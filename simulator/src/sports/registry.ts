/* ===========================================================================
   EVERY SPORT EDGEDESK COVERS, AND WHETHER IT MAY BE SIMULATED.

   The evidence for each line is in SIMULATOR_NOTES.md §Capability matrix.
   status:
     ACTIVE       every activation gate passes; results may be published
     BLOCKED      implementable; a named dependency is missing (the blockers)
     COMING_SOON  no supported structure or model to build on yet
   A sport is published only when its status is ACTIVE AND the run's own
   gates pass. lib/edgedesk_simulator.js carries a copy of this table for the
   reader (statuses, blockers and limitations are public, never a number);
   simulator/tests/registry.test.ts holds the two equal.
   =========================================================================== */
import { NFL_2026 } from './nfl/config.ts';
import { NHL_2027 } from './nhl/config.ts';
import { MLB_2026 } from './mlb/config.ts';
import { NBA_2026_27 } from './nba/config.ts';
import { cfbFacts, isCfbVerified } from './cfb/config.ts';
import { NCAAM_2027 } from './ncaam/config.ts';
import { WNBA_2026 } from './wnba/config.ts';
import { golfActivation } from './golf/activation.ts';
import { tennisActivation } from './tennis/activation.ts';
import { cbaseActivation } from './college_baseball/activation.ts';
import { UFC_2026 } from './ufc/config.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SportStatus = 'ACTIVE' | 'BLOCKED' | 'COMING_SOON';
export interface SportEntry {
  key: string;
  label: string;
  status: SportStatus;
  structure: 'season' | 'tournament' | 'series' | 'events' | 'none';
  tabs: Array<'division' | 'conference' | 'title' | 'cup' | 'futures' | 'tournament' | 'games' | 'upset_watch' | 'model_health' | 'fights' | 'title_path' | 'leaderboard' | 'finishes' | 'draws' | 'matches'>;
  blockers: string[];
  limitations: string[];
  /** what would have to exist for this sport to be activated */
  activation_path: string;
  /** a sport whose pregame game forecasts are published on their own (college basketball: basketball/ncaam_forecast,
      basketball/ncaaw_forecast). Its seat is open whatever `status` says about its tournament simulation, and the
      reader names the phase of the season instead: Preseason before regular_season_start, the season from it */
  games?: { regular_season_start: string };
}

/** the first game day of the 2026-27 Division I season, men's and women's alike (the first games in the hoopR mbb and
    wehoop wbb schedules, both from ESPN), as midnight US Eastern. The reader turns Preseason into the season at this
    instant; the daily refreshes find the opener in their own schedule files, so they need no date */
const CBB_2027_OPENING_DAY = '2026-11-02T05:00:00Z';

/** NFL: the engine, config and tests are complete; the remaining blocker is
    the human verification of the 2026 facts the official sites hold. */
function nflStatus(): { status: SportStatus; blockers: string[] } {
  return factStatus([['2026 tiebreaking procedures', NFL_2026.rules], ['2026 playoff format', NFL_2026.playoff_format], ['Super Bowl LXI venue and designated home team', NFL_2026.super_bowl]]);
}
/** NHL: ACTIVE once its three 2026-27 rules facts are verified against the NHL's own pages */
function nhlStatus(): { status: SportStatus; blockers: string[] } {
  return factStatus([['2026-27 tie-breaking procedure', NHL_2027.rules], ['2026-27 playoff format', NHL_2027.playoff_format], ['2026-27 playoff home-ice rule', NHL_2027.home_ice]], 'the NHL\'s official source');
}
type Fact = { verification: string; affects_results: boolean; verify_by: string; verified_by: string | null; verified_at: string | null; measured?: boolean };
/** a fact counts as verified only with VERIFIED, a named verifier and a date */
export const isVerified = (f: Fact) => f.verification === 'VERIFIED' && !!f.verified_by && !!f.verified_by.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.verified_at || '');
export function factStatus(facts: Array<[string, Fact]>, source = 'the NFL\'s official source'): { status: SportStatus; blockers: string[] } {
  /* a measured fact is the run's to decide (a gate refuses any run it decided), not a standing blocker */
  const blockers = facts.filter(([, f]) => f.affects_results && !f.measured && !isVerified(f))
    .map(([label, f]) => label + ' not verified against ' + source + ': ' + f.verify_by);
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}

/** CFB: the engine, rules, committee proxy and tests are complete; publication waits on the facts
    whose governing text could not be read or does not yet exist for 2026 (config.ts). */
function cfbStatus(): { status: SportStatus; blockers: string[] } {
  /* a measured assumption is the run's to decide (run.eligibility_sensitive), not a standing blocker */
  const blockers = cfbFacts().filter(([, f]) => f.affects_results && !f.measured && !isCfbVerified(f))
    .map(([label, f]) => label + ': ' + f.label + ' is ' + f.verification + '; the title-game, CFP and national-title outputs it feeds stay unpublished until it is verified (simulator/src/sports/cfb/config.ts lists the source to verify against)');
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}
const CFB_LIMITS = [
  'Game outcomes come from the served edgedesk_cfb_p4 engine replayed over the feed (the path its calibration was validated on, 2014-2025); every game keeps the engine\'s own margin distribution. The engine does not beat the closing line.',
  'Strength uncertainty: one persistent normal offset per team (tau calibrated so the spread of simulated remaining wins matches 2014-2023; 2024-2025 held out), carved out of the engine sigma so no single game is flattened.',
  'FCS opponents are the engine\'s single floor rating (its win rates are calibrated in aggregate on 2014-2025 FBS-vs-FCS games); Pac-12 Week 13 flex games are not in the feed and are not simulated.',
  'Quarterback availability moves a price only for a sourced primary-QB absence, through the engine\'s trained coefficient; no return dates or new injuries are simulated. Ratings are frozen at the as-of date.',
  'Conference tiebreaker steps that name an external ranking (SportSource Analytics, computer composites, CFP rankings) are resolved by an Estimated surrogate (the run\'s latent strength), and counted per conference.',
  'CFP selection and seeding come from an Estimated committee proxy (a Plackett-Luce model of the committee\'s final rankings 2014-2025, validated chronologically); a simulated record never decides the ranking by itself. Once the bracket is announced, the observed bracket replaces it.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy or committee uncertainty.'
];


/** MLB: the engine, rules, rotation model, studies and tests are complete; what remains is the human
    verification of the 2026 facts MLB's own pages hold, and one check of the live feed */
function mlbStatus(): { status: SportStatus; blockers: string[] } {
  const c = MLB_2026;
  return factStatus([['2026 divisional alignment', c.alignment], ['2026 postseason format', c.format], ['2026 tiebreaker procedure', c.tiebreakers],
    ['2026 World Series home-field rule', c.world_series_home], ['2026 extra-inning rules (regular season vs postseason)', c.extra_innings], ['The live 2026 inputs (MLB Stats API)', c.live_inputs]], 'MLB\'s official source');
}
const MLB_LIMITS = [
  'Strength uncertainty: one persistent offset per club (sigma calibrated on 2012-2023 frozen forecasts so the spread of simulated remaining wins matches history) and one per named starting pitcher (from within-pitcher residual covariance); the 2025 holdout is reported beside each.',
  'Game outcomes come from the served MLB lab brain (team offence and run prevention, starting pitcher, park; negative binomial runs; the served recalibration of each game\'s price). Its moneyline is PROVISIONAL: it does not beat Elo in the walk-forward record, and over 494 postseason games (2012-2025) it scored no better than a coin.',
  'Starting pitchers are Confirmed only where announced; every other start is Projected from the club\'s rotation (rest, doubleheaders and every postseason round on one calendar), with departures and spot starts measured on 2018-2023 rotations. The next start was named correctly 63% of the time in 2018-2023, a postseason start 52% of the time: never one certain name.',
  'Bullpen usage and fatigue are NOT modelled: no owned data records relief usage; relief innings are inside each club\'s run-prevention rating.',
  'No lineups, platoon splits, weather or injuries (beyond rotation departures) enter a game. Ratings are frozen at the as-of date; within-season drift is OFF.',
  'Extra innings are never played out: a level regulation draw resolves at the home win rate measured under the rule in force (automatic runner in the regular season; the standard rule, a home win rate near 52%, in the postseason).',
  'Postseason dates the schedule does not carry yet are Estimated from the 2025 calendar; short-rest postseason starts (4% in history) are rarer in the simulation.',
  'Tie-breaking: MLB\'s published tiebreaker procedure was not found, so it is measured instead of verified: the 2026 final standings hold no equal record at any place a tiebreaker decides, and a run in which a tie decided a reported place is never published.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** NBA: rules, inputs, studies and tests are complete, and the 2026-27 facts are VERIFIED from the league's text
    (2026-10-23). The 30 NBA Cup-dependent games the league schedules after Group Play are simulated from the Cup's
    published format until they are on the schedule (cup.ts; the unpublished parts Estimated and labelled) */
function nbaStatus(): { status: SportStatus; blockers: string[] } {
  const c = NBA_2026_27;
  return factStatus([['2026-27 tiebreaker procedure', c.tiebreakers], ['2026-27 definition of playoff teams for the tiebreaker', c.playoff_clubs_for_tiebreakers], ['2026-27 play-in format', c.play_in],
    ['2026-27 playoff format', c.playoff_format], ['2026-27 home-court rules', c.home_court], ['2026-27 NBA Cup standings rules', c.nba_cup], ['2026-27 NBA Cup format', c.nba_cup_format]], 'the NBA\'s official source');
}

/** NCAAM: the bracket engine, model and tests are complete; publication waits
    for the official 2027 field and a verified 2027 format */
function ncaamStatus(): { status: SportStatus; blockers: string[] } {
  const facts: Array<[string, Fact]> = [['2027 NCAA tournament format (field size, play-in games, regions)', NCAAM_2027.format], ['2027 official bracket (Selection Sunday)', NCAAM_2027.official_bracket]];
  const blockers = facts.filter(([, f]) => f.affects_results && !isVerified(f)).map(([label, f]) => label + ' not verified: ' + f.verify_by);
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}
const NCAAM_LIMITS = [
  'Team strength: opponent-adjusted efficiency and tempo from box scores (2010-present), refitted daily; a team\'s latent strength is drawn once per simulated tournament and kept through every round.',
  'Player availability is not modelled: no owned college-basketball injury or lineup feed exists. A star\'s absence announced before tip is not in the number.',
  'Every NCAA tournament game is treated as a neutral site; travel distance and crowd proximity are not modelled.',
  'Before Selection Sunday no national-title forecast is shown: no selection or seeding proxy is owned, and a guessed field is not presented as the official one.',
  'Conference tournaments are not simulated until a verified format for each conference exists in the repository.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** NCAAW: the pregame forecasts are a separate product (basketball/ncaaw_forecast, published once
    NCAAW_FC_PUBLISH is on); what is BLOCKED is the tournament simulation, which is not built */
const NCAAW_BLOCKERS = [
  'Tournament simulation not built for the women\'s format: the first two rounds are played on the top 16 seeds\' campuses (home games, not neutral), and the slot engine treats every game as neutral',
  '2027 NCAA women\'s tournament format and official bracket not verified (Selection Sunday 2027)'
];
const NCAAW_LIMITS = [
  'Team strength: opponent-adjusted efficiency and tempo from women\'s box scores (2017-present; earlier seasons\' box scores are too sparse), refitted daily.',
  'Player availability is not modelled: no owned women\'s college-basketball injury or lineup feed exists. A star\'s absence announced before tip is not in the number.',
  'No market comparison: no women\'s college basketball price is captured.',
  'In-game (live) forecasts are not built for the women\'s game.'
];

const NFL_LIMITS = [
  'Strength uncertainty: one persistent normal offset per club (sigma calibrated on 2006-2024 frozen forecasts so the spread of simulated remaining wins matches history); the 2025 holdout season was more volatile than that calibration.',
  'Game outcomes come from the served edgedesk_nfl_v2 margin distribution, including its own tie mass. The model does not beat the closing line in its walk-forward record.',
  'No injury return is sampled: future games use the board\'s starter treatment (the club\'s carried quarterback level beyond the current week). No new injuries are simulated.',
  'Ratings are frozen at the as-of date: simulated results do not update ratings. Within-season drift is OFF.',
  'Points-ranking tiebreakers use Estimated scores from the linemaker team-points model, conditioned on the simulated margin. Net-touchdown tiebreakers have no model input: a run that reaches one is resolved by the seeded coin toss and counted.',
  'Postseason rest is an Estimated input from the format; a postseason draw of the model\'s tie mass is resolved 50/50.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

const NHL_LIMITS = [
  'Game outcomes come from the served edgedesk_nhl_v1 (xg_core) distribution: regulation win, overtime win or shootout win for each side. Its 60-minute tie is under-priced (about 1-2 percentage points out of sample), so simulated loser points run slightly low; independent Poisson would be far worse (about 6 points).',
  'Strength uncertainty: one persistent normal offset per club on the goal rate (sigma calibrated on 2013-14 .. 2024-25 frozen forecasts so the spread of simulated remaining points matches history); the 2025-26 holdout season was more volatile than that calibration.',
  'Goalies: no starter is assumed for any future game; each club\'s goaltending is its recent team record. Confirmed starters with a recorded source are used for the game they start; projections are not. No injuries, returns or new absences are simulated for goalies or skaters.',
  'Overtime: regular-season 3-on-3 then shootout with the OT/shootout split fitted on earlier seasons; playoff overtime is sudden death in proportion to the two scoring rates (no fatigue or multi-overtime dynamics).',
  'Ratings are frozen at the as-of date: simulated results do not update ratings. Within-season drift is OFF.',
  'Tie-breaking beyond goals for is a seeded coin toss (counted); a three-or-more club tie at the head-to-head step continues without a restart.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

const NBA_LIMITS = [
  'Game outcomes come from the served NBA model (the projected-track ridge, edgedesk_nba_v1:E_ridge_P), priced from the states frozen at the as-of time, including its early-season shrinkage; it has never been tested against a closing market.',
  'Strength uncertainty: one persistent normal offset per club, calibrated on 2009-10..2023-24 so the spread of simulated remaining wins matches frozen historical forecasts; the 2024-25 and 2025-26 holdout seasons were markedly more volatile than that calibration, so season-level numbers are likely too confident.',
  'Availability: the projected rotation is who played in the club\'s latest game; a rotation player missing since an earlier game returns at a game drawn from empirical return hazards (Estimated, reason for the absence unknown). No new absences are simulated; roster moves after the as-of time are not.',
  'Rest, back-to-backs and travel come from the schedule for every regular-season game; a postseason game not yet scheduled carries the median rest of its round and game number (Estimated). The model\'s own learned postseason term applies; no playoff rotation change is assumed.',
  'Ratings are frozen at the as-of time: simulated results do not update them. Within-season drift is OFF.',
  'NBA Cup: Group Play, the knockout field and its hosts follow the league\'s rules (reproduced on every Cup 2023-24..2025-26). Until the league schedules them, the 30 regular-season games the Cup decides are simulated: the non-advancing clubs\' pairings by an Estimated stand-in for the league\'s unpublished formula (cross-conference pairs and every within-conference pairing type reproduced on 2023-24..2025-26, the exact within-conference pairs drawn at random), Estimated dates and rest. A simulated Group Play game\'s overtime and regulation points (the Cup\'s differential and points tiebreakers) are drawn from the served model given its margin.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** WNBA: the series formats and hosts are measured from the schedule in every run (schedule.series), not standing facts */
function wnbaStatus(): { status: SportStatus; blockers: string[] } {
  return factStatus([['2026 playoff series format', WNBA_2026.series_format], ['2026 playoff hosts', WNBA_2026.home_court]], 'the WNBA\'s official source');
}
const WNBA_LIMITS = [
  'Game outcomes come from the served WNBA model (points ratings and the season calibration fitted on the three seasons before it: the price on the basketball board). Its moneyline is PROVISIONAL: it has never been compared with closing prices.',
  'A series\' games move together through one shared offset per simulated series (tau about 2.7 points of margin, measured from late-season residuals 2010-2024 and checked on playoff series); it is carved out of the served distribution, so each game keeps the board\'s price on average. The 2025 holdout season was more volatile than the estimate.',
  'The ratings are frozen at the last final: a simulated game does not update them. The served model has no player input: an injury, a suspension or a return after the as-of time is not in any number.',
  'Series formats and hosts are read from the schedule (every remaining game, "if necessary" ones included), not from a rulebook; a series whose clubs are not yet known is never invented.',
  'A game\'s chance "if played" differs from the board\'s price: a game 6 or 7 is played only in some series paths, and those paths say something about the two clubs.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** UFC: active while the model loop serves its Elo and the four feeds the run reads are in the repository; every
    fact a result depends on is read in each run and gated (simulator/src/sports/ufc/run.ts), and the matchmaking
    rule is Estimated and labelled, not a fact to verify */
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function ufcStatus(): { status: SportStatus; blockers: string[] } {
  const blockers: string[] = [];
  try {
    const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'model-loop', 'ufc', 'versions.json'), 'utf8'));
    const cur = (v.versions || []).find((x: { version: string }) => x.version === v.current);
    if (!cur || !/^SERVED/.test(String(cur.status))) blockers.push('The model loop serves no UFC Elo (docs/model-loop/ufc/versions.json).');
  } catch (_) { blockers.push('docs/model-loop/ufc/versions.json is missing.'); }
  const f = UFC_2026.feeds;
  for (const [label, rel] of [['the ESPN schedule', f.bouts], ['the ufc.com rankings', f.rankings], ['the saved rankings page', f.rankings_html], ['Wikipedia\'s title history', f.title_history]]) {
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) blockers.push('Feed missing: ' + label + ' (' + rel + '); run the Simulator sports-data job (fetch_sports_data.ts --what ufc).');
  }
  const facts = factStatus([['UFC champions and rankings', UFC_2026.champions], ['UFC title-fight rate', UFC_2026.title_rate], ['UFC matchmaking rule', UFC_2026.matchmaking]], 'its source');
  return { status: blockers.length || facts.blockers.length ? 'BLOCKED' : 'ACTIVE', blockers: blockers.concat(facts.blockers) };
}
const UFC_LIMITS = [
  'Who wins comes from the served UFC Elo (the model loop\'s EXPERIMENTAL version; since 2026-10-24 the 1.1.0 Elo with a starting rating from each fighter\'s pre-UFC record and an age curve, each kept only because it improved 2021-2023 log loss, and promoted because it beat 1.1.0 on every bout from 2024 on): every booked bout keeps its published price exactly. It still trails the market by a wide margin: against a public archive of pre-fight closing lines (untimestamped), log loss since 2018 is about 0.65 for the model and 0.60 for the closing line on the same bouts (1.1.0: 0.67). Model Health shows both, with a calibration chart.',
  'Each booked bout shows the market\'s latest price without its margin (DraftKings via ESPN, captured hourly) beside the model\'s. A gap over the guard\'s threshold (8 points, docs/model-loop/ufc/guard.json) is labelled "Model disagrees with market", with what the model likely misreads (a short UFC sample, a long layoff, age, a weight change, a rematch), and no fair odds: gaps that size have not been shown to beat the closing line (out of sample the result sided with the market about two times in three), so a disagreement is never presented as an edge.',
  'Finish or decision, and the round of a finish, are measured from every UFC bout since 2014: the division, the scheduled rounds and each fighter\'s own finish record, shrunk toward the division. The data carry no method, so KO/TKO and submission are not told apart. Draws and no contests (under 2% of bouts) are not simulated: every simulated fight has a winner.',
  'Title Path numbers are Estimated. Title fights not yet booked come at each division\'s measured rate (undisputed title fights over the last five years, from Wikipedia\'s title history), never on a card already announced. The challenger is the highest-ranked contender coming off a win and rested at least the measured minimum: EdgeDesk\'s rule, not the UFC\'s, which books title fights at its discretion.',
  'Rankings move only through booked bouts (a winner takes a higher-ranked loser\'s place); bouts not yet on the schedule are not simulated. Interim titles, vacated or stripped titles, retirements, injuries and withdrawals are not modelled; a contender booked in another division is treated as having moved there.',
  'Title fights are priced by the served Elo without a champion term: champions beat its expectations from 2014 to 2020 but have matched them since 2021 (Model Health shows both periods); the model loop tests a champion term every week and adopts it only if it clears the preregistered rule.',
  'Ratings are frozen at the last result: a simulated win does not raise a rating (the served layoff rule and age curve still apply at a fight\'s date; head to head is not carried into a simulated rematch).',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** Golf: ACTIVE only while the committed skill study and backtest exist and the backtest's activation conditions
    hold on its holdout seasons (simulator/src/sports/golf/activation.ts); every format fact is measured per event (run.ts) */
const GOLF_LIMITS = [
  'Player skill: strokes per round against the field in the same round (so the course and the weather cancel), from every PGA Tour, LPGA and DP World Tour round since 2023, weighted toward recent rounds and shrunk toward a measured prior. The PGA Tour and the DP World Tour are fitted on one scale (their shared players link them; it predicted both tours better).',
  'A player with few or no rounds in that history (a Monday qualifier, an amateur, a LIV Golf or Korn Ferry Tour regular) is set near the measured newcomer level, which is well below the average tour player: a strong player from outside these three tours is underrated.',
  'Each player\'s week is drawn once per simulated tournament (what is wrong with his skill estimate and what is different this week), sized from how much one player\'s rounds in the same event move together (2024-2026); rounds already played update it, by exactly as much as those measurements say.',
  'Not modelled: course fit and course history, the weather and the morning or afternoon tee-time wave (only its average effect on the first two rounds is inside the per-player draw), injuries and news, and withdrawals after the leaderboard was read.',
  'The cut is measured, never assumed: Observed once made; otherwise read from the event\'s previous editions and the tour\'s 2023-2026 cuts (top 65 and ties on all three tours); an event whose rule cannot be read is not simulated, and an interval the editions cannot narrow is labelled Estimated.',
  'A tie for the lead goes to a sudden-death playoff decided hole by hole from the players\' skills: an approximation (the feed holds no hole-by-hole history; aggregate playoffs are treated as sudden death). Top 5, 10 and 20 break ties at random, which equals a dead-heat settlement on average.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** Tennis: ACTIVE only while the committed study and backtest meet the activation conditions on their holdout
    (simulator/src/sports/tennis/activation.ts); a draw's order is checked per run (run.ts) */
const CBASE_LIMITS = [
  'No 2027 schedule exists yet: the season is the measured move of each team\'s rating from the preseason to Selection Monday, not a game-by-game simulation. Once 2027 games are in the warehouse the view starts from the served model\'s current ratings.',
  'The selection committee is a proxy fitted on 2014-2026 fields: one automatic bid per conference (its winner drawn by strength), the at-large bids and the 16 hosts by rating plus a measured noise. Geography, which moves real 2-4 seeds between regionals, is not modelled.',
  'From the preseason the field chance runs slightly hot near the bubble (teams given 40-60% made it about 40% of the time in the backtest).',
  'The title call beats chance on average over eleven tournaments, but eleven are too few to prove it; once Omaha starts the model is no better than a coin among the eight.',
  'Roster turnover, the transfer portal, the draft and 2027 conference moves are not known to the model; 2026 memberships are used.',
  'Every number here passes through the committee proxy, so it is Estimated; there is no market to compare it with.'
];
const TENNIS_LIMITS = [
  'Who wins a match comes from a rating of every ATP and WTA singles match ESPN lists since 2022 (main draws and qualifying): an Elo per tour that moves by the share of games won, its settings chosen on 2023-2024. On 2025-2026 matches its log loss was about 9% below a coin\'s and below FiveThirtyEight\'s published tennis Elo; it has never been compared with closing prices.',
  'The court surface is not in the data, so one rating covers clay, grass and hard courts: a clay or grass specialist is misjudged on the other surfaces. Injuries, fitness and withdrawals after the scoreboard was read are not modelled; a match in progress is priced from before its first ball, not from its score.',
  'A draw is simulated only when its order is known: Wikipedia\'s draw article, confirmed line by line against ESPN\'s players and results, or from the semifinals on ESPN\'s own listing. Draws whose article is not filled in yet are listed with that reason and not simulated; their matches still appear under Matches.',
  'Ratings are frozen when the scoreboard is read: a simulated win does not raise a rating. A men\'s Grand Slam main-draw match is priced as best of five (through the set; it predicted those matches better); the score of a match (sets and games) is not simulated.',
  'The ATP and WTA Finals group stages (round robin) are not simulated.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

export function sportRegistry(): SportEntry[] {
  const nfl = nflStatus(), nhl = nhlStatus(), cfb = cfbStatus();
  const mlb = mlbStatus();
  const nba = nbaStatus();
  const ncaam = ncaamStatus();
  const wnba = wnbaStatus();
  const golf = golfActivation();
  const tennis = tennisActivation();
  const cbase = cbaseActivation();
  const ufc = ufcStatus();
  return [
    { key: 'nfl', label: 'NFL', status: nfl.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'], blockers: nfl.blockers, limitations: NFL_LIMITS,
      activation_path: 'Verify the three 2026 facts in simulator/src/sports/nfl/config.ts against the NFL\'s official pages, set verification VERIFIED with verified_by/verified_at in a reviewed commit, apply supabase/simulator.sql.' },
    { key: 'cfb', label: 'College Football', status: cfb.status, structure: 'season', tabs: ['conference', 'title', 'futures'],
      blockers: cfb.blockers, limitations: CFB_LIMITS,
      activation_path: 'Active: every conference procedure, the 2026 CFP format and North Dakota State\'s eligibility are VERIFIED from the governing bodies\' own text (simulator/src/sports/cfb/config.ts); Sacramento State\'s MAC eligibility is measured in every run and holds publication if any run depended on it. A new season, or a changed procedure, means re-reading the sources (Simulator CFB source check) and re-verifying in a reviewed commit. CFB_SIMULATOR_NOTES.md §4, §16.' },
    { key: 'nba', label: 'NBA', status: nba.status, structure: 'season', tabs: ['division', 'conference', 'title', 'cup', 'futures'], blockers: nba.blockers, limitations: NBA_LIMITS,
      activation_path: 'Active: the 2026-27 facts in simulator/src/sports/nba/config.ts are VERIFIED from the league\'s own text (2026-10-23), and the NBA Cup-dependent games are simulated from the Cup\'s format until the league schedules them (each one it schedules replaces its simulated stand-in). Each season: re-run the Simulator source check, re-verify the facts, and update the Cup format (config.ts cup) in a reviewed commit.' },
    { key: 'nhl', label: 'NHL', status: nhl.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'],
      blockers: nhl.blockers, limitations: NHL_LIMITS,
      activation_path: 'Each season: re-run the Simulator source check, compare the NHL.com tie-breaking and playoff-format pages with NHL_SIMULATOR_NOTES.md, and re-verify the three facts in simulator/src/sports/nhl/config.ts in a reviewed commit.' },
    { key: 'mlb', label: 'MLB', status: mlb.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'], blockers: mlb.blockers, limitations: MLB_LIMITS,
      activation_path: 'Each season: re-run the Simulator source check (job fetch (mlb): MLB\'s standings, postseason schedule, rulebook and explainers) and a dispatched MLB dry run, re-verify the facts in simulator/src/sports/mlb/config.ts in a reviewed commit, and set the season\'s nightly window (nightly_through). MLB_SIMULATOR_NOTES.md §15.' },
    { key: 'ncaam', label: 'Men\'s College Basketball', status: ncaam.status, structure: 'tournament', tabs: ['games', 'upset_watch', 'tournament', 'model_health'], blockers: ncaam.blockers, limitations: NCAAM_LIMITS,
      activation_path: 'After Selection Sunday 2027: write basketball/ncaam_forecast/config/brackets/2027.json from the official bracket and record the 2027 format and bracket as VERIFIED with verified_by/verified_at in simulator/src/sports/ncaam/config.ts. Already in place: supabase/simulator.sql and supabase/ncaam_forecast.sql are applied in production (2026-10-24), and the champion is a research_team_model (ncaam_adjeff@1.0.0, promoted by the weekly gates on 2026-10-23). The pregame forecasts in the Games and Upset Watch tabs do not wait on the tournament: basketball/ncaam_forecast publishes them once NCAAM_FC_PUBLISH is on.',
      games: { regular_season_start: CBB_2027_OPENING_DAY } },
    { key: 'ncaaw', label: 'Women\'s College Basketball', status: 'BLOCKED', structure: 'tournament', tabs: ['games', 'upset_watch', 'tournament', 'model_health'], blockers: NCAAW_BLOCKERS, limitations: NCAAW_LIMITS,
      activation_path: 'Build a host-site-aware women\'s bracket (the first two rounds at the top 16 seeds\' campuses), verify the 2027 format and bracket after Selection Sunday 2027 with verified_by/verified_at, and register a women\'s tournament simulation before any publication. The pregame forecasts in the Games and Upset Watch tabs do not wait on this: basketball/ncaaw_forecast publishes them once NCAAW_FC_PUBLISH is on.',
      games: { regular_season_start: CBB_2027_OPENING_DAY } },
    { key: 'wnba', label: 'WNBA', status: wnba.status, structure: 'series', tabs: ['title', 'games', 'model_health'], blockers: wnba.blockers, limitations: WNBA_LIMITS,
      activation_path: 'Active for the 2026 postseason: the series formats and hosts are measured from the schedule (simulator/src/sports/wnba/config.ts), the game model is the served basketball walk-forward and the shared series offset comes from simulator/data/wnba_strength_uncertainty.json. For 2027: a configuration with the season\'s playoff bracket rule (pairings of rounds not yet played), re-run the uncertainty study, set nightly_through. WNBA_SIMULATOR_NOTES.md.' },
    { key: 'tennis', label: 'Tennis', status: tennis.status, structure: 'events', tabs: ['draws', 'matches', 'model_health'], blockers: tennis.blockers, limitations: TENNIS_LIMITS,
      activation_path: 'Active while the committed study and backtest (simulator/data/tennis_elo_study.json, tennis_backtest.json: walk-forward over 2025-2026) meet the activation conditions in simulator/src/sports/tennis/activation.ts. A draw is simulated only when its order is known (a Wikipedia draw article confirmed against ESPN, or the semifinals on). Each season: let the feeds refresh, re-run the study and the backtest, and set the new season and nightly_through in simulator/src/sports/tennis/config.ts. Tennis is in the Simulator only; EdgeDesk Research still has it retired (lib/edgedesk_sports.js). TENNIS_SIMULATOR_NOTES.md.' },
    { key: 'golf', label: 'Golf', status: golf.status, structure: 'events', tabs: ['leaderboard', 'finishes', 'model_health'], blockers: golf.blockers, limitations: GOLF_LIMITS,
      activation_path: 'Active while the committed backtest (simulator/data/golf_backtest.json, walk-forward over 2025-2026) meets its activation conditions; each event\'s cut, rounds and field are measured per run. Each season: let the feeds refresh, re-run the skill study and the backtest, and set the new season and nightly_through in simulator/src/sports/golf/config.ts. GOLF_SIMULATOR_NOTES.md.' },
    { key: 'ufc', label: 'UFC', status: ufc.status, structure: 'events', tabs: ['fights', 'title_path', 'model_health'], blockers: ufc.blockers, limitations: UFC_LIMITS,
      activation_path: 'Active: every booked bout from the served UFC Elo (model_loop/adapters/ufc, reproduced in every run by simulator/src/sports/ufc/elo.ts), champions and rankings from ufc.com, the schedule from ESPN and the title history from Wikipedia, refreshed by the Simulator sports-data job (fetch_sports_data.ts --what ufc). UFC_SIMULATOR_NOTES.md.' },
    { key: 'college_baseball', label: 'College Baseball', status: cbase.status, structure: 'tournament', tabs: ['tournament', 'conference', 'model_health'], blockers: cbase.blockers, limitations: CBASE_LIMITS,
      activation_path: 'Active while the committed backtests (simulator/data/college_baseball_backtest.json: every NCAA tournament 2014-2026 the warehouse holds whole; simulator/data/college_baseball_road.json: the season walk-forward from 2016) meet the activation conditions in simulator/src/sports/college_baseball/activation.ts. The Road to Omaha runs nightly from the committed warehouse until the night before Selection Monday; the tournament itself, from the bracket the committee names, is not yet a published view. Each season: re-run both backtests and set the new season in simulator/src/sports/college_baseball/config.ts. The betting board\'s release gates (G11, G12, G15) are separate and still fail. COLLEGE_BASEBALL_SIMULATOR_NOTES.md.' }
  ];
}
