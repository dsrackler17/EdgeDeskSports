#!/usr/bin/env node
/* ============================================================================
   CFB production — the operational health report behind admin/cfb-ops/
   (docs/cfb-production/OPERATIONS.md §5).

   Reads only what is STORED — committed artifacts and, when credentials
   exist, the database's own cfb_health() — and writes one JSON file:

     football/cfb_production/reports/ops.json

   Sections (the dashboard's, in order): system health, model version, last
   weekly run, source health, odds age, PBP age, failed jobs, degraded games,
   predictions, bet decisions, warnings (incl. output anomalies), incidents.
   Every section carries status OK | WARNING | CRITICAL | UNKNOWN and says what
   it read. UNKNOWN is never shown as OK: a missing file is a finding.

     node football/cfb_production/health.js [--season 2026] [--now ISO] [--out FILE] [--stdout]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./compat.js');
const A = require('./anomaly.js');

const REPO = C.REPO;
const RANK = { OK: 0, UNKNOWN: 1, WARNING: 2, CRITICAL: 3 };
const worst = (xs) => xs.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'OK');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function ms(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? v : null; }
function ageMin(t, now) { const a = ms(t), b = ms(now); return a == null || b == null ? null : Math.round((b - a) / 60000); }
function inSeason(now) { const m = new Date(now).getUTCMonth() + 1; return [8, 9, 10, 11, 12, 1].includes(m); }
function seasonFor(now) { const d = new Date(now); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }

function build(opts) {
  opts = opts || {};
  const repo = opts.repo || REPO;
  const now = opts.now || new Date().toISOString();
  const season = opts.season || seasonFor(now);
  const P = (...p) => path.join(repo, ...p);
  const live = inSeason(now);
  const out = { schema: 'cfb_ops_v1', generated_at: now, season, in_season: live, reads: [], sections: {} };
  const read = (rel) => { out.reads.push(rel); return rel; };

  /* ---------------------------------------------- model version */
  const man = readJson(P(read('football/cfb_production/manifest.json')));
  const MF = (() => { try { return require('./manifest.js'); } catch (e) { return null; } })();
  const manProblems = man && MF ? MF.verify(man, { repo }) : ['no production manifest (node football/cfb_production/manifest.js --write)'];
  let comp = [];
  try { comp = C.check(C.facts({ repo }), C.loadMatrix()); } catch (e) { comp = [{ check: 'compatibility', ok: false, code: 'MODEL_ARTIFACT', detail: e.message }]; }
  const compBad = comp.filter((c) => !c.ok);
  out.sections.model_version = {
    status: !man || compBad.length ? 'CRITICAL' : manProblems.length ? 'WARNING' : 'OK',
    manifest_id: man && man.manifest_id, deployed_at: man && man.deployed_at,
    champion: man && man.champion_model_version, champion_selection: man ? man.champion_selection : null,
    production_model: man && man.production_model_version, production_status: man && man.production_model_status,
    feature_version: man && man.feature_version, calibration_version: man && man.calibration_version,
    ensemble_version: man && man.ensemble_version, decision_policy_version: man && man.decision_policy_version,
    git_commit: man && man.git_commit, git_dirty: man && man.git_dirty,
    manifest_problems: manProblems, compatibility: comp.map((c) => ({ check: c.check, ok: c.ok, code: c.code, detail: c.ok ? null : c.detail })),
    fallback_hierarchy: man && man.fallback_hierarchy,
  };

  /* ---------------------------------------------- last weekly run */
  const wdir = 'football/cfb_weekly/' + season;
  const runs = readJsonl(P(read(wdir + '/runs.jsonl'))).sort((a, b) => (ms(a.started_at) || 0) - (ms(b.started_at) || 0));
  const lastRun = runs[runs.length - 1] || null;
  const lastPub = runs.filter((r) => r.status === 'PUBLISHED').pop() || null;
  const runAge = lastPub ? ageMin(lastPub.completed_at || lastPub.started_at, now) : null;
  out.sections.last_weekly_run = {
    status: !lastRun ? (live ? 'CRITICAL' : 'UNKNOWN') : lastRun.status !== 'PUBLISHED' ? 'CRITICAL' : (live && runAge > 26 * 60 ? 'WARNING' : 'OK'),
    detail: !lastRun ? 'no weekly-engine run is recorded for ' + season + ' (' + wdir + '/runs.jsonl absent): the V2.1 weekly refresh has not run yet' : null,
    run_id: lastRun && lastRun.run_id, mode: lastRun && lastRun.mode, run_status: lastRun && lastRun.status,
    started_at: lastRun && lastRun.started_at, completed_at: lastRun && lastRun.completed_at,
    last_published_at: lastPub && (lastPub.completed_at || lastPub.started_at), age_minutes: runAge,
    stage_groups: lastRun ? Object.fromEntries(['score_ingestion_status', 'pbp_status', 'team_rating_status', 'projection_status', 'market_status', 'model_lab_status'].map((k) => [k, lastRun[k] || null])) : null,
    errors: lastRun ? (lastRun.errors || []).slice(0, 10) : [], runs_recorded: runs.length,
  };

  /* ---------------------------------------------- source health */
  const sh = readJson(P(read(wdir + '/source_health.json')));
  const ph = readJson(P(read('football/cfb_lab/reports/' + season + '/provider_health.json')));
  const lab = readJson(P(read('football/cfb_lab/reports/' + season + '/lab.json')));
  const sources = [];
  ((sh && sh.sources) || []).forEach((s) => sources.push({ source: s.source, origin: 'weekly engine', status: s.status, last_success: s.last_successful_ingestion || null,
    age_minutes: s.freshness_hours != null ? Math.round(s.freshness_hours * 60) : null, coverage: s.coverage, error_rate: s.error_rate, critical: !!s.critical, detail: s.detail || null }));
  Object.values((ph && ph.breakers) || {}).forEach((b) => sources.push({ source: b.provider, origin: 'Model Lab circuit breaker', status: b.state === 'CLOSED' ? 'HEALTHY' : b.state,
    last_success: b.last_success_at, age_minutes: ageMin(b.last_success_at, now), error_rate: b.calls ? Math.round((b.failures / b.calls) * 1000) / 1000 : null,
    incident: b.state !== 'CLOSED' ? (b.last_error_class || 'OPEN') + ': ' + String(b.last_error || '').slice(0, 200) : null }));
  const srcStatus = sources.map((s) => (/^(MISSING)$/.test(s.status) && s.critical ? 'CRITICAL' : /^(OPEN|HALF_OPEN|STALE|DEGRADED|MISSING)$/.test(s.status) ? 'WARNING' : 'OK'));
  out.sections.source_health = { status: sources.length ? worst(srcStatus) : 'UNKNOWN', sources,
    detail: sh ? null : 'no weekly-engine source_health.json for ' + season + '; the Model Lab breakers are shown' };

  /* ---------------------------------------------- odds age */
  const policy = C.facts({ repo }).decision_policy;
  const staleMin = (() => { const p = policy && readJson(P('football/cfb_v2/artifacts/decision', policy.dir, 'policy.json')); return (p && p.stale_minutes) || 180; })();
  let newestQuote = null;
  const qdir = P('football/cfb_lab/ledger', String(season), 'quotes');
  read('football/cfb_lab/ledger/' + season + '/quotes');
  if (fs.existsSync(qdir)) fs.readdirSync(qdir).filter((f) => f.endsWith('.jsonl')).forEach((f) => readJsonl(path.join(qdir, f)).forEach((q) => {
    const t = ms(q.observed_at); if (t != null && t <= ms(now) && (newestQuote == null || t > newestQuote)) newestQuote = t; }));
  const tw = (lab && lab.this_week) || [];
  const soon = tw.filter((g) => { const k = ms(g.kickoff); return k != null && k > ms(now) && k - ms(now) <= 48 * 3600000; }).length;
  const oddsAge = newestQuote == null ? null : ageMin(newestQuote, now);
  out.sections.odds_age = {
    status: !live || !soon ? 'OK' : oddsAge == null ? 'CRITICAL' : oddsAge >= 360 ? 'CRITICAL' : oddsAge >= staleMin ? 'WARNING' : 'OK',
    newest_quote_at: newestQuote == null ? null : new Date(newestQuote).toISOString(), age_minutes: oddsAge, stale_after_minutes: staleMin,
    games_within_48h: soon, games_marked_stale: tw.filter((g) => g.market && g.market.stale).length, games_this_week: tw.length,
    rule: 'decisions fail closed (MARKET_STALE) past ' + staleMin + ' min (decision policy ' + (policy && policy.version) + '); football projections still display',
  };

  /* ---------------------------------------------- PBP age */
  const pbp = ((sh && sh.sources) || []).find((s) => s.source === 'pbp') || null;
  const pbpAge = pbp ? ageMin(pbp.last_successful_ingestion, now) : null;
  out.sections.pbp_age = {
    status: !pbp ? (live ? 'WARNING' : 'UNKNOWN') : pbp.status === 'MISSING' ? 'CRITICAL' : pbp.status !== 'HEALTHY' ? 'WARNING' : pbpAge != null && pbpAge > 7 * 1440 ? 'CRITICAL' : 'OK',
    pbp_status: pbp && pbp.status, last_success: pbp && pbp.last_successful_ingestion, age_minutes: pbpAge, coverage: pbp && pbp.coverage, error_rate: pbp && pbp.error_rate,
    detail: pbp ? pbp.detail : 'no weekly-engine PBP health recorded for ' + season,
    rule: 'incomplete PBP never becomes zero EPA: the game is FINAL_PARTIAL_DATA and the weekly engine degrades (DEGRADED_PBP) or holds',
  };

  /* ---------------------------------------------- failed jobs */
  const lr = readJson(P(read('football/cfb_lab/reports/' + season + '/last_run.json')));
  const failed = [];
  Object.entries((lr && lr.steps) || {}).forEach(([k, v]) => { if (v && v.ok === false) failed.push({ job: 'cfb_lab_hourly', step: k, at: lr.started_at, error: String(v.error || '').slice(0, 300) }); });
  runs.filter((r) => r.status !== 'PUBLISHED').slice(-5).forEach((r) => failed.push({ job: 'cfb_weekly_refresh', step: r.status, at: r.started_at, error: (r.errors || []).map((e) => e.stage + ': ' + e.message).join('; ').slice(0, 300) }));
  const labAge = lr ? ageMin(lr.started_at, now) : null;
  out.sections.failed_jobs = {
    status: failed.some((f) => f.job === 'cfb_weekly_refresh') ? 'CRITICAL' : failed.length ? 'WARNING' : (live && (labAge == null || labAge > 150) ? 'CRITICAL' : 'OK'),
    failed, lab_last_run_at: lr && lr.started_at, lab_last_run_age_minutes: labAge,
    note: 'Mirror / workflow failures and heartbeats live in Postgres (cfb_job_heartbeat_status, cfb_incidents_current) and GitHub Actions; this file sees what the jobs committed.',
  };

  /* ---------------------------------------------- degraded games + predictions */
  const cur = readJson(P(read('football/cfb_v2/current.json')));
  const rows = (cur && cur.rows) || [];
  const degraded = rows.filter((r) => r.priced === false || r.qb_missing_any || r.qb_unsettled_any || r.early_season || (r.model_mode && r.model_mode !== 'FULL'))
    .map((r) => ({ game_id: String(r.game_id), home: r.home, away: r.away,
      modes: [r.model_mode && r.model_mode !== 'FULL' ? r.model_mode : null, r.priced === false ? 'NOT_PRICED' : null, r.qb_missing_any ? 'QB_MISSING' : null,
        r.qb_unsettled_any ? 'QB_UNSETTLED' : null, r.early_season ? 'EARLY_SEASON' : null].filter(Boolean), reason: r.not_priced_reason || null }));
  const dq = (lab && lab.health && lab.health.data_quality) || null;
  out.sections.degraded_games = { status: dq && dq.counts && dq.counts.RED ? 'WARNING' : 'OK', v21_rows: rows.length, degraded: degraded.slice(0, 200), degraded_count: degraded.length,
    lab_data_quality: dq ? dq.counts : null };
  const snapsDir = P('football/cfb_v2/snapshots', String(season));
  const frozen = fs.existsSync(snapsDir) ? fs.readdirSync(snapsDir).filter((f) => f.endsWith('.json') && f !== 'replay_to_date.json').length : 0;
  const curAge = cur ? ageMin(cur.generated_at, now) : null;
  out.sections.predictions = {
    status: !cur ? 'CRITICAL' : live && curAge > 8 * 1440 ? 'WARNING' : 'OK',
    v21_current_generated_at: cur && cur.generated_at, v21_current_age_minutes: curAge, v21_rows: rows.length, v21_mode: cur && cur.mode,
    frozen_snapshot_files: frozen, lab_models: lab && lab.health ? lab.health.models : null, lab_games_this_week: tw.length,
  };

  /* ---------------------------------------------- bet decisions */
  const sd = readJson(P(read('football/cfb_v2/shadow/' + season + '/decisions.json')));
  const dl = readJsonl(P(read('football/cfb_decision/' + season + '/decisions.jsonl')));
  const byStatus = {};
  dl.forEach((d) => { const k = (d.engine_role || '?') + ':' + d.status; byStatus[k] = (byStatus[k] || 0) + 1; });
  const bets = dl.filter((d) => d.status === 'BET' && d.official !== false).length + ((sd && sd.counts && sd.counts.BET) || 0);
  const betEnabled = !!(policy && policy.bet_enabled);
  out.sections.bet_decisions = {
    status: bets > 0 && !betEnabled ? 'CRITICAL' : 'OK', betting_enabled: betEnabled, policy: policy && policy.version, policy_status: policy && policy.status,
    decision_rows: dl.length, by_role_status: byStatus, shadow_counts: sd && sd.counts, bets,
    rule: 'a BET while the policy has betting disabled is a fail-safe breach (CRITICAL); an unusual BET count is reviewed, never auto-cancelled',
  };

  /* ---------------------------------------------- warnings (incl. anomalies) */
  const slate = readJson(P(read('football/fbs/slate.json')));
  const conf = new Map(((slate && slate.games) || []).map((g) => [String(g.game_id), g]));
  const v21 = 'edgedesk_cfb_v2.1.0';
  const arows = tw.filter((g) => g.models && g.models[v21]).map((g) => {
    const m = g.models[v21], s = conf.get(String(g.game_id)) || {};
    return { game_id: g.game_id, home_id: s.home_team_id, away_id: s.away_team_id, margin: m.margin, p_home: m.p_home, status: m.status,
      market_home_line: g.market && typeof g.market.current === 'number' ? g.market.current : null, home_conference: s.home_conference, away_conference: s.away_conference };
  });
  /* FBS conferences only (the board's own list): FCS opponents are tracked, never priced */
  const fbsConfs = new Set(((slate && slate.conferences) || []).map((c) => c.label));
  const weekConfs = Array.from(new Set(tw.map((g) => conf.get(String(g.game_id))).filter(Boolean).flatMap((s) => [s.home_conference, s.away_conference])
    .filter((c) => c && fbsConfs.has(c))));
  const predDir = P('football/cfb_lab/ledger', String(season), 'predictions');
  const hist = [];
  if (fs.existsSync(predDir)) fs.readdirSync(predDir).filter((f) => f.endsWith('.jsonl')).sort().forEach((f) => {
    const w = readJsonl(path.join(predDir, f)).filter((p) => p.model_version === v21 && (p.origin || 'LIVE') === 'LIVE' && typeof p.pure_home_margin === 'number');
    if (w.length >= A.MIN_N) hist.push(A.mean(w.map((p) => Math.abs(p.pure_home_margin))));
  });
  const anomalies = A.detect(arows, { mean_abs_margin: hist.slice(0, -1).length ? hist.slice(0, -1) : hist, bets_per_week: [], conferences: weekConfs });
  const warnings = [];
  anomalies.alerts.forEach((a) => warnings.push(Object.assign({ source: 'anomaly' }, a)));
  ((lab && lab.health && lab.health.alerts) || []).forEach((a) => warnings.push({ source: 'model lab', rule: a.kind, severity: a.level === 'critical' ? 'CRITICAL' : 'WARNING', message: a.message, detail: a.detail || null }));
  compBad.forEach((c) => warnings.push({ source: 'compatibility', rule: c.code, severity: 'CRITICAL', message: c.check, detail: c.detail }));
  manProblems.forEach((p) => warnings.push({ source: 'manifest', rule: 'MODEL_ARTIFACT', severity: 'WARNING', message: p }));
  if (man && man.git_dirty) warnings.push({ source: 'manifest', rule: 'RELEASE', severity: 'WARNING', message: 'the manifest was generated from a working tree that differed from ' + String(man.git_commit).slice(0, 12) + ' (not a releasable state)' });
  out.sections.warnings = { status: worst(warnings.map((w) => w.severity === 'CRITICAL' ? 'CRITICAL' : w.severity === 'INFO' ? 'OK' : 'WARNING')), warnings,
    anomaly_rows: arows.length, anomaly_baseline_weeks: hist.length };

  /* ---------------------------------------------- incidents (database) */
  out.sections.incidents = { status: 'UNKNOWN', open: [], detail: 'incidents live in Postgres (cfb_incidents_current); this build had no database credentials' };
  if (opts.db) {
    out.sections.incidents = { status: opts.db.incidents.some((i) => i.status === 'OPEN' && i.severity === 'CRITICAL') ? 'CRITICAL' : opts.db.incidents.some((i) => i.status === 'OPEN') ? 'WARNING' : 'OK',
      open: opts.db.incidents.filter((i) => i.status === 'OPEN'), detail: 'cfb_incidents_current' };
    out.database = { checks: opts.db.health, status: worst(opts.db.health.map((h) => (RANK[h.status] != null ? h.status : 'UNKNOWN'))) };
  }

  /* ---------------------------------------------- system health */
  const order = ['model_version', 'last_weekly_run', 'source_health', 'odds_age', 'pbp_age', 'failed_jobs', 'degraded_games', 'predictions', 'bet_decisions', 'warnings', 'incidents'];
  const st = order.map((k) => out.sections[k].status).concat(out.database ? [out.database.status] : []);
  out.system = { status: worst(st), by_section: Object.fromEntries(order.map((k) => [k, out.sections[k].status])),
    rule: 'the worst section decides; UNKNOWN is never reported as OK' };
  return out;
}

async function fromDatabase(opts) {
  const DB = require('./db.js');
  const url = opts.url || process.env.SB_URL, key = opts.key || process.env.SB_SERVICE_ROLE;
  if (!url || !key) return null;
  try {
    const h = await (await DB.request(url + '/rest/v1/rpc/cfb_health', { method: 'POST', headers: DB.headers(key), body: JSON.stringify({ p_now: opts.now || new Date().toISOString() }) }, { fetch: opts.fetch, timeoutMs: 20000 })).json();
    const inc = await (await DB.request(url + '/rest/v1/cfb_incidents_current?select=*&status=eq.OPEN', { headers: DB.headers(key) }, { fetch: opts.fetch, timeoutMs: 20000 })).json();
    return { health: h, incidents: inc };
  } catch (e) { return null; }
}

module.exports = { build, fromDatabase, worst };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  (async () => {
    const now = arg('--now', new Date().toISOString());
    const db = await fromDatabase({ now });
    const r = build({ now, season: arg('--season', null) ? Number(arg('--season')) : null, db });
    if (a.includes('--stdout')) { console.log(JSON.stringify(r, null, 1)); return; }
    const out = arg('--out', path.join(__dirname, 'reports', 'ops.json'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r, null, 1) + '\n');
    console.log('ops ' + r.system.status + ' ' + JSON.stringify(r.system.by_section) + ' -> ' + path.relative(REPO, out));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
