-- ===========================================================================
-- FOOTBALL GRADING v2 (grading_version = 'football-v2') — ONE canonical
-- settlement for the Model Collective, NFL and college football alike.
--
-- Paste into the Supabase SQL editor (or apply with psql). Idempotent,
-- additive, ends in a report. It never edits a projection, never deletes a
-- captured price, and never invents a closing line.
--
-- WHY. The 2026 records showed NFL: 47 finals, ~16 ATS grades per model;
-- CFB: ~205 finals, 38-55 ATS grades, "614 model-games with no captured
-- closing line". The closes were not all missing. They were lost between
-- the market feed and the grade:
--   * the odds linker joined odds events to games on the Collective's stored
--     team CODE, which is cut to ten characters (MISSISSIPP, WESTVIRGIN), so
--     most college odds events never linked and the per-game close route
--     answered "unavailable";
--   * a close recovered AFTER a game settled was written only to the
--     committed JSON record, never back to the database row, so the
--     database's grades kept pick_result null (NFL week 2: 16 games);
--   * four graders disagreed about the model's side: grade_game and the
--     settle job graded a STATED side only, the page also derived one from
--     the model's line, and the page preferred any database grade — so a
--     model with no pick column was graded ATS on some games and silently not
--     on others;
--   * the public API showed each model's FIRST pre-lock row while the lock
--     rule grades the LATEST.
--
-- WHAT THIS INSTALLS (all in schema collective, all prefixed fg2_):
--   fg2_config               the rule's parameters, versioned
--   fg2_* text helpers       canonical team key / code / aliases
--   fg2_src_games / _predictions / _teams / _team_aliases / _legacy_grades
--                            views over whatever the deployed tables are called
--   fg2_team_registry, fg2_team_keys, fg2_name_alias
--                            the canonical team alias layer
--   fg2_game_alias           duplicate games -> their one canonical game
--   fg2_market_events        every market event any source holds
--   fg2_event_links          each market event -> one canonical game, or the
--                            reason it could not be linked (never dropped)
--   fg2_market_snapshots     every captured price, copied with provenance
--   fg2_official_closes      ONE close per game and market, with its snapshot,
--                            book, observed_at, kickoff and A-L class
--   fg2_settlements          one row per model per game per grading version:
--                            the whole grading trace and exclusion reasons
--   fg2_grade_audit          old state -> new state for every changed grade
--   fg2_rebuild(sport, season, commit)   the ordered, idempotent rebuild
--   fg2_settle_one(game)     the same for one game (grade_game delegates here)
--   views: fg2_grading_trace, fg2_model_standings, fg2_consensus_games,
--          fg2_consensus_record, fg2_calibration, fg2_slate_diagnostics,
--          fg2_close_classification
--
-- THE RULE lives in lib/football_grading.js and is mirrored here function for
-- function; tools/collective/football_grading_sql.test.js runs the same
-- vectors through both.
-- ===========================================================================

begin;

create temp table if not exists fg2_install_report (n serial, step text, outcome text, detail text);
truncate fg2_install_report;

-- 0 ---- configuration ------------------------------------------------------
create table if not exists collective.fg2_config (
  key   text primary key,
  value jsonb not null,
  note  text
);
insert into collective.fg2_config (key, value, note) values
  ('grading_version', '"football-v2"'::jsonb,
   'Every settlement row carries the version that produced it. A methodology change is a NEW version, never a silent rewrite of this one.'),
  ('close_window_minutes', '{"NFL": 360, "CFB": 360}'::jsonb,
   'The final-pregame window. A snapshot older than this before kickoff is an old price, not a close; a snapshot at or after kickoff is an in-game price and is never a close.'),
  ('kickoff_tolerance_minutes', '2160'::jsonb,
   'How far two representations of one fixture may disagree about kickoff and still be one game (a moved game, a provider in local time).'),
  ('sources', '[{"name":"collective_odds","priority":1},{"name":"collective_odds_close","priority":2,"untimed":true},{"name":"legacy_results_close","priority":3,"untimed":true},{"name":"edgedesk_capture","priority":4}]'::jsonb,
   'Market sources in the order a close is taken from them. A source not listed is never read. untimed sources carry no observation time and are used only when no source has a valid timed pregame snapshot.'),
  ('book_priority', '["consensus","median","pinnacle","circa","draftkings","fanduel","betmgm","caesars","williamhill_us","espnbet","bet365","pointsbetus","betrivers","bovada","betonlineag","mybookieag","lowvig","unibet_us","wynnbet","superbook"]'::jsonb,
   'Inside one capture pass carrying several books, which book''s line is the close.'),
  ('snapshot_relations', '[]'::jsonb,
   'Operator-declared snapshot relations, used before discovery: [{"relation":"odds.x","source":"collective_odds","event_col":"event_id","time_col":"captured_at","line_col":"point","line_kind":"side","side_col":"outcome","market_col":"market","book_col":"book","id_col":"id"}]. line_kind is home | away | side.'),
  ('snapshot_import_margin_minutes', '120'::jsonb,
   'Timed price history is copied from [kickoff - (close window + margin), kickoff + margin] of its own event. Nothing outside the close window can ever be a close; the margin keeps the in-game and just-stale rows a game''s close class is read from. Widen the window and re-run the rebuild to copy older rows.')
on conflict (key) do nothing;

-- Which revision of THIS file is installed. It is re-applied in place (every
-- statement is idempotent), so the revision is how a caller knows the
-- database carries the functions it expects.
insert into collective.fg2_config (key, value, note) values
  ('install_revision', '3'::jsonb,
   'Revision of supabase/migrations/20260928120000_football_grading_v2.sql installed here. 2: window-bounded, index-driven snapshot import; breadth tie-break; fg2_refresh. 3: every UPDATE/DELETE qualified, so grade_game / fg2_refresh run through PostgREST (pg-safeupdate); fg2_compute_close''s scratch table is per transaction, so callers of different roles can share a pooled session.')
on conflict (key) do update set value = excluded.value, note = excluded.note;

create or replace function collective.fg2_cfg(p_key text) returns jsonb
language sql stable as $fn$ select value from collective.fg2_config where key = p_key $fn$;

create or replace function collective.fg2_install_revision() returns integer
language sql stable as $fn$ select coalesce((collective.fg2_cfg('install_revision') #>> '{}')::int, 1) $fn$;

create or replace function collective.fg2_import_margin_minutes() returns numeric
language sql stable as $fn$ select coalesce((collective.fg2_cfg('snapshot_import_margin_minutes') #>> '{}')::numeric, 120) $fn$;

create or replace function collective.fg2_version() returns text
language sql stable as $fn$ select coalesce(collective.fg2_cfg('grading_version') #>> '{}', 'football-v2') $fn$;

create or replace function collective.fg2_league(p_sport text) returns text
language sql immutable as $fn$
  select case when upper(coalesce(p_sport, '')) = 'NFL' then 'NFL'
              when upper(coalesce(p_sport, '')) in ('CFB', 'CFB-P4', 'NCAAF') then 'CFB'
              else upper(coalesce(p_sport, '')) end
$fn$;

create or replace function collective.fg2_window_minutes(p_sport text) returns numeric
language sql stable as $fn$
  select coalesce((collective.fg2_cfg('close_window_minutes') ->> collective.fg2_league(p_sport))::numeric, 360)
$fn$;

create or replace function collective.fg2_tolerance_minutes() returns numeric
language sql stable as $fn$
  select coalesce((collective.fg2_cfg('kickoff_tolerance_minutes') #>> '{}')::numeric, 2160)
$fn$;

create or replace function collective.fg2_lock_minutes() returns numeric
language plpgsql stable as $fn$
declare n numeric;
begin
  if to_regprocedure('collective.lock_minutes()') is not null then
    execute 'select collective.lock_minutes()' into n;
  end if;
  return coalesce(n, 30);
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('0 config', 'ok', 'fg2_config present; install revision ' || collective.fg2_install_revision() ||
   '; grading version ' || collective.fg2_version() ||
   '; lock ' || collective.fg2_lock_minutes() || ' min; close window NFL ' || collective.fg2_window_minutes('NFL') ||
   ' / CFB ' || collective.fg2_window_minutes('CFB') || ' min');

-- 1 ---- the rule, as SQL twins of lib/football_grading.js -------------------
create or replace function collective.fg2_norm_side(p text) returns text
language sql immutable as $fn$
  select case when lower(btrim(coalesce(p, ''))) in ('home', 'h') then 'home'
              when lower(btrim(coalesce(p, ''))) in ('away', 'a', 'road', 'visitor') then 'away' end
$fn$;

create or replace function collective.fg2_game_state(p_status text, p_home numeric, p_away numeric) returns text
language sql immutable as $fn$
  select case
    when lower(coalesce(p_status, '')) ~ '(cancel|forfeit)' then 'GAME_CANCELLED'
    when lower(coalesce(p_status, '')) ~ '(postpon|suspend|delay)' then 'GAME_POSTPONED'
    when p_home is null or p_away is null then 'GAME_UNFINISHED'
    when p_home = 0 and p_away = 0 then 'GAME_UNFINISHED'
    when p_home < 0 or p_away < 0 or p_home <> trunc(p_home) or p_away <> trunc(p_away) then 'GAME_UNFINISHED'
    else 'FINAL' end
$fn$;

create or replace function collective.fg2_ats_margin(p_home numeric, p_away numeric, p_close numeric) returns numeric
language sql immutable as $fn$ select round((p_home - p_away) + p_close, 6) $fn$;

create or replace function collective.fg2_cover(p_home numeric, p_away numeric, p_close numeric) returns text
language sql immutable as $fn$
  select case when p_home is null or p_away is null or p_close is null then null
              when collective.fg2_ats_margin(p_home, p_away, p_close) > 0 then 'home'
              when collective.fg2_ats_margin(p_home, p_away, p_close) < 0 then 'away'
              else 'push' end
$fn$;

create or replace function collective.fg2_grade_side(p_side text, p_cover text) returns text
language sql immutable as $fn$
  select case when collective.fg2_norm_side(p_side) is null or p_cover is null then null
              when p_cover = 'push' then 'push'
              when collective.fg2_norm_side(p_side) = p_cover then 'win' else 'loss' end
$fn$;

create or replace function collective.fg2_derive_side(p_explicit text, p_fair numeric, p_close numeric,
  out side text, out source text, out edge_home numeric)
language plpgsql immutable as $fn$
declare s text := collective.fg2_norm_side(p_explicit);
begin
  if s is not null then side := s; source := 'explicit'; edge_home := null; return; end if;
  if p_fair is null or p_close is null then return; end if;
  edge_home := round(p_close - p_fair, 6);
  if abs(edge_home) < 0.000000001 then edge_home := 0; return; end if;
  side := case when edge_home > 0 then 'home' else 'away' end;
  source := 'derived';
end $fn$;

create or replace function collective.fg2_fair_home_spread(p_spread numeric, p_ph numeric, p_pa numeric) returns numeric
language sql immutable as $fn$
  select case when p_spread is not null then p_spread
              when p_ph is not null and p_pa is not null then round(-(p_ph - p_pa), 6) end
$fn$;

create or replace function collective.fg2_predicted_margin(p_spread numeric, p_ph numeric, p_pa numeric) returns numeric
language sql immutable as $fn$
  select case when p_ph is not null and p_pa is not null then round(p_ph - p_pa, 6)
              when p_spread is not null then round(-p_spread, 6) end
$fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('1 rule', 'ok', 'fg2_cover / fg2_grade_side / fg2_derive_side / fg2_game_state / fg2_fair_home_spread / fg2_predicted_margin');

-- 2 ---- canonical text: keys, codes, aliases -------------------------------
create or replace function collective.fg2_fold(p text) returns text
language sql immutable as $fn$
  select translate(coalesce(p, ''),
    'ÁÀÂÄÃÅĀáàâäãåāÉÈÊËĒéèêëēÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇçÝýÿ',
    'AAAAAAAaaaaaaaEEEEEeeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCcYyy')
$fn$;

create or replace function collective.fg2_team_key(p text) returns text
language sql immutable as $fn$
  select regexp_replace(lower(collective.fg2_fold(btrim(coalesce(p, '')))), '[^a-z0-9]+', '', 'g')
$fn$;

create or replace function collective.fg2_team_code(p text) returns text
language sql immutable as $fn$
  select left(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]+', '', 'g'), 10)
$fn$;

create or replace function collective.fg2_codes_of(p text) returns text[]
language sql immutable as $fn$
  select case when collective.fg2_team_code(collective.fg2_fold(p)) = collective.fg2_team_code(p)
              then array[collective.fg2_team_code(p)]
              else array[collective.fg2_team_code(collective.fg2_fold(p)), collective.fg2_team_code(p)] end
$fn$;

create or replace function collective.fg2_expand_state(p text) returns text
language sql immutable as $fn$
  select regexp_replace(regexp_replace(coalesce(p, ''), '\s+St\.?$', ' State', 'i'), '\s+St\.?(\s+\()', ' State\1', 'i')
$fn$;

create or replace function collective.fg2_prefixes(p text) returns text[]
language plpgsql immutable as $fn$
declare
  w text[];
  n int;
  dropped text;
  out_ text[] := '{}';
  q text[] := array['state','st','tech','am','southern','northern','eastern','western','central','christian',
    'international','intl','atlantic','poly','baptist','methodist','valley','martin','monroe','lafayette',
    'commerce','birmingham','carolina','florida','texas','illinois','michigan','kentucky','tennessee',
    'washington','arizona','colorado','mexico','city'];
begin
  if btrim(coalesce(p, '')) = '' then return out_; end if;
  w := regexp_split_to_array(btrim(p), '\s+');
  for n in reverse coalesce(array_length(w, 1), 0) - 1 .. 1 loop
    dropped := w[n + 1];
    exit when dropped ~ '^\(' or dropped ~ '\)$' or collective.fg2_team_key(dropped) = any(q);
    out_ := out_ || array_to_string(w[1:n], ' ');
  end loop;
  return out_;
end $fn$;

create table if not exists collective.fg2_name_alias (
  league    text not null,
  alias_key text not null,
  group_no  integer not null,
  alias     text not null,
  primary key (league, alias_key)
);
comment on table collective.fg2_name_alias is
  'Spellings that are the same team (Ole Miss = Mississippi, LA = LAR). Generated from lib/football_identity.js ALIAS_GROUPS; never a prefix rule.';

-- FG2_ALIAS_BEGIN (generated by tools/collective/football_identity_sql.js; do not edit by hand)
insert into collective.fg2_name_alias (league, alias_key, group_no, alias) values
  ('NFL', 'ari', 1, 'ARI'),
  ('NFL', 'arizonacardinals', 1, 'Arizona Cardinals'),
  ('NFL', 'arz', 1, 'ARZ'),
  ('NFL', 'arizona', 1, 'Arizona'),
  ('NFL', 'cardinals', 1, 'Cardinals'),
  ('NFL', 'phoenixcardinals', 1, 'Phoenix Cardinals'),
  ('NFL', 'atl', 2, 'ATL'),
  ('NFL', 'atlantafalcons', 2, 'Atlanta Falcons'),
  ('NFL', 'atlanta', 2, 'Atlanta'),
  ('NFL', 'falcons', 2, 'Falcons'),
  ('NFL', 'bal', 3, 'BAL'),
  ('NFL', 'baltimoreravens', 3, 'Baltimore Ravens'),
  ('NFL', 'blt', 3, 'BLT'),
  ('NFL', 'baltimore', 3, 'Baltimore'),
  ('NFL', 'ravens', 3, 'Ravens'),
  ('NFL', 'buf', 4, 'BUF'),
  ('NFL', 'buffalobills', 4, 'Buffalo Bills'),
  ('NFL', 'buffalo', 4, 'Buffalo'),
  ('NFL', 'bills', 4, 'Bills'),
  ('NFL', 'car', 5, 'CAR'),
  ('NFL', 'carolinapanthers', 5, 'Carolina Panthers'),
  ('NFL', 'carolina', 5, 'Carolina'),
  ('NFL', 'panthers', 5, 'Panthers'),
  ('NFL', 'chi', 6, 'CHI'),
  ('NFL', 'chicagobears', 6, 'Chicago Bears'),
  ('NFL', 'chicago', 6, 'Chicago'),
  ('NFL', 'bears', 6, 'Bears'),
  ('NFL', 'cin', 7, 'CIN'),
  ('NFL', 'cincinnatibengals', 7, 'Cincinnati Bengals'),
  ('NFL', 'cincinnati', 7, 'Cincinnati'),
  ('NFL', 'bengals', 7, 'Bengals'),
  ('NFL', 'cle', 8, 'CLE'),
  ('NFL', 'clevelandbrowns', 8, 'Cleveland Browns'),
  ('NFL', 'clv', 8, 'CLV'),
  ('NFL', 'cleveland', 8, 'Cleveland'),
  ('NFL', 'browns', 8, 'Browns'),
  ('NFL', 'dal', 9, 'DAL'),
  ('NFL', 'dallascowboys', 9, 'Dallas Cowboys'),
  ('NFL', 'dallas', 9, 'Dallas'),
  ('NFL', 'cowboys', 9, 'Cowboys'),
  ('NFL', 'den', 10, 'DEN'),
  ('NFL', 'denverbroncos', 10, 'Denver Broncos'),
  ('NFL', 'denver', 10, 'Denver'),
  ('NFL', 'broncos', 10, 'Broncos'),
  ('NFL', 'det', 11, 'DET'),
  ('NFL', 'detroitlions', 11, 'Detroit Lions'),
  ('NFL', 'detroit', 11, 'Detroit'),
  ('NFL', 'lions', 11, 'Lions'),
  ('NFL', 'gb', 12, 'GB'),
  ('NFL', 'greenbaypackers', 12, 'Green Bay Packers'),
  ('NFL', 'gnb', 12, 'GNB'),
  ('NFL', 'greenbay', 12, 'Green Bay'),
  ('NFL', 'packers', 12, 'Packers'),
  ('NFL', 'hou', 13, 'HOU'),
  ('NFL', 'houstontexans', 13, 'Houston Texans'),
  ('NFL', 'hst', 13, 'HST'),
  ('NFL', 'houston', 13, 'Houston'),
  ('NFL', 'texans', 13, 'Texans'),
  ('NFL', 'ind', 14, 'IND'),
  ('NFL', 'indianapoliscolts', 14, 'Indianapolis Colts'),
  ('NFL', 'indianapolis', 14, 'Indianapolis'),
  ('NFL', 'colts', 14, 'Colts'),
  ('NFL', 'jax', 15, 'JAX'),
  ('NFL', 'jacksonvillejaguars', 15, 'Jacksonville Jaguars'),
  ('NFL', 'jac', 15, 'JAC'),
  ('NFL', 'jacksonville', 15, 'Jacksonville'),
  ('NFL', 'jaguars', 15, 'Jaguars'),
  ('NFL', 'kc', 16, 'KC'),
  ('NFL', 'kansascitychiefs', 16, 'Kansas City Chiefs'),
  ('NFL', 'kan', 16, 'KAN'),
  ('NFL', 'kcc', 16, 'KCC'),
  ('NFL', 'kansascity', 16, 'Kansas City'),
  ('NFL', 'chiefs', 16, 'Chiefs'),
  ('NFL', 'kcchiefs', 16, 'KC Chiefs'),
  ('NFL', 'lv', 17, 'LV'),
  ('NFL', 'lasvegasraiders', 17, 'Las Vegas Raiders'),
  ('NFL', 'lvr', 17, 'LVR'),
  ('NFL', 'oak', 17, 'OAK'),
  ('NFL', 'lasvegas', 17, 'Las Vegas'),
  ('NFL', 'raiders', 17, 'Raiders'),
  ('NFL', 'oaklandraiders', 17, 'Oakland Raiders'),
  ('NFL', 'lac', 18, 'LAC'),
  ('NFL', 'losangeleschargers', 18, 'Los Angeles Chargers'),
  ('NFL', 'sd', 18, 'SD'),
  ('NFL', 'sdg', 18, 'SDG'),
  ('NFL', 'lachargers', 18, 'LA Chargers'),
  ('NFL', 'chargers', 18, 'Chargers'),
  ('NFL', 'sandiegochargers', 18, 'San Diego Chargers'),
  ('NFL', 'lar', 19, 'LAR'),
  ('NFL', 'losangelesrams', 19, 'Los Angeles Rams'),
  ('NFL', 'la', 19, 'LA'),
  ('NFL', 'stl', 19, 'STL'),
  ('NFL', 'sl', 19, 'SL'),
  ('NFL', 'larams', 19, 'LA Rams'),
  ('NFL', 'rams', 19, 'Rams'),
  ('NFL', 'stlouisrams', 19, 'St. Louis Rams'),
  ('NFL', 'mia', 20, 'MIA'),
  ('NFL', 'miamidolphins', 20, 'Miami Dolphins'),
  ('NFL', 'miami', 20, 'Miami'),
  ('NFL', 'dolphins', 20, 'Dolphins'),
  ('NFL', 'min', 21, 'MIN'),
  ('NFL', 'minnesotavikings', 21, 'Minnesota Vikings'),
  ('NFL', 'minnesota', 21, 'Minnesota'),
  ('NFL', 'vikings', 21, 'Vikings'),
  ('NFL', 'ne', 22, 'NE'),
  ('NFL', 'newenglandpatriots', 22, 'New England Patriots'),
  ('NFL', 'nwe', 22, 'NWE'),
  ('NFL', 'newengland', 22, 'New England'),
  ('NFL', 'patriots', 22, 'Patriots'),
  ('NFL', 'no', 23, 'NO'),
  ('NFL', 'neworleanssaints', 23, 'New Orleans Saints'),
  ('NFL', 'nor', 23, 'NOR'),
  ('NFL', 'nos', 23, 'NOS'),
  ('NFL', 'neworleans', 23, 'New Orleans'),
  ('NFL', 'saints', 23, 'Saints'),
  ('NFL', 'nyg', 24, 'NYG'),
  ('NFL', 'newyorkgiants', 24, 'New York Giants'),
  ('NFL', 'nygiants', 24, 'NY Giants'),
  ('NFL', 'giants', 24, 'Giants'),
  ('NFL', 'nyj', 25, 'NYJ'),
  ('NFL', 'newyorkjets', 25, 'New York Jets'),
  ('NFL', 'nyjets', 25, 'NY Jets'),
  ('NFL', 'jets', 25, 'Jets'),
  ('NFL', 'phi', 26, 'PHI'),
  ('NFL', 'philadelphiaeagles', 26, 'Philadelphia Eagles'),
  ('NFL', 'philadelphia', 26, 'Philadelphia'),
  ('NFL', 'eagles', 26, 'Eagles'),
  ('NFL', 'pit', 27, 'PIT'),
  ('NFL', 'pittsburghsteelers', 27, 'Pittsburgh Steelers'),
  ('NFL', 'pittsburgh', 27, 'Pittsburgh'),
  ('NFL', 'steelers', 27, 'Steelers'),
  ('NFL', 'sf', 28, 'SF'),
  ('NFL', 'sanfrancisco49ers', 28, 'San Francisco 49ers'),
  ('NFL', 'sfo', 28, 'SFO'),
  ('NFL', 'sanfrancisco', 28, 'San Francisco'),
  ('NFL', '49ers', 28, '49ers'),
  ('NFL', 'niners', 28, 'Niners'),
  ('NFL', 'sea', 29, 'SEA'),
  ('NFL', 'seattleseahawks', 29, 'Seattle Seahawks'),
  ('NFL', 'seattle', 29, 'Seattle'),
  ('NFL', 'seahawks', 29, 'Seahawks'),
  ('NFL', 'tb', 30, 'TB'),
  ('NFL', 'tampabaybuccaneers', 30, 'Tampa Bay Buccaneers'),
  ('NFL', 'tam', 30, 'TAM'),
  ('NFL', 'tbb', 30, 'TBB'),
  ('NFL', 'tampabay', 30, 'Tampa Bay'),
  ('NFL', 'buccaneers', 30, 'Buccaneers'),
  ('NFL', 'bucs', 30, 'Bucs'),
  ('NFL', 'ten', 31, 'TEN'),
  ('NFL', 'tennesseetitans', 31, 'Tennessee Titans'),
  ('NFL', 'tennessee', 31, 'Tennessee'),
  ('NFL', 'titans', 31, 'Titans'),
  ('NFL', 'was', 32, 'WAS'),
  ('NFL', 'washingtoncommanders', 32, 'Washington Commanders'),
  ('NFL', 'wsh', 32, 'WSH'),
  ('NFL', 'wft', 32, 'WFT'),
  ('NFL', 'washington', 32, 'Washington'),
  ('NFL', 'commanders', 32, 'Commanders'),
  ('NFL', 'washingtonfootballteam', 32, 'Washington Football Team'),
  ('CFB', 'olemiss', 1, 'Ole Miss'),
  ('CFB', 'mississippi', 1, 'Mississippi'),
  ('CFB', 'miami', 2, 'Miami'),
  ('CFB', 'miamifl', 2, 'Miami (FL)'),
  ('CFB', 'miamiflorida', 2, 'Miami Florida'),
  ('CFB', 'miamioh', 3, 'Miami (OH)'),
  ('CFB', 'miamiohio', 3, 'Miami Ohio'),
  ('CFB', 'miamiuniversity', 3, 'Miami University'),
  ('CFB', 'uconn', 4, 'UConn'),
  ('CFB', 'connecticut', 4, 'Connecticut'),
  ('CFB', 'umass', 5, 'UMass'),
  ('CFB', 'massachusetts', 5, 'Massachusetts'),
  ('CFB', 'usc', 6, 'USC'),
  ('CFB', 'southerncalifornia', 6, 'Southern California'),
  ('CFB', 'southerncal', 6, 'Southern Cal'),
  ('CFB', 'lsu', 7, 'LSU'),
  ('CFB', 'louisianastate', 7, 'Louisiana State'),
  ('CFB', 'smu', 8, 'SMU'),
  ('CFB', 'southernmethodist', 8, 'Southern Methodist'),
  ('CFB', 'tcu', 9, 'TCU'),
  ('CFB', 'texaschristian', 9, 'Texas Christian'),
  ('CFB', 'ucf', 10, 'UCF'),
  ('CFB', 'centralflorida', 10, 'Central Florida'),
  ('CFB', 'unlv', 11, 'UNLV'),
  ('CFB', 'nevadalasvegas', 11, 'Nevada-Las Vegas'),
  ('CFB', 'utep', 12, 'UTEP'),
  ('CFB', 'texaselpaso', 12, 'Texas-El Paso'),
  ('CFB', 'utelpaso', 12, 'UT El Paso'),
  ('CFB', 'utsa', 13, 'UTSA'),
  ('CFB', 'texassanantonio', 13, 'Texas-San Antonio'),
  ('CFB', 'utsanantonio', 13, 'UT San Antonio'),
  ('CFB', 'fiu', 14, 'FIU'),
  ('CFB', 'floridainternational', 14, 'Florida International'),
  ('CFB', 'floridaintl', 14, 'Florida Intl'),
  ('CFB', 'fau', 15, 'FAU'),
  ('CFB', 'floridaatlantic', 15, 'Florida Atlantic'),
  ('CFB', 'byu', 16, 'BYU'),
  ('CFB', 'brighamyoung', 16, 'Brigham Young'),
  ('CFB', 'ncstate', 17, 'NC State'),
  ('CFB', 'northcarolinastate', 17, 'North Carolina State'),
  ('CFB', 'pitt', 18, 'Pitt'),
  ('CFB', 'pittsburgh', 18, 'Pittsburgh'),
  ('CFB', 'appstate', 19, 'App State'),
  ('CFB', 'appalachianstate', 19, 'Appalachian State'),
  ('CFB', 'hawaii', 20, 'Hawaii'),
  ('CFB', 'sanjosestate', 21, 'San Jose State'),
  ('CFB', 'sjsu', 21, 'SJSU'),
  ('CFB', 'ulmonroe', 22, 'UL Monroe'),
  ('CFB', 'louisianamonroe', 22, 'Louisiana-Monroe'),
  ('CFB', 'ulm', 22, 'ULM'),
  ('CFB', 'louisiana', 23, 'Louisiana'),
  ('CFB', 'louisianalafayette', 23, 'Louisiana-Lafayette'),
  ('CFB', 'ullafayette', 23, 'UL Lafayette'),
  ('CFB', 'louisianaragincajuns', 23, 'Louisiana Ragin Cajuns'),
  ('CFB', 'southernmiss', 24, 'Southern Miss'),
  ('CFB', 'southernmississippi', 24, 'Southern Mississippi'),
  ('CFB', 'samhouston', 25, 'Sam Houston'),
  ('CFB', 'samhoustonstate', 25, 'Sam Houston State'),
  ('CFB', 'army', 26, 'Army'),
  ('CFB', 'armywestpoint', 26, 'Army West Point'),
  ('CFB', 'uab', 27, 'UAB'),
  ('CFB', 'alabamabirmingham', 27, 'Alabama-Birmingham'),
  ('CFB', 'middletennessee', 28, 'Middle Tennessee'),
  ('CFB', 'middletennesseestate', 28, 'Middle Tennessee State'),
  ('CFB', 'mtsu', 28, 'MTSU'),
  ('CFB', 'westernkentucky', 29, 'Western Kentucky'),
  ('CFB', 'wku', 29, 'WKU'),
  ('CFB', 'texasam', 30, 'Texas A&M'),
  ('CFB', 'bowlinggreen', 31, 'Bowling Green'),
  ('CFB', 'bowlinggreenstate', 31, 'Bowling Green State'),
  ('CFB', 'bgsu', 31, 'BGSU'),
  ('CFB', 'northernillinois', 32, 'Northern Illinois'),
  ('CFB', 'niu', 32, 'NIU'),
  ('CFB', 'louisianatech', 33, 'Louisiana Tech'),
  ('CFB', 'latech', 33, 'La Tech'),
  ('CFB', 'newmexicostate', 34, 'New Mexico State'),
  ('CFB', 'nmstate', 34, 'NM State'),
  ('CFB', 'jacksonvillestate', 35, 'Jacksonville State'),
  ('CFB', 'jaxstate', 35, 'Jax State'),
  ('CFB', 'georgiasouthern', 36, 'Georgia Southern'),
  ('CFB', 'gasouthern', 36, 'Ga Southern'),
  ('CFB', 'southflorida', 37, 'South Florida'),
  ('CFB', 'usf', 37, 'USF'),
  ('CFB', 'northtexas', 38, 'North Texas'),
  ('CFB', 'unt', 38, 'UNT'),
  ('CFB', 'eastcarolina', 39, 'East Carolina'),
  ('CFB', 'ecu', 39, 'ECU'),
  ('CFB', 'sandiegostate', 40, 'San Diego State'),
  ('CFB', 'sdsu', 40, 'SDSU'),
  ('CFB', 'kansasstate', 41, 'Kansas State'),
  ('CFB', 'kstate', 41, 'K-State'),
  ('CFB', 'floridastate', 42, 'Florida State'),
  ('CFB', 'fsu', 42, 'FSU'),
  ('CFB', 'oklahomastate', 43, 'Oklahoma State'),
  ('CFB', 'okstate', 43, 'OK State'),
  ('CFB', 'bostoncollege', 44, 'Boston College'),
  ('CFB', 'bc', 44, 'BC'),
  ('CFB', 'coastalcarolina', 45, 'Coastal Carolina'),
  ('CFB', 'coastal', 45, 'Coastal'),
  ('CFB', 'centralmichigan', 46, 'Central Michigan'),
  ('CFB', 'centmichigan', 46, 'Cent Michigan'),
  ('CFB', 'cmichigan', 46, 'C Michigan'),
  ('CFB', 'easternmichigan', 47, 'Eastern Michigan'),
  ('CFB', 'emichigan', 47, 'E Michigan'),
  ('CFB', 'westernmichigan', 48, 'Western Michigan'),
  ('CFB', 'wmichigan', 48, 'W Michigan'),
  ('CFB', 'georgiatech', 49, 'Georgia Tech'),
  ('CFB', 'georgiainstituteoftechnology', 49, 'Georgia Institute of Technology'),
  ('CFB', 'kentstate', 50, 'Kent State'),
  ('CFB', 'kent', 50, 'Kent'),
  ('CFB', 'charlotte', 51, 'Charlotte'),
  ('CFB', 'unccharlotte', 51, 'UNC Charlotte'),
  ('CFB', 'southeasternlouisiana', 52, 'Southeastern Louisiana'),
  ('CFB', 'selouisiana', 52, 'SE Louisiana'),
  ('CFB', 'stephenfaustin', 53, 'Stephen F. Austin'),
  ('CFB', 'sfa', 53, 'SFA'),
  ('CFB', 'tennesseemartin', 54, 'Tennessee-Martin'),
  ('CFB', 'utmartin', 54, 'UT Martin'),
  ('CFB', 'tennesseestate', 55, 'Tennessee State'),
  ('CFB', 'tennstate', 55, 'Tenn State'),
  ('CFB', 'prairieviewam', 56, 'Prairie View A&M'),
  ('CFB', 'prairieview', 56, 'Prairie View'),
  ('CFB', 'floridaam', 57, 'Florida A&M'),
  ('CFB', 'famu', 57, 'FAMU'),
  ('CFB', 'northcarolinaat', 58, 'North Carolina A&T'),
  ('CFB', 'ncat', 58, 'NC A&T'),
  ('CFB', 'northcarolinacentral', 59, 'North Carolina Central'),
  ('CFB', 'nccentral', 59, 'NC Central'),
  ('CFB', 'alabamaam', 60, 'Alabama A&M'),
  ('CFB', 'aamu', 60, 'AAMU'),
  ('CFB', 'mississippivalleystate', 61, 'Mississippi Valley State'),
  ('CFB', 'mvsu', 61, 'MVSU'),
  ('CFB', 'missvalleystate', 61, 'Miss Valley State'),
  ('CFB', 'arkansaspinebluff', 62, 'Arkansas-Pine Bluff'),
  ('CFB', 'uapb', 62, 'UAPB'),
  ('CFB', 'texasamcommerce', 63, 'Texas A&M-Commerce'),
  ('CFB', 'easttexasam', 63, 'East Texas A&M'),
  ('CFB', 'houstonchristian', 64, 'Houston Christian'),
  ('CFB', 'houstonbaptist', 64, 'Houston Baptist'),
  ('CFB', 'mcneese', 65, 'McNeese'),
  ('CFB', 'mcneesestate', 65, 'McNeese State'),
  ('CFB', 'nicholls', 66, 'Nicholls'),
  ('CFB', 'nichollsstate', 66, 'Nicholls State'),
  ('CFB', 'grambling', 67, 'Grambling'),
  ('CFB', 'gramblingstate', 67, 'Grambling State'),
  ('CFB', 'longislanduniversity', 68, 'Long Island University'),
  ('CFB', 'liu', 68, 'LIU'),
  ('CFB', 'saintfrancispa', 69, 'Saint Francis (PA)'),
  ('CFB', 'stfrancispa', 69, 'St. Francis (PA)'),
  ('CFB', 'calpoly', 70, 'Cal Poly'),
  ('CFB', 'calpolysanluisobispo', 70, 'Cal Poly San Luis Obispo'),
  ('CFB', 'ucdavis', 71, 'UC Davis'),
  ('CFB', 'californiadavis', 71, 'California-Davis'),
  ('CFB', 'sacramentostate', 72, 'Sacramento State'),
  ('CFB', 'sacstate', 72, 'Sac State'),
  ('CFB', 'southernutah', 73, 'Southern Utah'),
  ('CFB', 'suu', 73, 'SUU'),
  ('CFB', 'utahtech', 74, 'Utah Tech'),
  ('CFB', 'dixiestate', 74, 'Dixie State'),
  ('CFB', 'easternwashington', 75, 'Eastern Washington'),
  ('CFB', 'ewashington', 75, 'E Washington'),
  ('CFB', 'northerncolorado', 76, 'Northern Colorado'),
  ('CFB', 'ncolorado', 76, 'N Colorado'),
  ('CFB', 'northernarizona', 77, 'Northern Arizona'),
  ('CFB', 'narizona', 77, 'N Arizona'),
  ('CFB', 'idahostate', 78, 'Idaho State'),
  ('CFB', 'idahost', 78, 'Idaho St'),
  ('CFB', 'utriograndevalley', 79, 'UT Rio Grande Valley'),
  ('CFB', 'utrgv', 79, 'UTRGV'),
  ('CFB', 'texasriograndevalley', 79, 'Texas-Rio Grande Valley')
on conflict (league, alias_key) do update set group_no = excluded.group_no, alias = excluded.alias;
-- FG2_ALIAS_END

insert into fg2_install_report (step, outcome, detail)
select '2 aliases', 'ok', count(*) || ' alias spellings (' ||
  count(*) filter (where league = 'NFL') || ' NFL, ' || count(*) filter (where league = 'CFB') || ' CFB)'
  from collective.fg2_name_alias;

-- 3 ---- source views, by discovery ----------------------------------------
-- The Collective's tables were built in the dashboard, so their names and
-- columns are read off the catalog here, once, into five views with fixed
-- shapes. Everything below reads only these views.
create or replace function collective.fg2_col(p_rel regclass, p_names text[]) returns text
language sql stable as $fn$
  select a.attname::text
    from pg_attribute a
    join unnest(p_names) with ordinality as n(name, ord) on n.name = a.attname::text
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped
   order by n.ord limit 1
$fn$;

do $do$
declare
  g regclass := to_regclass('collective.games');
  d regclass := to_regclass('collective.game_detail');
  r regclass;
  rname text;
  c_sport text; c_home_id text; c_away_id text; c_ref text; c_created text; c_status text;
  c_home_lbl text; c_away_lbl text;
  sql text;
begin
  if g is null then
    raise exception 'collective.games does not exist - is this the Collective project?';
  end if;
  c_sport   := collective.fg2_col(g, array['sport_code', 'sport']);
  c_home_id := collective.fg2_col(g, array['home_team_id', 'home_id']);
  c_away_id := collective.fg2_col(g, array['away_team_id', 'away_id']);
  c_ref     := collective.fg2_col(g, array['external_ref', 'provider_ref', 'espn_id']);
  c_created := collective.fg2_col(g, array['created_at', 'inserted_at']);
  c_status  := collective.fg2_col(g, array['status']);
  c_home_lbl := collective.fg2_col(g, array['home_team', 'home']);
  c_away_lbl := collective.fg2_col(g, array['away_team', 'away']);
  if c_sport is null then raise exception 'collective.games has no sport_code/sport column'; end if;
  if d is not null then
    sql := format($v$
      create or replace view collective.fg2_src_games as
      select x.id::text as game_id, x.%1$I::text as sport, x.season::int as season, x.week::int as week,
             x.kickoff_at, coalesce(%2$s, dd.status::text) as status,
             %3$s as home_team_id, %4$s as away_team_id,
             dd.home::text as home_label, dd.away::text as away_label,
             %5$s as external_ref,
             dd.home_score::numeric as home_score, dd.away_score::numeric as away_score,
             dd.closing_spread::numeric as legacy_close_spread, dd.closing_total::numeric as legacy_close_total,
             %6$s as created_at
        from collective.games x
        left join collective.game_detail dd on dd.game_id::text = x.id::text
    $v$, c_sport,
      case when c_status is null then 'null::text' else 'x.' || quote_ident(c_status) || '::text' end,
      case when c_home_id is null then 'null::text' else 'x.' || quote_ident(c_home_id) || '::text' end,
      case when c_away_id is null then 'null::text' else 'x.' || quote_ident(c_away_id) || '::text' end,
      case when c_ref is null then 'null::text' else 'x.' || quote_ident(c_ref) || '::text' end,
      case when c_created is null then 'null::timestamptz' else 'x.' || quote_ident(c_created) end);
  else
    -- no game_detail: scores and the close from whichever results relation holds them
    r := coalesce(to_regclass('collective.results'), to_regclass('collective.game_results'));
    sql := format($v$
      create or replace view collective.fg2_src_games as
      select x.id::text as game_id, x.%1$I::text as sport, x.season::int as season, x.week::int as week,
             x.kickoff_at, %2$s as status, %3$s as home_team_id, %4$s as away_team_id,
             %7$s as home_label, %8$s as away_label, %5$s as external_ref,
             %9$s, %6$s as created_at
        from collective.games x %10$s
    $v$, c_sport,
      case when c_status is null then 'null::text' else 'x.' || quote_ident(c_status) || '::text' end,
      case when c_home_id is null then 'null::text' else 'x.' || quote_ident(c_home_id) || '::text' end,
      case when c_away_id is null then 'null::text' else 'x.' || quote_ident(c_away_id) || '::text' end,
      case when c_ref is null then 'null::text' else 'x.' || quote_ident(c_ref) || '::text' end,
      case when c_created is null then 'null::timestamptz' else 'x.' || quote_ident(c_created) end,
      case when c_home_lbl is null then 'null::text' else 'x.' || quote_ident(c_home_lbl) || '::text' end,
      case when c_away_lbl is null then 'null::text' else 'x.' || quote_ident(c_away_lbl) || '::text' end,
      case when r is null then 'null::numeric as home_score, null::numeric as away_score, null::numeric as legacy_close_spread, null::numeric as legacy_close_total'
           else 'rr.home_score::numeric as home_score, rr.away_score::numeric as away_score, rr.closing_spread::numeric as legacy_close_spread, rr.closing_total::numeric as legacy_close_total' end,
      case when r is null then '' else 'left join ' || r::text || ' rr on rr.game_id::text = x.id::text' end);
  end if;
  execute sql;
  insert into fg2_install_report (step, outcome, detail) values ('3 fg2_src_games', 'ok',
    'from collective.games' || case when d is not null then ' + game_detail' else ' + ' || coalesce(r::text, 'no results relation') end ||
    '; team ids: ' || coalesce(c_home_id, 'NONE') || '; provider ref: ' || coalesce(c_ref, 'none'));
end $do$;

do $do$
declare
  p regclass := to_regclass('collective.projections');
  c_side text; c_spread text; c_ph text; c_pa text; c_prob text; c_origin text; c_status text;
  c_late text; c_cand text; c_recv text;
  e text;
begin
  if p is null then raise exception 'collective.projections does not exist'; end if;
  c_side   := collective.fg2_col(p, array['pick_side', 'side']);
  c_spread := collective.fg2_col(p, array['projected_spread', 'spread', 'fair_spread']);
  c_ph     := collective.fg2_col(p, array['proj_home_score', 'projected_home_score', 'home_score_proj']);
  c_pa     := collective.fg2_col(p, array['proj_away_score', 'projected_away_score', 'away_score_proj']);
  c_prob   := collective.fg2_col(p, array['home_win_prob', 'home_win_probability', 'home_ml_prob', 'win_probability']);
  c_origin := collective.fg2_col(p, array['data_origin']);
  c_status := collective.fg2_col(p, array['resolution_status']);
  c_late   := collective.fg2_col(p, array['is_late']);
  c_cand   := collective.fg2_col(p, array['is_graded_candidate']);
  c_recv   := collective.fg2_col(p, array['received_at', 'submitted_at', 'created_at']);
  if c_recv is null then raise exception 'collective.projections has no received_at'; end if;
  e := format($v$
    create or replace view collective.fg2_src_predictions as
    select p.id::text as prediction_id, p.model_id::text as model_id, p.game_id::text as game_id,
           p.%1$I as received_at,
           %2$s as data_origin, %3$s as resolution_status, %4$s as is_late, %5$s as is_graded_candidate,
           %6$s as pick_side, %7$s as projected_spread, %8$s as proj_home_score, %9$s as proj_away_score,
           %10$s as home_win_prob
      from collective.projections p
     where p.game_id is not null
  $v$, c_recv,
    coalesce('p.' || quote_ident(c_origin) || '::text', 'null::text'),
    coalesce('p.' || quote_ident(c_status) || '::text', 'null::text'),
    coalesce('p.' || quote_ident(c_late) || '::boolean', 'null::boolean'),
    coalesce('p.' || quote_ident(c_cand) || '::boolean', 'null::boolean'),
    coalesce('p.' || quote_ident(c_side) || '::text', 'null::text'),
    coalesce('p.' || quote_ident(c_spread) || '::numeric', 'null::numeric'),
    coalesce('p.' || quote_ident(c_ph) || '::numeric', 'null::numeric'),
    coalesce('p.' || quote_ident(c_pa) || '::numeric', 'null::numeric'),
    coalesce('p.' || quote_ident(c_prob) || '::numeric', 'null::numeric'));
  execute e;
  insert into fg2_install_report (step, outcome, detail) values ('3 fg2_src_predictions', 'ok',
    'side ' || coalesce(c_side, 'NONE') || ', spread ' || coalesce(c_spread, 'NONE') || ', scores ' ||
    coalesce(c_ph, 'NONE') || '/' || coalesce(c_pa, 'NONE') || ', probability ' || coalesce(c_prob, 'NONE') ||
    ', timestamp ' || c_recv);
end $do$;

do $do$
declare
  t regclass := to_regclass('collective.teams');
  a regclass := to_regclass('collective.team_aliases');
  c_sport text; c_code text; c_name text; a_sport text; a_alias text; a_team text; a_code text;
begin
  if t is null then
    execute 'create or replace view collective.fg2_src_teams as
      select null::text as team_id, null::text as sport, null::text as code, null::text as name where false';
    insert into fg2_install_report (step, outcome, detail) values ('3 fg2_src_teams', 'WARNING', 'no collective.teams: team resolution will find nothing');
  else
    c_sport := collective.fg2_col(t, array['sport_code', 'sport']);
    c_code := collective.fg2_col(t, array['code', 'abbreviation', 'short_code']);
    c_name := collective.fg2_col(t, array['name', 'full_name', 'display_name']);
    execute format('create or replace view collective.fg2_src_teams as
      select t.id::text as team_id, %s as sport, %s as code, %s as name from collective.teams t',
      coalesce('t.' || quote_ident(c_sport) || '::text', 'null::text'),
      coalesce('t.' || quote_ident(c_code) || '::text', 'null::text'),
      coalesce('t.' || quote_ident(c_name) || '::text', 'null::text'));
    insert into fg2_install_report (step, outcome, detail) values ('3 fg2_src_teams', 'ok',
      'code ' || coalesce(c_code, 'NONE') || ', name ' || coalesce(c_name, 'NONE'));
  end if;
  if a is not null then
    a_sport := collective.fg2_col(a, array['sport_code', 'sport']);
    a_alias := collective.fg2_col(a, array['alias', 'name']);
    a_team := collective.fg2_col(a, array['team_id']);
    a_code := collective.fg2_col(a, array['team_code', 'code']);
  end if;
  if a is null or a_alias is null or (a_team is null and (a_code is null or t is null)) then
    execute 'create or replace view collective.fg2_src_team_aliases as
      select null::text as sport, null::text as alias, null::text as team_id where false';
  elsif a_team is not null then
    execute format('create or replace view collective.fg2_src_team_aliases as
      select %s as sport, a.%I::text as alias, a.%I::text as team_id from collective.team_aliases a',
      coalesce('a.' || quote_ident(a_sport) || '::text', 'null::text'), a_alias, a_team);
  else
    execute format('create or replace view collective.fg2_src_team_aliases as
      select %s as sport, a.%I::text as alias, t.id::text as team_id
        from collective.team_aliases a join collective.teams t on t.%I::text = a.%I::text %s',
      coalesce('a.' || quote_ident(a_sport) || '::text', 'null::text'), a_alias,
      c_code, a_code,
      case when a_sport is not null and c_sport is not null then format('and t.%I::text = a.%I::text', c_sport, a_sport) else '' end);
  end if;
end $do$;

-- The grade the Collective served BEFORE this repair, per projection: the
-- "old state" of every audit row.
do $do$
declare
  gr regclass := to_regclass('collective.grades');
  pg regclass := to_regclass('collective.projection_grades');
  pr regclass := to_regclass('collective.projections');
  c_pid text; c_res text; c_me text; c_br text;
begin
  if gr is not null and collective.fg2_col(gr, array['projection_id']) is not null then
    c_res := collective.fg2_col(gr, array['pick_result', 'ats_result', 'result']);
    c_me := collective.fg2_col(gr, array['margin_error']);
    c_br := collective.fg2_col(gr, array['brier']);
    execute format('create or replace view collective.fg2_src_legacy_grades as
      select g.projection_id::text as prediction_id, %s as pick_result, %s as margin_error, %s as brier from collective.grades g',
      coalesce('g.' || quote_ident(c_res) || '::text', 'null::text'), coalesce('g.' || quote_ident(c_me) || '::numeric', 'null::numeric'),
      coalesce('g.' || quote_ident(c_br) || '::numeric', 'null::numeric'));
  elsif collective.fg2_col(pr, array['pick_result']) is not null then
    c_me := collective.fg2_col(pr, array['margin_error']);
    c_br := collective.fg2_col(pr, array['brier']);
    execute format('create or replace view collective.fg2_src_legacy_grades as
      select p.id::text as prediction_id, p.pick_result::text as pick_result, %s as margin_error, %s as brier from collective.projections p',
      coalesce('p.' || quote_ident(c_me) || '::numeric', 'null::numeric'), coalesce('p.' || quote_ident(c_br) || '::numeric', 'null::numeric'));
  elsif pg is not null then
    c_res := collective.fg2_col(pg, array['pick_result', 'ats_result', 'result']);
    execute format('create or replace view collective.fg2_src_legacy_grades as
      select g.projection_id::text as prediction_id, %s as pick_result, null::numeric as margin_error, null::numeric as brier from collective.projection_grades g',
      coalesce('g.' || quote_ident(c_res) || '::text', 'null::text'));
  else
    execute 'create or replace view collective.fg2_src_legacy_grades as
      select null::text as prediction_id, null::text as pick_result, null::numeric as margin_error, null::numeric as brier where false';
  end if;
end $do$;

-- The views above key every row by id::text, so every per-game lookup
-- (a game, its predictions, a prediction's legacy grade) filters on a cast
-- the tables' own indexes cannot serve: without these, settling ONE game
-- scans collective.projections once per model. Indexes on exactly those
-- expressions let the planner use them. Additive only; each is reported.
do $do$
declare
  r record;
  gr regclass := to_regclass('collective.grades');
  pg regclass := to_regclass('collective.projection_grades');
begin
  for r in
    select * from (values
      ('fg2_games_id_text_idx', 'collective.games'::regclass, 'id'),
      ('fg2_projections_game_text_idx', to_regclass('collective.projections'), 'game_id'),
      ('fg2_projections_id_text_idx', to_regclass('collective.projections'), 'id'),
      ('fg2_grades_projection_text_idx', gr, 'projection_id'),
      ('fg2_projection_grades_projection_text_idx', pg, 'projection_id')) v(name, rel, col)
     where v.rel is not null and collective.fg2_col(v.rel, array[v.col]) is not null
  loop
    begin
      execute format('create index if not exists %I on %s ((%I::text))', r.name, r.rel, r.col);
      insert into fg2_install_report (step, outcome, detail) values ('3 lookup index', 'ok', r.rel::text || ' (' || r.col || '::text)');
    exception when others then
      insert into fg2_install_report (step, outcome, detail) values ('3 lookup index', 'NOT CREATED',
        r.rel::text || ' (' || r.col || '::text): ' || sqlerrm || ' - per-game lookups fall back to scans');
    end;
  end loop;
end $do$;

-- 4 ---- the canonical tables ----------------------------------------------
create table if not exists collective.fg2_team_registry (
  league  text not null,
  team_id text not null,
  name    text,
  code    text,
  legacy  boolean not null,
  primary key (league, team_id)
);
create table if not exists collective.fg2_team_keys (
  league  text not null,
  key     text not null,
  team_id text not null,
  kind    text not null,
  primary key (league, key, team_id)
);
comment on table collective.fg2_team_keys is
  'The canonical team alias layer: every spelling that resolves to a team (full name, St->State, operator alias, alias-group spelling, an untruncated legacy code).';

create table if not exists collective.fg2_game_alias (
  game_id           text primary key,
  canonical_game_id text not null,
  reason            text not null,
  detected_at       timestamptz not null default now()
);
comment on table collective.fg2_game_alias is
  'A second collective.games row for a fixture that already has one, and the canonical game its predictions and prices are read under. Nothing is deleted.';

create table if not exists collective.fg2_market_events (
  source           text not null,
  source_event_id  text not null,
  league           text not null,
  season           integer,
  provider_ref     text,
  home_name        text,
  away_name        text,
  kickoff_at       timestamptz,
  existing_game_id text,
  raw              jsonb,
  imported_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (source, source_event_id)
);
-- linking reads each event's same-source neighbours inside the kickoff window
create index if not exists fg2_market_events_scope_idx on collective.fg2_market_events (league, source, kickoff_at);

create table if not exists collective.fg2_event_links (
  source            text not null,
  source_event_id   text not null,
  status            text not null check (status in ('linked', 'unresolved', 'conflict')),
  canonical_game_id text,
  matched_game_id   text,
  orientation       text,
  method            text,
  reason            text,
  home_team_id      text,
  away_team_id      text,
  home_method       text,
  away_method       text,
  kickoff_at        timestamptz,
  linked_at         timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (source, source_event_id)
);
create index if not exists fg2_event_links_game_idx on collective.fg2_event_links (canonical_game_id);
comment on table collective.fg2_event_links is
  'Each market event resolved to ONE canonical game, or the reason it could not be. An unresolved identity is logged here, never dropped.';

create table if not exists collective.fg2_market_snapshots (
  source             text not null,
  source_snapshot_id text not null,
  source_event_id    text,
  canonical_game_id  text,
  book               text,
  market_type        text not null default 'spread',
  home_line          numeric,
  away_line          numeric,
  observed_at        timestamptz,
  event_kickoff_at   timestamptz,
  raw                jsonb,
  imported_at        timestamptz not null default now(),
  primary key (source, source_snapshot_id)
);
create index if not exists fg2_market_snapshots_event_idx on collective.fg2_market_snapshots (source, source_event_id);
create index if not exists fg2_market_snapshots_game_idx on collective.fg2_market_snapshots (canonical_game_id);
comment on table collective.fg2_market_snapshots is
  'Every captured price the Collective can find in its own database, copied once with its provenance. home_line is stated for the SOURCE''s home team; the link orientation turns it to the canonical game''s home team. Rows are never changed after import (the legacy close mirror excepted, which follows its source column).';

create table if not exists collective.fg2_official_closes (
  canonical_game_id  text not null,
  market_type        text not null default 'spread',
  home_spread        numeric,
  away_spread        numeric,
  book               text,
  source             text,
  source_event_id    text,
  source_snapshot_id text,
  observed_at        timestamptz,
  kickoff_at         timestamptz,
  lead_minutes       numeric,
  timed              boolean,
  close_status       text not null,
  close_class        text,
  close_class_reason text,
  considered         integer,
  rejected           jsonb,
  legacy_close       numeric,
  grading_version    text not null,
  computed_at        timestamptz not null default now(),
  primary key (canonical_game_id, market_type)
);
comment on table collective.fg2_official_closes is
  'ONE captured close per game and market: the final valid pregame snapshot, never an in-game price, never invented. close_class is the A-L diagnosis of why the legacy pipeline did or did not have it.';

create table if not exists collective.fg2_results_writes (
  game_id        text primary key,
  closing_spread numeric not null,
  written_at     timestamptz not null default now(),
  run_id         uuid
);
comment on table collective.fg2_results_writes is
  'Closes this repair wrote into an EMPTY results.closing_spread, so the next rebuild never mistakes its own write for the legacy close.';

create table if not exists collective.fg2_settlements (
  model_id               text not null,
  canonical_game_id      text not null,
  grading_version        text not null,
  prediction_id          text,
  sport                  text,
  season                 integer,
  week                   integer,
  prediction_version     integer,
  prediction_versions    integer,
  post_lock_versions     integer,
  prediction_status      text,
  submitted_at           timestamptz,
  kickoff_at             timestamptz,
  lock_at                timestamptz,
  fair_home_spread       numeric,
  predicted_home_margin  numeric,
  explicit_side          text,
  ats_side               text,
  ats_side_source        text,
  model_edge_home        numeric,
  close_home_spread      numeric,
  close_away_spread      numeric,
  close_observed_at      timestamptz,
  close_book             text,
  close_source           text,
  close_snapshot_id      text,
  close_source_event_id  text,
  game_state             text,
  home_score             numeric,
  away_score             numeric,
  actual_margin          numeric,
  ats_margin_home        numeric,
  cover                  text,
  ats_result             text check (ats_result in ('win', 'loss', 'push')),
  ats_exclusion          text,
  margin_error           numeric,
  mae_exclusion          text,
  home_win_prob          numeric,
  outcome                integer,
  brier                  numeric,
  brier_exclusion        text,
  settled_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  run_id                 uuid,
  primary key (model_id, canonical_game_id, grading_version)
);
create unique index if not exists fg2_settlements_prediction_uidx
  on collective.fg2_settlements (prediction_id, canonical_game_id, grading_version) where prediction_id is not null;
create index if not exists fg2_settlements_scope_idx on collective.fg2_settlements (sport, season, grading_version);
comment on table collective.fg2_settlements is
  'THE settlement: one row per model per canonical game per grading version, with the whole grading trace and a named reason for every metric that is not graded. Records, rankings, consensus and calibration are views over this table.';

create table if not exists collective.fg2_grade_audit (
  id                 bigserial primary key,
  run_id             uuid,
  model_id           text,
  canonical_game_id  text,
  prediction_id      text,
  grading_version    text,
  old_state          jsonb,
  new_state          jsonb,
  reason             text not null,
  source_snapshot_id text,
  repaired_at        timestamptz not null default now()
);
create index if not exists fg2_grade_audit_game_idx on collective.fg2_grade_audit (canonical_game_id, model_id);

create table if not exists collective.fg2_rebuild_runs (
  run_id      uuid primary key,
  sport       text,
  season      integer,
  committed   boolean not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  report      jsonb
);

do $do$
declare t text;
begin
  foreach t in array array['fg2_config','fg2_name_alias','fg2_team_registry','fg2_team_keys','fg2_game_alias',
    'fg2_market_events','fg2_event_links','fg2_market_snapshots','fg2_official_closes','fg2_results_writes',
    'fg2_settlements','fg2_grade_audit','fg2_rebuild_runs'] loop
    execute format('alter table collective.%I enable row level security', t);
    begin execute format('grant select, insert, update, delete on collective.%I to service_role', t);
    exception when undefined_object then null; end;
    begin execute format('revoke all on collective.%I from anon, authenticated', t);
    exception when undefined_object then null; end;
  end loop;
end $do$;

do $do$ begin
  grant usage, select on sequence collective.fg2_grade_audit_id_seq to service_role;
exception when undefined_object then null; end $do$;

insert into fg2_install_report (step, outcome, detail) values
  ('4 tables', 'ok', 'fg2 identity, market, close, settlement and audit tables in place; RLS on, no anon/authenticated grants');

-- 5 ---- the team registry and resolver -------------------------------------
create or replace function collective.fg2_build_registry(p_league text) returns jsonb
language plpgsql as $fn$
declare n_t int; n_k int;
begin
  delete from collective.fg2_team_keys where league = p_league;
  delete from collective.fg2_team_registry where league = p_league;
  insert into collective.fg2_team_registry (league, team_id, name, code, legacy)
  select p_league, t.team_id, t.name, c.code,
         (t.name is null or t.name = '' or t.name = t.code or (t.name ~ '^[A-Z0-9]+$' and t.name = c.code))
    from collective.fg2_src_teams t,
         lateral (select upper(coalesce(nullif(t.code, ''), collective.fg2_team_code(t.name))) as code) c
   where collective.fg2_league(t.sport) = p_league and t.team_id is not null
  on conflict do nothing;
  -- full names, and their St -> State spelling
  insert into collective.fg2_team_keys (league, key, team_id, kind)
  select p_league, v.k, r.team_id, 'name'
    from collective.fg2_team_registry r,
         lateral (values (collective.fg2_team_key(r.name)), (collective.fg2_team_key(collective.fg2_expand_state(r.name)))) v(k)
   where r.league = p_league and not r.legacy and v.k <> ''
  on conflict do nothing;
  -- operator aliases
  insert into collective.fg2_team_keys (league, key, team_id, kind)
  select p_league, v.k, r.team_id, 'alias'
    from collective.fg2_src_team_aliases a
    join collective.fg2_team_registry r on r.league = p_league and r.team_id = a.team_id,
         lateral (values (collective.fg2_team_key(a.alias)), (collective.fg2_team_key(collective.fg2_expand_state(a.alias)))) v(k)
   where v.k <> ''
  on conflict do nothing;
  -- a legacy code shorter than the ten-character cut was never cut
  insert into collective.fg2_team_keys (league, key, team_id, kind)
  select p_league, lower(r.code), r.team_id, 'legacy_code'
    from collective.fg2_team_registry r
   where r.league = p_league and r.legacy and length(r.code) between 1 and 9
  on conflict do nothing;
  -- every other spelling of an alias group reaches the one team holding a member of it
  with owners as (
    select a.group_no, array_agg(distinct k.team_id) as ids
      from collective.fg2_name_alias a
      join collective.fg2_team_keys k on k.league = a.league and k.key = a.alias_key
     where a.league = p_league
     group by a.group_no
  )
  insert into collective.fg2_team_keys (league, key, team_id, kind)
  select p_league, a.alias_key, o.ids[1], 'alias_group'
    from collective.fg2_name_alias a
    join owners o on o.group_no = a.group_no
   where a.league = p_league and cardinality(o.ids) = 1
     and not exists (select 1 from collective.fg2_team_keys k where k.league = p_league and k.key = a.alias_key)
  on conflict do nothing;
  select count(*) into n_t from collective.fg2_team_registry where league = p_league;
  select count(*) into n_k from collective.fg2_team_keys where league = p_league;
  return jsonb_build_object('teams', n_t, 'keys', n_k);
end $fn$;

create or replace function collective.fg2_keys_lookup(p_league text, p_k text, p_k2 text) returns text[]
language sql stable as $fn$
  select coalesce(
    (select array_agg(distinct team_id order by team_id) from collective.fg2_team_keys where league = p_league and key = p_k),
    (select array_agg(distinct team_id order by team_id) from collective.fg2_team_keys where league = p_league and key = p_k2))
$fn$;

create or replace function collective.fg2_resolve_team(p_league text, p_name text, p_universe text[] default null,
  out team_id text, out method text, out reason text, out candidates text[])
language plpgsql stable as $fn$
declare
  k text := collective.fg2_team_key(p_name);
  ids text[];
  pres text[];
  s text; c text; own text;
  rival boolean;
begin
  if p_name is null or btrim(p_name) = '' then reason := 'empty'; candidates := '{}'; return; end if;
  ids := collective.fg2_keys_lookup(p_league, k, collective.fg2_team_key(collective.fg2_expand_state(p_name)));
  if ids is not null then
    if cardinality(ids) = 1 then team_id := ids[1]; method := 'name'; return; end if;
    reason := 'ambiguous_name'; candidates := ids; return;
  end if;
  pres := collective.fg2_prefixes(p_name);
  foreach s in array pres loop
    ids := collective.fg2_keys_lookup(p_league, collective.fg2_team_key(s), collective.fg2_team_key(collective.fg2_expand_state(s)));
    if ids is not null then
      if cardinality(ids) = 1 then team_id := ids[1]; method := 'mascot'; return; end if;
      reason := 'ambiguous_name'; candidates := ids; return;
    end if;
  end loop;
  foreach s in array (array[p_name] || pres) loop
    foreach c in array collective.fg2_codes_of(s) loop
      continue when c is null or c = '';
      select array_agg(r.team_id order by r.team_id) into ids
        from collective.fg2_team_registry r where r.league = p_league and r.legacy and r.code = c;
      if ids is not null and cardinality(ids) > 1 then reason := 'ambiguous_code'; candidates := ids; return; end if;
      continue when ids is null;
      if length(c) < 10 then team_id := ids[1]; method := 'code'; return; end if;
      own := collective.fg2_team_key(s);
      select exists (
        select 1 from unnest(coalesce(p_universe, '{}'::text[])) u
         where collective.fg2_team_key(u) <> k
           and exists (select 1 from unnest(array[u] || collective.fg2_prefixes(u)) x
                        where c = any(collective.fg2_codes_of(x)) and collective.fg2_team_key(x) <> own)) into rival;
      if rival then reason := 'ambiguous_code'; candidates := ids; return; end if;
      team_id := ids[1]; method := 'code_truncated'; return;
    end loop;
  end loop;
  if length(k) = 10 then
    select array_agg(r.team_id order by r.team_id) into ids
      from collective.fg2_team_registry r
     where r.league = p_league and not r.legacy and r.name is not null and left(collective.fg2_team_key(r.name), 10) = k;
    if ids is not null and cardinality(ids) = 1 then team_id := ids[1]; method := 'truncation'; return; end if;
    if ids is not null then reason := 'ambiguous_truncation'; candidates := ids; return; end if;
  end if;
  reason := 'unresolved'; candidates := '{}';
end $fn$;

-- One market event to one canonical game: provider id, then both teams and
-- the kickoff window in either orientation, then one side exact.
create or replace function collective.fg2_match_event(p_league text, p_season integer, p_provider_ref text,
  p_home text, p_away text, p_kickoff timestamptz, p_universe text[], p_tol_minutes numeric,
  out game_id text, out method text, out orientation text, out reason text,
  out home_team_id text, out away_team_id text, out home_method text, out away_method text)
language plpgsql stable as $fn$
declare
  ids text[];
  h record; a record;
  same_n text[]; swap_n text[]; same_all int; swap_all int;
  strong text; sid text; wc text[];
begin
  if p_provider_ref is not null and p_provider_ref <> '' then
    select array_agg(g.game_id order by g.game_id) into ids
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league
       and (p_season is null or g.season is null or g.season = p_season)
       and g.external_ref is not null
       and (g.external_ref = p_provider_ref or g.external_ref = 'espn:' || p_provider_ref
            or regexp_replace(g.external_ref, '^[a-z]+:', '') = regexp_replace(p_provider_ref, '^[a-z]+:', ''));
    if ids is not null and cardinality(ids) = 1 then
      game_id := ids[1]; method := 'provider_id'; orientation := 'same'; return;
    end if;
    if ids is not null then reason := 'duplicate_provider_ref'; return; end if;
  end if;
  select * into h from collective.fg2_resolve_team(p_league, p_home, p_universe);
  select * into a from collective.fg2_resolve_team(p_league, p_away, p_universe);
  home_team_id := h.team_id; away_team_id := a.team_id;
  home_method := coalesce(h.method, h.reason); away_method := coalesce(a.method, a.reason);
  if h.team_id is not null and a.team_id is not null and h.team_id = a.team_id then
    reason := 'both_sides_same_team'; return;
  end if;
  if h.team_id is not null and a.team_id is not null then
    select array_agg(g.game_id order by g.game_id) filter (where p_kickoff is not null and abs(extract(epoch from (g.kickoff_at - p_kickoff))) <= p_tol_minutes * 60),
           count(*)
      into same_n, same_all
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league and (p_season is null or g.season is null or g.season = p_season)
       and g.home_team_id = h.team_id and g.away_team_id = a.team_id
       and not exists (select 1 from collective.fg2_game_alias x where x.game_id = g.game_id);
    select array_agg(g.game_id order by g.game_id) filter (where p_kickoff is not null and abs(extract(epoch from (g.kickoff_at - p_kickoff))) <= p_tol_minutes * 60),
           count(*)
      into swap_n, swap_all
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league and (p_season is null or g.season is null or g.season = p_season)
       and g.home_team_id = a.team_id and g.away_team_id = h.team_id
       and not exists (select 1 from collective.fg2_game_alias x where x.game_id = g.game_id);
    if coalesce(cardinality(same_n), 0) = 1 and coalesce(cardinality(swap_n), 0) = 0 then
      game_id := same_n[1]; method := 'teams_kickoff'; orientation := 'same'; return;
    end if;
    if coalesce(cardinality(swap_n), 0) = 1 and coalesce(cardinality(same_n), 0) = 0 then
      game_id := swap_n[1]; method := 'teams_kickoff_swapped'; orientation := 'swapped'; return;
    end if;
    if coalesce(cardinality(same_n), 0) + coalesce(cardinality(swap_n), 0) > 1 then reason := 'ambiguous_games'; return; end if;
    if same_all + swap_all > 0 then reason := 'kickoff_out_of_tolerance'; return; end if;
    reason := 'no_game_for_teams'; return;
  end if;
  strong := case when h.team_id is not null then 'home' when a.team_id is not null then 'away' end;
  if strong is not null then
    sid := case when strong = 'home' then h.team_id else a.team_id end;
    wc := coalesce(case when strong = 'home' then a.candidates else h.candidates end, '{}'::text[]);
    select array_agg(g.game_id order by g.game_id) into ids
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league and (p_season is null or g.season is null or g.season = p_season)
       and p_kickoff is not null and abs(extract(epoch from (g.kickoff_at - p_kickoff))) <= p_tol_minutes * 60
       and (case when strong = 'home' then g.home_team_id else g.away_team_id end) = sid
       and (case when strong = 'home' then g.away_team_id else g.home_team_id end) = any(wc)
       and not exists (select 1 from collective.fg2_game_alias x where x.game_id = g.game_id);
    if ids is not null and cardinality(ids) = 1 then
      game_id := ids[1]; method := 'one_side_exact'; orientation := 'same'; return;
    end if;
  end if;
  reason := case when h.team_id is null then 'home_team_' || h.reason else 'away_team_' || a.reason end;
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('5 identity', 'ok', 'fg2_build_registry / fg2_resolve_team / fg2_match_event');

-- 6 ---- market sources: events and snapshots, copied with provenance --------
-- Every adapter WRITES ONLY fg2_market_events and fg2_market_snapshots, and
-- only ever adds a snapshot (on conflict do nothing): captured history is
-- copied, never edited.
create or replace function collective.fg2_season_bounds(p_season integer, out lo timestamptz, out hi timestamptz)
language sql immutable as $fn$
  select make_timestamptz(p_season, 7, 1, 0, 0, 0, 'UTC'), make_timestamptz(p_season + 1, 3, 1, 0, 0, 0, 'UTC')
$fn$;

-- the legacy close: whatever results.closing_spread already held (and this
-- repair did not write itself), as an untimed source
create or replace function collective.fg2_import_legacy(p_league text, p_season integer) returns jsonb
language plpgsql as $fn$
declare n_new int := 0; n_upd int := 0;
begin
  with src as (
    select g.game_id, g.kickoff_at, g.legacy_close_spread, g.legacy_close_total
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league and g.season = p_season and g.legacy_close_spread is not null
       and not exists (select 1 from collective.fg2_results_writes w
                        where w.game_id = g.game_id and w.closing_spread = g.legacy_close_spread)
  ), ins as (
    insert into collective.fg2_market_snapshots (source, source_snapshot_id, source_event_id, canonical_game_id,
      book, market_type, home_line, observed_at, event_kickoff_at, raw)
    select 'legacy_results_close', s.game_id, s.game_id, s.game_id, 'collective', 'spread', s.legacy_close_spread,
           null, s.kickoff_at, jsonb_build_object('closing_total', s.legacy_close_total)
      from src s
    on conflict (source, source_snapshot_id) do update
      set home_line = excluded.home_line, raw = excluded.raw, event_kickoff_at = excluded.event_kickoff_at
      where collective.fg2_market_snapshots.home_line is distinct from excluded.home_line
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into n_new, n_upd from ins;
  return jsonb_build_object('source', 'legacy_results_close', 'new', n_new, 'updated', n_upd);
end $fn$;

-- Revision 2 gave the importers and the linker a kickoff lower bound (the
-- hourly refresh); the old signatures go first so no call is ambiguous.
drop function if exists collective.fg2_import_relation(jsonb, text, integer);
drop function if exists collective.fg2_import_collective_odds(text, integer);
drop function if exists collective.fg2_import_edgedesk_capture(text, integer);
drop function if exists collective.fg2_import_snapshots(text, integer);
drop function if exists collective.fg2_link_events(text, integer);

-- The kickoff range an import reads: the season, cut at p_from when a
-- refresh only needs recent games.
create or replace function collective.fg2_import_range(p_season integer, p_from timestamptz, out lo timestamptz, out hi timestamptz)
language sql stable as $fn$
  select greatest((collective.fg2_season_bounds(p_season)).lo, coalesce(p_from, '-infinity'::timestamptz)),
         (collective.fg2_season_bounds(p_season)).hi
$fn$;

-- One declared snapshot relation into the canonical store. spec keys:
-- relation, source, event_col, time_col, line_col, line_kind (home|away|side),
-- side_col, market_col, book_col, id_col, events (the events relation spec).
-- Timed rows are copied from [kickoff - (window + margin), kickoff + margin]
-- of their own event: nothing earlier can be a close, and the margin keeps
-- the rows a close class is read from. A declared close relation is untimed
-- and copied whole.
create or replace function collective.fg2_import_relation(p_spec jsonb, p_league text, p_season integer,
  p_from timestamptz default null) returns jsonb
language plpgsql as $fn$
declare
  rel regclass := to_regclass(p_spec->>'relation');
  ev jsonb := p_spec->'events';
  erel regclass := to_regclass(ev->>'relation');
  lo_ts timestamptz; hi_ts timestamptz;
  before_min numeric := collective.fg2_window_minutes(p_league) + collective.fg2_import_margin_minutes();
  after_min numeric := collective.fg2_import_margin_minutes();
  sql text; line_expr text; mkt_filter text; mkt_expr text; id_expr text; time_expr text; time_bound text; n int := 0;
  lv text[];
begin
  select r.lo, r.hi into lo_ts, hi_ts from collective.fg2_import_range(p_season, p_from) r;
  if rel is null or erel is null then
    return jsonb_build_object('relation', p_spec->>'relation', 'skipped', 'relation or its events relation not found');
  end if;
  lv := array(select jsonb_array_elements_text(ev->'league_values'));
  line_expr := case p_spec->>'line_kind'
    when 'home' then format('s.%I::numeric', p_spec->>'line_col')
    when 'away' then format('-(s.%I::numeric)', p_spec->>'line_col')
    else format($x$case
      when lower(s.%1$I::text) in ('home', 'h') then s.%2$I::numeric
      when lower(s.%1$I::text) in ('away', 'a') then -(s.%2$I::numeric)
      when collective.fg2_team_key(s.%1$I::text) = collective.fg2_team_key(e.%3$I::text) then s.%2$I::numeric
      when collective.fg2_team_key(s.%1$I::text) = collective.fg2_team_key(e.%4$I::text) then -(s.%2$I::numeric)
      end$x$, p_spec->>'side_col', p_spec->>'line_col', ev->>'home_col', ev->>'away_col') end;
  -- every market is kept as evidence (a game whose only rows are totals is
  -- a market-key mismatch, class G, not "no market"); only spread rows carry
  -- a line
  mkt_filter := '';
  mkt_expr := case when p_spec->>'market_col' is not null
    then format($x$case when lower(s.%1$I::text) in ('spread','spreads','spread:home','spread:away','point_spread','handicap','ats')
                          or lower(s.%1$I::text) like 'spread%%' then 'spread' else lower(s.%1$I::text) end$x$, p_spec->>'market_col')
    else '''spread''' end;
  id_expr := case when p_spec->>'id_col' is not null then format('s.%I::text', p_spec->>'id_col')
    else 'md5(row_to_json(s)::text)' end;
  time_expr := format('s.%I::timestamptz', p_spec->>'time_col');
  time_bound := case when p_spec->>'source' = 'collective_odds_close' then ''
    else format(' and (%1$s is null or (%1$s >= e.%2$I::timestamptz - make_interval(mins => %3$s)
                                     and %1$s <  e.%2$I::timestamptz + make_interval(mins => %4$s)))',
                time_expr, ev->>'kickoff_col', ceil(before_min)::int, ceil(after_min)::int) end;
  sql := format($q$
    insert into collective.fg2_market_snapshots (source, source_snapshot_id, source_event_id, canonical_game_id,
      book, market_type, home_line, observed_at, event_kickoff_at, raw)
    select %1$L, %2$L || ':' || %3$s, e.%4$I::text, null, %5$s, %15$s, case when %15$s = 'spread' then x.line end,
           case when %1$L = 'collective_odds_close' and %6$s >= e.%7$I::timestamptz then null else %6$s end,
           e.%7$I::timestamptz, jsonb_build_object('relation', %2$L, 'observed_raw', %6$s, 'row', to_jsonb(s))
      from %9$s e
      join %8$s s on s.%10$I::text = e.%4$I::text
      cross join lateral (select %11$s as line) x
     where true
       and e.%7$I::timestamptz >= %12$L::timestamptz
       and e.%7$I::timestamptz <  %16$L::timestamptz
       %13$s %14$s %17$s
    on conflict (source, source_snapshot_id) do nothing
  $q$,
    p_spec->>'source', rel::text, id_expr, ev->>'id_col',
    case when p_spec->>'book_col' is not null then format('s.%I::text', p_spec->>'book_col') else '''feed''' end,
    time_expr, ev->>'kickoff_col', rel::text, erel::text, p_spec->>'event_col', line_expr, lo_ts,
    mkt_filter,
    case when ev->>'league_col' is not null and cardinality(lv) > 0
      then format(' and lower(e.%I::text) = any(%L::text[])', ev->>'league_col', lv) else '' end,
    mkt_expr, hi_ts, time_bound);
  execute sql;
  get diagnostics n = row_count;
  return jsonb_build_object('relation', rel::text, 'source', p_spec->>'source', 'new_snapshots', n,
    'line_kind', p_spec->>'line_kind');
end $fn$;

-- The Collective's own odds feed (schema odds): its events, and every
-- relation in that schema shaped like a price history, found by its columns.
create or replace function collective.fg2_import_collective_odds(p_league text, p_season integer,
  p_from timestamptz default null) returns jsonb
language plpgsql as $fn$
declare
  e regclass := to_regclass('odds.events');
  c_id text; c_kick text; c_home text; c_away text; c_league text; c_link text; c_ref text; c_close text;
  lv text[];
  specs jsonb := '[]'::jsonb;
  out_ jsonb := '[]'::jsonb;
  rr record;
  s jsonb;
  ev jsonb;
  c_ev text; c_time text; c_line text; c_side text; c_mkt text; c_book text; c_sid text; kind text;
  n int;
  sql text;
  lo_ts timestamptz; hi_ts timestamptz;
begin
  select r.lo, r.hi into lo_ts, hi_ts from collective.fg2_import_range(p_season, p_from) r;
  if e is null then
    return jsonb_build_object('source', 'collective_odds', 'skipped', 'odds.events not found');
  end if;
  c_id     := collective.fg2_col(e, array['event_id', 'id', 'odds_event_id', 'provider_event_id']);
  c_kick   := collective.fg2_col(e, array['commence_time', 'kickoff_at', 'start_time', 'commence_at', 'starts_at']);
  c_home   := collective.fg2_col(e, array['home_team', 'home_name', 'home', 'home_team_name', 'home_code']);
  c_away   := collective.fg2_col(e, array['away_team', 'away_name', 'away', 'away_team_name', 'away_code']);
  c_league := collective.fg2_col(e, array['league', 'sport', 'sport_key']);
  c_link   := collective.fg2_col(e, array['collective_game_id']);
  c_ref    := collective.fg2_col(e, array['espn_id', 'provider_ref', 'external_ref', 'external_id']);
  c_close  := collective.fg2_col(e, array['closing', 'close', 'closing_lines']);
  if c_id is null or c_kick is null or c_home is null or c_away is null then
    return jsonb_build_object('source', 'collective_odds', 'skipped',
      'odds.events lacks an id/kickoff/home/away column', 'columns',
      (select jsonb_agg(attname) from pg_attribute where attrelid = e and attnum > 0 and not attisdropped));
  end if;
  lv := case when p_league = 'NFL' then array['nfl', 'americanfootball_nfl']
             else array['ncaaf', 'cfb', 'college-football', 'americanfootball_ncaaf', 'ncaa'] end;
  ev := jsonb_build_object('relation', 'odds.events', 'id_col', c_id, 'kickoff_col', c_kick, 'home_col', c_home,
    'away_col', c_away, 'league_col', c_league, 'league_values', to_jsonb(lv));

  -- the events, for linking. The old linker's own link is kept as evidence.
  sql := format($q$
    insert into collective.fg2_market_events (source, source_event_id, league, season, provider_ref, home_name, away_name,
      kickoff_at, existing_game_id, raw)
    select 'collective_odds', e.%1$I::text, %2$L, %3$s, %4$s, e.%5$I::text, e.%6$I::text, e.%7$I::timestamptz, %8$s,
           jsonb_build_object('relation', 'odds.events')
      from odds.events e
     where e.%7$I::timestamptz >= %10$L::timestamptz
       and e.%7$I::timestamptz <  %11$L::timestamptz %9$s
    on conflict (source, source_event_id) do update
      set home_name = excluded.home_name, away_name = excluded.away_name, kickoff_at = excluded.kickoff_at,
          existing_game_id = excluded.existing_game_id, provider_ref = excluded.provider_ref, updated_at = now()
  $q$, c_id, p_league, p_season,
    case when c_ref is null then 'null' else format('e.%I::text', c_ref) end,
    c_home, c_away, c_kick,
    case when c_link is null then 'null' else format('e.%I::text', c_link) end,
    case when c_league is null then '' else format(' and lower(e.%I::text) = any(%L::text[])', c_league, lv) end,
    lo_ts, hi_ts);
  execute sql;
  get diagnostics n = row_count;
  out_ := out_ || jsonb_build_object('events', n);

  -- a declared close carried ON the event row as jsonb: {"spread:home": {"line": -7, "at": ...}}
  if c_close is not null then
    sql := format($q$
      insert into collective.fg2_market_snapshots (source, source_snapshot_id, source_event_id, canonical_game_id,
        book, market_type, home_line, observed_at, event_kickoff_at, raw)
      select 'collective_odds_close', 'odds.events.%1$s:' || e.%2$I::text, e.%2$I::text, null,
             coalesce(e.%1$I->'spread:home'->>'book', 'consensus'), 'spread',
             (e.%1$I->'spread:home'->>'line')::numeric,
             case when coalesce(e.%1$I->'spread:home'->>'observed_at', e.%1$I->'spread:home'->>'at', e.%1$I->'spread:home'->>'captured_at') is not null
                   and coalesce(e.%1$I->'spread:home'->>'observed_at', e.%1$I->'spread:home'->>'at', e.%1$I->'spread:home'->>'captured_at')::timestamptz < e.%3$I::timestamptz
                  then coalesce(e.%1$I->'spread:home'->>'observed_at', e.%1$I->'spread:home'->>'at', e.%1$I->'spread:home'->>'captured_at')::timestamptz end,
             e.%3$I::timestamptz, jsonb_build_object('relation', 'odds.events', 'closing', e.%1$I)
        from odds.events e
       where jsonb_typeof(e.%1$I::jsonb) = 'object' and e.%1$I->'spread:home'->>'line' is not null
         and e.%3$I::timestamptz >= %6$L::timestamptz
         and e.%3$I::timestamptz <  %7$L::timestamptz %5$s
      on conflict (source, source_snapshot_id) do nothing
    $q$, c_close, c_id, c_kick, p_season,
      case when c_league is null then '' else format(' and lower(e.%I::text) = any(%L::text[])', c_league, lv) end,
      lo_ts, hi_ts);
    begin
      execute sql;
      get diagnostics n = row_count;
      out_ := out_ || jsonb_build_object('relation', 'odds.events.' || c_close, 'source', 'collective_odds_close', 'new_snapshots', n);
    exception when others then
      out_ := out_ || jsonb_build_object('relation', 'odds.events.' || c_close, 'error', sqlerrm);
    end;
  end if;

  -- operator-declared relations first, then discovery
  for s in select * from jsonb_array_elements(coalesce(collective.fg2_cfg('snapshot_relations'), '[]'::jsonb)) loop
    specs := specs || jsonb_build_array(s || jsonb_build_object('events', ev));
  end loop;
  for rr in
    select c.oid::regclass as rel, c.relname::text as relname
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'odds' and c.relkind in ('r', 'p') and c.oid <> e
     order by c.relname
  loop
    continue when exists (select 1 from jsonb_array_elements(specs) x where to_regclass(x.value->>'relation') = rr.rel);
    c_ev   := collective.fg2_col(rr.rel, array[c_id, 'event_id', 'odds_event_id']);
    c_time := collective.fg2_col(rr.rel, array['observed_at', 'captured_at', 'fetched_at', 'snapshot_at', 'seen_at',
                'polled_at', 'recorded_at', 'as_of', 'line_at', 'created_at', 'updated_at', 'last_update']);
    c_line := collective.fg2_col(rr.rel, array['home_line', 'home_point', 'home_spread', 'point', 'line', 'handicap', 'spread']);
    c_side := collective.fg2_col(rr.rel, array['outcome', 'side', 'selection', 'outcome_name', 'team', 'name']);
    c_mkt  := collective.fg2_col(rr.rel, array['market', 'market_key', 'market_type']);
    c_book := collective.fg2_col(rr.rel, array['book', 'book_key', 'bookmaker', 'bookmaker_key', 'sportsbook', 'book_title']);
    c_sid  := collective.fg2_col(rr.rel, array['id', 'snapshot_id', 'quote_id', 'tick_id', 'line_id']);
    if c_ev is null or c_time is null or c_line is null then
      out_ := out_ || jsonb_build_object('relation', rr.rel::text, 'skipped', 'not a price history (needs event id, time and line columns)');
      continue;
    end if;
    kind := case when c_line in ('home_line', 'home_point', 'home_spread') then 'home'
                 when c_side is not null then 'side' end;
    if kind is null then
      out_ := out_ || jsonb_build_object('relation', rr.rel::text, 'skipped', 'line has no side: cannot orient it to the home team');
      continue;
    end if;
    if c_mkt is null and rr.relname !~ 'spread' then
      out_ := out_ || jsonb_build_object('relation', rr.rel::text, 'skipped', 'no market column and not a spread relation');
      continue;
    end if;
    specs := specs || jsonb_build_array(jsonb_build_object(
      'relation', rr.rel::text,
      'source', case when rr.relname ~ 'clos' then 'collective_odds_close' else 'collective_odds' end,
      'event_col', c_ev, 'time_col', c_time, 'line_col', c_line, 'line_kind', kind, 'side_col', c_side,
      'market_col', c_mkt, 'book_col', c_book, 'id_col', c_sid, 'events', ev));
  end loop;
  for s in select * from jsonb_array_elements(specs) loop
    begin
      out_ := out_ || collective.fg2_import_relation(s, p_league, p_season, p_from);
    exception when others then
      out_ := out_ || jsonb_build_object('relation', s->>'relation', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('source', 'collective_odds', 'steps', out_);
end $fn$;

-- EdgeDesk's own capture (public.signals + public.signal_ticks): a
-- first-party, timestamped price history of the same markets. A signal is
-- one (event, market, selection, point); a tick is one capture pass that saw
-- it, stamped with the pass's instant and how many books quoted that point.
-- Ticks are read per signal through (sig_key, created_at), inside
-- [kickoff - (window + margin), kickoff + margin] of the signal's own
-- kickoff: nothing earlier can be a close. signal_ticks holds every sport's
-- history, so it is never scanned whole.
create or replace function collective.fg2_import_edgedesk_capture(p_league text, p_season integer,
  p_from timestamptz default null) returns jsonb
language plpgsql as $fn$
declare
  s regclass := to_regclass('public.signals');
  t regclass := to_regclass('public.signal_ticks');
  c_ev text; c_sport text; c_mkt text; c_sel text; c_pt text; c_kick text; c_home text; c_away text; c_seen text; c_book text; c_nb text;
  t_time text; t_pt text; t_id text; t_book text; t_nb text;
  sk text[];
  lo_ts timestamptz; hi_ts timestamptz;
  before_min int := ceil(collective.fg2_window_minutes(p_league) + collective.fg2_import_margin_minutes())::int;
  after_min int := ceil(collective.fg2_import_margin_minutes())::int;
  sql text; n_e int := 0; n_s int := 0; n_t int := 0;
begin
  if s is null then return jsonb_build_object('source', 'edgedesk_capture', 'skipped', 'public.signals not found'); end if;
  select r.lo, r.hi into lo_ts, hi_ts from collective.fg2_import_range(p_season, p_from) r;
  c_ev    := collective.fg2_col(s, array['event_id']);
  c_sport := collective.fg2_col(s, array['sport_key', 'sport']);
  c_mkt   := collective.fg2_col(s, array['market', 'market_key']);
  c_sel   := collective.fg2_col(s, array['selection', 'outcome', 'side']);
  c_pt    := collective.fg2_col(s, array['point', 'line']);
  c_kick  := collective.fg2_col(s, array['commence_time', 'kickoff_at']);
  c_home  := collective.fg2_col(s, array['home_team', 'home']);
  c_away  := collective.fg2_col(s, array['away_team', 'away']);
  c_seen  := collective.fg2_col(s, array['last_seen_at', 'updated_at', 'captured_at']);
  c_book  := collective.fg2_col(s, array['best_book', 'book']);
  c_nb    := collective.fg2_col(s, array['n_books', 'total_books']);
  if c_ev is null or c_sport is null or c_mkt is null or c_sel is null or c_pt is null or c_kick is null
     or c_home is null or c_away is null then
    return jsonb_build_object('source', 'edgedesk_capture', 'skipped',
      'public.signals lacks one of event_id/sport_key/market/selection/point/commence_time/home_team/away_team');
  end if;
  sk := case when p_league = 'NFL' then array['americanfootball_nfl'] else array['americanfootball_ncaaf'] end;
  execute format($q$
    insert into collective.fg2_market_events (source, source_event_id, league, season, provider_ref, home_name, away_name, kickoff_at, raw)
    select distinct on (s.%1$I::text) 'edgedesk_capture', s.%1$I::text, %2$L, %3$s, null, s.%4$I::text, s.%5$I::text,
           s.%6$I::timestamptz, jsonb_build_object('relation', 'public.signals')
      from public.signals s
     where s.%7$I::text = any(%8$L::text[])
       and s.%6$I::timestamptz >= %9$L::timestamptz and s.%6$I::timestamptz < %10$L::timestamptz
     order by s.%1$I::text, s.%6$I::timestamptz desc
    on conflict (source, source_event_id) do update
      set home_name = excluded.home_name, away_name = excluded.away_name, kickoff_at = excluded.kickoff_at, updated_at = now()
  $q$, c_ev, p_league, p_season, c_home, c_away, c_kick, c_sport, sk, lo_ts, hi_ts);
  get diagnostics n_e = row_count;

  -- the spread signals of this league and range, each oriented to its own
  -- event's home team once (+1 home selection, -1 away, null neither)
  drop table if exists pg_temp.fg2_sig;
  execute format($q$
    create temp table fg2_sig on commit drop as
    select s.sig_key::text as sig_key, s.%1$I::text as event_id, s.%2$I::timestamptz as kickoff_at,
           s.%3$I::numeric as point, s.%4$I::text as selection, s.%12$I::text as market,
           case when collective.fg2_team_key(s.%4$I::text) = collective.fg2_team_key(s.%5$I::text) then 1
                when collective.fg2_team_key(s.%4$I::text) = collective.fg2_team_key(s.%6$I::text) then -1 end as sgn,
           %7$s as seen_at, %8$s as book, %9$s as n_books
      from public.signals s
     where s.%10$I::text = any(%11$L::text[]) and lower(s.%12$I::text) in ('spreads', 'spread')
       and s.%2$I::timestamptz >= %13$L::timestamptz and s.%2$I::timestamptz < %14$L::timestamptz
  $q$, c_ev, c_kick, c_pt, c_sel, c_home, c_away,
    case when c_seen is null then 'null::timestamptz' else format('s.%I::timestamptz', c_seen) end,
    case when c_book is null then '''edgedesk''::text' else format('s.%I::text', c_book) end,
    case when c_nb is null then 'null::numeric' else format('s.%I::numeric', c_nb) end,
    c_sport, sk, c_mkt, lo_ts, hi_ts);

  -- the signal row itself, as seen at its last capture pass
  if c_seen is not null then
    execute $q$
      insert into collective.fg2_market_snapshots (source, source_snapshot_id, source_event_id, canonical_game_id,
        book, market_type, home_line, observed_at, event_kickoff_at, raw)
      select 'edgedesk_capture', 'signals:' || md5(g.event_id || '|' || g.selection || '|' || g.market || '|' || g.point::text || '|' || g.seen_at::text),
             g.event_id, null, g.book, 'spread',
             case when g.sgn = 1 then g.point when g.sgn = -1 then -g.point end,
             g.seen_at, g.kickoff_at,
             jsonb_build_object('relation', 'public.signals', 'selection', g.selection, 'point', g.point, 'n_books', g.n_books)
        from fg2_sig g
       where g.seen_at is not null and g.point is not null
      on conflict (source, source_snapshot_id) do nothing
    $q$;
    get diagnostics n_s = row_count;
  end if;

  -- the tick history: every recorded pass inside the window, at its own instant
  if t is not null and collective.fg2_col(t, array['sig_key']) is not null and collective.fg2_col(s, array['sig_key']) is not null then
    t_time := collective.fg2_col(t, array['created_at', 'seen_at', 'captured_at']);
    t_pt   := collective.fg2_col(t, array['point', 'line']);
    t_id   := collective.fg2_col(t, array['id', 'tick_id']);
    t_book := collective.fg2_col(t, array['book_key', 'book']);
    t_nb   := collective.fg2_col(t, array['n_books', 'total_books']);
    if t_time is not null then
      execute format($q$
        insert into collective.fg2_market_snapshots (source, source_snapshot_id, source_event_id, canonical_game_id,
          book, market_type, home_line, observed_at, event_kickoff_at, raw)
        select 'edgedesk_capture', 'signal_ticks:' || md5(k.sig_key::text || '|' || k.%1$I::text || '|' || %2$s),
               g.event_id, null, %3$s, 'spread',
               case when g.sgn = 1 then %4$s when g.sgn = -1 then -(%4$s) end,
               k.%1$I::timestamptz, g.kickoff_at,
               jsonb_build_object('relation', 'public.signal_ticks', 'sig_key', k.sig_key, 'n_books', %5$s)
          from fg2_sig g
          join lateral (
            select * from public.signal_ticks k
             where k.sig_key = g.sig_key
               and k.%1$I >= g.kickoff_at - make_interval(mins => %6$s)
               and k.%1$I <  g.kickoff_at + make_interval(mins => %7$s)) k on true
         where %4$s is not null
        on conflict (source, source_snapshot_id) do nothing
      $q$, t_time,
        case when t_id is null then '''''' else format('coalesce(k.%I::text, '''')', t_id) end,
        case when t_book is null then '''edgedesk''' else format('coalesce(k.%I::text, ''edgedesk'')', t_book) end,
        case when t_pt is null then 'g.point' else format('coalesce(k.%I::numeric, g.point)', t_pt) end,
        case when t_nb is null then 'null::numeric' else format('k.%I::numeric', t_nb) end,
        before_min, after_min);
      get diagnostics n_t = row_count;
    end if;
  end if;
  drop table if exists pg_temp.fg2_sig;
  return jsonb_build_object('source', 'edgedesk_capture', 'events', n_e, 'signal_snapshots', n_s, 'tick_snapshots', n_t,
    'tick_window_minutes', jsonb_build_object('before_kickoff', before_min, 'after_kickoff', after_min));
end $fn$;

create or replace function collective.fg2_import_snapshots(p_league text, p_season integer,
  p_from timestamptz default null) returns jsonb
language plpgsql as $fn$
declare out_ jsonb := '[]'::jsonb; r jsonb;
begin
  begin r := collective.fg2_import_legacy(p_league, p_season);
  exception when others then r := jsonb_build_object('source', 'legacy_results_close', 'error', sqlerrm); end;
  out_ := out_ || jsonb_build_array(r);
  begin r := collective.fg2_import_collective_odds(p_league, p_season, p_from);
  exception when others then r := jsonb_build_object('source', 'collective_odds', 'error', sqlerrm); end;
  out_ := out_ || jsonb_build_array(r);
  begin r := collective.fg2_import_edgedesk_capture(p_league, p_season, p_from);
  exception when others then r := jsonb_build_object('source', 'edgedesk_capture', 'error', sqlerrm); end;
  out_ := out_ || jsonb_build_array(r);
  return out_;
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('6 sources', 'ok', 'fg2_import_legacy / fg2_import_collective_odds (discovery + snapshot_relations) / fg2_import_edgedesk_capture');

-- 7 ---- canonical games and event links -------------------------------------
create or replace function collective.fg2_canonical(p_game_id text) returns text
language sql stable as $fn$
  select coalesce((select canonical_game_id from collective.fg2_game_alias where game_id = p_game_id), p_game_id)
$fn$;

-- The same fixture held twice: sport, season, the unordered pair of team ids
-- and the kickoff tolerance. The member holding the most predictions is
-- canonical (then a provider ref, then the earliest kickoff, then the id).
create or replace function collective.fg2_detect_duplicates(p_league text, p_season integer) returns integer
language plpgsql as $fn$
declare
  tol numeric := collective.fg2_tolerance_minutes();
  r record; cl text[]; used text[] := '{}'; n int := 0; best text; x record;
begin
  for r in
    select g.game_id, g.kickoff_at, least(g.home_team_id, g.away_team_id) as t1, greatest(g.home_team_id, g.away_team_id) as t2
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league and g.season = p_season
       and g.home_team_id is not null and g.away_team_id is not null
     order by g.kickoff_at, g.game_id
  loop
    continue when r.game_id = any(used);
    select array_agg(g.game_id order by g.kickoff_at, g.game_id) into cl
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = p_league and g.season = p_season
       and least(g.home_team_id, g.away_team_id) = r.t1 and greatest(g.home_team_id, g.away_team_id) = r.t2
       and abs(extract(epoch from (g.kickoff_at - r.kickoff_at))) <= tol * 60
       and not (g.game_id = any(used));
    continue when cl is null or cardinality(cl) < 2;
    used := used || cl;
    select g.game_id into best
      from collective.fg2_src_games g
      left join lateral (select count(*) as n from collective.fg2_src_predictions p where p.game_id = g.game_id) pc on true
     where g.game_id = any(cl)
     order by pc.n desc, (g.external_ref is not null) desc, g.kickoff_at, g.game_id collate "C"
     limit 1;
    for x in select unnest(cl) as gid loop
      continue when x.gid = best;
      insert into collective.fg2_game_alias (game_id, canonical_game_id, reason)
      values (x.gid, best, 'same fixture (' || p_league || ' ' || p_season || ', same two teams, kickoff within ' || tol || ' min)')
      on conflict (game_id) do update set canonical_game_id = excluded.canonical_game_id, reason = excluded.reason;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $fn$;

create or replace function collective.fg2_link_events(p_league text, p_season integer,
  p_from timestamptz default null) returns jsonb
language plpgsql as $fn$
declare
  tol numeric := collective.fg2_tolerance_minutes();
  ev record; m record; uni text[];
  st text; gid text; meth text; ori text; why text; ex text;
  n_link int := 0; n_un int := 0; n_conf int := 0;
begin
  for ev in select * from collective.fg2_market_events
             where league = p_league and season = p_season
               and (p_from is null or kickoff_at >= p_from) loop
    select array_agg(x.nm) into uni
      from (select e2.home_name as nm from collective.fg2_market_events e2
             where e2.source = ev.source and e2.league = p_league and e2.kickoff_at is not null and ev.kickoff_at is not null
               and abs(extract(epoch from (e2.kickoff_at - ev.kickoff_at))) <= 36 * 3600
            union all
            select e2.away_name from collective.fg2_market_events e2
             where e2.source = ev.source and e2.league = p_league and e2.kickoff_at is not null and ev.kickoff_at is not null
               and abs(extract(epoch from (e2.kickoff_at - ev.kickoff_at))) <= 36 * 3600) x;
    select * into m from collective.fg2_match_event(p_league, p_season, ev.provider_ref, ev.home_name, ev.away_name,
      ev.kickoff_at, uni, tol);
    gid := m.game_id; meth := m.method; ori := m.orientation; why := m.reason;
    ex := case when ev.existing_game_id is null then null else collective.fg2_canonical(ev.existing_game_id) end;
    st := case when gid is not null then 'linked' else 'unresolved' end;
    if ex is not null then
      if gid is null then
        gid := ev.existing_game_id; meth := 'existing_link'; ori := 'same'; st := 'linked'; why := null;
      elsif collective.fg2_canonical(gid) <> ex then
        st := 'conflict'; why := 'existing link to ' || ev.existing_game_id || ' disagrees with ' || meth || ' match to ' || gid;
        gid := null;
      end if;
    end if;
    insert into collective.fg2_event_links (source, source_event_id, status, canonical_game_id, matched_game_id, orientation,
      method, reason, home_team_id, away_team_id, home_method, away_method, kickoff_at)
    values (ev.source, ev.source_event_id, st, case when gid is null then null else collective.fg2_canonical(gid) end, gid,
      ori, meth, why, m.home_team_id, m.away_team_id, m.home_method, m.away_method, ev.kickoff_at)
    on conflict (source, source_event_id) do update set
      status = excluded.status, canonical_game_id = excluded.canonical_game_id, matched_game_id = excluded.matched_game_id,
      orientation = excluded.orientation, method = excluded.method, reason = excluded.reason,
      home_team_id = excluded.home_team_id, away_team_id = excluded.away_team_id, home_method = excluded.home_method,
      away_method = excluded.away_method, kickoff_at = excluded.kickoff_at, updated_at = now()
    where (collective.fg2_event_links.status, collective.fg2_event_links.canonical_game_id, collective.fg2_event_links.orientation,
           collective.fg2_event_links.method, collective.fg2_event_links.reason)
          is distinct from (excluded.status, excluded.canonical_game_id, excluded.orientation, excluded.method, excluded.reason);
    if st = 'linked' then n_link := n_link + 1; elsif st = 'conflict' then n_conf := n_conf + 1; else n_un := n_un + 1; end if;
  end loop;
  return jsonb_build_object('linked', n_link, 'unresolved', n_un, 'conflict', n_conf);
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('7 canonical games', 'ok', 'fg2_detect_duplicates / fg2_link_events / fg2_canonical');

-- 8 ---- the official close ---------------------------------------------------
create or replace function collective.fg2_compute_close(p_game_id text) returns jsonb
language plpgsql as $fn$
declare
  g record;
  gv text := collective.fg2_version();
  win numeric; kick timestamptz; legacy numeric;
  srcs jsonb := coalesce(collective.fg2_cfg('sources'), '[]'::jsonb);
  books jsonb := coalesce(collective.fg2_cfg('book_priority'), '[]'::jsonb);
  members text[];
  s jsonb; pass boolean; found_ boolean := false; n_src int;
  b_home numeric; b_source text; b_snap text; b_event text; b_book text; b_obs timestamptz; b_link text; b_matched text; b_existing text;
  c_home numeric; c_source text; c_snap text; c_event text; c_book text; c_obs timestamptz; c_link text; c_matched text; c_existing text;
  rej jsonb; total int; st text; cls text; cls_why text;
begin
  select * into g from collective.fg2_src_games where game_id = p_game_id;
  if not found then return null; end if;
  win := collective.fg2_window_minutes(g.sport);
  kick := g.kickoff_at;
  members := array[p_game_id] || coalesce(array(select a.game_id from collective.fg2_game_alias a where a.canonical_game_id = p_game_id), '{}'::text[]);
  select home_line into legacy from collective.fg2_market_snapshots
   where source = 'legacy_results_close' and canonical_game_id = any(members)
   order by (canonical_game_id = p_game_id) desc, source_snapshot_id limit 1;

  -- (fg2_cand2: revision 2 added n_books; a session that ran revision 1
  -- keeps its old fg2_cand)
  -- ON COMMIT DROP (revision 3): PostgREST reuses one backend session across
  -- requests, and a temp table belongs to the role that created it. Kept for
  -- the session, the one grade_game makes (security definer: the owner) is
  -- refused to a later fg2_refresh, which runs as service_role ("permission
  -- denied for table fg2_cand2"). Per transaction, every caller makes its own.
  if to_regclass('pg_temp.fg2_cand2') is null then
  create temp table fg2_cand2 (
    source text, source_snapshot_id text, source_event_id text, book text, market_type text, observed_at timestamptz,
    home numeric, link_method text, matched_game_id text, existing_game_id text, prio int, untimed_ok boolean,
    book_rank int, n_books numeric, rejection text) on commit drop;
  end if;
  truncate fg2_cand2;
  -- the game's snapshots: those stamped with it (or an alias of it), and
  -- those whose market event is linked to it. Two index lookups, never a
  -- scan of the whole store.
  insert into fg2_cand2
  select s2.source, s2.source_snapshot_id, s2.source_event_id, s2.book, s2.market_type, s2.observed_at,
         case when l.orientation = 'swapped' then -coalesce(s2.home_line, -s2.away_line) else coalesce(s2.home_line, -s2.away_line) end,
         l.method, l.matched_game_id,
         (select e.existing_game_id from collective.fg2_market_events e where e.source = s2.source and e.source_event_id = s2.source_event_id),
         (select (x.value->>'priority')::int from jsonb_array_elements(srcs) x where x.value->>'name' = s2.source limit 1),
         coalesce((select (x.value->>'untimed')::boolean from jsonb_array_elements(srcs) x where x.value->>'name' = s2.source limit 1), false),
         coalesce((select (o.ord - 1)::int from jsonb_array_elements_text(books) with ordinality o(b, ord) where o.b = lower(coalesce(s2.book, '')) limit 1), 999),
         case when jsonb_typeof(s2.raw->'n_books') = 'number' then (s2.raw->>'n_books')::numeric end,
         null
    from (select x.source, x.source_snapshot_id from collective.fg2_market_snapshots x
           where x.canonical_game_id = any(members)
          union
          select x.source, x.source_snapshot_id from collective.fg2_event_links l0
            join collective.fg2_market_snapshots x on x.source = l0.source and x.source_event_id = l0.source_event_id
           where l0.canonical_game_id = p_game_id and l0.status = 'linked') ids
    join collective.fg2_market_snapshots s2 on s2.source = ids.source and s2.source_snapshot_id = ids.source_snapshot_id
    left join collective.fg2_event_links l on l.source = s2.source and l.source_event_id = s2.source_event_id and l.status = 'linked';

  -- Every candidate is classified once. The WHERE is required, not
  -- decoration: Supabase loads pg-safeupdate for the sessions PostgREST
  -- opens, and it refuses an UPDATE with no WHERE ("21000 UPDATE requires a
  -- WHERE clause") -- so grade_game (and fg2_refresh / fg2_rebuild) failed
  -- on every call through the API while running clean through psql.
  -- Every row was inserted just above with rejection null, so this touches
  -- exactly the rows the bare statement did.
  update fg2_cand2 set rejection = case
      when lower(coalesce(market_type, 'spread')) not in ('spread', 'spreads', 'spread:home', 'point_spread', 'handicap', 'ats') then 'NOT_SPREAD'
      when home is null then 'BAD_LINE'
      when prio is null then 'SOURCE_DISABLED'
      when observed_at is null and not untimed_ok then 'UNTIMED'
      when observed_at is not null and kick is null then 'NO_KICKOFF'
      when observed_at is not null and observed_at >= kick then 'AFTER_KICKOFF'
      when observed_at is not null and observed_at < kick - make_interval(secs => win * 60) then 'STALE'
    end
   where rejection is null;
  select count(*) into total from fg2_cand2;
  select jsonb_build_object(
    'NOT_SPREAD', count(*) filter (where rejection = 'NOT_SPREAD'), 'BAD_LINE', count(*) filter (where rejection = 'BAD_LINE'),
    'AFTER_KICKOFF', count(*) filter (where rejection = 'AFTER_KICKOFF'), 'STALE', count(*) filter (where rejection = 'STALE'),
    'UNTIMED', count(*) filter (where rejection = 'UNTIMED'), 'SOURCE_DISABLED', count(*) filter (where rejection = 'SOURCE_DISABLED'),
    'ORIENTATION_CONFLICT', 0, 'NO_KICKOFF', count(*) filter (where rejection = 'NO_KICKOFF'))
    into rej from fg2_cand2;

  -- timed snapshots first, sources in priority order; an untimed close only
  -- when no source has a valid timed one
  <<passes>>
  foreach pass in array array[true, false] loop
    for s in select x.value from jsonb_array_elements(srcs) x order by (x.value->>'priority')::int loop
      b_home := null;
      select c.home, c.source, c.source_snapshot_id, c.source_event_id, c.book, c.observed_at, c.link_method,
             c.matched_game_id, c.existing_game_id
        into b_home, b_source, b_snap, b_event, b_book, b_obs, b_link, b_matched, b_existing
        from fg2_cand2 c
       where c.rejection is null and c.source = s->>'name' and (c.observed_at is not null) = pass
       order by c.observed_at desc nulls last, coalesce(c.n_books, 0) desc, c.book_rank, c.source_snapshot_id collate "C"
       limit 1;
      continue when b_home is null;
      if legacy is not null and abs(legacy) >= 1 and s->>'name' <> 'legacy_results_close'
         and abs(b_home + legacy) <= 0.5 and abs(b_home - legacy) >= 2 then
        select count(*) into n_src from fg2_cand2 c where c.rejection is null and c.source = s->>'name' and (c.observed_at is not null) = pass;
        rej := jsonb_set(rej, '{ORIENTATION_CONFLICT}', to_jsonb((rej->>'ORIENTATION_CONFLICT')::int + n_src));
        continue;
      end if;
      c_home := b_home; c_source := b_source; c_snap := b_snap; c_event := b_event; c_book := b_book; c_obs := b_obs;
      c_link := b_link; c_matched := b_matched; c_existing := b_existing;
      found_ := true;
      exit passes;
    end loop;
  end loop;

  st := case
    when found_ then 'OK'
    when total = 0 then 'NO_SNAPSHOT'
    when (rej->>'ORIENTATION_CONFLICT')::int > 0 then 'ORIENTATION_CONFLICT'
    when (rej->>'AFTER_KICKOFF')::int > 0 and (rej->>'STALE')::int = 0 then 'ONLY_AFTER_KICKOFF'
    when (rej->>'STALE')::int > 0 then 'ONLY_STALE'
    when (rej->>'SOURCE_DISABLED')::int > 0 then 'SOURCE_DISABLED'
    when (rej->>'NOT_SPREAD')::int = total then 'NO_SPREAD_MARKET'
    else 'NO_VALID_SNAPSHOT' end;

  -- WHY the legacy pipeline did or did not have this close (A-L)
  if legacy is not null then
    cls := 'A'; cls_why := 'a captured close was already on the game';
  elsif found_ and ((c_matched is not null and c_matched <> p_game_id)
        or (c_existing is not null and c_existing <> p_game_id and collective.fg2_canonical(c_existing) = p_game_id)) then
    cls := 'D'; cls_why := 'recovered: the market was linked to duplicate game ' || coalesce(nullif(c_matched, p_game_id), c_existing);
  elsif found_ and c_existing is not null and c_existing = p_game_id then
    cls := 'B'; cls_why := 'recovered: the snapshots were already linked to this game and the close selector produced nothing';
  elsif found_ then
    cls := 'C'; cls_why := 'recovered: the snapshots were held under ' || c_source || ' event ' || coalesce(c_event, '?') ||
      ', not linked to this game (' || coalesce(c_link, 'direct') || ')';
  elsif exists (select 1 from collective.fg2_src_predictions p where p.game_id = any(members))
        and not exists (select 1 from collective.fg2_src_predictions p where p.game_id = any(members)
                         and p.received_at < kick - make_interval(secs => collective.fg2_lock_minutes() * 60)) then
    cls := 'K'; cls_why := 'every submission on the game arrived after the lock';
  elsif (rej->>'ORIENTATION_CONFLICT')::int > 0 or (rej->>'BAD_LINE')::int > 0 then
    cls := 'H'; cls_why := case when (rej->>'ORIENTATION_CONFLICT')::int > 0
      then 'the only snapshots state the line for the other side (orientation conflict)'
      else (rej->>'BAD_LINE') || ' spread snapshot(s) whose line could not be oriented to the home team' end;
  elsif (rej->>'AFTER_KICKOFF')::int > 0 and (rej->>'STALE')::int = 0 then
    cls := 'I'; cls_why := (rej->>'AFTER_KICKOFF') || ' snapshot(s) captured, all at or after kickoff';
  elsif (rej->>'NOT_SPREAD')::int + (rej->>'SOURCE_DISABLED')::int > 0 and (rej->>'STALE')::int = 0 then
    cls := 'G'; cls_why := 'snapshots exist only for another market or an unconfigured source';
  elsif (rej->>'STALE')::int > 0 then
    cls := 'L'; cls_why := 'snapshots exist but none inside the ' || win || '-minute final-pregame window';
  elsif exists (select 1 from collective.fg2_event_links l
                 where l.status = 'unresolved' and l.reason = 'kickoff_out_of_tolerance'
                   and least(l.home_team_id, l.away_team_id) = least(g.home_team_id, g.away_team_id)
                   and greatest(l.home_team_id, l.away_team_id) = greatest(g.home_team_id, g.away_team_id)) then
    cls := 'F'; cls_why := 'a market event for these teams exists with a kickoff outside the tolerance';
  elsif exists (select 1 from collective.fg2_event_links l
                 where l.status in ('unresolved', 'conflict') and l.kickoff_at is not null and kick is not null
                   and abs(extract(epoch from (l.kickoff_at - kick))) <= collective.fg2_tolerance_minutes() * 60
                   and (l.home_team_id in (g.home_team_id, g.away_team_id) or l.away_team_id in (g.home_team_id, g.away_team_id))) then
    cls := 'E'; cls_why := 'a market event naming one of these teams at this kickoff could not be resolved to the game (team name or link conflict)';
  else
    cls := 'J'; cls_why := 'no market snapshot for this game exists in any configured source';
  end if;

  insert into collective.fg2_official_closes (canonical_game_id, market_type, home_spread, away_spread, book, source,
    source_event_id, source_snapshot_id, observed_at, kickoff_at, lead_minutes, timed, close_status, close_class,
    close_class_reason, considered, rejected, legacy_close, grading_version, computed_at)
  values (p_game_id, 'spread', c_home, round(-c_home, 6), c_book, c_source, c_event, c_snap, c_obs, kick,
    case when c_obs is not null then round(extract(epoch from (kick - c_obs)) / 60, 6) end,
    case when found_ then c_obs is not null end,
    st, cls, cls_why, total, rej, legacy, gv, now())
  on conflict (canonical_game_id, market_type) do update set
    home_spread = excluded.home_spread, away_spread = excluded.away_spread, book = excluded.book, source = excluded.source,
    source_event_id = excluded.source_event_id, source_snapshot_id = excluded.source_snapshot_id,
    observed_at = excluded.observed_at, kickoff_at = excluded.kickoff_at, lead_minutes = excluded.lead_minutes,
    timed = excluded.timed, close_status = excluded.close_status, close_class = excluded.close_class,
    close_class_reason = excluded.close_class_reason, considered = excluded.considered, rejected = excluded.rejected,
    legacy_close = excluded.legacy_close, grading_version = excluded.grading_version, computed_at = now()
  where (collective.fg2_official_closes.home_spread, collective.fg2_official_closes.source_snapshot_id,
         collective.fg2_official_closes.close_status, collective.fg2_official_closes.close_class,
         collective.fg2_official_closes.considered, collective.fg2_official_closes.rejected, collective.fg2_official_closes.legacy_close)
        is distinct from (excluded.home_spread, excluded.source_snapshot_id, excluded.close_status, excluded.close_class,
         excluded.considered, excluded.rejected, excluded.legacy_close);
  return jsonb_build_object('home_spread', c_home, 'source', c_source, 'snapshot', c_snap, 'status', st, 'class', cls);
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('8 close', 'ok', 'fg2_compute_close: the final valid pregame snapshot, by source priority, never in-game, never invented; A-L class per game');

-- 9 ---- the settlement --------------------------------------------------------
create or replace function collective.fg2_settle_game(p_game_id text, p_run uuid default null) returns integer
language plpgsql as $fn$
declare
  gv text := collective.fg2_version();
  g record; cl record; mdl record; ch record; lg record;
  members text[];
  lk timestamptz;
  st text; is_final boolean; hs numeric; aws numeric; mrg numeric;
  n_versions int; n_live int; n_pre int; n_post int; n_untimed int; ver int;
  pstatus text; common text;
  fair numeric; pmargin numeric; expl text; prob numeric;
  side text; side_src text; edge numeric;
  atsm numeric; cov text; res text; ats_ex text; me numeric; mae_ex text; outc int; br numeric; br_ex text;
  closeh numeric;
  newstate jsonb; oldstate jsonb; prev record;
  n int := 0;
  why text;
begin
  if exists (select 1 from collective.fg2_game_alias a where a.game_id = p_game_id) then return 0; end if;
  select * into g from collective.fg2_src_games where game_id = p_game_id;
  if not found then return 0; end if;
  members := array[p_game_id] || coalesce(array(select a.game_id from collective.fg2_game_alias a where a.canonical_game_id = p_game_id), '{}'::text[]);
  st := collective.fg2_game_state(g.status, g.home_score, g.away_score);
  is_final := st = 'FINAL';
  hs := case when is_final then g.home_score end;
  aws := case when is_final then g.away_score end;
  mrg := hs - aws;
  lk := g.kickoff_at - make_interval(secs => collective.fg2_lock_minutes() * 60);
  select * into cl from collective.fg2_official_closes where canonical_game_id = p_game_id and market_type = 'spread';
  closeh := cl.home_spread;

  for mdl in select distinct p.model_id from collective.fg2_src_predictions p where p.game_id = any(members) order by 1 loop
    select count(*),
           count(*) filter (where (p.data_origin is null or p.data_origin = 'live') and (p.resolution_status is null or p.resolution_status = 'resolved')),
           count(*) filter (where (p.data_origin is null or p.data_origin = 'live') and (p.resolution_status is null or p.resolution_status = 'resolved')
                              and p.received_at is not null and p.received_at < lk),
           count(*) filter (where (p.data_origin is null or p.data_origin = 'live') and (p.resolution_status is null or p.resolution_status = 'resolved')
                              and p.received_at is not null and not coalesce(p.received_at < lk, false)),
           count(*) filter (where (p.data_origin is null or p.data_origin = 'live') and (p.resolution_status is null or p.resolution_status = 'resolved')
                              and p.received_at is null)
      into n_versions, n_live, n_pre, n_post, n_untimed
      from collective.fg2_src_predictions p where p.model_id = mdl.model_id and p.game_id = any(members);
    select v.* into ch from (
      select p.*, row_number() over (order by p.received_at asc nulls last, p.prediction_id collate "C" asc) as ver
        from collective.fg2_src_predictions p where p.model_id = mdl.model_id and p.game_id = any(members)) v
     where (v.data_origin is null or v.data_origin = 'live') and (v.resolution_status is null or v.resolution_status = 'resolved')
       and v.received_at is not null and lk is not null and v.received_at < lk
     order by v.received_at desc, v.prediction_id collate "C" desc
     limit 1;
    if found then pstatus := 'OK'; ver := ch.ver;
    else
      ver := null;
      pstatus := case when n_live = 0 then 'EXCLUDED_ORIGIN'
                      when n_untimed > 0 and n_post = 0 then 'UNTIMED_SUBMISSION'
                      when lk is null then 'GAME_UNFINISHED'
                      else 'LATE_SUBMISSION' end;
    end if;
    if pstatus = 'OK' then
      fair := collective.fg2_fair_home_spread(ch.projected_spread, ch.proj_home_score, ch.proj_away_score);
      pmargin := collective.fg2_predicted_margin(ch.projected_spread, ch.proj_home_score, ch.proj_away_score);
      expl := collective.fg2_norm_side(ch.pick_side);
      prob := case when ch.home_win_prob between 0 and 1 then ch.home_win_prob end;
    else
      fair := null; pmargin := null; expl := null; prob := null;
    end if;
    common := case when not is_final then st when pstatus <> 'OK' then pstatus end;
    side := null; side_src := null; edge := null; atsm := null; cov := null; res := null; ats_ex := null;
    if pstatus = 'OK' and closeh is not null then
      select d.side, d.source, d.edge_home into side, side_src, edge from collective.fg2_derive_side(ch.pick_side, fair, closeh) d;
    end if;
    if common is not null then ats_ex := common; side := null; side_src := null;
    elsif closeh is null then ats_ex := 'MISSING_CLOSE';
    elsif side is null then ats_ex := 'NO_ATS_SIDE';
    else res := collective.fg2_grade_side(side, collective.fg2_cover(hs, aws, closeh));
    end if;
    if is_final and closeh is not null then
      atsm := collective.fg2_ats_margin(hs, aws, closeh);
      cov := collective.fg2_cover(hs, aws, closeh);
    end if;
    me := null; mae_ex := null;
    if common is not null then mae_ex := common;
    elsif pmargin is null then mae_ex := 'MISSING_FAIR_SPREAD';
    else me := round(abs(pmargin - mrg), 6);
    end if;
    outc := case when is_final and mrg > 0 then 1 when is_final and mrg < 0 then 0 end;
    br := null; br_ex := null;
    if common is not null then br_ex := common;
    elsif prob is null then br_ex := 'MISSING_PROBABILITY';
    elsif mrg = 0 then br_ex := 'TIE_NO_WINNER';
    else br := round((prob - outc) * (prob - outc), 6);
    end if;

    newstate := jsonb_build_object('prediction_id', case when pstatus = 'OK' then ch.prediction_id end,
      'prediction_status', pstatus, 'ats_side', side, 'ats_side_source', side_src,
      'close_home_spread', closeh, 'close_snapshot_id', cl.source_snapshot_id,
      'ats_result', res, 'ats_exclusion', ats_ex, 'margin_error', me, 'mae_exclusion', mae_ex,
      'brier', br, 'brier_exclusion', br_ex, 'game_state', st);
    select * into prev from collective.fg2_settlements
     where model_id = mdl.model_id and canonical_game_id = p_game_id and grading_version = gv;
    if found then
      oldstate := jsonb_build_object('prediction_id', prev.prediction_id, 'prediction_status', prev.prediction_status,
        'ats_side', prev.ats_side, 'ats_side_source', prev.ats_side_source, 'close_home_spread', prev.close_home_spread,
        'close_snapshot_id', prev.close_snapshot_id, 'ats_result', prev.ats_result, 'ats_exclusion', prev.ats_exclusion,
        'margin_error', prev.margin_error, 'mae_exclusion', prev.mae_exclusion, 'brier', prev.brier,
        'brier_exclusion', prev.brier_exclusion, 'game_state', prev.game_state);
    else
      -- the first football-v2 settlement of this pair: the old state is the
      -- grade the Collective served before, from the legacy grading
      select lg2.pick_result, lg2.margin_error, lg2.brier into lg
        from collective.fg2_src_legacy_grades lg2
        join collective.fg2_src_predictions p on p.prediction_id = lg2.prediction_id
       where p.model_id = mdl.model_id and p.game_id = any(members)
         and (lg2.pick_result is not null or lg2.margin_error is not null or lg2.brier is not null)
       order by (p.prediction_id = case when pstatus = 'OK' then ch.prediction_id end) desc nulls last, p.received_at desc
       limit 1;
      oldstate := case when found then jsonb_build_object('legacy', true, 'ats_result', lg.pick_result,
        'margin_error', lg.margin_error, 'brier', lg.brier) else jsonb_build_object('legacy', true) end;
    end if;

    insert into collective.fg2_settlements (model_id, canonical_game_id, grading_version, prediction_id, sport, season, week,
      prediction_version, prediction_versions, post_lock_versions, prediction_status, submitted_at, kickoff_at, lock_at,
      fair_home_spread, predicted_home_margin, explicit_side, ats_side, ats_side_source, model_edge_home,
      close_home_spread, close_away_spread, close_observed_at, close_book, close_source, close_snapshot_id, close_source_event_id,
      game_state, home_score, away_score, actual_margin, ats_margin_home, cover, ats_result, ats_exclusion,
      margin_error, mae_exclusion, home_win_prob, outcome, brier, brier_exclusion, run_id)
    values (mdl.model_id, p_game_id, gv, case when pstatus = 'OK' then ch.prediction_id end, g.sport, g.season, g.week,
      ver, n_versions, n_post, pstatus, case when pstatus = 'OK' then ch.received_at end, g.kickoff_at, lk,
      fair, pmargin, expl, side, side_src, edge,
      closeh, case when closeh is not null then round(-closeh, 6) end, cl.observed_at, cl.book, cl.source,
      cl.source_snapshot_id, cl.source_event_id,
      st, hs, aws, mrg, atsm, cov, res, ats_ex, me, mae_ex, prob, outc, br, br_ex, p_run)
    on conflict (model_id, canonical_game_id, grading_version) do update set
      prediction_id = excluded.prediction_id, sport = excluded.sport, season = excluded.season, week = excluded.week,
      prediction_version = excluded.prediction_version, prediction_versions = excluded.prediction_versions,
      post_lock_versions = excluded.post_lock_versions, prediction_status = excluded.prediction_status,
      submitted_at = excluded.submitted_at, kickoff_at = excluded.kickoff_at, lock_at = excluded.lock_at,
      fair_home_spread = excluded.fair_home_spread, predicted_home_margin = excluded.predicted_home_margin,
      explicit_side = excluded.explicit_side, ats_side = excluded.ats_side, ats_side_source = excluded.ats_side_source,
      model_edge_home = excluded.model_edge_home, close_home_spread = excluded.close_home_spread,
      close_away_spread = excluded.close_away_spread, close_observed_at = excluded.close_observed_at,
      close_book = excluded.close_book, close_source = excluded.close_source, close_snapshot_id = excluded.close_snapshot_id,
      close_source_event_id = excluded.close_source_event_id, game_state = excluded.game_state,
      home_score = excluded.home_score, away_score = excluded.away_score, actual_margin = excluded.actual_margin,
      ats_margin_home = excluded.ats_margin_home, cover = excluded.cover, ats_result = excluded.ats_result,
      ats_exclusion = excluded.ats_exclusion, margin_error = excluded.margin_error, mae_exclusion = excluded.mae_exclusion,
      home_win_prob = excluded.home_win_prob, outcome = excluded.outcome, brier = excluded.brier,
      brier_exclusion = excluded.brier_exclusion, updated_at = now(), run_id = excluded.run_id
    where (collective.fg2_settlements.prediction_id, collective.fg2_settlements.prediction_status, collective.fg2_settlements.ats_side,
           collective.fg2_settlements.close_home_spread, collective.fg2_settlements.close_snapshot_id,
           collective.fg2_settlements.ats_result, collective.fg2_settlements.ats_exclusion, collective.fg2_settlements.margin_error,
           collective.fg2_settlements.mae_exclusion, collective.fg2_settlements.brier, collective.fg2_settlements.brier_exclusion,
           collective.fg2_settlements.game_state, collective.fg2_settlements.home_score, collective.fg2_settlements.away_score,
           collective.fg2_settlements.prediction_version, collective.fg2_settlements.post_lock_versions)
          is distinct from
          (excluded.prediction_id, excluded.prediction_status, excluded.ats_side, excluded.close_home_spread,
           excluded.close_snapshot_id, excluded.ats_result, excluded.ats_exclusion, excluded.margin_error,
           excluded.mae_exclusion, excluded.brier, excluded.brier_exclusion, excluded.game_state,
           excluded.home_score, excluded.away_score, excluded.prediction_version, excluded.post_lock_versions);

    -- the audit trail: every settlement that is new or changed, with why
    if oldstate is distinct from newstate and
       (oldstate ? 'legacy' or (oldstate - 'legacy') is distinct from newstate) then
      why := case
        when oldstate ? 'legacy' and (oldstate->>'ats_result') is null and res is not null then
          'ats_recovered:' || coalesce(cl.close_class, '?') || ':' || coalesce(side_src, '')
        when oldstate ? 'legacy' and (oldstate->>'ats_result') is not null and res is null then 'ats_withdrawn:' || coalesce(ats_ex, '')
        when oldstate ? 'legacy' and (oldstate->>'ats_result') is distinct from res then 'ats_changed'
        when oldstate ? 'legacy' and ((oldstate->>'margin_error')::numeric is distinct from me or (oldstate->>'brier')::numeric is distinct from br) then 'metric_changed'
        when oldstate ? 'legacy' then 'initial_settlement'
        when (oldstate->>'close_home_spread') is distinct from (newstate->>'close_home_spread') then 'close_changed'
        when (oldstate->>'prediction_id') is distinct from (newstate->>'prediction_id') then 'prediction_version_changed'
        when (oldstate->>'game_state') is distinct from (newstate->>'game_state') then 'game_state_changed'
        else 'regraded' end;
      if not (oldstate ? 'legacy') or why <> 'initial_settlement'
         or not exists (select 1 from collective.fg2_grade_audit a where a.model_id = mdl.model_id and a.canonical_game_id = p_game_id and a.grading_version = gv) then
        insert into collective.fg2_grade_audit (run_id, model_id, canonical_game_id, prediction_id, grading_version, old_state, new_state, reason, source_snapshot_id)
        values (p_run, mdl.model_id, p_game_id, case when pstatus = 'OK' then ch.prediction_id end, gv, oldstate, newstate, why, cl.source_snapshot_id);
      end if;
    end if;
    n := n + 1;
  end loop;
  return n;
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('9 settlement', 'ok', 'fg2_settle_game: latest live pre-lock version, one close per game, three metrics each with its own exclusion reason; audited');

-- 10 ---- the legacy tables follow the settlement ---------------------------
-- So every existing reader (game_detail, board_models, model_records, the
-- rankings API) serves the same numbers without a redeploy. Only ever fills
-- an EMPTY results.closing_spread; grade rows are set to the settlement's
-- values for the graded version and cleared for every other version.
create or replace function collective.fg2_sync_legacy(p_league text, p_season integer, p_run uuid) returns jsonb
language plpgsql as $fn$
declare
  gv text := collective.fg2_version();
  rr regclass := coalesce(to_regclass('collective.results'), to_regclass('collective.game_results'));
  gr regclass := to_regclass('collective.grades');
  pr regclass := to_regclass('collective.projections');
  n_close int := 0; n_grade int := 0; n_clear int := 0; n_ins int := 0;
  c_res text; c_me text; c_br text; c_at text; ptype text;
  target text; key text;
begin
  perform set_config('collective.maintenance', 'on', true);
  if rr is not null and collective.fg2_col(rr, array['closing_spread']) is not null then
    execute format($q$
      with w as (
        update %1$s r set closing_spread = c.home_spread
          from collective.fg2_official_closes c
          join collective.fg2_src_games g on g.game_id = c.canonical_game_id
         where r.game_id::text = c.canonical_game_id and r.closing_spread is null and c.home_spread is not null
           and collective.fg2_league(g.sport) = %2$L and g.season = %3$s
        returning r.game_id::text as game_id, c.home_spread
      )
      insert into collective.fg2_results_writes (game_id, closing_spread, run_id)
      select game_id, home_spread, %4$L::uuid from w
      on conflict (game_id) do update set closing_spread = excluded.closing_spread, written_at = now(), run_id = excluded.run_id
    $q$, rr::text, p_league, p_season, p_run);
    get diagnostics n_close = row_count;
  end if;
  -- where grades live: collective.grades(projection_id, ...) or grade columns on projections
  if gr is not null and collective.fg2_col(gr, array['projection_id']) is not null then
    target := gr::text; key := 'projection_id';
  elsif collective.fg2_col(pr, array['pick_result']) is not null then
    target := pr::text; key := 'id';
  end if;
  if target is not null then
    c_res := collective.fg2_col(target::regclass, array['pick_result', 'ats_result']);
    c_me := collective.fg2_col(target::regclass, array['margin_error']);
    c_br := collective.fg2_col(target::regclass, array['brier']);
    c_at := collective.fg2_col(target::regclass, array['graded_at']);
    if c_res is null and c_me is null and c_br is null then
      perform set_config('collective.maintenance', '', true);
      return jsonb_build_object('results_closes_filled', n_close, 'grades_relation', target, 'skipped', 'no grade columns');
    end if;
    select format_type(a.atttypid, a.atttypmod) into ptype from pg_attribute a
     where a.attrelid = target::regclass and a.attname = key and not a.attisdropped;
    -- the graded version takes the settlement's values
    execute format($q$
      update %1$s t set %2$s
        from collective.fg2_settlements s
       where s.grading_version = %3$L and collective.fg2_league(s.sport) = %4$L and s.season = %5$s
         and s.prediction_id is not null and t.%6$I::text = s.prediction_id
         and (%7$s)
    $q$, target,
      concat_ws(', ',
        case when c_res is not null then format('%I = s.ats_result', c_res) end,
        case when c_me is not null then format('%I = s.margin_error', c_me) end,
        case when c_br is not null then format('%I = s.brier', c_br) end,
        case when c_at is not null then format('%I = now()', c_at) end),
      gv, p_league, p_season, key,
      concat_ws(' or ',
        case when c_res is not null then format('t.%I::text is distinct from s.ats_result', c_res) end,
        case when c_me is not null then format('t.%I is distinct from s.margin_error', c_me) end,
        case when c_br is not null then format('t.%I is distinct from s.brier', c_br) end, 'false'));
    get diagnostics n_grade = row_count;
    -- a graded version with no grade row yet gets one (grades table only)
    if key = 'projection_id' then
      execute format($q$
        insert into %1$s (projection_id%2$s)
        select s.prediction_id::%7$s%3$s
          from collective.fg2_settlements s
         where s.grading_version = %4$L and collective.fg2_league(s.sport) = %5$L and s.season = %6$s
           and s.prediction_id is not null
           and (s.ats_result is not null or s.margin_error is not null or s.brier is not null)
           and not exists (select 1 from %1$s t where t.projection_id::text = s.prediction_id)
      $q$, target,
        concat(case when c_res is not null then ', ' || quote_ident(c_res) end,
               case when c_me is not null then ', ' || quote_ident(c_me) end,
               case when c_br is not null then ', ' || quote_ident(c_br) end),
        concat(case when c_res is not null then ', s.ats_result' end,
               case when c_me is not null then ', s.margin_error' end,
               case when c_br is not null then ', s.brier' end),
        gv, p_league, p_season, ptype);
      get diagnostics n_ins = row_count;
    end if;
    -- every OTHER version of a settled model/game carries no grade: exactly
    -- one version per model per game is graded
    execute format($q$
      update %1$s t set %2$s
        from collective.fg2_src_predictions p
        join collective.fg2_settlements s on s.model_id = p.model_id
             and s.canonical_game_id = collective.fg2_canonical(p.game_id)
       where s.grading_version = %3$L and collective.fg2_league(s.sport) = %4$L and s.season = %5$s
         and t.%6$I::text = p.prediction_id and p.prediction_id is distinct from s.prediction_id
         and (%7$s)
    $q$, target,
      concat_ws(', ',
        case when c_res is not null then format('%I = null', c_res) end,
        case when c_me is not null then format('%I = null', c_me) end,
        case when c_br is not null then format('%I = null', c_br) end),
      gv, p_league, p_season, key,
      concat_ws(' or ',
        case when c_res is not null then format('t.%I is not null', c_res) end,
        case when c_me is not null then format('t.%I is not null', c_me) end,
        case when c_br is not null then format('t.%I is not null', c_br) end, 'false'));
    get diagnostics n_clear = row_count;
  end if;
  perform set_config('collective.maintenance', '', true);
  return jsonb_build_object('results_closes_filled', n_close, 'grade_rows_updated', n_grade,
    'grade_rows_inserted', n_ins, 'non_graded_versions_cleared', n_clear, 'grades_relation', coalesce(target, 'none'));
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('10 legacy sync', 'ok', 'fg2_sync_legacy: fills empty results.closing_spread, grades follow the settlement (commit runs only)');

-- 11 ---- the rebuild ---------------------------------------------------------
-- The order the repair takes, every time, for one sport and season:
--   1 canonical games   2 market events + snapshots   3 links   4 closes
--   5-7 predictions, lock, settlement   8-12 metrics, diagnostics, consensus
--   and rankings (views over the settlement)   then, on commit, legacy sync.
-- Safe to rerun: every write is an upsert on a deterministic key, snapshots
-- are insert-only, and an unchanged settlement writes nothing and audits
-- nothing. Without p_commit the whole run is rolled back after the report.
-- The ordered rebuild. p_recent_days null = the whole season (what the
-- regrade runs); a number = the hourly refresh: the games that kicked off in
-- the last p_recent_days days, plus every finished game the settlement has
-- never processed, and only the market rows that can bear on them. Same
-- functions, same order, same audit; the scope is in the report.
create or replace function collective.fg2_rebuild_run(p_sport text, p_season integer, p_commit boolean,
  p_recent_days numeric) returns jsonb
language plpgsql as $fn$
declare
  lg text := collective.fg2_league(p_sport);
  run uuid := gen_random_uuid();
  rep jsonb;
  gid text; n int := 0; nc int := 0;
  diag jsonb;
  scope_from timestamptz;
  import_from timestamptz;
begin
  if lg not in ('NFL', 'CFB') then raise exception 'fg2_rebuild: % is not a football sport', p_sport; end if;
  perform pg_advisory_xact_lock(hashtext('fg2_rebuild:' || lg || ':' || p_season));
  if p_recent_days is not null then
    select least(now() - make_interval(secs => p_recent_days * 86400), min(g.kickoff_at)) into scope_from
      from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = lg and g.season = p_season and g.kickoff_at <= now()
       and not exists (select 1 from collective.fg2_game_alias a where a.game_id = g.game_id)
       and not exists (select 1 from collective.fg2_official_closes c where c.canonical_game_id = g.game_id);
    -- a market event may list the game up to the kickoff tolerance away
    import_from := scope_from - make_interval(secs => collective.fg2_tolerance_minutes() * 60);
  end if;
  rep := jsonb_build_object('run_id', run, 'sport', lg, 'season', p_season, 'grading_version', collective.fg2_version(),
    'install_revision', collective.fg2_install_revision(), 'committed', p_commit, 'started_at', now(),
    'scope', case when scope_from is null then 'season' else 'games from ' || scope_from end);
  insert into collective.fg2_rebuild_runs (run_id, sport, season, committed) values (run, lg, p_season, p_commit);
  rep := rep || jsonb_build_object('1_duplicates_aliased', collective.fg2_detect_duplicates(lg, p_season));
  rep := rep || jsonb_build_object('registry', collective.fg2_build_registry(lg));
  rep := rep || jsonb_build_object('2_sources', collective.fg2_import_snapshots(lg, p_season, import_from));
  rep := rep || jsonb_build_object('3_links', collective.fg2_link_events(lg, p_season, import_from));
  for gid in
    select g.game_id from collective.fg2_src_games g
     where collective.fg2_league(g.sport) = lg and g.season = p_season and g.kickoff_at <= now()
       and (scope_from is null or g.kickoff_at >= scope_from)
       and not exists (select 1 from collective.fg2_game_alias a where a.game_id = g.game_id)
     order by g.kickoff_at, g.game_id
  loop
    perform collective.fg2_compute_close(gid);
    nc := nc + 1;
    n := n + collective.fg2_settle_game(gid, run);
  end loop;
  rep := rep || jsonb_build_object('4_closes_computed', nc, '7_settlements_evaluated', n);
  rep := rep || jsonb_build_object('audit_rows_this_run', (select count(*) from collective.fg2_grade_audit where run_id = run));
  if p_commit then
    rep := rep || jsonb_build_object('legacy_sync', collective.fg2_sync_legacy(lg, p_season, run));
  end if;
  select jsonb_agg(to_jsonb(d) order by d.week nulls last) into diag
    from collective.fg2_slate_diagnostics d where d.league = lg and d.season = p_season;
  rep := rep || jsonb_build_object('diagnostics', coalesce(diag, '[]'::jsonb),
    'standings', (select jsonb_agg(to_jsonb(s) order by s.model_slug) from collective.fg2_model_standings s
                   where s.league = lg and s.season = p_season),
    'consensus', (select to_jsonb(c) from collective.fg2_consensus_record c where c.league = lg and c.season = p_season),
    'close_classes', (select jsonb_object_agg(x.cls, x.cnt) from (
        select c.close_class as cls, count(*) as cnt from collective.fg2_official_closes c
          join collective.fg2_src_games g on g.game_id = c.canonical_game_id
         where collective.fg2_league(g.sport) = lg and g.season = p_season
           and exists (select 1 from collective.fg2_settlements s where s.canonical_game_id = c.canonical_game_id and s.game_state = 'FINAL')
         group by c.close_class) x),
    'finished_at', now());
  update collective.fg2_rebuild_runs set finished_at = now(), report = rep where run_id = run;
  if not p_commit then
    raise exception using errcode = 'P0001', message = 'fg2_dry_run', detail = rep::text;
  end if;
  return rep;
end $fn$;

-- The whole season. Run it from psql with statement_timeout raised
-- (tools/collective/football_rebuild.js does): a season of capture history
-- is more than an API request's timeout.
create or replace function collective.fg2_rebuild(p_sport text, p_season integer, p_commit boolean default false) returns jsonb
language plpgsql as $fn$
begin
  return collective.fg2_rebuild_run(p_sport, p_season, p_commit, null);
end $fn$;

-- The hourly refresh the settle job calls through the API: always commits,
-- bounded to recent and never-processed games.
create or replace function collective.fg2_refresh(p_sport text, p_season integer, p_recent_days integer default 4) returns jsonb
language plpgsql as $fn$
begin
  if p_recent_days is null or p_recent_days < 1 then raise exception 'fg2_refresh: p_recent_days must be at least 1'; end if;
  return collective.fg2_rebuild_run(p_sport, p_season, true, p_recent_days);
end $fn$;

-- The dry run: the whole rebuild inside a subtransaction that is rolled
-- back, returning the report it would have committed.
create or replace function collective.fg2_rebuild_preview(p_sport text, p_season integer) returns jsonb
language plpgsql as $fn$
declare d text;
begin
  begin
    perform collective.fg2_rebuild(p_sport, p_season, false);
  exception when sqlstate 'P0001' then
    get stacked diagnostics d = pg_exception_detail;
    if d is null or d = '' then raise; end if;
    return d::jsonb || jsonb_build_object('dry_run', true, 'note', 'rolled back: nothing was written');
  end;
  return null;
end $fn$;

-- One game, the same way: what grade_game delegates to for football.
create or replace function collective.fg2_settle_one(p_game_id text, p_commit boolean default true) returns jsonb
language plpgsql as $fn$
declare g record; lg text; run uuid := gen_random_uuid(); n int; c jsonb; canon text;
begin
  select * into g from collective.fg2_src_games where game_id = p_game_id;
  if not found then return jsonb_build_object('graded', 0, 'reason', 'no such game'); end if;
  lg := collective.fg2_league(g.sport);
  canon := collective.fg2_canonical(p_game_id);
  /* One game, fast: the close from the snapshots already imported and
     linked, and the settlement. The season-wide import and linking is the
     rebuild's job (the settle workflow runs it after every settle), so a
     Saturday of settles is not a Saturday of full-season imports. The legacy
     close this game carries right now is refreshed first, because that is
     what the caller has usually just written. */
  perform collective.fg2_import_legacy(lg, g.season);
  c := collective.fg2_compute_close(canon);
  n := collective.fg2_settle_game(canon, run);
  if p_commit then perform collective.fg2_sync_legacy(lg, g.season, run); end if;
  return jsonb_build_object('graded', n, 'close', c, 'grading_version', collective.fg2_version(), 'run_id', run);
end $fn$;

insert into fg2_install_report (step, outcome, detail) values
  ('11 rebuild', 'ok', 'fg2_rebuild(sport, season, commit) / fg2_rebuild_preview(sport, season) / fg2_refresh(sport, season, days) / fg2_settle_one(game)');

-- 12 ---- the views every reader uses --------------------------------------------
create or replace view collective.fg2_grading_trace as
select s.sport, s.season, s.week, s.canonical_game_id,
       coalesce(g.away_label, '?') || ' @ ' || coalesce(g.home_label, '?') as event,
       m.creator_slug, m.model_slug, s.model_id,
       s.prediction_id, s.prediction_version, s.prediction_versions, s.post_lock_versions, s.prediction_status,
       s.submitted_at, s.kickoff_at, s.lock_at,
       s.fair_home_spread, s.predicted_home_margin, s.explicit_side, s.ats_side, s.ats_side_source, s.model_edge_home,
       s.close_home_spread, s.close_away_spread, s.close_observed_at, s.close_book, s.close_source, s.close_snapshot_id,
       s.close_source_event_id, c.close_status, c.close_class, c.close_class_reason, c.lead_minutes as close_lead_minutes,
       s.game_state, s.home_score, s.away_score, s.actual_margin,
       case when s.ats_margin_home is not null
            then trim_scale(s.actual_margin) || ' + (' || trim_scale(s.close_home_spread) || ') = ' || trim_scale(s.ats_margin_home) || ' -> ' || s.cover end as ats_calculation,
       s.ats_result, s.ats_exclusion, s.margin_error, s.mae_exclusion, s.home_win_prob, s.outcome, s.brier, s.brier_exclusion,
       s.grading_version, s.settled_at, s.updated_at
  from collective.fg2_settlements s
  left join collective.fg2_src_games g on g.game_id = s.canonical_game_id
  left join collective.fg2_official_closes c on c.canonical_game_id = s.canonical_game_id and c.market_type = 'spread'
  left join lateral (
    select cr.slug::text as creator_slug, mo.slug::text as model_slug
      from collective.models mo left join collective.creators cr on cr.id = mo.creator_id
     where mo.id::text = s.model_id) m on true;

create or replace view collective.fg2_model_standings as
select collective.fg2_league(s.sport) as league, s.season, s.model_id,
       max(m.creator_slug) as creator_slug, max(m.model_slug) as model_slug,
       count(*) filter (where s.ats_result = 'win') as wins,
       count(*) filter (where s.ats_result = 'loss') as losses,
       count(*) filter (where s.ats_result = 'push') as pushes,
       count(*) filter (where s.ats_result is not null) as ats_n,
       round(count(*) filter (where s.ats_result = 'win')::numeric
             / nullif(count(*) filter (where s.ats_result in ('win', 'loss')), 0), 6) as ats_pct,
       count(*) filter (where s.ats_side_source = 'explicit' and s.ats_result is not null) as ats_explicit_n,
       count(*) filter (where s.ats_side_source = 'derived' and s.ats_result is not null) as ats_derived_n,
       count(*) filter (where s.ats_exclusion = 'MISSING_CLOSE') as ats_missing_close,
       count(*) filter (where s.ats_exclusion = 'NO_ATS_SIDE') as ats_no_side,
       count(*) filter (where s.ats_exclusion = 'LATE_SUBMISSION') as ats_late,
       count(*) filter (where s.ats_exclusion in ('GAME_UNFINISHED', 'GAME_POSTPONED', 'GAME_CANCELLED')) as ats_game_not_final,
       count(*) filter (where s.ats_exclusion in ('EXCLUDED_ORIGIN', 'UNTIMED_SUBMISSION')) as ats_excluded_other,
       round(avg(s.margin_error), 6) as mae, count(s.margin_error) as mae_n,
       round(avg(s.brier), 6) as brier, count(s.brier) as brier_n,
       count(*) filter (where s.game_state = 'FINAL') as played,
       count(*) filter (where s.game_state = 'FINAL' and s.prediction_status = 'OK') as valid_predictions,
       round(100.0 * count(*) filter (where s.game_state = 'FINAL' and s.prediction_status = 'OK')
             / nullif((select count(*) from collective.fg2_src_games g2
                        where collective.fg2_league(g2.sport) = collective.fg2_league(max(s.sport)) and g2.season = s.season
                          and collective.fg2_game_state(g2.status, g2.home_score, g2.away_score) = 'FINAL'
                          and not exists (select 1 from collective.fg2_game_alias a where a.game_id = g2.game_id)
                          and g2.kickoff_at >= min(s.kickoff_at)), 0), 6) as coverage_pct,
       max(s.grading_version) as grading_version
  from collective.fg2_settlements s
  left join lateral (
    select cr.slug::text as creator_slug, mo.slug::text as model_slug
      from collective.models mo left join collective.creators cr on cr.id = mo.creator_id
     where mo.id::text = s.model_id) m on true
 where s.grading_version = collective.fg2_version()
 group by collective.fg2_league(s.sport), s.season, s.model_id;

-- The rankings, from the settlement. Each metric is ranked on its OWN sample
-- (a model with no pick side still ranks on margin error and Brier), behind
-- the Collective's published minimums (ranking.min_coverage_pct,
-- ranking.min_graded_games).
create or replace function collective.fg2_config_num(p_key text, p_default numeric) returns numeric
language plpgsql stable as $fn$
declare v jsonb;
begin
  if to_regprocedure('collective.get_config(text)') is not null then
    begin
      execute 'select collective.get_config($1)' into v using p_key;
    exception when others then v := null;
    end;
  end if;
  return coalesce(nullif(regexp_replace(coalesce(v #>> '{}', ''), '[^0-9.]', '', 'g'), '')::numeric, p_default);
end $fn$;

create or replace view collective.fg2_model_rankings as
with s as (
  select st.*,
         collective.fg2_config_num('ranking.min_coverage_pct', 60) as min_cov,
         collective.fg2_config_num('ranking.min_graded_games', 20) as min_n
    from collective.fg2_model_standings st
), e as (
  select s.*,
         coalesce(s.coverage_pct, 0) >= s.min_cov as cov_ok,
         (coalesce(s.coverage_pct, 0) >= s.min_cov and s.ats_n >= s.min_n and s.ats_pct is not null) as win_ok,
         (coalesce(s.coverage_pct, 0) >= s.min_cov and s.mae_n >= s.min_n) as mae_ok,
         (coalesce(s.coverage_pct, 0) >= s.min_cov and s.brier_n >= s.min_n) as brier_ok
    from s
)
select e.league, e.season, e.model_id, e.creator_slug, e.model_slug,
       e.wins, e.losses, e.pushes, e.ats_n, e.ats_pct, e.mae, e.mae_n, e.brier, e.brier_n, e.coverage_pct,
       e.ats_missing_close, e.ats_no_side, e.ats_late, e.ats_game_not_final, e.ats_excluded_other,
       (e.win_ok or e.mae_ok or e.brier_ok) as is_ranked,
       case when not e.cov_ok then 'coverage below ' || e.min_cov || '%'
            when not (e.win_ok or e.mae_ok or e.brier_ok) then 'fewer than ' || e.min_n || ' graded games on every metric' end as unranked_reason,
       case when e.win_ok then rank() over (partition by e.league, e.season, e.win_ok order by e.ats_pct desc) end as rank_win_pct,
       case when e.mae_ok then rank() over (partition by e.league, e.season, e.mae_ok order by e.mae asc) end as rank_margin_mae,
       case when e.brier_ok then rank() over (partition by e.league, e.season, e.brier_ok order by e.brier asc) end as rank_brier,
       e.min_cov as min_coverage_pct, e.min_n as min_graded_games, e.grading_version
  from e;

create or replace view collective.fg2_consensus_games as
with ats as (
  select s.canonical_game_id, collective.fg2_league(max(s.sport)) as league, max(s.season) as season,
         count(*) filter (where s.ats_result is not null) as n_eligible,
         count(*) filter (where s.ats_result is not null and s.ats_side = 'home') as n_home,
         count(*) filter (where s.ats_result is not null and s.ats_side = 'away') as n_away,
         max(s.cover) filter (where s.ats_result is not null) as cover,
         count(s.brier) as ml_n, round(avg(s.home_win_prob) filter (where s.brier is not null), 6) as ml_prob_mean,
         max(s.outcome) filter (where s.brier is not null) as outcome
    from collective.fg2_settlements s
   where s.grading_version = collective.fg2_version()
   group by s.canonical_game_id
)
select a.*,
       case when a.n_eligible >= 2 and a.n_home <> a.n_away then (case when a.n_home > a.n_away then 'home' else 'away' end) end as side,
       case when a.n_eligible >= 2 and a.n_home <> a.n_away
            then collective.fg2_grade_side(case when a.n_home > a.n_away then 'home' else 'away' end, a.cover) end as ats_result,
       case when a.n_eligible < 2 then 'FEWER_THAN_2' when a.n_home = a.n_away then 'EVEN_SPLIT' end as ats_exclusion,
       case when a.ml_n >= 2 and a.ml_prob_mean <> 0.5 then (case when a.ml_prob_mean > 0.5 then 'home' else 'away' end) end as ml_pick,
       case when a.ml_n >= 2 and a.ml_prob_mean <> 0.5
            then (case when (a.ml_prob_mean > 0.5) = (a.outcome = 1) then 'win' else 'loss' end) end as ml_result,
       case when a.ml_n < 2 then 'FEWER_THAN_2' when a.ml_prob_mean = 0.5 then 'EVEN_SPLIT' end as ml_exclusion
  from ats a;

create or replace view collective.fg2_consensus_record as
select league, season,
       count(*) filter (where ats_result = 'win') as ats_wins,
       count(*) filter (where ats_result = 'loss') as ats_losses,
       count(*) filter (where ats_result = 'push') as ats_pushes,
       round(count(*) filter (where ats_result = 'win')::numeric / nullif(count(*) filter (where ats_result in ('win', 'loss')), 0), 6) as ats_pct,
       count(*) filter (where ats_exclusion = 'FEWER_THAN_2') as ats_fewer_than_2,
       count(*) filter (where ats_exclusion = 'EVEN_SPLIT') as ats_even_split,
       count(*) filter (where ml_result = 'win') as ml_wins,
       count(*) filter (where ml_result = 'loss') as ml_losses,
       round(count(*) filter (where ml_result = 'win')::numeric / nullif(count(*) filter (where ml_result is not null), 0), 6) as ml_pct
  from collective.fg2_consensus_games
 group by league, season;

create or replace view collective.fg2_calibration as
select collective.fg2_league(s.sport) as league, s.season, s.model_id, b.lo, b.hi,
       count(*) as n,
       round(avg(greatest(s.home_win_prob, 1 - s.home_win_prob)), 6) as claimed,
       round(avg(case when (s.home_win_prob >= 0.5) = (s.outcome = 1) then 1.0 else 0.0 end), 6) as actual
  from collective.fg2_settlements s
  join (values (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.0000001)) b(lo, hi)
    on greatest(s.home_win_prob, 1 - s.home_win_prob) >= b.lo and greatest(s.home_win_prob, 1 - s.home_win_prob) < b.hi
 where s.grading_version = collective.fg2_version() and s.brier is not null
 group by collective.fg2_league(s.sport), s.season, s.model_id, b.lo, b.hi;

create or replace view collective.fg2_close_classification as
select collective.fg2_league(g.sport) as league, g.season, g.week, c.canonical_game_id,
       coalesce(g.away_label, '?') || ' @ ' || coalesce(g.home_label, '?') as event,
       c.close_class, c.close_class_reason, c.close_status, c.home_spread, c.source, c.book, c.observed_at, c.lead_minutes,
       c.legacy_close, c.considered, c.rejected,
       (select count(*) from collective.fg2_settlements s where s.canonical_game_id = c.canonical_game_id
          and s.grading_version = collective.fg2_version()) as model_games
  from collective.fg2_official_closes c
  join collective.fg2_src_games g on g.game_id = c.canonical_game_id;

create or replace view collective.fg2_slate_diagnostics as
with sg as (
  select collective.fg2_league(g.sport) as league, g.season, g.week, g.game_id,
         collective.fg2_game_state(g.status, g.home_score, g.away_score) as state, g.kickoff_at,
         exists (select 1 from collective.fg2_settlements s where s.canonical_game_id = g.game_id
                  and s.grading_version = collective.fg2_version() and s.prediction_status = 'OK') as has_pred,
         (select c.home_spread is not null from collective.fg2_official_closes c
           where c.canonical_game_id = g.game_id and c.market_type = 'spread') as has_close
    from collective.fg2_src_games g
   where not exists (select 1 from collective.fg2_game_alias a where a.game_id = g.game_id)
), ss as (
  select collective.fg2_league(s.sport) as league, s.season, s.week,
         count(*) filter (where s.game_state = 'FINAL' and s.prediction_status = 'OK') as valid_rows,
         count(*) filter (where s.game_state = 'FINAL' and s.prediction_status = 'OK' and s.close_home_spread is not null and s.ats_side is not null) as gradable,
         count(*) filter (where s.ats_result is not null) as graded,
         count(*) filter (where s.game_state = 'FINAL' and s.prediction_status = 'OK' and s.close_home_spread is not null
                          and s.ats_side is not null and s.ats_result is null) as gradable_not_graded,
         count(*) filter (where s.margin_error is not null and s.ats_result is null and s.close_home_spread is not null
                          and coalesce(s.ats_exclusion, '') <> 'NO_ATS_SIDE') as mae_without_ats,
         count(*) filter (where s.prediction_status = 'LATE_SUBMISSION') as late
    from collective.fg2_settlements s
   where s.grading_version = collective.fg2_version()
   group by 1, 2, 3
), le as (
  select e.league, e.season, count(*) as events,
         count(*) filter (where l.status = 'linked') as linked,
         count(*) filter (where l.status = 'unresolved') as unresolved,
         count(*) filter (where l.status = 'conflict') as conflicts
    from collective.fg2_market_events e
    left join collective.fg2_event_links l on l.source = e.source and l.source_event_id = e.source_event_id
   where e.kickoff_at <= now()
   group by 1, 2
), dup as (
  select collective.fg2_league(g.sport) as league, g.season, count(*) as n
    from collective.fg2_game_alias a join collective.fg2_src_games g on g.game_id = a.game_id group by 1, 2
), agg as (
  select sg.league, sg.season, sg.week,
         count(*) filter (where sg.state = 'FINAL') as completed_games,
         count(*) filter (where sg.state = 'FINAL' and sg.has_pred) as completed_with_prediction,
         count(*) filter (where sg.state = 'FINAL' and sg.has_pred and sg.has_close) as with_captured_close,
         count(*) filter (where sg.kickoff_at < now() - interval '4 hours' and sg.state not in ('GAME_CANCELLED', 'GAME_POSTPONED')) as due,
         count(*) filter (where sg.kickoff_at < now() - interval '4 hours' and sg.state = 'FINAL') as due_final
    from sg group by 1, 2, 3
)
select a.league, a.season, a.week, a.completed_games, a.completed_with_prediction, a.with_captured_close,
       round(100.0 * a.with_captured_close / nullif(a.completed_with_prediction, 0), 2) as market_capture_pct,
       round(100.0 * a.completed_with_prediction / nullif(a.completed_games, 0), 2) as prediction_coverage_pct,
       round(100.0 * le.linked / nullif(le.events, 0), 2) as canonical_match_pct_season,
       coalesce(ss.valid_rows, 0) as valid_model_games, coalesce(ss.gradable, 0) as ats_gradable,
       round(100.0 * ss.gradable / nullif(ss.valid_rows, 0), 2) as ats_gradable_pct,
       coalesce(ss.graded, 0) as ats_graded,
       round(100.0 * ss.graded / nullif(ss.gradable, 0), 2) as ats_graded_pct,
       round(100.0 * a.due_final / nullif(a.due, 0), 2) as final_score_settlement_pct,
       coalesce(dup.n, 0) as duplicate_event_count_season,
       coalesce(le.unresolved, 0) + coalesce(le.conflicts, 0) as orphan_event_count_season,
       coalesce(ss.late, 0) as late_submission_count,
       coalesce(ss.gradable_not_graded, 0) as gradable_but_ungraded,
       coalesce(ss.mae_without_ats, 0) as mae_without_ats_despite_close,
       array_remove(array[
         case when 100.0 * a.with_captured_close / nullif(a.completed_with_prediction, 0) < 95 then 'HIGH:MARKET_CAPTURE_LOW' end,
         case when 100.0 * le.linked / nullif(le.events, 0) < 99 then 'HIGH:CANONICAL_MATCH_LOW' end,
         case when coalesce(ss.gradable_not_graded, 0) > 0 then 'ERROR:GRADABLE_NOT_GRADED' end,
         case when coalesce(ss.mae_without_ats, 0) > 0 then 'ERROR:MAE_WITHOUT_ATS' end,
         case when coalesce(dup.n, 0) > 0 then 'HIGH:DUPLICATE_EVENTS' end,
         case when coalesce(le.unresolved, 0) + coalesce(le.conflicts, 0) > 0 then 'WARN:ORPHAN_EVENTS' end,
         case when a.due > a.due_final then 'WARN:FINALS_MISSING' end], null) as warnings
  from agg a
  left join ss on ss.league = a.league and ss.season = a.season and ss.week is not distinct from a.week
  left join le on le.league = a.league and le.season = a.season
  left join dup on dup.league = a.league and dup.season = a.season
 where a.completed_games > 0;

do $do$
declare v text;
begin
  foreach v in array array['fg2_grading_trace','fg2_model_standings','fg2_model_rankings','fg2_consensus_games','fg2_consensus_record',
    'fg2_calibration','fg2_close_classification','fg2_slate_diagnostics','fg2_src_games','fg2_src_predictions',
    'fg2_src_teams','fg2_src_team_aliases','fg2_src_legacy_grades'] loop
    begin execute format('revoke all on collective.%I from anon, authenticated', v);
    exception when undefined_object then null; end;
    begin execute format('grant select on collective.%I to service_role', v);
    exception when undefined_object then null; end;
  end loop;
end $do$;

insert into fg2_install_report (step, outcome, detail) values
  ('12 views', 'ok', 'fg2_grading_trace, fg2_model_standings, fg2_model_rankings, fg2_consensus_games/record, fg2_calibration, fg2_close_classification, fg2_slate_diagnostics (internal: no anon grants)');

-- The reconciliation for one sport and season, in one call: every count the
-- repair is judged by, each model's corrected record beside the LEGACY one
-- (reconstructed from the audit trail's old states, so "before" is what the
-- Collective actually served), the consensus, the diagnostics, and a
-- deterministic sample of graded model-games for manual verification.
create or replace function collective.fg2_report(p_sport text, p_season integer, p_sample integer default 20) returns jsonb
language plpgsql stable as $fn$
declare
  lg text := collective.fg2_league(p_sport);
  gv text := collective.fg2_version();
  out_ jsonb;
begin
  with s as (
    select * from collective.fg2_settlements
     where grading_version = gv and collective.fg2_league(sport) = lg and season = p_season
  ), fin as (
    select * from s where game_state = 'FINAL'
  ), g as (
    select distinct canonical_game_id from fin
  ), c as (
    select oc.* from collective.fg2_official_closes oc join g using (canonical_game_id) where oc.market_type = 'spread'
  )
  select jsonb_build_object(
    'sport', lg, 'season', p_season, 'grading_version', gv, 'generated_at', now(),
    'completed_events_with_submissions', (select count(*) from g),
    'model_game_predictions', (select count(*) from fin),
    'valid_prelock_predictions', (select count(*) from fin where prediction_status = 'OK'),
    'late_submissions', (select count(*) from fin where prediction_status = 'LATE_SUBMISSION'),
    'excluded_origin', (select count(*) from fin where prediction_status in ('EXCLUDED_ORIGIN', 'UNTIMED_SUBMISSION')),
    'games_with_captured_spread', (select count(*) from c where home_spread is not null),
    'recovered_closes', (select count(*) from c where close_class in ('B', 'C', 'D')),
    /* a close the Collective already published (often a quarter-point
       average across books) that a timed final-pregame snapshot now
       supersedes: listed, so the change is read rather than discovered */
    'legacy_closes_superseded', (select count(*) from c where legacy_close is not null and home_spread is distinct from legacy_close),
    'legacy_closes_superseded_list', coalesce((select jsonb_agg(jsonb_build_object('game', c.canonical_game_id,
        'event', coalesce(sg.away_label, '?') || ' @ ' || coalesce(sg.home_label, '?'),
        'legacy_close', c.legacy_close, 'official_close', c.home_spread, 'source', c.source, 'book', c.book,
        'observed_at', c.observed_at) order by sg.kickoff_at)
        from c join collective.fg2_src_games sg on sg.game_id = c.canonical_game_id
       where c.legacy_close is not null and c.home_spread is distinct from c.legacy_close), '[]'::jsonb),
    'no_market_capture', (select count(*) from c where close_class = 'J'),
    'close_classes', coalesce((select jsonb_object_agg(close_class, n order by close_class) from
        (select close_class, count(*) as n from c group by close_class) x), '{}'::jsonb),
    'close_sources', coalesce((select jsonb_object_agg(coalesce(source, 'none'), n) from
        (select source, count(*) as n from c group by source) x), '{}'::jsonb),
    'ats_graded', (select count(*) from fin where ats_result in ('win', 'loss')),
    'ats_pushes', (select count(*) from fin where ats_result = 'push'),
    'ats_ungraded', (select count(*) from fin where ats_result is null),
    'ats_ungraded_reasons', coalesce((select jsonb_object_agg(ats_exclusion, n) from
        (select ats_exclusion, count(*) as n from fin where ats_result is null group by ats_exclusion) x), '{}'::jsonb),
    'ats_side_sources', coalesce((select jsonb_object_agg(ats_side_source, n) from
        (select ats_side_source, count(*) as n from fin where ats_result is not null group by ats_side_source) x), '{}'::jsonb),
    'mae_graded', (select count(*) from fin where margin_error is not null),
    'brier_graded', (select count(*) from fin where brier is not null),
    'models', coalesce((select jsonb_agg(to_jsonb(ms) || jsonb_build_object('legacy', lg2.legacy) order by ms.creator_slug, ms.model_slug)
        from collective.fg2_model_standings ms
        left join lateral (
          select jsonb_build_object(
            'wins', count(*) filter (where a.old_state->>'ats_result' = 'win'),
            'losses', count(*) filter (where a.old_state->>'ats_result' = 'loss'),
            'pushes', count(*) filter (where a.old_state->>'ats_result' = 'push'),
            'mae', round(avg((a.old_state->>'margin_error')::numeric), 4),
            'mae_n', count(a.old_state->>'margin_error'),
            'brier', round(avg((a.old_state->>'brier')::numeric), 4),
            'brier_n', count(a.old_state->>'brier')) as legacy
            from collective.fg2_grade_audit a
            join s on s.model_id = a.model_id and s.canonical_game_id = a.canonical_game_id and s.game_state = 'FINAL'
           where a.model_id = ms.model_id and a.grading_version = gv and a.old_state ? 'legacy') lg2 on true
       where ms.league = lg and ms.season = p_season), '[]'::jsonb),
    'consensus', (select to_jsonb(cr) from collective.fg2_consensus_record cr where cr.league = lg and cr.season = p_season),
    'diagnostics', coalesce((select jsonb_agg(to_jsonb(d) order by d.week) from collective.fg2_slate_diagnostics d
        where d.league = lg and d.season = p_season), '[]'::jsonb),
    'audit_reasons', coalesce((select jsonb_object_agg(r, n) from
        (select split_part(a.reason, ':', 1) || coalesce(':' || nullif(split_part(a.reason, ':', 2), ''), '') as r, count(*) as n
           from collective.fg2_grade_audit a join s on s.model_id = a.model_id and s.canonical_game_id = a.canonical_game_id
          where a.grading_version = gv group by 1) x), '{}'::jsonb),
    'sample', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select t.sport, t.season, t.week, t.canonical_game_id, t.event, t.creator_slug, t.model_slug, t.prediction_id,
               t.prediction_version, t.submitted_at, t.kickoff_at, t.lock_at, t.fair_home_spread, t.explicit_side,
               t.ats_side, t.ats_side_source, t.model_edge_home, t.close_home_spread, t.close_observed_at, t.close_book,
               t.close_source, t.close_snapshot_id, t.close_class, t.home_score, t.away_score, t.actual_margin,
               t.ats_calculation, t.ats_result, t.margin_error, t.predicted_home_margin, t.home_win_prob, t.brier
          from collective.fg2_grading_trace t
         where t.grading_version = gv and collective.fg2_league(t.sport) = lg and t.season = p_season and t.ats_result is not null
         order by md5(t.canonical_game_id || t.model_id)
         limit p_sample) t), '[]'::jsonb)
  ) into out_;
  return out_;
end $fn$;

-- 13 ---- grade_game delegates football to the one grader ---------------------
-- collective_admin's results screen and the settle job call grade_game after
-- writing a result. For a football game it now runs fg2_settle_one, so there
-- is no second implementation left to disagree. The original is kept, renamed
-- grade_game_legacy_v1, and still answers for any other sport.
do $do$
declare
  fn regprocedure := coalesce(to_regprocedure('collective.grade_game(uuid)'), to_regprocedure('collective.grade_game(text)'));
  rtype text; argname text; argtype text; football text; body text;
begin
  if fn is null then
    insert into fg2_install_report (step, outcome, detail) values ('13 grade_game', 'skipped', 'no collective.grade_game(uuid|text) in this database');
    return;
  end if;
  if coalesce(obj_description(fn, 'pg_proc'), '') like 'fg2 wrapper%' then
    insert into fg2_install_report (step, outcome, detail) values ('13 grade_game', 'ok (already)', 'grade_game already delegates football to fg2_settle_one');
    return;
  end if;
  rtype := pg_get_function_result(fn);
  select coalesce(nullif(p.proargnames[1], ''), 'p_game_id'), format_type(p.proargtypes[0], null)
    into argname, argtype from pg_proc p where p.oid = fn;
  football := case
    when rtype = 'void' then format('perform collective.fg2_settle_one(%I::text); return;', argname)
    when rtype in ('integer', 'bigint', 'smallint', 'numeric') then
      format('return (collective.fg2_settle_one(%I::text)->>''graded'')::%s;', argname, rtype)
    when rtype in ('jsonb', 'json') then format('return collective.fg2_settle_one(%I::text)::%s;', argname, rtype)
    end;
  if football is null then
    insert into fg2_install_report (step, outcome, detail) values ('13 grade_game', 'SKIPPED',
      'grade_game returns ' || rtype || '; not wrapped. Call collective.fg2_settle_one(game_id) after a result is written.');
    return;
  end if;
  if to_regprocedure('collective.grade_game_legacy_v1(' || argtype || ')') is null then
    execute format('alter function %s rename to grade_game_legacy_v1', fn::text);
  else
    execute format('drop function %s', fn::text);
  end if;
  body := format($b$
    create function collective.grade_game(%1$I %2$s) returns %3$s
    language plpgsql security definer set search_path = collective, public as $w$
    declare sp text;
    begin
      select g.sport into sp from collective.fg2_src_games g where g.game_id = %1$I::text;
      if collective.fg2_league(sp) in ('NFL', 'CFB') then
        %4$s
      end if;
      %5$s
    end $w$
  $b$, argname, argtype, rtype, football,
    case when rtype = 'void' then format('perform collective.grade_game_legacy_v1(%I);', argname)
         else format('return collective.grade_game_legacy_v1(%I);', argname) end);
  execute body;
  execute format('comment on function collective.grade_game(%s) is %L', argtype,
    'fg2 wrapper: football games are settled by collective.fg2_settle_one (grading version football-v2); other sports by grade_game_legacy_v1.');
  execute format('revoke all on function collective.grade_game(%s) from public', argtype);
  begin execute format('revoke all on function collective.grade_game(%s) from anon, authenticated', argtype);
  exception when undefined_object then null; end;
  begin execute format('grant execute on function collective.grade_game(%s) to service_role', argtype);
  exception when undefined_object then null; end;
  insert into fg2_install_report (step, outcome, detail) values ('13 grade_game', 'ok',
    'grade_game(' || argtype || ') returns ' || rtype || ': football delegates to fg2_settle_one; original kept as grade_game_legacy_v1');
exception when others then
  insert into fg2_install_report (step, outcome, detail) values ('13 grade_game', 'FAILED (left as it was)', sqlerrm);
end $do$;

-- Nothing fg2 is callable by the public roles: the rebuild writes, and the
-- trace is internal. The service role (the settle job, the edge functions)
-- and the owner run everything.
do $do$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'collective' and p.proname like 'fg2\_%'
  loop
    execute format('revoke all on function %s from public', r.fn);
    begin execute format('revoke all on function %s from anon, authenticated', r.fn);
    exception when undefined_object then null; end;
    begin execute format('grant execute on function %s to service_role', r.fn);
    exception when undefined_object then null; end;
  end loop;
  insert into fg2_install_report (step, outcome, detail) values ('13 privileges', 'ok', 'fg2 functions: execute revoked from public/anon/authenticated, granted to service_role');
end $do$;

-- 14 ---- the uniqueness the Collective's own tables can take ------------------
-- Created only where the data already satisfies them; otherwise the report
-- names what stands in the way (the rebuild aliases duplicates rather than
-- deleting them).
do $do$
declare c_ref text := collective.fg2_col('collective.games'::regclass, array['external_ref']);
        c_sport text := collective.fg2_col('collective.games'::regclass, array['sport_code', 'sport']);
        c_home text := collective.fg2_col('collective.games'::regclass, array['home_team_id']);
        c_away text := collective.fg2_col('collective.games'::regclass, array['away_team_id']);
begin
  if c_ref is not null and c_sport is not null then
    begin
      execute format('create unique index if not exists fg2_games_provider_ref_uidx on collective.games (%I, %I) where %I is not null',
        c_sport, c_ref, c_ref);
      insert into fg2_install_report (step, outcome, detail) values ('14 unique provider ref', 'ok', 'one game per sport and provider event id');
    exception when others then
      insert into fg2_install_report (step, outcome, detail) values ('14 unique provider ref', 'NOT CREATED', sqlerrm || ' - duplicates exist; fg2_game_alias carries them');
    end;
  end if;
  if c_home is not null and c_away is not null and c_sport is not null then
    begin
      execute format('create unique index if not exists fg2_games_fixture_uidx on collective.games (%I, season, %I, %I, kickoff_at)',
        c_sport, c_home, c_away);
      insert into fg2_install_report (step, outcome, detail) values ('14 unique fixture', 'ok', 'one game per sport, season, home, away, kickoff');
    exception when others then
      insert into fg2_install_report (step, outcome, detail) values ('14 unique fixture', 'NOT CREATED', sqlerrm || ' - duplicates exist; fg2_game_alias carries them');
    end;
  end if;
end $do$;

commit;

-- the API serves new function signatures only after it re-reads the schema
notify pgrst, 'reload schema';

select n, step, outcome, detail from fg2_install_report order by n;

-- To rebuild (dry run first; the preview rolls itself back):
--   select collective.fg2_rebuild_preview('NFL', 2026);
--   select collective.fg2_rebuild_preview('CFB', 2026);
--   select collective.fg2_rebuild('NFL', 2026, true);
--   select collective.fg2_rebuild('CFB', 2026, true);
-- Then read:
--   select * from collective.fg2_slate_diagnostics where season = 2026 order by league, week;
--   select * from collective.fg2_model_standings where season = 2026 order by league, model_slug;
--   select close_class, count(*) from collective.fg2_close_classification where season = 2026 group by 1 order by 1;
--   select * from collective.fg2_grading_trace where canonical_game_id = '<game>' ;
