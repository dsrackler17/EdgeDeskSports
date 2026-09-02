#!/usr/bin/env node
/* ===========================================================================
   One presentation library, three hosts. This fails the moment any host's
   inlined copy drifts from supabase/functions/edgedesk_ai/_presentation.js.
   Fix: edit the canonical file and run `node tools/presentation/inline.js`.

   Run: node tools/presentation/presentation_sync.test.js
   =========================================================================== */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'inline.js'), '--check'], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
if (r.status !== 0) { console.log('FAILED presentation library drift — run node tools/presentation/inline.js'); process.exit(1); }
console.log('ALL GREEN 3 hosts in sync');
