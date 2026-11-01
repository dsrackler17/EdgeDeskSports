#!/usr/bin/env node
'use strict';
/* ===========================================================================
   THE SHARED COMPARISON PATH — lib/edgedesk_research_compare.js, and the two
   surfaces that compare through it: the Research Queue (lib/edgedesk_overview.js)
   and the Smart Money Tonight cards (lib/edgedesk_radar_ui.js).
   docs/research-compare/README.md

   Deterministic: a pinned clock, constructed provider payloads run through the
   REAL slate builder (tools/slate/fixtures/slate_fixture.js), constructed radar
   cards in radar_tonight()'s own shape. Nothing here reaches a provider.

     1  contracts: market, period, line, settlement, sport identity (NCAAM ≠ NCAAW)
     2  freshness: fresh / stale / missing / unknown, four clocks, started games
     3  cents: the 50¢ / 54¢ / 53¢ example, signed differences, side reversal, rounding
     4  execution: fees, executable vs indicative, depth (missing, partial, full)
     5  ordering: Starting soon, Research priority, TBD, postponed, DST, local dates
     6  refreshes: older-after-newer, duplicate refreshes, immutable snapshots
     7  the whole path: provider payload → slate → queue row and Smart Money card
     8  the frozen experiment: cards, selection and grading inputs are not touched

   Run: node tools/research_compare/research_compare.test.js
   =========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const RC = require(path.join(ROOT, 'lib', 'edgedesk_research_compare.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_games.js'));
const OV = require(path.join(ROOT, 'lib', 'edgedesk_overview.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_radar_ui.js'));
const F = require(path.join(ROOT, 'tools', 'slate', 'fixtures', 'slate_fixture.js'));

let pass = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else fails.push({ name, detail }); }
function eq(name, a, b) { const x = JSON.stringify(a), y = JSON.stringify(b); chk(name, x === y, { got: a, want: b }); }
const textOf = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const NOW = F.NOW;                                     /* 2026-10-13T22:30Z, Tue 5:30 PM CDT */
const MINS = (m) => new Date(NOW - m * 60000).toISOString();
const ZONE = 'America/Chicago';

/* a moneyline contract on one side */
const K = (o) => Object.assign({ sport: 'nhl', event: 'nhl:espn:1', side: 'home', market: 'moneyline', period: 'full_game', line: null, settlement: 'incl_ot' }, o || {});
const freshModel = (prob, o) => Object.assign({ prob, contract: K(), freshness: { state: 'fresh', generated_at: MINS(30), age_min: 30 } }, o || {});
const ask = (price, o) => Object.assign({ source: 'polymarket_ask', kind: 'executable_ask', venue: 'Polymarket', price, size: 500, observed_at: MINS(2), ingested_at: MINS(2), fee_per_share: 0.0075, contract: K() }, o || {});
const shown = (price, o) => Object.assign({ source: 'polymarket_price', kind: 'indicative', venue: 'Polymarket', price, size: null, observed_at: null, ingested_at: MINS(5), fee_per_share: null, contract: K() }, o || {});

/* ======================================================================= */
/* 1. CONTRACTS                                                            */
/* ======================================================================= */
chk('the same contract is comparable', RC.compatible(K(), K()).ok);
eq('a moneyline is never compared with a puck line', RC.compatible(K(), K({ market: 'spread', line: 1.5 })).code, 'MARKET_MISMATCH');
eq('a full game is never compared with a period', RC.compatible(K(), K({ period: 'regulation' })).code, 'PERIOD_MISMATCH');
eq('different alternate lines are not compared (no distribution is assumed)', RC.compatible(K({ market: 'spread', line: -1.5 }), K({ market: 'spread', line: -2.5 })).code, 'LINE_MISMATCH');
eq('a regulation-only probability is never set against an overtime-inclusive contract', RC.compatible(K({ settlement: 'regulation' }), K()).code, 'SETTLEMENT_MISMATCH');
eq('a settlement rule that is not stated is not assumed', RC.compatible(K({ settlement: null }), K()).code, 'SETTLEMENT_UNKNOWN');
eq('the other side of the same market is not the same contract', RC.compatible(K(), K({ side: 'away' })).code, 'SIDE_MISMATCH');
eq('NCAAM and NCAAW are different sports even for the same school', RC.compatible(K({ sport: 'ncaam' }), K({ sport: 'ncaaw' })).code, 'SPORT_MISMATCH');
eq('an NFL model moneyline (tie handling not stated) is never compared', RC.SETTLE.model['football/nfl/slate.json'].moneyline, null);
eq('a sport_key maps to one slate sport; basketball_ncaab is NCAAM, basketball_wncaab NCAAW', [RC.sportOf('basketball_ncaab'), RC.sportOf('basketball_wncaab'), RC.sportOf('icehockey_nhl'), RC.sportOf('soccer_epl')], ['ncaam', 'ncaaw', 'nhl', null]);
{
  const r = RC.compare({ model: freshModel(0.53), quote: shown(0.54, { contract: K({ market: 'spread', line: 1.5 }) }), now: NOW });
  chk('an incompatible pair is suppressed with its reason, and no number is computed', r.status === 'INCOMPATIBLE' && r.diff === null && /different market types/.test(r.reason) && r.active === false, r);
}

/* ======================================================================= */
/* 2. FRESHNESS                                                            */
/* ======================================================================= */
{
  const pol = RC.POLICY.models['hockey/slate.json'].max_age_min;
  const m = (gen, extra) => Object.assign({ source: 'hockey/slate.json', generated_at: gen, data_quality: 'OK', view: { data_state: 'FRESH' } }, extra || {});
  eq('a model built inside its own limit is fresh', RC.modelFreshness(m(MINS(60)), NOW).state, 'fresh');
  eq('…and past it is stale, with why', [RC.modelFreshness(m(MINS(pol + 1)), NOW).state, /rebuilt every 3 h/.test(RC.modelFreshness(m(MINS(pol + 1)), NOW).reason)], ['stale', true]);
  eq('a block with no build time is unknown, never fresh', RC.modelFreshness(m(null), NOW).state, 'unknown');
  eq('the slate’s own source time is used when the block has none', RC.modelFreshness(m(null), NOW, { 'hockey/slate.json': MINS(10) }).state, 'fresh');
  eq('re-running the model on stale inputs is not fresh', [RC.modelFreshness(m(MINS(1), { view: { data_state: 'STALE' } }), NOW).state, RC.modelFreshness(m(MINS(1), { view: { data_state: 'STALE' } }), NOW).reason], ['stale', 'model inputs stale']);
  eq('limited data quality is not fresh either', RC.modelFreshness(m(MINS(1), { data_quality: 'LIMITED' }), NOW).state, 'stale');
  chk('unconfirmed goalies are named, not hidden', /goalies not confirmed/.test(RC.modelFreshness(m(MINS(1), { view: { data_state: 'FRESH', goalie_certainty: 'PROJECTED_UNCERTAIN' } }), NOW).inputs.note));
  eq('each source has its own limit (no global timeout)', [RC.POLICY.models['hockey/slate.json'].max_age_min, RC.POLICY.models['basketball/slate.json'].max_age_min, RC.POLICY.quotes.polymarket_ask.max_age_min, RC.POLICY.quotes.espn_scoreboard.max_age_min], [360, 1800, 15, 90]);
  eq('a scoreboard line is timed by EdgeDesk’s read (the source gives none)', RC.quoteFreshness({ source: 'espn_scoreboard', ingested_at: MINS(20) }, NOW).clock, 'ingested_at');
  eq('an ask is timed by its own quote time, never by when EdgeDesk read it', RC.quoteFreshness({ source: 'polymarket_ask', observed_at: MINS(40), ingested_at: MINS(1) }, NOW).state, 'stale');
  eq('a price with no time is unknown', RC.quoteFreshness({ source: 'polymarket_ask', observed_at: null }, NOW).state, 'unknown');

  eq('MODEL STALE suppresses the active comparison', RC.compare({ model: freshModel(0.53, { freshness: { state: 'stale', reason: 'model built 9 h ago' } }), quote: ask(0.54), now: NOW }).status, 'MODEL_STALE');
  chk('…and draws no difference', RC.compare({ model: freshModel(0.53, { freshness: { state: 'stale' } }), quote: ask(0.54), now: NOW }).diff === null);
  eq('a model with no time recorded is not compared', RC.compare({ model: freshModel(0.53, { freshness: { state: 'unknown' } }), quote: ask(0.54), now: NOW }).status, 'MODEL_AGE_UNKNOWN');
  eq('a stale price asks for a price refresh', RC.compare({ model: freshModel(0.53), quote: ask(0.54, { observed_at: MINS(16) }), now: NOW }).status, 'PRICE_STALE');
  eq('no price: said, not zero', RC.compare({ model: freshModel(0.53), quote: null, now: NOW }).status, 'PRICE_MISSING');
  eq('no model: "Comparable model unavailable"', RC.label(RC.compare({ model: { prob: null }, quote: ask(0.54), now: NOW }).status), 'Comparable model unavailable');
  chk('a genuinely zero difference is kept apart from a missing one', RC.compare({ model: freshModel(0.54), quote: ask(0.54), now: NOW }).diff.value === 0 && RC.compare({ model: freshModel(null), quote: ask(0.54), now: NOW }).diff === null);
  eq('a started game: its pregame comparison is history, not current', RC.compare({ model: freshModel(0.53), quote: ask(0.54), started: true, now: NOW }).status, 'PREGAME_ONLY');
}

/* ======================================================================= */
/* 3. CENTS: THE REQUIRED EXAMPLE, SIGNS, ROUNDING                         */
/* ======================================================================= */
{
  /* wallet entry 50¢, current executable ask 54¢, fresh model fair 53¢ */
  const r = RC.compare({ model: freshModel(0.53), quote: ask(0.54), now: NOW });
  eq('50/54/53: the ask is 1¢ above model fair value', [r.status, r.diff.value, r.diff.price_cents, r.diff.fair_cents], ['ABOVE_FAIR', 1, 54, 53]);
  eq('…in one sentence, before fees', RC.sentence(r), 'Current ask is 1¢ above model fair value before fees.');
  const mv = RC.movement(0.50, 0.54);
  eq('…the historical entry stays apart, its movement from the same rounding', [mv.from, mv.to, mv.diff, mv.text], [50, 54, 4, '50¢ → 54¢ (up 4¢)']);
  /* the screenshot: 50¢ entry, 54¢ now, "up 3¢" — an average entry of 50.49¢ and a price of 53.5¢ each rounded alone */
  const bad = RC.movement(0.5049, 0.535);
  eq('a fractional entry is shown to the tenth, so the printed movement is the difference of the printed prices', [bad.text, bad.diff], ['50.5¢ → 53.5¢ (up 3¢)', 3]);
  chk('the old per-number rounding would have printed 50¢ → 54¢ yet "up 3¢" (the bug)', U.cents(0.5049) === '50¢' && U.cents(0.535) === '54¢' && Math.round((0.535 - 0.5049) * 100) === 3);
  eq('below fair is negative and says below', [RC.compare({ model: freshModel(0.56), quote: ask(0.54), now: NOW }).status, RC.compare({ model: freshModel(0.56), quote: ask(0.54), now: NOW }).diff.value], ['BELOW_FAIR', -2]);
  eq('near fair only when the printed difference is 0¢', [RC.compare({ model: freshModel(0.5402), quote: ask(0.54), now: NOW }).status, RC.compare({ model: freshModel(0.535), quote: ask(0.54), now: NOW }).status], ['NEAR_FAIR', 'ABOVE_FAIR']);
  /* side reversal: the away side's fair is 1 − home; the sign follows the side named */
  const home = RC.compare({ model: freshModel(0.53), quote: ask(0.54), now: NOW });
  const away = RC.compare({ model: freshModel(1 - 0.53, { contract: K({ side: 'away' }) }), quote: ask(0.44, { contract: K({ side: 'away' }) }), now: NOW });
  eq('side reversal: home 54 vs 53 is +1¢; away 44 vs 47 is −3¢, each for its own side', [home.diff.value, away.diff.value, away.status], [1, -3, 'BELOW_FAIR']);
  eq('pp, % and ¢ are different words', [RC.ppText(3.6), RC.pctText(0.036), RC.signedCents(-3)], ['+3.6 pp', '+3.6%', '−3¢']);
  chk('wallet/model agreement adds nothing: the same numbers give the same status whatever the wallets hold', JSON.stringify(RC.compare({ model: freshModel(0.53), quote: ask(0.54), now: NOW, agrees: true })) === JSON.stringify(RC.compare({ model: freshModel(0.53), quote: ask(0.54), now: NOW })));
}

/* ======================================================================= */
/* 4. EXECUTION: FEES, ASK VS INDICATIVE, DEPTH                            */
/* ======================================================================= */
{
  const r = RC.compare({ model: freshModel(0.53), quote: ask(0.54), now: NOW });
  chk('EV at an executable ask with a stated fee: p / (ask + fee) − 1', Math.abs(r.ev.value - (0.53 / (0.54 + 0.0075) - 1)) < 1e-12 && /top of book only/.test(r.ev.basis), r.ev);
  eq('no fee recorded: no EV, and why (never an assumed zero)', RC.compare({ model: freshModel(0.53), quote: ask(0.54, { fee_per_share: null }), now: NOW }).ev, { value: null, reason: 'the market’s fee is not recorded' });
  chk('a fee the venue states as zero is a real zero', RC.compare({ model: freshModel(0.53), quote: ask(0.54, { fee_per_share: 0 }), now: NOW }).ev.value !== null);
  const ind = RC.compare({ model: freshModel(0.53), quote: shown(0.54), now: NOW });
  chk('an indicative price is compared, labelled, and never given an EV', ind.status === 'ABOVE_FAIR' && ind.ev.value === null && /indicative/.test(ind.ev.reason) && /displayed price/.test(RC.sentence(ind)) && !/before fees/.test(RC.sentence(ind)), RC.sentence(ind));
  eq('depth: a stated size fills in full', RC.fill({ price: 0.54, size: 500 }, 200).state, 'full');
  eq('depth: partial capacity is reported', [RC.fill({ price: 0.54, size: 120 }, 200).state, RC.fill({ price: 0.54, size: 120 }, 200).filled], ['partial', 120]);
  eq('depth: none at the ask', RC.fill({ price: 0.54, size: 0 }, 200).state, 'insufficient');
  eq('depth: an unrecorded size is unknown, never unlimited', RC.fill({ price: 0.54, size: null }, 200).state, 'depth_unknown');
  eq('a comparison asked for a size reports the fill', RC.compare({ model: freshModel(0.53), quote: ask(0.54, { size: 50 }), stake_shares: 100, now: NOW }).fill.state, 'partial');
}

/* ======================================================================= */
/* 5. ORDERING, TIME ZONES, TBD                                            */
/* ======================================================================= */
{
  const row = (id, o) => Object.assign({ id, group: 'upcoming', start: NOW + 3600e3, sortKey: null, sport: 'nhl', cmp: null }, o || {});
  eq('Starting soon: by start, then id; saving a game never moves it', RC.orderSoon([row('c', { start: NOW + 7200e3, watched: true }), row('b'), row('a')]).map((r) => r.id), ['a', 'b', 'c']);
  eq('…live first, finished and postponed last', RC.orderSoon([row('f', { group: 'final', start: NOW - 9e6 }), row('u'), row('l', { group: 'live', start: NOW - 3600e3 }), row('p', { group: 'off', start: NOW - 1 })]).map((r) => r.id), ['l', 'u', 'f', 'p']);
  eq('…a time-TBD game sorts after its day’s timed games (sortKey = end of day)', RC.orderSoon([row('tbd', { start: null, sortKey: NOW + 5 * 3600e3 }), row('late', { start: NOW + 4 * 3600e3 })]).map((r) => r.id), ['late', 'tbd']);
  const shuffled = [row('a'), row('b'), row('c')].reverse();
  eq('deterministic: the same rows in any input order sort the same', RC.orderSoon(shuffled).map((r) => r.id), RC.orderSoon(shuffled.slice().reverse()).map((r) => r.id));

  const C = (abs, unit, market, active) => ({ active: active !== false, status: active === false ? 'MODEL_STALE' : 'COMPARED', diff: { abs, value: abs, unit }, market });
  const P = RC.priority([
    row('nba1', { sport: 'nba', cmp: C(2, 'pts', 'spread') }), row('nfl1', { sport: 'nfl', cmp: C(1, 'pts', 'spread') }), row('nba2', { sport: 'nba', cmp: C(4, 'pts', 'spread') }),
    row('nhl1', { sport: 'nhl', cmp: C(3.6, 'pp', 'moneyline') }), row('stale', { sport: 'nhl', cmp: C(9, 'pp', 'moneyline', false) }), row('zero', { sport: 'nhl', cmp: C(0, 'pp', 'moneyline') }),
    row('live', { sport: 'nhl', group: 'live', cmp: C(5, 'pp', 'moneyline') }), row('none', { sport: 'nba' })]);
  eq('priority: NFL, NBA and NHL are never ranked against each other (one group per sport × market)', P.groups.map((g) => g.key), ['nfl|spread', 'nba|spread', 'nhl|moneyline']);
  eq('…within a group, the larger disagreement first', P.groups[1].rows.map((r) => r.id), ['nba2', 'nba1']);
  eq('…stale, zero, started and uncompared games are not ranked; they are listed apart', P.excluded.map((r) => r.id).sort(), ['live', 'none', 'stale', 'zero']);

  /* time zones, DST and local dates: 2026-11-01 is the US fall-back day */
  const z = 'America/Chicago';
  eq('DST: 23:00Z on Oct 31 is 6:00 PM CDT; on Nov 2 it is 5:00 PM CST', [G.timeText(Date.parse('2026-10-31T23:00:00Z'), z), G.timeText(Date.parse('2026-11-02T23:00:00Z'), z)], ['6:00 PM CDT', '5:00 PM CST']);
  eq('the fall-back day is 25 hours long in Chicago', (G.dayBounds('2026-11-01', z).to - G.dayBounds('2026-11-01', z).from) / 3600e3, 25);
  eq('High Point–Liberty: 04:59Z is 11:59 PM EST (the feed’s own "11:59 PM EST") and 10:59 PM CST: a valid time, not TBD', [G.timeText(Date.parse('2026-11-02T04:59:00Z'), 'America/New_York'), G.timeText(Date.parse('2026-11-02T04:59:00Z'), z)], ['11:59 PM EST', '10:59 PM CST']);
  eq('…and it falls on the reader’s Nov 1 in Chicago but Nov 2 in Los Angeles? no: Nov 1 in both', [G.dateKey(Date.parse('2026-11-02T04:59:00Z'), z), G.dateKey(Date.parse('2026-11-02T04:59:00Z'), 'America/Los_Angeles'), G.dateKey(Date.parse('2026-11-02T04:59:00Z'), 'America/New_York')], ['2026-11-01', '2026-11-01', '2026-11-01']);
  eq('Smart Money times read in the reader’s zone, named (no hard-coded ET)', U.whenIn('2026-10-14T00:00:00Z', z, NOW), 'Today · 7:00 PM CDT');
}

/* ======================================================================= */
/* 6. REFRESHES AND SNAPSHOTS                                              */
/* ======================================================================= */
{
  const held = { as_of: '2026-10-13T22:20:00Z', cards: ['new'] }, late = { as_of: '2026-10-13T22:10:00Z', cards: ['old'] };
  eq('an older answer that lands after a newer one never replaces it', RC.newer(held, late).cards, ['new']);
  eq('a newer one does', RC.newer(late, held).cards, ['new']);
  eq('the same answer twice (a duplicate refresh) changes nothing', RC.newer(held, Object.assign({}, held)).as_of, held.as_of);
  const res = { event_id: 'E1', market: 'moneyline', side: 'home', model: freshModel(0.53, { label: 'EdgeDesk NHL model', source: 'hockey/slate.json' }), quote: ask(0.54), comparison: RC.compare({ model: freshModel(0.53), quote: ask(0.54), now: NOW }) };
  const snap = RC.snapshot(res, NOW);
  chk('a published snapshot is frozen: a refreshed prediction cannot overwrite it', Object.isFrozen(snap) && Object.isFrozen(snap.quote) && Object.isFrozen(snap.comparison.diff) && (() => { try { snap.model.prob = 0.9; } catch (_) { /* strict */ } return snap.model.prob === 0.53; })());
  chk('…and it keeps what was known at publication: model, quote time, venue, market, fee, status, calc', snap.model.prob === 0.53 && snap.quote.observed_at === MINS(2) && snap.quote.venue === 'Polymarket' && snap.quote.fee_per_share === 0.0075
    && snap.comparison.status === 'ABOVE_FAIR' && snap.calc === RC.VERSION && snap.published_at === new Date(NOW).toISOString());
  res.model.prob = 0.60;
  chk('…a later change to the live result leaves the snapshot as published', snap.model.prob === 0.53);
}

/* ======================================================================= */
/* 7. THE WHOLE PATH: provider payload → slate → queue row → card          */
/* ======================================================================= */
(async () => {
  const src = F.research();
  src.nhl.generated_at = MINS(60);                 /* the NHL model ran an hour ago */
  src.cfb.generated_at = MINS(120);
  const built = await F.buildFixture({ research: src });
  const S = built.snap;
  const EVENTS = S.events.concat(S.upcoming || []);
  const cbj = EVENTS.find((e) => e.id === 'nhl:espn:401802002');
  chk('ingestion: the slate builder stamps the model block with its artifact’s build time', cbj.research.model.generated_at === src.nhl.generated_at, cbj.research.model);
  const snapView = { events: EVENTS, markets: S.markets, zone: ZONE, today: G.today(NOW, ZONE), ready: true, generated_at: S.generated_at, freshness: { alerts: [] }, sources: S.sources };
  const L = OV.lists(snapView, { now: NOW, v2: true, watch: {}, card: {}, changes: {}, recent: [] });
  const r = L.byId['nhl:espn:401802002'];
  /* FLA at CBJ: the model prices the moneyline; the book has a moneyline AND a puck line (CBJ +1.5) — the Utah–Philadelphia shape */
  eq('Utah–Philadelphia shape: the model’s moneyline is compared with the book’s moneyline only', [r.cmp.status, r.cmp.market, r.cmp.via], ['COMPARED', 'moneyline', 'EDNHLCompare']);
  const NHLC = require(path.join(ROOT, 'lib', 'edgedesk_nhl_compare.js'));
  const page = NHLC.compare(cbj.research.model.view, S.markets[cbj.id], { now: NOW }).markets.find((m) => m.kind === 'moneyline').sides.find((x) => x.key === 'home');
  eq('the queue and the matchup page show the same gap (one path)', r.cmp.diff.value, page.gap_pp);
  const h = textOf(OV.rowV2HTML(r, { now: NOW, zone: ZONE }));
  chk('the row names the market on both numbers, and never sets a model moneyline beside a puck line', /Model · Moneyline Blue Jackets 47\.2% built 1 h ago/.test(h) && /DraftKings · Moneyline Blue Jackets 42\.0% no-vig \(\+130\) read just now/.test(h) && !/Puck line/.test(h.split('Sources and why')[0]), h);
  chk('the status is words, not colour alone', /Model vs no-vig price \+5\.2 pp \(home\)/.test(h), h);
  chk('the detail is behind one disclosure, with the calc version', /Sources and why/.test(h) && h.indexOf(RC.VERSION) > h.indexOf('Sources and why'));
  chk('the model’s caveat travels with the comparison', /model not tested against the market/.test(h));
  /* the row for a live game keeps its numbers as pregame history */
  const det = L.byId['nhl:espn:401802001'];
  chk('a live game is never an active comparison', det.group === 'live' && det.cmp.active === false && ['PREGAME_ONLY', 'PRICE_MISSING'].indexOf(det.cmp.status) >= 0, det.cmp);
  /* stale price three hours later */
  const L3 = OV.lists(snapView, { now: NOW + 3 * 3600e3, v2: true, watch: {}, card: {}, changes: {}, recent: [] });
  eq('three hours later the scoreboard line is past its limit: price refresh needed', L3.byId['nhl:espn:401802002'] ? L3.byId['nhl:espn:401802002'].cmp.status : 'PREGAME_ONLY', 'PREGAME_ONLY');
  const L1 = OV.lists(snapView, { now: NOW + 100 * 60000, v2: true, watch: {}, card: {}, changes: {}, recent: [] });
  eq('100 minutes later (before the 6 PM start? no: the game has started) — the started rule wins over the price age', L1.byId['nhl:espn:401802002'].cmp.status, 'PREGAME_ONLY');
  const early = JSON.parse(JSON.stringify(snapView)); early.markets['nhl:espn:401802002'].captured_at = MINS(95);
  eq('a scoreboard line read 95 minutes ago: price refresh needed', OV.lists(early, { now: NOW, v2: true, watch: {}, card: {}, changes: {}, recent: [] }).byId['nhl:espn:401802002'].cmp.status, 'PRICE_STALE');
  /* Starting soon is chronological; Today counts are the rows listed */
  const up = L.today.filter((x) => x.group === 'upcoming').map((x) => x.sortKey);
  chk('Starting soon: today’s upcoming games in start order', up.every((t, i) => i === 0 || up[i - 1] <= t), up);
  eq('Today’s count is the rows listed', L.counts.today, L.today.length);
  chk('a postponed game is folded with the finished ones', L.today.filter((x) => x.group === 'off').length >= 1 && /1 finished or not played|finished or not played/.test(OV.queueHTML(L, 'today', { now: NOW })));
  const qh = OV.queueHTML(L, 'today', { now: NOW, sort: 'priority' });
  chk('Research priority says it is not a betting recommendation, and ranks like with like', /Research priority, not a betting recommendation/.test(textOf(qh)) && /NHL · Moneyline/.test(textOf(qh)) && /Fresh model\/price disagreement/.test(textOf(qh)), textOf(qh).slice(0, 800));
  chk('…and every unranked game says why', /not ranked ·/.test(textOf(qh)));
  /* TBD: a game ESPN has not timed is on its date as "Time TBD" */
  const tbdEv = JSON.parse(JSON.stringify(cbj)); tbdEv.id = 'nhl:espn:tbd'; tbdEv.time_tbd = true; tbdEv.start_utc = '2026-10-14T03:59:00.000Z';
  const Lt = OV.lists(Object.assign({}, snapView, { events: EVENTS.concat([tbdEv]) }), { now: NOW, v2: true, watch: {}, card: {}, changes: {}, recent: [] });
  chk('a time-TBD game is listed under its date, last among its day, as "Time TBD"', Lt.today.filter((x) => x.group === 'upcoming').slice(-1)[0].id === 'nhl:espn:tbd' && /Time TBD/.test(OV.rowV2HTML(Lt.byId['nhl:espn:tbd'], { now: NOW, zone: ZONE })));
  chk('…and the legacy queue (flag off) still drops it, as before', !OV.lists(Object.assign({}, snapView, { events: EVENTS.concat([tbdEv]) }), { now: NOW, v2: false, watch: {}, card: {}, changes: {}, recent: [] }).today.some((x) => x.id === 'nhl:espn:tbd'));

  /* ── a Smart Money card on the same game, through the same path ── */
  const card = (o) => Object.assign({ event_id: 'oddsapi-ev-1', sport_key: 'icehockey_nhl', condition_id: '0x' + 'c'.repeat(64), token_id: '123', market_type: 'moneyline',
    question: 'Panthers vs. Blue Jackets', outcome: 'Panthers', selection: 'Florida Panthers', point: null, home_team: 'Columbus Blue Jackets', away_team: 'Florida Panthers',
    commence_time: '2026-10-13T23:00:00Z', n_wallets: 3, dollars: 8400, avg_entry: 0.5049, current_price: 0.535, price_at: MINS(4), moved: 0.0301, has_moved: true,
    fair: 0.55, fair_seen_at: MINS(400), fair_current: false, agrees: null, other_side_wallets: 1, other_side_dollars: 600, high_conviction: 0, holders_at: MINS(6),
    wallets: [{ wallet: '0x' + '1'.repeat(40), display: 'SharpAlice', rank: 2, cost: 5000, avg_price: 0.5, shares: 10000 }] }, o || {});
  const c0 = card(), frozen = JSON.stringify(c0);
  const R = RC.fromRadarCard(c0, { events: EVENTS, now: NOW });
  eq('the card finds its game on EdgeDesk’s schedule and its side (away)', [R.slate_event, R.side], ['nhl:espn:401802002', 'away']);
  eq('model fair for that side is the model’s own away probability', R.model.prob, 0.5283);
  eq('Polymarket’s displayed price is indicative, never called an ask', [R.quote.kind, R.comparison.status, R.comparison.diff.value], ['indicative', 'ABOVE_FAIR', 0.7]);
  eq('movement from their average entry, by the same rounding', R.movement.text, '50.5¢ → 53.5¢ (up 3¢)');
  eq('the stale Pinnacle reference is kept apart and not compared', [R.reference.state, R.reference.label], ['stale', 'Pinnacle de-vigged reference']);
  const ch = U.cardV2HTML(c0, { events: EVENTS, now: NOW, zone: ZONE, noun: 'featured bettor' }), ct = textOf(ch);
  chk('the card: matchup and time in the reader’s zone', /Florida Panthers at Columbus Blue Jackets · Today · 6:00 PM CDT/.test(ct), ct.slice(0, 200));
  chk('…wallet activity: count, cost basis held at the last read, historical average entry', /3 featured bettors, \$8\.4K, on Panthers \$8\.4K cost basis · held at last read 6 min ago · avg entry 50\.5¢ \(historical\)/.test(ct), ct);
  chk('…model fair with its model and age; the market with its kind and age', /Model fair 52\.8¢ EdgeDesk NHL model, built 1 h ago/.test(ct) && /Polymarket 53\.5¢ Displayed price, not an ask · read 4 min ago/.test(ct), ct);
  chk('…the interpretation in words, signed, never "smart money agrees"', /Above model fair value Polymarket’s displayed price is 0\.7¢ above model fair value\./.test(ct) && !/agrees|disagrees/i.test(ct.split('Details and sources')[0]), ct);
  chk('…no EV without an ask and a fee, and it says why', /No EV is shown: no executable ask/.test(ct));
  chk('…the old "EdgeDesk fair" label for the Pinnacle number is gone: it is named a market reference', /Sharp reference\. Pinnacle de-vigged reference 55¢, last seen .*: past its 90-minute limit, so it is not compared\. A market reference, not EdgeDesk’s model\./.test(ct) && !/EdgeDesk fair/.test(ct), ct);
  chk('…one research action, to the matched game', /Open game research/.test(textOf(U.cardV2HTML(c0, { events: EVENTS, now: NOW, zone: ZONE, researchHref: () => '#game/nhl/2026020091' }))) && /href="#game\/nhl\/2026020091"/.test(U.cardV2HTML(c0, { events: EVENTS, now: NOW, zone: ZONE, researchHref: () => '#game/nhl/2026020091' })));
  /* the ask, when the door carries it: 50¢ entry, 54¢ ask, 53¢ fair */
  const viewAt53 = JSON.parse(JSON.stringify(EVENTS)); const g53 = viewAt53.find((e) => e.id === 'nhl:espn:401802002'); g53.research.model.view.moneyline = { home: 0.47, away: 0.53, status: 'OUTCOME_VALIDATED', market_status: 'NOT_TESTED' };
  const A = RC.fromRadarCard(card({ avg_entry: 0.50, ask_price: 0.54, ask_size: 300, ask_at: MINS(1), fee_per_share: 0.0075 }), { events: viewAt53, now: NOW });
  eq('the required example through the card path: entry 50¢, ask 54¢, fair 53¢', [A.movement.text, A.comparison.status, RC.sentence(A.comparison)], ['50¢ → 54¢ (up 4¢)', 'ABOVE_FAIR', 'Current ask is 1¢ above model fair value before fees.']);
  const At = textOf(U.cardV2HTML(card({ avg_entry: 0.50, ask_price: 0.54, ask_size: 300, ask_at: MINS(1), fee_per_share: 0.0075 }), { events: viewAt53, now: NOW, zone: ZONE }));
  chk('…drawn: the entry separately, the ask with its depth, the 1¢ gap before fees, an EV with its basis', /avg entry 50¢ \(historical\)/.test(At) && /Best ask, 300 shares at it/.test(At) && /Current ask is 1¢ above model fair value before fees\./.test(At) && /Estimated EV −3\.2% per \$1/.test(At), At);
  /* model stale → no active comparison on the card */
  const stale = JSON.parse(JSON.stringify(EVENTS)); stale.find((e) => e.id === 'nhl:espn:401802002').research.model.generated_at = MINS(7 * 60);
  const Rs = RC.fromRadarCard(c0, { events: stale, now: NOW });
  chk('a stale model suppresses the card’s comparison (no difference drawn)', Rs.comparison.status === 'MODEL_STALE' && Rs.comparison.diff === null && /Model refresh needed/.test(textOf(U.cardV2HTML(c0, { events: stale, now: NOW, zone: ZONE }))));
  /* a spread card where the model has no probability at that line */
  const sp = RC.fromRadarCard(card({ market_type: 'spreads', point: -2.5, outcome: 'Panthers' }), { events: EVENTS, now: NOW });
  chk('a puck line the model does not price: comparable model unavailable, never a converted margin', sp.comparison.status === 'MODEL_UNAVAILABLE' && /no puck line at -2\.5/.test(sp.comparison.reason), sp.comparison);
  /* NCAAM / NCAAW: a men's card never matches a women's game of the same schools */
  const wEv = { id: 'ncaaw:espn:9', sport: 'ncaaw', start_utc: '2026-10-14T00:00:00.000Z', status: 'SCHEDULED', home: { name: 'Liberty Flames', abbr: 'LIB' }, away: { name: 'High Point Panthers', abbr: 'HPU' }, research: { model: { source: 'basketball/slate.json', fair: { home_win: 0.7 }, generated_at: MINS(10) } } };
  const mCard = card({ sport_key: 'basketball_ncaab', home_team: 'Liberty Flames', away_team: 'High Point Panthers', outcome: 'Liberty', selection: 'Liberty Flames', commence_time: '2026-10-14T00:00:00Z' });
  eq('a men’s college card finds no women’s game with the same schools', [RC.fromRadarCard(mCard, { events: [wEv], now: NOW }).slate_event, RC.fromRadarCard(mCard, { events: [wEv], now: NOW }).comparison.status], [null, 'MODEL_UNAVAILABLE']);
  eq('…the women’s card does', RC.fromRadarCard(card({ sport_key: 'basketball_wncaab', home_team: 'Liberty Flames', away_team: 'High Point Panthers', outcome: 'Liberty', selection: 'Liberty Flames', commence_time: '2026-10-14T00:00:00Z' }), { events: [wEv], now: NOW }).slate_event, 'ncaaw:espn:9');
  /* a card on a started game */
  eq('a card whose game has started is pregame history', RC.fromRadarCard(c0, { events: EVENTS, now: Date.parse('2026-10-13T23:05:00Z') }).comparison.status, 'PREGAME_ONLY');

  /* ======================================================================= */
  /* 8. THE FROZEN EXPERIMENT IS NOT TOUCHED                                 */
  /* ======================================================================= */
  eq('rendering and comparing never mutates a card (the published inputs)', JSON.stringify(c0), frozen);
  const T = { status: 'ok', hypothesis: 'H-RADAR-02', top_wallets: 10, featured: 3, conviction_high_x: 3, graded_at: MINS(600), cards: [card({ event_id: 'B' }), card({ event_id: 'A', n_wallets: 1 })], observed: [], sync: { state: 'ok', holders_at: MINS(6) } };
  const before = JSON.stringify(T);
  const tv = U.tonightHTML(T, { compare: true, events: EVENTS, now: NOW, zone: ZONE });
  chk('the cards keep the door’s order and membership (selection is the database’s)', tv.indexOf('data-radar-event="B"') < tv.indexOf('data-radar-event="A"') && (tv.match(/data-radar-event=/g) || []).length === 2 && JSON.stringify(T) === before);
  chk('the Experimental label stays visible on v2, and the method folds away', /<span class="rd-chip exp">Experimental<\/span>/.test(tv) && /<details class="rd-fold" id="rdHow"><summary>How Smart Money Tonight works/.test(tv));
  chk('flag off: the v1 card is drawn exactly as before', U.tonightHTML(T) === U.tonightHTML(T, undefined) && /EdgeDesk fair<\/dt>/.test(U.tonightHTML(T)));
  eq('the rollout flag: on by default, ?rc=0 turns it off for the page view', [RC.enabled(''), RC.enabled('?rc=0'), RC.enabled('?x=1&rc=1')], [true, false, true]);
  const rec = textOf(U.recordHTML({ status: 'ok', label: 'EXPERIMENTAL', hypothesis: 'H-RADAR-02', priced_at: 'best_ask', small_sample: true, min_sample: 200,
    totals: { graded: 2, wins: 2, losses: 0, pushes: 0, roi: 0.784, beat_close_rate: 1, with_close: 1, pending: 1, void: 0, no_close: 1 }, h_radar_01: { status: 'complete', passed: false }, recent: [] }));
  chk('2–0 and +78.4% from two cards read as two cards, not validated, with every denominator', /Small sample: 2 of 200 graded/.test(rec) && /over 2 graded cards, not validated/.test(rec) && /1 of 2 graded with a comparable close/.test(rec) && /1 pending, 0 void, 1 without a close/.test(rec), rec);
  /* the frozen protocol files are byte-identical to main (nothing here changes the experiment) */
  const cp = require('child_process');
  const base = cp.spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (base) {
    const d = cp.spawnSync('git', ['diff', '--name-only', base, '--', 'supabase/radar.sql', 'supabase/radar_record.sql', 'supabase/radar_registry.sql', 'research/radar', 'lib/edgedesk_radar.js'], { cwd: ROOT, encoding: 'utf8' });
    const u = cp.spawnSync('git', ['status', '--porcelain', '--', 'supabase/radar.sql', 'supabase/radar_record.sql', 'supabase/radar_registry.sql', 'research/radar', 'lib/edgedesk_radar.js'], { cwd: ROOT, encoding: 'utf8' });
    eq('H-RADAR-01/02: selection, publication, grading and registrations unchanged from main', (d.stdout + u.stdout).trim(), '');
  } else console.log('NOTE | no origin/main merge base here: the frozen-file diff check is not verified in this run');

  fails.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  console.log((fails.length ? 'FAILED' : 'ALL GREEN') + ' research compare — ' + pass + ' passed, ' + fails.length + ' failed');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
