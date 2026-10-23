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
  const f = factStatus([['2026-27 tie-breaking procedure', NHL_2027.rules], ['2026-27 playoff format', NHL_2027.playoff_format], ['2026-27 playoff home-ice rule', NHL_2027.home_ice]], 'NHL');
  const blockers = f.blockers.concat(['The reader (lib/edgedesk_simulator.js) renders the NFL outcome set only (seeds 1-7, Super Bowl); an NHL view (D1-D3, wild cards, Presidents\' Trophy, Stanley Cup) must exist before NHL numbers can be shown.']);
  return { status: 'BLOCKED', blockers };
}
type Fact = { verification: string; affects_results: boolean; verify_by: string; verified_by: string | null; verified_at: string | null };
/** a fact counts as verified only with VERIFIED, a named verifier and a date */
export const isVerified = (f: Fact) => f.verification === 'VERIFIED' && !!f.verified_by && !!f.verified_by.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.verified_at || '');
export function factStatus(facts: Array<[string, Fact]>, league = 'NFL'): { status: SportStatus; blockers: string[] } {
  const blockers = facts.filter(([, f]) => f.affects_results && !isVerified(f))
    .map(([label, f]) => label + ' not verified against the ' + league + '\'s official source: ' + f.verify_by);
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}

const NFL_LIMITS = [
  'Strength uncertainty: one persistent normal offset per club (sigma calibrated on 2006-2024 frozen forecasts so the spread of simulated remaining wins matches history); the 2025 holdout season was more volatile than that calibration.',
  'Game outcomes come from the served edgedesk_nfl_v2 margin distribution, including its own tie mass. The model does not beat the closing line in its walk-forward record.',
  'No injury return is sampled: future games use the board\'s starter treatment (the club\'s carried quarterback level beyond the current week). No new injuries are simulated.',
  'Ratings are frozen at the as-of date: simulated results do not update ratings. Within-season drift is OFF.',
  'Points-ranking tiebreakers use Estimated scores from the linemaker team-points model, conditioned on the simulated margin. Net-touchdown tiebreakers have no model input: a run that reaches one is resolved by the seeded coin toss and counted.',
  'Postseason rest and the Super Bowl venue are Estimated inputs from the format; a postseason draw of the model\'s tie mass is resolved 50/50.',
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

export function sportRegistry(): SportEntry[] {
  const nfl = nflStatus(), nhl = nhlStatus();
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
    { key: 'nhl', label: 'NHL', status: nhl.status, structure: 'season', tabs: ['division', 'conference', 'title', 'futures'],
      blockers: nhl.blockers, limitations: NHL_LIMITS,
      activation_path: 'Verify the three 2026-27 facts in simulator/src/sports/nhl/config.ts against the NHL\'s official pages (VERIFIED with verified_by/verified_at in a reviewed commit), build the reader\'s NHL view, add the NHL (with a pyarrow step) to the nightly workflow plan, apply supabase/simulator.sql.' },
    { key: 'mlb', label: 'MLB', status: 'COMING_SOON', structure: 'season', tabs: ['division', 'conference', 'title', 'futures'],
      blockers: ['The 2026 regular season is complete; only the World Series remains.', 'No 2026 ratings, results or starting pitchers are committed (the history model ends in 2025).', 'The live engine\'s inputs sit only in Supabase; the history model does not beat Elo.'],
      limitations: [], activation_path: 'A 2027 season with committed ratings, rotation inputs labelled Projected, and series formats.' },
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
