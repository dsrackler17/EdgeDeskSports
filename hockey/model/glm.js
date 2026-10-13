'use strict';
/* ===========================================================================
   EdgeDesk NHL — the expected-goals regression: ratings in, λ out.

   A Poisson GLM with a log link (Maher 1982 and every attack/defence goal
   model since): log E[regulation goals of team T vs O] = β · features. The
   ratings (hockey/model/ratings.js) enter as log ratios to the league, so a
   coefficient of 1 means "take the rating at face value" and 0 means "it
   adds nothing". The coefficients are fitted only on games from seasons
   before the one predicted.

   Candidate feature sets are declared here, BEFORE any season is scored, and
   walkforward.js picks among them by a rule written in that file.
   =========================================================================== */
const S = require('../../engine/stats');

function ln(v) { return Math.log(Math.max(0.2, Math.min(5, v == null || !isFinite(v) ? 1 : v))); }

const FEATURES = {
  home: (f) => f.home,
  ev_off: (f) => ln(f.ev_off),
  ev_def_opp: (f) => ln(f.ev_def_opp),
  g_off: (f) => ln(f.g_off),
  g_def_opp: (f) => ln(f.g_def_opp),
  pp_off: (f) => ln(f.pp_off),
  pk_def_opp: (f) => ln(f.pk_def_opp),
  pp_draw: (f) => ln(f.pp_draw),
  pk_take_opp: (f) => ln(f.pk_take_opp),
  fin: (f) => ln(f.fin),
  goalie_proj: (f) => f.opp_goalie_proj,
  goalie_conf: (f) => (f.opp_goalie_act != null ? f.opp_goalie_act : f.opp_goalie_proj),
  b2b: (f) => f.b2b,
  b2b_opp: (f) => f.b2b_opp,
  /* lineup availability (lineups.js): ln(tonight's lineup value / the team's typical), 0 when unknown */
  lu_own_proj: (f) => f.lu_own_proj || 0,
  lu_opp_proj: (f) => f.lu_opp_proj || 0,
  lu_own_conf: (f) => (f.lu_own_conf != null ? f.lu_own_conf : f.lu_own_proj || 0),
  lu_opp_conf: (f) => (f.lu_opp_conf != null ? f.lu_opp_conf : f.lu_opp_proj || 0),
};

/* the candidates (fixed before scoring) */
const CANDIDATES = {
  const_home: ['home'],
  goals_only: ['home', 'g_off', 'g_def_opp', 'b2b', 'b2b_opp'],
  xg_no_goalie: ['home', 'ev_off', 'ev_def_opp', 'g_off', 'g_def_opp', 'pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp', 'fin', 'b2b', 'b2b_opp'],
  xg_goalie_projected: ['home', 'ev_off', 'ev_def_opp', 'g_off', 'g_def_opp', 'pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp', 'fin', 'goalie_proj', 'b2b', 'b2b_opp'],
  xg_goalie_confirmed: ['home', 'ev_off', 'ev_def_opp', 'g_off', 'g_def_opp', 'pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp', 'fin', 'goalie_conf', 'b2b', 'b2b_opp'],
  /* added 2026-10-13 with the data pack's P0 lineup item, after the confirmation
     window had been read for the five above; the selection rule is unchanged */
  xg_lineup_projected: ['home', 'ev_off', 'ev_def_opp', 'g_off', 'g_def_opp', 'pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp', 'fin', 'b2b', 'b2b_opp', 'lu_own_proj', 'lu_opp_proj'],
  xg_lineup_confirmed: ['home', 'ev_off', 'ev_def_opp', 'g_off', 'g_def_opp', 'pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp', 'fin', 'b2b', 'b2b_opp', 'lu_own_conf', 'lu_opp_conf'],
  xg_all_confirmed: ['home', 'ev_off', 'ev_def_opp', 'g_off', 'g_def_opp', 'pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp', 'fin', 'goalie_conf', 'b2b', 'b2b_opp', 'lu_own_conf', 'lu_opp_conf'],
};
const LINEUP_CANDIDATES = ['xg_lineup_projected', 'xg_lineup_confirmed', 'xg_all_confirmed'];

function design(f, names) { const x = [1]; for (const n of names) x.push(FEATURES[n](f)); return x; }
/* The league's running scoring level enters as an OFFSET (coefficient fixed at 1):
   the intercept is then a ratio to it, so a league-wide rise in scoring (2017-18,
   2021-22) moves every λ at once instead of waiting five seasons for the fit. */
function offset(f) { return Math.log(Math.max(1, f.league_g_pg || 3)); }

/** fit on rows [{ f (snapshot), y (regulation goals) }] */
function fit(rows, names, o) {
  const X = rows.map((r) => design(r.f, names)); const y = rows.map((r) => r.y);
  const m = S.poisson(X, y, { l2: (o && o.l2) == null ? 2 : o.l2, offset: rows.map((r) => offset(r.f)) });
  return { names, offset: 'log(league goals per team-game, running)', beta: m.beta.map((b) => +b.toFixed(6)), se: m.se ? m.se.map((b) => +b.toFixed(6)) : null, n: rows.length, deviance: m.deviance };
}
function predict(model, f) { return S.predictPoisson(model.beta, design(f, model.names), offset(f)); }

/* ---------------------------------------------------------------------------
   RECALIBRATION OF THE PAIR (λH, λA), fitted on EARLIER seasons' out-of-sample
   predictions. Selection-window diagnostics showed the regression's predicted
   game totals vary more than real totals do (slope of actual on predicted
   0.79) while its home/away split is slightly timid (1.075). Two numbers fix
   both without touching the ratings:
     total  T = λH + λA       log T' = log c + a·(log T − log c)   (c = mean T)
     split  r = logit(λH / T)        r' = b·r
   The Poisson likelihood factorises exactly into the total (T ~ Poisson) and
   the split (home goals | T ~ Binomial), so a and b are fitted separately by
   maximum likelihood on a grid. Identity (a = b = 1) when no earlier
   out-of-sample season exists.
   --------------------------------------------------------------------------- */
function fitPairCalibration(rows) {
  /* rows: [{ lh, la, gh, ga }] — raw predicted regulation λ and observed regulation goals */
  if (!rows || rows.length < 500) return { a: 1, b: 1, c: null, n: rows ? rows.length : 0, basis: 'identity: fewer than 500 earlier out-of-sample games' };
  let c = 0; for (const r of rows) c += Math.log(r.lh + r.la); c = Math.exp(c / rows.length);
  let bestA = null, bestB = null;
  for (let a = 0.3; a <= 1.3001; a += 0.025) {
    let ll = 0;
    for (const r of rows) { const T = c * Math.pow((r.lh + r.la) / c, a); const y = r.gh + r.ga; ll += y * Math.log(T) - T; }
    if (!bestA || ll > bestA.ll) bestA = { a, ll };
  }
  for (let b = 0.7; b <= 1.6001; b += 0.025) {
    let ll = 0;
    for (const r of rows) { const pi0 = r.lh / (r.lh + r.la); const z = b * Math.log(pi0 / (1 - pi0)); const pi = 1 / (1 + Math.exp(-z)); ll += r.gh * Math.log(pi) + r.ga * Math.log(1 - pi); }
    if (!bestB || ll > bestB.ll) bestB = { b, ll };
  }
  return { a: +bestA.a.toFixed(3), b: +bestB.b.toFixed(3), c: +c.toFixed(4), n: rows.length, basis: 'maximum likelihood on earlier seasons\' out-of-sample predictions' };
}
function applyPairCalibration(lh, la, cal) {
  if (!cal || (cal.a === 1 && cal.b === 1) || !cal.c) return { lh, la };
  const T = cal.c * Math.pow((lh + la) / cal.c, cal.a);
  const pi0 = lh / (lh + la); const z = cal.b * Math.log(pi0 / (1 - pi0)); const pi = 1 / (1 + Math.exp(-z));
  return { lh: T * pi, la: T * (1 - pi) };
}

module.exports = { FEATURES, CANDIDATES, LINEUP_CANDIDATES, design, offset, fit, predict, ln, fitPairCalibration, applyPairCalibration };
