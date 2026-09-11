-- ===========================================================================
-- EdgeDesk Tennis — the provider player directory.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. It is idempotent and additive: safe to
-- run once, safe to run again, and it changes nothing that already exists.
-- The last statement prints a report — every row must say ok.
--
-- WHY IT IS SEPARATE FROM tennis.players. That table is the LICENSED record
-- and nothing here touches it. It is empty in this project, and the archive
-- that would fill it is CC BY-NC-SA (non-commercial), which the app itself
-- registers as blocked pending a licensing decision. This table is a
-- DIRECTORY instead: who the PROVIDER says is playing, keyed in the
-- provider's own namespace ('espn:<athlete id>') so it can never collide with
-- a licensed id. The resolver prefers the licensed record wherever it has
-- rows and falls back to this, so the day a cleared feed is loaded it wins
-- automatically and none of this has to be unpicked.
--
-- Everything below is already inside supabase/tennis_live_center.sql. Running
-- that whole file again does the same thing. This is the short version for
-- when the rest is already installed.
-- ===========================================================================

create schema if not exists tennis;

create table if not exists tennis.player_directory (
  player_id            text primary key,           -- 'espn:<athlete id>'
  provider             text not null default 'espn',
  provider_athlete_id  text not null,
  full_name            text not null,
  display_name         text,
  short_name           text,
  tour                 text,
  country              text,
  country_code         text,
  plays                text,                       -- hand, only where published
  height_cm            integer,
  weight_kg            integer,
  birth_date           date,
  turned_pro           integer,
  current_rank         integer,
  rank_points          integer,
  rank_as_of           date,
  seen_in_doubles      boolean not null default false,
  seen_in_singles      boolean not null default false,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz,
  source               text not null default 'espn',
  source_detail        text,                       -- which request shape answered
  enriched_at          timestamptz,                -- null until the athlete endpoint answered
  updated_at           timestamptz not null default now()
);

-- constraints, added separately so a re-run never fails on one that exists
alter table tennis.player_directory drop constraint if exists tennis_directory_provider_key;
alter table tennis.player_directory add  constraint tennis_directory_provider_key unique (provider, provider_athlete_id);
alter table tennis.player_directory drop constraint if exists tennis_directory_tour_shape;
alter table tennis.player_directory add  constraint tennis_directory_tour_shape
  check (tour is null or tour in ('ATP','WTA','MIXED','OTHER'));
-- A provider athlete id is a POSITIVE INTEGER in one global namespace. The
-- feed also carries non-positive ids for entrants who are not yet a person —
-- a qualifier, a bye, a slot nobody has won. The same one turns up on both
-- tours in the same week, so it cannot be an identity: admitting it would
-- collapse every placeholder in every draw into a single player. The database
-- refuses it too, so no future writer can reintroduce it.
alter table tennis.player_directory drop constraint if exists tennis_directory_athlete_id_shape;
alter table tennis.player_directory add  constraint tennis_directory_athlete_id_shape
  check (provider_athlete_id ~ '^[0-9]+$' and provider_athlete_id::bigint > 0);
alter table tennis.player_directory drop constraint if exists tennis_directory_id_shape;
alter table tennis.player_directory add  constraint tennis_directory_id_shape check (player_id like '%:%');

create index if not exists tennis_directory_name_idx     on tennis.player_directory (lower(full_name));
create index if not exists tennis_directory_enriched_idx on tennis.player_directory (enriched_at nulls first);

-- keep updated_at honest
create or replace function tennis.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists tennis_directory_touch on tennis.player_directory;
create trigger tennis_directory_touch before update on tennis.player_directory
  for each row execute function tennis.touch_updated_at();

-- THE DOOR: the browser reads, the browser never writes. Only the service role
-- the GitHub jobs hold may write, and it does so over PostgREST.
alter table tennis.player_directory enable row level security;
revoke insert, update, delete, truncate, references, trigger
  on tennis.player_directory from anon, authenticated;
grant usage on schema tennis to anon, authenticated;
grant select on tennis.player_directory to anon, authenticated;
grant select, insert, update, delete on tennis.player_directory to service_role;

drop policy if exists tennis_directory_read on tennis.player_directory;
create policy tennis_directory_read on tennis.player_directory
  for select to anon, authenticated using (true);

-- ── the report: every row must say ok ──────────────────────────────────────
select 1 as row, 'tennis.player_directory exists' as check,
       case when to_regclass('tennis.player_directory') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'anon and authenticated may READ it',
       case when has_table_privilege('anon', 'tennis.player_directory', 'SELECT')
             and has_table_privilege('authenticated', 'tennis.player_directory', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 3, 'no client role may WRITE it',
       case when not has_table_privilege('anon', 'tennis.player_directory', 'INSERT')
             and not has_table_privilege('anon', 'tennis.player_directory', 'UPDATE')
             and not has_table_privilege('anon', 'tennis.player_directory', 'DELETE')
             and not has_table_privilege('authenticated', 'tennis.player_directory', 'INSERT')
            then 'ok' else 'CHECK THIS' end
union all select 4, 'the pipeline (service_role) may write it',
       case when has_table_privilege('service_role', 'tennis.player_directory', 'INSERT')
             and has_table_privilege('service_role', 'tennis.player_directory', 'UPDATE')
            then 'ok' else 'CHECK THIS' end
union all select 5, 'row level security is on',
       case when (select relrowsecurity from pg_class where oid = 'tennis.player_directory'::regclass)
            then 'ok' else 'CHECK THIS' end
union all select 6, 'constraints and indexes installed',
       case when (select count(*) from pg_constraint
                   where conname in ('tennis_directory_provider_key','tennis_directory_tour_shape',
                                     'tennis_directory_id_shape','tennis_directory_athlete_id_shape')) = 4
             and to_regclass('tennis.tennis_directory_name_idx') is not null
            then 'ok' else 'CHECK THIS' end
union all select 7, 'the LICENSED record is untouched by this file',
       case when to_regclass('tennis.players') is null then 'ok (record not installed)'
            else 'ok (tennis.players is not altered above)' end
order by row;
