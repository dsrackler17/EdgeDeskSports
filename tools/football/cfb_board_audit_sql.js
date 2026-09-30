#!/usr/bin/env node
/* ============================================================================
   BUILDS supabase/audits/cfb_board_market_audit.sql — the READ-ONLY audit of
   the live FBS board's market path, for the Supabase SQL editor.

   Generated, not hand-written, for one reason: the audit has to resolve team
   names exactly the way the browser board does (football/fbs/fbs.js normKey,
   aliasKey, TEAM_ALIASES, the "St" expansion and the longest-unambiguous-
   prefix pass). The alias list is read from fbs.js at build time, so the SQL
   and the board cannot disagree about who is playing, and
   tools/football/cfb_board_audit_sql.test.js fails if the committed file is
   not byte-identical to what this builds.

     node tools/football/cfb_board_audit_sql.js           # print
     node tools/football/cfb_board_audit_sql.js --write   # write the file
     node tools/football/cfb_board_audit_sql.js --check   # exit 1 on drift
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'supabase', 'audits', 'cfb_board_market_audit.sql');
global.window = global.window || global;
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));

/* fbs.js normKey / aliasKey, as SQL expressions over any text expression */
const ACC_FROM = 'éíáóúñ’‘', ACC_TO = "eiaoun''";
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const NORM = (e) => `nullif(regexp_replace(translate(lower(${e}), ${lit(ACC_FROM)}, ${lit(ACC_TO)}), '[^a-z0-9]+', '', 'g'), '')`;
const ALIASK = (e) => `nullif(regexp_replace(replace(translate(lower(${e}), ${lit(ACC_FROM)}, ${lit(ACC_TO)}), '&', 'and'), '[^a-z0-9]+', '', 'g'), '')`;
/* app.html fbNorm: lower-case, strip everything but a-z0-9 (no accent map) */
const FBNORM = (e) => `regexp_replace(lower(${e}), '[^a-z0-9]+', '', 'g')`;
/* fbs.js expandState: "Boise St" / "Boise St." -> "Boise State" */
const EXPAND = (e) => `regexp_replace(${e}, '(^|[^a-z])st\\.?($|[^a-z])', '\\1State\\2', 'gi')`;
const SIDE = (hl, home, away) => `case when ${hl} is null then '—' when ${hl} = 0 then 'PK' when ${hl} < 0 then ${home} || ' ' || round((${hl})::numeric, 1)::text else ${away} || ' ' || round((-(${hl}))::numeric, 1)::text end`;
const CT = (e) => `coalesce(to_char(${e} at time zone 'America/Chicago', 'Dy MM/DD HH12:MIam') || ' CT', '—')`;

function aliasValues() {
  const A = FBS.TEAM_ALIASES, rows = [];
  Object.keys(A).forEach((k) => A[k].forEach((a) => rows.push('    (' + lit(k) + ', ' + lit(a) + ')')));
  return rows.join(',\n');
}

const SPOT = [['pittsburgh', 'virginiatech'], ['michigan', 'minnesota'], ['alabama', 'mississippistate'], ['pennstate', 'northwestern'],
  ['westvirginia', 'iowastate'], ['northtexas', 'tulsa'], ['miami', 'clemson'], ['ohiostate', 'iowa'], ['temple', 'southflorida'],
  ['marshall', 'jamesmadison'], ['purdue', 'illinois'], ['virginia', 'floridastate'], ['kentucky', 'southcarolina'], ['byu', 'tcu'],
  ['texastech', 'colorado'], ['sanjosestate', 'hawaii'], ['bowlinggreen', 'miamioh'], ['georgia', 'alabama']];

function build() {
  return `-- ===========================================================================
-- CFB BOARD MARKET AUDIT — READ-ONLY.            GENERATED, DO NOT HAND-EDIT:
--   node tools/football/cfb_board_audit_sql.js --write
--
-- Paste into the Supabase SQL editor and run. It is ONE select statement: it
-- creates nothing, writes nothing and takes no lock beyond an ordinary read,
-- so it is safe on production at any time. Edit only the params block.
--
-- FOR ONE WEEK (Tuesday 00:00 to Tuesday 00:00, America/Chicago, the window
-- containing week_of) IT REPORTS:
--   A  provider events pulled -> matched to a scheduled game -> shown with a
--      market, for the board's browser join (signals) and for each source of
--      the Model Lab's per-book quotes (cfb_lab_market_quotes)
--   B  every unmatched provider event with its reason — NAME MISS (home/away),
--      DATE MISS, ORIENTATION (home/away swapped), NO GAME, ID MISS (a Lab
--      quote with no game_id and no event-map row), TRUNCATED (rows the
--      browser's 5,000-row fetch never receives) — and every provider team
--      name the board's resolver cannot place
--   C  every game whose board Market (the browser's rule, replicated) differs
--      from the latest per-book consensus by 1+ point, names the other
--      favourite, is an untimed cfb.lines reference, or is missing while
--      books are current
--   D  every game the board would call STALE or NO MARKET whose latest quote
--      is under 60 minutes old
--   E  every game on the board's slate outside the selected week, with a TBD
--      kickoff, or with none
--   F  every team the board would show more than once
--   G  data faults: a book more than fault_pts from the cross-book median or
--      naming the other favourite; zombie rows (a point not seen for a day
--      while the event is live); alternate-ladder rows under 'spreads'
--   S  the named spot checks
--
-- THE BOARD'S RULES, replicated from app.html as of 2026-09-30:
--   fbSignals          signals, sport americanfootball_ncaaf, now <= commence
--                      <= now + 12 d, ordered event_id, market, selection,
--                      point nulls first, 5 pages x 1,000 rows; an event's
--                      teams and time come from its FIRST row
--   matchesEvent       both names resolve (fbs.js resolveTeam) to the game's
--                      own home and away, kickoffs within 36 h, never swapped
--   fbMarketFromEvent  fresh = last_seen_at inside the TTL ladder against the
--                      event's commence_time (5/15/45/90/180/360 min); modal
--                      rows preferred; books-weighted mode (ties broken here
--                      by the unweighted median — the browser weights it); no
--                      fresh row -> the same over every row, STALE; no row ->
--                      cfb.lines (no timestamp), STALE
--   buildSlate         not completed, kickoff in [now - 6 h, now + 10 d]
-- THE TARGET RULE (what the fix installs; C and D measure against it):
--   latest quote per (source, book) in cfb_lab_market_quotes — heartbeats
--   INCLUDED (a heartbeat is the Lab re-confirming an unchanged line),
--   provider openers and closes excluded, provider averages ('consensus')
--   dropped when a real book quotes, quotes with no game_id resolved by the
--   event map or by (home, away, kickoff +/- 36 h) with the orientation
--   corrected; current = captured within fresh_min; books more than
--   fault_pts from the median or naming the other favourite excluded;
--   consensus = median; staleness = now - MAX(observed_at) of those quotes.
--
-- Output: one row per finding — (section, game, detail, a, b, c) — sorted.
-- ===========================================================================
with params as (
  select
    now()   as now_ts,
    now()   as week_of,          -- EDIT to audit another week, e.g. '2026-10-01 12:00-05'::timestamptz
    360     as fresh_min,        -- the freshness window of the target rule (6 h)
    36      as match_hours,      -- provider event -> game kickoff tolerance
    12      as app_signal_days,  -- fbSignals look-ahead
    10      as app_slate_days,   -- FBP4_LOOKAHEAD_D
    5000    as app_row_cap,      -- fbSignals: 5 pages of 1,000 rows
    7       as fault_pts,        -- a book this far from the cross-book median is a DATA FAULT
    1.0     as pickem_band       -- "the other favourite" needs both sides past this many points
),
win as (
  select p.*,
    case when extract(month from p.week_of at time zone 'America/Chicago') <= 1
         then extract(year from p.week_of at time zone 'America/Chicago')::int - 1
         else extract(year from p.week_of at time zone 'America/Chicago')::int end as season,
    (date_trunc('day', p.week_of at time zone 'America/Chicago')
      - ((extract(isodow from p.week_of at time zone 'America/Chicago')::int + 5) % 7) * interval '1 day')
      at time zone 'America/Chicago' as w_from,
    (date_trunc('day', p.week_of at time zone 'America/Chicago')
      - ((extract(isodow from p.week_of at time zone 'America/Chicago')::int + 5) % 7) * interval '1 day'
      + interval '7 days') at time zone 'America/Chicago' as w_to
  from params p
),
/* ---------------------------------------------------------------- the schedule */
gj as (select to_jsonb(g) as j from cfb.games g),
games as (
  select
    j->>'game_id' as game_id,
    nullif(j->>'week', '')::int as week,
    nullif(j->>'start_date', '')::timestamptz as start_ts,
    case when j ? 'start_time_tbd' then coalesce(nullif(j->>'start_time_tbd', '')::boolean, false) end as tbd,
    coalesce(nullif(j->>'completed', '')::boolean, false) as completed,
    j->>'home_team' as home_team,
    j->>'away_team' as away_team,
    lower(coalesce(j->>'home_division', j->>'home_classification', '')) as home_div,
    lower(coalesce(j->>'away_division', j->>'away_classification', '')) as away_div,
    ${NORM("j->>'home_team'")} as hk,
    ${NORM("j->>'away_team'")} as ak
  from gj, win
  where nullif(j->>'season', '')::int = win.season
),
/* ------------------------------------------- the resolver (football/fbs/fbs.js) */
teams as (
  select distinct k, name from (
    select hk as k, home_team as name from games
    union all select ak, away_team from games) t
  where k is not null
),
alias_list(key, alias) as (values
${aliasValues()}
),
akeys as (
  select k as key, k as ak from teams
  union select k, ${ALIASK('name')} from teams
  union select a.key, ${ALIASK('a.alias')} from alias_list a where a.key in (select k from teams)
),
/* ------------------------------------------------ the board's captured quotes */
sig as (
  select s.event_id, s.market, s.selection, s.point, s.best_dec, s.best_book, s.n_books,
         s.home_team, s.away_team, s.commence_time, s.first_seen_at, s.last_seen_at,
         coalesce(s.point_is_modal, false) as modal
  from public.signals s, win
  where s.sport_key = 'americanfootball_ncaaf'
    and s.commence_time >= win.w_from - make_interval(hours => win.match_hours)
    and s.commence_time <  win.w_to   + make_interval(hours => win.match_hours)
),
appfetch as (
  select s.event_id,
         row_number() over (order by s.event_id, s.market, s.selection, s.point asc nulls first) as rn
  from public.signals s, win
  where s.sport_key = 'americanfootball_ncaaf'
    and s.commence_time >= win.now_ts
    and s.commence_time <= win.now_ts + make_interval(days => win.app_signal_days)
),
appcut as (
  select a.event_id, count(*) as n_rows, count(*) filter (where a.rn <= w.app_row_cap) as n_kept
  from appfetch a, win w
  group by a.event_id
),
ev as (
  select event_id,
    (array_agg(home_team order by market, selection, point asc nulls first))[1] as home_team,
    (array_agg(away_team order by market, selection, point asc nulls first))[1] as away_team,
    (array_agg(commence_time order by market, selection, point asc nulls first))[1] as commence_time,
    count(*) as n_rows,
    count(*) filter (where market = 'spreads') as n_spread_rows,
    count(distinct point) filter (where market = 'spreads') as n_spread_points,
    max(last_seen_at) filter (where market = 'spreads') as spread_last_seen,
    max(last_seen_at) as last_seen
  from sig
  group by event_id
),
/* ------------------------------------------------- the Lab's per-book quotes */
labq as (
  select q.quote_id, q.source, lower(q.book) as book, q.provider_event_id, q.game_id as q_game_id, q.season as q_season,
         q.home_line, q.price_home, q.price_away, q.observed_at, q.kickoff_ts, q.is_heartbeat,
         q.home_team, q.away_team,
         (select m.game_id from public.cfb_lab_event_map m
           where m.source = q.source and m.provider_event_id = q.provider_event_id
           order by m.created_at desc limit 1) as mapped_game_id
  from public.cfb_lab_market_quotes q, win
  where q.market_type = 'spread' and q.is_pregame
    and not q.is_provider_open and not q.is_provider_close
    and q.home_line is not null
    and q.observed_at <= win.now_ts
    and q.observed_at >= win.now_ts - interval '7 days'
    and (q.kickoff_ts is null
         or (q.kickoff_ts >= win.w_from - make_interval(hours => win.match_hours)
             and q.kickoff_ts < win.w_to + make_interval(hours => win.match_hours)))
),
labev as (
  select source, coalesce(provider_event_id, q_game_id) as event_key,
    (array_agg(home_team order by observed_at desc))[1] as home_team,
    (array_agg(away_team order by observed_at desc))[1] as away_team,
    (array_agg(kickoff_ts order by observed_at desc))[1] as kickoff_ts,
    max(q_game_id) as q_game_id, max(mapped_game_id) as mapped_game_id,
    bool_and(q_season is null) as season_null,
    count(*) as n_quotes, max(observed_at) as last_obs
  from labq
  group by source, coalesce(provider_event_id, q_game_id)
),
/* ------------------------------------------------------ resolve every name */
pnames as (
  select distinct nm from (
    select home_team as nm from ev union all select away_team from ev
    union all select home_team from labev union all select away_team from labev) x
  where nm is not null
),
res0 as (
  select n.nm, ${ALIASK('n.nm')} as nak,
    (select t.k from teams t where t.k = ${NORM('n.nm')} limit 1) as k_exact,
    (select a.key from akeys a where a.ak = ${ALIASK('n.nm')} order by a.key limit 1) as k_alias,
    case when ${EXPAND('n.nm')} <> n.nm then coalesce(
      (select t.k from teams t where t.k = ${NORM(EXPAND('n.nm'))} limit 1),
      (select a.key from akeys a where a.ak = ${ALIASK(EXPAND('n.nm'))} order by a.key limit 1)) end as k_state
  from pnames n
),
pre as (
  select r.nm, a.key, length(a.ak) as len
  from res0 r join akeys a on length(a.ak) >= 3 and r.nak like (a.ak || '%')
  where length(coalesce(r.nak, '')) >= 3
),
pre_pick as (
  select p.nm, min(p.key) as key, count(distinct p.key) as nkeys
  from pre p
  where p.len = (select max(p2.len) from pre p2 where p2.nm = p.nm)
  group by p.nm
),
resolved as (
  select r.nm,
    coalesce(r.k_exact, r.k_alias, r.k_state, case when pp.nkeys = 1 then pp.key end) as key,
    case when r.k_exact is not null then 'exact' when r.k_alias is not null then 'alias'
         when r.k_state is not null then 'state-expansion'
         when pp.nkeys = 1 then 'prefix' when pp.nkeys > 1 then 'ambiguous' else 'unresolved' end as how
  from res0 r left join pre_pick pp on pp.nm = r.nm
),
/* ------------------------------------ signals events -> scheduled games */
evm as (
  select e.*, rh.key as hkey, ra.key as akey, rh.how as hhow, ra.how as ahow,
    (select g.game_id from games g, win w
      where g.hk = rh.key and g.ak = ra.key
        and abs(extract(epoch from (g.start_ts - e.commence_time))) < w.match_hours * 3600
      order by abs(extract(epoch from (g.start_ts - e.commence_time))) limit 1) as game_id,
    (select g.game_id from games g, win w
      where g.hk = ra.key and g.ak = rh.key
        and abs(extract(epoch from (g.start_ts - e.commence_time))) < w.match_hours * 3600
      order by abs(extract(epoch from (g.start_ts - e.commence_time))) limit 1) as game_id_swapped,
    (select g.start_ts from games g
      where g.hk = rh.key and g.ak = ra.key
      order by abs(extract(epoch from (g.start_ts - e.commence_time))) limit 1) as same_teams_ts
  from ev e
  left join resolved rh on rh.nm = e.home_team
  left join resolved ra on ra.nm = e.away_team
),
evs as (
  select m.*, c.n_rows as fetch_rows, c.n_kept as fetch_kept,
    case
      when m.hkey is null then 'NAME MISS: home "' || coalesce(m.home_team, '?') || '" (' || coalesce(m.hhow, 'unresolved') || ')'
      when m.akey is null then 'NAME MISS: away "' || coalesce(m.away_team, '?') || '" (' || coalesce(m.ahow, 'unresolved') || ')'
      when m.game_id is not null then 'MATCHED'
      when m.game_id_swapped is not null then 'ORIENTATION: the provider lists ' || m.home_team || ' at home; the schedule has them away (game ' || m.game_id_swapped || ')'
      when m.same_teams_ts is not null then 'DATE MISS: provider kickoff ' || ${CT('m.commence_time')} || ', scheduled ' || ${CT('m.same_teams_ts')}
      else 'NO GAME: both names resolve (' || m.hkey || ' / ' || m.akey || ') but no scheduled game has them'
    end as reason
  from evm m left join appcut c on c.event_id = m.event_id
),
/* ------------------------------------ Lab events -> scheduled games */
labm as (
  select l.*, rh.key as hkey, ra.key as akey,
    coalesce(l.q_game_id, l.mapped_game_id) as id_game,
    (select g.game_id from games g, win w
      where g.hk = rh.key and g.ak = ra.key
        and abs(extract(epoch from (g.start_ts - l.kickoff_ts))) < w.match_hours * 3600
      order by abs(extract(epoch from (g.start_ts - l.kickoff_ts))) limit 1) as name_game,
    (select g.game_id from games g, win w
      where g.hk = ra.key and g.ak = rh.key
        and abs(extract(epoch from (g.start_ts - l.kickoff_ts))) < w.match_hours * 3600
      order by abs(extract(epoch from (g.start_ts - l.kickoff_ts))) limit 1) as name_game_swapped
  from labev l
  left join resolved rh on rh.nm = l.home_team
  left join resolved ra on ra.nm = l.away_team
),
labm2 as (
  select m.*,
    coalesce(m.id_game, m.name_game, m.name_game_swapped) as game_id_final,
    case when m.id_game is null and m.name_game is null and m.name_game_swapped is not null then 'swapped' else 'as_listed' end as orient
  from labm m
),
labg as (
  select q.*, m.game_id_final as game_id, m.orient,
    case when m.orient = 'swapped' then -q.home_line else q.home_line end as game_home_line
  from labq q
  join labm2 m on m.source = q.source and m.event_key = coalesce(q.provider_event_id, q.q_game_id)
  where m.game_id_final is not null
),
latest_book as (
  select distinct on (game_id, source, book) game_id, source, book, game_home_line, observed_at, is_heartbeat
  from labg
  order by game_id, source, book, observed_at desc, quote_id desc
),
lb2 as (
  select l.*,
    (w.now_ts - l.observed_at) <= make_interval(mins => w.fresh_min) as fresh,
    bool_or(l.book <> 'consensus') over (partition by l.game_id) as any_real
  from latest_book l, win w
),
cur0 as (select * from lb2 where fresh and (book <> 'consensus' or not any_real)),
med0 as (select game_id, percentile_cont(0.5) within group (order by game_home_line) as med from cur0 group by game_id),
cur1 as (
  select c.*, m.med,
    (abs(c.game_home_line - m.med) > w.fault_pts
     or (abs(c.game_home_line) >= w.pickem_band and abs(m.med) >= w.pickem_band and sign(c.game_home_line) <> sign(m.med))) as faulted
  from cur0 c join med0 m using (game_id), win w
),
ref as (
  select game_id, count(*) as n_books,
    percentile_cont(0.5) within group (order by game_home_line) as cons_home_line,
    max(observed_at) as newest_obs,
    string_agg(source || ':' || book || ' ' || round(game_home_line::numeric, 1)::text || case when is_heartbeat then ' (hb)' else '' end, ', ' order by source, book) as books
  from cur1 where not faulted
  group by game_id
),
lab_newest as (select game_id, max(observed_at) as newest_obs from latest_book group by game_id),
/* ------------------------------------------------------- the board's slate */
slate as (
  select g.*
  from games g, win w
  where not g.completed and g.start_ts is not null
    and g.start_ts >= w.now_ts - interval '6 hours'
    and g.start_ts <= w.now_ts + make_interval(days => w.app_slate_days)
    and (g.home_div in ('fbs', '') or g.away_div in ('fbs', ''))
),
sm as (
  select e.game_id, min(e.event_id) as event_id
  from evm e, win w
  where e.game_id is not null and e.commence_time >= w.now_ts
  group by e.game_id
),
srows as (
  select sm.game_id, x.point, x.n_books, x.best_dec, x.best_book, x.last_seen_at, x.first_seen_at, x.modal,
    case when ${FBNORM('x.selection')} = ${FBNORM('e.home_team')} then 'home'
         when ${FBNORM('x.selection')} = ${FBNORM('e.away_team')} then 'away' end as side,
    extract(epoch from (e.commence_time - w.now_ts)) / 60 as mtk,
    extract(epoch from (w.now_ts - x.last_seen_at)) / 60 as age_min
  from sm
  join ev e on e.event_id = sm.event_id
  join sig x on x.event_id = sm.event_id and x.market = 'spreads' and x.point is not null,
  win w
),
srows2 as (
  select r.*,
    case when r.side = 'home' then r.point else -r.point end as v,
    greatest(1, coalesce(r.n_books, 1)) as w,
    (r.age_min is not null and r.age_min >= 0 and r.mtk >= 2 and r.age_min <
       case when r.mtk / 60 <= 0.5 then 5 when r.mtk / 60 <= 2 then 15 when r.mtk / 60 <= 6 then 45
            when r.mtk / 60 <= 24 then 90 when r.mtk / 60 <= 72 then 180 else 360 end) as fresh
  from srows r
  where r.side is not null
),
sgame as (select game_id, bool_or(fresh) as any_fresh, max(last_seen_at) as newest_seen from srows2 group by game_id),
suse as (select r.* from srows2 r join sgame g using (game_id) where r.fresh or not g.any_fresh),
suse2 as (select u.* from suse u where u.modal or not exists (select 1 from suse u2 where u2.game_id = u.game_id and u2.modal)),
smed as (select game_id, percentile_cont(0.5) within group (order by v) as med from suse group by game_id),
swt as (select game_id, v, sum(w) as wsum from suse2 group by game_id, v),
smain as (
  select distinct on (s.game_id) s.game_id, s.v as app_home_line
  from swt s join smed m using (game_id)
  order by s.game_id, s.wsum desc, abs(s.v - m.med), s.v
),
appm as (
  select s.game_id, s.home_team, s.away_team, s.hk, s.ak, s.start_ts, s.tbd, s.week,
    sm.event_id, mm.app_home_line, g.any_fresh, g.newest_seen,
    cl.spread as lines_spread, cl.provider as lines_provider,
    case when mm.app_home_line is not null and g.any_fresh then 'LIVE'
         when mm.app_home_line is not null then 'STALE (captured rows, none fresh)'
         when cl.spread is not null then 'STALE (cfb.lines untimed reference)'
         else 'NO MARKET' end as app_status,
    coalesce(mm.app_home_line::numeric, cl.spread::numeric) as shown_home_line
  from slate s
  left join sm on sm.game_id = s.game_id
  left join smain mm on mm.game_id = s.game_id
  left join sgame g on g.game_id = s.game_id
  left join lateral (
    select l.spread, l.provider from cfb.lines l
    where l.game_id::text = s.game_id
    order by (lower(coalesce(l.provider, '')) like '%consensus%') desc
    limit 1) cl on true
),
wk_app as (
  select a.*, r.n_books, r.cons_home_line, r.newest_obs, r.books, ln.newest_obs as lab_newest
  from appm a
  cross join win w
  left join ref r on r.game_id = a.game_id
  left join lab_newest ln on ln.game_id = a.game_id
  where a.start_ts >= w.w_from and a.start_ts < w.w_to and coalesce(a.tbd, false) = false
),
spot(ak, hk) as (values
${SPOT.map(([a, h]) => '    (' + lit(a) + ', ' + lit(h) + ')').join(',\n')}
),
/* ------------------------------------------------------------ the findings */
out as (
  select 0 as ord, 'PARAMS' as section, null::text as game,
    'week ' || ${CT('w.w_from')} || ' -> ' || ${CT('w.w_to')} as detail,
    'as of ' || ${CT('w.now_ts')} as a, 'fresh window ' || w.fresh_min || ' min' as b,
    'cfb.games carries start_time_tbd: ' || coalesce((select bool_or(j ? 'start_time_tbd') from gj)::text, 'no rows') as c
  from win w

  union all
  select 1, 'A funnel · signals (board browser join)', null,
    'provider events with kickoff in the week, seen in the last 24 h',
    'pulled ' || (select count(*) from evs e where e.commence_time >= w.w_from and e.commence_time < w.w_to
                    and e.last_seen >= w.now_ts - interval '24 hours'),
    'matched ' || (select count(*) from evs e where e.commence_time >= w.w_from and e.commence_time < w.w_to
                    and e.last_seen >= w.now_ts - interval '24 hours' and e.reason = 'MATCHED'),
    'shown LIVE ' || (select count(*) from wk_app where app_status = 'LIVE')
      || ' · STALE ' || (select count(*) from wk_app where app_status like 'STALE%')
      || ' · NO MARKET ' || (select count(*) from wk_app where app_status = 'NO MARKET')
      || ' of ' || (select count(*) from wk_app) || ' week games'
  from win w

  union all
  select 1, 'A funnel · lab ' || s.source, null,
    'events with a quote in the last 7 d, kickoff in the week',
    'pulled ' || (select count(*) from labm m where m.source = s.source
                    and coalesce(m.kickoff_ts, w.w_from) >= w.w_from and coalesce(m.kickoff_ts, w.w_from) < w.w_to),
    'with game_id ' || (select count(*) from labm m where m.source = s.source and m.id_game is not null
                    and coalesce(m.kickoff_ts, w.w_from) >= w.w_from and coalesce(m.kickoff_ts, w.w_from) < w.w_to)
      || ' · matchable by names ' || (select count(*) from labm m where m.source = s.source and m.id_game is null
                    and (m.name_game is not null or m.name_game_swapped is not null)
                    and coalesce(m.kickoff_ts, w.w_from) >= w.w_from and coalesce(m.kickoff_ts, w.w_from) < w.w_to)
      || ' · season NULL ' || (select count(*) from labm m where m.source = s.source and m.season_null
                    and coalesce(m.kickoff_ts, w.w_from) >= w.w_from and coalesce(m.kickoff_ts, w.w_from) < w.w_to),
    'current (<= fresh window) ' || (select count(*) from labm m where m.source = s.source
                    and m.last_obs >= w.now_ts - make_interval(mins => w.fresh_min)
                    and coalesce(m.kickoff_ts, w.w_from) >= w.w_from and coalesce(m.kickoff_ts, w.w_from) < w.w_to)
  from (values ('odds_api'), ('espn'), ('cfbd')) s(source) cross join win w

  union all
  select 2, 'B unmatched · signals', e.away_team || ' @ ' || e.home_team, e.reason,
    'event ' || e.event_id, ${CT('e.commence_time')}, e.n_rows || ' rows'
  from evs e, win w
  where e.reason <> 'MATCHED' and e.commence_time >= w.w_from and e.commence_time < w.w_to

  union all
  select 2, 'B unmatched · signals', e.away_team || ' @ ' || e.home_team,
    'TRUNCATED: the browser receives ' || e.fetch_kept || ' of ' || e.fetch_rows || ' rows (5 x 1,000-row pages, ordered by event_id)',
    'event ' || e.event_id, ${CT('e.commence_time')}, e.reason
  from evs e, win w
  where e.fetch_rows is not null and e.fetch_kept < e.fetch_rows and e.commence_time >= w.w_from and e.commence_time < w.w_to

  union all
  select 2, 'B unmatched · lab ' || m.source, m.away_team || ' @ ' || m.home_team,
    case when m.hkey is null or m.akey is null then 'NAME MISS: ' || case when m.hkey is null then 'home "' || coalesce(m.home_team, '?') || '"' else 'away "' || coalesce(m.away_team, '?') || '"' end
         when m.name_game is not null then 'ID MISS: no game_id and no event-map row; names and kickoff match game ' || m.name_game
         when m.name_game_swapped is not null then 'ID MISS + ORIENTATION: names match game ' || m.name_game_swapped || ' with home/away swapped'
         else 'NO GAME: both names resolve but no scheduled game within 36 h' end,
    'event ' || m.event_key, ${CT('m.kickoff_ts')}, m.n_quotes || ' quotes' || case when m.season_null then ', season NULL' else '' end
  from labm m, win w
  where m.id_game is null
    and coalesce(m.kickoff_ts, w.w_from) >= w.w_from and coalesce(m.kickoff_ts, w.w_from) < w.w_to

  union all
  select 2, 'B unresolved name', r.nm, r.how, null, null, null
  from resolved r where r.key is null

  union all
  select 3, 'C market vs latest consensus', a.away_team || ' @ ' || a.home_team,
    concat_ws('; ',
      case when a.shown_home_line is not null and a.cons_home_line is not null and abs(a.shown_home_line - a.cons_home_line) >= 1
           then 'differs by ' || round(abs(a.shown_home_line - a.cons_home_line)::numeric, 1) end,
      case when a.shown_home_line is not null and a.cons_home_line is not null
            and a.shown_home_line <> 0 and a.cons_home_line <> 0 and sign(a.shown_home_line) <> sign(a.cons_home_line)
           then 'names the other favourite' end,
      case when a.app_status like 'STALE (cfb.lines%' and a.cons_home_line is not null then 'Market is the untimed cfb.lines reference' end,
      case when a.app_status = 'NO MARKET' and a.cons_home_line is not null then 'NO MARKET while books are current' end,
      case when a.app_status like 'STALE%' and a.cons_home_line is not null then 'STALE while books are current' end),
    'board ' || a.app_status || ': ' || ${SIDE('a.shown_home_line', 'a.home_team', 'a.away_team')},
    'consensus ' || ${SIDE('a.cons_home_line', 'a.home_team', 'a.away_team')} || ' (' || coalesce(a.n_books, 0) || ' books)',
    a.books
  from wk_app a
  where (a.shown_home_line is not null and a.cons_home_line is not null
         and (abs(a.shown_home_line - a.cons_home_line) >= 1
              or (a.shown_home_line <> 0 and a.cons_home_line <> 0 and sign(a.shown_home_line) <> sign(a.cons_home_line))))
     or (a.cons_home_line is not null and a.app_status <> 'LIVE')

  union all
  select 4, 'D false stale', a.away_team || ' @ ' || a.home_team,
    'board ' || a.app_status || ' but the latest quote is under 60 min old',
    'signals newest ' || coalesce(round(extract(epoch from (w.now_ts - a.newest_seen)) / 60)::text || ' min', '—'),
    'lab newest ' || coalesce(round(extract(epoch from (w.now_ts - a.lab_newest)) / 60)::text || ' min', '—'),
    'consensus ' || ${SIDE('a.cons_home_line', 'a.home_team', 'a.away_team')}
  from wk_app a, win w
  where a.app_status <> 'LIVE'
    and (a.newest_seen >= w.now_ts - interval '60 minutes' or a.lab_newest >= w.now_ts - interval '60 minutes')

  union all
  select 5, 'E slate outside the week', a.away_team || ' @ ' || a.home_team,
    case when a.tbd then 'TBD kickoff (start_time_tbd) — a placeholder time, not a kickoff'
         when a.tbd is null and to_char(a.start_ts at time zone 'UTC', 'HH24:MI') in ('04:00', '05:00') then 'probable TBD placeholder (midnight ET); the feed carries no TBD flag'
         else 'kickoff outside the selected week' end,
    'shown as ' || ${CT('a.start_ts')}, 'week ' || coalesce(a.week::text, '—'), a.game_id
  from appm a, win w
  where a.start_ts < w.w_from or a.start_ts >= w.w_to or a.tbd
     or (a.tbd is null and to_char(a.start_ts at time zone 'UTC', 'HH24:MI') in ('04:00', '05:00'))

  union all
  select 6, 'F team shown twice', t.team, string_agg(t.label, ' | ' order by t.start_ts), count(*)::text || ' games', null, null
  from (select home_team as team, away_team || ' @ ' || home_team || ' ' || ${CT('start_ts')} as label, start_ts from appm
        union all select away_team, away_team || ' @ ' || home_team || ' ' || ${CT('start_ts')}, start_ts from appm) t
  group by t.team having count(*) > 1

  union all
  select 7, 'G data fault · book vs median', g.away_team || ' @ ' || g.home_team,
    c.source || ':' || c.book || ' ' || ${SIDE('c.game_home_line', 'g.home_team', 'g.away_team')},
    'cross-book median ' || ${SIDE('c.med', 'g.home_team', 'g.away_team')},
    case when abs(c.game_home_line - c.med) > (select fault_pts from win) then 'more than ' || (select fault_pts from win) || ' pts from the median' else 'names the other favourite' end,
    'observed ' || ${CT('c.observed_at')}
  from cur1 c join games g on g.game_id = c.game_id
  where c.faulted

  union all
  select 7, 'G data fault · zombie signals rows', e.away_team || ' @ ' || e.home_team,
    count(*) || ' spreads row(s) not seen for 24 h+ while the event is live',
    'oldest ' || string_agg(x.selection || ' ' || x.point || ' last seen ' || ${CT('x.last_seen_at')}, ' | ' order by x.last_seen_at) ,
    'first seen ' || ${CT('min(x.first_seen_at)')}, e.reason
  from evs e join sig x on x.event_id = e.event_id and x.market = 'spreads', win w
  where e.commence_time >= w.w_from and e.commence_time < w.w_to
    and x.last_seen_at < e.spread_last_seen - interval '24 hours'
  group by e.event_id, e.away_team, e.home_team, e.reason

  union all
  select 7, 'G data fault · alternate ladder under spreads', e.away_team || ' @ ' || e.home_team,
    e.n_spread_points || ' distinct spread points on one event', 'a main market has one number per side', null, e.reason
  from evs e, win w
  where e.n_spread_points > 4 and e.commence_time >= w.w_from and e.commence_time < w.w_to

  union all
  select 8, 'S spot check', a.away_team || ' @ ' || a.home_team,
    'board ' || a.app_status || ': ' || ${SIDE('a.shown_home_line', 'a.home_team', 'a.away_team')},
    'consensus ' || ${SIDE('r.cons_home_line', 'a.home_team', 'a.away_team')} || ' (' || coalesce(r.n_books, 0) || ' books)',
    'newest quote ' || coalesce(round(extract(epoch from (w.now_ts - greatest(a.newest_seen, ln.newest_obs))) / 60)::text || ' min', '—'),
    ${CT('a.start_ts')} || case when a.start_ts < w.w_from or a.start_ts >= w.w_to or a.tbd then ' (NOT THIS WEEK)' else '' end
  from appm a
  join spot s on s.ak = a.ak and s.hk = a.hk
  left join ref r on r.game_id = a.game_id
  left join lab_newest ln on ln.game_id = a.game_id,
  win w
)
select section, game, detail, a, b, c
from out
order by ord, section, game nulls first, detail;
`;
}

function main() {
  const sql = build();
  if (process.argv.includes('--write')) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, sql); console.log('written ' + path.relative(ROOT, OUT)); return; }
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== sql) { console.error('DRIFT: ' + path.relative(ROOT, OUT) + ' is not what the generator builds; run with --write'); process.exit(1); }
    console.log('ok: ' + path.relative(ROOT, OUT) + ' matches the generator'); return;
  }
  process.stdout.write(sql);
}
if (require.main === module) main();
module.exports = { build, OUT, SPOT };
