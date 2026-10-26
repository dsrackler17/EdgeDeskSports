#!/usr/bin/env node
/* ===========================================================================
   Copy two canonical files, verbatim, into
   supabase/functions/nhl_goalie_sync/index.ts:

     hockey/goalies/core.js         between BEGIN / END NHL GOALIE CORE (the
                                    block only; its Node/browser footer is
                                    not copied)
     hockey/model/distribution.js   between BEGIN / END NHL DIST (the whole
                                    file: a pairing is priced by the slate's
                                    own distribution, not a port of it)

   Why a copy and not an import: the deploy bundles ONE folder, and an import
   that cannot resolve fails the bundle while the previous version keeps
   serving (tools/nba/inline_injury_core.js, the same rule).
   tools/hockey/nhl_goalie_core.test.js fails if either copy drifts.

   Run after editing either file:   node tools/hockey/inline_goalie_core.js
   Check without writing:           node tools/hockey/inline_goalie_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'supabase', 'functions', 'nhl_goalie_sync', 'index.ts');
const CORE_BEGIN = '// ── BEGIN NHL GOALIE CORE', CORE_END = '// ── END NHL GOALIE CORE';
const DIST_BEGIN = '// ── BEGIN NHL DIST', DIST_END = '// ── END NHL DIST';

function block(src, begin, end) { return src.slice(src.indexOf(begin), src.indexOf('\n', src.indexOf(end)) + 1); }
function core() { return block(fs.readFileSync(path.join(ROOT, 'hockey', 'goalies', 'core.js'), 'utf8'), CORE_BEGIN, CORE_END); }
function dist() {
  const d = fs.readFileSync(path.join(ROOT, 'hockey', 'model', 'distribution.js'), 'utf8');
  return DIST_BEGIN + ' ─────────────────────────────────────────────────────\n// Canonical source: hockey/model/distribution.js, copied whole by tools/hockey/inline_goalie_core.js.\n'
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
  if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, TARGET) + ' (run node tools/hockey/inline_goalie_core.js)'); process.exit(1); }
  fs.writeFileSync(TARGET, out); console.log('updated ' + path.relative(ROOT, TARGET));
}
module.exports = { current, splice, core, dist };
