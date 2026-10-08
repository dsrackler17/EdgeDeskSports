#!/usr/bin/env node
/* ===========================================================================
   Copy, verbatim, into supabase/functions/content_engine/index.ts:
     · tools/growth/outbound_auth.js  between BEGIN/END OUTBOUND AUTH
       (the owner check every owner-only Edge Function carries; the splice is
       tools/growth/inline_outbound_auth.js's own);
     · lib/content_engine.js          between BEGIN/END CONTENT ENGINE CORE
       (the same research, validation and AI request code the admin page and
       the weekly job run).

   Why a copy and not an import: the dashboard deploy bundles ONE folder, and
   an import that cannot resolve fails the bundle while the previous version
   keeps serving (supabase/README.md). tools/content/content.test.js fails if
   either copy drifts.

   Run after editing either canonical file:  node tools/content/inline.js
   Check without writing:                    node tools/content/inline.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AUTH_INLINE = require(path.join(ROOT, 'tools', 'growth', 'inline_outbound_auth.js'));
const CORE_FILE = path.join(ROOT, 'lib', 'content_engine.js');
const TARGET = path.join(ROOT, 'supabase', 'functions', 'content_engine', 'index.ts');
const BEGIN = '// ── BEGIN CONTENT ENGINE CORE';
const END = '// ── END CONTENT ENGINE CORE';

function coreBlock() {
  return BEGIN + ' ────────────────────────────────────────────\n'
    + '// Canonical source: lib/content_engine.js, copied VERBATIM by\n'
    + '// tools/content/inline.js. Edit the canonical file, then run it.\n'
    + fs.readFileSync(CORE_FILE, 'utf8').trimEnd() + '\n'
    + END + ' ──────────────────────────────────────────────\n';
}
function spliceCore(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error('supabase/functions/content_engine/index.ts has no BEGIN/END CONTENT ENGINE CORE markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + coreBlock() + src.slice(eol < 0 ? src.length : eol + 1);
}
function build(src) { return spliceCore(AUTH_INLINE.splice(src, TARGET)); }
function drifted() { const s = fs.readFileSync(TARGET, 'utf8'); return build(s) !== s; }

if (require.main === module) {
  const check = process.argv.indexOf('--check') >= 0;
  const src = fs.readFileSync(TARGET, 'utf8'), out = build(src);
  if (out === src) { console.log('ok      ' + path.relative(ROOT, TARGET)); process.exit(0); }
  if (check) { console.log('DRIFT   ' + path.relative(ROOT, TARGET) + ' — run node tools/content/inline.js'); process.exit(1); }
  fs.writeFileSync(TARGET, out);
  console.log('updated ' + path.relative(ROOT, TARGET));
}
module.exports = { drifted, build, TARGET };
