#!/usr/bin/env node
/* ===========================================================================
   THE LINT THIS REPOSITORY HAS: syntax and structure, with no dependency.

   There is no eslint or tsc here and none is being added for one change.
   What this does instead, and what CI runs:
     1. `node --check` on every JavaScript file the intelligence layer owns.
     2. The edge function and the research library, imported under Node's type
        stripping with the Deno shim — a TypeScript file that does not parse
        fails here.
     3. The inlined kernels are byte-identical to their canonical files.
     4. Every file in the function's directory can still be opened on GitHub.
     5. No secret-shaped string in the files this change touches.

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
/* the TypeScript files parse under type stripping. _lib.ts is checked on its
   own and not only through index.ts: it is the canonical copy now, so a
   syntax error in it has to fail BEFORE the inliner carries it into the file
   that gets deployed. */
const TS = [
  { f: 'supabase/functions/edgedesk_ai/index.ts', want: 'BUILD' },
  { f: 'supabase/functions/edgedesk_ai/_lib.ts', want: 'budgetEvidence' },
];
for (const t of TS) {
  try {
    cp.execFileSync(process.execPath, ['-e', 'globalThis.Deno={env:{get:()=>undefined}};import(process.argv[1]).then(m=>{if(!m[process.argv[2]])throw new Error("no "+process.argv[2]);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})', path.join(ROOT, t.f), t.want], { stdio: 'pipe' });
    console.log('ok    ' + t.f + ' (imports under type stripping)');
  } catch (e) { bad++; console.log('FAIL  ' + t.f + '\n' + String(e.stderr || e.message).slice(0, 600)); }
}
/* the inlined kernels are in sync */
const sync = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools/presentation/inline.js'), '--check'], { encoding: 'utf8' });
if (sync.status !== 0) { bad++; console.log('FAIL  inlined kernels drift\n' + sync.stdout); } else console.log('ok    inlined kernels in sync');

/* ---- every file in the function's directory can still be opened ----------
   GitHub renders no blob over 1 MB. Not a truncated view — no view, no search
   inside the file, no web editor, nothing. index.ts crossed that line and took
   PART 1 over with it, because PART 1 had no canonical file: the header named
   _lib.ts as its source of truth and _lib.ts did not exist, so 8,885 lines of
   the research library could be read nowhere but a local clone. That is fixed.
   This is what keeps it fixed, because the next kernel to grow will do the
   same thing quietly.

   index.ts is exempt because it is GENERATED — most of it is copied in from
   the files beside it by the inliner. The exemption is EARNED, not granted:
   what is not inside a marker pair has no canonical copy anywhere, so it is
   measured on its own and held to the same ceiling. When PART 2 reaches it,
   the answer is the one applied to PART 1, not a bigger number here.

   Scope is this one directory, deliberately. app.html carries the same
   problem at 3.8 MB and is not addressed by this change; a browser page that
   has to load in one request is a different fix, and claiming otherwise here
   would make this check a lie. */
const RENDER_LIMIT = 1024 * 1024;
const GENERATED = 'index.ts';
const FN_DIR = path.join(ROOT, 'supabase/functions/edgedesk_ai');
const { LIBS } = require(path.join(ROOT, 'tools/presentation/inline.js'));
for (const name of fs.readdirSync(FN_DIR).sort()) {
  const full = path.join(FN_DIR, name);
  if (!fs.statSync(full).isFile()) continue;
  let text = fs.readFileSync(full, 'utf8');
  let what = '';
  if (name === GENERATED) {
    for (const lib of LIBS) {
      const a = text.indexOf(lib.start), b = text.indexOf(lib.end);
      if (a >= 0 && b > a) text = text.slice(0, a) + text.slice(b + lib.end.length);
    }
    what = ' of its own source, outside every marker pair';
  }
  const bytes = Buffer.byteLength(text);
  const kb = Math.round(bytes / 1024) + ' KB';
  if (bytes > RENDER_LIMIT) {
    bad++;
    console.log('FAIL  ' + name + ' is ' + kb + what + ', over the 1 MB GitHub will render. ' +
      'Nobody can open it in a browser. Split it the way _lib.ts was split: move the block to a ' +
      'canonical file, leave a marker pair behind, register it in tools/presentation/inline.js.');
  } else {
    console.log('ok    ' + name + ' ' + kb + what + ' (openable)');
  }
}

/* no secret-shaped strings */
const SECRET = /(sk-ant-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}|sk_live_[A-Za-z0-9]{16,}|re_[A-Za-z0-9]{20,})/;
for (const f of JS.concat(['supabase/functions/edgedesk_ai/index.ts', 'supabase/functions/edgedesk_ai/_lib.ts', 'supabase/research_packets.sql', '.env.example', '.github/workflows/intelligence-ci.yml'])) {
  const fp = path.join(ROOT, f); if (!fs.existsSync(fp)) continue;
  if (SECRET.test(fs.readFileSync(fp, 'utf8'))) { bad++; console.log('FAIL  secret-shaped string in ' + f); }
}
console.log(bad ? 'FAILED ' + bad + ' problem(s)' : 'ALL GREEN lint');
process.exit(bad ? 1 : 0);
