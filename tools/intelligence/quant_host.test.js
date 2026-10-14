#!/usr/bin/env node
/* ===========================================================================
   THE QUANT DESK, THROUGH THE REAL HANDLER — the acceptance questions.

   Node strips the TypeScript; the network is the intelligence fixture router
   (the REAL committed FBS slate, NFL slate, metrics and pricing validation)
   plus an MLB game (Tampa Bay Rays @ Cleveland Guardians) with captured
   moneyline and run-line prices, per-book quotes and a probable-starter card.
   No writing model is called: every answer here is deterministic.

     1. "What's the best bet available in the next 24 hours across all supported sports?"
     2. "Analyze Rays vs. Guardians and tell me whether Rays at 61¢ is positive EV."
     3. "Is Cleveland +1.5 at 61 cents a good price on Kalshi?"
     4. "Find me a better price than this Kalshi contract."      (follow-up)
     5. "Explain why this contract has negative EV."             (follow-up)
     6. "What's the best available underdog?"
     7. "Which sports couldn't be scanned?"
     8. "If the odds API fails, can you still analyze this game?"
   plus: a football-scoped question still reaches the football desk, a
   staking question still reaches the staking engine, an audit row is written
   once per audited candidate, and the scan answers PASS when nothing clears.

   Run: node tools/intelligence/quant_host.test.js   (QUANT_PRINT=1 prints every answer)
   =========================================================================== */
'use strict';
/* THE CLOCK. The MLB fixture game starts three hours out, on the same New York day, so the questions answered
   for "today" (the underdog, the audit ids) see it and its four-minute-old quotes stay CURRENT. After 20:30 ET
   both cannot hold: the game either crosses midnight or starts so soon that its quotes read AGING, and the
   suite failed every night from about 23:25 ET. A run that starts after 20:30 ET therefore plays on a clock
   moved back to 20:30 ET the same day. Only this process's Date moves; the handler is not touched. */
const etMinute = (ms) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)); return (+p.find((x) => x.type === 'hour').value % 24) * 60 + (+p.find((x) => x.type === 'minute').value); };
const CLOCK_BACK = Math.max(0, etMinute(Date.now()) - (20 * 60 + 30)) * 60000;
if (CLOCK_BACK) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() - CLOCK_BACK); }
    static now() { return RealDate.now() - CLOCK_BACK; }
  };
}
const path = require('path');
const FX = require('./fixtures.js');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 900) : '')); }
const PRINT = process.env.QUANT_PRINT === '1';
/* QUANT_DUMP=<file> writes the handler's real responses for the browser suite (quant_ui.e2e.js) to render */
const DUMP = process.env.QUANT_DUMP ? {} : null;

/* the authorised quote refresh is switched ON here, with its secret: the quant desk must still never spend odds credits */
const ENV = { EDGEDESK_RESEARCH_LOG: '0', EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_QUOTE_REFRESH: '1', CRON_SECRET: 'cron-test', EDGEDESK_RESEARCH: process.env.EDGEDESK_RESEARCH };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

let route = () => [];
let postFail = null;
let modelCalls = 0;
let posted = [];
let reads = [];
const oddsCalls = [];
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) { modelCalls++; return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' }; }
  /* FIRST: a capture or odds call is a POST to the same host, so it is caught before the generic write branch */
  if (u.indexOf('the-odds-api.com') >= 0 || u.indexOf('/functions/v1/capture') >= 0) { oddsCalls.push(u); throw new Error('an odds request was made: ' + u); }
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) {
    posted.push({ table: u.replace('https://sb.test/rest/v1/', '').split('?')[0], query: u.split('?')[1] || '', body: JSON.parse(init.body) });
    if (postFail) return { ok: false, status: 400, text: async () => postFail, json: async () => null };
    return { ok: true, status: 201, text: async () => '', json: async () => [] };
  }
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  reads.push(u);
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  if (d && d.__status) return { ok: false, status: d.__status, text: async () => d.__error || '', json: async () => null };
  return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
};

const NOW = Date.now();
const ISO = (min) => new Date(NOW + min * 60000).toISOString();
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const fx = FX.build(NOW);
  /* the committed metrics carry absolute timestamps; anchor them to the test clock (as research_host does) so a run
     on any date sees the same freshness — injuries read 2 h ago, the depth chart published 20 h ago */
  fx.metrics = JSON.parse(JSON.stringify(fx.metrics));
  fx.metrics.generated_at = ISO(-120);
  Object.keys((fx.metrics.nfl || {}).teams || {}).forEach((k) => { const t = fx.metrics.nfl.teams[k]; if (t.injuries) t.injuries.retrieved_at = ISO(-120); if (t.starter) { t.starter.published_at = ISO(-20 * 60); t.starter.retrieved_at = ISO(-120); } });
  /* the MLB game starts three hours out, before midnight in New York (THE CLOCK, above, keeps a late run at
     20:30 ET), so the questions answered for "today" (the underdog, "right now") see it whatever hour the suite runs */
  const START_MIN = 180;
  const START = ISO(START_MIN);
  /* ---- the MLB fixture: Rays (away) @ Guardians (home) ------------------ */
  const MLB_GAME = { game_id: '776655', game_date: etDate(NOW + START_MIN * 60000), home_team: 'Cleveland Guardians', away_team: 'Tampa Bay Rays', start_time: START, status: 'Scheduled', park_id: 5 };
  const CARD = { game_date: MLB_GAME.game_date, start_time: START, status: 'Scheduled', away_team_name: 'Tampa Bay Rays', away_pitcher_name: 'Shane Baz', away_pitcher_throws: 'R', home_team_name: 'Cleveland Guardians', home_pitcher_name: 'Tanner Bibee', home_pitcher_throws: 'R', run_factor: 0.97, temp_f: 58, wind_mph: 8, wind_rel: 'in from LF' };
  const base = (o) => fx.signal(Object.assign({ event_id: 'ev-tb-cle', sport_key: 'baseball_mlb', sport_title: 'MLB', home_team: 'Cleveland Guardians', away_team: 'Tampa Bay Rays', commence_time: START,
    first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, o));
  /* Rays +120 at FanDuel against a Pinnacle 2.08 / 1.81 market: sharp fair 46.55%, EV +2.4% */
  const RAYS_ML = base({ sig_key: 'ev-tb-cle|h2h|Tampa Bay Rays|', market: 'h2h', selection: 'Tampa Bay Rays', point: null, best_dec: 2.2, first_best_dec: 2.15, best_book: 'FanDuel', sharp_fair: 0.4655, sharp_book_fair: 0.4655, consensus_fair: 0.464, pin_dec: 2.08, pin_opp_dec: 1.81, edge: 0.024, first_edge: 0.01, n_books: 7, n_books_eff: 5, corrob_n: 4 });
  const CLE_ML = base({ sig_key: 'ev-tb-cle|h2h|Cleveland Guardians|', market: 'h2h', selection: 'Cleveland Guardians', point: null, best_dec: 1.83, first_best_dec: 1.83, best_book: 'DraftKings', sharp_fair: 0.5345, sharp_book_fair: 0.5345, consensus_fair: 0.536, pin_dec: 1.81, pin_opp_dec: 2.08, edge: -0.02, first_edge: -0.02, n_books: 7, n_books_eff: 5, corrob_n: 4 });
  const CLE_RL = base({ sig_key: 'ev-tb-cle|spreads|Cleveland Guardians|1.5', market: 'spreads', selection: 'Cleveland Guardians', point: 1.5, best_dec: 1.6, best_book: 'BetMGM', sharp_fair: 0.62, sharp_book_fair: 0.62, consensus_fair: 0.618, pin_dec: 1.58, pin_opp_dec: 2.5, edge: -0.008, first_edge: -0.008, n_books: 6, corrob_n: 3 });
  const TB_RL = base({ sig_key: 'ev-tb-cle|spreads|Tampa Bay Rays|-1.5', market: 'spreads', selection: 'Tampa Bay Rays', point: -1.5, best_dec: 2.55, best_book: 'Caesars', sharp_fair: 0.38, sharp_book_fair: 0.38, consensus_fair: 0.382, pin_dec: 2.5, pin_opp_dec: 1.58, edge: -0.03, first_edge: -0.03, n_books: 6, corrob_n: 3 });
  const BOOK_QUOTES = {
    'ev-tb-cle|h2h|Tampa Bay Rays|': [['FanDuel', 2.2], ['DraftKings', 2.18], ['BetMGM', 2.15], ['Caesars', 2.12], ['Pinnacle', 2.08]],
    'ev-tb-cle|spreads|Cleveland Guardians|1.5': [['BetMGM', 1.6], ['FanDuel', 1.58], ['Pinnacle', 1.58]],
    'ev-tb-cle|h2h|Cleveland Guardians|': [['DraftKings', 1.83], ['FanDuel', 1.8], ['Pinnacle', 1.81]]
  };
  const MLB_SIGNALS = [RAYS_ML, CLE_ML, CLE_RL, TB_RL];
  /* ---- NFL: Lions @ Bills (starters agree across the slate and the depth chart) and
     Colts @ Texans (the slate's Colts starter is Anthony Richardson, the depth chart's Daniel Jones) */
  const nflGame = (id) => fx.nfl.games.find((g) => g.game_id === id);
  const nfl = (o) => fx.signal(Object.assign({ sport_key: 'americanfootball_nfl', sport_title: 'NFL', market: 'spreads', first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, o));
  const BUF = nflGame('nfl-fx-det-buf'), HOU = nflGame('nfl-fx-ind-hou');
  const NFL_SIGNALS = [
    nfl({ sig_key: 'ev-det-buf|spreads|Buffalo Bills|-2.5', event_id: 'ev-det-buf', selection: 'Buffalo Bills', point: -2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.95, best_book: 'FanDuel', sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528, pin_dec: 1.88, pin_opp_dec: 2.02, corrob_n: 4 }),
    nfl({ sig_key: 'ev-det-buf|spreads|Detroit Lions|2.5', event_id: 'ev-det-buf', selection: 'Detroit Lions', point: 2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.87, best_book: 'BetMGM', sharp_fair: 0.468, sharp_book_fair: 0.468, consensus_fair: 0.472, pin_dec: 2.02, pin_opp_dec: 1.88, edge: -0.03, first_edge: -0.03, corrob_n: 4 }),
    nfl({ sig_key: 'ev-ind-hou|spreads|Houston Texans|-3.5', event_id: 'ev-ind-hou', selection: 'Houston Texans', point: -3.5, home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: HOU.kickoff, best_dec: 1.96, best_book: 'FanDuel', sharp_fair: 0.533, sharp_book_fair: 0.533, consensus_fair: 0.53, pin_dec: 1.87, pin_opp_dec: 2.03, corrob_n: 4 }),
    nfl({ sig_key: 'ev-ind-hou|spreads|Indianapolis Colts|3.5', event_id: 'ev-ind-hou', selection: 'Indianapolis Colts', point: 3.5, home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: HOU.kickoff, best_dec: 1.86, best_book: 'BetMGM', sharp_fair: 0.467, sharp_book_fair: 0.467, consensus_fair: 0.47, pin_dec: 2.03, pin_opp_dec: 1.87, edge: -0.03, first_edge: -0.03, corrob_n: 4 })
  ];
  BOOK_QUOTES['ev-det-buf|spreads|Buffalo Bills|-2.5'] = [['FanDuel', 1.95], ['DraftKings', 1.93], ['Caesars', 1.92], ['Pinnacle', 1.88]];
  BOOK_QUOTES['ev-ind-hou|spreads|Houston Texans|-3.5'] = [['FanDuel', 1.96], ['DraftKings', 1.94], ['Pinnacle', 1.87]];

  function routerFor(signals, opts, o) {
    const inner = FX.router(fx, Object.assign({ signals }, opts || {}));
    return function (u, init) {
      /* the audit's fresh re-read of one signal, optionally different from what the board read */
      if (o && o.fresh && /signals\?select=sig_key,event_id,market,selection,point,best_dec,best_book,sharp_fair/.test(u)) {
        const k = decodeURIComponent((/sig_key=eq\.([^&]+)/.exec(u) || [])[1] || '');
        const row = signals.find((x) => x.sig_key === k);
        if (row) return [Object.assign({}, row, o.fresh[k] || {})];
      }
      if (u.indexOf('games?') >= 0 && u.indexOf('game_date=in.') >= 0 && u.indexOf('sport_key=') < 0) return [MLB_GAME];
      if (u.indexOf('mlb_game_cards?') >= 0) return [CARD];
      if (u.indexOf('market_execution_costs?') >= 0) return (o && o.fees) || [];
      if (u.indexOf('book_quotes?') >= 0) {
        const k = decodeURIComponent((/sig_key=eq\.([^&]+)/.exec(u) || [])[1] || '');
        return (BOOK_QUOTES[k] || []).map(([b, d]) => ({ sig_key: k, book_title: b, book_key: b.toLowerCase(), dec: d, updated_at: ISO(-3), is_fresh: true }));
      }
      return inner(u, init);
    };
  }
  async function ask(question, o) {
    o = o || {};
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    route = routerFor(o.signals || MLB_SIGNALS, o.rows, o);
    modelCalls = 0; posted = []; reads = [];
    const body = { mode: 'chat', question, packet: o.packet || null, history: [], research_context: o.carried || null, timezone: 'America/New_York' };
    if (o.desk !== false) body.desk = true;
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const j = await r.json();
    if (PRINT) console.log('\n──── Q: ' + question + '\n' + (j.answer || JSON.stringify(j).slice(0, 400)));
    if (DUMP && o.dump) DUMP[o.dump] = { question, response: j };
    return { status: r.status, j };
  }

  /* ═══ 1. THE CROSS-SPORT SCAN ═══════════════════════════════════════════ */
  const s1 = await ask("What's the best bet available in the next 24 hours across all supported sports?", { dump: 'scan_24h' });
  ok('the scan answers (200), deterministically, with no model call', s1.status === 200 && s1.j.quant && s1.j.quant.intent === 'SCAN' && modelCalls === 0, { status: s1.status, intent: s1.j.quant, err: s1.j.error });
  const sc = s1.j.scan || {};
  ok('it read more than football: MLB was evaluated', (sc.coverage || []).some((c) => c.sport === 'baseball_mlb' && c.status === 'EVALUATED'), sc.coverage);
  ok('NBA and NHL are NOT_CAPTURED, not an empty slate', ['basketball_nba', 'icehockey_nhl'].every((k) => (sc.coverage || []).some((c) => c.sport === k && c.status === 'NOT_CAPTURED')), (sc.coverage || []).map((c) => c.sport + ':' + c.status));
  ok('so the answer says "among the markets EdgeDesk could scan", never "across all sports"', sc.coverage_scope === 'SCANNED_ONLY' && /among the markets EdgeDesk could scan/.test(s1.j.answer) && !/across every in-season sport/.test(s1.j.answer), s1.j.answer);
  ok('the top candidates were audited on a fresh read', sc.counts && sc.counts.audited >= 1 && (sc.audit_trail || []).some((t) => t.step === 'VERDICT'), sc.counts);
  ok('the audit re-read the signal and the per-book quotes (uncached reads)', reads.some((u) => /signals\?select=sig_key,event_id,market.*sig_key=eq\./.test(u)) && reads.some((u) => /book_quotes\?/.test(u)));
  ok('the MLB card is the only one priced inside 24 hours, and MLB has no pitcher-scratch feed: nothing is called VERIFIED', !sc.best && sc.decision === 'WATCH', sc.decision);
  const pot = (sc.potential || [])[0];
  ok('the strongest candidate is the Rays moneyline at FanDuel +120, a POTENTIAL edge', pot && pot.candidate.selection === 'Tampa Bay Rays' && pot.candidate.market === 'h2h' && pot.candidate.quote.odds_american === 120 && pot.evaluation.classification === 'POTENTIAL_EDGE', pot && [pot.candidate.selection, pot.evaluation.classification]);
  ok('…and the research chain classes it RESEARCH REQUIRED (availability unchecked), final status WATCHLIST', pot && pot.classification && pot.classification.classification === 'RESEARCH_REQUIRED' && pot.classification.final_status === 'WATCHLIST' && sc.final_status === 'WATCHLIST' && sc.researched === true, pot && pot.classification);
  ok('…the audit downgraded it for exactly that reason', pot && pot.audit.status === 'DOWNGRADED' && /pitcher-scratch feed/.test(pot.audit.reason), pot && pot.audit.reason);
  ok('the answer says no verified trade clears, then gives every Phase-2 field for the strongest candidate', /^No verified positive-EV trade currently clears the research and execution thresholds/.test(s1.j.answer) && /STRONGEST CANDIDATE — RESEARCH REQUIRED, NOT VERIFIED/.test(s1.j.answer) && ['Event:', 'Sport:', 'Market:', 'Venue:', 'Verified market price:', 'Independent fair probability:', 'Break-even probability:', 'Estimated net EV:', 'Maximum acceptable price:', 'Model reliability:', 'Research freshness:', 'Why the model disagrees with the market:', 'Primary matchup advantage:', 'Strongest counterargument:', 'What would invalidate the opportunity:', 'Final status: WATCHLIST'].every((k) => s1.j.answer.indexOf(k) >= 0), s1.j.answer);
  ok('the independent fair is honestly UNAVAILABLE for MLB (research-tier model, browser only), with the market fair beside it', /Independent fair probability: unavailable — the MLB model runs in the browser only/.test(s1.j.answer) && /Market no-vig: 46\.[56]%/.test(s1.j.answer), s1.j.answer.split('\n').find((l) => /Independent/.test(l)));
  ok('with no independent model, no model-versus-market disagreement is claimed', /Why the model disagrees with the market: EdgeDesk has no independent model for this market/.test(s1.j.answer), s1.j.answer.split('\n').find((l) => /^Why the model/.test(l)));
  ok('net EV is EDFAIR\'s exact number (+2.41% per $1)', /Estimated net EV: 2\.41% per \$1/.test(s1.j.answer), s1.j.answer.split('\n').find((l) => /net EV/.test(l)));
  ok('the maximum entry is a whole American price that clears the floor (+116)', /Maximum acceptable price: \+116/.test(s1.j.answer), s1.j.answer.split('\n').find((l) => /Maximum/.test(l)));
  ok('no matchup advantage is invented for a price discrepancy', /Primary matchup advantage: none claimed/.test(s1.j.answer));
  ok('what would invalidate it names the starting pitcher', /What would invalidate the opportunity: .*SP availability/.test(s1.j.answer), s1.j.answer.split('\n').find((l) => /invalidate/.test(l)));
  ok('the research line and a numbered source list close the answer (MLB probables, statsapi URL)', /Research: L3 \(deep adversarial investigation\)/.test(s1.j.answer) && /\[1\] MLB probable pitchers \(via EdgeDesk's MLB card\) — https:\/\/statsapi\.mlb\.com\//.test(s1.j.answer) && /cost estimate \$0\.000/.test(s1.j.answer), s1.j.answer.split('\n').slice(-4));
  ok('the window is the next 24 hours, not "today until midnight"', sc.window && sc.window.kind === 'next_hours' && /next 24 hours/.test(s1.j.answer), sc.window);
  ok('coverage is printed with counts', /Coverage — Scanned: .*MLB/.test(s1.j.answer) && /NOT scanned: .*NBA \(prices not captured\)/.test(s1.j.answer) && /not covered by EdgeDesk: Soccer/.test(s1.j.answer), s1.j.answer.split('\n').slice(-1)[0]);
  ok('the carried state keeps the coverage for a follow-up', s1.j.quant_state && s1.j.quant_state.schema === 'edgedesk_quant_state_v1' && s1.j.quant_state.coverage.length > 3);
  const auditRows = posted.filter((p) => p.table === 'opportunity_audits');
  ok('one audit row per audited candidate is written, idempotently keyed', auditRows.length === 1 && auditRows[0].body.length === sc.counts.audited && auditRows[0].body.every((r) => /^aud_/.test(r.audit_id) && r.status && Array.isArray(r.checks)), auditRows.map((p) => p.body.length));
  ok('the board records are written too (research_packets)', posted.some((p) => p.table === 'research_packets'));
  ok('no odds request was made by the scan (cached data only)', !reads.some((u) => /the-odds-api|functions\/v1\/capture/.test(u)));

  /* the same scan with every price stale and no fresh read: nothing is called verified */
  const staleSignals = MLB_SIGNALS.map((s) => Object.assign({}, s, { last_seen_at: ISO(-400) }));
  const s1b = await ask("What's the best bet right now?", { signals: staleSignals });
  ok('with refresh switched on and every price stale, the scan still asked capture for nothing (a LITE route spends no odds credits)', oddsCalls.length === 0, oddsCalls);
  ok('with only stale prices: "No verified positive-EV trade…"', /^No verified positive-EV trade currently clears the research and execution thresholds/.test(s1b.j.answer) && s1b.j.scan.decision !== 'BUY', s1b.j.answer);

  /* the week's card: the NFL is priced and has an official injury report, so a price CAN be verified */
  const w1 = await ask("What's the best bet this week across all sports?", { signals: MLB_SIGNALS.concat(NFL_SIGNALS), dump: 'scan_week' });
  const wb = w1.j.scan && w1.j.scan.best;
  ok('this week: the best VERIFIED opportunity is Bills -2.5 at FanDuel (1.95)', wb && wb.candidate.selection === 'Buffalo Bills' && wb.candidate.market === 'spreads' && wb.audit.status === 'CONFIRMED' && wb.evaluation.classification === 'VERIFIED_EDGE' && w1.j.scan.decision === 'BUY', wb ? [wb.candidate.selection, wb.audit.status, wb.audit.reason, wb.evaluation.classification, (wb.evaluation.caps || []).filter((c) => c.binding)] : w1.j.scan && w1.j.scan.potential.map((p) => [p.candidate.selection, p.audit.status, p.audit.reason]));
  ok('…every check that can run, ran: the injury report and the starter were checked', wb && wb.audit.checks.find((c) => c.id === 'A8_AVAILABILITY').result === 'PASS' && wb.audit.checks.find((c) => c.id === 'A9_STARTER').result === 'PASS', wb && wb.audit.checks.filter((c) => c.result !== 'PASS').map((c) => c.id + ':' + c.result + ':' + c.detail));
  ok('…and the answer is BEST VERIFIED RESEARCH CANDIDATE with Final status: VERIFIED CANDIDATE', /^BEST VERIFIED RESEARCH CANDIDATE/.test(w1.j.answer) && /Final status: VERIFIED CANDIDATE/.test(w1.j.answer) && /Market: Buffalo Bills -2\.5/.test(w1.j.answer) && wb.classification && wb.classification.classification === 'VERIFIED_CANDIDATE', w1.j.answer);
  ok('…priced exactly as before the research chain: the audited sharp fair (53.2%), +3.74% per $1, max -112', /Estimated net EV: 3\.74% per \$1/.test(w1.j.answer) && /Maximum acceptable price: -112/.test(w1.j.answer) && /The price is judged against the sharp no-vig fair: 53\.2%/.test(w1.j.answer), w1.j.answer.split('\n').filter((l) => /EV|Maximum|Independent/.test(l)));
  ok('…the LEAN model is a cross-check, never swapped in for the board\'s fair', wb.research && wb.research.fair_kind === 'SHARP_NO_VIG' && wb.research.model_view && wb.research.model_view.tier === 'LEAN' && wb.research.model_view.used_to_price === false && wb.research.independent_fair_probability === null, wb.research && [wb.research.fair_kind, wb.research.model_view]);
  ok('…the strategist\'s seven questions all ran, and the edge survives a one-point error', wb.research && wb.research.strategist.checks.length === 7 && wb.research.strategist.verdict === 'SUPPORTED' && wb.research.sensitivity.robust === true, wb.research && wb.research.strategist.checks.map((c) => c.id + ':' + c.result));
  ok('…the NFL injury report and depth charts are cited with URLs and timestamps', /\[1\] NFL injury report \(nflverse\) — https:\/\/github\.com\/nflverse\//.test(w1.j.answer) && /retrieved \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(w1.j.answer) && (wb.research.findings || []).every((f) => f.source_url && f.retrieved_at), w1.j.answer.split('\n').slice(-4));
  const hou = []
    .concat(w1.j.scan.near_misses || [], w1.j.scan.potential || [])
    .find((p) => p.candidate.selection === 'Houston Texans');
  ok('the Texans price is stopped: the slate priced the Colts with Anthony Richardson, the depth chart now lists Daniel Jones', hou && hou.audit.status === 'NEEDS_RECHECK' && /incorrect starter: Indianapolis Colts: priced with Anthony Richardson, now Daniel Jones/.test(hou.audit.reason), hou && [hou.audit.status, hou.audit.reason]);
  ok('the MLB candidate stays a potential edge on the same card', (w1.j.scan.potential || []).some((p) => p.candidate.selection === 'Tampa Bay Rays'), (w1.j.scan.potential || []).map((p) => p.candidate.selection));

  /* ═══ 2. THE CONTRACT PRICE ═════════════════════════════════════════════ */
  const c1 = await ask('Analyze Rays vs. Guardians and tell me whether Rays at 61¢ is positive EV.', { dump: 'contract_rays' });
  ok('routed to the contract check (not the football desk, not a line of 61)', c1.j.quant && c1.j.quant.intent === 'CONTRACT' && !c1.j.desk, c1.j.quant);
  const ce = c1.j.contract && c1.j.contract.evaluation;
  ok('the selection is the Rays moneyline in the Rays @ Guardians game', c1.j.contract && /Tampa Bay Rays/.test(c1.j.contract.selection) && c1.j.contract.game && /Rays @ Cleveland Guardians/.test(c1.j.contract.game.matchup), c1.j.contract && [c1.j.contract.selection, c1.j.contract.game]);
  ok('the fair is the captured sharp no-vig (46.55%), market-derived, not an invented model number', ce && ce.fair_probability === '0.4655' && ce.fair_source.kind === 'SHARP_NO_VIG' && ce.independent_fair_probability === null, ce && [ce.fair_probability, ce.fair_source]);
  ok('61¢ against a 46.55% fair is −14.45¢ before fees: PASS', ce && ce.gross_expected_value === '-0.1445' && ce.decision === 'PASS', ce && [ce.gross_expected_value, ce.decision]);
  ok('no venue was named: no fee schedule is assumed, and the Kalshi case is shown as a scenario', ce && ce.venue.key === 'unspecified' && c1.j.contract.scenario && c1.j.contract.scenario.venue.key === 'kalshi' && /If this is Kalshi/.test(c1.j.answer), ce && ce.venue);
  ok('the answer names the cheaper sportsbook price for the same outcome (FanDuel +120 ≈ 45¢)', /FanDuel \+120 → 45\.45¢/.test(c1.j.answer), c1.j.answer);
  ok('the MLB context is attached as context, not a probability (probable starters)', /Context \(not a probability\): .*Shane Baz .*Tanner Bibee/.test(c1.j.answer), c1.j.answer);
  ok('the independent model is reported unavailable, with the reason', /Independent model: unavailable — the MLB model runs in the browser only/.test(c1.j.answer));
  ok('it read only EdgeDesk\'s own captured data: no odds request', !reads.some((u) => /the-odds-api|functions\/v1\/capture/.test(u)));

  /* a contract that IS positive before and after fees, with Kalshi named */
  const c2 = await ask('Is Guardians at 49¢ on Kalshi a good price?');
  const c2e = c2.j.contract && c2.j.contract.evaluation;
  ok('Guardians YES 49¢ on Kalshi vs a 53.45% fair: fee 2¢, net +2.45¢ a contract', c2e && c2e.venue.key === 'kalshi' && c2e.expected_fees.per_contract === '0.02' && c2e.net_expected_value === '0.0245', c2e && [c2e.venue, c2e.expected_fees, c2e.net_expected_value]);
  ok('…a POTENTIAL EDGE (WATCH), never VERIFIED: the fee schedule is unverified, the contract rules are not on file and no audit can read Kalshi', c2e && c2e.classification === 'POTENTIAL_EDGE' && c2e.decision === 'WATCH' && c2e.caps.some((x) => /fee schedule/.test(x.reason)) && c2e.caps.some((x) => /settlement/.test(x.reason)) && c2e.caps.some((x) => /audit/.test(x.reason)), c2e && c2e.caps);
  ok('…with the maximum entry after fees (51¢)', c2e && c2e.maximum_entry_price === '0.51', c2e && c2e.maximum_entry_price);

  const est = posted.filter((p) => p.table === 'fair_price_estimates');
  ok('the check is written once to fair_price_estimates with every field the engine computed', est.length === 1 && est[0].body[0].kind === 'CONTRACT' && est[0].body[0].venue === 'kalshi' && est[0].body[0].price_cents === 49 && est[0].body[0].net_expected_value === 0.0245 && est[0].body[0].fee_status === 'UNVERIFIED' && est[0].body[0].classification === 'POTENTIAL_EDGE' && /^fpe_/.test(est[0].body[0].estimate_id) && est[0].body[0].calc_version, est.map((p) => p.body[0]));
  /* an operator-verified Kalshi schedule (supabase/quant_desk.sql market_execution_costs) */
  const FEES = [{ venue: 'kalshi', category: 'sports', fee_kind: 'KALSHI_QUADRATIC', taker_coefficient: 0.07, maker_coefficient: 0.0175, source_url: 'https://kalshi.com/docs/kalshi-fee-schedule.pdf', verified_at: ISO(-60 * 24), verified_by: 'operator', effective_from: '2026-01-01T00:00:00Z', effective_to: null }];
  const c2v = await ask('Is Guardians at 49¢ on Kalshi a good price?', { fees: FEES });
  const c2ve = c2v.j.contract && c2v.j.contract.evaluation;
  ok('with a verified schedule on file the Kalshi fee is VERIFIED, and the fee cap is gone', c2ve && c2ve.expected_fees.status === 'VERIFIED' && /verified by operator/.test(c2ve.expected_fees.basis) && !c2ve.caps.some((x) => /fee schedule/.test(x.reason)), c2ve && [c2ve.expected_fees, c2ve.caps]);
  ok('…but it stays a POTENTIAL edge: the contract rules and the order book are still not on file', c2ve && c2ve.classification === 'POTENTIAL_EDGE', c2ve && c2ve.caps.map((x) => x.reason));
  const c2x = await ask('Is Guardians at 49¢ on Kalshi a good price?', { fees: [Object.assign({}, FEES[0], { effective_to: ISO(-60) })] });
  ok('an expired schedule is not used', c2x.j.contract.evaluation.expected_fees.status === 'UNVERIFIED');

  /* ═══ 3. THE RUN-LINE CONTRACT ══════════════════════════════════════════ */
  const c3 = await ask('Is Cleveland +1.5 at 61 cents a good price on Kalshi?');
  const c3e = c3.j.contract && c3.j.contract.evaluation;
  ok('"Cleveland +1.5" is the run line at +1.5, not a moneyline and not odds', c3.j.contract && /Cleveland Guardians \+1\.5/.test(c3.j.contract.selection), c3.j.contract && c3.j.contract.selection);
  ok('fair 62% vs 61¢: +1¢ before fees, −1¢ after the 2¢ Kalshi fee: PASS', c3e && c3e.gross_expected_value === '0.01' && c3e.net_expected_value === '-0.01' && c3e.decision === 'PASS', c3e && [c3e.gross_expected_value, c3e.net_expected_value, c3e.decision]);

  /* ═══ 4. "FIND ME A BETTER PRICE" (follow-up) ═══════════════════════════ */
  const c4 = await ask('Find me a better price than this Kalshi contract.', { carried: { quant: c1.j.quant_state } });
  ok('the follow-up re-prices the carried contract and lists cheaper venues', c4.j.quant && c4.j.quant.intent === 'CONTRACT' && c4.j.contract && c4.j.contract.compare && c4.j.contract.compare.ranked[0].venue === 'FanDuel', c4.j.contract && c4.j.contract.compare);
  ok('…and says to check settlement before switching', /check that it settles the same way/.test(c4.j.answer), c4.j.answer);

  /* ═══ 5. "EXPLAIN WHY THIS CONTRACT HAS NEGATIVE EV" ═════════════════════ */
  const c5 = await ask('Explain why this contract has negative EV.', { carried: { quant: c3.j.quant_state }, dump: 'explain' });
  ok('routed to EXPLAIN_EV on the carried contract', c5.j.quant && c5.j.quant.intent === 'EXPLAIN_EV', c5.j.quant);
  ok('the explanation walks price, fee, break-even, fair and the turn negative', /costs 61¢ plus 2¢ in fees/.test(c5.j.answer) && /breaks even only if it wins 63\.0%/.test(c5.j.answer) && /62\.0%/.test(c5.j.answer) && /the fee is what turns it negative/.test(c5.j.answer), c5.j.answer);
  ok('…and when it would become playable', /playable at 59¢ or less/.test(c5.j.answer), c5.j.answer);

  /* ═══ 6. THE BEST UNDERDOG ═══════════════════════════════════════════════ */
  const u1 = await ask("What's the best available underdog?");
  ok('routed to the scan with the underdog filter', u1.j.quant && u1.j.quant.intent === 'SCAN' && u1.j.scan && u1.j.scan.filter === 'underdog', u1.j.quant);
  const ud = (u1.j.scan.potential || [])[0];
  ok('the Rays (+120) are the strongest underdog candidate; no favourite\'s price is offered', ud && ud.candidate.quote.odds_american > 100 && (u1.j.scan.potential || []).every((p) => p.candidate.quote.odds_american > 100), ud && ud.candidate.quote);
  ok('the heading says underdog', /STRONGEST UNDERDOG CANDIDATE/.test(u1.j.answer), u1.j.answer.split('\n').slice(0, 3));

  /* ═══ 7. WHICH SPORTS COULDN'T BE SCANNED? ═══════════════════════════════ */
  const v1 = await ask("Which sports couldn't be scanned?", { carried: { quant: s1.j.quant_state }, dump: 'coverage' });
  ok('from the carried scan: NBA and NHL named as not scanned, with the reason', v1.j.quant && v1.j.quant.intent === 'COVERAGE' && /Not scanned: .*NBA — EdgeDesk does not capture NBA prices/.test(v1.j.answer) && /NHL/.test(v1.j.answer), v1.j.answer);
  ok('…and soccer as not covered at all', /Not covered at all: Soccer/.test(v1.j.answer));
  const v2 = await ask('Which sports could not be scanned today?');
  ok('without a carried scan: a live count from the price rows', v2.j.quant && v2.j.quant.intent === 'COVERAGE' && /Source: EdgeDesk's capture configuration/.test(v2.j.answer) && /MLB/.test(v2.j.answer), v2.j.answer);

  /* ═══ 8. IF THE ODDS API FAILS… ══════════════════════════════════════════ */
  const o1 = await ask('If the odds API fails, can you still analyze this game?');
  ok('routed to OUTAGE: yes, research continues; EV and BUY stop', o1.j.quant && o1.j.quant.intent === 'OUTAGE' && /^Yes — the matchup analysis does not depend on the odds feed/.test(o1.j.answer) && /What stops: a current expected value and any BUY decision/.test(o1.j.answer), o1.j.answer);
  ok('…with the real age of the newest captured price', /newest captured price is \d+ minutes old/.test(o1.j.answer), o1.j.answer);
  const o2 = await ask('If the odds API fails, can you still analyze this game?', { signals: [], rows: {} });
  ok('with no price rows at all it still answers, research-only', /^Yes/.test(o2.j.answer));

  /* ═══ 9. WHAT THE QUANT DESK LEAVES ALONE ════════════════════════════════ */
  const f1 = await ask("What's the best college football market line value today?");
  ok('a football-scoped question still reaches the football desk', !f1.j.quant && (f1.j.desk || f1.j.answer), Object.keys(f1.j));
  const st1 = await ask('How many units should I bet on the best bet today?');
  ok('a staking question still reaches the staking engine (not the scan)', !st1.j.quant, Object.keys(st1.j));
  const legacy = await ask("What's the best bet right now?", { desk: false });
  ok('a non-desk client keeps the full research pipeline for a best-bet question', !legacy.j.quant, Object.keys(legacy.j));
  const plain = await ask('Who has the advantage in Rays vs. Guardians?');
  ok('a matchup question with no price is not a quant question', !plain.j.quant, plain.j.quant);


  /* ═══ 10. INDEPENDENT-AUDIT REGRESSIONS (security S1–S13, quant H2, H3) ══ */
  const ALL = MLB_SIGNALS.concat(NFL_SIGNALS);
  /* S1 the selection is the subject, not the nearest team */
  const r1 = await ask('Rays to beat the Guardians at 46 cents on Kalshi, worth it?');
  const r1e = r1.j.contract && r1.j.contract.evaluation;
  ok('S1: "Rays to beat the Guardians at 46¢" prices the RAYS (fair 46.55%), not the Guardians', r1.j.contract && /^Tampa Bay Rays YES$/.test(r1.j.contract.selection) && r1e && r1e.fair_probability === '0.4655', r1.j.contract && [r1.j.contract.selection, r1e && r1e.fair_probability]);
  ok('S1: …which, after the 2¢ Kalshi fee, is negative EV: PASS', r1e && r1e.net_expected_value === '-0.0145' && r1e.decision === 'PASS', r1e && [r1e.net_expected_value, r1e.decision]);
  const r2 = await ask('Will the Guardians beat the Rays? YES is 55c on Kalshi');
  ok('S1: "Will the Guardians beat the Rays? YES is 55c" prices the GUARDIANS', r2.j.contract && /^Cleveland Guardians YES$/.test(r2.j.contract.selection) && r2.j.contract.evaluation && r2.j.contract.evaluation.fair_probability === '0.5345', r2.j.contract && r2.j.contract.selection);
  const r3 = await ask('Is 46c on Kalshi fair for Rays vs Guardians?', { dump: 'contract_ambiguous' });
  ok('S1: both teams named, the price attached to neither: no side is guessed, nothing is priced or written', r3.j.contract && r3.j.contract.ambiguous_side === true && !r3.j.contract.evaluation && /say which side/.test(r3.j.answer) && !posted.some((p) => p.table === 'fair_price_estimates'), r3.j.answer);
  /* S2 totals, futures and team totals are not priced as the moneyline */
  for (const [q, kind] of [['Rays vs Guardians: is the over 8.5 at -110 good value?', 'total'], ['Guardians to win the World Series at 49 cents on Kalshi', 'futures'], ['Rays team total over 4.5 at 55 cents on Kalshi', 'total']]) {
    const x = await ask(q);
    ok('S2: "' + q + '" is not priced as the moneyline', x.j.contract && !x.j.contract.evaluation && new RegExp(kind).test(x.j.contract.unsupported_market || '') && !/POTENTIAL EDGE|VERIFIED EDGE/.test(x.j.answer) && !posted.some((p) => p.table === 'fair_price_estimates'), [x.j.quant, x.j.contract && x.j.contract.unsupported_market, x.j.answer]);
  }
  /* S3 football "coverage" is not the scan-coverage answer */
  for (const q of ['How good is the Bills pass coverage against the Lions?', 'Does Alabama play man or zone coverage?', "What's Georgia's coverage rate on third down?", 'Which markets should I not bet this weekend?']) {
    const x = await ask(q, { desk: false, signals: ALL });
    ok('S3: "' + q + '" is not routed to COVERAGE', !(x.j.quant && x.j.quant.intent === 'COVERAGE'), x.j.quant);
  }
  /* S4 injury and line-movement questions are not the odds-outage answer */
  for (const q of ['Will the odds move if Josh Allen is ruled out?', 'Does the market adjust enough if the Bills left tackle is out?']) {
    const x = await ask(q, { signals: ALL });
    ok('S4: "' + q + '" is not routed to OUTAGE', !(x.j.quant && x.j.quant.intent === 'OUTAGE'), x.j.quant);
  }
  /* S5 a best-bet question about one game is that game's */
  for (const q of ['What is the best bet in Lions vs Bills?', 'What should I bet on the Bills?']) {
    const x = await ask(q, { signals: ALL });
    ok('S5: "' + q + '" is not the cross-sport scan', !(x.j.quant && x.j.quant.intent === 'SCAN'), x.j.quant);
  }
  const pk = await ask("What's the best bet?", { signals: ALL, packet: { game: { sport_key: 'americanfootball_nfl', home_team: 'Buffalo Bills', away_team: 'Detroit Lions' } } });
  ok('S5: a best-bet question sent with a game packet is not the cross-sport scan', !(pk.j.quant && pk.j.quant.intent === 'SCAN'), pk.j.quant);
  const xs = await ask("What's the best bet on the Bills across all sports?", { signals: ALL });
  ok('S5: …unless it asks across all sports', xs.j.quant && xs.j.quant.intent === 'SCAN', xs.j.quant);
  /* S6 "2 cents" and a temperature are not contract prices */
  for (const q of ['What is your 2 cents on Lions vs Bills?', 'Kickoff temperature 12c in Buffalo, does that favor the under?']) {
    const x = await ask(q, { signals: ALL });
    ok('S6: "' + q + '" is not a contract check and writes nothing', !(x.j.quant && x.j.quant.intent === 'CONTRACT') && !posted.some((p) => p.table === 'fair_price_estimates'), x.j.quant);
  }
  /* S7 a sportsbook price on a football team goes to the football desk */
  const b1 = await ask('Is Bills -150 a good price?', { signals: ALL });
  ok('S7: "Is Bills -150 a good price?" is left to the football desk / pipeline', !b1.j.quant, b1.j.quant);
  /* S8 deterministic, per-user ledger keys */
  const m0 = Math.floor(Date.now() / 60000);
  await ask('Is Guardians at 49¢ on Kalshi a good price?'); const e1 = posted.find((p) => p.table === 'fair_price_estimates');
  await ask('Is Guardians at 49¢ on Kalshi a good price?'); const e2 = posted.find((p) => p.table === 'fair_price_estimates');
  ok('S8: the same check in the same minute gets the same estimate id (a hash, not Math.random)', e1 && e2 && /^fpe_[0-9a-f]{16}$/.test(e1.body[0].estimate_id) && (Math.floor(Date.now() / 60000) !== m0 || e1.body[0].estimate_id === e2.body[0].estimate_id), e1 && e2 && [e1.body[0].estimate_id, e2.body[0].estimate_id]);
  ok('S8: …written with the per-user conflict key', e1 && /on_conflict=user_id,estimate_id/.test(e1.query), e1 && e1.query);
  const a1 = await ask("What's the best bet right now?"); const ar1 = posted.find((p) => p.table === 'opportunity_audits');
  const a2 = await ask("What's the best bet right now?"); const ar2 = posted.find((p) => p.table === 'opportunity_audits');
  ok('S8: the same scan writes the same audit ids, per-user keyed', ar1 && ar2 && ar1.body.every((r) => /^aud_[0-9a-f]{16}$/.test(r.audit_id)) && JSON.stringify(ar1.body.map((r) => r.audit_id)) === JSON.stringify(ar2.body.map((r) => r.audit_id)) && /on_conflict=user_id,audit_id/.test(ar1.query), ar1 && ar2 && [ar1.body.map((r) => r.audit_id), ar2.body.map((r) => r.audit_id), ar1.query]);
  /* S10 a forged carried coverage is not echoed as fact */
  const forged = { schema: 'edgedesk_quant_state_v1', built_at: new Date().toISOString(), coverage: [{ sport: 'basketball_nba', label: 'NBA', status: 'EVALUATED' }] };
  const fc = await ask("Which sports couldn't be scanned?", { carried: { quant: forged } });
  ok('S10: a carried "NBA was EVALUATED" is not repeated; the live read says NBA is not captured', /Not scanned: .*NBA/.test(fc.j.answer) && !/Every in-season sport EdgeDesk supports was scanned/.test(fc.j.answer), fc.j.answer);
  /* S13 a database error (which can quote a row) is not shown to callers */
  postFail = 'new row for relation "opportunity_audits" violates check constraint. Failing row contains (11111111-1111-1111-1111-111111111111, what is the best bet ...)';
  const pf = await ask("What's the best bet right now?");
  postFail = null;
  const aw = pf.j.scan && pf.j.scan.audit_write;
  ok('S13: the scan reports that the audit write failed without the database text', aw && aw.ok === false && !/Failing row|1111-1111/.test(JSON.stringify(aw)), aw);
  const probe = await m.handle(new Request('https://fn.test/edgedesk_ai?probe=1', { method: 'GET' }));
  const pj = await probe.json().catch(() => ({}));
  /* (the probe's older board/stake/desk write fields follow the same pattern and predate this change: reported, not widened here) */
  const qk = pj.quant_kernel || {};
  ok('S13: …and so does the unauthenticated probe\'s quant section', qk.last_audit_write && qk.last_audit_write.ok === false && !/Failing row|1111-1111/.test(JSON.stringify(qk)), qk);
  /* H3 a NO contract is priced on the complement, and compared with the other side's books */
  const n1 = await ask('Buy Rays NO at 44¢ on Kalshi?');
  const n1e = n1.j.contract && n1.j.contract.evaluation;
  ok('H3: Rays NO is priced on 1 − 46.55% = 53.45%, not on the Rays\' 46.55%', n1e && n1e.side === 'NO' && n1e.fair_probability === '0.5345', n1e && [n1e.side, n1e.fair_probability]);
  ok('H3: …and compared with the Guardians\' sportsbook prices, not the Rays\' (+120)', n1.j.contract.compare && n1.j.contract.compare.ranked.length > 1 && !n1.j.contract.compare.ranked.some((r) => r.entry === '+120'), n1.j.contract.compare && n1.j.contract.compare.ranked.map((r) => r.venue + ' ' + r.entry));
  /* H2 the scan's verdict is priced on the fair the audit re-read */
  const h2 = await ask("What's the best bet this week across all sports?", { signals: ALL, fresh: { 'ev-det-buf|spreads|Buffalo Bills|-2.5': { sharp_fair: 0.52 } } });
  const bills = [].concat(h2.j.scan.best ? [h2.j.scan.best] : [], h2.j.scan.potential || [], h2.j.scan.near_misses || []).find((x) => x.candidate.selection === 'Buffalo Bills');
  ok('H2: the sharp fair moved 53.2% → 52.0% at audit time: the Bills are priced at 1.4%, below the 2% bar — not BUY', bills && Math.abs(Number(bills.evaluation.net_ev_per_dollar) - 0.014) < 1e-6 && bills.evaluation.classification !== 'VERIFIED_EDGE' && h2.j.scan.decision !== 'BUY', bills && [bills.audit.status, bills.evaluation.net_ev_per_dollar, bills.evaluation.classification, h2.j.scan.decision]);

  if (DUMP) require('fs').writeFileSync(process.env.QUANT_DUMP, JSON.stringify(DUMP));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
