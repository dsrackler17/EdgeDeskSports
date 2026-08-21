// Vendor-agnostic normalization primitives.
//
// These are pure functions with no network and no environment access, which
// is what makes them testable outside Deno (see tests/collective/normalize_test.mjs).
// Each one has the same rule: recognise what it understands, and return null
// for anything else so the caller can report it. Nothing here ever guesses a
// number into existence.

import type { MarketId, Outcome, UnmappedRow } from "./odds_provider.ts";

/** lowercase, alphanumerics only. The comparison key for every fuzzy match. */
export function normKey(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * American odds from whatever the wire carried: -110, "-110", "+135", "EVEN".
 * Returns null for anything that is not a usable American price, including
 * the impossible band between -99 and +99 — a "price" of 0 or 5 means the
 * field was not American odds, and inventing one would poison every downstream
 * probability.
 */
export function parseAmericanPrice(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^(even|ev|evens|pk)$/i.test(t)) return 100;
    const cleaned = t.replace(/[\s,]/g, "");
    if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
    v = Number(cleaned);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n >= 100 || n <= -100) return n;
  return null;
}

/**
 * A points value: "-3.5", "+3.5", 3.5, "PK"/"Pick'em" (zero). Returns null
 * when there is no line, which is correct for a moneyline.
 */
export function parseLine(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^(pk|pick|pickem|pick'?em|even)$/i.test(t)) return 0;
    const cleaned = t.replace(/[\s,]/g, "").replace(/^([+-])?(o|u|over|under)/i, "$1");
    if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
    v = Number(cleaned);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

/** Decimal odds from American. Used for price comparison, where "bigger is
 *  better" holds and American odds do not sort. */
export function americanToDecimal(price: number): number | null {
  if (!Number.isFinite(price)) return null;
  if (price >= 100) return 1 + price / 100;
  if (price <= -100) return 1 + 100 / Math.abs(price);
  return null;
}

export function americanToProb(price: number): number | null {
  const d = americanToDecimal(price);
  return d === null ? null : 1 / d;
}

/** Two-way multiplicative de-vig. The only honest way to combine moneylines:
 *  raw American prices are never averaged. */
export function devigTwoWay(pa: number, pb: number): number | null {
  if (!Number.isFinite(pa) || !Number.isFinite(pb) || pa + pb <= 0) return null;
  return pa / (pa + pb);
}

// -------------------------------------------------------------- markets
// Vendors label markets for humans ("Point Spread"), so match on the label.
// A name that matches nothing is reported as unmapped rather than forced into
// the nearest bucket.
const MARKET_ALIASES: Record<string, MarketId> = {
  moneyline: "moneyline",
  moneylines: "moneyline",
  money: "moneyline",
  ml: "moneyline",
  h2h: "moneyline",
  headtohead: "moneyline",
  matchupwinner: "moneyline",
  gamelines: "moneyline",

  pointspread: "spread",
  spread: "spread",
  spreads: "spread",
  handicap: "spread",
  pointhandicap: "spread",
  linespread: "spread",
  gamespread: "spread",

  totalpoints: "total",
  total: "total",
  totals: "total",
  overunder: "total",
  gametotal: "total",
  totalpointsoverunder: "total",

  teamtotal: "team_total",
  teamtotalpoints: "team_total",
  alternatepointspread: "alternate_spread",
  alternatespread: "alternate_spread",
  alternatetotal: "alternate_total",
  alternatetotalpoints: "alternate_total",
};

export function canonicalMarket(raw: unknown): MarketId | null {
  const k = normKey(raw);
  if (!k) return null;
  return MARKET_ALIASES[k] ?? null;
}

/** Markets we store as game lines. Everything else is registered but not
 *  treated as a game line by the read API. */
export const GAME_MARKETS: MarketId[] = ["moneyline", "spread", "total"];

// -------------------------------------------------------------- outcomes
const OVER_WORDS = new Set(["over", "o", "above", "more"]);
const UNDER_WORDS = new Set(["under", "u", "below", "less"]);

/**
 * Which side a price sits on.
 *
 * For totals this is over/under. For spreads and moneylines it is home/away,
 * decided by an explicit side field when the vendor gives one, and otherwise
 * by matching the selection text against the two team names we already know.
 * If neither works the answer is null: an unattributed price is useless and
 * a coin-flip guess would silently invert a whole market.
 */
export function resolveOutcome(args: {
  market: MarketId;
  side?: unknown;
  selectionName?: unknown;
  homeNames: string[];
  awayNames: string[];
}): Outcome | null {
  const { market, side, selectionName, homeNames, awayNames } = args;
  const sideKey = normKey(side);
  const nameKey = normKey(selectionName);

  if (market === "total" || market === "team_total" || market === "alternate_total") {
    if (OVER_WORDS.has(sideKey)) return "over";
    if (UNDER_WORDS.has(sideKey)) return "under";
    if (OVER_WORDS.has(nameKey)) return "over";
    if (UNDER_WORDS.has(nameKey)) return "under";
    // "Over 47.5" / "Under 47.5"
    if (/^over/.test(nameKey)) return "over";
    if (/^under/.test(nameKey)) return "under";
    return null;
  }

  if (sideKey === "home") return "home";
  if (sideKey === "away") return "away";
  if (sideKey === "draw" || sideKey === "tie") return "draw";

  const home = new Set(homeNames.map(normKey).filter(Boolean));
  const away = new Set(awayNames.map(normKey).filter(Boolean));
  if (!nameKey) return null;
  if (home.has(nameKey)) return "home";
  if (away.has(nameKey)) return "away";
  // Vendors append the number: "Kansas City Chiefs -3.5".
  const stripped = nameKey.replace(/[+-]?\d+(\d|5)?$/, "");
  for (const h of home) if (h && (nameKey.startsWith(h) || stripped === h)) return "home";
  for (const a of away) if (a && (nameKey.startsWith(a) || stripped === a)) return "away";
  return null;
}

/** The trailing number in a selection label: "Chiefs -3.5" -> -3.5,
 *  "Over 47.5" -> 47.5. Last resort only, after every explicit field. */
export function lineFromLabel(label: unknown): number | null {
  const s = String(label ?? "").trim();
  const m = s.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
  return m ? parseLine(m[1]) : null;
}

/** First non-null among a list of candidate accessors. Lets an adapter list
 *  the documented field, then the documented alternatives, in priority order
 *  without a pile of nested ternaries. */
export function firstOf<T>(...candidates: (T | null | undefined)[]): T | null {
  for (const c of candidates) {
    if (c !== null && c !== undefined) return c;
  }
  return null;
}

// -------------------------------------------------------------- diagnostics

/** Key paths present in a value, e.g. "events[].odds[].selection.line".
 *  Structure only: no values are included, so this is always safe to log. */
export function shapePaths(value: unknown, maxDepth = 6, prefix = ""): string[] {
  const out = new Set<string>();
  walk(value, prefix, 0);
  function walk(v: unknown, path: string, depth: number): void {
    if (depth > maxDepth) return;
    if (Array.isArray(v)) {
      if (path) out.add(`${path}[]`);
      // One element is enough to describe the shape of a homogeneous array.
      if (v.length) walk(v[0], `${path}[]`, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        const child = (v as Record<string, unknown>)[k];
        if (child && typeof child === "object") walk(child, p, depth + 1);
        else out.add(p);
      }
      return;
    }
    if (path) out.add(path);
  }
  return [...out].sort();
}

/** Removes anything credential-shaped from a URL before it is logged, stored,
 *  or returned. Query keys are matched by name; the value is replaced, never
 *  truncated to a prefix. */
const SECRET_PARAMS = ["key", "apikey", "api_key", "token", "access_token", "secret"];

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const p of [...u.searchParams.keys()]) {
      if (SECRET_PARAMS.includes(p.toLowerCase())) u.searchParams.set(p, "REDACTED");
    }
    return u.toString();
  } catch {
    return "invalid-url";
  }
}

/** Strips a known secret out of arbitrary text (an error message, a vendor
 *  body) before it reaches a log line or an ingest_runs row. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  let out = String(text ?? "");
  if (secret && secret.length >= 6) {
    out = out.split(secret).join("REDACTED");
  }
  return out.replace(
    new RegExp(`([?&](?:${SECRET_PARAMS.join("|")})=)[^&\\s"']+`, "gi"),
    "$1REDACTED",
  );
}

export function unmapped(book: string, reason: string, row: unknown): UnmappedRow {
  const keys = row && typeof row === "object" && !Array.isArray(row)
    ? Object.keys(row as Record<string, unknown>)
    : [];
  return { book, reason, keys, sample: sampleOf(row) };
}

/** A bounded, value-bearing sample for diagnosis. Capped so an unmapped-row
 *  report can never grow into a payload dump. */
export function sampleOf(row: unknown, maxLen = 400): unknown {
  try {
    const s = JSON.stringify(row);
    if (s === undefined) return null;
    return s.length <= maxLen ? JSON.parse(s) : `${s.slice(0, maxLen)}…`;
  } catch {
    return null;
  }
}
