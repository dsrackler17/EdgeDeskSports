// ============================================================
//  FILE:    supabase/functions/stripe_webhook/index.ts
//  TYPE:    Edge Function (deployed) - Stripe webhook receiver
//  DEPLOY:  supabase functions deploy stripe_webhook --no-verify-jwt
//           "Enforce JWT verification" MUST be OFF. Stripe does not send a
//           Supabase JWT; it signs with its own secret, which is what this
//           function actually verifies. Leaving JWT on makes every delivery
//           401 and the whole thing silently does nothing.
//  IMPORTS: NONE. One file. The dashboard bundles only this folder and an
//           import that cannot resolve fails the bundle, leaving the previous
//           version serving — indistinguishable from a deploy that worked.
//
//  SECRETS (Project Settings > Edge Functions > Secrets):
//    STRIPE_WEBHOOK_SECRET   whsec_...  from the endpoint you create in Stripe
//    SB_URL                  https://<ref>.supabase.co
//    SB_SERVICE_ROLE         the service_role key
//    STRIPE_SECRET_KEY       sk_live_... — used ONLY to read back a subscription
//                            after a checkout, so a paying customer is never
//                            written in with a null status and locked out.
//
//  Run supabase/billing.sql and supabase/stripe_webhook.sql BEFORE deploying.
// ============================================================
//
// WHAT THIS REPLACES. Nothing. `public.subscriptions` was filled in by hand:
// nine rows typed into the SQL editor, six of them inside ninety seconds, with
// period ends in 2036 and 2108. Customers who paid Stripe were never written
// here at all, so they paid and stayed locked out; five rows have since gone
// stale and are refusing real people entry today. Every one of those problems
// is the same problem — nothing was listening to Stripe.
//
// THE THREE THINGS A MONEY WEBHOOK MUST GET RIGHT
//
//   1. IT MUST NOT TRUST THE CALLER. This endpoint is public and it grants
//      access to a paid product. Without signature verification, anyone who
//      finds the URL can POST themselves a subscription. Every request is
//      checked against STRIPE_WEBHOOK_SECRET with HMAC-SHA256 over Stripe's
//      exact signed payload, compared in constant time, inside a five-minute
//      window so a captured request cannot be replayed tomorrow.
//
//   2. DELIVERY IS AT-LEAST-ONCE AND OUT-OF-ORDER. Stripe retries, and
//      `customer.subscription.updated` routinely arrives before the
//      `checkout.session.completed` that says whose it is. Events are keyed on
//      Stripe's own id so a retry is a no-op, and no event older than the one
//      a row already reflects may overwrite it — otherwise a late-delivered
//      old event resurrects a cancelled subscription.
//
//   3. AN UNKNOWN CUSTOMER IS NOT AN ERROR. Answering 4xx to something we
//      cannot yet attach to an account makes Stripe retry for days and then
//      give up, losing it. It is stored unresolved, answered 200, and
//      reconciled by the next event that names the customer.
//
// WHAT IT REFUSES TO DO. It never invents a user. If an event cannot be tied
// to a real account by client_reference_id, by an existing customer mapping,
// or by an exact email match on a confirmed account, it stays unresolved and a
// human is expected to look. Guessing here means giving away the product, or
// giving one person's subscription to somebody else.

const ENC = new TextEncoder();

// ── the events that mean something to us ──────────────────────────────────
// Everything else is acknowledged and recorded, never acted on. A webhook that
// quietly does something with an event nobody designed for is how a billing
// system starts lying.
const HANDLED = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
];

// ── signature ─────────────────────────────────────────────────────────────
// Stripe sends: Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]
// signed payload is `${t}.${rawBody}` and the digest is HMAC-SHA256 hex.
function parseSigHeader(header) {
  const out = { t: null, v1: [] };
  String(header || '').split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') out.t = v;
    else if (k === 'v1') out.v1.push(v);
  });
  return out;
}

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// Constant time. A comparison that returns early on the first wrong character
// leaks the expected digest one byte at a time to anyone willing to measure.
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, ENC.encode(payload)));
}

// Resolves to { ok:true } or { ok:false, reason } — the reason is for our logs,
// never for the response body. Telling an unauthenticated caller WHY their
// forgery failed is free help for the next attempt.
async function verifySignature(rawBody, header, secret, nowSeconds, toleranceSeconds) {
  const tol = toleranceSeconds == null ? 300 : toleranceSeconds;
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set' };
  const sig = parseSigHeader(header);
  if (!sig.t || !sig.v1.length) return { ok: false, reason: 'malformed Stripe-Signature' };
  const t = Number(sig.t);
  if (!isFinite(t)) return { ok: false, reason: 'non-numeric timestamp' };
  // Replay window, both directions: a captured delivery must not be usable
  // later, and a wildly future timestamp is not something Stripe sends.
  if (Math.abs(nowSeconds - t) > tol) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = await hmacHex(secret, sig.t + '.' + rawBody);
  for (const candidate of sig.v1) if (timingSafeEqual(candidate, expected)) return { ok: true };
  return { ok: false, reason: 'no matching v1 signature' };
}

// ── reading a Stripe object ───────────────────────────────────────────────
// Stripe moved `current_period_end` onto the subscription's items in newer API
// versions and kept it on the subscription in older ones. Read both, so the
// function does not quietly start writing nulls the day the account's API
// version is bumped.
function periodEnd(sub) {
  if (!sub) return null;
  let secs = sub.current_period_end;
  if (secs == null && sub.items && Array.isArray(sub.items.data)) {
    for (const item of sub.items.data) {
      if (item && item.current_period_end != null) {
        if (secs == null || item.current_period_end > secs) secs = item.current_period_end;
      }
    }
  }
  if (secs == null || !isFinite(Number(secs))) return null;
  return new Date(Number(secs) * 1000).toISOString();
}

function idOf(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : (v.id || null);
}

// What a single event says about a subscription, or null if it says nothing.
// Pure, so it is testable without a network or a database.
function readEvent(event) {
  const type = event && event.type;
  const obj = event && event.data && event.data.object;
  if (!obj) return null;

  if (type === 'checkout.session.completed') {
    // The ONLY event that carries our own user id. The payment links set
    // client_reference_id to the Supabase user uuid.
    return {
      kind: 'checkout',
      user_id: obj.client_reference_id || null,
      email: (obj.customer_details && obj.customer_details.email) || obj.customer_email || null,
      customer_id: idOf(obj.customer),
      subscription_id: idOf(obj.subscription),
      // A completed checkout is not yet a status. The subscription events carry
      // the authoritative one; claiming 'active' here would mark a failed or
      // incomplete subscription as paid.
      status: null,
      current_period_end: null,
      cancel_at_period_end: null,
    };
  }

  if (type === 'customer.subscription.created' ||
      type === 'customer.subscription.updated' ||
      type === 'customer.subscription.deleted') {
    return {
      kind: 'subscription',
      user_id: (obj.metadata && obj.metadata.supabase_user_id) || null,
      email: null,
      customer_id: idOf(obj.customer),
      subscription_id: obj.id || null,
      // A deleted subscription is canceled whatever the object still says.
      status: type === 'customer.subscription.deleted' ? 'canceled' : (obj.status || null),
      current_period_end: periodEnd(obj),
      cancel_at_period_end: !!obj.cancel_at_period_end,
    };
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.payment_succeeded') {
    // Stripe moves the subscription to past_due itself and sends a
    // subscription.updated for it, so this is corroboration, not the decision.
    return {
      kind: 'invoice',
      user_id: null,
      email: obj.customer_email || null,
      customer_id: idOf(obj.customer),
      subscription_id: idOf(obj.subscription),
      status: null,
      current_period_end: null,
      cancel_at_period_end: null,
    };
  }

  return null;
}

// Should this event be written over what the row already reflects? Older than
// what we have applied, or the same event again, means no.
function shouldApply(existingLastEventAt, eventCreatedAt) {
  if (!eventCreatedAt) return false;
  if (!existingLastEventAt) return true;
  return new Date(eventCreatedAt).getTime() >= new Date(existingLastEventAt).getTime();
}

// ── the database, over PostgREST with the service role ────────────────────
function db(url, key) {
  const base = String(url || '').replace(/\/+$/, '');
  const headers = {
    apikey: key,
    authorization: 'Bearer ' + key,
    'content-type': 'application/json',
  };
  return {
    async get(path) {
      const r = await fetch(base + '/rest/v1/' + path, { headers });
      if (!r.ok) throw new Error('read ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return r.json();
    },
    async upsert(table, rows, onConflict) {
      const r = await fetch(base + '/rest/v1/' + table +
        (onConflict ? '?on_conflict=' + onConflict : ''), {
        method: 'POST',
        headers: Object.assign({}, headers, {
          prefer: 'return=minimal,resolution=merge-duplicates',
        }),
        body: JSON.stringify(rows),
      });
      if (!r.ok) throw new Error('write ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return true;
    },
    async rpc(fn, args) {
      const r = await fetch(base + '/rest/v1/rpc/' + fn, {
        method: 'POST', headers, body: JSON.stringify(args || {}),
      });
      if (!r.ok) throw new Error('rpc ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return r.json();
    },
    async patch(table, query, row) {
      const r = await fetch(base + '/rest/v1/' + table + '?' + query, {
        method: 'PATCH',
        headers: Object.assign({}, headers, { prefer: 'return=minimal' }),
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error('patch ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return true;
    },
  };
}

// Who is this? Three ways, in descending order of certainty, and no fourth.
async function resolveUser(D, read) {
  if (read.user_id) return { user_id: read.user_id, how: 'client_reference_id' };

  if (read.customer_id) {
    const rows = await D.get('subscriptions?select=user_id&stripe_customer_id=eq.' +
      encodeURIComponent(read.customer_id) + '&limit=1');
    if (rows && rows[0] && rows[0].user_id) return { user_id: rows[0].user_id, how: 'known customer' };
  }

  if (read.email) {
    // Last resort, and the rule lives in the database: public.stripe_user_by_email
    // matches CONFIRMED accounts only. An unconfirmed address proves nothing —
    // anyone can sign up as somebody else's email — and matching one here would
    // hand that person's subscription to a stranger.
    const id = await D.rpc('stripe_user_by_email', { p_email: read.email }).catch(() => null);
    if (id && typeof id === 'string') return { user_id: id, how: 'confirmed email match' };
  }

  return { user_id: null, how: 'unresolved' };
}

// ── asking Stripe what it actually thinks ─────────────────────────────────
// A checkout event says a session completed; it does NOT say the subscription
// is live, so this function refuses to infer one. That was right, and on its
// own it was not enough: the row was created with a null status, and
// pgEntitled() reads a null status as "not entitled" — so somebody who had just
// paid was written into the database and locked out by it.
//
// The subscription event that carries the real status can arrive BEFORE the
// checkout that names the customer, and a resend of it keeps its original
// timestamp, so the ordering guard correctly refuses it. Waiting for an event
// that has already been and gone is not a plan.
//
// So on a checkout we ask Stripe directly. One call, the authoritative answer,
// no dependence on delivery order at all. Without STRIPE_SECRET_KEY it degrades
// to the previous behaviour and says so, rather than guessing.
async function fetchSubscription(subId, secretKey) {
  if (!subId || !secretKey) return null;
  try {
    const r = await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subId), {
      headers: { authorization: 'Bearer ' + secretKey },
    });
    if (!r.ok) {
      console.error('stripe_webhook: subscription lookup ' + r.status);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('stripe_webhook: subscription lookup failed', String(e));
    return null;
  }
}

async function handle(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { 'content-type': 'application/json' },
    });
  }

  const SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const SB_URL = Deno.env.get('SB_URL');
  const SB_KEY = Deno.env.get('SB_SERVICE_ROLE');

  // The raw body, byte for byte. Parsing and re-serialising changes the bytes
  // and every signature check would fail for a reason nobody could see.
  const raw = await req.text();

  const v = await verifySignature(
    raw, req.headers.get('stripe-signature'), SECRET, Math.floor(Date.now() / 1000));
  if (!v.ok) {
    console.error('stripe_webhook: rejected —', v.reason);
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  if (!SB_URL || !SB_KEY) {
    // 500 on purpose: Stripe retries a 500, and a misconfigured function that
    // answered 200 would drop real payments on the floor for good.
    console.error('stripe_webhook: SB_URL / SB_SERVICE_ROLE not set');
    return new Response(JSON.stringify({ error: 'not configured' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  let event = null;
  try { event = JSON.parse(raw); } catch (_) { event = null; }
  if (!event || !event.id || !event.type) {
    return new Response(JSON.stringify({ error: 'unparseable event' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  const D = db(SB_URL, SB_KEY);
  const stripeCreated = event.created ? new Date(event.created * 1000).toISOString() : null;
  const read = readEvent(event);

  // Record the delivery FIRST, keyed on Stripe's id. A retry lands on the same
  // primary key and merges, so the ledger cannot double-count.
  try {
    await D.upsert('stripe_events', [{
      id: event.id,
      type: event.type,
      stripe_created: stripeCreated,
      customer_id: read ? read.customer_id : null,
      subscription_id: read ? read.subscription_id : null,
      payload: event,
      resolved: false,
      applied: false,
      note: HANDLED.indexOf(event.type) < 0 ? 'not a handled event type' : null,
    }], 'id');
  } catch (e) {
    console.error('stripe_webhook: could not record event', String(e));
    return new Response(JSON.stringify({ error: 'ledger write failed' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  if (!read || HANDLED.indexOf(event.type) < 0) {
    // Acknowledged and stored, deliberately not acted on.
    return new Response(JSON.stringify({ ok: true, ignored: event.type }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  let who = { user_id: null, how: 'unresolved' };
  try { who = await resolveUser(D, read); }
  catch (e) { console.error('stripe_webhook: resolve failed', String(e)); }

  if (!who.user_id) {
    // NOT an error. 200 so Stripe stops retrying; the row stays unresolved and
    // shows up in public.stripe_events_unresolved for a human.
    await D.patch('stripe_events', 'id=eq.' + encodeURIComponent(event.id),
      { resolved: false, note: 'no account matched this customer yet' }).catch(() => {});
    console.warn('stripe_webhook: unresolved customer', read.customer_id, event.type);
    return new Response(JSON.stringify({ ok: true, unresolved: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  // What does the row already reflect? An out-of-order delivery must not
  // overwrite a newer one.
  let existing = null;
  try {
    const rows = await D.get('subscriptions?select=last_event_at,status&user_id=eq.' +
      encodeURIComponent(who.user_id) + '&limit=1');
    existing = (rows && rows[0]) || null;
  } catch (e) { console.error('stripe_webhook: read existing failed', String(e)); }

  const fresh = shouldApply(existing && existing.last_event_at, stripeCreated);

  if (fresh) {
    const row = { user_id: who.user_id, updated_at: new Date().toISOString(),
                  last_event_at: stripeCreated, last_event_id: event.id };
    if (read.customer_id) row.stripe_customer_id = read.customer_id;
    if (read.subscription_id) row.stripe_subscription_id = read.subscription_id;
    // Only ever write the fields this event actually carries. Writing a null
    // over a real status would lock out somebody who is paying.
    if (read.status) row.status = read.status;
    if (read.current_period_end) row.current_period_end = read.current_period_end;
    if (read.cancel_at_period_end != null) row.cancel_at_period_end = read.cancel_at_period_end;

    // A CHECKOUT LEAVES NO STATUS, AND A ROW WITH NO STATUS IS A LOCKED-OUT
    // CUSTOMER. Ask Stripe for the subscription rather than hoping the event
    // that carries it turns up in a helpful order.
    if (read.kind === 'checkout' && read.subscription_id && !row.status) {
      const live = await fetchSubscription(read.subscription_id, Deno.env.get('STRIPE_SECRET_KEY'));
      if (live && live.status) {
        row.status = live.status;
        const pe = periodEnd(live);
        if (pe) row.current_period_end = pe;
        row.cancel_at_period_end = !!live.cancel_at_period_end;
      } else {
        console.warn('stripe_webhook: checkout for ' + read.subscription_id +
          ' left no status — set STRIPE_SECRET_KEY, or the customer stays locked out');
      }
    }

    try {
      await D.upsert('subscriptions', [row], 'user_id');
    } catch (e) {
      // 500 so Stripe retries. Losing this is losing a payment.
      console.error('stripe_webhook: subscription write failed', String(e));
      return new Response(JSON.stringify({ error: 'subscription write failed' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
  }

  await D.patch('stripe_events', 'id=eq.' + encodeURIComponent(event.id), {
    user_id: who.user_id, resolved: true, applied: fresh,
    note: fresh ? ('applied via ' + who.how) : 'superseded by a newer event',
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, applied: fresh, how: who.how }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(handle);
