#!/usr/bin/env node
/* ===========================================================================
   tools/ci/workflows.js — the workflows read the way GitHub reads them.

     1  the YAML subset: maps, sequences, "- key:" items, quoting and escapes,
        flow collections, | and > with chomping, comments, plain run-ons;
        what it does not support (anchors, tabs, duplicate keys) throws
     2  the same tree as PyYAML for every workflow in the repository (when
        python3 has PyYAML; said, never assumed)
     3  GitHub's filter patterns: * and ** and ?, a leading "**" + "/", later !
        patterns excluding, later positive ones re-including
     4  ${{ }} on a pull request: what is known is evaluated, what is not is
        UNKNOWN, and UNKNOWN never reads as true
     5  which workflows a change starts, and what each step becomes
        (run / setup / condition / NOT VERIFIED and why)
     6  tools/ci/checks.json: every workflow a pull request can start is in
        exactly one category, and every name in it exists
     7  verify.js: an install line is not repeated, the commands around it are

   Run: node tools/ci/workflows.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./workflows.js');
const V = require('./verify.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };
const eq = (name, got, want) => chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const throws = (name, fn, re) => { try { fn(); chk(name, false, 'did not throw'); } catch (e) { chk(name, !re || re.test(e.message), e.message); } };

/* 1. the YAML subset */
eq('a nested map, a sequence of maps, scalars typed as GitHub reads them', W.parseYaml([
  'name: CFB validation',
  'on:',
  '  pull_request:',
  '    paths:',
  "      - 'lib/edgedesk_canon.js'",
  '      - "football/**"',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  rules:',
  '    runs-on: ubuntu-latest   # a comment',
  '    timeout-minutes: 15',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - name: one',
  '        run: node a.js',
  '        env: { A: \'1\', B: "x y" }',
].join('\n')), {
  name: 'CFB validation',
  on: { pull_request: { paths: ['lib/edgedesk_canon.js', 'football/**'] }, push: { branches: ['main'] } },
  jobs: { rules: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 15, steps: [{ uses: 'actions/checkout@v5' }, { name: 'one', run: 'node a.js', env: { A: '1', B: 'x y' } }] } },
});
eq('`on` is the key "on", not a boolean (YAML 1.2, as GitHub reads it)', Object.keys(W.parseYaml('on:\n  push:\n')), ['on']);
eq('| keeps lines and one trailing newline; |- strips it; |+ keeps all', W.parseYaml('a: |\n  x\n    y\n\nb: |-\n  x\nc: |+\n  x\n\nd: 1\n'), { a: 'x\n  y\n', b: 'x', c: 'x\n\n', d: 1 });
eq('>- folds lines with a space; a blank line is a newline', W.parseYaml('a: >-\n  one\n  two\n\n  three\n'), { a: 'one two\nthree' });
eq('quoting: \'\' inside single quotes, escapes inside double, # inside quotes is text', W.parseYaml("a: 'it''s # not a comment'\nb: \"tab\\tnl\\n\\\"q\\\"\"\nc: plain # a comment\n"), { a: "it's # not a comment", b: 'tab\tnl\n"q"', c: 'plain' });
eq('a plain scalar runs on to more-indented lines', W.parseYaml("if: github.event_name == 'x' ||\n    inputs.mode == 'y'\n"), { if: "github.event_name == 'x' || inputs.mode == 'y'" });
eq('a sequence may sit at its key\'s own indent', W.parseYaml('paths:\n- a\n- b\nnext: 1\n'), { paths: ['a', 'b'], next: 1 });
eq('${{ }} and a leading ! after it stay plain text', W.parseYaml('if: ${{ !cancelled() }}\n'), { if: '${{ !cancelled() }}' });
eq('empty values are null; [] and {} are empty', W.parseYaml('a:\nb: []\nc: {}\n'), { a: null, b: [], c: {} });
throws('an anchor or alias is refused, never guessed', () => W.parseYaml('a: &x 1\nb: *x\n'), /anchor/);
throws('a tab in the indentation is refused', () => W.parseYaml('a:\n\tb: 1\n'), /tab/);
throws('a duplicate key is refused (GitHub refuses the file)', () => W.parseYaml('a: 1\na: 2\n'), /duplicate/);
throws('a line deeper than its mapping is refused', () => W.parseYaml('a: 1\n    b: 2\n'), /deeper/);

/* 2. the same tree as PyYAML, for every workflow in the repository */
{
  const dir = path.join(ROOT, '.github', 'workflows');
  const mine = {};
  let parsed = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    try { mine[f] = W.parseYaml(fs.readFileSync(path.join(dir, f), 'utf8')); parsed++; } catch (e) { chk('workflow ' + f + ' parses', false, e.message); }
  }
  chk('every workflow in .github/workflows parses', parsed === Object.keys(mine).length && parsed > 0, parsed);
  const py = [
    'import json, sys, os, datetime',
    'try:',
    '    import yaml',
    'except ImportError:',
    '    print(json.dumps({"skip": "PyYAML is not installed"})); sys.exit(0)',
    'mine = json.load(sys.stdin); d = sys.argv[1]',
    'B = {"yes": True, "no": False, "on": True, "off": False, "y": True, "n": False, "true": True, "false": False}',
    'def norm(v):',
    '    if isinstance(v, dict): return {("on" if k is True else str(k)): norm(x) for k, x in v.items()}',
    '    if isinstance(v, list): return [norm(x) for x in v]',
    '    if isinstance(v, (datetime.date, datetime.datetime)): return v.isoformat()',
    '    return v',
    'def eq(a, b, p):',
    '    if isinstance(a, dict) and isinstance(b, dict):',
    '        if set(a) != set(b): return p + " keys differ"',
    '        for k in a:',
    '            r = eq(a[k], b[k], p + "." + k)',
    '            if r: return r',
    '        return None',
    '    if isinstance(a, list) and isinstance(b, list):',
    '        if len(a) != len(b): return p + " lengths differ"',
    '        for i, (x, y) in enumerate(zip(a, b)):',
    '            r = eq(x, y, p + "[%d]" % i)',
    '            if r: return r',
    '        return None',
    '    if isinstance(a, bool) and isinstance(b, str) and b.lower() in B and B[b.lower()] == a: return None',
    '    if type(a) == type(b) and a == b: return None',
    '    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool) and a == b: return None',
    '    return p + ": %r vs %r" % (a, b)',
    'bad = []',
    'for f in sorted(mine):',
    '    r = eq(norm(yaml.safe_load(open(os.path.join(d, f)))), mine[f], f)',
    '    if r: bad.append(r[:300])',
    'print(json.dumps({"compared": len(mine), "bad": bad}))'].join('\n');
  const r = spawnSync('python3', ['-I', '-c', py, dir], { input: JSON.stringify(mine), maxBuffer: 1 << 26 });
  let out = null;
  try { out = JSON.parse(String(r.stdout)); } catch (e) { out = null; }
  if (r.error || !out) console.log('NOTE | python3 is not available: the PyYAML cross-check did NOT run');
  else if (out.skip) console.log('NOTE | ' + out.skip + ': the PyYAML cross-check did NOT run');
  else chk('every workflow reads the same as PyYAML reads it (' + out.compared + ' files)', out.bad.length === 0 && out.compared === parsed, out.bad.slice(0, 5));
}

/* 3. GitHub's filter patterns */
const m = (pats, f) => W.pathMatches(pats, f);
chk('* stops at a slash; ** does not', m(['lib/*.js'], 'lib/a.js') && !m(['lib/*.js'], 'lib/x/a.js') && m(['lib/**'], 'lib/x/a.js'));
chk('*.js matches only the root, **.js anywhere', m(['*.js'], 'a.js') && !m(['*.js'], 'lib/a.js') && m(['**.js'], 'lib/x/a.js'));
chk('a leading **/ matches at the root too', m(['**/README.md'], 'README.md') && m(['**/README.md'], 'docs/x/README.md'));
chk('a pattern names a whole path, not a prefix', !m(['lib/edgedesk_canon.js'], 'lib/edgedesk_canon.js.bak') && !m(['app.html'], 'x/app.html'));
chk('lib/edgedesk_decision*.js: the bare name and every suffix', m(['lib/edgedesk_decision*.js'], 'lib/edgedesk_decision.js') && m(['lib/edgedesk_decision*.js'], 'lib/edgedesk_decision_ui.js'));
chk('? is zero or one of the character before it (GitHub\'s rule)', m(['*.jsx?'], 'a.js') && m(['*.jsx?'], 'a.jsx') && !m(['*.jsx?'], 'a.jsxx'));
chk('a later ! excludes, a later positive pattern includes again', !m(['docs/**', '!docs/x/**'], 'docs/x/a.md') && m(['docs/**', '!docs/x/**', 'docs/x/keep.md'], 'docs/x/keep.md'));
chk('dots and brackets are literal unless a [set]', m(['a.b'], 'a.b') && !m(['a.b'], 'axb') && m(['v[12].js'], 'v1.js') && !m(['v[12].js'], 'v3.js'));

/* 4. expressions */
const ctx = W.prContext({ root: ROOT, temp: '/tmp' });
const E = (s) => W.evalExpr(s, ctx);
chk("github.event_name == 'pull_request' is true on a pull request", E("${{ github.event_name == 'pull_request' }}") === true);
chk('comparison is case-insensitive, as GitHub\'s is', E("github.event_name == 'PULL_REQUEST'") === true);
chk('an input a pull request does not have is empty', E("inputs.mode == 'run'") === false && E('inputs.verify_only != true') === true);
chk('a secret is UNKNOWN', E("secrets.SB_URL != ''") === W.UNKNOWN);
chk('a step output is UNKNOWN', E("steps.mode.outputs.mode != 'none'") === W.UNKNOWN);
chk('UNKNOWN && false is false; UNKNOWN || true is true; UNKNOWN && true stays UNKNOWN', E("steps.a.outputs.b == 'x' && false") === false && E("steps.a.outputs.b == 'x' || true") === true && E("steps.a.outputs.b == 'x' && true") === W.UNKNOWN);
chk('!UNKNOWN is UNKNOWN, never true', E('!steps.a.outputs.b') === W.UNKNOWN);
chk('always() / success() true; cancelled() / failure() false on a passing run', E('always()') === true && E('!cancelled()') === true && E('failure()') === false);
chk("format, contains, startsWith, and ||'s value", E("format('{0}-{1}', 'a', 'b')") === 'a-b' && E("contains('abc', 'B')") === true && E("startsWith(github.base_ref, 'ma')") === true && E("github.base_ref || 'main'") === 'main');
eq('interpolate: a known value is substituted', W.interpolate('x ${{ github.base_ref }} ${{ runner.temp }}', ctx), { ok: true, value: 'x main /tmp' });
chk('interpolate: an unknown value refuses the whole string', W.interpolate('${{ secrets.X }}', ctx).ok === false);

/* 5. which workflows a change starts, and each step's fate */
const wf = (doc) => ({ file: 'x.yml', base: 'x.yml', name: 'x', doc, on: W.triggers(doc) });
const PRF = wf({ on: { pull_request: { paths: ['lib/**', '!lib/skip.js'] } }, jobs: {} });
chk('a paths filter: started by a matching file', W.triggeredBy(PRF, ['README.md', 'lib/a.js']).run === true);
chk('...not by a file it excludes', W.triggeredBy(PRF, ['lib/skip.js']).run === false);
chk('no filter: every pull request', W.triggeredBy(wf({ on: { pull_request: null }, jobs: {} }), ['anything']).run === true);
chk('push only: no pull request starts it', W.triggeredBy(wf({ on: { push: { branches: ['main'] } }, jobs: {} }), ['lib/a.js']).run === false);
chk('a branches filter that leaves out main', W.triggeredBy(wf({ on: { pull_request: { branches: ['release/*'] } }, jobs: {} }), ['a']).run === false);
chk('paths-ignore: started unless every file is ignored', W.triggeredBy(wf({ on: { pull_request: { 'paths-ignore': ['docs/**'] } }, jobs: {} }), ['docs/a.md']).run === false
  && W.triggeredBy(wf({ on: { pull_request: { 'paths-ignore': ['docs/**'] } }, jobs: {} }), ['docs/a.md', 'lib/a.js']).run === true);
{
  const P = W.plan(wf({ on: { pull_request: null }, jobs: {
    a: { steps: [
      { uses: 'actions/checkout@v5' },
      { name: 'install', run: 'sudo apt-get install -y postgresql\nnpm install --no-save playwright@1.49.1' },
      { name: 'secret', run: 'node a.js', env: { K: '${{ secrets.SB_URL }}' } },
      { name: 'schedule only', if: "github.event_name == 'schedule'", run: 'node b.js' },
      { name: 'step output', if: "${{ steps.m.outputs.mode != 'none' }}", run: 'node c.js' },
      { name: 'plain', run: 'node d.js', env: { T: '${{ runner.temp }}/x' }, 'working-directory': 'sub' },
    ] },
    b: { if: "github.event_name == 'schedule'", steps: [{ run: 'x' }] },
    c: { strategy: { matrix: { s: [1, 2] } }, steps: [{ run: 'x' }] },
    d: { services: { postgres: { image: 'postgres:16' } }, steps: [{ run: 'psql -h 127.0.0.1' }] },
  } }), { root: ROOT, temp: '/tmp' });
  const st = P[0].steps.map((s) => s.status);
  eq('uses / install-only / secret / false if / unknown if / plain', st, ['setup', 'setup', 'unavailable', 'condition', 'unavailable', 'run']);
  chk('a NOT VERIFIED step says what it needs', /secrets\.SB_URL/.test(P[0].steps[2].why) && /step output/.test(P[0].steps[4].why));
  chk('a runnable step keeps its env (expressions substituted) and working-directory', P[0].steps[5].env.T === '/tmp/x' && P[0].steps[5].cwd === 'sub');
  chk('a job whose if: is false on a pull request is skipped as a condition', P[1].skipped && P[1].skipped.kind === 'condition');
  chk('a matrix job is NOT VERIFIED here, never silently passed', P[2].skipped && P[2].skipped.kind === 'unknown');
  chk('a job with a service container marks its steps', P[3].steps[0].status === 'run' && P[3].steps[0].services[0] === 'postgres');
}
{
  const all = W.loadWorkflows(ROOT);
  const val = all.find((x) => x.base === 'cfb-validation-tests.yml');
  chk('the CFB validation workflow is started by lib/edgedesk_canon.js', !!val && W.triggeredBy(val, ['lib/edgedesk_canon.js']).run);
  chk('...and not by a README change', !!val && !W.triggeredBy(val, ['README.md']).run);
  const core = all.find((x) => x.base === 'core-validation.yml');
  chk('Core validation runs on every pull request (no paths filter) and on pushes to main', !!core && W.triggeredBy(core, ['README.md']).run && !!core.on.push);
  let planned = 0;
  for (const x of all.filter((y) => y.on.pull_request !== undefined)) { try { W.plan(x, { root: ROOT, temp: '/tmp' }); planned++; } catch (e) { chk('plan ' + x.base, false, e.message); } }
  chk('every pull-request workflow plans without an error', planned > 0, planned);

  /* 6. tools/ci/checks.json */
  const pr = all.filter((y) => Object.prototype.hasOwnProperty.call(y.on, 'pull_request')).map((y) => y.base);
  const where = {};
  for (const [k, c] of Object.entries(V.CHECKS.categories)) for (const f of c.workflows) (where[f] = where[f] || []).push(k);
  const missing = pr.filter((f) => !where[f]), twice = Object.keys(where).filter((f) => where[f].length > 1), ghost = Object.keys(where).filter((f) => !all.find((y) => y.base === f));
  chk('every workflow a pull request can start has a category in tools/ci/checks.json', missing.length === 0, missing);
  chk('no workflow is in two categories', twice.length === 0, twice);
  chk('every workflow checks.json names exists', ghost.length === 0, ghost);
  const aliasGhost = [];
  for (const k of Object.keys(V.CHECKS.aliases)) { const g = V.groupWorkflows(k); if (!g) aliasGhost.push(k); else g.forEach((f) => { if (!all.find((y) => y.base === f)) aliasGhost.push(k + ':' + f); }); }
  chk('every alias names a category or existing workflows', aliasGhost.length === 0, aliasGhost);
}

/* 7. verify does not repeat an install, and keeps what runs beside it */
{
  const r = V.withoutSetup('sudo apt-get install -y -qq postgresql >/dev/null 2>&1 || true\nnode tools/x.test.js\nnpm install --no-save playwright@1.49.1 && npx playwright install --with-deps chromium\nsudo apt-get update && \\\n  sudo apt-get install -y psql\nnode y.js');
  chk('install lines (chained, continued, silenced) are dropped; the tests stay', r.dropped.length === 3 && /node tools\/x\.test\.js/.test(r.script) && /node y\.js/.test(r.script) && !/^\s*sudo/m.test(r.script) && !/^\s*npm install/m.test(r.script), r);
  chk('the line count is kept, so a failure still points at its line', r.script.split('\n').length === 6, r.script.split('\n').length);
  const keep = V.withoutSetup('npm install && node a.test.js');
  chk('a line that installs AND tests is kept whole', keep.dropped.length === 0 && /node a\.test\.js/.test(keep.script));
}

if (fail) { failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? ' | ' + JSON.stringify(f.detail).slice(0, 600) : ''))); console.log('FAILED workflow reader — ' + pass + ' passed, ' + fail + ' failed'); process.exitCode = 1; }
else console.log('ALL GREEN workflow reader — ' + pass + ' passed, 0 failed');
