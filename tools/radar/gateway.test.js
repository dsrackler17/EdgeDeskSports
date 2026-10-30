#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_poly_gateway.js — the Radar gateway, offline. No request
   leaves this process: fetch is a stand-in that records every URL, and the
   clock and sleep are the test's own.

     switch     POLYMARKET_DATA_ENABLED off: nothing is asked, ever
     budget     every attempt (retries too) takes one request; an empty
                budget is a refusal, never a wait
     backoff    no answer, a timeout, a 429, a 5xx: retried at most 3 times,
                base 1 s doubling, +-20%, capped; Retry-After honoured to 60 s
     no retry   any other 4xx is answered once
     breaker    6 consecutive 429s / 5xx: every later request refused unsent
     pace       two requests to one host start at least pace_ms apart
     endpoints  only the listed paths; arrays repeat their key

   Run: node tools/radar/gateway.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_poly_gateway.js'));
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };

/* a scripted Polymarket: each call takes the next answer */
function world(answers) {
  const calls = [], slept = [];
  let t = 1e12;
  const fetch = async (url) => {
    calls.push({ url, at: t });
    const a = answers.length ? answers.shift() : { status: 200, body: [] };
    if (a.throw) { const e = new Error(a.throw); e.name = a.name || 'TypeError'; throw e; }
    return { status: a.status, headers: { get: (k) => (a.headers || {})[k.toLowerCase()] || null }, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  const sleep = async (ms) => { slept.push(ms); t += ms; };
  return { calls, slept, fetch, sleep, now: () => t, rnd: () => 0.5 };
}
const make = (w, extra) => G.make(Object.assign({ fetch: w.fetch, sleep: w.sleep, now: w.now, rnd: w.rnd, enabled: true }, extra || {}));

(async () => {
  /* endpoints */
  chk('only listed endpoints: an unknown one throws', (() => { try { G.url('pnl', {}); return false; } catch (e) { return /unknown endpoint/.test(e.message); } })());
  chk('the CLOB\'s live book, price, midpoint and fee rate are listed endpoints (H-RADAR-02: the price a follower pays)',
    G.url('book', { token_id: '12' }) === 'https://clob.polymarket.com/book?token_id=12' && G.url('price', { token_id: '12', side: 'BUY' }) === 'https://clob.polymarket.com/price?token_id=12&side=BUY'
    && G.url('midpoint', { token_id: '12' }) === 'https://clob.polymarket.com/midpoint?token_id=12' && G.url('fee_rate', { token_id: '12' }) === 'https://clob.polymarket.com/fee-rate?token_id=12');
  chk('the P&L and rankings hosts are not in the gateway', !Object.values(G.HOSTS).some((h) => /pnl|rank/i.test(h)) && Object.keys(G.HOSTS).sort().join() === 'clob,data,gamma');
  chk('an array repeats its key; empty values are left out', G.url('markets', { condition_ids: ['0xa', '0xb'], closed: null, limit: 2 }) === 'https://gamma-api.polymarket.com/markets?condition_ids=0xa&condition_ids=0xb&limit=2');
  chk('the leaderboard is the v1 path on the data API', G.url('leaderboard', { category: 'SPORTS' }) === 'https://data-api.polymarket.com/v1/leaderboard?category=SPORTS');
  chk('holders are the v2 path, one condition per call', G.url('holders', { condition: '0xc', include_pnl: true }) === 'https://data-api.polymarket.com/v2/holders?condition=0xc&include_pnl=true');

  /* the switch */
  {
    const w = world([]);
    const g = make(w, { enabled: false });
    const r = await g.get('leaderboard', {});
    chk('switch off: refused as disabled, nothing asked', !r.ok && r.decision === 'disabled' && w.calls.length === 0, r);
    let on = false;
    const g2 = make(w, { enabled: () => on });
    const r1 = await g2.get('sports', {}); on = true; const r2 = await g2.get('sports', {});
    chk('the switch is read on every request (turned on mid-run, the next request goes)', r1.decision === 'disabled' && r2.ok && w.calls.length === 1);
  }
  /* success */
  {
    const w = world([{ status: 200, body: { data: [1], pagination: { has_more: false } } }]);
    const r = await make(w).get('activity', { user: '0x1' });
    chk('a 200 with JSON is ok, data parsed, one attempt', r.ok && r.attempts === 1 && r.data.data[0] === 1 && r.decision === 'ok');
    const w2 = world([{ status: 200, body: 'not json <html>' }]);
    const r2 = await make(w2).get('activity', {});
    chk('a 200 that is not JSON is malformed and not retried', !r2.ok && r2.decision === 'malformed' && w2.calls.length === 1);
  }
  /* backoff */
  {
    const w = world([{ status: 503 }, { status: 0, throw: 'reset' }, { status: 200, body: [] }]);
    const r = await make(w).get('markets', {});
    chk('a 503 then no answer then 200: ok on attempt 3', r.ok && r.attempts === 3 && w.calls.length === 3, r);
    chk('the backoff doubles from 1 s (jitter at its middle)', w.slept.filter((x) => x >= 1000).join() === '1000,2000', w.slept);
    const w2 = world([{ status: 500 }, { status: 502 }, { status: 504 }, { status: 503 }, { status: 200, body: [] }]);
    const r2 = await make(w2).get('markets', {});
    chk('at most 3 retries: the fourth failure is the answer', !r2.ok && r2.attempts === 4 && w2.calls.length === 4 && r2.decision === 'http_503', r2);
    const w3 = world([{ status: 0, throw: 'deadline', name: 'TimeoutError' }, { status: 200, body: [] }]);
    const r3 = await make(w3).get('markets', {});
    chk('a timeout is retried (Polymarket bills nothing)', r3.ok && r3.attempts === 2);
    chk('backoff is capped at 16 s', G.backoffMs(10, null, () => 1) === 16000 && G.backoffMs(1, null, () => 0) === 800);
    chk('a 429 Retry-After is honoured when longer, capped at 60 s', G.backoffMs(1, '7', () => 0.5) === 7000 && G.backoffMs(1, '600', () => 0.5) === 60000);
    const w4 = world([{ status: 429, headers: { 'retry-after': '5' } }, { status: 200, body: [] }]);
    const r4 = await make(w4).get('activity', {});
    chk('a 429 waits its Retry-After, then succeeds', r4.ok && w4.slept.includes(5000), w4.slept);
  }
  /* no retry */
  for (const s of [400, 401, 403, 404, 422]) {
    const w = world([{ status: s, body: { error: 'x' } }, { status: 200, body: [] }]);
    const r = await make(w).get('holders', {});
    chk('HTTP ' + s + ' is answered once, never retried', !r.ok && r.decision === 'http_' + s && w.calls.length === 1);
  }
  /* budget */
  {
    const w = world([{ status: 503 }, { status: 503 }, { status: 200, body: [] }]);
    const b = G.fixedBudget(2);
    const r = await make(w, { budget: b }).get('markets', {});
    chk('a retry takes from the budget: two attempts, then refused as budget_exhausted', !r.ok && r.decision === 'budget_exhausted' && w.calls.length === 2 && b.used === 2, r);
    const r2 = await make(w, { budget: b }).get('markets', {});
    chk('an empty budget refuses at once, sending nothing', r2.decision === 'budget_exhausted' && w.calls.length === 2);
    let asked = 0;
    const db = { take: async () => { asked++; return asked <= 1; } };
    const w2 = world([{ status: 200, body: [] }, { status: 200, body: [] }]);
    const g = make(w2, { budget: db });
    const a = await g.get('sports', {}), c = await g.get('sports', {});
    chk('an async budget (the database grant) is awaited', a.ok && c.decision === 'budget_exhausted' && w2.calls.length === 1);
  }
  /* breaker */
  {
    const answers = []; for (let i = 0; i < 20; i++) answers.push({ status: 429 });
    const w = world(answers);
    const g = make(w, { max_retries: 3 });
    const a = await g.get('activity', {}), b = await g.get('activity', {}), c = await g.get('activity', {});
    chk('6 consecutive 429s open the breaker', g.stats().breaker === true && w.calls.length === 6, { calls: w.calls.length, a: a.decision, b: b.decision });
    chk('after it opens, a request is refused without being sent', c.decision === 'breaker_open' && w.calls.length === 6);
    const w2 = world([{ status: 429 }, { status: 200, body: [] }, { status: 429 }, { status: 200, body: [] }]);
    const g2 = make(w2, { breaker_after: 2 });
    await g2.get('activity', {}); await g2.get('activity', {});
    chk('a success resets the count: alternating 429 / 200 never opens it', g2.stats().breaker === false);
  }
  /* pace */
  {
    const w = world([{ status: 200, body: [] }, { status: 200, body: [] }, { status: 200, body: [] }]);
    const g = make(w, { pace_ms: { clob: 500 } });
    await Promise.all([g.get('prices_history', {}), g.get('prices_history', {}), g.get('markets', {})]);
    const clob = w.calls.filter((c) => /clob/.test(c.url));
    chk('two concurrent requests to one host: the second waits out pace_ms; the other host does not wait', clob.length === 2 && w.slept.filter((x) => x === 500).length === 1 && w.slept.length === 1, w.slept);
    chk('stats count requests, statuses and endpoints', g.stats().requests === 3 && g.stats().statuses['200'] === 3 && g.stats().by_endpoint.prices_history === 2);
  }

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' radar gateway — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
