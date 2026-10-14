#!/usr/bin/env node
/* ===========================================================================
   Copy lib/edgedesk_portfolio_connect_core.js, verbatim, into every function
   that carries it, between its BEGIN CONNECT CORE / END CONNECT CORE markers:
     supabase/functions/portfolio_connect/index.ts
     supabase/functions/sharpsports-webhook/index.ts

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and
   an import that cannot resolve fails the bundle while the previous version
   keeps serving (tools/billing/inline_core.js, the same reasoning). So each
   function is one self-contained file and this script keeps the shared part
   one thing. tools/portfolio/connect_core.test.js fails if a copy drifts.

   Run after editing the core:   node tools/portfolio/inline_connect_core.js
   Check without writing:        node tools/portfolio/inline_connect_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE_FILE = path.join(ROOT, 'lib', 'edgedesk_portfolio_connect_core.js');
const TARGETS = [path.join(ROOT, 'supabase', 'functions', 'portfolio_connect', 'index.ts'),
  path.join(ROOT, 'supabase', 'functions', 'sharpsports-webhook', 'index.ts')];
const TARGET = TARGETS[0];
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
function splice(src, target) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, target || TARGET) + ' has no BEGIN/END CONNECT CORE markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + block() + src.slice(eol < 0 ? src.length : eol + 1);
}
function inSync() {
  return TARGETS.every((t) => { const src = fs.readFileSync(t, 'utf8'); return splice(src, t) === src; });
}

if (require.main === module) {
  const check = process.argv.indexOf('--check') >= 0;
  let drift = false;
  TARGETS.forEach((t) => {
    const src = fs.readFileSync(t, 'utf8'), out = splice(src, t);
    if (out === src) console.log('ok      ' + path.relative(ROOT, t));
    else if (check) { console.log('DRIFT   ' + path.relative(ROOT, t)); drift = true; }
    else { fs.writeFileSync(t, out); console.log('updated ' + path.relative(ROOT, t)); }
  });
  if (drift) process.exit(1);
}
module.exports = { inSync, splice, TARGET, TARGETS };
