'use strict';
/* ===========================================================================
   NCAAM-EARLY — the T3 model: preseason prior, Bayesian in-season update,
   game projection. Every constant is from the registered config/model_v0.json
   or the engine's own frozen state (ratings.js); nothing here is fitted.

   Units (the engine's): a team's `off` is points scored per 100 possessions
   above the league mean mu, `allow` points allowed per 100 above mu (+ is a
   worse defence), `tempo` possessions per game above the league pace tau. The
   home term eta is the engine's own (per 100, per side), neutral = 0.

   1. PRESEASON PRIOR (config preseason_prior)
        carried  = carry x last season's rating        (engine carry, 0.9)
        roster   = the T2 roster build (features.js): off = roster_off,
                   allow = -roster_def (a better defence allows fewer)
        w        = roster_weight; after a coaching change the carried part is
                   shrunk further: w + (1 - w) x coach_shrink
        prior    = (1 - w) carried + w roster      (no last season: roster only)
        tempo    = last season's x carry_tempo; when the coach record has a
                   tempo history (any coach, new or not), the history is
                   blended in by (1 - returning minutes share)
        variance per side = (s2 / lambda) x variance_multiplier (the engine's
                   opening variance, inflated by the registered unknowns)

   2. IN-SEASON UPDATE (config in_season_update)
        w(g)  the registered prior weight after g games (linear between the
              registered points; 0.05 from 15 games on)
        w'(g) = w / (w + vm (1 - w)): scaling the prior's precision by 1/vm,
              the normal-normal consequence of the variance multiplier, so a
              rebuilt, high-variance team leans on its games sooner
        The ratings are a joint opponent-adjusted ridge fit of this season's
        D-I v D-I games, each team pulled toward its own prior with the
        strength that gives it exactly w'(g): lambda_t = 70 g w' / (1 - w')
        possessions. Posterior variance = w' x prior variance.

   3. PROJECTION
        points per 100 (home) = mu + off_h + allow_a + eta v,  v = 1 home, 0 neutral
        possessions           = tau + tempo_h + tempo_a
        margin, total         = per-100 values x possessions / 100
        sd margin             = sqrt(base_margin_sd^2 + (var_h + var_a) x (poss/100)^2 x 2)
        sd total              = sqrt(base_total_sd^2 + the same rating term)
        win / cover / over probabilities from the normal; a whole-number line's
        push mass (the density over one point) is reported and removed
   =========================================================================== */
const POSS_PER_GAME = 70;

const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
const v = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);

/** the preseason prior of one team. prevRating: the engine's season-end
    rating of last season (or null); state: { s2, lambda } of last season */
function preseasonPrior(feat, prevRating, state, cfg, engine) {
  const PP = cfg.preseason_prior, carry = engine.carry, carryT = engine.carry_tempo;
  const flags = [];
  let w = v(PP.roster_weight);
  if (feat.coach_change) w = w + (1 - w) * v(PP.coach_change.coach_shrink);
  const rOff = feat.roster_off, rAllow = feat.roster_def == null ? null : -feat.roster_def;
  let off, allow;
  if (prevRating && rOff != null) { off = (1 - w) * carry * prevRating.off + w * rOff; allow = (1 - w) * carry * prevRating.allow + w * rAllow; }
  else if (rOff != null) { off = rOff; allow = rAllow; flags.push('NO_PRIOR_SEASON_RATING: roster build only'); }
  else if (prevRating) { off = carry * prevRating.off; allow = carry * prevRating.allow; flags.push('NO_ROSTER_BUILD: carried rating only'); }
  else return null;
  let tempo = prevRating && prevRating.tempo != null ? carryT * prevRating.tempo : 0;
  if (!(prevRating && prevRating.tempo != null)) flags.push('NO_PRIOR_TEMPO');
  const tempoWithout = tempo;
  if (feat.coach_tempo_resid != null) {   /* config: "when a coach record with history exists" */
    const c = feat.returning_minutes_share == null ? 0 : feat.returning_minutes_share;
    tempo = c * tempo + (1 - c) * feat.coach_tempo_resid;
  }
  const vm = feat.variance_multiplier == null ? 1 : feat.variance_multiplier;
  const varSide = state && state.s2 != null ? (state.s2 / state.lambda) * vm : null;
  if (varSide == null) flags.push('NO_ENGINE_VARIANCE');
  return { off, allow, tempo, tempo_coach_shift: tempo - tempoWithout, vm, var_side: varSide, roster_weight: w, flags };
}

/** the registered prior weight after g games, and its variance-scaled form */
function priorWeight(g, vm, cfg) {
  const tab = cfg.in_season_update.prior_weight_by_games;
  const pts = Object.keys(tab).map(Number).sort((a, b) => a - b);
  let w;
  if (g <= pts[0]) w = tab[pts[0]];
  else if (g >= pts[pts.length - 1]) w = tab[pts[pts.length - 1]];
  else {
    let i = 0; while (pts[i + 1] < g) i++;
    const a = pts[i], b = pts[i + 1];
    w = tab[a] + ((g - a) / (b - a)) * (tab[b] - tab[a]);
  }
  const wp = w >= 1 ? 1 : w / (w + (vm || 1) * (1 - w));
  return { w, w_eff: wp };
}

/** the in-season ratings: priors (Map team -> preseasonPrior), games (this
    season's D-I v D-I finals available at the time: { home, away, neutral,
    yH, yA (points per 100), poss, tempo }), league { mu, eta, tau } */
function fitSeason(priors, games, league, cfg, o) {
  o = o || {};
  const sweeps = o.sweeps || 25;
  const n = new Map();
  for (const g of games) { n.set(g.home, (n.get(g.home) || 0) + 1); n.set(g.away, (n.get(g.away) || 0) + 1); }
  const R = new Map(), lam = new Map(), lamT = new Map();
  for (const [id, p] of priors) {
    const k = n.get(id) || 0; const { w_eff } = priorWeight(k, p.vm, cfg);
    R.set(id, { off: p.off, allow: p.allow, tempo: p.tempo, games: k, w_prior: w_eff, var_side: p.var_side == null ? null : w_eff * p.var_side });
    lam.set(id, k === 0 || w_eff >= 1 ? Infinity : (POSS_PER_GAME * k * w_eff) / (1 - w_eff));
    lamT.set(id, k === 0 || w_eff >= 1 ? Infinity : (k * w_eff) / (1 - w_eff));
  }
  const usable = games.filter((g) => R.has(g.home) && R.has(g.away));
  const { mu, eta, tau } = league;
  for (let it = 0; it < sweeps; it++) {
    const acc = new Map();
    const A = (id) => { if (!acc.has(id)) acc.set(id, { so: 0, wo: 0, sa: 0, wa: 0, st: 0, wt: 0 }); return acc.get(id); };
    for (const g of usable) {
      const h = R.get(g.home), a = R.get(g.away), vv = g.neutral ? 0 : 1;
      A(g.home).so += g.poss * (g.yH - mu - a.allow - eta * vv); A(g.home).wo += g.poss;
      A(g.away).so += g.poss * (g.yA - mu - h.allow + eta * vv); A(g.away).wo += g.poss;
      A(g.away).sa += g.poss * (g.yH - mu - h.off - eta * vv); A(g.away).wa += g.poss;
      A(g.home).sa += g.poss * (g.yA - mu - a.off + eta * vv); A(g.home).wa += g.poss;
      if (g.tempo != null) { A(g.home).st += g.tempo - tau - a.tempo; A(g.home).wt += 1; A(g.away).st += g.tempo - tau - h.tempo; A(g.away).wt += 1; }
    }
    for (const [id, r] of R) {
      const L = lam.get(id), LT = lamT.get(id); if (!Number.isFinite(L)) continue;
      const p = priors.get(id), x = acc.get(id); if (!x) continue;
      r.off = (x.so + L * p.off) / (x.wo + L);
      r.allow = (x.sa + L * p.allow) / (x.wa + L);
      if (Number.isFinite(LT) && x.wt > 0) r.tempo = (x.st + LT * p.tempo) / (x.wt + LT);
    }
  }
  return R;
}

/** one game's projection from the ratings in force before its tip */
function project(h, a, neutral, league, cfg) {
  const vv = neutral ? 0 : 1;
  const yH = league.mu + h.off + a.allow + league.eta * vv;
  const yA = league.mu + a.off + h.allow - league.eta * vv;
  const poss = league.tau + (h.tempo || 0) + (a.tempo || 0);
  const margin = ((yH - yA) * poss) / 100, total = ((yH + yA) * poss) / 100;
  const f = (poss / 100) * (poss / 100);
  const ratingVar = h.var_side != null && a.var_side != null ? 2 * (h.var_side + a.var_side) * f : null;
  const GP = cfg.game_projection;
  const sdM = Math.sqrt(Math.pow(v(GP.base_margin_sd), 2) + (ratingVar || 0));
  const sdT = Math.sqrt(Math.pow(v(GP.base_total_sd), 2) + (ratingVar || 0));
  return { home_points: (yH * poss) / 100, away_points: (yA * poss) / 100, possessions: poss, margin, total,
    fair_spread_home: -margin, fair_total: total, sd_margin: sdM, sd_total: sdT, rating_var: ratingVar,
    win_prob_home: Phi(margin / sdM), flags: ratingVar == null ? ['NO_RATING_VARIANCE'] : [] };
}

/** P(the home side covers a home line L): margin + L > 0; a whole-number
    line's push mass is reported and the cover probability is conditional on
    no push (how a pushed bet is settled) */
function coverProb(p, line) {
  const z = (p.margin + line) / p.sd_margin;
  const whole = Math.abs(line - Math.round(line)) < 1e-9;
  const push = whole ? phi(z) / p.sd_margin : 0;
  const win = Phi(z) - push / 2, lose = 1 - Phi(z) - push / 2;
  return { home_cover: win / (win + lose), away_cover: lose / (win + lose), push };
}
function overProb(p, total) {
  const z = (p.total - total) / p.sd_total;
  const whole = Math.abs(total - Math.round(total)) < 1e-9;
  const push = whole ? phi(z) / p.sd_total : 0;
  const over = Phi(z) - push / 2, under = 1 - Phi(z) - push / 2;
  return { over: over / (over + under), under: under / (over + under), push };
}

module.exports = { preseasonPrior, priorWeight, fitSeason, project, coverProb, overProb, Phi, POSS_PER_GAME };
