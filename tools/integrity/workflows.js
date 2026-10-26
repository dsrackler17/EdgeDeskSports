/* ============================================================================
   EdgeDesk — read the GitHub Actions workflows as data.

   The integrity gate needs three facts the workflow files already state, so it
   reads them from the files instead of keeping a second list that can drift:

     publishers(wf)   every place a job commits to a branch: the paths handed to
                      tools/ci/push_generated.sh, or the pathspecs of a raw
                      `git add` in a job that runs `git push`
     generators(wf)   the scripts a job runs (node / python / bash / npm run)
     triggers(wf)     the `on:` events and whether `push` is limited to main

   No YAML library is installed (package.json has no dependencies), and none is
   needed: workflows here are block-style YAML, and what is read is `run:`
   blocks (block scalars or one-liners) and the `on:` / `concurrency:` maps.
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

function listWorkflows(root) {
  const dir = path.join(root || ROOT, '.github', 'workflows');
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => ({ file: '.github/workflows/' + f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/* `run:` blocks with the line each starts on. A block scalar (`run: |`) runs
   until a non-blank line indented no deeper than the `run:` key. */
function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = lines[i].indexOf('run:');
    const rest = m[2].trim();
    if (/^[|>][-+]?\d*$/.test(rest)) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') { body.push(''); continue; }
        const ind = l.length - l.trimStart().length;
        if (ind <= keyIndent) break;
        body.push(l);
      }
      const minInd = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      out.push({ line: i + 1, script: body.map((l) => l.slice(Number.isFinite(minInd) ? minInd : 0)).join('\n').replace(/\n+$/, '') });
      i = j - 1;
    } else if (rest) {
      out.push({ line: i + 1, script: rest.replace(/^(['"])(.*)\1$/, '$2') });
    }
  }
  return out;
}

/* Join backslash-continued lines; drop comment lines. */
function logicalLines(script) {
  const out = [];
  let cur = '';
  for (const raw of script.split('\n')) {
    const l = raw.replace(/\s+$/, '');
    if (!cur && /^\s*#/.test(l)) continue;
    if (l.endsWith('\\')) { cur += l.slice(0, -1) + ' '; continue; }
    out.push(cur + l);
    cur = '';
  }
  if (cur) out.push(cur);
  return out;
}

/* Shell words, with quotes removed and a flag on each word saying whether
   any part of it was quoted (a quoted glob is a literal, not a glob). */
function shellWords(s) {
  const words = [];
  let cur = null, i = 0;
  const push = () => { if (cur) words.push(cur); cur = null; };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { push(); i++; continue; }
    if (c === '#' && !cur) break;
    if (/[;&|<>()]/.test(c)) { push(); words.push({ text: c, op: true }); i++; continue; }
    cur = cur || { text: '', quoted: false };
    if (c === "'") { const e = s.indexOf("'", i + 1); cur.text += s.slice(i + 1, e < 0 ? s.length : e); cur.quoted = true; i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; }
      cur.text += s.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1'); cur.quoted = true; i = j + 1; continue;
    }
    if (c === '\\') { cur.text += s[i + 1] || ''; i += 2; continue; }
    cur.text += c; i++;
  }
  push();
  return words;
}

/* Simple shell assignments in a script: NAME=value, NAME="a b", NAME=(a b),
   NAME+=(c) and NAME+=" d". Values are kept as their words. */
function assignments(script) {
  const vars = {};
  for (const l of logicalLines(script)) {
    const m = /^\s*(?:export\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/.exec(l);
    if (!m) continue;
    let val = m[3];
    let words;
    if (val.startsWith('(')) words = shellWords(val.slice(1, val.lastIndexOf(')') < 0 ? undefined : val.lastIndexOf(')')));
    else words = shellWords(val).slice(0, 1).flatMap((w) => (w.quoted ? shellWords(w.text) : [w]));
    words = words.filter((w) => !w.op);
    vars[m[1]] = m[2] ? (vars[m[1]] || []).concat(words) : words;
  }
  return vars;
}

const VAR_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)(\[@\]|\[\*\])?\}?$/;

/* Expand $VAR / ${VAR} / ${ARR[@]} words from the script's own assignments.
   Anything else carrying a $ (a ${{ }} expression, a command substitution)
   cannot be read statically and is returned in `unresolved`. */
function expandWords(words, vars, depth) {
  const out = [], unresolved = [];
  for (const w of words) {
    const m = VAR_RE.exec(w.text);
    if (m && vars[m[1]] && (depth || 0) < 4) {
      const r = expandWords(vars[m[1]], vars, (depth || 0) + 1);
      out.push(...r.words); unresolved.push(...r.unresolved);
    } else if (/\$/.test(w.text)) unresolved.push(w.text);
    else out.push(w);
  }
  return { words: out, unresolved };
}

/* A path word with a variable inside it (research/clv/openers/$SPORT/x.jsonl)
   is read as a glob over that segment: the job may write any value there. */
function pathWord(w) {
  const text = w.text.replace(/\/+$/, '');
  if (/\$/.test(text) && !VAR_RE.test(text)) {
    return { text: text.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '*'), glob: true };
  }
  return { text, glob: !w.quoted && /[*?[]/.test(text) };
}

/* PUSH_MERGE_PATHS: paths a job patches in place that are SOURCE (app.html),
   set in a step's `env:` map or inline. Read workflow-wide. */
function mergePathsOf(text) {
  const out = [];
  const re = /PUSH_MERGE_PATHS[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s#]+)/g;
  let m;
  while ((m = re.exec(text))) out.push(...m[1].replace(/^['"]|['"]$/g, '').split(/\s+/).filter(Boolean));
  return [...new Set(out)];
}

/* Every commit a workflow makes to a branch, as the paths it names. */
function publishers(wf) {
  const found = [];
  const blocks = runBlocks(wf.text);
  const pushesRaw = blocks.some((b) => logicalLines(b.script).some((l) => /(^|[\s;&|(])git\s+push\b/.test(l)));
  const mergePaths = mergePathsOf(wf.text);
  for (const b of blocks) {
    const vars = assignments(b.script);
    for (const l of logicalLines(b.script)) {
      const words = shellWords(l);
      const at = words.findIndex((w) => /(^|\/)push_generated\.sh$/.test(w.text));
      if (at >= 0 && !/^\s*#/.test(l)) {
        const dd = words.findIndex((w, k) => k > at && w.text === '--' && !w.op);
        if (dd < 0) continue;
        const end = words.findIndex((w, k) => k > dd && w.op);
        const raw = words.slice(dd + 1, end < 0 ? undefined : end);
        const ex = expandWords(raw, vars);
        found.push({ workflow: wf.file, line: b.line, via: 'push_generated', branch: (words[at + 1] || {}).text || '',
          paths: ex.words.concat(ex.unresolved.map((t) => ({ text: t, quoted: false }))).map(pathWord).filter((p) => !/\$/.test(p.text)),
          unresolved: ex.unresolved.filter((t) => VAR_RE.test(t) || /\$\{\{|\$\(/.test(t)), mergePaths });
        continue;
      }
      if (!pushesRaw) continue;
      const ga = words.findIndex((w, k) => w.text === 'git' && (words[k + 1] || {}).text === 'add');
      if (ga >= 0) {
        const end = words.findIndex((w, k) => k > ga + 1 && w.op);
        const raw = words.slice(ga + 2, end < 0 ? undefined : end).filter((w) => !/^-/.test(w.text));
        const ex = expandWords(raw, vars);
        found.push({ workflow: wf.file, line: b.line, via: 'git add', branch: '',
          paths: ex.words.concat(ex.unresolved.map((t) => ({ text: t, quoted: false }))).map(pathWord).filter((p) => !/\$/.test(p.text)),
          unresolved: ex.unresolved.filter((t) => VAR_RE.test(t) || /\$\{\{|\$\(/.test(t)), mergePaths });
      }
    }
  }
  return found;
}

/* Scripts a workflow runs: `node x.js`, `python3 x.py`, `bash x.sh`,
   `deno run ... x.ts` and `npm run [-s] name` (followed into package.json). */
function generators(wf, root) {
  root = root || ROOT;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {}; } catch (e) { pkg = {}; }
  const out = new Set();
  const fromCommand = (cmd, depth) => {
    for (const l of logicalLines(cmd)) {
      const words = shellWords(l).filter((w) => !w.op).map((w) => w.text);
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        if (/^(node|python3?|bash|sh|deno|tsx|ts-node)$/.test(w)) {
          for (let j = k + 1; j < words.length; j++) {
            const a = words[j];
            if (a === 'run' && w === 'deno') continue;
            if (/^-/.test(a)) continue;
            if (/\.(js|mjs|cjs|ts|py|sh)$/.test(a) && fs.existsSync(path.join(root, a))) out.add(path.normalize(a));
            break;
          }
        } else if (/(^|\/)[\w.-]+\.(sh|py|js)$/.test(w) && k === 0 && fs.existsSync(path.join(root, w))) {
          out.add(path.normalize(w.replace(/^\.\//, '')));
        } else if (w === 'npm' && words[k + 1] === 'run' && depth < 4) {
          const name = words.slice(k + 2).find((a) => !/^-/.test(a));
          if (name && pkg[name]) fromCommand(pkg[name], depth + 1);
        }
      }
    }
  };
  for (const b of runBlocks(wf.text)) fromCommand(b.script, 0);
  return [...out].sort();
}

/* The `on:` block, read as event names, plus whether `push` is restricted to
   main and whether `pull_request` / `push` carry path filters. */
function triggers(wf) {
  const lines = wf.text.split('\n');
  const start = lines.findIndex((l) => /^(on|"on"|'on'):\s*(.*)$/.test(l));
  const res = { events: [], pushBranches: null, pushPaths: false, prPaths: false };
  if (start < 0) return res;
  const inline = /^(?:on|"on"|'on'):\s*(.+)$/.exec(lines[start]);
  if (inline && inline[1].trim()) {
    res.events = inline[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    return res;
  }
  let ev = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    const top = /^ {2}([a-z_]+):/.exec(l);
    if (top) { ev = top[1]; res.events.push(ev); continue; }
    if (ev === 'push' && /^\s+branches:\s*\[(.*)\]/.test(l)) res.pushBranches = /^\s+branches:\s*\[(.*)\]/.exec(l)[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    if (ev === 'push' && /^\s+branches:\s*$/.test(l)) {
      res.pushBranches = [];
      for (let j = i + 1; j < lines.length && /^\s+-\s/.test(lines[j]); j++) res.pushBranches.push(lines[j].replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
    }
    if (ev === 'push' && /^\s+paths(-ignore)?:/.test(l)) res.pushPaths = true;
    if ((ev === 'pull_request' || ev === 'pull_request_target') && /^\s+paths(-ignore)?:/.test(l)) res.prPaths = true;
  }
  return res;
}

/* Concurrency blocks (workflow-level and job-level) as raw group/cancel text. */
function concurrency(wf) {
  const lines = wf.text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)concurrency:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length;
    const block = { line: i + 1, level: ind === 0 ? 'workflow' : 'job', group: m[2].trim() || null, cancel: null };
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (l.length - l.trimStart().length <= ind) break;
      const g = /^\s+group:\s*(.*)$/.exec(l); if (g) block.group = g[1].trim();
      const c = /^\s+cancel-in-progress:\s*(.*)$/.exec(l); if (c) block.cancel = c[1].trim();
    }
    out.push(block);
  }
  return out;
}

module.exports = { ROOT, WF_DIR, listWorkflows, runBlocks, logicalLines, shellWords, assignments, expandWords, pathWord, mergePathsOf, publishers, generators, triggers, concurrency };
