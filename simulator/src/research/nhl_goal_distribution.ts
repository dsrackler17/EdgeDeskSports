/* ===========================================================================
   NHL GOAL DISTRIBUTION — is the served score model fit for standings?

     node simulator/src/research/nhl_goal_distribution.ts [--check]

   Standings points are a function of HOW games end, not only who wins: every
   60-minute tie is a three-point game (the loser's point), regulation wins
   and ROW decide ties, and goal differential is a later tiebreaker. So the
   season simulator needs the 60-minute draw rate, the overtime/shootout
   split and the score dispersion to be right, not just the moneyline.

   Every scored regular-season game 2013-14 .. 2026-27 (to date) is priced
   out of sample by the served model (nhl_replay.ts reproduces the committed
   walk-forward exactly) under three distributions with the SAME λ:
     served     hockey/model/distribution.js as the slate prices it
                (score effects; draw_inflation off)
     inflated   the same with the 60-minute diagonal inflated by δ_S, δ_S
                fitted by maximum likelihood of the 60-minute score on the
                regular-season games of the three seasons before S (out of
                sample; 2013-14 has none, δ = 0)
     poisson    independent Poisson regulation goals with the same λ (the
                simplistic baseline the task says not to assume)
   and scored on: the 60-minute tie rate (mean predicted vs observed, binary
   log loss), the 3-way log loss, the 60-minute score log likelihood, the
   moneyline log loss, the dispersion of the 60-minute total and margin
   (observed squared residual / predicted variance), the overtime share of
   tied games and the shootout home rate, and the league's loser points per
   season.

   RULE (written into this file before the study was first run, 2026-10-23;
   the served model's confirmation-window draw shortfall was already known
   from hockey/validation/nhl_walkforward.json):
     The simulator uses `inflated` (with δ fitted on the three seasons before
     the live season) if and only if, on BOTH the selection window
     (2013-14 .. 2019-20) and the confirmation window (2020-21 .. 2025-26):
       1 its absolute tie-rate bias |mean P(tie) − observed| is smaller than
         the served model's,
       2 its binary tie log loss is not worse than the served model's, and
       3 its moneyline log loss is not worse by more than 0.0002.
     Otherwise the simulator uses the served distribution and the draw bias
     is stated as a limitation. The 2026-27 games scored so far are reported,
     never used to decide.

   Writes simulator/data/nhl_goal_distribution.json.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkforwardReplay, type ReplayGame } from './nhl_replay.ts';
import { exactGame, tieSplit, type DistParams } from '../sports/nhl/model_adapter.ts';
import { sha256Hex } from '../core/canonical.ts';
import { REPO } from '../sports/nfl/model_adapter.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GOAL_STUDY_FILE = path.join(SIM, 'data', 'nhl_goal_distribution.json');
export const LIVE_SEASON = 2027;
const WINDOWS: Record<string, [number, number]> = { selection: [2014, 2020], confirmation: [2021, 2026], live: [2027, 2027] };
const DELTA_GRID = Array.from({ length: 41 }, (_, i) => i / 100);
const MAXG = 12, N1 = MAXG + 1;
const r = (v: number, d = 5) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function poissonMatrix(lh: number, la: number): Float64Array {
  const pmf = (l: number) => { const p: number[] = []; let x = Math.exp(-l), acc = 0; for (let k = 0; k <= MAXG; k++) { if (k > 0) x *= l / k; p.push(x); acc += x; } p[MAXG] += Math.max(0, 1 - acc); return p; };
  const a = pmf(lh), b = pmf(la), m = new Float64Array(N1 * N1);
  for (let h = 0; h <= MAXG; h++) for (let k = 0; k <= MAXG; k++) m[h * N1 + k] = a[h] * b[k];
  return m;
}
function summary(m: Float64Array) {
  let home = 0, away = 0, tie = 0, eT = 0, eT2 = 0, eM = 0, eM2 = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const p = m[h * N1 + a]; if (!p) continue;
    if (h > a) home += p; else if (h < a) away += p; else tie += p;
    eT += (h + a) * p; eT2 += (h + a) * (h + a) * p; eM += (h - a) * p; eM2 += (h - a) * (h - a) * p;
  }
  return { home, away, tie, eT, vT: eT2 - eT * eT, eM, vM: eM2 - eM * eM };
}
function inflate(m: Float64Array, d: number): Float64Array {
  if (!(d > 0)) return m;
  const o = new Float64Array(m.length); let z = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) { const i = h * N1 + a; o[i] = m[i] * (h === a ? 1 + d : 1); z += o[i]; }
  for (let i = 0; i < o.length; i++) o[i] /= z;
  return o;
}
const clip = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));

interface Row { g: ReplayGame; served: Float64Array; poisson: Float64Array; split: ReturnType<typeof tieSplit>; h: number; a: number }

export function runStudy(log: (s: string) => void = console.log) {
  const t0 = Date.now();
  const rep = walkforwardReplay(LIVE_SEASON);
  const reg = rep.games.filter((g) => g.type === 'R' && g.season >= 2014 && Number.isFinite(g.lh));
  const dataIssues: string[] = [];
  const rows: Row[] = reg.map((g) => {
    const p: DistParams = { effects: rep.P[g.season].effects, ot: rep.P[g.season].ot, draw_inflation: 0 };
    const D = exactGame(p, g.lh, g.la);
    if ((g.decided === 'REG') === (g.reg_home === g.reg_away)) dataIssues.push(g.game_id + ': decided ' + g.decided + ' with 60-minute score ' + g.reg_home + '-' + g.reg_away);
    return { g, served: D.reg_matrix as Float64Array, poisson: poissonMatrix(g.lh, g.la), split: tieSplit(p, g.lh, g.la, false), h: Math.min(MAXG, g.reg_home), a: Math.min(MAXG, g.reg_away) };
  });
  /* δ_S by maximum likelihood of the 60-minute score on the three seasons before S */
  const delta: Record<number, { delta: number; n: number; seasons: [number, number] | null; basis: string }> = {};
  for (let S = 2014; S <= LIVE_SEASON; S++) {
    const pool = rows.filter((x) => x.g.season >= Math.max(2014, S - 3) && x.g.season < S);
    if (!pool.length) { delta[S] = { delta: 0, n: 0, seasons: null, basis: 'burn-in: no earlier out-of-sample season' }; continue; }
    let best = { d: 0, ll: -Infinity };
    for (const d of DELTA_GRID) {
      let ll = 0;
      for (const x of pool) { const p = x.served[x.h * N1 + x.a], t = summary(x.served).tie; ll += Math.log(clip(p * (x.h === x.a ? 1 + d : 1) / (1 + d * t))); }
      if (ll > best.ll) best = { d, ll };
    }
    delta[S] = { delta: best.d, n: pool.length, seasons: [Math.max(2014, S - 3), S - 1], basis: 'maximum likelihood of the 60-minute score, regular season, grid 0-0.40 by 0.01' };
  }
  type V = 'served' | 'inflated' | 'poisson';
  const matrixOf = (x: Row, v: V) => (v === 'poisson' ? x.poisson : v === 'inflated' ? inflate(x.served, delta[x.g.season].delta) : x.served);
  function metrics(sub: Row[], v: V) {
    let tieP = 0, tieY = 0, tieLL = 0, tieBr = 0, ll3 = 0, llS = 0, mlLL = 0, rT = 0, vT = 0, rM = 0, vM = 0, eT = 0, yT = 0;
    let otPred = 0, otObs = 0, nTied = 0, soHomeObs = 0, nSo = 0, soHomePred = 0;
    for (const x of sub) {
      const m = matrixOf(x, v), s = summary(m);
      const y = x.h === x.a ? 1 : 0;
      tieP += s.tie; tieY += y;
      tieLL += -(y * Math.log(clip(s.tie)) + (1 - y) * Math.log(clip(1 - s.tie))); tieBr += (s.tie - y) ** 2;
      ll3 += -Math.log(clip(x.h > x.a ? s.home : x.h < x.a ? s.away : s.tie));
      llS += -Math.log(clip(m[x.h * N1 + x.a]));
      const pHome = s.home + s.tie * (x.split.ot_home + x.split.so_home);
      mlLL += -(x.g.hw * Math.log(clip(pHome)) + (1 - x.g.hw) * Math.log(clip(1 - pHome)));
      const T = x.g.reg_home + x.g.reg_away, M = x.g.reg_home - x.g.reg_away;
      rT += (T - s.eT) ** 2; vT += s.vT; rM += (M - s.eM) ** 2; vM += s.vM; eT += s.eT; yT += T;
      if (y) {
        nTied++; otPred += x.split.ot_home + x.split.ot_away; otObs += x.g.decided === 'OT' ? 1 : 0;
        if (x.g.decided === 'SO') { nSo++; soHomeObs += x.g.hw; soHomePred += x.split.so_home / (x.split.so_home + x.split.so_away); }
      }
    }
    const n = sub.length || 1, obs = tieY / n;
    const z = 1.96, den = 1 + z * z / n, ctr = (obs + z * z / (2 * n)) / den, half = z * Math.sqrt(obs * (1 - obs) / n + z * z / (4 * n * n)) / den;
    return {
      n: sub.length,
      tie: { mean_p: r(tieP / n, 4), observed: r(obs, 4), observed_wilson95: [r(ctr - half, 4), r(ctr + half, 4)], bias: r(tieP / n - obs, 4), log_loss: r(tieLL / n), brier: r(tieBr / n) },
      regulation_3way_log_loss: r(ll3 / n), regulation_score_nll: r(llS / n), moneyline_log_loss: r(mlLL / n),
      total: { mean_pred: r(eT / n, 4), mean_obs: r(yT / n, 4), dispersion: r(rT / vT, 4) },
      margin: { dispersion: r(rM / vM, 4) },
      overtime: { tied_games: nTied, p_ot_given_tie_pred: r(otPred / Math.max(1, nTied), 4), p_ot_given_tie_obs: r(otObs / Math.max(1, nTied), 4), shootouts: nSo, so_home_pred: r(soHomePred / Math.max(1, nSo), 4), so_home_obs: r(soHomeObs / Math.max(1, nSo), 4) },
      loser_points: { predicted: r(tieP, 1), observed: tieY }
    };
  }
  const variants: V[] = ['served', 'inflated', 'poisson'];
  const windows: Record<string, Record<string, any>> = {};
  for (const [w, [a, b]] of Object.entries(WINDOWS)) {
    const sub = rows.filter((x) => x.g.season >= a && x.g.season <= b);
    windows[w] = { seasons: [a, b] };
    for (const v of variants) windows[w][v] = metrics(sub, v);
  }
  const bySeason: Record<string, any> = {};
  for (let S = 2014; S <= LIVE_SEASON; S++) {
    const sub = rows.filter((x) => x.g.season === S);
    if (!sub.length) continue;
    bySeason[S] = { delta: delta[S].delta, served: metrics(sub, 'served'), inflated: metrics(sub, 'inflated'), poisson: metrics(sub, 'poisson') };
    for (const v of variants) { const m = bySeason[S][v]; bySeason[S][v] = { n: m.n, tie: m.tie, moneyline_log_loss: m.moneyline_log_loss, total_dispersion: m.total.dispersion, margin_dispersion: m.margin.dispersion, loser_points: m.loser_points, p_ot_given_tie: [m.overtime.p_ot_given_tie_pred, m.overtime.p_ot_given_tie_obs] }; }
  }
  /* the rule */
  const checks: Array<{ window: string; rule: string; pass: boolean; served: number | null; inflated: number | null }> = [];
  for (const w of ['selection', 'confirmation']) {
    const s = windows[w].served, i = windows[w].inflated;
    checks.push({ window: w, rule: '1 |tie bias| smaller', pass: Math.abs(i.tie.bias) < Math.abs(s.tie.bias), served: s.tie.bias, inflated: i.tie.bias });
    checks.push({ window: w, rule: '2 tie log loss not worse', pass: i.tie.log_loss <= s.tie.log_loss, served: s.tie.log_loss, inflated: i.tie.log_loss });
    checks.push({ window: w, rule: '3 moneyline log loss not worse by > 0.0002', pass: i.moneyline_log_loss - s.moneyline_log_loss <= 0.0002, served: s.moneyline_log_loss, inflated: i.moneyline_log_loss });
  }
  const adopted = checks.every((c) => c.pass);
  const poissonVsServed = Object.fromEntries(['selection', 'confirmation', 'live'].map((w) => [w, {
    score_nll_poisson_minus_served: r(windows[w].poisson.regulation_score_nll - windows[w].served.regulation_score_nll),
    tie_bias_poisson: windows[w].poisson.tie.bias, tie_bias_served: windows[w].served.tie.bias,
    margin_dispersion_poisson: windows[w].poisson.margin.dispersion, margin_dispersion_served: windows[w].served.margin.dispersion,
    total_dispersion_poisson: windows[w].poisson.total.dispersion, total_dispersion_served: windows[w].served.total.dispersion
  }]));
  const file = (p: string) => sha256Hex(fs.readFileSync(path.join(REPO, p)));
  const out = {
    schema: 'edgedesk_sim_nhl_goal_distribution_v1',
    generated_at: new Date().toISOString(),
    method: 'Out-of-sample (walk-forward) regular-season games 2013-14 .. 2026-27 to date, priced by the served model (xg_core, reproduced from hockey/model/walkforward.js; nhl_replay.ts). Variants share the same λ: served distribution, served with 60-minute diagonal inflation δ_S fitted on the three earlier seasons, independent Poisson.',
    rule: 'Adopt the inflated distribution iff, on BOTH selection (2013-14..2019-20) and confirmation (2020-21..2025-26): |tie bias| smaller than served, tie log loss not worse, moneyline log loss not worse by more than 0.0002. Written before the first run; the live season is reported, never used to decide.',
    data_issues: dataIssues,
    delta_by_season: delta,
    windows, by_season: bySeason, poisson_vs_served: poissonVsServed,
    decision: {
      checks, adopted,
      production_draw_inflation: adopted ? delta[LIVE_SEASON].delta : 0,
      fitted_on: adopted ? delta[LIVE_SEASON].seasons : null,
      reading: adopted
        ? 'The served distribution under-prices the 60-minute tie on both windows; the walk-forward diagonal inflation removes most of the bias without worsening the tie or moneyline log loss, so the simulator prices the regulation tie with δ = ' + delta[LIVE_SEASON].delta + ' (fitted on ' + delta[LIVE_SEASON].seasons!.join('-') + ').'
        : 'The inflation did not pass every check; the simulator uses the served distribution and states its tie bias as a limitation.'
    },
    code: { distribution_js: file('hockey/model/distribution.js'), walkforward_js: file('hockey/model/walkforward.js'), replay_ts: file('simulator/src/research/nhl_replay.ts'), live_json: file('hockey/model/params/live.json') },
    runtime_ms: Date.now() - t0
  };
  return out;
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes('--check')) {
    const s = JSON.parse(fs.readFileSync(GOAL_STUDY_FILE, 'utf8'));
    const ok = s.schema === 'edgedesk_sim_nhl_goal_distribution_v1' && s.decision && typeof s.decision.adopted === 'boolean';
    console.log(ok ? 'nhl goal distribution study: ok (adopted ' + s.decision.adopted + ', δ ' + s.decision.production_draw_inflation + ')' : 'nhl goal distribution study: INVALID');
    process.exit(ok ? 0 : 1);
  }
  const out = runStudy();
  fs.mkdirSync(path.dirname(GOAL_STUDY_FILE), { recursive: true });
  fs.writeFileSync(GOAL_STUDY_FILE, JSON.stringify(out, null, 1) + '\n');
  const w = out.windows;
  for (const k of ['selection', 'confirmation', 'live']) for (const v of ['served', 'inflated', 'poisson']) {
    const m = w[k][v];
    console.log(k.padEnd(12) + v.padEnd(9) + ' n ' + m.n + ' tie ' + m.tie.mean_p + ' vs ' + m.tie.observed + ' (bias ' + m.tie.bias + ') tieLL ' + m.tie.log_loss + ' 3way ' + m.regulation_3way_log_loss + ' scoreNLL ' + m.regulation_score_nll + ' ML ' + m.moneyline_log_loss + ' disp T ' + m.total.dispersion + ' M ' + m.margin.dispersion + ' OT|tie ' + m.overtime.p_ot_given_tie_pred + '/' + m.overtime.p_ot_given_tie_obs + ' SOhome ' + m.overtime.so_home_pred + '/' + m.overtime.so_home_obs);
  }
  console.log('decision', JSON.stringify(out.decision));
  console.log('data issues', out.data_issues.length, 'runtime', out.runtime_ms, 'ms');
}
