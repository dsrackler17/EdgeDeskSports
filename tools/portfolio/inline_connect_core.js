#!/usr/bin/env node
/* ===========================================================================
   Copy lib/edgedesk_portfolio_connect_core.js, verbatim, into
   supabase/functions/portfolio_connect/index.ts between its BEGIN CONNECT CORE
   / END CONNECT CORE markers.

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and
   an import that cannot resolve fails the bundle while the previous version
   keeps serving (tools/billing/inline_core.js, the same reasoning). So the
   function is one self-contained file and this script keeps the shared part
   one thing. tools/portfolio/connect_core.test.js fails if the copy drifts.

   Run after editing the core:   node tools/portfolio/inline_connect_core.js
   Check without writing:        node tools/portfolio/inline_connect_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE_FILE = path.join(ROOT, 'lib', 'edgedesk_portfolio_connect_core.js');
const TARGET = path.join(ROOT, 'supabase', 'functions', 'portfolio_connect', 'index.ts');
const BEGIN = '// ── BEGIN CONNECT CORE';
const END = '// ── END CONNECT CORE';

function block() {
  const core = fs.readFileSync(CORE_FILE, 'utf8').trimEnd();
  return BEGIN + ' ──────────────────────────────────────────────────\n'
    + '// Canonical source: lib/edgedesk_portfolio_connect_core.js, copied VERBATIM by\n'
    + '// tools/portfolio/inline_connect_core.js. Edit the canonical file, then run it.\n'
    + core + '\n'
    + END + ' ────────────────────────────────────────────────────\n';
}
function splice(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, TARGET) + ' has no BEGIN/END CONNECT CORE markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + block() + src.slice(eol < 0 ? src.length : eol + 1);
}
function inSync() { const src = fs.readFileSync(TARGET, 'utf8'); return splice(src) === src; }

if (require.main === module) {
  const check = process.argv.indexOf('--check') >= 0;
  const src = fs.readFileSync(TARGET, 'utf8'), out = splice(src);
  if (out === src) console.log('ok      ' + path.relative(ROOT, TARGET));
  else if (check) { console.log('DRIFT   ' + path.relative(ROOT, TARGET)); process.exit(1); }
  else { fs.writeFileSync(TARGET, out); console.log('updated ' + path.relative(ROOT, TARGET)); }
}
module.exports = { inSync, splice, TARGET };
