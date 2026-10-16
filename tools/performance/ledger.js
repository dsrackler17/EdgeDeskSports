'use strict';
/* ===========================================================================
   THE PERFORMANCE LEDGER STORE — append-only, hash-chained JSONL.

   Four streams under performance/ledger/, one file per sport and UTC year of
   the game's start (a chain per file):

     forecasts/<sport>-<YYYY>.jsonl   every pregame forecast revision
     quotes/<sport>-<YYYY>.jsonl      every named-book quote change before a start
     results/<sport>-<YYYY>.jsonl     every verified result revision (corrections
                                      are new rows that supersede, never edits)
     grades/<sport>-<YYYY>.jsonl      every grade revision

   Each row carries seq, prev (the previous row's hash, or GENESIS) and hash
   (SHA-256 of the canonical row without its hash). A changed byte anywhere
   breaks every later hash; verify() finds it. A write never rewrites: the new
   file is the old file plus new lines, written to a temp file, checked to be
   an exact extension of what was on disk, then renamed into place.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENESIS = 'GENESIS';
const STREAMS = ['forecasts', 'quotes', 'results', 'grades'];

/** Stable JSON: object keys sorted at every depth, undefined dropped. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashOf(row) { const c = Object.assign({}, row); delete c.hash; return sha256(canonical(c)); }

function fileFor(root, stream, sport, startIso) {
  const y = startIso && Number.isFinite(Date.parse(startIso)) ? new Date(startIso).getUTCFullYear() : 'undated';
  return path.join(root, 'performance', 'ledger', stream, String(sport || 'unknown').toLowerCase() + '-' + y + '.jsonl');
}
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } }
function parseRows(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    try { out.push(JSON.parse(l)); } catch (e) { out.push({ __bad: true, line: i + 1, error: String(e.message).slice(0, 120) }); }
  });
  return out;
}
function readRows(file) { return parseRows(readText(file)); }
function listFiles(root, stream) {
  const dir = path.join(root, 'performance', 'ledger', stream);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch (_) { names = []; }
  return names.map((n) => path.join(dir, n));
}
function readStream(root, stream) {
  const rows = [];
  listFiles(root, stream).forEach((f) => readRows(f).forEach((r) => { if (!r.__bad) rows.push(r); }));
  return rows;
}

/** Check one file's chain: seq runs 1..n, each prev is the last hash, each hash is right. */
function verifyRows(rows) {
  const errors = [];
  let prev = GENESIS;
  rows.forEach((r, i) => {
    if (r.__bad) { errors.push('line ' + r.line + ': not JSON (' + r.error + ')'); return; }
    if (r.seq !== i + 1) errors.push('line ' + (i + 1) + ': seq ' + r.seq + ' (expected ' + (i + 1) + ')');
    if (r.prev !== prev) errors.push('line ' + (i + 1) + ': prev does not match the previous hash');
    const h = hashOf(r);
    if (r.hash !== h) errors.push('line ' + (i + 1) + ': hash does not match its content');
    prev = r.hash;
  });
  return { ok: !errors.length, rows: rows.length, errors };
}

/**
 * Append rows to one file's chain. Returns the rows as written (with seq,
 * prev, hash). Refuses if the file on disk does not verify: a broken chain is
 * reported, never extended.
 */
function append(file, rows, o) {
  o = o || {};
  if (!rows.length) return [];
  const before = readText(file);
  const have = parseRows(before);
  const v = verifyRows(have);
  if (!v.ok) throw new Error('refusing to extend a broken chain: ' + path.relative(o.root || process.cwd(), file) + ' — ' + v.errors.slice(0, 3).join('; '));
  let prev = have.length ? have[have.length - 1].hash : GENESIS;
  let seq = have.length;
  const written = rows.map((r) => {
    const row = Object.assign({}, r);
    delete row.hash; delete row.prev; delete row.seq;
    row.seq = ++seq; row.prev = prev;
    row.hash = hashOf(row);
    prev = row.hash;
    return row;
  });
  if (o.dryRun) return written;
  const text = (before && !before.endsWith('\n') ? before + '\n' : before) + written.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (!text.startsWith(before)) throw new Error('append would rewrite ' + file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  const check = fs.readFileSync(tmp, 'utf8');
  if (!check.startsWith(before) || !verifyRows(parseRows(check)).ok) { fs.unlinkSync(tmp); throw new Error('the written file did not verify: ' + file); }
  fs.renameSync(tmp, file);
  return written;
}

/** Group rows by their target file, then append each group in order. */
function appendMany(root, stream, rows, o) {
  const by = new Map();
  rows.forEach((r) => {
    const f = fileFor(root, stream, r.sport, r.start_utc);
    if (!by.has(f)) by.set(f, []);
    by.get(f).push(r);
  });
  const out = [];
  Array.from(by.keys()).sort().forEach((f) => { append(f, by.get(f), Object.assign({ root }, o)).forEach((r) => out.push(r)); });
  return out;
}

/** Every chain under performance/ledger verifies. */
function verifyAll(root) {
  const report = { ok: true, files: [] };
  STREAMS.forEach((s) => listFiles(root, s).forEach((f) => {
    const v = verifyRows(readRows(f));
    report.files.push({ file: path.relative(root, f), rows: v.rows, ok: v.ok, errors: v.errors.slice(0, 5) });
    if (!v.ok) report.ok = false;
  }));
  return report;
}
/** The committed base of every ledger file must be an exact prefix of the working copy. */
function verifyPrefix(baseText, newText) {
  if (!baseText) return { ok: true };
  if (!newText.startsWith(baseText)) {
    let i = 0; while (i < baseText.length && baseText[i] === newText[i]) i++;
    const line = baseText.slice(0, i).split('\n').length;
    return { ok: false, detail: newText.length < baseText.length ? 'the file is shorter than the committed version' : 'line ' + line + ' differs from the committed version' };
  }
  return { ok: true };
}

module.exports = { GENESIS, STREAMS, canonical, sha256, hashOf, fileFor, readText, parseRows, readRows, listFiles, readStream, verifyRows, append, appendMany, verifyAll, verifyPrefix };
