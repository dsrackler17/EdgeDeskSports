#!/usr/bin/env node
/* ============================================================================
   THE EMAIL PROVIDER — Resend, and a driver that sends nothing.

   WHY A NEW INTEGRATION. Nothing in this repository sends email. Supabase
   Auth sends its own confirmation mail through the project's own configured
   SMTP, which is a different product with a different sending reputation and
   no bulk API, no webhooks and no suppression list. A weekly newsletter needs
   all three, so this is the one new external dependency the system takes on.

   WHY RESEND. The requirements, in order: a batch send API with per-message
   headers (so every recipient gets their own List-Unsubscribe URL); webhook
   events that distinguish delivered from bounced from complained; signed
   webhooks; and a verified sending domain with DKIM and DMARC. Resend has all
   of them behind one API key and one DNS setup. Nothing below is Resend-shaped
   except `resendDriver`; the pipeline talks to `send()`.

   THE FOUR THINGS THAT MAKE AN UNATTENDED SEND SAFE:

   1  IDEMPOTENCY IS DETERMINISTIC. A batch's key is a hash of the edition's
      content hash and the exact set of addresses in that batch. A retry of an
      identical batch presents an identical key and the provider returns the
      original result instead of sending twice. A retry with a DIFFERENT set
      of addresses is a different request and gets a different key, which is
      correct — it is a different send.

   2  AN AMBIGUOUS RESPONSE IS ITS OWN OUTCOME. A timeout, a dropped
      connection or a 5xx with no body means WE DO NOT KNOW whether the
      provider accepted the batch. That is never recorded as a failure,
      because a failure is retried and a retry after a silent success is a
      duplicate email. It is recorded as `ambiguous`, and the only safe retry
      is one carrying the same idempotency key.

   3  ACCEPTANCE IS NOT DELIVERY. `send()` returns `accepted`. Delivery,
      bounce and complaint arrive later, over the webhook, and are stored as
      separate states. Nothing in this file ever writes `delivered`.

   4  ONE-CLICK UNSUBSCRIBE IS A HEADER, NOT A LINK. RFC 8058: a
      `List-Unsubscribe` URL plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
      lets Gmail and Apple Mail show their own unsubscribe control and POST to
      it without the reader opening anything. Bulk senders are required to
      support it, and a newsletter that does not is a newsletter that gets
      filtered.

   THE SECRETS NEVER REACH A BROWSER: the API key is read from the environment
   of the job or the edge function, and no page in this repository contains it.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

const RESEND_ENDPOINT = 'https://api.resend.com';
/* Resend's batch endpoint takes at most 100 messages per call. */
const MAX_BATCH = 100;

function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function config(env) {
  env = env || process.env;
  return {
    driver: txt(env.NEWSLETTER_PROVIDER) || 'resend',
    apiKey: txt(env.RESEND_API_KEY) || null,
    endpoint: txt(env.RESEND_ENDPOINT) || RESEND_ENDPOINT,
    timeoutMs: Number(env.NEWSLETTER_SEND_TIMEOUT_MS || 30000),
  };
}

/* The key a retry has to reproduce exactly. Content hash plus the sorted
   address set: same edition, same people, same key. */
function idempotencyKeyFor(editionKey, contentHash, emails) {
  const list = (emails || []).map(e => String(e).toLowerCase()).sort().join(',');
  return 'edgedesk-' + sha256(editionKey + '|' + (contentHash || '') + '|' + list).slice(0, 48);
}

/* ------------------------------------------------------------- messages */
/* One message per recipient, personalised only in the three places a
   newsletter may be personalised: the address it goes to and the two
   per-recipient management URLs. The body is otherwise byte-identical for
   everybody, which is what makes a stored edition reproducible. */
function messagesFor(edition, recipients, opts) {
  opts = opts || {};
  const RENDER = opts.render || require('./render.js');
  const from = (opts.from_name ? opts.from_name + ' <' + opts.from_email + '>' : opts.from_email);
  return (recipients || []).map(r => {
    const variant = r.variant === 'member' ? 'member' : 'free';
    const html = RENDER.personalise(variant === 'member' ? edition.html_member : edition.html_free, r.urls);
    const text = RENDER.personalise(variant === 'member' ? edition.text_member : edition.text_free, r.urls);
    return {
      from,
      to: [r.email],
      subject: edition.subject,
      html,
      text,
      reply_to: opts.reply_to_email || undefined,
      headers: {
        /* RFC 8058 — the provider-supported one-click control. Two values:
           the HTTPS endpoint clients POST to, and a mailto for the handful
           that still prefer it. */
        'List-Unsubscribe': '<' + r.urls.unsubscribe + '>'
          + (opts.unsubscribe_mailto ? ', <mailto:' + opts.unsubscribe_mailto + '>' : ''),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'List-Id': 'EdgeDesk ' + edition.sport + ' Week Ahead <newsletter.edgedesksports.com>',
        /* the edition this message belongs to, so a webhook with only a
           message id can still be traced back without a lookup table */
        'X-Entity-Ref-ID': edition.edition_key + '/' + sha256(r.email).slice(0, 16),
      },
    };
  });
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------ the drivers */
/* A driver takes one batch and returns one of three shapes:
     { ok: true,  accepted: [{ email, message_id }] }
     { ok: false, ambiguous: false, error: '...' }     definitely not sent
     { ok: false, ambiguous: true,  error: '...' }     WE DO NOT KNOW          */

async function resendDriver(batch, ctx) {
  const cfg = ctx.config;
  if (!cfg.apiKey) return { ok: false, ambiguous: false, error: 'RESEND_API_KEY is not set' };
  const f = ctx.fetch;
  let res, body;
  try {
    res = await f(cfg.endpoint + '/emails/batch', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cfg.apiKey,
        'content-type': 'application/json',
        /* Resend honours this header and returns the original response for a
           repeat of the same request within its retention window. */
        'Idempotency-Key': ctx.idempotencyKey,
      },
      body: JSON.stringify(batch.messages),
      signal: ctx.signal,
    });
  } catch (e) {
    /* A THROWN FETCH IS THE AMBIGUOUS CASE. The request may have reached the
       provider and the response may have been lost on the way back. */
    return { ok: false, ambiguous: true, error: 'transport: ' + (e && e.message ? e.message : String(e)) };
  }
  try { body = await res.text(); } catch (e) { body = ''; }

  if (res.status >= 500) {
    return { ok: false, ambiguous: true, error: 'provider ' + res.status + ': ' + String(body).slice(0, 300) };
  }
  if (!res.ok) {
    /* A 4xx is a fact about the request: it was rejected and nothing was
       sent. Safe to record as a failure and safe to fix and retry. */
    return { ok: false, ambiguous: false, error: 'provider ' + res.status + ': ' + String(body).slice(0, 300) };
  }
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
  const data = parsed && (Array.isArray(parsed) ? parsed : parsed.data);
  if (!Array.isArray(data)) {
    /* A 2xx we cannot read is still a 2xx: the provider probably accepted it. */
    return { ok: false, ambiguous: true, error: 'provider returned 2xx with an unreadable body: ' + String(body).slice(0, 200) };
  }
  if (data.length !== batch.messages.length) {
    /* A PARTIAL BATCH. The provider accepted some of what we sent; the rest
       are unknown, not failed. Pair by position, which is the order the API
       documents, and mark the tail ambiguous. */
    const accepted = data.map((d, i) => ({ email: batch.emails[i], message_id: txt(d && d.id) }))
      .filter(x => x.email);
    return { ok: true, partial: true, accepted,
      ambiguous_emails: batch.emails.slice(data.length),
      error: 'provider returned ' + data.length + ' ids for ' + batch.messages.length + ' messages' };
  }
  return { ok: true, accepted: data.map((d, i) => ({ email: batch.emails[i], message_id: txt(d && d.id) })) };
}

/* Sends nothing, records everything. What a dry run, a suite and a
   pre-launch preview use — and the reason no test in this repository can
   email a real subscriber. */
async function consoleDriver(batch, ctx) {
  (ctx.sent || []).push({ idempotency_key: ctx.idempotencyKey, emails: batch.emails.slice(),
    subject: batch.messages[0] && batch.messages[0].subject });
  return { ok: true, accepted: batch.emails.map((e, i) => ({ email: e, message_id: 'console-' + ctx.idempotencyKey.slice(-8) + '-' + i })) };
}

const DRIVERS = { resend: resendDriver, console: consoleDriver };

/* --------------------------------------------------------------- send() */
/* send({ edition, recipients, settings, env, fetch, driver, dry })

   `recipients` is [{ email, variant, urls: { unsubscribe, preferences, webview } }].
   Returns one outcome per recipient and never throws for a provider problem —
   a send that cannot report what happened is worse than one that failed. */
async function send(opts) {
  opts = opts || {};
  const edition = opts.edition;
  if (!edition) throw new Error('send() needs an edition');
  const cfg = Object.assign(config(opts.env), opts.configOverride || {});
  const driverName = opts.dry ? 'console' : (opts.driver || cfg.driver || 'resend');
  const driver = DRIVERS[driverName];
  if (!driver) throw new Error('unknown email provider driver: ' + driverName);

  const s = opts.settings || {};
  const size = Math.min(MAX_BATCH, Math.max(1, Number(opts.batch_size || s.batch_size || MAX_BATCH)));
  const recipients = (opts.recipients || []).filter(r => r && r.email);
  /* A DETERMINISTIC BATCH COMPOSITION, so a retry of an unchanged recipient
     set produces the same batches and therefore the same idempotency keys. */
  recipients.sort((a, b) => String(a.email).toLowerCase().localeCompare(String(b.email).toLowerCase()));

  const sentLog = [];
  const ctxBase = {
    config: cfg,
    fetch: opts.fetch || ((...a) => fetch(...a)),
    sent: sentLog,
  };

  const outcomes = [];
  const batches = chunk(recipients, size);
  for (let i = 0; i < batches.length; i++) {
    const group = batches[i];
    const emails = group.map(r => r.email);
    const messages = messagesFor(edition, group, {
      from_name: s.from_name, from_email: s.from_email,
      reply_to_email: s.reply_to_email,
      unsubscribe_mailto: s.unsubscribe_mailto || null,
      render: opts.render,
    });
    const key = idempotencyKeyFor(edition.edition_key, edition.content_hash, emails);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), cfg.timeoutMs) : null;
    let res;
    try {
      res = await driver({ messages, emails }, Object.assign({}, ctxBase, {
        idempotencyKey: key, signal: ctl ? ctl.signal : undefined,
      }));
    } catch (e) {
      res = { ok: false, ambiguous: true, error: 'driver threw: ' + (e && e.message ? e.message : String(e)) };
    } finally { if (timer) clearTimeout(timer); }

    if (res.ok) {
      (res.accepted || []).forEach(a => outcomes.push({
        email: a.email, status: 'accepted', provider_message_id: a.message_id,
        idempotency_key: key, ambiguous: false, error: null, batch: i,
      }));
      (res.ambiguous_emails || []).forEach(e => outcomes.push({
        email: e, status: 'queued', provider_message_id: null,
        idempotency_key: key, ambiguous: true, error: res.error || 'partial batch', batch: i,
      }));
    } else {
      emails.forEach(e => outcomes.push({
        email: e, status: res.ambiguous ? 'queued' : 'failed', provider_message_id: null,
        idempotency_key: key, ambiguous: !!res.ambiguous, error: res.error || 'send failed', batch: i,
      }));
    }
  }

  const by = k => outcomes.filter(o => o.status === k).length;
  return {
    driver: driverName,
    batches: batches.length,
    batch_size: size,
    outcomes,
    counts: { accepted: by('accepted'), failed: by('failed'),
      ambiguous: outcomes.filter(o => o.ambiguous).length, total: outcomes.length },
    console_log: driverName === 'console' ? sentLog : undefined,
  };
}

/* ---------------------------------------------------------- the webhook */
/* Resend signs webhooks with Svix: the signed content is
   `<svix-id>.<svix-timestamp>.<raw body>`, HMAC-SHA256 with the base64 secret
   after the `whsec_` prefix, and the header carries one or more space-separated
   `v1,<base64>` values because a secret rotation publishes both.

   TIMING-SAFE COMPARISON, and a timestamp window, because a replayed webhook
   with a valid old signature is the attack this check exists to stop. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

function verifyWebhook(rawBody, headers, secret, opts) {
  opts = opts || {};
  const h = {};
  Object.keys(headers || {}).forEach(k => { h[String(k).toLowerCase()] = headers[k]; });
  const id = h['svix-id'] || h['webhook-id'];
  const ts = h['svix-timestamp'] || h['webhook-timestamp'];
  const sig = h['svix-signature'] || h['webhook-signature'];
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!id || !ts || !sig) return { ok: false, reason: 'missing_signature_headers' };

  const now = opts.now == null ? Math.floor(Date.now() / 1000) : Math.floor(opts.now / 1000);
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: 'unreadable_timestamp' };
  const tolerance = opts.tolerance_seconds == null ? WEBHOOK_TOLERANCE_SECONDS : opts.tolerance_seconds;
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: 'timestamp_outside_tolerance' };

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const signed = id + '.' + ts + '.' + String(rawBody);
  const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
  const given = String(sig).split(' ').map(p => p.split(',').pop());
  const eb = Buffer.from(expected);
  const match = given.some(g => {
    const gb = Buffer.from(String(g));
    return gb.length === eb.length && crypto.timingSafeEqual(gb, eb);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

/* The provider's event vocabulary, mapped onto the five states this system
   tracks. An event type that is not in this map is stored and NOT acted on,
   which is the safe direction: a new provider event never silently changes a
   delivery state nobody has reasoned about. */
const EVENT_MAP = {
  'email.sent': { status: 'accepted' },
  'email.delivered': { status: 'delivered' },
  'email.delivery_delayed': { status: null },
  'email.bounced': { status: 'bounced', suppress: 'bounce' },
  'email.complained': { status: 'complained', suppress: 'complaint' },
  'email.opened': { status: null },
  'email.clicked': { status: null },
};

function interpretEvent(payload) {
  const type = txt(payload && payload.type);
  const data = (payload && payload.data) || {};
  const map = EVENT_MAP[type] || null;
  const to = Array.isArray(data.to) ? data.to[0] : data.to;
  return {
    type,
    known: !!map,
    status: map ? map.status : null,
    suppress: map ? (map.suppress || null) : null,
    email: txt(to) ? String(to).toLowerCase() : null,
    message_id: txt(data.email_id) || txt(data.id) || null,
    /* A SOFT BOUNCE IS NOT A HARD ONE. Resend reports a bounce subtype; only
       a permanent failure suppresses the address forever. */
    permanent: type === 'email.bounced'
      ? !/transient|soft/i.test(String((data.bounce && data.bounce.type) || data.bounce_type || 'permanent'))
      : null,
  };
}

module.exports = {
  RESEND_ENDPOINT, MAX_BATCH, WEBHOOK_TOLERANCE_SECONDS, EVENT_MAP, DRIVERS,
  config, idempotencyKeyFor, messagesFor, chunk,
  send, verifyWebhook, interpretEvent, sha256,
};
