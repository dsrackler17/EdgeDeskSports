// @ts-nocheck — plain JavaScript in a .ts file, as the portfolio functions are.
// ============================================================
//  FILE:    supabase/functions/grade_user_bets/index.ts
//  TYPE:    Edge Function — Bet Checker: grade logged bets after the close
//           (docs/bet-checker.md)
//  DEPLOY:  supabase functions deploy grade_user_bets --no-verify-jwt
//           --no-verify-jwt IS LOAD-BEARING: pg_cron sends the x-cron-secret
//           header, not a JWT. A POST without the secret is refused here.
//           .github/workflows/deploy-bet-checker.yml
//  CRON:    supabase/bet_checker_cron.sql — every fifteen minutes (:05 :20
//           :35 :50), after `close` writes the closing line onto
//           public.signals. Its report names the close job it follows.
//  IMPORTS: NONE. One file.
//
//  EACH RUN calls public.bet_checker_grade_pending() (supabase/
//  bet_checker.sql) as the service role. For every open Bet Checker bet whose
//  game has started, the parts still to do, each terminal once written (so a
//  re-run changes nothing, and two runs skip each other's rows):
//    the close   at the bet's OWN line: captured -> closing price, closing
//                line and CLV by the house formula (close/index.ts
//                decideClose: entry decimal x no-vig closing probability - 1);
//                the market closed at another line, or never priced this one,
//                or nothing closed a day after kickoff -> no_close_available,
//                with the reason. Never adjusted, never estimated.
//    the result  settle's word on that board row, else the final score from
//                the Collective's settlement. No final, no result.
//    the flag    an EdgeDesk signal on the same side flagged before the bet
//                was logged, revealed now that the game has started.
//  Every run is recorded in public.bet_checker_grade_runs.
//
//  AUTH.  POST needs x-cron-secret = BET_CHECKER_CRON_SECRET (pg_cron reads it
//         from Vault bet_checker_cron_secret). GET is a public health probe:
//         the build and whether it is configured, nothing else.
//  BODY   (all optional): { limit (1-5000, default 500), source, probe }
//         probe: true checks the secret and answers without grading — what
//         the deploy workflow uses to prove both sides of the secret agree.
//  ENV    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase),
//         BET_CHECKER_CRON_SECRET
// ============================================================

export const BUILD = 'grade_user_bets@2026-10-28.1';

function config() {
  const env = (k) => (typeof Deno !== 'undefined' && Deno.env.get(k)) || '';
  return {
    url: (env('SB_URL') || env('SUPABASE_URL')).replace(/\/+$/, ''),
    serviceKey: env('SB_SERVICE_ROLE') || env('SUPABASE_SERVICE_ROLE_KEY'),
    secret: env('BET_CHECKER_CRON_SECRET'),
  };
}

function reply(status, body) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status, headers: { 'content-type': 'application/json', 'x-edgedesk-build': BUILD },
  });
}

// constant time, so the secret cannot be found a character at a time
export function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0 && x.length > 0;
}

export async function handle(req) {
  const cfg = config();
  if (req.method === 'GET') {
    return reply(200, { ok: true, service: 'grade_user_bets',
      configured: { database: !!(cfg.url && cfg.serviceKey), cron_secret: !!cfg.secret } });
  }
  if (req.method !== 'POST') return reply(405, { ok: false, reason: 'method' });
  if (!cfg.secret) return reply(401, { ok: false, error: 'unauthorized', reason: 'BET_CHECKER_CRON_SECRET is not set on this function' });
  if (!safeEqual(req.headers.get('x-cron-secret'), cfg.secret)) return reply(401, { ok: false, error: 'unauthorized' });
  if (!cfg.url || !cfg.serviceKey) return reply(503, { ok: false, reason: 'not_configured' });

  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  if (body && body.probe === true) return reply(200, { ok: true, probe: true });
  const limit = Math.max(1, Math.min(5000, Number.isInteger(body && body.limit) ? body.limit : 500));
  const source = String((body && body.source) || 'edge').replace(/[^a-z0-9_:-]/gi, '').slice(0, 40) || 'edge';

  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(cfg.url + '/rest/v1/rpc/bet_checker_grade_pending', {
      method: 'POST',
      headers: { apikey: cfg.serviceKey, authorization: 'Bearer ' + cfg.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_limit: limit, p_source: source }),
    });
    text = await res.text();
  } catch (e) {
    console.error(JSON.stringify({ svc: 'grade_user_bets', level: 'error', event: 'rpc_unreachable', error: String(e && e.message || e).slice(0, 200) }));
    return reply(503, { ok: false, reason: 'unavailable' });
  }
  if (!res.ok) {
    console.error(JSON.stringify({ svc: 'grade_user_bets', level: 'error', event: 'rpc_failed', status: res.status, body: String(text).slice(0, 240) }));
    return reply(502, { ok: false, reason: 'grade_failed', status: res.status });
  }
  let result = null;
  try { result = JSON.parse(text); } catch (_) { result = null; }
  console.log(JSON.stringify({ svc: 'grade_user_bets', level: 'info', event: 'graded', source, ms: Date.now() - t0, result }));
  return reply(200, { ok: true, source, result, ms: Date.now() - t0 });
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(handle);
