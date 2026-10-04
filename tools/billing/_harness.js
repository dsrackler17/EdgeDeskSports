'use strict';
/* ===========================================================================
   One EdgeDesk billing world, for scenario tests:

     a throwaway PostgreSQL with the SHIPPED migrations applied
       (billing.sql, stripe_webhook.sql, referral_codes.sql,
        subscription_price.sql, billing_hardening.sql)
     a PostgREST / Supabase Auth stand-in over it        (_pgrest.js)
     a fake Stripe                                       (_fake_stripe.js)
     the three SHIPPED Edge Functions, loaded whole under a Deno shim:
       stripe_webhook, create_checkout_session, sync_subscription

   Nothing is re-implemented for the test: the functions run their own code
   against the real SQL. Every log line they print is captured, so a test can
   also assert what was NOT logged (a token, a card, a full email).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require('../personal/_pg.js');
const REST = require('./_pgrest.js');
const STRIPE = require('./_fake_stripe.js');

const ROOT = PG.ROOT;
const DB_URL = 'https://db.test';
const SECRET = 'whsec_scenario_secret';

function loadFunction(name, env, fetchImpl, logs) {
  const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', name, 'index.ts'), 'utf8');
  let handler = null;
  const Deno = { env: { get: (k) => (env[k] == null ? undefined : env[k]) }, serve: (h) => { handler = h; } };
  const cap = (level) => (...a) => logs.push({ fn: name, level, line: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });
  const con = { log: cap('info'), warn: cap('warn'), error: cap('error') };
  new Function('Deno', 'fetch', 'console', 'crypto', 'TextEncoder', 'AbortController', 'setTimeout', 'clearTimeout',
    'Response', 'Request', src)(Deno, fetchImpl, con, crypto.webcrypto, TextEncoder, AbortController, setTimeout,
    clearTimeout, Response, Request);
  if (typeof handler !== 'function') throw new Error(name + ' did not register a handler');
  return handler;
}

function world(label, opts) {
  const o = opts || {};
  const db = PG.start(label || 'billw');
  if (db.skip) return { skip: db.skip };
  // o.preMigration: production as it is BEFORE billing_hardening.sql (the
  // deploy-stage test applies it itself, through the deployment's own gate)
  const files = ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'subscription_price.sql']
    .concat(o.extraFiles || [], o.preMigration ? [] : ['billing_hardening.sql']);
  for (const f of files) db.applyFile(path.join(ROOT, 'supabase', f));

  const tokens = {};
  const rest = REST.make(db, { serviceKey: 'service-key', anonKey: 'anon-key', tokens });
  const stripe = STRIPE.make({ live: o.live !== false });
  const logs = [];
  const route = (url, init) => {
    const s = String(url);
    if (s.indexOf('https://api.stripe.com/') === 0) return stripe.api(s, init);
    if (s.indexOf(DB_URL) === 0) return rest.fetch(s, init);
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  };
  const env = Object.assign({
    STRIPE_WEBHOOK_SECRET: SECRET, SB_URL: DB_URL, SB_SERVICE_ROLE: 'service-key',
    SUPABASE_URL: DB_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key',
    STRIPE_SECRET_KEY: 'sk_live_placeholder', STRIPE_PRICE_ID: 'price_4999', STRIPE_TRIAL_DAYS: '7',
    SITE_URL: 'https://edgedesksports.com',
  }, o.env || {});
  const fns = {};
  ['stripe_webhook', 'create_checkout_session', 'sync_subscription'].forEach((n) => { fns[n] = loadFunction(n, env, route, logs); });

  let userSeq = 0;
  function user(email, confirmed) {
    userSeq++;
    const id = '00000000-0000-4000-8000-' + String(userSeq).padStart(12, '0');
    db.sql("insert into auth.users (id, email, email_confirmed_at, created_at) values (" + PG.lit(id) + ', ' + PG.lit(email) +
      ', ' + (confirmed === false ? 'null' : "now() - interval '1 day'") + ", now() - interval '2 days');");
    const token = 'tok_' + userSeq + '_' + crypto.randomBytes(4).toString('hex');
    tokens[token] = { id, email, confirmed: confirmed !== false };
    return { id, email, token };
  }

  async function call(fn, method, body, token, extraHeaders) {
    const headers = Object.assign({ 'content-type': 'application/json', apikey: 'anon-key' }, extraHeaders || {});
    if (token) headers.authorization = 'Bearer ' + token;
    const req = new Request('https://fn.test/functions/v1/' + fn, { method, headers,
      body: method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify(body || {}) });
    const res = await fns[fn](req);
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json, headers: res.headers };
  }

  /* deliver one Stripe event to the webhook, signed the way Stripe signs it */
  async function deliver(event, secret, handler) {
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret || SECRET).update(t + '.' + raw).digest('hex');
    const req = new Request('https://fn.test/functions/v1/stripe_webhook', { method: 'POST',
      headers: { 'stripe-signature': 't=' + t + ',v1=' + sig, 'content-type': 'application/json' }, body: raw });
    const res = await (handler || fns.stripe_webhook)(req);
    return { status: res.status, body: await res.json() };
  }

  const q = (sql) => rest.json(sql);
  const row = (uid) => q('select * from public.subscriptions where user_id = ' + PG.lit(uid))[0] || null;
  const access = (uid) => JSON.parse(db.sql('select public.billing_access_for(' + PG.lit(uid) + ')') || 'null');
  const myAccess = (u) => JSON.parse(db.as(u.id, 'select public.my_billing_access();') || 'null');

  /* the same function under different secrets (no Stripe key, test mode…) */
  function load(name, envOverrides) { return loadFunction(name, Object.assign({}, env, envOverrides || {}), route, logs); }

  return { db, rest, stripe, fns, logs, env, load, user, call, deliver, q, row, access, myAccess, SECRET, route,
           stop: () => db.stop() };
}

module.exports = { world, loadFunction, SECRET };
