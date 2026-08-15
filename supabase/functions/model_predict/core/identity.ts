// ============================================================================
// EdgeDesk : model_predict / core / identity
//
// EVENT IDENTITY IS `signals.event_id`. Everywhere. For every sport.
//
// A team pair, or a player pair, is a CANDIDATE BUCKET and nothing more. Two
// teams play twice in a day; two fighters rematch; two players meet in three
// tournaments a season. Any identity built from the participants alone will
// eventually merge two real events into one, and the merge is silent because
// the upsert's ignore-duplicates resolution discards the loser without error.
//
// claimEvent() is the only sanctioned way to attach an externally-scheduled
// game (MLB's StatsAPI gamePk) to a captured market event: narrow by pair, pick
// the nearest unclaimed start time, and CONSUME it.
// ============================================================================

import type { MarketEvent } from "./types.ts";
import { pairKey } from "./names.ts";

/* How far apart two starts may be and still be considered the same event when
   joining an external schedule to the Odds API. Doubleheader games are hours
   apart; provider clock skew on a single game is minutes. Anything beyond this
   is a different event, and saying so is better than silently claiming the
   nearest one. */
export const DEFAULT_MATCH_WINDOW_MS = 240 * 60000;

/**
 * Give a scheduled game the market event that is actually its own.
 *
 * Returns null rather than the nearest available event when nothing falls
 * inside the match window — an event with no captured market is a real state
 * and is reported as such, not papered over with someone else's numbers.
 *
 * Behaviour is identical to v1.2's claimEvent(); it moved here so that every
 * sport gets the same guarantee instead of MLB alone.
 */
export function claimEvent(
  pairs: Record<string, MarketEvent[]>,
  home: unknown,
  away: unknown,
  gameTimeIso: string | null,
  windowMs: number = DEFAULT_MATCH_WINDOW_MS,
): MarketEvent | null {
  const pool = pairs[pairKey(home, away)];
  if (!pool || !pool.length) return null;
  const free = pool.filter((e) => !e.claimed);
  if (!free.length) return null;

  const t = gameTimeIso ? Date.parse(gameTimeIso) : NaN;
  if (!Number.isFinite(t)) {
    // No scheduled time to compare: take the earliest unclaimed, deterministically.
    free[0].claimed = true;
    return free[0];
  }
  let best: MarketEvent | null = null;
  let bestDiff = Infinity;
  for (const e of free) {
    const et = e.commence_time ? Date.parse(e.commence_time) : NaN;
    const diff = Number.isFinite(et) ? Math.abs(et - t) : Infinity;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  if (!best) return null;
  /* An event whose start is nowhere near this game is a different game. Only
     fall back to an undated event, which carries no contradiction. */
  if (bestDiff > windowMs && Number.isFinite(bestDiff)) {
    const undated = free.find((e) => !e.commence_time);
    if (!undated) return null;
    undated.claimed = true;
    return undated;
  }
  best.claimed = true;
  return best;
}

/**
 * Claim a market event directly by its own id.
 *
 * The path for every sport whose event universe IS the captured market: there
 * is no external schedule to join, so identity needs no reconstruction. The
 * consume step is kept anyway, because it is what makes "this event was already
 * predicted this run" a detectable condition rather than a duplicate row.
 */
export function claimById(idx: { byEvent: Record<string, MarketEvent> }, eventId: string): MarketEvent | null {
  const e = idx.byEvent[eventId];
  if (!e || e.claimed) return null;
  e.claimed = true;
  return e;
}

/** Market events nobody took. How a join break surfaces in the run instead of
 *  three weeks later in the record. */
export function unmatchedEvents(idx: { byEvent: Record<string, MarketEvent> }) {
  return Object.values(idx.byEvent)
    .filter((e) => !e.claimed)
    .map((e) => ({
      event_id: e.event_id,
      game: `${e.away_team} @ ${e.home_team}`,
      commence_time: e.commence_time,
    }));
}

/** How many market events share a participant pair — the doubleheader /
 *  same-day-rematch counter. Every one of them should end up claimed. */
export function duplicatePairEventCount(idx: { pairs: Record<string, MarketEvent[]> }): number {
  let n = 0;
  for (const k in idx.pairs) if (idx.pairs[k].length > 1) n += idx.pairs[k].length;
  return n;
}
