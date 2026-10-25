#!/usr/bin/env node
/* ===========================================================================
   MARKET FORESIGHT — the worker. docs/market-foresight/README.md §The job

     node tools/foresight/run.js --dry                 compute from what is
                                                       stored; print counts
     node tools/foresight/run.js --dry --out f.json    and write the result
     node tools/foresight/run.js --write               and store it (needs
                                                       SB_URL, SB_SERVICE_ROLE)
     options: --now <ISO>  --since <ISO>  --cache <dir>  --trigger manual|cron

   1. The methodology named current in research/foresight/methodology/
      FROZEN.json is loaded and its sha256 checked. A changed file stops the
      run before anything is computed.
   2. Committed sources are read (tools/foresight/sources.js); with
      credentials, the Kalshi layer and the Collective too. A source that
      cannot be read is recorded with its reason and contributes nothing:
      its measurements fail closed, they are never estimated.
   3. lib/edgedesk_foresight.js computes everything from those records.
   4. With --write: one run row (a lease), then only the games and units whose
      input hash changed, then the complete summary set, then the finish.
      Re-running on the same records writes nothing new.

   A run that could not read a configured source is PARTIAL: it stores what
   it computed for unaffected games and keeps the previous summaries.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_foresight.js'));
const SRC = require('./sources.js');
const DB = require('./db.js');

const EXIT = { OK: 0, FAILED: 1, METHODOLOGY: 2, CONFIG: 3 };
const SEASON_START = '2026-08-01T00:00:00.000Z';

function args(argv) {
  const a = { dry: false, write: false, out: null, now: null, since: SEASON_START, cache: path.join(ROOT, '.cache', 'foresight', 'kalshi'), trigger: 'manual' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry') a.dry = true;
    else if (k === '--write') a.write = true;
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--since') a.since = argv[++i];
    else if (k === '--cache') a.cache = argv[++i];
    else if (k === '--trigger') a.trigger = argv[++i];
    else if (k === '--no-cache') a.cache = null;
  }
  if (!a.write) a.dry = true;
  return a;
}

function loadMethodology(root) {
  const frozen = JSON.parse(fs.readFileSync(path.join(root, 'research', 'foresight', 'methodology', 'FROZEN.json'), 'utf8'));
  const entry = frozen.versions[frozen.current];
  const bytes = fs.readFileSync(path.join(root, entry.file));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) {
    const e = new Error('methodology ' + frozen.current + ' no longer has the digest it was frozen with (' + digest + ' vs ' + entry.sha256 + '): a changed methodology is a new version');
    e.code = 'METHODOLOGY';
    throw e;
  }
  const spec = JSON.parse(bytes.toString('utf8'));
  if (spec.version !== frozen.current) throw Object.assign(new Error('the frozen file does not carry version ' + frozen.current), { code: 'METHODOLOGY' });
  return { version: frozen.current, sha256: digest, spec, frozen_at: entry.frozen_at };
}

/* the summaries a run stores: the whole record, and the last 30 and 7 days */
function windowedSummaries(units, M, nowMs) {
  const R = E.rules(M), out = [];
  [['all', null], ['30d', 30], ['7d', 7]].forEach(([w, days]) => {
    const us = days === null ? units : units.filter((u) => Date.parse(u.kickoff) >= nowMs - days * 86400000);
    E.summarize(us, R).forEach((s) => out.push({ window: w, key: s.key, source: s.source, model_key: s.model_key, model_label: s.model_label, model_version: s.model_version,
      sport: s.sport, market: s.market, venue: s.venue, horizon_bucket: s.horizon_bucket, evidence: s.evidence, payload: Object.assign({ window: w }, s) }));
  });
  return out;
}

function gameRow(g, units) {
  const us = units.filter((u) => u.sport === g.sport && u.event_id === g.event_id);
  return { sport: g.sport, event_id: g.event_id, kickoff: g.kickoff, home: g.home, away: g.away, state: g.state, has_kalshi: !!g.series['kalshi:moneyline'],
    n_units: us.length, n_measured: us.filter((u) => u.status === 'measured').length, input_hash: g.input_hash, payload: g };
}
function unitRow(u) {
  return { unit_key: u.unit_key, sport: u.sport, event_id: u.event_id, kickoff: u.kickoff, source: u.source, model_key: u.model_key, model_label: u.model_label,
    model_version: u.model_version, creator: u.creator, market: u.market, measure: u.measure, venue: u.venue, status: u.status,
    exclusion_reason: u.status === 'excluded' ? u.exclusion_reason : null, cls: u.metrics && u.metrics.cls || null,
    precedence: u.metrics && u.metrics.move && u.metrics.move.precedence || null, horizon_bucket: u.horizon_bucket, published_at: u.published_at,
    input_hash: u.input_hash, payload: u };
}

/* assemble, evaluate; db is optional (no credentials = committed sources only) */
async function compute(o) {
  const log = [], nowMs = Date.parse(o.now);
  const M = o.methodology.spec;
  const local = SRC.readLocal(o.root || ROOT, log);
  const sources = {
    edgedesk: { status: 'connected', files: [] }, draftkings: { status: 'connected', files: [] },
    kalshi: { status: 'not_configured', reason: 'no database credentials in this run: Kalshi is not read, and nothing is compared with it' },
    collective: { status: 'not_configured', reason: 'no database credentials in this run: the Collective is not read' }
  };
  const games = [];
  const allEvents = {};
  SRC.SPORTS.forEach((sp) => {
    const s = local.sports[sp];
    sources.edgedesk.files = sources.edgedesk.files.concat(s.edgedesk.files);
    sources.draftkings.files = sources.draftkings.files.concat(s.dk.files);
    if (!s.edgedesk.ok) sources.edgedesk.status = 'partial';
    Object.keys(s.events).forEach((id) => { allEvents[sp + '|' + id] = s.events[id]; });
  });
  let kal = {}, col = {}, affected = new Set();
  if (o.db) {
    let ver = [];
    try { ver = await o.db.rpc('mf_job_verifications', {}); } catch (e) { log.push({ level: 'error', code: 'verifications_unreadable', message: String(e.message) }); }
    for (const sp of SRC.SPORTS) {
      const ev = local.sports[sp].events;
      try {
        const k = await DB.kalshi(o.db, sp, ev, nowMs, { cacheDir: o.cache }, log);
        kal[sp] = SRC.kalshiForEvents(ev, k.links.filter((l) => l.sport === sp), k.markets, k.snaps, ver, log);
        sources.kalshi = { status: 'connected', links: (sources.kalshi.links || 0) + k.links.length, fetched: (sources.kalshi.fetched || 0) + k.fetched, cached: (sources.kalshi.cached || 0) + k.cached,
          verified_series: Array.from(new Set((ver || []).map((v) => v.series_ticker))) };
      } catch (e) {
        sources.kalshi = { status: 'error', reason: String(e.message).slice(0, 300) };
        log.push({ level: 'error', code: 'kalshi_unreadable', sport: sp, message: String(e.message).slice(0, 300) });
        Object.keys(ev).forEach((id) => { if (Date.parse(ev[id].kickoff) <= nowMs) affected.add(sp + '|' + id); });
      }
    }
    try {
      const c = await DB.collective(o.db, o.since);
      for (const sp of SRC.SPORTS) {
        const links = SRC.linkCollectiveGames(sp, local.sports[sp].events, c.games, c.teams, sp === 'nfl' ? local.nflEspn : {}, log);
        col[sp] = SRC.collectiveForecasts(sp, links, c.projections, c.models, c.creators, log);
      }
      sources.collective = { status: 'connected', games: c.games.length, projections: c.projections.length, models: c.models.length };
    } catch (e) {
      sources.collective = { status: 'error', reason: String(e.message).slice(0, 300) };
      log.push({ level: 'error', code: 'collective_unreadable', message: String(e.message).slice(0, 300) });
      Object.keys(allEvents).forEach((k) => { if (Date.parse(allEvents[k].kickoff) <= nowMs) affected.add(k); });
    }
  }
  SRC.SPORTS.forEach((sp) => {
    const s = local.sports[sp];
    Object.keys(s.events).sort().forEach((id) => {
      games.push({
        event: s.events[id],
        forecasts: s.edgedesk.forecasts.filter((f) => f.event_id === id).concat((col[sp] || []).filter((f) => f.event_id === id)),
        dk: s.dk.byGame[id] || [],
        kalshi: (kal[sp] || {})[id] || null
      });
    });
  });
  const result = E.evaluate({ games }, M, new Date(nowMs).toISOString());
  const exclusions = {};
  result.units.forEach((u) => { if (u.status === 'excluded') exclusions[u.exclusion_reason] = (exclusions[u.exclusion_reason] || 0) + 1; });
  log.push({ level: 'note', code: 'exclusions', message: 'units excluded, by reason', counts: exclusions });
  const stale = result.units.filter((u) => u.exclusion_reason === 'no_fresh_baseline' || u.exclusion_reason === 'no_valid_close').length;
  if (stale) log.push({ level: 'note', code: 'stale_or_missing_market_data', count: stale, message: 'units without a fresh baseline or a valid close (counted, never estimated)' });
  return { result, sources, log, affected, summaries: windowedSummaries(result.units, M, nowMs) };
}

async function execute(a, env, opts) {
  opts = opts || {};
  const say = opts.log || console.log, err = opts.error || console.error;
  const now = a.now || new Date().toISOString();
  let methodology;
  try { methodology = loadMethodology(opts.root || ROOT); } catch (e) { err('[foresight] ' + e.message); return EXIT.METHODOLOGY; }
  let db = null;
  const haveCreds = !!(env.SB_URL && env.SB_SERVICE_ROLE);
  if (haveCreds) { try { db = DB.client(env, { fetchImpl: opts.fetchImpl, sleep: opts.sleep, maxRequests: opts.maxRequests }); } catch (e) { err('[foresight] ' + e.message); return EXIT.CONFIG; } }
  else say('[foresight] SB_URL / SB_SERVICE_ROLE are not set: committed sources only (Kalshi and the Collective are recorded as not configured)');
  if (a.write && !db) { err('[foresight] --write needs SB_URL and SB_SERVICE_ROLE'); return EXIT.CONFIG; }

  let run = null;
  if (a.write) {
    const b = await db.rpc('mf_job_begin', { p: { methodology: { version: methodology.version, sha256: methodology.sha256, spec: methodology.spec, frozen_at: methodology.frozen_at }, trigger: a.trigger, engine: E.VERSION } });
    if (b.busy) { say('[foresight] another run holds the lease (' + b.run_id + '): nothing to do'); return EXIT.OK; }
    run = b.run_id;
  }
  let c;
  try {
    c = await compute({ methodology, now, since: a.since, db, cache: a.cache, root: opts.root });
  } catch (e) {
    err('[foresight] FAILED: ' + e.message);
    if (run) await db.rpc('mf_job_finish', { p_run: run, p: { status: 'failed', error: String(e.message).slice(0, 1000), log: [{ level: 'error', code: 'run_failed', message: String(e.message).slice(0, 500) }] } });
    return EXIT.FAILED;
  }
  const r = c.result;
  const status = c.affected.size ? 'partial' : 'ok';
  say('[foresight] ' + methodology.version + ' (' + methodology.sha256.slice(0, 12) + '…) — games ' + r.counts.games + ' (pending ' + r.counts.pending_games + '), units ' + r.counts.units + ', measured ' + r.counts.measured + ', summaries ' + c.summaries.length + ', status ' + status);
  Object.keys(c.sources).forEach((k) => say('[foresight]   source ' + k + ': ' + c.sources[k].status + (c.sources[k].reason ? ' — ' + c.sources[k].reason : '')));
  if (a.out) { fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true }); fs.writeFileSync(a.out, JSON.stringify(Object.assign({ sources: c.sources, log: c.log, windowed_summaries: c.summaries }, r))); say('[foresight] wrote ' + a.out); }
  if (!a.write) return EXIT.OK;

  try {
    const known = await db.rpc('mf_job_known', { p_version: methodology.version });
    const gRows = r.games.filter((g) => !c.affected.has(g.sport + '|' + g.event_id)).map((g) => gameRow(g, r.units)).filter((g) => known.games[g.sport + '|' + g.event_id] !== g.input_hash);
    const uRows = r.units.filter((u) => !c.affected.has(u.sport + '|' + u.event_id)).map(unitRow).filter((u) => known.units[u.unit_key] !== u.input_hash);
    const wrote = { games: { inserted: 0, updated: 0, unchanged: 0 }, units: { inserted: 0, updated: 0, unchanged: 0 } };
    for (let i = 0; i < gRows.length; i += 50) { const x = await db.rpc('mf_job_put_games', { p_run: run, p_rows: gRows.slice(i, i + 50) }); ['inserted', 'updated', 'unchanged'].forEach((k) => { wrote.games[k] += x[k]; }); }
    for (let i = 0; i < uRows.length; i += 200) { const x = await db.rpc('mf_job_put_units', { p_run: run, p_rows: uRows.slice(i, i + 200) }); ['inserted', 'updated', 'unchanged'].forEach((k) => { wrote.units[k] += x[k]; }); }
    let sums = null;
    if (status === 'ok') {
      for (let i = 0; i < c.summaries.length; i += 1500) {
        const last = i + 1500 >= c.summaries.length;
        sums = await db.rpc('mf_job_put_summaries', { p_run: run, p_rows: c.summaries.slice(i, i + 1500), p_final: last });
      }
    } else c.log.push({ level: 'warn', code: 'summaries_kept', message: 'a source could not be read: the previous summaries are kept rather than replaced with an incomplete set' });
    await db.rpc('mf_job_finish', { p_run: run, p: { status, counts: Object.assign({}, r.counts, { wrote, summaries: c.summaries.length, requests: db.used }), sources: c.sources, log: c.log,
      coverage: r.coverage, lead_lag: r.lead_lag, incremental: r.incremental } });
    say('[foresight] stored: games ' + JSON.stringify(wrote.games) + ', units ' + JSON.stringify(wrote.units) + (sums ? ', summaries ' + JSON.stringify(sums) : '') + ', requests ' + db.used);
    return status === 'ok' ? EXIT.OK : EXIT.FAILED;
  } catch (e) {
    err('[foresight] store FAILED: ' + e.message);
    try { await db.rpc('mf_job_finish', { p_run: run, p: { status: 'failed', error: String(e.message).slice(0, 1000), sources: c.sources, log: c.log } }); } catch (_) { /* the lease expires on its own */ }
    return EXIT.FAILED;
  }
}

function main() { return execute(args(process.argv.slice(2)), process.env); }

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error('[foresight] ' + (e && e.stack || e)); process.exit(EXIT.FAILED); });

module.exports = { loadMethodology, compute, execute, windowedSummaries, gameRow, unitRow, args, EXIT };
