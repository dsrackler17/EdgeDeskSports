// Shared odds read helpers and the freshness envelope.
//
// Every odds payload the Collective serves carries the same three facts:
// where the number came from, when it was last updated, and whether that
// counts as current. A surface that cannot say when a price was captured is
// not allowed to display it as live, so this envelope is mandatory rather
// than decorative.

import { rpc } from "./db.ts";

export type Freshness = "live" | "stale" | "unavailable";

export interface OddsEnvelope {
  source: { provider: string; league: string };
  /** When the feed was last confirmed current: the last successful poll. */
  last_updated: string | null;
  /** When a price last actually moved. Not the same question, and not what
   *  freshness is judged on — unchanged polls write nothing by design, so a
   *  quiet market would otherwise read as a broken feed. */
  last_change_at: string | null;
  age_seconds: number | null;
  state: Freshness;
  stale_after_seconds: number;
  /** Present only when state is not "live": a sentence a UI can show as-is. */
  notice?: string;
}

const DEFAULT_STALE_AFTER = 900;

/**
 * Classifies the feed.
 *   live        polled successfully inside the freshness window
 *   stale       the last successful poll is older than the window. Prices are
 *               still returned, labelled, with their age. Never relabelled
 *               current.
 *   unavailable nothing to show. No number is invented to fill the gap.
 *
 * lastPolled, not the newest price. A market that has not moved since Tuesday
 * is a quiet market, not a dead feed, and calling it stale would train people
 * to ignore the one label that is supposed to mean something.
 */
export function envelope(
  lastPolled: string | null | undefined,
  staleAfterSeconds: number | null | undefined,
  league = "nfl",
  // Not a vendor name. A caller that forgets to pass the provider should
  // produce a visibly unknown source, not a confident and wrong one — the
  // field is read as fact, including by the assistant route.
  provider = "unknown",
  lastChangeAt: string | null | undefined = null,
): OddsEnvelope {
  const lastUpdated = lastPolled ?? null;
  const changed = lastChangeAt ?? null;
  const staleAfter = Number(staleAfterSeconds) > 0
    ? Number(staleAfterSeconds)
    : DEFAULT_STALE_AFTER;
  if (!lastUpdated) {
    return {
      source: { provider, league },
      last_updated: null,
      last_change_at: changed,
      age_seconds: null,
      state: "unavailable",
      stale_after_seconds: staleAfter,
      notice: "Odds unavailable.",
    };
  }
  const ms = Date.parse(lastUpdated);
  if (!Number.isFinite(ms)) {
    return {
      source: { provider, league },
      last_updated: null,
      last_change_at: changed,
      age_seconds: null,
      state: "unavailable",
      stale_after_seconds: staleAfter,
      notice: "Odds unavailable.",
    };
  }
  const age = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (age <= staleAfter) {
    return {
      source: { provider, league },
      last_updated: lastUpdated,
      last_change_at: changed,
      age_seconds: age,
      state: "live",
      stale_after_seconds: staleAfter,
    };
  }
  return {
    source: { provider, league },
    last_updated: lastUpdated,
    last_change_at: changed,
    age_seconds: age,
    state: "stale",
    stale_after_seconds: staleAfter,
    notice: `Odds may be out of date. Last polled ${relativeAge(age)}.`,
  };
}

export function relativeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

// ------------------------------------------------------------------ settings
// The odds* prefixes on the read helpers below are deliberate: the dashboard
// deploys these functions as one flattened script, where a top level
// `history` or `status` would sit alongside the DOM globals of the same name.
let settingsCache: { at: number; values: Record<string, unknown> } | null = null;
const SETTINGS_TTL_MS = 60_000;

/** Reads odds settings, cached briefly so a slate render does not make one
 *  round trip per tunable. */
export async function settings(keys: string[]): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) {
    const have = keys.every((k) => k in settingsCache!.values);
    if (have) return settingsCache.values;
  }
  const values: Record<string, unknown> = { ...(settingsCache?.values ?? {}) };
  await Promise.all(keys.map(async (k) => {
    try {
      values[k] = await rpc<unknown>("odds_get_setting", { p_key: k });
    } catch {
      values[k] = null;
    }
  }));
  settingsCache = { at: now, values };
  return values;
}

/**
 * A number, or the fallback.
 *
 * The null check is the whole point: Number(null) is 0, and 0 is finite, so a
 * bare Number.isFinite guard silently turns every absent value into zero.
 * URLSearchParams.get returns null for a missing parameter, so ?limit,
 * ?days and ?week all became 0 — a one-game board, a one-day window, and a
 * cadence of zero seconds when a setting was missing.
 */
export function num(v: unknown, fallback: number): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function strList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (out.length) return out;
  }
  return fallback;
}

/** Board payload straight from SQL. The math is not repeated here. */
export async function oddsBoard(args: {
  league?: string;
  from?: string | null;
  to?: string | null;
  includeBooks?: boolean;
  limit?: number;
}): Promise<Record<string, unknown> | null> {
  return await rpc<Record<string, unknown> | null>("odds_board", {
    p_league: args.league ?? "nfl",
    p_from: args.from ?? null,
    p_to: args.to ?? null,
    p_include_books: args.includeBooks !== false,
    p_limit: args.limit ?? 40,
  });
}

export async function oddsEventPayload(args: {
  eventId?: string | null;
  gameId?: string | null;
  includeBooks?: boolean;
}): Promise<Record<string, unknown> | null> {
  return await rpc<Record<string, unknown> | null>("odds_event", {
    p_event_id: args.eventId ?? null,
    p_game_id: args.gameId ?? null,
    p_include_books: args.includeBooks !== false,
  });
}

export async function oddsHistory(args: {
  eventId: string;
  market?: string | null;
  book?: string | null;
  outcome?: string | null;
  limit?: number;
}): Promise<Record<string, unknown> | null> {
  return await rpc<Record<string, unknown> | null>("odds_history", {
    p_event_id: args.eventId,
    p_market: args.market ?? null,
    p_book: args.book ?? null,
    p_outcome: args.outcome ?? null,
    p_limit: args.limit ?? 500,
  });
}

export async function oddsStatus(league = "nfl"): Promise<Record<string, unknown> | null> {
  return await rpc<Record<string, unknown> | null>("odds_status", { p_league: league });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
