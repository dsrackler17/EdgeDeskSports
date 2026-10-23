'use strict';
/* ===========================================================================
   Matchup factors, point in time, and the tests that decide what they are.

   teamFactors(games) walks the games in time order and gives, for each game,
   both teams' season-to-date four factors from box_ok games AVAILABLE before
   the prediction time (tip - 30 min; a game is known at tip + 4 h):
     offense  eFG% (FGM + .5 3PM)/FGA, turnover rate TOV/poss, offensive
              rebound rate ORB/(ORB + opp DRB), free-throw rate FTA/FGA,
              three-point attempt rate 3PA/FGA, share of points from threes
     defense  the same conceded by the team's opponents
   Raw season-to-date rates, NOT opponent-adjusted; fewer than 5 games is
   'insufficient sample' and no factor is shown.

   HYPOTHESES (registered here before the test; Bonferroni over all of them):
     H1 three_point_volume    underdog 3PA rate (high-variance shot diet)
     H2 turnover_pressure     underdog defense's forced TOV rate minus the
                              favourite offense's own TOV rate
     H3 offensive_rebounding  underdog ORB% minus favourite's ORB% allowed
     H4 free_throw_rate       underdog FTA rate minus favourite's FT rate allowed
     H5 pace                  predicted possessions (fewer = more variance per
                              unit of strength, the classic upset argument)
     H6 volatile_shooting     underdog share of points from threes
   test(): logistic regression of "the underdog won" on logit(p_underdog)
   (free coefficient) plus the z-scored factor, on DEVELOPMENT games. A factor
   is SUPPORTED only if |z| exceeds the Bonferroni bound; otherwise it is
   NOT_SUPPORTED and stays descriptive. Either way no factor changes a
   probability until a challenger that uses it passes the promotion gates.
   =========================================================================== */
const C = require('./config');

const HYPOTHESES = ['three_point_volume', 'turnover_pressure', 'offensive_rebounding', 'free_throw_rate', 'pace', 'volatile_shooting'];
const MIN_GAMES = 5;

function blank() { return { n: 0, o: { fgm: 0, fga: 0, tpm: 0, tpa: 0, fta: 0, orb: 0, tov: 0, pts: 0, poss: 0, opp_drb: 0 }, d: { fgm: 0, fga: 0, tpm: 0, tpa: 0, fta: 0, orb: 0, tov: 0, pts: 0, poss: 0, opp_drb: 0 } }; }
function rates(x) {
  if (!x || x.n < MIN_GAMES) return null;
  const f = (s) => ({ efg: (s.fgm + 0.5 * s.tpm) / s.fga, tov: s.tov / s.poss, orb: s.orb / (s.orb + s.opp_drb), ftr: s.fta / s.fga, tpar: s.tpa / s.fga, three_share: (3 * s.tpm) / s.pts });
  return { games: x.n, off: f(x.o), def: f(x.d) };
}

/** game_id -> { home, away } season-to-date factor snapshots before the game.
    probes: future games to snapshot (never absorbed: they have no result) */
function teamFactors(games, probes) {
  const fin = games.filter((g) => g.status === 'FINAL' && g.score_ok).concat((probes || []).map((g) => Object.assign({}, g, { _probe: true })))
    .sort((a, b) => a.start_ms - b.start_ms || (a._probe ? 1 : 0) - (b._probe ? 1 : 0));
  const st = new Map(); const out = new Map(); const pending = []; let head = 0;
  const T = (season, id) => { const k = season + ':' + id; if (!st.has(k)) st.set(k, blank()); return st.get(k); };
  const add = (g) => {
    if (!g.box_ok) return;
    const ph = g.h_fga - g.h_orb + g.h_tov + 0.475 * g.h_fta, pa = g.a_fga - g.a_orb + g.a_tov + 0.475 * g.a_fta;
    for (const [me, side, oside, poss, oposs, pts, opts] of [[g.home_id, 'h', 'a', ph, pa, g.hs, g.as], [g.away_id, 'a', 'h', pa, ph, g.as, g.hs]]) {
      const t = T(g.season, me); t.n++;
      for (const [dst, s, os, ps, pp] of [[t.o, side, oside, pts, poss], [t.d, oside, side, opts, oposs]]) {
        dst.fgm += g[s + '_fgm']; dst.fga += g[s + '_fga']; dst.tpm += g[s + '_tpm']; dst.tpa += g[s + '_tpa']; dst.fta += g[s + '_fta'];
        dst.orb += g[s + '_orb']; dst.tov += g[s + '_tov']; dst.pts += ps; dst.poss += pp; dst.opp_drb += g[os + '_drb'];
      }
    }
  };
  for (const g of fin) {
    const at = g.start_ms - C.PREDICT_BEFORE_MS;
    while (head < pending.length && pending[head].start_ms + C.AVAILABLE_AFTER_MS < at) add(pending[head++]);
    out.set(g.game_id, { home: rates(st.get(g.season + ':' + g.home_id)), away: rates(st.get(g.season + ':' + g.away_id)) });
    if (!g._probe) pending.push(g);
  }
  return out;
}

/** the six hypothesis values for an underdog/favourite pair (null when either side lacks a sample) */
function hypotheses(dog, fav, tempo) {
  if (!dog || !fav) return null;
  return {
    three_point_volume: dog.off.tpar,
    turnover_pressure: dog.def.tov - fav.off.tov,
    offensive_rebounding: dog.off.orb - fav.def.orb,
    free_throw_rate: dog.off.ftr - fav.def.ftr,
    pace: tempo,
    volatile_shooting: dog.off.three_share,
  };
}

/** logistic IRLS with standard errors: y ~ b0 + b1 * x1 + b2 * x2 */
function logit2(x1, x2, y) {
  let b = [0, 1, 0];
  for (let it = 0; it < 50; it++) {
    const g = [0, 0, 0]; const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < y.length; i++) {
      const v = [1, x1[i], x2[i]]; const z = b[0] + b[1] * v[1] + b[2] * v[2]; const p = 1 / (1 + Math.exp(-z)); const w = p * (1 - p);
      for (let j = 0; j < 3; j++) { g[j] += (y[i] - p) * v[j]; for (let k = 0; k < 3; k++) H[j][k] += w * v[j] * v[k]; }
    }
    const inv = inv3(H); const d = [0, 1, 2].map((j) => inv[j][0] * g[0] + inv[j][1] * g[1] + inv[j][2] * g[2]);
    b = b.map((x, j) => x + d[j]);
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-10) return { beta: b, se: [0, 1, 2].map((j) => Math.sqrt(inv[j][j])) };
  }
  return { beta: b, se: [NaN, NaN, NaN] };
}
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g; const det = a * A + b * B + c * Cc;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

/** rows: { p_dog, dog_won, h: hypotheses(...) } on development games */
function test(rows) {
  const zcrit = 2.638; // two-sided 0.05 / 6 (Bonferroni)
  const out = {};
  for (const k of HYPOTHESES) {
    const r = rows.filter((x) => x.h && Number.isFinite(x.h[k]));
    if (r.length < 500) { out[k] = { n: r.length, verdict: 'INSUFFICIENT_SAMPLE' }; continue; }
    const xs = r.map((x) => x.h[k]); const m = xs.reduce((a, v) => a + v, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) * (v - m), 0) / (xs.length - 1)) || 1;
    const lg = r.map((x) => { const p = Math.min(1 - 1e-6, Math.max(1e-6, x.p_dog)); return Math.log(p / (1 - p)); });
    const f = logit2(lg, xs.map((v) => (v - m) / sd), r.map((x) => x.dog_won));
    const z = f.beta[2] / f.se[2];
    out[k] = { n: r.length, coef_per_sd: +f.beta[2].toFixed(4), se: +f.se[2].toFixed(4), z: +z.toFixed(2), logit_slope: +f.beta[1].toFixed(3), verdict: Math.abs(z) > zcrit ? 'SUPPORTED_IN_DEVELOPMENT' : 'NOT_SUPPORTED', bound: zcrit };
  }
  return out;
}

module.exports = { HYPOTHESES, MIN_GAMES, teamFactors, hypotheses, test, logit2 };
