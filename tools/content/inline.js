#!/usr/bin/env node
/* ===========================================================================
   Copy, verbatim, into supabase/functions/content_engine/index.ts:
     · tools/growth/outbound_auth.js  between BEGIN/END OUTBOUND AUTH
       (the owner check every owner-only Edge Function carries; the splice is
       tools/growth/inline_outbound_auth.js's own);
     · lib/football_evidence.js       between BEGIN/END FOOTBALL EVIDENCE
       (the evidence packets' reader and the editorial gate: every AI rewrite
       the function keeps must pass it, exactly as in the page and the job);
     · lib/content_engine.js          between BEGIN/END CONTENT ENGINE CORE
       (the same research, validation and AI request code the admin page and
       the weekly job run);
     · lib/edgedesk_calc.js, edgedesk_schedule.js, edgedesk_availability.js,
       edgedesk_integrity.js, edgedesk_broadcast.js, edgedesk_matchup.js
                                      between BEGIN/END INTEGRITY LAYER, ahead
       of the core (docs/system-integrity): the core reads them from globalThis
       and fails its validation closed without them.

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
const EV_FILE = path.join(ROOT, 'lib', 'football_evidence.js');
const EV_BEGIN = '// ── BEGIN FOOTBALL EVIDENCE';
const EV_END = '// ── END FOOTBALL EVIDENCE';

function evBlock() {
  return EV_BEGIN + ' ─────────────────────────────────────────────\n'
    + '// Canonical source: lib/football_evidence.js, copied VERBATIM by\n'
    + '// tools/content/inline.js. Edit the canonical file, then run it.\n'
    + fs.readFileSync(EV_FILE, 'utf8').trimEnd() + '\n'
    + EV_END + ' ───────────────────────────────────────────────\n';
}
/* the evidence block sits immediately before the core (the core looks it up
   on globalThis at call time); added on first run if the markers are absent */
function spliceEvidence(src) {
  const a = src.indexOf(EV_BEGIN);
  if (a < 0) {
    const c = src.indexOf(BEGIN);
    if (c < 0) throw new Error('supabase/functions/content_engine/index.ts has no BEGIN CONTENT ENGINE CORE marker');
    return src.slice(0, c) + evBlock() + src.slice(c);
  }
  const b = src.indexOf(EV_END, a);
  if (b < 0) throw new Error('supabase/functions/content_engine/index.ts has BEGIN but no END FOOTBALL EVIDENCE marker');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + evBlock() + src.slice(eol < 0 ? src.length : eol + 1);
}
const IBEGIN = '// ── BEGIN INTEGRITY LAYER';
const IEND = '// ── END INTEGRITY LAYER';
/* the order matters: each file finds the ones before it on globalThis.
   edgedesk_broadcast.js and edgedesk_matchup.js carry Five Games to Watch
   (docs/content-engine/GAMES_TO_WATCH.md) */
const INTEGRITY_FILES = ['edgedesk_calc.js', 'edgedesk_schedule.js', 'edgedesk_availability.js', 'edgedesk_integrity.js', 'edgedesk_broadcast.js', 'edgedesk_matchup.js'];

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
function integrityBlock() {
  return IBEGIN + ' ──────────────────────────────────────────────\n'
    + '// Canonical sources: lib/' + INTEGRITY_FILES.join(', lib/') + ',\n'
    + '// copied VERBATIM by tools/content/inline.js. Edit the canonical files, then run it.\n'
    + INTEGRITY_FILES.map((f) => '// ── lib/' + f + '\n' + fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8').trimEnd() + '\n').join('')
    + IEND + ' ────────────────────────────────────────────────\n';
}
/* the integrity layer sits immediately before the core block; on the first
   run it is inserted there */
function spliceIntegrity(src) {
  const a = src.indexOf(IBEGIN);
  if (a >= 0) {
    const b = src.indexOf(IEND, a);
    if (b < 0) throw new Error('supabase/functions/content_engine/index.ts has a BEGIN without an END INTEGRITY LAYER marker');
    const eol = src.indexOf('\n', b);
    return src.slice(0, a) + integrityBlock() + src.slice(eol < 0 ? src.length : eol + 1);
  }
  const c = src.indexOf(BEGIN);
  if (c < 0) throw new Error('supabase/functions/content_engine/index.ts has no BEGIN CONTENT ENGINE CORE marker');
  return src.slice(0, c) + integrityBlock() + src.slice(c);
}
/* order before the core: the integrity layer, then the football evidence module */
function build(src) { return spliceCore(spliceEvidence(spliceIntegrity(AUTH_INLINE.splice(src, TARGET)))); }
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
