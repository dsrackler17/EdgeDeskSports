#!/usr/bin/env node
/* ===========================================================================
   H-RADAR-01's one look, across runs. Run by .github/workflows/
   radar-validation.yml before the runner, with the job's GITHUB_TOKEN.

   run_validation.js refuses to fetch while a completed report is committed.
   That alone does not stop a second look: GitHub starts the workflow again
   on every push to the pull request (its paths: filter reads the whole pull
   request's diff), and between the first run and the commit of its report a
   second run would look at the holdout again. So, while no report is
   committed, this refuses when any earlier run or attempt of the workflow
   finished its live step green (a green live step printed a report), and
   names that run: its report is the one to commit, exactly as printed.

   It fails closed: if GitHub's API cannot be read, nothing is fetched.
   Offline test: tools/radar/validation.test.js.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const LIVE_STEP = 'H-RADAR-01 on its registered holdout';
const REPORT_FILE = path.join(__dirname, 'H-RADAR-01', 'report.json');

/* the jobs, other than this run attempt's own, whose live step finished green */
function spent(jobs, self) {
  return jobs.filter((j) => !(String(j.run_id) === String(self.run_id) && String(j.run_attempt) === String(self.run_attempt)))
    .filter((j) => (j.steps || []).some((s) => String(s.name || '').startsWith(LIVE_STEP) && s.conclusion === 'success'));
}

/* ok, or why not */
function decide(jobs, self, reportCommitted) {
  if (reportCommitted) return { ok: true, why: 'a report is committed: the runner checks it and fetches nothing' };
  const s = spent(jobs, self);
  if (!s.length) return { ok: true, why: 'no earlier run looked at the holdout: this run is the one look' };
  return { ok: false, why: 'the one look was spent by run ' + s.map((j) => j.run_id + ' (attempt ' + j.run_attempt + ')').join(', ')
    + ' and its report is not committed: commit that report to research/radar/H-RADAR-01/report.json exactly as printed. Nothing is fetched.' };
}

async function main() {
  const repo = process.env.REPO, token = process.env.GH_TOKEN;
  const self = { run_id: process.env.RUN_ID, run_attempt: process.env.RUN_ATTEMPT };
  const reportCommitted = fs.existsSync(REPORT_FILE);
  if (reportCommitted) { console.log('ok      ' + decide([], self, true).why); return 0; }
  if (!repo || !token || !self.run_id || !self.run_attempt) { console.log('FAIL    REPO, GH_TOKEN, RUN_ID and RUN_ATTEMPT are required: nothing is fetched'); return 1; }
  const api = async (p) => {
    const r = await fetch('https://api.github.com/repos/' + repo + p, { headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    if (!r.ok) throw new Error('GitHub API ' + r.status + ' on ' + p);
    return r.json();
  };
  const runs = (await api('/actions/workflows/radar-validation.yml/runs?per_page=100')).workflow_runs || [];
  const jobs = [];
  for (const run of runs) {
    const js = (await api('/actions/runs/' + run.id + '/jobs?filter=all&per_page=100')).jobs || [];
    js.forEach((j) => jobs.push({ run_id: run.id, run_attempt: j.run_attempt, steps: j.steps }));
  }
  const d = decide(jobs, self, false);
  console.log((d.ok ? 'ok      ' : 'FAIL    ') + d.why + ' (' + runs.length + ' runs of this workflow read)');
  return d.ok ? 0 : 1;
}
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.log('FAIL    ' + (e && e.message || e) + ': nothing is fetched'); process.exit(1); });
module.exports = { spent, decide, LIVE_STEP };
