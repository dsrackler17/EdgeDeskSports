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

   Provider calls go through providers.js (timeouts, bounded retries, circuit
   breakers). Breaker state persists in reports/<season>/provider_health.json
   so a provider that keeps failing is not hammered hour after hour; the
   freshness of every critical source is written to last_run.json (freshness).

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
const I = require('./integrity.js');

const U = L.util;

async function run(opts) {
  opts = opts || {};
  const now = U.iso(opts.now || new Date());
  const season = opts.season || JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).season;
  const skip = new Set(opts.skip || []);
  const store = new G.Store(season, opts.storeOpts);
  const log = { started_at: now, season, steps: {} };
  const dir0 = opts.outDir || path.join(G.LAB, 'reports', String(season));
  const healthFile = path.join(dir0, 'provider_health.json');
  let health = { breakers: {} };
  try { health = JSON.parse(fs.readFileSync(healthFile, 'utf8')); if (!health.breakers) health.breakers = {}; } catch (e) { /* first run */ }
  let schedule = {};
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
  await step('market', async () => {
    const r = await MK.capture(season, now, { espn: !opts.offline, cfbd: true, supabaseQuotes: supa || undefined, storeOpts: opts.storeOpts, espnPayloads: opts.espnPayloads,
      breakerState: health.breakers.espn_scoreboard, fetchText: opts.fetchText, sleep: opts.sleep });
    schedule = r.schedule || {};
    if (r.log && r.log.espn && r.log.espn.breaker) health.breakers.espn_scoreboard = r.log.espn.breaker;
    const o = Object.assign({}, r); delete o.schedule; o.schedule_games = Object.keys(schedule).length;
    return o;
  });
  await step('freeze_import', () => CP.importFreezes({ season, storeOpts: opts.storeOpts }));
  let models = null;
  await step('checkpoints', () => { models = M.loadModels(['v1', 'v2.1', 'c001'], opts.modelOpts); return CP.run({ now, season, models, storeOpts: opts.storeOpts, schedule }); });
  await step('audit', () => ({ events: models ? GOV.detectChanges(store, models, now).length : 0 }));
  await step('settle', async () => {
    const r = await ST.run({ now, season, offline: opts.offline, storeOpts: opts.storeOpts, espnPayloads: opts.espnPayloads, cfbfastrCsv: opts.cfbfastrCsv,
      cfbfastrBreakerState: health.breakers.cfbfastr_schedule, espnBreakerState: health.breakers.espn_scoreboard });
    if (r.breakers && r.breakers.cfbfastr_schedule) health.breakers.cfbfastr_schedule = r.breakers.cfbfastr_schedule;
    if (r.breakers && r.breakers.espn_scoreboard) health.breakers.espn_scoreboard = r.breakers.espn_scoreboard;
    return r;
  });
  await step('report', () => RP.run({ now, season, storeOpts: opts.storeOpts, outDir: opts.outDir, publicPath: opts.publicPath }));
  await step('verify', () => { const p = G.verify({ base: opts.base || null }); if (p.length) throw new Error(p.length + ' ledger problem(s): ' + p.slice(0, 5).join('; ')); return { problems: 0 }; });
  log.freshness = sourceFreshness(store, now, season);
  log.finished_at = new Date().toISOString();
  log.ok = Object.values(log.steps).every((s) => s.ok !== false);
  const dir = dir0;
  fs.mkdirSync(dir, { recursive: true });
  if (!opts.offline) {
    health.updated_at = now;
    health.note = 'Circuit-breaker state per provider (football/cfb_lab/providers.js). OPEN = not called until the cooldown passes; the stored data ages and is marked stale.';
    fs.writeFileSync(healthFile, JSON.stringify(health, null, 1) + '\n');
  }
  fs.writeFileSync(path.join(dir, 'last_run.json'), JSON.stringify(log, null, 1) + '\n');
  return log;
}

/* Freshness of every source the lab depends on (integrity.FRESHNESS; §12):
   the newest odds quote by its TRUE age (provider_updated_at when the provider
   gives one), the board's schedule build, the V2 feature build, the newest
   result. Each is FRESH, STALE, MISSING or CLOCK_FAULT against its limit. */
function sourceFreshness(store, now, season) {
  const rd = (p) => { try { return JSON.parse(fs.readFileSync(path.join(G.REPO, p), 'utf8')); } catch (e) { return null; } };
  const out = { rule: I.RULES.freshness, at: now };
  try {
    const qs = store.quotes().filter((q) => q.is_pregame !== false && !q.is_provider_open && !q.is_provider_close);
    const t = U.ms(now);
    const upcoming = qs.filter((q) => U.ms(q.kickoff_ts) > t);
    const base = (q) => { const o = U.ms(q.observed_at), u = U.ms(q.provider_updated_at); return (u !== null && u < o) ? u : o; };
    const newest = upcoming.reduce((m, q) => Math.max(m, base(q) || 0), 0);
    out.odds = I.freshnessOf('odds', newest ? new Date(newest).toISOString() : null, now, 24);
    out.odds.upcoming_quotes = upcoming.length;
  } catch (e) { out.odds = { status: 'ERROR', error: e.message }; }
  const slate = rd('football/fbs/slate.json'), cur = rd('football/cfb_v2/current.json');
  out.schedule = I.freshnessOf('schedule', slate && slate.generated_at, now);
  out.model_features = I.freshnessOf('pbp', cur && cur.generated_at, now);
  try { const rs = store.results(); out.results_newest = rs.reduce((m, r) => (U.ms(r.recorded_at) > U.ms(m) ? r.recorded_at : m), null); } catch (e) { out.results_newest = null; }
  return out;
}

module.exports = { run, sourceFreshness };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  run({ now: arg('--now', null), season: arg('--season', null) ? Number(arg('--season')) : null, offline: a.includes('--offline'),
    skip: (arg('--skip', '') || '').split(',').filter(Boolean), base: arg('--base', null) })
    .then((log) => { console.log(JSON.stringify(log, null, 1)); if (!log.ok) process.exitCode = 1; })
    .catch((e) => { console.error(e); process.exit(1); });
}
