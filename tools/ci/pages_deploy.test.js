#!/usr/bin/env node
/* ===========================================================================
   .github/workflows/pages-deploy.yml: the site's deploy is never cancelled
   by the next push, the data jobs' pushes still reach the site, and the
   workflow is inert until Pages' source is GitHub Actions.

   The failure this guards: Pages' own branch build cancels the build before
   it on every push. The data jobs push every few minutes and a build takes
   about four, so on 2026-10-28 23 builds in a row were cancelled (19:54 to
   20:38 UTC) and the site served a 19:49 copy through three merges.

     1  a new run waits for the one in progress (one concurrency group,
        cancel-in-progress false); no pull request starts it
     2  it runs on a merge, on a schedule (the data jobs push with
        GITHUB_TOKEN, which starts no workflow) and by hand
     3  the build is the branch build's: Jekyll over the repository root
     4  only the deploy job may write Pages or mint an OIDC token; the
        workflow's default is read-only
     5  the source check, run against a stand-in `gh`: "workflow" lets the
        deploy run; the branch source deploys nothing and says so in the
        summary; a failed read of the source fails the job

   Run: node tools/ci/pages_deploy.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseYaml } = require('./workflows.js');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, '.github', 'workflows', 'pages-deploy.yml');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const exists = fs.existsSync(FILE);
chk('.github/workflows/pages-deploy.yml exists', exists);
const wf = exists ? parseYaml(fs.readFileSync(FILE, 'utf8')) : {};
const on = wf.on || {};
const jobs = wf.jobs || {};

/* 1. queued, never cancelled */
chk('1 one concurrency group for every run', !!wf.concurrency && wf.concurrency.group === 'pages', wf.concurrency);
chk('  and a new run waits for the one in progress (cancel-in-progress: false)', !!wf.concurrency && wf.concurrency['cancel-in-progress'] === false, wf.concurrency);
chk('  no pull request starts it', !Object.prototype.hasOwnProperty.call(on, 'pull_request') && !Object.prototype.hasOwnProperty.call(on, 'pull_request_target'), Object.keys(on));

/* 2. when it runs */
chk('2 a merge to main starts it', !!on.push && JSON.stringify(on.push.branches) === '["main"]' && !on.push.paths, on.push);
const cron = ((on.schedule || [])[0] || {}).cron || '';
const every = (cron.match(/^\*\/(\d+) \* \* \* \*$/) || [])[1];
chk('  and a schedule publishes the data jobs\' pushes, at least every 15 minutes', !!every && Number(every) >= 5 && Number(every) <= 15, cron);
chk('  and it can be run by hand', Object.prototype.hasOwnProperty.call(on, 'workflow_dispatch'));

/* 3. the branch build's build */
const steps = ((jobs.build || {}).steps || []);
const jekyll = steps.find((s) => /^actions\/jekyll-build-pages@v1$/.test(s.uses || '')) || {};
chk('3 the build is Jekyll over the repository root, as Pages\' branch build did', jekyll.with && jekyll.with.source === './' && jekyll.with.destination === './_site', jekyll);
chk('  after a checkout, and the result is uploaded as the Pages artifact', /^actions\/checkout@/.test((steps[0] || {}).uses || '') && steps.some((s) => /^actions\/upload-pages-artifact@/.test(s.uses || '')), steps.map((s) => s.uses || s.name));
const dsteps = ((jobs.deploy || {}).steps || []);
chk('  and the deploy job deploys it to the github-pages environment', JSON.stringify(jobs.deploy && jobs.deploy.needs) === '"build"' && (jobs.deploy.environment || {}).name === 'github-pages'
  && dsteps.some((s) => /^actions\/deploy-pages@/.test(s.uses || '') && s.id === 'deployment'), jobs.deploy);

/* 4. least privilege */
chk('4 the workflow\'s default permission is contents: read, nothing else', JSON.stringify(wf.permissions) === '{"contents":"read"}', wf.permissions);
chk('  only the deploy job may write Pages and mint an OIDC token', JSON.stringify((jobs.deploy || {}).permissions) === '{"pages":"write","id-token":"write"}'
  && Object.keys(jobs).filter((k) => k !== 'deploy').every((k) => !/write/.test(JSON.stringify(jobs[k].permissions || {}))), Object.keys(jobs).map((k) => k + ' ' + JSON.stringify(jobs[k].permissions || null)));
chk('  every job has a time limit', Object.keys(jobs).length === 3 && Object.keys(jobs).every((k) => Number(jobs[k]['timeout-minutes']) > 0), Object.keys(jobs));

/* 5. inert until the source is GitHub Actions */
chk('5 the build runs only when the source check says the Pages source is GitHub Actions', JSON.stringify((jobs.build || {}).needs) === '"source"'
  && (jobs.build || {}).if === "needs.source.outputs.actions == 'true'", jobs.build && jobs.build.if);
const srcStep = (((jobs.source || {}).steps) || []).find((s) => s.id === 'src') || {};
chk('  the source check reads the Pages site with the job\'s own read-only token', /gh api "repos\/\$REPO\/pages" --jq '\.build_type'/.test(srcStep.run || '')
  && JSON.stringify((jobs.source || {}).permissions) === '{"pages":"read"}', srcStep.run);

function runSource(ghBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-src-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/usr/bin/env bash\n' + ghBody + '\n', { mode: 0o755 });
  const out = path.join(dir, 'output'), sum = path.join(dir, 'summary');
  fs.writeFileSync(out, ''); fs.writeFileSync(sum, '');
  const r = spawnSync('bash', ['-c', srcStep.run || 'exit 99'], { env: Object.assign({}, process.env,
    { PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, REPO: 'o/r', GH_TOKEN: 't' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const res = { code: r.status, output: fs.readFileSync(out, 'utf8'), summary: fs.readFileSync(sum, 'utf8') };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}
{
  const r = runSource('[ "$1 $2" = "api repos/o/r/pages" ] && echo workflow');
  chk('  source "workflow": the deploy runs', r.code === 0 && r.output.trim() === 'actions=true' && r.summary === '', r);
}
{
  const r = runSource('echo legacy');
  chk('  source "legacy" (the branch): nothing is deployed, and the run\'s summary says why', r.code === 0 && r.output.trim() === 'actions=false'
    && /Nothing deployed: Pages still builds from the branch \(build_type: legacy\)/.test(r.summary) && /GitHub Actions/.test(r.summary), r);
}
{
  const r = runSource('echo "gh: Not Found (HTTP 404)" >&2; exit 1');
  chk('  the source cannot be read: the job fails, and nothing is reported as deployed', r.code !== 0 && r.output === '', r);
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + String(JSON.stringify(f.detail)).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'pages deploy — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
