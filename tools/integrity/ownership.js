#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — which tracked files are GENERATED, and which job owns them.

   The scheduled jobs publish their artifacts to main through
   tools/ci/push_generated.sh (or a raw `git add` + `git push`). The paths a
   job hands to that commit are the paths it owns. This module reads them from
   .github/workflows (tools/integrity/workflows.js), so a new job's outputs are
   owned the moment its workflow names them; there is no second list.

   A pull request that rewrites a bot-owned file collides with that bot, which
   rewrites it again within the hour: that is where most of the hand-resolved
   conflicts on main come from (#800's slate_audit.json, and its accidental
   football/venues/forecasts.json, which a local test run had rewritten).

   THE RULE (enforced by tools/integrity/gate.js on every pull request):
     a bot-owned file may change in a pull request only when the same pull
     request changes the code that produces it: the owning workflow, a script
     the workflow runs, or a file those scripts load (followed through
     require() / path.join literals, and Python imports beside the script).
   Anything else is an accidental commit of a job's output. The override is
   the `generated-files-ok` label: a person's deliberate, visible decision.

   Classification of a path:
     source      not named by any publishing job (hand-written; review as code)
     generated   inside a job's published paths and not source by extension,
                 or named by the job exactly (football/venues/descriptions.js)
     merge-source  named in PUSH_MERGE_PATHS: source that a job patches in
                 place (app.html); never treated as generated

     node tools/integrity/ownership.js --list            owned paths per job
     node tools/integrity/ownership.js <path>...         classify paths
     node tools/integrity/ownership.js --explain <path>  which changes justify it
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./workflows');

const ROOT = W.ROOT;

/* Inside a published directory these are code, not artifacts: build.js and
   tests.js live beside the JSON they write. A job that publishes a code file
   names it exactly, and then it is generated. */
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.sql', '.psql', '.yml', '.yaml', '.css', '.toml', '.r', '.ipynb']);
/* Hand-written notes that sit inside published directories. */
const SOURCE_NAMES = /^(README|METHODOLOGY|NOTES|CONTRIBUTING|LICENSE)(\.[a-z]+)?$/i;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const e = glob.indexOf(']', i); re += e > i ? glob.slice(i, e + 1) : '\\['; i = e > i ? e : i; }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function isPrBranch(branch) {
  return /HEAD_REF|head_ref|head\.ref/.test(branch);
}

let CACHE = null;
function model(root) {
  root = root || ROOT;
  if (CACHE && CACHE.root === root) return CACHE;
  const workflows = W.listWorkflows(root);
  const entries = [];       // { workflow, text, kind: dir|file|glob, re?, intoPr }
  const merge = new Set();
  const byWorkflow = {};
  for (const wf of workflows) {
    const pubs = W.publishers(wf);
    if (!pubs.length) continue;
    byWorkflow[wf.file] = { publishes: pubs, triggers: W.triggers(wf), text: wf.text };
    for (const p of pubs) {
      p.mergePaths.forEach((m) => merge.add(m));
      for (const t of p.paths) {
        if (!t.text || t.text === '.' || t.text === '-A') continue;
        let kind;
        if (t.glob) kind = 'glob';
        else {
          const abs = path.join(root, t.text);
          let st = null;
          try { st = fs.statSync(abs); } catch (e) { st = null; }
          kind = st ? (st.isDirectory() ? 'dir' : 'file') : (/\.[A-Za-z0-9]+$/.test(t.text) ? 'file' : 'dir');
        }
        entries.push({ workflow: wf.file, text: t.text, kind, re: kind === 'glob' ? globToRegExp(t.text) : null, intoPr: isPrBranch(p.branch) });
      }
    }
  }
  CACHE = { root, entries, merge, byWorkflow, closures: {} };
  return CACHE;
}

/* Which jobs own `rel`, and whether it is generated, source or merge-source. */
function classify(rel, root) {
  const m = model(root);
  rel = rel.replace(/^\.\//, '');
  if (m.merge.has(rel)) return { class: 'merge-source', owners: [] };
  const owners = new Set();
  const ext = path.extname(rel).toLowerCase();
  const base = path.basename(rel);
  for (const e of m.entries) {
    if (e.kind === 'file' && rel === e.text) owners.add(e.workflow);
    else if (e.kind === 'glob' && e.re.test(rel)) owners.add(e.workflow);
    else if (e.kind === 'dir' && rel.startsWith(e.text + '/') && !SOURCE_EXT.has(ext) && !SOURCE_NAMES.test(base)) owners.add(e.workflow);
  }
  return owners.size ? { class: 'generated', owners: [...owners].sort() } : { class: 'source', owners: [] };
}

/* ---- the code behind a job: its scripts and what they load ---------------- */

const REQ_RE = /require\(\s*(['"`])([^'"`]+)\1\s*\)/g;
const BASE_DEF_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]*\3)*)\s*\)/g;
const JOIN_RE = /path\.(?:join|resolve)\(\s*(__dirname|[A-Za-z_$][\w$]*)((?:\s*,\s*(['"])[^'"]*\3)+)\s*\)/g;
const LIT_RE = /(['"])([^'"]*)\1/g;

function lits(s) { const out = []; let m; LIT_RE.lastIndex = 0; while ((m = LIT_RE.exec(s))) out.push(m[2]); return out; }

function jsDeps(rel, root) {
  const abs = path.join(root, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  const dir = path.dirname(rel);
  const bases = { __dirname: dir };
  let m;
  BASE_DEF_RE.lastIndex = 0;
  while ((m = BASE_DEF_RE.exec(src))) bases[m[1]] = path.normalize(path.join(dir, ...lits(m[2] || '')));
  const out = new Set();
  const add = (p) => {
    const n = path.normalize(p);
    if (n.startsWith('..')) return;
    for (const cand of [n, n + '.js', path.join(n, 'index.js')]) {
      try { if (fs.statSync(path.join(root, cand)).isFile()) { out.add(cand); return; } } catch (e) { /* next */ }
    }
  };
  REQ_RE.lastIndex = 0;
  while ((m = REQ_RE.exec(src))) if (/^\.\.?\//.test(m[2])) add(path.join(dir, m[2]));
  JOIN_RE.lastIndex = 0;
  while ((m = JOIN_RE.exec(src))) {
    const b = bases[m[1]];
    if (b == null) continue;
    const p = path.join(b, ...lits(m[2]));
    if (/\.(js|mjs|cjs)$/.test(p)) add(p);
  }
  return [...out];
}

function pyDeps(rel, root) {
  let src;
  try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { return []; }
  const dir = path.dirname(rel);
  const out = new Set();
  const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  let m;
  while ((m = re.exec(src))) {
    const mod = (m[1] || m[2]).replace(/^\.+/, '');
    if (!mod) continue;
    const parts = mod.split('.');
    for (const cand of [path.join(dir, ...parts) + '.py', path.join(...parts) + '.py', path.join(dir, ...parts, '__init__.py')]) {
      try { if (fs.statSync(path.join(root, cand)).isFile()) { out.add(path.normalize(cand)); break; } } catch (e) { /* next */ }
    }
  }
  return [...out];
}

/* The workflow file, every script it runs, and (to depth 8) what they load. */
function generatorClosure(workflow, root) {
  root = root || ROOT;
  const m = model(root);
  if (m.closures[workflow]) return m.closures[workflow];
  const wf = { file: workflow, text: (m.byWorkflow[workflow] || {}).text || '' };
  const seen = new Set([workflow]);
  let frontier = W.generators(wf, root);
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      if (seen.has(f)) continue;
      seen.add(f);
      const deps = /\.py$/.test(f) ? pyDeps(f, root) : /\.(js|mjs|cjs)$/.test(f) ? jsDeps(f, root) : [];
      next.push(...deps);
    }
    frontier = next;
  }
  m.closures[workflow] = seen;
  return seen;
}

/* A job that commits into pull-request branches (simulator feeds) runs
   because the PR touched its `paths:`; such a PR is where its output belongs. */
function prPathRegexps(workflow, root) {
  const m = model(root);
  const info = m.byWorkflow[workflow];
  if (!info) return [];
  const lines = info.text.split('\n');
  const out = [];
  let inPr = false, inPaths = false;
  for (const l of lines) {
    if (/^ {2}[a-z_]+:/.test(l)) { inPr = /^ {2}pull_request:/.test(l); inPaths = false; continue; }
    if (!/^\s/.test(l)) { inPr = false; inPaths = false; continue; }
    if (inPr && /^\s+paths:\s*$/.test(l)) { inPaths = true; continue; }
    if (inPr && inPaths) {
      const mm = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(l);
      if (mm) out.push(globToRegExp(mm[1].trim()));
      else if (!/^\s*$/.test(l)) inPaths = false;
    }
  }
  return out;
}

/* Is a change to generated `rel` justified by the other files the PR changed? */
function explained(rel, changed, root) {
  const c = classify(rel, root);
  if (c.class !== 'generated') return { ok: true, why: c.class };
  for (const wf of c.owners) {
    const clo = generatorClosure(wf, root);
    const hit = changed.find((f) => f !== rel && clo.has(f));
    if (hit) return { ok: true, why: 'its generator changed: ' + hit + ' (' + wf + ')' };
    const pubs = (model(root).byWorkflow[wf] || {}).publishes || [];
    if (pubs.some((p) => isPrBranch(p.branch))) {
      const res = prPathRegexps(wf, root);
      const h2 = changed.find((f) => f !== rel && classify(f, root).class !== 'generated' && res.some((re) => re.test(f)));
      if (h2) return { ok: true, why: 'the job that commits it into pull requests runs on ' + h2 + ' (' + wf + ')' };
    }
  }
  return { ok: false, owners: c.owners };
}

function resetCache() { CACHE = null; }

module.exports = { classify, explained, generatorClosure, model, globToRegExp, resetCache, SOURCE_EXT };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    const m = model();
    const by = {};
    m.entries.forEach((e) => { (by[e.workflow] = by[e.workflow] || []).push(e.kind + ' ' + e.text + (e.intoPr ? ' (into PR branches)' : '')); });
    Object.keys(by).sort().forEach((w) => { console.log(w); [...new Set(by[w])].forEach((x) => console.log('  ' + x)); });
    if (m.merge.size) console.log('merge-source (patched in place, still source): ' + [...m.merge].join(', '));
  } else if (args[0] === '--explain') {
    const rel = args[1];
    const c = classify(rel);
    console.log(rel + ': ' + c.class + (c.owners.length ? ' — owned by ' + c.owners.join(', ') : ''));
    c.owners.forEach((w) => console.log('  ' + w + ' is produced by:\n    ' + [...generatorClosure(w)].sort().join('\n    ')));
  } else {
    args.forEach((a) => { const c = classify(a); console.log(c.class.padEnd(13) + ' ' + a + (c.owners.length ? '  ← ' + c.owners.join(', ') : '')); });
  }
}
