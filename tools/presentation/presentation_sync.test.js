#!/usr/bin/env node
/* ===========================================================================
   Two shared libraries, several hosts each. This fails the moment any host's
   inlined copy drifts from its canonical file:
     EDPRES  <- supabase/functions/edgedesk_ai/_presentation.js
     EDINTEL <- supabase/functions/edgedesk_ai/_intelligence.js
   Fix: edit the canonical file and run `node tools/presentation/inline.js`.

   Run: node tools/presentation/presentation_sync.test.js
   =========================================================================== */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'inline.js'), '--check'], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
if (r.status !== 0) { console.log('FAILED shared library drift — run node tools/presentation/inline.js'); process.exit(1); }
const pairs = (r.stdout || '').split('\n').filter(function (l) { return /^in sync:/.test(l); }).length;
console.log('ALL GREEN ' + pairs + ' library/host pairs in sync');
