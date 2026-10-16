'use strict';
/* ===========================================================================
   THE PERFORMANCE LEDGER'S SOURCES — every one already in the repository.

   Forecasts   engine/build_projections.js build(): the independent projection
               contract (lib/edgedesk_projections.js), built in process from the
               committed engine artifacts. No price is read.
   Quotes      today/slate.json markets: a named book's line, both sides and the
               capture time (ESPN scoreboard, tools/slate/build.js).
   Results     today/slate.json events (ESPN status and score, every sport) and
               each sport's own result file:
                 NFL   record/football/nfl_<season>.json   (nflverse)
                 CFB   record/football/cfb_<season>.json   (ESPN + cfbfastR, agreed)
                 NBA   nba/data/games/<season>.csv         (hoopR / ESPN)
                 NHL   hockey/data/team_games/<season>/    (official NHL; shootout-inclusive)
                 WNBA, NCAAM, NCAAW  basketball/data/<lg>/<season>.csv
               and, for a date the slate no longer carries, ESPN's scoreboard
               for that day (tools/slate/espn.js readDay), capped per run.
   Imports     the earlier pregame-only records, for the period before the
               ledger's first capture (tier RECORDED, never "verified"):
                 record/football/{nfl,cfb}_<season>.json   first and last pick
                 nba/ledger/<season>.jsonl, hockey/ledger/<season>.jsonl
                 engine/projections_ledger/<YYYY-MM>.jsonl
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const P = require('../../lib/edgedesk_performance.js');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function readLines(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }
function csv(f) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return []; }
  const lines = text.split('\n').filter((l) => l.length);
  if (!lines.length) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => { const c = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = c[i] === undefined ? '' : c[i]; }); return o; });
}
function ls(dir) { try { return fs.readdirSync(dir).sort(); } catch (_) { return []; } }
const toMs = P.toMs;

/* --------------------------------------------------------------- sports */
/* EDPROJ sport id → today/slate.json sport code, and how its event id joins */
const SPORT = {
  nfl: { slate: 'nfl', id_join: 'names', label: 'NFL' },
  cfb: { slate: 'cfb', id_join: 'espn', label: 'College football (FBS)' },
  nba: { slate: 'nba', id_join: 'espn', label: 'NBA' },
  nhl: { slate: 'nhl', id_join: 'names', label: 'NHL' },
  wnba: { slate: 'wnba', id_join: 'espn', label: 'WNBA' },
  ncaab_m: { slate: 'ncaam', id_join: 'espn', label: 'Men\'s college basketball' },
  ncaab_w: { slate: 'ncaaw', id_join: 'espn', label: 'Women\'s college basketball' }
};
const SUPPORTED = Object.keys(SPORT);

/* ------------------------------------------------------------ forecasts */
/** The projection contract as it stands now, from the committed artifacts. */
function currentProjections(root, nowMs) {
  const B = require(path.join(path.resolve(root), 'engine', 'build_projections.js'));
  const b = B.build({ now: nowMs, root });
  return { projections: b.artifact.projections || [], inputs: b.artifact.inputs || [], build_summary: b.artifact.build_summary || {} };
}

/* ---------------------------------------------------------------- slate */
function loadSlate(root) {
  const s = readJson(path.join(root, 'today', 'slate.json')) || { events: [], markets: {} };
  const byId = new Map();
  (s.events || []).concat(s.upcoming || []).forEach((e) => { if (e && e.id && !byId.has(e.id)) byId.set(e.id, e); });
  return { generated_at: s.generated_at || null, events: Array.from(byId.values()), byId, markets: s.markets || {} };
}
/**
 * The slate event for a ledger event: by ESPN id where the sport's ids are
 * ESPN's; otherwise both full team names and a start within 36 hours. Two
 * candidates, or none, is no match — never a guess.
 */
function matchSlate(slate, ev) {
  const sp = SPORT[ev.sport];
  if (!sp) return { match: null, why: 'UNSUPPORTED_SPORT' };
  if (sp.id_join === 'espn') {
    const e = slate.byId.get(sp.slate + ':espn:' + ev.event_id);
    return e ? { match: e, why: 'ID' } : { match: null, why: 'NOT_ON_SLATE' };
  }
  const st = toMs(ev.start_utc);
  const h = P.normName(ev.home && (ev.home.name || ev.home)), a = P.normName(ev.away && (ev.away.name || ev.away));
  const near = slate.events.filter((e) => e.sport === sp.slate && st != null && toMs(e.start_utc) != null && Math.abs(toMs(e.start_utc) - st) <= P.RESCHEDULE_HOURS * 3600e3);
  const exact = near.filter((e) => P.normName(e.home && e.home.name) === h && P.normName(e.away && e.away.name) === a);
  if (exact.length === 1) return { match: exact[0], why: 'NAMES' };
  if (exact.length > 1) return { match: null, why: 'AMBIGUOUS' };
  const swapped = near.filter((e) => P.normName(e.home && e.home.name) === a && P.normName(e.away && e.away.name) === h);
  if (swapped.length) return { match: null, why: 'SWAPPED_HOME_AWAY' };
  const ha = String(ev.home && ev.home.abbr || '').toUpperCase(), aa = String(ev.away && ev.away.abbr || '').toUpperCase();
  if (ha && aa) {
    const ab = near.filter((e) => String(e.home && e.home.abbr || '').toUpperCase() === ha && String(e.away && e.away.abbr || '').toUpperCase() === aa);
    if (ab.length === 1) return { match: ab[0], why: 'ABBREVIATIONS' };
    if (ab.length > 1) return { match: null, why: 'AMBIGUOUS' };
  }
  /* UNMATCHED only when the slate carries this sport's games around that start and none is this one */
  const anyNear = slate.events.some((e) => e.sport === sp.slate && st != null && toMs(e.start_utc) != null && Math.abs(toMs(e.start_utc) - st) <= 12 * 3600e3);
  return { match: null, why: anyNear ? 'UNMATCHED' : 'NOT_ON_SLATE' };
}
function slateCandidate(e, readAt) {
  if (!e) return null;
  return { source: 'espn_scoreboard', status: P.slateStatus(e), home_score: e.home && e.home.score, away_score: e.away && e.away.score, start_utc: e.start_utc,
    decided: /\/SO\b/.test(e.status_detail || '') ? 'SO' : /\/OT\b|\bOT\b/.test(e.status_detail || '') ? 'OT' : null, read_at: e.updated_at || readAt };
}

/* ---------------------------------------------------- native result files */
function seasonLabel(sport, startIso) {
  const d = new Date(startIso); const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (sport === 'nfl' || sport === 'cfb') return m <= 2 ? y - 1 : y;
  if (sport === 'wnba') return y;
  return m >= 8 ? y + 1 : y; /* nba, nhl, college basketball: the season is named for the year it ends */
}
function makeNative(root) {
  const cache = new Map();
  function once(key, fn) { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); }
  function football(sport, season) {
    return once('fb:' + sport + season, () => {
      const d = readJson(path.join(root, 'record', 'football', sport + '_' + season + '.json'));
      return d && d.games ? d.games : {};
    });
  }
  function csvGames(dir, season) {
    return once('csv:' + dir + season, () => {
      const m = new Map();
      csv(path.join(root, dir, season + '.csv')).forEach((r) => m.set(String(r.game_id), r));
      return m;
    });
  }
  function nhl(season) {
    return once('nhl' + season, () => {
      const m = new Map();
      ls(path.join(root, 'hockey', 'data', 'team_games', String(season))).filter((n) => n.endsWith('.csv')).forEach((n) => {
        csv(path.join(root, 'hockey', 'data', 'team_games', String(season), n)).forEach((r) => { if (r.home === '1') m.set(String(r.game_id), r); });
      });
      return m;
    });
  }
  /** The sport's own reading of a game, as a resolve() candidate, plus its close (NFL/CFB). */
  function read(sport, eventId, startIso) {
    if (!startIso) return { cand: null, close: null };
    const season = seasonLabel(sport, startIso);
    if (sport === 'nfl' || sport === 'cfb') {
      const g = football(sport, season)[eventId];
      if (!g) return { cand: null, close: null };
      const f = g.final;
      const close = g.close && (g.close.home_line != null || g.close.total != null) ? { home_line: g.close.home_line, total: g.close.total, source: g.close.source || null, book: g.close.book || null } : null;
      const cand = f ? { source: sport === 'nfl' ? 'nflverse (record/football)' : 'ESPN + cfbfastR (record/football)', status: 'FINAL', home_score: f.home_score, away_score: f.away_score, start_utc: g.kickoff, read_at: f.at || null } : null;
      return { cand, close, conflict: g.final_conflict || null };
    }
    if (sport === 'nhl') {
      const r = nhl(season).get(String(eventId));
      if (!r || r.gf === '' || r.ga === '') return { cand: null, close: null };
      return { cand: { source: 'NHL (hockey/data)', status: 'FINAL', home_score: +r.gf, away_score: +r.ga, start_utc: r.start_utc, decided: r.decided || null, read_at: r.assumed_available_at || null }, close: null };
    }
    const dir = sport === 'nba' ? 'nba/data/games' : sport === 'wnba' ? 'basketball/data/wnba' : sport === 'ncaab_m' ? 'basketball/data/ncaam' : sport === 'ncaab_w' ? 'basketball/data/ncaaw' : null;
    if (!dir) return { cand: null, close: null };
    const r = csvGames(dir, season).get(String(eventId));
    if (!r) return { cand: null, close: null };
    const st = String(r.status || '').toUpperCase();
    if (st !== 'FINAL' || r.hs === '' || r.as === '') return { cand: st === 'POSTPONED' || st === 'CANCELED' ? { source: dir, status: st, start_utc: r.start_utc } : null, close: null };
    return { cand: { source: sport === 'nba' ? 'hoopR (nba/data)' : dir, status: 'FINAL', home_score: +r.hs, away_score: +r.as, start_utc: r.start_utc, decided: +r.ot > 0 ? 'OT' : null, read_at: r.assumed_available_at || null }, close: null };
  }
  return { read };
}

/* ------------------------------------------------------- ESPN by date */
/** Read ESPN's scoreboard for the dates the slate no longer carries. Capped. */
async function espnDays(root, wants, o) {
  o = o || {};
  const E = require(path.join(path.resolve(root), 'tools', 'slate', 'espn.js'));
  const feeds = E.feeds();
  const out = new Map(); const log = [];
  const uniq = Array.from(new Set(wants.map((w) => w.code + '|' + w.ymd))).slice(0, o.max || 4);
  for (const k of uniq) {
    const [code, ymd] = k.split('|');
    const fs_ = feeds.filter((f) => f.sport === code);
    if (!fs_.length) { log.push({ day: ymd, sport: code, ok: false, error: 'no feed' }); continue; }
    for (const feed of fs_) {
      /* readDay never throws: { ok, error, events } */
      const r = await E.readDay(feed, ymd, { fetch: o.fetchImpl, timeoutMs: 15000, now: o.now });
      log.push({ day: ymd, sport: code, feed: feed.key, ok: !!r.ok, events: (r.events || []).length, error: r.ok ? null : r.error });
      (r.events || []).forEach((e) => out.set(e.id, e));
    }
  }
  return { events: out, log };
}

/* --------------------------------------------------------------- imports */
function nameMaps(root) {
  const nhl = {};
  const t = readJson(path.join(root, 'hockey', 'data', 'teams.json'));
  if (t && t.teams) Object.keys(t.teams).forEach((k) => { nhl[k] = t.teams[k].name; });
  const nba = {};
  const n = readJson(path.join(root, 'nba', 'data', 'teams.json')) || {}, a = readJson(path.join(root, 'nba', 'data', 'team_abbr.json')) || {};
  Object.keys(a).forEach((id) => { if (n[id]) nba[a[id]] = n[id]; });
  return { nhl, nba };
}
const EDPROJ_SPORTS = new Set(SUPPORTED);
function importRow(base) {
  return Object.assign({ schema: P.SNAPSHOT_SCHEMA, league: null, neutral: false, readiness: { research: null, reasons: [], freshness: null, age_hours: null, invalidated: false, availability: null, validation: {}, limitations: [] }, quote: null }, base);
}
function fc(o) {
  return { p_home: o.p_home == null ? null : +(+o.p_home).toFixed(4), p_away: o.p_away == null ? (o.p_home == null ? null : +(1 - o.p_home).toFixed(4)) : +o.p_away, p_draw: o.p_draw == null ? null : +o.p_draw,
    p_overtime: o.p_overtime == null ? null : +o.p_overtime, settles: null, fair_ml: null,
    fair_home_line: o.fair_home_line == null ? null : +(+o.fair_home_line).toFixed(2), fair_total: o.fair_total == null ? null : +(+o.fair_total).toFixed(2),
    expected_total: o.expected_total == null ? null : +(+o.expected_total).toFixed(2),
    projected_score: o.margin != null || o.home != null ? { home: o.home == null ? null : o.home, away: o.away == null ? null : o.away, margin: o.margin == null ? null : +(+o.margin).toFixed(2), total: o.expected_total == null ? null : +o.expected_total, basis: o.basis || null } : null,
    margin_sd: o.margin_sd == null ? null : +o.margin_sd };
}
/**
 * Every earlier pregame-only record, as RECORDED snapshots, for revisions
 * dated before `cutoff` (the ledger's first capture; now, before there is one).
 */
function importCandidates(root, cutoffMs) {
  const out = [];
  const names = nameMaps(root);
  const before = (iso) => { const t = toMs(iso); return t != null && (cutoffMs == null || t < cutoffMs); };
  /* 1 the football model record: its first and its last pregame number */
  ['nfl', 'cfb'].forEach((sport) => {
    ls(path.join(root, 'record', 'football')).filter((n) => new RegExp('^' + sport + '_\\d{4}\\.json$').test(n)).forEach((n) => {
      const d = readJson(path.join(root, 'record', 'football', n));
      if (!d || !d.games) return;
      Object.keys(d.games).forEach((id) => {
        const g = d.games[id];
        [['first', g.first], ['pick', g.pick]].forEach(([which, pk]) => {
          if (!pk || !pk.at || !before(pk.at) || !(toMs(pk.at) < toMs(g.kickoff))) return;
          if (which === 'pick' && g.first && g.first.at === pk.at) return;
          const mk = which === 'pick' ? g.market_pick : (g.entry && g.entry.model_at === pk.at ? g.entry.market : null);
          const quote = mk && mk.at && toMs(mk.at) < toMs(g.kickoff) && (mk.home_line != null || mk.total != null)
            ? { book: mk.book || null, source: mk.source || null, captured_at: mk.at, moneyline: null, spread: mk.home_line != null ? { home_point: mk.home_line, home_price: null, away_point: -mk.home_line, away_price: null } : null, total: mk.total != null ? { point: mk.total, over: null, under: null } : null }
            : null;
          out.push(importRow({ event_key: sport.toUpperCase() + '|' + id, sport, league: sport === 'nfl' ? 'NFL' : 'FBS', event_id: String(id),
            home: { name: g.home || null, abbr: g.home_code || null }, away: { name: g.away || null, abbr: g.away_code || null }, neutral: !!g.neutral_site, start_utc: g.kickoff,
            model: { id: pk.model_version || g.model_version || null, version: pk.model_version || g.model_version || null, artifact: d.projection_source || null, predicted_at: pk.at, artifact_generated_at: pk.at, params_generated_at: null, inputs_known_at: null, market_inputs: [] },
            forecast: fc({ p_home: pk.home_win_prob, fair_home_line: pk.home_line, fair_total: pk.total, margin: pk.home_line == null ? null : -pk.home_line, expected_total: pk.total, basis: 'the football record\'s published fair line and total' }),
            quote,
            capture: { method: 'import:football_record', captured_at: null, recorded_at: pk.at, run: null, git_sha: null, source: 'record/football/' + n, source_ref: 'record/football/' + n + '#' + id + '@' + which + ':' + pk.at, provenance: g.provenance || null } }));
        });
      });
    });
  });
  /* 2 the NBA and NHL pregame ledgers */
  ls(path.join(root, 'nba', 'ledger')).filter((n) => /^\d{4}\.jsonl$/.test(n)).forEach((n) => {
    readLines(path.join(root, 'nba', 'ledger', n)).forEach((r) => {
      if (!before(r.recorded_at) || !(toMs(r.recorded_at) < toMs(r.start_utc))) return;
      out.push(importRow({ event_key: 'NBA|' + r.game_id, sport: 'nba', league: 'NBA', event_id: String(r.game_id),
        home: { name: names.nba[r.home] || r.home, abbr: r.home }, away: { name: names.nba[r.away] || r.away, abbr: r.away }, start_utc: P.isoOf(r.start_utc),
        model: { id: r.model || null, version: r.model || null, artifact: 'nba/slate.json', predicted_at: r.recorded_at, artifact_generated_at: r.recorded_at, params_generated_at: null, inputs_known_at: null, market_inputs: [] },
        forecast: fc({ p_home: r.p_home, fair_home_line: r.fair_spread_home, fair_total: r.fair_total, expected_total: r.exp_total, margin: r.exp_margin, margin_sd: r.sd_m, p_overtime: r.p_ot, basis: 'expected points (nba ledger)' }),
        capture: { method: 'import:nba_ledger', captured_at: null, recorded_at: r.recorded_at, run: null, git_sha: null, source: 'nba/ledger/' + n, source_ref: 'nba/ledger/' + n + '#' + r.id } }));
    });
  });
  ls(path.join(root, 'hockey', 'ledger')).filter((n) => /^\d{4}\.jsonl$/.test(n)).forEach((n) => {
    readLines(path.join(root, 'hockey', 'ledger', n)).forEach((r) => {
      if (!before(r.recorded_at) || !(toMs(r.recorded_at) < toMs(r.start_utc))) return;
      out.push(importRow({ event_key: 'NHL|' + r.game_id, sport: 'nhl', league: 'NHL', event_id: String(r.game_id),
        home: { name: names.nhl[r.home] || r.home, abbr: r.home }, away: { name: names.nhl[r.away] || r.away, abbr: r.away }, start_utc: P.isoOf(r.start_utc),
        model: { id: r.model || null, version: r.model || null, artifact: 'hockey/slate.json', predicted_at: r.recorded_at, artifact_generated_at: r.recorded_at, params_generated_at: null, inputs_known_at: null, market_inputs: [] },
        forecast: fc({ p_home: r.p_home, expected_total: r.exp_total, basis: 'expected total including overtime (nhl ledger)' }),
        readiness: { research: null, reasons: [], freshness: null, age_hours: null, invalidated: false, availability: r.goalie_certainty || null, validation: {}, limitations: [] },
        capture: { method: 'import:nhl_ledger', captured_at: null, recorded_at: r.recorded_at, run: null, git_sha: null, source: 'hockey/ledger/' + n, source_ref: 'hockey/ledger/' + n + '#' + r.id } }));
    });
  });
  /* 3 the cross-sport projections ledger (retired sports are never imported) */
  /* a month that began after the cutoff can hold nothing before it: never read it */
  const cutMonth = cutoffMs == null ? null : new Date(cutoffMs).toISOString().slice(0, 7);
  ls(path.join(root, 'engine', 'projections_ledger')).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n) && (cutMonth == null || n.slice(0, 7) <= cutMonth)).forEach((n) => {
    readLines(path.join(root, 'engine', 'projections_ledger', n)).forEach((r) => {
      if (!EDPROJ_SPORTS.has(r.sport)) return;
      if (!before(r.frozen_at) || !(toMs(r.frozen_at) < toMs(r.start_utc)) || !(toMs(r.model_built_at) < toMs(r.start_utc))) return;
      out.push(importRow({ event_key: String(r.sport === 'ncaab_m' ? 'NCAAM' : r.sport === 'ncaab_w' ? 'NCAAW' : r.sport.toUpperCase()) + '|' + r.event_id, sport: r.sport, league: r.league || null, event_id: String(r.event_id),
        home: { name: r.home || null, abbr: null }, away: { name: r.away || null, abbr: null }, start_utc: P.isoOf(r.start_utc),
        model: { id: r.model_id || null, version: r.model_id || null, artifact: null, predicted_at: r.model_built_at, artifact_generated_at: r.model_built_at, params_generated_at: null, inputs_known_at: null, market_inputs: r.market_inputs || [] },
        forecast: fc({ p_home: r.p_home, p_away: r.p_away, p_draw: r.p_draw, fair_home_line: r.fair_home_line, fair_total: r.fair_total }),
        readiness: { research: r.research_outcome || null, reasons: [], freshness: null, age_hours: null, invalidated: !!r.invalidated, availability: null, validation: {}, limitations: [] },
        capture: { method: 'import:projections_ledger', captured_at: null, recorded_at: r.frozen_at, run: null, git_sha: null, source: 'engine/projections_ledger/' + n, source_ref: 'engine/projections_ledger/' + n + '#' + r.projection_hash, projection_id: r.projection_id, projection_hash: r.projection_hash } }));
    });
  });
  out.forEach((s) => { s.signature = P.signatureOf(s); });
  return out;
}

module.exports = { SPORT, SUPPORTED, readJson, readLines, csv, currentProjections, loadSlate, matchSlate, slateCandidate, seasonLabel, makeNative, espnDays, importCandidates, nameMaps };
