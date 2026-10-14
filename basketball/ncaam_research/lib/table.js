'use strict';
/* ===========================================================================
   Parquet in, typed columns out.

   The pack is Parquet. Like the NHL and NFL packs, it is read through
   hockey/tools/parquet_select.py (pyarrow, requested columns only) and never
   through the pack's own scripts. Rows stream into column arrays:

     num   Float64Array, NaN where the source is null (null = unknown, never 0)
     bool  Int8Array: 1 true, 0 false, -1 null
     str   Array of strings, null where the source is null ('' stays '')

   readTable(file, {col: type, ...}) -> { n, cols: {col: array}, missing: [cols] }
   =========================================================================== */
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const C = require('../config');

/* split one CSV record; an unquoted empty field is null, a quoted "" is '' */
function split(line) {
  const out = []; let i = 0; const n = line.length;
  while (i <= n) {
    if (line.charCodeAt(i) === 34) {
      let v = ''; i++;
      for (;;) {
        const j = line.indexOf('"', i);
        if (j < 0) { v += line.slice(i); i = n; break; }
        v += line.slice(i, j);
        if (line.charCodeAt(j + 1) === 34) { v += '"'; i = j + 2; } else { i = j + 1; break; }
      }
      out.push(v); i++;
    } else {
      let j = line.indexOf(',', i); if (j < 0) j = n;
      out.push(j === i ? null : line.slice(i, j)); i = j + 1;
    }
  }
  return out;
}

function makeCol(type, cap) {
  if (type === 'num') return new Float64Array(cap).fill(NaN);
  if (type === 'bool') return new Int8Array(cap).fill(-1);
  return new Array(cap).fill(null);
}

function grow(arr, type, cap) {
  const next = makeCol(type, cap);
  if (type === 'str') { for (let i = 0; i < arr.length; i++) next[i] = arr[i]; } else next.set(arr);
  return next;
}

function setCell(arr, type, i, v) {
  if (v === null) return;
  if (type === 'num') { const x = Number(v); arr[i] = v === '' || !isFinite(x) ? NaN : x; }
  else if (type === 'bool') arr[i] = v === 'true' || v === 'TRUE' || v === '1' ? 1 : v === 'false' || v === 'FALSE' || v === '0' ? 0 : -1;
  else arr[i] = v;
}

async function readTable(file, spec) {
  if (!fs.existsSync(file)) throw new Error('missing table ' + file);
  const names = Object.keys(spec);
  const py = spawn('python3', ['-I', C.PATHS.helper, file, '-', names.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  py.stderr.on('data', (d) => { stderr += d.toString(); });
  const done = new Promise((res) => py.on('close', (code) => res(code)));
  const rl = readline.createInterface({ input: py.stdout, crlfDelay: Infinity });
  let cap = 1 << 14; let n = 0; let header = null; let idx = null;
  const cols = {}; for (const c of names) cols[c] = makeCol(spec[c], cap);
  for await (const line of rl) {
    if (!header) { header = split(line); idx = names.map((c) => header.indexOf(c)); continue; }
    if (!line) continue;
    if (n === cap) { cap *= 2; for (const c of names) cols[c] = grow(cols[c], spec[c], cap); }
    const f = split(line);
    for (let k = 0; k < names.length; k++) if (idx[k] >= 0) setCell(cols[names[k]], spec[names[k]], n, f[idx[k]]);
    n++;
  }
  const code = await done;
  if (code !== 0) throw new Error('parquet_select failed (' + code + ') for ' + file + ': ' + stderr.slice(0, 400));
  for (const c of names) cols[c] = spec[c] === 'str' ? cols[c].slice(0, n) : cols[c].subarray(0, n);
  const m = /missing columns: (.*)/.exec(stderr);
  return { n, cols, missing: m ? m[1].trim().split(',') : [] };
}

/* a row view for small tables */
function rows(t) {
  const names = Object.keys(t.cols); const out = new Array(t.n);
  for (let i = 0; i < t.n; i++) { const o = {}; for (const c of names) { const v = t.cols[c][i]; o[c] = (typeof v === 'number' && Number.isNaN(v)) ? null : v; } out[i] = o; }
  return out;
}

module.exports = { readTable, rows, split };
