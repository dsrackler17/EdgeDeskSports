#!/usr/bin/env node
/* ===========================================================================
   ALL CHECKS: one required check that stands for every workflow a pull
   request starts.

     node tools/ci/gate.js                       (the all-checks.yml job)
     node tools/ci/gate.js --repo owner/name --pr 807 --once
                                                 (a read-only replay)

   A branch ruleset can require only a check that reports on every pull
   request, and 64 of the pull-request workflows are path-filtered. On
   2026-10-26 #807 merged 17 s after it was opened. Its three required checks
   passed within three minutes, and eight other workflows failed after it
   (docs/ci/BRANCH_PROTECTION.md). This job runs on every pull request. It:

     1. reads the pull request's changed files from the API (GitHub's own list);
     2. predicts the workflows that change starts, from each workflow's own
        on: block (tools/ci/workflows.js: paths, paths-ignore, branches; the
        reader npm run verify uses);
     3. polls the Actions runs for the head commit until every one finishes;
     4. passes only when each finished success, skipped or neutral.

   It fails when:
     - a run fails, is cancelled or times out (it fails at the first one);
     - a predicted workflow never starts (the prediction and GitHub disagree,
       and it says so rather than guess);
     - the wait runs out.
   A run nobody predicted still counts. A workflow disabled in the
   repository's settings is named and not waited on.

   It only reads. It never writes, re-runs or cancels anything. When you
   re-run a failed workflow, re-run this one after it.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./workflows.js');

const ROOT = path.join(__dirname, '..', '..');
const SELF = '.github/workflows/all-checks.yml';
const PASSING = ['success', 'skipped', 'neutral'];
const GITHUB_PATH_LIMIT = 300; // GitHub evaluates paths filters on the first 300 changed files only

/* the path a run was started from, without a ref suffix (".github/workflows/x.yml@refs/...") */
function runPath(run) { return String((run && run.path) || '').replace(/@.*$/, ''); }

/* one run → running | pass | fail */
function classify(run) {
  if (!run || run.status !== 'completed') return 'running';
  return PASSING.indexOf(run.conclusion) >= 0 ? 'pass' : 'fail';
}

/* the workflows a pull request into `base` that changes `files` starts, apart from this one */
function expectedWorkflows(root, files, base, opts) {
  const o = opts || {};
  const self = o.selfPath || SELF;
  const states = o.states || {};
  return W.loadWorkflows(root).filter((wf) => wf.file !== self).map((wf) => ({ wf, t: W.triggeredBy(wf, files, base) }))
    .filter((x) => x.t.run)
    .map((x) => ({ file: x.wf.file, name: x.wf.name, why: x.t.why, state: states[x.wf.file] || 'active' }));
}

/* the verdict on one look at the head commit's runs: pass | fail | wait, with a row per workflow */
function evaluate(input) {
  const { expected, runs, selfPath, selfRunId, elapsedMs, appearMs, fileCount } = input;
  const self = selfPath || SELF;
  const latest = new Map();
  (runs || []).forEach((r) => {
    if (r.event && r.event !== 'pull_request') return;
    if (selfRunId != null && String(r.id) === String(selfRunId)) return;
    const p = runPath(r);
    if (p === self) return;
    const had = latest.get(p);
    if (!had || Number(r.id) > Number(had.id)) latest.set(p, r);   // a newer run of the same workflow replaces an older one
  });
  const rows = [];
  const named = new Set();
  (expected || []).forEach((e) => {
    named.add(e.file);
    const run = latest.get(e.file) || null;
    let state;
    if (run) state = classify(run);                    // a run that exists counts, even if the workflow was disabled after it started
    else if (e.state !== 'active') state = 'disabled'; // never started, and cannot: named, not waited on
    else state = elapsedMs >= appearMs ? 'missing' : 'not-started';
    rows.push({ file: e.file, name: e.name, why: e.why, run, state, predicted: true });
  });
  latest.forEach((run, p) => {
    if (named.has(p)) return;
    rows.push({ file: p, name: run.name || p, why: 'not predicted: GitHub started it', run, state: classify(run), predicted: false });
  });
  const by = (s) => rows.filter((r) => r.state === s);
  const failed = by('fail');
  const missing = by('missing');
  const waiting = rows.filter((r) => r.state === 'running' || r.state === 'not-started');
  let verdict = 'pass';
  const reasons = [];
  if (failed.length) { verdict = 'fail'; reasons.push(failed.length + ' workflow run' + (failed.length === 1 ? '' : 's') + ' did not pass: ' + failed.map((r) => r.name + ' (' + (r.run.conclusion || r.run.status) + ')').join(', ')); }
  if (missing.length) {
    verdict = 'fail';
    reasons.push(missing.length + ' predicted workflow' + (missing.length === 1 ? '' : 's') + ' never started for this commit: ' + missing.map((r) => r.name).join(', ') +
      (fileCount > GITHUB_PATH_LIMIT ? ' (GitHub evaluates paths filters on the first ' + GITHUB_PATH_LIMIT + ' changed files only; this pull request changes ' + fileCount + ')' :
        ' (tools/ci/workflows.js and GitHub disagree about this change: fix the reader, never this check)'));
  }
  if (verdict === 'pass' && waiting.length) verdict = 'wait';
  return { verdict, rows, failed, missing, waiting, reasons };
}

/* ── the GitHub API (read-only; no dependency, Node's own fetch) ─────────── */
function client(env, opts) {
  const o = opts || {};
  const base = String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const token = env.GITHUB_TOKEN || '';
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tries = o.tries || 4;
  const headers = Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'edgedesk-all-checks' },
    token ? { Authorization: 'Bearer ' + token } : {});
  async function get(pathname) {
    let last;
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(Math.min(30000, 1000 * Math.pow(2, i - 1)));
      let res;
      try { res = await fetch(base + pathname, { headers, signal: AbortSignal.timeout(o.timeoutMs || 30000) }); }
      catch (e) { last = e; continue; }                      // the network, or a request that hung: try again
      if (res.ok) return res.json();
      last = new Error('GET ' + pathname + ' → ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      if (res.status < 500 && !limited) throw last;          // 401, 404, 422: trying again changes nothing
    }
    throw last;
  }
  async function paged(pathname, pick, maxPages) {
    const out = [];
    for (let page = 1; page <= (maxPages || 30); page++) {
      const sep = pathname.indexOf('?') >= 0 ? '&' : '?';
      const got = pick(await get(pathname + sep + 'per_page=100&page=' + page)) || [];
      out.push.apply(out, got);
      if (got.length < 100) return { items: out, truncated: false };
    }
    return { items: out, truncated: true };
  }
  return { get, paged };
}

/* ── the job ─────────────────────────────────────────────────────────────── */
function flagValue(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function short(sha) { return String(sha || '').slice(0, 9); }
const MARK = { pass: 'PASS', fail: 'FAIL', missing: 'MISSING', disabled: 'DISABLED', running: 'RUNNING', 'not-started': 'WAITING' };

function report(ctx, v, log) {
  const order = { fail: 0, missing: 1, running: 2, 'not-started': 3, disabled: 4, pass: 5 };
  const rows = v.rows.slice().sort((a, b) => (order[a.state] - order[b.state]) || a.file.localeCompare(b.file));
  rows.forEach((r) => log('  ' + (MARK[r.state] || r.state).padEnd(8) + ' ' + r.name + ' (' + path.basename(r.file) + ')' +
    (r.run && r.state !== 'pass' ? ' — ' + (r.run.conclusion || r.run.status) + ' · ' + r.run.html_url : '') + (r.predicted ? '' : '  [' + r.why + ']')));
  v.reasons.forEach((x) => log('  ' + x));
  const head = v.verdict === 'pass' ? 'ALL CHECKS PASSED' : v.verdict === 'fail' ? 'ALL CHECKS FAILED' : 'ALL CHECKS STILL RUNNING';
  log(head + ' · ' + v.rows.filter((r) => r.state === 'pass').length + ' of ' + v.rows.filter((r) => r.state !== 'disabled').length + ' workflows passed on ' + short(ctx.head));
  if (!ctx.summaryFile) return;
  const md = ['## ' + head, '', 'Pull request #' + ctx.pr + ' · head `' + short(ctx.head) + '` · ' + ctx.fileCount + ' changed files · ' + v.rows.length + ' workflows', ''];
  v.reasons.forEach((x) => md.push('- ' + x));
  md.push('', '| Result | Workflow | Why it ran | Run |', '|---|---|---|---|');
  rows.forEach((r) => md.push('| ' + (MARK[r.state] || r.state) + ' | ' + r.name + ' | ' + String(r.why).replace(/\|/g, '\\|') + ' | ' + (r.run ? '[' + (r.run.conclusion || r.run.status) + '](' + r.run.html_url + ')' : '—') + ' |'));
  try { fs.appendFileSync(ctx.summaryFile, md.join('\n') + '\n'); } catch (_) { /* the summary is a courtesy */ }
}

async function main(argv, env, opts) {
  const o = opts || {};
  const log = o.log || ((s) => console.log(s));
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const once = argv.indexOf('--once') >= 0;
  const root = flagValue(argv, '--root') || ROOT;
  const repo = flagValue(argv, '--repo') || env.GITHUB_REPOSITORY;
  const pollMs = 1000 * Number(env.GATE_POLL_SECONDS || 30);
  const appearMs = 60000 * Number(env.GATE_APPEAR_MINUTES || 10);
  const waitMs = 60000 * Number(env.GATE_WAIT_MINUTES || 85);
  const selfPath = (String(env.GITHUB_WORKFLOW_REF || '').match(/(\.github\/workflows\/[^@]+)@/) || [])[1] || SELF;
  if (!repo) { log('all checks could not run: no repository (GITHUB_REPOSITORY or --repo)'); return 2; }
  const api = client(env, { sleep });

  let pr = flagValue(argv, '--pr'), head = null, base = null;
  if (!pr && env.GITHUB_EVENT_PATH) {
    const ev = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (ev.pull_request) { pr = ev.pull_request.number; head = ev.pull_request.head.sha; base = ev.pull_request.base.ref; }
  }
  if (!pr) { log('all checks could not run: not a pull request (no pull_request event and no --pr)'); return 2; }
  if (!head) { const p = await api.get('/repos/' + repo + '/pulls/' + pr); head = p.head.sha; base = p.base.ref; }

  const files = await api.paged('/repos/' + repo + '/pulls/' + pr + '/files', (x) => x, 30);
  const names = files.items.map((f) => f.filename);
  const wfs = await api.paged('/repos/' + repo + '/actions/workflows', (x) => x.workflows, 10);
  const states = {};
  wfs.items.forEach((w) => { states[w.path] = w.state; });
  const expected = expectedWorkflows(root, names, base, { selfPath, states });
  const ctx = { pr, head, base, fileCount: names.length, summaryFile: env.GITHUB_STEP_SUMMARY || null };
  log('all checks · pull request #' + pr + ' into ' + base + ' · head ' + short(head) + ' · ' + names.length + ' changed file' + (names.length === 1 ? '' : 's') + (files.truncated ? ' (the API lists 3000 at most)' : ''));
  log('  ' + expected.length + ' workflows predicted from their own on: blocks: ' + expected.map((e) => path.basename(e.file)).join(', '));

  const t0 = now();
  let v, said = '';
  for (;;) {
    const runs = await api.paged('/repos/' + repo + '/actions/runs?head_sha=' + head + '&event=pull_request', (x) => x.workflow_runs, 10);
    v = evaluate({ expected, runs: runs.items, selfPath, selfRunId: env.GITHUB_RUN_ID, elapsedMs: now() - t0, appearMs, fileCount: names.length });
    if (v.verdict !== 'wait' || once) break;
    if (now() - t0 >= waitMs) {
      v.verdict = 'fail';
      v.reasons.push('still running after ' + Math.round(waitMs / 60000) + ' min: ' + v.waiting.map((r) => r.name).join(', ') + '. Re-run All checks once they finish');
      break;
    }
    const line = 'waiting on ' + v.waiting.length + ': ' + v.waiting.slice(0, 6).map((r) => r.name).join(', ') + (v.waiting.length > 6 ? ' …' : '');
    if (line !== said) { log('  ' + line); said = line; }
    await sleep(pollMs);
  }
  report(ctx, v, log);
  return v.verdict === 'pass' ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; },
    (e) => { console.error('all checks could not run: ' + (e && e.stack || e)); process.exitCode = 2; });
}
module.exports = { SELF, classify, runPath, expectedWorkflows, evaluate, client, main };
