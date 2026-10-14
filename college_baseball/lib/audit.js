'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the adversarial model auditor (Phase 9).

   Its job is to find reasons NOT to trust the production model. Every check
   is executable, reads committed artifacts, states its threshold and its
   evidence, and returns PASS, WARN or FAIL. A FAIL on a CRITICAL check blocks
   promotion (audit.js); a WARN is shown on every price as a limitation.
   No text — human or model-written — can override a failed check: the
   summary is generated from the check results, never the other way round.

    1 LEAKAGE               no input known at/after the prediction; no implausible skill
    2 TIMESTAMPS            every warehouse row: blank known_at, availability the next day
    3 SOURCE_CONFLICTS      quarantined games never scored; conflict rate per season
    4 STARTERS              one starter per team-game; opener share; projection beats naive
    5 BULLPEN_ASSUMPTIONS   availability model calibrated out of sample
    6 GAME_RULES            R02 violations rare; extra innings without a runner; run rule by context
    7 CONFERENCE_BIAS       calibration-in-the-large per conference (Bonferroni)
    8 FAVOURITE_CALIBRATION by favourite tier
    9 HOME_FIELD_BIAS       home vs neutral calibration
   10 EARLY_SEASON          first three weeks: calibration slope and bias
   11 OVERFITTING           selection->validation gap vs baselines; holdout looks; grid edges
   12 MISSING_DATA          performance where inputs are thin (single-source rows, unknown starters)
   13 TAILS                 extreme scoring calibrated (total >= 20, side >= 15, shutouts)
   14 SIMULATION            simulator vs closed form; price coherence; Monte Carlo error
   15 STALENESS             data freshness relative to the board date
   16 DEGRADATION           chosen model vs best baseline, season by season
   17 ENSEMBLE_STABILITY    stacking weights across season blocks
   18 PROGRAM_ERRORS        per-program residuals beyond chance
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const W = require('./warehouse');
const V = require('../../engine/validation');
const REG = require('./registry');

const CRITICAL = new Set(['LEAKAGE', 'TIMESTAMPS', 'SOURCE_CONFLICTS', 'GAME_RULES', 'OVERFITTING', 'TAILS', 'SIMULATION']);
const r = V.r;

function readJson(f) { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function check(id, status, threshold, evidence, remediation) { return { id, critical: CRITICAL.has(id), status, threshold, evidence, remediation: status === 'PASS' ? null : remediation }; }

function oosRows() {
  const f = path.join(C.PATHS.validation, 'oos_team_predictions.csv.gz');
  if (!fs.existsSync(f)) return [];
  const { readCsv } = require('../../engine/csv');
  return readCsv(f).rows.map((x) => { const o = {}; for (const [k, v] of Object.entries(x)) o[k] = v === '' ? null : (isNaN(Number(v)) || k === 'game_id' || k === 'date' || k === 'window' ? v : Number(v)); return o; });
}

function run(o) {
  o = o || {};
  const wf = readJson(C.PATHS.walkforward); const pw = readJson(C.PATHS.pitcherEval); const dist = readJson(C.PATHS.distEval);
  const rules = readJson(path.join(C.PATHS.validation, 'rules_evidence.json')); const ml = readJson(path.join(C.PATHS.validation, 'ml_ensemble.json'));
  const sim = readJson(C.PATHS.simEval); const board = readJson(path.join(C.PATHS.BASE, 'board', 'index.json'));
  const tuning = readJson(path.join(C.PATHS.params, 'team_tuning.json'));
  const rows = oosRows();
  const chosen = wf && wf.selection.chosen; const pc = chosen ? 'p_' + chosen : null;
  const val = rows.filter((x) => x.window === 'VALIDATION' && x[pc] != null);
  const out = [];

  /* 1 LEAKAGE */
  {
    const leak = wf && wf.leakage;
    const best = wf ? Math.min(...Object.values(wf.windows_report.VALIDATION.models).map((m) => m.log_loss)) : null;
    const st = !leak ? 'FAIL' : !leak.ok ? 'FAIL' : best != null && best < 0.55 ? 'FAIL' : 'PASS';
    out.push(check('LEAKAGE', st, 'zero leakage violations; no VALIDATION log loss below 0.55 (implausible for single college games)', { checked: leak && leak.checked, violations: leak && leak.violations, best_validation_log_loss: best }, 'find the input that is known after prediction time'));
  }
  /* 2 TIMESTAMPS */
  {
    let bad = 0; let n = 0; const ex = [];
    for (let s = C.SEASONS.first; s <= C.SEASONS.last; s++) for (const g of W.games(s)) {
      n++;
      const okKnown = g.known_at == null; const avail = g.assumed_available_at; const expect = (() => { const d = new Date(g.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) + 'T06:00:00Z'; })();
      if (!okKnown || avail !== expect || g.pit !== 'RETRO') { bad++; if (ex.length < 5) ex.push(g.game_id); }
    }
    out.push(check('TIMESTAMPS', bad === 0 ? 'PASS' : 'FAIL', 'every row: known_at blank (never backdated), assumed_available_at = next day 06:00 UTC, pit = RETRO', { rows: n, violations: bad, examples: ex }, 'rebuild the warehouse; never write a known_at the source does not carry'));
  }
  /* 3 SOURCE_CONFLICTS */
  {
    const scoredConflict = []; const rate = {};
    const conflictIds = new Set();
    for (let s = C.SEASONS.first; s <= C.SEASONS.last; s++) { const gs = W.games(s); const c = gs.filter((g) => g.quality === 'CONFLICT'); rate[s] = r(c.length / Math.max(1, gs.length), 4); for (const g of c) conflictIds.add(g.game_id); }
    for (const x of rows) if (conflictIds.has(x.game_id)) scoredConflict.push(x.game_id);
    const worst = Math.max(...Object.values(rate));
    out.push(check('SOURCE_CONFLICTS', scoredConflict.length ? 'FAIL' : worst > 0.02 ? 'WARN' : 'PASS', 'no quarantined game scored or priced; conflict rate <= 2% per season (WARN above)', { scored_quarantined: scoredConflict.length, conflict_rate_by_season: rate }, 'exclude CONFLICT rows; resolve with a third source'));
  }
  /* 4 STARTERS */
  {
    let multi = 0; let none = 0; let tg = 0; let openers = 0;
    for (const s of [2024, 2025, 2026]) {
      const by = new Map(); for (const p of W.pitchers(s)) { const k = p.game_id + '|' + p.side; if (!by.has(k)) by.set(k, 0); if (p.starter) by.set(k, by.get(k) + 1); }
      for (const v of by.values()) { tg++; if (v > 1) multi++; if (v === 0) none++; }
      for (const t of W.teamGames(s)) if (t.starter_outs != null && t.starter_outs <= 3) openers++;
    }
    const sp = pw && pw.starter_projection && pw.starter_projection.SELECTION;
    const acc = sp && sp.all ? sp.all.top1_accuracy : null;
    const st = multi || none > tg * 0.01 ? 'FAIL' : acc == null ? 'WARN' : acc < 0.4 ? 'WARN' : 'PASS';
    out.push(check('STARTERS', st, 'exactly one starter per team-game; projection top-1 accuracy >= 0.40 on SELECTION (WARN below)', { team_games: tg, with_two_starters: multi, with_no_starter: none, starters_with_3_outs_or_fewer: openers, projection_top1_accuracy_2025: acc, projection_by_status: sp && sp.by_status }, 'check the box-score starter convention against play-by-play'));
  }
  /* 5 BULLPEN */
  {
    const cal = pw && pw.availability_calibration;
    const st = !cal ? 'WARN' : Math.abs(cal.citl) <= 0.02 ? 'PASS' : 'WARN';
    out.push(check('BULLPEN_ASSUMPTIONS', st, 'reliever availability model: |mean p - mean y| <= 0.02 out of sample (2025)', cal || { missing: 'pitcher_walkforward availability calibration' }, 'refit the availability model; widen the workload features'));
  }
  /* 6 GAME_RULES */
  {
    const h = rules && rules.home_not_batting_when_leading; const x = rules && rules.extra_inning_runs; const rr = rules && rules.run_rule;
    const viol = h ? h.runs_scored_violation / Math.max(1, h.leading_after_top_of_last) : 1;
    const runner = x ? x.mean - x.regulation_mean > 0.35 : true;
    const tourneyRR = rr && rr.ncaa_tourney ? rr.ncaa_tourney.stopped / Math.max(1, rr.ncaa_tourney.eligible) : null;
    const st = !rules ? 'FAIL' : viol > 0.01 || runner ? 'FAIL' : 'PASS';
    out.push(check('GAME_RULES', st, 'R02 runs-scored violations <= 1% of eligible games; extra-inning scoring inconsistent with an automatic runner; run rule applied by measured context only', { r02_violation_rate: r(viol, 4), extra_mean: x && x.mean, regulation_mean: x && x.regulation_mean, ncaa_tourney_run_rule_rate: tourneyRR, seven_inning_dh_share: rules && rules.seven_inning_share && rules.seven_inning_share.dh }, 'audit the innings lines and the rules registry'));
  }
  /* 7-10, 12, 16, 18 on VALIDATION rows */
  const cal = (rs) => { const b = V.binary(rs.map((x) => ({ p: x[pc], y: x.y }))); return { n: b.n, citl: b.calibration_in_the_large, slope: b.calibration_slope, log_loss: b.log_loss, se: b.n ? Math.sqrt(b.mean_y * (1 - b.mean_y) / b.n) : null }; };
  if (val.length) {
    /* 7 conference bias */
    const gm = new Map(); for (let s = 2023; s <= 2024; s++) for (const g of W.games(s)) gm.set(g.game_id, g);
    const byConf = new Map(); for (const x of val) { const g = gm.get(x.game_id); const c = g && g.home_conf; if (!c) continue; if (!byConf.has(c)) byConf.set(c, []); byConf.get(c).push(x); }
    const confs = [...byConf.entries()].filter(([, xs]) => xs.length >= 300);
    const z = 3.0;   // ~Bonferroni for ~30 conferences at 5%
    const flagged = []; const table = {};
    for (const [c, xs] of confs) { const m = cal(xs); table[c] = { n: m.n, citl: m.citl }; if (Math.abs(m.citl) > z * m.se + 0.01) flagged.push(c); }
    out.push(check('CONFERENCE_BIAS', flagged.length ? 'WARN' : 'PASS', '|CITL| per home conference within 3 standard errors + 0.01 (n >= 300)', { conferences: confs.length, flagged, table }, 'look for a conference-level rating bias; check non-conference connectivity'));
    /* 8 favourites */
    const tiers = { heavy: val.filter((x) => Math.max(x[pc], 1 - x[pc]) >= 0.75), moderate: val.filter((x) => { const f = Math.max(x[pc], 1 - x[pc]); return f >= 0.6 && f < 0.75; }), tossup: val.filter((x) => Math.max(x[pc], 1 - x[pc]) < 0.6) };
    const fav = Object.fromEntries(Object.entries(tiers).map(([k, xs]) => {
      /* calibration of the favourite's probability, not the home side's */
      const fx = xs.map((x) => (x[pc] >= 0.5 ? { p: x[pc], y: x.y } : { p: 1 - x[pc], y: 1 - x.y }));
      const b = V.binary(fx); return [k, { n: b.n, mean_p: b.mean_p, observed: b.mean_y, citl: b.calibration_in_the_large }];
    }));
    const favBad = Object.values(fav).some((t) => t.n >= 500 && Math.abs(t.citl) > 0.025);
    out.push(check('FAVOURITE_CALIBRATION', favBad ? 'WARN' : 'PASS', '|favourite p - observed| <= 0.025 in each tier with n >= 500', fav, 'recalibrate by favourite strength'));
    /* 9 home field */
    const home = cal(val.filter((x) => !x.neutral)); const neu = cal(val.filter((x) => x.neutral));
    out.push(check('HOME_FIELD_BIAS', Math.abs(home.citl) > 0.02 || (neu.n >= 300 && Math.abs(neu.citl) > 0.03) ? 'WARN' : 'PASS', '|CITL| <= 0.02 for home games, <= 0.03 for neutral (n >= 300)', { home, neutral: neu }, 'refit home advantage; check neutral-site orientation'));
    /* 10 early season */
    const early = cal(val.filter((x) => { const d = (Date.parse(x.date) - Date.parse(x.season + '-02-10')) / 864e5; return d < 21; }));
    out.push(check('EARLY_SEASON', early.slope != null && (early.slope < 0.8 || Math.abs(early.citl) > 0.03) ? 'WARN' : 'PASS', 'first three weeks: calibration slope >= 0.80 (not overconfident), |CITL| <= 0.03', early, 'widen early-season uncertainty; revisit the carryover prior'));
    /* 12 missing data */
    const gq = (x) => { const g = gm.get(x.game_id); return g ? g.quality : null; };
    const single = cal(val.filter((x) => /^SINGLE_SOURCE/.test(gq(x) || ''))); const multi = cal(val.filter((x) => /^VERIFIED/.test(gq(x) || '')));
    const pwStatus = pw && pw.windows_report && pw.windows_report.SELECTION && pw.windows_report.SELECTION.by_starter_status;
    out.push(check('MISSING_DATA', single.n >= 200 && single.log_loss - multi.log_loss > 0.03 ? 'WARN' : 'PASS', 'single-source games no worse than verified games by > 0.03 log loss (n >= 200)', { single_source: single, verified: multi, by_starter_status_2025: pwStatus }, 'downgrade single-source games; seek a second source'));
    /* 18 program errors */
    const team = new Map();
    for (const x of val) { const g = gm.get(x.game_id); if (!g) continue; for (const [id, y, p] of [[g.home_id, x.y, x[pc]], [g.away_id, 1 - x.y, 1 - x[pc]]]) { if (!team.has(id)) team.set(id, { n: 0, res: 0, v: 0 }); const t = team.get(id); t.n++; t.res += y - p; t.v += p * (1 - p); } }
    const zs = [...team.entries()].filter(([, t]) => t.n >= 20).map(([id, t]) => ({ id, n: t.n, z: t.res / Math.sqrt(t.v) }));
    const extreme = zs.filter((t) => Math.abs(t.z) > 3.5);
    out.push(check('PROGRAM_ERRORS', extreme.length > Math.max(1, Math.round(zs.length * 0.002)) ? 'WARN' : 'PASS', 'programs with |z| > 3.5 no more than chance (~0.05% each)', { programs: zs.length, extreme: extreme.map((t) => ({ id: t.id, n: t.n, z: r(t.z, 2) })) }, 'look for a program-specific data or rating error'));
  } else out.push(check('CONFERENCE_BIAS', 'FAIL', 'requires the walk-forward record', {}, 'run college_baseball/walkforward.js'));
  /* 11 overfitting */
  {
    const looks = {}; for (const rec of REG.readAll()) if (rec.holdout_evaluated) looks[rec.family] = (looks[rec.family] || 0) + 1;
    const tooMany = Object.entries(looks).filter(([, n]) => n > REG.MAX_HOLDOUT_LOOKS);
    let gap = null; let baseGap = null;
    if (wf) { const s = wf.windows_report.SELECTION.models; const v = wf.windows_report.VALIDATION.models; gap = r(v[chosen].log_loss - s[chosen].log_loss, 5); const bb = wf.selection.best_baseline; baseGap = r(v[bb].log_loss - s[bb].log_loss, 5); }
    const edges = [];
    const grids = require('../walkforward').GRIDS;
    if (tuning) for (const [m, t] of Object.entries(tuning.models || {})) for (const [k, v] of Object.entries(t.cfg || {})) { const g = grids[m] && grids[m][k]; if (g && (v === g[0] || v === g[g.length - 1])) edges.push(`${m}.${k}=${v}`); }
    const st = tooMany.length || (gap != null && baseGap != null && gap - baseGap > 0.005) ? 'FAIL' : edges.length ? 'WARN' : 'PASS';
    out.push(check('OVERFITTING', st, 'chosen model\'s SELECTION->VALIDATION log-loss gap no worse than the best baseline\'s by > 0.005; <= 3 holdout looks per family; tuned values on a grid edge WARN', { selection_to_validation_gap: gap, baseline_gap: baseGap, holdout_looks: looks, grid_edges: edges }, 'simplify; stop looking at the holdout; extend grids'));
  }
  /* 13 tails */
  {
    const t = dist && dist.scores && dist.scores.VALIDATION && dist.scores.VALIDATION[dist.chosen] && dist.scores.VALIDATION[dist.chosen].tails;
    const bad = !t ? true : Math.abs(t.p_total_ge_20 - t.obs_total_ge_20) > Math.max(0.01, 0.15 * t.obs_total_ge_20) || Math.abs(t.p_side_ge_15 - t.obs_side_ge_15) > Math.max(0.01, 0.15 * t.obs_side_ge_15) || Math.abs(t.p_shutout - t.obs_shutout) > Math.max(0.01, 0.15 * t.obs_shutout);
    const cov = dist && dist.scores && dist.scores.VALIDATION[dist.chosen] && dist.scores.VALIDATION[dist.chosen].total_coverage_80;
    out.push(check('TAILS', bad ? 'FAIL' : cov != null && (cov < 0.77 || cov > 0.83) ? 'WARN' : 'PASS', 'P(total >= 20), P(side >= 15), P(shutout) within max(0.01, 15% relative) of observed on VALIDATION; 80% total interval covers 77-83% (WARN outside)', { tails: t, total_coverage_80: cov, family: dist && dist.chosen }, 'refit the dispersion; consider a mixture tail'));
  }
  /* 14 simulation */
  {
    const st = !sim ? 'WARN' : sim.mean_abs_diff_p_home > 0.03 || sim.max_mc_se > 0.01 || (sim.coherence_failures || 0) > 0 ? 'FAIL' : 'PASS';
    const bc = board && board.coherence_failures;
    out.push(check('SIMULATION', bc ? 'FAIL' : st, 'simulator vs closed form: mean |dP(home)| <= 0.03; Monte Carlo SE <= 0.01; zero incoherent prices on the board', { simulator: sim && { n: sim.n, mean_abs_diff_p_home: sim.mean_abs_diff_p_home, max_mc_se: sim.max_mc_se, convergence: sim.convergence }, board_coherence_failures: bc == null ? null : bc }, 'recalibrate the simulator frailty; fix the incoherent market'));
  }
  /* 15 staleness */
  {
    const man = []; for (let s = C.SEASONS.last - 1; s <= C.SEASONS.last; s++) { const rep = W.report(s); if (rep) man.push({ season: s, built_at: rep.built_at }); }
    const latest = man.map((m) => Date.parse(m.built_at)).sort().pop();
    const ageDays = latest ? (Date.now() - latest) / 864e5 : null;
    const inSeason = C.inSeasonMonth(new Date().toISOString().slice(0, 10));
    const st = ageDays == null ? 'FAIL' : inSeason && ageDays > 2 ? 'FAIL' : ageDays > 30 ? 'WARN' : 'PASS';
    out.push(check('STALENESS', st, 'in season: warehouse rebuilt within 2 days (FAIL); off season: within 30 days (WARN)', { latest_build: latest ? new Date(latest).toISOString() : null, age_days: ageDays == null ? null : r(ageDays, 2), in_season: inSeason, board_mode: board && board.mode }, 'run the daily build'));
  }
  /* 16 degradation */
  {
    const bySeason = {}; let worse = 0;
    if (rows.length && wf) {
      const bb = 'p_' + wf.selection.best_baseline;
      for (const s of [...new Set(rows.map((x) => x.season))].sort()) {
        const xs = rows.filter((x) => x.season === s && x[pc] != null && x[bb] != null && x.window !== 'HOLDOUT');
        if (!xs.length) continue;
        const a = xs.reduce((t, x) => t + V.logLoss(x[pc], x.y), 0) / xs.length; const b = xs.reduce((t, x) => t + V.logLoss(x[bb], x.y), 0) / xs.length;
        bySeason[s] = { n: xs.length, chosen: r(a, 5), baseline: r(b, 5), diff: r(a - b, 5) }; if (a > b) worse++;
      }
    }
    const recent = Object.values(bySeason).slice(-2);
    out.push(check('DEGRADATION', recent.length && recent.every((x) => x.diff > 0) ? 'FAIL' : worse > 2 ? 'WARN' : 'PASS', 'the chosen model must not trail the best baseline in the two latest non-holdout seasons (FAIL) or in more than two seasons (WARN)', bySeason, 'investigate drift; refit'));
  }
  /* 17 ensemble */
  {
    const spread = ml && ml.ensemble && ml.ensemble.weight_spread_across_blocks;
    const maxSpread = spread ? Math.max(...Object.values(spread)) : null;
    const adopted = ml && ml.decisions && ml.decisions.ensemble === 'ADOPT';
    out.push(check('ENSEMBLE_STABILITY', maxSpread == null ? 'WARN' : maxSpread > 0.6 ? (adopted ? 'FAIL' : 'WARN') : 'PASS', 'stacking weights move by <= 0.6 between season blocks (FAIL if the ensemble is adopted and unstable)', { adopted, weight_spread: spread, block_weights: ml && ml.ensemble.block_weights }, 'do not adopt an unstable ensemble'));
  }
  /* registry integrity */
  const regv = REG.verify();
  out.push(check('REGISTRY_INTEGRITY', regv.ok ? 'PASS' : 'FAIL', 'the experiment registry hash chain is intact', regv, 'an experiment record was edited or deleted; restore it from git'));
  CRITICAL.add('REGISTRY_INTEGRITY');
  out[out.length - 1].critical = true;
  const critFail = out.filter((c) => c.critical && c.status === 'FAIL').map((c) => c.id);
  const summary = `${out.filter((c) => c.status === 'PASS').length} PASS, ${out.filter((c) => c.status === 'WARN').length} WARN, ${out.filter((c) => c.status === 'FAIL').length} FAIL` + (critFail.length ? `; promotion BLOCKED by ${critFail.join(', ')}` : '; no critical failure');
  return { schema: 'edgedesk_cbase_audit_v1', model_version: C.MODEL_VERSION, chosen, checks: out, critical_failures: critFail, promotion_allowed: critFail.length === 0, summary };
}

module.exports = { run, CRITICAL };
