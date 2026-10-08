#!/usr/bin/env node
/* ===========================================================================
   THE NEWSLETTER'S PUBLIC DOOR, HARDENED (supabase/newsletter.sql, 2026-10).

   On a real PostgreSQL with Supabase's default grants, this proves:

     A  TOPICS: a findings-only signup is a signup; product updates alone are
        not; product updates carry their own consent stamp, and lose it the
        moment they are switched off.
     B  A CONFIRMED ADDRESS IS NOT CHANGED FROM THE ANONYMOUS FORM: its topics
        stay as they are, and the server is told to mail the address its own
        preferences link — once per cooldown.
     C  THE CAPS: past the hourly total no confirmation is mailed (the same
        answer is given); one address gets at most confirm_max_per_day
        confirmations a day, however the cooldown is set.
     D  PREFERENCES: an unsent topic is left alone; a revival from an old link
        is recorded as a new consent; turning every research topic off is an
        unsubscribe; one topic can be dropped on its own.
     E  THE COUNT OF THE LIST is for operators and the server, not for any
        signed-in reader.
     F  THE SOURCE LABEL is a label: anything else is stored as public_form.

   Run: node tools/newsletter/newsletter_growth_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('newsletter growth SQL');
const chk = T.chk;
const ROOT = PG.ROOT;

const db = PG.start('nlgrow');
if (db.skip) { console.log('SKIP | newsletter growth SQL | ' + db.skip); process.exit(T.done()); }

const J = (s) => JSON.parse(s);
const signup = (email, cfb, nfl, findings, product, src, ip) => J(db.service(
  `select public.newsletter_signup(${PG.lit(email)}, ${cfb}, ${nfl}, ${PG.lit(src || 'newsletter_page')}, 'ua', ${PG.lit(ip || 'iphash-1')}, ${findings}, ${product});`));
const row = (email) => J(db.sql(`select coalesce((select to_jsonb(s) from public.newsletter_subscribers s where email = ${PG.lit(email)}), 'null'::jsonb);`));
const confirmTok = (email) => {
  /* the raw token is only ever in the email; a test confirms by setting a
     known digest, which is what the email would have carried */
  const t = 'f'.repeat(64);
  db.sql(`update public.newsletter_subscribers set confirm_token_hash = public.newsletter_token_hash(${PG.lit(t)}), confirm_expires_at = now() + interval '1 day' where email = ${PG.lit(email)};`);
  return J(db.anon(`select public.newsletter_confirm(${PG.lit(t)});`));
};

try {
  ['billing.sql', 'site_articles.sql'].forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
  let rep = db.applyFileAtomic(path.join(ROOT, 'supabase', 'newsletter.sql'));
  chk('the migration applies', true);
  chk('…every report row says ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  rep = db.applyFileAtomic(path.join(ROOT, 'supabase', 'newsletter.sql'));
  chk('…and applies again unchanged', !/CHECK THIS/.test(rep));
  /* generous caps for the topic tests; section C sets its own */
  db.sql(`update public.newsletter_settings set signup_cooldown_seconds = 900, signup_per_ip_hour = 1000, signup_global_hour = 1000, confirm_max_per_day = 5 where id = 1;`);

  /* ── A. topics ─────────────────────────────────────────────────────────── */
  let r = signup('findings@example.com', false, false, true, false);
  chk('A a findings-only signup is accepted and mailed a confirmation', r.ok === true && /^[0-9a-f]{64}$/.test(r.confirm_token || ''), r);
  r = confirmTok('findings@example.com');
  chk('A …and confirms as findings only', r.ok === true && r.wants_findings === true && r.wants_cfb === false && r.wants_nfl === false, r);
  r = signup('product@example.com', false, false, false, true);
  chk('A product updates alone are not a newsletter signup', r.ok === false && r.reason === 'no_sport_selected', r);
  r = signup('both@example.com', true, false, false, true, 'nl_tool_no_vig');
  let s = row('both@example.com');
  chk('A product updates carry their own consent stamp and source', s.wants_product === true && !!s.product_consent_at && s.product_consent_source === 'nl_tool_no_vig', s);
  chk('A the signup source label is kept as given when it is a label', s.consent_source === 'nl_tool_no_vig', s.consent_source);
  r = signup('noprod@example.com', true, false, false, false);
  s = row('noprod@example.com');
  chk('A without the tick there is no product consent', s.wants_product === false && s.product_consent_at === null, s);

  /* ── B. a confirmed address is not changed from the form ──────────────── */
  r = confirmTok('noprod@example.com');
  chk('B the address confirms', r.ok === true && r.wants_cfb === true && r.wants_product === false, r);
  const before = row('noprod@example.com');
  r = signup('noprod@example.com', true, true, true, true);
  const after = row('noprod@example.com');
  chk('B a stranger cannot add topics to a confirmed reader', after.wants_nfl === false && after.wants_findings === false && after.wants_product === false
    && after.wants_cfb === true, after);
  chk('B …nor reset its consent record', after.consent_at === before.consent_at && after.status === 'confirmed');
  chk('B the server is told to mail the address its OWN preferences link', r.ok === true && r.state === 'already_confirmed'
    && r.send_manage_link === true && r.manage_token === after.manage_token && !r.confirm_token, r);
  r = signup('noprod@example.com', true, true, false, false);
  chk('B …once per cooldown, not once per submission', r.ok === true && !r.send_manage_link && !r.manage_token && r.throttled === 'cooldown', r);

  /* ── C. the caps ───────────────────────────────────────────────────────── */
  db.sql(`delete from public.newsletter_subscribers where status = 'pending';`);
  db.sql(`update public.newsletter_settings set signup_global_hour = 3, signup_per_ip_hour = 1000 where id = 1;`);
  const mailed = [1, 2, 3].map((i) => signup('g' + i + '@example.com', true, false, false, false, null, 'ip-' + i));
  chk('C up to the hourly total, each signup is mailed', mailed.every((x) => !!x.confirm_token), mailed);
  r = signup('g4@example.com', true, false, false, false, null, 'ip-4');
  chk('C past it, rotating sources still get no confirmation mailed', r.ok === true && !r.confirm_token && r.throttled === 'global', r);
  chk('C …and nothing is written for the address', row('g4@example.com') === null);
  db.sql(`delete from public.newsletter_subscribers where status = 'pending';`);
  db.sql(`update public.newsletter_settings set signup_global_hour = 1000, signup_cooldown_seconds = 0, confirm_max_per_day = 2 where id = 1;`);
  const daily = [1, 2, 3].map((i) => signup('victim@example.com', true, false, false, false, null, 'ipv-' + i));
  chk('C one address gets at most confirm_max_per_day confirmations, whatever the cooldown',
    !!daily[0].confirm_token && !!daily[1].confirm_token && !daily[2].confirm_token && daily[2].throttled === 'daily', daily);
  db.sql(`update public.newsletter_subscribers set confirm_sent_at = now() - interval '25 hours' where email = 'victim@example.com';`);
  r = signup('victim@example.com', true, false, false, false, null, 'ipv-9');
  chk('C …and the count starts again a day later', !!r.confirm_token, r);
  db.sql(`update public.newsletter_settings set signup_cooldown_seconds = 900, confirm_max_per_day = 5 where id = 1;`);

  /* ── D. preferences ────────────────────────────────────────────────────── */
  const tok = row('noprod@example.com').manage_token;
  r = J(db.anon(`select public.newsletter_preferences_set(${PG.lit(tok)}, true, true);`));
  s = row('noprod@example.com');
  chk('D the two-sport caller changes only the two sports', r.ok === true && s.wants_nfl === true && s.wants_findings === false && s.wants_product === false, s);
  r = J(db.anon(`select public.newsletter_preferences_set(${PG.lit(tok)}, true, true, true, true);`));
  s = row('noprod@example.com');
  chk('D product updates switched on from the preferences page are stamped there', s.wants_product === true && s.product_consent_source === 'preferences_page' && !!s.product_consent_at, s);
  r = J(db.anon(`select public.newsletter_unsubscribe(${PG.lit(tok)}, 'product', 'manage_page');`));
  s = row('noprod@example.com');
  chk('D product updates can be dropped on their own', r.state === 'partial' && s.wants_product === false && s.product_consent_at === null && s.status === 'confirmed', { r, s });
  r = J(db.anon(`select public.newsletter_unsubscribe(${PG.lit(tok)}, 'all', 'manage_page');`));
  chk('D a full unsubscribe', r.state === 'unsubscribed' && row('noprod@example.com').status === 'unsubscribed');
  db.sql(`update public.newsletter_subscribers set consent_at = now() - interval '30 days' where email = 'noprod@example.com';`);
  r = J(db.anon(`select public.newsletter_preferences_set(${PG.lit(tok)}, true, false);`));
  s = row('noprod@example.com');
  chk('D a revival from an old link is the reader\'s own act and is honoured', r.ok === true && s.status === 'confirmed', s);
  chk('D …and recorded as a NEW consent, not dressed up as the original signup',
    s.consent_source === 'preferences_page' && Date.parse(s.consent_at) > Date.now() - 600000 && s.unsubscribed_at === null, s);
  const ftok = row('findings@example.com').manage_token;
  r = J(db.anon(`select public.newsletter_unsubscribe(${PG.lit(ftok)}, 'findings', 'manage_page');`));
  chk('D dropping the last research topic is a full unsubscribe', r.state === 'unsubscribed', r);
  r = J(db.anon(`select public.newsletter_preferences_set(${PG.lit(tok)}, false, false, false, true);`));
  chk('D product updates alone do not keep a reader subscribed', r.state === 'unsubscribed' && row('noprod@example.com').status === 'unsubscribed', r);

  /* ── E. the count of the list ──────────────────────────────────────────── */
  const READER = '00000000-0000-0000-0000-0000000000c1';
  db.sql(`insert into auth.users (id, email) values ('${READER}', 'reader@example.com') on conflict do nothing;`);
  const err = db.mustFail(() => db.as(READER, `select public.newsletter_eligible_count('CFB');`));
  chk('E a signed-in reader cannot count the subscriber list', !!err && /operators|42501|permission/i.test(err), err);
  const n = db.service(`select public.newsletter_eligible_count('CFB');`);
  chk('E the server can', /^\d+$/.test(n), n);

  /* ── F. the source label ───────────────────────────────────────────────── */
  r = signup('label@example.com', true, false, false, false, 'Evil <script> source!');
  chk('F a source that is not a label is stored as public_form', row('label@example.com').consent_source === 'public_form');
  r = J(db.service(`select public.newsletter_signup(${PG.lit('x'.repeat(250) + '@example.com')}, true, false);`));
  chk('F an address longer than 254 characters is refused', r.ok === false && r.reason === 'invalid_email', r);
} catch (e) {
  chk('the suite reached its end — ' + String(e.message || e).split('\n').slice(0, 3).join(' | '), false);
} finally {
  db.stop();
}
process.exit(T.done());
