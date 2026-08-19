// Model Collective billing: Stripe Checkout redirect and the webhook that
// locks attribution and posts the referral ledger. Ships inert (rule 8.13):
// with billing.enabled false or Stripe secrets unset, checkout reports
// not-live and nothing charges, while attribution keeps recording upstream.

import { json, err, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { getUser } from "../_shared/auth.ts";
import { sha256hex } from "../_shared/keys.ts";
import { BASE_URL } from "../_shared/env.ts";

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
      if (!WEBHOOK_SECRET) return err("server_error", "Webhook secret is not configured.", 503);
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
        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : (obj.status === "past_due" ? "past_due" : obj.status === "canceled" ? "canceled" : "active");
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
