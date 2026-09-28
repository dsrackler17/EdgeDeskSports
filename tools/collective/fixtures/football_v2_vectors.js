/* ===========================================================================
   football-v2 grading vectors, shared by the JS suite
   (tools/collective/football_grading.test.js) and the SQL parity suite
   (tools/collective/football_grading_sql.test.js). One table, two
   implementations: a vector that passes in one and not the other is a red
   line, not a rounding note.

   Every expected value here was worked out by hand from the convention:
     ats_margin_home = (home_score - away_score) + home_close_spread
     > 0 home covers, < 0 away covers, = 0 push
     model_edge_home = close_home_spread - model_fair_home_spread
     > 0 HOME, < 0 AWAY, = 0 no side
   =========================================================================== */
'use strict';

/* [label, home_score, away_score, home_close_spread, cover, ats_margin_home] */
const COVER = [
  ['home -7, home wins by 10', 24, 14, -7, 'home', 3],
  ['home -7, home wins by 7', 21, 14, -7, 'push', 0],
  ['home -7, home wins by 3', 17, 14, -7, 'away', -4],
  ['home +3, home loses by 1', 20, 21, 3, 'home', 2],
  ['home +3, home loses by 3', 17, 20, 3, 'push', 0],
  ['home +3, home loses by 7', 14, 21, 3, 'away', -4],
  ["pick'em, home wins by 3", 20, 17, 0, 'home', 3],
  ["pick'em, tie game", 17, 17, 0, 'push', 0],
  ["pick'em, home loses by 3", 17, 20, 0, 'away', -3],
  ['home -0.5, tie game', 20, 20, -0.5, 'away', -0.5],
  ['home +0.5, tie game', 20, 20, 0.5, 'home', 0.5],
  ['home -0.5, home wins by 1', 21, 20, -0.5, 'home', 0.5],
  ['home +0.5, home loses by 1', 20, 21, 0.5, 'away', -0.5],
  ['large favourite -45.5 covers', 56, 7, -45.5, 'home', 3.5],
  ['large favourite -45.5 fails', 45, 3, -45.5, 'away', -3.5],
  ['home underdog +6.5 wins outright', 27, 24, 6.5, 'home', 9.5],
  ['road favourite: home +10 loses by 14', 10, 24, 10, 'away', -4],
  ['overtime final lands on -6', 29, 23, -6, 'push', 0],
  ['quarter-point close -3.75, home by 4', 24, 20, -3.75, 'home', 0.25],
];

/* [label, explicit_side, fair_home_spread, close_home_spread, side, source, edge_home] */
const SIDE = [
  ['fair -10 into market -7 is HOME', null, -10, -7, 'home', 'derived', 3],
  ['fair -3 into market -7 is AWAY', null, -3, -7, 'away', 'derived', -4],
  ['fair on the close names no side', null, -7, -7, null, null, 0],
  ['explicit away beats a home-leaning line', 'away', -10, -7, 'away', 'explicit', null],
  ['explicit HOME in capitals', 'HOME', -1, -7, 'home', 'explicit', null],
  ['fair +2 into home -1.5 is AWAY', null, 2, -1.5, 'away', 'derived', -3.5],
  ['fair -1 into home +2.5 is HOME', null, -1, 2.5, 'home', 'derived', 3.5],
  ['no fair and no side', null, null, -3, null, null, null],
  ['no close, no explicit side', null, -3, null, null, null, null],
  ["pick'em fair against a +0.5 close is HOME", null, 0, 0.5, 'home', 'derived', 0.5],
];

/* [label, side, cover, result] */
const RESULT = [
  ['home side, home covered', 'home', 'home', 'win'],
  ['home side, away covered', 'home', 'away', 'loss'],
  ['away side, away covered', 'away', 'away', 'win'],
  ['away side, home covered', 'away', 'home', 'loss'],
  ['home side, push', 'home', 'push', 'push'],
  ['away side, push', 'away', 'push', 'push'],
  ['no side', null, 'home', null],
];

/* A complete game to grade end to end, both implementations. Kickoff 19:00Z,
   lock 18:30Z. */
const KICK = '2026-09-13T19:00:00.000Z';
function v(id, at, fields) {
  return Object.assign({ prediction_id: id, received_at: at, data_origin: 'live',
    resolution_status: 'resolved' }, fields || {});
}
const MODEL_GAME = [
  { label: 'explicit side, close, final: graded',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8, home_win_prob: 0.7 })],
    expect: { ats_result: 'win', ats_side_source: 'explicit', margin_error: 2, brier: 0.09, ats_exclusion: null } },
  { label: 'no side, fair -10 into -7: derived HOME',
    game: { home_score: 17, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { projected_spread: -10, home_win_prob: 0.8 })],
    expect: { ats_result: 'loss', ats_side: 'home', ats_side_source: 'derived', margin_error: 7, brier: 0.04 } },
  { label: 'post-lock edit is ignored, the last pre-lock version counts',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [
      v('p1', '2026-09-13T12:00:00Z', { projected_spread: -3, home_win_prob: 0.55 }),
      v('p2', '2026-09-13T18:29:59Z', { projected_spread: -10, home_win_prob: 0.8 }),
      v('p3', '2026-09-13T18:31:00Z', { projected_spread: -1, home_win_prob: 0.5 }),
      v('p4', '2026-09-13T23:00:00Z', { projected_spread: -10, pick_side: 'home', home_win_prob: 1 })],
    expect: { prediction_id: 'p2', prediction_version: 2, post_lock_versions: 2, ats_side: 'home',
      ats_result: 'win', margin_error: 0, brier: 0.04 } },
  { label: 'only a post-lock submission: late, excluded from every metric',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T18:30:00Z', { pick_side: 'home', projected_spread: -9, home_win_prob: 0.7 })],
    expect: { ats_exclusion: 'LATE_SUBMISSION', mae_exclusion: 'LATE_SUBMISSION', brier_exclusion: 'LATE_SUBMISSION',
      ats_result: null, margin_error: null, brier: null } },
  { label: 'missing close: MAE and Brier graded, ATS excluded',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: null,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8, home_win_prob: 0.7 })],
    expect: { ats_exclusion: 'MISSING_CLOSE', ats_result: null, margin_error: 2, brier: 0.09 } },
  { label: 'missing probability: Brier excluded, ATS and MAE graded',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { projected_spread: -8 })],
    expect: { brier_exclusion: 'MISSING_PROBABILITY', ats_result: 'win', margin_error: 2 } },
  { label: 'missing fair spread with a stated side: ATS graded, MAE excluded',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'away', home_win_prob: 0.4 })],
    expect: { ats_result: 'loss', mae_exclusion: 'MISSING_FAIR_SPREAD', brier: 0.36 } },
  { label: 'no side and no fair spread: NO_ATS_SIDE',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { home_win_prob: 0.6 })],
    expect: { ats_exclusion: 'NO_ATS_SIDE', brier: 0.16 } },
  { label: 'model exactly on the close: NO_ATS_SIDE, MAE still graded',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { projected_spread: -7 })],
    expect: { ats_exclusion: 'NO_ATS_SIDE', margin_error: 3 } },
  { label: 'tie game: Brier has no winner, ATS on a pick\'em is a push',
    game: { home_score: 20, away_score: 20, status: 'final' }, close: 0,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -3, home_win_prob: 0.6 })],
    expect: { ats_result: 'push', brier_exclusion: 'TIE_NO_WINNER', margin_error: 3 } },
  { label: 'postponed game: excluded as postponed',
    game: { home_score: null, away_score: null, status: 'postponed' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8 })],
    expect: { ats_exclusion: 'GAME_POSTPONED', mae_exclusion: 'GAME_POSTPONED' } },
  { label: 'cancelled game: excluded as cancelled',
    game: { home_score: null, away_score: null, status: 'canceled' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8 })],
    expect: { ats_exclusion: 'GAME_CANCELLED' } },
  { label: 'unfinished game: excluded as unfinished',
    game: { home_score: null, away_score: null, status: 'scheduled' }, close: null,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8 })],
    expect: { ats_exclusion: 'GAME_UNFINISHED' } },
  { label: '0-0 placeholder is not a final',
    game: { home_score: 0, away_score: 0, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8 })],
    expect: { ats_exclusion: 'GAME_UNFINISHED', margin_error: null } },
  { label: 'backfill data is excluded by origin',
    game: { home_score: 24, away_score: 14, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'home', projected_spread: -8, data_origin: 'backfill' })],
    expect: { ats_exclusion: 'EXCLUDED_ORIGIN' } },
  { label: 'overtime final graded like any final',
    game: { home_score: 29, away_score: 23, status: 'final/OT' }, close: -6,
    versions: [v('p1', '2026-09-13T12:00:00Z', { pick_side: 'away', projected_spread: -2, home_win_prob: 0.55 })],
    expect: { ats_result: 'push', margin_error: 4, brier: 0.2025 } },
  { label: 'projected scores decide MAE; spread decides the derived side',
    game: { home_score: 31, away_score: 17, status: 'final' }, close: -7,
    versions: [v('p1', '2026-09-13T12:00:00Z', { projected_spread: -9, proj_home_score: 30, proj_away_score: 20, home_win_prob: 0.75 })],
    expect: { ats_side: 'home', ats_result: 'win', margin_error: 4, brier: 0.0625 } },
  { label: 'projected scores alone give the fair spread',
    game: { home_score: 20, away_score: 17, status: 'final' }, close: -6.5,
    versions: [v('p1', '2026-09-13T12:00:00Z', { proj_home_score: 24, proj_away_score: 20 })],
    expect: { fair_home_spread: -4, ats_side: 'away', ats_result: 'win', margin_error: 1 } },
];

module.exports = { COVER, SIDE, RESULT, MODEL_GAME, KICK };
