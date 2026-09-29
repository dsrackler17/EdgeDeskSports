#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS — freshness, executability, recovery and health, case by case.

   The one rule (lib/edgedesk_props.js FRESHNESS / isExecutableQuote /
   priceStatus / systemHealth / injuryFreshness), the capture's recovery
   (football/props/capture.js: cadence tiers, retry with back-off and jitter,
   a 429's wait, partial answers, market closures, manual refresh, data-quality
   guards), and the health record (football/props/health_sync.js):

     1  fresh quote              11 manual refresh
     2  20-minute aging quote     12 retry recovery
     3  45-minute stale quote     13 game started
     4  3-hour expired quote      14 market closed
     5  missing quote             15 only Over available
     6  one book stale, one fresh 16 only Under available
     7  one game stale, one fresh 17 model exists, price does not
     8  provider timeout          18 historical quote retained
     9  rate limit                19 stale quote excluded from EV
    10  partial API response      20 a fresh replacement restores the decision

   Run: node tools/props/props_freshness.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
require(path.join(ROOT, 'lib', 'edgedesk_vocab.js'));
require(path.join(ROOT, 'lib', 'edgedesk_market.js'));
require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));
const C = require(path.join(ROOT, 'football', 'props', 'config.js'));
const CAP = require(path.join(ROOT, 'football', 'props', 'capture.js'));
const HS = require(path.join(ROOT, 'football', 'props', 'health_sync.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('— ' + t); }

const NOW = Date.parse('2026-10-01T18:00:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const Q = (book, line, side, american, min, alt) => ({ book, line, side, american, captured_at: at(min == null ? 5 : min), quoted_at: at((min == null ? 5 : min) + 2), alt: !!alt });
const KICK = new Date(NOW + 30 * 3600e3).toISOString();
const RUSH = { family: 'gcomp', n: { family: 'negbin', mean: 20, size: 22 }, a: 1.88, theta: 4.95, shift: 4 };   /* mean ≈ 106 */
const prop = (o) => Object.assign({ id: 'nfl|g|p|rush_yds', market: 'rush_yds', kickoff: KICK, game_status: 'scheduled', mapped: true, player_status: { status: null }, report_on_file: true,
  projection: { dist: RUSH, sample_games: 6, prior_games: 10, role_stability: 0.85, completeness: 0.9 }, quotes: [] }, o || {});
const two = (min) => [Q('dk', 84.5, 'over', -105, min), Q('dk', 84.5, 'under', -115, min), Q('fd', 84.5, 'over', -110, min), Q('fd', 84.5, 'under', -110, min), Q('mgm', 84.5, 'over', -112, min), Q('mgm', 84.5, 'under', -108, min)];
const OPTS = { now: NOW };
const X = (min, ctx) => E.isExecutableQuote(Q('dk', 84.5, 'over', -105, min), Object.assign({ now: NOW, kickoff: KICK }, ctx || {}));

(async function main() {
  /* ------------------------------------------------------------ the rule */
  section('the one rule: quote age states and executability (1-4)');
  let x = X(5);
  chk('1 · a 5-minute quote is FRESH and executable', x.state === 'FRESH' && x.executable && x.reason === null, x);
  x = X(20);
  chk('2 · a 20-minute quote is AGING and still executable', x.state === 'AGING' && x.executable, x);
  x = X(45);
  chk('3 · a 45-minute quote is STALE and NOT executable', x.state === 'STALE' && !x.executable && x.reason === 'STALE' && /30-minute execution window/.test(x.text), x);
  x = X(180);
  chk('4 · a 3-hour quote is EXPIRED and NOT executable', x.state === 'EXPIRED' && !x.executable && x.reason === 'EXPIRED' && /3 h old/.test(x.text), x);
  chk('the thresholds are configurable, and the boundaries are inclusive', X(15).state === 'FRESH' && X(30).executable && !X(30.5).executable && X(90).state === 'STALE' && X(91).state === 'EXPIRED');
  const loose = E.freshCfg({ executable_max_minutes: 60 });
  chk('a caller\'s override (a board\'s own thresholds) moves the window without touching the default', E.isExecutableQuote(Q('dk', 84.5, 'over', -105, 45), { now: NOW, freshness: loose }).executable && !X(45).executable);
  chk('a capture time in the future is a clock fault, never fresh', X(-20).reason === 'CLOCK_FAULT');
  chk('a provider stamp ahead of the capture is a clock fault', E.isExecutableQuote({ american: -110, line: 84.5, captured_at: at(5), quoted_at: at(-10) }, { now: NOW }).reason === 'CLOCK_FAULT');
  chk('no capture time: UNKNOWN_TIME, never assumed fresh', E.isExecutableQuote({ american: -110, line: 84.5 }, { now: NOW }).reason === 'UNKNOWN_TIME');
  chk('an impossible price or line is never executable', E.isExecutableQuote({ american: 50, line: 84.5, captured_at: at(1) }, { now: NOW }).reason === 'INVALID_PRICE' && E.isExecutableQuote({ american: -110, line: 84.3, captured_at: at(1) }, { now: NOW }).reason === 'INVALID_LINE');
  chk('a suspended book is not executable, however fresh', X(1, { provider_status: 'suspended' }).reason === 'BOOK_SUSPENDED');
  chk('CONFIG only aliases FRESHNESS (one home for the numbers)', E.CONFIG.max_quote_age_minutes === E.FRESHNESS.executable_max_minutes && E.CONFIG.fresh_minutes === E.FRESHNESS.quote.fresh_minutes);
  chk('freshnessOf (every older reader) IS quoteFreshness', E.freshnessOf(Q('dk', 1, 'over', -110, 45), NOW).state === 'STALE' && E.freshnessOf(Q('dk', 1, 'over', -110, 200), NOW).state === 'EXPIRED');

  /* ------------------------------------------------------------ evaluate */
  section('decisions: stale prices never decide, research stays (5, 6, 17, 19, 20)');
  let ev = E.evaluate(prop(), OPTS);
  chk('5 · a missing quote: NO_MARKET, labelled, nothing priced', ev.decision === 'NO_DECISION' && ev.code === 'NO_MARKET' && ev.decision_label === 'NO MARKET' && !ev.candidate, [ev.code, ev.decision_label]);
  ev = E.evaluate(prop({ event: { polled_ok_at: null } }), OPTS);
  chk('5 · …and before its game was ever price-checked: NO_CURRENT_QUOTE, a WAIT, not "no market"', ev.code === 'NO_CURRENT_QUOTE' && ev.decision_label === 'WAIT FOR PRICE' && ev.waiting_for_price, [ev.code]);
  chk('17 · the model exists and the price does not: projection, fair line and confidence are all still there', ev.raw && ev.raw.mean > 90 && ev.informed && isFinite(ev.informed.median) && ev.confidence && ev.confidence.score > 0 && ev.units === 0);
  const mixed = [Q('dk', 84.5, 'over', 120, 200), Q('dk', 84.5, 'under', -150, 200), Q('fd', 84.5, 'over', -110, 5), Q('fd', 84.5, 'under', -110, 5)];
  ev = E.evaluate(prop({ quotes: mixed }), OPTS);
  chk('6 · one book stale and one fresh: only the fresh book prices — the stale +120 is never the best price', ev.candidate && ev.candidate.book === 'fd' && ev.consensus.n_books === 1 && ev.books.length === 2 && ev.best_price.over.book === 'fd', [ev.candidate, ev.best_price]);
  chk('6 · …and the decision is made on the fresh book', ev.decision !== 'NO_DECISION', ev.decision);
  ev = E.evaluate(prop({ quotes: two(200) }), OPTS);
  chk('19 · only stale quotes: no EV, no edge, no stake, no candidate — WAIT FOR PRICE', ev.decision === 'NO_DECISION' && ev.code === 'STALE_QUOTE' && ev.decision_label === 'WAIT FOR PRICE' && !ev.candidate && !ev.best_value && ev.units === 0 && ev.ladder.length === 0, [ev.decision, ev.code]);
  chk('19 · …the price status says why, and how old', ev.price_status.state === 'STALE_QUOTE' && ev.price_status.freshness === 'EXPIRED' && ev.price_status.age_minutes === 200, ev.price_status);
  chk('19 · …the model\'s view at the last line stays, as reference (projection, fair odds)', ev.at_reference && ev.at_reference.line === 84.5 && ev.at_reference.reference === true && ev.at_reference.fair_over != null && ev.raw.mean > 90, ev.at_reference);
  chk('19 · …the model is not blended with the expired market', ev.anchored === false && ev.informed.mean === ev.raw.mean);
  chk('19 · …the last prices are kept for reference with book and age', ev.last_seen && ev.last_seen.best_over.book === 'dk' && ev.last_seen.best_over.american === -105 && ev.last_seen.best_over.freshness === 'EXPIRED', ev.last_seen);
  const cp = E.compact(ev);
  chk('19 · …and the board\'s compact row carries all of it (ps, ref, ls, wp)', cp.ps && cp.ps[0] === 'STALE_QUOTE' && cp.ref && cp.ref[0] === 84.5 && cp.ls.length === 9 && cp.ls[4] === 'dk' && cp.wp === 1 && cp.d === 'NO_DECISION', cp);
  const staleBest = two(5).concat([Q('br', 84.5, 'over', 150, 60), Q('br', 84.5, 'under', -190, 60)]);
  ev = E.evaluate(prop({ quotes: staleBest }), OPTS);
  chk('19 · a stale +150 beside fresh −105: the stale one prices no EV and is never the candidate', ev.candidate.book === 'dk' && ev.ladder.every((r) => r.book !== 'br') && ev.best_ev.over.book !== 'br', [ev.candidate, ev.best_ev.over]);
  ev = E.evaluate(prop({ quotes: two(40) }), OPTS);
  const before = ev.decision;
  ev = E.evaluate(prop({ quotes: two(40).concat(two(2)) }), OPTS);
  chk('20 · a fresh replacement restores the decision automatically', before === 'NO_DECISION' && ev.decision === 'BET' && ev.candidate.captured_at === at(2), [before, ev.decision]);

  section('one side, a started game, a closed market (13-16)');
  ev = E.evaluate(prop({ quotes: [Q('dk', 97.5, 'over', -105), Q('fd', 97.5, 'over', -110)] }), OPTS);
  chk('15 · only the Over offered: ONE_SIDED (over), priced, capped at LEAN (no no-vig anchor)', ev.price_status.state === 'ONE_SIDED' && ev.price_status.side === 'over' && ['LEAN', 'WATCH', 'PASS'].indexOf(ev.decision) >= 0 && ev.units === 0 && ev.consensus.novig_over === null, [ev.price_status, ev.decision]);
  ev = E.evaluate(prop({ quotes: [Q('dk', 115.5, 'under', -105), Q('fd', 115.5, 'under', -110)] }), OPTS);
  chk('16 · only the Under offered: ONE_SIDED (under), never above LEAN', ev.price_status.state === 'ONE_SIDED' && ev.price_status.side === 'under' && ev.decision !== 'BET', [ev.price_status, ev.decision]);
  ev = E.evaluate(prop({ quotes: two(2), kickoff: at(1) }), OPTS);
  chk('13 · a game started a minute ago: GAME STARTED, nothing executable however fresh', ev.decision === 'NO_DECISION' && ev.code === 'GAME_STARTED' && ev.decision_label === 'GAME STARTED' && ev.price_status.state === 'GAME_STARTED' && !ev.candidate);
  chk('13 · …pregame polling stops at kickoff (no cadence for a started game)', E.cadenceFor(-0.1) === null && E.cadenceFor(0) === null);
  ev = E.evaluate(prop({ quotes: [], market_status: 'closed', market_closed_at: at(20) }), OPTS);
  chk('14 · a market the books pulled: MARKET CLOSED, not "no market"', ev.code === 'MARKET_CLOSED' && ev.decision_label === 'MARKET CLOSED' && ev.price_status.state === 'MARKET_CLOSED', [ev.code]);
  ev = E.evaluate(prop({ quotes: two(200), event: { polled_ok_at: at(200), attempted_at: at(3), failed: true, error: 'HTTP 500' } }), OPTS);
  chk('the last check failed and nothing is current: PROVIDER_FAILURE (a WAIT), with the error', ev.code === 'PROVIDER_FAILURE' && ev.price_status.error === 'HTTP 500' && ev.waiting_for_price && ev.decision_label === 'WAIT FOR PRICE', [ev.code, ev.price_status]);
  ev = E.evaluate(prop({ quotes: two(10), event: { polled_ok_at: at(10), attempted_at: at(3), failed: true } }), OPTS);
  chk('…but a quote still inside the window stays executable after a later failed check', ev.decision === 'BET' && ev.candidate, ev.decision);

  /* ------------------------------------------------------------ injuries */
  section('injury report freshness (15)');
  const inj = (h) => E.injuryFreshness(new Date(NOW - h * 3600e3).toISOString(), NOW);
  chk('a 3-hour-old report is CURRENT, a 12-hour one AGING, a 2-day one STALE', inj(3).state === 'CURRENT' && inj(12).state === 'AGING' && inj(48).state === 'STALE' && inj(48).factor < inj(12).factor && inj(12).factor < 1);
  chk('no report published: NOT_PUBLISHED, never "current"', E.injuryFreshness(null, NOW).state === 'NOT_PUBLISHED' && E.injuryFreshness(at(10), NOW, null, false).state === 'NOT_PUBLISHED');
  const fresh = E.evaluate(prop({ quotes: two(2), injury_as_of: new Date(NOW - 2 * 3600e3).toISOString() }), OPTS);
  const old = E.evaluate(prop({ quotes: two(2), injury_as_of: new Date(NOW - 60 * 3600e3).toISOString() }), OPTS);
  chk('a STALE injury report lowers confidence, says so, and is labelled', old.confidence.score < fresh.confidence.score && old.injury_freshness.state === 'STALE' && old.warnings.indexOf('INJURY_DATA_STALE') >= 0 && old.confidence.notes.some((n) => /injury report is .*STALE/.test(n)), [fresh.confidence.score, old.confidence.score]);
  chk('…and it is open uncertainty on the stake (never sized as if current)', old.decision !== 'BET' || old.units <= E.CONFIG.caps.material_units, [old.decision, old.units]);

  /* ------------------------------------------------------------ cadence */
  section('capture cadence and back-off (14 FUTURE GAME PRIORITY)');
  chk('cadence by hours to kickoff: 15 / 30 / 60 / 120 / 360 minutes', E.cadenceFor(1) === 15 && E.cadenceFor(5) === 30 && E.cadenceFor(20) === 60 && E.cadenceFor(40) === 120 && E.cadenceFor(80) === 360);
  chk('PROPS_CADENCE overrides it', (() => { const c = C.parseCadence('2:10,12:45,*:240'); return E.cadenceFor(1, { cadence: c }) === 10 && E.cadenceFor(10, { cadence: c }) === 45 && E.cadenceFor(50, { cadence: c }) === 240; })());
  chk('a malformed PROPS_CADENCE is ignored, never half-applied', C.parseCadence('2:ten,4:30') === null && C.freshnessFromEnv({ PROPS_CADENCE: 'nonsense' }) === null);
  const d1 = E.retryDelay(1, 0.5), d2 = E.retryDelay(2, 0.5), d3 = E.retryDelay(3, 0.5), d9 = E.retryDelay(9, 0.5);
  chk('retry back-off doubles (5, 10, 20 …) and is capped (60)', d1 === 5 && d2 === 10 && d3 === 20 && d9 === 60, [d1, d2, d3, d9]);
  chk('…with ± jitter so failures do not retry in lockstep', E.retryDelay(1, 0) === 4 && E.retryDelay(1, 1) === 6);

  /* ------------------------------------------------------------ health */
  section('pipeline health (10 SYSTEM-LEVEL STATUS)');
  const ev3 = (lastMin, failed, kickH) => ({ id: 'e' + Math.random(), kickoff: new Date(NOW + (kickH || 3) * 3600e3).toISOString(), polled_ok_at: lastMin == null ? null : at(lastMin), failed: !!failed });
  const cap = (o) => Object.assign({ enabled: true, status: 'SUCCESS', last_attempt_at: at(5), last_success_at: at(5), window_h: 96, next_due_at: new Date(NOW + 10 * 60000).toISOString() }, o || {});
  let H = E.systemHealth({ now: NOW, capture: cap(), events: [ev3(10), ev3(20), ev3(5)], books: { current: ['dk', 'fd'], delayed: [] } });
  chk('every game on its cadence: HEALTHY', H.state === 'HEALTHY' && H.share === 1, H);
  H = E.systemHealth({ now: NOW, capture: cap({ status: 'PARTIAL' }), events: [ev3(10), ev3(20), ev3(5, true)], books: { current: ['dk', 'fd', 'mgm'], delayed: ['br'] } });
  chk('a book delayed and a game failed, most current: DEGRADED — never the whole system stale', H.state === 'DEGRADED' && /3\/4 books current/.test(H.text), H);
  H = E.systemHealth({ now: NOW, capture: cap(), events: [ev3(120), ev3(150), ev3(10)] });
  chk('most games past their target: DELAYED', H.state === 'DELAYED' && H.reason === 'PRICES_BEHIND', H);
  H = E.systemHealth({ now: NOW, capture: cap({ next_due_at: at(120), last_attempt_at: at(200) }), events: [ev3(200), ev3(200)] });
  chk('nothing has tried since it was due two hours ago: OUTAGE (the scheduler is silent)', H.state === 'OUTAGE' && H.reason === 'SCHEDULER_SILENT' && /overdue/.test(H.text), H);
  H = E.systemHealth({ now: NOW, capture: cap({ status: 'ERROR', reason: 'PROVIDER_REFUSED', rate_limited_until: new Date(NOW + 600e3).toISOString() }), events: [ev3(200), ev3(200)] });
  chk('the provider refusing (429) with prices behind: OUTAGE, until when', H.state === 'OUTAGE' && H.reason === 'PROVIDER_REFUSED' && H.rate_limited_until, H);
  H = E.systemHealth({ now: NOW, capture: cap({ enabled: false, reason: 'PROPS_CAPTURE_DISABLED' }), events: [ev3(10)] });
  chk('capture switched off: OUTAGE (CAPTURE_OFF), said plainly', H.state === 'OUTAGE' && H.reason === 'CAPTURE_OFF');
  H = E.systemHealth({ now: NOW, capture: cap(), events: [ev3(300, false, 80)] });
  chk('a game 80 h out polled 5 h ago is on its 6-hour clock: HEALTHY (and its price is still not executable)', H.state === 'HEALTHY' && !X(300).executable);
  H = E.systemHealth({ now: NOW, capture: cap(), events: [] });
  chk('no game in the window: HEALTHY, said so', H.state === 'HEALTHY' && H.reason === 'NO_EVENTS_IN_WINDOW');

  /* ------------------------------------------------------------ capture */
  section('capture recovery (7-12)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-fresh-'));
  let n = 0;
  const paths = () => { n++; const p = C.leaguePaths('nfl', 2026), o = {}; Object.keys(p).forEach((k) => { o[k] = p[k].replace(C.DIR, path.join(tmp, 'r' + n)); }); return o; };
  const EVENTS = [
    { id: 'evA', commence_time: new Date(NOW + 3 * 3600e3).toISOString(), home_team: 'Cleveland Browns', away_team: 'Pittsburgh Steelers' },
    { id: 'evB', commence_time: new Date(NOW + 5 * 3600e3).toISOString(), home_team: 'Washington Commanders', away_team: 'Indianapolis Colts' }
  ];
  const oddsFor = (id, books, lineShift) => ({ id, bookmakers: books.map((b) => ({ key: b, title: b, last_update: new Date(NOW).toISOString(), markets: [
    { key: 'player_rush_yds', last_update: new Date(NOW).toISOString(), outcomes: [
      { name: 'Over', description: 'Nick Chubb', price: -110, point: 64.5 + (lineShift || 0) }, { name: 'Under', description: 'Nick Chubb', price: -110, point: 64.5 + (lineShift || 0) }] },
    { key: 'player_reception_yds', last_update: new Date(NOW).toISOString(), outcomes: [
      { name: 'Over', description: 'Jerry Jeudy', price: -115, point: 55.5 }, { name: 'Under', description: 'Jerry Jeudy', price: -105, point: 55.5 }] }] })) });
  const base = (P, extra) => Object.assign({ key: 'k', league: 'nfl', paths: P, window_h: 96, max_events: 8, min_remaining: 50, max_credits_run: 500, groups: ['core'], low_credits: 0, critical_credits: 0, retry_delay_ms: 0, sleep: async () => {}, random: () => 0.5 }, extra);
  const getterOf = (fn) => { const seen = []; const g = async (url) => { seen.push(url); if (/\/events\?/.test(url)) return { status: 200, body: EVENTS, remaining: 5000, last: 0 }; const id = /events\/([^/]+)\/odds/.exec(url)[1]; return fn(id, seen); }; g.seen = seen; return g; };

  /* 7 · one game fails, the other is committed */
  let P = paths();
  let g = getterOf(async (id) => { if (id === 'evB') throw Object.assign(new Error('HTTP 500'), { status: 500, body: 'upstream' }); return { status: 200, body: oddsFor(id, ['draftkings', 'fanduel']), remaining: 4990, last: 2 }; });
  let s = await CAP.run(base(P, { now: NOW, getJson: g }));
  let feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  chk('7 · PIT @ CLE captured while IND @ WAS failed: PIT @ CLE is committed and current', s.status === 'PARTIAL' && feed.events.evA && feed.events.evA.n_quotes === 8 && !feed.events.evB, [s.status, Object.keys(feed.events)]);
  chk('7 · …the failed game carries its own record and retry time; the good one is clean', s.events_state.evB.failures === 1 && s.events_state.evB.next_retry_at === new Date(NOW + 5 * 60e3).toISOString() && s.events_state.evA.failures === 0 && s.events_state.evA.polled_ok_at === new Date(NOW).toISOString(), s.events_state);
  chk('7 · …a 5xx was retried once inside the run before it failed', g.seen.filter((u) => /evB/.test(u)).length === 2);
  chk('7 · …health: DEGRADED, not stale (one game failed, the other is current)', s.health.state === 'DEGRADED' && s.health.failed_events === 1, s.health);
  chk('7 · …the scheduler is told the failed game is due at its retry, sooner than its cadence', s.next_due_at === s.events_state.evB.next_retry_at, [s.next_due_at]);

  /* 12 · recovery: the failed game backs off, then recovers on its own */
  let s2 = await CAP.run(base(P, { now: NOW + 2 * 60e3, getJson: g }));
  chk('12 · before its back-off has passed nothing is re-asked', s2.status === null && /no event due/.test(s2.skipped), s2.skipped);
  s2 = await CAP.run(base(P, { now: NOW + 5 * 60e3, getJson: g }));
  chk('12 · at its retry time it is asked again, fails again, and backs off longer (10 min)', s2.events_state.evB.failures === 2 && s2.events_state.evB.next_retry_at === new Date(NOW + 15 * 60e3).toISOString() && s2.events_checked === 1, s2.events_state.evB);
  const ok = getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings', 'fanduel']), remaining: 4980, last: 2 }));
  const s3 = await CAP.run(base(P, { now: NOW + 15 * 60e3, getJson: ok }));
  feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  chk('12 · when the provider answers again it recovers by itself: no failures, current prices, HEALTHY', s3.events_state.evB.failures === 0 && s3.events_state.evB.polled_ok_at && feed.events.evB && feed.events.evB.n_quotes === 8 && s3.health.state === 'HEALTHY' && s3.provider.consecutive_failures === 0, [s3.events_state.evB, s3.health.state]);

  /* 8 · a timeout */
  P = paths();
  g = getterOf(async (id) => { if (id === 'evA') throw Object.assign(new Error('TIMEOUT after 30000 ms'), { status: 'timeout', body: 'timed out' }); return { status: 200, body: oddsFor(id, ['draftkings']), remaining: 4990, last: 2 }; });
  s = await CAP.run(base(P, { now: NOW, getJson: g }));
  chk('8 · a provider timeout is retried once, then recorded on that game alone; the other is captured', g.seen.filter((u) => /evA/.test(u)).length === 2 && s.events_state.evA.last_http === 'timeout' && s.events_polled === 1 && s.status === 'PARTIAL', [s.status, s.events_state.evA]);

  /* 9 · a 429 */
  P = paths();
  g = getterOf(async () => { throw Object.assign(new Error('HTTP 429'), { status: 429, body: 'quota', retry_after: 1200 }); });
  s = await CAP.run(base(P, { now: NOW, getJson: g }));
  chk('9 · a 429 stops the run at once and records how long to wait (Retry-After)', s.status === 'ERROR' && s.reason === 'PROVIDER_REFUSED' && s.provider.rate_limited_until === new Date(NOW + 1200e3).toISOString() && g.seen.filter((u) => /\/odds\?/.test(u)).length === 1, [s.status, s.provider]);
  chk('9 · …health reads OUTAGE (the provider is refusing), and the next poll is not before the wait ends', s.health.state === 'OUTAGE' && s.health.reason === 'PROVIDER_REFUSED' && Date.parse(s.next_due_at) >= NOW + 1200e3, [s.health.state, s.next_due_at]);
  const gNo = getterOf(async () => { throw new Error('must not be called'); });
  s2 = await CAP.run(base(P, { now: NOW + 5 * 60e3, getJson: gNo, force: true }));
  chk('9 · inside the wait nothing is asked — a manual refresh included — and it says until when', s2.reason === 'RATE_LIMITED' && /rate-limited/.test(s2.skipped) && gNo.seen.length === 0, s2);
  s2 = await CAP.run(base(P, { now: NOW + 21 * 60e3, getJson: ok }));
  chk('9 · after the wait it resumes on its own', s2.status === 'SUCCESS' && !s2.provider.rate_limited_until, [s2.status, s2.provider]);

  /* 10 · a partial answer: one book missing */
  P = paths();
  s = await CAP.run(base(P, { now: NOW, getJson: getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings', 'fanduel']), remaining: 4990, last: 2 })) }));
  s2 = await CAP.run(base(P, { now: NOW + 35 * 60e3, getJson: getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings']), remaining: 4980, last: 2 })) }));
  feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  const qa = feed.events.evA.quotes.map(CAP.unpackQuote);
  const fdQ = qa.filter((q) => q.book === 'fanduel'), dkQ = qa.filter((q) => q.book === 'draftkings');
  chk('10 · a book missing from the answer keeps its quotes at their OWN capture time (never re-stamped)', fdQ.length === 4 && fdQ.every((q) => q.captured_at === new Date(NOW).toISOString()) && feed.events.evA.books_missing[0] === 'fanduel', fdQ.map((q) => q.captured_at));
  chk('10 · …the book that answered is current', dkQ.every((q) => q.captured_at === new Date(NOW + 35 * 60e3).toISOString()));
  chk('10 · …and the missing book\'s old price can never be executable', fdQ.every((q) => !E.isExecutableQuote(q, { now: NOW + 35 * 60e3 }).executable) && dkQ.every((q) => E.isExecutableQuote(q, { now: NOW + 35 * 60e3 }).executable));
  chk('10 · …no market is marked closed on a partial answer', !feed.events.evA.closed);
  await CAP.run(base(P, { now: NOW + 100 * 60e3, getJson: getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings']), remaining: 4970, last: 2 })) }));
  feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  chk('10 · …once past the stale band the missing book drops out of the CURRENT listing', feed.events.evA.quotes.map(CAP.unpackQuote).every((q) => q.book === 'draftkings'));

  /* 14 · a market the books pulled */
  P = paths();
  await CAP.run(base(P, { now: NOW, getJson: getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings']), remaining: 4990, last: 2 })) }));
  const pulled = (id) => { const o = oddsFor(id, ['draftkings']); o.bookmakers[0].markets = o.bookmakers[0].markets.slice(0, 1); return o; };
  await CAP.run(base(P, { now: NOW + 35 * 60e3, getJson: getterOf(async (id) => ({ status: 200, body: pulled(id), remaining: 4980, last: 2 })) }));
  feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  chk('14 · a market the answering book stopped dealing is recorded CLOSED, with when', feed.events.evA.closed && feed.events.evA.closed[E.normName('Jerry Jeudy') + '|rec_yds'] === new Date(NOW + 35 * 60e3).toISOString(), feed.events.evA.closed);
  /* an empty answer where there were prices is not believed at once */
  const empty = (id) => ({ id, bookmakers: [] });
  s = await CAP.run(base(P, { now: NOW + 70 * 60e3, getJson: getterOf(async (id) => ({ status: 200, body: empty(id), remaining: 4970, last: 0 })) }));
  feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  chk('an empty answer where the last poll had prices is kept (not a wipe) and retried soon', s.events_suspect_empty === 2 && feed.events.evA.n_quotes > 0 && s.events_state.evA.failures === 1 && s.status === 'NO_MARKETS' && s.reason === 'SUSPECT_EMPTY_ANSWER', [s.status, s.reason, s.events_suspect_empty]);
  s = await CAP.run(base(P, { now: NOW + 76 * 60e3, getJson: getterOf(async (id) => ({ status: 200, body: empty(id), remaining: 4970, last: 0 })) }));
  feed = JSON.parse(fs.readFileSync(P.quotes, 'utf8'));
  chk('…a second empty answer is believed: every market recorded CLOSED', feed.events.evA.n_quotes === 0 && Object.keys(feed.events.evA.closed || {}).length === 2, feed.events.evA);

  /* 11 · manual refresh */
  P = paths();
  await CAP.run(base(P, { now: NOW, getJson: ok }));
  const gm = getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings', 'fanduel']), remaining: 4980, last: 2 }));
  s = await CAP.run(base(P, { now: NOW + 5 * 60e3, getJson: gm, force: true }));
  chk('11 · a manual refresh five minutes after a capture re-buys nothing, and says so', s.status === null && /manual refresh/.test(s.skipped) && gm.seen.filter((u) => /\/odds\?/.test(u)).length === 0, s.skipped);
  s = await CAP.run(base(P, { now: NOW + 12 * 60e3, getJson: gm, force: true, only_events: ['evB'], trigger: 'manual_refresh', refresh_request_id: 'req-1' }));
  chk('11 · twelve minutes on it captures now — inside the game\'s own 30-minute clock — only the games asked', s.events_polled === 1 && gm.seen.some((u) => /evB/.test(u)) && !gm.seen.some((u) => /events\/evA\/odds/.test(u)) && s.run.refresh_request_id === 'req-1' && s.run.manual === true, [s.events_polled, s.run]);

  /* credit pacing */
  P = paths();
  const far = [{ id: 'far', commence_time: new Date(NOW + 30 * 3600e3).toISOString(), home_team: 'A', away_team: 'B' }, { id: 'near', commence_time: new Date(NOW + 2 * 3600e3).toISOString(), home_team: 'C', away_team: 'D' }];
  const gp = async (url) => (/\/events\?/.test(url) ? { status: 200, body: far, remaining: 1000, last: 0 } : { status: 200, body: { id: /events\/far/.test(url) ? 'far' : 'near', bookmakers: [] }, remaining: 990, last: 0 });
  s = await CAP.run(base(P, { now: NOW, getJson: gp, low_credits: 5000, critical_credits: 1500 }));
  chk('credits nearly gone: only games inside six hours are polled, and the state says why', s.events_polled === 1 && s.event_ids[0] === 'near' && /only games inside six hours/.test(s.pacing.reason), [s.event_ids, s.pacing]);

  /* 18 · history retained */
  P = paths();
  await CAP.run(base(P, { now: NOW, getJson: ok }));
  const moved = getterOf(async (id) => ({ status: 200, body: oddsFor(id, ['draftkings', 'fanduel'], 2), remaining: 4980, last: 2 }));
  await CAP.run(base(P, { now: NOW + 1 * 3600e3, getJson: moved }));
  const lines = JSON.parse(fs.readFileSync(P.lines, 'utf8'));
  const series = lines.events.evA.props[E.normName('Nick Chubb') + '|rush_yds'].books.draftkings.main;
  chk('18 · line movement is kept: the open and the move, after both quotes have long expired', series.length === 2 && series[0][1] === 64.5 && series[1][1] === 66.5, series);
  await CAP.run(base(P, { now: NOW + 9 * 3600e3, getJson: ok }));
  const closes = fs.existsSync(P.closes) ? fs.readFileSync(P.closes, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  chk('18 · a game past kickoff moves its whole series to the append-only closes (CLV, backtests) — never deleted', closes.some((c) => c.event_id === 'evA' && c.props && c.props[E.normName('Nick Chubb') + '|rush_yds']), closes.map((c) => c.event_id));

  /* ------------------------------------------------------------ quality */
  section('data-quality guards (13 PLAYER PROP DATA QUALITY)');
  const bad = CAP.parseEventProps({ id: 'q', bookmakers: [{ key: 'dk', title: 'DK', markets: [
    { key: 'player_rush_yds', last_update: new Date(NOW).toISOString(), outcomes: [
      { name: 'Over', description: 'Cleveland Browns D/ST', price: -110, point: 0.5 },
      { name: 'Over', description: 'A Back', price: -110, point: 950.5 },
      { name: 'Over', description: 'B Back', price: -110, point: 60.5 }, { name: 'Over', description: 'B Back', price: 120, point: 60.5 },
      { name: 'Over', description: 'C Back', price: -110, point: 60.5 }, { name: 'Over', description: 'C Back', price: -110, point: 60.5 }] },
    { key: 'player_rush_yds_alternate', last_update: new Date(NOW).toISOString(), outcomes: [
      { name: 'Over', description: 'D Back', price: 200, point: 40.5 }, { name: 'Over', description: 'D Back', price: -300, point: 80.5 }] },
    { key: 'player_reception_yds', last_update: new Date(NOW + 3600e3).toISOString(), outcomes: [{ name: 'Over', description: 'E End', price: -110, point: 50.5 }] }] }] }, new Date(NOW).toISOString());
  chk('a team / defense entity in a player market is refused', bad.refused['team or defense entity, not a player'] === 1, bad.refused);
  chk('an obviously broken stat line (950.5 rushing yards) is refused', bad.refused['line outside the sane range for rush_yds'] === 1);
  chk('two different prices for one outcome are BOTH refused — never averaged, never guessed', bad.refused['conflicting duplicate outcome'] === 2 && !bad.quotes.some((q) => q.player_name === 'B Back'), bad.refused);
  chk('the same price twice keeps one (a duplicated sportsbook quote)', bad.refused['duplicate outcome'] === 1 && bad.quotes.filter((q) => q.player_name === 'C Back').length === 1);
  chk('a ladder running the wrong way (reversed sides) is refused', bad.refused['ladder out of order (reversed sides?)'] === 2 && !bad.quotes.some((q) => q.player_name === 'D Back'), bad.refused);
  chk('a provider stamp in the future of the capture is refused', bad.refused['provider timestamp in the future'] === 1 && !bad.quotes.some((q) => q.player_name === 'E End'));
  P = paths();
  s = await CAP.run(base(P, { now: NOW, getJson: getterOf(async (id) => ({ status: 200, body: oddsFor(id === 'evA' ? 'someone-else' : id, ['draftkings']), remaining: 4990, last: 2 })) }));
  chk('an answer for a different event id than asked is that game\'s failure, never filed under it', s.events_state.evA.failures === 1 && /event id mismatch|answered for/.test(s.events_state.evA.last_error) && !JSON.parse(fs.readFileSync(P.quotes, 'utf8')).events.evA, s.events_state.evA);

  /* ------------------------------------------------------------ the record */
  section('the health record (9 OBSERVABILITY) and the refresh result');
  const st = JSON.parse(fs.readFileSync(P.capture_state, 'utf8'));
  const rr = HS.runRow({ league: 'nfl', run_key: '42.1', trigger: 'supabase_cron', result: Object.assign({ recorded_at: new Date(NOW).toISOString() }, s), state: st, now: NOW });
  chk('a run row carries requested / succeeded / failed games, markets, quotes, HTTP, duration, health and next due', rr.events_requested === 2 && rr.events_failed === 1 && rr.events_succeeded === 1 && rr.quotes_usable === 4 && rr.health === 'DEGRADED' && rr.provider_http === '200' && rr.next_due_at && rr.duration_ms != null && rr.trigger === 'supabase_cron', rr);
  const crashed = HS.runRow({ league: 'cfb', run_key: '42.1', result: null, state: null, now: NOW, outcome: 'failure' });
  chk('a crashed capture is recorded as CRASHED with the workflow outcome — never silent', crashed.status === 'CRASHED' && /crashed or did not run/.test(crashed.error_message), crashed);
  const hr = HS.healthRow({ league: 'nfl', run_key: '42.1', result: s, state: st, now: NOW, board_built_at: at(1) });
  chk('the health row is the latest verdict with when the capture is next due', hr.health === 'DEGRADED' && hr.next_due_at === s.next_due_at && hr.events_failed === 1 && hr.board_built_at === at(1), hr);
  chk('a refresh that captured prices completes, with the count', HS.refreshOutcome({ nfl: { events_polled: 1, quotes: 2641, status: 'SUCCESS' } }, 'success').status === 'completed' && /fresh prices captured/.test(HS.refreshOutcome({ nfl: { events_polled: 1, quotes: 10 } }, 'success').reason));
  const rl = HS.refreshOutcome({ nfl: { skipped: 'rate-limited', rate_limited_until: new Date(Date.now() + 600e3).toISOString() } }, 'success');
  chk('a refresh refused by the provider fails, and says until when', rl.status === 'failed' && /rate-limiting requests until/.test(rl.reason), rl);
  chk('a refresh with nothing to re-buy completes, and says why', /nothing to re-buy/.test(HS.refreshOutcome({ nfl: { skipped: 'manual refresh: every game…' } }, 'success').reason));
  chk('a refresh whose run failed before capturing fails', HS.refreshOutcome({ nfl: {} }, 'failure').status === 'failed');
  const writes = [];
  const db = { upsert: async (sch, rel, rows, on) => { writes.push([rel, rows.length, on]); return []; }, patch: async (sch, rel, q, p) => { writes.push([rel, q, p.status]); return []; } };
  await HS.run({ db, leagues: ['nfl'], run_key: '42.1', trigger: 'manual_refresh', refresh_request_id: 'r-9', outcome: 'success', results: { nfl: Object.assign({ recorded_at: new Date().toISOString() }, s) }, states: { nfl: st }, boards: { nfl: null } });
  chk('it writes the run (insert-once), the health (merge) and completes the refresh request', writes.some((w) => w[0] === 'player_props_pipeline_runs' && w[2] === 'run_key,league') && writes.some((w) => w[0] === 'player_props_pipeline_health' && w[2] === 'league') && writes.some((w) => w[0] === 'player_props_refresh_requests' && /r-9/.test(w[1]) && w[2] === 'completed'), writes);

  /* ------------------------------------------------------------ one rule */
  section('one definition of "fresh" (18 IMPORTANT DECISION RULE)');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const ui = read('lib/edgedesk_props_ui.js'), opp = read('lib/edgedesk_opportunity.js'), desk = read('football/props/desk.js');
  chk('the page keeps no private age limit: it asks isExecutableQuote / quoteFreshness with the board\'s thresholds', !/age\s*>\s*\d+/.test(ui) && !/90-minute|> 90\b/.test(ui) && /isExecutableQuote\(/.test(ui) && /freshCfg\(b\.freshness/.test(ui));
  chk('the opportunity layer asks the same rule', /isExecutableQuote\(/.test(opp) && !/90-minute/.test(opp) && !/fresh === 'STALE'/.test(opp));
  chk('the AI desk asks the same rule', /isExecutableQuote\(/.test(desk) && !/90-minute/.test(desk));
  chk('the SQL execution window is the kernel\'s', new RegExp('select ' + E.FRESHNESS.executable_max_minutes + ' \\$\\$').test(read('supabase/player_props_pipeline.sql')));
  chk('the inlined AI-desk copy of the kernel is in sync (tools/presentation/inline.js)', read('supabase/functions/edgedesk_ai/index.ts').indexOf('function isExecutableQuote(q, ctx)') >= 0);

  console.log('\n' + (fail ? 'FAILED' : 'ALL GREEN') + ' player props freshness & recovery — ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
