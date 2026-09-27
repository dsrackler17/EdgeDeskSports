-- cfb_market -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

do $blk$
declare
  v text;
begin
  foreach v in array array['cfb_market_lab_panel','cfb_market_quotes_canonical']
  loop
    if to_regclass('public.' || v) is null then continue; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
    end if;
  end loop;
end $blk$;

notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_market_consensus_snapshots'),('cfb_market_events'),('cfb_book_quality'),('cfb_market_predictions'),
         ('cfb_market_provider_conflicts'),('cfb_market_information_events'),('cfb_market_public_betting')
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only, row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg where tg.tgrelid = to_regclass('public.' || t)
                     and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'keys: one snapshot per game x moment x rule; one event per game x type x moment',
         case when to_regclass('public.cfb_market_consensus_snapshots_key') is not null
               and to_regclass('public.cfb_market_events_key') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'Model Lab view: the market panel',
         case when to_regclass('public.cfb_market_lab_panel') is not null then 'ok' else 'CHECK THIS' end
) r
order by ord, check_name;

