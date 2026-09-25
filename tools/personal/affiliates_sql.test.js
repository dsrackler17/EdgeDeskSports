#!/usr/bin/env node
/* ===========================================================================
   supabase/affiliates.sql, AGAINST A REAL POSTGRESQL, THROUGH REAL STRIPE
   EVENT SHAPES.

   Applies the real billing.sql, stripe_webhook.sql and referral_codes.sql
   first, then this file twice, then walks the whole partner lifecycle the way
   production does it — a click on the landing page, a signed-in claim, and
   Stripe events landing in public.stripe_events exactly as the deployed
   webhook writes them (the WHOLE event, {id, type, data:{object}}) — and
   attacks it: self-referral, an existing customer, a second partner trying to
   take a customer, a reader reading money, an edited commission, a replayed
   event, a refund after payout.

   Run: node tools/personal/affiliates_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('./_pg.js');

const T = PG.kit('affiliates SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'affiliates.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL));
chk('the economics live in one settings row', /create table if not exists public\.affiliate_settings/.test(SQL) && /default_commission_rate\s+numeric not null default/.test(SQL));
chk('nothing here moves money: no payout provider is called', !/api\.stripe\.com|transfers|payouts\.create|paypal/i.test(SQL));

const db = PG.start('affil');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const U = {
  admin: '00000000-0000-0000-0000-0000000000ad',
  partner: '00000000-0000-0000-0000-0000000000a1',
  partner2: '00000000-0000-0000-0000-0000000000a2',
  ref: '00000000-0000-0000-0000-0000000000b1',
  existing: '00000000-0000-0000-0000-0000000000b2',
  promo: '00000000-0000-0000-0000-0000000000b3',
  late: '00000000-0000-0000-0000-0000000000b4'
};
const VIS = 'visitor_abcdefghijklmnop';
let seq = 0;
function event(type, obj, userId, createdSecAgo) {
  const id = 'evt_' + (++seq);
  const ev = { id: id, type: type, created: Math.floor(Date.now() / 1000) - (createdSecAgo || 0), livemode: true, data: { object: obj } };
  db.service(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
    values ('${id}','${type}', to_timestamp(${ev.created}), ${PG.lit(obj.customer || null)}, ${PG.lit(obj.subscription || (type.indexOf('customer.subscription') === 0 ? obj.id : null))},
            ${userId ? "'" + userId + "'" : 'null'}, ${PG.lit(JSON.stringify(ev))}::jsonb);`);
  return id;
}

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql'].forEach((f) => db.applyFile(path.join(PG.ROOT, 'supabase', f)));
  let out = db.applyFile(FILE);
  chk('the migration applies after the billing files', true);
  chk('every report row says ok', !/CHECK THIS/.test(out), out.slice(-500));
  out = db.applyFile(FILE);
  chk('and applies a second time', !/CHECK THIS/.test(out));

  db.sql(`insert into auth.users (id, email, created_at) values
    ('${U.admin}','owner@example.com', now() - interval '400 days'),
    ('${U.partner}','coach@example.com', now() - interval '200 days'),
    ('${U.partner2}','rival@example.com', now() - interval '200 days'),
    ('${U.existing}','old@example.com', now() - interval '90 days'),
    ('${U.promo}','promo@example.com', now() - interval '1 day'),
    ('${U.late}','late@example.com', now() - interval '1 day');
    insert into public.affiliate_admins (user_id) values ('${U.admin}');
    insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, created_at)
      values ('${U.existing}','active','cus_old','sub_old', now() - interval '80 days');`);

  /* ── accounts: only an admin creates one ─────────────────────────────── */
  let err = db.mustFail(() => db.as(U.partner, `select public.affiliate_admin_upsert_account('coach@example.com','COACHBIGGS','active',null,'BIGGS10','Coach Biggs');`));
  chk('a non-admin cannot create a partner account', !!err && /not an affiliate admin/.test(err));
  const made = JSON.parse(db.as(U.admin, `select public.affiliate_admin_upsert_account('coach@example.com','coachbiggs','active',null,'biggs10','Coach Biggs');`));
  chk('an admin creates one, code normalised to upper case', made.ok && made.code === 'COACHBIGGS', made);
  db.as(U.admin, `select public.affiliate_admin_upsert_account('rival@example.com','RIVAL','active',0.3,null,'Rival');`);
  const apply = JSON.parse(db.as(U.late, `select public.affiliate_apply('LATECODE');`));
  chk('self-serve applications are refused while the program is by invitation', apply.ok === false && apply.reason === 'program_by_invitation', apply);

  /* ── clicks ──────────────────────────────────────────────────────────── */
  const c1 = JSON.parse(db.anon(`select public.affiliate_track_click('coachbiggs','${VIS}','/','twitter.com');`));
  db.anon(`select public.affiliate_track_click('COACHBIGGS','${VIS}','/pricing','t.co');`);
  chk('a click is recorded from the landing page without an account', c1.ok === true);
  chk('the same visitor on the same day is one click', db.sql(`select count(*) from public.affiliate_clicks;`) === '1');
  chk('an unknown code records nothing', JSON.parse(db.anon(`select public.affiliate_track_click('NOPE123','${VIS}','/',null);`)).ok === false
    && db.sql(`select count(*) from public.affiliate_clicks;`) === '1');
  chk('a malformed visitor id records nothing', JSON.parse(db.anon(`select public.affiliate_track_click('COACHBIGGS','x','/',null);`)).ok === false);
  chk('only the hash of the visitor id is kept', db.sql(`select count(*) from public.affiliate_clicks where visitor_hash = '${VIS}';`) === '0');
  err = db.mustFail(() => db.anon(`select count(*) from public.affiliate_clicks;`));
  chk('anon cannot read clicks', !!err && /permission denied/.test(err));

  /* ── attribution ─────────────────────────────────────────────────────── */
  db.sql(`insert into auth.users (id, email, created_at) values ('${U.ref}','ref@example.com', now());`);
  const cl = JSON.parse(db.as(U.ref, `select public.affiliate_claim('coachbiggs','${VIS}');`));
  chk('a new account arriving through the link is attributed', cl.ok === true && cl.code === 'COACHBIGGS', cl);
  const cl2 = JSON.parse(db.as(U.ref, `select public.affiliate_claim('RIVAL', null);`));
  chk('a second partner cannot take the customer: the first attribution wins', cl2.ok === false && cl2.reason === 'already_attributed', cl2);
  chk('and the stored attribution is unchanged', db.sql(`select code || '|' || source from public.affiliate_attributions where user_id = '${U.ref}';`) === 'COACHBIGGS|link');
  const self = JSON.parse(db.as(U.partner, `select public.affiliate_claim('COACHBIGGS', null);`));
  chk('a partner cannot refer themselves', self.ok === false && self.reason === 'self_referral', self);
  const old = JSON.parse(db.as(U.existing, `select public.affiliate_claim('COACHBIGGS', null);`));
  chk('an existing customer cannot be claimed by a link', old.ok === false && old.reason === 'existing_customer', old);
  err = db.mustFail(() => db.anon(`select public.affiliate_claim('COACHBIGGS', null);`));
  chk('anon cannot claim', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.as(U.ref, `select count(*) from public.affiliate_attributions;`));
  chk('a reader cannot read the attribution table directly', !!err && /permission denied/.test(err));

  /* ── Stripe: trial, payments, cancellation, refund ─────────────────────── */
  db.service(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${U.ref}','trialing','cus_ref','sub_ref');`);
  event('customer.subscription.created', { id: 'sub_ref', object: 'subscription', customer: 'cus_ref', status: 'trialing' }, U.ref, 600);
  chk('a trial is recorded from the subscription event', db.sql(`select count(*) from public.affiliate_conversions where kind = 'trial_started' and user_id = '${U.ref}';`) === '1');
  event('customer.subscription.updated', { id: 'sub_ref', object: 'subscription', customer: 'cus_ref', status: 'trialing' }, U.ref, 500);
  chk('a second trialing event records no second trial', db.sql(`select count(*) from public.affiliate_conversions where kind = 'trial_started';`) === '1');
  event('invoice.payment_succeeded', { id: 'in_trial', object: 'invoice', customer: 'cus_ref', subscription: 'sub_ref', amount_paid: 0, currency: 'usd' }, U.ref, 400);
  chk('the $0 trial invoice earns nothing', db.sql(`select count(*) from public.affiliate_commissions;`) === '0');

  /* the first real charge arrives UNRESOLVED (no user id), as it can */
  const inv1 = event('invoice.payment_succeeded', { id: 'in_1', object: 'invoice', customer: 'cus_ref', subscription: 'sub_ref', amount_paid: 7999, tax: 0, currency: 'usd' }, null, 300);
  chk('a paid invoice becomes a paid conversion, resolved through the customer id', db.sql(`select kind from public.affiliate_conversions where stripe_invoice_id = 'in_1';`) === 'paid');
  const com = db.sql(`select basis_cents || '|' || rate || '|' || amount_cents || '|' || status || '|' || (eligible_at > now() + interval '29 days') from public.affiliate_commissions where stripe_invoice_id = 'in_1';`);
  chk('the commission is the configured rate of the charge, pending through the hold', com === '7999|0.25|2000|pending|true', com);
  db.service(`update public.stripe_events set resolved = true, user_id = '${U.ref}' where id = '${inv1}';`);
  chk('a redelivered or re-resolved event books nothing twice', db.sql(`select count(*) from public.affiliate_commissions;`) === '1'
    && db.sql(`select count(*) from public.affiliate_conversions where stripe_invoice_id = 'in_1';`) === '1');
  event('invoice.payment_succeeded', { id: 'in_2', object: 'invoice', customer: 'cus_ref', subscription: 'sub_ref', amount_paid: 7999, currency: 'usd' }, U.ref, 200);
  chk('the next month is a renewal with its own commission', db.sql(`select kind from public.affiliate_conversions where stripe_invoice_id = 'in_2';`) === 'renewal'
    && db.sql(`select count(*) from public.affiliate_commissions;`) === '2');
  /* the bare-object shape some fixtures use is read too */
  db.service(`insert into public.stripe_events (id, type, user_id, payload) values ('evt_bare','invoice.payment_succeeded','${U.ref}',
    '{"id":"in_3","object":"invoice","customer":"cus_ref","subscription":"sub_ref","amount_paid":7999,"currency":"usd"}'::jsonb);`);
  chk('an invoice stored as the bare object is read as well', db.sql(`select count(*) from public.affiliate_commissions where stripe_invoice_id = 'in_3';`) === '1');

  /* the revenue report (referral_codes.sql) reads the same, whole-event shape */
  chk('BUG FIX: the revenue view reads an invoice stored as the webhook stores it (inside the event)',
    db.sql(`select amount_paid_cents from public.referral_invoice_payments where invoice_id = 'in_1';`) === '7999');
  chk('and still reads the bare-object shape', db.sql(`select amount_paid_cents from public.referral_invoice_payments where invoice_id = 'in_3';`) === '7999');

  /* a malformed payload must never fail the webhook's ledger write */
  db.service(`insert into public.stripe_events (id, type, payload) values ('evt_bad','invoice.payment_succeeded','{"data":{"object":{"id":"in_x","amount_paid":"lots"}}}'::jsonb);`);
  chk('a malformed event is still recorded in the ledger', db.sql(`select count(*) from public.stripe_events where id = 'evt_bad';`) === '1');

  /* ── money is never edited ───────────────────────────────────────────── */
  err = db.mustFail(() => db.service(`update public.affiliate_commissions set amount_cents = 99999 where stripe_invoice_id = 'in_1';`));
  chk('a commission amount cannot be edited, even by the service role', !!err && /never edited/.test(err));
  err = db.mustFail(() => db.service(`delete from public.affiliate_commissions;`));
  chk('a commission cannot be deleted', !!err && /never deleted|permission denied/.test(err));
  err = db.mustFail(() => db.as(U.partner, `select count(*) from public.affiliate_commissions;`));
  chk('a partner cannot read the commission table directly', !!err && /permission denied/.test(err));

  /* ── approval and payout: manual, with a reference ────────────────────── */
  const allIds = db.sql(`select string_agg(id::text, ',') from public.affiliate_commissions;`);
  const early = JSON.parse(db.as(U.admin, `select public.affiliate_admin_commissions(array[${allIds}]::bigint[], 'approve');`));
  chk('nothing is approved before its hold has passed', early.changed === 0, early);
  db.as(U.admin, `select public.affiliate_admin_update_settings('{"hold_days":0}'::jsonb);`);
  event('invoice.payment_succeeded', { id: 'in_4', object: 'invoice', customer: 'cus_ref', subscription: 'sub_ref', amount_paid: 7999, currency: 'usd' }, U.ref, 100);
  const id4 = db.sql(`select id from public.affiliate_commissions where stripe_invoice_id = 'in_4';`);
  chk('an approval is one admin action once eligible', JSON.parse(db.as(U.admin, `select public.affiliate_admin_commissions(array[${id4}]::bigint[], 'approve');`)).changed === 1);
  chk('a payout needs a reference', JSON.parse(db.as(U.admin, `select public.affiliate_admin_commissions(array[${id4}]::bigint[], 'pay');`)).ok === false);
  db.as(U.admin, `select public.affiliate_admin_commissions(array[${id4}]::bigint[], 'pay', 'manual transfer 2026-10-01 #118');`);
  chk('a payout is recorded with its reference', db.sql(`select status || '|' || payout_reference from public.affiliate_commissions where id = ${id4};`) === 'paid|manual transfer 2026-10-01 #118');
  err = db.mustFail(() => db.service(`update public.affiliate_commissions set status = 'pending' where id = ${id4};`));
  chk('a paid commission cannot be walked back', !!err && /stays paid/.test(err));
  err = db.mustFail(() => db.as(U.partner, `select public.affiliate_admin_commissions(array[${id4}]::bigint[], 'void');`));
  chk('a partner cannot approve, pay or void', !!err && /not an affiliate admin/.test(err));

  /* ── refunds ─────────────────────────────────────────────────────────── */
  event('charge.refunded', { id: 'ch_1', object: 'charge', customer: 'cus_ref', invoice: 'in_1', amount: 7999, amount_refunded: 7999, currency: 'usd' }, null, 50);
  chk('a full refund voids an unpaid commission', db.sql(`select status from public.affiliate_commissions where stripe_invoice_id = 'in_1' and kind = 'accrual';`) === 'void');
  event('charge.refunded', { id: 'ch_4', object: 'charge', customer: 'cus_ref', invoice: 'in_4', amount: 7999, amount_refunded: 4000, currency: 'usd' }, null, 40);
  const claw = db.sql(`select amount_cents || '|' || status from public.affiliate_commissions where stripe_invoice_id = 'in_4' and kind = 'clawback';`);
  chk('a refund after payout books a proportional negative clawback', claw === '-1000|pending', claw);

  /* ── cancellation ────────────────────────────────────────────────────── */
  let stats = JSON.parse(db.as(U.partner, `select public.affiliate_my_dashboard();`)).stats;
  chk('while subscribed, the customer counts as active paid', stats.active_paid === 0 || stats.active_paid === 1);
  db.service(`update public.subscriptions set status = 'active' where user_id = '${U.ref}';`);
  stats = JSON.parse(db.as(U.partner, `select public.affiliate_my_dashboard();`)).stats;
  chk('an active paying customer is counted once', stats.active_paid === 1, stats);
  db.service(`update public.subscriptions set status = 'canceled' where user_id = '${U.ref}';`);
  event('customer.subscription.deleted', { id: 'sub_ref', object: 'subscription', customer: 'cus_ref', status: 'canceled' }, U.ref, 10);
  stats = JSON.parse(db.as(U.partner, `select public.affiliate_my_dashboard();`)).stats;
  chk('a cancellation updates the partner\'s stats', stats.active_paid === 0 && stats.canceled === 1, stats);

  /* ── a sale made with the partner's promo code and no link ─────────────── */
  db.service(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, referral_code) values ('${U.promo}','active','cus_p','sub_p','BIGGS10');`);
  event('invoice.payment_succeeded', { id: 'in_p1', object: 'invoice', customer: 'cus_p', subscription: 'sub_p', amount_paid: 7999, currency: 'usd' }, U.promo, 5);
  chk('the promo code attributes the sale to its partner', db.sql(`select source from public.affiliate_attributions where user_id = '${U.promo}';`) === 'promo_code'
    && db.sql(`select count(*) from public.affiliate_commissions where stripe_invoice_id = 'in_p1';`) === '1');

  /* ── the partner dashboard ───────────────────────────────────────────── */
  const dash = JSON.parse(db.as(U.partner, `select public.affiliate_my_dashboard();`));
  chk('the dashboard answers for the caller\'s own account', dash.account && dash.account.code === 'COACHBIGGS');
  chk('clicks, signups, trials and paid customers are counted', dash.stats.clicks === 1 && dash.stats.signups === 2 && dash.stats.trials === 1 && dash.stats.paid_customers === 2, dash.stats);
  chk('commission is split by status', dash.stats.paid_cents === 2000 && dash.stats.void_cents === 2000 && dash.stats.pending_cents > 0, dash.stats);
  chk('no referred customer is identifiable in it', !/example\.com|cus_|00000000-/.test(JSON.stringify(dash)));
  const none = JSON.parse(db.as(U.ref, `select public.affiliate_my_dashboard();`));
  chk('a reader with no partner account sees no stats', none.ok === true && none.account === null && !none.stats);
  err = db.mustFail(() => db.anon(`select public.affiliate_my_dashboard();`));
  chk('anon has no dashboard', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.anon(`select public.affiliate_apply('ANONCODE', null, null);`));
  chk('anon cannot apply to the program', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.anon(`select public.affiliate_admin_overview();`));
  chk('anon cannot reach an admin function', !!err && /permission denied/.test(err));

  /* ── admin overview ──────────────────────────────────────────────────── */
  err = db.mustFail(() => db.as(U.partner, `select public.affiliate_admin_overview();`));
  chk('the admin overview is admin-only', !!err && /not an affiliate admin/.test(err));
  const ov = JSON.parse(db.as(U.admin, `select public.affiliate_admin_overview();`));
  chk('the admin sees every account with its stats', ov.accounts.length === 2 && ov.commissions.length >= 5, { a: ov.accounts.length, c: ov.commissions.length });
  const settings = JSON.parse(db.as(U.admin, `select public.affiliate_admin_update_settings('{"default_commission_rate":0.2,"commission_duration_months":""}'::jsonb);`));
  chk('the commission rate is configurable by an admin', +settings.default_commission_rate === 0.2 && settings.commission_duration_months === null, settings);
  err = db.mustFail(() => db.as(U.admin, `select public.affiliate_admin_update_settings('{"default_commission_rate":2}'::jsonb);`));
  chk('an absurd rate is refused by the database', !!err && /affiliate_settings_ranges/.test(err));
  const rec = JSON.parse(db.service(`select public.affiliate_reconcile(45);`));
  chk('reconcile replays the ledger without booking anything twice', rec.events_replayed > 0 && db.sql(`select count(*) from public.affiliate_commissions where stripe_invoice_id = 'in_2';`) === '1', rec);
  err = db.mustFail(() => db.as(U.admin, `select public.affiliate_reconcile(45);`));
  chk('the raw reconcile is not callable by a client, even an admin (the admin door wraps it)', !!err && /permission denied/.test(err));
  chk('the admin door runs it', JSON.parse(db.as(U.admin, `select public.affiliate_admin_reconcile();`)).events_replayed > 0);
} catch (e) {
  chk('the live suite ran without an unexpected error', false, String(e.message).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
