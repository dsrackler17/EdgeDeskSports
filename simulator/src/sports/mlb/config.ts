/* ===========================================================================
   MLB — alignment, the season-specific postseason formats, and the 2026
   season configuration the simulator runs under.

   Club codes are the Retrosheet franchise keys mlb/history uses (ANA, CHA,
   CHN, KCA, LAN, NYA, NYN, SDN, SFN, SLN, TBA, ...; the Athletics stay OAK
   and the Marlins MIA, as mlb/history/ingest.js maps them). statsapi_id is
   MLB's own team id, the key the live schedule uses; the test
   simulator/tests/mlb_config.test.ts holds every id equal to the team name in
   the real 2024 StatsAPI schedule (datapack/quant_v1/data/mlb/raw).

   ALIGNMENT. Six divisions, unchanged since Houston moved to the AL West in
   2013 (2012: Houston in the NL Central). The test re-derives the divisions
   from the committed game logs: division rivals meet far more often than any
   other pair (18-19 games through 2022, 13 since 2023).

   FORMATS. Every rule that decides who qualifies, who hosts which game and
   how long a series is, by season. The history suite
   (simulator/tests/mlb_rules_history.test.ts) replays every season 2012-2025
   except 2020 from the game logs and holds every postseason pairing and the
   host of every one of the 2012-2025 postseason games (Retrosheet) equal to
   what these formats and the tiebreak procedure produce. 2020 (16 clubs,
   neutral-site rounds, its own tiebreak list) is NOT supported and is
   refused, not approximated.

   Everything below that is a FACT ABOUT THE 2026 SEASON carries its source
   and a verification status. mlb.com and MLB's Stats API refuse the build
   environment but answer GitHub's runners: the Simulator source check (job
   fetch (mlb)) read MLB's 2026 standings and postseason schedule and the 2026
   Official Baseball Rules, and a dispatched dry run built the live snapshot
   there (2026-10-23). Each fact cites what was read. The tiebreak procedure's
   text was not found: it is MEASURED in every run instead (run.tiebreak_measured),
   which the final 2026 standings allow (no equal record at any decided place).
   =========================================================================== */
import type { SeasonFact } from '../nfl/config.ts';

export type League = 'AL' | 'NL';
export interface MlbTeam { code: string; name: string; league: League; division: string; statsapi_id: number }

const T = (code: string, name: string, division: string, statsapi_id: number): MlbTeam => ({ code, name, league: division.slice(0, 2) as League, division, statsapi_id });

export const MLB_TEAMS: MlbTeam[] = [
  T('BAL', 'Baltimore Orioles', 'AL East', 110), T('BOS', 'Boston Red Sox', 'AL East', 111), T('NYA', 'New York Yankees', 'AL East', 147), T('TBA', 'Tampa Bay Rays', 'AL East', 139), T('TOR', 'Toronto Blue Jays', 'AL East', 141),
  T('CHA', 'Chicago White Sox', 'AL Central', 145), T('CLE', 'Cleveland Guardians', 'AL Central', 114), T('DET', 'Detroit Tigers', 'AL Central', 116), T('KCA', 'Kansas City Royals', 'AL Central', 118), T('MIN', 'Minnesota Twins', 'AL Central', 142),
  T('ANA', 'Los Angeles Angels', 'AL West', 108), T('HOU', 'Houston Astros', 'AL West', 117), T('OAK', 'Athletics', 'AL West', 133), T('SEA', 'Seattle Mariners', 'AL West', 136), T('TEX', 'Texas Rangers', 'AL West', 140),
  T('ATL', 'Atlanta Braves', 'NL East', 144), T('MIA', 'Miami Marlins', 'NL East', 146), T('NYN', 'New York Mets', 'NL East', 121), T('PHI', 'Philadelphia Phillies', 'NL East', 143), T('WAS', 'Washington Nationals', 'NL East', 120),
  T('CHN', 'Chicago Cubs', 'NL Central', 112), T('CIN', 'Cincinnati Reds', 'NL Central', 113), T('MIL', 'Milwaukee Brewers', 'NL Central', 158), T('PIT', 'Pittsburgh Pirates', 'NL Central', 134), T('SLN', 'St. Louis Cardinals', 'NL Central', 138),
  T('ARI', 'Arizona Diamondbacks', 'NL West', 109), T('COL', 'Colorado Rockies', 'NL West', 115), T('LAN', 'Los Angeles Dodgers', 'NL West', 119), T('SDN', 'San Diego Padres', 'NL West', 135), T('SFN', 'San Francisco Giants', 'NL West', 137)
];
export const DIVISIONS = ['AL East', 'AL Central', 'AL West', 'NL East', 'NL Central', 'NL West'];

/** the alignment of a season: 2013 onward as above; 2012 with Houston in the NL Central */
export function teamsFor(season: number): MlbTeam[] {
  if (season < 2012) throw new Error('MLB alignment before 2012 is not configured');
  if (season >= 2013) return MLB_TEAMS.map((t) => ({ ...t }));
  return MLB_TEAMS.map((t) => (t.code === 'HOU' ? { ...t, league: 'NL' as League, division: 'NL Central' } : { ...t }));
}

/* ---------------- postseason formats ---------------- */
export type Round = 'WC' | 'DS' | 'LCS' | 'WS';
/** who hosts game k of a series: H the higher seed (better), L the lower */
export type Host = 'H' | 'L';
export interface RoundDef { key: Round; best_of: number; hosts: Host[] }
export interface MlbFormat {
  id: 'MLB-2022' | 'MLB-2012';
  /** clubs per league: three division winners seeded 1-3 by record, then the wild cards */
  playoff_clubs_per_league: number;
  wild_cards_per_league: number;
  /** seeds that skip the first round */
  byes_per_league: number;
  rounds: RoundDef[];
  /** a tie for a division title or a berth: decided by the formula (2022-) or by a tiebreaker game played as a regular-season game (2012-2021) */
  berth_ties: 'formula' | 'tiebreaker_game';
  /** World Series home field: the pennant winner with the better record (2017-), or the league that won the All-Star Game (2003-2016) */
  ws_home: { rule: 'better_record' } | { rule: 'all_star_game'; league: League; source: string };
}

const BO3_ALL_HIGH: RoundDef = { key: 'WC', best_of: 3, hosts: ['H', 'H', 'H'] };
const WC_GAME: RoundDef = { key: 'WC', best_of: 1, hosts: ['H'] };
const DS_221: RoundDef = { key: 'DS', best_of: 5, hosts: ['H', 'H', 'L', 'L', 'H'] };
/* 2012 only: the Division Series opened with two games at the LOWER seed (a 2-3 format, a
   schedule compression after the second wild card was added that year) */
const DS_23_2012: RoundDef = { key: 'DS', best_of: 5, hosts: ['L', 'L', 'H', 'H', 'H'] };
const LCS_232: RoundDef = { key: 'LCS', best_of: 7, hosts: ['H', 'H', 'L', 'L', 'L', 'H', 'H'] };
const WS_232: RoundDef = { key: 'WS', best_of: 7, hosts: ['H', 'H', 'L', 'L', 'L', 'H', 'H'] };

/* All-Star Game winners 2012-2016 (home field in the World Series went to that league):
   recalled, not read from a source here — the history suite checks each one against the host
   of every Retrosheet World Series game of that season */
const ASG_LEAGUE: Record<number, League> = { 2012: 'NL', 2013: 'AL', 2014: 'AL', 2015: 'AL', 2016: 'AL' };

export function formatFor(season: number): MlbFormat {
  if (season === 2020) throw new Error('the 2020 MLB format (16 clubs, neutral-site rounds, its own tiebreak list) is not supported');
  if (season >= 2022) {
    return { id: 'MLB-2022', playoff_clubs_per_league: 6, wild_cards_per_league: 3, byes_per_league: 2,
      rounds: [BO3_ALL_HIGH, DS_221, LCS_232, WS_232], berth_ties: 'formula', ws_home: { rule: 'better_record' } };
  }
  if (season >= 2012) {
    const ws: MlbFormat['ws_home'] = season <= 2016
      ? { rule: 'all_star_game', league: ASG_LEAGUE[season], source: 'All-Star Game result, recalled; checked against the Retrosheet World Series hosts by the history suite' }
      : { rule: 'better_record' };
    return { id: 'MLB-2012', playoff_clubs_per_league: 5, wild_cards_per_league: 2, byes_per_league: 0,
      rounds: [WC_GAME, season === 2012 ? DS_23_2012 : DS_221, LCS_232, WS_232], berth_ties: 'tiebreaker_game', ws_home: ws };
  }
  throw new Error('no MLB format configured for season ' + season);
}

/** the extra-inning rule in force: regular-season games since 2020 start each extra half-inning
    with a runner on second; postseason games never have; before 2020 neither did */
export function extraInningRule(season: number, phase: 'regular' | 'postseason'): 'automatic_runner' | 'standard' {
  return phase === 'regular' && season >= 2020 ? 'automatic_runner' : 'standard';
}

/* ---------------- the 2026 season ---------------- */
export interface CalendarTemplate {
  /** day offsets from the last scheduled regular-season date, per round, per league (WS: 'MLB'), per game number */
  WC: number[]; DS: { AL: number[]; NL: number[] }; LCS: { AL: number[]; NL: number[] }; WS: number[];
}

export interface MlbSeasonConfig {
  sport: 'mlb';
  competition: 'MLB';
  season: number;
  regular_season_games_per_club: number;
  rules_version: 'MLB-2022';
  /** the last date (UTC) the nightly workflow runs this season (simulator/src/cli/plan.ts NIGHTLY) */
  nightly_through: string;
  alignment: SeasonFact<string>;
  format: SeasonFact<string>;
  tiebreakers: SeasonFact<string>;
  world_series_home: SeasonFact<string>;
  extra_innings: SeasonFact<{ regular_season: 'automatic_runner'; postseason: 'standard' }>;
  /** Estimated: used only for postseason games the schedule does not date yet */
  postseason_calendar: SeasonFact<CalendarTemplate>;
  /** the live inputs: MLB's Stats API read through statsapi.ts, never run from the build environment */
  live_inputs: SeasonFact<string>;
  /** starting pitchers: confirmed where announced, projected otherwise (simulator/data/mlb_rotation_study.json) */
  rotation: { mode: 'projected'; min_rest_days: number; postseason_rotation_size: number };
  /** not modelled: no owned data describes bullpen usage or availability (SIMULATOR_NOTES / MLB_SIMULATOR_NOTES.md) */
  bullpen: { mode: 'off'; reason: string };
  /** not modelled: the served game model has no lineup input */
  lineups: { mode: 'off'; reason: string };
  /** within-season strength drift: OFF; a hook only, with no validated parameters */
  drift: { mode: 'off' };
  /** availability: no injury return sampling (no owned return-date distribution); rotation departures are the only availability term */
  availability: { mode: 'off'; fixed_assumption: string };
}

export const MLB_2026: MlbSeasonConfig = {
  sport: 'mlb',
  competition: 'MLB',
  season: 2026,
  regular_season_games_per_club: 162,
  rules_version: 'MLB-2022',
  /* World Series game 7 is scheduled for 2026-10-31 (MLB's Stats API, Actions run 39995723592); a week's
     margin for postponements, then MLB leaves the nightly schedule until a 2027 configuration exists */
  nightly_through: '2026-11-07',
  alignment: {
    value: 'six divisions as in MLB_TEAMS (unchanged since 2013)',
    source: 'MLB\'s Stats API, the 2026 regular-season standings (https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2026&standingsTypes=regularSeason&hydrate=team, HTTP 200, body sha256 347b1eda907483ad73ec8d6ab6db41308deaef2d9d1e0b37f498522760690ba6, and its divisions, sha256 94142c6567341a0f13efdb004090f67dc069283be6123c9988673022c763121c), the feed mlb.com\'s standings page reads: AL East TB NYY BOS BAL TOR; AL Central CLE CWS MIN DET KC; AL West HOU TEX SEA ATH LAA; NL East ATL PHI MIA WSH NYM; NL Central MIL CHC PIT STL CIN; NL West LAD SD AZ SF COL. Club by club the divisions of MLB_TEAMS (MLB\'s abbreviations; ATH = the Athletics, OAK here). The live snapshot\'s schedule.alignment gate checks the same on the 2026 schedule',
    retrieved: '2026-10-23', verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml (job fetch (mlb)) and compare its MLBSTANDING lines with MLB_TEAMS.',
    affects_results: true, verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the standings fetched by GitHub Actions run 39995723592 (Simulator source check, job fetch (mlb), 2026-10-23T17:31Z)', verified_at: '2026-10-23'
  },
  format: {
    value: '12 clubs: per league the three division winners seeded 1-3 by record and three wild cards seeded 4-6; seeds 1-2 receive byes. Wild Card Series best of 3, every game at the higher seed (3 v 6, 4 v 5). Division Series best of 5, 2-2-1 (1 v winner of 4/5, 2 v winner of 3/6), no reseeding. LCS best of 7, 2-3-2 at the higher seed. World Series best of 7, 2-3-2 (home field: see world_series_home).',
    source: 'MLB\'s Stats API, the 2026 postseason as scheduled and played (https://statsapi.mlb.com/api/v1/schedule/postseason?sportId=1&season=2026&hydrate=team, HTTP 200, body sha256 b10ed8c9380f84ec489365bf45109884fb31ba0e4e675091d4ce0a49c89f3bdb, 43 games), with the final standings (see alignment). Per league the three division winners seeded 1-3 by record (AL: TB 98-64, CLE 85-77, HOU 81-81 - HOU third above three wild cards with better records; NL: MIL 103-59, LAD 100-62, ATL 94-68), three wild cards 4-6 (AL NYY, BOS, CWS; NL SD, CHC, PHI). Wild Card Series gamesInSeries 3, every game at the higher seed (HOU-CWS at Daikin Park, NYY-BOS at Yankee Stadium, ATL-PHI at Truist Park, SD-CHC at Petco Park). Division Series of 5, seed 1 against the 4/5 winner and seed 2 against the 3/6 winner (TB-NYY, CLE-CWS, MIL-SD, LAD-ATL), games 1-2 and 5 at the higher seed. LCS and World Series of 7, games 1-2 and 6-7 at the club with home field (ALCS at TB, NLCS at MIL, World Series at MIL). mlb.com/postseason (HTTP 200, page sha256 8e3db2883f30dd7efc8d9963af54abd705b3a959032b3aa6c9bc74b34700b6a1) shows the same bracket; it states no rule in words. Every 2022-2025 pairing and game host in the Retrosheet postseason logs agrees too (simulator/tests/mlb_rules_history.test.ts)',
    retrieved: '2026-10-23', verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml (job fetch (mlb)) and compare its MLBPOSTGAME lines with this format once the postseason is scheduled.',
    affects_results: true, verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the 2026 postseason schedule and the final standings fetched by GitHub Actions run 39995723592 (Simulator source check, job fetch (mlb), 2026-10-23T17:31Z)', verified_at: '2026-10-23'
  },
  tiebreakers: {
    value: 'No tiebreaker games. A tie for a division title, a wild card or a seed is broken by (1) head-to-head winning percentage (combined among the tied clubs), (2) winning percentage in intradivision games, (3) winning percentage in interdivision games within the league, (4) winning percentage in the last half of intraleague games, (5) the last half plus one intraleague game not between the tied clubs, adding one game at a time. When a step separates the best club(s) from the rest without naming one, the procedure restarts among the best. Each place is decided this way, then the rest revert to step 1.',
    source: 'Recalled (MLB\'s mathematical tiebreakers since 2022); it reproduces every 2022-2025 division winner and seed, including the three-club tie of 2024 (NL wild cards), from the game logs alone. MLB\'s text was not found: mlb.com/glossary/transactions/TIEBREAKER (HTTP 200, Simulator source check run 39995723592) is a generic glossary page, and the Internet Archive\'s index of mlb.com timed out. MEASURED instead: MLB\'s 2026 final standings (Stats API, same run) hold no equal record at any place a tiebreaker decides (the only equal records, DET/SEA 76-86 and WSH/STL 77-85, are in different divisions and out of the wild-card places), so no 2026 place depends on it; every run counts the ties it breaks at a reported place and run.tiebreak_measured refuses publication if there is one',
    retrieved: '2026-10-23', verification: 'UNVERIFIED',
    verify_by: 'Compare MLB_SIMULATOR_NOTES.md §Tiebreakers with MLB\'s published tiebreaker procedure; steps 3-5 were never needed by a 2022-2025 tie, so the history replay does not test them. Required before any season whose standings are not final (2027).',
    affects_results: true, verified_by: null, verified_at: null, measured: true
  },
  world_series_home: {
    value: 'The pennant winner with the better regular-season winning percentage hosts games 1, 2, 6 and 7; an equal record is broken by the same procedure as a seeding tie (head-to-head first).',
    source: 'MLB\'s Stats API, the 2026 World Series schedule (https://statsapi.mlb.com/api/v1/schedule/postseason?sportId=1&season=2026&hydrate=team, HTTP 200, body sha256 b10ed8c9380f84ec489365bf45109884fb31ba0e4e675091d4ce0a49c89f3bdb): Milwaukee (103-59, .636) hosts games 1, 2, 6 and 7 at American Family Field, Tampa Bay (98-64, .605) games 3-5 at Tropicana Field - the better record hosts, as here. The rule\'s wording was not found on mlb.com (Simulator source check runs 39995723592, 39998698766); what the simulation uses, the 2026 hosts, is MLB\'s own schedule. The equal-record step is recalled only and does not apply in 2026 (it is counted by run.tiebreak_measured). Every 2017-2025 World Series host in the Retrosheet logs agrees',
    retrieved: '2026-10-23', verification: 'VERIFIED',
    verify_by: 'Each season: compare the World Series hosts in the Simulator source check\'s MLBPOSTGAME lines with the pennant winners\' records.',
    affects_results: true, verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the 2026 World Series schedule fetched by GitHub Actions run 39995723592 (Simulator source check, job fetch (mlb))', verified_at: '2026-10-23'
  },
  extra_innings: {
    value: { regular_season: 'automatic_runner', postseason: 'standard' },
    source: 'MLB, 2026 Official Baseball Rules (https://mktg.mlbstatic.com/mlb/official-information/2026-official-baseball-rules.pdf, HTTP 200, 1,316,921 bytes, sha256 f85860f3b754dfb5e07269e9d3a86c77c89b856376f6e3ba8345af36db997859; Rules 7.01-7.02 as printed, text sha256 a6e8ce49ce3a3d25f710042f4a97b37fe9278441eec4b60f57ba1ba9a965f6ee). Rule 7.01(b)(2): "Each half-inning following the ninth inning will begin with a runner on second base". Rule 7.02(g): "The Major Leagues have determined that Rule 7.01(b)(2) (runner on second base in Extra Innings) does not apply to any Wild Card Series, Division Series, League Championship Series or World Series games." The simulator never models innings: the rule only selects which measured extra-inning home-win rate a tied regulation draw resolves with (simulator/data/mlb_game_model_study.json)',
    retrieved: '2026-10-23', verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml (job fetch (mlb)) and read Rules 7.01(b) and 7.02(g) of that season\'s Official Baseball Rules.',
    affects_results: true, verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the 2026 Official Baseball Rules fetched by GitHub Actions run 40000336884 (Simulator source check, job fetch (mlb), 2026-10-23T18:05Z)', verified_at: '2026-10-23'
  },
  postseason_calendar: {
    /* the 2025 postseason calendar (Retrosheet), as day offsets from the last regular-season
       date (2025-09-28): an Estimated stand-in for 2026 dates the schedule does not carry yet */
    value: { WC: [2, 3, 4], DS: { AL: [6, 7, 9, 10, 12], NL: [6, 8, 10, 11, 13] }, LCS: { AL: [14, 15, 17, 18, 19, 21, 22], NL: [15, 16, 18, 19, 20, 22, 23] }, WS: [26, 27, 29, 30, 31, 33, 34] },
    source: 'Estimated: the 2025 postseason calendar in the Retrosheet logs (simulator/fixtures/mlb_postseason_2012_2025.json), as offsets from the last regular-season date. A postseason game the live schedule dates uses the schedule\'s date instead (Observed)',
    retrieved: '2026-10-23', verification: 'NOT_APPLICABLE',
    verify_by: 'Estimated input: replaced game by game by the schedule\'s own dates once MLB publishes them.',
    affects_results: true, verified_by: null, verified_at: null
  },
  live_inputs: {
    value: 'schedule (officialDate, doubleheaders, postponements, cancellations, series game numbers, announced probables) and box-score starters from statsapi.mlb.com; MLBAM ids mapped to Retrosheet ids by the Chadwick register',
    source: 'simulator/src/sports/mlb/statsapi.ts; the parser is tested on the real 2024 schedule response and box scores in datapack/quant_v1/data/mlb/raw (simulator/tests/mlb_statsapi.test.ts). The live 2026 snapshot was built on GitHub\'s runners by Actions run 39994766921 (Simulator, sport mlb, dry run, 2026-10-23T17:26Z; inputs 0b150e7725f2, as of 2026-10-23, 7 scheduled games): every gate passed but sport.active, with one WARN (schedule.full_162: NYY and BAL 161 games, a game MLB never made up). All 30 clubs\' W-L equal MLB\'s 2026 standings (Simulator source check run 39995723592, standings body sha256 347b1eda907483ad73ec8d6ab6db41308deaef2d9d1e0b37f498522760690ba6); the six division winners, the 12 postseason clubs, the four byes, the LCS clubs and both pennant winners are the ones MLB\'s postseason schedule shows (postseason.consistent passed); World Series games 1-2 are Confirmed with MLB\'s announced starters',
    retrieved: '2026-10-23', verification: 'VERIFIED',
    verify_by: 'Each season: dispatch Actions -> Simulator (sport mlb, dry run) and compare every club\'s record and seed with MLB\'s standings and postseason schedule (the Simulator source check prints both).',
    affects_results: true, verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from Actions runs 39994766921 (the live dry run) and 39995723592 (MLB\'s standings and postseason schedule)', verified_at: '2026-10-23'
  },
  rotation: { mode: 'projected', min_rest_days: 5, postseason_rotation_size: 4 },
  bullpen: { mode: 'off', reason: 'No owned data records bullpen usage: the Retrosheet game logs carry starters and decisions only, and the live bullpen flags (mlb_bullpen_taxed) exist only in the database and have no history to validate against. Relief innings are inside each club\'s run-prevention rating; fatigue is not modelled.' },
  lineups: { mode: 'off', reason: 'The served game model (mlb/history, edgedesk MLB lab brain) has no lineup input; offence is a club rating.' },
  drift: { mode: 'off' },
  availability: { mode: 'off', fixed_assumption: 'Club ratings are the as-of fit; no injury return is sampled. Starting-pitcher availability enters only through the rotation model (departures and spot starts measured from 2012-2025 rotations).' }
};
