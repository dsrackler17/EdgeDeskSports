/* ===========================================================================
   MLB game-model validation for the simulator:
   simulator/data/mlb_game_model_study.json

   What the simulator takes from the served model, checked out of sample
   (every prediction below is the replay's point-in-time prediction: the
   game's own result was never in the fit):

   1 RUN DISTRIBUTIONS. Each side's runs are a negative binomial of size r
     (the served calibration's r) about the model's mean. Over the served
     record's confirmation window (2018-2025): mean bias, the observed
     frequency of 0..14 and 15+ runs against the model's average PMF, the
     variance of runs about the mean against the model's own variance, and
     runs by decile of the predicted mean.
   2 EXTRA INNINGS. The model's P(level after nine) — the mass the served
     win probability resolves at the extra-inning home rate xi — against the
     observed share of extra-inning games (regular season: more than 54
     outs; postseason: more than nine innings in the line score).
   3 THE EXTRA-INNING HOME RATE BY RULE. Regular-season games since 2020
     start each extra inning with a runner on second; postseason games and
     every game before 2020 do not. The home club's win rate in extra-inning
     games under each rule, with Wilson intervals and their difference. The
     simulator resolves a level postseason draw at the STANDARD-rule rate
     (no situational scoring is modelled: the rule only picks which measured
     rate applies).
   4 THE POSTSEASON. The served pipeline (frozen at the end of each regular
     season, actual starters, the season's calibration) on every postseason
     game 2012-2025 except 2020: log loss, Brier and calibration in the
     large, with the standard-rule xi and with the regular-season xi.

     node simulator/src/research/mlb_game_model_study.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { studyReplay, studyCaptureDays, seasonEndDay, fileSha } from './mlb_replay.ts';
import { loadPostseason, REPO } from '../sports/mlb/history.ts';
import { lambdas, starterEffect, calibratedHome, loadRunsModel } from '../sports/mlb/model_adapter.ts';
import { wilson } from '../core/stats.ts';

export const GAME_MODEL_STUDY = path.join(REPO, 'simulator', 'data', 'mlb_game_model_study.json');
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

function rate(k: number, n: number) { const w = wilson(k, n); return { wins: k, games: n, rate: r6(k / n), ci95: [r6(w.lo), r6(w.hi)] }; }

function main() {
  const log = (s: string) => console.log('[mlb game model] ' + s);
  const R = studyReplay(studyCaptureDays(), log);
  const { nbPmf } = loadRunsModel();
  const CONF = [2018, 2025];

  /* 1 run distributions */
  const K = 15; const obs = new Array(K + 1).fill(0), mod = new Array(K + 1).fill(0);
  let n = 0, sumBias = 0, sumSq = 0, sumVar = 0;
  const deciles: Array<{ lam: number; y: number }> = [];
  for (const g of R.games) {
    if (g.season < CONF[0] || g.season > CONF[1]) continue;
    const x = R.raw.get(g.id)!; const r = R.calibration[g.season].r;
    for (const [lam, y] of [[x.lh, g.hs], [x.la, g.as]] as Array<[number, number]>) {
      n++; sumBias += y - lam; sumSq += (y - lam) * (y - lam); sumVar += lam + lam * lam / r;
      obs[Math.min(K, y)]++;
      const p = nbPmf(lam, r, 60); let tail = 1;
      for (let k = 0; k < K; k++) { mod[k] += p[k]; tail -= p[k]; }
      mod[K] += tail;
      deciles.push({ lam, y });
    }
  }
  deciles.sort((a, b) => a.lam - b.lam);
  const dec = Array.from({ length: 10 }, (_, i) => {
    const part = deciles.slice(Math.floor(i * deciles.length / 10), Math.floor((i + 1) * deciles.length / 10));
    return { decile: i + 1, n: part.length, mean_predicted: r6(part.reduce((a, b) => a + b.lam, 0) / part.length), mean_observed: r6(part.reduce((a, b) => a + b.y, 0) / part.length) };
  });
  const pmf = obs.map((o, k) => ({ runs: k === K ? K + '+' : String(k), observed: r6(o / n), model: r6(mod[k] / n) }));
  const runDist = {
    window: CONF, team_games: n, nb_size_by_season: Object.fromEntries(Object.entries(R.calibration).map(([s, c]) => [s, c.r])),
    mean_bias_runs: r6(sumBias / n), observed_variance_about_mean: r6(sumSq / n), model_variance: r6(sumVar / n),
    max_abs_pmf_difference: r6(Math.max(...pmf.map((x) => Math.abs(x.observed - x.model)))), pmf, by_decile_of_predicted_mean: dec
  };
  log('runs: bias ' + runDist.mean_bias_runs + ', variance observed ' + runDist.observed_variance_about_mean + ' vs model ' + runDist.model_variance + ', max PMF diff ' + runDist.max_abs_pmf_difference);

  /* 2 + 3 extra innings, regular season */
  const xi = { runner: { w: 0, n: 0 }, standard: { w: 0, n: 0 } };
  const lvl: Record<string, { games: number; extra: number; model: number }> = {};
  for (const g of R.games) {
    if (g.outs == null) continue;                         // 2024: no length on file
    const rule = g.season >= 2020 ? 'runner' : 'standard';
    const extra = g.outs > 54;
    if (extra) { xi[rule].n++; if (g.hs > g.as) xi[rule].w++; }
    if (g.season < 2012) continue;
    const x = R.raw.get(g.id)!; const r = R.calibration[g.season]?.r ?? 4;
    const a = nbPmf(x.lh, r, 25), b = nbPmf(x.la, r, 25); let t = 0; for (let k = 0; k <= 25; k++) t += a[k] * b[k];
    const key = String(g.season); const e = lvl[key] || (lvl[key] = { games: 0, extra: 0, model: 0 });
    e.games++; if (extra) e.extra++; e.model += t;
  }
  const levelBySeason = Object.fromEntries(Object.entries(lvl).map(([s, e]) => [s, { games: e.games, observed_extra_share: r6(e.extra / e.games), model_level_after_nine: r6(e.model / e.games) }]));

  /* 4 the postseason, frozen at the end of each regular season */
  const post = loadPostseason().games.filter((g) => g.season !== 2020);
  let pw = 0, pn = 0; let pModel = 0, pExtra = 0;
  const scored: Array<{ season: number; y: 0 | 1; p_standard: number; p_regular: number }> = [];
  for (const g of post) {
    const extra = g.innings > 9; pn++; if (extra) { pExtra++; if (g.hs > g.as) pw++; }
    const M = R.captures.get(seasonEndDay(g.season));
    if (!M) throw new Error('no end-of-season capture for ' + g.season);
    const cal = R.calibration[g.season];
    const l = lambdas(M, g.home, g.away, starterEffect(M, g.sp_home), starterEffect(M, g.sp_away));
    const a = nbPmf(l.lh, cal.r, 25), b = nbPmf(l.la, cal.r, 25); let w = 0, t = 0;
    for (let x = 0; x <= 25; x++) { let c = 0; for (let y = 0; y < x; y++) c += b[y]; w += a[x] * c; t += a[x] * b[x]; }
    pModel += t;
    scored.push({ season: g.season, y: g.hs > g.as ? 1 : 0, p_standard: 0, p_regular: calibratedHome(w, t, cal.xi, cal.recal), _w: w, _t: t } as any);
  }
  /* the standard-rule rate: every extra-inning game played without the automatic runner */
  const stdW = xi.standard.w + pw, stdN = xi.standard.n + pExtra;
  const xiStandard = stdW / stdN;
  for (const s of scored as any[]) { const cal = R.calibration[s.season]; s.p_standard = calibratedHome(s._w, s._t, xiStandard, cal.recal); delete s._w; delete s._t; }
  const metric = (key: 'p_standard' | 'p_regular' | 'const') => {
    let ll = 0, br = 0, mp = 0, my = 0;
    for (const s of scored) { const p = key === 'const' ? 0.5 : s[key]; ll -= s.y ? Math.log(p) : Math.log(1 - p); br += (p - s.y) ** 2; mp += p; my += s.y; }
    const N = scored.length;
    return { n: N, log_loss: r6(ll / N), brier: r6(br / N), mean_p: r6(mp / N), mean_y: r6(my / N), calibration_in_the_large: r6((my - mp) / N) };
  };
  const runnerRate = rate(xi.runner.w, xi.runner.n), stdReg = rate(xi.standard.w, xi.standard.n), postRate = rate(pw, pExtra), pooled = rate(stdW, stdN);
  const diff = pooled.rate - runnerRate.rate;
  const se = Math.sqrt(pooled.rate * (1 - pooled.rate) / stdN + runnerRate.rate * (1 - runnerRate.rate) / xi.runner.n);
  const doc = {
    schema: 'edgedesk_sim_mlb_game_model_study_v1',
    built_at: new Date().toISOString(),
    served_model: { version: R.served.version, config: R.served.config, config_sha256: R.served.config_sha256, candidate: 'team_park_sp', source: R.served.source },
    inputs: { data_sha256: R.data_sha256, postseason_fixture_sha256: loadPostseason().sha256, model_sha256: fileSha('mlb/history/model.js'), walkforward_sha256: fileSha('mlb/history/walkforward.js') },
    run_distribution: runDist,
    extra_innings: {
      definition: 'regular season: more than 54 outs (Retrosheet length in outs; 2024 has none and is left out); postseason: more than nine innings in the visiting line score',
      level_after_nine_by_season: levelBySeason,
      postseason: { games: pn, observed_extra_share: r6(pExtra / pn), model_level_after_nine: r6(pModel / pn) }
    },
    extra_inning_home_rate: {
      automatic_runner_regular_season_2020_2025: runnerRate,
      standard_regular_season_2010_2019: stdReg,
      standard_postseason_2012_2025: postRate,
      standard_pooled: pooled,
      difference_standard_minus_runner: { estimate: r6(diff), ci95: [r6(diff - 1.959964 * se), r6(diff + 1.959964 * se)] },
      used_by_simulator: { regular_season: 'the served calibration xi of the season (three earlier seasons, the rule in force then)', postseason: r6(xiStandard), postseason_rule: 'standard (no automatic runner)' }
    },
    postseason_pipeline: {
      seasons: '2012-2025 except 2020', frozen_at: 'the morning after the last regular-season date', starters: 'actual (Retrosheet)',
      with_standard_xi: metric('p_standard'), with_regular_season_xi: metric('p_regular'), coin: metric('const')
    },
    notes: [
      'The served model is fitted on final scores (extra innings included) and resolves its level mass with xi; P(level) is compared with the observed share of extra-inning games as a check of that construction, not as a model of innings.',
      'Outcome validation only: no MLB closing prices are archived (mlb/history/validation/mlb_walkforward.json; the moneyline is PROVISIONAL and does not beat Elo).'
    ]
  };
  fs.writeFileSync(GAME_MODEL_STUDY, JSON.stringify(doc, null, 1) + '\n');
  log('xi runner ' + runnerRate.rate + ' (n ' + runnerRate.games + '), standard pooled ' + pooled.rate + ' (n ' + pooled.games + '), diff ' + r6(diff) + ' ± ' + r6(1.96 * se));
  log('postseason: ' + JSON.stringify(doc.postseason_pipeline.with_standard_xi) + ' vs regular xi ' + JSON.stringify(doc.postseason_pipeline.with_regular_season_xi));
  log('wrote ' + path.relative(REPO, GAME_MODEL_STUDY));
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
