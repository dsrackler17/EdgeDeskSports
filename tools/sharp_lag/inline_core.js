#!/usr/bin/env node
/* ===========================================================================
   Copy lib/edgedesk_sharp_lag.js, verbatim and whole, into the two Sharp-lag
   Edge Functions between their BEGIN / END SHARP LAG CORE markers, and write
   the NBA and NHL club names they match provider events with between the
   BEGIN / END SHARP LAG IDENTITY markers:
     supabase/functions/sharp_lag/index.ts     the free job
     supabase/functions/sharp_check/index.ts   the paid dispatcher

   Why a copy and not an import: the dashboard deploy bundles ONE folder
   (tools/kalshi/inline_identity.js, the same rule). The flags the job writes
   and the sections the pages draw come from the same arithmetic, so a Pinnacle
   fair, a fee or a gap cannot be one number in the database and another on the
   page. tools/sharp_lag/sharp_lag_fn.test.js fails if a copy drifts.

   The identity tables: nba/data/teams.json (the ESPN id -> full name the NBA
   quote matcher uses, with its LA aliases) and hockey/data/teams.json (the
   abbreviation -> name and aliases, active clubs only).

   Run after editing lib/edgedesk_sharp_lag.js:  node tools/sharp_lag/inline_core.js
   Check without writing:                        node tools/sharp_lag/inline_core.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE_BEGIN = '// ── BEGIN SHARP LAG CORE', CORE_END = '// ── END SHARP LAG CORE';
const ID_BEGIN = '// ── BEGIN SHARP LAG IDENTITY', ID_END = '// ── END SHARP LAG IDENTITY';
const TARGETS = ['sharp_lag', 'sharp_check'].map((f) => path.join(ROOT, 'supabase', 'functions', f, 'index.ts'));

/* the NBA quote matcher's own aliases (nba/market/quotes.js ALIASES) */
const NBA_ALIASES = { 12: ['LA Clippers', 'Los Angeles Clippers'], 13: ['LA Lakers', 'Los Angeles Lakers'] };

function identity() {
  const nba = {}, nhl = {};
  const nt = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'data', 'teams.json'), 'utf8'));
  Object.keys(nt).sort((a, b) => Number(a) - Number(b)).forEach((id) => {
    if (!(Number(id) > 0) || /^TBD$/.test(nt[id])) return;
    nba[id] = [nt[id]].concat((NBA_ALIASES[id] || []).filter((a) => a !== nt[id]));
  });
  const ht = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'data', 'teams.json'), 'utf8')).teams;
  Object.keys(ht).sort().forEach((ab) => {
    const t = ht[ab]; if (t.inactive_since) return;
    nhl[ab] = [t.name].concat((t.aliases || []).filter((a) => a !== t.name));
  });
  return { nba, nhl };
}

function blocks() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_sharp_lag.js'), 'utf8');
  const core = CORE_BEGIN + ' ── copied from lib/edgedesk_sharp_lag.js by tools/sharp_lag/inline_core.js; do not edit here\n'
    + src.replace(/\s*$/, '\n') + CORE_END + ' ──\n';
  const id = ID_BEGIN + ' ── generated from nba/data/teams.json and hockey/data/teams.json by tools/sharp_lag/inline_core.js; do not edit here\n'
    + '(globalThis as any).SHARP_LAG_IDENTITY = ' + JSON.stringify(identity()) + ';\n' + ID_END + ' ──\n';
  return { core, id };
}

function spliceOne(src, begin, end, body, file) {
  const a = src.indexOf(begin), b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(path.relative(ROOT, file) + ' has no ' + begin.replace('// ── ', '') + ' markers');
  const eol = src.indexOf('\n', b);
  return src.slice(0, a) + body + src.slice(eol < 0 ? src.length : eol + 1);
}
function splice(src, file) {
  const b = blocks();
  return spliceOne(spliceOne(src, CORE_BEGIN, CORE_END, b.core, file), ID_BEGIN, ID_END, b.id, file);
}
function current() { return TARGETS.every((f) => { const s = fs.readFileSync(f, 'utf8'); return splice(s, f) === s; }); }

if (require.main === module) {
  let stale = 0;
  for (const f of TARGETS) {
    const src = fs.readFileSync(f, 'utf8'), out = splice(src, f);
    if (out === src) { console.log('ok      ' + path.relative(ROOT, f)); continue; }
    if (process.argv.includes('--check')) { console.log('DRIFT   ' + path.relative(ROOT, f) + ' (run node tools/sharp_lag/inline_core.js)'); stale++; continue; }
    fs.writeFileSync(f, out); console.log('updated ' + path.relative(ROOT, f));
  }
  process.exit(stale ? 1 : 0);
}
module.exports = { current, splice, identity, TARGETS };
