#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — when main changes under open pull requests, check them again.

   An integrity-gate result says "this pull request merged into main @ X is
   sound". When another pull request merges, X is no longer main, and a pass
   against X proves nothing about the merge that would happen now; when a pull
   request closes, the subsystems it held are free. So on every merge into
   main and every closed pull request, this re-runs the integrity gate of every
   other open pull request into main. While it re-runs, its check is pending
   and the pull request cannot merge.

   (Bot publishes do not trigger this — a GITHUB_TOKEN push starts no
   workflow — and need not: a bot changes only the files it owns, which the
   gate keeps pull requests away from, so the textual merge cannot change.)

   A gate run that started before this one is cancelled and re-run (it may
   have merged with the old main); one that started after already saw the new
   main and is left alone.
   ============================================================================ */
'use strict';
const GH = require('./github');

const GATE_FILE = 'integrity-gate.yml';

async function waitCompleted(repo, id, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await GH.api('GET', '/repos/' + repo + '/actions/runs/' + id);
    if (r.ok && r.json && r.json.status === 'completed') return true;
    await GH.sleep(5000);
  }
  return false;
}

async function main() {
  const repo = GH.repo();
  if (!repo || !GH.token()) { console.error('revalidate: needs GITHUB_REPOSITORY and a token'); return 2; }
  const base = process.env.BASE_REF || 'main';
  const skip = Number(process.env.CLOSED_PR || 0);
  let since = Date.now();
  if (process.env.GITHUB_RUN_ID) {
    const me = await GH.api('GET', '/repos/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID);
    if (me.ok && me.json) since = Date.parse(me.json.created_at);
  }
  const open = await GH.paginate('/repos/' + repo + '/pulls?state=open&base=' + encodeURIComponent(base), null);
  let n = 0;
  for (const pr of open) {
    if (pr.number === skip) continue;
    /* the pull request's own run, or the one a bot dispatched after committing
       into the branch (a GITHUB_TOKEN push starts no pull_request run) */
    const runs = await GH.api('GET', '/repos/' + repo + '/actions/workflows/' + GATE_FILE + '/runs?head_sha=' + pr.head.sha + '&per_page=10');
    const run = runs.ok && runs.json && (runs.json.workflow_runs || []).find((r) => r.event === 'pull_request' || r.event === 'workflow_dispatch');
    if (!run) { console.log('#' + pr.number + ': no gate run on ' + pr.head.sha.slice(0, 10) + ' yet; its next push runs one'); continue; }
    if (run.status !== 'completed') {
      if (Date.parse(run.run_started_at || run.created_at) >= since) { console.log('#' + pr.number + ': gate run ' + run.id + ' started after main changed; left alone'); continue; }
      await GH.api('POST', '/repos/' + repo + '/actions/runs/' + run.id + '/cancel');
      if (!(await waitCompleted(repo, run.id, 120e3))) { console.log('::warning::#' + pr.number + ': gate run ' + run.id + ' did not stop; not re-run'); continue; }
    }
    const r = await GH.api('POST', '/repos/' + repo + '/actions/runs/' + run.id + '/rerun');
    console.log('#' + pr.number + ': gate re-run ' + (r.ok ? 'requested' : 'refused (HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120) + ')') + ' — ' + run.html_url);
    if (r.ok) n++;
  }
  console.log(n + ' pull request(s) re-checked against the new main');
  return 0;
}

module.exports = { main };

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e && e.stack || e); process.exit(2); });
