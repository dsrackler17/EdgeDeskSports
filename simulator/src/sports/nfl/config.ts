/* ===========================================================================
   NFL 2026 — the season configuration the simulator runs under.

   Alignment: 32 clubs, 8 divisions, unchanged since 2002. Codes are
   nflverse's (the Rams are LA), the codes games.csv uses. The test
   simulator/tests/nfl_config.test.ts holds this table equal to
   supabase/nfl_market_structure.sql's seeded public.nfl_team_divisions and
   to the division-game flags of the 2026 schedule itself.

   Everything below that is a FACT ABOUT THE 2026 SEASON carries its source
   and a verification status. The publisher refuses to publish while any
   item that changes a published number is UNVERIFIED (see
   simulator/src/sports/registry.ts, activation gates).
   =========================================================================== */
import type { NflTeam } from './rules.ts';

const T = (code: string, name: string, division: string): NflTeam => ({ code, name, conference: division.slice(0, 3) as 'AFC' | 'NFC', division });

export const NFL_TEAMS_2026: NflTeam[] = [
  T('BUF', 'Buffalo Bills', 'AFC East'), T('MIA', 'Miami Dolphins', 'AFC East'), T('NE', 'New England Patriots', 'AFC East'), T('NYJ', 'New York Jets', 'AFC East'),
  T('BAL', 'Baltimore Ravens', 'AFC North'), T('CIN', 'Cincinnati Bengals', 'AFC North'), T('CLE', 'Cleveland Browns', 'AFC North'), T('PIT', 'Pittsburgh Steelers', 'AFC North'),
  T('HOU', 'Houston Texans', 'AFC South'), T('IND', 'Indianapolis Colts', 'AFC South'), T('JAX', 'Jacksonville Jaguars', 'AFC South'), T('TEN', 'Tennessee Titans', 'AFC South'),
  T('DEN', 'Denver Broncos', 'AFC West'), T('KC', 'Kansas City Chiefs', 'AFC West'), T('LV', 'Las Vegas Raiders', 'AFC West'), T('LAC', 'Los Angeles Chargers', 'AFC West'),
  T('DAL', 'Dallas Cowboys', 'NFC East'), T('NYG', 'New York Giants', 'NFC East'), T('PHI', 'Philadelphia Eagles', 'NFC East'), T('WAS', 'Washington Commanders', 'NFC East'),
  T('CHI', 'Chicago Bears', 'NFC North'), T('DET', 'Detroit Lions', 'NFC North'), T('GB', 'Green Bay Packers', 'NFC North'), T('MIN', 'Minnesota Vikings', 'NFC North'),
  T('ATL', 'Atlanta Falcons', 'NFC South'), T('CAR', 'Carolina Panthers', 'NFC South'), T('NO', 'New Orleans Saints', 'NFC South'), T('TB', 'Tampa Bay Buccaneers', 'NFC South'),
  T('ARI', 'Arizona Cardinals', 'NFC West'), T('LA', 'Los Angeles Rams', 'NFC West'), T('SF', 'San Francisco 49ers', 'NFC West'), T('SEA', 'Seattle Seahawks', 'NFC West')
];

export type Verification = 'VERIFIED' | 'UNVERIFIED' | 'NOT_APPLICABLE';

export interface SeasonFact<V> {
  value: V;
  source: string;
  retrieved: string;
  verification: Verification;
  /** what a person must check to verify it */
  verify_by: string;
  /** whether this fact moves a published probability */
  affects_results: boolean;
  /** who checked it against the official source, and when (YYYY-MM-DD); both required for VERIFIED to count */
  verified_by: string | null;
  verified_at: string | null;
}

export interface NflSeasonConfig {
  sport: 'nfl';
  competition: 'NFL';
  season: number;
  regular_season_games_per_club: number;
  regular_season_weeks: number;
  rules_version: string;
  rules: SeasonFact<string>;
  playoff_format: SeasonFact<string>;
  super_bowl: SeasonFact<{ name: string; venue: string; roof: string; surface: string; date: string; designated_home: 'AFC' | 'NFC' }>;
  /** estimated postseason rest inputs the model reads (days); null = the model's own missing-value default (7) */
  postseason_rest: SeasonFact<{ wild_card: number | null; divisional_after_bye: number; divisional_after_wild_card: number | null; conference: number | null; super_bowl: number }>;
  /** within-season strength drift: OFF; a hook only, with no validated parameters */
  drift: { mode: 'off' };
  /** availability: no injury return sampling (no owned return-date distribution) */
  availability: { mode: 'off'; fixed_assumption: string };
}

export const NFL_2026: NflSeasonConfig = {
  sport: 'nfl',
  competition: 'NFL',
  season: 2026,
  regular_season_games_per_club: 17,
  regular_season_weeks: 18,
  rules_version: 'NFL-TB-2020',
  rules: {
    value: 'NFL tiebreaking procedures: division (two clubs / three or more), wild card (two clubs / three or more), other procedures; ties count half',
    source: 'Procedure text as transcribed (verbatim from NFL.com and operations.nfl.com) in nflverse/nflseedR vignettes/articles/tiebreaker.Rmd (dated 2023-12-20), https://raw.githubusercontent.com/nflverse/nflseedR/master/vignettes/articles/tiebreaker.Rmd',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'Compare SIMULATOR_NOTES.md §NFL rules with https://operations.nfl.com/the-rules/nfl-tiebreaking-procedures/ for the 2026 season (operations.nfl.com and nfl.com were not reachable from the build environment). The engine reproduces every division rank and seed of 2002-2025 (nflverse standings).',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  playoff_format: {
    value: '7 clubs per conference (4 division winners seeded 1-4 by record, 3 wild cards 5-7); seed 1 bye; wild card 2v7 3v6 4v5 at the better seed; divisional round reseeded (seed 1 hosts the lowest remaining seed); conference final at the better seed; Super Bowl neutral',
    source: 'NFL playoff format in force since the 2020 season (nflverse/nflseedR; reproduced against the 2020-2025 postseason games in nflverse games.csv by simulator/tests/nfl_rules_history.test.ts)',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'Confirm no 2026 change to the playoff format or seeding (e.g. a seeding-by-record proposal) at https://operations.nfl.com/ — the 2026 rule book.',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  super_bowl: {
    value: { name: 'Super Bowl LXI', venue: 'SoFi Stadium', roof: 'dome', surface: 'fieldturf', date: '2027-02-14', designated_home: 'NFC' },
    source: 'Designated home: nflverse games.csv lists the NFC club as the home team of every odd-numbered Super Bowl and the AFC club of every even-numbered one, 2002-2025 (XXXVII-LX, 24 of 24; simulator/tests/nfl_config.test.ts re-derives it from simulator/fixtures/nfl_history.json.gz); LXI is odd, so NFC. Venue: SoFi Stadium, Inglewood (recalled, not verified from an official page); roof per football/venues/nfl_stadiums.json (SoFi: dome). Date recalled, not verified.',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'Confirm the Super Bowl LXI venue and date with the NFL (the designated home conference follows the 24-season alternation in the owned data). The served model reads the designated home club\'s context terms (week, venue) even at a neutral site.',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  postseason_rest: {
    value: { wild_card: null, divisional_after_bye: 14, divisional_after_wild_card: null, conference: null, super_bowl: 14 },
    source: 'Estimated from the format: a bye club and both Super Bowl clubs rest two weeks; every other postseason game is one week after the last (null: the served model\'s own default of 7 days for a missing rest value). The exact game dates are not on the schedule until the bracket is set.',
    retrieved: '2026-10-23',
    verification: 'NOT_APPLICABLE',
    verify_by: 'Estimated input, labelled Estimated in the reader.',
    affects_results: true,
    verified_by: null,
    verified_at: null
  },
  drift: { mode: 'off' },
  availability: {
    mode: 'off',
    fixed_assumption: 'No injury return is sampled. Every remaining game is priced with the starter the board itself prices: the schedule feed\'s named quarterback where one is filled in (through the current week), reconciled against the injury report (OUT/DOUBTFUL -> the club\'s most recent other starter); beyond that, the club\'s carried quarterback level (the served model\'s unknown-starter path). EdgeDesk owns no return-date distribution, so none is invented.'
  }
};
