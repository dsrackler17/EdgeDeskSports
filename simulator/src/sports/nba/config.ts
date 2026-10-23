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

/* Verified 2026-10-23 from the league's own text, read by the Simulator source check (GitHub Actions run 39996632843,
   .github/workflows/simulator-sources.yml): nba.com, api-hub.nba.com and pr.nba.com answer the runners 403, so each page
   is the Internet Archive's copy as published (web.archive.org/web/<capture>id_/, the archived bytes); text sha256 as
   the run printed it. */
const VERIFIED_BY = 'Claude Code (EdgeDesk NBA simulator session), at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run 39996632843 (Simulator source check)';
const OK = { verification: 'VERIFIED' as const, affects_results: true, verified_by: VERIFIED_BY, verified_at: '2026-10-23', retrieved: '2026-10-23' };
const SRC = {
  standings: 'nba.com/standings, "Play-In and Playoff Tie-Break Procedures" (Paragraph L.2), as captured 2026-10-13 11:39 UTC (https://web.archive.org/web/20261013113932id_/https://www.nba.com/standings; text sha256 9ccf2926d0697806f09bc9bbd92d03fc864fea02cdc03001f2e7022f55db3a86)',
  play_in: 'nba.com, "Everything to know about 2026 SoFi NBA Play-In Tournament", as captured 2026-10-05 (https://web.archive.org/web/20261005095017id_/https://www.nba.com/news/nba-play-in-tournament; text sha256 d232b79436ae3e0398f63d78298189f1f55d40973f3a3cdfe96cff2bd7c77a24)',
  release: 'nba.com, "NBA announces schedule for 2026-27 season", as captured 2026-10-07 (https://web.archive.org/web/20261007105723id_/https://www.nba.com/news/2026-27-nba-regular-season-schedule; text sha256 551e774563ec6a308dc227e65373075d2909df36d27d529854d72c81dee34dd7)',
  key_dates: 'nba.com, "Key dates for 2026-27 NBA season", as captured 2026-10-15 (https://web.archive.org/web/20261015010039id_/https://www.nba.com/news/key-dates; text sha256 414a3878a38e5f9d949bec5c1efeeb3623b0524be1ede0acf8b85a28e896bb79)',
  cup_101: 'nba.com, "Emirates NBA Cup 101", as captured 2026-10-10 (https://web.archive.org/web/20261010210309id_/https://www.nba.com/news/nba-cup-101; text sha256 6e8e2975b05c5f38a2c4a60733264b2db2d2e269b942a5cb4a87ca29845a6069)',
  cup_faq: 'nba.com, "Emirates NBA Cup: Frequently Asked Questions", as captured 2026-10-10 (https://web.archive.org/web/20261010210310id_/https://www.nba.com/news/nba-cup-frequently-asked-questions; text sha256 0d3006f37ccb1cdc9b349ec6a8bb34271e8089c842f3bdfdbcb84858defbe7f0)',
  seeding_2015: 'NBA Communications, "NBA to seed conference playoff teams by record" (2015), as captured 2025-12-13 (https://web.archive.org/web/20251213072511id_/https://pr.nba.com/nba-playoff-seeding-changes/; text sha256 d6c7af45132cce09baa0cd2de67d2c9eb01ba2db1c713906754457344fa48217)',
  finals_2014: 'NBA Communications, "NBA Board of Governors unanimously approves format change for The Finals" (2014), as captured 2025-12-09 (https://web.archive.org/web/20251209175338id_/https://pr.nba.com/nba-finals-format-change-2014/; text sha256 70b38db449e4f6574f0bb9b9043a8d97be3a5308527b48bc5b97de57f8626d0b)'
};
const RECHECK = 'Each season: re-run .github/workflows/simulator-sources.yml (the NBA job) and compare the pages it prints with NBA_SIMULATOR_NOTES.md §5 and simulator/src/sports/nba/rules.ts.';

export const NBA_2026_27: NbaSeasonConfig = {
  sport: 'nba', competition: 'NBA', season: 2027, label: '2026-27',
  regular_season_games_per_club: 82,
  rules_version: 'NBA-2021',
  tiebreakers: {
    ...OK,
    value: 'Two clubs: head-to-head; division winner; division record (same division only); conference record; record vs postseason-eligible clubs of own conference; vs those of the other conference; point differential; random drawing. Three or more: division winner; record in games among the tied clubs; division record (all in one division only); conference record; vs postseason-eligible clubs of own conference; point differential; random drawing. Division ties first, their result used only for the division title. The first criterion that tells the clubs apart orders the levels it separates (a complete break orders all of them); each group still level starts again from the first criterion with the two-club or multi-club list (Paragraph L.2.c).',
    source: SRC.standings + ': L.2.a (two teams, 7 criteria), L.2.b (more than two, 6 criteria), L.2.c (division ties first and used only for the division winner; complete and partial breaks; a group still tied after a partial break starts again from the beginning; a random drawing when nothing breaks the tie). Compared step by step with rules.ts: both lists and their order match. The page\'s complete/partial-break rule differed from the code (which ranked only the best level and restarted everyone below it): rules.ts was corrected on 2026-10-23 (nba_rules_synthetic.test.ts holds a case that tells them apart). Every season 2006-07..2025-26 (except 2019-20) reproduces under the corrected rule (nba_rules_history.test.ts).',
    verify_by: RECHECK
  },
  playoff_clubs_for_tiebreakers: {
    ...OK,
    value: { place: 10 },
    source: SRC.standings + ': the steps against "teams eligible for the postseason" in own / opposite conference include "teams that finished the Regular Season tied for one of the best 10 records in their conference" — the clubs at or above the record of the 10th place, ties included, as rules.ts counts them.',
    verify_by: RECHECK
  },
  play_in: {
    ...OK,
    value: '7th hosts 8th, the winner is the 7 seed; 9th hosts 10th, the loser is out; the loser of 7-8 hosts the winner of 9-10, the winner is the 8 seed. Single games; places by the regular-season standings after tiebreakers.',
    source: SRC.play_in + ': "Each conference\'s No. 7 team in the standings will host the No. 8 team. The winners secure the No. 7 seed ... Each conference\'s No. 9 team in the standings will host the No. 10 team ... The losers are eliminated. The losers of the No. 7 vs. No. 8 matchups will host the winners of the No. 9 vs. No. 10 matchups. The winners secure the No. 8 seed." For 2026-27: ' + SRC.release + ': "all six games of the SoFi NBA Play-In Tournament 2027 ... Teams seeded seventh through 10th in each conference will compete for the final two playoff berths"; ' + SRC.key_dates + ': "April 13-16: SoFi NBA Play-In Tournament". Reproduced against every play-in game 2020-21..2025-26 (36 games).',
    verify_by: RECHECK
  },
  playoff_format: {
    ...OK,
    value: '8 clubs per conference; fixed bracket, no reseeding: 1-8 and 4-5 meet in the semifinals, 2-7 and 3-6; best of seven every round, 2-2-1-1-1 (games 1, 2, 5, 7 at the club with home court).',
    source: 'Field: ' + SRC.seeding_2015 + ': "the eight playoff teams in each conference will be seeded in order of their regular-season record"; seeds 7 and 8 from the play-in (' + SRC.release + '). Series: ' + SRC.finals_2014 + ': "a 2-2-1-1-1 schedule, where the team with home-court advantage will host Games 1, 2, 5 and 7 ... aligns The Finals format with every other round of the NBA Playoffs". The fixed bracket (1-8 v 4-5, 2-7 v 3-6, no reseeding) is stated on none of the pages read; as with the NFL\'s seeding, it rests on every playoff pairing and every game\'s host 2006-07..2025-26 (except 2019-20) in nba/data/games, reproduced by nba_rules_history.test.ts (the Finals were 2-3-2 through 2012-13). The 2026 Finals in the key dates page (games 1, 2 and 5 in San Antonio, 3 and 4 in New York) follow it.',
    verify_by: RECHECK + ' A league statement of the bracket (or of any reseeding) would replace the history evidence.'
  },
  home_court: {
    ...OK,
    value: 'The club with the better regular-season record has home court in every series (within a conference: the better place in the standings, which for a play-in qualifier is not its seed); the Finals: better record, then the two-club tiebreaker across conferences.',
    source: SRC.seeding_2015 + ': a division winner "did not receive home-court advantage if its playoff opponent had a better record"; "Head-to-head results have become the first criterion to break ties for playoff seeding and home-court advantage between two teams with identical regular-season records; the second criterion is whether a team won its division" — the two-club list of ' + SRC.standings + '. Home court therefore goes by record, then those criteria, not by seed: for two play-in qualifiers (a seed-7 v seed-8 conference final, which has not happened) the better place hosts. Every series host 2006-07..2025-26 reproduced.',
    verify_by: RECHECK
  },
  nba_cup: {
    ...OK,
    value: 'Every NBA Cup game counts in the standings except the championship game (nba/data scope nba_cup_final, excluded). 30 regular-season games (two per club: the knockout games and the games scheduled for the clubs that do not advance) are fixed only after the group stage; until they are on the schedule the season cannot be simulated for publication.',
    source: SRC.cup_101 + ': "All 67 games across both stages of the Emirates NBA Cup will count toward the regular-season standings except the Championship. Each team will continue to play 82 regular-season games in the 2026-27 season"; Quarterfinals and Semifinals "will count as regular-season games for all purposes" and are hosted in NBA team markets by the higher seed; "the 22 teams that do not qualify for the Knockout Rounds will each play two regular-season games"; "The four losing teams in the Quarterfinals ... will play each other in a regular-season game" — 4 + 2 + 2 + 22 = 30 games. ' + SRC.release + ': "defined dates and opponents for 80 of each team\'s 82 games". ' + SRC.cup_faq + '. The committed 2026-27 schedule has 1,200 of 1,230 regular-season games, 80 per club.',
    verify_by: 'Each season: as above, and wait for the 30 Cup-dependent games on the schedule (after the group stage: from Dec. 4, 2026).'
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
