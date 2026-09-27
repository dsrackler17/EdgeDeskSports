/* ===========================================================================
   WRITE AN ARTIFACT ONLY WHEN ITS CONTENT CHANGED. A nightly job that rewrites
   a multi-megabyte file because its generated_at moved would commit the same
   data every night; this compares the new object with the file on disk with
   the clock fields nulled and leaves the file alone when nothing else moved.
   Returns 'written' | 'unchanged'.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const CLOCK = ['generated_at', 'retrieved_at', 'updated_at', 'as_of', 'started_at'];
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { if (CLOCK.indexOf(k) >= 0) return; o[k] = strip(v[k]); }); return o; }
  return v;
}
function writeIfChanged(file, obj, opts) {
  opts = opts || {};
  const text = opts.pretty ? JSON.stringify(obj, null, 1) + (opts.newline ? '\n' : '') : JSON.stringify(obj);
  try {
    if (fs.existsSync(file)) { const prev = JSON.parse(fs.readFileSync(file, 'utf8')); if (JSON.stringify(strip(prev)) === JSON.stringify(strip(obj))) return 'unchanged'; }
  } catch (_) { /* unreadable: write */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return 'written';
}
module.exports = { writeIfChanged, strip, CLOCK };
