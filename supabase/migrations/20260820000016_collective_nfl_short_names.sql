-- Model Collective, migration 16: short team names used by odds pages.
--
-- The NFL seed deliberately withheld bare city aliases for New York and Los
-- Angeles, because "LA" and "New York" each name two teams. These forms are
-- different: they carry the nickname, so they are unambiguous, and odds pages
-- print them constantly. Adding them by hand rather than loosening matching,
-- which is what would let a pick attach to the wrong team.

do $$
declare
  pairs text[][] := array[
    ['LA Chargers','LAC'], ['L.A. Chargers','LAC'], ['Los Angeles Chargers','LAC'],
    ['LA Rams','LAR'],     ['L.A. Rams','LAR'],
    ['NY Giants','NYG'],   ['N.Y. Giants','NYG'],
    ['NY Jets','NYJ'],     ['N.Y. Jets','NYJ']
  ];
  i int;
  v_team uuid;
begin
  for i in 1 .. array_length(pairs, 1) loop
    select id into v_team from collective.teams
     where sport_code = 'NFL' and code = pairs[i][2];
    if v_team is not null then
      insert into collective.team_aliases (sport_code, alias, team_id)
      values ('NFL', pairs[i][1], v_team)
      on conflict do nothing;
    end if;
  end loop;
end $$;
