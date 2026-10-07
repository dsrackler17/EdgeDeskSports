#!/usr/bin/env node
/* ===========================================================================
   THE OUTBOUND ENGINE'S OWNER-ONLY DATABASE, ATTACKED (supabase/growth_outbound.sql).

   normal user  <  affiliate_admin  <  outbound owner

   On a real PostgreSQL with Supabase's default grants, as anon, a paying
   subscriber, an affiliate partner, an affiliate ADMIN who is not an owner,
   the service role, an ex-owner and the owner:

     A  INSTALL       applies after its chain, twice; every report row ok
     B  CATALOGUE     every table: RLS on, the restrictive deny policy, no
                      privilege for any client role; the schema unusable by
                      them; every public growth_outbound_* door security
                      definer, pinned search_path, refused to anon and the
                      service role — and for EVERY door, EVERY non-owner is
                      refused by the owner check before anything else runs.
                      A door added in a later phase is covered automatically.
     C  EACH LAYER ALONE   a mistaken schema grant + table grant + permissive
                      policy still returns no row (the restrictive policy)
     D  NO SELF-ENROLLMENT direct writes refused; the service role refused; a
                      planted security-definer backdoor refused by the row
                      trigger; the catalogue scan finds the backdoor; only the
                      SQL-editor path works, and only for an affiliate admin
     E  HIERARCHY     an affiliate admin is not an owner; demotion cascades and
                      is audited; re-adding as affiliate admin restores nothing;
                      the existing growth console still opens for admins
     F  OWNER         reads prospects WITH emails, evidence, drafts, settings,
                      activity; settings changes validated, audited, and a cap
                      increase or leaving test mode needs explicit confirmation
     G  APPROVAL      only the owner, only pending review, only the reviewed
                      hash, only above the confidence gates; a direct UPDATE to
                      approved is refused even for the superuser; an approved
                      draft cannot change; an edit returns it to review
     H  SUPPRESSION   cancels live drafts, blocks approval, append-only
     I  SENDS         no row without the claim door, an approved unchanged
                      draft, a current owner, the approved recipient, complete
                      compliance config; test mode sends ONLY to the test
                      inbox; once per draft, once per address per step; the
                      daily cap; suppression; recorded content immutable
     J  HISTORY       activity, suppressions and owner audit append-only;
                      prospects, evidence, drafts, sends never deleted

   Run: node tools/growth/outbound_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');
const SRC = fs.readFileSync(FILE, 'utf8');
const lit = PG.lit;

/* ── STATIC: the file's conventions and the door rule ──────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SRC));
chk('idempotent creates', /create table if not exists/.test(SRC) && /create or replace function/.test(SRC) && !/\bdrop table\b/i.test(SRC));
chk('ends in a report', /CHECK THIS/.test(SRC) && /order by 1;\s*$/.test(SRC));
chk('it never writes the affiliate admin list or its function', !/(insert into|update|delete from)\s+public\.affiliate_admins/i.test(SRC)
  && !/create or replace function public\.(affiliate_is_admin|growth_is_admin)/.test(SRC));
chk('no pgcrypto dependency (portable under a pinned search_path)', !/gen_random_bytes|digest\(|crypt\(/.test(SRC));
{
  /* one chunk per function; a plpgsql door's first statement after `begin` must be the owner check */
  const chunks = SRC.split(/\ncreate or replace function /).slice(1).map((c) => ({ name: (c.match(/^public\.(growth_outbound_[a-z_]+)\(/) || [])[1], body: c.split(/\nend \$\$;/)[0] }))
    .filter((c) => c.name && /language plpgsql/.test(c.body));
  const notFirst = chunks.filter((c) => !/\nbegin\n\s*(perform growth_outbound\.require_owner\(\);|v_owner := growth_outbound\.require_owner\(\);)/.test(c.body)).map((c) => c.name);
  chk('every plpgsql door\'s FIRST statement is the owner check', chunks.length >= 12 && notFirst.length === 0, { n: chunks.length, notFirst });
}

const db = PG.start('gobound');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const U = {
  owner: '00000000-0000-0000-0000-0000000000a1',
  admin: '00000000-0000-0000-0000-0000000000a2',   // affiliate admin, NOT an owner
  sub: '00000000-0000-0000-0000-0000000000a3',     // paying subscriber
  partner: '00000000-0000-0000-0000-0000000000a4', // affiliate partner (creator)
  ex: '00000000-0000-0000-0000-0000000000a5',      // owner, later removed from affiliate_admins
  stranger: '00000000-0000-0000-0000-0000000000a6' // signed up, nothing else
};
const NOT_OWNER = /outbound owner only/;
const DENIED = /permission denied|insufficient|outbound owner only|SQL editor only|append-only|never deleted|only the approve door|claim door|approved draft|cannot change|final|triggered by an outbound owner/i;
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);

try {
  /* ══ A. INSTALL ═══════════════════════════════════════════════════════ */
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  let rep = db.applyFileAtomic(FILE);
  chk('A the migration applies after its chain', true);
  chk('A every report row says ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  rep = db.applyFileAtomic(FILE);
  chk('A and applies a second time, still all ok', !/CHECK THIS/.test(rep));
  chk('A sending starts blocked, in test mode, automation off, cap 20', /test mode ON, automation OFF, daily cap 20/.test(rep)
    && /postal_address_missing/.test(rep) && /no_outbound_owner/.test(rep));

  one(`insert into auth.users (id, email, email_confirmed_at) values
    ('${U.owner}', 'owner@edgedesk.test', now()), ('${U.admin}', 'admin@edgedesk.test', now()),
    ('${U.sub}', 'sub@example.com', now()), ('${U.partner}', 'creator@example.com', now()),
    ('${U.ex}', 'ex@edgedesk.test', now()), ('${U.stranger}', 'stranger@example.com', now());
    insert into public.subscriptions (user_id, status, price_id, current_period_end) values ('${U.sub}', 'active', 'price_4999', now() + interval '20 days');
    insert into public.affiliate_accounts (user_id, code, display_name, status) values ('${U.partner}', 'CREATORX', 'Creator X', 'active');
    insert into public.affiliate_admins (user_id) values ('${U.owner}'), ('${U.admin}'), ('${U.ex}');`);
  /* the SQL-editor bootstrap, exactly as documented — and every way to get it wrong */
  one(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b9', 'unconfirmed@edgedesk.test');
       insert into public.affiliate_admins (user_id) values ('00000000-0000-0000-0000-0000000000b9');`);
  const boot = (arg) => db.mustFail(() => one(`select growth_outbound.grant_owner(${arg});`));
  let be = boot(`'<owner@edgedesk.test>'`);
  chk('A bootstrap: an address pasted with its < > is refused, and told how to fix it', !!be && /remove the < > around the address: grant_owner\('owner@edgedesk\.test'\)/.test(be), be);
  be = boot(`'nobody@edgedesk.test'`);
  chk('A bootstrap: an address with no account says so', !!be && /no EdgeDesk account uses nobody@edgedesk\.test/.test(be), be);
  be = boot(`'unconfirmed@edgedesk.test'`);
  chk('A bootstrap: an unconfirmed account is refused', !!be && /has not confirmed/.test(be), be);
  be = boot(`'sub@example.com'`);
  chk('A bootstrap: a non-affiliate-admin is refused, with the prerequisite named', !!be && /is not an affiliate admin/.test(be), be);
  be = boot(`'not an email'`);
  chk('A bootstrap: garbage is refused', !!be && /is not an email address/.test(be), be);
  chk('A … and none of those granted anything', one(`select count(*) from growth_outbound.owners;`) === '0');
  const g1 = one(`select growth_outbound.grant_owner('  OWNER@edgedesk.test ');`);
  chk('A bootstrap: the owner\'s address (any case, stray spaces) grants them', /^ok — owner@edgedesk\.test .* is now an outbound owner$/.test(g1), g1);
  chk('A bootstrap: running it again is harmless', /already an outbound owner/.test(one(`select growth_outbound.grant_owner('owner@edgedesk.test');`)));
  one(`insert into growth_outbound.owners (user_id, note) values ('${U.ex}', 'second owner, demoted later');`);
  chk('A the raw SQL-editor insert also works (for the operator who prefers it)', one(`select count(*) from growth_outbound.owners;`) === '2');
  be = db.mustFail(() => db.as(U.admin, `select growth_outbound.grant_owner('admin@edgedesk.test');`));
  chk('A no client role can call the bootstrap helper', !!be && /permission denied/.test(be), be);
  one(`grant usage on schema growth_outbound to authenticated; grant execute on function growth_outbound.grant_owner(text, text) to authenticated;`);
  be = db.mustFail(() => db.as(U.admin, `select growth_outbound.grant_owner('admin@edgedesk.test');`));
  chk('A … and if it were ever granted by mistake, an API caller is still refused', !!be && /SQL editor only|permission denied/.test(be), be);
  one(`revoke execute on function growth_outbound.grant_owner(text, text) from authenticated; revoke usage on schema growth_outbound from authenticated;`);

  /* seed: prospects, evidence, drafts — as the research and draft pipeline
     would, server-side. Since Phase 3 nothing computed can be written
     directly: each prospect is built from evidence and evaluated. */
  const pid = (n) => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const did = (n) => '20000000-0000-0000-0000-' + String(n).padStart(12, '0');
  one(SEED.strong({ id: pid(1), name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'patanalyst' })
    + SEED.weak({ id: pid(2), name: 'Lo Confidence', email: 'lo@maybe.test' })
    + SEED.strong({ id: pid(3), name: 'Sam Spare', org: 'Props Lab', email: 'sam@propslab.test', domain: 'propslab.test', handle: 'samspare', type: 'props_analyst', project: 'weekly player prop projections' })
    // the same address as Pat, found again under another name: a duplicate
    + SEED.strong({ id: pid(4), name: 'Twin Row', org: 'Twin Media', email: 'PAT@cfbnumbers.test', domain: 'twinrow.test', handle: 'twinrow' })
    + SEED.strong({ id: pid(5), name: 'Domain Mate', org: 'Props Lab', email: 'dee@propslab.test', domain: 'propslab.test', handle: 'deemate', type: 'props_analyst' })
    + SEED.strong({ id: pid(7), name: 'Lee Live', org: 'Lee Lab', email: 'lee@leelab.test', domain: 'leelab.test', handle: 'leelab' })
    + `insert into growth_outbound.prospects (id, is_test, email) values ('10000000-0000-0000-0000-0000000000f0', true, 'owner-test@edgedesk.test');`
    + SEED.draft({ id: did(1), prospect: pid(1), subject: 'Your CFB ratings work', body: 'Hey Pat, saw your CFB power ratings...' })
    + SEED.draft({ id: did(2), prospect: pid(2), subject: 'Hello', body: 'Hey there, ...' })
    + SEED.draft({ id: did(3), prospect: pid(3), subject: 'Props research', body: 'Hey Sam, ...' })
    + SEED.draft({ id: did(4), prospect: pid(4), subject: 'Same address', body: 'Hey Twin, ...' })
    + SEED.draft({ id: did(5), prospect: pid(5), subject: 'Domain mate', body: 'Hey Dee, ...' })
    + SEED.draft({ id: did(7), prospect: pid(7), subject: 'Lee, your models', body: 'Hey Lee, ...' })
    + SEED.draft({ id: '20000000-0000-0000-0000-0000000000f0', prospect: '10000000-0000-0000-0000-0000000000f0', test: true, subject: '[TEST] outbound smoke', body: 'Hey there, this is a test.' }));
  const statusOf = (n) => one(`select status from growth_outbound.prospects where id = '${pid(n)}';`);
  chk('A (seed) evidence-backed prospects are ready for review; the weak one and the duplicate are not',
    [1, 3, 5, 7].every((n) => statusOf(n) === 'ready_for_review') && statusOf(2) === 'needs_research' && statusOf(4) === 'needs_research',
    [1, 2, 3, 4, 5, 7].map(statusOf));
  const P1 = '10000000-0000-0000-0000-000000000001', D1 = '20000000-0000-0000-0000-000000000001';
  const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = '${d}';`);

  /* ══ B. CATALOGUE ═════════════════════════════════════════════════════ */
  const tables = one(`select string_agg(relname, ',' order by relname) from pg_class where relnamespace = 'growth_outbound'::regnamespace and relkind = 'r';`).split(',');
  chk('B eleven outbound tables', tables.length === 11, tables);
  for (const r of ['anon', 'authenticated', 'service_role']) {
    chk('B ' + r + ' has no USAGE on the schema', one(`select has_schema_privilege('${r}', 'growth_outbound', 'usage');`) === 'f');
    const held = one(`select coalesce(string_agg(c.relname || ':' || p, ','), '') from pg_class c, unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                       where c.relnamespace = 'growth_outbound'::regnamespace and c.relkind = 'r' and has_table_privilege('${r}', c.oid, p);`);
    chk('B ' + r + ' holds no privilege on any outbound table', held === '', held);
  }
  chk('B every table has RLS on and the restrictive deny policy, and no permissive policy exists',
    one(`select count(*) from pg_class c where c.relnamespace = 'growth_outbound'::regnamespace and c.relkind = 'r' and c.relrowsecurity
          and exists (select 1 from pg_policies p where p.schemaname = 'growth_outbound' and p.tablename = c.relname and p.policyname = 'deny_clients' and p.permissive = 'RESTRICTIVE');`) === '11'
    && one(`select count(*) from pg_policies where schemaname = 'growth_outbound' and permissive = 'PERMISSIVE';`) === '0');

  /* direct reads of every table, as every non-owner role (the owner too: no direct path for anyone) */
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['a subscriber', (s) => db.as(U.sub, s)], ['a partner', (s) => db.as(U.partner, s)],
                            ['an affiliate admin', (s) => db.as(U.admin, s)], ['the owner (doors only)', (s) => db.as(U.owner, s)], ['the service role', (s) => db.service(s)]]) {
    const leaked = tables.filter((t) => !/permission denied/.test(db.mustFail(() => run(`select count(*) from growth_outbound.${t};`)) || ''));
    chk('B ' + who + ' cannot read any outbound table directly', leaked.length === 0, leaked);
  }

  const doors = one(`select string_agg(p.proname || '/' || p.pronargs, ',' order by p.proname) from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname like 'growth\\_outbound\\_%';`).split(',').map((x) => { const [n, a] = x.split('/'); return { n, a: +a }; });
  chk('B the doors exist', doors.length >= 12, doors.map((d) => d.n));
  chk('B every door is security definer with a pinned search_path', one(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname like 'growth\\_outbound\\_%' and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));`) === '0');
  const call = (d) => `select public.${d.n}(${Array(d.a).fill('null').join(', ')});`;
  for (const d of doors) {
    const anonE = db.mustFail(() => db.anon(call(d)));
    const svcE = db.mustFail(() => db.service(call(d)));
    chk('B anon cannot call ' + d.n, !!anonE && /permission denied/.test(anonE), anonE);
    chk('B the service role cannot call ' + d.n, !!svcE && /permission denied/.test(svcE), svcE);
    if (d.n === 'growth_outbound_is_owner') continue;
    for (const [who, uid] of [['subscriber', U.sub], ['partner', U.partner], ['affiliate admin', U.admin], ['stranger', U.stranger]]) {
      const e = db.mustFail(() => db.as(uid, call(d)));
      chk('B a ' + who + ' is refused by ' + d.n + ' at the owner check', !!e && NOT_OWNER.test(e), e);
    }
  }
  chk('B growth_outbound_is_owner says no to every non-owner',
    [U.sub, U.partner, U.admin, U.stranger].every((u) => db.as(u, `select public.growth_outbound_is_owner();`) === 'f'));
  chk('B … and yes to the owner', db.as(U.owner, `select public.growth_outbound_is_owner();`) === 't');

  /* ══ C. EACH LAYER ALONE: the restrictive policy, with the others removed ══ */
  one(`grant usage on schema growth_outbound to authenticated; grant select on growth_outbound.prospects to authenticated;
       create policy oops_everyone on growth_outbound.prospects for select to authenticated using (true);`);
  chk('C with schema USAGE, a table grant AND a permissive policy wrongly added, a subscriber still reads no row',
    db.as(U.sub, `select count(*) from growth_outbound.prospects;`) === '0');
  one(`drop policy oops_everyone on growth_outbound.prospects; revoke select on growth_outbound.prospects from authenticated;
       revoke usage on schema growth_outbound from authenticated;`);
  chk('C … and the mistake is undone', one(`select has_schema_privilege('authenticated', 'growth_outbound', 'usage');`) === 'f');

  /* ══ D. NO SELF-ENROLLMENT ═══════════════════════════════════════════ */
  let e = db.mustFail(() => db.as(U.admin, `insert into growth_outbound.owners (user_id) values ('${U.admin}');`));
  chk('D an affiliate admin cannot insert themselves', !!e && /permission denied/.test(e), e);
  e = db.mustFail(() => db.service(`insert into growth_outbound.owners (user_id) values ('${U.admin}');`));
  chk('D the service role cannot insert an owner', !!e && /permission denied/.test(e), e);
  one(`create function public.zz_enroll() returns void language sql security definer set search_path = public as
         $$ insert into growth_outbound.owners (user_id) values (auth.uid()) $$;
       grant execute on function public.zz_enroll() to authenticated, service_role;`);
  e = db.mustFail(() => db.as(U.admin, `select public.zz_enroll();`));
  chk('D a planted security-definer backdoor is refused by the row trigger', !!e && /SQL editor only/.test(e), e);
  e = db.mustFail(() => db.service(`select public.zz_enroll();`));
  chk('D … called with the service role too', !!e && /SQL editor only/.test(e), e);
  const WRITERS = `select coalesce(string_agg(p.proname, ','), '') from pg_proc p
     where p.prosrc ~* '(insert\\s+into|update)\\s+growth_outbound\\.owners'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));`;
  chk('D (control) the catalogue scan finds the planted backdoor', /zz_enroll/.test(one(WRITERS)));
  one(`drop function public.zz_enroll();`);
  chk('D no client-callable function writes the owner list', one(WRITERS) === '');
  chk('D the admin is still not an owner', db.as(U.admin, `select public.growth_outbound_is_owner();`) === 'f');
  e = db.mustFail(() => one(`insert into growth_outbound.owners (user_id) values ('${U.sub}');`));
  chk('D even the SQL editor cannot make a non-admin an owner (the hierarchy is a foreign key)', !!e && /foreign key/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.owners set user_id = '${U.admin}' where user_id = '${U.ex}';`));
  chk('D an owner grant cannot be moved to another account', !!e && /cannot be moved/.test(e), e);
  chk('D every grant is audited', one(`select count(*) from growth_outbound.owner_audit where action = 'granted';`) === '2');

  /* ══ E. HIERARCHY ═════════════════════════════════════════════════════ */
  chk('E an affiliate admin keeps the existing growth console', db.as(U.admin, `select public.growth_is_admin();`) === 't'
    && !!j(db.as(U.admin, `select public.growth_admin_activation(90);`)));
  chk('E the ex-owner is an owner before demotion', db.as(U.ex, `select public.growth_outbound_is_owner();`) === 't');
  one(`delete from public.affiliate_admins where user_id = '${U.ex}';`);
  chk('E removing an owner from affiliate_admins removes their outbound access', db.as(U.ex, `select public.growth_outbound_is_owner();`) === 'f'
    && one(`select count(*) from growth_outbound.owners where user_id = '${U.ex}';`) === '0');
  chk('E … and the revocation is audited', one(`select count(*) from growth_outbound.owner_audit where action = 'revoked' and user_id = '${U.ex}';`) === '1');
  one(`insert into public.affiliate_admins (user_id) values ('${U.ex}');`);
  chk('E re-adding them as an affiliate admin restores NOTHING outbound', db.as(U.ex, `select public.growth_outbound_is_owner();`) === 'f');

  /* ══ F. THE OWNER ═════════════════════════════════════════════════════ */
  const ov = j(db.as(U.owner, `select public.growth_outbound_overview();`));
  chk('F the owner reads the overview', ov.settings && ov.settings.test_mode === true && ov.prospects_by_status.ready_for_review === 4, ov.prospects_by_status);
  const list = j(db.as(U.owner, `select public.growth_outbound_prospects('ready_for_review', null, 50, 0);`));
  chk('F the owner reads prospects with their emails', list.total === 4 && list.rows.some((r) => r.email === 'pat@cfbnumbers.test'));
  const det = j(db.as(U.owner, `select public.growth_outbound_prospect('${P1}');`));
  chk('F … and one prospect\'s evidence and drafts', det.ok && det.evidence.length === 9 && det.drafts.length === 1 && det.prospect.email === 'pat@cfbnumbers.test');
  chk('F search works', j(db.as(U.owner, `select public.growth_outbound_prospects(null, 'props', 50, 0);`)).total === 2);

  let r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": 30}'::jsonb);`));
  chk('F raising the daily cap without confirmation is refused', r.ok === false && r.reason === 'cap_increase_needs_confirmation', r);
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": 30, "confirm_cap_increase": true}'::jsonb);`));
  chk('F … with confirmation it is raised, and the change is in the result', r.ok === true && r.changed.max_sends_per_day.from === 20 && r.changed.max_sends_per_day.to === 30, r);
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": 10}'::jsonb);`));
  chk('F lowering it needs no confirmation', r.ok === true && r.settings.max_sends_per_day === 10);
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": 500, "confirm_cap_increase": true}'::jsonb);`));
  chk('F the hard ceiling holds even when confirmed', r.ok === false && r.reason === 'invalid_value');
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": "lots"}'::jsonb);`));
  chk('F a non-number is refused cleanly', r.ok === false && r.reason === 'invalid_value');
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"service_role_key": "x"}'::jsonb);`));
  chk('F an unknown setting is refused (no secret can be stored here)', r.ok === false && r.reason === 'unknown_setting');
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"sender_email": "davis@evil.test"}'::jsonb);`));
  chk('F the sender cannot leave EdgeDesk\'s domain', r.ok === false && r.reason === 'invalid_value');
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"cta_url": "https://edgedesksports.com.evil.test/"}'::jsonb);`));
  chk('F the call to action cannot point anywhere but EdgeDesk', r.ok === false && r.reason === 'invalid_value');
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"test_mode": false}'::jsonb);`));
  chk('F leaving test mode needs explicit confirmation', r.ok === false && r.reason === 'going_live_needs_confirmation');
  const logged = j(db.as(U.owner, `select public.growth_outbound_activity(50, null);`)).filter((a) => a.action === 'settings_changed');
  chk('F every settings change is logged with the owner as actor', logged.length === 2 && logged.every((a) => a.actor_user_id === U.owner && a.actor_kind === 'owner'), logged.length);

  /* ══ G. APPROVAL ══════════════════════════════════════════════════════ */
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D1}', 'not-the-hash');`));
  chk('G approving content other than what is stored is refused', r.ok === false && r.reason === 'content_changed');
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('20000000-0000-0000-0000-000000000002', ${lit(hashOf('20000000-0000-0000-0000-000000000002'))});`));
  chk('G a prospect below the confidence gates cannot be approved', r.ok === false && r.reason === 'below_gate' && r.gates.length >= 4, r);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D1}', ${lit(hashOf(D1))});`));
  chk('G the owner approves the reviewed content', r.ok === true);
  chk('G … recorded as theirs, for that hash and recipient', one(`select status || '|' || approved_by || '|' || (approved_hash = content_hash) || '|' || approved_recipient from growth_outbound.drafts where id = '${D1}';`)
    === `approved|${U.owner}|true|pat@cfbnumbers.test`);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D1}', ${lit(hashOf(D1))});`));
  chk('G approving twice is refused (not pending review)', r.ok === false && r.reason === 'not_pending_review');

  e = db.mustFail(() => one(`update growth_outbound.drafts set status = 'approved', approved_at = now(), approved_by = '${U.owner}', approved_hash = content_hash, approved_recipient = 'sam@propslab.test' where id = '20000000-0000-0000-0000-000000000003';`));
  chk('G a direct UPDATE to approved is refused — even for the superuser, outside the door', !!e && /only the approve door/.test(e), e);
  e = db.mustFail(() => one(`begin; select set_config('growth_outbound.door', 'approve', true);
      update growth_outbound.drafts set status = 'approved', approved_at = now(), approved_by = '${U.owner}', approved_hash = content_hash, approved_recipient = 'sam@propslab.test' where id = '20000000-0000-0000-0000-000000000003'; commit;`));
  chk('G … and faking the door from a session that is not the signed-in owner is refused', !!e && /signed-in owner/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.drafts (prospect_id, subject, body_text, status) values ('10000000-0000-0000-0000-000000000003', 's', 'b', 'approved');`));
  chk('G a draft cannot be born approved', !!e && /only an owner approves/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.drafts set body_text = 'changed after approval' where id = '${D1}';`));
  chk('G an approved draft cannot be changed', !!e && /cannot change/.test(e), e);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_edit('${D1}', 'Your CFB power ratings', 'Hey Pat, edited by me.', ${lit(hashOf(D1))});`));
  chk('G the owner\'s edit returns the draft to review and clears the approval', r.ok === true && r.status === 'pending_review'
    && one(`select (approved_by is null and approved_at is null and edited_by_owner)::text from growth_outbound.drafts where id = '${D1}';`) === 'true');
  r = j(db.as(U.owner, `select public.growth_outbound_draft_edit('${D1}', 'x', 'y', 'stale-hash');`));
  chk('G an edit against a stale version is refused', r.ok === false && r.reason === 'content_changed');
  r = j(db.as(U.owner, `select public.growth_outbound_draft_edit('${D1}', '', 'y', ${lit(hashOf(D1))});`));
  chk('G an empty subject is refused', r.ok === false && r.reason === 'invalid_content');
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D1}', ${lit(hashOf(D1))});`));
  chk('G … and the edited version can be approved', r.ok === true);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_reject('20000000-0000-0000-0000-000000000002', 'not a fit');`));
  chk('G reject works and is logged', r.ok === true && one(`select status from growth_outbound.drafts where id = '20000000-0000-0000-0000-000000000002';`) === 'rejected');

  /* ══ H. SUPPRESSION ═══════════════════════════════════════════════════ */
  const D3 = '20000000-0000-0000-0000-000000000003', D5 = '20000000-0000-0000-0000-000000000005';
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D3}', ${lit(hashOf(D3))});`));
  chk('H (setup) Sam\'s draft is approved', r.ok === true);
  r = j(db.as(U.owner, `select public.growth_outbound_suppress('propslab.test', 'do_not_contact', 'asked us not to', 'domain');`));
  chk('H suppressing a domain suppresses every prospect there and cancels their drafts, approved ones included', r.ok === true && r.prospects_suppressed === 2 && r.drafts_cancelled === 2, r);
  chk('H … Sam\'s approval is gone', one(`select status || '|' || coalesce(approved_by::text, 'none') from growth_outbound.drafts where id = '${D3}';`) === 'cancelled|none');
  one(`insert into growth_outbound.drafts (id, prospect_id, sequence_number, subject, body_text) values ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', 2, 'again', 'again');`);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('20000000-0000-0000-0000-000000000006', ${lit(hashOf('20000000-0000-0000-0000-000000000006'))});`));
  chk('H a suppressed prospect cannot be approved', r.ok === false && /suppressed/.test(r.reason), r);
  r = j(db.as(U.owner, `select public.growth_outbound_suppress('not an email', 'manual', null, 'address');`));
  chk('H a malformed target is refused', r.ok === false);
  e = db.mustFail(() => one(`delete from growth_outbound.suppressions;`));
  chk('H a suppression cannot be deleted, even by the superuser', !!e && /append-only/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.suppressions set kind = 'manual';`));
  chk('H … or rewritten', !!e && /append-only/.test(e), e);

  /* ══ I. SENDS ═════════════════════════════════════════════════════════ */
  const send = (o) => `begin; ${o.door === false ? '' : "select set_config('growth_outbound.door', 'claim_send', true);"}
    insert into growth_outbound.sends (prospect_id, draft_id, sequence_number, is_test, idempotency_key, sender, intended_recipient, recipient, subject, content_hash, claimed_by)
    select d.prospect_id, d.id, d.sequence_number, ${o.test ? 'true' : 'false'}, ${lit(o.key || ('k-' + Math.random()))}, 'x',
           ${lit(o.intended)}, ${lit(o.recipient)}, d.subject, ${o.hash ? lit(o.hash) : 'd.content_hash'}, ${lit(o.by || U.owner)}
      from growth_outbound.drafts d where d.id = ${lit(o.draft)}; commit;`;
  e = db.mustFail(() => one(send({ draft: D1, intended: 'pat@cfbnumbers.test', recipient: 'pat@cfbnumbers.test', door: false })));
  chk('I no send row without the claim door', !!e && /claim door/.test(e), e);
  e = db.mustFail(() => one(send({ draft: '20000000-0000-0000-0000-000000000004', intended: 'pat@cfbnumbers.test', recipient: 'pat@cfbnumbers.test' })));
  chk('I an unapproved draft cannot be sent', !!e && /approved draft/.test(e), e);
  e = db.mustFail(() => one(send({ draft: D1, intended: 'pat@cfbnumbers.test', recipient: 'pat@cfbnumbers.test' })));
  chk('I nothing is sent while the compliance configuration is incomplete', !!e && /sending is blocked: postal_address_missing/.test(e), e);
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update(${lit(JSON.stringify({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', test_inbox: 'Owner-Test@EdgeDesk.test' }))}::jsonb);`));
  chk('I (setup) compliance configured; nothing blocks now', r.ok === true && r.settings.send_blockers.length === 0, r.settings && r.settings.send_blockers);
  e = db.mustFail(() => one(send({ draft: D1, intended: 'pat@cfbnumbers.test', recipient: 'pat@cfbnumbers.test', by: U.admin })));
  chk('I a send claimed by a non-owner is refused', !!e && /outbound owner only|triggered by an outbound owner/.test(e), e);
  e = db.mustFail(() => one(send({ draft: D1, intended: 'pat@cfbnumbers.test', recipient: 'pat@cfbnumbers.test' })));
  chk('I in test mode a real recipient is refused', !!e && /test inbox only/.test(e), e);
  one(send({ draft: D1, test: true, intended: 'pat@cfbnumbers.test', recipient: 'owner-test@edgedesk.test', key: 'test-1' }));
  chk('I in test mode the send goes to the owner\'s test inbox, marked TEST', one(`select is_test || '|' || recipient || '|' || sender from growth_outbound.sends where idempotency_key = 'test-1';`)
    === 'true|owner-test@edgedesk.test|Davis <davis@edgedesksports.com>');
  e = db.mustFail(() => one(send({ draft: D1, test: true, intended: 'pat@cfbnumbers.test', recipient: 'owner-test@edgedesk.test', key: 'test-2' })));
  chk('I a draft is sent at most once (double click, retry)', !!e && /duplicate key|unique/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.sends set recipient = 'someone@else.test' where idempotency_key = 'test-1';`));
  chk('I a send\'s recorded content cannot be rewritten', !!e && /only its delivery state/.test(e), e);
  one(`update growth_outbound.sends set delivery_status = 'delivered', delivered_at = now(), resend_message_id = 'msg_1' where idempotency_key = 'test-1';`);
  chk('I … its delivery state can be', one(`select delivery_status from growth_outbound.sends where idempotency_key = 'test-1';`) === 'delivered');

  // go live, deliberately
  r = j(db.as(U.owner, `select public.growth_outbound_settings_update('{"test_mode": false, "confirm_live": true}'::jsonb);`));
  chk('I (setup) the owner leaves test mode with confirmation', r.ok === true && r.settings.test_mode === false);
  e = db.mustFail(() => one(`insert into growth_outbound.drafts (prospect_id, subject, body_text) values ('${P1}', 'Second step-1 draft', 'Hey Pat');`));
  chk('I a prospect never has two live drafts for the same step', !!e && /drafts_one_live_uk/.test(e), e);
  const D4 = did(4), D7 = did(7);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D4}', ${lit(hashOf(D4))});`));
  chk('I a draft for a duplicate row (the same address as Pat) cannot be approved', r.ok === false && r.reason === 'below_gate'
    && r.gates.includes('duplicate of another prospect'), r);
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${D7}', ${lit(hashOf(D7))});`));
  chk('I (setup) a live draft for Lee is approved', r.ok === true, r);
  e = db.mustFail(() => one(send({ draft: D7, test: true, intended: 'lee@leelab.test', recipient: 'owner-test@edgedesk.test' })));
  chk('I live, a send cannot be diverted or marked test', !!e && /approved recipient only/.test(e), e);
  e = db.mustFail(() => one(send({ draft: D7, intended: 'someone@else.test', recipient: 'someone@else.test' })));
  chk('I a send to any address but the approved one is refused', !!e && /not the one that was approved/.test(e), e);
  one(send({ draft: D7, intended: 'lee@leelab.test', recipient: 'lee@leelab.test', key: 'live-1' }));
  chk('I the approved live send is claimed', one(`select delivery_status || '|' || is_test from growth_outbound.sends where idempotency_key = 'live-1';`) === 'claimed|false');

  // the same address on another prospect row (a duplicate discovery), same
  // step. The approve door refuses it; even an approval that slipped past
  // (a door with a bug, simulated here) does not send.
  one(SEED.strong({ id: pid(9), name: 'Lee Again', org: 'Lee Again Media', email: 'lee@leelab.test', domain: 'leeagain.test', handle: 'leeagain' })
    + SEED.draft({ id: did(9), prospect: pid(9), subject: 'Hi again', body: 'Hey Lee' }));
  r = j(db.as(U.owner, `select public.growth_outbound_draft_approve('${did(9)}', ${lit(hashOf(did(9)))});`));
  chk('I the duplicate row\'s draft is refused at approval', r.ok === false && r.gates.includes('duplicate of another prospect'), r);
  one(`begin; select set_config('request.jwt.claim.sub', '${U.owner}', true); select set_config('growth_outbound.door', 'approve', true);
       update growth_outbound.drafts set status = 'approved', approved_at = now(), approved_by = '${U.owner}', approved_hash = content_hash,
              approved_recipient = 'lee@leelab.test' where id = '${did(9)}'; commit;`);
  e = db.mustFail(() => one(send({ draft: did(9), intended: 'lee@leelab.test', recipient: 'lee@leelab.test' })));
  chk('I an address never receives the same step twice, whatever prospect row it is on', !!e && /already received step 1/.test(e), e);

  // the daily cap
  one(SEED.strong({ id: '10000000-0000-0000-0000-00000000000a', name: 'Cap Test', org: 'Cap Test Media', email: 'cap@captest.test', domain: 'captest.test', handle: 'captest' })
    + SEED.draft({ id: '20000000-0000-0000-0000-00000000000a', prospect: '10000000-0000-0000-0000-00000000000a', subject: 'Cap', body: 'Hey there' }));
  db.as(U.owner, `select public.growth_outbound_draft_approve('20000000-0000-0000-0000-00000000000a', ${lit(hashOf('20000000-0000-0000-0000-00000000000a'))});`);
  db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": 1}'::jsonb);`);
  e = db.mustFail(() => one(send({ draft: '20000000-0000-0000-0000-00000000000a', intended: 'cap@captest.test', recipient: 'cap@captest.test' })));
  chk('I the daily cap is enforced on the table, not the page', !!e && /daily send cap \(1\)/.test(e), e);
  db.as(U.owner, `select public.growth_outbound_settings_update('{"max_sends_per_day": 5, "confirm_cap_increase": true}'::jsonb);`);
  db.as(U.owner, `select public.growth_outbound_suppress('cap@captest.test', 'unsubscribe', 'replied: stop', 'address');`);
  e = db.mustFail(() => one(send({ draft: '20000000-0000-0000-0000-00000000000a', intended: 'cap@captest.test', recipient: 'cap@captest.test' })));
  chk('I a suppressed address cannot be sent to (its approved draft was cancelled)', !!e && /approved draft|suppressed/.test(e), e);

  // the approving owner demoted: their approvals no longer send
  one(`insert into public.affiliate_admins (user_id) values ('${U.stranger}') on conflict do nothing;
       insert into growth_outbound.owners (user_id, note) values ('${U.stranger}', 'temp owner');`);
  one(SEED.strong({ id: '10000000-0000-0000-0000-00000000000b', name: 'Demote Test', org: 'Demote Media', email: 'demote@demote.test', domain: 'demote.test', handle: 'demotetest' })
    + SEED.draft({ id: '20000000-0000-0000-0000-00000000000b', prospect: '10000000-0000-0000-0000-00000000000b', subject: 'Demote', body: 'Hey there' }));
  r = j(db.as(U.stranger, `select public.growth_outbound_draft_approve('20000000-0000-0000-0000-00000000000b', ${lit(hashOf('20000000-0000-0000-0000-00000000000b'))});`));
  one(`delete from growth_outbound.owners where user_id = '${U.stranger}';`);
  e = db.mustFail(() => one(send({ draft: '20000000-0000-0000-0000-00000000000b', intended: 'demote@demote.test', recipient: 'demote@demote.test' })));
  chk('I a draft approved by an owner who has since been removed does not send', r.ok === true && !!e && /no longer an owner/.test(e), e);

  /* ══ J. HISTORY ═══════════════════════════════════════════════════════ */
  for (const t of ['activity', 'owner_audit']) {
    e = db.mustFail(() => one(`delete from growth_outbound.${t};`));
    chk('J ' + t + ' cannot be deleted', !!e && /append-only/.test(e), e);
  }
  for (const t of ['prospects', 'evidence', 'drafts', 'sends']) {
    e = db.mustFail(() => one(`delete from growth_outbound.${t};`));
    chk('J ' + t + ' rows are never deleted', !!e && /never deleted/.test(e), e);
  }
  e = db.mustFail(() => one(`update growth_outbound.evidence set claim = 'a better story' where prospect_id = '${P1}';`));
  chk('J evidence is never rewritten', !!e && /never rewritten/.test(e), e);
  one(`update growth_outbound.evidence set superseded_at = now() where prospect_id = '${P1}';`);
  e = db.mustFail(() => one(`update growth_outbound.evidence set superseded_at = now() + interval '1 day' where prospect_id = '${P1}';`));
  chk('J … it can be marked superseded once, and that mark is final', !!e && /never rewritten/.test(e), e);
  const acts = j(db.as(U.owner, `select public.growth_outbound_activity(500, null);`)).map((a) => a.action);
  chk('J the owner\'s actions are all on the record', ['settings_changed', 'draft_approved', 'draft_edited', 'draft_rejected', 'suppression_created'].every((a) => acts.includes(a)), [...new Set(acts)]);
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
