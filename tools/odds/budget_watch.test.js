#!/usr/bin/env node
/* The hourly budget watch (tools/odds/budget_watch.js): what turns red, what
   only warns, and that it reads the ledger and nothing else. No network.
   Run: node tools/odds/budget_watch.test.js */
'use strict';
const path = require('path');
const W = require(path.join(__dirname, 'budget_watch.js'));
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('odds budget watch');

const dash = (o) => Object.assign({
  breaker: { enabled: true, reason: null },
  budget: { configured: true, monthly_budget: 60000, spent_today: 900, daily_allowance: 1500, spent_cycle: 9000, threshold: 'normal', budget_used_pct: 0.15, provider_remaining: 91000, next_reset: '2026-12-01T00:00:00Z' },
  today: { dispatched: 300, cache_hits: 2400, collapsed_in_flight: 40, denied: 12, credits: 900 },
  alerts: [],
}, o || {});

let v = W.evaluate(dash());
T.chk('a normal day: no failure, no warning', v.fail.length === 0 && v.warn.length === 0, v);
v = W.evaluate(dash({ alerts: [{ level: 'critical', code: 'budget_critical', at: 'x', message: '80 %', acknowledged_at: null }] }));
T.chk('an unacknowledged critical alert fails the run', v.fail.length === 1 && /budget_critical/.test(v.fail[0]), v);
v = W.evaluate(dash({ alerts: [{ level: 'emergency', code: 'quota_exhausted', at: 'x', message: '429', acknowledged_at: '2026-10-10T10:00:00Z' }] }));
T.chk('…an acknowledged one does not', v.fail.length === 0, v);
v = W.evaluate(dash({ alerts: [{ level: 'warning', code: 'budget_warning', at: 'x', message: '50 %', acknowledged_at: null }] }));
T.chk('a warning alert warns, never fails', v.fail.length === 0 && v.warn.length === 1, v);
v = W.evaluate(dash({ budget: Object.assign(dash().budget, { spent_today: 2000 }) }));
T.chk('spend past the day\'s 25 % overdraft with the breaker on fails', v.fail.some((l) => /allowance of 1500/.test(l)), v);
v = W.evaluate(dash({ budget: Object.assign(dash().budget, { monthly_budget: 0 }) }));
T.chk('the breaker on with a zero budget fails', v.fail.some((l) => /zero monthly budget/.test(l)), v);
v = W.evaluate(dash({ breaker: { enabled: false, reason: '2026-10-10 incident' }, budget: Object.assign(dash().budget, { monthly_budget: 0, spent_today: 0 }), today: { dispatched: 0 } }));
T.chk('paused (the incident state) is reported, not failed', v.fail.length === 0 && v.info.some((l) => /PAUSED/.test(l)), v);
v = W.evaluate(null);
T.chk('no dashboard at all fails (the SQL is missing)', v.fail.length === 1, v);

(async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify(dash()) }; };
  const code = await W.main({ EDGD_SB_URL: 'https://p.supabase.co', EDGD_SB_SERVICE: 'svc' }, f);
  T.chk('main reads rpc/odds_api_dashboard once and exits 0 on a normal day', code === 0 && seen.length === 1 && /\/rest\/v1\/rpc\/odds_api_dashboard$/.test(seen[0].url), seen.map((s) => s.url));
  T.chk('…and never the gateway or the provider', !seen.some((s) => /odds_gateway|the-odds-api/.test(s.url)));
  const bad = await W.main({ EDGD_SB_URL: 'https://p.supabase.co', EDGD_SB_SERVICE: 'svc' }, async () => ({ ok: false, status: 404, text: async () => 'not found' }));
  T.chk('a missing RPC (SQL not applied) exits 1', bad === 1);
  const none = await W.main({ EDGD_SB_URL: 'https://p.supabase.co' }, async () => { throw new Error('must not be called'); });
  T.chk('no service role: a warning and exit 0, nothing fetched', none === 0);
  process.exit(T.done());
})();
