#!/usr/bin/env node
'use strict';
/* ===========================================================================
   npm run verify — the pull request's checks, run before the pull request.

   2026-10-26: four pull requests merged into main between 12:15 and 12:59 UTC
   while a required suite was red or had not reported (#797, #800 ten seconds
   after its last commit, #803 after 48 s, #804 after 62 s). Each workflow
   names its own commands, behind its own paths: filter, so "run the tests"
   meant guessing which of 65 workflows a change starts. This runs what GitHub
   would run, read from the workflow files themselves, so it cannot drift from
   CI:

     --affected (default)  the workflows a pull request with these changes
                           starts: changed files vs the merge base with
                           origin/main, plus uncommitted and untracked files,
                           through each workflow's own paths: filter
     --all                 every workflow a pull request can start
                           (npm run verify)
     --group <name>        a category or alias from tools/ci/checks.json
                           (cfb, odds, research, core, sports-models, …)
     --workflow <f.yml>    named workflows (comma-separated)

   Every step is run as its job would run it (bash -e, the step's env and
   working-directory, the job's timeout), or reported with the reason it
   cannot run here: a secret, a repository variable, a step output, a
   service container that is not listening, a matrix, a live source. Those
   are NOT VERIFIED, and the summary says so; they never count as passed.
   Install steps are not repeated (the machine provides Node, PostgreSQL and
   Chromium, or the step after says what is missing). A step that appears in
   several workflows runs once.

     --list          print the plan, run nothing
     --include-live  also run the integration workflows (live sources)
     --base <ref>    compare against <ref> (default origin/main)
     --ci            set CI=true and GITHUB_ACTIONS=true, as a runner does
     --bail          stop at the first failure
     --verbose       stream each step's output instead of saving it
     --timeout <min> per-step limit (default: the job's timeout-minutes, else 30)
     --json <file>   write the results
     --root <dir>    another checkout (default: this repository)
     --clock-shift <days>  run every node process with the clock moved (a
                     determinism audit: tools/ci/clock_shift.js)
     --tz <zone>     run with TZ=<zone> (another determinism audit)
     --net-audit     name every step whose node processes opened a connection
                     to a host that is not loopback (tools/ci/net_audit.js)
     --keep-writes   keep the committed files a step rewrote and the files it
                     created (by default rewritten files are restored and new
                     ones removed at the end, and every one is named: a test
                     should write only to a temporary directory)

   Exit 0: every step that ran passed. 1: a step failed. 2: verify itself
   could not run (no base ref, an unreadable workflow).
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./workflows.js');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
/* --root <dir>: another checkout (tools/ci/verify.test.js drives a synthetic repository) */
const ROOT = path.resolve(opt('--root') || path.join(__dirname, '..', '..'));
const CHECKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'checks.json'), 'utf8'));

function categoryOf(base) {
  for (const [k, c] of Object.entries(CHECKS.categories)) if (c.workflows.indexOf(base) >= 0) return k;
  return null;
}
function groupWorkflows(name) {
  let g = CHECKS.aliases[name] != null ? CHECKS.aliases[name] : name;
  if (typeof g === 'string') { if (!CHECKS.categories[g]) return null; g = CHECKS.categories[g].workflows; }
  return g;
}
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, maxBuffer: 1 << 26 });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}
function changed(base) {
  const mb = git(['merge-base', base, 'HEAD']);
  if (!mb.ok) return { error: 'no merge base with ' + base + ': fetch it first (git fetch origin main), or pass --base <ref>' };
  const files = new Set();
  for (const args of [['diff', '--name-only', '--no-renames', mb.out], ['ls-files', '--others', '--exclude-standard']]) {
    const r = git(args);
    if (r.ok && r.out) r.out.split('\n').forEach((f) => files.add(f));
  }
  return { mergeBase: mb.out, files: Array.from(files).sort() };
}
/* the tracked files that differ from HEAD, and the untracked files git does not
   ignore: a step that adds to either list wrote into the checkout */
function dirtyTracked() {
  const r = git(['diff', '--name-only', 'HEAD']);
  return new Set(r.ok && r.out ? r.out.split('\n') : []);
}
function untracked() {
  const r = git(['ls-files', '--others', '--exclude-standard']);
  return new Set(r.ok && r.out ? r.out.split('\n') : []);
}
/* is something listening where a service container would be? */
function listening(port) {
  const r = spawnSync(process.execPath, ['-e', `const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)`]);
  return r.status === 0;
}
/* logical lines (a trailing backslash continues one); install lines are not repeated here */
function withoutSetup(script) {
  const raw = script.split('\n'), logical = [];
  for (let k = 0; k < raw.length; k++) {
    let l = raw[k];
    const start = k;
    while (/\\\s*$/.test(l) && k + 1 < raw.length) { k++; l = l.replace(/\\\s*$/, '') + ' ' + raw[k].trim(); }
    logical.push({ text: l, lines: k - start + 1 });
  }
  const dropped = [];
  /* a line is an install when every command it chains is one (an echo beside them is only words) */
  const isSetup = (text) => {
    const segs = text.replace(/[()]/g, ' ').split(/&&|\|\||;/)
      .map((s) => s.replace(/\d?>>?\s*\/dev\/null|2>&1/g, ' ').trim()).filter((s) => s && !/^(true|:)$/.test(s) && !/^echo\b/.test(s));
    return segs.length > 0 && segs.every((s) => W.SETUP_LINE.test(s));
  };
  const kept = logical.map((x) => {
    if (isSetup(x.text)) {
      dropped.push(x.text.trim());
      return ': # not repeated here: ' + x.text.trim().replace(/[\r\n]/g, ' ') + '\n'.repeat(x.lines - 1);
    }
    return x.text + '\n'.repeat(x.lines - 1);
  });
  return { script: kept.join('\n'), dropped };
}

/* the Python packages a job's (skipped) install steps would have put on the
   runner, and which of them this machine cannot import */
const IMPORT_NAME = { pyyaml: 'yaml', 'scikit-learn': 'sklearn', beautifulsoup4: 'bs4', 'python-dateutil': 'dateutil', pillow: 'PIL', 'opencv-python': 'cv2', 'pdfminer.six': 'pdfminer' };
const pyCache = {};
function missingPython(steps, cwdOf) {
  const pkgs = new Set(), how = [];
  for (const S of steps) {
    if (S.status !== 'setup' || !S.run || !/\bpip3?\s+install\b|-m\s+pip\s+install\b/.test(S.run)) continue;
    for (const line of S.run.split('\n')) {
      const m = /\bpip3?\s+install\b(.*)$|-m\s+pip\s+install\b(.*)$/.exec(line);
      if (!m) continue;
      how.push(line.trim());
      const toks = (m[1] || m[2] || '').replace(/[|&;].*$/, '').split(/\s+/).filter(Boolean);
      for (let k = 0; k < toks.length; k++) {
        if (toks[k] === '-r' || toks[k] === '--requirement') {
          const f = path.join(ROOT, cwdOf(S) || '', toks[++k] || '');
          try { fs.readFileSync(f, 'utf8').split('\n').map((x) => x.replace(/#.*/, '').trim()).filter((x) => x && !x.startsWith('-')).forEach((x) => pkgs.add(x)); } catch (e) { pkgs.add('(unreadable ' + toks[k] + ')'); }
        } else if (!toks[k].startsWith('-')) pkgs.add(toks[k]);
      }
    }
  }
  const mods = Array.from(pkgs).map((x) => { const n = x.split(/[<>=!~\[; ]/)[0].trim().toLowerCase(); return IMPORT_NAME[n] || n.replace(/-/g, '_'); }).filter(Boolean);
  const todo = mods.filter((m) => !(m in pyCache));
  if (todo.length) {
    const r = spawnSync('python3', ['-I', '-c', 'import importlib.util, json, sys; print(json.dumps({m: importlib.util.find_spec(m) is not None for m in sys.argv[1:]}))'].concat(todo), { encoding: 'utf8' });
    let got = {};
    try { got = JSON.parse(r.stdout); } catch (e) { todo.forEach((m) => { got[m] = false; }); }
    Object.assign(pyCache, got);
  }
  return { missing: mods.filter((m) => !pyCache[m]), how };
}

/* apply what a step appended to GITHUB_PATH (newest first) and GITHUB_ENV
   (NAME=value, or NAME<<DELIMITER … DELIMITER), then empty both, as a runner does */
function readRunnerFiles(gh, jobPath, jobEnv) {
  const add = fs.readFileSync(gh.path, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
  for (const d of add) jobPath.unshift(d);
  const lines = fs.readFileSync(gh.env, 'utf8').split('\n');
  for (let k = 0; k < lines.length; k++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[k]);
    if (m) { const body = []; k++; while (k < lines.length && lines[k] !== m[2]) body.push(lines[k++]); jobEnv[m[1]] = body.join('\n'); continue; }
    const e = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[k]);
    if (e) jobEnv[e[1]] = e[2];
  }
  fs.writeFileSync(gh.path, ''); fs.writeFileSync(gh.env, '');
}

function main() {
  const base = opt('--base') || 'origin/main';
  const mode = flag('--all') ? 'all' : opt('--group') ? 'group' : opt('--workflow') ? 'workflow' : 'affected';
  let wfs;
  try { wfs = W.loadWorkflows(ROOT); } catch (e) { console.error('verify: a workflow could not be read: ' + e.message); return 2; }
  const prWfs = wfs.filter((w) => Object.prototype.hasOwnProperty.call(w.on, 'pull_request'));
  let selected = [], header = '', files = null, notStarted = [];
  if (mode === 'affected') {
    const c = changed(base);
    if (c.error) { console.error('verify: ' + c.error); return 2; }
    files = c.files;
    header = 'verify · the workflows a pull request with these ' + files.length + ' changed file' + (files.length === 1 ? '' : 's') + ' starts (vs ' + base + ' @ ' + c.mergeBase.slice(0, 9) + ')';
    for (const w of prWfs) {
      const t = W.triggeredBy(w, files, 'main');
      if (t.run) selected.push(Object.assign({ why: t.why }, w)); else notStarted.push({ w, why: t.why });
    }
  } else if (mode === 'all') {
    header = 'verify · every workflow a pull request can start';
    selected = prWfs.map((w) => Object.assign({ why: 'all' }, w));
  } else {
    const names = mode === 'group' ? groupWorkflows(opt('--group')) : opt('--workflow').split(',').map((s) => s.trim().replace(/^\.github\/workflows\//, ''));
    if (!names) { console.error('verify: no category or alias "' + opt('--group') + '" in tools/ci/checks.json (have: ' + Object.keys(CHECKS.categories).concat(Object.keys(CHECKS.aliases)).join(', ') + ')'); return 2; }
    for (const n of names) {
      const w = wfs.find((x) => x.base === n);
      if (!w) { console.error('verify: no workflow ' + n); return 2; }
      selected.push(Object.assign({ why: mode === 'group' ? 'group ' + opt('--group') : 'named' }, w));
    }
    header = 'verify · ' + (mode === 'group' ? 'group "' + opt('--group') + '"' : 'named workflows') + ' (' + selected.length + ')';
  }
  const live = flag('--include-live');
  const ci = flag('--ci');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-verify-'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(ROOT, '.cache', 'verify', stamp);
  const logRel = path.relative(ROOT, logDir).split(path.sep).join('/');
  if (!flag('--list')) fs.mkdirSync(logDir, { recursive: true });
  const ctx = { root: ROOT, temp: tmp, base: 'main', head: git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'local' };
  const servicesUp = { postgres: null };
  const results = [];
  const seen = new Map();
  const tally = { pass: 0, fail: 0, unavailable: 0, skipped: 0, reused: 0 };
  const notVerified = [];
  const failures = [];
  const wantMajor = '22';
  const audit = {};
  if (opt('--clock-shift')) {
    audit.EDGEDESK_CLOCK_SHIFT_DAYS = String(Number(opt('--clock-shift')));
    audit.NODE_OPTIONS = ((process.env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(path.join(__dirname, 'clock_shift.js'))).trim();
    header += ' · CLOCK MOVED ' + audit.EDGEDESK_CLOCK_SHIFT_DAYS + ' days (an audit, not a verification)';
  }
  if (opt('--tz')) { audit.TZ = opt('--tz'); header += ' · TZ=' + audit.TZ + ' (an audit)'; }
  const netAudit = flag('--net-audit');
  if (netAudit) {
    audit.NODE_OPTIONS = ((audit.NODE_OPTIONS || process.env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(path.join(__dirname, 'net_audit.js'))).trim();
    header += ' · NETWORK AUDITED';
  }
  const reached = [];
  console.log(header);
  console.log('node ' + process.version + (process.version.startsWith('v' + wantMajor + '.') ? '' : ' — the workflows run Node ' + wantMajor + '; a result here may differ from CI'));
  if (files && files.length) console.log('changed: ' + files.slice(0, 12).join(', ') + (files.length > 12 ? ' … (' + files.length + ')' : ''));
  if (mode !== 'all' && !selected.find((w) => w.base === 'core-validation.yml')) {
    const core = wfs.find((w) => w.base === 'core-validation.yml');
    if (core) selected.unshift(Object.assign({ why: 'always: the repository integrity gate' }, core));
  }
  let bailed = false;
  const dirtyAtStart = flag('--list') ? new Set() : dirtyTracked();
  const known = new Set(dirtyAtStart);
  const wrote = [];
  const knownNew = flag('--list') ? new Set() : untracked();
  const created = [];
  for (const wf of selected) {
    const cat = categoryOf(wf.base);
    const title = wf.name + ' (' + wf.base + ')' + (cat ? ' · ' + CHECKS.categories[cat].title : ' · UNCATEGORIZED') + ' — ' + wf.why;
    console.log('\n' + title);
    if (cat === 'integration' && !live) {
      console.log('  N/A  a live-source workflow: not run without --include-live (network); NOT VERIFIED here');
      tally.unavailable++; notVerified.push(wf.base + ': live sources (--include-live)');
      results.push({ workflow: wf.base, status: 'unavailable', why: 'live sources' });
      continue;
    }
    let jobs;
    try { jobs = W.plan(wf, ctx); } catch (e) { console.log('  FAIL could not plan: ' + e.message); tally.fail++; failures.push(wf.base + ': ' + e.message); continue; }
    for (const J of jobs) {
      const job = wf.doc.jobs[J.id] || {};
      console.log('  job ' + J.id + (J.name !== J.id ? ' (' + J.name + ')' : ''));
      if (J.skipped) {
        const kind = J.skipped.kind === 'condition' ? 'SKIP' : 'N/A ';
        console.log('    ' + kind + ' ' + J.skipped.why);
        if (J.skipped.kind === 'condition') tally.skipped++; else { tally.unavailable++; notVerified.push(wf.base + ' job ' + J.id + ': ' + J.skipped.why); }
        continue;
      }
      const limitMin = Number(opt('--timeout')) || Number(job['timeout-minutes']) || 30;
      const py = missingPython(J.steps, (S) => S.cwd);
      /* the files a runner gives every step: what one step appends to GITHUB_PATH or
         GITHUB_ENV, the job's later steps see (GITHUB_OUTPUT and the summary are only kept) */
      const gh = {};
      for (const k of ['env', 'path', 'output', 'summary']) { gh[k] = path.join(tmp, 'gh_' + wf.base.replace(/\W/g, '_') + '_' + J.id + '_' + k); fs.writeFileSync(gh[k], ''); }
      const jobPath = [], jobEnv = {};
      for (const S of J.steps) {
        if (S.status === 'run' && py.missing.length && /(^|[\s;&|(])python3?\b/.test(S.run)) {
          S.status = 'unavailable';
          S.why = 'needs the Python packages its job installs (' + py.missing.slice(0, 6).join(', ') + (py.missing.length > 6 ? ' …' : '') + '): ' + py.how[0];
        }
        const label = S.name.length > 110 ? S.name.slice(0, 107) + '…' : S.name;
        const rec = { workflow: wf.base, job: J.id, step: S.n, name: S.name, status: S.status, why: S.why };
        results.push(rec);
        if (S.status === 'setup' || S.status === 'condition') { tally.skipped++; if (flag('--list')) console.log('    SKIP ' + label + ' — ' + S.why); continue; }
        if (S.status === 'unavailable') { tally.unavailable++; notVerified.push(wf.base + ' · ' + label + ': ' + S.why); console.log('    N/A  ' + label + ' — ' + S.why); continue; }
        if (S.services && S.services.length) {
          if (servicesUp.postgres == null) servicesUp.postgres = listening(5432);
          if (S.services.indexOf('postgres') >= 0 && !servicesUp.postgres && /(\bpsql\b|EDGD_PG|PGPASSWORD|127\.0\.0\.1|localhost|5432)/.test(S.run + JSON.stringify(S.env))) {
            rec.status = 'unavailable'; rec.why = 'needs the job\'s postgres service on 127.0.0.1:5432';
            tally.unavailable++; notVerified.push(wf.base + ' · ' + label + ': ' + rec.why); console.log('    N/A  ' + label + ' — ' + rec.why); continue;
          }
        }
        const key = JSON.stringify([S.run, S.env, S.cwd, S.shell]);
        if (seen.has(key)) {
          const prev = seen.get(key);
          rec.status = prev.status; rec.reused = prev.where; tally.reused++;
          if (prev.status === 'pass') tally.pass++; else { tally.fail++; failures.push(wf.base + ' · ' + label + ' (same as ' + prev.where + ')'); }
          console.log('    ' + (prev.status === 'pass' ? 'PASS' : 'FAIL') + ' ' + label + ' — same step as ' + prev.where + ', not run twice');
          continue;
        }
        if (flag('--list')) { console.log('    RUN  ' + label); continue; }
        if (bailed) { console.log('    ---- ' + label + ' — not run (--bail)'); continue; }
        const { script, dropped } = withoutSetup(S.run);
        const file = path.join(tmp, wf.base.replace(/\W/g, '_') + '_' + J.id + '_' + S.n + '.sh');
        fs.writeFileSync(file, script);
        const shellArgs = S.shell === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail', file] : ['-e', file];
        const netLog = netAudit ? path.join(tmp, 'net_' + wf.base.replace(/\W/g, '_') + '_' + J.id + '_' + S.n + '.jsonl') : null;
        const env = Object.assign({}, process.env, jobEnv, S.env, ci ? { CI: 'true', GITHUB_ACTIONS: 'true' } : {}, { GITHUB_WORKSPACE: ROOT, RUNNER_TEMP: tmp, GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main',
          GITHUB_ENV: gh.env, GITHUB_PATH: gh.path, GITHUB_OUTPUT: gh.output, GITHUB_STEP_SUMMARY: gh.summary }, audit, netLog ? { EDGEDESK_NET_LOG: netLog } : {});
        if (jobPath.length) env.PATH = jobPath.join(path.delimiter) + path.delimiter + (env.PATH || '');
        const cwd = S.cwd ? path.join(ROOT, S.cwd) : ROOT;
        const log = path.join(logDir, wf.base.replace(/\.ya?ml$/, '') + '.' + J.id + '.' + S.n + '.log');
        const t0 = Date.now();
        let r;
        if (flag('--verbose')) { console.log('    RUN  ' + label); r = spawnSync('bash', shellArgs, { cwd, env, stdio: 'inherit', timeout: limitMin * 60000 }); }
        else {
          const fd = fs.openSync(log, 'w');
          r = spawnSync('bash', shellArgs, { cwd, env, stdio: ['ignore', fd, fd], timeout: limitMin * 60000 });
          fs.closeSync(fd);
        }
        const secs = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        const ok = r.status === 0;
        rec.status = ok ? 'pass' : 'fail'; rec.seconds = Number(secs.slice(0, -1)); rec.log = flag('--verbose') ? null : path.relative(ROOT, log);
        if (dropped.length) rec.not_repeated = dropped;
        seen.set(key, { status: rec.status, where: wf.base + ' step ' + S.n });
        readRunnerFiles(gh, jobPath, jobEnv);
        const now = dirtyTracked(), fresh = Array.from(now).filter((f) => !known.has(f));
        if (fresh.length) { fresh.forEach((f) => { known.add(f); wrote.push({ file: f, by: wf.base + ' · ' + label }); }); rec.wrote = fresh; }
        const born = Array.from(untracked()).filter((f) => !knownNew.has(f) && !f.startsWith(logRel + '/'));
        if (born.length) { born.forEach((f) => { knownNew.add(f); created.push({ file: f, by: wf.base + ' · ' + label }); }); rec.created = born; }
        if (ok) { tally.pass++; console.log('    PASS ' + secs.padStart(7) + '  ' + label); }
        else {
          tally.fail++;
          const why = r.error && r.error.code === 'ETIMEDOUT' ? 'timed out after ' + limitMin + ' min' : r.signal ? 'killed by ' + r.signal : 'exit ' + r.status;
          failures.push(wf.base + ' · ' + label + ' (' + why + (rec.log ? '; ' + rec.log : '') + ')');
          console.log('    FAIL ' + secs.padStart(7) + '  ' + label + ' — ' + why + (rec.log ? ' · log ' + rec.log : ''));
          if (rec.log) {
            const tail = fs.readFileSync(log, 'utf8').trimEnd().split('\n').slice(-25);
            tail.forEach((l) => console.log('         | ' + l.slice(0, 220)));
          }
          if (flag('--bail')) bailed = true;
        }
        if (rec.wrote) console.log('         WROTE committed file' + (rec.wrote.length === 1 ? ' ' : 's ') + rec.wrote.join(', '));
        if (rec.created) console.log('         CREATED untracked file' + (rec.created.length === 1 ? ' ' : 's ') + rec.created.slice(0, 6).join(', ') + (rec.created.length > 6 ? ' …' : ''));
        if (netLog && fs.existsSync(netLog)) {
          const hosts = Array.from(new Set(fs.readFileSync(netLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { const x = JSON.parse(l); return x.host + (x.port ? ':' + x.port : ''); } catch (e) { return '?'; } })));
          rec.network = hosts;
          reached.push({ by: wf.base + ' · ' + label, hosts });
          console.log('         NETWORK ' + hosts.slice(0, 6).join(', ') + (hosts.length > 6 ? ' …' : ''));
        }
      }
    }
  }
  if (notStarted.length) console.log('\nnot started by this change: ' + notStarted.length + ' workflow' + (notStarted.length === 1 ? '' : 's') + (flag('--list') ? '' : ' (--list shows why)'));
  if (flag('--list')) notStarted.forEach((x) => console.log('  ' + x.w.base + ' — ' + x.why));
  console.log('\nSUMMARY  passed ' + tally.pass + ' · failed ' + tally.fail + ' · NOT VERIFIED here ' + tally.unavailable + ' · skipped ' + tally.skipped + ' (installs, false conditions) · reused ' + tally.reused);
  if (notVerified.length) {
    console.log('NOT VERIFIED HERE — CI runs these; do not report them as passed:');
    notVerified.forEach((x) => console.log('  - ' + x));
  }
  if (failures.length) { console.log('FAILED:'); failures.forEach((x) => console.log('  - ' + x)); }
  if (netAudit) {
    console.log(reached.length ? 'STEPS WHOSE NODE PROCESSES REACHED THE NETWORK (a deterministic suite should not):' : 'NETWORK AUDIT: no step\'s node process opened a connection beyond loopback');
    reached.forEach((x) => console.log('  - ' + x.by + ' → ' + x.hosts.join(', ')));
  }
  if (wrote.length) {
    console.log('STEPS THAT REWROTE COMMITTED FILES (a test should write only to a temporary directory):');
    wrote.forEach((w) => console.log('  - ' + w.file + ' ← ' + w.by));
    if (!flag('--keep-writes')) {
      const files = wrote.map((w) => w.file).filter((f) => !dirtyAtStart.has(f));
      const r = files.length ? spawnSync('git', ['checkout', '--'].concat(files), { cwd: ROOT }) : { status: 0 };
      console.log(r.status === 0 ? '  restored ' + files.length + ' to HEAD, so none is committed by accident (--keep-writes keeps them)' : '  could not restore them: ' + String(r.stderr));
    }
  }
  if (created.length) {
    console.log('STEPS THAT CREATED FILES IN THE CHECKOUT (git does not ignore them, so they could be committed by accident):');
    created.forEach((w) => console.log('  - ' + w.file + ' ← ' + w.by));
    if (!flag('--keep-writes')) {
      let n = 0;
      for (const w of created) { try { fs.rmSync(path.join(ROOT, w.file), { force: true }); n++; } catch (e) { console.log('  could not remove ' + w.file + ': ' + e.message); } }
      console.log('  removed ' + n + ' (--keep-writes keeps them)');
    }
  }
  console.log(flag('--list') ? 'PLAN ONLY — nothing was run' : tally.fail ? 'VERIFY FAILED' : 'VERIFY PASSED' + (tally.unavailable ? ' (with ' + tally.unavailable + ' not verified here)' : ''));
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ mode, base, files, tally, results, notVerified, failures, wrote, created, reached }, null, 2));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* the temp dir is the OS's */ }
  return tally.fail ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) { console.error('verify could not run: ' + (e && e.stack || e)); process.exitCode = 2; }
}
module.exports = { withoutSetup, groupWorkflows, categoryOf, CHECKS };
