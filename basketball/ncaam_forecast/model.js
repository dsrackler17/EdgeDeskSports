'use strict';
/* ===========================================================================
   NCAAM forecast models: configurations, point-in-time ratings, causal
   calibration, artifacts and prediction.

   ENGINES
     research_team_model  basketball/ncaam_research/team_model.js runSeason,
                          called UNCHANGED on dataset.engineGames(): opponent-
                          adjusted offensive/defensive efficiency and tempo,
                          ridge-pulled toward last season's rating (carry),
                          non-D1 opponents in their own pooled regime.
     points_ratings       the served scores-only model (basketball/model.js
                          via basketball/walkforward.js pass/score): the
                          incumbent baseline, "as served" (its own logistic win
                          curve and normal margin) and, to isolate rating
                          quality, through this file's calibrator ("+dist").
   Both feed one calibrator (dist.js fit), refitted WEEKLY on the games that
   finished before the refit — a separate, earlier chronological partition —
   pooled over the `window_seasons` seasons before and the season to date.
   A game is never scored by a calibration that saw it.

   ARTIFACT (schema edgedesk_ncaam_fc_artifact_v1): config + config hash,
   the training snapshot hash, ratings at `as_of`, the calibration, the code
   hash of every file that computes a number. predict(artifact, game) is the
   production path; the walk-forward and the artifact agree on the same
   inputs (tests/model.test.js).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const DS = require('./dataset');
const D = require('./dist');
const M = require('./metrics');
const TM = require('../ncaam_research/team_model');

const ARTIFACT_SCHEMA = 'edgedesk_ncaam_fc_artifact_v1';
const DAY = 864e5;

function stable(o) {
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
const hash = (o) => crypto.createHash('sha256').update(typeof o === 'string' ? o : stable(o)).digest('hex');
const configHash = (cfg) => hash({ engine: cfg.engine, params: cfg.params, calibration: cfg.calibration });

/** every file whose code computes a published number */
const CODE_FILES = ['basketball/ncaam_forecast/dist.js', 'basketball/ncaam_forecast/model.js', 'basketball/ncaam_forecast/dataset.js', 'basketball/ncaam_forecast/metrics.js',
  'basketball/ncaam_research/team_model.js', 'basketball/ncaam_research/lib/additive.js'];
function codeHash() { return hash(CODE_FILES.map((f) => f + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(C.ROOT, f))).digest('hex')).join('\n')); }

/* location_fit 'plain' is the fit ncaam_adjeff@1.0.0 was promoted with: a config
   without the key reproduces it exactly. 'tie_consistent' (dist.js fit) is a
   catalogue challenger (weekly.js), promoted only through the gates. */
const DEFAULT_CALIBRATION = Object.freeze({ refit_days: 7, window_seasons: 3, min_rows: { D1_D1: 300, D1_OTHER: 100 }, kappa: 'fit', variance: { margin: 'v1', total: 'v2' }, parameter_variance: 'stable', location_fit: 'plain' });

/* ------------------------------------------------------------------ ratings */
function seasonList(eg, upTo) { return [...new Set(eg.map((g) => g.season))].filter((s) => upTo == null || s <= upTo).sort((a, b) => a - b); }

/* Opening day. The research engine has no residual variance in a season
   until its first refit (Additive.s2 is null), so the first predictions of
   every season carry NaN parameter variance. Before the first game day the
   honest variance is last season's residual variance over the prior weight
   alone (no game this season yet): var(off) = var(allow) = s2_prev / lambda.
   Applied identically in the walk-forward (here) and in artifacts. */
function openingVariance(row, s2prev, params) {
  const lam = params.lambda == null ? TM.DEFAULT_PARAMS.lambda : params.lambda;
  const per = s2prev / lam;
  const d1 = (row.regime === 'D1_D1' ? 2 : 1);
  return (row.tempo / 100) * (row.tempo / 100) * d1 * 2 * per;
}

/* PARAMETER VARIANCE, stabilised. Additive.variance() divides the in-season
   residual variance s2 = rss / max(1, n - teams), which explodes while a
   season has fewer observations than teams (first weeks: var_param in the
   thousands, 1% of rows above 9,000), and that tail flattened the calibrator's
   variance slope to ~0. Here every row's parameter variance is recomputed
   from what the engine knows point in time — each side's observations this
   season — with LAST season's final residual variance per possession:
     var(off) = var(allow) = s2_prev / (games * 70 + lambda)
   (70 possessions per game). Causal: s2_prev is a finished season's. The
   engine's own value is kept as var_param_engine. */
const POSS_PER_GAME = 70;
function stableVarParam(row, s2prev, params) {
  const lam = params.lambda == null ? TM.DEFAULT_PARAMS.lambda : params.lambda;
  const side = (n) => 2 * s2prev / ((n || 0) * POSS_PER_GAME + lam);
  const both = row.regime === 'D1_D1';
  const home = both || (row.regime === 'D1_OTHER' && row.home_d1 !== false) ? side(row.n_h) : 0;
  const away = both || (row.regime === 'D1_OTHER' && row.away_d1 !== false) ? side(row.n_a) : 0;
  return (row.tempo / 100) * (row.tempo / 100) * (home + away);
}

/** the dataset context the engine's rows do not carry (membership, round, seeds) */
function attachMeta(rows, eg) {
  const by = new Map(eg.map((g) => [g.game_id, g]));
  for (const r of rows) {
    const g = by.get(r.game_id); if (!g) continue;
    r.home_d1 = g.home_d1; r.away_d1 = g.away_d1; r.ncaa_round = g.ncaa_round || null; r.home_seed = g.home_seed; r.away_seed = g.away_seed;
  }
  return rows;
}

/** raw walk-forward rows of the research engine, every season in order */
function researchRows(eg, cfg, seasons) {
  const ss = seasons || seasonList(eg);
  const W = TM.walk(eg, cfg.params, null, ss);
  attachMeta(W.rows, eg);
  let opening = 0; let unscored = 0;
  const stable = !cfg.calibration || cfg.calibration.parameter_variance !== 'engine';
  for (const r of W.rows) {
    r.var_param_engine = r.var_param;
    const prev = W.states[r.season - 1];
    const s2p = prev && Number.isFinite(prev.E.s2) ? prev.E.s2 : null;
    if (stable) { if (s2p != null) r.var_param = stableVarParam(r, s2p, cfg.params); else { r.var_param = NaN; unscored++; } continue; }
    if (Number.isFinite(r.var_param)) continue;
    if (s2p != null) { r.var_param = openingVariance(r, s2p, cfg.params); r.opening_variance = true; opening++; }
  }
  return { rows: W.rows, states: W.states, opening_rows: opening, first_season_rows_without_prior_variance: unscored };
}

/* ------------------------------------------------------------------ causal calibration */
/** attach r.s (scores) and r.cal_n to each row; each regime calibrated on its own pool */
function calibrateCausal(rows, calCfg) {
  const cc = Object.assign({}, DEFAULT_CALIBRATION, calCfg || {});
  const step = cc.refit_days * DAY;
  for (const regime of ['D1_D1', 'D1_OTHER']) {
    const rs = rows.filter((r) => r.regime === regime).sort((a, b) => a.start_ms - b.start_ms || a.game_id - b.game_id);
    let k = 0; const done = []; let cal = null; let nextRefit = -Infinity; let curSeason = null;
    for (const r of rs) {
      const at = r.start_ms - C.PREDICT_BEFORE_MS;
      if (at >= nextRefit || r.season !== curSeason) {
        while (k < rs.length && rs[k].start_ms + C.AVAILABLE_AFTER_MS < at) done.push(rs[k++]);
        const pool = done.filter((x) => x.season >= r.season - cc.window_seasons);
        cal = D.fit(pool, { min_rows: cc.min_rows[regime] || 300, kappa: cc.kappa === 'fit' ? undefined : cc.kappa, variance: cc.variance, location_fit: cc.location_fit });
        nextRefit = at - (at % step) + step; curSeason = r.season;
      }
      r.cal = cal; r.s = cal && Number.isFinite(r.var_param) ? M.scoreRow(r, cal) : null;
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ the incumbent */
/** the served points model's walk-forward rows, keyed by game id */
function incumbentRows(eg) {
  const BW = require('../walkforward');
  const tuning = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'basketball', 'params', 'ncaam_tuning.json'), 'utf8'));
  const served = BW.servedParams('ncaam');
  const { games } = BW.load('ncaam');
  const { rows } = BW.pass(games, served, tuning.elo);
  const { scored } = BW.score(rows);
  const mine = new Map(eg.map((g) => [String(g.game_id), g]));
  const asServed = []; const raw = [];
  for (const r of scored) {
    const g = mine.get(String(r.id)); if (!g) continue;
    const y = { margin: g.hs - g.as, total: g.hs + g.as, hw: g.hs > g.as ? 1 : 0, n_ot: g.n_ot };
    const base = { game_id: g.game_id, season: g.season, start_ms: g.start_ms, neutral: g.neutral, regime: g.regime, y };
    asServed.push(Object.assign({}, base, { s: M.scoreNormal(r.p.points, r.p.margin, r.p.total, y), elo: r.elo }));
    raw.push(Object.assign({}, base, { margin: r.m, total: r.t, var_param: 0, n_h: r.gh, n_a: r.ga }));
  }
  return { asServed, raw, served, version: currentIncumbentVersion() };
}
function currentIncumbentVersion() {
  try { const v = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'docs', 'model-loop', 'ncaam', 'versions.json'), 'utf8')); return 'edgedesk_bb_points_v1@' + v.current; } catch (_) { return 'edgedesk_bb_points_v1'; }
}

/* ------------------------------------------------------------------ artifacts */
/** ratings + calibration as of `asOfMs`, from data available by then only */
function buildArtifact(games, cfg, asOfMs, o) {
  o = o || {};
  if (cfg.engine !== 'research_team_model') throw new Error('artifacts are built for the research_team_model engine; the incumbent\'s artifact is basketball/params/ncaam_live.json');
  const target = o.season || C.currentSeason(asOfMs);
  /* finished games available by as_of, plus the target season's scheduled
     games from as_of on (results absent: priors only, never absorbed) */
  const egFinal = DS.engineGames(games.filter((g) => g.status === 'FINAL' && Date.parse(g.assumed_available_at) < asOfMs));
  const egSched = DS.engineGames(games.filter((g) => g.season === target && g.status === 'SCHEDULED'), { scheduledFrom: asOfMs });
  const seasons = seasonList(egFinal);
  if (!seasons.includes(target)) seasons.push(target);
  /* walk every season to the as-of moment: rows for calibration, state for
     prediction. o.cache = researchRows() over COMPLETED seasons before the
     target lets many as-of points share one walk (identical arithmetic: the
     cached states are the same runSeason results) */
  let prev = null; let prevS2 = null; const rows = [];
  let st = null;
  const stable = !cfg.calibration || cfg.calibration.parameter_variance !== 'engine';
  const finishSeason = (s, res) => {
    attachMeta(res.rows, egFinal);
    for (const r of res.rows) {
      r.var_param_engine = r.var_param;
      if (stable) r.var_param = Number.isFinite(prevS2) ? stableVarParam(r, prevS2, cfg.params) : NaN;
      else if (!Number.isFinite(r.var_param) && Number.isFinite(prevS2)) { r.var_param = openingVariance(r, prevS2, cfg.params); r.opening_variance = true; }
    }
  };
  const sorted = seasons.sort((a, b) => a - b);
  if (o.cache) {
    const before = sorted.filter((s) => s < target);
    for (const s of before) if (!o.cache.states[s]) throw new Error('the cached walk lacks season ' + s);
    const last = before[before.length - 1];
    if (last != null) { prev = o.cache.states[last].state; prevS2 = o.cache.states[last].E.s2; }
    const cc0 = Object.assign({}, DEFAULT_CALIBRATION, cfg.calibration || {});
    for (const r of o.cache.rows) if (r.season < target && r.season >= target - cc0.window_seasons) rows.push(r);
    st = TM.runSeason(target, egFinal.concat(egSched), Object.assign({}, cfg.params, { stop_ms: asOfMs }), prev, null);
    finishSeason(target, st); rows.push(...st.rows);
  } else {
    for (const s of sorted) {
      const p = Object.assign({}, cfg.params, s === target ? { stop_ms: asOfMs } : {});
      st = TM.runSeason(s, s === target ? egFinal.concat(egSched) : egFinal, p, prev, null);
      finishSeason(s, st);
      rows.push(...st.rows); prev = st.state;
      if (s !== target) prevS2 = st.E.s2;
    }
  }
  /* calibration: rows of games available before as_of, same window rule */
  const cc = Object.assign({}, DEFAULT_CALIBRATION, cfg.calibration || {});
  const meta = new Map(egFinal.map((g) => [g.game_id, g]));
  const cal = {};
  for (const regime of ['D1_D1', 'D1_OTHER']) {
    const pool = rows.filter((r) => r.regime === regime && r.start_ms + C.AVAILABLE_AFTER_MS < asOfMs && r.season >= target - cc.window_seasons)
      .map((r) => Object.assign(r, { y: Object.assign({}, r.y, { n_ot: meta.get(r.game_id) ? meta.get(r.game_id).n_ot : 0 }) }));
    cal[regime] = D.fit(pool.filter((r) => Number.isFinite(r.var_param)), { min_rows: cc.min_rows[regime] || 300, kappa: cc.kappa === 'fit' ? undefined : cc.kappa, variance: cc.variance, location_fit: cc.location_fit });
  }
  const E = st.E, Tm = st.Tm;
  const s2 = Number.isFinite(E.s2) ? E.s2 : prevS2;
  const teams = {};
  for (const id of E.ids) {
    const r = E.rating(id); const v = E.variance(id); const t = Tm.rating(id) || { off: 0, allow: 0 };
    /* the same parameter variance the walk-forward scored with (stableVarParam) */
    const stableVar = !cfg.calibration || cfg.calibration.parameter_variance !== 'engine';
    const lam = cfg.params.lambda == null ? TM.DEFAULT_PARAMS.lambda : cfg.params.lambda;
    const vo = stableVar ? prevS2 / (v.n_off * POSS_PER_GAME + lam) : Number.isFinite(v.off) ? v.off : s2 / (E.wOffSum[E.idx.get(id)] + E.o.lambdaOff);
    const va = stableVar ? prevS2 / (v.n_off * POSS_PER_GAME + lam) : Number.isFinite(v.allow) ? v.allow : s2 / (E.wDefSum[E.idx.get(id)] + E.o.lambdaAllow);
    teams[id] = { off: r.off, allow: r.allow, var_off: vo, var_allow: va, games: v.n_off, pace_off: t.off, pace_allow: t.allow };
  }
  const snap = DS.snapshot(games, asOfMs);
  const art = {
    schema: ARTIFACT_SCHEMA, model_id: cfg.model_id, version: cfg.version, engine: cfg.engine, config: cfg, config_sha256: configHash(cfg),
    as_of: new Date(asOfMs).toISOString(), season: target, training_snapshot: snap, code_sha256: codeHash(),
    state: { mu: E.mu, eta: E.eta, s2, s2_prev_season: prevS2, s2_source: Number.isFinite(E.s2) ? 'this season' : 'last season (no game absorbed yet)', lambda_off: E.o.lambdaOff, lambda_allow: E.o.lambdaAllow, tau: Tm.mu, nond1: st.nond1 },
    teams, calibration: cal,
    games_absorbed_this_season: egFinal.filter((g) => g.season === target).length,
    scheduled_teams_with_prior: new Set(egSched.flatMap((g) => [g.home, g.away])).size,
  };
  art.artifact_sha256 = hash(Object.assign({}, art, { artifact_sha256: undefined }));
  return art;
}

/** the raw model row of a future game from an artifact (team_model.js predictRow, same arithmetic) */
function rawFromArtifact(art, g) {
  const S = art.state; const T = art.teams;
  const isD1 = (x) => x === true || x === 1;
  const hD1 = isD1(g.home_d1), aD1 = isD1(g.away_d1);
  const v = g.neutral ? 0 : 1;
  const rating = (id) => T[id] || null;
  const lam = art.config.params.lambda == null ? TM.DEFAULT_PARAMS.lambda : art.config.params.lambda;
  const stableVar = !art.config.calibration || art.config.calibration.parameter_variance !== 'engine';
  const unseen = stableVar ? S.s2_prev_season / lam : null;
  const variance = (id) => (T[id] ? { off: T[id].var_off, allow: T[id].var_allow, n: T[id].games } : stableVar ? { off: unseen, allow: unseen, n: 0 } : { off: S.s2 / S.lambda_off, allow: S.s2 / S.lambda_allow, n: 0 });
  const side = (id, d1, opp, oppD1, vv) => {
    if (d1 && oppD1) { const a = rating(id); const b = rating(opp); return S.mu + (a ? a.off : 0) + (b ? b.allow : 0) + S.eta * vv; }
    if (d1) { const a = rating(id); return S.mu + (a ? a.off : 0) + S.nond1.allow + S.eta * vv; }
    const b = rating(opp); return S.mu + S.nond1.off + (b ? b.allow : 0) + S.eta * vv;
  };
  const zh = side(g.home_id, hD1, g.away_id, aD1, v); const za = side(g.away_id, aD1, g.home_id, hD1, -v);
  const pace = (id, d1) => { if (!d1) return { off: S.nond1.pace, allow: S.nond1.pace }; const r = rating(id); return r ? { off: r.pace_off, allow: r.pace_allow } : { off: 0, allow: 0 }; };
  const th = pace(g.home_id, hD1); const ta = pace(g.away_id, aD1);
  const tempo = (S.tau == null ? 68 : S.tau) + 0.5 * (th.off + ta.allow + ta.off + th.allow);
  const vh = variance(g.home_id); const va = variance(g.away_id);
  const varParam = (tempo / 100) * (tempo / 100) * ((hD1 ? vh.off + vh.allow : 0) + (aD1 ? va.off + va.allow : 0));
  return { neutral: !!g.neutral, regime: hD1 && aD1 ? 'D1_D1' : hD1 || aD1 ? 'D1_OTHER' : 'OTHER_OTHER', tempo, margin: (tempo * (zh - za)) / 100, total: (tempo * (zh + za)) / 100,
    var_param: varParam, n_h: vh.n, n_a: va.n, ppp_h: zh, ppp_a: za };
}

/** the production forecast of one future game */
function predict(art, g) {
  const raw = rawFromArtifact(art, g);
  if (raw.regime === 'OTHER_OTHER') return { raw, available: false, reason: 'neither team is a rated Division I team' };
  const cal = art.calibration[raw.regime];
  if (!cal) return { raw, available: false, reason: 'no calibration for regime ' + raw.regime + ' (too few earlier games)' };
  return { raw, available: true, fc: D.forecast(raw, cal) };
}

/** the latent-strength scale the simulator draws once per team per run (dist.strengthScale) */
function teamStrengthSd(art, teamId) {
  const cal = art.calibration.D1_D1; const t = art.teams[teamId];
  if (!cal || !t) return null;
  return Math.sqrt(D.strengthScale(cal) * (t.var_off + t.var_allow));
}

module.exports = { ARTIFACT_SCHEMA, DEFAULT_CALIBRATION, CODE_FILES, codeHash, configHash, hash, stable, openingVariance, stableVarParam, POSS_PER_GAME, researchRows, calibrateCausal, incumbentRows, currentIncumbentVersion, buildArtifact, rawFromArtifact, predict, teamStrengthSd, seasonList };
