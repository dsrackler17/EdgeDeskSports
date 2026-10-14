'use strict';
/* ===========================================================================
   EdgeDesk college baseball — fair prices from a run distribution (Phase 11).

   A price is a probability with its settlement rules attached. Every market
   below is computed from ONE joint distribution of final runs (the simulator's,
   or the closed form's), so the moneyline, run lines, totals and team totals
   of a game cannot contradict each other; coherence() proves it per game.

   PUSHES. A whole-number line can land exactly. Its fair price is the
   CONDITIONAL one, P(win) / (P(win) + P(lose)), and P(push) is shown beside it.

   SETTLEMENT. A sportsbook's college-baseball rules decide whether a shortened
   game has action, whether totals need a regulation-length game, and whether
   "listed pitchers" voids a bet when the starter changes. Those rules are
   book-specific and NONE has been verified from a rules page here, so the
   profiles below are TEMPLATES (status UNVERIFIED). A price is computed under
   a profile and carries its name; expected value is computed only against a
   quote whose book's profile is VERIFIED and whose timestamp is fresh — today,
   never (no authorised college-baseball feed exists).

   FIRST FIVE INNINGS. Priced only from the simulator (it tracks innings); a
   three-way (tie possible) and the two-way-with-tie-push version are given.
   =========================================================================== */
const D = require('./distribution');

const SETTLEMENT_PROFILES = {
  action_full_game: { status: 'UNVERIFIED_TEMPLATE', moneyline: 'official game, extra innings included', totals_and_run_lines: 'official game, extra innings included', pitchers: 'action', note: 'common default; not verified for any named book' },
  regulation_required: { status: 'UNVERIFIED_TEMPLATE', moneyline: 'official game', totals_and_run_lines: 'void unless the scheduled length (or the bottom half not needed) is completed', pitchers: 'action', note: 'shortened (weather) games void totals' },
  listed_pitchers: { status: 'UNVERIFIED_TEMPLATE', moneyline: 'void if either listed starter does not start', totals_and_run_lines: 'same', pitchers: 'listed', note: 'priced conditional on the listed starters' },
};

function american(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}
function decimal(p) { return p > 0 ? Math.round(1 / p * 1000) / 1000 : null; }
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

/** joint list [[h, a, p]] -> derived pmfs */
function fromJoint(joint) {
  const total = new Float64Array(81); const margin = new Float64Array(81); const home = new Float64Array(41); const away = new Float64Array(41);
  let pH = 0; let pA = 0; let pT = 0;
  for (const [h, a, p] of joint) {
    total[Math.min(80, h + a)] += p; margin[Math.max(-40, Math.min(40, h - a)) + 40] += p; home[h] += p; away[a] += p;
    if (h > a) pH += p; else if (a > h) pA += p; else pT += p;
  }
  return { total, margin, marginOffset: 40, home, away, pH, pA, pT };
}

/** from the closed form's outcomes() */
function fromOutcomes(o) {
  const total = o.total_pmf; const margin = o.margin_pmf;
  return { total, margin, marginOffset: o.margin_offset, home: D.marginal(o.exp_home, o.spec || { family: 'nb', r: 4 }), away: D.marginal(o.exp_away, o.spec || { family: 'nb', r: 4 }), pH: o.p_home, pA: o.p_away, pT: 0 };
}

function overUnder(pmf, line) {
  let over = 0; let under = 0; let push = 0;
  for (let t = 0; t < pmf.length; t++) { if (t > line) over += pmf[t]; else if (t < line) under += pmf[t]; else push += pmf[t]; }
  return { line, over: r4(over), under: r4(under), push: r4(push), fair_over: american(over / Math.max(1e-12, over + under)), fair_under: american(under / Math.max(1e-12, over + under)) };
}
function runLine(margin, offset, line) {
  /* home line `line` (e.g. -1.5): home covers if margin + line > 0 */
  let win = 0; let lose = 0; let push = 0;
  for (let i = 0; i < margin.length; i++) { const m = i - offset; const v = m + line; if (v > 0) win += margin[i]; else if (v < 0) lose += margin[i]; else push += margin[i]; }
  return { home_line: line, home_cover: r4(win), away_cover: r4(lose), push: r4(push), fair_home: american(win / Math.max(1e-12, win + lose)), fair_away: american(lose / Math.max(1e-12, win + lose)) };
}
function median(pmf) { let c = 0; for (let i = 0; i < pmf.length; i++) { c += pmf[i]; if (c >= 0.5) return i; } return pmf.length - 1; }

/**
 * price(dist, opts) -> every market of one game
 * dist: fromJoint()/fromOutcomes() result (+ optional f5 joint)
 */
function price(dist, opts) {
  opts = opts || {};
  const pHome = dist.pH + dist.pT * (opts.tieHomeShare == null ? 0.5 : opts.tieHomeShare);
  const exp = (pmf) => { let s = 0; for (let i = 0; i < pmf.length; i++) s += i * pmf[i]; return s; };
  const mainTotal = median(dist.total) + 0.5;
  const out = {
    settlement_profile: opts.profile || 'action_full_game',
    moneyline: { p_home: r4(pHome), p_away: r4(1 - pHome), fair_home: american(pHome), fair_away: american(1 - pHome), decimal_home: decimal(pHome), decimal_away: decimal(1 - pHome) },
    expected: { home: r4(exp(dist.home)), away: r4(exp(dist.away)), total: r4(exp(dist.total)) },
    run_lines: [-1.5, 1.5, -2.5, 2.5, -3.5, 3.5, -1, 1, -2, 2].map((l) => runLine(dist.margin, dist.marginOffset, l)),
    totals: [], team_totals: { home: [], away: [] },
    main_total_line: mainTotal,
  };
  for (let l = Math.max(4.5, mainTotal - 4); l <= mainTotal + 4; l += 0.5) out.totals.push(overUnder(dist.total, l));
  const mh = median(dist.home) + 0.5; const ma = median(dist.away) + 0.5;
  for (let l = Math.max(0.5, mh - 2); l <= mh + 2; l += 0.5) out.team_totals.home.push(overUnder(dist.home, l));
  for (let l = Math.max(0.5, ma - 2); l <= ma + 2; l += 0.5) out.team_totals.away.push(overUnder(dist.away, l));
  if (opts.f5) {
    const f = fromJoint(opts.f5);
    const two = f.pH / Math.max(1e-12, f.pH + f.pA);
    const f5Total = median(f.total) + 0.5;
    out.first_five = { three_way: { home: r4(f.pH), tie: r4(f.pT), away: r4(f.pA) }, two_way_tie_push: { p_home: r4(two), fair_home: american(two), fair_away: american(1 - two), push: r4(f.pT) },
      home_minus_0_5: { home: r4(f.pH), fair_home: american(f.pH), fair_away: american(1 - f.pH) }, totals: [f5Total - 1, f5Total, f5Total + 1].map((l) => overUnder(f.total, l)), status: 'PROVISIONAL', source: 'simulator' };
  }
  return out;
}

/** internal coherence: the markets must agree with one another */
function coherence(p) {
  const errs = [];
  const ml = p.moneyline;
  if (Math.abs(ml.p_home + ml.p_away - 1) > 1e-6) errs.push('moneyline does not sum to 1');
  const rl = (l) => p.run_lines.find((x) => x.home_line === l);
  if (rl(-1.5).home_cover > ml.p_home + 1e-6) errs.push('home -1.5 more likely than a home win');
  if (rl(1.5).home_cover < ml.p_home - 1e-6) errs.push('home +1.5 less likely than a home win');
  if (rl(-2.5).home_cover > rl(-1.5).home_cover + 1e-6) errs.push('alternate run lines not monotone');
  for (const t of p.totals) if (Math.abs(t.over + t.under + t.push - 1) > 2e-4) errs.push('total ' + t.line + ' does not sum to 1');
  for (let i = 1; i < p.totals.length; i++) if (p.totals[i].over > p.totals[i - 1].over + 1e-6) errs.push('totals not monotone at ' + p.totals[i].line);
  if (Math.abs(p.expected.home + p.expected.away - p.expected.total) > 0.05) errs.push('team expectations do not add to the total');
  if (p.first_five) { const f = p.first_five.three_way; if (Math.abs(f.home + f.tie + f.away - 1) > 2e-4) errs.push('first-five three-way does not sum to 1'); }
  return { ok: errs.length === 0, errors: errs };
}

/** expected value: only against a fresh quote under a VERIFIED matching profile */
function expectedValue(pFair, quote, profileName, now, maxAgeMin) {
  const prof = SETTLEMENT_PROFILES[profileName];
  if (!quote) return { status: 'MARKET_UNAVAILABLE', reason: 'no authorised quote for this game' };
  if (!prof || prof.status !== 'VERIFIED') return { status: 'SETTLEMENT_UNVERIFIED', reason: 'the book\'s settlement rules for this market are not verified' };
  if (!quote.captured_at || (now - Date.parse(quote.captured_at)) / 60000 > (maxAgeMin || 30)) return { status: 'QUOTE_STALE', reason: 'quote older than the freshness limit' };
  const dec = quote.american > 0 ? 1 + quote.american / 100 : 1 + 100 / -quote.american;
  return { status: 'EVALUATED', ev_per_unit: r4(pFair * dec - 1) };
}

module.exports = { SETTLEMENT_PROFILES, american, decimal, fromJoint, fromOutcomes, price, coherence, overUnder, runLine, expectedValue };
