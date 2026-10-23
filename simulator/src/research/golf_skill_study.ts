/* ===========================================================================
   HOW WELL CAN A GOLFER'S NEXT ROUNDS BE PREDICTED, AND HOW SURE CAN THE
   MODEL BE? — the evidence behind the golf skill model (simulator/src/
   sports/golf/model.ts) and the tournament simulation's per-player draw.

   Every number here is point-in-time: a test event's predictions come from
   a fit on the rounds played BEFORE its first round (fitSkills at the
   event's start). A test round's residual is
        r = y - a_hat - theta_hat_p,
   where a_hat is the round's own level, estimated from the round itself as
   the field's mean of (y - theta_hat): only the relative prediction (who
   beats whom) is tested, the part that decides a leaderboard.

   1. The prior for players the window holds few rounds of: the mean
      residual of players with no rounds (prior_shift_new) and with 1..24
      (prior_shift_few, per unit of the prior's weight in their posterior),
      re-estimated three times on the TUNING events; in a joint fit, each
      tour's unseen players then get that tour's own newcomer mean.
   2. Hyperparameters (half-life, kappa) by out-of-sample mean squared
      residual on every complete round of the TUNING events (2024); the
      HOLDOUT events (2025-2026) are scored once, with the chosen values.
   3. Separate or joint fits: the PGA Tour and DP World Tour share hundreds
      of players; a joint fit puts them on one scale. Chosen only if it
      lowers both tours' tuning error (the holdout is reported beside it).
   4. The tournament-level variance (the analog of the other sports'
      strength offset): within one event, two of a player's residuals share
      whatever is wrong with their pre-event skill and whatever is particular
      to that week (course fit, form, health):
           E[r_i r_j] = V   (round noise is independent between rounds)
      Rounds 1 and 2 are played by every starter, but share more than the
      week: the tee-time draw (morning/afternoon waves swap between the
      two days, and a bad draw can hit one wave twice) and, on multi-course
      events, the course rotation. Rounds 3-4 and the cross-half pairs
      (round 1 or 2 with round 3 or 4) carry only what persists through the
      week, but are played only by those who made the cut (a selected
      sample). All three are measured, and the simulation draws, once per
      player per tournament:
         delta  ~ N(0, c2 var_post)  in every round (c2: the cross-half
                  mean product over the mean var_post of the same pairs:
                  a player the model knows little about varies more),
         omega1 ~ N(0, W1)           in rounds 1-2, omega2 ~ N(0, W2) in
                  rounds 3-4 (each half's mean product beyond delta).
      Bootstrap over events (1,000 resamples).
   5. Round noise: sigma_eps^2 = E[r^2] - V on rounds 1-2, and its own
      value on rounds 3-4 (those who make the cut are steadier than the
      field: E[r^2] there less the offsets), and whether each player's own
      sd predicts their squared residuals (nu0 by tuning log likelihood under
      r ~ N(0, V + s_p^2)).

   Output: simulator/data/golf_skill_study.json
   Usage: node simulator/src/research/golf_skill_study.ts [--quick]
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { loadHistory, roundTable, fitSkills, skillOf, REPO, DAY, STUDY_FILE, TOURS, type HistEvent, type RoundTable, type SkillParams, type Tour } from '../sports/golf/model.ts';
import { streamFor } from '../core/prng.ts';

const QUICK = process.argv.includes('--quick');
export const TUNE = [2024], HOLD = [2025, 2026];
const BOOT = QUICK ? 200 : 1000, WINDOW = 1500, FEW_MAX = 24;

export interface TestRow { tour: Tour; ev: number; season: number; p: string; r: number; res: number; res0: number; var_post: number; s2: number; n_rounds: number; n_eff: number; on_prior: boolean; g: number }

/** every complete round of the test events, with the pre-event prediction's residual */
export function residuals(H: HistEvent[], fitTab: RoundTable, tests: HistEvent[], prm: SkillParams): TestRow[] {
  const out: TestRow[] = [];
  let warm: Float64Array | undefined;
  for (const e of tests) {
    const fit = fitSkills(fitTab, e.start / DAY, prm, warm);
    warm = fit.theta_raw;
    const evIdx = H.indexOf(e);
    for (let r = 1; r <= e.n_rounds; r++) {
      const field = e.players.map((p) => ({ p, rd: p.rounds.find((x) => x.r === r && x.complete) })).filter((x) => x.rd);
      if (field.length < 10) continue;
      const sk = field.map((x) => skillOf(fit, x.p.id));
      const lvl = field.reduce((a, x, i) => a + (x.rd!.strokes - sk[i].theta), 0) / field.length;
      const lvl0 = field.reduce((a, x) => a + x.rd!.strokes, 0) / field.length;
      field.forEach((x, i) => out.push({ tour: e.league, ev: evIdx, season: e.season, p: x.p.id, r, res: x.rd!.strokes - lvl - sk[i].theta, res0: x.rd!.strokes - lvl0, var_post: sk[i].var_post, s2: sk[i].sd_round ** 2,
        n_rounds: sk[i].n_rounds, n_eff: sk[i].n_eff, on_prior: sk[i].on_prior, g: prm.kappa / (sk[i].n_eff + prm.kappa) }));
    }
  }
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const mse = (rows: TestRow[]) => mean(rows.map((x) => x.res * x.res));

/** the products of a player's residuals in two rounds of one event (pairs of rounds as given) */
export function products(rows: TestRow[], pairs: Array<[number, number]>): Array<{ ev: number; prod: number; v: number }> {
  const by = new Map<string, Map<number, TestRow>>();
  for (const x of rows) { const k = x.ev + ':' + x.p; (by.get(k) || by.set(k, new Map()).get(k)!).set(x.r, x); }
  const out: Array<{ ev: number; prod: number; v: number }> = [];
  for (const g of by.values()) for (const [a, b] of pairs) { const x = g.get(a), y = g.get(b); if (x && y) out.push({ ev: x.ev, prod: x.res * y.res, v: x.var_post }); }
  return out;
}
/** mean product with an event-bootstrap 95% interval */
function meanBoot(prods: Array<{ ev: number; prod: number }>, seed: bigint): { mean: number; ci95: number[]; pairs: number; events: number } {
  const byEv = new Map<number, number[]>(); for (const q of prods) (byEv.get(q.ev) || byEv.set(q.ev, []).get(q.ev)!).push(q.prod);
  const evs = [...byEv.keys()], rs = streamFor(seed, 0, 1), bm: number[] = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, n = 0; for (let i = 0; i < evs.length; i++) { const a = byEv.get(evs[rs.nextInt(evs.length)])!; for (const v of a) s += v; n += a.length; } bm.push(s / n); }
  bm.sort((x, y) => x - y);
  return { mean: r4(mean(prods.map((q) => q.prod))), ci95: [r4(bm[Math.floor(0.025 * BOOT)]), r4(bm[Math.floor(0.975 * BOOT)])], pairs: prods.length, events: evs.length };
}

/** prior shifts: three passes of (mean residual of unseen players; least squares of few-round residuals on g) */
function estimateShifts(H: HistEvent[], tab: RoundTable, tests: HistEvent[], prm: SkillParams): SkillParams {
  let p = { ...prm, prior_shift_few: prm.prior_shift_few ?? 0, prior_shift_new: prm.prior_shift_new ?? 0, few_max: FEW_MAX };
  for (let pass = 0; pass < 3; pass++) {
    const rows = residuals(H, tab, tests, p);
    const nw = rows.filter((x) => x.n_rounds === 0), few = rows.filter((x) => x.n_rounds > 0 && x.n_rounds <= FEW_MAX);
    const dNew = nw.length ? mean(nw.map((x) => x.res)) : 0;
    const dFew = few.length ? few.reduce((a, x) => a + x.res * x.g, 0) / few.reduce((a, x) => a + x.g * x.g, 0) : 0;
    p = { ...p, prior_shift_new: r4(p.prior_shift_new + dNew), prior_shift_few: r4(p.prior_shift_few + dFew) };
  }
  return p;
}

interface Group { tours: Tour[]; params: SkillParams; grid: Array<{ half_life_days: number; kappa: number; mse: number; n: number }>; tune: Record<string, TestRow[]>; hold: Record<string, TestRow[]> }

function main() {
  const H = loadHistory();
  const ev = H.events;
  const t0 = Date.now();
  const grid = QUICK ? { h: [270, 365, 540], k: [3, 6, 10] } : { h: [120, 180, 240, 300, 365, 450, 540, 730], k: [1.5, 2, 3, 4, 6, 8, 10, 14, 20] };
  const tabs: Record<string, RoundTable> = {};
  const tabFor = (tours: Tour[]) => tabs[tours.join('+')] || (tabs[tours.join('+')] = roundTable(ev.filter((e) => tours.includes(e.league))));
  const tests = (tours: Tour[], seasons: number[]) => ev.filter((e) => tours.includes(e.league) && seasons.includes(e.season) && e.n_rounds >= 2);
  const log = (s: string) => console.log(s + ' · ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');

  /* 1-2 a fit group: shifts at a starting point, the grid, shifts again at the chosen values */
  function tuneGroup(tours: Tour[]): Group {
    const tab = tabFor(tours), tt = tests(tours, TUNE);
    let base = estimateShifts(ev, tab, tt, { half_life_days: 365, kappa: 10, nu0: Infinity, window_days: WINDOW });
    const g: Group['grid'] = [];
    for (const h of grid.h) for (const k of grid.k) {
      const rows = residuals(ev, tab, tt, { ...base, half_life_days: h, kappa: k });
      g.push({ half_life_days: h, kappa: k, mse: r4(mse(rows)), n: rows.length });
    }
    const best = g.slice().sort((a, b) => a.mse - b.mse)[0];
    const params = estimateShifts(ev, tab, tt, { ...base, half_life_days: best.half_life_days, kappa: best.kappa });
    const tune: Record<string, TestRow[]> = {}, hold: Record<string, TestRow[]> = {};
    for (const t of tours) { tune[t] = residuals(ev, tab, tests([t], TUNE), params); hold[t] = residuals(ev, tab, tests([t], HOLD), params); }
    log(tours.join('+') + ': half-life ' + params.half_life_days + ' d, kappa ' + params.kappa + ', prior shifts few ' + params.prior_shift_few + ' new ' + params.prior_shift_new + ', tuning MSE ' + tours.map((t) => t + ' ' + r4(mse(tune[t]))).join(' ') + ', holdout ' + tours.map((t) => t + ' ' + r4(mse(hold[t]))).join(' '));
    return { tours, params, grid: g, tune, hold };
  }
  const sep: Record<string, Group> = {};
  for (const t of TOURS) sep[t] = tuneGroup([t]);
  const jt = tuneGroup(['pga', 'eur']);
  const jointBetter = (['pga', 'eur'] as Tour[]).every((t) => mse(jt.tune[t]) < mse(sep[t].tune[t]));
  const groupOf = (t: Tour): Group => (jointBetter && t !== 'lpga' ? jt : sep[t]);
  log('joint PGA Tour + DP World Tour: ' + (jointBetter ? 'chosen' : 'not chosen'));

  /* 4-5 per tour */
  const tours: Record<string, unknown> = {};
  for (const t of TOURS) {
    let G = groupOf(t);
    /* in a joint fit, a player the window has never seen is still a newcomer to ONE tour: their prior mean is that
       tour's own (the tuning season's mean residual of its unseen players), the seen players' fit is unchanged */
    if (G.tours.length > 1) {
      const nw = G.tune[t].filter((x) => x.n_rounds === 0);
      const adj = nw.length ? mean(nw.map((x) => x.res)) : 0;
      const joint = G.params.prior_shift_new || 0, params = { ...G.params, prior_shift_new: r4(joint + adj) };
      G = { ...G, params, tune: { ...G.tune, [t]: residuals(ev, tabFor(G.tours), tests([t], TUNE), params) }, hold: { ...G.hold, [t]: residuals(ev, tabFor(G.tours), tests([t], HOLD), params) } };
      log(t + ': newcomer prior within the joint fit ' + params.prior_shift_new + ' (joint ' + joint + ' + ' + r4(adj) + ')');
    }
    const tune = G.tune[t], hold = G.hold[t], both = tune.concat(hold);
    const p12 = products(both, [[1, 2]]), p34 = products(both, [[3, 4]]), px = products(both, [[1, 3], [1, 4], [2, 3], [2, 4]]);
    const m12 = meanBoot(p12, 0x6012n), m34 = meanBoot(p34, 0x6034n), mx = meanBoot(px, 0x60aan);
    const mxTune = meanBoot(products(tune, [[1, 3], [1, 4], [2, 3], [2, 4]]), 0x60abn), mxHold = meanBoot(products(hold, [[1, 3], [1, 4], [2, 3], [2, 4]]), 0x60acn);
    const m12Tune = meanBoot(products(tune, [[1, 2]]), 0x6013n), m12Hold = meanBoot(products(hold, [[1, 2]]), 0x6014n);
    /* the persistent per-player variance, proportional to the model's own posterior variance: c^2 is the ratio of the
       cross-half mean product to the mean var_post of the same pairs (a player the model knows little about varies more) */
    const c2 = Math.max(0, mx.mean) / mean(px.map((q) => q.v));
    const vOf = (v: number) => c2 * v;
    /* what the two rounds of one half share beyond it (the tee-time draw, the course rotation): W1, W2 */
    const W1 = Math.max(0, m12.mean - c2 * mean(p12.map((q) => q.v))), W2 = Math.max(0, m34.mean - c2 * mean(p34.map((q) => q.v)));
    const V = Math.max(0, mx.mean);
    const r12 = both.filter((x) => x.r <= 2);
    const eps2 = mean(r12.map((x) => x.res * x.res)) - Math.max(0, m12.mean);
    const r34 = both.filter((x) => x.r >= 3);
    const pred34 = mean(r34.map((x) => vOf(x.var_post))) + W2 + eps2, obs34 = mean(r34.map((x) => x.res * x.res));
    /* the weekend's own round noise: those who make the cut are steadier than the field (E[r^2] on rounds 3-4 less the offsets) */
    const eps2wk = Math.max(0, obs34 - mean(r34.map((x) => vOf(x.var_post))) - W2);
    /* per-player sd: nu0 by tuning log likelihood, each player's relative sd scaled to sigma_eps */
    const nuRes: Array<{ nu0: number | string; loglik: number }> = [];
    let bestNu = Infinity, bestLL = -Infinity;
    for (const nu of [Infinity, 200, 100, 50, 25]) {
      const rows = residuals(ev, tabFor(G.tours), tests([t], TUNE), { ...G.params, nu0: nu });
      const sbar = mean(rows.map((x) => x.s2));
      const ll = mean(rows.map((x) => { const v = vOf(x.var_post) + W1 + eps2 * x.s2 / sbar; return -0.5 * (Math.log(2 * Math.PI * v) + x.res * x.res / v); }));
      nuRes.push({ nu0: Number.isFinite(nu) ? nu : 'one sd for the tour', loglik: r4(ll) });
      if (ll > bestLL + 1e-4) { bestLL = ll; bestNu = nu; }
    }
    const buckets: Array<[string, (n: number) => boolean]> = [['0 (on the prior)', (n) => n === 0], ['1-8', (n) => n >= 1 && n <= 8], ['9-24', (n) => n >= 9 && n <= 24], ['25-60', (n) => n >= 25 && n <= 60], ['61+', (n) => n > 60]];
    const bucket = (rows: TestRow[]) => buckets.map(([label, f]) => { const rr = rows.filter((x) => f(x.n_rounds)); const m = mean(rr.map((x) => x.res)); const sd = Math.sqrt(mean(rr.map((x) => (x.res - m) ** 2))); return { rounds_in_window: label, n: rr.length, mean_residual: r4(m), se: r4(sd / Math.sqrt(Math.max(1, rr.length))) }; });
    tours[t] = {
      fit_tours: G.tours,
      params: { ...G.params, nu0: Number.isFinite(bestNu) ? bestNu : null },
      tuning_grid: G.grid,
      out_of_sample: {
        tuning: { seasons: TUNE, rounds: tune.length, mse: r4(mse(tune)), mse_no_skill: r4(mean(tune.map((x) => x.res0 * x.res0))) },
        holdout: { seasons: HOLD, rounds: hold.length, mse: r4(mse(hold)), mse_no_skill: r4(mean(hold.map((x) => x.res0 * x.res0))) },
        note: 'mean squared residual of a pre-event prediction; mse_no_skill: every player equal (the field mean of the round)'
      },
      tournament_variance: {
        c2: r4(c2), W1: r4(W1), W2: r4(W2),
        method: 'per player per tournament, offsets drawn once: delta ~ N(0, c2 x var_post) in every round (c2 = the cross-half mean product E[r_i r_j], i in rounds 1-2, j in rounds 3-4, over the mean var_post of the same pairs: what persists through the week), omega1 ~ N(0, W1) in rounds 1-2 and omega2 ~ N(0, W2) in rounds 3-4 (what the two rounds of a half share beyond it: the round-1-2 and round-3-4 mean products minus c2 x their mean var_post)',
        cross_half: { ...mx, mean_var_post: r4(mean(px.map((q) => q.v))), tuning: mxTune.mean, holdout: mxHold.mean },
        rounds_1_2: { ...m12, mean_var_post: r4(mean(p12.map((q) => q.v))), tuning: m12Tune.mean, holdout: m12Hold.mean, note: 'every starter; includes the shared tee-time draw (morning and afternoon waves swap between the two days) and the course rotation of multi-course events' },
        rounds_3_4: { ...m34, mean_var_post: r4(mean(p34.map((q) => q.v))), note: 'players who made the cut only (a selected sample)' },
        check_rounds_3_4: { predicted_mean_square: r4(pred34), observed_mean_square: r4(obs34), note: 'E[r^2] on rounds 3-4 predicted by c2 var_post + W2 + sigma_eps^2 against the observed' },
        note: 'the cross-half pairs are played by those who made the cut: selection on rounds 1-2 makes them a slightly different sample from the field'
      },
      round_noise: { sigma_eps: r4(Math.sqrt(Math.max(0, eps2))), method: 'sqrt(E[r^2] - E[r1 r2]) on rounds 1-2', sigma_eps_weekend: r4(Math.sqrt(eps2wk)), method_weekend: 'sqrt(E[r^2] - c2 var_post - W2) on rounds 3-4 (players who made the cut)', nu0_grid: nuRes, nu0: Number.isFinite(bestNu) ? bestNu : null },
      newcomers: { tuning: bucket(tune), holdout: bucket(hold) }
    };
    log(t + ': c2 ' + r4(c2) + ', W1 ' + r4(W1) + ', W2 ' + r4(W2) + ', V ' + r4(V) + ' (cross-half ' + mx.mean + ' [' + mx.ci95.join(', ') + '], R1R2 ' + m12.mean + ', R3R4 ' + m34.mean + ', mean var_post ' + r4(mean(p12.map((q) => q.v))) + '); sigma_eps ' + r4(Math.sqrt(eps2)) + '; nu0 ' + bestNu + '; R3-4 mean square ' + r4(obs34) + ' vs predicted ' + r4(pred34) + ', weekend noise ' + r4(Math.sqrt(eps2wk)));
  }
  const doc = {
    schema: 'edgedesk_sim_golf_skill_study_v1',
    generated_at: new Date().toISOString(),
    data: { file: 'simulator/data/feeds/golf_events.json.gz', fetched_at: H.fetched_at, sha256: H.sha256, events: ev.length, excluded: H.excluded },
    windows: { tuning: TUNE, holdout: HOLD, window_days: WINDOW, few_max: FEW_MAX },
    joint: {
      chosen: jointBetter ? [['pga', 'eur']] : [],
      rule: 'joint only if it lowers the tuning MSE of both tours',
      pga: { tuning_mse_joint: r4(mse(jt.tune.pga)), tuning_mse_separate: r4(mse(sep.pga.tune.pga)), holdout_mse_joint: r4(mse(jt.hold.pga)), holdout_mse_separate: r4(mse(sep.pga.hold.pga)) },
      eur: { tuning_mse_joint: r4(mse(jt.tune.eur)), tuning_mse_separate: r4(mse(sep.eur.tune.eur)), holdout_mse_joint: r4(mse(jt.hold.eur)), holdout_mse_separate: r4(mse(sep.eur.hold.eur)) }
    },
    tours,
    quick: QUICK,
    runtime_s: Math.round((Date.now() - t0) / 1000)
  };
  const out = QUICK ? path.join(REPO, 'simulator', 'out', 'golf_skill_study.quick.json') : STUDY_FILE;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
  log('wrote ' + path.relative(REPO, out));
}
main();
