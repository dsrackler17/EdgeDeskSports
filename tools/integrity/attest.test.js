#!/usr/bin/env node
/* ============================================================================
   A bot commit earns the integrity-gate status before it reaches main
   (tools/integrity/attest.js), driven end to end: tools/ci/push_generated.sh
   and tools/ci/attest_head.sh against a bare repository, with a mock GitHub
   API recording the status calls.

   What main's ruleset needs from a bot: the commit carries integrity-gate=
   success when it is pushed. What the bots gain: an artifact that does not
   parse is never published (the failure #800 put on main, from a bot instead
   of a pull request).

   Run: node tools/integrity/attest.test.js
   ============================================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PUSH = path.join(ROOT, 'tools', 'ci', 'push_generated.sh');
const ATTEST_HEAD = path.join(ROOT, 'tools', 'ci', 'attest_head.sh');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const calls = [];
let reply = 201;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.writeHead(reply, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'success' }));
  });
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-attest-'));
const bare = path.join(root, 'origin.git');
const work = path.join(root, 'work');
const BASE_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', PUSH_SLEEP: '0', PUSH_ATTEMPTS: '3' });
delete BASE_ENV.GH_TOKEN; delete BASE_ENV.GITHUB_TOKEN; delete BASE_ENV.GITHUB_STEP_SUMMARY;
const git = (cwd, args) => execFileSync('git', args, { cwd, env: BASE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (rel, t) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), t); };
function sh(args, env) {
  return new Promise((resolve) => {
    const p = spawn('bash', args, { cwd: work, env: Object.assign({}, BASE_ENV, env || {}) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const remoteMain = () => git(root, ['ls-remote', bare, 'refs/heads/main']).split(/\s+/)[0];
const staging = () => git(root, ['ls-remote', bare, 'refs/heads/integrity-attest/*']);

server.listen(0, '127.0.0.1', async () => {
  const API = { GITHUB_API_URL: 'http://127.0.0.1:' + server.address().port, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'test-token', GITHUB_RUN_ID: '4242', INTEGRITY_ATTEST_ANY_REMOTE: '1' };
  try {
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(root, ['clone', '-q', bare, work]);
    put('data/x.json', '{"v":0}\n');
    git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'seed']); git(work, ['push', '-q', 'origin', 'main']);

    /* 1. a valid artifact: checked, staged, marked, pushed, staging removed */
    put('data/x.json', '{"v":1}\n');
    const r1 = await sh([PUSH, 'main', 'bot: x', '--', 'data'], API);
    const sha1 = remoteMain();
    const st1 = calls.filter((c) => c.method === 'POST');
    chk('a valid bot commit is pushed to main', r1.code === 0 && sha1 === git(work, ['rev-parse', 'HEAD']), r1.out);
    chk('… carrying integrity-gate=success on that exact commit', st1.length === 1 && st1[0].url === '/repos/owner/repo/statuses/' + sha1 && st1[0].body.context === 'integrity-gate' && st1[0].body.state === 'success' && st1[0].auth === 'Bearer test-token', st1);
    chk('… linking the run that checked it', st1.length === 1 && /\/owner\/repo\/actions\/runs\/4242$/.test(st1[0].body.target_url || ''), st1);
    chk('… and the staging branch it was marked on is gone', staging() === '');

    /* 2. a broken artifact is never published */
    put('data/x.json', '{"v":2,\n\n}\n');
    const before = remoteMain();
    const n = calls.length;
    const r2 = await sh([PUSH, 'main', 'bot: broken', '--', 'data'], API);
    chk('a bot commit whose JSON does not parse is refused: nothing pushed, no status', r2.code !== 0 && /refusing to publish/.test(r2.out) && remoteMain() === before && calls.length === n, r2.out);
    git(work, ['reset', '-q', '--hard', 'origin/main']);

    /* 3. a raw `git push` job: attest_head.sh in front of the push */
    put('data/y.json', '{"y":1}\n');
    git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'raw job']);
    const r3 = await sh(['-c', 'bash "$1" && git push -q origin main', '_', ATTEST_HEAD], API);
    const sha3 = git(work, ['rev-parse', 'HEAD']);
    chk('a raw-push job is checked and marked before its push', r3.code === 0 && remoteMain() === sha3 && calls.some((c) => c.url === '/repos/owner/repo/statuses/' + sha3), r3.out);
    put('data/y.json', '<<<<<<< HEAD\n{"y":1}\n=======\n{"y":2}\n>>>>>>> main\n');
    git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'raw job, bad resolution']);
    const r4 = await sh(['-c', 'bash "$1" && git push -q origin main', '_', ATTEST_HEAD], API);
    chk('… and a raw-push job with conflict markers never reaches the push', r4.code !== 0 && remoteMain() === sha3, r4.out);
    git(work, ['reset', '-q', '--hard', 'origin/main']);

    /* 4. only main needs the status */
    const n5 = calls.length;
    put('data/z.json', '{"z":1}\n');
    const r5 = await sh([PUSH, 'feature', 'bot: into a PR branch', '--', 'data'], API);
    chk('a push to another branch is not marked', r5.code === 0 && calls.length === n5, r5.out);
    git(work, ['checkout', '-q', 'main']); git(work, ['reset', '-q', '--hard', 'origin/main']);

    /* 5. no token: still checked, pushed without a status (until main requires it) */
    put('data/x.json', '{"v":3}\n');
    const n6 = calls.length;
    const r6 = await sh([PUSH, 'main', 'bot: no token', '--', 'data'], { GITHUB_REPOSITORY: 'owner/repo' });
    chk('without a token the commit is still checked and pushed, with no status call', r6.code === 0 && calls.length === n6 && /no GitHub token/.test(r6.out), r6.out);

    /* 6. the status call refused (no statuses: write): a warning, the push goes on */
    reply = 403;
    put('data/x.json', '{"v":4}\n');
    const r7 = await sh([PUSH, 'main', 'bot: refused', '--', 'data'], API);
    chk('a refused status call warns and names the missing permission; the push still happens', r7.code === 0 && /statuses: write/.test(r7.out) && remoteMain() === git(work, ['rev-parse', 'HEAD']) && staging() === '', r7.out);
    reply = 201;

    /* 7. a remote that is not this repository on GitHub is never marked */
    const n8 = calls.length;
    put('data/x.json', '{"v":5}\n');
    const r8 = await sh([PUSH, 'main', 'bot: local remote', '--', 'data'], Object.assign({}, API, { INTEGRITY_ATTEST_ANY_REMOTE: '' }));
    chk('a push to a remote that is not github.com/<this repo> gets no status call', r8.code === 0 && calls.length === n8 && /is not owner\/repo/.test(r8.out), r8.out);
  } catch (e) {
    chk('the attestation re-enactment ran', false, String(e && e.stack));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + JSON.stringify(f.detail).slice(0, 800)));
    console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'bot attestation — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
  }
});
