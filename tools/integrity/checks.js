/* ============================================================================
   EdgeDesk — file integrity checks.

   Each check takes a path and its bytes and returns problems, so the gate can
   check a merge result straight from git objects (a tree that was never
   checked out) as easily as a working tree.

     conflict markers  <<<<<<< / ||||||| / ======= / >>>>>>> left in any text
                       file (a lone ======= counts only beside another marker:
                       it is also a Markdown heading underline)
     .js .cjs .mjs     parses: in-process for scripts and CommonJS, and through
                       `node --check` for anything that needs module syntax
     .json             JSON.parse                  (#800: slate_audit.json)
     .jsonl .ndjson    every line JSON.parse
     .gz               gunzips; a .json.gz / .jsonl.gz also parses
     .html .htm        every inline <script> parses as a script; every
                       application/ld+json or application/json block parses
     .py               compiles (python3, one process for the batch)
     .sh               `bash -n`
     .yml .yaml        parses (python3 + PyYAML; reported as skipped without it)
     .xml              well-formed (python3 xml.etree)

   Problems: { file, line, rule, message }. A file named in
   tools/integrity/baseline.json for a rule is a known, documented exception;
   tools/integrity/integrity.test.js fails if that entry ever starts passing,
   so the baseline can only shrink.
   ============================================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const BINARY_EXT = new Set(['.gz', '.parquet', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mp3', '.wasm', '.feather', '.pkl', '.npy', '.npz', '.db', '.sqlite', '.xlsx', '.bin']);

function isBinary(rel, buf) {
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return true;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* ---- conflict markers ------------------------------------------------------ */
const OPEN_RE = /^<{7}(?: |$)/;
const BASE_RE = /^\|{7}(?: |$)/;
const CLOSE_RE = /^>{7}(?: |$)/;
const MID_RE = /^={7}$/;

function conflictMarkers(rel, text) {
  const lines = text.split('\n');
  const hits = [];
  let strong = false;
  lines.forEach((l, i) => {
    const s = l.replace(/\r$/, '');
    if (OPEN_RE.test(s) || CLOSE_RE.test(s) || BASE_RE.test(s)) { strong = true; hits.push({ line: i + 1, text: s.slice(0, 40) }); }
    else if (MID_RE.test(s)) hits.push({ line: i + 1, text: s, weak: true });
  });
  if (!strong) return [];
  return hits.map((h) => ({ file: rel, line: h.line, rule: 'conflict-marker', message: 'unresolved merge-conflict marker "' + h.text + '"' }));
}

/* ---- JSON ------------------------------------------------------------------ */
function lineOfPosition(text, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function jsonError(rel, text, e, baseLine) {
  const m = /line (\d+) column (\d+)/.exec(e.message) || null;
  const p = /position (\d+)/.exec(e.message);
  const line = m ? Number(m[1]) : p ? lineOfPosition(text, Number(p[1])) : 1;
  return { file: rel, line: (baseLine || 0) + line, rule: 'json', message: 'invalid JSON: ' + e.message.replace(/^Unexpected/, 'unexpected') };
}

function checkJson(rel, text) {
  try { JSON.parse(text.replace(/^﻿/, '')); return []; } catch (e) { return [jsonError(rel, text, e)]; }
}

function checkJsonl(rel, text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    try { JSON.parse(l); } catch (e) { out.push({ file: rel, line: i + 1, rule: 'jsonl', message: 'invalid JSON line: ' + e.message }); }
  });
  return out.slice(0, 20);
}

/* ---- JavaScript ------------------------------------------------------------ */
const ESM_HINT = /Cannot use import statement|Unexpected token 'export'|import\.meta|await is only valid|Cannot use 'import\.meta'|Unexpected reserved word/;

function parseScript(src, filename) {
  const body = src.replace(/^#!.*/, '');
  /* the CommonJS wrapper, as Node compiles a .js file: a top-level `return`
     is legal there, and nothing else changes */
  new vm.Script('(function (exports, require, module, __filename, __dirname) {' + body + '\n})', { filename });
}

function nodeCheck(src, ext, rel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  const f = path.join(dir, 'check' + ext);
  try {
    fs.writeFileSync(f, src);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status === 0) return [];
    const err = (r.stderr || '').split('\n');
    const lm = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)').exec(r.stderr || '');
    const msg = err.find((l) => /Error/.test(l)) || 'syntax error';
    return [{ file: rel, line: lm ? Number(lm[1]) : 1, rule: 'js', message: msg.trim() }];
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function checkJs(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.mjs') return nodeCheck(text, '.mjs', rel);
  try { parseScript(text, rel); return []; } catch (e) {
    if (ESM_HINT.test(e.message)) return nodeCheck(text, ext === '.cjs' ? '.cjs' : '.js', rel);
    const m = /:(\d+)$/.exec(String(e.stack || '').split('\n')[0]) || /evalmachine\.<anonymous>:(\d+)/.exec(e.stack || '');
    const line = m ? Number(m[1]) : 1;
    return [{ file: rel, line, rule: 'js', message: 'SyntaxError: ' + e.message }];
  }
}

/* ---- HTML inline scripts ----------------------------------------------------- */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function checkHtml(rel, text) {
  const out = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(text))) {
    const attrs = m[1];
    const body = m[2];
    if (/\bsrc\s*=/.test(attrs) || !body.trim()) continue;
    const typeM = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = typeM ? typeM[1].toLowerCase() : 'text/javascript';
    const startLine = lineOfPosition(text, m.index + m[0].indexOf('>') + 1) - 1;
    if (type === 'application/ld+json' || type === 'application/json') {
      try { JSON.parse(body); } catch (e) { out.push(Object.assign(jsonError(rel, body, e, startLine), { rule: 'html-json', message: 'inline ' + type + ' block: ' + e.message })); }
    } else if (/^(text|application)\/(javascript|ecmascript)$|^module$/.test(type)) {
      try {
        if (type === 'module') { const r = nodeCheck(body, '.mjs', rel); if (r.length) throw new Error(r[0].message); }
        else new vm.Script(body, { filename: rel });
      } catch (e) {
        const lm = /:(\d+)$/.exec(String(e.stack || '').split('\n')[0]);
        out.push({ file: rel, line: startLine + (lm ? Number(lm[1]) : 1), rule: 'html-script', message: 'inline <script> does not parse: ' + e.message });
      }
    }
  }
  return out;
}

/* ---- gzip ------------------------------------------------------------------ */
function checkGz(rel, buf) {
  let inner;
  try { inner = zlib.gunzipSync(buf); } catch (e) { return [{ file: rel, line: 1, rule: 'gzip', message: 'does not gunzip: ' + e.message }]; }
  const base = rel.replace(/\.gz$/i, '');
  if (/\.json$/i.test(base)) return checkJson(rel, inner.toString('utf8')).map((p) => Object.assign(p, { rule: 'gzip-json' }));
  if (/\.(jsonl|ndjson)$/i.test(base)) return checkJsonl(rel, inner.toString('utf8')).map((p) => Object.assign(p, { rule: 'gzip-jsonl' }));
  return [];
}

/* ---- batched external checks (python, bash, yaml, xml) ---------------------- */
const PY_BATCH = String.raw`
import sys, json
out = []
try:
    import yaml
    have_yaml = True
except Exception:
    have_yaml = False
import xml.etree.ElementTree as ET
for rel, real, kind in json.load(sys.stdin):
    try:
        if kind == 'py':
            with open(real, 'rb') as f: compile(f.read(), rel, 'exec', dont_inherit=True)
        elif kind == 'yaml':
            if not have_yaml:
                out.append([rel, 0, 'yaml-skipped', 'PyYAML is not installed; YAML not checked']); continue
            with open(real, 'rb') as f: list(yaml.safe_load_all(f))
        elif kind == 'xml':
            ET.parse(real)
    except SyntaxError as e:
        out.append([rel, getattr(e, 'lineno', 0) or 0, kind, '%s: %s' % (type(e).__name__, e.msg if hasattr(e, 'msg') else e)])
    except Exception as e:
        line = 0
        mark = getattr(e, 'problem_mark', None)
        if mark is not None: line = mark.line + 1
        pos = getattr(e, 'position', None)
        if pos: line = pos[0]
        out.append([rel, line, kind, '%s: %s' % (type(e).__name__, str(e).splitlines()[0] if str(e) else '')])
json.dump(out, sys.stdout)
`;

function checkExternal(items) {
  /* items: [{ rel, buf, kind: py|yaml|xml|sh }] */
  if (!items.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-ext-'));
  const out = [];
  try {
    const py = [];
    items.forEach((it, i) => {
      const real = path.join(dir, String(i) + path.extname(it.rel));
      fs.writeFileSync(real, it.buf);
      if (it.kind === 'sh') {
        const r = spawnSync('bash', ['-n', real], { encoding: 'utf8' });
        if (r.status !== 0) {
          const lm = /line (\d+)/.exec(r.stderr || '');
          out.push({ file: it.rel, line: lm ? Number(lm[1]) : 1, rule: 'sh', message: (r.stderr || 'bash -n failed').trim().split('\n')[0].replace(real + ': ', '') });
        }
      } else py.push([it.rel, real, it.kind]);
    });
    if (py.length) {
      const r = spawnSync('python3', ['-c', PY_BATCH], { input: JSON.stringify(py), encoding: 'utf8', maxBuffer: 1 << 26 });
      if (r.error || r.status !== 0) {
        out.push({ file: '(python3)', line: 0, rule: 'tooling', message: 'python3 checks could not run: ' + (r.error ? r.error.message : r.stderr.trim().split('\n').pop()) });
      } else {
        for (const [rel, line, kind, msg] of JSON.parse(r.stdout || '[]')) out.push({ file: rel, line, rule: kind, message: msg });
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return out;
}

/* ---- dispatch ------------------------------------------------------------------ */
function kindOf(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return 'js';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.gz') return 'gz';
  if (ext === '.py') return 'py';
  if (ext === '.sh' || ext === '.bash') return 'sh';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.xml') return 'xml';
  return null;
}

/* Fixtures that are broken on purpose live under these paths (the gate's own
   regression fixtures); they are never checked as repository files. */
const FIXTURE_RE = /^tools\/integrity\/fixtures\//;

function loadBaseline(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'tools', 'integrity', 'baseline.json'), 'utf8')); } catch (e) { return { entries: [] }; }
}

/* Check many files. `read(rel)` returns a Buffer (or null when deleted). */
function checkFiles(rels, read, opts) {
  opts = opts || {};
  const baseline = opts.baseline || { entries: [] };
  const exempt = new Set((baseline.entries || []).map((e) => e.rule + '\0' + e.file));
  const problems = [];
  const external = [];
  let checked = 0;
  for (const rel of rels) {
    if (FIXTURE_RE.test(rel)) continue;
    const buf = read(rel);
    if (!buf) continue;
    checked++;
    const kind = kindOf(rel);
    const binary = isBinary(rel, buf);
    if (!binary) problems.push(...conflictMarkers(rel, buf.toString('utf8')));
    if (kind === 'gz') { problems.push(...checkGz(rel, buf)); continue; }
    if (binary || !kind) continue;
    const text = buf.toString('utf8');
    if (kind === 'json') problems.push(...checkJson(rel, text));
    else if (kind === 'jsonl') problems.push(...checkJsonl(rel, text));
    else if (kind === 'js') problems.push(...checkJs(rel, text));
    else if (kind === 'html') problems.push(...checkHtml(rel, text));
    else external.push({ rel, buf, kind });
  }
  problems.push(...checkExternal(external));
  const kept = problems.filter((p) => !exempt.has(p.rule + '\0' + p.file) && !exempt.has(p.rule.replace(/^gzip-/, '') + '\0' + p.file));
  return { checked, problems: kept, exempted: problems.length - kept.length };
}

module.exports = { checkFiles, conflictMarkers, checkJson, checkJsonl, checkJs, checkHtml, checkGz, checkExternal, kindOf, isBinary, loadBaseline, FIXTURE_RE };
