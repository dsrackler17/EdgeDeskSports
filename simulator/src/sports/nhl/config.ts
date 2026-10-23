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
    source: 'NHL standings tie-breaking procedure in force since 2019-20 (regulation wins added as the first criterion after points percentage), as recorded in this repository from the NHL\'s published procedure; not re-read from an official page in this build (nhl.com, records.nhl.com and media.nhl.com were not reachable from the build environment). Consistent with every 2021-22 .. 2025-26 playoff field, pairing and home-ice assignment re-derived from hockey/data/team_games (simulator/tests/nhl_rules_history.test.ts).',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'Compare NHL_SIMULATOR_NOTES.md §Rules with the tie-breaking procedure on NHL.com standings for 2026-27 (in particular any change for the 84-game schedule and the treatment of three-or-more-club ties at the head-to-head step).',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  playoff_format: {
    value: '16 clubs: top 3 of each division + 2 wild cards per conference; the division winner with the better record meets WC2, the other meets WC1, D2 meets D3; fixed bracket (no reseeding); every round best of seven.',
    source: 'NHL division-based playoff format in force since 2013-14 (except the 2019-20 and 2020-21 emergency formats); reproduced against every 2013-14 .. 2018-19 and 2021-22 .. 2025-26 playoff series in hockey/data/team_games by simulator/tests/nhl_rules_history.test.ts.',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'Confirm no 2026-27 change to the playoff format (NHL.com, Stanley Cup Playoffs format).',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  home_ice: {
    value: 'Rounds 1-2: the club placed higher in the bracket (D1 > D2 > D3 > wild card). Conference final and Stanley Cup Final: the better regular-season record (points, then the tiebreakers). Series 2-2-1-1-1 (games 1, 2, 5, 7 at the club with home ice).',
    source: 'Derived from the owned data: every series of 2013-14 .. 2018-19 and 2021-22 .. 2025-26 (165 series) in hockey/data/team_games, including 2016 round 2 (Tampa Bay, Atlantic 2nd, 97 points, hosted the NY Islanders, wild card, 100 points) which a points-only rule gets wrong. Not read from an official page.',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'Confirm the 2026-27 home-ice rule (NHL.com, Stanley Cup Playoffs format).',
    affects_results: true,
    verified_by: null,
    verified_at: null
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
