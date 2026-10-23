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

export type SportStatus = 'ACTIVE' | 'BLOCKED' | 'COMING_SOON';
export interface SportEntry {
  key: string;
  label: string;
  status: SportStatus;
  structure: 'season' | 'tournament' | 'series' | 'none';
  tabs: Array<'division' | 'conference' | 'title' | 'futures' | 'tournament'>;
  blockers: string[];
  limitations: string[];
  /** what would have to exist for this sport to be activated */
  activation_path: string;
}

/** NFL: the engine, config and tests are complete; the remaining blocker is
    the human verification of the 2026 facts the official sites hold. */
function nflStatus(): { status: SportStatus; blockers: string[] } {
  return factStatus([['2026 tiebreaking procedures', NFL_2026.rules], ['2026 playoff format', NFL_2026.playoff_format], ['Super Bowl LXI venue and designated home team', NFL_2026.super_bowl]]);
}
/** NHL: engine, rules, studies and tests are complete; the 2026-27 rules facts await
    human verification against the NHL's own pages, and the reader has no NHL view */
function nhlStatus(): { status: SportStatus; blockers: string[] } {
  const f = factStatus([['2026-27 tie-breaking procedure', NHL_2027.rules], ['2026-27 playoff format', NHL_2027.playoff_format], ['2026-27 playoff home-ice rule', NHL_2027.home_ice]], 'the NHL\'s official source');
  const blockers = f.blockers.concat(['The reader (lib/edgedesk_simulator.js) renders the NFL outcome set only (seeds 1-7, Super Bowl); an NHL view (D1-D3, wild cards, Presidents\' Trophy, Stanley Cup) must exist before NHL numbers can be shown.']);
  return { status: 'BLOCKED', blockers };
}
type Fact = { verification: string; affects_results: boolean; verify_by: string; verified_by: string | null; verified_at: string | null };
/** a fact counts as verified only with VERIFIED, a named verifier and a date */
export const isVerified = (f: Fact) => f.verification === 'VERIFIED' && !!f.verified_by && !!f.verified_by.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.verified_at || '');
export function factStatus(facts: Array<[string, Fact]>, source = 'the NFL\'s official source'): { status: SportStatus; blockers: string[] } {
  const blockers = facts.filter(([, f]) => f.affects_results && !isVerified(f))
    .map(([label, f]) => label + ' not verified against ' + source + ': ' + f.verify_by);
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}

/** CFB: the engine, rules, committee proxy and tests are complete; publication waits on the facts
    whose governing text could not be read or does not yet exist for 2026 (config.ts). */
function cfbStatus(): { status: SportStatus; blockers: string[] } {
  const blockers = cfbFacts().filter(([, f]) => f.affects_results && !isCfbVerified(f))
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
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

/** NBA: rules, inputs, study and tests are complete; the 2026-27 facts await verification, and the
    season cannot be simulated for publication until the NBA Cup-dependent games are on the schedule */
function nbaStatus(): { status: SportStatus; blockers: string[] } {
  const c = NBA_2026_27;
  const f = factStatus([['2026-27 tiebreaker procedure', c.tiebreakers], ['2026-27 definition of playoff teams for the tiebreaker', c.playoff_clubs_for_tiebreakers], ['2026-27 play-in format', c.play_in],
    ['2026-27 playoff format', c.playoff_format], ['2026-27 home-court rules', c.home_court], ['2026-27 NBA Cup standings rules', c.nba_cup]], 'the NBA\'s official source');
  const blockers = f.blockers.concat(['The 30 regular-season games that depend on the NBA Cup group stage (two per club) are not on the schedule yet; until they are, the schedule.complete gate refuses the season (expected after the group stage, early December 2026).']);
  return { status: 'BLOCKED', blockers };
}

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
  'Strength uncertainty: one persistent normal offset per club, calibrated so the spread of simulated remaining wins matches frozen historical forecasts.',
  'Availability: the projected rotation is who played in the club\'s latest game; a rotation player missing since an earlier game returns at a game drawn from empirical return hazards (Estimated, reason for the absence unknown). No new absences are simulated; roster moves after the as-of time are not.',
  'Rest, back-to-backs and travel come from the schedule for every regular-season game; a postseason game not yet scheduled carries the median rest of its round and game number (Estimated). The model\'s own learned postseason term applies; no playoff rotation change is assumed.',
  'Ratings are frozen at the as-of time: simulated results do not update them. Within-season drift is OFF.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

export function sportRegistry(): SportEntry[] {
  const nfl = nflStatus(), nhl = nhlStatus(), cfb = cfbStatus();
  const mlb = mlbStatus();
  const nba = nbaStatus();
  return [
    { key: 'nfl', label: 'NFL', status: nfl.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'], blockers: nfl.blockers, limitations: NFL_LIMITS,
      activation_path: 'Verify the three 2026 facts in simulator/src/sports/nfl/config.ts against the NFL\'s official pages, set verification VERIFIED with verified_by/verified_at in a reviewed commit, apply supabase/simulator.sql.' },
    { key: 'cfb', label: 'College Football', status: cfb.status, structure: 'season', tabs: ['conference', 'title', 'futures'],
      blockers: cfb.blockers, limitations: CFB_LIMITS,
      activation_path: 'Read each blocked conference\'s 2026 tiebreaker text (and the two eligibility statements) from the governing body, update simulator/src/sports/cfb/config.ts (VERIFIED with verified_by/verified_at, procedure fixed if it differs) in a reviewed commit, regenerate the reader registry, run 100,000 runs. CFB_SIMULATOR_NOTES.md §9.' },
    { key: 'nba', label: 'NBA', status: nba.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'], blockers: nba.blockers, limitations: NBA_LIMITS,
      activation_path: 'Verify the six 2026-27 facts in simulator/src/sports/nba/config.ts against the NBA\'s official pages (VERIFIED with verified_by/verified_at in a reviewed commit), wait for the NBA Cup-dependent games on the schedule, then a 100,000-run publication.' },
    { key: 'nhl', label: 'NHL', status: nhl.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'],
      blockers: nhl.blockers, limitations: NHL_LIMITS,
      activation_path: 'Verify the three 2026-27 facts in simulator/src/sports/nhl/config.ts against the NHL\'s official pages (VERIFIED with verified_by/verified_at in a reviewed commit), build the reader\'s NHL view, add the NHL (with a pyarrow step) to the nightly workflow plan, apply supabase/simulator.sql.' },
    { key: 'mlb', label: 'MLB', status: mlb.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'], blockers: mlb.blockers, limitations: MLB_LIMITS,
      activation_path: 'Build the live 2026 snapshot once on a runner that reaches statsapi.mlb.com and check it against MLB\'s standings; verify the 2026 facts in simulator/src/sports/mlb/config.ts against MLB\'s pages; set each VERIFIED with verified_by/verified_at in a reviewed commit; apply supabase/simulator.sql.' },
    { key: 'cbb', label: 'College Basketball', status: 'COMING_SOON', structure: 'tournament', tabs: ['conference', 'tournament', 'futures'],
      blockers: ['The 2026-27 season has not started; the schedule is partial with placeholder times.', 'No 2026-27 conference membership, conference-tournament formats, or NCAA selection/seed/bracket data.'],
      limitations: [], activation_path: 'Conference membership and tournament formats; a selection/seeding proxy labelled Estimated.' },
    { key: 'wnba', label: 'WNBA', status: 'BLOCKED', structure: 'series', tabs: ['title'],
      blockers: ['No series simulator or strength-uncertainty study; the 2026 Finals end by 2026-10-31.'],
      limitations: [], activation_path: 'A series state machine and an uncertainty study before the 2027 season.' },
    { key: 'tennis', label: 'Tennis', status: 'COMING_SOON', structure: 'tournament', tabs: ['tournament'],
      blockers: ['Retired from coverage (2026-09-27).', 'Fitted ratings live only in the database; no owned draw structure; no validated point-level serve/return model.'],
      limitations: [], activation_path: 'Draw data, a validated point-level model, and the coverage decision reversed.' },
    { key: 'golf', label: 'Golf', status: 'COMING_SOON', structure: 'tournament', tabs: ['tournament'],
      blockers: ['No golf model, field data, round-score distribution or cut rules exist in the repository.'],
      limitations: [], activation_path: 'A per-player round-score model with a shared round effect, fields and cut rules.' },
    { key: 'ufc', label: 'UFC', status: 'COMING_SOON', structure: 'none', tabs: [],
      blockers: ['UFC has no season or division championship structure to simulate.'],
      limitations: [], activation_path: 'None planned: no artificial season simulator.' },
    { key: 'college_baseball', label: 'College Baseball', status: 'COMING_SOON', structure: 'tournament', tabs: ['tournament'],
      blockers: ['Out of season until February 2027; no 2027 schedule; release gates G11, G12 and G15 fail.'],
      limitations: [], activation_path: 'The 2027 schedule and passing release gates.' }
  ];
}
