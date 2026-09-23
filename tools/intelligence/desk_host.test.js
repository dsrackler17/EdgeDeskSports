#!/usr/bin/env node
/* ===========================================================================
   THE DESK TURN, THROUGH THE REAL HANDLER.

   Node strips the TypeScript; the network is the intelligence fixture router
   (the REAL committed FBS slate, NFL slate, metrics and pricing validation)
   plus captured signals this file chooses; the writing model is a stub whose
   text each case chooses. Asserts:
     - `desk: true` gets the short desk answer; any other caller keeps the
       full research contract unchanged
     - the ranking is EdgeDesk's: a writer that names a different pick, drops
       a number or turns a PASS into a pick is rejected, and the reader gets
       EdgeDesk's own words
     - CFB and NFL games both arrive as typed evidence
     - the carried desk state keeps follow-ups on the same selection
     - a stale captured price is never the current best value
     - the focus selection is recorded write-once, pregame
     - staking and other-sport questions fall through to the full pipeline

   Run: node tools/intelligence/desk_host.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const FX = require('./fixtures.js');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }

const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

let route = () => [];
let modelText = 'ok';
let modelCalls = [];
let posted = [];
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) {
    modelCalls.push(JSON.parse(init.body));
    const t = typeof modelText === 'function' ? modelText(JSON.parse(init.body)) : modelText;
    return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: t }] }), text: async () => t };
  }
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) {
    posted.push({ table: u.replace('https://sb.test/rest/v1/', '').split('?')[0], body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => '', json: async () => [] };
  }
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
};

const NOW = Date.now();

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const fx = FX.build(NOW);
  const nflKick = fx.nfl.games.find((g) => g.game_id === 'nfl-fx-ind-hou').kickoff;
  function sig(o) {
    return Object.assign({ event_id: 'ev-ind-hou', sport_key: 'americanfootball_nfl', market: 'spreads', best_book: 'FanDuel', best_dec: 1.91,
      home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: nflKick,
      first_seen_at: new Date(NOW - 300 * 60000).toISOString(), last_seen_at: new Date(NOW - 12 * 60000).toISOString(), sig_key: 'k-' + Math.random().toString(36).slice(2) }, o);
  }
  /* Houston -3 against EdgeDesk's Houston -8: a 5-point disagreement the NFL LEAN-tier blend clears.
     North Texas -2.5 / Texas State +2.5 against EdgeDesk's North Texas -2.4: efficiently priced. */
  const SIGNALS = [
    sig({ selection: 'Houston Texans', point: -3 }),
    sig({ selection: 'Indianapolis Colts', point: 3 }),
    fx.signal({ selection: 'North Texas', point: -2.5, best_dec: 1.91 }),
    fx.signal({ selection: 'Texas State', point: 2.5, best_dec: 1.91 })
  ];
  async function ask(question, opts) {
    opts = opts || {};
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    route = FX.router(fx, Object.assign({ signals: opts.signals || SIGNALS }, opts.rows || {}));
    modelCalls = []; posted = [];
    modelText = opts.answer === undefined ? 'ok' : opts.answer;
    const body = { mode: 'chat', question, packet: null, history: [], research_context: opts.carried || null };
    if (opts.desk !== false) body.desk = true;
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', {
      method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: r.status, j: await r.json() };
  }

  /* ---- 1. the broad question ------------------------------------------ */
  const r1 = await ask("What's the best market line value today?");
  const d1 = r1.j.desk;
  ok('desk answers the broad question', r1.status === 200 && d1 && d1.intent === 'BOARD', r1.j.error || (d1 && d1.intent));
  ok('the pick is EdgeDesk’s #1: Houston -3', /^Best value right now: Houston Texans -3/.test(d1.deterministic_answer), d1.deterministic_answer);
  ok('the writer’s "ok" drops the headline facts, so EdgeDesk’s words ship', r1.j.answer === d1.deterministic_answer && d1.narration.prose === 'REJECTED_BY_CRITIC', d1.narration);
  ok('both sports were read', d1.coverage.some((c) => c.sport === 'americanfootball_ncaaf' && c.games > 0) && d1.coverage.some((c) => c.sport === 'americanfootball_nfl' && c.games > 0), d1.coverage);
  ok('the answer is short', r1.j.answer.split(/(?<=[.!?])\s+/).length <= 12, r1.j.answer);
  ok('the ranking rule rides with the answer', /edge .* x quote freshness x validation tier x evidence quality/.test(d1.ranking_rule));
  ok('the state for the next turn comes back', r1.j.desk_state && r1.j.desk_state.schema === 'edgedesk_desk_state_v1' && r1.j.desk_state.focus.team === 'Houston Texans');
  const ev1 = d1.evaluations[0];
  ok('NFL evaluation carries typed evidence: LEAN tier, the blend, a cover probability', ev1.tier === 'LEAN' && /validated blend/.test(ev1.prob.basis) && ev1.prob.cover > 0.5, ev1);
  ok('the focus is recorded write-once, pregame', posted.some((p) => p.table === 'desk_prediction_history' && p.body.selection === 'Houston Texans -3' && Date.parse(p.body.captured_at) < Date.parse(p.body.kickoff)), posted.map((p) => p.table));

  /* ---- 2. the writer cannot change the pick ---------------------------- */
  const swap = await ask("What's the best market line value today?", { answer: 'Best value right now: Texas State +2.5 at -110. EdgeDesk makes it North Texas -2.4.' });
  ok('a rewrite naming a different pick is rejected', swap.j.desk.narration.prose === 'REJECTED_BY_CRITIC' && /^Best value right now: Houston/.test(swap.j.answer), swap.j.desk.narration);
  const faithful = (req) => req.messages[0].content.replace('Best value right now:', 'The best value on the board right now is');
  const good = await ask("What's the best market line value today?", { answer: faithful });
  ok('a faithful rephrase ships as the model’s prose', good.j.desk.narration.prose === 'MODEL' && /^The best value on the board right now is Houston Texans -3/.test(good.j.answer), good.j.desk.narration);
  ok('the writer was told it may only rephrase', modelCalls.length === 1 && /Do not add any number/.test(modelCalls[0].system));
  const invented = await ask("What's the best market line value today?", { answer: (req) => req.messages[0].content + ' Houston covers 71% of the time here.' });
  ok('an invented number is rejected', invented.j.desk.narration.prose === 'REJECTED_BY_CRITIC' && invented.j.desk.narration.critic.findings.some((f) => f.code === 'NUMBER_NOT_IN_EVIDENCE'), invented.j.desk.narration.critic);

  /* ---- 3. follow-ups ride the carried state ---------------------------- */
  const carried = { desk: r1.j.desk_state };
  const f1 = await ask('What if it moves to -4.5?', { carried });
  ok('"it" is Houston, re-priced at -4.5', f1.j.desk.intent === 'LINE_CHANGE' && f1.j.desk_state.focus.team === 'Houston Texans' && f1.j.desk_state.focus.line === -4.5, f1.j.desk);
  const f2 = await ask('Why?', { carried: { desk: f1.j.desk_state } });
  ok('"why" explains Houston', f2.j.desk.intent === 'EXPLAIN' && /Houston/.test(f2.j.desk.deterministic_answer), f2.j.desk.deterministic_answer);
  const f3 = await ask('Compare that to Texas State +2.5', { carried: { desk: f2.j.desk_state } });
  ok('compare across sports keeps the focus and adds the named side', f3.j.desk.intent === 'COMPARE' && f3.j.desk.compare.length === 2 && f3.j.desk.compare[1].team === 'Texas State', f3.j.desk);
  const f4 = await ask('Which would you rather have?', { carried: { desk: f3.j.desk_state } });
  ok('"which would you rather have" picks between the two', f4.j.desk.intent === 'CHOOSE' && /Houston|Texas State|Neither/.test(f4.j.answer), f4.j.answer);

  /* ---- 4. specific CFB question: typed evidence, efficient price --------- */
  const c1 = await ask('Is Texas State +2.5 worth betting?');
  const ce = c1.j.desk && c1.j.desk.evaluations[0];
  ok('CFB question evaluates Texas State +2.5 from typed evidence', ce && ce.sport === 'americanfootball_ncaaf' && ce.selection === 'Texas State +2.5' && ce.tier === 'RESEARCH', ce);
  ok('a 0.1-point difference is called efficient, not a bet', /^No\./.test(c1.j.desk.deterministic_answer), c1.j.desk.deterministic_answer);

  /* ---- 5. stale prices ------------------------------------------------- */
  const stale = SIGNALS.map((s) => Object.assign({}, s, { last_seen_at: new Date(NOW - 2126 * 60000).toISOString() }));
  const s1 = await ask("What's the best market line value today?", { signals: stale });
  ok('a stale price is never the current best value', !/^Best value right now/.test(s1.j.answer) && /^Nothing stands out/.test(s1.j.desk.deterministic_answer), s1.j.desk.deterministic_answer);
  ok('nothing stale is recorded', !posted.some((p) => p.table === 'desk_prediction_history'));

  /* ---- 6. what the desk does not answer ------------------------------ */
  const legacy = await ask("What's the best market line value today?", { desk: false });
  ok('without desk:true the full research contract is unchanged', !legacy.j.desk && legacy.j.research !== undefined, Object.keys(legacy.j));
  const units = await ask('How many units should I bet on Houston?');
  ok('a staking question falls through to the full pipeline', !units.j.desk, Object.keys(units.j));
  const mlb = await ask('Best MLB value today?');
  ok('another sport falls through', !mlb.j.desk);

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
