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
import { MLB_2026 } from './mlb/config.ts';

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
type Fact = { verification: string; affects_results: boolean; verify_by: string; verified_by: string | null; verified_at: string | null };
/** a fact counts as verified only with VERIFIED, a named verifier and a date */
export const isVerified = (f: Fact) => f.verification === 'VERIFIED' && !!f.verified_by && !!f.verified_by.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.verified_at || '');
export function factStatus(facts: Array<[string, Fact]>, source = 'the NFL\'s official source'): { status: SportStatus; blockers: string[] } {
  const blockers = facts.filter(([, f]) => f.affects_results && !isVerified(f))
    .map(([label, f]) => label + ' not verified against ' + source + ': ' + f.verify_by);
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}

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

const NFL_LIMITS = [
  'Strength uncertainty: one persistent normal offset per club (sigma calibrated on 2006-2024 frozen forecasts so the spread of simulated remaining wins matches history); the 2025 holdout season was more volatile than that calibration.',
  'Game outcomes come from the served edgedesk_nfl_v2 margin distribution, including its own tie mass. The model does not beat the closing line in its walk-forward record.',
  'No injury return is sampled: future games use the board\'s starter treatment (the club\'s carried quarterback level beyond the current week). No new injuries are simulated.',
  'Ratings are frozen at the as-of date: simulated results do not update ratings. Within-season drift is OFF.',
  'Points-ranking tiebreakers use Estimated scores from the linemaker team-points model, conditioned on the simulated margin. Net-touchdown tiebreakers have no model input: a run that reaches one is resolved by the seeded coin toss and counted.',
  'Postseason rest and the Super Bowl venue are Estimated inputs from the format; a postseason draw of the model\'s tie mass is resolved 50/50.',
  'Monte Carlo sampling error (shown as +/-) measures simulation noise only, never model accuracy.'
];

export function sportRegistry(): SportEntry[] {
  const nfl = nflStatus();
  const mlb = mlbStatus();
  return [
    { key: 'nfl', label: 'NFL', status: nfl.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'], blockers: nfl.blockers, limitations: NFL_LIMITS,
      activation_path: 'Verify the three 2026 facts in simulator/src/sports/nfl/config.ts against the NFL\'s official pages, set verification VERIFIED with verified_by/verified_at in a reviewed commit, apply supabase/simulator.sql.' },
    { key: 'cfb', label: 'College Football', status: 'BLOCKED', structure: 'season', tabs: ['conference', 'title', 'futures'],
      blockers: ['No conference title-game qualification rules or tiebreakers for 2026 in the repository (9 FBS conferences, each with its own).', 'No 2026 CFP format, seeding or selection data, and no committee-ranking proxy inputs (no CFP/AP rankings are committed).', 'No neutral-site flags for the remaining 2026 schedule and no committed full schedule (football/fbs/.cache is gitignored).'],
      limitations: ['The production game model (football/cfb_p4 engine) can price any rated FBS pairing offline; everything else above is missing.'],
      activation_path: 'Commit a versioned 2026 conference-rules table with sources, a CFP bracket config, an explicitly Estimated committee proxy, and the full schedule with neutral flags.' },
    { key: 'nba', label: 'NBA', status: 'BLOCKED', structure: 'season', tabs: ['conference', 'title', 'futures'],
      blockers: ['No 2026-27 conference/division table in the repository.', '30 regular-season games (2 per club) depend on NBA Cup results and are not yet scheduled.', 'No standings, tiebreaker, play-in or series code; no strength-uncertainty study.', 'The chosen model (E_ridge_P) needs the network-built .cache/nba_work tables to price offline.'],
      limitations: ['The roster/injury layer has statuses but no return dates.'],
      activation_path: 'Conference/division table, NBA tiebreakers + play-in + series state machine, a full schedule after the Cup group stage, an uncertainty study.' },
    { key: 'nhl', label: 'NHL', status: 'BLOCKED', structure: 'season', tabs: ['division', 'conference', 'title', 'futures'],
      blockers: ['No committed full 2026-27 schedule (hockey/build_slate.js downloads it into a gitignored cache).', 'No conference/division table.', 'No standings (regulation wins, points), wild card or series code; no strength-uncertainty study.'],
      limitations: ['The game model prices regulation/OT/shootout outcomes offline; the 60-minute draw is under-priced (PROVISIONAL).'],
      activation_path: 'Commit the schedule and alignment, implement NHL points/tiebreakers and the bracket, run an uncertainty study.' },
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
