#!/usr/bin/env node
/* ===========================================================================
   ODDS HELPER CONSOLIDATION — PARITY.

   The edge-function kernels (EDPRICE, EDBOARD, EDSTAKE, EDDESK) each carried a
   byte-identical copy of amToDec / decToAm / breakEven / devig2 / probToAm.
   They now call lib/research_core.js `R.odds`. This test pins the OLD bodies
   (copied verbatim below) and proves the canonical ones return exactly the
   same value for every input in a grid that includes the awkward ones, and
   that each migrated kernel still does.

   It also pins the documented DIFFERENCES that keep the strict helpers
   separate: americanToDecimal refuses |a| < 100, decimalToAmerican does not
   round, and EDINTEL's impliedProb takes a decimal price.

   See docs/odds-helpers-audit.md. Run: node tools/research/odds_parity.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'research_core.js'));
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }

/* ---- the OLD kernel bodies, verbatim ---------------------------------- */
function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
function r4(v) { var n = num(v); return n == null ? null : Math.round(n * 10000) / 10000; }
const OLD = {
  amToDec: function (am) { var a = num(am); if (a == null || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); },
  decToAm: function (dec) { var d = num(dec); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); },
  breakEven: function (oddsAmerican, push) { var d = OLD.amToDec(oddsAmerican); if (!d) return null; return r4((1 - (num(push) || 0)) / d); },
  devig2: function (amA, amB) { var a = OLD.amToDec(amA), b = OLD.amToDec(amB); if (!a || !b) return null; var ia = 1 / a, ib = 1 / b; return { a: ia / (ia + ib), b: ib / (ia + ib), overround: r4(ia + ib - 1) }; },
  probToAm: function (p) { p = num(p); if (p == null || p <= 0 || p >= 1) return null; return OLD.decToAm(1 / p); }
};

const AM = [-10000, -1000, -500, -300, -250, -200, -150, -125, -115, -110, -105, -101, -100, -99, -50, -1, 0, 1, 50, 99, 100, 101, 105, 110, 120, 150, 200, 240, 300, 1000, 5000,
  '-110', '+150', '150', '', ' ', null, undefined, NaN, Infinity, -Infinity, true, false, 'abc', -110.5, 133.33];
const DEC = [0, 0.5, 1, 1.0001, 1.01, 1.1, 1.5, 1.8, 1.9, 1.909, 1.91, 1.95, 1.99, 2, 2.01, 2.1, 2.4, 2.5, 3, 5, 11, 101, '1.91', '', null, undefined, NaN, Infinity, true, 'x'];
const P = [0, 0.001, 0.01, 0.1, 0.25, 0.4, 0.4762, 0.5, 0.5238, 0.6, 0.75, 0.9, 0.99, 0.999, 1, 1.2, -0.1, '0.5', '', null, NaN];
const PUSH = [undefined, null, 0, 0.03, 0.05, 0.2, '0.03', ''];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (Number.isNaN(a) && Number.isNaN(b));

AM.forEach((a) => ok('amToDec(' + a + ')', same(R.odds.amToDec(a), OLD.amToDec(a)), [R.odds.amToDec(a), OLD.amToDec(a)]));
DEC.forEach((d) => ok('decToAm(' + d + ')', same(R.odds.decToAm(d), OLD.decToAm(d)), [R.odds.decToAm(d), OLD.decToAm(d)]));
P.forEach((p) => ok('probToAm(' + p + ')', same(R.odds.probToAm(p), OLD.probToAm(p))));
AM.forEach((a) => PUSH.forEach((q) => ok('breakEven(' + a + ',' + q + ')', same(R.odds.breakEven(a, q), OLD.breakEven(a, q)))));
AM.forEach((a) => [-110, 120, -300, 0, null, 50].forEach((b) => ok('devig2(' + a + ',' + b + ')', same(R.odds.devig2(a, b), OLD.devig2(a, b)))));

/* ---- the migrated kernels, through their public surface ---------------- */
require(path.join(FN, '_intelligence.js'));
require(path.join(FN, '_research.js'));
const PK = require(path.join(FN, '_pricing.js'));
const DK = require(path.join(FN, '_desk.js'));
AM.forEach((a) => PUSH.forEach((q) => ok('EDPRICE.breakEven(' + a + ',' + q + ')', same(PK.breakEven(a, q), OLD.breakEven(a, q)))));
AM.forEach((a) => [-110, 120, null].forEach((b) => ok('EDPRICE.devig2(' + a + ',' + b + ')', same(PK.devig2(a, b), OLD.devig2(a, b)))));
ok('EDPRICE.fairMoneyline de-vigs the same way', PK.fairMoneyline({ sport: 'x', market_home_ml: -150, market_away_ml: 130 }).fair_home_ml === OLD.decToAm(1 / OLD.devig2(-150, 130).a));
const B = require(path.join(FN, '_board.js'));
ok('EDBOARD still loads and exports', typeof B.build === 'function' && typeof B.rankScore === 'function');
const S = require(path.join(FN, '_stake.js'));
ok('EDSTAKE still loads and exports', !!S && typeof S === 'object');
ok('EDDESK prices the same break-even', DK.evaluate({ sport: 'x', projection: { home_win_prob: 0.6 }, fair: {}, market: { moneyline: { state: 'CURRENT', actionable: true } }, identity: {}, reliability: {} },
  { market: 'moneyline', side: 'home', team: 'H', odds: -120 }).prob.break_even === Math.round(OLD.breakEven(-120, 0) * 100) / 100);

/* ---- the differences that keep the strict helpers separate -------------- */
ok('americanToDecimal refuses |a| < 100; the kernel convention does not', R.americanToDecimal(50) === null && R.odds.amToDec(50) === 1.5);
ok('decimalToAmerican does not round; the kernel convention does', R.decimalToAmerican(1.91) !== R.odds.decToAm(1.91) && R.odds.decToAm(1.91) === -110);
const I = globalThis.EDINTEL;
ok('EDINTEL.impliedProb reads a DECIMAL price; research_core.impliedProb reads an AMERICAN one',
  !I || typeof I.impliedProb !== 'function' || (Math.abs(I.impliedProb(2) - 0.5) < 1e-12 && Math.abs(R.impliedProb(100) - 0.5) < 1e-12));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
