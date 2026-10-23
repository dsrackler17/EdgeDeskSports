/* ===========================================================================
   NHL 2026-27 — the season configuration the simulator runs under.

   Season keys are END years, the convention of hockey/config.js and of the
   source data (2027 = 2026-27).

   Alignment: 32 clubs, two conferences of two eight-club divisions (Utah in
   the Central since 2024-25). Codes are the NHL abbreviations the
   sportsdataverse feeds and hockey/data/team_games use.
   simulator/tests/nhl_config.test.ts holds this table equal to the 2026-27
   schedule itself: every pair of division rivals meets four times, every
   other pair of conference clubs three times, every cross-conference pair
   twice — the pattern of an 84-game schedule, re-derived from the feed.

   Everything below that is a FACT ABOUT THE 2026-27 SEASON carries its
   source and a verification status. The publisher refuses to publish while
   any fact that changes a published number is UNVERIFIED (registry.ts).
   =========================================================================== */
import type { NhlTeam, Conference } from './rules.ts';
import type { SeasonFact } from '../nfl/config.ts';

const T = (code: string, name: string, division: string): NhlTeam => ({
  code, name, division, conference: (division === 'Atlantic' || division === 'Metropolitan' ? 'Eastern' : 'Western') as Conference
});

export const NHL_TEAMS_2027: NhlTeam[] = [
  T('BOS', 'Boston Bruins', 'Atlantic'), T('BUF', 'Buffalo Sabres', 'Atlantic'), T('DET', 'Detroit Red Wings', 'Atlantic'), T('FLA', 'Florida Panthers', 'Atlantic'),
  T('MTL', 'Montréal Canadiens', 'Atlantic'), T('OTT', 'Ottawa Senators', 'Atlantic'), T('TBL', 'Tampa Bay Lightning', 'Atlantic'), T('TOR', 'Toronto Maple Leafs', 'Atlantic'),
  T('CAR', 'Carolina Hurricanes', 'Metropolitan'), T('CBJ', 'Columbus Blue Jackets', 'Metropolitan'), T('NJD', 'New Jersey Devils', 'Metropolitan'), T('NYI', 'New York Islanders', 'Metropolitan'),
  T('NYR', 'New York Rangers', 'Metropolitan'), T('PHI', 'Philadelphia Flyers', 'Metropolitan'), T('PIT', 'Pittsburgh Penguins', 'Metropolitan'), T('WSH', 'Washington Capitals', 'Metropolitan'),
  T('CHI', 'Chicago Blackhawks', 'Central'), T('COL', 'Colorado Avalanche', 'Central'), T('DAL', 'Dallas Stars', 'Central'), T('MIN', 'Minnesota Wild', 'Central'),
  T('NSH', 'Nashville Predators', 'Central'), T('STL', 'St. Louis Blues', 'Central'), T('UTA', 'Utah Mammoth', 'Central'), T('WPG', 'Winnipeg Jets', 'Central'),
  T('ANA', 'Anaheim Ducks', 'Pacific'), T('CGY', 'Calgary Flames', 'Pacific'), T('EDM', 'Edmonton Oilers', 'Pacific'), T('LAK', 'Los Angeles Kings', 'Pacific'),
  T('SEA', 'Seattle Kraken', 'Pacific'), T('SJS', 'San Jose Sharks', 'Pacific'), T('VAN', 'Vancouver Canucks', 'Pacific'), T('VGK', 'Vegas Golden Knights', 'Pacific')
];

/* Division membership of the earlier seasons the history test replays
   (simulator/tests/nhl_rules_history.test.ts). 2019-20 (season cut short,
   points-percentage seeding, qualifying round) and 2020-21 (temporary
   divisions, 56 games, no wild cards) used other formats and are not
   replayed. */
const ATL = ['BOS', 'BUF', 'DET', 'FLA', 'MTL', 'OTT', 'TBL', 'TOR'];
const MET = ['CAR', 'CBJ', 'NJD', 'NYI', 'NYR', 'PHI', 'PIT', 'WSH'];
export function nhlAlignment(season: number): Record<string, string[]> {
  if (season === 2020 || season === 2021) throw new Error('season ' + season + ' used a temporary format; no alignment is replayed');
  if (season >= 2025) return { Atlantic: ATL, Metropolitan: MET, Central: ['CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'UTA', 'WPG'], Pacific: ['ANA', 'CGY', 'EDM', 'LAK', 'SEA', 'SJS', 'VAN', 'VGK'] };
  if (season >= 2022) return { Atlantic: ATL, Metropolitan: MET, Central: ['ARI', 'CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'WPG'], Pacific: ['ANA', 'CGY', 'EDM', 'LAK', 'SEA', 'SJS', 'VAN', 'VGK'] };
  if (season >= 2018) return { Atlantic: ATL, Metropolitan: MET, Central: ['CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'WPG'], Pacific: ['ANA', 'ARI', 'CGY', 'EDM', 'LAK', 'SJS', 'VAN', 'VGK'] };
  if (season >= 2015) return { Atlantic: ATL, Metropolitan: MET, Central: ['CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'WPG'], Pacific: ['ANA', 'ARI', 'CGY', 'EDM', 'LAK', 'SJS', 'VAN'] };
  if (season === 2014) return { Atlantic: ATL, Metropolitan: MET, Central: ['CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'WPG'], Pacific: ['ANA', 'CGY', 'EDM', 'LAK', 'PHX', 'SJS', 'VAN'] };
  throw new Error('no division/wild-card alignment before 2013-14 (season ' + season + ')');
}
export function teamsFromAlignment(a: Record<string, string[]>): NhlTeam[] {
  const out: NhlTeam[] = [];
  for (const d of Object.keys(a).sort()) for (const c of a[d]) out.push(T(c, c, d));
  return out;
}

export interface NhlSeasonConfig {
  sport: 'nhl';
  competition: 'NHL';
  /** season end year (2027 = 2026-27) */
  season: number;
  season_label: string;
  regular_season_games_per_club: number;
  rules_version: string;
  rules: SeasonFact<string>;
  playoff_format: SeasonFact<string>;
  home_ice: SeasonFact<string>;
  overtime: SeasonFact<string>;
  /** within-season strength drift: OFF; a hook only, with no validated parameters */
  drift: { mode: 'off' };
  /** goalie and skater availability: which starts may enter a price, and the baseline when none is known */
  availability: { mode: 'confirmed_starters_only'; baseline: string; confirmed_source: string; projected: string; skaters: string };
}

export const NHL_2027: NhlSeasonConfig = {
  sport: 'nhl',
  competition: 'NHL',
  season: 2027,
  season_label: '2026-27',
  regular_season_games_per_club: 84,
  rules_version: 'NHL-TB-2019',
  rules: {
    value: 'Clubs tied in points: 1 points percentage, 2 regulation wins, 3 regulation + overtime wins, 4 total wins, 5 points in games among the tied clubs (percentage of available points; each pair\'s odd game(s) - the first game played in the city that had the extra game - excluded), 6 goal differential (overtime goals and the shootout-winner credit included), 7 goals for; beyond: seeded coin toss (counted). 2 points per win, 1 per overtime or shootout loss.',
    source: 'NHL.com, Tie-Breaking Procedure, https://www.nhl.com/info/standings-info/tie-breaking-procedure (HTTP 200; page sha256 84f4dcedb26fd9712ec640b6844c7e96aac26c22f3861cf46240749b0ff7e61e, text sha256 0f154a833b7cf61363c86b8bbfe60ecd2c10c76db3c25789c82da706b773721e). Its seven steps, compared one by one with rules.ts NHL_TB_2019: 1 fewer games played (superior points percentage), 2 regulation wins (RW), 3 wins excluding shootout wins (ROW), 4 total wins, 5 points in games among the tied clubs - the first game in the city with the extra game (the odd game) excluded, the percentage of available points among three or more - 6 goal differential including overtime goals and the goal awarded for a shootout win, 7 goals for, same inclusion; NOTE: a shootout win counts as one goal for, a shootout loss one goal against. Identical. The page states no step beyond goals for and no restart for three or more clubs (the engine: seeded coin, counted; no restart). The same order reproduces every 2021-22 .. 2025-26 playoff field, pairing and home-ice assignment in hockey/data/team_games (simulator/tests/nhl_rules_history.test.ts).',
    retrieved: '2026-10-23',
    verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml and compare the NHL.com tie-breaking page with NHL_SIMULATOR_NOTES.md §9.2.',
    affects_results: true,
    verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39957383090 (Simulator source check, job fetch (nhl), 2026-10-23T12:59Z)',
    verified_at: '2026-10-23'
  },
  playoff_format: {
    value: '16 clubs: top 3 of each division + 2 wild cards per conference; the division winner with the better record meets WC2, the other meets WC1, D2 meets D3; fixed bracket (no reseeding); every round best of seven.',
    source: 'NHL.com, Playoff Format, https://www.nhl.com/info/standings-info/playoff-format (HTTP 200; page sha256 7ed1469132bf1b89a3edb575310cd3e3b17760459cac3f6250613480a346ddf7, text sha256 af4bc9dfab221102fa3fba6626eb645a2f83c5bdd51834bd8fdb78aa9cf6a218): 16 teams; a set bracket, largely division-based with wild cards; the top three in each division, then the next two highest-placed finishers in each conference regardless of division; the division winner with the best record meets the wild card with the lesser record, the better wild card the other division winner; second and third meet within the bracket headed by their division winner; first-round winners within each bracket meet in the second round; every round best of seven. Identical to rules.ts buildBracket / playPostseason, and reproduced against every 2013-14 .. 2018-19 and 2021-22 .. 2025-26 series (simulator/tests/nhl_rules_history.test.ts).',
    retrieved: '2026-10-23',
    verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml and compare the NHL.com playoff-format page with NHL_SIMULATOR_NOTES.md §9.3.',
    affects_results: true,
    verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39957383090 (Simulator source check, job fetch (nhl), 2026-10-23T12:59Z)',
    verified_at: '2026-10-23'
  },
  home_ice: {
    value: 'Rounds 1-2: the club placed higher in the bracket (D1 > D2 > D3 > wild card). Conference final and Stanley Cup Final: the better regular-season record (points, then the tiebreakers). Series 2-2-1-1-1 (games 1, 2, 5, 7 at the club with home ice).',
    source: 'NHL.com, Playoff Format, https://www.nhl.com/info/standings-info/playoff-format (HTTP 200; page sha256 7ed1469132bf1b89a3edb575310cd3e3b17760459cac3f6250613480a346ddf7): "Home-ice advantage through the first two rounds goes to the team that placed higher in the regular-season standings" and "In the Conference Finals and Stanley Cup Final, home-ice advantage goes to the team that had the better regular-season record - regardless of the teams\' final standing in their respective divisions." The contrast places the first two rounds by divisional standing (D1 > D2 > D3; a wild card below the division\'s top three), which is what every series of 2013-14 .. 2018-19 and 2021-22 .. 2025-26 in hockey/data/team_games shows (165 of 165, including 2016 round 2: Tampa Bay, Atlantic 2nd, 97 points, hosted the wild-card NY Islanders, 100). The 2-2-1-1-1 order is not on the page; it is the order of every one of those series\' games (simulator/tests/nhl_rules_history.test.ts).',
    retrieved: '2026-10-23',
    verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml and compare the NHL.com playoff-format page with NHL_SIMULATOR_NOTES.md §9.4.',
    affects_results: true,
    verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39957383090 (Simulator source check, job fetch (nhl), 2026-10-23T12:59Z)',
    verified_at: '2026-10-23'
  },
  overtime: {
    value: 'Regular season: 5-minute 3-on-3 sudden-death overtime, then a shootout. Playoffs: 20-minute 5-on-5 sudden-death periods until a goal; no shootout.',
    source: 'NHL overtime format since 2015-16, as modelled by hockey/model/distribution.js (formats R3v3 and PO); the regular-season OT/SO split is fitted on seasons before the one priced (hockey/model/params/live.json ot).',
    retrieved: '2026-10-23',
    verification: 'NOT_APPLICABLE',
    verify_by: 'Model convention, validated by simulator/data/nhl_goal_distribution.json (OT share of tied games, shootout home rate).',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  drift: { mode: 'off' },
  availability: {
    mode: 'confirmed_starters_only',
    baseline: 'No starting goalie is assumed for any game. Every remaining game is priced by the served model (xg_core), whose ratings carry each club\'s goaltending as its goals-against record: the club\'s recent mix of starters continues. No injury, return or new absence is simulated for goalies or skaters.',
    confirmed_source: 'A starter recorded in hockey/data/confirmed_starters.json with its source and recorded_at time prices that one game with the served model\'s confirmed-goalie variant (xg_goalie_confirmed, the confirmed goalie\'s rating); a record without a source and time is refused.',
    projected: 'Projected starters (hockey/model/ratings.js projectStarters, recent usage and the back-to-back rule) are NOT used: the projected-goalie model did not beat xg_core by the selection rule (hockey/validation/nhl_walkforward.json), so a projection would move prices without validated gain.',
    skaters: 'Skater lineups are not in the served price (no pregame lineup feed; the lineup variant did not clear the selection bar). No skater availability is simulated.'
  }
};
