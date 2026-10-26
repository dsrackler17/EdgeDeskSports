#!/usr/bin/env node
/* ============================================================================
   The integrity gate, tested against the failures it exists for.

   #800 (2026-10-26): a conflict resolved in GitHub's web editor (2ad15afadd)
     deleted both sides, leaving lib/edgedesk_quote_ev.js unparseable (line
     833) and football/cfb_validation/slate_audit.json invalid JSON (line 83);
     it was merged ten seconds later and broke main. Two parallel sessions
     (#799, #800) had fixed the same function, which is what made the
     conflict; #800 also committed football/venues/forecasts.json, a bot's
     file a local test run had rewritten.
   #801 (2026-10-26): merged while "Model performance tests" was still running
     on its last commit (46fbf51, an app.html conflict resolved by hand); that
     suite failed a minute later. #799's merge (ffc4047085) dropped #801's
     CHANGELOG entry and three others (tools/changelog/assemble.test.js).

   Sections
     1  file checks: the #800 artifacts, byte for byte, and every rule
     2  the merge the gate checks: a temporary repository re-enacting #800,
        a stale-main pass, leftover conflict markers
     3  generated files: who owns them, and which changes justify them
     4  the subsystem lock: #799 vs #800, app.html regions
     5  every triggered workflow must pass: the #801 timeline
     6  the workflows keep the gate's guarantees (lints)
     7  the baseline only shrinks

   Run: node tools/integrity/integrity.test.js
   ============================================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const C = require('./checks');
const O = require('./ownership');
const W = require('./workflows');
const G = require('./gate');
const L = require('./lock');
const WC = require('./wait_ci');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const rules = (ps) => ps.map((p) => p.rule).sort().join(',');

/* ---------------------------------------------------------------- 1 */
{
  const broken = fixture('pr800_quote_ev.js.txt');
  const p = C.checkJs('lib/edgedesk_quote_ev.js', broken);
  chk('#800: the merged quote-EV module is rejected with the error main showed', p.length === 1 && p[0].rule === 'js' && /missing \) after argument list/.test(p[0].message), p);
  const repaired = broken.replace(/(\n {4}\}\n)\n( {6}if \(a == null)/, '$1    function q(p) {\n      var lo = -80, hi = 80, a = gt(lo), b = gt(hi), i;\n$2');
  chk('#800: restoring the two deleted lines makes it parse', repaired !== broken && C.checkJs('lib/edgedesk_quote_ev.js', repaired).length === 0, C.checkJs('x.js', repaired));

  const audit = fixture('pr800_slate_audit.json.txt');
  const j = C.checkJson('football/cfb_validation/slate_audit.json', audit);
  chk('#800: the merged slate audit is rejected as invalid JSON, at the dropped verdict', j.length === 1 && j[0].rule === 'json' && /line 69/.test(j[0].message), j);
  const auditFixed = audit.replace(/"consistent": true,\n\n {2}\}/, '"consistent": true,\n   "verdict": "VERIFIED holds: every required check passed."\n  }');
  chk('#800: with the verdict back it parses', auditFixed !== audit && C.checkJson('x.json', auditFixed).length === 0);

  chk('the live module and the live audit parse', C.checkFiles(['lib/edgedesk_quote_ev.js', 'football/cfb_validation/slate_audit.json'], (f) => fs.readFileSync(path.join(ROOT, f))).problems.length === 0);

  const markers = 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\nb\n';
  chk('conflict markers are found in any text file', rules(C.conflictMarkers('docs/x.md', markers)) === 'conflict-marker,conflict-marker,conflict-marker');
  chk('a diff3 base marker counts too', C.conflictMarkers('a.txt', 'x\n||||||| base\ny\n').length === 1);
  chk('a lone ======= (a Markdown heading underline) is not a marker', C.conflictMarkers('README.md', 'Title\n=======\ntext\n').length === 0);
  chk('markers are caught in a .json before it is parsed', C.checkFiles(['d.json'], () => Buffer.from(markers)).problems.some((x) => x.rule === 'conflict-marker'));

  chk('JSON lines: a bad line is named', (() => { const r = C.checkJsonl('a.jsonl', '{"a":1}\n{"b":\n{"c":3}\n'); return r.length === 1 && r[0].line === 2; })());
  chk('an inline <script> that does not parse is caught, at its line', (() => { const r = C.checkHtml('p.html', '<html>\n<script>\nvar a = (1;\n</script>\n</html>'); return r.length === 1 && r[0].rule === 'html-script' && r[0].line === 3; })(), C.checkHtml('p.html', '<html>\n<script>\nvar a = (1;\n</script>\n</html>'));
  chk('an invalid JSON-LD block is caught', rules(C.checkHtml('p.html', '<script type="application/ld+json">{"a":}</script>')) === 'html-json');
  chk('a script with src= and a valid block pass', C.checkHtml('p.html', '<script src="x.js"></script><script>var a = 1;</script><script type="application/ld+json">{"a":1}</script>').length === 0);
  chk('a module file parses through node --check', C.checkJs('m.mjs', 'export const a = 1;\nimport fs from "fs";\n').length === 0 && C.checkJs('m.mjs', 'export const = 1;').length === 1);
  chk('a .js file in module syntax is read the way Node reads it', C.checkJs('m.js', 'import fs from "fs";\nexport default 1;\n').length === 0);
  chk('a CommonJS file with a top-level return parses (Node wraps it)', C.checkJs('c.js', '#!/usr/bin/env node\nif (1) return;\nmodule.exports = 1;\n').length === 0);
  const zlib = require('zlib');
  chk('a truncated .gz is caught', rules(C.checkGz('a.json.gz', zlib.gzipSync('{"a":1}').subarray(0, 12))) === 'gzip');
  chk('a .json.gz holding invalid JSON is caught', rules(C.checkGz('a.json.gz', zlib.gzipSync('{"a":'))) === 'gzip-json');
  const ext = C.checkExternal([
    { rel: 'bad.py', buf: Buffer.from('def f(:\n  pass\n'), kind: 'py' },
    { rel: 'ok.py', buf: Buffer.from('def f():\n  return 1\n'), kind: 'py' },
    { rel: 'bad.sh', buf: Buffer.from('if [ 1 ]; then\necho x\n'), kind: 'sh' },
    { rel: 'bad.yml', buf: Buffer.from('a: [1, 2\nb: 3\n'), kind: 'yaml' },
    { rel: 'ok.yml', buf: Buffer.from('a: 1\n'), kind: 'yaml' },
    { rel: 'bad.xml', buf: Buffer.from('<a><b></a>'), kind: 'xml' }
  ]);
  chk('Python, shell, YAML and XML that do not parse are caught; valid ones pass', ext.map((x) => x.file).sort().join(',') === 'bad.py,bad.sh,bad.xml,bad.yml', ext);
  chk('the gate\'s own broken fixtures are never checked as repository files', C.checkFiles(['tools/integrity/fixtures/pr800_quote_ev.js.txt'], () => Buffer.from('<<<<<<< x\n')).problems.length === 0);
}

/* ---------------------------------------------------------------- 2 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-merge-'));
const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
function git(args) { return execFileSync('git', args, { cwd: tmp, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function put(rel, text) { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); }
function commit(msg) { git(['add', '-A']); git(['commit', '-q', '-m', msg]); return git(['rev-parse', 'HEAD']); }
const MOD = (search) => [
  '(function () {',
  '  function spread(cover) {',
  '    function gt(x) { return cover(x); }',
  search,
  '      return (lo + hi) / 2;',
  '    }',
  '    return q(0.84) - q(0.16);',
  '  }',
  '  module.exports = spread;',
  '}());', ''].join('\n');
const SEARCH_OLD = '    function q(p) {\n      var lo = -80, hi = 80;';
const SEARCH_799 = '    function q(p) {\n      var lo = -80, hi = 80;\n      while (lo < hi && gt(lo) == null) lo++;';
const SEARCH_800 = '    var LO = -80, HI = 80;\n    while (LO < HI && gt(LO) == null) LO++;\n    function q(p) {\n      var lo = LO, hi = HI;';
const AUDIT = (v) => JSON.stringify({ games: [{ id: 1, consistent: true, verdict: v }] }, null, 1) + '\n';
try {
  git(['init', '-q', '-b', 'main']);
  put('lib/q.js', MOD(SEARCH_OLD)); put('data/audit.json', AUDIT('holds'));
  commit('base');
  git(['checkout', '-q', '-b', 'pr800']);
  put('lib/q.js', MOD(SEARCH_800)); put('data/audit.json', AUDIT('holds: every check'));
  const pr800 = commit('#800: the sigma search, its own way');
  git(['checkout', '-q', 'main']);
  put('lib/q.js', MOD(SEARCH_799)); put('data/audit.json', AUDIT('holds: all nine'));
  const main799 = commit('#799 merged: the same fix');
  G.setRepo(tmp);

  (async () => {
    /* the PR as it stood before anyone merged main into it */
    const r0 = await G.verifyMerge(main799, pr800, [], 'origin');
    chk('a pull request that conflicts with the latest main fails, naming the files', r0.conflicts.join(',') === 'data/audit.json,lib/q.js' && r0.problems.every((p) => p.rule === 'merge-conflict') && r0.problems.length === 2, r0);

    /* the web-editor resolution: both sides of both conflicts deleted */
    git(['checkout', '-q', 'pr800']);
    spawnSync('git', ['merge', '-q', 'main'], { cwd: tmp, env: ENV, stdio: 'ignore' });
    put('lib/q.js', MOD('').replace('\n\n      return (lo + hi) / 2;', '\n\n      if (lo > hi) return null;\n      return (lo + hi) / 2;'));
    put('data/audit.json', '{\n "games": [\n  {\n   "id": 1,\n   "consistent": true,\n\n  }\n ]\n}\n');
    git(['add', '-A']); git(['commit', '-q', '--no-edit']);
    const webMerge = git(['rev-parse', 'HEAD']);
    chk('(the re-enactment is a real two-parent merge commit)', git(['rev-list', '--parents', '-n', '1', webMerge]).split(' ').length === 3);
    const r1 = await G.verifyMerge(main799, webMerge, [], 'origin');
    chk('#800: the web-editor merge is refused before it can land — the module does not parse', r1.problems.some((p) => p.rule === 'js' && p.file === 'lib/q.js'), r1.problems);
    chk('#800: … and the audit is invalid JSON', r1.problems.some((p) => p.rule === 'json' && p.file === 'data/audit.json'), r1.problems);
    chk('the check reads the merge result, not the branch alone: no conflict left, two files changed', r1.conflicts.length === 0 && r1.changes.length === 2, r1);

    /* a resolution that kept the markers */
    put('lib/q.js', MOD('<<<<<<< HEAD\n' + SEARCH_800 + '\n=======\n' + SEARCH_799 + '\n>>>>>>> main'));
    put('data/audit.json', AUDIT('holds: all nine'));
    const kept = commit('resolve: keep both');
    const r2 = await G.verifyMerge(main799, kept, [], 'origin');
    chk('a resolution that leaves conflict markers is refused', r2.problems.some((p) => p.rule === 'conflict-marker' && p.file === 'lib/q.js'), r2.problems);

    /* a correct resolution passes */
    put('lib/q.js', MOD(SEARCH_800)); put('data/audit.json', AUDIT('holds: all nine'));
    const good = commit('resolve: keep #800\'s search, main\'s audit');
    const r3 = await G.verifyMerge(main799, good, [], 'origin');
    chk('a correct resolution passes', r3.problems.length === 0, r3.problems);

    /* main moves again after the PR's last check: the old pass does not carry */
    git(['checkout', '-q', 'main']);
    put('lib/q.js', MOD(SEARCH_799 + '\n      while (hi > lo && gt(hi) == null) hi--;'));
    const main2 = commit('another PR merged into the same function');
    const r4 = await G.verifyMerge(main2, good, [], 'origin');
    chk('a pass against an older main does not carry: against the latest main the same head conflicts', r3.problems.length === 0 && r4.problems.some((p) => p.rule === 'merge-conflict' && p.file === 'lib/q.js'), r4);
    G.setRepo(ROOT);
  })().catch((e) => chk('the merge re-enactment ran', false, String(e && e.stack))).finally(rest);
} catch (e) {
  chk('the merge re-enactment ran', false, String(e && e.stack));
  rest();
}

function rest() {
  fs.rmSync(tmp, { recursive: true, force: true });

  /* -------------------------------------------------------------- 3 */
  {
    const all = W.listWorkflows().flatMap((wf) => W.publishers(wf));
    chk('every job that commits names its paths so they can be read (none unresolved)', all.length >= 60 && all.every((p) => p.paths.length > 0 && p.unresolved.length === 0), all.filter((p) => !p.paths.length || p.unresolved.length).map((p) => p.workflow + ':' + p.line));
    const cls = (f) => O.classify(f);
    chk('the slate audit is generated, owned by the CFB lab job', cls('football/cfb_validation/slate_audit.json').owners.includes('.github/workflows/cfb-lab.yml'));
    chk('the build script beside it is source', cls('football/cfb_validation/build.js').class === 'source');
    chk('app.html, which jobs patch in place, stays source', cls('app.html').class === 'merge-source');
    chk('CHANGELOG.md is generated, owned by the Changelog job', cls('CHANGELOG.md').class === 'generated' && cls('CHANGELOG.md').owners.includes('.github/workflows/changelog.yml'));
    chk('a changelog fragment is source', cls('changelog.d/2026-10-26-x.md').class === 'source');
    const pr800 = ['football/cfb_validation/build.js', 'football/cfb_validation/tests.js', 'CHANGELOG.md', 'football/cfb_validation/slate_audit.json', 'football/venues/forecasts.json'];
    chk('#800: the slate audit it regenerated is justified by its generator (build.js)', O.explained('football/cfb_validation/slate_audit.json', pr800).ok);
    chk('#800: the forecasts file a local test run rewrote is NOT justified — an accidental commit', !O.explained('football/venues/forecasts.json', pr800).ok);
    chk('#799: the terminal board is justified by the quote-EV module the terminal build loads', O.explained('football/cfb_terminal/board.json', ['lib/edgedesk_quote_ev.js']).ok);
    chk('an unrelated change does not justify the terminal board', !O.explained('football/cfb_terminal/board.json', ['lib/edgedesk_sport_graphic.js']).ok);
    const ch = (paths) => paths.map((p) => ({ status: 'M', path: p }));
    const g1 = G.generatedRule(ch(pr800.filter((p) => p !== 'CHANGELOG.md')), []);
    chk('#800 under the gate: forecasts.json is refused, the audit allowed', g1.problems.map((p) => p.file).join() === 'football/venues/forecasts.json' && g1.allowed.some((a) => a.file === 'football/cfb_validation/slate_audit.json'), g1);
    const g2 = G.generatedRule(ch(['CHANGELOG.md', 'lib/edgedesk_plans.js']), []);
    chk('a hand edit of CHANGELOG.md is refused, pointing at changelog.d/', g2.problems.length === 1 && /changelog\.d/.test(g2.problems[0].message), g2);
    chk('a person can allow it with the generated-files-ok label', G.generatedRule(ch(['football/venues/forecasts.json']), [G.LABEL_GENERATED]).problems.length === 0);
    const cl = G.changelogRule([{ status: 'A', path: 'changelog.d/2026-10-26-bad.md' }, { status: 'A', path: 'changelog.d/2026-10-26-good.md' }],
      new Map([['changelog.d/2026-10-26-bad.md', Buffer.from('# Changes\n\nsome text\n')], ['changelog.d/2026-10-26-good.md', Buffer.from('## 2026-10-26 — Good\n\nBody.\n')]]));
    chk('a malformed changelog fragment is refused, a good one passes', cl.length > 0 && cl.every((p) => p.file === 'changelog.d/2026-10-26-bad.md'), cl);
  }

  /* -------------------------------------------------------------- 4 */
  {
    const cfg = L.loadConfig();
    const k799 = L.lockKeys([{ filename: 'lib/edgedesk_quote_ev.js', status: 'modified' }, { filename: 'tools/football/quote_ev.test.js', status: 'modified' }, { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -3,0 +4,12 @@' }], cfg);
    const k800 = L.lockKeys([{ filename: 'lib/edgedesk_quote_ev.js', status: 'modified' }, { filename: 'football/cfb_validation/build.js', status: 'modified' }, { filename: 'football/cfb_validation/slate_audit.json', status: 'modified' }], cfg);
    const hit = L.collisions(k800, k799, cfg);
    chk('#799 vs #800: the second pull request on the quote-EV module is held when it opens', hit.length === 1 && hit[0].key === 'subsystem:cfb-quote-ev', hit);
    chk('generated files and changelog fragments claim nothing', ![...k799.keys(), ...k800.keys()].some((k) => /CHANGELOG|slate_audit/.test(k)) && L.lockKeys([{ filename: 'changelog.d/2026-10-26-a.md' }], cfg).size === 0);
    const app = (patch) => L.lockKeys([{ filename: 'app.html', status: 'modified', patch }], cfg);
    chk('app.html: two pull requests editing distant lines may run in parallel', L.collisions(app('@@ -100,5 +100,6 @@'), app('@@ -30000,4 +30000,9 @@'), cfg).length === 0);
    chk('app.html: two editing the same region (#797 and #801, the NHL and Today\'s Games stamps) may not', L.collisions(app('@@ -50000,3 +50000,3 @@'), app('@@ -50012,2 +50012,2 @@'), cfg).length === 1);
    chk('app.html with no patch (too large to show) is held whole', L.collisions(app(null), app('@@ -5,1 +5,1 @@'), cfg).length === 1);
    chk('unmapped files are held file by file', L.collisions(L.lockKeys([{ filename: 'lib/edgedesk_plans.js' }], cfg), L.lockKeys([{ filename: 'lib/edgedesk_flags.js' }], cfg), cfg).length === 0 && L.collisions(L.lockKeys([{ filename: 'lib/edgedesk_plans.js' }], cfg), L.lockKeys([{ filename: 'lib/edgedesk_plans.js' }], cfg), cfg).length === 1);
    chk('the older pull request holds: created first, then the lower number', L.older({ created_at: '2026-10-26T12:00:00Z', number: 9 }, { created_at: '2026-10-26T12:30:00Z', number: 3 }) && L.older({ created_at: 'x', number: 1 }, { created_at: 'x', number: 2 }));
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
    const dead = [];
    cfg.subsystems.forEach((s) => s.paths.forEach((p) => { const re = O.globToRegExp(p); if (!tracked.some((f) => re.test(f))) dead.push(s.name + ': ' + p); }));
    cfg.hotspots.forEach((h) => { if (!tracked.includes(h)) dead.push('hotspot: ' + h); });
    chk('every subsystem path and hotspot matches a tracked file', dead.length === 0, dead);
  }

  /* -------------------------------------------------------------- 5 */
  {
    const run = (id, wf, name, status, conclusion, n) => ({ id, workflow_id: wf, name, status, conclusion, run_number: n || 1, run_attempt: 1, created_at: '2026-10-26T12:35:2' + (n || 1) + 'Z', html_url: 'u' });
    /* 46fbf51 at 12:36:32, when #801 was merged */
    const atMerge = [run(1, 10, 'CFB board integrity tests', 'completed', 'success'), run(2, 11, 'Model performance tests', 'in_progress', null), run(3, 12, 'CFB validation', 'completed', 'failure'), run(4, 99, 'Integrity gate', 'in_progress', null)];
    const l1 = WC.latestPerWorkflow(atMerge, new Set([99]));
    chk('the gate never waits on itself', l1.length === 3 && !l1.some((r) => r.workflow_id === 99));
    const v1 = WC.verdict(l1);
    chk('#801 at merge time: not done (Model performance still running) and already failed (CFB validation) — not mergeable', !v1.done && v1.pending.map((r) => r.name).join() === 'Model performance tests' && v1.failed.map((r) => r.name).join() === 'CFB validation', v1);
    const later = atMerge.map((r) => (r.id === 2 ? Object.assign({}, r, { status: 'completed', conclusion: 'failure' }) : r));
    const v2 = WC.verdict(WC.latestPerWorkflow(later, new Set([99])));
    chk('#801 a minute later: Model performance tests failed — the gate fails with it', v2.done && v2.failed.length === 2, v2);
    const rerun = later.concat([run(5, 11, 'Model performance tests', 'completed', 'success', 2), run(6, 12, 'CFB validation', 'completed', 'success', 2)]);
    chk('a newer run of a workflow replaces the older one', WC.verdict(WC.latestPerWorkflow(rerun, new Set([99]))).failed.length === 0);
    chk('skipped and neutral runs pass; cancelled and timed-out do not', ['success', 'skipped', 'neutral'].every((c) => WC.PASS.has(c)) && !['cancelled', 'timed_out', 'failure', 'action_required', 'startup_failure', 'stale'].some((c) => WC.PASS.has(c)));
  }

  /* -------------------------------------------------------------- 6 */
  {
    const py = spawnSync('python3', ['-c', [
      'import json, sys, glob, yaml',
      'out = {}',
      'for f in sorted(glob.glob(".github/workflows/*.yml")):',
      '    d = yaml.safe_load(open(f))',
      '    if True in d: d["on"] = d.pop(True)',
      '    out[f] = d',
      'json.dump(out, sys.stdout, default=str)'].join('\n')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
    chk('every workflow parses as YAML (PyYAML: python3 -m pip install pyyaml)', py.status === 0, (py.stderr || '').slice(-400));
    const wfs = py.status === 0 ? JSON.parse(py.stdout) : {};
    const gate = wfs['.github/workflows/integrity-gate.yml'] || {};
    const on = gate.on || {};
    chk('the gate has no path filter: it runs on every pull request and every push to main', on.pull_request && !on.pull_request.paths && !on.pull_request['paths-ignore'] && on.push && !on.push.paths && JSON.stringify(on.push.branches) === '["main"]', on);
    chk('the gate runs on every pull request event that changes the answer', ['opened', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled'].every((t) => (on.pull_request.types || []).includes(t)));
    const agg = (gate.jobs || {})['integrity-gate'] || {};
    chk('the required check is the integrity-gate job, which is never skipped and needs every part', agg.name === 'integrity-gate' && agg.if === 'always()' && ['verify', 'subsystem-lock', 'ci-complete'].every((n) => (agg.needs || []).includes(n)), agg);
    chk('no part of the gate may fail quietly (continue-on-error)', Object.values(gate.jobs || {}).every((j) => !j['continue-on-error'] && (j.steps || []).every((s) => !s['continue-on-error'])));
    const named = Object.entries(wfs).filter(([f, d]) => f !== '.github/workflows/integrity-gate.yml' && Object.entries(d.jobs || {}).some(([id, j]) => id === 'integrity-gate' || j.name === 'integrity-gate'));
    chk('no other workflow reports a check named integrity-gate', named.length === 0, named.map((x) => x[0]));

    const publishers = new Set(W.listWorkflows().filter((wf) => W.publishers(wf).length).map((wf) => wf.file));
    const INTENTIONAL = { '.github/workflows/integrity-revalidate.yml': 'the newest main is all it revalidates against' };
    const badConc = [];
    for (const [f, d] of Object.entries(wfs)) {
      const o = d.on || {};
      const push = o.push !== undefined && (o.push === null || !o.push.branches || o.push.branches.includes('main'));
      if (!push || publishers.has(f) || INTENTIONAL[f]) continue;
      const cs = [d.concurrency].concat(Object.values(d.jobs || {}).map((j) => j.concurrency)).filter(Boolean);
      for (const c of cs) {
        if (typeof c !== 'object') continue;
        const cancel = c['cancel-in-progress'];
        if (cancel === true || (typeof cancel === 'string' && !/github\.event_name == 'pull_request'/.test(cancel))) badConc.push(f + ': cancel-in-progress ' + cancel);
        else if (cancel && !/github\.sha/.test(String(c.group))) badConc.push(f + ': group ' + c.group + ' is shared on main');
      }
    }
    chk('no validation workflow cancels or drops a run on main: a pull request supersedes, main runs every commit', badConc.length === 0, badConc);

    const perms = [];
    for (const [f, d] of Object.entries(wfs)) {
      if (!publishers.has(f)) continue;
      for (const [id, j] of Object.entries(d.jobs || {})) {
        const run = (j.steps || []).map((s) => String(s.run || '')).join('\n');
        if (!/push_generated\.sh|attest_head\.sh/.test(run)) continue;
        if (/push_generated\.sh\s+"\$HEAD_REF"/.test(run) && !/push_generated\.sh\s+main/.test(run)) continue;
        const p = j.permissions || d.permissions || {};
        if (p.contents !== 'write' || p.statuses !== 'write') perms.push(f + ' ' + id);
      }
    }
    chk('every job that publishes to main can set the integrity-gate status (statuses: write)', perms.length === 0, perms);

    const raw = [];
    for (const wf of W.listWorkflows()) {
      for (const b of W.runBlocks(wf.text)) for (const l of W.logicalLines(b.script)) {
        if (!/(^|[\s;&|(])git\s+push\b/.test(l) || /--delete|head\.ref|HEAD_REF/.test(l)) continue;
        if (!/attest_head\.sh\s*&&\s*git\s+push/.test(l)) raw.push(wf.file + ': ' + l.trim().slice(0, 80));
      }
    }
    chk('every raw `git push` to main is attested first (bash tools/ci/attest_head.sh && git push …)', raw.length === 0, raw);
    /* a GITHUB_TOKEN push into a pull request branch starts no workflow: the
       job must dispatch the gate, or the new head never gets its check */
    const intoPr = W.listWorkflows().filter((wf) => W.publishers(wf).some((p) => /HEAD_REF|head_ref|head\.ref/.test(p.branch)) || /git push origin HEAD:\$\{\{ github\.event\.pull_request\.head\.ref \}\}/.test(wf.text));
    const noDispatch = intoPr.filter((wf) => !/gh workflow run integrity-gate\.yml[^\n]*-f pr=/.test(wf.text) || ((wfs[wf.file] || {}).permissions || {}).actions !== 'write');
    chk('every job that commits into a pull request branch dispatches the integrity gate on that commit', intoPr.length >= 2 && noDispatch.length === 0, noDispatch.map((w) => w.file));
    chk('the gate runs the pull-request checks when dispatched with a pr number', ((((on.workflow_dispatch || {}).inputs) || {}).pr || {}).required === false);
    const ciStep = (((gate.jobs || {})['ci-complete'] || {}).steps || []).map((s) => String(s.run || '')).join('\n');
    const wcReq = (fs.readFileSync(path.join(__dirname, 'wait_ci.js'), 'utf8').match(/require\(['"][^'"]+['"]\)/g) || []);
    chk('ci-complete runs wait_ci.js itself, which loads nothing outside its sparse checkout (tools/integrity)', /node tools\/integrity\/wait_ci\.js/.test(ciStep) && wcReq.every((r) => /'(fs|\.\/github)'/.test(r)), wcReq);
    const pg = fs.readFileSync(path.join(ROOT, 'tools', 'ci', 'push_generated.sh'), 'utf8');
    chk('push_generated.sh attests before every push and refuses a commit that fails the check', /if ! attest; then[\s\S]{0,200}exit 1[\s\S]{0,80}if git push "\$REMOTE" "HEAD:refs\/heads\/\$BRANCH"/.test(pg));
  }

  /* -------------------------------------------------------------- 7 */
  {
    const base = C.loadBaseline(ROOT);
    const stillBad = base.entries.filter((e) => {
      let buf;
      try { buf = fs.readFileSync(path.join(ROOT, e.file)); } catch (err) { return false; }
      return C.checkFiles([e.file], () => buf, { baseline: { entries: [] } }).problems.some((p) => p.rule === e.rule);
    });
    chk('every baseline exception still fails its rule (fixed files must leave the baseline)', stillBad.length === base.entries.length, base.entries.filter((e) => !stillBad.includes(e)).map((e) => e.file));
    chk('every baseline exception says why', base.entries.every((e) => e.reason && e.reason.length > 20));
    chk('the baseline is not a way around the check for anything else (12 NaN research files, nothing more)', base.entries.length <= 12 && base.entries.every((e) => e.rule === 'json' && e.file.startsWith('docs/model-loop/clv_early/results/')));
  }

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'integrity gate — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
