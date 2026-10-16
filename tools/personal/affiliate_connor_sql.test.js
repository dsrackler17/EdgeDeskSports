#!/usr/bin/env node
/* ===========================================================================
   CONNOR'S REFERRAL DEAL, AGAINST A REAL POSTGRESQL, THROUGH REAL STRIPE
   EVENT SHAPES ON A SIMULATED TEST CLOCK.

   Applies the shipped billing.sql, stripe_webhook.sql, referral_codes.sql,
   affiliates.sql and affiliate_connor.sql (the last two twice), then plays a
   subscription the way Stripe delivers it — the subscription with Connor's
   promotion code and the checkout's metadata, the $0 trial invoice, then
   thirteen monthly invoices with Stripe's own paid_at and billing periods —
   into public.stripe_events exactly as the deployed webhook writes them, and
   checks every number the deal promises:

     trial invoice $0, no commission; invoices 1-3 $44.99 -> $9.00 each;
     invoice 4 on $49.99 -> $10.00; invoices 5-12 likewise; invoice 13
     earns nothing (12 months from the first paid invoice); tax excluded;
     webhook retries and duplicate event types book nothing twice; a refund
     and a dispute book negative rows capped at the invoice's commission; a
     returning customer is never attributed; test mode stays out of the
     statement; the statement masks customers and totals the month.

   Run: node tools/personal/affiliate_connor_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('./_pg.js');

const T = PG.kit('Connor affiliate SQL');
const chk = T.chk;
const SEED = path.join(PG.ROOT, 'supabase', 'affiliate_connor.sql');
const SEED_SQL = fs.readFileSync(SEED, 'utf8');

chk('the seed carries no Stripe id (they come from the checkout\'s env)', !/promo_[A-Za-z0-9]{6,}|price_[A-Za-z0-9]{6,}|vDsOEet0/.test(SEED_SQL));
chk('the seed has no psql meta-commands', !/^\\/m.test(SEED_SQL));
chk('the seed ends in a report', /CHECK THIS/.test(SEED_SQL));
chk('BETDESK is withdrawn from the code list', /p_retired text\[\] := array\['BETDESK'\]/.test(fs.readFileSync(path.join(PG.ROOT, 'supabase', 'referral_codes.sql'), 'utf8')));

const db = PG.start('connor');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const DAY = 86400;
// Stripe's month arithmetic for anchors that need no end-of-month clamping
function addMonths(sec, n) { const d = new Date(sec * 1000); d.setUTCMonth(d.getUTCMonth() + n); return Math.floor(d.getTime() / 1000); }
const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

let seq = 0;
/* one Stripe delivery, stored the way the webhook stores it (the WHOLE event);
   a redelivery of the same id is an upsert, as billing_record_event does */
function event(type, obj, o) {
  const opt = o || {};
  const id = opt.id || 'evt_c' + (++seq);
  const created = opt.created || Math.floor(Date.now() / 1000);
  const ev = { id, object: 'event', type, created, livemode: opt.live !== false, data: { object: obj } };
  const sub = obj.subscription || (type.indexOf('customer.subscription') === 0 ? obj.id : null);
  db.service(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
    values (${PG.lit(id)}, ${PG.lit(type)}, to_timestamp(${created}), ${PG.lit(obj.customer || null)}, ${PG.lit(sub)},
            ${opt.user ? PG.lit(opt.user) : 'null'}, ${PG.lit(JSON.stringify(ev))}::jsonb)
    on conflict (id) do update set payload = excluded.payload, user_id = coalesce(excluded.user_id, public.stripe_events.user_id);`);
  return id;
}
const one = (sql) => db.service(sql);
const json = (sql) => JSON.parse(db.service(sql) || 'null');

/* a subscription Stripe created through Connor's checkout */
function subscriptionObj(f) {
  return Object.assign({
    object: 'subscription', status: 'trialing', livemode: f.live !== false, created: f.start, start_date: f.start,
    trial_start: f.start, trial_end: f.start + 7 * DAY, cancel_at_period_end: false,
    discount: f.promo ? { object: 'discount', id: 'di_' + f.id, promotion_code: f.promo, start: f.start, end: addMonths(f.start, 3),
      coupon: { id: 'coupon_test', object: 'coupon', percent_off: 10, duration: 'repeating', duration_in_months: 3, valid: true } } : null,
    discounts: f.promo ? ['di_' + f.id] : [],
    metadata: Object.assign({ supabase_user_id: f.user }, f.meta || {}),
    items: { object: 'list', data: [{ id: 'si_' + f.id, price: { id: 'price_monthly', unit_amount: 4999 } }] },
  }, { id: f.id, customer: f.customer });
}
/* an invoice on Stripe's clock: the period it pays for, paid an hour after it opens */
function invoiceObj(f) {
  const o = {
    id: f.id, object: 'invoice', customer: f.customer, subscription: f.sub, amount_paid: f.amount, currency: 'usd',
    livemode: f.live !== false, billing_reason: f.reason || 'subscription_cycle',
    status: 'paid', status_transitions: { paid_at: f.periodStart + 3600, finalized_at: f.periodStart + 3600 },
    lines: { object: 'list', data: [{ id: 'il_' + f.id, object: 'line_item', amount: f.amount - (f.tax || 0),
      period: { start: f.periodStart, end: addMonths(f.periodStart, 1) } }] },
  };
  if (f.amount > 0) { o.charge = 'ch_' + f.id; o.payment_intent = 'pi_' + f.id; }
  if (f.taxShape === 'total_taxes') o.total_taxes = [{ amount: f.tax, tax_behavior: 'exclusive' }];
  else if (f.tax != null) o.tax = f.tax;
  return o;
}
const commissionsFor = (inv) => one(`select coalesce(string_agg(kind || ':' || amount_cents, ',' order by id), '') from public.affiliate_commissions where stripe_invoice_id = ${PG.lit(inv)};`);

const U = {
  a: '00000000-0000-4000-8000-0000000000a1',   // Connor's customer, live
  b: '00000000-0000-4000-8000-0000000000b1',   // promo id not yet registered: metadata decides
  c: '00000000-0000-4000-8000-0000000000c1',   // returning customer
  c2: '00000000-0000-4000-8000-0000000000c2',  // had a trial once, never paid
  d: '00000000-0000-4000-8000-0000000000d1',   // test mode
  e: '00000000-0000-4000-8000-0000000000e1',   // no code at all
  f: '00000000-0000-4000-8000-0000000000f1',   // typed CONNOR10 on Stripe's page, nothing else
};
const PROMO_LIVE = 'promo_LiveConnor10', PROMO_TEST = 'promo_TestConnor10';

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql'].forEach((f) => db.applyFile(path.join(PG.ROOT, 'supabase', f)));
  let out = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'affiliates.sql'));
  chk('affiliates.sql applies and every report row says ok', !/CHECK THIS/.test(out), out.slice(-900));
  out = db.applyFileAtomic(SEED);
  chk('affiliate_connor.sql applies and every report row says ok', !/CHECK THIS/.test(out), out);
  out = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'affiliates.sql'));
  chk('affiliates.sql re-applies over a seeded program', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFileAtomic(SEED);
  chk('and the seed re-applies, changing nothing', !/CHECK THIS/.test(out)
    && one(`select count(*) from public.affiliate_accounts where slug = 'connor';`) === '1'
    && one(`select count(*) from public.affiliate_campaigns where upper(code) = 'CONNOR10';`) === '1');
  out = db.applyFile(path.join(PG.ROOT, 'supabase', 'referral_codes.sql'));
  chk('referral_codes.sql labels CONNOR10 as Connor\'s, and re-applies', /ok/.test(out)
    && one(`select partner_name || '|' || (retired_at is null) from public.referral_codes where code = 'CONNOR10';`) === 'Connor|true');

  /* ── the affiliates view: the spec's columns, service role only ────────── */
  const row = json(`select row_to_json(a) from public.affiliates a where slug = 'connor';`);
  chk('public.affiliates has Connor: slug, name, code, 20%, 12 months, active, no Stripe id yet',
    row && row.slug === 'connor' && row.display_name === 'Connor' && row.promo_code === 'CONNOR10' && +row.commission_rate === 0.2
      && row.earning_months === 12 && row.active === true && row.stripe_promotion_code_id === null && !!row.id && !!row.created_at, row);
  let err = db.mustFail(() => db.anon(`select count(*) from public.affiliates;`));
  chk('anon cannot read public.affiliates', !!err && /permission denied/.test(err), err);
  err = db.mustFail(() => db.as(U.a, `select count(*) from public.affiliates;`));
  chk('a signed-in reader cannot read public.affiliates', !!err && /permission denied/.test(err), err);
  err = db.mustFail(() => db.as(U.a, `select count(*) from public.affiliate_accounts where slug = 'connor';`));
  chk('a reader sees no creator rows (Connor has no login)', err === null && db.as(U.a, `select count(*) from public.affiliate_accounts;`) === '0');
  err = db.mustFail(() => db.as(U.a, `select count(*) from public.affiliate_campaigns;`));
  chk('a reader cannot read campaigns', !!err && /permission denied/.test(err));

  db.sql(`insert into auth.users (id, email, created_at) values
    ('${U.a}','a@example.com', now()), ('${U.b}','b@example.com', now()), ('${U.c}','c@example.com', now() - interval '200 days'),
    ('${U.c2}','c2@example.com', now() - interval '90 days'), ('${U.d}','d@example.com', now()), ('${U.e}','e@example.com', now()),
    ('${U.f}','f@example.com', now());`);

  /* ── the checkout's doors ─────────────────────────────────────────────── */
  let cc = json(`select public.affiliate_checkout_code('connor10', '${U.a}', true);`);
  chk('checkout: CONNOR10 is a live campaign of the creator "connor", no promotion code registered yet',
    cc.ok === true && cc.slug === 'connor' && cc.code === 'CONNOR10' && cc.promotion_code_id === null, cc);
  chk('checkout: an unknown code is refused', json(`select public.affiliate_checkout_code('NOPE99', '${U.a}', true);`).ok === false);
  chk('checkout: the promotion code from the env registers on the campaign once',
    one(`select public.affiliate_register_promotion_code('${cc.campaign_id}', '${PROMO_LIVE}', true);`) === 'registered'
    && one(`select public.affiliate_register_promotion_code('${cc.campaign_id}', '${PROMO_LIVE}', true);`) === 'same');
  chk('checkout: a different live id is a conflict, never an overwrite',
    one(`select public.affiliate_register_promotion_code('${cc.campaign_id}', 'promo_SomethingElse', true);`) === 'conflict'
    && one(`select stripe_promotion_code_id from public.affiliate_campaigns where id = '${cc.campaign_id}';`) === PROMO_LIVE);
  chk('checkout: test mode registers its own id beside the live one',
    one(`select public.affiliate_register_promotion_code('${cc.campaign_id}', '${PROMO_TEST}', false);`) === 'registered'
    && json(`select public.affiliate_checkout_code('CONNOR10', '${U.d}', false);`).promotion_code_id === PROMO_TEST
    && json(`select public.affiliate_checkout_code('CONNOR10', '${U.a}', true);`).promotion_code_id === PROMO_LIVE);
  chk('checkout: a malformed id is refused', one(`select public.affiliate_register_promotion_code('${cc.campaign_id}', 'bogus', true);`) === 'invalid');
  err = db.mustFail(() => db.as(U.a, `select public.affiliate_checkout_code('CONNOR10', '${U.a}', true);`));
  chk('checkout: the door is not callable by a client', !!err && /permission denied/.test(err), err);
  err = db.mustFail(() => db.anon(`select public.affiliate_register_promotion_code('${cc.campaign_id}', 'promo_x', true);`));
  chk('checkout: nor is registration', !!err && /permission denied/.test(err), err);

  /* ── a click is counted, never claimed ─────────────────────────────────── */
  chk('a ?ref=CONNOR10 click is counted', JSON.parse(db.anon(`select public.affiliate_track_click('connor10','visitor_connor_0000000001','/','x.com');`)).ok === true);
  const claim = JSON.parse(db.as(U.a, `select public.affiliate_claim('CONNOR10','visitor_connor_0000000001');`));
  chk('a link claim never attributes a checkout-only creator', claim.ok === false && claim.reason === 'attributed_at_checkout', claim);
  chk('so nothing is attributed before the sale', one(`select count(*) from public.affiliate_attributions;`) === '0');

  /* ── customer A: the full deal on a simulated test clock ───────────────── */
  const START = Math.floor(Date.UTC(2026, 9, 20, 15, 0, 0) / 1000);   // 2026-10-20 15:00 UTC, trial starts
  const TRIAL_END = START + 7 * DAY;                                   // 2026-10-27, first paid period
  const CUS_A = 'cus_TQx8Kd1aZ9';
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, price_id)
       values ('${U.a}','trialing','${CUS_A}','sub_A','price_monthly');`);
  event('customer.subscription.created', subscriptionObj({ id: 'sub_A', customer: CUS_A, user: U.a, start: START, promo: PROMO_LIVE,
    meta: { affiliate: 'connor', affiliate_code: 'CONNOR10' } }), { user: U.a, created: START });
  const at = json(`select row_to_json(x) from (select a.source, a.code, a.term_rate, a.term_type, a.term_months, a.attributed_at is not null as dated,
      ac.slug from public.affiliate_attributions a join public.affiliate_accounts ac on ac.id = a.affiliate_id where a.user_id = '${U.a}') x;`);
  chk('A: attributed to Connor by the promotion-code id, on Connor\'s campaign terms (20%, recurring, 12 months)',
    at && at.slug === 'connor' && at.source === 'promo_code' && at.code === 'CONNOR10' && +at.term_rate === 0.2
      && at.term_type === 'recurring' && at.term_months === 12 && at.dated, at);
  event('checkout.session.completed', { id: 'cs_A', object: 'checkout.session', mode: 'subscription', customer: CUS_A, subscription: 'sub_A',
    client_reference_id: U.a, metadata: { supabase_user_id: U.a, affiliate: 'connor', affiliate_code: 'CONNOR10' },
    discounts: [{ coupon: 'coupon_test', promotion_code: PROMO_LIVE }], livemode: true }, { user: U.a, created: START + 5 });
  chk('A: a later event never re-attributes or duplicates', one(`select count(*) from public.affiliate_attributions where user_id = '${U.a}';`) === '1');

  event('invoice.paid', invoiceObj({ id: 'in_A0', customer: CUS_A, sub: 'sub_A', amount: 0, periodStart: START, reason: 'subscription_create' }),
    { user: U.a, created: START + 10 });
  chk('A: the $0 trial invoice earns nothing', commissionsFor('in_A0') === '' && one(`select count(*) from public.affiliate_commissions;`) === '0');

  const invoices = [], invEvents = [];
  for (let k = 1; k <= 13; k++) {
    const ps = addMonths(TRIAL_END, k - 1);
    const discounted = k <= 3;
    const f = { id: 'in_A' + k, customer: CUS_A, sub: 'sub_A', amount: discounted ? 4499 : 4999, periodStart: ps };
    if (k === 2) { f.amount = 4499 + 360; f.tax = 360; f.taxShape = 'total_taxes'; }   // Stripe Tax, newer API shape
    if (k === 3) { f.amount = 4499 + 315; f.tax = 315; }                                // older API shape
    invoices.push(f);
    invEvents.push(event('invoice.paid', invoiceObj(f), { user: k === 5 ? null : U.a, created: ps + 3700 }));   // #5 arrives unresolved, as it can
  }
  const coms = invoices.map((f) => commissionsFor(f.id));
  chk('A: invoices 1-3 at $44.99 earn $9.00 each (tax excluded from the eligible amount)',
    coms[0] === 'accrual:900' && coms[1] === 'accrual:900' && coms[2] === 'accrual:900', coms.slice(0, 3));
  chk('A: invoice 4 at $49.99 earns $10.00', coms[3] === 'accrual:1000', coms[3]);
  chk('A: invoices 5-12 earn $10.00 each (one arrived without a user id and resolved through the customer)',
    coms.slice(4, 12).every((c) => c === 'accrual:1000'), coms.slice(4, 12));
  chk('A: invoice 13 starts 12 months after the first paid one and earns nothing',
    coms[12] === '' && one(`select kind from public.affiliate_conversions where stripe_invoice_id = 'in_A13';`) === 'renewal', coms[12]);
  chk('A: eligible amount is amount paid less tax, and the rate is 0.20',
    one(`select basis_cents || '|' || rate from public.affiliate_commissions where stripe_invoice_id = 'in_A2';`) === '4499|0.20'
    && one(`select basis_cents from public.affiliate_commissions where stripe_invoice_id = 'in_A3';`) === '4499');
  chk('A: the commission is dated by Stripe\'s paid_at (the invoice), not by the delivery',
    one(`select to_char(invoice_paid_at at time zone 'UTC', 'YYYY-MM-DD') from public.affiliate_commissions where stripe_invoice_id = 'in_A1';`) === iso(TRIAL_END));
  chk('A: twelve commissions in all, $117.00', one(`select count(*) || '|' || sum(amount_cents) from public.affiliate_commissions where user_id = '${U.a}';`) === '12|11700');

  /* ── retries: nothing twice ───────────────────────────────────────────── */
  const before = one(`select count(*) || '|' || sum(amount_cents) from public.affiliate_commissions;`);
  event('invoice.paid', invoiceObj(invoices[0]), { id: invEvents[0], user: U.a, created: TRIAL_END + 3700 });   // the same delivery again
  event('invoice.payment_succeeded', invoiceObj(invoices[0]), { user: U.a, created: TRIAL_END + 3701 });                // the same invoice, the other event type
  one(`update public.stripe_events set resolved = true where customer_id = '${CUS_A}';`);
  const rec = json(`select public.affiliate_reconcile(400);`);
  chk('a redelivered event, the twin event type and a full reconcile book nothing twice',
    one(`select count(*) || '|' || sum(amount_cents) from public.affiliate_commissions;`) === before && rec.events_replayed > 0, { before, rec });
  // a second accrual for in_A1 hung off another conversion (in_A13's, which earned nothing): only the per-invoice index can refuse it
  err = db.mustFail(() => one(`insert into public.affiliate_commissions (affiliate_id, user_id, conversion_id, stripe_invoice_id, kind, basis_cents, rate, amount_cents, eligible_at)
    select c.affiliate_id, c.user_id, (select id from public.affiliate_conversions where stripe_invoice_id = 'in_A13'), c.stripe_invoice_id, 'accrual',
           c.basis_cents, c.rate, c.amount_cents, now() from public.affiliate_commissions c where c.stripe_invoice_id = 'in_A1' and c.kind = 'accrual';`));
  chk('the database itself refuses a second accrual for one invoice', !!err && /affiliate_commissions_one_accrual_per_invoice/.test(err), err);

  /* ── refunds and disputes: negative rows, capped at the commission ─────── */
  // Basil-shaped charge: no `invoice` on it, matched by its charge / payment intent
  const REF1 = Math.floor(Date.UTC(2026, 11, 5, 12) / 1000), REF2 = REF1 + 3 * DAY, DSP = Math.floor(Date.UTC(2026, 11, 29, 12) / 1000);
  event('charge.refunded', { id: 'ch_in_A2', object: 'charge', customer: CUS_A, amount: 4859, amount_refunded: 2000, payment_intent: 'pi_in_A2', currency: 'usd', livemode: true }, { created: REF1 });
  chk('a partial refund books the commission\'s share of it ($9.00 x 2000/4859 = $3.70)', commissionsFor('in_A2') === 'accrual:900,clawback:-370', commissionsFor('in_A2'));
  event('charge.refunded', { id: 'ch_in_A2', object: 'charge', customer: CUS_A, amount: 4859, amount_refunded: 4859, payment_intent: 'pi_in_A2', currency: 'usd', livemode: true }, { created: REF2 });
  chk('refunding the rest books only what is new, and the two together are exactly the commission', commissionsFor('in_A2') === 'accrual:900,clawback:-370,clawback:-530', commissionsFor('in_A2'));
  event('charge.refunded', { id: 'ch_in_A2', object: 'charge', customer: CUS_A, amount: 4859, amount_refunded: 4859, payment_intent: 'pi_in_A2', currency: 'usd', livemode: true }, { created: REF2 + 60 });
  event('charge.dispute.created', { id: 'dp_A2', object: 'dispute', charge: 'ch_in_A2', payment_intent: 'pi_in_A2', amount: 4859, currency: 'usd', livemode: true }, { created: REF2 + 120 });
  chk('a redelivered refund and a dispute after a full refund take back nothing more (capped)', commissionsFor('in_A2') === 'accrual:900,clawback:-370,clawback:-530', commissionsFor('in_A2'));
  event('charge.dispute.created', { id: 'dp_A3', object: 'dispute', charge: 'ch_in_A3', payment_intent: 'pi_in_A3', amount: 4814, currency: 'usd', livemode: true }, { created: DSP });
  chk('a dispute (which names no customer) books a negative row for the disputed invoice', commissionsFor('in_A3') === 'accrual:900,clawback:-900', commissionsFor('in_A3'));
  event('charge.dispute.created', { id: 'dp_A3', object: 'dispute', charge: 'ch_in_A3', payment_intent: 'pi_in_A3', amount: 4814, currency: 'usd', livemode: true }, { created: DSP + 1 });
  // older-API charge that names its invoice, partial
  event('charge.refunded', { id: 'ch_in_A4', object: 'charge', customer: CUS_A, invoice: 'in_A4', amount: 4999, amount_refunded: 999, currency: 'usd', livemode: true }, { created: DSP + 2 });
  chk('a refund on the older API shape (charge.invoice) is matched too: $10.00 x 999/4999 = $2.00', commissionsFor('in_A4') === 'accrual:1000,clawback:-200', commissionsFor('in_A4'));
  chk('nothing is ever voided to do it', one(`select count(*) from public.affiliate_commissions where status = 'void';`) === '0');
  chk('the adjustment carries the invoice\'s customer and payment date',
    one(`select stripe_customer_id || '|' || to_char(invoice_paid_at at time zone 'UTC', 'YYYY-MM-DD') from public.affiliate_commissions where stripe_invoice_id = 'in_A3' and kind = 'clawback';`)
      === CUS_A + '|' + iso(addMonths(TRIAL_END, 2)));

  /* ── the monthly statement ─────────────────────────────────────────────── */
  const st = (m, live) => json(`select json_agg(s order by s.line) from public.affiliate_statement('connor', date '${m}'${live === false ? ', false' : ''}) s;`) || [];
  const oct = st('2026-10-01');
  chk('statement, October: one payment ($44.99 eligible, 20%, $9.00) and the total, due December 15',
    oct.length === 2 && oct[0].row_type === 'payment' && oct[0].eligible_amount_cents === 4499 && +oct[0].rate === 0.2
      && oct[0].commission_cents === 900 && oct[0].payment_date === iso(TRIAL_END) && oct[0].customer_last4 === '1aZ9'
      && oct[1].row_type === 'total' && oct[1].commission_cents === 900 && oct[0].payout_due === '2026-12-15', oct);
  chk('statement: the customer is only ever the last 4 characters', !JSON.stringify(st('2026-12-01')).includes(CUS_A) && !JSON.stringify(oct).includes('cus_'));
  const dec = st('2026-12-01');
  const decTotal = dec[dec.length - 1];
  chk('statement, December: the payment and the three adjustments booked that month, netted in the total',
    dec.filter((r) => r.row_type === 'payment').length === 1 && dec.filter((r) => r.row_type === 'adjustment').length === 4
      && decTotal.row_type === 'total' && decTotal.commission_cents === 900 - 370 - 530 - 900 - 200
      && decTotal.adjustment_cents === -(370 + 530 + 900 + 200) && decTotal.eligible_amount_cents === 4499 && decTotal.payout_due === '2027-02-15', dec);
  chk('statement: an adjustment names the date of the payment it came back from',
    dec.some((r) => r.row_type === 'adjustment' && r.invoice_paid_date === iso(addMonths(TRIAL_END, 1)) && r.adjustment_cents === -370 && r.eligible_amount_cents === null), dec);
  const empty = st('2028-03-01');
  chk('statement: a month with nothing is a zero total, never an error', empty.length === 1 && empty[0].commission_cents === 0 && empty[0].payout_due === '2028-05-15', empty);
  chk('statement: any day in the month names the month', JSON.stringify(st('2026-10-31')) === JSON.stringify(oct));
  err = db.mustFail(() => one(`select * from public.affiliate_statement('nobody', date '2026-10-01');`));
  chk('statement: an unknown creator is an error, not an empty month', !!err && /no creator with slug/.test(err), err);
  err = db.mustFail(() => db.as(U.a, `select * from public.affiliate_statement('connor', date '2026-10-01');`));
  chk('statement: no client can run it', !!err && /permission denied/.test(err), err);
  chk('statement: named arguments work as specified',
    one(`select count(*) from public.affiliate_statement(affiliate_slug => 'connor', month => date '2026-11-01');`) === '2');

  /* ── B: the promotion code isn't registered yet; the checkout's metadata decides ── */
  const CUS_B = 'cus_Bbbbbbbb';
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${U.b}','trialing','${CUS_B}','sub_B');`);
  event('customer.subscription.created', subscriptionObj({ id: 'sub_B', customer: CUS_B, user: U.b, start: START, promo: 'promo_NotRegisteredYet',
    meta: { affiliate: 'connor', affiliate_code: 'CONNOR10' } }), { user: U.b, created: START });
  chk('B: an unregistered promotion code falls back to metadata.affiliate, on the campaign\'s terms',
    one(`select a.source || '|' || a.code || '|' || a.term_rate from public.affiliate_attributions a where a.user_id = '${U.b}';`) === 'metadata|CONNOR10|0.20');

  /* ── C: a returning customer is never attributed ───────────────────────── */
  const CUS_C = 'cus_Cccccccc';
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, created_at) values ('${U.c}','canceled','${CUS_C}','sub_C_old', now() - interval '180 days');`);
  event('invoice.paid', invoiceObj({ id: 'in_C_old', customer: CUS_C, sub: 'sub_C_old', amount: 4999, periodStart: START - 150 * DAY }), { user: U.c, created: START - 150 * DAY });
  chk('C: the checkout will not apply the code for a customer who has paid before',
    json(`select public.affiliate_checkout_code('CONNOR10', '${U.c}', true);`).reason === 'returning_customer');
  one(`update public.subscriptions set status = 'trialing', stripe_subscription_id = 'sub_C_new' where user_id = '${U.c}';`);
  event('customer.subscription.created', subscriptionObj({ id: 'sub_C_new', customer: CUS_C, user: U.c, start: START, promo: PROMO_LIVE,
    meta: { affiliate: 'connor', affiliate_code: 'CONNOR10' } }), { user: U.c, created: START });
  event('invoice.paid', invoiceObj({ id: 'in_C1', customer: CUS_C, sub: 'sub_C_new', amount: 4499, periodStart: TRIAL_END }), { user: U.c, created: TRIAL_END + 3700 });
  chk('C: and even with Connor\'s promotion code on the new subscription, a returning customer is not attributed and earns nothing',
    one(`select count(*) from public.affiliate_attributions where user_id = '${U.c}';`) === '0' && commissionsFor('in_C1') === '');
  const c2claim = JSON.parse(db.as(U.c, `select public.affiliate_claim('CONNOR10', null);`));
  chk('C: nor can a link claim reach them', c2claim.ok === false, c2claim);

  /* C2: a trial that never converted is not a payment */
  const CUS_C2 = 'cus_C2c2c2c2';
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${U.c2}','trialing','${CUS_C2}','sub_C2_new');`);
  event('invoice.paid', invoiceObj({ id: 'in_C2_old', customer: CUS_C2, sub: 'sub_C2_old', amount: 0, periodStart: START - 60 * DAY, reason: 'subscription_create' }), { user: U.c2, created: START - 60 * DAY });
  event('customer.subscription.created', subscriptionObj({ id: 'sub_C2_new', customer: CUS_C2, user: U.c2, start: START, promo: PROMO_LIVE,
    meta: { affiliate: 'connor' } }), { user: U.c2, created: START });
  chk('C2: someone whose earlier trial never charged them is still a first-time customer',
    one(`select source from public.affiliate_attributions where user_id = '${U.c2}';`) === 'promo_code');

  /* ── D: test mode is processed, flagged, and kept out of the statement ── */
  const CUS_D = 'cus_test_Dddd';
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${U.d}','trialing','${CUS_D}','sub_D');`);
  event('customer.subscription.created', subscriptionObj({ id: 'sub_D', customer: CUS_D, user: U.d, start: START, promo: PROMO_TEST, live: false,
    meta: { affiliate: 'connor', affiliate_code: 'CONNOR10' } }), { user: U.d, created: START, live: false });
  event('invoice.paid', invoiceObj({ id: 'in_D1', customer: CUS_D, sub: 'sub_D', amount: 4499, periodStart: TRIAL_END, live: false }), { user: U.d, created: TRIAL_END + 3700, live: false });
  chk('D: a test-mode sale is attributed by the TEST promotion code and its commission is flagged as test',
    one(`select source from public.affiliate_attributions where user_id = '${U.d}';`) === 'promo_code'
    && one(`select amount_cents || '|' || livemode from public.affiliate_commissions where stripe_invoice_id = 'in_D1';`) === '900|false');
  chk('D: the statement leaves test mode out, and shows only test mode when asked',
    !st('2026-10-01').some((r) => r.customer_last4 === 'Dddd')
    && st('2026-10-01', false).filter((r) => r.row_type === 'payment').map((r) => r.customer_last4).join() === 'Dddd');

  /* ── E: no code, no attribution ──────────────────────────────────────── */
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values ('${U.e}','trialing','cus_Eeeeeeee','sub_E');`);
  event('customer.subscription.created', subscriptionObj({ id: 'sub_E', customer: 'cus_Eeeeeeee', user: U.e, start: START }), { user: U.e, created: START });
  event('invoice.paid', invoiceObj({ id: 'in_E1', customer: 'cus_Eeeeeeee', sub: 'sub_E', amount: 4999, periodStart: TRIAL_END }), { user: U.e, created: TRIAL_END + 3700 });
  chk('E: a subscription with no code and no stamp is nobody\'s', one(`select count(*) from public.affiliate_attributions where user_id = '${U.e}';`) === '0'
    && commissionsFor('in_E1') === '');

  /* ── F: CONNOR10 typed on Stripe's page — only the webhook's named code ── */
  one(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, referral_code) values ('${U.f}','trialing','cus_Ffffffff','sub_F','CONNOR10');`);
  event('invoice.paid', invoiceObj({ id: 'in_F1', customer: 'cus_Ffffffff', sub: 'sub_F', amount: 4499, periodStart: TRIAL_END }), { user: U.f, created: TRIAL_END + 3700 });
  chk('F: the code the webhook named on the subscription still credits Connor', one(`select source || '|' || code from public.affiliate_attributions where user_id = '${U.f}';`) === 'promo_code|CONNOR10'
    && commissionsFor('in_F1') === 'accrual:900');

  /* ── switching Connor off ─────────────────────────────────────────────── */
  one(`update public.affiliate_campaigns set active = false where upper(code) = 'CONNOR10';`);
  chk('a switched-off campaign: the checkout applies nothing', json(`select public.affiliate_checkout_code('CONNOR10', '${U.e}', true);`).ok === false
    && json(`select row_to_json(a) from public.affiliates a where slug = 'connor';`).active === false);
  event('invoice.paid', invoiceObj({ id: 'in_A14', customer: CUS_A, sub: 'sub_A', amount: 4999, periodStart: addMonths(TRIAL_END, 1) + 3 * DAY }), { user: U.a, created: TRIAL_END + 40 * DAY });
  chk('and customers already attributed keep earning on their own terms', commissionsFor('in_A14') === 'accrual:1000');
  out = db.applyFileAtomic(SEED);
  chk('re-running the seed never switches an admin\'s decision back on',
    one(`select active from public.affiliate_campaigns where upper(code) = 'CONNOR10';`) === 'f' && /CHECK THIS/.test(out));
  one(`update public.affiliate_campaigns set active = true where upper(code) = 'CONNOR10';`);

  /* the money is still never edited or deleted */
  err = db.mustFail(() => one(`update public.affiliate_commissions set invoice_paid_at = now() where stripe_invoice_id = 'in_A1';`));
  chk('a commission\'s invoice date cannot be edited either', !!err && /never edited/.test(err), err);
} catch (e) {
  chk('the live suite ran without an unexpected error', false, String(e.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
