-- Model Collective, migration 3: submissions and projections, append-only.
-- Submissions are immutable observations (rule 8.3): a revision is a new
-- row, UPDATE and DELETE are blocked for every path except the explicit
-- service maintenance GUC used by quarantine resolution and erasure.

create table collective.submissions (
  id                  uuid primary key default gen_random_uuid(),
  model_id            uuid not null references collective.models(id),
  api_key_id          uuid not null references collective.api_keys(id),
  -- Server receipt time is the only time trusted anywhere (rule 8.6).
  received_at         timestamptz not null default now(),
  data_origin         collective.data_origin not null,
  client_generated_at timestamptz,
  source_note         text,
  payload_hash        text not null,
  n_rows              int not null default 0,
  n_resolved          int not null default 0,
  n_quarantined       int not null default 0,
  n_late              int not null default 0,
  -- The exact response returned at ingest time, so an idempotent replay
  -- returns the original outcome verbatim (denormalization justified:
  -- recomputing it later could differ once quarantine gets resolved).
  response            jsonb,
  created_at          timestamptz not null default now(),
  unique (model_id, payload_hash)
);
create index submissions_model_time on collective.submissions (model_id, received_at desc);
alter table collective.submissions enable row level security;
grant select, insert on collective.submissions to service_role;

create table collective.projections (
  id                 uuid primary key default gen_random_uuid(),
  -- Deferrable: ingest writes projection rows first and the parent
  -- submissions row (carrying the final counts and stored response) last,
  -- inside one transaction. The constraint holds at commit.
  submission_id      uuid not null references collective.submissions(id) deferrable initially deferred,
  -- model_id, data_origin, received_at are denormalized from submissions:
  -- every read path (grading, coverage, movement, consensus) filters on
  -- them, and append-only rows never drift from their parent.
  model_id           uuid not null references collective.models(id),
  game_id            uuid references collective.games(id),
  raw_game_ref       text not null,
  raw_row            jsonb not null,
  resolution_status  collective.resolution_status not null,
  quarantine_reason  text,
  sport_code         text not null,
  season             int not null,
  week               int,
  pick_side          collective.pick_side,
  total_side         collective.total_side,
  line_at_submission numeric,
  projected_spread   numeric,
  projected_total    numeric,
  proj_home_score    numeric,
  proj_away_score    numeric,
  home_win_prob      numeric check (home_win_prob is null or (home_win_prob >= 0 and home_win_prob <= 1)),
  cover_prob         numeric check (cover_prob is null or (cover_prob >= 0 and cover_prob <= 1)),
  -- Creator-defined scale. Displayed only in the creator's own context,
  -- never aggregated (rule 9.5).
  confidence         numeric,
  data_origin        collective.data_origin not null,
  received_at        timestamptz not null,
  is_late            boolean not null default false,
  is_graded_candidate boolean not null default false,
  created_at         timestamptz not null default now(),
  -- A cover probability is meaningless without the line it was made
  -- against (rule 9.3).
  check (cover_prob is null or line_at_submission is not null),
  check (resolution_status = 'resolved' or game_id is null)
);

-- THE first-submission lock (rule 8.5). One graded candidate per model per
-- game, enforced structurally, not by convention. Everything later is
-- movement.
create unique index projections_first_lock
  on collective.projections (model_id, game_id)
  where is_graded_candidate;

create index projections_model_game on collective.projections (model_id, game_id, received_at);
create index projections_game on collective.projections (game_id) where game_id is not null;
create index projections_quarantined on collective.projections (received_at desc) where resolution_status = 'quarantined';
alter table collective.projections enable row level security;
grant select, insert on collective.projections to service_role;

-- ------------------------------------------------ append-only enforcement
-- Belt and braces on top of the missing UPDATE/DELETE grants: even the
-- table owner goes through the maintenance GUC, so nothing mutates these
-- rows casually. Quarantine resolution and GDPR erasure set the GUC inside
-- SECURITY DEFINER functions.

create or replace function collective.block_mutation() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('collective.maintenance', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'collective.% is append-only (rule 8.3); use the service maintenance path', tg_table_name
    using errcode = 'raise_exception';
end $$;

create trigger submissions_append_only
  before update or delete on collective.submissions
  for each row execute function collective.block_mutation();

create trigger projections_append_only
  before update or delete on collective.projections
  for each row execute function collective.block_mutation();
