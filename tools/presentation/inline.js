#!/usr/bin/env node
/* ===========================================================================
   Inline the canonical presentation library into every host that carries it.

   ONE SOURCE: supabase/functions/edgedesk_ai/_presentation.js
   FOUR HOSTS: supabase/functions/edgedesk_ai/index.ts, app.html, brief.html, record.html

   Each host carries a marker pair and this replaces everything between them
   with the canonical block, byte for byte. presentation_sync.test.js fails
   when a host drifts, so the fix is always "edit the canonical file, run
   this". Run: node tools/presentation/inline.js   (add --check to only verify)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js');
const HOSTS = [
  path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'),
  path.join(ROOT, 'app.html'),
  path.join(ROOT, 'brief.html'),
  path.join(ROOT, 'record.html'),
];
const START = '/*__EDPRES_START__*/';
const END = '/*__EDPRES_END__*/';

function block(src) {
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0 || b <= a) return null;
  return src.slice(a, b + END.length);
}

function main(check) {
  const canonical = block(fs.readFileSync(SRC, 'utf8'));
  if (!canonical) throw new Error('canonical file has no marker block');
  let drift = 0;
  for (const host of HOSTS) {
    if (!fs.existsSync(host)) { console.log('skip (missing): ' + path.relative(ROOT, host)); continue; }
    const text = fs.readFileSync(host, 'utf8');
    const have = block(text);
    if (!have) { console.log('NO MARKERS: ' + path.relative(ROOT, host)); drift++; continue; }
    if (have === canonical) { console.log('in sync: ' + path.relative(ROOT, host)); continue; }
    drift++;
    if (check) { console.log('DRIFT: ' + path.relative(ROOT, host)); continue; }
    fs.writeFileSync(host, text.replace(have, function () { return canonical; }));
    console.log('updated: ' + path.relative(ROOT, host));
  }
  if (check && drift) process.exit(1);
}
main(process.argv.includes('--check'));
