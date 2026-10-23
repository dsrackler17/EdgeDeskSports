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
import { NCAAM_2027 } from './ncaam/config.ts';

export type SportStatus = 'ACTIVE' | 'BLOCKED' | 'COMING_SOON';
export interface SportEntry {
  key: string;
  label: string;
  status: SportStatus;
  structure: 'season' | 'tournament' | 'series' | 'none';
  tabs: Array<'division' | 'conference' | 'title' | 'futures' | 'tournament' | 'games' | 'upset_watch' | 'model_health'>;
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
export function factStatus(facts: Array<[string, Fact]>): { status: SportStatus; blockers: string[] } {
  const blockers = facts.filter(([, f]) => f.affects_results && !isVerified(f))
    .map(([label, f]) => label + ' not verified against the NFL\'s official source: ' + f.verify_by);
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
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
  const ncaam = ncaamStatus();
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
    { key: 'mlb', label: 'MLB', status: 'COMING_SOON', structure: 'season', tabs: ['division', 'conference', 'title', 'futures'],
      blockers: ['The 2026 regular season is complete; only the World Series remains.', 'No 2026 ratings, results or starting pitchers are committed (the history model ends in 2025).', 'The live engine\'s inputs sit only in Supabase; the history model does not beat Elo.'],
      limitations: [], activation_path: 'A 2027 season with committed ratings, rotation inputs labelled Projected, and series formats.' },
    { key: 'ncaam', label: 'College Basketball', status: ncaam.status, structure: 'tournament', tabs: ['games', 'upset_watch', 'tournament', 'model_health'], blockers: ncaam.blockers, limitations: NCAAM_LIMITS,
      activation_path: 'After Selection Sunday 2027: write basketball/ncaam_forecast/config/brackets/2027.json from the official bracket, record the 2027 format and bracket as VERIFIED with verified_by/verified_at in simulator/src/sports/ncaam/config.ts, apply supabase/simulator.sql and supabase/ncaam_forecast.sql, and promote a research_team_model champion through the weekly gates.' },
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
