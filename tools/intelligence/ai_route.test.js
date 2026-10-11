#!/usr/bin/env node
/* ===========================================================================
   The AI desk's shared allowance and route, through the real handler
   (supabase/functions/edgedesk_ai/index.ts) with the database and the model
   stubbed:
     - a spent LITE allowance is a 429 with the reason, before any model call;
     - a QUICK question claims LITE only, runs LITE (capped answer, no tool
       loop) and says so in `route`;
     - a deeper question claims PRO; granted, it runs the full pipeline and
       the route says PRO; the claim is settled with the model's tokens;
     - a spent PRO allowance is DOWNGRADED: answered the LITE way, with the
       LITE model when one is configured, the reason in `route.why`;
     - an allowance that is not applied (404) or unreachable is UNMETERED and
       the question is still answered;
     - ?probe=1 describes the route.
   Run: node tools/intelligence/ai_route.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }

const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test',
  EDGEDESK_REQUIRE_SUBSCRIPTION: '0', EDGEDESK_AI_LITE_MODEL: 'lite-model-test', EDGEDESK_INVESTIGATE: '1' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

let claimMode = { LITE: 'grant', PRO: 'grant' };
let claims = [], settles = [], modelCalls = [];
let nextId = 1;
const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) {
    const b = JSON.parse(init.body); modelCalls.push(b);
    return J(200, { model: b.model, stop_reason: 'end_turn', usage: { input_tokens: 1234, output_tokens: 321 }, content: [{ type: 'text', text: 'An answer.' }] });
  }
  if (u.indexOf('/rest/v1/rpc/ai_usage_claim') >= 0) {
    const b = JSON.parse(init.body); claims.push(b.p_route);
    const m = claimMode[b.p_route];
    if (m === 'missing') return J(404, { message: 'function not found' });
    if (m === 'down') throw new TypeError('fetch failed');
    if (m === 'refuse') return J(200, { ok: false, route: b.p_route, status: 'REFUSED', limit: 3, reason: 'the daily allowance of 3 questions is spent; it resets at 00:00 UTC' });
    if (m === 'downgrade') return J(200, { ok: true, route: 'LITE', status: 'DOWNGRADED', used: 5, limit: 5, event_id: nextId++, reason: 'the daily allowance of 5 full-research questions is spent; this one is answered from EdgeDesk’s cached research' });
    return J(200, { ok: true, route: b.p_route, status: 'CLAIMED', used: 1, limit: 99, event_id: nextId++ });
  }
  if (u.indexOf('/rest/v1/rpc/ai_usage_settle') >= 0) { settles.push(JSON.parse(init.body)); return J(200, { ok: true }); }
  return J(404, null);
};

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  async function ask(question, extra) {
    claims = []; settles = []; modelCalls = [];
    m.resetRateLimit(); if (m.clearCache) m.clearCache();
    const res = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' },
      body: JSON.stringify(Object.assign({ mode: 'chat', question }, extra || {})) }));
    await new Promise((r) => setTimeout(r, 30));
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  ok('the tiers: QUICK is LITE, everything deeper is PRO', m.routeTier('QUICK') === 'LITE' && ['STANDARD', 'DEEP', 'SLATE', 'FULL'].every((d) => m.routeTier(d) === 'PRO'));

  /* 1. LITE spent: refused before any work */
  claimMode = { LITE: 'refuse', PRO: 'grant' };
  let r = await ask('Give me a deep dive on every college game this week.');
  ok('a spent LITE allowance is a 429 with the reason', r.status === 429 && /resets at 00:00 UTC/.test(r.body.note) && r.body.route && r.body.route.status === 'REFUSED', r);
  ok('and no model call and no PRO claim', modelCalls.length === 0 && claims.join() === 'LITE', claims);

  /* 2. PRO granted */
  claimMode = { LITE: 'grant', PRO: 'grant' };
  r = await ask('Give me a deep dive on every college game this week.');
  const proRan = claims.indexOf('PRO') >= 0;
  ok('a deeper question claims LITE then PRO', claims[0] === 'LITE' && proRan, claims);
  ok('granted, it runs as PRO with the default model', r.body && r.body.route && r.body.route.tier === 'PRO' && modelCalls.length >= 1 && modelCalls[0].model !== 'lite-model-test', { route: r.body && r.body.route, model: modelCalls[0] && modelCalls[0].model });
  const proSettle = settles.find((x) => x.p_tokens_in === 1234);
  ok('the PRO claim is settled with the model’s tokens', !!proSettle && proSettle.p_tokens_out === 321 && proSettle.p_outcome === 'answered', settles);
  ok('both claims are settled exactly once', settles.length === 2 && new Set(settles.map((x) => x.p_event_id)).size === 2, settles);

  /* 3. PRO spent: downgraded */
  claimMode = { LITE: 'grant', PRO: 'downgrade' };
  r = await ask('Give me a deep dive on every college game this week.');
  ok('a spent PRO allowance is answered the LITE way and says why', r.body && r.body.route && r.body.route.tier === 'LITE' && r.body.route.status === 'DOWNGRADED' && /full-research questions is spent/.test(r.body.route.why), r.body && r.body.route);
  ok('with the LITE model and a capped answer', modelCalls.length >= 1 && modelCalls[0].model === 'lite-model-test' && modelCalls[0].max_tokens <= 1600, modelCalls[0] && { model: modelCalls[0].model, max: modelCalls[0].max_tokens });
  ok('and no tool definitions are sent', modelCalls.every((b) => !b.tools));
  ok('the LITE claim carries the tokens of a downgraded question', settles.some((x) => x.p_tokens_in === 1234), settles);

  /* 4. QUICK: LITE only */
  claimMode = { LITE: 'grant', PRO: 'grant' };
  r = await ask('What price makes it a pass?');
  ok('a QUICK question claims LITE only', claims.join() === 'LITE', claims);
  ok('and is labelled LITE', r.body && r.body.route && r.body.route.tier === 'LITE' && /no outside lookup/.test(r.body.route.note), r.body && r.body.route);

  /* 5. not applied / unreachable: UNMETERED, still answered */
  claimMode = { LITE: 'missing', PRO: 'missing' };
  r = await ask('Give me a deep dive on every college game this week.');
  ok('an allowance that is not applied is UNMETERED and the question is answered', r.status === 200 && r.body.route && r.body.route.metered === false && modelCalls.length >= 1, { status: r.status, route: r.body && r.body.route });
  claimMode = { LITE: 'down', PRO: 'down' };
  r = await ask('Give me a deep dive on every college game this week.');
  ok('an unreachable allowance is UNMETERED and the question is answered', r.status === 200 && r.body.route && r.body.route.metered === false, { status: r.status, route: r.body && r.body.route });
  ok('and nothing is settled for a claim that was never made', settles.length === 0, settles);

  const probe = await (await m.handle(new Request('https://fn.test/edgedesk_ai?probe=1'))).json();
  ok('?probe=1 describes the route', probe.ai_usage && probe.ai_usage.enabled === true && probe.ai_usage.lite_model === 'lite-model-test' && probe.ai_usage.lite_depths.join() === 'QUICK', probe.ai_usage);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'ai route — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
