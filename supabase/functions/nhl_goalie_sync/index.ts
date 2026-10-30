// @ts-nocheck — plain JavaScript cores inlined in a .ts file, as the NBA injury, circa and billing functions are.
// ============================================================
//  FILE:    supabase/functions/nhl_goalie_sync/index.ts
//  TYPE:    Edge Function — NHL starting goalies (T0) and the versioned
//           NHL game card built on them
//  DEPLOY:  supabase functions deploy nhl_goalie_sync --no-verify-jwt
//           .github/workflows/deploy-nhl-goalie.yml does it, tests first
//  CRON:    supabase/nhl_goalie_cron.sql — pokes every 5 minutes; THIS
//           function decides (nhlgIsDue): every two hours from 8 AM
//           Eastern, every 15 minutes in the final three hours before each
//           puck drop, and a final pass at T-30
//  SQL:     supabase/nhl_goalie_layer.sql
// ============================================================
// WHAT IT DOES, each run that is due:
//   1. reads the slate's goalie inputs (hockey/goalie_inputs.json, published
//      with the site): every upcoming game, the goalie-aware variant without
//      its goalie term, each realistic goalie's rating, the usage projection,
//      the production headline (copied unchanged)
//   2. SOURCES (T0): Daily Faceoff's starting-goalies page for each Eastern
//      date with a game (Confirmed / Likely / Unconfirmed), and the NHL's own
//      game boxscore for games inside three hours of puck drop (the
//      `starter` flag, once lineups post). A manual confirmation in
//      hockey/data/confirmed_starters.json rides in the inputs. The usage
//      projection is the labelled T2 fallback when no source names anyone
//   3. names matched to rated goalies (surname and initial, club first);
//      every changed observation is appended to nhl_goalie_starters (the
//      older one stops being current)
//   4. one consensus per team: the higher status when sources agree; when
//      they name different goalies, both stay on file, the LOWER status is
//      shown (never Confirmed) and the conflict is flagged
//   5. the game card (hockey/goalies/core.js nhlgBuildCard): when either
//      side's starter, status or conflict changes — or the slate's numbers do
//      — a NEW VERSION is appended (the old ones stay, for audit), with the
//      pairing used, both statuses, the generation time, the range over
//      every realistic pairing, the edge gate, the Known Limitations and
//      "Updated: starter changed from X to Y" against the first version
//   6. an edge against a captured price (only when NHL prices flow) is
//      recorded against the card version current at that moment, with the
//      gate's answer: no EDGE flag unless both starters are Confirmed or the
//      edge holds under every realistic pairing
//   7. one run row and its alerts (FAILURE / DEGRADED / DRIFT / WARNING),
//      the readiness KPIs' source (public.nhl_goalie_readiness)
//
// WHAT IT REFUSES. It never shows a goalie as Confirmed that a source did
// not confirm, never matches a name to the nearest one, never touches the
// production price (xg_core carries no goalie term), and never writes a card
// for a game that has started.
//
// AUTH. pg_cron sends the Vault secret nhl_goalie_cron_secret as
// x-cron-secret; it must equal NHL_GOALIE_CRON_SECRET. A GET is a public
// health probe (BUILD only).
//
// POST body (all optional):
//   force            run even when no slot is due
//   dry              read and compute; write nothing; return everything
//   simulate_outage  ["daily_faceoff", "nhl_api", "inputs"]: treat those as
//                    down — the operator's forced-failure test (the run is
//                    recorded with simulated = true)
//   now              ISO time to run as (dry runs and tests)
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), NHL_GOALIE_CRON_SECRET,
//      NHL_GOALIE_INPUTS_URL (default https://edgedesksports.com/hockey/goalie_inputs.json)
// ============================================================

export const BUILD = "nhl_goalie_sync@2026-10-30.2";
const INPUTS_URL = "https://edgedesksports.com/hockey/goalie_inputs.json";
// A browser's headers, as nba_injury_sync sends: a crawler-style agent was
// refused by ESPN's edge on the NBA layer's first live runs.
const UA = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const CARD_HORIZON_H = 30;   // cards for games starting within this many hours (today's and tomorrow's)

// ── BEGIN NHL DIST ─────────────────────────────────────────────────────
// Canonical source: hockey/model/distribution.js, copied whole by tools/hockey/inline_goalie_core.js.
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
// ── END NHL DIST ───────────────────────────────────────────────────────

// ── BEGIN NHL GOALIE CORE ─────────────────────────────────────────────────
const NHLG_CORE_VERSION = 'edgedesk_nhl_goalie_core_v1';
const NHLG_STATUSES = ['unknown', 'projected', 'likely', 'confirmed'];
const NHLG_BADGE = { confirmed: 'Confirmed', likely: 'Likely', projected: 'Projected', unknown: 'Unknown' };
/* rank: which source leads when sources disagree (the league's own lineup first) */
const NHLG_SOURCES = {
  nhl_api_boxscore: { label: 'NHL.com game boxscore', tier: 'T0', rank: 4, observed: true },
  manual: { label: 'Manual entry (hockey/data/confirmed_starters.json)', tier: 'T0', rank: 3, observed: true },
  daily_faceoff: { label: 'Daily Faceoff', tier: 'T0', rank: 2, observed: true },
  edgedesk_projection: { label: 'EdgeDesk usage projection', tier: 'T2', rank: 1, observed: false },
  consensus: { label: 'EdgeDesk merge of the sources above', tier: 'T0', rank: 0, observed: false },
};
const NHLG_DEFAULTS = {
  min_ev: 0.02,              /* the EV an edge needs (lib/edgedesk_nhl_market.js DEFAULTS.min_ev) */
  alt_min_p: 0.15,           /* a projected alternate below this start probability is not a realistic pairing */
  max_per_side: 3,
  puck_lines: [-2.5, -1.5, 1.5, 2.5],
  total_lines: [5, 5.5, 6, 6.5, 7],
  first_et_hour: 8,          /* the two-hour cadence starts at 8 AM Eastern */
  every_hours: 2,
  pre_window_min: 180,       /* the final three hours before each puck drop... */
  pre_step_min: 15,          /* ...every 15 minutes */
  final_pass_min: 30,        /* and a final pass at T-30 */
  lookback_min: 90,          /* a slot missed by more than this is not chased */
  heartbeat_min: 55,         /* a declined poke is recorded at most this often */
  lock_window_min: 30,       /* after the final pass, every lock_step_min until puck drop: lineups post late */
  lock_step_min: 5,          /* pg_cron pokes every 5 minutes, the finest step there is */
  lock_min_skaters: 12,      /* a lineup with fewer listed skaters is not a lineup yet (hockey/model/lineups.js) */
};
const NHLG_TEAMS = [
  ['ANA', 'Anaheim Ducks', 'Anaheim', 'Ducks'], ['BOS', 'Boston Bruins', 'Boston', 'Bruins'], ['BUF', 'Buffalo Sabres', 'Buffalo', 'Sabres'],
  ['CAR', 'Carolina Hurricanes', 'Carolina', 'Hurricanes'], ['CBJ', 'Columbus Blue Jackets', 'Columbus', 'Blue Jackets'], ['CGY', 'Calgary Flames', 'Calgary', 'Flames'],
  ['CHI', 'Chicago Blackhawks', 'Chicago', 'Blackhawks'], ['COL', 'Colorado Avalanche', 'Colorado', 'Avalanche'], ['DAL', 'Dallas Stars', 'Dallas', 'Stars'],
  ['DET', 'Detroit Red Wings', 'Detroit', 'Red Wings'], ['EDM', 'Edmonton Oilers', 'Edmonton', 'Oilers'], ['FLA', 'Florida Panthers', 'Florida', 'Panthers'],
  ['LAK', 'Los Angeles Kings', 'Los Angeles', 'Kings', 'LA Kings', 'LA'], ['MIN', 'Minnesota Wild', 'Minnesota', 'Wild'],
  ['MTL', 'Montréal Canadiens', 'Montreal Canadiens', 'Montréal', 'Montreal', 'Canadiens'], ['NJD', 'New Jersey Devils', 'New Jersey', 'Devils', 'NJ'],
  ['NSH', 'Nashville Predators', 'Nashville', 'Predators'], ['NYI', 'New York Islanders', 'NY Islanders', 'Islanders'], ['NYR', 'New York Rangers', 'NY Rangers', 'Rangers'],
  ['OTT', 'Ottawa Senators', 'Ottawa', 'Senators'], ['PHI', 'Philadelphia Flyers', 'Philadelphia', 'Flyers'], ['PIT', 'Pittsburgh Penguins', 'Pittsburgh', 'Penguins'],
  ['SEA', 'Seattle Kraken', 'Seattle', 'Kraken'], ['SJS', 'San Jose Sharks', 'San Jose', 'Sharks', 'SJ'], ['STL', 'St. Louis Blues', 'St Louis Blues', 'St. Louis', 'St Louis', 'Blues'],
  ['TBL', 'Tampa Bay Lightning', 'Tampa Bay', 'Lightning', 'TB'], ['TOR', 'Toronto Maple Leafs', 'Toronto', 'Maple Leafs'],
  ['UTA', 'Utah Mammoth', 'Utah Hockey Club', 'Utah HC', 'Utah', 'Mammoth'], ['VAN', 'Vancouver Canucks', 'Vancouver', 'Canucks'],
  ['VGK', 'Vegas Golden Knights', 'Vegas', 'Golden Knights'], ['WPG', 'Winnipeg Jets', 'Winnipeg', 'Jets'], ['WSH', 'Washington Capitals', 'Washington', 'Capitals', 'WAS'],
];

function nhlgR(v, k) { if (v == null || !isFinite(v)) return null; const f = Math.pow(10, k == null ? 4 : k); return Math.round(v * f) / f; }
function nhlgIso(v) { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return isFinite(t) ? new Date(t).toISOString() : null; }
function nhlgStatusRank(s) { const i = NHLG_STATUSES.indexOf(s); return i < 0 ? 0 : i; }
function nhlgMinStatus(a, b) { return nhlgStatusRank(a) <= nhlgStatusRank(b) ? a : b; }
function nhlgSourceRank(s) { return (NHLG_SOURCES[s] && NHLG_SOURCES[s].rank) || 0; }
function nhlgSourceLabel(s) { return (NHLG_SOURCES[s] && NHLG_SOURCES[s].label) || String(s || 'no source'); }

/** a source's wording → one of the four statuses (unknown when it says nothing usable) */
function nhlgStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return 'unknown';
  if (/^confirm/.test(s) || s === 'starter' || s === 'starting') return 'confirmed';
  if (/^(likely|expected|probable)/.test(s)) return 'likely';
  if (/^(unconfirmed|projected|projection|tbd|tentative|possible|unknown starter)/.test(s)) return 'projected';
  return 'unknown';
}

function nhlgKey(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
let NHLG_TEAM_INDEX = null;
/** an abbreviation, a full name, a city, a nickname or a URL slug → the slate's abbreviation */
function nhlgTeam(x) {
  if (x == null || x === '') return null;
  if (!NHLG_TEAM_INDEX) {
    NHLG_TEAM_INDEX = {};
    for (const row of NHLG_TEAMS) for (const n of row) NHLG_TEAM_INDEX[nhlgKey(n)] = row[0];
  }
  const raw = String(x).trim();
  if (/^[A-Z]{2,3}$/.test(raw) && NHLG_TEAMS.some((r) => r[0] === raw)) return raw;
  return NHLG_TEAM_INDEX[nhlgKey(raw)] || null;
}

/** "Kevin Lankinen", "K. Lankinen", "Lankinen, Kevin" → { first, last } (accents and case folded) */
function nhlgNameParts(s) {
  let raw = String(s == null ? '' : s).trim();
  if (!raw) return null;
  if (raw.indexOf(',') > 0) { const [a, b] = raw.split(','); raw = (b || '').trim() + ' ' + a.trim(); }
  const toks = nhlgKey(raw).split(' ').filter((t) => t && !/^(jr|sr|ii|iii|iv)$/.test(t));
  if (!toks.length) return null;
  if (toks.length === 1) return { first: '', last: toks[0] };
  return { first: toks[0], last: toks[toks.length - 1] };
}
/**
 * One reported name → a goalie id from the inputs' rated pool. Exact on the
 * surname and the first initial, first within the club (the goalies who have
 * played for it), then league-wide when exactly one goalie fits (a trade or
 * a call-up the club's history does not show yet). Anything else is
 * unmatched or ambiguous: kept, never guessed.
 */
function nhlgMatchGoalie(name, team, inputs) {
  const p = nhlgNameParts(name);
  if (!p) return { goalie_id: null, method: 'unmatched' };
  const pool = (inputs && inputs.goalies) || {};
  const fits = [];
  for (const id of Object.keys(pool)) {
    const g = pool[id], q = nhlgNameParts(g.name);
    if (!q || q.last !== p.last) continue;
    if (p.first && q.first && p.first[0] !== q.first[0]) continue;
    fits.push({ id, g, full: !!(p.first && q.first && p.first === q.first) });
  }
  const inTeam = fits.filter((x) => (x.g.teams || []).indexOf(team) >= 0);
  const pick = (list, scope) => {
    if (list.length === 1) return { goalie_id: list[0].id, method: scope + (list[0].full ? '_exact' : '_initial'), rated_name: list[0].g.name };
    const full = list.filter((x) => x.full);
    if (full.length === 1) return { goalie_id: full[0].id, method: scope + '_exact', rated_name: full[0].g.name };
    return null;
  };
  if (inTeam.length) return pick(inTeam, 'team') || { goalie_id: null, method: 'ambiguous' };
  if (fits.length) return pick(fits, 'league') || { goalie_id: null, method: 'ambiguous' };
  return { goalie_id: null, method: 'unmatched' };
}

/* ---------------------------------------------------------------- the sources */
function nhlgDailyFaceoffUrl(etDate) { return 'https://www.dailyfaceoff.com/starting-goalies/' + etDate; }
function nhlgBoxscoreUrl(gameId) { return 'https://api-web.nhle.com/v1/gamecenter/' + gameId + '/boxscore'; }

function nhlgWalk(x, fn, depth) {
  if (depth > 12 || x == null || typeof x !== 'object') return;
  if (Array.isArray(x)) { for (const y of x) nhlgWalk(y, fn, depth + 1); return; }
  fn(x);
  for (const k of Object.keys(x)) nhlgWalk(x[k], fn, depth + 1);
}
function nhlgFirst(o, keys) { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; }
/**
 * Daily Faceoff's starting-goalies page. The page is a Next.js render whose
 * __NEXT_DATA__ script carries every game as an object with
 * home/awayGoalieName, home/awayNewsStrengthName (Confirmed, Likely,
 * Unconfirmed), the team names and the news times. A page with no such
 * object is a DRIFT (the layout changed), never an empty slate.
 */
function nhlgParseDailyFaceoff(html, ctx) {
  ctx = ctx || {};
  const out = { ok: false, source: 'daily_faceoff', url: ctx.url || null, fetched_at: nhlgIso(ctx.fetched_at), rows: [], games: 0, unread: [], drift: null };
  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ''));
  if (!m) { out.drift = 'the page has no __NEXT_DATA__ block'; return out; }
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { out.drift = 'the __NEXT_DATA__ block is not JSON'; return out; }
  const games = [];
  nhlgWalk(j, (o) => { if (!Array.isArray(o) && ('homeGoalieName' in o || 'awayGoalieName' in o)) games.push(o); }, 0);
  if (!games.length) { out.drift = 'no game object with homeGoalieName / awayGoalieName'; return out; }
  out.ok = true; out.games = games.length;
  for (const o of games) {
    const home = nhlgTeam(nhlgFirst(o, ['homeTeamAbbreviation', 'homeTeamAbbr', 'homeTeamName', 'homeTeamSlug', 'homeTeam']));
    const away = nhlgTeam(nhlgFirst(o, ['awayTeamAbbreviation', 'awayTeamAbbr', 'awayTeamName', 'awayTeamSlug', 'awayTeam']));
    const start = nhlgIso(nhlgFirst(o, ['dateGmt', 'dateUtc', 'startTimeUTC', 'gameTimeUtc']));
    const date = nhlgFirst(o, ['date', 'gameDate']);
    if (!home || !away) { out.unread.push({ why: 'teams did not read', home: nhlgFirst(o, ['homeTeamName', 'homeTeamSlug']), away: nhlgFirst(o, ['awayTeamName', 'awayTeamSlug']) }); continue; }
    for (const side of ['home', 'away']) {
      const nm = o[side + 'GoalieName'] != null ? String(o[side + 'GoalieName']).trim() : '';
      const raw = nhlgFirst(o, [side + 'NewsStrengthName', side + 'StrengthName', side + 'GoalieStatus', side + 'Status']);
      out.rows.push({
        side, team: side === 'home' ? home : away, home, away, game_date: date ? String(date).slice(0, 10) : null, start_utc: start,
        goalie_name: nm || null, source_status: raw == null ? null : String(raw), status: nm ? nhlgStatus(raw) : 'unknown',
        source_updated_at: nhlgIso(nhlgFirst(o, [side + 'NewsUpdatedAt', side + 'NewsCreatedAt', 'updatedAt', 'modifiedAt'])),
        details: o[side + 'NewsDetails'] ? String(o[side + 'NewsDetails']).slice(0, 280) : null,
      });
    }
  }
  return out;
}
/**
 * The NHL's game boxscore (api-web.nhle.com/v1/gamecenter/{id}/boxscore).
 * playerByGameStats appears once lineups post; a goalie flagged
 * `starter: true` is the confirmed starter. Before that the boxscore says
 * nothing about starters, which is not a failure.
 */
function nhlgParseNhlBoxscore(json, ctx) {
  ctx = ctx || {};
  const out = { ok: false, source: 'nhl_api_boxscore', url: ctx.url || null, fetched_at: nhlgIso(ctx.fetched_at), game_id: null, state: null, rows: [], drift: null };
  if (!json || typeof json !== 'object' || json.id == null || !json.homeTeam || !json.awayTeam) { out.drift = 'not a boxscore (no id, homeTeam, awayTeam)'; return out; }
  out.ok = true; out.game_id = String(json.id); out.state = json.gameState || null;
  const pb = json.playerByGameStats || null;
  /* the dressed skaters (forwards and defence, never the goalies), once lineups post: null until then */
  out.lineups = { home: null, away: null };
  for (const side of ['home', 'away']) {
    const t = pb && pb[side + 'Team'];
    if (!t) continue;
    const ids = [].concat(Array.isArray(t.forwards) ? t.forwards : [], Array.isArray(t.defense) ? t.defense : []).map((x) => (x && x.playerId != null ? String(x.playerId) : null)).filter(Boolean);
    out.lineups[side] = ids.filter((id, i) => ids.indexOf(id) === i);
  }
  for (const side of ['home', 'away']) {
    const team = nhlgTeam(json[side + 'Team'].abbrev);
    const gs = pb && pb[side + 'Team'] && Array.isArray(pb[side + 'Team'].goalies) ? pb[side + 'Team'].goalies : [];
    const st = gs.filter((g) => g && g.starter === true);
    if (st.length !== 1) continue;
    const g = st[0], nm = g.name && typeof g.name === 'object' ? g.name.default : g.name;
    out.rows.push({ side, team, goalie_id: g.playerId != null ? String(g.playerId) : null, goalie_name: nm ? String(nm) : null, status: 'confirmed', source_status: 'starter', source_updated_at: null });
  }
  return out;
}

/* ---------------------------------------------------------------- the merge */
function nhlgIdentity(o) { return o && o.goalie_id ? 'id:' + o.goalie_id : o && o.goalie_name ? 'nm:' + nhlgKey(o.goalie_name) : null; }
function nhlgSummary(o) { return { source: o.source, goalie_id: o.goalie_id || null, goalie_name: o.goalie_name || null, status: o.status, source_updated_at: o.source_updated_at || null, fetched_at: o.fetched_at || null, row_id: o.id != null ? o.id : (o.row_id != null ? o.row_id : null) }; }
/**
 * One team's starter from every source's current observation.
 *   obs   [{ source, goalie_id, goalie_name, status, source_updated_at, fetched_at, id }]
 *   proj  the usage projection's likeliest goalie { goalie_id, goalie_name, p }, or null
 * Sources that name the same goalie: the highest status wins. Sources that
 * name different goalies: the lead source's goalie (NHL > manual > Daily
 * Faceoff), the LOWER of their statuses, capped at Likely (two sources naming
 * different starters is never a confirmation), conflict = true.
 */
function nhlgMergeSide(obs, proj) {
  const named = (obs || []).filter((o) => o && NHLG_SOURCES[o.source] && NHLG_SOURCES[o.source].observed && o.goalie_name && o.status && o.status !== 'unknown');
  if (!named.length) {
    if (proj && (proj.goalie_id || proj.goalie_name)) {
      return { goalie_id: proj.goalie_id ? String(proj.goalie_id) : null, goalie_name: proj.goalie_name || null, status: 'projected', source: 'edgedesk_projection', source_updated_at: nhlgIso(proj.as_of), as_of: nhlgIso(proj.as_of),
        p_start: proj.p != null ? nhlgR(proj.p) : null, conflict: false, conflict_detail: null, sources: [], basis: 'projection' };
    }
    return { goalie_id: null, goalie_name: null, status: 'unknown', source: null, source_updated_at: null, as_of: null, conflict: false, conflict_detail: null, sources: [], basis: 'none' };
  }
  const ids = {};
  for (const o of named) ids[nhlgIdentity(o)] = true;
  const byLead = named.slice().sort((a, b) => nhlgSourceRank(b.source) - nhlgSourceRank(a.source) || nhlgStatusRank(b.status) - nhlgStatusRank(a.status));
  if (Object.keys(ids).length === 1) {
    const best = named.slice().sort((a, b) => nhlgStatusRank(b.status) - nhlgStatusRank(a.status) || nhlgSourceRank(b.source) - nhlgSourceRank(a.source))[0];
    const withId = named.filter((o) => o.goalie_id)[0];
    return { goalie_id: best.goalie_id || (withId ? withId.goalie_id : null), goalie_name: best.goalie_name, status: best.status, source: best.source, source_updated_at: best.source_updated_at || null,
      as_of: nhlgIso(best.source_updated_at || best.fetched_at), conflict: false, conflict_detail: null, sources: named.map(nhlgSummary), basis: named.length > 1 ? 'sources_agree' : 'one_source' };
  }
  const lead = byLead[0];
  let st = named.map((o) => o.status).reduce(nhlgMinStatus);
  if (st === 'confirmed') st = 'likely';
  const alt = [];
  const seen = {}; seen[nhlgIdentity(lead)] = true;
  for (const o of byLead) { const k = nhlgIdentity(o); if (!seen[k]) { seen[k] = true; alt.push({ goalie_id: o.goalie_id || null, goalie_name: o.goalie_name, source: o.source, status: o.status }); } }
  return { goalie_id: lead.goalie_id || null, goalie_name: lead.goalie_name, status: st, source: lead.source, source_updated_at: lead.source_updated_at || null,
    as_of: nhlgIso(lead.source_updated_at || lead.fetched_at), conflict: true, conflict_detail: byLead.map(nhlgSummary), alternates: alt, sources: named.map(nhlgSummary), basis: 'sources_disagree' };
}

/**
 * The card names a matched goalie as EdgeDesk's goalie registry does
 * (hockey/data/goalies.json: "L. Meriläinen"), so a projection and a report
 * read alike; the source's own spelling is kept as reported_name.
 */
function nhlgDisplay(m, inputs) {
  const out = Object.assign({}, m);
  const g = m && m.goalie_id && inputs && inputs.goalies ? inputs.goalies[String(m.goalie_id)] : null;
  if (g && g.name) { if (m.goalie_name && m.goalie_name !== g.name) out.reported_name = m.goalie_name; out.goalie_name = g.name; }
  const named = (a) => { const x = a && a.goalie_id && inputs && inputs.goalies ? inputs.goalies[String(a.goalie_id)] : null; return x && x.name ? Object.assign({}, a, { goalie_name: x.name, reported_name: a.goalie_name }) : a; };
  if (Array.isArray(m && m.alternates)) out.alternates = m.alternates.map(named);
  if (Array.isArray(m && m.conflict_detail)) out.conflict_detail = m.conflict_detail.map(named);
  return out;
}

/* ---------------------------------------------------------------- pricing a pairing */
/**
 * A goalie's rating: the game's own (the slate's goalieRating at the game
 * date, for each club's recent starters and its projection), else the
 * league-wide pool's (a starter the club's history does not show), else the
 * replacement-level prior, flagged unrated.
 */
function nhlgRate(inputs, id, gi) {
  if (id != null && gi && gi.rates && gi.rates[String(id)] != null && isFinite(gi.rates[String(id)])) {
    const p = inputs.goalies && inputs.goalies[String(id)];
    return { rate: gi.rates[String(id)], rated: true, name: p ? p.name : null };
  }
  const g = id != null && inputs.goalies ? inputs.goalies[String(id)] : null;
  return g && isFinite(g.rate) ? { rate: g.rate, rated: true, name: g.name } : { rate: inputs.goalie_prior_rate, rated: false, name: null };
}
/** hockey/model/glm.js applyPairCalibration, verbatim in behaviour (tools/hockey/nhl_goalie_core.test.js holds the parity) */
function nhlgCalibrate(lh, la, cal) {
  if (!cal || (cal.a === 1 && cal.b === 1) || !cal.c) return { lh, la };
  const T = cal.c * Math.pow((lh + la) / cal.c, cal.a);
  const pi0 = lh / (lh + la); const z = cal.b * Math.log(pi0 / (1 - pi0)); const pi = 1 / (1 + Math.exp(-z));
  return { lh: T * pi, la: T * (1 - pi) };
}
/** the goalie-aware variant's expected regulation goals: each club scores against the OTHER club's goalie */
function nhlgLambdas(gi, model, rateHomeGoalie, rateAwayGoalie) {
  const lh = Math.exp(gi.eta.home + model.goalie_beta * rateAwayGoalie);
  const la = Math.exp(gi.eta.away + model.goalie_beta * rateHomeGoalie);
  return nhlgCalibrate(lh, la, model.pair_calibration);
}
/** every market the card and the edge gate read, from one distribution */
function nhlgMarkets(D, DIST, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const pl = {}, tot = {};
  for (const L of o.puck_lines) { const x = DIST.spread(D, L); pl[L] = [nhlgR(x.win), nhlgR(x.push)]; }
  for (const L of o.total_lines) { const x = DIST.total(D, L); tot[L] = [nhlgR(x.over), nhlgR(x.push)]; }
  return { p_home: nhlgR(D.p_home), fair_home: DIST.probToAmerican(D.p_home), fair_away: DIST.probToAmerican(D.p_away), exp_total: nhlgR(DIST.expectedTotal(D), 2), fair_total_line: DIST.fairTotalLine(D).line, puck_line: pl, total: tot };
}
function nhlgPrice(gi, inputs, homeGoalie, awayGoalie, DIST, o) {
  const rh = nhlgRate(inputs, homeGoalie, gi), ra = nhlgRate(inputs, awayGoalie, gi);
  const lam = nhlgLambdas(gi, inputs.model, rh.rate, ra.rate);
  const D = DIST.game({ lamH: lam.lh, lamA: lam.la, effects: inputs.distribution.effects, ot: gi.type === 'P' ? { format: 'PO' } : inputs.distribution.ot, periods: false });
  return Object.assign(nhlgMarkets(D, DIST, o), { lambda: { home: nhlgR(lam.lh), away: nhlgR(lam.la) }, rated: { home: rh.rated, away: ra.rated } });
}

/* ---------------------------------------------------------------- the lineup-lock price */
/** ln(tonight's lineup value / the club's typical): each skater's recent time on ice per game, summed (hockey/model/lineups.js) */
function nhlgLineupDelta(ids, inputs, typical, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  if (!Array.isArray(ids) || ids.length < o.lock_min_skaters || !(typical > 0)) return null;
  const vals = (inputs && inputs.skater_values) || {}, prior = inputs && inputs.skater_prior_s != null ? inputs.skater_prior_s : 600;
  let v = 0; for (const id of ids) v += vals[String(id)] != null ? vals[String(id)] : prior;
  return Math.log(v / typical);
}
/**
 * The headline at lineup lock: both dressed lineups listed (lineups:
 * { home: [skater ids], away: [...] }) and both starters Confirmed, priced by
 * the variant that knows tonight's lineups and goalies (inputs.model.all_*).
 * null when any of it is missing: the headline then stays the slate's.
 */
function nhlgLockPrice(gi, inputs, merged, lineups, DIST, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const M = inputs && inputs.model, L = gi && gi.lineup;
  if (!M || !M.all_beta || !M.all_pair_calibration || !L || !L.eta || !L.typical || !lineups || !nhlgBothConfirmed(merged)) return null;
  const dH = nhlgLineupDelta(lineups.home, inputs, L.typical.home, o), dA = nhlgLineupDelta(lineups.away, inputs, L.typical.away, o);
  if (dH == null || dA == null) return null;
  const rh = nhlgRate(inputs, merged.home.goalie_id, gi), ra = nhlgRate(inputs, merged.away.goalie_id, gi);
  const B = M.all_beta;
  const lam = nhlgCalibrate(Math.exp(L.eta.home + B.goalie * ra.rate + B.lu_own * dH + B.lu_opp * dA), Math.exp(L.eta.away + B.goalie * rh.rate + B.lu_own * dA + B.lu_opp * dH), M.all_pair_calibration);
  const D = DIST.game({ lamH: lam.lh, lamA: lam.la, effects: inputs.distribution.effects, ot: gi.type === 'P' ? { format: 'PO' } : inputs.distribution.ot, periods: false });
  const mk = nhlgMarkets(D, DIST, o), pl = mk.puck_line;
  const awayMinus = pl['1.5'] ? Math.max(0, 1 - pl['1.5'][0] - pl['1.5'][1]) : null;
  const before = gi.headline || {};
  return {
    basis: 'lineup_lock', model_id: M.all_model_id || null, p_home: mk.p_home, p_away: nhlgR(1 - D.p_home), fair_home: mk.fair_home, fair_away: mk.fair_away,
    exp_total: mk.exp_total, fair_total_line: mk.fair_total_line, p_overtime: nhlgR(D.p_ot), p_shootout: nhlgR(D.p_so),
    puck_line: { home_minus_1_5: pl['-1.5'] ? pl['-1.5'][0] : null, away_minus_1_5: nhlgR(awayMinus), fair_home_minus_1_5: pl['-1.5'] ? DIST.probToAmerican(pl['-1.5'][0]) : null, fair_away_minus_1_5: awayMinus != null ? DIST.probToAmerican(awayMinus) : null },
    markets: { puck_line: pl, total: mk.total }, settles: before.settles || null, goalie_free: false, lambda: { home: nhlgR(lam.lh), away: nhlgR(lam.la) },
    lineup: { ids: { home: lineups.home.map(String), away: lineups.away.map(String) }, skaters: { home: lineups.home.length, away: lineups.away.length }, delta: { home: nhlgR(dH), away: nhlgR(dA) }, goalies: { home: merged.home.goalie_id || null, away: merged.away.goalie_id || null }, rated: { home: rh.rated, away: ra.rated } },
    before: { model_id: before.model_id || null, p_home: before.p_home != null ? before.p_home : null, fair_home: before.fair_home != null ? before.fair_home : null, fair_away: before.fair_away != null ? before.fair_away : null },
  };
}

/**
 * The dressed lineups a card was locked with. The card is the only place they
 * are kept, so a run whose boxscore read failed, or listed no lineup, prices
 * from these and the lock holds; a new listing replaces them.
 */
function nhlgLockedLineups(card) {
  const L = card && card.headline && card.headline.basis === 'lineup_lock' ? card.headline.lineup : null;
  return L && L.ids && Array.isArray(L.ids.home) && Array.isArray(L.ids.away) ? { home: L.ids.home.slice(), away: L.ids.away.slice() } : null;
}

/* ---------------------------------------------------------------- realistic pairings */
/**
 * The goalies who could realistically start for one side: the confirmed
 * starter alone; otherwise the current pick, any goalie another source names,
 * and the usage projection's alternates with at least alt_min_p.
 */
function nhlgCandidates(merged, proj, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const out = [], seen = {};
  const add = (g, why) => {
    if (!g || (!g.goalie_id && !g.goalie_name)) return;
    const k = nhlgIdentity(g);
    if (seen[k] || out.length >= o.max_per_side) return;
    seen[k] = true; out.push({ goalie_id: g.goalie_id ? String(g.goalie_id) : null, goalie_name: g.goalie_name || null, why });
  };
  if (merged && merged.status === 'confirmed' && !merged.conflict && merged.goalie_name) { add(merged, 'confirmed'); return out; }
  if (merged) add(merged, merged.basis === 'projection' ? 'projected' : 'reported');
  for (const a of (merged && merged.alternates) || []) add(a, 'named by ' + nhlgSourceLabel(a.source));
  for (const p of (proj || []).slice().sort((a, b) => b.p - a.p)) if (p.p >= o.alt_min_p) add(p, 'usage projection ' + Math.round(p.p * 100) + '%');
  if (!out.length) out.push({ goalie_id: null, goalie_name: null, why: 'no starter known: the replacement-level prior' });
  return out;
}
function nhlgPairings(gi, inputs, merged, DIST, o) {
  const cH = nhlgCandidates(merged.home, (gi.projection && gi.projection.home) || [], o);
  const cA = nhlgCandidates(merged.away, (gi.projection && gi.projection.away) || [], o);
  const pickH = nhlgIdentity(merged.home), pickA = nhlgIdentity(merged.away);
  const out = [];
  for (const h of cH) for (const a of cA) {
    const pr = nhlgPrice(gi, inputs, h.goalie_id, a.goalie_id, DIST, o);
    out.push(Object.assign({ home_goalie_id: h.goalie_id, home_goalie_name: h.goalie_name, away_goalie_id: a.goalie_id, away_goalie_name: a.goalie_name,
      used: nhlgIdentity(h) === pickH && nhlgIdentity(a) === pickA }, pr));
  }
  if (!out.some((p) => p.used) && out.length) out[0].used = true;
  return out;
}

/* ---------------------------------------------------------------- the card */
function nhlgBothConfirmed(merged) { return !!(merged && merged.home && merged.away && merged.home.status === 'confirmed' && merged.away.status === 'confirmed' && !merged.home.conflict && !merged.away.conflict); }
function nhlgShortName(n) { return n == null ? null : String(n); }
function nhlgSidePick(m, rated) {
  return { goalie_id: m.goalie_id || null, goalie_name: m.goalie_name || null, status: m.status, badge: NHLG_BADGE[m.status] || 'Unknown', source: m.source || null, source_label: m.source ? nhlgSourceLabel(m.source) : null,
    source_updated_at: m.source_updated_at || null, as_of: m.as_of || null, reported_name: m.reported_name || null, conflict: !!m.conflict, conflict_detail: m.conflict_detail || null, basis: m.basis || null, p_start: m.p_start != null ? m.p_start : null,
    rated: rated == null ? null : !!rated, starter_row_id: m.row_id != null ? m.row_id : null };
}
function nhlgLimitations(gi, merged, used) {
  const out = [];
  if (!nhlgBothConfirmed(merged)) out.push('Starter not confirmed. Numbers may change.');
  for (const side of ['home', 'away']) {
    const m = merged[side], team = gi[side];
    if (m.conflict) out.push('Sources disagree on the ' + team + ' starter (' + (m.conflict_detail || []).map((c) => (c.goalie_name || '?') + ' per ' + nhlgSourceLabel(c.source)).join(', ') + '): shown as ' + (NHLG_BADGE[m.status] || m.status) + ', not as fact.');
    if (m.basis === 'projection') out.push('No source has posted a ' + team + ' starter yet: ' + (m.goalie_name || 'the likeliest goalie') + ' is EdgeDesk’s usage projection' + (m.p_start != null ? ' (' + Math.round(m.p_start * 100) + '% to start)' : '') + '.');
    if (m.basis === 'none') out.push('No source names a ' + team + ' starter and EdgeDesk has no usage history for the club: the pairing uses the replacement-level prior.');
    if (used && used.rated && used.rated[side] === false && m.goalie_name) out.push(m.goalie_name + ' (' + team + ') has no EdgeDesk goalie rating: the pairing prices him at the replacement-level prior.');
  }
  return out;
}
/**
 * The change note against the FIRST version posted: which starter changed,
 * from whom to whom, and both versions' win probability for the home club
 * under the pairing each used (the goalie-aware variant).
 */
function nhlgChangeNote(first, card) {
  if (!first || !card) return null;
  const sides = [];
  for (const side of ['home', 'away']) {
    const a = first.goalie_pairing_used && first.goalie_pairing_used[side], b = card.goalie_pairing_used && card.goalie_pairing_used[side];
    if (!a || !b || !a.goalie_name || !b.goalie_name) continue;
    if (nhlgIdentity(a) !== nhlgIdentity(b)) sides.push({ side, team: card[side], from: a.goalie_name, to: b.goalie_name });
  }
  if (!sides.length) return null;
  const fp = first.pairing_price && first.pairing_price.p_home, cp = card.pairing_price && card.pairing_price.p_home;
  return {
    text: 'Updated: starter changed from ' + sides.map((s) => s.from).join(' and ') + ' to ' + sides.map((s) => s.to).join(' and '),
    sides, first_version: first.version != null ? first.version : 1, first_card_id: first.id != null ? first.id : null, first_generated_at: first.generated_at || null,
    first_p_home: fp == null ? null : fp, current_p_home: cp == null ? null : cp, basis: 'the home club’s win probability under the pairing each version used (goalie-aware variant)',
  };
}
function nhlgStable(x) {
  if (x == null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(nhlgStable);
  const o = {}; for (const k of Object.keys(x).sort()) o[k] = nhlgStable(x[k]); return o;
}
/** FNV-1a over the stable JSON: a content hash that is the same in Node, Deno and the browser */
function nhlgHash(x) {
  const s = JSON.stringify(nhlgStable(x)); let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}
/**
 * One game's card. gi: the game from hockey/goalie_inputs.json; merged:
 * { home, away } from nhlgMergeSide; first: the first version posted (for
 * the change note), or null.
 */
function nhlgBuildCard(gi, inputs, merged, DIST, o) {
  o = o || {};
  const pairs = nhlgPairings(gi, inputs, merged, DIST, o);
  const used = pairs.filter((p) => p.used)[0] || null;
  const both = nhlgBothConfirmed(merged);
  const ps = pairs.map((p) => p.p_home).filter((v) => v != null), ts = pairs.map((p) => p.exp_total).filter((v) => v != null);
  const lock = nhlgLockPrice(gi, inputs, merged, o.lineups || null, DIST, o);
  const card = {
    core_version: NHLG_CORE_VERSION, game_id: String(gi.game_id), start_utc: gi.start_utc, home: gi.home, away: gi.away, type: gi.type || 'R',
    generated_at: nhlgIso(o.now != null ? o.now : Date.now()),
    goalie_pairing_used: { home: nhlgSidePick(merged.home, used ? used.rated.home : null), away: nhlgSidePick(merged.away, used ? used.rated.away : null) },
    goalie_status: { home: merged.home.status, away: merged.away.status },
    conflict: !!(merged.home.conflict || merged.away.conflict),
    headline: lock || gi.headline || null,
    lineup_locked: !!lock,
    pairing_price: used ? { home_goalie_id: used.home_goalie_id, home_goalie_name: used.home_goalie_name, away_goalie_id: used.away_goalie_id, away_goalie_name: used.away_goalie_name,
      p_home: used.p_home, fair_home: used.fair_home, fair_away: used.fair_away, exp_total: used.exp_total, fair_total_line: used.fair_total_line, puck_line: used.puck_line, total: used.total, lambda: used.lambda } : null,
    pairing_range: pairs,
    range: { p_home: ps.length ? [Math.min.apply(null, ps), Math.max.apply(null, ps)] : null, exp_total: ts.length ? [Math.min.apply(null, ts), Math.max.apply(null, ts)] : null, pairings: pairs.length },
    show_range: !both,
    edge_gate: both
      ? { state: 'OPEN', basis: 'BOTH_CONFIRMED', rule: 'both starters are Confirmed: an edge is judged as before (lib/edgedesk_nhl_market.js)' }
      : { state: 'GATED', basis: 'EVERY_PAIRING', rule: 'a starter is not Confirmed: no EDGE on the moneyline, puck line or total unless it holds under every realistic pairing (' + pairs.length + ')' },
    known_limitations: nhlgLimitations(gi, merged, used),
    notes: lock
      ? ['Priced at lineup lock: both dressed lineups are listed by the NHL and both starters are Confirmed, so the headline numbers come from the variant that knows tonight’s lineups and goalies (' + (lock.model_id || 'xg_all_confirmed') + '). '
        + 'Before lock the headline was the production model (' + (lock.before.model_id || 'edgedesk_nhl_v1') + ', ' + gi.home + ' ' + (lock.before.p_home != null ? Math.round(lock.before.p_home * 1000) / 10 + '%' : '—') + '). '
        + 'The pairing numbers come from the goalie-aware variant (' + ((inputs.model && inputs.model.goalie_variant) || 'xg_goalie_confirmed') + ').']
      : ['The headline numbers are the production model (' + ((inputs.model && inputs.model.id) || 'edgedesk_nhl_v1') + '), which carries no goalie term: a starter change does not move them until lineup lock. '
        + 'The pairing numbers come from its goalie-aware variant (' + ((inputs.model && inputs.model.goalie_variant) || 'xg_goalie_confirmed') + '), the one the slate’s goalie scenarios use.'],
    model_id: (inputs.model && inputs.model.id) || null, goalie_variant: (inputs.model && inputs.model.goalie_variant) || null,
    slate_generated_at: inputs.slate_generated_at || inputs.generated_at || null,
  };
  card.change_note = nhlgChangeNote(o.first || null, card);
  card.inputs_hash = nhlgHash({ g: gi, m: inputs.model, d: inputs.distribution, r: pairs.map((p) => [p.home_goalie_id, p.away_goalie_id]).map((k) => k.concat([nhlgRate(inputs, k[0], gi).rate, nhlgRate(inputs, k[1], gi).rate])) });
  return card;
}

/**
 * Does `next` need a new card version over `prev`? A new version when a
 * starter changes, a status changes, a conflict opens or closes, or the
 * numbers changed with a new slate. Same goalie, same status, same numbers:
 * no new version (the run still records that it checked).
 */
function nhlgCardChange(prev, next) {
  if (!prev) return { changed: true, trigger: 'initial', reasons: ['initial'] };
  const reasons = [];
  const pu = prev.goalie_pairing_used || {}, nu = next.goalie_pairing_used || {};
  for (const side of ['home', 'away']) {
    const a = pu[side] || {}, b = nu[side] || {};
    if (nhlgIdentity(a) !== nhlgIdentity(b)) reasons.push('starter_changed:' + side);
    else if ((a.status || null) !== (b.status || null)) reasons.push('status_changed:' + side);
    if (!!a.conflict !== !!b.conflict) reasons.push('conflict_changed:' + side);
  }
  const locked = (c) => !!(c && c.headline && c.headline.basis === 'lineup_lock');
  if (locked(prev) !== locked(next)) reasons.push(locked(next) ? 'lineup_locked' : 'lineup_unlocked');
  const num = (c) => JSON.stringify([c.headline && c.headline.p_home, c.headline && c.headline.exp_total, c.pairing_price && c.pairing_price.p_home, c.pairing_price && c.pairing_price.exp_total,
    (c.pairing_range || []).map((p) => [p.home_goalie_id, p.away_goalie_id, p.p_home, p.exp_total])]);
  if (!reasons.some((r) => !/^lineup_/.test(r)) && num(prev) !== num(next)) reasons.push('inputs_changed');
  /* a lock moves the headline's numbers: it is recorded as its own reason under the inputs_changed trigger (the table's five triggers) */
  const order = ['starter_changed', 'status_changed', 'conflict_changed', 'inputs_changed'];
  const trigger = reasons.length ? order.filter((t) => reasons.some((r) => r.indexOf(t) === 0 || (t === 'inputs_changed' && /^lineup_/.test(r))))[0] : null;
  return { changed: reasons.length > 0, trigger, reasons };
}

/* ---------------------------------------------------------------- the edge gate */
function nhlgDec(american) { const a = Number(american); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
function nhlgEv(p, push, american) { const d = nhlgDec(american); if (p == null || d == null) return null; const lose = Math.max(0, 1 - p - (push || 0)); return p * (d - 1) - lose; }
/** the probability one side of one market wins (and pushes) under one priced pairing */
function nhlgSideProb(pr, market, side, line) {
  if (!pr) return null;
  if (market === 'moneyline') return pr.p_home == null ? null : { p: side === 'home' ? pr.p_home : 1 - pr.p_home, push: 0 };
  if (market === 'puck_line') {
    const homeLine = side === 'home' ? Number(line) : -Number(line);
    const x = pr.puck_line && pr.puck_line[String(homeLine)];
    if (!x) return null;
    return side === 'home' ? { p: x[0], push: x[1] } : { p: Math.max(0, 1 - x[0] - x[1]), push: x[1] };
  }
  if (market === 'total') {
    const x = pr.total && pr.total[String(Number(line))];
    if (!x) return null;
    return side === 'over' ? { p: x[0], push: x[1] } : { p: Math.max(0, 1 - x[0] - x[1]), push: x[1] };
  }
  return null;
}
/**
 * May an edge on this price be flagged? q: { market: 'moneyline' | 'puck_line'
 * | 'total', side: 'home' | 'away' | 'over' | 'under', line (puck line: the
 * side's own line; total: the total), american, min_ev }.
 *   both starters Confirmed  -> OPEN: the edge is judged as it always was
 *   otherwise                -> allowed only if EV >= min_ev under EVERY
 *                               realistic pairing; a line some pairing has no
 *                               price for cannot pass
 */
function nhlgEdgeGate(card, q) {
  const minEv = q && q.min_ev != null ? q.min_ev : NHLG_DEFAULTS.min_ev;
  const rows = ((card && card.pairing_range) || []).map((pr) => { const x = nhlgSideProb(pr, q.market, q.side, q.line); return x ? nhlgEv(x.p, x.push, q.american) : null; });
  const priced = rows.length > 0 && rows.every((v) => v != null);
  const evMin = priced ? Math.min.apply(null, rows) : null;
  const usedX = nhlgSideProb(card && card.pairing_price, q.market, q.side, q.line);
  const evUsed = usedX ? nhlgEv(usedX.p, usedX.push, q.american) : null;
  const base = { ev_by_pairing: rows.map((v) => nhlgR(v)), ev_min: nhlgR(evMin), ev_pairing_used: nhlgR(evUsed), min_ev: minEv };
  if (card && card.edge_gate && card.edge_gate.state === 'OPEN') return Object.assign(base, { flag_allowed: true, basis: 'BOTH_CONFIRMED', reason: 'both starters are Confirmed' });
  if (!priced) return Object.assign(base, { flag_allowed: false, basis: 'GATED', reason: 'a starter is not Confirmed and this line is not priced under every realistic pairing' });
  if (evMin >= minEv) return Object.assign(base, { flag_allowed: true, basis: 'HOLDS_EVERY_PAIRING', reason: 'the edge holds under all ' + rows.length + ' realistic pairings (worst EV ' + (evMin * 100).toFixed(1) + '%)' });
  return Object.assign(base, { flag_allowed: false, basis: 'GATED', reason: 'a starter is not Confirmed and the edge does not hold under every realistic pairing (worst EV ' + (evMin * 100).toFixed(1) + '%, needs ' + (minEv * 100).toFixed(1) + '%)' });
}

/* ---------------------------------------------------------------- cadence (US Eastern) */
let NHLG_ETF = null;
function nhlgEtParts(t) {
  if (!NHLG_ETF) NHLG_ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of NHLG_ETF.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, date: p.year + '-' + p.month + '-' + p.day };
}
function nhlgEtDate(t) { return nhlgEtParts(t).date; }
/** the UTC instant of an Eastern wall-clock time on an Eastern date */
function nhlgEtToUtc(date, hour, minute) {
  const [y, m, d] = String(date).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute || 0);
  let t = wall + 5 * 3600e3;
  for (let i = 0; i < 3; i++) { const p = nhlgEtParts(t); const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi); t += wall - seen; }
  return t;
}
/**
 * Every instant the sync is due for these games. games: [{ game_id, start_utc }].
 *   two_hour     8:00, 10:00, ... Eastern on each Eastern date with a game, until its last puck drop
 *   pre_game     every 15 minutes in the three hours before each puck drop
 *   final_pass   T-30 for each game
 *   lineup_lock  every 5 minutes after the final pass until puck drop (T-25 ... T-5)
 */
function nhlgDueTimes(games, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const out = [], lastByDate = {};
  for (const g of games || []) {
    const s = Date.parse(g.start_utc); if (!isFinite(s)) continue;
    const d = nhlgEtDate(s); if (!(d in lastByDate) || s > lastByDate[d]) lastByDate[d] = s;
    for (let k = o.pre_window_min; k > 0; k -= o.pre_step_min) out.push({ at: s - k * 60e3, kind: k === o.final_pass_min ? 'final_pass' : 'pre_game', game_id: String(g.game_id) });
    if (o.pre_window_min % o.pre_step_min !== 0 || o.final_pass_min % o.pre_step_min !== 0) out.push({ at: s - o.final_pass_min * 60e3, kind: 'final_pass', game_id: String(g.game_id) });
    for (let k = Math.min(o.lock_window_min, o.final_pass_min) - o.lock_step_min; k > 0; k -= o.lock_step_min) out.push({ at: s - k * 60e3, kind: 'lineup_lock', game_id: String(g.game_id) });
  }
  for (const d of Object.keys(lastByDate)) {
    for (let h = o.first_et_hour; h < 24; h += o.every_hours) { const t = nhlgEtToUtc(d, h, 0); if (t >= lastByDate[d]) break; out.push({ at: t, kind: 'two_hour', game_id: null }); }
  }
  return out.sort((a, b) => a.at - b.at || (a.kind < b.kind ? -1 : 1));
}
/**
 * Is a run due now? last: the last EXECUTED run's start time (ISO or ms), or
 * null. A slot older than lookback_min is not chased (the next one runs).
 * Returns { due, kinds, final_pass_games, next_due_at }.
 */
function nhlgIsDue(now, last, games, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const lt = last == null ? null : (typeof last === 'number' ? last : Date.parse(last));
  const all = nhlgDueTimes(games, o);
  const hit = all.filter((x) => x.at <= now && x.at > now - o.lookback_min * 60e3 && (lt == null || !isFinite(lt) || x.at > lt));
  const next = all.filter((x) => x.at > now)[0] || null;
  const kinds = []; for (const x of hit) if (kinds.indexOf(x.kind) < 0) kinds.push(x.kind);
  return { due: hit.length > 0, kinds, final_pass_games: hit.filter((x) => x.kind === 'final_pass').map((x) => x.game_id), next_due_at: next ? new Date(next.at).toISOString() : null };
}
// ── END NHL GOALIE CORE ───────────────────────────────────────────────────

const DIST = (globalThis as any).EDNHLDist;
// deno-lint-ignore no-explicit-any
type Any = any;
const env = (k: string): string => ((globalThis as Any).Deno?.env.get(k) ?? "");
function deadline(ms: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(ms); } catch { return undefined; } }
const same = (a: Any, b: Any) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));
const sameTime = (a: Any, b: Any) => (a == null && b == null) || (a != null && b != null && Date.parse(a) === Date.parse(b));
const inList = (ids: string[]) => "in.(" + ids.map((x) => '"' + String(x).replace(/"/g, "") + '"').join(",") + ")";

/* ---------------------------------------------------------------- the database (PostgREST, service role) */
// A read that times out or loses its connection is sent once more: on 2026-10-30 at 12:10 UTC one slow
// answer ("Signal timed out.") failed a whole run, and readiness stayed in error until the next slot.
// A write is never sent twice: it may have landed, and every table here is append-only.
const transient = (e: Any) => !!e && (e.name === "TimeoutError" || e.name === "AbortError" || e instanceof TypeError);
async function db(path: string, init?: RequestInit): Promise<Any> {
  const read = !init || !init.method || init.method === "GET";
  try { return await dbOnce(path, init); } catch (e) { if (!read || !transient(e)) throw e; }
  return await dbOnce(path, init);
}
async function dbOnce(path: string, init?: RequestInit): Promise<Any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init, signal: deadline(20000),
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...((init?.headers as Any) ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
const insert = (table: string, rows: Any, ret = false) =>
  db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: ret ? "return=representation" : "return=minimal" } });

async function getResp(url: string, ms = 20000) {
  return await fetch(url, { headers: UA, redirect: "follow", signal: deadline(ms) });
}

/* ---------------------------------------------------------------- the sources */
/** Daily Faceoff's page for one Eastern date: parsed rows, or why not */
export async function readDailyFaceoff(etDate: string, nowMs: number) {
  const url = nhlgDailyFaceoffUrl(etDate);
  try {
    const r = await getResp(url, 20000);
    if (!r.ok) return { ok: false, url, error: "Daily Faceoff answered HTTP " + r.status, http: r.status };
    const p = nhlgParseDailyFaceoff(await r.text(), { url, fetched_at: nowMs });
    if (!p.ok) return { ok: false, url, error: "Daily Faceoff's page did not read: " + p.drift, drift: true, parsed: p };
    return { ok: true, url, parsed: p };
  } catch (e) { return { ok: false, url, error: "Daily Faceoff: " + String((e as Error)?.message ?? e).slice(0, 160) }; }
}
/** the NHL's boxscore for one game: starters once lineups post, or why not */
export async function readBoxscore(gameId: string, nowMs: number) {
  const url = nhlgBoxscoreUrl(gameId);
  try {
    const r = await getResp(url, 15000);
    if (!r.ok) return { ok: false, url, error: "the NHL API answered HTTP " + r.status + " for " + gameId, http: r.status };
    const p = nhlgParseNhlBoxscore(await r.json(), { url, fetched_at: nowMs });
    if (!p.ok) return { ok: false, url, error: "the NHL boxscore for " + gameId + " did not read: " + p.drift, drift: true };
    return { ok: true, url, parsed: p };
  } catch (e) { return { ok: false, url, error: "the NHL API: " + String((e as Error)?.message ?? e).slice(0, 160) }; }
}

/* ---------------------------------------------------------------- a failed check is tried again
   A source refusing one read (Daily Faceoff answered HTTP 403 to the deploy's forced run at 16:34 UTC on 2026-10-30)
   left readiness in error until the next slot, 86 minutes later, with nothing asked in between. After an error run the
   sync runs again 10 minutes later, then 20, then every 40 while it keeps failing, besides the schedule's own slots.
   Nothing about what a run writes or how readiness judges it changes. */
const RETRY_AFTER_ERROR_MIN = [10, 20, 40];
/** the error runs in a row at the head of recent (the latest executed runs, newest first) */
function errorStreak(recent: Any[]) { let n = 0; for (const r of recent || []) { if (r.status !== "error") break; n++; } return n; }
/** when the latest executed run failed, the instant it is tried again; otherwise null */
function retryAfterError(recent: Any[]) {
  const n = errorStreak(recent);
  if (!n) return null;
  const last = Date.parse(recent[0].started_at);
  return isFinite(last) ? last + RETRY_AFTER_ERROR_MIN[Math.min(n, RETRY_AFTER_ERROR_MIN.length) - 1] * 60000 : null;
}

/* ---------------------------------------------------------------- one run */
export async function syncOnce(opts: Any = {}) {
  const t0 = Date.now();
  const nowMs = opts.now ? Date.parse(opts.now) : t0;
  const nowIso = new Date(nowMs).toISOString();
  const dry = !!opts.dry, sim: string[] = Array.isArray(opts.simulate_outage) ? opts.simulate_outage.map(String) : [];
  const run: Any = { run_id: crypto.randomUUID(), build: BUILD, trigger: opts.trigger || "manual", status: "ok", started_at: nowIso, simulated: sim.length > 0,
    due_kinds: [], final_pass_games: [], observations_written: 0, consensus_written: 0, conflicts_open: 0, unmatched: 0, cards_written: 0, cards_unchanged: 0, edge_events_written: 0, sources: {}, details: {} };
  const alerts: Any[] = [];
  const alert = (severity: string, code: string, message: string, detail?: Any) => alerts.push({ severity, code, message, detail: detail ?? null });
  const out: Any = { build: BUILD, core: NHLG_CORE_VERSION, run_id: run.run_id, now: nowIso, dry };
  let record = true;
  let recent: Any[] = [];
  try {
    recent = (await db("nhl_goalie_sync_runs?select=started_at,finished_at,status&status=neq.skipped&order=started_at.desc&limit=" + RETRY_AFTER_ERROR_MIN.length)) || [];
    const lastExec = recent[0] || null;
    const lastAny = (await db("nhl_goalie_sync_runs?select=finished_at&order=finished_at.desc&limit=1"))[0] || null;
    const quietFor = lastAny ? nowMs - Date.parse(lastAny.finished_at) : Infinity;

    /* 1. the inputs */
    let inputs: Any = null, inErr = "";
    if (sim.includes("inputs")) inErr = "simulated outage: inputs";
    else {
      try {
        const r = await getResp(env("NHL_GOALIE_INPUTS_URL") || INPUTS_URL, 20000);
        if (!r.ok) inErr = "hockey/goalie_inputs.json answered HTTP " + r.status;
        else { inputs = await r.json(); if (!inputs || inputs.schema !== "edgedesk_nhl_goalie_inputs_v1") { inErr = "hockey/goalie_inputs.json is not edgedesk_nhl_goalie_inputs_v1"; inputs = null; } }
      } catch (e) { inErr = "hockey/goalie_inputs.json: " + String((e as Error)?.message ?? e).slice(0, 160); }
    }
    if (!inputs) {
      // without the inputs the schedule is unknown: an error run, at most every 15 minutes (or when forced)
      if (!opts.force && quietFor < 15 * 60000) { record = false; out.status = "not_recorded"; out.reason = inErr; return out; }
      run.status = "error"; run.message = "the slate's goalie inputs could not be read: " + inErr;
      alert("FAILURE", "inputs_unavailable", run.message);
      return out;
    }
    run.inputs_generated_at = inputs.generated_at || null;
    const upcoming = (inputs.games || []).filter((g: Any) => Date.parse(g.start_utc) > nowMs);

    /* 2. due? */
    const due = nhlgIsDue(nowMs, lastExec ? lastExec.started_at : null, upcoming);
    const retryAt = retryAfterError(recent);
    const retry = !due.due && retryAt != null && nowMs >= retryAt;
    run.next_due_at = due.next_due_at;
    out.due = due;
    if (retry) { due.due = true; due.kinds = ["retry_after_error"]; }
    if (!due.due && !opts.force) {
      if (quietFor >= NHLG_DEFAULTS.heartbeat_min * 60000) { run.status = "skipped"; run.skipped_reason = "no slot due" + (due.next_due_at ? "; next " + due.next_due_at : ": no game in the inputs"); }
      else record = false;
      out.status = run.status; out.skipped = run.skipped_reason || "not due (heartbeat not needed)";
      return out;
    }
    run.due_kinds = opts.force ? ["forced"].concat(due.kinds) : due.kinds;
    run.final_pass_games = due.final_pass_games;
    const games = upcoming.filter((g: Any) => Date.parse(g.start_utc) - nowMs <= CARD_HORIZON_H * 3600e3);
    run.games_considered = games.length;
    if (!games.length) { out.games = 0; return out; }
    const byKey = new Map<string, Any>(games.map((g: Any) => [String(g.game_id), g]));

    /* 3. the sources */
    const obs: Any[] = [];
    const dates = [...new Set(games.map((g: Any) => nhlgEtDate(Date.parse(g.start_utc))))].sort();
    const df: Any = { ok: null, pages: [], rows: 0, unmatched_games: [] };
    for (const d of dates) {
      const res = sim.includes("daily_faceoff") ? { ok: false, url: nhlgDailyFaceoffUrl(d), error: "simulated outage: daily_faceoff" } : await readDailyFaceoff(d, nowMs);
      df.pages.push({ date: d, ok: res.ok, url: res.url, error: res.ok ? null : res.error, games: res.ok ? res.parsed.games : 0 });
      if (!res.ok) { df.ok = false; if ((res as Any).drift) alert("DRIFT", "daily_faceoff_drift", res.error, { url: res.url }); continue; }
      if (df.ok === null) df.ok = true;
      for (const r of res.parsed.rows) {
        const g = games.find((x: Any) => x.home === r.home && x.away === r.away && (r.start_utc ? Math.abs(Date.parse(x.start_utc) - Date.parse(r.start_utc)) < 18 * 3600e3 : nhlgEtDate(Date.parse(x.start_utc)) === (r.game_date || d)));
        if (!g) { if (!df.unmatched_games.includes(r.away + "@" + r.home)) df.unmatched_games.push(r.away + "@" + r.home); continue; }
        const m = r.goalie_name ? nhlgMatchGoalie(r.goalie_name, r.team, inputs) : { goalie_id: null, method: "none" };
        if (r.goalie_name && !m.goalie_id) run.unmatched++;
        obs.push({ game: g, team: r.team, side: r.side, source: "daily_faceoff", goalie_id: m.goalie_id, goalie_name: r.goalie_name, status: r.status, source_status: r.source_status, source_url: res.url,
          source_updated_at: r.source_updated_at, fetched_at: nowIso, match_method: m.method });
        df.rows++;
      }
    }
    if (df.ok === false) alert("DEGRADED", "daily_faceoff_unavailable", "Daily Faceoff could not be read: " + df.pages.filter((p: Any) => !p.ok).map((p: Any) => p.date + " (" + p.error + ")").join("; "));
    if (df.unmatched_games.length) alert("WARNING", "daily_faceoff_game_unmatched", "Daily Faceoff listed games the slate does not hold: " + df.unmatched_games.join(", "));
    /* the timing probe: per boxscore read, how long before puck drop and whether the dressed lineups were listed yet */
    const nhl: Any = { ok: null, calls: 0, failures: [], starters: 0, lineups_posted: 0, games: [] };
    const lineupsBy = new Map<string, Any>();
    for (const g of games) {
      const t = Date.parse(g.start_utc);
      if (!(t - nowMs <= NHLG_DEFAULTS.pre_window_min * 60000 || g.state === "PRE")) continue;
      nhl.calls++;
      const res = sim.includes("nhl_api") ? { ok: false, error: "simulated outage: nhl_api" } : await readBoxscore(String(g.game_id), nowMs);
      if (!res.ok) { nhl.failures.push(String(g.game_id) + ": " + res.error); nhl.ok = false; if ((res as Any).drift) alert("DRIFT", "nhl_boxscore_drift", res.error); continue; }
      if (nhl.ok === null) nhl.ok = true;
      const lu = res.parsed.lineups || { home: null, away: null };
      const nS = (side: string) => (Array.isArray(lu[side]) ? lu[side].length : 0);
      const posted = nS("home") >= NHLG_DEFAULTS.lock_min_skaters && nS("away") >= NHLG_DEFAULTS.lock_min_skaters;
      if (posted) { nhl.lineups_posted++; lineupsBy.set(String(g.game_id), lu); }
      nhl.games.push({ game_id: String(g.game_id), minutes_to_start: Math.round((t - nowMs) / 60000), state: res.parsed.state, skaters: { home: nS("home"), away: nS("away") }, starters: res.parsed.rows.length, lineups_posted: posted });
      for (const r of res.parsed.rows) {
        if (r.team !== g.home && r.team !== g.away) continue;
        obs.push({ game: g, team: r.team, side: r.team === g.home ? "home" : "away", source: "nhl_api_boxscore", goalie_id: r.goalie_id, goalie_name: r.goalie_name, status: "confirmed", source_status: r.source_status,
          source_url: res.url, source_updated_at: null, fetched_at: nowIso, match_method: "id" });
        nhl.starters++;
      }
    }
    if (nhl.ok === false) alert("DEGRADED", "nhl_api_unavailable", "The NHL boxscore could not be read for " + nhl.failures.length + " game(s): " + nhl.failures.slice(0, 3).join("; "));
    run.daily_faceoff_ok = df.ok; run.nhl_api_ok = nhl.ok;
    run.sources = { daily_faceoff: df, nhl_api_boxscore: nhl };
    if (df.ok === false && nhl.ok !== true) {
      run.status = "error"; run.message = "no starter source could be read (Daily Faceoff" + (nhl.calls ? " and the NHL API" : "") + "): the starters on file are kept, nothing is written in their place";
      alert("FAILURE", "sources_down", run.message);
    }
    for (const g of games) {
      // the manual file (hockey/data/confirmed_starters.json, carried in the inputs) and the usage projection
      for (const side of ["home", "away"]) {
        const team = g[side];
        const c = g.confirmed && g.confirmed[side];
        if (c && c.goalie_id) obs.push({ game: g, team, side, source: "manual", goalie_id: String(c.goalie_id), goalie_name: c.goalie_name || (inputs.goalies[String(c.goalie_id)] || {}).name || null, status: "confirmed",
          source_status: g.confirmed.source || "manual", source_url: g.confirmed.url || null, source_updated_at: g.confirmed.recorded_at || null, fetched_at: nowIso, match_method: "id" });
        const p = ((g.projection && g.projection[side]) || [])[0];
        obs.push(p ? { game: g, team, side, source: "edgedesk_projection", goalie_id: String(p.goalie_id), goalie_name: p.goalie_name, status: "projected", source_status: "usage projection " + Math.round(p.p * 100) + "%",
          source_url: null, source_updated_at: inputs.generated_at, fetched_at: nowIso, match_method: "projection" }
          : { game: g, team, side, source: "edgedesk_projection", goalie_id: null, goalie_name: null, status: "unknown", source_status: "no usage history", source_url: null, source_updated_at: inputs.generated_at, fetched_at: nowIso, match_method: "none" });
      }
    }
    if (run.unmatched) alert("WARNING", "unmatched_names", run.unmatched + " reported goalie name(s) did not match a rated goalie: kept as reported, priced at the replacement-level prior if they start");

    /* 4. what is on file, and what changed */
    const ids = [...byKey.keys()];
    const cur: Any[] = (await db("nhl_goalie_starters?select=*&is_current=is.true&game_id=" + inList(ids))) || [];
    const curBy = new Map<string, Any>(cur.map((r: Any) => [r.game_id + "|" + r.team + "|" + r.source, r]));
    const toRow = (o: Any) => ({ game_id: String(o.game.game_id), game_start_utc: o.game.start_utc, team: o.team, side: o.side, goalie_id: o.goalie_id || null, goalie_name: o.goalie_name || null, status: o.status,
      source: o.source, source_status: o.source_status || null, source_url: o.source_url || null, source_updated_at: o.source_updated_at || null, fetched_at: o.fetched_at, match_method: o.match_method || null, run_id: run.run_id });
    // a changed goalie, status or source time is a new observation; the projection's time is the slate's
    // build time, so for it only the goalie, the status and the start probability count
    const changedObs = obs.filter((o) => {
      const c = curBy.get(o.game.game_id + "|" + o.team + "|" + o.source);
      return !c || !same(c.goalie_id, o.goalie_id) || !same(c.goalie_name, o.goalie_name) || c.status !== o.status
        || (o.source === "edgedesk_projection" ? c.source_status !== o.source_status : !sameTime(c.source_updated_at, o.source_updated_at));
    });
    const rows = changedObs.map(toRow);
    if (rows.length) {
      const wrote = dry ? rows.map((r: Any, i: number) => Object.assign({ id: "dry-" + i, is_current: true }, r)) : await insert("nhl_goalie_starters", rows, true);
      for (const w of wrote) curBy.set(w.game_id + "|" + w.team + "|" + w.source, w);
      run.observations_written = rows.length;
    }

    /* 5. the consensus per team */
    const merged: Any = {};
    const consRows: Any[] = [];
    for (const g of games) {
      merged[g.game_id] = {};
      for (const side of ["home", "away"]) {
        const team = g[side], k = (s: string) => curBy.get(g.game_id + "|" + team + "|" + s);
        const list = ["nhl_api_boxscore", "manual", "daily_faceoff"].map(k).filter(Boolean);
        const pj = k("edgedesk_projection");
        const p0 = ((g.projection && g.projection[side]) || [])[0];
        const m = nhlgDisplay(nhlgMergeSide(list, pj && pj.goalie_name ? { goalie_id: pj.goalie_id, goalie_name: pj.goalie_name, p: p0 ? p0.p : null, as_of: pj.source_updated_at } : null), inputs);
        const prev = k("consensus");
        const leadRows = (m.sources || []).map((x: Any) => x.row_id).filter((x: Any) => x != null);
        const row = { game_id: String(g.game_id), game_start_utc: g.start_utc, team, side, goalie_id: m.goalie_id || null, goalie_name: m.goalie_name || null, status: m.status, source: "consensus",
          source_status: m.source || null, source_url: null, source_updated_at: m.as_of || null, fetched_at: nowIso, conflict: !!m.conflict,
          conflict_detail: m.conflict ? m.conflict_detail : null, match_method: m.basis === "projection" ? "projection" : m.basis === "none" ? "none" : (m.goalie_id ? "id" : "unmatched"),
          merged_from: { basis: m.basis, rows: leadRows.length ? leadRows : (pj ? [pj.id] : []), lead: m.source || null, alternates: m.alternates || [] }, run_id: run.run_id };
        const moved = !prev || !same(prev.goalie_id, row.goalie_id) || !same(prev.goalie_name, row.goalie_name) || prev.status !== row.status || !!prev.conflict !== row.conflict || prev.source_status !== row.source_status;
        merged[g.game_id][side] = Object.assign({}, m, { row_id: prev && !moved ? prev.id : null });
        if (moved) consRows.push({ row, g, side });
        if (m.conflict) run.conflicts_open++;
      }
    }
    if (consRows.length) {
      const wrote = dry ? consRows.map((c: Any, i: number) => Object.assign({ id: "dry-c" + i }, c.row)) : await insert("nhl_goalie_starters", consRows.map((c) => c.row), true);
      wrote.forEach((w: Any, i: number) => { merged[consRows[i].g.game_id][consRows[i].side].row_id = w.id; });
      run.consensus_written = consRows.length;
      const newConf = consRows.filter((c) => c.row.conflict);
      if (newConf.length) alert("WARNING", "source_conflict", newConf.map((c) => c.row.team + " (" + c.g.away + "@" + c.g.home + "): " + (c.row.conflict_detail || []).map((x: Any) => (x.goalie_name || "?") + " per " + nhlgSourceLabel(x.source) + " (" + x.status + ")").join(" vs ")).join("; "),
        { games: newConf.map((c) => c.row.game_id) });
    }

    /* 6. the cards: a new version only when something on it changed */
    const curCards: Any[] = (await db("nhl_game_cards_current?select=*&game_id=" + inList(ids))) || [];
    const firstCards: Any[] = (await db("nhl_game_cards?select=id,game_id,version,generated_at,goalie_pairing_used,pairing_price&version=eq.1&game_id=" + inList(ids))) || [];
    const cardBy = new Map<string, Any>(curCards.map((c: Any) => [String(c.game_id), c]));
    const firstBy = new Map<string, Any>(firstCards.map((c: Any) => [String(c.game_id), c]));
    const shown: Any[] = [], current = new Map<string, Any>();
    for (const g of games) {
      const prev = cardBy.get(String(g.game_id)) || null, first = firstBy.get(String(g.game_id)) || null;
      /* this run's listed lineups, else the ones the current card locked with (a failed read never unlocks it) */
      const card = nhlgBuildCard(g, inputs, merged[g.game_id], DIST, { now: nowMs, first, lineups: lineupsBy.get(String(g.game_id)) || nhlgLockedLineups(prev) });
      const ch = nhlgCardChange(prev, card);
      if (!ch.changed) { run.cards_unchanged++; current.set(String(g.game_id), prev); continue; }
      const P = card.goalie_pairing_used;
      const row: Any = { game_id: card.game_id, version: prev ? prev.version + 1 : 1, game_start_utc: card.start_utc, home: card.home, away: card.away, generated_at: card.generated_at,
        trigger: ch.trigger, reasons: ch.reasons, supersedes_id: prev ? prev.id : null, goalie_pairing_used: P, goalie_status_home: P.home.status, goalie_status_away: P.away.status,
        home_goalie_id: P.home.goalie_id, home_goalie_name: P.home.goalie_name, away_goalie_id: P.away.goalie_id, away_goalie_name: P.away.goalie_name,
        home_starter_row_id: typeof P.home.starter_row_id === "number" ? P.home.starter_row_id : null, away_starter_row_id: typeof P.away.starter_row_id === "number" ? P.away.starter_row_id : null,
        conflict: card.conflict, headline: card.headline, pairing_price: card.pairing_price, pairing_range: card.pairing_range, range: card.range, show_range: card.show_range,
        edge_gate: card.edge_gate, edge_gate_state: card.edge_gate.state, known_limitations: card.known_limitations, notes: card.notes, change_note: card.change_note,
        model_id: card.model_id, goalie_variant: card.goalie_variant, slate_generated_at: card.slate_generated_at, inputs_hash: card.inputs_hash, core_version: card.core_version, run_id: run.run_id };
      const wrote = dry ? [Object.assign({ id: "dry-card-" + g.game_id }, row)] : await insert("nhl_game_cards", [row], true);
      current.set(String(g.game_id), wrote[0]);
      run.cards_written++;
      shown.push({ game_id: row.game_id, matchup: g.away + "@" + g.home, version: row.version, trigger: row.trigger, reasons: row.reasons, pairing: [P.home.goalie_name, P.away.goalie_name],
        status: [P.home.status, P.away.status], gate: row.edge_gate_state, p_home_pairing: card.pairing_price ? card.pairing_price.p_home : null, change: card.change_note ? card.change_note.text : null,
        lineup_locked: !!card.lineup_locked, p_home_headline: card.headline ? card.headline.p_home : null });
    }
    out.cards = { written: run.cards_written, unchanged: run.cards_unchanged, versions: dry ? shown : shown.slice(0, 30) };
    if (dry) out.preview = games.map((g: Any) => { const c = current.get(String(g.game_id)); return c ? { game_id: c.game_id, version: c.version, goalie_pairing_used: c.goalie_pairing_used, edge_gate_state: c.edge_gate_state, known_limitations: c.known_limitations, change_note: c.change_note } : null; });

    /* 7. edges against a captured price, on the version current now */
    const quoted = games.filter((g: Any) => g.quote && g.quote.ml_best && current.get(String(g.game_id)));
    if (quoted.length) {
      const cardIds = quoted.map((g: Any) => current.get(String(g.game_id)).id).filter((x: Any) => typeof x === "number");
      const have: Any[] = cardIds.length && !dry ? ((await db("nhl_card_edge_events?select=card_id,market,side,line,american,quote_captured_at&card_id=in.(" + cardIds.join(",") + ")")) || []) : [];
      const seen = new Set(have.map((e: Any) => [e.card_id, e.market, e.side, e.line == null ? "" : Number(e.line), e.american, e.quote_captured_at ? Date.parse(e.quote_captured_at) : ""].join("|")));
      const events: Any[] = [];
      for (const g of quoted) {
        const c = current.get(String(g.game_id)), q = g.quote, H = c.headline || {};
        if (q.captured_at && Date.parse(q.captured_at) > nowMs) continue;
        for (const side of ["home", "away"]) {
          const b = q.ml_best[side]; if (!b || b.american == null) continue;
          const p = side === "home" ? H.p_home : H.p_away;
          const ev = nhlgEv(p, 0, b.american);
          if (ev == null || ev < NHLG_DEFAULTS.min_ev) continue;
          const gate = nhlgEdgeGate(c, { market: "moneyline", side, american: b.american, min_ev: NHLG_DEFAULTS.min_ev });
          const key = [c.id, "moneyline", side, "", Number(b.american), q.captured_at ? Date.parse(q.captured_at) : ""].join("|");
          if (seen.has(key)) continue;
          events.push({ card_id: c.id, game_id: c.game_id, market: "moneyline", side, line: null, american: Number(b.american), book: b.book || null, quote_source: "captured", quote_captured_at: q.captured_at || null,
            p_win: p, p_push: 0, ev: nhlgR(ev), min_ev: NHLG_DEFAULTS.min_ev, ev_min_pairings: gate.ev_min, ev_pairing_used: gate.ev_pairing_used, flag_allowed: gate.flag_allowed, gate_basis: gate.basis,
            gate_reason: gate.reason, detected_at: nowIso, run_id: run.run_id });
        }
      }
      if (events.length && !dry) await insert("nhl_card_edge_events", events);
      run.edge_events_written = events.length;
      out.edges = events.map((e) => ({ game_id: e.game_id, side: e.side, american: e.american, ev: e.ev, flag_allowed: e.flag_allowed, gate: e.gate_basis, card_id: e.card_id }));
    }
    if (run.status === "ok" && alerts.some((a) => a.severity !== "WARNING" || a.code === "unmatched_names" || a.code === "source_conflict")) run.status = "warn";
  } catch (e) {
    run.status = "error"; run.message = "sync error: " + String((e as Error)?.message ?? e).slice(0, 300);
    alert("FAILURE", "sync_error", run.message);
  } finally {
    run.finished_at = new Date(nowMs + Math.max(0, Date.now() - t0)).toISOString();  // the run's own clock (a test or a dry run passes `now`)
    if (run.status === "error") { const at = Date.parse(run.started_at) + RETRY_AFTER_ERROR_MIN[Math.min(errorStreak(recent) + 1, RETRY_AFTER_ERROR_MIN.length) - 1] * 60000;
      if (!run.next_due_at || at < Date.parse(run.next_due_at)) run.next_due_at = new Date(at).toISOString(); }
    if (run.status !== "skipped" && !run.message) run.message = alerts.filter((a) => a.severity !== "WARNING").map((a) => a.message).join("; ").slice(0, 600) || null;
    run.details = { alerts: alerts.map((a) => a.code), simulate_outage: sim.length ? sim : undefined };
    out.status = out.status || run.status; out.alerts = alerts; out.ok = run.status !== "error"; out.run = { status: run.status, due_kinds: run.due_kinds, final_pass_games: run.final_pass_games, next_due_at: run.next_due_at,
      observations_written: run.observations_written, consensus_written: run.consensus_written, conflicts_open: run.conflicts_open, cards_written: run.cards_written, cards_unchanged: run.cards_unchanged, edge_events_written: run.edge_events_written };
    if (!dry && record) {
      try {
        await insert("nhl_goalie_sync_runs", [run]);
        if (alerts.length) await insert("nhl_goalie_alerts", alerts.map((a) => Object.assign({ run_id: run.run_id }, a)));
      } catch (e) { out.ok = false; out.record_error = String((e as Error)?.message ?? e).slice(0, 300); }
    }
    console.log("NHL_GOALIE_SYNC", JSON.stringify({ run_id: run.run_id, status: run.status, recorded: record && !dry, skipped: run.skipped_reason || null, due: run.due_kinds, cards: { written: run.cards_written, unchanged: run.cards_unchanged }, alerts: alerts.map((a) => a.severity + ":" + a.code) }));
  }
  return out;
}

/* ---------------------------------------------------------------- the handler */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, core: NHLG_CORE_VERSION });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("NHL_GOALIE_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "NHL_GOALIE_CRON_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));
  const out = await syncOnce({ force: !!body.force, dry: !!body.dry, simulate_outage: body.simulate_outage, now: body.now, trigger: body.source === "supabase_cron" ? "cron" : "manual" });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof (globalThis as Any).Deno !== "undefined" && (globalThis as Any).Deno.serve) (globalThis as Any).Deno.serve(handle);
