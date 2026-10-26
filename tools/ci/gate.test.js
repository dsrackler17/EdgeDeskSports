#!/usr/bin/env node
/* ===========================================================================
   tools/ci/gate.js (All checks), against a fake GitHub API.

   The verdict on one look at a head commit's runs, for every outcome a run
   can end in. Then the whole job against a local HTTP server that pages the
   changed files and the runs, lets runs finish over several polls, fails
   once with a 502, and refuses with a 404. Last, the repository's own
   wiring:
     - all-checks.yml runs on every pull request and only reads;
     - every check docs/ci/main-ruleset.json requires is one job, reported
       on every pull request.

   Run: node tools/ci/gate.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('./gate.js');
const W = require('./workflows.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };

/* a synthetic repository: this gate, one workflow on every pull request, two path-filtered, one on another base, one push-only */
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-gate-test-'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), text); };
const JOBS = 'jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node -e 0\n';
write('.github/workflows/all-checks.yml', 'name: All checks\non:\n  pull_request:\n' + JOBS);
write('.github/workflows/every.yml', 'name: Every PR\non:\n  pull_request:\n' + JOBS);
write('.github/workflows/lib.yml', "name: Lib suite\non:\n  pull_request:\n    paths:\n      - 'lib/**'\n" + JOBS);
write('.github/workflows/docs.yml', "name: Docs suite\non:\n  pull_request:\n    paths:\n      - 'docs/**'\n" + JOBS);
write('.github/workflows/release.yml', "name: Release only\non:\n  pull_request:\n    branches: ['release/*']\n" + JOBS);
write('.github/workflows/push.yml', 'name: Push only\non:\n  push:\n    branches: [main]\n' + JOBS);

const run = (id, file, status, conclusion, extra) => Object.assign({ id, name: file.replace(/\.yml$/, ''), path: '.github/workflows/' + file, event: 'pull_request', status, conclusion: conclusion || null, html_url: 'https://example.test/runs/' + id }, extra || {});
const exp = (files) => G.expectedWorkflows(R, files, 'main');
const look = (runs, extra) => G.evaluate(Object.assign({ expected: exp(['lib/a.js']), runs, elapsedMs: 0, appearMs: 600000, fileCount: 1 }, extra || {}));
const state = (v, file) => (v.rows.find((r) => r.file === '.github/workflows/' + file) || {}).state;

/* ── one run, one verdict ─────────────────────────────────────────────────── */
chk('success, skipped and neutral pass', ['success', 'skipped', 'neutral'].every((c) => G.classify(run(1, 'x.yml', 'completed', c)) === 'pass'));
chk('failure, cancelled, timed_out, action_required, startup_failure and stale fail',
  ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', null].every((c) => G.classify(run(1, 'x.yml', 'completed', c)) === 'fail'));
chk('queued, in_progress, waiting and pending are still running', ['queued', 'in_progress', 'waiting', 'pending', 'requested'].every((s) => G.classify(run(1, 'x.yml', s)) === 'running'));
chk('a run path loses its ref suffix', G.runPath({ path: '.github/workflows/x.yml@refs/pull/7/merge' }) === '.github/workflows/x.yml');

/* ── which workflows a change starts ──────────────────────────────────────── */
const e1 = exp(['lib/a.js']).map((e) => path.basename(e.file)).sort();
chk('a lib change: the unfiltered workflow and the lib suite, never the gate itself', JSON.stringify(e1) === JSON.stringify(['every.yml', 'lib.yml']), e1);
const e2 = exp(['docs/a.md']).map((e) => path.basename(e.file)).sort();
chk('a docs change: the docs suite instead of the lib suite', JSON.stringify(e2) === JSON.stringify(['docs.yml', 'every.yml']), e2);
chk('a branches filter for release/* and a push-only workflow are never expected on a pull request into main', !exp(['lib/a.js', 'docs/a.md']).some((e) => /release|push/.test(e.file)));
const dis = G.expectedWorkflows(R, ['lib/a.js'], 'main', { states: { '.github/workflows/lib.yml': 'disabled_manually' } }).find((e) => /lib\.yml/.test(e.file));
chk('a workflow disabled in the settings is expected but marked disabled', dis && dis.state === 'disabled_manually', dis);

/* ── the verdict on one look ──────────────────────────────────────────────── */
let v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'skipped')]);
chk('every expected run finished green: pass', v.verdict === 'pass' && v.rows.length === 2, v);
v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'in_progress')]);
chk('one still running: wait', v.verdict === 'wait' && v.waiting.length === 1, v.verdict);
v = look([run(1, 'every.yml', 'completed', 'failure'), run(2, 'lib.yml', 'queued')]);
chk('a failure fails at once, while another is still running', v.verdict === 'fail' && /Every PR \(failure\)/.test(v.reasons[0]), v.reasons);
v = look([run(1, 'every.yml', 'completed', 'cancelled'), run(2, 'lib.yml', 'completed', 'success')]);
chk('a cancelled run fails: that commit was not tested', v.verdict === 'fail' && state(v, 'every.yml') === 'fail', v.reasons);
v = look([run(1, 'every.yml', 'completed', 'success')]);
chk('a predicted workflow not started yet, inside the window: wait', v.verdict === 'wait' && state(v, 'lib.yml') === 'not-started', v.verdict);
v = look([run(1, 'every.yml', 'completed', 'success')], { elapsedMs: 600000 });
chk('...and after the window: fail, naming it and the reader to fix', v.verdict === 'fail' && state(v, 'lib.yml') === 'missing' && /never started/.test(v.reasons[0]) && /fix the reader, never this check/.test(v.reasons[0]), v.reasons);
v = look([run(1, 'every.yml', 'completed', 'success')], { elapsedMs: 600000, fileCount: 412 });
chk('...on a change of over 300 files, it says GitHub reads only the first 300', v.verdict === 'fail' && /first 300 changed files only; this pull request changes 412/.test(v.reasons[0]), v.reasons);
v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success'), run(3, 'surprise.yml', 'completed', 'failure')]);
chk('a run nobody predicted still counts when it fails', v.verdict === 'fail' && v.rows.some((r) => !r.predicted && r.state === 'fail'), v.reasons);
v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success'), run(3, 'surprise.yml', 'completed', 'success')]);
chk('...and is listed as not predicted when it passes', v.verdict === 'pass' && v.rows.some((r) => !r.predicted && /not predicted/.test(r.why)), v.rows.length);
v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success'), run(9, 'all-checks.yml', 'in_progress')]);
chk('its own run, by path, neither holds the wait nor counts', v.verdict === 'pass' && !v.rows.some((r) => /all-checks/.test(r.file)), v.verdict);
v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success'), run(9, 'renamed-gate.yml', 'in_progress')], { selfRunId: 9 });
chk('...and by run id', v.verdict === 'pass', v.verdict);
v = look([run(1, 'every.yml', 'completed', 'failure'), run(5, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success')]);
chk('a newer run of the same workflow replaces a failed older one', v.verdict === 'pass', v.reasons);
v = look([run(1, 'every.yml', 'completed', 'success'), run(5, 'every.yml', 'completed', 'failure'), run(2, 'lib.yml', 'completed', 'success')]);
chk('...and a newer failure replaces an older pass', v.verdict === 'fail', v.verdict);
v = look([run(1, 'every.yml', 'completed', 'success', { run_attempt: 2 }), run(2, 'lib.yml', 'completed', 'success')]);
chk('a re-run attempt is read as the run now stands', v.verdict === 'pass', v.verdict);
v = look([run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success'), run(3, 'push.yml', 'completed', 'failure', { event: 'push' })]);
chk('a push run on the same commit is not this pull request\'s check', v.verdict === 'pass', v.reasons);
v = G.evaluate({ expected: G.expectedWorkflows(R, ['lib/a.js'], 'main', { states: { '.github/workflows/lib.yml': 'disabled_manually' } }), runs: [run(1, 'every.yml', 'completed', 'success')], elapsedMs: 600000, appearMs: 600000, fileCount: 1 });
chk('a disabled workflow is named and not waited on', v.verdict === 'pass' && state(v, 'lib.yml') === 'disabled', v.reasons);
v = G.evaluate({ expected: G.expectedWorkflows(R, ['lib/a.js'], 'main', { states: { '.github/workflows/lib.yml': 'disabled_manually' } }), runs: [run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'failure')], elapsedMs: 0, appearMs: 600000, fileCount: 1 });
chk('...but a run it started before it was disabled still counts when it fails', v.verdict === 'fail' && state(v, 'lib.yml') === 'fail', v.rows.map((r) => r.state));
v = look([run(1, 'every.yml', 'completed', 'success', { path: '.github/workflows/every.yml@refs/pull/7/merge' }), run(2, 'lib.yml', 'completed', 'success')]);
chk('a run path with a ref suffix still matches its workflow', v.verdict === 'pass' && v.rows.length === 2, v.rows.map((r) => r.file));

/* ── the whole job, against a fake API ────────────────────────────────────── */
function fakeApi(spec) {
  const seen = [];
  let runsPolls = 0, fails = spec.fail502 || 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, page: u.searchParams.get('page'), auth: req.headers.authorization || null, q: u.search });
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const page = Number(u.searchParams.get('page') || 1);
    if (u.pathname === '/repos/o/r/pulls/7/files') {
      if (spec.files404) return send(404, { message: 'Not Found' });
      const all = spec.files.map((f) => ({ filename: f }));
      return send(200, all.slice((page - 1) * 100, page * 100));
    }
    if (u.pathname === '/repos/o/r/actions/workflows') return send(200, { workflows: page === 1 ? (spec.workflows || []) : [] });
    if (u.pathname === '/repos/o/r/actions/runs') {
      if (u.searchParams.get('head_sha') !== 'abc123' || u.searchParams.get('event') !== 'pull_request') return send(422, { message: 'wrong query' });
      if (fails > 0) { fails--; return send(502, { message: 'Bad Gateway' }); }
      const frame = spec.frames[Math.min(runsPolls, spec.frames.length - 1)];
      if (page === 1) runsPolls++;
      return send(200, { total_count: frame.length, workflow_runs: page === 1 ? frame : [] });
    }
    send(404, { message: 'no route ' + u.pathname });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: 'http://127.0.0.1:' + srv.address().port, polls: () => runsPolls })));
}
async function job(spec, envExtra, argvExtra) {
  const api = await fakeApi(spec);
  const ev = path.join(R, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abc123' }, base: { ref: 'main' } } }));
  const summary = path.join(R, 'summary-' + Math.random().toString(36).slice(2) + '.md');
  let clock = 0;
  const lines = [];
  const env = Object.assign({ GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_EVENT_PATH: ev, GITHUB_STEP_SUMMARY: summary, GITHUB_RUN_ID: '9' }, envExtra || {});
  let code, err = null;
  try { code = await G.main(['--root', R].concat(argvExtra || []), env, { log: (s) => lines.push(s), sleep: async (ms) => { clock += ms; }, now: () => clock }); }
  catch (e) { err = e; }
  api.srv.close();
  return { code, err, out: lines.join('\n'), seen: api.seen, polls: api.polls(), summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
}

(async () => {
  const files = Array.from({ length: 150 }, (_, i) => 'lib/f' + i + '.js');
  const running = [run(1, 'every.yml', 'in_progress'), run(2, 'lib.yml', 'queued'), run(9, 'all-checks.yml', 'in_progress')];
  const green = [run(1, 'every.yml', 'completed', 'success'), run(2, 'lib.yml', 'completed', 'success'), run(9, 'all-checks.yml', 'in_progress')];
  let j = await job({ files, frames: [running, running, green] });
  chk('the job waits through two polls and passes when every run is green', j.code === 0 && j.polls === 3 && /ALL CHECKS PASSED · 2 of 2/.test(j.out), j.err || j.out);
  chk('it reads all 150 changed files, over two pages', /150 changed files/.test(j.out) && j.seen.some((s) => s.path.endsWith('/files') && s.page === '2'), j.out.split('\n')[0]);
  chk('it says what it waits on, once per change', (j.out.match(/waiting on 2/g) || []).length === 1, j.out);
  chk('it sends the token', j.seen.every((s) => s.auth === 'Bearer t'), j.seen.map((s) => s.auth));
  chk('it writes a step summary with one row per workflow', /## ALL CHECKS PASSED/.test(j.summary) && (j.summary.match(/^\| PASS \|/gm) || []).length === 2, j.summary);

  j = await job({ files: ['lib/a.js'], frames: [running, [run(1, 'every.yml', 'completed', 'failure'), run(2, 'lib.yml', 'in_progress')]] });
  chk('a run that fails fails the job (exit 1) without waiting for the rest', j.code === 1 && j.polls === 2 && /ALL CHECKS FAILED/.test(j.out) && /FAIL\s+Every PR/.test(j.out), j.out);
  chk('...and the summary links the failed run', /\| FAIL \| Every PR \|.*\[failure\]\(https:\/\/example\.test\/runs\/1\)/.test(j.summary), j.summary);

  j = await job({ files: ['lib/a.js'], frames: [green], fail502: 1 });
  chk('a 502 from the API is tried again', j.code === 0, j.err ? String(j.err) : j.out);

  let hits = 0;
  const hang = http.createServer((req, res) => { if (++hits === 1) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const got = await Promise.race([
    G.client({ GITHUB_API_URL: 'http://127.0.0.1:' + hang.address().port }, { sleep: async () => {}, timeoutMs: 300 }).get('/x').catch((e) => e),
    new Promise((r) => setTimeout(() => r(new Error('the request hung past 5 s: no timeout')), 5000).unref())]);
  hang.closeAllConnections(); hang.close();
  chk('a request that hangs times out and is tried again', got && got.ok === true && hits === 2, { got: String(got), hits });

  j = await job({ files: ['lib/a.js'], frames: [green], files404: true });
  chk('a 404 is not tried again: the job cannot run, and says why', j.err && /404/.test(String(j.err.message)) && j.seen.filter((s) => s.path.endsWith('/files')).length === 1, j.err ? String(j.err.message) : j.out);

  j = await job({ files: ['lib/a.js'], frames: [running] }, { GATE_WAIT_MINUTES: '1', GATE_POLL_SECONDS: '30' });
  chk('a wait that runs out fails, and says re-run All checks once they finish', j.code === 1 && /still running after 1 min/.test(j.out) && /Re-run All checks/.test(j.out), j.out);

  j = await job({ files: ['lib/a.js'], frames: [[run(1, 'every.yml', 'completed', 'success')]] }, { GATE_APPEAR_MINUTES: '1' });
  chk('a predicted workflow that never starts fails the job', j.code === 1 && /never started for this commit: Lib suite/.test(j.out), j.out);

  j = await job({ files: ['lib/a.js'], frames: [[run(1, 'every.yml', 'completed', 'success')]], workflows: [{ path: '.github/workflows/lib.yml', state: 'disabled_manually' }] });
  chk('a workflow disabled in the settings is read from the API and not waited on', j.code === 0 && /DISABLED\s+Lib suite/.test(j.out), j.out);

  j = await job({ files: ['lib/a.js'], frames: [running] }, {}, ['--once']);
  chk('--once never reports a commit still running as passed', j.code === 1 && /STILL RUNNING/.test(j.out) && j.polls === 1, j.out);

  j = await job({ files: ['lib/a.js'], frames: [green] }, { GITHUB_EVENT_PATH: '' });
  chk('outside a pull request (no event, no --pr) it cannot run: exit 2', j.code === 2 && /not a pull request/.test(j.out), j.out);

  /* ── this repository ───────────────────────────────────────────────────── */
  const wfs = W.loadWorkflows(ROOT);
  const gate = wfs.find((w) => w.file === G.SELF);
  chk('all-checks.yml exists', !!gate);
  if (gate) {
    chk('...and runs on every pull request into main (no paths or branches filter)', W.triggeredBy(gate, ['README.md'], 'main').run && W.triggeredBy(gate, ['anything/else.bin'], 'main').run && !gate.on.pull_request);
    const perms = gate.doc.permissions || {};
    chk('...and only reads: actions, contents and pull-requests, no write anywhere', perms.actions === 'read' && perms.contents === 'read' && perms['pull-requests'] === 'read' && !/:\s*write/.test(fs.readFileSync(path.join(ROOT, G.SELF), 'utf8')), perms);
    const jobs = Object.values(gate.doc.jobs || {});
    chk('...and its one job is named All checks, outlasts the wait, and is not a matrix', jobs.length === 1 && jobs[0].name === 'All checks' && Number(jobs[0]['timeout-minutes']) > 85 && !jobs[0].strategy, jobs.map((x) => [x.name, x['timeout-minutes']]));
    chk('...and a newer push to the pull request replaces its older run', gate.doc.concurrency && gate.doc.concurrency['cancel-in-progress'] === true && /github\.ref/.test(String(gate.doc.concurrency.group)), gate.doc.concurrency);
  }
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'ci', 'main-ruleset.json'), 'utf8')).rules;
  const req = ((rules.find((r) => r.type === 'required_status_checks') || {}).parameters || {}).required_status_checks || [];
  chk('the ruleset requires All checks', req.some((c) => c.context === 'All checks'), req.map((c) => c.context));
  req.forEach((c) => {
    const owners = [];
    wfs.forEach((w) => Object.entries((w.doc && w.doc.jobs) || {}).forEach(([id, jb]) => { if (((jb && jb.name) || id) === c.context) owners.push({ w, jb }); }));
    chk('required check "' + c.context + '" is the name of exactly one job', owners.length === 1, owners.map((o) => o.w.base));
    if (owners.length !== 1) return;
    const o = owners[0];
    chk('required check "' + c.context + '" reports on every pull request into main', W.triggeredBy(o.w, ['README.md'], 'main').run && W.triggeredBy(o.w, ['nothing/matches.this'], 'main').run, o.w.base);
    chk('required check "' + c.context + '" is not a matrix job and has no job-level if:', !o.jb.strategy && o.jb.if === undefined, o.w.base);
    chk('required check "' + c.context + '" is posted by GitHub Actions (app 15368)', c.integration_id === 15368, c.integration_id);
  });

  fs.rmSync(R, { recursive: true, force: true });
  if (fail) { failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? ' | ' + JSON.stringify(f.detail).slice(0, 900) : ''))); console.log('FAILED all checks gate — ' + pass + ' passed, ' + fail + ' failed'); process.exitCode = 1; }
  else console.log('ALL GREEN all checks gate — ' + pass + ' passed, 0 failed');
})().catch((e) => { console.log('FAIL | the suite threw: ' + (e && e.stack || e)); process.exitCode = 1; });
