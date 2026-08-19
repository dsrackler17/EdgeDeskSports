// collective_billing - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_billing
// IMPORTANT: turn OFF "Enforce JWT verification" for this function.

// ---------- inlined _shared/env.ts ----------
// Shared environment access for Collective edge functions.
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY are injected
// by the Supabase runtime. COLLECTIVE_BASE_URL is an optional secret that
// points at the public site root and defaults to production.

const SB_URL: string = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY: string = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY: string = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const BASE_URL: string = Deno.env.get("COLLECTIVE_BASE_URL") ?? "https://edgedesksports.com";

// ---------- inlined _shared/http.ts ----------
// Shared HTTP helpers: JSON responses, the contract error shape, CORS, and
// subpath routing. Every Collective edge function builds its responses here so
// the error taxonomy and CORS behavior stay identical across functions.

function corsHeaders(origin = "*"): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-collective-key, x-client-info",
    "Access-Control-Max-Age": "86400",
  };
  if (origin !== "*") {
    headers["Vary"] = "Origin";
  }
  return headers;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...headers,
    },
  });
}

// Error response in the contract shape { error: { code, message, details } }.
// details is always present, null when there is nothing row-level to report.
function err(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  return json({ error: { code, message, details: details ?? null } }, status);
}

// Returns a 204 Response for OPTIONS requests, else null.
function preflight(req: Request, origin = "*"): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Path after /functions/v1/<fnName>, normalized. Works both behind the
// production gateway (/functions/v1/<fnName>/...) and when served locally
// (/<fnName>/...). "" becomes "/", duplicate slashes collapse, and a
// trailing slash is stripped except on the root.
function subpath(req: Request, fnName: string): string {
  const pathname = new URL(req.url).pathname;
  const marker = `/${fnName}`;
  const idx = pathname.indexOf(marker);
  let rest = idx >= 0 ? pathname.slice(idx + marker.length) : pathname;
  if (!rest.startsWith("/")) rest = `/${rest}`;
  rest = rest.replace(/\/{2,}/g, "/");
  if (rest.length > 1 && rest.endsWith("/")) rest = rest.slice(0, -1);
  return rest;
}

// ---------- inlined _shared/db.ts ----------
// Shared database access. Edge functions never talk SQL: they call the
// SECURITY DEFINER RPCs in the collective schema through PostgREST with the
// service role key. RPCs return jsonb outcome objects like { ok: true, ... }
// or { ok: false, code: "token_expired", message: "..." }; callers translate
// ok:false codes to the HTTP error taxonomy. RpcError means an unexpected
// database failure and maps to 500 server_error (log it, never leak the body).


class RpcError extends Error {
  status: number;
  body: string;

  constructor(fn: string, status: number, body: string) {
    super(`rpc ${fn} failed with status ${status}`);
    this.name = "RpcError";
    this.status = status;
    this.body = body;
  }
}

async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "collective",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RpcError(fn, res.status, text);
  }
  if (text === "") {
    return null as T;
  }
  return JSON.parse(text) as T;
}

// ---------- inlined _shared/keys.ts ----------
// Shared key and token primitives. Submission keys are
// mck_live_{8 base62}{32 base62} or mck_test_{8 base62}{32 base62}.
// Invite tokens are mci_{24 base62}. Only the sha256 hex of the full raw
// string is ever stored; the prefix is stored for lookup and display.

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Unbiased base62 string via rejection sampling over crypto.getRandomValues.
// 248 is the largest multiple of 62 that fits in a byte, so bytes at or above
// it are discarded instead of skewing the distribution.
function randBase62(n: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i];
      if (b < 248) {
        out.push(BASE62[b % 62]);
      }
    }
  }
  return out.join("");
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const KEY_RE = /^mck_(live|test)_([0-9A-Za-z]{8})[0-9A-Za-z]{32}$/;

// Validates shape mck_live_<8+32 base62> or mck_test_<8+32 base62>.
// prefix is the 8 chars after mck_live_ or mck_test_.
function parseCollectiveKey(
  raw: string,
): { prefix: string; kind: "live" | "test" } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { prefix: m[2], kind: m[1] as "live" | "test" };
}

// New submission key. The raw string is shown once; hash is sha256hex of the
// FULL raw key string.
async function newApiKey(
  kind: "live" | "test",
): Promise<{ raw: string; prefix: string; hash: string }> {
  const prefix = randBase62(8);
  const secret = randBase62(32);
  const raw = `mck_${kind}_${prefix}${secret}`;
  const hash = await sha256hex(raw);
  return { raw, prefix, hash };
}

// New invite token mci_<24 base62>; prefix is the first 8 of the 24; hash is
// sha256hex of the full raw token.
async function newInviteToken(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  const body = randBase62(24);
  const raw = `mci_${body}`;
  const hash = await sha256hex(raw);
  return { raw, prefix: body.slice(0, 8), hash };
}

// ---------- inlined _shared/auth.ts ----------
// Shared JWT auth. Bearer tokens are validated against Supabase Auth by
// calling /auth/v1/user; the JWT is never decoded locally, so revoked or
// expired sessions fail closed. Admin checks compare the user id against the
// admin.user_ids config list via the get_config RPC.




async function getUser(
  req: Request,
): Promise<{ id: string; email: string | null } | null> {
  const authz = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  let res: Response;
  try {
    res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: {
        "apikey": ANON_KEY,
        "Authorization": authz,
      },
    });
  } catch (e) {
    console.error("auth.getUser: auth service unreachable:", e);
    return null;
  }
  if (!res.ok) return null;
  const user = await res.json().catch(() => null) as
    | { id?: string; email?: string | null }
    | null;
  if (!user || typeof user.id !== "string" || user.id.length === 0) return null;
  return { id: user.id, email: typeof user.email === "string" ? user.email : null };
}

// getUser plus membership of admin.user_ids. Returns the user, or an err()
// Response (401 invalid_key or 403 forbidden) ready to return to the caller.
async function requireAdmin(
  req: Request,
): Promise<{ id: string; email: string | null } | Response> {
  const user = await getUser(req);
  if (!user) {
    return err("invalid_key", "A valid signed-in session is required.", 401);
  }
  const cfg = await rpc<unknown>("get_config", { p_key: "admin.user_ids" });
  const ids = Array.isArray(cfg) ? cfg.filter((v) => typeof v === "string") : [];
  if (!ids.includes(user.id)) {
    return err("forbidden", "This account is not an administrator.", 403);
  }
  return user;
}

// ---------- collective_billing/index.ts ----------
// Model Collective billing: Stripe Checkout redirect and the webhook that
// locks attribution and posts the referral ledger. Ships inert (rule 8.13):
// with billing.enabled false or Stripe secrets unset, checkout reports
// not-live and nothing charges, while attribution keeps recording upstream.






const STRIPE_SECRET = Deno.env.get("COLLECTIVE_STRIPE_SECRET") ?? "";
const WEBHOOK_SECRET = Deno.env.get("COLLECTIVE_STRIPE_WEBHOOK_SECRET") ?? "";
const PRICE_MONTHLY = Deno.env.get("COLLECTIVE_PRICE_MONTHLY") ?? "";
const PRICE_ANNUAL = Deno.env.get("COLLECTIVE_PRICE_ANNUAL") ?? "";

async function stripe(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`stripe ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data as Record<string, unknown>;
}

// Stripe-Signature: t=timestamp,v1=hmac_sha256(secret, `${t}.${rawBody}`)
async function verifyStripeSignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_billing");

  try {
    if (req.method === "GET" && path === "/v1/billing/checkout") {
      const enabled = await rpc<unknown>("get_config", { p_key: "billing.enabled" });
      if (enabled !== true || !STRIPE_SECRET || !PRICE_MONTHLY || !PRICE_ANNUAL) {
        return json({
          live: false,
          message: "Billing is not live yet. The record is being built in the open first; subscriptions open once the wall has a verified season behind it.",
        });
      }
      const u = new URL(req.url);
      const plan = u.searchParams.get("plan") === "annual" ? "annual" : "monthly";
      const ref = (u.searchParams.get("ref") ?? "").slice(0, 60);
      const visitor = (u.searchParams.get("visitor") ?? "").slice(0, 64);
      const user = await getUser(req);
      const session = await stripe("checkout/sessions", {
        "mode": "subscription",
        "line_items[0][price]": plan === "annual" ? PRICE_ANNUAL : PRICE_MONTHLY,
        "line_items[0][quantity]": "1",
        "success_url": `${BASE_URL}/collective/?sub=ok`,
        "cancel_url": `${BASE_URL}/collective/#join`,
        "client_reference_id": JSON.stringify({ ref, visitor, user_id: user?.id ?? null }).slice(0, 190),
        ...(user?.email ? { "customer_email": user.email } : {}),
      });
      return new Response(null, { status: 302, headers: { "Location": String(session.url) } });
    }

    if (req.method === "POST" && path === "/v1/billing/webhook") {
      if (!WEBHOOK_SECRET) return err("server_error", "Webhook secret is not configured.", 500);
      const raw = await req.text();
      if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature")))) {
        return err("forbidden", "Signature verification failed.", 403);
      }
      const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
      const obj = event.data?.object ?? {};

      if (event.type === "checkout.session.completed") {
        let refCtx: { ref?: string; visitor?: string; user_id?: string | null } = {};
        try { refCtx = JSON.parse(String(obj.client_reference_id ?? "{}")); } catch { /* absent */ }
        const email = String((obj.customer_details as Record<string, unknown>)?.email ?? obj.customer_email ?? "");
        await rpc("billing_upsert_subscriber", {
          p_event: {
            user_id: refCtx.user_id ?? null,
            email,
            email_hash: email ? await sha256hex(email.toLowerCase()) : null,
            status: "active",
            stripe_customer_id: obj.customer ?? null,
            stripe_subscription_id: obj.subscription ?? null,
            visitor: refCtx.visitor ?? null,
            ref_slug: refCtx.ref ?? null,
          },
        });
      } else if (event.type === "invoice.paid") {
        const lines = (obj.lines as { data?: { period?: { start?: number } }[] })?.data ?? [];
        const start = lines[0]?.period?.start;
        await rpc("billing_post_invoice", {
          p: {
            stripe_subscription_id: obj.subscription ?? null,
            amount_cents: obj.amount_paid ?? 0,
            period_month: start ? new Date(start * 1000).toISOString().slice(0, 8) + "01" : null,
            stripe_ref: obj.id ?? null,
          },
        });
      } else if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
        await rpc("billing_post_refund", { p: { stripe_ref: obj.invoice ?? obj.id ?? null } });
      } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        // Explicit status map: only genuinely paying states keep access.
        // unpaid, paused, incomplete, and incomplete_expired all read as
        // canceled rather than defaulting to active.
        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : (obj.status === "active" || obj.status === "trialing")
          ? "active"
          : obj.status === "past_due"
          ? "past_due"
          : "canceled";
        await rpc("billing_upsert_subscriber", {
          p_event: {
            stripe_customer_id: obj.customer ?? null,
            stripe_subscription_id: obj.id ?? null,
            status,
            current_period_end: typeof obj.current_period_end === "number"
              ? new Date(obj.current_period_end * 1000).toISOString() : null,
          },
        });
      }
      return json({ received: true });
    }

    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_billing rpc failure:", e.message, e.body);
    else console.error("collective_billing failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
