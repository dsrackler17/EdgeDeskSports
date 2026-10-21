#!/usr/bin/env node
/* ===========================================================================
   Copy lib/football_identity.js, verbatim and whole, into
   supabase/functions/kalshi_sync/index.ts between its
   BEGIN FOOTBALL IDENTITY / END FOOTBALL IDENTITY markers.

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and an
   import that cannot resolve fails the bundle while the previous version keeps
   serving (tools/football/inline_circa_core.js, the same rule). The Kalshi
   links resolve team names with exactly the code the Collective's grading and
   the board resolve them with, so a team cannot be one school here and
   another there. tools/kalshi/kalshi_sync.test.js fails if the copy drifts.

   Run after editing lib/football_identity.js:   node tools/kalshi/inline_identity.js
   Check without writing:                         node tools/kalshi/inline_identity.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BEGIN = '// ── BEGIN FOOTBALL IDENTITY';
const END = '// ── END FOOTBALL IDENTITY';
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'football_identity.js'), 'utf8');
const CORE = BEGIN + ' ── copied from lib/football_identity.js by tools/kalshi/inline_identity.js; do not edit here\n'
  + SRC.replace(/\s*$/, '\n') + END + ' ──\n';
const TARGET = path.join(ROOT, 'supabase', 'functions', 'kalshi_sync', 'index.ts');

function splice(src) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, TARGET) + ' has no BEGIN/END FOOTBALL IDENTITY markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + CORE + src.slice(eol < 0 ? src.length : eol + 1);
}
function current() { const s = fs.readFileSync(TARGET, 'utf8'); return splice(s) === s; }

if (require.main === module) {
  const src = fs.readFileSync(TARGET, 'utf8'), out = splice(src);
  if (out === src) { console.log('ok      ' + path.relative(ROOT, TARGET)); process.exit(0); }
  if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, TARGET) + ' (run node tools/kalshi/inline_identity.js)'); process.exit(1); }
  fs.writeFileSync(TARGET, out); console.log('updated ' + path.relative(ROOT, TARGET));
}
module.exports = { CORE, current, splice };
