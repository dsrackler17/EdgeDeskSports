/* Favourite-probability calibration: the game probabilities the CFB simulator
   consumes, audited before they are simulated (simulator/data/cfb_calibration.json,
   simulator/data/cfb_strength_uncertainty.json), and the gate that stops a run
   whose inputs are overconfident. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kit } from './_kit.ts';
import { cfbFixture, clone } from './_cfb.ts';
import { validateCfbInputs } from '../src/sports/cfb/validate.ts';
import { gameNoiseSd } from '../src/research/cfb_strength_uncertainty.ts';
import { normalCdf } from '../src/core/normal.ts';
import { loadCfbEngine } from '../src/sports/cfb/engine_adapter.ts';

const T = kit('CFB favourite-probability calibration');
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CAL = JSON.parse(fs.readFileSync(path.join(DATA, 'cfb_calibration.json'), 'utf8'));
const STR = JSON.parse(fs.readFileSync(path.join(DATA, 'cfb_strength_uncertainty.json'), 'utf8'));
const E = loadCfbEngine();

/* 1 the audit's findings, as committed */
T.eq('the calibration audit scored the engine version the simulator prices with', CAL.model_version, E.model_version);
for (const k of ['pre_fbs_2014_2021', 'pre_fbs_2022_2025', 'frozen_fbs_2014_2021', 'frozen_fbs_2022_2025', 'pre_fcs_2014_2025', 'frozen_fcs_2014_2025']) {
  const top = CAL.replay[k].table.filter((b: any) => b.n && b.bucket[0] >= 0.9);
  T.chk(k + ': no 90%+ favourite bucket is overconfident (' + top.map((b: any) => b.bucket[0] + ': ' + b.predicted + ' v ' + b.won + ' n ' + b.n).join('; ') + ')', top.length >= 3 && top.every((b: any) => b.verdict !== 'OVERCONFIDENT'), top);
}
T.chk('the frozen forecasts are scored up to 11 weeks ahead, by horizon', Object.keys(CAL.replay.frozen_fbs_by_horizon).join() === 'weeks_1_2,weeks_3_5,weeks_6_11');
T.chk('the large-favourite buckets have real samples (98-100%: n >= 100 next-game, 2014-2025)', CAL.replay.pre_fbs_2014_2021.table[6].n + CAL.replay.pre_fbs_2022_2025.table[6].n >= 100);
const live = CAL.live_2026.fbs.table.find((b: any) => b.bucket[0] === 0.9);
T.eq('the audit records that the LIVE board\'s 2026 90-95% FBS bucket was overconfident (the reason the simulator prices from the replay)', live.verdict, 'OVERCONFIDENT');
T.chk('... and that the live board is more extreme than the replay on the same games (logit slope > 1)', CAL.live_vs_replay_2026.logit_slope_live_on_replay > 1, CAL.live_vs_replay_2026.logit_slope_live_on_replay);
T.chk('the audit\'s decision is stated', CAL.decision.some((d: string) => /replay path/.test(d)));

/* 2 the strength offset keeps every game's probability: E_z[Phi((f + tau sqrt(k) z) / sqrt(sigma^2 - k tau^2))] = Phi(f / sigma) */
for (const [f, sigma, tau, k] of [[0, 15, 5.14, 2], [10, 14.8, 5.14, 2], [25, 15.2, 5.14, 2], [40, 15.68, 6.28, 2], [30, 15.0, 5.14, 1], [-18, 14.6, 4.6, 2]]) {
  const sd = gameNoiseSd(sigma, tau, k), n = 4000;
  let acc = 0;
  for (let i = 0; i < n; i++) { const u = (i + 0.5) / n, z = Math.SQRT2 * inverfc(2 * (1 - u)); acc += normalCdf((f + tau * Math.sqrt(k) * z) / sd); }
  T.near('decomposition preserves the per-game probability at fair ' + f + ', sigma ' + sigma + ', tau ' + tau + ', k ' + k, acc / n, normalCdf(f / sigma), 2e-4);
}
T.throws('a tau that leaves no game noise inside sigma is refused', () => gameNoiseSd(10, 8, 2), /no game noise/);
T.chk('stacking tau on top of sigma was measured and rejected: it makes calibrated games underconfident', STR.per_game_calibration.additive_alternative_fbs.some((b: any) => b.verdict === 'UNDERCONFIDENT') && STR.per_game_calibration.simulator_fbs.every((b: any) => !b.n || b.verdict === 'within interval'));
T.chk('the win-total calibration matches the 2024-2025 holdout within 10% at week 7', Math.abs(STR.by_as_of_week['7'].holdout.at_tau.sim / STR.by_as_of_week['7'].holdout.at_tau.emp - 1) < 0.1, STR.by_as_of_week['7'].holdout);
T.chk('and tau = 0 under-disperses win totals (the reason the offset exists)', STR.by_as_of_week['7'].estimation.at_zero.sim < 0.85 * STR.by_as_of_week['7'].estimation.at_zero.emp, STR.by_as_of_week['7'].estimation);

/* 3 the gate: an overconfident input stops publication */
{
  const snap = cfbFixture();
  T.eq('the committed snapshot passes the favourite-calibration gate', validateCfbInputs(snap).find((g) => g.id === 'calibration.favorites')!.status, 'PASS');
  const bad = clone(snap); bad.data.calibration.frozen_top_buckets[0].verdict = 'OVERCONFIDENT';
  const g = validateCfbInputs(bad).find((x) => x.id === 'calibration.favorites')!;
  T.chk('an overconfident favourite bucket FAILS the gate and blocks publication', g.status === 'FAIL' && g.blocks === 'publication', g);
  const heavy = snap.data.games.filter((x) => !x.done && x.model && Math.max(normalCdf(x.model.fair / x.model.sigma), 1 - normalCdf(x.model.fair / x.model.sigma)) >= 0.98);
  T.chk('the snapshot\'s 98%+ favourites (' + heavy.length + ') are priced with the engine\'s own sigma, never a narrowed one', heavy.every((x) => x.model!.sigma >= 14.5), heavy.map((x) => x.model!.sigma));
}
/* inverse erfc for the quadrature (Giles' single-precision approximation refined by two Newton steps) */
function inverfc(y: number): number {
  const x = 1 - y; let w = -Math.log((1 - x) * (1 + x)), p: number;
  if (w < 5) { w -= 2.5; p = 2.81022636e-08; for (const c of [3.43273939e-07, -3.5233877e-06, -4.39150654e-06, 0.00021858087, -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = c + p * w; }
  else { w = Math.sqrt(w) - 3; p = -0.000200214257; for (const c of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = c + p * w; }
  let r = p * x;
  for (let i = 0; i < 2; i++) { const err = erf(r) - x; r -= err / (2 / Math.sqrt(Math.PI) * Math.exp(-r * r)); }
  return r;
}
function erf(x: number): number { return 1 - 2 * (1 - normalCdf(x * Math.SQRT2)); }
process.exitCode = T.done();
