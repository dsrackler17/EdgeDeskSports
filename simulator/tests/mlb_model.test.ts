/* The served MLB game model as the simulator reads it, and the extra-inning rules:
   - replay() is walkforward.js pass() (2010-2011, every prediction)
   - the price is walkforward.js's own (calibration, recalibration), and the fast table is within 2e-5 of model.js game()
   - a level regulation draw resolves at the season's xi in the regular season (the automatic-runner rule) and at the
     standard-rule xi in the postseason; nothing about innings is modelled; no game ends tied
   - the run distribution the simulator assumes, against the validation study */
import { createRequire } from 'node:module';
import path from 'node:path';
import { kit } from './_kit.ts';
import { replay, servedConfig, WinTable, calibratedHome, loadRunsModel, lambdas, starterEffect } from '../src/sports/mlb/model_adapter.ts';
import { loadRegularSeason, REPO } from '../src/sports/mlb/history.ts';
import { extraInningRule } from '../src/sports/mlb/config.ts';
import { gameModelStudy } from '../src/sports/mlb/inputs.ts';
import { mlbModule } from '../src/sports/mlb/module.ts';
import { runRange } from '../src/core/engine.ts';
import { mlbFixture } from './_mlb_fixture.ts';

const K = kit('MLB game model, extra innings and run distributions');
const require = createRequire(import.meta.url);
const WF = require(path.join(REPO, 'mlb', 'history', 'walkforward.js'));
const { game } = loadRunsModel();
const served = servedConfig();

/* 1 replay parity with the served pass */
{
  const games = [2010, 2011].flatMap((s) => loadRegularSeason(s).games);
  const mine = replay(games, { params: served.config }).raw;
  const theirs = WF.pass(WF.load().filter((g: any) => g.season <= 2011), served.config, WF.CANDS.team_park_sp).raw;
  let maxd = 0, missing = 0;
  for (const [id, x] of theirs) { const y = mine.get(id); if (!y) { missing++; continue; } maxd = Math.max(maxd, Math.abs(x.lh - y.lh) / x.lh, Math.abs(x.la - y.la) / x.la); }
  K.eq('replay prices every 2010-2011 game walkforward.pass() prices', [mine.size, missing], [theirs.size, 0]);
  K.chk('replay equals walkforward.pass() (relative difference < 1e-12)', maxd < 1e-12, maxd);
}
/* 2 the price */
{
  const tab = new WinTable(4); const out = new Float64Array(2); let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const lh = 1.5 + 7 * ((i * 0.618034) % 1), la = 1.5 + 7 * ((i * 0.414214) % 1);
    tab.at(lh, la, out); const g = game(lh, la, 4, 0.5);
    worst = Math.max(worst, Math.abs(out[0] + 0.5 * out[1] - g.p_home), Math.abs(out[1] - g.p_tie9));
  }
  K.chk('the interpolated table is within 2e-5 of model.js game() (P(home > away) + level, and P(level))', worst < 2e-5, worst);
  const g = game(4.6, 4.1, 4, 0.52); const c = { r: 4, xi: 0.52, recal: [0.0833, 0.908] as [number, number] };
  const viaWF = WF.priced({ lh: 4.6, la: 4.1 }, c).p, mineP = calibratedHome(g.p_home - g.p_tie9 * 0.52, g.p_tie9, 0.52, c.recal);
  K.near('calibratedHome is walkforward.js priced() (the served recalibration)', mineP, viaWF, 1e-12);
}
/* 3 extra innings: the rule in force, by phase */
{
  K.eq('the automatic runner: regular season 2020 on; never in the postseason; not before 2020', [extraInningRule(2026, 'regular'), extraInningRule(2026, 'postseason'), extraInningRule(2019, 'regular'), extraInningRule(2020, 'regular')], ['automatic_runner', 'standard', 'standard', 'automatic_runner']);
  const snap = mlbFixture('ws'); const d = snap.data;
  const seen: Array<{ phase: string; p: number; home: string; away: string }> = [];
  const m = mlbModule(d, { seed: 5n, sigma: 0, sigmaSp: 0, pHome: (c) => { seen.push(c); return c.p; } });
  runRange(m, { start: 0, end: 50 });
  const g3 = seen.filter((x) => x.phase === 'postseason')[0];
  const M = d.model.state, cal = d.model.calibration;
  const l = lambdas(M, 'LAN', 'TOR', starterEffect(M, 'glast001'), starterEffect(M, 'schem001'));
  const t = new WinTable(cal.r).exact(l.lh, l.la);
  const pPost = calibratedHome(t[0], t[1], d.model.xi_postseason, cal.recal), pReg = calibratedHome(t[0], t[1], cal.xi, cal.recal);
  K.near('World Series game 3 (sigma 0, the announced starters) is priced at the STANDARD-rule xi', g3.p, pPost, 3e-5);
  K.chk('... which differs from the regular-season (automatic-runner) xi price in the direction of the measured rates', (d.model.xi_postseason > cal.xi) === (pPost > pReg) && Math.abs(pPost - pReg) > 1e-4, { pPost, pReg, xiPost: d.model.xi_postseason, xiReg: cal.xi });
  K.chk('every run prices game 3 identically at sigma 0 (the frozen model, no hidden randomness in the price)', seen.filter((x) => x.phase === 'postseason' && x.home === 'LAN' && Math.abs(x.p - g3.p) < 1e-15).length >= 50);
  const aug = mlbFixture('aug').data; const reg: number[] = [];
  const m2 = mlbModule(aug, { seed: 5n, sigma: 0, sigmaSp: 0, pHome: (c) => { if (c.phase === 'regular' && reg.length < 1) reg.push(c.p); return c.p; } });
  runRange(m2, { start: 0, end: 1 });
  K.chk('regular-season games are priced at the season\'s served xi (the automatic-runner seasons it was measured on)', aug.model.calibration.xi > 0.45 && aug.model.calibration.xi < 0.56 && reg.length === 1);
  const st = gameModelStudy().doc;
  K.chk('the postseason xi is the study\'s standard-rule rate (regular season before 2020 + every postseason)', d.model.xi_postseason === st.extra_inning_home_rate.used_by_simulator.postseason && st.extra_inning_home_rate.standard_pooled.games > 2000);
  K.chk('the study keeps the rule difference honest: its 95% interval is reported (it includes 0)', Array.isArray(st.extra_inning_home_rate.difference_standard_minus_runner.ci95) && st.extra_inning_home_rate.difference_standard_minus_runner.ci95[0] < 0);
}
/* 4 run distributions (the validation study the simulator's model is checked against) */
{
  const st = gameModelStudy().doc;
  const rd = st.run_distribution;
  K.chk('runs: the mean bias of the predicted runs is under 0.05 a side (2018-2025, out of sample)', Math.abs(rd.mean_bias_runs) < 0.05, rd.mean_bias_runs);
  K.chk('runs: the model variance is within 5% of the observed variance about the mean', Math.abs(rd.model_variance / rd.observed_variance_about_mean - 1) < 0.05, [rd.model_variance, rd.observed_variance_about_mean]);
  K.chk('runs: every point of the PMF (0..14, 15+) within 1.5 points of the observed frequency', rd.max_abs_pmf_difference < 0.015, rd.max_abs_pmf_difference);
  const lv = Object.values(st.extra_innings.level_after_nine_by_season) as any[];
  K.chk('extra innings: the model\'s level-after-nine mass is above the observed extra-inning share every season (stated limitation: 10% v 8.6%)', lv.every((x) => x.model_level_after_nine > x.observed_extra_share));
  K.chk('postseason pipeline scored (494 games) and reported against a coin', st.postseason_pipeline.with_standard_xi.n === 494 && typeof st.postseason_pipeline.coin.log_loss === 'number');
  /* the season calibration of 2025 the fixtures carry is the served one (three earlier seasons) */
  const ws = mlbFixture('ws').data;
  K.eq('the snapshot\'s calibration is the served calibration of its season', [ws.model.calibration.season, ws.model.calibration.r], [2025, 4]);
}
process.exit(K.done());
