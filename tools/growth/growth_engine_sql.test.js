#!/usr/bin/env node
/* ===========================================================================
   THE OWNER'S ACQUISITION REPORT (supabase/growth_engine.sql), on a real
   PostgreSQL with Supabase's default grants.

     A  INSTALL: applies after its chain, twice, every report row ok; the
        cron file's guard names what it needs.
     B  WHO MAY READ IT: not anon, not a signed-in reader; an operator may.
        The builder, the revenue helpers and the snapshot have no client door.
     C  CHANNELS: a search visit that read an article and then signed up is
        SEARCH, end to end (acq_track_visit → acq_claim); a newsletter link
        is NEWSLETTER; an outbound link is OUTBOUND_EMAIL — each with its
        signups, trials, paid conversions and cash.
     D  MRR is measured from Stripe's price on file: comps and test-mode are
        never revenue, an unpriced subscription is counted not guessed, a
        recurring coupon moves only the *_estimate figure, trials only the
        trial estimate.
     E  PAGES, TOOLS, CTAs and the NEWSLETTER are read from the first-party
        events and the subscriber table.
     F  SEARCH CONSOLE: "not connected" until rows exist; then totals, the
        impression-weighted position and the top pages and queries.
     G  REFERRALS: attributions by code, and a browser that claimed two
        attributed accounts is FLAGGED — and nothing in the ledger changes.
     H  THE WEEKLY SNAPSHOT is server-side only, frozen once, readable by an
        operator.

   Run: node tools/growth/growth_engine_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('growth engine SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_engine.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const CRON = fs.readFileSync(path.join(PG.ROOT, 'supabase', 'growth_engine_cron.sql'), 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL) && !/^\\/m.test(CRON));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL));
chk('additive: nothing is dropped', !/\bdrop (table|column|function)\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('it never writes to the affiliate ledger or a subscription',
  !/(insert into|update|delete from)\s+public\.(affiliate_|subscriptions|stripe_events)/i.test(SQL));
chk('the weekly job sends nothing out of the database', !/net\.http|resend|http_post/i.test(CRON));

const db = PG.start('gengine');
if (db.skip) { console.log('SKIP | growth engine SQL | ' + db.skip); process.exit(T.done()); }

const J = (s) => JSON.parse(s);
const U = {
  admin: '00000000-0000-0000-0000-0000000000ad', reader: '00000000-0000-0000-0000-0000000000a1',
  s1: '00000000-0000-0000-0000-0000000000b1', n1: '00000000-0000-0000-0000-0000000000b2', o1: '00000000-0000-0000-0000-0000000000b3',
  comp: '00000000-0000-0000-0000-0000000000b4', coup: '00000000-0000-0000-0000-0000000000b5', test: '00000000-0000-0000-0000-0000000000b6',
  nop: '00000000-0000-0000-0000-0000000000b7', creator: '00000000-0000-0000-0000-0000000000c1',
  ref1: '00000000-0000-0000-0000-0000000000c2', ref2: '00000000-0000-0000-0000-0000000000c3'
};
let seq = 0;
function event(type, obj, userId, live) {
  const id = 'evt_ge' + (++seq);
  const ev = { id, type, created: Math.floor(Date.now() / 1000) - 60, livemode: live !== false, data: { object: obj } };
  db.service(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
    values ('${id}','${type}', to_timestamp(${ev.created}), ${PG.lit(obj.customer || null)},
            ${PG.lit(obj.subscription || (type.indexOf('customer.subscription') === 0 ? obj.id : null))},
            ${userId ? "'" + userId + "'" : 'null'}, ${PG.lit(JSON.stringify(ev))}::jsonb);`);
}
const subObj = (id, cust, status, cents, extra) => Object.assign({ id, customer: cust, status,
  items: { data: [{ quantity: 1, price: { id: 'price_4999', unit_amount: cents, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } }, extra || {});
/* a visitor arriving with a touch, then the account claiming it */
const visit = (vid, touch) => db.anon(`select public.acq_track_visit(${PG.lit(vid)}, ${PG.lit(JSON.stringify(touch))}::jsonb);`);
const claim = (uid, vid) => db.as(uid, `select public.acq_claim(${PG.lit(vid)}, null, null);`);
const track = (vid, events) => db.anon(`select public.ed_track(${PG.lit(JSON.stringify(events))}::jsonb, ${PG.lit(vid)}, 'sess_${vid.slice(0, 12)}');`);

try {
  /* ══ A. INSTALL ═══════════════════════════════════════════════════════ */
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql',
    'site_articles.sql', 'newsletter.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  let rep = db.applyFileAtomic(FILE);
  chk('A the migration applies after its chain', true);
  chk('A every report row says ok', !/CHECK THIS/.test(rep), rep);
  rep = db.applyFileAtomic(FILE);
  chk('A and again, unchanged', !/CHECK THIS/.test(rep));
  /* growth.sql re-run afterwards keeps the widened source list */
  db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'growth.sql'));
  rep = db.applyFileAtomic(FILE);
  chk('A re-running growth.sql afterwards keeps the new sources', !/CHECK THIS/.test(rep), rep);
  const cronErr = db.mustFail(() => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'growth_engine_cron.sql')));
  chk('A the cron file refuses, by name, where pg_cron is not installed', !!cronErr && /pg_cron/i.test(cronErr), cronErr && cronErr.slice(0, 200));

  db.sql(`insert into auth.users (id, email, created_at) values
    ('${U.admin}','owner@example.com', now() - interval '300 days'), ('${U.reader}','reader@example.com', now() - interval '30 days'),
    ('${U.comp}','comp@example.com', now() - interval '3 days'),
    ('${U.coup}','coup@example.com', now() - interval '3 days'), ('${U.test}','test@example.com', now() - interval '3 days'),
    ('${U.nop}','nop@example.com', now() - interval '3 days'), ('${U.creator}','creator@example.com', now() - interval '90 days'),
    ('${U.ref1}','ref1@example.com', now() - interval '2 days'), ('${U.ref2}','ref2@example.com', now() - interval '2 days');
    insert into public.affiliate_admins (user_id) values ('${U.admin}');`);

  /* ══ B. WHO MAY READ IT ═════════════════════════════════════════════════ */
  let err = db.mustFail(() => db.anon(`select public.growth_admin_acquisition(30);`));
  chk('B anon cannot read the report', !!err && /permission denied/.test(err), err);
  err = db.mustFail(() => db.as(U.reader, `select public.growth_admin_acquisition(30);`));
  chk('B a signed-in reader cannot read the report', !!err && /not an admin|insufficient/.test(err), err);
  ['growth_acquisition_payload(now(), now())', 'growth_mrr()', 'growth_invoice_payments()', 'growth_weekly_snapshot()',
    `growth_referral_flags(now(), now())`].forEach((f) => {
    const e = db.mustFail(() => db.as(U.reader, `select public.${f};`));
    chk('B no client door to ' + f.split('(')[0], !!e && /permission denied|server-side/.test(e), e);
  });
  let out = J(db.as(U.admin, `select public.growth_admin_acquisition(30);`));
  chk('B an operator reads it', out.schema === 'edgedesk_growth_acquisition/1' && out.window_days === 30, Object.keys(out));
  chk('B an empty project is a report of zeros, not an error', out.funnel.visitors === 0 && out.mrr.mrr_list_cents === 0 && out.search.connected === false, out.funnel);

  /* ══ C. CHANNELS, end to end ════════════════════════════════════════════ */
  const V = { s1: 'visitor_search_0001xx', n1: 'visitor_newsl_0002xx', o1: 'visitor_outbd_0003xx', d1: 'visitor_direct_004xx' };
  /* Google → an article; then the landing page (internal referrer = direct, which never overwrites) */
  visit(V.s1, { referrer_host: 'www.google.com', landing: '/articles/ole-miss-vs-vanderbilt-2026/' });
  visit(V.s1, { referrer_host: 'edgedesksports.com', landing: '/' });
  visit(V.n1, { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'nl_cfb_20261012', landing: '/articles/college-football/' });
  visit(V.o1, { utm_source: 'outbound', utm_medium: 'email', utm_campaign: 'ob_abc123', landing: '/tools/fair-odds-calculator/' });
  visit(V.d1, { landing: '/' });
  /* the accounts are created AFTER the visits: acq_claim counts only touches
     made up to an hour after signup, never what an account did later */
  db.sql(`insert into auth.users (id, email) values ('${U.s1}','s1@example.com'), ('${U.n1}','n1@example.com'), ('${U.o1}','o1@example.com');`);
  claim(U.s1, V.s1); claim(U.n1, V.n1); claim(U.o1, V.o1);
  const src = (uid) => db.sql(`select first_source || '|' || coalesce(first_landing, '') from public.user_acquisition where user_id = '${uid}';`);
  chk('C a search visit that read an article first is SEARCH, landing on that article', src(U.s1) === 'search|/articles/ole-miss-vs-vanderbilt-2026/', src(U.s1));
  chk('C a newsletter link is NEWSLETTER', src(U.n1).split('|')[0] === 'newsletter', src(U.n1));
  chk('C an outbound link is OUTBOUND_EMAIL', src(U.o1).split('|')[0] === 'outbound_email', src(U.o1));

  /* Stripe: s1 trials and pays; n1 trials; o1 nothing; comp and test-mode are not revenue */
  db.service(`insert into public.subscriptions (user_id, status, price_id, stripe_customer_id, stripe_subscription_id) values
    ('${U.s1}','active','price_4999','cus_s1','sub_s1'), ('${U.n1}','trialing','price_4999','cus_n1','sub_n1'),
    ('${U.comp}','active','owner_comp',null,null), ('${U.coup}','active','price_4999','cus_coup','sub_coup'),
    ('${U.test}','active','price_4999','cus_test','sub_test'), ('${U.nop}','active','price_4999','cus_nop','sub_nop');`);
  event('customer.subscription.created', subObj('sub_s1', 'cus_s1', 'trialing', 4999, { trial_start: Math.floor(Date.now() / 1000) - 4 * 86400 }), U.s1);
  event('customer.subscription.updated', subObj('sub_s1', 'cus_s1', 'active', 4999), U.s1);
  event('invoice.paid', { id: 'in_s1', customer: 'cus_s1', subscription: 'sub_s1', amount_paid: 4999, currency: 'usd' }, U.s1);
  event('invoice.payment_succeeded', { id: 'in_s1', customer: 'cus_s1', subscription: 'sub_s1', amount_paid: 4999, currency: 'usd' }, U.s1);
  event('customer.subscription.created', subObj('sub_n1', 'cus_n1', 'trialing', 4999, { trial_start: Math.floor(Date.now() / 1000) - 2 * 86400 }), U.n1);
  event('invoice.paid', { id: 'in_n1_trial', customer: 'cus_n1', subscription: 'sub_n1', amount_paid: 0, currency: 'usd' }, U.n1);
  event('customer.subscription.updated', subObj('sub_coup', 'cus_coup', 'active', 4999, { discount: { coupon: { id: 'HALF', percent_off: 50, duration: 'forever' } } }), U.coup);
  event('customer.subscription.updated', subObj('sub_test', 'cus_test', 'active', 4999), U.test, false);
  /* sub_nop: active, but no price event on file */

  out = J(db.as(U.admin, `select public.growth_admin_acquisition(30);`));
  const ch = (k) => out.channels.find((c) => c.source === k) || {};
  chk('C search: one visitor, one signup, one trial, one paid, $49.99 collected',
    ch('search').visitors === 1 && ch('search').signups === 1 && ch('search').trials === 1 && ch('search').paid === 1 && ch('search').collected_cents === 4999, ch('search'));
  chk('C one invoice delivered twice is collected once', out.funnel.collected_cents === 4999, out.funnel);
  chk('C a $0 trial invoice is not a payment', ch('newsletter').collected_cents === 0 && ch('newsletter').paid === 0 && ch('newsletter').trials === 1, ch('newsletter'));
  chk('C outbound: the visit and the signup, nothing else', ch('outbound_email').visitors === 1 && ch('outbound_email').signups === 1 && ch('outbound_email').trials === 0, ch('outbound_email'));
  chk('C direct is counted as direct', ch('direct').visitors === 1, ch('direct'));
  chk('C landing pages carry what came of them',
    (out.landing_pages.find((l) => l.landing === '/articles/ole-miss-vs-vanderbilt-2026/') || {}).paid === 1, out.landing_pages);
  chk('C campaigns carry the newsletter edition and the outbound tag',
    out.campaigns.some((c) => c.campaign === 'nl_cfb_20261012' && c.trials === 1) && out.campaigns.some((c) => c.campaign === 'ob_abc123' && c.signups === 1), out.campaigns);
  chk('C revenue by channel is cash by first touch', out.revenue_by_channel.length === 1 && out.revenue_by_channel[0].source === 'search'
    && out.revenue_by_channel[0].collected_cents === 4999 && out.revenue_by_channel[0].payers === 1, out.revenue_by_channel);

  /* ══ D. MRR ═════════════════════════════════════════════════════════════ */
  const m = out.mrr;
  chk('D list MRR counts only priced, live, non-comp subscriptions: $49.99 + $49.99', m.mrr_list_cents === 9998, m);
  chk('D a recurring coupon moves only the estimate', m.mrr_net_cents_estimate === 4999 + 2500, m);
  chk('D a subscription with no price on file is counted, not guessed', m.paying_price_not_on_file === 1 && m.paying_subscriptions === 3, m);
  chk('D test mode is excluded and said to be', m.test_mode_excluded === 1, m);
  chk('D a trial adds only to the trial estimate', m.trialing === 1 && m.trial_mrr_list_cents_estimate === 4999, m);

  /* ══ E. PAGES, TOOLS, CTAs, NEWSLETTER ══════════════════════════════════ */
  track(V.s1, [{ event: 'public_page_view', props: { entity: 'article:ole-miss-vs-vanderbilt-2026', kind: 'article' }, page_path: '/articles/ole-miss-vs-vanderbilt-2026/' },
    { event: 'public_cta_clicked', props: { cta: 'article_trial_top' } }]);
  track(V.o1, [{ event: 'public_page_view', props: { entity: 'tool:fair-odds-calculator', kind: 'tool' } },
    { event: 'tool_used', props: { entity: 'fair_odds' } }, { event: 'newsletter_signup', props: { source: 'nl_tool_fair_odds' } }]);
  track(V.o1, [{ event: 'tool_used', props: { entity: 'fair_odds' } }]);   /* same session: deduplicated */
  db.service(`select public.newsletter_signup('nl1@example.com', true, false, 'nl_tool_fair_odds', 'ua', 'h1', true, true);`);
  out = J(db.as(U.admin, `select public.growth_admin_acquisition(30);`));
  chk('E article views are read from public_page_view', out.public_pages.some((p) => p.page === 'article:ole-miss-vs-vanderbilt-2026' && p.views === 1), out.public_pages);
  chk('E tool use, once per session, beside the tool page\'s views',
    out.tools.length === 1 && out.tools[0].tool === 'fair_odds' && out.tools[0].uses === 1 && out.tools[0].visitors === 1 && out.tools[0].page_views === 1, out.tools);
  chk('E calls to action by name', out.ctas.some((c) => c.cta === 'article_trial_top' && c.clicks === 1), out.ctas);
  chk('E newsletter: signups by source, topics, form submissions', out.newsletter.installed === true && out.newsletter.signups === 1
    && out.newsletter.by_source[0].source === 'nl_tool_fair_odds' && out.newsletter.form_submissions === 1, out.newsletter);
  chk('E the funnel counts public-page visitors apart from landing visitors', out.funnel.public_page_visitors === 2, out.funnel);

  /* ══ F. SEARCH CONSOLE ══════════════════════════════════════════════════ */
  db.service(`insert into public.search_console_pages (day, page, clicks, impressions, ctr, position) values
    (current_date - 2, 'https://edgedesksports.com/articles/ole-miss-vs-vanderbilt-2026/', 6, 200, 0.03, 8.0),
    (current_date - 2, 'https://edgedesksports.com/tools/no-vig-calculator/', 2, 600, 0.0033, 20.0);
    insert into public.search_console_queries (day, query, clicks, impressions, ctr, position) values (current_date - 2, 'no vig calculator', 2, 600, 0.0033, 20.0);
    insert into public.search_console_runs (site, start_day, end_day, pages, queries, ok) values ('sc-domain:edgedesksports.com', current_date - 3, current_date - 2, 2, 1, true);`);
  out = J(db.as(U.admin, `select public.growth_admin_acquisition(30);`));
  chk('F connected, with totals', out.search.connected === true && out.search.clicks === 8 && out.search.impressions === 800, out.search);
  chk('F position is impression-weighted', Number(out.search.avg_position) === 17, out.search.avg_position);
  chk('F top pages lead with clicks', out.search.top_pages[0].page.indexOf('/articles/') > 0 && out.search.top_queries[0].query === 'no vig calculator', out.search);
  err = db.mustFail(() => db.anon(`select * from public.search_console_pages;`));
  chk('F the imported data is not readable by anon', !!err && /permission denied/.test(err), err);

  /* ══ G. REFERRALS ═══════════════════════════════════════════════════════ */
  const before = db.sql(`select count(*) || '/' || coalesce(string_agg(status, ','), '') from public.affiliate_attributions;`);
  db.sql(`insert into public.affiliate_accounts (id, user_id, code, status) values ('00000000-0000-0000-0000-00000000aaaa', '${U.creator}', 'COACHX', 'active');
    insert into public.affiliate_attributions (user_id, affiliate_id, code, source, visitor_hash) values
      ('${U.ref1}', '00000000-0000-0000-0000-00000000aaaa', 'COACHX', 'link', 'same-browser-hash'),
      ('${U.ref2}', '00000000-0000-0000-0000-00000000aaaa', 'COACHX', 'link', 'same-browser-hash');`);
  const ledger = db.sql(`select count(*) || '/' || string_agg(status, ',') from public.affiliate_attributions;`);
  out = J(db.as(U.admin, `select public.growth_admin_acquisition(30);`));
  chk('G attributions by code', out.referrals.installed === true && out.referrals.by_code.some((c) => c.code === 'COACHX' && c.accounts === 2), out.referrals);
  chk('G one browser claiming two attributed accounts is flagged for review',
    out.referrals.flags.some((f) => f.kind === 'same_browser_multiple_accounts' && f.code === 'COACHX' && f.accounts === 2), out.referrals.flags);
  chk('G reading the report changes nothing in the ledger',
    db.sql(`select count(*) || '/' || string_agg(status, ',') from public.affiliate_attributions;`) === ledger && before === '0/');

  /* ══ H. THE WEEKLY SNAPSHOT ═════════════════════════════════════════════ */
  err = db.mustFail(() => db.as(U.admin, `select public.growth_weekly_snapshot();`));
  chk('H not from a browser, even an operator\'s', !!err && /permission denied|server-side/.test(err), err);
  let snap = J(db.service(`select public.growth_weekly_snapshot();`));
  chk('H the service role freezes last week', snap.ok === true && snap.state === 'frozen', snap);
  snap = J(db.service(`select public.growth_weekly_snapshot();`));
  chk('H once', snap.state === 'already_frozen', snap);
  const weeks = J(db.as(U.admin, `select public.growth_admin_weekly_reports(4);`));
  chk('H an operator reads the frozen weeks', weeks.length === 1 && !!weeks[0].funnel && !!weeks[0].mrr, weeks);
  err = db.mustFail(() => db.as(U.reader, `select public.growth_admin_weekly_reports(4);`));
  chk('H a reader cannot', !!err && /not an admin|insufficient/.test(err), err);
} catch (e) {
  chk('the suite reached its end — ' + String(e.message || e).split('\n').slice(0, 4).join(' | '), false);
} finally {
  db.stop();
}
process.exit(T.done());
