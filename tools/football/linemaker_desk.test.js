#!/usr/bin/env node
/* ===========================================================================
   The linemaker on the desk: football/linemaker/desk.js against the
   committed fair-line sheets, then through the real edge function handler
   (supabase/functions/edgedesk_ai/index.ts, the sheet served from a stubbed
   site, no model).

   Proves: it answers team totals and alternate lines and nothing else (a
   player prop and a general question pass through); it places the game from
   the question (full name, an NFL nickname, the team's NEXT game) or from
   the game on the reader's screen, and refuses an ambiguous name; every
   number it states is on the sheet; a quoted price is checked through
   lib/edgedesk_fairline.js; a team total is never VALUE; and the handler
   answers deterministically, with no model call, the route and the subject.

   Run: node tools/football/linemaker_desk.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const D = require(path.join(ROOT, 'football', 'linemaker', 'desk.js'));
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const FEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'linemaker', 'fair_lines.json'), 'utf8'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }

const nfl = FEED.games.filter((g) => g.league === 'NFL');
const cfb = FEED.games.filter((g) => g.league === 'CFB');
const g = nfl[0], nick = g.home.split(' ').pop();
const now = Date.parse(FEED.generated_at) + 60000;

/* 1. the gate */
ok('a team-total question is recognised', D.classify('What is the ' + nick + ' team total?').intent === 'TEAM_TOTAL');
ok('"how many points will" is a team-total question', D.classify('How many points will the ' + nick + ' score?').intent === 'TEAM_TOTAL');
ok('an alternate total is recognised with its side and line', JSON.stringify(D.classify('alt total over 50.5 +150').quote) === JSON.stringify({ american: 150, side: 'over', line: 50.5 }));
ok('an alternate spread is recognised with its line and price', JSON.stringify(D.classify('alt spread ' + nick + ' -10.5 at +180').quote) === JSON.stringify({ american: 180, line: -10.5 }));
ok('a player prop is not this desk’s question', D.classify('alt line for Bijan Robinson rushing yards') === null && D.classify('team total of receptions for the Jets receivers') === null);
ok('a general question passes through', D.classify('Who wins the Super Bowl?') === null && D.classify('What is the fair price for the Jets?') === null);

/* 2. placing the game */
const r1 = D.resolveGame('What is the ' + nick + ' team total?', FEED, null);
ok('an NFL nickname places the team’s game', r1.game && r1.game.home === g.home, r1.why);
const allGames = nfl.filter((x) => x.home === g.home || x.away === g.home).sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
ok('a team on two upcoming weeks means its NEXT game', r1.game && r1.game.game_id === allGames[0].game_id, { got: r1.game && r1.game.game_id, want: allGames[0].game_id });
const r2 = D.resolveGame('team total ' + g.away + ' at ' + g.home, FEED, null);
ok('both full names place exactly that game', r2.game && r2.game.game_id === g.game_id && r2.via === 'named');
const c = cfb[0];
ok('a college team by its full name', D.resolveGame('team total for ' + c.home, FEED, null).game.home === c.home);
const r3 = D.resolveGame('team totals', FEED, { game_id: c.game_id, from_screen: true });
ok('no team named: the game on the reader’s screen', r3.game && r3.game.game_id === c.game_id && r3.via === 'screen');
ok('no team named and nothing open: no game, and the reason', !D.resolveGame('team totals', FEED, null).game && /no game is named/.test(D.resolveGame('team totals', FEED, null).why));
const named = D._named(' texas state at texas ', 'Texas', 'CFB');
ok('a short name inside a longer one is still found on its own (word boundary)', !!named);

/* 3. the answers */
const a1 = D.answer('What is the ' + nick + ' team total?', D.classify('What is the ' + nick + ' team total?'), FEED, r1, now);
const tt = r1.game.markets.team_total;
const fairHome = r1.game.home === g.home ? tt.home_fair_half : tt.away_fair_half;
ok('the team-total answer states the sheet’s fair number', a1.text.indexOf('is ' + fairHome + '.') >= 0, a1.text);
ok('and says team totals were never tested at a market number', /never been tested at a number the market posted/.test(a1.text));
ok('and carries the rungs around it', a1.block.rungs.length >= 5 && a1.block.intent === 'TEAM_TOTAL');
/* every percentage stated is a probability on the sheet's ladder */
const lad = FL.ladder(r1.game, r1.game.home === g.home ? 'home_team_total' : 'away_team_total');
const pcts = (a1.text.match(/\d+(\.\d)?%/g) || []).map((x) => parseFloat(x) / 100);
const onSheet = new Set([].concat(...lad.map((r) => [r.over, r.push, r.under])).map((x) => Math.round(x * 1000) / 1000));
ok('every percentage it states is on the sheet', pcts.length > 0 && pcts.every((p) => onSheet.has(Math.round(p * 1000) / 1000)), pcts);
const q4 = 'Is ' + nick + ' team total over 5.5 at +400 any good?';
const a4 = D.answer(q4, D.classify(q4), FEED, D.resolveGame(q4, FEED, null), now);
ok('a team total is never VALUE, even at a price far past its fair one', a4.block.price_check && a4.block.price_check.verdict !== 'VALUE' && a4.block.price_check.expected_roi > 0, a4.block.price_check);
const q5 = 'alt spread ' + nick + ' ' + (FEED.games.find((x) => x.game_id === r1.game.game_id).markets.spread.fair_home_line_half * (r1.game.home === g.home ? 1 : -1) - 6) + ' at +100';
const a5 = D.answer(q5, D.classify(q5), FEED, D.resolveGame(q5, FEED, null), now);
ok('laying six more than fair at even money is NO VALUE, with the arithmetic', a5.block.price_check && a5.block.price_check.verdict === 'NO_VALUE' && /needs 50% and EdgeDesk gives/.test(a5.text), a5.text);
ok('no answer says BET or PLAY', !/\b(BET|PLAY|lock)\b/.test([a1.text, a4.text, a5.text].join(' ')));
const old = D.answer('team totals', D.classify('team totals'), Object.assign({}, FEED, { generated_at: new Date(now - 30 * 36e5).toISOString() }), r3, now);
ok('a stale sheet says how old it is', /built 30 hours ago/.test(old.text), old.text);
ok('a screen-placed answer says it is about the game on screen', /open on your screen/.test(old.text));

/* 4. through the handler */
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_REQUIRE_SUBSCRIPTION: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let modelCalls = 0;
const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: () => null } });
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) { modelCalls++; return J(200, { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'model' }] }); }
  if (u.indexOf('https://site.test/football/linemaker/fair_lines.json') === 0) return J(200, FEED);
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
  let r = await ask('What is the ' + nick + ' team total?');
  ok('the handler answers a team-total question from the sheet', r.status === 200 && r.body.desk && r.body.desk.intent === 'LINES' && r.body.lines && r.body.lines.intent === 'TEAM_TOTAL', { status: r.status, intent: r.body.desk && r.body.desk.intent });
  ok('deterministically: no model call', modelCalls === 0 && r.body.narration.prose === 'DETERMINISTIC', modelCalls);
  ok('with the source and the subject it used', r.body.lines.source === 'football/linemaker/fair_lines.json' && r.body.research.research_context.game_id === String(r1.game.game_id));
  ok('and the route (a deterministic question is LITE)', r.body.route && r.body.route.tier === 'LITE');
  r = await ask('team totals', { research_context: { screen: { panel: 'lines', sport: c.sport, game_id: c.game_id, market: 'team_total' }, sport: c.sport, game_id: c.game_id, from_screen: true } });
  ok('a question naming no team reads the game on screen', r.body.lines && r.body.lines.game_id === c.game_id && r.body.lines.resolved_via === 'screen', r.body.lines);
  modelCalls = 0;
  r = await ask('alt line for Bijan Robinson rushing yards');
  ok('a player-prop question is not answered here', !(r.body.desk && r.body.desk.intent === 'LINES'), r.body.desk && r.body.desk.intent);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'linemaker desk — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
