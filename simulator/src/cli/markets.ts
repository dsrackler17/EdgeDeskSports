/* ===========================================================================
   edgedesk-sim markets — compare a published run with Kalshi futures.

     node simulator/src/cli/markets.ts --results simulator/out/<dir>/results.json [--run-id <uuid>] [--publish]

   A separate step from the simulation, on purpose: a Kalshi outage or a
   refused comparison never invalidates a complete simulation. Exit codes:
   0 compared (or unavailable: no verified mapping), 2 bad arguments or an
   invalid mapping, 4 the market fetch or the comparison publication failed
   (the simulation stays published; the failure is recorded as a DEGRADED
   alert and old quotes are never shown as fresh).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFutures, validateFuturesConfig, type FuturesConfig, type RunView } from '../markets/compare.ts';
import { kalshiClient, fetchQuotes } from '../markets/kalshi.ts';
import { postgrestDb, type SimDb } from '../publish/db.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FUTURES_CONFIG = path.join(SIM, 'config', 'kalshi_futures.json');

export function runView(results: any): RunView {
  return { sport: results.run.sport, competition: results.run.competition, season: results.run.season,
    entities: results.entities.map((e: any) => ({ entity_id: e.entity_id, outcomes: Object.fromEntries(Object.entries(e.outcomes).map(([k, o]: [string, any]) => [k, { probability: o.probability, mcse: o.mcse }])) })),
    ...(results.outcome_semantics ? { outcome_semantics: results.outcome_semantics } : {}) };
}

/** the mappings of one sport, and the outcome sets they use: one config file serves every sport's run */
export function forSport(cfg: FuturesConfig, sport: string): FuturesConfig {
  const mappings = cfg.mappings.filter((m) => m.sport === sport);
  const used = new Set(mappings.map((m) => m.outcome_set).filter(Boolean));
  return { ...cfg, mappings, outcome_sets: cfg.outcome_sets.filter((s) => used.has(s.id)) };
}

export async function marketStep(opt: { results: any; runId: string | null; publish: boolean; cfg?: FuturesConfig; db?: SimDb; fetchImpl?: typeof fetch; log?: (s: string) => void; now?: Date }) {
  const log = opt.log || console.log;
  const run = runView(opt.results);
  const cfg = forSport(opt.cfg || JSON.parse(fs.readFileSync(FUTURES_CONFIG, 'utf8')) as FuturesConfig, run.sport);
  const errs = validateFuturesConfig(cfg, run);
  if (errs.length) throw Object.assign(new Error('invalid futures mapping: ' + errs.join('; ')), { exitCode: 2 });
  const live = cfg.mappings.filter((m) => m.status === 'verified');
  if (!live.length) {
    log('market comparison unavailable: no verified Kalshi mapping for ' + run.sport + ' ' + run.season + ' (simulator/config/kalshi_futures.json). Nothing fetched, nothing written.');
    return { status: 'unavailable' as const, rows: [] };
  }
  const db = opt.publish ? (opt.db || postgrestDb()) : null;
  let comparisonId: string | null = null;
  try {
    if (db) {
      if (!opt.runId) throw new Error('--run-id (the published run) is required to publish a comparison');
      comparisonId = await db.rpc('sim_begin_comparison', { p: { run_id: opt.runId, mapping_version: cfg.mapping_version, expected: { edges: live.length } } }) as string;
    }
    const quotes = await fetchQuotes(kalshiClient({ fetchImpl: opt.fetchImpl }), live.map((m) => m.market_ticker));
    const cmp = compareFutures(cfg, run, quotes, opt.now || new Date());
    log(cmp.note + (cmp.excluded.length ? ' — excluded: ' + cmp.excluded.map((x) => x.mapping_id + ' (' + x.reason + ')').join('; ') : ''));
    if (db && comparisonId) {
      const ids = await db.rpc('sim_put_quotes', { p_comparison: comparisonId, p_rows: [...quotes.values()] }) as Record<string, number>;
      /* the edge rows the database expects: one per compared market; excluded mappings are recorded in the methodology */
      await db.rpc('sim_put_edges', { p_comparison: comparisonId, p_rows: cmp.rows.map((r) => ({ ...r, quote_id: ids[r.market_ticker] })) });
      if (cmp.rows.length !== live.length) {
        await db.rpc('sim_fail_comparison', { p_comparison: comparisonId, p_error: { code: 'markets_excluded', message: cmp.excluded.length + ' mapped markets were excluded: ' + cmp.excluded.map((x) => x.reason).join('; ') } });
        throw Object.assign(new Error('comparison incomplete: ' + cmp.excluded.length + ' mapped markets excluded'), { exitCode: 4, recorded: true });
      }
      const pub = await db.rpc('sim_publish_comparison', { p_comparison: comparisonId });
      log('comparison publication: ' + JSON.stringify(pub));
    }
    return { status: 'compared' as const, rows: cmp.rows, comparison: cmp };
  } catch (e) {
    if (db && comparisonId && !(e as any).recorded) {
      try { await db.rpc('sim_fail_comparison', { p_comparison: comparisonId, p_error: { code: 'market_failure', message: String((e as Error).message).slice(0, 500) } }); } catch (_) { /* reported below */ }
    }
    throw Object.assign(e as Error, { exitCode: (e as any).exitCode || 4 });
  }
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  (async () => {
    const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    const file = get('--results');
    if (!file || !fs.existsSync(file)) { console.error('error: --results <results.json> is required'); process.exit(2); }
    const runId = get('--run-id');
    if (runId && !/^[0-9a-f-]{36}$/.test(runId)) { console.error('error: --run-id must be a uuid'); process.exit(2); }
    try {
      const out = await marketStep({ results: JSON.parse(fs.readFileSync(file, 'utf8')), runId, publish: a.includes('--publish') });
      fs.writeFileSync(path.join(path.dirname(file), 'comparison.json'), JSON.stringify(out, null, 1));
    } catch (e) {
      console.error('market step failed: ' + (e as Error).message + ' — the simulation is unaffected');
      process.exit((e as any).exitCode || 4);
    }
  })();
}
