'use strict';
/* ===========================================================================
   EdgeDesk NHL — from expected goals to a full score distribution, and from
   the distribution to every market's fair price. Browser and Node (UMD:
   window.EDNHLDist), so the research panel prices with the same code.

   REGULATION. Sixty minutes in 30-second steps. In each step each team scores
   at its base rate times a SCORE-EFFECT multiplier m(lead, time): trailing
   teams press, leaders sit back, and in the last minutes a trailing team
   pulls its goalie, which raises both its own rate (6-on-5) and its
   opponent's (the empty net). The multipliers are estimated from every goal
   and every second of regulation in seasons before the one priced
   (estimateScoreEffects), following the simulation approach of Beaudoin &
   Swartz (2010, "Strategies for pulling the goalie in hockey"). Base rates
   are solved so the expected regulation goals equal the model's λ for each
   team. The result is an exact distribution (dynamic programming, no Monte
   Carlo noise), with the empty-net goals that make −1.5 cover more often than
   a plain Poisson says.

   OVERTIME. Regular season: 5 minutes sudden death (3-on-3 since 2015-16,
   4-on-4 before), then a shootout. Each team's OT rate is k × its regulation
   rate, with k fitted so the league's share of tied games decided in OT
   matches seasons before. The shootout is won by the home team at the rate
   observed in seasons before (close to 50%). Playoffs: sudden death until a
   goal, won in proportion to the two rates.

   SETTLEMENT (the common North American book rules, stated on every price):
     moneyline (2-way)  includes overtime and the shootout
     regulation 3-way   60 minutes only; a tie is its own outcome
     puck line ±1.5     includes OT/SO; an OT or shootout win is a 1-goal win
     total, team total  include OT; the shootout winner is credited ONE goal
                        (the official final score); a whole-number line can push
   Books that settle differently must be compared on their own terms; the
   board refuses a quote whose market definition is not one of these.

   TWO OPTIONAL SHAPE TERMS (off unless a fitted value is passed; both are
   fitted walk-forward and earn their place in hockey/lab/run.js, or stay off):
     pace_shape k     a game-level pace multiplier G ~ Gamma(k, 1/k), shared by
                      both teams (a fast or slow night: penalties, goaltending,
                      ice). It keeps each team's mean, widens the total
                      (Var += (λH+λA)²/k) and barely moves the margin. Computed
                      exactly as a 9-point equal-probability mixture matched to
                      mean 1 and variance 1/k.
     draw_inflation δ the 60-minute tie is inflated by (1+δ) and the matrix
                      renormalised (the diagonal-inflation idea of Karlis &
                      Ntzoufras 2003): a reduced form of the tied-late play the
                      loser point rewards, beyond what the score effects carry.
   FIRST PERIOD. With `periods: true` the same rates are run over the first
   1,200 seconds alone, for the first-period 3-way and totals.
   =========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDNHLDist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAXG = 12;          /* goals per team tracked; the tail is folded into the last cell */
  const STEP = 30;          /* seconds */
  const T_BUCKETS = [0, 2400, 3000, 3300, 3420, 3480, 3540, 3600];
  const D_MIN = -3, D_MAX = 3;

  /* an effects object carries its own bucket edges (t_buckets); older files without them use T_BUCKETS */
  function bucketOf(t, tb) { tb = tb || T_BUCKETS; for (let i = tb.length - 2; i >= 0; i--) if (t >= tb[i]) return i; return 0; }
  /* a finer profile that separates the first period from the second (the first is the lowest-scoring) */
  const T_BUCKETS_FINE = [0, 1200, 2400, 3000, 3300, 3420, 3480, 3540, 3600];
  function dIdx(d) { return Math.max(D_MIN, Math.min(D_MAX, d)) - D_MIN; }

  /** neutral multipliers (all ones) */
  function neutralEffects() { return { t_buckets: T_BUCKETS, d_min: D_MIN, d_max: D_MAX, m: T_BUCKETS.slice(0, -1).map(() => new Array(D_MAX - D_MIN + 1).fill(1)) }; }

  /**
   * Estimate m[timeBucket][lead] from completed games.
   * games: [{ goals: [{ t: gameSecond, side: 'home'|'away', pre: preGoalLeadOfScorer }] }] (regulation goals only)
   */
  function estimateScoreEffects(games, o) {
    o = o || {};
    const TB = o.t_buckets || T_BUCKETS;
    const nb = TB.length - 1, nd = D_MAX - D_MIN + 1;
    const goals = Array.from({ length: nb }, () => new Array(nd).fill(0));
    const secs = Array.from({ length: nb }, () => new Array(nd).fill(0));
    let G = 0, Ssec = 0;
    for (const g of games) {
      const gl = g.goals.filter((x) => x.t < 3600).sort((a, b) => a.t - b.t);
      let h = 0, a = 0, t0 = 0;
      const addTime = (t1) => {
        for (let b = 0; b < nb; b++) {
          const lo = Math.max(t0, TB[b]), hi = Math.min(t1, TB[b + 1]);
          if (hi > lo) { secs[b][dIdx(h - a)] += hi - lo; secs[b][dIdx(a - h)] += hi - lo; Ssec += 2 * (hi - lo); }
        }
      };
      for (const x of gl) {
        addTime(x.t); t0 = x.t;
        const lead = x.side === 'home' ? h - a : a - h;
        goals[bucketOf(x.t, TB)][dIdx(lead)]++; G++;
        if (x.side === 'home') h++; else a++;
      }
      addTime(3600);
    }
    const base = G / Ssec;
    const k = o.prior_goals == null ? 25 : o.prior_goals;
    const m = goals.map((row, b) => row.map((g, d) => {
      const s = secs[b][d]; if (!s) return 1;
      return (g + k) / (s * base + k);            /* shrunk toward 1 with k pseudo-goals */
    }));
    return { t_buckets: TB, d_min: D_MIN, d_max: D_MAX, m: m.map((r) => r.map((v) => +v.toFixed(4))), goals: G, team_seconds: Ssec, base_rate_per_hour: +(base * 3600).toFixed(4), cells: goals.map((r, b) => r.map((g, d) => ({ goals: g, seconds: secs[b][d] }))) };
  }

  /* one regulation pass; two buffers, no allocation per step */
  const N1 = MAXG + 1;
  const BUF_A = new Float64Array(N1 * N1), BUF_B = new Float64Array(N1 * N1);
  function runRegulation(rH, rA, eff, tEnd) {
    let P = BUF_A, Q = BUF_B;
    P.fill(0); P[0] = 1;
    let hiH = 0, hiA = 0; /* the reachable corner grows by one goal per step at most */
    const end = tEnd || 3600;
    for (let t = 0; t < end; t += STEP) {
      const mrow = eff.m[bucketOf(t, eff.t_buckets)];
      const sH = rH * STEP, sA = rA * STEP;
      Q.fill(0);
      const maxH = Math.min(MAXG, hiH), maxA = Math.min(MAXG, hiA);
      for (let h = 0; h <= maxH; h++) {
        const base = h * N1;
        for (let a = 0; a <= maxA; a++) {
          const p = P[base + a]; if (p < 1e-14) continue;
          const d = h - a;
          let ph = sH * mrow[(d < D_MIN ? D_MIN : d > D_MAX ? D_MAX : d) - D_MIN];
          let pa = sA * mrow[(-d < D_MIN ? D_MIN : -d > D_MAX ? D_MAX : -d) - D_MIN];
          const s = ph + pa; if (s > 0.9) { ph *= 0.9 / s; pa *= 0.9 / s; }
          Q[base + a] += p * (1 - ph - pa);
          Q[(h < MAXG ? h + 1 : MAXG) * N1 + a] += p * ph;
          Q[base + (a < MAXG ? a + 1 : MAXG)] += p * pa;
        }
      }
      hiH++; hiA++;
      const tmp = P; P = Q; Q = tmp;
    }
    return Float64Array.from(P);
  }
  /* add k ~ Poisson(lam3) goals to BOTH teams */
  function commonShock(P, lam3) {
    const N = MAXG + 1; const Q = new Float64Array(N * N);
    const pk = []; let p = Math.exp(-lam3), acc = 0;
    for (let k = 0; k <= MAXG; k++) { if (k > 0) p *= lam3 / k; pk.push(p); acc += p; }
    pk[MAXG] += Math.max(0, 1 - acc);
    for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
      const v = P[h * N + a]; if (v < 1e-15) continue;
      for (let k = 0; k <= MAXG; k++) { const w = pk[k]; if (w < 1e-15) break; Q[Math.min(MAXG, h + k) * N + Math.min(MAXG, a + k)] += v * w; }
    }
    return Q;
  }
  function means(P) {
    const N = MAXG + 1; let eh = 0, ea = 0;
    for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) { const p = P[h * N + a]; eh += h * p; ea += a * p; }
    return { eh, ea };
  }

  /* ---------- the pace mixture: Gamma(k, 1/k) on 9 equal-probability points ---------- */
  function lnGamma(x) { /* Lanczos */
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    x -= 1; let a = c[0]; const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  /* regularised lower incomplete gamma P(a, x) (series / continued fraction) */
  function gammaP(a, x) {
    if (x <= 0) return 0;
    const gln = lnGamma(a);
    if (x < a + 1) { let ap = a, sum = 1 / a, del = sum; for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; } return sum * Math.exp(-x + a * Math.log(x) - gln); }
    let b = x + 1 - a, cc = 1 / 1e-300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; cc = b + an / cc; if (Math.abs(cc) < 1e-300) cc = 1e-300; d = 1 / d; const del = d * cc; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
    return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
  }
  const MIX_CACHE = {};
  /** 9 points with mean exactly 1 and variance exactly 1/k (equal weights) */
  function paceMixture(k) {
    const key = String(k); if (MIX_CACHE[key]) return MIX_CACHE[key];
    const m = 9, pts = [];
    for (let i = 0; i < m; i++) {
      const q = (i + 0.5) / m; let lo = 0, hi = 20;
      for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (gammaP(k, mid * k) < q) lo = mid; else hi = mid; }
      pts.push((lo + hi) / 2);
    }
    const mean = pts.reduce((a, v) => a + v, 0) / m, v = pts.reduce((a, x) => a + (x - mean) * (x - mean), 0) / m;
    const sc = Math.sqrt((1 / k) / v);
    const out = pts.map((x) => Math.max(0.02, 1 + (x - mean) * sc));
    MIX_CACHE[key] = out; return out;
  }
  function mixRegulation(rH, rA, eff, mix, tEnd) {
    if (!mix) return runRegulation(rH, rA, eff, tEnd);
    const N = MAXG + 1; const P = new Float64Array(N * N);
    for (const g of mix) { const Q = runRegulation(rH * g, rA * g, eff, tEnd); for (let i = 0; i < P.length; i++) P[i] += Q[i] / mix.length; }
    return P;
  }
  function inflateDraws(P, delta) {
    if (!(delta > 0)) return P;
    const N = MAXG + 1; let z = 0;
    for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) { const i = h * N + a; if (h === a) P[i] *= 1 + delta; z += P[i]; }
    for (let i = 0; i < P.length; i++) P[i] /= z;
    return P;
  }

  /**
   * The game's distribution.
   * o: { lamH, lamA (expected REGULATION goals), effects, ot: { k, so_home, format: 'R3v3'|'R4v4'|'PO' } }
   */
  function game(o) {
    const eff = o.effects || neutralEffects();
    /* COMMON SHOCK (bivariate Poisson, Karlis & Ntzoufras 2003): a share of each
       team's expected goals arrives as goals BOTH teams score (a fast-paced game,
       two shaky goalies, a penalty-filled night). It leaves each team's mean
       unchanged, narrows the margin and widens the total. rho is fitted on
       seasons before the one priced (walkforward.js fitRho). */
    const rho = o.rho || 0;
    const lam3 = rho * Math.min(o.lamH, o.lamA);
    const l1 = o.lamH - lam3, l2 = o.lamA - lam3;
    let rH = l1 / 3600, rA = l2 / 3600;
    let P = null;
    /* solve the base rates so E[regulation goals] = λ (converges in two passes; the third is the answer) */
    for (let it = 0; it < 2; it++) {
      P = runRegulation(rH, rA, eff);
      const m = means(P);
      rH *= l1 / Math.max(1e-9, m.eh); rA *= l2 / Math.max(1e-9, m.ea);
    }
    const mix = o.pace_shape > 0 ? paceMixture(o.pace_shape) : null;
    if (mix) { /* one more solve on the mixture itself, so the means stay λ */
      const m = means(mixRegulation(rH, rA, eff, mix));
      rH *= l1 / Math.max(1e-9, m.eh); rA *= l2 / Math.max(1e-9, m.ea);
    }
    P = mixRegulation(rH, rA, eff, mix);
    if (lam3 > 0) P = commonShock(P, lam3);
    P = inflateDraws(P, o.draw_inflation);
    const P1 = o.periods ? mixRegulation(rH, rA, eff, mix, 1200) : null;
    const N = MAXG + 1;
    const reg = { home: 0, draw: 0, away: 0 };
    for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) { const p = P[h * N + a]; if (h > a) reg.home += p; else if (h < a) reg.away += p; else reg.draw += p; }
    const ot = o.ot || { k: 1, so_home: 0.5, format: 'R3v3' };
    let pOtH, pOtA, pSoH, pSoA;
    if (ot.format === 'PO') {
      pOtH = o.lamH / (o.lamH + o.lamA); pOtA = 1 - pOtH; pSoH = 0; pSoA = 0;
    } else {
      const h60 = ot.k * o.lamH / 60, a60 = ot.k * o.lamA / 60; /* goals per minute in OT */
      const pGoal = 1 - Math.exp(-(h60 + a60) * 5);
      pOtH = pGoal * h60 / (h60 + a60); pOtA = pGoal * a60 / (h60 + a60);
      const pSo = 1 - pGoal; pSoH = pSo * ot.so_home; pSoA = pSo * (1 - ot.so_home);
    }
    /* the official final: OT goal or shootout credits the winner one goal */
    const F = new Float64Array((MAXG + 2) * (MAXG + 2)); const NF = MAXG + 2;
    for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
      const p = P[h * N + a]; if (!p) continue;
      if (h !== a) F[h * NF + a] += p;
      else { F[(h + 1) * NF + a] += p * (pOtH + pSoH); F[h * NF + a + 1] += p * (pOtA + pSoA); }
    }
    const homeWin = reg.home + reg.draw * (pOtH + pSoH);
    return {
      lamH: o.lamH, lamA: o.lamA, rho, pace_shape: o.pace_shape || null, draw_inflation: o.draw_inflation || 0, reg, reg_matrix: P, final_matrix: F, p1_matrix: P1, maxg: MAXG,
      tie_split: { ot_home: pOtH, ot_away: pOtA, so_home: pSoH, so_away: pSoA },
      p_home: homeWin, p_away: 1 - homeWin,
      p_ot: reg.draw * (pOtH + pOtA), p_so: reg.draw * (pSoH + pSoA),
    };
  }

  /* ---------- markets from the final matrix ---------- */
  function finalIter(D, fn) { const NF = D.maxg + 2; for (let h = 0; h < NF; h++) for (let a = 0; a < NF; a++) { const p = D.final_matrix[h * NF + a]; if (p) fn(h, a, p); } }
  /** P(home margin + line > 0), P(push), P(lose) for the home side at `line` (e.g. −1.5) */
  function spread(D, homeLine) {
    let win = 0, push = 0;
    finalIter(D, (h, a, p) => { const x = h - a + homeLine; if (x > 1e-9) win += p; else if (Math.abs(x) <= 1e-9) push += p; });
    return { win, push, lose: Math.max(0, 1 - win - push) };
  }
  function total(D, line) {
    let over = 0, push = 0;
    finalIter(D, (h, a, p) => { const x = h + a - line; if (x > 1e-9) over += p; else if (Math.abs(x) <= 1e-9) push += p; });
    return { over, push, under: Math.max(0, 1 - over - push) };
  }
  function teamTotal(D, side, line) {
    let over = 0, push = 0;
    finalIter(D, (h, a, p) => { const g = side === 'home' ? h : a; const x = g - line; if (x > 1e-9) over += p; else if (Math.abs(x) <= 1e-9) push += p; });
    return { over, push, under: Math.max(0, 1 - over - push) };
  }
  function totalPmf(D) { const out = new Array(2 * (D.maxg + 1) + 1).fill(0); finalIter(D, (h, a, p) => { out[h + a] += p; }); return out; }
  function expectedTotal(D) { let e = 0; finalIter(D, (h, a, p) => { e += (h + a) * p; }); return e; }
  /** the line at which over and under are closest to even (half-goal grid) */
  function fairTotalLine(D) {
    let best = null;
    for (let L = 3.5; L <= 9.5; L += 0.5) { const t = total(D, L); const gap = Math.abs(t.over - t.under); if (!best || gap < best.gap) best = { line: L, gap, over: t.over, under: t.under, push: t.push }; }
    return best;
  }

  function regIter(D, fn) { const N = D.maxg + 1; for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) { const p = D.reg_matrix[h * N + a]; if (p) fn(h, a, p); } }
  function p1Iter(D, fn) { if (!D.p1_matrix) return false; const N = D.maxg + 1; for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) { const p = D.p1_matrix[h * N + a]; if (p) fn(h, a, p); } return true; }
  /** 60-minute total (overtime and shootout excluded) */
  function regulationTotal(D, line) { let over = 0, push = 0; regIter(D, (h, a, p) => { const x = h + a - line; if (x > 1e-9) over += p; else if (Math.abs(x) <= 1e-9) push += p; }); return { over, push, under: Math.max(0, 1 - over - push) }; }
  /** 60-minute handicap for the home side */
  function regulationSpread(D, homeLine) { let win = 0, push = 0; regIter(D, (h, a, p) => { const x = h - a + homeLine; if (x > 1e-9) win += p; else if (Math.abs(x) <= 1e-9) push += p; }); return { win, push, lose: Math.max(0, 1 - win - push) }; }
  function firstPeriod(D) {
    if (!D.p1_matrix) return null;
    const r = { home: 0, draw: 0, away: 0, totals: {} };
    p1Iter(D, (h, a, p) => { if (h > a) r.home += p; else if (h < a) r.away += p; else r.draw += p; });
    for (const L of [0.5, 1, 1.5, 2, 2.5]) { let over = 0, push = 0; p1Iter(D, (h, a, p) => { const x = h + a - L; if (x > 1e-9) over += p; else if (Math.abs(x) <= 1e-9) push += p; }); r.totals[L] = { over, push, under: Math.max(0, 1 - over - push) }; }
    let e = 0; p1Iter(D, (h, a, p) => { e += (h + a) * p; }); r.expected = e;
    return r;
  }

  /* ---------- prices ---------- */
  function probToAmerican(p) { if (!(p > 0 && p < 1)) return null; const d = 1 / p; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  /** fair price for a market with a push: the price at which EV = 0 given win/push/lose */
  function fairAmericanWithPush(win, push) { const lose = 1 - win - push; if (!(win > 0) || !(lose > 0)) return null; const dec = 1 + lose / win; return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1)); }

  /** the standard price sheet */
  function sheet(D, o) {
    o = o || {};
    const pl = spread(D, -1.5), plA = spread(D, 1.5);
    const ft = fairTotalLine(D);
    const totals = {};
    for (const L of o.total_lines || [5, 5.5, 6, 6.5, 7]) { const t = total(D, L); totals[L] = { over: t.over, under: t.under, push: t.push, fair_over: fairAmericanWithPush(t.over, t.push), fair_under: fairAmericanWithPush(t.under, t.push) }; }
    const tt = { home: {}, away: {} };
    for (const L of o.team_lines || [2.5, 3, 3.5]) for (const side of ['home', 'away']) { const t = teamTotal(D, side, L); tt[side][L] = { over: t.over, under: t.under, push: t.push, fair_over: fairAmericanWithPush(t.over, t.push), fair_under: fairAmericanWithPush(t.under, t.push) }; }
    return {
      moneyline: { home: D.p_home, away: D.p_away, fair_home: probToAmerican(D.p_home), fair_away: probToAmerican(D.p_away), settles: 'includes overtime and shootout' },
      regulation: { home: D.reg.home, draw: D.reg.draw, away: D.reg.away, fair_home: probToAmerican(D.reg.home), fair_draw: probToAmerican(D.reg.draw), fair_away: probToAmerican(D.reg.away), settles: '60 minutes only' },
      puck_line: {
        home_minus_1_5: pl.win, away_plus_1_5: 1 - pl.win, away_minus_1_5: spread(D, 1.5).lose, home_plus_1_5: 1 - spread(D, 1.5).lose,
        fair_home_minus_1_5: probToAmerican(pl.win), fair_away_plus_1_5: probToAmerican(1 - pl.win),
        fair_away_minus_1_5: probToAmerican(plA.lose), fair_home_plus_1_5: probToAmerican(1 - plA.lose),
        settles: 'includes overtime and shootout; an OT/SO win is a one-goal win',
      },
      total: { expected: expectedTotal(D), fair_line: ft.line, lines: totals, settles: 'includes overtime; the shootout winner is credited one goal' },
      team_total: tt,
      p_overtime: D.p_ot, p_shootout: D.p_so,
    };
  }

  /* ---------- the full sheet: every supported market, each with its own settlement ---------- */
  const SETTLES = {
    moneyline: 'two-way: includes overtime and the shootout',
    regulation: '60 minutes only; a tie is its own outcome',
    puck_line: 'includes overtime and the shootout; an OT or shootout win is a one-goal win; a whole-number line can push',
    total: 'includes overtime; the shootout winner is credited one goal (the official final); a whole-number line can push',
    regulation_total: '60 minutes only (no overtime, no shootout); a whole-number line can push',
    team_total: 'includes overtime; the shootout winner is credited one goal; a whole-number line can push',
    first_period: 'first period only (20 minutes); a tie is its own outcome on the 3-way; a whole-number total can push',
  };
  function twoWay(win, push, lose) { return { p: win, push, p_other: lose, fair: fairAmericanWithPush(win, push), fair_other: fairAmericanWithPush(lose, push) }; }
  function fullSheet(D, o) {
    o = o || {};
    const out = { settles: SETTLES };
    out.moneyline = { home: D.p_home, away: D.p_away, fair_home: probToAmerican(D.p_home), fair_away: probToAmerican(D.p_away) };
    out.regulation = { home: D.reg.home, draw: D.reg.draw, away: D.reg.away, fair_home: probToAmerican(D.reg.home), fair_draw: probToAmerican(D.reg.draw), fair_away: probToAmerican(D.reg.away) };
    out.puck_line = {};
    for (const L of o.puck_lines || [-3.5, -2.5, -1.5, -1, 1, 1.5, 2.5, 3.5]) { const x = spread(D, L); out.puck_line[L] = Object.assign({ home_line: L }, twoWay(x.win, x.push, x.lose)); }
    out.total = {};
    for (const L of o.total_lines || [4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5]) { const x = total(D, L); out.total[L] = Object.assign({ line: L }, twoWay(x.over, x.push, x.under)); }
    out.total_expected = expectedTotal(D);
    out.regulation_total = {};
    for (const L of o.regulation_total_lines || [4.5, 5, 5.5, 6, 6.5]) { const x = regulationTotal(D, L); out.regulation_total[L] = Object.assign({ line: L }, twoWay(x.over, x.push, x.under)); }
    out.team_total = { home: {}, away: {} };
    for (const side of ['home', 'away']) for (const L of o.team_lines || [1.5, 2, 2.5, 3, 3.5, 4.5]) { const x = teamTotal(D, side, L); out.team_total[side][L] = Object.assign({ line: L }, twoWay(x.over, x.push, x.under)); }
    const fp = firstPeriod(D);
    if (fp) {
      out.first_period = { home: fp.home, draw: fp.draw, away: fp.away, fair_home: probToAmerican(fp.home), fair_draw: probToAmerican(fp.draw), fair_away: probToAmerican(fp.away), expected: fp.expected, total: {} };
      for (const L of Object.keys(fp.totals)) { const x = fp.totals[L]; out.first_period.total[L] = Object.assign({ line: Number(L) }, twoWay(x.over, x.push, x.under)); }
    }
    out.p_overtime = D.p_ot; out.p_shootout = D.p_so;
    return out;
  }

  /**
   * The home share of a fixed expected total that makes P(home wins) = target.
   * Used when a probability from outside the score model (an ensemble) must be
   * turned back into a consistent score distribution: the total is kept, the
   * split is solved, and every other market follows from the same matrix.
   */
  function solveSplit(target, totalLam, o) {
    o = o || {};
    let lo = 0.05, hi = 0.95, D = null;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      D = game(Object.assign({}, o, { lamH: totalLam * mid, lamA: totalLam * (1 - mid) }));
      if (D.p_home < target) lo = mid; else hi = mid;
      if (Math.abs(D.p_home - target) < 1e-6) break;
    }
    return D;
  }

  /** P(regulation score = h-a) — for fitting rho by likelihood */
  function regProb(D, h, a) { const N = MAXG + 1; return D.reg_matrix[Math.min(MAXG, h) * N + Math.min(MAXG, a)]; }

  return { game, regProb, estimateScoreEffects, neutralEffects, spread, total, teamTotal, totalPmf, expectedTotal, fairTotalLine, sheet, fullSheet, solveSplit, regulationTotal, regulationSpread, firstPeriod, paceMixture, gammaP, probToAmerican, fairAmericanWithPush, SETTLES, T_BUCKETS, T_BUCKETS_FINE, MAXG };
});
