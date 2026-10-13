#!/usr/bin/env node
/* ===========================================================================
   The NHL on the desk: hockey/desk.js against the committed slate, then
   through the real edge function handler (supabase/functions/edgedesk_ai/
   index.ts, the slate served from a stubbed site, no model).

   Proves: it answers NHL questions and nothing else (an NFL, NBA or MLB
   question with a shared nickname passes through); it places the game from
   two clubs, one club's next game, or the NHL game on screen, and never
   prices a different game when two named clubs do not meet; a quoted price
   is checked at its break-even with pushes; every answer says value claims
   are off and never says "bet" as a recommendation; a slate-wide question is
   PASS with the reason; a missing slate is said, never filled; and the
   handler answers deterministically, before the out-of-scope answer that
   predates the NHL brain.

   Run: node tools/hockey/nhl_desk.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const D = require(path.join(ROOT, 'hockey', 'desk.js'));
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8'));
const TEAMS = require(path.join(ROOT, 'hockey', 'data', 'teams.json')).teams;
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
const now = Date.parse(SLATE.generated_at) + 60000;
const g = SLATE.games[0];
const nick = (abbr) => D.CLUBS[abbr].filter((n) => n.split(' ').length === 1)[0] || D.CLUBS[abbr][0];

/* 1. the gate */
ok('every active club in hockey/data/teams.json is known to the desk', Object.keys(TEAMS).filter((a) => !TEAMS[a].inactive_since).every((a) => D.CLUBS[a]), Object.keys(TEAMS).filter((a) => !TEAMS[a].inactive_since && !D.CLUBS[a]));
ok('a club nickname makes an NHL question', D.classify('What is your price on the Bruins?').intent === 'NHL_GAME');
ok('"hockey" with no club is a slate question', D.classify('best hockey bets tonight?').intent === 'NHL_SLATE');
ok('a shared nickname needs hockey context (Rangers, Jets, Kings, Panthers)', D.classify('Rangers moneyline') === null && D.classify('Jets vs Bills') === null && D.classify('Kings tonight') === null && D.classify('Panthers -3') === null);
ok('...and counts with it', D.classify('Rangers moneyline in hockey').clubs[0].abbr === 'NYR' && D.classify('NHL Jets total').clubs[0].abbr === 'WPG');
ok('a city counts only with hockey context (Detroit is also the Lions)', D.classify('Detroit -3') === null && D.classify('Detroit -140 in the NHL').clubs[0].abbr === 'DET');
ok('another league named outright is not ours', D.classify('NFL Jets total') === null && D.classify('Lakers odds in the NBA') === null && D.classify('Texas Rangers baseball line') === null);
ok('a cross-sport question is left to the all-sports scan', D.classify('best bets across all sports, hockey included?') === null);
ok('the NHL game on screen makes a bare price question ours', D.classify('what is the fair line?', { screen_panel: 'nhl', game_id: String(g.game_id) }).intent === 'NHL_GAME');
ok('a quoted moneyline, puck line and total are read', JSON.stringify(D.classify('Bruins -140').quote) === JSON.stringify({ american: -140, market: 'moneyline' })
  && D.classify('Penguins -1.5 +180').quote.market === 'puck_line' && D.classify('Penguins -1.5 +180').quote.pl === 'minus'
  && JSON.stringify(D.classify('over 6.5 -110 Bruins').quote) === JSON.stringify({ american: -110, market: 'total', side: 'over', line: 6.5 }));

/* 2. the game */
const r2 = D.answer(g.away + ' at ' + g.home + ' NHL price', SLATE, null, now);
ok('two clubs place their game', r2 && r2.block.game_id === g.game_id && r2.block.resolved_via === 'both clubs', r2 && r2.block);
const one = D.answer(nick(g.home) + ' moneyline', SLATE, null, now);
ok('one club places its next game', one && one.block.game_id === SLATE.games.find((x) => x.home === g.home || x.away === g.home).game_id);
const other = Object.keys(D.CLUBS).find((a) => a !== g.home && a !== g.away && !SLATE.games.some((x) => (x.home === g.home && x.away === a) || (x.away === g.home && x.home === a)));
const none = D.answer(nick(g.home) + ' at ' + nick(other) + ' nhl', SLATE, null, now);
ok('two clubs that do not meet are said, never another game priced', none && none.block.game_id == null && /no upcoming game between/.test(none.text), none && none.text);
const scr = D.answer('what is the fair total?', SLATE, { screen_panel: 'nhl', game_id: String(g.game_id) }, now);
ok('the game on screen is used when the question names none', scr && scr.block.game_id === g.game_id && scr.block.resolved_via === 'screen');
ok('every number stated is the slate\'s', r2.text.indexOf((g.prices.moneyline.home >= 0.5 ? g.home : g.away) + ' ' + ((x) => (x > 0 ? '+' : '') + x)(g.prices.moneyline.home >= 0.5 ? g.prices.moneyline.fair_home : g.prices.moneyline.fair_away)) >= 0 && r2.text.indexOf('fair line ' + g.prices.total.fair_line) >= 0);
ok('it says value claims are off and what could change the number', /not been tested against closing prices/.test(r2.text) && /What could change it/.test(r2.text) && /Research, not picks/.test(r2.text));
ok('it never recommends a bet', !/\b(bet it|take it|lock|hammer|play it|you should bet|recommend(ed)? bet)\b/i.test(r2.text));

/* 3. a price */
const fav = g.prices.moneyline.home >= 0.5 ? 'home' : 'away';
const pc = D.priceCheck(g, { american: -150, market: 'moneyline' }, fav);
ok('the moneyline check is break-even and EV at the quoted price', Math.abs(pc.break_even - 0.6) < 1e-4 && Math.abs(pc.ev - (g.prices.moneyline[fav] * (1 + 100 / 150) - 1)) < 1e-3, pc);
const tl = g.prices.total.lines['6'];
const tc = D.priceCheck(g, { american: -110, market: 'total', side: 'over', line: 6 }, null);
ok('a whole-number total counts its push', Math.abs(tc.break_even - (1 - tl.push) / (1 + 100 / 110)) < 1e-4 && tc.push === tl.push, tc);
const q3 = D.answer(nick(g[fav]) + ' -150 nhl', SLATE, null, now);
ok('a quoted price is answered with "not calling it a bet"', /break-even is 60%/.test(q3.text) && /not calling it a bet/.test(q3.text), q3.text);

/* 4. the slate, and no slate */
const sl = D.answer('best NHL bet tonight?', SLATE, null, now);
ok('a slate question is PASS with the reason, and lists fair lines', sl.block.intent === 'NHL_SLATE' && /^PASS on the NHL/.test(sl.text) && sl.block.games.length > 0);
const ns = D.answer('Bruins price', null, null, now);
ok('a missing slate is said, never filled', ns.block.intent === 'NHL_UNAVAILABLE' && /could not be read/.test(ns.text));

/* 5. through the handler */
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_REQUIRE_SUBSCRIPTION: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let modelCalls = 0, slateReads = 0;
const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: () => null } });
globalThis.fetch = async function (url) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) { modelCalls++; return J(200, { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'model' }] }); }
  if (u.indexOf('https://site.test/hockey/slate.json') === 0) { slateReads++; return J(200, SLATE); }
  if (u.indexOf('/rest/v1/rpc/ai_usage_claim') >= 0) return J(404, {});
  return J(404, null);
};
(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  /* the handler's clock is the real one: pin a question to a game still ahead of it, if any */
  const ahead = SLATE.games.find((x) => Date.parse(x.start_utc) > Date.now());
  async function ask(question, extra) {
    m.resetRateLimit(); if (m.clearCache) m.clearCache();
    const res = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' }, body: JSON.stringify(Object.assign({ mode: 'chat', question }, extra || {})) }));
    return { status: res.status, body: await res.json() };
  }
  modelCalls = 0;
  let r = await ask('best NHL bet tonight?', { desk: true });
  ok('the handler answers an NHL slate question from the slate', r.status === 200 && r.body.desk && r.body.desk.intent === 'NHL' && r.body.nhl && r.body.nhl.source === 'hockey/slate.json', { status: r.status, intent: r.body.desk && r.body.desk.intent, answer: String(r.body.answer).slice(0, 200) });
  ok('deterministically: no model call, read once', modelCalls === 0 && r.body.narration.prose === 'DETERMINISTIC' && slateReads >= 1, { modelCalls, slateReads });
  ok('before the out-of-scope answer that predates the NHL brain', !/NHL is not covered|NHL are not covered/i.test(String(r.body.answer)));
  if (ahead) {
    r = await ask(ahead.away + ' at ' + ahead.home + ' NHL price');
    ok('a game question names the game it priced', r.body.nhl && r.body.nhl.game_id === ahead.game_id && r.body.research.research_context.sport === 'icehockey_nhl', r.body.nhl);
  } else console.log('NOTE | every committed game has started on the real clock; the game-level handler check was skipped');
  modelCalls = 0;
  r = await ask('What is the Jets team total vs the Bills?');
  ok('a football question is not answered here', !(r.body.desk && r.body.desk.intent === 'NHL'), r.body.desk && r.body.desk.intent);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL desk — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
