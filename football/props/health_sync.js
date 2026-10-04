#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — the pipeline's health record in Supabase
   (supabase/player_props_pipeline.sql).

   After every Player props workflow run — including one that crashed — this
   records, per league:
     player_props_pipeline_runs     what the run asked, what came back, how
                                    long it took, the provider's answer, the
                                    rate-limit window and the health verdict
     player_props_pipeline_health   the latest verdict and when the capture is
                                    next due: what supabase/functions/props_cron
                                    wakes for
   and completes a reader's refresh request (player_props_refresh_requests)
   with what actually happened: prices captured, nothing due, rate limited
   until when, or the failure.

   The committed capture_state.json stays the page's source; this is the
   queryable copy an operator (and the scheduler) reads. Without SB_URL /
   SB_SERVICE_ROLE (EDGD_SB_URL / EDGD_SB_SERVICE) it logs and exits 0.

     node football/props/health_sync.js [--leagues nfl,cfb] [--run-key <id>] [--trigger <source>]
                                        [--refresh-request <uuid>] [--phase start|finish] [--outcome success|failure|cancelled]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
const PGR = require(path.join(C.ROOT, 'tools', 'lib', 'pgrest.js'));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
const n = (x) => (x == null || x === '' ? null : x);
const int = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.round(Number(x)) : null);
const HEALTH = ['HEALTHY', 'DEGRADED', 'DELAYED', 'OUTAGE'];

/* one run's row. `res` is the capture's own answer for this run (a quiet run
   writes no state file, so it is the only record of it); `state` the state
   file as it now stands */
function runRow(o) {
  const res = o.result || {}, st = o.state || {}, h = res.health || st.health || {};
  const reqs = Array.isArray(res.requests) ? res.requests : [];
  const refused = res.refused ? Object.keys(res.refused).reduce((a, k) => a + (res.refused[k] || 0), 0) : null;
  const prov = st.provider || {};
  const crashed = !o.result;
  return {
    run_key: o.run_key, league: o.league, trigger: n(o.trigger), refresh_request_id: n(o.refresh_request_id),
    started_at: res.started_at || res.last_attempt || o.started_at || new Date(o.now || Date.now()).toISOString(),
    completed_at: res.completed_at || new Date(o.now || Date.now()).toISOString(),
    status: crashed ? 'CRASHED' : (res.status || (res.skipped ? 'SKIPPED' : null)),
    reason: crashed ? 'NO_RESULT' : n(res.reason) || (res.skipped ? (/rate-limited/.test(res.skipped) ? 'RATE_LIMITED' : /manual refresh/.test(res.skipped) ? 'CAPTURED_RECENTLY' : 'NOTHING_DUE') : null),
    skipped: n(res.skipped),
    health: HEALTH.indexOf(h.state) >= 0 ? h.state : null, health_reason: n(h.reason),
    events_in_window: int(res.events_in_window), events_requested: int(res.events_checked), events_succeeded: int(res.events_polled != null && res.events_failed != null ? res.events_polled - (res.events_suspect_empty || 0) : res.events_polled),
    events_failed: int(res.events_failed), events_no_markets: int(res.events_no_markets),
    markets_received: res.markets_returned && typeof res.markets_returned === 'object' ? Object.keys(res.markets_returned).length : int(res.markets_returned),
    quotes_received: int(res.outcomes_returned), quotes_usable: int(res.quotes_normalized != null ? res.quotes_normalized : res.quotes), quotes_refused: refused,
    provider_http: reqs.length ? String(reqs[reqs.length - 1].http) : (prov.last_http != null ? String(prov.last_http) : null),
    rate_limited_until: n(res.rate_limited_until || prov.rate_limited_until), requests_remaining: int(res.requests_remaining != null ? res.requests_remaining : prov.requests_remaining),
    credits_spent: res.credits_spent != null ? Number(res.credits_spent) : null, duration_ms: int(res.duration_ms),
    consecutive_failures: int(prov.consecutive_failures), error_message: n(crashed ? 'the capture step produced no result (it crashed or did not run): ' + (o.outcome || 'unknown outcome') : (res.error_message || null)),
    next_due_at: n(res.next_due_at || st.next_due_at),
    detail: { requests: reqs.slice(0, 40), refused: res.refused || null, pacing: res.pacing || st.pacing || null, stopped: res.stopped || null, workflow_outcome: o.outcome || null }
  };
}
function healthRow(o) {
  const res = o.result || {}, st = o.state || {}, h = res.health || st.health || {}, prov = st.provider || {};
  return {
    league: o.league, health: HEALTH.indexOf(h.state) >= 0 ? h.state : null, health_reason: n(h.reason), health_text: n(h.text),
    last_attempt_at: n(st.last_attempt), last_success_at: n(st.last_success_at), last_full_success_at: n(st.last_full_success_at),
    last_status: n(st.status), last_reason: n(st.reason), last_error: n(st.error_message || prov.last_error),
    provider_http: prov.last_http != null ? String(prov.last_http) : null, rate_limited_until: n(prov.rate_limited_until), consecutive_failures: int(prov.consecutive_failures),
    requests_remaining: int(prov.requests_remaining != null ? prov.requests_remaining : st.requests_remaining),
    events_in_window: int(h.active_events), events_on_target: int(h.on_target), events_failed: int(h.failed_events),
    next_due_at: n(res.next_due_at || st.next_due_at), board_built_at: n(o.board_built_at), last_run_key: o.run_key,
    updated_at: new Date(o.now || Date.now()).toISOString()
  };
}
/* what a reader's refresh request ends as, across its leagues */
function refreshOutcome(perLeague, outcome) {
  const lgs = Object.keys(perLeague);
  const summary = {};
  let captured = 0, rateLimited = null, errors = [];
  lgs.forEach((lg) => {
    const r = perLeague[lg] || {};
    summary[lg] = { status: r.status || null, reason: r.reason || null, skipped: r.skipped || null, health: r.health ? r.health.state : null,
      quotes: r.quotes || 0, events_polled: r.events_polled || 0, error: r.error_message || null, rate_limited_until: r.rate_limited_until || (r.provider && r.provider.rate_limited_until) || null };
    if ((r.events_polled || 0) > 0) captured++;
    if (summary[lg].rate_limited_until && Date.parse(summary[lg].rate_limited_until) > Date.now() - 60e3) rateLimited = summary[lg].rate_limited_until;
    if (r.status === 'ERROR') errors.push(lg + ': ' + (r.error_message || r.why || r.reason));
  });
  let status = 'completed', reason;
  if (outcome && outcome !== 'success' && !captured) { status = 'failed'; reason = 'the refresh run ' + outcome + ' before prices were captured'; }
  else if (captured) reason = 'fresh prices captured' + (errors.length ? '; ' + errors.join('; ') : '');
  else if (rateLimited) { status = 'failed'; reason = 'the odds provider is rate-limiting requests until ' + rateLimited; }
  else if (errors.length) { status = 'failed'; reason = errors.join('; '); }
  else reason = 'every game in the window was captured in the last few minutes, or no game is inside the capture window: nothing to re-buy';
  return { status, reason, result: { leagues: summary, rate_limited_until: rateLimited, workflow_outcome: outcome || null } };
}

async function run(o) {
  const db = o.db, leagues = o.leagues, now = o.now || Date.now();
  const per = {}, rows = [], health = [];
  leagues.forEach((lg) => {
    const P = C.leaguePaths(lg, o.season || C.seasonOf(now));
    const result = o.results ? o.results[lg] : readJson(path.join(C.CACHE, lg + '_capture_result.json'));
    const fresh = result && Date.parse(result.recorded_at || result.completed_at || 0) >= now - 3 * 3600e3 ? result : null;
    const state = o.states ? o.states[lg] : readJson(P.capture_state);
    const board = o.boards ? o.boards[lg] : readJson(P.board);
    per[lg] = fresh || {};
    const base = { league: lg, run_key: o.run_key, trigger: o.trigger, refresh_request_id: o.refresh_request_id, now, outcome: o.outcome, board_built_at: board ? board.generated_at : null };
    rows.push(runRow(Object.assign({ result: fresh, state }, base)));
    health.push(healthRow(Object.assign({ result: fresh, state }, base)));
  });
  const out = { runs: 0, health: 0, refresh: null };
  if (rows.length) { await db.upsert('public', 'player_props_pipeline_runs', rows, 'run_key,league', { ignoreDuplicates: true, returning: false }); out.runs = rows.length; }
  if (health.length) { await db.upsert('public', 'player_props_pipeline_health', health, 'league', { returning: false }); out.health = health.length; }
  if (o.refresh_request_id) {
    const fin = refreshOutcome(per, o.outcome);
    await db.patch('public', 'player_props_refresh_requests', 'id=eq.' + encodeURIComponent(o.refresh_request_id),
      { status: fin.status, reason: fin.reason, result: fin.result, completed_at: new Date(now).toISOString(), run_key: o.run_key });
    out.refresh = fin;
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] != null && !/^--/.test(a[i + 1]) ? a[i + 1] : d; };
  const leagues = String(arg('leagues', process.env.PROPS_LEAGUES || 'nfl,cfb')).split(',').map((x) => x.trim()).filter((x) => x === 'nfl' || x === 'cfb');
  const runKey = arg('run-key', process.env.GITHUB_RUN_ID ? process.env.GITHUB_RUN_ID + '.' + (process.env.GITHUB_RUN_ATTEMPT || '1') : 'local:' + new Date().toISOString());
  const req = arg('refresh-request', process.env.PROPS_REFRESH_REQUEST || '') || null;
  const phase = arg('phase', 'finish');
  const cfg = PGR.config();
  if (!cfg) { console.log('[props health] SB_URL / SB_SERVICE_ROLE are not set: nothing recorded (capture_state.json carries the same record)'); return 0; }
  const db = PGR.client(cfg);
  try {
    if (phase === 'start') {
      if (!req) { console.log('[props health] no refresh request to mark running'); return 0; }
      await db.patch('public', 'player_props_refresh_requests', 'id=eq.' + encodeURIComponent(req), { status: 'running', started_at: new Date().toISOString(), run_key: runKey });
      console.log('[props health] refresh request ' + req + ' is running (' + runKey + ')');
      return 0;
    }
    const r = await run({ db, leagues, run_key: runKey, trigger: arg('trigger', process.env.PROPS_TRIGGER || null), refresh_request_id: req, outcome: arg('outcome', null) });
    console.log('[props health] ' + JSON.stringify(r));
  } catch (e) {
    const msg = (PGR.refused(e) ? 'refused by the database (apply supabase/player_props_pipeline.sql?): ' : 'failed: ') + (e.message || e);
    console.log('[props health] ' + msg);
    if (process.env.GITHUB_ACTIONS === 'true') console.log('::warning title=Player props health record::' + String(msg).replace(/[\r\n]+/g, ' ').slice(0, 400));
  }
  return 0;
}

module.exports = { run, runRow, healthRow, refreshOutcome };
if (require.main === module) main().then((c) => process.exit(c || 0));
