#!/usr/bin/env node
/* ===========================================================================
   NFL v2 TRAINER — one configuration of football/nfl_model.js in, the params
   the board serves out (football/nfl_params_v2.js, GENERATED).

   It is the backtest's own code with nothing held out: the replay through the
   last completed season, ridge weights fitted on 2002..through, the margin PMF
   from every closing spread through then, any calibration from the
   walk-forward predictions, and the end-of-season rating state as the seeds
   the board starts the next season from. The validation it ships is the
   walk-forward record of that configuration (2010-2024, the 2025 holdout,
   the close beside it), never a number fitted on what it reports.

   Usage
     node football/research/nfl_v2/train.js --config <file.json|step4> [--through 2025]
          [--version nfl_v2.0.0] [--out football/nfl_params_v2.js] [--active] [--parent <version>]
   --config takes a results/step<N>.json (its promoted_cfg) or a JSON config.
   --active marks the params the ones the board serves (else shadow).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./backtest.js');
const D = require('./data.js');
const ROOT = path.join(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));

function readCfg(arg) {
  const f = /^step\d$/.test(arg) ? path.join(B.RES, arg + '.json') : path.resolve(arg);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { cfg: j.promoted_cfg || j.cfg || j, source: path.relative(ROOT, f) };
}
const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);
const r8 = (v) => (Number.isFinite(v) ? Math.round(v * 1e8) / 1e8 : v);

function train(cfg, through, opts) {
  opts = opts || {};
  /* the replay through `through`, and the seeds at its end */
  const names = M.featureNames(cfg);
  const st = M.newState(cfg);
  if (cfg.personnel.on) st.personnel = D.personnel();
  const rows = D.teamRows(cfg.source), qb = D.qbRows(), feats = [];
  for (const g of D.games()) {
    if (!g.done || g.season > through) continue;
    if (st.season !== g.season) M.seasonBreak(st, g.season);
    if (g.season >= B.FIRST_TRAIN) {
      const F = M.features(st, B.gameObj(g));
      const vec = (o, n) => n.map((k) => (Number.isFinite(o[k]) ? o[k] : 0));
      feats.push({ g, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa });
    }
    M.absorbCompleted(st, { home_team: g.home_raw, away_team: g.away_raw, home_score: g.home_score, away_score: g.away_score }, rows[g.id] || [], qb[g.id] || []);
    M.afterGame(st, B.gameObj(g));
  }
  const fit = B.fit(cfg, feats);
  /* the seeds: every club's FINAL rating on each feature (the next season's
     prior is carry x this), QB values, league means, market ratings, home field */
  const seeds = { season: through, team: {}, lmean: {}, qb: {}, team_qb: {}, mr: {}, mkt: st.mkt, hfa: JSON.parse(JSON.stringify(st.hfa)) };
  for (const t of Object.keys(st.team)) { const snap = M.snapshot(st, t); seeds.team[t] = {}; for (const f of M.RATE_FEATS) seeds.team[t][f] = r8(snap[f]); }
  for (const f of Object.keys(st.lmean)) seeds.lmean[f] = r8(st.lmean[f]);
  for (const id of Object.keys(st.qb)) seeds.qb[id] = { v: r8(st.qb[id].v), n: st.qb[id].n };
  for (const t of Object.keys(st.teamQb)) seeds.team_qb[t] = r8(st.teamQb[t]);
  for (const t of Object.keys(st.mr)) seeds.mr[t] = r8(st.mr[t]);
  /* the season in progress is closed into the home-field history, as the break would */
  if (st.hfa.cur.n > 0) { seeds.hfa.seasons[through] = { sum: st.hfa.cur.sum, n: st.hfa.cur.n }; seeds.hfa.cur = { sum: 0, n: 0 }; }
  /* calibration from the walk-forward predictions (seasons <= through) */
  let calibration = { kind: 'none' };
  if (cfg.calibration.kind === 'isotonic') {
    const wf = B.walkForward(B.replay(cfg));
    calibration = M.fitIsotonic(wf.preds.filter((p) => p.season <= through && p.y != null).map((p) => [p.p_raw, p.y]));
  }
  const pack = (m, n) => ({ names: n, w: m.w.map(r8), b: r8(m.b) });
  return {
    cfg, trained_through_season: through,
    spread: pack(fit.spread, names.spread), ctx: pack(fit.ctx, names.ctx), total: pack(fit.total, names.total),
    margin_pmf_by_spread: B.pmfFor(through + 1), pmf_bandwidth: 3,
    calibration, seeds,
  };
}

/* the params file the board serves, written for a configuration: trained
   through `through`, stamped with its walk-forward record. Returns the doc. */
function writeParams(o) {
  const cfg = o.cfg, through = o.through, version = o.version;
  const out = path.resolve(o.out || path.join(ROOT, 'football', 'nfl_params_v2.js'));
  const P = train(cfg, through);
  /* the walk-forward record this configuration earned (2010-2024, the 2025 holdout) */
  const ev = o.evaluation || B.evaluate(cfg);
  const cfgHash = crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
  const doc = Object.assign({
    schema: 'edgedesk_nfl_params_v2', model_version: version, config_sha: cfgHash, built_at: o.builtAt || new Date().toISOString(),
    active: !!o.active, config_source: o.source || null, parent_version: o.parent || null,
    validation: {
      method: 'walk-forward (football/research/nfl_v2/backtest.js): weights, PMF and calibration fitted on earlier seasons only',
      valid_2010_2024: B.slim(ev.valid), holdout_2025: B.slim(ev.holdout),
      close_valid: { mae: +ev.valid.close.mae.toFixed(4), logloss: +ev.valid.close.logloss.toFixed(5), brier: +ev.valid.close.brier.toFixed(5) },
      close_holdout: { mae: +ev.holdout.close.mae.toFixed(4), logloss: +ev.holdout.close.logloss.toFixed(5), brier: +ev.holdout.close.brier.toFixed(5) },
      beats_closing_line: ev.holdout.model.mae < ev.holdout.close.mae && ev.holdout.model.logloss < ev.holdout.close.logloss,
    },
    provenance: { games: 'nflverse/nfldata games.csv', team_stats: cfg.source === 'stw' ? 'nflverse-data stats_team_week' : 'nflverse-data play_by_play (' + cfg.source + ')',
      qb: 'nflverse-data stats_player_week (training rule: the club passer with the most dropbacks)', personnel: cfg.personnel.on ? 'nflverse-data snap_counts + weekly_rosters + stats_player_week' : null,
      preregistration: 'football/research/nfl_v2/preregistration.json' },
  }, P);
  const js = "if(typeof window==='undefined'){globalThis.window=globalThis;}\n"
    + '/* EdgeDesk NFL model v2 — trained parameters. GENERATED by football/research/nfl_v2/train.js;\n'
    + '   never edit by hand. The configuration, the walk-forward record and the seeds are all here. */\n'
    + 'window.EDNflParamsV2 = ' + JSON.stringify(doc) + ';\n'
    + "if(typeof module!=='undefined'&&module.exports)module.exports=window.EDNflParamsV2;\n";
  fs.writeFileSync(out, js);
  return { doc, out, js };
}

function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const { cfg, source } = readCfg(v('--config', 'step4'));
  const through = +v('--through', '2025');
  const version = v('--version', 'nfl_v2.0.0');
  const { doc, out } = writeParams({ cfg, source, through, version, out: v('--out', null), active: a.includes('--active'), parent: v('--parent', null) });
  console.log(`wrote ${path.relative(ROOT, out)}: ${version} (${doc.config_sha}), trained through ${through}, active ${doc.active}; 2025 holdout MAE ${doc.validation.holdout_2025.mae} vs close ${doc.validation.close_holdout.mae}`);
}
if (require.main === module) main();
module.exports = { train, writeParams, readCfg };
