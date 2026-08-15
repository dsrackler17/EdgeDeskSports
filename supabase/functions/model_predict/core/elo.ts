// ============================================================================
// EdgeDesk : model_predict / core / elo
//
// A self-calibrating strength rating built from an owned result history.
//
// WHY ELO IS THE BASELINE FOR TENNIS AND MMA, AND NOT A HAND-WEIGHTED FEATURE
// BLEND. Elo has no free parameters that have to be guessed from nowhere: the
// ratings are produced by the results themselves, and the only tunable is the
// update size. That makes it the one strength model EdgeDesk can stand behind
// on day one without a fitted coefficient table. Anything richer — serve/return
// splits, style matchups, fatigue — is layered on ONLY through coefficients
// fitted on the same history (core/fit.ts), never through weights chosen
// because they seemed reasonable.
//
// The K schedule is FiveThirtyEight's published tennis formulation,
// K = kFactor / (matchesPlayed + kShift)^kDecay, which shrinks the update as a
// player accumulates matches so a veteran's rating stops thrashing. Defaults
// are 250 / (m + 5)^0.4. Tours override them independently; ATP and WTA do NOT
// share a parameter set.
// ============================================================================

import { eloProb } from "./odds.ts";

export interface EloParams {
  initial: number;
  kFactor: number;
  kShift: number;
  kDecay: number;
  /** logistic scale; 400 is the conventional base-10 Elo scale */
  scale: number;
}

export const DEFAULT_ELO: EloParams = {
  initial: 1500,
  kFactor: 250,
  kShift: 5,
  kDecay: 0.4,
  scale: 400,
};

export interface EloState {
  rating: Map<string, number>;
  matches: Map<string, number>;
  lastDate: Map<string, string>;
  params: EloParams;
}

export function newElo(params: EloParams = DEFAULT_ELO): EloState {
  return { rating: new Map(), matches: new Map(), lastDate: new Map(), params };
}

export function ratingOf(s: EloState, id: string): number {
  const r = s.rating.get(id);
  return r == null ? s.params.initial : r;
}

export function matchesOf(s: EloState, id: string): number {
  return s.matches.get(id) ?? 0;
}

function kOf(s: EloState, id: string): number {
  const m = matchesOf(s, id);
  return s.params.kFactor / Math.pow(m + s.params.kShift, s.params.kDecay);
}

/**
 * Apply one result. Must be called in chronological order — Elo is path
 * dependent and feeding it out of order silently produces a different, wrong
 * rating set.
 */
export function updateElo(s: EloState, winnerId: string, loserId: string, dateIso?: string | null): void {
  const rw = ratingOf(s, winnerId);
  const rl = ratingOf(s, loserId);
  const pw = eloProb(rw - rl, s.params.scale);
  const kw = kOf(s, winnerId);
  const kl = kOf(s, loserId);
  s.rating.set(winnerId, rw + kw * (1 - pw));
  s.rating.set(loserId, rl - kl * (1 - pw));
  s.matches.set(winnerId, matchesOf(s, winnerId) + 1);
  s.matches.set(loserId, matchesOf(s, loserId) + 1);
  if (dateIso) {
    s.lastDate.set(winnerId, dateIso);
    s.lastDate.set(loserId, dateIso);
  }
}

/** P(a beats b) on this rating set. */
export function eloWinProb(s: EloState, a: string, b: string): number {
  return eloProb(ratingOf(s, a) - ratingOf(s, b), s.params.scale);
}

/**
 * Blend an overall rating with a surface-specific one.
 *
 * The weight given to the surface rating rises with the SMALLER of the two
 * players' surface sample, because a surface rating built on nine matches is
 * not evidence about a surface — it is noise wearing a surface's name. At
 * `fullAt` surface matches the surface rating carries `maxWeight`; below that
 * it is scaled linearly. maxWeight defaults to 0.5 (FiveThirtyEight's choice)
 * and is overridable per tour from fitted parameters.
 */
export function blendedRating(
  overall: number,
  surface: number,
  surfaceMatches: number,
  maxWeight: number,
  fullAt: number,
): { rating: number; weight: number } {
  const w = maxWeight * Math.min(1, Math.max(0, surfaceMatches / Math.max(1, fullAt)));
  return { rating: overall * (1 - w) + surface * w, weight: w };
}

/** Days between two ISO dates; null when either is unusable. */
export function daysBetween(aIso: string | null | undefined, bIso: string | null | undefined): number | null {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 86400000;
}
