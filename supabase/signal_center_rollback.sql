-- =============================================================================
-- signal_center_rollback.sql — remove EdgeDesk Signal Center
-- (supabase/signal_center.sql). DESTRUCTIVE: every signal, version, graphic,
-- Model DNA snapshot, reader preference, notice log and run record is dropped
-- with its table, and the Signal Center notices in the bell (public.user_alerts
-- rows whose payload.source is 'signal_center') are deleted, since every one
-- of them links to a signal that no longer exists.
--
-- The SOFT rollback keeps all of it and publishes nothing: as an operator,
--   select public.sc_admin_set_mode('shadow', null);
-- (docs/signal-center/DEPLOYMENT.md). Use this file only to remove the feature.
-- The funnel's 'primary_nav_signals' event kind is removed with it (the taps
-- already kept stay in user_events; they are the reader's history, not ours).
-- No psql meta-commands; ends in a report.
-- =============================================================================

begin;

do $n$ begin
  if to_regclass('public.user_alerts') is not null then
    delete from public.user_alerts where payload->>'source' = 'signal_center';
  end if;
  if to_regclass('public.user_event_kinds') is not null then
    if to_regclass('public.user_events') is null then
      delete from public.user_event_kinds where event_name = 'primary_nav_signals';
    else
      -- a kind that kept taps stays: user_events references it
      delete from public.user_event_kinds k where k.event_name = 'primary_nav_signals'
        and not exists (select 1 from public.user_events e where e.event_name = k.event_name);
    end if;
  end if;
end $n$;

-- the reader doors
drop function if exists public.sc_status();
drop function if exists public.sc_pulse(integer);
drop function if exists public.sc_public_feed(integer);
drop function if exists public.sc_feed(jsonb, text, integer);
drop function if exists public.sc_signal(bigint);
drop function if exists public.sc_signal_version(bigint, integer);
drop function if exists public.sc_model_dna_current(text);
drop function if exists public.sc_my_preferences();
drop function if exists public.sc_save_preferences(jsonb);
drop function if exists public.sc_unread_count();
-- the operator doors
drop function if exists public.sc_admin_queue(jsonb, text, integer);
drop function if exists public.sc_admin_act(bigint, text, text);
drop function if exists public.sc_admin_graphic(bigint, text);
drop function if exists public.sc_admin_set_mode(text, text[]);
drop function if exists public.sc_admin_runs(integer);
drop function if exists public.sc_admin_failures(integer);
drop function if exists public.sc_admin_resolve_failure(bigint);
drop function if exists public.sc_require_admin();
-- the job doors
drop function if exists public.sc_begin_run(jsonb);
drop function if exists public.sc_require_run(uuid);
drop function if exists public.sc_current(text[]);
drop function if exists public.sc_prior_divergences();
drop function if exists public.sc_active(text[], integer);
drop function if exists public.sc_graphics_due(text, integer);
drop function if exists public.sc_check_simulation(jsonb);
drop function if exists public.sc_ingest(uuid, jsonb);
drop function if exists public.sc_ingest_one(uuid, jsonb, text, text, jsonb, text, boolean);
drop function if exists public.sc_put_graphics(uuid, jsonb);
drop function if exists public.sc_put_dna(uuid, jsonb);
drop function if exists public.sc_fail(uuid, jsonb);
drop function if exists public.sc_expire();
drop function if exists public.sc_finish_run(uuid, text, jsonb, jsonb);
drop function if exists public.sc_notify(uuid);
drop function if exists public.sc_event(bigint, text, text, uuid, jsonb);
-- sc_item takes the table's row type, so it goes before the table
drop function if exists public.sc_item(public.sc_signals, boolean);

-- the tables (their triggers go with them)
drop table if exists public.sc_notification_log, public.sc_preferences, public.sc_failures, public.sc_model_dna,
  public.sc_graphics, public.sc_signal_events, public.sc_signal_versions, public.sc_signals, public.sc_runs,
  public.sc_config_log, public.sc_config cascade;

-- the helpers and trigger functions, once no table, check or trigger uses them
drop function if exists public.sc_user_entitled(uuid);
drop function if exists public.sc_viewer_entitled();
drop function if exists public.sc_is_admin();
drop function if exists public.sc_cfg(text);
drop function if exists public.sc_copy_ok(text);
drop function if exists public.sc_label_rank(text);
drop function if exists public.sc_signals_guard();
drop function if exists public.sc_graphics_guard();
drop function if exists public.sc_failures_guard();
drop function if exists public.sc_keep();

commit;

notify pgrst, 'reload schema';

select 'Signal Center is removed' as piece,
       case when to_regclass('public.sc_signals') is null and to_regclass('public.sc_signal_versions') is null and to_regclass('public.sc_config') is null
             and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'sc\_%')
            then 'ok' else 'CHECK THIS' end as state;
