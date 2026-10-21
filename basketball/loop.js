#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk basketball — the weekly learning loop (NBA, WNBA, men's and
   women's college), the same contract as the NFL loop
   (model_loop/adapters/nfl/weekly.py, docs/model-loop/README.md).

     node basketball/loop.js research --league ncaam [--only a,b] [--max 8]
     node basketball/loop.js report   --league ncaam
     node basketball/loop.js all      [--league nba,ncaam]      (research + report)

   TWO JOBS, KEPT APART.
     refresh   basketball/walkforward.js, every day (lab-build.yml): the ratings
               re-fitted on the newest results with the SERVED configuration.
               It never changes a parameter.
     research  this file, weekly: where the misses concentrate, candidate
               changes from a fixed catalogue, each walked forward over every
               scored season exactly as production does (basketball/walkforward.js
               pass + score: ratings point-in-time, calibration from the three
               seasons before). A candidate replaces the served configuration
               only if, over the full window (selection start to date), it
               lowers moneyline log loss by >= 0.0002 with the paired 95%
               interval below zero AND lowers margin MAE by >= 0.005, and is no
               worse on either in the most recent full season. One week never
               decides anything. Every candidate, pass or fail, is logged.

   Outcome-graded only: no licensed archive of timestamped closing prices
   exists for basketball here, so nothing is compared with the market and
   every version stays EXPERIMENTAL in the registry.

   Writes docs/model-loop/<league>/versions.json (current = served),
   candidates.jsonl, weekly/<date>.json and weekly_model_report.md.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const W = require('./walkforward');
const P = require('../engine/lab/protocol');
const V = require('../engine/validation');

const ROOT = path.join(__dirname, '..');
const DOCS = (league) => path.join(ROOT, 'docs', 'model-loop', league);
const MIN_GAIN = { logloss: 0.0002, mae: 0.005 };
const MAX_CANDIDATES = 8;

/* the candidate catalogue: [id, param, [kind, value], patterns it answers, target]. The target is
   what the change can move: 'side' (moneyline and margin) or 'total' (mu cancels in every margin, so
   a scoring-level change is judged on totals, with moneyline and margin required not to get worse) */
const CATALOGUE = [
  ['recency_faster', 'half_life_days', ['mul', 0.5], ['early_season', 'late_season']],
  ['recency_slower', 'half_life_days', ['mul', 2], ['late_season']],
  ['prior_weaker', 'prior_games', ['mul', 0.5], ['early_season']],
  ['prior_stronger', 'prior_games', ['mul', 2], ['early_season']],
  ['carry_lower', 'carry', ['add', -0.1], ['early_season']],
  ['carry_higher', 'carry', ['add', 0.1], ['early_season']],
  ['home_edge_looser', 'k_h', ['mul', 0.5], ['home', 'home_early']],
  ['home_edge_tighter', 'k_h', ['mul', 2], ['home']],
  ['scoring_level_looser', 'k_mu', ['mul', 0.5], ['total', 'total_early'], 'total'],
  ['scoring_level_tighter', 'k_mu', ['mul', 2], ['total'], 'total'],
];

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
function stable(o) {
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
const configHash = (c) => crypto.createHash('sha256').update(stable(c)).digest('hex');

/* ------------------------------------------------------------ versions */
function versionsPath(league) { return path.join(DOCS(league), 'versions.json'); }
function loadVersions(league) { const p = versionsPath(league); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function saveVersions(league, doc) { fs.mkdirSync(DOCS(league), { recursive: true }); fs.writeFileSync(versionsPath(league), JSON.stringify(doc, null, 1) + '\n'); }
function current(doc) { return doc.versions.find((v) => v.version === doc.current); }

const servedParams = W.servedParams;

function ensureVersions(league, evidence) {
  let doc = loadVersions(league);
  if (doc) return doc;
  const cfg = servedParams(league);
  doc = { schema: 'edgedesk_model_loop_versions_v1', sport: C.LEAGUES[league].label, league, current: '1.0.0',
    versions: [{ version: '1.0.0', parent: null, config: cfg, config_sha256: configHash(cfg), status: 'SERVED', promoted_by: 'selection-window tuning',
      promoted_at: nowIso(), reason: 'The configuration basketball/walkforward.js served when the loop started: basketball/params/' + league + '_tuning.json `chosen`'
        + (C.LEAGUES[league].model ? ' with config.js `model` ' + JSON.stringify(C.LEAGUES[league].model) : '') + '.', evidence }] };
  saveVersions(league, doc);
  return doc;
}

function promote(league, doc, cfg, reason, evidence) {
  const [maj, min] = doc.current.split('.').map(Number);
  let m = min + 1; const taken = new Set(doc.versions.map((v) => v.version));
  while (taken.has(maj + '.' + m + '.0')) m++;
  const v = { version: maj + '.' + m + '.0', parent: doc.current, config: cfg, config_sha256: configHash(cfg), status: 'SERVED', promoted_by: 'weekly-loop', promoted_at: nowIso(), reason, evidence };
  for (const o of doc.versions) if (o.status === 'SERVED') o.status = 'RETIRED (rollback target)';
  doc.versions.push(v); doc.current = v.version;
  saveVersions(league, doc);
  return v;
}

/* ------------------------------------------------------------ evaluation */
function applyChange(cfg, param, how) {
  const cur = cfg[param]; const [kind, v] = how; let nv;
  if (kind === 'mul') { if (cur == null) return null; nv = +(cur * v).toFixed(6); }
  else if (kind === 'add') nv = +Math.min(1, Math.max(0, (cur || 0) + v)).toFixed(4);
  else nv = v;
  if (nv === cur) return null;
  return Object.assign({}, cfg, { [param]: nv });
}

function run(games, params, elo, from) {
  const { rows } = W.pass(games, params, elo);
  return W.score(rows).scored.filter((r) => r.season >= from);
}

/** the latest season with a full complement of games (a season just started is not one) */
function recentFullSeason(rows) {
  const n = new Map(); for (const r of rows) n.set(r.season, (n.get(r.season) || 0) + 1);
  const ss = [...n.keys()].sort((a, b) => a - b);
  for (let i = ss.length - 1; i > 0; i--) if (n.get(ss[i]) >= 0.7 * n.get(ss[i - 1])) return ss[i];
  return ss[ss.length - 1];
}

function metrics(rows) {
  if (!rows.length) return { n: 0 };
  let ll = 0, br = 0, mae = 0, tmae = 0;
  for (const r of rows) { ll += V.logLoss(r.p.points, r.y.hw); br += Math.pow(r.p.points - r.y.hw, 2); mae += Math.abs(r.y.margin - r.p.margin.mu); tmae += Math.abs(r.y.total - r.p.total.mu); }
  const n = rows.length;
  return { n, logloss: V.r(ll / n, 6), brier: V.r(br / n, 6), margin_mae: V.r(mae / n, 4), total_mae: V.r(tmae / n, 4) };
}

/** where the misses concentrate in the last two seasons: outcome bias (result - model) with t */
function errorAnalysis(rows, seasonFrom) {
  const d = rows.filter((r) => r.season >= seasonFrom);
  const out = [];
  const stat = (name, sel, note, field) => {
    const x = d.filter(sel); if (x.length < 50) return;
    const e = x.map((r) => field === 'total' ? r.y.total - r.p.total.mu : r.y.margin - r.p.margin.mu);
    const m = e.reduce((a, b) => a + b, 0) / e.length;
    const sd = Math.sqrt(e.reduce((a, b) => a + (b - m) * (b - m), 0) / (e.length - 1));
    out.push({ pattern: name, n: x.length, note, outcome_bias: V.r(m, 3), t: sd > 0 ? V.r(m / (sd / Math.sqrt(e.length)), 2) : null });
  };
  const early = (r) => Math.min(r.gh, r.ga) < 6;
  stat('home', (r) => !r.neutral, 'home games: result minus model, home side', 'margin');
  stat('home_early', (r) => !r.neutral && early(r), 'home games before either side has 6 games', 'margin');
  stat('neutral', (r) => r.neutral, 'neutral sites, listed home side', 'margin');
  stat('early_season', early, 'either side has played fewer than 6 games', 'margin');
  stat('late_season', (r) => Math.min(r.gh, r.ga) >= 20, 'both sides have played 20+', 'margin');
  stat('big_favourites', (r) => Math.abs(r.p.margin.mu) >= 10, 'projected margin 10+ either way (sign: toward the favourite)', 'margin');
  stat('back_to_back', (r) => r.x_rest !== 0, 'one side on a back-to-back', 'margin');
  stat('total', () => true, 'total points: result minus model', 'total');
  stat('total_early', early, 'total points, either side under 6 games', 'total');
  /* big favourites read toward the favourite: flip the sign for away favourites */
  const bf = out.find((p) => p.pattern === 'big_favourites');
  if (bf) {
    const x = d.filter((r) => Math.abs(r.p.margin.mu) >= 10);
    const e = x.map((r) => (r.y.margin - r.p.margin.mu) * Math.sign(r.p.margin.mu));
    const m = e.reduce((a, b) => a + b, 0) / e.length; const sd = Math.sqrt(e.reduce((a, b) => a + (b - m) * (b - m), 0) / (e.length - 1));
    bf.outcome_bias = V.r(m, 3); bf.t = V.r(m / (sd / Math.sqrt(e.length)), 2);
  }
  return out;
}

function rankCandidates(patterns, weekIndex, n) {
  n = n || MAX_CANDIDATES;
  const sig = patterns.map((p) => [Math.abs(p.t || 0), p.pattern]).sort((a, b) => b[0] - a[0]);
  let top = [];
  for (const [t, name] of sig) {
    if (t < 2 || top.length >= n - 2) break;
    top = top.concat(CATALOGUE.filter((c) => c[3].includes(name) && !top.includes(c[0])).map((c) => c[0]).slice(0, 2));
  }
  top = top.slice(0, n - 2);
  const rest = CATALOGUE.map((c) => c[0]).filter((c) => !top.includes(c));
  const k = weekIndex % Math.max(1, rest.length);
  return top.concat(rest.slice(k).concat(rest.slice(0, k)).slice(0, n - top.length));
}

/* ------------------------------------------------------------ research */
function research(league, opts) {
  opts = opts || {};
  const win = W.windowsFor(league);
  const tuning = JSON.parse(fs.readFileSync(C.PATHS.tuning(league), 'utf8'));
  const { games } = W.load(league);
  const from = win.selection[0];
  const served0 = servedParams(league);
  const base = run(games, served0, tuning.elo, from);
  const recent = recentFullSeason(base);
  const full0 = metrics(base), rec0 = metrics(base.filter((r) => r.season === recent));
  const doc = ensureVersions(league, { full: full0, recent_season: Object.assign({ season: recent }, rec0) });
  const cur = current(doc);
  const lastSeason = Math.max(...base.map((r) => r.season));
  const patterns = errorAnalysis(base, recent);
  const today = nowIso().slice(0, 10);
  const weekIndex = Math.floor(Date.parse(today) / (7 * 864e5));
  const order = opts.only ? opts.only.filter((c) => CATALOGUE.some((x) => x[0] === c)) : rankCandidates(patterns, weekIndex, opts.max);
  const results = [];
  const baseById = new Map(base.map((r) => [r.id, r]));
  for (const cid of order) {
    const [, param, how, answers, target = 'side'] = CATALOGUE.find((c) => c[0] === cid);
    const rec = { at: nowIso(), league, served_version: cur.version, candidate: cid, change: { param, how }, answers_patterns: answers };
    const cfg = applyChange(cur.config, param, how);
    if (!cfg) { results.push(Object.assign(rec, { decision: 'SKIPPED', reason: 'no change from the served configuration' })); continue; }
    const rows = run(games, cfg, tuning.elo, from).filter((r) => baseById.has(r.id));
    const full = metrics(rows), rr = metrics(rows.filter((r) => r.season === recent));
    const dLL = full.logloss - full0.logloss, dMAE = full.margin_mae - full0.margin_mae;
    const rLL = rr.logloss - rec0.logloss, rMAE = rr.margin_mae - rec0.margin_mae;
    const dTM = full.total_mae - full0.total_mae, rTM = rr.total_mae - rec0.total_mae;
    const reasons = []; let ci;
    if (target === 'total') {
      ci = P.compare(rows, (r) => Math.abs(r.y.total - r.p.total.mu), (r) => Math.abs(r.y.total - baseById.get(r.id).p.total.mu));
      if (dTM > -MIN_GAIN.mae) reasons.push('full total MAE change ' + dTM.toFixed(4) + ' does not clear -' + MIN_GAIN.mae);
      if (!(ci.ci95 && ci.ci95[1] < 0)) reasons.push('total MAE 95% interval ' + JSON.stringify(ci.ci95) + ' is not below zero');
      if (rTM > 0) reasons.push('worse on ' + recent + ' total MAE (' + rTM.toFixed(4) + ')');
      if (dLL > 1e-9 || dMAE > 1e-9) reasons.push('moneyline or margin got worse');
    } else {
      ci = P.compare(rows, (r) => V.logLoss(r.p.points, r.y.hw), (r) => V.logLoss(baseById.get(r.id).p.points, r.y.hw));
      if (dLL > -MIN_GAIN.logloss) reasons.push('full log loss change ' + dLL.toFixed(6) + ' does not clear -' + MIN_GAIN.logloss);
      if (!(ci.ci95 && ci.ci95[1] < 0)) reasons.push('log loss 95% interval ' + JSON.stringify(ci.ci95) + ' is not below zero');
      if (dMAE > -MIN_GAIN.mae) reasons.push('full margin MAE change ' + dMAE.toFixed(4) + ' does not clear -' + MIN_GAIN.mae);
      if (rLL > 0) reasons.push('worse on ' + recent + ' log loss (' + rLL.toFixed(6) + ')');
      if (rMAE > 0) reasons.push('worse on ' + recent + ' margin MAE (' + rMAE.toFixed(4) + ')');
    }
    Object.assign(rec, { target, config: cfg, full, recent_season: Object.assign({ season: recent }, rr), ci95: ci.ci95, ci_of: target === 'total' ? 'total MAE change' : 'log loss change',
      delta: { full_logloss: V.r(dLL, 6), full_mae: V.r(dMAE, 4), full_total_mae: V.r(dTM, 4), recent_logloss: V.r(rLL, 6), recent_mae: V.r(rMAE, 4), recent_total_mae: V.r(rTM, 4) },
      decision: reasons.length ? 'FAIL' : 'PASS', reason: reasons.join('; ') || 'clears every condition' });
    results.push(rec);
    console.error('[bb loop] ' + league + ' ' + cid + ': ' + rec.decision + ' (full dLL ' + dLL.toFixed(6) + ', dMAE ' + dMAE.toFixed(4) + ', dTotalMAE ' + dTM.toFixed(4) + ' ci(' + rec.ci_of + ') ' + JSON.stringify(ci.ci95) + '; ' + recent + ' dLL ' + rLL.toFixed(6) + ', dMAE ' + rMAE.toFixed(4) + ', dTotalMAE ' + rTM.toFixed(4) + ')');
  }
  fs.mkdirSync(DOCS(league), { recursive: true });
  fs.appendFileSync(path.join(DOCS(league), 'candidates.jsonl'), results.map((r) => { const o = Object.assign({}, r); delete o.config; return JSON.stringify(o); }).join('\n') + (results.length ? '\n' : ''));
  const passed = results.filter((r) => r.decision === 'PASS');
  let promoted = null;
  if (passed.length) {
    /* one promotion a week: the side change with the largest gain in noise-floor units, else the best totals change */
    const gain = (c) => (c.target === 'total' ? c.delta.full_total_mae / MIN_GAIN.mae : c.delta.full_logloss / MIN_GAIN.logloss + c.delta.full_mae / MIN_GAIN.mae);
    const side = passed.filter((c) => c.target !== 'total');
    const best = (side.length ? side : passed).reduce((a, b) => (gain(b) < gain(a) ? b : a));
    promoted = promote(league, doc, best.config, 'weekly loop ' + today + ': candidate ' + best.candidate + ' (' + best.change.param + ' ' + JSON.stringify(best.change.how) + ') cleared the full-window rule',
      { full: best.full, recent_season: best.recent_season, delta: best.delta, ci95: best.ci95, ci_of: best.ci_of, previous: { full: full0, recent_season: Object.assign({ season: recent }, rec0) } });
  }
  const wpath = path.join(DOCS(league), 'weekly', today + '.json');
  const earlier = fs.existsSync(wpath) ? JSON.parse(fs.readFileSync(wpath, 'utf8')) : null;
  const summary = { schema: 'edgedesk_bb_loop_week_v1', at: nowIso(), league, label: C.LEAGUES[league].label, date: today,
    served_before: earlier ? earlier.served_before : cur.version, served_after: doc.current, runs: earlier ? (earlier.runs || 1) + 1 : 1,
    promoted: promoted ? promoted.version : (earlier && earlier.promoted) || null,
    window: { full: [from, lastSeason], recent_full_season: recent },
    baseline: { full: full0, recent_season: Object.assign({ season: recent }, rec0), this_season: metrics(base.filter((r) => r.season === lastSeason && lastSeason !== recent)) },
    patterns, candidates: (earlier ? earlier.candidates : []).concat(results.map((r) => { const o = Object.assign({}, r); delete o.config; return o; })) };
  fs.mkdirSync(path.dirname(wpath), { recursive: true });
  fs.writeFileSync(wpath, JSON.stringify(summary, null, 1) + '\n');
  return summary;
}

/* ------------------------------------------------------------ report */
function report(league) {
  const dir = path.join(DOCS(league), 'weekly');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) { console.error('[bb loop] ' + league + ': no research run yet'); return null; }
  const s = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const doc = loadVersions(league); const cur = current(doc);
  const tested = s.candidates.filter((c) => c.decision !== 'SKIPPED').length;
  const md = ['# ' + s.label + ' weekly model report: ' + s.date + '\n',
    'Served version **' + cur.version + '** (' + cur.status + '; promoted by ' + cur.promoted_by + ' on ' + cur.promoted_at.slice(0, 10) + '). '
      + 'Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.\n',
    '## What changed\n'];
  if (s.promoted) {
    const v = doc.versions.find((x) => x.version === s.promoted); const e = v.evidence;
    md.push('**Promoted ' + s.served_before + ' → ' + s.promoted + '.** ' + v.reason + '.\n');
    md.push('- Full window ' + s.window.full.join('–') + ': log loss ' + e.previous.full.logloss + ' → ' + e.full.logloss + ', margin MAE ' + e.previous.full.margin_mae + ' → ' + e.full.margin_mae + ', total MAE ' + e.previous.full.total_mae + ' → ' + e.full.total_mae + ' (95% interval of the ' + e.ci_of + ' ' + JSON.stringify(e.ci95) + ')');
    md.push('- ' + s.window.recent_full_season + ': log loss ' + e.previous.recent_season.logloss + ' → ' + e.recent_season.logloss + ', margin MAE ' + e.previous.recent_season.margin_mae + ' → ' + e.recent_season.margin_mae);
    if (e.delta && e.delta.full_total_mae > 0 && v.reason.indexOf('scoring_level') < 0) {
      md.push('- **Cost on totals:** total-points MAE +' + e.delta.full_total_mae + ' over the full window (' + (e.delta.recent_total_mae > 0 ? '+' : '') + e.delta.recent_total_mae
        + ' in ' + s.window.recent_full_season + '). The side rule measures moneyline and margin only; a totals guard would be a rule change, made openly, not after the fact.');
    }
    md.push('- Roll back: point `current` in docs/model-loop/' + league + '/versions.json at ' + s.served_before + '.\n');
  } else {
    md.push('**Nothing promoted.** ' + tested + ' candidate' + (tested === 1 ? ' was' : 's were') + ' tested' + (s.runs > 1 ? ' over ' + s.runs + ' runs' : '') + '; none cleared the rule (over '
      + s.window.full.join('–') + ': log loss ≤ −' + MIN_GAIN.logloss + ' with its 95% interval below zero and margin MAE ≤ −' + MIN_GAIN.mae + ', or for a scoring-level change total MAE ≤ −' + MIN_GAIN.mae + ' with its interval below zero; no worse on ' + s.window.recent_full_season + '). v' + cur.version + ' keeps serving.\n');
  }
  md.push('## Accuracy (walk-forward, out of sample)\n');
  md.push('| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |\n|---|---|---|---|---|---|');
  for (const [lab, x] of [['Full ' + s.window.full.join('–'), s.baseline.full], [String(s.window.recent_full_season), s.baseline.recent_season], ['Season in progress', s.baseline.this_season]]) {
    if (x && x.n) md.push('| ' + lab + ' | ' + x.n + ' | ' + x.logloss + ' | ' + x.brier + ' | ' + x.margin_mae + ' | ' + x.total_mae + ' |');
  }
  md.push('\n## Where the misses concentrate (the ' + s.window.recent_full_season + ' season' + (s.window.full[1] > s.window.recent_full_season ? ' and the season in progress' : '') + ')\n');
  md.push('Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.\n');
  md.push('| Pattern | n | Outcome bias (pts) | t | What it covers |\n|---|---|---|---|---|');
  for (const p of s.patterns) md.push('| ' + p.pattern + ' | ' + p.n + ' | ' + (p.outcome_bias > 0 ? '+' : '') + p.outcome_bias + ' | ' + p.t + ' | ' + p.note + ' |');
  md.push('\n## Every candidate tried this week\n');
  md.push('| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | ' + s.window.recent_full_season + ' Δlog loss | ' + s.window.recent_full_season + ' Δmargin MAE | Decision |\n|---|---|---|---|---|---|---|---|---|');
  const f = (v) => (v == null ? '—' : v);
  for (const c of s.candidates) {
    const d = c.delta || {};
    md.push('| ' + c.candidate + ' | `' + c.change.param + '` ' + JSON.stringify(c.change.how) + ' | ' + f(d.full_logloss) + ' | ' + f(d.full_mae) + ' | ' + f(d.full_total_mae) + ' | '
      + (c.ci95 ? c.ci_of + ' ' + JSON.stringify(c.ci95) : '—') + ' | ' + f(d.recent_logloss) + ' | ' + f(d.recent_mae) + ' | ' + c.decision + ': ' + c.reason + ' |');
  }
  md.push('\nEvery candidate ever tried: `docs/model-loop/' + league + '/candidates.jsonl`. Versions: `docs/model-loop/' + league + '/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).');
  const text = md.join('\n') + '\n';
  fs.writeFileSync(path.join(DOCS(league), 'weekly_model_report.md'), text);
  fs.writeFileSync(path.join(dir, files[files.length - 1].replace('.json', '.md')), text);
  console.error('[bb loop] ' + league + ': wrote docs/model-loop/' + league + '/weekly_model_report.md');
  return text;
}

module.exports = { CATALOGUE, MIN_GAIN, servedParams, applyChange, rankCandidates, recentFullSeason, metrics, errorAnalysis, configHash, research, report };

if (require.main === module) {
  const cmd = process.argv[2];
  const leagues = (arg('league', 'all') === 'all' ? Object.keys(C.LEAGUES) : arg('league').split(','));
  const only = arg('only') ? arg('only').split(',') : null;
  const max = arg('max') ? +arg('max') : MAX_CANDIDATES;
  if (!['research', 'report', 'all'].includes(cmd)) { console.error('usage: node basketball/loop.js research|report|all [--league nba,ncaam] [--only a,b] [--max 8]'); process.exit(2); }
  const promoted = [];
  for (const lg of leagues) {
    if (cmd !== 'report') { const s = research(lg, { only, max }); if (s.promoted && s.served_before !== s.served_after) promoted.push(lg); }
    report(lg);
  }
  /* the workflow reads this to refresh the live ratings of a league whose served version changed */
  console.log(JSON.stringify({ promoted }));
}
