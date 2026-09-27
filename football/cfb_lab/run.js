/* ============================================================================
   CFB Model Lab — the hourly job (called by .github/workflows/cfb-lab.yml,
   which pg_cron dispatches every hour; the workflow's own schedule is the
   backup). Each step is isolated: a failed feed is logged and the other steps
   still run, because a missed checkpoint window can never be re-taken.

     1. governance seed   (idempotent)
     2. market capture    ESPN scoreboard + CFBD ledger (+ Supabase odds_api quotes when keys exist)
     3. freeze import     V2 Tuesday freezes -> WEEKLY_FREEZE rows
     4. checkpoints       every model x game whose window is open now
     5. audit             governed facts changed? -> audit log
     6. settle            results, openers/closes, grading, miss reviews
     7. reports           lab.json, season, weekly (once), promotion, public record
     8. verify            the ledger is intact (ids, hashes, one row per checkpoint)

     node football/cfb_lab/run.js [--season 2026] [--now ISO] [--offline] [--skip settle,report]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const GOV = require('./governance.js');
const MK = require('./market.js');
const CP = require('./checkpoint.js');
const M = require('./models.js');
const ST = require('./settle.js');
const RP = require('./report.js');

const U = L.util;

async function run(opts) {
  opts = opts || {};
  const now = U.iso(opts.now || new Date());
  const season = opts.season || JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).season;
  const skip = new Set(opts.skip || []);
  const store = new G.Store(season, opts.storeOpts);
  const log = { started_at: now, season, steps: {} };
  const step = async (name, fn) => {
    if (skip.has(name)) { log.steps[name] = { skipped: true }; return; }
    const t0 = Date.now();
    try { log.steps[name] = Object.assign({ ok: true }, await fn()); }
    catch (e) { log.steps[name] = { ok: false, error: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') }; }
    log.steps[name].ms = Date.now() - t0;
  };
  await step('seed', () => GOV.seed(store));
  let supa = null;
  await step('supabase_pull', async () => {
    if (opts.offline || !process.env.SB_URL || !process.env.SB_SERVICE_ROLE) return { skipped: 'no Supabase credentials (odds_api per-book quotes are optional)' };
    supa = await require('./sync_supabase.js').pullQuotes(season, now);
    return { quotes: supa.length };
  });
  await step('market', () => MK.capture(season, now, { espn: !opts.offline, cfbd: true, supabaseQuotes: supa || undefined, storeOpts: opts.storeOpts, espnPayloads: opts.espnPayloads }));
  await step('freeze_import', () => CP.importFreezes({ season, storeOpts: opts.storeOpts }));
  let models = null;
  await step('checkpoints', () => { models = M.loadModels(['v1', 'v2.1', 'c001'], opts.modelOpts); return CP.run({ now, season, models, storeOpts: opts.storeOpts }); });
  await step('audit', () => ({ events: models ? GOV.detectChanges(store, models, now).length : 0 }));
  await step('settle', () => ST.run({ now, season, offline: opts.offline, storeOpts: opts.storeOpts, espnPayloads: opts.espnPayloads, cfbfastrCsv: opts.cfbfastrCsv }));
  await step('report', () => RP.run({ now, season, storeOpts: opts.storeOpts, outDir: opts.outDir, publicPath: opts.publicPath }));
  await step('verify', () => { const p = G.verify({ base: opts.base || null }); if (p.length) throw new Error(p.length + ' ledger problem(s): ' + p.slice(0, 5).join('; ')); return { problems: 0 }; });
  log.finished_at = new Date().toISOString();
  log.ok = Object.values(log.steps).every((s) => s.ok !== false);
  const dir = opts.outDir || path.join(G.LAB, 'reports', String(season));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last_run.json'), JSON.stringify(log, null, 1) + '\n');
  return log;
}

module.exports = { run };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  run({ now: arg('--now', null), season: arg('--season', null) ? Number(arg('--season')) : null, offline: a.includes('--offline'),
    skip: (arg('--skip', '') || '').split(',').filter(Boolean), base: arg('--base', null) })
    .then((log) => { console.log(JSON.stringify(log, null, 1)); if (!log.ok) process.exitCode = 1; })
    .catch((e) => { console.error(e); process.exit(1); });
}
