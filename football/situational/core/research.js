/* ============================================================================
   FSIE — research harness: panels, walk-forward folds, the frozen holdout.

   SEASON ROLES come from research/preregistration.json and nothing else:
     prior_only   seeds the first training season's priors; never a label
     train        expanding window
     validation   walk-forward folds: train on every earlier season, predict
                  this one. All model choices were made here.
     holdout      evaluated ONCE, after the preregistration was frozen, by
                  holdout() — which refuses if the preregistration's hash or
                  the code fingerprint changed, or if a result already exists.
   walkForward() refuses any fold at or after the holdout season.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const I = require(path.join(__dirname, 'ingest.js'));
const FT = require(path.join(__dirname, 'features.js'));
const PN = require(path.join(__dirname, 'panel.js'));
const VM = require(path.join(__dirname, 'volume_model.js'));
const EV = require(path.join(__dirname, 'evaluate.js'));
const PM = require(path.join(__dirname, 'player_model.js'));

const DIR = path.join(__dirname, '..');
const RESEARCH = path.join(DIR, 'research');
const PREREG = path.join(RESEARCH, 'preregistration.json');
/* the files whose content defines the model; the holdout refuses to run if
   any of them changed after the preregistration was frozen */
const CODE_FILES = ['core/situations.js', 'core/quality.js', 'core/aggregate.js', 'core/features.js', 'core/panel.js', 'core/volume_model.js',
  'core/player_model.js', 'core/evaluate.js', 'core/research.js', 'config/situations_v1.json', 'config/quality_v1.json', 'config/features_v1.json',
  'nfl/source.js', 'cfb/source.js'];

function codeFingerprint() {
  const h = {}; CODE_FILES.forEach((f) => { h[f] = U.sha256(fs.readFileSync(path.join(DIR, f))); });
  return { files: h, sha256: U.sha256(h) };
}
/* tests inject a preregistration (and an output directory) to prove the guards */
let PREREG_OVERRIDE = null;
function withPrereg(p) { PREREG_OVERRIDE = p; }
function prereg() { return PREREG_OVERRIDE || U.readJson(PREREG); }
function roles(sport) { const p = prereg(); if (!p) throw new Error('research/preregistration.json missing'); return p.sports[sport].seasons; }

/* ---------------------------------------------------------------- coaches */
function nflCoaches(cur, prev) {
  const first = {}, last = {};
  const byTime = (a, b) => String(a.kickoff_at).localeCompare(String(b.kickoff_at));
  (cur.schedule || []).slice().sort(byTime).forEach((g) => { if (!first[g.home] && g.home_coach) first[g.home] = g.home_coach; if (!first[g.away] && g.away_coach) first[g.away] = g.away_coach; });
  /* the coach of each team's LAST game of the previous season, postseason included */
  if (prev) prev.schedule.slice().sort(byTime).forEach((g) => { if (g.home_coach) last[g.home] = g.home_coach; if (g.away_coach) last[g.away] = g.away_coach; });
  const out = {}; Object.keys(first).forEach((t) => { out[t] = { coach: first[t], prev_coach: last[t] || null, new_hc: last[t] ? last[t] !== first[t] : null }; });
  return out;
}
async function cfbCoaches(season, opts) {
  const S = require(path.join(DIR, 'cfb', 'source.js'));
  const a = await S.loadCoaches(season, opts), b = await S.loadCoaches(season - 1, opts);
  const out = {};
  Object.keys(a.by_team).forEach((t) => { const p = b.by_team[t]; out[t] = { coach: a.by_team[t].coach, prev_coach: p ? p.coach : null, new_hc: p ? p.coach !== a.by_team[t].coach : null }; });
  return { by_team: out, ok: a.ok && b.ok };
}
function cfbDivisions(d) {
  const out = {};
  (d.schedule || []).forEach((g) => {
    if (g.home && !out[g.home]) out[g.home] = { division: g.home_division, conference: g.home_conference, name: g.home_name };
    if (g.away && !out[g.away]) out[g.away] = { division: g.away_division, conference: g.away_conference, name: g.away_name };
  });
  return out;
}

/* ------------------------------------------------------------------ panels */
async function shrinkK(sport, seasons, opts) {
  const ks = [];
  for (const s of seasons) { const d = I.loadDerived(sport, s, opts); if (d) ks.push(FT.estimateK(FT.seasonTeamTotals(d))); }
  const out = {};
  if (!ks.length) return out;
  Object.keys(ks[0]).forEach((m) => { const xs = ks.map((k) => k[m]).filter(U.isNum).sort((a, b) => a - b); out[m] = xs.length ? U.round(U.quantile(xs, 0.5), 2) : null; });
  return out;
}
async function seasonPanel(sport, season, K, opts) {
  const d = I.loadDerived(sport, season, opts); if (!d) throw new Error(`no derived data for ${sport} ${season}; run the backfill`);
  const prev = I.loadDerived(sport, season - 1, opts);
  const coaches = sport === 'nfl' ? nflCoaches(d, prev) : (await cfbCoaches(season, opts)).by_team;
  const walk = FT.walkSeason(sport, d, prev, { K, coaches });
  const rows = PN.build(sport, d, prev, walk, { divisions: sport === 'cfb' ? cfbDivisions(d) : {} });
  return { rows, walk, data: d, prev, coaches };
}

/* ------------------------------------------------------------- variants */
const VARIANTS = ['season_avg', 'recent_weighted', 'market_only', 'situational', 'opponent', 'pace_script', 'formation'];
const TARGETS = ['plays', 'pass_att', 'rush_att'];
function predictAll(params, r) {
  const out = {};
  out.season_avg = { plays: r.base.season_avg.plays, pass_att: r.base.season_avg.pass_att, rush_att: r.base.season_avg.rush_att };
  out.recent_weighted = { plays: r.base.recent_weighted.plays, pass_att: r.base.recent_weighted.pass_att, rush_att: r.base.recent_weighted.rush_att };
  ['market_only'].concat(VM.RUNGS).forEach((v) => { const mu = VM.predictMean(params, r, v); out[v] = { plays: mu.plays, pass_att: mu.pass_att, rush_att: mu.rush_att, drives: mu.drives, db_rate: mu.db_rate }; });
  return out;
}

/* simulate a fold's games for interval coverage at the given phi values */
function simulateRows(params, rows, phis, draws) {
  const byGame = {}; rows.forEach((r) => { (byGame[r.game_id] = byGame[r.game_id] || []).push(r); });
  const out = {}; phis.forEach((p) => { out[p] = []; });
  Object.values(byGame).forEach((pair) => {
    if (pair.length !== 2) return;
    phis.forEach((phi) => {
      const sim = VM.simulateGame(params, pair[0], pair[1], { phi, draws, seed: 'cov|' + pair[0].game_id });
      [[pair[0], sim.a], [pair[1], sim.b]].forEach(([r, s]) => { if (r.labels) out[phi].push({ r, s }); });
    });
  });
  return out;
}

function evaluateRows(rows, preds, opts) {
  opts = opts || {};
  const res = { metrics: {}, paired: {}, breakdowns: {} };
  TARGETS.forEach((t) => {
    res.metrics[t] = {}; res.paired[t] = {};
    VARIANTS.forEach((v) => { res.metrics[t][v] = EV.pointMetrics(rows.map((r, i) => ({ y: r.labels[t], yhat: preds[i][v][t] }))); });
    ['season_avg', 'recent_weighted', 'market_only'].forEach((b) => {
      ['formation', 'pace_script', 'opponent', 'situational'].forEach((v) => {
        res.paired[t][v + '_vs_' + b] = EV.paired(rows.map((r, i) => ({ game_id: r.game_id, y: r.labels[t], a: preds[i][v][t], b: preds[i][b][t] })), { seed: t + v + b, boot: opts.boot || 1000, perm: opts.perm || 2000 });
      });
    });
    /* each ablation step against the step below it */
    const ladder = [['situational', 'recent_weighted'], ['opponent', 'situational'], ['pace_script', 'opponent'], ['formation', 'pace_script']];
    ladder.forEach(([a, b]) => { res.paired[t]['step_' + a + '_vs_' + b] = EV.paired(rows.map((r, i) => ({ game_id: r.game_id, y: r.labels[t], a: preds[i][a][t], b: preds[i][b][t] })), { seed: 'step' + t + a, boot: opts.boot || 1000, perm: opts.perm || 2000 }); });
  });
  const dims = {
    favorite: (r) => EV.favBucket(r.m), expected_script: (r) => EV.scriptBucket(r.m), data_tier: (r) => r.quality.tier,
    season: (r) => String(r.season), population: (r) => r.population, line: (r) => r.m_source || 'none'
  };
  Object.keys(dims).forEach((dk) => {
    const groups = EV.groupBy(rows.map((r, i) => ({ r, p: preds[i] })), (x) => dims[dk](x.r));
    res.breakdowns[dk] = {};
    Object.keys(groups).sort().forEach((g) => {
      const xs = groups[g]; const o = { n: xs.length };
      TARGETS.forEach((t) => { o[t] = {}; ['season_avg', 'recent_weighted', 'market_only', 'formation'].forEach((v) => { o[t][v] = EV.pointMetrics(xs.map((x) => ({ y: x.r.labels[t], yhat: x.p[v][t] }))).mae; }); });
      res.breakdowns[dk][g] = o;
    });
  });
  return res;
}

/* -------------------------------------------------------- walk-forward */
async function walkForward(sport, opts) {
  opts = opts || {};
  const R = roles(sport); const P = prereg();
  R.train.concat(R.validation).forEach((s) => { if (s >= R.holdout) throw new Error('walk-forward may not read the holdout season ' + R.holdout); });
  const K = await shrinkK(sport, R.shrinkage_estimation, opts);
  const panels = {}, seasonInfo = {};
  const need = R.train.concat(R.validation);
  need.forEach((s) => { if (s >= R.holdout) throw new Error('walk-forward may not read the holdout season ' + R.holdout); });
  for (const s of need) { const sp = await seasonPanel(sport, s, K, opts); panels[s] = sp.rows; seasonInfo[s] = { data: sp.data, prev: sp.prev }; }
  const primary = P.sports[sport].primary_variant;
  const playerRows = [], playerCov = [], foldRates = [], availCache = {};
  const folds = []; const allRows = [], allPreds = [], covRows = {};
  const phis = P.sports[sport].interval_phi_grid;
  for (const v of R.validation) {
    const trainRows = [].concat(...R.train.concat(R.validation).filter((s) => s < v).map((s) => panels[s])).filter((r) => r.labels);
    const params = VM.train(sport, trainRows, { lambda: P.sports[sport].ridge_lambda, trained_on: 'seasons < ' + v });
    const test = panels[v].filter((r) => r.labels);
    const preds = test.map((r) => predictAll(params, r));
    folds.push({ season: v, n_train: trainRows.length, n_test: test.length, metrics: evaluateRows(test, preds, { boot: 200, perm: 400 }).metrics });
    test.forEach((r, i) => { allRows.push(r); allPreds.push(preds[i]); });
    const before = R.train.concat(R.validation).filter((x) => x < v);
    const tr = targetedRatio(before.map((x) => seasonInfo[x].data));
    const ss = starterShareTable(before.map((x) => ({ data: seasonInfo[x].data, rows: panels[x] })));
    for (const x of before.concat([v])) if (sport === 'nfl' && !availCache[x]) availCache[x] = await nflAvailability(x, Object.assign({ current_season: R.live }, opts));
    const avail = sport === 'nfl' ? availCache[v] : null;
    const rates = playerRates(sport, before.map((x) => ({ data: seasonInfo[x].data, prev: seasonInfo[x].prev, season: x })), sport === 'nfl' ? availCache : null);
    rates.apply_active_uplift = !!P.sports[sport].apply_active_uplift;
    foldRates.push(Object.assign({ season: v }, rates));
    const pr = playerEvalRows(sport, params, primary, test, seasonInfo[v].data, seasonInfo[v].prev, tr, ss, avail, rates);
    playerRows.push(...pr);
    playerCov.push(...playerCoverageRows(sport, params, primary, test, seasonInfo[v].data, seasonInfo[v].prev, tr, ss, avail, P.sports[sport].player_kappa_grid, opts, rates));
    const sims = simulateRows(params, test, phis, opts.draws || 600);
    phis.forEach((phi) => { (covRows[phi] = covRows[phi] || []).push(...sims[phi]); });
  }
  const coverageByPhi = {};
  phis.forEach((phi) => { coverageByPhi[phi] = {}; TARGETS.forEach((t) => { coverageByPhi[phi][t] = EV.coverage(covRows[phi].map((x) => ({ y: x.r.labels[t], p10: x.s.p10[t], p90: x.s.p90[t] }))); }); });
  /* phi: the grid value whose mean |coverage - 0.8| over the three targets is smallest */
  let best = phis[0], bestErr = Infinity;
  phis.forEach((phi) => { const e = U.mean(TARGETS.map((t) => Math.abs(coverageByPhi[phi][t].p10_p90 - 0.8))); if (e < bestErr - 1e-9) { bestErr = e; best = phi; } });
  const pooled = evaluateRows(allRows, allPreds, { boot: 1000, perm: 2000 });
  return { schema: 'edgedesk_fsie_walkforward_v1', sport, seasons: R, primary_variant: primary, shrinkage_k: K, folds, pooled, interval: { by_phi: coverageByPhi, chosen_phi: best }, n_rows: allRows.length,
    players: evaluatePlayers(playerRows), player_interval: playerIntervalChoice(playerCov, P.sports[sport].player_kappa_grid), player_rates_by_fold: foldRates };
}

/* player interval coverage over a deterministic sample of games (every game
   for the NFL, every third for college), at each share-dispersion multiplier */
function playerCoverageRows(sport, params, variant, test, data, prev, tr, ssTable, avail, grid, opts, rates) {
  const states = PM.playerStates(sport, data, prev);
  const actual = {}; data.player_games.forEach((p) => { actual[p.game_id + '|' + p.team + '|' + p.player_id] = p; });
  const tq = {}; data.team_games.forEach((r) => { tq[r.game_id + '|' + r.team] = r.quality; });
  const byGame = {}; test.forEach((r) => { (byGame[r.game_id] = byGame[r.game_id] || []).push(r); });
  const gids = Object.keys(byGame).sort(); const step = sport === 'nfl' ? 1 : 3;
  const out = [];
  gids.forEach((gid, gi) => {
    if (gi % step) return;
    const pair = byGame[gid]; if (pair.length !== 2) return;
    const sim = VM.simulateGame(params, pair[0], pair[1], { variant, draws: (opts && opts.player_draws) || 300, keep_draws: true, seed: 'pc|' + gid, phi: 1 });
    [[pair[0], sim.a], [pair[1], sim.b]].forEach(([r, ts]) => {
      const q = tq[r.game_id + '|' + r.team]; if (!q || !q.player_ok) return;
      const st = states.get(r.game_id + '|' + r.team); if (!st) return;
      const team = teamMeanForPlayers(params, variant, r, tr, ssTable, rates);
      const players = PM.applyAvailability(sport, st.players, avail ? (id) => avail.lookup(r.week, r.team, id) : null);
      const means = PM.projectMeans(team, players, sport);
      grid.forEach((g) => {
        const kap = { pass: PM.CFG.kappa.pass * g, rush: PM.CFG.kappa.rush * g, target: PM.CFG.kappa.target * g };
        const sims = PM.simulatePlayers(team, ts.draws, players, { kappa: kap, seed: 'pk|' + gid + '|' + r.team + '|' + g });
        sims.forEach((ps, i) => {
          const m = means[i]; const a = actual[r.game_id + '|' + r.team + '|' + ps.player_id];
          if (!(a && a.pass_att + a.dropbacks + a.rush_att + a.targets > 0)) return;
          Object.keys(PLAYER_MARKETS).forEach((mk) => { if (!PLAYER_MARKETS[mk](players[i], m)) return; out.push({ g, market: mk, y: a[mk], p10: ps[mk].p10, p90: ps[mk].p90 }); });
        });
      });
    });
  });
  return out;
}
function playerIntervalChoice(rows, grid) {
  const by = {}; const choice = {};
  Object.keys(PLAYER_MARKETS).forEach((mk) => {
    by[mk] = {}; let best = grid[0], err = Infinity;
    grid.forEach((g) => { const c = EV.coverage(rows.filter((x) => x.market === mk && x.g === g)); by[mk][g] = c; if (c.n && Math.abs(c.p10_p90 - 0.8) < err - 1e-9) { err = Math.abs(c.p10_p90 - 0.8); best = g; } });
    choice[mk] = best;
  });
  return { by_multiplier: by, chosen: choice };
}

/* ------------------------------------------------------------- players */
/* targeted attempts per official pass attempt, from training seasons only */
function targetedRatio(datas) {
  let t = 0, a = 0;
  datas.forEach((d) => { const ok = {}; d.team_games.forEach((r) => { if (r.quality && r.quality.player_ok) { ok[r.game_id + '|' + r.team] = 1; a += r.counts.pass_att; } }); d.player_games.forEach((p) => { if (ok[p.game_id + '|' + p.team]) t += p.targets; }); });
  return a ? U.round(t / a, 4) : 0.95;
}
const PLAYER_MARKETS = {
  pass_att: (p, m) => p.role === 'QB' && p.started_last,
  rush_att: (p, m) => m.rush_att >= 3,
  targets: (p, m) => m.targets >= 2,
  receptions: (p, m) => m.targets >= 2
};
/* starter's share of team pass attempts by pregame expected margin (team
   perspective), from training seasons only */
const SS_BINS = [-Infinity, -14, -7, -3, 3, 7, 14, Infinity];
function ssBin(m) { for (let i = 0; i < SS_BINS.length - 1; i++) if (m > SS_BINS[i] && m <= SS_BINS[i + 1]) return i; return 3; }
function starterShareTable(datasWithRows) {
  const bins = SS_BINS.slice(0, -1).map(() => ({ a: 0, t: 0, n: 0 })); let A = 0, T = 0;
  datasWithRows.forEach(({ data, rows }) => {
    const m = {}; rows.forEach((r) => { if (U.isNum(r.m) && r.labels) m[r.game_id + '|' + r.team] = r.m; });
    const team = {}; data.team_games.forEach((r) => { if (r.quality && r.quality.player_ok && r.season_type === 'REG') team[r.game_id + '|' + r.team] = r.counts.pass_att; });
    data.player_games.forEach((p) => { const k = p.game_id + '|' + p.team; if (!p.started || team[k] == null || !(k in m)) return; const b = bins[ssBin(m[k])]; b.a += p.pass_att; b.t += team[k]; b.n++; A += p.pass_att; T += team[k]; });
  });
  const mean = T ? A / T : null;
  return { edges: SS_BINS.slice(1, -1), mean: U.round(mean, 4), bins: bins.map((b) => ({ share: b.t ? U.round((b.a + 200 * mean) / (b.t + 200), 4) : U.round(mean, 4), n: b.n })) };
}
function starterShareFor(table, m) { if (!table) return null; return U.isNum(m) ? table.bins[ssBin(m)].share : table.mean; }
/* From training seasons only: the share of eligible (post-availability)
   players who record no opportunity, and the share of starts in which the
   starting quarterback threw fewer than 70% of his team's passes. */
function playerRates(sport, seasons, availBySeason) {
  let elig = 0, inact = 0, starts = 0, exits = 0;
  seasons.forEach(({ data, prev, season }) => {
    const states = PM.playerStates(sport, data, prev);
    const act = {}; data.player_games.forEach((p) => { act[p.game_id + '|' + p.team + '|' + p.player_id] = p; });
    const team = {}; data.team_games.forEach((r) => { if (r.quality && r.quality.player_ok && r.season_type === 'REG') team[r.game_id + '|' + r.team] = r; });
    states.forEach((st, key) => {
      const r = team[key]; if (!r) return;
      const av = availBySeason && availBySeason[season];
      const ps = PM.applyAvailability(sport, st.players, av ? (id) => av.lookup(r.week, r.team, id) : null);
      ps.forEach((p) => { if (p.share.rush < 0.05 && p.share.target < 0.05 && p.role !== 'QB') return; elig++; const a = act[key + '|' + p.player_id]; if (!(a && a.pass_att + a.dropbacks + a.rush_att + a.targets > 0)) inact++; });
    });
    data.player_games.forEach((p) => { const r = team[p.game_id + '|' + p.team]; if (!p.started || !r || !r.counts.pass_att) return; starts++; if (p.pass_att / r.counts.pass_att < 0.7) exits++; });
  });
  return { active_rate: elig ? U.round(1 - inact / elig, 4) : 1, qb_exit_rate: starts ? U.round(exits / starts, 4) : 0, eligible: elig, starts };
}
function teamMeanForPlayers(params, variant, r, tr, ssTable, rates) {
  const mu = VM.predictMean(params, r, variant);
  const kn = r.T.off.kneels_pg && U.isNum(r.T.off.kneels_pg.v) ? r.T.off.kneels_pg.v : 0;
  return { pass_att: mu.pass_att, rush_att: mu.rush_att, scrambles: mu.scrambles, kneels: kn, targeted_ratio: tr, starter_share: starterShareFor(ssTable, r.m),
    active_rate: rates && rates.apply_active_uplift ? rates.active_rate : 1, qb_exit_rate: rates ? rates.qb_exit_rate : 0, plays: mu.plays, drives: mu.drives, sacks: mu.sacks, dropbacks: mu.dropbacks, db_rate: mu.db_rate, sack_rate: mu.sack_rate, scramble_rate: mu.scramble_rate };
}
/* NFL availability as known before kickoff: the weekly roster (anything but
   ACT — reserve, practice squad, cut, game-day inactive — is OUT; inactives are
   announced 90 minutes before kickoff) and the injury report (Out, Doubtful,
   Questionable). College football has no such feed. */
async function nflAvailability(season, opts) {
  const N = require(path.join(DIR, 'nfl', 'source.js'));
  const ro = await N.loadRosters(season, opts || {}), inj = await N.loadInjuries(season, opts || {});
  const st = new Map();
  if (ro.ok) ro.rows.forEach((x) => { if (x.status && x.status !== 'ACT' && x.gsis_id) st.set(x.week + '|' + x.team + '|' + x.gsis_id, 'OUT'); });
  if (inj.ok) inj.rows.forEach((x) => { const m = { Out: 'OUT', Doubtful: 'DOUBTFUL', Questionable: 'QUESTIONABLE' }[x.report_status]; if (m && x.gsis_id && !st.has(x.week + '|' + x.team + '|' + x.gsis_id)) st.set(x.week + '|' + x.team + '|' + x.gsis_id, m); });
  return { ok: ro.ok || inj.ok, lookup: (week, team, id) => st.get(week + '|' + team + '|' + id) || null, sources: [ro.source, inj.source].filter(Boolean) };
}

function playerEvalRows(sport, params, variant, test, data, prev, tr, ssTable, avail, rates) {
  const states = PM.playerStates(sport, data, prev);
  const actual = {}; data.player_games.forEach((p) => { actual[p.game_id + '|' + p.team + '|' + p.player_id] = p; });
  const tq = {}; data.team_games.forEach((r) => { tq[r.game_id + '|' + r.team] = r.quality; });
  const out = [];
  test.forEach((r) => {
    const q = tq[r.game_id + '|' + r.team]; if (!q || !q.player_ok) return;
    const st = states.get(r.game_id + '|' + r.team); if (!st) return;
    const team = teamMeanForPlayers(params, variant, r, tr, ssTable, rates);
    const players = PM.applyAvailability(sport, st.players, avail ? (id) => avail.lookup(r.week, r.team, id) : null);
    const means = PM.projectMeans(team, players, sport);
    means.forEach((m, i) => {
      const p = players[i]; const a = actual[r.game_id + '|' + r.team + '|' + p.player_id];
      const active = !!(a && a.pass_att + a.dropbacks + a.rush_att + a.targets > 0);
      Object.keys(PLAYER_MARKETS).forEach((mk) => {
        if (!PLAYER_MARKETS[mk](p, m)) return;
        out.push({ game_id: r.game_id, team: r.team, player_id: p.player_id, market: mk, active, y: active ? a[mk] : null,
          model: m[mk], season_avg: p.base.season_avg[mk], recent_weighted: p.base.recent_weighted[mk], season: r.season });
      });
    });
  });
  return out;
}
function evaluatePlayers(rows) {
  const out = {};
  Object.keys(PLAYER_MARKETS).forEach((mk) => {
    const all = rows.filter((x) => x.market === mk);
    const act = all.filter((x) => x.active && U.isNum(x.season_avg) && U.isNum(x.recent_weighted));
    out[mk] = {
      projected: all.length, inactive_share: all.length ? U.round(all.filter((x) => !x.active).length / all.length, 4) : null,
      evaluated: act.length,
      metrics: { model: EV.pointMetrics(act.map((x) => ({ y: x.y, yhat: x.model }))), season_avg: EV.pointMetrics(act.map((x) => ({ y: x.y, yhat: x.season_avg }))), recent_weighted: EV.pointMetrics(act.map((x) => ({ y: x.y, yhat: x.recent_weighted }))) },
      paired: {
        model_vs_season_avg: EV.paired(act.map((x) => ({ game_id: x.game_id, y: x.y, a: x.model, b: x.season_avg })), { seed: 'p' + mk + 's', boot: 1000, perm: 2000 }),
        model_vs_recent_weighted: EV.paired(act.map((x) => ({ game_id: x.game_id, y: x.y, a: x.model, b: x.recent_weighted })), { seed: 'p' + mk + 'r', boot: 1000, perm: 2000 })
      }
    };
  });
  return out;
}

/* ============================================================ the freeze */
function preregContentSha(p) { const c = Object.assign({}, p); delete c.content_sha256; delete c.frozen_at; delete c.status; delete c.code_fingerprint; return U.sha256(c); }
function checkFrozen() {
  const p = prereg(); if (!p) return { ok: false, why: 'no preregistration' };
  if (p.status !== 'frozen') return { ok: false, why: 'preregistration status is ' + p.status + ', not frozen' };
  if (preregContentSha(p) !== p.content_sha256) return { ok: false, why: 'preregistration content changed after the freeze' };
  const cf = codeFingerprint();
  if (!p.code_fingerprint || cf.sha256 !== p.code_fingerprint.sha256) {
    const changed = Object.keys(cf.files).filter((k) => !p.code_fingerprint || p.code_fingerprint.files[k] !== cf.files[k]);
    return { ok: false, why: 'model code changed after the freeze: ' + changed.join(', ') };
  }
  return { ok: true, prereg: p, code: cf };
}

/* ============================================ fit on a set of seasons */
async function fitOn(sport, seasons, opts) {
  opts = opts || {};
  const R = roles(sport); const P = prereg(); const S = P.sports[sport];
  const K = await shrinkK(sport, R.shrinkage_estimation, opts);
  const info = {}; const rows = [];
  for (const s of seasons) { const sp = await seasonPanel(sport, s, K, opts); info[s] = { data: sp.data, prev: sp.prev, rows: sp.rows }; rows.push(...sp.rows.filter((r) => r.labels)); }
  const params = VM.train(sport, rows, { lambda: S.ridge_lambda, trained_on: seasons.join(',') });
  params.phi = opts.phi != null ? opts.phi : 1;
  const availCache = {};
  if (sport === 'nfl') for (const s of seasons) availCache[s] = await nflAvailability(s, Object.assign({ current_season: R.live }, opts));
  const player = {
    targeted_ratio: targetedRatio(seasons.map((s) => info[s].data)),
    starter_share: starterShareTable(seasons.map((s) => ({ data: info[s].data, rows: info[s].rows }))),
    rates: Object.assign(playerRates(sport, seasons.map((s) => ({ data: info[s].data, prev: info[s].prev, season: s })), sport === 'nfl' ? availCache : null), { apply_active_uplift: !!S.apply_active_uplift }),
    kappa_multiplier: opts.kappa_multiplier || {}
  };
  return { params, player, K, seasons };
}

/* ================================================= the one-look holdout */
async function holdout(sport, opts) {
  opts = opts || {};
  const fz = checkFrozen(); if (!fz.ok) throw new Error('holdout refused: ' + fz.why);
  const out = path.join(opts.research_dir || RESEARCH, 'holdout_' + sport + '.json');
  if (fs.existsSync(out)) throw new Error('holdout refused: ' + path.basename(out) + ' already exists — the holdout is evaluated once');
  const P = fz.prereg; const S = P.sports[sport]; const R = S.seasons;
  const chosen = S.frozen_choices;
  const fit = await fitOn(sport, R.train.concat(R.validation), Object.assign({}, opts, { phi: chosen.phi, kappa_multiplier: chosen.player_kappa_multiplier }));
  const hp = await seasonPanel(sport, R.holdout, fit.K, opts);
  const test = hp.rows.filter((r) => r.labels);
  const preds = test.map((r) => predictAll(fit.params, r));
  const team = evaluateRows(test, preds, { boot: 2000, perm: 4000 });
  const sims = simulateRows(fit.params, test, [chosen.phi], opts.draws || 1000)[chosen.phi];
  const cov = {}; TARGETS.forEach((t) => { cov[t] = EV.coverage(sims.map((x) => ({ y: x.r.labels[t], p10: x.s.p10[t], p90: x.s.p90[t] }))); });
  const avail = sport === 'nfl' ? await nflAvailability(R.holdout, Object.assign({ current_season: R.live }, opts)) : null;
  const prow = playerEvalRows(sport, fit.params, S.primary_variant, test, hp.data, hp.prev, fit.player.targeted_ratio, fit.player.starter_share, avail, fit.player.rates);
  const players = evaluatePlayers(prow);
  const grid = Object.keys(chosen.player_kappa_multiplier).map((k) => chosen.player_kappa_multiplier[k]).filter((x, i, a) => a.indexOf(x) === i);
  const pcovRows = playerCoverageRows(sport, fit.params, S.primary_variant, test, hp.data, hp.prev, fit.player.targeted_ratio, fit.player.starter_share, avail, grid, opts, fit.player.rates);
  const pcov = {}; Object.keys(PLAYER_MARKETS).forEach((mk) => { pcov[mk] = EV.coverage(pcovRows.filter((x) => x.market === mk && x.g === chosen.player_kappa_multiplier[mk])); });
  const result = {
    schema: 'edgedesk_fsie_holdout_v1', sport, holdout_season: R.holdout, evaluated_at: new Date().toISOString(),
    preregistration_sha256: P.content_sha256, code_sha256: fz.code.sha256, primary_variant: S.primary_variant,
    trained_on: fit.seasons, n_team_games: test.length,
    team: { metrics: team.metrics, paired: team.paired, breakdowns: team.breakdowns, coverage: cov, residual: fit.params.residual },
    players: Object.assign(players, { coverage: pcov }), player_rates: fit.player.rates
  };
  result.criteria = judge(sport, S.promotion_criteria, result);
  U.writeJson(out, result);
  return result;
}

/* the preregistered criteria, evaluated mechanically */
function judge(sport, C, res) {
  const out = { team: [], player: [] }; const pv = res.primary_variant;
  const T = res.team; const P = res.players;
  const pair = (t, a, b) => (T.paired[t] && T.paired[t][a + '_vs_' + b]) || null;
  const primaryPair = (t, b) => { const x = pair(t, pv, b); return x; };
  C.team.forEach((c) => {
    let pass = null, evidence = null;
    if (c.id === 'beats_season_avg' || c.id === 'beats_recent_weighted') {
      const b = c.id === 'beats_season_avg' ? 'season_avg' : 'recent_weighted';
      evidence = TARGETS.map((t) => { const x = primaryPair(t, b); return { target: t, mae_diff: x.mae_diff, ci95: x.ci95 }; });
      pass = evidence.every((e) => e.ci95[1] < 0);
    } else if (c.id === 'vs_market_only') {
      evidence = TARGETS.map((t) => { const x = primaryPair(t, 'market_only'); return { target: t, mae_diff: x.mae_diff, pct_change: x.pct_change, ci95: x.ci95 }; });
      pass = evidence.every((e) => (e.target === 'plays' ? e.pct_change <= c.plays_max_pct_worse : e.ci95[1] < 0));
    } else if (c.id === 'interval_coverage') {
      evidence = TARGETS.map((t) => ({ target: t, p10_p90: T.coverage[t].p10_p90 }));
      pass = evidence.every((e) => e.p10_p90 >= c.min && e.p10_p90 <= c.max);
    } else if (c.id === 'bias') {
      evidence = TARGETS.map((t) => ({ target: t, bias: T.metrics[t][pv].bias }));
      pass = evidence.every((e) => Math.abs(e.bias) <= c.max_abs);
    } else if (c.id === 'sample') {
      evidence = { n: res.n_team_games, min: c.min_team_games }; pass = res.n_team_games >= c.min_team_games;
    }
    out.team.push({ id: c.id, rule: c.rule, pass, evidence });
  });
  C.player.forEach((c) => {
    let pass = null, evidence = null;
    if (c.id === 'beats_player_season_avg' || c.id === 'beats_player_recent_weighted') {
      const k = c.id === 'beats_player_season_avg' ? 'model_vs_season_avg' : 'model_vs_recent_weighted';
      evidence = Object.keys(PLAYER_MARKETS).map((mk) => ({ market: mk, mae_diff: P[mk].paired[k].mae_diff, ci95: P[mk].paired[k].ci95 }));
      pass = evidence.every((e) => e.ci95 && e.ci95[1] < 0);
    } else if (c.id === 'player_interval_coverage') {
      evidence = Object.keys(PLAYER_MARKETS).map((mk) => ({ market: mk, p10_p90: P.coverage[mk].p10_p90 }));
      pass = evidence.every((e) => e.p10_p90 >= c.min && e.p10_p90 <= c.max);
    } else if (c.id === 'player_bias') {
      evidence = Object.keys(PLAYER_MARKETS).map((mk) => ({ market: mk, bias: P[mk].metrics.model.bias, max: mk === 'pass_att' ? c.max_abs_pass_att : c.max_abs_other }));
      pass = evidence.every((e) => Math.abs(e.bias) <= e.max);
    } else if (c.id === 'player_sample') {
      evidence = Object.keys(PLAYER_MARKETS).map((mk) => ({ market: mk, n: P[mk].evaluated, min: mk === 'pass_att' ? c.min_qb_starts : c.min_other }));
      pass = evidence.every((e) => e.n >= e.min);
    }
    out.player.push({ id: c.id, rule: c.rule, pass, evidence });
  });
  out.team_passed = out.team.every((x) => x.pass === true);
  out.player_passed = out.player.every((x) => x.pass === true);
  return out;
}

/* ================================ production parameters for the live season */
async function productionFit(sport, opts) {
  opts = opts || {};
  const fz = checkFrozen(); if (!fz.ok) throw new Error('production fit refused: ' + fz.why);
  if (!fs.existsSync(path.join(opts.research_dir || RESEARCH, 'holdout_' + sport + '.json'))) throw new Error('production fit refused: the holdout has not been evaluated');
  const S = fz.prereg.sports[sport]; const R = S.seasons;
  const fit = await fitOn(sport, R.train.concat(R.validation, [R.holdout]), Object.assign({}, opts, { phi: S.frozen_choices.phi, kappa_multiplier: S.frozen_choices.player_kappa_multiplier }));
  const out = { schema: 'edgedesk_fsie_params_v1', sport, model_version: fz.prereg.model_version, primary_variant: S.primary_variant,
    preregistration_sha256: fz.prereg.content_sha256, code_sha256: fz.code.sha256, fitted_on: fit.seasons, shrinkage_k: fit.K,
    team: fit.params, player: fit.player, fitted_at: opts.now || new Date().toISOString() };
  U.writeJson(path.join(opts.research_dir || RESEARCH, 'params_' + sport + '.json'), out);
  return out;
}

module.exports = { withPrereg, holdout, productionFit, fitOn, judge, checkFrozen, preregContentSha, walkForward, nflAvailability, playerRates, playerEvalRows, starterShareTable, starterShareFor, evaluatePlayers, targetedRatio, teamMeanForPlayers, PLAYER_MARKETS, seasonPanel, shrinkK, predictAll, evaluateRows, simulateRows, codeFingerprint, prereg, roles, nflCoaches, cfbCoaches, cfbDivisions, VARIANTS, TARGETS, CODE_FILES, RESEARCH, PREREG };
