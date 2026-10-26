#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — a bot's commit earns the `integrity-gate` status before it is
   pushed to main.

   WHY. The integrity gate becomes a REQUIRED status check on main (a branch
   ruleset). GitHub enforces a required check on direct pushes too: a commit
   pushed to main must already carry a passing status. The scheduled jobs push
   with the workflow's GITHUB_TOKEN, and that token cannot be put on a
   ruleset's bypass list. So a bot commit does what the ruleset asks of any
   commit: it is pushed to another branch first, checked, and marked.

     1. check the files the commit range changes (tools/integrity/gate.js
        files mode: JSON, JS, HTML scripts, conflict markers, …). A broken
        artifact is REFUSED here, before it can reach main.
     2. push the commit to integrity-attest/<run>-<n> (a GITHUB_TOKEN push
        triggers no workflow)
     3. POST /statuses/<sha>: context integrity-gate, state success,
        target_url this run
     4. delete the staging branch (the status belongs to the commit, not to
        the branch)

   Without a token (a local run, a test) steps 2–4 are skipped with a notice;
   the check in step 1 still runs and still refuses a broken commit. A failed
   status call is a warning, not a failure: until the ruleset is enabled the
   push needs no status, and once it is, GitHub's own refusal names the cause.

     node tools/integrity/attest.js --head <sha> --base <sha> [--remote origin]
   Exit 0: checked (and attested when possible). 1: the commit fails a check.
   ============================================================================ */
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const GH = require('./github');

const ROOT = path.join(__dirname, '..', '..');
const CONTEXT = 'integrity-gate';

/* Only a push to THIS repository on GitHub gets a status: a test's local bare
   remote never does (INTEGRITY_ATTEST_ANY_REMOTE=1 lets the attestation test
   drive a mock API against one). */
function remoteIsRepo(remote, repo) {
  if (process.env.INTEGRITY_ATTEST_ANY_REMOTE === '1') return true;
  let url = '';
  try { url = git(['remote', 'get-url', remote]); } catch (e) { return false; }
  const host = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^(https?://([^@/]+@)?|git@)' + esc(host) + '[:/]' + esc(repo) + '(\\.git)?/?$', 'i').test(url);
}

function arg(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; }
function git(args) { return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

async function main() {
  const head = git(['rev-parse', arg('--head', 'HEAD')]);
  const base = git(['rev-parse', arg('--base', head + '^')]);
  const remote = arg('--remote', process.env.PUSH_REMOTE || 'origin');

  const chk = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'integrity', 'gate.js'), 'files', '--base', base, '--head', head], { cwd: process.cwd(), encoding: 'utf8', env: Object.assign({}, process.env, { GITHUB_STEP_SUMMARY: '' }) });
  process.stdout.write(chk.stdout || '');
  process.stderr.write(chk.stderr || '');
  if (chk.status !== 0) {
    console.error('::error title=integrity::refusing to publish ' + head.slice(0, 10) + ': the files it changes fail the integrity check (above). Nothing was pushed.');
    return 1;
  }

  const repo = GH.repo();
  const token = GH.token(process.cwd());
  if (!repo || !token) {
    console.log('integrity: ' + head.slice(0, 10) + ' checked; no GitHub token or repository in this environment, so no status was set');
    return 0;
  }
  if (!remoteIsRepo(remote, repo)) {
    console.log('integrity: ' + head.slice(0, 10) + ' checked; remote ' + remote + ' is not ' + repo + ' on GitHub, so no status was set');
    return 0;
  }
  const runId = process.env.GITHUB_RUN_ID || String(Date.now());
  const stage = 'integrity-attest/' + runId + '-' + (process.env.GITHUB_RUN_ATTEMPT || '1') + '-' + head.slice(0, 12);
  const pushed = spawnSync('git', ['push', '-q', remote, head + ':refs/heads/' + stage], { cwd: process.cwd(), encoding: 'utf8' });
  if (pushed.status !== 0) {
    console.log('::warning title=integrity::could not stage ' + head.slice(0, 10) + ' for its status (' + (pushed.stderr || '').trim().split('\n').pop() + '); pushing without one');
    return 0;
  }
  try {
    const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
    const target = process.env.GITHUB_RUN_ID ? server + '/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID : undefined;
    const r = await GH.api('POST', '/repos/' + repo + '/statuses/' + head, {
      state: 'success', context: CONTEXT, target_url: target,
      description: 'bot publish: changed files checked by tools/integrity/attest.js'
    }, { cwd: process.cwd(), token });
    if (r.ok) console.log('integrity: ' + head.slice(0, 10) + ' checked and marked ' + CONTEXT + '=success');
    else console.log('::warning title=integrity::could not set the ' + CONTEXT + ' status on ' + head.slice(0, 10) + ' (HTTP ' + r.status + '). The job needs `statuses: write`. Once main requires the check, this push will be refused.');
  } finally {
    spawnSync('git', ['push', '-q', remote, '--delete', 'refs/heads/' + stage], { cwd: process.cwd(), stdio: 'ignore' });
  }
  return 0;
}

module.exports = { CONTEXT };

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error('::warning title=integrity::attestation could not run: ' + (e && e.message || e)); process.exit(0); });
}
