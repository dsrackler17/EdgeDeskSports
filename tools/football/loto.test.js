#!/usr/bin/env node
/* ===========================================================================
   LEAVE ONE TERM OUT — the harness's arithmetic on synthetic games whose
   answers are known, and the committed record held to the harness.
   football/cfb_p4/research/loto.js · docs/cfb-validation/LOTO.md

   Run: node tools/football/loto.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'loto.js'));
const PROMOTE = require(path.join(ROOT, 'football', 'validation', 'promote.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function section(t) { console.log('\n== ' + t); }

/* ------------------------------------------------------------ synthetic games
   The truth is known: matchup is real at its shipped weight, conference is
   pure noise, schedule is tiny, home field is real, rating is real but
   shipped 10% too large. One pairing never moves. */
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(R) { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function synth(opts) {
  opts = opts || {};
  const R = rng(opts.seed || 7), rows = [];
  for (let season = 2014; season <= 2025; season++) {
    for (let i = 0; i < (opts.perSeason || 900); i++) {
      const rating = gauss(R) * 9, matchup = gauss(R) * 2.5, conference = gauss(R) * 1.2, schedule = gauss(R) * 0.004;
      const neutral = R() < 0.07, hfa = neutral ? 0 : 2.8;
      const truth = rating / 1.1 + matchup + hfa;            /* conference and schedule carry nothing */
      const margin = Math.round(truth + gauss(R) * 13);
      const c = { rating, hfa, qb: 0, matchup, travel: 0, schedule, injury: 0, rivalry: 0, conference };
      const fair = Object.keys(c).reduce((s, k) => s + c[k], 0);
      const kick = Date.UTC(season, 8, 1) + i * 36e5;
      rows.push({ game_id: season + '_' + i, season, completed: true, home_fbs: true, away_fbs: true, neutral_site: neutral,
        final_margin: margin, fair, sigma: 14.5, c, c_avail: { matchup: true },
        prediction_ts: new Date(kick - 4 * 864e5).toISOString(), kickoff: new Date(kick).toISOString(),
        mkt: { close_home_line: -(truth + gauss(R) * 3) },
        mpairs: { 'early downs': matchup * 0.7, 'ball control': matchup * 0.3, 'run game': 0 } });
    }
  }
  return rows;
}

section('1. the arithmetic on a hand-sized case');
{
  const g = [{ final_margin: 10, fair: 8, t: 3 }, { final_margin: -4, fair: -1, t: -2 }, { final_margin: 0, fair: 2, t: 1 }]
    .map((x, i) => ({ season: 2023, final_margin: x.final_margin, fair: x.fair, sigma: 14, c: { m: x.t }, kickoff: '', prediction_ts: '', i }));
  const m = L.measure(g, (x) => x.c.m, { boot: 50, seed: 1 });
  /* with: |10-8|,|-4+1|,|0-2| = 2,3,2 → 7/3; without (fair - t = 5,1,1): 5,5,1 → 11/3 */
  chk('MAE with and without are the plain means of the two arms', Math.abs(m.mae_with - 7 / 3) < 1e-3 && Math.abs(m.mae_without - 11 / 3) < 1e-3, m);
  chk('…and delta is their difference (+ = the term helps)', Math.abs(m.delta - 4 / 3) < 1e-3, m.delta);
  /* k = Σ t (y - b) / Σ t²: b = 5, 1, 1 → (3·5 + -2·-5 + 1·-1) / 14 = 24/14 */
  chk('k is least squares of (result − projection without the term) on the term', Math.abs(m.k - 24 / 14) < 1e-3, m.k);
  const noiseless = [1, -2, 3, 0.5, -1.5].map((t, i) => ({ season: 2023, final_margin: 4 + t, fair: 4 + t, sigma: 14, c: { m: t }, i }));
  const mn = L.measure(noiseless, (x) => x.c.m, { boot: 50, seed: 2 });
  chk('a term that is exactly right has k = 1', Math.abs(mn.k - 1) < 1e-9, mn.k);
  const zero = L.measure(noiseless.map((x) => Object.assign({}, x, { c: { m: 0 } })), (x) => x.c.m, { boot: 10, seed: 3 });
  chk('a term that never moves is INERT, not graded', zero.inert === true && zero.k === undefined, zero);
}

section('2. weight verdicts read k’s interval');
{
  const W = (k, lo, hi) => L.weightVerdict({ n: 100, k, k_ci95: [lo, hi] }).key;
  chk('interval around 1 → weight supported', W(0.9, 0.6, 1.2) === 'WEIGHT_SUPPORTED');
  chk('interval inside (0, 1) → over-weighted', W(0.5, 0.3, 0.8) === 'OVERWEIGHTED');
  chk('interval above 1 → under-weighted', W(1.6, 1.2, 2.0) === 'UNDERWEIGHTED');
  chk('interval through 0 → no signal', W(0.2, -0.3, 0.7) === 'NO_SIGNAL');
  chk('interval below 0 → wrong sign', W(-0.8, -1.2, -0.3) === 'WRONG_SIGN');
  chk('a negligible term is not weighed', L.weightVerdict({ n: 100, negligible: true, mean_abs_term: 0.001 }).key === 'NEGLIGIBLE');
}

section('3. synthetic games: the harness finds the truth it was given');
{
  const J = L.run(synth(), { boot: 400 });
  const T = {}; J.terms.forEach((t) => { T[t.key] = t; });
  chk('leakage check passes when every row is priced before kickoff', J.leakage.clean === true);
  chk('the held-out window is 2022-2025', JSON.stringify(J.holdout) === JSON.stringify([2022, 2023, 2024, 2025]));
  chk('a real term at its right weight: k interval holds 1, delta positive', T.matchup.holdout.k_ci95[0] < 1 && T.matchup.holdout.k_ci95[1] > 1 && T.matchup.holdout.delta > 0, T.matchup.holdout);
  chk('…and the promotion rules validate it', T.matchup.status === 'VALIDATED', [T.matchup.status, T.matchup.reasons]);
  chk('a pure-noise term: k interval holds 0, never VALIDATED', T.conference.holdout.k_ci95[0] < 0 && T.conference.holdout.k_ci95[1] > 0 && T.conference.status !== 'VALIDATED', [T.conference.holdout.k_ci95, T.conference.status]);
  chk('a term that moves under 0.05 pts is NEGLIGIBLE, not graded', T.schedule.status === 'NEGLIGIBLE' && T.schedule.weight.key === 'NEGLIGIBLE', T.schedule.status);
  chk('…and its trained-scale row restates k in trained units', T.schedule.trained_scale && Math.abs(T.schedule.trained_scale.k - T.schedule.holdout.k / 100) < 0.01, T.schedule.trained_scale);
  chk('a real but over-weighted rating is caught (shipped 1.1×, best fit ≈ 0.91)', T.rating.holdout.k_ci95[1] < 1 && T.rating.weight.key === 'OVERWEIGHTED', T.rating.holdout.k_ci95);
  chk('the core rating is never put to the promotion rules', T.rating.status === null);
  const P = {}; J.pairs.forEach((p) => { P[p.name] = p; });
  chk('a pairing that never moves is INERT', P['run game'] && P['run game'].holdout.inert === true, P['run game']);
  chk('the moving pairings are measured', P['early downs'] && P['early downs'].holdout.n > 0 && P['early downs'].holdout.k != null);
  chk('the fitted window and the hold-out are both reported for a term with a fit window', T.matchup.fit_window && T.matchup.fit_window.result.n > 0 && T.matchup.between && T.matchup.between.result.n > 0);
  const leak = synth({ perSeason: 300 }); leak[leak.length - 5].prediction_ts = new Date(Date.parse(leak[leak.length - 5].kickoff) + 36e5).toISOString();
  const JL = L.run(leak, { boot: 100 });
  chk('a row priced after kickoff fails the leakage check', JL.leakage.clean === false && JL.leakage.violations === 1, JL.leakage);
  chk('…and no term can be validated on leaked rows', JL.terms.every((t) => t.status !== 'VALIDATED'));
  chk('the same rows give the same record (deterministic bootstrap)', JSON.stringify(L.run(synth({ perSeason: 200 }), { boot: 100 }).terms.map((t) => t.holdout)) === JSON.stringify(L.run(synth({ perSeason: 200 }), { boot: 100 }).terms.map((t) => t.holdout)));
}

section('4. the committed record');
{
  const f = path.join(ROOT, 'football', 'validation', 'loto_cfb.json');
  const J = JSON.parse(fs.readFileSync(f, 'utf8'));
  chk('schema and declaration', J.schema === 'edgedesk_cfb_loto_v1' && J.declared === '2026-10-24');
  chk('the committed rows passed the leakage check', J.leakage.clean === true && J.leakage.checked > 5000, J.leakage);
  chk('it covers 2014-2025 with 2022-2025 held out', J.rows.seasons[0] === 2014 && J.rows.seasons[J.rows.seasons.length - 1] === 2025 && J.holdout.join() === '2022,2023,2024,2025');
  chk('every declared term is in the record', L.TERMS.every((t) => J.terms.some((x) => x.key === t.key)));
  J.terms.filter((t) => t.status && ['VALIDATED', 'CANDIDATE', 'REJECTED', 'RESEARCH_ONLY'].indexOf(t.status) >= 0).forEach((t) => {
    const m = t.holdout;
    const again = PROMOTE.evaluate({ feature: 'cfb_term_' + t.key, per_season: m.per_season, spread_mae: m.mae_with, paired: { p: m.paired_p }, brier: m.brier_with, leakage_clean: J.leakage.clean, coefficient: m.k },
      { spread_mae: m.mae_without, brier: m.brier_without });
    chk('the stored status is what the promotion rules say of the stored numbers · ' + t.key, again.status === t.status, [again.status, t.status]);
  });
  const mt = J.terms.find((t) => t.key === 'matchup');
  chk('the matchup term was measured on the held-out window', mt && mt.holdout.n > 2000 && mt.fit_window && mt.fit_window.seasons.join() === '2014,2019');
  chk('inert pairings name the features the season feed does not supply', (J.pairs || []).filter((p) => p.holdout.inert).every((p) => p.unfed_features.length > 0));
  chk('the live split is recorded', J.live && J.live.games > 0 && J.live.mean_abs_matchup > 0);
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'cfb-validation', 'LOTO.md'), 'utf8');
  chk('docs/cfb-validation/LOTO.md is the render of the committed record', md === L.render(J));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | leave one term out | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
