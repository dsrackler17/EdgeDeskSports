#!/usr/bin/env node
/* ===========================================================================
   Market intelligence (football/cfb_market/market_intel.js): tests.

   Synthetic worlds with known answers: the HOME-MARGIN sign convention, the
   canonical quote, the key-number distribution (and its parity with the
   Python reference), half points, price vs point, alternate lines, implied
   margins, consensus snapshots (a stale book never moves the consensus),
   openers and closes, movement (one book vs the market), velocity,
   coordinated moves, RLM (inert), resistance, disagreement, provider
   conflicts, stale quotes, the stale-data failsafe, gap and edge splits, key
   crossings, deterioration, do-not-chase, events (no spam), contradiction,
   large-gap checks, information events, maturity, the challenger, latency,
   scorecards, bet-now-vs-wait, language, the public card — the MANDATORY
   pure-model separation test (a sportsbook line alone never changes a pure
   number) — and a pass over the real Model Lab ledger, with parity against
   lab_core.marketAt.

     node football/cfb_market/tests.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const M = require('./market_intel.js');
const DEC = require(path.join(REPO, 'football', 'cfb_decision', 'decision.js'));
const L = require(path.join(REPO, 'football', 'cfb_lab', 'lab_core.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
const near = (a, b, t) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (t == null ? 1e-9 : t);
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const KICK = '2026-10-03T19:30:00.000Z';
const at = (h) => new Date(T0 + h * 3600000).toISOString();
let qn = 0;
function q(book, homeLine, h, extra) {
  return Object.assign({ quote_id: 'q' + (++qn), game_id: 'G1', source: 'odds_api', book, market_type: 'spread', home_line: homeLine,
    price_home: -110, price_away: -110, observed_at: at(h), kickoff_ts: KICK, is_pregame: true, is_provider_open: false, is_provider_close: false }, extra || {});
}
const PURE = { status: 'PREDICTED', game_id: 'G1', home: 'Texas Tech', away: 'Baylor', projected_margin: 6.2, sigma: 16.0, t_df: 100,
  kickoff: KICK, model_version: 'edgedesk_cfb_v2.1.0', football_prediction_confidence: 80, fair_spread_display: 'Texas Tech -6.0',
  prediction_ts: '2026-09-29T12:00:00Z', neutral_site: false };

/* ------------------------------------------------------ canonical + signs */
{
  const c = M.canonicalQuote({ game_id: 'G1', book: 'dk', source: 'odds_api', market_type: 'spread', home_line: -4.5, price_home: -110, price_away: 150, observed_at: at(0), provider_updated_at: at(-0.1), retrieved_at: at(0) });
  chk('canonical: Texas Tech -4.5 at home -> home_market_margin = +4.5', c[0].side === 'HOME' && c[0].home_market_margin === 4.5 && c[0].line === -4.5);
  chk('canonical: away +4.5 resolves to the SAME market state', c[1].side === 'AWAY' && c[1].line === 4.5 && c[1].home_market_margin === 4.5);
  chk('canonical: sideToHomeMargin(HOME -4.5) = sideToHomeMargin(AWAY +4.5) = +4.5', M.sideToHomeMargin('HOME', -4.5) === 4.5 && M.sideToHomeMargin('AWAY', 4.5) === 4.5);
  chk('canonical: a home underdog +3 is home margin -3; a pick is 0 (never -0)', M.sideToHomeMargin('HOME', 3) === -3 && Object.is(M.sideToHomeMargin('HOME', 0), 0));
  chk('canonical: -110 -> decimal 1.909091, raw implied 0.523810', near(c[0].decimal_odds, 1.909091, 1e-6) && near(c[0].implied_probability_raw, 0.52381, 1e-5));
  chk('canonical: +150 -> decimal 2.5, raw implied 0.4', near(c[1].decimal_odds, 2.5) && near(c[1].implied_probability_raw, 0.4));
  chk('canonical: three timestamps kept apart', c[0].quote_timestamp === at(0) && c[0].provider_timestamp === at(-0.1) && c[0].received_timestamp === at(0));
  const n = M.canonicalQuote({ game_id: 'G1', book: 'dk', market_type: 'spread', home_line: 3, observed_at: at(0) });
  chk('canonical: no captured price -> null odds, never an assumed -110', n[0].american_odds === null && n[0].decimal_odds === null && n[0].implied_probability_raw === null);
  const t = M.canonicalQuote({ game_id: 'G1', book: 'dk', market_type: 'total', total_points: 55.5, price_over: -105, price_under: -115, observed_at: at(0) });
  chk('canonical: a total gives OVER and UNDER at the number', t[0].side === 'OVER' && t[1].side === 'UNDER' && t[0].line === 55.5 && t[0].home_market_margin === null);
}

/* ------------------------------------------------------- key distribution */
{
  const P = M.keyPmf(3, 16, 100);
  const s = P.reduce((a, b) => a + b, 0);
  chk('key pmf: a distribution over -120..120', P.length === 241 && near(s, 1, 1e-12) && P.every((x) => x >= 0));
  chk('key pmf: no ties in college football', P[120] === 0);
  chk('key pmf: 3 and 7 carry more mass than their neighbours', P[123] > P[122] && P[123] > P[124] && P[127] > P[126] && P[127] > P[128]);
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'parity.json'), 'utf8'));
  let worst = 0;
  f.cases.forEach((c) => {
    const Q = M.keyPmf(c.mu, c.sigma, c.df);
    Object.keys(c.p_at).forEach((k) => { worst = Math.max(worst, Math.abs(Q[+k + 120] - c.p_at[k])); });
    c.lines.forEach((l) => { const o = M.outcomeProbs(Q, l.home_line, 'HOME'); worst = Math.max(worst, Math.abs(o.win - l.home_win), Math.abs(o.push - l.push), Math.abs(o.loss - l.home_loss)); });
  });
  chk('key pmf: parity with the Python reference (<= 1e-9)', worst <= 1e-9, worst);
  let wi = 0;
  f.implied.forEach((x) => { wi = Math.max(wi, Math.abs(M.impliedMargin(x.home_line, x.price_home, x.price_away, null, f.sigma_market) - x.implied_margin)); });
  chk('implied margin: parity with the Python reference (<= 1e-3)', wi <= 1e-3, wi);
  const o = M.outcomeProbs(P, -3, 'HOME'), a = M.outcomeProbs(P, -3, 'AWAY');
  chk('outcome: home -3 wins when margin > 3; push on exactly 3', near(o.push, P[123]) && near(o.win, P.slice(124).reduce((x, y) => x + y, 0)));
  chk('outcome: the away side is the mirror of the home side', near(a.win, o.loss) && near(a.loss, o.win) && near(a.push, o.push));
  chk('outcome: a half-point line never pushes', M.outcomeProbs(P, -3.5, 'HOME').push === 0);
  const kn = M.keyNumbers();
  chk('key-number table: the frozen DEV landing shares (|margin| = 3 is the most common)', kn.landing_dev_abs_margin.length >= 30
    && kn.landing_dev_abs_margin[2].k === 3 && kn.landing_dev_abs_margin[2].share === Math.max.apply(null, kn.landing_dev_abs_margin.map((x) => x.share)));
  chk('the artifact is the frozen DEV fit (local method)', M.artifacts.key.method === 'local' && M.artifacts.key.fit.seasons.every((y) => y >= 2016 && y <= 2023));
}

/* -------------------------------------------------------- half points */
{
  const pure = Object.assign({}, PURE, { projected_margin: 3.0 });
  const hv = M.halfPointValue(pure, -3, 'HOME', -110);
  const P = M.keyPmf(3, 16, 100);
  chk('half point: -3 -> -3.5 crosses the key number 3', hv.half_point_worse.integer_in_step === 3 && hv.half_point_worse.key_number === true);
  chk('half point: the EV lost moving off 3 is exactly P(margin = 3) (push -> loss)', near(-hv.half_point_worse.ev_change, P[123], 1e-4));
  chk('half point: -3 -> -2.5 gains P(3) x payout (push -> win)', near(hv.half_point_better.ev_change, P[123] * 100 / 110, 1e-4));
  chk('half point: on 3 it is worth more cents than off a key', hv.half_point_worse.cents > M.halfPointValue(Object.assign({}, pure, { projected_margin: 5 }), -5, 'HOME', -110).half_point_worse.cents);
  const eq = M.priceForEv(M.outcomeProbs(P, -3.5, 'HOME'), M.evAt(M.outcomeProbs(P, -3, 'HOME'), -110));
  chk('half point: the equivalent price at the worse number reproduces the EV', near(M.evAt(M.outcomeProbs(P, -3.5, 'HOME'), eq), M.evAt(M.outcomeProbs(P, -3, 'HOME'), -110), 1e-9));
  chk('half point: the equivalent price is unrounded analysis (rounded only for display)', Math.round(eq) !== eq);
  const np = M.halfPointValue(pure, -3, 'HOME', null);
  chk('half point: without a captured price no EV is computed', np.price_captured === false && np.ev_at_price === null && np.half_point_worse.ev_change === null);
  chk('cents: -110 = 0, +105 = 15, -120 = -10', M.util.cents(-110) === 0 && M.util.cents(105) === 15 && M.util.cents(-120) === -10);
}

/* ---------------------------------------------- price vs point, alternates */
{
  const pure = Object.assign({}, PURE, { projected_margin: -3.0 });          /* home underdog by 3 */
  const cmp = M.comparePricePoint(pure, { book: 'A', home_line: 3, price_home: -125, price_away: 105 }, { book: 'B', home_line: 3.5, price_home: -110, price_away: -110 }, 'HOME');
  const P = M.keyPmf(-3, 16, 100);
  const evA = M.evAt(M.outcomeProbs(P, 3, 'HOME'), -125), evB = M.evAt(M.outcomeProbs(P, 3.5, 'HOME'), -110);
  chk('price vs point: +3 -125 vs +3.5 -110 decided by exact EV', near(cmp.a.ev, Math.round(evA * 1e4) / 1e4) && near(cmp.b.ev, Math.round(evB * 1e4) / 1e4) && cmp.better === (evA > evB ? 'A' : 'B'));
  chk('price vs point: an uncaptured price cannot win', M.comparePricePoint(pure, { home_line: 3 }, { home_line: 3.5, price_home: -110 }, 'HOME').better === 'UNKNOWN_PRICE');
  const alt = M.altLinePrices(PURE, [-7, -6.5, -6, -3], { '-6.5': { price_home: 105, price_away: -125 } });
  const h65 = alt[1].home;
  chk('alternates: every line priced from ONE distribution (fair price -> EV 0)', near(M.evAt(M.outcomeProbs(M.keyPmf(6.2, 16, 100), -6.5, 'HOME'), h65.fair_price), 0, 1e-3));
  chk('alternates: laying less is always priced shorter', alt[3].home.fair_price < alt[0].home.fair_price);
  chk('alternates: an offered alternate stands on its own EV', typeof h65.ev === 'number' && alt[0].home.ev === null);
  const best = M.bestEvQuote(PURE, [q('a', -6.5, 0, { price_home: -105 }), q('b', -6, 0, { price_home: -125 }), q('c', -5.5, 0, { price_home: null }), q('d', -5, -10)], 'HOME', null,
    { now: at(0.5), enabled_books: ['a', 'b', 'c'] });
  chk('best EV quote: enabled books only, stale and unpriced never ranked by EV', best.considered === 3 && best.unpriced === 1 && ['a', 'b'].indexOf(best.best_expected_value_quote.book) >= 0);
  chk('best EV quote: the best NUMBER is reported apart from the best EV', best.best_number.book === 'c');
}

/* ---------------------------------------------------- implied margin */
{
  const a = M.impliedMargin(-3, -120, 100), b = M.impliedMargin(-3, -110, -110), c = M.impliedMargin(-3, 100, -120);
  chk('implied margin: a pricier home side implies a bigger home margin (monotone)', a > b && b > c, [a, b, c]);
  chk('implied margin: -3 -120 sits between -3 and -3.5 on the price-adjusted scale', a > 3 && a < 3.6, a);
}

/* ---------------------------------------------------- consensus snapshots */
{
  /* 45.5 h before kickoff: the odds freshness limit is 6 h (integrity.FRESHNESS.odds) */
  const qs = [q('dk', -3, 9, { price_home: -115, price_away: -105 }), q('fd', -3.5, 9.2), q('mgm', -3, 9.3, { price_home: -105, price_away: -115 }),
    q('consensus', -4, 9.3, { source: 'cfbd' }), q('czr', -4, 1)];
  const s = M.consensusSnapshot(qs, at(10), KICK);
  chk('consensus: the provider average drops out when real books quote', !s.books.some((b) => b.book === 'consensus'));
  chk('consensus: a stale book is listed and counted but never moves the consensus', s.stale_book_count === 1 && s.n_active_books === 3 && s.median_home_line === -3);
  chk('consensus: consensus_margin is the home margin (+3)', s.consensus_margin === 3);
  chk('consensus: best home number (-3) at the better price; best away number +3.5', s.best_home.line === -3 && s.best_home.price === -105 && s.best_away.line === 3.5 && s.best_away.book === 'fd');
  chk('consensus: median, weighted median, mean, trimmed mean, dispersion, uncertainty', s.weighted_median_home_line === -3 && near(s.mean_home_line, -3.1667, 1e-4)
    && typeof s.trimmed_mean_home_line === 'number' && s.dispersion_iqr === 0.25 && s.consensus_uncertainty > 0.25);
  chk('consensus: the freshness limit is integrity.js\'s (6 h inside 48 h of kickoff) and its verdict is carried', s.freshness_limit_hours === 6
    && s.integrity.rule === 'cfb_market_consensus_integrity_v1' && typeof s.integrity.actionable_status === 'string');
  const w = M.consensusSnapshot(qs, at(10), KICK, { weights: { fd: 5 } });
  chk('consensus: an information weight can move the weighted median only', w.weighted_median_home_line === -3.5 && w.median_home_line === -3);
  const lab = L.marketAt(qs.filter((x) => x.book !== 'czr'), at(10), KICK);
  const mine = M.consensusSnapshot(qs.filter((x) => x.book !== 'czr'), at(10), KICK);
  chk('consensus: parity with lab_core.marketAt (median, best numbers) without stale books', lab.current_spread === mine.median_home_line
    && lab.best_available_spread_home === mine.best_home.line && lab.best_available_spread_away === mine.best_away.line && lab.sportsbook_count === mine.n_active_books);
  const none = M.consensusSnapshot([q('dk', -3, -40)], at(1), KICK);
  chk('consensus: nothing inside 36 h -> NO_QUOTES', none.status === 'NO_QUOTES');
  chk('consensus: a quote at or after kickoff is never pregame market', M.consensusSnapshot([q('dk', -3, 60)], at(61), KICK).status === 'NO_QUOTES');
  const out4 = [q('a', -3, 9), q('b', -3.5, 9.1), q('c', -3, 9.2), q('d', -14, 9.3)];
  const so = M.consensusSnapshot(out4, at(10), KICK);
  chk('consensus: a MAD outlier integrity.assessMarket isolates is listed, never used', so.integrity.outlier_quote_ids.length === 1 && so.integrity_excluded_count === 1
    && so.n_active_books === 3 && so.median_home_line === -3);
  const tru = M.consensusSnapshot([q('a', -3, 9, { provider_updated_at: at(1) })], at(10), KICK);
  chk('consensus: TRUE age (integrity.quoteAgeH): a fresh heartbeat of a book last updated 9 h ago is stale', tru.status === 'ALL_STALE_OR_EXCLUDED' && tru.books[0].age_minutes === 540);
}

/* --------------------------------------------------- opener and close */
{
  const qs = [q('dk', -3, 0), q('fd', -2.5, 5), q('dk', -3.5, 6), q('mgm', -3.5, 7)];
  const o = M.trueOpener(qs, KICK, { min_books: 2 });
  chk('opener: the first individual opener of each book is its earliest quote', o.first_individual_openers.find((x) => x.book === 'dk').home_line === -3);
  chk('opener: the first ROBUST opener waits for two fresh books that agree', o.first_robust_consensus_opener.as_of === at(5) && o.first_robust_consensus_opener.n_books === 2);
  const o2 = M.trueOpener(qs.concat([q('czr', -9, 8)]), KICK, { min_books: 2 });
  chk('opener: later quotes never replace an earlier opener', o2.first_robust_consensus_opener.as_of === o.first_robust_consensus_opener.as_of
    && o2.first_individual_openers.find((x) => x.book === 'dk').home_line === -3);
  chk('opener: a one-book market never has a robust opener', M.trueOpener([q('dk', -3, 0), q('dk', -3.5, 3)], KICK).first_robust_consensus_opener === null);
  const kh = (Date.parse(KICK) - T0) / 3600000;
  const cl = M.closingLine([q('dk', -3, kh - 5), q('dk', -4, kh - 1), q('fd', -4.5, kh - 0.5)], KICK);
  chk('close: the last consensus snapshot inside 180 min of kickoff', cl.quality === 'OBSERVED' && cl.closing_home_line === -4.25 && cl.closing_consensus_margin === 4.25 && cl.quote_count === 2);
  const cl2 = M.closingLine([q('dk', -3, kh - 10), q('dk', -3.5, kh + 1, { is_provider_close: true, is_pregame: false })], KICK);
  chk('close: nothing inside the window -> the provider-declared close, labelled', cl2.quality === 'PROVIDER_DECLARED' && cl2.closing_home_line === -3.5);
}

/* ---------------------------------------------------------- movement */
{
  const qs = [q('a', -2.5, 0), q('b', -2.5, 0), q('c', -2.5, 0), q('a', -3, 1), q('b', -3.5, 2), q('c', -3.5, 2.1)];
  const ser = M.snapshotSeries(qs, KICK);
  const mv = M.movement(ser);
  const one = mv.find((x) => x.as_of === at(1)), mkt = mv[mv.length - 1];
  chk('movement: one book moving the median half a point is ONE_BOOK_MOVED', one.classification === 'ONE_BOOK_MOVED' && one.books_moving === 1);
  chk('movement: books moving together is MARKET_MOVED', mkt.classification === 'MARKET_MOVED' && mkt.from_open === 1);
  chk('movement: crossing 3 (home -2.5 -> -3.5) is a key-number crossing', mv.some((x) => x.key_crossings.some((c) => c.key === 3)));
  chk('movement: velocity is smoothed (below the raw rate of the last step)', Math.abs(mkt.line_velocity) < Math.abs(mv.find((x) => x.velocity_raw_pts_per_hour !== 0 && x.as_of === at(2)).velocity_raw_pts_per_hour) + 1e-9);
  const lv = M.lineVelocity(ser);
  chk('velocity: size of move, books moving the same way, time since first move', lv.move_from_open === 1 && lv.books_moving_same_direction >= 1 && lv.time_since_first_move_hours > 0 && /identity/.test(lv.note));
  chk('key crossings: onto, through and off a key', M.keyCrossings(-2.5, -3)[0].event === 'ONTO_KEY' && M.keyCrossings(-2.5, -3.5)[0].event === 'THROUGH_KEY'
    && M.keyCrossings(-7, -6.5)[0].event === 'LEFT_KEY' && M.keyCrossings(-4, -4.5).length === 0);
  const cm = M.coordinatedMoves([q('a', -3, 0), q('b', -3, 0), q('c', -3, 0), q('d', -3, 0), q('a', -3.5, 1), q('b', -3.5, 1.1), q('c', -4, 1.2), q('d', -3, 5), q('d', -2.5, 9)]);
  chk('coordinated move: three of four books moving together within 30 min', cm[0].label === 'COORDINATED_MOVE' && cm[0].books === 3 && cm[0].coordinated_move_score > 0.7);
  chk('coordinated move: a lone move is ONE_BOOK_MOVED, and nothing is ever called steam or sharp', cm[cm.length - 1].label === 'ONE_BOOK_MOVED' && !/steam|sharp/i.test(JSON.stringify(cm)));
  const rl = M.reverseLineMovement(null, { from_open: -1 });
  chk('RLM: inert without ticket or money percentages, never in a decision', rl.status === 'INERT' && rl.decision_use === false);
  const rl2 = M.reverseLineMovement({ ticket_pct_home: 72, money_pct_home: 55, source: 'x', observed_at: at(0) }, { from_open: -1 });
  chk('RLM: with data it is experimental and descriptive only', rl2.status === 'EXPERIMENTAL' && rl2.rlm === true && rl2.decision_use === false);
  const res = M.lineResistance([-2.5, -3, -2.5, -3, -2.5, -3, -2.5].map((x, i) => ({ median_home_line: x, as_of: at(i) })), 3);
  chk('resistance: three approaches to 3 that retreat without crossing', res.status === 'RESISTANCE' && res.touches === 3 && res.key_number);
  chk('resistance: a line that crosses is not resistance', M.lineResistance([-2.5, -3, -3.5].map((x, i) => ({ median_home_line: x, as_of: at(i) })), 3).status !== 'RESISTANCE');
  const dis = M.marketDisagreement({ dispersion_iqr: 2, n_active_books: 5, stale_book_count: 1 });
  chk('disagreement: high dispersion raises uncertainty and is never an edge', dis.class === 'HIGH' && dis.uncertainty_inflation_pts > 0 && /never an edge/.test(dis.note) && dis.possible_causes[0] === 'stale quotes');
  chk('disagreement: a one-book market is unknown, not agreement', M.marketDisagreement({ dispersion_iqr: null, n_active_books: 1 }).class === 'UNKNOWN_SINGLE_BOOK');
}

/* -------------------------------------------- conflicts, stale, failsafe */
{
  const pc = M.providerConflicts([q('draftkings', -3, 0, { source: 'espn' }), q('draftkings', -4, 0.5, { source: 'odds_api', provider_updated_at: at(0.4) })]);
  chk('provider conflict: both feeds preserved, a major difference flagged, the fresher named', pc.length === 1 && pc[0].major && pc[0].action === 'PRESERVE_BOTH' && pc[0].likely_fresher === 'odds_api');
  const st = M.staleQuotes([q('a', -3, 0), q('b', -3, 0), q('c', -3, 0), q('b', -4, 7), q('c', -4, 7.5)], at(8), KICK);
  const sa = st.find((x) => x.book === 'a'), sb = st.find((x) => x.book === 'b');
  chk('stale: an unchanged book while the others moved 1 pt, 8 h old -> STALE', sa.status === 'STALE' && sa.reasons.length === 3, sa);
  chk('stale: a book that moved recently is current', sb.status === 'CURRENT');
  const dv = M.staleQuotes([q('a', -3, 7), q('b', -4.5, 7.5), q('c', -3, 7.6)], at(8), KICK);
  chk('stale: a fresh book that simply disagrees is DIVERGENT_NOT_STALE', dv.find((x) => x.book === 'b').status === 'DIVERGENT_NOT_STALE');
  const fs1 = M.staleDataFailsafe({ observed_at: at(0) }, at(4));
  chk('failsafe: a 4-hour-old quote is MARKET_STALE (integrity code; shown as MARKET DATA STALE), not actionable', fs1.status === 'MARKET_STALE' && fs1.display === 'MARKET DATA STALE' && fs1.actionable === false && fs1.limit_minutes === 180);
  chk('failsafe: a fresh quote is ACTIONABLE', M.staleDataFailsafe({ observed_at: at(0) }, at(1)).status === 'ACTIONABLE');
  chk('failsafe: no timestamp is MARKET_MISSING, never actionable', M.staleDataFailsafe({}, at(1)).status === 'MARKET_MISSING');
  chk('failsafe: the true age counts (provider last update 5 h ago)', M.staleDataFailsafe({ observed_at: at(0.5), provider_updated_at: at(-4) }, at(1)).status === 'MARKET_STALE');
  const one = M.consensusSnapshot([q('dk', -3, 9)], at(10), KICK);
  chk('failsafe: a fresh one-book market keeps integrity\'s MARKET_DEGRADED (one book is a quote, not a consensus)', M.staleDataFailsafe(one, at(10)).status === 'MARKET_DEGRADED');
}

/* ---------------------------------------------------- gap and edges */
{
  const g = M.modelMarketGap(7.2, 4.0);
  chk('gap: EdgeDesk home +7.2 vs market +4.0 -> +3.2 toward home (the brief)', g.raw_signed_gap === 3.2 && g.absolute_gap === 3.2 && g.toward === 'HOME' && g.model_side_is === 'FAVORITE');
  chk('gap: the model on the dog', M.modelMarketGap(1, 4).model_side_is === 'UNDERDOG' && M.modelMarketGap(1, 4).toward === 'AWAY');
  const e = M.modelEdgeVsPriceEdge(6, 5.5, { book: 'X', home_line: -4.5 }, 'HOME');
  chk('model edge vs price edge: EdgeDesk -6, consensus -5.5, book -4.5 -> 0.5 and 1.0', e.model_edge === 0.5 && e.book_price_edge === 1);
  const pure = Object.assign({}, PURE, { projected_margin: -3.5 });
  const ka = M.keyNumberCrossingAlert(6.5, 7, pure, 'HOME', -110);
  chk('key crossing: +6.5 -> +7 recomputes EV (a push appears on 7)', ka && ka.crossings[0].key === 7 && ka.push_before === 0 && ka.push_after > 0.03 && ka.ev_change > 0);
  chk('key crossing: no captured price -> probabilities only', M.keyNumberCrossingAlert(6.5, 7, pure, 'HOME', null).ev_after === null);
  chk('key crossing: no key crossed -> no alert', M.keyNumberCrossingAlert(4, 4.5, pure, 'HOME', -110) === null);
  const pd = M.priceDeterioration({ at: at(0), line: 4, ev: 0.051 }, { at: at(100), line: 2.5, ev: 0.007 });
  chk('deterioration: +4 (EV 5.1%) -> +2.5 (EV 0.7%) = 4.4% of EV gone', pd.edge_decay_since_first_signal === 0.044 && pd.points_moved_against === 1.5);
  const dc = M.doNotChase({ status: 'BET', line: 4 }, { status: 'PASS', line: 1.5 });
  chk('do not chase: the current price decides; a past BET is never retained', dc.status === 'PASS' && dc.thesis_retained === false && dc.flag === 'EDGE_GONE_AT_CURRENT_PRICE');
}

/* ------------------------------------------------------------ events */
{
  const prev = { at: at(0), game_id: 'G1', ev: 0.01, consensus_margin: 3, pure_margin: 6.2 };
  const cur = { at: at(1), game_id: 'G1', ev: 0.05, consensus_margin: 4, pure_margin: 6.2 };
  const ev = M.marketEvents(prev, cur);
  const types = ev.map((x) => x.type);
  chk('events: edge appears and the market moves toward the model (and crosses 3)', types.indexOf('MODEL_EDGE_APPEARS') >= 0 && types.indexOf('MARKET_MOVES_TOWARD_MODEL') >= 0 && types.indexOf('KEY_NUMBER_CROSSED') >= 0);
  const again = M.marketEvents(prev, cur, { last: { MODEL_EDGE_APPEARS: at(0.5), MARKET_MOVES_TOWARD_MODEL: at(0.5), KEY_NUMBER_CROSSED: at(0.5) } });
  chk('events: no repeat inside the cooldown (no spam)', again.length === 0);
  chk('events: an unchanged state emits nothing', M.marketEvents(cur, Object.assign({}, cur, { at: at(2) })).length === 0);
  const gone = M.marketEvents(cur, { at: at(3), game_id: 'G1', ev: 0.0, consensus_margin: 2.5, pure_margin: 6.2 });
  chk('events: edge disappears; the market moves away', gone.some((x) => x.type === 'MODEL_EDGE_DISAPPEARS') && gone.some((x) => x.type === 'MARKET_MOVES_AWAY_FROM_MODEL'));
  const qb = M.marketEvents(prev, Object.assign({}, cur, { qb_event: { at: at(0.5), detail: 'QB ruled out' } }));
  chk('events: QB news reprices the market only when the news came first', qb.some((x) => x.type === 'QB_NEWS_REPRICES_MARKET' && /not proof/.test(x.detail.attribution)));
  const noqb = M.marketEvents(prev, Object.assign({}, cur, { qb_event: { at: at(-1), detail: 'old news' } }));
  chk('events: news older than the previous state is not tied to this move', !noqb.some((x) => x.type === 'QB_NEWS_REPRICES_MARKET'));
  const ca = M.contradictionAlert(PURE, { raw_signed_gap: 4 }, { from_open: -2, classification: 'MARKET_MOVED', books_moving_with_consensus: 3 });
  chk('contradiction: confident model vs a broad market move away -> INVESTIGATE, model untouched', ca.alert === 'MARKET_CONTRADICTION' && ca.severity === 'INVESTIGATE' && /never changed/.test(ca.action));
  chk('contradiction: a move toward the model is no contradiction', M.contradictionAlert(PURE, { raw_signed_gap: 4 }, { from_open: 2, classification: 'MARKET_MOVED' }) === null);
  const ID = require(path.join(REPO, 'football', 'cfb_lab', 'identity.js'));
  const same = ID.sameTeamFn ? ID.sameTeamFn() : ID.sameTeam;
  const swapped = { game_id: 'G1', home_line: 3, home_team: 'Baylor', away_team: 'Texas Tech', kickoff_ts: KICK, observed_at: at(0) };
  const lg = M.largeGapChecks(PURE, swapped, { sameTeam: same, now: at(0.2), qb_certainty: 90, injury_certainty: 90 }, { threshold: 7 });
  chk('large gap: a 9-point gap with the teams swapped fails integrity.validateQuote (identity master) -> review', lg.required && !lg.ok
    && lg.failures.indexOf('WRONG_GAME_ORIENTATION') >= 0 && lg.status === 'REVIEW_BEFORE_BELIEVING');
  const big = M.largeGapChecks(Object.assign({}, PURE, { projected_margin: 16, fair_spread_home_line: -16 }), { game_id: 'G1', home_line: -3, home_team: 'Texas Tech', away_team: 'Baylor', observed_at: at(0) },
    { sameTeam: same, now: at(0.2), qb_certainty: 50, injury_certainty: 90, neutral_site: false });
  chk('large gap: 13 points runs integrity.extremeReview (an unsettled QB fails it)', big.required && big.extreme_review.required && !big.ok && big.failures.some((f) => /^QB/.test(f)));
  chk('large gap: below every trigger no checks are required', M.largeGapChecks(PURE, { game_id: 'G1', home_line: -5 }, {}).required === false);
  const ser = [{ as_of: at(0), consensus_margin: 3 }, { as_of: at(2), consensus_margin: 3 }, { as_of: at(3.5), consensus_margin: 1 }];
  const ie = M.informationEvent({ type: 'QB_RULED_OUT', at: at(3) }, ser);
  chk('information event: market before/after with the timing recorded, never a cause', ie.attribution === 'TIMING_CONSISTENT' && ie.move_pts === -2 && /never claimed/.test(ie.note));
  const ie2 = M.informationEvent({ type: 'QB_RULED_OUT', at: at(3) }, [{ as_of: at(0), consensus_margin: 3 }, { as_of: at(2.9), consensus_margin: 1 }, { as_of: at(4), consensus_margin: 0.5 }], { window_minutes: 60 });
  chk('information event: a market that moved first is MOVED_BEFORE_EVENT', ie2.attribution === 'MOVED_BEFORE_EVENT' || ie2.attribution === 'TIMING_CONSISTENT');
}

/* ------------------------------------ maturity, challenger, latency, scorecards */
{
  const snapA = M.consensusSnapshot([q('a', -3, 0)], at(1), KICK);
  const snapB = M.consensusSnapshot([q('a', -3, 0), q('b', -3, 0), q('c', -3, 0), q('d', -3.5, 0)], at(1), KICK);
  const op = { first_individual_openers: [{ observed_at: at(-60) }] };
  const ma = M.marketMaturity(snapA, op, at(1)), mb = M.marketMaturity(snapB, op, at(1));
  chk('maturity: more books in agreement read as a more mature market; flagged unvalidated', mb.market_maturity_score > ma.market_maturity_score && mb.validated === false);
  const ch = M.challengerMargin(8, 3, { artifact: 't', w_pure: 0.2 });
  chk('challenger: market + w (pure - market), labelled a challenger, frozen', ch.market_adjusted_projection === 4 && ch.role === 'challenger' && /not the EdgeDesk fair line/.test(ch.label) && Object.isFrozen(ch));
  chk('challenger: the frozen artifact weight is a DEV fit in [0, 1]', M.artifacts.challenger.w_pure > 0 && M.artifacts.challenger.w_pure < 1);
  const lt = M.decisionLatency(at(0), '2026-10-01T12:00:01.250Z', '2026-10-01T12:00:02.000Z');
  chk('latency: decision_latency_ms and storage latency', lt.decision_latency_ms === 1250 && lt.storage_latency_ms === 750);
  const recs = [{ side: 'HOME', bet_line: -3, close_line: -4, signal: 'team_strength' }, { side: 'AWAY', bet_line: 4, close_line: 3, signal: 'qb_news' },
    { side: 'AWAY', bet_line: 3, close_line: 3.5, signal: 'qb_news' }, { side: 'HOME', bet_line: -3, close_line: -3, bet_price: -110, close_price: -120, signal: 'stale_line' }];
  const sc = M.clvScorecard(recs);
  chk('CLV scorecard: side-adjusted points, positive rate, mean, median', sc.n === 4 && sc.positive_clv_rate === 0.5 && sc.mean_clv_pts === 0.375 && sc.median_clv_pts === 0.5);
  chk('CLV scorecard: price CLV at the same number (-110 bet, -120 close)', sc.price_clv_pp_same_number > 2);
  const bs = M.clvBySignal(recs);
  chk('CLV by signal', bs.find((x) => x.signal === 'qb_news').n === 2 && bs.find((x) => x.signal === 'team_strength').mean_clv_pts === 1);
  const ts = M.timingScorecard([{ hours_to_kickoff: 80, is_first_quote: true, bet_line: 4, close_line: 3, result: 'W', bet_price: -110, ev_at_entry: 0.05 },
    { hours_to_kickoff: 30, bet_line: 3, close_line: 3, result: 'L', bet_price: null }, { hours_to_kickoff: 1, bet_line: 3, close_line: 3, result: 'W', bet_price: 100 }]);
  chk('timing scorecard: OPEN / 48H / 2H buckets; ROI only at captured prices', ts.map((x) => x.horizon).join() === 'OPEN,48H,2H' && ts[1].roi === null && ts[0].roi === 0.9091 && ts[2].roi === 1);
  const ser = M.snapshotSeries([q('a', 3, 0, { price_away: -105 }), q('a', 3.5, 7, { price_away: -110 }), q('a', 2.5, 20, { price_away: -115 })], KICK);
  const wc = M.waitComparison(ser, at(0.5), 'AWAY', KICK, PURE);
  chk('bet now vs wait: point-in-time line at each horizon, CLV vs the final number', wc[0].consensus_line === -3 && wc[1].consensus_line === -3 && wc[2].consensus_line === -3.5 && wc[3].consensus_line === -2.5
    && wc[4].execution === 'FINAL_PREKICK' && wc[0].clv_vs_final_pts === -0.5 && typeof wc[0].ev_at_execution === 'number');
}

/* ----------------------- MANDATORY: the pure model never follows the market */
{
  global.window = global.window || global;
  require(path.join(REPO, 'football', 'cfb_v2', 'params.js'));
  const E = require(path.join(REPO, 'football', 'cfb_v2', 'engine.js'));
  const ROW = { game_id: 'G1', season: 2026, week: 5, home: 'Texas Tech', away: 'Baylor', neutral_site: false,
    prediction_ts: '2026-09-29T12:00:00Z', feature_ts: '2026-09-29T12:00:00Z', kickoff: KICK, ens_pred: 6.2, sigma: 16.0, ens_sd: 2.0,
    rating_sd_sum: 0.9, fair_total: 55.5, min_games: 4, early_season: false, qb_unsettled_any: 0, qb_missing_any: 0, fcs_game: false,
    qb: { home: { exp_rating: 0.1, backup_rating: -0.1, team_rating: 0.1 }, away: { exp_rating: 0.05, backup_rating: -0.05, team_rating: 0.05 } } };
  const before = JSON.stringify(E.pure(ROW, {}));
  const p1 = E.pure(ROW, {});
  const marketA = [q('dk', -3, 0, { price_home: -110, price_away: -110 }), q('fd', -3.5, 0)];
  const marketB = [q('dk', -10, 0, { price_home: -140, price_away: 120 }), q('fd', -9.5, 0, { price_home: -105, price_away: -115 })];
  const outs = [];
  [marketA, marketB].forEach((mk) => {
    const s = M.consensusSnapshot(mk, at(1), KICK);
    M.bestEvQuote(p1, mk, 'HOME', null, { now: at(1) });
    M.halfPointValue(p1, s.median_home_line, 'HOME', -110);
    M.altLinePrices(p1, [-7, -3, 3], {});
    M.modelMarketGap(p1.projected_margin, s.consensus_margin);
    M.challengerMargin(p1.projected_margin, s.consensus_margin);
    M.keyNumberCrossingAlert(-2.5, -3.5, p1, 'HOME', -110);
    outs.push(M.outcomeProbs(M.keyPmf(p1.projected_margin, p1.sigma, p1.t_df), s.median_home_line, 'HOME').cover_no_push);
  });
  const after = JSON.stringify(E.pure(ROW, {}));
  chk('PURE NEVER FOLLOWS MARKET: changing the sportsbook line alone changes no pure number', before === after && JSON.stringify(p1) === before);
  chk('PURE NEVER FOLLOWS MARKET: fair spread, projected score and win probability identical under two markets',
    JSON.parse(after).fair_spread_home_line === JSON.parse(before).fair_spread_home_line && JSON.parse(after).home_win_prob === JSON.parse(before).home_win_prob
    && JSON.parse(after).fair_total === JSON.parse(before).fair_total);
  chk('PURE NEVER FOLLOWS MARKET: the pure projection is frozen (cannot be written by this layer)', Object.isFrozen(p1));
  chk('PURE NEVER FOLLOWS MARKET: the market CAN change the cover probability (and so EV and the decision)', Math.abs(outs[0] - outs[1]) > 0.1);
  const mi = fs.readFileSync(path.join(__dirname, 'market_intel.js'), 'utf8');
  chk('PURE NEVER FOLLOWS MARKET: this layer never assigns into a pure projection', !/pure\.(projected_margin|sigma|fair_spread_home_line|home_win_prob)\s*=[^=]/.test(mi));
  chk('PURE NEVER FOLLOWS MARKET: the challenger is a separate number, never the fair line', M.challengerMargin(p1.projected_margin, 3).market_adjusted_projection !== p1.projected_margin);
}

/* -------------------------------------------------- words and the card */
{
  chk('language: "sharps are on" is refused', !M.auditMarketLanguage('Sharps are on Texas Tech').ok);
  chk('language: "smart money", "steam move", "RLM proves" refused', !M.auditMarketLanguage('smart money').ok && !M.auditMarketLanguage('a steam move on Baylor').ok
    && !M.auditMarketLanguage('reverse line movement proves it').ok);
  chk('language: lock / guaranteed refused (decision engine rules)', !M.auditMarketLanguage('a lock').ok && !M.auditMarketLanguage('guaranteed winner').ok);
  chk('language: measurable words pass', M.auditMarketLanguage('Books moved together: the consensus moved from -3 to -4 (market moved toward EdgeDesk by 1 point).').ok);
  const snap = M.consensusSnapshot([q('dk', -3.5, 0, { price_home: -115, price_away: -105 }), q('fd', -3, 0, { price_home: null, price_away: null })], at(1), KICK);
  const card = M.marketCard(PURE, snap, { status: 'PASS', side: 'HOME', reasons: ['the price does not clear break-even by the validated margin, or no price was captured'] },
    { from_open: 0.5 }, { home: 'Texas Tech', away: 'Baylor' });
  chk('card: EdgeDesk fair, market, model gap, best available, timing, direction', card.edgedesk_fair === 'Texas Tech -6.0' && card.market === 'Texas Tech -3.25'
    && card.model_gap === 3 && /Texas Tech -3/.test(card.best_available) && card.timing === 'PASS' && card.market_direction === 'moving toward EdgeDesk' && card.language.ok);
  chk('card: an uncaptured best price is said so, never assumed', /price not captured/.test(card.best_available));
}

/* ---------------------------------------------- the real Model Lab ledger */
{
  const dir = path.join(REPO, 'football', 'cfb_lab', 'ledger', '2026', 'quotes');
  const rows = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [];
  const byGame = {};
  rows.forEach((r) => { (byGame[r.game_id] = byGame[r.game_id] || []).push(r); });
  let games = 0, ok = true, parity = true, canon = true;
  Object.keys(byGame).sort().slice(0, 60).forEach((g) => {
    const qs = byGame[g], k = qs[0].kickoff_ts;
    const ord = qs.filter((x) => x.market_type === 'spread' && x.is_pregame && !x.is_provider_open && !x.is_provider_close);
    if (!ord.length) return;
    games++;
    try {
      const ser = M.snapshotSeries(qs, k);
      M.closingLine(qs, k); M.trueOpener(qs, k); M.movement(ser); M.providerConflicts(qs);
      const t = ord[ord.length - 1].observed_at;
      const mine = M.consensusSnapshot(qs, t, k), lab = L.marketAt(qs, t, k);
      if (mine.status === 'OK' && mine.stale_book_count === 0 && lab.current_spread !== mine.median_home_line) parity = false;
      ord.forEach((x) => { const c = M.canonicalQuote(x); if (c[0].home_market_margin !== L.conv.bookToMargin(x.home_line)) canon = false; });
    } catch (e) { ok = false; failures.push('ledger game ' + g + ': ' + e.message); }
  });
  chk('Lab ledger: every captured game replays without error (' + games + ' games)', ok && (games > 0 || rows.length === 0));
  chk('Lab ledger: the consensus equals lab_core.marketAt on the live quotes', parity);
  chk('Lab ledger: every live quote maps to the canonical home margin exactly as the Lab converts it', canon);
}

failures.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
