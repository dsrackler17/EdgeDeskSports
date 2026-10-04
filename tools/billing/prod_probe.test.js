#!/usr/bin/env node
/* ===========================================================================
   THE PRODUCTION PROBES, AGAINST THE SHIPPED SYSTEM.

   tools/billing/prod_probe.js is what deploy-billing.yml asks production. A
   probe that passes on a broken system is worse than none, so every mode runs
   here against the real thing — the shipped SQL, the three shipped functions,
   a fake Stripe (tools/billing/_harness.js) — and must PASS on it, and must
   FAIL when the property it checks is broken.

   It also holds the probe to its own promises: nothing it prints carries a
   token, a password, a full email or a full account id.

   Run: node tools/billing/prod_probe.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const PROBE = require('./prod_probe.js');
const PG = require('../personal/_pg.js');

let pass = 0, fail = 0;
const chk = (label, ok, detail) => { if (ok) pass++; else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); } };

const W = H.world('probe');
if (W.skip) { console.log('NOTE | ' + W.skip + ' — skipped'); process.exit(0); }

const ROOT = PG.ROOT;
const SITE = 'https://site.test';
let fns = W.fns;
let siteOverride = {};
async function route(url, init) {
  const s = String(url);
  const i = init || {};
  if (s.indexOf('https://db.test/functions/v1/') === 0) {
    const name = new URL(s).pathname.split('/').pop();
    if (!fns[name]) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }), { status: 404 });
    return fns[name](new Request(s, { method: i.method || 'GET', headers: i.headers, body: i.body }));
  }
  if (s.indexOf('https://db.test/') === 0) return W.rest.fetch(s, i);
  if (s.indexOf(SITE) === 0) {
    const p = new URL(s).pathname;
    const file = p === '/' ? 'index.html' : p.endsWith('/') ? p.slice(1) + 'index.html' : p.slice(1);
    if (siteOverride[file] != null) return new Response(siteOverride[file], { status: 200 });
    try { return new Response(fs.readFileSync(path.join(ROOT, file), 'utf8'), { status: 200 }); }
    catch (_) { return new Response('not found', { status: 404 }); }
  }
  return new Response('no route', { status: 404 });
}
const ENV = { SB_URL: 'https://db.test', SB_SERVICE_ROLE: 'service-key', SB_ANON: 'anon-key', SITE_URL: SITE };
async function run(mode, ...args) {
  const lines = [];
  const P = PROBE.makeProbe({ env: ENV, fetch: route, log: (l) => lines.push(l) });
  let code = 0;
  try { code = (await P[mode](...args)) || 0; } catch (e) { lines.push('THREW ' + String(e.stack || e).slice(0, 600)); code = -1; }
  const by = (v) => P.results.filter((r) => r.verdict === v);
  return { lines, code, results: P.results, fails: by('FAIL'), passes: by('PASS'), warns: by('WARN'), text: lines.join('\n') };
}
const labels = (rs) => rs.map((r) => r.label + (r.detail ? ' — ' + JSON.stringify(r.detail).slice(0, 200) : ''));
const leaks = (text) => {
  const ids = W.q('select id::text as id from auth.users').map((r) => r.id);
  const out = [];
  ids.forEach((id) => { if (text.indexOf(id) >= 0) out.push('full id ' + id.slice(0, 8)); });
  if (/tok_[a-z0-9_]{6,}/i.test(text)) out.push('a token');
  if (/billing-probe-[ab]@/.test(text)) out.push('a probe email in full');
  if (/[a-z0-9.]{2,}@x\.co/i.test(text)) out.push('a customer email in full');
  if (/service-key|sk_live_/.test(text)) out.push('a key');
  return out;
};

(async () => {
  try {
    /* a real customer elsewhere in the system, whose completed checkout the
       sync probe borrows to prove another account's session names nothing */
    const other = W.user('other.customer@x.co');
    const co = await W.call('create_checkout_session', 'POST', { kind: 'trial', price_cents: 4999, trial_days: 7 }, other.token);
    const done = W.stripe.complete(co.body.session_id, { email: 'other.customer@x.co' });
    for (const e of done.events) await W.deliver(e);
    chk('setup: another customer paid and has access', W.access(other.id).has_access === true);

    /* ── functions ─────────────────────────────────────────────────────── */
    let r = await run('functions', ['sync_subscription', 'stripe_webhook', 'create_checkout_session']);
    chk('functions: every billing function serves this commit\'s build, configured', r.fails.length === 0 && r.passes.length >= 5, labels(r.fails));
    fns = Object.assign({}, W.fns, { sync_subscription: undefined });
    r = await run('functions', ['sync_subscription']);
    chk('functions: a required function that is not deployed FAILS', r.fails.length === 1 && /not deployed/.test(r.fails[0].label), labels(r.results));
    fns = W.fns;

    /* ── webhook ───────────────────────────────────────────────────────── */
    r = await run('webhook');
    chk('webhook: build, 405 on GET, unsigned and forged deliveries refused, none on the ledger', r.fails.length === 0 && r.passes.length === 5, labels(r.fails));
    fns = Object.assign({}, W.fns, { stripe_webhook: async () => new Response(JSON.stringify({ build: H.SECRET && 'stripe_webhook-old', ok: true }), { status: 200 }) });
    r = await run('webhook');
    chk('webhook: an old build that accepts unsigned deliveries FAILS', r.fails.length >= 2, labels(r.results));
    fns = W.fns;

    /* ── sync (Phase 6) ────────────────────────────────────────────────── */
    r = await run('sync');
    chk('sync: every Phase 6 property holds on the shipped function', r.fails.length === 0, labels(r.fails));
    chk('sync: and it checked them all', r.passes.length >= 20 && !r.results.some((x) => x.verdict === 'SKIP'), labels(r.results.filter((x) => x.verdict !== 'PASS')));
    chk('sync: probe accounts were created confirmed and flagged, without an email', W.q("select count(*)::int n from auth.users where email like 'billing-probe-%' and email_confirmed_at is not null")[0].n === 2);
    const B = W.q("select id from auth.users where email = 'billing-probe-b@edgedesksports.com'")[0].id;
    chk('sync: probe B\'s comp row was removed again', W.row(B) === null);
    chk('sync: the probe printed no token, password, full email or full id', leaks(r.text).length === 0, leaks(r.text));
    r = await run('sync');
    chk('sync: a second run inside ten minutes refuses to run on a spent budget (clear message, FAIL)',
      r.fails.length === 1 && /wait 10 minutes/.test(JSON.stringify(r.fails[0])), labels(r.fails));
    W.db.sql("update public.billing_sync_log set at = at - interval '11 minutes' where source in ('self','checkout_return','checkout');");

    // the probe must FAIL on a function that trusts the body
    const trusting = W.load('sync_subscription');
    fns = Object.assign({}, W.fns, { sync_subscription: async (req) => {
      if (req.method !== 'POST') return trusting(req);
      const body = await req.clone().json().catch(() => ({}));
      return body.user_id ? new Response(JSON.stringify({ build: PROBE.expectedBuild('sync_subscription'), ok: true, ref: 'EDS-AAAAAA', outcome: 'no_stripe_subscription', has_access: false }), { status: 200 }) : trusting(req);
    } });
    r = await run('sync');
    chk('sync: a function that honours a body naming another account FAILS the probe', r.fails.some((f) => /body naming another account/.test(f.label)), labels(r.fails));
    fns = W.fns;
    W.db.sql("update public.billing_sync_log set at = at - interval '11 minutes' where source in ('self','checkout_return','checkout');");

    /* ── checkout (Phase 8) ────────────────────────────────────────────── */
    fns = Object.assign({}, W.fns, { create_checkout_session: W.load('create_checkout_session', { STRIPE_PRICE_ID: '' }) });
    r = await run('checkout');
    chk('checkout: with the kill switch on, the probe says so (503 fallback_ok, WARN) and creates nothing',
      r.fails.length === 0 && r.warns.some((w) => /kill switch/.test(w.label)), labels(r.results));
    fns = W.fns;
    r = await run('checkout');
    chk('checkout: every Phase 8 property holds on the shipped function', r.fails.length === 0, labels(r.fails));
    chk('checkout: and it checked them all', r.passes.length >= 18, r.passes.length);
    const A = W.q("select id from auth.users where email = 'billing-probe-a@edgedesksports.com'")[0].id;
    const sessions = W.q('select id, user_id, status from public.billing_checkout_sessions where user_id = ' + PG.lit(A));
    chk('checkout: exactly ONE session exists for probe A, however often it opened checkout', sessions.length === 1 && sessions[0].status === 'open', sessions);
    const sess = W.stripe.S.sessions[sessions[0].id];
    chk('checkout: Stripe received the account three ways (client_reference_id, metadata, subscription_data.metadata) and a stamped customer',
      sess.client_reference_id === A && sess.metadata.supabase_user_id === A && sess.subscription_data.metadata.supabase_user_id === A &&
      W.stripe.S.customers[sess.customer].metadata.supabase_user_id === A, { cri: sess.client_reference_id === A });
    chk('checkout: nothing at all for probe B (the comp account and the account the body named)',
      W.q('select count(*)::int n from public.billing_checkout_sessions where user_id = ' + PG.lit(B))[0].n === 0 && W.row(B) === null);
    chk('checkout: no leak', leaks(r.text).length === 0, leaks(r.text));

    /* ── frontend (Phase 9) ────────────────────────────────────────────── */
    r = await run('frontend');
    chk('frontend: the site serves this commit, and no page carries a secret', r.fails.length === 0 && r.warns.length === 0, labels(r.fails.concat(r.warns)));
    siteOverride = { 'index.html': '<html>old page</html>' };
    r = await run('frontend');
    chk('frontend: an old landing page FAILS', r.fails.some((f) => /serves this commit's \//.test(f.label)), labels(r.fails));
    siteOverride = {};

    /* ── trace (Phase 7) ───────────────────────────────────────────────── */
    const t0 = new Date(Date.now() - 1000).toISOString();
    const upd = W.stripe.update(done.subscription.id, { cancel_at_period_end: true });
    await W.deliver(upd);
    r = await run('trace', t0, 0);
    chk('trace: one real delivery, event → ledger → account → writer → row → rule', r.fails.length === 0 && r.passes.length === 1 &&
      /resolved account/.test(r.text) && /billing writer/.test(r.text) && /access rule/.test(r.text), r.lines);
    r = await run('trace', new Date(Date.now() + 60000).toISOString(), 0);
    chk('trace: no delivery yet is a WARN that says how to get one (never a fake event)', r.warns.length === 1 && /resend/.test(JSON.stringify(r.warns[0])));

    /* ── subject (Phase 13) ────────────────────────────────────────────── */
    r = await run('subject', other.id, 'price_4999');
    chk('subject: the paid customer has converged (user, customer, subscription, price, period, access, no alerts)', r.fails.length === 0 && r.passes.length === 8, labels(r.fails));
    r = await run('subject', A, 'price_4999');
    chk('subject: an account that never paid does NOT pass', r.fails.length >= 3, labels(r.results));

    /* ── cron (Phase 11) ───────────────────────────────────────────────── */
    let since = new Date(Date.now() - 1000).toISOString();
    let sw = await W.call('sync_subscription', 'POST', { action: 'sweep' });
    r = await run('cron', since, 0);
    chk('cron: a healthy first sweep PASSES with its numbers', sw.status === 200 && r.code === 0 && r.fails.length === 0 && /sweep summary/.test(r.text), [sw.body, r.lines]);
    // Stripe cancels the paying customer's subscription and the webhook never hears of it
    W.stripe.update(done.subscription.id, { status: 'canceled' }, 'customer.subscription.deleted');
    W.db.sql("update public.subscriptions set stripe_synced_at = now() - interval '5 days', last_event_at = now() - interval '5 days' where user_id = " + PG.lit(other.id) + ';');
    W.db.sql("update public.billing_sync_log set at = at - interval '2 days' where source = 'cron';");
    W.db.sql("update public.billing_sweep_state set last_run_at = now() - interval '1 hour';");
    since = new Date(Date.now() - 1000).toISOString();
    sw = await W.call('sync_subscription', 'POST', { action: 'sweep' });
    r = await run('cron', since, 0);
    chk('cron: a sweep that REVOKES access is a STOP (exit 2), with the count', r.code === 2 && r.fails.some((f) => /STOP/.test(f.label) && /revocation/.test(f.detail)), [sw.body, labels(r.results)]);
    r = await run('cron', new Date(Date.now() + 60000).toISOString(), 0);
    chk('cron: no sweep since the schedule was applied FAILS', r.fails.length === 1);
  } catch (e) {
    chk('the suite ran to the end', false, String(e.stack || e).slice(0, 1200));
  } finally {
    W.stop();
  }
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'production probes — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
