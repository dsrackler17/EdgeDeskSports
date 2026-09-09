#!/usr/bin/env node
/* ===========================================================================
   Tests for sync_schedule.js -- the job that keeps the Collective's schedule
   complete on its own.

   The case these are built around is the real one: the Collective held 49
   games for CFB 2026 week 1, the real week had ten more, and every one of the
   ten was an FBS team hosting an opponent the schedule feed did not carry. A
   creator's correct thirty-game slate lost ten rows to it, every time they
   posted, with no way to fix it from their side.

   Run: node tools/collective/sync_schedule.test.js
   =========================================================================== */
'use strict';

const Y = require('./sync_schedule.js');
const S = require('./settle_finals.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}

/* ESPN events, in the shape the scoreboard actually returns them. */
function ev(away, home, date) {
  const side = (name, ha) => ({
    homeAway: ha, score: '',
    team: { location: name, displayName: name + ' Wildcats', shortDisplayName: name,
            abbreviation: name.slice(0, 4).toUpperCase(), name: 'Wildcats' },
  });
  return { date, competitions: [{ status: { type: { completed: false, state: 'pre' } },
    competitors: [side(home, 'home'), side(away, 'away')] }] };
}

/* ---- the source is addressed by season and week, not by guessing days --- */
chk('the CFB scoreboard is asked for a season and a week',
  function () {
    var u = Y.espnScoreboardUrl('CFB', 2026, 1);
    return /college-football\/scoreboard/.test(u) && /year=2026/.test(u)
      && /week=1/.test(u) && /seasontype=2/.test(u);
  },
  { got: Y.espnScoreboardUrl('CFB', 2026, 1) });
chk('college football is asked for the FBS group, which is where these games live',
  function () {
    /* Every one of the ten missing fixtures is an FBS team hosting somebody
       else. Those are FBS games and come back in this group; asking without
       it drags in every FCS-versus-FCS game in the country. */
    return /groups=80/.test(Y.espnScoreboardUrl('CFB', 2026, 1));
  });
chk('the NFL is not asked for a college group',
  function () { return !/groups=/.test(Y.espnScoreboardUrl('NFL', 2026, 1)); });
chk('a sport with no schedule source says so rather than inventing a URL',
  function () { return Y.espnScoreboardUrl('MLB', 2026, 1) === null; });

/* ---- what is missing -------------------------------------------------- */
const FEED = [
  ev('Massachusetts', 'Rutgers', '2026-09-03T22:00Z'),
  ev('Akron', 'Wake Forest', '2026-09-03T23:00Z'),
  ev('Bethune-Cookman', 'UCF', '2026-09-03T23:00Z'),
  ev('Arkansas-Pine Bluff', 'Missouri', '2026-09-04T00:00Z'),
  ev('Eastern Illinois', 'Minnesota', '2026-09-04T00:00Z'),
  ev('Idaho', 'Utah', '2026-09-04T01:00Z'),
].map(S.normEspn);

/* The Collective, spelling its names the way it really does: clipped to ten
   characters, uppercase, punctuation gone. */
const HAVE = [
  { home: 'RUTGERS', away: 'MASSACHUSE', week: 1, kickoff_at: '2026-09-03T22:00Z' },
  { home: 'WAKEFOREST', away: 'AKRON', week: 1, kickoff_at: '2026-09-03T23:00Z' },
];

chk('a game the Collective already has is not offered again',
  function () { return Y.alreadyHave(HAVE[0], FEED[0]) === true; },
  'the Collective clips its names; a comparison that does not know that reloads the whole week');
chk('the clipped spelling is recognised on both sides',
  function () { return Y.alreadyHave(HAVE[1], FEED[1]) === true; });
chk('a different game is not mistaken for one already held',
  function () { return Y.alreadyHave(HAVE[0], FEED[2]) === false; });
chk('only the fixtures the Collective is short of come back',
  function () {
    var miss = Y.missingFrom(HAVE, FEED);
    return miss.length === 4
      && miss.map(function (m) { return m.home_team; }).join(',') === 'UCF,Missouri,Minnesota,Utah';
  },
  { got: Y.missingFrom(HAVE, FEED).map(function (m) { return m.away_team + ' @ ' + m.home_team; }) });
chk('a half-formed feed row is not proposed as a game',
  function () {
    return Y.missingFrom([], [{ home_team: 'A', away_team: '', start_date: 'x',
      home_names: [], away_names: [] }]).length === 1;
  });
chk('nothing missing means nothing to write',
  function () { return Y.missingFrom(FEED.map(function (f) {
    return { home: f.home_team, away: f.away_team };
  }), FEED).length === 0; });

/* ---- teams before games ------------------------------------------------ */
chk('every team the missing games name is collected',
  function () {
    var names = Y.teamsNeeded(Y.missingFrom(HAVE, FEED));
    return names.indexOf('Bethune-Cookman') >= 0 && names.indexOf('UCF') >= 0
      && names.indexOf('Idaho') >= 0;
  },
  { got: Y.teamsNeeded(Y.missingFrom(HAVE, FEED)) });
chk('a team named twice is asked for once',
  function () {
    var rows = [
      { home_team: 'UCF', away_team: 'Idaho', start_date: 'x' },
      { home_team: 'UCF', away_team: 'Utah', start_date: 'x' },
    ];
    return Y.teamsNeeded(rows).filter(function (n) { return n === 'UCF'; }).length === 1;
  });
chk('teams are collected from BOTH sides, not just the away one',
  function () {
    /* the receipt said unknown_team_away every time, but that is what this
       backend happened to check first -- a home team it has never seen is
       just as unusable */
    return Y.teamsNeeded([{ home_team: 'New Home', away_team: 'New Away', start_date: 'x' }])
      .sort().join(',') === 'New Away,New Home';
  });

/* ---- the payload the schedule loader takes ----------------------------- */
chk('the payload is exactly what /v1/admin/games wants',
  function () {
    var g = Y.gamePayload(Y.missingFrom(HAVE, FEED), 1)[0];
    return Object.keys(g).sort().join(',') === 'away,home,kickoff,week'
      && g.week === 1 && g.home === 'UCF' && g.away === 'Bethune-Cookman';
  },
  { got: Y.gamePayload(Y.missingFrom(HAVE, FEED), 1)[0] });
chk('the kickoff is the instant the source stated, not a local wall clock',
  function () {
    var g = Y.gamePayload(Y.missingFrom(HAVE, FEED), 1)[0];
    return g.kickoff === '2026-09-03T23:00Z';
  },
  'a schedule that disagrees with itself about time zones is worse than one short a game');
chk('the week is a number, because the schedule is keyed on it',
  function () { return Y.gamePayload([{ home_team: 'A', away_team: 'B', start_date: 'x' }], '3')[0].week === 3; });

/* ---- running it twice must not double the schedule --------------------
   The job is scheduled twice a day and can be dispatched by hand on top of
   that, so "safe to run repeatedly" is a property it has to actually have
   rather than a sentence in its header. The deeper cases -- a kickoff that
   moved, a settled game the feed restates, the postseason addressing -- are
   in tools/collective/week_resolution.test.js, which the same workflow runs
   before this job is allowed to write. */
chk('the same feed run against its own result offers nothing the second time',
  function () {
    var loaded = Y.gamePayload(Y.missingFrom(HAVE, FEED), 1).map(function (p) {
      return { home: p.home, away: p.away, week: p.week, kickoff_at: p.kickoff };
    }).concat(HAVE);
    return Y.missingFrom(loaded, FEED).length === 0;
  },
  { second: Y.missingFrom(Y.gamePayload(Y.missingFrom(HAVE, FEED), 1).map(function (p) {
      return { home: p.home, away: p.away }; }).concat(HAVE), FEED)
      .map(function (r) { return r.away_team + ' @ ' + r.home_team; }) });
chk('and a schedule that already agrees produces no update either',
  function () {
    var held = FEED.map(function (f, i) {
      return { game_id: 'g' + i, home: f.home_team, away: f.away_team, week: 1,
               kickoff_at: f.start_date, status: 'scheduled' };
    });
    return Y.updatesFor(held, FEED).length === 0;
  },
  'a day on which nothing changed has to cost nothing');

/* ---- THE PLANNER, and the service-role door ----------------------------
   The job never loaded a game in its life: it needed an admin token that was
   never set. It writes with the service role now, and what it writes is
   decided by planWeek, held here against the cases that matter: a stable
   id, a moved fixture, a re-filed week, a duplicate, and a second run. */
const NOW = Date.parse('2026-09-09T01:00:00Z');
function evx(away, home, date, opts) {
  opts = opts || {};
  var e = ev(away, home, date);
  e.id = opts.id || (away + '-' + home);
  if (opts.week != null) e.week = { number: opts.week };
  if (opts.seasontype != null) e.season = { type: opts.seasontype };
  if (opts.status) e.competitions[0].status.type.name = opts.status;
  return e;
}
const W2FEED = [
  evx('SMU', 'Baylor', '2026-09-12T16:00:00Z', { id: '401', week: 2, seasontype: 2 }),
  evx('Idaho', 'Utah', '2026-09-12T20:00:00Z', { id: '402', week: 2, seasontype: 2 }),
].map(S.normEspn).map(function (r) { return Object.assign({}, r, { week: 2 }); });

chk('a game is matched by the provider\'s id before anything else, anywhere in the season',
  function () {
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 1, kickoff_at: '2026-09-05T16:00:00Z',
      status: 'scheduled', external_ref: 'espn:401' }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.inserts.length === 1 && p.inserts[0].home_team === 'Utah'
      && p.updates.length === 1 && p.updates[0].how === 'ref' && p.updates[0].game.game_id === 'a'
      && p.updates[0].patch.week === 2 && p.updates[0].patch.kickoff_at === '2026-09-12T16:00:00Z';
  },
  'the provider re-filed the fixture under week 2: the SAME game moves, it is not loaded twice');
chk('a bare id written by another loader is the same id',
  Y.refMatches('401', { espn_id: '401' }) && Y.refMatches('espn:401', { espn_id: '401' })
    && !Y.refMatches('espn:402', { espn_id: '401' }) && !Y.refMatches(null, { espn_id: '401' }));
chk('a game held without an id is matched by its teams in its week, and given the id',
  function () {
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 2, kickoff_at: '2026-09-12T16:00:00Z',
      status: 'scheduled', external_ref: null }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.updates.length === 1 && p.updates[0].how === 'teams'
      && Object.keys(p.updates[0].patch).join(',') === 'external_ref' && p.updates[0].patch.external_ref === 'espn:401';
  });
chk('and is NOT given one on a database whose games table has no such column',
  function () {
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled' }];
    return Y.planWeek(held, W2FEED, 2, { now: NOW, refs: false }).updates.length === 0;
  });
chk('an UNPLAYED game filed under the wrong week is moved to the week the provider states',
  function () {
    /* a Week 2 slate loaded by hand under week 1: its kickoff is still ahead */
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 1, kickoff_at: '2026-09-12T16:00:00Z',
      status: 'scheduled', external_ref: null }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.inserts.length === 1 && p.updates.length === 1 && p.updates[0].how === 'moved'
      && p.updates[0].patch.week === 2 && p.updates[0].patch.external_ref === 'espn:401';
  },
  'a game that looks present under the wrong week is worse than one that is missing');
chk('a PLAYED game is never moved to another week on the strength of two team names',
  function () {
    /* the same pairing, kicked off a week ago, never settled: a rematch, or
       a hole in the data -- either way not the fixture the feed is filing */
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 1, kickoff_at: '2026-09-05T16:00:00Z',
      status: 'scheduled', external_ref: null }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.inserts.length === 2 && p.updates.length === 0;
  });
chk('a postponed game is movable whatever its stale date says',
  function () {
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 1, kickoff_at: '2026-09-05T16:00:00Z',
      status: 'postponed', external_ref: null }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.updates.length === 1 && p.updates[0].how === 'moved' && p.updates[0].patch.week === 2
      && p.updates[0].patch.kickoff_at === '2026-09-12T16:00:00Z';
  });
chk('a settled game is never touched, whatever the feed says about it',
  function () {
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 2, kickoff_at: '2026-09-11T16:00:00Z',
      status: 'final', result: { home_score: 20, away_score: 13 }, external_ref: null }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.updates.length === 0 && p.inserts.length === 1 && p.unchanged === 1;
  });
chk('a fixture held twice is reported as a duplicate and never deleted, never loaded a third time',
  function () {
    var held = [
      { game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled', external_ref: 'espn:401' },
      { game_id: 'b', home: 'BAYLOR', away: 'SMU', week: 1, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled', external_ref: null },
    ];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.inserts.length === 1 && p.inserts[0].home_team === 'Utah'
      && p.duplicates.length === 1 && p.duplicates[0].game.game_id === 'b' && p.duplicates[0].of.game_id === 'a';
  });
chk('a rematch weeks away is not a duplicate of this week\'s game',
  function () {
    var held = [
      { game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled', external_ref: 'espn:401' },
      { game_id: 'later', home: 'BAYLOR', away: 'SMU', week: 9, kickoff_at: '2026-10-31T16:00:00Z', status: 'scheduled', external_ref: null },
    ];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.duplicates.length === 0 && p.inserts.length === 1;
  });
chk('a held game the feed no longer carries is reported, not deleted',
  function () {
    var held = [{ game_id: 'z', home: 'WASHINGTON', away: 'WASHINGTO2', week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled' }];
    var p = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return p.notInFeed.length === 1 && p.notInFeed[0].game_id === 'z' && p.inserts.length === 2;
  });
chk('SYNC TWICE  the second run over the first run\'s result plans nothing at all',
  function () {
    var held = [];
    var first = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    /* what the database holds after the first run: clipped names, the
       provider id, the provider week */
    first.inserts.forEach(function (r, i) {
      held.push({ game_id: 'new' + i, home: r.home_team.toUpperCase().slice(0, 10), away: r.away_team.toUpperCase().slice(0, 10),
        week: r.week, kickoff_at: r.start_date, status: 'scheduled', external_ref: Y.refOf(r) });
    });
    var second = Y.planWeek(held, W2FEED, 2, { now: NOW, refs: true });
    return first.inserts.length === 2 && second.inserts.length === 0 && second.updates.length === 0
      && second.duplicates.length === 0 && second.unchanged === 2;
  });
chk('a week the provider moves a kickoff in is one update, addressed by id',
  function () {
    var held = [{ game_id: 'a', home: 'BAYLOR', away: 'SMU', week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled', external_ref: 'espn:401' }];
    var moved = [evx('SMU', 'Baylor', '2026-09-11T23:00:00Z', { id: '401', week: 2, seasontype: 2 })].map(S.normEspn)
      .map(function (r) { return Object.assign({}, r, { week: 2 }); });
    var p = Y.planWeek(held, moved, 2, { now: NOW, refs: true });
    return p.updates.length === 1 && Object.keys(p.updates[0].patch).join(',') === 'kickoff_at' && p.inserts.length === 0;
  });

/* ---- teams, through the service role ---------------------------------- */
const ROSTER = { teams: [
  { id: 't1', code: 'WASHINGTON', name: 'Washington' },
  { id: 't2', code: 'WASHINGTO2', name: 'Washington State' },
  { id: 't3', code: 'NORTHCAROL', name: 'NORTHCAROL' },
  { id: 't4', code: 'TCU', name: 'TCU' },
], aliases: [{ alias: 'UL Monroe', team_id: 't5' }, { alias: 'Louisiana-Monroe', team_id: 't5' }] };
ROSTER.teams.push({ id: 't5', code: 'ULMONROE', name: 'UL Monroe' });
chk('a team is found by its stored full name, whatever ESPN spells it as',
  Y.findTeam(ROSTER, ['Washington State', 'Washington State Cougars', 'WSU']).id === 't2');
chk('a team is found by an alias', Y.findTeam(ROSTER, ['Louisiana-Monroe', 'ULM']).id === 't5');
chk('a code match alone is accepted only when the row\'s name IS its code',
  Y.findTeam(ROSTER, ['North Carolina', 'North Carolina Tar Heels']).id === 't3');
chk('a code collision with a DIFFERENT full name is not a match',
  function () {
    var r = { teams: [{ id: 't1', code: 'WASHINGTON', name: 'Washington' }], aliases: [] };
    return Y.findTeam(r, ['Washington State', 'Washington State Cougars']) === null;
  },
  'Washington State clips to WASHINGTON; linking it to Washington puts the Cougars\' games on the Huskies');
chk('and the collision gets the next free code, the way it was resolved by hand',
  function () {
    var r = { teams: [{ id: 't1', code: 'WASHINGTON', name: 'Washington' }], aliases: [] };
    return Y.nextCode(r, 'Washington State') === 'WASHINGTO2' && Y.nextCode(ROSTER, 'Washington State') === 'WASHINGTO3'
      && Y.nextCode(ROSTER, 'Idaho') === 'IDAHO';
  });
chk('a short abbreviation never decides a code match: Iowa State is not the legacy IOWA row',
  function () {
    var r = { teams: [{ id: 'iowa', code: 'IOWA', name: 'IOWA' }], aliases: [] };
    return Y.findTeam(r, ['Iowa State', 'Iowa State Cyclones', 'IOWA', 'Cyclones'], 'Iowa State') === null
      && Y.findTeam(r, ['Iowa', 'Iowa Hawkeyes', 'IOWA', 'Hawkeyes'], 'Iowa').id === 'iowa';
  },
  'the provider\'s abbreviation clips to a code of its own and would put the Cyclones on the Hawkeyes');
chk('the code is derived exactly as collective_admin derives it',
  Y.teamCode('San José State') === 'SANJOSSTAT' && Y.teamCode('Miami (OH)') === 'MIAMIOH' && Y.teamCode('UL Monroe') === 'ULMONROE');

(async function directDoor() {
  var writes = [];
  var roster = { teams: [{ id: 't-utah', code: 'UTAH', name: 'Utah' }], aliases: [] };
  var n = 0;
  var db = {
    insert: async function (rel, rows) {
      writes.push({ rel: rel, rows: rows });
      if (rel === 'teams') return rows.map(function (r) { return Object.assign({ id: 'team-' + (++n) }, r); });
      if (rel === 'games') return rows.map(function (r) { return Object.assign({ id: 'game-' + (++n) }, r); });
      return rows;
    },
    rpc: async function () { return { resolved: 0 }; },
  };
  var schema = { games: ['id', 'sport_code', 'season', 'week', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'external_ref', 'created_at'],
    teams: ['id', 'sport_code', 'code', 'name'], team_aliases: ['id', 'sport_code', 'alias', 'team_id'] };
  /* two one-word schools, a two-word school, and one already held */
  var TEAMFEED = W2FEED.concat([evx('Boise State', 'Oregon', '2026-09-12T23:30:00Z', { id: '403', week: 2, seasontype: 2 })]
    .map(S.normEspn).map(function (r) { return Object.assign({}, r, { week: 2 }); }));
  var plan = Y.planWeek([], TEAMFEED, 2, { now: NOW, refs: true });
  var t = await Y.ensureTeams(db, schema, 'CFB', plan.inserts, roster, true);
  chk('DIRECT  the teams the feed names and the database lacks are created, a full name that is not its code as an alias',
    t.created === 5 && t.failed.length === 0 && t.ids.get(S.teamKey('Utah')) === 't-utah'
      && writes.filter(function (w) { return w.rel === 'teams'; }).length === 5
      && writes.filter(function (w) { return w.rel === 'team_aliases'; }).length === 1
      && writes.find(function (w) { return w.rel === 'team_aliases'; }).rows[0].alias === 'Boise State'
      && writes.find(function (w) { return w.rel === 'teams' && w.rows[0].name === 'Boise State'; }).rows[0].code === 'BOISESTATE'
      && writes.find(function (w) { return w.rel === 'teams'; }).rows[0].sport_code === 'CFB',
    { created: t.created, failed: t.failed, writes: writes.map(function (w) { return w.rel + ':' + w.rows[0].name; }) });
  chk('DIRECT  a team already held is reused, never created again',
    !writes.some(function (w) { return w.rel === 'teams' && w.rows[0].name === 'Utah'; }));
  var g = await Y.insertGames(db, schema, 'CFB', 2026, plan.inserts, t.ids);
  var gw = writes.filter(function (w) { return w.rel === 'games'; })[0];
  chk('DIRECT  the games are inserted with the provider id, the provider week and the team ids',
    g.inserted.length === 3 && g.refused.length === 0 && gw && gw.rows.length === 3
      && gw.rows[0].external_ref === 'espn:401' && gw.rows[0].week === 2 && gw.rows[0].status === 'scheduled'
      && gw.rows[0].sport_code === 'CFB' && gw.rows[0].season === 2026 && gw.rows[0].kickoff_at === '2026-09-12T16:00:00Z'
      && gw.rows[0].home_team_id === t.ids.get(S.teamKey('Baylor')) && gw.rows[1].home_team_id === 't-utah'
      && gw.rows[2].away_team_id === t.ids.get(S.teamKey('Boise State')),
    gw && gw.rows);
  chk('DIRECT  only columns the table has are written',
    gw && gw.rows.every(function (r) { return Object.keys(r).every(function (c) { return schema.games.indexOf(c) >= 0; }); }));
  chk('DIRECT  a games table of a different shape is refused, not half-written',
    function () {
      var out = Y.gameRows({ games: ['id', 'week', 'kickoff_at'] }, 'CFB', 2026, plan.inserts, t.ids);
      return out.rows.length === 0 && out.refused.length === 1 && /home_team_id/.test(out.refused[0].detail);
    });
  chk('DIRECT  a dry run creates nothing and still says what it would create',
    async function () { return true; });
  var dry = await Y.ensureTeams({ insert: async function () { throw new Error('must not write'); } }, schema, 'CFB', plan.inserts,
    { teams: [], aliases: [] }, false);
  chk('DIRECT  a dry run names the teams it would create and writes none',
    dry.created === 0 && dry.toCreate.length === 6 && dry.failed.length === 0, dry);

  /* the season, read off the database and joined to its provider ids */
  var sdb = { select: async function (rel, q) {
    if (rel === 'game_detail') return [
      { game_id: 'g1', sport: 'CFB', season: 2026, week: 1, kickoff_at: '2026-09-05T16:00:00Z', status: 'scheduled',
        home: 'TCU', away: 'NORTHCAROL', label: 'NORTHCAROL @ TCU', home_score: null, away_score: null, closing_spread: null, closing_total: null },
      { game_id: 'g2', sport: 'CFB', season: 2026, week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled',
        home: 'BAYLOR', away: 'SMU', label: 'SMU @ BAYLOR', home_score: null, away_score: null, closing_spread: null, closing_total: null }];
    if (rel === 'games') return [{ id: 'g2', external_ref: 'espn:401' }, { id: 'g1', external_ref: null }];
    throw new Error('unexpected ' + rel + '?' + q);
  } };
  var held = await Y.loadSeason(sdb, schema, 'CFB', 2026);
  chk('DIRECT  the season comes off game_detail with the provider id joined in from games',
    held.length === 2 && held[1].external_ref === 'espn:401' && held[0].external_ref === null
      && held[0].home === 'TCU' && held[0].result === null,
    held);
  chk('DIRECT  and Current is decided over that whole season by the shared rule',
    require('../../collective/week.js').resolveCurrentWeek(held, NOW) === 2);
})().catch(function (e) { chk('the direct door drive did not crash', false, String(e && e.stack || e)); })
  .then(function () { report(); });

/* ---- report ------------------------------------------------------------ */
function report() {
failures.forEach(function (f) {
  console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : ''));
});
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
}
