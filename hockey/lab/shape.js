'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — Model F: the shape of the score distribution.

   The incumbent prices every market from one exact regulation matrix (score
   effects, empty nets, overtime, shootout). Its totals are over-confident
   (held-out calibration slope ≈ 0.8) and its 60-minute draw is too rare
   (20.5% predicted, 22.4% observed). Two shape terms are tested, each fitted
   walk-forward — season S from the three seasons before it, by maximum
   likelihood of the observed 60-minute score — on the chosen model's
   calibrated λ:

     pace_shape k       a shared Gamma(k, 1/k) pace multiplier (overdispersion
                        of the total, nearly none of the margin)
     draw_inflation δ   the 60-minute tie inflated by (1 + δ)

   The grid includes "off" for both, so a season whose history prefers
   neither gets the incumbent exactly. Fewer than 500 earlier scored games →
   both off (the pair recalibration's rule).

   DECLARED RULE (before scoring): the shape terms replace the incumbent's
   shape if, on the SELECTION window, they improve the mean log-likelihood of
   the 60-minute score by ≥ 0.001 per game and do not worsen the moneyline log
   loss by more than 0.0002. Confirmation is reported; the market statuses
   then follow the existing rules (n ≥ 1000, |mean p − mean y| ≤ 0.02,
   calibration slope 0.85–1.15).
   =========================================================================== */
const DIST = require('../model/distribution');

const K_GRID = [0, 80, 40, 25, 16, 11, 8];
const D_GRID = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15];

/** per game, per k: P(observed 60-minute score) and P(60-minute tie) */
function likelihoodCache(games, lamOf, effectsOf, otOf) {
  const out = new Map();
  for (const g of games) {
    const L = lamOf(g); if (!L) continue;
    const row = [];
    for (const k of K_GRID) {
      const D = DIST.game({ lamH: L.lh, lamA: L.la, effects: effectsOf(g), ot: otOf(g), pace_shape: k || null });
      row.push({ obs: DIST.regProb(D, g.reg_home, g.reg_away), draw: D.reg.draw });
    }
    out.set(g.game_id, row);
  }
  return out;
}

function loglik(cell, isDraw, delta) {
  const p = cell.obs * (isDraw ? 1 + delta : 1) / (1 + delta * cell.draw);
  return Math.log(Math.max(1e-12, p));
}

/** the (k, δ) that maximise the 60-minute score likelihood over `games` */
function fit(games, cache) {
  const use = games.filter((g) => cache.has(g.game_id));
  if (use.length < 500) return { pace_shape: null, draw_inflation: 0, n: use.length, basis: 'off: fewer than 500 earlier scored games' };
  let best = null; const surface = [];
  for (let ki = 0; ki < K_GRID.length; ki++) for (const d of D_GRID) {
    let ll = 0;
    for (const g of use) ll += loglik(cache.get(g.game_id)[ki], g.reg_home === g.reg_away, d);
    ll /= use.length;
    surface.push({ k: K_GRID[ki] || null, delta: d, ll: +ll.toFixed(6) });
    if (!best || ll > best.ll + 1e-12) best = { ki, d, ll };
  }
  const off = surface.find((x) => x.k == null && x.delta === 0);
  return { pace_shape: K_GRID[best.ki] || null, draw_inflation: best.d, n: use.length, ll: +best.ll.toFixed(6), ll_gain_vs_off: +(best.ll - off.ll).toFixed(6), basis: 'maximum likelihood of the 60-minute score on earlier seasons', surface };
}

module.exports = { K_GRID, D_GRID, likelihoodCache, fit, loglik };
