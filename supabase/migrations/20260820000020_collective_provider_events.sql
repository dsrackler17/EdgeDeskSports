-- Model Collective, migration 20: provider event identity.
--
-- An odds feed names a game with its own id and usually carries the ids other
-- systems use for the same fixture (the official league id, a stats provider,
-- a prediction market). Resolution to a canonical game still happens through
-- resolve_game_ref and nothing else; this table only records the answer, so
-- that:
--
--   * a later capture of the same event does not have to be re-resolved,
--   * an event that resolved once can be audited against the game it hit,
--   * a settle-from-official-id path has the league id to work with.
--
-- It is a cache and a ledger, never an authority. A row here can never create
-- a game and is not consulted by grading.

create table if not exists collective.provider_events (
  provider          text not null,
  provider_event_id text not null,
  sport_code        text not null references collective.sports(code),
  game_id           uuid not null references collective.games(id),
  mappings          jsonb not null default '{}'::jsonb,
  home_team         text,
  away_team         text,
  starts_at         timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  primary key (provider, provider_event_id)
);
create index if not exists provider_events_game on collective.provider_events (game_id);
alter table collective.provider_events enable row level security;
grant select, insert, update on collective.provider_events to service_role;

-- Collectors call this after record_market_snapshots has resolved the slate.
-- Rows naming a game the Collective does not know are dropped, not created:
-- the no-collector-invents-a-game rule holds here too.
create or replace function collective.link_provider_events(p_admin uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = collective as $$
declare
  r jsonb;
  v_game uuid;
  n_ok int := 0; n_skipped int := 0;
begin
  if not collective.is_admin(p_admin) then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'message', 'Not an admin account');
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload', 'message', 'rows must be an array');
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_game := collective.resolve_game_ref(
      r->>'sport', nullif(r->>'season','')::int,
      r->>'home_team', r->>'away_team', nullif(r->>'starts_at','')::timestamptz);
    if v_game is null or coalesce(r->>'provider','') = '' or coalesce(r->>'provider_event_id','') = '' then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    insert into collective.provider_events (
      provider, provider_event_id, sport_code, game_id, mappings,
      home_team, away_team, starts_at)
    values (
      r->>'provider', r->>'provider_event_id', r->>'sport', v_game,
      coalesce(r->'mappings', '{}'::jsonb),
      r->>'home_team', r->>'away_team', nullif(r->>'starts_at','')::timestamptz)
    on conflict (provider, provider_event_id) do update
      set game_id = excluded.game_id,
          mappings = excluded.mappings,
          home_team = excluded.home_team,
          away_team = excluded.away_team,
          starts_at = excluded.starts_at,
          last_seen_at = now();
    n_ok := n_ok + 1;
  end loop;

  return jsonb_build_object('ok', true, 'linked', n_ok, 'skipped', n_skipped);
end $$;

-- What the market store actually holds, per feed. The admin console reads
-- this to answer "is the collector running and how old is the newest price",
-- which is the only question worth asking of a collector.
create or replace view collective.market_sources as
select
  ms.source,
  ms.book,
  ms.sport_code,
  count(*)::int              as snapshots,
  count(distinct ms.game_id)::int as games,
  max(ms.captured_at)        as last_captured_at
from collective.market_snapshots ms
group by ms.source, ms.book, ms.sport_code;

grant select on collective.market_sources to service_role;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'collective' and p.proname = 'link_provider_events' loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
