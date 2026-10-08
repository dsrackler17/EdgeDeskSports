#!/usr/bin/env node
/* ===========================================================================
   PHASE 10 — RESULTS: what came of the emails
   supabase/growth_outbound.sql (tag_links, the conversions record, the
   matcher, the results door). supabase/growth.sql's acquisition record and
   Stripe ledger are the real ones, fed here as the site and Stripe would.

     L  LINKS      a live email's EdgeDesk links carry its prospect's
                   campaign code; a test send's carry ob_test; punctuation,
                   fragments, other domains and existing utm_ tags are left
                   alone; the preview shows exactly what is sent; the send
                   row fixes it at claim; tagging can be turned off
     A  ACCOUNTS   an address that already has an EdgeDesk account is never
                   cold-emailed: not drafted for, not approved, not sent
     M  MATCH      a visit or an account counts only by the email's link or
                   the address written to, only after the first email went
                   out; never an owner's, never a test's, never a bounced
                   email's, never one that existed before; trial and payment
                   from Stripe's own record; each fact once
     X  ENDS       an account ends the sequence: contacted or replied becomes
                   converted, unsent follow-ups are cancelled, and a
                   follow-up claimed after the signup is refused; an opt-out
                   stays an opt-out
     T  TICK       the scheduler matches hourly, whatever the morning run is
                   doing; a failure is recorded and never stops the tick
     D  DOOR       the owner's results: pipeline, sends, people, rates, by
                   step, by writer / type / search / fit with 95% intervals,
                   by day, providers; a difference is called out only past
                   the minimum sample; no account, address or key leaves
     C  RECORD     conversions are written by the matcher only, never
                   rewritten, never readable by a client role
     S  STATS      the drafting stats count replies, not conversions

   Run: node tools/growth/outbound_analytics_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound analytics SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('goresults');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const pad = (n) => String(n).padStart(12, '0');
const pid = (n) => '10000000-0000-0000-0000-' + pad(n);
const did = (n) => '20000000-0000-0000-0000-' + pad(n);
const uid = (n) => '30000000-0000-0000-0000-' + pad(n);
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = ${lit(d)};`);
const approve = (d) => own(`select public.growth_outbound_draft_approve(${lit(d)}, ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim(${lit(d)});`);
const result = (s, id) => own(`select public.growth_outbound_send_result(${lit(s)}, ${lit(id)}, null, false);`);
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = ${lit(p)};`);
const dstatus = (d) => one(`select status from growth_outbound.drafts where id = ${lit(d)};`);
const token = (p) => one(`select attribution_token from growth_outbound.prospects where id = ${lit(p)};`);
const code = (p) => 'ob_' + token(p);
const tag = (t, c) => one(`select coalesce(growth_outbound.tag_links(${lit(t)}, ${lit(c)}), '<null>');`);
const sync = (p) => j(one(`select growth_outbound.sync_conversions(${p ? lit(p) : 'null'});`));
const convs = (p) => j(one(`select coalesce(jsonb_agg(stage || ':' || matched_by order by stage, matched_by), '[]') from growth_outbound.conversions
                             where prospect_id = ${lit(p)};`));
const nconv = (where) => +one(`select count(*) from growth_outbound.conversions${where ? ' where ' + where : ''};`);
const results = (days) => own(`select public.growth_outbound_analytics(${days === undefined ? 90 : days === null ? 'null' : days});`);
const card = (d) => own(`select public.growth_outbound_review_queue('pending_review', 100);`).rows.find((c) => c.draft.id === d);
const sched = () => j(one(`select to_jsonb(s) from growth_outbound.scheduler s where id = 1;`));
const tick = () => j(one(`select growth_outbound.schedule_tick('https://iattxbkbufslbauoumga.supabase.co/functions/v1/');`));

const LINK = 'https://edgedesksports.com/';
const BODY = (first) => 'Hi ' + first + ',\n\nYou can try EdgeDesk Sports free for 7 days at ' + LINK + ' (then $49.99/month).';
let mailN = 0;
/* a real prospect who clears every gate, with a first email that links to EdgeDesk */
function prospect(n, name, o) {
  const [first, last] = name.split(' ');
  const dom = (first + last).toLowerCase() + '.test';
  one(SEED.strong(Object.assign({ id: pid(n), name, org: last + ' Media', email: first.toLowerCase() + '@' + dom, domain: dom,
    handle: (first + last).toLowerCase() }, o || {}))
    + SEED.draft({ id: did(n), prospect: pid(n), subject: 'Your work, ' + first, body: BODY(first), test: !!(o && o.test) }));
  return first.toLowerCase() + '@' + dom;
}
/* … and the first email to them, approved, claimed and sent */
function contact(n) {
  const a = approve(did(n));
  if (!a.ok) throw new Error('approve ' + n + ': ' + JSON.stringify(a));
  const c = claim(did(n));
  if (!c.ok) throw new Error('claim ' + n + ': ' + JSON.stringify(c));
  const r = result(c.send_id, 'msg_live_' + (++mailN) + '_ok');
  if (!r.ok) throw new Error('result ' + n + ': ' + JSON.stringify(r));
  return c;
}
const account = (u, email, at) => one(`insert into auth.users (id, email, created_at) values (${lit(u)}, ${lit(email)}, ${at || 'now()'});`);
const acquired = (u, o) => one(`insert into public.user_acquisition (user_id, signup_at, first_source, first_utm_source, first_utm_medium, first_utm_campaign,
    first_seen_at, last_source, last_utm_source, last_utm_medium, last_utm_campaign, last_seen_at)
  values (${lit(u)}, now(), 'other', ${o.first ? "'outbound', 'email'" : 'null, null'}, ${lit(o.first || null)}, now(),
          'other', ${o.last ? "'outbound', 'email'" : 'null, null'}, ${lit(o.last || null)}, now());`);
let vis = 0;
const visit = (o) => one(`insert into public.acquisition_visitors (visitor_hash, first_source, first_utm_campaign, first_seen_at,
    last_source, last_utm_campaign, last_seen_at, user_id)
  values (${lit('vh' + (++vis) + 'x'.repeat(20))}, 'other', ${lit(o.first || null)}, ${o.firstAt || 'now()'}, 'other', ${lit(o.last || null)},
          ${o.lastAt || 'now()'}, ${lit(o.user || null)});`);
let sev = 0;
const stripe = (type, obj, user) => {
  const id = 'evt_ob' + (++sev);
  const ev = { id, type, created: Math.floor(Date.now() / 1000), data: { object: obj } };
  one(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
       values (${lit(id)}, ${lit(type)}, now(), ${lit(obj.customer || null)}, ${lit(obj.subscription || (type.startsWith('customer.subscription') ? obj.id : null))},
               ${lit(user)}, ${J(ev)});`);
};

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${OWNER}', 'owner@edgedesk.test', now(), now() - interval '1 year'),
         ('${ADMIN}', 'admin@edgedesk.test', now(), now() - interval '1 year'), ('${SUB}', 'sub@edgedesk.test', now(), now() - interval '1 year');
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  one(`select growth_outbound.set_webhook_secret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');`);
  chk('(setup) tagging is on by default', own(`select public.growth_outbound_settings();`).attribution_links === true);

  /* ══ L. LINKS ═════════════════════════════════════════════════════════ */
  const C = 'ob_0123456789abcdef0123456789abcdef';
  const Q = 'utm_source=outbound&utm_medium=email&utm_campaign=' + C;
  const CASES = [
    ['a link at the end of a sentence: the full stop stays outside', 'Try it at https://edgedesksports.com/.', 'Try it at https://edgedesksports.com/?' + Q + '.'],
    ['a bare domain gains its slash', 'at https://edgedesksports.com (then $49.99/month)', 'at https://edgedesksports.com/?' + Q + ' (then $49.99/month)'],
    ['www and a path, then a comma', 'see https://www.edgedesksports.com/research/sample, ok', 'see https://www.edgedesksports.com/research/sample?' + Q + ', ok'],
    ['an existing query is extended, and the fragment stays last', 'x https://edgedesksports.com/?ref=a#top! y', 'x https://edgedesksports.com/?ref=a&' + Q + '#top! y'],
    ['a link that already has a utm_ tag is left exactly as written', 'x https://edgedesksports.com/p?utm_source=x z', 'x https://edgedesksports.com/p?utm_source=x z'],
    ['capitals, and a query ending in &', 'HTTPS://EdgeDeskSports.com/A?b=1&', 'HTTPS://EdgeDeskSports.com/A?b=1&' + Q],
    ['http too', 'http://edgedesksports.com', 'http://edgedesksports.com/?' + Q],
    ['a port is not EdgeDesk\'s site: untouched', 'https://edgedesksports.com:443/x', 'https://edgedesksports.com:443/x'],
    ['a look-alike domain: untouched', 'https://edgedesksports.com.evil.test/x', 'https://edgedesksports.com.evil.test/x'],
    ['another domain that merely starts the same: untouched', 'https://edgedesksports.comx/', 'https://edgedesksports.comx/'],
    ['a subdomain: untouched', 'https://app.edgedesksports.com/x', 'https://app.edgedesksports.com/x'],
    ['every link in the text', 'two: https://edgedesksports.com/a and https://edgedesksports.com/b.', 'two: https://edgedesksports.com/a?' + Q + ' and https://edgedesksports.com/b?' + Q + '.'],
    ['inside quotes and brackets', 'q "https://edgedesksports.com/a" [https://edgedesksports.com/b]', 'q "https://edgedesksports.com/a?' + Q + '" [https://edgedesksports.com/b?' + Q + ']'],
    ['a path ending in a slash', 'https://edgedesksports.com/a/b/', 'https://edgedesksports.com/a/b/?' + Q],
    ['a mention without https:// is not a link: untouched', 'visit edgedesksports.com today', 'visit edgedesksports.com today'],
    ['no links: the text is unchanged', 'Hi Pat,\n\nThanks.', 'Hi Pat,\n\nThanks.'],
  ];
  CASES.forEach(([what, t, want]) => chk('L ' + what, tag(t, C) === want, tag(t, C)));
  chk('L a campaign code that is not ob_<letters and digits> changes nothing (never a way to inject a parameter)',
    tag('at https://edgedesksports.com/', 'ob_x&utm_x=1') === 'at https://edgedesksports.com/' && tag('at https://edgedesksports.com/', 'evil') === 'at https://edgedesksports.com/'
    && tag('at https://edgedesksports.com/', null) === 'at https://edgedesksports.com/' && one(`select growth_outbound.tag_links(null, 'ob_test') is null;`) === 't');
  chk('L the code: the prospect\'s token for a live message, ob_test for anything that goes to the owner\'s inbox, nothing for a malformed token',
    one(`select growth_outbound.link_campaign('0123456789abcdef0123456789abcdef', false);`) === C
    && one(`select growth_outbound.link_campaign('0123456789abcdef0123456789abcdef', true);`) === 'ob_test'
    && one(`select coalesce(growth_outbound.link_campaign('0123456789abcdef0123456789abcdef', null), '-');`) === 'ob_test'
    && one(`select coalesce(growth_outbound.link_campaign('not-a-token', false), '-');`) === '-');

  // in test mode (the default)
  const E1 = prospect(1, 'Pat Analyst');
  let c = card(did(1));
  chk('L test mode: the preview\'s link carries ob_test, never the prospect\'s code', c && c.preview.links_tagged === true
    && c.preview.text.indexOf(LINK + '?utm_source=outbound&utm_medium=email&utm_campaign=ob_test') > 0 && c.preview.text.indexOf(token(pid(1))) < 0, c && c.preview);
  chk('L … the body shown is the body sent, and the stored words are unchanged', c.preview.text.indexOf(c.preview.body) === 0
    && c.draft.body_text.indexOf('utm_') < 0);
  let r = approve(did(1));
  r = claim(did(1));
  chk('L a test send carries ob_test in its links, and its row says the links were tagged', r.ok === true && r.test === true
    && r.message.text.indexOf(LINK + '?utm_source=outbound&utm_medium=email&utm_campaign=ob_test') > 0
    && one(`select links_tagged from growth_outbound.sends where id = ${lit(r.send_id)};`) === 't', r);
  const S1 = r.send_id;
  chk('L … the footer\'s opt-out link is not tagged', /growth_outbound_optout\?t=[0-9a-f]{64}/.test(r.message.text)
    && !/optout\?t=[0-9a-f]{64}[?&]/.test(r.message.text), r.message.text.slice(-200));
  let e = db.mustFail(() => one(`update growth_outbound.sends set links_tagged = false where id = ${lit(S1)};`));
  chk('L a send records whether its links were tagged; nobody rewrites that', !!e && /only its delivery state may change/.test(e), e);
  result(S1, 'msg_test_send_01');

  // live
  r = settings({ test_mode: false, confirm_live: true, max_sends_per_day: 80, confirm_cap_increase: true });
  chk('(setup) live, with room for this suite\'s sends', r.ok === true, r);
  prospect(2, 'Kim Ratings');
  c = card(did(2));
  chk('L live: the preview\'s link carries this prospect\'s own code', c.preview.test === false
    && c.preview.text.indexOf(LINK + '?utm_source=outbound&utm_medium=email&utm_campaign=' + code(pid(2))) > 0, c.preview.text);
  r = settings({ attribution_links: false });
  c = card(did(2));
  chk('L tagging turned off: the preview shows the link exactly as written, and says so', r.ok === true && c.preview.links_tagged === false
    && c.preview.text.indexOf(LINK + ' (then') > 0 && c.preview.text.indexOf('utm_') < 0, c.preview);
  chk('L … the change is logged', +one(`select count(*) from growth_outbound.activity where action = 'settings_changed' and detail ? 'attribution_links';`) === 1);
  settings({ attribution_links: true });
  const C2 = contact(2);
  chk('L a live send carries the prospect\'s code, as Resend receives it', C2.message.text.indexOf(LINK + '?utm_source=outbound&utm_medium=email&utm_campaign=' + code(pid(2))) > 0
    && C2.message.text.indexOf('ob_test') < 0, C2.message.text);
  prospect(3, 'Lee Lines');
  approve(did(3));
  const C3 = claim(did(3));
  settings({ attribution_links: false });
  r = claim(did(3));
  chk('L a retry sends what was claimed: turning tagging off afterwards does not change a claimed message', r.ok === true && r.retry === true
    && r.message.text === C3.message.text && r.message.text.indexOf(code(pid(3))) > 0, r);
  settings({ attribution_links: true });
  result(C3.send_id, 'msg_live_lee_001');
  chk('(setup) Kim and Lee are contacted', pstatus(pid(2)) === 'contacted' && pstatus(pid(3)) === 'contacted');

  /* ══ A. ACCOUNTS ══════════════════════════════════════════════════════ */
  const E4 = prospect(4, 'Ana Bell');
  account(uid(4), E4, `now() - interval '30 days'`);
  c = card(did(4));
  chk('A the review card says the address already has an account', c.existing_account === true);
  r = approve(did(4));
  chk('A … and approving it is refused, with that reason', r.ok === false && r.reason === 'below_gate'
    && r.gates.includes('this address already has an EdgeDesk account'), r);
  chk('A … matching however the account\'s address is written', (() => {
    one(`update auth.users set email = ${lit(E4.toUpperCase())} where id = ${lit(uid(4))};`);
    const g = approve(did(4));
    one(`update auth.users set email = ${lit(E4)} where id = ${lit(uid(4))};`);
    return g.ok === false && g.gates.includes('this address already has an EdgeDesk account');
  })());
  one(SEED.strong({ id: pid(5), name: 'Kai Moss', org: 'Moss Models', email: 'kai@mossmodels.test', domain: 'mossmodels.test', handle: 'kaimoss' })
    + SEED.strong({ id: pid(6), name: 'Ola Reed', org: 'Reed Report', email: 'ola@reedreport.test', domain: 'reedreport.test', handle: 'olareed' }));
  account(uid(5), 'kai@mossmodels.test', `now() - interval '30 days'`);
  const due = j(one(`select coalesce(jsonb_agg(prospect_id), '[]') from growth_outbound.drafting_due();`));
  chk('A the drafting engine is never asked to write to someone with an account', !due.includes(pid(5)) && due.includes(pid(6)), due);
  const E7 = prospect(7, 'Vic Stone');
  approve(did(7));
  account(uid(7), E7);
  r = claim(did(7));
  chk('A an account made after approval: the send is refused by the database, and nothing is sent', r.ok === false && r.reason === 'refused'
    && /already has an EdgeDesk account/.test(r.detail) && +one(`select count(*) from growth_outbound.sends where draft_id = ${lit(did(7))};`) === 0, r);

  /* ══ M. MATCH ═════════════════════════════════════════════════════════ */
  const people = [[8, 'Uma Ward'], [9, 'Rae Quinn'], [10, 'Bo Dunn'], [11, 'Cy Park'], [12, 'Dee Fox'], [13, 'Eli Hart'], [14, 'Fay Lund'], [15, 'Gus Hale']];
  const EM = {};
  people.forEach(([n, name]) => { EM[n] = prospect(n, name); contact(n); });
  chk('(setup) eight more prospects contacted, live', people.every(([n]) => pstatus(pid(n)) === 'contacted'));
  const firstSent = (n) => one(`select min(sent_at) from growth_outbound.sends where prospect_id = ${lit(pid(n))} and not is_test;`);

  // visits
  visit({ first: code(pid(8)) });                                                                         // Uma: visited
  visit({ first: code(pid(8)), firstAt: `${lit(firstSent(8))}::timestamptz - interval '1 hour'` });       // before the email: no
  visit({ first: code(pid(8)), user: OWNER });                                                            // the owner's own click: no
  visit({ first: null, last: code(pid(2)) });                                                             // Kim, latest touch
  visit({ first: 'ob_test', last: 'ob_test' });                                                           // a test link: nobody's
  // accounts
  account(uid(2), 'kim.personal@mail.test'); acquired(uid(2), { first: code(pid(2)) });                  // Kim: link
  account(uid(3), 'lee@leelines.test');                                                                   // Lee: address
  own(`select public.growth_outbound_prospect_replied(${lit(pid(9))}, 'interested, will look', false);`);
  // Rae replied first, then signed up from the link
  account(uid(9), 'rae.q@mail.test'); acquired(uid(9), { last: code(pid(9)) });
  one(`update growth_outbound.sends set delivery_status = 'bounced', bounced_at = now() where prospect_id = ${lit(pid(10))};`);
  account(uid(10), EM[10]);                                                                               // Bo: the email bounced: no
  account(uid(11), 'cy.old@mail.test', `now() - interval '2 days'`); acquired(uid(11), { first: code(pid(11)) }); // existed before: no
  const tok12 = one(`select optout_token from growth_outbound.sends where prospect_id = ${lit(pid(12))};`);
  r = j(db.anon(`select public.growth_outbound_optout(${lit(tok12)}, true);`));
  chk('(setup) Dee opted out', r.ok === true && pstatus(pid(12)) === 'suppressed', r);
  account(uid(12), EM[12]);                                                                               // Dee: counts, stays opted out
  account(uid(20), 'owner2@edgedesk.test'); one(`update auth.users set email_confirmed_at = now() where id = ${lit(uid(20))};
    insert into public.affiliate_admins (user_id) values (${lit(uid(20))});
    select growth_outbound.grant_owner('owner2@edgedesk.test');`); acquired(uid(20), { first: code(pid(8)) }); // a new owner: no
  account(uid(21), 'owner-test@edgedesk.test');                                                            // the test inbox: nobody's
  account(uid(1), E1);                                                                                     // Pat only ever had a TEST email: no
  // Kim's trial and first payment, as Stripe reports them
  stripe('customer.subscription.created', { id: 'sub_kim', customer: 'cus_kim', status: 'trialing', trial_start: Math.floor(Date.now() / 1000) }, uid(2));
  stripe('invoice.paid', { id: 'in_kim_1', customer: 'cus_kim', subscription: 'sub_kim', amount_paid: 4999 }, uid(2));
  // a follow-up waiting for Kim, which her signup must cancel
  const proj2 = one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid(2))} and field_name = 'project' and superseded_at is null order by id limit 1;`);
  r = own(`select public.growth_outbound_draft_create(${lit(pid(2))}, ${J({ sequence_number: 2, subject: 'Following up', body_text: 'Hi Kim, following up on your CFB power ratings against the market.',
    claims: [{ text: 'your CFB power ratings against the market', evidence_id: +proj2 }] })});`);
  const F2 = r.draft_id;
  chk('(setup) a follow-up for Kim waits in review', r.ok === true && dstatus(F2) === 'pending_review', r);
  const before = nconv();
  r = sync();
  chk('M the matcher records what it found, by stage', r.new.visited === 2 && r.new.signed_up === 4 && r.new.trial === 1 && r.new.paid === 1 && before === 0, r);
  chk('M Kim: visited, signed up by her link, then trial and payment', JSON.stringify(convs(pid(2))) === JSON.stringify(['paid:link', 'signed_up:link', 'trial:link', 'visited:link']), convs(pid(2)));
  chk('M Lee: an account made with the address written to', JSON.stringify(convs(pid(3))) === JSON.stringify(['signed_up:address']), convs(pid(3)));
  chk('M Uma: one visit — not the one before the email, not the owner\'s', JSON.stringify(convs(pid(8))) === JSON.stringify(['visited:link']), convs(pid(8)));
  chk('M Rae: replied, then signed up by her link', JSON.stringify(convs(pid(9))) === JSON.stringify(['signed_up:link']), convs(pid(9)));
  chk('M Bo: an email that bounced reached nobody — no result from it', convs(pid(10)).length === 0);
  chk('M Cy: an account that existed before the email is not its result', convs(pid(11)).length === 0);
  chk('M Dee: opted out, then signed up — the signup counts', JSON.stringify(convs(pid(12))) === JSON.stringify(['signed_up:address']));
  chk('M nothing for the test prospect, the test inbox or a prospect never written to', convs(pid(1)).length === 0 && convs(pid(4)).length === 0
    && convs(pid(5)).length === 0 && convs(pid(6)).length === 0 && nconv(`prospect_id not in (${[2, 3, 8, 9, 12].map((n) => lit(pid(n))).join(',')})`) === 0);
  chk('M when: the account\'s own creation time; the trial and payment Stripe\'s', one(`select (select occurred_at from growth_outbound.conversions where prospect_id = ${lit(pid(3))} and stage = 'signed_up')
      = (select created_at from auth.users where id = ${lit(uid(3))});`) === 't');
  chk('M the account itself is not recorded: a one-way key, no user id, no address', nconv(`account_key !~ '^[0-9a-f]{64}$'`) === 0
    && one(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'growth_outbound' and table_name = 'conversions';`)
      === 'id,prospect_id,stage,matched_by,account_key,occurred_at,recorded_at'
    && nconv(`account_key = ${lit(uid(2))} or account_key like '%@%'`) === 0
    && +one(`select count(*) from growth_outbound.conversions c join auth.users u on c.account_key like '%' || replace(u.id::text, '-', '') || '%'
               or c.account_key like '%' || encode(convert_to(u.id::text, 'UTF8'), 'hex') || '%';`) === 0);
  const rows = nconv();
  r = sync();
  chk('M matching again finds nothing new: each fact is recorded once', JSON.stringify(r.new) === '{}' && r.converted === 0 && nconv() === rows, r);

  /* ══ X. AN ACCOUNT ENDS THE SEQUENCE ═══════════════════════════════════ */
  chk('X Kim, Lee and Rae (who had replied) are converted', pstatus(pid(2)) === 'converted' && pstatus(pid(3)) === 'converted' && pstatus(pid(9)) === 'converted');
  chk('X … saying how they were matched', /their email's link/.test(one(`select status_reason from growth_outbound.prospects where id = ${lit(pid(2))};`))
    && /the address we wrote to/.test(one(`select status_reason from growth_outbound.prospects where id = ${lit(pid(3))};`)));
  chk('X Kim\'s waiting follow-up is cancelled', dstatus(F2) === 'cancelled');
  chk('X Dee stays opted out; Uma (a visit only), Bo and Cy stay contacted', pstatus(pid(12)) === 'suppressed' && pstatus(pid(8)) === 'contacted'
    && pstatus(pid(10)) === 'contacted' && pstatus(pid(11)) === 'contacted');
  const logs = j(one(`select jsonb_agg(jsonb_build_object('who', actor_kind, 'p', prospect_id, 'd', detail) order by id) from growth_outbound.activity where action = 'prospect_converted';`));
  chk('X each conversion is logged by the system, with no account in it', logs.length === 3 && logs.every((l) => l.who === 'system')
    && !/@|30000000-/.test(JSON.stringify(logs)) && logs.find((l) => l.p === pid(2)).d.drafts_cancelled === 1, logs);
  chk('X a converted prospect stays converted when re-evaluated', own(`select public.growth_outbound_prospect_evaluate(${lit(pid(2))});`).status === 'converted');
  chk('X nothing more is due for them', !j(one(`select coalesce(jsonb_agg(prospect_id), '[]') from growth_outbound.drafting_due();`)).some((p) => [pid(2), pid(3), pid(9)].includes(p)));
  // a follow-up approved BEFORE the signup, claimed after it
  const proj13 = one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid(13))} and field_name = 'project' and superseded_at is null order by id limit 1;`);
  const F13 = own(`select public.growth_outbound_draft_create(${lit(pid(13))}, ${J({ sequence_number: 2, subject: 'Following up', body_text: 'Hi Eli, following up on your CFB power ratings against the market.',
    claims: [{ text: 'your CFB power ratings against the market', evidence_id: +proj13 }] })});`).draft_id;
  const proj14 = one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid(14))} and field_name = 'project' and superseded_at is null order by id limit 1;`);
  const F14 = own(`select public.growth_outbound_draft_create(${lit(pid(14))}, ${J({ sequence_number: 2, subject: 'Following up', body_text: 'Hi Fay, following up on your CFB power ratings against the market. ' + LINK,
    claims: [{ text: 'your CFB power ratings against the market', evidence_id: +proj14 }] })});`).draft_id;
  chk('(setup) follow-ups for Eli and Fay approved', approve(F13).ok === true && approve(F14).ok === true);
  one(`update growth_outbound.sends set sent_at = now() - interval '6 days' where prospect_id in (${lit(pid(13))}, ${lit(pid(14))});`);
  account(uid(13), EM[13]);
  r = claim(F13);
  chk('X Eli signed up after the follow-up was approved: claiming it is refused, and it is cancelled', r.ok === false && r.reason === 'prospect_converted'
    && dstatus(F13) === 'cancelled' && pstatus(pid(13)) === 'converted'
    && +one(`select count(*) from growth_outbound.sends where draft_id = ${lit(F13)};`) === 0, r);
  r = claim(F14);
  chk('X Fay did not: her follow-up goes, as step 2, tagged with her code', r.ok === true && r.message.text.indexOf(code(pid(14))) > 0, r);
  result(r.send_id, 'msg_live_fay_002');

  /* ══ T. THE TICK ══════════════════════════════════════════════════════ */
  one(`update growth_outbound.scheduler set conversions_synced_at = null where id = 1;`);
  account(uid(8), EM[8]); acquired(uid(8), { last: code(pid(8)) });   // her own address AND her link: the link is the stronger match
  r = tick();
  chk('T the tick matches results even with the morning run off', r.action === 'idle' && r.reason === 'automation is off' && pstatus(pid(8)) === 'converted'
    && !!sched().conversions_synced_at && sched().conversions_error === null, r);
  chk('T … an account matched both by the link and by the address counts once, as the link', JSON.stringify(convs(pid(8))) === JSON.stringify(['signed_up:link', 'visited:link']), convs(pid(8)));
  account(uid(15), EM[15]);
  tick();
  chk('T … at most hourly', convs(pid(15)).length === 0 && pstatus(pid(15)) === 'contacted');
  one(`update growth_outbound.scheduler set conversions_synced_at = now() - interval '61 minutes' where id = 1;`);
  tick();
  chk('T … and again after the hour', JSON.stringify(convs(pid(15))) === JSON.stringify(['signed_up:address']) && pstatus(pid(15)) === 'converted');
  const FACTS = one(`select pg_get_functiondef('public.growth_customer_facts()'::regprocedure);`);
  one(`create or replace function public.growth_customer_facts()
       returns table (user_id uuid, signup_at timestamptz, trial_started_at timestamptz, paid_at timestamptz, paid_invoices int, sub_status text, price_id text)
       language plpgsql as $$ begin raise exception 'the Stripe ledger is unreachable'; end $$;`);
  one(`update growth_outbound.scheduler set conversions_synced_at = now() - interval '2 hours' where id = 1;`);
  account(uid(16), 'cy@cypark.test');   // Cy signs up with the address written to
  const n0 = nconv();
  r = tick();
  chk('T a failure while matching is recorded, nothing half-written, and the tick carries on', r.action === 'idle' && /Stripe ledger is unreachable/.test(sched().conversions_error)
    && nconv() === n0 && pstatus(pid(11)) === 'contacted', [r, sched()]);
  chk('T … the owner sees it in the morning-run panel', /unreachable/.test(own(`select public.growth_outbound_automation_overview();`).scheduler.results_error));
  r = results();
  chk('T … and on the results, which still load', r.ok === true && /unreachable/.test(r.sync_error), r.sync_error);
  one(FACTS);
  r = results();
  chk('T once it works again, the next matching catches up and clears the error', r.ok === true && r.sync_error === null && pstatus(pid(11)) === 'converted'
    && JSON.stringify(convs(pid(11))) === JSON.stringify(['signed_up:address']), r.sync_error);

  // Bo's address bounced for good: suppressed, but he did not opt out
  one(`select growth_outbound.apply_suppression('address', ${lit(EM[10])}, 'bounce', 'hard bounce', 'webhook', null, ${lit(pid(10))});`);

  /* ══ D. THE DOOR ══════════════════════════════════════════════════════ */
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['a subscriber', (s) => db.as(SUB, s)], ['an affiliate admin', (s) => db.as(ADMIN, s)],
                            ['the service role', (s) => db.service(s)]]) {
    e = db.mustFail(() => run(`select public.growth_outbound_analytics(90);`));
    chk('D ' + who + ' cannot read the results', !!e && /permission denied|outbound owner only/.test(e), e);
  }
  // a search that found one of them, and the providers' calls
  one(`insert into growth_outbound.candidates (url, query, provider, prospect_id) values ('https://uma.test/', 'cfb power ratings newsletter', 'brave', ${lit(pid(8))});
       insert into growth_outbound.provider_usage (day, provider, calls) values (current_date, 'search', 3), (current_date, 'llm', 5)
         on conflict (day, provider) do update set calls = excluded.calls;`);
  r = results();
  const live = [2, 3, 8, 9, 10, 11, 12, 13, 14, 15];
  chk('D people: everyone first written to in the window, and what they did (a bounce is not an opt-out)', r.people.contacted === live.length && r.people.replied === 1
    && r.people.opted_out === 1 && r.people.bounced === 1 && r.people.visited === 2 && r.people.signed_up === 8 && r.people.trial === 1 && r.people.paid === 1, r.people);
  chk('D … as rates of the people written to', r.people.reply_rate === 0.1 && r.people.signup_rate === 0.8 && r.people.paid_rate === 0.1 && r.people.opt_out_rate === 0.1, r.people);
  chk('D sends: live only, with what Resend reported, and how many carried tagged links', r.sends.sent === live.length + 1 && r.sends.bounced === 1
    && r.sends.links_tagged === live.length + 1 && r.sends.bounce_rate === +(1 / (live.length + 1)).toFixed(4), r.sends);
  // fifteen real prospects (Pat's email went out in test mode); sixteen drafts (thirteen first emails, three follow-ups); approved: Pat, the ten written to, Vic (refused at send) and Fay's
  // follow-up — not Kim's (never approved) nor Eli's (approved, then cancelled: an approval is all or nothing)
  chk('D the pipeline: prospects, drafts, approvals in the window (no test rows)', r.pipeline.prospects === 15 && r.pipeline.found === 1
    && r.pipeline.approved === live.length + 3 && r.pipeline.drafted === 16 && r.pipeline.rejected === 0, r.pipeline);
  const wilson = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.round(Math.max(0, (c - h) / d) * 1000) / 1000, Math.round(Math.min(1, (c + h) / d) * 1000) / 1000]; };
  const step = (k) => r.by_step.find((x) => x.step === k) || {};
  chk('D by step: what each step sent, and which step each signup followed', step(1).sent === live.length && step(2).sent === 1
    && step(1).signups_after === 8 && step(1).replies_after === 1 && (step(2).signups_after || 0) === 0, r.by_step);
  const grp = (dim, g) => (r.groups[dim] || []).find((x) => x.group === g) || {};
  chk('D by writer, type, search and fit — each with its interval; ten people make a group big enough to read, nine do not, and one group alone is no difference', grp('writer', 'owner').contacted === live.length
    && grp('query', 'cfb power ratings newsletter').contacted === 1 && grp('query', 'added by hand').contacted === live.length - 1
    && grp('fit_band', '85–89').contacted === live.length && grp('prospect_type', 'cfb_analyst').contacted === live.length
    && JSON.stringify(grp('writer', 'owner').reply_interval) === JSON.stringify(wilson(1, 10)) && grp('writer', 'owner').enough === true
    && grp('query', 'added by hand').enough === false && r.signals.length === 0 && r.min_sample === 10, r.groups);
  const WIL = [[12, 12], [0, 12], [3, 10], [13, 34], [1, 1], [50, 400]];
  chk('D a 95% Wilson interval, to three places, as computed independently', WIL.every(([k, n]) => JSON.stringify(j(one(`select growth_outbound.wilson(${k}, ${n});`))) === JSON.stringify(wilson(k, n)))
    && one(`select growth_outbound.wilson(0, 0) is null;`) === 't', WIL.map(([k, n]) => [one(`select growth_outbound.wilson(${k}, ${n});`), wilson(k, n)]));
  chk('D by day, in the owner\'s time zone, every day of the window', r.daily.length === 91 && r.daily.reduce((a, d) => a + d.sent, 0) === live.length + 1
    && r.daily.reduce((a, d) => a + d.signed_up, 0) === 8, r.daily.slice(-2));
  chk('D what each provider was asked for', r.providers.search === 3 && r.providers.llm === 5, r.providers);
  chk('D the latest results name the prospect, never the account', r.latest.length >= 8 && r.latest.some((x) => x.full_name === 'Kim Ratings' && x.stage === 'paid'));
  const flat = JSON.stringify(r);
  chk('D nothing about an account leaves: no address, no user id, no key', !/@/.test(flat) && !/30000000-0000/.test(flat) && !/[0-9a-f]{64}/.test(flat), flat.match(/@|30000000-0000|[0-9a-f]{64}/));
  const det = own(`select public.growth_outbound_prospect(${lit(pid(2))});`);
  chk('D the prospect\'s own page lists their results, without the account', det.conversions.length === 4
    && det.conversions.every((x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(['matched_by', 'occurred_at', 'recorded_at', 'stage'])), det.conversions);

  // enough people for a difference to mean something
  const FIRST = ['Avery', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jules', 'Kendall', 'Logan'];
  FIRST.forEach((f, i) => { prospect(100 + i, f + ' Podwell', { type: 'podcast' }); contact(100 + i);
    own(`select public.growth_outbound_prospect_replied(${lit(pid(100 + i))}, 'sounds good', false);`); });
  FIRST.forEach((f, i) => { prospect(200 + i, f + ' Fieldman', { type: 'nfl_analyst' }); contact(200 + i); });
  // five of the podcasters came from one search: all five replied, but five people are too few to call
  one(`insert into growth_outbound.candidates (url, query, provider, prospect_id)
       select 'https://pod' || n || '.test/', 'tiny search', 'brave', ('10000000-0000-0000-0000-' || lpad((100 + n)::text, 12, '0'))::uuid from generate_series(0, 4) n;`);
  r = results();
  const pod = grp('prospect_type', 'podcast'), nfl = grp('prospect_type', 'nfl_analyst');
  chk('D past the minimum sample, a group is big enough to read', pod.contacted === 12 && pod.enough === true && nfl.enough === true
    && nfl.reply_rate === 0 && pod.reply_rate === 1, r.groups.prospect_type);
  const sig = (g, m) => r.signals.find((x) => x.dimension === 'prospect_type' && x.group === g && x.metric === m);
  chk('D … and a difference is called out only when its whole interval is clear of the average', sig('podcast', 'reply') && sig('podcast', 'reply').direction === 'higher'
    && sig('nfl_analyst', 'reply') && sig('nfl_analyst', 'reply').direction === 'lower' && !sig('cfb_analyst', 'reply')
    && !r.signals.some((x) => x.dimension === 'writer' || x.dimension === 'fit_band'), r.signals);
  chk('D … and never for a group below the minimum sample, however extreme (5 of 5 from one search)', grp('query', 'tiny search').replied === 5
    && grp('query', 'tiny search').enough === false && (grp('query', 'tiny search').reply_interval || [0])[0] > r.people.reply_rate
    && !r.signals.some((x) => x.group === 'tiny search'), [grp('query', 'tiny search'), r.signals]);
  chk('D the window is 1 to 365 days', results(0).days === 1 && results(5000).days === 365 && results(null).days === 90 && results(7).daily.length === 8);
  one(`update growth_outbound.sends set sent_at = sent_at - interval '100 days' where prospect_id = ${lit(pid(10))};`);
  chk('D someone first written to before the window is outside it', results(90).people.contacted === live.length + 23 && results(365).people.contacted === live.length + 24);

  /* ══ C. THE RECORD ════════════════════════════════════════════════════ */
  e = db.mustFail(() => one(`insert into growth_outbound.conversions (prospect_id, stage, matched_by, account_key, occurred_at)
                              values (${lit(pid(6))}, 'paid', 'address', repeat('a', 64), now());`));
  chk('C a conversion is written by the matcher only, not even by the superuser', !!e && /recorded only by the matcher/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.conversions set stage = 'paid' where prospect_id = ${lit(pid(3))};`));
  chk('C … never rewritten', !!e && /append-only/.test(e), e);
  e = db.mustFail(() => one(`delete from growth_outbound.conversions where prospect_id = ${lit(pid(3))};`));
  chk('C … never deleted', !!e && /append-only/.test(e), e);
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['the owner (doors only)', (s) => db.as(OWNER, s)], ['the service role', (s) => db.service(s)]]) {
    e = db.mustFail(() => run(`select count(*) from growth_outbound.conversions;`));
    chk('C ' + who + ' cannot read the record directly', !!e && /permission denied/.test(e), e);
  }
  e = db.mustFail(() => db.as(OWNER, `select growth_outbound.sync_conversions();`));
  chk('C nobody calls the matcher through the API', !!e && /permission denied/.test(e), e);

  /* ══ S. STATS ═════════════════════════════════════════════════════════ */
  const st = j(one(`select growth_outbound.drafting_stats();`));
  chk('S the drafting stats count replies (Rae and the twelve), not signups', st.owner.replied === 13, st.owner);

  /* ══ R. RE-RUN ════════════════════════════════════════════════════════ */
  const n1 = nconv();
  const out = db.applyFileAtomic(FILE);
  chk('R the file runs again over all of this, every report row ok', !/CHECK THIS/.test(out) && /35\|results: \d+ prospects made an account, 1 paid; links tagged/.test(out),
    out.split('\n').filter((l) => /^3[45]\|/.test(l)));
  chk('R … and the record is untouched', nconv() === n1 && pstatus(pid(2)) === 'converted');
} catch (err) {
  chk('suite ran to the end', false, String(err && err.stack || err).slice(0, 3000));
} finally {
  db.stop();
}
process.exit(T.done());
