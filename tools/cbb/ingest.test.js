#!/usr/bin/env node
/* ===========================================================================
   THE SHAPING AND THE UNION, against the payloads the source really sends.

   The fixtures below are cut from what a runner actually returned on
   2026-04-15 and 2026-04-18, because the machine this runs on cannot reach
   the source at all — every live sports host is refused by its egress policy.
   So the shaping is pure, the network lives elsewhere, and this holds the
   part that decides whether a board row is right.

   What it is really guarding: the union. Neither source is complete on its
   own, and the merge is where "all the games" is either honoured or quietly
   broken.

   Run: node tools/cbb/ingest.test.js
   =========================================================================== */
'use strict';
const I = require('./ingest.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
};
const eq = (name, got, want) => ok(name, got === want, { got, want });

/* ---- fixtures, in the source's own shape ---------------------------------- */
const scoreboardEvent = {
  id: '401849995', date: '2026-04-15T22:00Z',
  status: { type: { state: 'post', completed: true, description: 'Final' }, period: 9 },
  competitions: [{
    neutralSite: false, conferenceCompetition: false,
    venue: { fullName: 'Meritus Park', address: { city: 'Hagerstown', state: 'MD' } },
    competitors: [
      { homeAway: 'home', score: '7', curatedRank: { current: 15 },
        team: { id: '277', displayName: 'West Virginia Mountaineers', abbreviation: 'WVU' } },
      { homeAway: 'away', score: '3', curatedRank: { current: 99 },
        team: { id: '213', displayName: 'Penn State Nittany Lions', abbreviation: 'PSU' } },
    ],
  }],
};
/* the schedule payload nests score as an object and carries the venue but no
   live state — the exact split the merge exists to reconcile */
const scheduleEvent = {
  id: '401849995', date: '2026-04-15T22:00Z',
  competitions: [{
    venue: { fullName: 'Meritus Park', address: { city: 'Hagerstown', state: 'MD' } },
    competitors: [
      { homeAway: 'home', score: { value: 7 }, team: { id: '277', displayName: 'West Virginia Mountaineers' } },
      { homeAway: 'away', score: { value: 3 }, team: { id: '213', displayName: 'Penn State Nittany Lions' } },
    ],
  }],
  status: { type: { state: 'post', completed: true } },
};
const walkOnly = {
  id: '401847782', date: '2026-04-18T20:00Z',
  status: { type: { state: 'post', completed: true, description: 'Final' } },
  competitions: [{
    neutralSite: false, conferenceCompetition: true,
    venue: { fullName: 'Evans Diamond' },
    competitors: [
      { homeAway: 'home', score: { value: 5 }, team: { id: '25', displayName: 'California Golden Bears' } },
      { homeAway: 'away', score: { value: 4 }, team: { id: '97', displayName: 'Louisville Cardinals' } },
    ],
  }],
};

console.log('college baseball ingest — shaping');
{
  const g = I.shapeEvent(scoreboardEvent, 'scoreboard');
  eq('the game id is the source id', g.game_id, '401849995');
  eq('the season is the year of the date', g.season, 2026);
  eq('the date is a plain day', g.game_date, '2026-04-15');
  eq('home and away are not confused', g.home_name, 'West Virginia Mountaineers');
  eq('…nor the other way round', g.away_name, 'Penn State Nittany Lions');
  eq('a string score becomes a number', g.home_score, 7);
  eq('…on both sides', g.away_score, 3);
  eq('a real rank survives', g.home_rank, 15);
  /* 99 IS HOW THE SOURCE SPELLS UNRANKED. Printed on a board it would read as
     a team ranked 99th in a sport with about three hundred teams. */
  eq('rank 99 means unranked, not ranked 99th', g.away_rank, null);
  eq('the venue comes through', g.venue, 'Meritus Park');
  eq('…with its city', g.venue_city, 'Hagerstown');
  eq('a finished game is marked finished', g.completed, true);
  eq('the source that saw it is recorded', g.seen_by.join(), 'scoreboard');
}
{
  const g = I.shapeEvent(scheduleEvent, 'team_schedule');
  eq('an object score is read too', g.home_score, 7);
  eq('…and its away side', g.away_score, 3);
}
console.log('college baseball ingest — the union');
{
  const a = I.shapeEvent(scoreboardEvent, 'scoreboard');
  const b = I.shapeEvent(scheduleEvent, 'team_schedule');
  const c = I.shapeEvent(walkOnly, 'team_schedule');
  const u = I.unionGames([[a], [b, c]]);
  eq('a game both sources saw appears once', u.length, 2);
  const merged = u.find((x) => x.game_id === '401849995');
  eq('…and records both sources', merged.seen_by.join(','), 'scoreboard,team_schedule');
  eq('…keeping the detail only one of them had', merged.status_detail, 'Final');
  const only = u.find((x) => x.game_id === '401847782');
  ok('a game only the walk saw is still on the card', !!only);
  eq('…and says so', only.seen_by.join(), 'team_schedule');
  eq('the union is ordered by date', u[0].game_date, '2026-04-15');
}
{
  /* THE CASE THAT MATTERS MOST: the scoreboard has the live score, the
     schedule row is stale. Taking either row whole would lose something. */
  const live = I.shapeEvent({
    id: '9', date: '2026-04-18T20:00Z',
    status: { type: { state: 'in', description: 'Top 7th' }, period: 7 },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '4', team: { id: '1', displayName: 'Home' } },
      { homeAway: 'away', score: '2', team: { id: '2', displayName: 'Away' } }] }],
  }, 'scoreboard');
  const stale = I.shapeEvent({
    id: '9', date: '2026-04-18T20:00Z',
    status: { type: { state: 'pre' } },
    competitions: [{ venue: { fullName: 'Someone Field' }, competitors: [
      { homeAway: 'home', team: { id: '1', displayName: 'Home' } },
      { homeAway: 'away', team: { id: '2', displayName: 'Away' } }] }],
  }, 'team_schedule');
  const m = I.unionGames([[live], [stale]])[0];
  eq('the live score is kept', m.home_score, 4);
  eq('the venue only the schedule had is kept', m.venue, 'Someone Field');
  eq('the live state is kept', m.status_state, 'in');
}
{
  /* a row that cannot name both sides is not a row */
  ok('an event with one competitor is refused', I.shapeEvent({
    id: '5', date: '2026-04-18T20:00Z',
    competitions: [{ competitors: [{ homeAway: 'home', team: { id: '1', displayName: 'Only' } }] }] },
    'scoreboard') === null);
  ok('an event with no date is refused',
    I.shapeEvent({ id: '6', competitions: [{ competitors: [] }] }, 'scoreboard') === null);
}
{
  /* a start time the source has not settled must not be printed as midnight */
  const g = I.shapeEvent({ id: '7', date: '2026-04-18T00:00Z',
    status: { type: { state: 'pre' } },
    competitions: [{ competitors: [
      { homeAway: 'home', team: { id: '1', displayName: 'H' } },
      { homeAway: 'away', team: { id: '2', displayName: 'A' } }] }] }, 'scoreboard');
  eq('an unset start time is flagged, not invented', g.start_time_tbd, true);
  eq('…and no time is carried', g.start_time, null);
}

console.log(fail === 0 ? `ALL GREEN ${pass} passed, 0 failed` : `FAILED ${pass} passed, ${fail} failed`);
if (fail === 0) console.log(`PASS | cbb ingest shaping and union | ${pass} assertions`);
process.exit(fail === 0 ? 0 : 1);
