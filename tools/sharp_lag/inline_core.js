#!/usr/bin/env node
/* ===========================================================================
   Copy lib/edgedesk_sharp_lag.js, verbatim and whole, into the Sharp-lag
   Edge Function between its BEGIN / END SHARP LAG CORE markers:
     supabase/functions/sharp_lag/index.ts     the free job

   Why a copy and not an import: the dashboard deploy bundles ONE folder
   (tools/kalshi/inline_identity.js, the same rule). The flags the job writes
   and the sections the pages draw come from the same arithmetic, so a Pinnacle
   fair, a fee or a gap cannot be one number in the database and another on the
   page. tools/sharp_lag/sharp_lag_fn.test.js fails if a copy drifts.

   Run after editing lib/edgedesk_sharp_lag.js:  node tools/sharp_lag/inline_core.js
   Check without writing:                        node tools/sharp_lag/inline_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE_BEGIN = '// ── BEGIN SHARP LAG CORE', CORE_END = '// ── END SHARP LAG CORE';
const TARGETS = ['sharp_lag'].map((f) => path.join(ROOT, 'supabase', 'functions', f, 'index.ts'));


function blocks() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_sharp_lag.js'), 'utf8');
  const core = CORE_BEGIN + ' ── copied from lib/edgedesk_sharp_lag.js by tools/sharp_lag/inline_core.js; do not edit here\n'
    + src.replace(/\s*$/, '\n') + CORE_END + ' ──\n';
  return { core };
}

function spliceOne(src, begin, end, body, file) {
  const a = src.indexOf(begin), b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, file) + ' has no ' + begin.replace('// ── ', '') + ' markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + body + src.slice(eol < 0 ? src.length : eol + 1);
}
function splice(src, file) {
  const b = blocks();
  return spliceOne(src, CORE_BEGIN, CORE_END, b.core, file);
}
function current() { return TARGETS.every((f) => { const s = fs.readFileSync(f, 'utf8'); return splice(s, f) === s; }); }

if (require.main === module) {
  let stale = 0;
  for (const f of TARGETS) {
    const src = fs.readFileSync(f, 'utf8'), out = splice(src, f);
    if (out === src) { console.log('ok      ' + path.relative(ROOT, f)); continue; }
    if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, f) + ' (run node tools/sharp_lag/inline_core.js)'); stale++; continue; }
    fs.writeFileSync(f, out); console.log('updated ' + path.relative(ROOT, f));
  }
  process.exit(stale ? 1 : 0);
}
module.exports = { current, splice, TARGETS };
