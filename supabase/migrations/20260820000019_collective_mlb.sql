-- Model Collective, migration 19: MLB.
--
-- The sport, its 2026 season window, all 30 clubs, and the alias vocabulary
-- an odds feed actually prints. Nothing here is odds-provider specific: a
-- provider only ever resolves through team_aliases, so adding a second feed
-- later needs no schema change.
--
-- Three cities field two clubs (New York, Los Angeles, Chicago), so the bare
-- city is never seeded as an alias for any of them. "Chicago" must not
-- silently resolve to the Cubs. The nickname-carrying short forms odds pages
-- print ("Chi Cubs", "LA Dodgers") are seeded explicitly instead, exactly as
-- migration 16 did for the NFL: name the forms, never loosen the matching.

insert into collective.sports (code, name) values ('MLB', 'Baseball')
on conflict (code) do nothing;

-- Opening day through the end of the World Series window.
insert into collective.sport_seasons (sport_code, season, starts_on, ends_on)
values ('MLB', 2026, '2026-03-25', '2026-11-08')
on conflict do nothing;

do $$
declare
  rows text[] := array[
    'ARI|Arizona|Diamondbacks|AZ;D-backs;Dbacks;D Backs',
    'ATH|Athletics|Athletics|OAK;A''s;Oakland Athletics;Sacramento Athletics;Las Vegas Athletics',
    'ATL|Atlanta|Braves|',
    'BAL|Baltimore|Orioles|BLT;O''s',
    'BOS|Boston|Red Sox|',
    'CHC|Chicago|Cubs|CHN;Chi Cubs;Chicago Cubs',
    'CIN|Cincinnati|Reds|',
    'CLE|Cleveland|Guardians|Cleveland Indians',
    'COL|Colorado|Rockies|',
    'CWS|Chicago|White Sox|CHW;CHA;Chi White Sox;Chicago White Sox',
    'DET|Detroit|Tigers|',
    'HOU|Houston|Astros|',
    'KC|Kansas City|Royals|KAN;KCR',
    'LAA|Los Angeles|Angels|ANA;LAN;LA Angels;L.A. Angels;Anaheim Angels;Los Angeles Angels',
    'LAD|Los Angeles|Dodgers|LA Dodgers;L.A. Dodgers;Los Angeles Dodgers',
    'MIA|Miami|Marlins|FLA;Florida Marlins',
    'MIL|Milwaukee|Brewers|',
    'MIN|Minnesota|Twins|',
    'NYM|New York|Mets|NY Mets;N.Y. Mets;New York Mets',
    'NYY|New York|Yankees|NY Yankees;N.Y. Yankees;New York Yankees',
    'PHI|Philadelphia|Phillies|',
    'PIT|Pittsburgh|Pirates|',
    'SD|San Diego|Padres|SDP',
    'SEA|Seattle|Mariners|',
    'SF|San Francisco|Giants|SFG',
    'STL|St. Louis|Cardinals|St Louis;Saint Louis',
    'TB|Tampa Bay|Rays|TBR;Tampa Bay Devil Rays',
    'TEX|Texas|Rangers|',
    'TOR|Toronto|Blue Jays|',
    'WSH|Washington|Nationals|WAS;WSN'
  ];
  r text;
  parts text[];
  v_team uuid;
  v_name text;
  a text;
  city_ambiguous boolean;
begin
  foreach r in array rows loop
    parts := string_to_array(r, '|');
    -- The Athletics carry no city since the Oakland move, so city and
    -- nickname are the same string and the full name is the nickname alone.
    v_name := case when parts[2] = parts[3] then parts[3] else parts[2] || ' ' || parts[3] end;

    select id into v_team from collective.teams where sport_code = 'MLB' and code = parts[1];
    if v_team is null then
      insert into collective.teams (sport_code, code, name)
      values ('MLB', parts[1], v_name)
      returning id into v_team;
    end if;

    -- code, nickname, full name
    insert into collective.team_aliases (sport_code, alias, team_id) values
      ('MLB', parts[1], v_team),
      ('MLB', parts[3], v_team),
      ('MLB', v_name, v_team)
    on conflict do nothing;

    -- The bare city, only where one club owns it.
    city_ambiguous := parts[2] in ('New York', 'Los Angeles', 'Chicago');
    if not city_ambiguous then
      insert into collective.team_aliases (sport_code, alias, team_id)
      values ('MLB', parts[2], v_team)
      on conflict do nothing;
    end if;

    if parts[4] <> '' then
      foreach a in array string_to_array(parts[4], ';') loop
        insert into collective.team_aliases (sport_code, alias, team_id)
        values ('MLB', a, v_team)
        on conflict do nothing;
      end loop;
    end if;
  end loop;
end $$;
