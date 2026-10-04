#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_edge_pnl.js — THE ARITHMETIC OF THE FLAGGED-EDGE P&L.

   The odds math the brief fixed, case by case:
     +150 win = +1.50 · -110 win = +0.909 · loss = -1 · push = 0
     void = not a bet (no P&L) · no flag price = no P&L, never estimated
   and the rest of what the page relies on: the decimal path equals the
   American path, the tier and market labels, the edge band, folding summary
   rows, the cumulative series, the formatting.

   The SQL twin (supabase/signal_pnl*.sql) is held to the same numbers by
   tools/record/signal_pnl_sql.test.js.

   Run: node tools/record/signal_pnl.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_edge_pnl.js'));
const { kit } = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = kit('flagged-edge P&L arithmetic');
const chk = T.chk;
const near = (a, b, eps) => a !== null && b !== null && Math.abs(a - b) <= (eps || 1e-9);

/* ── the brief's four cases, at American odds ─────────────────────────── */
chk('+150 win = 1.50', P.unitsAmerican(150, 'win') === 1.5, P.unitsAmerican(150, 'win'));
chk('-110 win = 0.909', Math.round(P.unitsAmerican(-110, 'win') * 1000) / 1000 === 0.909 && near(P.unitsAmerican(-110, 'win'), 100 / 110), P.unitsAmerican(-110, 'win'));
chk('loss = -1', P.unitsAmerican(-110, 'loss') === -1 && P.unitsAmerican(250, 'loss') === -1);
chk('push = 0', P.unitsAmerican(-110, 'push') === 0 && P.unitsAmerican(130, 'push') === 0);
chk('void is not a bet: no P&L', P.unitsAmerican(-110, 'void') === null && P.unitsAmerican(-110, 'cancelled') === null && P.unitsAmerican(-110, 'no action') === null);
chk('even money both ways: +100 and -100 win = 1.00', P.unitsAmerican(100, 'win') === 1 && P.unitsAmerican(-100, 'win') === 1);
chk('-250 win = 0.40, +400 win = 4.00', near(P.unitsAmerican(-250, 'win'), 0.4) && P.unitsAmerican(400, 'win') === 4);

/* ── not odds, not a result ───────────────────────────────────────────── */
[0, 50, -50, 99, -99, null, undefined, NaN, 'abc', '', 100001].forEach((o) =>
  chk('not American odds → no P&L: ' + String(o), P.unitsAmerican(o, 'win') === null && P.unitsAmerican(o, 'loss') === null));
chk('an unreadable result → no P&L', P.unitsAmerican(-110, 'tie') === null && P.unitsAmerican(-110, null) === null && P.unitsAmerican(-110, 'pending') === null);
chk('result words are read loosely, never guessed', P.resultOf(' WON ') === 'win' && P.resultOf('Lost') === 'loss' && P.resultOf('PUSH') === 'push'
  && P.resultOf('Canceled') === 'void' && P.resultOf('postponed') === 'void' && P.resultOf('draw') === null && P.resultOf('w') === null);

/* ── the decimal path is the American path ────────────────────────────── */
[150, -110, 100, -100, 250, -250, 1000, -1000, 105, -105, -10000].forEach((a) => {
  const d = P.decimalOf(a);
  chk('decimal path = American path at ' + a, near(P.unitsDecimal(d, 'win'), P.unitsAmerican(a, 'win'), 1e-12) && near(P.decimalOf(P.american(d)), d, 1e-12), [a, d, P.unitsDecimal(d, 'win'), P.unitsAmerican(a, 'win')]);
});
chk('a provider decimal of 1.91 pays 0.91 (that is -109.89, shown as -110)', near(P.unitsDecimal(1.91, 'win'), 0.91) && P.fmtPriceDec(1.91) === '−110');
chk('decimal 2.5 is +150; 2.00 is even money (+100 = -100)', near(P.american(2.5), 150) && P.fmtPriceDec(2.5) === '+150' && P.american(2) === 100);
chk('no real decimal price → no P&L', P.unitsDecimal(1, 'win') === null && P.unitsDecimal(0.5, 'win') === null && P.unitsDecimal(null, 'win') === null
  && P.unitsDecimal(1002, 'win') === null && P.unitsDecimal('x', 'loss') === null);

/* ── one signal → its grade ───────────────────────────────────────────── */
const base = { sig_key: 'e|spreads|KC|-3.5', flagged_at: '2026-09-20T12:00:00Z', closed_at: '2026-09-21T16:30:00Z', market: 'spreads',
  flagged_tier: 'A', flagged_edge: 0.03, flagged_best_dec: 1.91, closing_dec: 1.87, result: 'win' };
const g = (o) => P.grade(Object.assign({}, base, o));
chk('a win at the flag price, and at the close for comparison', g({}).pnl_status === 'graded' && near(g({}).pnl_units, 0.91) && near(g({}).pnl_units_at_close, 0.87) && g({}).stake_units === 1);
chk('never the closing price: the P&L is the flag price', near(g({ closing_dec: 3.0 }).pnl_units, 0.91) && near(g({ closing_dec: 3.0 }).pnl_units_at_close, 2.0));
chk('a loss is -1 at either price', g({ result: 'loss' }).pnl_units === -1 && g({ result: 'loss' }).pnl_units_at_close === -1);
chk('a push is 0, and still a graded bet', g({ result: 'push' }).pnl_units === 0 && g({ result: 'push' }).pnl_status === 'graded');
chk('a void is not a bet: no P&L, no stake, its own status', g({ result: 'void' }).pnl_status === 'void' && g({ result: 'void' }).pnl_units === null && g({ result: 'void' }).stake_units === 0);
chk('no flag price: ungraded, with the reason, and NOT the close price', g({ flagged_best_dec: null }).pnl_status === 'ungraded_missing_price'
  && g({ flagged_best_dec: null }).ungraded_reason === 'no_flag_price' && g({ flagged_best_dec: null }).pnl_units === null && g({ flagged_best_dec: null }).pnl_units_at_close === null);
chk('a flag price that is not a price: ungraded, invalid', g({ flagged_best_dec: 1 }).ungraded_reason === 'invalid_flag_price' && g({ flagged_best_dec: 5000 }).ungraded_reason === 'invalid_flag_price');
chk('closed, not settled: waiting on the result', g({ result: null }).pnl_status === 'ungraded_unsettled' && g({ result: null }).ungraded_reason === 'awaiting_result');
chk('a result nobody can read: not graded, says so', g({ result: 'tie' }).pnl_status === 'ungraded_unsettled' && g({ result: 'tie' }).ungraded_reason === 'unrecognized_result');
chk('not flagged, or neither closed nor settled: no row at all', P.grade(Object.assign({}, base, { flagged_at: null })) === null && P.grade(Object.assign({}, base, { result: null, closed_at: null })) === null);
chk('no closing price: the comparison is blank, the P&L is not', g({ closing_dec: null }).pnl_units_at_close === null && near(g({ closing_dec: null }).pnl_units, 0.91));
chk('tiers: A, B, everything else is an older flag', g({}).tier === 'A' && g({ flagged_tier: 'B' }).tier === 'B' && g({ flagged_tier: null }).tier === 'legacy' && g({ flagged_tier: 'PASS' }).tier === 'legacy');
chk('markets: h2h, spreads, totals, props', g({ market: 'h2h' }).market_type === 'moneyline' && g({}).market_type === 'spread' && g({ market: 'totals' }).market_type === 'total'
  && g({ market: 'player_pass_yds' }).market_type === 'player_prop' && g({ market: 'weird' }).market_type === 'other');
chk('the record is the CLV record\'s rows: an edge of 0.5% to 10% at the flag', g({ flagged_edge: 0.005 }).record_scope === 'record' && g({ flagged_edge: 0.1 }).record_scope === 'record'
  && g({ flagged_edge: 0.0049 }).record_scope === 'outside_edge_band' && g({ flagged_edge: 0.25 }).record_scope === 'outside_edge_band' && g({ flagged_edge: null }).record_scope === 'outside_edge_band');
chk('every grade says which math made it', g({}).calc_version === 'pnl-v1');

/* ── folding summary rows ─────────────────────────────────────────────── */
const rows = [
  { sport_key: 'americanfootball_nfl', sport_title: 'NFL', breakdown: 'sport', flags: 6, graded: 4, wins: 2, losses: 1, pushes: 1, voids: 1, ungraded_missing_price: 1, ungraded_unsettled: 0, outside_edge_band: 2,
    units_won: 0.82, units_risked: 3, close_compared: 3, units_won_at_close: 0.5, units_won_flag_compared: 0.7, units_risked_compared: 2, first_game_date: '2026-09-07', last_game_date: '2026-09-28' },
  { sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF', breakdown: 'sport', flags: '3', graded: '3', wins: '1', losses: '2', pushes: '0', voids: 0, ungraded_missing_price: 0, ungraded_unsettled: 0, outside_edge_band: 0,
    units_won: '-1.5', units_risked: '3', close_compared: 0, units_won_at_close: 0, units_won_flag_compared: 0, units_risked_compared: 0, first_game_date: '2026-08-30', last_game_date: '2026-09-27' },
  { sport_key: 'tennis_atp_us_open', sport_title: 'ATP US Open', breakdown: 'sport', flags: 9, graded: 9, wins: 9, losses: 0, pushes: 0, units_won: 9, units_risked: 9 }
];
const f = P.fold(rows.slice(0, 2));
chk('fold adds counts and units (numbers or numeric strings)', f.graded === 7 && f.wins === 3 && f.losses === 3 && f.pushes === 1 && near(f.units_won, -0.68) && f.units_risked === 6);
chk('ROI = units won / units risked; a push is not risked', near(f.roi_pct, -0.68 / 6 * 100) && near(f.win_pct, 50));
chk('the closing comparison only over rows that have a close', near(f.roi_at_close_pct, 25) && near(f.roi_flag_compared_pct, 35));
chk('not counted = void + no price + waiting', f.not_counted === 2 && f.outside_edge_band === 2);
chk('date range spans the rows', f.first_game_date === '2026-08-30' && f.last_game_date === '2026-09-28');
chk('nothing graded: rates are blank, never 0%', P.fold([]).roi_pct === null && P.fold([]).win_pct === null && P.fold([]).graded === 0);

const tierRows = [
  { sport_key: 'americanfootball_nfl', breakdown: 'sport+tier', tier: 'A', flags: 4, graded: 3, wins: 2, losses: 1, units_won: 0.82, units_risked: 3 },
  { sport_key: 'americanfootball_nfl', breakdown: 'sport+tier', tier: 'B', flags: 2, graded: 1, pushes: 1, units_won: 0, units_risked: 0 },
  { sport_key: 'americanfootball_ncaaf', breakdown: 'sport+tier', tier: 'B', flags: 3, graded: 3, wins: 1, losses: 2, units_won: -1.5, units_risked: 3 },
  { sport_key: 'tennis_atp_us_open', breakdown: 'sport+tier', tier: 'A', flags: 9, graded: 9, wins: 9, units_won: 9, units_risked: 9 },
  { sport_key: 'americanfootball_nfl', breakdown: 'sport+market', market_type: 'spread', flags: 6, graded: 4, units_won: 0.82, units_risked: 3 }
];
const dayRows = [
  { period_start: '2026-09-07', sport_key: 'americanfootball_nfl', tier: 'A', graded: 1, units_won: 0.91 },
  { period_start: '2026-09-07', sport_key: 'americanfootball_ncaaf', tier: 'B', graded: 2, units_won: -2 },
  { period_start: '2026-09-14', sport_key: 'americanfootball_nfl', tier: 'B', graded: 1, units_won: 0 },
  { period_start: '2026-09-14', sport_key: 'tennis_atp_us_open', tier: 'A', graded: 5, units_won: 5 },
  { period_start: '2026-09-21', sport_key: 'americanfootball_nfl', tier: 'A', graded: 2, units_won: -0.09 },
  { period_start: '2026-09-21', sport_key: 'americanfootball_ncaaf', tier: 'B', graded: 1, units_won: 0.5 }
];
const notTennis = (k) => String(k).indexOf('tennis_') !== 0;
const v = P.view(rows.concat(tierRows), dayRows, { keep: notTennis });
chk('a retired sport is left out of every number', v.sports.length === 2 && v.total.graded === 7 && !v.sports.some((s) => /tennis/.test(s.key)));
chk('tiers are folded across sports, A before B', v.tiers[0].tier.key === 'A' && v.tiers[0].graded === 3 && v.tiers[1].tier.key === 'B' && v.tiers[1].graded === 4 && near(v.tiers[1].units_won, -1.5));
chk('no older flags → no empty "older flags" card', v.tiers.length === 2);
chk('the cumulative series runs in date order, per tier', v.series.length === 3 && near(v.series[0].all, -1.09) && near(v.series[2].all, -0.68) && near(v.series[2].A, 0.82) && near(v.series[2].B, -1.5) && v.series[2].bets === 7);
const nfl = P.view(rows.concat(tierRows), dayRows, { keep: notTennis, sport: 'americanfootball_nfl' });
chk('one sport: its own totals, tiers, markets and line', nfl.total.graded === 4 && nfl.tiers[1].graded === 1 && nfl.markets.length === 1 && nfl.markets[0].label === 'Spread' && near(nfl.series[nfl.series.length - 1].all, 0.82));
chk('every view carries its sample label', v.sample.key === 'VERY_SMALL' && P.sampleLabel(20).key === 'SMALL' && P.sampleLabel(50).key === 'DEVELOPING' && P.sampleLabel(100).key === 'MEANINGFUL');

/* ── formatting: 2 decimals on the page, full precision underneath ─────── */
chk('units: sign, two decimals, a real minus', P.fmtUnits(0.909090909) === '+0.91u' && P.fmtUnits(-1) === '−1.00u' && P.fmtUnits(0) === '0.00u' && P.fmtUnits(-0.001) === '0.00u' && P.fmtUnits(null) === '—');
chk('rounding is half-up at the cent (1.005 → 1.01, 2.675 → 2.68)', P.fmtUnits(1.005) === '+1.01u' && P.fmtUnits(2.675) === '+2.68u');
chk('percent and price', P.fmtPct(4.56) === '+4.6%' && P.fmtPct(-11.333) === '−11.3%' && P.fmtPct(null) === '—' && P.fmtAmerican(-109.89) === '−110' && P.fmtAmerican(150) === '+150');
chk('record and tone', P.fmtRecord({ wins: 3, losses: 2, pushes: 1 }) === '3–2–1' && P.tone(0.5) === 'pos' && P.tone(-0.5) === 'neg' && P.tone(0.001) === 'flat');
chk('the method note is the one the brief wrote', P.METHOD_NOTE === '1 unit flat stake at the price when flagged. Pushes = 0. Missing prices are not estimated.');

process.exit(T.done());
