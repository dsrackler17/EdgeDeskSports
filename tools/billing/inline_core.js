#!/usr/bin/env node
/* ===========================================================================
   Copy tools/billing/billing_core.js, verbatim, into every billing Edge
   Function, between its BEGIN BILLING CORE / END BILLING CORE markers.

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and an
   import that cannot resolve fails the bundle while the previous version keeps
   serving — indistinguishable from a deploy that worked. So each function is
   one self-contained file, and this script is how the shared part stays one
   thing. tools/billing/billing_core.test.js fails if a copy drifts.

   Run after editing billing_core.js:   node tools/billing/inline_core.js
   Check without writing:               node tools/billing/inline_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE = fs.readFileSync(path.join(__dirname, 'billing_core.js'), 'utf8').trimEnd() + '\n';
const TARGETS = ['stripe_webhook', 'create_checkout_session', 'sync_subscription']
  .map((f) => path.join(ROOT, 'supabase', 'functions', f, 'index.ts'));
const BEGIN = '// ── BEGIN BILLING CORE';
const END = '// ── END BILLING CORE';

function splice(src, file) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, file) + ' has no BEGIN/END BILLING CORE markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + CORE + src.slice(eol < 0 ? src.length : eol + 1);
}

const check = process.argv.indexOf('--check') >= 0;
let drift = 0;
for (const f of TARGETS) {
  const src = fs.readFileSync(f, 'utf8');
  const out = splice(src, f);
  if (out === src) { console.log('ok      ' + path.relative(ROOT, f)); continue; }
  drift++;
  if (check) console.log('DRIFT   ' + path.relative(ROOT, f));
  else { fs.writeFileSync(f, out); console.log('updated ' + path.relative(ROOT, f)); }
}
if (check && drift) process.exit(1);
