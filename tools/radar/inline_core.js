#!/usr/bin/env node
/* ===========================================================================
   Copy lib/edgedesk_radar.js and lib/edgedesk_poly_gateway.js, verbatim and
   whole, into supabase/functions/polymarket_sync/index.ts between its
   BEGIN / END RADAR CORE and BEGIN / END RADAR GATEWAY markers.

   Why a copy and not an import: the dashboard deploy bundles ONE folder
   (supabase/README.md). The grades the job writes, the validation runner and
   the tests come from the same arithmetic, and every Polymarket request from
   the same gateway. tools/radar/sync_fn.test.js fails if a copy drifts.

   Run after editing either file:  node tools/radar/inline_core.js
   Check without writing:          node tools/radar/inline_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'supabase', 'functions', 'polymarket_sync', 'index.ts');
const BLOCKS = [
  { begin: '// ── BEGIN RADAR CORE', end: '// ── END RADAR CORE', src: 'lib/edgedesk_radar.js' },
  { begin: '// ── BEGIN RADAR GATEWAY', end: '// ── END RADAR GATEWAY', src: 'lib/edgedesk_poly_gateway.js' }
];

function spliceOne(text, b) {
  const a = text.indexOf(b.begin), e = text.indexOf(b.end, a);
  if (a < 0 || e < 0) throw new Error(path.relative(ROOT, TARGET) + ' has no ' + b.begin.replace('// ── ', '') + ' markers');
  const eol = text.indexOf('\n', e);
  const body = b.begin + ' ── copied from ' + b.src + ' by tools/radar/inline_core.js; do not edit here\n'
    + fs.readFileSync(path.join(ROOT, b.src), 'utf8').replace(/\s*$/, '\n') + b.end + ' ──\n';
  return text.slice(0, a) + body + text.slice(eol < 0 ? text.length : eol + 1);
}
function render(text) { return BLOCKS.reduce(spliceOne, text); }
function current() { const s = fs.readFileSync(TARGET, 'utf8'); return render(s) === s; }

if (require.main === module) {
  const src = fs.readFileSync(TARGET, 'utf8'), out = render(src);
  if (out === src) { console.log('ok      ' + path.relative(ROOT, TARGET)); process.exit(0); }
  if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, TARGET) + ' (run node tools/radar/inline_core.js)'); process.exit(1); }
  fs.writeFileSync(TARGET, out); console.log('updated ' + path.relative(ROOT, TARGET));
}
module.exports = { current, render, TARGET };
