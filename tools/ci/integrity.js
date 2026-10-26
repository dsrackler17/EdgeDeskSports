#!/usr/bin/env node
'use strict';
/* ===========================================================================
   THE REPOSITORY STILL PARSES — every tracked file, on every pull request.

   2026-10-26 12:47 UTC: #800's "Update branch" merge (2ad15afadd) resolved two
   conflicts in GitHub's web editor and was merged ten seconds later, before
   any check had reported. It left lib/edgedesk_quote_ev.js unparseable
   (SyntaxError, line 833) and football/cfb_validation/slate_audit.json not
   JSON. On main, the app loads the module behind a .catch(), so the board's
   quote-level EV went dark without an error; in CI, seven workflows failed on
   the pull request and four more on main and on #803, each naming its own
   suite, none naming the file. One cheap check, run on every pull request
   with no path filter, fails in seconds and names the file and line:

     1  every .js / .cjs parses as a script (CommonJS), or as an ES module
        when it is one; every .mjs as a module; every .ts / .mts once its
        types are stripped
     2  every .json parses; every .jsonl / .ndjson line parses
     3  every inline <script> in a tracked .html parses (classic, module, or
        JSON for ld+json / importmap)
     4  no tracked text file holds a merge-conflict marker line
     5  every shell script passes `bash -n`; every .py compiles (when python3
        is on the machine — said, never assumed)
     6  every file a workflow step or a package.json script runs
        (node / bash / sh / python <path>) exists, and every `npm run <name>`
        names a script package.json defines

   Static and offline; writes nothing. A file that is invalid ON PURPOSE (a
   fixture a parser must refuse) is listed in KNOWN_INVALID with its reason,
   and integrity.test.js fails if a listed file ever becomes valid.

   Run:  node tools/ci/integrity.js                 every tracked file
         node tools/ci/integrity.js --changed       only files changed vs origin/main
         node tools/ci/integrity.js --root <dir>    another checkout (an old commit)
         node tools/ci/integrity.js --json          the report as JSON
   Exit 0 clean, 1 problems found, 2 the scan itself could not run.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const W = require('./workflows.js');

/* files that are invalid on purpose; each must still be invalid (integrity.test.js) */
const KNOWN_INVALID = {};

const BINARY = /\.(gz|zip|parquet|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|eot|mp[34]|wav|ogg|avif|bin|sqlite|db|pkl|npy|npz|feather|arrow|xlsx?|docx?|pptx?|psd|svgz)$/i;
const MARKER = /^(<{7}|>{7}|\|{7})(?: |$)/m;

function trackedFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('git ls-files failed in ' + root + ': ' + String(r.stderr));
  return String(r.stdout).split('\0').filter(Boolean);
}
function changedFiles(root, base) {
  const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: root });
  if (mb.status !== 0) throw new Error('no merge base with ' + base + ' (fetch it: git fetch origin main)');
  const sha = String(mb.stdout).trim();
  const a = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', sha], { cwd: root, maxBuffer: 1 << 26 });
  const b = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1 << 26 });
  return Array.from(new Set(String(a.stdout).split('\0').concat(String(b.stdout).split('\0')).filter(Boolean)));
}

/* "file:LINE" from a V8 SyntaxError raised while compiling `filename` */
function lineOf(err, filename) {
  const st = String(err && err.stack || '');
  const k = st.indexOf(filename + ':');
  if (k >= 0) { const m = /^:(\d+)/.exec(st.slice(k + filename.length)); if (m) return Number(m[1]); }
  return null;
}
const looksModule = (src) => /^\s*(import\s*[\w*{'"]|export\s+(default|const|let|var|function|async|class|\{|\*))/m.test(src);
const stripHashbang = (src) => (src.startsWith('#!') ? '//' + src.slice(2) : src);

function checkScript(src, file) {
  try { vm.compileFunction(stripHashbang(src), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file }); return null; }
  catch (e) { return { line: lineOf(e, file), message: String(e.message) }; }
}
/* Python's json.dump writes NaN / Infinity / -Infinity unless told not to;
   Python reads them back. Such a file is the generator's dialect, not a broken
   merge, so it passes as { dialect: 'python' } — anything else wrong still fails */
function pythonDialect(src) {
  let out = '', q = false, any = false;
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    if (q) { out += c; if (c === '\\') { out += src[++k] || ''; } else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; out += c; continue; }
    const m = /^(-?Infinity|NaN)/.exec(src.slice(k, k + 9));
    if (m && !/[\w.]/.test(src[k - 1] || ' ')) { out += 'null'; k += m[1].length - 1; any = true; continue; }
    out += c;
  }
  return any ? out : null;
}
function checkJson(src) {
  try { JSON.parse(src); return null; }
  catch (e) {
    const alt = pythonDialect(src);
    if (alt != null) { try { JSON.parse(alt); return { dialect: 'python' }; } catch (e2) { /* broken in its own right */ } }
    const m = /line (\d+) column (\d+)/.exec(e.message) || null;
    let line = m ? Number(m[1]) : null;
    if (line == null) { const p = /position (\d+)/.exec(e.message); if (p) line = src.slice(0, Number(p[1])).split('\n').length; }
    return { line, message: String(e.message).split('\n')[0] };
  }
}
/* the inline scripts of an HTML page, the way a browser cuts them out */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const t = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = t ? t[1].toLowerCase() : '';
    const kind = !type || /^(text|application)\/(java|ecma)script$/.test(type) ? 'script'
      : type === 'module' ? 'module' : (type === 'application/ld+json' || type === 'importmap' || type === 'application/json') ? 'json' : null;
    if (!kind || !m[2].trim()) continue;
    const startLine = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
    out.push({ kind, code: m[2], startLine });
  }
  return out;
}

/* ES modules and TypeScript need vm.SourceTextModule, which Node keeps behind
   --experimental-vm-modules: one child process checks all of them */
function moduleWorker() {
  const jobs = JSON.parse(fs.readFileSync(0, 'utf8'));
  const Mod = require('module');
  const res = jobs.map((j) => {
    let code = j.code;
    try {
      if (j.ts) {
        try { code = Mod.stripTypeScriptTypes(code, { mode: 'strip' }); }
        catch (e) { code = Mod.stripTypeScriptTypes(code, { mode: 'transform' }); }
      }
      new vm.SourceTextModule(stripHashbang(code), { identifier: j.file });
      return null;
    } catch (e) { return { line: lineOf(e, j.file), message: String(e.message) }; }
  });
  process.stdout.write(JSON.stringify(res));
}
function checkModules(jobs) {
  if (!jobs.length) return [];
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename, '--module-worker'],
    { input: JSON.stringify(jobs), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('the module parser could not run: ' + String(r.stderr).slice(0, 600));
  return JSON.parse(String(r.stdout));
}

/* every command a step or script runs, and the files and npm scripts it names.
   `cd <dir>` moves where later relative paths resolve (dir: on each ref);
   `npm --prefix <dir>` reads <dir>/package.json (prefix: on the ref) */
function references(script) {
  const refs = [];
  const text = String(script).split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
  const toks = text.split(/[\s;&|()`]+/).filter(Boolean);
  let dir = '';
  const unq = (s) => s.replace(/^['"]|['"]$/g, '');
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === 'cd') {
      const d = unq(toks[k + 1] || '');
      dir = !d || /[$~]/.test(d) || d.startsWith('/') ? null : path.posix.normalize(path.posix.join(dir == null ? '' : dir, d));
      k++;
    } else if (dir === null) continue;                   /* after `cd $SOMEWHERE` nothing relative can be checked */
    else if (/^(node|bash|sh|python3?)$/.test(t)) {
      let j = k + 1;
      if (t === 'node') { while (j < toks.length && /^-/.test(toks[j])) { if (/^(-e|--eval|-p|--print|-|--input-type.*|-r|--require|--test)$/.test(toks[j])) { j = -1; break; } j++; } }
      else { while (j < toks.length && /^-/.test(toks[j])) { if (/^(-c|-m|-)$/.test(toks[j])) { j = -1; break; } j++; } }
      if (j < 0 || j >= toks.length) continue;
      const p = unq(toks[j]);
      const ext = t === 'node' ? /\.(m?js|cjs)$/ : /^python/.test(t) ? /\.py$/ : /\.sh$/;
      if (ext.test(p) && !/[$*{}<>]/.test(p)) refs.push({ kind: 'file', via: t, path: p, dir });
    } else if (t === 'npm') {
      let j = k + 1, prefix = '';
      const flags = () => { while (j < toks.length && /^-/.test(toks[j])) { if (toks[j] === '--prefix' || toks[j] === '-C') { prefix = unq(toks[j + 1] || ''); j += 2; } else if (/^--prefix=/.test(toks[j])) { prefix = toks[j].slice(9); j++; } else j++; } };
      flags();
      if (toks[j] === 'run' || toks[j] === 'run-script') {
        j++;
        flags();
        if (j < toks.length && !/[$]/.test(toks[j])) refs.push({ kind: 'npm', name: unq(toks[j]), prefix: dir || prefix ? path.posix.join(dir, prefix) : '', dir });
      } else if (toks[j] === 'test' || toks[j] === 't' || toks[j] === 'start') refs.push({ kind: 'npm', name: toks[j] === 't' ? 'test' : toks[j], prefix: dir || prefix ? path.posix.join(dir, prefix) : '', dir });
    }
  }
  return refs;
}

function scan(opts) {
  const o = opts || {};
  const root = path.resolve(o.root || path.join(__dirname, '..', '..'));
  const all = o.files || trackedFiles(root);
  const tracked = new Set(all);
  const only = o.only ? new Set(o.only.filter((f) => tracked.has(f) || fs.existsSync(path.join(root, f)))) : null;
  const files = only ? all.filter((f) => only.has(f)).concat(Array.from(only).filter((f) => !tracked.has(f))) : all;
  const problems = [];
  const counts = { js: 0, module: 0, ts: 0, json: 0, jsonl_lines: 0, html_scripts: 0, text: 0, shell: 0, python: 0, workflow_refs: 0, script_refs: 0 };
  const notes = [];
  const add = (file, kind, line, message) => { if (KNOWN_INVALID[file]) return; problems.push({ file, kind, line: line || null, message }); };
  const modJobs = [];
  const shells = [], pys = [], pyJson = [];

  for (const f of files) {
    if (BINARY.test(f)) continue;
    const abs = path.join(root, f);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { continue; }          /* deleted in the working tree */
    if (!st.isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) continue;                /* binary, whatever its name */
    const src = buf.toString('utf8');
    counts.text++;
    const mk = MARKER.exec(src);
    if (mk && !/\.(md|txt)$/.test(f) || mk && /^<{7} \S/m.test(src) && /^>{7} \S/m.test(src)) {
      add(f, 'conflict-marker', src.slice(0, mk.index).split('\n').length, 'a merge-conflict marker line (' + mk[1] + ') — the conflict was committed unresolved');
    }
    const ext = (/\.([^./]+)$/.exec(f) || [])[1];
    if (ext === 'js' || ext === 'cjs') {
      counts.js++;
      const e = checkScript(src, f);
      if (e) { if (ext === 'js' && looksModule(src)) modJobs.push({ file: f, code: src, kind: 'module' }); else add(f, 'js-syntax', e.line, e.message); }
    } else if (ext === 'mjs') { counts.module++; modJobs.push({ file: f, code: src, kind: 'module' }); }
    else if (ext === 'ts' || ext === 'mts') { counts.ts++; modJobs.push({ file: f, code: src, kind: 'ts', ts: true }); }
    else if (ext === 'json' || ext === 'geojson' || ext === 'webmanifest') {
      counts.json++;
      const e = checkJson(src);
      if (e && e.dialect) pyJson.push(f);
      else if (e) add(f, 'json-syntax', e.line, e.message);
    } else if (ext === 'jsonl' || ext === 'ndjson') {
      const lines = src.split('\n');
      for (let k = 0; k < lines.length; k++) {
        if (!lines[k].trim()) continue;
        counts.jsonl_lines++;
        const e = checkJson(lines[k]);
        if (e && e.dialect) { if (pyJson[pyJson.length - 1] !== f) pyJson.push(f); }
        else if (e) { add(f, 'jsonl-syntax', k + 1, e.message); break; }
      }
    } else if (ext === 'html' || ext === 'htm') {
      for (const s of inlineScripts(src)) {
        counts.html_scripts++;
        const id = f + '#script@' + s.startLine;
        if (s.kind === 'json') { const e = checkJson(s.code); if (e) add(f, 'html-json', s.startLine + (e.line || 1) - 1, e.message); }
        else if (s.kind === 'module') modJobs.push({ file: f, code: s.code, kind: 'html-module', startLine: s.startLine, id });
        else {
          try { new vm.Script(s.code, { filename: id }); }
          catch (e) { const ln = lineOf(e, id); add(f, 'html-script', ln != null ? s.startLine + ln - 1 : s.startLine, String(e.message)); }
        }
      }
    } else if (ext === 'sh') shells.push(f);
    else if (ext === 'py') pys.push(f);
  }

  if (pyJson.length) notes.push(pyJson.length + ' JSON file' + (pyJson.length === 1 ? '' : 's') + ' use Python\'s NaN/Infinity (json.dump without allow_nan=False); valid for Python readers, not for JSON.parse: '
    + pyJson.slice(0, 3).join(', ') + (pyJson.length > 3 ? ' …' : ''));

  /* ES modules and TypeScript, in one child */
  const res = checkModules(modJobs.map((j) => ({ file: j.id || j.file, code: j.code, ts: !!j.ts })));
  modJobs.forEach((j, k) => {
    if (j.kind === 'module' && /\.js$/.test(j.file)) counts.module++;
    const e = res[k];
    if (!e) return;
    if (j.kind === 'html-module') add(j.file, 'html-script', j.startLine + (e.line || 1) - 1, e.message);
    else add(j.file, j.kind === 'ts' ? 'ts-syntax' : 'js-syntax', e.line, e.message);
  });

  /* shell */
  for (const f of shells) {
    counts.shell++;
    const r = spawnSync('bash', ['-n', f], { cwd: root });
    if (r.status !== 0) add(f, 'shell-syntax', (/line (\d+)/.exec(String(r.stderr)) || [])[1], String(r.stderr).trim().split('\n')[0]);
  }
  /* python, when there is one: compiled in memory, nothing written */
  if (pys.length) {
    const py = spawnSync('python3', ['-I', '-c', [
      'import sys, json',
      'out = []',
      'for f in json.load(sys.stdin):',
      '    try:',
      '        compile(open(f, "rb").read(), f, "exec", dont_inherit=True)',
      '    except SyntaxError as e:',
      '        out.append([f, e.lineno, e.msg])',
      'print(json.dumps(out))'].join('\n')], { cwd: root, input: JSON.stringify(pys), maxBuffer: 1 << 26 });
    if (py.error || py.status !== 0) notes.push('python3 is not available here: ' + pys.length + ' .py files were NOT checked');
    else { counts.python = pys.length; for (const [f, ln, msg] of JSON.parse(String(py.stdout))) add(f, 'python-syntax', ln, msg); }
  }

  /* 6. what the workflows and package.json run exists */
  const exists = (p) => tracked.has(p) || fs.existsSync(path.join(root, p));
  const pkgs = {};
  const scriptsAt = (dir) => {
    const d = path.posix.normalize(dir || '.');
    if (!(d in pkgs)) { try { pkgs[d] = JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8')).scripts || {}; } catch (e) { pkgs[d] = null; } }
    return pkgs[d];
  };
  const hasScript = (r) => { const s = scriptsAt(r.prefix); return !!s && Object.prototype.hasOwnProperty.call(s, r.name); };
  const npmWhere = (r) => (r.prefix && path.posix.normalize(r.prefix) !== '.' ? r.prefix + '/package.json' : 'package.json');
  const scripts = scriptsAt('.') || {};
  const wfSelected = !only || Array.from(only).some((f) => /^\.github\/workflows\//.test(f) || f === 'package.json')
    || files.some((f) => /\.(m?js|cjs|sh|py)$/.test(f));
  if (wfSelected) {
    let wfs = [];
    try { wfs = W.loadWorkflows(root); }
    catch (e) { add('.github/workflows', 'workflow-yaml', null, String(e.message)); }
    const wfFiles = fs.readdirSync(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
    for (const f of wfFiles) {
      try { W.parseYaml(fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8')); }
      catch (e) { add('.github/workflows/' + f, 'workflow-yaml', e.yamlLine != null ? e.yamlLine + 1 : null, String(e.message)); }
    }
    for (const wf of wfs) {
      if (!wf.doc || typeof wf.doc !== 'object' || !wf.doc.jobs) { add(wf.file, 'workflow-shape', null, 'no jobs: mapping'); continue; }
      if (!Object.keys(wf.on).length) add(wf.file, 'workflow-shape', null, 'no on: trigger');
      for (const [jid, job] of Object.entries(wf.doc.jobs)) {
        if (!job || (!job.steps && !job.uses)) { add(wf.file, 'workflow-shape', null, 'job ' + jid + ' has neither steps nor uses'); continue; }
        for (const st of job.steps || []) {
          if (!st || st.run == null) continue;
          const wd = st['working-directory'] || (job.defaults && job.defaults.run && job.defaults.run['working-directory']) || '';
          for (const r of references(st.run)) {
            counts.workflow_refs++;
            if (r.kind === 'npm') {
              const at = Object.assign({}, r, { prefix: path.posix.join(wd, r.prefix || '') });
              if (!hasScript(at)) add(wf.file, 'missing-npm-script', null, 'job ' + jid + ' runs `npm run ' + r.name + '`, which ' + npmWhere(at) + ' does not define');
            } else {
              const p = path.posix.normalize(path.posix.join(wd, r.dir || '', r.path));
              if (!exists(p)) add(wf.file, 'missing-file', null, 'job ' + jid + ' runs `' + r.via + ' ' + r.path + '`' + (wd || r.dir ? ' in ' + path.posix.join(wd, r.dir || '') : '') + ', which does not exist');
            }
          }
        }
      }
    }
    for (const [name, cmd] of Object.entries(scripts)) {
      for (const r of references(cmd)) {
        counts.script_refs++;
        if (r.kind === 'npm') { if (!hasScript(r)) add('package.json', 'missing-npm-script', null, 'script "' + name + '" runs `npm run ' + r.name + '`, which ' + npmWhere(r) + ' does not define'); }
        else if (!exists(path.posix.normalize(path.posix.join(r.dir || '', r.path)))) add('package.json', 'missing-file', null, 'script "' + name + '" runs `' + r.via + ' ' + r.path + '`' + (r.dir ? ' in ' + r.dir : '') + ', which does not exist');
      }
    }
  }
  return { root, files: files.length, counts, problems, notes };
}

function report(res) {
  const c = res.counts;
  const lines = [];
  lines.push('repository integrity · ' + res.files + ' files · ' + c.js + ' js, ' + c.module + ' modules, ' + c.ts + ' ts, ' + c.json + ' json, ' + c.jsonl_lines + ' jsonl lines, '
    + c.html_scripts + ' inline scripts, ' + c.shell + ' sh, ' + c.python + ' py, ' + c.workflow_refs + ' workflow + ' + c.script_refs + ' package.json references');
  for (const n of res.notes) lines.push('NOTE | ' + n);
  for (const p of res.problems) lines.push('FAIL | ' + p.file + (p.line ? ':' + p.line : '') + ' | ' + p.kind + ' | ' + p.message);
  lines.push(res.problems.length ? 'FAILED repository integrity — ' + res.problems.length + ' problem' + (res.problems.length === 1 ? '' : 's') : 'ALL GREEN repository integrity — 0 problems');
  return lines.join('\n');
}

if (require.main === module) {
  if (process.argv.includes('--module-worker')) { moduleWorker(); return; }
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  try {
    const root = path.resolve(arg('--root') || path.join(__dirname, '..', '..'));
    const only = process.argv.includes('--changed') ? changedFiles(root, arg('--base') || 'origin/main') : null;
    const res = scan({ root, only });
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    else console.log(report(res));
    process.exitCode = res.problems.length ? 1 : 0;
  } catch (e) {
    console.error('repository integrity could not run: ' + (e && e.stack || e));
    process.exitCode = 2;
  }
}

module.exports = { scan, report, references, inlineScripts, checkJson, checkScript, trackedFiles, changedFiles, KNOWN_INVALID, MARKER };
