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
//                            written in with a null status and locked out, and
//                            to turn a promo_... id into the code a customer
//                            actually typed.
//
//  FOR A DRY RUN, AND ONLY FOR AS LONG AS ONE IS RUNNING:
//    STRIPE_WEBHOOK_SECRET_TEST  whsec_... from a TEST-MODE endpoint pointed at
//                            this same URL. Both secrets are accepted, so a
//                            test delivery can be proved end to end without
//                            disturbing the live secret for a second — which
//                            is the alternative, and it is an outage.
//    STRIPE_SECRET_KEY_TEST  sk_test_... A test-mode id looked up with a live
//                            key answers 404, which is indistinguishable from
//                            a promotion code that does not exist. Every
//                            lookup for a livemode:false event uses this.
//  Both are optional and unset is the normal state. A delivery accepted on the
//  test secret says `livemode: false` in its response and warns in the log, so
//  a test event can never be mistaken for a sale.
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
//
// AND IT RECORDS WHICH DISCOUNT CODE THE SALE CAME IN UNDER. A promotion code
// redeemed at checkout is the only thing that says a partner sent this
// customer, and it exists for about a second — on the checkout session, in the
// event that is delivered once. It is read from the session (or from the
// subscription Stripe returns), named, and written to public.subscriptions
// beside the sale it belongs to. Run supabase/referral_codes.sql first; the
// write is deliberately separate from the status write, so a project without
// those columns loses the attribution and NOT the customer's access.
//
// THE BUILD MARKER. Every response carries `build` and an `x-edgedesk-build`
// header, including the 405 a plain GET gets, so the deployed version can be
// confirmed from a browser or one curl without sending a signed event:
//
//   curl -s https://<ref>.supabase.co/functions/v1/stripe_webhook
//   {"build":"stripe_webhook-2026-09-12-referral-1","error":"POST only"}

const ENC = new TextEncoder();

// ── which build is actually serving ───────────────────────────────────────
// The dashboard deploy path is delete-the-function, create-it-again, clear the
// template, paste, deploy — and a bundle that fails leaves the PREVIOUS version
// serving, which is indistinguishable from a deploy that worked and changed
// nothing. This string is how that is told apart. Bump it with every paste.
const BUILD = 'stripe_webhook-2026-09-12-referral-1';

// One place responses are made, so a reply cannot exist that forgot to say
// which build produced it.
function json(body, status) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'x-edgedesk-build': BUILD },
  });
}

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

// ── rows Stripe does not own ──────────────────────────────────────────────
// `price_id = 'owner_comp'` is full access granted inside this database and
// never bought: no Stripe customer, no Stripe subscription, nothing for an
// event to be about. The same list, under the same name, gates the paywall in
// app.html and the checkout in index.html; keep the three in step.
const COMP_PRICE_IDS = ['owner_comp'];

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

// ── the promotion code, normalised ────────────────────────────────────────
// Stripe matches a promotion code case-insensitively when it is redeemed, so
// one code arrives as BETDESK, betdesk and BetDesk. Upper-casing is what stops
// a single code becoming three lines in the report. Anything outside the
// character set a Stripe promotion code can hold is refused rather than
// scrubbed into something that merely looks like one — a sanitised string would
// be attributed to a code nobody ever created.
function normCode(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return /^[A-Z0-9_.-]{1,64}$/.test(s) ? s : null;
}

// ── what discount, if any, a session or a subscription carried ────────────
// Stripe reports this in several shapes and WHICH ONE ARRIVES DEPENDS ON THE
// ACCOUNT'S API VERSION — the same trap periodEnd() above exists for:
//
//   session.discounts[]                      [{coupon, promotion_code}] as ids
//                                            on older versions; Discount
//                                            objects from 2025-01-27.acacia
//   session.total_details.breakdown.discounts[]   [{amount, discount:{…}}],
//                                            present only when expanded
//   subscription.discount / .discounts[]     the same Discount, on the
//                                            subscription the checkout created
//
// so every one of them is read and the first that names a promotion code wins.
//
// A COUPON ID IS NOT AN ANSWER. Two promotion codes can share one coupon, so a
// coupon alone says a discount happened, not who sent the customer. It is
// recorded as exactly that much and never promoted into a code.
function readDiscount(obj) {
  const out = { promotion_code_id: null, coupon_id: null, code: null };
  if (!obj || typeof obj !== 'object') return out;

  const take = (d) => {
    if (!d) return;
    if (typeof d === 'string') {
      // A bare id. Only a promo_… is unambiguous; a di_… is a discount id,
      // which names nothing without another round trip, and is not guessed at.
      if (d.indexOf('promo_') === 0 && !out.promotion_code_id) out.promotion_code_id = d;
      return;
    }
    if (typeof d !== 'object') return;
    // a breakdown entry, {amount, discount:{…}}, wraps the real thing
    if (d.discount) take(d.discount);
    const pc = d.promotion_code;
    if (typeof pc === 'string') {
      if (!out.promotion_code_id) out.promotion_code_id = pc;
    } else if (pc && typeof pc === 'object') {
      if (pc.id && !out.promotion_code_id) out.promotion_code_id = pc.id;
      if (pc.code && !out.code) out.code = normCode(pc.code);
    }
    if (d.coupon && !out.coupon_id) out.coupon_id = idOf(d.coupon);
  };

  const lists = [
    obj.discounts,
    obj.total_details && obj.total_details.breakdown && obj.total_details.breakdown.discounts,
  ];
  for (const list of lists) if (Array.isArray(list)) list.forEach(take);
  if (obj.discount) take(obj.discount);
  return out;
}

function hasDiscount(d) {
  return !!(d && (d.promotion_code_id || d.coupon_id || d.code));
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
      // The one event that can carry the promotion code the customer typed.
      discount: readDiscount(obj),
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
      // The discount the checkout put on the subscription. Corroboration, and
      // the fallback for an account whose API version leaves `discounts` off
      // the checkout session entirely.
      discount: readDiscount(obj),
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
      discount: null,
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

// Which Stripe key may answer a question about this event. Asking a live key
// about a test object gets a 404 — which reads exactly like an object that does
// not exist, and would quietly turn a dry run into a false negative.
function stripeKeyFor(livemode) {
  return livemode === false
    ? (Deno.env.get('STRIPE_SECRET_KEY_TEST') || null)
    : (Deno.env.get('STRIPE_SECRET_KEY') || null);
}

// A promotion code id (promo_…) is not a code. This is the one call that turns
// it into the string the customer typed. It is the LAST resort on purpose:
// referral_codes is asked first, so attribution keeps working on a day the
// Stripe API is slow or STRIPE_SECRET_KEY is unset.
async function fetchPromotionCode(promoId, secretKey) {
  if (!promoId || !secretKey) return null;
  try {
    const r = await fetch('https://api.stripe.com/v1/promotion_codes/' + encodeURIComponent(promoId), {
      headers: { authorization: 'Bearer ' + secretKey },
    });
    if (!r.ok) {
      console.error('stripe_webhook: promotion code lookup ' + r.status);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('stripe_webhook: promotion code lookup failed', String(e));
    return null;
  }
}

// Turn whatever the event carried into the row's attribution, or null when the
// sale used no discount at all. Three ways to name a code, in descending order
// of certainty, and no fourth — in particular, nothing here ever picks a code
// because it happens to be the only one on file. A discount we cannot name is
// recorded as an unnamed discount, which the report shows on its own line.
async function resolveReferral(D, d, secretKey, seenOn) {
  if (!hasDiscount(d)) return null;

  const out = {
    code: d.code || null,
    promotion_code_id: d.promotion_code_id || null,
    coupon_id: d.coupon_id || null,
    partner: null,
    source: seenOn + ':inline',
  };

  // 1. Our own table, keyed on the promotion code id. No network at all.
  if (!out.code && out.promotion_code_id) {
    const rows = await D.get('referral_codes?select=code,partner_name,stripe_coupon_id' +
      '&stripe_promotion_code_id=eq.' + encodeURIComponent(out.promotion_code_id) + '&limit=1')
      .catch(() => null);
    if (rows && rows[0] && rows[0].code) {
      out.code = normCode(rows[0].code);
      out.partner = rows[0].partner_name || null;
      out.source = seenOn + ':referral_codes';
      if (!out.coupon_id) out.coupon_id = rows[0].stripe_coupon_id || null;
    }
  }

  // 2. Ask Stripe what that id is called.
  if (!out.code && out.promotion_code_id) {
    const pc = await fetchPromotionCode(out.promotion_code_id, secretKey);
    if (pc && pc.code) {
      out.code = normCode(pc.code);
      out.source = seenOn + ':stripe_lookup';
      if (!out.coupon_id) out.coupon_id = idOf(pc.coupon);
    }
  }

  // 3. A discount that could not be named is still recorded, as that.
  if (!out.code) out.source = seenOn + ':unnamed_discount';

  // The partner name is a SNAPSHOT taken at the sale, like the offer text on a
  // billing consent: renaming a partner next year must not quietly rewrite what
  // last year's sales say they were sold under.
  if (out.code && !out.partner) {
    const rows = await D.get('referral_codes?select=partner_name&code=eq.' +
      encodeURIComponent(out.code) + '&limit=1').catch(() => null);
    if (rows && rows[0]) out.partner = rows[0].partner_name || null;
  }

  return out;
}

async function handle(req) {
  // A plain GET is not an error worth hiding: it is how the deployed build is
  // confirmed from the dashboard or a curl. It still refuses to do anything.
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  const SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  // Present only while a dry run is being done. See the header.
  const SECRET_TEST = Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST');
  const SB_URL = Deno.env.get('SB_URL');
  const SB_KEY = Deno.env.get('SB_SERVICE_ROLE');

  // The raw body, byte for byte. Parsing and re-serialising changes the bytes
  // and every signature check would fail for a reason nobody could see.
  const raw = await req.text();

  const nowSec = Math.floor(Date.now() / 1000);
  let v = await verifySignature(raw, req.headers.get('stripe-signature'), SECRET, nowSec);
  // A TEST-MODE ENDPOINT SIGNS WITH ITS OWN SECRET, so proving this function
  // before pointing live money at it otherwise means swapping the live secret
  // out and back — an outage, during which real payments are refused. The
  // second secret is tried only after the live one has already failed, so the
  // live path is not lengthened and nothing about it changes when it is unset.
  if (!v.ok && SECRET_TEST) {
    const t = await verifySignature(raw, req.headers.get('stripe-signature'), SECRET_TEST, nowSec);
    if (t.ok) v = t;
  }
  if (!v.ok) {
    console.error('stripe_webhook: rejected —', v.reason);
    return json({ error: 'invalid signature' }, 400);
  }

  if (!SB_URL || !SB_KEY) {
    // 500 on purpose: Stripe retries a 500, and a misconfigured function that
    // answered 200 would drop real payments on the floor for good.
    console.error('stripe_webhook: SB_URL / SB_SERVICE_ROLE not set');
    return json({ error: 'not configured' }, 500);
  }

  let event = null;
  try { event = JSON.parse(raw); } catch (_) { event = null; }
  if (!event || !event.id || !event.type) {
    return json({ error: 'unparseable event' }, 400);
  }

  const D = db(SB_URL, SB_KEY);
  const stripeCreated = event.created ? new Date(event.created * 1000).toISOString() : null;
  const read = readEvent(event);
  // Stripe stamps every event with this. A test delivery is recorded and
  // answered exactly like a real one — the ledger keeps the whole payload, so
  // `payload->>'livemode' = 'false'` finds them all again — but it says so in
  // the log and in the response, because a dry run that is indistinguishable
  // from a sale is not a dry run.
  const livemode = event.livemode !== false;
  if (!livemode) console.warn('stripe_webhook: TEST MODE delivery ' + event.id + ' (' + event.type + ')');

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
    return json({ error: 'ledger write failed' }, 500);
  }

  if (!read || HANDLED.indexOf(event.type) < 0) {
    // Acknowledged and stored, deliberately not acted on.
    return json({ ok: true, ignored: event.type }, 200);
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
    return json({ ok: true, unresolved: true }, 200);
  }

  // What does the row already reflect? An out-of-order delivery must not
  // overwrite a newer one.
  let existing = null;
  try {
    const rows = await D.get('subscriptions?select=last_event_at,status,price_id,referral_code&user_id=eq.' +
      encodeURIComponent(who.user_id) + '&limit=1');
    existing = (rows && rows[0]) || null;
  } catch (e) { console.error('stripe_webhook: read existing failed', String(e)); }

  // A COMPED ROW IS NOT STRIPE'S TO WRITE. `price_id = 'owner_comp'` is access
  // granted in this database, never bought — there is no Stripe subscription
  // behind it, so no Stripe event describes it. If one ever arrives carrying
  // this user_id (a customer id reused across products, a test event, a
  // payment link fired at the wrong account), applying it would set the row's
  // status from something Stripe knows about and revoke access that Stripe
  // never granted. Acknowledged with 200 so Stripe stops retrying: refusing
  // this write is the correct outcome, not a failure to be redelivered.
  if (existing && COMP_PRICE_IDS.indexOf(String(existing.price_id || '')) >= 0) {
    console.log('stripe_webhook: ignoring ' + event.type + ' for comped user ' + who.user_id +
      ' (price_id ' + existing.price_id + ')');
    return json({ ok: true, ignored: 'comped_subscription' }, 200);
  }

  const fresh = shouldApply(existing && existing.last_event_at, stripeCreated);
  let liveSub = null;

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
      const live = await fetchSubscription(read.subscription_id, stripeKeyFor(livemode));
      liveSub = live;
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
      return json({ error: 'subscription write failed' }, 500);
    }
  }

  // ── WHICH CODE THIS SALE CAME IN UNDER ───────────────────────────────────
  // Its own write, after the status one, for three reasons.
  //
  // IT MUST NOT BE ABLE TO COST SOMEBODY THEIR ACCESS. On a project where
  // supabase/referral_codes.sql has not been run these columns do not exist,
  // and folding them into the row above would make every delivery a 500 —
  // Stripe retrying a paying customer forever while their status never lands.
  // Attribution is worth having. It is not worth that, so it fails on its own
  // and says so in the log.
  //
  // AN OLD EVENT STILL KNOWS SOMETHING NEW. The ordering guard refuses a late
  // delivery because it must not overwrite a newer STATUS. A promotion code is
  // not a status; it is a fact about the sale that the row may never have been
  // told. So this runs whether or not the event was fresh.
  //
  // AND THE FIRST ATTRIBUTION WINS. `referral_code=is.null` is in the FILTER,
  // not in an if — so two deliveries racing produce one credited code rather
  // than whichever landed last, and a code already on the row is never
  // rewritten by a later event. A row that carries an unnamed discount still
  // matches, so it can be upgraded the moment the code can be named.
  // Already credited? The filter below would refuse the write anyway, but every
  // subsequent event for an attributed customer would first cost a table read
  // and, when the code still needs naming, a call to Stripe — all for a write
  // that can only ever match zero rows. The guarantee is the filter; this is
  // only the saving.
  let referral = null;
  if (!(existing && existing.referral_code)) {
    try {
      let disc = read.discount;
      let seenOn = read.kind === 'checkout' ? 'checkout_session' : 'subscription_object';
      // An older API version can leave `discounts` off the checkout session
      // altogether. When Stripe has already handed us the subscription the
      // checkout created, the discount is on that — look there rather than
      // recording "no code" for a sale that used one.
      if (!hasDiscount(disc) && liveSub) {
        const alt = readDiscount(liveSub);
        if (hasDiscount(alt)) { disc = alt; seenOn = 'subscription_object'; }
      }
      referral = await resolveReferral(D, disc, stripeKeyFor(livemode), seenOn);
      if (referral) {
        const patch = { referral_source: referral.source };
        if (referral.code) patch.referral_code = referral.code;
        if (referral.partner) patch.referred_partner = referral.partner;
        if (referral.promotion_code_id) patch.stripe_promotion_code_id = referral.promotion_code_id;
        if (referral.coupon_id) patch.stripe_coupon_id = referral.coupon_id;
        await D.patch('subscriptions',
          'user_id=eq.' + encodeURIComponent(who.user_id) + '&referral_code=is.null', patch);
      }
    } catch (e) {
      // Loud, and only in the log. A customer is not told about this and Stripe
      // is not asked to retry it: the money side of the delivery already landed.
      console.error('stripe_webhook: referral attribution not recorded —', String(e),
        '(run supabase/referral_codes.sql if these columns do not exist yet)');
    }
  }

  await D.patch('stripe_events', 'id=eq.' + encodeURIComponent(event.id), {
    user_id: who.user_id, resolved: true, applied: fresh,
    note: fresh ? ('applied via ' + who.how) : 'superseded by a newer event',
  }).catch(() => {});

  return json({
    ok: true, applied: fresh, how: who.how, livemode,
    // What was actually recorded, so a test-mode dry run can be read off the
    // response instead of guessed at from the database afterwards.
    referral_code: referral ? referral.code : null,
    referral_source: referral ? referral.source : null,
  }, 200);
}

Deno.serve(handle);
