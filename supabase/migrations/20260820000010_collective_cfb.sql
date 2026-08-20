-- Model Collective, migration 10: NCAA football (CFB).
--
-- Adds the sport, the 2026 season window, and all 136 FBS programs with
-- aliases. Team names follow CollegeFootballData spelling, which is what the
-- EdgeDesk cfb schema already ingests, so a creator submitting from CFD or
-- cfbfastR data resolves without translation. Common written variants (St for
-- State, "and" for &, parenthetical drops) are aliased too.
--
-- No games are seeded here: load a slate through Admin, Games, exactly like
-- NFL. Nothing about NFL changes.

insert into collective.sports (code, name) values ('CFB', 'College Football')
on conflict (code) do nothing;

insert into collective.sport_seasons (sport_code, season, starts_on, ends_on)
values ('CFB', 2026, '2026-08-22', '2027-01-20')
on conflict (sport_code, season) do nothing;

-- Format: code | school | extra;alias;variants
do $$
declare
  rows text[] := array[
    'AIRFORCE|Air Force|',
    'AKRON|Akron|',
    'ALABAMA|Alabama|',
    'APPSTATE|App State|App St;App St.;Appalachian St;Appalachian State',
    'ARIZONA|Arizona|',
    'ARIZONASTA|Arizona State|Arizona St;Arizona St.',
    'ARKANSAS|Arkansas|',
    'ARKANSASST|Arkansas State|Arkansas St;Arkansas St.',
    'ARMY|Army|',
    'AUBURN|Auburn|',
    'BYU|BYU|Brigham Young',
    'BALLSTATE|Ball State|Ball St;Ball St.',
    'BAYLOR|Baylor|',
    'BOISESTATE|Boise State|Boise St;Boise St.',
    'BOSTONCOLL|Boston College|',
    'BOWLINGGRE|Bowling Green|',
    'BUFFALO|Buffalo|',
    'CALIFORNIA|California|Cal',
    'CENTRALMIC|Central Michigan|',
    'CHARLOTTE|Charlotte|',
    'CINCINNATI|Cincinnati|',
    'CLEMSON|Clemson|',
    'COASTALCAR|Coastal Carolina|',
    'COLORADO|Colorado|',
    'COLORADOST|Colorado State|Colorado St;Colorado St.',
    'DELAWARE|Delaware|',
    'DUKE|Duke|',
    'EASTCAROLI|East Carolina|',
    'EASTERNMIC|Eastern Michigan|',
    'FLORIDA|Florida|',
    'FLORIDAATL|Florida Atlantic|FAU',
    'FLORIDAINT|Florida International|FIU',
    'FLORIDASTA|Florida State|Florida St;Florida St.',
    'FRESNOSTAT|Fresno State|Fresno St;Fresno St.',
    'GEORGIA|Georgia|',
    'GEORGIASOU|Georgia Southern|',
    'GEORGIASTA|Georgia State|Georgia St;Georgia St.',
    'GEORGIATEC|Georgia Tech|',
    'HAWAII|Hawai''i|Hawaii;Hawaii Rainbow Warriors',
    'HOUSTON|Houston|',
    'ILLINOIS|Illinois|',
    'INDIANA|Indiana|',
    'IOWA|Iowa|',
    'IOWASTATE|Iowa State|Iowa St;Iowa St.',
    'JACKSONVIL|Jacksonville State|Jacksonville St;Jacksonville St.',
    'JAMESMADIS|James Madison|',
    'KANSAS|Kansas|',
    'KANSASSTAT|Kansas State|Kansas St;Kansas St.',
    'KENNESAWST|Kennesaw State|Kennesaw St;Kennesaw St.',
    'KENTSTATE|Kent State|Kent St;Kent St.',
    'KENTUCKY|Kentucky|',
    'LSU|LSU|Louisiana State',
    'LIBERTY|Liberty|',
    'LOUISIANA|Louisiana|Louisiana Lafayette;Louisiana-Lafayette;UL Lafayette;ULL',
    'LOUISIANAT|Louisiana Tech|',
    'LOUISVILLE|Louisville|',
    'MARSHALL|Marshall|',
    'MARYLAND|Maryland|',
    'MASSACHUSE|Massachusetts|UMass',
    'MEMPHIS|Memphis|',
    'MIAMI|Miami|Miami (FL);Miami FL;Miami Florida',
    'MIAMIOH|Miami (OH)|Miami OH;Miami Ohio',
    'MICHIGAN|Michigan|',
    'MICHIGANST|Michigan State|Michigan St;Michigan St.',
    'MIDDLETENN|Middle Tennessee|Middle Tenn;Middle Tennessee State;MTSU',
    'MINNESOTA|Minnesota|',
    'MISSISSIPP|Mississippi State|Mississippi St;Mississippi St.',
    'MISSOURI|Missouri|',
    'MISSOURIST|Missouri State|Missouri St;Missouri St.',
    'NCSTATE|NC State|NC St;NC St.;NCSU;North Carolina St;North Carolina State',
    'NAVY|Navy|',
    'NEBRASKA|Nebraska|',
    'NEVADA|Nevada|',
    'NEWMEXICO|New Mexico|',
    'NEWMEXICOS|New Mexico State|New Mexico St;New Mexico St.',
    'NORTHCAROL|North Carolina|',
    'NORTHTEXAS|North Texas|',
    'NORTHERNIL|Northern Illinois|',
    'NORTHWESTE|Northwestern|',
    'NOTREDAME|Notre Dame|',
    'OHIO|Ohio|Ohio Bobcats',
    'OHIOSTATE|Ohio State|Ohio St;Ohio St.',
    'OKLAHOMA|Oklahoma|',
    'OKLAHOMAST|Oklahoma State|Oklahoma St;Oklahoma St.',
    'OLDDOMINIO|Old Dominion|',
    'OLEMISS|Ole Miss|Mississippi',
    'OREGON|Oregon|',
    'OREGONSTAT|Oregon State|Oregon St;Oregon St.',
    'PENNSTATE|Penn State|Penn St;Penn St.',
    'PITTSBURGH|Pittsburgh|Pitt',
    'PURDUE|Purdue|',
    'RICE|Rice|',
    'RUTGERS|Rutgers|',
    'SMU|SMU|Southern Methodist',
    'SAMHOUSTON|Sam Houston|Sam Houston State',
    'SANDIEGOST|San Diego State|San Diego St;San Diego St.',
    'SANJOSESTA|San José State|San Jose St;San Jose St.;San Jose State;San José St;San José St.',
    'SOUTHALABA|South Alabama|',
    'SOUTHCAROL|South Carolina|',
    'SOUTHFLORI|South Florida|',
    'SOUTHERNMI|Southern Miss|Southern Mississippi',
    'STANFORD|Stanford|',
    'SYRACUSE|Syracuse|',
    'TCU|TCU|Texas Christian',
    'TEMPLE|Temple|',
    'TENNESSEE|Tennessee|',
    'TEXAS|Texas|',
    'TEXASAM|Texas A&M|Texas A and M;Texas A M;Texas AandM',
    'TEXASSTATE|Texas State|Texas St;Texas St.',
    'TEXASTECH|Texas Tech|',
    'TOLEDO|Toledo|',
    'TROY|Troy|',
    'TULANE|Tulane|',
    'TULSA|Tulsa|',
    'UAB|UAB|Alabama Birmingham',
    'UCF|UCF|Central Florida',
    'UCLA|UCLA|',
    'UCONN|UConn|Connecticut',
    'ULMONROE|UL Monroe|Louisiana Monroe;Louisiana-Monroe;ULM',
    'UNLV|UNLV|Nevada Las Vegas',
    'USC|USC|Southern Cal;Southern California',
    'UTEP|UTEP|Texas El Paso',
    'UTSA|UTSA|Texas San Antonio',
    'UTAH|Utah|',
    'UTAHSTATE|Utah State|Utah St;Utah St.',
    'VANDERBILT|Vanderbilt|',
    'VIRGINIA|Virginia|',
    'VIRGINIATE|Virginia Tech|',
    'WAKEFOREST|Wake Forest|',
    'WASHINGTON|Washington|',
    'WASHINGTO2|Washington State|Washington St;Washington St.',
    'WESTVIRGIN|West Virginia|',
    'WESTERNKEN|Western Kentucky|WKU',
    'WESTERNMIC|Western Michigan|',
    'WISCONSIN|Wisconsin|',
    'WYOMING|Wyoming|'
  ];
  r text;
  parts text[];
  v_team uuid;
  a text;
begin
  foreach r in array rows loop
    parts := string_to_array(r, '|');

    insert into collective.teams (sport_code, code, name)
    values ('CFB', parts[1], parts[2])
    on conflict (sport_code, code) do nothing;
    select id into v_team from collective.teams where sport_code = 'CFB' and code = parts[1];

    -- the code and the canonical school name always resolve
    insert into collective.team_aliases (sport_code, alias, team_id)
    values ('CFB', parts[1], v_team), ('CFB', parts[2], v_team)
    on conflict do nothing;

    -- written variants
    if coalesce(parts[3], '') <> '' then
      foreach a in array string_to_array(parts[3], ';') loop
        if trim(a) <> '' then
          insert into collective.team_aliases (sport_code, alias, team_id)
          values ('CFB', trim(a), v_team)
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end loop;
end $$;
