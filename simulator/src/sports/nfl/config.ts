/* ===========================================================================
   NFL 2026 — the season configuration the simulator runs under.

   Alignment: 32 clubs, 8 divisions, unchanged since 2002. Codes are
   nflverse's (the Rams are LA), the codes games.csv uses. The test
   simulator/tests/nfl_config.test.ts holds this table equal to
   supabase/nfl_market_structure.sql's seeded public.nfl_team_divisions and
   to the division-game flags of the 2026 schedule itself.

   Everything below that is a FACT ABOUT THE 2026 SEASON carries its source
   and a verification status. The publisher refuses to publish while any
   item that changes a published number is not VERIFIED with a named
   verifier and a date (simulator/src/sports/registry.ts, activation gates).
   The three were verified on 2026-10-23 against the NFL's own pages, read
   from GitHub's runners by .github/workflows/simulator-sources.yml.
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
  /** an unverified rule every run measures instead: while unverified it is no standing blocker, and a run in
      which it decided a reported place is refused publication (MLB: run.tiebreak_measured) */
  measured?: boolean;
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
  super_bowl: SeasonFact<{ name: string; venue: string; roof: string; surface: string; date: string | null; designated_home: 'AFC' | 'NFC' }>;
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
    source: 'NFL.com, NFL Tiebreaking Procedures, https://www.nfl.com/standings/tie-breaking-procedures (HTTP 200; page sha256 268595de8e1306332938cfa11d30ab979adee0de90aff1bfb804c72d9abf20d5, text sha256 876ae864b5826dc712a6d3db079196e089aea03ac738e915827781b73ad06a6d). Compared step by step with rules.ts: division two clubs (12 steps) and three or more (12 steps, restart at step 1), wild card two clubs (11 steps) and three or more (division reduction, head-to-head sweep, restart at step 2), the other procedures (one club advances per step, common games by percentage, combined ranking with shared positions, home-field priority by the wild card tiebreakers): identical. Unchanged for 2026: the league\'s Approved 2026 Playing Rules, Bylaws and Resolutions (media.nfl.com, Mar 31 2026; page sha256 88e418102c1b2658da6b859b0e7ff01e8bf4fa571ae2a2be27df0c50bf2d0a15) and the 2026 proposals (PDF sha256 9b944fe84ba54e3eb7f390d8a51086571e137b4f00b7bbbe04c7d97af03b12f1) contain no tiebreaking or seeding change. operations.nfl.com/the-rules/nfl-tiebreaking-procedures answered 404 on 2026-10-23.',
    retrieved: '2026-10-23',
    verification: 'VERIFIED',
    verify_by: 'Each season: re-run .github/workflows/simulator-sources.yml and compare the NFL.com procedures and the league\'s approved rules for that season with SIMULATOR_NOTES.md §7.',
    affects_results: true,
    verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39950435701 (Simulator source check)',
    verified_at: '2026-10-23'
  },
  playoff_format: {
    value: '7 clubs per conference (4 division winners seeded 1-4 by record, 3 wild cards 5-7); seed 1 bye; wild card 2v7 3v6 4v5 at the better seed; divisional round reseeded (seed 1 hosts the lowest remaining seed); conference final at the better seed; Super Bowl neutral',
    source: 'Field and rounds: NFL.com tiebreaking procedures, https://www.nfl.com/standings/tie-breaking-procedures — three Wild-Card clubs per conference; the selection-meeting order has 18 non-playoff clubs, 6 Wild Card losers, 4 Divisional losers and 2 Conference Championship losers (14 clubs, one bye per conference); home-field priority among division winners by the Wild Card tiebreakers and among Wild Card qualifiers by the division or Wild Card tiebreakers. Seeding and the divisional reseeding: the 2020-2025 postseason games in nflverse games.csv, reproduced by simulator/tests/nfl_rules_history.test.ts. Unchanged for 2026: no playoff, seeding or postseason bylaw among the league\'s Approved 2026 Playing Rules, Bylaws and Resolutions (https://media.nfl.com/football-information/2026/news/approved-2026-playing-rules--bylaws-and-resolutions) or the 2026 proposals (sha256 in the rules fact).',
    retrieved: '2026-10-23',
    verification: 'VERIFIED',
    verify_by: 'Each season: the league\'s approved rules and bylaws for that season (re-run .github/workflows/simulator-sources.yml).',
    affects_results: true,
    verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39950435701 (Simulator source check)',
    verified_at: '2026-10-23'
  },
  super_bowl: {
    value: { name: 'Super Bowl LXI', venue: 'SoFi Stadium', roof: 'dome', surface: 'fieldturf', date: null, designated_home: 'NFC' },
    source: 'Venue: NFL.com, "SoFi Stadium approved to host Super Bowl LXI in 2027", https://www.nfl.com/news/sofi-stadium-approved-to-host-super-bowl-lxi-in-2027 — "Super Bowl LXI in February 2027 will be played at SoFi Stadium in Inglewood" (page sha256 aea582459bbde763d92a4629a8fd3bc4dc152f970f398bd157d3fb81c8eb190c); roof per football/venues/nfl_stadiums.json (SoFi: dome). Designated home: NFL.com, "Bengals, not Rams, are official home team for Super Bowl LVI at SoFi Stadium", https://www.nfl.com/news/bengals-not-rams-are-official-home-team-for-super-bowl-lvi-at-sofi-stadium — "The home team designation for the Super Bowl alternates each year between the AFC and NFC champions" (page sha256 de30036ddad8cc70aab67fb61245f5dbce3d57cd756f99bc7aa48b251cec9ab0); LVI AFC (Bengals), so LVII NFC, LVIII AFC, LIX NFC, LX AFC, LXI NFC — the same alternation nflverse games.csv shows for every Super Bowl 2002-2025 (24 of 24, re-derived by simulator/tests/nfl_config.test.ts). Date: null — the NFL text says February 2027 and no exact day was fetched; the served model\'s Super Bowl prices do not depend on it (all 256 Super Bowl pairs unchanged with the date set, moved a week, or absent; measured 2026-10-23).',
    retrieved: '2026-10-23',
    verification: 'VERIFIED',
    verify_by: 'The designated home flips each season (it moves Super Bowl prices by up to 0.33 points); the venue is the league\'s announced site.',
    affects_results: true,
    verified_by: 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39950435701 (Simulator source check)',
    verified_at: '2026-10-23'
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
