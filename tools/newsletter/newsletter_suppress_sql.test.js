#!/usr/bin/env node
/* ===========================================================================
   NOBODY HOLDING THE ANON KEY CAN SUPPRESS AN ADDRESS (supabase/newsletter.sql).

   The hole this closes: newsletter_suppress(email, reason) was a SECURITY
   DEFINER function with no revoke, so PUBLIC — and therefore anyone with the
   anon key embedded in every page — could POST /rest/v1/rpc/newsletter_suppress
   and mark any address a 'complaint'. A complaint outranks everything and is
   never downgraded, so that address would never again receive the newsletter,
   and lifecycle_due() would stop its trial emails too.

   On a real PostgreSQL with Supabase's default grants (EXECUTE on every new
   public function to anon and authenticated), this proves:

     A  WHO MAY CALL IT: not anon, not a signed-in reader, not PUBLIC; the
        service role may. It is no longer security definer.
     B  EVERY LOCK HOLDS ALONE: re-granting EXECUTE to anon still fails (no
        table privilege); re-granting the table privileges too still fails
        (the function refuses the caller by name). Fail closed, with 42501.
     C  NO OTHER DOOR SUPPRESSES A STRANGER: the token doors refuse a missing,
        malformed, guessed or email-shaped token and change nothing.
     D  THE LEGITIMATE PATHS STILL WORK:
          the provider webhook (service role) suppresses bounces and
          complaints, ranks them, validates its input;
          a reader's own unsubscribe link (one-click, the preferences page,
          a single sport) works with their token — as anon and as the
          service role the Edge Function uses — and touches only their row;
          confirmation and re-subscribing still work, and a re-subscribe
          never clears a bounce or a complaint.
     E  THE CATALOGUE: the only security-definer newsletter functions anon can
        execute are the four token doors and the harmless admin probe, and the
        only client-callable writers of a suppression are the token door and
        the signed-in door that reads the caller's own confirmed address — a
        new function added without its revoke fails here.
     F  THE CALLERS: the webhook and the pipeline call it with the service key.

   Run: node tools/newsletter/newsletter_suppress_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('newsletter suppression SQL');
const chk = T.chk;
const ROOT = PG.ROOT;
const SQLF = path.join(ROOT, 'supabase', 'newsletter.sql');
const SRC = fs.readFileSync(SQLF, 'utf8');

/* ── F. static: the legitimate callers use the service key ─────────────── */
const EDGE = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'newsletter', 'index.ts'), 'utf8');
const RUNTIME = fs.readFileSync(path.join(ROOT, 'tools', 'newsletter', 'runtime.js'), 'utf8');
chk('F the webhook\'s database calls carry the service key', /apikey:\s*c\.serviceKey/.test(EDGE) && /authorization:\s*`Bearer \$\{c\.serviceKey\}`/.test(EDGE)
  && /rpc\(c, 'newsletter_suppress'/.test(EDGE));
chk('F the pipeline refuses to call an rpc without the service credential', /if \(!service\) throw new Error\('no service credential/.test(RUNTIME)
  && /rpc\('newsletter_suppress'/.test(RUNTIME));
chk('F the file revokes it from public, anon and authenticated',
  /revoke all on function public\.newsletter_suppress\(text, text, text, text\) from public, anon, authenticated;/.test(SRC));
chk('F … and grants it to the service role only', /grant execute on function public\.newsletter_suppress\(text, text, text, text\) to service_role;/.test(SRC)
  && !/grant execute on function public\.newsletter_suppress[^;]*(anon|authenticated)/.test(SRC));

const db = PG.start('nlsupp');
/* games-sql.yml refuses a log with a SKIP line or without a PASS line, so the
   job cannot go green on a suite that never reached a database */
if (db.skip) { console.log('SKIP | newsletter suppression SQL | ' + db.skip); process.exit(T.done()); }

const tok = (c) => c.repeat(64).slice(0, 64);           // a well-formed manage token
const VICTIM = 'victim@example.com', READER = 'reader@example.com', OTHER = 'other@example.com';
const T_READER = tok('a'), T_OTHER = tok('b'), T_VICTIM = tok('c');
const supp = (email) => db.sql(`select coalesce((select reason from public.newsletter_suppressions where email = ${PG.lit(email)}), 'none');`);
const status = (email) => db.sql(`select status from public.newsletter_subscribers where email = ${PG.lit(email)};`);
const denied = (e) => !!e && /permission denied|insufficient|server-side operation/i.test(e);
const SIG = 'public.newsletter_suppress(text,text,text,text)';

try {
  ['billing.sql', 'site_articles.sql'].forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
  let rep = db.applyFileAtomic(SQLF);
  chk('the migration applies', true);
  chk('… every report row says ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  rep = db.applyFileAtomic(SQLF);
  chk('… and applies again, still all ok (idempotent)', !/CHECK THIS/.test(rep));
  chk('… with the new report row present', /suppressing an arbitrary address is server-side only/.test(rep));

  db.sql(`insert into public.newsletter_subscribers (email, status, wants_cfb, wants_nfl, consent_source, consent_at, confirmed_at, manage_token) values
    (${PG.lit(VICTIM)}, 'confirmed', true, true, 'public_form', now(), now(), ${PG.lit(T_VICTIM)}),
    (${PG.lit(READER)}, 'confirmed', true, true, 'public_form', now(), now(), ${PG.lit(T_READER)}),
    (${PG.lit(OTHER)},  'confirmed', true, false, 'public_form', now(), now(), ${PG.lit(T_OTHER)});`);
  db.sql(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'signedin@example.com');`);
  const SIGNED_IN = '00000000-0000-0000-0000-0000000000e1';

  /* ── A. who may call it ───────────────────────────────────────────────── */
  chk('A anon cannot execute newsletter_suppress', db.sql(`select has_function_privilege('anon', '${SIG}', 'execute');`) === 'f');
  chk('A a signed-in reader cannot', db.sql(`select has_function_privilege('authenticated', '${SIG}', 'execute');`) === 'f');
  db.sql(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'plain_login') then create role plain_login login; end if; end $$;`);
  chk('A PUBLIC holds nothing (a fresh login role cannot)', db.sql(`select has_function_privilege('plain_login', '${SIG}', 'execute');`) === 'f');
  chk('A the service role can', db.sql(`select has_function_privilege('service_role', '${SIG}', 'execute');`) === 't');
  chk('A it runs with the caller\'s rights, not the owner\'s', db.sql(`select prosecdef from pg_proc where oid = '${SIG}'::regprocedure;`) === 'f');

  /* ── B. the attack, as the API would make it ──────────────────────────── */
  let e = db.mustFail(() => db.anon(`select public.newsletter_suppress(${PG.lit(VICTIM)}, 'complaint');`));
  chk('B anon suppressing an arbitrary address is refused', denied(e), e);
  chk('B … nothing was written', supp(VICTIM) === 'none' && status(VICTIM) === 'confirmed');
  e = db.mustFail(() => db.as(SIGNED_IN, `select public.newsletter_suppress(${PG.lit(VICTIM)}, 'complaint');`));
  chk('B a signed-in reader is refused too', denied(e), e);
  e = db.mustFail(() => db.anon(`insert into public.newsletter_suppressions (email, reason) values (${PG.lit(VICTIM)}, 'complaint');`));
  chk('B anon cannot write the suppression table directly', denied(e), e);
  e = db.mustFail(() => db.as(SIGNED_IN, `update public.newsletter_subscribers set status = 'unsubscribed' where email = ${PG.lit(VICTIM)};`));
  chk('B a signed-in reader cannot unsubscribe someone by writing the table', denied(e), e);

  /* lock 1 removed by mistake: EXECUTE re-granted to anon */
  db.sql(`grant execute on function ${SIG} to anon;`);
  e = db.mustFail(() => db.anon(`select public.newsletter_suppress(${PG.lit(VICTIM)}, 'complaint');`));
  chk('B with EXECUTE wrongly re-granted, anon is STILL refused (fails closed)', denied(e), e);
  /* locks 1 and 2 removed: the table privileges re-granted as well */
  db.sql(`grant select, insert, update on public.newsletter_suppressions to anon; grant select, update on public.newsletter_subscribers to anon;`);
  e = db.mustFail(() => db.anon(`select public.newsletter_suppress(${PG.lit(VICTIM)}, 'complaint');`));
  chk('B with EXECUTE and the table grants wrongly re-granted, the function itself refuses', !!e && /server-side operation/.test(e), e);
  db.sql(`revoke all on function ${SIG} from anon; revoke all on public.newsletter_suppressions from anon; revoke all on public.newsletter_subscribers from anon;`);
  chk('B … and still nothing was written', supp(VICTIM) === 'none' && status(VICTIM) === 'confirmed');

  /* ── C. the token doors cannot be turned on a stranger ────────────────── */
  const forged = [`null`, `''`, PG.lit(VICTIM), PG.lit('not-a-token'), PG.lit(tok('f')), PG.lit(tok('A').toUpperCase()), PG.lit(T_VICTIM + 'x'), PG.lit("' or 1=1 --")];
  let allRefused = true;
  for (const f of forged) {
    const r = JSON.parse(db.anon(`select public.newsletter_unsubscribe(${f}, 'all', 'one_click');`));
    if (r.ok !== false || r.reason !== 'unknown_token') allRefused = false;
  }
  chk('C newsletter_unsubscribe refuses a missing, malformed, guessed or email-shaped token', allRefused);
  chk('C … the victim is untouched', supp(VICTIM) === 'none' && status(VICTIM) === 'confirmed');
  const ps = JSON.parse(db.anon(`select public.newsletter_preferences_set(${PG.lit(VICTIM)}, false, false);`));
  chk('C the preferences door refuses an email in place of a token', ps.ok === false && supp(VICTIM) === 'none');
  const pg = JSON.parse(db.anon(`select public.newsletter_preferences_get(${PG.lit(tok('9'))});`));
  chk('C … and reveals nothing for a guessed token', pg.ok === false && !('email_masked' in pg));
  const cf = JSON.parse(db.anon(`select public.newsletter_confirm('not-the-token');`));
  chk('C the confirm door refuses a malformed token', cf.ok === false);

  /* ── D. the legitimate paths ──────────────────────────────────────────── */
  // the provider webhook (service role)
  let r = JSON.parse(db.service(`select public.newsletter_suppress('Bounced@Example.com ', 'bounce', 'mailbox does not exist', 'evt_1');`));
  chk('D the webhook suppresses a hard bounce (normalised address)', r.ok === true && supp('bounced@example.com') === 'bounce');
  db.service(`select public.newsletter_suppress('bounced@example.com', 'unsubscribe', 'later', 'evt_2');`);
  chk('D … a later unsubscribe does not downgrade the bounce', supp('bounced@example.com') === 'bounce');
  db.service(`select public.newsletter_suppress('bounced@example.com', 'complaint', 'spam', 'evt_3');`);
  chk('D … a complaint outranks it', supp('bounced@example.com') === 'complaint');
  db.service(`select public.newsletter_suppress('bounced@example.com', 'bounce', 'again', 'evt_4');`);
  chk('D … and is never downgraded', supp('bounced@example.com') === 'complaint');
  db.service(`select public.newsletter_suppress(${PG.lit(OTHER)}, 'complaint', 'spam', 'evt_5');`);
  chk('D a complaint on a subscriber also marks them unsubscribed', supp(OTHER) === 'complaint' && status(OTHER) === 'unsubscribed');
  r = JSON.parse(db.service(`select public.newsletter_suppress('not an email', 'bounce');`));
  chk('D the webhook path validates the address', r.ok === false && r.reason === 'not_an_email');
  r = JSON.parse(db.service(`select public.newsletter_suppress('x@example.com', 'because');`));
  chk('D … and the reason', r.ok === false && r.reason === 'unknown_reason' && supp('x@example.com') === 'none');
  r = JSON.parse(db.sql(`select public.newsletter_suppress('operator@example.com', 'manual', 'by hand');`));
  chk('D the operator (SQL editor, table owner) can still suppress by hand', r.ok === true && supp('operator@example.com') === 'manual');

  // a reader's own link, one sport at a time, as anon (a direct link) …
  r = JSON.parse(db.anon(`select public.newsletter_unsubscribe(${PG.lit(T_READER)}, 'CFB', 'one_click');`));
  chk('D a single-sport unsubscribe with the reader\'s own token keeps the other sport', r.ok === true && r.state === 'partial' && supp(READER) === 'none');
  // … and the rest, as the service role the Edge Function uses
  r = JSON.parse(db.service(`select public.newsletter_unsubscribe(${PG.lit(T_READER)}, 'NFL', 'one_click');`));
  chk('D turning the last sport off is a full unsubscribe (Edge Function path)', r.ok === true && r.state === 'unsubscribed' && supp(READER) === 'unsubscribe' && status(READER) === 'unsubscribed');
  chk('D … and it changed only the reader\'s row', supp(VICTIM) === 'none' && status(VICTIM) === 'confirmed');
  chk('D … with the source it was given', db.sql(`select unsubscribe_source from public.newsletter_subscribers where email = ${PG.lit(READER)};`) === 'one_click');

  // re-subscribing from the preferences page clears only an unsubscribe
  r = JSON.parse(db.anon(`select public.newsletter_preferences_set(${PG.lit(T_READER)}, true, false);`));
  chk('D re-subscribing with the token restores the reader and clears their unsubscribe', r.ok === true && status(READER) === 'confirmed' && supp(READER) === 'none');
  r = JSON.parse(db.anon(`select public.newsletter_preferences_set(${PG.lit(T_OTHER)}, true, true);`));
  chk('D … but never clears a complaint', supp(OTHER) === 'complaint');

  // both off on the preferences page is an unsubscribe; a junk source is not stored verbatim
  r = JSON.parse(db.anon(`select public.newsletter_preferences_set(${PG.lit(T_READER)}, false, false);`));
  chk('D both sports off on the preferences page is an unsubscribe', r.ok === true && supp(READER) === 'unsubscribe');
  db.anon(`select public.newsletter_preferences_set(${PG.lit(T_READER)}, true, true);`);
  r = JSON.parse(db.anon(`select public.newsletter_unsubscribe(${PG.lit(T_READER)}, 'all', '<script>alert(1)</script>');`));
  chk('D a caller-supplied source that is not a plain label is recorded as "link"', r.ok === true
    && db.sql(`select unsubscribe_source from public.newsletter_subscribers where email = ${PG.lit(READER)};`) === 'link'
    && db.sql(`select detail from public.newsletter_suppressions where email = ${PG.lit(READER)};`) === 'link');

  // the signed-in account door: only ever the caller's OWN confirmed address
  db.sql(`update auth.users set email = ${PG.lit(VICTIM.toUpperCase())}, email_confirmed_at = null where id = '${SIGNED_IN}';`);
  r = JSON.parse(db.as(SIGNED_IN, `select public.newsletter_set_my_preferences(false, false, 'account_settings');`));
  chk('D a signed-in account whose email is NOT confirmed cannot unsubscribe the matching subscriber', r.ok === false && r.reason === 'account_email_unverified' && supp(VICTIM) === 'none');
  db.sql(`update auth.users set email = 'signedin@example.com', email_confirmed_at = now() where id = '${SIGNED_IN}';`);
  r = JSON.parse(db.as(SIGNED_IN, `select public.newsletter_set_my_preferences(true, false, 'account_settings');`));
  db.as(SIGNED_IN, `select public.newsletter_set_my_preferences(false, false, 'x"; drop table y');`);
  chk('D a signed-in reader unsubscribing in account settings suppresses only their own address', supp('signedin@example.com') === 'unsubscribe' && supp(VICTIM) === 'none'
    && db.sql(`select detail from public.newsletter_suppressions where email = 'signedin@example.com';`) === 'account_settings');
  e = db.mustFail(() => db.anon(`select public.newsletter_set_my_preferences(false, false, 'account_settings');`));
  chk('D … and anon cannot call that door at all', denied(e), e);

  // signup (service) → confirm (the link, as anon) still works end to end
  const su = JSON.parse(db.service(`select public.newsletter_signup('new@example.com', true, false, 'public_form', null, null);`));
  chk('D a signup still issues a well-formed confirmation token', su.ok === true && /^[0-9a-f]{64}$/.test(su.confirm_token || ''), su);
  const cr = JSON.parse(db.anon(`select public.newsletter_confirm(${PG.lit(su.confirm_token)});`));
  chk('D … which confirms the address from the email link', cr.ok === true && status('new@example.com') === 'confirmed' && /^[0-9a-f]{64}$/.test(cr.manage_token || ''));
  r = JSON.parse(db.anon(`select public.newsletter_unsubscribe(${PG.lit(cr.manage_token)}, 'all', 'one_click');`));
  chk('D … and the manage token it returns unsubscribes that address', r.ok === true && supp('new@example.com') === 'unsubscribe');

  /* ── E. the catalogue ─────────────────────────────────────────────────── */
  const reach = db.sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'newsletter%'
      and p.prosecdef and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('anon', p.oid, 'execute');`);
  chk('E the only security-definer newsletter functions anon can execute are the token doors (and the false-for-anon admin probe)',
    reach === 'newsletter_confirm,newsletter_is_admin,newsletter_preferences_get,newsletter_preferences_set,newsletter_unsubscribe', reach);
  chk('E the admin probe says false to anon', db.anon(`select public.newsletter_is_admin();`) === 'f');
  const writers = db.sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.prosrc ~* 'insert\\s+into\\s+(public\\.)?newsletter_suppressions'
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
  chk('E the only client-callable functions that write a suppression are the token door and the signed-in self-service door', writers === 'newsletter_set_my_preferences,newsletter_unsubscribe', writers);
  chk('E … and the self-service door is not callable by anon', db.sql(`select has_function_privilege('anon', 'public.newsletter_set_my_preferences(boolean,boolean,text)', 'execute');`) === 'f');
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 600));
} finally {
  db.stop();
}
const code = T.done();
if (code === 0) console.log('PASS | newsletter suppression SQL');
process.exit(code);
