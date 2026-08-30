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

/* ---- report ------------------------------------------------------------ */
failures.forEach(function (f) {
  console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : ''));
});
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
