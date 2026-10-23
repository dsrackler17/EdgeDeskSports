#!/usr/bin/env node
'use strict';
/* ===========================================================================
   How uncertain is a team's strength when its ratings are frozen?

     node basketball/ncaam_forecast/strength.js     writes validation/strength_uncertainty.json

   The tournament simulator draws ONE latent offset per team per run and keeps
   it through every round. Its variance V must be measured, not assumed, and
   it must not double count: the calibrated single-game variance already
   contains it (module.ts uses sd_game^2 = sd^2 - V_a - V_b).

   Method (the NFL study's within-club residual covariance, simulator/src/
   research/nfl_strength_uncertainty.ts, adapted): for each season, freeze the
   ratings on 1 March (an artifact as of that moment: nothing after it is
   read), forecast every later D1-v-D1 game from the FROZEN artifact
   (conference tournaments, NCAA, NIT and other postseason), and take the
   regulation-margin residuals signed toward each team. If team t's frozen
   strength is off by d_t, every residual signed toward t shares d_t, so the
   mean product of two DIFFERENT games' residuals of the same team (different
   opponents) estimates Var(d_t) = V, in margin points^2.
   Interval: bootstrap over seasons (games of a season share a freeze), 1,000
   resamples. The 2024-2026 NCAA tournament games are the final tournament
   holdout and are EXCLUDED from this study.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const D = require('./dist');
const U = require('../ncaam_research/lib/util');
const SEL = require('./select');

const OUT = path.join(C.PATHS.validation, 'strength_uncertainty.json');

function freezeMs(season) { return Date.parse((season) + '-03-01T05:00:00Z'); }

/** frozen-forecast residuals after the freeze, signed per team */
function seasonResiduals(all, cfg, season, cache) {
  const at = freezeMs(season);
  const art = MD.buildArtifact(all, cfg, at, { season, cache });
  const cal = art.calibration.D1_D1;
  const out = [];
  for (const g of all) {
    if (g.season !== season || g.status !== 'FINAL' || !g.score_ok || g.start_ms < at) continue;
    if (!(g.home_d1 && g.away_d1)) continue;
    if (g.event === 'ncaa_tournament' && SEL.PROTOCOL.tournament_holdout.includes(season)) continue;
    const raw = MD.rawFromArtifact(art, g);
    const r = D.regulation(raw, cal);
    const yReg = g.n_ot > 0 ? 0 : g.hs - g.as;
    out.push({ game_id: g.game_id, season, home: g.home_id, away: g.away_id, e: yReg - r.mu, sd: r.sd, event: g.event });
  }
  return { rows: out, artifact_sha256: art.artifact_sha256 };
}

function covariance(rows) {
  const by = new Map();
  for (const r of rows) for (const [t, sg, opp] of [[r.home, 1, r.away], [r.away, -1, r.home]]) {
    const k = r.season + ':' + t; if (!by.has(k)) by.set(k, []); by.get(k).push({ e: sg * r.e, opp });
  }
  let s = 0, n = 0, e2 = 0, ne = 0;
  for (const xs of by.values()) for (let i = 0; i < xs.length; i++) { e2 += xs[i].e * xs[i].e; ne++; for (let j = i + 1; j < xs.length; j++) if (xs[i].opp !== xs[j].opp) { s += xs[i].e * xs[j].e; n++; } }
  return { cov: n ? s / n : null, pairs: n, mean_sq_residual: ne ? e2 / ne : null };
}

function run() {
  const sel = JSON.parse(fs.readFileSync(SEL.FILE, 'utf8'));
  const cfg = { model_id: 'ncaam_adjeff', version: 'study', engine: 'research_team_model', params: sel.chosen, calibration: sel.calibration };
  const all = DS.load();
  const seasons = []; for (let s = 2012; s <= 2026; s++) if (s !== 2020) seasons.push(s);
  /* one walk of every completed season serves every freeze */
  const W = MD.researchRows(DS.engineGames(all.filter((g) => g.season <= 2025)), cfg);
  const per = {}; const all_rows = [];
  for (const s of seasons) {
    const cache = { rows: W.rows.filter((r) => r.season < s), states: W.states };
    const r = seasonResiduals(all, cfg, s, cache);
    const c = covariance(r.rows);
    per[s] = { games: r.rows.length, pairs: c.pairs, cov: U.r(c.cov, 3), mean_sq_residual: U.r(c.mean_sq_residual, 1), artifact_sha256: r.artifact_sha256 };
    all_rows.push(...r.rows);
    console.log('[strength] ' + s + ' games ' + r.rows.length + ' cov ' + U.r(c.cov, 3));
  }
  const pooled = covariance(all_rows);
  const bySeason = new Map(); for (const r of all_rows) { if (!bySeason.has(r.season)) bySeason.set(r.season, []); bySeason.get(r.season).push(r); }
  const keys = [...bySeason.keys()]; const rnd = U.rng(20261023); const boots = [];
  for (let b = 0; b < 1000; b++) { const pick = []; for (let i = 0; i < keys.length; i++) pick.push(...bySeason.get(keys[Math.floor(rnd() * keys.length)]).map((x) => Object.assign({}, x, { season: x.season * 100 + i }))); boots.push(covariance(pick).cov); }
  boots.sort((a, b) => a - b);
  const V = Math.max(0, pooled.cov);
  const doc = {
    schema: 'edgedesk_ncaam_fc_strength_v1', generated_at: new Date().toISOString(), selection_hash: sel.hash,
    method: 'within-team covariance of frozen-forecast regulation-margin residuals after a 1 March freeze, different opponents only; season bootstrap',
    freeze: '1 March 05:00 UTC of each season (an artifact as of that moment)', excluded: 'NCAA tournament games of the 2024-2026 tournament holdout',
    seasons, per_season: per,
    estimate: { variance_margin_pts2: U.r(V, 4), sd_margin_pts: U.r(Math.sqrt(V), 4), ci95: [U.r(Math.max(0, boots[25]), 4), U.r(Math.max(0, boots[974]), 4)], pairs: pooled.pairs, games: all_rows.length, mean_sq_residual: U.r(pooled.mean_sq_residual, 2) },
    use: 'the simulator draws d_t ~ Normal(0, V) once per team per run; each game keeps sd^2 - V_a - V_b of the calibrated variance',
  };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('[strength] V = ' + doc.estimate.variance_margin_pts2 + ' pts^2 (sd ' + doc.estimate.sd_margin_pts + '), 95% CI ' + JSON.stringify(doc.estimate.ci95));
  return doc;
}

module.exports = { OUT, freezeMs, covariance, seasonResiduals };
if (require.main === module) run();
