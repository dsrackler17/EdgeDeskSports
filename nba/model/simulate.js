'use strict';
/* ===========================================================================
   EdgeDesk NBA — MODEL D: a possession-by-possession game simulation.

   The structure follows Štrumbelj & Vračar (2012, "Simulating a basketball
   match with a homogeneous Markov model and forecasting the outcome", IJF):
   each possession is a short chain of events whose probabilities come from
   the two teams' opponent-adjusted rates, and the game is the sum of its
   possessions. Rates (point in time, from the pass's adjusted ratings):

     turnover          TOV per possession (offence vs that defence)
     shooting trip     two free throws, chosen so FTM per FGA matches the
                       matchup's free-throw rate at the league's FT%
     shot              a three with the matchup's 3PA share; makes at p3 / p2,
                       solved so the matchup's eFG% is reproduced with the
                       league's split between twos and threes
     offensive rebound after a miss, at the matchup's OREB% (a new chance)

   Clock: each possession takes the time the matchup's pace implies
   (2880 s / possessions-per-team / 2), with noise. END GAME (last 60 s of
   regulation or overtime): a team trailing by 3–8 on defence fouls at once (two
   free throws for the leader, 5 s off the clock); a team trailing by 3 shoots
   a three; a tie goes to overtime: 300 s at the same rates. The mean is not
   recalibrated: the simulation is scored as a structural model, beside the
   calibrated ones (nba/model/walkforward.js candidate D_sim).
   =========================================================================== */
const S = require('../../engine/stats');

const LEAGUE = { ft: 0.765, p3share_of_efg: 0.36 };

function rates(f, side, lg) {
  /* side 'h' = home offence vs away defence */
  const tov = Math.min(0.25, Math.max(0.08, f['tov_' + side]));
  const efg = Math.min(0.62, Math.max(0.40, f['efg_' + side]));
  const t = Math.min(0.6, Math.max(0.1, f['tpar_' + side]));
  const orb = Math.min(0.40, Math.max(0.12, f['orb_' + side]));
  const ftr = Math.min(0.35, Math.max(0.10, f['ftr_' + side]));
  /* split eFG into p2 and p3 with the league's relationship p3 ≈ 0.70·p2 */
  const p2 = efg / ((1 - t) + 1.5 * t * 0.70); const p3 = 0.70 * p2;
  /* FT trips per possession so that FTM/FGA ≈ ftr: FGA per possession ≈ (1 − tov − q)/(1 − miss·orb) */
  const miss = (1 - t) * (1 - p2) + t * (1 - p3);
  const fgaPer = (q) => (1 - tov - q) / (1 - miss * orb);
  let q = 0.1; for (let i = 0; i < 20; i++) q = Math.max(0.01, Math.min(0.3, ftr * fgaPer(q) / (2 * lg.ft)));
  return { tov, q, t, p2, p3, orb };
}

function possession(R, rand, mode) {
  /* mode: 0 normal, 3 = must shoot a three */
  let pts = 0;
  for (let chance = 0; chance < 4; chance++) {
    if (rand() < (chance === 0 ? R.tov : R.tov * 0.4)) return pts;
    if (mode !== 3 && rand() < R.q) { if (rand() < LEAGUE.ft) pts++; if (rand() < LEAGUE.ft) pts++; return pts; }
    const three = mode === 3 || rand() < R.t;
    if (rand() < (three ? R.p3 : R.p2)) return pts + (three ? 3 : 2);
    if (rand() >= R.orb) return pts;
  }
  return pts;
}

/** expected points per possession of a rate set (the chance chain, four deep) */
function expectedPpp(R) {
  let ev = 0, reach = 1;
  for (let chance = 0; chance < 4; chance++) {
    const tov = chance === 0 ? R.tov : R.tov * 0.4;
    const live = reach * (1 - tov);
    ev += live * R.q * 2 * LEAGUE.ft;
    const shot = live * (1 - R.q);
    ev += shot * (R.t * R.p3 * 3 + (1 - R.t) * R.p2 * 2);
    reach = shot * (R.t * (1 - R.p3) + (1 - R.t) * (1 - R.p2)) * R.orb;
  }
  return ev;
}
/** scale the make rates so the chain reproduces a target points per possession
    (the efficiency model's, which the walk-forward validates); the event
    structure is kept, only its level is anchored */
function anchor(R, target) {
  if (!(target > 0.7 && target < 1.5)) return R;
  let lo = 0.6, hi = 1.6;
  for (let i = 0; i < 40; i++) { const k = (lo + hi) / 2; const e = expectedPpp(Object.assign({}, R, { p2: Math.min(0.95, R.p2 * k), p3: Math.min(0.95, R.p3 * k) })); if (e < target) lo = k; else hi = k; }
  const k = (lo + hi) / 2; return Object.assign({}, R, { p2: Math.min(0.95, R.p2 * k), p3: Math.min(0.95, R.p3 * k), anchor_k: k });
}

/** simulate n games; returns arrays of final margins and totals, regulation margins, OT counts */
function simulate(f, o) {
  o = o || {}; const n = o.n || 1000; const rand = S.rng(o.seed || 1);
  const lg = { ft: LEAGUE.ft };
  const H = anchor(rates(f, 'h', lg), (f.pp_h || 0) / 100), A = anchor(rates(f, 'a', lg), (f.pp_a || 0) / 100);
  const pace = Math.max(85, Math.min(110, f.pace || 98));
  const secPer = 2880 / (2 * pace);
  /* home court is already inside the adjusted four-factor expectations (their home term) */
  const homeEdge = 0;
  const Hh = Object.assign({}, H, { p2: H.p2 + homeEdge, p3: H.p3 + homeEdge * 0.7 }), Aa = Object.assign({}, A, { p2: A.p2 - homeEdge, p3: A.p3 - homeEdge * 0.7 });
  const margins = new Int16Array(n), totals = new Int16Array(n), regM = new Int16Array(n), ots = new Uint8Array(n);
  for (let g = 0; g < n; g++) {
    let hs = 0, as = 0; let ot = 0;
    const period = (len) => {
      let t = 0; let off = rand() < 0.5 ? 0 : 1;
      while (t < len) {
        const left = len - t; const lead = hs - as; const offTeam = off; /* 0 home, 1 away */
        const trailingDef = (offTeam === 0 && lead > 0 && lead <= 8 && left <= 60) || (offTeam === 1 && lead < 0 && lead >= -8 && left <= 60);
        if (trailingDef && Math.abs(lead) >= 3) {
          /* the defence is behind: foul at once */
          let p = 0; if (rand() < LEAGUE.ft) p++; if (rand() < LEAGUE.ft) p++;
          if (offTeam === 0) hs += p; else as += p; t += 5; off = 1 - off; continue;
        }
        const behindBy = offTeam === 0 ? -lead : lead;
        const mode = left <= 30 && behindBy === 3 ? 3 : 0;
        const p = possession(offTeam === 0 ? Hh : Aa, rand, mode);
        if (offTeam === 0) hs += p; else as += p;
        t += Math.max(4, secPer * (0.6 + 0.8 * rand())); off = 1 - off;
      }
    };
    period(2880);
    regM[g] = hs - as;
    while (hs === as && ot < 6) { period(300); ot++; }
    if (hs === as) { if (rand() < 0.5) hs++; else as++; }
    margins[g] = hs - as; totals[g] = hs + as; ots[g] = ot;
  }
  return { margins, totals, regM, ots, rates: { home: H, away: A, pace } };
}

/** empirical pmfs (lightly smoothed for scoring) */
function toDists(sim) {
  const n = sim.margins.length;
  const mk = (arr, lo, hi) => { const pmf = new Float64Array(hi - lo + 1).fill(0.2 / (hi - lo + 1) / n); for (const v of arr) { const i = Math.max(0, Math.min(hi - lo, v - lo)); pmf[i] += 1; } let s = 0; for (const v of pmf) s += v; for (let i = 0; i < pmf.length; i++) pmf[i] /= s; return { lo, pmf }; };
  let ph = 0; for (const v of sim.margins) if (v > 0) ph++;
  let ot = 0; for (const v of sim.ots) if (v > 0) ot++;
  return { margin: mk(sim.margins, -70, 70), total: mk(sim.totals, 100, 380), p_home: (ph + 0.5) / (n + 1), p_ot: ot / n };
}

module.exports = { simulate, toDists, rates, anchor, expectedPpp, LEAGUE };
