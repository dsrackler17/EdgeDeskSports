// @ts-nocheck — plain JavaScript in a .ts file, as the portfolio functions are.
// ============================================================
//  FILE:    supabase/functions/log_user_bet/index.ts
//  TYPE:    Edge Function — Bet Checker: log a bet the reader already
//           placed, and grade its price instantly (docs/bet-checker.md)
//  DEPLOY:  supabase functions deploy log_user_bet
//           (JWT verification ON — the default. The gateway refuses a
//           request without a valid Supabase JWT, and this function asks
//           Supabase Auth who the token belongs to before anything else.
//           .github/workflows/deploy-bet-checker.yml)
//  IMPORTS: NONE. One file.
//
//  WHAT IT DOES, FOR ONE SIGNED-IN READER
//    POST { event_id, market: spread | total | moneyline, side: home | away |
//           over | under, line (null for moneyline), odds (American),
//           book: Kalshi | DK Predictions | DraftKings | Other,
//           stake_units (default 1), client_key }
//      1. verifies the caller (Supabase Auth /auth/v1/user; the anon key is
//         not an account) and the request's shape;
//      2. hands the rest to public.bet_checker_log_bet() (supabase/
//         bet_checker.sql) as the service role, which does every remaining
//         step in ONE transaction: the game is on EdgeDesk's board and not
//         started; the free allowance (10 grades a calendar month, counted
//         under a per-reader lock — over it, the bet is still saved, ungraded,
//         with an upgrade prompt); EdgeDesk's current fair price at EXACTLY
//         this event, market, side and line (stored, never recomputed); the
//         edge in implied-probability points; and the grade, green / yellow /
//         red, from the one constant bet_checker_rules(). No fair at that
//         line, or a stale one: ungraded, with the reason. Never interpolated.
//      3. answers { ok, bet, grade, edge_pct, fair_price, reason, upgrade,
//         usage, rules } at once, so the card shows the grade.
//    The whole decision lives in the database so the free count cannot race
//    and a reader's own insert can never carry a grade (a trigger resets it).
//
//  WHAT IT NEVER DOES
//    - say whether EdgeDesk flagged the side. That is settled after kickoff
//      by grade_user_bets, so a free account cannot read live signals one
//      logged bet at a time;
//    - return EdgeDesk's fair price for a bet it did not grade.
//
//  SECRETS / ENV
//    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   provided by Supabase
//    BET_CHECKER_ORIGINS   optional, comma-separated allowed origins for CORS
//                          (default *: the API is bearer-token only)
// ============================================================

export const BUILD = 'log_user_bet@2026-10-28.1';

const MARKETS = ['spread', 'total', 'moneyline'];
const SIDES = { spread: ['home', 'away'], moneyline: ['home', 'away'], total: ['over', 'under'] };

function config() {
  const env = (k) => (typeof Deno !== 'undefined' && Deno.env.get(k)) || '';
  return {
    url: (env('SB_URL') || env('SUPABASE_URL')).replace(/\/+$/, ''),
    anonKey: env('SUPABASE_ANON_KEY') || env('SB_ANON_KEY'),
    serviceKey: env('SB_SERVICE_ROLE') || env('SUPABASE_SERVICE_ROLE_KEY'),
    origins: env('BET_CHECKER_ORIGINS'),
  };
}

function cors(req, cfg) {
  const want = String(cfg.origins || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const allow = !want.length ? '*' : (want.indexOf(origin) >= 0 ? origin : want[0]);
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}
function reply(req, cfg, status, body) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status,
    headers: Object.assign({ 'content-type': 'application/json', 'x-edgedesk-build': BUILD }, cors(req, cfg)),
  });
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

// The caller, verified by Supabase Auth; never decoded here.
async function getUser(cfg, req) {
  const authz = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  try {
    const r = await fetchWithTimeout(cfg.url + '/auth/v1/user', { headers: { apikey: cfg.anonKey, authorization: authz } }, 6000);
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    if (!u || typeof u.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(u.id)) return null;
    return { id: u.id.toLowerCase() };
  } catch (_) { return null; }
}

// The request's shape. The database checks it all again; this only keeps an
// obviously malformed request from costing a database call.
export function readBet(body) {
  const b = body && typeof body === 'object' ? body : {};
  const market = String(b.market || '').toLowerCase();
  const side = String(b.side || '').toLowerCase();
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const out = {
    event_id: typeof b.event_id === 'string' ? b.event_id.trim() : '',
    market, side,
    line: market === 'moneyline' ? null : num(b.line),
    odds: num(b.odds),
    book: typeof b.book === 'string' ? b.book.trim() : '',
    stake_units: b.stake_units == null || b.stake_units === '' ? 1 : num(b.stake_units),
    client_key: typeof b.client_key === 'string' ? b.client_key.trim() : '',
  };
  const bad = (message) => ({ ok: false, message });
  if (!out.event_id || out.event_id.length > 200) return bad('Pick a game from the list.');
  if (MARKETS.indexOf(market) < 0) return bad('Pick a market: spread, total or moneyline.');
  if (SIDES[market].indexOf(side) < 0) return bad('Pick a side for that market.');
  if (market !== 'moneyline' && (out.line == null || !isFinite(out.line))) return bad('Enter the line you took.');
  if (out.odds == null || !Number.isInteger(out.odds) || Math.abs(out.odds) < 100) return bad('Enter American odds, like -110 or +150.');
  if (out.stake_units == null || !isFinite(out.stake_units) || out.stake_units <= 0 || out.stake_units > 100) return bad('Stake is between 0 and 100 units.');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(out.client_key)) return bad('This page is out of date. Reload it and try again.');
  if (!out.book) return bad('Pick the book.');
  return { ok: true, bet: out };
}

// What the card needs, and nothing else from the row.
export function cardOf(b) {
  if (!b) return null;
  return {
    id: b.id, event_id: b.event_id, sport: b.sport, market: b.market_type, side: b.side, team: b.team,
    line: b.line, odds: b.odds == null ? null : Number(b.odds), book: b.book, stake_units: b.units == null ? null : Number(b.units),
    placed_at: b.placed_at, kickoff: b.kickoff, home_team: b.home_team, away_team: b.away_team,
    entry_grade: b.entry_grade, entry_grade_reason: b.entry_grade_reason,
    entry_edge_pct: b.entry_edge_pct == null ? null : Number(b.entry_edge_pct),
    entry_fair_price: b.entry_fair_price, close_status: b.close_status, result: b.result || 'pending',
    edgedesk_flagged: false,
  };
}

const STATUS_OF = { no_such_user: 401, bad_input: 400, no_such_game: 404, not_graded_sport: 422, game_started: 409 };

export async function handle(req) {
  const cfg = config();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req, cfg) });
  if (req.method === 'GET') {
    return reply(req, cfg, 200, { ok: true, service: 'log_user_bet',
      configured: { database: !!(cfg.url && cfg.serviceKey), auth: !!cfg.anonKey } });
  }
  if (req.method !== 'POST') return reply(req, cfg, 405, { ok: false, reason: 'method' });
  if (!cfg.url || !cfg.serviceKey || !cfg.anonKey) {
    return reply(req, cfg, 503, { ok: false, reason: 'not_configured', message: 'Bet Checker is being set up. Nothing was saved.' });
  }

  const user = await getUser(cfg, req);
  if (!user) return reply(req, cfg, 401, { ok: false, reason: 'sign_in_required', message: 'Sign in to log a bet.' });

  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const read = readBet(body);
  if (!read.ok) return reply(req, cfg, 400, { ok: false, reason: 'bad_input', message: read.message });
  const x = read.bet;

  let r;
  try {
    const res = await fetchWithTimeout(cfg.url + '/rest/v1/rpc/bet_checker_log_bet', {
      method: 'POST',
      headers: { apikey: cfg.serviceKey, authorization: 'Bearer ' + cfg.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_user: user.id, p_event_id: x.event_id, p_market: x.market, p_side: x.side, p_line: x.line,
        p_odds: x.odds, p_book: x.book, p_units: x.stake_units, p_client_key: x.client_key }),
    }, 10000);
    const text = await res.text();
    if (!res.ok) {
      console.error(JSON.stringify({ svc: 'log_user_bet', level: 'error', event: 'rpc_failed', status: res.status, user_id: user.id,
        body: text.slice(0, 240) }));
      return reply(req, cfg, 503, { ok: false, reason: 'unavailable', message: 'Bet Checker could not save that right now. Nothing was saved; try again.' });
    }
    r = JSON.parse(text);
  } catch (e) {
    console.error(JSON.stringify({ svc: 'log_user_bet', level: 'error', event: 'rpc_unreachable', user_id: user.id, error: String(e && e.message || e).slice(0, 200) }));
    return reply(req, cfg, 503, { ok: false, reason: 'unavailable', message: 'Bet Checker could not be reached. Nothing was saved; try again.' });
  }

  if (!r || !r.ok) {
    const reason = (r && r.reason) || 'refused';
    return reply(req, cfg, STATUS_OF[reason] || 409, { ok: false, reason, message: (r && r.message) || 'That bet could not be logged.' });
  }
  const card = cardOf(r.bet);
  console.log(JSON.stringify({ svc: 'log_user_bet', level: 'info', event: r.replay ? 'replay' : 'logged', user_id: user.id,
    grade: card.entry_grade, reason: card.entry_grade_reason, market: card.market, upgrade: !!r.upgrade }));
  return reply(req, cfg, 200, {
    ok: true, replay: !!r.replay, bet: card,
    grade: card.entry_grade, edge_pct: card.entry_edge_pct, fair_price: card.entry_fair_price, reason: card.entry_grade_reason,
    upgrade: !!r.upgrade, usage: r.usage || null, rules: r.rules || null,
  });
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(handle);
