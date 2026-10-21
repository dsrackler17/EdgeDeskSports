#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk college baseball — ask the odds gateway for college baseball
   prices, ONLY when authorised, and keep them so the model can be graded
   against the closing line.

     CBASE_PRICES=on node college_baseball/market/fetch_quotes.js

   Spends nothing unless BOTH switches are on:
     1. the repository variable CBASE_PRICES=on (this job), and
     2. the gateway's own sport row: odds_api_sports.baseball_ncaa enabled
        (supabase/cbase_odds_sport.sql inserts it DISABLED).
   With either off it writes college_baseball/data/market/quotes.json with
   status DISABLED and the reason, and nothing else. It never reads the
   provider key and never names the provider host: the gateway is the only
   client (tools/odds/no_bypass.test.js).

   One request per run: category `featured` (h2h, spreads, totals for every
   upcoming game in one call, about 3 credits when the gateway buys it; served
   from the stored snapshot at no cost inside the gateway's cadence window).

   EACH RUN (college_baseball/market/quotes.js has the rules):
     - folds the snapshot into data/market/<season>/state.json, stamped with
       the snapshot's own time (fetched_at), never this job's clock; a
       snapshot no newer than the last one folded adds nothing;
     - appends every changed price to observations/<date>.jsonl.gz;
     - finalises each event whose first pitch has passed into lines.jsonl
       (its first price seen and its last pregame price, per book and market);
     - takes the model's number for each priced game from the LIVE board
       (board/<season>/<date>.json, point_in_time PREGAME) the first time the
       game is seen with it, with the model version and the served
       configuration's hash, into models.jsonl. A number is taken only before
       the game's first pitch, and a replayed (RETROSPECTIVE) board is never
       read: out of sample means a price captured after the model was frozen.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const Q = require('./quotes');
const GW = require('../../tools/lib/odds_gateway.js');

const ROOT = path.join(__dirname, '..', '..');
const MARKET = path.join(__dirname, '..', 'data', 'market');
const BOARD = path.join(__dirname, '..', 'board');
const SPORT_KEY = 'baseball_ncaa';

/* the date a game is played on, as our record dates it (US Eastern) */
function easternDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function servedConfig(o) {
  const v = Q.readJson(o.versionsFile || path.join(ROOT, 'docs', 'model-loop', 'college_baseball', 'versions.json'), null);
  const cur = v && (v.versions || []).find((x) => x.version === v.current);
  return cur ? { version: cur.version, config_sha256: cur.config_sha256 } : { version: null, config_sha256: null };
}

/* the model's numbers for the events still open, from the live board, first sighting only */
function captureModels(state, at, o) {
  const dir = o.boardDir || BOARD;
  const file = path.join(o.marketDir, 'models.jsonl');
  const have = new Set(Q.readJsonl(file).map((r) => r.game_id + '|' + r.config_sha256));
  const served = servedConfig(o);
  const boards = new Map();
  const rows = []; const missing = [];
  for (const [eventId, s] of Object.entries(state.events || {})) {
    if (!(Date.parse(at) < Date.parse(s.commence_time))) continue;
    const date = easternDate(s.commence_time);
    if (!boards.has(date)) boards.set(date, Q.readJson(path.join(dir, date.slice(0, 4), date + '.json'), null));
    const b = boards.get(date);
    if (!b || b.point_in_time !== 'PREGAME') { missing.push({ event_id: eventId, date, why: b ? 'the board for ' + date + ' is a ' + b.point_in_time + ' replay' : 'no live board for ' + date }); continue; }
    /* the game between these two teams on that date; a doubleheader's games are told apart by order of start */
    const games = b.games.filter((g) => g.ml && g.ml.p_home != null && [g.home.id, g.away.id].sort().join('~') === [s.home_id, s.away_id].sort().join('~'));
    if (!games.length) { missing.push({ event_id: eventId, date, why: 'the board has no priced game between these teams' }); continue; }
    const same = Object.entries(state.events).filter(([, x]) => easternDate(x.commence_time) === date && [x.home_id, x.away_id].sort().join('~') === [s.home_id, s.away_id].sort().join('~'))
      .sort((p, q) => p[1].commence_time.localeCompare(q[1].commence_time) || p[0].localeCompare(q[0]));
    const nth = same.findIndex(([id]) => id === eventId);
    if (games.length !== same.length) { missing.push({ event_id: eventId, date, why: games.length + ' games on the board and ' + same.length + ' events priced between these teams: not paired' }); continue; }
    const g = games[nth];
    const k = g.game_id + '|' + served.config_sha256;
    if (have.has(k)) continue;
    have.add(k);
    const flipped = String(g.home.id) !== String(s.home_id);
    rows.push({ captured_at: at, event_id: eventId, game_id: g.game_id, date, commence_time: s.commence_time, home_id: String(g.home.id), away_id: String(g.away.id),
      provider_home_is_ours: !flipped, p_home: g.ml.p_home, total_line: g.total ? g.total.line : null, p_over: g.total ? g.total.over : null,
      model_version: b.model_version || null, served_version: served.version, config_sha256: served.config_sha256, board_generated_at: b.generated_at || null });
  }
  Q.appendJsonl(file, rows);
  return { captured: rows.length, missing };
}

async function run(o) {
  o = o || {};
  const env = o.env || process.env;
  const now = o.now || new Date().toISOString();
  const marketRoot = o.marketRoot || MARKET;
  const out = path.join(marketRoot, 'quotes.json');
  fs.mkdirSync(marketRoot, { recursive: true });
  const write = (obj) => { fs.writeFileSync(out, JSON.stringify(Object.assign({ schema: 'edgedesk_cbase_market_v1', sport_key: SPORT_KEY, generated_at: now }, obj), null, 1) + '\n'); return obj; };
  if (String(env.CBASE_PRICES || '').toLowerCase() !== 'on') return write({ status: 'DISABLED', reason: 'college baseball price capture is not authorised: the repository variable CBASE_PRICES is not "on" (and odds_api_sports.baseball_ncaa must be enabled in the gateway)' });
  const cfg = GW.config(env);
  if (!cfg) return write({ status: 'UNAVAILABLE', reason: 'no gateway credentials in this job (EDGD_SB_URL / EDGD_SB_SERVICE or ODDS_GATEWAY_SECRET)' });
  const client = GW.client(cfg, o.fetchImpl);
  const g = await client.request({ caller: 'cbase_prices', consumer: 'cbase_prices', category: 'featured', sport_key: SPORT_KEY, odds_format: 'american', allow_stale: true });
  const gateway = { decision: g.decision, source: g.source, fetched_at: g.fetched_at || null, request_id: g.request_id || null, cost: g.cost || 0, quota: g.quota || null };
  if (!g.ok || !Array.isArray(g.data)) return write({ status: 'UNAVAILABLE', reason: 'the gateway refused or failed: ' + (g.decision || '') + ' ' + (g.reason || ''), gateway });
  /* the snapshot's own time: a cached snapshot is as old as it is, never as new as this run */
  const at = g.fetched_at || now;
  const season = Number(easternDate(at).slice(0, 4));
  const marketDir = path.join(marketRoot, String(season));
  const schools = (Q.readJson(o.schoolsFile || path.join(ROOT, 'collegiate', 'data', 'schools.json'), { schools: [] }).schools) || [];
  const teamSeasons = o.teamSeasons || (() => { try { const { readCsv } = require('../../engine/csv'); const rows = readCsv(path.join(__dirname, '..', 'data', 'teams', 'team_seasons.csv')).rows; const last = Math.max(...rows.map((r) => +r.season)); return rows.filter((r) => +r.season === Math.min(season, last)); } catch (_) { return []; } })();
  const index = Q.teamIndex({ schools, teamSeasons, division: 1, aliases: Q.readJson(o.aliasesFile || path.join(__dirname, 'aliases.json'), {}) });
  const events = g.data.map((e) => Q.normaliseEvent(e, index));
  const stateFile = path.join(marketDir, 'state.json');
  const state = Q.readJson(stateFile, { events: {} });
  let folded = { observations: [], finalised: [] };
  const fresh = !state.last_fetched_at || Date.parse(at) > Date.parse(state.last_fetched_at);
  if (fresh) { folded = Q.fold(state, events, at); state.last_fetched_at = at; }
  /* events whose first pitch has passed by now are closed whether or not this snapshot was new */
  const later = Q.fold(state, [], now);
  folded.finalised = folded.finalised.concat(later.finalised);
  Q.appendGz(path.join(marketDir, 'observations', easternDate(at) + '.jsonl.gz'), folded.observations);
  Q.appendJsonl(path.join(marketDir, 'lines.jsonl'), folded.finalised);
  const models = captureModels(state, now, Object.assign({}, o, { marketDir }));
  fs.mkdirSync(marketDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1) + '\n');
  const unmatched = [...new Map(events.filter((e) => e.unmatched).flatMap((e) => [[e.home_name, e.unmatched], [e.away_name, e.unmatched]])).entries()].map(([name, why]) => ({ name, why }))
    .filter((u) => !index.resolve(u.name).id);
  return write({
    status: g.source === 'provider' || g.fresh ? 'LIVE' : 'CACHED', season, gateway, snapshot_new: fresh,
    events: events.length, matched: events.filter((e) => !e.unmatched).length, open_events: Object.keys(state.events).length,
    observations_kept: folded.observations.length, events_closed: [...new Set(folded.finalised.map((r) => r.event_id))].length,
    model_numbers_taken: models.captured, model_numbers_missing: models.missing.slice(0, 50), unmatched_names: unmatched,
    /* names matched by our team name with the rest read as the nickname: for a person to confirm (or correct in aliases.json) */
    matched_by_name_prefix: [...new Set(events.filter((e) => !e.unmatched).flatMap((e) => [e.home_via === 'name_prefix' ? e.home_name + ' = ' + e.home_id : null, e.away_via === 'name_prefix' ? e.away_name + ' = ' + e.away_id : null]).filter(Boolean))].sort(),
    settlement: 'h2h = two-way moneyline; totals and the run line as the provider lists them (assumed provider defaults; a shortened game settles by each book\'s own rules, not verified: release gate G12)',
  });
}

if (require.main === module) {
  run().then((r) => console.log('[cbase prices] ' + r.status + (r.reason ? ': ' + r.reason : '') + (r.events != null ? ' — ' + r.matched + '/' + r.events + ' events matched, ' + r.observations_kept + ' prices changed, ' + r.events_closed + ' closed, ' + r.model_numbers_taken + ' model numbers taken' : '')))
    .catch((e) => { console.error(e.stack || e); process.exit(1); });
}
module.exports = { run, captureModels, easternDate, servedConfig };
