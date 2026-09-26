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
  let out = db.applyFileAtomic(FILE);
  chk('the migration applies after the billing files', true);
  chk('every report row says ok', !/CHECK THIS/.test(out), out.slice(-500));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time', !/CHECK THIS/.test(out));
  /* re-running it on a live site: a Stripe webhook (or the hourly reconcile)
     holds stripe_events and then reads the affiliate tables. Run as the SQL
     editor runs it — one transaction — the file must not deadlock with it. */
  const hook = db.background('begin;\nselect count(*) from public.stripe_events;\nselect pg_sleep(2);\nselect count(*) from public.affiliate_settings;\ncommit;\n');
  db.sleep(0.4);
  const rerun = db.mustFail(() => db.applyFileAtomic(FILE));
  const hk = hook.wait(30000);
  chk('re-running it while a webhook is mid-event deadlocks neither side', rerun === null && hk.code === 0,
    { rerun: rerun && rerun.slice(0, 400), hook: hk });

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

  /* ── CAMPAIGNS: per-code terms the admin sets without a deploy ─────────── */
  const C = { a: '00000000-0000-0000-0000-0000000000c1', b: '00000000-0000-0000-0000-0000000000c2', c: '00000000-0000-0000-0000-0000000000c3',
    d: '00000000-0000-0000-0000-0000000000c4', e: '00000000-0000-0000-0000-0000000000c5' };
  const VC = 'visitor_campaign_abcdefgh', VD = 'visitor_campaign_zyxwvuts';
  db.sql(`insert into auth.users (id, email, created_at) values ('${C.a}','ca@example.com', now()), ('${C.b}','cb@example.com', now()),
    ('${C.c}','cc@example.com', now()), ('${C.d}','cd@example.com', now()), ('${C.e}','ce@example.com', now());`);
  err = db.mustFail(() => db.as(U.partner, `select public.affiliate_admin_upsert_campaign('{"partner_code":"COACHBIGGS","code":"BIGGSFALL","commission_rate":0.4}'::jsonb);`));
  chk('campaigns: only an admin creates one', !!err && /not an affiliate admin/.test(err));
  let cp = JSON.parse(db.as(U.admin, `select public.affiliate_admin_upsert_campaign('${JSON.stringify({ partner_code: 'coachbiggs', code: 'biggsfall', name: 'Fall launch',
    discount_type: 'percent', discount_amount: 20, discount_duration: 'repeating', discount_duration_months: 3, stripe_promo_code: 'biggsfall',
    commission_rate: 0.4, commission_type: 'one_time', commission_duration_months: 6 })}'::jsonb);`));
  chk('campaigns: an admin creates one, code normalised to upper case', cp.ok && cp.code === 'BIGGSFALL', cp);
  const campId = cp.id;
  chk('campaigns: a one-time commission carries no month count', cp.campaign.commission_type === 'one_time' && cp.campaign.commission_duration_months === null, cp.campaign);
  chk('campaigns: the discount is NOT shown before Stripe confirms it', cp.campaign.stripe_state === 'unverified' && cp.campaign.discount === null, cp.campaign);
  let bad = JSON.parse(db.as(U.admin, `select public.affiliate_admin_upsert_campaign('{"partner_code":"COACHBIGGS","code":"BADPCT","discount_type":"percent","discount_amount":140,"discount_duration":"once","commission_rate":0.2}'::jsonb);`));
  chk('campaigns: an impossible discount is refused', bad.ok === false && bad.reason === 'invalid_campaign', bad);
  bad = JSON.parse(db.as(U.admin, `select public.affiliate_admin_upsert_campaign('{"partner_code":"COACHBIGGS","code":"RIVAL","commission_rate":0.2}'::jsonb);`));
  chk('campaigns: a code that is another creator\'s base code is refused', bad.ok === false, bad);
  bad = JSON.parse(db.as(U.admin, `select public.affiliate_admin_upsert_campaign('{"partner_code":"COACHBIGGS","code":"LATER","commission_rate":0.2,"starts_at":"2030-01-02T00:00:00Z","expires_at":"2030-01-01T00:00:00Z"}'::jsonb);`));
  chk('campaigns: an end before the start is refused', bad.ok === false, bad);

  /* the visitor's offer: the code to carry to checkout, never the commission */
  let offer = JSON.parse(db.anon(`select public.affiliate_offer('biggsfall');`));
  chk('campaigns: a visitor reads the offer without an account', offer.ok === true && offer.campaign === true, offer);
  chk('campaigns: no code is sent to checkout before Stripe has it', offer.checkout_code === null, offer);
  chk('campaigns: the offer never carries the creator\'s economics', !/commission|0\.4|rate/.test(JSON.stringify(offer)), offer);
  chk('campaigns: and no discount until Stripe records it', offer.discount === null, offer);
  /* Stripe's own record arrives through the ledger */
  event('promotion_code.created', { id: 'promo_BIGGSFALL1', object: 'promotion_code', code: 'BIGGSFALL', active: true,
    coupon: { id: 'co_fall', object: 'coupon', percent_off: 20, duration: 'repeating', duration_in_months: 3, valid: true } }, null, 30);
  offer = JSON.parse(db.anon(`select public.affiliate_offer('BIGGSFALL');`));
  chk('campaigns: Stripe\'s promotion code is copied onto the campaign', db.sql(`select stripe_promotion_code_id || '|' || stripe_coupon_id from public.affiliate_campaigns where id = '${campId}';`) === 'promo_BIGGSFALL1|co_fall');
  chk('campaigns: once Stripe has the promotion code, checkout carries it', offer.checkout_code === 'BIGGSFALL', offer);
  chk('campaigns: once Stripe matches the terms, the visitor sees Stripe\'s discount', offer.discount && offer.discount.percent_off === 20
    && offer.discount.duration === 'repeating' && offer.discount.duration_in_months === 3 && offer.discount.source === 'stripe', offer);
  event('coupon.updated', { id: 'co_fall', object: 'coupon', percent_off: 25, duration: 'repeating', duration_in_months: 3, valid: true }, null, 20);
  let ovc = JSON.parse(db.as(U.admin, `select public.affiliate_admin_overview();`)).campaigns.find((x) => x.code === 'BIGGSFALL');
  chk('campaigns: when Stripe and the admin disagree, the admin sees a mismatch and the visitor sees no amount',
    ovc.stripe_state === 'mismatch' && JSON.parse(db.anon(`select public.affiliate_offer('BIGGSFALL');`)).discount === null, ovc && ovc.stripe_state);
  event('coupon.updated', { id: 'co_fall', object: 'coupon', percent_off: 20, duration: 'repeating', duration_in_months: 3, valid: true }, null, 15);
  chk('campaigns: Stripe stays the source of truth as it changes', JSON.parse(db.anon(`select public.affiliate_offer('BIGGSFALL');`)).discount.percent_off === 20);

  /* click + claim through the campaign: the terms are snapshotted */
  chk('campaigns: a click through the campaign code is recorded against the campaign',
    JSON.parse(db.anon(`select public.affiliate_track_click('BIGGSFALL','${VC}','/','x.com');`)).ok === true
    && db.sql(`select count(*) from public.affiliate_clicks where campaign_id = '${campId}';`) === '1');
  const cc = JSON.parse(db.as(C.a, `select public.affiliate_claim('BIGGSFALL','${VC}');`));
  chk('campaigns: the account is attributed to the creator through the campaign', cc.ok === true && cc.code === 'BIGGSFALL', cc);
  chk('campaigns: the campaign terms are snapshotted onto the attribution',
    db.sql(`select campaign_id || '|' || term_rate || '|' || term_type || '|' || coalesce(term_months::text, 'null') from public.affiliate_attributions where user_id = '${C.a}';`) === campId + '|0.4|one_time|null');
  err = db.mustFail(() => db.service(`update public.affiliate_attributions set term_rate = 0.9 where user_id = '${C.a}';`));
  chk('campaigns: an attribution\'s terms cannot be rewritten, even by the service role', !!err && /never rewritten/.test(err));
  err = db.mustFail(() => db.service(`update public.affiliate_attributions set affiliate_id = (select id from public.affiliate_accounts where code = 'RIVAL') where user_id = '${C.a}';`));
  chk('campaigns: nor its creator', !!err && /never rewritten/.test(err));
  /* editing the campaign later changes nothing already attributed */
  db.as(U.admin, `select public.affiliate_admin_upsert_campaign('${JSON.stringify({ id: campId, partner_code: 'COACHBIGGS', code: 'BIGGSFALL', name: 'Fall launch',
    discount_type: 'percent', discount_amount: 20, discount_duration: 'repeating', discount_duration_months: 3, stripe_promo_code: 'BIGGSFALL',
    commission_rate: 0.1, commission_type: 'recurring' })}'::jsonb);`);
  chk('campaigns: an edit applies to the next attribution, not the last one', db.sql(`select term_rate::text from public.affiliate_attributions where user_id = '${C.a}';`) === '0.4');
  /* one-time: the first paid invoice earns at the snapshotted rate, the next earns nothing */
  db.service(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${C.a}','active','cus_ca','sub_ca');`);
  event('invoice.payment_succeeded', { id: 'in_ca1', object: 'invoice', customer: 'cus_ca', subscription: 'sub_ca', amount_paid: 6399, currency: 'usd' }, C.a, 9);
  event('invoice.payment_succeeded', { id: 'in_ca2', object: 'invoice', customer: 'cus_ca', subscription: 'sub_ca', amount_paid: 6399, currency: 'usd' }, C.a, 8);
  chk('campaigns: one-time earns on the first paid invoice at the campaign rate (of what Stripe collected)',
    db.sql(`select rate || '|' || amount_cents from public.affiliate_commissions where stripe_invoice_id = 'in_ca1';`) === '0.4|2560');
  chk('campaigns: and nothing on the renewal', db.sql(`select count(*) from public.affiliate_commissions where stripe_invoice_id = 'in_ca2';`) === '0'
    && db.sql(`select kind from public.affiliate_conversions where stripe_invoice_id = 'in_ca2';`) === 'renewal');

  /* disabling: no new attributions through the code; existing ones keep earning */
  db.as(U.admin, `select public.affiliate_admin_upsert_campaign('{"partner_code":"COACHBIGGS","code":"BIGGSREC","commission_rate":0.3,"commission_type":"recurring","commission_duration_months":2}'::jsonb);`);
  const recId = db.sql(`select id from public.affiliate_campaigns where code = 'BIGGSREC';`);
  chk('campaigns: a recurring campaign attributes', JSON.parse(db.as(C.b, `select public.affiliate_claim('BIGGSREC', null);`)).ok === true
    && db.sql(`select term_type || '|' || term_months from public.affiliate_attributions where user_id = '${C.b}';`) === 'recurring|2');
  const off = JSON.parse(db.as(U.admin, `select public.affiliate_admin_set_campaign_active('${recId}', false);`));
  chk('campaigns: an admin disables one in a call', off.ok === true && db.sql(`select active || '|' || (disabled_at is not null) from public.affiliate_campaigns where id = '${recId}';`) === 'false|true');
  const cd = JSON.parse(db.as(C.c, `select public.affiliate_claim('BIGGSREC', null);`));
  chk('campaigns: a disabled campaign attributes nobody new', cd.ok === false && cd.reason === 'campaign_not_active', cd);
  chk('campaigns: and its click door records nothing', JSON.parse(db.anon(`select public.affiliate_track_click('BIGGSREC','${VD}','/',null);`)).ok === false);
  db.service(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${C.b}','active','cus_cb','sub_cb');`);
  event('invoice.payment_succeeded', { id: 'in_cb1', object: 'invoice', customer: 'cus_cb', subscription: 'sub_cb', amount_paid: 7999, currency: 'usd' }, C.b, 7);
  chk('campaigns: an account attributed before the switch-off still earns on its own terms',
    db.sql(`select rate || '|' || amount_cents from public.affiliate_commissions where stripe_invoice_id = 'in_cb1';`) === '0.3|2400');
  err = db.mustFail(() => db.service(`delete from public.affiliate_campaigns where id = '${recId}';`));
  chk('campaigns: a campaign is never deleted', !!err && /never deleted/.test(err));

  /* expiry: an ended campaign still credits a visitor who clicked while it ran */
  db.as(U.admin, `select public.affiliate_admin_upsert_campaign('{"partner_code":"COACHBIGGS","code":"BIGGSWEEK","commission_rate":0.35}'::jsonb);`);
  db.anon(`select public.affiliate_track_click('BIGGSWEEK','${VD}','/',null);`);
  db.service(`update public.affiliate_campaigns set starts_at = now() - interval '10 days', expires_at = now() - interval '1 minute' where code = 'BIGGSWEEK';
              update public.affiliate_clicks set created_at = now() - interval '2 days' where visitor_hash = md5('edgedesk-affiliate:${VD}');`);
  const late = JSON.parse(db.as(C.d, `select public.affiliate_claim('BIGGSWEEK','${VD}');`));
  chk('campaigns: an ended campaign honours a click made while it ran', late.ok === true
    && db.sql(`select term_rate::text from public.affiliate_attributions where user_id = '${C.d}';`) === '0.35', late);
  const nolate = JSON.parse(db.as(C.e, `select public.affiliate_claim('BIGGSWEEK', null);`));
  chk('campaigns: but attributes nobody who never clicked it', nolate.ok === false && nolate.reason === 'campaign_not_active', nolate);

  /* a promo code typed at checkout, no link: the campaign in force at the sale */
  const PU = '00000000-0000-0000-0000-0000000000c6';
  db.sql(`insert into auth.users (id, email, created_at) values ('${PU}','cp@example.com', now());`);
  db.service(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, referral_code) values ('${PU}','active','cus_cp','sub_cp','BIGGSFALL');`);
  event('invoice.payment_succeeded', { id: 'in_cp1', object: 'invoice', customer: 'cus_cp', subscription: 'sub_cp', amount_paid: 6399, currency: 'usd' }, PU, 6);
  chk('campaigns: a checkout promo code attributes through the campaign in force, with its current terms',
    db.sql(`select source || '|' || term_type || '|' || term_rate from public.affiliate_attributions where user_id = '${PU}';`) === 'promo_code|recurring|0.1');
  /* a customer already credited to one creator is never taken by another's campaign code */
  db.as(U.admin, `select public.affiliate_admin_upsert_campaign('{"partner_code":"RIVAL","code":"RIVALFALL","commission_rate":0.5}'::jsonb);`);
  chk('campaigns: another creator\'s campaign cannot take an attributed customer', JSON.parse(db.as(C.a, `select public.affiliate_claim('RIVALFALL', null);`)).reason === 'already_attributed'
    && db.sql(`select code from public.affiliate_attributions where user_id = '${C.a}';`) === 'BIGGSFALL');

  /* the creator and the admin read their campaigns */
  const pd = JSON.parse(db.as(U.partner, `select public.affiliate_my_dashboard();`));
  const pc = (pd.campaigns || []).find((x) => x.code === 'BIGGSFALL');
  chk('campaigns: the creator sees their own campaigns, terms and counts', pc && pc.stats.signups === 2 && pc.stats.clicks === 1 && pc.id === null, pc);
  chk('campaigns: and never another creator\'s', !(pd.campaigns || []).some((x) => x.code === 'RIVALFALL'));
  ovc = JSON.parse(db.as(U.admin, `select public.affiliate_admin_overview();`)).campaigns;
  chk('campaigns: the admin sees every campaign with its partner, state and Stripe check', ovc.length === 4 && ovc.every((x) => x.partner_code && x.stripe_state && x.stats), ovc.map((x) => x.code));
  err = db.mustFail(() => db.as(U.partner, `select count(*) from public.affiliate_campaigns;`));
  chk('campaigns: a reader cannot read the campaign table directly', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.anon(`select public.affiliate_admin_set_campaign_active('${recId}', true);`));
  chk('campaigns: anon cannot switch one', !!err && /permission denied/.test(err));
} catch (e) {
  chk('the live suite ran without an unexpected error', false, String(e.message).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
