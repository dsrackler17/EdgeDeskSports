#!/usr/bin/env node
/* ===========================================================================
   Copy the shared cores, verbatim and whole, into the Novig edge functions
   between their BEGIN NOVIG CORE / END NOVIG CORE markers:

     supabase/functions/novig_sync/index.ts
        lib/football_identity.js       team identity (the board's and Kalshi's)
        lib/novig_signing.js           NOVIG-V3
        lib/edgedesk_venue_compare.js  the executable-price engine
        lib/novig_market_map.js        the matcher
     supabase/functions/novig_key_bootstrap/index.ts
        lib/novig_signing.js

   Why a copy and not an import: the deploy bundles ONE folder, and an import
   that cannot resolve fails the bundle while the previous version keeps
   serving (tools/kalshi/inline_identity.js, the same rule). The browser, the
   tests and the functions therefore run exactly the same code, and
   tools/novig/novig_sync.test.js fails if a copy drifts.

   Run after editing any of those lib files:   node tools/novig/inline.js
   Check without writing:                      node tools/novig/inline.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BEGIN = '// ── BEGIN NOVIG CORE';
const END = '// ── END NOVIG CORE';
const TARGETS = {
  'supabase/functions/novig_sync/index.ts': ['lib/football_identity.js', 'lib/novig_signing.js', 'lib/edgedesk_venue_compare.js', 'lib/novig_market_map.js'],
  'supabase/functions/novig_key_bootstrap/index.ts': ['lib/novig_signing.js'],
};

function core(libs) {
  return BEGIN + ' ── ' + libs.join(', ') + ', copied by tools/novig/inline.js; do not edit here\n'
    + libs.map((l) => '// ---- ' + l + '\n' + fs.readFileSync(path.join(ROOT, l), 'utf8').replace(/\s*$/, '\n')).join('')
    + END + ' ──\n';
}
function splice(src, libs, name) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(name + ' has no BEGIN/END NOVIG CORE markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + core(libs) + src.slice(eol < 0 ? src.length : eol + 1);
}
function status() {
  return Object.entries(TARGETS).map(([t, libs]) => {
    const p = path.join(ROOT, t), src = fs.readFileSync(p, 'utf8'), out = splice(src, libs, t);
    return { target: t, current: out === src, out, p };
  });
}
function current(target) { return status().filter((s) => !target || s.target === target).every((s) => s.current); }

if (require.main === module) {
  let drift = false;
  for (const s of status()) {
    if (s.current) { console.log('ok      ' + s.target); continue; }
    if (process.argv.includes('--check')) { console.log('DRIFT   ' + s.target + ' (run node tools/novig/inline.js)'); drift = true; continue; }
    fs.writeFileSync(s.p, s.out); console.log('updated ' + s.target);
  }
  process.exit(drift ? 1 : 0);
}
module.exports = { TARGETS, current, core };
