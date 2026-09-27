#!/usr/bin/env node
/* ===========================================================================
   tools/ci/push_generated.sh, driven against a real bare repository.

   The failures this reproduces are the ones the scheduled jobs actually hit:
     - a plain `git push` rejected because another job pushed first
       (games-challenges, football-weekly-build, 2026-09-14/15);
     - `git pull --rebase` conflicting on a generated file both sides rewrote,
       leaving unmerged paths so every later attempt also fails
       (editorial, 2026-09-14 23:50).

   Run: node tools/ci/push_generated.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'push_generated.sh');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  PUSH_SLEEP: '0', PUSH_ATTEMPTS: '4',
});
function git(cwd, args, extraEnv) {
  return execFileSync('git', args, { cwd, env: Object.assign({}, ENV, extraEnv || {}), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
function run(cwd, args) {
  const r = spawnSync('bash', [SCRIPT].concat(args), { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

/* a bare "origin" with one commit on main, and two clones racing it */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-push-'));
const bare = path.join(root, 'origin.git');
git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
const seed = path.join(root, 'seed');
git(root, ['clone', '-q', bare, seed]);
write(seed, 'README.md', 'seed\n');
write(seed, 'articles/data/index.json', '{"v":0}\n');
git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']); git(seed, ['push', '-q', 'origin', 'main']);
const A = path.join(root, 'a'), B = path.join(root, 'b');
git(root, ['clone', '-q', bare, A]);
git(root, ['clone', '-q', bare, B]);

/* 1. nothing changed: no commit, exit 0 */
{
  const r = run(A, ['main', 'games: board', '--', 'games/data/challenges.json']);
  chk('a run that changed nothing commits nothing and succeeds', r.code === 0 && /nothing changed/.test(r.out) && git(A, ['rev-parse', 'HEAD']) === git(seed, ['rev-parse', 'HEAD']), r.out);
}

/* 2. the plain race: B pushes an unrelated file first; A's artifact still lands */
{
  write(B, 'football/rankings/current.json', '{"week":2}\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'football: week 2']); git(B, ['push', '-q', 'origin', 'main']);
  write(A, 'games/data/challenges.json', '{"challenges":[1,2,3]}\n');
  const r = run(A, ['main', 'games: challenge board (3 matchups)', '--', 'games/data/challenges.json']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  const log = git(seed, ['log', '--format=%s', '-3']).split('\n');
  chk('a push rejected because another job pushed first is retried on the remote tip, not failed',
    r.code === 0 && /rebuilding the commit/.test(r.out) && log[0] === 'games: challenge board (3 matchups)' && log[1] === 'football: week 2', r.out + '\n' + log.join('|'));
  chk('the other job\'s file survives untouched', fs.readFileSync(path.join(seed, 'football/rankings/current.json'), 'utf8') === '{"week":2}\n');
  chk('and the artifact is exactly what this run built', fs.readFileSync(path.join(seed, 'games/data/challenges.json'), 'utf8') === '{"challenges":[1,2,3]}\n');
  chk('the working tree is left clean for the steps after it', git(A, ['status', '--porcelain']) === '');
}

/* 3. the conflict: both sides rewrote the SAME generated file. A rebase would
      stop with unmerged paths; this replaces the file with ours and pushes. */
{
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(B, 'articles/data/index.json', '{"v":"theirs"}\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'editorial: theirs']); git(B, ['push', '-q', 'origin', 'main']);
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  /* stand one commit behind the remote, as a job that checked out before
     the other one pushed */
  git(A, ['reset', '-q', '--hard', 'HEAD~1']);
  write(A, 'articles/data/index.json', '{"v":"ours"}\n');
  write(A, 'sitemap.xml', '<urlset/>\n');
  const r = run(A, ['main', 'newsletter: ours', '--', 'articles', 'sitemap.xml', 'sitemap-articles.xml']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('a generated file both sides rewrote does not stop the push with a rebase conflict',
    r.code === 0 && !/unmerged/.test(r.out), r.out);
  chk('ours wins for the paths this job owns', fs.readFileSync(path.join(seed, 'articles/data/index.json'), 'utf8') === '{"v":"ours"}\n');
  chk('a path that does not exist is not a reason to fail', fs.existsSync(path.join(seed, 'sitemap.xml')));
  chk('the branch history is linear: no merge commit, no force-push',
    git(seed, ['log', '--format=%p', '-1']).split(' ').length === 1 && git(seed, ['log', '--format=%s', '-2']).split('\n')[1] === 'editorial: theirs');
}

/* 4. identical artifacts already on the branch: success without a second commit */
{
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(B, 'games/data/challenges.json', '{"challenges":[9]}\n');
  /* a different second, so the two commits cannot collapse into one sha */
  git(B, ['add', '-A']);
  git(B, ['commit', '-q', '-m', 'games: challenge board (1 matchups)'],
    { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  git(B, ['push', '-q', 'origin', 'main']);
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(A, ['reset', '-q', '--hard', 'HEAD~1']);
  write(A, 'games/data/challenges.json', '{"challenges":[9]}\n');
  const before = git(seed, ['ls-remote', bare, 'refs/heads/main']);
  const r = run(A, ['main', 'games: challenge board (1 matchups)', '--', 'games/data/challenges.json']);
  const after = git(seed, ['ls-remote', bare, 'refs/heads/main']);
  chk('the same artifact already published by another run is success, and adds no commit',
    r.code === 0 && /already carries/.test(r.out) && before === after, r.out);
}

/* 5. a deletion inside an owned path is carried across the rebuild */
{
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(A, 'articles/old.html', 'x\n');
  git(A, ['add', '-A']); git(A, ['commit', '-q', '-m', 'articles: old']); git(A, ['push', '-q', 'origin', 'main']);
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(B, 'README.md', 'seed 2\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'docs']); git(B, ['push', '-q', 'origin', 'main']);
  fs.unlinkSync(path.join(A, 'articles/old.html'));
  const r = run(A, ['main', 'articles: prune', '--', 'articles']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('a file this run deleted stays deleted after the rebuild', r.code === 0 && !fs.existsSync(path.join(seed, 'articles/old.html')), r.out);
  chk('while the other side\'s change is kept', fs.readFileSync(path.join(seed, 'README.md'), 'utf8') === 'seed 2\n');
}

/* 6. bad usage is refused, not silently a no-op */
{
  const r = run(A, ['main', 'msg']);
  chk('missing paths are a usage error', r.code === 64, String(r.code));
}

fs.rmSync(root, { recursive: true, force: true });
failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + String(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
