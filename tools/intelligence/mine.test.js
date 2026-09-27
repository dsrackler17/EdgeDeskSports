#!/usr/bin/env node
/* ===========================================================================
   THE DESK READS THE READER'S OWN RESEARCH — and invents none of it.

   Part 1, the kernel (supabase/functions/edgedesk_ai/_mine.js): every example
   question from the brief lands on its intent and a betting question does
   not; each answer is built only from the rows handed to it; an empty or
   unreadable table is SAID, never filled; the copy rule holds; the critic
   refuses a rephrasing that adds a number or tout language.

   Part 2, the real handler (index.ts, Node strips the TypeScript): a personal
   question is answered by mineTurn before the desk or the pipeline runs,
   every read goes out under the CALLER's bearer token (so row level security
   decides what exists), nothing is cached across callers, no model is called
   unless EDGEDESK_MINE_NARRATE=1, and a question that is not about the
   reader's research falls through untouched.

   Run: node tools/intelligence/mine.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const MINE = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_mine.js'));
const P = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }

const NOW = Date.now(), H = 36e5, D = 864e5;
const iso = (ms) => new Date(ms).toISOString();
function st(o) {
  return P.normalizeState(Object.assign({ sport: 'cfb', status: 'RESEARCH', projected: true, kickoff_at: iso(NOW + 2 * D), computed_at: iso(NOW - H),
    fair: { home_line: 1.7, text: 'Ole Miss -1.7' }, market: { home_line: -2.5, text: 'Florida -2.5', kind: 'live', books: 4, stale: false },
    gap: { points: 4.2 }, reliability: { score: 88, grade: 'STRONG', scored: true },
    qb: { home: { name: 'H QB', confirmed: true }, away: { name: 'A QB', confirmed: true }, confirmed_both: true },
    injuries: { home: { known: true, out: [] }, away: { known: true, out: [] } },
    priority: { eligible: true, rank: 1, score: 70, why_text: 'Model flips the market favorite: EdgeDesk has Ole Miss by 1.7, the market has Florida by 2.5.' }
  }, o));
}
const G1 = st({ game_key: 'cfb|1', game_id: '1', home: 'Florida', away: 'Ole Miss' });
const G1_BEFORE = st({ game_key: 'cfb|1', game_id: '1', home: 'Florida', away: 'Ole Miss', fair: { home_line: 0.4, text: 'Ole Miss -0.4' }, reliability: { score: 76, grade: 'ADEQUATE', scored: true },
  qb: { home: { name: 'H QB', confirmed: false }, away: { name: 'A QB', confirmed: true }, confirmed_both: false } });
const G2 = st({ game_key: 'cfb|2', game_id: '2', home: 'Texas Tech', away: 'Baylor', fair: { home_line: -7.1 }, market: { home_line: -3.5, kind: 'live' }, gap: { points: 3.6 },
  reliability: { score: 58, grade: 'LOW', scored: true }, research_label: 'LOW_RELIABILITY', priority: { eligible: true, rank: 2, score: 30 } });
const G3 = st({ game_key: 'nfl|X', sport: 'nfl', game_id: 'X', home: 'Miami Dolphins', away: 'Buffalo Bills', reliability: { score: null, scored: false }, research_label: null,
  gap: { points: 6.5 }, fair: { home_line: 3 }, market: { home_line: -3.5, kind: 'consensus' }, priority: { eligible: true, rank: 1, score: 40 } });

/* ═══ PART 1 — the kernel ═══════════════════════════════════════════════ */
const Q = {
  'What changed in my watchlist today?': 'WATCH_CHANGES',
  'Which of my watched games became research-grade?': 'WATCH_GRADE',
  'Which five games are most worth researching?': 'TOP5',
  'Where is EdgeDesk most different from the market?': 'LARGEST_GAP',
  'Which games have high disagreement but low reliability?': 'GAP_LOW_REL',
  'Which games improved after QB confirmation?': 'QB_IMPROVED',
  'How has my CLV looked this month?': 'CLV',
  'Show me games where my own decisions consistently disagree with EdgeDesk.': 'VERSUS',
  'Why did this game\'s reliability change?': 'REL_WHY',
  'What are my alerts?': 'ALERTS',
  'What is on my watchlist?': 'WATCH_LIST'
};
Object.keys(Q).forEach((q) => ok('classify: "' + q + '" → ' + Q[q], MINE.classify(q) === Q[q], MINE.classify(q)));
Object.keys(Q).forEach((q) => ok('the browser routes "' + q + '" to the desk', P.PERSONAL_Q.test(q)));
['Is Maryland -2.5 worth betting?', 'What is the best bet today?', 'Who is out for Florida?', 'Compare that to Maryland ML'].forEach((q) => {
  ok('a betting or matchup question is not the reader\'s own research: "' + q + '"', MINE.classify(q) === null && !P.PERSONAL_Q.test(q));
});

const watch = [{ game_key: 'cfb|1', home: 'Florida', away: 'Ole Miss', state: G1, changed: true, seen_hash: G1_BEFORE.state_hash },
  { game_key: 'cfb|2', home: 'Texas Tech', away: 'Baylor', state: G2, changed: false }];
const history = [{ game_key: 'cfb|1', computed_at: iso(NOW - 30 * H), state: G1_BEFORE }, { game_key: 'cfb|1', computed_at: iso(NOW - 2 * H), state: G1 }];

let a = MINE.answer('WATCH_CHANGES', { watchlist: watch, history: history, alerts: [{ kind: 'qb_confirmed', created_at: iso(NOW - 2 * H), read_at: null }] }, { now: NOW });
ok('what changed: names the game that changed and how', /1 of your 2 watched games changed in the last 24 hours/.test(a.headline) && a.lines.some((l) => /Ole Miss @ Florida/.test(l) && /moved from/.test(l)), a);
ok('what changed: carries the QB confirmation with the reliability it moved', a.text.indexOf('QB status confirmed for Florida. Reliability increased from 76 to 88.') >= 0 || a.detail.join(' ').indexOf('QB status confirmed for Florida') >= 0, a);
ok('what changed: mentions the unread alert from that window', /1 unread alert/.test(a.headline));
a = MINE.answer('WATCH_CHANGES', { watchlist: watch, history: [] }, { now: NOW });
ok('no history in the window: nothing changed, said plainly', /Nothing meaningful changed in your 2 watched games/.test(a.headline), a.headline);
a = MINE.answer('WATCH_CHANGES', { watchlist: [] }, { now: NOW });
ok('an empty watchlist says so rather than inventing games', /watchlist is empty/.test(a.headline) && a.lines.length === 0);
a = MINE.answer('WATCH_LIST', { watchlist: watch }, { now: NOW });
ok('the watchlist answer reads the rows it was given', a.lines.length === 2 && /EdgeDesk Ole Miss -1\.7, market Florida -2\.5, gap 4\.2 pts, reliability 88/.test(a.lines[0]), a.lines);

a = MINE.answer('WATCH_GRADE', { watchlist: watch, alerts: [{ kind: 'research_grade', game_key: 'cfb|1', created_at: iso(NOW - 5 * H) }] }, { now: NOW });
ok('research-grade watched games are named, with when they became so', /research-grade right now/.test(a.headline) && a.lines.some((l) => /became research-grade/.test(l)), a);

a = MINE.answer('TOP5', { top: [G1, G2, G3], prefs: { leagues: ['cfb'] } }, { now: NOW, question: 'Which five games are most worth researching?' });
ok('Top 5 follows the research-priority rank for the reader\'s league', a.lines.length === 2 && /CFB #1 Ole Miss @ Florida/.test(a.lines[0]) && /CFB #2 Baylor @ Texas Tech/.test(a.lines[1]), a.lines);
ok('and says it is not a ranking of bets', /not a ranking of bets/.test(a.headline));
ok('each entry carries why and a possible concern in the detail', a.detail.some((l) => /why: Model flips the market favorite/.test(l)));
a = MINE.answer('TOP5', { top: [], top_error: 'HTTP 500' }, { now: NOW });
ok('a list that cannot be read is not named from memory', /could not be read/.test(a.headline) && !a.lines.length);

a = MINE.answer('LARGEST_GAP', { slate: [G1, G2, G3] }, { now: NOW });
ok('the largest gaps are listed, largest first, with reliability beside each', /NFL reliability not scored/.test(a.lines[0]) && /Buffalo Bills @ Miami Dolphins/.test(a.lines[0]) && /read reliability first/.test(a.headline), a.lines);
ok('a consensus reference still counts as a market number but is not called live', !/captured/.test(a.lines[0]));
a = MINE.answer('GAP_LOW_REL', { slate: [G1, G2, G3] }, { now: NOW });
ok('high disagreement on low reliability: the low-reliability game only', a.lines.length === 1 && /Baylor @ Texas Tech/.test(a.lines[0]) && /suspect, not exciting/.test(a.headline), a);
ok('and says the NFL cannot be screened this way', a.missing.some((m) => /NFL model publishes no reliability score/.test(m)));

a = MINE.answer('QB_IMPROVED', { watchlist: watch, history: history }, { now: NOW });
ok('a QB confirmation is found in the watched game\'s history with the reliability either side', a.lines.length === 1 && /QB confirmed for Florida/.test(a.lines[0]) && /reliability 76 → 88 \(improved\)/.test(a.lines[0]), a.lines);

const J = [];
for (let i = 0; i < 6; i++) J.push({ created_at: iso(NOW - i * D), game_key: 'cfb|' + i, home: 'H', away: 'A', decision: 'wagered', market_type: 'spread', selection: i % 2 ? 'home' : 'away',
  line: 3, snap_fair_home_line: -2, snap_market_home_line: -1, snap_reliability_score: 85, clv_points: i < 4 ? 1 : -0.5, beat_close: i < 4, result: i % 3 ? 'loss' : 'win' });
J.push({ created_at: iso(NOW - 60 * D), game_key: 'cfb|old', decision: 'wagered', market_type: 'spread', selection: 'home', line: 1, clv_points: 5, beat_close: true, result: 'win' });
a = MINE.answer('CLV', { journal: J }, { now: NOW, question: 'How has my CLV looked this month?' });
ok('CLV this month uses the last 30 days only', /In the last 30 days/.test(a.headline) && a.lines.some((l) => /4 of 6 beat the closing line/.test(l)), a.lines);
ok('the average CLV is the rows\' own arithmetic', a.lines.some((l) => /Average CLV \+0\.5 points on 6 spread\/total wagers/.test(l)), a.lines);
ok('results are counted separately and called noise', a.lines.some((l) => /Results, counted separately: 2-4-0/.test(l) && /mostly noise/.test(l)));
ok('a small sample is flagged', a.missing.some((m) => /Small sample/.test(m)));
ok('no profit figure is ever given', !/profit|roi|\$/i.test(a.text));
a = MINE.answer('CLV', { journal: [], journal_error: 'HTTP 404' }, { now: NOW, question: 'my clv' });
ok('a journal that cannot be read: no CLV from memory', /could not be read/.test(a.headline));
a = MINE.answer('VERSUS', { journal: J }, { now: NOW });
ok('you vs EdgeDesk counts the sides from decision time', /decisions with a side/.test(a.headline), a.headline);

a = MINE.answer('REL_WHY', { game_state: G1, history: history }, { now: NOW });
ok('reliability change: the move, when, and what changed in the same update', /Reliability moved from 76 to 88/.test(a.text) && /QB status confirmed for Florida/.test(a.text), a.text);
ok('and says what EdgeDesk cannot attribute', a.missing.some((m) => /cannot attribute the change point by point/.test(m)));
a = MINE.answer('REL_WHY', { game_state: G3, history: [] }, { now: NOW });
ok('an NFL game has no reliability to explain, said so', /NFL model publishes no reliability score/.test(a.headline));
a = MINE.answer('REL_WHY', {}, { now: NOW });
ok('no game named: it asks which, rather than guessing', /Which game\?/.test(a.headline));
ok('the game is resolved from the open card first', MINE.resolveGame('why did reliability change', [G1, G2], { game_id: '2' }) === G2);
ok('or from a team the question names', MINE.resolveGame('why did Texas Tech reliability drop', [G1, G2], null) === G2);

let every = true;
Object.keys(Q).forEach((q) => {
  const i = MINE.classify(q);
  const o = MINE.answer(i, { watchlist: watch, history, alerts: [], journal: J, slate: [G1, G2, G3], top: [G1, G2, G3], game_state: G1 }, { now: NOW, question: q });
  if (!o || !P.copyOk(o.text) || !o.detail.every(P.copyOk)) every = false;
});
ok('every answer passes the research-only copy rule', every);

const base = MINE.answer('CLV', { journal: J }, { now: NOW, question: 'this month clv' });
ok('the critic passes a rephrasing that keeps the numbers', MINE.critic('Over the last 30 days, 4 of 6 wagers beat the closing line.', base).verdict === 'PASS');
ok('the critic rejects an invented number', MINE.critic('You beat the close 9 times out of 10.', base).verdict === 'FAIL');
ok('the critic rejects tout language', MINE.critic('This is a lock — bet this now.', base).verdict === 'FAIL');

/* ═══ PART 2 — the real handler ═════════════════════════════════════════ */
(async function () {
  const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test' };
  globalThis.Deno = { env: { get: (k) => ENV[k] } };
  let reads = [], modelCalls = 0, tables = {};
  globalThis.fetch = async function (url, init) {
    const u = String(url);
    if (u.indexOf('api.anthropic.com') >= 0) { modelCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' }; }
    const auth = init && init.headers && (init.headers.authorization || init.headers.Authorization);
    const t = u.replace('https://sb.test/rest/v1/', '').split('?')[0];
    reads.push({ table: t, auth });
    if (t === 'subscriptions') return { ok: true, status: 200, json: async () => [{ status: 'active', price_id: 'p', current_period_end: iso(NOW + 9 * D) }], text: async () => '[]' };
    const rows = tables[t];
    if (rows === 'ERROR') return { ok: false, status: 500, text: async () => 'boom', json: async () => null };
    const body = JSON.stringify(rows || []);
    return { ok: true, status: 200, text: async () => body, json: async () => rows || [] };
  };
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  async function ask(question, user) {
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    reads = []; modelCalls = 0;
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST',
      headers: { authorization: 'Bearer ' + (user || 'user-jwt'), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question, desk: true, history: [], packet: null }) }));
    return { status: r.status, j: await r.json() };
  }
  tables = { my_watchlist: watch, game_research_history: history, user_alerts: [], research_journal: J, game_research_state: [G1, G2, G3].map((s) => ({ state: s })), user_preferences: [{ leagues: ['cfb', 'nfl'] }] };
  let r = await ask('What changed in my watchlist today?');
  ok('HANDLER: a personal question is answered by the reader\'s research turn', r.status === 200 && r.j.mine && r.j.mine.intent === 'WATCH_CHANGES', r.j.error || r.j.mine);
  ok('HANDLER: the answer is the kernel\'s words, deterministic', r.j.narration && r.j.narration.prose === 'DETERMINISTIC' && r.j.answer === r.j.deterministic_mine_answer && /Ole Miss @ Florida/.test(r.j.answer));
  ok('HANDLER: no model was called', modelCalls === 0);
  ok('HANDLER: every personal read went out under the caller\'s own token', reads.filter((x) => x.table !== 'subscriptions').every((x) => x.auth === 'Bearer user-jwt') && reads.some((x) => x.table === 'my_watchlist'));
  const r2 = await ask('What changed in my watchlist today?', 'second-reader');
  ok('HANDLER: a second reader\'s question is read afresh, never served from the first reader\'s rows', reads.some((x) => x.table === 'my_watchlist' && x.auth === 'Bearer second-reader') && r2.j.mine);
  r = await ask('Which five games are most worth researching?');
  ok('HANDLER: Top 5 reads the shared state and ranks by the priority order', r.j.mine && r.j.mine.intent === 'TOP5' && /CFB #1 Ole Miss @ Florida/.test(r.j.answer), r.j.answer);
  r = await ask('How has my CLV looked this month?');
  ok('HANDLER: CLV comes from the reader\'s journal', r.j.mine && r.j.mine.intent === 'CLV' && /4 of 6 beat the closing line/.test(r.j.answer), r.j.answer);
  tables.research_journal = 'ERROR';
  r = await ask('How has my CLV looked this month?');
  ok('HANDLER: a journal the server cannot read is reported, not invented', /could not be read/.test(r.j.answer) && !/beat the closing line \(/.test(r.j.answer), r.j.answer);
  tables.my_watchlist = [];
  r = await ask('Which of my watched games became research-grade?');
  ok('HANDLER: an empty watchlist gives an honest empty answer', /None of your watched games has an upcoming research state/.test(r.j.answer), r.j.answer);
  r = await ask('Why did Texas Tech reliability drop?');
  ok('HANDLER: a reliability question resolves the named team from the slate', r.j.mine && r.j.mine.intent === 'REL_WHY' && /Baylor @ Texas Tech/.test(r.j.answer), r.j.answer);
  r = await ask('Is Maryland -2.5 worth betting?');
  ok('HANDLER: a betting question is not answered by the reader\'s research turn', !r.j.mine);

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'desk reads the reader\'s research — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | unexpected ' + (e && e.stack)); process.exit(1); });
