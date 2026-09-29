// ============================================================
//  FILE:    supabase/functions/capture/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy capture --no-verify-jwt
//  BUILD:   capture-v11-player-props-r1   (authoritative value: `export const BUILD` below)
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
// v10 — ALTERNATE LINES
//
//   `alternate_spreads` and `alternate_totals` exist only on the event-level
//   endpoint (/events/{id}/odds). The DAY and NEAR tiers buy them for football
//   events inside their window, merge each response into its event BEFORE
//   priceEvent(), and canonicalMarket() files them under `spreads` / `totals`.
//   The point stays in sigKey(), so -3 and -3.5 remain two bets; a ladder that
//   repeats the featured number at the same book keeps the featured quote.
//
// v11 — PLAYER PROPS
//
//   THE PLAYER IS IN `description`, NOT `name`. A player outcome reads
//   { name: "Over", description: "Patrick Mahomes", price, point }. Keyed the way
//   game markets are keyed — event|market|selection|point — Mahomes Over 274.5
//   and Josh Allen Over 274.5 are ONE row, and devigging one book's player
//   market as a single outcome space averages every quarterback on the slate
//   into one probability. So a player market is identified by the player at
//   every step: the partition that pairs Over with Under (partitionPlayer-
//   PropOutcomes), the priceEvent slot, the point census, sigKey() and the
//   quote key. Game-market sig_keys are byte-for-byte what they were.
//
//   CAPTURED IS NOT QUALIFIED. Every quote the provider returns for an eligible
//   event is stored in player_prop_quotes (current) and player_prop_quote_ticks
//   (change-only history) so a reader can line-shop it, including one-sided
//   markets that have no honest fair value. Qualification is separate: only a
//   two-sided Over/Under at one player's exact line can reach qualifySignal(),
//   and the player-prop policy family has NO edge floor, so nothing here
//   becomes an actionable EdgeDesk signal until a floor is earned from history.
//   POLICY_VERSION is unchanged because no actionable rule changed.
//
//   GAME LINES COME FIRST. Props run in a second pass after every sport's game
//   lines are written, on their own credit budget, their own per-event refresh
//   clock and a quota floor, so a Saturday slate cannot starve a spread of its
//   write or drain the account.
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

/* RETIRED SPORTS (lib/edgedesk_sports.js, inlined by tools/presentation/inline.js).
   A retired sport is never requested from the odds provider, whatever
   CAPTURE_SPORTS, CAPTURE_AUTO_PREFIXES or discovery say. */
/*__EDSPORTS_START__*/
/* ===========================================================================
   EdgeDesk SPORTS — which sports are a current product, and which are retired.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - app.html                               (research routes, live pools, record)
     - record.html                            (the public record's default view)
     - supabase/functions/edgedesk_ai/index.ts (the desk's support boundary)
     - supabase/functions/capture/index.ts    (never buy odds for a retired sport)
     - supabase/functions/close/index.ts      (never buy a live close for one)
   by tools/presentation/inline.js; presentation_sync.test.js and
   tools/app/sports_config.test.js fail when a copy drifts or a host stops
   honouring it. Edit THIS file, then `node tools/presentation/inline.js`.

   RETIRING A SPORT IS AN EDIT HERE, NOT A HUNT. Add an entry to RETIRED and
   every host above follows: capture stops requesting its odds, close stops
   requesting its closes, the desk answers questions about it with the support
   boundary instead of research, the terminal's live pools and default record
   drop it, and its old research routes land on RESEARCH_DEFAULT. What is NOT
   automatic, and is pinned by tests instead: removing its tab and panel from
   the Research navigation, and removing it from the board's SUPPORTED list.

   RETIRED IS NOT DELETED. Nothing here touches stored rows. Historical signals,
   grades, model outputs and research records stay exactly where they are; a
   retired sport is only excluded from what the product offers today, and the
   terminal's record keeps an explicit archive view that includes it.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDSPORTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;

  /* What the Research shell covers today, in its navigation order. This is the
     list the desk quotes when it declines a retired sport, and the list the
     navigation test holds the Research tabs to. */
  var RESEARCH_COVERAGE = [
    { id: 'football', label: 'Football' },
    { id: 'ufc', label: 'UFC' },
    { id: 'baseball', label: 'Baseball' }
  ];
  /* Where a retired research module's old route lands: the shell's default. */
  var RESEARCH_DEFAULT = 'football';

  /* Retired sports. `key_prefixes` match an Odds API sport_key; `modules` are
     the Research shell ids that once served it; `title` catches stored rows
     written before capture kept a sport_key; `words` recognise a question that
     is about the sport (tour and event names, never a bare "match" or "set"). */
  var RETIRED = [
    {
      id: 'tennis', label: 'Tennis', retired_on: '2026-09-27',
      key_prefixes: ['tennis_'],
      modules: ['tennis', 'wta'],
      title: /^(ATP|WTA)\b|\btennis\b/i,
      words: /\b(tennis|atp|wta|wimbledon|roland[- ]garros|french open|us open tennis|australian open|davis cup|billie jean king cup)\b/i
    }
  ];

  function str(v) { return v == null ? '' : String(v); }

  /* The retired entry a sport key (or a bare sport id such as "tennis") belongs to. */
  function retiredByKey(key) {
    var k = str(key).toLowerCase();
    if (!k) return null;
    for (var i = 0; i < RETIRED.length; i++) {
      var s = RETIRED[i];
      if (k === s.id) return s;
      for (var j = 0; j < s.key_prefixes.length; j++) if (k.indexOf(s.key_prefixes[j]) === 0) return s;
    }
    return null;
  }
  function isRetiredKey(key) { return !!retiredByKey(key); }

  /* A stored row: its sport_key decides; a row with no key falls back to its title. */
  function retiredOfRow(r) {
    if (!r) return null;
    var k = str(r.sport_key);
    if (k) return retiredByKey(k);
    var t = str(r.sport_title);
    for (var i = 0; i < RETIRED.length; i++) if (t && RETIRED[i].title.test(t)) return RETIRED[i];
    return null;
  }
  function isRetiredRow(r) { return !!retiredOfRow(r); }
  function dropRetired(rows) {
    var out = [];
    if (!rows || !rows.length) return out;
    for (var i = 0; i < rows.length; i++) if (!retiredOfRow(rows[i])) out.push(rows[i]);
    return out;
  }
  /* Keep only the sport keys a current product may use. */
  function keepCurrentKeys(keys) {
    var out = [];
    for (var i = 0; i < (keys || []).length; i++) if (!isRetiredKey(keys[i])) out.push(keys[i]);
    return out;
  }
  function retiredPrefixes() {
    var out = [];
    for (var i = 0; i < RETIRED.length; i++) out = out.concat(RETIRED[i].key_prefixes);
    return out;
  }

  /* The retired sport a piece of text is about, or null. */
  function retiredNamedIn(text) {
    var q = str(text);
    if (!q) return null;
    for (var i = 0; i < RETIRED.length; i++) if (RETIRED[i].words.test(q)) return RETIRED[i];
    return null;
  }

  /* THE DESK'S SUPPORT BOUNDARY: which retired sport, if any, a turn is about.
     It is a product boundary, not a language rule. A question plainly about
     history ("why did you stop covering tennis?") is not refused; a question
     asking for research, a price, an edge or a bet on a retired sport — or a
     turn whose open game resolved to one — is answered with unsupportedAnswer.
     The server (edgedesk_ai) and the browser panel both decide with this. */
  var HISTORY_ASK = /\b(histor(y|ical|ically)|archived?|retired|no longer|stop(ped)? (covering|supporting|offering)|used to (cover|support|offer)|(why|when) (did|do|does) (you|edgedesk))\b/i;
  function supportBoundary(o) {
    var q = str(o && o.question);
    if (HISTORY_ASK.test(q)) return null;
    var bySport = o && o.sportKey ? retiredByKey(o.sportKey) : null;
    var entry = bySport || retiredNamedIn(q);
    if (!entry) return null;
    return {
      entry: entry,
      answer: unsupportedAnswer(entry),
      reason: bySport ? 'the turn resolved to a retired sport' : 'the question names a retired sport'
    };
  }

  /* { module: destination } for every retired Research module. */
  function retiredModuleRoutes() {
    var out = {};
    for (var i = 0; i < RETIRED.length; i++)
      for (var j = 0; j < RETIRED[i].modules.length; j++) out[RETIRED[i].modules[j]] = RESEARCH_DEFAULT;
    return out;
  }

  /* A PostgREST filter that keeps rows of current sports: a NULL key is kept
     (the row is judged by its title client-side), every retired prefix is out. */
  function postgrestKeep(col) {
    var c = str(col) || 'sport_key';
    var nots = [];
    var p = retiredPrefixes();
    for (var i = 0; i < p.length; i++) nots.push(c + '.not.like.' + p[i] + '*');
    if (!nots.length) return '';
    return 'or=(' + c + '.is.null,' + (nots.length === 1 ? nots[0] : 'and(' + nots.join(',') + ')') + ')';
  }

  function coverageSentence() {
    var l = [];
    for (var i = 0; i < RESEARCH_COVERAGE.length; i++) l.push(RESEARCH_COVERAGE[i].label);
    var list = l.length > 1 ? l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] : (l[0] || '');
    return 'Current research coverage includes ' + list + '.';
  }
  /* The support boundary, in the product's words. */
  function unsupportedAnswer(entry) {
    var label = entry && entry.label ? entry.label : 'That sport';
    return label + ' is not currently supported by EdgeDesk Research. ' + coverageSentence();
  }

  return {
    VERSION: VERSION,
    RETIRED: RETIRED,
    RESEARCH_COVERAGE: RESEARCH_COVERAGE,
    RESEARCH_DEFAULT: RESEARCH_DEFAULT,
    retiredByKey: retiredByKey,
    isRetiredKey: isRetiredKey,
    retiredOfRow: retiredOfRow,
    isRetiredRow: isRetiredRow,
    dropRetired: dropRetired,
    keepCurrentKeys: keepCurrentKeys,
    retiredPrefixes: retiredPrefixes,
    retiredNamedIn: retiredNamedIn,
    supportBoundary: supportBoundary,
    retiredModuleRoutes: retiredModuleRoutes,
    postgrestKeep: postgrestKeep,
    coverageSentence: coverageSentence,
    unsupportedAnswer: unsupportedAnswer
  };
});
/*__EDSPORTS_END__*/
const EDSPORTS: any = (globalThis as any).EDSPORTS;

export const BUILD = "capture-v11-player-props-r1";

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

/* ── CADENCE TIERS ───────────────────────────────────────────────────────────
   A capture run is not one thing. The board a customer researches on Tuesday
   and the board they bet into forty minutes before kickoff need completely
   different cadences, and until now the deployment had neither: NOTHING
   scheduled `capture` at all. The file header calls it a cron job; no cron
   existed anywhere in this repository. That is why a customer asking about a
   Saturday game on the Thursday was shown a price captured 2,345 minutes —
   thirty-nine hours — earlier, and why the answer opened by warning them
   about it.

   One deployed function, several cadences, selected per invocation with
   `?tier=`. The tier picks a WINDOW, not a policy: what makes a signal
   actionable is identical in every tier, and a tier can only narrow which
   sports are worth a billed request, never loosen what a price must prove.

     near   every ~10 min   Sports with a game inside 8 hours. On a day with
                            no such game this costs the FREE event index per
                            sport and not one billed request. On a Saturday it
                            is the only thing standing between a customer and
                            a price that left the board.
     day    every ~30 min   Anything kicking off inside 30 hours. Keeps the
                            board a customer researches the night before, and
                            the morning of, inside its 90-minute rung.
     board  every 4 hours   The whole horizon, nothing skipped. A college
                            spread six days out is allowed to be six hours
                            old — that is its rung — so six runs a day clears
                            it with room.

   THE RUNGS THESE SERVE are the reader's, in
   `edgedesk_ai/_intelligence.js` (`quote_ttl_buckets`), which are these same
   FRESHNESS_POLICY numbers in minutes. A cadence looser than the rung it
   feeds produces a board that is correctly described as stale, which is
   honest and useless. These were chosen to sit inside their rungs and the
   comparison is asserted in tools/capture/capture.test.js so the two cannot
   drift apart silently. */
/* The reader's rungs, in minutes, mirrored from
   edgedesk_ai/_intelligence.js `quote_ttl_buckets`. Held here so a run can
   state which of them its own cadence is fast enough to keep, and so
   tools/capture/capture.test.js can fail when the two copies drift. */
export const READER_RUNGS: { name: string; maxHoursToStart: number; minutes: number }[] = [
  { name: "imminent", maxHoursToStart: 0.5, minutes: 5 },
  { name: "close", maxHoursToStart: 2, minutes: 15 },
  { name: "soon", maxHoursToStart: 6, minutes: 45 },
  { name: "day", maxHoursToStart: 24, minutes: 90 },
  { name: "far", maxHoursToStart: 72, minutes: 180 },
  { name: "deep", maxHoursToStart: Infinity, minutes: 360 },
];

export interface CadenceTier {
  nearHours: number;
  maxDaysToStart: number;
  /** Minutes between runs on the schedule this tier is DEPLOYED on. The cron
      entries in supabase/capture_cron.sql must agree with this, and the test
      suite reads that file and checks that they do. */
  cadenceMin: number;
  note: string;
}
export const CADENCE_TIERS: Record<string, CadenceTier> = {
  near: {
    nearHours: 8, maxDaysToStart: 2, cadenceMin: 10,
    note: "Only sports with an event inside 8 hours. On a day with no such event "
      + "this costs the free event index per sport and not one billed request.",
  },
  day: {
    nearHours: 30, maxDaysToStart: 3, cadenceMin: 30,
    note: "Anything kicking off inside 30 hours, which is the board a customer "
      + "researches the night before and the morning of.",
  },
  board: {
    nearHours: 0, maxDaysToStart: 14, cadenceMin: 240,
    note: "The full horizon with no sport skipped. Every sport costs a billed "
      + "request on this tier, which is why it runs six times a day and not more.",
  },
};

/** Which reader rungs a cadence is fast enough to keep, and which it is not.
 *
 *  A CADENCE LOOSER THAN THE RUNG IT FEEDS IS NOT A BUG, BUT IT MUST NOT BE
 *  SILENT. Running every ten minutes cannot keep a price inside the five-minute
 *  rung that applies within half an hour of kickoff, so in that window EdgeDesk
 *  genuinely does not know the current number to the accuracy it demands before
 *  acting, and the reader will correctly call those quotes aging. That is the
 *  system working. What would not be working is a run reporting success while
 *  leaving somebody to discover the gap from a customer complaint, so every run
 *  says which rungs it serves and which it does not. */
export function rungsServed(cadenceMin: number): { served: string[]; not_served: string[]; note: string } {
  const served: string[] = [], notServed: string[] = [];
  for (const r of READER_RUNGS) (cadenceMin <= r.minutes ? served : notServed).push(r.name);
  return {
    served, not_served: notServed,
    note: notServed.length
      ? `A ${cadenceMin}-minute cadence cannot keep a price inside the ${notServed.join(", ")} rung`
        + `${notServed.length > 1 ? "s" : ""}. Quotes in ${notServed.length > 1 ? "those windows" : "that window"} `
        + `are correctly reported as aging or stale rather than presented as current. Tightening this costs odds-API `
        + `quota in direct proportion; see supabase/capture_cron.sql.`
      : `A ${cadenceMin}-minute cadence keeps every reader rung this tier covers.`,
  };
}

/** Apply a named cadence tier to a config. Unknown or absent name returns the
    config untouched, so a malformed cron entry degrades to the environment's
    own window rather than to a window nobody chose. */
export function applyCadenceTier(cfg: Config, tier: string | undefined | null): { cfg: Config; tier: string | null } {
  const name = String(tier ?? "").trim().toLowerCase();
  /* OWN PROPERTY ONLY. `tier` is a query parameter, and a bare `CADENCE_TIERS[name]`
     lookup also finds what the object INHERITS: `?tier=constructor` resolved to
     Object.prototype.constructor, which is truthy, so the run reported itself as
     tier "constructor" and spread `nearHours: undefined, maxDaysToStart: undefined`
     over the config. That silently disabled the actionable horizon — with
     maxDaysToStart undefined, `hours_to_start > undefined * 24` is NaN and every
     comparison against it is false, so a game a month out stopped being beyond
     the horizon. `toString` and `valueOf` miss only because toLowerCase() mangles
     them, which is luck, not a check. */
  const t = name && Object.prototype.hasOwnProperty.call(CADENCE_TIERS, name)
    ? CADENCE_TIERS[name] : undefined;
  if (!t) return { cfg, tier: null };
  return { cfg: { ...cfg, nearHours: t.nearHours, maxDaysToStart: t.maxDaysToStart }, tier: name };
}

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
  /* PLAYER PROPS: NO FLOOR. Nothing in this repository has measured a single
     player-prop edge against a result, so there is no number to write here
     that would not be invented. Two-sided props are priced and stored; none is
     actionable until backtested evidence puts a floor in this row (or in
     CAPTURE_EDGE_FLOOR as `"nfl|player_props|A": 0.04`). */
  "*|player_props|A": null, "*|player_props|B": null,
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

/* ── PLAYER PROP MARKETS ─────────────────────────────────────────────────────
   The Odds API's American-football player markets (NFL and NCAAF share one
   key list), exactly as the provider names them. Nothing here is invented: a
   key the provider does not serve fails only the request batch that carried
   it, and the run names the batch. Player markets are served ONLY by
   /events/{id}/odds; they never belong in CAPTURE_MARKETS.

   One list, two consumers: defaultConfig() reads it as the default capture
   set, and the tests assert its exact contents so a key cannot be dropped or
   typed into existence without a failing check. */
export const PLAYER_PROP_MARKETS: string[] = [
  "player_assists",
  "player_defensive_interceptions",
  "player_field_goals",
  "player_kicking_points",
  "player_pass_attempts",
  "player_pass_completions",
  "player_pass_interceptions",
  "player_pass_longest_completion",
  "player_pass_rush_yds",
  "player_pass_rush_reception_tds",
  "player_pass_rush_reception_yds",
  "player_pass_tds",
  "player_pass_yds",
  "player_pass_yds_q1",
  "player_pats",
  "player_receptions",
  "player_reception_longest",
  "player_reception_tds",
  "player_reception_yds",
  "player_rush_attempts",
  "player_rush_longest",
  "player_rush_reception_tds",
  "player_rush_reception_yds",
  "player_rush_tds",
  "player_rush_yds",
  "player_sacks",
  "player_solo_tackles",
  "player_tackles_assists",
  "player_tds",
  "player_tds_over",
  "player_1st_td",
  "player_anytime_td",
  "player_last_td",
];

/* The alternate ladders the provider serves for those markets. Each is filed
   under its base market by canonicalMarket(); the quote keeps the alternate key
   as its source_market so provenance is never lost. */
export const PLAYER_PROP_ALT_MARKETS: string[] = [
  "player_assists_alternate",
  "player_field_goals_alternate",
  "player_kicking_points_alternate",
  "player_pass_attempts_alternate",
  "player_pass_completions_alternate",
  "player_pass_interceptions_alternate",
  "player_pass_longest_completion_alternate",
  "player_pass_rush_yds_alternate",
  "player_pass_rush_reception_tds_alternate",
  "player_pass_rush_reception_yds_alternate",
  "player_pass_tds_alternate",
  "player_pass_yds_alternate",
  "player_pats_alternate",
  "player_receptions_alternate",
  "player_reception_longest_alternate",
  "player_reception_tds_alternate",
  "player_reception_yds_alternate",
  "player_rush_attempts_alternate",
  "player_rush_longest_alternate",
  "player_rush_reception_tds_alternate",
  "player_rush_reception_yds_alternate",
  "player_rush_tds_alternate",
  "player_rush_yds_alternate",
  "player_sacks_alternate",
  "player_solo_tackles_alternate",
  "player_tackles_assists_alternate",
];

/* Scorer markets are priced Yes / No, not Over / Under. They are captured and
   devigged per player like any two-sided market, but a scorer probability is a
   different object from a yardage line and is not yet allowed near
   qualification. */
export const PLAYER_PROP_YES_NO = new Set(["player_1st_td", "player_anytime_td", "player_last_td"]);

/** A player-market override from the environment. Unset or "" keeps the
    provider list; "none" / "off" / "false" is an empty list, so a deployment
    can turn alternates off without a redeploy. Only player_* keys are kept (a
    game market here would be requested from the event endpoint for nothing),
    alternates only in the alternate list and standard keys only in the other. */
export function propMarketList(raw: string | undefined, fallback: string[], alternate: boolean): string[] {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return [...fallback];
  if (v === "none" || v === "off" || v === "false") return [];
  const keys = v.split(",").map((x) => x.trim()).filter(Boolean)
    .filter((k) => isPlayerPropMarket(k) && k.endsWith("_alternate") === alternate);
  return [...new Set(keys)];
}

/** CAPTURE_MARKETS with any player market removed. Returned unchanged —
    byte for byte — when there is none, which is every correct configuration. */
export function withoutPlayerMarkets(markets: string): string {
  const parts = String(markets ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.some((m) => isPlayerPropMarket(m))) return markets;
  return parts.filter((m) => !isPlayerPropMarket(m)).join(",");
}

export interface Config {
  regions: string;
  bookmakers: string[];
  markets: string;
  /** Player markets somebody put in CAPTURE_MARKETS. The sport-wide /odds
      endpoint refuses player markets, so one there would 422 the whole sport's
      board; they are removed from `markets` and named in the run log instead. */
  marketsIgnored: string[];
  /** Additional event-level markets. The provider only exposes these through
      /events/{eventId}/odds, so they are fetched separately and normalized back
      into spreads/totals before pricing. */
  alternateLines: boolean;
  alternateMarkets: string[];
  alternateMaxHours: number;
  alternateNearHours: number;
  alternateMaxEvents: number;
  alternateConcurrency: number;
  /** PLAYER PROPS — event-level only, football only, captured in their own pass
      after every game line is written. */
  playerProps: boolean;
  playerPropMarkets: string[];
  playerPropAlternateMarkets: string[];
  /** How far ahead the DAY tier (and an untiered run) buys props. */
  playerPropMaxHours: number;
  /** How far ahead the NEAR tier buys props, and the window inside which an
      event is re-polled on the short interval. */
  playerPropNearHours: number;
  /** Events per sport per run, nearest kickoff first. */
  playerPropMaxEvents: number;
  /** Events fetched at once. Each event's market batches run in sequence. */
  playerPropConcurrency: number;
  /** Markets per provider request. Billing is per market returned, so the
      batch size changes the request count, never the cost. */
  playerPropMarketsPerRequest: number;
  /** Minimum minutes between two prop polls of the same event outside, and
      inside, playerPropNearHours of its kickoff. Without this the DAY tier
      (every 30 minutes) would re-buy a full prop board 60 times per game. */
  playerPropIntervalMin: number;
  playerPropNearIntervalMin: number;
  /** Credits one run may spend on props, estimated before each request as
      markets requested × region-equivalents and settled from x-requests-last. */
  propMaxCreditsPerRun: number;
  /** (event × market) pairs one run may request. */
  propMaxMarketRequestsPerRun: number;
  /** Props stop when the provider reports fewer credits than this left on the
      account, so game-line capture always has quota to run on. */
  propMinQuotaRemaining: number;
  /** Also write two-sided player props into `signals`. OFF by default: see
      PLAYER PROP SIGNALS in the handler for the three places game-line capture
      would pay for it. */
  playerPropSignals: boolean;
  sportsEnv: string;
  autoPrefixes: string[];
  referenceBooks: string[];
  ticks: boolean;
  bookQuotes: boolean;
  cfbLab: boolean;
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
    markets: withoutPlayerMarkets(g("CAPTURE_MARKETS", "h2h,spreads,totals")),
    marketsIgnored: list("CAPTURE_MARKETS", "h2h,spreads,totals").filter((m) => isPlayerPropMarket(m)),
    /* Alternate lines are opt-out once this build is deployed, but they are
       deliberately constrained by cadence below: DAY refreshes the ladder out
       to 30h, NEAR only refreshes the final 2h, and BOARD does not buy alternate
       markets at all. Every knob can be overridden without a redeploy. */
    alternateLines: bool("CAPTURE_ALT_LINES", true),
    alternateMarkets: list("CAPTURE_ALT_MARKETS", "alternate_spreads,alternate_totals"),
    alternateMaxHours: Math.max(0, num("CAPTURE_ALT_MAX_HOURS", 30)),
    alternateNearHours: Math.max(0, num("CAPTURE_ALT_NEAR_HOURS", 2)),
    alternateMaxEvents: Math.max(0, Math.floor(num("CAPTURE_ALT_MAX_EVENTS", 80))),
    alternateConcurrency: Math.max(1, Math.floor(num("CAPTURE_ALT_CONCURRENCY", 6))),
    /* Player props: on, windowed by tier (BOARD buys none), and budgeted three
       ways — per run in credits, per run in (event × market) requests, and by a
       floor on the account's remaining quota. A market list set to "none" or
       "off" is empty; unset or "" is the full provider list below. */
    playerProps: bool("CAPTURE_PLAYER_PROPS", true),
    playerPropMarkets: propMarketList(env("CAPTURE_PLAYER_PROP_MARKETS"), PLAYER_PROP_MARKETS, false),
    playerPropAlternateMarkets: propMarketList(env("CAPTURE_PLAYER_PROP_ALT_MARKETS"), PLAYER_PROP_ALT_MARKETS, true),
    playerPropMaxHours: Math.max(0, num("CAPTURE_PLAYER_PROP_MAX_HOURS", 30)),
    playerPropNearHours: Math.max(0, num("CAPTURE_PLAYER_PROP_NEAR_HOURS", 3)),
    playerPropMaxEvents: Math.max(0, Math.floor(num("CAPTURE_PLAYER_PROP_MAX_EVENTS", 80))),
    playerPropConcurrency: Math.max(1, Math.floor(num("CAPTURE_PLAYER_PROP_CONCURRENCY", 4))),
    playerPropMarketsPerRequest: Math.max(1, Math.floor(num("CAPTURE_PLAYER_PROP_MARKETS_PER_REQUEST", 12))),
    playerPropIntervalMin: Math.max(0, num("CAPTURE_PLAYER_PROP_INTERVAL_MIN", 120)),
    playerPropNearIntervalMin: Math.max(0, num("CAPTURE_PLAYER_PROP_NEAR_INTERVAL_MIN", 20)),
    propMaxCreditsPerRun: Math.max(0, num("CAPTURE_PROP_MAX_CREDITS_PER_RUN", 1000)),
    propMaxMarketRequestsPerRun: Math.max(0, Math.floor(num("CAPTURE_PROP_MAX_MARKET_REQUESTS_PER_RUN", 2000))),
    propMinQuotaRemaining: Math.max(0, num("CAPTURE_PROP_MIN_QUOTA_REMAINING", 5000)),
    playerPropSignals: bool("CAPTURE_PLAYER_PROP_SIGNALS", false),
    sportsEnv: g("CAPTURE_SPORTS", ""),
    /* v8 CONCATENATED "americanfootball_nfl" onto whatever this was set to, so
       auto-add could not be turned off: setting CAPTURE_AUTO_PREFIXES="" still
       pulled in every active NFL key including preseason, on top of an explicit
       CAPTURE_SPORTS list that had deliberately excluded them. Here the variable
       means what it says — set it to empty and nothing is auto-added; leave it
       unset and the football keys EdgeDesk is built around are included.
       `tennis_` was dropped from this default on 2026-09-27 when Tennis was
       retired; a retired prefix set here explicitly is removed as well, and
       the sport list below drops retired keys whatever their source. */
    autoPrefixes: (env("CAPTURE_AUTO_PREFIXES") === undefined
      ? ["americanfootball_nfl", "americanfootball_ncaaf"]
      : list("CAPTURE_AUTO_PREFIXES", "")).filter((p) => !EDSPORTS.isRetiredKey(p)),
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
    /* forward per-book college odds to the CFB Model Lab (fail-soft) */
    cfbLab: bool("CAPTURE_CFB_LAB", true),
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

/** A provider player market: `player_*`, standard or alternate. */
export function isPlayerPropMarket(market: string): boolean {
  return /^player_[a-z0-9_]+$/.test(String(market ?? "").toLowerCase());
}

/** The standard market an alternate player ladder belongs to:
    player_rush_yds_alternate -> player_rush_yds. Anything else is returned as
    given (lower-cased). The quote keeps the alternate key as its source. */
export function playerPropBaseMarket(market: string): string {
  const m = String(market ?? "").toLowerCase();
  return isPlayerPropMarket(m) && m.endsWith("_alternate") ? m.slice(0, -"_alternate".length) : m;
}

/** Map provider-specific alternate market keys onto the canonical market that
    EdgeDesk already understands. The POINT remains part of sigKey(), so -3 and
    -3.5 are still different bets; this only prevents the same bet from becoming
    a second namespace merely because it came from the event-level endpoint.
    Game markets map exactly as v10 did; a player alternate maps to its base. */
export function canonicalMarket(market: string): string {
  const m = String(market ?? "").toLowerCase();
  if (m === "alternate_spreads") return "spreads";
  if (m === "alternate_totals") return "totals";
  if (isPlayerPropMarket(m)) return playerPropBaseMarket(m);
  return m;
}

/** Which policy table row a market reads. Game markets are their own family,
    so every existing lookup resolves exactly as before. Every player market is
    `player_props`, which keeps a prop from inheriting a game-line number —
    above all the generic `*|*` edge floor, which was never validated for props. */
export function marketPolicyFamily(market: string): string {
  const m = canonicalMarket(market);
  return isPlayerPropMarket(m) ? "player_props" : m;
}

/** Can qualifySignal() price this market honestly? The three game markets, and
    — for players — only a standard Over/Under at one player's exact line. A
    scorer market (Yes/No) is captured and devigged but not qualified yet, and a
    one-sided market never gets this far: it has no fair value to test. */
export function marketUnderstoodForQualification(market: string, selection?: string | null): boolean {
  const m = String(market ?? "").toLowerCase();
  if (BACK_MARKETS.has(m)) return true;
  if (!isPlayerPropMarket(m) || m !== playerPropBaseMarket(m)) return false;
  if (PLAYER_PROP_YES_NO.has(m)) return false;
  if (selection == null) return true;
  const side = String(selection).trim().toLowerCase();
  return side === "over" || side === "under";
}

/** The player as the book wrote them, tidied only for whitespace. */
export function playerDisplayName(raw: unknown): string {
  return String(raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The player's key inside ONE event: the name folded only where two spellings
 * can never be two people — case, accents, periods and apostrophes, spacing.
 * "A.J. Brown" and "AJ Brown" are one key; "Michael Pittman Jr." and "Michael
 * Pittman" are NOT, because a suffix can be the only thing separating a father
 * from a son. It is scoped to an event and is NOT a player id: nothing here
 * pretends a name is globally authoritative. A roster source joins onto
 * (event, player_key) later.
 */
export function playerKey(raw: unknown): string {
  return playerDisplayName(raw).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[.'\u2018\u2019`\u00b4]/g, "")
    .replace(/[^\p{L}\p{N}\- ]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/* Sides as the reader sees them. Books agree on these four words and disagree
   on their case; a game-market selection is never touched. */
function propSide(raw: unknown): string {
  const t = String(raw ?? "").trim();
  const l = t.toLowerCase();
  return l === "over" ? "Over" : l === "under" ? "Under" : l === "yes" ? "Yes" : l === "no" ? "No" : t;
}

/* THE TRAILING PIPE IS LOAD-BEARING. A selection with no point still ends in "|".
   This is the primary key of `signals` and it must not drift by one character.

   A PLAYER MARKET CARRIES THE PLAYER. Decided by the market key, not by a flag
   a caller could forget: event|market|player_key|selection|point. Without the
   player, Mahomes Over 274.5 and Allen Over 274.5 are one row. Every other
   market builds exactly the v9 string. */
export const sigKey = (o: { event_id: string; market: string; selection: string; point: number | null; participant_key?: string | null }): string =>
  isPlayerPropMarket(o.market)
    ? `${o.event_id}|${o.market}|${o.participant_key ?? ""}|${o.selection}|${o.point ?? ""}`
    : `${o.event_id}|${o.market}|${o.selection}|${o.point ?? ""}`;

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
  const table = policyLookup(cfg.freshnessPolicy, sportGroup(sportKey), marketPolicyFamily(market)) ?? FRESHNESS_POLICY["*|*"];
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
  /** Devigged fair probability from this book's own complete market. NULL for
      a one-sided player quote: with one price there is no margin to remove,
      and inventing the missing side would invent the probability. */
  fair: number | null;
  /** Seconds between the provider's update stamp for this quote and the run's
      clock. null means the provider sent no usable timestamp. */
  ageS: number | null;
  fresh: boolean;
  family: string;
  tier: string;
  /** How many outcomes the devig used. A two-way devig is much better determined
      than a three-way one and the qualification engine is entitled to know. */
  sides: number;
  /** Provider market key this quote came from (`player_pass_yds_alternate`,
      `alternate_spreads`, `spreads`...). Resolves a duplicate exact point
      deterministically — the featured quote beats the same quote repeated in
      a ladder — and is stored with every player quote as its provenance. */
  sourceMarket: string;
  /** The provider's own update stamp for this quote, epoch ms, or null. */
  updatedMs: number | null;
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
  /** The player, for a player market; null for every game market. The display
      form is what the book wrote; the key is playerKey() of it. */
  participant: string | null;
  participant_key: string | null;
  is_player_prop: boolean;
  /** At least one book quoted both sides at this exact line. A candidate where
      no book did is captured and never qualified. */
  is_two_sided: boolean;
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
  /** Player quotes with no opposite side at the same book, player and line.
      Captured with a NULL fair value, never devigged against an invented side. */
  oneSidedQuotes: number;
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
export function partitionOutcomes(outcomes: any[], marketKey?: string): { group: any[]; ok: boolean }[] {
  if (marketKey !== undefined && isPlayerPropMarket(marketKey)) return partitionPlayerPropOutcomes(outcomes);
  return partitionStandardOutcomes(outcomes);
}

export function partitionStandardOutcomes(outcomes: any[]): { group: any[]; ok: boolean }[] {
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

export interface PropPart {
  group: any[];
  ok: boolean;
  participant: string;
  participant_key: string;
  /** Repeats of a side this book already quoted for this player at this line. */
  duplicates: number;
}

/**
 * Split one book's PLAYER market object into complete per-player sub-markets.
 *
 * partitionOutcomes() pairs a game market on |point|, which for a player
 * market pairs EVERY quarterback at 274.5 into one "market" — four prices
 * devigged as one outcome space, each fair roughly halved. A player market is
 * PLAYER + LINE + the sides offered at it:
 *
 *   Patrick Mahomes | 274.5   Over, Under     one two-sided market
 *   Josh Allen      | 274.5   Over, Under     a different one
 *   Patrick Mahomes | (none)  Yes, No         a scorer market
 *   Player A        | 0.5     Over            one-sided: captured, never devigged
 *
 * Refused (ok:false, counted as malformed): no player in `description`, no
 * side in `name`, an Over/Under with no line, a line that is present but not a
 * number, and more than two distinct sides for one player at one line. A side
 * the book repeats for the same player and line is a duplicate; the first wins.
 */
export function partitionPlayerPropOutcomes(outcomes: any[]): PropPart[] {
  const out: PropPart[] = [];
  const by = new Map<string, PropPart>();
  for (const o of outcomes ?? []) {
    const participant = playerDisplayName(o?.description);
    const pkey = playerKey(o?.description);
    const side = propSide(o?.name).toLowerCase();
    const ptRaw = o?.point;
    const pt = strictNum(ptRaw);
    const pointGarbled = ptRaw != null && ptRaw !== "" && pt == null;
    const lineMissing = (side === "over" || side === "under") && pt == null;
    if (!pkey || !side || pointGarbled || lineMissing) {
      out.push({ group: [o], ok: false, participant, participant_key: pkey, duplicates: 0 });
      continue;
    }
    const k = pkey + "|" + (pt == null ? "" : String(pt));
    let part = by.get(k);
    if (!part) { part = { group: [], ok: true, participant, participant_key: pkey, duplicates: 0 }; by.set(k, part); }
    if (part.group.some((x) => propSide(x?.name).toLowerCase() === side)) { part.duplicates++; continue; }
    part.group.push(o);
  }
  for (const part of by.values()) {
    part.ok = part.group.length === 1 || part.group.length === 2;
    out.push(part);
  }
  return out;
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
  const out: PriceEventResult = { candidates: [], malformed: 0, missingTimestamps: 0, duplicateQuotes: 0, oneSidedQuotes: 0 };
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
     suite is a test of this one line.

     For a PLAYER market the player leads the slot key —
     player_key + "|" + side + "|" + point — so two players on the same number
     can never meet. */
  const mkts: Record<string, Record<string, any>> = {};
  /* Per (market, selection name) — and per player for a player market — how
     many BOOKS sit on each point, so a minority line is visible as such. */
  const pointCensus: Record<string, Record<string, Set<string>>> = {};

  for (const bk of ev.bookmakers ?? []) {
    const bookKey = String(bk?.key ?? "").toLowerCase();
    if (!bookKey) continue;
    const bookStamp = parseStamp(bk?.last_update);

    for (const mk of bk.markets ?? []) {
      const sourceMarket = String(mk?.key ?? "").toLowerCase();
      if (!sourceMarket) { out.malformed++; continue; }
      const mkey = canonicalMarket(sourceMarket);
      const isProp = isPlayerPropMarket(mkey);
      const rawOutcomes: any[] = Array.isArray(mk?.outcomes) ? mk.outcomes : [];
      /* One player on one side is a real player market (player_tds_over is
         Over-only). A game market with one outcome never is. */
      if (rawOutcomes.length < (isProp ? 1 : 2)) { out.malformed++; continue; }
      /* A handicap market without a handicap is a schema fault (a provider that
         drops `point`), never a market with no point: refuse it rather than
         price it as a two-way without a line. strictNum never reads null as 0. */
      if ((mkey === "spreads" || mkey === "totals") && !rawOutcomes.every((o) => strictNum(o?.point) != null)) { out.malformed++; continue; }

      const method = policyLookup(cfg.devigPolicy, sportGroup(sportKey), marketPolicyFamily(mkey)) ?? "shin";

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

      const parts: any[] = isProp ? partitionPlayerPropOutcomes(rawOutcomes) : partitionStandardOutcomes(rawOutcomes);
      for (const part of parts) {
        if (part.duplicates) out.duplicateQuotes += part.duplicates;
        if (!part.ok) { out.malformed++; continue; }
        const outcomes = part.group;
        const decs = outcomes.map((o: any) => Number(o?.price));
        if (decs.some((d: number) => !Number.isFinite(d) || d <= 1)) { out.malformed++; continue; }
        if (!isProp && decs.length < 2) { out.malformed++; continue; }

        /* ONE PRICE HAS NO MARGIN TO REMOVE. A one-sided player quote is kept
           as the raw price it is; its fair is NULL rather than a number built
           on an opposite side nobody offered. */
        let fair: (number | null)[];
        if (decs.length >= 2) {
          const f = devig(decs, method);
          if (f.some((x) => !Number.isFinite(x) || x <= 0 || x >= 1)) { out.malformed++; continue; }
          fair = f;
        } else {
          fair = [null];
          out.oneSidedQuotes++;
        }
        if (stamp == null) out.missingTimestamps += outcomes.length;

        for (let i = 0; i < outcomes.length; i++) {
          const o = outcomes[i];
          const nm = isProp ? propSide(o?.name) : String(o?.name ?? "");
          if (!nm) continue;
          const ptRaw = o?.point;
          /* A player line reads the point exactly as its partition did (strictNum:
             "" is no line, never 0). A game market keeps its v9 expression. */
          const pt = isProp ? strictNum(ptRaw)
            : (ptRaw == null || !Number.isFinite(Number(ptRaw))) ? null : Number(ptRaw);
          const pkey: string | null = isProp ? part.participant_key : null;
          const okey = (isProp ? pkey + "|" : "") + nm + "|" + (pt == null ? "" : pt);

          mkts[mkey] = mkts[mkey] ?? {};
          const slot = mkts[mkey][okey] ?? (mkts[mkey][okey] = {
            name: nm, point: pt, participant: isProp ? part.participant : null, participant_key: pkey,
            byBook: new Map<string, Quote>(),
          });

          /* ONE QUOTE PER BOOK PER SELECTION, first wins. A book listing the same
             outcome twice used to count as two books, which defeated the very gate
             that exists to stop one feed's opinion being called a consensus, and
             double-weighted that book in the median as well. */
          const existing = slot.byBook.get(bookKey) as Quote | undefined;
          if (existing) {
            out.duplicateQuotes++;
            /* The featured market is the authoritative line. If an alternate
               ladder repeats that exact book/selection/point, keep the featured
               quote; if the alternate happened to arrive first, the featured
               quote replaces it. */
            const incomingFeatured = sourceMarket === mkey;
            const existingFeatured = existing.sourceMarket === mkey;
            if (!(incomingFeatured && !existingFeatured)) continue;
          }

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
            sourceMarket,
            updatedMs: stamp,
          });

          const cKey = mkey + "|" + (isProp ? pkey + "|" : "") + nm;
          pointCensus[cKey] = pointCensus[cKey] ?? {};
          const pKey = pt == null ? "" : String(pt);
          (pointCensus[cKey][pKey] = pointCensus[cKey][pKey] ?? new Set<string>()).add(bookKey);
        }
      }
    }
  }

  for (const mkey in mkts) {
    const isProp = isPlayerPropMarket(mkey);
    for (const okey in mkts[mkey]) {
      const s = mkts[mkey][okey];
      const quotes = [...s.byBook.values()] as Quote[];
      if (!quotes.length) continue;

      const census = pointCensus[mkey + "|" + (isProp ? s.participant_key + "|" : "") + s.name] ?? {};
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
        devig_method: policyLookup(cfg.devigPolicy, sportGroup(sportKey), marketPolicyFamily(mkey)) ?? "shin",
        participant: s.participant,
        participant_key: s.participant_key,
        is_player_prop: isProp,
        is_two_sided: quotes.some((q) => q.fair != null),
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
  /* Every policy table is read through the market's FAMILY. A game market is its
     own family, so each lookup below resolves exactly as it did in v9; a player
     market reads `player_props` and can never fall through to a game number. */
  const family = marketPolicyFamily(c.market);

  /* ONE-SIDED IS CAPTURED, NEVER QUALIFIED. A player market no book quoted on
     both sides at this line has no fair value, so there is nothing to test a
     price against. It gets its own reason rather than a borrowed one. A game
     candidate cannot reach this: its quotes always come from a devigged pair. */
  if (!c.quotes.some((q) => q.fair != null)) {
    const bestRaw = c.quotes.reduce((a, b) => (b.dec > a.dec ? b : a));
    return {
      actionable: false, tier: "PASS", reason: "one_sided_player_market",
      reference_type: "none", reference_book: null,
      fair_probability: null, fair_decimal: null, consensus_fair: null, sharp_book_fair: null, edge: null,
      best_dec: bestRaw.dec, best_book: bestRaw.book, best_book_title: bestRaw.title,
      best_quote_age_s: bestRaw.ageS, reference_quote_age_s: null,
      median_dec: median(c.quotes.map((q) => q.dec)),
      fresh_books: c.quotes.filter((q) => q.fresh).length, total_books: c.quotes.length,
      families: 0, dispersion: 0, edge_floor: null, segment: `${group}|${c.market}|PASS`,
      confirmations: 0, required_confirmations: 0, quality_score: 0, quality: {},
      point_is_modal: c.point === c.modal_point, modal_point: c.modal_point, key_numbers_to_modal: [],
      is_fav: median(c.quotes.map((q) => q.dec)) < 2, pin_dec: null, pin_opp_dec: null,
      corrob_n: 0, corrob_ref: "none", corrob_levels: 0, has_sharp: false,
    };
  }
  /* A one-sided quote sitting beside two-sided ones at other books is kept out
     of every consensus number below: it has no fair to contribute. */
  const quotes = c.quotes.filter((q) => q.fair != null);
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
  const consensusAll = indep.length ? trimmedMedian(indep.map((q) => q.fair as number)) : null;
  const dispersion = indep.length >= 2 ? mad(indep.map((q) => q.fair as number)) : 0;

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
  const corroborating = corrobBase == null ? [] : indep.filter((q) => (corrobBase - (q.fair as number)) >= CORROB_MATERIAL);
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
    /* Key numbers are margins of victory. A receptions line moving 2.5 -> 3.5
       does not "cross 3" in any sense that matters, so a player market reports
       none rather than borrowing the spread's vocabulary. */
    key_numbers_to_modal: c.is_player_prop ? [] : keyNumbersCrossed(c.point, c.modal_point, c.sport_key),
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
  if (!marketUnderstoodForQualification(c.market, c.selection)) {
    return pass(c.is_player_prop ? "prop_market_not_yet_qualifiable" : "market_not_understood");
  }
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
  const req = policyLookup(cfg.bookRequirements, group, family) ?? BOOK_REQUIREMENTS["*|*"];
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
    tier = "A"; refType = "sharp"; fairProb = refFresh.fair as number; refAge = refFresh.ageS;
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

    const maxDisp = policyLookup(cfg.maxDispersion, group, family) ?? MAX_DISPERSION["*|*"];
    if (dispersion > maxDisp) return pass("consensus_dispersion_too_high");

    /* THE BEST-PRICE BOOK IS REMOVED FROM ITS OWN FAIR VALUE. Without this, on a
       four-book market the book being tested supplies a quarter of the number it
       is tested against, and on a two-book market it supplies half. A soft line
       must not be allowed to help prove that it is soft. */
    const packFairs = indep.filter((q) => q.family !== execBest.family).map((q) => q.fair as number);
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
  /* A PLAYER MARKET HAS ONLY ITS OWN FLOOR. The generic `${group}|*` and `*|*`
     rows were set for game lines; letting a prop fall through to them would
     make a 2.5% player edge "actionable" on a threshold nobody validated for
     props. With no `player_props` row the floor is null, and a null floor is
     PASS: segment_not_qualified_for_action. */
  const floorKeys = family === "player_props"
    ? [`${group}|player_props|${tier}`, `*|player_props|${tier}`]
    : [`${group}|${c.market}|${tier}`, `${group}|*|${tier}`, `*|${c.market}|${tier}`, `*|*|${tier}`];
  const floorKey = floorKeys.find((k) => cfg.edgeFloor[k] !== undefined);
  const floor = floorKey === undefined ? null : cfg.edgeFloor[floorKey];
  const saneMax = policyLookup(cfg.edgeSaneMax, group, family) ?? EDGE_SANE_MAX["*|*"];

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
  const confPolicy = policyLookup(cfg.confirmations, group, family) ?? CONFIRMATIONS["*|*"];
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
    consensus: clamp(100 * (1 - dispersion / (policyLookup(cfg.maxDispersion, group, family) ?? 0.02)), 0, 100),
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
  one_sided_player_market: 0, prop_market_not_yet_qualifiable: 0,
  awaiting_confirmation: 7,
  below_quality_floor: 8,
  /* THE NUMBER OF STAGES CLEARED, WHICH FOR A REJECTION IS THE INDEX OF THE
     GATE THAT STOPPED IT, AND FOR `ok` IS ALL TEN.

     This read 9 — the INDEX of the last stage rather than the COUNT of stages —
     and the caller increments `for (s = 0; s < stagesPassed(reason); s++)`. So a
     candidate that cleared every gate registered on the first nine stages and
     left `actionable` at zero, permanently: the final row of the funnel could
     never be anything but 0, in direct contradiction of `funnel.actionable`
     beside it. The one report built to answer "why is the board empty" said
     nothing became actionable on every run in which something did. */
  ok: 10,
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
/* Every provider call has a deadline (docs/cfb-production/PROVIDERS.md): a
   hung request must not eat the whole run budget. The billed /odds call is
   NOT retried here (a retry is a second billed request; the next scheduled
   run is the retry); a timeout reports status 0 with a TIMEOUT detail. */
export const ODDS_TIMEOUT_MS = 20000;
export function deadline(ms: number): AbortSignal | undefined {
  try { return (AbortSignal as any).timeout(ms); } catch { return undefined; }
}

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
    const r = await fetch(u, { signal: deadline(ODDS_TIMEOUT_MS) });
    const h = (n: string) => r.headers.get(n) ?? "";
    const meta = { quotaRemaining: h("x-requests-remaining"), quotaUsed: h("x-requests-used"), lastCost: h("x-requests-last") };
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { data: [], ok: false, status: r.status, detail: body.slice(0, 240), ...meta };
    }
    const data = await r.json();
    return { data: Array.isArray(data) ? data : [], ok: true, status: 200, detail: "", ...meta };
  } catch (e) {
    const name = String((e as Error)?.name ?? "");
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { data: [], ok: false, status: 0, detail: (timeout ? "TIMEOUT after " + ODDS_TIMEOUT_MS + " ms: " : "") + String((e as Error)?.message ?? e), quotaRemaining: "", quotaUsed: "", lastCost: "" };
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
    const r = await fetch(`${ODDS_BASE}/sports/${encodeURIComponent(sport)}/events/?apiKey=${encodeURIComponent(key)}`, { signal: deadline(ODDS_TIMEOUT_MS) });
    if (!r.ok) return { commences: [], ok: false };
    const list = await r.json();
    if (!Array.isArray(list)) return { commences: [], ok: false };
    return { commences: list.map((e: any) => Date.parse(e?.commence_time)).filter((t: number) => Number.isFinite(t)), ok: true };
  } catch { return { commences: [], ok: false }; }
}

/**
 * Fetch non-featured markets for ONE event: alternate spreads/totals, and every
 * player market. The provider serves these only on this endpoint, one event per
 * request, and bills each request at (unique markets RETURNED) × (region
 * equivalents) — so a batch of twelve player markets on an event where books
 * post eight costs eight, and a market nobody posts costs nothing. The same
 * bookmaker/region selection as fetchOdds(), so reference and consensus policy
 * do not change because a quote came from a ladder.
 */
export async function fetchEventOdds(
  key: string, sport: string, eventId: string, cfg: Config, markets = cfg.alternateMarkets,
): Promise<OddsResult> {
  const sel = cfg.bookmakers.length
    ? `bookmakers=${encodeURIComponent(cfg.bookmakers.join(","))}`
    : `regions=${encodeURIComponent(cfg.regions)}`;
  const u = `${ODDS_BASE}/sports/${encodeURIComponent(sport)}/events/${encodeURIComponent(eventId)}/odds`
    + `?apiKey=${encodeURIComponent(key)}&${sel}&markets=${encodeURIComponent(markets.join(","))}`
    + `&oddsFormat=decimal&dateFormat=iso`;
  try {
    const r = await fetch(u, { signal: deadline(ODDS_TIMEOUT_MS) });
    const h = (n: string) => r.headers.get(n) ?? "";
    const meta = { quotaRemaining: h("x-requests-remaining"), quotaUsed: h("x-requests-used"), lastCost: h("x-requests-last") };
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { data: [], ok: false, status: r.status, detail: body.slice(0, 240), ...meta };
    }
    const data = await r.json();
    return { data: data && typeof data === "object" && !Array.isArray(data) ? [data] : [], ok: true, status: 200, detail: "", ...meta };
  } catch (e) {
    const name = String((e as Error)?.name ?? "");
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { data: [], ok: false, status: 0, detail: (timeout ? "TIMEOUT after " + ODDS_TIMEOUT_MS + " ms: " : "") + String((e as Error)?.message ?? e), quotaRemaining: "", quotaUsed: "", lastCost: "" };
  }
}

/**
 * Merge an event-level response into an event BEFORE priceEvent(). This is
 * deliberately not two independent pricing passes: doing that would make the
 * same featured point collide at sigKey() after qualification and whichever
 * pass ran first would win by accident.
 *
 * Base markets are appended first. priceEvent() canonicalizes alternate_spreads
 * -> spreads, alternate_totals -> totals and player_*_alternate -> player_*, and
 * its per-book duplicate rule keeps the featured quote when a ladder repeats the
 * exact same point. A response for a different event id is ignored.
 */
export function mergeEventOdds(base: any, extra: any): any {
  if (!base || typeof base !== "object") return extra;
  if (!extra || typeof extra !== "object") return base;
  if (base.id && extra.id && String(base.id) !== String(extra.id)) return base;

  const books = new Map<string, any>();
  for (const bk of base.bookmakers ?? []) {
    const key = String(bk?.key ?? "").toLowerCase();
    if (!key) continue;
    books.set(key, { ...bk, markets: Array.isArray(bk?.markets) ? [...bk.markets] : [] });
  }
  for (const bk of extra.bookmakers ?? []) {
    const key = String(bk?.key ?? "").toLowerCase();
    if (!key) continue;
    const cur = books.get(key) ?? { ...bk, markets: [] };
    const added = (Array.isArray(bk?.markets) ? bk.markets : []).map((mk: any) => ({
      ...mk,
      /* Keep the event-level bookmaker clock when a market-level clock is
         absent; otherwise merging into the featured bookmaker would age the
         extra quote by the featured book's timestamp. */
      last_update: mk?.last_update ?? bk?.last_update ?? null,
    }));
    cur.markets = [...(cur.markets ?? []), ...added];
    books.set(key, cur);
  }

  return {
    ...base,
    sport_key: base.sport_key ?? extra.sport_key,
    sport_title: base.sport_title ?? extra.sport_title,
    commence_time: base.commence_time ?? extra.commence_time,
    home_team: base.home_team ?? extra.home_team,
    away_team: base.away_team ?? extra.away_team,
    bookmakers: [...books.values()],
  };
}

/** How far out this invocation should buy alternate ladders. BOARD is kept at 0
    because six full-board refreshes per day are useful for featured prices but
    wasteful for per-event ladders. DAY carries the research board to the
    configured horizon; NEAR only refreshes the final window where 30-minute
    alts would become too old for the reader. */
export function alternateHoursForTier(cfg: Config, tier: string | null): number {
  if (!cfg.alternateLines || !cfg.alternateMarkets.length) return 0;
  if (tier === "board") return 0;
  if (tier === "near") return Math.min(cfg.alternateMaxHours, cfg.alternateNearHours);
  return cfg.alternateMaxHours;
}

/** How far out this invocation should buy player props. BOARD buys none: it
    runs every four hours over the whole horizon, which is exactly the shape
    that turns a prop list into thousands of billed markets. DAY covers the
    research window (30 h), NEAR the final hours (3 h). An untiered manual run
    uses the DAY window. */
export function playerPropHoursForTier(cfg: Config, tier: string | null): number {
  if (!cfg.playerProps || !(cfg.playerPropMarkets.length + cfg.playerPropAlternateMarkets.length)) return 0;
  if (tier === "board") return 0;
  if (tier === "near") return Math.min(cfg.playerPropMaxHours, cfg.playerPropNearHours);
  return cfg.playerPropMaxHours;
}

/** Is this event due a prop poll? Inside playerPropNearHours of kickoff the
    short interval applies, otherwise the long one. Two minutes of slack absorb
    scheduler drift, so a 20-minute interval on a 10-minute cron is every other
    run rather than every third. An event never polled is always due. */
export function propEventDue(lastPolledMs: number | null, hoursToStart: number, cfg: Config, nowMs: number): boolean {
  if (lastPolledMs == null || !Number.isFinite(lastPolledMs)) return true;
  const mins = hoursToStart <= cfg.playerPropNearHours ? cfg.playerPropNearIntervalMin : cfg.playerPropIntervalMin;
  return nowMs - lastPolledMs >= Math.max(0, mins * 60000 - 120000);
}

/** Region-equivalents a request is billed at: a bookmaker list is charged per
    ten keys, rounded up; otherwise one per region named. */
export function regionEquivalents(cfg: Config): number {
  if (cfg.bookmakers.length) return Math.max(1, Math.ceil(cfg.bookmakers.length / 10));
  return Math.max(1, cfg.regions.split(",").map((x) => x.trim()).filter(Boolean).length);
}

/** The prop markets one run requests, standard first, in batches. */
export function propMarketBatches(cfg: Config): string[][] {
  const all = [...new Set([...cfg.playerPropMarkets, ...cfg.playerPropAlternateMarkets])];
  const out: string[][] = [];
  for (let i = 0; i < all.length; i += cfg.playerPropMarketsPerRequest) out.push(all.slice(i, i + cfg.playerPropMarketsPerRequest));
  return out;
}

export async function fetchActiveSports(key: string): Promise<{ keys: string[]; ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${ODDS_BASE}/sports/?apiKey=${encodeURIComponent(key)}`, { signal: deadline(ODDS_TIMEOUT_MS) });
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
  const row = gameSignalRow(c, v, nowIso);
  if (!c.is_player_prop) return row;
  /* A PLAYER ROW NAMES ITS PLAYER. Only player rows carry these four columns:
     PostgREST writes a batch with one key set, so game rows keep exactly the
     v9 shape and a database that has not run the v11 migration keeps taking
     them untouched. `source_market` is the source of the best quote — where a
     reader would go to take the price; each book's own source is on its
     player_prop_quotes row. */
  const best = c.quotes.find((q) => q.book === v.best_book) ?? c.quotes[0];
  return {
    ...row,
    participant: c.participant,
    participant_key: c.participant_key,
    is_player_prop: true,
    source_market: best ? best.sourceMarket : null,
  };
}

function gameSignalRow(c: Candidate, v: Verdict, nowIso: string): any {
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
    /* THE CURRENT ACTIONABLE STATE, PERSISTED.
       `flagged_at` is the FROZEN ENTRY: it records that this selection qualified
       once, and it is deliberately permanent so the record and CLV cannot be
       rewritten by later market movement. It is NOT a statement about now. A row
       flagged on Tuesday whose price has since gone stale, whose books have
       thinned, or whose edge has decayed below its floor still carries
       flagged_at forever — correctly.

       Without this column the frontend has no way to ask "is this actionable
       RIGHT NOW", so it was inferring it from flagged_at and then re-deciding
       with its own heuristics. Capture knows the answer; it just was not
       writing it down. `qual_reason === 'ok'` is equivalent by construction —
       qualifySignal() returns "ok" if and only if actionable is true — and both
       are written so a reader can assert on either and a drift between them is
       visible rather than silent. */
    actionable: v.actionable,
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

/** The deterministic identity of one player quote: which game, which player,
    which market, which side, which line, which book. Two different players can
    never share it, and the same quote seen on the next run always has it, so
    the current table upserts in place and history appends only on change. */
export function propQuoteKey(o: { event_id: string; market: string; participant_key: string | null; selection: string; point: number | null; book: string }): string {
  return `${o.event_id}|${o.market}|${o.participant_key ?? ""}|${o.selection}|${o.point ?? ""}|${o.book}`;
}

/** Why a player quote cannot enter qualification, or null if it can. */
export function propUnqualifiableReason(c: Candidate, q: Quote): string | null {
  if (q.fair == null) return "one_sided_player_market";
  if (!marketUnderstoodForQualification(c.market, c.selection)) return "prop_market_not_yet_qualifiable";
  return null;
}

/**
 * One player_prop_quotes row per book quoting a player selection — EVERY quote,
 * qualified or not, fresh or stale, one-sided or two. This is what the Player
 * Props page line-shops from, so it answers, for each quote: who (player_name,
 * player_key), what (market), side, line (point), where (book), price
 * (decimal_odds), when (source_updated_at from the provider, captured_at from
 * this run), which game (event, teams, kickoff), from where (source_market:
 * standard or alternate) and how fresh (quote_age_s, is_fresh).
 */
export function playerPropQuoteRows(c: Candidate, nowIso: string): any[] {
  if (!c.is_player_prop) return [];
  return c.quotes.map((q) => {
    const reason = propUnqualifiableReason(c, q);
    return {
      quote_key: propQuoteKey({ event_id: c.event_id, market: c.market, participant_key: c.participant_key, selection: c.selection, point: c.point, book: q.book }),
      event_id: c.event_id, sport_key: c.sport_key, sport_title: canonicalTitle(c.sport_key, c.sport_title),
      commence_time: c.commence_time, home_team: c.home_team, away_team: c.away_team,
      player_name: c.participant, player_key: c.participant_key,
      market: c.market, source_market: q.sourceMarket, side: c.selection, point: c.point,
      book_key: q.book, book_title: q.title,
      decimal_odds: q.dec, opposite_decimal_odds: q.oppDec, book_fair_probability: q.fair,
      quote_age_s: q.ageS, is_fresh: q.fresh,
      source_updated_at: q.updatedMs == null ? null : new Date(q.updatedMs).toISOString(),
      captured_at: nowIso,
      is_two_sided: q.fair != null,
      qualifiable: reason == null,
      unqualifiable_reason: reason,
    };
  });
}

/** One event's prop poll: when, what it asked for, what came back, what it
    cost. Written only after at least one request for the event succeeded, so a
    failed poll is retried on the next run rather than waiting out an interval. */
export function propPollRow(ev: any, sport: string, nowIso: string, m: {
  markets_requested: number; markets_returned: number; requests_failed: number;
  credits_spent: number; quotes: number; players: number; poll_status: string;
}): any {
  return {
    event_id: String(ev?.id ?? ""), sport_key: String(ev?.sport_key ?? sport),
    commence_time: ev?.commence_time ?? null, home_team: ev?.home_team ?? null, away_team: ev?.away_team ?? null,
    last_polled_at: nowIso, ...m,
  };
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

/* ==========================================================================
   THE CFB MODEL LAB FEED. The lab (football/cfb_lab/, docs/cfb-lab/) keeps a
   permanent, append-only market history for every college game it predicts:
   each sportsbook's spread, total and moneyline as observed, so it can derive
   the opener, the close, CLV and the market at every snapshot. This board
   already pays for the per-book college odds, so it forwards them, UNCHANGED
   IN MEANING, to public.cfb_lab_ingest_quotes() (supabase/cfb_lab.sql), which
   applies the lab's own de-duplication rule and resolves the provider event to
   a game through cfb_lab_event_map.

   Conventions are the LAB's, not this file's: American prices, the spread as
   the HOME team's line (negative = home favoured), the total's over/under
   prices, and nothing observed at or after kickoff. A market whose two sides
   disagree about the number (home -3.5 against away +3) is skipped, never
   averaged. The feed is FAIL-SOFT: a missing function or a failed call is
   reported under `cfb_lab` in the run log and changes nothing else about the
   run's status.
   ========================================================================== */
export const CFB_LAB_SPORT = "americanfootball_ncaaf";

/* A number, strictly: null, undefined, "" and non-numeric text are NOT 0.
   (`Number(null) === 0` is how a provider that drops `point` would have
   become a pick'em spread and a zero total.) */
export function strictNum(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* The lab's hard market rules (football/cfb_lab/integrity.js validateQuote,
   cfb_market_quote_integrity_v1; the shared cases are
   football/cfb_lab/fixtures/integrity_rules.json). A quote that fails is NOT
   sent to cfb_lab_ingest_quotes: it goes to the quarantine RPC with its
   reasons, kept for investigation and never part of any consensus. */
export const CFB_QUOTE_BOUNDS = {
  SPREAD_ABS_MAX: 70, TOTAL_MIN: 20, TOTAL_MAX: 100, AMERICAN_ABS_MIN: 100, SIDE_PRICE_ABS_MAX: 1000,
  MONEYLINE_ABS_MAX: 100000, TWO_WAY_IMPLIED_MIN: 0.99, TWO_WAY_IMPLIED_MAX: 1.30, FUTURE_TOLERANCE_MIN: 5,
};
function impliedAm(a: number | null): number | null {
  if (a == null || !Number.isFinite(a) || Math.abs(a) < CFB_QUOTE_BOUNDS.AMERICAN_ABS_MIN) return null;
  return a > 0 ? 100 / (a + 100) : (-a) / (-a + 100);
}
export function cfbQuoteProblems(q: any, nowMs: number): string[] {
  const B = CFB_QUOTE_BOUNDS, out: string[] = [];
  const cols = q.market_type === "total" ? ["price_over", "price_under"] : ["price_home", "price_away"];
  for (const c of ["home_line", "total_points", "price_home", "price_away", "price_over", "price_under"]) {
    if (q[c] != null && q[c] !== "" && strictNum(q[c]) == null) out.push("NON_NUMERIC_" + c.toUpperCase());
  }
  const hl = strictNum(q.home_line), tp = strictNum(q.total_points);
  if (q.market_type === "spread" && hl != null && Math.abs(hl) > B.SPREAD_ABS_MAX) out.push("SPREAD_OUT_OF_BOUNDS");
  if (q.market_type === "total" && tp != null && (tp < B.TOTAL_MIN || tp > B.TOTAL_MAX)) out.push("TOTAL_OUT_OF_BOUNDS");
  const maxAbs = q.market_type === "moneyline" ? B.MONEYLINE_ABS_MAX : B.SIDE_PRICE_ABS_MAX;
  for (const c of cols) {
    const a = strictNum(q[c]);
    if (a == null) continue;
    if (a === 0) out.push("PRICE_ZERO");
    else if (Math.abs(a) < B.AMERICAN_ABS_MIN) out.push("PRICE_NOT_AMERICAN");
    else if (Math.abs(a) > maxAbs) out.push("PRICE_OUT_OF_BOUNDS");
    else if (Math.round(a) !== a) out.push("PRICE_NOT_INTEGER");
  }
  const p1 = impliedAm(strictNum(q[cols[0]])), p2 = impliedAm(strictNum(q[cols[1]]));
  if (p1 != null && p2 != null) {
    const sum = p1 + p2;
    if (strictNum(q[cols[0]]) === strictNum(q[cols[1]]) && sum > B.TWO_WAY_IMPLIED_MAX) out.push("IDENTICAL_SIDE_PRICES");
    else if (sum > B.TWO_WAY_IMPLIED_MAX) out.push("TWO_WAY_HOLD_TOO_HIGH");
    if (sum < B.TWO_WAY_IMPLIED_MIN) out.push("TWO_WAY_BELOW_FAIR");
  }
  const tol = B.FUTURE_TOLERANCE_MIN * 60000;
  const obs = parseStamp(q.observed_at), upd = parseStamp(q.provider_updated_at);
  if (obs != null && obs > nowMs + tol) out.push("OBSERVED_IN_FUTURE");
  if (upd != null && obs != null && upd > obs + tol) out.push("PROVIDER_TS_AFTER_OBSERVED");
  if (q.provider_updated_at != null && q.provider_updated_at !== "" && upd == null) out.push("PROVIDER_TS_UNPARSEABLE");
  return [...new Set(out)];
}

/* decimal -> American, rounded half away from zero (the lab's price rule) */
export function decimalToAmerican(d: unknown): number | null {
  const x = Number(d);
  if (!Number.isFinite(x) || x <= 1) return null;
  const a = x >= 2 ? (x - 1) * 100 : -100 / (x - 1);
  const r = Math.sign(a) * Math.floor(Math.abs(a) + 0.5);
  return r === 0 ? null : r;
}

export function cfbLabQuotes(events: any[], nowIso: string, nowMs: number): { quotes: any[]; skipped: Record<string, number>; quarantined: any[] } {
  const quotes: any[] = [];
  const quarantined: any[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const lower = (x: unknown) => String(x ?? "").trim().toLowerCase();
  for (const ev of events ?? []) {
    const kick = parseStamp(ev?.commence_time);
    if (!ev?.id || kick == null || !ev?.home_team || !ev?.away_team) { skip("event without id, teams or kickoff"); continue; }
    if (nowMs >= kick) { skip("started (in-play numbers are never recorded)"); continue; }
    const home = lower(ev.home_team), away = lower(ev.away_team);
    const common = {
      game_id: null, source: "odds_api", provider_event_id: String(ev.id),
      observed_at: nowIso, retrieved_at: nowIso, kickoff_ts: new Date(kick).toISOString(),
      home_team: String(ev.home_team), away_team: String(ev.away_team),
      is_pregame: true, is_provider_open: false, is_provider_close: false,
    };
    for (const bk of ev?.bookmakers ?? []) {
      const book = lower(bk?.key).replace(/[^a-z0-9]+/g, "");
      if (!book) { skip("bookmaker without a key"); continue; }
      for (const m of bk?.markets ?? []) {
        const outs: any[] = Array.isArray(m?.outcomes) ? m.outcomes : [];
        const upd = parseStamp(m?.last_update) ?? parseStamp(bk?.last_update);
        const base = { ...common, book, provider_updated_at: upd == null ? null : new Date(upd).toISOString() };
        let q: any = null;
        if (m?.key === "spreads") {
          const h = outs.find((o) => lower(o?.name) === home), a = outs.find((o) => lower(o?.name) === away);
          const hp = strictNum(h?.point), ap = strictNum(a?.point);
          if (!h || !a) { skip("spread without both sides"); continue; }
          if (hp == null || ap == null) { skip("spread point missing (schema: never read as 0)"); continue; }
          if (Math.abs(hp + ap) > 1e-9) { skip("spread sides disagree about the number"); continue; }
          q = { ...base, market_type: "spread", home_line: hp, price_home: decimalToAmerican(strictNum(h.price)), price_away: decimalToAmerican(strictNum(a.price)) };
        } else if (m?.key === "totals") {
          const o = outs.find((x) => lower(x?.name) === "over"), u = outs.find((x) => lower(x?.name) === "under");
          const op = strictNum(o?.point), up = strictNum(u?.point);
          if (!o || !u) { skip("total without both sides"); continue; }
          if (op == null || up == null) { skip("total point missing (schema: never read as 0)"); continue; }
          if (Math.abs(op - up) > 1e-9) { skip("total sides disagree about the number"); continue; }
          q = { ...base, market_type: "total", total_points: op, price_over: decimalToAmerican(strictNum(o.price)), price_under: decimalToAmerican(strictNum(u.price)) };
        } else if (m?.key === "h2h") {
          const h = outs.find((o) => lower(o?.name) === home), a = outs.find((o) => lower(o?.name) === away);
          const ph = decimalToAmerican(strictNum(h?.price)), pa = decimalToAmerican(strictNum(a?.price));
          if (ph == null && pa == null) { skip("moneyline without a price"); continue; }
          q = { ...base, market_type: "moneyline", price_home: ph, price_away: pa };
        }
        if (!q) continue;
        const problems = cfbQuoteProblems(q, nowMs);
        if (problems.length) quarantined.push({ ...q, reasons: problems, rule_version: "cfb_market_quote_integrity_v1" });
        else quotes.push(q);
      }
    }
  }
  return { quotes, skipped, quarantined };
}

async function sendCfbLab(url: string, key: string, quotes: any[], rpc = "cfb_lab_ingest_quotes"): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const r = await fetch(url.replace(/\/+$/, "") + "/rest/v1/rpc/" + rpc, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ p_quotes: quotes }),
      signal: deadline(ODDS_TIMEOUT_MS),
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 240)}` };
    try { return { ok: true, result: JSON.parse(text) }; } catch { return { ok: true, result: text.slice(0, 240) }; }
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

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

/* ==========================================================================
   PLAYER PROPS — THE SECOND PASS.

   Runs after every sport's game lines have been priced and written, so a prop
   board can never take the wall clock, the write budget or the quota a spread
   needed. For each NFL / NCAAF event inside the tier's window whose own
   refresh interval has passed, nearest kickoff first:

     1. ONE event-level request per batch of player markets — never one per
        player: a single response already carries every player a book offers
        in those markets. Standard and alternate batches are merged into one
        event before pricing, so the featured-beats-ladder rule and the
        per-player point census see both.
     2. priceEvent() on that event: per player, per line, per side, per book.
     3. EVERY quote to player_prop_quotes (upsert on quote_key); the database
        appends a tick to player_prop_quote_ticks only when a price changed.
     4. The event's poll time to player_prop_event_polls, which is the clock
        step 0 reads on the next run.
     5. Optionally (CAPTURE_PLAYER_PROP_SIGNALS) two-sided props to `signals`.

   Before each request the pass checks, in order: the wall clock, the credit
   budget (spent + in flight + this batch's worst case), the (event × market)
   request budget and the account's quota floor. The first to fail stops the
   pass cleanly and is named in `stopped`. A 401 or 429 stops it at once.
   ========================================================================== */
export interface PropQueueItem { sport: string; events: any[] }

export async function runPlayerProps(o: {
  cfg: Config; tier: string | null; oddsKey: string; rest: Rest; nowMs: number; nowIso: string;
  outOfTime: () => boolean; queue: PropQueueItem[]; quotaRemaining: string; diag: boolean; disabledByRequest?: boolean;
}): Promise<any> {
  const { cfg, tier, rest, nowMs, nowIso } = o;
  const hours = playerPropHoursForTier(cfg, tier);
  const regionEq = regionEquivalents(cfg);
  const T: any = {
    enabled: cfg.playerProps, status: "ok", tier, window_hours: hours,
    markets_configured: { standard: cfg.playerPropMarkets.length, alternate: cfg.playerPropAlternateMarkets.length, per_request: cfg.playerPropMarketsPerRequest },
    budget: {
      max_credits_per_run: cfg.propMaxCreditsPerRun, max_market_requests_per_run: cfg.propMaxMarketRequestsPerRun,
      min_quota_remaining: cfg.propMinQuotaRemaining, region_equivalents: regionEq,
      interval_min: cfg.playerPropIntervalMin, near_interval_min: cfg.playerPropNearIntervalMin,
      near_hours: cfg.playerPropNearHours, max_events_per_sport: cfg.playerPropMaxEvents,
    },
    events_eligible: 0, events_due: 0, events_skipped_interval: 0, events_skipped_cap: 0,
    events_skipped_budget: 0, events_skipped_time: 0, events_requested: 0, events_with_props: 0,
    requests: 0, markets_requested: 0, markets_returned: 0,
    unique_players: 0, unique_player_markets: 0, candidates: 0,
    quotes_seen: 0, two_sided_quotes: 0, one_sided_quotes: 0, fresh_quotes: 0, stale_quotes: 0,
    quotes_missing_timestamp: 0, malformed: 0, duplicate_quotes: 0,
    quotes_written: 0, quotes_written_is_exact: true, ticks_written: 0, ticks_written_is_exact: true,
    polls_written: 0, quota_spent: 0, quota_spent_is_exact: true, failures: 0, stopped: null,
    signals_enabled: cfg.playerPropSignals, per_sport: {},
  };
  const skip = (status: string, reason: string) => { T.status = status; T.reason = reason; return T; };
  if (!cfg.playerProps) return skip("disabled", "CAPTURE_PLAYER_PROPS is off.");
  if (o.disabledByRequest) return skip("skipped", "?props=0 turned player props off for this run.");
  if (o.diag) return skip("skipped", "diagnostic runs never buy player props.");
  if (hours <= 0) {
    return skip("skipped", tier === "board"
      ? "BOARD buys no player props: DAY and NEAR do, inside their windows."
      : "No player markets are configured (CAPTURE_PLAYER_PROP_MARKETS and _ALT_MARKETS are both empty).");
  }
  if (!o.queue.length) return skip("skipped", "No NFL or NCAAF board was captured this run, so no event is eligible.");

  /* STORAGE FIRST, CREDITS SECOND. If the table the quotes go to is not there,
     buying them would pay for data with nowhere to live. */
  const pre = await rest.select("player_prop_quotes?select=quote_key&limit=1");
  if (pre.error) {
    return skip("storage_missing", "player_prop_quotes is not readable (" + pre.error.slice(0, 160) + "). Run "
      + "supabase/capture_v11_player_props.sql. No prop request was made, so nothing was spent.");
  }

  /* Each event's own clock. Unreadable state is reported, and every event then
     reads as due — the run budget below still bounds what that can cost. */
  const polled = new Map<string, number>();
  const pr = await rest.select(`player_prop_event_polls?select=event_id,last_polled_at&commence_time=gte.${encodeURIComponent(nowIso)}&limit=5000`);
  if (pr.error) T.poll_state_error = pr.error.slice(0, 200);
  else for (const r of pr.rows) { const t = Date.parse(String(r?.last_polled_at ?? "")); if (r?.event_id && Number.isFinite(t)) polled.set(String(r.event_id), t); }

  const batches = propMarketBatches(cfg);
  let reserved = 0, spent = 0, marketReqs = 0;
  let quotaLeft = o.quotaRemaining === "" ? NaN : Number(o.quotaRemaining);
  let stopped: string | null = null;
  const players = new Set<string>(), playerMarkets = new Set<string>();
  const failureSamples: any[] = [];
  const quoteRows: any[] = [], pollRows: any[] = [];
  const propCands: Candidate[] = [];

  const canSpend = (nMarkets: number): boolean => {
    if (stopped) return false;
    if (o.outOfTime()) { stopped = "wall_clock"; return false; }
    const est = nMarkets * regionEq;
    if (spent + reserved + est > cfg.propMaxCreditsPerRun) { stopped = "credit_budget"; return false; }
    if (marketReqs + nMarkets > cfg.propMaxMarketRequestsPerRun) { stopped = "market_request_budget"; return false; }
    if (Number.isFinite(quotaLeft) && quotaLeft - est < cfg.propMinQuotaRemaining) { stopped = "quota_floor"; return false; }
    return true;
  };

  const processEvent = async (sport: string, ev: any, PS: any): Promise<void> => {
    const eventId = String(ev?.id ?? "");
    let merged: any = {
      id: ev?.id, sport_key: ev?.sport_key ?? sport, sport_title: ev?.sport_title,
      commence_time: ev?.commence_time, home_team: ev?.home_team, away_team: ev?.away_team, bookmakers: [],
    };
    let okReqs = 0, failReqs = 0, eventCost = 0, requested = 0, cut = false;
    const returned = new Set<string>();
    for (const batch of batches) {
      if (!canSpend(batch.length)) { cut = true; break; }
      const est = batch.length * regionEq;
      reserved += est; marketReqs += batch.length;
      const r = await fetchEventOdds(o.oddsKey, sport, eventId, cfg, batch);
      reserved -= est;
      T.requests++; T.markets_requested += batch.length; requested += batch.length;
      /* Spend is what the provider says it charged. If a response ever arrives
         without x-requests-last, the budget counts the worst case instead and
         the total is labelled inexact rather than presented as a measurement. */
      const cost = r.lastCost === "" ? NaN : Number(r.lastCost);
      if (Number.isFinite(cost)) { spent += cost; eventCost += cost; T.quota_spent += cost; }
      else if (r.ok) { spent += est; eventCost += est; T.quota_spent_is_exact = false; }
      const q = r.quotaRemaining === "" ? NaN : Number(r.quotaRemaining);
      if (Number.isFinite(q)) { quotaLeft = q; T.last_quota_remaining = r.quotaRemaining; }
      if (r.quotaUsed) T.last_quota_used = r.quotaUsed;
      if (!r.ok) {
        failReqs++; T.failures++;
        if (failureSamples.length < 8) failureSamples.push({ sport, event_id: eventId, status: r.status, detail: r.detail, markets: batch });
        if (r.status === 401 || r.status === 429) { stopped = `provider_${r.status}`; break; }
        continue;
      }
      okReqs++;
      const extra = r.data[0];
      if (extra) {
        for (const bk of extra.bookmakers ?? []) for (const mk of bk?.markets ?? []) if (mk?.key) returned.add(String(mk.key));
        merged = mergeEventOdds(merged, extra);
      }
    }
    if (!okReqs && !failReqs) {
      if (stopped === "wall_clock") { T.events_skipped_time++; PS.skipped_time++; }
      else { T.events_skipped_budget++; PS.skipped_budget++; }
      return;
    }
    T.events_requested++; PS.requested++;
    T.markets_returned += returned.size; PS.markets_returned += returned.size;
    PS.quota_spent += eventCost;
    if (!okReqs) return;   // every batch failed: no poll time, so it is retried next run

    const pe = priceEvent(merged, cfg, nowMs);
    T.malformed += pe.malformed; T.duplicate_quotes += pe.duplicateQuotes; T.quotes_missing_timestamp += pe.missingTimestamps;
    const cands = pe.candidates.filter((c) => c.is_player_prop);
    let nq = 0;
    for (const c of cands) {
      T.candidates++;
      players.add(`${sport}|${c.event_id}|${c.participant_key}`);
      playerMarkets.add(`${sport}|${c.event_id}|${c.market}|${c.participant_key}`);
      for (const q of c.quotes) {
        nq++;
        if (q.fair == null) T.one_sided_quotes++; else T.two_sided_quotes++;
        if (q.fresh) T.fresh_quotes++; else T.stale_quotes++;
      }
      quoteRows.push(...playerPropQuoteRows(c, nowIso));
      propCands.push(c);
    }
    T.quotes_seen += nq; PS.quotes_seen += nq;
    if (cands.length) { T.events_with_props++; PS.with_props++; }
    pollRows.push(propPollRow(ev, sport, nowIso, {
      markets_requested: requested, markets_returned: returned.size, requests_failed: failReqs,
      credits_spent: eventCost, quotes: nq, players: new Set(cands.map((c) => c.participant_key)).size,
      poll_status: cut || failReqs ? "partial" : "ok",
    }));
  };

  for (const item of o.queue) {
    const sport = item.sport;
    const PS: any = T.per_sport[sport] = {
      eligible: 0, due: 0, requested: 0, with_props: 0, skipped_budget: 0, skipped_time: 0,
      markets_returned: 0, quotes_seen: 0, quota_spent: 0,
    };
    const eligible = (item.events ?? [])
      .map((ev: any) => ({ ev, t: Date.parse(String(ev?.commence_time ?? "")) }))
      .filter((x: any) => x.ev?.id && Number.isFinite(x.t) && x.t > nowMs && x.t <= nowMs + hours * 3600000)
      .sort((a: any, b: any) => a.t - b.t);
    const due = eligible.filter((x: any) => propEventDue(polled.get(String(x.ev.id)) ?? null, (x.t - nowMs) / 3600000, cfg, nowMs));
    const selected = due.slice(0, cfg.playerPropMaxEvents);
    PS.eligible = eligible.length; PS.due = due.length;
    T.events_eligible += eligible.length; T.events_due += due.length;
    T.events_skipped_interval += eligible.length - due.length;
    T.events_skipped_cap += due.length - selected.length;
    for (let i = 0; i < selected.length; i += cfg.playerPropConcurrency) {
      if (stopped || o.outOfTime()) {
        const left = selected.length - i;
        if (!stopped) stopped = "wall_clock";
        if (stopped === "wall_clock") { T.events_skipped_time += left; PS.skipped_time += left; }
        else { T.events_skipped_budget += left; PS.skipped_budget += left; }
        break;
      }
      const batch = selected.slice(i, i + cfg.playerPropConcurrency);
      await Promise.all(batch.map((x: any) => processEvent(sport, x.ev, PS)));
    }
  }
  T.unique_players = players.size;
  T.unique_player_markets = playerMarkets.size;
  T.stopped = stopped;
  if (failureSamples.length) T.failure_samples = failureSamples;

  /* ── WRITES. The current quote upserts on quote_key; the database's trigger
     stamps price_changed_at and appends a tick only when the price moved, and
     `returning` reads that stamp back so ticks_written is a count the database
     made, not one this function inferred. */
  const writeErrors: string[] = [];
  const gaps = new Set<string>();
  const byKey = new Map<string, any>();
  for (const r of quoteRows) byKey.set(r.quote_key, r);   // one row per identity per statement
  const rows = [...byKey.values()];
  const CHUNK = 1000;
  let returning: string | undefined = "price_changed_at";
  const capturedMs = Date.parse(nowIso);
  const writeChunk = async (slice: any[]): Promise<void> => {
    let chunk = dropColumns(slice, gaps);
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await rest.insert("player_prop_quotes", chunk, { onConflict: "quote_key", ignoreDuplicates: false, returning });
      if (!res.error) {
        if (returning) {
          T.quotes_written += res.rows.length;
          T.ticks_written += res.rows.filter((r: any) => Date.parse(String(r?.price_changed_at ?? "")) === capturedMs).length;
        } else {
          T.quotes_written += res.count ?? chunk.length;
          if (res.count == null) T.quotes_written_is_exact = false;
          T.ticks_written_is_exact = false;
        }
        return;
      }
      const col = missingColumnFrom(res.error);
      if (col === "price_changed_at" && returning) { returning = undefined; continue; }
      if (col) { gaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
      if (writeErrors.length < 8) writeErrors.push("player_prop_quotes: " + res.error.slice(0, 300));
      return;
    }
  };
  const WRITE_CONCURRENCY = 4;
  let unwritten = 0;
  for (let i = 0; i < rows.length; i += CHUNK * WRITE_CONCURRENCY) {
    if (o.outOfTime()) { unwritten = rows.length - i; break; }
    const group: Promise<void>[] = [];
    for (let j = i; j < Math.min(rows.length, i + CHUNK * WRITE_CONCURRENCY); j += CHUNK) group.push(writeChunk(rows.slice(j, j + CHUNK)));
    await Promise.all(group);
  }
  if (unwritten) T.quotes_unwritten_for_time = unwritten;

  if (pollRows.length && !o.outOfTime()) {
    let chunk = dropColumns(pollRows, gaps);
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await rest.insert("player_prop_event_polls", chunk, { onConflict: "event_id", ignoreDuplicates: false });
      if (!res.error) { T.polls_written += res.count ?? chunk.length; break; }
      const col = missingColumnFrom(res.error);
      if (col) { gaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
      if (writeErrors.length < 8) writeErrors.push("player_prop_event_polls: " + res.error.slice(0, 300));
      break;
    }
  }

  /* ── PLAYER PROP SIGNALS (optional, OFF by default).
     Writing every prop into `signals` costs game-line capture in three places,
     which is why it is opt-in: the close function takes unclosed signals by
     kickoff with a 5,000-row limit and no market filter, so a Sunday of prop
     rows would push spreads out of their close; capture's own prior-state read
     is capped at 20,000 rows; and `signal_ticks` appends one row per candidate
     per run where player_prop_quote_ticks appends only on change. So only
     two-sided props are sent, they never write signal_ticks, their prior state
     is read separately, and the game-line read filters them out. With the
     player_props floor at null, none of them is actionable. */
  if (cfg.playerPropSignals && propCands.length && !o.outOfTime()) {
    const Q: any = T.qualification = { candidates: 0, actionable: 0, by_reason: {}, new_signals: 0, refreshed: 0, flag_frozen: 0 };
    const prior = new Map<string, number>();
    const horizon = new Date(nowMs + cfg.maxDaysToStart * 86400000).toISOString();
    const ps = await rest.select(`signals?select=sig_key,qual_streak&market=like.player_*`
      + `&commence_time=gte.${encodeURIComponent(nowIso)}&commence_time=lte.${encodeURIComponent(horizon)}&limit=20000`);
    if (ps.error) { const col = missingColumnFrom(ps.error); if (col) gaps.add(col); else if (writeErrors.length < 8) writeErrors.push("prop prior_state: " + ps.error.slice(0, 300)); }
    else for (const r of ps.rows) prior.set(r.sig_key, Number(r.qual_streak) || 0);

    const sigRows: any[] = [], flags: any[] = [];
    const seen = new Set<string>();
    for (const c of propCands) {
      if (!c.is_two_sided) continue;
      const key = sigKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      const v = qualifySignal(c, { priorStreak: prior.get(key) ?? 0, nowMs }, cfg);
      Q.candidates++;
      Q.by_reason[v.reason] = (Q.by_reason[v.reason] ?? 0) + 1;
      sigRows.push(signalRow(c, v, nowIso));
      if (v.actionable) { Q.actionable++; flags.push(flagRow(c, v, nowIso)); }
    }
    const existing = new Set<string>();
    for (let i = 0; i < sigRows.length && !o.outOfTime(); i += 500) {
      const slice = sigRows.slice(i, i + 500);
      let chunk = dropColumns(slice, gaps);
      for (let attempt = 0; attempt < 12; attempt++) {
        const res = await rest.insert("signals", chunk, { onConflict: "sig_key", ignoreDuplicates: true, returning: "sig_key" });
        if (!res.error) { Q.new_signals += res.rows.length; for (const r of slice) existing.add(r.sig_key); break; }
        const col = missingColumnFrom(res.error);
        if (col) { gaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
        if (writeErrors.length < 8) writeErrors.push("prop signals insert: " + res.error.slice(0, 300));
        break;
      }
    }
    const live = sigRows.filter((r) => existing.has(r.sig_key)).map(liveRow);
    for (let i = 0; i < live.length && !o.outOfTime(); i += 500) {
      let chunk = dropColumns(live.slice(i, i + 500), gaps);
      for (let attempt = 0; attempt < 12; attempt++) {
        const res = await rest.insert("signals", chunk, { onConflict: "sig_key", ignoreDuplicates: false });
        if (!res.error) { Q.refreshed += res.count ?? chunk.length; break; }
        const col = missingColumnFrom(res.error);
        if (col) { gaps.add(col); chunk = dropColumns(chunk, new Set([col])); continue; }
        if (writeErrors.length < 8) writeErrors.push("prop signals update: " + res.error.slice(0, 300));
        break;
      }
    }
    for (const f of flags) {
      if (o.outOfTime()) break;
      if (!existing.has(f.sig_key)) continue;
      const res = await rest.patch("signals", `sig_key=eq.${encodeURIComponent(f.sig_key)}&flagged_at=is.null`, dropColumns([f], gaps)[0], "sig_key");
      if (res.error) { if (writeErrors.length < 8) writeErrors.push("prop signals flag: " + res.error.slice(0, 300)); }
      else Q.flag_frozen += res.rows.length;
    }
  }

  if (writeErrors.length) T.write_errors = writeErrors;
  if (gaps.size) {
    T.schema_gaps = [...gaps].sort();
    T.schema_warning = "These player-prop columns do not exist, so they were dropped and everything else was written. "
      + "Run supabase/capture_v11_player_props.sql.";
  }
  T.status = T.requests > 0 && T.events_requested > 0 && T.failures === T.requests ? "failed"
    : (stopped || T.failures || writeErrors.length || gaps.size || T.poll_state_error || unwritten) ? "partial" : "ok";
  return T;
}

export async function handle(req: Request): Promise<Response> {
  const envGet: EnvGet = (k) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined);
  const baseCfg = defaultConfig(envGet);
  const CRON_SECRET = envGet("CRON_SECRET") ?? "";
  const ODDS_KEY = envGet("ODDS_API_KEY") ?? "";
  const SB_URL = envGet("SUPABASE_URL") ?? "";
  const SB_KEY = envGet("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams);
  const diag = params.diag === "1";
  const probe = params.probe === "1";

  /* WHICH WINDOW THIS RUN IS FOR. Selected per invocation so one deployment
     serves every cadence; see CADENCE_TIERS. The tier is applied BEFORE the
     auth check reads nothing from it and BEFORE any request is made, and it
     is echoed in the response so a run says which schedule produced it. */
  const { cfg, tier } = applyCadenceTier(baseCfg, params.tier);

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
  /* RETIRED SPORTS ARE NEVER REQUESTED. Whatever CAPTURE_SPORTS names or the
     /sports discovery returns (an empty CAPTURE_SPORTS captures every active
     sport), a retired key (EDSPORTS) is dropped here, before a single odds
     request is made, and the run reports what it skipped. Stored rows for the
     sport are untouched. */
  const retiredSkipped = sports.filter((k) => EDSPORTS.isRetiredKey(k));
  sports = EDSPORTS.keepCurrentKeys(sports);
  autoAdded = EDSPORTS.keepCurrentKeys(autoAdded);
  if (!sports.length) {
    return json({
      ok: false, build: BUILD, error: "no sports to capture",
      stable_sports: stable, auto_prefixes: cfg.autoPrefixes, retired_sports_skipped: retiredSkipped,
      sports_discovery_ok: discoveryOk, sports_discovery_error: discoveryDetail || null,
      reason: retiredSkipped.length ? `every configured sport is retired (${retiredSkipped.join(", ")}), so nothing was requested.`
        : stable.length ? "CAPTURE_SPORTS is set but produced no keys after trimming."
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
  let altEligible = 0, altRequested = 0, altMerged = 0, altFailed = 0, altSkippedByCap = 0;
  const altErrorSamples: any[] = [];
  const perSportAlt: Record<string, { eligible: number; requested: number; merged: number; failed: number }> = {};
  /* The football boards this run captured, handed to the player-prop pass
     after every game line is written. */
  const propQueue: PropQueueItem[] = [];
  const propHours = playerPropHoursForTier(cfg, tier);
  /* the CFB Model Lab feed (see cfbLabQuotes); never part of the run status */
  const cfbLab: any = { enabled: cfg.cfbLab, sent: 0, skipped: {}, results: [] as any[], errors: [] as string[],
    quarantined: 0, quarantine_reasons: {} as Record<string, number>, quarantine_errors: [] as string[] };
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

    if (cfg.cfbLab && !diag && sport === CFB_LAB_SPORT) {
      try {
        const lab = cfbLabQuotes(res.data, nowIso, nowMs);
        for (const k in lab.skipped) cfbLab.skipped[k] = (cfbLab.skipped[k] ?? 0) + lab.skipped[k];
        for (let i = 0; i < lab.quotes.length && !outOfTime(); i += 1000) {
          const chunk = lab.quotes.slice(i, i + 1000);
          const r = await sendCfbLab(SB_URL, SB_KEY, chunk);
          if (r.ok) { cfbLab.sent += chunk.length; cfbLab.results.push(r.result); }
          else { cfbLab.errors.push(r.error); break; }
        }
        /* quotes that failed the integrity rules: kept for investigation
           (supabase/cfb_market_integrity.sql), fail-soft like the feed itself */
        if (lab.quarantined.length && !outOfTime()) {
          cfbLab.quarantined += lab.quarantined.length;
          for (const q of lab.quarantined) for (const x of q.reasons) cfbLab.quarantine_reasons[x] = (cfbLab.quarantine_reasons[x] ?? 0) + 1;
          const r = await sendCfbLab(SB_URL, SB_KEY, lab.quarantined, "cfb_market_quarantine_quotes");
          if (!r.ok) cfbLab.quarantine_errors.push(r.error);
        }
      } catch (e) { cfbLab.errors.push(String((e as Error)?.message ?? e)); }
    }
    funnel.events_returned += res.data.length;

    /* EVENT-LEVEL ALTERNATE LADDERS. Only NFL/NCAAF are enabled here because the
       downstream policy (key numbers, spread semantics, current product surface)
       is football-specific. The requests are bounded, sorted nearest-first, and
       made in small concurrent batches so the wall-clock budget still means
       something. */
    const altByEvent = new Map<string, any>();
    const altHours = alternateHoursForTier(cfg, tier);
    const group = sportGroup(sport);
    const altStat = perSportAlt[sport] = { eligible: 0, requested: 0, merged: 0, failed: 0 };
    if (altHours > 0 && (group === "nfl" || group === "ncaaf")) {
      const eligible = res.data
        .map((ev: any) => ({ ev, t: Date.parse(String(ev?.commence_time ?? "")) }))
        .filter((x: any) => Number.isFinite(x.t) && x.t >= nowMs && x.t <= nowMs + altHours * 3600000)
        .sort((a: any, b: any) => a.t - b.t);
      altStat.eligible = eligible.length;
      altEligible += eligible.length;
      const selected = eligible.slice(0, cfg.alternateMaxEvents);
      altSkippedByCap += Math.max(0, eligible.length - selected.length);

      for (let i = 0; i < selected.length && !outOfTime(); i += cfg.alternateConcurrency) {
        const batch = selected.slice(i, i + cfg.alternateConcurrency);
        const results = await Promise.all(batch.map(async ({ ev }: any) => {
          const eventId = String(ev?.id ?? "");
          if (!eventId) return { eventId, ev, res: null as OddsResult | null };
          return { eventId, ev, res: await fetchEventOdds(ODDS_KEY, sport, eventId, cfg) };
        }));
        for (const item of results) {
          if (!item.res) continue;
          altRequested++; altStat.requested++;
          if (item.res.quotaRemaining) quotaRemaining = item.res.quotaRemaining;
          if (item.res.quotaUsed) quotaUsed = item.res.quotaUsed;
          quotaSpent += Number(item.res.lastCost) || 0;
          if (!item.res.ok) {
            altFailed++; altStat.failed++;
            if (altErrorSamples.length < 8) altErrorSamples.push({
              sport, event_id: item.eventId, status: item.res.status, detail: item.res.detail,
            });
            continue;
          }
          const extra = item.res.data[0];
          if (extra) { altByEvent.set(item.eventId, extra); altMerged++; altStat.merged++; }
        }
      }
    }
    if (propHours > 0 && !diag && (group === "nfl" || group === "ncaaf")) propQueue.push({ sport, events: res.data });

    /* PRIOR STATE for persistence, in ONE read per sport. A candidate whose prior
       streak is unknown is treated as 0, which requires it to re-confirm: the
       conservative direction, and the direction that cannot manufacture a signal
       out of missing data. */
    const priorStreak = new Map<string, number>();
    if (!diag) {
      const horizon = new Date(nowMs + cfg.maxDaysToStart * 86400000).toISOString();
      const { rows, error } = await rest.select(
        /* Game lines only. Player rows (when CAPTURE_PLAYER_PROP_SIGNALS is on)
           are read by the prop pass; here they could only use up the row limit
           that a spread's streak depends on. */
        `signals?select=sig_key,qual_streak&sport_key=eq.${encodeURIComponent(sport)}&market=not.like.player_*`
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
        const eventId = String(ev?.id ?? "");
        const pricedEvent = altByEvent.has(eventId) ? mergeEventOdds(ev, altByEvent.get(eventId)) : ev;
        for (const bk of pricedEvent?.bookmakers ?? []) {
          const k = String(bk?.key ?? "").toLowerCase();
          if (k) { bookSet.add(k); if (cfg.referenceBooks.includes(k)) refSeen.add(k); }
        }
        pe = priceEvent(pricedEvent, cfg, nowMs);
      } catch (e) {
        eventErrors++;
        if (eventErrorSamples.length < 5) eventErrorSamples.push({ sport, event_id: ev?.id ?? null, error: String((e as Error)?.message ?? e) });
        continue;
      }
      malformedMarkets += pe.malformed;
      missingTimestamps += pe.missingTimestamps;
      duplicateQuotes += pe.duplicateQuotes;

      for (const c of pe.candidates) {
        /* Player markets belong to the second pass. The sport-wide endpoint
           never returns them and CAPTURE_MARKETS cannot name them, so this is a
           guard, not a path: a player row must never enter the game funnel. */
        if (c.is_player_prop) continue;
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

  /* ── THE PLAYER-PROP PASS. Every game line above is already written. ───── */
  const playerProps = await runPlayerProps({
    cfg, tier, oddsKey: ODDS_KEY, rest, nowMs, nowIso, outOfTime, queue: propQueue,
    quotaRemaining, diag, disabledByRequest: params.props === "0",
  });
  quotaSpent += playerProps.quota_spent || 0;
  if (playerProps.last_quota_remaining) quotaRemaining = playerProps.last_quota_remaining;
  if (playerProps.last_quota_used) quotaUsed = playerProps.last_quota_used;

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

    // ── alternate-line coverage ───────────────────────────────────────────
    alternate_lines: {
      enabled: cfg.alternateLines,
      markets: cfg.alternateMarkets,
      cadence_hours: alternateHoursForTier(cfg, tier),
      near_hours: cfg.alternateNearHours,
      max_hours: cfg.alternateMaxHours,
      max_events_per_sport_run: cfg.alternateMaxEvents,
      concurrency: cfg.alternateConcurrency,
      eligible_events: altEligible,
      requests: altRequested,
      merged_events: altMerged,
      failed_requests: altFailed,
      skipped_by_cap: altSkippedByCap,
      per_sport: perSportAlt,
      ...(altErrorSamples.length ? { errors: altErrorSamples } : {}),
      note: tier === "board"
        ? "BOARD intentionally skips per-event alternate ladders; DAY refreshes the research horizon and NEAR refreshes only the final window."
        : "alternate_spreads/totals are normalized to spreads/totals before qualification; point remains part of sig_key.",
    },

    // ── player props: captured in their own pass, never part of the status ──
    player_props: playerProps,
    prop_quota_spent: playerProps.quota_spent,
    prop_events_eligible: playerProps.events_eligible,
    prop_events_requested: playerProps.events_requested,
    prop_markets_requested: playerProps.markets_requested,
    prop_markets_returned: playerProps.markets_returned,
    prop_players_seen: playerProps.unique_players,
    prop_quotes_seen: playerProps.quotes_seen,
    prop_quotes_written: playerProps.quotes_written,
    prop_ticks_written: playerProps.ticks_written,
    prop_events_skipped_budget: playerProps.events_skipped_budget,
    prop_failures: playerProps.failures,
    ...(cfg.marketsIgnored.length ? {
      markets_ignored: cfg.marketsIgnored,
      markets_warning: "CAPTURE_MARKETS named player markets. The sport-wide endpoint refuses them and would have failed "
        + "the whole board, so they were removed from the featured request. Player markets are captured by the prop pass "
        + "(CAPTURE_PLAYER_PROP_MARKETS).",
    } : {}),

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
    stable_sports: stable, auto_prefixes: cfg.autoPrefixes, auto_added: autoAdded, retired_sports_skipped: retiredSkipped,
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
    cfb_lab: cfbLab,
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

    /* WHICH SCHEDULE PRODUCED THIS RUN. A board that looks under-captured is
       either a cadence that is not firing or a tier that is doing exactly what
       it was asked to; without this in the log those are the same picture. */
    cadence: {
      tier: tier,
      near_hours: cfg.nearHours,
      max_days_to_start: cfg.maxDaysToStart,
      cadence_min: tier ? CADENCE_TIERS[tier].cadenceMin : null,
      reader_rungs: tier ? rungsServed(CADENCE_TIERS[tier].cadenceMin) : null,
      note: tier ? CADENCE_TIERS[tier].note
        : "No ?tier= was named, so this run used the window the environment configures. "
          + "Scheduled runs name a tier; see CADENCE_TIERS.",
    },
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
      alternate_lines: {
        enabled: cfg.alternateLines, markets: cfg.alternateMarkets,
        max_hours: cfg.alternateMaxHours, near_hours: cfg.alternateNearHours,
        max_events: cfg.alternateMaxEvents, concurrency: cfg.alternateConcurrency,
      },
      player_props: {
        enabled: cfg.playerProps, signals: cfg.playerPropSignals,
        markets: cfg.playerPropMarkets, alternate_markets: cfg.playerPropAlternateMarkets,
        max_hours: cfg.playerPropMaxHours, near_hours: cfg.playerPropNearHours,
        max_events: cfg.playerPropMaxEvents, concurrency: cfg.playerPropConcurrency,
        markets_per_request: cfg.playerPropMarketsPerRequest,
        interval_min: cfg.playerPropIntervalMin, near_interval_min: cfg.playerPropNearIntervalMin,
        max_credits_per_run: cfg.propMaxCreditsPerRun, max_market_requests_per_run: cfg.propMaxMarketRequestsPerRun,
        min_quota_remaining: cfg.propMinQuotaRemaining,
        qualification: "two-sided Over/Under at one player's exact line only; the player_props edge floor is null, so none is actionable",
      },
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
