'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the pitcher-aware walk-forward (Models 7, and
   the starter-projection test of Phase 7).

     node college_baseball/pitcher_walkforward.js              FIT 2024, SELECTION 2025
     node college_baseball/pitcher_walkforward.js --holdout    + HOLDOUT 2026 (registered)

   Windows (research/PROTOCOL.md §2): box scores exist for 2024-2026 only.
     FIT 2024        pitching linear weights, reliever availability logit,
                     starter-projection logit and the hybrid elasticities
     SELECTION 2025  every variant scored; the chosen one is decided here
     HOLDOUT 2026    reported once per model version

   VARIANTS (each starts from the team model's out-of-sample run expectations,
   validation cache of college_baseball/walkforward.js):
     team            the team model alone
     bullpen         + bullpen availability today
     starter_proj    + the projected starter as a probability mixture
     hybrid_proj     + both (what EdgeDesk can know before a game)
     hybrid_oracle   + both, with the starter who actually started — the
                     "confirmed starter" scenario; it is NOT a pregame-available
                     model and is never chosen, it measures what confirmation is worth

   Adjustment: a staff's expected run value per batter today
        rv_game = s * rv(starter) + (1 - s) * rv(available bullpen)
   relative to the run value the team has actually been pitching with this
   season (BF-weighted), raised to an elasticity fitted on FIT:
        runs allowed x (rv_game / rv_season)^beta
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./lib/warehouse');
const PI = require('./lib/pitchers');
const D = require('./lib/distribution');
const TQ = require('./lib/team_quality');
const V = require('../engine/validation');
const P = require('../engine/lab/protocol');
const REG = require('./lib/registry');
const K = require('./ingest/common');
const WF = require('./walkforward');

const WIN = C.WINDOWS.pitcher;
const SCHEMA = 'edgedesk_cbase_pitcher_walkforward_v1';
const VARIANTS = ['team', 'bullpen', 'starter_proj', 'hybrid_proj', 'hybrid_oracle'];
const PREGAME = ['team', 'bullpen', 'starter_proj', 'hybrid_proj'];

function flag(n) { return process.argv.includes('--' + n); }
const r = V.r;

function teamRows() {
  if (!fs.existsSync(WF.ROWS_FILE)) throw new Error('run college_baseball/walkforward.js first (it writes the team model cache)');
  /* the team model's RUN-SPACE CALIBRATED expectations (fitted on earlier seasons only) are the base every variant adjusts */
  const m = new Map();
  for (const x of JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8'))) {
    if (x.season < WIN.burn_in[0]) continue;
    if (x.hier_cal_lh != null) { x.hier_lh_raw = x.hier_lh; x.hier_la_raw = x.hier_la; x.hier_lh = x.hier_cal_lh; x.hier_la = x.hier_cal_la; }
    m.set(x.game_id, x);
  }
  return m;
}

/* the run value a team's staff has pitched with this season (BF-weighted, current talent estimates) */
function seasonStaffRv(state, team, season) {
  const t = state.team.get(team); if (!t) return null;
  let w = 0; let s = 0;
  for (let i = t.apps.length - 1; i >= 0; i--) {
    const a = t.apps[i]; if (a.season !== season) break;
    const tal = state.talent(a.person, season); if (tal.rv_per_bf == null) continue;
    w += a.bf; s += a.bf * tal.rv_per_bf;
  }
  if (w < 60) {   // early season: fall back to last season's staff, then the league
    for (let i = t.apps.length - 1; i >= 0 && w < 300; i--) { const a = t.apps[i]; if (a.season === season) continue; const tal = state.talent(a.person, season); if (tal.rv_per_bf == null) continue; w += a.bf; s += a.bf * tal.rv_per_bf; }
  }
  return w ? s / w : null;
}

/* the staff scenario for one side: starter distribution and bullpen */
function staffToday(state, team, season, g, starterActual) {
  const proj = state.projectStarter(team, season, g.date, g);
  const pen = state.bullpen(team, season);
  const avg = seasonStaffRv(state, team, season);
  const scenarios = [];
  const generic = { rv: avg, outs: state.o.starter_outs_mean };
  for (const c of proj.candidates.slice(0, 3)) { const t = state.talent(c.person, season); scenarios.push({ person: c.person, p: c.p, rv: t.rv_per_bf, outs: t.exp_outs_start }); }
  const covered = scenarios.reduce((a, x) => a + x.p, 0);
  if (1 - covered > 1e-6) scenarios.push({ person: null, p: 1 - covered, rv: generic.rv, outs: generic.outs });
  let oracle = null;
  if (starterActual) { const t = state.talent(starterActual, season); oracle = { person: starterActual, p: 1, rv: t.rv_per_bf, outs: t.exp_outs_start }; }
  const actualRank = starterActual ? proj.candidates.findIndex((c) => c.person === starterActual) : -1;
  return { proj, pen, avg, scenarios, oracle, actualRank };
}

/* multiplier on the opponent's runs given a staff scenario */
function staffFactor(sc, staff, beta, useStarter, useBullpen, innings) {
  if (!staff.avg) return 1;
  const s = Math.min(0.85, Math.max(0.15, (sc && sc.outs != null ? sc.outs : 12.5) / (3 * innings)));
  const rvS = useStarter && sc && sc.rv != null ? sc.rv : staff.avg;
  const rvB = useBullpen && staff.pen.rv_available != null ? staff.pen.rv_available : (staff.pen.rv_normal != null ? staff.pen.rv_normal : staff.avg);
  const rvNoPen = staff.pen.rv_normal != null ? staff.pen.rv_normal : staff.avg;
  const game = s * rvS + (1 - s) * (useBullpen ? rvB : rvNoPen);
  const base = s * staff.avg + (1 - s) * rvNoPen;
  return Math.pow(Math.max(0.2, game / Math.max(1e-3, base)), beta);
}

function pHome(lh, la, sd, spec, constants) { const f = D.pHomeTable(spec, constants); return TQ.integrate(lh, la, sd, f); }

function variantProb(v, x, H, A, beta, spec, constants) {
  const inn = 9;
  const useB = v === 'bullpen' || v === 'hybrid_proj' || v === 'hybrid_oracle';
  const useS = v === 'starter_proj' || v === 'hybrid_proj' || v === 'hybrid_oracle';
  if (v === 'team') return { p: pHome(x.hier_lh, x.hier_la, x.hier_sd, spec, constants), lh: x.hier_lh, la: x.hier_la };
  const hs = v === 'hybrid_oracle' ? (H.oracle ? [H.oracle] : H.scenarios) : (useS ? H.scenarios : [null]);
  const as = v === 'hybrid_oracle' ? (A.oracle ? [A.oracle] : A.scenarios) : (useS ? A.scenarios : [null]);
  let p = 0; let elh = 0; let ela = 0; let wsum = 0;
  for (const h of hs) for (const a of as) {
    const w = (h ? h.p : 1) * (a ? a.p : 1); if (w < 1e-4) continue;
    const la = x.hier_la * staffFactor(h, H, beta.starter, useS, useB, inn);   // home staff limits away runs
    const lh = x.hier_lh * staffFactor(a, A, beta.starter, useS, useB, inn);
    p += w * pHome(lh, la, x.hier_sd, spec, constants); elh += w * lh; ela += w * la; wsum += w;
  }
  return { p: p / wsum, lh: elh / wsum, la: ela / wsum };
}

/* ---------------------------------------------------------------- fitted pieces, for the slate */
function fitModels() {
  const fitSeason = WIN.burn_in[0];
  const fitGames = W.results(fitSeason, fitSeason);
  const lw = PI.fitPitchingWeights(W.teamGames(fitSeason));
  const s1 = new PI.PitchingState().load([fitSeason]); s1.lw = lw;
  const avail = PI.fitAvailability(s1, fitSeason, fitGames);
  const s2 = new PI.PitchingState().load([fitSeason]); s2.lw = lw;
  const proj = PI.fitProjection(s2, fitSeason, fitGames);
  const rep = fs.existsSync(C.PATHS.pitcherEval) ? JSON.parse(fs.readFileSync(C.PATHS.pitcherEval, 'utf8')) : null;
  const beta = rep ? rep.fitted_on_fit_season.elasticity : { starter: 1 };
  return { lw, avail, proj, beta, chosen: rep ? rep.selection.chosen : 'team', accepted: rep ? rep.selection.chosen !== 'team' : false };
}

/* ---------------------------------------------------------------- run */
function run(o) {
  o = o || {};
  const rows = teamRows();
  const constants = WF.constants();
  const tun = WF.tuning(); const spec = tun.dist || { family: 'nb', r: 4 };
  const fitSeason = WIN.burn_in[0];
  const games = W.results(fitSeason, WIN.holdout[1]);
  const starterOf = new Map(); for (let s = fitSeason; s <= WIN.holdout[1]; s++) for (const p of W.pitchers(s)) if (p.starter && p.person_id) starterOf.set(p.game_id + '|' + p.team_id, p.person_id);

  /* FIT: linear weights, availability, projection on 2024 */
  const lw = PI.fitPitchingWeights(W.teamGames(fitSeason));
  const fitState = new PI.PitchingState().load([fitSeason]); fitState.lw = lw;
  const fitGames = games.filter((g) => g.season === fitSeason);
  const avail = PI.fitAvailability(fitState, fitSeason, fitGames);
  const projState = new PI.PitchingState().load([fitSeason]); projState.lw = lw;
  const proj = PI.fitProjection(projState, fitSeason, fitGames);

  /* the evaluation pass: one causal state over 2024-2026 */
  const state = new PI.PitchingState().load([fitSeason, WIN.selection[0], WIN.holdout[0]]);
  state.lw = lw; state.avail = avail.beta; state.proj = { cand: proj.cand, unseen: proj.unseen };
  const scored = []; const projEval = []; const availEval = [];
  const reliefOn = new Map(); for (const s2 of [WIN.selection[0]]) for (const p of W.pitchers(s2)) if (!p.starter && p.person_id) { const k = p.team_id + '|' + p.date; if (!reliefOn.has(k)) reliefOn.set(k, new Set()); reliefOn.get(k).add(p.person_id); }
  for (const g of games) {
    state.advance(g.date);
    if (g.season === WIN.selection[0]) for (const team of [g.home_id, g.away_id]) {
      const used = reliefOn.get(team + '|' + g.date) || new Set();
      for (const rv of state.relievers(team, g.season)) availEval.push({ p: state.pAppear(rv.person, rv.usage_share), y: used.has(rv.person) ? 1 : 0 });
    }
    const x = rows.get(g.game_id); if (!x || x.hier_lh == null) continue;
    const H = staffToday(state, g.home_id, g.season, g, starterOf.get(g.game_id + '|' + g.home_id));
    const A = staffToday(state, g.away_id, g.season, g, starterOf.get(g.game_id + '|' + g.away_id));
    for (const [side, st] of [['H', H], ['A', A]]) {
      const actual = starterOf.get(g.game_id + '|' + (side === 'H' ? g.home_id : g.away_id)); if (!actual) continue;
      const pc = st.proj.candidates.find((c) => c.person === actual);
      projEval.push({ season: g.season, date: g.date, weekday: g.weekday, status: st.proj.status, top_p: st.proj.top_p, top_correct: st.proj.candidates[0] && st.proj.candidates[0].person === actual ? 1 : 0, p_actual: pc ? pc.p : st.proj.p_unseen, unseen: pc ? 0 : 1 });
    }
    scored.push({ g, x, H, A });
  }

  /* FIT the elasticity on 2024 by grid on log loss of the hybrid with the actual starter (the effect size, not a selection) */
  const fitRows = scored.filter((s) => s.g.season === fitSeason);
  let bestBeta = { starter: 0, ll: Infinity };
  for (const b of [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]) {
    let ll = 0; for (const s of fitRows) { const v = variantProb('hybrid_oracle', s.x, s.H, s.A, { starter: b }, spec, constants); ll += V.logLoss(v.p, s.x.y); }
    ll /= Math.max(1, fitRows.length);
    if (ll < bestBeta.ll) bestBeta = { starter: b, ll };
  }
  const beta = { starter: bestBeta.starter };

  /* score every variant */
  const out = [];
  for (const s of scored) {
    const row = { game_id: s.g.game_id, season: s.g.season, date: s.g.date, weekday: s.g.weekday, y: s.x.y, home_runs: s.g.home_runs, away_runs: s.g.away_runs, neutral: s.g.neutral,
      status_home: s.H.proj.status, status_away: s.A.proj.status, p: {}, lh: {}, la: {}, depletion_home: s.H.pen.depletion, depletion_away: s.A.pen.depletion };
    for (const v of VARIANTS) { const res = variantProb(v, s.x, s.H, s.A, beta, spec, constants); row.p[v] = res.p; row.lh[v] = res.lh; row.la[v] = res.la; }
    out.push(row);
  }
  const ab = V.binary(availEval);
  const availability_calibration = { season: WIN.selection[0], n: ab.n, mean_p: ab.mean_p, mean_y: ab.mean_y, citl: ab.calibration_in_the_large, slope: ab.calibration_slope, log_loss: ab.log_loss, climatology_log_loss: ab.climatology.log_loss };
  return { rows: out, projEval, lw, avail, proj, beta, bestBeta, spec, availability_calibration };
}

function totalsScore(rows, v, spec) {
  let ls = 0; for (const x of rows) { ls += D.logScore(D.marginal(x.lh[v], spec), x.home_runs) + D.logScore(D.marginal(x.la[v], spec), x.away_runs); }
  return r(ls / (2 * rows.length), 5);
}

function projSummary(rs) {
  const by = (fn) => { const m = {}; for (const x of rs) { const k = fn(x); if (!m[k]) m[k] = []; m[k].push(x); } return Object.fromEntries(Object.entries(m).map(([k, xs]) => [k, { n: xs.length, top1_accuracy: r(xs.reduce((a, x) => a + x.top_correct, 0) / xs.length, 4), mean_top_p: r(xs.reduce((a, x) => a + x.top_p, 0) / xs.length, 4), log_loss: r(xs.reduce((a, x) => a - Math.log(Math.max(1e-6, x.p_actual)), 0) / xs.length, 4), unseen_share: r(xs.reduce((a, x) => a + x.unseen, 0) / xs.length, 4) }])); };
  return { all: by(() => 'all').all, by_status: by((x) => x.status), by_day: by((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.weekday]) };
}

function report(res, o) {
  const windows = { FIT: [WIN.burn_in[0]], SELECTION: [WIN.selection[0]] }; if (o.holdout) windows.HOLDOUT = [WIN.holdout[0]];
  const rep = { schema: SCHEMA, model_version: C.MODEL_VERSION, point_in_time: 'RETROSPECTIVE', protocol: 'college_baseball/research/PROTOCOL.md', windows: WIN,
    fitted_on_fit_season: { pitching_linear_weights: res.lw, availability: { beta: res.avail.beta.map((b) => r(b, 4)), n: res.avail.n, base_rate: r(res.avail.base_rate, 4), features: ['intercept', 'BF yesterday/10', 'BF last 3 days/20', '2+ consecutive days', 'days since last (cap 7)/7', 'usage share'] },
      starter_projection: { beta: res.proj.cand.map((b) => r(b, 4)), unseen: r(res.proj.unseen, 4), n: res.proj.n, features: ['rest 5-9 days', 'rest <= 3 days', 'started exactly 7 days ago', 'started on this weekday', 'share of recent starts', 'light relief work in last 2 days'] },
      elasticity: res.beta, elasticity_fit_ll: r(res.bestBeta.ll, 5) },
    availability_calibration: res.availability_calibration,
    distribution: res.spec, variants: VARIANTS, pregame_variants: PREGAME, windows_report: {}, starter_projection: {}, market: P.MARKET_NOT_TESTED };
  for (const [w, seasons] of Object.entries(windows)) {
    const rs = res.rows.filter((x) => seasons.includes(x.season));
    const m = {}; for (const v of VARIANTS) { const b = V.binary(rs.map((x) => ({ p: x.p[v], y: x.y }))); m[v] = { n: b.n, log_loss: b.log_loss, brier: b.brier, citl: b.calibration_in_the_large, slope: b.calibration_slope, team_runs_log_score: totalsScore(rs, v, res.spec) }; }
    const cmp = (a, b) => P.compare(rs.map((x) => ({ date: x.date, p: x.p, y: x.y })), (x) => V.logLoss(x.p[a], x.y), (x) => V.logLoss(x.p[b], x.y));
    const byStatus = {};
    for (const st of ['PROJECTED', 'UNKNOWN']) {
      const sub = rs.filter((x) => (x.status_home === st && x.status_away === st));
      if (sub.length) byStatus['both_' + st] = Object.fromEntries(['team', 'hybrid_proj', 'hybrid_oracle'].map((v) => [v, { n: sub.length, log_loss: V.binary(sub.map((x) => ({ p: x.p[v], y: x.y }))).log_loss }]));
    }
    const day = { weekend: rs.filter((x) => [5, 6, 0].includes(x.weekday)), midweek: rs.filter((x) => ![5, 6, 0].includes(x.weekday)) };
    rep.windows_report[w] = { seasons, n: rs.length, models: m,
      comparisons: { hybrid_proj_vs_team: cmp('hybrid_proj', 'team'), bullpen_vs_team: cmp('bullpen', 'team'), starter_proj_vs_team: cmp('starter_proj', 'team'), oracle_vs_proj: cmp('hybrid_oracle', 'hybrid_proj') },
      by_starter_status: byStatus,
      by_day: Object.fromEntries(Object.entries(day).map(([k, xs]) => [k, Object.fromEntries(['team', 'hybrid_proj', 'hybrid_oracle'].map((v) => [v, { n: xs.length, log_loss: V.binary(xs.map((x) => ({ p: x.p[v], y: x.y }))).log_loss }]))])) };
    rep.starter_projection[w] = projSummary(res.projEval.filter((x) => seasons.includes(x.season)));
  }
  const sel = rep.windows_report.SELECTION.models;
  rep.selection = { log_loss: Object.fromEntries(PREGAME.map((v) => [v, sel[v].log_loss])), chosen: P.choose(Object.fromEntries(PREGAME.map((v) => [v, sel[v].log_loss])), PREGAME), rule: 'pregame variants only; the oracle is a measurement, never a candidate' };
  return rep;
}

function main() {
  const t0 = Date.now();
  const res = run({});
  const rep = report(res, { holdout: flag('holdout') });
  rep.generated_at = new Date().toISOString(); rep.seconds = Math.round((Date.now() - t0) / 1000);
  K.writeJson(C.PATHS.pitcherEval, rep);
  for (const [w, x] of Object.entries(rep.windows_report)) {
    console.log(w, 'n', x.n);
    for (const v of VARIANTS) console.log('  ' + v.padEnd(14), JSON.stringify(x.models[v]));
    console.log('  hybrid_proj vs team', JSON.stringify(x.comparisons.hybrid_proj_vs_team));
    console.log('  starter projection', JSON.stringify(rep.starter_projection[w].all), JSON.stringify(rep.starter_projection[w].by_status));
  }
  console.log('chosen', rep.selection.chosen, 'elasticity', JSON.stringify(rep.fitted_on_fit_season.elasticity));
  const sel = rep.windows_report.SELECTION;
  REG.register({
    id: 'CBX-PITCHER-HYBRID', family: 'pitcher_hybrid', title: 'Pitcher-aware hybrid (starter projection + bullpen availability) vs team model',
    hypothesis: 'Adjusting the team model for the projected starter and today\'s available bullpen lowers moneyline log loss on SELECTION 2025',
    dataset: { warehouse: 'college_baseball/data', seasons: [2024, 2026] },
    windows: { training: [2024, 2024], validation: [2025, 2025], holdout: flag('holdout') ? [2026, 2026] : null },
    features: ['team model run expectations', 'shrunk pitcher components (K, BB+HBP, HR, H)', 'starter outing length', 'reliever availability from workload', 'starter projection logit'],
    algorithm: { name: 'multiplicative staff adjustment, elasticity fitted on 2024', elasticity: rep.fitted_on_fit_season.elasticity, distribution: res.spec }, seeds: [20261013],
    metrics: Object.fromEntries(Object.entries(sel.models).map(([k, v]) => [k, v.log_loss])),
    uncertainty: { hybrid_proj_vs_team: sel.comparisons.hybrid_proj_vs_team, oracle_vs_proj: sel.comparisons.oracle_vs_proj },
    decision: sel.comparisons.hybrid_proj_vs_team.a_better ? 'ACCEPT' : 'REJECT',
    justification: sel.comparisons.hybrid_proj_vs_team.a_better ? 'block-bootstrap 95% interval of the log-loss difference vs the team model is wholly below zero on SELECTION' : 'the interval of the improvement vs the team model is not wholly below zero on SELECTION; the team model stays the price',
    holdout_evaluated: flag('holdout'),
  });
  if (flag('holdout')) {
    const h = rep.windows_report.HOLDOUT;
    REG.register({ id: 'CBX-PITCHER-HYBRID-HOLDOUT', family: 'pitcher_hybrid', title: 'Pitcher-aware hybrid on HOLDOUT 2026', hypothesis: 'The SELECTION result holds on the untouched 2026 season',
      dataset: { warehouse: 'college_baseball/data', seasons: [2024, 2026] }, windows: { training: [2024, 2025], validation: [2025, 2025], holdout: [2026, 2026] }, features: ['as CBX-PITCHER-HYBRID'],
      algorithm: { name: 'as CBX-PITCHER-HYBRID', chosen: rep.selection.chosen }, seeds: [20261013], metrics: Object.fromEntries(Object.entries(h.models).map(([k, v]) => [k, v.log_loss])),
      uncertainty: { hybrid_proj_vs_team: h.comparisons.hybrid_proj_vs_team }, decision: h.comparisons.hybrid_proj_vs_team.a_better ? 'ACCEPT' : 'INCONCLUSIVE',
      justification: 'reported once for this model version', holdout_evaluated: true });
  }
}

if (require.main === module) main();
module.exports = { run, report, fitModels, staffToday, staffFactor, seasonStaffRv, variantProb, VARIANTS, PREGAME };
