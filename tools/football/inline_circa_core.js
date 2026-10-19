#!/usr/bin/env node
/* ===========================================================================
   Copy football/market_structure/circa_core.js, verbatim, into
   supabase/functions/circa_ownership_sync/index.ts between its
   BEGIN CIRCA CORE / END CIRCA CORE markers.

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and an
   import that cannot resolve fails the bundle while the previous version keeps
   serving (tools/billing/inline_core.js, the same rule). The Node module
   footer after END is not copied. tools/football/circa_ownership.test.js fails
   if the copy drifts.

   Run after editing circa_core.js:   node tools/football/inline_circa_core.js
   Check without writing:             node tools/football/inline_circa_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BEGIN = '// ── BEGIN CIRCA CORE';
const END = '// ── END CIRCA CORE';
const SRC = fs.readFileSync(path.join(ROOT, 'football', 'market_structure', 'circa_core.js'), 'utf8');
const CORE = SRC.slice(SRC.indexOf(BEGIN), SRC.indexOf('\n', SRC.indexOf(END)) + 1);
const TARGET = path.join(ROOT, 'supabase', 'functions', 'circa_ownership_sync', 'index.ts');

function splice(src) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, TARGET) + ' has no BEGIN/END CIRCA CORE markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + CORE + src.slice(eol < 0 ? src.length : eol + 1);
}
function current() { return splice(fs.readFileSync(TARGET, 'utf8')) === fs.readFileSync(TARGET, 'utf8'); }

if (require.main === module) {
  const src = fs.readFileSync(TARGET, 'utf8'), out = splice(src);
  if (out === src) { console.log('ok      ' + path.relative(ROOT, TARGET)); process.exit(0); }
  if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, TARGET)); process.exit(1); }
  fs.writeFileSync(TARGET, out); console.log('updated ' + path.relative(ROOT, TARGET));
}
module.exports = { CORE, current, splice };
