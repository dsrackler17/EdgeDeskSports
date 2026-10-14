#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — load the warehouse, the ledger and the record into nbahist.

     node nba/tools/sync_supabase.js [--season current|2026,2027|all] [--dry-run]

   PostgREST with the service role only (tools/lib/pgrest.js; EDGD_SB_URL /
   EDGD_SB_SERVICE). Idempotent: every table is upserted on its own key, so a
   run repeated writes the same rows. Default scope is incremental — the season
   in progress and the one before it — which keeps a scheduled run to a few
   thousand rows; `--season all` backfills 2002-03 onwards once.

   Without credentials (or with --dry-run) it builds every row and prints the
   counts, writing nothing: the mapping is exercised either way
   (tools/nba/nba.test.js runs it dry).

   It never writes market quotes for a game whose quote file says DISABLED, and
   every quote row carries value_claims = DISABLED.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const D = require('../lib/data');
const LU = require('./lineups');
const PG = require('../../tools/lib/pgrest.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const SCHEMA = 'nbahist';
const nn = (v) => (v == null || v === '' || !isFinite(v) ? null : v);
const iso = (v) => (v ? new Date(v).toISOString() : null);

function gameRows(seasons) {
  return D.games(seasons).map((g) => ({
    game_id: g.game_id, season: g.season, game_type: g.type, scope: g.scope || null, game_date: g.date, start_utc: g.start_utc, neutral: !!g.neutral, bubble: !!g.bubble,
    home_id: g.home_id, away_id: g.away_id, home_score: nn(g.hs), away_score: nn(g.as), overtimes: nn(g.ot),
    home_q: g.h_q1 == null ? null : [g.h_q1, g.h_q2, g.h_q3, g.h_q4], away_q: g.a_q1 == null ? null : [g.a_q1, g.a_q2, g.a_q3, g.a_q4],
    home_ot_points: nn(g.h_ot), away_ot_points: nn(g.a_ot), venue: g.venue || null, city: g.city || null, state: g.state || null, attendance: nn(g.attendance),
    ref_line_home: nn(g.ref_line_home), has_pbp: !!g.pbp, status: g.status, source: g.src || 'S', known_at: null, assumed_available_at: g.assumed_available_at || null, pit: 'RETRO',
  }));
}
function teamGameRows(seasons) {
  return D.teamGames(seasons).filter((r) => r.pts != null).map((r) => ({
    game_id: r.game_id, team_id: r.team_id, opp_id: r.opp_id, season: r.season, start_utc: r.start_utc, is_home: r.home === 1, neutral: r.neutral === 1,
    pts: r.pts, opp_pts: r.opp_pts, minutes: r.min, fgm: r.fgm, fga: r.fga, fg3m: r.fg3m, fg3a: r.fg3a, ftm: r.ftm, fta: r.fta, oreb: r.oreb, dreb: r.dreb,
    ast: r.ast, stl: r.stl, blk: r.blk, tov: r.tov, pf: r.pf, paint_pts: r.paint_pts, fast_break_pts: r.fb_pts, pts_off_tov: r.pts_off_tov, possessions: r.poss,
    rim_a: r.rim_a, rim_m: r.rim_m, paint_a: r.paint_a, paint_m: r.paint_m, mid_a: r.mid_a, mid_m: r.mid_m, c3_a: r.c3_a, c3_m: r.c3_m, ab3_a: r.ab3_a, ab3_m: r.ab3_m,
    transition_fga: r.tr_a, transition_pts: r.tr_pts, heaves: r.heave, city: r.city || null, travel_km: r.travel_km, tz_shift: r.tz_shift, altitude_m: r.alt,
    rest_days: r.rest_days, back_to_back: r.b2b === 1, games_in_7: r.games_7d, road_streak: r.road_streak, home_streak: r.home_streak, assumed_available_at: r.assumed_available_at || null,
  }));
}
function playerGameRows(season) {
  return D.playerGames(season).map((r) => ({
    game_id: r.g, player_id: r.p, team_id: r.tm, season, starter: !!r.st, played: !!r.pl, dnp_reason: r.pl ? null : (r.rc || 'UNKNOWN'),
    minutes: r.min, pts: r.pts, fgm: r.fgm, fga: r.fga, fg3m: r.f3m, fg3a: r.f3a, ftm: r.ftm, fta: r.fta, oreb: r.or, dreb: r.dr, ast: r.ast, stl: r.stl, blk: r.blk, tov: r.tov, pf: r.pf,
    plus_minus: r.pm == null ? null : r.pm, ejected: !!r.ej,
  }));
}
function ledgerRows(season) {
  const f = path.join(C.PATHS.ledger, season + '.jsonl'); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => Date.parse(r.recorded_at) < Date.parse(r.start_utc)).map((r) => ({
    id: r.id, game_id: r.game_id, start_utc: r.start_utc, recorded_at: r.recorded_at, model: r.model, p_home: r.p_home, fair_spread_home: r.fair_spread_home, fair_total: r.fair_total,
    exp_margin: r.exp_margin, exp_total: r.exp_total, sd_margin: r.sd_m, p_overtime: r.p_ot, rotation_stale: !!r.rotation_stale }));
}
function quoteRows() {
  let slate = null; try { slate = JSON.parse(fs.readFileSync(C.PATHS.slate, 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const g of slate.games || []) {
    const m = g.market || {}; if (!m.quotes || !m.quotes.length) continue;
    for (const q of m.quotes) out.push({ game_id: g.game_id, book: q.book, market: q.market, side: q.side, line: q.line, american: q.american, decimal_odds: q.american > 0 ? 1 + q.american / 100 : 1 + 100 / -q.american,
      quote_time: q.quote_time, captured_at: m.captured_at || slate.generated_at, freshness: q.freshness, break_even: q.break_even, model_p: q.model_p, model_push: q.model_push,
      market_novig_p: q.market_novig_p, ev_vs_model: q.ev_vs_model, model_version: m.model_version, value_claims: 'DISABLED' });
  }
  return out;
}
function registryRows() {
  let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'nba_walkforward.json'), 'utf8')); } catch (_) { return []; }
  const sealed = rec.windows && rec.windows.test && rec.windows.test.status === 'SEALED';
  return ['P', 'C'].filter((t) => rec.choice && rec.choice[t]).map((t) => {
    const id = rec.choice[t].chosen; const w = sealed ? rec.windows.selection[id] : rec.windows.test[id];
    return { model_id: id, version: 'edgedesk_nba_v1', track: t, spec_hash: rec.spec_hash, generated_at: rec.generated_at,
      status: sealed ? 'SEALED_SELECTION_ONLY' : ((rec.markets[t] && rec.markets[t].moneyline && rec.markets[t].moneyline.status) || 'PROVISIONAL'),
      record: { window: sealed ? 'selection' : 'test', n: w && w.n, moneyline: w && { log_loss: w.moneyline.log_loss, brier: w.moneyline.brier, calibration_slope: w.moneyline.calibration_slope }, margin_crps: w && w.margin.crps, total_crps: w && w.total.crps } };
  });
}
function playerRows() { return Object.entries(D.playersMap()).map(([id, p]) => ({ player_id: id, name: p.name, position: p.pos, last_team_id: p.team, last_season: p.season })); }

async function run(o) {
  o = o || {};
  const cur = C.currentSeason();
  const spec = o.season || 'current';
  const seasons = spec === 'all' ? D.seasonList(C.FIRST_SEASON, cur) : spec === 'current' ? [cur - 1, cur] : String(spec).split(',').map(Number);
  const plan = [
    ['games', gameRows(seasons), 'game_id'],
    ['team_games', teamGameRows(seasons), 'game_id,team_id'],
    ['players', playerRows(), 'player_id'],
  ];
  for (const s of seasons) plan.push(['player_games', playerGameRows(s), 'game_id,player_id']);
  for (const s of seasons) { const l = LU.aggregate(s); if (l) plan.push(['lineup_seasons', l.map((x) => ({ season: x.season, team_id: x.team_id, lineup_key: x.lineup_key, players: x.players, seconds: x.seconds, poss_off: x.poss_off, poss_def: x.poss_def, pts_for: x.pts_for, pts_against: x.pts_against, off_rating: x.off_rating, def_rating: x.def_rating, net_rating: x.net_rating, net_shrunk: x.net_shrunk, reliability: x.reliability })), 'season,team_id,lineup_key']); }
  for (const s of seasons) plan.push(['predictions', ledgerRows(s), 'id']);
  plan.push(['market_quotes', quoteRows(), 'game_id,book,market,side,line,captured_at']);
  plan.push(['model_registry', registryRows(), 'model_id,version,track']);
  const counts = {}; for (const [t, rows] of plan) counts[t] = (counts[t] || 0) + rows.length;
  const cfg = PG.config(o.env || process.env);
  if (o.dryRun || !cfg) return { written: false, reason: o.dryRun ? 'dry run' : 'no credentials (EDGD_SB_URL / EDGD_SB_SERVICE)', seasons, counts, sample: Object.fromEntries(plan.map(([t, rows]) => [t, rows[0] || null])) };
  const db = PG.client(cfg, o.fetchImpl);
  const runId = 'nba-' + new Date().toISOString();
  await db.upsert(SCHEMA, 'import_runs', [{ run_id: runId, seasons, status: 'running' }], 'run_id', { returning: false });
  try {
    for (const [t, rows, key] of plan) if (rows.length) await db.upsert(SCHEMA, t, rows, key, { returning: false, chunk: 500 });
    await db.upsert(SCHEMA, 'import_runs', [{ run_id: runId, seasons, status: 'ok', finished_at: new Date().toISOString(), counts }], 'run_id', { returning: false });
    await PG.writeMeta(db, SCHEMA, { nba_sync_last_run: new Date().toISOString(), nba_sync_last_status: 'ok' });
  } catch (e) {
    await db.upsert(SCHEMA, 'import_runs', [{ run_id: runId, seasons, status: 'failed', finished_at: new Date().toISOString(), note: String(e.message).slice(0, 500) }], 'run_id', { returning: false }).catch(() => {});
    const hint = PG.contractHint(e, 'nba_engine.sql'); if (hint) console.error('::error::nba sync: ' + hint);
    throw e;
  }
  return { written: true, run_id: runId, seasons, counts };
}

module.exports = { run, gameRows, teamGameRows, playerGameRows, ledgerRows, quoteRows, registryRows };
if (require.main === module) run({ season: arg('season', 'current'), dryRun: flag('dry-run') }).then((r) => console.log('[nba sync] ' + (r.written ? 'wrote' : 'did not write (' + r.reason + ')') + ' seasons ' + r.seasons.join(',') + ': ' + JSON.stringify(r.counts))).catch((e) => { console.error(e.message); process.exit(1); });
