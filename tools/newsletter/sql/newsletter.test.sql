-- ===========================================================================
-- supabase/newsletter.sql, ATTACKED.
--
-- This schema decides whether strangers receive email, so the checks are
-- about what is IMPOSSIBLE rather than about what works:
--
--   1  NO CLIENT ROLE CAN READ A SUBSCRIBER ADDRESS — not anon, not a
--      signed-in reader, not an operator. Row level security is on and there
--      is no select policy for anybody.
--   2  SENDING IS OFF until somebody turns it on, and only an operator can.
--   3  ONE EDITION per sport, season, slate week and scheduled date.
--   4  ONE DELIVERY ROW per (edition, address), so a retry cannot become a
--      second email.
--   5  ONE PROCESSED EVENT per provider event id.
--   6  ONE WORKER at a time owns an edition.
--   7  A COMPLAINT OUTRANKS a bounce outranks an unsubscribe, and nothing a
--      click can do clears the first two.
--   8  DOUBLE OPT-IN cannot be short-circuited from the table.
--
-- Every check raises on failure, so reaching the end is the suite passing.
-- ===========================================================================

\set ON_ERROR_STOP on

create or replace function pg_temp.chk(name text, cond boolean) returns void
language plpgsql as $$
begin
  if cond then raise notice 'ok  %', name;
  else raise exception 'FAIL: %', name; end if;
end $$;

-- Two identities to attack as.
do $$
declare uid uuid; oid_ uuid;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (gen_random_uuid(), 'reader@example.com', now()) returning id into uid;
  insert into auth.users (id, email, email_confirmed_at)
  values (gen_random_uuid(), 'operator@example.com', now()) returning id into oid_;
  insert into public.site_article_admins (user_id, note) values (oid_, 'sql suite');
  perform set_config('nl.reader', uid::text, false);
  perform set_config('nl.operator', oid_::text, false);
end $$;

-- ===========================================================================
-- 1 — THE SUBSCRIBER TABLE IS UNREADABLE FROM A BROWSER
-- ===========================================================================
do $$
declare r jsonb; n integer;
begin
  r := public.newsletter_signup('secret@example.com', true, true, 'public_form');
  perform pg_temp.chk('a signup creates a pending row', r->>'state' = 'pending');
  perform pg_temp.chk('a signup returns a confirmation token once', (r->>'confirm_token') is not null);
  perform set_config('nl.confirm', r->>'confirm_token', false);

  select count(*) into n from public.newsletter_subscribers;
  perform pg_temp.chk('the service role can see the row', n = 1);
end $$;

-- as anon
set role anon;
do $$
declare n integer; err text;
begin
  begin
    select count(*) into n from public.newsletter_subscribers;
    perform pg_temp.chk('anon sees no subscriber row', n = 0);
  exception when insufficient_privilege then
    perform pg_temp.chk('anon cannot even select the subscriber table', true);
  end;
  begin
    insert into public.newsletter_subscribers (email, manage_token) values ('anon@example.com', 'x');
    perform pg_temp.chk('anon CANNOT insert a subscriber', false);
  exception when others then
    perform pg_temp.chk('anon cannot insert a subscriber', true);
  end;
  begin
    perform public.newsletter_signup('anon@example.com', true, false, 'x');
    perform pg_temp.chk('anon CANNOT call the signup door', false);
  exception when insufficient_privilege then
    perform pg_temp.chk('anon cannot call the signup door', true);
  end;
  begin
    perform * from public.newsletter_eligible('NFL');
    perform pg_temp.chk('anon CANNOT call the eligibility door', false);
  exception when insufficient_privilege then
    perform pg_temp.chk('anon cannot call the eligibility door', true);
  end;
  begin
    perform public.newsletter_claim_edition('x', 'y', 60);
    perform pg_temp.chk('anon CANNOT claim an edition', false);
  exception when insufficient_privilege then
    perform pg_temp.chk('anon cannot claim an edition', true);
  end;
  err := '';
end $$;
reset role;

-- as a signed-in reader
set role authenticated;
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('nl.reader'), true);
  begin
    select count(*) into n from public.newsletter_subscribers;
    perform pg_temp.chk('a signed-in reader sees no subscriber row', n = 0);
  exception when insufficient_privilege then
    perform pg_temp.chk('a signed-in reader cannot select the subscriber table', true);
  end;
  begin
    perform public.newsletter_admin_overview();
    perform pg_temp.chk('a non-operator CANNOT read the operator console', false);
  exception when others then
    perform pg_temp.chk('a non-operator cannot read the operator console', true);
  end;
  begin
    perform public.newsletter_admin_set('{"sending_enabled": true}'::jsonb);
    perform pg_temp.chk('a non-operator CANNOT open the launch gate', false);
  exception when others then
    perform pg_temp.chk('a non-operator cannot open the launch gate', true);
  end;
end $$;
reset role;

-- and the operator sees counts, never addresses
set role authenticated;
do $$
declare o jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('nl.operator'), true);
  o := public.newsletter_admin_overview();
  perform pg_temp.chk('an operator can read the console', (o->'subscribers') is not null);
  perform pg_temp.chk('the console reports a pending count', (o->'subscribers'->>'pending')::int = 1);
  perform pg_temp.chk('the console carries no subscriber address',
    position('secret@example.com' in o::text) = 0);
  begin
    perform count(*) from public.newsletter_subscribers;
    perform pg_temp.chk('an operator CANNOT read the subscriber table directly', false);
  exception when others then
    perform pg_temp.chk('an operator cannot read the subscriber table directly', true);
  end;
end $$;
reset role;

-- ===========================================================================
-- 2 — CONSENT, DOUBLE OPT-IN AND ELIGIBILITY
-- ===========================================================================
do $$
declare r jsonb; m text; n integer;
begin
  perform pg_temp.chk('a pending subscriber is not eligible', public.newsletter_eligible_count('NFL') = 0);

  r := public.newsletter_confirm('not-the-token');
  perform pg_temp.chk('an unknown confirmation token is refused', (r->>'ok')::boolean is false);

  r := public.newsletter_confirm(current_setting('nl.confirm'));
  perform pg_temp.chk('the right confirmation token confirms', (r->>'ok')::boolean);
  perform pg_temp.chk('confirmation returns a masked address only',
    (r->>'email_masked') = 's***@example.com');
  m := r->>'manage_token';
  perform set_config('nl.manage', m, false);

  perform pg_temp.chk('a confirmed subscriber is eligible for both sports',
    public.newsletter_eligible_count('NFL') = 1 and public.newsletter_eligible_count('CFB') = 1);

  r := public.newsletter_confirm(current_setting('nl.confirm'));
  perform pg_temp.chk('a confirmation token cannot be used twice', (r->>'ok')::boolean is false);

  -- sport preferences are separate
  r := public.newsletter_preferences_set(m, false, true);
  perform pg_temp.chk('turning college football off leaves the NFL on',
    public.newsletter_eligible_count('CFB') = 0 and public.newsletter_eligible_count('NFL') = 1);
  r := public.newsletter_preferences_set(m, true, true);
  perform pg_temp.chk('turning it back on restores eligibility',
    public.newsletter_eligible_count('CFB') = 1);

  select count(*) into n from public.newsletter_eligible('NFL') e where e.manage_token = m;
  perform pg_temp.chk('the send path can read this subscriber’s own manage token', n = 1);
end $$;

-- an account is not consent
do $$
declare n integer;
begin
  select count(*) into n from public.newsletter_subscribers where email = 'reader@example.com';
  perform pg_temp.chk('having an account does not create a subscriber row', n = 0);
end $$;

set role authenticated;
do $$
declare r jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('nl.reader'), true);
  r := public.newsletter_my_preferences();
  perform pg_temp.chk('an account holder starts unsubscribed', (r->>'subscribed')::boolean is false);
  r := public.newsletter_set_my_preferences(true, false, 'account_settings');
  perform pg_temp.chk('an account holder can subscribe themselves', (r->>'subscribed')::boolean);
  r := public.newsletter_my_preferences();
  perform pg_temp.chk('…and reads back only a masked address',
    (r->>'email_masked') = 'r***@example.com');
end $$;
reset role;

do $$
begin
  perform pg_temp.chk('the account holder is now eligible for CFB only',
    public.newsletter_eligible_count('CFB') = 2 and public.newsletter_eligible_count('NFL') = 1);
end $$;

-- ===========================================================================
-- 2b — THE ONE PUBLIC DOOR IS RATE LIMITED
--
-- /subscribe cannot require a session: a stranger signing up has none. Which
-- means anybody who can reach it can make a VERIFIED EDGEDESK DOMAIN send
-- mail to any address they name. Unthrottled that is an email-bombing service
-- with our sending reputation attached. Both caps live here rather than in the
-- edge runtime, so no client and no redeploy goes around them.
-- ===========================================================================
do $$
declare r jsonb; i int; issued int := 0; cap int;
begin
  r := public.newsletter_signup('rl@example.com', true, false, 'public_form', 'ua', 'hash-rl');
  perform pg_temp.chk('a first signup is issued a confirmation token', (r->>'confirm_token') is not null);

  r := public.newsletter_signup('rl@example.com', true, true, 'public_form', 'ua', 'hash-rl');
  perform pg_temp.chk('an immediate repeat is issued NO second token', (r->>'confirm_token') is null);
  perform pg_temp.chk('…and says it was the cooldown', r->>'throttled' = 'cooldown');
  perform pg_temp.chk('…and still looks identical to the caller', r->>'state' = 'pending');
  perform pg_temp.chk('…but the preference change is still recorded, so correcting a choice is not punished',
    (select wants_nfl from public.newsletter_subscribers where email = 'rl@example.com'));

  update public.newsletter_subscribers set confirm_sent_at = now() - interval '20 minutes'
   where email = 'rl@example.com';
  r := public.newsletter_signup('rl@example.com', true, false, 'public_form', 'ua', 'hash-rl');
  perform pg_temp.chk('past the cooldown a new token is issued', (r->>'confirm_token') is not null);

  select signup_per_ip_hour into cap from public.newsletter_settings where id = 1;
  for i in 1..(cap + 4) loop
    r := public.newsletter_signup('flood' || i || '@example.com', true, false, 'public_form', 'ua', 'hash-flood');
    if (r->>'confirm_token') is not null then issued := issued + 1; end if;
  end loop;
  perform pg_temp.chk('a flood from one source stops at the cap', issued = cap);
  r := public.newsletter_signup('elsewhere@example.com', true, false, 'public_form', 'ua', 'hash-other');
  perform pg_temp.chk('a different source is unaffected by it', (r->>'confirm_token') is not null);

  -- and the cap is a setting an operator can move, not a literal
  begin
    update public.newsletter_settings set signup_per_ip_hour = 0 where id = 1;
    perform pg_temp.chk('a cap of zero was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('a cap that would block every signup is refused', true);
  end;
end $$;

-- ===========================================================================
-- 3 — UNSUBSCRIBE WITHOUT A LOGIN, AND SUPPRESSION PRECEDENCE
-- ===========================================================================
do $$
declare r jsonb; m text;
begin
  m := current_setting('nl.manage');
  r := public.newsletter_unsubscribe('wrong-token', 'all', 'one_click');
  perform pg_temp.chk('an unknown manage token unsubscribes nobody', (r->>'ok')::boolean is false);

  r := public.newsletter_unsubscribe(m, 'CFB', 'one_click');
  perform pg_temp.chk('a single-sport unsubscribe leaves the other sport', r->>'state' = 'partial');
  perform pg_temp.chk('…and takes effect immediately', public.newsletter_eligible_count('CFB') = 1);

  r := public.newsletter_unsubscribe(m, 'NFL', 'one_click');
  perform pg_temp.chk('unsubscribing the last sport unsubscribes the address', r->>'state' = 'unsubscribed');
  perform pg_temp.chk('…and suppresses it', exists (
    select 1 from public.newsletter_suppressions where email = 'secret@example.com' and reason = 'unsubscribe'));
  perform pg_temp.chk('…and removes it from every sport', public.newsletter_eligible_count('NFL') = 0);

  -- resubscribing clears an unsubscribe suppression
  r := public.newsletter_preferences_set(m, true, true);
  perform pg_temp.chk('the preferences page can resubscribe after an unsubscribe',
    public.newsletter_eligible_count('NFL') = 1);
  perform pg_temp.chk('…and the unsubscribe suppression is cleared', not exists (
    select 1 from public.newsletter_suppressions where email = 'secret@example.com'));

  -- a bounce is stronger
  perform public.newsletter_suppress('secret@example.com', 'bounce', 'mailbox does not exist', 'evt_b');
  perform pg_temp.chk('a bounce suppresses immediately', public.newsletter_eligible_count('NFL') = 0);
  perform public.newsletter_suppress('secret@example.com', 'unsubscribe', 'later', 'evt_u');
  perform pg_temp.chk('a later unsubscribe does not downgrade a bounce', (
    select reason from public.newsletter_suppressions where email = 'secret@example.com') = 'bounce');
  perform public.newsletter_suppress('secret@example.com', 'complaint', 'reported as spam', 'evt_c');
  perform pg_temp.chk('a complaint outranks a bounce', (
    select reason from public.newsletter_suppressions where email = 'secret@example.com') = 'complaint');
  perform public.newsletter_suppress('secret@example.com', 'bounce', 'again', 'evt_b2');
  perform pg_temp.chk('and nothing downgrades a complaint', (
    select reason from public.newsletter_suppressions where email = 'secret@example.com') = 'complaint');

  r := public.newsletter_signup('secret@example.com', true, true, 'public_form');
  perform pg_temp.chk('a complained address cannot resubscribe through the form', r->>'state' = 'suppressed');
  perform pg_temp.chk('…and no new confirmation token is issued', (r->>'confirm_token') is null);
  r := public.newsletter_preferences_set(m, true, true);
  perform pg_temp.chk('…and the preferences page cannot revive it either',
    public.newsletter_eligible_count('NFL') = 0);
end $$;

-- ===========================================================================
-- 4 — ONE EDITION, ONE LEASE, ONE DELIVERY ROW, ONE EVENT
-- ===========================================================================
do $$
declare eid bigint; n integer;
begin
  insert into public.newsletter_editions (edition_key, sport, season, slate_week, edition_date, status,
    subject, html_free, text_free, game_count)
  values ('NFL:2026:W02:2026-09-15', 'NFL', 2026, 2, '2026-09-15', 'ready', 's', 'h', 't', 5)
  returning id into eid;
  perform set_config('nl.edition', eid::text, false);

  begin
    insert into public.newsletter_editions (edition_key, sport, season, slate_week, edition_date, status)
    values ('NFL:2026:W02:2026-09-15-again', 'NFL', 2026, 2, '2026-09-15', 'planned');
    perform pg_temp.chk('a SECOND edition for the same identity was accepted', false);
  exception when unique_violation then
    perform pg_temp.chk('a second edition for the same sport, season, week and date is refused', true);
  end;

  -- a held edition must say why
  begin
    insert into public.newsletter_editions (edition_key, sport, season, slate_week, edition_date, status)
    values ('NFL:2026:W03:2026-09-22', 'NFL', 2026, 3, '2026-09-22', 'held');
    perform pg_temp.chk('a held edition with NO reason was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('a held edition must state a reason', true);
  end;

  -- a sent edition must carry a body and at least one game
  begin
    insert into public.newsletter_editions (edition_key, sport, season, slate_week, edition_date, status)
    values ('CFB:2026:W03:2026-09-21', 'CFB', 2026, 3, '2026-09-21', 'sent');
    perform pg_temp.chk('an EMPTY sent edition was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('a sent edition must carry a body and at least one game', true);
  end;

  -- an unknown sport or status is refused
  begin
    insert into public.newsletter_editions (edition_key, sport, season, slate_week, edition_date, status)
    values ('MLB:2026:W03:2026-09-21', 'MLB', 2026, 3, '2026-09-21', 'planned');
    perform pg_temp.chk('an unknown sport was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('an unknown sport is refused', true);
  end;

  -- THE LEASE
  perform pg_temp.chk('the first worker claims the edition',
    public.newsletter_claim_edition('NFL:2026:W02:2026-09-15', 'worker-a', 1800));
  perform pg_temp.chk('a second worker is refused while the lease holds',
    not public.newsletter_claim_edition('NFL:2026:W02:2026-09-15', 'worker-b', 1800));
  perform pg_temp.chk('the holder may re-claim its own lease',
    public.newsletter_claim_edition('NFL:2026:W02:2026-09-15', 'worker-a', 1800));
  -- an expired lease is takeable, which is what stops a crashed runner wedging a week
  update public.newsletter_editions set lease_expires_at = now() - interval '1 minute'
   where edition_key = 'NFL:2026:W02:2026-09-15';
  perform pg_temp.chk('an expired lease can be taken over',
    public.newsletter_claim_edition('NFL:2026:W02:2026-09-15', 'worker-b', 1800));
  perform pg_temp.chk('releasing a lease you do not hold does nothing',
    not public.newsletter_release_edition('NFL:2026:W02:2026-09-15', 'worker-a'));
  perform pg_temp.chk('releasing your own lease works',
    public.newsletter_release_edition('NFL:2026:W02:2026-09-15', 'worker-b'));

  -- ONE DELIVERY ROW PER (EDITION, ADDRESS)
  insert into public.newsletter_deliveries (edition_id, email, idempotency_key, status)
  values (eid, 'Someone@Example.com', 'k1', 'queued');
  perform pg_temp.chk('an address is lowercased on the way in',
    exists (select 1 from public.newsletter_deliveries where email = 'someone@example.com'));
  begin
    insert into public.newsletter_deliveries (edition_id, email, idempotency_key, status)
    values (eid, 'someone@example.com', 'k2', 'queued');
    perform pg_temp.chk('a SECOND delivery row for the same address was accepted', false);
  exception when unique_violation then
    perform pg_temp.chk('one delivery row per edition and address', true);
  end;

  -- ACCEPTANCE IS NOT DELIVERY, and a later state never erases the earlier one
  update public.newsletter_deliveries set status = 'accepted', provider_message_id = 'm1'
   where edition_id = eid and email = 'someone@example.com';
  perform pg_temp.chk('acceptance stamps accepted_at', (
    select accepted_at is not null from public.newsletter_deliveries
     where edition_id = eid and email = 'someone@example.com'));
  perform pg_temp.chk('acceptance does not stamp delivered_at', (
    select delivered_at is null from public.newsletter_deliveries
     where edition_id = eid and email = 'someone@example.com'));
  update public.newsletter_deliveries set status = 'delivered'
   where edition_id = eid and email = 'someone@example.com';
  perform pg_temp.chk('delivery stamps delivered_at and keeps accepted_at', (
    select delivered_at is not null and accepted_at is not null from public.newsletter_deliveries
     where edition_id = eid and email = 'someone@example.com'));

  begin
    insert into public.newsletter_deliveries (edition_id, email, idempotency_key, status)
    values (eid, 'x@example.com', 'k3', 'teleported');
    perform pg_temp.chk('an unknown delivery status was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('an unknown delivery status is refused', true);
  end;

  -- ONE PROCESSED EVENT PER PROVIDER EVENT ID
  insert into public.newsletter_events (provider, event_id, event_type, email, message_id, payload)
  values ('resend', 'evt_1', 'email.delivered', 'someone@example.com', 'm1', '{}'::jsonb);
  begin
    insert into public.newsletter_events (provider, event_id, event_type, payload)
    values ('resend', 'evt_1', 'email.delivered', '{}'::jsonb);
    perform pg_temp.chk('a DUPLICATE provider event was accepted', false);
  exception when unique_violation then
    perform pg_temp.chk('a duplicate provider event is refused', true);
  end;
  insert into public.newsletter_events (provider, event_id, event_type, payload)
  values ('resend', null, 'email.opened', '{}'::jsonb);
  insert into public.newsletter_events (provider, event_id, event_type, payload)
  values ('resend', null, 'email.opened', '{}'::jsonb);
  select count(*) into n from public.newsletter_events where event_id is null;
  perform pg_temp.chk('an event with no id is stored rather than deduplicated away', n = 2);
end $$;

-- ===========================================================================
-- 5 — THE SWITCHES
-- ===========================================================================
do $$
declare s jsonb;
begin
  perform pg_temp.chk('sending is off out of the box',
    (select not sending_enabled from public.newsletter_settings where id = 1));
  begin
    update public.newsletter_settings set retry_window_minutes = 0 where id = 1;
    perform pg_temp.chk('a zero retry window was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('a retry window that would make every edition stale is refused', true);
  end;
  begin
    update public.newsletter_settings set from_email = 'not-an-address' where id = 1;
    perform pg_temp.chk('a sender with no @ was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('a sender address with no @ is refused', true);
  end;
  begin
    update public.newsletter_settings set max_games = 2, target_games = 5 where id = 1;
    perform pg_temp.chk('a cap below the target was accepted', false);
  exception when check_violation then
    perform pg_temp.chk('a maximum below the target is refused', true);
  end;
end $$;

set role authenticated;
do $$
declare s jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('nl.operator'), true);
  s := public.newsletter_admin_set('{"sending_enabled": true, "cfb_enabled": false}'::jsonb);
  perform pg_temp.chk('an operator can open the launch gate', (s->>'sending_enabled')::boolean);
  perform pg_temp.chk('an operator can pause one sport', (s->>'cfb_enabled')::boolean is false);
  begin
    perform public.newsletter_admin_set('{"subscriber_count": 9999}'::jsonb);
    perform pg_temp.chk('an unknown settings field was accepted', false);
  exception when others then
    perform pg_temp.chk('a settings field that is not on the list is refused', true);
  end;
end $$;
reset role;

do $$
declare n integer;
begin
  select count(*) into n from public.newsletter_settings_audit where field = 'sending_enabled';
  perform pg_temp.chk('opening the launch gate is written to the audit', n >= 1);
  perform pg_temp.chk('the audit records who moved it', exists (
    select 1 from public.newsletter_settings_audit
     where field = 'sending_enabled' and changed_by::text = current_setting('nl.operator')));
end $$;

-- ---------------------------------------------------------------------------
-- THE INSTALL REPORT. It answers the launch questions from catalogue state,
-- so what it must never do is answer one of them with a credential.
-- ---------------------------------------------------------------------------
do $$
declare st jsonb; flat text;
begin
  st := public.newsletter_install_status();
  perform pg_temp.chk('the install report names the launch gate',
    st->'gate' ? 'sending_enabled');
  perform pg_temp.chk('it reports every contract table',
    (select count(*) from jsonb_object_keys(st->'tables')) = 8
    and not exists (select 1 from jsonb_each(st->'tables') where value::text = 'false'));
  perform pg_temp.chk('it reports every contract function',
    not exists (select 1 from jsonb_each(st->'functions') where value::text = 'false'));
  perform pg_temp.chk('it says pg_cron is not installed on a database without it',
    (st->'cron'->>'present') = 'false' and (st->'cron'->>'why') like '%pg_cron%');
  perform pg_temp.chk('it counts subscribers without listing them',
    st->'counts' ? 'subscribers_confirmed' and not (st::text ilike '%@example.com%'));

  -- the two settings the cron job body reads are reported as set / not set,
  -- and the key itself never leaves the database through this door
  perform set_config('edgedesk.service_key', 'super-secret-service-key', false);
  perform set_config('edgedesk.project_url', 'https://example.supabase.co', false);
  flat := public.newsletter_install_status()::text;
  perform pg_temp.chk('a set service key reports as set',
    (public.newsletter_install_status()->'db_settings'->>'edgedesk.service_key') = 'set');
  perform pg_temp.chk('and the service key itself is never returned',
    flat not like '%super-secret-service-key%');
  perform set_config('edgedesk.service_key', '', false);
  perform pg_temp.chk('an unset service key reports as not set',
    (public.newsletter_install_status()->'db_settings'->>'edgedesk.service_key') = 'not set');
end $$;

set role anon;
do $$ begin
  begin
    perform public.newsletter_install_status();
    perform pg_temp.chk('a browser could read the install report', false);
  exception when insufficient_privilege then
    perform pg_temp.chk('a browser cannot read the install report', true);
  end;
end $$;
reset role;

set role authenticated;
do $$ begin
  begin
    perform public.newsletter_install_status();
    perform pg_temp.chk('a signed-in reader could read the install report', false);
  exception when insufficient_privilege then
    perform pg_temp.chk('a signed-in reader cannot read the install report either', true);
  end;
end $$;
reset role;

do $$ begin raise notice 'ALL NEWSLETTER SQL CHECKS PASSED'; end $$;
