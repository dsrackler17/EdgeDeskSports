#!/usr/bin/env node
/* ===========================================================================
   Market Foresight — isolation from everything it must never influence.

     node tools/foresight/isolation.test.js

   Market Foresight is a separate observational layer. No ranking, grade,
   evaluation window, eligibility rule, model, model input or historical
   forecast may read it, and it may write nothing but its own mf_* rows.
   This suite proves both directions from the repository itself:

     inbound    no tracked file outside an explicit allowlist (the feature's
                own files, its docs, its page links and door map) mentions an
                mf_* object, the engine, the methodology or the SQL layer; the
                frozen ranking and grading files are named and checked one by
                one
     outbound   the engine requires nothing but lib/edgedesk_calc.js; the
                worker writes only through mf_job_* doors and reads only its
                allowlist; the methodology states the isolation rule
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const T = PG.kit('Market Foresight isolation');

const TOKEN = /\bmf_[a-z]|edgedesk_foresight|market_foresight|research\/foresight|EDForesight|tools\/foresight/;
/* the only places allowed to name the layer */
const ALLOW = [
  /^lib\/edgedesk_foresight(_ui)?\.js$/, /^foresight\//, /^tools\/foresight\//, /^research\/foresight\//,
  /^supabase\/market_foresight(_rollback)?\.sql$/, /^supabase\/migrations\/20261025120000_market_foresight\.sql$/,
  /^\.github\/workflows\/(market-foresight(-tests)?|deploy-market-foresight)\.yml$/, /^docs\/market-foresight\//,
  /^README\.md$/, /^CHANGELOG\.md$/, /^supabase\/README\.md$/, /^package\.json$/,
  /^lib\/edgedesk_plans\.js$/, /^lib\/edgedesk_flags\.js$/, /^tools\/site\/(free_access|nav)\.test\.js$/,
  /^methodology\/index\.html$/, /^app\.html$/
];
const BINARY = /\.(gz|png|jpe?g|gif|webp|ico|pdf|parquet|zip|woff2?|ttf|otf|bin|sqlite|db)$/i;

const files = cp.execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean);
const offenders = [];
files.forEach((f) => {
  if (BINARY.test(f) || ALLOW.some((rx) => rx.test(f))) return;
  let s;
  try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return; }
  if (TOKEN.test(s)) offenders.push(f);
});
T.chk('no file outside the allowlist references Market Foresight (' + files.length + ' tracked files scanned)', offenders.length === 0, offenders.slice(0, 20));

/* the frozen evaluation, named one by one */
const FROZEN = [
  'lib/football_grading.js', 'lib/edgedesk_performance.js', 'lib/edgedesk_research_grade.js', 'lib/edgedesk_pnl.js',
  'supabase/migrations/20260928120000_football_grading_v2.sql', 'supabase/lock_rule.sql', 'supabase/model_performance.sql', 'supabase/research_grades.sql',
  'supabase/functions/collective_public/index.ts', 'supabase/functions/collective_ingest/index.ts', 'supabase/functions/collective_admin/index.ts',
  'tools/performance/build.js', 'tools/performance/ledger.js', 'tools/record/football_record.js', 'tools/record/pnl_ledger.js',
  'supabase/kalshi_market_data.sql', 'supabase/signal_center.sql'
];
FROZEN.forEach((f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { T.chk(f + ' exists (the frozen list is current)', false); return; }
  T.chk(f + ' does not read Market Foresight', !TOKEN.test(fs.readFileSync(p, 'utf8')));
});
/* every model and ranking tree, whatever its file names */
['football', 'basketball', 'hockey', 'mlb', 'model_loop', 'engine', 'simulator', 'collegiate', 'college_baseball', 'performance', 'record', 'collective'].forEach((dir) => {
  const hit = files.filter((f) => f.indexOf(dir + '/') === 0 && !BINARY.test(f)).filter((f) => { try { return TOKEN.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { return false; } });
  T.chk(dir + '/ never reads Market Foresight', hit.length === 0, hit.slice(0, 5));
});

/* outbound: what the layer itself depends on and writes */
const ENGINE = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_foresight.js'), 'utf8');
const CODE = ENGINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const reqs = [...CODE.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
T.chk('the engine requires only lib/edgedesk_calc.js', reqs.length === 1 && reqs[0] === './edgedesk_calc.js', reqs);
T.chk('the engine reads no clock, network or file', !/Date\.now\(|new Date\(\)|fetch\(|XMLHttpRequest|readFileSync|process\.env/.test(CODE));
const DBJS = fs.readFileSync(path.join(ROOT, 'tools', 'foresight', 'db.js'), 'utf8');
T.chk('the worker writes only through mf_job_* doors', /\^mf_job_\[a-z_\]\+\$/.test(DBJS) && !/method:\s*'(PATCH|DELETE)'|'(PATCH|DELETE)'/.test(DBJS));
T.chk('the worker\'s reads are an allowlist of the Kalshi layer and the Collective', /kalshi_game_links\|kalshi_markets\|kalshi_price_snapshots/.test(DBJS) && /games\|teams\|models\|creators\|projections/.test(DBJS));
const RUNJS = fs.readFileSync(path.join(ROOT, 'tools', 'foresight', 'run.js'), 'utf8');
T.chk('the worker never writes into a ledger or the repository', !/writeFileSync\([^)]*(ledger|record\/|performance\/|football\/)/.test(RUNJS) && !/appendFileSync|LEDGER\.append/.test(RUNJS + fs.readFileSync(path.join(ROOT, 'tools', 'foresight', 'sources.js'), 'utf8')));
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'foresight', 'methodology', 'mf-v1.json'), 'utf8'));
T.chk('the methodology states the isolation rule and no composite score', /No ranking, grade/.test(M.isolation) && /separate measurements only/.test(M.statistics.no_composite_score));

process.exit(T.done());
