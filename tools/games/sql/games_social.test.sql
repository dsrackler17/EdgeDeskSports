-- ===========================================================================
-- EDGEDESK GAMES — the social layer, run against a real PostgreSQL.
--
-- These are not assertions about what the SQL says. The schema and its
-- security-definer functions are applied to a live database and then attacked:
-- the tests take the roles a real client gets (anon, authenticated), impersonate
-- each player, and try to read the thing they must not be able to read.
--
-- The load-bearing test is HEAD-TO-HEAD ANSWER PRIVACY. Everything else in the
-- social layer is a nicety; if a second player can see the first player's pick
-- before locking, the game is worthless and shipping it would be dishonest.
-- ===========================================================================
\set ON_ERROR_STOP on
-- notice level ON PURPOSE: every passing assertion is a NOTICE, and the Node
-- harness counts them to prove the suite actually ran rather than exiting
-- early with nothing asserted.
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then
    raise notice 'ok   %', p_name;
  else
    raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, '');
  end if;
end;
$$;

-- become a signed-in user / an anonymous visitor
create or replace function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_id::text, false);
  execute 'set local role authenticated';
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set local role anon';
end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end; $$;

do $test$
declare
  DAVIS   constant uuid := '11111111-1111-1111-1111-111111111111';
  ROBERT  constant uuid := '22222222-2222-2222-2222-222222222222';
  JAKE    constant uuid := '33333333-3333-3333-3333-333333333333';
  SEC_A   constant text := 'anon-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  SEC_B   constant text := 'anon-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  SEC_X   constant text := 'anon-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  v jsonb; tok text; cid uuid; gtok text; n integer; caught text;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (DAVIS,  'davis@example.com',  '{"display_name":"Davis"}'),
    (ROBERT, 'robert@example.com', '{"display_name":"Robert"}'),
    (JAKE,   'jake@example.com',   '{"display_name":"Jake"}')
  on conflict (id) do nothing;

-- ═══ 1. ANSWER PRIVACY ════════════════════════════════════════════════════

  -- Davis, ANONYMOUS, creates a spread challenge and lodges his pick.
  perform pg_temp.as_anon();
  v := public.h2h_create('spread', 'americanfootball_ncaaf', 'g-401', 'baylor-auburn',
        'Auburn', 'Baylor', now() + interval '2 days',
        '{"spread":-8.5,"book":"consensus"}'::jsonb,
        '{"side":"home"}'::jsonb, 'Davis', SEC_A);
  tok := v->>'invite_token';
  cid := (v->>'id')::uuid;
  perform pg_temp.ok('a challenge is created with its author''s pick', tok is not null);
  perform pg_temp.ok('and it starts WAITING', v->>'status' = 'WAITING');
  perform pg_temp.ok('the invite token is long enough not to be guessed', length(tok) >= 20);

  -- Davis, holding his secret, sees his OWN pick.
  v := public.h2h_view(tok, SEC_A);
  perform pg_temp.ok('the author sees their own pick', v->'selections'->'a' is not null);
  perform pg_temp.ok('and the challenge is still waiting', v->>'status' = 'WAITING');
  perform pg_temp.ok('and knows which slot they are', v->>'your_slot' = 'a');

  -- A STRANGER with the link sees the matchup and NO pick at all.
  v := public.h2h_view(tok, null);
  perform pg_temp.ok('a stranger can see the matchup', v->>'home_team' = 'Auburn');
  perform pg_temp.ok('a stranger sees NO prediction', v->'selections' = '{}'::jsonb,
    'leaked: ' || (v->'selections')::text);
  perform pg_temp.ok('a stranger has no slot', v->>'your_slot' is null);
  perform pg_temp.ok('the entry list never carries a prediction',
    not ((v->'entries')::text ilike '%selection%')
    and not ((v->'entries')::text ilike '%"side"%'),
    (v->'entries')::text);

  -- A stranger GUESSING a secret gets nothing.
  v := public.h2h_view(tok, SEC_X);
  perform pg_temp.ok('a wrong secret reveals nothing', v->'selections' = '{}'::jsonb);
  perform pg_temp.ok('a wrong secret grants no slot', v->>'your_slot' is null);

  -- A SIGNED-IN stranger cannot see it either.
  perform pg_temp.as_user(JAKE);
  v := public.h2h_view(tok, null);
  perform pg_temp.ok('a signed-in stranger sees no prediction', v->'selections' = '{}'::jsonb);

  -- THE DIRECT ROUTE IS CLOSED. No client role may read the secret table.
  perform pg_temp.as_user(JAKE);
  begin
    select count(*) into n from public.game_challenge_selections;
    perform pg_temp.ok('authenticated cannot read the selections table', n = 0,
      'read ' || n || ' secret rows');
  exception when insufficient_privilege then
    perform pg_temp.ok('authenticated cannot read the selections table', true);
  end;
  perform pg_temp.as_anon();
  begin
    select count(*) into n from public.game_challenge_selections;
    perform pg_temp.ok('anon cannot read the selections table', n = 0,
      'read ' || n || ' secret rows');
  exception when insufficient_privilege then
    perform pg_temp.ok('anon cannot read the selections table', true);
  end;

  -- Nor write one.
  begin
    insert into public.game_challenge_selections (challenge_id, player_slot, selection)
    values (cid, 'b', '{"side":"away"}'::jsonb);
    perform pg_temp.ok('anon cannot forge a selection', false, 'the insert succeeded');
  exception when insufficient_privilege or others then
    perform pg_temp.ok('anon cannot forge a selection', true);
  end;

  -- Nor tamper with an entry's result.
  begin
    update public.game_challenge_entries set result = 'win' where challenge_id = cid;
    perform pg_temp.ok('anon cannot award itself a win', false, 'the update succeeded');
  exception when insufficient_privilege or others then
    perform pg_temp.ok('anon cannot award itself a win', true);
  end;

-- ═══ 2. SUBMISSION ════════════════════════════════════════════════════════

  -- Robert, anonymous, answers. Only now does anything unlock.
  perform pg_temp.as_anon();
  v := public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Robert', SEC_B);
  perform pg_temp.ok('the opponent''s submission locks the challenge', v->>'status' = 'LOCKED');

  v := public.h2h_view(tok, SEC_B);
  perform pg_temp.ok('now Robert sees Davis''s pick', v->'selections'->'a' is not null);
  perform pg_temp.ok('and his own', v->'selections'->'b' is not null);
  perform pg_temp.ok('Davis picked the home side', v->'selections'->'a'->>'side' = 'home');
  v := public.h2h_view(tok, SEC_A);
  perform pg_temp.ok('and Davis sees Robert''s', v->'selections'->'b'->>'side' = 'away');
  v := public.h2h_view(tok, null);
  perform pg_temp.ok('a locked challenge is readable by anyone with the link',
    v->'selections'->'a' is not null,
    'once both have committed there is nothing left to protect');

  -- Double submission is refused.
  caught := null;
  begin
    perform public.h2h_submit(tok, '{"side":"home"}'::jsonb, 'Robert again', SEC_B);
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('a player cannot submit twice', caught is not null, 'no error raised');

  -- A third player is refused.
  caught := null;
  begin
    perform public.h2h_submit(tok, '{"side":"home"}'::jsonb, 'Jake', SEC_X);
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('a third player cannot join a head-to-head', caught is not null);

  -- And an answer cannot be changed after locking.
  perform pg_temp.as_owner();
  select selection->>'side' into caught from public.game_challenge_selections
   where challenge_id = cid and player_slot = 'a';
  perform pg_temp.ok('the locked answer is unchanged', caught = 'home');

-- ═══ 3. SETTLEMENT ════════════════════════════════════════════════════════

  perform pg_temp.as_owner();
  v := public.h2h_settle(cid, 'win', '{"home_score":31,"away_score":20}'::jsonb);
  perform pg_temp.ok('a locked challenge settles', v->>'status' = 'FINAL');
  perform pg_temp.ok('and is not reported as a replay', (v->>'already_settled')::boolean = false);

  -- IDEMPOTENT: replaying the request changes nothing.
  v := public.h2h_settle(cid, 'loss', '{"home_score":0,"away_score":99}'::jsonb);
  perform pg_temp.ok('replaying settlement is refused as already settled',
    (v->>'already_settled')::boolean = true);
  select result into caught from public.game_challenge_entries
   where challenge_id = cid and player_slot = 'a';
  perform pg_temp.ok('and the original result stands', caught = 'win');

  v := public.h2h_view(tok, SEC_A);
  perform pg_temp.ok('the settlement is frozen onto the challenge',
    v->'settlement'->>'outcome_a' = 'win');
  perform pg_temp.ok('with the evidence that produced it',
    v->'settlement'->'evidence'->>'home_score' = '31');
  perform pg_temp.ok('and the market snapshot it was graded against',
    v->'settlement'->'market_snapshot'->>'spread' = '-8.5');

-- ═══ 4. DRAWS, AND RATINGS BETWEEN ACCOUNTS ═══════════════════════════════

  perform pg_temp.as_user(DAVIS);
  v := public.h2h_create('spread', 'americanfootball_ncaaf', 'g-402', 'a-b',
        'Home', 'Away', now() + interval '2 days',
        '{"spread":-3.0}'::jsonb, '{"side":"home"}'::jsonb, 'Davis');
  tok := v->>'invite_token'; cid := (v->>'id')::uuid;
  perform pg_temp.as_user(ROBERT);
  perform public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Robert');

  perform pg_temp.as_owner();
  perform pg_temp.ok('both players start at the same rating',
    public.games_rating_of(DAVIS, 'h2h') = 1200 and public.games_rating_of(ROBERT, 'h2h') = 1200);
  v := public.h2h_settle(cid, 'draw', '{"push":true}'::jsonb);
  perform pg_temp.ok('a push is a DRAW, not a win for anyone', v->>'status' = 'DRAW');
  select count(*) into n from public.game_challenge_entries
   where challenge_id = cid and result = 'draw';
  perform pg_temp.ok('and both entries record the draw', n = 2);
  perform pg_temp.ok('an even draw moves neither rating',
    public.games_rating_of(DAVIS, 'h2h') = 1200 and public.games_rating_of(ROBERT, 'h2h') = 1200);

  -- a decisive result between two accounts moves both, symmetrically
  perform pg_temp.as_user(DAVIS);
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'g-403', 'c-d',
        'Home', 'Away', now() + interval '2 days', '{}'::jsonb,
        '{"side":"home"}'::jsonb, 'Davis');
  tok := v->>'invite_token'; cid := (v->>'id')::uuid;
  perform pg_temp.as_user(ROBERT);
  perform public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Robert');
  perform pg_temp.as_owner();
  perform public.h2h_settle(cid, 'win', '{}'::jsonb);
  perform pg_temp.ok('the winner gains 12 from an even start',
    public.games_rating_of(DAVIS, 'h2h') = 1212,
    'got ' || public.games_rating_of(DAVIS, 'h2h'));
  perform pg_temp.ok('the loser loses the same 12',
    public.games_rating_of(ROBERT, 'h2h') = 1188,
    'got ' || public.games_rating_of(ROBERT, 'h2h'));
  select count(*) into n from public.game_rating_history where reason like 'h2h %';
  perform pg_temp.ok('and the rating change is kept in history', n >= 2);

  -- an anonymous opponent cannot be used to farm a rating
  perform pg_temp.as_user(JAKE);
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'g-404', 'e-f',
        'Home', 'Away', now() + interval '2 days', '{}'::jsonb, '{"side":"home"}'::jsonb, 'Jake');
  tok := v->>'invite_token'; cid := (v->>'id')::uuid;
  perform pg_temp.as_anon();
  perform public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Ghost', SEC_X);
  perform pg_temp.as_owner();
  perform public.h2h_settle(cid, 'win', '{}'::jsonb);
  perform pg_temp.ok('beating an anonymous opponent does not move a rating',
    public.games_rating_of(JAKE, 'h2h') = 1200,
    'got ' || public.games_rating_of(JAKE, 'h2h'));

-- ═══ 5. CORRECTIONS ARE VISIBLE ═══════════════════════════════════════════

  perform pg_temp.as_owner();
  v := public.h2h_correct(cid, 'the feed reported the wrong final score', 'loss', '{"fixed":true}'::jsonb);
  perform pg_temp.ok('a correction re-settles the challenge', v->>'status' = 'FINAL');
  select count(*) into n from public.game_challenge_corrections where challenge_id = cid;
  perform pg_temp.ok('and leaves a visible record of what changed', n = 1);
  select result into caught from public.game_challenge_entries where challenge_id = cid and player_slot = 'a';
  perform pg_temp.ok('with the corrected result in place', caught = 'loss');

-- ═══ 6. EXPIRY AND BAD INPUT ══════════════════════════════════════════════

  perform pg_temp.as_anon();
  caught := null;
  begin
    perform public.h2h_create('roulette', 'americanfootball_ncaaf', 'g-9', 's',
      'H', 'A', now(), '{}'::jsonb, '{"side":"home"}'::jsonb, 'X', SEC_X);
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('an unknown mode is refused', caught is not null);

  caught := null;
  begin
    perform public.h2h_create('spread', 'americanfootball_ncaaf', 'g-9', 's',
      'H', 'A', now(), '{}'::jsonb, '{"side":"home"}'::jsonb, 'X', SEC_X);
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('a spread challenge without a snapshotted line is refused', caught is not null);

  caught := null;
  begin
    perform public.h2h_create('winner', 'americanfootball_ncaaf', 'g-9', 's',
      'H', 'A', now(), '{}'::jsonb, '{"side":"home"}'::jsonb, 'X', 'tooshort');
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('a weak bearer secret is refused', caught is not null);

  perform pg_temp.ok('an unknown invite token simply does not resolve',
    public.h2h_view('nosuchtokenatall', null) is null);

  -- an expired challenge cannot be answered
  perform pg_temp.as_user(DAVIS);
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'g-405', 'g-h',
        'Home', 'Away', now() + interval '1 day', '{}'::jsonb, '{"side":"home"}'::jsonb, 'Davis');
  tok := v->>'invite_token';
  perform pg_temp.as_owner();
  update public.game_challenges set expires_at = now() - interval '1 hour' where invite_token = tok;
  perform pg_temp.as_anon();
  caught := null;
  begin
    perform public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Late', SEC_X);
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('an expired challenge cannot be answered', caught is not null);
  -- Derived, so it reads correctly even before anything sweeps it. The first
  -- draft wrote EXPIRED inside the same function that raised, and the raise
  -- rolled the write back — the challenge stayed WAITING forever.
  v := public.h2h_view(tok, null);
  perform pg_temp.ok('and it reads as EXPIRED immediately', v->>'status' = 'EXPIRED',
    'got ' || (v->>'status'));
  perform pg_temp.as_owner();
  select status into caught from public.game_challenges where invite_token = tok;
  perform pg_temp.ok('even though nothing has swept it yet', caught = 'WAITING');
  perform pg_temp.ok('and the sweeper persists it', public.h2h_sweep_expired() >= 1);
  select status into caught from public.game_challenges where invite_token = tok;
  perform pg_temp.ok('after which the stored column agrees', caught = 'EXPIRED');

-- ═══ 7. CLAIMING AN ANONYMOUS RECORD ══════════════════════════════════════

  perform pg_temp.as_anon();
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'g-406', 'i-j',
        'Home', 'Away', now() + interval '2 days', '{}'::jsonb, '{"side":"home"}'::jsonb, 'Newbie', SEC_X);
  tok := v->>'invite_token';
  perform pg_temp.as_user(JAKE);
  v := public.h2h_claim(tok, SEC_X);
  perform pg_temp.ok('signing up claims the anonymous entry that earned it',
    (v->>'claimed')::boolean = true);
  perform pg_temp.as_owner();
  select count(*) into n from public.game_challenge_entries e
    join public.game_challenges c on c.id = e.challenge_id
   where c.invite_token = tok and e.user_id = JAKE and e.anon_hash is null;
  perform pg_temp.ok('the claimed entry now belongs to the account, not the secret', n = 1);

  -- the secret no longer opens it, because it is no longer an anonymous entry
  perform pg_temp.as_anon();
  v := public.h2h_view(tok, SEC_X);
  perform pg_temp.ok('and the spent secret grants nothing', v->>'your_slot' is null);

  -- claiming with the wrong secret is refused
  perform pg_temp.as_user(ROBERT);
  caught := null;
  begin perform public.h2h_claim(tok, SEC_B); exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('a claim with the wrong secret is refused', caught is not null);
end;
$test$;

-- ═══ 7b. "YOUR CHALLENGES" ════════════════════════════════════════════════
do $t1b$
declare
  DAVIS constant uuid := '11111111-1111-1111-1111-111111111111';
  v jsonb;
begin
  perform pg_temp.as_user(DAVIS);
  v := public.h2h_mine();
  perform pg_temp.ok('a signed-in player can list their own challenges',
    jsonb_array_length(v) >= 2, 'got ' || jsonb_array_length(v)::text);
  -- The list must never carry a prediction, not even the caller's own. Checked
  -- as an exact key set rather than by searching the text: "spread" appears
  -- legitimately as a MODE, and a substring test that trips on that is a test
  -- that will be deleted the first time it cries wolf.
  perform pg_temp.ok('the list exposes exactly the intended fields, and no selection',
    (select bool_and(keys = array['away_team','home_team','invite_token','kickoff','mode',
                                  'opponent','settled_at','status','your_result']::text[])
       from (select array(select jsonb_object_keys(e) order by 1) as keys
               from jsonb_array_elements(v) e) k),
    (select string_agg(k::text, ' | ') from (
       select array(select jsonb_object_keys(e) order by 1) as k
         from jsonb_array_elements(v) e) z));
  perform pg_temp.ok('it names the opponent', v::text ilike '%Robert%');
  perform pg_temp.ok('and reports a status', (v->0->>'status') is not null);

  -- an anonymous visitor gets nothing rather than everything
  perform pg_temp.as_anon();
  perform pg_temp.ok('an anonymous visitor lists no challenges',
    jsonb_array_length(public.h2h_mine()) = 0);
end;
$t1b$;

-- ═══ 8. GROUPS ════════════════════════════════════════════════════════════
do $t3$
declare
  DAVIS  constant uuid := '11111111-1111-1111-1111-111111111111';
  ROBERT constant uuid := '22222222-2222-2222-2222-222222222222';
  JAKE   constant uuid := '33333333-3333-3333-3333-333333333333';
  v jsonb; gtok text; gid uuid; caught text; n integer;
begin
  perform pg_temp.as_user(DAVIS);
  v := public.group_create('The Boys CFB League', '🏈');
  gtok := v->>'invite_token';
  -- captured here, from the creator's own return value. Looking it up later as
  -- a non-member returns NULL, because the RLS policy hides the row — which is
  -- correct, and which silently defeated this test's first version.
  gid := (v->>'id')::uuid;
  perform pg_temp.ok('a group is created', gtok is not null);
  perform pg_temp.ok('with a readable slug', v->>'slug' = 'the-boys-cfb-league');

  -- a stranger sees the preview and nothing else
  perform pg_temp.as_user(ROBERT);
  v := public.group_preview(gtok);
  perform pg_temp.ok('an invitee can see what they are joining', v->>'name' = 'The Boys CFB League');
  perform pg_temp.ok('and how many are in it', (v->>'members')::int = 1);
  perform pg_temp.ok('but the preview names no member', not (v::text ilike '%Davis%'), v::text);
  perform pg_temp.ok('and knows they are not in it yet', (v->>'you_are_member')::boolean = false);

  -- and cannot open the dashboard
  caught := null;
  begin perform public.group_dashboard(gtok); exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('a non-member cannot open the group dashboard', caught is not null);

  -- nor read the tables directly. (A membership policy that asks the
  -- membership table whether you are a member recurses forever; this is the
  -- test that caught it.)
  select count(*) into n from public.game_group_members;
  perform pg_temp.ok('a non-member reads no membership rows', n = 0, 'read ' || n);
  select count(*) into n from public.game_groups;
  perform pg_temp.ok('a non-member reads no group rows', n = 0, 'read ' || n);
  select count(*) into n from public.game_activity;
  perform pg_temp.ok('a non-member reads no activity rows', n = 0, 'read ' || n);

  v := public.group_join(gtok, 'Robert');
  perform pg_temp.ok('joining works', (v->>'already_member')::boolean = false);
  v := public.group_join(gtok, 'Robert');
  perform pg_temp.ok('joining twice is idempotent, not an error',
    (v->>'already_member')::boolean = true);
  perform pg_temp.as_owner();
  select count(*) into n from public.game_group_members where user_id = ROBERT;
  perform pg_temp.ok('and creates no duplicate membership', n = 1);

  perform pg_temp.as_user(ROBERT);
  v := public.group_dashboard(gtok);
  perform pg_temp.ok('a member can open the dashboard', v->>'name' = 'The Boys CFB League');
  perform pg_temp.ok('and sees the members', jsonb_array_length(v->'members') = 2);
  perform pg_temp.ok('the feed records the join',
    (v->'activity')::text ilike '%group_joined%');
  perform pg_temp.ok('a member is not the owner unless they are',
    (v->>'owner')::boolean = false);
  -- Every member appears with zeros. The first draft restricted to this
  -- group's challenges in a WHERE clause, which dropped any member who had
  -- played head-to-head ELSEWHERE — they disappeared from their own group's
  -- standings entirely.
  perform pg_temp.ok('every member appears in the standings',
    jsonb_array_length(v->'h2h_standings') = 2,
    'got ' || jsonb_array_length(v->'h2h_standings')::text || ': ' || (v->'h2h_standings')::text);
  perform pg_temp.ok('standings start at zero rather than invented',
    (v->'h2h_standings'->0->>'wins')::int = 0);
  perform pg_temp.ok('a member who has played outside the group still appears here',
    (v->'h2h_standings')::text ilike '%Davis%');
  perform pg_temp.ok('and their outside results are not counted in this group',
    (select sum((x->>'wins')::int) from jsonb_array_elements(v->'h2h_standings') x) = 0);

  -- an unknown token is simply nothing
  perform pg_temp.ok('an unknown group token does not resolve',
    public.group_preview('nosuchgrouptoken') is null);

  -- a group challenge requires membership
  perform pg_temp.as_user(JAKE);
  perform pg_temp.ok('a non-member cannot even resolve the group id',
    (select count(*) from public.game_groups where id = gid) = 0);
  caught := null;
  begin
    perform public.h2h_create('winner', 'americanfootball_ncaaf', 'g-500', 's',
      'H', 'A', now() + interval '1 day', '{}'::jsonb, '{"side":"home"}'::jsonb, 'Jake', null, gid);
  exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('and cannot post a challenge into it even knowing the id',
    caught is not null, 'the create succeeded');

  -- a member can
  perform pg_temp.as_user(ROBERT);
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'g-501', 's',
        'H', 'A', now() + interval '1 day', '{}'::jsonb, '{"side":"home"}'::jsonb, 'Robert', null, gid);
  perform pg_temp.ok('a member can post a challenge into their group',
    v->>'invite_token' is not null);

  -- an anonymous visitor cannot create a group at all
  perform pg_temp.as_anon();
  caught := null;
  begin perform public.group_create('Ghost League'); exception when others then caught := SQLERRM; end;
  perform pg_temp.ok('an anonymous visitor cannot create a group', caught is not null);
end;
$t3$;

-- ═══ 9. THE ELO ITSELF ════════════════════════════════════════════════════
do $t4$
begin
  perform pg_temp.ok('an even win is +12', public.games_elo_delta(1200, 1200, 1) = 12);
  perform pg_temp.ok('an even loss is -12', public.games_elo_delta(1200, 1200, 0) = -12);
  perform pg_temp.ok('an even draw is 0', public.games_elo_delta(1200, 1200, 0.5) = 0);
  perform pg_temp.ok('beating a much stronger player is worth more',
    public.games_elo_delta(1000, 1600, 1) > public.games_elo_delta(1600, 1000, 1));
  perform pg_temp.ok('losing to a much weaker player costs more',
    public.games_elo_delta(1600, 1000, 0) < public.games_elo_delta(1000, 1600, 0));
  perform pg_temp.ok('the exchange is zero-sum at equal ratings',
    public.games_elo_delta(1200, 1200, 1) + public.games_elo_delta(1200, 1200, 0) = 0);
  perform pg_temp.ok('a draw against a stronger player is a gain',
    public.games_elo_delta(1000, 1400, 0.5) > 0);
  perform pg_temp.ok('the rating is deterministic',
    public.games_elo_delta(1337, 1201, 1) = public.games_elo_delta(1337, 1201, 1));
end;
$t4$;

-- ═══ 10. TOKENS ═══════════════════════════════════════════════════════════
do $t5$
declare a text; b text; n integer;
begin
  a := public.games_token(); b := public.games_token();
  perform pg_temp.ok('tokens are unique between calls', a <> b);
  perform pg_temp.ok('tokens are URL-safe', a ~ '^[0-9a-z]+$');
  perform pg_temp.ok('tokens exclude ambiguous characters', a !~ '[01lo]');
  select count(distinct public.games_token()) into n from generate_series(1, 500);
  perform pg_temp.ok('500 tokens collide zero times', n = 500, 'got ' || n);
  perform pg_temp.ok('a short secret is never hashed', public.games_hash('short') is null);
  perform pg_temp.ok('a real secret hashes to 64 hex chars',
    length(public.games_hash('a-perfectly-long-bearer-secret-value')) = 64);
end;
$t5$;

select 'PASS | games social SQL' as result;
