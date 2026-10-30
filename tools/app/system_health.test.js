#!/usr/bin/env node
/* ===========================================================================
   The System health panel against the production states it misreported on
   2026-10-30 (app.html, the SYSTEM HEALTH module, run in a VM).

     attribution   the NHL goalie sync's error is the sync's, not the model's:
                   "Model health" counts the football self-check alone (it
                   read 21/22 with every self-check passing), and the header's
                   count names the subsystems it is made of
     jobs          pipeline_meta holds six jobs, not fifteen keys, and a job
                   whose status is the string "fail" is seen
     odds          the capture in its six states from public.odds_feed_status:
                   paused (quota unconfirmed, the production state), quota
                   exhausted, degraded, healthy, delayed, unknown because the
                   status read failed; a missing write is "none on record",
                   never the time of the read
     frozen model  a 68-day-old parameter build that is season-fixed by
                   design reads as such, beside how current the ratings are
     governance    a NOT_SERVED learning loop is named research-only, not
                   broken
     kalshi        a recovered single failure with no reason from the view is
                   said from the counts, never left blank
     text          label, note and value are separate text (they ran together
                   for text readers), every value is escaped exactly once, and
                   no entity reaches the reader
     sections      model, data sources, scheduled jobs, data quality, research
                   governance and history are separate

   Run: node tools/app/system_health.test.js [path/to/app.html]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(process.argv[2] || path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const has = (s, sub, name) => chk(name, String(s).indexOf(sub) >= 0, sub);
const lacks = (s, sub, name) => chk(name, String(s).indexOf(sub) < 0, sub);

const SH_START = APP.indexOf('/* ═══ SYSTEM HEALTH + MORE ');
const SH_END = APP.indexOf('window.loadMore=loadMore;', SH_START);
chk('the system-health module is found in app.html', SH_START >= 0 && SH_END > SH_START);
const SH_SRC = APP.slice(SH_START, SH_END);
const EDESC = (APP.match(/function edEsc\(s\)\{[^\n]*\}/) || [''])[0];
chk('the app\'s own escaper is found', !!EDESC);

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
function makeCtx(o) {
  o = o || {};
  const els = {};
  function el(id) { return els[id] || (els[id] = { id, textContent: '', className: '', title: '', innerHTML: '', attrs: {}, classList: { add() {}, remove() {} }, setAttribute(k, v) { this.attrs[k] = String(v); } }); }
  el('dbPill').className = 'pill ok';
  const ctx = {
    console, Date, Math, JSON, String, Number, Object, Array, isFinite, RegExp, Error, Promise, isNaN, parseInt,
    setInterval: () => 0, setTimeout: () => 0,
    fetch: () => Promise.reject(new Error('no network in tests')),
    document: { addEventListener() {}, getElementById: (id) => els[id] || null },
    $: el,
    ago: (ms) => Math.round((Date.now() - ms) / 86400000) + 'd ago',
    show() {}, researchGo() {},
    __els: els,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(EDESC, ctx);
  vm.runInContext(SH_SRC, ctx, { filename: 'app.html:system-health' });
  ctx.SH.health = o.health === undefined ? HEALTH : o.health;
  ctx.FL = { faults: [] };
  ['ngl', 'ks', 'nbaInj', 'loops', 'odds', 'oddsErr'].forEach((k) => { if (o[k] !== undefined) ctx.SH[k] = o[k]; });
  return ctx;
}
/* the shape of football/health.json on 2026-10-30: 22 checks, 21 pass and 1 warn, six jobs */
const HEALTH = {
  schema: 'edgedesk_football_health_v1', generated_at: iso(50 * 60000),
  run: { trigger: 'schedule', params_built_at: { football: iso(69 * 86400000), cfb_p4: iso(68 * 86400000) },
    model_versions: { football: 'edgedesk_football_v1.0.0', cfb_p4: 'edgedesk_cfb_p4_v1.0.0' } },
  learning: { nfl: { data_through: '2026-10-29' }, p4: { data_through: '2026-10-25' } },
  checks: Array.from({ length: 21 }, (_, i) => ({ id: 'c' + i, label: 'check ' + i, status: 'pass' }))
    .concat([{ id: 'nfl_lines', label: 'NFL: model vs market line guard', status: 'warn', detail: 'median gap 1.4 pts over 27 games; 1 game(s) beyond 7 pts' }]),
  pipeline_meta: {
    daily_check_last_run: iso(1), daily_check_last_status: 'ok', engine_tests_last_run: iso(1), engine_tests_last_status: 'ok',
    nfl_ingest_last_run: iso(1), nfl_ingest_last_status: 'ok', row_count_nfl_ingest: 108, p4_ingest_last_run: iso(1),
    p4_ingest_last_status: 'ok', row_count_p4_ingest: 566, projection_guard_last_run: iso(1), projection_guard_last_status: 'ok',
    line_guard_last_run: iso(1), line_guard_last_status: 'ok', row_count_line_guard: 27 },
};
/* public.nhl_goalie_readiness as it read at 17:05Z on 2026-10-30 */
const NGL = { state: 'error', state_reason: 'the last check failed: no starter source could be read (Daily Faceoff): the starters on file are kept, nothing is written in their place',
  last_success_at: iso(64 * 60000), daily_faceoff_ok: false, nhl_api_ok: null, consecutive_failures: 1, sync_failures_24h: 2, degraded_24h: 1, drift_24h: 0,
  games_7d: 30, games_confirmed_by_t30_7d: 16, pct_confirmed_by_t30_7d: 53.3, pct_sides_confirmed_by_t30_7d: 73.3, confirmed_by_t30_target_pct: 90, conflicts_open: 0, conflicts_24h: 0, conflicts_7d: 0 };
/* public.kalshi_readiness: warn with no reason, one failed run recovered */
const KS = { state: 'warn', state_reason: null, last_snapshot_run_status: 'ok', last_successful_snapshot_at: iso(5 * 60000), minutes_since_snapshot: 5,
  markets_last_snapshot: 268, tracked_series: 2, failures_24h: 1, degraded_24h: 0, drift_24h: 0, consecutive_failures: 0,
  closes_7d: 36, closes_captured_7d: 36, closes_usable_7d: 36, close_capture_pct_7d: 100, open_game_markets_linked: 70, open_game_markets_unmapped: 462, unmapped_settling_soon: 0 };
/* public.odds_feed_status() as it answered on 2026-10-30 */
const SPORTS = (last, ko) => ['americanfootball_nfl', 'basketball_nba'].map((k) => ({ sport_key: k, last_verified_at: last, next_kickoff: ko, expected_refresh_minutes: 360 }));
const PAUSED = { state: 'paused', paused_by: 'quota_unconfirmed', paid_refresh: false, sports: SPORTS(null, null) };
const LOOPS = { schema: 'edgedesk_model_loop_health_v1', summary: { OK: 10, STALE: 0, DEGRADED: 0, OFF_SEASON: 0, NOT_SERVED: 1 },
  loops: [{ label: 'NFL', status: 'OK', reasons: [] }, { label: 'MLB (lab brain)', status: 'NOT_SERVED', reasons: ['the lab brain prices no live game (the card uses mlb/engine.js)'] }] };

const row = (H, label) => { const a = H.indexOf('<span class="l">' + label); if (a < 0) return null; const b = H.indexOf('</div>', a); return H.slice(a, b); };
const valOf = (H, label) => { const r = row(H, label); const m = r && /<span class="v ([^"]*)">([^<]*)<\/span>/.exec(r); return m ? { cls: m[1], text: m[2] } : null; };
const text = (H) => H.replace(/<[^>]+>/g, '');

/* ---------------------------------------------------------------- attribution */
let C = makeCtx({ ngl: NGL, ks: KS, odds: PAUSED, loops: LOOPS });
let H = C.sysHealthHTML();
let S = C.sysHealthState();
chk('attribution: Model health counts the self-check alone: 22/22 pass, none failing', (valOf(H, 'Model health') || {}).text === '22/22', valOf(H, 'Model health'));
chk('attribution: and is amber for its one warning, not red', (valOf(H, 'Model health') || {}).cls === 'warn', valOf(H, 'Model health'));
has(row(H, 'Model health'), 'NFL: model vs market line guard', 'attribution: the warning check is named');
chk('attribution: the NHL sync still fails the system (the header is red with 1 failing)', S.state === 'err' && S.n === 1, S);
chk('attribution: and the failing count names the NHL goalie sync', JSON.stringify(S.failing) === '["NHL goalie sync"]', S.failing);
chk('attribution: the model\'s own failure count is zero', S.modelFails === 0, S.modelFails);
has(H, 'Failing:</b> NHL goalie sync', 'attribution: the panel opens by saying what is failing');
C.$('sysHealthPill'); C.$('sysHealthBtn'); C.sysHealthPill();
has(C.__els.sysHealthBtn.attrs['aria-label'], '(NHL goalie sync)', 'attribution: and the control says it in words');
has(C.__els.sysHealthPill.title, 'Failing: NHL goalie sync', 'attribution: and in its title');
/* a real self-check failure still fails Model health */
C = makeCtx({ health: Object.assign({}, HEALTH, { checks: HEALTH.checks.concat([{ id: 'x', label: 'P4 engine tests', status: 'fail' }]) }) });
H = C.sysHealthHTML();
chk('attribution: a failed self-check is red in Model health', (valOf(H, 'Model health') || {}).cls === 'err' && (valOf(H, 'Model health') || {}).text === '22/23', valOf(H, 'Model health'));
has(row(H, 'Model health'), 'P4 engine tests', 'attribution: and named');

/* ---------------------------------------------------------------- jobs */
C = makeCtx({});
H = C.sysHealthHTML();
chk('jobs: six jobs, not fifteen keys', (valOf(H, 'Pipeline jobs') || {}).text === '6/6', valOf(H, 'Pipeline jobs'));
C = makeCtx({ health: Object.assign({}, HEALTH, { pipeline_meta: Object.assign({}, HEALTH.pipeline_meta, { p4_ingest_last_status: 'fail' }) }) });
H = C.sysHealthHTML();
chk('jobs: a status of "fail" is seen', (valOf(H, 'Pipeline jobs') || {}).text === '5/6' && (valOf(H, 'Pipeline jobs') || {}).cls === 'warn', valOf(H, 'Pipeline jobs'));
has(row(H, 'Pipeline jobs'), 'p4 ingest fail', 'jobs: and the failing job is named');
chk('jobs: and it asks for attention in the header', (C.sysHealthState().warning || []).indexOf('football pipeline job') >= 0, C.sysHealthState().warning);

/* ---------------------------------------------------------------- odds capture */
C = makeCtx({ odds: PAUSED });
H = C.sysHealthHTML();
chk('odds: quota unconfirmed reads paused', (valOf(H, 'Data / feed health') || {}).text === 'paused' && (valOf(H, 'Data / feed health') || {}).cls === 'pause', valOf(H, 'Data / feed health'));
has(row(H, 'Data / feed health'), 'quota for this billing cycle is not confirmed', 'odds: and says why');
chk('odds: no write on record reads "none on record", never a time', (valOf(H, 'Last successful sync') || {}).text === 'none on record', valOf(H, 'Last successful sync'));
has(row(H, 'Last successful sync'), 'records no verified capture for any sport', 'odds: and says where it looked');
chk('odds: a pause asks for attention, it is not a failure', C.sysHealthState().state === 'warn' && (C.sysHealthState().warning || []).indexOf('odds capture paused') >= 0, C.sysHealthState());
C = makeCtx({ odds: { state: 'paused', paused_by: 'provider_reserve', sports: SPORTS(iso(3 * 86400000), null) } });
H = C.sysHealthHTML();
chk('odds: the provider at its reserve reads quota exhausted', (valOf(H, 'Data / feed health') || {}).text === 'quota exhausted', valOf(H, 'Data / feed health'));
chk('odds: and the last write keeps its own time (3 days), never now', (valOf(H, 'Last successful sync') || {}).text === '3d ago', valOf(H, 'Last successful sync'));
C = makeCtx({ odds: { state: 'paused', paused_by: 'breaker_off', sports: SPORTS(null, null) } });
has(row(C.sysHealthHTML(), 'Data / feed health'), 'paused by configuration', 'odds: the breaker off is a pause by configuration');
C = makeCtx({ odds: { state: 'degraded', sports: SPORTS(iso(60000), iso(-3600000)) } });
chk('odds: degraded reads degraded', (valOf(C.sysHealthHTML(), 'Data / feed health') || {}).text === 'degraded');
C = makeCtx({ odds: { state: 'live', sports: SPORTS(iso(20 * 60000), iso(-3600000)) } });
chk('odds: live with a recent write is healthy', (valOf(C.sysHealthHTML(), 'Data / feed health') || {}).text === 'healthy' && C.sysHealthState().state !== 'err');
C = makeCtx({ odds: { state: 'live', sports: SPORTS(iso(13 * 3600000), iso(-3600000)) } });
chk('odds: live but 13 h behind a 6 h cadence is delayed', (valOf(C.sysHealthHTML(), 'Data / feed health') || {}).text === 'delayed');
C = makeCtx({ odds: { state: 'live', sports: SPORTS(null, iso(-3600000)) } });
chk('odds: live with no write on record is delayed, not healthy', (valOf(C.sysHealthHTML(), 'Data / feed health') || {}).text === 'delayed');
C = makeCtx({ odds: null, oddsErr: 'HTTP 503' });
H = C.sysHealthHTML();
chk('odds: an unreadable status is unknown', (valOf(H, 'Data / feed health') || {}).text === 'unknown' && (valOf(H, 'Data / feed health') || {}).cls === 'mut');
has(row(H, 'Data / feed health'), 'monitoring failed', 'odds: and says monitoring failed, not the feed');
C = makeCtx({});
chk('odds: nothing read yet is unknown, never healthy', (valOf(C.sysHealthHTML(), 'Data / feed health') || {}).text === 'unknown');
chk('odds: the panel reads public.odds_feed_status as anon', /function sysHealthOddsLoad\(force\)[\s\S]{0,700}rpc\/odds_feed_status/.test(SH_SRC) && /try\{sysHealthOddsLoad\(force\);\}catch\(_\)\{\}/.test(SH_SRC));

/* ---------------------------------------------------------------- frozen model */
C = makeCtx({});
H = C.sysHealthHTML();
chk('frozen: a season-fixed build reads as such, not stale', (valOf(H, 'Build freshness') || {}).text === 'season-fixed' && (valOf(H, 'Build freshness') || {}).cls === 'na', valOf(H, 'Build freshness'));
has(row(H, 'Build freshness'), 'held fixed through it by design', 'frozen: and says why');
has(row(H, 'Build freshness'), 'NFL 2026-10-29', 'frozen: beside how current the ratings are');
chk('frozen: and it adds nothing to the header', (C.sysHealthState().warning || []).join(',').indexOf('param') < 0);
C = makeCtx({ health: Object.assign({}, HEALTH, { run: { trigger: 'schedule' } }) });
chk('frozen: no stamp reads "—", never a fresh build', (valOf(C.sysHealthHTML(), 'Build freshness') || {}).text === '—');

/* ---------------------------------------------------------------- governance */
C = makeCtx({ loops: LOOPS });
H = C.sysHealthHTML();
chk('governance: the not-served loop is research-only', (valOf(H, 'Research-only (not served)') || {}).text === '1 research-only', valOf(H, 'Research-only (not served)'));
has(row(H, 'Research-only (not served)'), 'MLB (lab brain): the lab brain prices no live game', 'governance: named, with its reason');
chk('governance: and it is not attention', C.sysHealthState().state === 'warn' ? (C.sysHealthState().warning || []).join(',').indexOf('MLB') < 0 : true);

/* ---------------------------------------------------------------- kalshi */
C = makeCtx({ ks: KS });
H = C.sysHealthHTML();
has(row(H, 'Kalshi snapshot sync'), '1 failed run in 24 h, recovered: the latest snapshot succeeded', 'kalshi: a recovered failure is said from the counts');
chk('kalshi: and still counted as the view states it (degraded)', (valOf(H, 'Kalshi snapshot sync') || {}).text === 'degraded');

/* ---------------------------------------------------------------- text */
C = makeCtx({ ngl: NGL, ks: KS, odds: PAUSED, loops: LOOPS });
H = C.sysHealthHTML();
const T = text(H);
chk('text: no entity reaches the reader as text', !/&#x?[0-9a-f]+;/i.test(T.replace(/&(amp|lt|gt|quot|#39);/g, '')), T.match(/&#x?[0-9a-f]+;/i));
chk('text: label and value never run together', !/(\(game day\)|matched to a game|passing)\S/.test(T) && /<\/span> <span class="v /.test(H));
chk('text: label and note never run together', / <i>/.test(H) && T.indexOf('Model health1') < 0);
C = makeCtx({ ngl: Object.assign({}, NGL, { state_reason: '<img src=x onerror=alert(1)> &#x34;' }) });
H = C.sysHealthHTML();
lacks(H, '<img', 'text: a reason from the database is escaped (no markup)');
has(H, '&amp;#x34;', 'text: escaped exactly once: an entity in the data is shown as written, never decoded into markup');

/* ---------------------------------------------------------------- sections */
C = makeCtx({ ngl: NGL, ks: KS, odds: PAUSED, loops: LOOPS });
H = C.sysHealthHTML();
const secs = (H.match(/<div class="hps"[^>]*>([^<]*)<\/div>/g) || []).map((x) => x.replace(/<[^>]+>/g, ''));
chk('sections: six, in order', JSON.stringify(secs) === JSON.stringify(['Model health', 'Data sources', 'Scheduled jobs', 'Data quality and coverage', 'Research governance', 'Historical performance (7 days)']), secs);
chk('sections: the T-30 rate and close capture are history, not live health', H.indexOf('NHL starters confirmed by T-30') > H.indexOf('Historical performance') && H.indexOf('Kalshi close capture') > H.indexOf('Historical performance'));
chk('sections: the NHL starter source has its own row', (valOf(H, 'NHL starter sources') || {}).text === 'source down');

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'system health — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
