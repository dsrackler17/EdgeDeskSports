-- portfolio_decision -- part 7 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. SEARCH — the caller's own positions and their journal words
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_search(p_q text, p_limit int default 20)
returns table (id uuid, event_name text, selection text, market_name text, platform_label text, position_type text, sport text,
  placed_at timestamptz, event_start_at timestamptz, status text, result text, profit_loss numeric, matched text)
language sql stable as $$
  with q as (select '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
                    length(btrim(coalesce(p_q, ''))) as len)
  select p.id, p.event_name, p.selection, p.market_name, p.platform_label, p.position_type, p.sport, p.placed_at, p.event_start_at,
         p.status, p.result, p.profit_loss,
         case when p.event_name ilike q.pat then 'event' when p.selection ilike q.pat then 'selection' when p.market_name ilike q.pat then 'market'
              when p.platform_label ilike q.pat then 'platform' when coalesce(p.sport, '') ilike q.pat or coalesce(p.league, '') ilike q.pat then 'sport'
              when coalesce(p.notes, '') ilike q.pat then 'notes' when coalesce(j.thesis, '') ilike q.pat then 'thesis' else 'review' end
    from q, public.portfolio_positions p
    left join public.portfolio_journal_entries j on j.position_id = p.id
   where p.user_id = auth.uid() and q.len between 2 and 80
     and (p.event_name ilike q.pat or p.selection ilike q.pat or p.market_name ilike q.pat or p.platform_label ilike q.pat
          or coalesce(p.sport, '') ilike q.pat or coalesce(p.league, '') ilike q.pat or coalesce(p.notes, '') ilike q.pat
          or coalesce(j.thesis, '') ilike q.pat or coalesce(j.review_note, '') ilike q.pat)
   order by p.placed_at desc, p.id
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. NOTIFICATIONS — a settled position's record is ready to review. One
--     per position, in the reader's own notification centre, only if they
--     keep the preference on; never a prompt to place anything.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_settled_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare on_pref boolean := true; pj jsonb;
begin
  if to_regclass('public.user_alerts') is null then return null; end if;
  if to_regclass('public.alert_preferences') is not null then
    execute 'select to_jsonb(a) from public.alert_preferences a where a.user_id = $1' into pj using new.user_id;
    if pj is not null and ((pj->>'enabled') = 'false' or (pj->>'on_decision_review') = 'false') then return null; end if;
  end if;
  begin
    execute 'insert into public.user_alerts (user_id, kind, title, body, severity, payload, dedupe_key)
             values ($1, ''decision_review'', $2, $3, ''info'', $4, $5) on conflict (user_id, dedupe_key) do nothing'
      using new.user_id, left(new.event_name || ' settled', 160),
            left(new.selection || ' · ' || new.platform_label || '. The decision record is ready: what you saw at entry, the market path and the process grade.', 600),
            jsonb_build_object('position_id', new.id, 'surface', 'portfolio'), 'decision_review:' || new.id::text;
  exception when check_violation or undefined_column or undefined_table then
    /* the notification centre predates this kind: the settlement stands */
    null;
  end;
  return null;
end $$;
drop trigger if exists portfolio_positions_settled_notice_trg on public.portfolio_positions;
create trigger portfolio_positions_settled_notice_trg after update on public.portfolio_positions
  for each row when (old.status = 'OPEN' and new.status <> 'OPEN')
  execute function public.portfolio_settled_notice();

-- an experiment whose window has ended and is not yet concluded: one notice,
-- for the caller only (the page calls this as it loads)
create or replace function public.portfolio_due_notices()
returns int language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); n int := 0; k int; e record; pj jsonb;
begin
  if me is null or to_regclass('public.user_alerts') is null then return 0; end if;
  if to_regclass('public.alert_preferences') is not null then
    execute 'select to_jsonb(a) from public.alert_preferences a where a.user_id = $1' into pj using me;
    if pj is not null and ((pj->>'enabled') = 'false' or (pj->>'on_experiment_ready') = 'false') then return 0; end if;
  end if;
  for e in select x.id, x.title from public.portfolio_experiments x
            where x.user_id = me and x.conclusion is null and (x.status <> 'ACTIVE' or x.ends_at <= now()) and x.ends_at > now() - interval '60 days' loop
    begin
      execute 'insert into public.user_alerts (user_id, kind, title, body, severity, payload, dedupe_key)
               values ($1, ''experiment_ready'', $2, $3, ''info'', $4, $5) on conflict (user_id, dedupe_key) do nothing'
        using me, left('Experiment window ended: ' || e.title, 160),
              'The result can be read now, against the baseline frozen when it started.',
              jsonb_build_object('experiment_id', e.id, 'surface', 'process'), 'experiment_ready:' || e.id::text;
      get diagnostics k = row_count; n := n + k;
    exception when check_violation or undefined_column or undefined_table then null;
    end;
  end loop;
  return n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. PRIVACY — everything as data, and everything deleted on request
-- ─────────────────────────────────────────────────────────────────────────────
-- the caller's whole Portfolio and Decision Record, in one document. Runs as
-- the caller: it can contain nothing that is not theirs. Credentials are
-- never readable and are not included; derived caches are not data.
create or replace function public.portfolio_export()
returns jsonb language plpgsql stable as $$
declare me uuid := auth.uid(); out jsonb;
begin
  if me is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  out := jsonb_build_object(
    'format', 'edgedesk_portfolio_export_v1', 'exported_at', now(),
    'methodology', (select coalesce(jsonb_agg(to_jsonb(m) order by m.component, m.effective_from), '[]'::jsonb) from public.portfolio_methodology m),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) - 'sync_cursor' order by a.created_at), '[]'::jsonb) from public.platform_accounts a where a.user_id = me),
    'positions', (select coalesce(jsonb_agg(to_jsonb(p) order by p.placed_at, p.id), '[]'::jsonb) from public.portfolio_positions p where p.user_id = me),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.executed_at, t.id), '[]'::jsonb) from public.portfolio_transactions t where t.user_id = me),
    'journal', (select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at), '[]'::jsonb) from public.portfolio_journal_entries j where j.user_id = me),
    'decision_snapshots', (select coalesce(jsonb_agg(to_jsonb(s) order by s.recorded_at), '[]'::jsonb) from public.portfolio_decision_snapshots s where s.user_id = me),
    'market_path', (select coalesce(jsonb_agg(to_jsonb(m) order by m.position_id, m.observed_at, m.id), '[]'::jsonb) from public.portfolio_market_path m where m.user_id = me),
    'reflections', (select coalesce(jsonb_agg(to_jsonb(r) order by r.written_at, r.id), '[]'::jsonb) from public.portfolio_reflections r where r.user_id = me),
    'outcome_classes', (select coalesce(jsonb_agg(to_jsonb(o) order by o.classified_at, o.id), '[]'::jsonb) from public.portfolio_outcome_classes o where o.user_id = me),
    'baselines', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from public.portfolio_baselines b where b.user_id = me),
    'insights', (select coalesce(jsonb_agg(to_jsonb(i) order by i.first_detected_at), '[]'::jsonb) from public.portfolio_insights i where i.user_id = me),
    'insight_observations', (select coalesce(jsonb_agg(to_jsonb(o) order by o.observed_at, o.id), '[]'::jsonb) from public.portfolio_insight_observations o where o.user_id = me),
    'rules', (select coalesce(jsonb_agg(to_jsonb(r) order by r.active_from), '[]'::jsonb) from public.portfolio_rules r where r.user_id = me),
    'experiments', (select coalesce(jsonb_agg(to_jsonb(e) order by e.starts_at), '[]'::jsonb) from public.portfolio_experiments e where e.user_id = me),
    'card_events', (select coalesce(jsonb_agg(to_jsonb(c) order by c.at, c.id), '[]'::jsonb) from public.portfolio_card_events c where c.user_id = me),
    'imports', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]'::jsonb) from public.portfolio_imports i where i.user_id = me),
    'import_rows', (select coalesce(jsonb_agg(to_jsonb(r) order by r.import_id, r.row_number), '[]'::jsonb) from public.portfolio_import_rows r where r.user_id = me));
  return out;
end $$;

-- delete every Portfolio and Decision Record row the caller owns: positions
-- (with their journal, snapshots, path, reflections and classes), fills,
-- imports, accounts and their stored credentials, rules, experiments,
-- patterns, the baseline, Card events, caches and this kind of notification.
-- The typed phrase guards against a stray call. Irreversible.
create or replace function public.portfolio_delete_everything(p_confirm text)
returns jsonb language plpgsql volatile security definer set search_path = public, portfolio_private, pg_temp as $$
declare me uuid := auth.uid(); out jsonb := '{}'::jsonb; k int;
begin
  if me is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  if coalesce(p_confirm, '') <> 'DELETE MY PORTFOLIO' then
    raise exception 'portfolio: type DELETE MY PORTFOLIO to confirm' using errcode = '22023';
  end if;
  /* the caller is checked above; what follows deletes only rows whose
     user_id is theirs, including connector-owned ones a reader cannot touch,
     so it runs without the reader's identity (as portfolio_disconnect does) */
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  delete from portfolio_private.platform_credentials where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('credentials', k);
  delete from public.portfolio_positions where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('positions', k);
  delete from public.portfolio_transactions where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('transactions', k);
  delete from public.portfolio_import_rows where user_id = me;
  delete from public.portfolio_imports where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('imports', k);
  delete from public.portfolio_sync_logs where user_id = me;
  if to_regclass('public.portfolio_sync_runs') is not null then
    delete from public.portfolio_sync_runs r using public.platform_accounts a where r.platform_account_id = a.id and a.user_id = me;
  end if;
  delete from public.platform_accounts where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('accounts', k);
  delete from public.portfolio_rules where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('rules', k);
  delete from public.portfolio_experiments where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('experiments', k);
  delete from public.portfolio_insights where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('patterns', k);
  delete from public.portfolio_insight_observations where user_id = me;
  delete from public.portfolio_baselines where user_id = me;
  delete from public.portfolio_card_events where user_id = me; get diagnostics k = row_count; out := out || jsonb_build_object('card_events', k);
  delete from public.portfolio_outcome_classes where user_id = me;
  delete from public.portfolio_facts_cache where user_id = me;
  delete from public.portfolio_facts_cache_state where user_id = me;
  if to_regclass('public.user_alerts') is not null then
    execute 'delete from public.user_alerts where user_id = $1 and kind in (''decision_review'', ''experiment_ready'')' using me;
  end if;
  return out;
end $$;
