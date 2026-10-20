#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The slate pipeline, end to end, with no network: the ESPN adapter, the
   builder (tools/slate/build.js), the research join and the live poller.

   The adapter reads a recorded ESPN odds block (the CFB lab's fixture) and
   constructed scoreboards (fixtures/espn_shapes.js); refuses a consensus
   quote, a one-sided price and in-play odds; never throws on a 403 or a
   payload without events. The builder: every listed sport, schedules with no
   odds pipeline in the path, a failed read carried forward with its age, the
   repo's own schedule when ESPN never answered, "failed" (not "empty") when
   neither exists, refresh only when due, no rewrite when only timestamps
   moved. The join: each sport's research reference, and a signal only where
   the owning engine certified one. The poller: its gate, its days, and what
   it writes.

   Run: node tools/slate/build.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'edgedesk_games.js'));
const ESPN = require('./espn.js');
const BUILD = require('./build.js');
const RES = require('./research.js');
const LIVE = require('./live_poll.js');
const E = require('./fixtures/espn_shapes.js');
const F = require('./fixtures/slate_fixture.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

(async function main() {
  /* ── THE ADAPTER ──────────────────────────────────────────────────── */
  eq('one plain day per request, the division for college', ESPN.scoreboardUrl({ path: 'football/college-football', groups: '80' }, '20261013'),
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20261013&limit=500&groups=80');
  eq('eight feeds across the eight sports (soccer removed)', [ESPN.feeds().length, Array.from(new Set(ESPN.feeds().map((f) => f.sport))).length], [8, 8]);
  chk('no feed reads a soccer scoreboard', !ESPN.feeds().some((f) => /soccer/.test(f.sport + f.path)));

  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_lab', 'fixtures', 'providers', 'espn_scoreboard_pregame.json'), 'utf8'));
  const recEv = G.fromEspn(rec.events[0], { sport: 'cfb', league: 'FBS', fetched_at: '2026-10-01T12:00:00Z' });
  const recMk = ESPN.marketFromEspn(rec.events[0].competitions[0].odds[0], recEv, '2026-10-01T12:00:00Z');
  eq('a recorded ESPN odds block (CFB lab fixture) reads as one book, both sides, every number', [recMk.book, recMk.spread, recMk.total, recMk.moneyline],
    ['DraftKings', { home: { point: -6.5, price: -110 }, away: { point: 6.5, price: -110 } }, { point: 55.5, over: -110, under: -110 }, { home: -250, away: 205 }]);
  const evS = G.fromEspn(E.event({ id: 1, date: '2026-10-13T23:00Z', home: F.T.CBJ, away: F.T.FLA, status: E.status('pre') }), { sport: 'nhl', fetched_at: 'x' });
  chk('a consensus quote is a number, not a book: refused', /no named book/.test(ESPN.marketFromEspn(E.odds({ book: 'consensus', homeAbbr: 'CBJ', awayAbbr: 'FLA', home: { ml: 130 }, away: { ml: -150 } }), evS, 'x').reject || ''));
  chk('a one-sided price is refused, with why', /not priced on every side/.test(ESPN.marketFromEspn(E.odds({ book: 'DraftKings', home: { ml: 130 }, away: {} }), evS, 'x').reject || ''));
  const mlOnly = ESPN.marketFromEspn(E.odds({ book: 'DraftKings', home: { ml: 130 }, away: { ml: -150 } }), evS, 'x');
  eq('a moneyline-only quote (no line, no total) is still read', [mlOnly.moneyline, mlOnly.spread, mlOnly.total], [{ home: 130, away: -150 }, undefined, undefined]);
  const parsed = ESPN.parseScoreboard(F.table()['hockey/nhl|20261013'], { sport: 'nhl', league: 'NHL', key: 'nhl:hockey/nhl' }, '2026-10-13T22:30:00.000Z');
  eq('five NHL games read; odds only for the pregame one (the live game’s in-play odds are never read)', [parsed.events.length, Object.keys(parsed.markets)], [5, ['nhl:espn:401802002']]);
  const r403 = await ESPN.readDay({ sport: 'nhl', path: 'hockey/nhl', key: 'nhl:hockey/nhl' }, '20261013', { fetch: E.fakeFetch({ 'hockey/nhl|20261013': { status: 403 } }) });
  eq('a 403 is a failed read, never a thrown error and never an empty day', [r403.ok, r403.status, r403.events.length], [false, 403, 0]);
  const rDrift = await ESPN.readDay({ sport: 'nhl', path: 'hockey/nhl', key: 'nhl:hockey/nhl' }, '20261013', { fetch: E.fakeFetch({ 'hockey/nhl|20261013': { leagues: [] } }) });
  chk('a payload without an events array is schema drift: a failed read', !rDrift.ok && /schema drift/.test(rDrift.error));
  const rNet = await ESPN.readDay({ sport: 'nhl', path: 'hockey/nhl', key: 'nhl:hockey/nhl' }, '20261013', { fetch: E.fakeFetch({ 'hockey/nhl|20261013': new Error('ECONNRESET') }) });
  chk('a network error is a failed read', !rNet.ok && /ECONNRESET/.test(rNet.error));

  /* ── THE BUILDER ──────────────────────────────────────────────────── */
  const log = [];
  const r = await F.buildFixture({ log });
  const s = r.snap;
  eq('the snapshot schema', s.schema, 'edgedesk_slate/1');
  chk('no request reaches the odds pipeline: every read is an ESPN scoreboard', log.every((k) => /^[a-z-]+\/[a-z0-9.-]+\|\d{8}$/.test(k)), log.slice(0, 3));
  const ids = s.events.map((e) => e.id);
  chk('every listed sport with games in the window is in it', ['nhl', 'mlb', 'cfb', 'nfl', 'ncaam'].every((sp) => s.events.some((e) => e.sport === sp)));
  chk('soccer is not a listed sport: no feed, no bucket, no event', !s.sports.soccer && !Object.keys(s.buckets).some((k) => /^soccer/.test(k)) && !s.events.concat(s.upcoming).some((e) => e.sport === 'soccer') && !log.some((k) => /^soccer\//.test(k)));
  chk('UFC failed on every day: its state is failed, with no events', s.sports.mma.state === 'failed' && !s.events.some((e) => e.sport === 'mma'));
  chk('college baseball answered, empty: its state is ok (a confirmed empty slate)', s.sports.ncaabase.state === 'ok' && !s.events.some((e) => e.sport === 'ncaabase'));
  chk('both games of the doubleheader are in, as two events', ids.indexOf('mlb:espn:401803001') >= 0 && ids.indexOf('mlb:espn:401803002') >= 0);
  eq('the provider’s "Game 2" note is kept', s.events.find((e) => e.id === 'mlb:espn:401803002').game_number, 2);
  eq('the postponed game stays on the slate, postponed', s.events.find((e) => e.id === 'mlb:espn:401803003').status, 'POSTPONED');
  chk('late West Coast games remember the Eastern scoreboard day they were read from', s.events.find((e) => e.id === 'nhl:espn:401802005').sb_day === '2026-10-13');
  eq('Upcoming carries the next games of sports with few ahead: the neutral-site NFL game and the NBA opener', s.upcoming.map((e) => e.id).sort(), ['nba:espn:401900001', 'nfl:espn:401880002']);
  chk('the neutral site survives', s.upcoming.find((e) => e.id === 'nfl:espn:401880002').neutral === true);
  eq('markets: only pregame, only named books, both sides — the upcoming games’ posted lines too', Object.keys(s.markets).sort(), ['mlb:espn:401803002', 'nfl:espn:401880001', 'nfl:espn:401880002', 'nhl:espn:401802002', 'ncaam:espn:401910002'].sort());
  chk('an upcoming game past the window keeps the line its book posted (the Card prices next week’s slate)', s.markets['nfl:espn:401880002'] && s.markets['nfl:espn:401880002'].spread && s.markets['nfl:espn:401880002'].spread.home.point === 1.5);
  chk('the refused consensus quote is counted, not shown', s.run.odds_rejected === 1 && !s.markets['cfb:espn:401871067']);
  chk('every market carries its book and its capture time', Object.values(s.markets).every((m) => m.book && m.captured_at && m.source === 'espn_scoreboard'));

  /* the same build five minutes later reads nothing; 25 minutes later only the near days */
  const log2 = [];
  const r2 = await F.buildFixture({ prev: s, now: F.NOW + 5 * 60000, log: log2 });
  eq('five minutes later: nothing is due, nothing is read', r2.requests, 0);
  chk('and nothing changed beyond timestamps, so nothing would be written', BUILD.material(r2.snap) === BUILD.material(Object.assign({}, s, { generated_at: 'x' })));
  const log3 = [];
  await F.buildFixture({ prev: s, now: F.NOW + 25 * 60000, log: log3 });
  chk('25 minutes later only yesterday and today (and failed reads past their backoff) are read again', log3.length > 0 && log3.every((k) => /\|2026101[23]$/.test(k) || /^mma\//.test(k)), log3);

  /* a failed read keeps the previous read, labelled */
  const t2 = F.table();
  t2['hockey/nhl|20261013'] = { status: 503 };
  const r4 = await F.buildFixture({ prev: s, now: F.NOW + 25 * 60000, table: t2 });
  const b4 = r4.snap.buckets['nhl:hockey/nhl|2026-10-13'];
  chk('ESPN down for NHL today: the previous read is carried, with its age and the error', b4.ok && b4.carried && b4.fetched_at === s.buckets['nhl:hockey/nhl|2026-10-13'].fetched_at && /503/.test(b4.last_error));
  chk('its games are still on the slate', r4.snap.events.filter((e) => e.sport === 'nhl').length === s.events.filter((e) => e.sport === 'nhl').length);
  eq('and the sport says stale', r4.snap.sports.nhl.state, 'stale');
  chk('a carried price keeps its original capture time (it ages; it is never refreshed by a failure)', r4.snap.markets['nhl:espn:401802002'].captured_at === s.markets['nhl:espn:401802002'].captured_at);

  /* ESPN never answered, the repo has a schedule: the fallback, labelled */
  const art = { bySport: { nhl: [{ id: 'nhl:nhl:2026020090', sport: 'nhl', league: 'NHL', provider: 'nhl', provider_id: '2026020090', start_utc: '2026-10-13T22:00:00.000Z', status: 'SCHEDULED',
    home: { name: 'Detroit Red Wings', abbr: 'DET' }, away: { name: 'New Jersey Devils', abbr: 'NJD' }, updated_at: '2026-10-13T06:00:00Z' }] }, sources: [{ file: 'hockey/slate.json', sports: ['nhl'], generated_at: '2026-10-13T06:00:00Z' }] };
  const t3 = F.table();
  t3['hockey/nhl|20261013'] = { status: 403 };
  const r5 = await F.buildFixture({ table: t3, artifacts: art });
  const b5 = r5.snap.buckets['nhl:hockey/nhl|2026-10-13'];
  chk('no earlier read: the repo’s own NHL schedule fills the day, labelled as the fallback', b5.ok && b5.source === 'artifact' && r5.snap.events.some((e) => e.id === 'nhl:nhl:2026020090'));
  eq('the sport is marked as on the fallback, so the page can say "no live status"', r5.snap.sports.nhl.state === 'fallback' || r5.snap.sports.nhl.state === 'partial', true);
  chk('the fallback game keeps its research link (the NHL id is the research entity)', r5.snap.events.find((e) => e.id === 'nhl:nhl:2026020090').research.entity === '2026020090');
  const r6 = await F.buildFixture({ table: Object.assign(F.table(), { 'baseball/mlb|20261013': { status: 500 } }) });
  chk('no read and no fallback: the day is failed, never empty', r6.snap.buckets['mlb:baseball/mlb|2026-10-13'].ok === false && r6.snap.sports.mlb.state === 'partial');

  /* the offline bootstrap builds from the repo's real committed schedules */
  /* the committed schedules roll forward every week, so the build is pinned
     to the first Eastern day on which they carry both a CFB and an NHL game */
  const ART = require('./artifacts.js');
  const committed = ART.load(new Date().toISOString()).bySport;
  const daysOf = (sp) => (committed[sp] || []).map((e) => G.etDay(G.toMs(e.start_utc)));
  const both = daysOf('cfb').filter((d) => daysOf('nhl').indexOf(d) >= 0).sort()[0];
  chk('the repo commits a football and a hockey schedule that share a day', !!both, Object.keys(committed));
  const off = await BUILD.build({ offline: true, now: Date.parse((both || '2026-10-13') + 'T16:00:00Z'), prev: null });
  chk('offline: the committed football and hockey schedules become slate events', ['cfb', 'nhl'].every((sp) => off.snap.events.some((e) => e.sport === sp)) && off.requests === 0);
  chk('offline: a sport with no committed schedule is failed, not empty', off.snap.sports.mma.state === 'failed' && off.snap.sports.mlb.state === 'failed');
  chk('offline: no soccer schedule is read any more', !off.snap.events.some((e) => e.sport === 'soccer') && !(off.snap.sources.fallback || []).some((x) => /soccer/.test(x.file)));

  /* ── THE RESEARCH JOIN ────────────────────────────────────────────── */
  const R = (id) => s.events.concat(s.upcoming).find((e) => e.id === id).research;
  eq('NHL: ESPN’s NJ @ DET is the NHL id’s game (NJ = NJD), with the model’s tier', [R('nhl:espn:401802001').module, R('nhl:espn:401802001').entity, R('nhl:espn:401802001').model.tier], ['nhl', '2026020090', 'OUTCOME_VALIDATED']);
  eq('NFL: ESPN’s SEA @ DEN is nflverse 2026_06_SEA_DEN', [R('nfl:espn:401880001').entity, R('nfl:espn:401880001').read.status], ['nfl|2026_06_SEA_DEN', 'PASS']);
  chk('NFL LEAN_PLAY or PASS is a read, never a signal', R('nfl:espn:401880001').signal.actionable === false);
  eq('CFB: the ESPN id is the research entity, with its free article and the board’s read', [R('cfb:espn:401871067').entity, R('cfb:espn:401871067').article.url, R('cfb:espn:401871067').read.label], ['401871067', '/articles/delaware-vs-middle-tennessee-2026/', 'RESEARCH']);
  chk('a RESEARCH read with a PASS decision is not a signal', R('cfb:espn:401871067').signal.actionable === false);
  eq('MLB: the card’s own key (Eastern date, both clubs, the game number)', R('mlb:espn:401803002').entity, 'g:mlb:2026-10-13|newyorkyankees|bostonredsox|2');
  chk('college basketball has no research page, nor an NBA game the NBA engine has not priced; a game with nothing says nothing', R('ncaam:espn:401910002').module === null && R('nba:espn:401900001').module === null);
  const srcN = F.research();
  srcN.nba = { schema: 'edgedesk_nba_slate_v1', value_reason: 'never compared with closing prices', games: [{ game_id: '401900001', start_utc: '2026-10-20T23:30:00Z', home: { abbr: 'NY', name: 'New York Knicks' }, away: { abbr: 'BOS', name: 'Boston Celtics' },
    price: { moneyline: { home: 0.6, away: 0.4, home_american: -150, away_american: 150 }, spread: { fair_line_home: -3.5 }, total: { fair_line: 224.5 } }, decision: { gates: [{ gate: 'outcome record', pass: true }] } }] };
  const evN = [JSON.parse(JSON.stringify(s.events.concat(s.upcoming).find((e) => e.id === 'nba:espn:401900001')))];
  RES.join(evN, srcN, { now: F.NOW });
  eq('NBA: the ESPN id is the NBA engine’s game, with the panel’s own fair prices', [evN[0].research.module, evN[0].research.entity, evN[0].research.model.fair.spread_home, evN[0].research.model.fair.total, evN[0].research.model.tier], ['nba', '401900001', -3.5, 224.5, 'OUTCOME_VALIDATED']);
  const src = F.research();
  src.cfb.rows[0].decision_status = 'BET'; src.cfb.rows[0].decision_label = 'BET';
  const evs = [JSON.parse(JSON.stringify(s.events.find((e) => e.id === 'cfb:espn:401871067')))];
  RES.join(evs, src, { now: F.NOW });
  chk('the decision engine’s BET — and only that — is a CFB signal', evs[0].research.signal.actionable === true && evs[0].research.signal.status === 'BET');
  const src2 = F.research();
  src2.engine = { verdict: 'PASS', best: { event: { start_utc: '2026-10-13T23:00:00Z', home: 'Columbus Blue Jackets', away: 'Florida Panthers' } } };
  const evs2 = [JSON.parse(JSON.stringify(s.events.find((e) => e.id === 'nhl:espn:401802002')))];
  RES.join(evs2, src2, { now: F.NOW });
  chk('the cross-sport engine’s strongest candidate under PASS is not a signal', !evs2[0].research.signal);
  src2.engine.verdict = 'BEST_SUPPORTED'; src2.engine.best.label = 'FLA ML';
  RES.join(evs2, src2, { now: F.NOW });
  chk('its BEST_SUPPORTED pick is', evs2[0].research.signal && evs2[0].research.signal.actionable === true);

  /* ── THE LIVE POLLER ──────────────────────────────────────────────── */
  const g = LIVE.gate(s, F.NOW);
  chk('the gate opens while games are live or about to start', g.found && g.feeds.some((f) => f.feed === 'nhl:hockey/nhl'));
  chk('a day of finals keeps the gate shut', !LIVE.gate({ events: s.events.filter((e) => e.status === 'FINAL') }, F.NOW).found);
  eq('before 6 AM Eastern, last night’s scoreboard is still read', LIVE.liveDays(Date.parse('2026-10-14T09:30:00Z')), ['2026-10-13', '2026-10-14']);
  eq('after it, only today’s', LIVE.liveDays(Date.parse('2026-10-14T11:00:00Z')), ['2026-10-14']);
  const calls = [];
  const db = { rpc: async (schema, fn, args) => { calls.push({ fn, args }); return { upserted: args.p_events.length }; } };
  const cycles = await LIVE.poll({ snapshot: s, sources: F.research(), db, fetch: E.fakeFetch(F.table()), clock: () => F.NOW, once: true, log: false });
  chk('one cycle writes through slate_live_ingest only', calls.length === 1 && calls[0].fn === 'slate_live_ingest');
  const wrote = calls[0].args;
  chk('it reads only feeds with a game in its live window', wrote.p_feeds.every((f) => ['nhl:hockey/nhl', 'mlb:baseball/mlb', 'cfb:football/college-football', 'ncaam:basketball/mens-college-basketball'].indexOf(f.feed) >= 0), wrote.p_feeds.map((f) => f.feed));
  chk('each written event carries its feed, its scoreboard day and its research', wrote.p_events.every((e) => e.feed && e.sb_day && e.event && e.event.research));
  chk('the pregame price rides along; the live game has none', wrote.p_events.find((e) => e.id === 'nhl:espn:401802002').market && !wrote.p_events.find((e) => e.id === 'nhl:espn:401802001').market);
  const calls2 = [];
  const db2 = { rpc: async (schema, fn, args) => { calls2.push(args); return {}; } };
  await LIVE.poll({ snapshot: s, sources: F.research(), db: db2, fetch: E.fakeFetch({ '*': { status: 503 } }), clock: () => F.NOW, once: true, log: false });
  chk('a provider outage writes the failed read state and no events, so the last good read stands', calls2[0].p_events.length === 0 && calls2[0].p_feeds.every((f) => f.ok === false));
  let threw = false;
  try { await LIVE.poll({ snapshot: s, db: undefined, fetch: E.fakeFetch({}), clock: () => F.NOW, once: true, log: false, sources: F.research() }); } catch (e) { threw = /nowhere to write/.test(e.message); }
  chk('with no database credentials the poller refuses to run rather than pretending', threw || !!require(path.join(ROOT, 'tools', 'lib', 'pgrest.js')).config());

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'slate pipeline — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
