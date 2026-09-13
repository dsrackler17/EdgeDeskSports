-- ===========================================================================
-- THE EDITORIAL SYSTEM — featured games, pregame snapshots, thesis audits,
-- research lessons, model-review candidates and the run log.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHAT THIS IS FOR, AND WHAT IT IS NOT
--   The RECORD of everything here is the repository: tools/editorial/store.js
--   writes articles/data/editorial/**, the static build reads it, and every
--   editorial decision is therefore a commit somebody can read. This table set
--   exists so an OPERATOR can make and see those decisions from a browser or a
--   phone without a checkout, and so the next pipeline run honours them.
--
--   The pipeline reads these tables when it can reach them and falls back to
--   the committed store when it cannot, so an outage delays a decision rather
--   than losing one. Same shape as supabase/site_articles.sql, on purpose:
--   one pattern for "the decision lives here, the page lives in the repo".
--
-- THE ONE RULE THE DATABASE ENFORCES BY ITSELF
--   A PREGAME SNAPSHOT IS IMMUTABLE. Its id is a content hash of the research
--   it captured, and the whole postgame audit rests on it not having moved: an
--   article that graded EdgeDesk against an edited prediction would be worse
--   than no article. So there is no UPDATE policy on editorial_snapshots for
--   anybody, a trigger refuses a payload change even to the service role, and
--   there is no DELETE grant. It can be inserted and it can be read.
--
-- AND THE ONE RULE ABOUT MODEL WEIGHTS
--   editorial_model_reviews holds QUESTIONS WITH EVIDENCE ATTACHED. Nothing in
--   this schema, this repository or the pipeline changes a model weight from a
--   row in it. A candidate is opened automatically when a published claim
--   carrying real weight is contradicted by a game; only a person may close
--   one, and the trigger below requires a disposition and an author to do it.
--
-- WHO MAY DO WHAT
--   anon / any signed-in reader: SELECT the rows behind PUBLISHED articles.
--                               A snapshot for an unpublished article, a run
--                               log line and an open review candidate are all
--                               invisible.
--   an operator on the allowlist: everything, except editing a snapshot.
--   Admin is decided by public.site_article_is_admin(), the function
--   site_articles.sql already installs — one allowlist, not two.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- THE ONE HARD PREREQUISITE, SAID OUT LOUD AND FIRST.
--
-- The public-read boundary of every table below is "what a PUBLISHED article
-- already shows", and that is expressed as an RLS policy referencing
-- public.site_articles. A policy body is parsed when the policy is created, so
-- on a project that has never run site_articles.sql this file stops four
-- hundred lines in with `relation "public.site_articles" does not exist` —
-- which is a true statement and a useless one.
--
-- So it is checked here, at the top, with the fix in the message. This is the
-- same class of trap supabase/README.md records against site_articles.sql's
-- own optional carry-over, caught in the other direction: that one must NOT
-- depend on a migration, this one MUST, and both should say so rather than
-- failing somewhere in the middle.
do $$
begin
  if to_regclass('public.site_articles') is null then
    raise exception
      'supabase/editorial_system.sql extends the article system and needs it: run supabase/site_articles.sql first, then run this file again.'
      using errcode = 'undefined_table';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The operator allowlist this file shares with the article manager.
--
-- IT HAS TO BE A RUNTIME GUARD AND A DYNAMIC ONE. site_articles.sql installs
-- site_article_is_admin(); this file must install cleanly whether or not that
-- has been run, because "the editorial system cannot be installed unless an
-- unrelated migration happened to run first" is the exact failure
-- site_articles.sql itself documents (see supabase/README.md). So: create a
-- fallback only if the real one is absent, and never overwrite the real one.
-- ---------------------------------------------------------------------------
-- Its allowlist table FIRST. A `language sql` function body is parsed and
-- validated when the function is created, not when it is called, so creating
-- the is-admin function before the table it reads fails outright on a bare
-- project — which is the exact class of ordering bug supabase/README.md
-- records against site_articles.sql, in the other direction.
create table if not exists public.site_article_admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  note     text,
  added_at timestamptz not null default now()
);
alter table public.site_article_admins enable row level security;
revoke all on public.site_article_admins from anon, authenticated;

-- And the function, only if site_articles.sql has not already installed it.
-- One allowlist for the whole operator surface, never two.
do $$
begin
  if to_regprocedure('public.site_article_is_admin()') is null then
    execute $fn$
      create function public.site_article_is_admin()
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select auth.uid() is not null
           and exists (select 1 from public.site_article_admins a where a.user_id = auth.uid());
      $body$;
    $fn$;
    execute 'revoke all on function public.site_article_is_admin() from public';
    execute 'grant execute on function public.site_article_is_admin() to authenticated';
  end if;
end $$;

-- ===========================================================================
-- 1. FEATURED GAMES — which games earn a permanent research trail.
-- ===========================================================================
create table if not exists public.editorial_featured_games (
  key                  text primary key,          -- 'NFL:2026_01_NE_SEA'
  game_id              text not null,
  sport                text not null,
  season               integer,
  week                 integer,
  away_team            text,
  home_team            text,
  away_code            text,
  home_code            text,
  game_time            timestamptz,
  kickoff_et           text,
  venue                text,
  neutral_site         boolean not null default false,
  -- NO BROADCASTER COLUMN, DELIBERATELY. No feed this repository reads carries
  -- one, and a nullable `network` column is an invitation for somebody to fill
  -- it in from memory. The kickoff WINDOW below is derived from the schedule
  -- and is a fact; the network is not held at all.
  window_key           text,
  window_label         text,
  national_window      boolean not null default false,
  standalone_window    boolean not null default false,
  stage                text,
  stage_label          text,
  playoff_flag         boolean not null default false,
  championship_flag    boolean not null default false,
  rivalry_flag         boolean not null default false,
  rivalry_label        text,
  ranking_weight       integer,                   -- the WORSE of the two ranks
  home_rank            integer,
  away_rank            integer,
  rank_pool            integer,
  model_disagreement   numeric,
  model_disagreement_text text,
  editorial_priority   numeric not null default 0,
  priority_components  jsonb not null default '[]'::jsonb,
  priority_floor       numeric,
  weekly_cap           integer,
  auto_selected        boolean not null default false,
  manual_override      text,                      -- 'feature' | 'unfeature' | null
  operator_note        text,
  overridden_at        timestamptz,
  overridden_by        uuid,
  pregame_enabled      boolean not null default true,
  postgame_enabled     boolean not null default true,
  status               text not null default 'considered',
  selection_note       text,
  scored_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Additive, column by column, so a table made by hand in the dashboard is
-- completed rather than left half-shaped by a no-op `create table if not
-- exists`. close_v7_parity.sql was bitten by exactly that.
alter table public.editorial_featured_games add column if not exists away_code text;
alter table public.editorial_featured_games add column if not exists home_code text;
alter table public.editorial_featured_games add column if not exists kickoff_et text;
alter table public.editorial_featured_games add column if not exists window_key text;
alter table public.editorial_featured_games add column if not exists window_label text;
alter table public.editorial_featured_games add column if not exists standalone_window boolean not null default false;
alter table public.editorial_featured_games add column if not exists stage text;
alter table public.editorial_featured_games add column if not exists stage_label text;
alter table public.editorial_featured_games add column if not exists rivalry_label text;
alter table public.editorial_featured_games add column if not exists rank_pool integer;
alter table public.editorial_featured_games add column if not exists model_disagreement_text text;
alter table public.editorial_featured_games add column if not exists priority_components jsonb not null default '[]'::jsonb;
alter table public.editorial_featured_games add column if not exists priority_floor numeric;
alter table public.editorial_featured_games add column if not exists weekly_cap integer;
alter table public.editorial_featured_games add column if not exists operator_note text;
alter table public.editorial_featured_games add column if not exists overridden_at timestamptz;
alter table public.editorial_featured_games add column if not exists overridden_by uuid;
alter table public.editorial_featured_games add column if not exists selection_note text;
alter table public.editorial_featured_games add column if not exists scored_at timestamptz;

alter table public.editorial_featured_games drop constraint if exists editorial_featured_status_ck;
alter table public.editorial_featured_games add constraint editorial_featured_status_ck
  check (status in ('featured', 'considered', 'excluded'));
alter table public.editorial_featured_games drop constraint if exists editorial_featured_override_ck;
alter table public.editorial_featured_games add constraint editorial_featured_override_ck
  check (manual_override is null or manual_override in ('feature', 'unfeature'));

create index if not exists editorial_featured_sport_idx
  on public.editorial_featured_games (sport, game_time desc);
create index if not exists editorial_featured_status_idx
  on public.editorial_featured_games (status, editorial_priority desc);
create index if not exists editorial_featured_week_idx
  on public.editorial_featured_games (sport, season, week);

-- ===========================================================================
-- 2. PREGAME SNAPSHOTS — immutable, and the database is what makes them so.
-- ===========================================================================
create table if not exists public.editorial_snapshots (
  snapshot_id      text primary key,              -- a content hash of the research
  key              text not null,
  game_id          text not null,
  sport            text not null,
  season           integer,
  week             integer,
  article_id       text,
  captured_at      timestamptz not null,
  kickoff          timestamptz,
  generation_version text,
  -- the whole captured state: game, model, market, drivers, matchups,
  -- advantages, uncertainty, the fact ledger and the verbatim research payload
  payload          jsonb not null,
  fact_count       integer,
  coverage         jsonb,
  created_at       timestamptz not null default now()
);
alter table public.editorial_snapshots add column if not exists fact_count integer;
alter table public.editorial_snapshots add column if not exists coverage jsonb;
alter table public.editorial_snapshots add column if not exists generation_version text;

create index if not exists editorial_snapshots_key_idx
  on public.editorial_snapshots (key, captured_at desc);
create index if not exists editorial_snapshots_article_idx
  on public.editorial_snapshots (article_id);

-- A SNAPSHOT CAPTURED AFTER KICKOFF IS NOT A PREGAME SNAPSHOT. Enforced here
-- as well as in tools/editorial/snapshot.js, because the whole audit rests on
-- it and a client-side check cannot see a row somebody inserted by hand.
alter table public.editorial_snapshots drop constraint if exists editorial_snapshots_pregame_ck;
alter table public.editorial_snapshots add constraint editorial_snapshots_pregame_ck
  check (kickoff is null or captured_at <= kickoff);

-- IMMUTABILITY, IN A TRIGGER RATHER THAN A POLICY. An RLS policy can say which
-- rows you may update; it cannot say which VALUES you may put in a column, and
-- "the payload may never change" is a statement about a value. A trigger can,
-- and it applies to the service role too — which is the point, because the
-- pipeline runs as the service role.
create or replace function public.editorial_snapshots_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.snapshot_id is distinct from old.snapshot_id
       or new.payload::text is distinct from old.payload::text
       or new.captured_at is distinct from old.captured_at
       or new.game_id is distinct from old.game_id
       or new.kickoff is distinct from old.kickoff then
      raise exception
        'editorial_snapshots is append-only: a pregame snapshot records what EdgeDesk said BEFORE a game and may never be edited (snapshot_id=%)',
        old.snapshot_id
        using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception
      'editorial_snapshots is append-only: a published article cites snapshot_id=% and deleting it would leave that article citing nothing',
      old.snapshot_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists editorial_snapshots_immutable_t on public.editorial_snapshots;
create trigger editorial_snapshots_immutable_t
  before update or delete on public.editorial_snapshots
  for each row execute function public.editorial_snapshots_immutable();

-- ===========================================================================
-- 3. THESIS AUDITS — what each pregame claim did, structurally.
-- ===========================================================================
create table if not exists public.editorial_thesis_audits (
  id                bigserial primary key,
  key               text not null,
  game_id           text not null,
  sport             text not null,
  season            integer,
  week              integer,
  article_id        text,
  snapshot_id       text references public.editorial_snapshots (snapshot_id),
  thesis_id         text not null,
  kind              text,
  category          text,
  weight            numeric,
  favours_team      text,
  pregame_claim     text not null,
  expected_signal   jsonb,
  observed_result   text,
  observed          jsonb,
  evaluation        text not null,
  confidence        text,
  why               text,
  lesson            text,
  future_adjustment text,
  audited_at        timestamptz not null default now(),
  unique (key, thesis_id)
);
alter table public.editorial_thesis_audits drop constraint if exists editorial_thesis_eval_ck;
alter table public.editorial_thesis_audits add constraint editorial_thesis_eval_ck
  check (evaluation in ('CONFIRMED', 'PARTIALLY CONFIRMED', 'NOT CONFIRMED', 'INCONCLUSIVE'));
create index if not exists editorial_thesis_cat_idx
  on public.editorial_thesis_audits (sport, category, evaluation);
create index if not exists editorial_thesis_key_idx
  on public.editorial_thesis_audits (key);

-- ===========================================================================
-- 4. THE GRADED RESULT — bet result and process grade, side by side and never
--    collapsed into one number.
-- ===========================================================================
create table if not exists public.editorial_game_grades (
  key                text primary key,
  game_id            text not null,
  sport              text not null,
  season             integer,
  week               integer,
  snapshot_id        text references public.editorial_snapshots (snapshot_id),
  article_id         text,
  home_team          text, away_team text,
  home_score         integer, away_score integer,
  -- the side EdgeDesk's own number implied against the quote it captured.
  -- NOT a pick: EdgeDesk publishes research, and the column is named for
  -- what it is so nothing downstream can quietly read it as one.
  implied_side       text,
  implied_team       text,
  implied_point      numeric,
  implied_gap        numeric,
  spread_result      text,
  total_result       text,
  moneyline_result   text,
  closing_home_margin numeric,
  closing_source     text,
  clv_points         numeric,
  margin_error       numeric,
  total_error        numeric,
  inside_published_range boolean,
  process_grade      text,
  verdict_key        text,
  verdict_line       text,
  variance_markers   jsonb not null default '[]'::jsonb,
  payload            jsonb,
  graded_at          timestamptz not null default now()
);
alter table public.editorial_game_grades drop constraint if exists editorial_grades_process_ck;
alter table public.editorial_game_grades add constraint editorial_grades_process_ck
  check (process_grade is null or process_grade in ('SOUND', 'MIXED', 'UNSOUND', 'UNTESTED'));
alter table public.editorial_game_grades drop constraint if exists editorial_grades_bet_ck;
alter table public.editorial_game_grades add constraint editorial_grades_bet_ck
  check (spread_result is null or spread_result in ('win', 'loss', 'push'));
create index if not exists editorial_grades_quadrant_idx
  on public.editorial_game_grades (sport, spread_result, process_grade);

-- ===========================================================================
-- 5. RESEARCH LESSONS — the long-term memory.
-- ===========================================================================
create table if not exists public.editorial_research_lessons (
  id                     text primary key,
  game_id                text not null,
  sport                  text,
  season                 integer,
  week                   integer,
  team                   text,
  opponent               text,
  article_id             text,
  snapshot_id            text,
  thesis_id              text,
  category               text not null,
  evaluation             text,
  pregame_expectation    text,
  actual_result          text,
  lesson                 text not null,
  severity               text not null default 'low',
  model_review_required  boolean not null default false,
  suggested_investigation text,
  bet_result             text,
  process_grade          text,
  created_at             timestamptz not null default now()
);
alter table public.editorial_research_lessons drop constraint if exists editorial_lessons_sev_ck;
alter table public.editorial_research_lessons add constraint editorial_lessons_sev_ck
  check (severity in ('low', 'medium', 'high'));
create index if not exists editorial_lessons_cat_idx
  on public.editorial_research_lessons (sport, category, created_at desc);
create index if not exists editorial_lessons_review_idx
  on public.editorial_research_lessons (model_review_required) where model_review_required;

-- ===========================================================================
-- 6. MODEL-REVIEW CANDIDATES — a question with evidence, closed by a person.
-- ===========================================================================
create table if not exists public.editorial_model_reviews (
  key              text primary key,
  sport            text,
  category         text,
  question         text not null,
  status           text not null default 'open',
  occurrences      integer not null default 0,
  recurring        boolean not null default false,
  evidence         jsonb not null default '[]'::jsonb,
  note             text,
  disposition      text,
  disposition_note text,
  closed_at        timestamptz,
  closed_by        uuid,
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.editorial_model_reviews drop constraint if exists editorial_reviews_status_ck;
alter table public.editorial_model_reviews add constraint editorial_reviews_status_ck
  check (status in ('open', 'investigating', 'reopened', 'closed'));
alter table public.editorial_model_reviews drop constraint if exists editorial_reviews_disposition_ck;
alter table public.editorial_model_reviews add constraint editorial_reviews_disposition_ck
  check (disposition is null or disposition in
    ('validated_change', 'no_change_needed', 'wont_fix', 'needs_more_data', 'duplicate'));

-- ONLY A PERSON CLOSES A CANDIDATE, and closing one requires saying why and
-- who. A pipeline that could close its own investigations would be a pipeline
-- that tunes itself on one Sunday, which is the thing this whole subsystem is
-- built not to do.
create or replace function public.editorial_reviews_guard()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.status = 'closed' then
    if new.disposition is null or length(coalesce(new.disposition_note, '')) < 20 then
      raise exception
        'a model-review candidate is closed by a PERSON writing a disposition: set disposition and a disposition_note of at least 20 characters (key=%)',
        new.key using errcode = 'check_violation';
    end if;
    if new.closed_by is null then
      new.closed_by := auth.uid();
    end if;
    if new.closed_by is null then
      raise exception
        'a model-review candidate must record WHO closed it; closed_by is null and there is no authenticated user in this session (key=%)',
        new.key using errcode = 'check_violation';
    end if;
    if new.closed_at is null then new.closed_at := now(); end if;
  else
    new.closed_at := null;
    new.closed_by := null;
  end if;
  return new;
end;
$$;
drop trigger if exists editorial_reviews_guard_t on public.editorial_model_reviews;
create trigger editorial_reviews_guard_t before insert or update on public.editorial_model_reviews
  for each row execute function public.editorial_reviews_guard();

-- ===========================================================================
-- 7. THE RUN LOG — observability, bounded.
-- ===========================================================================
create table if not exists public.editorial_runs (
  id        bigserial primary key,
  run       text not null,
  phase     text,
  step      text not null,
  key       text,
  ok        boolean not null,
  reason    text,
  detail    jsonb,
  at        timestamptz not null default now()
);
create index if not exists editorial_runs_at_idx on public.editorial_runs (at desc);
create index if not exists editorial_runs_key_idx on public.editorial_runs (key, step, at desc);
create index if not exists editorial_runs_failed_idx on public.editorial_runs (at desc) where not ok;

-- ===========================================================================
-- RLS
-- ===========================================================================
alter table public.editorial_featured_games  enable row level security;
alter table public.editorial_snapshots       enable row level security;
alter table public.editorial_thesis_audits   enable row level security;
alter table public.editorial_game_grades     enable row level security;
alter table public.editorial_research_lessons enable row level security;
alter table public.editorial_model_reviews   enable row level security;
alter table public.editorial_runs            enable row level security;

-- WHAT THE PUBLIC MAY READ is exactly what a published article already shows.
-- A snapshot whose article is not published is the research behind a page
-- nobody has published, and it stays invisible; the same is true of an audit,
-- a grade and a lesson. That is a structural fact rather than a filter
-- somebody has to remember, and it is the same boundary
-- supabase/brief_record.sql draws for the public CLV page.
drop policy if exists "editorial featured public read" on public.editorial_featured_games;
create policy "editorial featured public read" on public.editorial_featured_games
  for select to anon, authenticated using (
    exists (select 1 from public.site_articles a
            where a.game_id = editorial_featured_games.game_id and a.status = 'published')
  );

drop policy if exists "editorial snapshots public read" on public.editorial_snapshots;
create policy "editorial snapshots public read" on public.editorial_snapshots
  for select to anon, authenticated using (
    exists (select 1 from public.site_articles a
            where a.game_id = editorial_snapshots.game_id and a.status = 'published')
  );

drop policy if exists "editorial audits public read" on public.editorial_thesis_audits;
create policy "editorial audits public read" on public.editorial_thesis_audits
  for select to anon, authenticated using (
    exists (select 1 from public.site_articles a
            where a.game_id = editorial_thesis_audits.game_id and a.status = 'published')
  );

drop policy if exists "editorial grades public read" on public.editorial_game_grades;
create policy "editorial grades public read" on public.editorial_game_grades
  for select to anon, authenticated using (
    exists (select 1 from public.site_articles a
            where a.game_id = editorial_game_grades.game_id and a.status = 'published')
  );

drop policy if exists "editorial lessons public read" on public.editorial_research_lessons;
create policy "editorial lessons public read" on public.editorial_research_lessons
  for select to anon, authenticated using (
    exists (select 1 from public.site_articles a
            where a.game_id = editorial_research_lessons.game_id and a.status = 'published')
  );

-- The run log and the review queue are OPERATIONAL and are not public. A run
-- log names the games EdgeDesk considered and did not publish, and an open
-- review candidate is an unresolved doubt about the model; neither is a
-- secret, and neither is a page.
-- (No public select policy: RLS denies by default.)

-- The operator: everything, on every table.
do $$
declare t text;
begin
  foreach t in array array['editorial_featured_games', 'editorial_snapshots',
                           'editorial_thesis_audits', 'editorial_game_grades',
                           'editorial_research_lessons', 'editorial_model_reviews',
                           'editorial_runs']
  loop
    execute format('drop policy if exists %I on public.%I', t || ' admin read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.site_article_is_admin())',
                   t || ' admin read', t);
    execute format('drop policy if exists %I on public.%I', t || ' admin insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.site_article_is_admin())',
                   t || ' admin insert', t);
    -- NO UPDATE POLICY ON THE SNAPSHOTS, for anybody. The trigger above would
    -- refuse a payload edit; not granting the update at all means the refusal
    -- never has to fire.
    if t <> 'editorial_snapshots' then
      execute format('drop policy if exists %I on public.%I', t || ' admin update', t);
      execute format('create policy %I on public.%I for update to authenticated using (public.site_article_is_admin()) with check (public.site_article_is_admin())',
                     t || ' admin update', t);
    end if;
  end loop;
end $$;

-- Deleting a featured row or a run-log line is housekeeping; deleting a
-- snapshot, an audit or a lesson is erasing a record EdgeDesk published
-- against. The first is granted, the rest are not.
drop policy if exists "editorial featured admin delete" on public.editorial_featured_games;
create policy "editorial featured admin delete" on public.editorial_featured_games
  for delete to authenticated using (public.site_article_is_admin());
drop policy if exists "editorial runs admin delete" on public.editorial_runs;
create policy "editorial runs admin delete" on public.editorial_runs
  for delete to authenticated using (public.site_article_is_admin());

grant select on public.editorial_featured_games, public.editorial_snapshots,
               public.editorial_thesis_audits, public.editorial_game_grades,
               public.editorial_research_lessons to anon;
grant select, insert, update, delete on public.editorial_featured_games to authenticated;
grant select, insert on public.editorial_snapshots to authenticated;
grant select, insert, update on public.editorial_thesis_audits,
               public.editorial_game_grades, public.editorial_research_lessons,
               public.editorial_model_reviews to authenticated;
grant select, insert, update, delete on public.editorial_runs to authenticated;

-- An operator's override, stamped. Same reasoning as site_articles_touch():
-- "record who changed this and when" is a promise a browser can forget to keep.
create or replace function public.editorial_featured_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.manual_override is distinct from old.manual_override then
    new.overridden_at := now();
    if new.overridden_by is null then new.overridden_by := auth.uid(); end if;
  end if;
  -- the status is a FUNCTION of the two decisions, never typed in by hand
  new.status := case
    when new.manual_override = 'unfeature' then 'excluded'
    when new.manual_override = 'feature'   then 'featured'
    when new.auto_selected                 then 'featured'
    else 'considered' end;
  return new;
end;
$$;
drop trigger if exists editorial_featured_touch_t on public.editorial_featured_games;
create trigger editorial_featured_touch_t before insert or update on public.editorial_featured_games
  for each row execute function public.editorial_featured_touch();

-- ---------------------------------------------------------------------------
-- The standing questions, as a view, so the research memory can be asked of
-- the database as well as of the committed file. Operator-only by inheritance:
-- it reads tables whose RLS already decides who sees what.
-- ---------------------------------------------------------------------------
create or replace view public.editorial_research_memory as
  select
    g.sport,
    count(*)                                                              as graded_games,
    count(*) filter (where g.spread_result = 'win'  and g.process_grade = 'SOUND')   as right_for_right_reason,
    count(*) filter (where g.spread_result = 'win'  and g.process_grade = 'UNSOUND') as right_for_wrong_reason,
    count(*) filter (where g.spread_result = 'loss' and g.process_grade = 'SOUND')   as wrong_for_right_reason,
    count(*) filter (where g.spread_result = 'loss' and g.process_grade = 'UNSOUND') as wrong_for_wrong_reason,
    count(*) filter (where g.process_grade = 'UNTESTED')                  as untested,
    round(avg(g.clv_points)::numeric, 3)                                  as avg_clv_points,
    round(avg(g.margin_error)::numeric, 2)                                as avg_margin_error,
    round(avg(g.total_error)::numeric, 2)                                 as avg_total_error,
    count(*) filter (where g.inside_published_range is false)             as outside_published_range
  from public.editorial_game_grades g
  group by g.sport;
alter view public.editorial_research_memory set (security_invoker = true);
grant select on public.editorial_research_memory to authenticated;

comment on table public.editorial_featured_games is
  'Which games earn automated editorial coverage. editorial_priority and its itemised components are computed by tools/editorial/featured.js; manual_override is the operator''s decision and outranks it. No broadcaster column: no feed this repository reads carries one.';
comment on table public.editorial_snapshots is
  'APPEND-ONLY. The exact research state a pregame article was written from, identified by a content hash of itself. A trigger refuses any edit or delete, including by the service role: every postgame audit rests on this not having moved.';
comment on table public.editorial_game_grades is
  'The bet result and the process grade, side by side, computed separately and allowed to disagree. implied_side is the side EdgeDesk''s own number implied against a captured quote — it is NOT a pick, and EdgeDesk publishes none.';
comment on table public.editorial_model_reviews is
  'Questions with evidence attached, raised automatically when a weighted published claim is contradicted. NOTHING in this schema or this repository changes a model weight from a row here; a trigger requires a person, a disposition and a note to close one.';

commit;

-- Report: every row should say ok.
select 1 as step, 'tables exist' as check,
  case when to_regclass('public.editorial_featured_games') is not null
        and to_regclass('public.editorial_snapshots') is not null
        and to_regclass('public.editorial_thesis_audits') is not null
        and to_regclass('public.editorial_game_grades') is not null
        and to_regclass('public.editorial_research_lessons') is not null
        and to_regclass('public.editorial_model_reviews') is not null
        and to_regclass('public.editorial_runs') is not null then 'ok' else 'CHECK THIS' end as outcome
union all select 2, 'RLS on every editorial table',
  case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname like 'editorial_%' and c.relkind = 'r'
               and not c.relrowsecurity) = 0 then 'ok' else 'CHECK THIS' end
union all select 3, 'snapshots are append-only (trigger present)',
  case when exists (select 1 from pg_trigger where tgname = 'editorial_snapshots_immutable_t') then 'ok' else 'CHECK THIS' end
union all select 4, 'snapshots have NO update policy for anybody',
  case when not exists (select 1 from pg_policies where tablename = 'editorial_snapshots' and cmd = 'UPDATE')
       then 'ok' else 'CHECK THIS' end
union all select 5, 'snapshots have no delete grant',
  case when not exists (select 1 from pg_policies where tablename = 'editorial_snapshots' and cmd = 'DELETE')
       then 'ok' else 'CHECK THIS' end
union all select 6, 'a pregame snapshot cannot postdate kickoff',
  case when exists (select 1 from pg_constraint where conname = 'editorial_snapshots_pregame_ck') then 'ok' else 'CHECK THIS' end
union all select 7, 'a review candidate needs a person to close it',
  case when exists (select 1 from pg_trigger where tgname = 'editorial_reviews_guard_t') then 'ok' else 'CHECK THIS' end
union all select 8, 'the four thesis verdicts are constrained',
  case when exists (select 1 from pg_constraint where conname = 'editorial_thesis_eval_ck') then 'ok' else 'CHECK THIS' end
union all select 9, 'the four process grades are constrained',
  case when exists (select 1 from pg_constraint where conname = 'editorial_grades_process_ck') then 'ok' else 'CHECK THIS' end
-- WHAT STOPS anon WRITING IS THE POLICY SET, NOT THE GRANT: Supabase issues a
-- default grant on the public schema and relies on RLS to decide what a role
-- may touch, so a check for the absence of a grant reports CHECK THIS on every
-- correctly configured project. What must be true is that no policy admits
-- anon to anything but a select.
union all select 10, 'anon has no policy that writes',
  case when not exists (select 1 from pg_policies
      where tablename like 'editorial_%' and cmd <> 'SELECT'
        and ('anon' = any(roles) or 'public' = any(roles))) then 'ok' else 'CHECK THIS' end
union all select 11, 'the public sees only what a published article shows',
  case when (select count(*) from pg_policies
             where tablename in ('editorial_snapshots','editorial_thesis_audits',
                                 'editorial_game_grades','editorial_research_lessons')
               and 'anon' = any(roles) and qual like '%site_articles%published%') = 4
       then 'ok' else 'CHECK THIS' end
union all select 12, 'the run log and the review queue are not public',
  case when not exists (select 1 from pg_policies
      where tablename in ('editorial_runs', 'editorial_model_reviews') and 'anon' = any(roles))
       then 'ok' else 'CHECK THIS' end
union all select 13, 'one operator allowlist, not two',
  case when to_regprocedure('public.site_article_is_admin()') is not null then 'ok' else 'CHECK THIS' end
order by 1;
