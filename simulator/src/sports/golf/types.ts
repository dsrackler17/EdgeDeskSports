/* ===========================================================================
   THE GOLF INPUT SNAPSHOT'S SHAPE — what one tournament simulation reads
   (inputs.ts builds it, module.ts simulates it, run.ts gates it). Kept apart
   so the module, the tests' synthetic fixtures and the builder share it.
   =========================================================================== */
import type { Tour, Status } from './model.ts';
import type { CutRule } from './rules.ts';

export interface GolfSkill {
  /** strokes per round relative to an average round on the tour (negative is better) */
  theta: number; var_post: number;
  /** the player's round-to-round sd, scaled to the tour's measured round noise */
  sd_round: number;
  n_eff: number; n_rounds: number;
  /** no round in the window: the prior (the measured newcomer mean) */
  on_prior: boolean;
}
export interface GolfPlayer {
  id: string; name: string; country: string | null;
  /** as the leaderboard shows it now (Observed): active, cut, wd, dq, mdf (made the cut, did not finish) */
  status: Status;
  position: string | null; score: string | null; sort_order: number | null; thru: number | null; tee_time: string | null;
  /** completed regulation rounds (Observed) */
  rounds: Array<{ r: number; strokes: number; par: number }>;
  /** the round being played: holes completed, strokes so far and the par of those holes (Observed) */
  partial: { r: number; holes: number; strokes: number; par_played: number } | null;
  skill: GolfSkill;
}
export interface RoundLevel {
  r: number;
  /** strokes to par of a 0-skill player in this round: estimated from the field (complete or in progress), or null (future) */
  level: number | null;
  state: 'complete' | 'partial' | 'future';
  /** players' holes behind the estimate, in rounds (a complete round = 1 per player) */
  weight: number;
}
export interface GolfInputData {
  sport: 'golf';
  tour: Tour; tour_label: string;
  /** the published competition key: <tour>-<ESPN event id> */
  competition: string;
  season: number;
  as_of: string;
  event: { id: string; name: string; course: string | null; par: number; start: string; end: string | null; status: string; period: number;
    n_rounds: number; rounds_source: string; rounds_provenance: 'Research' | 'Estimated' | 'Observed' };
  players: GolfPlayer[];
  cut: CutRule & { state: 'pending' | 'made' | 'none' | 'undetermined' };
  levels: RoundLevel[];
  /** a future round's level: mean and sd of the event's level (course and set-up), and the day-to-day sd around it */
  course: { level_mean: number; level_sd: number; day_sd: number; source: string };
  model: {
    model_version: string; fit_tours: Tour[]; params: Record<string, unknown>; as_of_day: number; rounds_used: number;
    prior_mean: number; prior_sd: number; sigma_in_sample: number;
    /** the per-tournament offsets' variances (c2 x var_post, W1, W2), the round noise of rounds 1-2 and of rounds 3-4, and the scale */
    tournament: { c2: number; W1: number; W2: number; sigma_eps: number; sigma_eps_weekend: number; scale: number };
    study_sha256: string; history_sha256: string; history_fetched_at: string;
  };
  /** the playoff approximation: sudden death, hole by hole, from each player's skill (Estimated) */
  playoff: { mode: 'sudden_death'; hole_level: number; max_holes: number; note: string };
  code: Record<string, string>;
  frequencies: { playoff_events: number; events: number; withdrawals_per_round: Array<{ round: number; rate: number }> };
  health: unknown;
}
export interface GolfSnapshot { schema: string; input_hash: string; data: GolfInputData; meta: { built_at: string; builder: string; source: unknown; feeds: Array<{ name: string; sha256: string }> } }
