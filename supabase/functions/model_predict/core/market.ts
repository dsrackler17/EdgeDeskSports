// ============================================================================
// EdgeDesk : model_predict / core / market
//
// Turns the flat `signals` rows into one group PER EVENT.
//
// ---------------------------------------------------------------------------
// WHY THIS IS GROUPED BY EVENT AND NOT BY TEAM PAIR  (the v1.2 doubleheader fix)
//
// v1.1 indexed the captured market by TEAM PAIR:
//
//     const key = matchKey(hName) + "|" + matchKey(aName);
//
// A key built from two team names cannot distinguish two games between those
// teams on the same day. On a doubleheader both events collapsed into one
// bucket: the FIRST signal row seen fixed the bucket's event_id and every later
// row — including all of game 2's h2h and totals — merged into it. Game 1's
// prediction could be built from game 2's market, both scheduled gamePks
// emitted rows carrying game 1's event_id, and the ignore-duplicates upsert
// silently discarded the second game. No error, no skip entry.
//
// `signals.event_id` was always the canonical identifier. The bug was an index
// that threw it away. So the market is grouped BY EVENT and the team pair is
// only a bucket used to find candidates — see identity.ts for the claim.
//
// That contract now holds for every sport, not just MLB: ATP, WTA, UFC, NFL and
// WNBA all read their events straight out of this index by event_id.
// ---------------------------------------------------------------------------
// ============================================================================

import type { MarketEvent, SignalRow } from "./types.ts";
import { matchKey, nrm, pairKey } from "./names.ts";

export const SIGNAL_SELECT =
  "event_id,sport_key,sport_title,market,selection,point,sharp_fair,best_dec,best_book,n_books,commence_time,home_team,away_team";

export interface MarketIndex {
  byEvent: Record<string, MarketEvent>;
  pairs: Record<string, MarketEvent[]>;
}

export function buildMarketIndex(sigRows: SignalRow[]): MarketIndex {
  const byEvent: Record<string, MarketEvent> = {};
  for (const s of sigRows) {
    if (!s || !s.event_id) continue;
    const g = byEvent[s.event_id] || (byEvent[s.event_id] = {
      event_id: s.event_id,
      sport_key: s.sport_key ?? "",
      sport_title: s.sport_title ?? null,
      commence_time: s.commence_time ?? null,
      home_team: s.home_team,
      away_team: s.away_team,
      totalsRows: [],
      spreadsRows: [],
    });
    if (s.market === "h2h") {
      if (matchKey(s.selection) === matchKey(s.home_team)) g.h2hHome = s;
      else if (matchKey(s.selection) === matchKey(s.away_team)) g.h2hAway = s;
    } else if (s.market === "totals") {
      g.totalsRows.push(s);
    } else if (s.market === "spreads") {
      g.spreadsRows.push(s);
    }
  }

  for (const id in byEvent) {
    const g = byEvent[id];
    g.mainTotal = pickMainTotal(g);
    g.mainSpread = pickMainSpread(g);
  }

  // Bucket events by team pair, earliest first, so a doubleheader is an ARRAY.
  const pairs: Record<string, MarketEvent[]> = {};
  for (const id in byEvent) {
    const g = byEvent[id];
    const k = pairKey(g.home_team, g.away_team);
    (pairs[k] || (pairs[k] = [])).push(g);
  }
  for (const k in pairs) {
    pairs[k].sort((a, b) => String(a.commence_time ?? "").localeCompare(String(b.commence_time ?? "")));
  }
  return { byEvent, pairs };
}

/** Main total per EVENT = the point the most books are quoting. Unchanged from
 *  v1.2, including the n_books tiebreak and the "first wins" ordering. */
function pickMainTotal(g: MarketEvent): { point: number | null; over?: SignalRow; under?: SignalRow } | null {
  if (!g.totalsRows.length) return null;
  const byPt: Record<string, { n: number; over?: SignalRow; under?: SignalRow }> = {};
  for (const r of g.totalsRows) {
    const p = String(r.point);
    const b = byPt[p] || (byPt[p] = { n: 0 });
    b.n += (+(r.n_books ?? 0) || 0);
    if (nrm(r.selection).indexOf("over") >= 0) b.over = r;
    else if (nrm(r.selection).indexOf("under") >= 0) b.under = r;
  }
  let best: { n: number; over?: SignalRow; under?: SignalRow } | null = null;
  let bestPt: number | null = null;
  for (const p in byPt) {
    if (!best || byPt[p].n > best.n) {
      best = byPt[p];
      bestPt = +p;
    }
  }
  return best ? { point: bestPt, over: best.over, under: best.under } : null;
}

/**
 * Main spread per EVENT. Same "most books quoting it" rule as totals, but a
 * spread is a SIGNED handicap and the two sides carry opposite points (-3.5 /
 * +3.5), so the pair is keyed on |point| and the sides are separated by which
 * participant the selection names. Keying on the raw point would file the two
 * halves of one line as two different lines.
 */
function pickMainSpread(g: MarketEvent): { point: number | null; home?: SignalRow; away?: SignalRow } | null {
  if (!g.spreadsRows.length) return null;
  const byPt: Record<string, { n: number; home?: SignalRow; away?: SignalRow }> = {};
  for (const r of g.spreadsRows) {
    if (r.point == null || !Number.isFinite(+r.point)) continue;
    const k = String(Math.abs(+r.point));
    const b = byPt[k] || (byPt[k] = { n: 0 });
    b.n += (+(r.n_books ?? 0) || 0);
    if (matchKey(r.selection) === matchKey(g.home_team)) b.home = r;
    else if (matchKey(r.selection) === matchKey(g.away_team)) b.away = r;
  }
  let best: { n: number; home?: SignalRow; away?: SignalRow } | null = null;
  for (const p in byPt) if (!best || byPt[p].n > best.n) best = byPt[p];
  if (!best) return null;
  // Report the HOME point, so `point` always reads as the home handicap.
  const pt = best.home?.point ?? (best.away?.point != null ? -(+best.away.point) : null);
  return { point: pt != null ? +pt : null, home: best.home, away: best.away };
}

/** Every event in the index, in first-start order. The event universe for every
 *  sport whose schedule EdgeDesk does not separately own. */
export function eventsInStartOrder(idx: MarketIndex): MarketEvent[] {
  return Object.values(idx.byEvent).sort((a, b) =>
    String(a.commence_time ?? "").localeCompare(String(b.commence_time ?? "")));
}
