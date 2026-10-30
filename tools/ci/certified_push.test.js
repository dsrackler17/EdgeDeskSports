#!/usr/bin/env node
/* ===========================================================================
   tools/ci/certified_push.sh (and push_generated.sh through it), driven
   against a real bare repository, with a local server standing in for
   GitHub's check-runs API.

   What it holds: a push to main posts exactly one "All checks" success on
   the very commit that lands, while that commit sits on a ci-certify side
   branch, and the side branch is gone afterwards; any other branch is a plain
   push; a certificate that cannot be made never stops the push; git push's
   own exit code is the script's.

   Run: node tools/ci/certified_push.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'certified_push.sh');
const PUSHGEN = path.join(__dirname, 'push_generated.sh');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const BASE_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  PUSH_SLEEP: '0', PUSH_ATTEMPTS: '4', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW: 'Test data job',
});
delete BASE_ENV.GH_TOKEN; delete BASE_ENV.GITHUB_TOKEN; delete BASE_ENV.PUSH_CERTIFY; delete BASE_ENV.GITHUB_ACTIONS;

function git(cwd, args) { return execFileSync('git', args, { cwd, env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
function run(script, cwd, args, env) {
  return new Promise((resolve) => {
    const p = spawn('bash', [script].concat(args), { cwd, env: Object.assign({}, BASE_ENV, env || {}) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
function sideRefs(bare) { return git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/ci-certify']).split('\n').filter(Boolean); }
function tip(bare, b) { return git(bare, ['rev-parse', 'refs/heads/' + b]); }

/* a bare "origin" with main at one commit, and a clone to push from */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certified-push-'));
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work');
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'a.json'), '{"v":0}\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'base']); git(work, ['push', '-q', 'origin', 'main']);
  return { dir, bare, work };
}
function commit(work, v) { fs.writeFileSync(path.join(work, 'a.json'), '{"v":' + v + '}\n'); git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'data ' + v]); return git(work, ['rev-parse', 'HEAD']); }

(async () => {
  /* the stand-in API: records every request, answers with `status` */
  let status = 201, bareForProbe = null;
  const posts = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(b); } catch (_) { /* recorded as null */ }
      posts.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, sides: bareForProbe ? sideRefs(bareForProbe) : [] });
      res.writeHead(status, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const API = 'http://127.0.0.1:' + srv.address().port;
  const ON = { PUSH_CERTIFY: '1', GITHUB_API_URL: API, GH_TOKEN: 'tok' };

  /* 1 · a plain push: not on GitHub Actions, not forced */
  {
    const { bare, work } = setup(); posts.length = 0;
    const sha = commit(work, 1);
    const r = await run(SCRIPT, work, ['origin', 'HEAD:main'], { GITHUB_API_URL: API, GH_TOKEN: 'tok' });
    chk('plain: off GitHub Actions a push to main is a plain git push', r.code === 0 && tip(bare, 'main') === sha && posts.length === 0, r.out);
    chk('plain: and leaves no side branch', sideRefs(bare).length === 0);
    const r2 = await run(SCRIPT, work, ['origin', 'HEAD:main'], { GITHUB_ACTIONS: 'true', GITHUB_API_URL: API, GH_TOKEN: 'tok' });
    chk('plain: on GitHub Actions a remote that is not github.com is not certified (the other suites push to local repos)', r2.code === 0 && posts.length === 0, r2.out);
  }

  /* 2 · certified: the commit that lands, while it is on the side branch */
  for (const spec of ['HEAD:main', 'main', 'HEAD:refs/heads/main']) {
    const { bare, work } = setup(); posts.length = 0; bareForProbe = bare;
    const sha = commit(work, 2);
    const r = await run(SCRIPT, work, ['origin', spec], ON);
    const p = posts[0] || {};
    chk('certified (' + spec + '): pushed, and exactly one request', r.code === 0 && tip(bare, 'main') === sha && posts.length === 1, [r.out, posts.length]);
    chk('certified (' + spec + '): POST /repos/o/r/check-runs with the run token', p.method === 'POST' && p.url === '/repos/o/r/check-runs' && p.auth === 'Bearer tok', [p.method, p.url, p.auth]);
    chk('certified (' + spec + '): "All checks", completed, success, on the commit that landed', p.body && p.body.name === 'All checks' && p.body.status === 'completed' && p.body.conclusion === 'success' && p.body.head_sha === sha, p.body);
    chk('certified (' + spec + '): it says it is a data publish, not the pull-request gate, and names the workflow and run', p.body && /not the pull-request gate/.test(p.body.output.title) && /Test data job/.test(p.body.output.summary) && /\/o\/r\/actions\/runs\/77/.test(p.body.output.summary), p.body && p.body.output);
    chk('certified (' + spec + '): GitHub had the commit when it was certified (on ci-certify/77-1-<sha>)', (p.sides || []).indexOf('refs/heads/ci-certify/77-1-' + sha) >= 0, p.sides);
    chk('certified (' + spec + '): the side branch is deleted afterwards', sideRefs(bare).length === 0, sideRefs(bare));
    bareForProbe = null;
  }

  /* 3 · another branch is never certified */
  {
    const { bare, work } = setup(); posts.length = 0;
    const sha = commit(work, 3);
    const r = await run(SCRIPT, work, ['origin', 'HEAD:feature'], ON);
    chk('other branch: a plain push, no certificate', r.code === 0 && tip(bare, 'feature') === sha && posts.length === 0, r.out);
    const r2 = await run(SCRIPT, work, ['origin', 'HEAD:feature'], Object.assign({}, ON, { CERTIFY_BRANCH: 'feature' }));
    chk('other branch: CERTIFY_BRANCH names the protected branch', r2.code === 0 && posts.length === 1, r2.out);
  }

  /* 4 · a certificate that cannot be made never stops the push */
  {
    const { bare, work } = setup(); posts.length = 0; status = 403;
    const sha = commit(work, 4);
    const r = await run(SCRIPT, work, ['origin', 'HEAD:main'], ON);
    chk('refused certificate: the push still lands, exit 0, with a warning', r.code === 0 && tip(bare, 'main') === sha && /::warning::certified_push: the All checks certificate/.test(r.out), r.out);
    chk('refused certificate: no side branch left', sideRefs(bare).length === 0, sideRefs(bare));
    status = 201;
    const sha2 = commit(work, 5); posts.length = 0;
    const env = Object.assign({}, ON); delete env.GH_TOKEN;
    const r2 = await run(SCRIPT, work, ['origin', 'HEAD:main'], env);
    chk('no token: the push still lands, with a warning, and nothing is asked of the API', r2.code === 0 && tip(bare, 'main') === sha2 && posts.length === 0 && /no token/.test(r2.out), r2.out);
  }

  /* 5 · the token actions/checkout leaves in the git config */
  {
    const { work } = setup(); posts.length = 0;
    commit(work, 6);
    git(work, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:fromcfg').toString('base64')]);
    const env = Object.assign({}, ON); delete env.GH_TOKEN;
    const r = await run(SCRIPT, work, ['origin', 'HEAD:main'], env);
    chk('checkout credential: used when no token is in the environment', r.code === 0 && posts.length === 1 && posts[0].auth === 'Bearer fromcfg', [r.out, posts.map((p) => p.auth)]);
  }

  /* 6 · git push's exit code is the script's */
  {
    const { dir, bare, work } = setup(); posts.length = 0;
    const other = path.join(dir, 'other');
    git(dir, ['clone', '-q', bare, other]); commit(other, 7); git(other, ['push', '-q', 'origin', 'HEAD:main']);
    commit(work, 8);
    const r = await run(SCRIPT, work, ['origin', 'HEAD:main'], ON);
    chk('rejected push: non-zero, main untouched, side branch removed', r.code !== 0 && tip(bare, 'main') === git(other, ['rev-parse', 'HEAD']) && sideRefs(bare).length === 0, [r.code, r.out]);
    const u = await run(SCRIPT, work, ['origin'], ON);
    chk('usage: a missing refspec is exit 64', u.code === 64, u);
  }

  /* 7 · push_generated.sh certifies every attempt, so the commit that lands is certified */
  {
    const { dir, bare, work } = setup(); posts.length = 0;
    const other = path.join(dir, 'other');
    git(dir, ['clone', '-q', bare, other]);
    fs.writeFileSync(path.join(other, 'b.json'), '{"o":1}\n'); git(other, ['add', '-A']); git(other, ['commit', '-q', '-m', 'other job']); git(other, ['push', '-q', 'origin', 'HEAD:main']);
    fs.writeFileSync(path.join(work, 'a.json'), '{"v":9}\n');
    const r = await run(PUSHGEN, work, ['main', 'data 9', '--', 'a.json'], ON);
    const landed = tip(bare, 'main');
    chk('push_generated: a rejected first push is rebuilt on the new tip and lands', r.code === 0 && git(bare, ['show', landed + ':b.json']) === '{"o":1}' && git(bare, ['show', landed + ':a.json']) === '{"v":9}', r.out);
    chk('push_generated: each attempt is certified, the last one on the commit that landed', posts.length === 2 && posts[1].body.head_sha === landed && posts[0].body.head_sha !== landed, posts.map((p) => p.body && p.body.head_sha));
    chk('push_generated: no side branch left', sideRefs(bare).length === 0, sideRefs(bare));
  }

  srv.close();
  if (fail) {
    failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? ' | ' + JSON.stringify(f.detail).slice(0, 700) : '')));
    console.log('FAILED certified push — ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = 1;
  } else console.log('ALL GREEN certified push — ' + pass + ' passed, 0 failed');
})().catch((e) => { console.log('FAIL | the suite threw: ' + (e && e.stack || e)); process.exitCode = 1; });
