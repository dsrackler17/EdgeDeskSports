'use strict';
/* ===========================================================================
   EdgeDesk engine — small, auditable price and exposure primitives.

   A Node port of the data pack's scripts/quant_math.py (datapack/quant_v1),
   held to the same test cases (tools/datapack/datapack.test.js). Invalid
   input throws; nothing is clamped into a plausible-looking number.

   asofVersions() is fail-closed: a record whose known_at is unknown is never
   available to a prediction, whatever its date.
   =========================================================================== */

function bad(msg) { const e = new Error(msg); e.code = 'INVALID'; return e; }
const fin = Number.isFinite;

function safeRatio(num, den) {
  if (den == null || !(den > 0) || num == null) return null;
  return num / den;
}

function americanToDecimal(a) {
  if (!fin(a) || a === 0 || Math.abs(a) < 100) throw bad('Standard American odds must be <= -100 or >= +100');
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}
function decimalToAmerican(d) {
  if (!fin(d) || d <= 1) throw bad('Decimal odds must exceed 1');
  return d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
}

/** multiplicative no-vig over a complete, mutually exclusive market */
function proportionalNoVig(decimals) {
  if (!Array.isArray(decimals) || decimals.length < 2 || decimals.some((x) => !fin(x) || x <= 1)) throw bad('Need a complete mutually exclusive market of valid decimal odds');
  const q = decimals.map((x) => 1 / x); const s = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / s);
}

const near1 = (ps) => Math.abs(ps.reduce((a, b) => a + b, 0) - 1) <= 1e-8;

/** profit per unit staked: a push or a void returns the stake */
function expectedProfit(decimal, pWin, pLoss, pPush, pVoid) {
  const ps = [pWin, pLoss, pPush || 0, pVoid || 0];
  if (!fin(decimal) || decimal <= 1 || ps.some((x) => !fin(x) || x < 0 || x > 1) || !near1(ps)) throw bad('Invalid price or probability distribution');
  return pWin * (decimal - 1) - pLoss;
}

/** a quarter line is two half-stakes: full win, half win, push, half loss, full loss */
function expectedSplitProfit(decimal, fullWin, halfWin, push, halfLoss, fullLoss) {
  const ps = [fullWin, halfWin, push, halfLoss, fullLoss];
  if (!fin(decimal) || decimal <= 1 || ps.some((x) => !fin(x) || x < 0) || !near1(ps)) throw bad('Invalid settlement distribution');
  return (fullWin + halfWin / 2) * (decimal - 1) - halfLoss / 2 - fullLoss;
}

function goalieGsax(xga, ga) { return xga - ga; }
function efg(fgm, threePm, fga) { return safeRatio(fgm + 0.5 * threePm, fga); }

function inningsFromOuts(outs) {
  if (!Number.isInteger(outs) || outs < 0) throw bad('Outs must be nonnegative integer');
  return outs / 3;
}
/** baseball notation 5.2 -> 17 outs, never 5.2 innings */
function parseBaseballInnings(native) {
  const s = String(native); const parts = s.split('.');
  if (parts.length > 2 || !/^\d+$/.test(parts[0]) || (parts.length === 2 && !/^[012]$/.test(parts[1]))) throw bad('Invalid baseball innings notation');
  return Number(parts[0]) * 3 + (parts.length === 2 ? Number(parts[1]) : 0);
}

function posteriorRate(successes, trials, priorRate, priorExposure) {
  if (trials < 0 || successes < 0 || successes > trials || !(priorRate >= 0 && priorRate <= 1) || !(priorExposure > 0)) throw bad('Invalid binomial/prior counts');
  return (successes + priorRate * priorExposure) / (trials + priorExposure);
}

const TZ = /(Z|[+-]\d\d:?\d\d)$/;
function instant(s, what) {
  if (!TZ.test(String(s))) throw bad(what + ' must be timezone-aware');
  const t = Date.parse(s);
  if (!fin(t)) throw bad(what + ' is not a timestamp');
  return t;
}
/** the latest version of each record_id known at or before the cutoff; unknown known_at never qualifies */
function asofVersions(records, cutoff) {
  const cut = instant(cutoff, 'Cutoff');
  const latest = new Map();
  for (const r of records) {
    if (!r.known_at) continue;
    const k = instant(r.known_at, 'known_at');
    if (k > cut) continue;
    const old = latest.get(r.record_id);
    const rev = r.revision || 0;
    if (!old || k > old.k || (k === old.k && rev > old.rev)) latest.set(r.record_id, { k, rev, r });
  }
  return [...latest.values()].map((x) => x.r);
}

module.exports = {
  safeRatio, americanToDecimal, decimalToAmerican, proportionalNoVig, expectedProfit,
  expectedSplitProfit, goalieGsax, efg, inningsFromOuts, parseBaseballInnings,
  posteriorRate, asofVersions,
};
