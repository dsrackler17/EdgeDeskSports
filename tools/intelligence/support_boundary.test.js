#!/usr/bin/env node
/* ===========================================================================
   The desk's SUPPORT BOUNDARY for retired sports (lib/edgedesk_sports.js).

   Tennis is not a product EdgeDesk offers today. The deployed edgedesk_ai
   file — not a copy — is imported under a Deno shim with a mocked network, and
   asked the questions a reader actually types. What is held:

     - a tennis research / betting question is answered with the boundary
       sentence, deterministically: no model call, no research packet
     - a turn whose open packet is a tennis game is answered the same way
     - a question naming only players reaches the model, and the model's
       system prompt carries the SUPPORT BOUNDARY rule with the same sentence
     - a question plainly about history is NOT refused: the word is not banned
     - football, UFC and baseball questions are untouched

   Run: node tools/intelligence/support_boundary.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const EDSPORTS = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_sports.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}

const ENV = {
  EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key',
  SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key',
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

let modelCalls = [];
let dbReads = [];
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) {
    const body = JSON.parse(init.body);
    modelCalls.push(body);
    const out = { content: [{ type: 'text', text: 'A short research read.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  }
  if (u.indexOf('sb.test') >= 0) {
    if (u.indexOf('/subscriptions') < 0) dbReads.push(u);
    if (u.indexOf('/subscriptions') >= 0) {
      const sub = [{ status: 'active', price_id: 'price_test', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString() }];
      return { ok: true, status: 200, text: async () => JSON.stringify(sub), json: async () => sub };
    }
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '', json: async () => null };
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  }
  return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
};

function req(body) {
  return new Request('https://fn.test/edgedesk_ai', {
    method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function gamePacket(sportKey, away, home) {
  return { game: { matchup: away + ' @ ' + home, sport: sportKey, sport_key: sportKey, away, home, commence: new Date(Date.now() + 864e5).toISOString() } };
}

(async function main() {
  const m = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const TENNIS = EDSPORTS.RETIRED.find((r) => r.id === 'tennis');
  const SENTENCE = EDSPORTS.unsupportedAnswer(TENNIS);
  chk('the boundary sentence names the sport and what IS covered',
    /^Tennis is not currently supported by EdgeDesk Research\./.test(SENTENCE) && /Football, UFC and Baseball/.test(SENTENCE), SENTENCE);

  async function ask(body) {
    modelCalls = []; dbReads = [];
    const r = await m.handle(req(Object.assign({ mode: 'ask', history: [] }, body)));
    return { status: r.status, j: await r.json(), modelCalls: modelCalls.slice(), dbReads: dbReads.slice() };
  }

  /* 1. the reader's own words */
  for (const q of ['Who has value in this ATP match?', 'Best WTA bets today?', 'Any tennis edges this week?', 'Who wins at Wimbledon?']) {
    const { j, modelCalls: mc, dbReads: reads } = await ask({ question: q });
    chk('"' + q + '" is answered with the boundary sentence', j.answer === SENTENCE, j.answer);
    chk('"' + q + '" spends no model call', mc.length === 0, mc.length);
    chk('"' + q + '" is answered before retrieval: no read beyond the entitlement check', reads.length === 0, reads);
    chk('"' + q + '" builds no research packet', !j.research && !j.research_packet, Object.keys(j));
    chk('"' + q + '" says why, and names the coverage', j.support_boundary && j.support_boundary.sport === 'tennis'
      && j.support_boundary.coverage.join() === 'Football,UFC,Baseball', j.support_boundary);
  }
  /* the desk client path (`desk: true`) is gated before the desk turn too */
  {
    const { j, modelCalls: mc } = await ask({ question: 'Best WTA bets today?', desk: true });
    chk('the desk client gets the same boundary', j.answer === SENTENCE && mc.length === 0, j.answer);
  }

  /* 2. the open packet is a tennis game, and the question names only players */
  {
    const { j, modelCalls: mc } = await ask({ question: 'Research Alcaraz vs Sinner', packet: gamePacket('tennis_atp_us_open', 'Carlos Alcaraz', 'Jannik Sinner') });
    chk('an open tennis packet is answered with the boundary', j.answer === SENTENCE && mc.length === 0, j.answer);
    chk('and says the turn resolved to the retired sport', /resolved/.test(j.support_boundary && j.support_boundary.reason || ''), j.support_boundary);
  }

  /* 3. a question naming only players, with nothing resolved: the model is the
        last line, and its system prompt carries the rule with the same sentence */
  {
    const { j, modelCalls: mc } = await ask({ question: 'Research Alcaraz vs Sinner' });
    chk('a players-only question reaches the model', mc.length >= 1, mc.length);
    const sys = mc.length ? String(mc[0].system || '') : '';
    chk('and the system prompt carries the SUPPORT BOUNDARY rule', /SUPPORT BOUNDARY\. Tennis is not currently supported by EdgeDesk Research\./.test(sys), sys.slice(0, 200));
    chk('with the exact boundary sentence to reply with', sys.indexOf('"' + SENTENCE + '"') >= 0);
    chk('and leaves the sport free to be mentioned as history', /only as history/.test(sys));
    chk('the turn itself still answers', typeof j.answer === 'string' && j.answer.length > 0, j.answer);
  }

  /* 4. the word is not banned: a history question passes through */
  for (const q of ['Why did you stop covering tennis?', 'Did EdgeDesk used to cover tennis historically?']) {
    const { j, modelCalls: mc } = await ask({ question: q });
    chk('"' + q + '" is not refused by the boundary', j.answer !== SENTENCE && !j.support_boundary, j.answer);
    chk('"' + q + '" reaches the normal pipeline', mc.length >= 1, mc.length);
  }

  /* 5. supported sports are untouched */
  for (const [q, pk] of [
    ['Why does EdgeDesk like the Chiefs?', gamePacket('americanfootball_nfl', 'Baltimore Ravens', 'Kansas City Chiefs')],
    ['How does Texas State look this week?', null],
    ['Who has the edge in the UFC main event?', gamePacket('mma_mixed_martial_arts', 'Fighter A', 'Fighter B')],
    ['Which pitcher is the weakest tonight?', null],
  ]) {
    const { j } = await ask(Object.assign({ question: q }, pk ? { packet: pk } : {}));
    chk('"' + q + '" is not answered with the boundary', j.answer !== SENTENCE && !j.support_boundary, j.answer);
  }

  /* 6. the retrieval-stage check, directly: a turn research resolved to tennis */
  {
    const r = m.retiredSportTurn({ question: 'What about this one?', sportKey: 'tennis_wta_guadalajara_open', stage: 'retrieval' });
    chk('a turn retrieval resolved to a tennis key is answered with the boundary', r && r.answer === SENTENCE && r.support_boundary.stage === 'retrieval', r);
    chk('a football key is not', m.retiredSportTurn({ question: 'What about this one?', sportKey: 'americanfootball_ncaaf' }) === null);
    chk('the response carries the deployed build', r && r.build === m.BUILD, r && r.build);
  }

  failures.forEach(function (f) { console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')); });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) { console.log('FAIL | harness  ' + String(e && e.stack || e).slice(0, 600)); process.exit(1); });
