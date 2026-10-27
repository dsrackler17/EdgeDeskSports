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

/* 6. a SOURCE file a build step patches in place (app.html), named in
      PUSH_MERGE_PATHS: a pull request that landed meanwhile is kept, and our
      own patch is merged onto it, never the whole file overwritten */
function runMerge(cwd, args, merge) {
  const r = spawnSync('bash', [SCRIPT].concat(args), { cwd, env: Object.assign({}, ENV, { PUSH_MERGE_PATHS: merge }), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
{
  const page = ['<html>', 'header', 'board', 'footer', '</html>', ''].join('\n');
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(A, 'app.html', page);
  git(A, ['add', '-A']); git(A, ['commit', '-q', '-m', 'app: page']); git(A, ['push', '-q', 'origin', 'main']);
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  /* the merged pull request: a new header */
  write(B, 'app.html', page.replace('header', 'header v2 (merged PR)'));
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'app: new header']); git(B, ['push', '-q', 'origin', 'main']);
  /* the build job, checked out before that merge: patches the footer and writes an artifact */
  write(A, 'app.html', page.replace('footer', 'footer (patched by the build)'));
  write(A, 'football/rating/current.json', '{"week":5}\n');
  const r = runMerge(A, ['main', 'football: week 5', '--', 'football/rating/current.json', 'app.html'], 'app.html');
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  const got = fs.readFileSync(path.join(seed, 'app.html'), 'utf8');
  chk('a merged change to a source file survives a rejected push (it is not reverted)', r.code === 0 && /header v2 \(merged PR\)/.test(got), r.out + '\n' + got);
  chk('and the build\'s own patch to it lands too', /footer \(patched by the build\)/.test(got), got);
  chk('the artifacts still land beside it', fs.readFileSync(path.join(seed, 'football/rating/current.json'), 'utf8') === '{"week":5}\n');

  /* the same line changed on both sides: refuse, never overwrite */
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(B, 'app.html', got.replace('footer (patched by the build)', 'footer (a merged PR)'));
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'app: footer PR']); git(B, ['push', '-q', 'origin', 'main']);
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(A, ['reset', '-q', '--hard', 'HEAD~1']);
  write(A, 'app.html', got.replace('footer (patched by the build)', 'footer (patched again)'));
  write(A, 'football/rating/current.json', '{"week":6}\n');
  const before = git(seed, ['ls-remote', bare, 'refs/heads/main']);
  const r2 = runMerge(A, ['main', 'football: week 6', '--', 'football/rating/current.json', 'app.html'], 'app.html');
  const after = git(seed, ['ls-remote', bare, 'refs/heads/main']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('a conflicting change to a source file is refused: nothing is pushed', r2.code !== 0 && /refusing to overwrite/.test(r2.out) && before === after, r2.out);
  chk('the branch keeps the other change exactly', /footer \(a merged PR\)/.test(fs.readFileSync(path.join(seed, 'app.html'), 'utf8')));
  chk('the working tree is left clean after a refusal', git(A, ['status', '--porcelain']) === '');
}

/* 7. without PUSH_MERGE_PATHS nothing changes: an owned path is still ours */
{
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(B, 'games/data/challenges.json', '{"challenges":["theirs"]}\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'games: theirs']); git(B, ['push', '-q', 'origin', 'main']);
  write(A, 'games/data/challenges.json', '{"challenges":["ours"]}\n');
  const r = run(A, ['main', 'games: ours', '--', 'games/data/challenges.json']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('the default for a generated artifact is unchanged: ours wins', r.code === 0 && fs.readFileSync(path.join(seed, 'games/data/challenges.json'), 'utf8') === '{"challenges":["ours"]}\n', r.out);
}

/* 8. a named DIRECTORY: a pull request that changed a file in it while the job
      ran is kept, because the job did not change that file (cfb-lab,
      2026-10-25 05:23 reverted football/game_research/factors.json from #766) */
{
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(A, 'football/game_research/factors.json', '{"v":"old"}\n');
  write(A, 'football/game_research/current.json', '{"run":0}\n');
  git(A, ['add', '-A']); git(A, ['commit', '-q', '-m', 'research: seed']); git(A, ['push', '-q', 'origin', 'main']);
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  /* the merged pull request regenerates a file in the job's directory */
  write(B, 'football/game_research/factors.json', '{"v":"merged PR"}\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'Merge pull request']); git(B, ['push', '-q', 'origin', 'main']);
  /* the job, checked out before that merge, rewrites only its own artifact */
  write(A, 'football/game_research/current.json', '{"run":1}\n');
  const r = run(A, ['main', 'cfb lab: hourly', '--', 'football/game_research']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('a file a merged pull request changed inside a named directory is not reverted by a stale job',
    r.code === 0 && fs.readFileSync(path.join(seed, 'football/game_research/factors.json'), 'utf8') === '{"v":"merged PR"}\n', r.out);
  chk('while the file the job built still lands', fs.readFileSync(path.join(seed, 'football/game_research/current.json'), 'utf8') === '{"run":1}\n');
  chk('and a later run from a fresh checkout leaves the merged file alone too', (() => {
    git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
    return fs.readFileSync(path.join(A, 'football/game_research/factors.json'), 'utf8') === '{"v":"merged PR"}\n';
  })());
}

/* 9. an AGGREGATE (the article manifest) is rebuilt on the new tip, not copied:
      on 2026-10-25 20:47 the editorial job laid its index.json (717 records)
      over a tip where Publish research articles had just added 6, and every
      job that tests the manifest failed from then on */
function runRebuild(cwd, args, rebuild) {
  const r = spawnSync('bash', [SCRIPT].concat(args), { cwd, env: Object.assign({}, ENV, { PUSH_REBUILD: rebuild }), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
{
  const REINDEX = 'ls articles/data/records > articles/data/index.json';
  git(A, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(A, 'articles/data/records/r1.json', '{}\n');
  write(A, 'articles/data/index.json', 'r1.json\n');
  git(A, ['add', '-A']); git(A, ['commit', '-q', '-m', 'articles: r1']); git(A, ['push', '-q', 'origin', 'main']);
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  /* the publisher adds a record and its manifest */
  write(B, 'articles/data/records/r2.json', '{}\n');
  write(B, 'articles/data/index.json', 'r1.json\nr2.json\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'articles: refresh']); git(B, ['push', '-q', 'origin', 'main']);
  /* the editorial job, checked out before that, adds a different one */
  write(A, 'articles/data/records/r3.json', '{}\n');
  write(A, 'articles/data/index.json', 'r1.json\nr3.json\n');
  const r = runRebuild(A, ['main', 'editorial: r3', '--', 'articles'], REINDEX);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('the manifest is rebuilt from every record on the new tip, not copied from the stale run',
    r.code === 0 && fs.readFileSync(path.join(seed, 'articles/data/index.json'), 'utf8') === 'r1.json\nr2.json\nr3.json\n',
    r.out + '\n' + fs.readFileSync(path.join(seed, 'articles/data/index.json'), 'utf8'));
  chk('both jobs\' records land', fs.existsSync(path.join(seed, 'articles/data/records/r2.json')) && fs.existsSync(path.join(seed, 'articles/data/records/r3.json')));
  chk('the working tree is left clean after a rebuild', git(A, ['status', '--porcelain']) === '');

  /* a rebuild that fails pushes nothing: a missed publish, never a broken store */
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  write(B, 'articles/data/records/r4.json', '{}\n');
  write(B, 'articles/data/index.json', 'r1.json\nr2.json\nr3.json\nr4.json\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'articles: r4']); git(B, ['push', '-q', 'origin', 'main']);
  write(A, 'articles/data/records/r5.json', '{}\n');
  write(A, 'articles/data/index.json', 'r1.json\nr2.json\nr3.json\nr5.json\n');
  const before = git(seed, ['ls-remote', bare, 'refs/heads/main']);
  const r2 = runRebuild(A, ['main', 'editorial: r5', '--', 'articles'], 'touch articles/half-built.html; exit 3');
  const after = git(seed, ['ls-remote', bare, 'refs/heads/main']);
  chk('a failed rebuild pushes nothing', r2.code !== 0 && /nothing pushed/.test(r2.out) && before === after, r2.out);
  chk('and leaves the working tree clean', git(A, ['status', '--porcelain']) === '' && !fs.existsSync(path.join(A, 'articles/half-built.html')), git(A, ['status', '--porcelain']));
}

/* 10. a shallow checkout (actions/checkout's default) stays shallow on a rejected
       push. A pull request merged meanwhile has a branch reaching back to the first
       commit, and a plain fetch pulled all of it: App version, 2026-10-26 00:42 and
       00:52, 4 GB into a five-minute job, cancelled both times */
{
  git(B, ['pull', '-q', '--ff-only', 'origin', 'main']);
  const S = path.join(root, 'shallow');
  git(root, ['clone', '-q', '--depth', '1', 'file://' + bare, S]);
  const first = git(B, ['rev-list', '--max-parents=0', 'HEAD']);
  git(B, ['checkout', '-q', '-b', 'pr', first]);
  write(B, 'lib/feature.js', 'x\n');
  git(B, ['add', '-A']); git(B, ['commit', '-q', '-m', 'pr: feature']);
  git(B, ['checkout', '-q', 'main']);
  git(B, ['merge', '-q', '--no-ff', '-m', 'Merge pull request', 'pr']);
  git(B, ['push', '-q', 'origin', 'main']);
  write(S, 'app-version.json', '{"version":"new"}\n');
  const r = run(S, ['main', 'app: version stamp for open tabs', '--', 'app-version.json']);
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  chk('a shallow checkout\'s rejected push lands on the new tip', r.code === 0 && /rebuilding the commit/.test(r.out)
    && fs.readFileSync(path.join(seed, 'app-version.json'), 'utf8') === '{"version":"new"}\n' && fs.existsSync(path.join(seed, 'lib/feature.js')), r.out);
  chk('without fetching the history behind the merged branch',
    git(S, ['rev-parse', '--is-shallow-repository']) === 'true' && spawnSync('git', ['cat-file', '-e', first + '^{commit}'], { cwd: S }).status !== 0);
  chk('while a full clone stays full', git(A, ['rev-parse', '--is-shallow-repository']) === 'false');
}

/* 11. every workflow that pushes an aggregate rebuilds it on a rejected push. The
       articles job carried a stale manifest (2026-10-25 20:47) and the weekly build a
       stale football/matchup/metrics.json (2026-10-26 00:30, built from starters three
       hours old), each over a newer tip: a job that names one of these paths and sets
       no PUSH_REBUILD for it can do it again. The cross-sport registry and board are built
       from every sport's record: a carried copy drops the record another job just published */
{
  const AGGREGATES = { 'football/matchup/metrics.json': 'build_matchup_metrics.js', 'articles/data/index.json': 'store.js --reindex',
    'engine/registry.json': 'build_registry.js', 'engine/board.json': 'build_board.js' };
  const WF = path.join(__dirname, '..', '..', '.github', 'workflows');
  const missing = [];
  let seen = 0;
  fs.readdirSync(WF).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => {
    const lines = fs.readFileSync(path.join(WF, f), 'utf8').split('\n');
    const starts = lines.map((l, i) => (/^\s*- name:/.test(l) ? i : -1)).filter((i) => i >= 0);
    starts.forEach((s, k) => {
      const step = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n');
      const at = step.indexOf('push_generated.sh');
      if (at < 0) return;
      const dash = step.indexOf(' -- ', at);
      if (dash < 0) return;
      const paths = step.slice(dash + 4).split(/[\s\\]+/).filter((p) => p && !p.startsWith('#')).map((p) => p.replace(/^['"]|['"]$/g, '').replace(/\/$/, ''));
      const rebuild = (/^\s*PUSH_REBUILD:\s*(.+)$/m.exec(step) || [])[1] || '';
      Object.keys(AGGREGATES).forEach((agg) => {
        if (!paths.some((p) => agg === p || agg.startsWith(p + '/'))) return;
        seen++;
        if (rebuild.indexOf(AGGREGATES[agg]) < 0) missing.push(f + ': ' + agg);
      });
    });
  });
  chk('every workflow that pushes an aggregate rebuilds it on the new tip (' + seen + ' steps)', seen > 0 && missing.length === 0, missing.join('; '));
}

/* 12. bad usage is refused, not silently a no-op */
{
  const r = run(A, ['main', 'msg']);
  chk('missing paths are a usage error', r.code === 64, String(r.code));
}

fs.rmSync(root, { recursive: true, force: true });
failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + String(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
