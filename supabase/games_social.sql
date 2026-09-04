-- ===========================================================================
-- EDGEDESK GAMES — the social layer: Head-to-Head and Groups.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHAT THIS IS FOR
--   EdgeDesk Games is free-to-play. Nothing here is a wager: there is no
--   balance, no currency, no entry fee, no prize. A "win" is a row saying you
--   read a football game better than a friend did, and nothing else.
--
-- THE ONE THING THIS FILE EXISTS TO GUARANTEE
--   In Head-to-Head, your opponent's prediction is SECRET until both players
--   have locked. That is an integrity requirement, not a UI preference: if the
--   second player can read the first player's answer, the game is worthless.
--
--   So the secret does not live in the same table as everything else.
--
--     game_challenge_entries      who is playing, when they submitted, how they
--                                 did. NO prediction. Safe to read.
--     game_challenge_selections   the prediction itself. NOT SELECTABLE BY ANY
--                                 CLIENT ROLE AT ALL — no policy grants read on
--                                 it, so RLS denies by default, permanently.
--
--   The only way to read a prediction is h2h_view(), a security-definer
--   function that returns the opponent's answer if and only if the challenge is
--   locked. Column-level grants or a "hide it unless locked" policy would also
--   work, but a table nobody can select from makes the boundary a STRUCTURAL
--   FACT rather than a policy that has to stay correct forever. This is the
--   same reasoning publisher_briefs uses to split public payload from engine
--   internals.
--
-- ANONYMOUS PLAYERS
--   The whole growth loop depends on a friend playing before they sign up, so
--   an entry may have no user_id. Such a player proves who they are with a
--   high-entropy secret their browser generated, and the server stores only its
--   SHA-256. Possession of the secret is the identity; the server never accepts
--   a client-supplied user id as proof of anything. Claiming an anonymous entry
--   later (h2h_claim) is how a signup inherits a record.
--
-- WRITES
--   Every mutation goes through a security-definer function. The tables grant
--   no insert/update/delete to any client role. Scoring, locking and settlement
--   are therefore server-side facts, never something the page asserts.
-- ===========================================================================

begin;

create extension if not exists pgcrypto;

-- ── helpers ───────────────────────────────────────────────────────────────

-- SHA-256 of a bearer secret. The secret itself is never stored.
create or replace function public.games_hash(p_secret text)
returns text language sql immutable as $$
  select case
    when p_secret is null or length(p_secret) < 16 then null
    else encode(digest(p_secret, 'sha256'), 'hex')
  end;
$$;

-- An opaque, URL-safe invite token. 26 chars of base32-ish alphabet drawn from
-- gen_random_bytes: ~130 bits, so enumeration is not a threat model, it is
-- arithmetic. Ambiguous characters are excluded so a token survives being read
-- aloud or retyped from a screenshot.
create or replace function public.games_token(p_len integer default 26)
returns text language plpgsql volatile as $$
declare
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  out text := '';
  i integer;
begin
  for i in 1..p_len loop
    out := out || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % length(alphabet)), 1);
  end loop;
  return out;
end;
$$;

-- ── head-to-head ──────────────────────────────────────────────────────────

create table if not exists public.game_challenges (
  id                 uuid primary key default gen_random_uuid(),
  invite_token       text not null unique default public.games_token(),
  mode               text not null check (mode in ('winner', 'spread', 'price_it')),
  sport              text not null default 'americanfootball_ncaaf',
  canonical_game_id  text not null,
  game_slug          text,
  home_team          text not null,
  away_team          text not null,
  kickoff            timestamptz,
  -- The market as it stood when the challenge was CREATED. A spread challenge
  -- is settled against this and never against a number that moved afterwards.
  market_snapshot    jsonb not null default '{}'::jsonb,
  status             text not null default 'WAITING'
                       check (status in ('WAITING','LOCKED','LIVE','FINAL','DRAW','EXPIRED','CANCELLED')),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz,
  locked_at          timestamptz,
  settled_at         timestamptz,
  -- Immutable once written. A completed challenge is never silently re-graded;
  -- a correction writes a new row into game_challenge_corrections and says so.
  settlement         jsonb,
  group_id           uuid
);

create index if not exists game_challenges_game on public.game_challenges (canonical_game_id);
create index if not exists game_challenges_group on public.game_challenges (group_id) where group_id is not null;
create index if not exists game_challenges_open on public.game_challenges (status, kickoff);

create table if not exists public.game_challenge_entries (
  challenge_id   uuid not null references public.game_challenges (id) on delete cascade,
  player_slot    text not null check (player_slot in ('a', 'b')),
  user_id        uuid references auth.users (id) on delete set null,
  anon_hash      text,
  display_name   text not null check (char_length(display_name) between 1 and 24),
  submitted_at   timestamptz not null default now(),
  -- filled at settlement, never by a client
  result         text check (result in ('win', 'loss', 'draw')),
  score          numeric,
  rating_before  integer,
  rating_after   integer,
  primary key (challenge_id, player_slot),
  -- an entry is owned by an account OR by a bearer secret, never neither
  constraint game_challenge_entries_identified
    check (user_id is not null or anon_hash is not null)
);

create index if not exists game_challenge_entries_user on public.game_challenge_entries (user_id)
  where user_id is not null;
create index if not exists game_challenge_entries_anon on public.game_challenge_entries (anon_hash)
  where anon_hash is not null;

-- THE SECRET. No client role may select this table. See the header.
create table if not exists public.game_challenge_selections (
  challenge_id uuid not null references public.game_challenges (id) on delete cascade,
  player_slot  text not null check (player_slot in ('a', 'b')),
  selection    jsonb not null,
  primary key (challenge_id, player_slot),
  foreign key (challenge_id, player_slot)
    references public.game_challenge_entries (challenge_id, player_slot) on delete cascade
);

-- A visible, append-only record of any regrade. Nothing is ever quietly fixed.
create table if not exists public.game_challenge_corrections (
  id            uuid primary key default gen_random_uuid(),
  challenge_id  uuid not null references public.game_challenges (id) on delete cascade,
  corrected_at  timestamptz not null default now(),
  reason        text not null,
  previous      jsonb not null,
  replacement   jsonb not null
);

-- ── groups ────────────────────────────────────────────────────────────────

create table if not exists public.game_groups (
  id             uuid primary key default gen_random_uuid(),
  invite_token   text not null unique default public.games_token(),
  slug           text not null,
  name           text not null check (char_length(name) between 2 and 40),
  emoji          text check (emoji is null or char_length(emoji) <= 8),
  owner_user_id  uuid not null references auth.users (id) on delete cascade,
  created_at     timestamptz not null default now(),
  member_cap     integer not null default 50 check (member_cap between 2 and 200)
);

create index if not exists game_groups_owner on public.game_groups (owner_user_id);

create table if not exists public.game_group_members (
  group_id      uuid not null references public.game_groups (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 24),
  role          text not null default 'member' check (role in ('owner', 'member')),
  joined_at     timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists game_group_members_user on public.game_group_members (user_id);

-- ── the activity feed ─────────────────────────────────────────────────────
-- A SPORTS ACTIVITY FEED. Rows are written by the server when something real
-- happens; there is no free-text field a person can post into, deliberately.
create table if not exists public.game_activity (
  id           bigserial primary key,
  group_id     uuid references public.game_groups (id) on delete cascade,
  kind         text not null check (kind in
                 ('h2h_settled','h2h_created','group_joined','pick5_result','price_it_result','rank_change')),
  actor_name   text,
  subject_name text,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists game_activity_group on public.game_activity (group_id, created_at desc);

-- ── ratings ───────────────────────────────────────────────────────────────
create table if not exists public.game_ratings (
  user_id     uuid not null references auth.users (id) on delete cascade,
  game_type   text not null check (game_type in ('h2h', 'price_it')),
  rating      integer not null default 1200,
  played      integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, game_type)
);

create table if not exists public.game_rating_history (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  game_type   text not null,
  rating      integer not null,
  delta       integer not null,
  reason      text,
  created_at  timestamptz not null default now()
);

create index if not exists game_rating_history_user on public.game_rating_history (user_id, created_at desc);

-- ===========================================================================
-- ROW LEVEL SECURITY
--
-- Enabled everywhere. The DEFAULT IS DENY: a table with RLS on and no policy
-- for an operation refuses that operation for every client role. What follows
-- grants back only what a client genuinely needs to read directly; everything
-- else goes through the security-definer functions below.
-- ===========================================================================

alter table public.game_challenges            enable row level security;
alter table public.game_challenge_entries     enable row level security;
alter table public.game_challenge_selections  enable row level security;
alter table public.game_challenge_corrections enable row level security;
alter table public.game_groups                enable row level security;
alter table public.game_group_members         enable row level security;
alter table public.game_activity              enable row level security;
alter table public.game_ratings               enable row level security;
alter table public.game_rating_history        enable row level security;

-- game_challenge_selections: NO POLICY. NOT ONE. This is the point.
-- Any select, insert, update or delete from anon or authenticated is refused by
-- RLS. h2h_view() is the only reader, and it decides what may be seen.

-- A signed-in player may read their own entries (for "your active challenges").
drop policy if exists game_challenge_entries_own on public.game_challenge_entries;
create policy game_challenge_entries_own
  on public.game_challenge_entries for select
  using (user_id is not null and user_id = auth.uid());

-- Challenges are addressed by an unguessable token through h2h_view(), so no
-- blanket select is granted here either. A signed-in player may see the
-- challenges they are actually in, which is what the home page needs.
drop policy if exists game_challenges_mine on public.game_challenges;
create policy game_challenges_mine
  on public.game_challenges for select
  using (exists (
    select 1 from public.game_challenge_entries e
    where e.challenge_id = game_challenges.id
      and e.user_id is not null and e.user_id = auth.uid()));

-- Corrections are public for any challenge you can already see.
drop policy if exists game_challenge_corrections_read on public.game_challenge_corrections;
create policy game_challenge_corrections_read
  on public.game_challenge_corrections for select
  using (exists (
    select 1 from public.game_challenge_entries e
    where e.challenge_id = game_challenge_corrections.challenge_id
      and e.user_id is not null and e.user_id = auth.uid()));

-- "Is the caller in this group?" — as a SECURITY DEFINER function, because a
-- policy on game_group_members that asks game_group_members the question sends
-- Postgres into infinite recursion. The function bypasses RLS to answer, which
-- is safe: it takes a group id and returns a boolean about the CALLER, so it
-- cannot be used to read anybody's membership but your own.
create or replace function public.games_is_member(p_group uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.game_group_members m
     where m.group_id = p_group and m.user_id = auth.uid());
$$;

-- A private group is visible to its members. Non-members reach it only through
-- group_preview(), which returns a name and a headcount and nothing else.
drop policy if exists game_groups_member on public.game_groups;
create policy game_groups_member
  on public.game_groups for select
  using (public.games_is_member(id));

drop policy if exists game_group_members_same_group on public.game_group_members;
create policy game_group_members_same_group
  on public.game_group_members for select
  using (public.games_is_member(group_id));

drop policy if exists game_activity_member on public.game_activity;
create policy game_activity_member
  on public.game_activity for select
  using (group_id is null or public.games_is_member(group_id));

-- Ratings are public: a leaderboard is the product. Emails and ids are not
-- exposed by any of the read paths below.
drop policy if exists game_ratings_read on public.game_ratings;
create policy game_ratings_read on public.game_ratings for select using (true);

drop policy if exists game_rating_history_own on public.game_rating_history;
create policy game_rating_history_own
  on public.game_rating_history for select using (user_id = auth.uid());

commit;

-- ===========================================================================
-- FUNCTIONS
--
-- Every mutation and every privileged read lives here. They are SECURITY
-- DEFINER, so they run as the owner and bypass RLS — which is exactly why each
-- one re-derives WHO IS CALLING from auth.uid() or from a bearer secret, and
-- never from an argument that names a user.
--
-- `search_path` is pinned on all of them: a security-definer function that
-- resolves an unqualified name through a caller-controlled search_path is the
-- classic way this pattern is turned into privilege escalation.
-- ===========================================================================

begin;

-- Resolve the caller of a challenge function to a slot, or null if they are a
-- stranger. An account beats a bearer secret; a secret is accepted only if it
-- hashes to a stored entry on THIS challenge.
create or replace function public.h2h_slot_of(p_challenge uuid, p_secret text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select e.player_slot
  from public.game_challenge_entries e
  where e.challenge_id = p_challenge
    and ((auth.uid() is not null and e.user_id = auth.uid())
      or (p_secret is not null and e.anon_hash is not null
          and e.anon_hash = public.games_hash(p_secret)))
  order by (e.user_id is not null) desc
  limit 1;
$$;

-- Create a challenge and lodge the creator's prediction in one statement, so a
-- challenge can never exist in a state where it has been shared but its creator
-- has not actually committed to an answer.
create or replace function public.h2h_create(
  p_mode text, p_sport text, p_game_id text, p_game_slug text,
  p_home text, p_away text, p_kickoff timestamptz,
  p_market jsonb, p_selection jsonb, p_display_name text,
  p_secret text default null, p_group uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_token text;
  v_hash text := public.games_hash(p_secret);
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  if auth.uid() is null and v_hash is null then
    raise exception 'a player must be signed in or present a bearer secret'
      using errcode = '28000';
  end if;
  if p_mode not in ('winner', 'spread', 'price_it') then
    raise exception 'unknown challenge mode %', p_mode using errcode = '22023';
  end if;
  if p_selection is null or p_selection = 'null'::jsonb then
    raise exception 'a challenge is created with its author''s prediction' using errcode = '22023';
  end if;
  -- A spread challenge without a snapshotted line has nothing to settle against.
  if p_mode = 'spread' and (p_market->>'spread') is null then
    raise exception 'a spread challenge requires a market snapshot' using errcode = '22023';
  end if;
  v_name := coalesce(v_name, 'Player');
  if p_group is not null and not exists (
      select 1 from public.game_group_members m
      where m.group_id = p_group and m.user_id = auth.uid()) then
    raise exception 'not a member of that group' using errcode = '42501';
  end if;

  insert into public.game_challenges
    (mode, sport, canonical_game_id, game_slug, home_team, away_team, kickoff,
     market_snapshot, expires_at, group_id)
  values
    (p_mode, coalesce(p_sport, 'americanfootball_ncaaf'), p_game_id, p_game_slug,
     p_home, p_away, p_kickoff, coalesce(p_market, '{}'::jsonb),
     coalesce(p_kickoff, now() + interval '14 days'), p_group)
  returning id, invite_token into v_id, v_token;

  insert into public.game_challenge_entries
    (challenge_id, player_slot, user_id, anon_hash, display_name)
  values (v_id, 'a', auth.uid(), case when auth.uid() is null then v_hash end, left(v_name, 24));

  insert into public.game_challenge_selections (challenge_id, player_slot, selection)
  values (v_id, 'a', p_selection);

  return jsonb_build_object('id', v_id, 'invite_token', v_token, 'status', 'WAITING');
end;
$$;

-- The opponent's submission. This is the function that must not be fooled.
create or replace function public.h2h_submit(
  p_token text, p_selection jsonb, p_display_name text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.game_challenges%rowtype;
  v_hash text := public.games_hash(p_secret);
  v_name text := coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), 'Player');
  v_taken integer;
begin
  select * into c from public.game_challenges where invite_token = p_token for update;
  if not found then
    raise exception 'no such challenge' using errcode = 'P0002';
  end if;
  if auth.uid() is null and v_hash is null then
    raise exception 'a player must be signed in or present a bearer secret' using errcode = '28000';
  end if;
  if c.status <> 'WAITING' then
    raise exception 'this challenge is already %', c.status using errcode = '22023';
  end if;
  -- NOTE: this does NOT write status = 'EXPIRED' here. The raise below would
  -- roll that write straight back, which is how "expired" quietly stayed
  -- "WAITING" in the first draft. Expiry is DERIVED (see h2h_view) and
  -- persisted separately by h2h_sweep_expired().
  if c.expires_at is not null and c.expires_at < now() then
    raise exception 'this challenge has expired' using errcode = '22023';
  end if;
  -- You cannot play yourself, and you cannot submit twice.
  if public.h2h_slot_of(c.id, p_secret) is not null then
    raise exception 'you have already submitted to this challenge' using errcode = '23505';
  end if;
  select count(*) into v_taken from public.game_challenge_entries where challenge_id = c.id;
  if v_taken >= 2 then
    raise exception 'this challenge already has two players' using errcode = '23505';
  end if;

  insert into public.game_challenge_entries
    (challenge_id, player_slot, user_id, anon_hash, display_name)
  values (c.id, 'b', auth.uid(), case when auth.uid() is null then v_hash end, left(v_name, 24));

  insert into public.game_challenge_selections (challenge_id, player_slot, selection)
  values (c.id, 'b', p_selection);

  -- Both are in: the challenge locks, and only now does either answer become
  -- readable by the other player.
  update public.game_challenges
     set status = 'LOCKED', locked_at = now()
   where id = c.id;

  return jsonb_build_object('id', c.id, 'status', 'LOCKED');
end;
$$;

-- THE READ PATH. The only way any client sees a prediction.
--
-- Returns the challenge, both entries, and selections under exactly one rule:
--   * the challenge is locked  -> both selections;
--   * otherwise                -> the caller's own selection only.
-- A stranger with the link sees the matchup and that someone is waiting, which
-- is what the invite page needs, and no prediction at all.
create or replace function public.h2h_view(p_token text, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.game_challenges%rowtype;
  v_slot text;
  v_locked boolean;
  v_status text;
  v_entries jsonb;
  v_selections jsonb;
begin
  select * into c from public.game_challenges where invite_token = p_token;
  if not found then
    return null;
  end if;
  v_slot := public.h2h_slot_of(c.id, p_secret);
  v_locked := c.locked_at is not null;
  -- Expiry is derived rather than trusted from the column, so a challenge that
  -- nobody has swept still reads as EXPIRED the moment it is one.
  v_status := c.status;
  if v_status = 'WAITING' and c.expires_at is not null and c.expires_at < now() then
    v_status := 'EXPIRED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slot', e.player_slot,
           'display_name', e.display_name,
           'submitted_at', e.submitted_at,
           'is_you', (e.player_slot = v_slot),
           'registered', (e.user_id is not null),
           'result', e.result,
           'score', e.score,
           'rating_before', e.rating_before,
           'rating_after', e.rating_after) order by e.player_slot), '[]'::jsonb)
    into v_entries
    from public.game_challenge_entries e
   where e.challenge_id = c.id;

  select coalesce(jsonb_object_agg(s.player_slot, s.selection), '{}'::jsonb)
    into v_selections
    from public.game_challenge_selections s
   where s.challenge_id = c.id
     -- the whole guarantee, in one predicate
     and (v_locked or s.player_slot = v_slot);

  return jsonb_build_object(
    'invite_token', c.invite_token,
    'mode', c.mode,
    'sport', c.sport,
    'canonical_game_id', c.canonical_game_id,
    'game_slug', c.game_slug,
    'home_team', c.home_team,
    'away_team', c.away_team,
    'kickoff', c.kickoff,
    'market_snapshot', c.market_snapshot,
    'status', v_status,
    'stored_status', c.status,
    'created_at', c.created_at,
    'expires_at', c.expires_at,
    'locked_at', c.locked_at,
    'settled_at', c.settled_at,
    'settlement', c.settlement,
    'group_id', c.group_id,
    'your_slot', v_slot,
    'entries', v_entries,
    'selections', v_selections);
end;
$$;

-- "Your challenges", for the home page's return loop. Signed-in players only:
-- an anonymous player's challenges live on the links they were sent, which is
-- the honest consequence of not having an account yet.
--
-- NO SELECTIONS ARE RETURNED HERE, not even the caller's own. This list exists
-- to say what is waiting on you; a screen that needs an answer asks h2h_view
-- for one challenge, where the reveal rule is applied.
create or replace function public.h2h_mine(p_limit integer default 20)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x.sort_at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'invite_token', c.invite_token,
             'mode', c.mode,
             'home_team', c.home_team,
             'away_team', c.away_team,
             'kickoff', c.kickoff,
             'status', case
               when c.status = 'WAITING' and c.expires_at is not null and c.expires_at < now()
                 then 'EXPIRED' else c.status end,
             'your_result', e.result,
             'opponent', (select o.display_name from public.game_challenge_entries o
                           where o.challenge_id = c.id and o.player_slot <> e.player_slot),
             'settled_at', c.settled_at) as x,
           coalesce(c.settled_at, c.locked_at, c.created_at) as sort_at
      from public.game_challenge_entries e
      join public.game_challenges c on c.id = e.challenge_id
     where auth.uid() is not null and e.user_id = auth.uid()
     order by coalesce(c.settled_at, c.locked_at, c.created_at) desc
     limit greatest(1, least(coalesce(p_limit, 20), 50))) x;
$$;

-- Attach an anonymous entry to an account, so signing up keeps the record that
-- earned the signup. Proof is possession of the bearer secret, nothing else.
create or replace function public.h2h_claim(p_token text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.game_challenges%rowtype;
  v_hash text := public.games_hash(p_secret);
  v_slot text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if v_hash is null then
    raise exception 'a bearer secret is required to claim an entry' using errcode = '22023';
  end if;
  select * into c from public.game_challenges where invite_token = p_token;
  if not found then
    raise exception 'no such challenge' using errcode = 'P0002';
  end if;
  select e.player_slot into v_slot from public.game_challenge_entries e
   where e.challenge_id = c.id and e.anon_hash = v_hash;
  if v_slot is null then
    raise exception 'no anonymous entry here matches that secret' using errcode = '42501';
  end if;
  if exists (select 1 from public.game_challenge_entries e
              where e.challenge_id = c.id and e.user_id = auth.uid()) then
    raise exception 'you are already in this challenge under your account' using errcode = '23505';
  end if;
  update public.game_challenge_entries
     set user_id = auth.uid(), anon_hash = null
   where challenge_id = c.id and player_slot = v_slot;
  return jsonb_build_object('claimed', true, 'slot', v_slot);
end;
$$;

commit;

-- ===========================================================================
-- SETTLEMENT AND RATINGS
--
-- Settlement is driven by a trusted caller holding the service role — the
-- workflow in .github/workflows/games-settle.yml, which reads final scores out
-- of the committed challenge artifact. A player's browser can never settle a
-- challenge, which is the whole point of putting scoring here.
-- ===========================================================================

begin;

-- Elo, in the ordinary form, with K fixed at 24 and every rating starting at
-- 1200. Deterministic and auditable: the same pair of ratings and the same
-- outcome always move the same way, and the arithmetic is simple enough to
-- check by hand. It is a GAME RATING — how well someone plays this game
-- against other people playing it — and is not a measure of betting skill.
create or replace function public.games_elo_delta(
  p_rating integer, p_opponent integer, p_outcome numeric, p_k integer default 24)
returns integer language sql immutable as $$
  select round(p_k * (p_outcome - 1.0 / (1.0 + power(10.0, (p_opponent - p_rating) / 400.0))))::integer;
$$;

create or replace function public.games_rating_of(p_user uuid, p_type text)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select rating from public.game_ratings
                    where user_id = p_user and game_type = p_type), 1200);
$$;

-- Settle one challenge. Idempotent by construction: a challenge that already
-- carries a settlement is returned unchanged rather than re-graded.
--
-- `p_outcome_a` is player A's result from the caller's canonical grading:
-- 'win', 'loss' or 'draw'. The scores that produced it ride along in
-- p_evidence and are frozen into the settlement so the result can always be
-- explained later.
create or replace function public.h2h_settle(
  p_challenge uuid, p_outcome_a text, p_evidence jsonb default '{}'::jsonb,
  p_score_a numeric default null, p_score_b numeric default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.game_challenges%rowtype;
  ea public.game_challenge_entries%rowtype;
  eb public.game_challenge_entries%rowtype;
  v_outcome_b text;
  v_ra integer; v_rb integer; v_da integer; v_db integer;
  v_num_a numeric;
begin
  select * into c from public.game_challenges where id = p_challenge for update;
  if not found then
    raise exception 'no such challenge' using errcode = 'P0002';
  end if;
  -- IDEMPOTENT. Replaying a settlement request changes nothing.
  if c.settled_at is not null then
    return jsonb_build_object('id', c.id, 'status', c.status, 'already_settled', true);
  end if;
  if c.locked_at is null then
    raise exception 'cannot settle a challenge that never locked' using errcode = '22023';
  end if;
  if p_outcome_a not in ('win', 'loss', 'draw') then
    raise exception 'unknown outcome %', p_outcome_a using errcode = '22023';
  end if;

  select * into ea from public.game_challenge_entries where challenge_id = c.id and player_slot = 'a';
  select * into eb from public.game_challenge_entries where challenge_id = c.id and player_slot = 'b';

  v_outcome_b := case p_outcome_a when 'win' then 'loss' when 'loss' then 'win' else 'draw' end;
  v_num_a := case p_outcome_a when 'win' then 1 when 'loss' then 0 else 0.5 end;

  -- Ratings move only between two ACCOUNTS. An anonymous player has nothing to
  -- rate, and rating a signed-in player against a ghost would let anyone farm a
  -- number by opening links in a private window.
  if ea.user_id is not null and eb.user_id is not null then
    v_ra := public.games_rating_of(ea.user_id, 'h2h');
    v_rb := public.games_rating_of(eb.user_id, 'h2h');
    v_da := public.games_elo_delta(v_ra, v_rb, v_num_a);
    v_db := public.games_elo_delta(v_rb, v_ra, 1 - v_num_a);

    insert into public.game_ratings (user_id, game_type, rating, played, updated_at)
    values (ea.user_id, 'h2h', v_ra + v_da, 1, now())
    on conflict (user_id, game_type) do update
      set rating = public.game_ratings.rating + v_da,
          played = public.game_ratings.played + 1, updated_at = now();
    insert into public.game_ratings (user_id, game_type, rating, played, updated_at)
    values (eb.user_id, 'h2h', v_rb + v_db, 1, now())
    on conflict (user_id, game_type) do update
      set rating = public.game_ratings.rating + v_db,
          played = public.game_ratings.played + 1, updated_at = now();

    insert into public.game_rating_history (user_id, game_type, rating, delta, reason)
    values (ea.user_id, 'h2h', v_ra + v_da, v_da, 'h2h ' || c.id),
           (eb.user_id, 'h2h', v_rb + v_db, v_db, 'h2h ' || c.id);
  end if;

  update public.game_challenge_entries
     set result = p_outcome_a, score = p_score_a,
         rating_before = v_ra, rating_after = case when v_ra is null then null else v_ra + v_da end
   where challenge_id = c.id and player_slot = 'a';
  update public.game_challenge_entries
     set result = v_outcome_b, score = p_score_b,
         rating_before = v_rb, rating_after = case when v_rb is null then null else v_rb + v_db end
   where challenge_id = c.id and player_slot = 'b';

  update public.game_challenges
     set status = case when p_outcome_a = 'draw' then 'DRAW' else 'FINAL' end,
         settled_at = now(),
         settlement = jsonb_build_object(
           'outcome_a', p_outcome_a, 'outcome_b', v_outcome_b,
           'evidence', coalesce(p_evidence, '{}'::jsonb),
           'market_snapshot', c.market_snapshot,
           'settled_at', now())
   where id = c.id;

  -- the feed entry, if this challenge belongs to a group
  if c.group_id is not null then
    insert into public.game_activity (group_id, kind, actor_name, subject_name, detail)
    values (c.group_id, 'h2h_settled',
            case p_outcome_a when 'win' then ea.display_name when 'loss' then eb.display_name else null end,
            case p_outcome_a when 'win' then eb.display_name when 'loss' then ea.display_name else null end,
            jsonb_build_object('game', c.away_team || ' vs ' || c.home_team,
                               'draw', (p_outcome_a = 'draw'), 'challenge', c.invite_token));
  end if;

  return jsonb_build_object('id', c.id, 'status',
    case when p_outcome_a = 'draw' then 'DRAW' else 'FINAL' end, 'already_settled', false);
end;
$$;

-- Persist expiry for challenges nobody answered. Called by the settlement
-- workflow, never by a page. Purely housekeeping: h2h_view already reports an
-- unswept challenge correctly, so this only keeps the stored column honest for
-- anything that queries the table directly.
create or replace function public.h2h_sweep_expired()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  with swept as (
    update public.game_challenges
       set status = 'EXPIRED'
     where status = 'WAITING' and expires_at is not null and expires_at < now()
    returning 1)
  select count(*) into n from swept;
  return n;
end;
$$;

-- A visible correction. The old settlement is preserved in the log; nothing is
-- ever quietly replaced.
create or replace function public.h2h_correct(
  p_challenge uuid, p_reason text, p_outcome_a text, p_evidence jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.game_challenges%rowtype;
begin
  select * into c from public.game_challenges where id = p_challenge for update;
  if not found then raise exception 'no such challenge' using errcode = 'P0002'; end if;
  if c.settled_at is null then
    raise exception 'nothing to correct: this challenge is not settled' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a correction must state its reason' using errcode = '22023';
  end if;
  insert into public.game_challenge_corrections (challenge_id, reason, previous, replacement)
  values (c.id, p_reason, c.settlement,
          jsonb_build_object('outcome_a', p_outcome_a, 'evidence', p_evidence));
  update public.game_challenges set settled_at = null, settlement = null, status = 'LOCKED'
   where id = c.id;
  update public.game_challenge_entries set result = null, score = null
   where challenge_id = c.id;
  return public.h2h_settle(c.id, p_outcome_a, p_evidence);
end;
$$;

commit;

-- ===========================================================================
-- GROUPS
-- ===========================================================================

begin;

create or replace function public.group_create(
  p_name text, p_emoji text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_token text; v_slug text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if auth.uid() is null then
    raise exception 'sign in to create a group' using errcode = '28000';
  end if;
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'a group needs a name' using errcode = '22023';
  end if;
  v_slug := left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 40);
  v_slug := btrim(v_slug, '-');
  if v_slug = '' then v_slug := 'group'; end if;

  insert into public.game_groups (slug, name, emoji, owner_user_id)
  values (v_slug, left(v_name, 40), left(nullif(btrim(coalesce(p_emoji, '')), ''), 8), auth.uid())
  returning id, invite_token into v_id, v_token;

  insert into public.game_group_members (group_id, user_id, display_name, role)
  values (v_id, auth.uid(),
          left(coalesce(nullif(btrim(coalesce(
            (select raw_user_meta_data->>'display_name' from auth.users where id = auth.uid()),
            split_part((select email from auth.users where id = auth.uid()), '@', 1))), ''), 'Owner'), 24),
          'owner');

  return jsonb_build_object('id', v_id, 'invite_token', v_token, 'slug', v_slug);
end;
$$;

-- What a stranger holding an invite link may see BEFORE joining: enough to
-- understand what they are being invited to, and nothing about who is in it.
create or replace function public.group_preview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.game_groups%rowtype; v_n integer;
begin
  select * into g from public.game_groups where invite_token = p_token;
  if not found then return null; end if;
  select count(*) into v_n from public.game_group_members where group_id = g.id;
  return jsonb_build_object(
    'name', g.name, 'emoji', g.emoji, 'slug', g.slug,
    'members', v_n, 'full', v_n >= g.member_cap,
    'you_are_member', exists (select 1 from public.game_group_members m
                               where m.group_id = g.id and m.user_id = auth.uid()));
end;
$$;

create or replace function public.group_join(p_token text, p_display_name text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.game_groups%rowtype; v_n integer; v_name text;
begin
  if auth.uid() is null then
    raise exception 'sign in to join a group' using errcode = '28000';
  end if;
  select * into g from public.game_groups where invite_token = p_token for update;
  if not found then raise exception 'no such group' using errcode = 'P0002'; end if;
  if exists (select 1 from public.game_group_members m
              where m.group_id = g.id and m.user_id = auth.uid()) then
    return jsonb_build_object('id', g.id, 'slug', g.slug, 'already_member', true);
  end if;
  select count(*) into v_n from public.game_group_members where group_id = g.id;
  if v_n >= g.member_cap then
    raise exception 'this group is full' using errcode = '22023';
  end if;
  v_name := left(coalesce(nullif(btrim(coalesce(p_display_name, '')), ''),
    nullif(btrim(coalesce(
      (select raw_user_meta_data->>'display_name' from auth.users where id = auth.uid()),
      split_part((select email from auth.users where id = auth.uid()), '@', 1))), ''),
    'Player'), 24);
  insert into public.game_group_members (group_id, user_id, display_name)
  values (g.id, auth.uid(), v_name);
  insert into public.game_activity (group_id, kind, actor_name)
  values (g.id, 'group_joined', v_name);
  return jsonb_build_object('id', g.id, 'slug', g.slug, 'already_member', false);
end;
$$;

-- The dashboard, for members only. Standings are kept SEPARATE per game rather
-- than fused into one opaque number: three clear tables beat one nobody can
-- explain. H2H standings are wins/losses/draws inside this group.
create or replace function public.group_dashboard(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.game_groups%rowtype; v_h2h jsonb; v_members jsonb; v_feed jsonb;
begin
  select * into g from public.game_groups where invite_token = p_token;
  if not found then return null; end if;
  if not exists (select 1 from public.game_group_members m
                  where m.group_id = g.id and m.user_id = auth.uid()) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'display_name', m.display_name, 'role', m.role, 'joined_at', m.joined_at,
           'is_you', m.user_id = auth.uid(),
           'rating', public.games_rating_of(m.user_id, 'h2h')) order by m.joined_at), '[]'::jsonb)
    into v_members from public.game_group_members m where m.group_id = g.id;

  -- Standings over the challenges played INSIDE this group.
  --
  -- The restriction to this group belongs in the join, not in a WHERE: filtering
  -- afterwards drops a member who has played head-to-head somewhere else but not
  -- here, and they vanish from their own group's table. Every member appears,
  -- with zeros until they have played.
  --
  -- Ordering is on the numeric column, not on the assembled json — '9' sorts
  -- after '10' as text, which is a standings table that lies.
  select coalesce(jsonb_agg(jsonb_build_object(
           'display_name', s.display_name,
           'is_you', s.is_you,
           'wins', s.wins, 'losses', s.losses, 'draws', s.draws)
           order by s.wins desc, s.losses asc, s.display_name asc), '[]'::jsonb)
    into v_h2h
    from (
      select m.display_name,
             (m.user_id = auth.uid()) as is_you,
             count(*) filter (where ge.result = 'win')  as wins,
             count(*) filter (where ge.result = 'loss') as losses,
             count(*) filter (where ge.result = 'draw') as draws
        from public.game_group_members m
        left join (
          select e.user_id, e.result
            from public.game_challenge_entries e
            join public.game_challenges c on c.id = e.challenge_id
           where c.group_id = g.id and e.user_id is not null
        ) ge on ge.user_id = m.user_id
       where m.group_id = g.id
       group by m.user_id, m.display_name) s;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', a.kind, 'actor', a.actor_name, 'subject', a.subject_name,
           'detail', a.detail, 'at', a.created_at) order by a.created_at desc), '[]'::jsonb)
    into v_feed from (
      select * from public.game_activity where group_id = g.id
      order by created_at desc limit 20) a;

  return jsonb_build_object(
    'name', g.name, 'emoji', g.emoji, 'slug', g.slug, 'invite_token', g.invite_token,
    'owner', g.owner_user_id = auth.uid(),
    'members', v_members, 'h2h_standings', v_h2h, 'activity', v_feed);
end;
$$;

commit;

-- ===========================================================================
-- GRANTS
--
-- Clients call the functions; they do not touch the tables. `anon` gets the
-- ones an unsigned-in visitor genuinely needs — creating and answering a
-- challenge, and viewing one — because playing before signing up IS the
-- product. Everything that needs an identity checks auth.uid() itself.
--
-- h2h_settle and h2h_correct are granted to NO client role. Only the service
-- role reaches them.
-- ===========================================================================

begin;

revoke all on function public.h2h_settle(uuid, text, jsonb, numeric, numeric) from public, anon, authenticated;
revoke all on function public.h2h_correct(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.h2h_sweep_expired() from public, anon, authenticated;

grant execute on function public.h2h_create(text, text, text, text, text, text, timestamptz, jsonb, jsonb, text, text, uuid) to anon, authenticated;
grant execute on function public.h2h_submit(text, jsonb, text, text) to anon, authenticated;
grant execute on function public.h2h_view(text, text) to anon, authenticated;
grant execute on function public.h2h_claim(text, text) to authenticated;
grant execute on function public.h2h_mine(integer) to authenticated;
grant execute on function public.group_preview(text) to anon, authenticated;
grant execute on function public.group_create(text, text) to authenticated;
grant execute on function public.group_join(text, text) to authenticated;
grant execute on function public.group_dashboard(text) to authenticated;
grant execute on function public.games_rating_of(uuid, text) to anon, authenticated;
grant execute on function public.games_is_member(uuid) to anon, authenticated;

commit;
