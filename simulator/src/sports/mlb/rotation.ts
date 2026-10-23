/* ===========================================================================
   STARTING PITCHERS: CONFIRMED WHERE ANNOUNCED, PROJECTED OTHERWISE.

   Nothing here claims to know an unannounced rotation. A starter is one of
     Observed    the actual starter of a completed game (game logs / box score)
     Confirmed   the announced probable starter of a scheduled game
     Projected   anything else: drawn, run by run, from the rotation model
                 below, whose accuracy is measured on 2012-2025 rotations
                 (simulator/data/mlb_rotation_study.json)

   THE ROTATION AT THE AS-OF DATE: the club's last five distinct starting
   pitchers, walking back from its most recent start (the study compares
   larger and frequency-based sets; this one projects best).

   REGULAR SEASON (one rule, every date, every doubleheader):
     a member is RESTED when at least `min_rest_days` calendar days (5: four
     days of rest) have passed since his last start. The next start goes to
     the rested member whose last start is the oldest (the rotation cycles;
     ties: the as-of order). No rested member: a replacement starts (an
     unnamed starter at s = 0, the club's average). So a doubleheader's
     second game, with the first game's starter at zero days of rest and the
     others between one and four, falls to a replacement unless an off day
     rested a member: the measured share of doubleheader second games started
     outside the rotation is 56%.
   POSTSEASON: the postseason rotation is the `postseason_rotation_size` (4)
     available members with the best starter effect s; each game goes to the
     best rested one; else, if a member has departed, to a replacement in
     his vacant slot; else to the most rested one on short rest (four
     calendar days; 4.0% of 2012-2025 postseason member starts), else a
     replacement.
   The rest clock runs on calendar dates through the regular season, the off
   days between rounds and every round, so a club that starts its ace in
   game 1 of a Division Series has him back only after four days of rest.

   UNCERTAINTY (persistent within a run, drawn on the rotation stream):
     departure   each member leaves the rotation (injury, demotion) after a
                 number of club games drawn from the measured survival curve;
                 his slot is then a replacement for the rest of the run,
                 postseason included
     spot start  each projected start goes, with the measured probability
                 (single games, game 1 and game 2 of a doubleheader and the
                 postseason each have their own), to a starter outside the
                 rotation (opener, bullpen game, call-up) at the measured
                 replacement level; whether it takes the turn of the member
                 the rule would have started is the study's choice, made
                 separately for the regular season (spot_takes_turn) and the
                 postseason (postseason_spot_takes_turn)
   A confirmed starter is used as announced, with no draw.
   =========================================================================== */
import type { Xoshiro128 } from '../../core/prng.ts';

export interface Start { day: number; game_no: number; pitcher: string }

/** the club's last `n` distinct starters, most recent first */
export function rotationAt(starts: Start[], n = 5): string[] {
  const out: string[] = [];
  for (let i = starts.length - 1; i >= 0 && out.length < n; i--) { const p = starts[i].pitcher; if (p && !out.includes(p)) out.push(p); }
  return out;
}
/** day of each pitcher's most recent start */
export function lastStarts(starts: Start[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const s of starts) if (s.pitcher) o[s.pitcher] = s.day;
  return o;
}

export type GameKind = 'single' | 'dh1' | 'dh2';
export interface RotationParams {
  min_rest_days: number;            // 5
  short_rest_days: number;          // 4 (postseason only)
  postseason_rotation_size: number; // 4
  /** probability that a projected start goes outside the rotation, by game kind (doubleheader games differ) and in the postseason */
  p_spot: { single: number; dh1: number; dh2: number; postseason: number };
  /** a regular-season spot start takes the turn of the member the rule would have started (his clock moves; the order is kept) */
  spot_takes_turn: boolean;
  /** the same for a postseason spot start (an opener or bullpen game in place of a starter) */
  postseason_spot_takes_turn: boolean;
  /** P(a member is still in the rotation for club game k after the as-of date), index k - 1; beyond the table: its last value */
  survival: number[];
}

export const REPLACEMENT = -1;

/** one club's rotation through one simulated run */
export class RotationState {
  readonly ids: string[];
  readonly s: Float64Array;
  readonly last: Float64Array;
  /** club games after the as-of date at which the slot's member leaves (Infinity: never) */
  readonly departAt: Float64Array;
  games = 0;
  constructor(ids: string[], s: number[], last: number[]) {
    this.ids = ids.slice(); this.s = Float64Array.from(s); this.last = Float64Array.from(last);
    this.departAt = new Float64Array(ids.length).fill(Infinity);
  }
  reset(last: ArrayLike<number>): void { for (let i = 0; i < this.ids.length; i++) { this.last[i] = last[i]; this.departAt[i] = Infinity; } this.games = 0; }
  present(i: number): boolean { return this.games < this.departAt[i]; }
  slotOf(id: string): number { return this.ids.indexOf(id); }
}

/** draw each member's departure from the survival curve (inverse CDF on one uniform per member) */
export function drawDepartures(st: RotationState, P: RotationParams, rng: Xoshiro128): void {
  /* S[j] = P(present for club game j+1). With departAt = the first j where S[j] <= u, the member
     is present for game m (m - 1 games played) iff m - 1 < departAt iff S[m-1] > u: probability S[m-1] */
  const S = P.survival;
  for (let i = 0; i < st.ids.length; i++) {
    const u = rng.nextDouble();
    let j = 0;
    while (j < S.length && S[j] > u) j++;
    st.departAt[i] = j >= S.length ? Infinity : j;
  }
}

/** the regular-season starter of the club's next game on `day`: a slot index, or REPLACEMENT */
export function pickRegular(st: RotationState, day: number, P: RotationParams): number {
  let best = REPLACEMENT, bestLast = Infinity;
  for (let i = 0; i < st.ids.length; i++) {
    if (!st.present(i)) continue;
    const l = st.last[i];
    if (day - l < P.min_rest_days) continue;
    if (l < bestLast) { best = i; bestLast = l; }
  }
  return best;
}

/** the postseason rotation: the best `size` present members by s (ties: as-of order) */
export function postseasonRotation(st: RotationState, P: RotationParams): number[] {
  const idx: number[] = [];
  for (let i = 0; i < st.ids.length; i++) if (st.present(i)) idx.push(i);
  idx.sort((a, b) => st.s[b] - st.s[a] || a - b);
  return idx.slice(0, P.postseason_rotation_size);
}

/** the postseason starter on `day` among the postseason rotation: the best rested member; else, when the rotation
    is short of `postseason_rotation_size` (a member departed), a replacement fills the vacant slot; else the most
    rested member on short rest; else a replacement */
export function pickPostseason(st: RotationState, rot: number[], day: number, P: RotationParams): { slot: number; short: boolean } {
  for (const i of rot) if (day - st.last[i] >= P.min_rest_days) return { slot: i, short: false };
  if (rot.length < P.postseason_rotation_size) return { slot: REPLACEMENT, short: false };
  let best = REPLACEMENT, bestLast = Infinity;
  for (const i of rot) if (day - st.last[i] >= P.short_rest_days && st.last[i] < bestLast) { best = i; bestLast = st.last[i]; }
  return { slot: best, short: best !== REPLACEMENT };
}

/** record a start by slot (a replacement start moves no member's clock) */
export function recordStart(st: RotationState, slot: number, day: number): void { if (slot >= 0) st.last[slot] = day; }

/** one projected regular-season start: the spot draw, the rule, the clocks; returns the slot or REPLACEMENT.
    (The caller advances st.games once per club game, projected or not.) */
export function projectRegular(st: RotationState, day: number, kind: GameKind, P: RotationParams, rng: Xoshiro128): number {
  const spot = rng.nextDouble() < P.p_spot[kind];
  const slot = pickRegular(st, day, P);
  if (spot) { if (P.spot_takes_turn) recordStart(st, slot, day); return REPLACEMENT; }
  recordStart(st, slot, day);
  return slot;
}

/** one projected postseason start */
export function projectPostseason(st: RotationState, rot: number[], day: number, P: RotationParams, rng: Xoshiro128): { slot: number; short: boolean } {
  const spot = rng.nextDouble() < P.p_spot.postseason;
  const pick = pickPostseason(st, rot, day, P);
  if (spot) { if (P.postseason_spot_takes_turn) recordStart(st, pick.slot, day); return { slot: REPLACEMENT, short: false }; }
  recordStart(st, pick.slot, day);
  return pick;
}
