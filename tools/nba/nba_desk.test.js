#!/usr/bin/env node
/* ===========================================================================
   The NBA on the desk: nba/desk.js against the committed slate, then through
   the real edge function handler (supabase/functions/edgedesk_ai/index.ts,
   the slate served from a stubbed site, no model).

   Proves: it answers NBA questions and nothing else (an NHL, NFL, college or
   MLB question with a shared nickname passes through); a shared nickname or a
   city needs basketball context; it places the game from two teams, one
   team's next game, or the NBA game on screen, and never prices a different
   game when two named teams do not meet; a quoted moneyline, spread and total
   are checked at their break-even with pushes; every answer says value claims
   are off and never recommends a bet; a slate-wide question is PASS with the
   reason; a missing slate is said, never filled; the handler answers
   deterministically after the NHL turn.

   Run: node tools/nba/nba_desk.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const D = require(path.join(ROOT, 'nba', 'desk.js'));
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'slate.json'), 'utf8'));
const TEAMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'data', 'teams.json'), 'utf8'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
const now = Date.parse(SLATE.generated_at) + 60000;
const nick = (id) => D.TEAMS[id].filter((n) => n.split(' ').length === 1)[0] || D.TEAMS[id][0];

/* 1. the gate */
const active = Object.keys(TEAMS).filter((id) => Number(id) >= 1 && Number(id) <= 30);
ok('every NBA team in nba/data/teams.json is known to the desk', active.every((id) => D.TEAMS[id]), active.filter((id) => !D.TEAMS[id]));
ok('a team nickname makes an NBA question', D.classify('What is your price on the Celtics?').intent === 'NBA_GAME');
ok('"NBA" with no team is a slate question', D.classify('best NBA bets tonight?').intent === 'NBA_SLATE');
ok('a shared name needs basketball context (Kings, Heat, Magic, Wolves, Cavaliers)', D.classify('Kings tonight') === null && D.classify('heat wave tomorrow') === null && D.classify('Magic number?') === null && D.classify('Wolves -1') === null && D.classify('Cavaliers -3') === null);
ok('...and counts with it', D.classify('Kings moneyline in the NBA').teams[0].id === '23' && D.classify('basketball: Heat -4').teams[0].id === '14');
ok('a city counts only with basketball context (Boston is also the Bruins)', D.classify('Boston -5') === null && D.classify('Boston -5 nba').teams[0].id === '2');
ok('another league named outright is not ours', D.classify('Kings vs Ducks NHL') === null && D.classify('Celtics college basketball line') === null && D.classify('Texas Rangers baseball line') === null);
ok('a cross-sport question is left to the all-sports scan', D.classify('best bets across all sports, NBA included?') === null);
ok('the NBA game on screen makes a bare price question ours', SLATE.games.length === 0 || D.classify('what is the fair line?', { screen_panel: 'nba', game_id: String(SLATE.games[0].game_id) }).intent === 'NBA_GAME');
ok('a quoted moneyline, spread and total are read', JSON.stringify(D.classify('Lakers +140').quote) === JSON.stringify({ market: 'moneyline', american: 140 })
  && JSON.stringify(D.classify('Denver -6.5 -110 nba').quote) === JSON.stringify({ market: 'spread', line: -6.5, american: -110 })
  && D.classify('over 228.5 -105 Warriors').quote.market === 'total' && D.classify('over 228.5 -105 Warriors').quote.line === 228.5 && D.classify('over 228.5 -105 Warriors').quote.american === -105);

/* 2. the game, a price, the slate */
if (SLATE.games.length) {
  const g = SLATE.games[0];
  const r2 = D.answer(nick(String(g.away.id)) + ' at ' + nick(String(g.home.id)) + ' price', SLATE, null, now);
  ok('two teams place their game', r2 && r2.block.game_id === g.game_id && r2.block.resolved_via === 'both teams', r2 && r2.block);
  const fav = g.price.moneyline.home >= 0.5 ? 'home' : 'away';
  ok('every number stated is the slate\'s', r2.text.indexOf('fair total ' + g.price.total.fair_line) >= 0 && r2.text.indexOf(String(Math.abs(g.price.moneyline[fav + '_american']))) >= 0, r2.text);
  ok('it says value claims are off and never recommends a bet', /never been tested against closing prices/.test(r2.text) && /Research, not picks/.test(r2.text) && !/\b(bet it|take it|lock|hammer|play it|you should bet)\b/i.test(r2.text));
  const pc = D.priceCheck(g, { market: 'moneyline', american: -150 }, fav);
  ok('the moneyline check is break-even and EV at the quoted price', Math.abs(pc.break_even - 0.6) < 1e-4 && Math.abs(pc.ev - (g.price.moneyline[fav] * (1 + 100 / 150) - 1)) < 1e-3, pc);
  const whole = g.price.spread.ladder.find((x) => Number.isInteger(x.line_home) && x.push > 0);
  if (whole) { const sc = D.priceCheck(g, { market: 'spread', line: whole.line_home, american: -110 }, 'home'); ok('a whole-number spread counts its push', Math.abs(sc.break_even - (1 - whole.push) / (1 + 100 / 110)) < 1e-4 && sc.push === whole.push, sc); }
  const out = D.priceCheck(g, { market: 'spread', line: -40.5, american: -110 }, 'home');
  ok('a line outside the sheet is said, not invented', out && out.error && /outside/.test(out.error), out);
  const other = active.find((id) => id !== String(g.home.id) && id !== String(g.away.id) && !SLATE.games.some((x) => (String(x.home.id) === String(g.home.id) && String(x.away.id) === id) || (String(x.away.id) === String(g.home.id) && String(x.home.id) === id)));
  const none = D.answer(nick(String(g.home.id)) + ' vs ' + nick(other) + ' nba', SLATE, null, now);
  ok('two teams that do not meet are said, never another game priced', none && none.block.game_id == null && /no upcoming game between/.test(none.text), none && none.text);
}
const sl = D.answer('best NBA bet tonight?', SLATE, null, now);
ok('a slate question is PASS with the reason', sl.block.intent === 'NBA_SLATE' && /^PASS on the NBA/.test(sl.text));
const ns = D.answer('Celtics price', null, null, now);
ok('a missing slate is said, never filled', ns.block.intent === 'NBA_UNAVAILABLE' && /could not be read/.test(ns.text));

/* 3. through the handler */
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_REQUIRE_SUBSCRIPTION: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let modelCalls = 0, slateReads = 0;
const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: () => null } });
globalThis.fetch = async function (url) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) { modelCalls++; return J(200, { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'model' }] }); }
  if (u.indexOf('https://site.test/nba/slate.json') === 0) { slateReads++; return J(200, SLATE); }
  if (u.indexOf('https://site.test/hockey/slate.json') === 0) return J(200, JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8')));
  if (u.indexOf('/rest/v1/rpc/ai_usage_claim') >= 0) return J(404, {});
  return J(404, null);
};
(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  async function ask(question, extra) {
    m.resetRateLimit(); if (m.clearCache) m.clearCache();
    const res = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' }, body: JSON.stringify(Object.assign({ mode: 'chat', question }, extra || {})) }));
    return { status: res.status, body: await res.json() };
  }
  modelCalls = 0;
  let r = await ask('best NBA bet tonight?', { desk: true });
  ok('the handler answers an NBA slate question from the slate', r.status === 200 && r.body.desk && r.body.desk.intent === 'NBA' && r.body.nba && r.body.nba.source === 'nba/slate.json', { status: r.status, intent: r.body.desk && r.body.desk.intent, answer: String(r.body.answer).slice(0, 200) });
  ok('deterministically: no model call', modelCalls === 0 && r.body.narration.prose === 'DETERMINISTIC' && slateReads >= 1, { modelCalls, slateReads });
  r = await ask('best NHL bet tonight?', { desk: true });
  ok('an NHL question still goes to the NHL desk', r.body.desk && r.body.desk.intent === 'NHL', r.body.desk && r.body.desk.intent);
  r = await ask('What is the Jets team total vs the Bills?');
  ok('a football question is not answered here', !(r.body.desk && r.body.desk.intent === 'NBA'), r.body.desk && r.body.desk.intent);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NBA desk — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
