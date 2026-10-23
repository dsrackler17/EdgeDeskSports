#!/usr/bin/env node
/* ===========================================================================
   SIGNAL CENTER — one evaluation run: read every source, find what changed,
   store it, draw its graphics, tell the readers who asked.
   docs/signal-center/README.md §4 (the worker), DEPLOYMENT.md (the job)

     node tools/signal_center/run.js --dry-run              no database: evaluate the
                                                             committed sources, write
                                                             .cache/signal_center/run.json
     node tools/signal_center/run.js                         SB_URL + SB_SERVICE_ROLE:
                                                             the full run (the hourly job)
     --now 2026-10-23T20:30:00Z   evaluate as of a time (replay; never in production)
     --out <dir>                   where a dry run writes
     --fixture <payloads.json>     CONTROLLED payloads, each marked fixture:true; the
                                   database refuses them unless sc_config.allow_fixtures
                                   is on, and never publishes one

   THE RUN (each step a job door in supabase/signal_center.sql)
     1  sc_begin_run          one run at a time (a lease); a second exits quietly
     2  sources               the committed files, then the database layers
                              (Simulator runs, NBA injury reports, Kalshi, the stored
                              divergences); a layer that fails removes only its own
                              signals, and is recorded
     3  evaluate              lib/edgedesk_signal_engine.js, eligibility from
                              lib/edgedesk_signal_registry.js
     4  re-verify             an active signal whose source records are gone gets an
                              INVALIDATED version (withdrawn, history kept)
     5  sc_current            the stored version of every key: a re-evaluation is sent
                              only when it is a material update (E.materialUpdate)
     6  sc_ingest             batches of 200, idempotent by key and version hash
     7  sc_graphics_due       draw the content of every version still missing its
                              graphic (lib/edgedesk_signal_graphic.js), check it, store it
     8  sc_put_dna            the Model DNA records, stored once per distinct audit
     9  sc_notify             notices into the existing bell, deduplicated
    10  sc_finish_run         counts; started events expire
   A failure at any step records the error (sc_fail), fails the run, and exits 1;
   what was stored before it stays stored, and the next run continues from there.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const SG = require(path.join(ROOT, 'lib', 'edgedesk_signal_graphic.js'));
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const NBAG = require(path.join(ROOT, 'lib', 'edgedesk_nba_graphic.js'));
const NHLG = require(path.join(ROOT, 'lib', 'edgedesk_nhl_graphic.js'));
const S = require('./sources.js');
const DB = require('./db.js');
const { evaluate } = require('./evaluate.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.indexOf('--' + n) > 0;
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

/* the badge colours a graphic draws, from the tables the matchup graphics
   already use; nothing is guessed (neutral colours otherwise) */
function teamStyleResolver(root) {
  const ident = S.readJson('football/game_research/identity_cfb.json', root) || { teams: {} };
  const table = {};
  Object.keys(ident.teams || {}).forEach((k) => { table[k] = ident.teams[k]; });
  return function (sport, t) {
    t = t || {};
    if (sport === 'nba') { const x = NBAG.team({ name: t.name, abbr: t.abbr }); return x.color === '#3b4a6b' ? null : { color: x.color, alt: x.alt, on: x.on, abbr: x.abbr }; }
    if (sport === 'nhl') { const x = NHLG.team(String(t.abbr || '').toUpperCase()); return x.color === '#3b4a6b' ? null : { color: x.color, alt: x.alt, on: x.on, abbr: x.abbr }; }
    if (sport === 'nfl' || sport === 'cfb') {
      const x = GS.teamIdentity(sport, t.name, t.abbr, table);
      return x.identity_source && !/not on file/.test(x.identity_source) ? { color: x.color, alt: x.alt_color, on: x.on_color, abbr: x.abbr } : null;
    }
    return null;
  };
}

function committedInputs(root, now) {
  const football = S.footballGames(root), au = S.audits(root);
  return { football, footballCurrent: S.footballCurrent(root), perfGames: S.perfForecastGames(root), perfLastCapture: au.perf && au.perf.ledger ? au.perf.ledger.last_capture_at : null,
    quotes: S.perfQuotes(root), slateTeams: S.slateTeams(root), audits: au, cfbAvailability: S.cfbAvailability(root, football), sourceStates: S.sourceStates(root, now), now };
}

/* step 4: an active signal whose compared records are no longer in its source
   (the ledgers are append-only, so this means a source was rewritten) */
function invalidations(active, inputs) {
  const ids = new Map();
  inputs.football.concat(inputs.perfGames).forEach((g) => ids.set(g.game.event_key, new Set(g.series.map((r) => r.snapshot_id))));
  const out = [];
  (active || []).forEach((row) => {
    const p = row.payload;
    if (!p || p.category !== 'FORECAST_SHIFT' || !p.event || !p.values) return;
    const have = ids.get(p.event.key);
    if (!have) return; /* the game left the window: not evidence of anything */
    const missing = [p.values.previous && p.values.previous.snapshot_id, p.values.current && p.values.current.snapshot_id].filter((id) => id && !have.has(id));
    if (!missing.length) return;
    const q = JSON.parse(JSON.stringify(p));
    q.verification = { state: 'INVALIDATED', checks: [{ id: 'source_records_present', ok: false, detail: 'missing from ' + (q.sources && q.sources[0] && q.sources[0].ref) + ': ' + missing.join(', ') }], failed: ['source_records_present'], means: E.VERIFICATION.INVALIDATED };
    q.detected_at = new Date(inputs.now).toISOString();
    q.version_hash = E.versionHash(q);
    out.push(q);
  });
  return out;
}

/* step 7: one graphic per format per due version, checked before it is stored */
function graphicItems(due, resolver) {
  const items = [];
  (due || []).forEach((d) => {
    const r = SG.content(d.payload, { version: d.version, payload_sha256: d.payload_sha256, teamStyle: resolver });
    const base = { version_id: d.version_id, payload_sha256: d.payload_sha256, template_version: SG.TEMPLATE_VERSION };
    if (!r.ok) {
      if (SG.TEMPLATES[d.payload.category]) Object.keys(SG.FORMATS).forEach((f) => items.push(Object.assign({}, base, { template: SG.TEMPLATES[d.payload.category], format: f, error: 'content: ' + (r.reason || 'refused') + (r.detail ? ' (' + r.detail + ')' : '') })));
      return;
    }
    Object.keys(SG.FORMATS).forEach((f) => {
      const bad = SG.check(SG.layout(r.content, f));
      items.push(Object.assign({}, base, { template: r.content.kind, format: f }, bad.length ? { error: 'layout: ' + bad.length + ' text op(s) outside their box (' + bad[0].problem + ': ' + String(bad[0].text).slice(0, 60) + ')' } : { content: r.content }));
    });
  });
  return items;
}

function gitSha() { try { return cp.execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return null; } }

async function liveRun(db, inputs, opts) {
  const log = [];
  const note = (src, msg) => { log.push({ source: src, note: msg }); console.log('  note | ' + src + ': ' + msg); };
  const counts = { requests: 0 };
  const begun = await db.rpc('sc_begin_run', { p: { engine_version: E.VERSION, spec_version: E.SPEC.id, source_commit: opts.sha, idempotency_key: opts.idem || null,
    sources: { game_research: inputs.footballCurrent.generated_at, performance_ledger: inputs.perfLastCapture, fixture: !!opts.fixture } } });
  if (begun.busy) { console.log('another Signal Center run holds the lease (' + begun.run_id + ', started ' + begun.started_at + '): nothing to do'); return { busy: true }; }
  if (begun.duplicate) { console.log('this run already completed (' + begun.run_id + ')'); return { duplicate: true }; }
  const run = begun.run_id;
  console.log('run ' + run + ' · mode ' + begun.mode + ' · live sports ' + JSON.stringify(begun.live_sports));
  try {
    /* 2: the database layers */
    const dbIn = { simPairs: await DB.simPairs(db, note), nbaInjuries: await DB.nbaInjuries(db, inputs.now, note), kalshi: await DB.kalshiMids(db, note) };
    try { dbIn.priorDivergences = ((await db.rpc('sc_prior_divergences', {})) || []).map((r) => r.payload); } catch (e) { note('sc', 'stored divergences unreadable: ' + e.message); dbIn.priorDivergences = []; }
    /* 3 */
    const r = opts.fixture ? { signals: opts.fixture, dna: [], stats: { fixture: true }, refused: [], ineligible: {} } : evaluate(Object.assign({}, inputs, { db: dbIn }));
    console.log('evaluated: ' + r.signals.length + ' candidate signals, ' + r.dna.length + ' Model DNA records, ' + r.refused.length + ' comparisons refused');
    /* 4 */
    let inval = [];
    try { inval = invalidations(await db.rpc('sc_active', { p_categories: ['FORECAST_SHIFT'], p_limit: 2000 }), inputs); } catch (e) { note('sc', 're-verification skipped: ' + e.message); }
    /* 5 */
    const byKey = new Map(r.signals.concat(inval).map((p) => [p.signal_key, p]));
    const current = new Map();
    for (const keys of chunk(Array.from(byKey.keys()), 1000)) ((await db.rpc('sc_current', { p_keys: keys })) || []).forEach((row) => current.set(row.signal_key, row));
    const send = [];
    byKey.forEach((p, k) => {
      const cur = current.get(k);
      const mu = E.materialUpdate(cur && cur.payload, p);
      if (!mu.update) return;
      const reason = !cur ? 'initial' : (p.verification.state === 'INVALIDATED' ? 'invalidation' : (/methodology/.test(mu.reason) ? 'methodology' : 'evidence_update'));
      send.push({ payload: p, reason });
    });
    counts.candidates = byKey.size; counts.to_send = send.length; counts.invalidations = inval.length;
    /* 6 */
    const ing = { inserted: 0, versioned: 0, unchanged: 0, rejected: 0, published: 0 };
    for (const batch of chunk(send, 200)) {
      const res = await db.rpc('sc_ingest', { p_run: run, p_items: batch });
      ['inserted', 'versioned', 'unchanged', 'rejected', 'published'].forEach((k) => { ing[k] += res[k] || 0; });
      (res.items || []).filter((i) => i.rejected).slice(0, 5).forEach((i) => note('ingest', i.signal_key + ' refused: ' + i.rejected));
    }
    Object.assign(counts, ing);
    console.log('stored: ' + ing.inserted + ' new, ' + ing.versioned + ' new versions, ' + ing.unchanged + ' unchanged, ' + ing.rejected + ' refused, ' + ing.published + ' published');
    /* 7 */
    const due = (await db.rpc('sc_graphics_due', { p_template_version: SG.TEMPLATE_VERSION, p_limit: 150 })) || [];
    const gi = graphicItems(due, opts.resolver);
    const gs = { generated: 0, unchanged: 0, refused: 0, failed: gi.filter((i) => i.error).length };
    for (const batch of chunk(gi, 100)) { const res = await db.rpc('sc_put_graphics', { p_run: run, p_items: batch }); gs.generated += res.generated || 0; gs.unchanged += res.unchanged || 0; gs.refused += res.refused || 0; }
    counts.graphics = gs;
    console.log('graphics: ' + due.length + ' versions due, ' + gs.generated + ' drawn and stored, ' + gs.failed + ' failed their checks (stored as FAILED), ' + gs.refused + ' refused');
    /* 8 */
    if (r.dna.length) counts.dna = (await db.rpc('sc_put_dna', { p_run: run, p_items: r.dna })).stored;
    /* 9 */
    counts.notices = await db.rpc('sc_notify', { p_run: run });
    counts.signals = r.signals.length; counts.refused_comparisons = r.refused.length; counts.notes = log.length;
    if (log.length) await db.rpc('sc_fail', { p_run: run, p_items: log.slice(0, 50).map((l) => ({ stage: 'source', item_key: l.source, error: l.note })) });
    counts.requests = db.used + 1;
    /* 10 */
    const fin = await db.rpc('sc_finish_run', { p_run: run, p_status: 'completed', p_counts: counts, p_error: null });
    console.log('run completed · ' + fin.expired + ' signals expired (their event started) · ' + counts.requests + ' database requests');
    return { run, counts };
  } catch (e) {
    console.error('run failed: ' + e.message);
    try { await db.rpc('sc_fail', { p_run: run, p_items: [{ stage: 'run', error: String(e.message).slice(0, 900) }] }); } catch (_) { /* recorded below */ }
    try { await db.rpc('sc_finish_run', { p_run: run, p_status: 'failed', p_counts: counts, p_error: { message: String(e.message).slice(0, 900) } }); } catch (_) { /* the lease expires */ }
    throw e;
  }
}

async function main() {
  const now = arg('now', null) ? Date.parse(arg('now')) : Date.now();
  if (!isFinite(now)) throw new Error('--now is not a time');
  const inputs = committedInputs(ROOT, now);
  let fixture = null;
  if (arg('fixture', null)) {
    const raw = JSON.parse(fs.readFileSync(arg('fixture'), 'utf8'));
    fixture = (Array.isArray(raw) ? raw : raw.signals || []).map((p) => { const q = JSON.parse(JSON.stringify(p)); q.fixture = true; q.version_hash = E.versionHash(q); return q; });
    console.log('FIXTURE MODE: ' + fixture.length + ' controlled payloads, every one marked fixture (never published)');
  }
  const dry = flag('dry-run') || !process.env.SB_URL || !process.env.SB_SERVICE_ROLE;
  if (dry) {
    const r = fixture ? { signals: fixture, dna: [], stats: { fixture: true }, refused: [], ineligible: {} } : evaluate(inputs);
    const out = path.resolve(arg('out', path.join(ROOT, '.cache', 'signal_center')));
    fs.mkdirSync(out, { recursive: true });
    const graphics = r.signals.filter((p) => SG.eligible(p).ok).length;
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ schema: 'edgedesk_signal_center_dry_run_v1', evaluated_at: new Date(now).toISOString(), engine_version: E.VERSION, spec: E.SPEC, stats: r.stats, signals: r.signals, dna: r.dna, refused: r.refused, ineligible: r.ineligible }, null, 1));
    console.log((flag('dry-run') ? 'DRY RUN' : 'DRY RUN (SB_URL / SB_SERVICE_ROLE not set)') + ' · ' + r.signals.length + ' signals, ' + graphics + ' with a graphic template, ' + r.dna.length + ' Model DNA records · ' + path.relative(process.cwd(), path.join(out, 'run.json')));
    Object.keys(r.stats.by_category || {}).sort().forEach((k) => console.log('  ' + k + ': ' + r.stats.by_category[k]));
    return;
  }
  const db = DB.client(process.env);
  const idem = process.env.GITHUB_RUN_ID ? 'gh:' + process.env.GITHUB_RUN_ID + ':' + (process.env.GITHUB_RUN_ATTEMPT || '1') : null;
  await liveRun(db, inputs, { sha: gitSha(), idem, fixture, resolver: teamStyleResolver(ROOT) });
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { liveRun, committedInputs, invalidations, graphicItems, teamStyleResolver };
