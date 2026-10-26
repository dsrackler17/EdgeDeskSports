#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — every workflow a pull request triggered must pass.

   WHY. #801 was merged while "Model performance tests" was still running on
   its last commit; it failed a minute later, on main. Almost every suite here
   runs only when its paths change, so none of them can be a required check:
   a required check that never runs leaves every other pull request waiting
   forever. This job makes them required ONLY WHEN THEY RUN: it waits for every
   workflow run GitHub started for the pull request's head commit, and fails
   if any of them did not succeed. The integrity-gate check includes it, so a
   pull request is mergeable only when everything that ran on it is green.

   A run counts by workflow: the newest run of each workflow for the commit
   (a re-run replaces the attempt in place). success, skipped and neutral
   pass; failure, cancelled, timed_out, action_required, startup_failure and
   stale do not. This workflow's own runs are not waited on.

     node tools/integrity/wait_ci.js --sha <head sha> [--timeout-min 150]
   ============================================================================ */
'use strict';
const fs = require('fs');
const GH = require('./github');

const PASS = new Set(['success', 'skipped', 'neutral']);

function arg(args, name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }

/* The newest run per workflow, excluding the given workflow ids. */
function latestPerWorkflow(runs, excludeIds) {
  const by = new Map();
  for (const r of runs) {
    if (excludeIds.has(r.workflow_id)) continue;
    const cur = by.get(r.workflow_id);
    if (!cur || r.run_number > cur.run_number || (r.run_number === cur.run_number && Date.parse(r.created_at) > Date.parse(cur.created_at))) by.set(r.workflow_id, r);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* { done, failed[], pending[] } for a set of runs */
function verdict(runs) {
  const pending = runs.filter((r) => r.status !== 'completed');
  const failed = runs.filter((r) => r.status === 'completed' && !PASS.has(r.conclusion));
  return { done: pending.length === 0, pending, failed };
}

async function main(args) {
  const sha = arg(args, '--sha', process.env.HEAD_SHA);
  const repo = GH.repo();
  if (!sha || !repo || !GH.token()) { console.error('wait-ci: needs --sha, GITHUB_REPOSITORY and a token'); return 2; }
  const timeoutMs = Number(arg(args, '--timeout-min', '150')) * 60e3;
  const pollMs = Number(arg(args, '--poll-sec', '30')) * 1e3;
  const settleMs = Number(arg(args, '--settle-sec', '60')) * 1e3;
  const exclude = new Set();
  if (process.env.GITHUB_RUN_ID) {
    const me = await GH.api('GET', '/repos/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID);
    if (me.ok && me.json) exclude.add(me.json.workflow_id);
  }
  const started = Date.now();
  let prevIds = '', runs = [];
  for (;;) {
    const all = await GH.paginate('/repos/' + repo + '/actions/runs?head_sha=' + sha, (j) => j.workflow_runs || []);
    runs = latestPerWorkflow(all, exclude);
    const v = verdict(runs);
    const ids = runs.map((r) => r.id + ':' + r.run_attempt).join(',');
    const settled = Date.now() - started >= settleMs;
    /* a workflow that has not created its run yet would be missed: decide only
       after the settle time, on two polls that saw the same runs */
    if (v.done && settled && ids === prevIds) break;
    if (Date.now() - started > timeoutMs) {
      report(runs, sha, 'timed out after ' + Math.round(timeoutMs / 60e3) + ' min waiting for: ' + v.pending.map((r) => r.name).join(', '));
      return 1;
    }
    if (!v.done) console.log('waiting on ' + v.pending.length + ' workflow(s): ' + v.pending.map((r) => r.name + ' (' + r.status + ')').join(', '));
    prevIds = ids;
    await GH.sleep(pollMs);
  }
  const v = verdict(runs);
  report(runs, sha, v.failed.length ? v.failed.length + ' workflow(s) did not pass' : null);
  return v.failed.length ? 1 : 0;
}

function report(runs, sha, problem) {
  const lines = ['### Every workflow on `' + sha.slice(0, 10) + '`: ' + (problem ? '❌ ' + problem : '✅ ' + runs.length + ' passed'), '', '| Workflow | Result |', '|---|---|'];
  runs.forEach((r) => lines.push('| [' + r.name + '](' + r.html_url + ') | ' + (r.status === 'completed' ? r.conclusion : r.status) + ' |'));
  const md = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  runs.filter((r) => r.status === 'completed' && !PASS.has(r.conclusion)).forEach((r) => console.log('::error title=' + r.name + '::' + r.name + ' ' + r.conclusion + ' on this commit — ' + r.html_url));
}

module.exports = { main, latestPerWorkflow, verdict, PASS };

/* run directly by the ci-complete job, whose checkout holds tools/integrity only */
if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('wait-ci could not run: ' + (e && e.stack || e)); process.exit(2); });
}
