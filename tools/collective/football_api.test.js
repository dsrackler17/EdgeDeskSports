#!/usr/bin/env node
/* ===========================================================================
   The public API serves the SETTLEMENT (football-v2), end to end.

   supabase/functions/collective_public/index.ts is imported for real under a
   Deno shim, its own request handler is driven, and PostgREST is mocked. Two
   worlds:

     installed   collective.fg2_* answers: every graded number comes from the
                 settlement and the official close, the board shows the row
                 that was graded (the LATEST pre-lock one), the wall and the
                 rankings carry the settlement's record with each metric's own
                 n and the reasons the rest are ungraded.
     not yet     fg2_* answers 404 (not installed): the legacy views answer
                 exactly as before; nothing breaks.

   Run: node tools/collective/football_api.test.js
   =========================================================================== */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function chk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push({ name, detail }); }
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' };
let HANDLER = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { HANDLER = h; } };

let INSTALLED = true;
const G1 = '11111111-1111-1111-1111-111111111111', G2 = '22222222-2222-2222-2222-222222222222';
const M1 = 'dddddddd-0000-0000-0000-000000000001';
const DATA = {
  sports: [{ code: 'NFL', name: 'Football', active: true }],
  sport_seasons: [{ sport_code: 'NFL', season: 2026, starts_on: '2026-08-01', ends_on: '2027-02-28' }],
  game_detail: [
    { game_id: G1, sport: 'NFL', season: 2026, week: 2, kickoff_at: '2026-09-18T00:15:00Z', status: 'final',
      home: 'BUF', away: 'DET', label: 'DET @ BUF', home_score: 41, away_score: 31, closing_spread: null, closing_total: null },
    { game_id: G2, sport: 'NFL', season: 2026, week: 2, kickoff_at: '2026-09-20T17:00:00Z', status: 'final',
      home: 'NYJ', away: 'GB', label: 'GB @ NYJ', home_score: 17, away_score: 20, closing_spread: 3.5, closing_total: null },
  ],
  board_models: [
    { game_id: G1, model_id: M1, creator_slug: 'moose', model_slug: 'nfl', pick_side: null, projected_spread: -3,
      projected_total: null, home_win_prob: null, line_at_submission: null, cover_prob: null,
      received_at: '2026-09-17T10:00:00Z', is_late: false, pick_result: null, margin_error: 13, brier: null },
    { game_id: G1, model_id: M1, creator_slug: 'moose', model_slug: 'nfl', pick_side: null, projected_spread: -12,
      projected_total: null, home_win_prob: 0.8, line_at_submission: null, cover_prob: null,
      received_at: '2026-09-17T21:00:00Z', is_late: false, pick_result: null, margin_error: 2, brier: 0.04 },
    { game_id: G1, model_id: M1, creator_slug: 'moose', model_slug: 'nfl', pick_side: 'home', projected_spread: -20,
      projected_total: null, home_win_prob: 0.99, line_at_submission: null, cover_prob: null,
      received_at: '2026-09-18T00:05:00Z', is_late: true, pick_result: null, margin_error: null, brier: null },
    { game_id: G2, model_id: M1, creator_slug: 'moose', model_slug: 'nfl', pick_side: null, projected_spread: 1,
      projected_total: null, home_win_prob: 0.45, line_at_submission: null, cover_prob: null,
      received_at: '2026-09-20T12:00:00Z', is_late: false, pick_result: null, margin_error: 2, brier: 0.2025 },
  ],
  consensus: [],
  fg2_settlements: [
    { model_id: M1, canonical_game_id: G1, prediction_id: 'p2', prediction_version: 2, prediction_status: 'OK',
      ats_side: 'home', ats_side_source: 'derived', ats_result: 'win', ats_exclusion: null, margin_error: 2,
      mae_exclusion: null, brier: 0.04, brier_exclusion: null, close_home_spread: -5.5 },
    { model_id: M1, canonical_game_id: G2, prediction_id: 'p4', prediction_version: 1, prediction_status: 'OK',
      ats_side: 'away', ats_side_source: 'derived', ats_result: 'win', ats_exclusion: null, margin_error: 2,
      mae_exclusion: null, brier: 0.2025, brier_exclusion: null, close_home_spread: 3.5 },
  ],
  fg2_official_closes: [
    { canonical_game_id: G1, home_spread: -5.5, away_spread: 5.5, source: 'collective_odds', book: 'draftkings',
      observed_at: '2026-09-17T23:55:00Z', lead_minutes: 20, source_snapshot_id: 'odds.lines:2', close_status: 'OK', close_class: 'B' },
    { canonical_game_id: G2, home_spread: 3.5, away_spread: -3.5, source: 'legacy_results_close', book: 'collective',
      observed_at: null, lead_minutes: null, source_snapshot_id: G2, close_status: 'OK', close_class: 'A' },
  ],
  model_wall: [{ creator_slug: 'moose', creator_name: 'Moose', logo_url: null, monogram: 'M', founding: false,
    website_url: null, x_handle: null, membership: 'ACTIVE CONTRIBUTOR', model_slug: 'nfl', model_name: 'Moose NFL',
    sport: 'NFL', graded: 1, wins: 0, losses: 1, pushes: 0, win_pct: 0, margin_mae: 7.5, brier: 0.12,
    coverage_pct: 50, last_submission_at: '2026-09-20T12:00:00Z' }],
  fg2_model_standings: [{ league: 'NFL', season: 2026, model_id: M1, creator_slug: 'moose', model_slug: 'nfl',
    wins: 2, losses: 0, pushes: 0, ats_n: 2, ats_pct: 1, mae: 2, mae_n: 2, brier: 0.12125, brier_n: 2, coverage_pct: 100,
    ats_missing_close: 3, ats_no_side: 1, ats_late: 1, ats_game_not_final: 0, ats_excluded_other: 0 }],
  fg2_model_rankings: [{ league: 'NFL', season: 2026, model_id: M1, creator_slug: 'moose', model_slug: 'nfl',
    wins: 2, losses: 0, pushes: 0, ats_n: 2, ats_pct: 1, mae: 2, mae_n: 2, brier: 0.12125, brier_n: 2, coverage_pct: 100,
    ats_missing_close: 3, ats_no_side: 1, ats_late: 1, ats_game_not_final: 0, ats_excluded_other: 0,
    is_ranked: true, unranked_reason: null, rank_win_pct: 1, rank_margin_mae: 1, rank_brier: 1,
    min_coverage_pct: 0, min_graded_games: 1 }],
  model_rankings: [],
  creators: [{ id: 'cr1', slug: 'moose', display_name: 'Moose', pinned_model_id: null }],
  model_backfill: [],
  models: [{ id: M1, slug: 'nfl', description: null }],
  model_coverage: [],
  model_game_log: [{ game_id: G1, label: 'DET @ BUF', kickoff_at: '2026-09-18T00:15:00Z', week: 2, pick_side: null,
    closing_spread: null, final: '31 - 41', pick_result: null, margin_error: 13, brier: null, movement_n: 3 }],
  fg2_grading_trace: [
    { canonical_game_id: G1, event: 'DET @ BUF', kickoff_at: '2026-09-18T00:15:00Z', week: 2, ats_side: 'home',
      ats_side_source: 'derived', close_home_spread: -5.5, close_source: 'collective_odds', close_book: 'draftkings',
      close_observed_at: '2026-09-17T23:55:00Z', home_score: 41, away_score: 31, ats_calculation: '10 + (-5.5) = 4.5 -> home',
      ats_result: 'win', ats_exclusion: null, margin_error: 2, mae_exclusion: null, brier: 0.04, brier_exclusion: null,
      prediction_version: 2, prediction_versions: 3 },
    { canonical_game_id: 'g9', event: 'LV @ NO', kickoff_at: '2026-09-27T20:25:00Z', week: 3, ats_side: null,
      ats_side_source: null, close_home_spread: null, close_source: null, close_book: null, close_observed_at: null,
      home_score: 27, away_score: 35, ats_calculation: null, ats_result: null, ats_exclusion: 'MISSING_CLOSE',
      margin_error: 6, mae_exclusion: null, brier: null, brier_exclusion: 'MISSING_PROBABILITY',
      prediction_version: 1, prediction_versions: 1 },
  ],
};
function reply(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text),
    headers: { get: (k) => (headers || {})[k.toLowerCase()] || null } };
}
globalThis.fetch = async function (url, init) {
  const u = new URL(String(url));
  const method = (init && init.method) || 'GET';
  if (u.pathname.startsWith('/auth/')) return reply(401, { msg: 'no session' });
  if (u.pathname === '/rest/v1/rpc/get_config') return reply(200, 'null');
  const rel = u.pathname.replace('/rest/v1/', '');
  if (method === 'HEAD') return reply(200, '', { 'content-range': '0-0/0' });
  if (rel.startsWith('fg2_') && !INSTALLED) {
    return reply(404, { code: 'PGRST205', message: `Could not find the table 'collective.${rel}' in the schema cache` });
  }
  let rows = DATA[rel];
  if (!rows) return reply(200, []);
  /* the one filter these routes lean on: in.( ) and eq. on a few keys */
  u.searchParams.forEach((v, k) => {
    if (k === 'select' || k === 'order' || k === 'limit') return;
    const m = /^in\.\((.*)\)$/.exec(v);
    if (m) {
      const vals = m[1].split(',').map(s => s.replace(/^"|"$/g, ''));
      rows = rows.filter(r => r[k] === undefined || vals.includes(String(r[k])));
    } else if (/^eq\./.test(v)) {
      const want = v.slice(3);
      rows = rows.filter(r => r[k] === undefined || String(r[k]) === want);
    }
  });
  return reply(200, rows);
};

(async function () {
  await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'collective_public', 'index.ts'));
  chk('the function registered its handler', typeof HANDLER === 'function');
  const get = async (p) => {
    const res = await HANDLER(new Request('https://sb.test/functions/v1/collective_public' + p));
    return { status: res.status, body: await res.json() };
  };

  /* ---- installed ---------------------------------------------------------- */
  INSTALLED = true;
  let r = await get('/v1/games?sport=NFL&season=2026&week=2');
  const g1 = r.body.games.find(g => g.game_id === G1), m = g1 && g1.models[0];
  chk('games: one row per model per game', g1 && g1.models.length === 1, g1 && g1.models);
  chk('games: the row shown is the LATEST pre-lock one (the graded one), not the first, not the late one',
    m && m.projected_spread === -12 && m.late === false && m.movement_n === 3, m);
  chk('games: the grade IS the settlement (a derived side the legacy grader never graded)',
    m && m.grade && m.grade.pick_result === 'win' && m.grade.margin_error === 2 && m.grade.grading_version === 'football-v2', m && m.grade);
  chk('games: the settlement travels with the row: side, where it came from, reasons',
    m && m.settlement && m.settlement.ats_side === 'home' && m.settlement.ats_side_source === 'derived' &&
    m.settlement.prediction_version === 2, m && m.settlement);
  chk('games: the result carries the ONE official close (-5.5) where the legacy row had none',
    g1.result.closing_spread === -5.5 && g1.result.close && g1.result.close.class === 'B' &&
    g1.result.close.snapshot_id === 'odds.lines:2' && g1.result.close.observed_at === '2026-09-17T23:55:00Z', g1.result);

  r = await get('/v1/wall');
  const w = r.body.rows[0];
  chk('wall: the record is the settlement’s, with each metric’s own n',
    w.record.wins === 2 && w.record.losses === 0 && w.record.ats_n === 2 && w.record.margin_n === 2 &&
    w.record.brier_n === 2 && w.record.grading_version === 'football-v2' && w.coverage_pct === 100, w.record);
  chk('wall: and why the rest are ungraded, by name',
    w.record.ats_missing.MISSING_CLOSE === 3 && w.record.ats_missing.NO_ATS_SIDE === 1 && w.record.ats_missing.LATE_SUBMISSION === 1);

  r = await get('/v1/rankings');
  chk('rankings: served from the settlement, each metric on its own sample',
    r.body.grading_version === 'football-v2' && r.body.boards.win_pct.length === 1 && r.body.boards.win_pct[0].value === 1 &&
    r.body.boards.win_pct[0].n === 2 && r.body.boards.margin_mae[0].value === 2 && r.body.boards.win_pct[0].model_name === 'Moose NFL', r.body);

  r = await get('/v1/models/moose/nfl');
  const log = r.body.recent_graded || [];
  chk('model log: every settled game, graded or not, from the grading trace',
    r.body.grading_version === 'football-v2' && log.length === 2 && log[0].pick_result === 'win' &&
    log[0].ats_calculation === '10 + (-5.5) = 4.5 -> home' && log[0].closing_spread === -5.5, log[0]);
  chk('model log: an ungraded game says why (MISSING_CLOSE) and keeps its margin error',
    log[1] && log[1].pick_result === null && log[1].ats_exclusion === 'MISSING_CLOSE' && log[1].margin_error === 6, log[1]);

  /* ---- not installed ---------------------------------------------------------- */
  INSTALLED = false;
  r = await get('/v1/games?sport=NFL&season=2026&week=2');
  const l1 = r.body.games.find(g => g.game_id === G1), lm = l1 && l1.models[0];
  chk('legacy: without football-v2 the legacy grade and close are served exactly as before',
    r.status === 200 && lm && lm.settlement === null && lm.grade && lm.grade.pick_result === null &&
    lm.grade.margin_error === 2 && l1.result.closing_spread === null && !l1.result.close, { status: r.status, lm, res: l1 && l1.result });
  r = await get('/v1/wall');
  chk('legacy: the wall serves the legacy record', r.body.rows[0].record.wins === 0 && r.body.rows[0].record.losses === 1 &&
    !r.body.rows[0].record.grading_version);
  r = await get('/v1/models/moose/nfl');
  chk('legacy: the model log is the legacy view’s', !r.body.grading_version && r.body.recent_graded.length === 1);

  if (fail) {
    fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
    console.log(`FAILED ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`ALL GREEN ${pass} passed, 0 failed`);
})().catch(e => { console.error(e); process.exit(1); });
