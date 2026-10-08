#!/usr/bin/env node
/* ===========================================================================
   Football evidence packets — built from what EdgeDesk already commits.

     node tools/content/evidence.js build [--now ISO] [--check]
         one packet per upcoming CFB and NFL game of the current week, written
         to football/evidence/packets.json (the file the owner's Content
         Engine page reads). A packet whose inputs have not changed is reused
         as it was (same inputs_hash → same packet, same built_at), so a
         rebuild only regenerates what changed. --check exits 1 if the file on
         disk is out of date.
     node tools/content/evidence.js show <game_id> [--json]
         one packet, readably: the explanation, the claims and the coverage.
     node tools/content/evidence.js plan [--featured]
         the research plan: for each game, the research items EdgeDesk does
         not have, the reported facts still to confirm, and the starters still
         unannounced. Nothing is fetched: this is the list a person (or an
         approved researcher) works from, recording each answer with
         tools/content/add_fact.js. Facts already on file and current are
         never looked up again.

   COST: zero. Every input is a committed artifact; no API is called. Outside
   reporting enters only through the facts ledger (football/evidence/facts.json)
   and the desk notebook (football/notes/current.json), each with a receipt.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FE = require(path.join(ROOT, 'lib', 'football_evidence.js'));

const PATHS = {
  terminal: 'football/cfb_terminal/games.json',
  metrics: 'football/matchup/metrics.json',
  profiles: 'football/matchup/profiles_2026.json',
  qbs: 'football/fbs_epa/qb_epa_2026.json',
  rankings: 'football/rankings/current.json',
  record: 'record/football/cfb_2026.json',
  forecasts: 'football/venues/forecasts.json',
  lines_cfb: 'football/pricing/lines_cfb.json',
  lines_nfl: 'football/pricing/lines_nfl.json',
  box: 'football/data/box/2026.json',
  reports_dir: 'football/availability/reports',
  records_dir: 'articles/data/records',
  facts: 'football/evidence/facts.json',
  notes: 'football/notes/current.json',
  nfl_slate: 'football/nfl/slate.json',
  nfl_injuries: 'football/injuries/nfl_2026.json',
  nfl_team_weeks: 'football/nfl/stats_team_week_2026.csv',
  market_dir: 'articles/data/market',
  out: 'football/evidence/packets.json'
};

function readJson(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
/* a small CSV reader (quoted fields allowed) — this repository has no dependencies */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length === head.length).map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

/* ── the sources, read once per process ──────────────────────────────────── */
let SRC = null;
function sources(opts) {
  if (SRC && !(opts && opts.reload)) return SRC;
  const t = readJson(PATHS.terminal), rk = readJson(PATHS.rankings), m = readJson(PATHS.metrics), pr = readJson(PATHS.profiles), q = readJson(PATHS.qbs);
  const rec = readJson(PATHS.record), fc = readJson(PATHS.forecasts), lc = readJson(PATHS.lines_cfb), bx = readJson(PATHS.box);
  const byName = {}, keyOf = {};
  if (rk && rk.teams) Object.keys(rk.teams).forEach((k) => { const r = rk.teams[k]; if (r && r.team) { byName[r.team] = { key: k, rank: r.rank, team: r.team, conference: r.conference || null }; keyOf[r.team] = k; } });
  if (m && m.teams) Object.keys(m.teams).forEach((k) => { const r = m.teams[k]; if (r && r.team && !keyOf[r.team]) keyOf[r.team] = k; });
  const qbByTeam = {};
  if (q && q.players) Object.keys(q.players).forEach((id) => { const p = q.players[id]; if (p && p.team_key) (qbByTeam[p.team_key] = qbByTeam[p.team_key] || []).push(p); });
  SRC = {
    terminal: t, rankings: rk, metrics: m, profiles: pr, qbByTeam, record: rec, forecasts: fc, linesCfb: lc, box: (bx && bx.teams) || {}, byName, keyOf,
    facts: readJson(PATHS.facts) || { facts: [] }, notes: readJson(PATHS.notes) || { notes: [] },
    nflSlate: readJson(PATHS.nfl_slate), nflInjuries: readJson(PATHS.nfl_injuries),
    as_of: {
      terminal: t && t.generated_at, rankings: rk && (rk.data_as_of || rk.generated_at), metrics: m && m.generated_at, profiles: pr && pr.generated_at,
      qbs: q && (q.observations_through || q.generated_at), record: rec && rec.updated_at, forecasts: fc && fc.generated_at, lines: lc && lc.generated_at, box: bx && bx.generated_at
    }
  };
  return SRC;
}
function lazy(key, fn) { const s = sources(); if (!(key in s)) s[key] = fn(); return s[key]; }
function reportsFor(gameId) {
  const dir = path.join(ROOT, PATHS.reports_dir);
  if (!fs.existsSync(dir)) return [];
  const idx = lazy('_reportFiles', () => fs.readdirSync(dir).filter((f) => /\.json$/.test(f)));
  return idx.filter((f) => f.endsWith('_' + gameId + '.json')).map((f) => readJson(path.join(PATHS.reports_dir, f))).filter(Boolean);
}
function firstPartyRecord(league, gameId) { return readJson(path.join(PATHS.records_dir, league + '-' + gameId + '.json')); }

/* ── one CFB packet ──────────────────────────────────────────────────────── */
function cfbInputs(g, opts) {
  const S = sources(), gm = g.game || {};
  const keys = { home: S.keyOf[gm.home], away: S.keyOf[gm.away] };
  const reps = reportsFor(String(g.game_id));
  const repFor = (team) => reps.filter((r) => r.team === team).sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0))[0] || null;
  const h2h = ((S.linesCfb && S.linesCfb.games) || []).filter((x) => (x.home === gm.home && x.away === gm.away) || (x.home === gm.away && x.away === gm.home));
  const finals = (S.record && S.record.games) || {};
  const pseudo = { game_id: String(g.game_id), home: gm.home, away: gm.away };
  return {
    game: g, keys,
    metrics: { home: S.metrics && S.metrics.teams[keys.home], away: S.metrics && S.metrics.teams[keys.away] },
    profiles: { home: S.profiles && S.profiles.teams[keys.home], away: S.profiles && S.profiles.teams[keys.away] },
    qbs: { home: S.qbByTeam[keys.home] || [], away: S.qbByTeam[keys.away] || [] },
    box: { home: S.box[keys.home] || null, away: S.box[keys.away] || null },
    reports: { home: repFor(gm.home), away: repFor(gm.away) },
    forecast: S.forecasts && S.forecasts.by_game ? S.forecasts.by_game[String(g.game_id)] : null,
    h2h, finals, rankings: { teams: (S.rankings && S.rankings.teams) || {}, by_name: S.byName },
    record: firstPartyRecord('cfb', g.game_id),
    facts: FE.factsFor(S.facts, pseudo, opts.now), notes: ((S.notes && S.notes.notes) || []).filter((n) => n.game_id === String(g.game_id)),
    as_of: S.as_of
  };
}

/* ── one NFL packet ──────────────────────────────────────────────────────── */
function nflInputs(g, opts) {
  const S = sources();
  const tw = lazy('_teamWeeks', () => {
    const f = path.join(ROOT, PATHS.nfl_team_weeks);
    if (!fs.existsSync(f)) return {};
    const out = {};
    parseCsv(fs.readFileSync(f, 'utf8')).forEach((r) => { if (r.season_type === 'REG') (out[r.team] = out[r.team] || []).push(r); });
    return out;
  });
  const ln = lazy('_linesNfl', () => readJson(PATHS.lines_nfl));
  const quotes = lazy('_nflQuotes', () => {
    const dir = path.join(ROOT, PATHS.market_dir), out = {};
    if (!fs.existsSync(dir)) return out;
    fs.readdirSync(dir).filter((f) => /^\d{4}-week-\d+\.json$/.test(f)).sort().forEach((f) => {
      const j = readJson(path.join(PATHS.market_dir, f));
      ((j && j.quotes) || []).forEach((q) => { if (q && q.sport === 'NFL' && q.game_id && q.spread && typeof q.spread.point === 'number') out[q.game_id] = q; });
    });
    return out;
  });
  const teams = (S.nflSlate && S.nflSlate.teams) || {};
  const nameOf = (code) => (teams[code] && teams[code].team) || code;
  const h2h = ((ln && ln.games) || []).filter((x) => typeof x.home_score === 'number' && ((x.home === g.home_code && x.away === g.away_code) || (x.home === g.away_code && x.away === g.home_code)))
    .map((x) => ({ season: x.season, kickoff: x.date, home: nameOf(x.home), away: nameOf(x.away), home_points: x.home_score, away_points: x.away_score }));
  const q = quotes[g.game_id];
  const quote = q ? { home_line: q.spread.side === 'home' ? q.spread.point : -q.spread.point, book: q.spread.book || null, captured_at: q.captured_at || q.spread.captured_at || null } : null;
  const pseudo = { game_id: String(g.game_id), home: g.home_team, away: g.away_team };
  return {
    game: g, teams, injuries: S.nflInjuries, teamWeeks: tw, h2h, quote,
    facts: FE.factsFor(S.facts, pseudo, opts.now),
    as_of: { slate: S.nflSlate && S.nflSlate.generated_at, injuries: S.nflInjuries && S.nflInjuries.retrieved_at, team_weeks: fileTime(PATHS.nfl_team_weeks), lines: ln && ln.generated_at }
  };
}
function fileTime(rel) { try { return fs.statSync(path.join(ROOT, rel)).mtime.toISOString(); } catch (e) { return null; } }

/* ── the week's packets, reusing every packet whose inputs did not change ─ */
const CACHE = new Map();
let builds = 0;
function packetFor(league, g, opts) {
  const x = league === 'cfb' ? cfbInputs(g, opts) : nflInputs(g, opts);
  const key = league + ':' + g.game_id + ':' + FE.util.hash(JSON.stringify([
    league === 'cfb' ? g.built_at : (g.fingerprint || g.model_home_line), x.as_of,
    (x.facts || []).map((f) => f.id + '|' + (f.expires_at || '')),
    league === 'cfb' ? [x.reports.home && x.reports.home.published_at, x.reports.away && x.reports.away.published_at] : null
  ]));
  if (CACHE.has(key)) return CACHE.get(key);
  const prev = opts.previous && opts.previous[String(g.game_id)];
  builds++;
  let p = league === 'cfb' ? FE.buildCfb(x, { now: opts.now }) : FE.buildNfl(x, { now: opts.now });
  /* same inputs, same packet: keep the earlier build time so nothing downstream churns */
  if (prev && prev.inputs_hash === p.inputs_hash && prev.hash === p.hash) p = prev;
  CACHE.set(key, p);
  return p;
}
function chooseWeek(games, now) {
  let best = null;
  games.forEach((g) => { const t = Date.parse(g.kickoff); if (!isFinite(t) || t <= now || typeof g.week !== 'number') return; if (best == null || g.week < best) best = g.week; });
  return best;
}
function build(opts) {
  opts = Object.assign({ now: Date.now() }, opts || {});
  const S = sources();
  const prevFile = opts.previous === undefined ? readJson(PATHS.out) : opts.previous;
  const prev = { cfb: (prevFile && prevFile.cfb && prevFile.cfb.packets) || {}, nfl: (prevFile && prevFile.nfl && prevFile.nfl.packets) || {} };
  const out = { schema: 'edgedesk_football_evidence_set_v1', version: FE.VERSION, built_at: new Date(opts.now).toISOString(), inputs: Object.assign({}, S.as_of), cfb: null, nfl: null };
  if (S.terminal && S.terminal.games) {
    const all = Object.values(S.terminal.games);
    const week = typeof opts.cfbWeek === 'number' ? opts.cfbWeek : chooseWeek(all, opts.now);
    const packets = {};
    all.filter((g) => g.week === week && (!opts.gameIds || opts.gameIds.includes(String(g.game_id)))).forEach((g) => {
      if (!g.edgedesk || !g.edgedesk.available) return;
      packets[String(g.game_id)] = packetFor('cfb', g, { now: opts.now, previous: prev.cfb });
    });
    out.cfb = { season: S.terminal.season, week, packets };
  }
  if (S.nflSlate && Array.isArray(S.nflSlate.games)) {
    const week = typeof opts.nflWeek === 'number' ? opts.nflWeek : chooseWeek(S.nflSlate.games, opts.now);
    const packets = {};
    S.nflSlate.games.filter((g) => g.week === week && (!opts.gameIds || opts.gameIds.includes(String(g.game_id)))).forEach((g) => {
      packets[String(g.game_id)] = packetFor('nfl', g, { now: opts.now, previous: prev.nfl });
    });
    out.nfl = { season: S.nflSlate.season, week, packets };
  }
  out.counts = { cfb: out.cfb ? Object.keys(out.cfb.packets).length : 0, nfl: out.nfl ? Object.keys(out.nfl.packets).length : 0, built_this_run: builds };
  return out;
}
function stats() { return { builds, cached: CACHE.size }; }

/* ── CLI ─────────────────────────────────────────────────────────────────── */
function arg(name, d) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
function flag(name) { return process.argv.indexOf('--' + name) > 0; }
function stable(set) { const c = JSON.parse(JSON.stringify(set)); delete c.built_at; if (c.counts) delete c.counts.built_this_run; return JSON.stringify(c); }

function showPacket(p) {
  const X = p.explanation || {};
  const lines = [];
  lines.push(p.away + ' at ' + p.home + ' (' + p.league.toUpperCase() + ' ' + p.game_id + ')');
  lines.push('  model ' + (p.model.text || '—') + ' · market ' + (p.market.text || '—') + ' [' + p.market.status + ']' + (X.gap ? ' · gap ' + X.gap.points + ' toward ' + X.gap.toward : ''));
  lines.push('  STATUS ' + X.status + (X.input_suspect ? ' · INPUT SUSPECT' : '') + (X.mechanical ? ' · explained ' + X.mechanical.explained_points + ' of ' + (X.gap && X.gap.points) : '') + (X.football_balance ? ' · football balance ' + X.football_balance.score : ''));
  lines.push('  ' + (X.assessment || ''));
  (X.input_flags || []).forEach((f) => lines.push('  ! ' + f.severity.toUpperCase() + ' ' + f.key + ': ' + f.text));
  if (X.critical_matchup) lines.push('  critical matchup: ' + X.critical_matchup.question + ' (' + X.critical_matchup.why + ')');
  const by = {}; p.claims.forEach((c) => { by[c.id] = c; });
  lines.push('  supporting EdgeDesk:'); (X.supporting || []).slice(0, 5).forEach((id) => lines.push('    + ' + by[id].text));
  lines.push('  against EdgeDesk:'); (X.contradicting || []).slice(0, 6).forEach((id) => lines.push('    - ' + by[id].text));
  lines.push('  for EdgeDesk’s number to be right:'); ((X.game_script && X.game_script.model_case) || []).forEach((t) => lines.push('    · ' + t));
  lines.push('  for the market’s number:'); ((X.game_script && X.game_script.market_case) || []).forEach((t) => lines.push('    · ' + t));
  lines.push('  uncertainty:'); (X.uncertainty || []).forEach((t) => lines.push('    ? ' + t));
  const v = {}; p.claims.forEach((c) => { v[c.verification] = (v[c.verification] || 0) + 1; });
  lines.push('  claims: ' + p.claims.length + ' ' + JSON.stringify(v));
  lines.push('  missing: ' + p.coverage.filter((c) => c.status === 'MISSING').map((c) => c.label).join(', '));
  return lines.join('\n');
}

function main() {
  const cmd = process.argv[2];
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  if (cmd === 'build') {
    const set = build({ now });
    const file = path.join(ROOT, PATHS.out);
    const prev = readJson(PATHS.out);
    if (flag('check')) { const ok = prev && stable(prev) === stable(set); console.log(ok ? 'ok      ' + PATHS.out : 'STALE   ' + PATHS.out + ' — run node tools/content/evidence.js build'); process.exit(ok ? 0 : 1); }
    if (prev && stable(prev) === stable(set)) { console.log('unchanged ' + PATHS.out + ' (' + set.counts.cfb + ' CFB, ' + set.counts.nfl + ' NFL packets)'); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(set) + '\n');
    console.log('wrote ' + PATHS.out + ' — ' + set.counts.cfb + ' CFB (week ' + (set.cfb && set.cfb.week) + '), ' + set.counts.nfl + ' NFL (week ' + (set.nfl && set.nfl.week) + '); ' + set.counts.built_this_run + ' built this run');
    return;
  }
  if (cmd === 'show') {
    const id = process.argv[3];
    const set = build({ now, gameIds: [String(id)] });
    const p = (set.cfb && set.cfb.packets[id]) || (set.nfl && set.nfl.packets[id]);
    if (!p) { console.error('no upcoming game ' + id); process.exit(1); }
    console.log(flag('json') ? JSON.stringify(p, null, 1) : showPacket(p));
    return;
  }
  if (cmd === 'plan') {
    const set = build({ now });
    const all = [].concat(Object.values((set.cfb && set.cfb.packets) || {}), Object.values((set.nfl && set.nfl.packets) || {}));
    const wanted = flag('featured') ? all.filter((p) => p.explanation && p.explanation.gap && p.explanation.gap.points >= FE.MATERIAL_GAP) : all;
    wanted.forEach((p) => { const r = FE.researchPlan(p); console.log(r.game + ' [' + r.status + '] missing: ' + r.missing.map((m) => m.label).join(', ') + (r.to_confirm.length ? ' | confirm: ' + r.to_confirm.length : '') + (r.starters.length ? ' | starters unannounced: ' + r.starters.map((s) => s.team).join(', ') : '')); });
    return;
  }
  console.log('usage: node tools/content/evidence.js build [--check] | show <game_id> [--json] | plan [--featured]  [--now ISO]');
  process.exit(2);
}
if (require.main === module) main();
module.exports = { build, packetFor, sources, cfbInputs, nflInputs, stats, showPacket, parseCsv, PATHS };
