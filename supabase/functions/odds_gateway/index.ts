// ============================================================
//  FILE:    supabase/functions/odds_gateway/index.ts
//  TYPE:    Edge Function (deployed) — the ONLY The Odds API client
//  DEPLOY:  supabase functions deploy odds_gateway --no-verify-jwt
//  BUILD:   odds-gateway-2026-10-10-r1   (authoritative: `export const BUILD`)
//  IMPORTS: NONE (supabase/README.md: the dashboard bundles one folder).
//  TESTS:   node tools/odds/gateway_fn.test.js   (imports THIS file, no network)
// ============================================================
//
// WHY THIS EXISTS (docs/odds-api-incident-2026-10/INCIDENT.md). On 2026-10-10
// the account had spent 99,336 of its 100,000 monthly credits in 9.5 days.
// Six call paths held the same key, each with a private budget and no view of
// the others. This function is now the one place the key is read and the one
// place api.the-odds-api.com is called. tools/odds/no_bypass.test.js fails the
// build if any other file in the repository names the provider host or reads
// the key.
//
// WHAT IT DOES WITH A REQUEST
//   1. odds_api_acquire() (supabase/odds_api_gateway.sql) decides, under one
//      row lock shared by every worker: serve the stored snapshot (cadence
//      window), collapse into an identical request already in flight, refuse
//      (breaker, budget, category, sport, live/completed event, unconfirmed
//      quota...), or GRANT with a reserved upper-bound cost.
//   2. Only on a grant does it call the provider, with a deadline. Temporary
//      failures (no response at all, or 500/502/503/504) are retried at most
//      MAX_RETRIES times with bounded exponential backoff, and every retry is a
//      NEW acquire — it re-reserves and can be refused. A timeout is never
//      retried (the provider may already have billed it), a 429 is never
//      retried, and a 401 is never retried.
//   3. odds_api_settle() reconciles the reservation with x-requests-last and
//      records x-requests-used / x-requests-remaining, the snapshot, and the
//      event clock. A quota-exhausted 429 or a 401 trips the breaker.
//   4. The answer is one envelope whatever happened: the data (provider, cache
//      or the last stale snapshot), whether it is fresh, when it was fetched,
//      what it cost, and — for a named consumer — whether this consumer has
//      already processed it.
//
// FAIL CLOSED. No key, no database, an RPC error, a missing config row or a
// kill switch all mean no provider request. Nothing here retries a refusal.
// The key is never logged, never returned and never written: provider error
// text is cut to 240 characters with the key and any apiKey= removed.
// ============================================================

export const BUILD = "odds-gateway-2026-10-10-r1";

export type EnvGet = (k: string) => string | undefined;
const defaultEnv: EnvGet = (k) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined);

export const PROVIDER_BASE = "https://api.the-odds-api.com/v4";
export const TIMEOUT_MS = 20000;
export const MAX_RETRIES = 2;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 4000;
export const IN_FLIGHT_WAIT_MS = 15000;
export const IN_FLIGHT_POLL_MS = 500;

export interface GatewayRequest {
  action?: string;
  caller?: string;
  consumer?: string;
  trigger?: string;
  category?: string;
  sport_key?: string;
  event_id?: string;
  odds_format?: string;
  max_age_seconds?: number;
  commence_time?: string;
  date?: string;
  want_body?: boolean;
  allow_stale?: boolean;
}

export interface Envelope {
  ok: boolean;
  build: string;
  decision: string;
  reason: string | null;
  request_id: number | null;
  source: "provider" | "cache" | "stale_cache" | "none";
  fresh: boolean;
  new_for_consumer: boolean | null;
  fetched_at: string | null;
  age_seconds: number | null;
  data: any;
  status: number;
  quota: { used: number | null; remaining: number | null; last: number | null };
  cost: number;
  fingerprint: string | null;
  category: string | null;
  sport_key: string | null;
  event_id: string | null;
  markets: string[] | null;
  bookmakers: string[] | null;
  odds_format: string | null;
  interval_minutes: number | null;
  hours_to_start: number | null;
  shed_level: number | null;
  breaker: string | null;
  attempts: number;
  detail?: string;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function deadline(ms: number): AbortSignal | undefined {
  try { return (AbortSignal as any).timeout(ms); } catch { return undefined; }
}
function num(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Constant-time comparison, so the secret cannot be guessed by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Remove the key, wherever an upstream message might echo it. */
export function redact(text: string, key: string): string {
  let t = String(text ?? "");
  if (key) t = t.split(key).join("REDACTED");
  return t.replace(/(api_?key)=[^&\s"']*/gi, "$1=REDACTED").slice(0, 240);
}

/** Backoff for retry n (1-based): base * 2^(n-1), jittered +-20%, capped. */
export function backoffMs(n: number, rnd: () => number = Math.random): number {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, n - 1)));
  return Math.round(Math.min(BACKOFF_CAP_MS, raw * (0.8 + 0.4 * rnd())));
}

/** Temporary failures: no response at all, or the provider's own 5xx. */
export function retryable(status: number, timedOut: boolean): boolean {
  if (timedOut) return false;
  return status === 0 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** A 429 that means the account is out of credits, not merely too fast. */
export function quotaExhausted(status: number, body: string, remaining: number | null): boolean {
  if (status !== 429 && status !== 401) return false;
  if (remaining != null && remaining <= 0) return true;
  return /OUT_OF_USAGE_CREDITS|usage quota|quota has been reached|exceeded.*quota/i.test(body ?? "");
}

/** The provider URL for a GRANTED acquire. Everything but the key comes from
    the grant: markets, books and format are the category's, not the caller's. */
export function providerUrl(g: any, key: string, base = PROVIDER_BASE): string {
  const enc = encodeURIComponent;
  const sel = Array.isArray(g.bookmakers) && g.bookmakers.length
    ? `&bookmakers=${enc(g.bookmakers.join(","))}`
    : (g.regions ? `&regions=${enc(g.regions)}` : "");
  const mk = Array.isArray(g.markets) && g.markets.length ? `&markets=${enc(g.markets.join(","))}` : "";
  const fmt = `&oddsFormat=${enc(g.odds_format || "decimal")}&dateFormat=iso`;
  const k = `apiKey=${enc(key)}`;
  const s = enc(String(g.sport_key ?? "")), e = enc(String(g.event_id ?? ""));
  switch (g.endpoint) {
    case "odds": return `${base}/sports/${s}/odds/?${k}${sel}${mk}${fmt}`;
    case "event_odds": return `${base}/sports/${s}/events/${e}/odds?${k}${sel}${mk}${fmt}`;
    case "events": return `${base}/sports/${s}/events/?${k}&dateFormat=iso`;
    case "sports": return `${base}/sports/?${k}`;
    case "scores": return `${base}/sports/${s}/scores/?${k}&daysFrom=1&dateFormat=iso`;
    case "historical_events": return `${base}/historical/sports/${s}/events?${k}&date=${enc(g.date)}&dateFormat=iso`;
    case "historical_odds": return `${base}/historical/sports/${s}/odds?${k}&date=${enc(g.date)}${sel}${mk}${fmt}`;
    case "historical_event_odds": return `${base}/historical/sports/${s}/events/${e}/odds?${k}&date=${enc(g.date)}${sel}${mk}${fmt}`;
    default: throw new Error("unknown endpoint " + String(g.endpoint));
  }
}

// ── the database door (PostgREST RPC with the service role) ───────────────
export function makeDb(url: string, key: string) {
  async function rpc(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; error: string | null }> {
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(args),
        signal: deadline(15000),
      });
      const text = await r.text();
      if (!r.ok) return { ok: false, data: null, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
      return { ok: true, data: text ? JSON.parse(text) : null, error: null };
    } catch (e) {
      return { ok: false, data: null, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }
  return { rpc };
}
export type Db = ReturnType<typeof makeDb>;

function blank(decision: string, reason: string | null): Envelope {
  return {
    ok: false, build: BUILD, decision, reason, request_id: null, source: "none", fresh: false,
    new_for_consumer: null, fetched_at: null, age_seconds: null, data: null, status: 0,
    quota: { used: null, remaining: null, last: null }, cost: 0, fingerprint: null, category: null,
    sport_key: null, event_id: null, markets: null, bookmakers: null, odds_format: null,
    interval_minutes: null, hours_to_start: null, shed_level: null, breaker: null, attempts: 0,
  };
}

function fromGrant(env: Envelope, g: any): Envelope {
  env.request_id = g.request_id ?? env.request_id;
  env.fingerprint = g.fingerprint ?? null;
  env.category = g.category ?? null;
  env.sport_key = g.sport_key ?? null;
  env.event_id = g.event_id ?? null;
  env.markets = g.markets ?? null;
  env.bookmakers = g.bookmakers ?? null;
  env.odds_format = g.odds_format ?? null;
  env.interval_minutes = g.interval_minutes ?? null;
  env.hours_to_start = g.hours_to_start ?? null;
  env.shed_level = g.shed_level ?? null;
  env.breaker = g.breaker ?? null;
  env.decision = g.decision ?? env.decision;
  env.reason = g.reason ?? null;
  return env;
}

async function consume(db: Db, consumer: string | undefined, fp: string | null, requestId: number | null): Promise<boolean | null> {
  if (!consumer || !fp || requestId == null) return null;
  const r = await db.rpc("odds_api_consume", { p_consumer: consumer, p_fingerprint: fp, p_request_id: requestId });
  return r.ok ? r.data === true : null;
}

async function snapshot(db: Db, fp: string): Promise<any | null> {
  const r = await db.rpc("odds_api_snapshot", { p_fingerprint: fp });
  return r.ok && r.data && typeof r.data === "object" ? r.data : null;
}

/** Serve a stored snapshot (fresh cache hit, or the last verified one). */
async function serveSnapshot(db: Db, env: Envelope, req: GatewayRequest, fresh: boolean): Promise<Envelope> {
  if (!env.fingerprint) return env;
  const s = await snapshot(db, env.fingerprint);
  if (!s) return env;
  env.source = fresh ? "cache" : "stale_cache";
  env.fresh = fresh;
  env.fetched_at = s.fetched_at ?? null;
  env.age_seconds = s.age_seconds ?? null;
  env.data = req.want_body === false ? null : (s.body ?? null);
  env.ok = req.want_body === false ? true : s.body != null;
  env.new_for_consumer = await consume(db, req.consumer, env.fingerprint, s.request_id ?? null);
  return env;
}

/** One gateway request, start to finish. Exported for the tests. */
export async function serve(req: GatewayRequest, envGet: EnvGet = defaultEnv, rnd: () => number = Math.random): Promise<Envelope> {
  const key = (envGet("ODDS_GATEWAY_PROVIDER_KEY") ?? envGet("ODDS_API_KEY") ?? "").trim();
  const base = (envGet("ODDS_GATEWAY_PROVIDER_BASE") ?? "").trim() || PROVIDER_BASE;
  const timeout = Math.max(2000, Math.min(60000, Number(envGet("ODDS_GATEWAY_TIMEOUT_MS") ?? TIMEOUT_MS) || TIMEOUT_MS));
  const maxRetries = Math.max(0, Math.min(MAX_RETRIES, Number(envGet("ODDS_GATEWAY_MAX_RETRIES") ?? MAX_RETRIES)));
  const db = makeDb(envGet("SUPABASE_URL") ?? "", envGet("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  if (/^(1|true|yes|on)$/i.test(envGet("ODDS_GATEWAY_DISABLED") ?? "")) {
    return blank("denied_gateway_disabled", "ODDS_GATEWAY_DISABLED is set on the function: no provider request of any kind.");
  }
  const want = req.want_body !== false;
  const allowStale = req.allow_stale !== false;
  let attempt = 1, parent: number | null = null;
  let env = blank("denied_gateway_error", null);

  for (;;) {
    const a = await db.rpc("odds_api_acquire", { p: {
      caller: req.caller, trigger: req.trigger, category: req.category, sport_key: req.sport_key,
      event_id: req.event_id, odds_format: req.odds_format, max_age_seconds: req.max_age_seconds,
      commence_time: req.commence_time, date: req.date, attempt, parent_request_id: parent,
    } });
    if (!a.ok || !a.data || typeof a.data !== "object") {
      return blank("denied_gateway_error", "the gateway could not reach its control plane (fail closed): " + (a.error ?? "empty answer"));
    }
    const g = a.data;
    env = fromGrant(blank(String(g.decision ?? "denied_gateway_error"), g.reason ?? null), g);
    env.attempts = attempt;

    if (g.decision === "cache_hit") return await serveSnapshot(db, env, req, true);

    if (g.decision === "in_flight") {
      const target = Number(g.in_flight_request_id);
      const until = Date.now() + IN_FLIGHT_WAIT_MS;
      while (Date.now() < until) {
        await sleep(IN_FLIGHT_POLL_MS);
        const s = await snapshot(db, env.fingerprint!);
        if (s && Number(s.request_id) >= target) return await serveSnapshot(db, env, req, true);
      }
      return allowStale ? await serveSnapshot(db, env, req, false) : env;
    }

    if (g.decision !== "granted") return allowStale ? await serveSnapshot(db, env, req, false) : env;

    if (!key) {
      await db.rpc("odds_api_settle", { p: { request_id: g.request_id, ok: false, http_status: 0, requests_last: 0,
        error: "ODDS_GATEWAY_PROVIDER_KEY is not set on odds_gateway" } });
      env.decision = "denied_no_key"; env.reason = "ODDS_GATEWAY_PROVIDER_KEY is not set on odds_gateway: nothing was requested.";
      return allowStale ? await serveSnapshot(db, env, req, false) : env;
    }

    // ── the provider call: the only one in the repository ──
    const t0 = Date.now();
    let status = 0, text = "", timedOut = false, headers: Headers | null = null;
    try {
      const r = await fetch(providerUrl(g, key, base), { signal: deadline(timeout) });
      status = r.status; headers = r.headers;
      text = await r.text();
    } catch (e) {
      const name = String((e as Error)?.name ?? "");
      timedOut = name === "TimeoutError" || name === "AbortError";
      text = (timedOut ? `TIMEOUT after ${timeout} ms` : "network: ") + String((e as Error)?.message ?? e);
    }
    const h = (n: string) => num(headers ? headers.get(n) : null);
    const used = h("x-requests-used"), remaining = h("x-requests-remaining"), last = h("x-requests-last");
    let body: any = null, parsed = false;
    if (status >= 200 && status < 300) {
      try { body = JSON.parse(text); parsed = true; } catch { parsed = false; }
    }
    const okCall = status >= 200 && status < 300 && parsed;
    const errText = okCall ? null : redact(status ? `HTTP ${status}: ${text}` : text, key);
    const st = await db.rpc("odds_api_settle", { p: {
      request_id: g.request_id, ok: okCall, http_status: status, requests_used: used, requests_remaining: remaining,
      requests_last: last, duration_ms: Date.now() - t0, error: errText, body: okCall ? body : null,
      quota_exhausted: quotaExhausted(status, text, remaining),
    } });
    env.status = status;
    env.quota = { used, remaining, last };
    env.cost = st.ok && st.data && Number.isFinite(Number(st.data.actual_credits)) ? Number(st.data.actual_credits) : (last ?? Number(g.est_credits) ?? 0);

    if (okCall) {
      env.ok = true; env.source = "provider"; env.fresh = true; env.decision = "granted";
      env.fetched_at = new Date().toISOString(); env.age_seconds = 0;
      env.data = want ? body : null;
      env.new_for_consumer = await consume(db, req.consumer, env.fingerprint, Number(g.request_id));
      console.log("ODDS_GATEWAY", JSON.stringify({ caller: req.caller, category: req.category, sport: req.sport_key,
        event: req.event_id ?? null, status, cost: env.cost, remaining, attempt }));
      return env;
    }

    env.detail = errText ?? undefined;
    env.decision = timedOut ? "provider_timeout" : status === 429 ? "provider_429" : status ? `provider_http_${status}` : "provider_unreachable";
    console.log("ODDS_GATEWAY", JSON.stringify({ caller: req.caller, category: req.category, sport: req.sport_key,
      event: req.event_id ?? null, status, timedOut, attempt, decision: env.decision }));
    if (!retryable(status, timedOut) || attempt > maxRetries) {
      return allowStale ? await serveSnapshot(db, env, req, false) : env;
    }
    parent = Number(g.request_id);
    attempt++;
    await sleep(backoffMs(attempt - 1, rnd));
  }
}

/** Free quota check: GET /v4/sports costs nothing and carries the usage
    headers, which is how a new cycle's quota becomes "confirmed". */
async function quotaProbe(envGet: EnvGet): Promise<Envelope> {
  const env = await serve({ caller: "odds_gateway:quota_probe", category: "sports_index", want_body: false, allow_stale: false, max_age_seconds: 0 }, envGet);
  return env;
}

export async function handle(req: Request, envGet: EnvGet = defaultEnv): Promise<Response> {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (req.method === "GET") {
    return json({ ok: true, build: BUILD, note: "POST only. The gateway answers service-role callers; it never serves a browser." });
  }
  const service = (envGet("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const shared = (envGet("ODDS_GATEWAY_SECRET") ?? "").trim();
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const sent = (req.headers.get("x-odds-gateway-secret") ?? "").trim();
  const authorized = (service && (safeEqual(bearer, service) || safeEqual(req.headers.get("apikey") ?? "", service)))
    || (shared && safeEqual(sent, shared));
  if (!authorized) return json({ ok: false, build: BUILD, decision: "unauthorized", reason: "service role or x-odds-gateway-secret required" }, 401);

  let body: GatewayRequest;
  try { body = await req.json(); } catch { return json({ ok: false, build: BUILD, decision: "denied_bad_request", reason: "JSON body required" }, 400); }
  const action = String(body.action ?? "odds");
  try {
    if (action === "status") {
      const db = makeDb(envGet("SUPABASE_URL") ?? "", service);
      const [b, f] = await Promise.all([db.rpc("odds_api_budget_state", {}), db.rpc("odds_feed_status", {})]);
      return json({ ok: b.ok && f.ok, build: BUILD, budget: b.data, feed: f.data });
    }
    if (action === "quota_probe") return json(await quotaProbe(envGet));
    if (action !== "odds") return json({ ok: false, build: BUILD, decision: "denied_bad_request", reason: "unknown action" }, 400);
    return json(await serve(body, envGet));
  } catch (e) {
    return json({ ...blank("denied_gateway_error", "gateway error (fail closed): " + redact(String((e as Error)?.message ?? e), envGet("ODDS_GATEWAY_PROVIDER_KEY") ?? envGet("ODDS_API_KEY") ?? "")) }, 500);
  }
}

if (typeof Deno !== "undefined" && (Deno as any).serve && !Deno.env.get("ODDS_GATEWAY_NO_SERVE")) {
  Deno.serve((req) => handle(req));
}
