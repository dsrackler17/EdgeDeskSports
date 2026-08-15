// ============================================================================
//  FILE:    supabase/functions/ufc_live_stats/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy ufc_live_stats --no-verify-jwt
//  BUILD:   ufc-live-stats-v1  (authoritative value: `export const BUILD` below)
//  SCHEMA:  sql/ufc_live_v2.sql   (run it first; this function only writes)
//  IMPORTS: NONE from ../_shared. ONE FILE — same reason as capture/index.ts:
//           the dashboard bundles only the folder of the function being edited,
//           an unresolvable relative import fails the bundle, the deploy is
//           REJECTED, and the previous version keeps serving. A fix that cannot
//           land is not a fix.
// ============================================================================
//
//  WHAT THIS IS
//
//  A live UFC fight-statistics poller. It discovers active events, normalizes
//  whatever the configured provider returns into EdgeDesk's canonical stat
//  contract, writes current state, per-round statistics and an immutable
//  timestamped snapshot timeline, and records what it did in telemetry.
//
//  ─────────────────────────────────────────────────────────────────────────
//  WHAT THIS IS NOT, AND WHY THAT MATTERS MOST
//
//  IT IS NOT PART OF THE ODDS CAPTURE PATH. It does not import, call, modify,
//  read or share a process with `capture`. It does not write `public.signals`
//  or `public.signal_ticks`. It computes no fair line, no edge, no opening
//  price, no flag and no tick.
//
//  The isolation is STRUCTURAL, not a promise in a comment. Two separate Edge
//  Functions on two separate schedules cannot fail into each other: a UFC API
//  timeout, a 429, a malformed bout or a failed snapshot write happens in a
//  different process from the one pricing the board, and the board's run never
//  observes it.
//
//  WHY NOT A captureUFC() INSIDE capture(). Because capture is already fighting
//  for its wall clock — it carries BUDGET_MS, an explicit "finish the sport you
//  are on, skip the rest, RETURN" rule, and `sports_skipped_for_time` telemetry
//  that exists because the run was previously being killed mid-flight with its
//  writes still in memory. UFC polling inside that budget would take clock
//  directly from the odds board, and the first symptom would be sports silently
//  dropping off the end of the run. The right place for a poller that wants to
//  run every few seconds is not inside a function that must finish a full board
//  price in 110 seconds.
//
//  ─────────────────────────────────────────────────────────────────────────
//  SOURCE-AGNOSTIC BY CONSTRUCTION
//
//  No provider's JSON shape reaches the database or the UI. The flow is:
//
//      PROVIDER RESPONSE                (provider-specific, quarantined here)
//            |
//            v
//      ADAPTER  .discover() / .detail() (the ONLY provider-aware code)
//            |
//            v
//      FLATTENER  flattenStatEntries()  (shape-tolerant: arrays, objects,
//            |                           categories, name/value pairs)
//            v
//      ALIAS MAP  canonicalStatSlot()   (name-tolerant: one canonical contract,
//            |                           many source spellings)
//            v
//      CANONICAL STATS                  (what the tables and the UI know about)
//
//  Swapping providers means writing an adapter. It does not mean a migration,
//  and it does not mean touching app.html.
//
//  NOTHING IS INVENTED. A statistic the provider did not publish is written as
//  NULL, and NULL renders as unavailable. It is never defaulted to zero — zero
//  is a claim about the fight, and a claim EdgeDesk has no evidence for is
//  worse than a blank. Every source key the flattener finds but the alias map
//  does not recognise is COUNTED AND REPORTED in `unmapped_stat_keys`, so a
//  provider renaming a field surfaces as a diagnostic instead of quietly
//  becoming an empty column.
//
//  ─────────────────────────────────────────────────────────────────────────
//  ON THE ESPN ADAPTER SPECIFICALLY
//
//  It is included, it is OPTIONAL, and it is not the default. It was written
//  from the documented public shape and has NOT been verified against a live
//  response, because the environment this was built in blocks the host. That is
//  recorded honestly rather than papered over: `provider_verified` is not a
//  claim in a config file, it is measured each run — true only when the adapter
//  actually parsed usable events out of a real 2xx response. An adapter that
//  never matches anything therefore reports itself as unverified rather than
//  looking like a quiet night with no fights.
//
//  Point UFC_LIVE_PROVIDER at a live provider you have credentials for. With no
//  provider configured this function does nothing, writes one telemetry row
//  saying so, and returns status "unconfigured" — which is a state, not a
//  failure, and is reported differently from one.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const BUILD = "ufc-live-stats-v1";

/* ══════════════════════════════════════════════════════════════════════════
   PURE CORE START
   Everything between these markers is deterministic: no network, no database,
   no Deno, no clock except what is passed in. It is what the test suite
   exercises directly, and it is where every normalization decision lives.
   ══════════════════════════════════════════════════════════════════════════ */

/** The canonical stat contract. Every field is `number | null`; null means the
    provider did not publish it. There is no zero-default anywhere. */
export interface CanonicalStats {
  sig_strikes_landed: number | null;
  sig_strikes_attempted: number | null;
  total_strikes_landed: number | null;
  total_strikes_attempted: number | null;
  head_strikes_landed: number | null;
  head_strikes_attempted: number | null;
  body_strikes_landed: number | null;
  body_strikes_attempted: number | null;
  leg_strikes_landed: number | null;
  leg_strikes_attempted: number | null;
  distance_strikes_landed: number | null;
  distance_strikes_attempted: number | null;
  clinch_strikes_landed: number | null;
  clinch_strikes_attempted: number | null;
  ground_strikes_landed: number | null;
  ground_strikes_attempted: number | null;
  takedowns_landed: number | null;
  takedowns_attempted: number | null;
  takedowns_pct: number | null;
  submission_attempts: number | null;
  reversals: number | null;
  control_seconds: number | null;
  knockdowns: number | null;
}

export const STAT_FIELDS: (keyof CanonicalStats)[] = [
  "sig_strikes_landed", "sig_strikes_attempted",
  "total_strikes_landed", "total_strikes_attempted",
  "head_strikes_landed", "head_strikes_attempted",
  "body_strikes_landed", "body_strikes_attempted",
  "leg_strikes_landed", "leg_strikes_attempted",
  "distance_strikes_landed", "distance_strikes_attempted",
  "clinch_strikes_landed", "clinch_strikes_attempted",
  "ground_strikes_landed", "ground_strikes_attempted",
  "takedowns_landed", "takedowns_attempted", "takedowns_pct",
  "submission_attempts", "reversals", "control_seconds", "knockdowns",
];

export function emptyStats(): CanonicalStats {
  const o: any = {};
  for (const f of STAT_FIELDS) o[f] = null;
  return o as CanonicalStats;
}

/** True when the provider published nothing at all for this corner. Used to set
    live_fight_state.stats_available, which is what lets the diagnostics say
    "the fight exists but the feed publishes no statistics" instead of leaving
    a reader to guess from a screen of dashes. */
export function statsAreEmpty(s: CanonicalStats): boolean {
  for (const f of STAT_FIELDS) if (s[f] != null) return false;
  return true;
}

/** Loose key normalizer: "Sig. Strikes Landed" and "sigStrikesLanded" and
    "SIG_STRIKES_LANDED" all collapse to "sig_strikes_landed" before lookup, so
    the alias table lists MEANINGS rather than every possible spelling. */
export function normKey(k: unknown): string {
  return String(k ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")   // camelCase -> camel_Case
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Name normalizer for fighter matching. Strips accents, punctuation, suffixes
    and case so "José Aldó Jr." and "Jose Aldo" reconcile. Deliberately NOT
    fuzzy: it normalizes spelling, it does not guess at similarity. A near-miss
    stays unresolved, because a wrongly linked fighter silently attaches one
    man's career to another man's fight. */
export function normalizeName(n: unknown): string {
  return String(n ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().replace(/\s+/g, " ");
}

/* ── THE ALIAS MAP ────────────────────────────────────────────────────────
   Left: a normalized source key. Right: a canonical slot.

   A slot ending in "#pair" means the value carries BOTH landed and attempted
   in one string ("12 of 30", "12/30"), which is how most MMA feeds and every
   UFCStats-derived dataset publish strike and takedown counts.

   Adding a provider spelling is a one-line change here and nowhere else. When
   a run reports unmapped keys, this is the table to extend. */
const PAIR = "#pair";
export const STAT_ALIASES: Record<string, string> = {
  // significant strikes (fight total)
  sig_strikes: "sig_strikes" + PAIR,
  sig_str: "sig_strikes" + PAIR,
  significant_strikes: "sig_strikes" + PAIR,
  sig_strikes_landed_attempted: "sig_strikes" + PAIR,
  significant_strikes_landed_attempted: "sig_strikes" + PAIR,
  sig_strikes_landed: "sig_strikes_landed",
  significant_strikes_landed: "sig_strikes_landed",
  sig_str_landed: "sig_strikes_landed",
  significant_strikes_succeeded: "sig_strikes_landed",
  sig_strikes_attempted: "sig_strikes_attempted",
  significant_strikes_attempted: "sig_strikes_attempted",
  sig_str_attempted: "sig_strikes_attempted",
  significant_strikes_thrown: "sig_strikes_attempted",

  // all strikes
  total_strikes: "total_strikes" + PAIR,
  total_str: "total_strikes" + PAIR,
  strikes: "total_strikes" + PAIR,
  total_strikes_landed: "total_strikes_landed",
  total_str_landed: "total_strikes_landed",
  strikes_landed: "total_strikes_landed",
  total_strikes_attempted: "total_strikes_attempted",
  total_str_attempted: "total_strikes_attempted",
  strikes_attempted: "total_strikes_attempted",
  strikes_thrown: "total_strikes_attempted",

  // target breakdown
  head: "head_strikes" + PAIR,
  head_strikes: "head_strikes" + PAIR,
  head_significant_strikes: "head_strikes" + PAIR,
  sig_strikes_head: "head_strikes" + PAIR,
  head_strikes_landed: "head_strikes_landed",
  head_strikes_attempted: "head_strikes_attempted",
  body: "body_strikes" + PAIR,
  body_strikes: "body_strikes" + PAIR,
  body_significant_strikes: "body_strikes" + PAIR,
  sig_strikes_body: "body_strikes" + PAIR,
  body_strikes_landed: "body_strikes_landed",
  body_strikes_attempted: "body_strikes_attempted",
  leg: "leg_strikes" + PAIR,
  legs: "leg_strikes" + PAIR,
  leg_strikes: "leg_strikes" + PAIR,
  leg_significant_strikes: "leg_strikes" + PAIR,
  sig_strikes_leg: "leg_strikes" + PAIR,
  leg_strikes_landed: "leg_strikes_landed",
  leg_strikes_attempted: "leg_strikes_attempted",

  // position breakdown
  distance: "distance_strikes" + PAIR,
  distance_strikes: "distance_strikes" + PAIR,
  distance_significant_strikes: "distance_strikes" + PAIR,
  sig_strikes_distance: "distance_strikes" + PAIR,
  distance_strikes_landed: "distance_strikes_landed",
  distance_strikes_attempted: "distance_strikes_attempted",
  clinch: "clinch_strikes" + PAIR,
  clinch_strikes: "clinch_strikes" + PAIR,
  clinch_significant_strikes: "clinch_strikes" + PAIR,
  sig_strikes_clinch: "clinch_strikes" + PAIR,
  clinch_strikes_landed: "clinch_strikes_landed",
  clinch_strikes_attempted: "clinch_strikes_attempted",
  ground: "ground_strikes" + PAIR,
  ground_strikes: "ground_strikes" + PAIR,
  ground_significant_strikes: "ground_strikes" + PAIR,
  sig_strikes_ground: "ground_strikes" + PAIR,
  ground_strikes_landed: "ground_strikes_landed",
  ground_strikes_attempted: "ground_strikes_attempted",

  // grappling
  takedowns: "takedowns" + PAIR,
  td: "takedowns" + PAIR,
  takedown: "takedowns" + PAIR,
  takedowns_landed_attempted: "takedowns" + PAIR,
  takedowns_landed: "takedowns_landed",
  td_landed: "takedowns_landed",
  takedowns_succeeded: "takedowns_landed",
  takedowns_attempted: "takedowns_attempted",
  td_attempted: "takedowns_attempted",
  takedown_percentage: "takedowns_pct",
  takedowns_pct: "takedowns_pct",
  td_pct: "takedowns_pct",
  takedown_accuracy: "takedowns_pct",

  submission_attempts: "submission_attempts",
  sub_attempts: "submission_attempts",
  submissions: "submission_attempts",
  sub_att: "submission_attempts",
  submission_attempt: "submission_attempts",

  reversals: "reversals",
  reversal: "reversals",
  rev: "reversals",

  control: "control_seconds",
  control_time: "control_seconds",
  ctrl: "control_seconds",
  control_time_seconds: "control_seconds",
  ground_control: "control_seconds",
  ground_control_time: "control_seconds",

  knockdowns: "knockdowns",
  kd: "knockdowns",
  knockdown: "knockdowns",
  knock_downs: "knockdowns",
};

export type StatSlot =
  | { kind: "pair"; base: string }
  | { kind: "field"; field: keyof CanonicalStats }
  | null;

/** Map a raw source key onto a canonical slot, or null when we do not know what
    it is. Returning null rather than a best guess is the whole point: an
    unrecognised key becomes a reported diagnostic, never a silent value in the
    wrong column. */
export function canonicalStatSlot(rawKey: unknown): StatSlot {
  const hit = STAT_ALIASES[normKey(rawKey)];
  if (!hit) return null;
  if (hit.endsWith(PAIR)) return { kind: "pair", base: hit.slice(0, -PAIR.length) };
  return { kind: "field", field: hit as keyof CanonicalStats };
}

export type ParsedValue =
  | { kind: "pair"; landed: number; attempted: number }
  | { kind: "num"; n: number }
  | { kind: "time"; seconds: number }
  | { kind: "pct"; p: number }
  | null;

/** Parse whatever the provider put in the value position.

    Handles, because feeds do all of these: "12 of 30", "12/30", "12-30",
    "2:31", "1:02:03", "45%", "0.45", 12, "12", and every flavour of blank
    ("", "-", "--", "—", "N/A", "null", undefined).

    A blank returns null, which becomes a NULL column, which renders as
    unavailable. It does not become 0. */
export function parseStatValue(raw: unknown): ParsedValue {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? { kind: "num", n: raw } : null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^(-{1,2}|—|–|n\/?a|null|undefined|tbd)$/i.test(s)) return null;

  // "12 of 30" | "12/30" | "12 - 30"  -> landed / attempted
  const pair = /^(-?\d+(?:\.\d+)?)\s*(?:of|\/|-|:of:)\s*(-?\d+(?:\.\d+)?)$/i.exec(s);
  if (pair) {
    const landed = Number(pair[1]), attempted = Number(pair[2]);
    if (Number.isFinite(landed) && Number.isFinite(attempted)) {
      return { kind: "pair", landed, attempted };
    }
  }

  // "2:31" | "1:02:03" -> seconds. Checked BEFORE the bare-number branch so a
  // clock is never read as a count.
  const t = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (t) {
    const a = Number(t[1]), b = Number(t[2]), c = t[3] != null ? Number(t[3]) : null;
    const seconds = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
    return Number.isFinite(seconds) ? { kind: "time", seconds } : null;
  }

  // "45%" -> 0.45. Stored as a fraction so it never collides with a count.
  const p = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (p) {
    const n = Number(p[1]);
    return Number.isFinite(n) ? { kind: "pct", p: n / 100 } : null;
  }

  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? { kind: "num", n } : null;
}

/** Coerce a parsed value into a whole count. A feed that sends "12.0" means 12;
    a feed that sends "12.4" strikes is malformed and is refused rather than
    silently rounded into a statistic nobody can trace. */
function asCount(v: ParsedValue): number | null {
  if (!v) return null;
  if (v.kind === "num") return Number.isInteger(v.n) ? v.n : (Math.abs(v.n % 1) < 1e-9 ? Math.round(v.n) : null);
  if (v.kind === "time") return null;
  if (v.kind === "pct") return null;
  return null;
}

/** Write one source key/value into the canonical stat object.
    Returns true when something was actually assigned. */
export function assignStat(out: CanonicalStats, slot: StatSlot, raw: unknown): boolean {
  if (!slot) return false;
  const v = parseStatValue(raw);
  if (!v) return false;

  if (slot.kind === "pair") {
    if (v.kind !== "pair") {
      // A pair slot given a single number is ambiguous — is 12 landed, or
      // thrown? Guessing would put a number in a column it may not belong in,
      // so it is refused and reported as a missing field instead.
      return false;
    }
    const landed = `${slot.base}_landed` as keyof CanonicalStats;
    const attempted = `${slot.base}_attempted` as keyof CanonicalStats;
    if (!STAT_FIELDS.includes(landed) || !STAT_FIELDS.includes(attempted)) return false;
    (out as any)[landed] = Number.isInteger(v.landed) ? v.landed : Math.round(v.landed);
    (out as any)[attempted] = Number.isInteger(v.attempted) ? v.attempted : Math.round(v.attempted);
    return true;
  }

  const f = slot.field;
  if (f === "control_seconds") {
    if (v.kind === "time") { (out as any)[f] = v.seconds; return true; }
    if (v.kind === "num" && v.n >= 0) { (out as any)[f] = Math.round(v.n); return true; }
    return false;
  }
  if (f === "takedowns_pct") {
    if (v.kind === "pct") { (out as any)[f] = v.p; return true; }
    // a bare 0..1 is already a fraction; a bare 0..100 is a percentage
    if (v.kind === "num" && v.n >= 0 && v.n <= 1) { (out as any)[f] = v.n; return true; }
    if (v.kind === "num" && v.n > 1 && v.n <= 100) { (out as any)[f] = v.n / 100; return true; }
    return false;
  }
  const c = asCount(v);
  if (c == null || c < 0) return false;
  (out as any)[f] = c;
  return true;
}

/** A flat {key: value} bag pulled out of an arbitrarily-shaped provider node. */
export interface StatBag { [k: string]: unknown }

/** Walk a provider payload node and flatten every stat-looking thing into one
    bag, tolerating the shapes feeds actually use:

      [{name, displayValue}] · [{name, value}] · [{abbreviation, displayValue}]
      {sig_strikes_landed: 5} · {categories:[{name, stats:[...]}]}
      {statistics:{...}} · {stats:[...]} · {totals:{...}}

    Depth-limited, because a cyclic or pathologically nested payload must cost a
    bounded amount of work rather than the whole run. */
export function flattenStatEntries(node: unknown, depth = 0, out: StatBag = {}): StatBag {
  if (node == null || depth > 6) return out;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as any;
        const name = o.name ?? o.key ?? o.abbreviation ?? o.shortDisplayName ?? o.type ?? o.label;
        const val = o.displayValue ?? o.value ?? o.displayName ?? o.count ?? o.total;
        if (name != null && val != null && typeof val !== "object") {
          // last writer wins is wrong here: an earlier, more specific key
          // ("sig_strikes_landed") must not be clobbered by a later generic one
          if (!(normKey(name) in out)) out[normKey(name)] = val;
          continue;
        }
      }
      flattenStatEntries(item, depth + 1, out);
    }
    return out;
  }

  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as any)) {
      if (v == null) continue;
      if (typeof v === "object") { flattenStatEntries(v, depth + 1, out); continue; }
      const nk = normKey(k);
      if (!(nk in out)) out[nk] = v;
    }
  }
  return out;
}

export interface NormalizeResult {
  stats: CanonicalStats;
  mapped: number;
  unmapped: string[];
  /** keys we recognised but could not use — a pair slot given a bare number,
      a count given a clock. Counted separately from unknown keys because the
      fix is different: this is a value problem, not a naming problem. */
  unusable: string[];
}

/** THE NORMALIZER. Provider bag in, canonical stats out, with a full account of
    what was understood and what was not. */
export function normalizeStatBag(bag: StatBag): NormalizeResult {
  const stats = emptyStats();
  const unmapped: string[] = [];
  const unusable: string[] = [];
  let mapped = 0;

  for (const [k, v] of Object.entries(bag || {})) {
    const slot = canonicalStatSlot(k);
    if (!slot) {
      // Ignore obvious non-stat scaffolding rather than reporting it as a
      // mystery — a diagnostic full of "id", "name", "uid" teaches nobody
      // anything and buries the one key that actually changed.
      if (!IGNORED_KEYS.has(normKey(k))) unmapped.push(normKey(k));
      continue;
    }
    if (assignStat(stats, slot, v)) mapped++;
    else unusable.push(normKey(k));
  }
  return { stats, mapped, unmapped, unusable };
}

const IGNORED_KEYS = new Set([
  "id", "uid", "guid", "name", "full_name", "short_name", "display_name", "abbreviation",
  "type", "order", "home_away", "winner", "logo", "href", "ref", "link", "links",
  "color", "alternate_color", "record", "records", "athlete", "team", "position",
  "description", "summary", "label", "rank", "seed", "score", "status", "period",
  "display_clock", "clock", "date", "start_date", "venue", "location", "weight_class",
  "first_name", "last_name", "nickname", "flag", "country", "age", "height", "reach",
  "stance", "weight", "division", "odds", "probability", "win_probability",
]);

/** Sum per-round rows into the fight total.

    This is ARITHMETIC ON STORED NUMBERS, not a model: if the provider published
    rounds 1-3 and no total, the total is the sum of what it published. It is
    exactly as trustworthy as its inputs and no more.

    A field NULL in every round stays NULL in the total — summing nothing must
    not produce zero, because that would turn "not published" into "none
    happened". A field present in some rounds sums the ones present and the
    result is flagged partial by the caller. */
export function sumRounds(rounds: CanonicalStats[]): CanonicalStats {
  const out = emptyStats();
  for (const f of STAT_FIELDS) {
    if (f === "takedowns_pct") continue;      // a rate never sums; derived below
    let acc: number | null = null;
    for (const r of rounds) {
      const v = r[f];
      if (v == null) continue;
      acc = (acc == null ? 0 : acc) + v;
    }
    (out as any)[f] = acc;
  }
  if (out.takedowns_landed != null && out.takedowns_attempted != null && out.takedowns_attempted > 0) {
    out.takedowns_pct = out.takedowns_landed / out.takedowns_attempted;
  }
  return out;
}

/** "2:14" -> 134. The clock a provider prints is a display string; a number is
    what the timeline needs. Unparseable returns null and the display string is
    still stored verbatim, so nothing is lost. */
export function parseClockSeconds(clock: unknown): number | null {
  if (clock == null) return null;
  if (typeof clock === "number") return Number.isFinite(clock) ? Math.max(0, Math.round(clock)) : null;
  const m = /^(\d+):([0-5]?\d)$/.exec(String(clock).trim());
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(s) ? s : null;
}

/** Seconds of fight elapsed, given the round and the count-DOWN clock a UFC
    round uses. Round 2 at 2:14 remaining is 300 + (300-134) = 466s elapsed.

    Returns null rather than a guess when the round or clock is unknown — an
    elapsed time nobody can check is not worth having on a timeline. */
export function elapsedSeconds(
  round: number | null, clockSeconds: number | null, roundLengthSec = 300,
): number | null {
  if (round == null || !Number.isFinite(round) || round < 1) return null;
  if (clockSeconds == null) return null;
  const completed = (round - 1) * roundLengthSec;
  const inRound = Math.max(0, roundLengthSec - clockSeconds);
  return completed + inRound;
}

/** Collapse a provider's status vocabulary onto the four states EdgeDesk uses.
    Unknown input returns null, and a null status renders as unknown rather than
    being defaulted to "pre" — a fight wrongly shown as upcoming while it is
    being fought is a worse error than one shown as unknown. */
export function normalizeStatus(raw: unknown): string | null {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return null;
  /* ORDER IS LOAD-BEARING, AND THIS COST A BUG.
     "postponed" begins with "post". With the completed check first — and with
     an unanchored stem — a POSTPONED fight normalized to "post" and would have
     rendered on the Fight Centre as FINAL: a bout that has not happened, shown
     as finished, with a blank result underneath it. Cancelled and postponed are
     therefore matched FIRST, and the completed stems are anchored on both sides
     so "post" can never swallow a longer word again. Caught by
     supabase/tests — "normalizeStatus collapses provider vocabularies". */
  if (/cancel/.test(s)) return "canceled";
  if (/(postpone|delay|suspend)/.test(s)) return "postponed";
  if (/(^|_)(post|final|complete|completed|closed|ended|finished)(_|$)/.test(s)) return "post";
  if (/(^|_)(in|live|inprogress|in_progress|active|started)(_|$)/.test(s)) return "in";
  if (/(^|_)(pre|scheduled|upcoming|created|not_started)(_|$)/.test(s)) return "pre";
  return null;
}

/** Decision detail out of a method string. "Decision - Unanimous" -> Unanimous.
    Only ever reports what the string actually said. */
export function parseDecisionType(method: unknown, detail?: unknown): string | null {
  const s = `${String(method ?? "")} ${String(detail ?? "")}`.toLowerCase();
  if (!/decision/.test(s)) return null;
  if (/unanimous/.test(s)) return "Unanimous";
  if (/split/.test(s)) return "Split";
  if (/majority/.test(s)) return "Majority";
  if (/technical/.test(s)) return "Technical";
  return "Decision";
}

/** The snapshot dedup key.

    HASHES THE STATISTICS AND THE ROUND. DELIBERATELY NOT THE CLOCK.

    Including the clock would change the hash on every poll and the snapshot
    table would collect one identical row per tick — tens of thousands per card,
    and a timeline nobody can read. Excluding it means a row is written exactly
    when a number moves, and `captured_at` is when that new state was first
    seen. That is what makes the timeline a record of the fight changing rather
    than a record of the poller running.

    FNV-1a: no crypto import, stable across runs, and collisions here cost one
    skipped snapshot rather than a wrong number. */
export function snapshotHash(round: number | null, s: CanonicalStats): string {
  let str = `r${round ?? "-"}`;
  for (const f of STAT_FIELDS) str += `|${s[f] ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + str.length.toString(36);
}

export interface CanonicalCorner {
  corner: "red" | "blue";
  source_fighter_id: string | null;
  name: string | null;
  fighter_id?: string | null;
  stats: CanonicalStats;
  rounds: { round: number; stats: CanonicalStats; round_status: string | null }[];
  statsPartial: boolean;
}

export interface CanonicalBout {
  fight_id: string;
  source_fight_id: string | null;
  event_id: string;
  card_segment: string | null;
  fight_order: number | null;
  is_main: boolean | null;
  is_title: boolean | null;
  weight_class: string | null;
  scheduled_rounds: number | null;
  referee: string | null;
  status: string | null;
  status_detail: string | null;
  round: number | null;
  clock: string | null;
  clock_seconds: number | null;
  elapsed_seconds: number | null;
  winner_corner: string | null;
  method: string | null;
  method_detail: string | null;
  decision_type: string | null;
  end_round: number | null;
  end_time: string | null;
  red_win_prob: number | null;
  blue_win_prob: number | null;
  source_timestamp: string | null;
  corners: CanonicalCorner[];
}

export interface CanonicalEvent {
  event_id: string;
  source_event_id: string | null;
  name: string | null;
  short_name: string | null;
  status: string | null;
  status_detail: string | null;
  start_time: string | null;
  end_time: string | null;
  venue: string | null;
  location: string | null;
  source_url: string | null;
  bouts: CanonicalBout[];
}

/** Is this event worth spending API calls on right now?

    THE IDLE RULE. When no card is running, this function should do almost
    nothing — that is what keeps a poller on a short cron from burning a
    provider quota on 360 empty days a year. An event qualifies only if it is
    live, starts within the lookahead, or finished within the lookbehind (so the
    final numbers and the result get captured after the last bell). */
export function isEventInWindow(
  ev: { status?: string | null; start_time?: string | null },
  nowMs: number, lookaheadMs: number, lookbehindMs: number,
): boolean {
  const st = normalizeStatus(ev.status);
  if (st === "canceled") return false;
  const t = ev.start_time ? Date.parse(ev.start_time) : NaN;
  if (st === "in") {
    // A row stuck at "in" forever must not pin the poller to a dead event. The
    // same staleness discipline the UI already applies to live_events.
    if (!Number.isFinite(t)) return true;
    return (nowMs - t) <= lookbehindMs;
  }
  if (!Number.isFinite(t)) return false;
  const delta = t - nowMs;
  if (delta >= 0) return delta <= lookaheadMs;
  return (nowMs - t) <= lookbehindMs;
}

/** Work order within an event: the fight being fought, then the one about to
    be, then everything else in card order. Under a wall clock this is what
    decides which bouts get captured when there is not time for all of them. */
export function prioritizeBouts(bouts: CanonicalBout[]): CanonicalBout[] {
  const rank = (b: CanonicalBout) => {
    const s = normalizeStatus(b.status);
    if (s === "in") return 0;
    if (s === "pre") return 1;
    if (s === "post") return 2;
    return 3;
  };
  return [...bouts].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ao = a.fight_order ?? 999, bo = b.fight_order ?? 999;
    return ao - bo;
  });
}

/** Freshness in seconds: how old the provider says its own state is. Distinct
    from "when did we write the row", and the pair is what tells a healthy
    poller apart from one faithfully copying a frozen upstream. */
export function sourceFreshnessSeconds(sourceTs: string | null, nowMs: number): number | null {
  if (!sourceTs) return null;
  const t = Date.parse(sourceTs);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Resolve a feed athlete onto ufc.fighters.fighter_id.
    Exact normalized match only. An ambiguous name — two fighters normalizing
    identically — resolves to NOTHING, because attaching one man's career to
    another man's fight is far worse than showing "no DB history". */
export function resolveFighter(
  sourceName: string | null,
  index: Map<string, string[]>,
): { fighter_id: string | null; match_method: string; confidence: number } {
  const norm = normalizeName(sourceName);
  if (!norm) return { fighter_id: null, match_method: "unresolved", confidence: 0 };
  const hits = index.get(norm);
  if (!hits || !hits.length) return { fighter_id: null, match_method: "unresolved", confidence: 0 };
  if (hits.length > 1) return { fighter_id: null, match_method: "ambiguous", confidence: 0 };
  return { fighter_id: hits[0], match_method: "normalized", confidence: 1 };
}

/** Build the name -> fighter_id index. Collisions are KEPT as collisions so
    resolveFighter can refuse them, rather than being silently deduped into a
    confident wrong answer. */
export function buildFighterIndex(
  rows: { fighter_id: string; full_name: string }[],
): Map<string, string[]> {
  const ix = new Map<string, string[]>();
  for (const r of rows || []) {
    const n = normalizeName(r?.full_name);
    if (!n || !r?.fighter_id) continue;
    const cur = ix.get(n);
    if (cur) { if (!cur.includes(r.fighter_id)) cur.push(r.fighter_id); }
    else ix.set(n, [r.fighter_id]);
  }
  return ix;
}

/* ══════════════════════════════════════════════════════════════════════════
   PURE CORE END
   ══════════════════════════════════════════════════════════════════════════ */

/* ── configuration ──────────────────────────────────────────────────────── */
const ENV = (k: string, d = "") => {
  try { return (globalThis as any).Deno?.env?.get(k) ?? d; } catch { return d; }
};
const NUM = (k: string, d: number) => {
  const v = Number(ENV(k, ""));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const CRON_SECRET = ENV("CRON_SECRET");
const PROVIDER = (ENV("UFC_LIVE_PROVIDER", "none") || "none").toLowerCase().trim();
const PROVIDER_KEY = ENV("UFC_LIVE_API_KEY");
const PROVIDER_BASE = ENV("UFC_LIVE_BASE_URL");
const SR_ACCESS = ENV("UFC_LIVE_SPORTRADAR_ACCESS", "production");

const LOOKAHEAD_MS = NUM("UFC_LIVE_LOOKAHEAD_MIN", 240) * 60000;
const LOOKBEHIND_MS = NUM("UFC_LIVE_LOOKBEHIND_MIN", 300) * 60000;
const TIMEOUT_MS = NUM("UFC_LIVE_TIMEOUT_MS", 8000);
const RETRIES = Math.min(5, Math.max(0, Number(ENV("UFC_LIVE_RETRIES", "2")) || 0));
const CONCURRENCY = Math.max(1, Math.min(8, NUM("UFC_LIVE_CONCURRENCY", 4)));
const BUDGET_MS = NUM("UFC_LIVE_MAX_MS", 50000);
const MAX_BOUTS = NUM("UFC_LIVE_MAX_BOUTS", 16);
const MAX_EVENTS = NUM("UFC_LIVE_MAX_EVENTS", 2);
const FIGHTERS_TTL_MS = NUM("UFC_FIGHTERS_TTL_MS", 6 * 3600 * 1000);

const db = createClient(ENV("SUPABASE_URL"), ENV("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
  db: { schema: "ufc" },
});

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function authorized(req: Request): boolean {
  return CRON_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SECRET;
}

/* ══════════════════════════════════════════════════════════════════════════
   TRANSPORT CORE START
   Retry, backoff, timeout and rate-limit handling. Kept in its own marked
   region and taking its configuration as an ARGUMENT rather than reading
   module constants, so the test suite can drive it with a stubbed fetch and a
   1ms backoff instead of waiting out real seconds. A retry policy nobody can
   test is a retry policy nobody should trust.
   ══════════════════════════════════════════════════════════════════════════ */

export interface HttpCfg { timeoutMs: number; retries: number; backoffBaseMs?: number; backoffMaxMs?: number; }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const backoffMs = (attempt: number, cfg?: HttpCfg) =>
  Math.min(cfg?.backoffMaxMs ?? 4000, (cfg?.backoffBaseMs ?? 400) * Math.pow(2, attempt));

/* ── run-scoped telemetry ───────────────────────────────────────────────── */
export class Telemetry {
  events_discovered = 0; events_active = 0;
  fights_discovered = 0; fights_active = 0; fights_completed = 0;
  fighters_resolved = 0; fighters_unresolved = 0;
  round_rows_written = 0; state_rows_written = 0;
  snapshots_written = 0; snapshots_skipped_dup = 0;
  api_requests = 0; api_failures = 0; api_timeouts = 0; rate_limited = 0;
  malformed_events = 0; malformed_fights = 0; missing_stat_fields = 0;
  db_write_failures = 0;
  http_status: Record<string, number> = {};
  unmapped: Record<string, number> = {};
  write_errors: string[] = [];
  bout_errors: { fight_id: string | null; error: string }[] = [];
  provider_verified = false;
  active_event_id: string | null = null;
  active_fight_id: string | null = null;
  source_freshness_seconds: number | null = null;

  status(code: number) { const k = String(code); this.http_status[k] = (this.http_status[k] ?? 0) + 1; }
  unmappedKeys(keys: string[]) { for (const k of keys) this.unmapped[k] = (this.unmapped[k] ?? 0) + 1; }
  writeError(phase: string, e: any) {
    this.db_write_failures++;
    if (this.write_errors.length < 10) {
      this.write_errors.push(`${phase}: ${[e?.message, e?.code, e?.details, e?.hint].filter(Boolean).join(" · ")}`);
    }
  }
}

/* ── HTTP with timeout, retry, backoff and rate-limit respect ───────────── */
export async function httpGet(
  url: string, headers: Record<string, string>, t: Telemetry, cfg: HttpCfg,
): Promise<{ ok: boolean; status: number; data: any; detail: string }> {
  const RETRIES = cfg.retries, TIMEOUT_MS = cfg.timeoutMs;
  let lastStatus = 0, lastDetail = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    t.api_requests++;
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      t.status(r.status);
      if (r.ok) {
        try { return { ok: true, status: r.status, data: await r.json(), detail: "" }; }
        catch (e) {
          // 200 with a body that is not JSON is a broken source, not a retry
          // candidate — retrying costs quota and returns the same garbage.
          t.api_failures++;
          return { ok: false, status: r.status, data: null, detail: "non-JSON body: " + String((e as Error)?.message ?? e) };
        }
      }
      lastStatus = r.status;
      lastDetail = (await r.text().catch(() => "")).slice(0, 200);
      t.api_failures++;
      if (r.status === 429) {
        t.rate_limited++;
        // Honour Retry-After when the provider sends one; it knows better than
        // any backoff curve we could invent.
        const ra = Number(r.headers.get("retry-after"));
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : backoffMs(attempt, cfg);
        if (attempt < RETRIES) { await sleep(waitMs); continue; }
        return { ok: false, status: 429, data: null, detail: lastDetail };
      }
      // 4xx other than 429 will not fix itself by asking again with the same
      // credentials and the same path. Fail fast and say the status.
      if (r.status >= 400 && r.status < 500) {
        return { ok: false, status: r.status, data: null, detail: lastDetail };
      }
      if (attempt < RETRIES) { await sleep(backoffMs(attempt, cfg)); continue; }
    } catch (e) {
      clearTimeout(timer);
      const msg = String((e as Error)?.message ?? e);
      const aborted = (e as any)?.name === "AbortError";
      if (aborted) t.api_timeouts++;
      t.api_failures++;
      t.status(0);
      lastStatus = 0;
      lastDetail = aborted ? `timeout after ${TIMEOUT_MS}ms` : msg;
      if (attempt < RETRIES) { await sleep(backoffMs(attempt, cfg)); continue; }
    }
  }
  return { ok: false, status: lastStatus, data: null, detail: lastDetail };
}

/** Bounded concurrency. A card has a dozen bouts; firing a dozen simultaneous
    requests at a provider is how a poller earns a 429 and a rate-limit note in
    its contract. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   TRANSPORT CORE END
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   PROVIDER ADAPTERS

   The ONLY provider-aware code in this file. An adapter's whole job is to turn
   a provider response into CanonicalEvent[]. Everything downstream — the
   flattener, the alias map, persistence, the UI — is provider-blind.

   To add a provider: write one adapter, register it, set UFC_LIVE_PROVIDER.
   No migration, no schema change, no UI change.
   ══════════════════════════════════════════════════════════════════════════ */
interface Adapter {
  id: string;
  ready(): { ok: boolean; reason: string };
  /** Discover events and their bouts. May issue more than one request. */
  discover(t: Telemetry, nowMs: number, cfg: HttpCfg): Promise<CanonicalEvent[]>;
}

/** Shared bout assembly: given per-corner nodes, run them through the flattener
    and the alias map. Used by every adapter so normalization can never drift
    between providers. */
function buildCorner(
  corner: "red" | "blue",
  sourceId: string | null,
  name: string | null,
  totalNode: unknown,
  roundNodes: { round: number; node: unknown; status?: string | null }[],
  t: Telemetry,
): CanonicalCorner {
  const rounds: CanonicalCorner["rounds"] = [];
  for (const r of roundNodes || []) {
    const res = normalizeStatBag(flattenStatEntries(r.node));
    t.unmappedKeys(res.unmapped);
    if (res.unusable.length) t.missing_stat_fields += res.unusable.length;
    if (res.mapped > 0) {
      rounds.push({ round: r.round, stats: res.stats, round_status: r.status ?? null });
    }
  }

  let stats: CanonicalStats;
  let partial = false;
  const totalRes = totalNode != null ? normalizeStatBag(flattenStatEntries(totalNode)) : null;
  if (totalRes) {
    t.unmappedKeys(totalRes.unmapped);
    if (totalRes.unusable.length) t.missing_stat_fields += totalRes.unusable.length;
  }
  if (totalRes && totalRes.mapped > 0) {
    stats = totalRes.stats;
  } else if (rounds.length) {
    // The provider gave rounds but no total. Summing published rounds is
    // arithmetic on stored numbers, not a model — and it is flagged partial so
    // the reader knows the total was assembled rather than published.
    stats = sumRounds(rounds.map((r) => r.stats));
    partial = true;
  } else {
    stats = emptyStats();
  }

  return {
    corner, source_fighter_id: sourceId, name, stats, rounds, statsPartial: partial,
  };
}

/* ── ESPN adapter — OPTIONAL, UNVERIFIED ─────────────────────────────────
   Written against ESPN's documented public MMA shape. It has NOT been checked
   against a live response (the host was unreachable from the build
   environment), which is exactly why `provider_verified` is measured at runtime
   instead of asserted here. If this adapter parses nothing, the telemetry says
   so plainly rather than reporting an empty card.

   Not the default, and not recommended as a primary source: an unauthenticated
   endpoint with no contract can change shape without notice. */
const espnAdapter: Adapter = {
  id: "espn",
  ready() { return { ok: true, reason: "" }; },
  async discover(t, nowMs, cfg) {
    const base = PROVIDER_BASE || "https://site.api.espn.com/apis/site/v2/sports/mma/ufc";
    const sb = await httpGet(`${base}/scoreboard`, {}, t, cfg);
    if (!sb.ok) return [];
    const events: CanonicalEvent[] = [];
    for (const raw of asArray(sb.data?.events)) {
      try {
        const ev = espnEvent(raw);
        if (!ev) { t.malformed_events++; continue; }
        events.push(ev);
      } catch { t.malformed_events++; }
    }
    if (events.length) t.provider_verified = true;
    return events;
  },
};

function espnEvent(raw: any): CanonicalEvent | null {
  const id = str(raw?.id);
  if (!id) return null;
  const comp0 = asArray(raw?.competitions)[0];
  const venue = comp0?.venue ?? raw?.venue;
  const ev: CanonicalEvent = {
    event_id: `espn:${id}`,
    source_event_id: id,
    name: str(raw?.name),
    short_name: str(raw?.shortName),
    status: normalizeStatus(raw?.status?.type?.state ?? raw?.status?.type?.name),
    status_detail: str(raw?.status?.type?.detail ?? raw?.status?.type?.description),
    start_time: iso(raw?.date),
    end_time: null,
    venue: str(venue?.fullName ?? venue?.name),
    location: joinLoc(venue?.address?.city, venue?.address?.state ?? venue?.address?.country),
    source_url: str(raw?.links?.[0]?.href),
    bouts: [],
  };
  const comps = asArray(raw?.competitions);
  comps.forEach((c: any, i: number) => {
    const b = espnBout(ev.event_id, id, c, i);
    if (b) ev.bouts.push(b);
  });
  return ev;
}

function espnBout(eventId: string, srcEventId: string, c: any, idx: number): CanonicalBout | null {
  const cid = str(c?.id);
  if (!cid) return null;
  const st = normalizeStatus(c?.status?.type?.state ?? c?.status?.type?.name);
  const round = int(c?.status?.period);
  const clock = str(c?.status?.displayClock);
  const cs = parseClockSeconds(clock);
  const method = str(c?.status?.result?.description ?? c?.status?.result?.name);
  const detail = str(c?.status?.result?.shortDisplayName ?? c?.notes?.[0]?.headline);
  return {
    fight_id: `espn:${cid}`,
    source_fight_id: cid,
    event_id: eventId,
    card_segment: str(c?.cardSegment?.description ?? c?.type?.text),
    fight_order: int(c?.order) ?? idx + 1,
    is_main: bool(c?.conferenceCompetition) ?? (idx === 0 ? true : null),
    is_title: /title|championship/i.test(str(c?.note ?? c?.notes?.[0]?.headline) ?? "") || null,
    weight_class: str(c?.type?.abbreviation ?? c?.weightClass?.text ?? c?.format?.weightClass),
    scheduled_rounds: int(c?.format?.regulation?.periods),
    referee: str(asArray(c?.officials)[0]?.displayName ?? asArray(c?.officials)[0]?.fullName),
    status: st,
    status_detail: str(c?.status?.type?.detail),
    round, clock, clock_seconds: cs,
    elapsed_seconds: elapsedSeconds(round, cs),
    winner_corner: null,
    method, method_detail: detail,
    decision_type: parseDecisionType(method, detail),
    end_round: st === "post" ? round : null,
    end_time: st === "post" ? clock : null,
    red_win_prob: null, blue_win_prob: null,
    source_timestamp: null,
    corners: [],
  };
}

/* ── Sportradar MMA adapter ──────────────────────────────────────────────
   A credentialled, contractual live feed with documented live fight
   statistics, round statistics, control time and strike position data. This is
   the adapter to prefer for anything a user will read as "live".

   Also written from documentation rather than an observed payload in this
   environment. Same rule applies: provider_verified is measured, not claimed.
   Because everything goes through the shared flattener and alias map, a field
   whose spelling differs from what is assumed here surfaces in
   `unmapped_stat_keys` and is fixed by one line in STAT_ALIASES. */
const sportradarAdapter: Adapter = {
  id: "sportradar",
  ready() {
    return PROVIDER_KEY
      ? { ok: true, reason: "" }
      : { ok: false, reason: "UFC_LIVE_API_KEY is not set, so no Sportradar request can be authenticated." };
  },
  async discover(t, nowMs, cfg) {
    const base = PROVIDER_BASE || `https://api.sportradar.com/mma/${SR_ACCESS}/v2/en`;
    const h = { "x-api-key": PROVIDER_KEY, accept: "application/json" };

    // Live summaries first: during a card this is the cheapest possible read
    // and it is the only call an idle run ever makes.
    const live = await httpGet(`${base}/schedules/live/summaries.json`, h, t, cfg);
    const summaries = asArray(live.data?.summaries);
    const events = new Map<string, CanonicalEvent>();

    for (const s of summaries) {
      try {
        const built = srSummary(s, t);
        if (!built) { t.malformed_events++; continue; }
        mergeEvent(events, built);
      } catch { t.malformed_events++; }
    }
    if (events.size) t.provider_verified = true;
    return [...events.values()];
  },
};

/** Sportradar publishes one summary per sport_event (bout), each carrying its
    parent event context. Fold them back into events. */
function srSummary(s: any, t: Telemetry): CanonicalEvent | null {
  const se = s?.sport_event ?? s;
  const boutId = str(se?.id);
  if (!boutId) return null;

  const ctx = se?.sport_event_context ?? {};
  const parent = ctx?.competition ?? ctx?.season ?? {};
  const evId = str(parent?.id ?? ctx?.stage?.id) ?? `bout-parent:${boutId}`;
  const venue = se?.venue ?? {};
  const status = s?.sport_event_status ?? {};

  const ev: CanonicalEvent = {
    event_id: `sportradar:${evId}`,
    source_event_id: evId,
    name: str(parent?.name ?? ctx?.season?.name),
    short_name: null,
    status: normalizeStatus(status?.status ?? status?.match_status),
    status_detail: str(status?.match_status),
    start_time: iso(se?.start_time),
    end_time: null,
    venue: str(venue?.name),
    location: joinLoc(venue?.city_name, venue?.country_name),
    source_url: null,
    bouts: [],
  };

  const bout = srBout(ev.event_id, boutId, se, s, status, t);
  if (bout) ev.bouts.push(bout); else t.malformed_fights++;
  return ev;
}

function srBout(eventId: string, boutId: string, se: any, s: any, status: any, t: Telemetry): CanonicalBout | null {
  const competitors = asArray(se?.competitors);
  const round = int(status?.period ?? status?.current_round);
  const clock = str(status?.clock?.played ?? status?.clock ?? status?.match_time);
  const cs = parseClockSeconds(clock);
  const method = str(status?.method ?? status?.win_method);
  const st = normalizeStatus(status?.status ?? status?.match_status);

  const bout: CanonicalBout = {
    fight_id: `sportradar:${boutId}`,
    source_fight_id: boutId,
    event_id: eventId,
    card_segment: str(se?.sport_event_context?.round?.name ?? se?.card_segment),
    fight_order: int(se?.sport_event_context?.round?.number ?? se?.order),
    is_main: bool(se?.sport_event_context?.round?.main_event),
    is_title: bool(se?.title_fight ?? se?.sport_event_context?.competition?.title),
    weight_class: str(se?.sport_event_context?.category?.name ?? se?.weight_class),
    scheduled_rounds: int(se?.scheduled_rounds ?? se?.sport_event_context?.scheduled_rounds),
    referee: str(asArray(se?.sport_event_officials).find((o: any) => /referee/i.test(str(o?.type) ?? ""))?.name),
    status: st,
    status_detail: str(status?.match_status),
    round, clock, clock_seconds: cs,
    elapsed_seconds: elapsedSeconds(round, cs),
    winner_corner: null,
    method, method_detail: str(status?.method_detail),
    decision_type: parseDecisionType(method, status?.method_detail),
    end_round: st === "post" ? int(status?.final_round ?? round) : null,
    end_time: st === "post" ? str(status?.final_time ?? clock) : null,
    red_win_prob: null, blue_win_prob: null,
    source_timestamp: iso(s?.generated_at ?? se?.generated_at),
    corners: [],
  };

  // statistics.totals.competitors[] carries per-competitor totals; periods[]
  // carries the per-round split when the feed publishes one.
  const statCompetitors = asArray(s?.statistics?.totals?.competitors);
  const periods = asArray(s?.statistics?.periods);

  competitors.forEach((c: any, i: number) => {
    const cid = str(c?.id);
    const corner: "red" | "blue" = i === 0 ? "red" : "blue";
    const totals = statCompetitors.find((x: any) => str(x?.id) === cid) ?? statCompetitors[i];
    const roundNodes = periods.map((p: any) => {
      const pc = asArray(p?.competitors).find((x: any) => str(x?.id) === cid);
      return { round: int(p?.number) ?? 0, node: pc?.statistics ?? pc, status: str(p?.status) };
    }).filter((r: any) => r.round > 0 && r.node != null);
    bout.corners.push(buildCorner(corner, cid, str(c?.name), totals?.statistics ?? totals, roundNodes, t));
    if (bool(c?.winner)) bout.winner_corner = corner;
  });

  return bout;
}

function mergeEvent(map: Map<string, CanonicalEvent>, ev: CanonicalEvent) {
  const cur = map.get(ev.event_id);
  if (!cur) { map.set(ev.event_id, ev); return; }
  cur.bouts.push(...ev.bouts);
  // keep the most informative event-level values seen across summaries
  cur.name ??= ev.name; cur.venue ??= ev.venue; cur.location ??= ev.location;
  cur.start_time ??= ev.start_time;
  if (normalizeStatus(ev.status) === "in") cur.status = "in";
}

const ADAPTERS: Record<string, Adapter> = {
  espn: espnAdapter,
  sportradar: sportradarAdapter,
};

/* ── small coercions ────────────────────────────────────────────────────── */
function asArray(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function int(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}
function iso(v: unknown): string | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function joinLoc(a: unknown, b: unknown): string | null {
  const p = [str(a), str(b)].filter(Boolean);
  return p.length ? p.join(", ") : null;
}

/* ── fighter index cache ────────────────────────────────────────────────
   Module scope survives between invocations on a warm isolate, so a poller on a
   short cron does NOT re-download the fighter table every few seconds. That is
   the difference between one read per six hours and one read per tick. */
let FIGHTER_INDEX: Map<string, string[]> | null = null;
let FIGHTER_INDEX_AT = 0;

async function fighterIndex(t: Telemetry, nowMs: number): Promise<Map<string, string[]>> {
  if (FIGHTER_INDEX && (nowMs - FIGHTER_INDEX_AT) < FIGHTERS_TTL_MS) return FIGHTER_INDEX;
  try {
    const rows: { fighter_id: string; full_name: string }[] = [];
    for (let page = 0; page < 20; page++) {
      const { data, error } = await db.from("fighters")
        .select("fighter_id,full_name").range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      rows.push(...(data as any));
      if (data.length < 1000) break;
    }
    FIGHTER_INDEX = buildFighterIndex(rows);
    FIGHTER_INDEX_AT = nowMs;
  } catch (e) {
    // A fighter table we cannot read costs us the EdgeDesk id link and nothing
    // else. The live capture continues with source ids only, and the app shows
    // "no DB history" — the honest state it already has copy for.
    t.writeError("fighter_index", e);
    if (!FIGHTER_INDEX) FIGHTER_INDEX = new Map();
  }
  return FIGHTER_INDEX!;
}

/* ── persistence ────────────────────────────────────────────────────────
   Every write is independently guarded. A failed snapshot must not stop the
   state write; a failed state write must not stop the next bout. ONE BAD WRITE
   IS NOT A BAD RUN — the same rule capture applies to a bad event. */
async function persistEvent(ev: CanonicalEvent, t: Telemetry, nowIso: string, counts: {
  total: number; completed: number; active: number; current: string | null;
}) {
  try {
    const { error } = await db.from("live_event_state").upsert({
      event_id: ev.event_id, source: PROVIDER, source_event_id: ev.source_event_id,
      source_url: ev.source_url, name: ev.name, short_name: ev.short_name,
      status: ev.status, status_detail: ev.status_detail,
      start_time: ev.start_time, end_time: ev.end_time,
      venue: ev.venue, location: ev.location,
      fights_total: counts.total, fights_completed: counts.completed,
      fights_active: counts.active, current_fight_id: counts.current,
      updated_at: nowIso,
    }, { onConflict: "event_id" });
    if (error) t.writeError("event_state", error);
  } catch (e) { t.writeError("event_state", e); }
}

async function persistBout(b: CanonicalBout, t: Telemetry, nowMs: number, nowIso: string) {
  const red = b.corners.find((c) => c.corner === "red");
  const blue = b.corners.find((c) => c.corner === "blue");
  const anyStats = !!(red && !statsAreEmpty(red.stats)) || !!(blue && !statsAreEmpty(blue.stats));
  const freshness = sourceFreshnessSeconds(b.source_timestamp, nowMs);
  if (freshness != null) {
    t.source_freshness_seconds = t.source_freshness_seconds == null
      ? freshness : Math.min(t.source_freshness_seconds, freshness);
  }

  try {
    const { error } = await db.from("live_fight_state").upsert({
      fight_id: b.fight_id, event_id: b.event_id,
      source: PROVIDER, source_event_id: b.event_id, source_fight_id: b.source_fight_id,
      card_segment: b.card_segment, fight_order: b.fight_order,
      is_main: b.is_main, is_title: b.is_title,
      weight_class: b.weight_class, scheduled_rounds: b.scheduled_rounds, referee: b.referee,
      status: b.status, status_detail: b.status_detail,
      round: b.round, clock: b.clock, clock_seconds: b.clock_seconds,
      elapsed_seconds: b.elapsed_seconds,
      source_timestamp: b.source_timestamp, source_freshness_seconds: freshness,
      red_fighter_id: red?.fighter_id ?? null, red_name: red?.name ?? null,
      red_source_id: red?.source_fighter_id ?? null,
      blue_fighter_id: blue?.fighter_id ?? null, blue_name: blue?.name ?? null,
      blue_source_id: blue?.source_fighter_id ?? null,
      winner_corner: b.winner_corner,
      winner_fighter_id: b.winner_corner === "red" ? (red?.fighter_id ?? null)
        : b.winner_corner === "blue" ? (blue?.fighter_id ?? null) : null,
      method: b.method, method_detail: b.method_detail, decision_type: b.decision_type,
      end_round: b.end_round, end_time: b.end_time,
      // red_win_prob / blue_win_prob are written ONLY from a provider value and
      // are omitted entirely when there is none, so a run that cannot see a
      // probability never overwrites one another poller stored.
      ...(b.red_win_prob != null ? { red_win_prob: b.red_win_prob } : {}),
      ...(b.blue_win_prob != null ? { blue_win_prob: b.blue_win_prob } : {}),
      stats_available: anyStats,
      ...(anyStats ? { last_stat_change_at: nowIso } : {}),
      updated_at: nowIso,
    }, { onConflict: "fight_id" });
    if (error) t.writeError("fight_state", error);
    else t.state_rows_written++;
  } catch (e) { t.writeError("fight_state", e); }

  for (const c of b.corners) {
    try { await persistCorner(b, c, t, nowIso); }
    catch (e) { t.writeError("corner", e); }
  }
}

async function persistCorner(b: CanonicalBout, c: CanonicalCorner, t: Telemetry, nowIso: string) {
  const rows: any[] = [];
  const base = {
    fight_id: b.fight_id, corner: c.corner,
    fighter_id: c.fighter_id ?? null, source_fighter_id: c.source_fighter_id,
    source: PROVIDER, source_timestamp: b.source_timestamp, updated_at: nowIso,
  };
  // round 0 = fight total
  if (!statsAreEmpty(c.stats)) {
    rows.push({ ...base, round: 0, is_cumulative: true, round_status: b.status, ...c.stats });
  }
  for (const r of c.rounds) {
    if (statsAreEmpty(r.stats)) continue;
    if (!Number.isFinite(r.round) || r.round < 1 || r.round > 12) continue;   // the CHECK would reject it anyway
    rows.push({ ...base, round: r.round, is_cumulative: false, round_status: r.round_status, ...r.stats });
  }
  if (!rows.length) return;

  try {
    const { error } = await db.from("live_fight_round_stats")
      .upsert(rows, { onConflict: "fight_id,corner,round" });
    if (error) t.writeError("round_stats", error);
    else t.round_rows_written += rows.length;
  } catch (e) { t.writeError("round_stats", e); }

  // SNAPSHOT — cumulative totals only, deduplicated by content hash.
  if (statsAreEmpty(c.stats)) return;
  const hash = snapshotHash(b.round, c.stats);
  try {
    const { error, count } = await db.from("live_fight_snapshots").upsert([{
      fight_id: b.fight_id, corner: c.corner, round: b.round ?? 0,
      clock: b.clock, clock_seconds: b.clock_seconds, elapsed_seconds: b.elapsed_seconds,
      status: b.status, fighter_id: c.fighter_id ?? null,
      source_fighter_id: c.source_fighter_id, source: PROVIDER,
      source_timestamp: b.source_timestamp, content_hash: hash,
      ...c.stats,
    }], { onConflict: "fight_id,corner,round,content_hash", ignoreDuplicates: true, count: "exact" });
    if (error) { t.writeError("snapshot", error); return; }
    // count is rows actually inserted: 0 means this exact state was already on
    // record, which is a successful skip and is reported as one.
    if (count && count > 0) t.snapshots_written += count;
    else t.snapshots_skipped_dup++;
  } catch (e) { t.writeError("snapshot", e); }
}

async function persistFighterMap(c: CanonicalCorner, method: string, confidence: number, t: Telemetry, nowIso: string) {
  if (!c.source_fighter_id) return;
  try {
    const { error } = await db.from("fighter_source_map").upsert({
      source: PROVIDER, source_fighter_id: c.source_fighter_id,
      fighter_id: c.fighter_id ?? null, source_name: c.name,
      normalized_name: normalizeName(c.name), match_method: method,
      confidence, updated_at: nowIso,
    }, { onConflict: "source,source_fighter_id" });
    if (error) t.writeError("fighter_map", error);
  } catch (e) { t.writeError("fighter_map", e); }
}

/* ── the handler ────────────────────────────────────────────────────────── */
export async function handle(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const diag = url.searchParams.get("diag") === "1";
  const elapsed = () => Date.now() - startedAt;
  const outOfTime = () => elapsed() > BUDGET_MS;
  const t = new Telemetry();

  if (!authorized(req)) {
    return json({
      ok: false, build: BUILD, error: "unauthorized",
      reason: CRON_SECRET === ""
        ? "CRON_SECRET is not set on this function, so every caller is rejected including the scheduler. "
          + "Set CRON_SECRET and have the cron send a matching x-cron-secret header."
        : "the x-cron-secret header did not match CRON_SECRET.",
    }, 401);
  }
  if (!ENV("SUPABASE_URL") || !ENV("SUPABASE_SERVICE_ROLE_KEY")) {
    return json({
      ok: false, build: BUILD, error: "supabase credentials missing",
      reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so nothing could be written. Nothing was attempted.",
    }, 500);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  /* NO PROVIDER IS A STATE, NOT A FAILURE. It is reported as its own status so
     "you have not configured a live source" can never be mistaken for "the live
     source is down" — two words apart on a screen, two completely different
     things to go and do. */
  const adapter = ADAPTERS[PROVIDER];
  if (!adapter) {
    const body = {
      ok: true, status: "unconfigured", build: BUILD, provider: PROVIDER,
      note: PROVIDER === "none"
        ? "No live UFC provider is configured. Set UFC_LIVE_PROVIDER to one of: "
          + Object.keys(ADAPTERS).join(", ") + ". Nothing was fetched and nothing was written."
        : `UFC_LIVE_PROVIDER="${PROVIDER}" does not match any registered adapter (`
          + Object.keys(ADAPTERS).join(", ") + ").",
      elapsed_ms: elapsed(),
    };
    await writeRun(t, { ...body, mode: "idle" }, startedAt, nowIso);
    return json(body, 200);
  }
  const ready = adapter.ready();
  if (!ready.ok) {
    const body = {
      ok: false, status: "unconfigured", build: BUILD, provider: PROVIDER,
      error: "provider not ready", reason: ready.reason, elapsed_ms: elapsed(),
    };
    await writeRun(t, { ...body, mode: "idle" }, startedAt, nowIso);
    return json(body, 500);
  }

  /* ---- DISCOVER ---- */
  let events: CanonicalEvent[] = [];
  try {
    events = await adapter.discover(t, nowMs, { timeoutMs: TIMEOUT_MS, retries: RETRIES });
  } catch (e) {
    const body = {
      ok: false, status: "failed", build: BUILD, provider: PROVIDER,
      error: "provider discovery threw", detail: String((e as Error)?.message ?? e),
      api_requests: t.api_requests, api_failures: t.api_failures,
      http_status_counts: t.http_status, elapsed_ms: elapsed(),
    };
    await writeRun(t, { ...body, mode: "active" }, startedAt, nowIso);
    return json(body, 500);
  }
  t.events_discovered = events.length;

  const active = events
    .filter((e) => isEventInWindow(e, nowMs, LOOKAHEAD_MS, LOOKBEHIND_MS))
    .slice(0, MAX_EVENTS);
  t.events_active = active.length;

  /* ---- IDLE: no card in the window, so do nothing else ---- */
  if (!active.length) {
    const body = {
      ok: true, status: "idle", build: BUILD, provider: PROVIDER,
      provider_verified: t.provider_verified,
      events_discovered: t.events_discovered, events_active: 0,
      note: t.events_discovered === 0
        ? (t.api_failures > 0
            ? "The provider returned no events AND requests failed — see http_status_counts. This is a source problem, not a quiet night."
            : "The provider returned no events at all. If a card is running, the adapter is not parsing the response: check provider_verified.")
        : `${t.events_discovered} event(s) returned, none within the capture window `
          + `(${LOOKAHEAD_MS / 60000}m ahead / ${LOOKBEHIND_MS / 60000}m behind). Nothing to capture right now.`,
      api_requests: t.api_requests, api_failures: t.api_failures,
      http_status_counts: t.http_status, elapsed_ms: elapsed(),
    };
    await writeRun(t, { ...body, mode: "idle" }, startedAt, nowIso);
    return json(body, 200);
  }

  const ix = diag ? new Map<string, string[]>() : await fighterIndex(t, nowMs);
  const skippedForTime: string[] = [];

  for (const ev of active) {
    if (outOfTime()) { skippedForTime.push(ev.event_id); continue; }

    const bouts = prioritizeBouts(ev.bouts).slice(0, MAX_BOUTS);
    t.fights_discovered += ev.bouts.length;

    let completed = 0, activeN = 0, current: string | null = null;
    for (const b of bouts) {
      const s = normalizeStatus(b.status);
      if (s === "post") completed++;
      if (s === "in") { activeN++; if (!current) current = b.fight_id; }
    }
    t.fights_active += activeN;
    t.fights_completed += completed;
    if (!t.active_event_id && activeN > 0) t.active_event_id = ev.event_id;
    if (!t.active_fight_id && current) t.active_fight_id = current;

    /* resolve fighters (cheap, in-memory) before persistence */
    for (const b of bouts) {
      for (const c of b.corners) {
        const r = resolveFighter(c.name, ix);
        c.fighter_id = r.fighter_id;
        if (r.fighter_id) t.fighters_resolved++; else t.fighters_unresolved++;
      }
    }

    if (diag) continue;   // diagnostics never write

    await persistEvent(ev, t, nowIso, {
      total: ev.bouts.length, completed, active: activeN, current,
    });

    /* ONE BAD BOUT IS NOT A BAD RUN. Each bout persists inside its own catch, so
       a malformed fight, a missing corner or a rejected row costs exactly that
       bout and the rest of the card still lands. */
    await mapLimit(bouts, CONCURRENCY, async (b) => {
      if (outOfTime()) return;
      try {
        await persistBout(b, t, nowMs, nowIso);
        for (const c of b.corners) {
          await persistFighterMap(c, c.fighter_id ? "normalized" : "unresolved", c.fighter_id ? 1 : 0, t, nowIso);
        }
      } catch (e) {
        t.malformed_fights++;
        if (t.bout_errors.length < 8) {
          t.bout_errors.push({ fight_id: b?.fight_id ?? null, error: String((e as Error)?.message ?? e) });
        }
      }
    });
  }

  const status = diag ? "diagnostic"
    : (t.db_write_failures || t.malformed_fights || t.malformed_events || t.api_failures || skippedForTime.length)
      ? "partial" : "ok";

  const body: any = {
    ok: true, status, build: BUILD, provider: PROVIDER,
    /* MEASURED, NOT CLAIMED. True only when the adapter actually parsed usable
       events out of a real response this run. An adapter that matches nothing
       reports false, which is how "the shape changed" is told apart from
       "there are no fights tonight". */
    provider_verified: t.provider_verified,
    mode: diag ? "diagnostic" : "active",
    ...(diag ? { note: "Discovery and normalization ran. NOTHING was written.", persistence: "skipped_intentionally" } : {}),

    events_discovered: t.events_discovered, events_active: t.events_active,
    fights_discovered: t.fights_discovered, fights_active: t.fights_active,
    fights_completed: t.fights_completed,
    active_event_id: t.active_event_id, active_fight_id: t.active_fight_id,

    fighters_resolved: t.fighters_resolved, fighters_unresolved: t.fighters_unresolved,
    state_rows_written: t.state_rows_written,
    round_rows_written: t.round_rows_written,
    snapshots_written: t.snapshots_written,
    snapshots_skipped_duplicate: t.snapshots_skipped_dup,

    api_requests: t.api_requests, api_failures: t.api_failures,
    api_timeouts: t.api_timeouts, rate_limited: t.rate_limited,
    http_status_counts: t.http_status,
    source_freshness_seconds: t.source_freshness_seconds,

    ...(t.malformed_events ? { malformed_events: t.malformed_events } : {}),
    ...(t.malformed_fights ? { malformed_fights: t.malformed_fights, bout_errors: t.bout_errors } : {}),
    ...(t.missing_stat_fields ? { unusable_stat_values: t.missing_stat_fields } : {}),
    /* THE MOST ACTIONABLE FIELD HERE. Source keys the alias map does not know.
       A provider renaming "sig_strikes" shows up here as a name nobody has
       mapped, instead of silently becoming an empty column on the Fight
       Centre. Fix is one line in STAT_ALIASES. */
    ...(Object.keys(t.unmapped).length ? { unmapped_stat_keys: topN(t.unmapped, 25) } : {}),
    ...(t.db_write_failures ? { db_write_failures: t.db_write_failures, write_errors: t.write_errors } : {}),
    ...(skippedForTime.length ? { events_skipped_for_time: skippedForTime } : {}),

    elapsed_ms: elapsed(), budget_ms: BUDGET_MS,
  };

  await writeRun(t, body, startedAt, nowIso, diag);
  console.log(diag ? "UFC_LIVE_STATS DIAG" : "UFC_LIVE_STATS", JSON.stringify(body));
  return json(body, 200);
}

function topN(m: Record<string, number>, n: number): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));
}

/** Telemetry is written LAST and in its own try/catch, because a run whose only
    failure is that it could not record itself has still done its actual job.
    Diagnostics never write. */
async function writeRun(t: Telemetry, body: any, startedAt: number, nowIso: string, diag = false) {
  if (diag) return;
  try {
    await db.from("live_capture_runs").insert({
      build: BUILD, mode: body.mode ?? "active", ok: !!body.ok, status: body.status ?? null,
      provider: PROVIDER, provider_verified: t.provider_verified,
      started_at: new Date(startedAt).toISOString(),
      finished_at: nowIso, duration_ms: Date.now() - startedAt,
      events_discovered: t.events_discovered, events_active: t.events_active,
      fights_discovered: t.fights_discovered, fights_active: t.fights_active,
      fights_completed: t.fights_completed,
      fighters_resolved: t.fighters_resolved, fighters_unresolved: t.fighters_unresolved,
      round_rows_written: t.round_rows_written, state_rows_written: t.state_rows_written,
      snapshots_written: t.snapshots_written, snapshots_skipped_dup: t.snapshots_skipped_dup,
      api_requests: t.api_requests, api_failures: t.api_failures,
      api_timeouts: t.api_timeouts, rate_limited: t.rate_limited,
      http_status_counts: t.http_status,
      malformed_events: t.malformed_events, malformed_fights: t.malformed_fights,
      missing_stat_fields: t.missing_stat_fields,
      unmapped_stat_keys: topN(t.unmapped, 40),
      db_write_failures: t.db_write_failures,
      write_errors: t.write_errors.length ? t.write_errors : null,
      active_event_id: t.active_event_id, active_fight_id: t.active_fight_id,
      source_freshness_seconds: t.source_freshness_seconds,
      error: body.error ?? null,
      detail: body.reason ? { reason: body.reason } : null,
    });
  } catch (_) { /* telemetry must never be the thing that fails a run */ }
}

/* Guarded so the test suite can import the pure core without starting a
   server. Production sets nothing and this runs exactly as normal. */
if (!ENV("UFC_LIVE_STATS_NO_SERVE")) {
  (globalThis as any).Deno?.serve?.(handle);
}
