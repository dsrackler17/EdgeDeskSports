#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The NCAAM forecast validation record.

     node basketball/ncaam_forecast/validate.js        writes validation/ncaam_fc_validation.json + VALIDATION.md
     node basketball/ncaam_forecast/validate.js --check the frozen upset policy and selection still hash

   Candidates (every one walked forward, scored on the same games):
     champion_candidate   research engine + this system's calibrator, the frozen
                          development selection (config/selection_v1.json)
     incumbent_as_served  the served points model, its own probabilities
     incumbent_ratings    the served points ratings through THIS calibrator
                          (isolates rating quality from the probability layer)
     elo                  the incumbent's tuned Elo (win probability only)
     home_only            home win rate / 0.5 at a neutral site
     ablations            no preseason prior (carry 0), constant width (no
                          parameter variance), no endgame tie factor (kappa 1),
                          the engine's unstabilised parameter variance
   Windows: development 2012-2019 (every choice was made here), confirmation
   2020-2026, the NCAA tournament games of 2024-2026 as the final tournament
   HOLDOUT (excluded from confirmation, reported separately once).
   Upset Watch: theta and the uncertainty threshold are chosen on development
   rows and written to config/upset_policy.json BEFORE the confirmation and
   holdout rows are scored; an existing policy file is never re-chosen.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const M = require('./metrics');
const D = require('./dist');
const EV = require('./evaluate');
const UP = require('./upset');
const FA = require('./factors');
const SEL = require('./select');
const U = require('../ncaam_research/lib/util');

const OUT = path.join(C.PATHS.validation, 'ncaam_fc_validation.json');
const MD_OUT = path.join(C.PATHS.validation, 'VALIDATION.md');
const P = SEL.PROTOCOL;
const lite = (s) => EV.summaryLite(s);

const inDev = (r) => r.season >= P.development[0] && r.season <= P.development[1];
const inConf = (r) => r.season >= P.confirmation[0] && r.season <= P.confirmation[1] && !(r.ncaa_round && P.tournament_holdout.includes(r.season));
const inHoldoutT = (r) => !!r.ncaa_round && P.tournament_holdout.includes(r.season);
const d1 = (r) => r.regime === 'D1_D1' && r.s;

function policyHash(p) { return MD.hash({ signals: p.signals, version: p.version, rule: p.rule }); }

function stage(r) { const m = new Date(r.start_ms).getUTCMonth() + 1; return m === 11 ? '1_nov' : m === 12 ? '2_dec' : m === 1 ? '3_jan' : m === 2 ? '4_feb' : '5_mar_apr'; }
function gp(r) { const n = Math.min(r.n_h == null ? 99 : r.n_h, r.n_a == null ? 99 : r.n_a); return n < 5 ? '0-4' : n < 10 ? '5-9' : n < 20 ? '10-19' : '20+'; }
function seedPair(r) { if (!r.ncaa_round || r.home_seed == null || r.away_seed == null) return null; const a = Math.min(r.home_seed, r.away_seed), b = Math.max(r.home_seed, r.away_seed); return a + 'v' + b; }
function breakdown(rows, key) {
  const g = new Map(); for (const r of rows) { const k = key(r); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const out = {}; for (const k of [...g.keys()].sort()) { const s = M.summarize(g.get(k), { reliability: false }); out[k] = lite(s); }
  return out;
}

function run() {
  const t0 = Date.now();
  const sel = JSON.parse(fs.readFileSync(SEL.FILE, 'utf8'));
  if (SEL.selectionHash(sel) !== sel.hash) throw new Error('config/selection_v1.json was edited after freezing');
  const games = DS.load(); const eg = DS.engineGames(games);
  const cfg = { engine: 'research_team_model', params: sel.chosen, calibration: sel.calibration };
  const runCfg = (c) => { const R = MD.researchRows(eg, c); MD.calibrateCausal(R.rows, c.calibration); return R.rows; };
  console.error('[validate] champion candidate'); const champ = runCfg(cfg);
  console.error('[validate] incumbent'); const inc = MD.incumbentRows(eg); MD.calibrateCausal(inc.raw, cfg.calibration);
  const incById = new Map(inc.asServed.map((r) => [r.game_id, r]));
  const meta = new Map(champ.map((r) => [r.game_id, r]));
  for (const r of inc.asServed.concat(inc.raw)) { const m = meta.get(r.game_id); if (m) Object.assign(r, { ncaa_round: m.ncaa_round, event: m.event, n_h: m.n_h, n_a: m.n_a, home_seed: m.home_seed, away_seed: m.away_seed }); }
  const elo = inc.asServed.map((r) => Object.assign({}, r, { s: { p_home: r.elo, m_crps: NaN } }));
  const homeOnly = []; { /* home win rate of the three seasons before, 0.5 at a neutral site */
    const rate = {}; for (const s of new Set(champ.map((r) => r.season))) { const xs = champ.filter((r) => !r.neutral && r.regime === 'D1_D1' && r.season < s && r.season >= s - 3); rate[s] = xs.length ? xs.reduce((a, r) => a + r.y.hw, 0) / xs.length : 0.6; }
    for (const r of champ) if (r.s) homeOnly.push(Object.assign({}, r, { s: { p_home: r.neutral ? 0.5 : rate[r.season], m_crps: NaN } }));
  }
  const ablations = {
    no_preseason_prior: Object.assign({}, cfg, { params: Object.assign({}, cfg.params, { carry: 0 }) }),
    constant_width: Object.assign({}, cfg, { calibration: Object.assign({}, cfg.calibration, { parameter_variance: 'zero' }) }),
    no_endgame_tie_factor: Object.assign({}, cfg, { calibration: Object.assign({}, cfg.calibration, { kappa: 1 }) }),
    engine_parameter_variance: Object.assign({}, cfg, { calibration: Object.assign({}, cfg.calibration, { parameter_variance: 'engine' }) }),
  };
  const abl = {};
  for (const [k, c] of Object.entries(ablations)) {
    console.error('[validate] ablation ' + k);
    const R = MD.researchRows(eg, c);
    if (c.calibration.parameter_variance === 'zero') for (const r of R.rows) if (Number.isFinite(r.var_param)) r.var_param = 0;
    MD.calibrateCausal(R.rows, c.calibration); abl[k] = R.rows;
  }
  const W = { development: inDev, confirmation: inConf, tournament_holdout: inHoldoutT };
  const pick = (rows, w) => rows.filter((r) => d1(r) && W[w](r));
  const ids = new Set(champ.filter((r) => d1(r)).map((r) => r.game_id));
  const shared = (rows) => rows.filter((r) => ids.has(r.game_id) && r.s && Number.isFinite(r.s.p_home));
  const windows = {};
  for (const w of Object.keys(W)) {
    const base = pick(champ, w);
    const ws = { n: base.length, champion_candidate: M.summarize(base), candidates: {}, comparisons: {} };
    const others = { incumbent_as_served: shared(inc.asServed), incumbent_ratings: shared(inc.raw), elo: shared(elo), home_only: shared(homeOnly) };
    for (const [k, rs] of Object.entries(others)) {
      const sub = rs.filter((r) => W[w](r) && r.regime === 'D1_D1');
      const s = M.summarize(sub, { reliability: false });
      ws.candidates[k] = k === 'elo' || k === 'home_only' ? { n: s.n, log_loss: s.win.log_loss, brier: s.win.brier, citl: s.win.calibration_in_the_large, slope: s.win.logistic_recalibration.slope } : lite(s);
      ws.comparisons['champion_candidate_vs_' + k] = { log_loss: M.compare(base, sub, 'log_loss'), brier: M.compare(base, sub, 'brier') };
      if (k === 'incumbent_as_served' || k === 'incumbent_ratings') ws.comparisons['champion_candidate_vs_' + k].margin_crps = M.compare(base, sub, 'margin_crps');
    }
    for (const [k, rs] of Object.entries(abl)) {
      const sub = rs.filter((r) => d1(r) && W[w](r));
      ws.candidates['ablation_' + k] = lite(M.summarize(sub, { reliability: false }));
      ws.comparisons['champion_candidate_vs_ablation_' + k] = { log_loss: M.compare(base, sub, 'log_loss'), margin_crps: M.compare(base, sub, 'margin_crps'), total_crps: M.compare(base, sub, 'total_crps') };
    }
    windows[w] = ws;
  }
  /* cohorts on the confirmation window */
  const conf = pick(champ, 'confirmation');
  const quar = new Map(); for (const g of games) if (g.quarantine.length) for (const t of [g.home_id, g.away_id]) quar.set(g.season + ':' + t, true);
  const cohorts = {
    probability_bucket: M.reliability(conf),
    season_stage: breakdown(conf, stage),
    venue: breakdown(conf, (r) => (r.neutral ? 'neutral' : 'home')),
    games_played_min: breakdown(conf, gp),
    event: breakdown(conf, (r) => r.event),
    conference_game: breakdown(conf, (r) => (r.conference_game ? 'conference' : 'non_conference')),
    data_quality: breakdown(conf, (r) => (quar.get(r.season + ':' + r.home) || quar.get(r.season + ':' + r.away) ? 'a_team_has_quarantined_games' : 'clean')),
    regime_d1_vs_non_d1: lite(M.summarize(champ.filter((r) => r.regime === 'D1_OTHER' && r.s && inConf(r)), { reliability: false })),
    seed_matchup_development_2023: breakdown(champ.filter((r) => d1(r) && r.season === 2023 && r.ncaa_round), seedPair),
  };
  /* tournament domain shift: NCAA tournament games vs neutral regular-season games of similar spread (development tournaments) */
  const devT = champ.filter((r) => d1(r) && r.ncaa_round && !P.tournament_holdout.includes(r.season) && r.season !== 2020);
  const neutralReg = champ.filter((r) => d1(r) && r.neutral && !r.ncaa_round && r.event !== 'conference_tournament' && r.season >= 2012 && !P.tournament_holdout.includes(r.season));
  const band = (r) => { const a = Math.abs(r.s.m_mean); return a < 3 ? '0-3' : a < 7 ? '3-7' : a < 12 ? '7-12' : '12+'; };
  const domain = { ncaa_tournament_games: lite(M.summarize(devT, { reliability: false })), neutral_regular_season: lite(M.summarize(neutralReg, { reliability: false })),
    ncaa_by_expected_margin: breakdown(devT, band), neutral_by_expected_margin: breakdown(neutralReg, band), ncaa_reliability: M.reliability(devT, 5),
    note: 'NCAA tournament games of the development tournaments (2012-2019, 2021-2023) against neutral-site regular-season games; a regular-season fit is not assumed to transfer' };
  /* Upset Watch: choose on development rows, freeze, then score later rows */
  const devRows = pick(champ, 'development');
  const fac = FA.teamFactors(games);
  const dogRows = (rows) => rows.map((r) => { const f = fac.get(String(r.game_id)) || {}; const homeDog = r.s.p_home < 0.5; return { p_dog: homeDog ? r.s.p_home : 1 - r.s.p_home, dog_won: homeDog ? r.y.hw : 1 - r.y.hw, h: FA.hypotheses(homeDog ? f.home : f.away, homeDog ? f.away : f.home, r.tempo) }; });
  let policy;
  if (fs.existsSync(C.PATHS.upsetPolicy)) {
    policy = JSON.parse(fs.readFileSync(C.PATHS.upsetPolicy, 'utf8'));
    if (policyHash(policy) !== policy.hash) throw new Error('config/upset_policy.json was edited after freezing');
  } else {
    const s = UP.select(devRows);
    policy = { schema: 'edgedesk_ncaam_fc_upset_policy_v1', version: 1, frozen_at: new Date().toISOString(), chosen_on: 'development ' + P.development.join('-') + ' D1-v-D1 rows (' + devRows.length + ')',
      rule: 'theta = the development 80th percentile of the underdog probability among games with a clear favourite (underdog < 0.45), rounded to 0.01: about one clear-favourite game in five is flagged; sd threshold = the development 90th percentile of the regulation-margin sd',
      underdog_basis_order: ['market', 'seed', 'model'],
      signals: { upset_probability: { theta: s.theta, toss_up: UP.TOSS_UP }, market_disagreement: { delta: 0.06, max_quote_age_min: 60, status: 'UNAVAILABLE: no NCAAM quote is captured (the odds gateway does not carry it)' },
        high_uncertainty: { sd_threshold: s.sd_threshold, min_games: 5 } },
      factor_tests: FA.test(dogRows(devRows)), selection_counts: s };
    policy.hash = policyHash(policy);
    fs.mkdirSync(C.PATHS.configDir, { recursive: true });
    fs.writeFileSync(C.PATHS.upsetPolicy, JSON.stringify(policy, null, 1) + '\n');
  }
  const upset = { policy_hash: policy.hash, theta: policy.signals.upset_probability.theta, development: UP.evaluate(devRows, policy), confirmation: UP.evaluate(conf, policy),
    tournament_holdout_model_basis: UP.evaluate(pick(champ, 'tournament_holdout'), policy),
    tournament_holdout_seed_basis: (() => { const rs = pick(champ, 'tournament_holdout').filter((r) => r.home_seed != null && r.away_seed != null && r.home_seed !== r.away_seed);
      const xs = rs.map((r) => { const dogHome = r.home_seed > r.away_seed; const p = dogHome ? r.s.p_home : 1 - r.s.p_home; return { p, y: dogHome ? r.y.hw : 1 - r.y.hw }; });
      const k = xs.reduce((a, x) => a + x.y, 0); return { games: xs.length, lower_seed_won: k, realized_rate: xs.length ? +(k / xs.length).toFixed(4) : null, mean_forecast: xs.length ? +(xs.reduce((a, x) => a + x.p, 0) / xs.length).toFixed(4) : null, ci95: xs.length ? UP.wilson(k, xs.length).map((v) => +v.toFixed(4)) : null }; })() };
  const leak = EV.leakage(champ.filter((r) => r.season >= P.development[0]));
  const cov = DS.coverage(games);
  const doc = {
    schema: 'edgedesk_ncaam_fc_validation_v1', generated_at: new Date().toISOString(), selection_hash: sel.hash, protocol: P,
    scope: C.RULES.competition, data: { seasons: Object.keys(cov).map(Number), coverage: cov, temporal: 'RETROSPECTIVE: results retrieved after the fact; a game is assumed known 4 h after tip; predictions 30 min before tip' },
    leakage: leak, log_loss_clip: M.EPS, windows, cohorts, tournament_domain_shift: domain, upset_watch: upset,
    first_season_rows_without_prior_variance: 'season 2010 (no earlier season residual variance): burn-in, not scored', runtime_s: Math.round((Date.now() - t0) / 1000),
  };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  fs.writeFileSync(MD_OUT, markdown(doc));
  console.log('[validate] wrote ' + path.relative(C.ROOT, OUT) + ' (' + doc.runtime_s + ' s), leakage violations ' + leak.violations);
  return doc;
}

function f(x, d) { return x == null || !Number.isFinite(x) ? '—' : (+x).toFixed(d == null ? 4 : d); }
function ci(c) { return c && c.ci95 ? f(c.mean_diff, 5) + ' [' + f(c.ci95[0], 5) + ', ' + f(c.ci95[1], 5) + ']' : '—'; }
function markdown(doc) {
  const L = ['# NCAAM forecast validation (generated)\n', 'Generated ' + doc.generated_at + ' by `basketball/ncaam_forecast/validate.js` from the committed data; selection ' + doc.selection_hash.slice(0, 16) + '. Retrospective: results are retrieved after the fact and assumed known 4 h after tip.\n'];
  for (const [w, ws] of Object.entries(doc.windows)) {
    L.push('## ' + w + ' (D1 vs D1, n = ' + ws.n + ')\n');
    L.push('| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |\n|---|---|---|---|---|---|---|---|---|');
    const c = lite(ws.champion_candidate); L.push('| **champion candidate** | ' + c.n + ' | ' + f(c.log_loss, 5) + ' | ' + f(c.brier, 5) + ' | ' + f(c.margin_crps) + ' | ' + f(c.margin_mae, 3) + ' | ' + f(c.margin_c80) + ' | ' + f(c.total_crps) + ' | ' + f(c.total_c80) + ' |');
    for (const [k, v] of Object.entries(ws.candidates)) L.push('| ' + k + ' | ' + v.n + ' | ' + f(v.log_loss, 5) + ' | ' + f(v.brier, 5) + ' | ' + f(v.margin_crps) + ' | ' + f(v.margin_mae, 3) + ' | ' + f(v.margin_c80) + ' | ' + f(v.total_crps) + ' | ' + f(v.total_c80) + ' |');
    L.push('\nPaired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):\n');
    L.push('| Versus | Log loss | Margin CRPS |\n|---|---|---|');
    for (const [k, v] of Object.entries(ws.comparisons)) L.push('| ' + k.replace('champion_candidate_vs_', '') + ' | ' + ci(v.log_loss) + ' | ' + ci(v.margin_crps) + ' |');
    L.push('');
  }
  L.push('## Upset Watch (policy ' + doc.upset_watch.policy_hash.slice(0, 12) + ', theta ' + doc.upset_watch.theta + ')\n');
  L.push('| Window | Games | Flagged | Coverage | Mean forecast | Realized | 95% CI |\n|---|---|---|---|---|---|---|');
  for (const k of ['development', 'confirmation', 'tournament_holdout_model_basis']) { const u = doc.upset_watch[k]; L.push('| ' + k + ' | ' + u.games + ' | ' + u.flagged + ' | ' + f(u.coverage) + ' | ' + f(u.mean_forecast) + ' | ' + f(u.realized_upset_rate) + ' | ' + (u.realized_ci95 || []).map((x) => f(x)).join('–') + ' |'); }
  const sb = doc.upset_watch.tournament_holdout_seed_basis; L.push('\nTournament holdout, seed basis: lower seed won ' + sb.lower_seed_won + ' of ' + sb.games + ' (' + f(sb.realized_rate) + ', 95% CI ' + (sb.ci95 || []).map((x) => f(x)).join('–') + '); mean forecast ' + f(sb.mean_forecast) + '.\n');
  L.push('## Tournament games vs neutral regular-season games (development tournaments)\n');
  const d = doc.tournament_domain_shift; L.push('NCAA tournament: n ' + d.ncaa_tournament_games.n + ', log loss ' + f(d.ncaa_tournament_games.log_loss, 5) + ', margin CRPS ' + f(d.ncaa_tournament_games.margin_crps) + '. Neutral regular season: n ' + d.neutral_regular_season.n + ', log loss ' + f(d.neutral_regular_season.log_loss, 5) + ', margin CRPS ' + f(d.neutral_regular_season.margin_crps) + '.\n');
  return L.join('\n') + '\n';
}

function check() {
  const sel = JSON.parse(fs.readFileSync(SEL.FILE, 'utf8')); if (SEL.selectionHash(sel) !== sel.hash) { console.error('selection_v1.json edited after freezing'); process.exit(1); }
  if (fs.existsSync(C.PATHS.upsetPolicy)) { const p = JSON.parse(fs.readFileSync(C.PATHS.upsetPolicy, 'utf8')); if (policyHash(p) !== p.hash) { console.error('upset_policy.json edited after freezing'); process.exit(1); } }
  const v = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (v.leakage.violations !== 0) { console.error('leakage violations in the validation record'); process.exit(1); }
  if (v.selection_hash !== sel.hash) { console.error('the validation record was built with another selection'); process.exit(1); }
  console.log('validation record ok: selection ' + sel.hash.slice(0, 12) + ', leakage 0, upset policy frozen');
}

module.exports = { policyHash, run, check };
if (require.main === module) { if (process.argv.includes('--check')) check(); else run(); }
