#!/usr/bin/env node
/* Tests for the auto-settler's matching and derivation. Offline and fast:
   every network edge is behind an exported pure function, so the part that
   decides whether a real game gets a real score is the part under test.

   Run: node tools/collective/settle_finals.test.js                        */
'use strict';
const S = require('./settle_finals.js');
let pass = 0, fail = 0; const fails = [];
const chk = (name, ok, detail) => ok ? pass++ : (fail++, fails.push({ name, detail }));

/* ---- the reported game: North Carolina @ TCU ---------------------------- */
/* The Collective truncates to ten characters; the feed spells it out. */
chk('a truncated Collective name matches the feed\'s full spelling',
  S.teamsAgree('NORTHCAROL', 'North Carolina'));
chk('TCU matches exactly', S.teamsAgree('TCU', 'TCU'));
chk('an accent is folded, not deleted',
  S.teamsAgree('San José State', 'San Jose State'));
chk('two different schools never agree', !S.teamsAgree('TCU', 'Texas'));
chk('a short code cannot prefix-match its way into a spelled-out name',
  !S.teamsAgree('NC', 'North Carolina'), { why: 'a code never latches onto a name' });

/* nflverse spells the Rams "LA"; the Collective's schedule says "LAR". Left
   unmatched, a Rams game never settles at all. */
chk('LAR (Collective) joins LA (nflverse)', S.teamsAgree('LAR', 'LA'));
chk('LA joins LAR the other way round', S.teamsAgree('LA', 'LAR'));
chk('LAR still refuses LAC', !S.teamsAgree('LAR', 'LAC'));
chk('NE still refuses NO', !S.teamsAgree('NE', 'NO'));
chk('SF joins SFO', S.teamsAgree('SF', 'SFO'));
chk('a code never becomes a city name',
  !S.teamsAgree('NE', 'New Orleans') && !S.teamsAgree('LA', 'Lafayette'));

const TCU_GAME = {
  game_id: '450b75c2-cc40-4fb2-9067-305af35d9bfa',
  label: 'North Carolina @ TCU', home: 'TCU', away: 'NORTHCAROL',
  kickoff_at: '2026-08-29T16:00:00+00:00', status: 'scheduled', result: null,
};
const FEED = [
  { start_date: '2026-08-29', home_team: 'TCU', away_team: 'North Carolina',
    home_points: '31', away_points: '17', completed: true },
  { start_date: '2026-08-29', home_team: 'Stanford', away_team: "Hawai'i",
    home_points: '', away_points: '', completed: false },
];

const got = S.findFinal(TCU_GAME, FEED);
chk('the finished game resolves to its final',
  got.ok && got.home_score === 31 && got.away_score === 17, got);

const body = S.settleBody(TCU_GAME, got, null);
chk('with no captured close, the line fields go as null and the score still settles',
  body.home_score === 31 && body.away_score === 17 &&
  body.closing_spread === null && body.closing_total === null &&
  body.closing_home_ml_prob === null, body);
chk('a captured close is passed through, never rounded away',
  S.settleBody(TCU_GAME, got, { closing_spread: -7.25, closing_total: 47.5, closing_home_ml_prob: 0.7261 })
    .closing_spread === -7.25);

/* ---- the collision this repo has already been bitten by ------------------ */
/* "NORTHCAROL" is a truncation of North Carolina AND North Carolina State.
   Resolving it to whichever the feed lists first settles one school's game
   with the other's score. */
const BOTH = FEED.concat([{ start_date: '2026-08-29', home_team: 'Duke',
  away_team: 'North Carolina State', home_points: '10', away_points: '20', completed: true }]);
/* Both schools on the same date against the same opponent is the case the
   pair cannot resolve, and it is refused. */
const CLASH = FEED.concat([{ start_date: '2026-08-29', home_team: 'TCU',
  away_team: 'North Carolina Central', home_points: '3', away_points: '0', completed: true }]);
const amb = S.findFinal(TCU_GAME, CLASH);
chk('two schools whose truncation collides, same opponent same day, is refused',
  !amb.ok && amb.reason === 'ambiguous_feed_rows', amb);

/* But an ambiguous NAME alone must not skip the game -- against the real
   feed "NORTHCAROL" also truncates NC Central and NC A&T, and refusing on
   that would skip most of a Saturday. The pair settles it; the row is
   flagged for audit. */
const withSiblings = FEED.concat([
  { start_date: '2026-08-29', home_team: 'Duke', away_team: 'North Carolina Central',
    home_points: '10', away_points: '20', completed: true },
  { start_date: '2026-08-29', home_team: 'Elon', away_team: 'North Carolina A&T',
    home_points: '7', away_points: '14', completed: true }]);
const sib = S.findFinal(TCU_GAME, withSiblings);
chk('an ambiguous truncated name still settles when the PAIR is unique',
  sib.ok && sib.home_score === 31 && sib.away_score === 17, sib);
chk('...and that match is flagged for review rather than settled silently',
  sib.matched_by === 'truncated' && sib.needs_review === true && /North Carolina/.test(sib.joined), sib);

/* An exact match never depends on a truncation and is never flagged. */
const EXACT_GAME = { ...TCU_GAME, away: 'North Carolina' };
const ex = S.findFinal(EXACT_GAME, withSiblings);
chk('an exact match wins outright and needs no review',
  ex.ok && ex.matched_by === 'exact' && ex.needs_review === false, ex);
chk('an exact match beats a truncated one on the same date',
  S.findFinal(EXACT_GAME, withSiblings.concat([{ start_date: '2026-08-29',
    home_team: 'TCU', away_team: 'North Carolina Central',
    home_points: '3', away_points: '0', completed: true }])).home_score === 31);
chk('Washington is still recognised as a name that could mean two schools',
  S.truncationIsAmbiguous('WASHINGTON', S.feedTeamKeys(
    [{ home_team: 'Washington', away_team: 'Washington State' }])));

/* ---- never invent a score ----------------------------------------------- */
const UNPLAYED = [{ start_date: '2026-08-29', home_team: 'TCU', away_team: 'North Carolina',
  home_points: '', away_points: '', completed: false }];
chk('a game the feed has not completed is skipped',
  S.findFinal(TCU_GAME, UNPLAYED).reason === 'not_final_in_feed');
chk('a completed row with no score is skipped, never zero-filled',
  S.findFinal(TCU_GAME, [{ ...UNPLAYED[0], completed: true }]).reason === 'feed_row_has_no_score');

/* ---- 0-0 is never a final ------------------------------------------------
   Two games on the Collective were settled 0-0 — a results form posted with
   nothing typed in it — and every model was graded against the placeholder.
   Nothing that reads or writes a final may accept the shape: a feed row that
   is "completed" at 0-0 is a postponed or canceled game or an unfilled
   placeholder, and a game the Collective already holds at 0-0 is the one
   settled result this script is allowed to write over, with the real score. */
chk('a completed feed row at 0-0 is refused as a placeholder, not settled',
  S.findFinal(TCU_GAME, [{ ...UNPLAYED[0], completed: true, home_points: '0', away_points: '0' }])
    .reason === 'zero_zero_placeholder');
chk('a real shutout still settles',
  S.findFinal(TCU_GAME, [{ ...UNPLAYED[0], completed: true, home_points: '24', away_points: '0' }]).ok);
chk('isPlaceholderResult names the shape and nothing else',
  S.isPlaceholderResult({ home_score: 0, away_score: 0 }) &&
  S.isPlaceholderResult({ home_score: '0', away_score: '0' }) &&
  !S.isPlaceholderResult({ home_score: 0, away_score: 7 }) &&
  !S.isPlaceholderResult({ home_score: null, away_score: null }) &&
  !S.isPlaceholderResult(null));
(() => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const games = [
    { game_id: 'a', kickoff_at: '2026-08-29T16:00:00Z', status: 'final', result: { home_score: 0, away_score: 0 } },
    { game_id: 'b', kickoff_at: '2026-08-29T16:00:00Z', status: 'final', result: { home_score: 31, away_score: 17 } },
    { game_id: 'c', kickoff_at: '2026-08-29T16:00:00Z', status: 'scheduled', result: null },
    { game_id: 'd', kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled', result: null },
    { game_id: 'e', kickoff_at: '2026-08-29T16:00:00Z', status: 'postponed', result: { home_score: 0, away_score: 0 } },
  ];
  const ids = S.needsSettling(games, now).map(g => g.game_id).join(',');
  chk('a game settled 0-0 is settled again; a real result, a future game and a postponement are not',
    ids === 'a,c', { ids });
})();
chk('a game the feed does not carry at all is skipped',
  S.findFinal(TCU_GAME, []).reason === 'no_feed_row');
chk('two rows for one game are refused rather than picked between',
  S.findFinal(TCU_GAME, [FEED[0], { ...FEED[0], home_points: '3', away_points: '0' }])
    .reason === 'ambiguous_feed_rows');
chk('a nonsense score is not a score',
  !S.isFinalScore('') && !S.isFinalScore(null) && !S.isFinalScore('x') &&
  !S.isFinalScore(-1) && !S.isFinalScore(17.5) && S.isFinalScore('17') && S.isFinalScore(0));

/* ---- kickoff dates: UTC storage vs a local publish date ----------------- */
chk('a night game one calendar day apart still matches',
  S.datesAgree('2026-08-30T02:00:00+00:00', '2026-08-29'));
chk('two days apart does not',
  !S.datesAgree('2026-08-31T02:00:00+00:00', '2026-08-29'));
chk('a missing date never matches', !S.datesAgree('', '2026-08-29') && !S.datesAgree('2026-08-29', ''));

/* ---- which games are this job's business -------------------------------- */
const NOW = Date.parse('2026-08-30T00:00:00Z');
const need = S.needsSettling([
  TCU_GAME,
  { ...TCU_GAME, game_id: 'settled', result: { home_score: 1, away_score: 0 } },
  { ...TCU_GAME, game_id: 'future', kickoff_at: '2026-12-01T16:00:00+00:00' },
  { ...TCU_GAME, game_id: 'ppd', status: 'postponed' },
  { ...TCU_GAME, game_id: 'cxl', status: 'canceled' },
], NOW);
chk('only unsettled, kicked-off, live games are touched',
  need.length === 1 && need[0].game_id === TCU_GAME.game_id,
  { got: need.map(g => g.game_id) });

/* ---- feed normalisation -------------------------------------------------- */
chk('nflverse marks a played game by carrying both scores',
  S.normNfl({ gameday: '2026-09-09', home_team: 'SEA', away_team: 'NE',
    home_score: '24', away_score: '20' }).completed === true);
/* ESPN's postponed and canceled statuses sit in state "post" with
   completed:false and both scores "0". Reading the state as corroboration
   settled a game that was never played, 0-0. */
/* =========================================================================
   THE JOB RUNS ITSELF — the database door, the grader, the committed record.

   The hourly workflow depended on an admin refresh token lifted out of a
   browser session and on the collective_admin edge function, neither of
   which lives in this repository; with the token unset it exited 0 having
   settled nothing, for weeks, and the only games that ever settled were
   two an admin clicked by hand — at 0-0. With the service role the games
   workflows already hold, the run writes the database itself and grades by
   the published rule, and commits a record the site reads from its own
   origin. Every piece of that is a pure function or a fake-fetch drive here.
   ========================================================================= */
chk('the service credential is read under the names the games workflows use',
  (() => {
    const c = S.directConfig({ EDGD_SB_SERVICE: 'svc', EDGD_SB_URL: 'https://x.supabase.co/' });
    return c && c.key === 'svc' && c.url === 'https://x.supabase.co' &&
      S.directConfig({ EDGD_SB_URL: 'https://x' }) === null &&
      S.directConfig({}) === null;
  })());
chk('the table shapes are read off the OpenAPI listing, never assumed',
  (() => {
    const cols = S.columnsFrom({ definitions: {
      games: { properties: { id: {}, home_score: {}, away_score: {}, status: {} } },
      projections: { properties: { id: {}, pick_result: {} } } } });
    return cols.games.join(',') === 'id,home_score,away_score,status' &&
      cols.projections.join(',') === 'id,pick_result' &&
      Object.keys(S.columnsFrom(null)).length === 0;
  })());
chk('a game_detail row becomes the shape the public games feed serves',
  (() => {
    const g = S.gameFromDetail({ game_id: 'g1', label: 'A @ B', home: 'B', away: 'A', week: 1, season: 2026,
      kickoff_at: '2026-08-29T16:00:00Z', status: 'final', home_score: 31, away_score: 17,
      closing_spread: -7.5, closing_total: 47.5 });
    const u = S.gameFromDetail({ game_id: 'g2', home: 'B', away: 'A', kickoff_at: '2026-08-29T16:00:00Z',
      status: 'scheduled', home_score: null, away_score: null, closing_spread: null, closing_total: null });
    return g.result && g.result.home_score === 31 && g.result.closing_spread === -7.5 && g.game_id === 'g1' &&
      u.result === null && u.label === 'A @ B';
  })());
chk('the current season is the one today sits inside, else the latest held',
  (() => {
    const sp = [{ code: 'CFB', name: 'College Football' }, { code: 'NFL', name: 'NFL' }, { code: 'MLB', name: 'x' }];
    const se = [{ sport_code: 'CFB', season: 2025, starts_on: '2025-08-20', ends_on: '2026-01-20' },
      { sport_code: 'CFB', season: 2026, starts_on: '2026-08-20', ends_on: '2027-01-20' },
      { sport_code: 'NFL', season: 2025, starts_on: '2025-09-01', ends_on: '2026-02-15' }];
    const out = S.seasonsFrom(sp, se, '2026-09-05');
    return out.length === 2 && out[0].code === 'CFB' && out[0].season === 2026 &&
      out[1].code === 'NFL' && out[1].season === 2025;
  })());

/* THE PUBLISHED RULE, pinned to the fixtures collective/tests_render.js
   grades on the page, so the two graders can never drift apart. */
const TCU_FINAL = { home_score: 48, away_score: 14 };        /* TCU by 34 into -7.5 */
const USC_FINAL = { home_score: 59, away_score: 28 };        /* USC by 31 into -38.5 */
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
chk('a stated home pick that covered is a win, and the margin and Brier follow',
  (() => {
    const g = S.gradeProjection({ pick_side: 'home', projected_spread: -12.5, home_win_prob: 0.78 }, TCU_FINAL, -7.5);
    return g.pick_result === 'win' && near(g.margin_error, 21.5) && near(g.brier, 0.0484);
  })());
chk('a stated home pick into a bigger number is a loss when the favourite wins by less',
  (() => {
    const g = S.gradeProjection({ pick_side: 'home', projected_spread: -32, home_win_prob: 0.96 }, USC_FINAL, -38.5);
    return g.pick_result === 'loss' && near(g.margin_error, 1) && near(g.brier, 0.0016);
  })());
chk('the road side of that same game is a win',
  S.gradeProjection({ pick_side: 'away', projected_spread: -26.5 }, USC_FINAL, -38.5).pick_result === 'win');
chk('landing exactly on the close is a push',
  S.gradeProjection({ pick_side: 'home' }, { home_score: 27, away_score: 20 }, -7).pick_result === 'push');
chk('no pick side is no ATS result — a side is never inferred here — but the margin still counts',
  (() => {
    const g = S.gradeProjection({ pick_side: null, projected_spread: -16.3 }, TCU_FINAL, -7.5);
    return g.pick_result === null && near(g.margin_error, 17.7) && g.brier === null;
  })());
chk('no close is no ATS result either',
  S.gradeProjection({ pick_side: 'home', projected_spread: -12.5 }, TCU_FINAL, null).pick_result === null);
chk('projected scores beat the spread for the margin, and a tie has no Brier',
  (() => {
    const g = S.gradeProjection({ projected_spread: -12.5, proj_home_score: 31, proj_away_score: 17, home_win_prob: 0.7 },
      { home_score: 20, away_score: 20 }, -7.5);
    return near(g.margin_error, 14) && g.brier === null;
  })());

chk('the counting rows are the flagged ones where the lock rule is installed',
  (() => {
    const rows = [
      { id: 'a', model_id: 'm1', is_graded_candidate: true, data_origin: 'live', resolution_status: 'resolved', is_late: false },
      { id: 'b', model_id: 'm1', is_graded_candidate: false, data_origin: 'live', resolution_status: 'resolved', is_late: false },
      { id: 'c', model_id: 'm2', is_graded_candidate: true, data_origin: 'live', resolution_status: 'resolved', is_late: true },
      { id: 'd', model_id: 'm3', is_graded_candidate: true, data_origin: 'backfill', resolution_status: 'resolved', is_late: false },
      { id: 'e', model_id: 'm4', is_graded_candidate: true, data_origin: 'live', resolution_status: 'quarantined', is_late: false },
    ];
    return S.countingRows(rows).map(r => r.id).join(',') === 'a';
  })());
chk('without the flag, the newest pre-lock row per model counts',
  (() => {
    const rows = [
      { id: 'a', model_id: 'm1', received_at: '2026-08-29T10:00:00Z' },
      { id: 'b', model_id: 'm1', received_at: '2026-08-29T12:00:00Z' },
      { id: 'c', model_id: 'm2', received_at: '2026-08-29T11:00:00Z', is_late: true },
      { id: 'd', model_id: 'm3', received_at: '2026-08-28T11:00:00Z' },
    ];
    return S.countingRows(rows).map(r => r.id).sort().join(',') === 'b,d';
  })());

/* The database door, driven end to end against a fake PostgREST. */
(async () => {
  const calls = [];
  const SCHEMA = { definitions: {
    games: { properties: { id: {}, home_score: {}, away_score: {}, closing_spread: {}, closing_total: {}, status: {}, kickoff_at: {} } },
    projections: { properties: { id: {}, model_id: {}, game_id: {}, pick_side: {}, projected_spread: {}, home_win_prob: {},
      is_late: {}, is_graded_candidate: {}, data_origin: {}, resolution_status: {}, pick_result: {}, margin_error: {}, brier: {} } },
  } };
  const PROJ = [
    { id: 'p1', model_id: 'm1', game_id: 'g1', pick_side: 'home', projected_spread: -12.5, home_win_prob: 0.78,
      is_late: false, is_graded_candidate: true, data_origin: 'live', resolution_status: 'resolved' },
    { id: 'p2', model_id: 'm2', game_id: 'g1', pick_side: 'away', projected_spread: -5.5, home_win_prob: null,
      is_late: false, is_graded_candidate: true, data_origin: 'live', resolution_status: 'resolved' },
    { id: 'p3', model_id: 'm2', game_id: 'g1', pick_side: 'away', projected_spread: -6.5, home_win_prob: null,
      is_late: true, is_graded_candidate: false, data_origin: 'live', resolution_status: 'resolved' },
  ];
  const fakeFetch = async (url, opts) => {
    const u = String(url), m = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: m, body, headers: (opts && opts.headers) || {} });
    const reply = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
    if (u.endsWith('/rest/v1/') && m === 'GET') return reply(200, SCHEMA);
    if (u.indexOf('/rest/v1/games?id=eq.g1') >= 0 && m === 'PATCH') return reply(200, [{ id: 'g1', ...body }]);
    if (u.indexOf('/rest/v1/projections?select=') >= 0 && m === 'GET') return reply(200, PROJ);
    if (u.indexOf('/rest/v1/projections?id=eq.p2') >= 0 && m === 'PATCH')
      return reply(403, { message: 'append-only: projections may not be updated' });
    if (u.indexOf('/rest/v1/projections?id=eq.') >= 0 && m === 'PATCH') return reply(200, [{ id: 'p', ...body }]);
    return reply(404, { message: 'no route ' + m + ' ' + u });
  };
  const db = S.dbClient({ url: 'https://x.supabase.co', key: 'svc' }, fakeFetch);
  const schema = await db.schema();
  const game = { game_id: 'g1', label: 'NORTHCAROL @ TCU', home: 'TCU', away: 'NORTHCAROL',
    kickoff_at: '2026-08-29T16:00:00Z', status: 'final', result: { home_score: 0, away_score: 0, closing_spread: null, closing_total: null } };
  const out = await S.settleDirect(db, schema, game, TCU_FINAL, { closing_spread: -7.5, closing_total: 52.5, closing_home_ml_prob: 0.73 });

  const gamePatch = calls.find(c => c.method === 'PATCH' && c.url.indexOf('/games?') >= 0);
  chk('the score, the close and the status are written onto the games row over PostgREST',
    gamePatch && gamePatch.body.home_score === 48 && gamePatch.body.away_score === 14 &&
    gamePatch.body.closing_spread === -7.5 && gamePatch.body.closing_total === 52.5 && gamePatch.body.status === 'final',
    gamePatch && gamePatch.body);
  chk('every write names the collective schema and carries the service role',
    calls.filter(c => c.method === 'PATCH').every(c =>
      c.headers['content-profile'] === 'collective' && c.headers.apikey === 'svc' &&
      c.headers.authorization === 'Bearer svc' && c.headers.prefer === 'return=representation') &&
    calls.filter(c => c.method === 'GET').every(c => c.headers['accept-profile'] === 'collective'));
  chk('a column the table does not carry is not written, and is named as a gap',
    gamePatch && !('closing_home_ml_prob' in gamePatch.body) && out.gaps.indexOf('games.closing_home_ml_prob') >= 0,
    out.gaps);
  const p1 = calls.find(c => c.method === 'PATCH' && c.url.indexOf('projections?id=eq.p1') >= 0);
  chk('the counting projections are graded by the published rule and written back',
    p1 && p1.body.pick_result === 'win' && near(p1.body.margin_error, 21.5) && near(p1.body.brier, 0.0484) &&
    out.candidates === 2 && out.graded === 1,
    { p1: p1 && p1.body, out });
  chk('a late row is never graded',
    !calls.some(c => c.method === 'PATCH' && c.url.indexOf('projections?id=eq.p3') >= 0));
  chk('a grade the database refuses is reported by row, with the server\'s words, not swallowed',
    out.refused.length === 1 && out.refused[0].projection_id === 'p2' && /append-only/.test(out.refused[0].detail),
    out.refused);

  /* a close the row already holds is never blanked by a run that found none */
  calls.length = 0;
  const held = { ...game, result: { home_score: 0, away_score: 0, closing_spread: -6.5, closing_total: 51 } };
  await S.settleDirect(db, schema, held, TCU_FINAL, null);
  const gp2 = calls.find(c => c.method === 'PATCH' && c.url.indexOf('/games?') >= 0);
  chk('a run with no captured close leaves the close the row already holds alone',
    gp2 && !('closing_spread' in gp2.body) && !('closing_total' in gp2.body) && gp2.body.home_score === 48, gp2 && gp2.body);
  const p1b = calls.find(c => c.method === 'PATCH' && c.url.indexOf('projections?id=eq.p1') >= 0);
  chk('and grades against that held close',
    p1b && p1b.body.pick_result === 'win', p1b && p1b.body);

  /* a table with no score columns is refused before anything is written */
  let threw = null;
  try { await S.settleDirect(db, { games: ['id', 'status'], projections: [] }, game, TCU_FINAL, null); }
  catch (e) { threw = e.message; }
  chk('a games table with no score columns stops the run before it writes, and says what it saw',
    /home_score/.test(threw || '') && /id, status/.test(threw || ''), threw);
})().catch(e => chk('the database door drive did not crash', false, String(e && e.stack || e)));

/* The committed record. */
chk('the record file is named by sport and season',
  S.recordPath('collective/settled', 'cfb', 2026).replace(/\\/g, '/') === 'collective/settled/CFB_2026.json');
(() => {
  const game = { game_id: 'g1', label: 'NORTHCAROL @ TCU', home: 'TCU', away: 'NORTHCAROL', week: 1,
    kickoff_at: '2026-08-29T16:00:00Z' };
  const e1 = S.recordEntry(game, TCU_FINAL, { closing_spread: -7.5, closing_total: 52.5, closing_home_ml_prob: 0.73, source: 'collective_odds' }, 'espn+cfbfastR');
  const first = S.mergeRecord(null, 'CFB', 2026, [e1], '2026-08-30T00:00:00Z');
  chk('the first merge writes the record with the schema, the rule and the game',
    first.changed && first.record.schema === S.RECORD_SCHEMA && first.record.sport === 'CFB' && first.record.season === 2026 &&
    first.record.games.g1.home_score === 48 && first.record.games.g1.closing_spread === -7.5 &&
    first.record.games.g1.score_source === 'espn+cfbfastR' && first.record.games.g1.settled_at === '2026-08-30T00:00:00Z' &&
    /0-0 is never a final/.test(first.record.rule),
    first.record);
  const again = S.mergeRecord(first.record, 'CFB', 2026, [e1], '2026-08-31T00:00:00Z');
  chk('the same facts an hour later change nothing — a timestamp-only diff is not a change',
    again.changed === false && again.record === first.record);
  const moved = S.mergeRecord(first.record, 'CFB', 2026,
    [S.recordEntry(game, { home_score: 48, away_score: 17 }, null, 'collective')], '2026-08-31T00:00:00Z');
  chk('a changed fact is written and the moment the record first saw the game is kept',
    moved.changed && moved.record.games.g1.away_score === 17 && moved.record.games.g1.closing_spread === null &&
    moved.record.games.g1.settled_at === '2026-08-30T00:00:00Z' && moved.record.generated_at === '2026-08-31T00:00:00Z');
  const ph = S.mergeRecord(first.record, 'CFB', 2026,
    [S.recordEntry({ ...game, game_id: 'g9' }, { home_score: 0, away_score: 0 }, null, 'collective')], '2026-08-31T00:00:00Z');
  chk('a 0-0 never enters the record, whatever wrote it',
    ph.changed === false && !('g9' in ph.record.games));
  const two = S.mergeRecord(first.record, 'CFB', 2026,
    [S.recordEntry({ ...game, game_id: 'a0' }, USC_FINAL, null, 'espn')], '2026-08-31T00:00:00Z');
  chk('games are kept in a stable order so the diff reads as the change',
    Object.keys(two.record.games).join(',') === 'a0,g1');
})();
chk('--record names the directory the record is written to',
  S.parseArgs(['--commit', '--record', 'collective/settled']).record === 'collective/settled' &&
  S.parseArgs([]).record === null);

/* The workflow has to hand the job the credential it is written for, and
   publish what it wrote. */
(() => {
  const fs = require('fs'), path = require('path');
  let wf = '';
  try { wf = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'settle-finals.yml'), 'utf8'); } catch (_) {}
  const code = wf.split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n');
  chk('settle-finals.yml passes the service role and the project URL under the names the script reads',
    code.indexOf('EDGD_SB_SERVICE: ${{ secrets.SB_SERVICE_ROLE }}') >= 0 && code.indexOf('EDGD_SB_URL: ${{ secrets.SB_URL }}') >= 0);
  chk('it writes the settlement record and commits it',
    code.indexOf('--record collective/settled') >= 0 && code.indexOf('git add collective/settled') >= 0 &&
    /permissions:\s*\n\s*contents:\s*write/.test(code));
  chk('a missing credential no longer ends the run before the script has a chance to build the record',
    (() => {
      const i = code.indexOf('- name: Settle\n');
      const step = i >= 0 ? code.slice(i, code.indexOf('- name:', i + 10)) : '';
      return step.indexOf('node tools/collective/settle_finals.js $ARGS') >= 0 && step.indexOf('exit 0') < 0;
    })());
  chk('it says out loud when the credential is missing, rather than degrading in silence',
    code.indexOf('::warning::SB_SERVICE_ROLE') >= 0);
})();

chk('an ESPN postponed game is not completed, whatever its state says',
  !S.espnCompleted({ name: 'STATUS_POSTPONED', state: 'post', completed: false }) &&
  !S.espnCompleted({ name: 'STATUS_CANCELED', state: 'post', completed: false }) &&
  !S.espnCompleted({ name: 'STATUS_CANCELED', state: 'post', completed: true }) &&
  !S.espnCompleted({ name: 'STATUS_FINAL', state: 'post' }) &&
  S.espnCompleted({ name: 'STATUS_FINAL', state: 'post', completed: true }) &&
  !S.espnCompleted(null));
chk('an unplayed nflverse row is not completed',
  S.normNfl({ gameday: '2026-09-09', home_team: 'SEA', away_team: 'NE',
    home_score: '', away_score: '' }).completed === false);
chk('cfbfastR completed is read from its own flag',
  S.normCfb({ start_date: '2026-08-29', completed: 'TRUE' }).completed === true &&
  S.normCfb({ start_date: '2026-08-29', completed: 'FALSE' }).completed === false);
chk('a quoted comma in the feed does not split the row',
  S.parseCsv('a,b\n"x, y",2')[0].a === 'x, y');

/* ---- the run is a dry run unless told otherwise -------------------------- */
chk('nothing is written without --commit', S.parseArgs([]).commit === false);
chk('--commit is the only thing that writes', S.parseArgs(['--commit']).commit === true);
chk('sport and season are honoured',
  S.parseArgs(['--sport', 'CFB', '--season', '2026']).sport === 'CFB' &&
  S.parseArgs(['--sport', 'CFB', '--season', '2026']).season === 2026);
chk('a sport with no finals feed is not silently mapped to another',
  S.FEED.CFB === 'cfb' && S.FEED.NFL === 'nfl' && S.FEED.MLB === undefined);


/* ---- ESPN, the live source ---------------------------------------------
   A recorded event in ESPN's scoreboard shape. NOTE: this fixture is the
   contract, not a live capture — the sandbox this was written in blocks
   site.api.espn.com, so the adapter is proven against the shape and the
   run is proven against the network by `--verify`. */
const ESPN_EVENT = {
  id: '401752687',
  date: '2026-08-29T16:00Z',
  name: 'North Carolina Tar Heels at TCU Horned Frogs',
  competitions: [{
    date: '2026-08-29T16:00Z',
    status: { type: { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true } },
    competitors: [
      { homeAway: 'home', score: '31', team: { location: 'TCU', name: 'Horned Frogs',
        abbreviation: 'TCU', displayName: 'TCU Horned Frogs', shortDisplayName: 'Horned Frogs' } },
      { homeAway: 'away', score: '17', team: { location: 'North Carolina', name: 'Tar Heels',
        abbreviation: 'UNC', displayName: 'North Carolina Tar Heels', shortDisplayName: 'Tar Heels' } },
    ],
  }],
};
const er = S.normEspn(ESPN_EVENT);
chk('an ESPN final normalises to home/away and a completed flag',
  er.completed === true && er.home_points === '31' && er.away_points === '17' &&
  er.home_team === 'TCU' && er.away_team === 'North Carolina', er);
chk('every ESPN spelling is carried, so a truncated store name can still join',
  er.home_names.includes('TCU') && er.away_names.includes('North Carolina') &&
  er.away_names.includes('UNC') && er.away_names.includes('North Carolina Tar Heels'), er.away_names);
chk('an ESPN row joins the Collective\'s truncated name',
  S.findFinal(TCU_GAME, [er]).ok && S.findFinal(TCU_GAME, [er]).home_score === 31);
chk('an ESPN abbreviation joins too',
  S.findFinal({ ...TCU_GAME, away: 'UNC' }, [er]).ok);

const inProgress = JSON.parse(JSON.stringify(ESPN_EVENT));
inProgress.competitions[0].status.type = { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false };
chk('a game still being played is never settled',
  S.normEspn(inProgress).completed === false &&
  S.findFinal(TCU_GAME, [S.normEspn(inProgress)]).reason === 'not_final_in_feed');

const scheduled = JSON.parse(JSON.stringify(ESPN_EVENT));
scheduled.competitions[0].status.type = { name: 'STATUS_SCHEDULED', state: 'pre', completed: false };
scheduled.competitions[0].competitors.forEach(c => { c.score = '0'; });
chk('a scheduled game showing 0-0 is not a 0-0 final',
  S.findFinal(TCU_GAME, [S.normEspn(scheduled)]).reason === 'not_final_in_feed');

chk('the ESPN url is per-day and asks for the right league',
  /college-football\/scoreboard\?dates=20260829/.test(S.espnUrl('cfb', '20260829')) &&
  /groups=80/.test(S.espnUrl('cfb', '20260829')) &&
  /\/nfl\/scoreboard/.test(S.espnUrl('nfl', '20260909')) &&
  !/groups=80/.test(S.espnUrl('nfl', '20260909')));
chk('a kickoff becomes the day ESPN indexes on',
  S.compactDate('2026-08-29T16:00:00+00:00') === '20260829');

/* ---- sources must AGREE, and the chain heals around a dead one ---------- */
const CSV_ROW = { start_date: '2026-08-29', home_team: 'TCU', away_team: 'North Carolina',
  home_points: '31', away_points: '17', completed: true, source: 'cfbfastR' };
const agreed = S.findAcrossSources(TCU_GAME,
  [{ name: 'espn', rows: [er] }, { name: 'cfbfastR', rows: [CSV_ROW] }]);
chk('two sources that agree settle, and both are named',
  agreed.ok && agreed.home_score === 31 && agreed.agreed_by.join('+') === 'espn+cfbfastR', agreed);

const contradicted = S.findAcrossSources(TCU_GAME, [
  { name: 'espn', rows: [er] },
  { name: 'cfbfastR', rows: [{ ...CSV_ROW, home_points: '28' }] }]);
chk('two sources that disagree settle NOTHING',
  !contradicted.ok && contradicted.reason === 'sources_disagree', contradicted);
chk('...and the disagreement is reported, not hidden',
  /espn 17-31/.test(contradicted.detail) && /17-28/.test(contradicted.detail), contradicted.detail);

chk('a source with nothing for this season is skipped, not fatal',
  S.findAcrossSources(TCU_GAME,
    [{ name: 'cfbfastR', rows: [] }, { name: 'espn', rows: [er] }]).ok,
  { why: 'cfbfastR published no 2026 file at all while the season was live' });
chk('when no source has the game, it says which ones it asked',
  /espn:/.test(S.findAcrossSources(TCU_GAME, [{ name: 'espn', rows: [] }]).detail || 'espn:'));

chk('--verify never writes and never asks for a close',
  S.parseArgs(['--verify']).verify === true && S.parseArgs(['--verify']).commit === false);

fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
