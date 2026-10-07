#!/usr/bin/env node
/* ===========================================================================
   Copy tools/growth/outbound_auth.js, verbatim, into every outbound Edge
   Function between its BEGIN OUTBOUND AUTH / END OUTBOUND AUTH markers.

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and
   an import that cannot resolve fails the bundle while the previous version
   keeps serving (tools/billing/inline_core.js, the same reasoning). The owner
   check is written and tested once, in tools/growth/outbound_auth.js; this
   keeps every copy that one thing. tools/growth/outbound_send.test.js fails
   if a copy drifts.

   Run after editing the canonical file:  node tools/growth/inline_outbound_auth.js
   Check without writing:                 node tools/growth/inline_outbound_auth.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE_FILE = path.join(__dirname, 'outbound_auth.js');
const TARGETS = ['growth_outbound_send', 'growth_outbound_research'].map((f) => path.join(ROOT, 'supabase', 'functions', f, 'index.ts'));
const BEGIN = '// ── BEGIN OUTBOUND AUTH';
const END = '// ── END OUTBOUND AUTH';

function block() {
  return BEGIN + ' ──────────────────────────────────────────────────\n'
    + '// Canonical source: tools/growth/outbound_auth.js, copied VERBATIM by\n'
    + '// tools/growth/inline_outbound_auth.js. Edit the canonical file, then run it.\n'
    + fs.readFileSync(CORE_FILE, 'utf8').trimEnd() + '\n'
    + END + ' ────────────────────────────────────────────────────\n';
}
function splice(src, file) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, file) + ' has no BEGIN/END OUTBOUND AUTH markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + block() + src.slice(eol < 0 ? src.length : eol + 1);
}
function drifted() { return TARGETS.filter((f) => { const s = fs.readFileSync(f, 'utf8'); return splice(s, f) !== s; }); }

if (require.main === module) {
  const check = process.argv.indexOf('--check') >= 0;
  let bad = 0;
  for (const f of TARGETS) {
    const src = fs.readFileSync(f, 'utf8'), out = splice(src, f);
    if (out === src) console.log('ok      ' + path.relative(ROOT, f));
    else if (check) { console.log('DRIFT   ' + path.relative(ROOT, f)); bad++; }
    else { fs.writeFileSync(f, out); console.log('updated ' + path.relative(ROOT, f)); }
  }
  process.exit(bad ? 1 : 0);
}
module.exports = { drifted, splice, TARGETS };
