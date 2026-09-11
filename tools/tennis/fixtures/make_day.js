#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — SYNTHETIC provider documents for the test suite.

   Everything produced here is invented for tests: the tournaments, the courts,
   the players, the numbers. Nothing from it is ever written to production, and
   the names are chosen so they cannot be mistaken for real players. The shapes
   follow ESPN's public site API for tennis — events carrying either
   `competitions[]` directly or `groupings[].competitions[]`, competitors with
   linescores, and statistics in the categories/stats form — which is what
   tools/tennis/espn.js parses.

     node tools/tennis/fixtures/make_day.js     # writes scoreboard_sample.json
   =========================================================================== */
'use strict';

function statList(s) {
  const stat = (name, value, display) => ({ name, displayName: name, abbreviation: name.slice(0, 4).toUpperCase(),
    value, displayValue: display != null ? display : String(value) });
  const out = [];
  if (s.aces != null) out.push(stat('aces', s.aces));
  if (s.df != null) out.push(stat('doubleFaults', s.df));
  if (s.firstIn != null && s.firstTotal != null) {
    out.push(stat('firstServesIn', s.firstIn));
    out.push(stat('firstServesTotal', s.firstTotal));
    out.push(stat('firstServePercentage', Math.round(100 * s.firstIn / s.firstTotal)));
  }
  if (s.firstWon != null && s.firstPts != null) out.push(stat('firstServePoints', s.firstWon, s.firstWon + '/' + s.firstPts));
  if (s.secondWon != null && s.secondPts != null) out.push(stat('secondServePoints', s.secondWon, s.secondWon + '/' + s.secondPts));
  if (s.svcGames != null) out.push(stat('serviceGamesPlayed', s.svcGames));
  if (s.holds != null) out.push(stat('serviceGamesWon', s.holds));
  if (s.svcPtsWon != null && s.svcPts != null) out.push(stat('servicePoints', s.svcPtsWon, s.svcPtsWon + '/' + s.svcPts));
  if (s.bpFaced != null) out.push(stat('breakPointsFaced', s.bpFaced));
  if (s.bpSaved != null) out.push(stat('breakPointsSaved', s.bpSaved));
  if (s.bpWon != null && s.bpTotal != null) out.push(stat('breakPoints', s.bpWon, s.bpWon + '/' + s.bpTotal));
  if (s.rtnPtsWon != null && s.rtnPts != null) out.push(stat('returnPoints', s.rtnPtsWon, s.rtnPtsWon + '/' + s.rtnPts));
  if (s.totalPts != null) out.push(stat('totalPointsWon', s.totalPts));
  if (s.winners != null) out.push(stat('winners', s.winners));
  if (s.ue != null) out.push(stat('unforcedErrors', s.ue));
  if (s.tbWon != null) out.push(stat('tiebreaksWon', s.tbWon));
  if (s.tbPlayed != null) out.push(stat('tiebreaksPlayed', s.tbPlayed));
  return out;
}

/* stats: {...totals, sets: {1: {...}, 2: {...}}} */
function statsDoc(s) {
  if (!s) return null;
  const doc = { categories: [{ name: 'serving', stats: statList(s) }] };
  if (s.sets) {
    doc.splits = Object.keys(s.sets).map(n => ({ name: 'Set ' + n, period: Number(n), stats: statList(s.sets[n]) }));
  }
  return doc;
}

function competitor(order, side) {
  const c = { id: side.id, order, winner: !!side.winner, possession: !!side.serving,
    linescores: (side.sets || []).map(v => (typeof v === 'object' ? { value: v.games, tiebreak: v.tb } : { value: v })) };
  if (side.pair) {
    c.roster = side.pair.map(p => ({ athlete: { id: p.id, displayName: p.name, fullName: p.name } }));
  } else {
    c.athlete = { id: side.id, displayName: side.name, fullName: side.name, shortName: String(side.name).split(' ').slice(-1)[0] };
  }
  if (side.seed != null) c.seed = side.seed;
  if (side.rank != null) c.rank = side.rank;
  const st = statsDoc(side.stats);
  if (st) c.statistics = st;
  return c;
}

function status(kind, o) {
  o = o || {};
  const map = {
    pre: { state: 'pre', name: 'STATUS_SCHEDULED', description: 'Scheduled', detail: 'Scheduled' },
    live: { state: 'in', name: 'STATUS_IN_PROGRESS', description: 'In Progress', detail: 'Set ' + (o.set || 1) },
    final: { state: 'post', name: 'STATUS_FINAL', description: 'Final', detail: 'Final' },
    retired: { state: 'post', name: 'STATUS_RETIRED', description: 'Retired', detail: 'Retired' },
    walkover: { state: 'post', name: 'STATUS_WALKOVER', description: 'Walkover', detail: 'Walkover' },
    cancelled: { state: 'post', name: 'STATUS_CANCELED', description: 'Canceled', detail: 'Canceled' },
    postponed: { state: 'pre', name: 'STATUS_POSTPONED', description: 'Postponed', detail: 'Postponed' }
  };
  const t = map[kind] || map.pre;
  return { period: o.set != null ? o.set : (kind === 'pre' ? 0 : 1),
    type: { id: '1', name: t.name, state: t.state, completed: t.state === 'post', description: t.description, detail: t.detail, shortDetail: t.detail } };
}

/* One match. m: {id, home, away, round, status, set, bestOf, court, date, grouping} */
function match(m, tournamentDate, idx) {
  const c = { id: m.id, date: m.date || tournamentDate,
    competitors: [competitor(1, m.home), competitor(2, m.away)],
    status: status(m.status || 'pre', m) };
  if (m.round) c.notes = [{ type: 'event', headline: m.round }];
  if (m.bestOf) c.format = { sets: { count: m.bestOf } };
  if (m.court) c.venue = { fullName: m.court };
  c.matchNumber = idx + 1;
  return c;
}

/* One tournament. t: {id, name, shortName, surface, city, country, start, end,
   matches: [...], groupings: {label: [...matches]}} */
function tournament(t) {
  const date = t.start || '2026-05-28T09:00Z';
  const ev = { id: t.id, uid: 's:850~l:1~e:' + t.id, date,
    name: t.name || 'Test Open', shortName: t.shortName || 'TEST',
    endDate: t.end || null, drawSize: t.drawSize || null,
    surface: t.surface || null,
    venue: { fullName: t.venue || 'Centre Court', address: { city: t.city || 'Testville', country: t.country || 'TST' } },
    season: { startDate: t.start || null, endDate: t.end || null, slug: t.level || null } };
  if (t.matches) ev.competitions = t.matches.map((m, i) => match(m, date, i));
  if (t.groupings) {
    ev.groupings = Object.keys(t.groupings).map(label => ({
      grouping: { name: label, shortName: label, slug: label.toLowerCase().replace(/\s+/g, '-') },
      competitions: t.groupings[label].map((m, i) => match(m, date, i))
    }));
  }
  return ev;
}

/* A whole tour-day scoreboard. */
function day(o) {
  return { leagues: [{ id: '1', name: String(o.tour || 'atp').toUpperCase(), abbreviation: String(o.tour || 'atp').toUpperCase() }],
    day: o.day ? [{ date: o.day }] : undefined,
    events: (o.tournaments || []).map(tournament) };
}

module.exports = { day, tournament, match, competitor, status, statsDoc, statList };

if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const sample = day({ tour: 'atp', day: '2026-05-28', tournaments: [{
    id: '7000001', name: 'Testville Open', shortName: 'TESTVILLE', surface: 'clay', city: 'Testville', country: 'TST',
    start: '2026-05-25T09:00Z', end: '2026-06-07T09:00Z', drawSize: 128, level: 'grand-slam',
    groupings: {
      "Men's Singles": [
        { id: '8000001', round: 'Round of 32', bestOf: 5, court: 'Court Placeholder', status: 'live', set: 3,
          home: { id: '9000001', name: 'Marco Testerson', seed: '4', rank: 5, serving: true, sets: [6, 3, { games: 2 }],
            stats: { aces: 7, df: 2, firstIn: 44, firstTotal: 71, firstWon: 31, firstPts: 44, secondWon: 14, secondPts: 27,
              svcGames: 12, holds: 10, svcPtsWon: 45, svcPts: 71, bpFaced: 4, bpSaved: 3, bpWon: 3, bpTotal: 8,
              rtnPtsWon: 26, rtnPts: 66, totalPts: 71, winners: 22, ue: 15,
              sets: { 1: { aces: 3, df: 1, svcGames: 5, holds: 5 }, 2: { aces: 2, df: 1, svcGames: 4, holds: 3 } } } },
          away: { id: '9000002', name: 'Ivan Placeholder', seed: '12', rank: 14, sets: [4, 6, { games: 1 }],
            stats: { aces: 3, df: 5, firstIn: 38, firstTotal: 66, firstWon: 24, firstPts: 38, secondWon: 11, secondPts: 28,
              svcGames: 11, holds: 8, svcPtsWon: 35, svcPts: 66, bpFaced: 8, bpSaved: 5, bpWon: 2, bpTotal: 4,
              rtnPtsWon: 26, rtnPts: 71, totalPts: 61, winners: 18, ue: 24 } } },
        { id: '8000002', round: 'Round of 32', bestOf: 5, court: 'Court Two', status: 'pre',
          home: { id: '9000003', name: 'Jiří Mockovský', seed: '9', sets: [] },
          away: { id: '9000004', name: 'Alex Sample', sets: [] } },
        { id: '8000003', round: 'Round of 32', bestOf: 5, status: 'final',
          home: { id: '9000005', name: 'Bruno Fixture', winner: true, sets: [{ games: 7, tb: 7 }, 6, 6] },
          away: { id: '9000006', name: 'Kai Dummy', sets: [{ games: 6, tb: 4 }, 4, 3] } }
      ],
      "Men's Doubles": [
        { id: '8000004', round: 'Round of 16', bestOf: 3, status: 'pre',
          home: { id: '9100001', pair: [{ id: '9000007', name: 'Rohan Testpair' }, { id: '9000008', name: 'Matt Fixtureman' }], sets: [] },
          away: { id: '9100002', pair: [{ id: '9000009', name: 'Marcel Sampleton' }, { id: '9000010', name: 'Horacio Placeholder' }], sets: [] } }
      ]
    }
  }] });
  fs.writeFileSync(path.join(__dirname, 'scoreboard_sample.json'), JSON.stringify(sample, null, 1));
  console.log('wrote scoreboard_sample.json');
}
