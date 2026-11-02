'use strict';
/* NCAAM-EARLY — the Phase 5 backtest harness (backtest.js), on synthetic
   seasons with a known truth. No CBBD data, no outcome of a real game.
     node basketball/ncaam_early/tests/backtest.test.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const BT = require('../backtest');
const FE = require('../features');
const MD = require('../model');
const C = require('../config');

let pass = 0, fail = 0; const fails = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; fails.push(name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 500))); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);
const v0 = FE.loadConfig();
const REG = JSON.parse(fs.readFileSync(path.join(C.PATHS.BASE, 'research', 'registration.json'), 'utf8'));

/* ── windows ────────────────────────────────────────────────────────────── */
{
  const [f, t] = BT.earlyWindow(2026);
  chk('window: 2025-26 runs from 1 Nov 00:00 Eastern (EDT, 04:00 UTC) to 16 Dec 00:00 Eastern (EST, 05:00 UTC), [from, to)', new Date(f).toISOString() === '2025-11-01T04:00:00.000Z' && new Date(t).toISOString() === '2025-12-16T05:00:00.000Z');
  const [f20] = BT.earlyWindow(2020);
  chk('window: 2019-20 opens 1 Nov 2019 Eastern', new Date(f20).toISOString() === '2019-11-01T04:00:00.000Z');
  chk('window: 15 December 23:59 Eastern is inside; 16 December 00:00 is not', Date.parse('2025-12-16T04:59:00Z') < t && !(Date.parse('2025-12-16T05:00:00Z') < t));
  chk('windows: the machine dates of the registration bound every training window', BT.TRAINING_SEASONS.every((S) => { const [a, b] = BT.earlyWindow(S); return a >= Date.parse(REG.machine.window_dates.training[0]) && b <= Date.parse(REG.machine.window_dates.training[1] + 'T23:59:59Z'); }));
  const ends = (REG.training_window.match(/END years ([0-9, and]+)\)/) || [])[1] || '';
  chk('seasons: training END years are the registered 2020, 2022, 2023, 2024, 2025; 2021 excluded', JSON.stringify(BT.TRAINING_SEASONS) === '[2020,2022,2023,2024,2025]' && /2020, 2022, 2023, 2024, 2025/.test(ends)
    && JSON.stringify(BT.EXCLUDED_SEASONS) === '[2021]' && /2021\) is EXCLUDED/.test(REG.training_window));
  chk('selection: the improvement threshold is the registered 0.01, two sweeps', BT.MIN_IMPROVEMENT === 0.01 && /two sweeps/.test(REG.selection_rule.procedure) && />= 0\.01/.test(REG.selection_rule.procedure));
}

/* ── scores ─────────────────────────────────────────────────────────────── */
{
  chk('CRPS: at the mean of N(0, 1) it is 2 phi(0) - 1/sqrt(pi) = 0.23369', near(BT.crpsNormal(0, 0, 1), 0.2336949772, 1e-6));
  chk('CRPS: it scales with sd, and tends to |y - mu| as sd -> 0', near(BT.crpsNormal(0, 0, 10), 2.336949772, 1e-5) && near(BT.crpsNormal(7, 2, 1e-6), 5, 1e-5));
  chk('CRPS: a wider forecast is worse at its centre and better far out', BT.crpsNormal(0, 0, 12) > BT.crpsNormal(0, 0, 8) && BT.crpsNormal(40, 0, 12) < BT.crpsNormal(40, 0, 8));
  let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const recs = Array.from({ length: 20000 }, () => { const rv = 4 + 8 * rnd(); return { rating_var: rv, resid_margin: gauss() * Math.sqrt(121 + rv) }; });
  const b = BT.fitBaseSd(recs, 'resid_margin');
  chk('sd fit: maximum likelihood recovers a base sd of 11 under known rating variance', Math.abs(b - 11) < 0.25, b);
}

/* ── configurations ─────────────────────────────────────────────────────── */
{
  const sel = BT.selectables(v0);
  chk('selectables: the four registered values, in the order the file lists them', JSON.stringify(sel.map((x) => x.path)) === JSON.stringify(['player_value.shrink_minutes', 'transfer_translation.d1_to_d1.w', 'preseason_prior.roster_weight', 'preseason_prior.coach_change.coach_shrink']), sel.map((x) => x.path));
  chk('selectables: conviction thresholds and the base sds are not among them', !sel.some((x) => /conviction|base_.*_sd/.test(x.path)));
  const c = BT.withValues(v0, { 'preseason_prior.roster_weight': 1 });
  chk('withValues: sets a registered candidate on a copy; the registered config is unchanged', c.preseason_prior.roster_weight.value === 1 && v0.preseason_prior.roster_weight.value === 0.5);
  chk('withValues: a value outside the registered candidates is refused', /not a registered candidate/.test((() => { try { BT.withValues(v0, { 'preseason_prior.roster_weight': 0.6 }); return ''; } catch (e) { return e.message; } })()));
}

/* ── synthetic seasons with a known truth ──────────────────────────────────
   40 teams; last season's rating is the truth plus heavy noise, the roster
   build is the truth plus light noise: a higher roster weight is better */
function makeSeasons(seed) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const out = {};
  for (const S of BT.TRAINING_SEASONS) {
    const T = 40, teams = Array.from({ length: T }, (_, i) => ({ id: S * 100 + i, off: gauss() * 6, allow: gauss() * 6 }));
    const prev = new Map(teams.map((t) => [t.id, { off: (t.off + gauss() * 8) / 0.9, allow: (t.allow + gauss() * 8) / 0.9, tempo: 0 }]));
    const feats = new Map(teams.map((t) => [t.id, { team_id: t.id, roster_off: t.off + gauss(), roster_def: -(t.allow + gauss()), coach_change: false, returning_minutes_share: 0.5, variance_multiplier: 1 }]));
    const [from, to] = BT.earlyWindow(S);
    const finals = []; let gid = S * 10000;
    for (let d = 0; d < 60; d++) {
      const day = from + d * 86400e3 + 20 * 3600e3;
      const order = teams.slice().sort(() => rnd() - 0.5);
      for (let k = 0; k + 1 < order.length && k < 8; k += 2) {
        const h = order[k], a = order[k + 1];
        const yH = 108 + h.off + a.allow + 2.25 + gauss() * 11, yA = 108 + a.off + h.allow - 2.25 + gauss() * 11;
        finals.push({ game_id: ++gid, home: h.id, away: a.id, neutral: false, yH, yA, poss: 70, tempo: 70, start_ms: day, known_ms: day + C.AVAILABLE_AFTER_MS, hs: Math.round(yH * 0.7), as: Math.round(yA * 0.7) });
      }
    }
    out[S] = { teams, prev, feats, finals: finals.sort((x, y) => x.known_ms - y.known_ms), window: [from, to] };
  }
  return out;
}
const SYN = makeSeasons(12345);
const engine = { carry: 0.9, carry_tempo: 0.9 };
const loads = [];
const load = (S, cfg) => {
  loads.push(S);
  const x = SYN[S];
  if (!x) throw new Error('no synthetic season ' + S);
  const priors = new Map(); const features = new Map();
  for (const t of x.teams) { const f = x.feats.get(t.id); priors.set(t.id, MD.preseasonPrior(f, x.prev.get(t.id), { s2: 11000, lambda: 300 }, cfg, engine)); features.set(t.id, f); }
  return { priors, features, finals: x.finals, league: { mu: 108, eta: 2.25, tau: 70 } };
};

/* ── point in time ─────────────────────────────────────────────────────── */
{
  const r = BT.seasonRecords(2023, v0, load);
  const inWin = SYN[2023].finals.filter((f) => f.start_ms >= SYN[2023].window[0] && f.start_ms < SYN[2023].window[1]).length;
  chk('records: every window game is scored, and only window games', r.recs.length === inWin && r.games === inWin && r.recs.every((x) => x.start_ms >= SYN[2023].window[0] && x.start_ms < SYN[2023].window[1]));
  chk('records: the first day\'s games are projected from no final (the prior alone)', r.recs.filter((x) => x.start_ms === SYN[2023].finals[0].start_ms).every((x) => x.finals_used === 0));
  /* changing a late result must not move an earlier projection */
  const late = SYN[2023].finals[SYN[2023].finals.length - 1];
  const saved = Object.assign({}, late);
  late.yH += 60; late.hs += 40;
  const r2 = BT.seasonRecords(2023, v0, load);
  Object.assign(late, saved);
  const early = r.recs.filter((x) => x.start_ms < late.known_ms + 30 * 60e3).map((x) => x.game_id);
  const same = early.every((id) => near(r.recs.find((x) => x.game_id === id).margin, r2.recs.find((x) => x.game_id === id).margin, 1e-9));
  chk('point in time: a result known only later moves no projection made before it was known', same && early.length > 50);
  chk('records: a season outside the training list is refused', /not a training season/.test((() => { try { BT.seasonRecords(2026, v0, load); return ''; } catch (e) { return e.message; } })()));
}

/* ── the selection ─────────────────────────────────────────────────────── */
{
  loads.length = 0;
  const res = BT.select(v0, load);
  chk('select: only training seasons were read (no 2021, 2026 or 2027)', loads.length > 0 && loads.every((S) => BT.TRAINING_SEASONS.includes(S)), [...new Set(loads)]);
  chk('select: with a near-exact roster build and a noisy carried rating, it moves the roster weight up', res.chosen['preseason_prior.roster_weight'] > 0.5, res.chosen);
  chk('select: a value the synthetic seasons do not use (shrink minutes) is never accepted: no candidate beats it by 0.01', res.chosen['player_value.shrink_minutes'] === 250
    && res.steps.filter((s) => s.path === 'player_value.shrink_minutes').every((s) => !s.accepted));
  chk('select: every accepted step lowered the score by at least 0.01, every rejected one by less', res.steps.every((s) => (s.accepted ? s.current_score - s.candidate_score >= 0.01 : s.candidate_score == null || s.current_score - s.candidate_score < 0.01)), res.steps);
  chk('select: two sweeps over the four values, in order', res.steps.length === 8 && res.steps[0].path === 'player_value.shrink_minutes' && res.steps[4].sweep === 2 && res.steps[3].path === 'preseason_prior.coach_change.coach_shrink');
  const keys = res.candidates_tried.map((c) => JSON.stringify(c.values));
  chk('select: every configuration scored is recorded once, in order, with its LOSO score and per-season n', new Set(keys).size === keys.length && res.candidates_tried.every((c, i) => c.order === i + 1 && Number.isFinite(c.loso_margin_crps) && Object.keys(c.per_season).length === 5));
  const best = Math.min(...res.candidates_tried.map((c) => c.loso_margin_crps));
  chk('select: the chosen configuration\'s score is within 0.01 of the best scored', res.loso_margin_crps - best < 0.01 + 1e-12);
  chk('select: base sds fitted on all training windows with the chosen values (margin near the simulated ~11 x 0.7 x sqrt 2)', res.fitted.base_margin_sd > 7 && res.fitted.base_margin_sd < 16 && res.fitted.games === Object.values(res.games_by_season).reduce((a, g) => a + g.scored, 0), res.fitted);
  chk('select: LOSO: each held-out season is scored with a base sd fitted without it', Object.values(res.per_season).every((p) => Number.isFinite(p.base_margin_sd) && p.n > 0));
  chk('select: a non-training season in the list is refused before anything is read', /training seasons only/.test((() => { try { BT.select(v0, load, { seasons: [2020, 2026] }); return ''; } catch (e) { return e.message; } })()));
  /* the candidate and the report */
  const cand = BT.candidateConfig(v0, res, { ran_at: '2026-11-02T00:00:00Z', code_sha: 'abc' });
  chk('candidate: the chosen values and the fitted sds, rounded, with its selection record', cand.preseason_prior.roster_weight.value === res.chosen['preseason_prior.roster_weight'] && near(cand.game_projection.base_margin_sd.value, res.fitted.base_margin_sd, 5e-4)
    && cand.selection.from_config_sha256 === v0._sha256 && cand.selection.candidates_tried === res.candidates_tried.length && cand.config_version === '1.0.0-candidate');
  chk('candidate: Conviction thresholds, the decay schedule, the market rules and the angle tags are exactly as registered', JSON.stringify(cand.conviction) === JSON.stringify(v0.conviction)
    && JSON.stringify(cand.in_season_update) === JSON.stringify(v0.in_season_update) && JSON.stringify(cand.market) === JSON.stringify(v0.market) && JSON.stringify(cand.angle_tags) === JSON.stringify(v0.angle_tags));
  const rep = BT.report(res, { ran_at: 'x', code_sha: 'y', config_sha256: v0._sha256 });
  chk('report: aggregate numbers only (no game, team or player row)', !/"game_id"|"team_id"|"home"|"resid_/.test(JSON.stringify(rep)) && rep.kind.startsWith('TRAINING WINDOWS ONLY'));
}

/* ── the holdout gate ───────────────────────────────────────────────────── */
{
  const h0 = BT.holdoutAllowed(REG, path.join(C.PATHS.BASE, 'config', 'model_v1.json'));
  chk('holdout: refused now (registration 0.1.0, no frozen model_v1)', !h0.allowed && h0.why.some((w) => /0\.2\.0/.test(w)) && h0.why.some((w) => /does not exist/.test(w)), h0.why);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaam-bt-'));
  const f = path.join(tmp, 'model_v1.json'); fs.writeFileSync(f, '{"x":1}\n');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  chk('holdout: allowed only with version 0.2.0 and the registered sha256 of model_v1', BT.holdoutAllowed({ version: '0.2.0', spec: { config_v1_sha256: sha } }, f).allowed
    && !BT.holdoutAllowed({ version: '0.2.0', spec: { config_v1_sha256: 'f'.repeat(64) } }, f).allowed);
  chk('holdout: refused a second time once scored', !BT.holdoutAllowed({ version: '0.2.0', spec: { config_v1_sha256: sha }, retrospective_holdout_scored_at: '2026-12-01' }, f).allowed);
  fs.rmSync(tmp, { recursive: true, force: true });
  chk('registration: still EXPERIMENTAL, version 0.1.0, no result, no candidate tried (nothing has been scored)', REG.status === 'EXPERIMENTAL' && REG.version === '0.1.0' && REG.result === null && REG.forking_paths.candidates_tried.length === 0);
}

fails.forEach((x) => console.log('FAIL | ' + x));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NCAAM-EARLY backtest harness — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
