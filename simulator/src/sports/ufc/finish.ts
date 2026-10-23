/* ===========================================================================
   HOW A UFC FIGHT ENDS: finish or decision, and the round of a finish —
   measured from the history the served Elo is run on
   (model_loop/data/ufc/bouts.csv: ESPN's round, clock and scheduled rounds
   for every final since 2014).

   Definitions (the data carry no method, so KO/TKO and submission are NOT
   separated anywhere):
     decision   the bout went the distance: it ended in the last scheduled
                round at 5:00
     finish     anything else with a winner (KO/TKO, submission, a
                doctor's or corner stoppage, a disqualification)
   Bouts with no winner (draws, no contests) are counted apart (the rate is
   reported; the simulation conditions on a winner, as the served Elo does).
   Bouts listed with 4 scheduled rounds (tournament finals with a possible
   extra round) and bouts outside the eleven divisions (catchweights, the
   defunct women's featherweight) are left out of the division rates.

   THE MODEL (each piece measured):
   1. base(d, R): the finish rate of a bout in division d scheduled for R
      rounds = logistic(logit(rate_R) + logit(rate_d) - logit(rate_all)):
      the format's rate moved by the division's (heavier divisions finish
      more), so a thin cell (a women's five-rounder) borrows from both.
   2. Given that A beats B: logit P(finish) = logit base + dev_win(A) +
      dev_loss(B), where dev_win is how much more often than expected A's
      wins were finishes and dev_loss how much more often B's losses were,
      each SHRUNK toward 0 by m pseudo-bouts at the expected rate:
          dev = logit((k + m e) / (n + m)) - logit(e),  e = mean base of those bouts.
      m is chosen point in time (each bout predicted from earlier bouts only)
      on 2016-2022 by log loss and reported on 2023 onward (holdout), beside
      the base rate alone and a constant.
   3. The round of a finish: P(round k | finish, R, d), the division's own
      distribution shrunk toward the format's with c pseudo-finishes, c chosen
      the same way (c = infinity, the format's distribution alone, is a
      candidate: the data decide whether the division adds anything).
      Independent of who wins (stated).
   =========================================================================== */
import type { Bout } from './elo.ts';
import { FINAL } from './elo.ts';

export const DIVISIONS = ['Flyweight', 'Bantamweight', 'Featherweight', 'Lightweight', 'Welterweight', 'Middleweight', 'Light Heavyweight', 'Heavyweight',
  'W Strawweight', 'W Flyweight', 'W Bantamweight'];
const logit = (p: number) => Math.log(p / (1 - p));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface Ending { winner: 'a' | 'b'; finish: boolean; round: number; R: number }
/** a final's ending, or null (no winner, or not a 3- or 5-round bout, or an unreadable round) */
export function ending(b: Bout): Ending | null {
  if (b.status !== FINAL || b.a_winner === b.b_winner) return null;
  const R = b.periods;
  if (R !== 3 && R !== 5) return null;
  const rd = b.round;
  if (rd == null || !Number.isInteger(rd) || rd < 1 || rd > R) return null;
  const finish = !(rd === R && b.clock === '5:00');
  return { winner: b.a_winner ? 'a' : 'b', finish, round: rd, R };
}

export interface Rate { n: number; finishes: number; rate: number }
export interface BaseRates { all: Rate; by_rounds: Record<string, Rate>; by_division: Record<string, Rate> }
export function baseRates(bouts: Bout[], from: number, to: number): BaseRates {
  const acc = (o: Record<string, Rate>, k: string, f: boolean) => { const x = o[k] || (o[k] = { n: 0, finishes: 0, rate: 0 }); x.n++; if (f) x.finishes++; };
  const all: Record<string, Rate> = {}, byR: Record<string, Rate> = {}, byD: Record<string, Rate> = {};
  for (const b of bouts) {
    if (b.ts < from || b.ts >= to) continue;
    const e = ending(b); if (!e) continue;
    acc(all, 'all', e.finish); acc(byR, String(e.R), e.finish);
    if (DIVISIONS.includes(b.weight_class)) acc(byD, b.weight_class, e.finish);
  }
  for (const o of [all, byR, byD]) for (const x of Object.values(o)) x.rate = r6(x.finishes / x.n);
  return { all: all.all || { n: 0, finishes: 0, rate: 0.5 }, by_rounds: byR, by_division: byD };
}
/** base(d, R): the format's rate moved by the division's, on the logit scale */
export function baseRate(B: BaseRates, division: string, R: number): number {
  const fr = B.by_rounds[String(R)], fd = B.by_division[division];
  const lr = logit(clampP(fr ? fr.rate : B.all.rate));
  return logistic(lr + (fd ? logit(clampP(fd.rate)) - logit(clampP(B.all.rate)) : 0));
}

/** a fighter's record of endings, for the shrunk deviations */
export interface FinishCounts { w: number; wf: number; ew: number; l: number; lf: number; el: number }
export const emptyCounts = (): FinishCounts => ({ w: 0, wf: 0, ew: 0, l: 0, lf: 0, el: 0 });
/** dev = logit((k + m e) / (n + m)) - logit(e), e = mean expected rate of those bouts; 0 with no bouts or m = Infinity */
export function dev(k: number, n: number, sumE: number, m: number): number {
  if (!(n > 0) || !Number.isFinite(m)) return 0;
  const e = clampP(sumE / n);
  return logit(clampP((k + m * e) / (n + m))) - logit(e);
}
export function finishGivenWinner(base: number, winner: FinishCounts, loser: FinishCounts, m: number): number {
  return logistic(logit(clampP(base)) + dev(winner.wf, winner.w, winner.ew, m) + dev(loser.lf, loser.l, loser.el, m));
}

export interface FinishStudy {
  source: string;
  base: BaseRates;
  /** the base rates the holdout was scored with (estimated before it) */
  base_pre_holdout: BaseRates;
  windows: { tune: [string, string]; holdout: [string, string] };
  shrink: { chosen_m: number; grid: Array<{ m: number | null; tune_log_loss: number; holdout_log_loss: number }>; base_only: { tune_log_loss: number; holdout_log_loss: number }; constant: { tune_log_loss: number; holdout_log_loss: number }; n_tune: number; n_holdout: number };
  rounds: { chosen_c: number | null; grid: Array<{ c: number | null; tune_log_lik: number; holdout_log_lik: number }>; by_rounds: Record<string, { n: number; dist: number[] }>; by_division: Record<string, Record<string, { n: number; dist: number[] }>> };
  no_winner: { finals: number; draws: number; no_contests: number; rate: number; recent_rate: number; recent_from: string };
  excluded: { four_rounds: number; outside_divisions: number };
  by_year: Array<{ year: number; n: number; finish_rate: number }>;
}
const M_GRID = [1, 3, 6, 10, 15, 25, 40, 70, 120];
const C_GRID = [0, 5, 15, 30, 60, 120, 250, 500];

/** round distribution given a finish: the division's counts shrunk toward the format's with c pseudo-finishes */
export function roundDist(byR: Record<string, { n: number; counts: number[] }>, byD: Record<string, Record<string, { n: number; counts: number[] }>>, division: string, R: number, c: number): number[] {
  const pool = byR[String(R)], cell = byD[division] && byD[division][String(R)];
  const pd = pool && pool.n ? pool.counts.map((x) => x / pool.n) : new Array(R).fill(1 / R);
  if (!cell || !cell.n || !Number.isFinite(c)) return pd;
  return cell.counts.map((x, k) => (x + c * pd[k]) / (cell.n + c));
}
function roundCounts(bouts: Bout[], from: number, to: number) {
  const byR: Record<string, { n: number; counts: number[] }> = {}, byD: Record<string, Record<string, { n: number; counts: number[] }>> = {};
  for (const b of bouts) {
    if (b.ts < from || b.ts >= to) continue;
    const e = ending(b); if (!e || !e.finish) continue;
    const p = byR[String(e.R)] || (byR[String(e.R)] = { n: 0, counts: new Array(e.R).fill(0) }); p.n++; p.counts[e.round - 1]++;
    if (DIVISIONS.includes(b.weight_class)) {
      const d = byD[b.weight_class] || (byD[b.weight_class] = {});
      const c = d[String(e.R)] || (d[String(e.R)] = { n: 0, counts: new Array(e.R).fill(0) }); c.n++; c.counts[e.round - 1]++;
    }
  }
  return { byR, byD };
}

/** the study over every final up to asOf (ms); the fighters' counts at asOf come back for pricing */
export function finishStudy(bouts: Bout[], asOf: number): { study: FinishStudy; counts: Map<string, FinishCounts> } {
  const T = (s: string) => Date.parse(s + 'T00:00:00Z');
  const t0 = T('2014-01-01'), tuneFrom = T('2016-01-01'), holdFrom = T('2023-01-01');
  const base = baseRates(bouts, t0, asOf + 1), basePre = baseRates(bouts, t0, holdFrom);
  /* point in time: each bout predicted from the counts before it, for every m at once */
  const ms: Array<number> = M_GRID.concat([Infinity]);
  const C = new Map<string, FinishCounts>();
  const ll = ms.map(() => ({ tune: 0, hold: 0 }));
  const llConst = { tune: 0, hold: 0 };
  let nT = 0, nH = 0, fT = 0, nT0 = 0;
  /* the constant: the tune window's overall rate */
  for (const b of bouts) { if (b.ts >= tuneFrom && b.ts < holdFrom) { const e = ending(b); if (e && DIVISIONS.includes(b.weight_class)) { nT0++; if (e.finish) fT++; } } }
  const pConst = fT / Math.max(1, nT0);
  for (const b of bouts) {
    if (b.ts > asOf) break;
    const e = ending(b); if (!e) continue;
    const inDiv = DIVISIONS.includes(b.weight_class);
    const Bx = b.ts >= holdFrom ? basePre : base;
    const bs = baseRate(Bx, b.weight_class, e.R);
    const W = e.winner === 'a' ? b.fighter_a_id : b.fighter_b_id, L = e.winner === 'a' ? b.fighter_b_id : b.fighter_a_id;
    const cw = C.get(W) || emptyCounts(), cl = C.get(L) || emptyCounts();
    if (inDiv && b.ts >= tuneFrom) {
      const y = e.finish ? 1 : 0, hold = b.ts >= holdFrom;
      ms.forEach((m, i) => { const p = clampP(finishGivenWinner(bs, cw, cl, m)); const v = -(y ? Math.log(p) : Math.log(1 - p)); if (hold) ll[i].hold += v; else ll[i].tune += v; });
      const v0 = -(y ? Math.log(pConst) : Math.log(1 - pConst));
      if (hold) { llConst.hold += v0; nH++; } else { llConst.tune += v0; nT++; }
    }
    /* absorb (expected rates from the full-window base: the counts describe the fighter, not the test) */
    const bAbs = baseRate(base, b.weight_class, e.R);
    cw.w++; cw.ew += bAbs; if (e.finish) cw.wf++;
    cl.l++; cl.el += bAbs; if (e.finish) cl.lf++;
    C.set(W, cw); C.set(L, cl);
  }
  const grid = ms.map((m, i) => ({ m: Number.isFinite(m) ? m : null, tune_log_loss: r6(ll[i].tune / nT), holdout_log_loss: r6(ll[i].hold / nH) }));
  const finite = grid.filter((g) => g.m != null);
  const best = finite.reduce((a, g) => (g.tune_log_loss < a.tune_log_loss ? g : a), finite[0]);
  const baseOnly = grid.find((g) => g.m == null)!;
  /* the round of a finish: point in time (each finish predicted from the finishes before it), c chosen on
     2016-2022 by log likelihood (the format's distribution alone, c = infinity, is a candidate), scored on 2023 on */
  const full = roundCounts(bouts, t0, asOf + 1);
  const cs = C_GRID.concat([Infinity]);
  const lk = cs.map(() => ({ tune: 0, hold: 0 }));
  {
    const byR: Record<string, { n: number; counts: number[] }> = {}, byD: Record<string, Record<string, { n: number; counts: number[] }>> = {};
    for (const b of bouts) {
      if (b.ts > asOf) break;
      const e = ending(b); if (!e || !e.finish) continue;
      const inDiv = DIVISIONS.includes(b.weight_class);
      if (inDiv && b.ts >= tuneFrom) {
        const hold = b.ts >= holdFrom;
        cs.forEach((c, i) => { const v = Math.log(Math.max(1e-9, roundDist(byR, byD, b.weight_class, e.R, c)[e.round - 1])); if (hold) lk[i].hold += v; else lk[i].tune += v; });
      }
      const p = byR[String(e.R)] || (byR[String(e.R)] = { n: 0, counts: new Array(e.R).fill(0) }); p.n++; p.counts[e.round - 1]++;
      if (inDiv) { const d = byD[b.weight_class] || (byD[b.weight_class] = {}); const q = d[String(e.R)] || (d[String(e.R)] = { n: 0, counts: new Array(e.R).fill(0) }); q.n++; q.counts[e.round - 1]++; }
    }
  }
  const rgrid = cs.map((c, i) => ({ c: Number.isFinite(c) ? c : null, tune_log_lik: r6(lk[i].tune), holdout_log_lik: r6(lk[i].hold) }));
  const rbest = rgrid.reduce((a, g) => (g.tune_log_lik > a.tune_log_lik ? g : a), rgrid[0]);
  const dist = (o: { n: number; counts: number[] }) => ({ n: o.n, dist: o.counts.map((x) => r6(x / o.n)) });
  /* no winner: draws (went the distance) and no contests */
  let finals = 0, draws = 0, nc = 0, rf = 0, rnw = 0;
  const recentFrom = T('2021-01-01');
  let four = 0, outside = 0;
  const years: Record<number, { n: number; f: number }> = {};
  for (const b of bouts) {
    if (b.status !== FINAL || b.ts > asOf) continue;
    finals++;
    if (b.ts >= recentFrom) rf++;
    if (b.a_winner === b.b_winner) {
      if (b.ts >= recentFrom) rnw++;
      if (b.periods != null && b.round === b.periods && b.clock === '5:00') draws++; else nc++;
      continue;
    }
    if (b.periods === 4) four++;
    else if (!DIVISIONS.includes(b.weight_class)) outside++;
    const e = ending(b);
    if (e && DIVISIONS.includes(b.weight_class)) { const y = new Date(b.ts).getUTCFullYear(); const o = years[y] || (years[y] = { n: 0, f: 0 }); o.n++; if (e.finish) o.f++; }
  }
  const study: FinishStudy = {
    source: 'model_loop/data/ufc/bouts.csv (ESPN scoreboard: round, clock, scheduled rounds, weight class; every final since 2014)',
    base, base_pre_holdout: basePre,
    windows: { tune: ['2016-01-01', '2022-12-31'], holdout: ['2023-01-01', new Date(asOf).toISOString().slice(0, 10)] },
    shrink: { chosen_m: best.m as number, grid, base_only: { tune_log_loss: baseOnly.tune_log_loss, holdout_log_loss: baseOnly.holdout_log_loss },
      constant: { tune_log_loss: r6(llConst.tune / nT), holdout_log_loss: r6(llConst.hold / nH) }, n_tune: nT, n_holdout: nH },
    rounds: { chosen_c: rbest.c, grid: rgrid,
      by_rounds: Object.fromEntries(Object.entries(full.byR).map(([k, v]) => [k, dist(v)])),
      by_division: Object.fromEntries(Object.entries(full.byD).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dist(v)]))])) },
    no_winner: { finals, draws, no_contests: nc, rate: r6((draws + nc) / finals), recent_rate: r6(rnw / Math.max(1, rf)), recent_from: '2021-01-01' },
    excluded: { four_rounds: four, outside_divisions: outside },
    by_year: Object.keys(years).map(Number).sort().map((y) => ({ year: y, n: years[y].n, finish_rate: r6(years[y].f / years[y].n) }))
  };
  return { study, counts: C };
}

/** the round distribution the simulation uses for (division, R), from the study */
export function studyRoundDist(S: FinishStudy, division: string, R: number): number[] {
  const toCounts = (o: { n: number; dist: number[] }) => ({ n: o.n, counts: o.dist.map((x) => x * o.n) });
  const byR = Object.fromEntries(Object.entries(S.rounds.by_rounds).map(([k, v]) => [k, toCounts(v)]));
  const byD = Object.fromEntries(Object.entries(S.rounds.by_division).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toCounts(v)]))]));
  return roundDist(byR, byD, division, R, S.rounds.chosen_c == null ? Infinity : S.rounds.chosen_c).map(r6);
}
