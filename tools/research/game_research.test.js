#!/usr/bin/env node
/* THE GAME RESEARCH CONTRACT. Driven by a REAL CFB P4 engine projection, so
   the engine's margin convention is converted by the named function and the
   decomposition is proven exact against the engine's own number, not a mock.
   Also pins: no market -> nothing model-vs-market invented; no cover
   probability -> EV is N/A; best number is kept apart from best price;
   stale data is flagged; an outlier is described, not judged; the research
   queue never speaks in picks; the autopsy blames no component it cannot
   measure.   Run: node tools/research/game_research.test.js */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'research_core.js'));
const E = require(path.join(ROOT, 'lib', 'research_eval.js'));
const G = require(path.join(ROOT, 'lib', 'game_research.js'));
globalThis.EDCfbP4Params = require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const ENG = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String(e && e.stack) }; } }
  if (ok) { pass++; return; } fail++; failures.push({ name, detail });
}
const near = (a, b, e) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (e == null ? 1e-9 : e);
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 400)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- a real projection -------------------------------------------------- */
const P = globalThis.EDCfbP4Params;
const teams = Object.keys(P.rating.seed_ratings);
const HOME = teams.indexOf('alabama') >= 0 ? 'Alabama' : teams[0];
const AWAY = teams.indexOf('georgia') >= 0 ? 'Georgia' : teams[1];
function project(market) {
  return ENG.projectGame({ season: P.trained_through_season, week: 6, state: ENG.newState(),
    game: { home: HOME, away: AWAY, neutral_site: false, kickoff: '2025-10-11T19:00:00Z' },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } }, market: market || {} });
}
const eng = project({ spread_line: 3.5, total_line: 52.5 });   /* engine market is MARGIN convention: home by 3.5 */
chk('the engine projects the fixture', eng && eng.status === 'PREDICTED', eng && eng.status);
const NOW = '2025-10-10T12:00:00Z';
const game = { sport: 'CFB', season: 2025, week: 6, game_id: 'g1', home: HOME, away: AWAY, kickoff_at: '2025-10-11T19:00:00Z' };
const market = {
  open: { line: -2.5, captured_at: '2025-10-05T12:00:00Z', source: 'consensus' },
  current: { line: -3.5, captured_at: '2025-10-10T11:00:00Z', source: 'consensus' },
  moneyline: { home: -160, away: 135, captured_at: '2025-10-10T11:00:00Z' },
  books: [
    { book: 'A', line: -3.5, price_home: -110, price_away: -110, captured_at: '2025-10-10T11:00:00Z' },
    { book: 'B', line: -3.5, price_home: -105, price_away: -115, captured_at: '2025-10-10T11:00:00Z' },
    { book: 'C', line: -3, price_home: -120, price_away: 100, captured_at: '2025-10-10T11:00:00Z' },
    { book: 'D', line: -4, price_home: 100, price_away: -120, captured_at: '2025-10-10T11:00:00Z' }
  ]
};
const o = G.build({ game, now: NOW, model: { engine: eng }, market,
  quality: { market: { captured_at: '2025-10-10T11:00:00Z' }, injuries: { captured_at: '2025-10-01T00:00:00Z' } } });

/* ---- 1. convention and decomposition ------------------------------------ */
chk('the engine margin becomes a home line with the sign turned', near(o.model.fair_home_line.value, -eng.model.fair_spread));
chk('the decomposition is exact: its terms sum to the published fair line', o.model.decomposition.exact === true
  && near(o.model.decomposition.sum, o.model.fair_home_line.value, 0.01), o.model.decomposition);
chk('every component carries value, reliability, source and a missing flag', o.model.decomposition.components.every((c) =>
  'value' in c && 'reliability' in c && 'source' in c && typeof c.missing === 'boolean'));
chk('a missing component contributes exactly zero and says why', o.model.decomposition.components.filter((c) => c.missing)
  .every((c) => c.value === 0 && (c.reason || c.source)));
chk('weather sits in the total decomposition, not the spread', !o.model.decomposition.components.some((c) => c.key === 'weather'));
chk('the joined-line cover probability is re-stated at the home line (-3.5)', o.model.cover_at_joined_line
  && near(o.model.cover_at_joined_line.home_line, -3.5));

/* ---- 2. model vs market -------------------------------------------------- */
chk('raw gap = |fair - current|', near(o.model_vs_market.raw_gap.value, Math.abs(o.model.fair_home_line.value - -3.5), 1e-4));
chk('normalized gap uses the engine sigma and names it', near(o.model_vs_market.normalized_gap.value,
  o.model_vs_market.raw_gap.value / eng.model.sigma_margin, 1e-3) && /sigma/.test(o.model_vs_market.normalized_gap.source));
chk('probability gap = model home win prob - no-vig home', near(o.model_vs_market.probability_gap.value,
  eng.model.home_win_prob - R.noVigTwoWay(-160, 135).a));
chk('open -2.5 -> -3.5 crosses 3 and is reported as a key number', o.model_vs_market.key_numbers_since_open[0].key === 3);
chk('every model number carries its source and capture time', o.model.fair_home_line.source && o.model.fair_home_line.captured_at);

/* ---- 3. line shopping --------------------------------------------------- */
const sh = o.market.shopping;
chk('best NUMBER for home is the highest home line (-3), for away the lowest (-4)', sh.best_number.home.home_line === -3 && sh.best_number.away.home_line === -4
  && sh.best_number.away.side_line === 4);
chk('best PRICE at the consensus number is separate: home -105 at -3.5, away -110', sh.best_price_at_consensus.home.price === -105
  && sh.best_price_at_consensus.away.price === -110);
chk('worst number is the other end', sh.worst_number.home.home_line === -4 && sh.worst_number.away.home_line === -3);
chk('dispersion and range are stated', sh.range.min === -4 && sh.range.max === -3 && sh.dispersion > 0);

/* ---- 4. price-aware EV ------------------------------------------------- */
chk('EV at the joined line uses the engine cover probability and its push mass', (() => {
  const a = o.price.home.at_consensus;
  return a.model_prob != null && near(a.model_prob, eng.cover.win) && near(a.push_prob, eng.cover.push || 0)
    && near(a.break_even, 105 / 205) && a.expected_roi != null;
})(), o.price.home.at_consensus);
chk('EV at a line with no model probability is N/A, never derived from the gap', (() => {
  const a = o.price.home.best_number;          /* -3: engine only priced -3.5 */
  return a.model_prob === null && a.expected_roi === null && /no model cover probability/.test(a.reason) && a.break_even != null;
})(), o.price.home.best_number);
chk('with the model\'s own cover_at function every line can be priced', (() => {
  const o2 = G.build({ game, now: NOW, model: { engine: eng, cover_at: (l) => ({ win: 0.55, push: 0.03, lose: 0.42 }) }, market });
  return near(o2.price.home.best_number.model_prob, 0.55) && near(o2.price.away.best_number.model_prob, 0.42);
})());

/* ---- 5. no market: nothing invented ---------------------------------- */
(function () {
  const n = G.build({ game, now: NOW, model: { engine: project({}) }, market: {} });
  chk('no market: every model-vs-market fact is null', n.model_vs_market.raw_gap.value === null && n.model_vs_market.normalized_gap.value === null
    && n.model_vs_market.probability_gap.value === null && n.model_vs_market.movement_since_open === null);
  chk('no market: line shopping says so', n.market.shopping.available === false && /no per-book/.test(n.market.shopping.reason));
  chk('no market: flagged NO_MARKET and no research flag raised from a gap', n.flags.flags.some((f) => f.key === 'NO_MARKET')
    && !n.flags.flags.some((f) => f.key === 'LARGE_DISAGREEMENT'));
  chk('no model: the builder still returns identity and market, model null', G.build({ game, market }).model === null);
})();

/* ---- 6. data quality --------------------------------------------------- */
(function () {
  const q = o.quality;
  chk('each category has a status from AVAILABLE/PARTIAL/STALE/UNAVAILABLE', q.categories.every((c) => ['AVAILABLE', 'PARTIAL', 'STALE', 'UNAVAILABLE'].indexOf(c.status) >= 0));
  chk('a 9-day-old injury report is STALE', q.categories.find((c) => c.category === 'injuries').status === 'STALE');
  chk('a category never supplied is UNAVAILABLE, not assumed fine', q.categories.find((c) => c.category === 'qb').status === 'UNAVAILABLE');
  chk('completeness states its rule and names what was lost', /mean credit/.test(q.rule) && q.missing.indexOf('qb') >= 0 && q.stale.indexOf('injuries') >= 0);
  chk('stale injuries raise HIGH_UNCERTAINTY', o.flags.flags.some((f) => f.key === 'HIGH_UNCERTAINTY'));
  const st = G.build({ game, now: NOW, model: { engine: eng }, market: { current: { line: -3.5, captured_at: '2025-10-09T00:00:00Z' } } });
  chk('a 36h-old consensus is flagged STALE_MARKET', st.market.current.stale === true && st.flags.flags.some((f) => f.key === 'STALE_MARKET'));
})();

chk('contract rows fold into categories: all-unavailable, mixed, stale, not-applicable', (() => {
  const q = G.qualityFromContract([
    { field: 'qb_starter', side: 'home', state: 'USABLE', as_of: '2025-10-09T00:00:00Z' },
    { field: 'qb_starter', side: 'away', state: 'UNAVAILABLE' },
    { field: 'availability', side: 'home', state: 'UNAVAILABLE' }, { field: 'availability', side: 'away', state: 'FETCH_FAILED' },
    { field: 'weather', state: 'STALE', as_of: '2025-10-01T00:00:00Z' },
    { field: 'coaching_continuity', state: 'NOT_APPLICABLE' },
    { field: 'roster', side: 'home', state: 'RESEARCH_ONLY' }
  ]);
  return q.qb.status === 'PARTIAL' && q.injuries.status === 'UNAVAILABLE' && q.weather.status === 'STALE'
    && !q.coaching && q.player_quality.status === 'AVAILABLE' && /research only/.test(q.player_quality.note)
    && G.qualityStatus(q.qb, 'qb', NOW) === 'PARTIAL';
})());
chk('decimal to American', near(R.decimalToAmerican(1.9090909), -110, 1e-3) && near(R.decimalToAmerican(2.5), 150) && R.decimalToAmerican(1) === null);

/* ---- 7. collective ----------------------------------------------------- */
(function () {
  const col = [
    { model_id: 'a/1', name: 'A', home_line: -6, home_win_prob: 0.66, line_at_submission: -2.5 },
    { model_id: 'b/1', name: 'B', home_line: -5.5 },
    { model_id: 'c/1', name: 'C', home_line: -7 },
    { model_id: 'd/1', name: 'D', home_line: 1 }
  ];
  const c = G.build({ game, now: NOW, model: { home_line: -12, model_id: 'edgedesk', captured_at: NOW }, market, collective: col });
  chk('agreement: 4 models, 3 lean home of -3.5', c.collective.n === 4 && c.collective.agreement.lean.home === 3);
  chk('each member carries gap, lean, prob gap, movement and room status', (() => {
    const a = c.collective.members[0];
    return near(a.market_gap, 2.5) && a.lean === 'home' && a.prob_gap != null && a.movement.toward_model_points === 1 && a.room;
  })());
  chk('D is the lone model on the away side', c.collective.members[3].room.lone === true);
  chk('EdgeDesk 6 pts off the room median is a strong outlier, not labelled wrong', c.collective.edgedesk_room.status === 'strong'
    && !/wrong|fade|lock/i.test(JSON.stringify(c.collective.edgedesk_room)));
  chk('3 of 4 agree with EdgeDesk: MODEL_CONSENSUS raised', c.flags.flags.some((f) => f.key === 'MODEL_CONSENSUS'));
  chk('without a correlation history independence is not stated', c.collective.effective_independent === null && /no correlation/.test(c.collective.independence_note));
})();

/* ---- 8. research queue language --------------------------------------- */
chk('flags carry their rule; priority is documented as not a probability', o.flags.flags.every((f) => f.rule)
  && /not a probability or a recommendation/.test(o.flags.priority_rule));
chk('no flag or rule speaks in picks', !/BEST BET|LOCK|GUARANTEE|SMASH/i.test(JSON.stringify(G.FLAG_RULES)));

/* ---- 9. history --------------------------------------------------------- */
(function () {
  const recs = [];
  const eid = eng.engine;
  for (let i = 0; i < 30; i++) recs.push({ model_id: eid, sport: 'CFB', game_id: 'h' + i,
    kickoff_at: new Date(Date.UTC(2025, 8, 1 + i, 18)).toISOString(), predicted_at: new Date(Date.UTC(2025, 8, 1 + i, 1)).toISOString(),
    final_at: new Date(Date.UTC(2025, 8, 1 + i, 23)).toISOString(), spread: -7, line_at_prediction: -4 - (i % 5), close_line: -5,
    home_score: 20 + (i % 9), away_score: 17 });
  const rows = E.evaluate(recs).rows;
  const h = G.build({ game, now: NOW, model: { engine: eng, captured_at: '2025-10-10T00:00:00Z' }, market, history: { rows } });
  chk('history gives the edge bucket sample and similar situations with their n', h.history && h.history.bucket.n_rows >= 0
    && h.history.similar && typeof h.history.similar.n === 'number' && h.history.similar.criteria);
  chk('similar situations only use games final before the model\'s capture time', h.history.similar.pool_n === 30);
})();

/* ---- 10. autopsy ------------------------------------------------------- */
(function () {
  const a = G.build({ game, now: NOW, model: { home_line: -9.4, model_id: 'm' }, market: { open: { line: -5 }, current: { line: -5.5 }, close: { line: -6 } },
    result: { final: true, home_score: 24, away_score: 22 } });
  chk('autopsy: model error 7.4, market error 4.0, model not closer', near(a.autopsy.model_margin_error, 7.4) && near(a.autopsy.market_margin_error, 4)
    && a.autopsy.model_closer_than_market === false);
  chk('autopsy: home side at open, lost ATS against -6 on a 2-pt win, CLV +1', a.autopsy.side === 'home' && a.autopsy.ats_vs_close === 'loss' && a.autopsy.clv === 1);
  chk('autopsy with no measured component outcomes blames no component', a.autopsy.components.available === false && /no component is blamed|no decomposition/.test(a.autopsy.components.reason));
  const b = G.build({ game, now: NOW, model: { engine: eng }, market, result: { final: true, home_score: 20, away_score: 10 },
    actual_components: { rating: { value: -1, source: 'box score efficiency' } } });
  chk('autopsy compares only components with a measured actual', b.autopsy.components.rows.length === 1 && b.autopsy.components.rows[0].key === 'rating');
  chk('no autopsy before a final', o.autopsy === null);
})();

/* ---- 10b. watchlist timeline ----------------------------------------- */
(function () {
  const a = G.snapshot(o);
  const eng2 = project({ spread_line: 4.5, total_line: 52.5 });
  const o2 = G.build({ game, now: '2025-10-10T18:00:00Z', model: { engine: eng2 },
    market: Object.assign({}, market, { current: { line: -4.5, captured_at: '2025-10-10T17:32:00Z', source: 'consensus' } }),
    quality: { market: { captured_at: '2025-10-10T17:32:00Z' }, injuries: { captured_at: '2025-10-10T09:00:00Z' } } });
  const ev = G.timelineEvents(a, G.snapshot(o2));
  const mkt = ev.find((e) => e.kind === 'market');
  chk('a market move is an event stamped with the market capture time, not the viewing time', mkt && mkt.from === -3.5 && mkt.to === -4.5
    && mkt.at === '2025-10-10T17:32:00Z', ev);
  chk('an injury report turning fresh is a quality event', ev.some((e) => e.kind === 'quality' && e.key === 'injuries' && e.from === 'STALE' && e.to === 'AVAILABLE'));
  chk('identical snapshots produce no events', G.timelineEvents(a, G.snapshot(o)).length === 0);
  chk('a half-point threshold: a 0.25 move is not an event', G.timelineEvents({ market: { line: -3.5 } }, { market: { line: -3.75, at: 'x' }, seen_at: 'y' }).length === 0);
  chk('a component change is named', (() => {
    const b = JSON.parse(JSON.stringify(a)); const k = Object.keys(b.components)[0];
    b.components[k].value = (b.components[k].value || 0) + 1;
    return G.timelineEvents(a, b).some((e) => e.kind === 'component' && e.key === k);
  })());
})();

/* ---- 11. scenarios ----------------------------------------------------- */
chk('a scenario is labelled hypothetical with baseline, scenario and difference; unsupported ones are dropped', (() => {
  const s = G.build({ game, now: NOW, model: { home_line: -7.2 }, market,
    scenarios: [{ label: 'QB1 unavailable', home_line: -3.8, affected: ['qb'], supported: true }, { label: 'arbitrary', home_line: -20 }] }).scenarios;
  return s.length === 1 && s[0].hypothetical && near(s[0].difference, 3.4) && s[0].affected[0] === 'qb';
})());

done();
