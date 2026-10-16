#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk MODEL PERFORMANCE — the hourly job. docs/model-performance/RUNBOOK.md

     node tools/performance/run.js                 dry run: what it would do, writes nothing
     node tools/performance/run.js --write         capture, import, verify, grade, build, write
     node tools/performance/run.js --write --network   …and read ESPN by date for missed finals
     node tools/performance/run.js --check [--base origin/main]
                                                   verify every ledger chain, and that the
                                                   committed base of every ledger file is an
                                                   exact prefix of the working copy

   options: --now <ISO> (replay a moment) · --no-capture · --no-import · --root <dir>
            --max-espn <n> (ESPN day reads per run, default 4)

   Order, every run: verify the chains (a broken chain stops the run before
   anything is written) → capture → research grades (the A–F grade of every
   upcoming game, lib/edgedesk_research_grade.js) → import → results → grade →
   settle research grades → build → verify again. Each step appends only what is new, so a second run on the same
   inputs writes nothing.
   Exit 0 = done; 1 = a chain or prefix check failed; 2 = nothing could be read.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../../lib/edgedesk_performance.js');
const L = require('./ledger.js');
const S = require('./sources.js');
const PL = require('./pipeline.js');
const B = require('./build.js');
const RG = require('./research_grades.js');
const GB = require('./grade_build.js');
const G = require('../../lib/edgedesk_research_grade.js');

const ROOT_DEFAULT = path.join(__dirname, '..', '..');

function args(argv) {
  const a = { write: false, network: false, capture: true, import: true, check: false, base: null, now: null, root: ROOT_DEFAULT, maxEspn: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true;
    else if (k === '--network') a.network = true;
    else if (k === '--no-capture') a.capture = false;
    else if (k === '--no-import') a.import = false;
    else if (k === '--check') a.check = true;
    else if (k === '--base') a.base = argv[++i];
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--root') a.root = path.resolve(argv[++i]);
    else if (k === '--max-espn') a.maxEspn = +argv[++i];
  }
  return a;
}
function gitSha(root) { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch (_) { return null; } }
function loadState(root) {
  const st = {};
  L.STREAMS.forEach((s) => { st[s] = L.readStream(root, s); });
  return st;
}

/** Every chain verifies; with a base ref, every committed ledger file is a prefix of the working copy. */
function check(root, base) {
  const chains = L.verifyAll(root);
  const prefix = [];
  if (base) {
    let list = '';
    try { list = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'performance/ledger'], { cwd: root }).toString(); } catch (_) { list = ''; }
    list.split('\n').filter((f) => f.endsWith('.jsonl')).forEach((rel) => {
      let baseText = '';
      try { baseText = execFileSync('git', ['show', base + ':' + rel], { cwd: root, maxBuffer: 512 << 20 }).toString(); } catch (_) { return; }
      const now = L.readText(path.join(root, rel));
      const v = L.verifyPrefix(baseText, now);
      if (!v.ok) prefix.push({ file: rel, detail: v.detail });
    });
  }
  /* every locked research grade must come back unchanged from its own inputs and version */
  const reproduce = [];
  L.readStream(root, 'research_grades').forEach((r) => { const v = G.reproduce(r); if (!v.ok) reproduce.push({ event_key: r.event_key, hash: r.hash, diffs: v.diffs || [v.why] }); });
  return { ok: chains.ok && !prefix.length && !reproduce.length, chains, prefix, reproduce };
}

/**
 * The whole run. o: { root, now (ms), write, network, capture, import, fetchImpl, maxEspn, run, git_sha, log }
 * Returns { report, state, outputs }.
 */
async function runAll(o) {
  const root = path.resolve(o.root || ROOT_DEFAULT);
  const now = o.now != null ? o.now : Date.now();
  const log = o.log || (() => {});
  const report = { now: new Date(now).toISOString(), wrote: o.write ? {} : null, steps: {} };
  const before = L.verifyAll(root);
  if (!before.ok) { report.blocked = 'a ledger chain does not verify; nothing is written'; report.chains = before; return { report, state: null }; }
  const state = loadState(root);
  const append = (stream, rows) => {
    if (!rows.length) return [];
    const written = L.appendMany(root, stream, rows, { dryRun: !o.write });
    written.forEach((r) => state[stream].push(r));
    return written;
  };
  const slate = S.loadSlate(root);
  const native = S.makeNative(root);

  /* 1 CAPTURE */
  let cur = null;
  if (o.capture !== false) {
    if (o.projections) cur = { projections: o.projections }; /* tests and replays inject the contract */
    else { try { cur = S.currentProjections(root, now); } catch (e) { cur = { projections: [], error: String(e && e.message || e) }; } }
    const c = PL.capture(state, { now, projections: cur.projections, slate, run: o.run || null, git_sha: o.git_sha || null });
    append('quotes', c.quotes);
    const w = append('forecasts', c.appended);
    report.steps.capture = { projections: cur.projections.length, considered: c.considered, appended: w.length, quotes: c.quotes.length, unchanged: c.unchanged, refused: c.refused, matched: c.matched, error: cur.error || null };
    log('capture: ' + w.length + ' new forecast revision(s), ' + c.quotes.length + ' quote change(s), ' + c.unchanged + ' unchanged; refused ' + JSON.stringify(c.refused));
    report.steps.capture_detail = c;
  }
  /* 1b RESEARCH GRADES: every upcoming game's A–F grade, from what is on file now (after the capture above) */
  if (cur) {
    const rg = RG.snapshot(state, { now, projections: cur.projections, slate, extras: RG.loadExtras(root), run: o.run || null, git_sha: o.git_sha || null });
    const w = append('research_grades', rg.appended);
    report.steps.research_grades = { considered: rg.considered, appended: w.length, unchanged: rg.unchanged, refused: rg.refused, letters: rg.letters, reproduce_failures: rg.reproduce_failures.length };
    log('research grades: ' + w.length + ' new grade revision(s), ' + rg.unchanged + ' unchanged; letters ' + JSON.stringify(rg.letters) + '; refused ' + JSON.stringify(rg.refused));
    report.steps.research_grades_detail = rg;
  }
  /* 2 IMPORT (the period before the ledger's first capture) */
  if (o.import !== false) {
    const epoch = PL.epochOf(state.forecasts);
    const cands = S.importCandidates(root, epoch != null ? epoch : now);
    const im = PL.importRecorded(state, cands);
    const w = append('forecasts', im.appended);
    report.steps.import = { candidates: cands.length, appended: w.length, already_present: im.skipped_present, same_as_previous: im.skipped_same, cutoff: new Date(epoch != null ? epoch : now).toISOString() };
    log('import: ' + w.length + ' recorded revision(s) from earlier records (cutoff ' + report.steps.import.cutoff + ')');
  }
  /* 3 RESULTS */
  let res = PL.verifyResults(state, { now, slate, native });
  let espn = null;
  if (o.network && res.wantDays.length) {
    espn = await S.espnDays(root, res.wantDays, { max: o.maxEspn || 4, fetchImpl: o.fetchImpl, now });
    res = PL.verifyResults(state, { now, slate, native, espnEvents: espn.events });
  }
  const rw = append('results', res.appended);
  report.steps.results = { read: res.read, appended: rw.length, corrections: rw.filter((x) => x.reason === 'source_correction').length, pending: res.pending.length, conflicts: res.conflicts.length, unmatched: res.unmatched.length,
    espn_days: espn ? espn.log : [], wanted_days: res.wantDays.length };
  log('results: ' + rw.length + ' new result revision(s) (' + report.steps.results.corrections + ' correction(s)); ' + res.pending.length + ' pending, ' + res.conflicts.length + ' in conflict');
  /* 4 GRADE */
  const gr = PL.grade(state, { now, native });
  const gw = append('grades', gr.appended);
  report.steps.grade = { appended: gw.length, revisions: gw.filter((x) => x.revision > 1).length, no_snapshot: gr.no_snapshot.length };
  log('grade: ' + gw.length + ' new grade revision(s), ' + report.steps.grade.revisions + ' of them regrades');
  /* 4b SETTLE RESEARCH GRADES: each verified result against the game's latest valid pregame grade */
  const so = RG.settle(state, { now, native });
  const ow = append('grade_outcomes', so.appended);
  report.steps.grade_outcomes = { appended: ow.length, revisions: ow.filter((x) => x.revision > 1).length, no_pregame_grade: so.no_pregame_grade.length };
  log('grade outcomes: ' + ow.length + ' new outcome revision(s); ' + so.no_pregame_grade.length + ' completed game(s) had no pregame research grade (never backfilled)');

  /* 5 BUILD */
  const after = L.verifyAll(root);
  const chains = { ok: after.ok, files: after.files.length, rows: after.files.reduce((s, f) => s + f.rows, 0) };
  const pr = B.publicRows(state, now);
  const prevSummary = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'performance', 'data', 'summary.json'), 'utf8')); } catch (_) { return null; } })();
  const summary = B.buildSummary(root, state, pr.rows, now, { chains });
  const wk = B.weekly(pr.rows, now);
  const articles = B.articleSummaries(root, state, pr.rows);
  const social = B.socialDraft(wk);
  const duplicates = [];
  const socialFile = social ? path.join(root, 'performance', 'social', social.week_id + '.json') : null;
  if (social && fs.existsSync(socialFile)) {
    /* a published week's draft is written once; a different rebuild is refused and reported */
    try {
      const prev = JSON.parse(fs.readFileSync(socialFile, 'utf8'));
      if (prev.summary && prev.summary.text !== social.summary.text) duplicates.push({ file: path.relative(root, socialFile), why: 'the week\'s draft is already published; a different rebuild was refused' });
    } catch (_) { /* unreadable: leave it, report it */ duplicates.push({ file: path.relative(root, socialFile), why: 'unreadable published draft left in place' }); }
  }
  const hl = B.health(state, { capture: report.steps.capture_detail, results: res, grade: gr, duplicates, espn }, prevSummary, summary, now, after);
  /* the research grade artifacts, and their health items folded into the one health file */
  const gradeLive = GB.live(state, now);
  const gpr = GB.publicRows(state, now);
  const ggf = GB.gameFiles(gpr.rows, now);
  const gsum = GB.buildSummary(state, gpr.rows, now, { chains, no_pregame_grade: so.no_pregame_grade, conflicts: res.conflicts, pending: res.pending });
  gsum.games = ggf.index;
  GB.healthItems(state, { snapshot: report.steps.research_grades_detail, settle: so }, now).forEach((i) => hl.items.push(i));
  const LV = ['OK', 'INFO', 'WARN', 'ALERT', 'ERROR'];
  hl.status = hl.items.reduce((w, i) => (LV.indexOf(i.level) > LV.indexOf(w) && i.level !== 'INFO' ? i.level : w), hl.status);
  hl.counts.research_grades = (state.research_grades || []).length; hl.counts.grade_outcomes = (state.grade_outcomes || []).length;
  delete report.steps.capture_detail;
  delete report.steps.research_grades_detail;
  const gf = B.gameFiles(pr.rows, now);
  summary.games = gf.index;
  const outputs = Object.assign({}, gf.files, ggf.files, {
    'performance/data/grades/live.json': gradeLive.live,
    'performance/data/grades/live_detail.json': gradeLive.detail,
    'performance/data/grades/summary.json': gsum,
    'performance/data/summary.json': summary,
    'performance/data/weekly.json': wk,
    'performance/data/health.json': hl,
    'performance/articles/postgame.json': { schema: 'edgedesk_perf_article_postgame_v1', generated_at: new Date(now).toISOString(), note: 'Read by tools/articles/build_articles.js: the "EdgeDesk Prediction vs. Actual Result" block on each published matchup article. The article\'s own published numbers, never a later forecast.', articles }
  });
  if (social && !fs.existsSync(socialFile)) outputs[path.relative(root, socialFile)] = social;
  report.health = hl.status;
  report.grades = { upcoming: Object.keys(gradeLive.live.games).length, started: gpr.rows.length, settled_graded: gsum.overall.totals.settled_graded, insufficient: gsum.insufficient };
  report.public = { games: pr.rows.length, graded_verified: summary.headline.verified.eligibility.graded, graded_recorded: summary.headline.recorded.eligibility.graded, articles: Object.keys(articles).length, weekly: wk.week_id + ' ' + wk.status };
  if (o.write) {
    const { writeIfChanged } = require(path.join(root, 'tools', 'football', 'write_if_changed.js'));
    Object.keys(outputs).forEach((rel) => { report.wrote[rel] = writeIfChanged(path.join(root, rel), outputs[rel], { pretty: rel.indexOf('/games/') < 0 && rel.indexOf('/grades/live') < 0, newline: true }); });
  }
  report.chains = chains;
  return { report, state, outputs };
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.check) {
    const c = check(a.root, a.base);
    c.chains.files.forEach((f) => { if (!f.ok) console.log('BROKEN ' + f.file + ': ' + f.errors.join('; ')); });
    c.prefix.forEach((p) => console.log('REWRITTEN ' + p.file + ': ' + p.detail));
    c.reproduce.forEach((p) => console.log('NOT REPRODUCIBLE ' + p.event_key + ' ' + p.hash + ': ' + p.diffs.join(', ')));
    console.log(c.ok ? 'CHECK OK: ' + c.chains.files.length + ' ledger file(s), every chain verifies, every research grade reproduces' + (a.base ? ', every committed line kept (base ' + a.base + ')' : '') : 'CHECK FAILED');
    process.exit(c.ok ? 0 : 1);
  }
  const now = a.now ? Date.parse(a.now) : Date.now();
  const r = await runAll({ root: a.root, now, write: a.write, network: a.network, capture: a.capture, import: a.import, maxEspn: a.maxEspn,
    run: process.env.GITHUB_RUN_ID ? 'gh:' + process.env.GITHUB_RUN_ID : null, git_sha: gitSha(a.root), log: (s) => console.log(s) });
  if (r.report.blocked) { console.error(r.report.blocked); console.error(JSON.stringify(r.report.chains, null, 1).slice(0, 3000)); process.exit(1); }
  console.log(JSON.stringify(r.report, null, 1));
  if (!a.write) console.log('(dry run: nothing written; pass --write)');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const h = r.outputs['performance/data/health.json'];
    const lines = ['### Model performance — ' + r.report.health, '', '| step | result |', '|---|---|',
      '| capture | ' + (r.report.steps.capture ? r.report.steps.capture.appended + ' new forecast revision(s), ' + r.report.steps.capture.unchanged + ' unchanged' : 'skipped') + ' |',
      '| import | ' + (r.report.steps.import ? r.report.steps.import.appended + ' recorded revision(s)' : 'skipped') + ' |',
      '| results | ' + r.report.steps.results.appended + ' new, ' + r.report.steps.results.pending + ' pending, ' + r.report.steps.results.conflicts + ' in conflict |',
      '| grade | ' + r.report.steps.grade.appended + ' new grade revision(s) |',
      '| research grades | ' + (r.report.steps.research_grades ? r.report.steps.research_grades.appended + ' new, letters ' + JSON.stringify(r.report.steps.research_grades.letters) : 'skipped') + ' |',
      '| grade outcomes | ' + r.report.steps.grade_outcomes.appended + ' new, ' + r.report.steps.grade_outcomes.no_pregame_grade + ' without a pregame grade |', ''];
    h.items.forEach((i) => lines.push('- **' + i.level + '** ' + i.check + ': ' + i.detail));
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (_) { /* summary is best effort */ }
  }
}

module.exports = { runAll, check, args, loadState };
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
