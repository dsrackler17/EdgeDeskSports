#!/usr/bin/env node
/* ============================================================================
   THE CANONICAL MARKET AND THE EXECUTION LAYER — and how the decision engine
   reads them.

     node tools/validation/market_execution.test.js

   MARKET     fresh · stale · missing · outlier · conflicting books · a sharp
              reference breaking a tie · orientation · caller-retired quotes ·
              aggregated capture rows · parity with lib/market_consensus.js ·
              the quality index is gated, never a probability · movement
   EXECUTION  price steps across even money · empirical key numbers per league
              · the half point is worth more on a key number · the ladder is
              monotone and its current row IS the decision · best execution
              is the decision's own quote on a BET · the key-number reason
   ENGINE     one off-market book never creates a BET · an off-market book
              never poisons the books that agree · one consensus line for the
              gap and the market object · versions and the leakage check ·
              a stale NO DECISION still describes its market · speed
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const M = require(path.join(ROOT, 'lib', 'edgedesk_market.js'));
const MC = require(path.join(ROOT, 'lib', 'market_consensus.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_execution.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('  · ' + t); }

const NOW = '2026-10-04T12:00:00Z', FRESH = '2026-10-04T11:50:00Z', OLD = '2026-10-04T08:00:00Z', KICK = '2026-10-04T17:00:00Z';
const pair = (book, hl, ph, pa, t, extra) => [Object.assign({ side: 'home', line: hl, american: ph, book, captured_at: t || FRESH, market_type: 'spread' }, extra || {}), Object.assign({ side: 'away', line: -hl, american: pa, book, captured_at: t || FRESH, market_type: 'spread' }, extra || {})];

/* ================================================================ MARKET */
section('market: fresh, stale, missing');
{
  const qs = [].concat(pair('DraftKings', -3, -110, -110), pair('FanDuel', -3, -108, -112), pair('BetMGM', -3, -110, -110));
  const c = M.canonical({ event_id: 'g1', sport: 'NFL', quotes: qs, selected: qs[1], team: 'Chicago', now: NOW });
  chk('fresh: three books on one number verify', c.verification_status === 'VERIFIED', c.verification_text);
  chk('fresh: side-stated consensus for the selected side (away +3)', c.consensus_line === 3 && c.consensus_home_line === -3, [c.consensus_line, c.consensus_home_line]);
  chk('fresh: age in seconds', c.age_seconds === 600 && c.freshness === 'FRESH', [c.age_seconds, c.freshness]);
  chk('fresh: every canonical field is present', ['event_id', 'sport', 'market_type', 'selection', 'line', 'odds', 'sportsbook', 'captured_at', 'age_seconds', 'orientation', 'verification_status', 'market_depth', 'book_count', 'consensus_line', 'sharp_reference_line', 'best_execution_price', 'source'].every((k) => k in c));
  chk('fresh: quality is an index with its own disclaimer', c.quality.score >= 80 && /not a probability/.test(c.quality.note), c.quality);
  const st = [].concat(pair('DraftKings', -3, -110, -110, OLD), pair('FanDuel', -3, -108, -112, OLD));
  const s = M.canonical({ sport: 'NFL', quotes: st, selected: st[0], now: NOW });
  chk('stale: a 4-hour-old quote is STALE', s.verification_status === 'STALE' && s.freshness === 'STALE', s.verification_status);
  chk('stale: quality is capped, whatever else holds', s.quality.score <= 30 && s.quality.caps.length > 0, s.quality);
  chk('stale: a stale-only consensus says so', M.consensus(st, { sport: 'NFL', now: NOW }).stale_only === true);
  const none = M.canonical({ sport: 'NFL', quotes: [], selected: null, now: NOW });
  chk('missing: no quote is NO_QUOTE, never a zero line', none.verification_status === 'NO_QUOTE' && none.consensus_line === null && none.line === null, none);
  chk('missing: nothing measurable reads UNMEASURED, not 0', none.quality.score === null && none.quality.label === 'UNMEASURED', none.quality);
  const retired = pair('DraftKings', -3, -110, -110, FRESH, { fresh: false });
  chk('a quote its source retired is not revived by its age', M.canonical({ sport: 'NFL', quotes: retired, selected: retired[0], now: NOW }).freshness === 'STALE');
  chk('a capture time in the future is a clock fault', M.freshness('2026-10-04T13:00:00Z', NOW).state === 'FUTURE');
  chk('no capture time is UNKNOWN', M.freshness(null, NOW).state === 'UNKNOWN');
}
section('market: outliers, conflicting books, the sharp reference');
{
  const qs = [].concat(pair('DraftKings', -1, -110, -110), pair('FanDuel', -1, -112, -108), pair('BetMGM', -1.5, -105, -115), pair('Caesars', -3.5, -110, -110), pair('Pinnacle', -1, -104, -106));
  const c = M.consensus(qs, { sport: 'NFL', now: NOW });
  chk('outlier: Caesars 2.5 pts off the median is named', c.outliers.length === 1 && c.outliers[0].book === 'Caesars' && c.outliers[0].off_by === -2.5, c.outliers);
  chk('outlier: the weighted mean is taken without it', Math.abs(c.weighted_mean - (-1.1)) < 1e-6, c.weighted_mean);
  chk('outlier: the consensus is a number books deal', c.consensus === -1);
  chk('sharp reference reported beside, never as, the consensus', c.sharp_reference && c.sharp_reference.value === -1 && c.sharp_reference.books[0] === 'Pinnacle');
  const can = M.canonical({ sport: 'NFL', quotes: qs, selected: qs[7], team: 'Chicago', now: NOW });
  chk('outlier: the exact sentence', can.verification_text === 'PRICE ANOMALY — Caesars: Chicago +3.5. Consensus: Chicago +1. The quote is 2.5 points away from consensus. EdgeDesk will not promote this to BET until verified.', can.verification_text);
  chk('outlier: OUTLIER status and a capped quality index', can.verification_status === 'OUTLIER' && can.quality.score <= 45 && can.selected_is_outlier, [can.verification_status, can.quality.score]);
  const two = [].concat(pair('DraftKings', -1, -110, -110), pair('Caesars', -3.5, -110, -110));
  const c2 = M.consensus(two, { sport: 'NFL', now: NOW });
  chk('two books far apart, no tie-breaker: UNRESOLVED, not two outliers', c2.outliers.length === 0 && c2.unresolved && c2.unresolved.apart === 2.5, c2);
  const twoS = [].concat(pair('Pinnacle', -1, -105, -105), pair('Caesars', -3.5, -110, -110));
  const c3 = M.consensus(twoS, { sport: 'NFL', now: NOW });
  chk('two books, one sharp: the other is the outlier', c3.outliers.length === 1 && c3.outliers[0].book === 'Caesars' && c3.outliers[0].against === 'sharp reference', c3.outliers);
  const cfb = [].concat(pair('A', -7, -110, -110), pair('B', -7, -110, -110), pair('C', -8, -110, -110));
  chk('a league tolerance: 1 pt is an outlier in the NFL, not in college', M.consensus(cfb, { sport: 'CFB', now: NOW }).outliers.length === 0 && M.consensus(cfb, { sport: 'NFL', now: NOW }).outliers.length === 1);
  const split = [{ side: 'away', line: 6.5, american: -102, book: 'FanDuel', captured_at: FRESH, n_books: 2 }, { side: 'home', line: -6.5, american: -118, book: 'FanDuel', captured_at: FRESH, n_books: 2 },
    { side: 'away', line: 3.5, american: -110, book: 'DraftKings', captured_at: FRESH, n_books: 2 }, { side: 'home', line: -3.5, american: -110, book: 'DraftKings', captured_at: FRESH, n_books: 2 }];
  const cs = M.consensus(split, { sport: 'CFB', now: NOW });
  chk('a 2–2 split market has no outlier: it is UNRESOLVED (every book off the median is not one book wrong)', cs.outliers.length === 0 && cs.unresolved && /split/.test(cs.unresolved.text), cs);
  const conf = M.canonical({ sport: 'NFL', quotes: qs, selected: qs[0], now: NOW, orientation: { status: 'AMBIGUOUS', repairs: [], dropped: [{}] } });
  chk('orientation: an ambiguous orientation caps the index', conf.quality.score <= 40 && conf.orientation.certain === false, conf.quality);
}
section('market: parity with lib/market_consensus.js, aggregated captures, totals, moneylines');
{
  let rng = 7; const rand = () => (rng = (rng * 16807) % 2147483647) / 2147483647;
  let agree = 0, n = 0;
  for (let t = 0; t < 300; t++) {
    const k = 1 + Math.floor(rand() * 7), books = [], qs = [];
    for (let i = 0; i < k; i++) { const hl = -Math.round(rand() * 14) / 2 - (rand() < 0.3 ? 0.5 : 0); books.push({ book: 'b' + i, spread: hl }); qs.push.apply(qs, pair('b' + i, hl, -110, -110)); }
    const a = MC.consensus({ books }, NOW).consensus_spread, b = M.consensus(qs, { sport: 'CFB', now: NOW }).consensus;
    n++; if (a === b) agree++;
  }
  chk('the consensus rule is market_consensus.js’s (300 random boards)', agree === n, agree + '/' + n);
  const agg = [{ side: 'home', line: -3, american: -105, book: 'DraftKings', captured_at: FRESH, n_books: 5 }, { side: 'away', line: 3, american: -110, book: 'FanDuel', captured_at: FRESH, n_books: 4 },
    { side: 'home', line: -1, american: -110, book: 'Caesars', captured_at: FRESH, n_books: 1 }, { side: 'away', line: 1, american: -110, book: 'Caesars', captured_at: FRESH, n_books: 1 }];
  const ca = M.consensus(agg, { sport: 'NFL', now: NOW });
  chk('aggregated capture rows count books per number', ca.book_count === 6 && ca.consensus === -3 && /captured numbers/.test(ca.basis_rows), ca);
  chk('aggregated: the off-market number is named', ca.outliers.length === 1 && ca.outliers[0].book === 'Caesars');
  const tot = [{ side: 'over', line: 44.5, american: -110, book: 'A', captured_at: FRESH, market_type: 'total' }, { side: 'under', line: 44.5, american: -110, book: 'A', captured_at: FRESH, market_type: 'total' },
    { side: 'over', line: 44.5, american: -105, book: 'B', captured_at: FRESH, market_type: 'total' }, { side: 'under', line: 44.5, american: -115, book: 'B', captured_at: FRESH, market_type: 'total' },
    { side: 'over', line: 47, american: -110, book: 'C', captured_at: FRESH, market_type: 'total' }, { side: 'under', line: 47, american: -110, book: 'C', captured_at: FRESH, market_type: 'total' }];
  const ct = M.consensus(tot, { market_type: 'total', sport: 'NFL', now: NOW });
  chk('totals: consensus and a 2.5-pt outlier', ct.consensus === 44.5 && ct.outliers.length === 1 && ct.outliers[0].book === 'C', ct);
  const ml = [{ side: 'home', american: -150, book: 'A', captured_at: FRESH, market_type: 'moneyline' }, { side: 'away', american: 130, book: 'A', captured_at: FRESH, market_type: 'moneyline' },
    { side: 'home', american: -145, book: 'B', captured_at: FRESH, market_type: 'moneyline' }, { side: 'away', american: 125, book: 'B', captured_at: FRESH, market_type: 'moneyline' }];
  const cm = M.consensus(ml, { market_type: 'moneyline', sport: 'NFL', now: NOW });
  chk('moneyline: the consensus is a no-vig probability', cm.consensus > 0.57 && cm.consensus < 0.59 && cm.dispersion.unit === 'pp', cm);
}
section('market: movement is described, never attributed');
{
  const h = [{ at: '2026-10-04T08:00:00Z', value: -3 }, { at: '2026-10-04T10:00:00Z', value: -2.5 }, { at: '2026-10-04T10:20:00Z', value: -1 }];
  const mv = M.movement(h, { sport: 'NFL', fair: 0.5, evaluated_at: '2026-10-04T10:05:00Z', now: NOW, keys: [3, 7] });
  const codes = mv.indicators.map((i) => i.code);
  chk('opening, current, high, low', mv.opening.value === -3 && mv.current.value === -1 && mv.high === -1 && mv.low === -3);
  chk('toward the model since the open', codes.indexOf('LINE_MOVED_TOWARD_MODEL') >= 0, codes);
  chk('confirming after the evaluation', codes.indexOf('MARKET_CONFIRMING') >= 0, codes);
  chk('a fast move is STEAM-LIKE and says it does not know who moved it', codes.indexOf('STEAM_LIKE_MOVE') >= 0 && /does not know who caused it/.test(mv.indicators.filter((i) => i.code === 'STEAM_LIKE_MOVE')[0].text));
  chk('no word of sharp money', !/sharp money|wiseguy|syndicate/i.test(JSON.stringify(mv)));
  chk('moving off a key number is named', codes.indexOf('KEY_NUMBER_TOUCHED') >= 0, codes);
  const away = M.movement([{ at: '2026-10-04T08:00:00Z', value: -1 }, { at: '2026-10-04T11:00:00Z', value: -3 }], { sport: 'NFL', fair: 0.5, evaluated_at: '2026-10-04T09:00:00Z', now: NOW, keys: [3] });
  chk('against the model, and rejecting after the evaluation', away.indicators.some((i) => i.code === 'LINE_MOVED_AGAINST_MODEL') && away.indicators.some((i) => i.code === 'MARKET_REJECTING'), away.indicators);
  chk('no history is unavailable, not a zero move', M.movement([], {}).available === false);
}

/* ============================================================= EXECUTION */
section('execution: prices, key numbers, the half point');
{
  chk('−110 + 5 cents = −105', X.stepPrice(-110, 5) === -105);
  chk('−105 + 5 cents = even money', X.stepPrice(-105, 5) === 100);
  chk('−103 + 5 cents crosses to +102', X.stepPrice(-103, 5) === 102);
  chk('+100 − 5 cents = −105', X.stepPrice(100, -5) === -105);
  const K = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'key_numbers.json'), 'utf8'));
  const nfl = K.leagues.NFL.key_numbers, cfb = K.leagues.CFB.key_numbers;
  chk('NFL key numbers come from ' + K.leagues.NFL.n_games + ' final margins: 3 and 7 primary', nfl.primary.indexOf(3) >= 0 && nfl.primary.indexOf(7) >= 0, nfl);
  chk('the leagues differ: 21 is a CFB key, not an NFL one', cfb.secondary.indexOf(21) >= 0 && nfl.secondary.indexOf(21) < 0 && nfl.primary.indexOf(21) < 0, [nfl, cfb]);
  chk('NFL 3 carries more mass than CFB 3', K.leagues.NFL.abs_margin_mass[3] > K.leagues.CFB.abs_margin_mass[3] + 0.03);
  chk('the key-number table is rebuilt from the archive, not typed', JSON.stringify(require(path.join(ROOT, 'tools', 'validation', 'build_key_numbers.js')).build().leagues.NFL.key_numbers) === JSON.stringify(nfl));
  const pw = (sport, fair) => (side, line) => Q.sideProb((t) => E.dist.coverProbSpread(sport, fair, t), side, line);
  const hp3 = X.halfPointValue(pw('nfl', -2), 'home', 2.5, 3), hp9 = X.halfPointValue(pw('nfl', -8), 'home', 8.5, 9);
  chk('NFL: +2.5 → +3 is worth more than +8.5 → +9 (the distribution, not a rule)', hp3.half_push_gain > hp9.half_push_gain + 0.01, [hp3, hp9]);
  chk('NFL: landing on 3 buys a push the hook does not', hp3.push_mass_to > 0.07 && hp3.push_mass_from === 0, hp3);
}

/* the NFL fixtures, as tools/bettor/football_decision.test.js builds them */
const NFL_VAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'pricing_nfl.json'), 'utf8'));
function nflModel(fair, blendAt) {
  return { sport: 'NFL', available: true, model_version: 'edgedesk_football_v1.0.0', fair_home_margin: fair, home_cover: (t) => E.dist.coverProbSpread('nfl', fair, t), tail: { validated_within_pts: 0 },
    projection_timestamp: '2026-10-04T06:00:00Z',
    adjusted: blendAt != null ? D.blendAdjusted({ validation: NFL_VAL.markets.spread, model_home_margin: fair, market_home_line: blendAt, cover: (c, t) => E.dist.coverProbSpread('nfl', c, t), version: 'pricing_nfl' }) : { available: false } };
}
const qq = (side, line, am, book, extra) => Object.assign({ game_id: 'g', side, line, american: am, book: book || 'DraftKings', captured_at: FRESH, fresh: true, n_books: 1 }, extra || {});
function decide(fair, quotes, extra) {
  return D.decide(Object.assign({ sport: 'NFL', game: { game_id: 'g', home: 'Miami Dolphins', away: 'Buffalo Bills', kickoff: KICK }, model: nflModel(fair, extra && extra.blendAt), quotes, now: Date.parse(NOW),
    qb: { known: true }, availability: { known: true }, reliability: { score: 85 }, confidence: { score: 80 }, projection: { stability: 'STABLE' } }, extra || {}));
}
const board = (hl, extra) => [qq('home', hl, -110), qq('away', -hl, -110), qq('home', hl, -112, 'FanDuel'), qq('away', -hl, -108, 'FanDuel'),
  qq('home', hl + 0.5, -120, 'DraftKings', { market_type: 'alternate_spread' }), qq('home', hl - 0.5, 102, 'DraftKings', { market_type: 'alternate_spread' })].concat(extra || []);

section('execution: the ladder IS the decision, and moves one way');
{
  let agree = 0, n = 0, mono = 0, monoN = 0, bestIsBet = 0, bets = 0;
  const sweep = [];
  for (let fair = -16; fair <= -4; fair += 0.5) for (const hl of [3, 7, 10]) sweep.push([fair, hl]);
  sweep.forEach(([fair, hl]) => {
    const d = decide(fair - (10 - hl), board(hl));
    if (d.evaluation_status !== 'EVALUABLE') return;
    n++;
    if (d.price_curve && d.price_curve.self_check && d.price_curve.self_check.agrees) agree++;
    const rows = (d.price_curve.points || []).filter((p) => p.odds === d.price_curve.odds && p.line != null).sort((a, b) => a.line - b.line);
    const rk = { PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };
    let ok = true;
    for (let i = 1; i < rows.length; i++) { const a = rk[rows[i - 1].cls] * 10 + (rows[i - 1].units || 0), b = rk[rows[i].cls] * 10 + (rows[i].units || 0); if (b < a - 1e-9) ok = false; }
    monoN++; if (ok) mono++;
    if (d.decision === 'BET') { bets++; const b = d.best_execution && d.best_execution.best; if (b && b.book === d.bet_price.book && b.line === d.bet_price.line && b.odds === d.bet_price.odds) bestIsBet++; }
  });
  chk('the ladder’s current row agrees with the engine (' + n + ' decisions)', agree === n && n > 30, agree + '/' + n);
  chk('more points never lowers the decision or the stake (' + monoN + ' ladders)', mono === monoN, mono + '/' + monoN);
  chk('on a BET, best execution is the BET’s own quote (' + bets + ' BETs): one answer, never two', bets > 5 && bestIsBet === bets, bestIsBet + '/' + bets);
  const d = decide(-11.5, board(10));
  chk('the ladder shows transition points only (≤ 7 rows per axis)', d.ladder.by_line.length <= 7 && d.ladder.by_price.length <= 7, d.ladder);
  chk('the ladder names its axis and marks now', /At -110: .*\(now\)/.test(d.ladder.summary), d.ladder.summary);
  chk('WATCH → BET appears on the line axis', /WATCH/.test(d.ladder.summary_line || '') && /BET 0\.25U/.test(d.ladder.summary_line || ''), d.ladder.summary_line);
  chk('the ladder is computed from the rules, with its caveat', /holding the rest of the market/.test(d.ladder.caveat));
}
section('execution: best execution explains the points-vs-juice trade');
{
  /* NFL, Miami +2.5 (+100) vs +3 (−120): landing on 3 */
  const quotes = [qq('home', 2.5, 100, 'Hard Rock'), qq('away', -2.5, -120, 'Hard Rock'), qq('home', 2.5, 100, 'BetMGM'), qq('away', -2.5, -120, 'BetMGM'),
    qq('home', 3, -118, 'FanDuel', { market_type: 'alternate_spread' }), qq('home', 3.5, -135, 'FanDuel', { market_type: 'alternate_spread' })];
  const cands = [];
  const d = decide(-1, quotes);
  const be = X.bestExecution(d.candidates, { side: 'home', market_type: 'spread', market: d.market, max_age_minutes: 90, pushMass: (side, k) => Q.sideProb((t) => E.dist.coverProbSpread('nfl', -1, t), side, k).push });
  chk('best execution names a runner-up and a reason', be.best && be.alternative && typeof be.reason === 'string' && be.reason.length > 20, be);
  const withKey = X.explain({ label: 'Miami +3 (-118)', side: 'home', market_type: 'spread', line: 3, odds: -118, book: 'FanDuel', calibrated_ev: 0.062, decision_ev: 0.062 },
    { label: 'Miami +2.5 (+100)', side: 'home', market_type: 'spread', line: 2.5, odds: 100, book: 'Hard Rock', calibrated_ev: 0.048, decision_ev: 0.048 },
    { pushMass: (side, k) => Q.sideProb((t) => E.dist.coverProbSpread('nfl', -1, t), side, k).push });
  chk('the key-number sentence: crosses 3, higher calibrated EV despite the juice', /crosses a key number \(3: .*%.*\) and produces higher calibrated EV \(\+6\.2% calibrated EV vs \+4\.8% calibrated EV\) despite the additional juice \(-118 vs \+100\)/.test(withKey), withKey);
  const sameLine = X.explain({ line: 3, odds: -105, book: 'A', decision_ev: 0.05 }, { line: 3, odds: -110, book: 'B', decision_ev: 0.04 }, {});
  chk('same number: a better price at another book', /Same number, better price: -105 at A against -110 at B/.test(sameLine), sameLine);
  const unv = X.bestExecution([{ side: 'home', line: 3, odds: -110, book: 'A', price_unverified: true, decision_ev: 0.2, classification: 'BET', label: 'x' }, { side: 'home', line: 2.5, odds: -110, book: 'B', decision_ev: 0.05, classification: 'BET', label: 'y', is_main_line: true }], { side: 'home' });
  chk('an unverified price is never the execution', unv.best.book === 'B' && unv.excluded[0].why === 'failed price verification', unv);
  const off = X.bestExecution([{ side: 'home', line: 3, odds: -110, book: 'Caesars', decision_ev: 0.2, classification: 'BET', label: 'x' }, { side: 'home', line: 2.5, odds: -110, book: 'B', decision_ev: 0.05, classification: 'BET', label: 'y' }], { side: 'home', market: { outliers: [{ book: 'Caesars' }] } });
  chk('an off-market book is never the execution', off.best.book === 'B' && /off the market/.test(off.excluded[0].why), off);
}

/* ================================================================ ENGINE */
section('engine: one anomalous sportsbook cannot create a BET');
{
  /* the market deals Miami −10 at three books; Caesars alone deals −6.5 */
  const agreeing = [qq('home', -10, -110), qq('away', 10, -110), qq('home', -10, -110, 'FanDuel'), qq('away', 10, -110, 'FanDuel'), qq('home', -10, -110, 'BetMGM'), qq('away', 10, -110, 'BetMGM')];
  const outlier = [qq('home', -6.5, -110, 'Caesars'), qq('away', 6.5, -110, 'Caesars')];
  /* the model makes Miami by 12: only the off-market −6.5 would qualify */
  const d = decide(12, agreeing.concat(outlier)), alone = decide(12, agreeing);
  chk('only the off-market quote would qualify: not a BET', d.decision !== 'BET', [d.decision_display, d.action && d.action.selection]);
  chk('… WATCH · PRICE ANOMALY on it', d.decision === 'WATCH' && d.action_reason_code === 'PRICE_ANOMALY', [d.decision_display, d.action_reason_code]);
  const c = (d.candidates || []).filter((x) => x.book === 'Caesars' && x.side === 'home')[0];
  chk('the off-market quote failed verification', c && c.price_unverified === true, c);
  const tr = ((d.anomaly && d.anomaly.triggers) || []).map((t) => t.code);
  chk('its review names QUOTE_OUTLIER', tr.indexOf('QUOTE_OUTLIER') >= 0, tr);
  chk('the WATCH says exactly why', /Caesars: Miami Dolphins -6\.5\. Consensus: Miami Dolphins -10\. The quote is 3\.5 points away from consensus\. EdgeDesk will not promote this to BET until verified\./.test(JSON.stringify(d.anomaly)), d.anomaly && d.anomaly.triggers);
  chk('BOOK ON MARKET fails; the other books’ agreement does not', (d.anomaly.checks || []).some((x) => x.code === 'BOOK_ON_MARKET' && x.status === 'FAIL') && (d.anomaly.checks || []).some((x) => x.code === 'BOOK_AGREEMENT' && x.status === 'PASS'), d.anomaly.checks);
  chk('without the outlier the same model is not a BET either', alone.decision !== 'BET');
  chk('the outlier is never the best execution', !(d.best_execution && d.best_execution.best && d.best_execution.best.book === 'Caesars'), d.best_execution);
  /* the model makes Miami by 9: the agreeing books decide, the outlier changes nothing */
  for (const fair of [8, 9, 10, 11]) {
    const w = decide(fair, agreeing.concat(outlier)), wo = decide(fair, agreeing);
    chk('fair ' + fair + ': the agreeing books decide as if the outlier were absent', w.decision === wo.decision && w.recommended_units === wo.recommended_units && (w.bet_price || w.reference_quote || {}).book !== 'Caesars', [w.decision_display, wo.decision_display]);
  }
  chk('the canonical market names the outlier', d.market && d.market.outliers.some((o) => o.book === 'Caesars'), d.market && d.market.outliers);
}
section('engine: the model must agree with itself');
{
  /* EdgeDesk makes Miami +11.5; the market deals +10. The NFL raw distribution
     is off-centre here (the distribution audit) and says +10 covers ~59%. */
  const d = decide(-11.5, board(10));
  chk('a fair line on the other side of the number with cover > 50% is WATCH · MODEL CONFLICT, never a BET', d.decision === 'WATCH' && d.action_reason_code === 'MODEL_CONFLICT', [d.decision_display, d.action_reason_text]);
  chk('… and it says what it saw', /Miami Dolphins \+10 against a fair \+11\.5, model cover \d/.test(d.action_reason_text), d.action_reason_text);
  chk('the ladder applies the rule at every number: +11 (inside the band) is where it would bet', /\+11 BET/.test(d.ladder.summary_line || ''), d.ladder.summary_line);
  chk('inside the aligned band there is no conflict (+10.5 fair vs +10)', decide(-10.5, board(10)).action_reason_code !== 'MODEL_CONFLICT');
  const alt = decide(-10, board(10).concat([qq('home', 6.5, 260, 'DraftKings', { market_type: 'alternate_spread' })]));
  const c = (alt.candidates || []).filter((x) => x.line === 6.5)[0];
  chk('a plus-money alternate on the other side is not a conflict (its cover is under 50%)', c && c.decision_cover < 0.5, c);
  let bad = 0, n = 0;
  for (let fair = -14; fair <= -4; fair += 0.25) {
    const x = decide(fair, board(10));
    if (x.decision !== 'BET') continue;
    n++;
    const f = x.canonical.decision_fair_home_spread != null ? x.canonical.decision_fair_home_spread : x.canonical.fair_home_spread;
    const fSide = x.bet_price.side === 'home' ? f : -f;
    if (x.bet_price.line - fSide < -0.5 - 1e-9 && x.probability > 0.5) bad++;
  }
  chk('no BET anywhere on a sweep where the model’s own fair line disagrees (' + n + ' BETs)', bad === 0 && n > 5, [bad, n]);
}
section('engine: one consensus line, versions, leakage');
{
  const d = decide(-11.5, board(10, [qq('home', 9.5, -110, 'BetMGM'), qq('away', -9.5, -110, 'BetMGM')]));
  chk('the gap and the market object read one consensus line', d.canonical.market_home_spread === d.market.consensus_home_line, [d.canonical.market_home_spread, d.market.consensus_home_line]);
  chk('the market object reads the decision’s own quote', d.market.sportsbook === (d.bet_price || d.reference_quote).book && d.market.line === (d.bet_price || d.reference_quote).line);
  chk('best execution price is on the market object', d.market.best_execution_price && d.market.best_execution_price.label === d.best_execution.best.label);
  const v = d.versions;
  chk('every version is recorded', v && v.model && v.pricing_engine && v.decision_engine && v.decision_rules && v.market_engine && v.execution_engine && /^dv_/.test(v.version_key), v);
  chk('the data snapshot is the newest input', v.data_snapshot_at === new Date(FRESH).toISOString() && d.data_snapshot_at === v.data_snapshot_at, v);
  chk('pregame and leakage-clean', v.pregame === true && v.leakage_ok === true && v.inputs_after_evaluation === 0, v);
  const leak = decide(-11.5, board(10, [qq('home', 10, -110, 'Late', { captured_at: '2026-10-04T13:30:00Z' })]));
  chk('a quote captured after the evaluation is flagged', leak.versions.leakage_ok === false && leak.versions.inputs_after_evaluation === 1, leak.versions);
  const cal = decide(-11.5, board(10), { blendAt: -10 });
  chk('the calibration version travels with the decision', cal.versions.calibration === 'pricing_nfl' && cal.versions.version_key !== v.version_key);
  chk('evaluation mode defaults to LIVE and can be declared', d.evaluation_mode === 'LIVE' && decide(-11.5, board(10), { evaluation_mode: 'backtest' }).evaluation_mode === 'BACKTEST');
}
section('engine: a NO DECISION still describes its market');
{
  const stale = board(10).map((q) => { const x = Object.assign({}, q, { captured_at: OLD }); delete x.fresh; return x; });
  const d = decide(-11.5, stale);
  chk('stale quotes: NO DECISION', d.decision === 'NO_DECISION' && d.blocker_codes.indexOf('STALE_QUOTE') >= 0, d.blocker_codes);
  chk('… and the canonical market says the market is stale', d.market && d.market.book_count >= 2 && M.consensus(stale, { sport: 'NFL', now: NOW }).stale_only === true, d.market);
}
section('engine: totals and moneylines carry the same blocks');
{
  const quotes = [qq('over', 44.5, -110, 'A', { market_type: 'total' }), qq('under', 44.5, -110, 'A', { market_type: 'total' }), qq('over', 44.5, -108, 'B', { market_type: 'total' }), qq('under', 44.5, -112, 'B', { market_type: 'total' }),
    qq('over', 48.5, -110, 'C', { market_type: 'total' }), qq('under', 48.5, -110, 'C', { market_type: 'total' })];
  const model = nflModel(-3); model.total_cover = (t) => E.dist.coverProbTotal('nfl', 49, t, 'over'); model.total_calibration = { validated: false, reason: 'test' };
  const d = D.decide({ sport: 'NFL', market_type: 'total', game: { game_id: 'g', home: 'H', away: 'A', kickoff: KICK }, model, quotes, now: Date.parse(NOW), qb: { known: true }, availability: { known: true } });
  chk('total: a canonical market with the off-market book named', d.market && d.market.market_type === 'total' && d.market.outliers.some((o) => o.book === 'C'), d.market);
  chk('total: the off-market book is not the recommendation', !(d.reference_quote && d.reference_quote.book === 'C') && !(d.bet_price && d.bet_price.book === 'C'), d.reference_quote);
  chk('total: a ladder and versions', d.ladder && d.versions && d.versions.version_key, d.ladder);
}
section('performance: the execution layer is cheap enough for a full board');
{
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) decide(-8 - (i % 12) * 0.5, board(10));
  const each = (Date.now() - t0) / 60;
  chk('a decision with its ladder and execution in < 25 ms (' + each.toFixed(1) + ' ms)', each < 25, each);
}

console.log(fail ? 'FAILURES:\n  ' + failures.join('\n  ') : '');
console.log((fail ? 'FAIL' : 'ALL GREEN') + ' market & execution — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
