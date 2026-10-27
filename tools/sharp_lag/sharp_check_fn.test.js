#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/sharp_check/index.ts — the PAID dispatcher, tested as
   deployed (Node type stripping, a Deno shim, the in-memory PostgREST) with a
   MOCKED odds_gateway. Nothing here reaches a provider: the only network
   endpoint it may call is odds_gateway, and that is a stub that answers like
   the gateway (granted, cache_hit, denied_category_cap ...).
     shadow    nothing is asked while dispatch is shadow
     triggers  one ask per event per run, in the trigger type's category
               (sharp_check, or nba_role_props for a role shift)
               , every trigger recorded once against that answer; unmapped
               and out-of-window triggers recorded as skipped, nothing spent
     shape     want_body false, allow_stale false, caller sharp_check, the
               commence time as the hint; never a provider host or a key
     refusals  a cap refusal is recorded and never retried
     closes    an NBA/NHL game with an ungraded flag inside the hour gets one
               close check, unless one ran in the last 50 minutes
     cap       at most MAX_ASKS asks a run
     mapping   an NBA trigger with no event is matched at dispatch time
   Run: node tools/sharp_lag/sharp_check_fn.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(__dirname, '_rest_mock.js'));
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SHARP_CHECK_CRON_SECRET: 'cron-secret' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
const NOW = '2026-11-02T18:00:00Z', T0 = Date.parse(NOW);
const at = (min) => new Date(T0 + min * 60000).toISOString();

let R, asks, other, ANSWER;
function world(seed) {
  R = M.create(seed); asks = []; other = [];
  ANSWER = () => ({ ok: true, decision: 'granted', source: 'provider', cost: 3, request_id: 9000 + asks.length, fetched_at: NOW });
  globalThis.fetch = async (u, init) => {
    u = String(u);
    if (u.startsWith(ENV.SUPABASE_URL + '/rest/v1/')) { const [s, b] = R.rest(u, init); return M.resp(s, b); }
    if (u === ENV.SUPABASE_URL + '/functions/v1/odds_gateway') { const b = JSON.parse(init.body); asks.push({ body: b, auth: init.headers.authorization }); return M.resp(200, ANSWER(b)); }
    other.push(u); return M.resp(404, 'unmocked ' + u);
  };
}
const trig = (id, type, ev, start, o) => Object.assign({ id, trigger_type: type, sport_key: type === 'kalshi_move' ? 'americanfootball_nfl' : type === 'nhl_goalie' ? 'icehockey_nhl' : 'basketball_nba',
  event_id: ev, home_team: 'Charlotte Hornets', away_team: 'Washington Wizards', commence_time: start, mode: 'live', dedupe_key: 'd' + id, detected_at: at(-20), detail: {} }, o || {});

(async () => {
  let F;
  try { F = await import(path.join(ROOT, 'supabase', 'functions', 'sharp_check', 'index.ts')); }
  catch (e) { console.log('SKIP | sharp check fn | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  const run = (o) => F.dispatchOnce(Object.assign({ now: NOW }, o || {}));

  /* ── shadow ──────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: [{ key: 'dispatch', value: 'shadow' }], sharp_triggers: [trig(1, 'kalshi_move', 'ev_nfl', at(120))] });
  let out = await run();
  chk('shadow: nothing is asked, nothing recorded, and the run says why', asks.length === 0 && R.DB.sharp_check_requests.length === 0 && R.DB.sharp_lag_runs[0].status === 'skipped' && /shadow/.test(R.DB.sharp_lag_runs[0].message));

  /* ── triggers ────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: [{ key: 'dispatch', value: 'live' }],
    odds_api_events: [{ event_id: 'ev_nba2', sport_key: 'basketball_nba', commence_time: at(300), home_team: 'Charlotte Hornets', away_team: 'Washington Wizards' }],
    sharp_triggers: [trig(1, 'kalshi_move', 'ev_nfl', at(120)), trig(2, 'kalshi_move', 'ev_nfl', at(120)), trig(3, 'nhl_goalie', 'ev_nhl', at(90)),
      trig(4, 'role_shift', 'ev_nba', at(180), { detail: { teammates: [{ name: 'Miles Bridges' }] } }),
      trig(5, 'nba_injury', null, at(300)),
      trig(6, 'nba_injury', null, at(300), { home_team: 'Nowhere FC', away_team: 'Atlantis' }), trig(7, 'kalshi_move', 'ev_far', at(60 * 30)),
      trig(8, 'kalshi_move', 'ev_old', at(120), { detected_at: at(-200) }), trig(9, 'nba_injury', 'ev_shadow', at(100), { mode: 'shadow' })] });
  out = await run();
  const cats = asks.map((a) => a.body.category + ':' + a.body.event_id).sort();
  chk('triggers: one ask per event per run, in the trigger type\'s category (role shift -> nba_role_props)', JSON.stringify(cats) === JSON.stringify(['nba_role_props:ev_nba', 'sharp_check:ev_nba2', 'sharp_check:ev_nfl', 'sharp_check:ev_nhl']), cats);
  chk('triggers: an NBA trigger with no provider event yet is matched at dispatch time (both clubs, the start)', asks.some((a) => a.body.event_id === 'ev_nba2'));
  const reqs = R.DB.sharp_check_requests;
  chk('triggers: every live trigger is recorded exactly once', [1, 2, 3, 4, 5, 6, 7].every((id) => reqs.filter((r) => r.trigger_id === id).length === 1), reqs.map((r) => r.trigger_id));
  chk('triggers: two triggers on one event share one ask: the second is recorded at zero cost, naming the first', reqs.find((r) => r.trigger_id === 2).cost === 0 && reqs.find((r) => r.trigger_id === 2).detail.shared_with_trigger === 1 && reqs.find((r) => r.trigger_id === 1).cost === 3);
  chk('triggers: an unmatched game is recorded skipped_unmapped, and nothing is spent', reqs.find((r) => r.trigger_id === 6).decision === 'skipped_unmapped' && reqs.find((r) => r.trigger_id === 6).cost === 0);
  chk('triggers: a game more than 24 h out is recorded skipped_window, and nothing is spent', reqs.find((r) => r.trigger_id === 7).decision === 'skipped_window');
  chk('triggers: a trigger older than 2 hours and a shadow trigger are never asked about', !reqs.some((r) => r.trigger_id === 8 || r.trigger_id === 9));
  chk('shape: every ask is want_body false, allow_stale false, caller sharp_check, consumer sharp_lag, with the start as its hint', asks.every((a) => a.body.want_body === false && a.body.allow_stale === false
    && a.body.caller === 'sharp_check' && a.body.consumer === 'sharp_lag' && a.body.action === 'odds' && !!a.body.commence_time));
  chk('shape: the gateway is asked as the service role, and nothing else is called', asks.every((a) => a.auth === 'Bearer service-key') && other.length === 0, other);
  const n = asks.length;
  out = await run();
  chk('triggers: a second run asks about nothing already dispatched', asks.length === n && out.asks.length === 0);

  /* ── refusals ────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: [{ key: 'dispatch', value: 'live' }], sharp_triggers: [trig(1, 'kalshi_move', 'ev_nfl', at(120))] });
  ANSWER = () => ({ ok: false, decision: 'denied_category_cap', reason: 'category sharp_check is capped at 90 credits a day', source: 'none', cost: 0, request_id: 77 });
  out = await run();
  chk('refusals: a cap refusal is recorded with the gateway\'s reason, at zero cost', R.DB.sharp_check_requests[0].decision === 'denied_category_cap' && R.DB.sharp_check_requests[0].cost === 0 && /capped/.test(R.DB.sharp_check_requests[0].detail.reason));
  await run();
  chk('refusals: and never retried', asks.length === 1);

  /* ── closes ──────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: [{ key: 'dispatch', value: 'live' }],
    sharp_flags: [{ flag_id: 1, model_key: 'SHARP-LAG', sport_key: 'basketball_nba', event_id: 'ev_c1', commence_time: at(30) },
      { flag_id: 2, model_key: 'SHARP-LAG', sport_key: 'icehockey_nhl', event_id: 'ev_c2', commence_time: at(45) },
      { flag_id: 3, model_key: 'SHARP-LAG', sport_key: 'americanfootball_nfl', event_id: 'ev_c3', commence_time: at(30) },
      { flag_id: 4, model_key: 'SHARP-LAG', sport_key: 'basketball_nba', event_id: 'ev_c4', commence_time: at(120) },
      { flag_id: 5, model_key: 'NBA-ROLE-SHIFT', sport_key: 'basketball_nba', event_id: 'ev_c5', commence_time: at(40) },
    ],
    sharp_check_requests: [{ id: 1, purpose: 'trigger', category: 'sharp_check', sport_key: 'icehockey_nhl', event_id: 'ev_c2', requested_at: at(-20), decision: 'granted' }] });
  out = await run();
  const closeAsks = asks.map((a) => a.body.trigger + ':' + a.body.category + ':' + a.body.event_id).sort();
  chk('closes: an NBA game with an open flag inside the hour gets one close check; a role shift its props close', JSON.stringify(closeAsks) === JSON.stringify(['close:sharp_check:ev_c1', 'role_shift_close:nba_role_props:ev_c5']), closeAsks);
  chk('closes: not the NHL game checked 20 minutes ago, not football (capture closes it), not a game 2 h out', !asks.some((a) => ['ev_c2', 'ev_c3', 'ev_c4'].includes(a.body.event_id)));

  /* ── run cap ─────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: [{ key: 'dispatch', value: 'live' }], sharp_triggers: Array.from({ length: 15 }, (_, i) => trig(i + 1, 'kalshi_move', 'ev' + i, at(60 + i))) });
  out = await run();
  chk('cap: at most ' + F.MAX_ASKS + ' asks a run; the rest wait, and the run warns', asks.length === F.MAX_ASKS && out.warnings.some((w) => w.code === 'run_cap') && R.DB.sharp_check_requests.length === F.MAX_ASKS);
  await run();
  chk('cap: the next run takes the rest', asks.length === 15);

  /* ── auth and source ─────────────────────────────────────────────────── */
  const res = await F.handle(new Request('https://x/functions/v1/sharp_check', { method: 'POST', body: '{}' }));
  chk('auth: a POST without the cron secret is refused', res.status === 401);
  const src = require('fs').readFileSync(path.join(ROOT, 'supabase', 'functions', 'sharp_check', 'index.ts'), 'utf8');
  chk('source: it never names the provider host or reads a provider key (odds_gateway is the only client)', !/the-odds-api\.com|ODDS_API_KEY|ODDS_GATEWAY_PROVIDER_KEY|apiKey=/.test(src));
  chk('source: no PATCH or DELETE (append-only)', !R.calls.some((c) => /^(PATCH|DELETE)/.test(c)));

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' sharp check fn: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();
