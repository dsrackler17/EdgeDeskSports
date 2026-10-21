#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk MLB — the weekly learning loop for the lab brain (mlb/history), the
   same contract as the basketball and football loops (basketball/loop.js,
   docs/model-loop/README.md).

     node mlb/history/loop.js research [--only a,b] [--max 8]
     node mlb/history/loop.js report
     node mlb/history/loop.js all                    (research + report)

   WHAT IT LEARNS ON. Every scored game from 2012 to the newest season on file,
   priced exactly as the record prices it (walkforward.js scoreCandidate: one
   point-in-time pass, the run distribution and recalibration of each season
   fitted on the three seasons before). The brain prices no live game yet, so
   the loop's job until Opening Day is to find, on the whole history, the
   configuration the owner should be choosing between the engines with.

   THE RULE. A candidate from the catalogue replaces the served configuration
   only if, over the full window (2012 to date), it lowers moneyline log loss
   by >= 0.0002 with the paired 95% interval (blocked by date) below zero,
   leaves the run line's log loss and the Brier score no worse, and is no worse
   on the most recent full season. Never because of one week: every candidate
   is judged on every season, and every one, pass or fail, is logged.

   Outcome-graded only: no MLB closing prices are archived, so nothing here is
   compared with the market. Elo is reported beside every number because it is
   the baseline the brain has to beat (its moneyline does not, yet).

   Writes docs/model-loop/mlb/versions.json (current = served; walkforward.js
   builds the weekly record with it), candidates.jsonl, weekly/<date>.json and
   weekly_model_report.md.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WF = require('./walkforward');
const P = require('../../engine/lab/protocol');
const V = require('../../engine/validation');

const ROOT = path.join(__dirname, '..', '..');
const DOCS_DEFAULT = path.join(ROOT, 'docs', 'model-loop', 'mlb');
const TUNING = path.join(__dirname, 'params', 'mlb_tuning.json');
const MIN_GAIN = { logloss: 0.0002 };
const MAX_CANDIDATES = 8;

/* [id, param, [kind, value], patterns it answers]. prior_starts sat at the top of the selection grid
   (walkforward.js tune: 16, 32, 64), so the starter shrinkage is tried on both sides of it */
const CATALOGUE = [
  ['starters_looser', 'prior_starts', ['mul', 0.5], ['favourites', 'starter_known']],
  ['starters_tighter', 'prior_starts', ['mul', 2], ['favourites', 'starter_known']],
  ['recency_faster', 'half_life_days', ['mul', 0.5], ['late_season']],
  ['recency_slower', 'half_life_days', ['mul', 2], ['late_season', 'home']],
  ['teams_prior_weaker', 'prior_games', ['mul', 0.5], ['early_season', 'favourites']],
  ['teams_prior_stronger', 'prior_games', ['mul', 2], ['early_season']],
  ['carry_lower', 'carry', ['add', -0.15], ['early_season']],
  ['carry_higher', 'carry', ['add', 0.15], ['early_season']],
  ['park_prior_weaker', 'prior_park_games', ['mul', 0.5], ['total']],
  ['park_prior_stronger', 'prior_park_games', ['mul', 2], ['total']],
  ['window_longer', 'window_days', ['mul', 1.5], ['late_season', 'home']],
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
function loadVersions(docs) { const p = path.join(docs, 'versions.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function saveVersions(docs, doc) { fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, 'versions.json'), JSON.stringify(doc, null, 1) + '\n'); }
function current(doc) { return doc.versions.find((v) => v.version === doc.current); }

function ensureVersions(docs, tuning, evidence) {
  let doc = loadVersions(docs);
  if (doc) return doc;
  const cfg = tuning.chosen;
  doc = { schema: 'edgedesk_model_loop_versions_v1', sport: 'MLB', league: 'mlb', current: '1.0.0',
    versions: [{ version: '1.0.0', parent: null, config: cfg, config_sha256: configHash(cfg), status: 'SERVED (RESEARCH: prices no live game)', promoted_by: 'selection-window tuning',
      promoted_at: nowIso(), reason: 'The configuration mlb/history/walkforward.js used when the loop started: mlb/history/params/mlb_tuning.json `chosen` (' + tuning.rule + ').', evidence }] };
  saveVersions(docs, doc);
  return doc;
}

function promote(docs, doc, cfg, reason, evidence) {
  const [maj, min] = doc.current.split('.').map(Number);
  let m = min + 1; const taken = new Set(doc.versions.map((v) => v.version));
  while (taken.has(maj + '.' + m + '.0')) m++;
  const v = { version: maj + '.' + m + '.0', parent: doc.current, config: cfg, config_sha256: configHash(cfg), status: 'SERVED (RESEARCH: prices no live game)', promoted_by: 'weekly-loop', promoted_at: nowIso(), reason, evidence };
  for (const o of doc.versions) if (String(o.status).startsWith('SERVED')) o.status = 'RETIRED (rollback target)';
  doc.versions.push(v); doc.current = v.version;
  saveVersions(docs, doc);
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

/** the latest season with a full complement of games */
function recentFullSeason(rows) {
  const n = new Map(); for (const r of rows) n.set(r.season, (n.get(r.season) || 0) + 1);
  const ss = [...n.keys()].sort((a, b) => a - b);
  for (let i = ss.length - 1; i > 0; i--) if (n.get(ss[i]) >= 0.7 * n.get(ss[i - 1])) return ss[i];
  return ss[ss.length - 1];
}

function metrics(rows) {
  if (!rows.length) return { n: 0 };
  let ll = 0, br = 0, rl = 0, tmae = 0;
  for (const r of rows) {
    ll += V.logLoss(r.p, r.y.hw); br += Math.pow(r.p - r.y.hw, 2);
    rl += V.logLoss(r.mk.rl_home, r.y.margin >= 2 ? 1 : 0); tmae += Math.abs(r.y.total - r.mk.exp_total);
  }
  const n = rows.length;
  return { n, logloss: V.r(ll / n, 6), brier: V.r(br / n, 6), run_line_logloss: V.r(rl / n, 6), total_mae: V.r(tmae / n, 4) };
}

function eloRows(games, elo) {
  const e = new WF.Elo(elo); const out = new Map();
  for (const g of games) { e.start(g.season); out.set(g.game_id, e.prob(g.home, g.away)); e.absorb(g); }
  return out;
}

/** (wins - priced) / sqrt(sum p(1-p)): the binomial z under the model's own prices */
function binomialZ(ps, ys) {
  let w = 0, s = 0, v = 0; for (let i = 0; i < ps.length; i++) { w += ys[i]; s += ps[i]; v += ps[i] * (1 - ps[i]); }
  return v > 0 ? (w - s) / Math.sqrt(v) : null;
}

/** where the misses concentrate in the recent seasons: moneyline (binomial z) and totals (t) */
function errorAnalysis(rows, seasonFrom) {
  const d = rows.filter((r) => r.season >= seasonFrom);
  const out = [];
  const month = (r) => Number(String(r.date).slice(5, 7));
  const ml = (name, sel, note, fav) => {
    const x = d.filter(sel); if (x.length < 100) return;
    const ps = x.map((r) => (fav && r.p < 0.5 ? 1 - r.p : r.p)); const ys = x.map((r) => (fav && r.p < 0.5 ? 1 - r.y.hw : r.y.hw));
    const bias = ys.reduce((a, b) => a + b, 0) / ys.length - ps.reduce((a, b) => a + b, 0) / ps.length;
    out.push({ pattern: name, market: 'moneyline', n: x.length, note, outcome_bias: V.r(bias, 4), t: V.r(binomialZ(ps, ys), 2), stat: 'z' });
  };
  ml('home', () => true, 'every game: home wins minus the priced home win', false);
  ml('early_season', (r) => month(r) <= 4, 'March and April (ratings carried over the winter)', false);
  ml('late_season', (r) => month(r) >= 9, 'September and later', false);
  ml('favourites', (r) => Math.max(r.p, 1 - r.p) >= 0.6, 'priced 60%+ either way, read from the favourite', true);
  ml('starter_known', (r) => r.sp_known, 'both starters on file', false);
  const tot = d.map((r) => r.y.total - r.mk.exp_total);
  if (tot.length >= 100) {
    const m = tot.reduce((a, b) => a + b, 0) / tot.length; const sd = Math.sqrt(tot.reduce((a, b) => a + (b - m) * (b - m), 0) / (tot.length - 1));
    out.push({ pattern: 'total', market: 'total', n: tot.length, note: 'total runs: result minus expected', outcome_bias: V.r(m, 3), t: V.r(m / (sd / Math.sqrt(tot.length)), 2), stat: 't' });
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
function research(opts) {
  opts = opts || {};
  const docs = opts.docs || DOCS_DEFAULT;
  const tuning = opts.tuning || JSON.parse(fs.readFileSync(TUNING, 'utf8'));
  const games = opts.games || WF.load();
  const from = WF.W.selection[0];
  const score = (cfg) => WF.scoreCandidate(games, cfg, WF.CANDS.team_park_sp).filter((r) => r.season >= from);
  const doc0 = loadVersions(docs);
  const served0 = doc0 ? current(doc0).config : tuning.chosen;
  const base = score(served0);
  const recent = recentFullSeason(base);
  const full0 = metrics(base), rec0 = metrics(base.filter((r) => r.season === recent));
  const elo = eloRows(games, tuning.elo);
  const eloFull = (rows) => { let ll = 0; for (const r of rows) ll += V.logLoss(elo.get(r.id), r.y.hw); return V.r(ll / rows.length, 6); };
  const doc = ensureVersions(docs, tuning, { full: full0, recent_season: Object.assign({ season: recent }, rec0) });
  const cur = current(doc);
  const lastSeason = Math.max(...base.map((r) => r.season));
  const patterns = errorAnalysis(base, recent - 1);
  const today = (opts.today || nowIso()).slice(0, 10);
  const weekIndex = Math.floor(Date.parse(today) / (7 * 864e5));
  const order = opts.only ? opts.only.filter((c) => CATALOGUE.some((x) => x[0] === c)) : rankCandidates(patterns, weekIndex, opts.max);
  const baseById = new Map(base.map((r) => [r.id, r]));
  const results = [];
  for (const cid of order) {
    const [, param, how, answers] = CATALOGUE.find((c) => c[0] === cid);
    const rec = { at: nowIso(), served_version: cur.version, candidate: cid, change: { param, how }, answers_patterns: answers };
    const cfg = applyChange(cur.config, param, how);
    if (!cfg) { results.push(Object.assign(rec, { decision: 'SKIPPED', reason: 'no change from the served configuration' })); continue; }
    const rows = score(cfg).filter((r) => baseById.has(r.id));
    const full = metrics(rows), rr = metrics(rows.filter((r) => r.season === recent));
    const d = { full_logloss: V.r(full.logloss - full0.logloss, 6), full_brier: V.r(full.brier - full0.brier, 6), full_run_line: V.r(full.run_line_logloss - full0.run_line_logloss, 6),
      full_total_mae: V.r(full.total_mae - full0.total_mae, 4), recent_logloss: V.r(rr.logloss - rec0.logloss, 6) };
    const ci = P.compare(rows, (r) => V.logLoss(r.p, r.y.hw), (r) => V.logLoss(baseById.get(r.id).p, r.y.hw));
    const reasons = [];
    if (d.full_logloss > -MIN_GAIN.logloss) reasons.push('full log loss change ' + d.full_logloss + ' does not clear -' + MIN_GAIN.logloss);
    if (!(ci.ci95 && ci.ci95[1] < 0)) reasons.push('log loss 95% interval ' + JSON.stringify(ci.ci95) + ' is not below zero');
    if (d.full_brier > 0) reasons.push('Brier worse (' + d.full_brier + ')');
    if (d.full_run_line > 0) reasons.push('run line log loss worse (' + d.full_run_line + ')');
    if (d.recent_logloss > 0) reasons.push('worse on ' + recent + ' (' + d.recent_logloss + ')');
    Object.assign(rec, { config: cfg, full, recent_season: Object.assign({ season: recent }, rr), ci95: ci.ci95, delta: d,
      decision: reasons.length ? 'FAIL' : 'PASS', reason: reasons.join('; ') || 'clears every condition' });
    results.push(rec);
    console.error('[mlb loop] ' + cid + ': ' + rec.decision + ' (full dLL ' + d.full_logloss + ' ci ' + JSON.stringify(ci.ci95) + ', dRL ' + d.full_run_line + ', ' + recent + ' dLL ' + d.recent_logloss + ')');
  }
  fs.mkdirSync(docs, { recursive: true });
  fs.appendFileSync(path.join(docs, 'candidates.jsonl'), results.map((r) => { const o = Object.assign({}, r); delete o.config; return JSON.stringify(o); }).join('\n') + (results.length ? '\n' : ''));
  const passed = results.filter((r) => r.decision === 'PASS');
  let promoted = null;
  if (passed.length) {
    const best = passed.reduce((a, b) => (b.delta.full_logloss < a.delta.full_logloss ? b : a));
    promoted = promote(docs, doc, best.config, 'weekly loop ' + today + ': candidate ' + best.candidate + ' (' + best.change.param + ' ' + JSON.stringify(best.change.how) + ') cleared the full-window rule',
      { full: best.full, recent_season: best.recent_season, delta: best.delta, ci95: best.ci95, previous: { full: full0, recent_season: Object.assign({ season: recent }, rec0) } });
  }
  const wpath = path.join(docs, 'weekly', today + '.json');
  const earlier = fs.existsSync(wpath) ? JSON.parse(fs.readFileSync(wpath, 'utf8')) : null;
  const summary = { schema: 'edgedesk_mlb_loop_week_v1', at: nowIso(), label: 'MLB (lab brain, mlb/history)', date: today,
    served_before: earlier ? earlier.served_before : cur.version, served_after: doc.current, runs: earlier ? (earlier.runs || 1) + 1 : 1,
    promoted: promoted ? promoted.version : (earlier && earlier.promoted) || null,
    window: { full: [from, lastSeason], recent_full_season: recent },
    baseline: { full: full0, recent_season: Object.assign({ season: recent }, rec0) },
    elo: { full_logloss: eloFull(base), recent_logloss: eloFull(base.filter((r) => r.season === recent)), params: tuning.elo },
    patterns, candidates: (earlier ? earlier.candidates : []).concat(results.map((r) => { const o = Object.assign({}, r); delete o.config; return o; })) };
  fs.mkdirSync(path.dirname(wpath), { recursive: true });
  fs.writeFileSync(wpath, JSON.stringify(summary, null, 1) + '\n');
  return summary;
}

/* ------------------------------------------------------------ report */
function report(opts) {
  opts = opts || {};
  const docs = opts.docs || DOCS_DEFAULT;
  const dir = path.join(docs, 'weekly');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) { console.error('[mlb loop] no research run yet'); return null; }
  const s = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const doc = loadVersions(docs); const cur = current(doc);
  const tested = s.candidates.filter((c) => c.decision !== 'SKIPPED').length;
  const md = ['# MLB weekly model report (lab brain): ' + s.date + '\n',
    'Served version **' + cur.version + '** (' + cur.status + '; ' + cur.promoted_by + ', ' + cur.promoted_at.slice(0, 10) + '). The lab brain (mlb/history) prices no live game: '
      + 'the browser card uses mlb/engine.js. This loop improves the brain on the whole 2012-to-date record so the 2027 engine can be chosen on evidence. '
      + 'Outcome-graded only: no MLB closing prices are archived.\n',
    '## What changed\n'];
  if (s.promoted) {
    const v = doc.versions.find((x) => x.version === s.promoted); const e = v.evidence;
    md.push('**Promoted ' + s.served_before + ' → ' + s.promoted + '.** ' + v.reason + '.\n');
    md.push('- Full window ' + s.window.full.join('–') + ': log loss ' + e.previous.full.logloss + ' → ' + e.full.logloss + ' (95% interval of the change ' + JSON.stringify(e.ci95) + '), run line log loss ' + e.previous.full.run_line_logloss + ' → ' + e.full.run_line_logloss);
    md.push('- ' + s.window.recent_full_season + ': log loss ' + e.previous.recent_season.logloss + ' → ' + e.recent_season.logloss);
    md.push('- Roll back: point `current` in docs/model-loop/mlb/versions.json at ' + s.served_before + '.\n');
  } else {
    md.push('**Nothing promoted.** ' + tested + ' candidate' + (tested === 1 ? ' was' : 's were') + ' tested' + (s.runs > 1 ? ' over ' + s.runs + ' runs' : '') + '; none cleared the rule (over '
      + s.window.full.join('–') + ': log loss ≤ −' + MIN_GAIN.logloss + ' with its 95% interval below zero, Brier and run line no worse, no worse on ' + s.window.recent_full_season + '). v' + cur.version + ' keeps serving.\n');
  }
  md.push('## Accuracy (walk-forward, out of sample)\n');
  md.push('| Window | n | Moneyline log loss | Elo | Brier | Run line log loss | Total MAE |\n|---|---|---|---|---|---|---|');
  md.push('| Full ' + s.window.full.join('–') + ' | ' + s.baseline.full.n + ' | ' + s.baseline.full.logloss + ' | ' + s.elo.full_logloss + ' | ' + s.baseline.full.brier + ' | ' + s.baseline.full.run_line_logloss + ' | ' + s.baseline.full.total_mae + ' |');
  md.push('| ' + s.window.recent_full_season + ' | ' + s.baseline.recent_season.n + ' | ' + s.baseline.recent_season.logloss + ' | ' + s.elo.recent_logloss + ' | ' + s.baseline.recent_season.brier + ' | ' + s.baseline.recent_season.run_line_logloss + ' | ' + s.baseline.recent_season.total_mae + ' |');
  md.push('\nElo is the baseline the brain has to beat; while its moneyline log loss is above Elo\'s, the brain\'s moneyline cannot be validated (engine/lab/protocol.js).\n');
  md.push('## Where the misses concentrate (the last two full seasons)\n');
  md.push('Moneyline: wins minus priced, z = (wins − Σp) / √Σp(1−p). Totals: runs minus expected, t. |z| or |t| ≥ 2 pulls the matching candidates forward.\n');
  md.push('| Pattern | Market | n | Bias | z / t | What it covers |\n|---|---|---|---|---|---|');
  for (const p of s.patterns) md.push('| ' + p.pattern + ' | ' + p.market + ' | ' + p.n + ' | ' + (p.outcome_bias > 0 ? '+' : '') + p.outcome_bias + ' | ' + p.t + ' ' + p.stat + ' | ' + p.note + ' |');
  md.push('\n## Every candidate tried this week\n');
  md.push('| Candidate | Change | Full Δlog loss | 95% interval | ΔBrier | Δrun line | Δtotal MAE | ' + s.window.recent_full_season + ' Δlog loss | Decision |\n|---|---|---|---|---|---|---|---|---|');
  const f = (v) => (v == null ? '—' : v);
  for (const c of s.candidates) {
    const d = c.delta || {};
    md.push('| ' + c.candidate + ' | `' + c.change.param + '` ' + JSON.stringify(c.change.how) + ' | ' + f(d.full_logloss) + ' | ' + (c.ci95 ? JSON.stringify(c.ci95) : '—') + ' | ' + f(d.full_brier) + ' | ' + f(d.full_run_line) + ' | ' + f(d.full_total_mae) + ' | ' + f(d.recent_logloss) + ' | ' + c.decision + ': ' + c.reason + ' |');
  }
  md.push('\nEvery candidate ever tried: `docs/model-loop/mlb/candidates.jsonl`. Versions: `docs/model-loop/mlb/versions.json`. The weekly record (`mlb/history/walkforward.js`, lab-validate.yml) is built with the served version.');
  const text = md.join('\n') + '\n';
  fs.writeFileSync(path.join(docs, 'weekly_model_report.md'), text);
  fs.writeFileSync(path.join(dir, files[files.length - 1].replace('.json', '.md')), text);
  console.error('[mlb loop] wrote ' + path.relative(ROOT, path.join(docs, 'weekly_model_report.md')));
  return text;
}

module.exports = { CATALOGUE, MIN_GAIN, applyChange, rankCandidates, recentFullSeason, metrics, errorAnalysis, binomialZ, configHash, research, report };

if (require.main === module) {
  const cmd = process.argv[2];
  const only = arg('only') ? arg('only').split(',') : null;
  const max = arg('max') ? +arg('max') : MAX_CANDIDATES;
  if (!['research', 'report', 'all'].includes(cmd)) { console.error('usage: node mlb/history/loop.js research|report|all [--only a,b] [--max 8]'); process.exit(2); }
  let s = null;
  if (cmd !== 'report') s = research({ only, max });
  report();
  if (s && s.promoted && s.served_before !== s.served_after) console.log('PROMOTED ' + s.served_after);
}
