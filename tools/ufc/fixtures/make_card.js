#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — SYNTHETIC provider documents for the test suite.

   Everything produced here is invented for tests: the event, the venue, the
   fighters, the numbers. Nothing from it is ever written to production, and
   the names are chosen so they cannot be mistaken for real athletes. The
   shapes follow ESPN's public site API (events / competitions / competitors /
   status) and core API (statistics splits with categories and stats), which
   is what tools/ufc/espn.js parses.
   =========================================================================== */
'use strict';

function competitor(order, athlete, o) {
  o = o || {};
  return { id: athlete.id, uid: 's:3301~a:' + athlete.id, type: 'athlete', order, winner: !!o.winner,
    athlete: { id: athlete.id, fullName: athlete.name, displayName: athlete.name, shortName: athlete.name.split(' ').slice(-1)[0] },
    records: [{ summary: athlete.record || '10-2-0' }], statistics: o.stats || undefined };
}

function status(kind, o) {
  o = o || {};
  const map = {
    pre: { state: 'pre', name: 'STATUS_SCHEDULED', description: 'Scheduled', detail: 'Scheduled' },
    live: { state: 'in', name: 'STATUS_IN_PROGRESS', description: 'In Progress', detail: 'Round ' + (o.round || 1) },
    final: { state: 'post', name: 'STATUS_FINAL', description: 'Final', detail: 'Final' },
    cancelled: { state: 'post', name: 'STATUS_CANCELED', description: 'Canceled', detail: 'Canceled' },
    postponed: { state: 'pre', name: 'STATUS_POSTPONED', description: 'Postponed', detail: 'Postponed' }
  };
  const t = map[kind] || map.pre;
  const disp = o.clock || (kind === 'live' ? '2:41' : (kind === 'final' ? (o.endTime || '5:00') : '5:00'));
  const secs = (m => m ? (+m[1]) * 60 + (+m[2]) : 0)(/^(\d+):(\d{1,2})$/.exec(disp));
  const st = { clock: o.clockSeconds != null ? o.clockSeconds : (kind === 'live' ? secs : 0), displayClock: disp,
    period: o.round != null ? o.round : (kind === 'pre' ? 0 : 1), type: { id: '1', name: t.name, state: t.state, completed: kind === 'final', description: t.description, detail: t.detail, shortDetail: t.detail } };
  if (kind === 'final' && o.method) st.result = { name: o.method.toLowerCase().replace(/[^a-z]+/g, '-'), displayName: o.method, shortDisplayName: o.method.slice(0, 3).toUpperCase(), description: o.methodDetail || '' };
  return st;
}

/* bouts: [{id, red:{id,name,record}, blue:{...}, weight, rounds, segment, status:'pre'|'live'|'final'|'cancelled', round, clock, method, winner:'red'|'blue', endTime, redStats, blueStats}] */
function card(o) {
  const evId = o.eventId || '600099001';
  const date = o.date || '2026-09-13T22:00Z';
  const comps = (o.bouts || []).map((b, i, arr) => ({
    id: b.id, uid: 's:3301~l:3320~e:' + evId + '~c:' + b.id, date: b.date || date, timeValid: true,
    type: { id: '1', abbreviation: 'B', text: (b.weight || 'Lightweight') + (b.title ? ' Title' : '') + ' - Bout' },
    matchNumber: b.order != null ? b.order : (arr.length - i),
    cardSegment: { id: '1', description: b.segment || 'Main Card' },
    format: { regulation: { periods: b.rounds || 3, displayName: 'Rounds', slug: 'rounds' } },
    venue: o.venue || { id: '1', fullName: 'Test Arena', address: { city: 'Testville', state: 'TX', country: 'USA' } },
    competitors: [competitor(1, b.red, { winner: b.winner === 'red', stats: b.redStats }), competitor(2, b.blue, { winner: b.winner === 'blue', stats: b.blueStats })],
    status: status(b.status || 'pre', b)
  }));
  const anyLive = comps.some(c => c.status.type.state === 'in');
  const allPost = comps.length && comps.every(c => c.status.type.state === 'post');
  return { leagues: [{ id: '3320', name: 'UFC' }], events: [{ id: evId, uid: 's:3301~l:3320~e:' + evId, date, name: o.name || 'UFC Fight Night: Testerson vs. Sparring', shortName: o.shortName || 'Testerson vs. Sparring',
    competitions: comps, status: status(anyLive ? 'live' : (allPost ? 'final' : 'pre'), {}) }] };
}

/* A core-API statistics document. */
function statsDoc(s, rounds) {
  s = s || {};
  const stat = (name, value, display) => ({ name, displayName: name, abbreviation: name.slice(0, 4).toUpperCase(), value, displayValue: display != null ? display : String(value) });
  const cats = [
    { name: 'general', stats: [stat('knockdowns', s.kd || 0), stat('submissionAttempts', s.sub || 0), stat('reversals', s.rev || 0), stat('controlTime', s.ctrl || 0, fmt(s.ctrl || 0))] },
    { name: 'significantStrikes', stats: [stat('sigStrikesLanded', s.sigL || 0), stat('sigStrikesAttempted', s.sigA || 0),
      stat('sigStrikesHead', s.headL || 0, (s.headL || 0) + '/' + (s.headA || 0)), stat('sigStrikesBody', s.bodyL || 0, (s.bodyL || 0) + '/' + (s.bodyA || 0)), stat('sigStrikesLeg', s.legL || 0, (s.legL || 0) + '/' + (s.legA || 0)),
      stat('sigStrikesDistance', s.distL || 0, (s.distL || 0) + '/' + (s.distA || 0)), stat('sigStrikesClinch', s.clinchL || 0, (s.clinchL || 0) + '/' + (s.clinchA || 0)), stat('sigStrikesGround', s.groundL || 0, (s.groundL || 0) + '/' + (s.groundA || 0)),
      stat('sigStrikesPct', s.sigA ? Math.round(100 * (s.sigL || 0) / s.sigA) : 0)] },
    { name: 'totalStrikes', stats: [stat('totalStrikesLanded', s.totL || 0), stat('totalStrikesAttempted', s.totA || 0)] },
    { name: 'takedowns', stats: [stat('takedownsLanded', s.tdL || 0), stat('takedownsAttempted', s.tdA || 0), stat('takedownPct', s.tdA ? Math.round(100 * (s.tdL || 0) / s.tdA) : 0)] }
  ];
  const doc = { $ref: 'statistics', splits: { id: '0', name: 'All Splits', categories: cats } };
  if (rounds) doc.rounds = Object.keys(rounds).map(n => ({ name: 'Round ' + n, period: Number(n), categories: statsDoc(rounds[n]).splits.categories }));
  return doc;
}
function fmt(sec) { return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }

module.exports = { card, statsDoc, status, competitor };

if (require.main === module) {
  /* write the sample the sync job's --fixture path can read */
  const fs = require('fs'), path = require('path');
  const sample = card({ bouts: [
    { id: '401900101', order: 3, red: { id: '5000001', name: 'Marco Testerson', record: '15-3-0' }, blue: { id: '5000002', name: 'Ivan Sparring', record: '12-4-0' }, weight: 'Lightweight', rounds: 5, segment: 'Main Card', title: true },
    { id: '401900102', order: 2, red: { id: '5000003', name: 'Zhang Fixture', record: '9-1-0' }, blue: { id: '5000004', name: 'Alex Placeholder', record: '11-2-0' }, weight: 'Flyweight', rounds: 3, segment: 'Main Card' },
    { id: '401900103', order: 1, red: { id: '5000005', name: 'Jon "Sample" Dummy Jr.', record: '7-0-0' }, blue: { id: '5000006', name: 'Jiří Mockovský', record: '6-1-0' }, weight: 'Welterweight', rounds: 3, segment: 'Prelims' }
  ] });
  fs.writeFileSync(path.join(__dirname, 'scoreboard_sample.json'), JSON.stringify(sample, null, 1));
  console.log('wrote scoreboard_sample.json');
}
