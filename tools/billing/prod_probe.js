#!/usr/bin/env node
/* ===========================================================================
   PRODUCTION PROBES FOR THE BILLING DEPLOYMENT (.github/workflows/deploy-billing.yml)

   Each mode asks the DEPLOYED system one set of questions and answers each with
   PASS / FAIL / WARN / SKIP. It exits 1 if anything FAILED (2 for a cron STOP),
   so a workflow stage cannot go green on a deployment that did not verify.

     functions [--require a,b]   which build each billing function is serving,
                                 and whether its secrets are configured
     sync                        Phase 6: sync_subscription's guarantees
     webhook                     Phase 7: stripe_webhook answers, refuses unsigned
     checkout                    Phase 8: create_checkout_session's guarantees
     frontend                    Phase 9: the live site serves this commit's pages
     trace [--since ISO] [--wait S]   Phase 7: one real delivery, end to end
     cron --since ISO [--wait S] Phase 11: what the first sweeps did; exit 2 = STOP
     subject --user UUID [--price price_…]  Phase 13: has this account converged?

   WHO IT ACTS AS. Never a real customer. The tests that need a signed-in reader
   use two PROBE accounts it creates once and reuses (user_metadata.billing_probe
   = true; BILLING_PROBE_EMAIL_A / _B, default billing-probe-a|b@edgedesksports.com),
   confirmed through the Auth admin API so no email is sent. Each run gives them
   a fresh random password that is never printed. Probe B is given a comp_trial
   row for the comp tests and it is removed again in a finally block.

   WHAT IT LEAVES BEHIND, BY DESIGN: billing_sync_log rows for the probe
   accounts; and after `checkout`, a Stripe customer for probe A and ONE open,
   unpaid Checkout Session that expires on its own within 24 hours. Nothing is
   ever charged, no Stripe object is invented, and nothing about any real
   account is written.

   WHAT IT NEVER PRINTS: a token, a password, a key, a full email, a full
   account id, a full Stripe id. The logs it writes to are public.

   ENV: SB_URL, SB_SERVICE_ROLE (the secrets the other deploy workflows hold);
        SB_ANON optional (read from index.html, where it is public anyway);
        SITE_URL optional (https://edgedesksports.com).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const FUNCTIONS = ['sync_subscription', 'stripe_webhook', 'create_checkout_session'];

function expectedBuild(name) {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', name, 'index.ts'), 'utf8');
    const m = /const BUILD = '([^']+)'/.exec(src);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
function anonFromSource() {
  try {
    const m = /var SB_KEY="(eyJ[^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    return m ? m[1] : '';
  } catch (_) { return ''; }
}
function pricing() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_pricing.js'), 'utf8');
  const cents = /PRICE_CENTS:\s*(\d+)/.exec(src), days = /TRIAL_DAYS:\s*(\d+)/.exec(src);
  return { price_cents: cents ? +cents[1] : null, trial_days: days ? +days[1] : null };
}
const mask = (v) => (v == null ? null : String(v).slice(0, 8) + '…');
const maskEmail = (e) => { const s = String(e || ''); const i = s.indexOf('@'); return i < 1 ? '***' : s[0] + '***' + s.slice(i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProbe(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const F = o.fetch || fetch;
  const out = o.log || ((s) => console.log(s));
  const E = (k) => String(env[k] || '').trim();
  const SB = E('SB_URL').replace(/\/+$/, '');
  const SERVICE = E('SB_SERVICE_ROLE');
  const ANON = E('SB_ANON') || anonFromSource();
  const SITE = (E('SITE_URL') || 'https://edgedesksports.com').replace(/\/+$/, '');
  const results = [];

  function report(verdict, label, detail) {
    results.push({ verdict, label, detail: detail == null ? null : detail });
    out(verdict.padEnd(5) + ' ' + label + (detail != null && detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  }
  const check = (ok, label, detail) => report(ok ? 'PASS' : 'FAIL', label, ok ? null : detail);

  async function http(url, init) {
    const r = await F(url, init);
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    const hdr = r.headers && typeof r.headers.get === 'function' ? r.headers.get('x-edgedesk-build') : null;
    return { status: r.status, ok: r.ok, body, build: (body && body.build) || hdr || null };
  }
  // a function, as the browser calls it: the public anon key, and a user's token when there is one
  function fn(name, method, body, token, extra) {
    const headers = Object.assign({ apikey: ANON, 'content-type': 'application/json' }, extra || {});
    if (token) headers.authorization = 'Bearer ' + token;
    return http(SB + '/functions/v1/' + name, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  }
  const SH = () => ({ apikey: SERVICE, authorization: 'Bearer ' + SERVICE, 'content-type': 'application/json' });
  async function db(q) {
    const r = await http(SB + '/rest/v1/' + q, { headers: SH() });
    if (!r.ok) throw new Error('db ' + q.split('?')[0] + ' ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 160));
    return r.body;
  }
  async function rpc(name, args) {
    const r = await http(SB + '/rest/v1/rpc/' + name, { method: 'POST', headers: SH(), body: JSON.stringify(args || {}) });
    if (!r.ok) throw new Error('rpc ' + name + ' ' + r.status);
    return r.body;
  }
  async function dbWrite(method, q, body) {
    const r = await http(SB + '/rest/v1/' + q, { method, headers: Object.assign(SH(), { prefer: 'return=minimal,resolution=merge-duplicates' }),
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error('db ' + method + ' ' + q.split('?')[0] + ' ' + r.status);
  }
  const need = () => {
    const missing = [!SB && 'SB_URL', !SERVICE && 'SB_SERVICE_ROLE', !ANON && 'SB_ANON'].filter(Boolean);
    if (missing.length) { report('FAIL', 'credentials present', 'missing ' + missing.join(', ')); return false; }
    return true;
  };

  /* ── the probe accounts ─────────────────────────────────────────────────── */
  // paged until an empty page: Auth may cap per_page below what is asked for
  async function findUser(email) {
    for (let page = 1; page <= 400; page++) {
      const r = await http(SB + '/auth/v1/admin/users?page=' + page + '&per_page=1000', { headers: SH() });
      if (!r.ok) throw new Error('auth admin list ' + r.status);
      const list = (r.body && (r.body.users || r.body)) || [];
      const hit = list.find((u) => String(u.email || '').toLowerCase() === email.toLowerCase());
      if (hit) return hit.id;
      if (!list.length) return null;
    }
    return null;
  }
  async function probeUser(tag) {
    const email = (E('BILLING_PROBE_EMAIL_' + tag.toUpperCase()) || ('billing-probe-' + tag + '@edgedesksports.com')).toLowerCase();
    const password = crypto.randomBytes(24).toString('base64url');
    let id = await findUser(email);
    if (!id) {
      const r = await http(SB + '/auth/v1/admin/users', { method: 'POST', headers: SH(),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { billing_probe: true } }) });
      if (!r.ok || !(r.body && (r.body.id || (r.body.user && r.body.user.id)))) throw new Error('could not create probe account ' + tag + ' (' + r.status + ')');
      id = r.body.id || r.body.user.id;
    } else {
      const r = await http(SB + '/auth/v1/admin/users/' + id, { method: 'PUT', headers: SH(),
        body: JSON.stringify({ password, email_confirm: true, user_metadata: { billing_probe: true } }) });
      if (!r.ok) throw new Error('could not reset probe account ' + tag + ' (' + r.status + ')');
    }
    const t = await http(SB + '/auth/v1/token?grant_type=password', { method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!t.ok || !t.body || !t.body.access_token) throw new Error('probe account ' + tag + ' could not sign in (' + t.status + ')');
    return { tag, id: String(id).toLowerCase(), email, token: t.body.access_token };
  }
  async function stateOf(uid) {
    const [row, custs, sessions] = await Promise.all([
      db('subscriptions?select=status,price_id,current_period_end,cancel_at_period_end,stripe_customer_id,stripe_subscription_id,updated_at&user_id=eq.' + uid),
      db('billing_customers?select=stripe_customer_id,source&user_id=eq.' + uid + '&order=stripe_customer_id.asc'),
      db('billing_checkout_sessions?select=id,status,price_id,livemode&user_id=eq.' + uid + '&order=created_at.desc&limit=20'),
    ]);
    return { row: (row && row[0]) || null, customers: custs || [], sessions: sessions || [] };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const REF = /^EDS-[A-Z0-9]{6}$/;

  /* ── modes ──────────────────────────────────────────────────────────────── */
  async function functions(require) {
    const req = (require || []).filter(Boolean);
    for (const name of FUNCTIONS) {
      const want = expectedBuild(name);
      let r;
      try { r = await fn(name, 'GET'); } catch (e) { report(req.indexOf(name) >= 0 ? 'FAIL' : 'WARN', name + ' reachable', String(e.message || e)); continue; }
      const serving = r.build || null;
      const configured = r.body && r.body.configured;
      const notDeployed = r.status === 404 && !serving;
      const label = name + ': serving ' + (serving || (notDeployed ? 'nothing (not deployed)' : 'an unmarked build, HTTP ' + r.status)) +
        (want ? ' · this commit is ' + want : '');
      if (req.indexOf(name) >= 0) {
        check(serving === want, label, 'expected ' + want);
        if (configured) check(Object.keys(configured).every((k) => configured[k] || (name === 'create_checkout_session' && k === 'price')),
          name + ' secrets configured ' + JSON.stringify(configured), configured);
      } else {
        report('INFO', label + (configured ? ' · configured ' + JSON.stringify(configured) : ''));
      }
    }
  }

  async function webhook() {
    if (!need()) return;
    const want = expectedBuild('stripe_webhook');
    const g = await fn('stripe_webhook', 'GET');
    check(g.build === want, 'stripe_webhook serves this commit (' + want + ')', 'serving ' + g.build + ' (HTTP ' + g.status + ')');
    check(g.status === 405, 'a GET does nothing (405)', g.status);
    const u = await http(SB + '/functions/v1/stripe_webhook', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_probe_unsigned', type: 'customer.subscription.updated', data: { object: {} } }) });
    check(u.status === 400 && u.body && u.body.error === 'invalid signature',
      'an unsigned delivery is refused (signature verification is on, and JWT verification is off)', { status: u.status, body: u.body });
    const b = await http(SB + '/functions/v1/stripe_webhook', { method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=' + Math.floor(Date.now() / 1000) + ',v1=' + '0'.repeat(64) },
      body: JSON.stringify({ id: 'evt_probe_forged', type: 'checkout.session.completed', livemode: true, data: { object: {} } }) });
    check(b.status === 400 && b.body && b.body.error === 'invalid signature', 'a forged signature is refused', { status: b.status });
    const led = (await db('stripe_events?select=id&id=eq.evt_probe_unsigned')).concat(await db('stripe_events?select=id&id=eq.evt_probe_forged'));
    check(led.length === 0, 'and neither reached the ledger', led);
  }

  async function sync() {
    if (!need()) return;
    const want = expectedBuild('sync_subscription');
    const g = await fn('sync_subscription', 'GET');
    check(g.build === want, 'sync_subscription serves this commit (' + want + ')', 'serving ' + g.build + ' (HTTP ' + g.status + ')');
    const cfg = (g.body && g.body.configured) || {};
    check(cfg.stripe_key && cfg.database && cfg.auth, 'configured: Stripe key, database, auth', cfg);

    // 4. no identity at all, a token Auth does not know, the public anon key as a "token"
    let r = await fn('sync_subscription', 'POST', {});
    check(r.status === 401 && r.body && r.body.reason === 'sign_in_required', 'unauthenticated: refused (401)', r);
    r = await fn('sync_subscription', 'POST', {}, 'not-a-real-token');
    check(r.status === 401, 'a garbage token: refused (401)', r.status);
    r = await fn('sync_subscription', 'POST', {}, ANON);
    check(r.status === 401, 'the anon key used as a user token: refused (401)', r.status);

    const A = await probeUser('a');
    const B = await probeUser('b');
    report('INFO', 'probe accounts ready', 'A ' + mask(A.id) + ' ' + maskEmail(A.email) + ' · B ' + mask(B.id) + ' ' + maskEmail(B.email));
    await dbWrite('DELETE', 'subscriptions?user_id=eq.' + B.id).catch(() => null);
    const recent = await db('billing_sync_log?select=id&user_id=eq.' + A.id + '&source=eq.self&outcome=eq.admitted&at=gt.' +
      encodeURIComponent(new Date(Date.now() - 600000).toISOString()));
    if (recent.length > 3) {
      report('FAIL', 'probe A has a fresh rate-limit budget', recent.length + ' syncs in the last 10 minutes from an earlier run — wait 10 minutes and run this stage again');
      return;
    }
    const before = await stateOf(A.id);
    const bBefore = await stateOf(B.id);

    // 3. an account with no Stripe billing history (or only the probe's own unpaid session)
    r = await fn('sync_subscription', 'POST', {}, A.token);
    check(r.status === 200 && r.body?.ok === true, 'a signed-in reader with no subscription: answered (200)', { status: r.status, body: r.body });
    check(r.body && r.body.has_access === false && r.body.outcome === 'no_stripe_subscription',
      'Stripe has nothing, so nothing is granted: outcome no_stripe_subscription', r.body && { outcome: r.body.outcome, has_access: r.body.has_access });
    check(r.body && REF.test(String(r.body.ref || '')), 'a support reference is issued (EDS-XXXXXX)', r.body && r.body.ref);
    const ref1 = r.body && r.body.ref;
    const logged = ref1 ? await db('billing_sync_log?select=user_id,source,outcome,ok&ref=eq.' + encodeURIComponent(ref1) + '&outcome=neq.admitted') : [];
    check(logged.length === 1 && logged[0].user_id === A.id && logged[0].outcome === 'no_stripe_subscription',
      'the reference finds exactly this attempt in billing_sync_log (what support searches)', logged);
    let after = await stateOf(A.id);
    check(after.row === null, 'no subscriptions row was invented for an account Stripe has nothing for', after.row);

    // 6. repeated
    r = await fn('sync_subscription', 'POST', {}, A.token);
    const after2 = await stateOf(A.id);
    check(r.status === 200 && r.body?.outcome === 'no_stripe_subscription' && same(after2, after), 'repeated: the same answer, nothing changed', { outcome: r.body && r.body.outcome });

    // 5. a body naming another account changes nothing about whose billing is read
    r = await fn('sync_subscription', 'POST', { user_id: B.id, customer_id: 'cus_' + 'X'.repeat(14), source: 'self' }, A.token);
    const named = r.body && r.body.ref ? await db('billing_sync_log?select=user_id&ref=eq.' + encodeURIComponent(r.body.ref) + '&outcome=neq.admitted') : [];
    check(r.status === 200 && named.length === 1 && named[0].user_id === A.id,
      'a body naming another account is ignored: the caller\'s own account is the one reconciled', named);
    const bNow = await stateOf(B.id);
    check(bNow.row === null && same(bNow.customers, bBefore.customers) && same(bNow.sessions, bBefore.sessions),
      'and the named account was not touched', { row: bNow.row });

    // 8. a malformed checkout session id
    for (const sid of ['not-a-session', 'cs_live_<script>', 'cs_live_' + 'a'.repeat(300)]) {
      r = await fn('sync_subscription', 'POST', { source: 'checkout_return', session_id: sid }, A.token);
      check(r.status === 200 && r.body?.ok === true, 'a malformed session id is ignored, not an error (' + sid.slice(0, 16) + '…)', r.status);
    }
    // 9. a checkout session that belongs to another account (the newest real one in the ledger)
    const real = (await db('stripe_events?select=payload,user_id&type=eq.checkout.session.completed&order=created_at.desc&limit=5'))
      .filter((e) => e.user_id && e.user_id !== A.id);
    const realSid = real[0] && real[0].payload && real[0].payload.data && real[0].payload.data.object && real[0].payload.data.object.id;
    if (realSid && /^cs_(live|test)_/.test(realSid)) {
      const custBefore = await stateOf(A.id);
      r = await fn('sync_subscription', 'POST', { source: 'checkout_return', session_id: realSid }, A.token);
      const custAfter = await stateOf(A.id);
      check(r.status === 200 && same(custAfter.customers, custBefore.customers) && custAfter.row === null,
        'another account\'s checkout session names nothing here: no customer linked, no row', { status: r.status, customers: custAfter.customers.length });
    } else {
      report('SKIP', 'another account\'s checkout session', 'no completed checkout in the ledger to borrow (the checkout stage repeats this with the probe\'s own session)');
    }

    // 2. a comp account: refreshing access never touches it
    const comp = { user_id: B.id, status: 'trialing', price_id: 'comp_trial', current_period_end: new Date(Date.now() + 864e5).toISOString(),
      cancel_at_period_end: true };
    try {
      await dbWrite('POST', 'subscriptions?on_conflict=user_id', [comp]);
      const b0 = await stateOf(B.id);
      r = await fn('sync_subscription', 'POST', {}, B.token);
      const b1 = await stateOf(B.id);
      check(r.status === 200 && r.body?.has_access === true && r.body?.access?.is_comp_trial === true,
        'a comp_trial account: access confirmed', r.body && { has_access: r.body.has_access, outcome: r.body.outcome });
      check(same(b1.row, b0.row), 'and its comp_trial row is untouched by Stripe\'s view (no Stripe state invented or applied)', { before: b0.row, after: b1.row });
      await dbWrite('POST', 'subscriptions?on_conflict=user_id', [{ user_id: B.id, status: 'active', price_id: 'owner_comp', current_period_end: null, cancel_at_period_end: false }]);
      const c0 = await stateOf(B.id);
      r = await fn('sync_subscription', 'POST', {}, B.token);
      const c1 = await stateOf(B.id);
      check(r.status === 200 && r.body?.outcome === 'comp' && r.body?.has_access === true && same(c1.row, c0.row),
        'an owner_comp account: outcome comp, row untouched', r.body && { outcome: r.body.outcome });
    } finally {
      await dbWrite('DELETE', 'subscriptions?user_id=eq.' + B.id).catch((e) => report('FAIL', 'probe B\'s comp row removed again', String(e.message || e)));
    }

    // admin actions are not for readers
    r = await fn('sync_subscription', 'POST', { action: 'admin_inspect', query: B.id }, A.token);
    check(r.status === 403, 'a reader cannot use the operator actions (403)', r.status);
    r = await fn('sync_subscription', 'POST', { action: 'admin_sync', user_id: B.id });
    check(r.status === 401, 'nor can nobody (401)', r.status);

    // 7. rate limiting: keep asking until refused
    let limited = null;
    for (let i = 0; i < 16 && !limited; i++) {
      r = await fn('sync_subscription', 'POST', {}, A.token);
      if (r.status === 429) limited = r;
      else if (r.status !== 200) { report('FAIL', 'sync while under the limit', r.status); break; }
    }
    check(!!limited && limited.body?.reason === 'rate_limited' && limited.body?.retry_after_s > 0 &&
      limited.body?.access?.has_access === false, 'rate limited after the per-account allowance: 429 with retry_after_s and the current decision', limited && limited.body);
    after = await stateOf(A.id);
    check(after.row === null && same(after.customers, before.customers), 'after every probe, still no invented state for probe A', after);
  }

  async function checkout() {
    if (!need()) return;
    const want = expectedBuild('create_checkout_session');
    const g = await fn('create_checkout_session', 'GET');
    check(g.build === want, 'create_checkout_session serves this commit (' + want + ')', 'serving ' + g.build + ' (HTTP ' + g.status + ')');
    const cfg = (g.body && g.body.configured) || {};
    check(cfg.stripe_key && cfg.database && cfg.auth, 'configured: Stripe key, database, auth', cfg);
    const offer = pricing();
    let r = await fn('create_checkout_session', 'POST', Object.assign({ kind: 'trial' }, offer));
    if (!cfg.price) {
      check(r.status === 503 && r.body && r.body.fallback_ok === true && r.body.reason === 'not_configured',
        'STRIPE_PRICE_ID unset: 503 not_configured with fallback_ok (the page keeps using the Payment Link)', r);
      report('WARN', 'server-side checkout is OFF (kill switch)', 'set STRIPE_PRICE_ID (stage input stripe_price_id) to turn it on; every other probe here needs it');
      return;
    }
    check(r.status === 401, 'unauthenticated: refused (401) before anything is created', r.status);

    const A = await probeUser('a');
    const B = await probeUser('b');
    const s0 = await stateOf(A.id);
    r = await fn('create_checkout_session', 'POST', { kind: 'trial', price_cents: offer.price_cents + 1, trial_days: offer.trial_days }, A.token);
    check(r.status === 409 && r.body?.reason === 'offer_mismatch', 'a price the customer did not consent to is refused (409 offer_mismatch)', { status: r.status, reason: r.body && r.body.reason });
    r = await fn('create_checkout_session', 'POST', { kind: 'trial', price_cents: offer.price_cents, trial_days: offer.trial_days + 7 }, A.token);
    check(r.status === 409 && r.body?.reason === 'offer_mismatch', 'a trial length the customer did not consent to is refused (409)', { status: r.status, reason: r.body && r.body.reason });
    r = await fn('create_checkout_session', 'POST', { kind: 'resubscribe', price_cents: offer.price_cents, trial_days: 0 }, A.token);
    check(r.status === 400 && r.body?.reason === 'bad_kind', 'only the trial offer is sold here (400 bad_kind)', r.status);
    r = await fn('create_checkout_session', 'POST', { kind: 'trial', price_cents: 'free' }, A.token);
    check(r.status === 400 && r.body?.reason === 'bad_offer', 'an offer without the consented figures is refused (400)', r.status);
    const s1 = await stateOf(A.id);
    check(same(s1.sessions, s0.sessions), 'none of those created a Checkout Session', s1.sessions.length - s0.sessions.length);

    // the real thing — and a body that tries to name somebody else, and a price id the browser cannot choose
    r = await fn('create_checkout_session', 'POST', Object.assign({ kind: 'trial', user_id: B.id, client_reference_id: B.id,
      price: 'price_' + 'X'.repeat(14), price_id: 'price_' + 'X'.repeat(14) }, offer), A.token);
    const okUrl = r.status === 200 && r.body?.ok === true && /^https:\/\/checkout\.stripe\.com\//.test(String(r.body?.url || ''));
    check(okUrl, 'a signed-in reader gets a Stripe-hosted checkout (checkout.stripe.com)', { status: r.status, reason: r.body && r.body.reason, message: r.body && r.body.message });
    if (!okUrl) return;
    const sid = r.body.session_id;
    check(/^cs_live_/.test(sid), 'it is a LIVE session (the configured price and key are live-mode)', mask(sid));
    const rec = (await db('billing_checkout_sessions?select=user_id,status,price_id,livemode,trial_days,stripe_customer_id&id=eq.' + encodeURIComponent(sid)))[0];
    check(rec && rec.user_id === A.id && rec.livemode === true && rec.status === 'open' && rec.trial_days === offer.trial_days && /^price_/.test(rec.price_id) &&
      rec.price_id !== 'price_' + 'X'.repeat(14), 'recorded for the CALLER\'s account (from the token, not the body), at the server\'s price', rec && { user: mask(rec.user_id), livemode: rec.livemode });
    const linked = (await db('billing_customers?select=stripe_customer_id,source,user_id&stripe_customer_id=eq.' + encodeURIComponent(rec.stripe_customer_id)))[0];
    check(linked && linked.user_id === A.id, 'its Stripe customer was linked to the account BEFORE any payment', linked && { source: linked.source });
    check((await stateOf(B.id)).sessions.length === 0, 'and nothing was created for the account the body named', null);

    // opened twice: the same session, never a second
    const seen = new Set([sid]);
    let limited = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const again = await fn('create_checkout_session', 'POST', Object.assign({ kind: 'trial' }, offer), A.token);
      if (again.status === 429) { limited = again; break; }
      if (again.status !== 200) { report('FAIL', 'checkout opened again', { status: again.status, reason: again.body && again.body.reason }); break; }
      seen.add(again.body.session_id);
      if (i === 0) check(again.body.reused === true && again.body.session_id === sid, 'checkout opened twice: the SAME session is returned (reused)', { reused: again.body.reused });
    }
    check(seen.size === 1, 'however many times it is opened, one session (one possible charge)', seen.size);
    check(!!limited && limited.body?.reason === 'rate_limited', 'and the per-account checkout allowance is enforced (429)', limited && limited.status);

    // the success URL's session id only counts for its owner
    r = await fn('sync_subscription', 'POST', { source: 'checkout_return', session_id: sid }, B.token);
    const bState = await stateOf(B.id);
    check(r.status === 200 && bState.customers.every((c) => c.stripe_customer_id !== rec.stripe_customer_id) && bState.row === null,
      'another account presenting this session id gains nothing (no customer link, no row)', { status: r.status });

    // a comp account the page might misread cannot buy
    try {
      await dbWrite('POST', 'subscriptions?on_conflict=user_id', [{ user_id: B.id, status: 'trialing', price_id: 'comp_trial',
        current_period_end: new Date(Date.now() + 864e5).toISOString(), cancel_at_period_end: true }]);
      r = await fn('create_checkout_session', 'POST', Object.assign({ kind: 'trial' }, offer), B.token);
      check(r.status === 409 && r.body?.reason === 'already_entitled', 'an account that already has access cannot start a checkout (409 already_entitled)', { status: r.status, reason: r.body && r.body.reason });
      check((await stateOf(B.id)).sessions.length === 0, 'and no session was created for it', null);
    } finally {
      await dbWrite('DELETE', 'subscriptions?user_id=eq.' + B.id).catch((e) => report('FAIL', 'probe B\'s comp row removed again', String(e.message || e)));
    }
    report('INFO', 'left behind on purpose', 'one open, unpaid Checkout Session for probe A (' + mask(sid) + '); it expires on its own within 24 hours. ' +
      'In the Stripe dashboard it shows client_reference_id and metadata.supabase_user_id = ' + mask(A.id) + ', and so does its customer.');
  }

  async function frontend() {
    const files = [
      { url: '/', must: ['/lib/edgedesk_access.js?v=', 'Payment received. Finalizing your EdgeDesk access'] },
      { url: '/app.html', must: ['/lib/edgedesk_access.js?v=', 'Refresh access'] },
      { url: '/admin/billing/', must: ['Billing console', 'classify('] },
    ];
    for (const f of files) {
      let r;
      try { r = await F(SITE + f.url); } catch (e) { report('FAIL', 'the site answers ' + f.url, String(e.message || e)); continue; }
      const text = await r.text();
      const missing = f.must.filter((m) => text.indexOf(m) < 0);
      check(r.status === 200 && missing.length === 0, 'the live site serves this commit\'s ' + f.url, { status: r.status, missing });
    }
    const local = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_access.js'), 'utf8');
    const v = (/edgedesk_access\.js\?v=([0-9a-z]+)/.exec(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) || [])[1];
    try {
      const r = await F(SITE + '/lib/edgedesk_access.js?v=' + v);
      const served = await r.text();
      report(served === local ? 'PASS' : 'WARN', 'lib/edgedesk_access.js is byte-for-byte this commit\'s',
        served === local ? null : 'differs (GitHub Pages can lag a deploy by a few minutes)');
    } catch (e) { report('FAIL', 'lib/edgedesk_access.js reachable', String(e.message || e)); }
    // no Stripe secret, and no JWT that is anything but the public anon key
    for (const p of ['lib/edgedesk_access.js', 'index.html', 'app.html', 'admin/billing/index.html']) {
      const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
      const stripeSecret = /(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(src);
      const roles = (src.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []).map((t) => {
        try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).role || '?'; } catch (_) { return '?'; }
      });
      check(!stripeSecret && roles.every((r) => r === 'anon'), p + ' carries no service or Stripe secret (only the public anon key)',
        { stripe_secret: stripeSecret, jwt_roles: roles });
    }
  }

  async function trace(sinceIso, waitS) {
    if (!need()) return;
    const since = sinceIso || new Date(Date.now() - 3600e3).toISOString();
    const until = Date.now() + (waitS || 0) * 1000;
    let evs = [];
    for (;;) {
      evs = await db('stripe_events?select=id,type,livemode,attempts,resolved,applied,resolved_how,note,last_error,user_id,customer_id,subscription_id,stripe_created,processed_at' +
        '&processed_at=gte.' + encodeURIComponent(since) + '&order=processed_at.desc&limit=5');
      if (evs.length || Date.now() > until) break;
      await sleep(20000);
    }
    if (!evs.length) {
      report('WARN', 'no delivery has been processed by the new build since ' + since,
        'Stripe → Developers → Webhooks → the endpoint → resend a recent event (it is safe: a delivery re-reads Stripe and writes what is true now), then run stage verify');
      return;
    }
    const e = evs.find((x) => x.user_id) || evs[0];
    report('INFO', 'stripe event', { event: mask(e.id), type: e.type, livemode: e.livemode, attempts: e.attempts, stripe_created: e.stripe_created });
    report('INFO', '→ stripe_events (the ledger)', { resolved: e.resolved, applied: e.applied, how: e.resolved_how, note: e.note, error: e.last_error });
    if (!e.user_id) {
      const al = await db('billing_alerts?select=kind,occurrences&stripe_event_id=eq.' + encodeURIComponent(e.id));
      check(al.length > 0, '→ unresolved, and raised as a billing alert for a human (no account guessed)', al);
      return;
    }
    report('INFO', '→ resolved account', mask(e.user_id) + ' via ' + e.resolved_how);
    const logs = await db('billing_sync_log?select=at,source,outcome,ok,stripe_status,access_after,note&user_id=eq.' + e.user_id +
      '&source=eq.webhook&order=at.desc&limit=3');
    report(logs.length ? 'INFO' : 'WARN', '→ billing writer (reconciled live, billing_sync_log)', logs.length ? logs[0] : 'no webhook reconciliation logged (the payload path ran: Stripe could not be read)');
    const row = (await db('subscriptions?select=status,price_id,current_period_end,cancel_at_period_end,stripe_synced_at,sync_source,last_event_id&user_id=eq.' + e.user_id))[0] || null;
    report('INFO', '→ subscriptions', row && Object.assign({}, row, { last_event_id: mask(row.last_event_id) }));
    const acc = await rpc('billing_access_for', { p_user: e.user_id });
    report('INFO', '→ access rule', acc && { has_access: acc.has_access, reason: acc.reason, offer: acc.offer });
    check(e.resolved && !e.last_error, 'the delivery traced end to end without an error', { resolved: e.resolved, error: e.last_error });
  }

  async function cron(sinceIso, waitS) {
    if (!need()) return 0;
    const since = sinceIso;
    const sinceMs = Date.parse(since);
    if (!isFinite(sinceMs)) { report('FAIL', 'cron --since is a timestamp', since); return 1; }
    const until = Date.now() + (waitS || 0) * 1000;
    const ran = (x) => !!(x && x.last_run_at && Date.parse(x.last_run_at) >= sinceMs && x.last_result && Date.parse(x.last_result.at) >= sinceMs);
    let st = null;
    for (;;) {
      st = ((await db('billing_sweep_state?select=last_run_at,last_result&id=eq.1')) || [])[0] || null;
      if (ran(st) || Date.now() > until) break;
      await sleep(30000);
    }
    if (!ran(st)) {
      report('FAIL', 'the sweep ran since ' + since, 'no run recorded — check cron.job_run_details (stage verify prints it)');
      return 1;
    }
    const logs = await db('billing_sync_log?select=outcome,ok&source=eq.cron&outcome=neq.admitted&at=gte.' + encodeURIComponent(since));
    const by = {};
    logs.forEach((l) => { by[l.outcome] = (by[l.outcome] || 0) + 1; });
    const alerts = await db('billing_alerts?select=kind,resolved_at&first_seen_at=gte.' + encodeURIComponent(since));
    const ak = {};
    alerts.forEach((a) => { const k = a.kind + (a.resolved_at ? ' (repaired)' : ''); ak[k] = (ak[k] || 0) + 1; });
    const lr = st.last_result || {};
    const entitled = (await db('subscriptions?select=status&stripe_subscription_id=not.is.null'))
      .filter((x) => ['active', 'trialing', 'past_due'].indexOf(x.status) >= 0).length;
    const repaired = by.repaired || 0, revoked = by.revoked || 0, errors = (lr.errors || 0) + logs.filter((l) => !l.ok).length;
    report('INFO', 'sweep summary', { scanned: logs.length, unchanged: by.unchanged || 0, updated: by.updated || 0, repaired, revoked,
      no_stripe_subscription: by.no_stripe_subscription || 0, unresolved_events_seen: lr.events_seen || 0,
      unresolved_events_resolved: lr.events_resolved || 0, errors, alerts: ak });
    const limit = Math.max(3, Math.ceil(entitled * 0.1));
    const stop = revoked > 0 || repaired > limit || errors > 0;
    if (stop) {
      report('FAIL', 'STOP: the first sweeps did more than a healthy system should',
        (revoked ? revoked + ' access revocations; ' : '') + (repaired > limit ? repaired + ' repairs (limit ' + limit + '); ' : '') +
        (errors ? errors + ' errors; ' : '') + 'investigate each in /admin/billing/ before re-enabling the schedule');
      return 2;
    }
    report('PASS', 'the first sweeps look like a healthy system', repaired + ' repairs (limit ' + limit + '), no revocations, no errors');
    return 0;
  }

  async function subject(uid, wantPrice) {
    if (!need()) return;
    if (!/^[0-9a-f-]{36}$/i.test(String(uid || ''))) { report('FAIL', 'subject --user is an account id', uid); return; }
    const id = uid.toLowerCase();
    const u = await http(SB + '/auth/v1/admin/users/' + id, { headers: SH() });
    const usr = u.body && (u.body.user || u.body);
    check(u.ok && usr && usr.id, 'Auth user exists', u.status);
    if (!u.ok) return;
    report('INFO', 'account', { id: mask(id), email: maskEmail(usr.email), confirmed: !!(usr.email_confirmed_at || usr.confirmed_at) });
    const s = await stateOf(id);
    const row = s.row;
    check(s.customers.length > 0, 'a Stripe customer is linked to it', s.customers.map((c) => ({ id: mask(c.stripe_customer_id), source: c.source })));
    check(row && /^sub_/.test(String(row.stripe_subscription_id || '')), 'a Stripe subscription is on its subscriptions row', row && mask(row.stripe_subscription_id));
    check(row && ['trialing', 'active'].indexOf(row.status) >= 0, 'status is trialing or active', row && row.status);
    if (wantPrice) check(row && row.price_id === wantPrice, 'price_id is the configured price', row && row.price_id);
    else report('INFO', 'price_id', row && row.price_id);
    check(row && row.current_period_end && Date.parse(row.current_period_end) > Date.now(), 'the period ends in the future', row && row.current_period_end);
    const acc = await rpc('billing_access_for', { p_user: id });
    check(acc && acc.has_access === true, 'access = granted', acc && { reason: acc.reason });
    const alerts = await db('billing_alerts?select=kind,occurrences&user_id=eq.' + id + '&resolved_at=is.null');
    check(alerts.length === 0, 'no open billing alerts for it', alerts);
    const logs = await db('billing_sync_log?select=at,source,outcome&user_id=eq.' + id + '&outcome=neq.admitted&order=at.desc&limit=8');
    report('INFO', 'how it converged (newest first)', logs.map((l) => l.source + ':' + l.outcome).join(' · ') || 'no reconciliation logged');
    const evs = await db('stripe_events?select=type,resolved,applied,resolved_how&user_id=eq.' + id + '&order=created_at.desc&limit=8');
    report('INFO', 'deliveries', evs.map((e) => e.type + (e.resolved ? '' : ' UNRESOLVED') + (e.applied ? ' applied' : '')).join(' · ') || 'none');
  }

  return { functions, webhook, sync, checkout, frontend, trace, cron, subject, results,
           failed: () => results.some((r) => r.verdict === 'FAIL') };
}

async function main(argv) {
  const mode = argv[0];
  const arg = (k) => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : null; };
  const P = makeProbe({});
  let code = 0;
  try {
    if (mode === 'functions') await P.functions(String(arg('require') || '').split(','));
    else if (mode === 'webhook') await P.webhook();
    else if (mode === 'sync') await P.sync();
    else if (mode === 'checkout') await P.checkout();
    else if (mode === 'frontend') await P.frontend();
    else if (mode === 'trace') await P.trace(arg('since'), +(arg('wait') || 0));
    else if (mode === 'cron') code = await P.cron(arg('since'), +(arg('wait') || 0));
    else if (mode === 'subject') await P.subject(arg('user'), arg('price'));
    else { console.log('usage: node tools/billing/prod_probe.js functions|webhook|sync|checkout|frontend|trace|cron|subject …'); return 64; }
  } catch (e) {
    console.log('FAIL  the probe ran to the end  — ' + String((e && e.message) || e).slice(0, 300));
    return 1;
  }
  const n = P.results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  console.log('── ' + mode + ': ' + Object.keys(n).map((k) => n[k] + ' ' + k).join(', '));
  return code || (P.failed() ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
module.exports = { makeProbe, expectedBuild, main };
