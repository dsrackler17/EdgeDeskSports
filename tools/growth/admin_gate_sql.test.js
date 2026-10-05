#!/usr/bin/env node
/* ===========================================================================
   THE GROWTH CONSOLE'S OPERATOR GATE, AGAINST A REAL POSTGRESQL.

   The console's sign-in fix (lib/edgedesk_admin_session.js) changed how the
   page holds a session; it must not have changed WHO gets in. Who gets in is
   decided here, in the database, under the caller's own token:

     growth_is_admin() → affiliate_is_admin() → a row in public.affiliate_admins

   What this proves, as real roles on a throwaway cluster:

     1  anonymous: cannot even ask the question, cannot read or write the list
     2  a paying subscriber: is told "no", cannot read the list, cannot add,
        change or remove a row in it, cannot open any growth admin function
     3  an affiliate partner (a creator in the program): exactly the same
     4  the owner, listed: is told "yes" and the console's reads answer
     5  NO PATH TO SELF-PROMOTION: no policy on the list, no client privilege
        on it, and no function a client may execute writes to it
     6  removal is immediate — the next call with the same token is refused
     7  deleting the auth user removes the operator row with it

   Run: node tools/growth/admin_gate_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('growth admin gate SQL');
const chk = T.chk;

const db = PG.start('ggate');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const U = {
  owner: '00000000-0000-0000-0000-00000000a0a0',
  sub: '00000000-0000-0000-0000-00000000a0b1',
  partner: '00000000-0000-0000-0000-00000000a0c2'
};
const denied = (e) => !!e && /permission denied|not an admin|insufficient|not an affiliate admin/i.test(e);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  chk('the chain applies (billing → … → affiliates → growth)', true);

  db.sql(`insert into auth.users (id, email, created_at) values
      ('${U.owner}', 'owner@example.com', now() - interval '400 days'),
      ('${U.sub}', 'subscriber@example.com', now() - interval '40 days'),
      ('${U.partner}', 'creator@example.com', now() - interval '90 days');
    insert into public.subscriptions (user_id, status, price_id, current_period_end)
      values ('${U.sub}', 'active', 'price_4999', now() + interval '20 days');
    insert into public.affiliate_accounts (user_id, code, display_name, status)
      values ('${U.partner}', 'CREATORX', 'Creator X', 'active');
    insert into public.affiliate_admins (user_id) values ('${U.owner}');`);

  /* ── 1. anonymous ─────────────────────────────────────────────────────── */
  chk('anon cannot call growth_is_admin()', denied(db.mustFail(() => db.anon(`select public.growth_is_admin();`))));
  chk('anon cannot read the operator list', denied(db.mustFail(() => db.anon(`select count(*) from public.affiliate_admins;`))));
  chk('anon cannot add to the operator list', denied(db.mustFail(() => db.anon(`insert into public.affiliate_admins (user_id) values ('${U.sub}');`))));
  chk('anon cannot open the console\'s reads', ['growth_admin_activation(90)', "growth_admin_funnel(90, 'first')", 'growth_admin_samples()']
    .every((f) => denied(db.mustFail(() => db.anon(`select public.${f};`)))));

  /* ── 2 & 3. a subscriber and a partner ────────────────────────────────── */
  for (const [who, uid] of [['a paying subscriber', U.sub], ['an affiliate partner', U.partner]]) {
    chk(who + ' is told no by growth_is_admin()', db.as(uid, `select public.growth_is_admin();`) === 'f');
    chk(who + ' cannot read the operator list', denied(db.mustFail(() => db.as(uid, `select count(*) from public.affiliate_admins;`))));
    chk(who + ' cannot add themselves', denied(db.mustFail(() => db.as(uid, `insert into public.affiliate_admins (user_id) values ('${uid}');`))));
    chk(who + ' cannot rewrite a row to themselves', denied(db.mustFail(() => db.as(uid, `update public.affiliate_admins set user_id = '${uid}';`))));
    chk(who + ' cannot remove the owner', denied(db.mustFail(() => db.as(uid, `delete from public.affiliate_admins;`))));
    chk(who + ' cannot open the console\'s reads', ['growth_admin_activation(90)', "growth_admin_funnel(90, 'first')", 'growth_admin_samples()']
      .every((f) => denied(db.mustFail(() => db.as(uid, `select public.${f};`)))));
    chk(who + ' cannot change a console setting', denied(db.mustFail(() => db.as(uid, `select public.growth_admin_update_activation_settings('{"trial_days":8}'::jsonb);`))));
  }
  chk('the list is still exactly the owner', db.sql(`select string_agg(user_id::text, ',') from public.affiliate_admins;`) === U.owner);

  /* ── 4. the owner ─────────────────────────────────────────────────────── */
  chk('the owner is told yes', db.as(U.owner, `select public.growth_is_admin();`) === 't');
  const act = JSON.parse(db.as(U.owner, `select public.growth_admin_activation(90);`));
  chk('… and the console\'s reads answer', act && typeof act.trials === 'number' && act.settings && typeof act.settings.trial_days === 'number', act);
  chk('… all three', !!JSON.parse(db.as(U.owner, `select public.growth_admin_funnel(90, 'first');`)) && !!JSON.parse(db.as(U.owner, `select public.growth_admin_samples();`)));

  /* ── 5. no path to self-promotion ─────────────────────────────────────── */
  chk('row level security is on for the operator list', db.sql(`select relrowsecurity from pg_class where oid = 'public.affiliate_admins'::regclass;`) === 't');
  chk('no policy opens it to anyone', db.sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'affiliate_admins';`) === '0');
  const privs = db.sql(`select string_agg(r || ':' || p, ',') from unnest(array['anon','authenticated']) r,
      unnest(array['select','insert','update','delete','truncate','references','trigger']) p
    where has_table_privilege(r, 'public.affiliate_admins', p);`);
  chk('neither client role holds any privilege on it', privs === '', privs);
  const WRITERS = `select coalesce(string_agg(p.oid::regprocedure::text, ', '), '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?affiliate_admins'
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`;
  const writers = db.sql(WRITERS);
  chk('no function a client can execute writes to the operator list', writers === '', writers);
  /* the scan is not vacuous: a planted backdoor is found, and actually works, until it is gone */
  db.sql(`create function public.zz_backdoor() returns void language sql security definer set search_path = public as
            $$ insert into public.affiliate_admins (user_id) select auth.uid() on conflict do nothing $$;`);
  chk('… (control) the scan finds a planted self-promotion function', /zz_backdoor/.test(db.sql(WRITERS)));
  db.as(U.sub, `select public.zz_backdoor();`);
  chk('… (control) which would really have worked', db.as(U.sub, `select public.growth_is_admin();`) === 't');
  db.sql(`drop function public.zz_backdoor(); delete from public.affiliate_admins where user_id = '${U.sub}';`);
  chk('… (control) cleaned up', db.sql(WRITERS) === '' && db.as(U.sub, `select public.growth_is_admin();`) === 'f');
  chk('growth_is_admin() is a fixed-search_path security definer (cannot be hijacked)',
    db.sql(`select prosecdef and coalesce(array_to_string(proconfig, ','), '') ~ 'search_path=public, ?pg_temp'
            from pg_proc where oid = 'public.growth_is_admin()'::regprocedure;`) === 't');

  /* ── 6. removal is immediate ──────────────────────────────────────────── */
  db.sql(`delete from public.affiliate_admins where user_id = '${U.owner}';`);
  chk('a removed operator is refused on the very next call', db.as(U.owner, `select public.growth_is_admin();`) === 'f'
    && denied(db.mustFail(() => db.as(U.owner, `select public.growth_admin_activation(90);`))));
  db.sql(`insert into public.affiliate_admins (user_id) values ('${U.owner}');`);
  chk('… and restored by the operator path (SQL editor) only', db.as(U.owner, `select public.growth_is_admin();`) === 't');

  /* ── 7. deleting the account removes the operator row ─────────────────── */
  db.sql(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000a0d3', 'temp@example.com');
          insert into public.affiliate_admins (user_id) values ('00000000-0000-0000-0000-00000000a0d3');
          delete from auth.users where id = '00000000-0000-0000-0000-00000000a0d3';`);
  chk('a deleted account leaves no operator row behind', db.sql(`select count(*) from public.affiliate_admins where user_id = '00000000-0000-0000-0000-00000000a0d3';`) === '0');
} catch (e) {
  chk('the suite ran without an unexpected error', false, String(e.sqlMessage || e.message).slice(0, 600));
} finally {
  db.stop();
}
process.exit(T.done());
