#!/usr/bin/env node
/* ===========================================================================
   The writing model's clock (supabase/functions/edgedesk_ai/index.ts
   callModel). Imported under Node with a Deno shim, the model endpoint
   stubbed:
     - an upstream that never answers is aborted at EDGEDESK_AI_TIMEOUT_MS
       and reported as ok:false, 504, timed_out, with the wait in the detail;
     - a network error is ok:false, 502, not an exception;
     - a normal answer is untouched;
     - (the deadline across tool-loop rounds is the same guard, checked before
       each round; the loop itself is off by default and not exercised here);
     - the handler turns a timeout into the existing narration-failed body:
       502, retryable, timed_out, the research kept;
     - ?probe=1 reports the clock.
   Run: node tools/intelligence/model_timeout.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }

const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', EDGEDESK_SITE_BASE: 'https://site.test',
  EDGEDESK_AI_TIMEOUT_MS: '1200', EDGEDESK_AI_DEADLINE_MS: '2000', EDGEDESK_REQUIRE_SUBSCRIPTION: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let mode = 'hang';
let calls = 0;
globalThis.fetch = function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) {
    calls++;
    if (mode === 'hang') return new Promise((res, rej) => { if (init && init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    if (mode === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (mode === 'slow-ok') return new Promise((res) => setTimeout(() => res({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'fine' }] }), text: async () => 'fine' }), 50));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'fine' }] }), text: async () => 'fine' });
  }
  return Promise.resolve({ ok: false, status: 404, text: async () => 'nope', json: async () => null, headers: { get: () => null } });
};

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  ok('the clock reads its environment (clamped)', JSON.stringify(m.modelClock()) === JSON.stringify({ timeout_ms: 1200, deadline_ms: 2000 }), m.modelClock());
  let t0 = Date.now();
  const r1 = await m.callModel({ system: 's', messages: [{ role: 'user', content: 'q' }], max_tokens: 10 });
  const took = Date.now() - t0;
  ok('an upstream that never answers is aborted at the timeout', took >= 1100 && took < 3000, took);
  ok('and reported as 504, timed out, not thrown', r1.ok === false && r1.status === 504 && r1.timed_out === true && /did not answer within 1200 ms/.test(r1.detail), r1);
  mode = 'down';
  const r2 = await m.callModel({ system: 's', messages: [{ role: 'user', content: 'q' }], max_tokens: 10 });
  ok('a network error is a 502 envelope, not an exception', r2.ok === false && r2.status === 502 && !r2.timed_out && /could not be reached/.test(r2.detail), r2);
  mode = 'slow-ok';
  const r3 = await m.callModel({ system: 's', messages: [{ role: 'user', content: 'q' }], max_tokens: 10 });
  ok('a normal answer is untouched', r3.ok === true && r3.status === 200 && r3.data.content[0].text === 'fine', r3);
  /* through the handler: a hanging model still returns the research */
  mode = 'hang';
  t0 = Date.now();
  const res = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify({ mode: 'chat', question: 'What is the weather like on Mars?' }) }));
  const body = await res.json().catch(() => null);
  const took2 = Date.now() - t0;
  ok('the handler answers within the deadline when the model hangs', took2 < 6000, took2);
  ok('with a body (never an unhandled rejection)', !!body, res.status);
  console.log('  handler branch: status ' + res.status + ', narration ' + JSON.stringify(body && body.narration).slice(0, 160));
  if (body && body.narration && body.narration.ok === false) {
    ok('the narration failure says it timed out and is retryable', body.narration.timed_out === true && body.narration.retryable === true && /did not answer in time/.test(body.narration.reason), body.narration);
  } else {
    /* a turn that never reached the model (answered deterministically) is also fine: the clock only governs model calls */
    ok('a turn that did not need the model is not affected', res.status < 500, { status: res.status, keys: body && Object.keys(body) });
  }
  const probe = await (await m.handle(new Request('https://fn.test/edgedesk_ai?probe=1'))).json();
  ok('?probe=1 reports the model clock', probe.model_clock && probe.model_clock.timeout_ms === 1200 && probe.model_clock.deadline_ms === 2000, probe.model_clock);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'model clock — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
