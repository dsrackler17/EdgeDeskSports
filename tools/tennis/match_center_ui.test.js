#!/usr/bin/env node
/* ===========================================================================
   Tests for the TENNIS LIVE MATCH CENTER in app.html.

   Two kinds of check. Static: the page loads the shared engine, reads only
   the committed contract, keeps the anon key and nothing stronger, keeps the
   "no EdgeDesk tennis model" honesty, never lets a doubles pair sit in a
   player's seat, and uses no tout language. Rendered: the tennis block is
   evaluated in a sandbox with a fake Supabase reader and painted for a LIVE
   match, a match whose poller has stopped, a PRE match, a FINAL match, a
   doubles match and an unreachable table — and the HTML is inspected for what
   a reader would actually see.

   Run: node tools/tennis/match_center_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const LIB = fs.readFileSync(path.join(ROOT, 'lib', 'tennis_research.js'), 'utf8');
const START = APP.indexOf('/* ═══ TENNIS deep dive');
const END = APP.indexOf('async function sbGetCfb(');
chk('the tennis module is found between its markers', START > 0 && END > START);
const SRC = APP.slice(START, END);

/* ======================================================================== */
/* 1. STATIC                                                                */
/* ======================================================================== */
has(APP, '<script src="/lib/tennis_research.js', 'the shared research engine is loaded');
chk('the engine script tag precedes the block that uses it', APP.indexOf('<script src="/lib/tennis_research.js') < START);
chk('the engine is plain script for the browser and a module for Node',
  /root\.EDTennisResearch = api/.test(LIB) && /module\.exports = api/.test(LIB));

['live_matches?select=', 'tournaments?select=', 'match_live_state?select=', 'match_set_stats?select=',
 'match_snapshots?select=', 'player_baselines?select=', 'match_markets?select=', 'market_captures?select=',
 'pipeline_status?select=', 'market_rejections?select=']
  .forEach(q => has(SRC, q, 'the page reads ' + q.replace('?select=', '')));
['rankings_current?select=', 'matches?select=', 'player_career?select=', 'player_surface?select=', 'player_form?select=']
  .forEach(q => has(SRC, q, 'the licensed record is still read: ' + q.replace('?select=', '')));

has(APP, 'tennis_live_center.sql', 'the migration is named where an operator would look');
has(SRC, 'first_point_at', 'the first-point boundary is carried into the page');
has(SRC, 'close_bound_source', 'and the page can say which boundary it used');
has(SRC, 'can never become a pre-match close', 'a live price is never presented as a close');
has(SRC, 'there is no EdgeDesk tennis model', 'the model gate stays honest');
has(SRC, 'A pair is a team', 'a doubles pair is never given a player baseline');
has(SRC, 'never resolved to one of its players', 'the doubles rule is stated where a reader can see it');
has(SRC, 'No Edge Function is involved', 'the architecture is stated on the page');
has(SRC, 'is a number, not an injury', 'a flag is never dressed up as a physical claim');
has(SRC, 'it is not a zero', 'a missing field is never read as zero');
['BET THIS', 'LOCK OF', 'HAMMER', 'guaranteed edge', 'model says bet', 'AI pick'].forEach(
  w => lacks(SRC, w, 'no tout language: ' + w));
lacks(SRC, "'espn:800", 'no hardcoded match id');
lacks(SRC, "home_player_id:'", 'no hardcoded player id');
lacks(SRC, 'Date.now())', 'no freshness stamp falls back to the clock');

chk('the anon key in the page is an anon key', () => {
  const m = /var SB_KEY="([^"]+)"/.exec(APP);
  const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64').toString('utf8'));
  return payload.role === 'anon';
});
['app.html', 'index.html', 'lib/tennis_research.js', 'lib/ufc_research.js'].forEach(f => {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  chk('no service-role credential in ' + f,
    !/"role":"service_role"|service_role_key|SUPABASE_SERVICE_ROLE_KEY/.test(t) &&
    !/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/.test(t));
});
has(SRC, "researchRegister({id:'tennis'", 'the tennis module is still registered with the research shell');
has(APP, "id=\"tddLiveBody\"", 'the match centre has a home in the panel');
has(APP, "tddSetTour('LIVE')", 'and a way in from the segment row');

/* ======================================================================== */
/* 2. RENDERED                                                              */
/* ======================================================================== */
const NOW = Date.parse('2026-05-28T11:30:00Z');
function iso(msAgo) { return new Date(NOW - msAgo).toISOString(); }

function baseTables(over) {
  const t = {
    'tennis.tournaments': [{ tournament_id: 'espn:t1', tour: 'ATP', name: 'Testville Open', surface: 'clay', city: 'Testville',
      country: 'TST', state: 'live', matches_total: 4, matches_completed: 1, matches_live: 1, source_updated_at: iso(20000) }],
    'tennis.live_matches': [],
    'tennis.match_live_state': [],
    'tennis.match_set_stats': [],
    'tennis.match_snapshots': [],
    'tennis.player_baselines': [],
    'tennis.match_markets': [],
    'tennis.market_captures': [],
    'tennis.market_rejections': [],
    'tennis.pipeline_status': [
      { job: 'tennis_live', run_id: 'r1', scope: 'atp:2026-05-28', status: 'running', heartbeat_at: iso(20000), last_success_at: iso(20000), consecutive_failures: 0 },
      { job: 'tennis_sync', run_id: 's1', status: 'ok', heartbeat_at: iso(600000), last_success_at: iso(600000) },
      { job: 'tennis_baselines', run_id: 'b1', status: 'ok', last_success_at: iso(86400000) }
    ],
    'tennis.meta': [{ key: 'tennis_sync_last_status', value: 'ok' }],
    'tennis.rankings_current': [], 'tennis.players': [], 'tennis.matches': [],
    'wta.daily_research': [], 'wta.watchlist': [], 'wta.meta': [],
    'public.signals': []
  };
  Object.keys(over || {}).forEach(k => { t[k] = over[k]; });
  return t;
}
function liveMatch(over) {
  return Object.assign({
    match_id: 'espn:m1', tournament_id: 'espn:t1', tour: 'ATP', round: 'Round of 32', match_order: 1, court: 'Court Placeholder',
    is_doubles: false, best_of: 5, scheduled_at: iso(2400000), home_name: 'Marco Testerson', away_name: 'Ivan Placeholder',
    home_player_id: 'p1', away_player_id: 'p2', home_seed: '4', away_seed: '12', home_rank: 5, away_rank: 14,
    status: 'live', current_set: 2, sets_home: 1, sets_away: 0, games_home: 1, games_away: 2,
    set_scores: [{ home: 6, away: 3 }, { home: 1, away: 2 }], server_side: 'home',
    first_point_at: iso(1800000), close_bound_source: 'observed_first_point', source_updated_at: iso(20000)
  }, over || {});
}
function stateRow(side, over) {
  return Object.assign({ match_id: 'espn:m1', tournament_id: 'espn:t1', side: side, player_id: side === 'home' ? 'p1' : 'p2',
    player_name: side === 'home' ? 'Marco Testerson' : 'Ivan Placeholder', status: 'live', current_set: 2,
    stats_available: true, aces: side === 'home' ? 5 : 1, double_faults: side === 'home' ? 1 : 4,
    first_serves_in: side === 'home' ? 22 : 17, first_serves_total: side === 'home' ? 33 : 31,
    first_serve_points_won: side === 'home' ? 18 : 10, first_serve_points_total: side === 'home' ? 22 : 17,
    second_serve_points_won: side === 'home' ? 5 : 4, second_serve_points_total: side === 'home' ? 11 : 14,
    service_games_played: 5, service_games_won: side === 'home' ? 5 : 3,
    service_points_won: side === 'home' ? 23 : 14, service_points_total: side === 'home' ? 33 : 31,
    break_points_faced: side === 'home' ? 2 : 4, break_points_saved: 2,
    break_points_won: side === 'home' ? 2 : 0, break_points_total: side === 'home' ? 4 : 2,
    return_points_won: side === 'home' ? 16 : 10, return_points_total: side === 'home' ? 30 : 33,
    total_points_won: side === 'home' ? 39 : 24, updated_at: iso(20000) }, over || {});
}

function sandbox(tables, opts) {
  opts = opts || {};
  const els = {};
  function el(id) { return els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, querySelectorAll() { return []; }, scrollIntoView() {} }); }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = {
    console, JSON, Math, Date, String, Number, Array, Object, Promise, RegExp, Error, isFinite, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    document: { hidden: false, body: { style: {} }, querySelector() { return null; }, getElementById: (id) => el(id), addEventListener() {} },
    $: (id) => el(id),
    stEsc: esc, rsEsc: esc, _escHtml: esc, edAttrJs: (s) => String(s == null ? '' : s).replace(/'/g, "\\'"),
    ago: (ms) => Math.round((NOW - ms) / 1000) + 's ago', whenLabel: (x) => String(x),
    rsTkWhen: (x) => String(x), rsTkPts: (v) => String(v), rsParseStamp: (v) => Date.parse(v),
    rsTkScrollTo() {}, rsFreshApply() {}, rsSetState() {}, rsMetaRender() {}, rsProbeFields() {}, rsTkRefresh() {},
    rsTkDrawerOpen() {}, rsTkDrawerIsOpen() { return false; }, rsModelsLoad() { return Promise.resolve(); },
    rsTkSysCard: (o) => '<sys level="' + o.level + '">' + o.tt + '|' + o.ts + '</sys>' + o.body,
    rsTkPipeRows: (m, title) => (m && Object.keys(m).length ? '<pipe>' + title + '</pipe>' : ''),
    rsTkPipeLevel: (m) => { let w = null; for (const k in (m || {})) { if (!/_last_status$/.test(k)) continue; const v = String(m[k] || '').toLowerCase(); if (v === 'error') w = 'neg'; else if (v === 'warn' && w !== 'neg') w = 'warn'; } return w; },
    rsTkStateCard: () => '', rsTkSkel: () => '<skel>', rsTkSnap: (o) => '<snap>' + JSON.stringify(o.kpis) + '</snap>',
    rsTkToday: (items, k, empty) => (items.length ? items.map(i => i.title).join('|') : empty),
    rsTkTool: (k, title) => '<tool>' + title + '</tool>', rsTkMvm: (o) => JSON.stringify(o.rows),
    rsTkBadges: (b) => JSON.stringify(b), rsTkProvRows: () => '', rsTkLimits: () => '', rsDatasetHTML: () => '',
    rsBadgeHTML: () => '', rsSaveBtnHTML: () => '', rsDefFor: () => '', rsFreshness: () => null, rsFieldCoverage: () => null,
    rsMaturity: () => null, rsNorm: (s) => String(s || '').toLowerCase(), rsClassifyError: (e) => ({ state: 'error', msg: String(e && e.message || e) }),
    rsFetchAll: async () => [], researchRegister() {}, researchActivate() {}, researchDeactivate() {}, researchRefresh() {},
    researchGo() {}, researchSetHash() {}, researchParseHash: () => null,
    RS_TK_ICONS: { live: '<svg/>', research: '<svg/>', team: '<svg/>', market: '<svg/>', game: '<svg/>', ratings: '<svg/>', history: '<svg/>', watch: '<svg/>', rankings: '<svg/>' },
    RESEARCH_MODULES: { tennis: { _: { uistate: { state: 'ok' } } }, wta: { _: { uistate: { state: 'ok' } } } },
    RS_PROV: {}, RS_LIMITS: {}, WTA_TIER: {}, edIsOwner: () => !!opts.owner,
    WTA: { meta: {}, day: [], research: [], watch: [], at: 0, slate: null, seg: 'research', hidden: 0 },
    GE: { fmtPrice: (d) => (d >= 2 ? '+' + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1)))) },
    wtaTodayRow: () => null, wtaChip: () => '', wtaSetSeg() {},
    /* The block defines its OWN sbGetTennis and sbGetWta over sbFetch, so the
       stand-in has to sit under sbFetch rather than over them — otherwise the
       page's real readers are replaced and nothing the page does is tested. */
    sbFetch: async (q, headers) => {
      const schema = (headers && headers['accept-profile']) || 'public';
      const rel = q.split('?')[0];
      if (opts.failMatches && rel === 'live_matches') { const e = new Error('db 404'); e.status = 404; throw e; }
      if (opts.failStatus && rel === 'pipeline_status') throw new Error('db 500');
      let rows = (tables[schema + '.' + rel] || []).slice();
      const eqm = /[?&]([a-z_]+)=eq\.([^&]+)/.exec(q);
      if (eqm) rows = rows.filter(r => String(r[eqm[1]]) === decodeURIComponent(eqm[2]));
      const inm = /[?&]([a-z_]+)=in\.\(([^)]+)\)/.exec(q);
      if (inm) { const vals = inm[2].split(',').map(v => decodeURIComponent(v).replace(/^"|"$/g, '').replace(/^%22|%22$/g, '')); rows = rows.filter(r => vals.indexOf(String(r[inm[1]])) >= 0); }
      return rows;
    },
    sbGet: async (q) => { if (opts.failSignals) throw new Error('db 401'); return (tables['public.signals'] || []).slice(); }
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(LIB, ctx, { filename: 'tennis_research.js' });
  vm.runInContext(SRC, ctx, { filename: 'tennis-block.js' });
  ctx.TDD.view = 'LIVE';
  return { ctx, els };
}
async function paint(tables, opts) {
  const { ctx, els } = sandbox(tables, opts);
  await ctx.loadTennisLive(true);
  const body = els.tddLiveBody || { innerHTML: '' };
  return { html: body.innerHTML, fresh: els.tddLiveFresh || { textContent: '', className: '' }, ctx, els, why: ctx.TDD.live.why };
}

(async function main() {
  /* ---- a live match ---------------------------------------------------- */
  let r = await paint(baseTables({
    'tennis.live_matches': [liveMatch(), liveMatch({ match_id: 'espn:m2', match_order: 2, status: 'scheduled', current_set: null,
      sets_home: 0, sets_away: 0, set_scores: [], server_side: null, first_point_at: null, close_bound_source: null,
      home_name: 'Bruno Fixture', away_name: 'Kai Dummy', home_player_id: null, away_player_id: null, scheduled_at: iso(-3600000) })],
    'tennis.match_live_state': [stateRow('home'), stateRow('away')],
    'tennis.match_set_stats': [
      { match_id: 'espn:m1', tournament_id: 'espn:t1', set_number: 1, side: 'home', set_status: 'complete', stat_source: 'snapshot_delta', games_won: 6, service_games_played: 3, service_games_won: 3, aces: 3, double_faults: 0, first_serves_in: 12, first_serves_total: 18 },
      { match_id: 'espn:m1', tournament_id: 'espn:t1', set_number: 1, side: 'away', set_status: 'complete', stat_source: 'snapshot_delta', games_won: 3, service_games_played: 3, service_games_won: 2, aces: 1, double_faults: 2, first_serves_in: 9, first_serves_total: 17 },
      { match_id: 'espn:m1', tournament_id: 'espn:t1', set_number: 2, side: 'home', set_status: 'in_progress', stat_source: 'snapshot_delta', games_won: 1, service_games_played: 2, service_games_won: 2, aces: 2 },
      { match_id: 'espn:m1', tournament_id: 'espn:t1', set_number: 2, side: 'away', set_status: 'in_progress', stat_source: 'snapshot_delta', games_won: 2, service_games_played: 2, service_games_won: 1, aces: 0 }
    ],
    'tennis.player_baselines': [
      { player_id: 'p1', full_name: 'Marco Testerson', tour: 'ATP', built_at: iso(86400000), obs_matches: 5, obs_hold_pct: 0.82,
        obs_first_serve_pct: 0.63, obs_return_points_won_pct: 0.40, obs_bp_saved_pct: 0.6, obs_ace_per_service_game: 1.1,
        obs_df_per_service_game: 0.2, career_matches: 300, career_win_pct: 0.7, rank: 5, rank_points: 5400,
        clay_matches: 80, clay_win_pct: 0.7, form_last10_sample: 10, form_last10_wins: 8, style_labels: ['BIG SERVER'], notes: [] },
      { player_id: 'p2', full_name: 'Ivan Placeholder', tour: 'ATP', built_at: iso(86400000), obs_matches: 0,
        career_matches: 150, career_win_pct: 0.55, rank: 14, rank_points: 2100, clay_matches: 30, clay_win_pct: 0.5,
        form_last10_sample: 10, form_last10_wins: 4, style_labels: [], notes: ['no_observed_serve_baseline'] }
    ],
    'tennis.match_markets': [{ match_id: 'espn:m1', tournament_id: 'espn:t1', signal_event_id: 'ev1', sport_key: 'tennis_atp',
      home_team: 'Marco Testerson', away_team: 'Ivan Placeholder', home_sig_key: 'k1', away_sig_key: 'k2', link_method: 'both_names_exact' }],
    'tennis.market_captures': [
      { match_id: 'espn:m1', sig_key: 'k1', side: 'home', capture_at: iso(2100000), market_state: 'PRE', best_dec: 1.62, sharp_fair: 0.60, book: 'bk' },
      { match_id: 'espn:m1', sig_key: 'k2', side: 'away', capture_at: iso(2100000), market_state: 'PRE', best_dec: 2.45, sharp_fair: 0.40, book: 'bk' },
      { match_id: 'espn:m1', sig_key: 'k1', side: 'home', capture_at: iso(600000), market_state: 'LIVE', best_dec: 1.25, sharp_fair: 0.79, book: 'bk' }
    ],
    'public.signals': [
      { sig_key: 'k1', event_id: 'ev1', sport_key: 'tennis_atp', market: 'h2h', selection: 'Marco Testerson', home_team: 'Marco Testerson', away_team: 'Ivan Placeholder', best_dec: 1.25, best_book: 'bk', first_best_dec: 1.62, first_seen_at: iso(2100000), sharp_fair: 0.79, consensus_fair: 0.78, n_books: 8, has_sharp: true, last_seen_at: iso(30000) },
      { sig_key: 'k2', event_id: 'ev1', sport_key: 'tennis_atp', market: 'h2h', selection: 'Ivan Placeholder', home_team: 'Marco Testerson', away_team: 'Ivan Placeholder', best_dec: 4.10, best_book: 'bk', first_best_dec: 2.45, first_seen_at: iso(2100000), sharp_fair: 0.21, consensus_fair: 0.22, n_books: 8, has_sharp: true, last_seen_at: iso(30000) }
    ]
  }));
  has(r.html, 'LIVE', 'a live match renders as LIVE');
  has(r.html, 'Testville Open', 'the tournament is named');
  has(r.html, 'clay court', 'the surface is shown as published');
  has(r.html, 'Testerson', 'the players are named');
  has(r.html, 'tn-serve', 'the server is marked');
  chk('the set scores are drawn as a scoreline', /tn-score/.test(r.html) && />6</.test(r.html) && />3</.test(r.html), 'no scoreline');
  chk('the first set is credited to the player who won it and the set in progress is not',
    /class="sw">1<\/td>[\s\S]*class="sw">0<\/td>/.test(r.html), r.html.slice(r.html.indexOf('tn-score'), r.html.indexOf('tn-score') + 900));
  has(r.html, 'live read', 'the live read is drawn');
  has(r.html, 'Aces', 'the key counts are drawn');
  has(r.html, 'research flags', 'the research flags are drawn');
  has(r.html, 'tennis-flag-rules-v1', 'and they carry the rule version that produced them');
  has(r.html, 'NO SERVE BASELINE', 'a player EdgeDesk has never watched is flagged as such');
  has(r.html, 'Market fact', 'the market is labelled as a market fact');
  has(r.html, 'Live match data', 'the live counts are labelled as provider data');
  has(r.html, 'EdgeDesk research', 'what EdgeDesk computed is labelled as such');
  has(r.html, 'there is no EdgeDesk tennis model', 'the model gate is on screen');
  lacks(r.html, 'undefined', 'nothing renders as undefined');
  lacks(r.html, 'NaN', 'nothing renders as NaN');
  lacks(r.html, '[object Object]', 'nothing renders as a raw object');
  chk('the freshness stamp reports the live age, not the clock', /live \d/.test(r.fresh.textContent), r.fresh.textContent);

  /* the market section, opened */
  r.ctx.TDD.live.open.market = true; r.ctx.TDD.live.open.sets = true; r.ctx.TDD.live.open.matchup = true; r.ctx.TDD.live.open.unknown = true;
  const opened = r.ctx.tnShellHTML();
  has(opened, 'pre-match capture', 'the capture history is summarised');
  has(opened, 'first point observed', 'the boundary is named on screen');
  has(opened, 'Testerson close', 'a closing reference is reported when one qualifies');
  has(opened, 'can never become a pre-match close', 'and a live price is never promoted to it');
  has(opened, 'derived', 'a set row derived from snapshots says so');
  has(opened, 'Ranking', 'the matchup compares the record');
  has(opened, 'no observed serve baseline', 'a player with no serve history is said to have none');
  has(opened, 'BIG SERVER', 'a style label that earned its sample is shown');
  lacks(opened, 'undefined', 'nothing in the opened sections renders as undefined');

  /* ---- the poller has stopped ----------------------------------------- */
  r = await paint(baseTables({
    'tennis.live_matches': [liveMatch({ source_updated_at: iso(3600000) })],
    'tennis.match_live_state': [stateRow('home', { updated_at: iso(3600000) }), stateRow('away', { updated_at: iso(3600000) })],
    'tennis.pipeline_status': [{ job: 'tennis_live', run_id: 'r1', status: 'running', heartbeat_at: iso(3600000), last_success_at: iso(3600000), consecutive_failures: 0 }]
  }));
  has(r.html, 'STALE', 'a match nothing has written to is STALE, not LIVE');
  has(r.html, 'The poller is not running', 'and the reader is told the poller stopped');
  has(r.html, 'not the current one', 'and that the score shown is the last one stored');

  /* ---- nothing on court ------------------------------------------------ */
  r = await paint(baseTables({ 'tennis.live_matches': [] }));
  has(r.html, 'NO MATCH', 'an empty draw says so plainly');
  has(r.html, 'draw sync last succeeded', 'and says when the sync last worked');
  lacks(r.html, '0s ago', 'the empty state does not print the clock as freshness');

  /* ---- the table is unreachable ---------------------------------------- */
  r = await paint(baseTables({}), { failMatches: true });
  has(r.html, 'OFFLINE', 'an unreachable table is OFFLINE, not empty');
  has(r.html, 'tennis_live_center.sql', 'and names the migration an operator would run');
  has(r.html, 'Nothing is shown in its place', 'and refuses to invent a card');

  /* ---- a doubles match ------------------------------------------------- */
  r = await paint(baseTables({
    'tennis.live_matches': [liveMatch({ match_id: 'espn:m3', is_doubles: true, best_of: 3,
      home_name: 'Rohan Testpair/Matt Fixtureman', away_name: 'Marcel Sampleton/Horacio Placeholder',
      home_player_id: null, away_player_id: null })],
    'tennis.match_live_state': [stateRow('home', { match_id: 'espn:m3', player_id: null }), stateRow('away', { match_id: 'espn:m3', player_id: null })]
  }));
  has(r.html, 'Testpair/Fixtureman', 'a pair is named as a pair');
  r.ctx.TDD.live.open.matchup = true;
  const dbl = r.ctx.tnShellHTML();
  has(dbl, 'A pair is a team', 'a doubles match is given no player baseline');
  lacks(dbl, 'BIG SERVER', 'and no serve label is borrowed from one half of it');

  /* ---- a finished match, and a retirement ------------------------------ */
  r = await paint(baseTables({
    'tennis.live_matches': [liveMatch({ status: 'final', winner_side: 'home', result_type: 'completed', current_set: 3,
      set_scores: [{ home: 6, away: 3 }, { home: 4, away: 6 }, { home: 6, away: 2 }], sets_home: 2, sets_away: 1,
      server_side: null, completed_at: iso(600000) })],
    'tennis.pipeline_status': [{ job: 'tennis_sync', run_id: 's1', status: 'ok', last_success_at: iso(600000) }]
  }));
  has(r.html, 'FINAL', 'a finished match reads FINAL');
  has(r.html, 'Testerson won', 'and names the winner');
  r = await paint(baseTables({
    'tennis.live_matches': [liveMatch({ status: 'final', winner_side: 'home', result_type: 'retirement', current_set: 2,
      set_scores: [{ home: 6, away: 2 }, { home: 2, away: 1 }], server_side: null })],
    'tennis.pipeline_status': [{ job: 'tennis_sync', run_id: 's1', status: 'ok', last_success_at: iso(600000) }]
  }));
  has(r.html, 'ret.', 'a retirement is named as one');
  chk('a retirement does not credit its unfinished set', /class="sw">1<\/td>[\s\S]*class="sw">0<\/td>/.test(r.html), 'set columns');

  /* ---- a tiebreak prints the loser's points ---------------------------- */
  r = await paint(baseTables({
    'tennis.live_matches': [liveMatch({ status: 'final', winner_side: 'home', result_type: 'completed', current_set: 2,
      set_scores: [{ home: 7, away: 6, home_tb: 7, away_tb: 4 }, { home: 6, away: 4 }], sets_home: 2, sets_away: 0, server_side: null })]
  }));
  has(r.html, '<sup>4</sup>', 'a tiebreak prints the loser’s points beside the set');

  /* ---- a match with a score but no statistics -------------------------- */
  r = await paint(baseTables({ 'tennis.live_matches': [liveMatch()], 'tennis.match_live_state': [] }));
  has(r.html, 'no statistics', 'a match with no published statistics says so');
  has(r.html, 'nothing is estimated', 'and estimates nothing in their place');
  lacks(r.html, 'holding 0%', 'and never renders an absent rate as zero');

  /* ---- an unlinked match ------------------------------------------------ */
  r = await paint(baseTables({ 'tennis.live_matches': [liveMatch()], 'tennis.match_live_state': [stateRow('home'), stateRow('away')],
    'tennis.market_rejections': [{ signal_event_id: 'ev9', sig_key: '', home_team: 'Marco Testerson', away_team: 'Someone Else', reason: 'one_side_unresolved', detail: 'away side did not resolve', last_seen_at: iso(60000), seen_count: 3 }] }), { owner: true });
  r.ctx.TDD.live.open.market = true;
  const unlinked = r.ctx.tnShellHTML();
  has(unlinked, 'No odds fixture is linked', 'an unlinked match says so');
  has(unlinked, 'BOTH of its participants', 'and states the rule that refused it');
  has(unlinked, 'one_side_unresolved', 'and shows the refusal an owner can act on');

  /* ---- the overview strip ---------------------------------------------- */
  const s2 = sandbox(baseTables({ 'tennis.live_matches': [liveMatch()] }));
  s2.ctx.TDD.view = 'ATP';
  await s2.ctx.tnFcMatches();
  await s2.ctx.tnFcStatus();
  s2.ctx.TDD.live.mode = 'live';
  const strip = s2.ctx.tddLiveStripHTML();
  has(strip, 'On court', 'the overview carries an on-court line');
  has(strip, 'Testerson v Placeholder', 'naming the match');
  const s3 = sandbox(baseTables({ 'tennis.live_matches': [] }));
  await s3.ctx.tnFcMatches();
  await s3.ctx.tnFcStatus();
  const quiet = s3.ctx.tddLiveStripHTML();
  has(quiet, 'No tennis match is on court', 'and says so plainly when nothing is');
  lacks(quiet, '0s ago', 'without printing the clock as freshness');

  /* ---- the health card is honest about a missing build time ------------ */
  const s4 = sandbox(baseTables({}));
  s4.ctx.WTA.at = NOW - 1000; s4.ctx.TDD.ATP.at = NOW - 1000;
  const sys = s4.ctx.tddSystemHTML();
  lacks(sys, 'All tennis research systems operational', 'a panel with no published build time does not read fully operational');
  has(sys, 'build time not published', 'it says which stamp is missing');
  const s5 = sandbox(baseTables({}));
  s5.ctx.TDD.live.matchesOk = false;
  const sysFault = s5.ctx.tddSystemHTML();
  has(sysFault, 'live_matches did not answer', 'a failed match-centre read is counted as a fault');
  chk('and the card is red for it', /level="neg"/.test(sysFault), sysFault.slice(0, 200));
  eq2('the faults list and the snapshot count agree', s5.ctx.tddFaults().length, 1);

  /* ---- the player list is sorted before it is capped -------------------- */
  const s6 = sandbox(baseTables({}));
  const many = {};
  for (let i = 0; i < 260; i++) { const id = 'p' + i; many[id] = { player_id: id, full_name: 'Zed Player ' + String(i).padStart(3, '0') }; }
  many.aaa = { player_id: 'aaa', full_name: 'Aaron Alpha' };
  s6.ctx.TDD.ATP.byId = many; s6.ctx.TDD.ATP.rank = [{ player_id: 'aaa', rank: 1 }]; s6.ctx.TDD.ATP.at = NOW;
  s6.ctx.TDD.ATP.seg = 'players'; s6.ctx.TDD.view = 'ATP';
  s6.ctx.renderTennis();
  const list = s6.els.tddBody.innerHTML;
  has(list, 'Aaron Alpha', 'the alphabetically first player survives the cap');
  has(list, 'of 261', 'and the page says how many it is showing of how many');

  if (fail) {
    console.log('FAIL | tennis match center UI | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach((f) => console.log('     | ' + f));
    process.exit(1);
  }
  console.log('PASS | tennis match center UI | ' + pass + ' assertions');
})().catch((e) => { console.error('harness error: ' + (e && e.stack || e)); process.exit(1); });

function eq2(name, got, want) { chk(name, got === want, 'got ' + got + ' want ' + want); }
