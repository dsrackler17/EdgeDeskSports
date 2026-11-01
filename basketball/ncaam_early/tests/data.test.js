#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM-EARLY data layer — unit suite. No network, no credentials, nothing
   written outside a temporary directory. Every CBBD payload here is SYNTHETIC
   (shaped by the 1.30.1 response schemas); no real CBBD row is in the repo.

     endpoints   every path the client asks for is in the verified spec list
     client      key handling and redaction, call cap, shared-quota reserve,
                 401/429 stop, bounded retries, cap-splitting windows
     normalise   season-label convention, games, box lines and possessions,
                 player seasons, rosters, portal, recruits, lines, PIT labels
     moves       returning / D-I transfer / portal / freshman / unknown,
                 departures, minutes share, the verified year offset
     manual      the committed files validate; bad records are refused; the
                 as-of availability and the coach facts
     ingest      parts end to end on a mocked CBBD and an in-memory database;
                 a missing key fails the run; a manifest carries no data row
     scope       men's only; no odds host; no raw CBBD data committed
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const C = require('../config');
const CB = require('../cbbd');
const N = require('../normalise');
const MV = require('../moves');
const MAN = require('../manual');
const ING = require('../ingest');

let pass = 0, fail = 0; const fails = [];
const chk = (label, ok, detail) => { if (ok) pass++; else { fail++; fails.push(label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } };
const KEY = 'test-key-0123456789abcdef';

/* a mocked fetch: route(url) -> { status, body, headers } */
function mockFetch(route) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, auth: init && init.headers && init.headers.Authorization });
    const r = await route(url, calls.length);
    if (r && r.throw) throw new Error(r.throw);
    const h = new Map(Object.entries((r && r.headers) || {}));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) }, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}
const noSleep = () => Promise.resolve();

(async () => {
  /* ═══ endpoints ═══════════════════════════════════════════════════════════ */
  const E = CB.endpoints();
  chk('endpoints: the list names the spec it was checked against', E.spec_version === '1.30.1' && /^[0-9a-f]{64}$/.test(E.spec_sha256) && E.verified_at === '2026-11-01');
  const used = ['/teams', '/conferences/history', '/venues', '/games', '/games/teams', '/stats/player/season', '/teams/roster', '/recruiting/portal', '/recruiting/players', '/lines'];
  chk('endpoints: every path the ingest calls is in the verified list', used.every((p) => E.endpoints[p]), used.filter((p) => !E.endpoints[p]));
  const src = fs.readFileSync(path.join(__dirname, '..', 'ingest.js'), 'utf8');
  const named = [...new Set((src.match(/'\/[a-z/]+'/g) || []).map((s) => s.slice(1, -1)))].filter((p) => p !== '/');
  chk('endpoints: no path in ingest.js outside the verified list', named.every((p) => E.endpoints[p]), named.filter((p) => !E.endpoints[p]));
  chk('endpoints: the documented row caps are recorded (3,000 games; no cap on rosters)', E.endpoints['/games'].row_cap === 3000 && E.endpoints['/lines'].row_cap === 3000 && E.endpoints['/teams/roster'].row_cap === null);
  chk('endpoints: no coaches endpoint is claimed (the spec has none)', !Object.keys(E.endpoints).some((p) => /coach/i.test(p)) && E.not_in_spec.some((s) => /coaches/.test(s)));
  chk('check: an unknown path is refused', /not in the verified/.test(CB.check('/coaches', {})));
  chk('check: an unknown parameter is refused', /not accepted/.test(CB.check('/games', { week: 1 })));
  chk('check: a required parameter is enforced', /requires season/.test(CB.check('/teams/roster', {})));
  chk('buildUrl: sorted, encoded, empty values dropped', CB.buildUrl('https://x.test/', '/games', { season: 2026, startDateRange: '2025-11-01T00:00:00Z', team: null }) === 'https://x.test/games?season=2026&startDateRange=2025-11-01T00%3A00%3A00Z');

  /* ═══ client ══════════════════════════════════════════════════════════════ */
  {
    const f = mockFetch(() => ({ status: 200, body: [] }));
    const c = CB.client({ key: '', fetch: f, sleep: noSleep });
    const r = await c.get('/teams', { season: 2026 });
    chk('client: no key -> refused, and no request is made', !r.ok && /no CBBD_API_KEY/.test(r.refused) && f.calls.length === 0);
  }
  {
    const f = mockFetch(() => ({ status: 200, body: [{ id: 1 }], headers: { 'x-calllimit-remaining': '812' } }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep });
    const r = await c.get('/teams', { season: 2026 });
    chk('client: the key is sent as a Bearer token; the provider\'s remaining count is read', r.ok && f.calls[0].auth === 'Bearer ' + KEY && c.state.remaining === 812 && r.remaining === 812);
    chk('client: the key is never in the URL or the call log', !f.calls[0].url.includes(KEY) && !JSON.stringify(c.state.log).includes(KEY));
  }
  {
    const f = mockFetch(() => ({ throw: 'socket hang up while sending ' + KEY }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep });
    const r = await c.get('/teams', { season: 2026 });
    chk('client: a network error is retried at most twice and the key is redacted from it', !r.ok && f.calls.length === 3 && !r.error.includes(KEY) && /\[redacted\]/.test(r.error));
  }
  {
    const f = mockFetch(() => ({ status: 503, body: null }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep });
    const r = await c.get('/teams', { season: 2026 });
    chk('client: a 5xx is retried at most twice', !r.ok && f.calls.length === 3 && r.status === 503);
  }
  {
    const f = mockFetch(() => ({ status: 400, body: null }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep });
    const r = await c.get('/teams', { season: 2026 });
    chk('client: a 4xx is not retried', !r.ok && f.calls.length === 1);
  }
  for (const st of [401, 429]) {
    const f = mockFetch(() => ({ status: st, body: null }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep });
    await c.get('/teams', { season: 2026 });
    const r2 = await c.get('/venues', {});
    chk('client: HTTP ' + st + ' stops the run (no further call)', f.calls.length === 1 && !r2.ok && /stopped earlier/.test(r2.refused));
  }
  {
    const f = mockFetch(() => ({ status: 200, body: [], headers: { 'x-calllimit-remaining': '150' } }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep, reserve: 300 });
    await c.get('/teams', { season: 2026 });
    const r = await c.get('/venues', {});
    chk('client: below the shared-quota reserve, no further call (the football jobs keep their allowance)', f.calls.length === 1 && /reserve of 300/.test(r.refused));
  }
  {
    const f = mockFetch(() => ({ status: 200, body: [] }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep, maxCalls: 2 });
    await c.get('/venues', {}); await c.get('/venues', {});
    const r = await c.get('/venues', {});
    chk('client: the per-run call cap holds', f.calls.length === 2 && /call cap \(2\)/.test(r.refused));
  }
  {
    /* 7,000 games over a season; the endpoint returns at most 3,000 */
    const t0 = Date.parse('2025-11-01T00:00:00Z');
    const all = []; for (let i = 0; i < 7000; i++) all.push({ id: i + 1, startDate: new Date(t0 + i * 1800e3).toISOString() });   // every 30 min: Nov 1 to late March
    const f = mockFetch((url) => {
      const u = new URL(url); const a = Date.parse(u.searchParams.get('startDateRange')), b = Date.parse(u.searchParams.get('endDateRange'));
      return { status: 200, body: all.filter((g) => Date.parse(g.startDate) >= a && Date.parse(g.startDate) <= b).slice(0, 3000) };
    });
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep, maxCalls: 50 });
    const r = await c.windowed('/games', { season: 2026 }, '2025-10-01T00:00:00Z', '2026-04-30T23:59:59Z');
    const ids = new Set(r.rows.map((g) => g.id));
    chk('windowed: a window at the cap is split until none is, and every row arrives once', r.ok && r.rows.length === 7000 && ids.size === 7000 && r.split >= 2 && r.windows.every((w) => w.rows < 3000), { n: r.rows && r.rows.length, split: r.split });
  }
  {
    const f = mockFetch(() => ({ status: 200, body: new Array(3000).fill({ id: 1 }) }));
    const c = CB.client({ key: KEY, fetch: f, sleep: noSleep, maxCalls: 200 });
    const r = await c.windowed('/games', {}, '2025-11-01T00:00:00Z', '2025-11-02T00:00:00Z');
    chk('windowed: a one-day window still at the cap is an error, never a silent truncation', !r.ok && /cannot be split further/.test(r.error));
  }

  /* ═══ normalise ═══════════════════════════════════════════════════════════ */
  chk('seasonOf: 2026 with label 2025-26 is the END-year convention', N.seasonOf({ season: 2026, seasonLabel: '2025-26' }).season === 2026);
  chk('seasonOf: 2025 with label 2025-26 is refused (a START-year convention)', /does not end the label/.test(N.seasonOf({ season: 2025, seasonLabel: '2025-26' }).err));
  chk('seasonOf: the century turn (1999-00 is 2000)', N.seasonOf({ season: 2000, seasonLabel: '1999-00' }).season === 2000);
  const G = (o) => Object.assign({ id: 10, sourceId: '401', season: 2026, seasonLabel: '2025-26', seasonType: 'regular', startDate: '2025-11-04T00:00:00.000Z', status: 'final',
    homeTeamId: 1, awayTeamId: 2, homePoints: 80, awayPoints: 70, neutralSite: false, conferenceGame: false }, o);
  {
    const g = N.games([G(), G({ id: 11, homePoints: 70, awayPoints: 70 }), G({ id: 12, status: 'final', homePoints: null }), G({ id: 13, status: 'scheduled', homePoints: 0, awayPoints: 0 }), G({ id: 14, seasonLabel: '2026-27' }), G({ id: 10, homePoints: 81 })]);
    const by = new Map(g.rows.map((r) => [r.game_id, r]));
    chk('games: a final keeps its score and is assumed known 4 h after tip', by.get(10).status === 'FINAL' && by.get(10).assumed_available_at === '2025-11-04T04:00:00Z');
    chk('games: a tied or scoreless final is rejected, never repaired', !by.has(11) && !by.has(12) && g.rejected.filter((r) => /decided score/.test(r.reason)).length === 2);
    chk('games: a scheduled game carries no score', by.get(13).status === 'SCHEDULED' && by.get(13).home_points === null);
    chk('games: a season/label mismatch is rejected', !by.has(14));
    chk('games: a duplicate id keeps the later row and says so', by.get(10).home_points === 81 && g.rejected.some((r) => /duplicate id/.test(r.reason)));
  }
  {
    const ts = (o) => Object.assign({ points: { total: 75 }, fieldGoals: { made: 28, attempted: 60 }, threePointFieldGoals: { made: 7, attempted: 20 }, freeThrows: { made: 12, attempted: 18 },
      rebounds: { offensive: 10, defensive: 25, total: 35 }, turnovers: { total: 12, teamTotal: 1 }, assists: 14, steals: 6, blocks: 3, fouls: { total: 17 }, possessions: 70 }, o);
    const b = N.boxTeam([{ gameId: 10, teamId: 1, season: 2026, seasonLabel: '2025-26', startDate: '2025-11-04T00:00:00Z', opponentId: 2, isHome: true, teamStats: ts(), opponentStats: ts({ points: { total: 70 } }) },
      { gameId: 10, teamId: 2, season: 2026, seasonLabel: '2025-26', isHome: false, teamStats: ts({ points: { total: 99 } }), opponentStats: ts() },
      { gameId: 11, teamId: 1, season: 2026, seasonLabel: '2025-26', teamStats: ts({ freeThrows: { made: 0, attempted: null } }), opponentStats: ts() }]);
    const r = b.rows[0];
    chk('box: possessions = FGA - OREB + TOV + 0.475 FTA (60 - 10 + 12 + 8.55 = 70.55)', r.possessions === 70.55 && r.poss_src === 70 && r.box_ok === true, r);
    chk('box: points that do not add up to the shots are flagged, not dropped', b.rows[1].box_ok === false && /POINTS_NE_SHOTS/.test(b.rows[1].box_issues));
    chk('box: a missing FTA leaves possessions null and the line flagged', b.rows[2].possessions === null && /NO_FTA/.test(b.rows[2].box_issues));
  }
  {
    const p = N.playerSeasons([{ season: 2026, seasonLabel: '2025-26', teamId: 1, athleteId: 100, name: 'Synthetic One', games: 30, minutes: 900, points: 450, usage: 24.5, PORPAG: 3.1, rebounds: { total: 150, offensive: 40, defensive: 110 }, winShares: { total: 4.2, offensive: 2.8, defensive: 1.4 }, fieldGoals: { made: 160, attempted: 340 } },
      { season: 2026, seasonLabel: '2025-26', teamId: 1, athleteId: 101, games: 2, minutes: 200 }]);
    chk('player seasons: fields map (usage, PORPAG, rebounds, win shares)', p.rows.length === 1 && p.rows[0].usage === 24.5 && p.rows[0].porpag === 3.1 && p.rows[0].orb === 40 && p.rows[0].ws === 4.2 && p.rows[0].fga === 340 && p.rows[0].as_of === null);
    chk('player seasons: 100 minutes a game is implausible and rejected', p.rejected.length === 1 && /implausible minutes/.test(p.rejected[0].reason));
  }
  {
    const body = [{ teamId: 1, season: 2027, players: [{ id: 100, name: 'A', height: 78, startSeason: 2025 }, { id: 101, name: 'B', height: 7.5 }, { id: 100, name: 'A' }] }];
    const live = N.rosters(body, 2027, '2026-11-01T12:00:00Z', '2026-11-03T00:00:00Z');
    const retro = N.rosters(body, 2027, '2026-12-01T12:00:00Z', '2026-11-03T00:00:00Z');
    chk('rosters: captured before the first tip is LIVE, after it RETRO, unknown tip RETRO', live.rows[0].pit === 'LIVE' && retro.rows[0].pit === 'RETRO' && N.rosters(body, 2027, '2026-11-01T12:00:00Z', null).rows[0].pit === 'RETRO');
    chk('rosters: a height outside 60-96 in is not a height (null), a duplicate player is rejected', live.rows[1].height_in === null && live.rows[0].height_in === 78 && live.rejected.some((r) => /twice/.test(r.reason)));
    chk('rosters: a roster of another season is rejected', N.rosters([{ teamId: 1, season: 2026, players: [] }], 2027, 'x', null).rejected.length === 1);
  }
  {
    const l = N.lines([{ gameId: 10, season: 2026, seasonLabel: '2025-26', startDate: '2025-11-04T00:00:00Z', lines: [{ provider: 'P', spread: -3.5, overUnder: 141, spreadOpen: -2.5 }, { provider: 'P', spread: -4 }] }], '2026-11-01T00:00:00Z', new Map());
    chk('lines: a line read after tip is RETRO; a provider twice is rejected', l.rows.length === 1 && l.rows[0].pit === 'RETRO' && l.rows[0].spread_open === -2.5 && l.rejected.length === 1);
    const l2 = N.lines([{ gameId: 10, season: 2027, seasonLabel: '2026-27', lines: [{ provider: 'P', spread: -1 }] }], '2026-11-01T00:00:00Z', new Map([[10, '2026-11-05T00:00:00Z']]));
    chk('lines: read before tip, LIVE', l2.rows[0].pit === 'LIVE' && l2.rows[0].tip_utc === '2026-11-05T00:00:00Z');
  }
  {
    const p = N.portal([{ id: 5, year: 2026, firstName: 'C', lastName: 'D', origin: { id: null, name: 'Some State College', conference: null }, destination: { id: 1, name: 'T1', conference: 'X' }, stars: 3, rating: 0.86 }, { id: 5, year: 2026 }], 'now');
    chk('portal: origin and destination kept; an entry twice is rejected', p.rows.length === 1 && p.rows[0].origin_team_id === null && p.rows[0].dest_team_id === 1 && p.rejected.length === 1);
  }

  /* ═══ moves ═══════════════════════════════════════════════════════════════ */
  {
    const S = 2027, at = '2026-11-01T12:00:00Z';
    const ros = (tid, pid, name, start) => ({ season: S, team_id: tid, player_id: pid, name, start_season: start, captured_at: at, pit: 'LIVE' });
    const rosters = [ros(1, 100, 'Ret Urner', 2025), ros(1, 101, 'Trans Fer', 2027), ros(1, 102, 'Port Al', 2027), ros(1, 103, 'Fresh Man', 2027), ros(1, 104, 'No Body', 2027), ros(1, 105, 'Red Shirt', 2025), ros(1, 106, 'Port Two', 2027),
      ros(2, 200, 'Stay Er', 2024), ros(2, 110, 'Gone Er', 2027)];
    const prev = [{ team_id: 1, athlete_id: 100, name: 'Ret Urner', minutes: 600, games: 30 }, { team_id: 1, athlete_id: 110, name: 'Gone Er', minutes: 300 }, { team_id: 1, athlete_id: 111, name: 'Left Er', minutes: 100 },
      { team_id: 2, athlete_id: 101, name: 'Trans Fer', minutes: 800, usage: 27 }, { team_id: 2, athlete_id: 200, name: 'Stay Er', minutes: 200 }];
    const portal = [{ portal_id: 1, year: 2026, first_name: 'Port', last_name: 'Al', origin_team_id: null, origin_name: 'Small College', dest_team_id: 1 },
      { portal_id: 2, year: 2026, first_name: 'Port', last_name: 'Two', origin_team_id: null, origin_name: 'Unlisted U', dest_team_id: 1 }];
    const recruits = [{ recruit_id: 9, year: 2026, athlete_id: 103, name: 'Fresh Man', committed_team_id: 1, stars: 4, rating: 0.95 }];
    const d = MV.derive({ season: S, rosters, prevPlayers: prev, curTeams: [{ team_id: 1, conference_id: 7 }, { team_id: 2, conference_id: 8 }], prevTeams: [{ team_id: 1, conference_id: 7 }, { team_id: 2, conference_id: 8 }],
      portal, recruits, schoolLevels: { entries: [{ name: 'Small College', level: 'D2', source_url: 'https://x.test', entered_at: at }] }, portalOffset: 1, recruitOffset: 1 });
    const by = new Map(d.moves.map((m) => [m.player_id, m]));
    chk('moves: same team last season -> RETURNING with its minutes share (600 of 1,000)', by.get(100).kind === 'RETURNING' && by.get(100).prev_minutes_share === 0.6);
    chk('moves: another D-I team last season -> TRANSFER_D1 with origin, level and usage', by.get(101).kind === 'TRANSFER_D1' && by.get(101).from_team_id === 2 && by.get(101).from_level === 'D1' && by.get(101).prev_usage === 27 && by.get(101).prev_minutes_share === 0.8);
    chk('moves: a portal entry from a listed school -> TRANSFER_PORTAL at its level (D2)', by.get(102).kind === 'TRANSFER_PORTAL' && by.get(102).from_level === 'D2' && by.get(102).from_level_basis === 'manual/school_levels.json');
    chk('moves: a portal entry from an unlisted school -> NON_D1_UNCLASSIFIED, never guessed', by.get(106).kind === 'TRANSFER_PORTAL' && by.get(106).from_level === 'NON_D1_UNCLASSIFIED');
    chk('moves: a recruit by athlete id -> FRESHMAN with stars and rating', by.get(103).kind === 'FRESHMAN' && by.get(103).stars === 4 && by.get(103).evidence === 'recruit_athlete_id');
    chk('moves: new on the roster with no record -> NEW_UNKNOWN_SOURCE; on it before -> RETURNING_NO_STATS', by.get(104).kind === 'NEW_UNKNOWN_SOURCE' && by.get(105).kind === 'RETURNING_NO_STATS');
    const dep = new Map(d.departed.map((x) => [x.player_id, x]));
    chk('moves: a departure to another D-I roster names it; otherwise LEFT_OR_UNKNOWN', dep.get(110).destination === 'D1_ROSTER' && dep.get(110).to_team_id === 2 && dep.get(111).destination === 'LEFT_OR_UNKNOWN' && dep.get(101).from_team_id === 2);
    chk('moves: a returning player is not departed', !dep.has(100) && !dep.has(200));
    const d3 = MV.derive({ season: S, rosters, prevPlayers: prev, curTeams: [], prevTeams: [{ team_id: 1, conference_id: 7 }, { team_id: 2, conference_id: null }], portal: [], recruits: [], schoolLevels: { entries: [] }, portalOffset: null, recruitOffset: null });
    chk('moves: a previous team listed WITHOUT a conference is not D-I (NON_D1_UNCLASSIFIED), never assumed', d3.moves.find((m) => m.player_id === 101).from_level === 'NON_D1_UNCLASSIFIED');
    const d2 = MV.derive({ season: S, rosters, prevPlayers: prev, curTeams: [], prevTeams: [], portal, recruits, schoolLevels: { entries: [] }, portalOffset: null, recruitOffset: null });
    chk('moves: with no verified year offset the portal and recruits are not used at all', d2.counts.portal_used === false && !d2.moves.some((m) => m.kind === 'TRANSFER_PORTAL' || m.kind === 'FRESHMAN'));
  }
  {
    const idx = new Map([[2027, new Map([[1, new Set()]])]]);
    const entries = [];
    for (let i = 0; i < 80; i++) { idx.get(2027).get(1).add(MV.normName('Player ' + 'abcdefghij'[i % 10] + 'x' + i)); entries.push({ year: 2026, team: 1, name: 'Player ' + 'abcdefghij'[i % 10] + 'x' + i }); }
    const v = MV.verifyOffset(entries, idx, (e) => e.team, (e) => e.name);
    chk('verifyOffset: entries on the NEXT season\'s roster -> offset 1', v.offset === 1 && v.score[1].rate === 1);
    chk('verifyOffset: too few entries -> unverified (null)', MV.verifyOffset(entries.slice(0, 10), idx, (e) => e.team, (e) => e.name).offset === null);
  }
  chk('normName: accents, suffixes and punctuation do not split a name', MV.normName('José O\'Neal Jr.') === MV.normName('Jose ONeal'));

  /* ═══ manual ══════════════════════════════════════════════════════════════ */
  const all = MAN.loadAll('2026-11-01T12:00:00Z');
  chk('manual: the committed coaches, availability and school-level files validate', all.coaches.ok && all.availability.ok && all.school_levels.ok, [all.coaches.errors, all.availability.errors, all.school_levels.errors]);
  const coach = { season: 2027, team_id: 1, team_name: 'Synthetic State', coach: 'A. Coach', first_season_at_school: 2027, prior_job: { team_name: 'Other U', level: 'D1', role: 'HEAD', internal_promotion: false },
    career: [{ team_name: 'Other U', level: 'D1', role: 'HEAD', from_season: 2015, to_season: 2026 }], source_urls: ['https://example.test/hire'], confidence: 'confirmed', entered_by: 'test', entered_at: '2026-11-01T10:00:00Z' };
  const cv = MAN.validateCoaches({ schema: 'edgedesk_ncaam_early_coaches_v1', entries: [coach] }, '2026-11-01T12:00:00Z');
  chk('coaches: a complete record validates', cv.ok, cv.errors);
  const bad = MAN.validateCoaches({ schema: 'edgedesk_ncaam_early_coaches_v1', entries: [Object.assign({}, coach, { source_urls: [] }), Object.assign({}, coach, { team_id: 2, entered_at: '2027-01-01T00:00:00Z' }), Object.assign({}, coach, { team_id: 3, first_season_at_school: 2028 })] }, '2026-11-01T12:00:00Z');
  chk('coaches: no source, a future entry time, a first season after the season -> refused', !bad.ok && bad.errors.some((e) => /source_urls/.test(e)) && bad.errors.some((e) => /entered_at/.test(e)) && bad.errors.some((e) => /first_season_at_school/.test(e)), bad.errors);
  const cf = MAN.coachFacts([coach, Object.assign({}, coach, { team_id: 2, first_season_at_school: 2020, prior_job: { team_name: 'Same U', level: 'D1', role: 'ASSISTANT', internal_promotion: true } })], 2027, 1);
  chk('coachFacts: a first season = this season -> coach change, tenure 1, prior level D1', cf.coach_change === true && cf.tenure_years === 1 && cf.prior_level === 'D1');
  chk('coachFacts: an internal promotion is named; no record -> null (unknown, never "same coach")', MAN.coachFacts([Object.assign({}, coach, { prior_job: { team_name: 'X', level: 'D1', role: 'ASSISTANT', internal_promotion: true } })], 2027, 1).prior_level === 'INTERNAL_PROMOTION' && MAN.coachFacts([coach], 2027, 99) === null);
  const av = (o) => Object.assign({ id: 'av_1', season: 2027, team_id: 1, game_date: '2026-11-04', player_name: 'X', status: 'OUT', source_url: 'https://example.test/report', published_at: '2026-11-03T15:00:00Z', entered_at: '2026-11-03T16:00:00Z', entered_by: 'test', confidence_note: 'team release' }, o);
  const avd = { schema: 'edgedesk_ncaam_early_availability_v1', entries: [av(), av({ id: 'av_2', status: 'AVAILABLE', supersedes: 'av_1', published_at: '2026-11-04T15:00:00Z', entered_at: '2026-11-04T15:30:00Z' })] };
  chk('availability: an append-only correction validates', MAN.validateAvailability(avd, '2026-11-05T00:00:00Z').ok);
  chk('availability: as of a time, only what was published AND entered by then; a superseded entry is gone',
    MAN.availabilityAsOf(avd.entries, '2026-11-03T20:00:00Z').map((e) => e.id).join() === 'av_1' && MAN.availabilityAsOf(avd.entries, '2026-11-04T20:00:00Z').map((e) => e.id).join() === 'av_2'
    && MAN.availabilityAsOf(avd.entries, '2026-11-03T15:30:00Z').length === 0);
  const avb = MAN.validateAvailability({ schema: 'edgedesk_ncaam_early_availability_v1', entries: [av({ supersedes: 'av_9' }), av({ id: 'av_1', status: 'GONE' }), av({ id: 'av_3', source_url: 'http://insecure.test' })] }, '2026-11-05T00:00:00Z');
  chk('availability: an unknown supersedes, a reused id, an unknown status, a non-https source -> refused', !avb.ok && avb.errors.length >= 4, avb.errors);

  /* ═══ ingest end to end ═══════════════════════════════════════════════════ */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaam-early-'));
  const realCache = C.PATHS.cache;
  C.PATHS.cache = tmp; C.PATHS.raw = (s, p) => path.join(tmp, 'raw', String(s), p + '.json.gz');
  try {
    const memdb = () => {
      const calls = []; let n = 0;
      return { calls, async rpc(name, args) { calls.push({ name, args }); if (name === 'ncaam_es_begin_run') return 'run-' + (++n); if (name === 'ncaam_es_put' || name === 'ncaam_es_put_rosters') return { inserted: args.p_rows.length, updated: 0 }; if (name === 'ncaam_es_replace_derived') return { stale_moves_removed: 0 }; return null; } };
    };
    const S = 2027;
    const fx = {
      '/teams': [{ id: 1, sourceId: '2', school: 'Synthetic A', conferenceId: 7 }, { id: 2, sourceId: '999999', school: 'Synthetic B', conferenceId: 8 }],
      '/games': [G({ id: 50, season: S, seasonLabel: '2026-27', startDate: '2026-11-03T23:00:00Z', status: 'scheduled', homePoints: null, awayPoints: null })],
      '/teams/roster': [{ teamId: 1, season: S, players: [{ id: 100, name: 'Synthetic Player', startSeason: 2026 }] }, { teamId: 2, season: S, players: [{ id: 200, name: 'Synthetic Other', startSeason: 2027 }] }],
      '/stats/player/season': [{ season: S - 1, seasonLabel: '2025-26', teamId: 1, athleteId: 100, name: 'Synthetic Player', games: 30, minutes: 700 }],
    };
    const f = mockFetch((url) => { const u = new URL(url); const p = u.pathname; const yr = +u.searchParams.get('season');
      if (p === '/teams') return { status: 200, body: fx['/teams'] };
      if (p === '/stats/player/season') return { status: 200, body: fx['/stats/player/season'] };
      if (p === '/games') return { status: 200, body: yr === S ? fx['/games'] : [] };
      if (p === '/teams/roster') return { status: 200, body: fx['/teams/roster'] };
      if (p === '/recruiting/portal' || p === '/recruiting/players') return { status: 200, body: [] };
      return { status: 404, body: null }; });
    const db = memdb();
    /* the previous season's player seasons and teams first (what moves needs) */
    const api0 = CB.client({ key: KEY, fetch: f, sleep: noSleep, maxCalls: 20 });
    const m0 = await ING.run({ api: api0, db, parts: ['teams', 'player_seasons'], seasons: [S - 1], mode: 'test', now: '2026-11-01T12:00:00Z', codeSha: 'x' });
    const api = CB.client({ key: KEY, fetch: f, sleep: noSleep, maxCalls: 20 });
    const m = await ING.run({ api, db, parts: ['teams', 'games', 'rosters', 'portal', 'recruits', 'coaches', 'availability', 'moves'], seasons: [S], mode: 'test', now: '2026-11-01T12:00:00Z', codeSha: 'x' });
    chk('ingest: every part ran, in order, with one run row each', m0.failed === 0 && m.failed === 0 && m.results.map((r) => r.part).join() === 'teams,games,rosters,portal,recruits,coaches,availability,moves', m.results.map((r) => r.part + ':' + r.status + (r.error ? ':' + r.error : '')));
    const ros = db.calls.filter((c) => c.name === 'ncaam_es_put_rosters');
    chk('ingest: a roster read before the first tip is stored LIVE, whole teams per call', ros.length === 1 && ros[0].args.p_rows.every((r) => r.pit === 'LIVE') && ros[0].args.p_rows.length === 2);
    const mv = db.calls.filter((c) => c.name === 'ncaam_es_put' && c.args.p_table === 'ncaam_es_player_moves');
    chk('ingest: moves derived from the cache (a returning player with last season\'s minutes)', mv.length === 1 && mv[0].args.p_rows.find((r) => r.player_id === 100).kind === 'RETURNING');
    chk('ingest: every run is finished', db.calls.filter((c) => c.name === 'ncaam_es_begin_run').length === db.calls.filter((c) => c.name === 'ncaam_es_finish_run').length);
    chk('ingest: the ESPN crosswalk is measured, not assumed', m.results[0].meta.crosswalk_espn && m.results[0].meta.crosswalk_espn.with_source_id === 2);
    const mj = JSON.stringify(m) + JSON.stringify(m0);
    chk('ingest: the run manifest carries no data row (no player name, no team name)', !/Synthetic/.test(mj));
    /* no key: refused, recorded, the run fails */
    const db2 = memdb();
    const m2 = await ING.run({ api: CB.client({ key: '', fetch: f }), db: db2, parts: ['games'], seasons: [S], mode: 'test', now: '2026-11-01T12:00:00Z', codeSha: 'x' });
    chk('ingest: without a key the part fails, is recorded FAILURE / error, and the run exits non-zero', m2.failed === 1 && db2.calls.some((c) => c.name === 'ncaam_es_alert' && c.args.p_severity === 'FAILURE' && c.args.p_code === 'REFUSED')
      && db2.calls.some((c) => c.name === 'ncaam_es_finish_run' && c.args.p_status === 'error'));
    /* dry run: nothing stored */
    const m3 = await ING.run({ api: CB.client({ key: KEY, fetch: f, sleep: noSleep }), db: null, parts: ['games'], seasons: [S], mode: 'test', now: '2026-11-01T12:00:00Z', codeSha: 'x' });
    chk('ingest: a dry run fetches and normalises, stores nothing, and says so', m3.dry_run === true && m3.failed === 0 && m3.results[0].stored === 0);
    chk('ingest: moves without its inputs is refused, never derived from nothing', (await ING.run({ api, db: null, parts: ['moves'], seasons: [2020], mode: 'test', now: '2026-11-01T12:00:00Z', codeSha: 'x' })).results[0].refused === true);
    chk('parseArgs: schedules, seasons and a bounded call cap', ING.parseArgs(['--parts', 'daily']).parts.join() === ING.DAILY.join() && ING.parseArgs(['--season', '2019-2021']).seasons.join() === '2019,2020,2021' && ING.parseArgs(['--max-calls', '9999']).maxCalls === 250);
    let threw = null; try { ING.parseArgs(['--parts', 'coaches_api']); } catch (e) { threw = e.message; }
    chk('parseArgs: an unknown part is refused', /unknown part/.test(threw || ''));
  } finally {
    C.PATHS.cache = realCache;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ═══ scope ═══════════════════════════════════════════════════════════════ */
  const dir = path.join(__dirname, '..');
  const files = cp.execSync('git ls-files ' + JSON.stringify(dir) + ' && git ls-files --others --exclude-standard ' + JSON.stringify(dir), { cwd: C.ROOT }).toString().split('\n').filter(Boolean);
  const code = files.filter((f) => /\.js$/.test(f) && !/tests\//.test(f)).map((f) => fs.readFileSync(path.join(C.ROOT, f), 'utf8')).join('\n');
  chk('scope: men\'s only (no wbb / ncaaw / wehoop source)', !/wbb|ncaaw|wehoop/i.test(code));
  chk('scope: no odds host and no odds gateway call', !/the-odds-api|functions\/v1\/(odds_gateway|capture|close)|kalshi\.com|novig/i.test(code));
  chk('scope: no raw CBBD data is committed (no .json.gz, no data/ payloads)', !files.some((f) => /\.json\.gz$|\/data\//.test(f)), files.filter((f) => /\.json\.gz$|\/data\//.test(f)));
  chk('scope: the word "lock" appears nowhere in the code', !/\block\b/i.test(code));
  const mig = path.join(C.ROOT, 'supabase', 'migrations', '20261101130000_ncaam_early.sql');
  chk('the migration mirror is a byte copy of supabase/ncaam_early.sql', fs.existsSync(mig) && fs.readFileSync(mig).equals(fs.readFileSync(path.join(C.ROOT, 'supabase', 'ncaam_early.sql'))));

  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NCAAM-EARLY data layer — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
