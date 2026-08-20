-- MODEL COLLECTIVE, UPGRADE 1: economics waterfall + invite lifecycle + model sources
-- For a database that already ran collective-setup.sql (or migrations 1-8).
-- Paste into the Supabase SQL editor and run once. Safe to re-run.

-- Model Collective, migration 9: the economics waterfall, invite revocation,
-- and model sources.
--
-- Owner decision 2026-08-20: creator compensation is no longer a referral
-- percentage. Gross Collective revenue splits 10% operating reserve, 30%
-- platform, 60% Founding Collective Pool divided equally across the founding
-- seats. Referral remains in the architecture as a SEPARATE customer
-- acquisition concept, 0% by default, and never dilutes the founder pool.
-- All numbers live in config; nothing here is hard-coded into pages.

-- ------------------------------------------------------------ 1) economics
insert into collective.config (key, value, description) values
  ('econ.reserve_bps',      '1000', 'Operating reserve share of gross Collective revenue'),
  ('econ.platform_bps',     '3000', 'Platform and operator allocation of gross Collective revenue'),
  ('econ.founder_pool_bps', '6000', 'Founding Collective Pool, divided equally across the founding seats'),
  ('econ.founder_count',    '6',    'Founding seats the pool divides across'),
  ('econ.referral_bps',     '0',    'Referral share for customer acquisition, separate from founder economics, off by default')
on conflict (key) do nothing;

-- Retire the referral-as-compensation model everywhere it was stored so no
-- conflicting numbers survive (a 50%/40% referral share next to a founder
-- pool would be two comp systems). Founding identity keeps living on
-- creators.founding_member; the money now flows from config at post time.
update collective.config
   set value = '0',
       description = 'Legacy referral default, superseded by econ.referral_bps'
 where key = 'share.referral_bps_default';
update collective.config
   set description = 'Legacy founding referral share, superseded by the founder pool (econ.*)'
 where key = 'share.founding_bps';
update collective.creators set referral_share_bps = 0;

-- ------------------------------------------------------ 2) invite lifecycle
alter table collective.invite_tokens add column if not exists revoked_at timestamptz;

-- ------------------------------------------------------- 3) model sources
-- Where the model lives: spreadsheet, GitHub repo, hosted app, or other.
-- The admin picks the type at invite time; the creator completes the detail
-- during onboarding. Both are optional forever: a model with no declared
-- source still submits through the same pipeline.
alter table collective.models add column if not exists source_kind text
  check (source_kind is null or source_kind in ('excel','github','online','other'));
alter table collective.models add column if not exists source_ref text;

-- ------------------------------------------------------------- 4) RPCs

-- Revoke an invite: the link stops working immediately, nothing else changes.
create or replace function collective.revoke_invite(p_admin uuid, p_invite_id uuid) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  t record;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  select * into t from collective.invite_tokens where id = p_invite_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such invite');
  end if;
  if t.revoked_at is not null then
    return jsonb_build_object('ok', true, 'already_revoked', true);
  end if;
  update collective.invite_tokens set revoked_at = now() where id = p_invite_id;
  return jsonb_build_object('ok', true, 'already_revoked', false);
end $$;

create or replace function collective.invite_status(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = collective as $$
declare
  t record;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;
  -- Dead tokens leak no invitee details: no prefill on these branches.
  if t.revoked_at is not null then
    return jsonb_build_object('ok', true, 'status', 'revoked', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', true, 'status', 'expired', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', true, 'status', 'spent', 'founding', t.founding_member,
      'prefill', '{}'::jsonb, 'expires_at', t.expires_at);
  end if;
  return jsonb_build_object('ok', true, 'status', 'valid', 'founding', t.founding_member,
    'prefill', t.prefill, 'expires_at', t.expires_at);
end $$;

create or replace function collective.redeem_invite(
  p_token_hash text, p_user_id uuid, p_email text, p_profile jsonb,
  p_key_prefix text, p_key_hash text
) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  t record;
  c record;
  v_creator_id uuid;
  v_model_id uuid;
  v_slug text;
  v_model_slug text;
  v_share int;
  v_host text;
  v_src_kind text;
  i int := 2;
begin
  select * into t from collective.invite_tokens where token_hash = p_token_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'No such invite');
  end if;

  -- Idempotent per user: re-opening screen 3 must not burn the token or
  -- mint a second identity.
  select cr.*, m.slug as mslug, m.name as mname, m.sport_code as msport
  into c
  from collective.creators cr
  left join collective.models m on m.creator_id = cr.id
  where cr.user_id = p_user_id
  order by m.created_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'already_issued', true,
      'creator_id', c.id, 'creator_slug', c.slug, 'display_name', c.display_name,
      'founding', c.founding_member,
      'model_slug', c.mslug, 'model_name', c.mname, 'sport', c.msport);
  end if;

  if t.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'token_revoked', 'message', 'This invite was revoked');
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'token_expired', 'message', 'This invite has expired');
  end if;
  if t.use_count >= t.max_uses then
    return jsonb_build_object('ok', false, 'code', 'token_spent', 'message', 'This invite has already been used');
  end if;

  v_slug := collective.slugify(p_profile->>'display_name');
  while exists (select 1 from collective.creators where slug = v_slug) loop
    -- keep the disambiguated slug inside the 40-char constraint
    v_slug := left(collective.slugify(p_profile->>'display_name'), 40 - length(i::text) - 1) || '-' || i;
    i := i + 1;
  end loop;

  -- Compensation is the founder pool (config, computed at post time), never a
  -- per-creator percentage. referral_share_bps now only carries the separate
  -- referral acquisition share, which defaults to 0.
  v_share := coalesce(t.referral_share_bps, collective.cfg_int('econ.referral_bps', 0));

  insert into collective.creators (user_id, slug, display_name, description, website_url, x_handle, logo_url,
    founding_member, referral_share_bps, invite_token_id)
  values (p_user_id, v_slug, p_profile->>'display_name',
    nullif(p_profile->>'description',''), nullif(p_profile->>'website_url',''),
    nullif(p_profile->>'x_handle',''), nullif(p_profile->>'logo_url',''),
    t.founding_member, v_share, t.id)
  returning id into v_creator_id;

  v_src_kind := case when p_profile->>'source_kind' in ('excel','github','online','other')
                     then p_profile->>'source_kind' end;
  v_model_slug := collective.slugify(p_profile->>'model_name');
  insert into collective.models (creator_id, slug, name, sport_code, source_kind, source_ref)
  values (v_creator_id, v_model_slug, p_profile->>'model_name', p_profile->>'sport',
          v_src_kind, nullif(left(coalesce(p_profile->>'source_ref',''), 300), ''))
  returning id into v_model_id;

  insert into collective.api_keys (creator_id, model_id, kind, key_prefix, key_hash)
  values (v_creator_id, v_model_id, 'live', p_key_prefix, p_key_hash);

  -- Their own site is allowlisted for the embed from the moment they join.
  if nullif(p_profile->>'website_url','') is not null then
    begin
      v_host := lower(regexp_replace(p_profile->>'website_url', '^(https?://[^/]+).*$', '\1'));
      if v_host like 'http%' then
        insert into collective.embed_installs (creator_id, origin) values (v_creator_id, v_host)
        on conflict do nothing;
      end if;
    exception when others then null; end;
  end if;

  update collective.invite_tokens set use_count = use_count + 1 where id = t.id;

  return jsonb_build_object('ok', true, 'already_issued', false,
    'creator_id', v_creator_id, 'creator_slug', v_slug,
    'display_name', p_profile->>'display_name', 'founding', t.founding_member,
    'model_id', v_model_id, 'model_slug', v_model_slug,
    'model_name', p_profile->>'model_name', 'sport', p_profile->>'sport');
end $$;

-- The revenue waterfall. On a paid invoice:
--   reserve and platform allocations stay with the Collective (no ledger row:
--   the ledger only tracks money owed to creators),
--   the founder pool share posts one equal earning per active founding member
--   (pool divided by econ.founder_count, the seat count, so each founding
--   member's share is fixed whether or not every seat is filled yet),
--   and the separate referral share posts to the attributed creator only when
--   econ.referral_bps is above zero.
-- Stripe retries webhooks, so the whole pass is idempotent per invoice ref.
-- Ledger refs are suffixed per entry ('#f-…', '#ref') because one invoice now
-- fans out to several rows and earnings_invoice_once is unique per ref.
create or replace function collective.billing_post_invoice(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  f record;
  v_amount int := coalesce(nullif(p->>'amount_cents','')::int, 0);
  v_month date := coalesce(nullif(p->>'period_month','')::date, date_trunc('month', now())::date);
  v_net int := collective.cfg_int('payout.net_days', 30);
  v_ref_bps int := collective.cfg_int('econ.referral_bps', 0);
  v_pool_bps int := collective.cfg_int('econ.founder_pool_bps', 6000);
  v_fcount int := greatest(collective.cfg_int('econ.founder_count', 6), 1);
  v_base_ref text := nullif(p->>'stripe_ref','');
  v_sub_id uuid;
  v_ref_creator uuid;
  v_cents int;
  v_per_founder int;
  v_posted int := 0;
  v_total int := 0;
  v_avail timestamptz;
begin
  -- No ref, no post: without an invoice ref there is no idempotency and no
  -- clawback path, and Stripe always supplies one.
  if v_base_ref is null then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'missing stripe_ref');
  end if;
  select id into v_sub_id from collective.subscribers
   where stripe_subscription_id = p->>'stripe_subscription_id';
  if v_sub_id is null then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no such subscriber');
  end if;
  v_avail := (v_month + interval '1 month') + make_interval(days => v_net);

  if exists (
    select 1 from collective.earnings_ledger
     where entry_type = 'earning'
       and (stripe_ref = v_base_ref or stripe_ref like v_base_ref || '#%')
  ) then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'already posted');
  end if;

  -- Referral: customer acquisition, separate from founder economics. Never
  -- reduces the pool; off (0 bps) by default.
  if v_ref_bps > 0 then
    select a.creator_id into v_ref_creator
      from collective.subscribers sub
      join collective.attributions a on a.id = sub.attribution_id
     where sub.id = v_sub_id;
    v_cents := (v_amount * v_ref_bps) / 10000;
    if v_ref_creator is not null and v_cents > 0 then
      insert into collective.earnings_ledger
        (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
      values (v_ref_creator, v_sub_id, 'earning', v_cents, v_month, v_avail,
              v_base_ref || '#ref', 'referral share')
      on conflict (stripe_ref) where entry_type = 'earning' and stripe_ref is not null do nothing;
      v_posted := v_posted + 1; v_total := v_total + v_cents;
    end if;
  end if;

  -- Founding Collective Pool: one equal share per founding seat.
  v_per_founder := ((v_amount * v_pool_bps) / 10000) / v_fcount;
  if v_per_founder > 0 then
    -- Capped at the configured seat count: even if more founding members ever
    -- exist than seats, the pool never pays out more than its share. The
    -- earliest-created members hold the seats, deterministically.
    for f in
      select id from collective.creators
       where founding_member and status = 'active'
       order by created_at
       limit v_fcount
    loop
      insert into collective.earnings_ledger
        (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
      values (f.id, v_sub_id, 'earning', v_per_founder, v_month, v_avail,
              v_base_ref || '#f-' || left(f.id::text, 8), 'founder pool share')
      on conflict (stripe_ref) where entry_type = 'earning' and stripe_ref is not null do nothing;
      v_posted := v_posted + 1; v_total := v_total + v_per_founder;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'posted', v_posted > 0, 'entries', v_posted,
    'amount_cents', v_total, 'per_founder_cents', v_per_founder);
end $$;

-- A refund claws back every earning the invoice fanned out to, each exactly
-- once, inside the clawback window. Clawbacks reuse the earning's suffixed
-- ref so replays are blocked by earnings_clawback_once plus the exists guard.
create or replace function collective.billing_post_refund(p jsonb) returns jsonb
language plpgsql security definer set search_path = collective as $$
declare
  e record;
  v_window int := collective.cfg_int('payout.clawback_days', 60);
  v_ref text := nullif(p->>'stripe_ref','');
  v_posted int := 0;
  v_total int := 0;
begin
  if v_ref is null then
    return jsonb_build_object('ok', true, 'posted', false, 'reason', 'no stripe_ref');
  end if;
  for e in
    select * from collective.earnings_ledger
     where entry_type = 'earning'
       and (stripe_ref = v_ref or stripe_ref like v_ref || '#%')
  loop
    if e.created_at < now() - make_interval(days => v_window) then continue; end if;
    if exists (select 1 from collective.earnings_ledger
                where entry_type = 'clawback' and stripe_ref = e.stripe_ref) then
      continue;
    end if;
    -- The clawback carries the SAME available_at as the earning it reverses
    -- so the pair always nets to zero in available_cents.
    insert into collective.earnings_ledger
      (creator_id, subscriber_id, entry_type, amount_cents, period_month, available_at, stripe_ref, note)
    values (e.creator_id, e.subscriber_id, 'clawback', -e.amount_cents, e.period_month, e.available_at,
            e.stripe_ref, 'refund or chargeback clawback')
    on conflict (stripe_ref) where entry_type = 'clawback' and stripe_ref is not null do nothing;
    v_posted := v_posted + 1; v_total := v_total - e.amount_cents;
  end loop;
  if v_posted = 0 then
    return jsonb_build_object('ok', true, 'posted', false,
      'reason', 'no matching earning inside the clawback window');
  end if;
  return jsonb_build_object('ok', true, 'posted', true, 'entries', v_posted, 'amount_cents', v_total);
end $$;

-- ------------------------------------------------------------- 5) grants
-- Migration 7's grant sweep already ran; the one genuinely new function needs
-- the same treatment (create or replace preserves ACLs on the others).
revoke execute on function collective.revoke_invite(uuid, uuid) from public;
grant execute on function collective.revoke_invite(uuid, uuid) to service_role;
