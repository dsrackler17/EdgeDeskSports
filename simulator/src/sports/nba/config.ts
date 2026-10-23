/* ===========================================================================
   NBA 2026-27 — the season configuration the simulator runs under.

   Season key 2027 (the END year: nba/config.js, nba/data/games/2027.csv).
   Teams are the ESPN ids and abbreviations the NBA engine and its slate use
   (nba/data/teams.json, team_abbr.json).

   ALIGNMENT. 30 clubs, two conferences of 15, six divisions of five,
   unchanged since 2004-05. It is not recalled: simulator/tests/nba_config.test.ts
   derives it from the committed schedules (a division rival is the only
   opponent played four times in EVERY season 2014-2019, 2022-2023, before
   the NBA Cup changed the counts; a conference rival is played three or
   four times, the other conference twice) and holds this table equal to it,
   and checks the 2026-27 schedule against it. The division NAMES are labels
   (recalled; they change no number).

   Everything below that is a FACT ABOUT THE 2026-27 SEASON carries its
   source and a verification status. The registry refuses to activate the
   sport while any fact that moves a published number is UNVERIFIED
   (simulator/src/sports/registry.ts).
   =========================================================================== */
import type { NbaTeam } from './rules.ts';
import type { SeasonFact } from '../nfl/config.ts';

const ROW: Array<[string, string, string, string]> = [
  ['2', 'BOS', 'Boston Celtics', 'Atlantic'], ['17', 'BKN', 'Brooklyn Nets', 'Atlantic'], ['18', 'NY', 'New York Knicks', 'Atlantic'], ['20', 'PHI', 'Philadelphia 76ers', 'Atlantic'], ['28', 'TOR', 'Toronto Raptors', 'Atlantic'],
  ['4', 'CHI', 'Chicago Bulls', 'Central'], ['5', 'CLE', 'Cleveland Cavaliers', 'Central'], ['8', 'DET', 'Detroit Pistons', 'Central'], ['11', 'IND', 'Indiana Pacers', 'Central'], ['15', 'MIL', 'Milwaukee Bucks', 'Central'],
  ['1', 'ATL', 'Atlanta Hawks', 'Southeast'], ['30', 'CHA', 'Charlotte Hornets', 'Southeast'], ['14', 'MIA', 'Miami Heat', 'Southeast'], ['19', 'ORL', 'Orlando Magic', 'Southeast'], ['27', 'WSH', 'Washington Wizards', 'Southeast'],
  ['7', 'DEN', 'Denver Nuggets', 'Northwest'], ['16', 'MIN', 'Minnesota Timberwolves', 'Northwest'], ['25', 'OKC', 'Oklahoma City Thunder', 'Northwest'], ['22', 'POR', 'Portland Trail Blazers', 'Northwest'], ['26', 'UTAH', 'Utah Jazz', 'Northwest'],
  ['9', 'GS', 'Golden State Warriors', 'Pacific'], ['12', 'LAC', 'LA Clippers', 'Pacific'], ['13', 'LAL', 'Los Angeles Lakers', 'Pacific'], ['21', 'PHX', 'Phoenix Suns', 'Pacific'], ['23', 'SAC', 'Sacramento Kings', 'Pacific'],
  ['6', 'DAL', 'Dallas Mavericks', 'Southwest'], ['10', 'HOU', 'Houston Rockets', 'Southwest'], ['29', 'MEM', 'Memphis Grizzlies', 'Southwest'], ['3', 'NO', 'New Orleans Pelicans', 'Southwest'], ['24', 'SA', 'San Antonio Spurs', 'Southwest']
];
const EAST = new Set(['Atlantic', 'Central', 'Southeast']);
export const NBA_TEAMS: NbaTeam[] = ROW.map(([id, code, name, division]) => ({ id, code, name, conference: EAST.has(division) ? 'East' : 'West', division }));

export interface NbaSeasonConfig {
  sport: 'nba';
  competition: 'NBA';
  /** end-year key */
  season: number;
  label: string;
  regular_season_games_per_club: number;
  rules_version: string;
  tiebreakers: SeasonFact<string>;
  playoff_clubs_for_tiebreakers: SeasonFact<{ place: number }>;
  play_in: SeasonFact<string>;
  playoff_format: SeasonFact<string>;
  home_court: SeasonFact<string>;
  nba_cup: SeasonFact<string>;
  /** Estimated: how rest and travel are set for a postseason game that is not on the schedule yet */
  postseason_schedule: SeasonFact<string>;
  drift: { mode: 'off' };
  availability: { mode: 'off' | 'return_hazards'; fixed_assumption: string };
}

const UNV = { verification: 'UNVERIFIED' as const, affects_results: true, verified_by: null, verified_at: null, retrieved: '2026-10-23' };
const NBA_PAGES = 'nba.com (the league\'s tiebreaker procedures and playoff format for 2026-27); nba.com, official.nba.com and cdn.nba.com were not reachable from the build environment (proxy policy)';

export const NBA_2026_27: NbaSeasonConfig = {
  sport: 'nba', competition: 'NBA', season: 2027, label: '2026-27',
  regular_season_games_per_club: 82,
  rules_version: 'NBA-2021',
  tiebreakers: {
    ...UNV,
    value: 'Two clubs: head-to-head; division winner; division record (same division); conference record; record vs playoff clubs of own conference; vs playoff clubs of the other conference; point differential; random drawing. Three or more: division winner; record in games among the tied clubs; division record (all in one division); conference record; vs playoff clubs of own conference; point differential; random drawing. A step that separates clubs eliminates the rest; the remaining clubs (and, below them, the eliminated) start again from step 1. Division ties are broken first.',
    source: 'The NBA tiebreaker procedure as recalled (no official text could be read from the build environment). Evidence: simulator/tests/nba_rules_history.test.ts replays every season 2006-07 to 2025-26 (except 2019-20) from the committed results and reproduces every play-in pairing and host, every playoff pairing, the host of every postseason game and every series length — including the 2008-09 three-way tie (DEN, POR, SA at 54-28) that fixes the elimination rule.',
    verify_by: 'Compare NBA_SIMULATOR_NOTES.md §Rules and simulator/src/sports/nba/rules.ts with ' + NBA_PAGES + '.'
  },
  playoff_clubs_for_tiebreakers: {
    ...UNV,
    value: { place: 10 },
    source: 'Recalled: with the play-in, "playoff teams" for tiebreak steps 5-6 are the clubs at or above the record of the 10th place (play-in clubs included, ties included). The history test cannot tell 6, 8, 10 or 12 apart: one tie in 2020-21..2025-26 reached that step, and every definition orders it the same way.',
    verify_by: 'Confirm the definition of playoff teams for the tiebreaker with ' + NBA_PAGES + '.'
  },
  play_in: {
    ...UNV,
    value: '7th hosts 8th, the winner is the 7 seed; 9th hosts 10th, the loser is out; the loser of 7-8 hosts the winner of 9-10, the winner is the 8 seed. Single games; places by the regular-season standings after tiebreakers.',
    source: 'The format in force since 2020-21 (recalled); reproduced against every play-in game 2020-21..2025-26 in nba/data/games (36 games: pairings and hosts).',
    verify_by: 'Confirm the 2026-27 play-in format with ' + NBA_PAGES + '.'
  },
  playoff_format: {
    ...UNV,
    value: '8 clubs per conference; fixed bracket, no reseeding: 1-8 and 4-5 meet in the semifinals, 2-7 and 3-6; best of seven every round, 2-2-1-1-1 (games 1, 2, 5, 7 at the club with home court).',
    source: 'Recalled; reproduced against every postseason game 2006-07..2025-26 (except 2019-20) in nba/data/games (the Finals were 2-3-2 through 2012-13).',
    verify_by: 'Confirm the 2026-27 playoff format with ' + NBA_PAGES + '.'
  },
  home_court: {
    ...UNV,
    value: 'The club with the better regular-season record has home court in every series (within a conference: the better place in the standings, which for a play-in qualifier is not its seed); the Finals: better record, then the two-club tiebreaker across conferences.',
    source: 'Recalled; every series host 2006-07..2025-26 reproduced. A tie in record between the two Finals clubs has not occurred in the replayed seasons, so the cross-conference step is untested by history.',
    verify_by: 'Confirm home-court rules with ' + NBA_PAGES + '.'
  },
  nba_cup: {
    ...UNV,
    value: 'Every NBA Cup game counts in the standings except the championship game (nba/data scope nba_cup_final, excluded). 30 regular-season games (two per club: the knockout games and the games scheduled for the clubs that do not advance) are fixed only after the group stage; until they are on the schedule the season cannot be simulated for publication.',
    source: 'The data\'s scope column (nba/ingest/season.js: nba_cup_final apart from the regular season) and the committed 2026-27 schedule: 1,200 of 1,230 regular-season games, 80 per club.',
    verify_by: 'Confirm with ' + NBA_PAGES + ' and wait for the 30 Cup-dependent games on the schedule (after the group stage, early December 2026).'
  },
  postseason_schedule: {
    value: 'Estimated: a postseason game not yet on the schedule takes the median rest of its round and game number in the 2021-22..2025-26 postseasons (nba/data/games), travel between the two arenas in the 2-2-1-1-1 order, no back-to-back, and each club arriving for a series opener from its own arena. A game on the schedule uses its real date and venue.',
    source: 'simulator/src/sports/nba/postseason_context.ts, from the committed games and team-games tables.',
    retrieved: '2026-10-23', verification: 'NOT_APPLICABLE', verify_by: 'Estimated input, labelled Estimated in the reader.', affects_results: true, verified_by: null, verified_at: null
  },
  drift: { mode: 'off' },
  availability: {
    mode: 'return_hazards',
    fixed_assumption: 'Every remaining game is priced with the served projected rotation (who played in the club\'s latest game, nba/model/players.js); a tracked absence (a rotation player who has not played since an earlier game and has not played for another club) returns at a game drawn once per run from the empirical return hazards (simulator/src/sports/nba/availability.ts) and then joins the rotation, priced by the served player model. No new absences are simulated.'
  }
};
