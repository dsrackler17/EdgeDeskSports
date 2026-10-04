#!/usr/bin/env node
/* ===========================================================================
   supabase/billing_hardening.sql, AGAINST A REAL POSTGRESQL.

   Three questions, in the order an operator would ask them:

   1. DOES IT INSTALL OVER WHAT PRODUCTION ACTUALLY HOLDS? Not an empty
      database: hand-made rows with 2036 and 2108 period ends, a comp, a
      comp_trial, a Stripe id typed onto two accounts, a customer two accounts
      both claim, and checkout deliveries that never resolved. It must apply
      (twice), report honestly on each, change none of those rows, and link
      only what the data already proves.

   2. IS THE ONE RULE THE RULE? billing_row_grants_access() against the
      shipped community_is_entitled() (lifted out of community_posts.sql) and
      against the JavaScript copy the functions and the pages carry, over every
      combination of status, price and period end that matters.

   3. DOES THE ONE WRITER REFUSE WHAT IT MUST? Stale states, comps, access
      Stripe never granted, a cancelled duplicate, a subscription that is
      somebody else's — and nobody but the service role may call it.

   Applied together with the files whose triggers watch the same tables
   (affiliates, personal_research, growth, funnel, community_posts), because
   a retroactive resolution fires those triggers and must not break them.

   Run: node tools/billing/billing_hardening_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../personal/_pg.js');

const T = PG.kit('billing hardening SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'billing_hardening.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const CORE = new Function(fs.readFileSync(path.join(__dirname, 'billing_core.js'), 'utf8') + '\nreturn { grantsAccess };')();
const ACCESS = require(path.join(PG.ROOT, 'lib', 'edgedesk_access.js'));

chk('no psql meta-commands (it is pasted into the SQL editor)', !/^\\/m.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by row;\s*$/.test(SQL));
chk('nothing is dropped', !/\bdrop\s+(table|column|index|view|function)\b/i.test(SQL.replace(/--.*$/gm, '')));
chk('no existing subscription row is rewritten by the file itself',
  !/update\s+public\.subscriptions\s+set/i.test(SQL.slice(SQL.indexOf('-- ── 12. BACKFILL'))));

const db = PG.start('bhsql');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }
const J = (sql) => JSON.parse(db.sql('select coalesce(json_agg(t), \'[]\'::json) from (' + sql + ') t;') || '[]');
const one = (sql) => J(sql)[0];
const V = (sql) => db.sql(sql);
const users = {};
function user(key, email, confirmed) {
  const id = '00000000-0000-4000-8000-' + String(Object.keys(users).length + 1).padStart(12, '0');
  V("insert into auth.users (id, email, email_confirmed_at, created_at) values (" + lit(id) + ', ' + lit(email) + ', ' +
    (confirmed === false ? 'null' : "now() - interval '1 day'") + ", now() - interval '9 days');");
  users[key] = id;
  return id;
}
const ev = (id, type, obj, userId, resolved) => V("insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, resolved, payload) values (" +
  lit(id) + ', ' + lit(type) + ', now(), ' + lit(obj.customer || null) + ', ' + lit(obj.subscription || (type.indexOf('customer.subscription') === 0 ? obj.id : null)) + ', ' +
  (userId ? lit(userId) : 'null') + ', ' + (resolved ? 'true' : 'false') + ', ' +
  lit(JSON.stringify({ id, type, livemode: true, data: { object: obj } })) + '::jsonb);');

try {
  const pre = ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'subscription_price.sql', 'affiliates.sql',
               'personal_research.sql', 'growth.sql', 'funnel.sql', 'site_articles.sql', 'community_posts.sql'];
  pre.forEach((f) => db.applyFile(path.join(PG.ROOT, 'supabase', f)));
  const shippedCommunity = V("select pg_get_functiondef('public.community_is_entitled(uuid)'::regprocedure);");

  /* ===================================================================== */
  /* 1. PRODUCTION'S SHAPE, BEFORE THE MIGRATION                          */
  /* ===================================================================== */
  const owner = user('owner', 'owner@x.co');
  const hand2108 = user('hand2108', 'h2108@x.co');
  const stale = user('stale', 'stale@x.co');
  const ctrial = user('ctrial', 'ct@x.co');
  const paid = user('paid', 'paid@x.co');
  const dupA = user('dupA', 'dupa@x.co'), dupB = user('dupB', 'dupb@x.co');
  const lost = user('lost', 'lost@x.co');
  const nobody = user('nobody', 'nobody@x.co');
  V(`insert into public.subscriptions (user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id) values
     (${lit(owner)}, 'active', 'owner_comp', null, false, null, null),
     (${lit(hand2108)}, 'active', null, '2108-01-01', false, null, null),
     (${lit(stale)}, 'active', null, '2026-08-23', false, 'cus_stale', 'sub_stale'),
     (${lit(ctrial)}, 'trialing', 'comp_trial', now() + interval '7 days', true, null, null),
     (${lit(paid)}, 'trialing', null, now() + interval '5 days', false, 'cus_paid', 'sub_paid'),
     (${lit(dupA)}, 'active', null, now() + interval '9 days', false, 'cus_shared', 'sub_twice'),
     (${lit(dupB)}, 'active', null, now() + interval '9 days', false, 'cus_shared', 'sub_twice');`);
  V(`update public.subscriptions set last_event_at = now() - interval '1 hour', last_event_id = 'evt_paid' where user_id = ${lit(paid)};`);
  ev('evt_paid', 'customer.subscription.updated', { id: 'sub_paid', customer: 'cus_paid', status: 'trialing' }, paid, true);
  // a checkout delivery that names a real account but never resolved (the failure)
  ev('evt_lost_sub', 'customer.subscription.created', { id: 'sub_lost', customer: 'cus_lost', status: 'trialing' }, null, false);
  ev('evt_lost_co', 'checkout.session.completed', { id: 'cs_live_lost', object: 'checkout.session', mode: 'subscription',
    client_reference_id: lost, customer: 'cus_lost', subscription: 'sub_lost', customer_details: { email: 'lost@x.co' } }, null, false);
  // one that names nobody who exists, and one with no reference at all
  ev('evt_ghost', 'checkout.session.completed', { id: 'cs_live_ghost', client_reference_id: '00000000-0000-4000-8000-00000000dead', customer: 'cus_ghost', subscription: 'sub_ghost' }, null, false);
  ev('evt_anon', 'checkout.session.completed', { id: 'cs_live_anon', customer: 'cus_anon', subscription: 'sub_anon' }, null, false);
  V(`insert into public.billing_consents (user_id, user_email, price_display, billing_period, trial_days) values (${lit(nobody)}, 'nobody@x.co', '$49.99', 'month', 7);`);
  const before = J('select user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id from public.subscriptions order by user_id');

  /* ===================================================================== */
  /* 2. INSTALL, TWICE                                                     */
  /* ===================================================================== */
  let out = db.applyFileAtomic(FILE);
  const rep = out.split('\n').filter((l) => /^\d+\|/.test(l));
  chk('it applies over production-shaped data', rep.length === 11, out.slice(-1500));
  const bad = rep.filter((l) => !/\|ok/.test(l));
  chk('and reports, honestly, exactly the two things a human must decide',
    bad.length === 2 && /^6\|/.test(bad[0]) && /sub_twice/.test(bad[0]) && /^8\|/.test(bad[1]) && /cus_shared/.test(bad[1]), bad);
  chk('a skipped unique index is a report row, not a failed migration',
    one("select to_regclass('public.subscriptions_stripe_subscription_uk') is null as skipped").skipped === true);
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, identically', out.split('\n').filter((l) => /^\d+\|/.test(l)).length === 11);
  const after = J('select user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id from public.subscriptions order by user_id');
  chk('no existing subscription row was changed by installing it', JSON.stringify(before) === JSON.stringify(after));

  /* the backfill: only what the data proves */
  const bc = J('select stripe_customer_id, user_id, source from public.billing_customers order by stripe_customer_id');
  const m = Object.fromEntries(bc.map((r) => [r.stripe_customer_id, r]));
  chk('a customer on one row is linked to that account', m.cus_paid && m.cus_paid.user_id === paid && m.cus_stale && m.cus_stale.user_id === stale);
  chk('a customer two accounts claim is NOT linked to either', !m.cus_shared, bc);
  chk('the never-resolved checkout naming a real account is linked', m.cus_lost && m.cus_lost.user_id === lost && /client_reference_id/.test(m.cus_lost.source));
  chk('and both its deliveries are resolved retroactively', J("select id from public.stripe_events where id in ('evt_lost_sub','evt_lost_co') and resolved and user_id = " + lit(lost)).length === 2);
  chk('a reference naming nobody, and no reference, stay unresolved — never guessed',
    J("select id from public.stripe_events where id in ('evt_ghost','evt_anon') and not resolved").length === 2 && !m.cus_ghost && !m.cus_anon);
  chk('the lost customer now has no row, and the decision says to ask Stripe',
    JSON.parse(V('select public.billing_access_for(' + lit(lost) + ')')).should_sync === true);

  /* ===================================================================== */
  /* 3. ONE RULE                                                           */
  /* ===================================================================== */
  const statuses = [null, 'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'mystery'];
  const prices = [null, 'price_4999', 'owner_comp', 'comp_trial', 'owner_comp_x'];
  const offsets = [null, '5 days', '-1 second', '-20 days', '-22 days', '100 years'];
  const cases = [];
  statuses.forEach((s) => prices.forEach((p) => offsets.forEach((o) => cases.push({ s, p, o }))));
  const at = '2026-10-04T12:00:00Z';
  const vals = cases.map((c, i) => '(' + i + ', ' + lit(c.s) + '::text, ' + lit(c.p) + '::text, ' +
    (c.o == null ? 'null::timestamptz' : "(timestamptz '" + at + "' + interval " + lit(c.o) + ')') + ')').join(',\n');
  V('create table if not exists public.rule_grid (i int primary key, user_id uuid, status text, price_id text, pe timestamptz);');
  V('insert into public.rule_grid (i, status, price_id, pe) values ' + vals + ';');
  const grid = J("select i, status, price_id, pe, public.billing_row_grants_access(status, price_id, pe, timestamptz '" + at + "') as g from public.rule_grid order by i");
  chk('the grid is the whole grid', grid.length === cases.length && cases.length === 300);
  const atMs = Date.parse(at);
  const jsAgree = grid.every((r) => CORE.grantsAccess({ status: r.status, price_id: r.price_id, current_period_end: r.pe }, atMs) === r.g &&
                                     ACCESS.grants({ status: r.status, price_id: r.price_id, current_period_end: r.pe }, atMs) === r.g);
  chk('the server core and the browser library agree with the SQL rule on all 300 cases', jsAgree,
    grid.filter((r) => CORE.grantsAccess({ status: r.status, price_id: r.price_id, current_period_end: r.pe }, atMs) !== r.g).slice(0, 3));
  // the shipped community_is_entitled, as community_posts.sql writes it, over the same grid (it uses now())
  const gridNow = J('select i, status, price_id, pe, public.billing_row_grants_access(status, price_id, pe, now()) as g from public.rule_grid order by i');
  V(shippedCommunity.replace(/create or replace function public\.community_is_entitled\(/i, 'create or replace function public.community_shipped_rule('));
  // one user per case so community's subscriptions-reading rule can be asked
  V('create temp table if not exists _x (i int);');
  const gridUsers = [];
  for (const r of gridNow) {
    const id = '10000000-0000-4000-8000-' + String(r.i).padStart(12, '0');
    gridUsers.push(id);
  }
  V('insert into auth.users (id, email, email_confirmed_at) select (\'10000000-0000-4000-8000-\' || lpad(i::text, 12, \'0\'))::uuid, \'g\' || i || \'@x.co\', now() from public.rule_grid on conflict do nothing;');
  V("insert into public.subscriptions (user_id, status, price_id, current_period_end) select ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, status, price_id, pe from public.rule_grid on conflict do nothing;");
  const cmp = J("select g.i, public.community_shipped_rule(('10000000-0000-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid) as shipped, " +
    "public.community_is_entitled(('10000000-0000-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid) as now_installed, " +
    "public.billing_row_grants_access(g.status, g.price_id, g.pe, now()) as rule from public.rule_grid g order by g.i");
  chk('the shipped community_is_entitled agrees with the one rule on every case', cmp.every((r) => r.shipped === r.rule), cmp.filter((r) => r.shipped !== r.rule).slice(0, 3));
  chk('and the installed one now defers to it', cmp.every((r) => r.now_installed === r.rule) &&
    /billing_row_grants_access/.test(V("select pg_get_functiondef('public.community_is_entitled(uuid)'::regprocedure);")));
  V("delete from public.subscriptions where user_id::text like '10000000-%'; delete from auth.users where id::text like '10000000-%';");

  /* ===================================================================== */
  /* 4. THE ONE WRITER                                                     */
  /* ===================================================================== */
  const apply = (args) => JSON.parse(db.service('select public.billing_apply_subscription_state(' + Object.entries(Object.assign({
    p_customer_id: null, p_subscription_id: null, p_status: null, p_price_id: null, p_current_period_end: null,
    p_cancel_at_period_end: null, p_as_of: null, p_source: 'test', p_live: false, p_authoritative: false }, args))
    .map(([k, v]) => k + ' => ' + (v === null ? 'null' : typeof v === 'boolean' ? String(v) : lit(v))).join(', ') + ');'));
  const row = (u) => one('select * from public.subscriptions where user_id = ' + lit(u));
  const alertsOf = (u, k) => J('select * from public.billing_alerts where user_id = ' + lit(u) + ' and kind = ' + lit(k) + ' and resolved_at is null');

  let r = apply({ p_user: owner, p_customer_id: 'cus_o', p_subscription_id: 'sub_o', p_status: 'canceled', p_as_of: 'now()' });
  chk('an owner_comp is never written', r.applied === false && r.reason === 'comp' && row(owner).price_id === 'owner_comp' && row(owner).status === 'active');

  r = apply({ p_user: ctrial, p_customer_id: 'cus_ct', p_subscription_id: 'sub_ct_dead', p_status: 'incomplete_expired', p_price_id: 'price_4999', p_as_of: new Date().toISOString(), p_live: true, p_authoritative: true });
  chk('a live comp_trial is not ended by a Stripe subscription that never paid', r.reason === 'protected_entitlement' && row(ctrial).price_id === 'comp_trial' && row(ctrial).status === 'trialing');
  chk('(and that expected disagreement raises no alert)', alertsOf(ctrial, 'db_active_stripe_inactive').length === 0);
  r = apply({ p_user: hand2108, p_customer_id: 'cus_h', p_subscription_id: 'sub_h', p_status: 'canceled', p_price_id: 'price_4999', p_as_of: new Date().toISOString(), p_live: true, p_authoritative: true });
  chk('a hand-made row with no Stripe subscription is not revoked by Stripe either', r.reason === 'protected_entitlement' && row(hand2108).status === 'active');
  chk('but THAT disagreement goes to a human', alertsOf(hand2108, 'db_active_stripe_inactive').length === 1);
  r = apply({ p_user: ctrial, p_customer_id: 'cus_ct', p_subscription_id: 'sub_ct', p_status: 'trialing', p_price_id: 'price_4999',
    p_current_period_end: new Date(Date.now() + 7 * 864e5).toISOString(), p_cancel_at_period_end: false, p_as_of: new Date().toISOString(), p_live: true, p_authoritative: true });
  let rw = row(ctrial);
  chk('a real subscription replaces a comp_trial, and takes the comp sentinel with it',
    r.applied && rw.stripe_subscription_id === 'sub_ct' && rw.price_id === 'price_4999' && rw.cancel_at_period_end === false, rw);

  // ordering
  const t = (s) => new Date(Date.now() + s * 1000).toISOString();
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'canceled', p_as_of: t(-7200), p_event_at: t(-7200), p_event_id: 'evt_old' });
  chk('an event body older than what the row reflects is refused', r.applied === false && r.reason === 'stale' && row(paid).status === 'trialing');
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'active', p_as_of: t(0), p_live: true, p_authoritative: true });
  chk('a live read applies', r.applied && row(paid).status === 'active' && row(paid).stripe_synced_at);
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'past_due', p_as_of: t(-30), p_live: true, p_authoritative: true });
  chk('an OLDER live read loses to a newer one (same clock)', r.reason === 'stale' && row(paid).status === 'active');
  V(`update public.subscriptions set last_event_at = now() + interval '40 seconds' where user_id = ${lit(paid)};`);
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'active', p_cancel_at_period_end: true, p_as_of: t(1), p_live: true, p_authoritative: true });
  chk('a live read is not refused because Stripe\'s clock runs a little ahead of ours', r.applied && row(paid).cancel_at_period_end === true, r);
  V(`update public.subscriptions set last_event_at = now() + interval '10 minutes' where user_id = ${lit(paid)};`);
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'canceled', p_as_of: t(2), p_live: true, p_authoritative: true });
  chk('but it does lose to an event body that is minutes newer', r.reason === 'stale');
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'active', p_as_of: t(700), p_live: true, p_authoritative: true });
  chk('a live read changing nothing says so', r.applied && r.changed === false, r);

  // duplicates and the other subscription
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid_2', p_customer_id: 'cus_paid', p_status: 'active', p_current_period_end: t(86400 * 30), p_as_of: t(800), p_event_at: t(800) });
  chk('a second live subscription arriving on an event is refused and flagged as a duplicate',
    r.reason === 'duplicate_entitled_subscription' && row(paid).stripe_subscription_id === 'sub_paid' && alertsOf(paid, 'duplicate_active_subscriptions').length === 1);
  r = apply({ p_user: paid, p_subscription_id: 'sub_paid_2', p_customer_id: 'cus_paid', p_status: 'canceled', p_as_of: t(900), p_event_at: t(900) });
  chk('the duplicate being cancelled does not lock out the subscription in use', r.reason === 'other_subscription_entitled' && row(paid).status === 'active');
  r = apply({ p_user: stale, p_subscription_id: 'sub_paid', p_customer_id: 'cus_paid', p_status: 'active', p_as_of: t(1000), p_live: true, p_authoritative: true });
  chk('a subscription already on another account is never written to this one', r.reason === 'subscription_belongs_to_other_user' && row(stale).stripe_subscription_id === 'sub_stale');
  chk('and is raised as an identity conflict', alertsOf(stale, 'identity_conflict').length === 1);
  r = apply({ p_user: '00000000-0000-4000-8000-00000000dead', p_status: 'active', p_as_of: t(0) });
  chk('an account that does not exist is an answer, not a foreign-key failure', r.reason === 'no_such_user');
  r = apply({ p_user: stale, p_subscription_id: 'sub_stale', p_customer_id: 'cus_stale', p_status: 'canceled', p_as_of: t(1100), p_live: true, p_authoritative: true });
  chk('Stripe ends what Stripe granted: the stale "active" from August becomes canceled', r.applied && row(stale).status === 'canceled');

  // nobody else may call it
  const denied = db.mustFail(() => db.as(nobody, "select public.billing_apply_subscription_state(" + lit(nobody) + ", null, null, 'active', null, null, null, now(), 'me');"));
  chk('a signed-in reader cannot call the writer', /permission denied/.test(String(denied)), denied);
  const deniedAnon = db.mustFail(() => db.anon("select public.billing_link_customer('cus_x', " + lit(nobody) + ", 'me');"));
  chk('an anonymous caller cannot link a customer', /permission denied/.test(String(deniedAnon)), deniedAnon);

  /* ===================================================================== */
  /* 5. NAMING                                                             */
  /* ===================================================================== */
  const res = (a) => JSON.parse(db.service('select public.billing_resolve_user(' + ['p_metadata_user', 'p_client_reference', 'p_customer_id', 'p_subscription_id', 'p_session_id', 'p_email']
    .map((k) => k + ' => ' + (a[k] == null ? 'null' : lit(a[k]))).join(', ') + ');'));
  r = res({ p_metadata_user: paid, p_client_reference: stale });
  chk('metadata outranks client_reference_id, and the disagreement is reported', r.user_id === paid && r.how === 'metadata' && /client_reference_id says/.test(r.conflict || ''), r);
  r = res({ p_client_reference: 'not-a-uuid', p_customer_id: 'cus_paid' });
  chk('a malformed reference is rejected, and the known customer names the account', r.user_id === paid && r.how === 'known customer' && r.rejected.length === 1, r);
  r = res({ p_client_reference: '00000000-0000-4000-8000-00000000dead' });
  chk('a reference to an account that does not exist names nobody', r.user_id === null && r.rejected[0].why === 'names no account', r);
  r = res({ p_email: 'LOST@x.co' });
  chk('a confirmed email is the last resort, case-insensitively', r.user_id === lost && r.how === 'confirmed email match', r);
  const unconf = user('unconf', 'unconf@x.co', false);
  r = res({ p_email: 'unconf@x.co' });
  chk('an UNCONFIRMED email names nobody', r.user_id === null && unconf);
  V(`insert into public.billing_checkout_sessions (id, user_id) values ('cs_live_known', ${lit(nobody)});`);
  r = res({ p_session_id: 'cs_live_known' });
  chk('a checkout session we created names its account', r.user_id === nobody && r.how === 'checkout_session');

  let link = JSON.parse(db.service("select to_jsonb(public.billing_link_customer('cus_paid', " + lit(nobody) + ", 'test'));"));
  chk('a linked customer is never remapped to another account', link === 'conflict' && one("select user_id from public.billing_customers where stripe_customer_id = 'cus_paid'").user_id === paid);
  chk('the attempt is raised', J("select 1 from public.billing_alerts where dedupe_key = 'identity_conflict:cus:cus_paid' and resolved_at is null").length === 1);
  link = JSON.parse(db.service("select to_jsonb(public.billing_link_customer('bad id', " + lit(nobody) + ", 'test'));"));
  chk('something that is not a customer id is refused', link === 'invalid');

  /* ===================================================================== */
  /* 6. THE DECISION, AND WHO MAY ASK FOR IT                               */
  /* ===================================================================== */
  const acc = (u) => JSON.parse(V('select public.billing_access_for(' + lit(u) + ')'));
  chk('owner_comp: access, reason comp, nothing offered', acc(owner).has_access && acc(owner).reason === 'comp' && acc(owner).offer === 'none');
  V(`update public.subscriptions set current_period_end = now() - interval '1 day', status = 'trialing', price_id = 'comp_trial', stripe_subscription_id = null, stripe_customer_id = null where user_id = ${lit(ctrial)};`);
  chk('an ended comp_trial: no access, and offered the trial (it can buy)', !acc(ctrial).has_access && acc(ctrial).reason === 'comp_trial_ended' && acc(ctrial).offer === 'trial');
  chk('a Stripe-backed cancellation is offered a restart', acc(stale).offer === 'resubscribe' && acc(stale).reason === 'canceled');
  chk('consent without a row: ask Stripe', acc(nobody).should_sync === true && acc(nobody).reason === 'no_subscription');
  const fresh = user('fresh', 'fresh@x.co');
  chk('an account that never went near checkout: do NOT spend a Stripe call', acc(fresh).should_sync === false);
  V(`insert into public.billing_sync_log (user_id, source, outcome) values (${lit(nobody)}, 'self', 'unchanged');`);
  chk('and an account asked about a minute ago is not asked again yet', acc(nobody).should_sync === false);

  const mine = JSON.parse(db.as(paid, 'select public.my_billing_access();'));
  chk('my_billing_access describes the caller and only the caller', mine.user_id === paid && mine.has_access === true);
  chk('signed out, it says so', JSON.parse(db.as('', 'select public.my_billing_access();')).signed_in === false);
  chk('anon cannot call it at all', /permission denied/.test(String(db.mustFail(() => db.anon('select public.my_billing_access();')))));
  chk('a reader cannot ask for someone else\'s decision', /permission denied/.test(String(db.mustFail(() => db.as(paid, 'select public.billing_access_for(' + lit(stale) + ');')))));
  ['billing_customers', 'billing_checkout_sessions', 'billing_sync_log', 'billing_alerts', 'billing_diagnostics'].forEach((tb) =>
    chk('a reader cannot read ' + tb, /permission denied/.test(String(db.mustFail(() => db.as(paid, 'select * from public.' + tb + ';'))))));
  chk('a reader still cannot write their own subscription row', /permission denied|row-level security/.test(String(db.mustFail(() =>
    db.as(fresh, "insert into public.subscriptions (user_id, status) values (" + lit(fresh) + ", 'active');")))));

  /* ===================================================================== */
  /* 7. LIMITS AND THE SCHEDULE                                            */
  /* ===================================================================== */
  const admit = () => JSON.parse(db.service('select public.billing_sync_admit(' + lit(fresh) + ", 'self', 3, 600);"));
  chk('reconciliation is admitted up to the limit', admit().admitted && admit().admitted && admit().admitted);
  const fourth = admit();
  chk('and then refused, with when to come back', fourth.admitted === false && fourth.retry_after_s > 0 && fourth.retry_after_s <= 600, fourth);
  chk('the sweep runs once', db.service('select public.billing_sweep_admit(540);') === 't');
  chk('and is debounced after that', db.service('select public.billing_sweep_admit(540);') === 'f');
  const cands = J('select * from public.billing_sweep_candidates(50)');
  chk('the sweep looks at the account that consented and has nothing', cands.some((c) => c.user_id === nobody) || J("select 1 from public.billing_sync_log where user_id = " + lit(nobody) + " and source = 'cron'").length > 0);
  chk('and at the stale "active" Stripe row', cands.length > 0);
  chk('never at a comp', !cands.some((c) => c.user_id === owner));
  V(`insert into public.billing_consents (user_id, price_display, billing_period, trial_days) values (${lit(fresh)}, '$49.99', 'month', 7);`);
  V(`insert into public.billing_sync_log (user_id, source, outcome) values (${lit(fresh)}, 'cron', 'unchanged');`);
  chk('and not at an account the sweep checked in the last half hour', !J('select * from public.billing_sweep_candidates(50)').some((c) => c.user_id === fresh));

  /* ===================================================================== */
  /* 8. THE OPERATOR                                                       */
  /* ===================================================================== */
  chk('a reader is not an operator', db.as(paid, 'select public.billing_is_admin();') === 'f');
  chk('the operator lookup refuses a reader', /not authorized|42501/.test(String(db.mustFail(() => db.as(paid, "select public.billing_admin_lookup('lost@x.co');")))));
  V("insert into public.affiliate_admins (user_id) values (" + lit(owner) + ") on conflict do nothing;");
  chk('an operator (the partner program\'s list) is', db.as(owner, 'select public.billing_is_admin();') === 't');
  const look = (q) => JSON.parse(db.as(owner, 'select public.billing_admin_lookup(' + lit(q) + ');'));
  chk('by email', look('lost@x.co')[0].user.id === lost);
  chk('by account id', look(lost)[0].user.id === lost);
  chk('by Stripe customer', look('cus_lost')[0].user.id === lost);
  chk('by Stripe event', look('evt_lost_co')[0].user.id === lost);
  chk('by checkout session', look('cs_live_known')[0].user.id === nobody);
  V(`insert into public.billing_sync_log (user_id, source, outcome, ref) values (${lit(lost)}, 'checkout_return', 'stripe_error', 'EDS-REF123');`);
  chk('by the reference a customer quotes', look('eds-ref123')[0].user.id === lost);
  const repL = look('lost@x.co')[0];
  chk('the report says why the account is locked', repL.access.has_access === false && repL.customers.length === 1 && Array.isArray(repL.mismatches));
  const repN = look('nobody@x.co')[0];
  chk('and names the reported failure: consent, no row', repN.mismatches.indexOf('consent recorded but no subscription row') >= 0, repN.mismatches);
  const ov = JSON.parse(db.as(owner, 'select public.billing_admin_overview();'));
  chk('the overview counts what needs a human', ov.open_alerts_by_kind.identity_conflict >= 1 && ov.unresolved_events_14d >= 2 && Array.isArray(ov.unresolved));
  chk('an operator may close an alert', db.as(owner, 'select public.billing_admin_resolve_alert(' + one("select id from public.billing_alerts where resolved_at is null limit 1").id + ", 'seen');") === 't');
  chk('the SQL-editor view lists every account with a billing footprint',
    J('select * from public.billing_diagnostics').length >= 8 && J("select mismatch from public.billing_diagnostics where user_id = " + lit(nobody))[0].mismatch === 'consent recorded, no subscription row');
} catch (e) {
  chk('the suite ran to the end', false, String(e.sqlMessage || e.stack || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
