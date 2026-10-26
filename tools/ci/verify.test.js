#!/usr/bin/env node
/* ===========================================================================
   tools/ci/verify.js, run end to end against a synthetic repository.

   A git repository with one pull-request workflow whose steps pass, fail,
   need a secret, depend on a step output, install something, repeat
   themselves, and rewrite a committed file; a second workflow on a paths
   filter the change does not touch. verify must run what GitHub would run,
   say why it did not run the rest, never count a step it could not run as
   passed, exit with the right code, and put back a committed file a step
   rewrote.

   Run: node tools/ci/verify.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const VERIFY = path.join(__dirname, 'verify.js');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };

const R = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-verify-test-'));
const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const git = (args) => execFileSync('git', args, { cwd: R, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), text); };
const run = (args) => { const r = spawnSync(process.execPath, [VERIFY, '--root', R].concat(args), { cwd: R, env: ENV, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

write('lib/a.js', 'module.exports = 1;\n');
write('data/store.json', '{"v": 1}\n');
write('ok.test.js', 'console.log("ALL GREEN");\n');
write('bad.test.js', 'console.log("FAIL | a check — got 2, want 1"); process.exit(1);\n');
write('writes.test.js', 'require("fs").writeFileSync(require("path").join(__dirname, "data", "store.json"), "{\\"v\\": 2}\\n"); require("fs").writeFileSync(require("path").join(__dirname, "data", "artifact.json"), "{}\\n");\n');
write('.github/workflows/pr.yml', [
  'name: PR suite',
  'on:',
  '  pull_request:',
  '    paths:',
  "      - 'lib/**'",
  'jobs:',
  '  t:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - name: install',
  '        run: npm install --no-save playwright@1.49.1',
  '      - name: passes',
  '        run: node ok.test.js',
  '      - name: passes again, in another words',
  '        run: node ok.test.js',
  '      - name: fails',
  '        run: node bad.test.js',
  '      - name: needs a secret',
  '        env: { K: "${{ secrets.SB_URL }}" }',
  '        run: node ok.test.js',
  '      - name: needs a step output',
  "        if: ${{ steps.mode.outputs.mode == 'x' }}",
  '        run: node ok.test.js',
  '      - name: only on a schedule',
  "        if: github.event_name == 'schedule'",
  '        run: node bad.test.js',
  '      - name: rewrites a committed file',
  '        run: node writes.test.js',
].join('\n') + '\n');
write('.github/workflows/other.yml', "name: Other\non:\n  pull_request:\n    paths: ['docs/**']\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node bad.test.js\n");
git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['commit', '-q', '-m', 'seed']);
git(['checkout', '-q', '-b', 'feature']);
write('lib/a.js', 'module.exports = 2;\n');
git(['commit', '-q', '-am', 'change lib']);

/* the plan */
let r = run(['--base', 'main', '--list']);
chk('--list exits 0 and runs nothing', r.code === 0 && /PLAN ONLY — nothing was run/.test(r.out) && !/PASS /.test(r.out), r.out);
chk('a change under lib/ starts the workflow whose paths name lib/**', /PR suite \(pr\.yml\)/.test(r.out) && /paths: lib\/a\.js/.test(r.out), r.out);
chk('...and not the one whose paths name docs/**', /not started by this change: 1 workflow/.test(r.out) && /other\.yml — no changed file is on its paths filter/.test(r.out), r.out);
chk('an uncategorized workflow is said to be uncategorized', /UNCATEGORIZED/.test(r.out));

/* the run */
r = run(['--base', 'main']);
chk('a failing step makes verify exit 1 and say VERIFY FAILED', r.code === 1 && /VERIFY FAILED/.test(r.out), r.out.slice(-800));
chk('the passing step is PASS', /PASS\s+[\d.]+s\s+passes\n/.test(r.out), r.out);
chk('the identical step runs once and is reused, not run twice', /PASS passes again, in another words — same step as pr\.yml step 3, not run twice/.test(r.out), r.out);
chk('the failing step is FAIL with its exit code and the tail of its output', /FAIL\s+[\d.]+s\s+fails — exit 1/.test(r.out) && /\| FAIL \| a check — got 2, want 1/.test(r.out), r.out);
chk('a step that needs a secret is NOT VERIFIED and names the secret', /N\/A  needs a secret — needs secrets\.SB_URL/.test(r.out), r.out);
chk('a step whose if: reads a step output is NOT VERIFIED', /N\/A  needs a step output — its if:/.test(r.out), r.out);
chk('a step whose if: is false on a pull request does not run', !/only on a schedule/.test(r.out.split('SUMMARY')[0].replace(/SKIP.*\n/g, '')) || !/FAIL.*only on a schedule/.test(r.out), r.out);
chk('the summary counts them apart (passed 3 with the reuse · failed 1 · not verified 2)', /SUMMARY  passed 3 · failed 1 · NOT VERIFIED here 2 · skipped 3/.test(r.out), (r.out.match(/SUMMARY.*/) || [])[0]);
chk('NOT VERIFIED steps are listed as not passed', /NOT VERIFIED HERE — CI runs these; do not report them as passed:/.test(r.out));
chk('a step that rewrote a committed file is named', /WROTE committed file data\/store\.json/.test(r.out) && /data\/store\.json ← pr\.yml · rewrites a committed file/.test(r.out), r.out.slice(-600));
chk('...and the file is put back, so it cannot be committed by accident', fs.readFileSync(path.join(R, 'data', 'store.json'), 'utf8') === '{"v": 1}\n' && /restored 1 to HEAD/.test(r.out));
chk('a step that created an untracked file is named', /CREATED untracked file data\/artifact\.json/.test(r.out) && /data\/artifact\.json ← pr\.yml · rewrites a committed file/.test(r.out), r.out.slice(-700));
chk('...and the file is removed, so it cannot be committed by accident', !fs.existsSync(path.join(R, 'data', 'artifact.json')) && /removed 1 \(--keep-writes keeps them\)/.test(r.out));
chk('a step log is saved under .cache/verify/', /log \.cache\/verify\/[^ ]+\/pr\.t\.5\.log/.test(r.out), r.out);

/* --keep-writes, --bail, --json */
r = run(['--base', 'main', '--keep-writes', '--json', path.join(R, 'out.json')]);
chk('--keep-writes leaves the rewritten file and the created one', fs.readFileSync(path.join(R, 'data', 'store.json'), 'utf8') === '{"v": 2}\n' && fs.existsSync(path.join(R, 'data', 'artifact.json')));
git(['checkout', '--', 'data/store.json']); fs.rmSync(path.join(R, 'data', 'artifact.json'));
let j = null; try { j = JSON.parse(fs.readFileSync(path.join(R, 'out.json'), 'utf8')); } catch (e) { j = null; }
chk('--json writes the tally, every result, and what was written or created', !!j && j.tally.fail === 1 && j.tally.pass === 3 && j.results.length > 0 && j.wrote.length === 1 && j.created.length === 1, j && j.tally);
r = run(['--base', 'main', '--bail']);
chk('--bail stops after the first failure', r.code === 1 && /not run \(--bail\)/.test(r.out), r.out.slice(-600));

/* a clean change passes; the exit codes */
git(['checkout', '-q', 'main']); git(['checkout', '-q', '-b', 'docs-only']);
write('docs/x.md', '# x\n'); git(['add', '-A']); git(['commit', '-q', '-m', 'docs']);
fs.writeFileSync(path.join(R, 'bad.test.js'), 'console.log("fixed");\n'); git(['commit', '-q', '-am', 'fix']);
r = run(['--base', 'main']);
chk('a change whose started workflows pass exits 0 and says VERIFY PASSED', r.code === 0 && /VERIFY PASSED/.test(r.out) && /Other \(other\.yml\)/.test(r.out), r.out.slice(-600));
r = run(['--base', 'no-such-ref']);
chk('no merge base: exit 2, and it says to fetch', r.code === 2 && /no merge base with no-such-ref/.test(r.out), r.out);
r = run(['--workflow', 'nope.yml']);
chk('an unknown workflow: exit 2', r.code === 2 && /no workflow nope\.yml/.test(r.out), r.out);
r = run(['--group', 'no-such-group']);
chk('an unknown group: exit 2, naming the groups there are', r.code === 2 && /no category or alias "no-such-group"/.test(r.out) && /cfb/.test(r.out), r.out);
r = run(['--workflow', 'pr.yml', '--list']);
chk('--workflow runs the named workflow whatever changed', r.code === 0 && /PR suite \(pr\.yml\)/.test(r.out) && /RUN  passes/.test(r.out), r.out);

/* the clock audit moves the clock in every node process a step starts */
write('clock.test.js', 'const y = new Date().getUTCFullYear(); console.log("year " + y); process.exit(y >= 2100 ? 0 : 1);\n');
write('.github/workflows/clock.yml', "name: Clock\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node clock.test.js\n");
git(['add', '-A']); git(['commit', '-q', '-m', 'clock']);
r = run(['--workflow', 'clock.yml']);
chk('without the audit the clock is today\'s', r.code === 1, r.out.slice(-300));
r = run(['--workflow', 'clock.yml', '--clock-shift', String(365 * 100)]);
chk('--clock-shift moves Date for the step\'s node process, and the header says it is an audit', r.code === 0 && /CLOCK MOVED/.test(r.out), r.out.slice(-400));

/* what a step appends to GITHUB_PATH and GITHUB_ENV, the job's later steps see */
write('bin/edgedesk-hello', '#!/bin/sh\necho hello-from-path\n'); fs.chmodSync(path.join(R, 'bin', 'edgedesk-hello'), 0o755);
write('.github/workflows/runner.yml', [
  'name: Runner files', 'on:', '  pull_request:', 'jobs:', '  t:', '    runs-on: ubuntu-latest', '    steps:',
  '      - run: echo "$GITHUB_WORKSPACE/bin" >> "$GITHUB_PATH"',
  '      - run: |', '          echo "EDGEDESK_A=one" >> "$GITHUB_ENV"', '          { echo "EDGEDESK_B<<EOF"; echo "two lines"; echo "here"; echo "EOF"; } >> "$GITHUB_ENV"',
  '          echo "x=1" >> "$GITHUB_OUTPUT"; echo "# summary" >> "$GITHUB_STEP_SUMMARY"',
  '      - run: test "$(edgedesk-hello)" = hello-from-path',
  '      - run: test "$EDGEDESK_A" = one && test "$EDGEDESK_B" = "$(printf \'two lines\\nhere\')"',
].join('\n') + '\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'runner files']);
r = run(['--workflow', 'runner.yml']);
chk('GITHUB_PATH, GITHUB_ENV (incl. a multi-line value), GITHUB_OUTPUT and the step summary work as on a runner', r.code === 0 && /SUMMARY  passed 4 · failed 0/.test(r.out), r.out.slice(-900));
chk('verify never counts its own step logs as files a step created', !/CREATED untracked file \.cache\/verify/.test(r.out) && fs.existsSync(path.join(R, '.cache', 'verify')));

/* a job that checks out full history, failing on a shallow clone, is NOT VERIFIED, never passed */
{
  const SH = R + '-shallow';
  execFileSync('git', ['clone', '-q', '--depth', '1', 'file://' + R, SH], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(path.join(SH, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(SH, 'hist.test.js'), 'process.exit(require("child_process").spawnSync("git", ["rev-parse", "HEAD~1"]).status === 0 ? 0 : 1);\n');
  fs.writeFileSync(path.join(SH, '.github', 'workflows', 'hist.yml'), "name: History\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 0\n      - run: node hist.test.js\n      - run: node -e 'process.exit(0)'\n");
  const rs = spawnSync(process.execPath, [VERIFY, '--root', SH, '--workflow', 'hist.yml'], { cwd: SH, env: ENV, encoding: 'utf8' });
  chk('on a shallow clone, a failure in a fetch-depth: 0 job is NOT VERIFIED with the remedy, and a pass still passes', rs.status === 0 && /N\/A .*failed on a shallow clone.*git fetch --unshallow/.test(rs.stdout) && /SUMMARY  passed 1 · failed 0 · NOT VERIFIED here 1/.test(rs.stdout), rs.stdout.slice(-700));
}

/* the network audit names a step whose node process opened a connection beyond loopback */
write('net.test.js', 'const s = require("net").connect(9, "example.invalid"); s.on("error", () => {}); setTimeout(() => process.exit(0), 200);\n');
write('.github/workflows/net.yml', "name: Net\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node net.test.js\n      - run: node ok.test.js\n");
git(['add', '-A']); git(['commit', '-q', '-m', 'net']);
r = run(['--workflow', 'net.yml', '--net-audit']);
chk('--net-audit names the step that reached example.invalid, and only that step', r.code === 0 && /NETWORK example\.invalid:9/.test(r.out) && (r.out.match(/NETWORK example/g) || []).length === 1
  && /STEPS WHOSE NODE PROCESSES REACHED THE NETWORK/.test(r.out), r.out.slice(-700));

if (fail) { failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? ' | ' + JSON.stringify(f.detail).slice(0, 900) : ''))); console.log('FAILED verify — ' + pass + ' passed, ' + fail + ' failed'); process.exitCode = 1; }
else console.log('ALL GREEN verify — ' + pass + ' passed, 0 failed');
