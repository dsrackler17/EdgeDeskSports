-- ============================================================================
-- EDGEDESK — VERIFIED P&L: THE EVIDENCE. docs/pnl/DESIGN.md § Verified P&L
-- Apply after model_pnl_verified.sql, before model_pnl_verified_views.sql.
-- Every stored quote a locked price cites (model_pnl.price_ref ->> 'quote_id'),
-- copied once from the committed ledger it lives in (tools/record/
-- pnl_config.json sources: the CFB Model Lab's quotes, the football record's
-- own quote ledger) by tools/record/pnl_sync.js, before the rows that cite it.
-- Append-only: a quote is never edited or removed, and a second copy that
-- differs is refused. verified_pnl_integrity() checks every snapshot price
-- against its row here: same game, market, number, time, and price.
-- Idempotent and additive; ends in a report whose rows must all read ok.
-- ============================================================================
do $g$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'model_pnl' and column_name = 'price_ref') then
    raise exception 'apply supabase/model_pnl_verified.sql first'; end if;
end $g$;

create table if not exists public.model_pnl_quotes (
  quote_id      text primary key,
  source        text not null,
  league        text not null,
  game_id       text not null,
  book          text not null,
  market_type   text not null check (market_type in ('spread', 'total', 'moneyline')),
  observed_at   timestamptz not null,
  kickoff_ts    timestamptz null,
  home_line     numeric null,
  total_points  numeric null,
  price_home    numeric null,
  price_away    numeric null,
  price_over    numeric null,
  price_under   numeric null,
  source_file   text null,
  copied_at     timestamptz not null default now(),
  constraint model_pnl_quotes_pregame check (kickoff_ts is null or observed_at < kickoff_ts)
);
create index if not exists model_pnl_quotes_game_idx on public.model_pnl_quotes (game_id, market_type, observed_at);
create or replace function public.model_pnl_quotes_keep() returns trigger language plpgsql as $k$
begin raise exception 'model_pnl_quotes: % is refused — a stored quote is evidence and is kept as it was read', tg_op; end $k$;
drop trigger if exists model_pnl_quotes_frozen_trg on public.model_pnl_quotes;
create trigger model_pnl_quotes_frozen_trg before update or delete on public.model_pnl_quotes for each row execute function public.model_pnl_quotes_keep();
drop trigger if exists model_pnl_quotes_no_truncate_trg on public.model_pnl_quotes;
create trigger model_pnl_quotes_no_truncate_trg before truncate on public.model_pnl_quotes for each statement execute function public.model_pnl_quotes_keep();

-- the one writer: insert a quote not seen yet; one already here is left alone
-- when identical and refused (named) when it differs
create or replace function public.model_pnl_quotes_put(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $q$
declare v jsonb; q public.model_pnl_quotes; x public.model_pnl_quotes; ins int := 0; same int := 0; refused jsonb := '[]'::jsonb;
begin
  for v in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin
      q := jsonb_populate_record(null::public.model_pnl_quotes, v);
      q.copied_at := now();
      select * into x from public.model_pnl_quotes where quote_id = q.quote_id;
      if not found then
        insert into public.model_pnl_quotes values (q.*);
        ins := ins + 1;
      elsif (x.source, x.game_id, x.book, x.market_type, x.observed_at, x.home_line, x.total_points, x.price_home, x.price_away, x.price_over, x.price_under)
          is not distinct from (q.source, q.game_id, q.book, q.market_type, q.observed_at, q.home_line, q.total_points, q.price_home, q.price_away, q.price_over, q.price_under) then
        same := same + 1;
      else
        refused := refused || jsonb_build_object('quote_id', q.quote_id, 'error', 'a different quote under the same id is refused: the stored one stands');
      end if;
    exception when others then
      refused := refused || jsonb_build_object('quote_id', v ->> 'quote_id', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('inserted', ins, 'unchanged', same, 'refused', refused);
end $q$;
alter table public.model_pnl_quotes enable row level security;
drop policy if exists model_pnl_quotes_read on public.model_pnl_quotes;
create policy model_pnl_quotes_read on public.model_pnl_quotes for select to anon, authenticated using (true);
revoke all on public.model_pnl_quotes from anon, authenticated;
grant select on public.model_pnl_quotes to anon, authenticated;
grant select, insert on public.model_pnl_quotes to service_role;
revoke all on function public.model_pnl_quotes_put(jsonb) from public, anon, authenticated;
grant execute on function public.model_pnl_quotes_put(jsonb) to service_role;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'model_pnl_quotes: the stored quotes the locked prices cite' as piece, case when to_regclass('public.model_pnl_quotes') is not null then 'ok' else 'CHECK THIS' end as state
  union all select 'append-only: no update, delete or truncate', case when exists (select 1 from pg_trigger where tgname = 'model_pnl_quotes_frozen_trg')
    and exists (select 1 from pg_trigger where tgname = 'model_pnl_quotes_no_truncate_trg') then 'ok' else 'CHECK THIS' end
  union all select 'never a quote read at or after kickoff (constraint)', case when exists (select 1 from pg_constraint where conname = 'model_pnl_quotes_pregame') then 'ok' else 'CHECK THIS' end
  union all select 'readers read it, only the service role writes', case when has_table_privilege('anon', 'public.model_pnl_quotes', 'select')
    and not has_table_privilege('anon', 'public.model_pnl_quotes', 'insert') and not has_function_privilege('anon', 'public.model_pnl_quotes_put(jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
  union all select 'every locked price cites a quote held here (re-run after the next sync)', case when not exists (select 1 from public.model_pnl m where m.price_source = 'snapshot'
    and not exists (select 1 from public.model_pnl_quotes q where q.quote_id = m.price_ref ->> 'quote_id')) then 'ok' else 'CHECK THIS' end
) r order by 1;
