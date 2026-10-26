#!/usr/bin/env node
/* ===========================================================================
   THE PRIOR-DECAY BACKTEST (preregistration.json, H-NFL-PD-01) — validation only.

   Runs exactly what the preregistration fixed, once:
     v1        the served edgedesk_nfl_v2.1.0 configuration (football/nfl_params_v2.js
               cfg), refitted walk-forward: the incumbent. Its served weights are
               not touched; the comparison refits both models on the same seasons.
     PD-K200, PD-K100, PD-K400
               v1 + cfg.pd = { on: true, k_db } (football/nfl_model.js qbPriorGap)
   through football/research/nfl_v2/backtest.js (the protocol every NFL variant
   is judged by): for each season S the ridge weights, context model and margin
   PMF are fitted on 2002..S-1 and S is predicted pregame, game by game.

   THE HOLDOUT IS NOT TOUCHED. The replay's rows are cut at 2024 before the walk-
   forward runs, so no 2025 (or 2026) game is predicted, scored or written.

   Scores, on 2010-2024: Brier (primary), log loss, margin MAE, Brier per season;
   and CLV in spread points at the early-week line on 2020-2024
   (export_early_lines.py, the model loop's definitions): bets where
   |model margin - early line| >= 2, points the line moved early -> close toward
   the model's side, moves over 10 points dropped. Without the early-line file
   the CLV criterion is NOT EVALUATED and no variant can be a finalist.

   Writes prior_decay/results.json and appends each run to
   results/variants.jsonl (family prior_decay, holdout_looked: false).

   Usage: node football/research/nfl_v2/prior_decay/run.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('../backtest.js');
const ROOT = path.join(__dirname, '..', '..', '..', '..');
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
const PV = require(path.join(ROOT, 'football', 'nfl_params_v2.js'));

const PRE_FILE = path.join(__dirname, 'preregistration.json');
const OUT = path.join(__dirname, 'results.json');
const EARLY = path.join(__dirname, '..', '.cache', 'early_lines_nfl.csv');
const VALID = [2010, 2024], CLV_SEASONS = [2020, 2024], CLV_THRESHOLD = 2, MAX_MOVE = 10;
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const r5 = (x) => (Number.isFinite(x) ? Math.round(x * 100000) / 100000 : null);

/* the preregistration, unedited */
function loadPre() {
  const P = JSON.parse(fs.readFileSync(PRE_FILE, 'utf8'));
  const sha = crypto.createHash('sha256').update(JSON.stringify(P.studies)).digest('hex');
  if (sha !== P.content_sha256) throw new Error('preregistration.json was edited after registration (content_sha256 mismatch): refusing to run');
  return P;
}

/* the early-week and closing spreads (home margin, nflverse convention) */
function earlyLines() {
  if (!fs.existsSync(EARLY)) return null;
  const lines = fs.readFileSync(EARLY, 'utf8').split(/\r?\n/).filter(Boolean), head = lines[0].split(','), out = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','), o = {}; head.forEach((h, j) => { o[h] = c[j]; });
    const e = Number(o.early_spread), cl = Number(o.close_spread);
    if (o.early_spread === '' || o.close_spread === '' || !Number.isFinite(e) || !Number.isFinite(cl)) continue;
    if (String(o.early_live).toLowerCase() !== 'true' || String(o.close_live).toLowerCase() !== 'true') continue;
    out[o.game_id] = { early: e, close: cl };
  }
  return out;
}

/* CLV at the early checkpoint: model margin vs the early line, the move to the close toward the model's side */
function clv(preds, lines) {
  if (!lines) return null;
  const v = [];
  preds.forEach((p) => {
    if (p.season < CLV_SEASONS[0] || p.season > CLV_SEASONS[1] || p.week <= 1) return;
    const L = lines[p.id]; if (!L) return;
    if (Math.abs(L.close - L.early) > MAX_MOVE) return;
    const gap = p.model - L.early;
    if (Math.abs(gap) < CLV_THRESHOLD) return;
    v.push((gap > 0 ? 1 : -1) * (L.close - L.early));
  });
  const n = v.length, mean = n ? v.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : null;
  return { n, mean_pts: r4(mean), ci95: n > 1 ? [r4(mean - 1.96 * sd / Math.sqrt(n)), r4(mean + 1.96 * sd / Math.sqrt(n))] : null,
    toward: v.filter((x) => x > 0).length, unmoved: v.filter((x) => x === 0).length, away: v.filter((x) => x < 0).length,
    threshold_pts: CLV_THRESHOLD, seasons: CLV_SEASONS };
}

function run(label, cfg, lines) {
  const rep = B.replay(cfg);
  /* the holdout is never predicted: the rows end at 2024 before the walk-forward */
  const cut = Object.assign({}, rep, { rows: rep.rows.filter((r) => r.g.season <= VALID[1]) });
  const wf = B.walkForward(cut);
  const preds = wf.preds.filter((p) => p.season <= VALID[1]);
  if (preds.some((p) => p.season >= 2025)) throw new Error('a holdout game was predicted');
  const s = B.score(preds, B.range(VALID[0], VALID[1]));
  const bySeason = B.range(VALID[0], VALID[1]).map((y) => { const x = B.score(preds, [y]); return { season: y, n: x.n, brier: r5(x.model.brier), logloss: r5(x.model.logloss), mae: r4(x.model.mae) }; });
  return { label, valid: { n: s.n, brier: r5(s.model.brier), logloss: r5(s.model.logloss), mae: r4(s.model.mae), ece: r4(s.model.ece), cal_slope: r4(s.model.slope) },
    close: { brier: r5(s.close.brier), logloss: r5(s.close.logloss), mae: r4(s.close.mae) }, by_season: bySeason, clv: clv(preds, lines),
    weights: wf.fits[VALID[1]] ? { names: M.featureNames(cfg).spread, w: wf.fits[VALID[1]].spread.w.map(r4), fitted_through: VALID[1] - 1 } : null };
}

function verdict(cand, inc) {
  const wins = cand.by_season.filter((x, i) => x.brier < inc.by_season[i].brier).length;
  const checks = {
    brier_lower: cand.valid.brier < inc.valid.brier,
    logloss_not_worse: cand.valid.logloss <= inc.valid.logloss,
    mae_within_0_01: cand.valid.mae <= inc.valid.mae + 0.01,
    brier_lower_in_9_of_15_seasons: wins >= 9,
    clv_at_least_v1: cand.clv && inc.clv ? cand.clv.mean_pts >= inc.clv.mean_pts : null,
  };
  const finalist = Object.values(checks).every((x) => x === true);
  return { finalist, checks, seasons_brier_better: wins,
    status: 'EXPERIMENTAL', passed: false,
    reason: finalist ? 'a finalist on 2010-2024; the 2025 holdout look (stage B) is a separate preregistered run and has not been made'
      : 'not a finalist: ' + Object.keys(checks).filter((k) => checks[k] !== true).map((k) => k + (checks[k] === null ? ' (not evaluated)' : '')).join(', ') };
}

function main() {
  const P = loadPre(), S = P.studies[0];
  const lines = earlyLines();
  if (!lines) console.log('NOTE: no early-line file (' + path.relative(ROOT, EARLY) + '); CLV is not evaluated, so no variant can be a finalist');
  const inc = run('v1 (edgedesk_nfl_v2.1.0 configuration, refitted)', M.config(PV.cfg), lines);
  const vars = S.variants.map((v) => Object.assign({ id: v.id, k_db: v.k_db }, run(v.id, M.config(Object.assign({}, PV.cfg, { pd: { on: true, k_db: v.k_db } })), lines)));
  if (vars.length !== S.variants_planned) throw new Error('ran ' + vars.length + ' variants, preregistered ' + S.variants_planned);
  /* selection, as registered: the lowest 2010-2024 Brier (ties: log loss) */
  const sel = vars.slice().sort((a, b) => a.valid.brier - b.valid.brier || a.valid.logloss - b.valid.logloss)[0];
  const V = verdict(sel, inc);
  const at = new Date().toISOString();
  const doc = { schema: 'edgedesk_nfl_prior_decay_results_v1', study: S.id, generated_at: at, preregistration: { registered_at: P.registered_at, content_sha256: P.content_sha256 },
    protocol: 'football/research/nfl_v2/backtest.js walk-forward; validation 2010-2024; the 2025 holdout was not predicted', holdout_looked: false,
    variants_tried: vars.length, early_lines: lines ? { file: path.relative(ROOT, EARLY), games: Object.keys(lines).length } : null,
    incumbent: inc, variants: vars, selected: sel.id, verdict: V };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  [inc].concat(vars).forEach((x) => B.logVariant({ family: 'prior_decay', study: S.id, label: x.label, k_db: x.k_db || null, valid: x.valid, clv: x.clv, holdout_looked: false }));
  const line = (x) => `${x.label.padEnd(50)} Brier ${x.valid.brier} LL ${x.valid.logloss} MAE ${x.valid.mae} | CLV ${x.clv ? x.clv.mean_pts + ' pts on ' + x.clv.n + ' bets' : 'not evaluated'}`;
  console.log(line(inc)); vars.forEach((x) => console.log(line(x)));
  console.log(`selected ${sel.id}: ${V.finalist ? 'FINALIST' : 'REJECTED'} (${V.reason}); status EXPERIMENTAL; holdout not looked at`);
  console.log('wrote ' + path.relative(ROOT, OUT));
}
module.exports = { loadPre, earlyLines, clv, verdict };
if (require.main === module) main();
