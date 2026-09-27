-- ===========================================================================
-- EdgeDesk Games — the weekly leaderboard.
--
-- NOT DEPLOYED BY THIS REPOSITORY. Like every other file in supabase/, this is
-- the definition; applying it is a deliberate act against the project. Until it
-- is applied, games/lib/leaderboard.js returns { available:false } and the page
-- renders "No leaderboard results yet. Be the first." — which is the correct
-- thing for a board with no players, deployed or not.
--
-- DESIGN NOTES
--
-- * One row per player per football week. The week key is the boundary
--   documented in games/lib/week.js (Tuesday 07:00 UTC) and is supplied by the
--   client rather than derived here, so the browser, the tests and the table
--   can never disagree about which week a score belongs to.
--
-- * A player must own their row. Writes are keyed on auth.uid(), so a signed-in
--   player can publish and amend their OWN score and nobody else's. There is no
--   anonymous write path: an anonymous player keeps their score in localStorage
--   and appears on the board only once they have an account. That is the point
--   at which a leaderboard identity starts to mean something.
--
-- * Reads are public, because a leaderboard nobody can see is not one. Only the
--   display name and the score are exposed — never the account, never an email.
--
-- * NOTHING HERE FABRICATES A PLAYER. There is no seed data in this file and
--   there must never be any.
-- ===========================================================================

create table if not exists public.games_weekly_scores (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  week_key         text        not null,
  display_name     text        not null,
  score            integer     not null default 0 check (score >= 0),
  price_it_played  integer     not null default 0 check (price_it_played >= 0),
  pick5_correct    integer     not null default 0 check (pick5_correct >= 0),
  scoring_version  text        not null default 'price_it_v1',
  updated_at       timestamptz not null default now(),
  primary key (user_id, week_key)
);

-- the board's only query: this week, best first
create index if not exists games_weekly_scores_board
  on public.games_weekly_scores (week_key, score desc);

-- a display name is a public handle, not a free-text field
alter table public.games_weekly_scores
  drop constraint if exists games_weekly_scores_display_name_shape;
alter table public.games_weekly_scores
  add constraint games_weekly_scores_display_name_shape
  check (char_length(display_name) between 2 and 24
         and display_name !~ '[<>]');

-- a week key is the documented boundary's ISO date, and nothing else
alter table public.games_weekly_scores
  drop constraint if exists games_weekly_scores_week_shape;
alter table public.games_weekly_scores
  add constraint games_weekly_scores_week_shape
  check (week_key ~ '^\d{4}-\d{2}-\d{2}$');

alter table public.games_weekly_scores enable row level security;

-- READ: public. The board is the product.
drop policy if exists games_weekly_scores_read on public.games_weekly_scores;
create policy games_weekly_scores_read
  on public.games_weekly_scores for select
  using (true);

-- WRITE: your own row only.
drop policy if exists games_weekly_scores_insert on public.games_weekly_scores;
create policy games_weekly_scores_insert
  on public.games_weekly_scores for insert
  with check (auth.uid() = user_id);

drop policy if exists games_weekly_scores_update on public.games_weekly_scores;
create policy games_weekly_scores_update
  on public.games_weekly_scores for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists games_weekly_scores_delete on public.games_weekly_scores;
create policy games_weekly_scores_delete
  on public.games_weekly_scores for delete
  using (auth.uid() = user_id);

-- Historical weeks are kept, not truncated: a player's past weeks are part of
-- their record, and the board for an old week is a plain read with that key.
-- No scheduled deletion is defined here on purpose.

comment on table public.games_weekly_scores is
  'EdgeDesk Games weekly leaderboard. One row per player per football week '
  '(boundary: Tuesday 07:00 UTC, see games/lib/week.js). Public read, owner-only '
  'write. Free-to-play points only — never currency, never a wager, never a prize.';
