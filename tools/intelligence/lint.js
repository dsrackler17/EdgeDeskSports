#!/usr/bin/env node
/* ===========================================================================
   THE LINT THIS REPOSITORY HAS: syntax and structure, with no dependency.

   There is no eslint or tsc here and none is being added for one change.
   What this does instead, and what CI runs:
     1. `node --check` on every JavaScript file the intelligence layer owns.
     2. The edge function, imported under Node's type stripping with the
        Deno shim — a TypeScript file that does not parse fails here.
     3. The inlined kernels are byte-identical to their canonical files.
     4. No secret-shaped string in the files this change touches.

   Run: node tools/intelligence/lint.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const JS = [
  'supabase/functions/edgedesk_ai/_research.js',
  'supabase/functions/edgedesk_ai/_analyst.js',
  'supabase/functions/edgedesk_ai/_pricing.js',
  'supabase/functions/edgedesk_ai/_board.js',
  'supabase/functions/edgedesk_ai/_stake.js',
  'supabase/functions/edgedesk_ai/_intelligence.js',
  'supabase/functions/edgedesk_ai/_presentation.js',
  'tools/presentation/inline.js',
  'tools/intelligence/research.test.js', 'tools/intelligence/evals.test.js', 'tools/intelligence/intelligence.test.js',
  'tools/intelligence/acceptance.test.js', 'tools/intelligence/conversation.test.js', 'tools/intelligence/matchup.test.js',
  'tools/intelligence/research_packets_sql.test.js', 'tools/intelligence/ledger_sql.test.js', 'tools/intelligence/lint.js',
  'tools/intelligence/board.test.js', 'tools/intelligence/board_probe_live.js',
  'tools/intelligence/stake.test.js', 'tools/intelligence/stake_sql.test.js',
  'tools/intelligence/validate_staking.js', 'tools/intelligence/staking_validation.test.js',
  'tools/intelligence/stake_grades.js', 'tools/intelligence/stake_grades.test.js', 'tools/intelligence/learning_loop.js',
  'tools/intelligence/stake_host.test.js', 'tools/intelligence/validate_extra_markets.js',
];
let bad = 0;
for (const f of JS) {
  try { cp.execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); console.log('ok    ' + f); }
  catch (e) { bad++; console.log('FAIL  ' + f + '\n' + String(e.stderr || e.message).slice(0, 400)); }
}
/* the edge function parses under type stripping */
try {
  cp.execFileSync(process.execPath, ['-e', 'globalThis.Deno={env:{get:()=>undefined}};import(process.argv[1]).then(m=>{if(!m.BUILD)throw new Error("no BUILD");process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})', path.join(ROOT, 'supabase/functions/edgedesk_ai/index.ts')], { stdio: 'pipe' });
  console.log('ok    supabase/functions/edgedesk_ai/index.ts (imports under type stripping)');
} catch (e) { bad++; console.log('FAIL  supabase/functions/edgedesk_ai/index.ts\n' + String(e.stderr || e.message).slice(0, 600)); }
/* the inlined kernels are in sync */
const sync = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools/presentation/inline.js'), '--check'], { encoding: 'utf8' });
if (sync.status !== 0) { bad++; console.log('FAIL  inlined kernels drift\n' + sync.stdout); } else console.log('ok    inlined kernels in sync');
/* no secret-shaped strings */
const SECRET = /(sk-ant-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}|sk_live_[A-Za-z0-9]{16,}|re_[A-Za-z0-9]{20,})/;
for (const f of JS.concat(['supabase/functions/edgedesk_ai/index.ts', 'supabase/research_packets.sql', '.env.example', '.github/workflows/intelligence-ci.yml'])) {
  const fp = path.join(ROOT, f); if (!fs.existsSync(fp)) continue;
  if (SECRET.test(fs.readFileSync(fp, 'utf8'))) { bad++; console.log('FAIL  secret-shaped string in ' + f); }
}
console.log(bad ? 'FAILED ' + bad + ' problem(s)' : 'ALL GREEN lint');
process.exit(bad ? 1 : 0);
