#!/usr/bin/env node
/* ===========================================================================
   Copy two canonical files, verbatim, into
   supabase/functions/nba_injury_sync/index.ts:

     nba/injury/core.js         between BEGIN / END NBA INJURY CORE (the block
                                only; its Node module footer is not copied)
     nba/model/distribution.js  between BEGIN / END NBA DIST (the whole file:
                                the adjusted projection is priced by the
                                baseline's own distribution, not a port of it)

   Why a copy and not an import: the deploy bundles ONE folder, and an import
   that cannot resolve fails the bundle while the previous version keeps
   serving (tools/football/inline_circa_core.js, the same rule).
   tools/nba/nba_injury_core.test.js fails if either copy drifts.

   Run after editing either file:   node tools/nba/inline_injury_core.js
   Check without writing:           node tools/nba/inline_injury_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'supabase', 'functions', 'nba_injury_sync', 'index.ts');
const CORE_BEGIN = '// ── BEGIN NBA INJURY CORE', CORE_END = '// ── END NBA INJURY CORE';
const DIST_BEGIN = '// ── BEGIN NBA DIST', DIST_END = '// ── END NBA DIST';

function block(src, begin, end) { return src.slice(src.indexOf(begin), src.indexOf('\n', src.indexOf(end)) + 1); }
function core() { return block(fs.readFileSync(path.join(ROOT, 'nba', 'injury', 'core.js'), 'utf8'), CORE_BEGIN, CORE_END); }
function dist() {
  const d = fs.readFileSync(path.join(ROOT, 'nba', 'model', 'distribution.js'), 'utf8');
  return DIST_BEGIN + ' ─────────────────────────────────────────────────────\n// Canonical source: nba/model/distribution.js, copied whole by tools/nba/inline_injury_core.js.\n'
    + d.replace(/\s*$/, '\n') + DIST_END + ' ───────────────────────────────────────────────────────\n';
}
function spliceOne(src, begin, end, text) {
  const a = src.indexOf(begin), b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, TARGET) + ' has no ' + begin.slice(6) + ' / END markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + text + src.slice(eol < 0 ? src.length : eol + 1);
}
function splice(src) { return spliceOne(spliceOne(src, DIST_BEGIN, DIST_END, dist()), CORE_BEGIN, CORE_END, core()); }
function current() { const s = fs.readFileSync(TARGET, 'utf8'); return splice(s) === s; }

if (require.main === module) {
  const src = fs.readFileSync(TARGET, 'utf8'), out = splice(src);
  if (out === src) { console.log('ok      ' + path.relative(ROOT, TARGET)); process.exit(0); }
  if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, TARGET) + ' (run node tools/nba/inline_injury_core.js)'); process.exit(1); }
  fs.writeFileSync(TARGET, out); console.log('updated ' + path.relative(ROOT, TARGET));
}
module.exports = { current, splice, core, dist };
