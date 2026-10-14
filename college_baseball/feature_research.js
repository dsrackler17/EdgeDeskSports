'use strict';
/* ===========================================================================
   EdgeDesk college baseball — offense, defence and environment features:
   do they predict anything the team model does not already know?

     node college_baseball/feature_research.js

   Each hypothesis is tested the same way, written before the result:
     the team model's out-of-sample run expectation is the offset; a feature
     group enters a Poisson GLM for runs (log E[y] = log lambda_team + beta x),
     fitted on the FIT window and scored on the next, untouched window by
     team-runs log score (negative binomial, the pricing distribution). A
     group is ACCEPTED only if a date-block bootstrap of the per-game score
     difference has a 95% interval wholly below zero. A rejected group is
     recorded, never deleted.

   H-OFF-1  component offense (Model 2): opponent-adjusted component rates
            (1B, 2B, 3B, HR, BB, HBP, K, SB) turned into runs with COLLEGE
            linear weights, as an alternative and a blend with the team model.
            FIT 2024 -> TEST 2025 (box scores).
   H-DEF-1  defence: season-to-date errors per game, unearned-run share,
            double plays, catcher stolen-base control, defensive efficiency.
            FIT 2024 -> TEST 2025.
   H-ENV-1  rest: days since each side's previous game (capped), and the
            second game of a doubleheader. FIT SELECTION -> TEST VALIDATION.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const W = require('./lib/warehouse');
const D = require('./lib/distribution');
const S = require('../engine/stats');
const V = require('../engine/validation');
const WF = require('./walkforward');
const REG = require('./lib/registry');
const K = require('./ingest/common');

const r = V.r;

function teamRowsMap() { const m = new Map(); for (const x of JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8'))) if (x.hier_lh != null) m.set(x.game_id, x); return m; }

/* ---------------------------------------------------------------- linear weights */
function fitLinearWeights(teamGames) {
  const X = []; const y = [];
  for (const t of teamGames) {
    if (t.box_quality !== 'OK' || t.bat_ab == null) continue;
    const h = t.bat_h || 0; const d2 = t.bat_2b || 0; const d3 = t.bat_3b || 0; const hr = t.bat_hr || 0;
    const outs = (t.bat_ab - h) + (t.bat_sf || 0) + (t.bat_sh || 0);
    X.push([h - d2 - d3 - hr, d2, d3, hr, (t.bat_bb || 0) + (t.bat_hbp || 0), t.bat_sb || 0, t.bat_cs || 0, outs]);
    y.push(t.bat_r || 0);
  }
  const p = X[0].length; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < p; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
  const beta = Array.from(S.solve(A, b));
  const names = ['1B', '2B', '3B', 'HR', 'BB+HBP', 'SB', 'CS', 'out'];
  let ss = 0; let st = 0; const my = y.reduce((a, v) => a + v, 0) / y.length;
  X.forEach((x, i) => { const f = S.dot(beta, x); ss += Math.pow(y[i] - f, 2); st += Math.pow(y[i] - my, 2); });
  return { weights: Object.fromEntries(names.map((n, i) => [n, r(beta[i], 4)])), beta, r2: r(1 - ss / st, 4), n: X.length };
}

/* ---------------------------------------------------------------- season-to-date team box state (causal) */
const COMP = ['s1', 'd2', 't3', 'hr', 'bbh', 'k', 'sb', 'cs', 'out', 'pa'];
function compsOf(t, side) {
  /* side 'bat': the team's own batting; 'pit': what its pitchers allowed (from the opponent's batting line) */
  const h = t.bat_h || 0; const d2 = t.bat_2b || 0; const d3 = t.bat_3b || 0; const hr = t.bat_hr || 0;
  const pa = (t.bat_ab || 0) + (t.bat_bb || 0) + (t.bat_hbp || 0) + (t.bat_sf || 0) + (t.bat_sh || 0);
  return { s1: h - d2 - d3 - hr, d2, t3: d3, hr, bbh: (t.bat_bb || 0) + (t.bat_hbp || 0), k: t.bat_k || 0, sb: t.bat_sb || 0, cs: t.bat_cs || 0, out: (t.bat_ab || 0) - h + (t.bat_sf || 0) + (t.bat_sh || 0), pa };
}
function blankC() { const o = {}; for (const k of COMP) o[k] = 0; return o; }

function buildStates(season) {
  /* per game date: each team's batting comps and allowed comps before that date, plus defence counters */
  const tg = W.teamGames(season).filter((t) => t.box_quality === 'OK' && t.team_id && t.date);
  const byGame = new Map(); for (const t of tg) { if (!byGame.has(t.game_id)) byGame.set(t.game_id, []); byGame.get(t.game_id).push(t); }
  const games = [...byGame.values()].filter((x) => x.length === 2).sort((a, b) => (a[0].date < b[0].date ? -1 : 1));
  return games;
}

function main() {
  const rows = teamRowsMap();
  const constants = WF.constants();
  const spec = WF.tuning().dist || { family: 'nb', r: 4 };
  const out = { schema: 'edgedesk_cbase_feature_research_v1', point_in_time: 'RETROSPECTIVE', distribution: spec, hypotheses: {} };
  const lwFit = fitLinearWeights(W.teamGames(2024));
  out.linear_weights_2024 = lwFit;

  /* ---------- H-OFF-1 and H-DEF-1 on 2024 -> 2025 ---------- */
  const samples = { 2024: [], 2025: [] };
  for (const season of [2024, 2025]) {
    const games = buildStates(season);
    const bat = new Map(); const pit = new Map(); const def = new Map(); const lg = blankC(); let lgGames = 0;
    const get = (m, id) => { if (!m.has(id)) m.set(id, blankC()); return m.get(id); };
    const getD = (id) => { if (!def.has(id)) def.set(id, { g: 0, e: 0, r: 0, er: 0, dp: 0, sba: 0, csb: 0, bip: 0, hits_in_play: 0 }); return def.get(id); };
    let i = 0;
    while (i < games.length) {
      const date = games[i][0].date; let j = i; while (j < games.length && games[j][0].date === date) j++;
      /* predict every game of the date from the state before it */
      for (let q = i; q < j; q++) {
        const [a, b] = games[q]; const x = rows.get(a.game_id); if (!x) continue;
        const home = a.side === 'H' ? a : b; const away = a.side === 'H' ? b : a;
        for (const [batT, pitT, y, lam] of [[home, away, x.home_runs, x.hier_lh], [away, home, x.away_runs, x.hier_la]]) {
          const bs = bat.get(batT.team_id); const ps = pit.get(pitT.team_id); const ds = def.get(pitT.team_id);
          if (!bs || !ps || !ds || bs.pa < 150 || ps.pa < 150 || lgGames < 200) continue;
          /* opponent-adjusted component rates, shrunk to the league with 300 PA */
          const n0 = 300; const lgRate = (k) => lg[k] / lg.pa;
          const rate = (k) => { const rb = (bs[k] + n0 * lgRate(k)) / (bs.pa + n0); const rp = (ps[k] + n0 * lgRate(k)) / (ps.pa + n0); return rb * rp / Math.max(1e-6, lgRate(k)); };
          const comp = { s1: rate('s1'), d2: rate('d2'), t3: rate('t3'), hr: rate('hr'), bbh: rate('bbh'), sb: rate('sb'), cs: rate('cs') };
          const obp = comp.s1 + comp.d2 + comp.t3 + comp.hr + comp.bbh;
          const outsPerGame = lg.out / lgGames; const pa = outsPerGame / Math.max(0.3, 1 - obp);
          const w = lwFit.beta;
          const lamComp = Math.max(0.5, pa * (w[0] * comp.s1 + w[1] * comp.d2 + w[2] * comp.t3 + w[3] * comp.hr + w[4] * comp.bbh + w[5] * comp.sb + w[6] * comp.cs + w[7] * (1 - obp)));
          const dd = ds;
          const defF = [dd.e / dd.g, dd.r ? (dd.r - dd.er) / dd.r : 0, dd.dp / dd.g, (dd.sba + dd.csb) ? dd.sba / (dd.sba + dd.csb) : 0.75, dd.bip ? 1 - dd.hits_in_play / dd.bip : 0.66];
          samples[season].push({ date, y, lam, lamComp, defF });
        }
      }
      /* fold the date's box scores in */
      for (let q = i; q < j; q++) {
        const [a, b] = games[q];
        for (const [t, o] of [[a, b], [b, a]]) {
          const c = compsOf(t); const bs = get(bat, t.team_id); const ps = get(pit, o.team_id);
          for (const k of COMP) { bs[k] += c[k]; ps[k] += c[k]; lg[k] += c[k]; }
          const d = getD(t.team_id); d.g++; d.e += t.fld_e || 0; d.r += t.pit_r || 0; d.er += t.pit_er || 0; d.dp += t.fld_idp || 0; d.sba += t.fld_sba || 0; d.csb += t.fld_csb || 0;
          const bip = (t.pit_bf || 0) - (t.pit_so || 0) - (t.pit_bb || 0) - (t.pit_hb || 0) - (t.pit_hr_a || 0); d.bip += Math.max(0, bip); d.hits_in_play += Math.max(0, (t.pit_h || 0) - (t.pit_hr_a || 0));
        }
        lgGames += 2;
      }
      i = j;
    }
  }
  const ls = (lam, y) => D.logScore(D.marginal(lam, spec), y);
  /* H-OFF-1: blend weight fitted on 2024 */
  let bestW = 0; let bestLs = Infinity;
  for (const w of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1]) { let s = 0; for (const x of samples[2024]) s += ls(Math.pow(x.lam, 1 - w) * Math.pow(x.lamComp, w), x.y); s /= samples[2024].length; if (s < bestLs) { bestLs = s; bestW = w; } }
  const test = samples[2025];
  const boot = (fa, fb) => V.pairedBootstrap(test.map((x) => ({ date: x.date, a: fa(x), b: fb(x) })), { B: 1000 });
  const offRes = { fit_season: 2024, test_season: 2025, n_test: test.length, blend_weight_fit_2024: bestW,
    test_log_score: { team: r(test.reduce((a, x) => a + ls(x.lam, x.y), 0) / test.length, 5), component: r(test.reduce((a, x) => a + ls(x.lamComp, x.y), 0) / test.length, 5), blend: r(test.reduce((a, x) => a + ls(Math.pow(x.lam, 1 - bestW) * Math.pow(x.lamComp, bestW), x.y), 0) / test.length, 5) },
    blend_vs_team: boot((x) => ls(Math.pow(x.lam, 1 - bestW) * Math.pow(x.lamComp, bestW), x.y), (x) => ls(x.lam, x.y)),
    component_vs_team: boot((x) => ls(x.lamComp, x.y), (x) => ls(x.lam, x.y)) };
  offRes.decision = offRes.blend_vs_team.a_better && bestW > 0 ? 'ACCEPT' : 'REJECT';
  out.hypotheses['H-OFF-1'] = offRes;

  /* H-DEF-1: Poisson GLM with offset, fitted on 2024 */
  const fitOffsetGlm = (rowsFit, fx) => {
    const X = rowsFit.map((x) => [1].concat(fx(x))); const y = rowsFit.map((x) => x.y); const off = rowsFit.map((x) => Math.log(x.lam));
    return S.poisson(X, y, { l2: 1, offset: off });
  };
  const defNames = ['errors_per_game', 'unearned_share', 'double_plays_per_game', 'sb_success_allowed', 'defensive_efficiency'];
  const dm = defNames.map((_, j) => samples[2024].reduce((a, x) => a + x.defF[j], 0) / samples[2024].length);
  const dsd = defNames.map((_, j) => Math.sqrt(samples[2024].reduce((a, x) => a + Math.pow(x.defF[j] - dm[j], 2), 0) / samples[2024].length) || 1);
  const fx = (x) => x.defF.map((v, j) => (v - dm[j]) / dsd[j]);
  let defRes;
  try {
    const glm = fitOffsetGlm(samples[2024], fx);
    const lamDef = (x) => x.lam * Math.exp(S.dot(glm.beta, [1].concat(fx(x))));
    defRes = { fit_season: 2024, test_season: 2025, n_test: test.length, coefficients: Object.fromEntries(['intercept'].concat(defNames).map((n, i) => [n, r(glm.beta[i], 4)])),
      test_log_score: { team: r(test.reduce((a, x) => a + ls(x.lam, x.y), 0) / test.length, 5), team_plus_defence: r(test.reduce((a, x) => a + ls(lamDef(x), x.y), 0) / test.length, 5) },
      defence_vs_team: boot((x) => ls(lamDef(x), x.y), (x) => ls(x.lam, x.y)) };
    defRes.decision = defRes.defence_vs_team.a_better ? 'ACCEPT' : 'REJECT';
  } catch (e) { defRes = { error: String(e.message), decision: 'INCONCLUSIVE' }; }
  out.hypotheses['H-DEF-1'] = defRes;

  /* ---------- H-ENV-1: rest, on the team windows ---------- */
  const all = JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8')).filter((x) => x.hier_lh != null && x.window !== 'HOLDOUT');
  const lastPlayed = new Map(); const env = [];
  const gamesById = new Map(); for (let s = 2014; s <= 2024; s++) for (const g of W.games(s)) if (W.usable(g)) gamesById.set(g.game_id, g);
  const sorted = all.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let k = 0;
  while (k < sorted.length) {
    const date = sorted[k].date; let j = k; while (j < sorted.length && sorted[j].date === date) j++;
    for (let q = k; q < j; q++) {
      const x = sorted[q]; const g = gamesById.get(x.game_id); if (!g) continue;
      const rest = (id) => { const l = lastPlayed.get(id); const d = l ? K.daysBetween(l, date) : 7; return Math.min(7, d); };
      const rh = rest(g.home_id); const ra = rest(g.away_id);
      env.push({ window: x.window, date, y: x.home_runs, lam: x.hier_lh, f: [rh <= 1 ? 1 : 0, ra <= 1 ? 1 : 0, g.dh === 2 ? 1 : 0] });
      env.push({ window: x.window, date, y: x.away_runs, lam: x.hier_la, f: [ra <= 1 ? 1 : 0, rh <= 1 ? 1 : 0, g.dh === 2 ? 1 : 0] });
    }
    for (let q = k; q < j; q++) { const g = gamesById.get(sorted[q].game_id); if (g) { lastPlayed.set(g.home_id, date); lastPlayed.set(g.away_id, date); } }
    k = j;
  }
  const envFit = env.filter((x) => x.window === 'SELECTION'); const envTest = env.filter((x) => x.window === 'VALIDATION');
  let envRes;
  try {
    const glm = fitOffsetGlm(envFit, (x) => x.f);
    const lamE = (x) => x.lam * Math.exp(S.dot(glm.beta, [1].concat(x.f)));
    envRes = { fit: 'SELECTION', test: 'VALIDATION', n_test: envTest.length, coefficients: { intercept: r(glm.beta[0], 4), batting_side_played_yesterday: r(glm.beta[1], 4), pitching_side_played_yesterday: r(glm.beta[2], 4), doubleheader_game_2: r(glm.beta[3], 4) },
      test_log_score: { team: r(envTest.reduce((a, x) => a + ls(x.lam, x.y), 0) / envTest.length, 5), team_plus_rest: r(envTest.reduce((a, x) => a + ls(lamE(x), x.y), 0) / envTest.length, 5) },
      rest_vs_team: V.pairedBootstrap(envTest.map((x) => ({ date: x.date, a: ls(lamE(x), x.y), b: ls(x.lam, x.y) })), { B: 1000 }) };
    envRes.decision = envRes.rest_vs_team.a_better ? 'ACCEPT' : 'REJECT';
  } catch (e) { envRes = { error: String(e.message), decision: 'INCONCLUSIVE' }; }
  out.hypotheses['H-ENV-1'] = envRes;

  K.writeJson(require('path').join(C.PATHS.validation, 'feature_research.json'), out);
  const reg = (id, title, hyp, windows, features, metrics, unc, dec) => REG.register({ id, family: 'feature_' + id.toLowerCase(), title, hypothesis: hyp, dataset: { warehouse: 'college_baseball/data' }, windows, features, algorithm: { name: 'Poisson GLM / blend with the team model as offset', distribution: spec }, seeds: [20261013], metrics, uncertainty: unc, decision: dec, justification: dec === 'ACCEPT' ? 'out-of-sample improvement with a 95% block-bootstrap interval below zero' : 'no out-of-sample improvement with a 95% interval below zero; the feature group is not used in prices', holdout_evaluated: false });
  reg('CBX-H-OFF-1', 'Component offense (college linear weights, opponent-adjusted components)', 'Component-based run expectations add information to the runs-based team model', { training: [2024, 2024], validation: [2025, 2025], holdout: null }, ['1B', '2B', '3B', 'HR', 'BB+HBP', 'SB', 'CS', 'outs'], offRes.test_log_score, { blend_vs_team: offRes.blend_vs_team, component_vs_team: offRes.component_vs_team }, offRes.decision);
  reg('CBX-H-DEF-1', 'Defensive metrics beyond the team model', 'Season-to-date errors, unearned-run share, double plays, catcher SB control and DER predict runs allowed beyond the team model', { training: [2024, 2024], validation: [2025, 2025], holdout: null }, defNames, defRes.test_log_score || {}, defRes.defence_vs_team || null, defRes.decision);
  reg('CBX-H-ENV-1', 'Rest and doubleheader game 2', 'Playing yesterday and doubleheader game 2 change scoring beyond the team model', { training: [2014, 2022], validation: [2023, 2024], holdout: null }, ['batting side played yesterday', 'pitching side played yesterday', 'doubleheader game 2'], envRes.test_log_score || {}, envRes.rest_vs_team || null, envRes.decision);
  console.log('linear weights 2024', JSON.stringify(lwFit.weights), 'r2', lwFit.r2);
  for (const [h, v] of Object.entries(out.hypotheses)) console.log(h, v.decision, JSON.stringify(v.test_log_score), JSON.stringify(v.blend_vs_team || v.defence_vs_team || v.rest_vs_team || {}));
}

if (require.main === module) main();
module.exports = { fitLinearWeights };
