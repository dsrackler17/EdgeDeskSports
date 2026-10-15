#!/usr/bin/env node
'use strict';
/* ===========================================================================
   lib/edgedesk_games.js — the slate kernel. Plain node, no dependencies.

   Dates: the reader's own calendar day, local midnight, 23- and 25-hour
   daylight-saving days, a zone whose midnight does not exist, the
   America/Chicago fallback. Selection: a game at 11:59 PM is today's, at
   12:01 AM it is not; future games never in Today; "Upcoming" only for a
   sport with nothing on the day. Status from the feed, "Started" when the
   feed has gone quiet, ordering, doubleheaders, dedupe, the live overlay
   (a rescheduled game leaves its old day). Markets: puck line, run line,
   the draw, both sides labelled, nothing invented, the integrity check, The
   Odds API's events oriented and matched. Research links, readiness through
   lib/edgedesk_readiness.js (a signal only when it passed), the URL state.

   Run: node tools/slate/games.test.js
   =========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'edgedesk_games.js'));
const R = require(path.join(ROOT, 'lib', 'edgedesk_readiness.js'));
const E = require('./fixtures/espn_shapes.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
const CHI = 'America/Chicago';
const ms = (s) => Date.parse(s);

/* ── DATES AND ZONES ─────────────────────────────────────────────────── */
eq('a normal Chicago day is 24 hours', G.dayBounds('2026-10-13', CHI).hours, 24);
eq('it starts at 05:00Z (CDT midnight)', new Date(G.dayBounds('2026-10-13', CHI).from).toISOString(), '2026-10-13T05:00:00.000Z');
eq('spring forward (2027-03-14) is a 23-hour day', G.dayBounds('2027-03-14', CHI).hours, 23);
eq('fall back (2026-11-01) is a 25-hour day', G.dayBounds('2026-11-01', CHI).hours, 25);
eq('the day after fall back starts at CST midnight (06:00Z)', new Date(G.dayBounds('2026-11-02', CHI).from).toISOString(), '2026-11-02T06:00:00.000Z');
eq('Santiago jumps over midnight: the day starts at the first instant that exists', new Date(G.dayBounds('2026-09-06', 'America/Santiago').from).toISOString(), '2026-09-06T04:00:00.000Z');
eq('Lord Howe moves by half an hour: a 23.5-hour day', G.dayBounds('2026-10-04', 'Australia/Lord_Howe').hours, 23.5);
eq('Kolkata (+05:30) starts the day the evening before in UTC', new Date(G.dayBounds('2026-10-13', 'Asia/Kolkata').from).toISOString(), '2026-10-12T18:30:00.000Z');
eq('one second before Chicago midnight is still the 13th', G.today(ms('2026-10-14T04:59:59Z'), CHI), '2026-10-13');
eq('Chicago midnight is the 14th', G.today(ms('2026-10-14T05:00:00Z'), CHI), '2026-10-14');
eq('at the same instant it is already the 14th in New York', G.today(ms('2026-10-14T04:30:00Z'), 'America/New_York'), '2026-10-14');
eq('30 s before midnight, the next day is 30 s away', G.msUntilNextDay(ms('2026-10-14T04:59:30Z'), CHI), 30000);
eq('on the fall-back night, midnight to midnight is 25 h', G.msUntilNextDay(ms('2026-11-01T05:00:00Z'), CHI), 25 * 3600e3);
eq('an unknown preference falls to the browser zone', G.resolveZone('Mars/Olympus', 'America/Denver'), { zone: 'America/Denver', source: 'browser' });
eq('no usable zone at all falls to America/Chicago', G.resolveZone(null, 'Not/AZone'), { zone: 'America/Chicago', source: 'fallback' });
eq('a valid preference wins', G.resolveZone('Europe/London', 'America/Denver'), { zone: 'Europe/London', source: 'preference' });
eq('relDay: today, yesterday, tomorrow, then a date', ['2026-10-13', '2026-10-12', '2026-10-14', '2026-10-16'].map((d) => G.relDay(d, '2026-10-13')), ['Today', 'Yesterday', 'Tomorrow', 'Fri, Oct 16']);
eq('addDays crosses a month and a DST change without drift', [G.addDays('2026-10-31', 1), G.addDays('2026-11-01', 1), G.addDays('2027-03-13', 1)], ['2026-11-01', '2026-11-02', '2027-03-14']);
eq('times name their zone: CDT before the change', G.timeText(ms('2026-10-13T23:00:00Z'), CHI), '6:00 PM CDT');
eq('and CST after it', G.timeText(ms('2026-11-03T00:00:00Z'), CHI), '6:00 PM CST');
chk('isDateKey refuses an impossible date', !G.isDateKey('2026-02-30') && G.isDateKey('2028-02-29'));
chk('an instant without a zone is refused, not read as UTC', G.toMs('2026-10-13T18:00:00') === null && G.toMs('2026-10-13T18:00Z') === ms('2026-10-13T18:00Z'));

/* ── NORMALISING ESPN ───────────────────────────────────────────────── */
const DET = E.team('DET', 'Detroit Red Wings', 'Red Wings', 5), NJ = E.team('NJ', 'New Jersey Devils', 'Devils', 1);
const src = { sport: 'nhl', league: 'NHL', fetched_at: '2026-10-13T22:30:00.000Z' };
const live = G.fromEspn(E.event({ id: 1, date: '2026-10-13T22:00Z', home: DET, away: NJ, hs: 2, as: 1, status: E.status('live', { detail: '2nd 12:34', period: 2, clock: '12:34' }) }), src);
eq('a live game: status, detail, period, clock, score', [live.status, live.status_detail, live.period, live.clock, live.home.score, live.away.score], ['LIVE', '2nd 12:34', 2, '12:34', 2, 1]);
eq('the id is <sport>:<provider>:<provider id>', live.id, 'nhl:espn:1');
const pre = G.fromEspn(E.event({ id: 2, date: '2026-10-13T23:00Z', home: DET, away: NJ, status: E.status('pre') }), src);
chk('a scheduled game carries no score, even though the feed sends "0"', pre.home.score === null && pre.away.score === null);
const fin = G.fromEspn(E.event({ id: 3, date: '2026-10-13T17:00Z', home: DET, away: NJ, hs: 4, as: 3, status: E.status('final', { detail: 'Final/OT' }) }), src);
eq('a final keeps its score and the provider detail', [fin.status, fin.status_detail, fin.home.score], ['FINAL', 'Final/OT', 4]);
eq('postponed and canceled', [E.status('postponed'), E.status('canceled')].map((s) => G.statusFromEspn(s).status), ['POSTPONED', 'CANCELED']);
eq('halftime, end of period, shootout and a rain delay in progress are live', ['STATUS_HALFTIME', 'STATUS_END_PERIOD', 'STATUS_SHOOTOUT', 'STATUS_RAIN_DELAY'].map((n) => G.statusFromEspn({ type: { name: n, state: 'in' } }).status), ['LIVE', 'LIVE', 'LIVE', 'LIVE']);
eq('a delay before the start is Delayed; a suspension is Suspended; a forfeit is Final', ['STATUS_DELAYED', 'STATUS_SUSPENDED', 'STATUS_FORFEIT'].map((n) => G.statusFromEspn({ type: { name: n, state: n === 'STATUS_SUSPENDED' ? 'post' : 'pre' } }).status), ['DELAYED', 'SUSPENDED', 'FINAL']);
eq('ESPN\'s full time is final', G.statusFromEspn({ type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true } }).status, 'FINAL');
const tbd = G.fromEspn(E.event({ id: 4, date: '2026-10-17T04:00Z', timeValid: false, home: DET, away: NJ, status: E.status('pre') }), src);
chk('timeValid: false is a TBD time, not a 4 AM start', tbd.time_tbd === true);
const neu = G.fromEspn(E.event({ id: 5, date: '2026-10-18T13:30Z', neutral: true, venue: 'Wembley Stadium', city: 'London', state: 'England', home: DET, away: NJ, status: E.status('pre') }), src);
eq('a neutral site and its venue', [neu.neutral, neu.venue, neu.city], [true, 'Wembley Stadium', 'London, England']);
chk('an event without two named sides is dropped', G.fromEspn({ id: 9, date: '2026-10-13T23:00Z', competitions: [{ competitors: [{ homeAway: 'home', team: { displayName: 'X' } }] }] }, src) === null);
chk('an unknown sport is dropped', G.fromEspn(E.event({ id: 6, date: '2026-10-13T23:00Z', home: DET, away: NJ, status: E.status('pre') }), { sport: 'cricket' }) === null);
const ufc = G.fromEspn(E.card({ id: 77, date: '2026-10-18T02:00Z', name: 'UFC Fight Night: Doe vs. Roe', shortName: 'Doe vs. Roe', status: E.status('pre'),
  bouts: [{ a: 'Al Prelim', b: 'Bo Prelim' }, { a: 'John Doe', b: 'Rick Roe' }, { a: 'Late Swap', b: 'Other Guy' }] }), { sport: 'mma', league: 'UFC' });
eq('a UFC card is one event: its title, its headline bout (by name, not position), its bout count', [ufc.title, ufc.away.name, ufc.home.name, ufc.bouts], ['UFC Fight Night: Doe vs. Roe', 'John Doe', 'Rick Roe', 3]);

/* ── EFFECTIVE STATUS ───────────────────────────────────────────────── */
const quiet = G.effective(Object.assign({}, pre, { updated_at: '2026-10-13T22:30:00Z' }), ms('2026-10-13T23:20:00Z'));
eq('a scheduled game past its start, with no update since, is Started (never Live)', [quiet.status, quiet.status_stale], ['STARTED', true]);
eq('it is in the live group but carries no score', [G.statusGroup(quiet.status), quiet.home.score], ['live', null]);
const oldLive = G.effective(Object.assign({}, live, { updated_at: '2026-10-13T22:00:00Z' }), ms('2026-10-13T22:30:00Z'));
chk('a live read older than the live limit stays Live, marked stale', oldLive.status === 'LIVE' && oldLive.status_stale === true);
chk('effective() never edits the event itself', pre.status === 'SCHEDULED');
chk('a TBD time is never "Started"', G.effective(Object.assign({}, tbd, { start_utc: '2026-10-13T04:00:00Z' }), ms('2026-10-13T22:00:00Z')).status === 'SCHEDULED');

/* ── SELECTING A DAY ────────────────────────────────────────────────── */
function ev(id, sport, start, status, o) {
  return Object.assign({ id: sport + ':espn:' + id, sport, start_utc: start, status: status || 'SCHEDULED', updated_at: '2026-10-13T22:30:00Z',
    home: { name: 'Home ' + id, abbr: 'H' + id }, away: { name: 'Away ' + id, abbr: 'A' + id } }, o || {});
}
const NOW = ms('2026-10-13T22:30:00Z');
const list = [
  ev(1, 'nhl', '2026-10-14T04:59:00Z'),                 /* 11:59 PM CDT: today */
  ev(2, 'nhl', '2026-10-14T05:01:00Z'),                 /* 12:01 AM CDT: tomorrow */
  ev(3, 'nhl', '2026-10-13T22:00:00Z', 'LIVE'),
  ev(4, 'nhl', '2026-10-13T17:00:00Z', 'FINAL'),
  ev(5, 'mlb', '2026-10-14T01:40:00Z', 'POSTPONED'),
  ev(6, 'mlb', '2026-10-13T23:10:00Z'),
  ev(7, 'nba', '2026-10-20T23:30:00Z'),
  ev(8, 'nba', '2026-10-21T23:30:00Z'),
  ev(9, 'nfl', '2026-10-16T00:15:00Z'),
  ev(10, 'ncaam', '2026-10-13T19:00:00Z', 'FINAL', { home: { name: 'Montréal Carabins' }, away: { name: 'Toronto' } }),
  ev(12, 'soccer', '2026-10-13T21:00:00Z', 'LIVE'),       /* a sport no longer listed */
  ev(11, 'nhl', '2026-11-30T00:00:00Z')                  /* past the Upcoming horizon */
];
const day = G.select(list, { date: '2026-10-13', zone: CHI, now: NOW });
eq('today in order: live, then upcoming by start, then final, then postponed', day.games.map((e) => e.id), ['nhl:espn:3', 'mlb:espn:6', 'nhl:espn:1', 'nhl:espn:4', 'ncaam:espn:10', 'mlb:espn:5']);
chk('a sport no longer listed (soccer) is never shown, live or not, and never counted', !day.games.some((e) => e.sport === 'soccer') && day.counts.soccer === undefined && day.counts.all === 6);
chk('11:59 PM local is today; 12:01 AM is not', day.games.some((e) => e.id === 'nhl:espn:1') && !day.games.some((e) => e.id === 'nhl:espn:2'));
chk('a later game is never under today', day.games.every((e) => { const t = ms(e.start_utc); return t >= day.bounds.from && t < day.bounds.to; }));
eq('counts per sport', [day.counts.all, day.counts.nhl, day.counts.mlb, day.counts.nba, day.counts.ncaam], [6, 3, 2, 0, 1]);
eq('counts per status group', day.by_status, { live: 1, upcoming: 2, final: 2, off: 1 });
const tomorrow = G.select(list, { date: '2026-10-14', zone: CHI, now: NOW });
chk('the 12:01 AM game is tomorrow’s', tomorrow.games.some((e) => e.id === 'nhl:espn:2'));
const nba = G.select(list, { date: '2026-10-13', zone: CHI, now: NOW, sport: 'nba' });
eq('a sport with nothing today: no games …', nba.games.length, 0);
eq('… and its next games, separately, as Upcoming', nba.upcoming.map((u) => [u.sport, u.games.map((e) => e.id)]), [['nba', ['nba:espn:7', 'nba:espn:8']]]);
const allUp = G.select(list, { date: '2026-10-13', zone: CHI, now: NOW });
chk('under All sports, Upcoming lists only sports with nothing today', allUp.upcoming.every((u) => !allUp.counts[u.sport]) && allUp.upcoming.some((u) => u.sport === 'nba') && allUp.upcoming.some((u) => u.sport === 'nfl'));
chk('Upcoming stops at its horizon (14 days): a game 29 days out is not offered', !G.select(list, { date: '2026-11-01', zone: CHI, now: NOW, sport: 'nhl' }).upcoming.length);
chk('a past day offers no Upcoming', !G.select(list, { date: '2026-10-12', zone: CHI, now: NOW, sport: 'nba' }).upcoming.length);
chk('a search offers no Upcoming', !G.select(list, { date: '2026-10-13', zone: CHI, now: NOW, sport: 'nba', q: 'x' }).upcoming.length);
eq('status filter: live only', G.select(list, { date: '2026-10-13', zone: CHI, now: NOW, status: 'live' }).games.map((e) => e.id), ['nhl:espn:3']);
eq('status filter: postponed and canceled', G.select(list, { date: '2026-10-13', zone: CHI, now: NOW, status: 'off' }).games.map((e) => e.id), ['mlb:espn:5']);
eq('search ignores accents and case', G.select(list, { date: '2026-10-13', zone: CHI, now: NOW, q: 'MONTREAL' }).games.map((e) => e.id), ['ncaam:espn:10']);
eq('the same games in Tokyo (+9) all fall on the 14th', G.select(list, { date: '2026-10-14', zone: 'Asia/Tokyo', now: NOW }).games.map((e) => e.id).sort(), ['mlb:espn:5', 'mlb:espn:6', 'nhl:espn:1', 'nhl:espn:2', 'nhl:espn:3', 'nhl:espn:4', 'ncaam:espn:10'].sort());
eq('and none on the 13th', G.select(list, { date: '2026-10-13', zone: 'Asia/Tokyo', now: NOW }).games.length, 0);

/* ── DOUBLEHEADERS, DEDUPE, OVERLAY ─────────────────────────────────── */
const g1 = ev('d1', 'mlb', '2026-10-13T17:05:00Z', 'FINAL', { home: { id: '2', name: 'Boston Red Sox' }, away: { id: '10', name: 'New York Yankees' } });
const g2 = ev('d2', 'mlb', '2026-10-13T23:10:00Z', 'SCHEDULED', { home: { id: '2', name: 'Boston Red Sox' }, away: { id: '10', name: 'New York Yankees' } });
const dh = G.markDoubleheaders([g2, g1].map((x) => Object.assign({}, x)), CHI);
eq('a doubleheader is two games, labelled by start time', dh.map((e) => [e.id, e.doubleheader && e.doubleheader.game]), [['mlb:espn:d2', 2], ['mlb:espn:d1', 1]]);
const dh2 = G.markDoubleheaders([Object.assign({}, g1, { game_number: 2 }), Object.assign({}, g2, { game_number: 1 })], CHI);
eq('the provider’s own game number wins over start order', dh2.map((e) => e.doubleheader.game), [2, 1]);
const dh3 = G.markDoubleheaders([Object.assign({}, g1), Object.assign({}, g2, { game_number: 2 })], CHI);
eq('one game noted "Game 2" makes the other Game 1, never a second Game 2', dh3.map((e) => [e.id, e.doubleheader.game]), [['mlb:espn:d1', 1], ['mlb:espn:d2', 2]]);
chk('two games between other teams are not a doubleheader', !G.markDoubleheaders([ev(1, 'mlb', '2026-10-13T17:00:00Z'), ev(2, 'mlb', '2026-10-13T23:00:00Z')], CHI).some((e) => e.doubleheader));
const old = ev(1, 'nhl', '2026-10-13T22:00:00Z', 'SCHEDULED', { updated_at: '2026-10-13T20:00:00Z', venue: 'Arena' });
const nw = ev(1, 'nhl', '2026-10-13T22:00:00Z', 'LIVE', { updated_at: '2026-10-13T22:20:00Z', venue: null });
const dd = G.dedupe([old, nw]);
eq('one id, one event: the newer read wins, the older fills its silences', [dd.length, dd[0].status, dd[0].venue], [1, 'LIVE', 'Arena']);
const base = [Object.assign(ev(1, 'nhl', '2026-10-13T22:00:00Z'), { feed: 'nhl:hockey/nhl', sb_day: '2026-10-13' }),
  Object.assign(ev(2, 'nhl', '2026-10-13T23:00:00Z'), { feed: 'nhl:hockey/nhl', sb_day: '2026-10-13' }),
  Object.assign(ev(3, 'nhl', '2026-10-14T23:00:00Z'), { feed: 'nhl:hockey/nhl', sb_day: '2026-10-14' }),
  Object.assign(ev(4, 'ncaam', '2026-10-13T19:00:00Z'), { feed: 'ncaam:basketball/mens-college-basketball', sb_day: '2026-10-13' })];
const liveRead = [Object.assign(ev(1, 'nhl', '2026-10-13T22:00:00Z', 'LIVE', { updated_at: '2026-10-13T22:29:00Z' }), { feed: 'nhl:hockey/nhl', sb_day: '2026-10-13' })];
const ov = G.overlay(base, liveRead, [{ feed: 'nhl:hockey/nhl', sport: 'nhl', day: '2026-10-13', fetched_at: '2026-10-13T22:29:00Z' }]);
eq('the live read replaces its covered day; a game it no longer lists (rescheduled) leaves that day; other days and feeds stay',
  ov.map((e) => e.id + ':' + e.status).sort(), ['ncaam:espn:4:SCHEDULED', 'nhl:espn:1:LIVE', 'nhl:espn:3:SCHEDULED']);

/* ── IDENTITY ───────────────────────────────────────────────────────── */
chk('ESPN NJ is the NHL’s NJD', G.sameSide('nhl', { abbr: 'NJ', name: 'New Jersey Devils' }, { abbr: 'NJD', name: 'X' }));
chk('ESPN WSH and LAR are nflverse WAS and LA', G.sameSide('nfl', { abbr: 'WSH' }, { abbr: 'WAS' }) && G.sameSide('nfl', { abbr: 'LAR' }, { abbr: 'LA' }));
chk('club words and accents do not split a name', G.sameSide('nhl', { name: 'Montréal Canadiens' }, { name: 'Montreal Canadiens' }) && G.sameSide('mlb', { name: 'Athletics Baseball Club' }, { name: 'Athletics Baseball' }));
chk('a mascot does not split a college name', G.sameSide('cfb', { name: 'Middle Tennessee Blue Raiders' }, { name: 'Middle Tennessee' }));
chk('but two different schools sharing a word are different', !G.sameSide('cfb', { name: 'Tennessee Volunteers' }, { name: 'Middle Tennessee' }) && !G.sameSide('cfb', { name: 'Miami Hurricanes' }, { name: 'Miami (OH) RedHawks' }));
chk('sameEvent needs both sides and a start inside the window', G.sameEvent({ sport: 'nhl', start_utc: '2026-10-13T22:00:00Z', home: { name: 'Detroit Red Wings' }, away: { name: 'New Jersey Devils' } },
  { sport: 'nhl', start_utc: '2026-10-13T23:30:00Z', home: { name: 'Detroit Red Wings' }, away: { name: 'New Jersey Devils' } })
  && !G.sameEvent({ sport: 'nhl', start_utc: '2026-10-13T22:00:00Z', home: { name: 'Detroit Red Wings' }, away: { name: 'New Jersey Devils' } },
    { sport: 'nhl', start_utc: '2026-10-15T22:00:00Z', home: { name: 'Detroit Red Wings' }, away: { name: 'New Jersey Devils' } }));

/* ── MARKETS ────────────────────────────────────────────────────────── */
const cap = '2026-10-13T22:20:00Z';
const nhlE = ev('m1', 'nhl', '2026-10-13T23:00:00Z', 'SCHEDULED', { home: { name: 'Columbus Blue Jackets', abbr: 'CBJ' }, away: { name: 'Florida Panthers', abbr: 'FLA' } });
const nhlM = { book: 'DraftKings', captured_at: cap, moneyline: { home: 130, away: -150 }, spread: { home: { point: 1.5, price: -205 }, away: { point: -1.5, price: 170 } }, total: { point: 6.5, over: -110, under: -110 } };
const f1 = G.formatMarket(nhlE, nhlM, { now: NOW });
eq('a hockey spread is the puck line', f1.cols, ['Puck line', 'Moneyline', 'Total']);
eq('both sides, each labelled, each priced', f1.rows.map((r) => [r.label].concat(r.cells)), [['FLA', '−1.5 +170', '−150', 'O 6.5 −110'], ['CBJ', '+1.5 −205', '+130', 'U 6.5 −110']]);
chk('with the book and the capture age', f1.book === 'DraftKings' && f1.current && f1.age_min === 10);
eq('a baseball spread is the run line', G.formatMarket(ev('m2', 'mlb', '2026-10-13T23:10:00Z'), { captured_at: cap, spread: { home: { point: -1.5, price: 140 }, away: { point: 1.5, price: -160 } } }, { now: NOW }).cols, ['Run line']);
eq('no sport listed is three-way, and soccer is not listed', [G.SPORTS.filter((x) => x.draw).length, G.sport('soccer')], [0, null]);
eq('no market: "Odds unavailable", with the reason', [G.formatMarket(nhlE, null, { now: NOW }).text, G.formatMarket(nhlE, null).reason], ['Odds unavailable', 'no captured price on file for this game']);
chk('a market without a capture time cannot be verified', !G.formatMarket(nhlE, Object.assign({}, nhlM, { captured_at: null }), { now: NOW }).ok);
const stale = G.formatMarket(nhlE, Object.assign({}, nhlM, { captured_at: '2026-10-13T18:00:00Z' }), { now: NOW });
chk('a price past the limit is shown as a past price, never as current', stale.ok && stale.stale && !stale.current && /past the 90-minute limit/.test(stale.note));
eq('PK and signs', [G.point(0), G.point(-1.5), G.point(3), G.american(-110), G.american(150), G.american(50)], ['PK', '−1.5', '+3', '−110', '+150', null]);
const cm = G.cleanMarket('nfl', { moneyline: { home: -110 }, spread: { home: { point: -3, price: -110 }, away: { point: 2.5, price: -110 } }, total: { point: 120, over: -110, under: -110 } });
eq('the integrity check drops a one-sided moneyline, spreads that are not opposite and an impossible total', [cm.market, cm.why.length], [null, 3]);
eq('and an overround outside 0–25%', G.cleanMarket('nba', { moneyline: { home: -400, away: -300 } }).why[0].indexOf('overround') >= 0, true);
eq('an NFL spread off the half-point grid is not allowed; a sport not listed has no market',
  [!!G.cleanMarket('nfl', { spread: { home: { point: -3.25, price: -110 }, away: { point: 3.25, price: -110 } } }).market, G.cleanMarket('soccer', { moneyline: { home: 120, away: 210, draw: 250 } }).market], [false, null]);
eq('decimal to American', [G.decToAm(1.91), G.decToAm(2.5), G.decToAm(2), G.decToAm(1)], [-110, 150, 100, null]);

/* The Odds API → the slate */
const slate = [ev('o1', 'nfl', '2026-10-16T00:15:00Z', 'SCHEDULED', { home: { name: 'Denver Broncos', abbr: 'DEN' }, away: { name: 'Seattle Seahawks', abbr: 'SEA' } })];
const oddsEv = [{ event_id: 'abc', sport_key: 'americanfootball_nfl', commence_time: '2026-10-16T00:15:00Z', home_team: 'Seattle Seahawks', away_team: 'Denver Broncos', odds_format: 'decimal',
  bookmakers: [
    { key: 'bovada', title: 'Bovada', markets: [{ key: 'h2h', last_update: '2026-10-13T22:00:00Z', outcomes: [{ name: 'Denver Broncos', price: 2.2 }, { name: 'Seattle Seahawks', price: 1.7 }] }] },
    { key: 'draftkings', title: 'DraftKings', markets: [
      { key: 'h2h', last_update: '2026-10-13T22:10:00Z', outcomes: [{ name: 'Denver Broncos', price: 2.25 }, { name: 'Seattle Seahawks', price: 1.69 }] },
      { key: 'spreads', last_update: '2026-10-13T22:05:00Z', outcomes: [{ name: 'Denver Broncos', price: 1.91, point: 2.5 }, { name: 'Seattle Seahawks', price: 1.91, point: -2.5 }] },
      { key: 'totals', last_update: '2026-10-13T22:12:00Z', outcomes: [{ name: 'Over', price: 1.91, point: 39.5 }, { name: 'Under', price: 1.91, point: 39.5 }] }] }] }];
const om = G.fromOddsApi(oddsEv, slate)['nfl:espn:o1'];
eq('the preferred US book, both sides of every number from it', om && [om.book, om.source, om.moneyline, om.spread, om.total], ['DraftKings', 'odds_api', { home: 125, away: -145 }, { home: { point: 2.5, price: -110 }, away: { point: -2.5, price: -110 } }, { point: 39.5, over: -110, under: -110 }]);
eq('oriented to the slate’s home team when the provider lists them the other way round', om.moneyline.home, 125);
eq('the capture time is the oldest market used', om.captured_at, '2026-10-13T22:05:00.000Z');
chk('an event that matches two slate games is not guessed', !Object.keys(G.fromOddsApi(oddsEv, slate.concat([Object.assign({}, slate[0], { id: 'nfl:espn:o2', start_utc: '2026-10-16T01:15:00Z' })]))).length);
chk('a sport the slate does not list is ignored', !Object.keys(G.fromOddsApi([Object.assign({}, oddsEv[0], { sport_key: 'cricket_ipl' })], slate)).length);

/* ── RESEARCH LINKS ─────────────────────────────────────────────────── */
eq('a game with a module and an entity opens that game', G.researchTarget({ research: { module: 'nhl', entity: '2026020090' } }, 'app'), { kind: 'module', href: '#research/nhl/2026020090', label: 'View Research', exact: true });
eq('an NFL entity keeps its pipe through the URL', G.researchTarget({ research: { module: 'football', entity: 'nfl|2026_06_SEA_DEN' } }, 'app').href, '#research/football/nfl%7C2026_06_SEA_DEN');
eq('UFC opens its panel (it has no per-card route)', G.researchTarget({ research: { module: 'ufc', entity: null } }, 'app').href, '#research/ufc');
eq('on the public page a free article comes first', G.researchTarget({ research: { module: 'football', entity: '1', article: { url: '/articles/x/', type: 'pregame' } } }, 'public').kind, 'article');
eq('and research that lives only in the terminal says so', G.researchTarget({ research: { module: 'nhl', entity: '9' } }, 'public'), { kind: 'terminal', href: '/app.html#research/nhl/9', label: 'Research in the terminal', exact: true });
eq('no research page: the matchup view', G.researchTarget({ research: { module: null } }, 'app').kind, 'detail');

/* ── READINESS (lib/edgedesk_readiness.js decides) ──────────────────── */
const base2 = ev('r1', 'cfb', '2026-10-14T00:00:00Z', 'SCHEDULED', { home: { name: 'Home', abbr: 'H' }, away: { name: 'Away', abbr: 'A' } });
const goodMk = { book: 'DraftKings', captured_at: '2026-10-13T22:20:00Z', moneyline: { home: -150, away: 130 } };
const r0 = G.readiness(Object.assign({}, base2, { research: { module: null } }), null, NOW, R);
eq('nothing on file: no research, no odds, no model, no signal', [r0.research.ok, r0.odds.ok, r0.model.ok, r0.signal.ok], [false, false, false, false]);
const r1 = G.readiness(Object.assign({}, base2, { research: { module: 'football', entity: 'x', model: { status: 'PREDICTED', home_line: -3 }, metrics: true, signal: { actionable: false, status: 'PASS', why: 'below threshold' } } }), goodMk, NOW, R);
eq('research, model and a current price, but the gate did not pass: no signal', [r1.research.ok, r1.model.ok, r1.odds.ok, r1.signal.ok], [true, true, true, false]);
const r2 = G.readiness(Object.assign({}, base2, { research: { module: 'football', entity: 'x', model: { status: 'PREDICTED', home_line: -3 }, signal: { actionable: true, status: 'BET', label: 'Certified: BET' } } }), goodMk, NOW, R);
eq('a certified signal with a current price and a model: the signal shows', [r2.signal.ok, r2.signal.text], [true, 'Certified: BET']);
const r3 = G.readiness(Object.assign({}, base2, { research: { module: 'football', entity: 'x', model: { status: 'PREDICTED', home_line: -3 }, signal: { actionable: true, status: 'BET', label: 'Certified: BET' } } }), null, NOW, R);
chk('the same certification without a current price is not shown as a signal', !r3.signal.ok && /market price/.test(r3.signal.why));
const r4 = G.readiness(Object.assign({}, base2, { research: { module: 'football', entity: 'x', model: { status: 'PREDICTED', home_line: -3 }, signal: { actionable: true } } }), Object.assign({}, goodMk, { captured_at: '2026-10-13T12:00:00Z' }), NOW, R);
chk('nor with a stale one', !r4.signal.ok && !r4.odds.ok);
chk('a started game is not "available" in EDREADY’s sense', !G.readiness(Object.assign({}, base2, { start_utc: '2026-10-13T20:00:00Z', status: 'LIVE' }), null, NOW, R).assess.states.AVAILABLE.ok);

/* ── URL STATE ──────────────────────────────────────────────────────── */
const st = { sport: 'nhl', date: '2026-10-13', status: 'live', q: 'red wings' };
eq('the hash round-trips sport, date, status and search', G.parseState(G.stateHash(st)), st);
eq('a bare #games is All sports, today', G.parseState('#games'), { sport: 'all', date: null, status: 'all', q: '' });
eq('an unknown sport or status is ignored', G.parseState('#games/curling/2026-10-13?status=bogus'), { sport: 'all', date: '2026-10-13', status: 'all', q: '' });
chk('an impossible date is ignored', G.parseState('#games/nhl/2026-02-31').date === null);
chk('a hash that is not the games page is not read as one', G.parseState('#research/nhl/1') === null && G.parseState('#gamesx') === null);
chk('a search is capped at 60 characters', G.parseState('#games/all?q=' + 'x'.repeat(200)).q.length === 60);

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'slate kernel — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
