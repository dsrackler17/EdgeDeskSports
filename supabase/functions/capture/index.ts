// ============================================================
//  FILE:    supabase/functions/capture/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy capture --no-verify-jwt
//  BUILD:   capture-v9-qualified   (authoritative value: `export const BUILD` below)
//  IMPORTS: NONE. Not one. See "WHY THIS FILE HAS NO IMPORTS" below.
//  TESTS:   node tools/capture/capture.test.js   (imports THIS file, no network)
// ============================================================
//
// CAPTURE prices the board for the configured sports and writes one durable row
// per (event, market, selection, point) into `signals`. It then decides, for each
// row, whether EdgeDesk is willing to put its name on the price.
//
// ═════════════════════════════════════════════════════════════════════════════
// v9 — WHY "SHARP" WAS NOT SHARP, AND WHAT REPLACES IT
//
// THE ROOT CAUSE
//   v8 shipped with CAPTURE_REGIONS defaulting to `us` and SHARP_BOOK defaulting
//   to `pinnacle`. Pinnacle is not a US-licensed book and is not returned by the
//   Odds API `us` region. So `s.sharp` was null on every selection of every
//   event of every run, and this line
//
//       const sharp = s.sharp ?? cons;          // v8, priceEvent()
//
//   silently substituted the multi-book consensus. `sharp_fair` — a column named
//   after a claim — held the median of the same books the edge was measured
//   against, and `flaggable()` never required has_sharp, so the substitution was
//   invisible at the only place it mattered. Every "sharp-anchored" signal
//   EdgeDesk has ever flagged under a us-only region was consensus wearing the
//   word sharp.
//
//   Worse, the consensus median INCLUDED the book offering the best price. On a
//   two-book market the median of two fairs is their mean, so the book being
//   tested supplied half of the number it was tested against. A soft line proved
//   its own value.
//
// WHAT REPLACES IT — AN EXPLICIT REFERENCE HIERARCHY
//   There is now one function, `qualifySignal()`, and it returns a TIER:
//
//     TIER A — sharp anchored.  An approved reference book (Pinnacle by default)
//              quoted THIS event, THIS market, THIS selection, at THIS EXACT
//              POINT, on a usable two-sided market, with a fresh quote, against
//              a fresh best price and enough fresh corroborating books.
//     TIER B — robust consensus.  No approved reference book. Never called sharp.
//              Requires materially more evidence: more fresh books, more
//              INDEPENDENT operator families, low dispersion, no outlier, and a
//              trimmed consensus computed with the best-price book REMOVED so a
//              book can never help set the fair value it is then measured against.
//     PASS   — insufficient evidence. The row is STORED with its reason. It is
//              never flagged, never actionable, and never reaches a user as an
//              Edge.
//
//   `reference_type` ('sharp' | 'robust_consensus' | 'none') is written on every
//   row. `has_sharp` is now true ONLY when a real approved reference book was
//   present AND fresh. It can no longer be satisfied by a median.
//
// ═════════════════════════════════════════════════════════════════════════════
// v9 — THE FIVE OTHER THINGS THAT WERE WRONG
//
//   1. NO FRESHNESS. v8 never read `last_update`. Five books quoting a line is
//      not five-book consensus when three of them last moved four hours ago.
//      Every quote now carries `quote_age_seconds`, every count of "books" is a
//      count of FRESH books, and the freshness limit varies by sport, market and
//      time-to-kickoff, because a college football line 60 hours out legitimately
//      sits still for hours while an NFL total 20 minutes out does not.
//
//   2. THE OUTLIER CHECK LIVED IN DECIMAL SPACE. `best_dec / median_dec <= 1.35`
//      is two different rules depending on price. At 1.90 it permits a best price
//      of 2.56 — a 13-point probability gap, which is not a soft line, it is a
//      broken feed. At 10.0 it rejects 13.6, which is ordinary longshot
//      disagreement. Outlier detection is now done in PROBABILITY space, where
//      the two cases separate correctly, with a decimal-ratio backstop kept only
//      for the catastrophic 12.0-vs-1.90 case.
//
//   3. ONE EDGE FLOOR FOR EVERYTHING. 0.5% is smaller than the devig error on a
//      three-way market, smaller than the movement between two capture cycles,
//      and smaller than the spread between two reasonable devig methods. Floors
//      are now segmented by sport × market × tier, and a segment EdgeDesk cannot
//      justify is allowed to have no actionable signals at all.
//
//   4. `flag_frozen` COUNTED THINGS THAT WERE NOT FROZEN. v8 counted every UPDATE
//      that did not error. The update is guarded on `flagged_at IS NULL`, so an
//      already-flagged row matches nothing and still returned success — the
//      number reported as "signals that entered the record this run" was really
//      "PATCH requests that did not 500". It now counts rows the database
//      actually returned.
//
//   5. A PHASE-A FAILURE PERMANENTLY DESTROYED THE OPENING SNAPSHOT. Phase B
//      omits every first_* column so it can never overwrite one. But phase B is
//      an UPSERT: when phase A had failed and the row did not exist, phase B
//      INSERTED it with every first_* column NULL — and because phase A uses
//      ignore-duplicates, no later run could ever fill them. Phase B now runs
//      only for sig_keys phase A confirmed exist.
//
// ═════════════════════════════════════════════════════════════════════════════
// PRESERVED FROM v5-v8. Do not "simplify" these away; each is a specific outage.
//   - Two-phase write so the opening snapshot is never overwritten.
//   - Phase C freezes the flagged entry once, guarded on flagged_at IS NULL.
//   - Exchange lay quotes are stored, never flagged.
//   - One quote per book per selection (a duplicated line is not two opinions).
//   - Malformed events are isolated: one bad event costs one event.
//   - `outcomes` guarded, prices coerced and checked with Number.isFinite.
//   - Hard failure on a missing API key, a missing sport list, a 401 loop, and
//     on a run that captured nothing. A run that captured nothing is never ok.
//   - Per-sport HTTP status on failure (401 / 422 / 429 need different fixes).
//   - Wall-clock budget: stop cleanly and say what was skipped.
//   - Bounded-concurrency flag writes.
//   - Duplicate sig_key protection before the write.
//   - Tick history, on by default, with its errors checked.
//   - Rejection counts by reason, so "quiet slate" and "capture rejected
//     everything" can never look the same.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE HAS NO IMPORTS
//
//   The Supabase dashboard bundles ONLY the folder of the function being edited.
//   A relative import that cannot resolve fails the bundle, the deploy is
//   rejected, and THE PREVIOUS VERSION KEEPS SERVING — indistinguishable from a
//   deploy that worked and changed nothing.
//
//   v8 imported `createClient` from esm.sh. That was one remote fetch away from
//   the same failure, and it also made this file impossible to unit-test: Node's
//   native type stripping cannot resolve an https import, so the single most
//   consequential function in EdgeDesk had no test that ran anywhere. It is
//   replaced below by ~40 lines of PostgREST over `fetch`, which is all the
//   client was ever used for here. The function now imports nothing, and
//   tools/capture/capture.test.js imports THIS FILE — not a copy — and runs it
//   against a mocked network, exactly as tools/presentation/edgedesk_ai.test.js
//   already does for edgedesk_ai.
//
//   sigKey() especially must not drift: it builds the primary key of `signals`,
//   and one character of change would make every row a NEW signal instead of an
//   update to an existing one, resetting the opening snapshot on the whole board.
// ═════════════════════════════════════════════════════════════════════════════

export const BUILD = "capture-v9-qualified";

/* Bumped whenever the QUALIFICATION RULES change, independently of BUILD. It is
   written to `flagged_policy` on every freeze so the record can segment its
   results by the policy that produced them. A backtest that mixes policies is
   measuring an average of two systems and calling it one. */
export const POLICY_VERSION = "qual-2026.09.1";

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — CONFIGURATION
//
// Every tunable is read through defaultConfig(envGet) and passed EXPLICITLY into
// the pure functions. Nothing reads Deno.env below this block. That is what lets
// a test construct a config object directly and assert on a policy without
// setting process-wide state, and it is why the adversarial suite can prove that
// a quote exactly at the freshness limit is accepted and one second past it is
// not.
// ═══════════════════════════════════════════════════════════════════════════

export type EnvGet = (k: string) => string | undefined;

/** Sport family. Football is not "a sport" here — NFL and college football have
    different liquidity, different book coverage and different update cadence,
    and every policy below is allowed to distinguish them. */
export function sportGroup(sportKey: string): string {
  const s = String(sportKey ?? "").toLowerCase();
  if (s.startsWith("americanfootball_nfl")) return "nfl";
  if (s.startsWith("americanfootball_ncaaf")) return "ncaaf";
  if (s.startsWith("americanfootball_")) return "football_other";
  return "other";
}

/** Resolve a policy value by ${group}|${market}, then ${group}|*, then *|${market},
    then *|*. Written out rather than clever so a wrong lookup is visible. */
export function policyLookup<T>(table: Record<string, T>, group: string, market: string): T | undefined {
  const keys = [`${group}|${market}`, `${group}|*`, `*|${market}`, `*|*`];
  for (const k of keys) if (table[k] !== undefined) return table[k];
  return undefined;
}

/* ── DEVIG POLICY ────────────────────────────────────────────────────────────
   Shin everywhere, which is exactly what v8 did. This is NOT a claim that Shin
   is optimal — it is the refusal to make a claim without evidence.

   The infrastructure to answer the question properly is in
   tools/capture/backtest.js, which reports Brier score, log loss and calibration
   error per (sport, market, price band, time-to-start bucket) for shin,
   multiplicative and power over chronological walk-forward folds. When that
   report says a segment calibrates better under another method, put it in this
   table and record the fold results that justified it in the commit message.
   Until then a per-sport devig table would be decoration. */
export const DEVIG_POLICY: Record<string, string> = {
  "*|*": "shin",
};

/* ── FRESHNESS POLICY (seconds) ──────────────────────────────────────────────
   How old a quote may be and still count toward an ACTIONABLE decision.

   Bucketed by time to kickoff, because the same age means different things at
   different distances. An NFL total 20 minutes from kickoff that has not moved
   in 15 minutes is a book that has stopped updating; a college football spread
   60 hours out that has not moved in 90 minutes is a normal Tuesday.

   These are PRIORS chosen from how markets behave, not fitted numbers. The
   backtest harness reports actionable-signal CLV bucketed by reference quote age
   so they can be replaced with measured ones. Stale quotes are still STORED —
   freshness gates the decision, never the data. */
export const FRESHNESS_BUCKETS: { name: string; maxHoursToStart: number }[] = [
  { name: "imminent", maxHoursToStart: 0.5 },
  { name: "close", maxHoursToStart: 2 },
  { name: "soon", maxHoursToStart: 6 },
  { name: "day", maxHoursToStart: 24 },
  { name: "far", maxHoursToStart: 72 },
  { name: "deep", maxHoursToStart: Infinity },
];

export const FRESHNESS_POLICY: Record<string, Record<string, number>> = {
  "nfl|*": { imminent: 240, close: 600, soon: 1800, day: 3600, far: 7200, deep: 14400 },
  "ncaaf|*": { imminent: 300, close: 900, soon: 2700, day: 5400, far: 10800, deep: 21600 },
  "*|*": { imminent: 300, close: 900, soon: 2400, day: 4800, far: 9600, deep: 19200 },
};

/* ── EDGE FLOORS ─────────────────────────────────────────────────────────────
   The minimum edge a segment must show before EdgeDesk will call it actionable,
   by sport × market × tier.

   0.5% — v8's single floor for everything — is smaller than the disagreement
   between two devig methods on the same price, smaller than the movement between
   two capture cycles, and smaller than the error in a devigged three-way market.
   A 0.5% "edge" is a rounding artefact with a plus sign.

   Tier B floors sit ~1 point above Tier A for the same segment because Tier B
   has no independent reference: the number being beaten is derived from the same
   population of retail books that produced the price, so the same nominal edge
   carries less information. NCAAF sits above NFL because the market is thinner,
   moves later and is quoted by fewer books.

   PRIORS, not fitted. tools/capture/backtest.js sweeps this table on
   chronological walk-forward folds and reports ROI, CLV and win rate with
   confidence intervals per segment. A segment where the honest answer is "no
   demonstrated advantage" is allowed to have NO actionable floor at all — set it
   to `null` and the segment produces no signals. That is a supported outcome,
   not a failure. */
export const EDGE_FLOOR: Record<string, number | null> = {
  "nfl|spreads|A": 0.015, "nfl|spreads|B": 0.025,
  "nfl|totals|A": 0.015, "nfl|totals|B": 0.025,
  "nfl|h2h|A": 0.020, "nfl|h2h|B": 0.030,
  "ncaaf|spreads|A": 0.020, "ncaaf|spreads|B": 0.030,
  "ncaaf|totals|A": 0.020, "ncaaf|totals|B": 0.030,
  "ncaaf|h2h|A": 0.025, "ncaaf|h2h|B": 0.035,
  "*|spreads|A": 0.020, "*|spreads|B": 0.030,
  "*|totals|A": 0.020, "*|totals|B": 0.030,
  "*|h2h|A": 0.025, "*|h2h|B": 0.035,
  "*|*|A": 0.025, "*|*|B": 0.035,
};

/* The ceiling above which an edge is evidence of a broken price rather than an
   opportunity, by market. Segmented because the markets are shaped differently:
   spreads and totals cluster around even money, so a 12% edge there is a bad
   quote with near-certainty, while a genuine moneyline dog can be mispriced by
   more without anything being broken. */
export const EDGE_SANE_MAX: Record<string, number> = {
  "*|spreads": 0.10, "*|totals": 0.10, "*|h2h": 0.20, "*|*": 0.25,
};

/* Minimum FRESH books, and minimum independent operator families, per tier.
   Tier B's bar is deliberately much higher: it is the whole reason Tier B is
   allowed to exist without a reference book. */
export const BOOK_REQUIREMENTS: Record<string, { A: { books: number; families: number }; B: { books: number; families: number } }> = {
  "ncaaf|*": { A: { books: 3, families: 3 }, B: { books: 5, families: 4 } },
  "*|*": { A: { books: 3, families: 3 }, B: { books: 4, families: 3 } },
};

/* Maximum dispersion of the devigged fair probabilities across fresh books
   before the "consensus" is not one. Median absolute deviation, in probability
   points. Tier B only — Tier A has an independent anchor and does not need the
   pack to agree with itself. */
export const MAX_DISPERSION: Record<string, number> = {
  "*|h2h": 0.030,
  "*|*": 0.020,
};

/* How many consecutive capture cycles a candidate must qualify before it becomes
   actionable.

   A = 1 (act on the first sighting). An independent sharp reference IS the
   corroboration; making a Pinnacle-anchored edge wait a cycle mostly guarantees
   the price is gone.

   B = 2. This is a PRIOR with a stated reason, not a fitted number: Tier B has
   no independent reference, so a single snapshot of a consensus is the only
   evidence there is, and requiring the same mispricing to survive one full
   capture cycle is the cheapest available guard against a transient bad quote.
   tools/capture/backtest.js evaluates 1, 2 and 3 per segment against CLV and
   ROI; when it has an answer, this table is where it goes. */
export const CONFIRMATIONS: Record<string, { A: number; B: number }> = {
  "*|*": { A: 1, B: 2 },
};

/* ── BOOKS ───────────────────────────────────────────────────────────────────
   Two separate facts about a book, deliberately kept apart:

   FAMILY is a STRUCTURAL fact — who operates it. Two brands on one trading desk
   are one opinion however many rows the feed sends, and `n_books_eff` (which
   app.html already reads and which nothing has ever written) is the count of
   families. Only families that are actually one operator are listed; anything
   unlisted is its own family, because wrongly merging two independent books is a
   worse error than failing to merge two related ones.

   TIER is a coverage fact, not a performance claim. It records what kind of book
   this is — a low-margin reference market, a US retail major, an offshore book,
   an exchange — and nothing here asserts that any of them predicts outcomes.
   Phase 6 of the brief asks for lead/lag and closing-accuracy scores learned from
   history and then frozen; those are DATA, they cannot be invented in a source
   file, and the schema for them (`book_quality`, see the migration) is created
   empty and read at runtime if present. Shipping a made-up `lead_lag_score`
   would be exactly the kind of decorative number this overhaul exists to remove. */
export const BOOK_FAMILY: Record<string, string> = {
  betonlineag: "betonline",
  lowvig: "betonline",
  caesars: "caesars",
  williamhill_us: "caesars",
  bovada: "bodog",
  bodog: "bodog",
};

export const BOOK_TIER: Record<string, string> = {
  pinnacle: "reference",
  circasports: "reference",
  betonlineag: "reference",
  lowvig: "reference",
  draftkings: "major", fanduel: "major", betmgm: "major", caesars: "major",
  williamhill_us: "major", betrivers: "major", espnbet: "major",
  hardrockbet: "major", fanatics: "major", superbook: "major",
  bovada: "offshore", betus: "offshore", mybookieag: "offshore", betanysports: "offshore",
  novig: "exchange", prophetx: "exchange", matchbook: "exchange",
};

export function bookFamily(key: string, overrides?: Record<string, string>): string {
  const k = String(key ?? "").toLowerCase();
  if (overrides && overrides[k]) return overrides[k];
  return BOOK_FAMILY[k] ?? k;
}
export function bookTier(key: string): string {
  return BOOK_TIER[String(key ?? "").toLowerCase()] ?? "standard";
}

/* Football key numbers. A half point either side of one of these is not noise:
   in the NFL roughly 15% of games land exactly on 3 and 9% on 7, so moving a
   spread from 2.5 to 3 changes the bet in a way moving 4 to 4.5 does not.

   Nothing here adjusts a probability. Manufacturing a key-number probability
   bump without historical support is precisely the kind of invention the brief
   forbids. What this does is EXPOSE the crossing correctly — `key_numbers_crossed`
   is stored on the row and reported in telemetry — so downstream research can
   use it and the backtest can measure whether it is worth anything. */
export const KEY_NUMBERS: Record<string, number[]> = {
  nfl: [3, 6, 7, 10, 14],
  ncaaf: [3, 6, 7, 10, 14],
};

/* Real, but second order. Roughly 4-5% of NFL games each, against ~15% for 3 and
   ~9% for 7. Kept separate and OFF by default so that `keyNumbersCrossed` answers
   the question people actually mean — "did this move touch a number that matters"
   — rather than firing on almost every half-point move and becoming noise. The
   ordering here is from published margin-of-victory frequencies; nothing in this
   file fits it, and nothing in this file turns it into a probability. */
export const KEY_NUMBERS_MINOR: Record<string, number[]> = {
  nfl: [1, 2, 4, 8, 11, 13, 17, 20, 21, 24],
  ncaaf: [1, 2, 4, 8, 11, 13, 17, 18, 21, 24, 28],
};

export interface Config {
  regions: string;
  bookmakers: string[];
  markets: string;
  sportsEnv: string;
  autoPrefixes: string[];
  referenceBooks: string[];
  ticks: boolean;
  bookQuotes: boolean;
  flagMax: number;
  flagConcurrency: number;
  budgetMs: number;
  minDec: number;
  maxDec: number;
  /** Absolute probability points the best price may sit below the pack median
      before it is a broken feed rather than a generous book. */
  maxAbsProbDev: number;
  /** The best price's implied probability, as a fraction of the pack median's.
      Catches the long-odds case where the absolute gap stays small but the price
      has doubled: 20.0 against a pack median of 10.0 is 0.50 and is refused. */
  minProbRatio: number;
  /** Robust z-score against the median absolute deviation of the pack, applied
      only when there are enough books for a MAD to mean anything. */
  maxMadZ: number;
  /** Decimal-ratio backstop, kept from v8 for the catastrophic case. Loosened
      from 1.35 because probability space is now the primary and stricter test,
      and 1.35 in decimal space wrongly refused ordinary longshot disagreement. */
  maxBestVsMedianDec: number;
  /** Minimum minutes to kickoff. A signal inside this window is not research,
      it is a race with the clock. */
  minMinutesToStart: number;
  /* Only spend an odds request on a sport with an event starting inside this
     many hours. 0 disables the check. The event index is a FREE endpoint, so
     this trades a free call for a billed one. */
  nearHours: number;
  /** Horizon beyond which a game is priced and stored but never made actionable. */
  maxDaysToStart: number;
  /** Treat a quote whose age cannot be determined as fresh. Defaults FALSE: an
      unknown age is not a young age, and the whole point of this build is to stop
      inferring the favourable reading of missing data. Telemetry counts these
      separately so a feed that stops sending timestamps is loud, not silent. */
  treatMissingTimestampAsFresh: boolean;
  /** Optional hard gate on the composite quality score. Defaults to 0 — OFF.
      The score is built from measured components and is stored for audit, but it
      has never been validated against outcomes, and gating on an unvalidated
      composite is how a system starts believing its own decoration. Raise it only
      with backtest evidence. */
  minQualityScore: number;
  devigPolicy: Record<string, string>;
  freshnessPolicy: Record<string, Record<string, number>>;
  edgeFloor: Record<string, number | null>;
  edgeSaneMax: Record<string, number>;
  bookRequirements: typeof BOOK_REQUIREMENTS;
  maxDispersion: Record<string, number>;
  confirmations: Record<string, { A: number; B: number }>;
  familyOverrides: Record<string, string>;
}

/* EXACTLY TEN, AND THE COUNT IS THE POINT.
   `/v4/sports/{sport}/odds` bills at markets x regions. The `bookmakers`
   parameter substitutes for the regions term and is charged in groups of ten,
   ROUNDED UP: one to ten keys is one region-equivalent, eleven is two.

   So this list reaches Pinnacle — an `eu` book, and the whole reason v8's
   sharp anchor was structurally unreachable — for the SAME price as the broken
   `regions=us` configuration it replaces, and for HALF the price of the
   corrected `regions=us,eu`. An eleventh key would double the bill. If you add
   one, take one out.

   Every key is chosen to be a distinct operator family, because a family is
   what `n_books_eff` counts and two brands on one trading desk are one opinion
   however many rows the feed sends. `bookmakers` is a cross-region selector, so
   espnbet and hardrockbet (`us2`) are reachable without naming their region.

   Still empty by default: billing must be MEASURED on the account that pays for
   it, not assumed from a docs page. `?probe=1` measures it and prints the
   answer. Until it has, the corrected default is `regions=us,eu` — twice the
   cost, but the only other configuration in which Tier A exists at all. */
export const SUGGESTED_BOOKMAKERS = [
  "pinnacle",        // eu  — the reference book. The entire point of the list.
  "betonlineag",     // us  — low-margin, useful as a second reference candidate
  "draftkings", "fanduel", "betmgm",
  "williamhill_us",  // us  — Caesars' current key; `caesars` is the older one
  "betrivers", "bovada",
  "espnbet", "hardrockbet",   // us2, reachable because bookmakers crosses regions
];

function parseJsonEnv<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === "object") ? v as T : fallback;
  } catch { return fallback; }
}

export function defaultConfig(env: EnvGet): Config {
  const g = (k: string, d: string) => { const v = env(k); return v == null || v === "" ? d : v; };
  const num = (k: string, d: number) => { const v = Number(g(k, String(d))); return Number.isFinite(v) ? v : d; };
  const bool = (k: string, d: boolean) => {
    const v = String(g(k, d ? "true" : "false")).toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  };
  const list = (k: string, d: string) => g(k, d).split(",").map((s) => s.trim()).filter(Boolean);

  return {
    /* CHANGED FROM v8: `us` -> `us,eu`. `us` does not contain Pinnacle, which
       made Tier A unreachable and turned every "sharp" claim into a consensus.
       This costs one extra region per request; CAPTURE_BOOKMAKERS is the cheaper
       route once ?probe=1 has confirmed how the account is billed for it. */
    regions: g("CAPTURE_REGIONS", "us,eu"),
    bookmakers: list("CAPTURE_BOOKMAKERS", ""),
    markets: g("CAPTURE_MARKETS", "h2h,spreads,totals"),
    sportsEnv: g("CAPTURE_SPORTS", ""),
    /* v8 CONCATENATED "americanfootball_nfl" onto whatever this was set to, so
       auto-add could not be turned off: setting CAPTURE_AUTO_PREFIXES="" still
       pulled in every active NFL key including preseason, on top of an explicit
       CAPTURE_SPORTS list that had deliberately excluded them. Here the variable
       means what it says — set it to empty and nothing is auto-added; leave it
       unset and the football keys EdgeDesk is built around are included. */
    autoPrefixes: env("CAPTURE_AUTO_PREFIXES") === undefined
      ? ["tennis_", "americanfootball_nfl", "americanfootball_ncaaf"]
      : list("CAPTURE_AUTO_PREFIXES", ""),
    /* Only books EdgeDesk is willing to call a sharp reference. Pinnacle alone
       by default. Adding a book here is a claim that its price is independent
       information, and that claim belongs in a commit message with evidence. */
    referenceBooks: list("CAPTURE_REFERENCE_BOOKS", "pinnacle").map((s) => s.toLowerCase()),
    ticks: bool("CAPTURE_TICKS", true),
  /* Per-book quote history, written ONLY for signals that became actionable.
     `book_quotes` has a trigger, a view and four UI paths built on it, three UI
     strings that assert capture populates it, and — until now — no writer
     anywhere. Without it there is no per-book history, and without per-book
     history the book-quality questions the brief asks (which books lead, which
     follow, which post stale prices, which move toward the close) cannot be
     answered from data and would have to be invented, which is not on the table.

     Bounded to actionable signals on purpose: every priced selection at every
     book would be tens of thousands of rows per run, and book_quote_ticks
     appends a history row for each change. The actionable set is small and is
     exactly the population a book-bias study is about. */
  bookQuotes: bool("CAPTURE_BOOK_QUOTES", true),
    flagMax: num("CAPTURE_FLAG_MAX", 600),
    flagConcurrency: Math.max(1, num("CAPTURE_FLAG_CONCURRENCY", 25)),
    budgetMs: num("CAPTURE_MAX_MS", 110000),
    minDec: num("CLOSE_MIN_DEC", 1.02),
    maxDec: num("CLOSE_MAX_DEC", 30),
    maxAbsProbDev: num("CAPTURE_MAX_ABS_PROB_DEV", 0.08),
    minProbRatio: num("CAPTURE_MIN_PROB_RATIO", 0.60),
    maxMadZ: num("CAPTURE_MAX_MAD_Z", 6),
    maxBestVsMedianDec: num("CAPTURE_MAX_BEST_RATIO", 2.0),
    minMinutesToStart: num("CAPTURE_MIN_MINUTES_TO_START", 10),
    nearHours: num("CAPTURE_NEAR_HOURS", 0),
    maxDaysToStart: num("CAPTURE_MAX_DAYS_TO_START", 14),
    treatMissingTimestampAsFresh: bool("CAPTURE_MISSING_TS_FRESH", false),
    minQualityScore: num("CAPTURE_MIN_QUALITY", 0),
    devigPolicy: { ...DEVIG_POLICY, ...parseJsonEnv(env("CAPTURE_DEVIG_POLICY"), {}) },
    freshnessPolicy: { ...FRESHNESS_POLICY, ...parseJsonEnv(env("CAPTURE_FRESHNESS_POLICY"), {}) },
    edgeFloor: { ...EDGE_FLOOR, ...parseJsonEnv(env("CAPTURE_EDGE_FLOOR"), {}) },
    edgeSaneMax: { ...EDGE_SANE_MAX, ...parseJsonEnv(env("CAPTURE_EDGE_SANE_MAX"), {}) },
    bookRequirements: { ...BOOK_REQUIREMENTS, ...parseJsonEnv(env("CAPTURE_BOOK_REQUIREMENTS"), {}) },
    maxDispersion: { ...MAX_DISPERSION, ...parseJsonEnv(env("CAPTURE_MAX_DISPERSION"), {}) },
    confirmations: { ...CONFIRMATIONS, ...parseJsonEnv(env("CAPTURE_CONFIRMATIONS"), {}) },
    familyOverrides: parseJsonEnv(env("CAPTURE_BOOK_FAMILIES"), {} as Record<string, string>),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — MATH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bisection that CHECKS ITS BRACKET.
 *
 * v8's version evaluated f(lo) and never f(hi). Bisection is only defined when
 * the endpoints straddle a root; given a bracket that does not, the loop happily
 * walked lo up to hi and returned the endpoint as though it were a solution. That
 * is not a hypothetical: an underround book (booksum below 1 — two sides priced
 * so generously that backing both is an arbitrage, which happens on thin college
 * lines and on stale quotes) gives the Shin objective the same sign at both ends,
 * and v8 returned z = 0.5 and produced "fair probabilities" summing to 0.53.
 * Nothing checked, nothing logged, and that number went into an edge.
 *
 * Returning null on an unbracketed root forces the caller to have an answer for
 * the case, which is the entire difference between a fallback and a silent lie.
 */
export function bisect(f: (x: number) => number, lo: number, hi: number, it = 80): number | null {
  let fl = f(lo);
  const fh = f(hi);
  if (!Number.isFinite(fl) || !Number.isFinite(fh)) return null;
  if (Math.abs(fl) < 1e-12) return lo;
  if (Math.abs(fh) < 1e-12) return hi;
  if ((fl < 0) === (fh < 0)) return null;          // no root in [lo, hi]
  for (let i = 0; i < it; i++) {
    const m = (lo + hi) / 2, fm = f(m);
    if (Math.abs(fm) < 1e-12) return m;
    if ((fl < 0) === (fm < 0)) { lo = m; fl = fm; } else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * Remove the bookmaker's margin from a set of decimal prices covering a complete
 * market, returning fair probabilities that sum to 1.
 *
 * Unchanged from v8 in behaviour — this is the one piece that was not broken —
 * but the failure paths are now explicit rather than swallowed, because a devig
 * that silently degrades to `multiplicative` while still reporting itself as
 * `shin` is a number whose provenance is a lie.
 */
export function devig(decs: number[], method = "shin"): number[] {
  const q = decs.map((d) => 1 / d);
  const S = q.reduce((a, b) => a + b, 0);
  const normalised = () => q.map((x) => x / S);
  if (!Number.isFinite(S) || S <= 0) return decs.map(() => 0);
  if (method === "multiplicative") return normalised();

  /* AN UNDERROUND BOOK HAS NO MARGIN TO REMOVE. Both Shin and power solve for a
     parameter that SHRINKS the implied probabilities down to 1; when they already
     sum below 1 there is nothing to shrink and no root exists in either bracket.
     Proportional normalisation is the correct and only honest answer, and it is
     what the fallback below has always intended to do — v8 just never noticed it
     was not doing it. */
  if (!(S > 1)) return normalised();

  if (method === "power") {
    /* q_i < 1 for any decimal above 1, so raising to k > 1 shrinks the sum. At
       k = 0.5 the sum exceeds the (already >1) booksum; at k = 8 it is far below
       1. The bracket straddles whenever S > 1, which is guarded above. */
    const k = bisect((kk) => q.reduce((a, x) => a + Math.pow(x, kk), 0) - 1, 0.5, 8);
    if (k == null) return normalised();
    const out = q.map((x) => Math.pow(x, k));
    const s2 = out.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(s2) || s2 <= 0) return normalised();
    return out.map((x) => x / s2);
  }

  /* Shin. z is the assumed proportion of insider money. At z -> 0 the fairs sum
     to sqrt(S) > 1; at z = 0.5 they sum below 1. The bracket straddles. */
  const fair = (z: number) => q.map((qi) => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / S) - z) / (2 * (1 - z)));
  const z = bisect((zz) => fair(zz).reduce((a, b) => a + b, 0) - 1, 1e-9, 0.5);
  if (z == null) return normalised();
  const out = fair(z);
  const s2 = out.reduce((a, b) => a + b, 0);
  /* Renormalise. The solver lands within 1e-12 of a unit sum, but "within 1e-12"
     is not "exactly", and every probability this function returns is multiplied
     by a price to make an edge. Costs nothing, removes a class of drift. */
  if (!Number.isFinite(s2) || s2 <= 0) return normalised();
  return out.map((x) => x / s2);
}

export const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

/**
 * Trimmed median: drop the extreme value from each tail before taking the
 * median, when there are enough observations to afford it.
 *
 * Why not a plain median. A median is already robust to a single wild value, but
 * it is NOT robust to the thing that actually happens on a thin college football
 * line: several books copying one slow number, so the "middle" book is a clone
 * of the stale one. Trimming the tails and then taking the middle of what is left
 * is a small, defensible step that costs nothing on a healthy market and helps on
 * an unhealthy one. Below five observations there is nothing to trim and this is
 * exactly a median, which is the honest behaviour rather than a fake refinement.
 */
export function trimmedMedian(a: number[]): number {
  if (a.length < 5) return median(a);
  const s = [...a].sort((x, y) => x - y);
  return median(s.slice(1, s.length - 1));
}

/** Median absolute deviation — dispersion that a single broken quote cannot
    inflate, unlike a standard deviation. */
export function mad(a: number[]): number {
  if (a.length < 2) return 0;
  const m = median(a);
  return median(a.map((x) => Math.abs(x - m)));
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — MARKET SHAPE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Can this market be BACKED at the quoted price?
 *
 * Exchanges publish both sides and the Odds API surfaces the lay side as its own
 * market key. Flagging one puts a price in front of a user that they cannot take
 * and then grades it into the record as if they had. The regex matches a `_lay`
 * segment anywhere, which is the same rule app.html's marketIsLay() applies, so
 * the writer and the reader cannot disagree about it.
 */
export function backable(market: string): boolean {
  const m = String(market ?? "").toLowerCase();
  if (!m) return false;
  return !/(^|_)lay(_|$)/.test(m);
}

/** Markets EdgeDesk understands well enough to rank. Deliberately identical to
    app.html's BACK_MARKETS and edgedesk_ai's, so a market that one component
    refuses cannot be flagged by another. */
export const BACK_MARKETS = new Set(["h2h", "spreads", "totals"]);

/* THE TRAILING PIPE IS LOAD-BEARING. A selection with no point still ends in "|".
   This is the primary key of `signals` and it must not drift by one character. */
export const sigKey = (o: { event_id: string; market: string; selection: string; point: number | null }): string =>
  `${o.event_id}|${o.market}|${o.selection}|${o.point ?? ""}`;

/**
 * Which football key numbers a move between two spread/total values touches.
 *
 * THE INTERVAL IS CLOSED, AND THAT IS THE WHOLE POINT. Moving 2.5 -> 3 does not
 * pass over 3, it LANDS on it, and landing on 3 is the single most consequential
 * thing a football spread can do — roughly 15% of NFL games are decided by
 * exactly 3. A half-open interval would report that move as crossing nothing,
 * which is the opposite of true. So a key number counts when it lies anywhere in
 * [min, max], and an unchanged line touches nothing.
 *
 *   2.5 -> 3    => [3]      landed on the key number
 *   3   -> 3.5  => [3]      left the key number
 *   6.5 -> 7.5  => [7]      passed over the second most common margin
 *   4   -> 4.5  => []       moved through empty space (4 is minor; opt in for it)
 *
 * It returns the numbers themselves rather than a boolean so research can weight
 * 3 differently from 14 if the data ever supports doing so. It applies NO
 * probability adjustment and makes no claim about magnitude — inventing one
 * without historical support is exactly what the brief forbids.
 *
 * Sign is handled by absolute value: -2.5 -> -3 and +2.5 -> +3 both touch 3.
 */
export function keyNumbersCrossed(
  from: number | null, to: number | null, sportKey: string, includeMinor = false,
): number[] {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) return [];
  const g = sportGroup(sportKey);
  const keys = (KEY_NUMBERS[g] ?? []).concat(includeMinor ? (KEY_NUMBERS_MINOR[g] ?? []) : []);
  if (!keys.length) return [];
  const a = Math.abs(from), b = Math.abs(to);
  if (a === b) return [];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return [...new Set(keys.filter((k) => k >= lo && k <= hi))].sort((x, y) => x - y);
}

/** The freshness bucket this event is in, by hours to kickoff. */
export function freshnessBucket(hoursToStart: number): string {
  for (const b of FRESHNESS_BUCKETS) if (hoursToStart <= b.maxHoursToStart) return b.name;
  return "deep";
}

/** The maximum quote age, in seconds, that counts as fresh for this selection. */
export function freshnessLimit(cfg: Config, sportKey: string, market: string, hoursToStart: number): number {
  const table = policyLookup(cfg.freshnessPolicy, sportGroup(sportKey), market) ?? FRESHNESS_POLICY["*|*"];
  return table[freshnessBucket(hoursToStart)] ?? table.deep ?? 3600;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — PRICING
//
// priceEvent turns one provider event into candidates. It does NOT decide
// anything: no edge, no tier, no flag. Everything a decision needs is carried on
// the candidate, and qualifySignal() is the only place a decision is made.
// ═══════════════════════════════════════════════════════════════════════════

export interface Quote {
  book: string;
  title: string;
  /** Decimal price for THIS selection at THIS book, at THIS point. */
  dec: number;
  /** The opposite side's decimal at the same book in the same two-way market,
      or null for a market that is not two-way. This is what `pin_dec` /
      `pin_opp_dec` need, and app.html has a whole method-sensitivity panel that
      has been gated off waiting for capture to write them since they were added. */
  oppDec: number | null;
  /** Devigged fair probability from this book's own complete market. */
  fair: number;
  /** Seconds between the provider's update stamp for this quote and the run's
      clock. null means the provider sent no usable timestamp. */
  ageS: number | null;
  fresh: boolean;
  family: string;
  tier: string;
  /** How many outcomes the devig used. A two-way devig is much better determined
      than a three-way one and the qualification engine is entitled to know. */
  sides: number;
}

export interface Candidate {
  event_id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  market: string;
  selection: string;
  point: number | null;
  quotes: Quote[];
  /** Distinct points offered by any book for this market and selection name, and
      the one the most books are on. A signal sitting on a minority point is a
      different bet from the one the market is trading, and for football that
      difference is frequently a key number. */
  modal_point: number | null;
  points_offered: number;
  books_at_modal: number;
  hours_to_start: number;
  freshness_limit_s: number;
  devig_method: string;
}

export interface PriceEventResult {
  candidates: Candidate[];
  /** Markets skipped because the feed's shape was unusable. Counted, never
      thrown: one malformed market must never cost a run. */
  malformed: number;
  /** Quotes the provider supplied with no usable update timestamp. If this is
      ever large the feed changed and freshness has quietly stopped working. */
  missingTimestamps: number;
  /** Second and later quotes from a book that listed the same selection twice. */
  duplicateQuotes: number;
}

/**
 * Split one book's market object into COMPLETE sub-markets before devigging.
 *
 * WHY THIS EXISTS. Devigging assumes the prices handed to it partition the
 * outcome space — that is what "remove the margin so they sum to 1" means. v8
 * handed the whole `outcomes` array to devig() unconditionally. When a book
 * returns alternate lines inside a single market object (Team A -3 / Team B +3 /
 * Team A -3.5 / Team B +3.5, which several books do), that is FOUR prices across
 * TWO markets, and devigging them together treats a double-counted outcome space
 * as exhaustive. Every fair probability from that book is then roughly halved,
 * which makes the book look like it is offering enormous value on both sides at
 * once, in the consensus median and in the sharp anchor alike.
 *
 * The partition rule: a handicap pairs on its ABSOLUTE value. Spreads are
 * opposite-signed (-3.5 / +3.5) and totals are same-signed (Over 47.5 / Under
 * 47.5), and |point| groups both correctly. Moneylines carry no point and stay
 * whole, which keeps three-way markets (home / draw / away) intact.
 *
 * A point-bearing group that is not exactly two outcomes is not a market this
 * function understands, and it is refused rather than guessed at.
 */
export function partitionOutcomes(outcomes: any[]): { group: any[]; ok: boolean }[] {
  const hasPoint = outcomes.some((o) => o?.point != null && Number.isFinite(Number(o.point)));
  if (!hasPoint) return [{ group: outcomes, ok: outcomes.length >= 2 }];
  const by = new Map<string, any[]>();
  for (const o of outcomes) {
    const p = Number(o?.point);
    /* Mixed shapes — some outcomes with a handicap and some without — is not a
       market shape, it is a feed error. Refuse the whole market object. */
    if (!Number.isFinite(p)) return [{ group: outcomes, ok: false }];
    const k = Math.abs(p).toFixed(4);
    const arr = by.get(k);
    if (arr) arr.push(o); else by.set(k, [o]);
  }
  return [...by.values()].map((group) => ({ group, ok: group.length === 2 }));
}

function parseStamp(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Price one event.
 *
 * THE FEED IS NOT A CONTRACT. `bookmakers`, `markets` and `outcomes` are each
 * guarded, prices are coerced with Number() and checked with Number.isFinite, and
 * anything unusable is skipped and counted. v6 was killed by a single market
 * object arriving without an `outcomes` array; nothing below assumes a shape.
 */
export function priceEvent(ev: any, cfg: Config, nowMs: number): PriceEventResult {
  const out: PriceEventResult = { candidates: [], malformed: 0, missingTimestamps: 0, duplicateQuotes: 0 };
  if (!ev || typeof ev !== "object") return out;

  const commence = String(ev.commence_time ?? "");
  const startMs = Date.parse(commence);
  const hoursToStart = Number.isFinite(startMs) ? (startMs - nowMs) / 3600000 : 999;
  const sportKey = String(ev.sport_key ?? "");

  /* mkts[marketKey][selectionName + "|" + point] — THE POINT IS PART OF THE KEY.
     This is the rule that makes "same bet" mean same bet: a quote on Team A -3
     and a quote on Team A -3.5 land in different slots, are never devigged
     together, never share a consensus, and never compare a fair from one with a
     price from the other. Every football key-number trap in the adversarial
     suite is a test of this one line. */
  const mkts: Record<string, Record<string, any>> = {};
  /* Per (market, selection name): how many BOOKS sit on each point, so a minority
     line is visible as such. */
  const pointCensus: Record<string, Record<string, Set<string>>> = {};

  for (const bk of ev.bookmakers ?? []) {
    const bookKey = String(bk?.key ?? "").toLowerCase();
    if (!bookKey) continue;
    const bookStamp = parseStamp(bk?.last_update);

    for (const mk of bk.markets ?? []) {
      const mkey = String(mk?.key ?? "");
      if (!mkey) { out.malformed++; continue; }
      const rawOutcomes: any[] = Array.isArray(mk?.outcomes) ? mk.outcomes : [];
      if (rawOutcomes.length < 2) { out.malformed++; continue; }

      const method = policyLookup(cfg.devigPolicy, sportGroup(sportKey), mkey) ?? "shin";

      /* Market-level stamp where the provider sends one, book-level otherwise.
         The market stamp is the better answer — a book can refresh its baseball
         page without touching this football spread — and preferring it is why
         freshness is measured per market rather than per book. */
      const stamp = parseStamp(mk?.last_update) ?? bookStamp;
      const ageS = stamp == null ? null : Math.max(0, Math.round((nowMs - stamp) / 1000));
      const limit = freshnessLimit(cfg, sportKey, mkey, hoursToStart);
      /* A quote exactly AT the limit is fresh; one second past it is not.
         Asserted directly in the adversarial suite, because an off-by-one here
         silently changes the size of every consensus in the system. */
      const fresh = ageS == null ? cfg.treatMissingTimestampAsFresh : ageS <= limit;

      for (const part of partitionOutcomes(rawOutcomes)) {
        if (!part.ok) { out.malformed++; continue; }
        const outcomes = part.group;
        const decs = outcomes.map((o: any) => Number(o?.price));
        if (decs.length < 2 || decs.some((d: number) => !Number.isFinite(d) || d <= 1)) { out.malformed++; continue; }

        const fair = devig(decs, method);
        if (fair.some((f) => !Number.isFinite(f) || f <= 0 || f >= 1)) { out.malformed++; continue; }
        if (stamp == null) out.missingTimestamps += outcomes.length;

        for (let i = 0; i < outcomes.length; i++) {
          const o = outcomes[i];
          const nm = String(o?.name ?? "");
          if (!nm) continue;
          const ptRaw = o?.point;
          const pt = (ptRaw == null || !Number.isFinite(Number(ptRaw))) ? null : Number(ptRaw);
          const okey = nm + "|" + (pt == null ? "" : pt);

          mkts[mkey] = mkts[mkey] ?? {};
          const slot = mkts[mkey][okey] ?? (mkts[mkey][okey] = { name: nm, point: pt, byBook: new Map<string, Quote>() });

          /* ONE QUOTE PER BOOK PER SELECTION, first wins. A book listing the same
             outcome twice used to count as two books, which defeated the very gate
             that exists to stop one feed's opinion being called a consensus, and
             double-weighted that book in the median as well. */
          if (slot.byBook.has(bookKey)) { out.duplicateQuotes++; continue; }

          slot.byBook.set(bookKey, {
            book: bookKey,
            title: String(bk?.title ?? bookKey),
            dec: decs[i],
            oppDec: outcomes.length === 2 ? decs[1 - i] : null,
            fair: fair[i],
            ageS, fresh,
            family: bookFamily(bookKey, cfg.familyOverrides),
            tier: bookTier(bookKey),
            sides: outcomes.length,
          });

          const cKey = mkey + "|" + nm;
          pointCensus[cKey] = pointCensus[cKey] ?? {};
          const pKey = pt == null ? "" : String(pt);
          (pointCensus[cKey][pKey] = pointCensus[cKey][pKey] ?? new Set<string>()).add(bookKey);
        }
      }
    }
  }

  for (const mkey in mkts) {
    for (const okey in mkts[mkey]) {
      const s = mkts[mkey][okey];
      const quotes = [...s.byBook.values()] as Quote[];
      if (!quotes.length) continue;

      const census = pointCensus[mkey + "|" + s.name] ?? {};
      let modalPoint: number | null = null, modalN = -1, offered = 0;
      for (const p in census) {
        offered++;
        const n = census[p].size;
        if (n > modalN) { modalN = n; modalPoint = p === "" ? null : Number(p); }
      }

      out.candidates.push({
        event_id: String(ev.id ?? ""),
        sport_key: sportKey,
        sport_title: String(ev.sport_title ?? ""),
        commence_time: commence,
        home_team: String(ev.home_team ?? ""),
        away_team: String(ev.away_team ?? ""),
        market: mkey,
        selection: s.name,
        point: s.point,
        quotes,
        modal_point: modalPoint,
        points_offered: offered,
        books_at_modal: modalN < 0 ? 0 : modalN,
        hours_to_start: hoursToStart,
        freshness_limit_s: freshnessLimit(cfg, sportKey, mkey, hoursToStart),
        devig_method: policyLookup(cfg.devigPolicy, sportGroup(sportKey), mkey) ?? "shin",
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 5 — THE QUALIFICATION ENGINE
//
// ONE function decides what EdgeDesk is willing to call an Edge. The board, the
// research engine, the record, the grader and the learning loop all read the
// state this function produces; none of them re-derives it. That is the whole
// point of Phase 10 of the brief, and it is the difference between a system with
// a definition and a system with four opinions.
// ═══════════════════════════════════════════════════════════════════════════

export interface QualContext {
  /** Consecutive prior capture cycles in which this candidate already qualified
      on evidence. 0 for a candidate never seen before, or one that failed last
      cycle. Missing prior state is treated as 0, which requires re-confirmation:
      the conservative direction. */
  priorStreak: number;
  nowMs: number;
}

export interface Verdict {
  actionable: boolean;
  tier: "A" | "B" | "PASS";
  reason: string;
  reference_type: "sharp" | "robust_consensus" | "none";
  reference_book: string | null;
  /** The probability EdgeDesk is betting against. Tier A: the reference book's
      own devigged number. Tier B: the trimmed median of the fresh, family-deduped
      pack WITH THE BEST-PRICE BOOK REMOVED. */
  fair_probability: number | null;
  fair_decimal: number | null;
  /** The pack's own consensus, always computed when there are any fresh books.
      Stored for research even when the row is not actionable. */
  consensus_fair: number | null;
  /** The reference book's fair when a genuine approved reference book quoted this
      selection at this point. NULL otherwise, always — this column can never be
      a median, which is exactly what went wrong in v8. */
  sharp_book_fair: number | null;
  edge: number | null;
  best_dec: number;
  best_book: string;
  best_book_title: string;
  best_quote_age_s: number | null;
  reference_quote_age_s: number | null;
  median_dec: number;
  fresh_books: number;
  total_books: number;
  families: number;
  dispersion: number;
  edge_floor: number | null;
  segment: string;
  confirmations: number;
  required_confirmations: number;
  quality_score: number;
  quality: Record<string, number>;
  point_is_modal: boolean;
  modal_point: number | null;
  key_numbers_to_modal: number[];
  is_fav: boolean;
  pin_dec: number | null;
  pin_opp_dec: number | null;
  corrob_n: number;
  corrob_ref: string;
  corrob_levels: number;
  has_sharp: boolean;
}

/* Books whose devigged fair is at least this far BELOW the reference fair are
   counted as corroborating: they independently price the selection cheaper than
   the reference does. app.html's corroboration() reads corrob_n / corrob_ref /
   corrob_levels and has been falling back to a browser-side recomputation over
   whatever quotes happened to be cached, because nothing ever wrote them. These
   are the same constants that reader uses; they must not drift. */
const CORROB_MATERIAL = 0.01;

function clamp(x: number, a: number, b: number): number { return Math.max(a, Math.min(b, x)); }

/**
 * Decide whether this candidate is an actionable EdgeDesk signal, and say
 * precisely why or why not.
 *
 * Pure. No clock of its own, no network, no environment. Everything it needs is
 * in (candidate, ctx, cfg), which is what makes the adversarial suite able to
 * assert on a single rule at a time.
 */
export function qualifySignal(c: Candidate, ctx: QualContext, cfg: Config): Verdict {
  const group = sportGroup(c.sport_key);
  const quotes = c.quotes;
  const fresh = quotes.filter((q) => q.fresh);

  /* One quote per operator family for every consensus number below. Six books on
     one trading desk are one opinion, and `n_books_eff` — which app.html has read
     for as long as it has existed and which nothing has ever written — is this
     count. Where a family has several quotes the FRESHEST wins, then the best
     priced, so the family is represented by its most current number. */
  const byFamily = new Map<string, Quote>();
  for (const q of fresh) {
    const cur = byFamily.get(q.family);
    if (!cur) { byFamily.set(q.family, q); continue; }
    const a = q.ageS ?? Number.MAX_SAFE_INTEGER, b = cur.ageS ?? Number.MAX_SAFE_INTEGER;
    if (a < b || (a === b && q.dec > cur.dec)) byFamily.set(q.family, q);
  }
  const indep = [...byFamily.values()];

  const best = quotes.reduce((a, b) => (b.dec > a.dec ? b : a));
  const bestFresh = fresh.length ? fresh.reduce((a, b) => (b.dec > a.dec ? b : a)) : null;
  const medianDec = median(quotes.map((q) => q.dec));
  const consensusAll = indep.length ? trimmedMedian(indep.map((q) => q.fair)) : null;
  const dispersion = indep.length >= 2 ? mad(indep.map((q) => q.fair)) : 0;

  /* The reference book, chosen by the PRIORITY ORDER of cfg.referenceBooks rather
     than by whichever one the feed happened to list first. v8 picked the LAST
     matching book because it assigned inside the loop, which meant the anchor
     could change identity between two runs of the same slate for no reason but
     feed ordering — and an anchor that is not deterministic is not an anchor. */
  let refBook: Quote | null = null;
  for (const rb of cfg.referenceBooks) {
    const q = quotes.find((x) => x.book === rb);
    if (q) { refBook = q; break; }
  }
  const refFresh = refBook && refBook.fresh ? refBook : null;
  const isFav = medianDec < 2;

  /* Corroboration, recorded against whichever reference actually applies, and
     labelled so the reader can tell which. Counted over independent families so a
     cloned line cannot corroborate itself. */
  const corrobRef = refFresh ? "pinnacle" : "median";
  const corrobBase = refFresh ? refFresh.fair : consensusAll;
  const corroborating = corrobBase == null ? [] : indep.filter((q) => (corrobBase - q.fair) >= CORROB_MATERIAL);
  const corrobLevels = new Set(corroborating.map((q) => q.dec.toFixed(3))).size;

  const base = {
    reference_book: refBook ? refBook.book : null,
    consensus_fair: consensusAll,
    sharp_book_fair: refFresh ? refFresh.fair : null,
    best_dec: best.dec,
    best_book: best.book,
    best_book_title: best.title,
    best_quote_age_s: best.ageS,
    reference_quote_age_s: refBook ? refBook.ageS : null,
    median_dec: medianDec,
    fresh_books: fresh.length,
    total_books: quotes.length,
    families: indep.length,
    dispersion,
    confirmations: 0,
    point_is_modal: c.point === c.modal_point,
    modal_point: c.modal_point,
    key_numbers_to_modal: keyNumbersCrossed(c.point, c.modal_point, c.sport_key),
    is_fav: isFav,
    pin_dec: refBook ? refBook.dec : null,
    pin_opp_dec: refBook ? refBook.oppDec : null,
    corrob_n: corroborating.length,
    corrob_ref: corrobRef,
    corrob_levels: corrobLevels,
    has_sharp: !!refFresh,
  };

  const pass = (reason: string, extra: Partial<Verdict> = {}): Verdict => ({
    actionable: false, tier: "PASS", reason,
    reference_type: refFresh ? "sharp" : (consensusAll != null ? "robust_consensus" : "none"),
    fair_probability: null, fair_decimal: null, edge: null,
    edge_floor: null, segment: `${group}|${c.market}|PASS`,
    required_confirmations: 0, quality_score: 0, quality: {},
    ...base, ...extra,
  });

  // ── Gate 1: is this a bet a person can place at all? ─────────────────────
  if (!backable(c.market)) return pass("exchange_lay_not_backable");
  if (!BACK_MARKETS.has(String(c.market).toLowerCase())) return pass("market_not_understood");
  if (!Number.isFinite(best.dec) || best.dec <= 1) return pass("no_usable_price");

  // ── Gate 2: is there time to place it, and is it near enough to be real? ──
  const minsToStart = c.hours_to_start * 60;
  if (minsToStart < cfg.minMinutesToStart) return pass("too_close_to_start");
  if (c.hours_to_start > cfg.maxDaysToStart * 24) return pass("beyond_actionable_horizon");

  // ── Gate 3: freshness. A stale quote is stored, never acted on. ───────────
  if (!bestFresh || !fresh.length || consensusAll == null) return pass("best_price_stale");
  /* THE EXECUTION PRICE MUST BE BOTH THE BEST AND FRESH. If the highest quote on
     the board is stale, the price EdgeDesk claims is the best FRESH one — quoting
     a number no longer being offered is how a paper edge becomes a real loss, and
     it is also the single easiest way for a dead feed to manufacture an edge.
     Everything downstream — the outlier test, the fair value, the edge, the
     frozen entry — uses execBest and never `best`. */
  if (bestFresh.book !== best.book) {
    base.best_dec = bestFresh.dec;
    base.best_book = bestFresh.book;
    base.best_book_title = bestFresh.title;
    base.best_quote_age_s = bestFresh.ageS;
  }
  const execBest = bestFresh;

  /* Tradeable bounds apply to the price a person would actually take. */
  if (execBest.dec < cfg.minDec) return pass("price_below_tradeable_bound");
  if (execBest.dec > cfg.maxDec) return pass("price_above_tradeable_bound");

  // ── Gate 4: outlier detection, in PROBABILITY space. ──────────────────────
  /* Judged against the pack EXCLUDING the candidate price's own book, so a book
     cannot moderate the median it is being measured against. */
  const packQuotes = indep.filter((q) => q.book !== execBest.book);
  const packProbs = packQuotes.map((q) => 1 / q.dec);
  const bestProb = 1 / execBest.dec;
  if (packProbs.length) {
    const packMed = median(packProbs);
    const absDev = packMed - bestProb;
    const ratio = packMed > 0 ? bestProb / packMed : 1;

    /* MAD WIDENS THE TOLERANCE. IT NEVER NARROWS IT.
       This is the one place where the obvious use of a robust z-score is wrong,
       and it is worth saying why. A genuine soft price and a broken feed have the
       SAME signature under a z-test: both are "far from the pack". On a tight
       market — four books inside a cent, MAD around 0.003 — a real 4-point
       overlay scores z ≈ 13, so a z cap of 6 does not reject broken prices, it
       rejects every edge worth having. Tested directly: the first draft of this
       gate refused a legitimate 2.9% Tier B signal on a five-book consensus.
       What MAD legitimately says is the opposite: on a market where books already
       disagree by several points, a deviation of the same size is less
       surprising. So it raises the allowance and is capped so it can never open
       a hole wider than 1.5x the absolute rule. The absolute cap governs
       everywhere else, and Tier B separately refuses a dispersed pack outright. */
    const m = packProbs.length >= 4 ? mad(packProbs) : 0;
    const allowedDev = Math.min(cfg.maxAbsProbDev * 1.5, Math.max(cfg.maxAbsProbDev, cfg.maxMadZ * m));

    if (absDev > allowedDev) return pass("best_price_outlier_abs");
    if (ratio < cfg.minProbRatio) return pass("best_price_outlier_ratio");
    /* Decimal backstop, kept from v8 for the catastrophic 12.0-against-1.90 case
       that started this whole repair. Loosened to 2.0 because the probability
       tests above are strictly stricter for short prices and 1.35 in decimal
       space wrongly refused ordinary longshot disagreement. */
    const packMedDec = median(packQuotes.map((q) => q.dec));
    if (packMedDec > 1 && execBest.dec / packMedDec > cfg.maxBestVsMedianDec) {
      return pass("best_price_outlier_decimal");
    }
  }

  // ── Gate 5: the reference tier. ───────────────────────────────────────────
  const req = policyLookup(cfg.bookRequirements, group, c.market) ?? BOOK_REQUIREMENTS["*|*"];
  let tier: "A" | "B";
  let refType: "sharp" | "robust_consensus";
  let fairProb: number;
  let refAge: number | null;

  if (refFresh) {
    /* TIER A. The reference book quoted THIS selection at THIS point — the slot
       key guarantees it, because a Pinnacle quote on -3 lives in a different slot
       from a best price on -3.5 and the two can never meet. */
    if (refFresh.sides < 2) return pass("reference_market_not_two_sided");
    if (fresh.length < req.A.books) return pass("insufficient_fresh_books");
    if (indep.length < req.A.families) return pass("insufficient_independent_books");
    tier = "A"; refType = "sharp"; fairProb = refFresh.fair; refAge = refFresh.ageS;
  } else {
    /* TIER B. No approved reference book, or its quote is stale. The difference
       matters and is reported separately: a missing Pinnacle is a coverage
       problem the operator can fix by changing CAPTURE_REGIONS, while a stale
       Pinnacle is a market condition. */
    if (refBook && !refBook.fresh) {
      /* The reference exists but is stale. Tier B is still available, but only on
         the stronger evidence bar, and the reason is recorded so the telemetry
         can tell the two apart. */
    }
    if (fresh.length < req.B.books) {
      return pass(refBook && !refBook.fresh ? "sharp_quote_stale" : "insufficient_fresh_books");
    }
    if (indep.length < req.B.families) return pass("insufficient_independent_books");

    const maxDisp = policyLookup(cfg.maxDispersion, group, c.market) ?? MAX_DISPERSION["*|*"];
    if (dispersion > maxDisp) return pass("consensus_dispersion_too_high");

    /* THE BEST-PRICE BOOK IS REMOVED FROM ITS OWN FAIR VALUE. Without this, on a
       four-book market the book being tested supplies a quarter of the number it
       is tested against, and on a two-book market it supplies half. A soft line
       must not be allowed to help prove that it is soft. */
    const packFairs = indep.filter((q) => q.family !== execBest.family).map((q) => q.fair);
    if (packFairs.length < req.B.families - 1) return pass("insufficient_independent_books");
    tier = "B"; refType = "robust_consensus"; fairProb = trimmedMedian(packFairs);
    /* The "reference age" for a consensus is the median age of the books that
       formed it. A missing age counts as the freshness limit, never as zero:
       unknown is not young, and this build exists partly to stop the favourable
       reading of missing data. */
    refAge = median(indep.filter((q) => q.family !== execBest.family)
      .map((q) => q.ageS ?? c.freshness_limit_s));
  }

  if (!Number.isFinite(fairProb) || fairProb <= 0 || fairProb >= 1) return pass("fair_not_computable");

  // ── Gate 6: the edge, against a floor that knows what it is looking at. ───
  const edge = fairProb * execBest.dec - 1;
  const segment = `${group}|${c.market}|${tier}`;
  const floorKey = [`${group}|${c.market}|${tier}`, `${group}|*|${tier}`, `*|${c.market}|${tier}`, `*|*|${tier}`]
    .find((k) => cfg.edgeFloor[k] !== undefined);
  const floor = floorKey === undefined ? null : cfg.edgeFloor[floorKey];
  const saneMax = policyLookup(cfg.edgeSaneMax, group, c.market) ?? EDGE_SANE_MAX["*|*"];

  const priced = {
    reference_type: refType,
    fair_probability: fairProb,
    fair_decimal: 1 / fairProb,
    edge,
    edge_floor: floor,
    segment,
    reference_quote_age_s: refAge,
  };

  if (!Number.isFinite(edge)) return pass("edge_not_computable", priced);
  if (edge > saneMax) return pass("edge_implausible_bad_price", priced);
  /* A null floor is a deliberate "EdgeDesk has no demonstrated advantage in this
     segment". It is a supported configuration, and it produces PASS, not zero. */
  if (floor == null) return pass("segment_not_qualified_for_action", priced);
  if (edge < floor) return pass("below_segment_edge_floor", priced);

  // ── Gate 7: persistence. ──────────────────────────────────────────────────
  const confPolicy = policyLookup(cfg.confirmations, group, c.market) ?? CONFIRMATIONS["*|*"];
  const needed = tier === "A" ? confPolicy.A : confPolicy.B;
  const streak = Math.max(0, ctx.priorStreak) + 1;

  // ── The composite quality score. ──────────────────────────────────────────
  /* Every component is a measured quantity scaled to 0-100 and STORED, so the
     score can always be taken apart and argued with. It is not a gate by default:
     cfg.minQualityScore is 0. A composite that has never been validated against
     outcomes must not be allowed to admit or refuse a bet, and the honest thing
     to do with one is to record it until the backtest says whether it means
     anything. `historical` is 50 — literally "no information" — until a frozen
     calibration table exists to fill it, and it is reported that way rather than
     quietly omitted. */
  const limit = c.freshness_limit_s || 1;
  const quality = {
    reference: tier === "A" ? 100 : clamp(40 + 15 * (indep.length - req.B.families), 40, 85),
    freshness: clamp(100 * (1 - (Math.max(execBest.ageS ?? limit, refAge ?? 0) / limit)), 0, 100),
    consensus: clamp(100 * (1 - dispersion / (policyLookup(cfg.maxDispersion, group, c.market) ?? 0.02)), 0, 100),
    persistence: clamp(100 * (streak / Math.max(1, needed)), 0, 100),
    edge: clamp(100 * (edge / Math.max(1e-9, floor * 3)), 0, 100),
    historical: 50,
  };
  const quality_score = Math.round(
    0.30 * quality.reference + 0.15 * quality.freshness + 0.20 * quality.consensus
    + 0.10 * quality.persistence + 0.15 * quality.edge + 0.10 * quality.historical,
  );

  const full: Verdict = {
    actionable: false, tier, reason: "ok",
    ...base, ...priced,
    confirmations: streak, required_confirmations: needed,
    quality_score, quality,
  } as Verdict;

  if (streak < needed) return { ...full, actionable: false, reason: "awaiting_confirmation" };
  if (quality_score < cfg.minQualityScore) return { ...full, actionable: false, reason: "below_quality_floor" };
  return { ...full, actionable: true, reason: "ok" };
}

/* ── THE FUNNEL ──────────────────────────────────────────────────────────────
   Every rejection reason maps to the gate that produced it, in the order
   qualifySignal() applies them. A candidate that stops at stage k passed stages
   0..k-1, so the counters are monotonically non-increasing by construction and
   the DROP between two adjacent numbers is the cost of exactly one rule.

   This is what makes "why is the board empty" answerable from one run without
   inference: a big drop at `fresh_price` is a dead feed, at `reference_quality`
   it is book coverage, at `edge_floor` it is an efficient market, and at
   `persistence` it is simply a candidate that has not been seen twice yet. */
export const FUNNEL_STAGES = [
  "market_understood", "in_time_window", "fresh_price", "passed_outlier",
  "reference_quality", "consensus_quality", "edge_floor", "persistence",
  "quality_floor", "actionable",
];

export const STAGE_OF_REASON: Record<string, number> = {
  exchange_lay_not_backable: 0, market_not_understood: 0, no_usable_price: 0,
  too_close_to_start: 1, beyond_actionable_horizon: 1,
  best_price_stale: 2, price_below_tradeable_bound: 2, price_above_tradeable_bound: 2,
  best_price_outlier_abs: 3, best_price_outlier_ratio: 3, best_price_outlier_mad: 3,
  best_price_outlier_decimal: 3,
  reference_market_not_two_sided: 4, insufficient_fresh_books: 4,
  insufficient_independent_books: 4, sharp_quote_stale: 4,
  consensus_dispersion_too_high: 5, fair_not_computable: 5,
  edge_not_computable: 6, edge_implausible_bad_price: 6,
  segment_not_qualified_for_action: 6, below_segment_edge_floor: 6,
  awaiting_confirmation: 7,
  below_quality_floor: 8,
  ok: 9,
};

/** How many gates this verdict cleared. `ok` clears all of them. An unmapped
    reason returns 0 rather than silently counting as a pass — a new rejection
    reason that nobody added to the table must show up as a hole in the funnel,
    not as a phantom success. */
export function stagesPassed(reason: string): number {
  const s = STAGE_OF_REASON[reason];
  return s === undefined ? 0 : s;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 6 — POSTGREST
//
// Everything the supabase-js client was used for here, without the import. See
// "WHY THIS FILE HAS NO IMPORTS".
// ═══════════════════════════════════════════════════════════════════════════

export interface RestResult { rows: any[]; error: string | null; count: number | null }
export interface Rest {
  select(path: string): Promise<RestResult>;
  insert(table: string, rows: any[], opts: { onConflict?: string; ignoreDuplicates?: boolean; returning?: string }): Promise<RestResult>;
  patch(table: string, filter: string, patchBody: any, returning: string): Promise<RestResult>;
}

export function makeRest(url: string, key: string, timeoutMs = 20000): Rest {
  const base = url.replace(/\/+$/, "") + "/rest/v1/";
  const headers = (extra: Record<string, string>) => ({
    apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...extra,
  });
  const signal = () => {
    try { return (AbortSignal as any).timeout ? (AbortSignal as any).timeout(timeoutMs) : undefined; }
    catch { return undefined; }
  };
  const run = async (path: string, init: any): Promise<{ rows: any[]; error: string | null; count: number | null }> => {
    try {
      const r = await fetch(base + path, { ...init, signal: signal() });
      const text = await r.text().catch(() => "");
      /* Content-Range is how PostgREST reports how many rows a write actually
         affected when nothing is returned. v8 reported rows SENT and called them
         rows written, which is the same class of error as counting PATCH requests
         that did not 500 as signals frozen. `null` here means the server did not
         say, and the caller must label its number accordingly rather than
         inventing one. */
      const cr = r.headers.get("content-range") ?? "";
      const m = /\/(\d+)$/.exec(cr);
      const count = m ? Number(m[1]) : null;
      if (!r.ok) return { rows: [], error: `HTTP ${r.status}: ${text.slice(0, 300)}`, count: null };
      if (!text) return { rows: [], error: null, count };
      try { return { rows: JSON.parse(text), error: null, count }; } catch { return { rows: [], error: null, count }; }
    } catch (e) { return { rows: [], error: String((e as Error)?.message ?? e), count: null }; }
  };
  return {
    select: (path) => run(path, { method: "GET", headers: headers({}) }),
    insert: (table, rows, opts) => {
      const qs = opts.onConflict ? `?on_conflict=${encodeURIComponent(opts.onConflict)}` : "";
      const sel = opts.returning ? `${qs ? "&" : "?"}select=${encodeURIComponent(opts.returning)}` : "";
      return run(table + qs + sel, {
        method: "POST",
        headers: headers({
          Prefer: [
            opts.onConflict ? (opts.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates") : "",
            opts.returning ? "return=representation" : "return=minimal",
            "count=exact",
          ].filter(Boolean).join(","),
        }),
        body: JSON.stringify(rows),
      });
    },
    patch: (table, filter, patchBody, returning) => run(
      `${table}?${filter}&select=${encodeURIComponent(returning)}`,
      { method: "PATCH", headers: headers({ Prefer: "return=representation" }), body: JSON.stringify(patchBody) },
    ),
  };
}

/**
 * The name of a column PostgREST says it does not have.
 *
 * WHY THIS EXISTS. This function is deployed by pasting it into a dashboard
 * editor, and the migration that adds its new columns is run separately by a
 * human. Those two events happen in whichever order they happen. Without this,
 * deploying before running the SQL means every write 400s and the board goes
 * dark until somebody reads the logs; with it, capture drops the columns the
 * database does not have, keeps writing everything else, and says loudly in
 * `schema_gaps` exactly which migration is missing. Degrade, name the cause,
 * never go silent.
 */
export function missingColumnFrom(error: string | null): string | null {
  if (!error) return null;
  const m = /Could not find the '([^']+)' column/.exec(error)
    ?? /column "?([a-z0-9_]+)"? of relation/i.exec(error)
    ?? /column ([a-z0-9_]+) does not exist/i.exec(error);
  return m ? m[1] : null;
}

export function dropColumns(rows: any[], cols: Set<string>): any[] {
  if (!cols.size) return rows;
  return rows.map((r) => {
    const o: any = {};
    for (const k in r) if (!cols.has(k)) o[k] = r[k];
    return o;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 7 — ODDS API
// ═══════════════════════════════════════════════════════════════════════════

const ODDS_BASE = "https://api.the-odds-api.com/v4";

export interface OddsResult {
  data: any[]; ok: boolean; status: number; detail: string;
  quotaRemaining: string; quotaUsed: string; lastCost: string;
}

/**
 * Fetch the board for one sport.
 *
 * Returns the STATUS on failure. "errored" without a status cannot be acted on:
 * 401 (bad key), 422 (rotated sport key) and 429 (quota exhausted) need three
 * different fixes and were indistinguishable before v5.
 *
 * `bookmakers` and `regions` are mutually exclusive at the provider. An explicit
 * bookmaker list is the only way to reach Pinnacle (an `eu` book) and the US
 * retail books in a single request; `?probe=1` measures what each actually costs
 * on this account rather than trusting a docs page.
 */
export async function fetchOdds(key: string, sport: string, cfg: Config): Promise<OddsResult> {
  const sel = cfg.bookmakers.length
    ? `bookmakers=${encodeURIComponent(cfg.bookmakers.join(","))}`
    : `regions=${encodeURIComponent(cfg.regions)}`;
  const u = `${ODDS_BASE}/sports/${encodeURIComponent(sport)}/odds/?apiKey=${encodeURIComponent(key)}`
    + `&${sel}&markets=${encodeURIComponent(cfg.markets)}&oddsFormat=decimal&dateFormat=iso`;
  try {
    const r = await fetch(u);
    const h = (n: string) => r.headers.get(n) ?? "";
    const meta = { quotaRemaining: h("x-requests-remaining"), quotaUsed: h("x-requests-used"), lastCost: h("x-requests-last") };
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { data: [], ok: false, status: r.status, detail: body.slice(0, 240), ...meta };
    }
    const data = await r.json();
    return { data: Array.isArray(data) ? data : [], ok: true, status: 200, detail: "", ...meta };
  } catch (e) {
    return { data: [], ok: false, status: 0, detail: String((e as Error)?.message ?? e), quotaRemaining: "", quotaUsed: "", lastCost: "" };
  }
}

/**
 * The event index for one sport, WITHOUT odds.
 *
 * `/v4/sports/{sport}/events` does not count against the quota. That makes it a
 * free way to ask "does this sport have anything starting soon" before spending
 * a billed odds request on it — which is the only honest cadence lever
 * available, because the odds endpoint returns the whole board per call and a
 * far-out game therefore costs nothing extra. What costs is calling often, for
 * sports with nothing to price.
 *
 * A failure here returns ok:false and the CALLER CAPTURES THE SPORT ANYWAY.
 * Skipping a sport because a free optimisation call failed would turn a
 * cost-saving into an outage.
 */
export async function fetchEvents(key: string, sport: string): Promise<{ commences: number[]; ok: boolean }> {
  try {
    const r = await fetch(`${ODDS_BASE}/sports/${encodeURIComponent(sport)}/events/?apiKey=${encodeURIComponent(key)}`);
    if (!r.ok) return { commences: [], ok: false };
    const list = await r.json();
    if (!Array.isArray(list)) return { commences: [], ok: false };
    return { commences: list.map((e: any) => Date.parse(e?.commence_time)).filter((t: number) => Number.isFinite(t)), ok: true };
  } catch { return { commences: [], ok: false }; }
}

export async function fetchActiveSports(key: string): Promise<{ keys: string[]; ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${ODDS_BASE}/sports/?apiKey=${encodeURIComponent(key)}`);
    if (!r.ok) return { keys: [], ok: false, detail: `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
    const list = await r.json();
    return { keys: (list ?? []).filter((s: any) => s.active && !s.has_outrights).map((s: any) => s.key), ok: true, detail: "" };
  } catch (e) {
    return { keys: [], ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 8 — ROW SHAPES
// ═══════════════════════════════════════════════════════════════════════════

export function canonicalTitle(sportKey: string, sportTitle: string): string {
  const k = String(sportKey ?? "");
  if (k.startsWith("americanfootball_nfl")) return "NFL";
  if (k.startsWith("americanfootball_ncaaf")) return "NCAAF";
  return sportTitle;
}

/** The columns that describe RIGHT NOW. Phase B sends exactly these and no
    first_* column, which is the entire mechanism protecting the opening
    snapshot. Identity columns are present so the payload is a valid row. */
export function liveRow(r: any): any {
  const o: any = {};
  for (const k in r) if (!k.startsWith("first_")) o[k] = r[k];
  return o;
}

export function signalRow(c: Candidate, v: Verdict, nowIso: string): any {
  return {
    sig_key: sigKey(c),
    event_id: c.event_id, sport_key: c.sport_key,
    sport_title: canonicalTitle(c.sport_key, c.sport_title),
    commence_time: c.commence_time, home_team: c.home_team, away_team: c.away_team,
    market: c.market, selection: c.selection, point: c.point,

    last_seen_at: nowIso,
    best_dec: v.best_dec, best_book: v.best_book_title,
    /* `sharp_fair` keeps its established meaning across the whole stack: THE FAIR
       EDGEDESK ANCHORED ON. What changes in v9 is that `reference_type` now says
       what that anchor actually was, and `sharp_book_fair` carries the reference
       book's own number and is NULL whenever there wasn't one. A reader can no
       longer be fooled, and no existing consumer breaks. */
    sharp_fair: v.fair_probability ?? v.consensus_fair,
    sharp_book_fair: v.sharp_book_fair,
    consensus_fair: v.consensus_fair,
    edge: v.edge,
    is_plus_ev: v.edge != null && v.edge > 0,
    n_books: v.total_books,
    n_books_eff: v.families,
    has_sharp: v.has_sharp,
    is_fav: v.is_fav,
    pin_dec: v.pin_dec, pin_opp_dec: v.pin_opp_dec,
    corrob_n: v.corrob_n, corrob_ref: v.corrob_ref, corrob_levels: v.corrob_levels,

    // v9 qualification state — written on EVERY row, actionable or not.
    qual_tier: v.tier,
    qual_reason: v.reason,
    qual_streak: v.confirmations,
    reference_type: v.reference_type,
    reference_book: v.reference_book,
    quality_score: v.quality_score,
    quality_components: v.quality,
    fresh_books: v.fresh_books,
    dispersion: v.dispersion,
    ref_quote_age_s: v.reference_quote_age_s,
    best_quote_age_s: v.best_quote_age_s,
    edge_floor: v.edge_floor,
    qual_segment: v.segment,
    point_is_modal: v.point_is_modal,
    modal_point: v.modal_point,
    points_offered: c.points_offered,
    key_numbers_to_modal: v.key_numbers_to_modal,
    devig_method: c.devig_method,
    capture_policy: POLICY_VERSION,

    // OPENING fields. Written by phase A on first sighting and never again.
    first_seen_at: nowIso, first_best_dec: v.best_dec, first_best_book: v.best_book_title,
    first_sharp_fair: v.fair_probability ?? v.consensus_fair, first_edge: v.edge,
    first_has_sharp: v.has_sharp, first_corrob_n: v.corrob_n, first_corrob_ref: v.corrob_ref,
    first_reference_type: v.reference_type, first_qual_tier: v.tier,
  };
}

/** One row per book quoting an ACTIONABLE selection, with the freshness that
    decided whether it counted. This is the raw material for measuring book
    behaviour later, and it stores what was true at decision time rather than
    what a browser can re-fetch afterwards. */
export function bookQuoteRows(c: Candidate, v: Verdict, cfg: Config, nowIso: string): any[] {
  const key = sigKey(c);
  return c.quotes.map((q) => ({
    sig_key: key, book_key: q.book, book_title: q.title,
    dec: q.dec, opp_dec: q.oppDec, fair: q.fair,
    quote_age_s: q.ageS, is_fresh: q.fresh,
    is_reference: cfg.referenceBooks.includes(q.book),
    book_family: q.family, book_tier: q.tier,
    is_best: q.book === v.best_book,
    updated_at: nowIso,
  }));
}

export function tickRow(c: Candidate, v: Verdict, nowIso: string): any {
  return {
    sig_key: sigKey(c),
    /* The CAPTURE instant, not the insert instant. `created_at` has a database
       default and capture never wrote it, so on a run that takes 100 seconds the
       ticks carried whatever time each batch happened to land. The close pipeline
       picks "the last tick at or before commence_time" as a closing price, so a
       tick's timestamp is load-bearing for CLV. */
    created_at: nowIso,
    best_dec: v.best_dec, sharp_fair: v.fair_probability ?? v.consensus_fair,
    edge: v.edge, n_books: v.total_books,
    fresh_books: v.fresh_books, n_books_eff: v.families,
    qual_tier: v.tier, qual_reason: v.reason, reference_type: v.reference_type,
    quality_score: v.quality_score, ref_quote_age_s: v.reference_quote_age_s,
    actionable: v.actionable,
  };
}

/** The frozen anchor. Written once, guarded on flagged_at IS NULL, and never
    revisited — this is the entry EdgeDesk is graded against, and the reason the
    record cannot be rewritten by later market movement.

    v8 left flagged_corrob_n permanently NULL because it had no corroboration
    count to write. v9 computes one, so all eight columns are written together:
    anything left NULL at flag time can NEVER be filled later, because
    preserve_anchor_entry() coalesces old over new. */
export function flagRow(c: Candidate, v: Verdict, nowIso: string): any {
  return {
    sig_key: sigKey(c),
    flagged_at: nowIso,
    flagged_edge: v.edge,
    flagged_best_dec: v.best_dec,
    flagged_best_book: v.best_book_title,
    flagged_sharp_fair: v.fair_probability,
    flagged_has_sharp: v.has_sharp,
    flagged_corrob_n: v.corrob_n,
    flagged_tier: v.tier,
    flagged_reference_type: v.reference_type,
    flagged_quality_score: v.quality_score,
    flagged_fresh_books: v.fresh_books,
    flagged_policy: POLICY_VERSION,
    flagged_build: BUILD,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 9 — THE HANDLER
// ═══════════════════════════════════════════════════════════════════════════

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function explainWriteError(phase: string, e: string): string {
  const low = String(e).toLowerCase();
  if (low.includes("null value") && low.includes("first_")) {
    return `${phase}: ${e} — a first_* column is NOT NULL with no DEFAULT. Phase B omits the opening columns so it `
      + `can never overwrite them, but Postgres validates the proposed INSERT tuple even when the row already exists. `
      + `Make the first_* columns nullable and phase B will succeed.`;
  }
  if (low.includes("cannot affect row a second time")) {
    return `${phase}: ${e} — two rows in one batch shared a sig_key. Deduplication should prevent this; if it recurs, `
      + `sigKey() and the priceEvent slot key have drifted apart.`;
  }
  if (low.includes("could not find") && low.includes("column")) {
    return `${phase}: ${e} — run supabase/capture_v9_qualification.sql. Capture dropped this column and kept writing `
      + `the rest; see schema_gaps.`;
  }
  return `${phase}: ${e}`;
}

export async function handle(req: Request): Promise<Response> {
  const envGet: EnvGet = (k) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined);
  const cfg = defaultConfig(envGet);
  const CRON_SECRET = envGet("CRON_SECRET") ?? "";
  const ODDS_KEY = envGet("ODDS_API_KEY") ?? "";
  const SB_URL = envGet("SUPABASE_URL") ?? "";
  const SB_KEY = envGet("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams);
  const diag = params.diag === "1";
  const probe = params.probe === "1";

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const outOfTime = () => elapsed() > cfg.budgetMs;

  if (!(CRON_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SECRET)) {
    return json({
      ok: false, build: BUILD, error: "unauthorized",
      reason: CRON_SECRET === ""
        ? "CRON_SECRET is not set on this function, so every caller is rejected including the scheduler. Capture has "
          + "not run since the variable went missing. Set CRON_SECRET and make the cron send a matching x-cron-secret header."
        : "the x-cron-secret header did not match CRON_SECRET.",
    }, 401);
  }
  if (!ODDS_KEY) {
    return json({ ok: false, build: BUILD, error: "ODDS_API_KEY is not set", reason: "Every odds request would fail. Nothing was attempted." }, 500);
  }
  if (!diag && !probe && (!SB_URL || !SB_KEY)) {
    return json({ ok: false, build: BUILD, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set",
      reason: "Capture could price the board and would then discard every row. Refusing to run rather than reporting a successful empty pass." }, 500);
  }

  const rest = makeRest(SB_URL, SB_KEY);

  // ---- sports -------------------------------------------------------------
  const stable = cfg.sportsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  let sports: string[] = [], autoAdded: string[] = [], discoveryOk = true, discoveryDetail = "";
  if (!stable.length) {
    const all = await fetchActiveSports(ODDS_KEY);
    sports = all.keys; discoveryOk = all.ok; discoveryDetail = all.detail;
  } else {
    if (cfg.autoPrefixes.length) {
      const active = await fetchActiveSports(ODDS_KEY);
      discoveryOk = active.ok; discoveryDetail = active.detail;
      autoAdded = active.keys.filter((k) => cfg.autoPrefixes.some((p) => k.startsWith(p)) && !stable.includes(k));
    }
    sports = [...new Set([...stable, ...autoAdded])];
  }
  if (!sports.length) {
    return json({
      ok: false, build: BUILD, error: "no sports to capture",
      stable_sports: stable, auto_prefixes: cfg.autoPrefixes,
      sports_discovery_ok: discoveryOk, sports_discovery_error: discoveryDetail || null,
      reason: stable.length ? "CAPTURE_SPORTS is set but produced no keys after trimming."
        : discoveryOk ? "CAPTURE_SPORTS is empty and the /sports discovery call returned no active sports."
        : `CAPTURE_SPORTS is empty and the /sports discovery call FAILED (${discoveryDetail}), so the sport list is `
          + `empty for a reason that has nothing to do with the season.`,
    }, 500);
  }

  /* ?probe=1 — spend at most two odds requests on ONE sport and report which
     books each selection strategy actually returns, and what the provider
     charged for it. This is how the Pinnacle question and the billing question
     get answered with measurements instead of assumptions. Writes nothing. */
  if (probe) {
    const sport = sports[0];
    const byRegion = await fetchOdds(ODDS_KEY, sport, { ...cfg, bookmakers: [] });
    const byBooks = await fetchOdds(ODDS_KEY, sport, { ...cfg, bookmakers: cfg.bookmakers.length ? cfg.bookmakers : SUGGESTED_BOOKMAKERS });
    const booksOf = (r: OddsResult) => [...new Set(r.data.flatMap((e: any) => (e.bookmakers ?? []).map((b: any) => b.key)))].sort();
    const stampsOf = (r: OddsResult) => {
      let withMarket = 0, withBook = 0, none = 0;
      for (const e of r.data) for (const b of e.bookmakers ?? []) for (const m of b.markets ?? []) {
        if (m.last_update) withMarket++; else if (b.last_update) withBook++; else none++;
      }
      return { market_level: withMarket, book_level_only: withBook, none };
    };
    return json({
      ok: byRegion.ok || byBooks.ok, build: BUILD, mode: "probe", persistence: "skipped_intentionally",
      sport,
      by_regions: {
        regions: cfg.regions, ok: byRegion.ok, status: byRegion.status, events: byRegion.data.length,
        books: booksOf(byRegion), reference_present: booksOf(byRegion).some((b) => cfg.referenceBooks.includes(b)),
        cost_charged: byRegion.lastCost, quota_remaining: byRegion.quotaRemaining, timestamps: stampsOf(byRegion),
      },
      by_bookmakers: {
        bookmakers: cfg.bookmakers.length ? cfg.bookmakers : SUGGESTED_BOOKMAKERS,
        ok: byBooks.ok, status: byBooks.status, events: byBooks.data.length,
        books: booksOf(byBooks), reference_present: booksOf(byBooks).some((b) => cfg.referenceBooks.includes(b)),
        cost_charged: byBooks.lastCost, quota_remaining: byBooks.quotaRemaining, timestamps: stampsOf(byBooks),
      },
      expected_billing: `markets x regions. The bookmakers parameter substitutes for the regions term and is `
        + `charged in groups of ten, rounded up — so ${SUGGESTED_BOOKMAKERS.length} keys should cost the same as `
        + `ONE region, and an eleventh would double it. cost_charged below is the provider's own x-requests-last `
        + `header and is the only authority; if it disagrees with that formula, believe the header.`,
      how_to_read: "If by_bookmakers.reference_present is true and its cost_charged is at or below by_regions, set "
        + "CAPTURE_BOOKMAKERS and leave CAPTURE_REGIONS unused: that reaches Pinnacle for what the broken us-only "
        + "configuration used to cost. If `timestamps.none` is not 0, the feed is not sending update stamps for "
        + "some quotes and those quotes will never count as fresh — that is deliberate, but you should know it. "
        + "`market_level` counting 0 while `book_level_only` is large means this account's responses carry only "
        + "the bookmaker timestamp, which is coarser but still works.",
    });
  }

  // ---- the run ------------------------------------------------------------
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const sportList = diag ? sports.slice(0, 1) : sports;

  let priced = 0, inserted = 0, updated = 0, flagged = 0;
  let flagDeferred = 0, flagErrors = 0, ticksWritten = 0, tickErrors = 0;
  let quotesWritten = 0, quoteErrors = 0;
  let dupesDropped = 0, eventErrors = 0, duplicateQuotes = 0, malformedMarkets = 0, missingTimestamps = 0;
  let priorStateTruncated = false, updatedExact = true, ticksExact = true;
  /* THE FLAG CAP IS A RUN CAP. v8 applied FLAG_MAX inside the per-sport loop, so
     a response reporting `flag_max: 600` could freeze 600 signals PER SPORT — the
     documented ceiling was not a ceiling. This budget is decremented across the
     whole run. */
  let flagBudget = cfg.flagMax;
  const eventsSkippedForTime: Record<string, number> = {};

  const bookSet = new Set<string>();
  const refSeen = new Set<string>();
  const perSport: Record<string, number> = {};
  const perSportEvents: Record<string, number> = {};
  const errored: { sport: string; status: number; detail: string }[] = [];
  const eventErrorSamples: any[] = [];
  const skippedForTime: string[] = [];
  const skippedNoNearEvents: string[] = [];
  const writeErrors: string[] = [];
  const schemaGaps = new Set<string>();
  const rejected: Record<string, number> = {};
  const rejectSamples: any[] = [];
  const actionableSamples: any[] = [];
  const tierCounts: Record<string, number> = { A: 0, B: 0, PASS: 0 };
  const perSegment: Record<string, { candidates: number; actionable: number }> = {};
  let quotaRemaining = "", quotaUsed = "", quotaSpent = 0;
  /* THE FUNNEL. Every one of these answers a question the brief asks to be
     answerable from a single run, in order, without inference. */
  const funnel: any = {
    events_returned: 0, outcomes_priced: 0, quotes_seen: 0, quotes_fresh: 0,
    quotes_stale: 0, positive_raw_edge: 0,
    tier_a: 0, tier_b: 0, awaiting_confirmation: 0,
    reference_present_on_selection: 0, reference_fresh_on_selection: 0,
    no_reference_data: 0, actionable: 0,
  };
  const stagePassed: number[] = FUNNEL_STAGES.map(() => 0);

  for (const sport of sportList) {
    if (outOfTime()) { skippedForTime.push(sport); continue; }

    /* FREE CALL BEFORE A BILLED ONE. Only when explicitly configured — a sport
       with no near event still has a board worth storing for research, so this
       is a cadence tier the operator opts into, not a default. */
    if (cfg.nearHours > 0) {
      const idx = await fetchEvents(ODDS_KEY, sport);
      if (idx.ok) {
        const cutoff = nowMs + cfg.nearHours * 3600000;
        if (!idx.commences.some((t) => t >= nowMs - 3600000 && t <= cutoff)) {
          skippedNoNearEvents.push(sport);
          perSport[sport] = 0;
          continue;
        }
      }
      /* idx.ok === false: the free call failed, so capture the sport anyway.
         Skipping because an optimisation call failed would turn a cost saving
         into an outage. */
    }

    const res = await fetchOdds(ODDS_KEY, sport, cfg);
    if (res.quotaRemaining) quotaRemaining = res.quotaRemaining;
    if (res.quotaUsed) quotaUsed = res.quotaUsed;
    quotaSpent += Number(res.lastCost) || 0;
    if (!res.ok) { errored.push({ sport, status: res.status, detail: res.detail }); perSport[sport] = 0; continue; }

    perSportEvents[sport] = res.data.length;
    funnel.events_returned += res.data.length;

    /* PRIOR STATE for persistence, in ONE read per sport. A candidate whose prior
       streak is unknown is treated as 0, which requires it to re-confirm: the
       conservative direction, and the direction that cannot manufacture a signal
       out of missing data. */
    const priorStreak = new Map<string, number>();
    if (!diag) {
      const horizon = new Date(nowMs + cfg.maxDaysToStart * 86400000).toISOString();
      const { rows, error } = await rest.select(
        `signals?select=sig_key,qual_streak&sport_key=eq.${encodeURIComponent(sport)}`
        + `&commence_time=gte.${encodeURIComponent(nowIso)}&commence_time=lte.${encodeURIComponent(horizon)}&limit=20000`,
      );
      if (error) {
        if (missingColumnFrom(error)) schemaGaps.add(missingColumnFrom(error)!);
        else if (writeErrors.length < 8) writeErrors.push(explainWriteError("prior_state", error));
      } else {
        for (const r of rows) priorStreak.set(r.sig_key, Number(r.qual_streak) || 0);
        if (rows.length >= 20000) priorStateTruncated = true;
      }
    }

    const rows: any[] = [], ticks: any[] = [], toFlag: any[] = [], quotes: any[] = [];
    const seen = new Set<string>();

    for (const ev of res.data) {
      /* THE CLOCK IS CHECKED HERE TOO. v8 checked it at the top of the sport loop
         and inside the flag batches only, so a sport with 400 events could run
         hundreds of seconds past the budget before anything looked. Stopping mid
         sport is safe: everything already priced is written below. */
      if (outOfTime()) { eventsSkippedForTime[sport] = (eventsSkippedForTime[sport] ?? 0) + 1; continue; }
      /* ONE BAD EVENT IS NOT A BAD RUN. priceEvent is defensive, but it parses a
         third-party feed and this is the last place an unexpected shape can
         escape. Without it, an exception here unwinds out of the request handler
         and every remaining sport is lost to a bare 500 that the fire-and-forget
         cron caller never records. */
      let pe: PriceEventResult;
      try {
        for (const bk of ev?.bookmakers ?? []) {
          const k = String(bk?.key ?? "").toLowerCase();
          if (k) { bookSet.add(k); if (cfg.referenceBooks.includes(k)) refSeen.add(k); }
        }
        pe = priceEvent(ev, cfg, nowMs);
      } catch (e) {
        eventErrors++;
        if (eventErrorSamples.length < 5) eventErrorSamples.push({ sport, event_id: ev?.id ?? null, error: String((e as Error)?.message ?? e) });
        continue;
      }
      malformedMarkets += pe.malformed;
      missingTimestamps += pe.missingTimestamps;
      duplicateQuotes += pe.duplicateQuotes;

      for (const c of pe.candidates) {
        const key = sigKey(c);
        /* DEDUPE BEFORE THE WRITE. Postgres refuses an ON CONFLICT statement that
           touches the same row twice, and that error fails the entire chunk, not
           the duplicate — one malformed feed could discard a whole sport. */
        if (seen.has(key)) { dupesDropped++; continue; }
        seen.add(key);

        const v = qualifySignal(c, { priorStreak: priorStreak.get(key) ?? 0, nowMs }, cfg);

        priced++;
        funnel.outcomes_priced++;
        funnel.quotes_seen += c.quotes.length;
        funnel.quotes_fresh += v.fresh_books;
        funnel.quotes_stale += (c.quotes.length - v.fresh_books);
        if (v.edge != null && v.edge > 0) funnel.positive_raw_edge++;
        if (v.reference_book) funnel.reference_present_on_selection++;
        if (v.has_sharp) funnel.reference_fresh_on_selection++;
        if (v.reference_type === "none") funnel.no_reference_data++;
        if (v.reason === "awaiting_confirmation") funnel.awaiting_confirmation++;
        tierCounts[v.tier] = (tierCounts[v.tier] ?? 0) + 1;

        const seg = v.segment;
        const bucket = perSegment[seg] ?? (perSegment[seg] = { candidates: 0, actionable: 0 });
        bucket.candidates++;

        /* Monotonic by construction: a candidate that stopped at stage k passed
           stages 0..k-1, so the drop between two adjacent counters is the cost of
           exactly one rule. */
        const reached = stagesPassed(v.reason);
        for (let s = 0; s < reached; s++) stagePassed[s]++;

        rows.push(signalRow(c, v, nowIso));
        if (cfg.ticks) ticks.push(tickRow(c, v, nowIso));

        if (v.actionable) {
          funnel.actionable++;
          bucket.actionable++;
          if (v.tier === "A") funnel.tier_a++; else funnel.tier_b++;
          if (actionableSamples.length < 15) {
            actionableSamples.push({
              sport, market: c.market, selection: c.selection, point: c.point,
              tier: v.tier, reference_type: v.reference_type, edge: +(v.edge ?? 0).toFixed(4),
              floor: v.edge_floor, best_dec: v.best_dec, best_book: v.best_book,
              fresh_books: v.fresh_books, families: v.families, dispersion: +v.dispersion.toFixed(4),
              ref_age_s: v.reference_quote_age_s, quality: v.quality_score, streak: v.confirmations,
            });
          }
          toFlag.push({ row: flagRow(c, v, nowIso), edge: v.edge ?? 0 });
          if (cfg.bookQuotes) quotes.push(...bookQuoteRows(c, v, cfg, nowIso));
        } else {
          rejected[v.reason] = (rejected[v.reason] ?? 0) + 1;
          if (v.edge != null && v.edge > 0 && rejectSamples.length < 20) {
            rejectSamples.push({
              reason: v.reason, sport, market: c.market, selection: c.selection, point: c.point,
              edge: +v.edge.toFixed(4), floor: v.edge_floor, best_dec: v.best_dec, median_dec: +v.median_dec.toFixed(3),
              n_books: v.total_books, fresh_books: v.fresh_books, families: v.families,
              ref_type: v.reference_type, ref_age_s: v.reference_quote_age_s, best_book: v.best_book,
            });
          }
        }
      }
    }
    perSport[sport] = rows.length;
    if (diag) continue;   // diagnostics never write

    /* ── PHASE A — insert brand-new signals only. ───────────────────────────
       `returning: sig_key` is what makes phase B safe: it tells us which rows
       exist, so phase B can never INSERT a row with a NULL opening snapshot that
       nothing would ever be able to fill. */
    /* WHICH ROWS ARE SAFE FOR PHASE B.
       Phase A is an ignore-duplicates upsert, so a chunk that returns without an
       error leaves EVERY row in it present in the table — either newly inserted
       or already there. That makes the whole chunk safe for phase B and needs no
       confirming read.

       What is not safe is a row in a chunk that ERRORED. Those rows may not
       exist, and phase B is an upsert: sending one would INSERT it with every
       first_* column NULL, permanently, because phase A ignores duplicates and
       could never fill them on a later run. So an errored chunk is excluded from
       phase B entirely and the run reports the write error. A refreshed live
       column is worth less than an opening snapshot that can never be recovered. */
    const existing = new Set<string>();
    for (let i = 0; i < rows.length && !outOfTime(); i += 500) {
      const slice = rows.slice(i, i + 500);
      let chunk = dropColumns(slice, schemaGaps);
      for (let attempt = 0; attempt < 12; attempt++) {
        const { rows: got, error } = await rest.insert("signals", chunk, { onConflict: "sig_key", ignoreDuplicates: true, returning: "sig_key" });
        if (!error) {
          inserted += got.length;
          for (const r of slice) existing.add(r.sig_key);
          break;
        }
        const col = missingColumnFrom(error);
        if (col) { schemaGaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
        if (writeErrors.length < 8) writeErrors.push(explainWriteError("insert", error));
        break;
      }
    }

    /* ── PHASE B — refresh the live columns. Cannot touch an opening field. ── */
    const live = rows.filter((r) => existing.has(r.sig_key)).map(liveRow);
    for (let i = 0; i < live.length && !outOfTime(); i += 500) {
      let chunk = dropColumns(live.slice(i, i + 500), schemaGaps);
      for (let attempt = 0; attempt < 12; attempt++) {
        const { error, count } = await rest.insert("signals", chunk, { onConflict: "sig_key", ignoreDuplicates: false });
        /* The server's count when it gives one, the rows sent when it does not —
           and `refreshed_is_exact` says which, rather than presenting a guess as
           a measurement. */
        if (!error) { updated += count ?? chunk.length; if (count == null) updatedExact = false; break; }
        const col = missingColumnFrom(error);
        if (col) { schemaGaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
        if (writeErrors.length < 8) writeErrors.push(explainWriteError("update", error));
        break;
      }
    }

    /* ── PHASE C — freeze the entry the first time it qualifies. ────────────
       Guarded on flagged_at IS NULL so it is written once and never drifts. Over
       the cap, take the STRONGEST edges now and DEFER the rest — they stay
       unflagged, so the next run picks them up and the backlog drains rather
       than the batch being dropped. */
    toFlag.sort((a, b) => b.edge - a.edge);
    const flagNow = toFlag.slice(0, Math.max(0, flagBudget));
    flagBudget -= flagNow.length;
    flagDeferred += Math.max(0, toFlag.length - flagNow.length);
    for (let i = 0; i < flagNow.length; i += cfg.flagConcurrency) {
      const batch = flagNow.slice(i, i + cfg.flagConcurrency);
      const results = await Promise.all(batch.map(async (f) => {
        let body = dropColumns([f.row], schemaGaps)[0];
        for (let attempt = 0; attempt < 12; attempt++) {
          const { rows: got, error } = await rest.patch(
            "signals",
            `sig_key=eq.${encodeURIComponent(f.row.sig_key)}&flagged_at=is.null`,
            body, "sig_key",
          );
          if (!error) return { frozen: got.length, error: null as string | null };
          const col = missingColumnFrom(error);
          if (col) { schemaGaps.add(col); body = dropColumns([body], new Set([col]))[0]; continue; }
          return { frozen: 0, error };
        }
        return { frozen: 0, error: "flag: exhausted schema retries" };
      }));
      for (const r of results) {
        if (r.error) {
          flagErrors++;
          if (writeErrors.length < 8) writeErrors.push(explainWriteError("flag", r.error));
          continue;
        }
        /* COUNT WHAT THE DATABASE ACTUALLY FROZE. v8 counted every PATCH that did
           not error — but the guard means an already-flagged row matches nothing
           and still succeeds, so the headline number was "requests that did not
           500", not "signals that entered the record". */
        flagged += r.frozen;
      }
      if (outOfTime()) { flagDeferred += flagNow.length - (i + batch.length); break; }
    }

    /* Per-book quotes for the actionable set. Upserted on (sig_key, book_key) —
       the database's own trigger appends the changed ones to book_quote_ticks,
       so the history accumulates without capture having to manage it. */
    for (let i = 0; cfg.bookQuotes && i < quotes.length && !outOfTime(); i += 500) {
      let chunk = dropColumns(quotes.slice(i, i + 500), schemaGaps);
      for (let attempt = 0; attempt < 12; attempt++) {
        const { error, count } = await rest.insert("book_quotes", chunk, { onConflict: "sig_key,book_key", ignoreDuplicates: false });
        if (!error) { quotesWritten += count ?? chunk.length; break; }
        const col = missingColumnFrom(error);
        if (col) { schemaGaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
        quoteErrors++;
        if (writeErrors.length < 8) writeErrors.push(explainWriteError("book_quotes", error));
        break;
      }
    }

    /* Tick history: the only thing that can grade a signal whose market key has
       rotated out of existence, and the entire input to the market residual. Its
       errors are checked, never discarded. */
    for (let i = 0; cfg.ticks && i < ticks.length && !outOfTime(); i += 500) {
      let chunk = dropColumns(ticks.slice(i, i + 500), schemaGaps);
      for (let attempt = 0; attempt < 12; attempt++) {
        const { error, count } = await rest.insert("signal_ticks", chunk, {});
        if (!error) { ticksWritten += count ?? chunk.length; if (count == null) ticksExact = false; break; }
        const col = missingColumnFrom(error);
        if (col) { schemaGaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
        tickErrors++;
        if (writeErrors.length < 8) writeErrors.push(explainWriteError("ticks", error));
        break;
      }
    }
  }

  const books = [...bookSet].sort();
  const referencePresent = refSeen.size > 0;
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  const capturedNothing = priced === 0;
  const allErrored = errored.length === sportList.length;

  const status = diag ? "diagnostic"
    : capturedNothing ? "failed"
    : (errored.length || eventErrors || writeErrors.length || skippedForTime.length || schemaGaps.size) ? "partial" : "ok";

  const body: any = {
    ok: diag ? (!allErrored && !capturedNothing) : !capturedNothing,
    status, build: BUILD, policy: POLICY_VERSION,

    ...(diag ? {
      mode: "diagnostic",
      note: "One sport priced. NOTHING was written — no signals, no flags, no ticks. Persistence streaks read as 0, "
        + "so any Tier B candidate needing confirmation shows as awaiting_confirmation here even if it would flag live.",
      persistence: "skipped_intentionally",
      diag_scope_sport: sportList[0] ?? null,
    } : {}),

    ...(capturedNothing && !diag ? {
      error: allErrored
        ? "every sport's odds request failed — see `errored` for the HTTP status of each"
        : "no outcomes priced from any sport; the feed returned events with no usable two-sided markets",
    } : {}),

    // ── THE FUNNEL. One run, every question in Phase 21, in order. ──────────
    funnel: {
      ...funnel,
      stages: FUNNEL_STAGES.map((name, i) => ({ stage: name, passed: stagePassed[i] })),
    },
    tier_counts: tierCounts,
    per_segment: perSegment,
    rejected_by_reason: rejected,
    rejected_total: rejectedTotal,
    ...(rejectSamples.length ? { rejected_samples: rejectSamples } : {}),
    ...(actionableSamples.length ? { actionable_samples: actionableSamples } : {}),

    // ── reference / market coverage ────────────────────────────────────────
    reference_books: cfg.referenceBooks,
    reference_present: referencePresent,
    reference_books_seen: [...refSeen].sort(),
    ...(referencePresent ? {} : {
      reference_warning: `NONE of the configured reference books (${cfg.referenceBooks.join(", ")}) appeared in any `
        + `response. Every signal this run is Tier B at best. Pinnacle is not in the Odds API 'us' region — if `
        + `CAPTURE_REGIONS does not include 'eu', or CAPTURE_BOOKMAKERS does not name it, Tier A is unreachable by `
        + `construction. Call ?probe=1 to see exactly which books each strategy returns and what it costs.`,
    }),
    selection_strategy: cfg.bookmakers.length ? "bookmakers" : "regions",
    regions: cfg.bookmakers.length ? null : cfg.regions,
    bookmakers: cfg.bookmakers.length ? cfg.bookmakers : null,
    books_seen: books,
    quotes_missing_timestamp: missingTimestamps,
    ...(missingTimestamps > 0 ? {
      freshness_warning: `${missingTimestamps} quote(s) arrived with no usable update timestamp and were treated as `
        + `${cfg.treatMissingTimestampAsFresh ? "FRESH (CAPTURE_MISSING_TS_FRESH is on — this is a downgrade)" : "STALE"}. `
        + `If this is most of the feed, freshness has silently stopped working and every consensus count is wrong.`,
    } : {}),

    // ── sport resolution ───────────────────────────────────────────────────
    stable_sports: stable, auto_prefixes: cfg.autoPrefixes, auto_added: autoAdded,
    sports_discovery_ok: discoveryOk,
    ...(discoveryDetail ? { sports_discovery_error: discoveryDetail } : {}),
    sports: sportList.length, sports_list: sportList,
    per_sport: perSport, per_sport_events: perSportEvents,
    ...(errored.length ? { errored } : {}),
    ...(eventErrors ? { event_pricing_failures: eventErrors, event_pricing_error_samples: eventErrorSamples } : {}),

    // ── writes ─────────────────────────────────────────────────────────────
    priced,
    new_signals: inserted, refreshed: updated, refreshed_is_exact: updatedExact,
    flag_frozen: flagged, flag_max: cfg.flagMax,
    ...(flagDeferred ? { flag_deferred_to_next_run: flagDeferred } : {}),
    ...(flagErrors ? { flag_write_failures: flagErrors } : {}),
    ...(dupesDropped ? { duplicate_sig_keys_dropped: dupesDropped } : {}),
    ...(duplicateQuotes ? { duplicate_book_quotes_dropped: duplicateQuotes } : {}),
    ...(malformedMarkets ? { malformed_markets_skipped: malformedMarkets } : {}),
    ticks_enabled: cfg.ticks, ticks_written: ticksWritten, ticks_written_is_exact: ticksExact,
    book_quotes_enabled: cfg.bookQuotes, book_quotes_written: quotesWritten,
    ...(quoteErrors ? { book_quote_write_failures: quoteErrors } : {}),
    ...(tickErrors ? { tick_write_failures: tickErrors } : {}),
    ...(writeErrors.length ? { write_errors: writeErrors } : {}),
    ...(schemaGaps.size ? {
      schema_gaps: [...schemaGaps].sort(),
      schema_warning: "These columns do not exist in the database, so capture DROPPED them and wrote everything else. "
        + "Run supabase/capture_v9_qualification.sql. Until then the qualification metadata is not being persisted, "
        + "which means persistence streaks reset every run and Tier B can never confirm.",
    } : {}),
    ...(priorStateTruncated ? {
      persistence_warning: "The prior-state read hit its 20,000-row limit, so some candidates were treated as having "
        + "no history and must re-confirm. Narrow CAPTURE_MAX_DAYS_TO_START or split the sports list.",
    } : {}),

    // ── clock and quota ────────────────────────────────────────────────────
    elapsed_ms: elapsed(), budget_ms: cfg.budgetMs,
    ...(Object.keys(eventsSkippedForTime).length ? { events_skipped_for_time: eventsSkippedForTime } : {}),
    ...(skippedNoNearEvents.length ? {
      sports_skipped_no_near_events: skippedNoNearEvents,
      near_hours: cfg.nearHours,
      cadence_note: `CAPTURE_NEAR_HOURS=${cfg.nearHours}: these sports had no event starting inside the window, `
        + `so their billed odds request was skipped. The check itself used the free event index. Their boards `
        + `are NOT being stored while this is set.`,
    } : {}),
    ...(skippedForTime.length ? {
      sports_skipped_for_time: skippedForTime,
      time_warning: `Ran out of clock after ${elapsed()}ms. ${skippedForTime.length} sport(s) were not captured this `
        + `run. Everything written before the cutoff is committed.`,
    } : {}),
    quota_remaining: quotaRemaining, quota_used: quotaUsed, quota_spent_this_run: quotaSpent,

    // ── the policy in force, echoed so a run explains its own decisions ────
    policy_in_force: {
      reference_books: cfg.referenceBooks,
      edge_floor: cfg.edgeFloor,
      book_requirements: cfg.bookRequirements,
      confirmations: cfg.confirmations,
      max_dispersion: cfg.maxDispersion,
      freshness: cfg.freshnessPolicy,
      devig: cfg.devigPolicy,
      min_quality_score: cfg.minQualityScore,
      outlier: {
        max_abs_prob_dev: cfg.maxAbsProbDev, min_prob_ratio: cfg.minProbRatio,
        max_mad_z: cfg.maxMadZ, max_best_vs_median_dec: cfg.maxBestVsMedianDec,
      },
      note: "A candidate that fails any of these is STORED with its reason in qual_reason and is never actionable. "
        + "Zero actionable signals is a valid outcome and is not the same as a broken run — compare `funnel` stages.",
    },
  };

  console.log(diag ? "CAPTURE DIAG" : "CAPTURE", JSON.stringify(body));
  return json(body, body.ok ? 200 : 500);
}

/* Guarded exactly as edgedesk_ai/index.ts is, so tools/capture/capture.test.js
   can import this file and call handle() directly without a server starting. */
if (typeof Deno !== "undefined" && (Deno as any).serve && !Deno.env.get("CAPTURE_NO_SERVE")) {
  Deno.serve(handle);
}
