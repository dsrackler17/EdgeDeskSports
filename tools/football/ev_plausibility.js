#!/usr/bin/env node
/* ===========================================================================
   THE EV PLAUSIBILITY BOUND — σ-scaled, fitted walk-forward (audit follow-up #2).

   THE DEFECT. The first fix (2026-09-30 #8) bounded raw EV at a flat 25% on a
   main-line spread. Against a live −110 price a college gap of ~6 pts already
   prices past 25%, so every VERIFIED 7+ disagreement read INVESTIGATE
   ("implausible EV") and VERIFIED MAJOR was unreachable. The bound was on the
   wrong quantity: EV is a price-dependent function of the gap measured in the
   distribution's own width, and a 25% flat number means a different gap in
   every game.

   THE BOUND. A main-line quote is implausible when the model sits more than
   z* distribution-widths from the quote's own line:

        z = |fair home margin − the quote's home margin| / σ
        σ = half the central-68% width of the SAME margin distribution the EV
            is priced from (lib/edgedesk_quote_ev.js distributionSpread)

   z* is the q = 0.995 quantile of z over CORRECTLY-JOINED games (the archive's
   close) in the fit seasons: a gap that the model and a real market have
   produced less than once in two hundred games. Declared before the holdout
   was read: q = 0.995, fit 2021-2023, holdout 2024-2025.

   WHAT THE HOLDOUT MEASURES (2024-2025, never fitted)
     false positives   the share of real games the bound flags (target ~0.5%)
     VERIFIED MAJOR    the share of real 7+ gaps the bound leaves reachable
     data errors       synthetic, on every holdout game: the market's side
                       flipped (|close| >= 3), a mis-joined market (another
                       game's close the same week, >= 3 pts off), and a line
                       off by a touchdown away from the model. The share of
                       each the bound catches.
   and the SAME numbers for the flat 25% rule it replaces (raw EV at −110 on
   the side the model favours, priced from the same distribution).

   Rows: CFB from football/cfb_p4/research/replay_rows.js (a cold replay of the
   shipped engine; --data = the cfbfastR cache with sched/ and out/market.csv);
   NFL from tools/football/validate_pricing.js replayNfl (a cold replay of the
   shipped NFL engine against football/pricing/lines_nfl.json). The market is
   never an input to a projection.

     node tools/football/ev_plausibility.js --data D            # print
     node tools/football/ev_plausibility.js --data D --write    # football/validation/ev_plausibility.json
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.window.EDCfbP4Params;
require(path.join(ROOT, 'football', 'params.js'));
const EF = require(path.join(ROOT, 'football', 'engine.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));

const SCHEMA = 'edgedesk_ev_plausibility_v1';
const RULES = { q: 0.995, fit: [2021, 2023], holdout: [2024, 2025], min_flip_close: 3, min_misjoin_pts: 3, off_pts: 7, major_gap: 7,
  old_rule: { raw_ev: 0.25, price: -110 } };
const OUT = path.join(ROOT, 'football', 'validation', 'ev_plausibility.json');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v == null || v.slice(0, 2) === '--') ? true : v; }
function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
function r4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }
function quantile(xs, q) { const a = xs.slice().sort((x, y) => x - y); if (!a.length) return null; const h = (a.length - 1) * q, lo = Math.floor(h); return a[lo] + (h - lo) * ((a[Math.min(lo + 1, a.length - 1)]) - a[lo]); }
const DEC = Q.americanToDecimal(RULES.old_rule.price);

/* the distribution each sport's EV is priced from, for a game with this fair
   margin, at this market (the CFB shape is conditioned on the market spread,
   exactly as app.html fbQevModelCfb and football/cfb_terminal/build.js do) */
function coverFor(sport, row, marketMargin) {
  if (sport === 'NFL') return (t) => EF.dist.coverProbSpread('nfl', row.fair, t);
  const hc = Q.cfbConditionedCover(P.distributions, row.fair, marketMargin, row.sigma, row.sigma_base);
  return hc || ((t) => global.window.EDCfbP4.dist.coverProbSpread(row.fair, t, row.sigma, row.sigma_base));
}
/* z and the old rule's raw EV for one (row, market) pair */
function measure(sport, row, marketMargin) {
  const hc = coverFor(sport, row, marketMargin), sd = Q.distributionSpread(hc);
  if (!(sd > 0)) return null;
  const side = row.fair >= marketMargin ? 'home' : 'away', line = side === 'home' ? -marketMargin : marketMargin;
  const pr = Q.sideProb(hc, side, line), ev = pr ? pr.win * (DEC - 1) - pr.loss : null;
  /* the rest of the integrity stack an error meets on the board: the
     orientation invariant (a 10+ gap that flipping would bring under 5) and
     the 21-point guard (lib/edgedesk_canon.js) */
  const stack = !!C.orientationSuspect(row.fair, marketMargin) || Math.abs(row.fair - marketMargin) > C.THRESHOLDS.guard_gap;
  return { z: Math.abs(row.fair - marketMargin) / sd, sd: sd, gap: Math.abs(row.fair - marketMargin), old_ev: ev, stack: stack };
}

function evaluate(sport, rows) {
  const fitRows = rows.filter((r) => r.season >= RULES.fit[0] && r.season <= RULES.fit[1] && r.close != null);
  const holdRows = rows.filter((r) => r.season >= RULES.holdout[0] && r.season <= RULES.holdout[1] && r.close != null);
  const fitZ = fitRows.map((r) => measure(sport, r, r.close)).filter(Boolean).map((m) => m.z);
  const zStar = quantile(fitZ, RULES.q);
  const flagNew = (m) => m && m.z > zStar + 1e-9, flagOld = (m) => m && m.old_ev != null && m.old_ev > RULES.old_rule.raw_ev + 1e-9;
  const real = holdRows.map((r) => ({ r, m: measure(sport, r, r.close) })).filter((x) => x.m);
  const rate = (list, f) => list.length ? r4(list.filter(f).length / list.length) : null;
  const majors = real.filter((x) => x.m.gap >= RULES.major_gap);
  /* synthetic data errors, deterministic */
  const byWeek = {}; holdRows.forEach((r) => { (byWeek[r.season + '|' + r.week] = byWeek[r.season + '|' + r.week] || []).push(r); });
  const errs = { flip: [], misjoin: [], off7: [] };
  holdRows.forEach((r) => {
    if (Math.abs(r.close) >= RULES.min_flip_close) errs.flip.push(measure(sport, r, -r.close));
    const wk = byWeek[r.season + '|' + r.week], i = wk.indexOf(r), o = wk.length > 1 ? wk[(i + Math.max(1, Math.floor(wk.length / 2))) % wk.length] : null;
    if (o && Math.abs(o.close - r.close) >= RULES.min_misjoin_pts) errs.misjoin.push(measure(sport, r, o.close));
    const away = r.close >= r.fair ? 1 : -1;
    errs.off7.push(measure(sport, r, r.close + away * RULES.off_pts));
  });
  Object.keys(errs).forEach((k) => { errs[k] = errs[k].filter(Boolean); });
  const catchOf = (f) => { const o = {}; Object.keys(errs).forEach((k) => { o[k] = { cases: errs[k].length, caught: rate(errs[k], f),
    caught_with_the_stack: rate(errs[k], (m) => f(m) || m.stack) }; }); return o; };
  const zs = real.map((x) => x.m.z);
  return {
    sport, fit_seasons: RULES.fit.join('-'), fit_games: fitZ.length, q: RULES.q, z_star: r4(zStar),
    z_quantiles_fit: { q50: r4(quantile(fitZ, 0.5)), q90: r4(quantile(fitZ, 0.9)), q99: r4(quantile(fitZ, 0.99)), q995: r4(zStar), max: r4(Math.max.apply(null, fitZ)) },
    typical_sigma: r3(quantile(real.map((x) => x.m.sd), 0.5)),
    gap_at_z_star_pts: r3(zStar * quantile(real.map((x) => x.m.sd), 0.5)),
    holdout: { seasons: RULES.holdout.join('-'), games: real.length,
      stack_alone: { false_positive_rate: rate(real, (x) => x.m.stack), data_errors: catchOf(() => false) },
      new_bound: { false_positive_rate: rate(real, (x) => flagNew(x.m)), false_positive_rate_with_the_stack: rate(real, (x) => flagNew(x.m) || x.m.stack), major_gaps: majors.length,
        major_gaps_reachable: rate(majors, (x) => !flagNew(x.m)), data_errors: catchOf(flagNew) },
      old_flat_25pct: { false_positive_rate: rate(real, (x) => flagOld(x.m)), false_positive_rate_with_the_stack: rate(real, (x) => flagOld(x.m) || x.m.stack),
        major_gaps_reachable: rate(majors, (x) => !flagOld(x.m)), data_errors: catchOf(flagOld) },
      z_quantiles: { q50: r4(quantile(zs, 0.5)), q99: r4(quantile(zs, 0.99)), max: r4(Math.max.apply(null, zs)) } }
  };
}

function cfbRows() {
  const data = arg('data', null);
  if (!data) throw new Error('--data <cfbfastR cache with sched/ and out/market.csv> is required for the college rows');
  const RR = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'replay_rows.js'));
  require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  return RR.replayRows({ data, from: RULES.fit[0], to: RULES.holdout[1] }).rows;
}
function nflRows() {
  const VP = require(path.join(__dirname, 'validate_pricing.js'));
  const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_nfl.json'), 'utf8'));
  return VP.replayNfl(archive).rows.map((r) => ({ season: r.season, week: r.week, fair: r.model, close: r.close, margin: r.margin }));
}

function main() {
  const cfb = evaluate('CFB', cfbRows()), nfl = evaluate('NFL', nflRows());
  const art = { schema: SCHEMA, generated_at: new Date().toISOString(), rules: RULES,
    definition: 'implausible when |fair home margin − the quote’s home margin| exceeds z* × σ, σ = half the central-68% width of the distribution the EV is priced from (lib/edgedesk_quote_ev.js distributionSpread); z* = the q quantile of that ratio over correctly-joined games in the fit seasons',
    market_is_an_input: false, cfb, nfl,
    source: { cfb: 'football/cfb_p4/research/replay_rows.js (cold replay of the shipped engine, cfbfastR schedules and closing archive)',
      nfl: 'tools/football/validate_pricing.js replayNfl (cold replay of the shipped NFL engine, football/pricing/lines_nfl.json)' } };
  console.log(JSON.stringify(art, null, 1));
  if (arg('write', false)) { fs.writeFileSync(OUT, JSON.stringify(art, null, 1) + '\n'); console.error('[write] ' + path.relative(ROOT, OUT)); }
}
if (require.main === module) main();
module.exports = { evaluate, measure, RULES, SCHEMA };
