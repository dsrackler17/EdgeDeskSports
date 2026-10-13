'use strict';
/* ===========================================================================
   EdgeDesk engine — CSV in, rows out (RFC 4180).

   Quoted fields may hold commas, doubled quotes and newlines (the data pack's
   *_json columns do). A `.gz` file is gunzipped first. Values stay strings:
   an empty cell is '' and is never turned into 0 — callers decide what a
   blank means (usually "not observed").

   readCsv(file)            -> { header: [..], rows: [{col: 'value'}] }
   scanCsv(file, [cols])    -> counts only, for files too wide to hold
   parseCsv(text)           -> [[cells], ...]
   =========================================================================== */
const fs = require('fs');
const zlib = require('zlib');

/** calls fn(cells, index) for each record; nothing is retained */
function eachRow(text, fn) {
  let row = []; let cur = ''; let q = false; let i = 0; let r = 0;
  const n = text.length;
  if (n && text.charCodeAt(0) === 0xfeff) i = 1;
  let start = i;
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    if (q) {
      if (c === 34) {
        cur += text.slice(start, i);
        if (text.charCodeAt(i + 1) === 34) { cur += '"'; i++; } else q = false;
        start = i + 1;
      }
      continue;
    }
    if (c === 34) { cur += text.slice(start, i); q = true; start = i + 1; }
    else if (c === 44) { row.push(cur + text.slice(start, i)); cur = ''; start = i + 1; }
    else if (c === 10 || c === 13) {
      row.push(cur + text.slice(start, i)); cur = '';
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
      fn(row, r++); row = [];
    }
  }
  if (q) throw new Error('CSV: unterminated quoted field');
  if (start < n || cur !== '' || row.length) { row.push(cur + text.slice(start, n)); fn(row, r++); }
  return r;
}

function parseCsv(text) {
  const out = [];
  eachRow(text, (row) => { out.push(row); });
  return out;
}

function readText(file) {
  const buf = fs.readFileSync(file);
  return (/\.gz$/.test(file) ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

function readCsv(file) {
  let header = []; const rows = [];
  eachRow(readText(file), (f, r) => {
    if (r === 0) { header = f; return; }
    if (f.length === 1 && f[0] === '') return;
    if (f.length !== header.length) throw new Error('CSV: ' + file + ' line ' + (r + 1) + ' has ' + f.length + ' cells, header has ' + header.length);
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = f[k];
    rows.push(o);
  });
  return { header, rows };
}

/** counts without keeping rows: { header, rows, ragged, nonBlank: {col: n} } for the columns asked */
function scanCsv(file, watch) {
  let header = []; let rows = 0; let ragged = 0; const idx = {}; const nonBlank = {};
  eachRow(readText(file), (f, r) => {
    if (r === 0) { header = f; (watch || []).forEach((c) => { idx[c] = f.indexOf(c); nonBlank[c] = 0; }); return; }
    if (f.length === 1 && f[0] === '') return;
    rows++;
    if (f.length !== header.length) ragged++;
    for (const c in idx) if (idx[c] >= 0 && f[idx[c]] !== '') nonBlank[c]++;
  });
  return { header, rows, ragged, nonBlank };
}

/** one CSV cell from a value: quoted when it must be; null/undefined -> '' */
function cell(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(header, rows) {
  return header.join(',') + '\n' + rows.map((r) => header.map((h) => cell(r[h])).join(',')).join('\n') + (rows.length ? '\n' : '');
}

module.exports = { eachRow, parseCsv, readCsv, scanCsv, readText, toCsv, cell };
