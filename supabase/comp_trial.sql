-- ===========================================================================
-- EdgeDesk — grant ONE named account a free trial that expires on its own.
--
-- WHAT THIS IS FOR. Handing somebody a look at the terminal without sending
-- them through Stripe, and having that look END on a date rather than on
-- somebody remembering to close it.
--
-- WHY NOT `owner_comp`. That is the other way to grant access by hand, and it
-- is the wrong one here: `price_id = 'owner_comp'` with `status = 'active'` is
-- checked BEFORE any date arithmetic — by `subIsComp()` in app.html and
-- index.html, by `community_is_entitled()` in the database, and by the Stripe
-- webhook, which refuses to write over such a row at all. A comp does not
-- lapse, on purpose. Put a trial end date on one and the date is decoration:
-- the account keeps full access forever and no screen will ever say otherwise.
--
-- WHAT THIS WRITES INSTEAD, and why each field is what it is:
--
--   status = 'trialing'        `pgEntitled()` admits active and trialing alike,
--                              but only while `current_period_end` is in the
--                              future. Settings reads it back as "Trial".
--   price_id = 'comp_trial'    Not a Stripe price, and deliberately not on
--                              COMP_PRICE_IDS: it says "granted here, and it
--                              expires" to anyone reading the table later.
--   current_period_end = +N d  THE LOCK. Nothing has to run for it to happen
--                              and nothing can forget: the moment this
--                              timestamp is in the past, every entitlement
--                              check in the product reads the row as lapsed.
--   cancel_at_period_end       true, because nothing renews this. It is also
--                              what makes the Settings card say "Access ends
--                              <date>" instead of "Renews on <date> — you will
--                              be charged $79.99 on this date", which would be
--                              a straight lie to somebody with no card on file.
--   stripe ids, last_event_*   NOT WRITTEN. Nothing was bought, so there is no
--                              Stripe id to have; and leaving the ordering
--                              guard null means a real subscription later on
--                              writes straight over this row, in order, with
--                              nothing to clear out first.
--
-- WHAT HAPPENS WHEN IT RUNS OUT. `pgEntitled()` returns false, `pgCheck()`
-- returns 'locked', and the paywall overlay closes over the terminal with the
-- $79.99 checkout button on it. The row is left exactly as it is — an expired
-- trial that says what it was. Nothing is deleted and no account is touched.
--
-- WHAT IT REFUSES. An account that is ALREADY entitled — a live Stripe
-- subscription, a past_due one still inside Stripe's retry window, or an
-- `owner_comp` — is not overwritten. Writing a 14-day trial over a paying
-- customer's row would replace their real billing state with a deadline, and
-- the report says so rather than doing it.
--
-- CONVENTION (supabase/README.md): idempotent, and it ends in a report.
-- Running it twice does NOT extend the trial — the end date is set once, and
-- a second run reports the date it already carries. Set p_restart to grant a
-- fresh one deliberately.
-- ===========================================================================

begin;

create temp table if not exists ct_report (n serial, step text, outcome text, detail text);
truncate ct_report;

do $do$
declare
  -- ==== THE VALUES THIS FILE IS ABOUT ==================================== --
  p_email   text    := 'pittardj@gmail.com';
  -- How long the trial lasts. The self-serve trial the landing page sells is
  -- 7 days (TRIAL_DAYS in index.html); this one is granted by hand, so make it
  -- whatever was actually promised.
  p_days    int     := 14;
  -- Re-running this file is a no-op by design, so a paste twice cannot quietly
  -- hand out another two weeks. Set true to deliberately start a NEW trial
  -- from today over one this file granted before.
  p_restart boolean := false;
  -- ====================================================================== --
  c_price   constant text := 'comp_trial';
  v_uid      uuid;
  v_any      int;
  v_end      timestamptz;
  v_had      boolean;
  v_status   text;
  v_price    text;
  v_pe       timestamptz;
  v_cus      text;
  v_subid    text;
  v_entitled boolean;
  v_db_ok    boolean;
begin
  if to_regclass('public.subscriptions') is null then
    insert into ct_report(step, outcome, detail)
    values ('0 table', 'CHECK THIS',
            'public.subscriptions does not exist. Run supabase/billing.sql first — it '
            'creates the three tables the signup path reads and writes.');
    return;
  end if;

  -- 1 ---- whose account is this ------------------------------------------
  -- CONFIRMED ACCOUNTS ONLY, the same rule stripe_user_by_email() enforces and
  -- for the same reason: an unconfirmed address proves nothing — anybody can
  -- sign up as somebody else's email — so granting on one hands access to
  -- whoever typed it. Oldest confirmed account wins.
  select u.id into v_uid
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
     and u.email_confirmed_at is not null
   order by u.created_at asc
   limit 1;

  if v_uid is null then
    select count(*) into v_any from auth.users where lower(email) = lower(btrim(p_email));
    insert into ct_report(step, outcome, detail)
    values ('1 account', 'CHECK THIS',
            case when v_any = 0
              then 'No account for ' || p_email || '. They have to sign up first — the trial '
                   'attaches to an auth user, so there is nothing here to attach it to yet.'
              else v_any::text || ' account(s) exist for ' || p_email || ' but none has confirmed '
                   'its email. Have them click the confirmation link (or press Resend in '
                   'Supabase > Authentication > Users), then run this file again.' end);
    return;
  end if;

  insert into ct_report(step, outcome, detail)
  values ('1 account', 'ok', p_email || ' is ' || v_uid::text);

  -- 2 ---- what the row says right now ------------------------------------
  select status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id
    into v_status, v_price, v_pe, v_cus, v_subid
    from public.subscriptions
   where user_id = v_uid;
  v_had := found;

  -- pgEntitled() from app.html, verbatim: the comp short-circuit, the
  -- active/trialing period-end test, and Stripe's 21-day past_due grace.
  v_entitled := coalesce(
       (v_status = 'active' and coalesce(v_price, '') = 'owner_comp')
    or (v_status in ('active', 'trialing') and (v_pe is null or v_pe >= now()))
    or (v_status = 'past_due' and (v_pe is null or now() - v_pe < interval '21 days'))
  , false);

  insert into ct_report(step, outcome, detail)
  values ('2 existing row', 'ok',
          case when not v_had then 'None. This account has never had a subscription row.'
               else 'status ' || coalesce(v_status, 'null') ||
                    ', price_id ' || coalesce(v_price, 'null') ||
                    ', period end ' || coalesce(to_char(v_pe at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'null') ||
                    case when v_subid is not null then ', Stripe subscription ' || v_subid else ', no Stripe subscription' end ||
                    ' — reads as ' || case when v_entitled then 'ENTITLED' else 'not entitled' end || ' today.'
          end);

  -- 3 ---- the grant -------------------------------------------------------
  -- Refuse to write over access somebody already has. A trial deadline
  -- replacing a live subscription is a customer locked out on a date nobody
  -- chose, and it would be invisible until it happened.
  if v_entitled and coalesce(v_price, '') <> c_price then
    insert into ct_report(step, outcome, detail)
    values ('3 trial', 'CHECK THIS',
            'REFUSED — this account already has access (' ||
            case when coalesce(v_price, '') = 'owner_comp' then 'a permanent comp'
                 when v_status = 'past_due' then 'a Stripe subscription inside the retry grace'
                 else 'a live ' || coalesce(v_status, '?') || ' subscription' end ||
            '). Nothing was written. Granting a trial here would replace real billing state '
            'with an expiry date. If the intent really is to end that access, do it in Stripe.');
    return;
  end if;

  if v_had and coalesce(v_price, '') = c_price and not p_restart then
    insert into ct_report(step, outcome, detail)
    values ('3 trial', 'ok, already',
            'This file already granted the trial — it ' ||
            case when v_entitled then 'runs to ' else 'ran out at ' end ||
            coalesce(to_char(v_pe at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'no end date') ||
            '. The date was NOT moved: re-running this file cannot quietly hand out more time. '
            'To start a new ' || p_days::text || '-day trial from today, set p_restart := true.');
    return;
  end if;

  v_end := date_trunc('second', now() + make_interval(days => p_days));

  if v_had then
    -- Stripe ids and the ordering guard are left exactly as they are. If this
    -- account had a subscription once, that history is what lets a new
    -- purchase reconcile against the right customer later.
    update public.subscriptions
       set status               = 'trialing',
           price_id             = c_price,
           current_period_end   = v_end,
           cancel_at_period_end = true,
           updated_at           = now()
     where user_id = v_uid;
  else
    insert into public.subscriptions
      (user_id, status, price_id, current_period_end, cancel_at_period_end, created_at, updated_at)
    values (v_uid, 'trialing', c_price, v_end, true, now(), now());
  end if;

  insert into ct_report(step, outcome, detail)
  values ('3 trial', 'ok',
          case when v_had then 'Granted (existing row updated).' else 'Granted (row created).' end ||
          ' ' || p_days::text || ' days, opening now and closing at ' ||
          to_char(v_end at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.');

  -- 4 ---- read it back ----------------------------------------------------
  -- Not a claim by this file: the row as the paywall will read it.
  select status, price_id, current_period_end
    into v_status, v_price, v_pe
    from public.subscriptions
   where user_id = v_uid;

  v_entitled := coalesce(
       (v_status = 'active' and coalesce(v_price, '') = 'owner_comp')
    or (v_status in ('active', 'trialing') and (v_pe is null or v_pe >= now()))
    or (v_status = 'past_due' and (v_pe is null or now() - v_pe < interval '21 days'))
  , false);

  insert into ct_report(step, outcome, detail)
  values ('4 access now', case when v_entitled then 'ok' else 'CHECK THIS' end,
          case when v_entitled
            then 'pgEntitled() reads this row as entitled. ' || p_email ||
                 ' can open the terminal on their next page load — no sign-out needed, the '
                 'subscription is re-read on every boot.'
            else 'The row was written but does not read as entitled. Something else is on it.' end);

  -- 5 ---- and the lock ----------------------------------------------------
  insert into ct_report(step, outcome, detail)
  values ('5 the lock', 'ok',
          'From ' || to_char(v_pe at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC onward the period '
          'end is in the past, and every entitlement check flips on its own — no job runs, and '
          'nothing has to be remembered. The terminal closes behind the paywall overlay, which offers the '
          '$79.99 checkout. There is no past_due grace on this: that 21-day window only applies to '
          'a Stripe card being retried, and nothing here is being charged.');

  -- 6 ---- the other gate, if it is installed ------------------------------
  -- The paywall is the UX half. Any policy in the database that decides what
  -- rows this account can actually READ has to agree with it, or the trial
  -- either never opens or never shuts. community_is_entitled() is the copy
  -- that lives in this repository; check it directly rather than assume.
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into v_db_ok using v_uid;
    insert into ct_report(step, outcome, detail)
    values ('6 database-side rule', case when v_db_ok = v_entitled then 'ok' else 'CHECK THIS' end,
            'community_is_entitled() says ' || coalesce(v_db_ok::text, 'null') ||
            ', the paywall says ' || v_entitled::text ||
            case when v_db_ok = v_entitled
                 then '. They agree, so this trial opens and closes on both sides.'
                 else '. THEY DISAGREE — one of the two rules is not reading current_period_end.' end);
  else
    insert into ct_report(step, outcome, detail)
    values ('6 database-side rule', 'ok',
            'community_is_entitled() is not installed here, so nothing to compare. Any RLS policy '
            'gating the data tables must test current_period_end the same way — a policy that '
            'accepts status ''trialing'' on its own would leave this account reading data after '
            'the paywall has closed.');
  end if;
end
$do$;

commit;

-- The report runs after the commit, so reading it can never roll the file back.
select n, step, outcome, detail from ct_report order by n;
