'use strict';
/* ===========================================================================
   EdgeDesk — read Parquet from Node through my own Python helpers (pyarrow),
   run with `python3 -I` so nothing beside a data file can be imported.

     meta([file, ...])   -> { file: { rows, columns, fields, nulls, spans } }   (tools/datapack/parquet_meta.py)
     rows(file, [cols])  -> [{ col: 'value' }]  strings; '' for null           (hockey/tools/parquet_select.py)

   A requested column the file lacks comes back '' on every row (the caller
   records it missing; it is never observed).
   =========================================================================== */
const path = require('path');
const { execFileSync } = require('child_process');
const { parseCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
const META = path.join(__dirname, 'parquet_meta.py');
const SELECT = path.join(ROOT, 'hockey', 'tools', 'parquet_select.py');

function meta(files) { return JSON.parse(execFileSync('python3', ['-I', META].concat(files), { encoding: 'utf8', maxBuffer: 1 << 28 })); }
function rows(file, cols) {
  const text = execFileSync('python3', ['-I', SELECT, file, '-', cols.join(',')], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const all = parseCsv(text); const h = all.shift() || [];
  const out = [];
  for (const r of all) { if (r.length !== h.length) continue; const o = {}; for (let i = 0; i < h.length; i++) o[h[i]] = r[i]; out.push(o); }
  return out;
}
module.exports = { meta, rows };
