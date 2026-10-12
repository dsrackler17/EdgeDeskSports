#!/usr/bin/env node
/* ===========================================================================
   PHASE 2 — THE RESEARCH SYSTEM, END TO END, THROUGH THE REAL HANDLER.

   Node strips the TypeScript; the network is the intelligence fixture router
   (the REAL committed NFL slate, FBS slate, metrics and pricing validation),
   with EdgeDesk-captured prices, per-book quotes, an MLB card and desk notes
   written for each scenario. The clock is FIXED (Monday 2026-10-12 16:00 UTC)
   and passed to the route, so "this weekend" is the same window every run.

   The twelve scenarios the brief names:
      1. the best opportunity across sports
      2. an NFL game with conflicting injury reports
      3. a college game with a large model-versus-market discrepancy
      4. an MLB game whose starting pitcher changed
      5. a contract that is positive before fees and negative after
      6. a heavily juiced alternate spread
      7. two sources that disagree on a player's availability
      8. stale odds
      9. no independent model
     10. a slate where every candidate is rejected
     11. a CSV whose parlay legs repeat the ticket
     12. a research API failure that must not take the basic analysis with it
   plus the two acceptance questions, numeric consistency between the answer
   and the engine's JSON, the communicator's critic (it may not invent or
   change a value), and the auditor rejecting what the researcher favoured.

   No writing model is called unless a scenario switches narration on and
   supplies the fake model's reply.

   Run: node tools/intelligence/research_host.test.js    (RESEARCH_PRINT=1 prints every answer)
        RESEARCH_DUMP=<file> also writes the responses for the browser suite.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const FX = require('./fixtures.js');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 900) : '')); }
const PRINT = process.env.RESEARCH_PRINT === '1';
const DUMP = process.env.RESEARCH_DUMP ? {} : null;

const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_QUOTE_REFRESH: '1', CRON_SECRET: 'cron-test',
  EDGEDESK_RESEARCH_NARRATE: '1', EDGEDESK_RESEARCH_PAID_OK: '0', EDGEDESK_RESEARCH_LOG: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const NOW = Date.parse('2026-10-12T16:00:00Z');            /* Monday noon in New York */
const ISO = (min) => new Date(NOW + min * 60000).toISOString();
const H = 60;
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

let route = () => [];
let modelCalls = 0, modelReply = null;
let searchCalls = [], searchReply = null, searchDelay = 0;
let costCalls = [], costReply = null;
let posted = [], reads = [], rpcCalls = [], quotaReply = null;
const oddsCalls = [];
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0 && init && /"web_search"/.test(String(init.body))) {
    searchCalls.push({ body: JSON.parse(init.body), headers: init.headers || {} });
    if (searchDelay) await new Promise((r) => setTimeout(r, searchDelay));
    const rep = typeof searchReply === 'function' ? searchReply(JSON.parse(init.body), searchCalls.length) : searchReply;
    if (!rep || rep.__status) return { ok: false, status: (rep && rep.__status) || 500, json: async () => ({ type: 'error', error: { type: 'api_error', message: 'fixture failure' } }), text: async () => 'fixture failure' };
    return { ok: true, status: 200, json: async () => rep, text: async () => JSON.stringify(rep) };
  }
  if (u.indexOf('api.anthropic.com') >= 0) {
    modelCalls++;
    const text = typeof modelReply === 'function' ? modelReply(JSON.parse(init.body)) : (modelReply || 'ok');
    return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text }] }), text: async () => text };
  }
  if (u.indexOf('the-odds-api.com') >= 0 || u.indexOf('/functions/v1/capture') >= 0) { oddsCalls.push(u); throw new Error('an odds request was made: ' + u); }
  if (init && init.method === 'POST' && u.indexOf('/rpc/research_cost_') >= 0) {
    costCalls.push({ fn: u.split('/rpc/')[1], body: JSON.parse(init.body), auth: (init.headers || {}).authorization });
    const out = /claim/.test(u) ? (costReply || { ok: true, claim_id: 77 }) : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  }
  if (init && init.method === 'POST' && u.indexOf('/rpc/research_usage_') >= 0) {
    rpcCalls.push({ fn: u.split('/rpc/')[1], body: JSON.parse(init.body), auth: (init.headers || {}).authorization });
    const out = /claim/.test(u) ? (quotaReply || { ok: true, claim_id: 41 }) : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  }
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) {
    posted.push({ table: u.replace('https://sb.test/rest/v1/', '').split('?')[0], query: u.split('?')[1] || '', body: JSON.parse(init.body), auth: (init.headers || {}).authorization });
    return { ok: true, status: 201, text: async () => '', json: async () => [] };
  }
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  reads.push({ url: u, auth: init && init.headers ? (init.headers.authorization || init.headers.Authorization) : null });
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  if (d && d.__status) return { ok: false, status: d.__status, text: async () => d.__error || '', json: async () => null };
  return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
};

/* the answer's "Field: value" lines */
function field(answer, k) { const m = new RegExp('^' + k.replace(/[()]/g, '\\$&') + ': (.*)$', 'm').exec(answer || ''); return m ? m[1] : null; }
function fmtAm(n) { n = Number(n); return (n > 0 ? '+' : '') + Math.round(n); }
const FIELDS = ['Event', 'Sport', 'Market', 'Venue', 'Verified market price', 'Independent fair probability', 'Break-even probability', 'Estimated net EV', 'Maximum acceptable price', 'Model reliability',
  'Research freshness', 'Why the model disagrees with the market', 'Primary matchup advantage', 'Strongest counterargument', 'What would invalidate the opportunity', 'Final status'];
/* every number the candidate block prints for the decision equals the engine's JSON */
function consistent(tag, answer, row) {
  const ev = row.evaluation || {}, r = row.research || {};
  const evText = field(answer, 'Estimated net EV');
  ok(tag + ': net EV in the answer is the engine\'s (' + evText + ')', evText && evText.indexOf((Number(ev.net_ev_per_dollar) * 100).toFixed(2) + '% per $1') === 0, [evText, ev.net_ev_per_dollar]);
  const be = field(answer, 'Break-even probability');
  ok(tag + ': break-even in the answer is the engine\'s', be && be.indexOf((Number(ev.break_even_probability) * 100).toFixed(1) + '%') === 0, [be, ev.break_even_probability]);
  const mx = field(answer, 'Maximum acceptable price');
  ok(tag + ': maximum acceptable price is the engine\'s', ev.maximum_entry_price == null ? /^none/.test(mx || '') : mx && mx.indexOf(fmtAm(ev.maximum_entry_price)) === 0, [mx, ev.maximum_entry_price]);
  const vp = field(answer, 'Verified market price');
  ok(tag + ': the verified market price is the engine\'s entry price', vp && vp.indexOf(fmtAm(ev.entry_price)) === 0, [vp, ev.entry_price]);
  const ind = field(answer, 'Independent fair probability');
  const want = r.independent_fair_probability != null ? r.independent_fair_probability : r.model_view ? r.model_view.probability : null;
  ok(tag + ': the independent fair probability is the engine\'s, or honestly unavailable', want == null ? /^unavailable/.test(ind || '') : ind && ind.indexOf((want * 100).toFixed(1) + '%') === 0, [ind, want]);
  const fs_ = field(answer, 'Final status');
  ok(tag + ': the final status is the auditor\'s', fs_ && fs_.indexOf(row.classification.final_status) === 0, [fs_, row.classification]);
}

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const AG = globalThis.EDAGENTS, GR = globalThis.EDGRAPH, BETS = globalThis.EDBETS;
  ok('the research kernels are loaded into the edge function', !!(AG && GR && globalThis.EDDISAGREE && globalThis.EDBUDGET && BETS), Object.keys(globalThis).filter((k) => /^ED/.test(k)).slice(0, 40));
  const fx = FX.build(NOW);

  /* ---- the NFL card: Lions @ Bills and Colts @ Texans on Sunday, with the engine's own QB-out re-runs ---- */
  const SUNDAY = ISO(6 * 24 * H);                                        /* Sunday 2026-10-18 16:00 UTC, inside "this weekend" */
  fx.nfl.games.forEach((g) => { if (g.game_id === 'nfl-fx-det-buf' || g.game_id === 'nfl-fx-ind-hou') g.kickoff = SUNDAY; });
  const nflGame = (id) => fx.nfl.games.find((g) => g.game_id === id);
  const BUF = nflGame('nfl-fx-det-buf'), HOU = nflGame('nfl-fx-ind-hou');
  BUF.scenarios = { home_qb_out: { home_line: 1.3, delta_home_line: 6.5, basis: 'FIXTURE engine re-run with home_qb_id = null', source: 'FIXTURE football/nfl/slate.json (engine re-run, one input changed)' },
    away_qb_out: { home_line: -9.4, delta_home_line: -4.2, basis: 'FIXTURE engine re-run with away_qb_id = null', source: 'FIXTURE football/nfl/slate.json (engine re-run, one input changed)' } };
  const nfl = (o) => fx.signal(Object.assign({ sport_key: 'americanfootball_nfl', sport_title: 'NFL', market: 'spreads', first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, o));
  const BILLS = nfl({ sig_key: 'ev-det-buf|spreads|Buffalo Bills|-2.5', event_id: 'ev-det-buf', selection: 'Buffalo Bills', point: -2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.95, best_book: 'FanDuel', sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528, pin_dec: 1.88, pin_opp_dec: 2.02, corrob_n: 4 });
  const LIONS = nfl({ sig_key: 'ev-det-buf|spreads|Detroit Lions|2.5', event_id: 'ev-det-buf', selection: 'Detroit Lions', point: 2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.87, best_book: 'BetMGM', sharp_fair: 0.468, sharp_book_fair: 0.468, consensus_fair: 0.472, pin_dec: 2.02, pin_opp_dec: 1.88, edge: -0.03, first_edge: -0.03, corrob_n: 4 });
  const TEXANS = nfl({ sig_key: 'ev-ind-hou|spreads|Houston Texans|-3.5', event_id: 'ev-ind-hou', selection: 'Houston Texans', point: -3.5, home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: HOU.kickoff, best_dec: 1.96, best_book: 'FanDuel', sharp_fair: 0.533, sharp_book_fair: 0.533, consensus_fair: 0.53, pin_dec: 1.87, pin_opp_dec: 2.03, corrob_n: 4 });
  const COLTS = nfl({ sig_key: 'ev-ind-hou|spreads|Indianapolis Colts|3.5', event_id: 'ev-ind-hou', selection: 'Indianapolis Colts', point: 3.5, home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: HOU.kickoff, best_dec: 1.86, best_book: 'BetMGM', sharp_fair: 0.467, sharp_book_fair: 0.467, consensus_fair: 0.47, pin_dec: 2.03, pin_opp_dec: 1.87, edge: -0.03, first_edge: -0.03, corrob_n: 4 });
  const NFL_SIGNALS = [BILLS, LIONS, TEXANS, COLTS];
  const BOOK_QUOTES = {
    'ev-det-buf|spreads|Buffalo Bills|-2.5': [['FanDuel', 1.95], ['DraftKings', 1.93], ['Caesars', 1.92], ['Pinnacle', 1.88]],
    'ev-ind-hou|spreads|Houston Texans|-3.5': [['FanDuel', 1.96], ['DraftKings', 1.94], ['Pinnacle', 1.87]],
  };

  /* ---- MLB: Rays (away) @ Guardians (home), Saturday evening ---- */
  const MLB_START = '2026-10-17T23:05:00.000Z';
  const MLB_GAME = { game_id: '776655', game_date: etDate(Date.parse(MLB_START)), home_team: 'Cleveland Guardians', away_team: 'Tampa Bay Rays', start_time: MLB_START, status: 'Scheduled', park_id: 5 };
  const CARD = { game_date: MLB_GAME.game_date, start_time: MLB_START, status: 'Scheduled', away_team_name: 'Tampa Bay Rays', away_pitcher_name: 'Shane Baz', away_pitcher_throws: 'R', home_team_name: 'Cleveland Guardians', home_pitcher_name: 'Tanner Bibee', home_pitcher_throws: 'R', run_factor: 0.97, temp_f: 58, wind_mph: 8, wind_rel: 'in from LF', updated_at: ISO(-3 * H) };
  const mlb = (o) => fx.signal(Object.assign({ event_id: 'ev-tb-cle', sport_key: 'baseball_mlb', sport_title: 'MLB', home_team: 'Cleveland Guardians', away_team: 'Tampa Bay Rays', commence_time: MLB_START, first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, o));
  const RAYS_ML = mlb({ sig_key: 'ev-tb-cle|h2h|Tampa Bay Rays|', market: 'h2h', selection: 'Tampa Bay Rays', point: null, best_dec: 2.2, first_best_dec: 2.15, best_book: 'FanDuel', sharp_fair: 0.4655, sharp_book_fair: 0.4655, consensus_fair: 0.464, pin_dec: 2.08, pin_opp_dec: 1.81, edge: 0.024, first_edge: 0.01, n_books: 7, n_books_eff: 5, corrob_n: 4 });
  const CLE_ML = mlb({ sig_key: 'ev-tb-cle|h2h|Cleveland Guardians|', market: 'h2h', selection: 'Cleveland Guardians', point: null, best_dec: 1.83, first_best_dec: 1.83, best_book: 'DraftKings', sharp_fair: 0.5345, sharp_book_fair: 0.5345, consensus_fair: 0.536, pin_dec: 1.81, pin_opp_dec: 2.08, edge: -0.02, first_edge: -0.02, n_books: 7, n_books_eff: 5, corrob_n: 4 });
  const MLB_SIGNALS = [RAYS_ML, CLE_ML];
  BOOK_QUOTES['ev-tb-cle|h2h|Tampa Bay Rays|'] = [['FanDuel', 2.2], ['DraftKings', 2.18], ['BetMGM', 2.15], ['Caesars', 2.12], ['Pinnacle', 2.08]];
  BOOK_QUOTES['ev-tb-cle|h2h|Cleveland Guardians|'] = [['DraftKings', 1.83], ['FanDuel', 1.8], ['Pinnacle', 1.81]];

  /* ---- the NFL injury build, timestamped against the fixed clock ---- */
  function metricsWith(over) {
    const mm = JSON.parse(JSON.stringify(fx.metrics));
    mm.generated_at = ISO(-2 * H);
    Object.keys(mm.nfl.teams).forEach((k) => { const t = mm.nfl.teams[k]; if (t.injuries) t.injuries.retrieved_at = ISO(-2 * H); if (t.starter) { t.starter.published_at = ISO(-20 * H); t.starter.retrieved_at = ISO(-2 * H); } });
    Object.keys(over || {}).forEach((k) => { const t = mm.nfl.teams[k]; const o = over[k]; if (o.players) t.injuries.players = o.players.concat(t.injuries.players); if (o.retrieved_at) t.injuries.retrieved_at = o.retrieved_at; });
    return mm;
  }
  function routerFor(o) {
    o = o || {};
    const signals = o.signals || MLB_SIGNALS.concat(NFL_SIGNALS);
    const inner = FX.router(fx, Object.assign({ signals, metrics: o.metrics || metricsWith(), notes: o.notes || { schema: 'edgedesk_desk_notes_v1', notes: [] } }, o.opts || {}));
    return function (u, init) {
      if (o.fail && o.fail(u)) return { __status: 503, __error: 'upstream unavailable' };
      /* the audit's fresh re-read of one signal, optionally different from what the board read */
      if (o.fresh && /signals\?select=sig_key,event_id,market,selection,point,best_dec,best_book,sharp_fair/.test(u)) {
        const k = decodeURIComponent((/sig_key=eq\.([^&]+)/.exec(u) || [])[1] || '');
        const row = signals.find((x) => x.sig_key === k);
        if (row) return [Object.assign({}, row, o.fresh[k] || {})];
      }
      if (u.indexOf('games?') >= 0 && u.indexOf('game_date=in.') >= 0 && u.indexOf('sport_key=') < 0) return o.noMlb ? [] : [MLB_GAME];
      if (u.indexOf('mlb_game_cards?') >= 0) return o.noMlb ? [] : [CARD];
      if (u.indexOf('market_execution_costs?') >= 0) return o.fees || [];
      if (u.indexOf('book_quotes?') >= 0) {
        const k = decodeURIComponent((/sig_key=eq\.([^&]+)/.exec(u) || [])[1] || '');
        return (BOOK_QUOTES[k] || []).map(([b, d]) => ({ sig_key: k, book_title: b, book_key: b.toLowerCase(), dec: d, updated_at: o.bookAt || ISO(-3), is_fresh: true }));
      }
      if (u.indexOf('portfolio_positions?') >= 0) return o.positions ? o.positions(u, init) : [];
      return inner(u, init);
    };
  }
  async function ask(question, o) {
    o = o || {};
    const M = o.mod || m;
    M.clearCache(); M.resetRateLimit(); if (M.clearInvestigationCache) M.clearInvestigationCache(); if (!o.keepLedger) M.resetResearchLedger();
    route = routerFor(o);
    modelCalls = 0; modelReply = o.modelReply || null; posted = []; reads = []; rpcCalls = []; quotaReply = o.quota || null; costCalls = []; costReply = o.cost || null;
    const body = { mode: 'chat', question, history: [], research_context: o.carried || null, timezone: 'America/New_York', desk: o.desk === false ? undefined : true, intent_hint: o.qhint || undefined };
    const j = await (o.mod || m).quantTurn({ body, auth: 'Bearer ' + (o.jwt || USER_JWT), now: o.now || NOW });
    if (PRINT) console.log('\n──── Q: ' + question + '\n' + (j ? j.answer : 'null (not a quant route)'));
    if (DUMP && o.dump) DUMP[o.dump] = { question, response: j };
    return j;
  }
  /* a JWT whose sub is a fixed user id (the edge function only decodes it for the soft per-user cap) */
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const USER_JWT = b64({ alg: 'none' }) + '.' + b64({ sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated' }) + '.sig';

  /* ═══ S1. THE BEST OPPORTUNITY ACROSS SPORTS ════════════════════════════ */
  const s1 = await ask("What's the best bet this weekend across all sports?", { dump: 'scan_weekend' });
  const sc = (s1 && s1.scan) || {};
  ok('S1: a cross-sport scan, deterministic, no model call, no odds request', s1 && s1.quant && s1.quant.intent === 'SCAN' && modelCalls === 0 && oddsCalls.length === 0, s1 && [s1.quant, modelCalls]);
  ok('S1: NFL and MLB were both evaluated', ['americanfootball_nfl', 'baseball_mlb'].every((k) => (sc.coverage || []).some((c) => c.sport === k && c.status === 'EVALUATED')), (sc.coverage || []).map((c) => c.sport + ':' + c.status));
  ok('S1: every audited candidate went through the research chain', sc.researched === true && sc.counts && sc.counts.audited >= 2 && [sc.best].concat(sc.potential || [], sc.near_misses || []).filter(Boolean).every((r) => r.classification && r.research), sc.counts);
  const best = sc.best;
  /* THE CALCULATION LEDGER: every number on the row as a versioned record, recomputed independently */
  const bC = best && best.calc, recC = (L, n) => L && L.records.find((x) => x.name === n);
  ok('CALC S1: the best row carries its calculation ledger, every engine value agreeing with the independent recomputation', bC && bC.schema === 'edgedesk_quant_verify_v1' && bC.verification.verdict === 'VERIFIED' && bC.verification.checked >= 8 && bC.verification.mismatches.length === 0 && bC.market_comparison.status === 'AVAILABLE', bC && bC.verification);
  ok('CALC S1: the EV, break-even and maximum price records are the evaluation\'s own numbers, each with version, formula, inputs and assumptions', bC && recC(bC, 'EXPECTED_VALUE').output.value === Number(best.evaluation.net_ev_per_dollar) && recC(bC, 'BREAK_EVEN').output.value === Number(best.evaluation.break_even_probability) && recC(bC, 'MAXIMUM_ENTRY_PRICE').output.value === best.evaluation.maximum_entry_price && bC.records.every((x) => /@\d+\.\d+\.\d+$/.test(x.version) && x.formula) && recC(bC, 'EXPECTED_VALUE').inputs.length === 3 && recC(bC, 'EXPECTED_VALUE').assumptions.length >= 2, bC && bC.records.map((x) => [x.name, x.output && x.output.value]));
  ok('CALC S1: the projection is compared with the market line (gap and cover probability) and never called edge evidence', bC && recC(bC, 'LINE_DISCREPANCY').status === 'COMPUTED' && recC(bC, 'LINE_DISCREPANCY').output.is_edge_evidence === false && recC(bC, 'LINE_DISCREPANCY').output.cover_probability > 0 && recC(bC, 'LINE_DISCREPANCY').inputs.some((i) => /model cover probability/.test(i.name)), bC && recC(bC, 'LINE_DISCREPANCY'));
  ok('CALC S1: the model\'s measured record comes from the validation artifact (held-out Brier against the base rate)', bC && recC(bC, 'CALIBRATION').status === 'COMPUTED' && typeof recC(bC, 'CALIBRATION').output.value === 'number' && typeof recC(bC, 'CALIBRATION').output.beats_base_rate === 'boolean', bC && recC(bC, 'CALIBRATION'));
  ok('CALC S1: the turn is verified: every ledger recomputes, and every probability, price and EV in the answer traces to a calculation', s1 && s1.quant_verification && s1.quant_verification.verdict === 'VERIFIED' && s1.quant_verification.ledgers >= 2 && s1.quant_verification.numbers.verdict === 'PASS' && s1.quant_verification.numbers.checked >= 5, s1 && s1.quant_verification);
  /* THE RUN RECORD: one write-once research_runs row per research turn */
  const runPost = posted.find((p) => p.table === 'research_runs'), runRow = runPost && runPost.body;
  ok('RUN S1: the turn writes one research_runs row under the reader\'s own token, idempotent on (user, run id)', runPost && /on_conflict=user_id,run_id/.test(runPost.query) && /^Bearer /.test(runPost.auth) && /^rr_[0-9a-f]{16}$/.test(runRow.run_id) && s1.research_run && s1.research_run.run_id === runRow.run_id && s1.research_run.write.ok, runPost && [runPost.query, runRow.run_id, s1.research_run]);
  ok('RUN S1: it holds the question, route, path, level, the plan and what actually ran', runRow && runRow.question === "What's the best bet this weekend across all sports?" && runRow.route === 'SCAN' && runRow.path === s1.research_plan.path && runRow.research_level === 'L3' && runRow.plan_actual.length === s1.research_plan_actual.length && runRow.plan_actual.every((x) => x.stage && x.actual), runRow && [runRow.route, runRow.path, runRow.plan_actual]);
  ok('RUN S1: sources consulted, the model and market snapshots, and the conclusions (class, challenge, research confidence, EV) per candidate', runRow && runRow.sources.length >= 2 && runRow.sources.every((x) => x.url || x.dataset_id) && runRow.model_snapshot.length === runRow.market_snapshot.length && runRow.conclusions.length === runRow.model_snapshot.length && runRow.conclusions.some((c) => c.selection === 'Buffalo Bills' && c.classification === 'VERIFIED_CANDIDATE' && c.challenge === 'STANDS' && c.research_confidence && c.net_ev_per_dollar === Number(best.evaluation.net_ev_per_dollar)) && runRow.market_snapshot.some((m) => m.selection === 'Buffalo Bills' && m.book === 'FanDuel' && m.captured_at), runRow && runRow.conclusions);
  ok('RUN S1: the frozen prediction snapshots it rests on, the earliest event start (no look-ahead), the verification, cost and engine versions', runRow && runRow.snapshot_ids.length >= 1 && runRow.snapshot_ids.every((x) => /^ps_[0-9a-f]{16}$/.test(x)) && Date.parse(runRow.earliest_event_start) > NOW && runRow.verification && runRow.verification.verdict === 'VERIFIED' && runRow.cost_usd === 0 && runRow.engine_versions.challenge === 'edgedesk_challenge_v1' && runRow.engine_versions.fairodds_calc && runRow.final_status === 'VERIFIED CANDIDATE', runRow && [runRow.snapshot_ids, runRow.earliest_event_start, runRow.verification, runRow.engine_versions]);
  ok('RUN S1: the run row carries no outcome (outcomes are written later, apart)', runRow && !Object.keys(runRow).some((k) => /result|outcome|closing|clv|profit/.test(k)), runRow && Object.keys(runRow));
  /* THE CHALLENGE PASS: the eight questions, answered from the evidence and calculation ledgers */
  const bCh = best && best.challenge;
  ok('CHALLENGE S1: the best candidate faced all eight questions and STANDS — each answered from the ledgers, nothing unresolved', bCh && bCh.schema === 'edgedesk_challenge_v1' && bCh.questions.length === 8 && bCh.outcome === 'STANDS' && bCh.unresolved.critical === 0 && bCh.unresolved.important === 0 && bCh.questions.every((x) => x.answer && x.status), bCh && [bCh.outcome, bCh.questions.map((x) => x.id + ':' + x.status + ':' + x.answer.slice(0, 60))]);
  ok('CHALLENGE S1: the market-priced Bills answer sample size and calibration NOT_APPLICABLE; the quote CLEAR; confidence a category, not a percentage', bCh && bCh.questions.find((x) => x.id === 'Q3_SAMPLE_SIZE').status === 'NOT_APPLICABLE' && bCh.questions.find((x) => x.id === 'Q6_CALIBRATION').status === 'NOT_APPLICABLE' && bCh.questions.find((x) => x.id === 'Q5_STALE_QUOTE').status === 'CLEAR' && ['HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT'].includes(bCh.confidence.after) && !/%/.test(JSON.stringify(bCh.confidence)), bCh && bCh.confidence);
  ok('S1: the best VERIFIED CANDIDATE is Bills -2.5 at FanDuel', best && best.candidate.selection === 'Buffalo Bills' && best.classification.classification === 'VERIFIED_CANDIDATE' && sc.final_status === 'VERIFIED CANDIDATE', best ? [best.candidate.selection, best.classification] : (sc.potential || []).map((p) => [p.candidate.selection, p.classification]));
  ok('S1: the answer opens BEST VERIFIED RESEARCH CANDIDATE and prints every field the brief names', /^BEST VERIFIED RESEARCH CANDIDATE/.test(s1.answer) && FIELDS.every((k) => field(s1.answer, k) != null), FIELDS.filter((k) => field(s1.answer, k) == null));
  if (best) consistent('S1', s1.answer, best);
  ok('S1: the Texans are held back: the engine priced Anthony Richardson, the depth chart lists Daniel Jones', [].concat(sc.potential || [], sc.near_misses || []).some((r) => r.candidate.selection === 'Houston Texans' && r.classification.classification === 'RESEARCH_REQUIRED'), [].concat(sc.potential || [], sc.near_misses || []).map((r) => [r.candidate.selection, r.classification && r.classification.reasons[0]]));
  const allFindings = [best].concat(sc.potential || [], sc.near_misses || []).filter(Boolean).flatMap((r) => r.research.findings || []);
  ok('S1: every finding carries a source URL, a retrieval time, an event reference, a claim and a reliability class', allFindings.length > 5 && allFindings.every((f) => /^https:\/\//.test(f.source_url) && f.retrieved_at && f.event_ref && f.claim && ['OFFICIAL', 'CREDIBLE_JOURNALISM', 'STATISTICAL_DATA', 'SPECULATION', 'OPINION', 'UNKNOWN'].includes(f.reliability)), allFindings.slice(0, 2));
  const srcUrls = (s1.answer.match(/https:\/\/[^\s)]+/g) || []);
  ok('S1: every link in the answer is a source a finding came from (no fabricated citation)', srcUrls.length >= 2 && srcUrls.every((u) => allFindings.some((f) => f.source_url === u)), srcUrls);
  ok('S1: the four confidence measures are reported separately', best && best.research.confidence && ['outcome_probability', 'research_confidence', 'model_reliability', 'execution_confidence'].every((k) => best.research.confidence[k]), best && best.research.confidence);
  ok('S1: no model is called calibrated: the LEAN model is a cross-check, the price is the sharp market\'s', best && best.research.fair_kind === 'SHARP_NO_VIG' && /cross-check only/.test(field(s1.answer, 'Independent fair probability') || '') && !/\bcalibrated\b/i.test(field(s1.answer, 'Model reliability') || ''), best && [best.research.fair_kind, field(s1.answer, 'Model reliability')]);
  ok('S1: no guarantee or certainty language anywhere in the answer', !GR.CERTAINTY.test(s1.answer), (s1.answer.match(GR.CERTAINTY) || [])[0]);
  const rf = posted.filter((p) => p.table === 'research_findings'), ps = posted.filter((p) => p.table === 'prediction_snapshots');
  ok('S1: the findings are written once each, under the caller\'s token, idempotently keyed', rf.length === 1 && /on_conflict=user_id,finding_id/.test(rf[0].query) && rf[0].auth === 'Bearer ' + USER_JWT && rf[0].body.every((x) => /^f_/.test(x.finding_id) && /^https:\/\//.test(x.source_url) && x.retrieved_at && x.provider !== 'edgedesk_ai'), rf.map((p) => [p.query, p.body.length]));
  ok('S1: pregame prediction snapshots are written before kickoff, with the quote captured before kickoff (no look-ahead)', ps.length === 1 && /on_conflict=user_id,snapshot_id/.test(ps[0].query) && ps[0].body.length >= 2 && ps[0].body.every((x) => Date.parse(x.event_start) > NOW && Date.parse(x.quote_captured_at) < Date.parse(x.event_start) && !('result' in x) && !('outcome' in x)), ps.map((p) => p.body.map((x) => [x.selection, x.classification, x.event_start])));
  ok('S1: the Bills snapshot records the auditor\'s class and the exact EV', ps[0] && ps[0].body.some((x) => x.selection === 'Buffalo Bills' && x.classification === 'VERIFIED_CANDIDATE' && Math.abs(x.net_ev_per_dollar - Number(best.evaluation.net_ev_per_dollar)) < 1e-9), ps[0] && ps[0].body.map((x) => [x.selection, x.classification, x.net_ev_per_dollar]));
  ok('S1: research cost is reported per turn, and free sources cost nothing', sc.research_summary && sc.research_summary.level === 'L3' && sc.research_summary.cost_estimate_usd === 0 && /cost estimate \$0\.000/.test(s1.answer), sc.research_summary);
  ok('S1: paid research stayed off: no search provider was called', !reads.some((r) => /api\.search\.brave\.com|api\.perplexity\.ai/.test(r.url)));

  /* ═══ ACCEPTANCE 1. RESEARCH EVERY NFL GAME THIS WEEKEND ════════════════ */
  const QA1 = 'Research every available NFL game this weekend, identify the largest verified model-versus-market discrepancies, independently investigate the matchup advantages, and tell me which opportunities survive an adversarial audit.';
  const a1 = await ask(QA1, { dump: 'research_slate' });
  const sl = (a1 && a1.research_slate) || {};
  ok('A1: routed to the slate investigation, deterministic', a1 && a1.quant && a1.quant.intent === 'RESEARCH_SLATE' && modelCalls === 0 && oddsCalls.length === 0, a1 && [a1.quant, modelCalls]);
  ok('A1: only NFL, only this weekend', sl.sport === 'americanfootball_nfl' && sl.window && sl.window.kind === 'weekend' && (sl.games || []).length >= 3 && sl.games.every((g) => g.sport === 'americanfootball_nfl' && Date.parse(g.kickoff) > NOW), sl.games && sl.games.map((g) => [g.matchup, g.kickoff]));
  const gaps = (sl.games || []).filter((g) => g.gap_points != null);
  ok('A1: every game with a model line and a market number shows the discrepancy', gaps.length >= 3 && gaps.every((g) => Math.abs(g.gap_points - Math.round((g.model_line - g.market_line) * 10) / 10) < 1e-9), gaps.map((g) => [g.matchup, g.model_line, g.market_line, g.gap_points]));
  ok('A1: the largest gaps were researched and diagnosed (cause attribution), none called an edge by itself', gaps.filter((g) => g.disagreement).length >= 2 && gaps.filter((g) => g.disagreement).every((g) => typeof g.disagreement.verdict === 'string' && g.disagreement.explanation), gaps.map((g) => [g.matchup, g.disagreement && g.disagreement.verdict]));
  ok('A1: a reference line without a book is never an opportunity', gaps.filter((g) => !g.executable).every((g) => !g.disagreement || g.disagreement.verdict !== 'POTENTIAL_MISPRICING'), gaps.filter((g) => !g.executable).map((g) => [g.matchup, g.disagreement && g.disagreement.verdict]));
  ok('A1: the priced NFL candidates went through research and the audit; Bills -2.5 survives, the Texans do not', sl.survivors === 1 && (sl.investigated || []).some((r) => r.candidate.selection === 'Buffalo Bills' && r.classification.classification === 'VERIFIED_CANDIDATE') && (sl.investigated || []).some((r) => r.candidate.selection === 'Houston Texans' && r.classification.classification !== 'VERIFIED_CANDIDATE'), (sl.investigated || []).map((r) => [r.candidate.selection, r.classification && r.classification.classification]));
  ok('A1: the answer names the survivor and lists the discrepancies, the candidates and the sources', /Survived the audit: Buffalo Bills -2\.5/.test(a1.answer) && /Largest model-versus-market discrepancies/.test(a1.answer) && /CANDIDATE 1 — VERIFIED CANDIDATE/.test(a1.answer) && /^Sources:/m.test(a1.answer), a1.answer.slice(0, 900));
  ok('A1: no MLB or college candidate leaks into an NFL question', (sl.investigated || []).every((r) => r.candidate.sport === 'americanfootball_nfl'), (sl.investigated || []).map((r) => r.candidate.sport));
  const billsRow = (sl.investigated || []).find((r) => r.candidate.selection === 'Buffalo Bills');
  /* THE EVIDENCE LEDGER on every row: the captured price and the projection as typed, dated records */
  const bEv = billsRow && billsRow.evidence;
  const bMq = bEv && bEv.records.find((r) => r.type === 'MARKET_QUOTE'), bMe = bEv && bEv.records.find((r) => r.type === 'MODEL_ESTIMATE');
  ok('EVIDENCE: the Bills row carries a ledger; every record has a source (URL or dataset id), a retrieval time, a type, a verification and a freshness', bEv && bEv.schema === 'edgedesk_evidence_v1' && bEv.records.length >= 2 && bEv.records.every((r) => (r.source.url || r.source.dataset_id) && r.retrieved_at && r.type && r.verification && r.freshness && r.freshness.status), bEv && bEv.records.map((r) => [r.type, r.verification, r.source.url || r.source.dataset_id]));
  ok('EVIDENCE: the captured price is a VERIFIED MARKET_QUOTE with its signal dataset id and its capture time', bMq && bMq.verification === 'VERIFIED' && /^edgedesk:\/\/supabase\/signals\//.test(bMq.source.dataset_id) && bMq.retrieved_at === new Date(billsRow.candidate.quote.captured_at).toISOString() && /Buffalo Bills -2\.5/.test(bMq.claim), bMq);
  ok('EVIDENCE: the projection is a MODEL_ESTIMATE (never a fact) naming the slate it came from', bMe && /^edgedesk:\/\/football\/nfl\/slate\.json#games\/nfl-fx-det-buf/.test(bMe.source.dataset_id) && bMe.value > 0 && bMe.value < 1 && bMe.source.reliability === 'MODEL', bMe);
  ok('EVIDENCE: the summary counts match the records, and the sources list every record\'s source once', bEv && bEv.summary.total >= bEv.records.length && Object.values(bEv.summary.by_type).reduce((a, b) => a + b, 0) === bEv.summary.total && bEv.sources.length >= 2 && new Set(bEv.sources.map((x) => x.url || x.dataset_id)).size === bEv.sources.length, bEv && bEv.summary);
  ok('CALC A1: the slate is verified the same way: every number in the answer traces to a calculation or the research cost', a1 && a1.quant_verification && a1.quant_verification.verdict === 'VERIFIED' && a1.quant_verification.numbers.verdict === 'PASS' && a1.quant_verification.numbers.checked >= 10, a1 && a1.quant_verification);
  ok('CALC A1: each game with a projection carries its line discrepancy; a reference line is never a price (market comparison unavailable, no implied probability)', (sl.games || []).filter((g) => g.model_line != null && g.market_line != null).every((g) => g.calc && recC(g.calc, 'LINE_DISCREPANCY').status === 'COMPUTED' && (g.executable || (g.calc.market_comparison.status === 'UNAVAILABLE' && !recC(g.calc, 'IMPLIED_PROBABILITY')))), (sl.games || []).map((g) => [g.matchup, g.executable, g.calc && g.calc.market_comparison.status]));
  ok('A1: the slate and the scan agree on the Bills to the digit (one engine, one number)', billsRow && best && billsRow.evaluation.net_ev_per_dollar === best.evaluation.net_ev_per_dollar && billsRow.evaluation.maximum_entry_price === best.evaluation.maximum_entry_price, billsRow && [billsRow.evaluation.net_ev_per_dollar, best && best.evaluation.net_ev_per_dollar]);

  const rowsOf = (sc_) => [sc_.best].concat(sc_.verified_rest || [], sc_.potential || [], sc_.near_misses || []).filter(Boolean);
  const notes = (list) => ({ schema: 'edgedesk_desk_notes_v1', notes: list.map((n, i) => Object.assign({ id: 'note_s' + i, recorded_by: 'fixture operator', expires_at: ISO(6 * 24 * H), game_id: null }, n)) });

  /* ═══ S2. NFL: CONFLICTING INJURY REPORTS ════════════════════════════════
     The official report (30 h old) lists Josh Allen OUT; a credible report two hours old says he was a
     full participant and will play; a blog says he "could miss time". Nothing settles the official/credible
     conflict (the credible report is 28 h NEWER), and the speculation is set aside. */
  const s2 = await ask("What's the best bet this weekend across all sports?", {
    metrics: metricsWith({ BUF: { players: [{ name: 'Josh Allen', position: 'QB', status: 'Out', injury: 'Shoulder', practice: 'Did Not Participate In Practice' }], retrieved_at: ISO(-30 * H) } }),
    notes: notes([
      { sport: 'americanfootball_nfl', team: 'BUF', kind: 'availability', player: 'Josh Allen', status: 'ACTIVE', key: true, text: 'Josh Allen was a full participant in Saturday practice and will play Sunday', source: 'ESPN', url: 'https://www.espn.com/nfl/story/_/id/fixture-allen-practice', published_at: ISO(-2 * H), recorded_at: ISO(-90), source_kind: 'NEWS' },
      { sport: 'americanfootball_nfl', team: 'BUF', kind: 'availability', player: 'Josh Allen', text: 'Sources say Josh Allen could miss time with the shoulder', source: 'a betting blog', url: 'https://bettingblog.example/allen-rumor', published_at: ISO(-60), recorded_at: ISO(-50), source_kind: 'BLOG' },
    ]) });
  const s2rows = rowsOf(s2.scan || {});
  const s2b = s2rows.find((r) => r.candidate.selection === 'Buffalo Bills');
  const s2c = s2b && (s2b.research.conflicts || []).find((c) => /Josh Allen/.test(c.subject || ''));
  ok('S2: the Allen conflict is found, with both sources, and left UNRESOLVED (the credible report is 28 h newer than the official one)', s2c && s2c.unresolved === true && /hours newer/.test(s2c.why_unresolved || '') && s2c.sources.some((u) => /nflverse/.test(u)) && s2c.sources.some((u) => /espn\.com/.test(u)), s2b && s2b.research.conflicts);
  const s2spec = s2b && s2b.research.findings.find((f) => /bettingblog/.test(f.source_url));
  ok('S2: the blog\'s "sources say … could miss" is SPECULATION, never verified', s2spec && s2spec.reliability === 'SPECULATION' && s2spec.verified === false, s2spec);
  const s2ev = s2b && s2b.evidence;
  ok('EVIDENCE S2: both sides of the Allen conflict are CONTRADICTED records, named in the summary', s2ev && s2ev.records.filter((r) => r.subject.player === 'Josh Allen' && r.verification === 'CONTRADICTED').length === 2 && s2ev.summary.contradicted.length >= 2 && s2ev.records.filter((r) => r.verification === 'CONTRADICTED').every((r) => r.conflicts.length && r.conflicts[0].resolved === false), s2ev && s2ev.records.map((r) => [r.subject.player, r.type, r.verification]));
  ok('EVIDENCE S2: the blog is a HYPOTHESIS, UNVERIFIED; the 30-hour-old official report is still FRESH six days out (72 h window), so the conflict, not its age, is the problem', s2ev && s2ev.records.some((r) => /bettingblog/.test(r.source.url || '') && r.type === 'HYPOTHESIS' && r.verification === 'UNVERIFIED') && s2ev.records.some((r) => /nflverse/.test(r.source.url || '') && r.subject.player === 'Josh Allen' && r.freshness.status === 'FRESH' && r.freshness.ttl_min === 72 * 60), s2ev && s2ev.records.map((r) => [r.source.url, r.type, r.verification, r.freshness.status]));
  const s2ch = s2b && s2b.challenge, s2q1 = s2ch && s2ch.questions.find((x) => x.id === 'Q1_CONTRADICTIONS');
  ok('CHALLENGE S2: the unresolved Josh Allen conflict is Q1, CRITICAL (a key player), settleable by research; the class is RESEARCH REQUIRED and confidence INSUFFICIENT', s2q1 && s2q1.status === 'UNRESOLVED' && s2q1.severity === 'CRITICAL' && s2q1.resolvable_by_research && /Josh Allen/.test(s2q1.answer) && s2b.classification.classification === 'RESEARCH_REQUIRED' && s2ch.confidence.after === 'INSUFFICIENT', s2ch && [s2q1, s2b.classification.classification, s2ch.outcome, s2ch.confidence]);
  ok('S2: the Bills are not a verified candidate while the reports conflict', s2b && s2b.classification.classification !== 'VERIFIED_CANDIDATE' && s2.scan.final_status !== 'VERIFIED CANDIDATE', s2b && [s2b.classification, s2b.audit.status, s2b.audit.reason]);
  ok('S2: the answer never states the speculative report as fact', !/could miss time/.test(s2.answer.replace(/^\[\d+\].*$/gm, '')), null);

  /* ═══ S3. COLLEGE FOOTBALL: A LARGE MODEL-VERSUS-MARKET DISCREPANCY ═══════
     The engine's line for North Texas @ Texas State is moved to Texas State -9.5 against a market of North
     Texas -2.5: a 12-point gap. A gap that size is a suspected data fault first, never an edge. */
  const cfbGame = fx.slate.games.find((g) => String(g.game_id) === '401858900');
  const cfbSaved = cfbGame.model_home_line;
  cfbGame.model_home_line = -9.5; cfbGame.model_home_margin = 9.5; cfbGame.kickoff = ISO(5 * 24 * H);
  const CFB_SIG = fx.signal({ commence_time: cfbGame.kickoff, last_seen_at: ISO(-4), first_seen_at: ISO(-300), flagged_at: ISO(-20) });
  const s3 = await ask('Research every college football game this weekend and tell me which opportunities survive an adversarial audit.', { signals: [CFB_SIG], noMlb: true });
  const s3sl = (s3 && s3.research_slate) || {};
  const s3g = (s3sl.games || []).find((g) => /Texas State/.test(g.matchup));
  ok('S3: the college slate shows the 12-point discrepancy', s3g && Math.abs(Math.abs(s3g.gap_points) - 12) < 1e-9, s3sl.games && s3sl.games.map((g) => [g.matchup, g.gap_points]));
  ok('S3: …diagnosed as a suspected data fault, not evidence of value', s3g && s3g.disagreement && s3g.disagreement.verdict === 'DATA_FAULT' && s3g.disagreement.is_edge_evidence === false, s3g && s3g.disagreement);
  ok('S3: nothing on that game survives the audit', !(s3sl.investigated || []).some((r) => /Texas/.test(r.candidate.matchup) && r.classification && r.classification.classification === 'VERIFIED_CANDIDATE') && s3sl.survivors === 0, (s3sl.investigated || []).map((r) => [r.candidate.selection, r.classification && r.classification.classification, r.audit.status]));
  ok('S3: the answer says so in words', /suspected data fault/.test(s3.answer) && /none survived/.test(s3.answer), s3.answer.slice(0, 700));
  cfbGame.model_home_line = cfbSaved; cfbGame.model_home_margin = -cfbSaved;

  /* ═══ S4. MLB: THE STARTING PITCHER CHANGED ═════════════════════════════
     EdgeDesk's card lists Shane Baz for the Rays; MLB.com reports 30 minutes ago (after the quote was captured,
     an hour ago) that Taj Bradley starts. The Rays price is held for research, and the strategist says the
     price may not reflect the news. */
  const raysEarly = Object.assign({}, RAYS_ML, { last_seen_at: ISO(-60) }), cleEarly = Object.assign({}, CLE_ML, { last_seen_at: ISO(-60) });
  const s4 = await ask("What's the best bet this weekend across all sports?", { signals: [raysEarly, cleEarly], bookAt: ISO(-58),
    notes: notes([{ sport: 'baseball_mlb', team: 'Tampa Bay Rays', kind: 'starting_pitcher', player: 'Taj Bradley', status: 'STARTING', text: 'Taj Bradley will start Saturday for the Rays; Shane Baz was scratched with forearm tightness', source: 'MLB.com', url: 'https://www.mlb.com/news/fixture-rays-starter', published_at: ISO(-30), recorded_at: ISO(-25), source_kind: 'OFFICIAL' }]) });
  const s4r = rowsOf(s4.scan || {}).find((r) => r.candidate.selection === 'Tampa Bay Rays');
  ok('S4: the Rays are held: RESEARCH REQUIRED, because the card\'s starter is not the one MLB.com lists', s4r && s4r.classification.classification === 'RESEARCH_REQUIRED' && /Shane Baz.*Taj Bradley|Taj Bradley.*Shane Baz/.test(s4r.classification.reasons[0] || ''), s4r && s4r.classification);
  ok('S4: the starter change is a verified official finding, linked to the model input it contradicts', s4r && s4r.research.gaps.some((g) => g.kind === 'STARTER_MISMATCH' && g.player === 'Taj Bradley') && s4r.research.findings.some((f) => /mlb\.com\/news/.test(f.source_url) && f.verified && f.reliability === 'OFFICIAL'), s4r && s4r.research.gaps);
  ok('S4: the strategist warns the price predates the news', s4r && s4r.research.strategist.checks.some((c) => c.id === 'PRICED_IN' && c.result === 'WARN' && /after the quote was captured/.test(c.detail)), s4r && s4r.research.strategist.checks.find((c) => c.id === 'PRICED_IN'));
  ok('S4: no model scenario exists for an MLB starter, so no number was moved', s4r && (s4r.research.adjustments || []).length === 0 && s4r.research.fair_kind === 'SHARP_NO_VIG', s4r && s4r.research.adjustments);
  ok('S4: the answer is not a verified candidate and names the starter change', s4.scan.final_status !== 'VERIFIED CANDIDATE' && /Taj Bradley/.test(s4.answer), s4.answer.slice(0, 500));

  /* ═══ S5. A CONTRACT: POSITIVE BEFORE FEES, NEGATIVE AFTER ══════════════ */
  const s5 = await ask('Is Guardians at 52¢ on Kalshi a good price?', { signals: MLB_SIGNALS });
  const s5e = s5 && s5.contract && s5.contract.evaluation;
  ok('S5: Guardians YES at 52¢ against a 53.45% fair: gross +1.45¢, Kalshi fee 2¢, net −0.55¢', s5e && s5e.gross_expected_value === '0.0145' && s5e.expected_fees.per_contract === '0.02' && s5e.net_expected_value === '-0.0055', s5e && [s5e.gross_expected_value, s5e.expected_fees, s5e.net_expected_value]);
  ok('S5: …so it is a PASS: a positive gross edge is not a positive expected value after fees', s5e && s5e.decision === 'PASS' && /PASS/.test(s5.answer) && !/positive EV\b(?! before)/i.test(s5.answer.split('\n')[0]), s5 && [s5e && s5e.decision, s5.answer.split('\n').slice(0, 3)]);
  ok('S5: the fee is Kalshi\'s own formula, labelled unverified, not a sportsbook rule applied to an exchange', s5e && s5e.venue.key === 'kalshi' && /KALSHI/i.test(JSON.stringify(s5e.expected_fees)) && s5e.expected_fees.status !== 'VERIFIED', s5e && s5e.expected_fees);

  /* ═══ S6. A HEAVILY JUICED ALTERNATE SPREAD ═════════════════════════════
     Bills -1.5 at -150: the side is likelier to win than the main line, and that is exactly the trap. */
  const ALT = nfl({ sig_key: 'ev-det-buf|spreads|Buffalo Bills|-1.5', event_id: 'ev-det-buf', selection: 'Buffalo Bills', point: -1.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.667, best_book: 'DraftKings', sharp_fair: 0.585, sharp_book_fair: 0.585, consensus_fair: 0.583, pin_dec: 1.62, pin_opp_dec: 2.3, edge: -0.025, first_edge: -0.025, corrob_n: 3, last_seen_at: ISO(-10) });
  const s6 = await ask("What's the best bet this weekend across all sports?", { signals: MLB_SIGNALS.concat(NFL_SIGNALS, [ALT]) });
  const s6rows = rowsOf(s6.scan || {});
  ok('S6: the juiced alternate (-1.5 at -150) is never offered: below its 60% break-even the likelier winner loses money', !s6rows.some((r) => r.candidate.line === -1.5 && r.classification && r.classification.classification !== 'REJECTED') && !/Buffalo Bills -1\.5/.test((s6.answer.split('\nOther candidates')[0])), s6rows.map((r) => [r.candidate.selection, r.candidate.line, r.classification && r.classification.classification]));
  const altInv = AG.investigate({ candidate: { id: 'alt', market: 'spreads', selection: 'Buffalo Bills', line: -1.5, quote: { captured_at: ISO(-10) } }, event: { id: 'g', sport: 'americanfootball_nfl', home: 'Buffalo Bills', away: 'Detroit Lions', kickoff: SUNDAY }, raw: [],
    model: { available: true, prices: true, tier: 'VALIDATED', probability: 0.575, label: 'EdgeDesk model' }, market: { decimal: 1.667, book: 'DraftKings', captured_at: ISO(-10), sharp_fair: 0.585, kickoff: SUNDAY },
    audit: { status: 'CONFIRMED', reason: 'fixture', checks: [] }, settlement: { verified: true }, quality: { flags: [], checked: true }, now: NOW, ttl_min: 90, conservative: true });
  ok('S6: the chain on the alternate: a 57.5% winner at -150 (60% break-even) is REJECTED on negative EV, whatever the win rate', altInv.classification.classification === 'REJECTED' && Number(altInv.quant.evaluation.net_ev_per_dollar) < 0 && Number(altInv.quant.evaluation.break_even_probability) > 0.59, [altInv.classification, altInv.quant.evaluation.net_ev_per_dollar, altInv.quant.evaluation.break_even_probability]);

  /* ═══ S7. TWO SOURCES DISAGREE ON AVAILABILITY ══════════════════════════
     Two credible outlets an hour apart: Jared Goff ruled out / Jared Goff will play. Same standing, close
     together: nothing settles it, so the price waits — and the model's QB-out scenario is NOT applied. */
  const s7 = await ask("What's the best bet this weekend across all sports?", {
    notes: notes([
      { sport: 'americanfootball_nfl', team: 'DET', kind: 'availability', player: 'Jared Goff', status: 'OUT', key: true, text: 'Jared Goff has been ruled out for Sunday with a hand injury', source: 'NFL Network via NBC Sports', url: 'https://www.nbcsports.com/nfl/news/fixture-goff-out', published_at: ISO(-3 * H), recorded_at: ISO(-170), source_kind: 'NEWS' },
      { sport: 'americanfootball_nfl', team: 'DET', kind: 'availability', player: 'Jared Goff', status: 'ACTIVE', key: true, text: 'Jared Goff will play Sunday, the coach said after practice', source: 'The Athletic', url: 'https://www.theathletic.com/fixture-goff-plays', published_at: ISO(-2 * H), recorded_at: ISO(-110), source_kind: 'NEWS' },
    ]) });
  const s7b = rowsOf(s7.scan || {}).find((r) => r.candidate.selection === 'Buffalo Bills');
  ok('S7: same standing, an hour apart: the Goff reports are an UNRESOLVED conflict', s7b && (s7b.research.conflicts || []).some((c) => /Goff/.test(c.subject) && c.unresolved), s7b && s7b.research.conflicts);
  ok('S7: …so the Bills are RESEARCH REQUIRED, and the reason says the sources disagree', s7b && s7b.classification.classification === 'RESEARCH_REQUIRED' && /sources disagree/.test(s7b.classification.reasons[0]), s7b && s7b.classification);
  ok('S7: the model\'s away-QB-out scenario was NOT applied on an unconfirmed report', s7b && (s7b.research.adjustments || []).length === 0, s7b && s7b.research.adjustments);

  /* ═══ S8. STALE ODDS ═════════════════════════════════════════════════════ */
  const stale = MLB_SIGNALS.concat(NFL_SIGNALS).map((x) => Object.assign({}, x, { last_seen_at: ISO(-400) }));
  const s8 = await ask("What's the best bet this weekend across all sports?", { signals: stale, bookAt: ISO(-400) });
  ok('S8: with every price 6 h old nothing is verified, and no capture was asked for (no odds credits spent)', s8 && s8.scan.final_status !== 'VERIFIED CANDIDATE' && /^No verified positive-EV trade/.test(s8.answer) && oddsCalls.length === 0, s8 && [s8.scan.final_status, s8.answer.slice(0, 160)]);
  ok('S8: any candidate that was looked at carries the staleness in its verdict', rowsOf(s8.scan).every((r) => !r.classification || r.classification.classification !== 'VERIFIED_CANDIDATE'), rowsOf(s8.scan).map((r) => [r.candidate.selection, r.classification && r.classification.classification]));

  /* ═══ S8b. THE AUDITOR REJECTS WHAT THE RESEARCHER FAVOURED ════════════
     The research on the Bills is clean (official report, depth chart, no conflict, no gap) — but the audit's
     fresh read finds the price has moved to 1.87, below the floor. */
  const s8b = await ask("What's the best bet this weekend across all sports?", { fresh: { 'ev-det-buf|spreads|Buffalo Bills|-2.5': { best_dec: 1.87, last_seen_at: ISO(-1) } } });
  const s8bb = rowsOf(s8b.scan || {}).find((r) => r.candidate.selection === 'Buffalo Bills');
  ok('S8b: the research is clean: findings, no conflict, no model gap', s8bb && s8bb.research.findings.length > 5 && !s8bb.research.conflicts.length && !s8bb.research.gaps.length, s8bb && [s8bb.research.findings.length, s8bb.research.conflicts, s8bb.research.gaps]);
  ok('S8b: …and the auditor still refuses it: the fresh price no longer clears', s8bb && s8bb.classification.classification !== 'VERIFIED_CANDIDATE' && s8b.scan.final_status !== 'VERIFIED CANDIDATE', s8bb && [s8bb.audit.status, s8bb.audit.reason, s8bb.classification]);

  /* ═══ S9. NO INDEPENDENT MODEL ═══════════════════════════════════════════ */
  const s9 = await ask("What's the best bet this weekend across all sports?", { signals: MLB_SIGNALS });
  const s9r = rowsOf(s9.scan || {}).find((r) => r.candidate.selection === 'Tampa Bay Rays');
  ok('S9: MLB has no independent model on the desk: no model probability is invented', s9r && s9r.research.independent_fair_probability === null && s9r.research.model_view === null && s9r.research.fair_kind === 'SHARP_NO_VIG', s9r && [s9r.research.independent_fair_probability, s9r.research.model_view, s9r.research.fair_kind]);
  ok('S9: the answer says why, and claims no model-versus-market disagreement', /Independent fair probability: unavailable — the MLB model runs in the browser only/.test(s9.answer) && /Why the model disagrees with the market: EdgeDesk has no independent model/.test(s9.answer), [field(s9.answer, 'Independent fair probability'), field(s9.answer, 'Why the model disagrees with the market')]);
  ok('S9: the disagreement engine returns NO_MODEL, never POTENTIAL_MISPRICING', s9r && s9r.research.disagreement.verdict === 'NO_MODEL' && !s9r.research.disagreement.is_edge_evidence, s9r && s9r.research.disagreement);

  /* ═══ S10. EVERY CANDIDATE REJECTED ═════════════════════════════════════ */
  const bad = NFL_SIGNALS.map((x) => Object.assign({}, x, { best_dec: 1.8, edge: -0.04, first_edge: -0.04 }));
  const s10 = await ask("What's the best bet this weekend across all sports?", { signals: bad, noMlb: true });
  ok('S10: nothing clears: "No verified positive-EV trade…", final status PASS, no candidate block', s10 && /^No verified positive-EV trade/.test(s10.answer) && s10.scan.final_status === 'PASS' && !/^Final status:/m.test(s10.answer), s10 && [s10.scan.final_status, s10.answer.slice(0, 300)]);
  ok('S10: research stayed at L1: nothing on the board was worth investigating, so nothing was bought', s10.scan.research_summary && s10.scan.research_summary.level === 'L1' && s10.scan.research_summary.cost_estimate_usd === 0, s10.scan.research_summary);
  ok('S10: no prediction snapshot is written for a slate with no candidate', !posted.some((p) => p.table === 'prediction_snapshots'), posted.map((p) => p.table));
  const s10s = await ask('Research every available NFL game this weekend and tell me which opportunities survive an adversarial audit.', { signals: bad, noMlb: true });
  ok('S10: the slate investigation says none survived, and still lists the discrepancies', s10s && s10s.research_slate.survivors === 0 && /none survived/.test(s10s.answer) && /Largest model-versus-market discrepancies/.test(s10s.answer), s10s && s10s.answer.slice(0, 400));

  /* ═══ S11 + ACCEPTANCE 2. A CSV WHOSE PARLAY LEGS REPEAT THE TICKET ════════ */
  const CSV = fs.readFileSync(path.join(ROOT, 'tools', 'portfolio', 'fixtures', 'juice_reel_style.csv'), 'utf8');
  const csvA = BETS.analyze(BETS.fromCSV(CSV, { timezone: 'America/New_York' }), { tz: 'America/New_York' });
  const naiveStake = CSV.trim().split('\n').slice(1).map((l) => Number(l.split(',')[11]) || 0).reduce((a, b) => a + b, 0);
  ok('S11: 22 leg rows are 14 tickets with 21 legs; a parlay\'s stake is counted once', csvA.counts.tickets === 14 && csvA.counts.legs === 21 && csvA.totals.risked === '605.00' && naiveStake !== 605, [csvA.counts, csvA.totals.risked, naiveStake]);
  ok('S11: realized P&L −$183.55; singles −$210.00, parlays +$26.45', csvA.totals.pnl === '-183.55' && csvA.singles.pnl === '-210.00' && csvA.parlays.pnl === '26.45', [csvA.totals.pnl, csvA.singles.pnl, csvA.parlays.pnl]);
  /* the same file, imported: one stored position per ticket (the importer's staged rows), read back by the desk */
  const IMP = globalThis.EDPortfolioImport;
  const staged = IMP.stage(CSV, { adapter: 'leg_rows_sportsbook_v1', timezone: 'America/New_York' });
  const positions = staged.rows.filter((r) => r.normalized && !(r.issues || []).some((i) => i.code === 'TICKET_FIELDS_DIFFER')).map((r, i) => Object.assign({ id: 'pos-' + (i + 1) }, r.normalized, { stake: r.normalized.stake != null ? String(r.normalized.stake) : null }));
  let positionReads = [];
  const QA2 = 'Why did I lose money on my recent bets, and were my singles or parlays more profitable?';
  const a2 = await ask(QA2, { dump: 'bets', positions: (u, init) => { positionReads.push({ u, auth: init && init.headers && init.headers.authorization }); return /status=eq\.OPEN/.test(u) ? positions.filter((p) => p.status === 'OPEN') : positions.filter((p) => p.status !== 'OPEN'); } });
  ok('A2: routed to the betting-history answer, deterministic, no model call', a2 && a2.quant && a2.quant.intent === 'BETS' && modelCalls === 0 && a2.bets && a2.bets.available, a2 && [a2.quant, a2.bets && a2.bets.why]);
  ok('A2: only the caller\'s own positions were read, under the caller\'s token', positionReads.length === 2 && positionReads.every((r) => r.auth === 'Bearer ' + USER_JWT) && reads.filter((r) => /portfolio_positions/.test(r.url)).every((r) => r.auth === 'Bearer ' + USER_JWT), positionReads.map((r) => r.auth));
  ok('A2: nothing about the bets was written anywhere', posted.length === 0, posted.map((p) => p.table));
  ok('A2: the stored positions give exactly the CSV\'s figures (one engine, one number)', a2.bets.totals.pnl === csvA.totals.pnl && a2.bets.totals.risked === csvA.totals.risked && a2.bets.singles.pnl === csvA.singles.pnl && a2.bets.parlays.pnl === csvA.parlays.pnl, a2.bets && [a2.bets.totals, csvA.totals.pnl]);
  ok('A2: the answer explains the loss and compares singles with parlays, with the exact figures', /You lost \$183\.55/.test(a2.answer) && /Parlays were more profitable per dollar risked than singles/.test(a2.answer) && /small sample|weak evidence/.test(a2.answer), a2.answer.slice(0, 700));
  ok('A2: the juiced alternate lines and the worst day are named', /Alternate lines|alternate lines/.test(a2.answer) && /Worst day: 2026-09-20/.test(a2.answer), a2.answer);
  ok('A2: past only — no prediction, no "bet more to win it back"', /describe your past results only; they do not predict future results/.test(a2.answer) && a2.bets.language.ok === true && !/\b(chase|win it back|recover (your|the) loss|increase (your )?stake|bet more)\b/i.test(a2.answer), a2.bets.language);
  ok('A2: per-ticket lists stay on the Portfolio page; the response carries the summary only', !JSON.stringify(a2.bets).includes('"tickets":['), Object.keys(a2.bets));
  const a2none = await ask(QA2, { positions: () => [] });
  ok('A2: with no recorded bets the answer says so and invents nothing', a2none && /no bets recorded/.test(a2none.answer) && !/\$\d/.test(a2none.answer), a2none && a2none.answer);

  /* ═══ S12. A RESEARCH SOURCE FAILS; THE BASIC ANALYSIS SURVIVES ══════════ */
  const failLive = (u) => /nflverse-data\/releases\/download\/injuries\//.test(u);
  const s12 = await ask("What's the best bet this weekend across all sports?", { fail: failLive });
  const s12b = rowsOf(s12.scan || {}).find((r) => r.candidate.selection === 'Buffalo Bills');
  ok('S12: the live injury feed is down, and the scan still answers with the audited, priced candidate', s12b && s12b.evaluation && s12b.evaluation.ok && s12b.audit && s12b.classification, s12b && [s12b.audit && s12b.audit.status, s12b.classification]);
  ok('S12: the failure is reported, and the committed report was used instead', (s12.scan.research_summary.unavailable || []).some((u) => /live nflverse injury feed/.test(u) && /committed report was used/.test(u)) && /live nflverse injury feed/.test(s12.answer), s12.scan.research_summary.unavailable);
  /* the breaker: the same failure on the next turns opens the circuit, so the feed is not hammered */
  let liveHits = 0;
  for (let i = 0; i < 4; i++) { await ask("What's the best bet this weekend across all sports?", { fail: (u) => { if (failLive(u)) { liveHits++; return true; } return false; }, keepLedger: true }); }
  ok('S12: after repeated failures the circuit breaker stops calling the feed (≤ 2 more attempts in 4 turns)', liveHits <= 2, liveHits);
  const s12m = await ask("What's the best bet this weekend across all sports?", { opts: { metrics: null } });
  const s12mb = rowsOf(s12m.scan || {}).find((r) => r.candidate.selection === 'Buffalo Bills');
  ok('S12: with the injury build itself down, the price check still runs and the candidate is held, not dropped', s12mb && s12mb.evaluation && s12mb.evaluation.ok && s12mb.classification.classification !== 'VERIFIED_CANDIDATE', s12mb && [s12mb.classification, s12mb.audit.status]);

  /* ═══ THE COMMUNICATOR: IT MAY NOT INVENT OR CHANGE A VALUE ═══════════════ */
  const det = s1.answer;
  const head = det.slice(0, det.indexOf('\nResearch: '));
  const g1 = best.research ? null : null;
  const graphLike = { sourceUrls: () => allFindings.map((f) => f.source_url) };
  ok('C: the deterministic answer passes its own critic', AG.critic(head, head, graphLike).verdict === 'PASS', AG.critic(head, head, graphLike));
  const changed = head.replace('3.74% per $1', '4.74% per $1');
  ok('C: a changed EV is caught', AG.critic(changed, head, graphLike).findings.some((f) => f.code === 'DROPPED_OR_CHANGED' || f.code === 'UNLISTED_NUMBER'), AG.critic(changed, head, graphLike));
  ok('C: an invented probability is caught', AG.critic(head + '\nI make the Bills a 61.3% chance.', head, graphLike).findings.some((f) => f.code === 'UNLISTED_NUMBER'), null);
  ok('C: certainty language is caught', AG.critic(head + '\nThis is a lock.', head, graphLike).findings.some((f) => f.code === 'CERTAINTY'), null);
  ok('C: a changed final status is caught', AG.critic(head.replace('Final status: VERIFIED CANDIDATE', 'Final status: WATCHLIST'), head, graphLike).findings.some((f) => f.code === 'STATUS_CHANGED'), null);
  ok('C: a fabricated citation is caught', AG.critic(head + '\nSee https://www.espn.com/made-up-story', head, graphLike).findings.some((f) => f.code === 'UNKNOWN_LINK'), null);
  ok('C: an injury the result never mentioned is caught', AG.critic(head + '\nJames Cook was ruled out this morning.', head, graphLike).verdict === 'FAIL', AG.critic(head + '\nJames Cook was ruled out this morning.', head, graphLike));

  /* the optional model communicator, switched on in a second instance of the function (paid narration authorised) */
  ENV.EDGEDESK_RESEARCH_PAID_OK = '1';
  const { pathToFileURL } = require('url');
  const mN = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?narrate=1');
  ENV.EDGEDESK_RESEARCH_PAID_OK = '0';
  const faithful = (req) => { const h = req.messages[0].content; return h.replace('Why: ', 'In short: ').replace('BEST VERIFIED RESEARCH CANDIDATE', 'BEST VERIFIED RESEARCH CANDIDATE — the read'); };
  const n1 = await ask("What's the best bet this weekend across all sports?", { mod: mN, modelReply: faithful });
  ok('N: a faithful rewrite passes the critic and is served, with the sources appended verbatim', n1 && n1.narration.prose === 'MODEL' && modelCalls === 1 && /In short: /.test(n1.answer) && /^Sources:/m.test(n1.answer) && n1.deterministic_answer && n1.deterministic_answer.indexOf('Why: ') > 0, n1 && [n1.narration, modelCalls]);
  const n2 = await ask("What's the best bet this weekend across all sports?", { mod: mN, modelReply: (req) => req.messages[0].content.replace('3.74% per $1', '5.10% per $1') });
  ok('N: a rewrite that changes the EV is rejected and the deterministic answer is served', n2 && n2.narration.prose === 'REJECTED_BY_CRITIC' && /Estimated net EV: 3\.74% per \$1/.test(n2.answer) && !/5\.10%/.test(n2.answer), n2 && n2.narration);
  const n3 = await ask("What's the best bet this weekend across all sports?", { mod: mN, modelReply: (req) => req.messages[0].content + '\nThe Bills are a guaranteed winner.' });
  ok('N: a rewrite that promises a result is rejected', n3 && n3.narration.prose === 'REJECTED_BY_CRITIC' && !/guaranteed/.test(n3.answer), n3 && n3.narration);
  ok('N: narration is metered: a paid provider in the ledger, with its cost estimate', n3 && n3.narration.metered && n3.narration.metered.provider === 'anthropic_narration' && n3.narration.metered.calls === 1 && n3.narration.metered.cost_estimate_usd > 0, n3 && n3.narration);
  ok('N: every paid narration call was claimed against the database quota first, and settled, under the caller\'s token', rpcCalls.filter((c) => c.fn === 'research_usage_claim').length === 1 && rpcCalls.some((c) => c.fn === 'research_usage_settle' && c.body.p_claim_id === 41 && c.body.p_state === 'OK') && rpcCalls.every((c) => c.auth === 'Bearer ' + USER_JWT), rpcCalls);
  const n5 = await ask("What's the best bet this weekend across all sports?", { mod: mN, modelReply: faithful, quota: { ok: false, why: 'anthropic_narration is not enabled by the operator' } });
  ok('N: with the provider disabled in the database quota, no model is called and the deterministic answer is served', n5 && modelCalls === 0 && n5.narration.prose === 'DETERMINISTIC' && /not enabled by the operator/.test(n5.narration.error || '') && !n5.deterministic_answer, n5 && [n5.narration, modelCalls]);
  const n4 = await ask("What's the best bet this weekend across all sports?", { mod: mN, modelReply: (req) => req.messages[0].content + '\nThe Bills are a guaranteed winner.' });
  const n4b = await ask("What's the best bet this weekend across all sports?", { mod: mN, modelReply: faithful, keepLedger: true });
  ok('N: the same narration request again is served from the cache (and re-checked by the critic), not bought twice', n4b && modelCalls === 0 && n4b.narration.metered.cached === 1 && n4b.narration.metered.calls === 0 && n4b.narration.prose === 'REJECTED_BY_CRITIC', n4b && [n4b.narration, modelCalls]);

  /* ═══ THE OFF SWITCH: EDGEDESK_RESEARCH=0 gives back the Phase-1 desk exactly ═══ */
  ENV.EDGEDESK_RESEARCH = '0';
  const mOff = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?research=off');
  delete ENV.EDGEDESK_RESEARCH;
  const off = await ask("What's the best bet this weekend across all sports?", { mod: mOff });
  ok('OFF: with the chain switched off the scan answers in the Phase-1 format, priced the same', off && off.scan.researched === false && /^BEST VERIFIED OPPORTUNITY/.test(off.answer) && /Decision: BUY/.test(off.answer) && off.scan.best && off.scan.best.evaluation.net_ev_per_dollar === best.evaluation.net_ev_per_dollar, off && [off.scan.researched, off.answer.split('\n')[0]]);
  ok('OFF: …and writes no research memory', !posted.some((p) => p.table === 'research_findings' || p.table === 'prediction_snapshots'), posted.map((p) => p.table));

  /* ═══ PHASE 4 — EXTERNAL SEARCH SWITCHED ON (Claude web search), AGAINST A CONSTRUCTED FIXTURE ═══
     The response is built from the documented shape (tools/research/fixtures, labelled); this proves the wiring, the
     gates and the evidence path — not a live provider. */
  {
    const SFX = require(path.join(ROOT, 'tools', 'research', 'fixtures', 'claude_web_search_det_buf.json')).response;
    const SFX_ERR = require(path.join(ROOT, 'tools', 'research', 'fixtures', 'claude_web_search_refusal.json')).response;
    const SFX_PAUSE = require(path.join(ROOT, 'tools', 'research', 'fixtures', 'claude_web_search_pause.json')).response;
    /* before switching anything on: the default scan never calls a search provider, and says why */
    searchCalls = [];
    const s0 = await ask("What's the best bet this weekend across all sports?");
    ok('SEARCH OFF: the default build never calls a search provider; the subscriber reads that search is off, the operator detail stays in the report', searchCalls.length === 0 && s0.scan.best && s0.scan.best.search && s0.scan.best.search.status === 'NOT_RUN' && /^external search is off/.test(s0.scan.best.search.why) && !/EDGEDESK_|API key/.test(s0.scan.best.search.why) && /not enabled by the operator/.test(s0.scan.best.search.detail) && !/EDGEDESK_SEARCH_PROVIDERS|API key/.test(s0.answer), s0 && s0.scan.best && s0.scan.best.search);
    ENV.EDGEDESK_SEARCH_PROVIDERS = 'claude_web_search'; ENV.EDGEDESK_RESEARCH_PAID_OK = '1';
    const mS = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?search=claude');
    delete ENV.EDGEDESK_SEARCH_PROVIDERS; ENV.EDGEDESK_RESEARCH_PAID_OK = '0';
    searchCalls = []; searchReply = SFX;
    const s1s = await ask("What's the best bet this weekend across all sports?", { mod: mS });
    const call = searchCalls[0], bS = s1s && s1s.scan && s1s.scan.best;
    ok('SEARCH ON: one search per game, sent server-side with the key in the header — never in the body', searchCalls.length >= 1 && call.headers['x-api-key'] === 'test-key' && !/test-key/.test(JSON.stringify(call.body)) && call.body.tools[0].type === 'web_search_20260209' && JSON.stringify(call.body.tools[0].allowed_callers) === '["direct"]' && call.body.model === 'claude-opus-5-5', searchCalls.map((c) => c.body.messages[0].content.slice(0, 80)));
    ok('SEARCH ON: each real search first claims the persistent quota (research_usage_claim) for its provider and settles it OK', rpcCalls.filter((x) => x.fn === 'research_usage_claim' && x.body.p_provider === 'claude_web_search').length === searchCalls.length && rpcCalls.filter((x) => x.fn === 'research_usage_settle' && x.body.p_state === 'OK').length >= searchCalls.length, rpcCalls.map((x) => x.fn + ':' + JSON.stringify(x.body)));
    ok('SEARCH ON: each real search first claims its dollar estimate (research_cost_claim) and settles it with the actual cost read from usage', costCalls.filter((x) => x.fn === 'research_cost_claim' && x.body.p_provider === 'claude_web_search' && Math.abs(x.body.p_estimate_usd - 0.084) < 1e-9).length === searchCalls.length && costCalls.some((x) => x.fn === 'research_cost_settle' && x.body.p_state === 'SETTLED' && Math.abs(x.body.p_actual_usd - 0.0722) < 1e-9), costCalls.map((x) => x.fn + ':' + JSON.stringify(x.body)));
    ok('SEARCH ON: two candidates on the same game share one search (the ledger\'s cache and single flight)', new Set(searchCalls.map((c) => c.body.messages[0].content.split('\n')[0])).size === searchCalls.length, searchCalls.length);
    const sev = bS && bS.evidence, srec = sev ? sev.records.filter((r) => r.search) : [];
    ok('SEARCH ON: cited quotes reached the evidence ledger as the source\'s own words, with the provider named', srec.length >= 3 && srec.every((r) => r.search.provider === 'claude_web_search' && r.source.url) && srec.some((r) => /full participant in Thursday's practice/.test(r.claim)), srec.map((r) => [r.source.url, r.type, r.verification, r.claim.slice(0, 50)]));
    ok('SEARCH ON: the refused citations (a URL the search never returned, a blog off the allowed list) never became evidence', !sev.records.some((r) => /not-in-results|bettingblog/.test(r.source.url || '')) && bS.search.refused.length === 2, bS && bS.search);
    ok('SEARCH ON: the injected quote is flagged and demoted to an unverified hypothesis', sev.records.some((r) => r.injection && r.injection.flagged && r.type === 'HYPOTHESIS' && r.verification === 'UNVERIFIED'), sev.summary.flagged);
    ok('SEARCH ON: the undated page is UNKNOWN freshness, never fresh', srec.filter((r) => /apnews/.test(r.source.url)).every((r) => r.freshness.status === 'UNKNOWN'));
    ok('SEARCH ON: the row reports the search: provider, status, findings, refusals, uncited sentences, cost from usage', bS.search.provider === 'claude_web_search' && bS.search.status === 'OK' && bS.search.findings === 4 && bS.search.uncited_sentences === 2 && Math.abs(bS.search.cost_usd - 0.0722) < 1e-9 && bS.search.schema_verified === true, bS.search);
    ok('SEARCH ON: the research summary carries the search\'s actual cost, counted once per search', s1s.scan.research_summary && s1s.scan.research_summary.search && Math.abs(s1s.scan.research_summary.search.cost_usd - 0.0722 * new Set(searchCalls.map((c) => c.body.messages[0].content.split('\n')[0])).size) < 1e-6, s1s.scan.research_summary && s1s.scan.research_summary.search);
    ok('SEARCH ON: the Bills still stand on the numbers — the search\'s reports agree with the official feed (no new conflict)', bS.candidate.selection === 'Buffalo Bills' && bS.classification.classification === 'VERIFIED_CANDIDATE' && bS.challenge.outcome === 'STANDS', bS && [bS.classification, bS.challenge && bS.challenge.questions.filter((x) => x.status !== 'CLEAR' && x.status !== 'NOT_APPLICABLE')]);
    ok('SEARCH ON: every number in the answer still traces to a calculation', s1s.quant_verification && s1s.quant_verification.numbers.verdict === 'PASS', s1s.quant_verification && s1s.quant_verification.numbers);
    /* a search report that contradicts the official feed: Allen OUT from ESPN, ACTIVE from the official report → a conflict, the challenge lowers it */
    const CONTRA = JSON.parse(JSON.stringify(SFX));
    CONTRA.content.forEach((b) => (b.citations || []).forEach((c) => { if (/fixture-allen-practice/.test(c.url)) c.cited_text = 'Bills quarterback Josh Allen (shoulder) has been ruled out for Sunday.'; }));
    searchCalls = []; searchReply = CONTRA;
    const s2s = await ask("What's the best bet this weekend across all sports?", { mod: mS });
    const allBills = [s2s.scan.best].concat(s2s.scan.verified_rest || [], s2s.scan.potential || [], s2s.scan.near_misses || []).filter(Boolean).find((r) => r.candidate.selection === 'Buffalo Bills');
    const q4c = allBills && allBills.challenge && allBills.challenge.questions.find((x) => x.id === 'Q4_KEY_PLAYERS');
    ok('SEARCH REPORTS AN ABSENCE: one credible report that the priced quarterback is out is never priced on, but blocks the verdict — RESEARCH REQUIRED, and the challenge calls it critical', allBills && allBills.classification.classification === 'RESEARCH_REQUIRED' && /Josh Allen .*reported out by espn\.com/.test(allBills.classification.reasons[0]) && q4c && q4c.status === 'UNRESOLVED' && q4c.severity === 'CRITICAL' && Number(allBills.evaluation.net_ev_per_dollar) === Number(bS.evaluation.net_ev_per_dollar), allBills && [allBills.classification, q4c, allBills.evaluation.net_ev_per_dollar]);
    /* failures never take the basic analysis with them */
    searchCalls = []; searchReply = { __status: 529 };
    const s3s = await ask("What's the best bet this weekend across all sports?", { mod: mS });
    ok('SEARCH FAILS: an HTTP error is reported as FAILED; the scan still answers on EdgeDesk\'s own sources', s3s && s3s.scan && s3s.scan.best && s3s.scan.best.search.status === 'FAILED' && /HTTP 529/.test(s3s.scan.best.search.why) && s3s.scan.best.classification.classification === 'VERIFIED_CANDIDATE', s3s && s3s.scan && s3s.scan.best && s3s.scan.best.search);
    searchCalls = []; searchReply = SFX;
    const s3q = await ask("What's the best bet this weekend across all sports?", { mod: mS, quota: { ok: false, why: 'claude_web_search is not enabled by the operator' } });
    ok('SEARCH QUOTA: when the database quota refuses, no search request is sent, the refusal is reported (not cached, not a breaker failure), and the scan answers', searchCalls.length === 0 && s3q.scan.best.search.status === 'QUOTA_REFUSED' && /not enabled by the operator/.test(s3q.scan.best.search.why) && s3q.scan.best.classification.classification === 'VERIFIED_CANDIDATE', s3q.scan.best.search);
    searchCalls = []; searchReply = SFX;
    const s3b = await ask("What's the best bet this weekend across all sports?", { mod: mS, cost: { ok: false, why: 'your research budget for today ($1.00) would be exceeded' } });
    ok('SEARCH BUDGET: when the dollar budget refuses, no search is sent and no call quota is claimed; the refusal is reported and the scan answers', searchCalls.length === 0 && !rpcCalls.some((x) => x.fn === 'research_usage_claim') && s3b.scan.best.search.status === 'BUDGET_REFUSED' && /research budget for today/.test(s3b.scan.best.search.why) && s3b.scan.best.classification.classification === 'VERIFIED_CANDIDATE', [searchCalls.length, s3b.scan.best.search]);
    const s3c = await ask("What's the best bet this weekend across all sports?", { mod: mS, quota: { ok: false, why: 'claude_web_search daily limit (300) reached' } });
    ok('SEARCH QUOTA after BUDGET: a quota refusal releases the dollar claim it already holds', costCalls.some((x) => x.fn === 'research_cost_settle' && x.body.p_state === 'RELEASED') && s3c.scan.best.search.status === 'QUOTA_REFUSED', costCalls.map((x) => x.fn + ':' + x.body.p_state));
    searchCalls = []; searchReply = SFX_ERR;
    const s4s = await ask("What's the best bet this weekend across all sports?", { mod: mS });
    ok('SEARCH REFUSED: a refusal is reported, adds no evidence, and the scan answers', s4s.scan.best.search.status === 'REFUSED' && !s4s.scan.best.evidence.records.some((r) => r.search), s4s.scan.best.search);
    searchCalls = []; searchReply = (body, n) => n === 1 ? SFX_PAUSE : SFX;
    const s5s = await ask("What's the best bet this weekend across all sports?", { mod: mS });
    const rows5 = [s5s.scan.best].concat(s5s.scan.verified_rest || [], s5s.scan.potential || [], s5s.scan.near_misses || []).filter(Boolean);
    const resumed = rows5.find((r) => r.search && r.search.status === 'OK' && r.search.cost_usd > 0.0722 + 1e-9);
    ok('SEARCH PAUSED: a paused turn is resumed once — the second call is the original message plus the paused assistant turn, unchanged — and both calls are costed', searchCalls.length >= 2 && searchCalls[1].body.messages.length === 2 && searchCalls[1].body.messages[1].role === 'assistant' && JSON.stringify(searchCalls[1].body.messages[1].content) === JSON.stringify(SFX_PAUSE.content) && searchCalls.filter((c) => c.body.messages.length === 2).length === 1 && resumed && Math.abs(resumed.search.cost_usd - (2100 * 4 / 1e6 + 30 * 20 / 1e6 + 0.01 + 0.0722)) < 1e-9, [searchCalls.length, rows5.map((r) => r.search)]);
    /* the breaker: three failures open it; the next call is refused without a request */
    searchCalls = []; searchReply = { __status: 500 };
    await ask("What's the best bet this weekend across all sports?", { mod: mS });
    await ask("What's the best bet this weekend across all sports?", { mod: mS, keepLedger: true });
    await ask("What's the best bet this weekend across all sports?", { mod: mS, keepLedger: true });
    const before = searchCalls.length;
    const s6s = await ask("What's the best bet this weekend across all sports?", { mod: mS, keepLedger: true });
    ok('SEARCH BREAKER: after three consecutive failures the breaker opens and no further request is sent', searchCalls.length === before && /circuit breaker is open/.test(s6s.scan.best.search.why || ''), [before, searchCalls.length, s6s.scan.best.search]);
    /* the per-turn dollar cap: with a $0.10 request budget, the second game's search ($0.084 more) is refused */
    ENV.EDGEDESK_SEARCH_PROVIDERS = 'claude_web_search'; ENV.EDGEDESK_RESEARCH_PAID_OK = '1'; ENV.EDGEDESK_RESEARCH_BUDGET_REQUEST_USD = '0.10';
    const mB = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?search=claude&budget=0.10');
    delete ENV.EDGEDESK_SEARCH_PROVIDERS; ENV.EDGEDESK_RESEARCH_PAID_OK = '0'; delete ENV.EDGEDESK_RESEARCH_BUDGET_REQUEST_USD;
    searchCalls = []; searchReply = SFX;
    const sb1 = await ask("What's the best bet this weekend across all sports?", { mod: mB });
    const rowsB = [sb1.scan.best].concat(sb1.scan.verified_rest || [], sb1.scan.potential || [], sb1.scan.near_misses || []).filter(Boolean);
    ok('TURN BUDGET: one search per turn fits a $0.10 request budget; the next game\'s search is refused before any claim, and says why', searchCalls.length === 1 && rowsB.some((r) => r.search && r.search.status === 'BUDGET_REFUSED' && /this turn's research budget \(\$0\.10\)/.test(r.search.why)) && costCalls.filter((x) => x.fn === 'research_cost_claim').length === 1, [searchCalls.length, rowsB.map((r) => r.search && r.search.status)]);
    /* the paid-search slots */
    const sA = await mS.searchSlot(10), sB2 = await mS.searchSlot(10);
    const sC = await mS.searchSlot(30);
    ok('SLOTS: at most two paid searches in flight per isolate; a third waits briefly, then is refused', typeof sA === 'function' && typeof sB2 === 'function' && sC === null && mS.searchSlotsState().active === 2, mS.searchSlotsState());
    const waiting = mS.searchSlot(500); sA();
    const sD = await waiting;
    ok('SLOTS: a released slot goes to the next waiter', typeof sD === 'function' && mS.searchSlotsState().active === 2);
    sB2(); sD();
    ok('SLOTS: all released', mS.searchSlotsState().active === 0 && mS.searchSlotsState().waiting === 0, mS.searchSlotsState());
    /* the per-subscriber in-flight limit: with a limit of one, a second concurrent turn from the same subscriber is refused, not queued */
    ENV.EDGEDESK_SEARCH_PROVIDERS = 'claude_web_search'; ENV.EDGEDESK_RESEARCH_PAID_OK = '1'; ENV.EDGEDESK_RESEARCH_MAX_INFLIGHT = '1';
    const mI = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?inflight=1');
    delete ENV.EDGEDESK_SEARCH_PROVIDERS; ENV.EDGEDESK_RESEARCH_PAID_OK = '0'; delete ENV.EDGEDESK_RESEARCH_MAX_INFLIGHT;
    searchCalls = []; searchReply = SFX; searchDelay = 150;
    mI.clearCache(); mI.resetRateLimit(); mI.clearInvestigationCache(); mI.resetResearchLedger(); route = routerFor({});
    const qBody = { mode: 'chat', question: "What's the best bet this weekend across all sports?", history: [], timezone: 'America/New_York', desk: true };
    const p1 = mI.quantTurn({ body: qBody, auth: 'Bearer ' + USER_JWT, now: NOW });
    await new Promise((r) => setTimeout(r, 20));
    const busy = await mI.quantTurn({ body: qBody, auth: 'Bearer ' + USER_JWT, now: NOW });
    const first = await p1;
    searchDelay = 0;
    ok('IN FLIGHT: a second concurrent research turn from the same subscriber is refused with a plain answer; the first completes', busy && busy.quant.intent === 'BUSY' && busy.busy.limit === 1 && /already in progress/.test(busy.answer) && first && first.scan && first.scan.best && Object.keys(mI.researchInflightState()).length === 0, [busy && busy.answer, first && !!first.scan, mI.researchInflightState()]);
    /* structured logs: one JSON line per search and per turn, no question text, no key, the subscriber hashed */
    const logs = [], origLog = console.log;
    console.log = (...a) => { const t = a.join(' '); if (/^\{"ts"/.test(t)) logs.push(JSON.parse(t)); else origLog.apply(console, a); };
    searchCalls = []; searchReply = SFX; ENV.EDGEDESK_RESEARCH_LOG = '1';
    try { await ask("What's the best bet this weekend across all sports?", { mod: mS }); } finally { console.log = origLog; ENV.EDGEDESK_RESEARCH_LOG = '0'; }
    const lt = logs.find((x) => x.event === 'research_turn'), ls = logs.find((x) => x.event === 'research_search');
    ok('LOGS: a research_turn line with run id, route, level, timing, verdicts, search statuses and cost', lt && lt.svc === 'edgedesk_ai' && /^rr_/.test(lt.run_id) && lt.route === 'SCAN' && lt.level === 'L3' && typeof lt.ms === 'number' && lt.verification === 'VERIFIED/PASS' && Array.isArray(lt.search) && typeof lt.cost_usd === 'number' && lt.challenge && typeof lt.challenge === 'object', lt);
    ok('LOGS: a research_search line with provider, status, cost, findings and refusals', ls && ls.provider === 'claude_web_search' && ls.status === 'OK' && Math.abs(ls.cost_usd - 0.0722) < 1e-9 && ls.findings === 4 && ls.refused === 2, ls);
    ok('LOGS: no line carries the question, the API key or the raw subscriber id', logs.length >= 2 && logs.every((x) => !/best bet this weekend/.test(JSON.stringify(x)) && !/test-key/.test(JSON.stringify(x)) && !/11111111-1111/.test(JSON.stringify(x))) && /^u_[0-9a-f]{10}$/.test(lt.user), logs.map((x) => x.event + ':' + x.user));
    searchReply = null;
  }

  /* ═══ PHASE 3 — THE ROUTES THE WEBSITE'S AI ENTRY POINT AND GAME VIEW CALL ═══════════ */
  /* the six example questions on the Research screen each reach a deterministic engine route, never a model */
  const EX = [
    ["What's the best researched opportunity tonight?", 'SCAN'],
    ['Analyze every NFL game this weekend.', 'RESEARCH_SLATE'],
    ['Which matchup has the biggest offensive advantage?', 'MATCHUP_EDGE'],
    ['Compare DraftKings Predictions and Kalshi prices.', 'VENUE_COMPARE'],
    ["Explain why this game isn't research ready.", 'READINESS'],
  ];
  for (const [qx, want] of EX) {
    const jx = await ask(qx, { dump: 'ex_' + want.toLowerCase() });
    ok('EX: "' + qx + '" → ' + want + ', answered by the engine (no model call)', jx && jx.quant && jx.quant.intent === want && typeof jx.answer === 'string' && jx.answer.length > 40 && modelCalls === 0, jx && [jx.quant, (jx.answer || '').slice(0, 120)]);
  }
  const GCTX = { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-det-buf' } };
  const exd = await ask('Why does EdgeDesk disagree with this spread?', { carried: GCTX, dump: 'ex_disagree' });
  ok('EX: "Why does EdgeDesk disagree with this spread?" from a game → that game\'s research', exd && exd.quant.intent === 'GAME_RESEARCH' && exd.game_research && exd.game_research.game && exd.game_research.game.game_id === 'nfl-fx-det-buf' && /disagreement/i.test(exd.answer), exd && [exd.quant, (exd.answer || '').slice(0, 200)]);
  const exd0 = await ask('Why does EdgeDesk disagree with this spread?');
  ok('EX: …and with no game open, the slate\'s largest disagreements, researched', exd0 && exd0.quant.intent === 'RESEARCH_SLATE' && exd0.research_slate, exd0 && exd0.quant);

  /* READINESS: five states per game, from the board's own data; nothing bought, nothing audited */
  const rdy = await ask("Explain why games aren't research ready this weekend", { signals: MLB_SIGNALS.concat([BILLS, LIONS]), dump: 'readiness' });
  const rb = rdy && rdy.readiness_board;
  ok('RDY: the readiness answer counts five separate states', rb && rb.readiness && ['AVAILABLE', 'RESEARCH', 'MARKET', 'MODEL', 'ACTIONABLE'].every((k) => typeof rb.readiness.counts[k] === 'number') && rb.readiness.counts.total === rb.games.length, rb && rb.readiness);
  const bufG = rb && rb.games.find((g) => g.game_id === 'nfl-fx-det-buf'), houG = rb && rb.games.find((g) => g.game_id === 'nfl-fx-ind-hou');
  ok('RDY: Lions @ Bills has a current FanDuel price and a projection: market verified and model ready', bufG && bufG.readiness.states.MARKET.ok && bufG.readiness.states.MODEL.ok && bufG.readiness.states.RESEARCH.ok, bufG && bufG.readiness.states);
  ok('RDY: Colts @ Texans has no captured price here: researchable, model ready, market NOT verified — and says exactly why', houG && houG.readiness.states.RESEARCH.ok && houG.readiness.states.MODEL.ok && !houG.readiness.states.MARKET.ok && houG.why_not.some((w) => /^Market verified — needs/.test(w)), houG && houG.why_not);
  ok('RDY: a reference line is never counted as a verified market', rb && rb.games.filter((g) => !g.executable && g.market_line != null).every((g) => !g.readiness.states.MARKET.ok), rb && rb.games.map((g) => [g.matchup, g.executable, g.readiness.states.MARKET.ok]));
  ok('RDY: research available ≥ model ready ≥ market-and-model, and nothing is called actionable without a verified market', rb && rb.games.every((g) => (!g.readiness.states.ACTIONABLE.ok || g.readiness.states.MARKET.ok)) && rb.readiness.counts.RESEARCH >= rb.readiness.counts.MODEL, rb && rb.readiness.counts);
  ok('RDY: no research was bought and no audit ran for a readiness question', !posted.some((p) => p.table === 'research_findings' || p.table === 'opportunity_audits') && !reads.some((r) => /book_quotes\?/.test(r.url)), posted.map((p) => p.table));
  ok('RDY: the answer states the counts and each game\'s missing requirements', /Readiness: \d+ available · \d+ research available · \d+ market verified · \d+ model ready · \d+ actionable signal/.test(rdy.answer) && /Why each game is not fully ready/.test(rdy.answer) && /not ready to research/.test(rdy.answer), rdy && rdy.answer.slice(0, 600));

  /* GAME_RESEARCH: the game view's button — one game, readiness, numbers, findings, candidates, sources */
  const gr = await ask('Research this game', { carried: GCTX, dump: 'game_research', qhint: 'GAME_RESEARCH' });
  const grg = gr && gr.game_research && gr.game_research.game;
  ok('GAME: routed to the one-game research, with the game\'s readiness', gr && gr.quant.intent === 'GAME_RESEARCH' && grg && grg.readiness && grg.readiness.states.MARKET.ok && grg.readiness.states.ACTIONABLE.ok, gr && [gr.quant, grg && grg.readiness && grg.readiness.level]);
  ok('GAME: only that game was investigated (Bills -2.5 survives; no other game leaks in)', gr && gr.game_research.games.length === 1 && gr.game_research.investigated.every((r) => r.candidate.game_id === 'nfl-fx-det-buf') && gr.game_research.survivors === 1, gr && [gr.game_research.games.length, gr.game_research.survivors, gr.game_research.investigated.map((r) => [r.candidate.selection, r.classification && r.classification.classification, r.withheld_by_board])]);
  ok('GAME: model projection, market, disagreement, findings and sources are all in the answer', /^GAME RESEARCH — Detroit Lions @ Buffalo Bills/.test(gr.answer) && /Model projection: Buffalo Bills -5\.2/.test(gr.answer) && /Market: Buffalo Bills -2\.5/.test(gr.answer) && /Key injuries or lineup changes:/.test(gr.answer) && /^Sources:/m.test(gr.answer) && /CANDIDATE 1 — VERIFIED CANDIDATE/.test(gr.answer), gr && gr.answer.slice(0, 900));
  ok('EVIDENCE GAME: the game carries its own ledger: the verified price and the projection (home line), each dated', grg && grg.evidence && grg.evidence.records.some((r) => r.type === 'MARKET_QUOTE' && r.verification === 'VERIFIED') && grg.evidence.records.some((r) => r.type === 'MODEL_ESTIMATE' && /model_home_line$/.test(r.source.dataset_id) && r.value === grg.model_line), grg && grg.evidence && grg.evidence.records.map((r) => [r.type, r.claim]));
  ok('CALC GAME: the one game\'s ledger: projection -5.2 against the -2.5 market (gap -2.7), the captured price implied, and the turn verified', grg && grg.calc && Math.abs(recC(grg.calc, 'LINE_DISCREPANCY').output.value - (grg.model_line - grg.market_line)) < 1e-9 && recC(grg.calc, 'IMPLIED_PROBABILITY') && grg.calc.market_comparison.status === 'AVAILABLE' && gr.quant_verification && gr.quant_verification.numbers.verdict === 'PASS', grg && grg.calc && [grg.calc.records.map((x) => [x.name, x.output && x.output.display]), gr.quant_verification]);
  const grRow = gr && gr.game_research.investigated[0];
  ok('GAME: its numbers are the scan\'s numbers to the digit', grRow && best && grRow.evaluation.net_ev_per_dollar === best.evaluation.net_ev_per_dollar, grRow && [grRow.evaluation.net_ev_per_dollar, best && best.evaluation.net_ev_per_dollar]);
  const grh = await ask("Explain why this game isn't research ready", { carried: { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-ind-hou' } }, signals: MLB_SIGNALS.concat([BILLS, LIONS]) });
  ok('GAME: "why isn\'t this game ready" on Colts @ Texans names the missing market, and still researches it', grh && grh.quant.intent === 'GAME_RESEARCH' && /Why not ready:/.test(grh.answer) && /Market verified — needs/.test(grh.answer) && /Readiness: available yes · research yes · market verified no · model ready yes/.test(grh.answer), grh && grh.answer.slice(0, 700));
  const grhg = grh && grh.game_research && grh.game_research.game;
  ok('EVIDENCE GAME: a game with no verified market has no MARKET_QUOTE (a reference line is never a price)', grhg && grhg.evidence && !grhg.evidence.records.some((r) => r.type === 'MARKET_QUOTE'), grhg && grhg.evidence && grhg.evidence.records.map((r) => [r.type, r.claim]));
  ok('CALC GAME: with no verified price the market comparison is UNAVAILABLE and says why; the research still ran', grhg && grhg.calc && grhg.calc.market_comparison.status === 'UNAVAILABLE' && /reference line|no market/.test(grhg.calc.market_comparison.why) && !recC(grhg.calc, 'IMPLIED_PROBABILITY') && grhg.research, grhg && grhg.calc && grhg.calc.market_comparison);
  const grx = await ask('Research this game', { carried: { game: { sport: 'americanfootball_nfl', game_id: 'no-such-game' } }, qhint: 'GAME_RESEARCH' });
  ok('GAME: a game that is not on the card says so and invents nothing', grx && /not on EdgeDesk's card/.test(grx.answer) && grx.game_research && grx.game_research.game === null, grx && grx.answer);

  /* MATCHUP_EDGE: the ratings sum, recomputed here from the same artifact */
  const me = await ask('Which matchup has the biggest offensive advantage this weekend?');
  const mer = me && me.matchup_edges && me.matchup_edges.rows;
  const T = fx.nfl.teams;
  const want0 = mer && mer[0] ? (() => { const off = Object.values(T).find((t) => t.team === mer[0].offense), def = Object.values(T).find((t) => t.team === mer[0].defense); return Math.round((off.ratings.off_epa_play + def.ratings.def_epa_play) * 1000) / 1000; })() : null;
  ok('EDGE: the biggest offensive mismatch is the offense rating plus the opposing defense rating, recomputed', mer && mer.length >= 2 && mer[0].edge === want0 && mer.every((r, i) => i === 0 || r.edge <= mer[i - 1].edge), mer && [mer[0], want0]);
  ok('EDGE: the answer cites the ratings build and says it is context, not a bet', /BIGGEST OFFENSIVE MISMATCHES/.test(me.answer) && /not a probability and not a bet/.test(me.answer) && /Source: EdgeDesk NFL slate team ratings/.test(me.answer), me && me.answer.slice(0, 400));
  const mec = await ask('Which college football matchup has the biggest offensive advantage?');
  ok('EDGE: for college football it says the unit ratings are not published, and measures nothing', mec && /not unit-against-unit efficiency ratings/.test(mec.answer) && (mec.matchup_edges.rows || []).length === 0, mec && mec.answer);

  /* VENUE_COMPARE: what is on file per venue; no price invented, no fee rule borrowed */
  const vc = await ask('Compare DraftKings Predictions and Kalshi prices.');
  const vv = vc && vc.venue_compare && vc.venue_compare.venues;
  ok('VENUE: Kalshi carries its own (unverified) fee rule; DraftKings Predictions has none on file and is not given Kalshi\'s', vv && vv.find((v) => v.key === 'kalshi').verification === 'UNVERIFIED' && vv.find((v) => v.key === 'draftkings_predictions').fee === 'not on file' && vv.find((v) => v.key === 'draftkings_predictions').verification === 'UNKNOWN', vv);
  ok('VENUE: no live price is claimed for either venue, and the answer asks for the two prices', /does not capture its live prices/.test(vc.answer) && /none is invented/.test(vc.answer) && !/\d+¢ on (Kalshi|DraftKings)/.test(vc.answer.split('e.g.')[0]), vc && vc.answer);

  /* STREAMING through the real handler: accepted → real progress → result, the same numbers as the plain call */
  async function streamAsk(question, o) {
    o = o || {};
    m.clearCache(); m.resetRateLimit(); m.resetResearchLedger();
    route = routerFor(o); posted = []; reads = []; modelCalls = 0;
    const ctl = new AbortController();
    const body = { mode: 'chat', question, history: [], research_context: o.carried || null, timezone: 'America/New_York', desk: true, stream: true, intent_hint: o.qhint || undefined };
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer ' + USER_JWT, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }));
    const ct = r.headers.get('content-type') || '';
    if (!/ndjson/.test(ct)) { const json = await r.json(); if (DUMP && o.dump) DUMP[o.dump] = { question, carried: o.carried || null, qhint: o.qhint || null, json }; return { ct, json, events: [] }; }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '', events = [];
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) events.push(JSON.parse(line)); }
      if (o.cancelAfter && events.filter((e) => e.type === 'progress').length >= o.cancelAfter) { await rd.cancel(); break; }
    }
    if (DUMP && o.dump) DUMP[o.dump] = { question, carried: o.carried || null, qhint: o.qhint || null, events };
    return { ct, events };
  }
  /* the handler reads Date.now(): pinned to the scenario clock for these checks, so they mean the same on any day */
  const realNow = Date.now, T0 = realNow();
  Date.now = () => NOW + (realNow() - T0);
  /* every example question through the REAL handler (mine, opportunity, lines and props run first): each reaches its research route */
  for (const [qx, want] of EX.concat([['Analyze every NFL game this weekend.', 'RESEARCH_SLATE']])) {
    const hx = await streamAsk(qx, { dump: 'h_' + want.toLowerCase() });
    const payload = hx.events.length ? (hx.events.find((e) => e.type === 'result') || {}).payload : hx.json;
    ok('HANDLER: "' + qx + '" reaches ' + want + ' through the full handler', payload && payload.quant && payload.quant.intent === want, payload ? (payload.quant || Object.keys(payload).slice(0, 8)) : hx.events.map((e) => e.type));
  }
  /* the website's game view and its follow-ups, streamed through the handler (the browser suite replays these) */
  const hg = await streamAsk('Research this game', { carried: GCTX, qhint: 'GAME_RESEARCH', dump: 'h_game_research' });
  const hgp = (hg.events.find((e) => e.type === 'result') || {}).payload;
  ok('HANDLER: the game view\'s "Research with EdgeDesk AI" streams one game\'s research', hgp && hgp.quant && hgp.quant.intent === 'GAME_RESEARCH' && hgp.game_research && hgp.game_research.game && hgp.game_research.game.game_id === 'nfl-fx-det-buf', hgp && hgp.quant);
  const hd = await streamAsk('Why does EdgeDesk disagree with this spread?', { carried: GCTX, dump: 'h_disagree_game' });
  const hdp = (hd.events.find((e) => e.type === 'result') || {}).payload;
  ok('HANDLER: "Why does EdgeDesk disagree with this spread?" asked from a game streams that game\'s research', hdp && hdp.quant && hdp.quant.intent === 'GAME_RESEARCH', hdp && hdp.quant);
  const hh = await streamAsk("Explain why this game isn't research ready.", { carried: { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-ind-hou' } }, signals: MLB_SIGNALS.concat([BILLS, LIONS]), dump: 'h_game_hou' });
  const hhp = (hh.events.find((e) => e.type === 'result') || {}).payload;
  ok('HANDLER: "why isn\'t this game ready" from Colts @ Texans names the missing market through the handler', hhp && hhp.quant && hhp.quant.intent === 'GAME_RESEARCH' && /Market verified — needs/.test(hhp.answer || ''), hhp && [hhp.quant, (hhp.answer || '').slice(0, 300)]);
  const hr = await streamAsk("Explain why games aren't research ready this weekend", { signals: MLB_SIGNALS.concat([BILLS, LIONS]), dump: 'h_readiness_board' });
  const hrp = (hr.events.find((e) => e.type === 'result') || {}).payload;
  ok('HANDLER: the readiness board streams through the handler', hrp && hrp.quant && hrp.quant.intent === 'READINESS' && hrp.readiness_board, hrp && hrp.quant);
  /* the game sheet's mismatch chip: that game's two unit pairings, recomputed here from the same ratings */
  const hm = await streamAsk('What are the biggest offensive mismatches in this game?', { carried: GCTX, dump: 'h_mismatch_game' });
  const hmp = (hm.events.find((e) => e.type === 'result') || {}).payload;
  const hmr = hmp && hmp.matchup_edges && hmp.matchup_edges.rows;
  const offDet = Object.values(T).find((t) => t.team === 'Detroit Lions'), offBuf = Object.values(T).find((t) => t.team === 'Buffalo Bills');
  ok('HANDLER: "the biggest offensive mismatches in this game" from a game view measures that game only, both pairings, the same sums',
    hmp && hmp.quant && hmp.quant.intent === 'MATCHUP_EDGE' && hmr && hmr.length === 2 && hmr.every((r) => r.game_id === 'nfl-fx-det-buf')
      && hmr.some((r) => r.offense === 'Buffalo Bills' && r.edge === Math.round((offBuf.ratings.off_epa_play + offDet.ratings.def_epa_play) * 1000) / 1000)
      && /BIGGEST OFFENSIVE MISMATCHES — NFL, Detroit Lions @ Buffalo Bills/.test(hmp.answer), hmp && [hmp.quant, hmr, (hmp.answer || '').slice(0, 200)]);
  /* THE BROWSER SUITE'S ANSWERS (tools/intelligence/intel_ui.e2e.js), one consistent card: the Lions @ Bills spread is
     priced (FanDuel), Colts @ Texans has no captured price — the same signals the browser's own board is given */
  if (DUMP) {
    const BSIG = MLB_SIGNALS.concat([BILLS, LIONS]);
    const HOU_CTX = { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-ind-hou' } };
    const B = [
      ['b_tonight', "What's the best researched opportunity tonight?", {}],
      ['b_slate', 'Analyze every NFL game this weekend.', {}],
      ['b_disagree', 'Why does EdgeDesk disagree with this spread?', {}],
      ['b_matchup', 'Which matchup has the biggest offensive advantage?', {}],
      ['b_venue', 'Compare DraftKings Predictions and Kalshi prices.', {}],
      ['b_readiness', "Explain why this game isn't research ready.", {}],
      ['b_scan_weekend', "What's the best bet this weekend across all sports?", {}],
      ['b_game_buf', 'Research this game: model, market, injuries, the disagreement and the audit.', { carried: GCTX, qhint: 'GAME_RESEARCH' }],
      ['b_disagree_buf', 'Why does EdgeDesk disagree with this spread?', { carried: GCTX }],
      ['b_why_buf', "Explain why this game isn't research ready.", { carried: GCTX }],
      ['b_mismatch_buf', 'What are the biggest offensive mismatches in this game?', { carried: GCTX }],
      ['b_game_hou', 'Research this game: model, market, injuries, the disagreement and the audit.', { carried: HOU_CTX, qhint: 'GAME_RESEARCH' }],
      ['b_readiness_week', "Explain why games aren't research ready this week", {}],
      ['b_why_hou', "Explain why this game isn't research ready.", { carried: HOU_CTX }],
      ['b_disagree_hou', 'Why does EdgeDesk disagree with this spread?', { carried: HOU_CTX }],
      ['b_mismatch_hou', 'What are the biggest offensive mismatches in this game?', { carried: HOU_CTX }],
    ];
    /* a provider failure mid-research: the live injury feed is down; the browser shows what remained available */
    B.push(['b_game_buf_feedfail', 'Research this game: model, market, injuries, the disagreement and the audit.', { carried: GCTX, qhint: 'GAME_RESEARCH', fail: failLive }]);
    for (const [k, q, o] of B) { m.resetResearchLedger(); await streamAsk(q, Object.assign({ signals: BSIG, dump: k }, o)); }
  }
  const st = await streamAsk("What's the best bet this weekend across all sports?", { dump: 'h_scan_weekend' });
  const stages = st.events.filter((e) => e.type === 'progress');
  ok('STREAM: the handler streams NDJSON: accepted first, a result last', /ndjson/.test(st.ct) && st.events[0] && st.events[0].type === 'accepted' && st.events[st.events.length - 1].type === 'result', st.events.map((e) => e.type));
  /* PHASE 4: the plan arrives before any work, and the result carries planned vs actual */
  const planEv = st.events[1];
  ok('PLAN: the second event is the plan (before any progress), with its path, datasets, calculations and estimate', planEv && planEv.type === 'plan' && planEv.plan && planEv.plan.path === 'ENGINE_RESEARCH' && planEv.plan.datasets.length >= 3 && planEv.plan.calculations.length >= 3 && planEv.plan.estimate && planEv.plan.estimate.usd === 0 && st.events.findIndex((e) => e.type === 'progress') > 1, planEv && [planEv.type, planEv.plan && planEv.plan.path]);
  ok('PLAN: every planned stage is a stage the stream reports (no invented step names)', planEv && planEv.plan.steps.every((x) => ['FIND_EVENTS', 'COMPARE_PRICES', 'RETRIEVE_STATS', 'VERIFY_INJURIES', 'CALCULATE', 'AUDIT', 'CHALLENGE', 'EXPLAIN', 'SEARCH', 'LOOKUP', 'READ_HISTORY', 'ANALYZE_HISTORY', 'MODEL_DESK'].includes(x.stage)), planEv && planEv.plan.steps.map((x) => x.stage));
  const resP = st.events[st.events.length - 1].payload;
  const act = resP && resP.research_plan_actual;
  ok('PLAN: the result carries planned vs actual, and every stage the stream reported is marked as it ran', act && act.length === planEv.plan.steps.length && act.filter((x) => x.actual !== 'not_run').every((x) => stages.some((e) => e.stage === x.stage && e.status === x.actual)), act);
  const order = ['FIND_EVENTS', 'COMPARE_PRICES', 'RETRIEVE_STATS', 'VERIFY_INJURIES', 'CALCULATE', 'AUDIT', 'EXPLAIN'];
  const firstDone = order.map((k) => stages.findIndex((e) => e.stage === k && (e.status === 'done' || e.status === 'skipped')));
  ok('STREAM: every research step reports, in the order the work actually happens, each with a real detail', firstDone.every((x) => x >= 0) && firstDone.every((x, i) => i === 0 || x > firstDone[i - 1]) && stages.every((e) => e.label && typeof e.detail === 'string' && e.detail.length > 3 && typeof e.t_ms === 'number'), stages.map((e) => e.stage + ':' + e.status + ':' + (e.detail || '').slice(0, 40)));
  ok('STREAM: partial results arrive before the answer (the coverage, then the first audit verdicts)', stages.some((e) => e.stage === 'FIND_EVENTS' && e.partial && Array.isArray(e.partial.coverage)) && stages.some((e) => e.stage === 'COMPARE_PRICES' && e.partial && Array.isArray(e.partial.audit) && e.partial.audit.length >= 1), stages.filter((e) => e.partial).map((e) => e.stage));
  const res = st.events[st.events.length - 1].payload;
  ok('STREAM: the streamed result is the engine\'s payload (route, scan, the same verdict)', res && res.quant && res.quant.intent === 'SCAN' && res.scan && res.route && typeof res.answer === 'string', res && Object.keys(res));
  const stc = await streamAsk("What's the best bet this week across all sports?", { cancelAfter: 2 });
  await new Promise((r) => setTimeout(r, 300));
  ok('STREAM: cancelling stops the run: no result was sent and no research memory was written', !stc.events.some((e) => e.type === 'result') && !posted.some((p) => p.table === 'research_findings' || p.table === 'research_runs'), [stc.events.map((e) => e.type), posted.map((p) => p.table)]);
  const stp = await streamAsk('Is Guardians at 49¢ on Kalshi a good price?');
  ok('STREAM: a question the research routes do not stream comes back as plain JSON (the client reads both)', /json/.test(stp.ct) && !/ndjson/.test(stp.ct) && stp.json && stp.json.quant && stp.json.quant.intent === 'CONTRACT', [stp.ct, stp.json && stp.json.quant]);

  /* ═══ PHASE 4 — WHAT THE BENCHMARK FOUND (tools/research/benchmark): a player's status, what EdgeDesk does not
     measure, a schedule question, a price read that failed. Each model-free, through the full handler. ═══ */
  {
    const S2M = metricsWith({ BUF: { players: [{ name: 'Josh Allen', position: 'QB', status: 'Out', injury: 'Shoulder', practice: 'Did Not Participate In Practice' }], retrieved_at: ISO(-30 * H) } });
    const S2N = notes([{ sport: 'americanfootball_nfl', team: 'BUF', kind: 'availability', player: 'Josh Allen', status: 'ACTIVE', key: true, text: 'Josh Allen was a full participant in Saturday practice and will play Sunday', source: 'ESPN', url: 'https://www.espn.com/nfl/story/_/id/fixture-allen-practice', published_at: ISO(-2 * H), recorded_at: ISO(-90), source_kind: 'NEWS' }]);
    const av = await streamAsk('Is Josh Allen playing Sunday?', { metrics: S2M, notes: S2N, dump: 'b_availability' });
    const aj = av.json || {}, aa = aj.availability || {};
    ok('AVAILABILITY: "Is Josh Allen playing Sunday?" is answered from the sources EdgeDesk reads, through the handler, with no model call', aj.quant && aj.quant.intent === 'AVAILABILITY' && modelCalls === 0 && aa.player === 'Josh Allen' && aa.team === 'Buffalo Bills' && aa.game && aa.game.game_id === 'nfl-fx-det-buf', [aj.quant, modelCalls, aa.player, aa.game]);
    ok('AVAILABILITY: the official OUT and the credible ACTIVE are a conflict it names and does not settle', aa.status && aa.status.code === 'CONFLICTING' && /OUT per nflverse vs ACTIVE per ESPN/.test(aj.answer) && /does not pick one/.test(aj.answer) && (aa.conflicts || []).length >= 1, [aa.status, (aj.answer || '').split('\n').slice(0, 3)]);
    ok('AVAILABILITY: each source in its own words, with its time and freshness, and a numbered link that was read', aa.records.some((r) => /espn\.com/.test(r.source.url)) && aa.records.some((r) => /injuries_2026\.csv/.test(r.source.url)) && /What each source says:/.test(aj.answer) && /\[1\] .+ — https:\/\//.test(aj.answer), aa.records.map((r) => r.source.url));
    ok('AVAILABILITY: the engine\'s own QB-out re-run is shown as a model re-run, never a market price', aa.scenario && aa.scenario.side === 'home' && /re-run without Buffalo Bills' starting quarterback/.test(aj.answer) && /not a market price/.test(aj.answer), [aa.scenario, (aj.answer || '').match(/If .*$/m)]);
    ok('AVAILABILITY: it carries its plan (route AVAILABILITY) and what actually ran', aj.research_plan && aj.research_plan.classification.route === 'AVAILABILITY' && aj.research_plan.path === 'ENGINE_RESEARCH' && aj.research_plan.steps.some((x) => x.stage === 'VERIFY_INJURIES') && Array.isArray(aj.research_plan_actual), aj.research_plan && [aj.research_plan.classification.route, aj.research_plan.steps.map((x) => x.stage)]);
    const ar = await streamAsk('Is Anthony Richardson starting for the Colts?', {});
    const arj = ar.json || {};
    ok('AVAILABILITY: a player EdgeDesk holds nothing on is said to be unknown and given no status; the club\'s listed starter is shown instead', arj.availability && arj.availability.unknown_name === 'Anthony Richardson' && /holds no report on Anthony Richardson/.test(arj.answer) && !/Anthony Richardson (is|will be) (out|active|starting|playing)/i.test(arj.answer) && /Daniel Jones/.test(arj.answer) && modelCalls === 0, (arj.answer || '').split('\n').slice(0, 4));
    const az = await streamAsk('Is Zebulon Quarterbackson playing Sunday?', {});
    ok('AVAILABILITY: a name on no list and no club named is not given an availability card', !(az.json && az.json.availability), az.json && az.json.quant);
    const un = await streamAsk('Best Premier League bet this weekend?', { dump: 'b_unsupported' });
    const uj = un.json || {};
    ok('UNSUPPORTED: a soccer question is not answered with an NFL pick: it says soccer is not covered, and calls no model', uj.quant && uj.quant.intent === 'UNSUPPORTED' && uj.unsupported.kind === 'SPORT' && /Soccer is not covered/.test(uj.answer) && !/Buffalo Bills/.test(uj.answer) && modelCalls === 0, [uj.quant, uj.answer]);
    const uf = await streamAsk('Who will win the Super Bowl in 2031?', {});
    ok('UNSUPPORTED: a season-long outcome is not modelled and not guessed', uf.json && uf.json.quant.intent === 'UNSUPPORTED' && uf.json.unsupported.kind === 'OUTCOME' && /does not model season-long outcomes/.test(uf.json.answer) && modelCalls === 0, uf.json && uf.json.answer);
    const ug = await streamAsk('Can you guarantee the Bills cover -2.5?', {});
    ok('UNSUPPORTED: a demand for a guarantee is answered without one, pointing to the price question it can answer', ug.json && ug.json.unsupported && ug.json.unsupported.kind === 'CERTAINTY' && /Is Buffalo Bills -2\.5 a good bet\?/.test(ug.json.answer) && !/\bguaranteed\b/i.test(ug.json.answer), ug.json && ug.json.answer);
    const uw = await streamAsk('Who will win Lions at Bills?', {});
    ok('UNSUPPORTED: "who will win" about a named game is not intercepted (the desk reports that game\'s probability)', !(uw.json && uw.json.unsupported), uw.json && (uw.json.quant || Object.keys(uw.json).slice(0, 6)));
    const ua = await streamAsk("What's the best bet this weekend across all sports, NBA included?", {});
    const uaP = ua.events.length ? (ua.events.find((e) => e.type === 'result') || {}).payload : ua.json;
    ok('UNSUPPORTED: "across all sports" stays a scan whatever else it names', uaP && uaP.quant && uaP.quant.intent === 'SCAN', uaP && uaP.quant);
    const sc = await streamAsk('When do the Lions play the Bills?', {});
    ok('SCHEDULE: "When do the Lions play the Bills?" is answered with the kickoff on the card, not a price verdict, with no model call', sc.json && sc.json.desk && sc.json.desk.intent === 'SCHEDULE' && /^Detroit Lions @ Buffalo Bills kicks off /.test(sc.json.answer) && !/paying more|value/i.test(sc.json.answer) && modelCalls === 0, sc.json && sc.json.answer);
    /* two players with one name: the club the question names, else the listed starter — and the answer says who else has it */
    const NS = metricsWith({ JAX: { players: [{ name: 'Josh Allen', position: 'LB', status: 'Questionable', injury: 'Ankle', practice: 'Limited Participation In Practice' }] } });
    const ns1 = await streamAsk('Is Josh Allen playing Sunday?', { metrics: NS });
    ok('AVAILABILITY: a name two clubs carry goes to the listed starter, and the answer names the other club', ns1.json && ns1.json.availability && ns1.json.availability.team === 'Buffalo Bills' && /Another player with this name is on Jacksonville Jaguars/.test(ns1.json.answer), ns1.json && [ns1.json.availability && ns1.json.availability.team, (ns1.json.answer || '').split('\n').slice(0, 4)]);
    const ns2 = await streamAsk('Is Josh Allen from the Jaguars playing this week?', { metrics: NS });
    ok('AVAILABILITY: naming the club picks that club\'s player', ns2.json && ns2.json.availability && ns2.json.availability.team === 'Jacksonville Jaguars' && /Another player with this name is on Buffalo Bills/.test(ns2.json.answer), ns2.json && [ns2.json.availability && ns2.json.availability.team, (ns2.json.answer || '').split('\n').slice(0, 4)]);
    /* the operator's switches: both routes off, the questions go back to the routes that answered them before */
    ENV.EDGEDESK_AVAILABILITY = '0'; ENV.EDGEDESK_OUT_OF_SCOPE = '0';
    const mOff = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?flags=off');
    delete ENV.EDGEDESK_AVAILABILITY; delete ENV.EDGEDESK_OUT_OF_SCOPE;
    route = routerFor({});
    const offA = await mOff.availabilityTurn({ body: { question: 'Is Josh Allen playing Sunday?', desk: true }, auth: 'Bearer ' + USER_JWT, now: NOW });
    const offU = mOff.outOfScopeTurn({ question: 'Best Premier League bet this weekend?', desk: true });
    ok('SWITCHES: EDGEDESK_AVAILABILITY=0 and EDGEDESK_OUT_OF_SCOPE=0 turn both routes off without a code change', offA === null && offU === null && !!m.outOfScopeTurn({ question: 'Best Premier League bet this weekend?', desk: true }), [offA && offA.quant, offU && offU.quant]);
    const rf = await ask("What's the best bet this weekend across all sports?", { fail: (u) => /\/rest\/v1\/signals\?/.test(u) });
    ok('COVERAGE: when the captured prices cannot be read, the coverage says the read failed — never "no captured prices"', rf && /NFL \(read failed\)/.test(rf.answer) && !/NFL \(games but no captured prices\)/.test(rf.answer), rf && (rf.answer || '').split('\n').filter((l) => /Coverage/.test(l)));
  }
  Date.now = realNow;

  if (DUMP) fs.writeFileSync(process.env.RESEARCH_DUMP, JSON.stringify(DUMP));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
