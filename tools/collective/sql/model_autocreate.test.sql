-- ===========================================================================
-- SELF-SERVE MODELS, run against a real PostgreSQL.
--
-- supabase/collective_model_autocreate.sql has been applied to a live database
-- holding a reconstruction of the Collective schema. These are not assertions
-- about what that file SAYS: the functions it installed are used here, and
-- attacked -- as anon, as one contributor reaching for another's account, with
-- a removed creator, with every spelling of the same sport, and with a
-- duplicate the unique index has to refuse.
--
-- The load-bearing cases, in the brief's own letters:
--   A  a CFB-only contributor asks for NFL           -> a model appears
--   B  the same contributor asks again               -> the SAME model, no copy
--   F  the CFB model, its id and its submissions     -> untouched
--   I  one contributor cannot reach another's model  -> and cannot name one
--
-- H (two simultaneous creations make one model) needs two connections at once,
-- so it lives in the Node harness that runs this file. What is provable from
-- one session is here: the index REFUSES the second row.
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, ''); end if;
end; $$;

create or replace function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_id::text, false);
  execute 'set role authenticated';
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role anon';
end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end; $$;

-- ═══ the world ════════════════════════════════════════════════════════════
-- One contributor who already has a college model, posted under the server's
-- own NCAAF spelling and carrying graded submissions; one with nothing at all;
-- one who has been removed; and a stranger.
do $seed$
declare
  U_BLIZZ  constant uuid := 'dddddddd-0000-0000-0000-000000000001';
  U_FRESH  constant uuid := 'dddddddd-0000-0000-0000-000000000002';
  U_GONE   constant uuid := 'dddddddd-0000-0000-0000-000000000003';
  U_NOBODY constant uuid := 'dddddddd-0000-0000-0000-000000000004';
  c_blizz uuid; c_fresh uuid; c_gone uuid;
  m_cfb uuid; g uuid;
begin
  insert into auth.users (id, email) values
    (U_BLIZZ,'blizzard@example.com'), (U_FRESH,'fresh@example.com'),
    (U_GONE,'gone@example.com'), (U_NOBODY,'nobody@example.com')
  on conflict (id) do nothing;

  insert into collective.creators (user_id, slug, display_name)
  values (U_BLIZZ, 'blizzard-performance', 'Blizzard Performance') returning id into c_blizz;
  insert into collective.creators (user_id, slug, display_name)
  values (U_FRESH, 'fresh-desk', 'Fresh Desk') returning id into c_fresh;
  insert into collective.creators (user_id, slug, display_name, account_status)
  values (U_GONE, 'gone-desk', 'Gone Desk', 'removed') returning id into c_gone;

  -- The model that already exists, spelled the way THIS server spells it.
  insert into collective.models (creator_id, slug, name, sport)
  values (c_blizz, 'blizzard-performance-p4', 'Blizzard P4', 'NCAAF') returning id into m_cfb;

  -- and real work filed under it, which nothing here may disturb
  insert into collective.games (sport_code, season, week, kickoff_at, home_team, away_team)
  values ('NCAAF', 2026, 3, now() + interval '2 days', 'TCU', 'SMU') returning id into g;
  insert into collective.projections (model_id, game_id, spread, is_graded_candidate, result)
  values (m_cfb, g, -3.5, true, 'win');

  raise notice 'ok   the fixture Collective is seeded';
end $seed$;

-- ═══ 1. the vocabulary ════════════════════════════════════════════════════
-- Every spelling of one sport has to reach one family, or the whole guarantee
-- below is decoration: two spellings would make two models.
do $t$
begin
  perform pg_temp.ok('NFL and its long name are one family',
    collective.sport_family('NFL') = 'NFL'
    and collective.sport_family('National Football League') = 'NFL'
    and collective.sport_family('pro-football') = 'NFL'
    and collective.sport_family('americanfootball_nfl') = 'NFL');
  perform pg_temp.ok('every college spelling is one family',
    collective.sport_family('CFB') = 'CFB'
    and collective.sport_family('NCAAF') = 'CFB'
    and collective.sport_family('ncaaf') = 'CFB'
    and collective.sport_family('College Football') = 'CFB'
    and collective.sport_family('college-football') = 'CFB'
    and collective.sport_family('CFB-P4') = 'CFB',
    collective.sport_family('college-football'));
  perform pg_temp.ok('the two football families are not each other',
    collective.sport_family('NFL') <> collective.sport_family('CFB'));
  perform pg_temp.ok('a sport nobody has heard of is its own family, never merged into one',
    collective.sport_family('WNBA') = 'WNBA'
    and collective.sport_family('WNBA') <> collective.sport_family('NBA'));
  perform pg_temp.ok('nothing at all normalises to nothing, rather than to a sport',
    collective.sport_family('') is null and collective.sport_family(null) is null
    and collective.sport_family('   ') is null);

  -- The SERVER owns the vocabulary: this fixture says NCAAF, so a file detected
  -- as CFB has to be written back as NCAAF or its games are looked up in a
  -- sport the schedule does not carry.
  perform pg_temp.ok('a detected sport is written back in the code THIS server uses',
    collective.sport_canonical('CFB') = 'NCAAF'
    and collective.sport_canonical('college football') = 'NCAAF',
    collective.sport_canonical('CFB'));
  perform pg_temp.ok('a code the server already uses comes back unchanged',
    collective.sport_canonical('NFL') = 'NFL'
    and collective.sport_canonical('nfl') = 'NFL');
  perform pg_temp.ok('a sport the server does not list keeps its own name rather than becoming one it does',
    collective.sport_canonical('WNBA') = 'WNBA');
end $t$;

-- ═══ 2. A: a CFB-only contributor asks for NFL ════════════════════════════
do $t$
declare
  c uuid; r record; n int; before_id uuid;
begin
  select id into c from collective.creators where slug = 'blizzard-performance';
  select id into before_id from collective.models where creator_id = c;

  select count(*) into n from collective.models where creator_id = c;
  perform pg_temp.ok('before: one model, and it is the college one', n = 1);

  select * into r from collective.get_or_create_model(c, 'NFL', null);
  perform pg_temp.ok('A: the NFL model is created on request', r.created, r.model_slug);
  perform pg_temp.ok('A: it is an NFL model', collective.sport_family(r.sport) = 'NFL', r.sport);
  perform pg_temp.ok('A: it belongs to the contributor who asked',
    exists (select 1 from collective.models m where m.id = r.model_id and m.creator_id = c));
  perform pg_temp.ok('A: it is a SEPARATE model, not the college one renamed',
    r.model_id <> before_id);
  perform pg_temp.ok('A: it is named after the contributor, not left blank',
    r.model_name = 'Blizzard Performance NFL', r.model_name);
  perform pg_temp.ok('A: its slug says whose it is and which sport',
    r.model_slug = 'blizzard-performance-nfl', r.model_slug);

  -- F: the model that already existed, and the work filed under it.
  perform pg_temp.ok('F: the college model keeps its id',
    exists (select 1 from collective.models where id = before_id and creator_id = c));
  perform pg_temp.ok('F: it keeps its slug, name and sport',
    exists (select 1 from collective.models
             where id = before_id and slug = 'blizzard-performance-p4'
               and name = 'Blizzard P4' and sport = 'NCAAF'));
  perform pg_temp.ok('F: its submissions still point at it',
    (select count(*) from collective.projections where model_id = before_id) = 1);
  perform pg_temp.ok('F: and still reach the record the product reads',
    (select graded from collective.model_records where model_id = before_id) = 1);
end $t$;

-- ═══ 3. B: asking again returns the same model ════════════════════════════
do $t$
declare
  c uuid; first uuid; r record; n int;
begin
  select id into c from collective.creators where slug = 'blizzard-performance';
  select model_id into first from collective.get_or_create_model(c, 'NFL', null);

  select * into r from collective.get_or_create_model(c, 'NFL', null);
  perform pg_temp.ok('B: the second call returns the same model', r.model_id = first);
  perform pg_temp.ok('B: and says it did not create one', not r.created);

  -- The aliases are the real test: a caller who says NCAAF and a caller who
  -- says "College Football" must not end up with two college models.
  select * into r from collective.get_or_create_model(c, 'national football league', null);
  perform pg_temp.ok('B: a different spelling of NFL returns the same model',
    r.model_id = first and not r.created, r.model_slug);
  perform pg_temp.ok('B: so does the odds feed''s own key',
    (select model_id from collective.get_or_create_model(c, 'americanfootball_nfl', null)) = first);

  select count(*) into n from collective.models
   where creator_id = c and collective.sport_family(sport) = 'NFL';
  perform pg_temp.ok('B: after four calls there is exactly one NFL model', n = 1, n::text);

  -- and the college one, reached by three names, is still one row
  perform pg_temp.ok('B: CFB, NCAAF and "College Football" all reach the one college model',
    (select model_id from collective.get_or_create_model(c, 'CFB', null))
      = (select model_id from collective.get_or_create_model(c, 'NCAAF', null))
    and (select model_id from collective.get_or_create_model(c, 'College Football', null))
      = (select id from collective.models where slug = 'blizzard-performance-p4'));
  select count(*) into n from collective.models where creator_id = c;
  perform pg_temp.ok('B: the contributor has exactly two models, one per sport', n = 2, n::text);
end $t$;

-- ═══ 4. the constraint, not the good intentions ═══════════════════════════
do $t$
declare
  c uuid; failed boolean := false;
begin
  select id into c from collective.creators where slug = 'blizzard-performance';
  begin
    insert into collective.models (creator_id, slug, name, sport)
    values (c, 'blizzard-performance-nfl-2', 'A second NFL model', 'NFL');
  exception when unique_violation then failed := true;
  end;
  perform pg_temp.ok('a second NFL model cannot be inserted at all, by anyone', failed);

  -- and the alias is what makes that true: NCAAF is already taken by CFB
  failed := false;
  begin
    insert into collective.models (creator_id, slug, name, sport)
    values (c, 'blizzard-performance-cfb', 'Another college model', 'CFB');
  exception when unique_violation then failed := true;
  end;
  perform pg_temp.ok('nor can a college model under a different spelling of college', failed);

  -- a DIFFERENT contributor is a different row: the index is per creator
  perform pg_temp.ok('a second contributor may of course have their own NFL model',
    (select created from collective.get_or_create_model(
       (select id from collective.creators where slug = 'fresh-desk'), 'NFL', null)));
end $t$;

-- ═══ 5. a contributor with nothing at all ═════════════════════════════════
do $t$
declare c uuid; r record;
begin
  select id into c from collective.creators where slug = 'fresh-desk';
  select * into r from collective.get_or_create_model(c, 'College Football', 'My College Model');
  perform pg_temp.ok('a contributor with no models gets one', r.created);
  perform pg_temp.ok('the name they chose is the name it has', r.model_name = 'My College Model');
  perform pg_temp.ok('and it is stored in the server''s spelling, not the one they typed',
    r.sport = 'NCAAF', r.sport);
  perform pg_temp.ok('a first slate in a second sport does not disturb the first',
    (select count(*) from collective.models where creator_id = c) = 2);
end $t$;

-- ═══ 6. what it refuses ═══════════════════════════════════════════════════
do $t$
declare c uuid; threw boolean;
begin
  select id into c from collective.creators where slug = 'blizzard-performance';

  threw := false;
  begin perform collective.get_or_create_model(c, '', null);
  exception when others then threw := true; end;
  perform pg_temp.ok('a request with no sport is refused rather than guessed at', threw);

  threw := false;
  begin perform collective.get_or_create_model(null, 'NFL', null);
  exception when others then threw := true; end;
  perform pg_temp.ok('a request with no creator is refused', threw);

  threw := false;
  begin perform collective.get_or_create_model(
    '00000000-0000-0000-0000-0000000000ff'::uuid, 'NFL', null);
  exception when others then threw := true; end;
  perform pg_temp.ok('a creator that does not exist is refused, never invented', threw);
end $t$;

-- ═══ 7. the door the browser knocks on ════════════════════════════════════
-- The rule this is really about: the acting creator comes from auth.uid() and
-- there is NO ARGUMENT for it, so nothing a page sends can claim to be somebody
-- else. That is checked by signature, not only by behaviour.
do $t$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'collective_model_ensure'
     and pg_get_function_identity_arguments(p.oid) = 'p_sport text, p_model_name text';
  perform pg_temp.ok('collective_model_ensure takes a sport and a name — and no creator',
    n = 1);
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'collective_my_models'
     and pg_get_function_identity_arguments(p.oid) = '';
  perform pg_temp.ok('collective_my_models takes nothing at all', n = 1);
end $t$;

do $t$
declare j jsonb; mine jsonb;
begin
  perform pg_temp.as_user('dddddddd-0000-0000-0000-000000000001');
  j := public.collective_model_ensure('NFL');
  perform pg_temp.ok('a signed-in contributor gets their own NFL model back',
    (j->>'ok')::boolean and j->'model'->>'model_slug' = 'blizzard-performance-nfl', j::text);
  perform pg_temp.ok('and is told it already existed rather than that something failed',
    (j->>'already')::boolean and not (j->>'created')::boolean);

  mine := public.collective_my_models();
  perform pg_temp.ok('their own models read back, both of them',
    jsonb_array_length(mine) = 2, mine::text);
  perform pg_temp.ok('and every one of them is theirs',
    not exists (select 1 from jsonb_array_elements(mine) e
                 where e->>'model_slug' like 'fresh-desk%'), mine::text);
  perform pg_temp.as_owner();
end $t$;

-- I: one contributor cannot reach another's model.
do $t$
declare j jsonb; mine jsonb; c_blizz uuid;
begin
  select id into c_blizz from collective.creators where slug = 'blizzard-performance';

  perform pg_temp.as_user('dddddddd-0000-0000-0000-000000000002');
  j := public.collective_model_ensure('NFL');
  perform pg_temp.ok('I: a second contributor asking for NFL gets THEIR NFL model',
    j->'model'->>'model_slug' = 'fresh-desk-nfl', j::text);

  mine := public.collective_my_models();
  perform pg_temp.ok('I: and reads back only their own',
    jsonb_array_length(mine) = 2
    and not exists (select 1 from jsonb_array_elements(mine) e
                     where e->>'model_slug' like 'blizzard%'), mine::text);

  perform pg_temp.as_owner();

  -- There is no argument through which they could name another creator, so the
  -- attack that remains is reaching past the door: reading the table, or
  -- calling the creator-taking function underneath it. Asked as the owner,
  -- because a role that cannot even see the schema cannot resolve its names.
  perform pg_temp.ok('I: the contributor role cannot see the Collective schema at all',
    not has_schema_privilege('authenticated', 'collective', 'usage'));
  perform pg_temp.ok('I: and cannot read the models table directly to find one',
    not has_table_privilege('authenticated', 'collective.models', 'select'));
  perform pg_temp.ok('I: nor call the creator-taking function that would let them name one',
    not has_function_privilege('authenticated',
      'collective.get_or_create_model(uuid, text, text)', 'execute')
    and not has_function_privilege('anon',
      'collective.get_or_create_model(uuid, text, text)', 'execute'));
end $t$;

-- A creator whose account is closed does not grow a new sport on the way out.
do $t$
declare j jsonb;
begin
  perform pg_temp.as_user('dddddddd-0000-0000-0000-000000000003');
  j := public.collective_model_ensure('NFL');
  perform pg_temp.ok('a removed contributor is refused, and told why',
    not (j->>'ok')::boolean and j->>'code' = 'no_creator', j::text);
  perform pg_temp.as_owner();
  perform pg_temp.ok('and no model was made for them',
    not exists (select 1 from collective.models m
                  join collective.creators c on c.id = m.creator_id
                 where c.slug = 'gone-desk'));
end $t$;

-- A signed-in account that is not a contributor at all.
do $t$
declare j jsonb;
begin
  perform pg_temp.as_user('dddddddd-0000-0000-0000-000000000004');
  j := public.collective_model_ensure('NFL');
  perform pg_temp.ok('an account with no contributor profile is told so, not 500ed',
    not (j->>'ok')::boolean and j->>'code' = 'no_creator', j::text);
  perform pg_temp.ok('and reads back no models', public.collective_my_models() = '[]'::jsonb);
  perform pg_temp.as_owner();
end $t$;

-- ═══ 8. anon ══════════════════════════════════════════════════════════════
do $t$
declare denied boolean := false;
begin
  perform pg_temp.as_anon();
  begin perform public.collective_model_ensure('NFL');
  exception when insufficient_privilege then denied := true;
  end;
  perform pg_temp.ok('anon cannot create a model', denied);

  denied := false;
  begin perform public.collective_my_models();
  exception when insufficient_privilege then denied := true;
  end;
  perform pg_temp.ok('anon cannot read anybody''s models', denied);
  perform pg_temp.as_owner();
end $t$;

-- ═══ 9. what the migration did NOT do ═════════════════════════════════════
-- The brief says: do not solve this by disabling RLS, and do not break the
-- people already here. Both are checkable facts about the database now.
do $t$
declare n int;
begin
  select count(*) into n from pg_tables
   where schemaname = 'collective' and rowsecurity is false and tablename = 'models';
  -- The fixture never turned RLS ON for collective.models, so the only thing to
  -- prove is that this file did not turn it OFF for anything that had it.
  perform pg_temp.ok('no client role was granted access to the models table',
    not has_table_privilege('anon', 'collective.models', 'select')
    and not has_table_privilege('authenticated', 'collective.models', 'insert'));
  perform pg_temp.ok('nor to the creators table',
    not has_table_privilege('anon', 'collective.creators', 'select')
    and not has_table_privilege('authenticated', 'collective.creators', 'update'));

  perform pg_temp.ok('both public doors are security definer, which is what makes that safe',
    (select bool_and(p.prosecdef) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public'
        and p.proname in ('collective_model_ensure', 'collective_my_models')));
  perform pg_temp.ok('and both pin their search_path, so nothing on the caller''s can shadow a table',
    (select bool_and(array_to_string(p.proconfig, ',') like '%search_path%')
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public'
        and p.proname in ('collective_model_ensure', 'collective_my_models')));

  select count(*) into n from collective.projections;
  perform pg_temp.ok('every submission that existed still exists', n = 1);
end $t$;

do $done$ begin raise notice 'ok   the self-serve model suite finished'; end $done$;
