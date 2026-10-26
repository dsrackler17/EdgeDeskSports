#!/usr/bin/env node
/* ===========================================================================
   tools/ci/integrity.js, driven against synthetic repositories.

   The first case is the damage itself: 2ad15afadd (2026-10-26) deleted a
   function's header in lib/edgedesk_quote_ev.js and dropped two "verdict"
   lines from football/cfb_validation/slate_audit.json while keeping their
   commas. Each check below is one way a hand-resolved conflict or a bad edit
   breaks a file that no suite of its own may load; each must fail, name the
   file and line, and leave a clean repository green. The CLI's exit codes
   are checked on a real git repository.

   Run: node tools/ci/integrity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const I = require('./integrity.js');

let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-integrity-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const CLEAN = {
  'package.json': JSON.stringify({ name: 'x', scripts: { 'a:test': 'node tools/a.test.js', both: 'npm run a:test && cd sub && bash run.sh', sub: 'npm run --prefix web build' } }, null, 2),
  'web/package.json': JSON.stringify({ scripts: { build: 'echo ok' } }),
  'sub/run.sh': '#!/usr/bin/env bash\nset -e\necho ok\n',
  'tools/a.test.js': '#!/usr/bin/env node\n\'use strict\';\nconst x = require("./b");\nif (!x) return;\nmodule.exports = 1;\n',
  'lib/q.js': '(function () {\n  function q(p) {\n    var lo = 0, hi = 1;\n    return (lo + hi) / 2;\n  }\n  window.Q = { q: q };\n})();\n',
  'lib/esm.js': 'import fs from "node:fs";\nexport const a = 1;\n',
  'lib/m.mjs': 'export default function f() { return 1; }\n',
  'supabase/functions/f/index.ts': 'interface A { b: number }\nexport function f(a: A): number { return a.b; }\n',
  'data/a.json': '{\n "games": [\n  {\n   "consistent": true,\n   "verdict": "VERIFIED holds"\n  }\n ]\n}\n',
  'data/py.json': '{"clv_pts": NaN, "edge": Infinity, "low": -Infinity, "s": "NaN is fine in a string"}\n',
  'data/l.jsonl': '{"a":1}\n\n{"a":2}\n',
  'page.html': '<!doctype html>\n<script src="x.js"></script>\n<script>\n  var a = 1;\n</script>\n<script type="module">\n  import x from "./x.js";\n</script>\n<script type="application/ld+json">{"@type":"Thing"}</script>\n<script type="text/template"><div>{{ not js }}</div></script>\n',
  'docs/notes.md': '# Notes\n\nA conflict looks like:\n\n    <<<<<<< HEAD\n',
  'research/x.py': 'def f():\n    return 1\n',
  '.github/workflows/ci.yml': 'name: ci\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: node tools/a.test.js && npm run -s a:test\n      - run: node --max-old-space-size=4096 run.js\n        working-directory: sub\n      - run: node -e "require(\'./missing.js\')"\n      # node commented/out.js\n',
  'sub/run.js': 'console.log(1)\n',
};
const scan = (root) => I.scan({ root, files: listFiles(root) });
function listFiles(root) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = d ? d + '/' + e.name : e.name; if (e.isDirectory()) { if (e.name !== '.git') walk(p); } else out.push(p); } })('');
  return out;
}
const kinds = (res) => res.problems.map((p) => p.kind + ' ' + p.file + (p.line ? ':' + p.line : ''));

/* a clean repository */
{
  const res = scan(repo(CLEAN));
  chk('a clean repository has no problems', res.problems.length === 0, kinds(res));
  chk('...and every kind of file was looked at', res.counts.js >= 2 && res.counts.module >= 2 && res.counts.ts === 1 && res.counts.json >= 3 && res.counts.jsonl_lines === 2 && res.counts.html_scripts === 3 && res.counts.shell === 1, res.counts);
  chk('Python\'s NaN / Infinity pass, and are named in a note', res.notes.some((n) => /data\/py\.json/.test(n)), res.notes);
  chk('a hashbang, a top-level return and require() are a CommonJS file, not an error', !res.problems.some((p) => p.file === 'tools/a.test.js'));
  chk('a commented-out step and `node -e` name no file', !res.problems.some((p) => /commented|missing\.js/.test(p.message)));
}

/* the 2026-10-26 damage, exactly */
{
  const R = repo(Object.assign({}, CLEAN, {
    'lib/q.js': '(function () {\n\n    var lo = 0, hi = 1;\n    return (lo + hi) / 2;\n  }\n  window.Q = { q: q };\n})();\n',
    'data/a.json': '{\n "games": [\n  {\n   "consistent": true,\n\n  }\n ]\n}\n',
  }));
  const res = scan(R);
  const js = res.problems.find((p) => p.file === 'lib/q.js'), json = res.problems.find((p) => p.file === 'data/a.json');
  chk('a function whose header a merge deleted fails, named with its line', !!js && js.kind === 'js-syntax' && js.line === 6, js);
  chk('a dropped JSON line that kept its comma fails, named with its line', !!json && json.kind === 'json-syntax' && json.line === 6, json);
}

/* one way each to break a file */
const broken = {
  'an unresolved conflict in code': ['lib/c.js', 'var a = 1;\n<<<<<<< HEAD\nvar b = 2;\n=======\nvar b = 3;\n>>>>>>> main\n', 'conflict-marker'],
  'an unresolved conflict in a changelog': ['CHANGELOG.md', '# Changelog\n<<<<<<< HEAD\n## a\n=======\n## b\n>>>>>>> origin/main\n', 'conflict-marker'],
  'an unresolved conflict in JSON': ['data/c.json', '{\n<<<<<<< ours\n "a": 1\n=======\n "a": 2\n>>>>>>> theirs\n}\n', 'conflict-marker'],
  'a broken ES module': ['lib/esm.js', 'import fs from "node:fs";\nexport const a = ;\n', 'js-syntax'],
  'a broken .mjs': ['lib/m.mjs', 'export default function f( { return 1; }\n', 'js-syntax'],
  'broken TypeScript': ['supabase/functions/f/index.ts', 'export function f(a: number: number { return a; }\n', 'ts-syntax'],
  'a JSONL line cut short': ['data/l.jsonl', '{"a":1}\n{"a":\n', 'jsonl-syntax'],
  'NaN beside a real error is still an error': ['data/py.json', '{"clv_pts": NaN,}\n', 'json-syntax'],
  'a broken inline script': ['page.html', '<!doctype html>\n<p>x</p>\n<script>\n  var a = ;\n</script>\n', 'html-script'],
  'a broken inline module': ['page.html', '<script type="module">\nexport const = 1;\n</script>\n', 'html-script'],
  'broken ld+json': ['page.html', '<script type="application/ld+json">{"@type": }</script>\n', 'html-json'],
  'a shell script that does not parse': ['sub/run.sh', 'if true; then\necho x\n', 'shell-syntax'],
  'Python that does not compile': ['research/x.py', 'def f(:\n    return 1\n', 'python-syntax'],
  'a workflow that runs a file that is not there': ['.github/workflows/ci.yml', CLEAN['.github/workflows/ci.yml'].replace('node tools/a.test.js', 'node tools/gone.test.js'), 'missing-file'],
  'a workflow that runs an npm script that is not defined': ['.github/workflows/ci.yml', CLEAN['.github/workflows/ci.yml'].replace('npm run -s a:test', 'npm run -s a:tset'), 'missing-npm-script'],
  'a working-directory the file is not in': ['.github/workflows/ci.yml', CLEAN['.github/workflows/ci.yml'].replace('working-directory: sub', 'working-directory: tools'), 'missing-file'],
  'workflow YAML GitHub would refuse': ['.github/workflows/ci.yml', 'name: ci\non:\n  pull_request:\njobs:\n  t:\n    steps:\n      - run: a\n      - run: b\n        run: c\n', 'workflow-yaml'],
  'a package.json script after cd that is not there': ['package.json', CLEAN['package.json'].replace('bash run.sh', 'bash gone.sh'), 'missing-file'],
  'npm --prefix to a script that is not defined': ['package.json', CLEAN['package.json'].replace('web build', 'web bulid'), 'missing-npm-script'],
};
for (const [name, [file, text, kind]] of Object.entries(broken)) {
  const res = scan(repo(Object.assign({}, CLEAN, { [file]: text })));
  if (kind === 'python-syntax' && res.notes.some((n) => /python3 is not available/.test(n))) { console.log('NOTE | python3 is not available: "' + name + '" did NOT run'); continue; }
  const hit = res.problems.find((p) => p.kind === kind && (p.file === file || (kind === 'workflow-yaml' && /ci\.yml/.test(p.file))));
  chk(name + ' fails as ' + kind, !!hit && res.problems.length >= 1, kinds(res));
}
chk('a markdown file that only shows a marker in prose is not a conflict', !scan(repo(CLEAN)).problems.some((p) => p.file === 'docs/notes.md'));

/* the references a command names */
{
  const r = I.references('node --max-old-space-size=6144 tools/x.js --check && npm -s run a:b && cd football/r && bash run_all.sh live && python3 -m v2.learn && node -e "x" && npm run --prefix simulator typecheck');
  const s = r.map((x) => x.kind === 'npm' ? 'npm ' + x.name + '@' + x.prefix : x.via + ' ' + x.path + '@' + x.dir);
  chk('node flags skipped; npm -s; cd moves the base; -m and -e name no file; --prefix is kept',
    JSON.stringify(s) === JSON.stringify(['node tools/x.js@', 'npm a:b@', 'bash run_all.sh@football/r', 'npm typecheck@football/r/simulator']), s);
  chk('after `cd $VAR`, nothing relative is claimed', I.references('cd "$DIR" && node x.js').length === 0);
}

/* KNOWN_INVALID: each listed file must still be invalid */
for (const f of Object.keys(I.KNOWN_INVALID)) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  const bad = /\.json$/.test(f) ? !!I.checkJson(src) && !I.checkJson(src).dialect : !!I.checkScript(src, f);
  chk('KNOWN_INVALID ' + f + ' is still invalid (else take it off the list)', bad);
}

/* the CLI on a real git repository: exit 0 clean, 1 broken, 2 when it cannot run */
{
  const R = repo(CLEAN);
  const g = (args) => execFileSync('git', args, { cwd: R, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });
  g(['init', '-q', '-b', 'main']); g(['add', '-A']); g(['commit', '-q', '-m', 'seed']);
  const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, 'integrity.js'), '--root', R].concat(args || []), { encoding: 'utf8' });
  let r = cli();
  chk('the CLI exits 0 on a clean repository and says ALL GREEN', r.status === 0 && /ALL GREEN repository integrity/.test(r.stdout), r.stdout + r.stderr);
  fs.writeFileSync(path.join(R, 'data/a.json'), '{"a": 1,}\n');
  r = cli();
  chk('the CLI exits 1 on a broken file and names it with its line', r.status === 1 && /FAIL \| data\/a\.json:1 \| json-syntax/.test(r.stdout), r.stdout);
  r = cli(['--changed', '--base', 'main']);
  chk('--changed checks the uncommitted change, and fails on it', r.status === 1 && /data\/a\.json/.test(r.stdout) && /· 1 files ·/.test(r.stdout), r.stdout);
  r = cli(['--changed', '--base', 'no-such-ref']);
  chk('the CLI exits 2 when it cannot run (no such base), and says why', r.status === 2 && /could not run/.test(r.stderr), r.stderr);
  r = cli(['--json']);
  let j = null; try { j = JSON.parse(r.stdout); } catch (e) { j = null; }
  chk('--json is the report as JSON', !!j && Array.isArray(j.problems) && j.problems.length === 1, r.stdout.slice(0, 200));
}

if (fail) { failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? ' | ' + JSON.stringify(f.detail).slice(0, 600) : ''))); console.log('FAILED repository integrity gate — ' + pass + ' passed, ' + fail + ' failed'); process.exitCode = 1; }
else console.log('ALL GREEN repository integrity gate — ' + pass + ' passed, 0 failed');
