#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk basketball — does the Division I fix earn its place?

     node basketball/eval_d1_fix.js --league ncaam

   The audit (docs/model-loop/audit_report.md, CBB) found two defects in the
   college ratings that only matter when non-Division I opponents are in the
   data: a team with a handful of games against D1 opposition starts each
   season carried from a rating built on 3-4 blowouts, and the league mean
   (mu) and home edge (h) are fitted on games that include those blowouts.
   `d1_fix` (basketball/model.js) gives non-D1 teams a learned non-D1 prior
   and fits mu and h on D1-vs-D1 games only.

   Same walk-forward as basketball/walkforward.js: one causal pass per
   variant, calibration fitted on the three seasons before, tuned params from
   the SELECTION window. The rule is decided here, before the run:
     promote only if the CONFIRMATION window (2019 on) improves moneyline log
     loss AND margin MAE on D1-vs-D1 games, the paired 95% interval of the
     log-loss difference is below zero, and the selection window is no worse.
   Writes basketball/validation/<league>_d1_fix.json either way.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const W = require('./walkforward');
const P = require('../engine/lab/protocol');
const V = require('../engine/validation');
const C = require('./config');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const league = arg('league', 'ncaam');
const D1_MIN_GAMES = 15; // a season's D1 programme plays 25+; a non-D1 visitor 1-4

const tuning = JSON.parse(fs.readFileSync(C.PATHS.tuning(league), 'utf8'));
const win = W.windowsFor(league);
const { games } = W.load(league);

/* D1 membership by season from the results themselves (ex post: used only to
   pick which games are scored, never as a model input) */
const nBy = new Map();
for (const g of games) for (const id of [g.home_id, g.away_id]) { const k = g.season + '|' + id; nBy.set(k, (nBy.get(k) || 0) + 1); }
const d1 = (s, id) => (nBy.get(s + '|' + id) || 0) >= D1_MIN_GAMES;

function run(params) {
  const { rows, ratings } = W.pass(games, params, tuning.elo);
  const { scored } = W.score(rows);
  return { rows: scored.filter((r) => r.season >= win.selection[0]), ratings };
}

const base = run(tuning.chosen);
const fix = run(Object.assign({}, tuning.chosen, { d1_fix: true }));
const fixById = new Map(fix.rows.map((r) => [r.id, r]));

function summary(sub, pick) {
  const n = sub.length; if (!n) return { n: 0 };
  let ll = 0, br = 0, mae = 0, bias = 0;
  for (const r of sub) { const x = pick(r); const p = x.p.points; ll += V.logLoss(p, r.y.hw); br += Math.pow(p - r.y.hw, 2); mae += Math.abs(r.y.margin - x.p.margin.mu); bias += r.y.margin - x.p.margin.mu; }
  return { n, ml_log_loss: V.r(ll / n, 5), brier: V.r(br / n, 5), margin_mae: V.r(mae / n, 4), margin_bias: V.r(bias / n, 4) };
}

const groups = {
  d1_vs_d1: (r) => d1(r.season, r.home) && d1(r.season, r.away),
  d1_home_neutral_or_road: (r) => d1(r.season, r.home) && d1(r.season, r.away) && r.neutral,
  involves_non_d1: (r) => !(d1(r.season, r.home) && d1(r.season, r.away)),
  all: () => true,
};
const out = { schema: 'edgedesk_bb_d1_fix_eval_v1', league, generated_at: new Date().toISOString(), params: { base: tuning.chosen, fix: Object.assign({}, tuning.chosen, { d1_fix: true }) },
  rule: 'promote only if the confirmation window improves D1-vs-D1 moneyline log loss AND margin MAE, the paired 95% interval of the log-loss difference is below zero, and the selection window is no worse on either',
  d1_definition: '>= ' + D1_MIN_GAMES + ' games in the season in the data (ex post; picks the scored games only)', windows: {} };

for (const [wname, w] of Object.entries({ selection: win.selection, confirmation: win.confirmation, live: win.live })) {
  const inW = base.rows.filter((r) => P.inWin(r.season, w) && fixById.has(r.id));
  const o = {};
  for (const [gname, f] of Object.entries(groups)) {
    const sub = inW.filter(f);
    o[gname] = { base: summary(sub, (r) => r), d1_fix: summary(sub, (r) => fixById.get(r.id)) };
    if (sub.length >= 30) {
      o[gname].log_loss_diff = P.compare(sub, (r) => V.logLoss(fixById.get(r.id).p.points, r.y.hw), (r) => V.logLoss(r.p.points, r.y.hw));
      o[gname].mae_diff = P.compare(sub, (r) => Math.abs(r.y.margin - fixById.get(r.id).p.margin.mu), (r) => Math.abs(r.y.margin - r.p.margin.mu));
    }
  }
  /* home bias by month on D1-vs-D1 home games: does the fix take out the early-season over-pricing? */
  const months = {};
  for (const r of inW.filter((x) => groups.d1_vs_d1(x) && !x.neutral)) {
    const m = r.date.slice(5, 7); const f = fixById.get(r.id);
    const a = months[m] || (months[m] = { n: 0, base: 0, d1_fix: 0 });
    a.n++; a.base += r.y.margin - r.p.margin.mu; a.d1_fix += r.y.margin - f.p.margin.mu;
  }
  o.home_bias_by_month = Object.fromEntries(Object.entries(months).sort().map(([m, a]) => [m, { n: a.n, base: V.r(a.base / a.n, 3), d1_fix: V.r(a.d1_fix / a.n, 3) }]));
  out.windows[wname] = Object.assign({ seasons: w }, o);
}

const cs = out.windows.confirmation.d1_vs_d1, ss = out.windows.selection.d1_vs_d1;
const pass = cs.d1_fix.ml_log_loss < cs.base.ml_log_loss && cs.d1_fix.margin_mae < cs.base.margin_mae
  && cs.log_loss_diff && cs.log_loss_diff.ci95 && cs.log_loss_diff.ci95[1] < 0
  && ss.d1_fix.ml_log_loss <= ss.base.ml_log_loss && ss.d1_fix.margin_mae <= ss.base.margin_mae;
const dump = fix.ratings.dump();
out.fitted = { base_h: base.ratings.dump().h, fix_h: dump.h, base_mu: base.ratings.dump().mu, fix_mu: dump.mu, non_d1_prior: dump.nd1, by_season: fix.ratings.trace || [] };
out.decision = pass ? 'PROMOTE' : 'KEEP OFF';
fs.mkdirSync(path.dirname(C.PATHS.validation(league)), { recursive: true });
const file = path.join(path.dirname(C.PATHS.validation(league)), league + '_d1_fix.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
/* every run is disclosed: the decision file is the latest, the runs log is all of them */
const cs1 = out.windows.confirmation.d1_vs_d1, ss1 = out.windows.selection.d1_vs_d1;
fs.appendFileSync(path.join(path.dirname(file), league + '_d1_fix_runs.jsonl'), JSON.stringify({ at: out.generated_at, model_sha: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'model.js'))).digest('hex').slice(0, 16),
  note: arg('note', ''), decision: out.decision, fitted: out.fitted, confirmation_d1: { base: cs1.base, d1_fix: cs1.d1_fix, dLL: cs1.log_loss_diff, dMAE: cs1.mae_diff }, selection_d1: { base: ss1.base, d1_fix: ss1.d1_fix, dLL: ss1.log_loss_diff } }) + '\n');
for (const [wname, o] of Object.entries(out.windows)) for (const g of ['d1_vs_d1', 'involves_non_d1']) console.log(wname.padEnd(13) + g.padEnd(17) + JSON.stringify(o[g].base) + '\n' + ' '.repeat(30) + JSON.stringify(o[g].d1_fix) + (o[g].log_loss_diff ? '  dLL ' + JSON.stringify(o[g].log_loss_diff) : ''));
console.log('fitted', JSON.stringify(Object.assign({}, out.fitted, { by_season: undefined })));
for (const t of out.fitted.by_season) console.log('  ' + JSON.stringify(t));
console.log('decision: ' + out.decision + ' -> ' + path.relative(process.cwd(), file));
