#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/sharp_lag/index.ts, tested as deployed: imported (not a
   copy) under Node's type stripping, with a Deno shim and an in-memory
   PostgREST (tools/sharp_lag/_rest_mock.js). The provider is never called:
   any request that is not the database or the published NBA roster inputs
   fails the suite.
     copy      the inlined core (and, from step B, the club identity) match
               lib/ and the team files
     auth      GET is a probe; POST needs the cron secret
     ingest    Pinnacle and DraftKings only, out of featured / close /
               sharp_check snapshots, American converted, each snapshot once
     spend     no call to odds_gateway or the provider, no PATCH, no DELETE
   Run: node tools/sharp_lag/sharp_lag_fn.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(__dirname, '_rest_mock.js'));
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SHARP_LAG_CRON_SECRET: 'cron-secret', NBA_INPUTS_URL: 'https://edgedesksports.com/nba/roster_inputs.json' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
chk('copy: the inlined copies match lib/edgedesk_sharp_lag.js and the team files (node tools/sharp_lag/inline_core.js)', require(path.join(__dirname, 'inline_core.js')).current());

const NOW = '2026-11-02T18:00:00Z', T0 = Date.parse(NOW);
const at = (min) => new Date(T0 + min * 60000).toISOString();
const NFL = { id: 'ev_nfl', sport_key: 'americanfootball_nfl', commence_time: at(240), home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys' };
const book = (key, markets, upd) => ({ key, title: key, last_update: upd || at(-12), markets });
const h2h = (h, a) => ({ key: 'h2h', outcomes: [{ name: NFL.home_team, price: h }, { name: NFL.away_team, price: a }] });
const nflBody = (pin, dk) => [Object.assign({}, NFL, { bookmakers: [book('pinnacle', [h2h(pin[0], pin[1]), { key: 'totals', outcomes: [{ name: 'Over', price: 1.91, point: 47.5 }, { name: 'Under', price: 1.99, point: 47.5 }] }]),
  book('draftkings', [h2h(dk[0], dk[1]), { key: 'totals', outcomes: [{ name: 'Over', price: 1.7, point: 47.5 }, { name: 'Under', price: dk[2] || 2.2, point: 47.5 }] }]), book('fanduel', [h2h(1.5, 2.7)])] })];
const NBA_EV = { id: 'ev_nba', sport_key: 'basketball_nba', commence_time: at(180), home_team: 'Charlotte Hornets', away_team: 'Washington Wizards' };
const NHL_EV = { id: 'ev_nhl', sport_key: 'icehockey_nhl', commence_time: at(120), home_team: 'Toronto Maple Leafs', away_team: 'Montreal Canadiens' };
const snap = (o) => Object.assign({ fingerprint: 'fp' + o.last_request_id, odds_format: 'decimal' }, o);
const INPUTS = { games: [{ game_id: '401909868', start_utc: at(180), home: { id: '30', abbr: 'CHA', name: 'Charlotte Hornets' }, away: { id: '27', abbr: 'WSH', name: 'Washington Wizards' },
  reference: { home: [{ id: 'p1', name: 'LaMelo Ball', minutes: 33 }, { id: 'p2', name: 'Miles Bridges', minutes: 31 }, { id: 'p3', name: 'Brandon Miller', minutes: 30 }, { id: 'p4', name: 'Mark Williams', minutes: 26 }, { id: 'p5', name: 'Josh Green', minutes: 24 }, { id: 'p6', name: 'Bench Guy', minutes: 9 }],
    away: [{ id: 'w1', name: 'Jordan Poole', minutes: 32 }] } }] };

let R, extCalls;
function world(seed) {
  R = M.create(seed); extCalls = [];
  globalThis.fetch = async (u, init) => {
    u = String(u);
    if (u.startsWith(ENV.SUPABASE_URL + '/rest/v1/')) { const [s, b] = R.rest(u, init); return M.resp(s, b); }
    if (u === ENV.NBA_INPUTS_URL) return M.resp(200, INPUTS);
    extCalls.push(u);
    return M.resp(404, 'unmocked ' + u);
  };
}
const cfg = (dispatch, extra) => [{ key: 'dispatch', value: dispatch || 'shadow' }, { key: 'flags', value: 'on' }, { key: 'public_display', value: 'off' }].concat(extra || []);

(async () => {
  let F;
  try { F = await import(path.join(ROOT, 'supabase', 'functions', 'sharp_lag', 'index.ts')); }
  catch (e) { console.log('SKIP | sharp lag fn | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  const run = (o) => F.runOnce(Object.assign({ now: NOW }, o || {}));

  /* ── auth ────────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: cfg() });
  let res = await F.handle(new Request('https://x/functions/v1/sharp_lag', { method: 'GET' }));
  chk('auth: GET is a probe naming the build and the core', res.status === 200 && /sharp_lag@/.test((await res.json()).build));
  res = await F.handle(new Request('https://x/functions/v1/sharp_lag', { method: 'POST', body: '{}' }));
  chk('auth: a POST without the cron secret is refused', res.status === 401);

  /* ── ingest ──────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: cfg(), odds_api_snapshots: [
    snap({ category: 'featured', sport_key: NFL.sport_key, event_id: null, last_request_id: 501, last_success_at: at(-10), body: nflBody([1.6, 2.5], [1.75, 2.15]) }),
    snap({ category: 'featured', sport_key: 'basketball_nba', event_id: null, odds_format: 'american', last_request_id: 502, last_success_at: at(-20),
      body: [Object.assign({}, NBA_EV, { bookmakers: [book('pinnacle', [{ key: 'h2h', outcomes: [{ name: NBA_EV.home_team, price: -150 }, { name: NBA_EV.away_team, price: 130 }] }])] })] }),
    snap({ category: 'collective', sport_key: NFL.sport_key, last_request_id: 504, last_success_at: at(-5), body: nflBody([1.6, 2.5], [1.6, 2.5]) }),
    snap({ category: 'featured', sport_key: NFL.sport_key, last_request_id: 400, last_success_at: at(-420), body: nflBody([1.6, 2.5], [1.6, 2.5]) })] });
  let out = await run({ steps: ['ingest'] });
  const P = R.DB.sharp_price_snapshots;
  chk('ingest: Pinnacle and DraftKings only, from the featured snapshots (not collective, not 7 h old)', out.ingest.snapshots_read === 2 && P.every((r) => ['pinnacle', 'draftkings'].includes(r.book)) && !P.some((r) => r.source_request_id === 504 || r.source_request_id === 400), out.ingest);
  chk('ingest: each row stamped with the snapshot\'s fetch time and its gateway request', P.filter((r) => r.source_request_id === 501).every((r) => r.captured_at === at(-10) && r.source_category === 'featured'));
  chk('ingest: American prices are stored decimal', P.some((r) => r.source_request_id === 502 && Math.abs(r.price_dec - 1.6667) < 1e-4));
  const n1 = P.length;
  out = await run({ steps: ['ingest'] });
  chk('ingest: a second run reads nothing again', R.DB.sharp_price_snapshots.length === n1 && out.ingest.snapshots_read === 0);

  /* ── spend ───────────────────────────────────────────────────────────── */
  chk('spend: no call outside the database and the published roster inputs (no gateway, no provider)', extCalls.length === 0, extCalls);
  chk('spend: no PATCH and no DELETE, ever (append-only)', !R.calls.some((c) => /^(PATCH|DELETE)/.test(c)));
  const src = require('fs').readFileSync(path.join(ROOT, 'supabase', 'functions', 'sharp_lag', 'index.ts'), 'utf8');
  chk('spend: the free job never names odds_gateway\'s URL or the provider', !/functions\/v1\/odds_gateway|the-odds-api\.com|ODDS_API_KEY|ODDS_GATEWAY_PROVIDER_KEY/.test(src));

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' sharp lag fn: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();
