/* ===========================================================================
   EdgeDesk odds tools — the arithmetic behind the free public calculators
   (/tools/no-vig-calculator/, /tools/fair-odds-calculator/).

   PURE ARITHMETIC, NO MODEL. Nothing here knows anything about a game. It
   converts prices, removes a sportsbook's margin from a set of prices by a
   NAMED method, and turns a probability the reader supplies into the price
   that probability is worth. Every result carries the steps that produced
   it, in words, so a page can print its own working.

   ONE TRUTH. The de-vig methods are the same four lib/edgedesk_ev.js uses
   for the terminal's market benchmark (proportional / additive / power /
   Shin), and tools/growth/odds_tools.test.js holds this file equal to that
   one on a grid of real prices. This file exists because edgedesk_ev.js is
   1,800 lines with three dependencies, and a free calculator should load a
   few kilobytes.

   Browser: window.EDOddsTools. Node: require('./edgedesk_odds_tools.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDOddsTools = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var METHODS = {
    proportional: {
      label: 'Multiplicative (proportional)',
      short: 'Divides each implied probability by their total, so the margin is removed in proportion to each price.',
      formula: 'fair pᵢ = qᵢ ÷ Σq'
    },
    additive: {
      label: 'Additive',
      short: 'Subtracts an equal share of the margin from every outcome. Can fail on a heavy longshot, and says so.',
      formula: 'fair pᵢ = qᵢ − (Σq − 1) ÷ n'
    },
    power: {
      label: 'Power',
      short: 'Raises every implied probability to one power k chosen so they sum to 1; takes more margin from longshots.',
      formula: 'fair pᵢ = qᵢᵏ, with k solved so Σ qᵢᵏ = 1'
    },
    shin: {
      label: 'Shin',
      short: 'Models the margin as protection against better-informed bettors (Shin, 1993); also takes more from longshots.',
      formula: 'fair pᵢ = (√(z² + 4(1−z)qᵢ²/Σq) − z) ÷ (2(1−z)), with z solved so Σp = 1'
    }
  };
  var METHOD_ORDER = ['proportional', 'power', 'shin', 'additive'];

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r(x, d) { if (!isNum(x)) return null; var f = Math.pow(10, d == null ? 4 : d); return Math.round(x * f) / f; }

  /* ----------------------------------------------------------- prices */
  function validAmerican(a) { return isNum(a) && Math.abs(a) >= 100 && Math.abs(a) <= 100000; }
  function americanToDecimal(a) { if (!validAmerican(a)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  /* exact: the American price a decimal represents (+100 and −100 are the same price) */
  function decimalToAmerican(d) { if (!isNum(d) || !(d > 1)) return null; return d >= 2 ? 100 * (d - 1) : -100 / (d - 1); }
  /* what a sportsbook would print: a whole number, never between −100 and +100 */
  function americanDisplay(a) {
    if (!isNum(a)) return null;
    var x = Math.round(a);
    if (x > -100 && x < 100) x = x >= 0 ? 100 : -100;
    return (x > 0 ? '+' : '') + x;
  }

  /* "-110", "+150", "150", "−120", "1.91", "2.50". format: 'american' |
     'decimal' | 'auto' (a value with a decimal point under 100 is decimal). */
  function parsePrice(input, format) {
    var t = String(input == null ? '' : input).trim().replace(/[−–—]/g, '-').replace(/\s+/g, '');
    if (!t) return { ok: false, error: 'Enter a price.' };
    if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return { ok: false, error: '“' + String(input).slice(0, 20) + '” is not a price.' };
    var n = parseFloat(t), fmt = format || 'auto';
    if (fmt === 'auto') fmt = (/\./.test(t) && Math.abs(n) < 100) ? 'decimal' : 'american';
    if (fmt === 'american') {
      if (/\./.test(t)) return { ok: false, error: 'American odds are whole numbers, like -110 or +150.' };
      if (!validAmerican(n)) return { ok: false, error: 'American odds are -100 or below, or +100 or above (you entered ' + t + ').' };
      var d = americanToDecimal(n);
      return { ok: true, format: 'american', american: n, decimal: d, implied: 1 / d };
    }
    if (!(n > 1) || n > 1001) return { ok: false, error: 'Decimal odds are greater than 1.00 (you entered ' + t + ').' };
    return { ok: true, format: 'decimal', american: decimalToAmerican(n), decimal: n, implied: 1 / n };
  }

  /* ------------------------------------------------------ de-vig (n-way) */
  /* the same arithmetic as lib/edgedesk_ev.js devig(); fair probabilities
     from decimal prices, or { ok: false, problem } */
  function devig(decimals, method) {
    var q = (decimals || []).map(function (d) { return isNum(d) && d > 1 ? 1 / d : null; });
    if (q.length < 2 || q.some(function (x) { return x == null; })) return { ok: false, method: method, problem: 'Every outcome needs a valid price.' };
    var s = q.reduce(function (a, b) { return a + b; }, 0), n = q.length, p, z = null, k = null;
    var over = s - 1;
    if (over < -0.02 || over > 0.5) {
      return { ok: false, method: method, overround: over,
        problem: 'These prices add up to ' + (s * 100).toFixed(2) + '% implied probability. A real market is between 98% and 150%; check that every outcome of one market is entered.' };
    }
    switch (method || 'proportional') {
      case 'proportional':
        p = q.map(function (x) { return x / s; }); break;
      case 'additive':
        p = q.map(function (x) { return x - over / n; });
        if (p.some(function (x) { return x <= 0 || x >= 1; })) {
          return { ok: false, method: 'additive', overround: over, problem: 'The additive method gives an impossible probability here (a heavy longshot). Use another method.' };
        }
        break;
      case 'power': {
        if (Math.abs(over) < 1e-12) { p = q.slice(); k = 1; break; }
        var lo = 0.5, hi = 3, i;
        for (i = 0; i < 100; i++) { var mid = (lo + hi) / 2, t = q.reduce(function (a, x) { return a + Math.pow(x, mid); }, 0); if (t > 1) lo = mid; else hi = mid; }
        k = (lo + hi) / 2; p = q.map(function (x) { return Math.pow(x, k); });
        var ps = p.reduce(function (a, b) { return a + b; }, 0); p = p.map(function (x) { return x / ps; });
        break;
      }
      case 'shin': {
        if (over <= 0) { p = q.map(function (x) { return x / s; }); z = 0; break; }
        var f = function (zz) { return q.reduce(function (a, x) { return a + (Math.sqrt(zz * zz + 4 * (1 - zz) * x * x / s) - zz) / (2 * (1 - zz)); }, 0) - 1; };
        var a2 = 0, b2 = 0.4, j;
        for (j = 0; j < 100; j++) { var m2 = (a2 + b2) / 2; if (f(m2) > 0) a2 = m2; else b2 = m2; }
        z = (a2 + b2) / 2;
        p = q.map(function (x) { return (Math.sqrt(z * z + 4 * (1 - z) * x * x / s) - z) / (2 * (1 - z)); });
        var ss = p.reduce(function (aa, bb) { return aa + bb; }, 0); p = p.map(function (x) { return x / ss; });
        break;
      }
      default: return { ok: false, method: method, problem: 'Unknown method.' };
    }
    return { ok: true, method: method || 'proportional', p: p, raw: q, overround: over, hold: 1 - 1 / s, power_k: k, shin_z: z };
  }

  /* THE NO-VIG CALCULATOR. prices: strings or numbers, one per outcome of
     ONE market. Returns every outcome's implied and fair probability and fair
     price under the chosen method, every method side by side, and the
     working in words. */
  function noVig(prices, opts) {
    opts = opts || {};
    var method = METHODS[opts.method] ? opts.method : 'proportional';
    var parsed = (prices || []).map(function (x) { return parsePrice(x, opts.format || 'auto'); });
    var errors = [];
    parsed.forEach(function (pp, i) { if (!pp.ok) errors.push({ index: i, error: pp.error }); });
    if (parsed.length < 2) errors.push({ index: null, error: 'Enter at least two outcomes of the same market.' });
    if (errors.length) return { ok: false, errors: errors };
    var dec = parsed.map(function (pp) { return pp.decimal; });
    var main = devig(dec, method);
    if (!main.ok) return { ok: false, errors: [{ index: null, error: main.problem }] };
    var sum = main.raw.reduce(function (a, b) { return a + b; }, 0);
    var outcomes = parsed.map(function (pp, i) {
      var fp = main.p[i], fd = 1 / fp;
      return {
        index: i, input_american: pp.american, input_decimal: r(pp.decimal, 4),
        implied: r(main.raw[i], 6), fair: r(fp, 6),
        fair_decimal: r(fd, 4), fair_american: decimalToAmerican(fd), fair_american_display: americanDisplay(decimalToAmerican(fd)),
        margin_removed_pp: r((main.raw[i] - fp) * 100, 3)
      };
    });
    var compare = METHOD_ORDER.map(function (m) {
      var d = devig(dec, m);
      return { method: m, label: METHODS[m].label, ok: d.ok, problem: d.ok ? null : d.problem,
        fair: d.ok ? d.p.map(function (x) { return r(x, 6); }) : null };
    });
    var pct = function (x, dd) { return (x * 100).toFixed(dd == null ? 2 : dd) + '%'; };
    var steps = [];
    steps.push('Convert each price to its implied probability: 1 ÷ decimal odds. '
      + outcomes.map(function (o, i) { return 'Outcome ' + (i + 1) + ': 1 ÷ ' + o.input_decimal.toFixed(4) + ' = ' + pct(o.implied); }).join('; ') + '.');
    steps.push('Add them: ' + outcomes.map(function (o) { return pct(o.implied); }).join(' + ') + ' = ' + pct(sum)
      + '. Everything above 100% is the sportsbook’s margin (the overround): ' + pct(main.overround) + '. As a hold on a balanced book that is ' + pct(main.hold) + '.');
    steps.push(METHODS[method].label + ': ' + METHODS[method].formula
      + (method === 'power' && main.power_k != null ? ' (k = ' + main.power_k.toFixed(4) + ')' : '')
      + (method === 'shin' && main.shin_z != null ? ' (z = ' + main.shin_z.toFixed(4) + ')' : '') + '. '
      + outcomes.map(function (o, i) { return 'Outcome ' + (i + 1) + ': ' + pct(o.fair); }).join('; ') + '.');
    steps.push('Convert each fair probability back to a price: fair decimal = 1 ÷ fair probability; American = '
      + '100 × (decimal − 1) at or above 2.00, −100 ÷ (decimal − 1) below it. '
      + outcomes.map(function (o, i) { return 'Outcome ' + (i + 1) + ': ' + o.fair_decimal.toFixed(3) + ' (' + o.fair_american_display + ')'; }).join('; ') + '.');
    return { ok: true, method: method, method_label: METHODS[method].label, outcomes: outcomes, compare: compare,
      total_implied: r(sum, 6), overround: r(main.overround, 6), hold: r(main.hold, 6),
      power_k: main.power_k, shin_z: main.shin_z, steps: steps };
  }

  /* ------------------------------------------------- the fair-odds tool */
  /* "52.4", "52.4%", "0.524". A bare number above 1 is a percentage. */
  function parseProbability(input) {
    var t = String(input == null ? '' : input).trim().replace(/\s+/g, '');
    if (!t) return { ok: false, error: 'Enter a probability.' };
    var pctForm = /%$/.test(t);
    t = t.replace(/%$/, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'Enter a probability as a percentage, like 55 or 55.5%.' };
    var n = parseFloat(t);
    var p = (pctForm || n > 1) ? n / 100 : n;
    if (!(p > 0.001) || !(p < 0.999)) return { ok: false, error: 'Use a probability between 0.1% and 99.9%.' };
    return { ok: true, p: p };
  }
  /* fair price for a probability; with pushPct, the price at which a bet
     that can push is exactly break-even ((1 − push) ÷ win, the push refunded) */
  function fairOdds(probInput, opts) {
    opts = opts || {};
    var pp = typeof probInput === 'number' ? (probInput > 0 && probInput < 1 ? { ok: true, p: probInput } : { ok: false, error: 'Use a probability between 0.1% and 99.9%.' }) : parseProbability(probInput);
    if (!pp.ok) return { ok: false, errors: [{ field: 'probability', error: pp.error }] };
    var p = pp.p, push = 0;
    if (opts.push != null && String(opts.push).trim() !== '') {
      var pu = parseProbability(opts.push);
      if (!pu.ok && String(opts.push).trim() !== '0') return { ok: false, errors: [{ field: 'push', error: pu.error }] };
      push = pu.ok ? pu.p : 0;
      if (p + push >= 1) return { ok: false, errors: [{ field: 'push', error: 'Win and push probabilities together must be under 100%.' }] };
    }
    var dec = (1 - push) / p;
    var am = decimalToAmerican(dec);
    var out = {
      ok: true, probability: r(p, 6), push: r(push, 6), loss: r(1 - p - push, 6),
      fair_decimal: r(dec, 4), fair_american: am, fair_american_display: americanDisplay(am),
      steps: []
    };
    var pct = function (x) { return (x * 100).toFixed(2) + '%'; };
    out.steps.push(push > 0
      ? 'A bet that wins ' + pct(p) + ' of the time and pushes ' + pct(push) + ' (stake refunded) breaks even at decimal odds of (1 − ' + pct(push) + ') ÷ ' + pct(p) + ' = ' + dec.toFixed(4) + '.'
      : 'A price is fair when it pays exactly what the probability is worth: fair decimal odds = 1 ÷ ' + pct(p) + ' = ' + dec.toFixed(4) + '.');
    out.steps.push(dec >= 2
      ? 'At or above 2.00, American odds = 100 × (decimal − 1) = ' + out.fair_american_display + '.'
      : 'Below 2.00, American odds = −100 ÷ (decimal − 1) = ' + out.fair_american_display + '.');
    if (opts.price != null && String(opts.price).trim() !== '') {
      var bp = parsePrice(opts.price, opts.format || 'auto');
      if (!bp.ok) return { ok: false, errors: [{ field: 'price', error: bp.error }] };
      var b = bp.decimal - 1;
      var ev = p * b - (1 - p - push);
      out.compare = {
        american: bp.american, american_display: americanDisplay(bp.american), decimal: r(bp.decimal, 4),
        break_even: r((1 - push) / bp.decimal, 6),
        ev_per_100: r(ev * 100, 2), ev_pct: r(ev * 100, 3),
        edge_pp: r((p - (1 - push) / bp.decimal) * 100, 3)
      };
      out.steps.push('At ' + out.compare.american_display + ' (decimal ' + bp.decimal.toFixed(4) + '), a $100 stake wins $' + (b * 100).toFixed(2)
        + '. Expected value at YOUR probability = ' + pct(p) + ' × $' + (b * 100).toFixed(2) + ' − ' + pct(1 - p - push) + ' × $100 = '
        + (ev >= 0 ? '+' : '−') + '$' + Math.abs(ev * 100).toFixed(2) + ' per $100. This is arithmetic on the probability you entered, not a forecast.');
    }
    return out;
  }

  /* odds → implied probability, both directions, for a quick converter */
  function convert(input, format) {
    var pp = parsePrice(input, format);
    if (!pp.ok) return pp;
    return { ok: true, american: pp.american, american_display: americanDisplay(pp.american), decimal: r(pp.decimal, 4), implied: r(pp.implied, 6) };
  }

  return {
    METHODS: METHODS, METHOD_ORDER: METHOD_ORDER,
    parsePrice: parsePrice, parseProbability: parseProbability,
    americanToDecimal: americanToDecimal, decimalToAmerican: decimalToAmerican, americanDisplay: americanDisplay,
    devig: devig, noVig: noVig, fairOdds: fairOdds, convert: convert
  };
}));
