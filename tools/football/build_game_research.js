#!/usr/bin/env node
/* ===========================================================================
   THE GAME RESEARCH SNAPSHOTS — one model-first research snapshot per NFL and
   FBS game, the source of the game research page and its matchup graphic.
   docs/game-research/README.md

   Reads (committed artifacts only: no network, no sportsbook number):
     football/nfl/slate.json            the NFL projection run (football/engine.js)
     football/fbs/slate.json            the FBS projection run (football/cfb_p4)
     football/cfb_terminal/games.json   the terminal's detail for the same run
                                        (used only where its margin matches)
     football/rankings/current.json     college unit rankings and ETSR
     football/validation/linemaker_<nfl|cfb>.json   the pricing calibration
     today/slate.json                   records and poll ranks (ESPN), when the
                                        game is inside its window
     football/game_research/identity_cfb.json      college abbreviations/colours

   Writes:
     football/game_research/current.json         every pregame game's snapshot
                                                 (+ the last pregame snapshot of
                                                 a game that has kicked off)
     football/game_research/probabilities.json   each snapshot's probability
                                                 sheet (lib/edgedesk_fairline.js,
                                                 the linemaker's own code, on
                                                 the SAME slates), for Compare
                                                 my number
     football/game_research/history/<season>.jsonl  APPEND-ONLY: one row each
                                                 time a game's snapshot changes,
                                                 before kickoff only

   Run:
     node tools/football/build_game_research.js            build and write
     node tools/football/build_game_research.js --check    verify the committed artifact:
                                                 ids are content hashes, checks
                                                 re-run identically, sheets match
                                                 their snapshots, history is pregame
     node tools/football/build_game_research.js --identity regenerate the college
                                                 identity table from the NCAAM pack
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const { writeIfChanged } = require(path.join(__dirname, 'write_if_changed.js'));

const OUT = path.join(ROOT, 'football', 'game_research');
const SCHEMA = 'edgedesk_game_research_current_v1';
const PROB_SCHEMA = 'edgedesk_game_research_probabilities_v1';
const HISTORY_SCHEMA = 'edgedesk_game_research_history_v1';
/* a game that kicked off this long ago leaves current.json (its history stays) */
const STARTED_KEEP_H = 36;

function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; } }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/* ------------------------------------------------------------ identity */
function buildIdentity() {
  const dir = path.join(ROOT, 'basketball', 'ncaam_research', 'published', 'teams');
  const rk = readJson('football/rankings/current.json');
  if (!rk || !fs.existsSync(dir)) throw new Error('the NCAAM pack or football/rankings/current.json is missing');
  const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  const by = {};
  fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).team;
    if (!t) return;
    by[norm(t.short)] = by[norm(t.short)] || t; by[norm(t.name)] = by[norm(t.name)] || t;
  });
  const teams = {}, missing = [];
  Object.keys(rk.teams).sort().forEach((key) => {
    const t = rk.teams[key], m = by[norm(t.team)] || by[key];
    if (!m) { missing.push(t.team); return; }
    teams[key] = { name: t.team, espn_id: String(m.id), abbr: m.abbrev || null, color: m.color || null, alt_color: null, source: 'ESPN team identity (NCAAM data pack, team ' + m.id + ')' };
  });
  return { schema: 'edgedesk_cfb_identity_v1', generated_at: new Date().toISOString(),
    note: 'Presentation only (abbreviation and primary colour for the matchup graphic). Matched by school name to ESPN’s identity in the NCAAM data pack. A school missing here is drawn with initials and neutral colours, never a guessed abbreviation.',
    teams, missing };
}

/* ------------------------------------------------------------ records */
function nflRecords(slate) {
  const out = {};
  Object.keys((slate && slate.teams) || {}).forEach((code) => {
    const res = slate.teams[code].results || [];
    let w = 0, l = 0, t = 0;
    res.forEach((r) => { if (r.result === 'W') w++; else if (r.result === 'L') l++; else if (r.result === 'T') t++; });
    if (w + l + t) out[code] = { w, l, t, as_of: slate.generated_at, source: 'football/nfl/slate.json results (nflverse)' };
  });
  return out;
}
/* ESPN records for the games inside today/slate.json's window, keyed by the
   game so a record is only ever attached to the game it was read for */
function espnByGame(today) {
  const out = {};
  ((today && today.events) || []).forEach((e) => {
    const gk = e.research && e.research.game_key;
    if (!gk || (e.sport !== 'cfb' && e.sport !== 'nfl')) return;
    out[gk] = { home: e.home || {}, away: e.away || {}, as_of: e.updated_at || today.generated_at, status: e.status };
  });
  return out;
}

/* ------------------------------------------------------------ probability sheets */
function sheetsFor(slates, now) {
  const FLB = require(path.join(__dirname, 'build_fair_lines.js'));
  const out = {}, full = {}, models = {}, refused = [];
  ['nfl', 'cfb'].forEach((lg) => {
    const cal = readJson('football/validation/linemaker_' + lg + '.json');
    const slate = slates[lg];
    if (!cal || !cal.live || !slate) { refused.push({ league: lg, reason: !cal ? 'no calibration record' : 'no slate' }); return; }
    models[lg] = { league: lg.toUpperCase(), calibration_generated_at: cal.generated_at || null, bands: cal.live.bands, bands_at_market: cal.live.bands_at_market || {}, band_min_n: cal.live.band_min_n,
      markets: Object.keys(cal.live.markets).reduce((o, k) => { const m = cal.live.markets[k]; o[k] = { method: m.method, status: m.status, tier: m.tier }; return o; }, {}) };
    const { rows, refused: rf, hooks } = FLB.inputsFor(lg, slate, now);
    rf.forEach((r) => refused.push(r));
    rows.forEach(({ input }) => {
      const sh = FL.sheet(input, cal.live, hooks, { spread_width: 21, total_width: 21 });
      if (!sh.ok) { refused.push({ game_id: input.game_id, league: lg, reason: sh.error }); return; }
      const keep = { spread: sh.markets.spread || null, moneyline: sh.markets.moneyline || null, total: sh.markets.total || null };
      const lite = { sport: sh.sport, game_id: sh.game_id, centres: sh.centres, markets: {}, dist: {}, ladders: {} };
      Object.keys(keep).forEach((k) => { if (keep[k]) lite.markets[k] = keep[k]; });
      if (sh.dist.margin) lite.dist.margin = FL.pmf.compact(sh.dist.margin, 1e-5, 5);
      else if (sh.ladders.spread) lite.ladders.spread = sh.ladders.spread.map((r) => ({ home_line: r.home_line, home: r.home, push: r.push, away: r.away }));
      if (sh.dist.total) lite.dist.total = FL.pmf.compact(sh.dist.total, 1e-5, 5);
      else if (sh.ladders.total) lite.ladders.total = sh.ladders.total.map((r) => ({ line: r.line, over: r.over, push: r.push, under: r.under }));
      out[lg + '|' + sh.game_id] = lite;
      full[lg + '|' + sh.game_id] = sh;
    });
  });
  return { sheets: out, full, models, refused };
}

/* ------------------------------------------------------------ history */
function historyFile(season) { return path.join(OUT, 'history', String(season) + '.jsonl'); }
function readHistory(file) {
  if (!fs.existsSync(file)) return { text: '', rows: [] };
  const text = fs.readFileSync(file, 'utf8'), rows = [];
  text.split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    try { rows.push(JSON.parse(l)); } catch (e) { throw new Error(path.relative(ROOT, file) + ' line ' + (i + 1) + ' does not parse: the history is append-only and is never repaired by the build'); }
  });
  return { text, rows };
}
/* one row per change in what the graphic prints: the snapshot id, the
   headline numbers, and the graphic spec that redraws it exactly */
function historyRow(s, nowIso) {
  return { schema: HISTORY_SCHEMA, snapshot_id: s.snapshot_id, graphic_key: GS.graphicKey(s), game_key: s.game_key, league: s.league, game_id: s.game_id,
    season: s.season, week: s.week, kickoff: s.kickoff, recorded_at: nowIso,
    summary: s.model.available ? { fair_home_line: s.model.fair.home_line, total: s.model.total, home_win: s.model.win_prob.home, version: s.model.version } : { unavailable: s.model.reason },
    data_status: s.data.status, spec: GS.graphicSpec(s) };
}

/* ------------------------------------------------------------ the build */
function build(opts) {
  opts = opts || {};
  const now = opts.now != null ? Date.parse(opts.now) : Date.now();
  const nowIso = new Date(now).toISOString();
  const nfl = opts.nfl !== undefined ? opts.nfl : readJson('football/nfl/slate.json');
  const fbs = opts.fbs !== undefined ? opts.fbs : readJson('football/fbs/slate.json');
  const term = opts.terminal !== undefined ? opts.terminal : readJson('football/cfb_terminal/games.json');
  const rk = opts.rankings !== undefined ? opts.rankings : readJson('football/rankings/current.json');
  const today = opts.today !== undefined ? opts.today : readJson('today/slate.json');
  const ident = opts.identity !== undefined ? opts.identity : readJson('football/game_research/identity_cfb.json');
  const prevHistory = opts.history || null;
  const prevCurrent = opts.previous !== undefined ? opts.previous : null;

  const identity = {};
  Object.keys((ident && ident.teams) || {}).forEach((k) => { const t = ident.teams[k]; identity[k] = { abbr: t.abbr, color: t.color, alt_color: t.alt_color, source: t.source }; });
  const espn = espnByGame(today);
  const rankCounts = {};
  if (rk && rk.teams) Object.keys(rk.teams).forEach((k) => {
    const r = rk.teams[k].ranks || {};
    Object.keys(r).forEach((m) => { if (r[m] && !r[m].unranked && num(r[m].rank) != null) rankCounts[m] = Math.max(rankCounts[m] || 0, r[m].rank); });
  });

  /* the probability sheets first, on the same slates: each snapshot reads its
     own sheet's scoring distribution, and the price check reads the sheet */
  const probs = sheetsFor({ nfl, cfb: fbs }, now);
  const fullSheets = probs.full;
  const snaps = [], refused = [];
  function espnSide(gk, s) {
    const e = espn[gk];
    if (!e || !e[s]) return null;
    return e[s];
  }
  function pollsFor(gk) {
    const out = {};
    ['home', 'away'].forEach((sd) => { const e = espnSide(gk, sd); if (e && num(e.rank) != null) out[sd] = { rank: e.rank, source: 'ESPN scoreboard (AP/CFP poll rank)', as_of: espn[gk].as_of }; });
    return out;
  }
  /* NFL */
  const nflRecs = nflRecords(nfl);
  ((nfl && nfl.games) || []).forEach((g) => {
    try {
      const gk = 'nfl|' + g.game_id;
      const s = GS.fromNfl(g, { teams: nfl.teams, generated_at: nfl.generated_at, source: 'football/nfl/slate.json', records: nflRecs, polls: pollsFor(gk), sheet: fullSheets[gk] || null });
      snaps.push(s);
    } catch (e) { refused.push({ game_key: 'nfl|' + g.game_id, reason: String(e && e.message || e) }); }
  });
  /* FBS */
  ((fbs && fbs.games) || []).forEach((g) => {
    try {
      const gk = 'cfb|' + g.game_id;
      const recs = {};
      ['home', 'away'].forEach((sd) => {
        const e = espnSide(gk, sd);
        if (e && e.record) recs[g[sd + '_team_id']] = { text: e.record, as_of: espn[gk].as_of, source: 'ESPN scoreboard record' };
      });
      const s = GS.fromCfb(g, { terminal: term && term.games ? term.games[String(g.game_id)] : null, rankings: rk && rk.teams, rankings_as_of: rk && (rk.data_as_of || rk.generated_at),
        team_count: rk && rk.team_count, rank_counts: rankCounts, identity, records: recs, polls: pollsFor(gk), units_label: rk && rk.week_label ? rk.week_label + ' ratings' : null, sheet: fullSheets[gk] || null,
        generated_at: fbs.generated_at, source: 'football/fbs/slate.json' });
      snaps.push(s);
    } catch (e) { refused.push({ game_key: 'cfb|' + g.game_id, reason: String(e && e.message || e) }); }
  });

  /* pregame vs started: a game that has kicked off gets no new snapshot. Its
     last pregame snapshot is carried from the previous current.json for a
     day and a half (frozen, never recomputed), then leaves; the history
     keeps its graphic spec for good. */
  const hist = prevHistory || {};
  const prevBy = {};
  ((prevCurrent && prevCurrent.games) || []).forEach((g) => { prevBy[g.game_key] = g; });
  const games = [], appendBySeason = {}, seen = {};
  snaps.forEach((s) => {
    const ko = Date.parse(s.kickoff);
    const last = hist[s.game_key] || null;
    seen[s.game_key] = 1;
    if (isFinite(ko) && ko <= now) {
      const p = prevBy[s.game_key];
      if (p && now - ko <= STARTED_KEEP_H * 36e5) games.push(Object.assign({}, p, { started: true, frozen_at: p.frozen_at || p.generated_at }));
      return;
    }
    s.generated_at = nowIso;
    s.history = last ? (last.trail || []).slice(-6) : [];
    games.push(s);
    if (!last || last.graphic_key !== GS.graphicKey(s)) (appendBySeason[s.season] = appendBySeason[s.season] || []).push(s);
  });
  /* a started game the slates no longer carry: still frozen from the previous run */
  Object.keys(prevBy).forEach((k) => {
    if (seen[k]) return;
    const p = prevBy[k], ko = Date.parse(p.kickoff);
    if (isFinite(ko) && ko <= now && now - ko <= STARTED_KEEP_H * 36e5) games.push(Object.assign({}, p, { started: true, frozen_at: p.frozen_at || p.generated_at }));
  });
  games.sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || String(a.game_key).localeCompare(String(b.game_key)));
  /* each sheet must come from the projection its snapshot shows */
  let sheetMismatch = 0;
  games.forEach((s) => {
    const sh = probs.sheets[s.game_key];
    s.probability_sheet = sh ? (GS.sheetMatches(s, sh) ? 'MATCHED' : 'MISMATCH') : 'NONE';
    if (sh && s.probability_sheet === 'MISMATCH') { delete probs.sheets[s.game_key]; sheetMismatch++; }
  });
  const counts = { games: games.length, nfl: games.filter((g) => g.league === 'nfl').length, cfb: games.filter((g) => g.league === 'cfb').length,
    model_available: games.filter((g) => g.model.available).length, data_fault: games.filter((g) => g.data.status === 'FAULT').length,
    limited: games.filter((g) => g.data.status === 'LIMITED').length, started: games.filter((g) => g.started).length,
    with_sheet: games.filter((g) => g.probability_sheet === 'MATCHED').length, sheet_mismatch: sheetMismatch };
  const current = {
    schema: SCHEMA, version: GS.VERSION, generated_at: nowIso,
    note: 'Layer A only: EdgeDesk’s own projections. No sportsbook number is read here; the page joins the market separately and labels it.',
    inputs: {
      nfl_slate: nfl ? { file: 'football/nfl/slate.json', generated_at: nfl.generated_at, model_version: nfl.engine && nfl.engine.model_version } : null,
      fbs_slate: fbs ? { file: 'football/fbs/slate.json', generated_at: fbs.generated_at } : null,
      cfb_terminal: term ? { file: 'football/cfb_terminal/games.json', generated_at: term.generated_at } : null,
      rankings: rk ? { file: 'football/rankings/current.json', generated_at: rk.generated_at, week: rk.week_label } : null,
      records: today ? { file: 'today/slate.json', generated_at: today.generated_at } : null,
      identity: ident ? { file: 'football/game_research/identity_cfb.json', generated_at: ident.generated_at } : null
    },
    definitions: GS.DEFINITIONS, counts, refused, games
  };
  const probabilities = { schema: PROB_SCHEMA, generated_at: nowIso, fairline_version: FL.VERSION,
    note: 'Each sheet is lib/edgedesk_fairline.js sheet() on the same slate as its snapshot (tools/football/build_fair_lines.js inputsFor). A sheet whose centre does not match its snapshot is dropped, never served.',
    models: probs.models, refused: probs.refused, sheets: probs.sheets };
  return { current, probabilities, appendBySeason, nowIso };
}

/* the latest history row per game, with a short trail of how its number moved */
function loadHistory() {
  const dir = path.join(OUT, 'history'), out = {};
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).filter((f) => /\.jsonl$/.test(f)).sort().forEach((f) => {
    readHistory(path.join(dir, f)).rows.forEach((r) => {
      const prev = out[r.game_key];
      const trail = prev ? prev.trail.slice() : [];
      trail.push({ snapshot_id: r.snapshot_id, at: r.recorded_at, fair_home_line: r.summary && r.summary.fair_home_line, total: r.summary && r.summary.total, home_win: r.summary && r.summary.home_win });
      out[r.game_key] = { snapshot_id: r.snapshot_id, graphic_key: r.graphic_key, recorded_at: r.recorded_at, spec: r.spec, trail };
    });
  });
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--identity')) {
    const id = buildIdentity();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'identity_cfb.json'), JSON.stringify(id, null, 1) + '\n');
    console.log('identity_cfb.json: ' + Object.keys(id.teams).length + ' teams' + (id.missing.length ? ', missing ' + id.missing.join(', ') : ''));
    return;
  }
  const check = argv.includes('--check');
  const nowArg = (() => { const i = argv.indexOf('--now'); return i >= 0 ? argv[i + 1] : null; })();
  const history = loadHistory();
  if (check) {
    /* THE COMMITTED ARTIFACT IS SELF-CONSISTENT. Not a rebuild from the
       current inputs: the slates, rankings and ESPN records are rewritten by
       other scheduled jobs between hourly snapshot builds, so a rebuild-and-
       compare gate would fail on main whenever an input moved (the lesson in
       .github/workflows/starter-context.yml). What can always be verified:
         - every snapshot's id is the hash of its own content;
         - every snapshot passes the consistency checks it carries;
         - every probability sheet served was built from its snapshot;
         - the history ledger parses, is pregame-only and append-shaped. */
    const cur = readJson('football/game_research/current.json'), probs = readJson('football/game_research/probabilities.json');
    if (!cur || !probs) { console.error('football/game_research/current.json or probabilities.json is missing'); process.exit(1); }
    const bad = [];
    (cur.games || []).forEach((s) => {
      if (GS.snapshotId(s) !== s.snapshot_id) bad.push(s.game_key + ': snapshot id is not the hash of its content');
      const ck = GS.checks(s);
      if (JSON.stringify(ck) !== JSON.stringify(s.checks)) bad.push(s.game_key + ': stored consistency checks differ from a re-run');
      if (s.model.available && !ck.ok && s.data.status !== 'FAULT') bad.push(s.game_key + ': a failed check is not shown as a DATA FAULT');
      const sh = probs.sheets[s.game_key];
      if (sh && !GS.sheetMatches(s, sh)) bad.push(s.game_key + ': its probability sheet was built from a different projection');
    });
    const dir = path.join(OUT, 'history');
    if (fs.existsSync(dir)) fs.readdirSync(dir).filter((f) => /\.jsonl$/.test(f)).forEach((f) => {
      readHistory(path.join(dir, f)).rows.forEach((r, i) => {
        if (r.schema !== HISTORY_SCHEMA || !r.spec || !r.snapshot_id) bad.push(f + ' row ' + (i + 1) + ': not a history row');
        else if (!(Date.parse(r.recorded_at) < Date.parse(r.kickoff))) bad.push(f + ' row ' + (i + 1) + ': recorded after kickoff');
      });
    });
    if (bad.length) { console.error('game research: ' + bad.length + ' integrity failure(s):\n  ' + bad.slice(0, 20).join('\n  ')); process.exit(1); }
    console.log('game research: current.json is self-consistent (' + cur.counts.games + ' games, ' + Object.keys(probs.sheets).length + ' sheets) and the history ledger is pregame-only');
    return;
  }
  const r = build({ now: nowArg || undefined, history, previous: readJson('football/game_research/current.json') });
  /* the history first: append only, read back as an exact prefix */
  let appended = 0;
  Object.keys(r.appendBySeason).forEach((season) => {
    const file = historyFile(season), prev = readHistory(file);
    const lines = r.appendBySeason[season].map((s) => JSON.stringify(historyRow(s, r.nowIso)));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (prev.text && !prev.text.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
    const after = fs.readFileSync(file, 'utf8');
    if (after.slice(0, prev.text.length) !== prev.text) throw new Error(path.relative(ROOT, file) + ' changed in place; refusing');
    appended += lines.length;
  });
  /* the current trail now includes what was just appended */
  const fresh = loadHistory();
  r.current.games.forEach((s) => { if (!s.started && fresh[s.game_key]) s.history = fresh[s.game_key].trail.slice(-6); });
  const w1 = writeIfChanged(path.join(OUT, 'current.json'), r.current, { pretty: false });
  const w2 = writeIfChanged(path.join(OUT, 'probabilities.json'), r.probabilities, { pretty: false });
  const c = r.current.counts;
  console.log('game research: ' + c.games + ' games (' + c.nfl + ' NFL, ' + c.cfb + ' CFB), ' + c.model_available + ' projected, ' + c.limited + ' limited, '
    + c.data_fault + ' data faults, ' + c.started + ' started; sheets ' + c.with_sheet + ' matched / ' + c.sheet_mismatch + ' dropped; '
    + appended + ' history rows appended; current.json ' + w1 + ', probabilities.json ' + w2);
  if (r.current.refused.length) console.log('refused: ' + r.current.refused.map((x) => x.game_key + ' (' + x.reason + ')').join('; '));
}

if (require.main === module) main();
module.exports = { build, buildIdentity, loadHistory, historyRow, nflRecords, espnByGame, sheetsFor, SCHEMA, PROB_SCHEMA, HISTORY_SCHEMA };
