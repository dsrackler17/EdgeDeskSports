#!/usr/bin/env node
/* ===========================================================================
   Tests for the UFC LIVE FIGHT CENTER in app.html.

   Two kinds of check. Static: the page loads the shared engine, reads only
   the new contract (no legacy live_* tables, no Edge Function names on a
   customer's screen), never lets a Draw sit in a fighter's seat, keeps the
   anon key and nothing stronger, keeps the "no UFC model" honesty, and uses
   no tout language. Rendered: the UFC block is evaluated in a sandbox with a
   fake Supabase reader and painted for a LIVE card, a STALE card, a PRE card,
   a FINAL card and an unreachable table, and the HTML is inspected for what
   a reader would see — the state, the round and clock, the freshness, the
   stale banner, the sections, and the absence of anything invented.

   Run: node tools/ufc/fight_center_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const LIB = fs.readFileSync(path.join(ROOT, 'lib', 'ufc_research.js'), 'utf8');
const START = APP.indexOf('/* ===== UFC research tab');
const END = APP.indexOf('/* Per-user data ownership guard.');
chk('the UFC module is found between its markers', START > 0 && END > START);
const SRC = APP.slice(START, END);

/* ======================================================================== */
/* 1. STATIC                                                                */
/* ======================================================================== */
has(APP, '<script src="/lib/ufc_research.js', 'the shared research engine is loaded');
chk('the engine script tag precedes the block that uses it', APP.indexOf('<script src="/lib/ufc_research.js') < START);
['live_events', 'live_fights', 'live_event_state', 'live_fight_state', 'live_fight_round_stats', 'live_fight_snapshots', 'live_pipeline_health']
  .forEach(t => lacks(APP, "'" + t + "?", 'the page no longer reads the legacy table ' + t));
['ufc_live_stats', 'ufc_live poller', 'ufc_live edge', 'sql/ufc_live_v2.sql', 'refresh_style_metrics'].forEach(t => lacks(APP, t, 'no dead reference to ' + t));
has(SRC, 'boutsFromSignals', 'priced bouts come from fixtures, through the engine');
lacks(SRC, 'var A=h2h[ks[0]],B=h2h[ks[1]]', 'the first-two-selections pairing that produced "Jean Silva vs Draw" is gone');
has(SRC, 'draw_sig_key', 'a draw price is carried under its own key');
['events?select=', 'bouts?select=', 'fight_live_state?select=', 'fight_round_stats?select=', 'fight_snapshots?select=', 'fighter_baselines?select=', 'bout_markets?select=', 'market_captures?select=', 'pipeline_status?select=', 'market_rejections?select=']
  .forEach(q => has(SRC, q, 'the page reads ' + q.replace('?select=', '')));
has(SRC, 'LIVE DATA STALE', 'a stopped poller is shouted, not whispered');
['EDGEDESK LIVE READ', 'WHAT’S DIFFERENT TONIGHT', 'Round breakdown', 'Striking battle', 'Wrestling / grappling battle', 'Range / positional battle', 'Pace + cardio', 'Damage / pressure indicators', 'Market vs fight', 'Closing line / CLV integrity', 'Matchup baselines', 'Fighter research', 'What we don’t know', 'Methodology']
  .forEach(t => has(SRC, t, 'the Fight Center carries the section "' + t + '"'));
has(SRC, 'not an official scorecard', 'the round lean is labelled as not a scorecard');
has(SRC, 'no UFC model is registered', 'the model gate stays honest');
has(SRC, 'Closing line unavailable', 'a missing close is stated, never substituted');
has(SRC, 'Research context, not a wagering recommendation', 'the live read disclaims itself');
['BET THIS', 'LOCK OF', 'HAMMER', 'guaranteed edge', 'model says bet', 'AI pick'].forEach(w => lacks(SRC, w, 'no tout language: ' + w));
lacks(SRC, "'espn:600", 'no hardcoded current event id');
lacks(SRC, 'red_fighter_id:\'', 'no hardcoded fighter id');
chk('the anon key in the page is an anon key', () => {
  const m = /var SB_KEY="([^"]+)"/.exec(APP); const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64').toString('utf8'));
  return payload.role === 'anon';
});
['app.html', 'index.html', 'lib/ufc_research.js', 'lib/edgedesk_auth.js', 'lib/edgedesk_report.js'].forEach(f => {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  chk('no service-role credential in ' + f, !/"role":"service_role"|service_role_key|SUPABASE_SERVICE_ROLE_KEY/.test(t) && !/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/.test(t));
});
chk('the engine is plain script for the browser and a module for Node', /root\.EDUfcResearch = api/.test(LIB) && /module\.exports = api/.test(LIB));
has(APP, 'ufc_live_center.sql', 'the migration is named where an operator would look');
has(APP, "researchRegister({id:'ufc'", 'the UFC module is still registered with the research shell');

/* ======================================================================== */
/* 2. RENDERED                                                              */
/* ======================================================================== */
function sandbox(tables, opts) {
  opts = opts || {};
  const els = {};
  function el(id) { return els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, scrollIntoView() {} }); }
  const ctx = {
    console, JSON, Math, Date, String, Number, Array, Object, Promise, RegExp, Error, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { hidden: false, body: { style: {} }, querySelector() { return null; }, addEventListener() {} },
    $: (id) => (id === 'ufcBody' || id === 'ufcFresh' || id === 'ufcQ') ? el(id) : null,
    stEsc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    rsEsc: (s) => String(s == null ? '' : s), _escHtml: (s) => String(s == null ? '' : s), edAttrJs: (s) => String(s == null ? '' : s),
    ago: (ms) => Math.round((Date.now() - ms) / 1000) + 's ago', whenLabel: (iso) => String(iso), rsTkWhen: (x) => String(x), rsTkPts: (v) => String(v), rsParseStamp: (v) => Date.parse(v),
    rsTkScrollTo() {}, rsFreshApply() {}, rsSetState() {}, rsMetaRender() {}, rsProbeFields() {}, rsTkRefresh() {}, rsTkDrawerOpen() {}, rsTkDrawerIsOpen() { return false; }, rsModelsLoad() { return Promise.resolve(); },
    rsTkSysCard: (o) => '<sys level="' + o.level + '">' + o.tt + '|' + o.ts + '</sys>' + o.body, rsTkPipeRows: () => '', rsTkPipeLevel: () => null, rsTkStateCard: () => '', rsTkSkel: () => '', rsTkSnap: (o) => JSON.stringify(o.kpis), rsTkToday: (items) => items.map(i => i.title).join('|'), rsTkTool: () => '', rsTkMvm: (o) => o.game, rsTkBadges: (b) => JSON.stringify(b), rsTkProvRows: () => '', rsTkLimits: () => '', rsDatasetHTML: () => '', rsBadgeHTML: () => '', rsSaveBtnHTML: () => '', rsDefFor: () => '', rsFreshness: () => null, rsFieldCoverage: () => null,
    GE: { fmtPrice: (d) => (d >= 2 ? '+' + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1)))), decToAm: (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1))) },
    BOARD_FLAG_COLS: 'flagged_at,flagged_best_dec', RESEARCH_MODULES: { ufc: { _: { uistate: { state: 'ok' } } } }, RS_PROV: {}, RS_LIMITS: {}, edIsOwner: () => !!opts.owner,
    sbGetUfc: async (q) => {
      const rel = q.split('?')[0];
      if (opts.failEvents && rel === 'events') { const e = new Error('db 404'); e.status = 404; throw e; }
      let rows = (tables['ufc.' + rel] || []).slice();
      const m = /[?&]([a-z_]+)=eq\.([^&]+)/.exec(q);
      if (m) rows = rows.filter(r => String(r[m[1]]) === decodeURIComponent(m[2]));
      const inm = /[?&]([a-z_]+)=in\.\(([^)]+)\)/.exec(q);
      if (inm) { const vals = inm[2].split(',').map(v => decodeURIComponent(v).replace(/^"|"$/g, '').replace(/^%22|%22$/g, '')); rows = rows.filter(r => vals.indexOf(String(r[inm[1]])) >= 0); }
      return rows;
    },
    sbGet: async (q) => { if (opts.failSignals) { const e = new Error('db 401'); e.status = 401; throw e; } return (tables['public.signals'] || []).slice(); }
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(LIB, ctx, { filename: 'ufc_research.js' });
  vm.runInContext(SRC, ctx, { filename: 'ufc-block.js' });
  ctx.UFC.mode = 'live';   /* what the Live Fight Center tab sets before it loads */
  return { ctx, els };
}
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
function cardTables(o) {
  o = o || {};
  const ev = { event_id: 'espn:1', provider_event_id: '1', name: 'UFC Fight Night: Testerson vs. Sparring', short_name: 'Testerson vs. Sparring', venue: 'Test Arena', city: 'Testville', state: 'TX', scheduled_at: iso(NOW - 2 * 3600000),
    event_state: o.state || 'live', current_bout_id: 'espn:12', bouts_total: 3, bouts_completed: 1, bouts_live: o.state === 'live' ? 1 : 0, source_updated_at: iso(NOW - (o.writeAgeS || 12) * 1000), updated_at: iso(NOW - (o.writeAgeS || 12) * 1000) };
  if (o.state === 'scheduled') { ev.scheduled_at = iso(NOW + 2 * 86400000); ev.current_bout_id = 'espn:11'; ev.bouts_completed = 0; }
  if (o.state === 'final') { ev.completed_at = iso(NOW - 3600000); ev.bouts_completed = 3; ev.current_bout_id = null; }
  const st = o.state === 'scheduled' ? ['scheduled', 'scheduled', 'scheduled'] : (o.state === 'final' ? ['final', 'final', 'final'] : ['final', 'live', 'scheduled']);
  const bouts = [
    { bout_id: 'espn:11', event_id: 'espn:1', bout_order: 1, card_segment: 'Prelims', is_main: false, weight_class: 'Welterweight', scheduled_rounds: 3, red_name: 'Some Body', blue_name: 'Any One', red_fighter_id: null, blue_fighter_id: null, status: st[0], winner_corner: st[0] === 'final' ? 'red' : null, method: st[0] === 'final' ? 'KO/TKO' : null, end_round: st[0] === 'final' ? 1 : null, end_time: st[0] === 'final' ? '3:12' : null, first_bell_at: st[0] === 'final' ? iso(NOW - 5400000) : null, source_updated_at: iso(NOW - 12000) },
    { bout_id: 'espn:12', event_id: 'espn:1', bout_order: 2, card_segment: 'Main Card', is_main: false, weight_class: 'Flyweight', scheduled_rounds: 3, red_name: 'Zhang Fixture', blue_name: 'Alex Placeholder', red_fighter_id: 'fixture-zhang', blue_fighter_id: 'alexander-placeholder', status: st[1], round: st[1] === 'live' ? 3 : (st[1] === 'final' ? 3 : null), clock: st[1] === 'live' ? '2:41' : null, clock_seconds: st[1] === 'live' ? 161 : null, elapsed_seconds: st[1] === 'live' ? 739 : (st[1] === 'final' ? 900 : null), winner_corner: st[1] === 'final' ? 'blue' : null, method: st[1] === 'final' ? 'Decision - Unanimous' : null, first_bell_at: st[1] === 'scheduled' ? null : iso(NOW - 800000), close_bound_source: st[1] === 'scheduled' ? null : 'observed_bell', source_updated_at: iso(NOW - 12000) },
    { bout_id: 'espn:13', event_id: 'espn:1', bout_order: 3, card_segment: 'Main Card', is_main: true, is_title: true, weight_class: 'Lightweight', scheduled_rounds: 5, red_name: 'Marco Testerson', blue_name: 'Ivan Sparring', red_fighter_id: 'marco-testerson', blue_fighter_id: 'ivan-sparring', status: st[2], first_bell_at: st[2] === 'final' ? iso(NOW - 3000000) : null, source_updated_at: iso(NOW - 12000) }
  ];
  const stat = (bout_id, corner, s) => Object.assign({ bout_id, event_id: 'espn:1', corner, status: 'live', round: 3, clock: '2:41', elapsed_seconds: 739, stats_available: true, source: 'espn', source_updated_at: iso(NOW - (o.liveAgeS || 12) * 1000), updated_at: iso(NOW - (o.liveAgeS || 12) * 1000) }, s);
  const states = o.state === 'scheduled' ? [] : [
    stat('espn:12', 'red', { sig_strikes_landed: 52, sig_strikes_attempted: 110, total_strikes_landed: 84, takedowns_landed: 3, takedowns_attempted: 6, control_seconds: 194, knockdowns: 1, submission_attempts: 0, head_strikes_landed: 30, body_strikes_landed: 15, leg_strikes_landed: 7, distance_strikes_landed: 20, clinch_strikes_landed: 12, ground_strikes_landed: 20 }),
    stat('espn:12', 'blue', { sig_strikes_landed: 38, sig_strikes_attempted: 90, total_strikes_landed: 66, takedowns_landed: 1, takedowns_attempted: 4, control_seconds: 62, knockdowns: 0, submission_attempts: 1 })
  ];
  const base = (fighter_id, full_name, x) => Object.assign({ fighter_id, full_name, built_at: iso(NOW - 86400000), fights_on_file: 12, dated_fights: 12, career_stats_available: true, slpm: 3.5, sapm: 3.0, striking_accuracy: 0.45, striking_defense: 0.55, takedown_avg: 1.2, takedown_accuracy: 0.4, takedown_defense: 0.6, submission_avg: 0.5, wins: 9, losses: 3, draws: 0, win_ko: 4, win_sub: 2, win_dec: 3, loss_ko: 1, loss_sub: 0, loss_dec: 2, finish_rate: 0.667, finished_loss_rate: 0.333, avg_fight_seconds: 700, timed_fights: 12, fights_past_r3: 1, r4_r5_seconds: 300, finishes_after_r3: 0, days_since_last_fight: 120, fights_last_365: 2, fights_last_730: 4, current_streak: 2, opp_avg_win_pct: 0.62, opp_sample: 10, obs_fights: 0, style_labels: ['STRIKER'], style_rules_version: 'style-rules-v1', notes: [] }, x || {});
  return {
    'ufc.events': [ev], 'ufc.bouts': bouts, 'ufc.fight_live_state': states,
    'ufc.fighter_baselines': [base('fixture-zhang', 'Zhang Fixture'), base('alexander-placeholder', 'Alex Placeholder', { takedown_avg: 3.1, style_labels: ['WRESTLER'] }), base('marco-testerson', 'Marco Testerson'), base('ivan-sparring', 'Ivan Sparring')],
    'ufc.bout_markets': [{ bout_id: 'espn:12', event_id: 'espn:1', signal_event_id: 'odds1', red_sig_key: 'k1', blue_sig_key: 'k2', draw_sig_key: 'k3', link_method: 'both_names_exact' }],
    'ufc.fight_round_stats': o.state === 'scheduled' ? [] : [
      { bout_id: 'espn:12', round: 1, corner: 'red', round_status: 'complete', stat_source: 'snapshot_delta', round_seconds: 300, sig_strikes_landed: 20, sig_strikes_attempted: 40, takedowns_landed: 1, takedowns_attempted: 2, control_seconds: 60, knockdowns: 1, submission_attempts: 0 },
      { bout_id: 'espn:12', round: 1, corner: 'blue', round_status: 'complete', stat_source: 'snapshot_delta', round_seconds: 300, sig_strikes_landed: 15, sig_strikes_attempted: 35, takedowns_landed: 0, takedowns_attempted: 1, control_seconds: 20, knockdowns: 0, submission_attempts: 0 },
      { bout_id: 'espn:12', round: 2, corner: 'red', round_status: 'complete', stat_source: 'snapshot_delta', round_seconds: 300, sig_strikes_landed: 18, sig_strikes_attempted: 40, takedowns_landed: 1, takedowns_attempted: 2, control_seconds: 70, knockdowns: 0, submission_attempts: 0 },
      { bout_id: 'espn:12', round: 2, corner: 'blue', round_status: 'complete', stat_source: 'snapshot_delta', round_seconds: 300, sig_strikes_landed: 13, sig_strikes_attempted: 30, takedowns_landed: 1, takedowns_attempted: 2, control_seconds: 30, knockdowns: 0, submission_attempts: 1 }],
    'ufc.fight_snapshots': [], 'ufc.market_captures': [
      { sig_key: 'k1', corner: 'red', capture_at: iso(NOW - 3 * 86400000), market_state: 'PRE', best_dec: 1.7, sharp_fair: 0.56, source: 'signals_open' },
      { sig_key: 'k1', corner: 'red', capture_at: iso(NOW - 900000), market_state: 'PRE', best_dec: 1.6, sharp_fair: 0.6, source: 'signals' },
      { sig_key: 'k2', corner: 'blue', capture_at: iso(NOW - 3 * 86400000), market_state: 'PRE', best_dec: 2.3, sharp_fair: 0.44, source: 'signals_open' },
      { sig_key: 'k2', corner: 'blue', capture_at: iso(NOW - 900000), market_state: 'PRE', best_dec: 2.5, sharp_fair: 0.4, source: 'signals' },
      { sig_key: 'k1', corner: 'red', capture_at: iso(NOW - 300000), market_state: 'LIVE', best_dec: 1.3, sharp_fair: 0.75, round: 2, clock: '1:00', source: 'signals' },
      { sig_key: 'k2', corner: 'blue', capture_at: iso(NOW - 300000), market_state: 'LIVE', best_dec: 3.6, sharp_fair: 0.25, round: 2, clock: '1:00', source: 'signals' }],
    'ufc.pipeline_status': [{ job: 'ufc_live', run_id: 'r', event_id: 'espn:1', status: 'running', heartbeat_at: iso(NOW - (o.liveAgeS || 12) * 1000), last_success_at: iso(NOW - (o.liveAgeS || 12) * 1000), seconds_since_heartbeat: o.liveAgeS || 12, seconds_since_success: o.liveAgeS || 12, polls: 40, writes: 120, details: {} },
      { job: 'ufc_sync', run_id: 's', status: 'ok', heartbeat_at: iso(NOW - 3600000), last_success_at: iso(NOW - 3600000), seconds_since_heartbeat: 3600, seconds_since_success: 3600, details: {} }],
    'ufc.market_rejections': [{ signal_event_id: 'odds9', sig_key: '', home_team: 'Draw', away_team: 'Rafa Garcia', reason: 'draw_as_fighter', seen_count: 3, last_seen_at: iso(NOW) }],
    'public.signals': [
      { sig_key: 'k1', event_id: 'odds1', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Zhang Fixture', home_team: 'Zhang Fixture', away_team: 'Alex Placeholder', commence_time: iso(NOW - 7200000), best_dec: 1.3, best_book: 'bookA', first_best_dec: 1.7, first_seen_at: iso(NOW - 3 * 86400000), sharp_fair: 0.75, n_books: 6, has_sharp: true, last_seen_at: iso(NOW - (o.marketAgeS || 28) * 1000) },
      { sig_key: 'k2', event_id: 'odds1', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Alex Placeholder', home_team: 'Zhang Fixture', away_team: 'Alex Placeholder', commence_time: iso(NOW - 7200000), best_dec: 3.6, best_book: 'bookB', first_best_dec: 2.3, first_seen_at: iso(NOW - 3 * 86400000), sharp_fair: 0.25, n_books: 6, has_sharp: true, last_seen_at: iso(NOW - (o.marketAgeS || 28) * 1000) },
      { sig_key: 'k3', event_id: 'odds1', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Draw', home_team: 'Zhang Fixture', away_team: 'Alex Placeholder', commence_time: iso(NOW - 7200000), best_dec: 51, last_seen_at: iso(NOW - 28000) },
      { sig_key: 'k4', event_id: 'odds2', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Draw', home_team: 'Draw', away_team: 'Rafa Garcia', commence_time: iso(NOW + 86400000), best_dec: 41, last_seen_at: iso(NOW - 28000) },
      { sig_key: 'k5', event_id: 'odds3', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Jean Silva', home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: iso(NOW + 86400000), best_dec: 1.5, first_best_dec: 1.4, last_seen_at: iso(NOW - 28000) },
      { sig_key: 'k6', event_id: 'odds3', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Rafa Garcia', home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: iso(NOW + 86400000), best_dec: 2.7, first_best_dec: 3.0, last_seen_at: iso(NOW - 28000) },
      { sig_key: 'k7', event_id: 'odds3', sport_key: 'mma_mixed_martial_arts', market: 'h2h', selection: 'Draw', home_team: 'Jean Silva', away_team: 'Rafa Garcia', commence_time: iso(NOW + 86400000), best_dec: 41, last_seen_at: iso(NOW - 28000) }]
  };
}
(async () => {
  /* ---- LIVE ---- */
  let sb = sandbox(cardTables({ state: 'live' }), { owner: true });
  sb.ctx.UFC.byId = { 'fixture-zhang': { fighter_id: 'fixture-zhang', full_name: 'Zhang Fixture', age: 28, height_inches: 66, reach_inches: 68, stance: 'Orthodox', wins: 9, losses: 1, draws: 0 } };
  await sb.ctx.loadUFCLive();
  sb.ctx.UFC.at = Date.now();
  await sb.ctx.ufcMarketFetch();
  let html = sb.els.ufcBody.innerHTML;
  has(html, 'ufc-fc-state live">LIVE<', 'a live card reads LIVE');
  has(html, 'Round 3 · 2:41', 'the header shows round and clock');
  has(html, 'Fight 2 of 3', 'the header shows the fight number');
  has(html, '1 remaining', 'and the bouts remaining');
  has(html, 'Zhang Fixture', 'the current fight is the selected bout');
  has(html, 'id="ufcFcHero"', 'the hero renders');
  has(html, '<b>Live</b> 12s ago', 'live freshness is on screen');
  has(html, '<b>Market</b>', 'market freshness is on screen');
  has(html, '<b>History</b>', 'history freshness is on screen');
  lacks(html, 'LIVE DATA STALE', 'a 12-second-old feed is not stale');
  has(html, 'EDGEDESK LIVE READ', 'the live read renders');
  has(html, 'WHAT’S DIFFERENT TONIGHT', 'the flags panel renders');
  has(html, 'WRESTLING SHIFT', 'a wrestling shift fires on 6 attempts against a 1.2/15 career rate');
  has(html, 'KNOCKDOWN', 'a knockdown is reported');
  has(html, '52/110', 'key stats show landed/attempted');
  has(html, '3:14', 'control time is formatted');
  has(html, 'Round breakdown', 'the round table renders');
  has(html, 'not an official scorecard', 'and says it is not a scorecard');
  has(html, 'Market vs fight', 'the market-vs-fight panel renders');
  has(html, 'No EdgeDesk UFC model is registered', 'the model gate is visible');
  lacks(html, 'vs Draw', 'no bout is drawn against a Draw');
  has(html, '✓', 'the strip marks the finished bout');
  has(html, 'def.', 'and names its winner');
  has(html, 'ufc-strip-b live on', 'the live bout is selected in the strip');
  has(html, 'separate outcome, never a corner', 'the draw is shown as a separate outcome, not a corner');
  has(html, 'Body def. One', 'a bout whose fighters are not on file still renders by name in the strip');
  chk('the health level during a fresh live card is HEALTHY', sb.ctx.ufcFcHealth().level === 'HEALTHY', sb.ctx.ufcFcHealth().level);
  const sys = sb.ctx.ufcSystemHTML();
  has(sys, 'level="ok"', 'the system card is ok on a fresh live card');
  has(sys, 'Rejected market rows', 'the operator diagnostics list rejected market rows');
  has(sys, 'draw_as_fighter', 'with their reason');
  const todayTitles = sb.ctx.ufcTodayItems(sb.ctx.ufcBouts());
  chk('the overview never titles a bout with a Draw', todayTitles.every(t => !/vs Draw|Draw vs/.test(t.title)), JSON.stringify(todayTitles.map(t => t.title)));
  chk('the overview finds the priced bouts', sb.ctx.ufcBouts().length === 2 && sb.ctx.ufcBouts().every(b => b.a.selection !== 'Draw' && b.b.selection !== 'Draw'));
  chk('the draw-as-fighter fixture is rejected, not priced', sb.ctx.UFC.market.rejected.some(r => r.reasons[0].reason === 'draw_as_fighter'));

  /* ---- LIVE but the poller stopped 4 minutes ago ---- */
  sb = sandbox(cardTables({ state: 'live', liveAgeS: 240, writeAgeS: 240 }));
  await sb.ctx.loadUFCLive();
  sb.ctx.UFC.at = Date.now();
  html = sb.els.ufcBody.innerHTML;
  has(html, 'LIVE DATA STALE · last update 4m 00s ago', 'a stopped poller is shouted in the header');
  chk('the health level is STALE during a card with a 4-minute-old feed', sb.ctx.ufcFcHealth().level === 'STALE');
  has(sb.ctx.ufcSystemHTML(), 'level="neg"', 'and the system card is red, not "operational"');
  lacks(sb.ctx.ufcSystemHTML(), 'operational', 'nothing says operational');

  /* ---- a card still marked live that nothing has written for 20 days ---- */
  sb = sandbox(cardTables({ state: 'live', liveAgeS: 20 * 86400, writeAgeS: 20 * 86400 }));
  await sb.ctx.loadUFCLive();
  html = sb.els.ufcBody.innerHTML;
  has(html, '>STALE<', 'a 20-day-old open card is shown as STALE, never LIVE');
  lacks(html, 'ufc-fc-state live"', 'and never wears the LIVE badge');
  has(html, 'It is not shown as live', 'and the banner says why');

  /* ---- PRE ---- */
  sb = sandbox(cardTables({ state: 'scheduled' }));
  await sb.ctx.loadUFCLive();
  html = sb.els.ufcBody.innerHTML;
  has(html, '>PRE<', 'a scheduled card reads PRE');
  chk('the default bout before a card is the first scheduled one', sb.ctx.UFC.fc.sel === 'espn:11');
  has(html, 'nothing to read yet', 'a bout with no baseline and no market says so instead of reading nothing');
  await sb.ctx.ufcFcSelect('espn:12');
  sb.ctx.ufcFcToggle('clv');
  html = sb.els.ufcBody.innerHTML;
  has(html, 'EDGEDESK PRE-FIGHT READ', 'the pre-fight read renders');
  has(html, 'STRIKER vs WRESTLER', 'the style collision is stated');
  has(html, 'Market research', 'the market panel is open before the fight');
  has(html, 'Matchup baselines', 'matchup baselines render');
  has(html, 'pending', 'CLV is pending before the bell');
  lacks(html, 'EDGEDESK LIVE READ', 'no live read before the fight');

  /* ---- FINAL ---- */
  sb = sandbox(cardTables({ state: 'final' }));
  await sb.ctx.loadUFCLive();
  html = sb.els.ufcBody.innerHTML;
  has(html, '>FINAL<', 'a finished card reads FINAL');
  has(html, 'Result pending', 'a final bout the poller has no winner for reads pending, never a no contest');
  await sb.ctx.ufcFcSelect('espn:12');
  sb.ctx.ufcFcToggle('clv');
  html = sb.els.ufcBody.innerHTML;
  has(html, 'Decision - Unanimous', 'the result is shown');
  has(html, 'Closing line', 'the close section renders');

  /* ---- unreachable ---- */
  sb = sandbox(cardTables({ state: 'live' }), { failEvents: true });
  await sb.ctx.loadUFCLive();
  sb.ctx.UFC.at = Date.now();
  html = sb.els.ufcBody.innerHTML;
  has(html, '>OFFLINE<', 'an unreachable event table reads OFFLINE');
  has(html, 'ufc_live_center.sql', 'and names the migration');
  has(sb.ctx.ufcSystemHTML(), 'level="neg"', 'the system card is red');

  /* ---- signals unreadable (no subscription) ---- */
  sb = sandbox(cardTables({ state: 'live' }), { failSignals: true });
  await sb.ctx.loadUFCLive();
  html = sb.els.ufcBody.innerHTML;
  has(html, 'not readable this session', 'an unreadable market says so instead of showing a price');
  chk('and degrades the health level to MARKET DEGRADED', sb.ctx.ufcFcHealth().level === 'MARKET DEGRADED', sb.ctx.ufcFcHealth().level);

  const line = 'UFC Fight Center UI | ' + pass + ' passed, ' + fail + ' failed';
  if (fail) { console.log('FAIL | ' + line); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('PASS | ' + line);
})().catch(e => { console.error('harness error: ' + (e && e.stack || e)); process.exit(1); });
