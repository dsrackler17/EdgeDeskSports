'use strict';
/* ===========================================================================
   Publication to Supabase (service role, job environment only).

     node basketball/ncaam_forecast/publish.js --sync     champion history and weekly reports
                                                          (SB_URL, SB_SERVICE_ROLE; the weekly job)

   syncChampion(db)  the repository's registry is the source of truth for the
       jobs; the database keeps its own pointer and history for readers. This
       replays registry/history.jsonl into the database in order: every model
       record and training snapshot, every report a PROMOTE cites, then INIT /
       PROMOTE / ROLLBACK through ncaam_fc_set_champion (which refuses a
       PROMOTE without a stored PROMOTE report for exactly that model). Already
       synced steps are skipped, so a retry is harmless.

   publishForecasts(doc, {db})  begin (idempotent on model + artifact + the
       games and their forecasts) -> forecasts and Upset Watch in chunks ->
       ncaam_fc_publish_run, which verifies counts and gates and swaps the
       pointer in one transaction. Any failure after begin marks the run
       failed; the published run readers see never changes on a failure.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const MD = require('./model');
const RG = require('./registry');

function history() {
  const f = RG.P.history(); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function recordModel(db, key) {
  const m = RG.readModel(key); if (!m) throw new Error('registry record missing for ' + key);
  if (m.training_snapshot) await db.rpc('ncaam_fc_record_snapshot', { p: m.training_snapshot });
  await db.rpc('ncaam_fc_record_model', { p: { model_id: m.model_id, version: m.version, engine: m.engine, config: m.config, config_sha256: m.config_sha256, code_sha256: m.code_sha256 || '',
    snapshot_sha256: m.training_snapshot ? m.training_snapshot.sha256 : '' } });
  return m;
}

async function syncChampion(db, o) {
  o = o || {};
  /* only the lines that moved the pointer: a winning candidate's weekly decision record is a PROMOTE too, naming the champion it beat */
  const H = history().filter(RG.movesPointer);
  const status = await db.rpc('ncaam_fc_public_status', {}).catch(() => null);
  const dbKey = Array.isArray(status) && status[0] ? status[0].champion_key : null;
  const ptr = RG.readPointer(); if (!ptr) throw new Error('no champion pointer in the repository');
  if (dbKey === ptr.current.key) return { synced: false, champion: dbKey };
  /* replay from the step after the database's current champion */
  let start = 0;
  if (dbKey) { for (let i = H.length - 1; i >= 0; i--) if (H[i].champion === dbKey) { start = i + 1; break; } }
  for (const h of H.slice(start)) {
    await recordModel(db, h.champion);
    if (h.replaced) await recordModel(db, h.replaced);
    if (h.decision === 'PROMOTE') {
      const rep = JSON.parse(fs.readFileSync(path.resolve(C.ROOT, h.report), 'utf8'));
      await db.rpc('ncaam_fc_record_report', { p: { report_sha256: h.report_sha256, candidate: rep.candidate, champion_key: rep.champion, challenger_key: rep.challenger.model_id + '@' + rep.challenger.version,
        decision: rep.result.decision, policy_version: rep.policy_version, gates: rep.result.gates.map((g) => ({ id: g.id, pass: g.pass, detail: g.detail })),
        summary: { challenger: rep.result.challenger, champion: rep.result.champion, shared_games: rep.result.shared_games, seasons: rep.result.seasons }, report_path: h.report } });
    }
    await db.rpc('ncaam_fc_set_champion', { p: { decision: h.decision, model_key: h.champion, report_sha256: h.report_sha256 || '', reason: h.reason || null } });
    if (o.log) o.log('synced ' + h.decision + ' ' + h.champion);
  }
  return { synced: true, champion: ptr.current.key };
}

/** every weekly report not yet in the database (RETAIN and INSUFFICIENT_EVIDENCE included: Model Health shows them) */
async function syncReports(db) {
  const dir = C.PATHS.weeklyReports(); if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const text = fs.readFileSync(path.join(dir, f)); const sha = require('crypto').createHash('sha256').update(text).digest('hex');
    const rep = JSON.parse(text);
    await db.rpc('ncaam_fc_record_report', { p: { report_sha256: sha, candidate: rep.candidate, champion_key: rep.champion, challenger_key: rep.challenger.model_id + '@' + rep.challenger.version,
      decision: rep.result.decision, policy_version: rep.policy_version, gates: rep.result.gates.map((g) => ({ id: g.id, pass: g.pass, detail: g.detail })),
      summary: { challenger: rep.result.challenger, champion: rep.result.champion, shared_games: rep.result.shared_games, seasons: rep.result.seasons }, report_path: path.relative(C.ROOT, path.join(dir, f)).split(path.sep).join('/') } });
    n++;
  }
  return n;
}

function idempotencyKey(doc) {
  return MD.hash({ model: doc.model.key, artifact: doc.artifact.sha256, games: doc.forecasts.map((f) => [f.game_id, f.available ? Math.round(f.p_home * 1e9) : null]) });
}

async function publishForecasts(doc, o) {
  o = o || {};
  const db = o.db || require('./db').postgrestDb();
  const log = o.log || (() => {}); const chunk = o.chunk || 200;
  await syncChampion(db, { log });
  await syncReports(db);
  const begin = await db.rpc('ncaam_fc_begin_run', { p: { idempotency_key: idempotencyKey(doc), model_key: doc.model.key, artifact_sha256: doc.artifact.sha256,
    snapshot_sha256: doc.artifact.training_snapshot.sha256, as_of: doc.as_of, expected_games: doc.forecasts.length, gates: doc.gates, definitions: doc.definitions, upset_policy: doc.upset_policy } });
  if (begin.existing && begin.status !== 'running') { log('identical forecasts already ' + begin.status + ' (' + begin.run_id + ')'); return { run_id: begin.run_id, status: begin.status, existing: true, published: false }; }
  const runId = begin.run_id;
  try {
    const F = doc.forecasts.map((f) => ({ game_id: String(f.game_id), start_utc: f.start_utc, home_id: f.home_id, away_id: f.away_id, home_name: f.home_name, away_name: f.away_name, neutral: f.neutral,
      event: f.event, regime: f.regime, available: f.available, reason: f.reason || null, p_home: f.available ? f.p_home : null, p_ot: f.available ? f.p_ot : null, margin: f.margin || null, total: f.total || null,
      pts_home: f.pts_home == null ? null : f.pts_home, pts_away: f.pts_away == null ? null : f.pts_away, games_played: f.games_played, data_quality: f.data_quality, availability_assumption: f.availability_assumption, provenance: 'Research' }));
    for (let i = 0; i < F.length; i += chunk) await db.rpc('ncaam_fc_put_forecasts', { p_run: runId, p_rows: F.slice(i, i + chunk) });
    const U = doc.forecasts.filter((f) => f.available && f.upset).map((f) => ({ game_id: String(f.game_id), underdog: f.upset.underdog, basis: f.upset.basis, p_underdog: f.upset.p_underdog, signals: f.upset.signals,
      p_market_underdog: f.upset.p_market_underdog == null ? null : f.upset.p_market_underdog, disagreement: f.upset.disagreement == null ? null : f.upset.disagreement, factors: f.upset.factors || null }));
    for (let i = 0; i < U.length; i += chunk) await db.rpc('ncaam_fc_put_upset', { p_run: runId, p_rows: U.slice(i, i + chunk) });
    const pub = await db.rpc('ncaam_fc_publish_run', { p_run: runId });
    log('publication: ' + JSON.stringify(pub));
    if (!pub.published && pub.status === 'failed') throw Object.assign(new Error('the database refused the publication: ' + JSON.stringify(pub.errors)), { alreadyFailed: true });
    return { run_id: runId, status: pub.status, existing: false, published: pub.published };
  } catch (e) {
    if (!e.alreadyFailed) { try { await db.rpc('ncaam_fc_fail_run', { p_run: runId, p_error: { code: 'upload_failed', message: String(e.message || e).slice(0, 500) } }); } catch (e2) { log('could not mark run failed: ' + e2.message); } }
    throw e;
  }
}

module.exports = { syncChampion, syncReports, publishForecasts, idempotencyKey, history };

if (require.main === module && process.argv.includes('--sync')) {
  (async () => {
    const db = require('./db').postgrestDb();
    const c = await syncChampion(db, { log: console.log }); const n = await syncReports(db);
    console.log('[ncaam publish] champion ' + c.champion + ' synced; ' + n + ' weekly reports recorded (already stored ones are no-ops)');
  })().catch((e) => { console.error('[ncaam publish] sync failed: ' + e.message + ' — the database keeps its previous champion'); process.exit(1); });
}
