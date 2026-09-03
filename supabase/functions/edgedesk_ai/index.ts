// supabase/functions/edgedesk_ai/index.ts
// ============================================================================
// EdgeDesk Intelligence — research engine.  SINGLE-FILE BUILD.
//
// The Supabase dashboard editor deploys one file, so the research library that
// lives in _lib.ts during development is inlined below. Paste this whole file
// into the edgedesk_ai function and deploy. Nothing else is needed.
//
// Layout: PART 1 is the research library (retrieval, evidence, freshness,
// conflicts, completeness, snapshots, findings, scout, thesis attack).
// PART 1b is the PRESENTATION layer (deep engine, simple answer) — inlined
// byte-for-byte from _presentation.js, the same block app.html and brief.html
// carry. PART 2 is the orchestrator, the system prompt and the HTTP handler.
//
// CONTRACT (extended ADDITIVELY): the browser POSTs
//   { mode, question, packet, history, compare, presentation_mode? }
// and gets back
//   { answer, model?, cached?, research?, presentation? }
// `research` and `presentation` are additive. Any non-200 or thrown error
// makes the client fall back to its own deterministic engine, so this function
// is an ENHANCEMENT, never a dependency.
//
// WHAT CHANGED, ARCHITECTURALLY
//   Before: client packet -> Claude -> narration. The model could only discuss
//   whatever the browser happened to attach, which is why "who's the worst
//   pitcher today?" returned "pitcher quality data is not on file".
//
//   Now:  question -> classify intent -> build a research plan with a retrieval
//   budget -> RETRIEVE from EdgeDesk's own tables under the caller's JWT so RLS
//   applies exactly as in the browser -> normalize every fact with provenance
//   and freshness -> detect conflicts -> attack the thesis on owned numbers ->
//   read research memory -> Claude synthesizes THAT -> write the session back.
//
//   And now, on top: DETERMINISTIC DECISION -> TRANSLATE -> PRESENT. The
//   engine's verdict and price fields are translated into a structured
//   `presentation` object (SIMPLE / PUBLISHER) by EdgeDesk-owned code. The
//   model contributes ONLY copy — headline, why, watch, change trigger, market
//   read — inside a fenced block that is parsed and VALIDATED before a word of
//   it reaches the card. Rejected copy falls back to templated deterministic
//   copy. Narration failure never takes the decision card down.
//
// WHAT DID NOT CHANGE
//   The deterministic pipeline still owns every number. Nothing here computes
//   or adjusts a probability, fair price, edge, EV, CLV, confidence, score or
//   verdict. The research layer retrieves and interprets; it never models.
//
// ENV: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY.
//      Optional: EDGEDESK_AI_MODEL, EDGEDESK_AI_RESEARCH=0, EDGEDESK_MIN_PATTERN_N.
// ============================================================================

/* ========================================================================
   PART 1 — RESEARCH LIBRARY
   Source of truth: supabase/functions/edgedesk_ai/_lib.ts
   ======================================================================= */

// supabase/functions/edgedesk_ai/_lib.ts
// ============================================================================
// EdgeDesk Intelligence — research engine internals.
//
// Everything in this file is PURE LOGIC + DATA ACCESS. It is imported by
// index.ts, which owns the HTTP handler and the Anthropic call. Split this way
// so the research logic can be unit-tested without a server or an API key.
//
// THE ONE RULE THAT GOVERNS THIS FILE
//   EdgeDesk's deterministic pipeline owns every number: probability, fair
//   price, edge, EV, CLV, confidence, score, verdict, price sensitivity. This
//   layer RETRIEVES those numbers and the evidence around them. It never
//   computes, adjusts or replaces one. Where this file "ranks", it ranks
//   RESEARCH PRIORITY over already-owned fields — it never produces a betting
//   number.
//
// HONESTY CONTRACT
//   Every retrieval returns an Evidence[] with provenance {source, retrieved_at,
//   status, freshness}. A read that fails or comes back empty produces an
//   UNAVAILABLE evidence item naming the exact table and error. Nothing is ever
//   silently filled in. The model downstream is instructed to say "not available
//   in EdgeDesk's current data" whenever it sees one.
// ============================================================================

/* ------------------------------------------------------------------ types */

export type EvStatus =
  | "VERIFIED"      // owned table, current, unambiguous
  | "PROBABLE"      // owned but not confirmed (probable starters)
  | "PARTIAL"       // owned but incomplete (flagged arms only, not full usage)
  | "STALE"         // owned but past its freshness window
  | "UNPROVEN"      // owned model output, not CLV-validated
  | "HISTORICAL"    // a sample, not a current fact
  | "CONFLICT"      // two owned sources disagree
  | "UNAVAILABLE";  // could not be retrieved — say so, never fill it

export type Freshness = "CURRENT" | "RECENT" | "HISTORICAL" | "STALE" | "UNKNOWN";

export interface Evidence {
  /** Stable within one packet. Every number the analyst quotes traces to this. */
  id?: string;
  source: string;            // table / function that produced it
  entity: string | null;     // team, player, game, signal it describes
  field: string;             // what it is
  value: unknown;            // the owned value, verbatim
  status: EvStatus;
  freshness: Freshness;
  retrieved_at: number;
  source_timestamp?: string | null;
  relevance?: string;        // which research question it answers
  note?: string;
  /* ── CANONICAL IDENTITY ────────────────────────────────────────────────
     Names are display labels; ids are identity. These are populated wherever
     the owning table publishes one, and the cross-entity integrity checks key
     on them in preference to the name. A field that does not apply is simply
     absent — nothing is forced. */
  sport?: string | null;
  event_id?: string | null;
  team_id?: string | number | null;
  player_id?: string | number | null;
  /** The date this fact is ABOUT, not when it was read. */
  date?: string | null;
  /** Which layer this is, so a season rate can never be read as a matchup one.
      `external_model` is deliberately its own tier: SP+, FPI, ELO, KenPom-style
      ratings and the like are EVIDENCE, never an EdgeDesk probability, and the
      analytical hierarchy has to be able to say so without a comment. */
  layer?: "matchup" | "season" | "market" | "historical" | "context" | "external_model" | null;

  /* ── r3 ADDITIONS. Every one is OPTIONAL, so no existing emitter changes
     shape and no MLB evidence item is altered by their introduction. ───── */
  /** Where the fact came from, as a KIND rather than a table name. */
  source_type?: SourceType | null;
  /** L0..L10. `layer` is the analytical tier; this is the DATA layer. */
  data_layer?: DataLayer | null;
  /** League within the sport. NCAAF/FBS and NCAAF/FCS are not one population. */
  league?: string | null;
  /** The season this fact belongs to. A 2024 rate is not a 2025 fact. */
  season?: number | string | null;
  /** Canonical, sport-scoped team identity. Never a display name. */
  canonical_team_id?: string | null;
  /** Unit of `value` where a bare number would be ambiguous. */
  unit?: string | null;
  /** Free-form qualifiers: split, opponent, venue, situation. */
  context?: Record<string, unknown> | null;
  /** Human-readable retrieval path: provider, endpoint/table, how it was keyed. */
  provenance?: string | null;
  /** WHEN THE INFORMATION BECAME KNOWN — distinct from `date` (what it is about).
      The pair is what makes historical research non-leaky: a fact whose
      information_timestamp is after the as-of date did not exist yet. */
  information_timestamp?: string | null;
}

/** What kind of thing produced a fact. Drives the evidence hierarchy and the
    reliability ledger, and keeps an external rating from ever being read as an
    EdgeDesk number. */
export type SourceType =
  | "OWNED_TABLE"      // EdgeDesk's own normalized storage
  | "OWNED_MODEL"      // EdgeDesk model output — UNPROVEN, feeds no edge math
  | "OFFICIAL_FEED"    // the league's own API (MLB Stats API, etc.)
  | "PROVIDER_API"     // a third-party structured provider (CFBD, nflverse…)
  | "EXTERNAL_MODEL"   // SP+, FPI, DVOA, ELO, KenPom-style — evidence, NOT a price
  | "DERIVED"          // computed here from owned fields, by comparison only
  | "MARKET";          // prices

/** The DATA layer, per the sport-module contract. Orthogonal to `layer`:
    `layer` answers "how much analytical weight", this answers "what kind of
    row is it". Both are needed — a current-status injury and a matchup split
    are both matchup-relevant but are not the same kind of fact. */
export type DataLayer =
  | "L0_IDENTITY" | "L1_SCHEDULE" | "L2_RESULTS" | "L3_TEAM_SEASON"
  | "L4_PLAYER_SEASON" | "L5_MATCHUP" | "L6_CURRENT" | "L7_MARKET"
  | "L8_EXTERNAL_MODEL" | "L9_HISTORICAL" | "L10_LEARNING";

export interface Conflict {
  entity: string | null;
  field: string;
  a: { source: string; value: unknown };
  b: { source: string; value: unknown };
  resolution: string | null; // which source EdgeDesk trusts for this field, if any
}

export type Depth = "QUICK" | "STANDARD" | "DEEP" | "SLATE" | "FULL";

/* The named research modes the panel exposes. Depth is the retrieval budget;
   Mode is what kind of investigation it is. They are not the same axis: an
   ATTACK can be cheap and a SLATE sweep can be shallow. */
export type Mode =
  | "FAST" | "DEEP" | "ATTACK" | "COMPARE" | "HISTORICAL"
  | "MARKET" | "MATCHUP" | "SLATE" | "SCOUT" | "POSTMORTEM";

/* ========================================================================
   DATA INTEGRITY — audit the evidence BEFORE anything is allowed to rank it.
   ======================================================================== */

export type IntegrityVerdict = "PASS" | "WARNING" | "FAIL";

export interface IntegrityCheck {
  name: string;
  status: IntegrityVerdict;
  detail: string;
  entities?: string[];
}

export interface Integrity {
  verdict: IntegrityVerdict;
  checks: IntegrityCheck[];
  summary: string;
  /** One product-facing line: "30/30 starters · 100% delivered · 2h old". */
  headline: string;
}

/** What actually reached the model, so completeness can be audited honestly. */
export interface DeliveryFacts { included: number; withheld: number }

export interface IntegrityOpts {
  now?: number;
  staleDays?: number;
  /** ET slate days in scope, used to catch stats bound to the wrong date. */
  slateDays?: string[];
  /** Filled in after the evidence has been budgeted for the prompt. */
  delivered?: DeliveryFacts;
}

/** Numeric identity of a stat row, used to spot the same row served twice. */
function statFingerprint(v: any): string | null {
  if (!v || typeof v !== "object") return null;
  /* Counting stats that coincide often enough to be noise, PLUS every identity
     field. An id is not a measurement: including pitcher_id here made two
     genuinely identical stat lines look distinct purely because they belonged
     to different people, which is exactly the case the check exists to catch.
     Identity must never contribute to a statistical fingerprint. */
  const SKIP = new Set([
    "plate_appearances", "at_bats", "batters_faced", "games_started", "home_runs",
    "pitcher_id", "player_id", "team_id", "game_id", "event_id", "id",
  ]);
  const keys = Object.keys(v).filter((k) => typeof v[k] === "number" && !SKIP.has(k)).sort();
  // Two or three coincidental matches happen; a whole vector matching does not.
  if (keys.length < 4) return null;
  return keys.map((k) => `${k}=${v[k]}`).join("|");
}

const AGE_DAYS = (iso: unknown, now: number): number | null => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? (now - t) / 86400000 : null;
};

/**
 * Decide whether this evidence deserves to be analysed at all.
 *
 * Built after a slate answer ranked Skubal, Gray and Peralta as the three best
 * arms on the card while quoting one identical stat line for all three — and
 * explained the coincidence away in prose rather than treating it as a fault.
 * A convincing paragraph assembled from badly joined data is more dangerous
 * than an obvious gap, because nothing about it looks wrong.
 *
 * So the audit is deterministic and runs first. The model is told the verdict
 * and, on FAIL, is not permitted to publish a ranking at all. Auditing whether
 * the data deserves analysis is the job, not a preamble to it.
 */
export function evidenceIntegrity(
  evidence: Evidence[],
  opts: IntegrityOpts = {},
): Integrity {
  const now = opts.now ?? Date.now();
  const staleDays = opts.staleDays ?? 3;
  const checks: IntegrityCheck[] = [];
  const usable = evidence.filter((e) => e.status !== "UNAVAILABLE");

  const byField = (f: string) => usable.filter((e) => e.field === f);
  const pitchers = byField("pitcher_quality");
  const offenses = byField("opponent_offense");

  /* 1. IDENTITY — a pitcher's team must be one of the two teams in his game. */
  {
    const bad: string[] = [];
    let checked = 0;
    for (const e of pitchers) {
      const v = e.value as any;
      const team = String(v?.team ?? "").trim();
      const game = String(v?.game ?? "").trim();
      if (!team || !game || !game.includes("@")) continue;
      checked++;
      const sides = game.split("@").map((s) => s.trim().toLowerCase());
      if (!sides.some((s) => s === team.toLowerCase())) {
        bad.push(`${v?.name ?? e.entity}: listed with ${team} but scheduled in "${game}"`);
      }
    }
    checks.push(bad.length
      ? { name: "identity_chain", status: "FAIL", entities: bad.slice(0, 8),
          detail: `${bad.length} of ${checked} starters are attached to a team that is not playing in their own game. `
            + `Pitcher -> team -> game does not resolve, so any statement about who faces whom is unsafe.` }
      : { name: "identity_chain", status: "PASS",
          detail: checked
            ? `All ${checked} starters resolve pitcher -> team -> game consistently.`
            : "No starter carried both a team and a game to cross-check." });
  }

  /* 2. DUPLICATION — the same numeric vector on two different SUBJECTS.
     The subject is not always the evidence's entity. An opponent_offense item
     is filed under the pitcher who faces it, but the numbers describe his
     OPPONENT — so two starters facing the same club legitimately carry one
     identical season line, and keying on the pitcher reported that as a fault.
     It did, live: 15 "duplicate" pairs that were just the same teams appearing
     on both days of a two-day card. Key on what the numbers actually describe. */
  for (const [label, items, status] of [
    ["pitcher_stats", pitchers, "FAIL"],
    ["offense_stats", offenses, "WARNING"],
  ] as [string, Evidence[], IntegrityVerdict][]) {
    const seen = new Map<string, string[]>();
    for (const e of items) {
      const fp = statFingerprint(e.value);
      if (!fp) continue;
      const v = e.value as any;
      const who = String(v?.opponent ?? v?.team_name ?? v?.name ?? e.entity ?? "?");
      const at = seen.get(fp) ?? [];
      if (!at.includes(who)) at.push(who);
      seen.set(fp, at);
    }
    const dupes = [...seen.values()].filter((g) => g.length > 1);
    const affected = dupes.flat();
    checks.push(dupes.length
      ? { name: `duplicate_${label}`, status, entities: affected.slice(0, 12),
          detail: `${dupes.length} identical statistical profile${dupes.length === 1 ? "" : "s"} shared across `
            + `${affected.length} different entities: ${dupes.map((g) => g.join(" = ")).slice(0, 4).join("; ")}. `
            + `Distinct players do not share a whole feature vector — this is one record served more than once.` }
      : { name: `duplicate_${label}`, status: "PASS",
          detail: `No two of the ${items.length} ${label.replace("_", " ")} rows share a full numeric profile.` });
  }

  /* 3. FRESHNESS — how old is the newest thing being reasoned over.
     Measured across ALL dated subject evidence, not pitchers specifically.
     Keyed to pitchers, this fired on every non-baseball turn and made a WNBA
     answer open with "No pitcher data was retrieved for any game on the slate"
     — a baseball-shaped complaint about a basketball game, leading an answer
     that was otherwise correct. A check that cannot apply must stay silent
     rather than invent a concern. */
  {
    const SUBJECT_FIELDS = new Set([
      "pitcher_quality", "opponent_offense", "team_efficiency", "quarterback",
      "workload", "player_stats", "team_form",
    ]);
    const subjects = usable.filter((e) => SUBJECT_FIELDS.has(String(e.field)));
    const ages = subjects.map((e) => AGE_DAYS(e.source_timestamp ?? e.retrieved_at, now))
      .filter((a): a is number => a != null);

    if (!subjects.length) {
      /* Nothing whose age could matter was retrieved — a market-only turn.
         That is not a freshness problem; the market layer carries its own
         staleness handling and completeness already reports what is missing. */
      checks.push({ name: "freshness", status: "PASS",
        detail: "No dated subject evidence on this turn — nothing whose age could change the answer." });
    } else if (!ages.length) {
      checks.push({ name: "freshness", status: "WARNING",
        detail: `${subjects.length} subject rows were retrieved but none carried a source timestamp, `
          + `so their age cannot be established.` });
    } else {
      const newest = Math.min(...ages);
      const when = new Date(now - newest * 86400000).toISOString().slice(0, 10);
      checks.push(newest > staleDays
        ? { name: "freshness", status: "WARNING",
            detail: `The most recent subject record is ${Math.round(newest)} days old (${when}). `
              + `Any ranking built on it is provisional and must be labelled as such UP FRONT, not disclosed at the end.` }
        : { name: "freshness", status: "PASS",
            detail: `Newest subject record is ${newest < 1 ? "under a day" : Math.round(newest) + " days"} old.` });
    }
  }

  /* 4. NAMED SUBJECTS — an unnamed row cannot be attributed to anyone. */
  {
    const anon = usable.filter((e) => !String(e.entity ?? "").trim()).length;
    checks.push(anon
      ? { name: "attribution", status: "WARNING",
          detail: `${anon} evidence items carry no entity name, so their values cannot be safely attributed.` }
      : { name: "attribution", status: "PASS", detail: "Every evidence item names its subject." });
  }

  /* 5. COMPLETENESS — did the model actually receive everything retrieved?
     This is the check that would have caught the truncation bug on its own:
     coverage said 30/30 while the prompt carried a severed fraction of it. */
  {
    const d = opts.delivered;
    checks.push(!d
      ? { name: "completeness", status: "WARNING",
          detail: "Delivery was not measured, so it cannot be confirmed that every retrieved item reached the analyst." }
      : d.withheld > 0
        ? { name: "completeness", status: "WARNING",
            detail: `${d.included} of ${d.included + d.withheld} retrieved items reached the analyst; `
              + `${d.withheld} were withheld for size. Conclusions cover only what was delivered, and the `
              + `withheld subjects are named in the evidence-withheld note.` }
        : { name: "completeness", status: "PASS",
            detail: `All ${d.included} retrieved items were delivered to the analyst — nothing was truncated.` });
  }

  /* 6. TEMPORAL — is each fact valid for the date being asked about? */
  {
    const problems: string[] = [];
    const days = opts.slateDays?.length ? new Set(opts.slateDays) : null;
    let future = 0;
    for (const e of usable) {
      const ts = Date.parse(String(e.source_timestamp ?? ""));
      // A little clock skew between hosts is normal; an hour ahead is not.
      if (Number.isFinite(ts) && ts > now + 3600000) future++;
      const gd = String((e.value as any)?.game_date ?? "").slice(0, 10);
      if (days && gd && !days.has(gd)) {
        problems.push(`${e.entity ?? "?"} (${e.field}) carries game_date ${gd}, outside the slate`);
      }
    }
    if (future) problems.push(`${future} item${future === 1 ? "" : "s"} timestamped in the future`);
    checks.push(problems.length
      ? { name: "temporal", status: "WARNING", entities: problems.slice(0, 8),
          detail: `${problems.length} item${problems.length === 1 ? " is" : "s are"} bound to a date other than the one `
            + `being asked about. A stat attached to the wrong day is not a stat about today.` }
      : { name: "temporal", status: "PASS",
          detail: days
            ? `Every dated fact falls on the slate being asked about (${[...days].join(", ")}).`
            : "No dated fact contradicts the question's timeframe." });
  }

  /* 7. MARKET — are the prices and fair values internally coherent? */
  {
    const bad: string[] = [];
    let priced = 0;
    const PRICE_FIELDS = new Set(["signal", "sharp_reference", "closing_line", "book_spread"]);
    for (const e of usable) {
      if (!PRICE_FIELDS.has(String(e.field))) continue;
      const v = e.value as any;
      const who = String(e.entity ?? "?");
      const dec = [v?.best_dec, v?.pinnacle_dec, v?.pin_dec, v?.closing_dec].map(num).filter((x) => x != null);
      const fair = [v?.sharp_fair, v?.consensus_fair].map(num).filter((x) => x != null);
      if (!dec.length && !fair.length) continue;
      priced++;
      // Decimal odds below 1.0 pay less than the stake — not a price.
      if (dec.some((d) => d! <= 1)) bad.push(`${who}: decimal odds at or below 1.0`);
      // A de-vigged fair value is a probability. Outside (0,1) it is not one.
      if (fair.some((f) => f! <= 0 || f! >= 1)) bad.push(`${who}: fair value outside 0-1, not a probability`);
      const p = num(v?.pinnacle_dec ?? v?.pin_dec), q = num(v?.pinnacle_opp_dec ?? v?.pin_opp_dec);
      if (p && q && p > 1 && q > 1) {
        const ovr = 1 / p + 1 / q;
        // Below 1.0 is a free arbitrage against Pinnacle; it means stale sides.
        if (ovr < 0.98 || ovr > 1.25) bad.push(`${who}: two-way overround ${ovr.toFixed(3)} is incoherent`);
      }
    }
    checks.push(bad.length
      ? { name: "market", status: "FAIL", entities: bad.slice(0, 8),
          detail: `${bad.length} priced item${bad.length === 1 ? " is" : "s are"} not internally coherent. `
            + `An edge computed against an impossible price is not an edge.` }
      : { name: "market", status: "PASS",
          detail: priced ? `All ${priced} priced items are internally coherent.` : "No priced evidence to check." });
  }

  /* 8. SOURCE — is each fact coming from where it is supposed to come from?
     Serving pitcher quality from the live MLB API means the owned table is not
     being written. The answer can still be correct; the pipeline is not. */
  {
    const fallback = usable.filter((e) =>
      e.field === "pitcher_quality" && String(e.source) !== "pitcher_features");
    const owned = usable.filter((e) => e.field === "pitcher_quality").length - fallback.length;
    checks.push(fallback.length
      ? { name: "source", status: "WARNING",
          detail: `${fallback.length} pitcher record${fallback.length === 1 ? " is" : "s are"} being served from `
            + `${[...new Set(fallback.map((e) => e.source))].join(", ")} rather than EdgeDesk's own `
            + `pitcher_features table${owned ? ` (${owned} came from the owned table)` : ""}. `
            + `The live fallback is working, but the ingest that should populate the owned table is not.` }
      : { name: "source", status: "PASS",
          detail: "Every fact came from the source it was expected to come from." });
  }

  /* 9. CROSS-ENTITY — the identity chain, generalised past pitchers.
     Check 1 only ever looked at pitcher_quality, so a football answer could be
     built on a team_efficiency row attached to a game that team is not in and
     nothing would notice. Any item carrying both a subject team and a matchup
     is checked the same way. */
  {
    const bad: string[] = [];
    let checked = 0;
    for (const e of usable) {
      if (e.field === "pitcher_quality") continue;         // check 1 owns that one
      const v = e.value as any;
      const team = String(v?.team ?? v?.team_name ?? "").trim();
      const game = String(v?.game ?? "").trim();
      if (!team || !game || !game.includes("@")) continue;
      checked++;
      const sides = game.split("@").map((s) => normName(s));
      if (!sides.some((s) => s === normName(team))) {
        bad.push(`${e.entity ?? team} (${e.field}): listed with ${team}, which is not playing in "${game}"`);
      }
      // Home/away inversion: the declared side must match the side of the matchup.
      const side = String(v?.side ?? "").toLowerCase();
      if (side === "home" || side === "away") {
        const want = side === "away" ? sides[0] : sides[1];
        if (want && normName(team) !== want) {
          bad.push(`${e.entity ?? team} (${e.field}): marked ${side} but ${team} is the other side of "${game}"`);
        }
      }
    }
    checks.push(bad.length
      ? { name: "cross_entity_identity", status: "FAIL", entities: bad.slice(0, 8),
          detail: `${bad.length} of ${checked} non-pitcher items are attached to a team that is not in their own game, `
            + `or are marked on the wrong side of it. Every statement about who faces whom is unsafe.` }
      : { name: "cross_entity_identity", status: "PASS",
          detail: checked ? `All ${checked} team-keyed items resolve team -> game -> side consistently.`
            : "No team-keyed item carried both a team and a game to cross-check." });
  }

  /* 10. ONE SUBJECT, ONE TEAM — a person attached to two clubs in one packet
     is a join artefact, and it is the shape that puts a starter in the wrong
     dugout without changing a single number. */
  {
    const teamsOf = new Map<string, Set<string>>();
    for (const e of usable) {
      const v = e.value as any;
      const who = String(e.entity ?? "").trim();
      const team = String(v?.team ?? "").trim();
      if (!who || !team) continue;
      const s = teamsOf.get(personKey(who)) ?? new Set<string>();
      s.add(normName(team));
      teamsOf.set(personKey(who), s);
    }
    const split = [...teamsOf.entries()].filter(([, s]) => s.size > 1);
    checks.push(split.length
      ? { name: "subject_team_consistency", status: "FAIL",
          entities: split.map(([k, s]) => `${k}: ${[...s].join(" / ")}`).slice(0, 8),
          detail: `${split.length} subject${split.length === 1 ? " is" : "s are"} attached to more than one team in the `
            + `same packet. One of the joins is wrong and there is no way to tell which from the values alone.` }
      : { name: "subject_team_consistency", status: "PASS",
          detail: `Every named subject resolves to exactly one team.` });
  }

  /* 11. DUPLICATE EVENTS — the same matchup under two identifiers double-counts
     a game in every denominator built from it. */
  {
    const idsOf = new Map<string, Set<string>>();
    for (const e of usable) {
      const v = e.value as any;
      const game = String(v?.game ?? (e.field === "game" ? e.entity : "") ?? "").trim();
      const id = e.event_id ?? v?.game_id;
      if (!game || id == null) continue;
      const s = idsOf.get(normName(game)) ?? new Set<string>();
      s.add(String(id));
      idsOf.set(normName(game), s);
    }
    const dupes = [...idsOf.entries()].filter(([, s]) => s.size > 1);
    checks.push(dupes.length
      ? { name: "duplicate_event", status: "WARNING",
          entities: dupes.map(([g, s]) => `${g}: ${[...s].join(", ")}`).slice(0, 6),
          detail: `${dupes.length} matchup${dupes.length === 1 ? "" : "s"} appear under more than one event id. `
            + `A doubleheader legitimately does this; anything else is a duplicate that inflates every count built on it.` }
      : { name: "duplicate_event", status: "PASS", detail: "No matchup appears under two event ids." });
  }

  const verdict: IntegrityVerdict = checks.some((c) => c.status === "FAIL")
    ? "FAIL"
    : checks.some((c) => c.status === "WARNING") ? "WARNING" : "PASS";

  const failed = checks.filter((c) => c.status !== "PASS");
  const summary = verdict === "PASS"
    ? "All integrity checks passed."
    : `${verdict}: ` + failed.map((c) => c.name).join(", ");

  /* The one line a person reads. Facts only — no adjectives. */
  const headline = (() => {
    const bits: string[] = [];
    const named = pitchers.filter((e) => statFingerprint(e.value) != null).length;
    if (pitchers.length) bits.push(`${named}/${pitchers.length} starters with a full line`);
    else {
      const teams = usable.filter((e) => e.field === "team_efficiency");
      const withNums = teams.filter((e) => statFingerprint(e.value) != null).length;
      if (teams.length) bits.push(`${withNums}/${teams.length} teams with an efficiency line`);
    }
    const d = opts.delivered;
    if (d) {
      const total = d.included + d.withheld;
      bits.push(total ? `${Math.round((d.included / total) * 100)}% of evidence delivered` : "no evidence delivered");
    }
    const ages = pitchers.map((e) => AGE_DAYS(e.source_timestamp ?? e.retrieved_at, now))
      .filter((a): a is number => a != null);
    if (ages.length) {
      const newest = Math.min(...ages);
      bits.push(`freshest data ${newest < 1 / 24 ? "under an hour" : newest < 1
        ? Math.round(newest * 24) + "h" : Math.round(newest) + " days"} old`);
    }
    return bits.join(" · ");
  })();

  return { verdict, checks, summary, headline };
}

/**
 * Serialize evidence to a character budget WITHOUT ever cutting an item in half.
 *
 * This replaces a blind `JSON.stringify(...).slice(0, max)`. On a 30-starter
 * MLB slate the evidence array is ~69,000 characters against a 60,000 cap, so
 * the tail was severed mid-object — the model received a JSON string that
 * ended inside a key, and filled the hole from the last complete record it had
 * seen. That is what produced three different pitchers sharing one stat line
 * and two different lineups sharing one split. Worse, `coverage` is computed
 * server-side over the FULL array, so it kept reporting 30/30 for data the
 * model had never been shown: the honesty layer was certifying an absence.
 *
 * So: whole items only, and whatever will not fit is NAMED. A model told
 * "8 items were withheld, here is what they were" can say the slate is
 * incomplete. A model handed a severed string cannot even know it happened.
 */
export interface EvidenceBudget {
  text: string;
  included: number;
  dropped: number;
  droppedNote: string | null;
}

export function budgetEvidence(items: unknown[], max: number): EvidenceBudget {
  const encoded = items.map((it) => ({ it, s: JSON.stringify(it) ?? "null" }));
  const kept: string[] = [];
  const lost: string[] = [];
  let size = 2; // the enclosing [ ]

  for (const { it, s } of encoded) {
    // +1 for the separating comma once there is something to separate from.
    const cost = s.length + (kept.length ? 1 : 0);
    if (size + cost <= max) { kept.push(s); size += cost; continue; }
    const e = it as any;
    lost.push(`${e?.entity ?? "?"} (${e?.field ?? "?"})`);
  }

  let droppedNote: string | null = null;
  if (lost.length) {
    // Name as many as will fit in a readable line; count the rest.
    const shown: string[] = [];
    let n = 0;
    for (const l of lost) { if (n + l.length > 900) break; shown.push(l); n += l.length + 2; }
    droppedNote =
      `${lost.length} retrieved item${lost.length === 1 ? " was" : "s were"} withheld from this message `
      + `because the evidence exceeded the size budget: ${shown.join(", ")}`
      + (shown.length < lost.length ? `, and ${lost.length - shown.length} more` : "")
      + ". These were RETRIEVED SUCCESSFULLY but are not shown to you. You do not have their values. "
      + "Do not state, estimate or carry over figures for them, and do not reuse another entity's numbers "
      + "in their place — say the slate is larger than what you were shown and name what is missing.";
  }

  return { text: `[${kept.join(",")}]`, included: kept.length, dropped: lost.length, droppedNote };
}

/**
 * The direction a ranking question runs in, restated next to the intent.
 *
 * The standing BAD vs EXPLOITABLE prompt rule was written for "who is worst",
 * and it turned out strong enough to capture "who is BEST" as well: asked for
 * the best pitchers on the slate, the model opened by reframing the question
 * as most-exploitable, ranked the five worst arms on the card, and put the
 * actual best pitcher on the slate in a closing footnote headed "the one who
 * is NOT on the list". The classifier was right the whole time — it returned
 * intent=best_pitchers — so the axis has to travel WITH the intent rather
 * than being left for a general rule to infer, and get over-applied.
 */
export function rankingAxis(intent: string): string | null {
  switch (intent) {
    case "best_pitchers":
      return "The user asked who is BEST. Rank by pitching quality, strongest arm at #1, "
        + "and do not reorder by attackability. Give that ranking in full before any betting angle.";
    case "worst_pitchers":
    case "exploitable_pitchers":
      return "The user asked who is WORST or most exploitable. Rank by attackability — quality "
        + "read against the opponent, park, workload, bullpen and price — not by raw ERA.";
    case "best_matchups":
      return "The user asked for the BEST matchups. Name the axis you ranked on in the first "
        + "sentence, and rank in the direction the question asked for.";
    default:
      return null;
  }
}

/* Intents that are locked to one sport by definition. A question about
   starting pitchers is about baseball whether or not baseball leads the board,
   and routing it by board order is how a pitching question retrieved an MMA
   slate and concluded the pitching data was missing. */
export const MLB_INTENTS = new Set([
  "best_pitchers", "worst_pitchers", "exploitable_pitchers", "pitching_matchups",
  "starters", "bullpen", "offense_mlb",
]);
export const INTENT_SPORT: Record<string, string> = {
  best_pitchers: "baseball_mlb", worst_pitchers: "baseball_mlb",
  exploitable_pitchers: "baseball_mlb", pitching_matchups: "baseball_mlb",
  starters: "baseball_mlb", bullpen: "baseball_mlb", offense_mlb: "baseball_mlb",
};

/* Every sport-specific intent is PREFIXED with its sport, and the prefix is the
   binding. "best offenses" means three different things in three sports and
   needs three different evidence sets, so there is no shared `best_offenses`
   intent to be resolved later by context — the sport is decided at
   classification time and travels with the intent from then on. */
let INTENT_MAP_BUILT = false;
export function ensureIntentSportMap(): Record<string, string> {
  /* Lazy for the same reason the identity registry is: SPORT_INTELLIGENCE is
     declared further down the file, and reading it from a top-level loop here
     would touch its temporal dead zone and throw on import. */
  if (INTENT_MAP_BUILT) return INTENT_SPORT;
  INTENT_MAP_BUILT = true;
  for (const [sport, mod] of Object.entries(SPORT_INTELLIGENCE)) {
    for (const intent of mod.research_intents) {
      if (INTENT_SPORT[intent] == null) INTENT_SPORT[intent] = sport;
    }
  }
  return INTENT_SPORT;
}

/** The sport an intent is locked to, if any. */
export function sportOfIntent(intent: string): string | null {
  return ensureIntentSportMap()[intent] ?? null;
}

/**
 * Which sport is this question about, decided BEFORE any board order gets a vote.
 *
 * Routing by "whatever tops the board" is how a pitching question retrieved an
 * MMA slate and then reported that pitching data was missing. The sport comes
 * from the question: an explicit league word first, then a team name that
 * resolves in exactly one sport's registry, and only then nothing.
 *
 * Returning null is a real answer and a common one — "what should I bet
 * tonight?" is genuinely sport-agnostic and must stay that way.
 */
export function detectSport(question: string): { sport: string | null; via: string; confidence: "EXPLICIT" | "INFERRED" | "NONE" } {
  const q = " " + normName(question) + " ";
  const league: [RegExp, string, string][] = [
    [/\b(college football|cfb|ncaaf|ncaa football|fbs)\b/, "americanfootball_ncaaf", "an explicit college-football reference"],
    [/\b(college basketball|cbb|ncaab|ncaa basketball|march madness|ncaa tournament|the tournament|bracket)\b/, "basketball_ncaab", "an explicit college-basketball reference"],
    [/\b(nfl|pro football)\b/, "americanfootball_nfl", "an explicit NFL reference"],
    [/\bnba\b/, "basketball_nba", "an explicit NBA reference"],
    [/\b(mlb|baseball)\b/, "baseball_mlb", "an explicit baseball reference"],
    [/\b(nhl|hockey)\b/, "icehockey_nhl", "an explicit hockey reference"],
    [/\b(wnba)\b/, "basketball_wnba", "an explicit WNBA reference"],
  ];
  for (const [re, sport, via] of league) if (re.test(q)) return { sport, via, confidence: "EXPLICIT" };

  /* No league word. A team name can still decide it, but ONLY if it resolves in
     exactly one sport — "Giants" resolves in two and must stay unresolved. */
  const bySport = new Map<string, string[]>();
  for (const sport of Object.keys(SPORT_INTELLIGENCE)) {
    const hits = resolveTeamIdentity(question, sport).filter((m) => m.status === "RESOLVED");
    if (hits.length) bySport.set(sport, hits.map((h) => h.canonical_name!).filter(Boolean));
  }
  if (bySport.size === 1) {
    const [sport, names] = [...bySport][0];
    return { sport, via: `"${names.join(", ")}" resolves only in ${SPORT_INTELLIGENCE[sport].label}`, confidence: "INFERRED" };
  }
  if (bySport.size > 1) {
    return { sport: null, confidence: "NONE",
      via: `the named team resolves in more than one sport (${[...bySport.keys()].map((s) => SPORT_INTELLIGENCE[s]?.label ?? s).join(", ")}) — identity cannot decide the sport` };
  }
  return { sport: null, via: "no league word and no team that resolves to a single sport", confidence: "NONE" };
}

export const MODE_OF_INTENT: Record<string, Mode> = {
  worst_pitchers: "MATCHUP", exploitable_pitchers: "MATCHUP", best_pitchers: "MATCHUP",
  team_efficiency: "MATCHUP",
  best_matchups: "MATCHUP", offense: "MATCHUP", research_matchup: "DEEP",
  best_bets: "SLATE", slate_overview: "SLATE", bullpen: "SLATE", weather: "SLATE",
  traps: "SCOUT", research_priority: "SCOUT", signal_quality: "SCOUT",
  market_disagreement: "MARKET", what_changed: "MARKET", price: "MARKET",
  attack: "ATTACK", compare: "COMPARE", historical: "HISTORICAL",
  full_research: "DEEP", why: "FAST", unknown: "FAST",
};

/**
 * The mode for an intent, including the ones the sport modules added.
 *
 * MODE_OF_INTENT was written before the NFL, CFB and CBB modules introduced
 * their own intents. It registers 23 keys; those modules can emit 62 more, and
 * not one of them was added — so every one of those questions fell through
 * `?? "FAST"` and reported mode=FAST in the research trace
 * while executing a SLATE or DEEP retrieval plan. The label is what the research
 * trace shows the user and what `plan.mode === "SCOUT"` gates the research queue
 * on, so a wrong one is a wrong story about what the engine just did.
 *
 * Derived from the intent's own shape rather than restated per sport, so a new
 * `xyz_best_matchups` is classified correctly the day it is added.
 */
export function modeOfIntent(intent: string): Mode {
  const m = MODE_OF_INTENT[intent];
  if (m) return m;
  if (/_what_changed$/.test(intent)) return "MARKET";
  if (/_historical(_matchup)?$/.test(intent)) return "HISTORICAL";
  if (/_comparison$/.test(intent)) return "COMPARE";
  if (/_betting_candidate$/.test(intent)) return "SLATE";
  if (/_injury_impact$|_availability$|_roster$|_returning_production$|_portal$/.test(intent)) return "DEEP";
  if (/_(matchups?|offenses|defenses|quarterbacks|teams|players|sp_plus|recruiting)$/.test(intent)) return "MATCHUP";
  if (/^(nfl|cfb|cbb)_/.test(intent)) return "DEEP";
  return "FAST";
}

export interface Plan {
  intent: string;
  mode: Mode;
  depth: Depth;
  sport: string | null;
  steps: string[];           // named retrieval steps, in order
  entities: {
    teams: string[];
    players: string[];
    date: string | null;
    eventId: string | null;
    rank: number | null;
    /** How each club matched, so a cross-league alias can be dropped later. */
    team_matches: TeamMatch[];
    /** Candidate person references, resolved against the roster after retrieval. */
    player_hints: string[];
  };
  budget: number;            // max retrieval calls
  why: string;               // one line, shown in the research trace
}

export interface ResearchResult {
  plan: Plan;
  evidence: Evidence[];
  conflicts: Conflict[];
  unavailable: { source: string; reason: string }[];
  attack: { status: string; note: string } | null;
  memory: {
    facts: unknown[];
    outcomes: unknown[];
    patterns: unknown[];
    prior_sessions: unknown[];
  };
  data_path: Record<string, unknown>; // why a retrieval came back empty
  calls: number;
  ms: number;
}

/* ------------------------------------------------------------------ util */

export function nowMs(): number { return Date.now(); }

export function etDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

export function normName(s: unknown): string {
  let t = String(s ?? "").toLowerCase();
  try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch { /* older runtimes */ }
  return t.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** "Rodón, Carlos" and "Carlos Rodon" collapse to the same key. */
export function personKey(s: unknown): string {
  const raw = String(s ?? "");
  const flipped = raw.includes(",")
    ? raw.split(",").map((p) => p.trim()).reverse().join(" ")
    : raw;
  return normName(flipped);
}

/** Fallback key: first initial + last name, for "J. Sears" vs "JP Sears". */
export function personAlt(s: unknown): string {
  const parts = personKey(s).split(" ").filter(Boolean);
  if (parts.length < 2) return personKey(s);
  return parts[0].charAt(0) + " " + parts[parts.length - 1];
}

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/* Freshness windows per data category, in seconds. Sports facts are temporal:
   a price from an hour ago is not a current price, and a season stat from March
   is not a current stat. Nothing is presented as CURRENT past its window. */
export const TTL: Record<string, number> = {
  odds: 900, line_movement: 1800, lineup: 600, starter: 3600, game_status: 300,
  weather: 5400, bullpen: 21600, injury: 3600, news: 3600,
  player_stats: 172800, team_stats: 172800, park: 2592000,
  schedule: 7200, model: 21600, historical: 2592000, memory: 2592000,
};

/* Ladder: within TTL it is current; up to 2x it is recent; up to 6x it is
   historical context; past that it is stale and may not be used as a fact.
   Deliberately tighter than a generous "24x TTL" would be — a six-hour-old
   weather forecast is not weather, and this is where that gets enforced. */
export function freshnessOf(category: string, ts: number | string | null | undefined, now = Date.now()): Freshness {
  if (ts == null) return "UNKNOWN";
  const t = typeof ts === "number" ? ts : Date.parse(String(ts));
  if (!Number.isFinite(t)) return "UNKNOWN";
  const ttl = TTL[category];
  if (ttl == null) return "UNKNOWN";
  const age = (now - t) / 1000;
  if (age < 0) return "UNKNOWN";
  if (age <= ttl) return "CURRENT";
  if (age <= ttl * 2) return "RECENT";
  if (age <= ttl * 6) return "HISTORICAL";
  return "STALE";
}

export function ev(e: Partial<Evidence> & { source: string; field: string }): Evidence {
  const retrieved = e.retrieved_at ?? Date.now();
  const out: Evidence = {
    source: e.source,
    entity: e.entity ?? null,
    field: e.field,
    value: e.value ?? null,
    status: e.status ?? "VERIFIED",
    freshness: e.freshness ?? "UNKNOWN",
    retrieved_at: retrieved,
    source_timestamp: e.source_timestamp ?? null,
    relevance: e.relevance,
    note: e.note,
    sport: e.sport ?? null,
    event_id: e.event_id ?? null,
    team_id: e.team_id ?? null,
    player_id: e.player_id ?? null,
    date: e.date ?? null,
    layer: e.layer ?? null,
    /* r3. Undefined rather than null when unset, so an item that never carried
       one serializes without a field instead of with an empty one — the prompt
       is already large and a null on every item is 20KB of nothing. */
    source_type: e.source_type ?? undefined,
    data_layer: e.data_layer ?? undefined,
    league: e.league ?? undefined,
    season: e.season ?? undefined,
    canonical_team_id: e.canonical_team_id ?? undefined,
    unit: e.unit ?? undefined,
    context: e.context ?? undefined,
    provenance: e.provenance ?? undefined,
    information_timestamp: e.information_timestamp ?? undefined,
  };
  // Old information never masquerades as current information. Enforced here,
  // once, rather than trusted to every call site.
  if (out.status === "VERIFIED") {
    if (out.freshness === "STALE") out.status = "STALE";
    else if (out.freshness === "HISTORICAL") out.status = "HISTORICAL";
  }
  return out;
}

export function unavailable(source: string, field: string, reason: string, entity: string | null = null): Evidence {
  return ev({ source, field, entity, value: null, status: "UNAVAILABLE", freshness: "UNKNOWN", note: reason });
}


/* ---------------------------- Statcast CSV helpers -----------------------
   Same discipline as the ingest_mlb repair: quotes are stripped from VALUES as
   well as headers (parseFloat('"5.41"') is NaN, which silently drops a stat),
   and column lookup is exact-name-first with derived *_diff / *_minus_ columns
   excluded from fuzzy matching — otherwise a blank `xera` resolves to
   `era_minus_xera_diff` and the DIFF gets stored as the pitcher's xERA. */
export function csvRows(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const split = (l: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (const c of l) { if (c === '"') q = !q; else if (c === "," && !q) { out.push(cur); cur = ""; } else cur += c; }
    out.push(cur); return out;
  };
  const clean = (x: string) => x.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/""/g, '"').trim();
  const head = split(lines[0]).map(clean);
  return lines.slice(1).map((l) => {
    const c = split(l); const o: Record<string, string> = {};
    head.forEach((h, i) => o[h] = clean(c[i] ?? ""));
    return o;
  });
}

export function csvCol(row: Record<string, string>, needles: string[]): number | null {
  const keys = Object.keys(row);
  const derived = (k: string) => /(_diff|_minus_|percentile|_rank)/.test(k.toLowerCase());
  for (const n of needles) {
    const hit = keys.find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit) return num(row[hit]);
  }
  for (const n of needles) {
    const hit = keys.find((k) => !derived(k) && k.toLowerCase().startsWith(n.toLowerCase()));
    if (hit) return num(row[hit]);
  }
  for (const n of needles) {
    const hit = keys.find((k) => !derived(k) && k.toLowerCase().includes(n.toLowerCase()));
    if (hit) return num(row[hit]);
  }
  return null;
}

/* ------------------------------------------------- conflict detection */

/* Which source wins for a given field when two owned sources disagree.
   If a field is not listed, the conflict stands unresolved and lowers
   research confidence rather than being silently collapsed. */
export const TRUST: Record<string, string[]> = {
  probable_starter: ["mlb_game_cards", "pitcher_features"],
  fair_price: ["signals"],
  current_price: ["signals", "book_quotes"],
  weather: ["venue_weather", "mlb_game_cards", "weather_features"],
  game_status: ["mlb_game_cards", "games"],
};

export function findConflicts(list: Evidence[]): Conflict[] {
  const by: Record<string, Evidence[]> = {};
  for (const e of list) {
    if (e.status === "UNAVAILABLE") continue;
    const k = `${e.field}|${e.entity ?? ""}`;
    (by[k] ||= []).push(e);
  }
  const out: Conflict[] = [];
  for (const k of Object.keys(by)) {
    const arr = by[k];
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (a.source === b.source) continue;
        const na = num(a.value), nb = num(b.value);
        let disagree: boolean;
        if (na != null && nb != null) {
          const scale = Math.max(1e-9, Math.abs(na) + Math.abs(nb));
          disagree = Math.abs(na - nb) / scale > 0.02;
        } else {
          disagree = normName(JSON.stringify(a.value)) !== normName(JSON.stringify(b.value));
        }
        if (!disagree) continue;
        const order = TRUST[a.field];
        let resolution: string | null = null;
        if (order) {
          const ia = order.indexOf(a.source), ib = order.indexOf(b.source);
          if (ia >= 0 && ib >= 0 && ia !== ib) resolution = ia < ib ? a.source : b.source;
        }
        out.push({
          entity: a.entity, field: a.field,
          a: { source: a.source, value: a.value },
          b: { source: b.source, value: b.value },
          resolution,
        });
      }
    }
  }
  return out;
}

/* ========================================================================
   CANONICAL IDENTITY — a first-class system, not a name-matching helper.

   THE FAILURE THIS EXISTS TO MAKE STRUCTURALLY IMPOSSIBLE
   A display name is not an identity. "Giants" is a baseball club in San
   Francisco and a football club in New York; "Cardinals" is a baseball club in
   St. Louis and a football club in Arizona; "Miami" is two entirely different
   universities in two different states; "Texas Tech" is one university whose
   football team and basketball team share nothing but a campus. The previous
   resolver owned exactly one roster — baseball's — so every one of those
   collapsed onto an MLB club, and the wrong club's name was then printed to the
   analyst as the subject of the question.

   So identity is a RECORD, and every record is scoped by sport and league:

     canonical_team_id = "<SPORT_LABEL>:<LEAGUE>:<slug>"

   NFL:NFL:new-york-giants and MLB:MLB:san-francisco-giants are different
   strings, and `sameCanonicalTeam` returns false whenever the sports differ
   before it looks at anything else. Joining them is not merely discouraged, it
   is unrepresentable: there is no key under which they meet.

   The same school in two sports gets two ids — NCAAF:FBS:texas-tech and
   NCAAB:D1:texas-tech — because a football roster and a basketball roster are
   different populations with different statistics and different seasons.

   NOTHING HERE INVENTS AN EXTERNAL ID. `provider_ids` is declared as part of
   the contract and is populated at RUNTIME from rows that actually came back
   (see registerProviderIdentity), plus abbreviations, which are stable and
   verifiable from the name itself. A hardcoded numeric provider id that cannot
   be checked against a live row is precisely the sort of confident fabrication
   this engine exists to refuse.
   ======================================================================== */

export interface CanonicalTeam {
  canonical_team_id: string;
  canonical_name: string;
  display_name: string;
  /** sport_key, e.g. "americanfootball_nfl". The primary identity scope. */
  sport: string;
  sport_label: string;
  /** League/subdivision within the sport. FBS and FCS are not one population. */
  league: string;
  conference: string | null;
  city: string | null;
  state: string | null;
  abbreviation: string | null;
  /** Normalised tokens that identify this club UNIQUELY within its sport. */
  aliases: string[];
  /** Normalised tokens that are NOT unique — shared with another club, sport or
      league. A match on one of these is a hint, never an identity. */
  ambiguous_aliases: string[];
  /** provider -> provider's own id. Learned from retrieved rows. */
  provider_ids: Record<string, string>;
}

/** A provider's identity for a team, mapped into the canonical namespace.
    Time-bounded because conference membership and even team names change. */
export interface ProviderIdentity {
  provider: string;
  provider_id: string;
  provider_name: string;
  canonical_id: string | null;
  sport: string;
  league: string;
  valid_from: string | null;
  valid_to: string | null;
}

export const LEAGUE_OF_SPORT: Record<string, { label: string; league: string }> = {
  baseball_mlb: { label: "MLB", league: "MLB" },
  americanfootball_nfl: { label: "NFL", league: "NFL" },
  americanfootball_ncaaf: { label: "NCAAF", league: "FBS" },
  basketball_ncaab: { label: "NCAAB", league: "D1" },
  basketball_nba: { label: "NBA", league: "NBA" },
  basketball_wnba: { label: "WNBA", league: "WNBA" },
  icehockey_nhl: { label: "NHL", league: "NHL" },
};

export function teamSlug(name: unknown): string {
  return normName(name).replace(/\s+/g, "-");
}

export function canonicalTeamId(sportKey: string, name: string): string {
  const m = LEAGUE_OF_SPORT[sportKey] ?? { label: sportKey.toUpperCase(), league: "?" };
  return `${m.label}:${m.league}:${teamSlug(name)}`;
}

/* ---------------------------------------------------------------- NFL ---
   Thirty-two clubs with city, division and abbreviation. Nicknames that are
   unique in the NFL are still shared with baseball, hockey and college, so the
   ambiguity is declared per-token rather than assumed. */
const NFL_TEAMS: { name: string; city: string; state: string; abbr: string; conf: string; nick: string[] }[] = [
  { name: "Arizona Cardinals", city: "Glendale", state: "AZ", abbr: "ARI", conf: "NFC West", nick: ["cardinals", "cards"] },
  { name: "Atlanta Falcons", city: "Atlanta", state: "GA", abbr: "ATL", conf: "NFC South", nick: ["falcons"] },
  { name: "Baltimore Ravens", city: "Baltimore", state: "MD", abbr: "BAL", conf: "AFC North", nick: ["ravens"] },
  { name: "Buffalo Bills", city: "Orchard Park", state: "NY", abbr: "BUF", conf: "AFC East", nick: ["bills"] },
  { name: "Carolina Panthers", city: "Charlotte", state: "NC", abbr: "CAR", conf: "NFC South", nick: ["panthers"] },
  { name: "Chicago Bears", city: "Chicago", state: "IL", abbr: "CHI", conf: "NFC North", nick: ["bears"] },
  { name: "Cincinnati Bengals", city: "Cincinnati", state: "OH", abbr: "CIN", conf: "AFC North", nick: ["bengals"] },
  { name: "Cleveland Browns", city: "Cleveland", state: "OH", abbr: "CLE", conf: "AFC North", nick: ["browns"] },
  { name: "Dallas Cowboys", city: "Arlington", state: "TX", abbr: "DAL", conf: "NFC East", nick: ["cowboys"] },
  { name: "Denver Broncos", city: "Denver", state: "CO", abbr: "DEN", conf: "AFC West", nick: ["broncos"] },
  { name: "Detroit Lions", city: "Detroit", state: "MI", abbr: "DET", conf: "NFC North", nick: ["lions"] },
  { name: "Green Bay Packers", city: "Green Bay", state: "WI", abbr: "GB", conf: "NFC North", nick: ["packers", "pack"] },
  { name: "Houston Texans", city: "Houston", state: "TX", abbr: "HOU", conf: "AFC South", nick: ["texans"] },
  { name: "Indianapolis Colts", city: "Indianapolis", state: "IN", abbr: "IND", conf: "AFC South", nick: ["colts"] },
  { name: "Jacksonville Jaguars", city: "Jacksonville", state: "FL", abbr: "JAX", conf: "AFC South", nick: ["jaguars", "jags"] },
  { name: "Kansas City Chiefs", city: "Kansas City", state: "MO", abbr: "KC", conf: "AFC West", nick: ["chiefs"] },
  { name: "Las Vegas Raiders", city: "Las Vegas", state: "NV", abbr: "LV", conf: "AFC West", nick: ["raiders"] },
  { name: "Los Angeles Chargers", city: "Inglewood", state: "CA", abbr: "LAC", conf: "AFC West", nick: ["chargers", "bolts"] },
  { name: "Los Angeles Rams", city: "Inglewood", state: "CA", abbr: "LAR", conf: "NFC West", nick: ["rams"] },
  { name: "Miami Dolphins", city: "Miami Gardens", state: "FL", abbr: "MIA", conf: "AFC East", nick: ["dolphins", "fins"] },
  { name: "Minnesota Vikings", city: "Minneapolis", state: "MN", abbr: "MIN", conf: "NFC North", nick: ["vikings", "vikes"] },
  { name: "New England Patriots", city: "Foxborough", state: "MA", abbr: "NE", conf: "AFC East", nick: ["patriots", "pats"] },
  { name: "New Orleans Saints", city: "New Orleans", state: "LA", abbr: "NO", conf: "NFC South", nick: ["saints"] },
  { name: "New York Giants", city: "East Rutherford", state: "NJ", abbr: "NYG", conf: "NFC East", nick: ["giants"] },
  { name: "New York Jets", city: "East Rutherford", state: "NJ", abbr: "NYJ", conf: "AFC East", nick: ["jets"] },
  { name: "Philadelphia Eagles", city: "Philadelphia", state: "PA", abbr: "PHI", conf: "NFC East", nick: ["eagles"] },
  { name: "Pittsburgh Steelers", city: "Pittsburgh", state: "PA", abbr: "PIT", conf: "AFC North", nick: ["steelers"] },
  { name: "San Francisco 49ers", city: "Santa Clara", state: "CA", abbr: "SF", conf: "NFC West", nick: ["49ers", "niners"] },
  { name: "Seattle Seahawks", city: "Seattle", state: "WA", abbr: "SEA", conf: "NFC West", nick: ["seahawks", "hawks"] },
  { name: "Tampa Bay Buccaneers", city: "Tampa", state: "FL", abbr: "TB", conf: "NFC South", nick: ["buccaneers", "bucs"] },
  { name: "Tennessee Titans", city: "Nashville", state: "TN", abbr: "TEN", conf: "AFC South", nick: ["titans"] },
  { name: "Washington Commanders", city: "Landover", state: "MD", abbr: "WAS", conf: "NFC East", nick: ["commanders"] },
];

/* ------------------------------------------------------------ COLLEGE ---
   College identity is the dangerous one, so this list is curated for the
   COLLISIONS rather than for coverage. Every entry below exists because its
   short name is shared with something else; the long tail of unambiguous
   programs is registered at RUNTIME from cfb.teams, which is the authoritative
   provider registry EdgeDesk already ingests.

   `state` is the disambiguator and it is here because it is the one attribute
   that is both unambiguous and permanent. Conference is deliberately LEFT NULL:
   realignment moves it every year, and a stale hardcoded conference is a
   confident wrong answer. It is filled in from the ingested provider row when
   one is available. */
const COLLEGE_SCHOOLS: { school: string; state: string; football?: string; basketball?: string; nick: string[]; collides?: string[] }[] = [
  { school: "Miami", state: "FL", nick: ["hurricanes", "the u", "miami fl", "miami florida"], collides: ["miami"] },
  { school: "Miami (OH)", state: "OH", nick: ["redhawks", "miami oh", "miami ohio"], collides: ["miami"] },
  { school: "Washington", state: "WA", nick: ["huskies", "u dub", "udub"], collides: ["washington"] },
  { school: "Washington State", state: "WA", nick: ["cougars", "wsu", "wazzu"], collides: ["washington", "cougars"] },
  { school: "Texas", state: "TX", nick: ["longhorns"], collides: ["texas", "ut"] },
  { school: "Texas Tech", state: "TX", nick: ["red raiders", "ttu"], collides: ["texas", "tech"] },
  { school: "Texas A&M", state: "TX", nick: ["aggies", "texas am", "tamu"], collides: ["texas", "aggies"] },
  { school: "Tennessee", state: "TN", nick: ["volunteers", "vols"], collides: ["ut", "tennessee"] },
  { school: "Utah", state: "UT", nick: ["utes"], collides: ["ut", "utah"] },
  { school: "Utah State", state: "UT", nick: ["utah state aggies"], collides: ["utah", "aggies"] },
  { school: "Kansas", state: "KS", nick: ["jayhawks", "ku"], collides: ["kansas"] },
  { school: "Kansas State", state: "KS", nick: ["wildcats", "k state", "ksu"], collides: ["kansas", "wildcats"] },
  { school: "LSU", state: "LA", nick: ["tigers", "louisiana state"], collides: ["tigers"] },
  { school: "Louisiana", state: "LA", nick: ["ragin cajuns", "ul lafayette"], collides: ["louisiana"] },
  { school: "Ohio State", state: "OH", nick: ["buckeyes", "osu"], collides: ["ohio", "osu"] },
  { school: "Ohio", state: "OH", nick: ["bobcats"], collides: ["ohio"] },
  { school: "Oklahoma", state: "OK", nick: ["sooners", "ou"], collides: ["oklahoma"] },
  { school: "Oklahoma State", state: "OK", nick: ["cowboys", "okie state", "okst"], collides: ["oklahoma", "cowboys", "osu"] },
  { school: "Oregon", state: "OR", nick: ["ducks"], collides: ["oregon"] },
  { school: "Oregon State", state: "OR", nick: ["beavers"], collides: ["oregon"] },
  { school: "Michigan", state: "MI", nick: ["wolverines"], collides: ["michigan"] },
  { school: "Michigan State", state: "MI", nick: ["spartans", "msu"], collides: ["michigan", "msu"] },
  { school: "Mississippi State", state: "MS", nick: ["bulldogs", "miss state"], collides: ["mississippi", "bulldogs", "msu"] },
  { school: "Ole Miss", state: "MS", nick: ["rebels", "mississippi"], collides: ["mississippi"] },
  { school: "Alabama", state: "AL", nick: ["crimson tide", "bama"], collides: ["alabama"] },
  { school: "Auburn", state: "AL", nick: ["auburn tigers"], collides: ["tigers"] },
  { school: "Florida", state: "FL", nick: ["gators"], collides: ["florida"] },
  { school: "Florida State", state: "FL", nick: ["seminoles", "fsu", "noles"], collides: ["florida"] },
  { school: "South Florida", state: "FL", nick: ["usf", "bulls"], collides: ["florida", "usf", "bulls"] },
  { school: "USC", state: "CA", nick: ["southern california", "trojans"], collides: ["usc"] },
  { school: "South Carolina", state: "SC", nick: ["gamecocks"], collides: ["usc", "carolina"] },
  { school: "North Carolina", state: "NC", nick: ["tar heels", "unc"], collides: ["carolina"] },
  { school: "NC State", state: "NC", nick: ["wolfpack", "north carolina state", "ncsu"], collides: ["carolina", "nc"] },
  { school: "Indiana", state: "IN", nick: ["hoosiers", "iu"], collides: ["indiana"] },
  { school: "Illinois", state: "IL", nick: ["fighting illini", "illini"], collides: ["illinois"] },
  { school: "Iowa", state: "IA", nick: ["hawkeyes"], collides: ["iowa"] },
  { school: "Iowa State", state: "IA", nick: ["cyclones", "isu"], collides: ["iowa", "isu"] },
  { school: "Georgia", state: "GA", nick: ["bulldogs", "uga", "dawgs"], collides: ["georgia", "bulldogs"] },
  { school: "Georgia Tech", state: "GA", nick: ["yellow jackets", "gt"], collides: ["georgia", "tech"] },
  { school: "Arizona", state: "AZ", nick: ["arizona wildcats"], collides: ["arizona", "wildcats"] },
  { school: "Arizona State", state: "AZ", nick: ["sun devils", "asu"], collides: ["arizona", "asu"] },
  { school: "Colorado", state: "CO", nick: ["buffaloes", "buffs"], collides: ["colorado"] },
  { school: "Colorado State", state: "CO", nick: ["rams"], collides: ["colorado", "rams"] },
  { school: "Houston", state: "TX", nick: ["cougars"], collides: ["houston", "cougars"] },
  { school: "Memphis", state: "TN", nick: ["memphis tigers"], collides: ["tigers"] },
  { school: "Cincinnati", state: "OH", nick: ["bearcats"], collides: ["cincinnati"] },
  { school: "Villanova", state: "PA", nick: ["wildcats"], collides: ["wildcats"] },
  { school: "Kentucky", state: "KY", nick: ["kentucky wildcats"], collides: ["wildcats"] },
  { school: "Duke", state: "NC", nick: ["blue devils"], collides: [] },
  { school: "Gonzaga", state: "WA", nick: ["bulldogs", "zags"], collides: ["bulldogs"] },
  { school: "Baylor", state: "TX", nick: ["bears"], collides: ["bears"] },
  { school: "Purdue", state: "IN", nick: ["boilermakers"], collides: [] },
  { school: "UCLA", state: "CA", nick: ["bruins"], collides: [] },
  { school: "Marquette", state: "WI", nick: ["golden eagles"], collides: [] },
  { school: "Creighton", state: "NE", nick: ["bluejays"], collides: [] },
  { school: "Nebraska", state: "NE", nick: ["cornhuskers", "huskers"], collides: [] },
  { school: "Penn State", state: "PA", nick: ["nittany lions"], collides: ["penn"] },
  { school: "Penn", state: "PA", nick: ["quakers", "pennsylvania"], collides: ["penn"] },
  { school: "Notre Dame", state: "IN", nick: ["fighting irish", "irish"], collides: [] },
  { school: "Clemson", state: "SC", nick: ["clemson tigers"], collides: ["tigers"] },
  { school: "Wisconsin", state: "WI", nick: ["badgers"], collides: [] },
  { school: "Virginia", state: "VA", nick: ["cavaliers", "uva", "hoos"], collides: ["virginia"] },
  { school: "Virginia Tech", state: "VA", nick: ["hokies", "vt"], collides: ["virginia", "tech"] },
  { school: "West Virginia", state: "WV", nick: ["mountaineers", "wvu"], collides: ["virginia"] },
  { school: "Connecticut", state: "CT", nick: ["huskies", "uconn"], collides: ["huskies"] },
  { school: "Saint Mary's", state: "CA", nick: ["gaels", "st marys"], collides: ["st marys"] },
  { school: "Saint Joseph's", state: "PA", nick: ["hawks", "st josephs"], collides: ["hawks"] },
  { school: "TCU", state: "TX", nick: ["horned frogs", "texas christian"], collides: ["texas"] },
  { school: "SMU", state: "TX", nick: ["mustangs", "southern methodist"], collides: ["texas"] },
  { school: "BYU", state: "UT", nick: ["cougars", "brigham young"], collides: ["cougars"] },
  { school: "Missouri", state: "MO", nick: ["tigers", "mizzou"], collides: ["tigers", "missouri"] },
  { school: "Missouri State", state: "MO", nick: ["bears"], collides: ["missouri", "bears"] },
  { school: "Arkansas", state: "AR", nick: ["razorbacks", "hogs"], collides: ["arkansas"] },
  { school: "Arkansas State", state: "AR", nick: ["red wolves"], collides: ["arkansas"] },
  { school: "Minnesota", state: "MN", nick: ["golden gophers", "gophers"], collides: [] },
  { school: "Maryland", state: "MD", nick: ["terrapins", "terps"], collides: [] },
  { school: "Rutgers", state: "NJ", nick: ["scarlet knights"], collides: [] },
  { school: "Syracuse", state: "NY", nick: ["orange"], collides: [] },
  { school: "Louisville", state: "KY", nick: ["cardinals"], collides: ["cardinals"] },
  { school: "Pittsburgh", state: "PA", nick: ["panthers", "pitt"], collides: ["pittsburgh", "panthers"] },
  { school: "Boston College", state: "MA", nick: ["eagles", "bc"], collides: ["boston", "eagles"] },
  { school: "Wake Forest", state: "NC", nick: ["demon deacons"], collides: [] },
  { school: "Vanderbilt", state: "TN", nick: ["commodores", "vandy"], collides: [] },
];

/* Tokens that name a club in more than one sport or league. A match on one of
   these can never establish identity by itself — it is scoped by the resolved
   sport, and if the sport is unknown it comes back AMBIGUOUS with every
   candidate named. This set is BUILT rather than typed, so a club added to any
   registry above automatically contributes its collisions. */
const CROSS_SPORT_TOKEN: Map<string, Set<string>> = new Map();

/* SHORT COLLEGE TOKENS THAT ARE TRAPS.
   "UT" is Texas, Tennessee and Utah. "USC" is Southern California and South
   Carolina. "MSU" is Michigan State, Mississippi State and Missouri State.
   These cannot be resolved and must not be silently dropped either — a
   question that says "UT" and gets an answer about a school it did not mean is
   the worst outcome, but a question that says "UT" and gets no acknowledgement
   that the reference was seen is nearly as bad. They resolve to an explicit
   UNRESOLVED match naming every school the token could mean. */
const COLLEGE_SHORT_TRAP: Map<string, CanonicalTeam[]> = new Map();

export const CANONICAL_TEAMS: Map<string, CanonicalTeam> = new Map();
const CANON_BY_SPORT: Map<string, CanonicalTeam[]> = new Map();

function addCanonical(t: CanonicalTeam): CanonicalTeam {
  CANONICAL_TEAMS.set(t.canonical_team_id, t);
  const arr = CANON_BY_SPORT.get(t.sport) ?? [];
  arr.push(t);
  CANON_BY_SPORT.set(t.sport, arr);
  for (const a of [...t.aliases, ...t.ambiguous_aliases]) {
    const s = CROSS_SPORT_TOKEN.get(a) ?? new Set<string>();
    s.add(t.canonical_team_id);
    CROSS_SPORT_TOKEN.set(a, s);
  }
  return t;
}

/* ---- build the registry ------------------------------------------------
   LAZY, and deliberately so. The MLB half is built from MLB_TEAMS and
   CROSS_LEAGUE_ALIAS, which are declared FURTHER DOWN this file — a top-level
   build block would read them inside their temporal dead zone and throw on
   import, taking the whole function down at deploy time rather than at a call.
   Building on first use makes the identity graph independent of declaration
   order, which is the property you want in a single file that is edited often. */
let REGISTRY_BUILT = false;
function ensureCanonicalRegistry(): void {
  if (REGISTRY_BUILT) return;
  REGISTRY_BUILT = true;

  /* MLB. Aliases come from the EXISTING MLB_TEAMS list and ambiguity from the
     EXISTING CROSS_LEAGUE_ALIAS set, so the baseball path resolves exactly as
     it did before this system was introduced. That is deliberate: the
     regression requirement is that MLB behaviour is unchanged, and the cheapest
     way to guarantee it is to reuse the same data rather than restate it. */
  for (const t of MLB_TEAMS) {
    const full = normName(t.name);
    const safe = t.aliases.filter((a) => !CROSS_LEAGUE_ALIAS.has(a));
    const amb = t.aliases.filter((a) => CROSS_LEAGUE_ALIAS.has(a));
    const words = t.name.split(" ");
    addCanonical({
      canonical_team_id: canonicalTeamId("baseball_mlb", t.name),
      canonical_name: t.name, display_name: t.name,
      sport: "baseball_mlb", sport_label: "MLB", league: "MLB",
      conference: null, city: words.slice(0, -1).join(" ") || null, state: null,
      abbreviation: null,
      aliases: Array.from(new Set([full, ...safe])),
      ambiguous_aliases: Array.from(new Set(amb)),
      provider_ids: {},
    });
  }

  for (const t of NFL_TEAMS) {
    const full = normName(t.name);
    /* A nickname is ambiguous when ANY other registry already claims it, and
       city tokens always are — "arizona" is a Cardinal and a Diamondback,
       "washington" is a Commander and a Husky and a National. */
    const cityTok = normName(t.city);
    const nameCity = normName(t.name.split(" ").slice(0, -1).join(" "));
    const amb = new Set<string>();
    const safe = new Set<string>([full]);
    for (const n of t.nick) {
      (CROSS_SPORT_TOKEN.has(n) || CROSS_LEAGUE_ALIAS.has(n) ? amb : safe).add(n);
    }
    for (const c of [cityTok, nameCity]) if (c) amb.add(c);
    addCanonical({
      canonical_team_id: canonicalTeamId("americanfootball_nfl", t.name),
      canonical_name: t.name, display_name: t.name,
      sport: "americanfootball_nfl", sport_label: "NFL", league: "NFL",
      conference: t.conf, city: t.city, state: t.state, abbreviation: t.abbr,
      aliases: Array.from(safe),
      ambiguous_aliases: Array.from(amb),
      provider_ids: { abbr: t.abbr },
    });
  }

  /* Colleges are registered TWICE — once per sport — because the football team
     and the basketball team are different populations that merely share a
     crest. This is the mechanism that makes "Texas Tech football" and "Texas
     Tech basketball" different entities rather than one entity with a note. */
  for (const s of COLLEGE_SCHOOLS) {
    for (const [sport, label, league] of [
      ["americanfootball_ncaaf", "NCAAF", "FBS"],
      ["basketball_ncaab", "NCAAB", "D1"],
    ] as [string, string, string][]) {
      const full = normName(s.school);
      const collide = new Set((s.collides ?? []).map(normName));
      const safe = new Set<string>();
      const amb = new Set<string>();
      /* The school's own full name is unambiguous WITHIN a sport unless another
         school in the same list shares it, which is why the collision tokens
         are declared per school rather than inferred from a substring test. */
      if (collide.has(full)) amb.add(full); else safe.add(full);
      for (const n of s.nick) {
        const k = normName(n);
        (collide.has(k) || CROSS_SPORT_TOKEN.has(k) || CROSS_LEAGUE_ALIAS.has(k) ? amb : safe).add(k);
      }
      for (const c of collide) amb.add(c);
      const built = addCanonical({
        canonical_team_id: canonicalTeamId(sport, s.school),
        canonical_name: s.school, display_name: s.school,
        sport, sport_label: label, league,
        conference: null, city: null, state: s.state, abbreviation: null,
        aliases: Array.from(safe), ambiguous_aliases: Array.from(amb),
        provider_ids: {},
      });
      /* A declared collision token that is SHORT is a candidate abbreviation
         trap. The school whose own canonical name IS the token is included
         deliberately — "USC" must appear in its own trap alongside South
         Carolina, or the refusal names only one of the two schools it is
         refusing to choose between. Pruned to genuine collisions below. */
      for (const c of collide) {
        if (c.length > 4) continue;
        const arr = COLLEGE_SHORT_TRAP.get(c) ?? [];
        if (!arr.includes(built)) arr.push(built);
        COLLEGE_SHORT_TRAP.set(c, arr);
      }
    }
  }

  /* A "trap" claimed by exactly one school in a sport is not a trap, it is
     just that school's short name. Keeping those would refuse to resolve
     references that are perfectly unambiguous. */
  for (const [tok, teams] of [...COLLEGE_SHORT_TRAP]) {
    const bySport = new Map<string, number>();
    for (const t of teams) bySport.set(t.sport, (bySport.get(t.sport) ?? 0) + 1);
    if (![...bySport.values()].some((n) => n > 1)) COLLEGE_SHORT_TRAP.delete(tok);
  }
}

/** Every canonical team EdgeDesk knows for one sport. */
export function canonicalTeamsFor(sportKey: string): CanonicalTeam[] {
  ensureCanonicalRegistry();
  return CANON_BY_SPORT.get(sportKey) ?? [];
}

/** The whole identity graph, for diagnostics. */
export function canonicalRegistry(): CanonicalTeam[] {
  ensureCanonicalRegistry();
  return [...CANONICAL_TEAMS.values()];
}

/**
 * Two identities are the same team only if they are the same SPORT first.
 *
 * The sport check is not an optimisation, it is the guarantee. NFL New York
 * Giants and MLB San Francisco Giants share a nickname, a token, and nothing
 * else; this returns false before it ever compares a name.
 */
export function sameCanonicalTeam(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const [sa, la] = String(a).split(":");
  const [sb, lb] = String(b).split(":");
  if (sa !== sb || la !== lb) return false;
  return String(a) === String(b);
}

export interface IdentityMatch {
  query: string;
  via: string;
  canonical_team_id: string | null;
  canonical_name: string | null;
  sport: string | null;
  league: string | null;
  status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
  candidates: { canonical_team_id: string; canonical_name: string; sport: string; state: string | null }[];
  reason: string;
}

/* Abbreviation safety, per league. MLB and NFL abbreviations are published and
   stable enough to match on when the sport is already known. COLLEGE ONES ARE
   NOT, and never will be: "USC" is Southern California and South Carolina,
   "UT" is Texas and Tennessee and Utah, "MSU" is Michigan State and Mississippi
   State and Missouri State. Matching a college team on an abbreviation alone is
   forbidden outright rather than discouraged. */
export function abbreviationIsSafe(sportKey: string | null): boolean {
  return sportKey === "baseball_mlb" || sportKey === "americanfootball_nfl"
    || sportKey === "basketball_nba" || sportKey === "icehockey_nhl";
}

/**
 * Resolve every team reference in free text to a CANONICAL, SPORT-SCOPED id.
 *
 * Two rules govern the whole function.
 *   1. A token that names clubs in more than one sport resolves to nothing
 *      until the sport is known. It comes back AMBIGUOUS with every candidate
 *      listed, and the caller is told to ask rather than pick.
 *   2. When the sport IS known, only that sport's registry is searched. There
 *      is no code path in which a football question consults the baseball
 *      registry, which is what made "how do the Giants look tonight" answer
 *      with San Francisco during football season.
 */
export function resolveTeamIdentity(text: string, sportKey: string | null): IdentityMatch[] {
  ensureCanonicalRegistry();
  const q = " " + normName(text) + " ";
  const pool = sportKey ? canonicalTeamsFor(sportKey) : [...CANONICAL_TEAMS.values()];
  const collegeSport = sportKey === "americanfootball_ncaaf" || sportKey === "basketball_ncaab";

  /* Token -> which canonical teams in the searched pool claim it. Built over
     the POOL, not the whole registry, so scoping to a sport genuinely removes
     the other sport's claim rather than merely deprioritising it. */
  const claims = new Map<string, CanonicalTeam[]>();
  const hit = (tok: string, t: CanonicalTeam) => {
    if (!tok) return;
    /* SHORT-TOKEN RULE. Two- and three-letter tokens are collision-prone
       everywhere and lethal in college. They are allowed only when the league
       publishes stable abbreviations (MLB/NFL/NBA/NHL), or when the short token
       IS the school's own canonical name — "LSU", "TCU", "SMU", "BYU" are names,
       not abbreviations, and refusing them would make a third of the SEC
       unaskable. Everything else short is handled by the trap pass below. */
    if (tok.length <= 3 && !abbreviationIsSafe(sportKey)
      && normName(t.canonical_name) !== tok) return;
    if (!q.includes(" " + tok + " ") && !q.includes(" " + tok + "s ")) return;
    const arr = claims.get(tok) ?? [];
    if (!arr.includes(t)) arr.push(t);
    claims.set(tok, arr);
  };
  for (const t of pool) {
    for (const a of t.aliases) hit(a, t);
    for (const a of t.ambiguous_aliases) hit(a, t);
    if (t.abbreviation && abbreviationIsSafe(sportKey)) hit(normName(t.abbreviation), t);
  }

  /* THE ABBREVIATION TRAP PASS, run before anything else claims a token.
     A trapped abbreviation is REMOVED from the ordinary claim map so a school
     whose canonical name happens to equal it cannot quietly win — "USC" must
     not resolve to Southern California merely because South Carolina spells its
     own name out. */
  const trapped: IdentityMatch[] = [];
  if (!abbreviationIsSafe(sportKey)) {
    for (const [tok, teams] of COLLEGE_SHORT_TRAP) {
      if (!q.includes(" " + tok + " ")) continue;
      /* LONGEST MATCH WINS HERE TOO. " penn " is a substring of " penn state ",
         so a bare-token trap would fire on a question that named the school in
         full. If a longer token already claims this reference, the reference is
         not ambiguous and there is nothing to trap. */
      if ([...claims.keys()].some((k) => k.length > tok.length && (" " + k + " ").includes(" " + tok + " "))) continue;
      const inScope = sportKey ? teams.filter((t) => t.sport === sportKey) : teams;
      if (inScope.length < 2) continue;
      claims.delete(tok);
      trapped.push({
        query: tok, via: tok, canonical_team_id: null, canonical_name: null,
        sport: null, league: null, status: "UNRESOLVED",
        candidates: inScope.map((c) => ({
          canonical_team_id: c.canonical_team_id, canonical_name: c.canonical_name,
          sport: c.sport, state: c.state,
        })),
        reason: `"${tok.toUpperCase()}" is an abbreviation shared by `
          + `${inScope.map((c) => `${c.canonical_name} (${c.state ?? "?"})`).join(", ")}. `
          + `College teams are never resolved from an abbreviation alone — ask which school was meant.`,
      });
    }
  }

  /* Longest token first: "washington state" must win over "washington", and
     "miami oh" over "miami". Without this the more specific reference is
     shadowed by the vaguer one that is a substring of it. */
  const tokens = [...claims.keys()].sort((a, b) => b.length - a.length);
  const out: IdentityMatch[] = [...trapped];
  const claimed = new Set<string>();
  const consumed: string[] = trapped.map((t) => t.via);

  for (const tok of tokens) {
    // A longer, already-matched token that contains this one has consumed it.
    if (consumed.some((c) => c.includes(tok))) continue;
    const cands = claims.get(tok)!;
    const uniq = Array.from(new Map(cands.map((c) => [c.canonical_team_id, c])).values());
    const shape = uniq.map((c) => ({
      canonical_team_id: c.canonical_team_id, canonical_name: c.canonical_name,
      sport: c.sport, state: c.state,
    }));

    if (uniq.length === 1) {
      const t = uniq[0];
      const ambiguousToken = t.ambiguous_aliases.includes(tok);
      /* An ambiguous token with a single claimant inside a KNOWN sport is a
         real resolution — "arizona" means the Cardinals once the question is
         known to be football. With no sport it stays unresolved. */
      if (ambiguousToken && !sportKey) {
        out.push({
          query: tok, via: tok, canonical_team_id: null, canonical_name: null,
          sport: null, league: null, status: "AMBIGUOUS", candidates: shape,
          reason: `"${tok}" names a club in more than one sport and the question has not resolved to one. `
            + `Identity cannot be established from a display token alone.`,
        });
        continue;
      }
      if (claimed.has(t.canonical_team_id)) continue;
      claimed.add(t.canonical_team_id);
      consumed.push(tok);
      out.push({
        query: tok, via: tok, canonical_team_id: t.canonical_team_id,
        canonical_name: t.canonical_name, sport: t.sport, league: t.league,
        status: "RESOLVED", candidates: shape,
        reason: ambiguousToken
          ? `"${tok}" is shared across leagues but resolves uniquely inside ${t.sport_label}.`
          : `"${tok}" is unique to ${t.canonical_name} in ${t.sport_label}.`,
      });
      continue;
    }

    consumed.push(tok);
    out.push({
      query: tok, via: tok, canonical_team_id: null, canonical_name: null,
      sport: null, league: null, status: "AMBIGUOUS", candidates: shape,
      reason: collegeSport
        ? `"${tok}" matches ${uniq.length} programs (${shape.map((c) => `${c.canonical_name} (${c.state ?? "?"})`).join(", ")}). `
          + `College references need a school, a state or a conference — never a bare short name.`
        : `"${tok}" matches ${uniq.length} teams (${shape.map((c) => c.canonical_name).join(", ")}). Do not pick one.`,
    });
  }
  return out;
}

/* ---------------------------------------------------- provider identity ---
   Every external provider gets its own namespace. A provider id is NEVER
   assumed globally unique: the key is sport + league + provider + id, so
   "team 123" from one feed can never collide with "team 123" from another, or
   with the same number in a different sport. */
const PROVIDER_IDENTITIES: Map<string, ProviderIdentity> = new Map();

export function providerIdentityKey(provider: string, providerId: string, sport: string, league: string): string {
  return `${sport}|${league}|${provider}|${providerId}`;
}

/**
 * Bind a provider's row to a canonical team, or record that it could not be
 * bound. THIS NEVER GUESSES. A provider name that does not resolve inside the
 * declared sport is stored with canonical_id null and surfaces as an
 * identity-unresolved evidence item, which is the honest outcome — a wrong
 * binding is silent forever, an unresolved one is visible immediately.
 */
export function registerProviderIdentity(p: {
  provider: string; provider_id: string | number; provider_name: string;
  sport: string; league?: string; conference?: string | null; state?: string | null;
  valid_from?: string | null; valid_to?: string | null;
}): ProviderIdentity {
  ensureCanonicalRegistry();
  const league = p.league ?? LEAGUE_OF_SPORT[p.sport]?.league ?? "?";
  const id = String(p.provider_id);
  const matches = resolveTeamIdentity(p.provider_name, p.sport);
  let canonical: string | null =
    matches.find((m) => m.status === "RESOLVED")?.canonical_team_id ?? null;

  /* Not in the curated list. The provider row is itself authoritative for its
     own sport, so REGISTER it — this is how the long tail of college programs
     enters the identity graph without any of it being typed out by hand. */
  if (!canonical && p.provider_name) {
    const existing = canonicalTeamId(p.sport, p.provider_name);
    if (!CANONICAL_TEAMS.has(existing)) {
      const full = normName(p.provider_name);
      addCanonical({
        canonical_team_id: existing,
        canonical_name: p.provider_name, display_name: p.provider_name,
        sport: p.sport, sport_label: LEAGUE_OF_SPORT[p.sport]?.label ?? p.sport,
        league, conference: p.conference ?? null, city: null, state: p.state ?? null,
        abbreviation: null,
        /* Registered from a provider row, so the full name is trusted inside
           this sport; nothing else about it is. */
        aliases: CROSS_SPORT_TOKEN.has(full) ? [] : [full],
        ambiguous_aliases: CROSS_SPORT_TOKEN.has(full) ? [full] : [],
        provider_ids: { [p.provider]: id },
      });
    } else {
      const t = CANONICAL_TEAMS.get(existing)!;
      if (p.conference && !t.conference) t.conference = p.conference;
      t.provider_ids[p.provider] = id;
    }
    canonical = existing;
  } else if (canonical) {
    const t = CANONICAL_TEAMS.get(canonical);
    if (t) {
      t.provider_ids[p.provider] = id;
      if (p.conference && !t.conference) t.conference = p.conference;
    }
  }

  const rec: ProviderIdentity = {
    provider: p.provider, provider_id: id, provider_name: p.provider_name,
    canonical_id: canonical, sport: p.sport, league,
    valid_from: p.valid_from ?? null, valid_to: p.valid_to ?? null,
  };
  PROVIDER_IDENTITIES.set(providerIdentityKey(p.provider, id, p.sport, league), rec);
  return rec;
}

export function lookupProviderIdentity(
  provider: string, providerId: string | number, sport: string, league?: string,
): ProviderIdentity | null {
  const lg = league ?? LEAGUE_OF_SPORT[sport]?.league ?? "?";
  return PROVIDER_IDENTITIES.get(providerIdentityKey(provider, String(providerId), sport, lg)) ?? null;
}

/** Drop the learned identity graph. Used by the test suite so one sport's
    fixture cannot leak into the next; harmless in production. */
export function clearProviderIdentities(): void { PROVIDER_IDENTITIES.clear(); }

/**
 * The evidence item emitted when a provider row CANNOT be safely bound.
 *
 * This is the whole point of the identity layer: a row that cannot be attached
 * to a canonical team is not attached to a guess. It becomes a visible
 * unresolved-identity fact, and the analyst is told not to describe it.
 */
export function identityUnresolved(
  provider: string, providerName: string, sport: string, detail: string,
): Evidence {
  return ev({
    source: provider, field: "identity_unresolved", entity: providerName,
    value: { provider, provider_name: providerName, sport, detail },
    status: "UNAVAILABLE", freshness: "UNKNOWN",
    source_type: "PROVIDER_API", data_layer: "L0_IDENTITY", sport,
    note: `${provider} returned "${providerName}" but it could not be bound to a canonical ${sport} team — ${detail}. `
      + `No statistics from this row may be attributed to any named team.`,
  });
}

/* --------------------------------------------------- sport registry */

/* Core research (market, sharp reference, fair price, edge, confirmation,
   freshness, CLV, thesis attack) works for every sport, because `signals` is
   sport-agnostic. Sport-SPECIFIC research only exists where EdgeDesk actually
   owns the tables. Nothing here pretends a sport has a field it does not. */
export interface SportModule {
  key: string;
  label: string;
  status: "WIRED" | "CORE_ONLY";
  steps: string[];
  needs?: string;      // what ingestion would have to exist to wire it up
}

export const SPORTS: Record<string, SportModule> = {
  baseball_mlb: {
    key: "baseball_mlb", label: "MLB", status: "WIRED",
    steps: ["starters", "pitcher_features", "opponent_offense", "bullpen", "park", "weather", "workload", "team_form"],
  },
  americanfootball_nfl: {
    key: "americanfootball_nfl", label: "NFL", status: "WIRED",
    steps: ["team_efficiency", "quarterback", "matchup_context", "rest", "weather", "market"],
  },
  basketball_nba: {
    key: "basketball_nba", label: "NBA", status: "CORE_ONLY", steps: [],
    needs: "No NBA availability/rotation/efficiency tables are ingested. Core market research works; player availability and pace/efficiency research needs an NBA pipeline.",
  },
  icehockey_nhl: {
    key: "icehockey_nhl", label: "NHL", status: "CORE_ONLY", steps: [],
    needs: "No NHL goalie/xG/special-teams tables are ingested. Core market research works; goalie confirmation is the single highest-value missing input.",
  },
  mma_mixed_martial_arts: {
    key: "mma_mixed_martial_arts", label: "UFC/MMA", status: "CORE_ONLY", steps: ["rankings"],
    needs: "Fighter metrics live behind the ufc schema (ufc_fighters_sync / ufcstats_sync) and are not exposed to this function's reader. Core market research works.",
  },
  tennis_wta: {
    key: "tennis_wta", label: "WTA", status: "CORE_ONLY", steps: [],
    needs: "Surface/serve/return research lives behind the wta schema (wta_ingest / wta_elo / wta_research) and is not exposed to this function's reader. Core market research works.",
  },
  americanfootball_ncaaf: {
    key: "americanfootball_ncaaf", label: "CFB", status: "WIRED",
    steps: ["team_efficiency", "matchup_context", "rest", "rankings", "market"],
    /* Honest about the gap rather than quiet about it: there is no free
       play-by-play EPA feed for college football without a CollegeFootballData
       key, so the efficiency columns are usually null here even though the
       schedule, rankings, rest and situational layer are all present. */
    needs: "Schedule, rankings, rest, venue and situational context are ingested. Play-by-play EFFICIENCY (EPA per play, success rate) is not: there is no free CFB feed for it without a CollegeFootballData API key. Say so rather than substituting points per game.",
  },
  basketball_ncaab: {
    key: "basketball_ncaab", label: "CBB", status: "WIRED",
    steps: ["team_efficiency", "four_factors", "tempo", "matchup_context", "rest", "rankings", "market"],
  },
};

export function sportModule(key: string | null | undefined): SportModule | null {
  if (!key) return null;
  return SPORTS[key] ?? null;
}

/* ========================================================================
   SPORT INTELLIGENCE MODULES — one conceptual contract, four implementations.

   NFL and college basketball are NOT if/else branches bolted onto the baseball
   path. They implement the same contract MLB does, and MLB is the reference
   implementation precisely because it is the one that has been proven against
   real slates. What generalised is the SHAPE — identity, layers, intents,
   evidence hierarchy, completeness, sources, capabilities — and what stayed
   sport-specific is the only thing that should: what the numbers mean.

   The contract is declarative. It says what a sport HAS, what a question about
   it NEEDS, and where each fact comes from. Retrieval reads it; it does not
   re-derive it. That is what stops "which offence is best" from meaning the
   same thing in three sports where it obviously does not.
   ======================================================================== */

/** One row of the capability matrix: a thing a sport can know, and where from. */
export interface CapabilityCell {
  capability: string;
  source: string;
  source_type: SourceType;
  /** Table name, PostgREST path, or external endpoint. Never invented. */
  endpoint: string;
  /** PostgREST schema profile, when the table is not in `public`. */
  schema?: string | null;
  status:
    | "AVAILABLE"              // verified present in this project and read by this build
    | "PROBE"                  // may exist; the read is attempted and failure is reported honestly
    | "REQUIRES_CREDENTIAL"    // needs an env var that is not set
    | "REQUIRES_CONFIGURATION" // adapter exists, endpoint must be supplied before it is trusted
    | "NOT_AVAILABLE";         // genuinely not in this project — say so, never approximate
  /** TTL category from the freshness ladder. */
  freshness: string;
  credential: string | null;
  data_layer: DataLayer;
  notes: string;
}

export interface SportIntelligenceModule {
  key: string;
  label: string;
  league: string;
  status: "WIRED" | "CORE_ONLY";
  /** Season shape, which decides what "current" and "season-to-date" mean. */
  season: {
    type: "calendar_year" | "split_year";
    /** Which month (1-12) a new season is considered to start in ET. */
    starts_month: number;
    note: string;
  };
  identity: {
    /** May a team be matched from a 2-3 letter abbreviation alone? */
    abbreviation_safe: boolean;
    /** Does safe resolution need a conference/state as well as a name? */
    requires_disambiguator: boolean;
    note: string;
  };
  /** Which DATA layers this sport actually populates, and with what. */
  layers: Partial<Record<DataLayer, string[]>>;
  /** Question types this module knows how to plan for. */
  research_intents: string[];
  /** Analytical priority ORDER for this sport's fields — the answer to
      "which number decides it", which is different in every sport. */
  evidence_hierarchy: string[];
  /** Dimensions the learning loop tracks separately for this sport. */
  learning_dimensions: string[];
  capabilities: CapabilityCell[];
}

const CAP = (
  capability: string, source: string, source_type: SourceType, endpoint: string,
  status: CapabilityCell["status"], freshness: string, data_layer: DataLayer,
  notes: string, credential: string | null = null, schema: string | null = null,
): CapabilityCell => ({ capability, source, source_type, endpoint, schema, status, freshness, credential, data_layer, notes });

export const SPORT_INTELLIGENCE: Record<string, SportIntelligenceModule> = {
  /* ------------------------------------------------------------ MLB ------
     THE REFERENCE IMPLEMENTATION. Nothing here changes MLB behaviour; it
     DESCRIBES the behaviour that already exists so the other three modules
     have something to be measured against. */
  baseball_mlb: {
    key: "baseball_mlb", label: "MLB", league: "MLB", status: "WIRED",
    season: { type: "calendar_year", starts_month: 3, note: "One calendar year; the season label is the year it is played in." },
    identity: { abbreviation_safe: true, requires_disambiguator: false,
      note: "Thirty clubs with published, stable abbreviations. City tokens still collide with the NFL and NHL and are marked ambiguous." },
    layers: {
      L0_IDENTITY: ["mlb_game_cards.away_team_id/home_team_id", "pitcher_features.pitcher_id"],
      L1_SCHEDULE: ["mlb_game_cards", "games", "MLB Stats API /schedule"],
      L2_RESULTS: ["games.status", "signals.result"],
      L3_TEAM_SEASON: ["team_season", "MLB Stats API /teams/stats"],
      L4_PLAYER_SEASON: ["pitcher_season", "MLB Stats API /people", "Baseball Savant leaderboards"],
      L5_MATCHUP: ["pitcher_features", "offense_features", "platoon splits"],
      L6_CURRENT: ["mlb_game_cards probables", "mlb_bullpen_taxed", "venue_weather"],
      L7_MARKET: ["signals", "book_quotes", "signal_ticks", "market_residual"],
      L9_HISTORICAL: ["signals graded", "research_outcomes"],
      L10_LEARNING: ["research_patterns", "research_calibration"],
    },
    research_intents: ["best_pitchers", "worst_pitchers", "exploitable_pitchers", "best_matchups",
      "bullpen", "weather", "offense", "historical", "what_changed", "best_bets"],
    evidence_hierarchy: ["pitcher_quality", "opponent_offense", "workload", "bullpen_flag",
      "park", "weather", "season_pitching", "season_offense", "signal"],
    learning_dimensions: ["starter_quality", "bullpen_state", "park", "platoon_split", "weather"],
    capabilities: [
      CAP("schedule", "mlb_game_cards", "OWNED_TABLE", "mlb_game_cards", "AVAILABLE", "schedule", "L1_SCHEDULE", "Three-day ET window; completed games dropped at the source."),
      CAP("starters", "mlb_game_cards", "OWNED_TABLE", "mlb_game_cards", "AVAILABLE", "starter", "L6_CURRENT", "Probable, never confirmed."),
      CAP("pitching_matchup", "pitcher_features", "OWNED_TABLE", "pitcher_features", "AVAILABLE", "player_stats", "L5_MATCHUP", "Per-game, joined through games.game_id."),
      CAP("pitching_season", "pitcher_season", "OWNED_TABLE", "pitcher_season", "AVAILABLE", "player_stats", "L4_PLAYER_SEASON", "Identity-keyed; available from a name alone."),
      CAP("offense", "offense_features", "OWNED_TABLE", "offense_features", "AVAILABLE", "team_stats", "L5_MATCHUP", "Opposing side of the same game_id."),
      CAP("bullpen", "mlb_bullpen_taxed", "OWNED_TABLE", "mlb_bullpen_taxed", "AVAILABLE", "bullpen", "L6_CURRENT", "Flagged arms only — never full rest state."),
      CAP("park", "mlb_game_cards", "OWNED_TABLE", "mlb_game_cards", "AVAILABLE", "park", "L1_SCHEDULE", "Park/HR/run factors carried on the card."),
      CAP("weather", "venue_weather", "OWNED_TABLE", "venue_weather", "AVAILABLE", "weather", "L6_CURRENT", "Computed per venue; fresher than the card copy."),
      CAP("statcast", "Baseball Savant", "OFFICIAL_FEED", "baseballsavant.mlb.com/leaderboard", "AVAILABLE", "player_stats", "L4_PLAYER_SEASON", "Keyless CSV; read only when pitcher_features is empty."),
      CAP("official_feed", "MLB Stats API", "OFFICIAL_FEED", "statsapi.mlb.com/api/v1", "AVAILABLE", "schedule", "L1_SCHEDULE", "Keyless; the live fallback when owned tables are empty."),
      CAP("market", "signals", "MARKET", "signals", "AVAILABLE", "odds", "L7_MARKET", "Deterministic engine's own rows. Read-only."),
    ],
  },

  /* ------------------------------------------------------------ NFL ------ */
  americanfootball_nfl: {
    key: "americanfootball_nfl", label: "NFL", league: "NFL", status: "WIRED",
    season: { type: "split_year", starts_month: 9,
      note: "September through February. A January game belongs to the PREVIOUS calendar year's season — getting this wrong attaches a playoff game to a season that has not started." },
    identity: { abbreviation_safe: true, requires_disambiguator: false,
      note: "Thirty-two clubs. Nicknames collide with MLB (Giants, Cardinals, Panthers) and city tokens collide with everything, so both are marked ambiguous and resolved only inside the NFL registry." },
    layers: {
      L0_IDENTITY: ["canonical NFL registry", "team_features.team", "games.home_team/away_team"],
      L1_SCHEDULE: ["games (sport_key=americanfootball_nfl)"],
      L2_RESULTS: ["games.status", "signals.result"],
      L3_TEAM_SEASON: ["team_features", "game_stats"],
      L4_PLAYER_SEASON: ["qb_features", "stats_players (league=NFL)"],
      L5_MATCHUP: ["team_features opponent columns", "qb_features vs opponent pass defence"],
      L6_CURRENT: ["qb_features.status/is_backup/injury_note", "matchup_context rest"],
      L7_MARKET: ["signals", "book_quotes", "signal_ticks"],
      L9_HISTORICAL: ["signals graded", "research_outcomes"],
      L10_LEARNING: ["research_patterns", "research_calibration"],
    },
    research_intents: ["nfl_best_offenses", "nfl_worst_offenses", "nfl_best_defenses", "nfl_worst_defenses",
      "nfl_best_quarterbacks", "nfl_worst_quarterbacks", "nfl_best_matchups", "nfl_worst_matchups",
      "nfl_betting_candidate", "nfl_injury_impact", "nfl_what_changed", "nfl_historical_matchup",
      "nfl_team_comparison"],
    /* EFFICIENCY FIRST, ALWAYS. Points per game is a pace artifact and ranking
       on it is the single most common football error. */
    evidence_hierarchy: ["quarterback", "team_efficiency", "matchup_context",
      "nfl_player_production", "team_form", "weather", "signal", "rankings"],
    learning_dimensions: ["qb_status", "pressure_mismatch", "explosive_rate", "rest_and_travel", "weather_wind"],
    capabilities: [
      CAP("schedule", "games", "OWNED_TABLE", "games?sport_key=eq.americanfootball_nfl", "AVAILABLE", "schedule", "L1_SCHEDULE", "Written by ingest_multisport."),
      CAP("team_efficiency", "team_features", "OWNED_TABLE", "team_features", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "EPA/play both sides, success rate, pass/rush splits, explosive rate, yards/play, third down, red zone, turnover margin, sack rate taken and allowed, plays/game."),
      CAP("quarterback", "qb_features", "OWNED_TABLE", "qb_features", "AVAILABLE", "player_stats", "L4_PLAYER_SEASON",
        "EPA/dropback, CPOE, YPA, comp%, TD/INT rate, sack rate taken, pressure rate, rush EPA, QBR, attempts, starts, status, is_backup, injury note."),
      CAP("matchup_context", "matchup_context", "OWNED_TABLE", "matchup_context", "AVAILABLE", "schedule", "L5_MATCHUP",
        "Rest days, short week, off bye, neutral site, rivalry, venue, indoor, surface, altitude."),
      CAP("player_production", "stats_players", "OWNED_TABLE", "stats_players?league=eq.NFL", "AVAILABLE", "player_stats", "L4_PLAYER_SEASON",
        "Leaderboard line per player — a production summary, NOT a full stat profile. Target share, air yards and snap counts are not in it."),
      CAP("team_form", "game_stats", "OWNED_TABLE", "game_stats", "PROBE", "team_stats", "L3_TEAM_SEASON",
        "Records and form keyed on team_norm. Read is attempted and reported honestly if the table is not exposed."),
      CAP("weather", "venue_weather", "OWNED_TABLE", "venue_weather", "PROBE", "weather", "L6_CURRENT",
        "Keyed by event_id. Populated for MLB venues; an NFL row may or may not exist."),
      CAP("market", "signals", "MARKET", "signals", "AVAILABLE", "odds", "L7_MARKET", "Moneyline, spread and total with sharp reference and movement."),
      CAP("injuries_team_wide", "—", "OWNED_TABLE", "—", "NOT_AVAILABLE", "injury", "L6_CURRENT",
        "EdgeDesk ingests no NFL injury report. Only the QUARTERBACK carries a status, on qb_features. Say that rather than implying full injury coverage."),
      CAP("special_teams", "—", "OWNED_TABLE", "—", "NOT_AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "No kicking, punting or return columns exist in team_features. Not approximated."),
      CAP("snap_counts_and_target_share", "—", "OWNED_TABLE", "—", "NOT_AVAILABLE", "player_stats", "L4_PLAYER_SEASON",
        "Not ingested. stats_players carries a leaderboard line only."),
      CAP("nflverse", "nflverse", "PROVIDER_API", "(configure EDGEDESK_NFLVERSE_BASE)", "REQUIRES_CONFIGURATION", "team_stats", "L3_TEAM_SEASON",
        "Adapter is wired but NO endpoint is assumed. Set EDGEDESK_NFLVERSE=1 and EDGEDESK_NFLVERSE_BASE to a CSV release URL to enable. Disabled it emits an unavailable item rather than failing the module.",
        "EDGEDESK_NFLVERSE_BASE"),
    ],
  },

  /* ------------------------------------------------- COLLEGE FOOTBALL ---- */
  americanfootball_ncaaf: {
    key: "americanfootball_ncaaf", label: "CFB", league: "FBS", status: "WIRED",
    season: { type: "split_year", starts_month: 8,
      note: "August through January. A bowl or playoff game in January belongs to the previous calendar year's season." },
    identity: { abbreviation_safe: false, requires_disambiguator: true,
      note: "Never resolve a program from an abbreviation. Miami is two universities, Washington and Washington State are different schools, UT is three. School plus state or conference, or nothing." },
    layers: {
      L0_IDENTITY: ["cfb.teams (school, mascot, abbreviation, conference, classification)"],
      L1_SCHEDULE: ["cfb.games", "games (sport_key=americanfootball_ncaaf)"],
      L2_RESULTS: ["cfb.games.completed/home_points/away_points"],
      L3_TEAM_SEASON: ["cfb.team_season_stats", "cfb.records"],
      L4_PLAYER_SEASON: ["cfb.roster", "stats_players (league=CFB)"],
      L5_MATCHUP: ["cfb.games opponent pairing", "matchup_context"],
      L6_CURRENT: ["cfb.rankings", "matchup_context rest"],
      L7_MARKET: ["signals", "cfb.lines (consensus book numbers, NOT EdgeDesk prices)"],
      L8_EXTERNAL_MODEL: ["cfb.ratings (SP+)", "cfb.games pregame ELO", "cfb.analyst_flags"],
      L9_HISTORICAL: ["signals graded", "cfb.games prior seasons"],
      L10_LEARNING: ["research_patterns", "research_calibration"],
    },
    research_intents: ["cfb_best_offenses", "cfb_worst_offenses", "cfb_best_defenses",
      "cfb_best_quarterbacks", "cfb_best_teams", "cfb_best_matchups", "cfb_roster",
      "cfb_returning_production", "cfb_recruiting", "cfb_portal", "cfb_sp_plus",
      "cfb_betting_candidate", "cfb_what_changed"],
    evidence_hierarchy: ["cfb_team_season_stat", "cfb_sp_plus", "cfb_record", "cfb_game",
      "cfb_ranking", "cfb_recruiting", "cfb_roster", "matchup_context", "signal"],
    learning_dimensions: ["returning_production", "recruiting_gap", "sp_plus_disagreement",
      "conference_strength", "explosive_play_mismatch"],
    capabilities: [
      CAP("identity", "cfb.teams", "OWNED_TABLE", "teams", "AVAILABLE", "team_stats", "L0_IDENTITY",
        "School, mascot, abbreviation, conference and classification. The authoritative provider registry for CFB identity.", null, "cfb"),
      CAP("schedule", "cfb.games", "OWNED_TABLE", "games", "AVAILABLE", "schedule", "L1_SCHEDULE",
        "Season, week, season_type, start_date, completed, neutral site, conference game, venue, both team ids.", null, "cfb"),
      CAP("results", "cfb.games", "OWNED_TABLE", "games", "AVAILABLE", "historical", "L2_RESULTS",
        "home_points/away_points on completed games.", null, "cfb"),
      CAP("sp_plus", "cfb.ratings", "EXTERNAL_MODEL", "ratings", "AVAILABLE", "team_stats", "L8_EXTERNAL_MODEL",
        "CollegeFootballData SP+: overall, offence, defence, special teams, SOS and rankings. EXTERNAL MODEL — evidence, never an EdgeDesk probability and never converted into one.", null, "cfb"),
      CAP("elo", "cfb.games", "EXTERNAL_MODEL", "games (home_pregame_elo/away_pregame_elo)", "AVAILABLE", "team_stats", "L8_EXTERNAL_MODEL",
        "Pregame ELO carried on the schedule row. EXTERNAL MODEL.", null, "cfb"),
      CAP("team_season_stats", "cfb.team_season_stats", "OWNED_TABLE", "team_season_stats", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "Long-format stat_name/stat_value per team per season. Season aggregates — NOT per-play efficiency.", null, "cfb"),
      CAP("records", "cfb.records", "OWNED_TABLE", "records", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "Total and conference win/loss/tie.", null, "cfb"),
      CAP("rankings", "cfb.rankings", "OWNED_TABLE", "rankings", "AVAILABLE", "team_stats", "L6_CURRENT",
        "Poll rankings by week. A poll is an opinion, not a projection.", null, "cfb"),
      CAP("recruiting", "cfb.recruiting", "OWNED_TABLE", "recruiting", "AVAILABLE", "historical", "L3_TEAM_SEASON",
        "Class rank and points by year. Slow-changing — served from ingestion, never a live call.", null, "cfb"),
      CAP("roster", "cfb.roster", "OWNED_TABLE", "roster", "AVAILABLE", "player_stats", "L4_PLAYER_SEASON",
        "Name, position, jersey, year, height, weight per team. Roster presence is NOT a depth chart and never a confirmed starter.", null, "cfb"),
      CAP("book_lines", "cfb.lines", "MARKET", "lines", "AVAILABLE", "odds", "L7_MARKET",
        "Consensus book spread/total/moneyline by provider. CONTEXT ONLY — these are not Pinnacle and are not EdgeDesk prices.", null, "cfb"),
      CAP("analyst_flags", "cfb.analyst_flags", "OWNED_MODEL", "analyst_flags", "PROBE", "model", "L8_EXTERNAL_MODEL",
        "Another EdgeDesk module's derived classification, including SP+-implied and ELO-implied spreads. UNPROVEN and never an edge.", null, "cfb"),
      CAP("per_play_efficiency", "—", "OWNED_TABLE", "—", "NOT_AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "EPA per play and success rate are NOT ingested for CFB: per-game CFBD calls exceed the free tier. Say so; never substitute points per game or a poll ranking."),
      CAP("returning_production", "cfb.returning_production", "PROVIDER_API", "returning_production", "PROBE", "historical", "L3_TEAM_SEASON",
        "Read is ATTEMPTED against the cfb schema. If cfb_ingest does not write it the read fails and an unavailable item names the exact table and the CFBD endpoint that would fill it.", null, "cfb"),
      CAP("transfer_portal", "cfb.portal", "PROVIDER_API", "portal", "PROBE", "historical", "L3_TEAM_SEASON",
        "Same contract as returning production: attempted, and reported honestly when absent.", null, "cfb"),
      CAP("cfbd_direct", "CollegeFootballData", "PROVIDER_API", "api.collegefootballdata.com", "REQUIRES_CREDENTIAL", "team_stats", "L3_TEAM_SEASON",
        "Direct API calls for returning production and portal require CFBD_API_KEY. Without the key the adapter is skipped and the gap is declared — the module never fails as a whole.",
        "CFBD_API_KEY"),
      CAP("market", "signals", "MARKET", "signals", "AVAILABLE", "odds", "L7_MARKET", "EdgeDesk's own priced rows for CFB events."),
    ],
  },

  /* ----------------------------------------------- COLLEGE BASKETBALL ---- */
  basketball_ncaab: {
    key: "basketball_ncaab", label: "CBB", league: "D1", status: "WIRED",
    season: { type: "split_year", starts_month: 11,
      note: "November through April. The season is labelled by the year it ENDS in by most providers — a March game is not in the calendar year the November games were played in." },
    identity: { abbreviation_safe: false, requires_disambiguator: true,
      note: "The most dangerous identity space in the product: 360+ D1 programs, heavy name reuse, and feeds that abbreviate aggressively. School plus state or conference, never a short name." },
    layers: {
      L0_IDENTITY: ["canonical CBB registry", "team_features.team", "games.home_team/away_team"],
      L1_SCHEDULE: ["games (sport_key=basketball_ncaab)"],
      L2_RESULTS: ["games.status", "signals.result"],
      L3_TEAM_SEASON: ["team_features (adj_o, adj_d, adj_em, adj_tempo, four factors)"],
      L4_PLAYER_SEASON: ["stats_players (league=CBB)"],
      L5_MATCHUP: ["team_features opponent columns", "derived four-factor mismatch"],
      L6_CURRENT: ["matchup_context rest/neutral site", "rankings_current"],
      L7_MARKET: ["signals", "book_quotes"],
      L8_EXTERNAL_MODEL: ["(configure an external ratings source)"],
      L9_HISTORICAL: ["signals graded", "research_outcomes"],
      L10_LEARNING: ["research_patterns", "research_calibration"],
    },
    research_intents: ["cbb_best_offenses", "cbb_worst_offenses", "cbb_best_defenses",
      "cbb_best_teams", "cbb_best_players", "cbb_best_matchups", "cbb_pace_matchup",
      "cbb_shooting_matchup", "cbb_rebounding_matchup", "cbb_availability",
      "cbb_tournament", "cbb_betting_candidate", "cbb_historical", "cbb_what_changed"],
    /* TEMPO-FREE OR NOTHING. adj_em first because it is the single best
       one-number summary; the four factors say HOW, which is what turns a
       ranking into a matchup read. */
    evidence_hierarchy: ["team_efficiency", "cbb_matchup_edge", "matchup_context",
      "cbb_player_production", "rankings", "signal"],
    learning_dimensions: ["tempo_mismatch", "turnover_mismatch", "rebounding_mismatch",
      "three_point_dependency", "neutral_site", "rest"],
    capabilities: [
      CAP("schedule", "games", "OWNED_TABLE", "games?sport_key=eq.basketball_ncaab", "AVAILABLE", "schedule", "L1_SCHEDULE", "Written by ingest_multisport."),
      CAP("team_efficiency", "team_features", "OWNED_TABLE", "team_features", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "adj_o, adj_d, adj_em, adj_tempo — opponent-adjusted, tempo-free. adj_d is points ALLOWED per 100, so lower is better."),
      CAP("four_factors", "team_features", "OWNED_TABLE", "team_features", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "Offensive and defensive eFG%, turnover rate, offensive rebound rate and free-throw rate, plus three-point rate and percentage on both sides."),
      CAP("roster_context", "team_features", "OWNED_TABLE", "team_features", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "Average height, experience, bench minutes and wins-above-bubble. Variance context and tiebreakers, never a thesis."),
      CAP("matchup_context", "matchup_context", "OWNED_TABLE", "matchup_context", "AVAILABLE", "schedule", "L5_MATCHUP",
        "Neutral site, conference game, rest days, rankings, venue, altitude. Neutral site and rest matter more in tournament play."),
      CAP("matchup_edge", "team_features", "DERIVED", "(comparison of owned columns)", "AVAILABLE", "team_stats", "L5_MATCHUP",
        "Which side holds each four-factor and tempo axis, with BOTH owned numbers quoted. A comparison of owned fields — it produces no new metric and no betting number."),
      CAP("player_production", "stats_players", "OWNED_TABLE", "stats_players?league=eq.CBB", "PROBE", "player_stats", "L4_PLAYER_SEASON",
        "Leaderboard line per player. Minutes, usage, and lineup context are NOT in it — those are declared unavailable rather than estimated."),
      CAP("rankings", "rankings_current", "OWNED_TABLE", "rankings_current?league=eq.CBB", "PROBE", "team_stats", "L6_CURRENT",
        "Poll rankings where the capture wrote them for CBB."),
      CAP("market", "signals", "MARKET", "signals", "AVAILABLE", "odds", "L7_MARKET", "EdgeDesk's own priced rows for CBB events."),
      CAP("availability", "—", "OWNED_TABLE", "—", "NOT_AVAILABLE", "injury", "L6_CURRENT",
        "No CBB injury or lineup-availability table is ingested. This is the single highest-value missing input for the sport and must be stated, never inferred from minutes."),
      CAP("external_ratings", "BartTorvik / KenPom / NET", "EXTERNAL_MODEL", "(configure EDGEDESK_CBB_RATINGS_URL)", "REQUIRES_CONFIGURATION", "team_stats", "L8_EXTERNAL_MODEL",
        "Adapter is wired and NO endpoint is assumed. Supply a licensed or permitted source via EDGEDESK_CBB_RATINGS_URL. Any rating retrieved is EXTERNAL_MODEL evidence and is never converted into an EdgeDesk probability.",
        "EDGEDESK_CBB_RATINGS_URL"),
    ],
  },
};

export function intelligenceModule(key: string | null | undefined): SportIntelligenceModule | null {
  if (!key) return null;
  return SPORT_INTELLIGENCE[key] ?? null;
}

/** The capability matrix, flattened and inspectable. */
export function capabilityMatrix(sportKey?: string | null): CapabilityCell[] {
  const mods = sportKey
    ? [SPORT_INTELLIGENCE[sportKey]].filter(Boolean) as SportIntelligenceModule[]
    : Object.values(SPORT_INTELLIGENCE);
  return mods.flatMap((m) => m.capabilities.map((c) => ({ ...c, capability: `${m.label}.${c.capability}` })));
}

/**
 * Which season a date belongs to, for a sport whose season straddles New Year.
 *
 * A January NFL playoff game is part of the season that began the previous
 * September, and a March college basketball game is part of the season that
 * began in November. Labelling either by its calendar year attaches it to a
 * season that had not started, which silently empties every season-keyed
 * lookup — the failure looks like missing data rather than like a date bug.
 */
export function seasonFor(sportKey: string, dateISO?: string): number {
  const d = dateISO ? new Date(dateISO + (dateISO.length === 10 ? "T12:00:00Z" : "")) : new Date();
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;
  const mod = SPORT_INTELLIGENCE[sportKey];
  if (!mod || mod.season.type === "calendar_year") return y;
  /* Split-year sports are labelled by the year the season STARTED for football
     and by the year it started for basketball too — EdgeDesk's own ingest and
     CFBD both use the start year, so this matches the stored rows rather than
     a convention from somewhere else. */
  return mo >= mod.season.starts_month ? y : y - 1;
}

/* ------------------------------------------- MLB entity resolution */

/* Enough aliasing to resolve "Dodgers", "LAD", "Los Angeles Dodgers" and
   "D-backs" to one canonical club. Used only to FIND rows — never to invent
   one. If a name does not resolve, the research says so. */
export const MLB_TEAMS: { name: string; aliases: string[] }[] = [
  { name: "Arizona Diamondbacks", aliases: ["diamondbacks", "dbacks", "d backs", "arizona", "ari", "az"] },
  { name: "Atlanta Braves", aliases: ["braves", "atlanta", "atl"] },
  { name: "Baltimore Orioles", aliases: ["orioles", "os", "baltimore", "bal"] },
  { name: "Boston Red Sox", aliases: ["red sox", "redsox", "sox", "boston", "bos"] },
  { name: "Chicago Cubs", aliases: ["cubs", "chc"] },
  { name: "Chicago White Sox", aliases: ["white sox", "whitesox", "cws", "chw"] },
  { name: "Cincinnati Reds", aliases: ["reds", "cincinnati", "cin"] },
  { name: "Cleveland Guardians", aliases: ["guardians", "cleveland", "cle"] },
  { name: "Colorado Rockies", aliases: ["rockies", "colorado", "col"] },
  { name: "Detroit Tigers", aliases: ["tigers", "detroit", "det"] },
  { name: "Houston Astros", aliases: ["astros", "houston", "hou"] },
  { name: "Kansas City Royals", aliases: ["royals", "kansas city", "kc"] },
  { name: "Los Angeles Angels", aliases: ["angels", "laa", "anaheim"] },
  { name: "Los Angeles Dodgers", aliases: ["dodgers", "lad", "la dodgers"] },
  { name: "Miami Marlins", aliases: ["marlins", "miami", "mia"] },
  { name: "Milwaukee Brewers", aliases: ["brewers", "milwaukee", "mil"] },
  { name: "Minnesota Twins", aliases: ["twins", "minnesota", "min"] },
  { name: "New York Mets", aliases: ["mets", "nym"] },
  { name: "New York Yankees", aliases: ["yankees", "yanks", "nyy"] },
  { name: "Oakland Athletics", aliases: ["athletics", "as", "oakland", "oak"] },
  { name: "Philadelphia Phillies", aliases: ["phillies", "philadelphia", "phi"] },
  { name: "Pittsburgh Pirates", aliases: ["pirates", "bucs", "pittsburgh", "pit"] },
  { name: "San Diego Padres", aliases: ["padres", "san diego", "sd"] },
  { name: "San Francisco Giants", aliases: ["giants", "san francisco", "sf"] },
  { name: "Seattle Mariners", aliases: ["mariners", "seattle", "sea"] },
  { name: "St. Louis Cardinals", aliases: ["cardinals", "cards", "st louis", "stl"] },
  { name: "Tampa Bay Rays", aliases: ["rays", "tampa", "tb"] },
  { name: "Texas Rangers", aliases: ["rangers", "texas", "tex"] },
  { name: "Toronto Blue Jays", aliases: ["blue jays", "jays", "toronto", "tor"] },
  { name: "Washington Nationals", aliases: ["nationals", "nats", "washington", "wsh"] },
];

/* Aliases that are NOT unique to baseball. A nickname or a city shared with
   another league resolves to an MLB club here purely because this is the only
   roster the resolver owns — so "how does the Giants offence look tonight?"
   during football season came back "San Francisco Giants" and that name was
   handed to the analyst as the entity in focus for an NFL game.
   These matches are kept but MARKED. Once the sport is known, an ambiguous
   match against the wrong sport is dropped rather than trusted: a name is a
   display label, and a label that fits two leagues is not an identity. */
export const CROSS_LEAGUE_ALIAS = new Set([
  // nicknames shared with the NFL / NHL / NBA / college
  "giants", "cardinals", "cards", "rangers", "jets", "panthers", "kings", "tigers",
  // every city and state token: each one names a club in several leagues
  "arizona", "az", "atlanta", "atl", "baltimore", "bal", "boston", "bos",
  "chicago", "chc", "cincinnati", "cin", "cleveland", "cle", "colorado", "col",
  "detroit", "det", "houston", "hou", "kansas city", "kc", "miami", "mia",
  "milwaukee", "mil", "minnesota", "min", "philadelphia", "phi", "pittsburgh", "pit",
  "san diego", "sd", "san francisco", "sf", "seattle", "sea", "st louis", "stl",
  "tampa", "tb", "texas", "tex", "toronto", "tor", "washington", "wsh",
  "anaheim", "oakland", "oak", "la dodgers",
]);

export interface TeamMatch { name: string; via: string; ambiguous: boolean }

/** Resolve MLB clubs from free text, RECORDING how each one matched. */
export function resolveTeamsDetailed(question: string): TeamMatch[] {
  const q = " " + normName(question) + " ";
  const byName = new Map<string, TeamMatch>();
  for (const t of MLB_TEAMS) {
    const full = normName(t.name);
    for (const k of [full, ...t.aliases]) {
      // Two-letter abbreviations are too collision-prone to match loosely.
      if (k.length <= 3 && !q.includes(" " + k + " ")) continue;
      if (q.includes(" " + k + " ") || q.includes(" " + k + "s ")) {
        // The club's own full name is never ambiguous, whatever it contains.
        const ambiguous = k !== full && CROSS_LEAGUE_ALIAS.has(k);
        const prev = byName.get(t.name);
        if (!prev || (prev.ambiguous && !ambiguous)) byName.set(t.name, { name: t.name, via: k, ambiguous });
        if (!ambiguous) break;   // an unambiguous hit is as good as it gets
      }
    }
  }
  return [...byName.values()];
}

export function resolveTeams(question: string): string[] {
  return resolveTeamsDetailed(question).map((m) => m.name);
}

/** Drop MLB clubs that were only claimed through a cross-league alias, once the
    sport is known to be something other than baseball. */
export function scopeTeamsToSport(
  matches: TeamMatch[], sportKey: string | null,
): { teams: string[]; rejected: TeamMatch[] } {
  if (!sportKey || sportKey === "baseball_mlb") {
    return { teams: matches.map((m) => m.name), rejected: [] };
  }
  const kept = matches.filter((m) => !m.ambiguous);
  return { teams: kept.map((m) => m.name), rejected: matches.filter((m) => m.ambiguous) };
}

/* ------------------------------------------ player entity resolution */

/* Capitalised words that are not people. Without this every question donates a
   phantom player ("Who", "Today", "MLB") to the resolver. */
const NOT_A_NAME = new Set([
  "who", "what", "when", "where", "why", "how", "which", "the", "a", "an", "is", "are", "does",
  "do", "did", "can", "should", "would", "will", "i", "me", "my", "we", "us", "our", "you",
  "today", "tonight", "tomorrow", "yesterday", "now", "this", "that", "these", "those",
  "mlb", "nfl", "nba", "nhl", "cfb", "cbb", "wnba", "ufc", "mma", "atp", "wta", "ncaa",
  "edgedesk", "clv", "ev", "era", "fip", "whip", "xera", "epa", "qb", "ml", "over", "under",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "best", "worst", "top", "compare", "vs", "versus", "and", "or", "for", "with", "against",
]);

/**
 * Candidate PERSON references in the question, before anything is retrieved.
 *
 * These are hints, not identities. "Cole" is a hint that matches two starters on
 * a normal card; which one — if either — is a question only the retrieved roster
 * can answer. So this extracts, and `resolvePlayers` decides.
 */
export function playerHints(raw: string): string[] {
  const text = String(raw ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  const teamNames = new Set(resolveTeams(text).map((t) => normName(t)));
  const teamWords = new Set<string>();
  for (const t of MLB_TEAMS) {
    for (const w of normName(t.name).split(" ")) teamWords.add(w);
    for (const a of t.aliases) for (const w of a.split(" ")) teamWords.add(w);
  }

  // Two capitalised words in a row are a full name; a lone one is a surname hint.
  const re = /\b([A-Z][A-Za-zÀ-ÿ'’.-]+)(\s+([A-Z][A-Za-zÀ-ÿ'’.-]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const first = m[1], second = m[3];
    const full = second ? `${first} ${second}` : first;
    const key = normName(full);
    if (!key || seen.has(key)) continue;
    const words = key.split(" ");
    if (words.every((w) => NOT_A_NAME.has(w) || teamWords.has(w))) continue;
    if (teamNames.has(key)) continue;
    if (words.length === 1 && (NOT_A_NAME.has(key) || teamWords.has(key) || key.length < 3)) continue;
    seen.add(key);
    out.push(full);
  }
  return out.slice(0, 6);
}

export interface PlayerResolution {
  query: string;
  resolved: string | null;
  candidates: string[];
  status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
}

/**
 * Bind each hint to a person who actually appears in the retrieved data.
 *
 * NEVER guesses. A surname matching two starters on the card comes back
 * AMBIGUOUS with both candidates named, and the analyst is told to ask rather
 * than pick — because picking is how a question about one Cole gets answered
 * with the other Cole's numbers, in a paragraph that reads perfectly.
 */
export function resolvePlayers(hints: string[], known: string[]): PlayerResolution[] {
  const roster = Array.from(new Set(known.filter(Boolean).map(String)));
  return hints.map((h) => {
    const hk = personKey(h);
    if (!hk) return { query: h, resolved: null, candidates: [], status: "UNRESOLVED" as const };

    const exact = roster.filter((n) => personKey(n) === hk);
    if (exact.length === 1) return { query: h, resolved: exact[0], candidates: exact, status: "RESOLVED" as const };
    if (exact.length > 1) return { query: h, resolved: null, candidates: exact, status: "AMBIGUOUS" as const };

    // "J. Sears" vs "JP Sears"
    const alt = roster.filter((n) => personAlt(n) === personAlt(h));
    if (alt.length === 1) return { query: h, resolved: alt[0], candidates: alt, status: "RESOLVED" as const };
    if (alt.length > 1) return { query: h, resolved: null, candidates: alt, status: "AMBIGUOUS" as const };

    /* A lone token is a surname OR a first name — "Cole" is both on a normal
       card (Gerrit Cole, Cole Ragans). Match either end and let the count
       decide; two hits is ambiguity, and ambiguity is the answer. */
    const parts = hk.split(" ").filter(Boolean);
    if (parts.length === 1) {
      const tok = parts[0];
      const hits = roster.filter((n) => {
        const w = personKey(n).split(" ").filter(Boolean);
        return w.length > 0 && (w[w.length - 1] === tok || w[0] === tok);
      });
      if (hits.length === 1) return { query: h, resolved: hits[0], candidates: hits, status: "RESOLVED" as const };
      if (hits.length > 1) return { query: h, resolved: null, candidates: hits, status: "AMBIGUOUS" as const };
    }
    return { query: h, resolved: null, candidates: [], status: "UNRESOLVED" as const };
  });
}

/* -------------------------------------------- intent classification */

/* Deterministic first: cheap, testable, and right for the questions users
   actually ask. index.ts may call the model to classify anything that lands
   on `unknown`, but the system never depends on that call succeeding. */
export function classify(question: string, mode?: string): Plan {
  const raw = String(question ?? "");
  const q = normName(raw);
  const has = (...xs: string[]) => xs.some((x) => q.includes(normName(x)));
  const rankMatch = raw.match(/#\s*(\d+)/);

  const team_matches = resolveTeamsDetailed(raw);
  const entities = {
    teams: team_matches.map((m) => m.name),
    players: [] as string[],
    date: null as string | null,
    eventId: null as string | null,
    rank: rankMatch ? parseInt(rankMatch[1], 10) : null,
    team_matches,
    player_hints: playerHints(raw),
  };

  const P = (intent: string, depth: Depth, steps: string[], why: string): Plan => ({
    intent, mode: modeOfIntent(intent), depth, sport: null, steps, entities,
    /* SLATE was given 12 reads — FEWER than DEEP's 14 — while being the depth
       that retrieves the most: board, card, the three-table pitcher join,
       usage, season pitching, season offense, bullpen, weather, CLV history
       plus its exact count, and then whatever the adaptive second pass needs.
       That is ~13 before a single probe or fallback, so a full MLB slate
       reliably hit "research budget exhausted before this read" partway
       through and the analyst reported the tail of the card as missing data.
       A slate sweep is the widest thing this engine does and is budgeted as
       such; QUICK and STANDARD are untouched, so a cheap question stays cheap. */
    budget: depth === "QUICK" ? 4 : depth === "STANDARD" ? 8 : depth === "DEEP" ? 14 : depth === "SLATE" ? 20 : 24,
    why,
  });

  // A postmortem is about a decision EdgeDesk already made, not today's board.
  if (has("postmortem", "why did we", "why did edgedesk", "what went wrong", "how did we do", "review that bet"))
    return { ...P("postmortem", "DEEP", ["focus_signal", "closing_line", "clv_history", "memory", "market"], "Postmortem on a graded decision."), mode: "POSTMORTEM" };

  if (has("what should i research", "research next", "research queue", "deserves attention", "scout"))
    return { ...P("research_priority", "SLATE", ["slate", "market", "sharp_reference", "matchup"], "Scout the board for what deserves research time."), mode: "SCOUT" };

  // Explicit modes from the client's buttons win over text parsing.
  if (mode === "price") return P("price", "QUICK", ["focus_signal", "market"], "Price question — the owned price-sensitivity fields answer it.");
  if (mode === "whatchanged") return P("what_changed", "STANDARD", ["focus_signal", "market", "line_movement", "closing_line"], "Movement question — compare detection, current and close.");
  if (mode === "challenge") return P("attack", "DEEP", ["focus_signal", "market", "sharp_reference", "matchup", "bullpen", "weather", "clv_history", "memory"], "Thesis attack — retrieve everything that could break it.");
  if (mode === "trace" || mode === "research") return P("full_research", "FULL", ["focus_signal", "market", "sharp_reference", "slate", "matchup", "pitchers", "opponent_offense", "bullpen", "park", "weather", "workload", "model", "clv_history", "memory"], "Full research request.");

  /* Stem-matched, because "worst pitching matchups" is the same question as
     "worst pitchers" and the substring test missed it — pitchER vs pitchING —
     which sent it to the generic slate overview and retrieved no pitcher data
     at all. Anything asking about weak arms routes here. */
  const PITCH_STEM = /\b(pitch|pitcher|pitchers|pitching|starter|starters|starting|arm|arms|rotation|mound)\b/;
  /* Football and basketball vocabulary. Without these, "which offense is most
     efficient tonight" fell through to the generic slate overview and retrieved
     no team_features at all — the same gap that made "worst pitching matchups"
     return nothing before the pitcher stems were added. */
  const GRIDIRON_STEM = /\b(quarterback|qb|qbs|offense|offence|defense|defence|epa|efficiency|efficient|rushing|passing|run game|pass rush|trenches|line|red zone|third down|explosive)\b/;
  const HOOPS_STEM = /\b(tempo|pace|possessions|efficiency|efficient|adjusted|kenpom|torvik|four factors|rebounding|turnovers|three point|threes|shooting|effective field goal|efg)\b/;
  const TEAM_STEM = /\b(team|teams|matchup|matchups|offense|offence|defense|defence|efficiency|efficient)\b/;
  const WEAK_WORD = /\b(worst|weakest|bad|worse|poorest|shakiest|most vulnerable|vulnerable)\b/;
  const STRONG_WORD = /\b(best|strongest|top|elite|toughest)\b/;
  /* "worst pitching MATCHUPS" is a matchup question, not purely an arm-quality
     one, and the matchup intent retrieves weather and market on top of the
     pitching layer. Let it win when the user actually said matchup. */
  const MATCHUP_WORD = /\b(matchup|matchups|mismatch|spot|spots)\b/;

  if (WEAK_WORD.test(q) && PITCH_STEM.test(q) && !MATCHUP_WORD.test(q))
    return P("worst_pitchers", "SLATE", ["slate", "pitchers", "pitcher_features", "opponent_offense", "park", "weather", "workload", "bullpen", "market"], "Ranking starters requires the whole card plus who each one faces.");

  if (has("exploitable", "most attackable", "attack the pitcher"))
    return P("exploitable_pitchers", "SLATE", ["slate", "pitchers", "pitcher_features", "opponent_offense", "park", "weather", "workload", "bullpen", "market"], "Exploitability is pitcher quality read against the specific opponent, park and bullpen.");

  /* ── SPORT-SPECIFIC ROUTING ───────────────────────────────────────────
     Runs BEFORE the generic football/basketball branch, and only fires when
     the sport is EXPLICIT in the question. That ordering is deliberate: a
     question that merely says "which offense is most efficient tonight" has
     not told us which sport it means, and must keep falling through to the
     generic team_efficiency path exactly as it did before this build. Nothing
     below can change the routing of a question that does not name its sport. */
  {
    const det = detectSport(raw);
    const sport = det.confidence === "EXPLICIT" ? det.sport : null;
    const SP = (intent: string, depth: Depth, steps: string[], why: string): Plan =>
      ({ ...P(intent, depth, steps, why), sport });

    if (sport === "americanfootball_nfl") {
      const base = ["slate", "team_efficiency", "quarterback", "matchup_context", "nfl_deep", "market"];
      if (/\bquarterback|\bqb\b|\bqbs\b|passer|passing game\b/.test(q)) {
        return SP(WEAK_WORD.test(q) ? "nfl_worst_quarterbacks" : "nfl_best_quarterbacks", "SLATE",
          base, "NFL quarterback question — the QB is the single largest input, so the passing layer leads.");
      }
      if (/\bdefen[cs]e|defensive\b/.test(q)) {
        return SP(WEAK_WORD.test(q) ? "nfl_worst_defenses" : "nfl_best_defenses", "SLATE",
          base, "NFL defence ranking — EPA allowed per play and success rate allowed, read with the correct sign.");
      }
      if (/\boffen[cs]e|offensive|scoring\b/.test(q)) {
        return SP(WEAK_WORD.test(q) ? "nfl_worst_offenses" : "nfl_best_offenses", "SLATE",
          base, "NFL offence ranking — EPA per play and success rate, never points per game.");
      }
      if (/injur|\bout\b|questionable|doubtful|availab/.test(q)) {
        return SP("nfl_injury_impact", "DEEP", base.concat(["injuries"]),
          "NFL availability question — EdgeDesk carries a quarterback status only, and that limit has to be stated.");
      }
      if (has("compare", " vs ", " versus ")) {
        return SP("nfl_team_comparison", "DEEP", base, "NFL team comparison — both efficiency profiles side by side.");
      }
      if (has("what changed", "line move", "movement", "steam")) {
        return SP("nfl_what_changed", "STANDARD",
          ["focus_signal", "market", "line_movement", "closing_line", "quarterback"],
          "NFL movement question, with the quarterback status attached because it is what usually moved it.");
      }
      if (has("last time", "historically", "history", "track record")) {
        return SP("nfl_historical_matchup", "DEEP", ["clv_history", "historical_results", "memory", "team_efficiency"],
          "NFL historical question — answered from graded EdgeDesk outcomes with the sample size.");
      }
      if (MATCHUP_WORD.test(q)) {
        return SP(WEAK_WORD.test(q) ? "nfl_worst_matchups" : "nfl_best_matchups", "SLATE",
          base, "NFL matchup quality — strength against weakness, not strength against average.");
      }
      if (/\bbet|bets|play|plays|edge|value|candidate\b/.test(q)) {
        return SP("nfl_betting_candidate", "SLATE",
          base.concat(["sharp_reference", "clv_history", "memory"]),
          "NFL betting research — the deterministic engine still owns the verdict.");
      }
      return SP("nfl_best_matchups", "SLATE", base, "NFL question — retrieve the full owned NFL layer.");
    }

    if (sport === "americanfootball_ncaaf") {
      const base = ["slate", "cfb_intelligence", "matchup_context", "market"];
      if (/returning production|returning starters|experience returning/.test(q)) {
        return SP("cfb_returning_production", "DEEP", base.concat(["cfb_returning"]),
          "CFB returning production — the strongest year-over-year predictor in college football.");
      }
      if (/portal|transfer/.test(q)) {
        return SP("cfb_portal", "DEEP", base.concat(["cfb_portal"]), "CFB transfer portal question.");
      }
      if (/recruit/.test(q)) {
        return SP("cfb_recruiting", "STANDARD", base.concat(["cfb_recruiting"]),
          "CFB recruiting question — talent input, never a measure of current performance.");
      }
      if (/\bsp\+|sp plus|advanced rating|ratings?\b/.test(q)) {
        return SP("cfb_sp_plus", "STANDARD", base.concat(["cfb_sp_plus"]),
          "CFB SP+ question — an EXTERNAL model, reported as evidence and never as an EdgeDesk number.");
      }
      if (/roster|depth chart|who plays|starters?\b/.test(q)) {
        return SP("cfb_roster", "STANDARD", base.concat(["cfb_roster"]),
          "CFB roster question — roster presence is not a depth chart.");
      }
      if (/\bquarterback|\bqb\b/.test(q)) {
        return SP("cfb_best_quarterbacks", "DEEP", base.concat(["cfb_roster"]),
          "CFB quarterback question — EdgeDesk has roster and season aggregates, not per-play passing efficiency.");
      }
      if (/\bdefen[cs]e|defensive\b/.test(q)) {
        return SP("cfb_best_defenses", "SLATE", base.concat(["cfb_sp_plus"]),
          "CFB defence ranking — SP+ defence is the opponent-adjusted axis available.");
      }
      if (/\boffen[cs]e|offensive|scoring\b/.test(q)) {
        return SP(WEAK_WORD.test(q) ? "cfb_worst_offenses" : "cfb_best_offenses", "SLATE",
          base.concat(["cfb_sp_plus"]),
          "CFB offence ranking — SP+ offence plus season aggregates, with opponent quality attached.");
      }
      if (has("what changed", "line move", "movement")) {
        return SP("cfb_what_changed", "STANDARD", ["focus_signal", "market", "line_movement", "closing_line"],
          "CFB movement question.");
      }
      if (MATCHUP_WORD.test(q)) {
        return SP("cfb_best_matchups", "SLATE", base.concat(["cfb_sp_plus"]), "CFB matchup quality across the card.");
      }
      if (/\bbet|bets|play|plays|edge|value|candidate\b/.test(q)) {
        return SP("cfb_betting_candidate", "SLATE", base.concat(["sharp_reference", "clv_history", "memory"]),
          "CFB betting research.");
      }
      return SP("cfb_best_teams", "SLATE", base.concat(["cfb_sp_plus"]),
        "CFB question — retrieve the owned CollegeFootballData layer.");
    }

    if (sport === "basketball_ncaab") {
      const base = ["slate", "team_efficiency", "matchup_context", "cbb_deep", "market"];
      if (/pace|tempo|possession/.test(q)) {
        return SP("cbb_pace_matchup", "SLATE", base,
          "CBB pace question — expected possessions come from BOTH adjusted tempos together.");
      }
      if (/rebound|boards|glass/.test(q)) {
        return SP("cbb_rebounding_matchup", "SLATE", base, "CBB rebounding matchup.");
      }
      if (/shoot|three|3 point|efg|effective field goal/.test(q)) {
        return SP("cbb_shooting_matchup", "SLATE", base,
          "CBB shooting matchup — three-point RATE is a property, three-point PERCENTAGE allowed is mostly noise.");
      }
      if (/injur|availab|\bout\b|lineup/.test(q)) {
        return SP("cbb_availability", "DEEP", base.concat(["availability"]),
          "CBB availability question — EdgeDesk ingests none, and that gap is the answer.");
      }
      if (/tournament|march madness|bracket|seed/.test(q)) {
        return SP("cbb_tournament", "DEEP", base, "CBB tournament question — neutral site and rest matter more here.");
      }
      if (/\bplayers?\b|scorer|guard|forward|center/.test(q)) {
        return SP("cbb_best_players", "SLATE", base.concat(["player_production"]),
          "CBB player question — EdgeDesk has a leaderboard line only; minutes and usage are not ingested.");
      }
      if (/\bdefen[cs]e|defensive\b/.test(q)) {
        return SP("cbb_best_defenses", "SLATE", base,
          "CBB defence ranking — adj_d is points ALLOWED per 100 possessions, so lower is better.");
      }
      if (/\boffen[cs]e|offensive|scoring\b/.test(q)) {
        return SP(WEAK_WORD.test(q) ? "cbb_worst_offenses" : "cbb_best_offenses", "SLATE", base,
          "CBB offence ranking — adjusted efficiency, never points per game.");
      }
      if (has("last time", "historically", "history", "track record")) {
        return SP("cbb_historical", "DEEP", ["clv_history", "historical_results", "memory", "team_efficiency"],
          "CBB historical question.");
      }
      if (has("what changed", "line move", "movement")) {
        return SP("cbb_what_changed", "STANDARD", ["focus_signal", "market", "line_movement", "closing_line"],
          "CBB movement question.");
      }
      if (MATCHUP_WORD.test(q)) {
        return SP("cbb_best_matchups", "SLATE", base, "CBB matchup quality — the four factors say HOW.");
      }
      if (/\bbet|bets|play|plays|edge|value|candidate\b/.test(q)) {
        return SP("cbb_betting_candidate", "SLATE", base.concat(["sharp_reference", "clv_history", "memory"]),
          "CBB betting research.");
      }
      return SP("cbb_best_teams", "SLATE", base, "CBB question — adjusted efficiency leads.");
    }
  }

  /* Football / basketball efficiency questions, routed before the generic
     fallbacks so they retrieve the owned layer for their sport. */
  if ((GRIDIRON_STEM.test(q) || HOOPS_STEM.test(q))
    && (WEAK_WORD.test(q) || STRONG_WORD.test(q) || MATCHUP_WORD.test(q) || TEAM_STEM.test(q))) {
    return P("team_efficiency", "SLATE",
      ["slate", "team_efficiency", "quarterback", "matchup_context", "market"],
      "Ranking football or basketball teams needs the owned efficiency layer plus who each one faces.");
  }

  if (STRONG_WORD.test(q) && PITCH_STEM.test(q) && !MATCHUP_WORD.test(q))
    return P("best_pitchers", "SLATE", ["slate", "pitchers", "pitcher_features", "opponent_offense", "park"], "Ranking starters requires the whole card.");

  // Superlative + subject, matched loosely: "best pitching matchups today" and
  // "biggest mismatch between pitching and offense" are the same question.
  if (/\b(best|strongest|biggest|top|juiciest|worst|weakest|easiest|softest)\b[\s\S]{0,40}\b(matchup|matchups|mismatch|game|games|spot|spots)\b/.test(q))
    return P("best_matchups", "SLATE", ["slate", "pitchers", "pitcher_features", "opponent_offense", "team_efficiency", "quarterback", "matchup_context", "park", "weather", "market"], "Matchup quality across the card.");

  if (/\b(best|strongest|top|biggest|find me the best|three best|3 best)\b[\s\S]{0,30}\b(bet|bets|play|plays|edge|edges|value|moneyline|underdog|dog|price)\b/.test(q)
      || has("what should i bet", "what to bet", "find me something"))
    return P("best_bets", "SLATE", ["slate", "market", "sharp_reference", "matchup", "pitcher_features", "opponent_offense", "clv_history", "memory"], "Slate-wide: rank by owned research priority, then research and attack the top candidates.");

  if (has("compare", " vs ", " versus "))
    return P("compare", "DEEP", ["slate", "focus_signal", "market", "sharp_reference", "matchup", "pitchers", "pitcher_features", "opponent_offense", "bullpen", "park", "weather"], "Comparison — retrieve both sides and put the evidence side by side.");

  if (has("attack", "challenge", "talk me out", "convince me not", "convince me", "biggest risk",
          "what would make", "why not", "falsif", "reason not to", "every reason", "blind to", "what are we missing"))
    return P("attack", "DEEP", ["focus_signal", "market", "sharp_reference", "matchup", "bullpen", "weather", "clv_history", "memory"], "Thesis attack.");

  if (has("what changed", "changed since", "line move", "line moving", "movement", "steam"))
    return P("what_changed", "STANDARD", ["focus_signal", "market", "line_movement", "closing_line"], "Movement question.");

  if (has("what price", "at what price", "break even", "breakeven", "max playable", "still playable", "what do i need"))
    return P("price", "QUICK", ["focus_signal", "market"], "Price question.");

  if (has("research ", "dig into", "look into", "tell me about", "what do you know about", "what does edgedesk know"))
    return P("research_matchup", "DEEP", ["slate", "focus_signal", "market", "sharp_reference", "matchup", "pitchers", "pitcher_features", "opponent_offense", "bullpen", "park", "weather", "workload", "model", "memory"], "Open-ended research on a named entity.");

  if (has("last time", "historically", "history", "track record", "how have", "sample", "previously",
          "have we seen", "seen this", "seen a setup", "setup like", "similar to", "same setup", "before?"))
    return P("historical", "DEEP", ["clv_history", "historical_results", "memory", "focus_signal"], "Historical question — answer from graded EdgeDesk outcomes, with the sample size.");

  if (has("bullpen", "reliever", "closer", "taxed"))
    return P("bullpen", "STANDARD", ["slate", "bullpen", "workload"], "Bullpen question.");

  if (has("weather", "wind", "rain", "temperature"))
    return P("weather", "STANDARD", ["slate", "weather", "park"], "Weather question.");

  if (has("offense", "offence", "lineup", "hitters", "bats"))
    return P("offense", "SLATE", ["slate", "opponent_offense", "pitchers", "pitcher_features", "park"], "Offense question across the card.");

  if (has("trap", "dangerous", "avoid", "stay away", "risk today"))
    return P("traps", "SLATE", ["slate", "market", "sharp_reference", "clv_history"], "Risk scan — look for thin confirmation, decayed edges and stale prices.");

  if (has("market disagree", "disagree", "market missing", "market may be missing", "mispriced"))
    return P("market_disagreement", "SLATE", ["slate", "market", "sharp_reference", "model", "line_movement"], "Where the owned model and the market diverge.");

  if (has("research first", "deserve", "worth researching", "my attention", "priority"))
    return P("research_priority", "SLATE", ["slate", "market", "sharp_reference", "matchup"], "Research triage across the card.");

  if (has("which signal", "strongest confirmation", "weakest evidence", "most fragile", "fragile"))
    return P("signal_quality", "SLATE", ["slate", "market", "sharp_reference"], "Signal quality comparison.");

  if (has("why"))
    return P("why", "STANDARD", ["focus_signal", "market", "sharp_reference", "matchup", "model"], "Explain an owned signal from its evidence.");

  /* The catch-all. It used to retrieve only the board, so ANY question that
     merely mentioned "today" answered with zero pitcher coverage — which is
     exactly how "worst pitching matchups today?" reported 0/30. The fallthrough
     now pulls the matchup layer too; the retrieval budget still caps the cost. */
  if (has("slate", "today", "tonight", "board", "card"))
    return P("slate_overview", "SLATE", ["slate", "market", "matchup", "pitchers", "pitcher_features", "opponent_offense", "team_efficiency", "quarterback", "matchup_context", "park"], "Board-level overview.");

  return P("unknown", "STANDARD", ["slate", "focus_signal", "market", "matchup", "pitcher_features", "opponent_offense"], "Unclassified — retrieve the board, the matchup layer and any focused signal, then answer from what is there.");
}

/* --------------------------------------------------- data access layer */

export interface DalOpts {
  supabaseUrl: string;
  apikey: string;
  authorization: string;   // the CALLER's bearer. RLS applies exactly as it does in the browser.
  fetchImpl?: typeof fetch;
  budget?: number;
  /** Allow the official-MLB-feed fallback when the owned feature tables are empty. */
  mlbFallback?: boolean;
}

interface CacheEntry { at: number; rows: unknown[]; err: string | null }

/** Per-isolate cache. Only stable categories are cached; odds/lineups/weather are not. */
const CACHE = new Map<string, CacheEntry>();
const CACHEABLE: Record<string, number> = {
  schedule: 300_000, park: 3_600_000, player_stats: 900_000,
  team_stats: 900_000, historical: 600_000, memory: 300_000,
};

/** Drop the retrieval cache. Used by the test suite so one fixture cannot bleed
    into the next; harmless in production. */
export function clearCache(): void { CACHE.clear(); }

/** How many entries the per-isolate retrieval cache is holding. Diagnostics only. */
export function cacheSize(): number { return CACHE.size; }

/**
 * A short, stable, non-reversible tag for the caller, used to scope the cache.
 *
 * The JWT itself must never become a Map key: it is a credential, it is long,
 * and it would sit in isolate memory for the life of the process. FNV-1a over
 * the header gives a stable per-caller tag with none of that. Anonymous or
 * missing auth collapses to one shared bucket, which is correct — those reads
 * are unfiltered and identical for everyone.
 */
export function callerKey(authorization: unknown): string {
  const s = String(authorization ?? "");
  if (!s) return "anon";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export class Dal {
  private o: DalOpts;
  private f: typeof fetch;
  calls = 0;
  budget: number;
  mlbFallback: boolean;
  private callerKey: string;
  log: { table: string; ms: number; rows: number; error: string | null }[] = [];

  constructor(o: DalOpts) {
    this.o = o;
    this.f = o.fetchImpl ?? fetch;
    this.budget = o.budget ?? 18;
    this.mlbFallback = o.mlbFallback !== false;
    this.callerKey = callerKey(o.authorization);
  }

  /**
   * One REST read. Never throws. Returns rows plus the error text if it failed.
   *
   * `schema` selects a non-public PostgREST profile. EdgeDesk already ingests a
   * whole CollegeFootballData mirror into the `cfb` schema — teams, games, SP+
   * ratings, records, rankings, season stats, recruiting, roster and book lines
   * — and the research engine could not see ANY of it, because every read here
   * went to `public`. That is the single largest body of owned sport-specific
   * data in the project and it was invisible to the thing whose job is to
   * research it. Accept-Profile is how PostgREST exposes it.
   */
  async read(query: string, category = "schedule", schema?: string): Promise<{ rows: any[]; error: string | null; cached: boolean }> {
    const ttl = CACHEABLE[category];
    /* The cache key MUST carry the caller. Every read goes out under the
       caller's JWT so RLS applies exactly as in the browser — which means two
       users issuing the identical query legitimately get different rows. Keyed
       on the query alone, the first user's RLS-filtered result was served to
       the second for the whole TTL, up to an hour on park data. The isolate is
       shared and long-lived, so this was a cross-account read, not a
       theoretical one. */
    /* The schema is part of the cache key. `cfb.games` and `public.games` are
       different tables with the same name and overlapping columns; sharing a
       cache entry between them would serve a college schedule as an MLB one. */
    const key = `${this.callerKey}|${schema ?? "public"}|${query}`;
    const label = (schema ? schema + "." : "") + query.split("?")[0];
    if (ttl) {
      const hit = CACHE.get(key);
      if (hit && Date.now() - hit.at < ttl) return { rows: hit.rows as any[], error: hit.err, cached: true };
    }
    if (this.calls >= this.budget) {
      return { rows: [], error: "research budget exhausted before this read", cached: false };
    }
    this.calls++;
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = {
        apikey: this.o.apikey, authorization: this.o.authorization, accept: "application/json",
      };
      if (schema) headers["accept-profile"] = schema;
      const r = await this.f(`${this.o.supabaseUrl}/rest/v1/${query}`, { headers });
      const txt = await r.text();
      if (!r.ok) {
        const err = `HTTP ${r.status}${txt ? ": " + txt.slice(0, 180) : ""}`;
        this.log.push({ table: label, ms: Date.now() - t0, rows: 0, error: err });
        if (ttl) CACHE.set(key, { at: Date.now(), rows: [], err });
        this.note(label, false, err);
        return { rows: [], error: err, cached: false };
      }
      let rows: any[] = [];
      try { rows = JSON.parse(txt); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      this.log.push({ table: label, ms: Date.now() - t0, rows: rows.length, error: null });
      if (ttl) CACHE.set(key, { at: Date.now(), rows, err: null });
      this.note(label, true, null, rows.length);
      return { rows, error: null, cached: false };
    } catch (e) {
      const err = String((e as Error)?.message ?? e);
      this.log.push({ table: label, ms: Date.now() - t0, rows: 0, error: err });
      this.note(label, false, err);
      return { rows: [], error: err, cached: false };
    }
  }

  /* ---------------------------------------------- source reliability ------
     Every read is counted, here, in one place. This is infrastructure quality
     — how often a source answers, how often it answers with rows — and it is
     NEVER a betting number. It exists so the retrieval planner can prefer a
     source that works over one that does not, and so a persistently empty
     table becomes visible instead of being rediscovered every session. */
  sourceStats: Map<string, { source: string; attempts: number; ok: number; failed: number; empty: number; rows: number; last_error: string | null }> = new Map();

  private note(source: string, ok: boolean, error: string | null, rows = 0): void {
    const s = this.sourceStats.get(source)
      ?? { source, attempts: 0, ok: 0, failed: 0, empty: 0, rows: 0, last_error: null };
    s.attempts++;
    if (ok) { s.ok++; s.rows += rows; if (!rows) s.empty++; }
    else { s.failed++; s.last_error = error; }
    this.sourceStats.set(source, s);
  }

  /** The session's own reliability observations, ready to be reported or stored. */
  reliabilityReport(): {
    source: string; attempts: number; successful_retrievals: number; failed_retrievals: number;
    empty_retrievals: number; rows: number; completeness_rate: number; reliability_score: number;
    last_error: string | null;
  }[] {
    return [...this.sourceStats.values()].map((s) => ({
      source: s.source,
      attempts: s.attempts,
      successful_retrievals: s.ok,
      failed_retrievals: s.failed,
      empty_retrievals: s.empty,
      rows: s.rows,
      completeness_rate: s.attempts ? +((s.ok - s.empty) / s.attempts).toFixed(3) : 0,
      /* Answering with nothing is better than erroring but worse than
         answering. Deliberately crude: this is an operational preference
         ordering, not a statistic, and dressing it up would invite it being
         read as one. */
      reliability_score: s.attempts ? +(((s.ok - s.empty) + 0.5 * s.empty) / s.attempts).toFixed(3) : 0,
      last_error: s.last_error,
    })).sort((a, b) => b.attempts - a.attempts);
  }

  /**
   * The EXACT number of rows matching a filter, via PostgREST's count=exact.
   *
   * Supabase caps a response body at db-max-rows (1000). `.limit(2000)` does not
   * error — it returns 1000, and `rows.length` then reads 1000, so a statement
   * built on it describes the page rather than the table. That matters most in
   * exactly one place: the analyst is instructed to ALWAYS state the sample size
   * of a historical claim, so a capped page becomes a understated, confidently
   * quoted N. The count comes from the Content-Range header, which is not
   * subject to the row cap.
   */
  async count(query: string): Promise<number | null> {
    if (this.calls >= this.budget) return null;
    this.calls++;
    try {
      const r = await this.f(`${this.o.supabaseUrl}/rest/v1/${query}`, {
        method: "HEAD",
        headers: {
          apikey: this.o.apikey, authorization: this.o.authorization,
          prefer: "count=exact", range: "0-0",
        },
      });
      const cr = (r as any)?.headers?.get?.("content-range");
      // "0-0/2400", or "*/2400" when the range is empty
      const m = String(cr ?? "").match(/\/(\d+)\s*$/);
      return m ? parseInt(m[1], 10) : null;
    } catch { return null; }
  }

  /* ---------------- core, sport-agnostic: the market truth ---------------- */

  /** Every live signal in the window. This is the board, server-side. */
  async getSlate(sport?: string | null, hours = 30): Promise<{ rows: any[]; ev: Evidence[] }> {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + hours * 3600_000).toISOString();
    let q = "signals?select=event_id,sport_key,sport_title,market,selection,point,best_dec,first_best_dec,best_book,"
      + "sharp_fair,consensus_fair,edge,first_edge,n_books,n_books_eff,has_sharp,corrob_n,pin_dec,pin_opp_dec,"
      + "home_team,away_team,commence_time,first_seen_at,last_seen_at,clv,beat_close,result,graded_at,closing_sharp_fair"
      + `&commence_time=gte.${from}&commence_time=lte.${to}&order=edge.desc.nullslast&limit=120`;
    if (sport) q += `&sport_key=eq.${encodeURIComponent(sport)}`;
    let { rows, error } = await this.read(q, "");
    if (error) return { rows: [], ev: [unavailable("signals", "slate", `signals read failed — ${error}`)] };
    if (!rows.length) return { rows: [], ev: [unavailable("signals", "slate", "no signals in the current window")] };
    /* A FILTER THAT KEEPS WHAT IT REJECTED IS NOT A FILTER. `if (_clean.length)`
       meant that when EVERY row failed the tradeable bound — an exchange-lay
       feed, a placeholder-price run, a bad capture — all of them were passed
       through unchanged and priced as though they were real markets. And
       `_drop` collected the reason for each rejection and was then discarded,
       so nothing downstream could report that a single row had been dropped.
       Both halves are fixed here: the filter always applies, and what it
       removed becomes visible evidence rather than a silent deletion. */
    const _drop: string[] = [];
    const _clean = rows.filter((r: any) => { const t = signalTradeable(r); if (!t.ok) _drop.push(t.reason!); return t.ok; });
    const _dropped = rows.length - _clean.length;
    const _why = Array.from(new Set(_drop)).slice(0, 4).join("; ");
    rows = _clean;
    if (!rows.length) {
      return { rows: [], ev: [unavailable("signals", "slate",
        `all ${_dropped} signal rows in the window failed the tradeable bound (${_why}). `
        + `That is a capture problem, not an empty board — do not describe the slate as quiet.`)] };
    }
    const out = rows.map((r) => ev({
      source: "signals", entity: `${r.away_team} @ ${r.home_team}`, field: "signal",
      value: r, status: "VERIFIED", relevance: "market",
      source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
    }));
    if (_dropped) {
      out.push(ev({
        source: "signals", entity: null, field: "slate_filtered", relevance: "market",
        value: { dropped: _dropped, kept: rows.length, reasons: Array.from(new Set(_drop)).slice(0, 8) },
        status: "PARTIAL", freshness: "CURRENT",
        note: `${_dropped} row(s) were removed as untradeable before anything was ranked (${_why}). `
          + `The board you are reading is ${rows.length} rows, not ${rows.length + _dropped}.`,
      }));
    }
    return { rows, ev: out };
  }

  /** The sharp reference on a specific signal: Pinnacle print + book spread. */
  async getSharpReference(eventId: string, market?: string, selection?: string): Promise<Evidence[]> {
    let q = `signals?select=event_id,market,selection,has_sharp,pin_dec,pin_opp_dec,sharp_fair,consensus_fair,n_books,n_books_eff,corrob_n,last_seen_at&event_id=eq.${encodeURIComponent(eventId)}`;
    if (market) q += `&market=eq.${encodeURIComponent(market)}`;
    if (selection) q += `&selection=eq.${encodeURIComponent(selection)}`;
    q += "&order=last_seen_at.desc.nullslast&limit=4";
    const { rows, error } = await this.read(q, "");
    if (error || !rows.length) return [unavailable("signals", "sharp_reference", error ?? "no signal row for this selection", eventId)];
    return rows.map((r) => ev({
      source: "signals", entity: eventId, field: "sharp_reference", value: {
        has_sharp: r.has_sharp, pinnacle_dec: r.pin_dec, pinnacle_opp_dec: r.pin_opp_dec,
        sharp_fair: r.sharp_fair, consensus_fair: r.consensus_fair,
        n_books: r.n_books, n_books_eff: r.n_books_eff, corrob_n: r.corrob_n,
      },
      status: r.has_sharp ? "VERIFIED" : "PARTIAL",
      source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
      relevance: "sharp", note: r.has_sharp ? undefined : "Pinnacle does not print this exact side — the fair line rests on softer books.",
    }));
  }

  /** Per-book quotes behind a signal, when capture stored them. */
  async getMarket(sigKey: string): Promise<Evidence[]> {
    const { rows, error } = await this.read(
      `book_quotes?select=book_title,dec,fair,is_sharp&sig_key=eq.${encodeURIComponent(sigKey)}&limit=40`, "");
    if (error || !rows.length) return [unavailable("book_quotes", "book_spread", error ?? "no per-book quotes stored for this signal", sigKey)];
    return [ev({ source: "book_quotes", entity: sigKey, field: "book_spread", value: rows, status: "VERIFIED", freshness: "CURRENT", relevance: "liquidity" })];
  }

  /** Price history for a signal — the movement the user asks about. */
  async getLineMovement(sigKey: string): Promise<Evidence[]> {
    const { rows, error } = await this.read(
      `signal_ticks?select=edge,best_dec,created_at&sig_key=eq.${encodeURIComponent(sigKey)}&order=created_at.asc&limit=200`, "");
    if (error) return [unavailable("signal_ticks", "line_movement", `signal_ticks read failed — ${error}`, sigKey)];
    if (!rows.length) return [unavailable("signal_ticks", "line_movement", "tick capture is off or no ticks recorded for this signal", sigKey)];
    return [ev({
      source: "signal_ticks", entity: sigKey, field: "line_movement",
      value: { n: rows.length, first: rows[0], last: rows[rows.length - 1], series: rows.slice(-40) },
      status: "VERIFIED", source_timestamp: rows[rows.length - 1]?.created_at,
      freshness: freshnessOf("line_movement", rows[rows.length - 1]?.created_at), relevance: "movement",
    })];
  }

  /**
   * The market residual: how much the line moved BEYOND what closing the known
   * opening gap already accounts for.
   *
   * Raw line movement on a flagged signal is close to self-confirming — the
   * signal exists because a soft price is out of line, and out-of-line prices
   * get corrected. market_residual subtracts that expected correction, using a
   * kappa fitted on this database's own completed series, so what is left is
   * the part the mispricing does not explain.
   *
   * A null residual is a real answer and is surfaced as such. It means the
   * bucket had too few completed series to fit an expectation, or the series
   * was too thin to measure — never that the residual was zero.
   */
  async getMarketResidual(sigKey: string): Promise<Evidence[]> {
    const { rows, error } = await this.read(
      `market_residual?select=residual,residual_z,observed_move,expected_move,ticks,hours_observed,`
      + `path_volatility,max_drawdown,steam_steps,reversal_count,books_max,confidence,quality,computed_at`
      + `&sig_key=eq.${encodeURIComponent(sigKey)}&limit=1`, "");
    if (error) return [unavailable("market_residual", "market_residual", `read failed — ${error}`, sigKey)];
    if (!rows.length) {
      return [unavailable("market_residual", "market_residual",
        "no residual computed for this signal — the market_residual job has not run over it yet", sigKey)];
    }
    const r = rows[0];
    if (r.residual == null) {
      return [unavailable("market_residual", "market_residual",
        r.quality === "unfitted"
          ? "too few completed series in this sport and time window to fit an expected movement — the residual is unknown, not zero"
          : `series too thin to measure (${r.ticks} ticks over ${r.hours_observed}h) — the residual is unknown, not zero`,
        sigKey)];
    }
    return [ev({
      source: "market_residual", entity: sigKey, field: "market_residual",
      value: {
        residual: r.residual, residual_z: r.residual_z,
        observed_move: r.observed_move, expected_move: r.expected_move,
        ticks: r.ticks, hours_observed: r.hours_observed,
        path_volatility: r.path_volatility, max_drawdown: r.max_drawdown,
        steam_steps: r.steam_steps, reversal_count: r.reversal_count,
        books_max: r.books_max, confidence: r.confidence, quality: r.quality,
      },
      status: r.quality === "ok" ? "VERIFIED" : "PARTIAL",
      source_timestamp: r.computed_at, freshness: freshnessOf("line_movement", r.computed_at),
      relevance: "movement",
      note: "Movement in excess of what closing the opening gap predicts. Research only — it is not a probability, an edge or a verdict, and it does not change any price on the board.",
    })];
  }

  /** Closing line + CLV for a graded signal. Never inferred for an ungraded one. */
  async getClosingLine(eventId: string): Promise<Evidence[]> {
    const { rows, error } = await this.read(
      `signals?select=market,selection,closing_sharp_fair,clv,beat_close,result,graded_at&event_id=eq.${encodeURIComponent(eventId)}&graded_at=not.is.null&limit=10`, "");
    if (error) return [unavailable("signals", "closing_line", `read failed — ${error}`, eventId)];
    if (!rows.length) return [unavailable("signals", "closing_line", "not graded yet — a closing price exists only after settle captures it", eventId)];
    return rows.map((r) => ev({
      source: "signals", entity: eventId, field: "closing_line", value: r, status: "VERIFIED",
      source_timestamp: r.graded_at, freshness: freshnessOf("historical", r.graded_at), relevance: "clv",
    }));
  }

  /** Graded EdgeDesk history in a comparable band. Sample size is always reported. */
  async getCLVHistory(sportKey?: string | null, market?: string | null, edge?: number | null): Promise<Evidence[]> {
    let q = "signals?select=clv,beat_close,result,first_edge&graded_at=not.is.null&limit=2000";
    if (sportKey) q += `&sport_key=eq.${encodeURIComponent(sportKey)}`;
    if (market) q += `&market=eq.${encodeURIComponent(market)}`;
    if (edge != null && Number.isFinite(edge)) {
      q += `&first_edge=gte.${(edge - 0.015).toFixed(3)}&first_edge=lte.${(edge + 0.015).toFixed(3)}`;
    }
    const { rows, error } = await this.read(q, "historical");
    if (error) return [unavailable("signals", "clv_history", `read failed — ${error}`)];
    /* rows.length is a PAGE, capped at db-max-rows. The population size comes
       from a count, so the analyst quotes the real N and knows when the rates
       beneath it were measured on a sample of it. */
    const exact = await this.count(q.replace(/&limit=\d+/, "") + "&limit=1");
    const sample = rows.length;
    const n = exact ?? sample;
    if (n < 8) {
      return [ev({
        source: "signals", entity: sportKey ?? "all", field: "clv_history",
        value: { n, note: "sample too small to read" }, status: "HISTORICAL", freshness: "HISTORICAL",
        relevance: "history", note: `Only ${n} comparable graded signals — not enough to say anything.`,
      })];
    }
    const beat = rows.filter((r) => r.beat_close === true).length;
    const clvs = rows.map((r) => num(r.clv)).filter((v): v is number => v != null);
    const avg = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;
    const wins = rows.filter((r) => r.result === "win").length;
    const graded = rows.filter((r) => !!r.result).length;
    const sampled = exact != null && exact > sample;
    return [ev({
      source: "signals", entity: sportKey ?? "all", field: "clv_history",
      value: {
        /* n is the population. The rates below are measured on n_measured_on,
           which is the same number unless the page cap bit. Kept as separate
           fields so neither can be quoted as the other. */
        n, n_measured_on: sample, sampled,
        beat_close: beat, beat_close_rate: +(beat / Math.max(1, sample)).toFixed(3),
        avg_clv: avg == null ? null : +avg.toFixed(4),
        win_rate: graded ? +(wins / graded).toFixed(3) : null, graded,
      },
      status: "HISTORICAL", freshness: "HISTORICAL", relevance: "history",
      note: "Correlation over owned graded signals, not proof about any single game."
        + (sampled
          ? ` ${n} comparable signals exist; the rates above were measured on a ${sample}-row page of them `
            + `(the database caps a response at ${sample}). Quote ${n} as the population and say the rates come from a sample of it.`
          : ` Sample size ${n}.`),
    })];
  }

  /** Owned model output. Explicitly UNPROVEN — it is not CLV-validated. */
  async getModel(eventId: string): Promise<Evidence[]> {
    const { rows, error } = await this.read(
      `model_predictions?select=market,selection,point,model_prob,model_fair_american,model_edge,model_version&event_id=eq.${encodeURIComponent(eventId)}&order=created_at.desc&limit=6`, "");
    if (error || !rows.length) return [unavailable("model_predictions", "model", error ?? "no model row for this event", eventId)];
    return rows.map((r) => ev({
      source: "model_predictions", entity: eventId, field: "model", value: r,
      status: "UNPROVEN", freshness: "RECENT", relevance: "model",
      note: "Independent EdgeDesk model — display-only, not CLV-validated, and it feeds no edge math.",
    }));
  }

  /* --------------------------------- MLB module -------------------------- */

  /**
   * The MLB card with probable starters, park and weather.
   * Queries a 3-day ET window because ingest writes dates in its own timezone;
   * a single-day equality filter is exactly how a full slate goes missing.
   */
  async getMlbCard(): Promise<{ rows: any[]; ev: Evidence[]; path: Record<string, unknown> }> {
    const days = [etDay(-1), etDay(0), etDay(1)];
    let { rows, error } = await this.read(
      `mlb_game_cards?select=game_date,start_time,start_time_local,venue,status,doubleheader,game_number,`
      + `away_team_id,away_team_name,away_record,away_streak,away_pitcher_name,away_pitcher_throws,`
      + `home_team_id,home_team_name,home_record,home_streak,home_pitcher_name,home_pitcher_throws,`
      + `park_factor,hr_factor,run_factor,roof_type,is_dome,temp_f,humidity,precip_prob,wind_mph,wind_dir,wind_rel`
      + `&game_date=in.(${days.join(",")})&order=start_time.asc&limit=60`, "schedule");
    const path: Record<string, unknown> = { table: "mlb_game_cards", days_queried: days, rows: rows.length, error };
    if (error) return { rows: [], ev: [unavailable("mlb_game_cards", "mlb_card", `read failed — ${error}`)], path };
    if (!rows.length) return { rows: [], ev: [unavailable("mlb_game_cards", "mlb_card", `no rows for ${days.join(" / ")} — the MLB schedule sync has not written this slate`)], path };

    /* A COMPLETED GAME IS NOT ON TONIGHT'S CARD — and this is where that was
       being lost, not in getPitcherFeatures (which has dropped finals for a
       while). The three-day window is deliberate: an ET slate straddles a UTC
       date and a late game can be filed under tomorrow. But it also drags in
       YESTERDAY, ordered start_time ASCENDING, so yesterday's completed games
       come back FIRST — and the caller slices the emitted evidence to a budget.
       Fifteen finished games emit exactly 90 evidence items, the slate slice is
       90, so on a full card the model received yesterday's finished slate and
       NOTHING of tonight's. Measured, not theorised: 30/30 of the starters that
       reached the analyst were yesterday's and 0/30 were today's, and coverage
       then reported pitcher quality 0/30 against a denominator of pitchers who
       had already thrown.
       Finals are dropped HERE, at the source, so no downstream budget can spend
       itself on a card that is already over. A non-final game on the earlier
       date is KEPT — a suspended or postponed carryover really is on tonight's
       card. Live games are ordered first so any remaining budget pressure falls
       on tomorrow, never on tonight. */
    const isFinal = (r: any) => String(r?.status ?? "").toLowerCase() === "final";
    const today = etDay(0);
    const liveRows = rows.filter((r: any) => !isFinal(r));
    const dropped = rows.length - liveRows.length;
    liveRows.sort((a: any, b: any) => {
      // today first, then the rest chronologically
      const at = String(a.game_date ?? "") === today ? 0 : 1;
      const bt = String(b.game_date ?? "") === today ? 0 : 1;
      if (at !== bt) return at - bt;
      return String(a.start_time ?? "").localeCompare(String(b.start_time ?? ""));
    });
    path.live_scope = {
      returned: rows.length, live: liveRows.length, dropped_final: dropped,
      note: "Completed games are dropped at the source so the evidence budget is never spent on a finished card.",
    };
    /* The expected universe, computed from the SCHEDULE rather than from what
       came back. This is the denominator every later count uses. */
    path.slate_scope = buildSlateScope("baseball_mlb", rows, liveRows);
    if (!liveRows.length) {
      return { rows: [], path, ev: [unavailable("mlb_game_cards", "mlb_card",
        `all ${rows.length} carded games across ${days.join(" / ")} are Final — there is no live slate in this window`)] };
    }
    rows = liveRows;

    const out: Evidence[] = [];
    for (const g of rows) {
      const entity = `${g.away_team_name} @ ${g.home_team_name}`;
      out.push(ev({
        source: "mlb_game_cards", entity, field: "game", relevance: "schedule",
        value: { date: g.game_date, start: g.start_time, local: g.start_time_local, venue: g.venue, status: g.status },
        status: "VERIFIED", source_timestamp: g.start_time, freshness: freshnessOf("schedule", Date.now()),
      }));
      for (const side of ["away", "home"] as const) {
        const nm = side === "away" ? g.away_pitcher_name : g.home_pitcher_name;
        const th = side === "away" ? g.away_pitcher_throws : g.home_pitcher_throws;
        out.push(nm
          ? ev({
            source: "mlb_game_cards", entity: nm, field: "probable_starter",
            value: { name: nm, throws: th, team: side === "away" ? g.away_team_name : g.home_team_name,
              game: entity, side, game_date: g.game_date ?? null, status: g.status ?? null },
            status: "PROBABLE", freshness: "CURRENT", relevance: "pitching",
            note: "Probable, not confirmed. A scratch moves the number.",
          })
          : unavailable("mlb_game_cards", "probable_starter", `${side} starter not announced yet`, entity));
      }
      out.push(ev({
        source: "mlb_game_cards", entity, field: "park", relevance: "context",
        value: { venue: g.venue, park_factor: g.park_factor, hr_factor: g.hr_factor, run_factor: g.run_factor, roof: g.roof_type, dome: g.is_dome },
        status: "VERIFIED", freshness: "CURRENT",
      }));
      if (!g.is_dome) {
        out.push(ev({
          source: "mlb_game_cards", entity, field: "weather", relevance: "variance",
          value: { temp_f: g.temp_f, wind_mph: g.wind_mph, wind_dir: g.wind_dir, wind_rel: g.wind_rel, precip_prob: g.precip_prob },
          status: (g.temp_f == null && g.wind_mph == null) ? "UNAVAILABLE" : "VERIFIED",
          freshness: freshnessOf("weather", Date.now()),
        }));
      }
      out.push(ev({
        source: "mlb_game_cards", entity, field: "team_form", relevance: "form",
        value: { away: { record: g.away_record, streak: g.away_streak }, home: { record: g.home_record, streak: g.home_streak } },
        status: "VERIFIED", freshness: "RECENT",
      }));
    }
    return { rows, ev: out, path };
  }

  /**
   * Pitcher quality + the offense each starter faces.
   *
   * THIS IS THE FUNCTION THAT FIXES "pitcher quality data is not on file".
   * It does not assume the games -> pitcher_features join works. It tries the
   * join, and when the join yields nothing it probes each link separately so the
   * answer can name WHICH link is broken (A: no data / B: join / C: date /
   * E: RLS) instead of blaming the data.
   */
  /**
   * Football and basketball: team efficiency, the quarterback, and the
   * situational layer, joined through games the same way the MLB card is.
   *
   * The shape deliberately mirrors getPitcherFeatures because the failure modes
   * are the same. Every link is probed and diagnosed, each row carries the
   * identity the integrity audit needs (team, opponent, matchup, date), and a
   * column that is null is reported as absent rather than skipped — a CFB row
   * with no EPA is a known gap, not a mystery.
   */
  async getTeamFeatures(sportKey: string): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const days = [etDay(0), etDay(1)];
    const path: Record<string, unknown> = { sport: sportKey, days_queried: days };
    const out: Evidence[] = [];

    const g = await this.read(
      `games?select=game_id,game_date,home_team,away_team,start_time,status`
      + `&sport_key=eq.${encodeURIComponent(sportKey)}&game_date=in.(${days.join(",")})`
      + `&order=start_time.asc&limit=120`, "schedule");
    path.games = { rows: g.rows.length, error: g.error };

    const ids = g.rows.map((r) => r.game_id).filter((v) => v != null).map(String);
    if (!ids.length) {
      const probe = await this.read(
        `games?select=game_id,game_date&sport_key=eq.${encodeURIComponent(sportKey)}`
        + `&order=game_date.desc&limit=5`, "schedule");
      path.games_probe = {
        rows: probe.rows.length, latest_dates: probe.rows.map((r) => r.game_date),
        diagnosis: probe.error
          ? "E — games is not readable by this caller (RLS or grant)."
          : probe.rows.length
            ? `C — games holds rows for this sport but none on ${days.join("/")}; latest is ${probe.rows[0]?.game_date}. The multisport ingest is stale or off-schedule.`
            : "A — games holds no row for this sport at all. ingest_multisport has never written it.",
      };
      return { ev: [unavailable("games", "team_efficiency", `no ${sportKey} games on this slate`)], path };
    }

    const inList = ids.map(encodeURIComponent).join(",");
    const tf = await this.read(
      `team_features?select=game_id,side,team,wins,losses,win_pct,`
      + `off_epa_play,def_epa_play,off_success_rate,def_success_rate,pass_epa_play,rush_epa_play,`
      + `def_pass_epa_play,def_rush_epa_play,explosive_play_rate,yards_per_play,opp_yards_per_play,`
      + `third_down_pct,def_third_down_pct,red_zone_td_pct,def_red_zone_td_pct,turnover_margin_pg,`
      + `sack_rate,sack_rate_allowed,plays_per_game,`
      + `adj_o,adj_d,adj_em,adj_tempo,efg_pct,to_pct,orb_pct,ft_rate,`
      + `def_efg_pct,def_to_pct,def_orb_pct,def_ft_rate,three_rate,three_pct,def_three_rate,def_three_pct,`
      + `avg_height,experience,bench_minutes,wab,source,updated_at`
      + `&game_id=in.(${inList})&limit=240`, "team_stats");
    path.team_features = { rows: tf.rows.length, error: tf.error };

    const qb = await this.read(
      `qb_features?select=game_id,side,name,epa_per_dropback,cpoe,ypa,comp_pct,td_rate,int_rate,`
      + `sack_rate_taken,pressure_rate,rush_epa,qbr,attempts,games_started,status,is_backup,injury_note,`
      + `source,updated_at&game_id=in.(${inList})&limit=240`, "player_stats");
    path.qb_features = { rows: qb.rows.length, error: qb.error };

    const mc = await this.read(
      `matchup_context?select=game_id,neutral_site,conference_game,is_rivalry,home_rest_days,away_rest_days,`
      + `short_week,off_bye_home,off_bye_away,home_rank,away_rank,venue,indoor,surface,altitude_ft,tv,notes,`
      + `updated_at&game_id=in.(${inList})&limit=120`, "schedule");
    path.matchup_context = { rows: mc.rows.length, error: mc.error };

    if (!tf.rows.length) {
      const probe = await this.read("team_features?select=game_id,sport_key,team&limit=5", "team_stats");
      path.team_features_probe = {
        rows: probe.rows.length, sample_game_ids: probe.rows.map((r) => r.game_id),
        diagnosis: probe.error
          ? "E — team_features is not readable by this caller (RLS or grant)."
          : !probe.rows.length
            ? "A — team_features is empty. ingest_multisport has never populated it."
            : "B — team_features holds rows but none matched this slate's game_ids. Compare sample_game_ids against the ids in games.",
      };
    }

    const gameById: Record<string, any> = {};
    for (const r of g.rows) gameById[String(r.game_id)] = r;
    const tfBy: Record<string, any> = {};
    for (const r of tf.rows) tfBy[`${r.game_id}|${r.side}`] = r;
    const qbBy: Record<string, any> = {};
    for (const r of qb.rows) qbBy[`${r.game_id}|${r.side}`] = r;
    const mcBy: Record<string, any> = {};
    for (const r of mc.rows) mcBy[String(r.game_id)] = r;

    const flip = (x: string) => x === "home" ? "away" : "home";
    const teamOn = (gm: any, side: string) => side === "home" ? gm?.home_team : gm?.away_team;
    const isHoops = sportKey === "basketball_ncaab" || sportKey === "basketball_nba";

    for (const gm of g.rows) {
      const gid = String(gm.game_id);
      const played = String(gm.status ?? "").toLowerCase() === "final";
      const matchup = `${gm.away_team} @ ${gm.home_team}`;
      const ctx = mcBy[gid] ?? null;

      for (const side of ["home", "away"] as const) {
        const t = tfBy[`${gid}|${side}`];
        const opp = tfBy[`${gid}|${flip(side)}`];
        const team = teamOn(gm, side);
        if (!t) {
          out.push(unavailable("team_features", "team_efficiency",
            `no efficiency row for ${team ?? side} in this game`, team ?? gid));
          continue;
        }

        /* Which numbers are genuinely absent, named rather than left blank.
           CFB has no free EPA feed, so this list is how the answer knows to
           say "not ingested for this sport" instead of reasoning from a hole. */
        const wantCols = isHoops
          ? ["adj_o", "adj_d", "adj_tempo", "efg_pct", "to_pct", "orb_pct", "ft_rate"]
          : ["off_epa_play", "def_epa_play", "off_success_rate", "def_success_rate", "plays_per_game"];
        const missing = wantCols.filter((k) => t[k] == null);

        out.push(ev({
          source: "team_features", entity: team ?? `${gid}:${side}`, field: "team_efficiency",
          relevance: isHoops ? "efficiency" : "offense",
          value: {
            team, side, opponent: teamOn(gm, flip(side)), game: matchup, game_date: gm.game_date,
            game_id: gid, already_played: played,
            record: (t.wins != null && t.losses != null) ? `${t.wins}-${t.losses}` : null,
            ...(isHoops
              ? {
                adj_o: t.adj_o, adj_d: t.adj_d, adj_em: t.adj_em, adj_tempo: t.adj_tempo,
                four_factors: { efg: t.efg_pct, tov: t.to_pct, orb: t.orb_pct, ftr: t.ft_rate },
                four_factors_defence: { efg: t.def_efg_pct, tov: t.def_to_pct, orb_allowed: t.def_orb_pct, ftr: t.def_ft_rate },
                three_rate: t.three_rate, three_pct: t.three_pct,
                opp_three_rate: t.def_three_rate, opp_three_pct: t.def_three_pct,
                height: t.avg_height, experience: t.experience, bench_minutes: t.bench_minutes, wab: t.wab,
                opponent_adj_o: opp?.adj_o ?? null, opponent_adj_d: opp?.adj_d ?? null,
                opponent_adj_tempo: opp?.adj_tempo ?? null,
                tempo_note: (t.adj_tempo != null && opp?.adj_tempo != null)
                  ? "Both tempos are attached. The expected possession count is the pace input for the total; two efficient slow teams can be excellent and still play under."
                  : null,
                adj_d_note: "adj_d is points ALLOWED per 100 possessions — lower is better, unlike every other efficiency field here.",
              }
              : {
                off_epa_play: t.off_epa_play, def_epa_play: t.def_epa_play,
                off_success_rate: t.off_success_rate, def_success_rate: t.def_success_rate,
                pass_epa_play: t.pass_epa_play, rush_epa_play: t.rush_epa_play,
                def_pass_epa_play: t.def_pass_epa_play, def_rush_epa_play: t.def_rush_epa_play,
                explosive_play_rate: t.explosive_play_rate,
                yards_per_play: t.yards_per_play, opp_yards_per_play: t.opp_yards_per_play,
                third_down_pct: t.third_down_pct, def_third_down_pct: t.def_third_down_pct,
                red_zone_td_pct: t.red_zone_td_pct, def_red_zone_td_pct: t.def_red_zone_td_pct,
                turnover_margin_pg: t.turnover_margin_pg,
                sack_rate: t.sack_rate, sack_rate_allowed: t.sack_rate_allowed,
                plays_per_game: t.plays_per_game,
                opponent_def_epa_play: opp?.def_epa_play ?? null,
                opponent_off_epa_play: opp?.off_epa_play ?? null,
                opponent_def_pass_epa_play: opp?.def_pass_epa_play ?? null,
                opponent_def_rush_epa_play: opp?.def_rush_epa_play ?? null,
                def_epa_note: "def_epa_play is EPA ALLOWED per play — NEGATIVE is a good defence. The sign is opposite to the offensive column.",
              }),
            missing_fields: missing,
            missing_note: missing.length && sportKey === "americanfootball_ncaaf"
              ? "College football has no free play-by-play EPA feed without a CollegeFootballData key, so these are NOT ingested for this sport. Say that; do not substitute points per game."
              : missing.length ? "These columns were not populated for this row." : null,
          },
          status: missing.length === wantCols.length ? "PARTIAL" : played ? "HISTORICAL" : "VERIFIED",
          source_timestamp: t.updated_at ?? null,
          freshness: t.updated_at ? freshnessOf("team_stats", t.updated_at) : "UNKNOWN",
        }));

        const q = qbBy[`${gid}|${side}`];
        if (q) {
          out.push(ev({
            source: "qb_features", entity: q.name ?? team ?? `${gid}:${side}`, field: "quarterback",
            relevance: "pitching",
            value: {
              name: q.name, team, side, game: matchup, game_date: gm.game_date,
              epa_per_dropback: q.epa_per_dropback, cpoe: q.cpoe, ypa: q.ypa, comp_pct: q.comp_pct,
              td_rate: q.td_rate, int_rate: q.int_rate, sack_rate_taken: q.sack_rate_taken,
              pressure_rate: q.pressure_rate, rush_epa: q.rush_epa, qbr: q.qbr,
              attempts: q.attempts, games_started: q.games_started,
              status: q.status, is_backup: q.is_backup, injury_note: q.injury_note,
              opponent_pass_defence_epa: opp?.def_pass_epa_play ?? null,
              opponent_sack_rate: opp?.sack_rate ?? null,
            },
            /* An unconfirmed or backup starter is never VERIFIED. It is the
               single largest predictable line move in football, so a
               conclusion resting on it has to be marked provisional. */
            status: q.is_backup === true || (q.status && String(q.status).toLowerCase() !== "active")
              ? "PROBABLE" : "VERIFIED",
            source_timestamp: q.updated_at ?? null,
            freshness: q.updated_at ? freshnessOf("player_stats", q.updated_at) : "UNKNOWN",
            note: q.is_backup === true
              ? "This is NOT the season-long starter. Treat every conclusion built on the quarterback as provisional."
              : undefined,
          }));
        } else if (sportKey.startsWith("americanfootball")) {
          out.push(unavailable("qb_features", "quarterback",
            `no starting quarterback on file for ${team ?? side}`, team ?? gid));
        }
      }

      if (ctx) {
        out.push(ev({
          source: "matchup_context", entity: matchup, field: "matchup_context", relevance: "situation",
          value: {
            game: matchup, game_date: gm.game_date, game_id: gid,
            neutral_site: ctx.neutral_site, conference_game: ctx.conference_game, is_rivalry: ctx.is_rivalry,
            home_rest_days: ctx.home_rest_days, away_rest_days: ctx.away_rest_days,
            short_week: ctx.short_week, off_bye_home: ctx.off_bye_home, off_bye_away: ctx.off_bye_away,
            home_rank: ctx.home_rank, away_rank: ctx.away_rank,
            venue: ctx.venue, indoor: ctx.indoor, surface: ctx.surface, altitude_ft: ctx.altitude_ft,
            tv: ctx.tv, weather: (ctx.notes as any)?.weather ?? null,
          },
          status: "VERIFIED", source_timestamp: ctx.updated_at ?? null,
          freshness: ctx.updated_at ? freshnessOf("schedule", ctx.updated_at) : "UNKNOWN",
        }));
      } else {
        out.push(unavailable("matchup_context", "matchup_context",
          "no situational context row for this game", matchup));
      }
    }

    path.emitted = out.length;
    return { ev: out, path };
  }

  /* ==================================================================== */
  /* COLLEGE FOOTBALL — the ingested `cfb` schema                          */
  /* ==================================================================== */

  /**
   * The CFB intelligence layer, read from EdgeDesk's OWN CollegeFootballData
   * mirror rather than from the API.
   *
   * This is the largest single correction in this build. The engine previously
   * told every CFB questioner that college efficiency "is not ingested — there
   * is no free feed without a CollegeFootballData key", while the project has
   * been ingesting a full CFBD mirror into the `cfb` schema the entire time:
   * teams with conferences, the whole schedule with pregame ELO, SP+ ratings
   * split into offence, defence and special teams, records, poll rankings,
   * season stat lines, recruiting classes, rosters and consensus book lines.
   * The research engine simply never looked, because every read it makes goes
   * to `public` and none of that is in `public`.
   *
   * The old sentence was still HALF true and stays true: per-PLAY efficiency
   * (EPA, success rate) genuinely is not ingested, because per-game CFBD calls
   * exceed the free tier. That gap is declared per capability rather than used
   * to write off the sport.
   *
   * Retrieval is NEEDS-DRIVEN. A question about recruiting does not read the
   * roster, and a question about this week's card does not pull four seasons
   * of results. The plan decides; this executes.
   */
  async getCfbIntelligence(opts: {
    needs: Set<string>; teams?: string[]; season?: number | null;
  }): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const out: Evidence[] = [];
    const path: Record<string, unknown> = { schema: "cfb", provider: "CollegeFootballData", needs: [...opts.needs] };
    const SPORT = "americanfootball_ncaaf";
    const wants = (k: string) => opts.needs.has(k);
    const teamFilter = (opts.teams ?? []).map((t) => normName(t)).filter(Boolean);
    const matchesTeam = (name: unknown) => {
      if (!teamFilter.length) return true;
      const n = normName(name);
      return teamFilter.some((t) => n === t || n.includes(t) || t.includes(n));
    };

    /* ---- L0 IDENTITY. Always first, and never skipped: every other row in
       this schema is keyed on a school NAME, and a name is not an identity
       until it has been bound to a canonical, sport-scoped id. */
    const teams = await this.read(
      "teams?select=team_id,school,mascot,abbreviation,conference,classification&order=school&limit=1000",
      "team_stats", "cfb");
    path.teams = { rows: teams.rows.length, error: teams.error };
    if (teams.error) {
      out.push(unavailable("cfb.teams", "cfb_identity",
        `the cfb schema is not readable by this caller — ${teams.error}. `
        + `Expose the cfb schema under Supabase > API settings, or check its RLS grant. `
        + `Every other CFB retrieval depends on this one.`));
      path.diagnosis = "E — cfb schema not readable (not exposed, or RLS/grant). No CFB layer can be built.";
      return { ev: out, path };
    }
    if (!teams.rows.length) {
      out.push(unavailable("cfb.teams", "cfb_identity",
        "the cfb schema is readable but cfb.teams is empty — cfb_ingest has never run"));
      path.diagnosis = "A — cfb schema reachable and empty. Run cfb_ingest.";
      return { ev: out, path };
    }

    const canonOf = new Map<string, string>();   // normalised school -> canonical id
    const confOf = new Map<string, string | null>();
    let unresolvedIds = 0;
    for (const t of teams.rows) {
      if (!t.school) continue;
      const pi = registerProviderIdentity({
        provider: "cfbd", provider_id: t.team_id ?? t.school, provider_name: String(t.school),
        sport: SPORT, league: t.classification ? String(t.classification).toUpperCase() : "FBS",
        conference: t.conference ?? null,
      });
      if (pi.canonical_id) {
        canonOf.set(normName(t.school), pi.canonical_id);
        confOf.set(normName(t.school), t.conference ?? null);
      } else {
        unresolvedIds++;
        out.push(identityUnresolved("cfbd", String(t.school), SPORT,
          "the provider row could not be bound to a canonical program"));
      }
    }
    path.identity = {
      registered: canonOf.size, unresolved: unresolvedIds,
      note: "cfb.teams is the authoritative provider registry for CFB identity. Every school below is bound to a "
        + "canonical, sport-scoped id before any statistic is attached to it.",
    };

    const season = opts.season ?? seasonFor(SPORT);
    const idFor = (school: unknown) => canonOf.get(normName(school)) ?? null;
    const cfbEv = (
      e: Partial<Evidence> & { field: string; source: string },
    ) => ev({
      ...e, sport: SPORT, league: "FBS", season,
      canonical_team_id: e.canonical_team_id ?? (e.entity ? idFor(e.entity) : null),
    });

    /* ---- L8 EXTERNAL MODEL — SP+.
       Labelled EXTERNAL_MODEL at every level the system can express it: the
       source_type, the analytical layer and the note. SP+ is a genuinely good
       opponent-adjusted rating and it is STILL not an EdgeDesk number. It may
       inform a research read; it may never become a probability, a fair price
       or an edge, and it must never be described as EdgeDesk's view. */
    if (wants("sp_plus") || wants("team_quality")) {
      const rt = await this.read(
        "ratings?select=season,team,conference,rating,ranking,offense_rating,offense_ranking,"
        + "defense_rating,defense_ranking,special_teams_rating,sos&order=season.desc.nullslast&limit=1000",
        "team_stats", "cfb");
      path.ratings = { rows: rt.rows.length, error: rt.error };
      if (rt.error) {
        out.push(unavailable("cfb.ratings", "cfb_sp_plus", `read failed — ${rt.error}`));
      } else if (!rt.rows.length) {
        out.push(unavailable("cfb.ratings", "cfb_sp_plus", "no SP+ rows on file — cfb_ingest has not written ratings"));
      } else {
        const latest = rt.rows.reduce((a: number, r: any) => Math.max(a, num(r.season) ?? 0), 0);
        const cur = rt.rows.filter((r: any) => num(r.season) === latest && matchesTeam(r.team));
        path.ratings_season = { latest, rows_in_season: cur.length };
        for (const r of cur.slice(0, 140)) {
          out.push(cfbEv({
            source: "cfb.ratings", entity: r.team, field: "cfb_sp_plus",
            source_type: "EXTERNAL_MODEL", layer: "external_model", data_layer: "L8_EXTERNAL_MODEL",
            relevance: "team_quality", season: latest,
            value: {
              team: r.team, conference: r.conference ?? confOf.get(normName(r.team)) ?? null,
              sp_overall: r.rating, sp_overall_rank: r.ranking,
              sp_offense: r.offense_rating, sp_offense_rank: r.offense_ranking,
              sp_defense: r.defense_rating, sp_defense_rank: r.defense_ranking,
              sp_special_teams: r.special_teams_rating,
              strength_of_schedule: r.sos, season: latest,
            },
            status: "UNPROVEN", freshness: freshnessOf("team_stats", Date.now()),
            provenance: `CollegeFootballData SP+ via cfb.ratings, season ${latest}`,
            note: "EXTERNAL MODEL — CollegeFootballData's SP+, not EdgeDesk's. SP+ defence is measured in points "
              + "allowed per drive-adjusted possession, so a LOWER defensive rating is better. This is research "
              + "context and evidence about team quality. It is NOT an EdgeDesk probability, fair price or edge, "
              + "and it must never be converted into one or presented as EdgeDesk's own view.",
          }));
        }
      }
    }

    /* ---- L3 TEAM SEASON — records. */
    if (wants("records") || wants("team_quality")) {
      const rec = await this.read(
        "records?select=season,team,total_wins,total_losses,total_ties,conf_wins,conf_losses"
        + "&order=season.desc.nullslast&limit=1000", "team_stats", "cfb");
      path.records = { rows: rec.rows.length, error: rec.error };
      if (rec.error) out.push(unavailable("cfb.records", "cfb_record", `read failed — ${rec.error}`));
      else {
        const latest = rec.rows.reduce((a: number, r: any) => Math.max(a, num(r.season) ?? 0), 0);
        for (const r of rec.rows.filter((r: any) => num(r.season) === latest && matchesTeam(r.team)).slice(0, 140)) {
          out.push(cfbEv({
            source: "cfb.records", entity: r.team, field: "cfb_record",
            source_type: "OWNED_TABLE", layer: "season", data_layer: "L3_TEAM_SEASON",
            relevance: "form", season: latest,
            value: {
              team: r.team, season: latest,
              record: `${r.total_wins ?? 0}-${r.total_losses ?? 0}${r.total_ties ? "-" + r.total_ties : ""}`,
              wins: r.total_wins, losses: r.total_losses, ties: r.total_ties,
              conference_record: (r.conf_wins != null && r.conf_losses != null) ? `${r.conf_wins}-${r.conf_losses}` : null,
              conference: confOf.get(normName(r.team)) ?? null,
            },
            status: "VERIFIED", freshness: freshnessOf("team_stats", Date.now()),
            provenance: `cfb.records season ${latest}`,
            note: "A record is an outcome, not an efficiency measure. It carries no opponent adjustment.",
          }));
        }
      }
    }

    /* ---- L3 TEAM SEASON — the season stat lines.
       Long format (stat_name/stat_value), pivoted here. The stat VOCABULARY is
       discovered from the rows rather than assumed: this is a provider mirror
       and guessing at CFBD's stat names would be exactly the kind of confident
       invention that produces a null-shaped answer nobody can debug. Whatever
       names come back are reported in data_path so the gap is inspectable. */
    if (wants("team_season_stats") || wants("offense") || wants("defense")) {
      let q = "team_season_stats?select=season,team,stat_name,stat_value&order=team&limit=1000";
      if (teamFilter.length && teamFilter.length <= 6) {
        const names = (opts.teams ?? []).slice(0, 6).map((t) => `"${String(t).replace(/"/g, '""')}"`).join(",");
        q = `team_season_stats?select=season,team,stat_name,stat_value&team=in.(${encodeURIComponent(names).replace(/%2C/g, ",")})&limit=600`;
      }
      const ts = await this.read(q, "team_stats", "cfb");
      path.team_season_stats = { rows: ts.rows.length, error: ts.error, filtered_to_teams: teamFilter.length || null };
      if (ts.error) {
        out.push(unavailable("cfb.team_season_stats", "cfb_team_season_stat", `read failed — ${ts.error}`));
      } else if (!ts.rows.length) {
        out.push(unavailable("cfb.team_season_stats", "cfb_team_season_stat",
          "no season stat rows returned for the teams in scope"));
      } else {
        const latest = ts.rows.reduce((a: number, r: any) => Math.max(a, num(r.season) ?? 0), 0);
        const byTeam = new Map<string, Record<string, unknown>>();
        const vocab = new Set<string>();
        for (const r of ts.rows) {
          if (num(r.season) !== latest || !r.team || !r.stat_name) continue;
          vocab.add(String(r.stat_name));
          const t = byTeam.get(String(r.team)) ?? {};
          t[String(r.stat_name)] = num(r.stat_value) ?? r.stat_value;
          byTeam.set(String(r.team), t);
        }
        path.stat_vocabulary = {
          season: latest, teams: byTeam.size, stat_names: [...vocab].sort(),
          note: "Discovered from the rows, not assumed. If a statistic the question needs is absent from this list, "
            + "it is not ingested — say so rather than substituting a different one.",
        };
        for (const [team, stats] of [...byTeam].filter(([t]) => matchesTeam(t)).slice(0, 140)) {
          out.push(cfbEv({
            source: "cfb.team_season_stats", entity: team, field: "cfb_team_season_stat",
            source_type: "OWNED_TABLE", layer: "season", data_layer: "L3_TEAM_SEASON",
            relevance: "offense", season: latest,
            value: { team, season: latest, conference: confOf.get(normName(team)) ?? null, stats },
            status: "VERIFIED", freshness: freshnessOf("team_stats", Date.now()),
            provenance: `cfb.team_season_stats season ${latest}, pivoted from long format`,
            note: "SEASON AGGREGATES, not per-play efficiency. These are totals and counts across the season and "
              + "carry no opponent adjustment and no pace adjustment. EPA per play and success rate are NOT "
              + "ingested for college football. Use SP+ for the opponent-adjusted read and say which you used.",
          }));
        }
      }
    }

    /* ---- L1/L2 SCHEDULE + RESULTS, with pregame ELO as a second external model. */
    if (wants("schedule") || wants("matchup") || wants("results")) {
      const gm = await this.read(
        "games?select=game_id,season,week,season_type,start_date,completed,neutral_site,conference_game,"
        + "venue,home_id,home_team,home_conference,home_points,home_pregame_elo,"
        + "away_id,away_team,away_conference,away_points,away_pregame_elo,excitement"
        + "&order=start_date.desc.nullslast&limit=800", "schedule", "cfb");
      path.games = { rows: gm.rows.length, error: gm.error };
      if (gm.error) {
        out.push(unavailable("cfb.games", "cfb_game", `read failed — ${gm.error}`));
      } else {
        const now = Date.now();
        const upcoming = gm.rows.filter((g: any) =>
          !g.completed && g.start_date && Date.parse(g.start_date) >= now - 3 * 3600_000);
        const recent = gm.rows.filter((g: any) => g.completed);
        const scope = (teamFilter.length
          ? gm.rows.filter((g: any) => matchesTeam(g.home_team) || matchesTeam(g.away_team))
          : upcoming.length ? upcoming : recent).slice(0, 60);
        path.games_scope = {
          total: gm.rows.length, upcoming: upcoming.length, completed: recent.length,
          emitted: scope.length,
        };
        for (const g of scope) {
          const matchup = `${g.away_team} @ ${g.home_team}`;
          out.push(cfbEv({
            source: "cfb.games", entity: matchup, field: "cfb_game",
            source_type: "OWNED_TABLE", layer: g.completed ? "historical" : "context",
            data_layer: g.completed ? "L2_RESULTS" : "L1_SCHEDULE",
            relevance: "schedule", season: g.season, event_id: g.game_id != null ? String(g.game_id) : null,
            date: g.start_date ? String(g.start_date).slice(0, 10) : null,
            value: {
              game: matchup, game_id: g.game_id, season: g.season, week: g.week,
              season_type: g.season_type, start_date: g.start_date,
              completed: g.completed === true, neutral_site: g.neutral_site,
              conference_game: g.conference_game, venue: g.venue,
              home_team: g.home_team, home_conference: g.home_conference,
              away_team: g.away_team, away_conference: g.away_conference,
              home_canonical_id: idFor(g.home_team), away_canonical_id: idFor(g.away_team),
              ...(g.completed ? { home_points: g.home_points, away_points: g.away_points } : {}),
            },
            status: g.completed ? "HISTORICAL" : "VERIFIED",
            source_timestamp: g.start_date ?? null,
            freshness: freshnessOf("schedule", Date.now()),
            provenance: `cfb.games ${g.season} week ${g.week}`,
          }));
          if (g.home_pregame_elo != null || g.away_pregame_elo != null) {
            out.push(cfbEv({
              source: "cfb.games", entity: matchup, field: "cfb_elo",
              source_type: "EXTERNAL_MODEL", layer: "external_model", data_layer: "L8_EXTERNAL_MODEL",
              relevance: "team_quality", season: g.season,
              event_id: g.game_id != null ? String(g.game_id) : null,
              value: {
                game: matchup, home_team: g.home_team, home_pregame_elo: g.home_pregame_elo,
                away_team: g.away_team, away_pregame_elo: g.away_pregame_elo,
                elo_gap: (num(g.home_pregame_elo) != null && num(g.away_pregame_elo) != null)
                  ? +(num(g.home_pregame_elo)! - num(g.away_pregame_elo)!).toFixed(1) : null,
              },
              status: "UNPROVEN", freshness: freshnessOf("team_stats", Date.now()),
              provenance: "cfb.games pregame ELO (CollegeFootballData)",
              note: "EXTERNAL MODEL — a third-party ELO carried on the schedule row. It is evidence about relative "
                + "team strength. It is not an EdgeDesk probability and an ELO gap must never be converted into a "
                + "spread, a win probability or an edge.",
            }));
          }
        }
      }
    }

    /* ---- L6 CURRENT — poll rankings. A poll is an opinion, and is labelled one. */
    if (wants("rankings")) {
      const rk = await this.read(
        "rankings?select=season,week,season_type,poll,team,rank,points&order=rank.asc&limit=400",
        "team_stats", "cfb");
      path.rankings = { rows: rk.rows.length, error: rk.error };
      if (rk.error) out.push(unavailable("cfb.rankings", "cfb_ranking", `read failed — ${rk.error}`));
      else if (rk.rows.length) {
        const ap = rk.rows.filter((r: any) => String(r.poll ?? "").includes("AP"));
        const pool = ap.length ? ap : rk.rows;
        const maxWk = pool.reduce((a: number, r: any) => Math.max(a, num(r.week) ?? 0), 0);
        for (const r of pool.filter((r: any) => num(r.week) === maxWk && matchesTeam(r.team)).slice(0, 30)) {
          out.push(cfbEv({
            source: "cfb.rankings", entity: r.team, field: "cfb_ranking",
            source_type: "OWNED_TABLE", layer: "context", data_layer: "L6_CURRENT",
            relevance: "context", season: r.season,
            value: { team: r.team, poll: r.poll, rank: r.rank, week: r.week, season: r.season, points: r.points },
            status: "VERIFIED", freshness: freshnessOf("team_stats", Date.now()),
            provenance: `cfb.rankings ${r.poll} week ${maxWk}`,
            note: "A poll is a human opinion about past results. It is not a projection and not an efficiency measure.",
          }));
        }
      }
    }

    /* ---- Slow-changing layers: recruiting and roster.
       Exactly the data §28 says should come from ingestion rather than a live
       call — it changes a few times a year, so a stored copy is both cheaper
       and fresher-than-necessary. */
    if (wants("recruiting")) {
      const rc = await this.read("recruiting?select=year,team,rank,points&order=year.desc.nullslast&limit=800",
        "historical", "cfb");
      path.recruiting = { rows: rc.rows.length, error: rc.error };
      if (rc.error) out.push(unavailable("cfb.recruiting", "cfb_recruiting", `read failed — ${rc.error}`));
      else if (!rc.rows.length) out.push(unavailable("cfb.recruiting", "cfb_recruiting", "no recruiting rows on file"));
      else {
        const latest = rc.rows.reduce((a: number, r: any) => Math.max(a, num(r.year) ?? 0), 0);
        for (const r of rc.rows.filter((r: any) => num(r.year) === latest && matchesTeam(r.team)).slice(0, 140)) {
          out.push(cfbEv({
            source: "cfb.recruiting", entity: r.team, field: "cfb_recruiting",
            source_type: "OWNED_TABLE", layer: "context", data_layer: "L3_TEAM_SEASON",
            relevance: "context", season: latest,
            value: { team: r.team, class_year: r.year, class_rank: r.rank, points: r.points },
            status: "VERIFIED", freshness: freshnessOf("historical", Date.now()),
            provenance: `cfb.recruiting class of ${latest}`,
            note: "Recruiting is an input to future talent, not a measure of current performance. It is the weakest "
              + "evidence type here and must never outrank an on-field measurement.",
          }));
        }
      }
    }

    /* A roster is a PER-TEAM read, so it needs a resolved team. When none
       resolved, the honest outcome is an explicit refusal naming why — not a
       skipped read. Silently doing nothing here is what made a roster question
       answer "no roster data" for a lookup that was never attempted, and
       "EdgeDesk did not look" and "the data is not there" are different
       sentences with different fixes. */
    if (wants("roster") && !teamFilter.length) {
      out.push(unavailable("cfb.roster", "cfb_roster",
        "no school resolved unambiguously from the question, so no roster was retrieved. A roster is per-team and "
        + "cannot be fetched for an ambiguous reference — college names collide badly (Miami is two universities, "
        + "Georgia and Georgia Tech are different schools). Ask which program was meant; do not describe a roster "
        + "from memory."));
    }
    if (wants("roster") && teamFilter.length) {
      for (const t of (opts.teams ?? []).slice(0, 3)) {
        const rs = await this.read(
          `roster?select=first_name,last_name,position,jersey,year,height,weight&team=eq.${encodeURIComponent(t)}`
          + "&order=position&limit=200", "player_stats", "cfb");
        if (rs.error) { out.push(unavailable("cfb.roster", "cfb_roster", `read failed for ${t} — ${rs.error}`, t)); continue; }
        if (!rs.rows.length) { out.push(unavailable("cfb.roster", "cfb_roster", `no roster rows on file for "${t}"`, t)); continue; }
        const byPos: Record<string, number> = {};
        for (const p of rs.rows) byPos[String(p.position ?? "?")] = (byPos[String(p.position ?? "?")] ?? 0) + 1;
        out.push(cfbEv({
          source: "cfb.roster", entity: t, field: "cfb_roster",
          source_type: "OWNED_TABLE", layer: "season", data_layer: "L4_PLAYER_SEASON",
          relevance: "roster",
          value: {
            team: t, players: rs.rows.length, by_position: byPos,
            quarterbacks: rs.rows.filter((p: any) => String(p.position ?? "").toUpperCase() === "QB")
              .map((p: any) => ({ name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(), year: p.year, jersey: p.jersey })),
            sample: rs.rows.slice(0, 40).map((p: any) => ({
              name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
              position: p.position, year: p.year, height: p.height, weight: p.weight,
            })),
          },
          status: "PARTIAL", freshness: freshnessOf("player_stats", Date.now()),
          provenance: `cfb.roster for ${t}`,
          note: "A ROSTER IS NOT A DEPTH CHART. Being listed says a player is on the team; it does not say he starts, "
            + "how much he plays, or that he is healthy. Never present a roster quarterback as the confirmed starter.",
        }));
      }
    }

    /* ---- Book lines. Context ONLY: these are consensus numbers from the CFBD
       mirror, not Pinnacle, and not the deterministic engine's prices. */
    if (wants("lines")) {
      const ln = await this.read("lines?select=game_id,provider,spread,over_under,home_moneyline,away_moneyline&limit=600",
        "", "cfb");
      path.lines = { rows: ln.rows.length, error: ln.error };
      if (ln.error) out.push(unavailable("cfb.lines", "cfb_book_line", `read failed — ${ln.error}`));
      else if (ln.rows.length) {
        const byGame = new Map<string, any[]>();
        for (const l of ln.rows) {
          const k = String(l.game_id);
          byGame.set(k, [...(byGame.get(k) ?? []), l]);
        }
        for (const [gid, rows] of [...byGame].slice(0, 40)) {
          out.push(cfbEv({
            source: "cfb.lines", entity: gid, field: "cfb_book_line",
            source_type: "MARKET", layer: "market", data_layer: "L7_MARKET",
            relevance: "market", event_id: gid,
            value: { game_id: gid, quotes: rows.map((r: any) => ({
              provider: r.provider, spread: r.spread, total: r.over_under,
              home_moneyline: r.home_moneyline, away_moneyline: r.away_moneyline })) },
            status: "PARTIAL", freshness: "UNKNOWN",
            provenance: "cfb.lines (CollegeFootballData consensus book numbers)",
            note: "CONSENSUS BOOK NUMBERS FOR CONTEXT ONLY. These are not Pinnacle, they are not EdgeDesk's captured "
              + "prices, and they carry no timestamp. Never compute an edge against them and never quote one as the "
              + "current price — the `signals` rows are the only prices EdgeDesk stands behind.",
          }));
        }
      }
    }

    /* ---- PROBE LAYERS. Returning production and the transfer portal are real
       CFBD products and genuinely valuable for college football, but whether
       cfb_ingest writes them into this schema is not something this function
       may assume. So it ASKS. A failure here names the exact table and the
       endpoint that would fill it, which is a far more useful answer than
       either a guess or a silence. */
    for (const [need, table, field, why] of [
      ["returning_production", "returning_production", "cfb_returning_production",
        "returning production (CFBD /player/returning) is the strongest single predictor of year-over-year college movement"],
      ["portal", "portal", "cfb_portal",
        "the transfer portal (CFBD /player/portal) breaks year-over-year priors more than any other college input"],
    ] as [string, string, string, string][]) {
      if (!wants(need)) continue;
      const r = await this.read(`${table}?select=*&limit=200`, "historical", "cfb");
      (path as any)[table] = { rows: r.rows.length, error: r.error };
      if (r.error) {
        out.push(unavailable(`cfb.${table}`, field,
          `cfb.${table} is not readable — ${r.error}. This table is NOT written by the current cfb_ingest. `
          + `${why}. To fill it, extend cfb_ingest, or set CFBD_API_KEY to allow a direct call.`));
      } else if (!r.rows.length) {
        out.push(unavailable(`cfb.${table}`, field,
          `cfb.${table} exists but is empty — cfb_ingest has not populated it. ${why}.`));
      } else {
        for (const row of r.rows.filter((x: any) => matchesTeam(x.team)).slice(0, 60)) {
          out.push(cfbEv({
            source: `cfb.${table}`, entity: row.team ?? null, field,
            source_type: "PROVIDER_API", layer: "season", data_layer: "L3_TEAM_SEASON",
            relevance: "roster", value: row,
            status: "VERIFIED", freshness: freshnessOf("historical", Date.now()),
            provenance: `cfb.${table} (CollegeFootballData mirror)`,
          }));
        }
      }
    }

    path.emitted = out.length;
    return { ev: out, path };
  }

  /* ==================================================================== */
  /* NFL — deep layer over the owned multisport tables                     */
  /* ==================================================================== */

  /**
   * The NFL layers that getTeamFeatures does not reach.
   *
   * getTeamFeatures already does the heavy lifting per game — efficiency both
   * sides, the quarterback, and the situational row — and it is left exactly
   * as it is. This adds the layers around it: player production, team form,
   * and an explicit, per-capability statement of what EdgeDesk does NOT have
   * for this sport, which for the NFL is the injury report, special teams and
   * anything snap- or target-derived.
   *
   * That last part is not padding. An answer that quietly omits injuries reads
   * as an answer that considered them.
   */
  async getNflDeep(opts: { needs: Set<string>; teams?: string[] }): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const out: Evidence[] = [];
    const path: Record<string, unknown> = { sport: "americanfootball_nfl", needs: [...opts.needs] };
    const SPORT = "americanfootball_nfl";
    const season = seasonFor(SPORT);
    const teamFilter = (opts.teams ?? []).map(normName).filter(Boolean);
    const matches = (n: unknown) => !teamFilter.length
      || teamFilter.some((t) => normName(n).includes(t) || t.includes(normName(n)));

    if (opts.needs.has("player_production")) {
      const sp = await this.read(
        "stats_players?select=league,team,player,position,stat_line,lead_cat,lead_val"
        + "&league=eq.NFL&limit=300", "player_stats");
      path.stats_players = { rows: sp.rows.length, error: sp.error };
      if (sp.error) {
        out.push(unavailable("stats_players", "nfl_player_production", `read failed — ${sp.error}`));
      } else if (!sp.rows.length) {
        out.push(unavailable("stats_players", "nfl_player_production",
          "no NFL rows in stats_players — capture_stats has not written this league"));
      } else {
        for (const r of sp.rows.filter((r: any) => matches(r.team)).slice(0, 80)) {
          out.push(ev({
            source: "stats_players", entity: r.player, field: "nfl_player_production",
            sport: SPORT, league: "NFL", season,
            canonical_team_id: resolveTeamIdentity(String(r.team ?? ""), SPORT)
              .find((m) => m.status === "RESOLVED")?.canonical_team_id ?? null,
            source_type: "OWNED_TABLE", layer: "season", data_layer: "L4_PLAYER_SEASON",
            relevance: "stats",
            value: { player: r.player, team: r.team, position: r.position,
              stat_line: r.stat_line, leading_category: r.lead_cat, leading_value: r.lead_val },
            status: "PARTIAL", freshness: freshnessOf("player_stats", Date.now()),
            provenance: "stats_players (capture_stats), league=NFL",
            note: "A LEADERBOARD LINE, not a full statistical profile. Target share, air yards, snap counts, route "
              + "participation and red-zone usage are NOT in this table and are not available anywhere in EdgeDesk. "
              + "Do not infer usage from a counting line.",
          }));
        }
      }
    }

    if (opts.needs.has("team_form")) {
      const gs = await this.read("game_stats?select=*&limit=200", "team_stats");
      path.game_stats = { rows: gs.rows.length, error: gs.error };
      if (gs.error) {
        out.push(unavailable("game_stats", "nfl_team_form",
          `game_stats is not readable — ${gs.error}. Records and form are unavailable; efficiency is unaffected.`));
      } else if (gs.rows.length) {
        for (const r of gs.rows.filter((r: any) => matches(r.team_norm ?? r.team)).slice(0, 40)) {
          out.push(ev({
            source: "game_stats", entity: r.team ?? r.team_norm, field: "nfl_team_form",
            sport: SPORT, league: "NFL", season,
            source_type: "OWNED_TABLE", layer: "context", data_layer: "L3_TEAM_SEASON",
            relevance: "form", value: r,
            status: "PARTIAL", freshness: freshnessOf("team_stats", Date.now()),
            provenance: "game_stats keyed on team_norm",
            note: "Records and form context only. Never a substitute for efficiency — a record is an outcome.",
          }));
        }
      }
    }

    /* The declared gaps, emitted as evidence so they are IN the packet rather
       than left for the analyst to notice. An unstated gap gets treated as a
       considered-and-dismissed factor, which is worse than an absence. */
    if (opts.needs.has("injuries")) {
      out.push(unavailable("EdgeDesk", "nfl_injury_report",
        "EdgeDesk ingests NO NFL injury report. The ONLY availability signal in the system is on qb_features "
        + "(status / is_backup / injury_note) and it covers the quarterback alone. Say explicitly that injuries "
        + "beyond the quarterback are not on file — never imply a clean injury sheet from their absence."));
    }
    if (opts.needs.has("special_teams")) {
      out.push(unavailable("team_features", "nfl_special_teams",
        "No kicking, punting, return or field-position columns exist in team_features. Special teams is not "
        + "ingested for the NFL and is not approximated from anything else."));
    }

    path.emitted = out.length;
    return { ev: out, path };
  }

  /* ==================================================================== */
  /* COLLEGE BASKETBALL — deep layer                                       */
  /* ==================================================================== */

  /**
   * CBB layers beyond the per-game efficiency row.
   *
   * getTeamFeatures already emits adjusted efficiency, tempo and both sides of
   * the four factors for a carded game. What was missing is the thing that
   * turns two team profiles into a MATCHUP: which side holds each axis.
   *
   * `cbb_matchup_edge` is a COMPARISON OF OWNED COLUMNS and nothing more. Both
   * raw numbers travel with every axis, the direction convention is stated, and
   * no combined score, weight or probability is produced. That boundary is the
   * whole reason it is safe to compute here: the deterministic engine still
   * owns every number that could become a bet.
   */
  async getCbbDeep(opts: { needs: Set<string>; teams?: string[]; teamRows?: any[] }): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const out: Evidence[] = [];
    const path: Record<string, unknown> = { sport: "basketball_ncaab", needs: [...opts.needs] };
    const SPORT = "basketball_ncaab";
    const season = seasonFor(SPORT);
    const teamFilter = (opts.teams ?? []).map(normName).filter(Boolean);
    const matches = (n: unknown) => !teamFilter.length
      || teamFilter.some((t) => normName(n).includes(t) || t.includes(normName(n)));

    if (opts.needs.has("player_production")) {
      const sp = await this.read(
        "stats_players?select=league,team,player,position,stat_line,lead_cat,lead_val"
        + "&league=eq.CBB&limit=300", "player_stats");
      path.stats_players = { rows: sp.rows.length, error: sp.error };
      if (sp.error) {
        out.push(unavailable("stats_players", "cbb_player_production", `read failed — ${sp.error}`));
      } else if (!sp.rows.length) {
        out.push(unavailable("stats_players", "cbb_player_production",
          "no CBB rows in stats_players. Player-level college basketball data is not ingested — minutes, usage rate, "
          + "shooting splits and lineup context are all unavailable. Say so; do not infer a role from a box score."));
      } else {
        for (const r of sp.rows.filter((r: any) => matches(r.team)).slice(0, 80)) {
          out.push(ev({
            source: "stats_players", entity: r.player, field: "cbb_player_production",
            sport: SPORT, league: "D1", season,
            source_type: "OWNED_TABLE", layer: "season", data_layer: "L4_PLAYER_SEASON",
            relevance: "stats",
            value: { player: r.player, team: r.team, position: r.position,
              stat_line: r.stat_line, leading_category: r.lead_cat, leading_value: r.lead_val },
            status: "PARTIAL", freshness: freshnessOf("player_stats", Date.now()),
            provenance: "stats_players (capture_stats), league=CBB",
            note: "A leaderboard line. MINUTES, USAGE RATE and LINEUP CONTEXT ARE NOT IN IT — a per-game average "
              + "says nothing about whether the player starts or how the rotation is built.",
          }));
        }
      }
    }

    if (opts.needs.has("rankings")) {
      const rk = await this.read(
        "rankings_current?select=league,poll,rank,team,week,season&league=eq.CBB&order=rank.asc&limit=60", "team_stats");
      path.rankings = { rows: rk.rows.length, error: rk.error };
      if (rk.error || !rk.rows.length) {
        out.push(unavailable("rankings_current", "cbb_ranking",
          rk.error ?? "no CBB rows in rankings_current"));
      } else {
        for (const r of rk.rows.filter((r: any) => matches(r.team)).slice(0, 30)) {
          out.push(ev({
            source: "rankings_current", entity: r.team, field: "cbb_ranking",
            sport: SPORT, league: "D1", season: r.season ?? season,
            source_type: "OWNED_TABLE", layer: "context", data_layer: "L6_CURRENT",
            relevance: "context", value: r,
            status: "VERIFIED", freshness: freshnessOf("team_stats", Date.now()),
            note: "A poll is an opinion about past results, not a tempo-free rating. adj_em outranks it every time.",
          }));
        }
      }
    }

    /* THE MATCHUP AXES. Derived by comparing two owned rows, per game. */
    if (opts.needs.has("matchup_edge") && Array.isArray(opts.teamRows) && opts.teamRows.length) {
      const byGame = new Map<string, any[]>();
      for (const r of opts.teamRows) {
        if (r?.game_id == null) continue;
        byGame.set(String(r.game_id), [...(byGame.get(String(r.game_id)) ?? []), r]);
      }
      let built = 0;
      for (const [gid, sides] of byGame) {
        const home = sides.find((s: any) => String(s.side).toLowerCase() === "home");
        const away = sides.find((s: any) => String(s.side).toLowerCase() === "away");
        if (!home || !away) continue;
        /* `lowerIsBetter` is carried per axis rather than assumed, because the
           sign convention flips between them: adj_d and turnover rate reward a
           LOW number, everything else a high one, and getting one of them
           backwards inverts the whole read. */
        const AXES: [string, string, boolean, string][] = [
          ["adjusted_offense", "adj_o", false, "points scored per 100 possessions, opponent-adjusted"],
          ["adjusted_defense", "adj_d", true, "points ALLOWED per 100 possessions — lower is better"],
          ["net_efficiency", "adj_em", false, "adj_o minus adj_d; the best single-number summary"],
          ["shooting", "efg_pct", false, "effective field goal percentage — the heaviest of the four factors"],
          ["turnovers", "to_pct", true, "turnover rate — lower is better"],
          ["offensive_rebounding", "orb_pct", false, "share of available offensive rebounds"],
          ["free_throw_rate", "ft_rate", false, "free throw attempts per field goal attempt"],
          ["three_point_rate", "three_rate", false, "share of shots taken from three — a style fact, not a skill"],
        ];
        const axes: any[] = [];
        for (const [label, col, lowerBetter, meaning] of AXES) {
          const h = num(home[col]), a = num(away[col]);
          if (h == null || a == null) { axes.push({ axis: label, status: "unavailable", meaning }); continue; }
          const holder = h === a ? null : (lowerBetter ? (h < a ? "home" : "away") : (h > a ? "home" : "away"));
          axes.push({
            axis: label, meaning, lower_is_better: lowerBetter,
            home: h, away: a, gap: +(h - a).toFixed(3),
            advantage: holder, advantage_team: holder === "home" ? home.team : holder === "away" ? away.team : null,
          });
        }
        const ht = num(home.adj_tempo), at = num(away.adj_tempo);
        out.push(ev({
          source: "team_features", entity: `${away.team} @ ${home.team}`, field: "cbb_matchup_edge",
          sport: SPORT, league: "D1", season, event_id: gid,
          source_type: "DERIVED", layer: "matchup", data_layer: "L5_MATCHUP",
          relevance: "matchup",
          value: {
            game: `${away.team} @ ${home.team}`, game_id: gid,
            home_team: home.team, away_team: away.team, axes,
            tempo: (ht != null && at != null)
              ? { home_adj_tempo: ht, away_adj_tempo: at,
                  note: "Expected possessions come from BOTH tempos together, never from either alone. Two efficient "
                    + "slow teams routinely play under a number their efficiencies alone would suggest." }
              : { note: "Tempo is missing for at least one side — the possession count cannot be read." },
          },
          status: axes.some((x) => x.status === "unavailable") ? "PARTIAL" : "VERIFIED",
          freshness: freshnessOf("team_stats", Date.now()),
          provenance: "derived by comparing the two team_features rows for this game_id",
          note: "A COMPARISON OF OWNED COLUMNS, nothing else. Each axis names which side holds it and carries BOTH "
            + "raw values so the claim can be checked. No axis is weighted, no axes are combined, and nothing here "
            + "is a probability, a spread, an edge or a projection. Shooting is the heaviest of the four factors, "
            + "then turnovers, then rebounding, then free throws — but a MISMATCH is what makes a number wrong, "
            + "not a high ranking on its own.",
        }));
        built++;
        if (built >= 25) break;
      }
      path.matchup_edges = { games_compared: built };
    }

    if (opts.needs.has("availability")) {
      out.push(unavailable("EdgeDesk", "cbb_availability",
        "No college basketball injury, suspension or lineup-availability data is ingested anywhere in EdgeDesk. "
        + "This is the single highest-value missing input for the sport: one absent starter moves a college total "
        + "and a college spread more than any efficiency gap in the packet. State it plainly — never infer "
        + "availability from minutes, and never treat a season efficiency rating as evidence about the lineup "
        + "that will actually play."));
    }

    path.emitted = out.length;
    return { ev: out, path };
  }

  /**
   * Season-to-date pitching and team offense, keyed on IDENTITY rather than on
   * game_id.
   *
   * Everything else in the MLB layer hangs off games -> pitcher_features ->
   * offense_features. That chain is the better answer when it holds, because a
   * per-game row knows which bat the arm actually faces. But it is a three-link
   * join on a key that is written by a different job, and when any link misses
   * the whole pitcher read collapses — which is what produced "quality on file
   * for 10 starters, opponent_offense missing for nearly all of them" and a
   * refusal instead of a ranking.
   *
   * These two tables are keyed on the pitcher and the team, so a starter's
   * season line is available the moment his NAME appears on the card. They are
   * emitted alongside the per-game evidence and labelled `season` so a
   * season-long rate can never be read as a matchup-specific one.
   */
  async getSeasonPitching(): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const path: Record<string, unknown> = {};
    const out: Evidence[] = [];
    const season = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));

    /* 60, not 200, and a COMPACT projection.
       Every evidence value here is serialized into the model prompt. 200 rows
       of 13 fields plus 40 team rows is tens of thousands of tokens of table
       for a question that needs the tail of a ranking, and it took the whole
       function to a 502 — the request ran, built a payload the model call could
       not accept, and threw. Ranking "worst" needs the worst end ordered, not
       the league. */
    const p = await this.read(
      `pitcher_season?select=name,team,games_started,ip,era,fip,whip,k_bb_pct,hr_per9,fip_constant,as_of`
      + `&season=eq.${season}&games_started=gt.0&order=fip.desc.nullslast&limit=60`, "player_stats");
    path.pitcher_season = { rows: p.rows.length, error: p.error, season };
    if (p.error) {
      out.push(unavailable("pitcher_season", "season_pitching", `read failed — ${p.error}`));
    } else if (!p.rows.length) {
      out.push(unavailable("pitcher_season", "season_pitching",
        `no rows for season ${season} — ingest_pitcher_season has not run, or the migration has not been applied`));
    } else {
      const slim = p.rows.map((r: any) => ({
        name: r.name, team: r.team, gs: r.games_started, ip: r.ip,
        era: r.era, fip: r.fip, whip: r.whip, k_bb_pct: r.k_bb_pct, hr9: r.hr_per9,
      }));
      out.push(ev({
        source: "pitcher_season", entity: `MLB ${season}`, field: "season_pitching",
        value: { season, starters: slim.length, ordered: "worst FIP first", rows: slim,
          fip_constant: p.rows[0]?.fip_constant ?? null,
          basis: "season-to-date, keyed on the pitcher. NOT matchup-specific — it says nothing about the opponent, park or weather." },
        status: "VERIFIED", source_timestamp: p.rows[0]?.as_of ?? null,
        freshness: freshnessOf("historical", p.rows[0]?.as_of), relevance: "quality",
        note: "Ordered worst FIP first. FIP is computed from counting stats with the league constant derived from the same pull; fip_constant is carried so it can be checked.",
      }));
    }

    const t = await this.read(
      `team_season?select=team,runs_per_game,ops,k_pct,hr_per_game,woba,barrel_pct,hardhit_pct,ra_per_game,as_of`
      + `&season=eq.${season}&order=runs_per_game.desc.nullslast&limit=30`, "team_stats");
    path.team_season = { rows: t.rows.length, error: t.error };
    if (t.error) {
      out.push(unavailable("team_season", "season_offense", `read failed — ${t.error}`));
    } else if (!t.rows.length) {
      out.push(unavailable("team_season", "season_offense",
        `no team rows for season ${season} — ingest_pitcher_season has not run`));
    } else {
      out.push(ev({
        source: "team_season", entity: `MLB ${season}`, field: "season_offense",
        value: { season, teams: t.rows.length, ordered: "best offense first", rows: t.rows,
          basis: "season-to-date team batting and pitching, keyed on the team. The opponent axis when the per-game offense row is missing." },
        status: "VERIFIED", source_timestamp: t.rows[0]?.as_of ?? null,
        freshness: freshnessOf("historical", t.rows[0]?.as_of), relevance: "matchup",
        note: t.rows.length === 30 ? "all 30 clubs" : `${t.rows.length} of 30 clubs — the rest did not ingest`,
      }));
    }
    return { ev: out, path };
  }

  async getPitcherFeatures(): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const days = [etDay(-1), etDay(0), etDay(1)];
    const path: Record<string, unknown> = { days_queried: days };
    const out: Evidence[] = [];

    // Link 1 — the games rows that carry the ids pitcher_features is keyed by.
    const g = await this.read(
      `games?select=game_id,game_date,home_team,away_team,start_time,status,park_id&game_date=in.(${days.join(",")})&order=start_time.asc&limit=60`, "schedule");
    path.games = { rows: g.rows.length, error: g.error };

    /* A COMPLETED GAME'S STARTER IS NOT A STARTER ON TONIGHT'S CARD.

       The three-day window exists because an ET slate can straddle a UTC date
       and a late game can be listed under tomorrow. But it also drags in
       YESTERDAY, and yesterday's games are Final with fully-ingested
       pitcher_features, while tonight's were written minutes ago — so the
       completed card outnumbers the live one and dominates the evidence. That
       is precisely what the integrity check keeps reporting: "61 items are
       bound to a date other than the one being asked about", followed by a
       ranking built on a pitcher who threw last night.

       Final games are dropped here rather than retrieved and then flagged. The
       warning was correct every time; the right response to it is not to keep
       printing it, it is to stop fetching the rows that cause it. A game from
       the earlier date that is NOT final is kept — a suspended or postponed
       carryover really is on tonight's card. */
    const finalOf = (r: any) => String(r?.status ?? "").toLowerCase() === "final";
    const live = g.rows.filter((r) => !finalOf(r));
    path.games_live = { total: g.rows.length, live: live.length, dropped_final: g.rows.length - live.length };
    let ids: string[] = live.map((r) => r.game_id).filter((v) => v != null).map(String);

    // Link 1b — if the date filter found nothing, is the table readable at all?
    if (!ids.length) {
      const probe = await this.read("games?select=game_id,game_date&order=game_date.desc&limit=5", "schedule");
      path.games_probe = {
        rows: probe.rows.length, error: probe.error,
        latest_dates: probe.rows.map((r) => r.game_date),
        diagnosis: probe.error
          ? "E — games is not readable by this caller (RLS or grant)."
          : probe.rows.length
            ? `C — games is readable but holds no row for ${days.join("/")}; latest is ${probe.rows[0]?.game_date}. The MLB ingestion is stale or writes a different date.`
            : "A — games is readable and empty. The MLB ingestion has never written to it.",
      };
    }

    // Link 2 — pitcher quality, joined on those ids.
    let pf: any[] = [];
    if (ids.length) {
      const r = await this.read(
        `pitcher_features?select=game_id,side,pitcher_id,name,xera,k_pct,bb_pct,barrel_pct,hardhit_pct,era,fip,whip,whiff_pct,xwoba_against,updated_at&game_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=200`, "player_stats");
      pf = r.rows; path.pitcher_features = { rows: pf.length, error: r.error, game_ids_tried: ids.length };
    }
    // Link 2b — join produced nothing: does the table hold anything at all, and
    // do its game_ids look like the ones `games` hands out?
    if (!pf.length) {
      const probe = await this.read("pitcher_features?select=game_id,name,xera&limit=5", "player_stats");
      path.pitcher_features_probe = {
        rows: probe.rows.length, error: probe.error,
        sample_game_ids: probe.rows.map((r) => r.game_id),
        diagnosis: probe.error
          ? "E — pitcher_features is not readable by this caller (RLS or grant)."
          : !probe.rows.length
            ? "A — pitcher_features is readable and empty. The Statcast/feature ingestion has never populated it."
            : ids.length
              ? "B — pitcher_features holds rows, but none matched today's game_ids. The games -> pitcher_features key does not line up; compare sample_game_ids against the ids in games."
              : "C — pitcher_features holds rows, but no game_ids could be resolved for today, so the join was never attempted.",
      };
    }

    // Link 3 — the offense each starter actually faces.
    let off: any[] = [];
    if (ids.length) {
      const r = await this.read(
        `offense_features?select=game_id,side,obp,iso,k_pct,runs_per_game,avg,slg,ops,bb_pct,vs_lhp,vs_rhp,updated_at&game_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=200`, "team_stats");
      off = r.rows; path.offense_features = { rows: off.length, error: r.error };
    }

    // Link 4 — starter workload, for rest and pitch-count context.
    const use = await this.read(
      `mlb_pitcher_usage?select=pitcher_id,game_date,pitches,outs,started&game_date=gte.${etDay(-8)}&started=is.true&order=game_date.desc&limit=1200`, "player_stats");
    path.mlb_pitcher_usage = { rows: use.rows.length, error: use.error };

    const offBy: Record<string, any> = {};
    for (const r of off) offBy[`${r.game_id}|${String(r.side ?? "").toLowerCase()}`] = r;
    const lastStart: Record<string, any> = {};
    for (const r of use.rows) {
      const k = String(r.pitcher_id);
      if (!lastStart[k] || String(r.game_date) > String(lastStart[k].game_date)) lastStart[k] = r;
    }
    const flip = (s: string) => (s === "home" ? "away" : s === "away" ? "home" : "");

    /* The games row carries the identity every audit needs: which teams, which
       date, and whether it has already been played. Without it the owned path
       emitted a pitcher with a side and a game_id and nothing else, so the
       identity check had nothing to cross-check and silently passed, and the
       model could not tell whose offense it was looking at. */
    const gameById: Record<string, any> = {};
    for (const r of g.rows) gameById[String(r.game_id)] = r;
    const teamOn = (gm: any, s: string) => s === "home" ? gm?.home_team : s === "away" ? gm?.away_team : null;

    for (const p of pf) {
      const side = String(p.side ?? "").toLowerCase();
      const gm = gameById[String(p.game_id)] ?? null;
      const oppSide = flip(side);
      const opp = offBy[`${p.game_id}|${oppSide}`] ?? null;
      const u = lastStart[String(p.pitcher_id)] ?? null;
      const missing = (["xera", "k_pct", "bb_pct", "barrel_pct", "hardhit_pct"] as const).filter((k) => p[k] == null);
      const played = String(gm?.status ?? "").toLowerCase() === "final";
      const gameDate = gm?.game_date ? String(gm.game_date).slice(0, 10) : null;
      const matchup = gm ? `${gm.away_team} @ ${gm.home_team}` : null;
      const oppTeam = teamOn(gm, oppSide);

      out.push(ev({
        source: "pitcher_features", entity: p.name, field: "pitcher_quality", relevance: "pitching",
        player_id: p.pitcher_id ?? null,
        event_id: p.game_id != null ? String(p.game_id) : null,
        sport: "baseball_mlb",
        value: {
          /* pitcher_id travels WITH the value, not just alongside it. The name
             is a display label — two starters can share a surname and one can
             be spelled two ways — so the id is what the integrity checks and
             any downstream join key on. */
          name: p.name, pitcher_id: p.pitcher_id ?? null, side, game_id: p.game_id,
          team: teamOn(gm, side), game: matchup, game_date: gameDate, opponent: oppTeam,
          era: p.era, fip: p.fip, whip: p.whip,
          xera: p.xera, k_pct: p.k_pct, bb_pct: p.bb_pct, barrel_pct: p.barrel_pct,
          hardhit_pct: p.hardhit_pct, whiff_pct: p.whiff_pct, xwoba_against: p.xwoba_against,
          already_played: played,
          missing_fields: missing,
        },
        /* A completed game is a sample, never a fact about tonight. */
        status: missing.length === 5 ? "UNAVAILABLE" : played ? "HISTORICAL" : missing.length ? "PARTIAL" : "VERIFIED",
        source_timestamp: p.updated_at ?? null,
        freshness: p.updated_at ? freshnessOf("player_stats", p.updated_at) : "UNKNOWN",
      }));
      out.push(opp
        ? ev({
          source: "offense_features", entity: p.name, field: "opponent_offense", relevance: "matchup",
          value: {
            /* Naming the team is what makes this attributable. Two starters who
               face the SAME team share one season line by definition, and
               without the name that reads as a duplication fault. */
            opponent: oppTeam, faces_side: oppSide, game_date: gameDate,
            obp: opp.obp, iso: opp.iso, k_pct: opp.k_pct, runs_per_game: opp.runs_per_game,
            avg: opp.avg, slg: opp.slg, ops: opp.ops, bb_pct: opp.bb_pct,
            vs_lhp: opp.vs_lhp ?? null, vs_rhp: opp.vs_rhp ?? null,
          },
          status: played ? "HISTORICAL" : "VERIFIED",
          source_timestamp: opp.updated_at ?? null,
          freshness: opp.updated_at ? freshnessOf("team_stats", opp.updated_at) : "UNKNOWN",
          note: `Season line for ${oppTeam ?? "the opposing side"}, joined through pitcher_features.game_id `
            + `and the opposite side of offense_features.`,
        })
        : unavailable("offense_features", "opponent_offense", "no offense row for the opposing side of this game", p.name));
      if (u) {
        out.push(ev({
          source: "mlb_pitcher_usage", entity: p.name, field: "workload", relevance: "workload",
          value: { last_start: String(u.game_date).slice(0, 10), pitches: u.pitches, outs: u.outs },
          status: "VERIFIED", source_timestamp: String(u.game_date), freshness: freshnessOf("player_stats", String(u.game_date)),
        }));
      }
    }

    /* The owned feature tables produced nothing usable. Rather than reporting a
       dead end, fall back to the official MLB feed for the traditional line so
       the question is still answerable — clearly attributed, and with the
       Statcast fields still declared unavailable. */
    if (!pf.length && this.mlbFallback) {
      const fb = await this.getMlbLiveFallback();
      path.live_fallback = fb.path;
      /* This text is read by the model and it must describe what actually
         happened. The previous wording predated the Savant tier and said the
         Statcast fields were missing — so an answer that HAD xERA opened by
         announcing it had none, then quoted it two lines later. */
      const scOk = /read \d+ pitchers/.test(String(fb.path.statcast_status ?? ""));
      path.live_fallback_reason =
        "pitcher_features returned no rows for this slate, so EdgeDesk read the official MLB Stats API for "
        + "the traditional line" + (scOk
          ? " AND Baseball Savant directly for the Statcast layer. xERA, xwOBA, barrel%, hard-hit% and whiff% "
            + "ARE present for the pitchers Savant returned — check each starter's own fields rather than "
            + "assuming the slate has none. Repairing ingest_mlb would serve these from the owned table instead."
          : ", but the Statcast read returned nothing, so xERA / barrel% / hard-hit% are genuinely unavailable "
            + "for this slate. Repair ingest_mlb to restore them from the owned table.");
      out.push(...fb.ev);
    }

    if (!out.length) {
      out.push(unavailable("pitcher_features", "pitcher_quality",
        "No pitcher-quality rows could be retrieved for this slate. See data_path for which link in games -> pitcher_features -> offense_features failed."));
    }
    return { ev: out, path };
  }

  /**
   * MLB STATISTICAL LAYER — statsapi.mlb.com, keyless and official.
   *
   * This is NOT a new data source: it is the same official feed ingest_mlb and
   * mlb_sync already read, and the app's Intelligence Fabric already registers
   * it. It runs when the owned feature tables come back empty, so a stalled
   * ingestion does not take the research engine down with it.
   *
   * WHAT IT NOW PROVIDES (six batched requests, no per-pitcher fan-out):
   *   pitcher : ERA, WHIP, K%, BB%, K/BB, HR/9, GB/FB tendency, strike%,
   *             pitches/inning, IP, BF, GS, throwing hand
   *   derived : FIP, computed from owned counting stats with the league
   *             constant SOLVED FROM THE SAME FEED rather than assumed
   *   opponent: AVG/OBP/SLG/OPS/ISO, K%, BB%, R/G — AND the platoon split that
   *             actually applies, vs LHP or vs RHP depending on who is starting
   *   workload: last three starts with pitch counts and days rest
   *
   * STILL NOT AVAILABLE, and reported as such rather than approximated:
   * xERA, xwOBA, barrel%, hard-hit%, CSW%, SwStr%, pitch mix and velocity are
   * all Statcast-derived and absent from this feed. wRC+ and wOBA require park
   * and league adjustments this feed does not publish. Those come back only
   * when ingest_mlb's Savant path is repaired.
   */
  async getMlbLiveFallback(dateISO?: string): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const day = dateISO ?? etDay(0);
    const season = day.slice(0, 4);
    /* getMlbCard spans three ET days, so a single-date schedule fetch covered
       only part of the card — which is exactly how coverage read 20 of 50
       starters. The window here matches the card's. */
    const days = dateISO ? [dateISO] : [etDay(0), etDay(1)];
    const path: Record<string, unknown> = { source: "statsapi.mlb.com", dates: days };
    const out: Evidence[] = [];
    const now = Date.now();
    let apiCalls = 0;

    const getJSON = async (url: string, ms = 9000): Promise<any | null> => {
      if (apiCalls >= 20) return null;             // cost ceiling, same spirit as the read budget
      apiCalls++;
      try {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
        const r = await this.f(url, { signal: ctrl?.signal, headers: { accept: "application/json" } });
        if (t) clearTimeout(t);
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    };

    /* "121.2" is 121 innings and two OUTS, not 121.2 innings. Getting this
       wrong quietly corrupts every rate stat built on top of it. */
    const ipNum = (v: unknown): number | null => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const m = s.match(/^(\d+)(?:\.(\d))?$/);
      if (!m) { const n = num(s); return n; }
      return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 3 : 0);
    };
    const pct3 = (x: number | null) => x == null ? null : +x.toFixed(3);

    // 1. the card + probable starters, across the same window getMlbCard uses
    const scheds: any[] = [];
    for (const dd of days) {
      const j = await getJSON(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dd}&hydrate=probablePitcher,team`);
      if (j) scheds.push(j);
    }
    if (!scheds.length) {
      path.error = "schedule request failed";
      return { ev: [unavailable("MLB Stats API", "pitcher_quality", "live fallback unreachable")], path };
    }
    const sched = { dates: scheds.flatMap((j: any) => j.dates ?? []) };

    interface Starter { id: number; name: string; team: string; teamId: number; opp: string; oppId: number; game: string }
    const starters: Starter[] = [];
    const seenStarter = new Set<string>();
    for (const d of sched.dates ?? []) {
      for (const g of d.games ?? []) {
        const away = g.teams?.away, home = g.teams?.home;
        const game = `${away?.team?.name ?? "?"} @ ${home?.team?.name ?? "?"}`;
        for (const [side, other] of [[away, home], [home, away]] as any[]) {
          const p = side?.probablePitcher;
          if (!p?.id) continue;
          const dedupe = `${p.id}|${game}`;
          if (seenStarter.has(dedupe)) continue;   // doubleheaders repeat a card
          seenStarter.add(dedupe);
          starters.push({
            id: p.id, name: p.fullName, team: side?.team?.name, teamId: side?.team?.id,
            opp: other?.team?.name, oppId: other?.team?.id, game,
          });
        }
      }
    }
    path.starters_found = starters.length;
    if (!starters.length) {
      path.note = "no probable starters announced yet for this date";
      return { ev: [unavailable("MLB Stats API", "pitcher_quality", `no probable starters announced for ${day}`)], path };
    }

    /* 2. season line + game log + throwing hand, batched in chunks. A single
       50-id request with a gameLog hydrate is large enough to be truncated or
       refused, which silently halves coverage. */
    const lineById: Record<string, any> = {};
    const logById: Record<string, any[]> = {};
    const handById: Record<string, string> = {};
    /* Season stats and game logs are fetched SEPARATELY, season first.
       Requesting both in one hydrate produces a payload heavy enough that the
       response comes back partial — which showed up as most starters having no
       line at all while one had everything. The season line is what the whole
       quality read depends on, so it is never allowed to share a request with
       the game log, and it is never the thing that runs out of budget. */
    const SEASON_CHUNK = 12, LOG_CHUNK = 6;
    const seasonPages: any[] = [];
    for (let i = 0; i < starters.length; i += SEASON_CHUNK) {
      const ids = starters.slice(i, i + SEASON_CHUNK).map((s) => s.id).join(",");
      const j = await getJSON(
        `https://statsapi.mlb.com/api/v1/people?personIds=${ids}`
        + `&hydrate=stats(group=[pitching],type=[season],season=${season})`);
      if (j) seasonPages.push(j);
    }
    const people = { people: seasonPages.flatMap((j: any) => j.people ?? []) };
    for (const p of people?.people ?? []) {
      const key = String(p.id);
      if (p.pitchHand?.code) handById[key] = p.pitchHand.code;
      for (const s of p.stats ?? []) {
        if (s.group?.displayName !== "pitching") continue;
        const type = s.type?.displayName;
        if (type === "season" && s.splits?.[0]?.stat) lineById[key] = s.splits[0].stat;
        if (type === "gameLog") logById[key] = s.splits ?? [];
      }
    }
    path.pitching_lines = Object.keys(lineById).length;
    path.starters_without_line = starters
      .filter((s) => !lineById[String(s.id)]).map((s) => s.name).slice(0, 12);

    // Game logs are workload context, not the quality read. Best-effort, last.
    for (let i = 0; i < starters.length; i += LOG_CHUNK) {
      const ids = starters.slice(i, i + LOG_CHUNK).map((s) => s.id).join(",");
      const j = await getJSON(
        `https://statsapi.mlb.com/api/v1/people?personIds=${ids}`
        + `&hydrate=stats(group=[pitching],type=[gameLog],season=${season})`, 12000);
      if (!j) break;                       // out of budget or upstream trouble: keep what we have
      for (const p of j.people ?? []) {
        for (const st of p.stats ?? []) {
          if (st.group?.displayName === "pitching" && st.type?.displayName === "gameLog") {
            logById[String(p.id)] = st.splits ?? [];
          }
        }
      }
    }
    path.game_logs = Object.keys(logById).length;

    /* 3. LEAGUE PITCHING TOTALS -> the FIP constant, SOLVED not assumed.
       FIP needs a league constant. Hardcoding 3.10 would be exactly the quiet
       fudge this engine exists to avoid, so it is derived from the same feed:
       cFIP = leagueERA - leagueFIPcore. Every input is traceable. */
    const lgStats = await getJSON(
      `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&stats=season&group=pitching&sportIds=1`);
    let cFIP: number | null = null, lgERA: number | null = null;
    {
      let hr = 0, bb = 0, hbp = 0, so = 0, ip = 0, er = 0, teams = 0;
      for (const s of lgStats?.stats ?? []) {
        for (const sp of s.splits ?? []) {
          const st = sp.stat ?? {};
          const i = ipNum(st.inningsPitched);
          if (i == null) continue;
          hr += num(st.homeRuns) ?? 0; bb += num(st.baseOnBalls) ?? 0;
          hbp += num(st.hitBatsmen) ?? 0; so += num(st.strikeOuts) ?? 0;
          er += num(st.earnedRuns) ?? 0; ip += i; teams++;
        }
      }
      if (ip > 0 && teams >= 20) {
        lgERA = (9 * er) / ip;
        cFIP = lgERA - ((13 * hr + 3 * (bb + hbp) - 2 * so) / ip);
        path.fip_constant = { cFIP: +cFIP.toFixed(3), league_era: +lgERA.toFixed(3), teams, innings: Math.round(ip) };
      } else {
        path.fip_constant = { error: "league pitching totals unavailable — FIP not computed" };
      }
    }

    // 4-6. opponent hitting: overall, vs LHP, vs RHP
    const hitting = async (sit?: string) => {
      const u = sit
        ? `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&stats=statSplits&group=hitting&sitCodes=${sit}&sportIds=1`
        : `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&stats=season&group=hitting&sportIds=1`;
      const j = await getJSON(u);
      const by: Record<string, any> = {};
      for (const s of j?.stats ?? []) for (const sp of s.splits ?? []) {
        if (sp.team?.id != null) by[String(sp.team.id)] = sp.stat;
      }
      return by;
    };
    const hitAll = await hitting();
    const hitVsL = await hitting("vl");
    const hitVsR = await hitting("vr");
    path.team_hitting = { season: Object.keys(hitAll).length, vs_lhp: Object.keys(hitVsL).length, vs_rhp: Object.keys(hitVsR).length };

    /* 7. STATCAST TIER — Baseball Savant, keyless CSV, keyed by MLBAM id.
       This is the layer ingest_mlb is supposed to write into pitcher_features.
       When that pipeline is down, reading Savant directly is what turns
       "pitcher quality not on file" into an actual xERA. Same source, same
       ids, just fetched here instead of yesterday. Two requests. */
    const savant: Record<string, any> = {};
    let savantStatus = "not attempted";
    {
      const getCsv = async (url: string): Promise<Record<string, string>[] | null> => {
        if (apiCalls >= 20) return null;
        apiCalls++;
        try {
          const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
          const t = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
          const r = await this.f(url, { signal: ctrl?.signal, headers: { accept: "text/csv,*/*" } });
          if (t) clearTimeout(t);
          if (!r.ok) return null;
          return csvRows(await r.text());
        } catch { return null; }
      };
      const put = (id: string, k: string, v: number | null) => {
        if (v == null || !id) return;
        (savant[id] ||= {})[k] = v;
      };
      const exp = await getCsv(
        `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${season}`
        + `&position=&team=&filterType=bip&min=1&csv=true`);
      for (const row of exp ?? []) {
        const id = String(csvCol(row, ["player_id"]) ?? "");
        put(id, "xera", csvCol(row, ["xera"]));
        put(id, "xwoba_against", csvCol(row, ["est_woba"]));
      }
      const rate = await getCsv(
        `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=pitcher&filter=&min=1`
        + `&selections=player_id,k_percent,bb_percent,barrel_batted_rate,hard_hit_percent,whiff_percent&csv=true`);
      for (const row of rate ?? []) {
        const id = String(csvCol(row, ["player_id"]) ?? "");
        put(id, "sc_k_pct", csvCol(row, ["k_percent"]));
        put(id, "sc_bb_pct", csvCol(row, ["bb_percent"]));
        put(id, "barrel_pct", csvCol(row, ["barrel_batted_rate", "barrel"]));
        put(id, "hardhit_pct", csvCol(row, ["hard_hit_percent", "hard_hit"]));
        put(id, "whiff_pct", csvCol(row, ["whiff_percent", "whiff"]));
      }
      const n = Object.keys(savant).length;
      savantStatus = n ? `read ${n} pitchers` : "returned no rows";
      path.statcast = {
        source: "baseballsavant.mlb.com", pitchers: n,
        expected_statistics: exp == null ? "request failed" : `${exp.length} rows`,
        custom_leaderboard: rate == null ? "request failed" : `${rate.length} rows`,
        note: "Read directly because pitcher_features is empty. Repairing ingest_mlb restores this from the owned table instead.",
      };
    }

    const MISSING_STATCAST = ["csw_pct", "pitch_mix", "velocity"];
    const NOTE = "Traditional line from the MLB Stats API; Statcast fields (xERA, xwOBA, barrel%, hard-hit%, "
      + "whiff%) read directly from Baseball Savant because pitcher_features is empty. CSW%, pitch mix and "
      + "velocity are in neither feed and are not approximated.";

    const offenseOf = (st: any, label: string, extraMissing: string[]) => {
      if (!st) return null;
      const pa = num(st.plateAppearances), ab = num(st.atBats);
      const avg = num(st.avg), slg = num(st.slg);
      return {
        split: label,
        avg, obp: num(st.obp), slg, ops: num(st.ops),
        iso: (slg != null && avg != null) ? +(slg - avg).toFixed(3) : null,
        k_pct: (pa && num(st.strikeOuts) != null) ? pct3(num(st.strikeOuts)! / pa) : null,
        bb_pct: (pa && num(st.baseOnBalls) != null) ? pct3(num(st.baseOnBalls)! / pa) : null,
        runs_per_game: num(st.gamesPlayed) ? +((num(st.runs) ?? 0) / num(st.gamesPlayed)!).toFixed(2) : null,
        home_runs: num(st.homeRuns), plate_appearances: pa, at_bats: ab,
        missing_fields: extraMissing,
      };
    };

    for (const s of starters) {
      const key = String(s.id);
      const line = lineById[key];
      const hand = handById[key] ?? null;

      /* ---- pitcher: true rate stats, plus FIP from owned counting stats ---- */
      if (line) {
        const ip = ipNum(line.inningsPitched);
        const bf = num(line.battersFaced);
        const so = num(line.strikeOuts), bb = num(line.baseOnBalls);
        const hr = num(line.homeRuns), hbp = num(line.hitBatsmen) ?? 0;
        const fip = (cFIP != null && ip && ip > 0 && hr != null && bb != null && so != null)
          ? +(((13 * hr + 3 * (bb + hbp) - 2 * so) / ip) + cFIP).toFixed(2) : null;
        const gbfb = num(line.groundOutsToAirouts);
        const sc = savant[String(s.id)] ?? null;
        const scMissing = MISSING_STATCAST.concat(sc ? [] : ["xera", "xwoba", "barrel_pct", "hardhit_pct", "whiff_pct"]);

        out.push(ev({
          source: "MLB Stats API", entity: s.name, field: "pitcher_quality", relevance: "pitching",
          value: {
            name: s.name, team: s.team, game: s.game, throws: hand,
            era: num(line.era), whip: num(line.whip), fip,
            fip_note: fip == null ? "FIP not computed — league constant unavailable"
              : `FIP from owned counting stats; league constant ${cFIP!.toFixed(3)} solved from this season's league totals, not assumed.`,
            k_pct: (bf && so != null) ? pct3(so / bf) : null,
            bb_pct: (bf && bb != null) ? pct3(bb / bf) : null,
            k_per_9: num(line.strikeoutsPer9Inn), bb_per_9: num(line.walksPer9Inn),
            k_bb_ratio: num(line.strikeoutWalkRatio),
            hr_per_9: (ip && hr != null) ? +((9 * hr) / ip).toFixed(2) : null,
            ground_to_air: gbfb,
            batted_ball_lean: gbfb == null ? null : gbfb >= 1.3 ? "ground-ball" : gbfb <= 0.85 ? "fly-ball" : "neutral",
            strike_pct: num(line.strikePercentage), pitches_per_inning: num(line.pitchesPerInning),
            innings: line.inningsPitched ?? null, innings_num: ip == null ? null : +ip.toFixed(1),
            batters_faced: bf, games_started: num(line.gamesStarted),
            /* Statcast, when Savant answered. These are the fields that separate
               "bad ERA" from "bad pitcher" — xERA strips the defence and the
               luck out, barrel% and hard-hit% say whether the contact allowed
               was genuinely dangerous. */
            xera: sc?.xera ?? null,
            xwoba_against: sc?.xwoba_against ?? null,
            barrel_pct: sc?.barrel_pct ?? null,
            hardhit_pct: sc?.hardhit_pct ?? null,
            whiff_pct: sc?.whiff_pct ?? null,
            statcast_k_pct: sc?.sc_k_pct ?? null,
            statcast_bb_pct: sc?.sc_bb_pct ?? null,
            era_vs_xera: (sc?.xera != null && num(line.era) != null)
              ? +(num(line.era)! - sc.xera).toFixed(2) : null,
            era_vs_xera_note: (sc?.xera != null && num(line.era) != null)
              ? "ERA minus xERA. Positive means the ERA is worse than the contact he allowed — the arm may be better than the line suggests, and vice versa."
              : null,
            statcast_source: sc ? "Baseball Savant (Statcast)" : null,
            missing_fields: scMissing,
          },
          status: "VERIFIED", freshness: "CURRENT", source_timestamp: new Date(now).toISOString(), note: NOTE,
        }));
      } else {
        out.push(unavailable("MLB Stats API", "pitcher_quality", `no season pitching line on file for ${s.name}`, s.name));
      }

      /* ---- workload: last three starts, pitch counts, days rest ---- */
      const log = (logById[key] ?? [])
        .filter((g: any) => num(g.stat?.gamesStarted) === 1)
        .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 3);
      if (log.length) {
        const lastDate = String(log[0].date).slice(0, 10);
        const rest = Math.round((Date.parse(day + "T00:00:00Z") - Date.parse(lastDate + "T00:00:00Z")) / 86400000);
        out.push(ev({
          source: "MLB Stats API", entity: s.name, field: "workload", relevance: "workload",
          value: {
            days_rest: Number.isFinite(rest) && rest >= 0 ? rest : null,
            last_start: lastDate,
            recent_starts: log.map((g: any) => ({
              date: String(g.date).slice(0, 10),
              innings: g.stat?.inningsPitched ?? null,
              pitches: num(g.stat?.numberOfPitches),
              earned_runs: num(g.stat?.earnedRuns),
              strikeouts: num(g.stat?.strikeOuts), walks: num(g.stat?.baseOnBalls),
            })),
          },
          status: "VERIFIED", freshness: "CURRENT", source_timestamp: lastDate,
          note: "Last three starts from the official game log. Short rest and a heavy previous pitch count are the two workload facts that move a start.",
        }));
      } else {
        out.push(unavailable("MLB Stats API", "workload", `no game log on file for ${s.name}`, s.name));
      }

      /* ---- opponent offense, on the split that ACTUALLY applies ----
         A right-hander does not face a lineup's overall line; he faces its
         numbers against right-handers. Using the overall split when the platoon
         one exists is a quiet accuracy loss on the single most matchup-relevant
         field there is. */
      const splitTable = hand === "L" ? hitVsL : hand === "R" ? hitVsR : null;
      const splitLabel = hand === "L" ? "vs LHP" : hand === "R" ? "vs RHP" : null;
      const platoon = splitTable ? offenseOf(splitTable[String(s.oppId)], splitLabel!, ["woba", "wrc_plus", "barrel_pct", "hardhit_pct"]) : null;
      const overall = offenseOf(hitAll[String(s.oppId)], "season overall", ["woba", "wrc_plus", "barrel_pct", "hardhit_pct"]);

      if (platoon || overall) {
        out.push(ev({
          source: "MLB Stats API", entity: s.name, field: "opponent_offense", relevance: "matchup",
          value: {
            opponent: s.opp, faces_hand: hand,
            applicable: platoon ?? overall,
            platoon_split: platoon, season_overall: overall,
            note: platoon
              ? `${s.opp}'s line ${splitLabel} is the one that applies to this start; the season overall line is included for contrast.`
              : "Handedness split unavailable for this team, so the season overall line is what applies.",
          },
          status: "VERIFIED", freshness: "CURRENT",
          note: "Season team hitting from the MLB Stats API. wOBA and wRC+ need park and league adjustments this feed does not publish, so they are not included.",
        }));
      } else {
        out.push(unavailable("MLB Stats API", "opponent_offense", `no team hitting line for ${s.opp}`, s.name));
      }

      out.push(ev({
        source: "MLB Stats API", entity: s.name, field: "probable_starter", relevance: "pitching",
        value: { name: s.name, team: s.team, game: s.game, opponent: s.opp, throws: hand },
        status: "PROBABLE", freshness: "CURRENT",
        note: "Probable, not confirmed.",
      }));
    }
    path.api_calls = apiCalls;
    path.statcast_status = savantStatus;
    return { ev: out, path };
  }

  /**
   * Every signal EdgeDesk holds on ONE game, across every market.
   *
   * The board scores each signal alone, which is why the most informative thing
   * in the data is invisible: what the markets on a single game say ABOUT EACH
   * OTHER. A moneyline edge with a run-line edge on the same team is a
   * different object from a moneyline edge whose spread points the other way.
   * Nothing new is computed here — this retrieves the rows so the relationship
   * can be read off owned prices.
   */
  async getCrossMarket(eventId: string): Promise<{ rows: any[]; ev: Evidence[] }> {
    const { rows, error } = await this.read(
      `signals?select=event_id,market,selection,point,best_dec,first_best_dec,sharp_fair,consensus_fair,`
      + `edge,first_edge,n_books,has_sharp,pin_dec,pin_opp_dec,home_team,away_team,last_seen_at`
      + `&event_id=eq.${encodeURIComponent(eventId)}&order=edge.desc.nullslast&limit=40`, "");
    if (error) return { rows: [], ev: [unavailable("signals", "cross_market", `read failed — ${error}`, eventId)] };
    if (rows.length < 2) {
      return { rows, ev: [unavailable("signals", "cross_market",
        "only one market carries a signal on this game — nothing to cross-check", eventId)] };
    }
    return {
      rows,
      ev: [ev({
        source: "signals", entity: eventId, field: "cross_market", relevance: "structure",
        value: rows.map((r) => ({
          market: r.market, selection: r.selection, point: r.point,
          price: r.best_dec, edge: r.edge, has_sharp: r.has_sharp, n_books: r.n_books,
        })),
        status: "VERIFIED",
        source_timestamp: rows[0]?.last_seen_at,
        freshness: freshnessOf("odds", rows[0]?.last_seen_at),
      })],
    };
  }

  /** Flagged/taxed arms and closer availability. Partial by nature — never full usage. */
  async getBullpen(teamIds: (number | string)[]): Promise<Evidence[]> {
    const ids = teamIds.filter((v) => v != null);
    if (!ids.length) return [unavailable("mlb_bullpen_taxed", "bullpen", "no team ids to look up")];
    const taxed = await this.read(
      `mlb_bullpen_taxed?select=team_id,full_name,flag,pitches_yesterday,severity&team_id=in.(${ids.join(",")})&order=severity.desc&limit=60`, "");
    const closers = await this.read(
      `mlb_bullpen_team?select=team_id,closer_name,closer_flag&team_id=in.(${ids.join(",")})&limit=30`, "");
    const out: Evidence[] = [];
    if (taxed.error) out.push(unavailable("mlb_bullpen_taxed", "bullpen", `read failed — ${taxed.error}`));
    for (const t of taxed.rows) {
      out.push(ev({
        source: "mlb_bullpen_taxed", entity: String(t.team_id), field: "bullpen_flag", relevance: "bullpen",
        value: { pitcher: t.full_name, flag: t.flag, pitches_yesterday: t.pitches_yesterday, severity: t.severity },
        status: "PARTIAL", freshness: freshnessOf("bullpen", Date.now()),
        note: "Flagged arms only — not full rest state for the whole pen.",
      }));
    }
    for (const c of closers.rows) {
      if (!c.closer_name) continue;
      out.push(ev({
        source: "mlb_bullpen_team", entity: String(c.team_id), field: "closer", relevance: "bullpen",
        value: { closer: c.closer_name, flag: c.closer_flag ?? "available" },
        status: "PARTIAL", freshness: freshnessOf("bullpen", Date.now()),
      }));
    }
    if (!out.length) out.push(unavailable("mlb_bullpen_taxed", "bullpen", "no flagged arms or closer rows on file for these teams"));
    return out;
  }

  /** Computed venue weather, which is fresher and richer than the card's copy. */
  async getWeather(eventIds: string[]): Promise<Evidence[]> {
    const ids = eventIds.filter(Boolean).slice(0, 25);
    if (!ids.length) return [unavailable("venue_weather", "weather", "no event ids to look up")];
    const { rows, error } = await this.read(
      `venue_weather?select=event_id,temp_f,wind_mph,wind_component_out,precip_prob,is_dome,fetched_at&event_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=40`, "");
    if (error) return [unavailable("venue_weather", "weather", `read failed — ${error}`)];
    if (!rows.length) return [unavailable("venue_weather", "weather", "no venue_weather rows for these games yet")];
    return rows.map((r) => ev({
      source: "venue_weather", entity: r.event_id, field: "weather", relevance: "variance",
      value: { temp_f: r.temp_f, wind_mph: r.wind_mph, wind_component_out: r.wind_component_out, precip_prob: r.precip_prob, dome: r.is_dome },
      status: "VERIFIED", source_timestamp: r.fetched_at, freshness: freshnessOf("weather", r.fetched_at),
    }));
  }

  /** Leaderboard-style player stats, for sports without a feature pipeline. */
  async getPlayerStats(league: string, player?: string): Promise<Evidence[]> {
    let q = `stats_players?select=team,player,position,stat_line,lead_cat,lead_val&league=eq.${encodeURIComponent(league)}&limit=200`;
    if (player) q += `&player=ilike.*${encodeURIComponent(player)}*`;
    const { rows, error } = await this.read(q, "player_stats");
    if (error || !rows.length) return [unavailable("stats_players", "player_stats", error ?? `no stats_players rows for ${league}${player ? " / " + player : ""}`)];
    return rows.slice(0, 40).map((r) => ev({
      source: "stats_players", entity: r.player, field: "player_stats", relevance: "stats",
      value: r, status: "VERIFIED", freshness: "RECENT",
      note: "Leaderboard line, not a full stat profile.",
    }));
  }

  /** Poll rankings, where a sport has them. */
  async getRankings(league: string): Promise<Evidence[]> {
    const { rows, error } = await this.read(
      `rankings_current?select=league,poll,rank,team,week,season&league=eq.${encodeURIComponent(league)}&order=rank.asc&limit=60`, "team_stats");
    if (error || !rows.length) return [unavailable("rankings_current", "rankings", error ?? `no rankings for ${league}`)];
    return rows.map((r) => ev({
      source: "rankings_current", entity: r.team, field: "rankings", relevance: "context",
      value: r, status: "VERIFIED", freshness: "RECENT",
    }));
  }

  /* ------------------------------------- research memory (new tables) ----- */

  /** The most recent stored research packet for a game, for the "what changed" diff. */
  async getLastSnapshot(eventId: string): Promise<Snapshot | null> {
    const { rows, error } = await this.read(
      `research_snapshots?select=event_id,version,taken_at,facts&event_id=eq.${encodeURIComponent(eventId)}&order=version.desc&limit=1`, "memory");
    if (error || !rows.length) return null;
    const r = rows[0];
    return {
      event_id: r.event_id,
      version: num(r.version) ?? 1,
      taken_at: Date.parse(r.taken_at) || Date.now(),
      facts: r.facts ?? {},
    };
  }

  async getResearchMemory(entities: string[], sport?: string | null): Promise<{
    facts: any[]; outcomes: any[]; patterns: any[]; prior: any[]; calibration: any[]; ev: Evidence[];
  }> {
    const out: Evidence[] = [];
    const ents = entities.filter(Boolean).slice(0, 8);
    const enc = (a: string[]) => a.map((s) => `"${s.replace(/"/g, '""')}"`).join(",");

    const facts = ents.length
      ? await this.read(`research_facts?select=entity,sport,fact_type,fact_value,source,source_timestamp,verification_status,confidence,valid_from,valid_until&entity=in.(${enc(ents)})&order=source_timestamp.desc&limit=60`, "memory")
      : { rows: [], error: null, cached: false };
    const outcomes = ents.length
      ? await this.read(`research_outcomes?select=entity,sport,market,thesis,price,fair_price,edge,closing_price,clv,result,thesis_survived,falsifier,what_happened,graded_at&entity=in.(${enc(ents)})&order=graded_at.desc&limit=40`, "memory")
      : { rows: [], error: null, cached: false };
    /* CONFIRMED only. A pattern that has not survived a chronological holdout,
       the family-wide FDR and the effect floor is a hypothesis, and quoting a
       hypothesis as a finding is the exact failure this whole layer exists to
       prevent. CANDIDATE and EXPIRED rows stay in the table for inspection;
       they never reach the model. */
    let patQ = "research_patterns?select=pattern_key,sport,description,sample_size,metric,metric_value,"
      + "confidence,status,effect,base_rate,n_discovery,n_holdout,lo_overall,lo_holdout,q_value,avg_clv,rationale,updated_at"
      + "&status=eq.CONFIRMED&order=sample_size.desc&limit=25";
    if (sport) patQ += `&sport=eq.${encodeURIComponent(sport)}`;
    const patterns = await this.read(patQ, "memory");

    /* Calibration is not a pattern and needs no confirmation — it is a direct
       measurement of whether the engine's own edge numbers land where they
       claim. It is the single most useful thing memory can offer. */
    const calibration = await this.read(
      "research_calibration?select=bucket,n,mean_edge_predicted,mean_clv_realised,beat_rate,beat_lo,shortfall,updated_at"
      + "&order=bucket.asc&limit=10", "memory");
    const prior = ents.length
      ? await this.read(`research_sessions?select=question,intent,conclusion,confidence,sport,entities,created_at&entities=ov.{${ents.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",")}}&order=created_at.desc&limit=10`, "memory")
      : { rows: [], error: null, cached: false };

    // Facts decay. A fact past its validity window informs research but is never
    // presented as current.
    const now = Date.now();
    for (const f of facts.rows) {
      const expired = f.valid_until && Date.parse(f.valid_until) < now;
      out.push(ev({
        source: "research_facts", entity: f.entity, field: `fact:${f.fact_type}`, value: f.fact_value,
        status: expired ? "HISTORICAL" : (f.verification_status === "VERIFIED" ? "VERIFIED" : "PARTIAL"),
        source_timestamp: f.source_timestamp, freshness: expired ? "HISTORICAL" : freshnessOf("memory", f.source_timestamp),
        relevance: "memory", note: expired ? "Past its validity window — historical context, not a current fact." : undefined,
      }));
    }
    for (const o of outcomes.rows) {
      out.push(ev({
        source: "research_outcomes", entity: o.entity, field: "prior_outcome", value: o,
        status: "HISTORICAL", source_timestamp: o.graded_at, freshness: "HISTORICAL", relevance: "history",
      }));
    }
    for (const p of patterns.rows) {
      out.push(ev({
        source: "research_patterns", entity: p.pattern_key, field: "pattern", value: p,
        status: "HISTORICAL", source_timestamp: p.updated_at, freshness: "HISTORICAL", relevance: "history",
        note: `Confirmed over ${p.sample_size} graded signals (${p.n_holdout ?? "?"} of them in a held-out later `
          + `window), ${p.effect != null ? (p.effect * 100).toFixed(1) + "pp over a base rate of "
            + ((p.base_rate ?? 0) * 100).toFixed(1) + "%" : "effect unrecorded"}, `
          + `q=${p.q_value ?? "?"} across every slice tested. This is a historical base rate over many games. `
          + `It is never evidence about one game and it never changes a price.`,
      }));
    }
    for (const c of calibration.rows) {
      out.push(ev({
        source: "research_calibration", entity: c.bucket, field: "calibration", value: c,
        status: "HISTORICAL", source_timestamp: c.updated_at, freshness: "HISTORICAL", relevance: "history",
        note: `Over ${c.n} graded signals in this band the engine predicted `
          + `${c.mean_edge_predicted != null ? (c.mean_edge_predicted * 100).toFixed(2) + "%" : "?"} and realised `
          + `${c.mean_clv_realised != null ? (c.mean_clv_realised * 100).toFixed(2) + "%" : "?"} CLV. `
          + `Use this to say how much a quoted edge has historically been worth. Do NOT restate the edge itself.`,
      }));
    }
    if (facts.error || outcomes.error || patterns.error || prior.error) {
      out.push(unavailable("research_memory", "memory",
        `memory tables not readable — ${facts.error ?? outcomes.error ?? patterns.error ?? prior.error}. Run the research-memory migration.`));
    }
    return { facts: facts.rows, outcomes: outcomes.rows, patterns: patterns.rows, prior: prior.rows,
             calibration: calibration.rows, ev: out };
  }
}

/* --------------------------------------- research completeness + coverage */

/* "Not on file" is the wrong answer when 33 of 40 games have the data. This
   turns the evidence set into an honest coverage report so the answer can say
   what IS usable, and name exactly what is missing and where. */
export interface Completeness {
  pct: number;
  available: string[];
  partial: string[];
  stale: string[];
  missing: string[];
  note: string;
}

/* The research dimensions a full answer would want, per sport module. */
export const DIMENSIONS: Record<string, string[]> = {
  baseball_mlb: [
    "signal", "sharp_reference", "probable_starter", "pitcher_quality",
    "opponent_offense", "bullpen_flag", "park", "weather", "workload", "team_form",
  ],
  americanfootball_nfl: [
    "signal", "sharp_reference", "game", "team_efficiency", "quarterback",
    "matchup_context", "nfl_player_production", "nfl_team_form",
  ],
  americanfootball_ncaaf: [
    "signal", "cfb_game", "cfb_sp_plus", "cfb_team_season_stat", "cfb_record",
    "cfb_ranking", "cfb_recruiting", "cfb_roster", "matchup_context",
  ],
  basketball_ncaab: [
    "signal", "game", "team_efficiency", "cbb_matchup_edge", "matchup_context",
    "cbb_player_production", "cbb_ranking",
  ],
  _core: ["signal", "sharp_reference", "clv_history"],
};

export function completeness(evidence: Evidence[], sportKey: string | null): Completeness {
  const dims = DIMENSIONS[sportKey ?? ""] ?? DIMENSIONS._core;
  const best: Record<string, EvStatus> = {};
  const rank: Record<string, number> = {
    VERIFIED: 5, PROBABLE: 4, PARTIAL: 3, HISTORICAL: 2, UNPROVEN: 2, STALE: 1, CONFLICT: 1, UNAVAILABLE: 0,
  };
  for (const e of evidence) {
    const cur = best[e.field];
    if (cur == null || (rank[e.status] ?? 0) > (rank[cur] ?? 0)) best[e.field] = e.status;
  }
  const available: string[] = [], partial: string[] = [], stale: string[] = [], missing: string[] = [];
  for (const d of dims) {
    const s = best[d];
    if (s == null || s === "UNAVAILABLE") missing.push(d);
    else if (s === "STALE") stale.push(d);
    else if (s === "PARTIAL" || s === "PROBABLE") partial.push(d);
    else available.push(d);
  }
  const score = (available.length + 0.6 * partial.length + 0.3 * stale.length) / Math.max(1, dims.length);
  return {
    pct: Math.round(score * 100), available, partial, stale, missing,
    note: missing.length
      ? `Missing: ${missing.join(", ")}. Report these as not available in EdgeDesk's current data.`
      : "All research dimensions for this sport returned data.",
  };
}

/* Per-entity coverage: how many games/starters actually carry a given field.
   This is what stops "pitcher quality is not on file" when most of the card
   has it and a handful of games do not. */
export function coverage(evidence: Evidence[], field: string, universe: string[]): {
  field: string; have: string[]; missing: string[]; have_n: number; total_n: number; summary: string;
} {
  const have = new Set<string>();
  for (const e of evidence) {
    if (e.field !== field) continue;
    if (e.status === "UNAVAILABLE") continue;
    if (e.entity) have.add(String(e.entity));
  }
  const haveKeys = new Set(Array.from(have).map((h) => personKey(h)));
  const missing = universe.filter((u) => !haveKeys.has(personKey(u)));
  const haveList = universe.filter((u) => haveKeys.has(personKey(u)));
  return {
    field, have: haveList, missing, have_n: haveList.length, total_n: universe.length,
    summary: universe.length
      ? `${field}: usable for ${haveList.length} of ${universe.length}. ${missing.length ? "Missing for: " + missing.slice(0, 12).join(", ") + (missing.length > 12 ? ` (+${missing.length - 12})` : "") : "Complete."}`
      : `${field}: no entities in scope.`,
  };
}

/* ========================================================================
   QUESTION REQUIREMENTS — what THIS question actually needs.

   Coverage used to answer "how many rows came back". That is a database
   statistic, not a research one: a 30-starter slate with complete weather and
   no pitching data scored well, and a slate missing only weather scored the
   same as one missing the starters. The requirement map makes coverage mean
   "how much of what this question NEEDS is on hand", which is the only version
   of the number that can gate an answer.

   `per` is the denominator:
     entity  — one per starter / team in scope
     slate   — the game universe itself
     focus   — the one signal under discussion
     global  — a single row anywhere is enough
   ======================================================================== */

export type ReqTier = "REQUIRED" | "IMPORTANT" | "OPTIONAL";
export interface Requirement {
  field: string;
  tier: ReqTier;
  per: "entity" | "slate" | "focus" | "global";
  /** Another field that satisfies this one when the preferred layer is absent. */
  satisfied_by?: string[];
  note?: string;
}

const R = (field: string, tier: ReqTier, per: Requirement["per"], extra: Partial<Requirement> = {}): Requirement =>
  ({ field, tier, per, ...extra });

export const REQUIREMENTS: Record<string, Requirement[]> = {
  best_pitchers: [
    R("game", "REQUIRED", "slate"),
    R("probable_starter", "REQUIRED", "entity"),
    R("pitcher_quality", "REQUIRED", "entity", {
      satisfied_by: ["season_pitching"],
      note: "The per-game layer is preferred; the season layer satisfies the requirement and must be labelled as season-long.",
    }),
    R("opponent_offense", "IMPORTANT", "entity", { satisfied_by: ["season_offense"] }),
    R("park", "IMPORTANT", "slate"),
    R("workload", "IMPORTANT", "entity"),
    R("team_form", "IMPORTANT", "slate"),
    R("bullpen_flag", "OPTIONAL", "global"),
    R("weather", "OPTIONAL", "slate"),
    R("signal", "OPTIONAL", "global"),
  ],
  worst_pitchers: [
    R("game", "REQUIRED", "slate"),
    R("probable_starter", "REQUIRED", "entity"),
    R("pitcher_quality", "REQUIRED", "entity", { satisfied_by: ["season_pitching"] }),
    R("opponent_offense", "IMPORTANT", "entity", { satisfied_by: ["season_offense"] }),
    R("park", "IMPORTANT", "slate"),
    R("workload", "IMPORTANT", "entity"),
    R("bullpen_flag", "IMPORTANT", "global"),
    R("weather", "OPTIONAL", "slate"),
    R("signal", "OPTIONAL", "global"),
  ],
  best_matchups: [
    R("game", "REQUIRED", "slate"),
    R("probable_starter", "REQUIRED", "entity"),
    R("pitcher_quality", "REQUIRED", "entity", { satisfied_by: ["season_pitching", "team_efficiency"] }),
    R("opponent_offense", "REQUIRED", "entity", { satisfied_by: ["season_offense", "team_efficiency"] }),
    R("park", "IMPORTANT", "slate"),
    R("weather", "IMPORTANT", "slate"),
    R("workload", "IMPORTANT", "entity"),
    R("signal", "IMPORTANT", "global"),
    R("bullpen_flag", "OPTIONAL", "global"),
  ],
  team_efficiency: [
    R("game", "REQUIRED", "slate"),
    R("team_efficiency", "REQUIRED", "entity"),
    R("matchup_context", "IMPORTANT", "slate"),
    R("quarterback", "IMPORTANT", "entity"),
    R("signal", "OPTIONAL", "global"),
    R("rankings", "OPTIONAL", "global"),
  ],
  best_bets: [
    R("signal", "REQUIRED", "global"),
    R("sharp_reference", "REQUIRED", "focus"),
    R("game", "IMPORTANT", "slate"),
    R("pitcher_quality", "IMPORTANT", "entity", { satisfied_by: ["season_pitching", "team_efficiency"] }),
    R("opponent_offense", "IMPORTANT", "entity", { satisfied_by: ["season_offense"] }),
    R("cross_market", "IMPORTANT", "focus"),
    R("clv_history", "IMPORTANT", "global"),
    R("line_movement", "OPTIONAL", "focus"),
    R("market_residual", "OPTIONAL", "focus"),
  ],
  what_changed: [
    R("signal", "REQUIRED", "focus"),
    R("snapshot_diff", "REQUIRED", "focus"),
    R("line_movement", "IMPORTANT", "focus"),
    R("closing_line", "IMPORTANT", "focus"),
    R("probable_starter", "IMPORTANT", "slate"),
    R("weather", "OPTIONAL", "slate"),
    R("market_residual", "OPTIONAL", "focus"),
  ],
  historical: [
    R("clv_history", "REQUIRED", "global"),
    R("prior_outcome", "IMPORTANT", "global"),
    R("pattern", "IMPORTANT", "global"),
    R("calibration", "IMPORTANT", "global"),
    R("signal", "OPTIONAL", "focus"),
  ],
  player_specific: [
    R("probable_starter", "REQUIRED", "entity"),
    R("pitcher_quality", "REQUIRED", "entity", { satisfied_by: ["season_pitching", "player_stats", "quarterback"] }),
    R("game", "REQUIRED", "slate"),
    R("workload", "IMPORTANT", "entity"),
    R("opponent_offense", "IMPORTANT", "entity", { satisfied_by: ["season_offense"] }),
  ],
  why: [
    R("signal", "REQUIRED", "focus"),
    R("sharp_reference", "REQUIRED", "focus"),
    R("pitcher_quality", "IMPORTANT", "entity", { satisfied_by: ["season_pitching", "team_efficiency"] }),
    R("cross_market", "OPTIONAL", "focus"),
    R("model", "OPTIONAL", "focus"),
  ],
  price: [
    R("signal", "REQUIRED", "focus"),
    R("sharp_reference", "IMPORTANT", "focus"),
    R("line_movement", "OPTIONAL", "focus"),
  ],
  _default: [
    R("signal", "REQUIRED", "global"),
    R("game", "IMPORTANT", "slate"),
    R("sharp_reference", "IMPORTANT", "focus"),
  ],
};

/* ========================================================================
   SPORT-SPECIFIC REQUIREMENTS.

   "BEST" MEANS DIFFERENT THINGS IN DIFFERENT SPORTS, and this is where that
   becomes machinery rather than a instruction in a prompt. The best NFL
   offence is an EPA-per-play and success-rate question. The best college
   basketball offence is an adjusted-efficiency question that is meaningless
   without pace. The best college football offence cannot be answered from
   per-play efficiency at all, because EdgeDesk does not ingest it, so it is a
   season-aggregate question read against SP+ and opponent quality.

   Three different evidence sets, three different denominators, three different
   honest answers. There is deliberately no universal "best offence" entry.
   ======================================================================== */
{
  const NFL_TEAM_CORE = (extra: Requirement[] = []): Requirement[] => [
    R("game", "REQUIRED", "slate"),
    R("team_efficiency", "REQUIRED", "entity", {
      note: "EPA per play and success rate are the ranking columns. Points per game is a pace artifact and is not a substitute.",
    }),
    R("matchup_context", "IMPORTANT", "slate"),
    ...extra,
    R("nfl_player_production", "OPTIONAL", "global"),
    R("nfl_team_form", "OPTIONAL", "global"),
    R("signal", "OPTIONAL", "global"),
  ];
  const NFL_QB_CORE: Requirement[] = [
    R("game", "REQUIRED", "slate"),
    R("quarterback", "REQUIRED", "entity", {
      note: "The quarterback is the largest single input in the sport. An unconfirmed or backup starter makes every conclusion provisional.",
    }),
    R("team_efficiency", "IMPORTANT", "entity"),
    R("matchup_context", "OPTIONAL", "slate"),
    R("nfl_player_production", "OPTIONAL", "global"),
    R("signal", "OPTIONAL", "global"),
  ];

  REQUIREMENTS.nfl_best_offenses = NFL_TEAM_CORE([R("quarterback", "IMPORTANT", "entity")]);
  REQUIREMENTS.nfl_worst_offenses = REQUIREMENTS.nfl_best_offenses;
  REQUIREMENTS.nfl_best_defenses = NFL_TEAM_CORE([
    R("quarterback", "OPTIONAL", "entity", { note: "Relevant as the opposing input, not as the subject." }),
  ]);
  REQUIREMENTS.nfl_worst_defenses = REQUIREMENTS.nfl_best_defenses;
  REQUIREMENTS.nfl_best_quarterbacks = NFL_QB_CORE;
  REQUIREMENTS.nfl_worst_quarterbacks = NFL_QB_CORE;
  REQUIREMENTS.nfl_best_matchups = [
    R("game", "REQUIRED", "slate"),
    R("team_efficiency", "REQUIRED", "entity"),
    R("quarterback", "REQUIRED", "entity"),
    R("matchup_context", "IMPORTANT", "slate"),
    R("nfl_injury_report", "IMPORTANT", "global", {
      note: "Deliberately counted as a real gap rather than declared inapplicable: injuries matter enormously in the NFL, EdgeDesk simply does not ingest them, and an unstated absence reads as a considered-and-dismissed factor.",
    }),
    R("signal", "IMPORTANT", "global"),
    R("weather", "OPTIONAL", "slate"),
  ];
  REQUIREMENTS.nfl_worst_matchups = REQUIREMENTS.nfl_best_matchups;
  REQUIREMENTS.nfl_team_comparison = NFL_TEAM_CORE([R("quarterback", "REQUIRED", "entity")]);
  REQUIREMENTS.nfl_injury_impact = [
    R("quarterback", "REQUIRED", "entity"),
    R("nfl_injury_report", "REQUIRED", "global", {
      note: "There is no NFL injury table in EdgeDesk. This requirement is expected to fail, and the failure IS the answer.",
    }),
    R("team_efficiency", "IMPORTANT", "entity"),
    R("signal", "OPTIONAL", "global"),
  ];
  REQUIREMENTS.nfl_what_changed = [
    R("signal", "REQUIRED", "focus"),
    R("snapshot_diff", "REQUIRED", "focus"),
    R("quarterback", "IMPORTANT", "entity", {
      note: "In football the thing that moved the line is usually the quarterback. Check it before attributing movement to the market.",
    }),
    R("line_movement", "IMPORTANT", "focus"),
    R("closing_line", "OPTIONAL", "focus"),
  ];
  REQUIREMENTS.nfl_historical_matchup = [
    R("clv_history", "REQUIRED", "global"),
    R("prior_outcome", "IMPORTANT", "global"),
    R("pattern", "IMPORTANT", "global"),
    R("team_efficiency", "OPTIONAL", "entity"),
  ];
  REQUIREMENTS.nfl_betting_candidate = [
    R("signal", "REQUIRED", "global"),
    R("sharp_reference", "REQUIRED", "focus"),
    R("team_efficiency", "IMPORTANT", "entity"),
    R("quarterback", "IMPORTANT", "entity"),
    R("matchup_context", "OPTIONAL", "slate"),
    R("clv_history", "IMPORTANT", "global"),
  ];

  /* ---- COLLEGE FOOTBALL. Note what is NOT required: per-play efficiency.
     Requiring a field the project does not ingest would put every CFB question
     permanently in INSUFFICIENT and teach the analyst to ignore the gate. The
     gap is declared per capability instead, and the requirement set is built
     from what actually exists. */
  const CFB_CORE = (extra: Requirement[] = []): Requirement[] => [
    R("cfb_identity", "REQUIRED", "global", {
      satisfied_by: ["cfb_sp_plus", "cfb_record", "cfb_team_season_stat"],
      note: "College identity must be established before any statistic is attributed. Provided by cfb.teams.",
    }),
    R("cfb_team_season_stat", "REQUIRED", "entity", {
      satisfied_by: ["cfb_sp_plus"],
      note: "Season aggregates. If only SP+ is present, say the read is opponent-adjusted rating rather than production.",
    }),
    R("cfb_game", "IMPORTANT", "slate"),
    R("cfb_sp_plus", "IMPORTANT", "entity", {
      note: "EXTERNAL MODEL. The opponent-quality axis EdgeDesk actually has for college football.",
    }),
    R("cfb_record", "IMPORTANT", "entity"),
    ...extra,
    R("cfb_ranking", "OPTIONAL", "global"),
    R("signal", "OPTIONAL", "global"),
  ];
  REQUIREMENTS.cfb_best_offenses = CFB_CORE([
    R("cfb_returning_production", "IMPORTANT", "global", {
      note: "Returning production is the strongest year-over-year predictor in college football. Probed; reported honestly if absent.",
    }),
    R("cfb_recruiting", "OPTIONAL", "global"),
    R("cfb_portal", "OPTIONAL", "global"),
  ]);
  REQUIREMENTS.cfb_worst_offenses = REQUIREMENTS.cfb_best_offenses;
  REQUIREMENTS.cfb_best_defenses = CFB_CORE();
  REQUIREMENTS.cfb_best_teams = CFB_CORE([R("cfb_elo", "OPTIONAL", "global")]);
  REQUIREMENTS.cfb_best_matchups = CFB_CORE([
    R("cfb_game", "REQUIRED", "slate"),
    R("matchup_context", "OPTIONAL", "slate"),
    R("cfb_elo", "OPTIONAL", "global"),
  ]);
  REQUIREMENTS.cfb_best_quarterbacks = [
    R("cfb_identity", "REQUIRED", "global"),
    R("cfb_roster", "REQUIRED", "entity", {
      note: "A roster is not a depth chart. EdgeDesk has no college passing-efficiency layer, so a quarterback question is answerable only at roster and season-aggregate level — say so.",
    }),
    R("cfb_team_season_stat", "IMPORTANT", "entity"),
    R("cfb_sp_plus", "IMPORTANT", "entity"),
  ];
  REQUIREMENTS.cfb_roster = [
    R("cfb_identity", "REQUIRED", "global"),
    R("cfb_roster", "REQUIRED", "entity"),
    R("cfb_record", "OPTIONAL", "entity"),
  ];
  REQUIREMENTS.cfb_returning_production = [
    R("cfb_identity", "REQUIRED", "global"),
    R("cfb_returning_production", "REQUIRED", "global", {
      note: "Probed against cfb.returning_production. If cfb_ingest does not write it, the honest answer names the table and the CFBD endpoint that would fill it.",
    }),
    R("cfb_team_season_stat", "IMPORTANT", "entity"),
    R("cfb_recruiting", "OPTIONAL", "global"),
  ];
  REQUIREMENTS.cfb_portal = [
    R("cfb_identity", "REQUIRED", "global"),
    R("cfb_portal", "REQUIRED", "global"),
    R("cfb_recruiting", "IMPORTANT", "global"),
  ];
  REQUIREMENTS.cfb_recruiting = [
    R("cfb_identity", "REQUIRED", "global"),
    R("cfb_recruiting", "REQUIRED", "entity"),
    R("cfb_record", "OPTIONAL", "entity"),
  ];
  REQUIREMENTS.cfb_sp_plus = [
    R("cfb_identity", "REQUIRED", "global"),
    R("cfb_sp_plus", "REQUIRED", "entity"),
    R("cfb_record", "IMPORTANT", "entity"),
    R("cfb_ranking", "OPTIONAL", "global"),
  ];
  REQUIREMENTS.cfb_betting_candidate = [
    R("signal", "REQUIRED", "global"),
    R("sharp_reference", "REQUIRED", "focus"),
    R("cfb_sp_plus", "IMPORTANT", "entity"),
    R("cfb_team_season_stat", "IMPORTANT", "entity"),
    R("clv_history", "IMPORTANT", "global"),
    R("cfb_book_line", "OPTIONAL", "global"),
  ];
  REQUIREMENTS.cfb_what_changed = REQUIREMENTS.what_changed;

  /* ---- COLLEGE BASKETBALL. Tempo-free or nothing. */
  const CBB_CORE = (extra: Requirement[] = []): Requirement[] => [
    R("game", "REQUIRED", "slate"),
    R("team_efficiency", "REQUIRED", "entity", {
      note: "adj_o, adj_d and adj_em. adj_d is points ALLOWED per 100 possessions, so lower is better — the sign is opposite to every other efficiency column.",
    }),
    R("matchup_context", "IMPORTANT", "slate"),
    ...extra,
    R("cbb_player_production", "OPTIONAL", "global"),
    R("cbb_ranking", "OPTIONAL", "global"),
    R("signal", "OPTIONAL", "global"),
  ];
  REQUIREMENTS.cbb_best_offenses = CBB_CORE();
  REQUIREMENTS.cbb_worst_offenses = CBB_CORE();
  REQUIREMENTS.cbb_best_defenses = CBB_CORE();
  REQUIREMENTS.cbb_best_teams = CBB_CORE();
  REQUIREMENTS.cbb_best_matchups = CBB_CORE([R("cbb_matchup_edge", "REQUIRED", "slate")]);
  REQUIREMENTS.cbb_pace_matchup = CBB_CORE([
    R("cbb_matchup_edge", "REQUIRED", "slate", {
      note: "Expected possessions come from BOTH adjusted tempos together, never from one side's.",
    }),
  ]);
  REQUIREMENTS.cbb_shooting_matchup = CBB_CORE([R("cbb_matchup_edge", "REQUIRED", "slate")]);
  REQUIREMENTS.cbb_rebounding_matchup = CBB_CORE([R("cbb_matchup_edge", "REQUIRED", "slate")]);
  REQUIREMENTS.cbb_tournament = CBB_CORE([
    R("cbb_matchup_edge", "IMPORTANT", "slate"),
    R("cbb_availability", "IMPORTANT", "global"),
  ]);
  REQUIREMENTS.cbb_best_players = [
    R("cbb_player_production", "REQUIRED", "global", {
      note: "EdgeDesk carries a leaderboard line only. Minutes, usage rate and lineup context do not exist anywhere in the system.",
    }),
    R("team_efficiency", "IMPORTANT", "entity"),
    R("game", "IMPORTANT", "slate"),
  ];
  REQUIREMENTS.cbb_availability = [
    R("cbb_availability", "REQUIRED", "global", {
      note: "Expected to fail. EdgeDesk ingests no college basketball availability data, and saying so IS the answer to an availability question.",
    }),
    R("team_efficiency", "IMPORTANT", "entity"),
    R("game", "IMPORTANT", "slate"),
  ];
  REQUIREMENTS.cbb_betting_candidate = [
    R("signal", "REQUIRED", "global"),
    R("sharp_reference", "REQUIRED", "focus"),
    R("team_efficiency", "IMPORTANT", "entity"),
    R("cbb_matchup_edge", "IMPORTANT", "slate"),
    R("clv_history", "IMPORTANT", "global"),
  ];
  REQUIREMENTS.cbb_historical = REQUIREMENTS.historical;
  REQUIREMENTS.cbb_what_changed = REQUIREMENTS.what_changed;
}

/* Player questions come in under many intents. The presence of a resolved
   player changes what the question needs, so the map is selected accordingly. */
export function requirementsFor(intent: string, hasPlayer = false): Requirement[] {
  if (hasPlayer && REQUIREMENTS.player_specific && !REQUIREMENTS[intent]) return REQUIREMENTS.player_specific;
  return REQUIREMENTS[intent] ?? REQUIREMENTS._default;
}

/* ========================================================================
   SPORT CAPABILITY CONTRACT — what each sport ACTUALLY has.

   The research architecture is sport-agnostic, which is exactly why this has
   to be declared: a generic pipeline will happily report a missing field for a
   sport that was never going to have one, and "EdgeDesk has no bullpen data for
   this UFC card" is noise, not honesty. A capability that is false means the
   requirement is dropped rather than counted as a gap.
   ======================================================================== */
export const SPORT_CAPABILITIES: Record<string, Record<string, boolean>> = {
  baseball_mlb: {
    schedule: true, starters: true, pitching_season: true, pitching_matchup: true,
    offense: true, bullpen: true, park: true, weather: true, market: true,
    team_efficiency: false, quarterback: false,
  },
  americanfootball_nfl: {
    schedule: true, team_efficiency: true, quarterback: true, matchup_context: true,
    market: true, weather: true,
    starters: false, pitching_season: false, pitching_matchup: false, offense: false,
    bullpen: false, park: false,
    /* r3 NFL layers. nfl_injury_report is DELIBERATELY absent from this map so
       sportSupports() returns true for it: the NFL obviously has injuries, and
       declaring the field "not applicable to this sport" would be a lie that
       hides the single most important gap in the module. It is a real,
       counted, reported gap. */
    nfl_player_production: true, nfl_team_form: true, nfl_special_teams: false,
  },
  americanfootball_ncaaf: {
    /* team_efficiency stays FALSE — per-play EPA and success rate genuinely are
       not ingested for college football. Everything else here is new and real:
       the cfb schema has been carrying SP+, records, season stats, rosters,
       recruiting, rankings and the full schedule the whole time. */
    schedule: true, team_efficiency: false, matchup_context: true, rankings: true, market: true,
    quarterback: false, starters: false, pitching_season: false, pitching_matchup: false,
    offense: false, bullpen: false, park: false, weather: false,
    cfb_identity: true, cfb_schedule: true, cfb_sp_plus: true, cfb_elo: true,
    cfb_team_season_stat: true, cfb_record: true, cfb_ranking: true,
    cfb_recruiting: true, cfb_roster: true, cfb_book_line: true,
    /* Probed rather than promised — the read is attempted and reported. */
    cfb_returning_production: true, cfb_portal: true,
  },
  basketball_ncaab: {
    schedule: true, team_efficiency: true, matchup_context: true, market: true,
    quarterback: false, starters: false, pitching_season: false, pitching_matchup: false,
    offense: false, bullpen: false, park: false, weather: false,
    cbb_matchup_edge: true, cbb_player_production: true, cbb_ranking: true,
    /* Same reasoning as the NFL injury report: college basketball absolutely
       has availability, EdgeDesk just has no source for it. A real gap. */
    cbb_availability: true,
  },
  _core: { market: true, schedule: false },
};

const FIELD_CAPABILITY: Record<string, string> = {
  game: "schedule", probable_starter: "starters", pitcher_quality: "pitching_matchup",
  season_pitching: "pitching_season", opponent_offense: "offense", season_offense: "offense",
  bullpen_flag: "bullpen", park: "park", weather: "weather", signal: "market",
  sharp_reference: "market", team_efficiency: "team_efficiency", quarterback: "quarterback",
  matchup_context: "matchup_context", rankings: "rankings",
  /* r3 */
  nfl_player_production: "nfl_player_production", nfl_team_form: "nfl_team_form",
  nfl_special_teams: "nfl_special_teams",
  cfb_identity: "cfb_identity", cfb_game: "cfb_schedule", cfb_sp_plus: "cfb_sp_plus",
  cfb_elo: "cfb_elo", cfb_team_season_stat: "cfb_team_season_stat", cfb_record: "cfb_record",
  cfb_ranking: "cfb_ranking", cfb_recruiting: "cfb_recruiting", cfb_roster: "cfb_roster",
  cfb_book_line: "cfb_book_line", cfb_returning_production: "cfb_returning_production",
  cfb_portal: "cfb_portal",
  cbb_matchup_edge: "cbb_matchup_edge", cbb_player_production: "cbb_player_production",
  cbb_ranking: "cbb_ranking", cbb_availability: "cbb_availability",
};

export function sportSupports(sportKey: string | null, field: string): boolean {
  const caps = SPORT_CAPABILITIES[sportKey ?? ""] ?? SPORT_CAPABILITIES._core;
  const need = FIELD_CAPABILITY[field];
  if (!need) return true;                 // not a sport-gated field
  return caps[need] !== false;
}

/* ========================================================================
   SLATE SCOPE — the expected universe, established BEFORE anything is counted.

   The denominator has to come from the schedule, never from the rows that came
   back. Counting retrieved rows against retrieved rows always reports 100%,
   which is how a half-ingested card looked complete.
   ======================================================================== */
export interface SlateScope {
  sport: string | null;
  date: string;
  timezone: string;
  expected_games: number;
  retrieved_games: number;
  live_games: number;
  scheduled_games: number;
  final_games: number;
  postponed_games: number;
  missing_games: number;
  dropped_final: number;
  complete: boolean;
  note: string;
}

export function buildSlateScope(sport: string | null, allRows: any[], liveRows: any[]): SlateScope {
  const statusOf = (r: any) => String(r?.status ?? "").toLowerCase();
  const today = etDay(0);
  const onToday = allRows.filter((r) => String(r?.game_date ?? "").slice(0, 10) === today);
  const universe = onToday.length ? onToday : allRows;

  const final = universe.filter((r) => statusOf(r) === "final").length;
  const postponed = universe.filter((r) => /postpon|suspend|cancel/.test(statusOf(r))).length;
  const scheduled = universe.length - final - postponed;
  const expected = universe.length;
  const live = liveRows.filter((r) => String(r?.game_date ?? "").slice(0, 10) === today).length
    || liveRows.length;

  return {
    sport, date: today, timezone: "America/New_York",
    expected_games: expected,
    retrieved_games: allRows.length,
    live_games: live,
    scheduled_games: scheduled,
    final_games: final,
    postponed_games: postponed,
    // A game on the card that is neither final, postponed, nor carried through.
    missing_games: Math.max(0, scheduled - live),
    dropped_final: allRows.length - liveRows.length,
    complete: expected > 0 && live >= scheduled,
    note: expected === 0
      ? "No games are carded for this date — the schedule sync has not written this slate."
      : `${live} of ${scheduled} scheduled games on ${today} are in scope; ${final} already final.`,
  };
}

/* ========================================================================
   SEMANTIC COVERAGE + THE COMPLETENESS GATE
   ======================================================================== */

export interface CoverageCell { available: number; expected: number; missing: string[]; via?: string }
export interface SemanticCoverage {
  question_type: string;
  overall: number;
  required: Record<string, CoverageCell>;
  important: Record<string, CoverageCell>;
  optional: Record<string, CoverageCell>;
  critical_gaps: string[];
  important_gaps: string[];
  optional_gaps: string[];
  not_applicable: string[];
}

export interface CoverageUniverse {
  entities: string[];        // starters / teams in scope
  games: string[];
  hasFocus: boolean;
  expectedGames: number;
}

export function semanticCoverage(
  intent: string, evidence: Evidence[], reqs: Requirement[],
  uni: CoverageUniverse, sportKey: string | null,
): SemanticCoverage {
  const usable = evidence.filter((e) => e.status !== "UNAVAILABLE");
  const haveByField = new Map<string, Set<string>>();
  const anyByField = new Set<string>();
  for (const e of usable) {
    anyByField.add(e.field);
    if (!e.entity) continue;
    const s = haveByField.get(e.field) ?? new Set<string>();
    s.add(personKey(String(e.entity)));
    haveByField.set(e.field, s);
  }

  const cell = (r: Requirement): CoverageCell => {
    // A satisfying alternate layer counts, and is NAMED so nothing is silent.
    const candidates = [r.field, ...(r.satisfied_by ?? [])];
    if (r.per === "entity") {
      const expected = uni.entities.length;
      let best: CoverageCell = { available: 0, expected, missing: uni.entities.slice() };
      for (const f of candidates) {
        const have = haveByField.get(f);
        // A slate-wide roll-up row (season layer) covers every entity it lists.
        const rollup = usable.some((e) => e.field === f && !uni.entities.length);
        let hit: string[];
        if (have) hit = uni.entities.filter((n) => have.has(personKey(n)));
        else hit = [];
        if (!hit.length && anyByField.has(f) && rollup) hit = uni.entities.slice();
        // season_pitching is one row carrying many pitchers — expand it.
        if (!hit.length && anyByField.has(f)) {
          const names = new Set<string>();
          for (const e of usable) {
            const v: any = e.value;
            if (e.field === f && Array.isArray(v?.rows)) for (const row of v.rows) if (row?.name) names.add(personKey(String(row.name)));
          }
          if (names.size) hit = uni.entities.filter((n) => names.has(personKey(n)));
        }
        if (hit.length > best.available) {
          best = { available: hit.length, expected, missing: uni.entities.filter((n) => !hit.includes(n)),
                   via: f === r.field ? undefined : f };
        }
      }
      return best;
    }
    if (r.per === "slate") {
      const expected = Math.max(uni.expectedGames, uni.games.length);
      for (const f of candidates) {
        const have = haveByField.get(f);
        if (have) {
          const hit = uni.games.filter((g) => have.has(personKey(g)));
          const n = hit.length || (anyByField.has(f) ? Math.min(expected, uni.games.length) : 0);
          return { available: n, expected, missing: uni.games.filter((g) => !hit.includes(g)).slice(0, 12),
                   via: f === r.field ? undefined : f };
        }
        if (anyByField.has(f)) return { available: expected, expected, missing: [], via: f === r.field ? undefined : f };
      }
      return { available: 0, expected, missing: uni.games.slice(0, 12) };
    }
    // focus / global — one is enough
    const expected = r.per === "focus" ? (uni.hasFocus ? 1 : 0) : 1;
    for (const f of candidates) {
      if (anyByField.has(f)) return { available: expected, expected, missing: [], via: f === r.field ? undefined : f };
    }
    return { available: 0, expected, missing: [r.field] };
  };

  const required: Record<string, CoverageCell> = {};
  const important: Record<string, CoverageCell> = {};
  const optional: Record<string, CoverageCell> = {};
  const critical_gaps: string[] = [], important_gaps: string[] = [], optional_gaps: string[] = [];
  const not_applicable: string[] = [];

  for (const r of reqs) {
    /* A sport that does not HAVE a field cannot be missing it. Counting CFB's
       absent EPA as a gap on every question buries the gaps that are real. */
    if (!sportSupports(sportKey, r.field)) { not_applicable.push(r.field); continue; }
    const c = cell(r);
    if (c.expected === 0) { not_applicable.push(r.field); continue; }
    const bucket = r.tier === "REQUIRED" ? required : r.tier === "IMPORTANT" ? important : optional;
    bucket[r.field] = c;
    const short = c.available < c.expected;
    if (short) {
      const label = `${r.field} (${c.available}/${c.expected})`;
      if (r.tier === "REQUIRED") critical_gaps.push(label);
      else if (r.tier === "IMPORTANT") important_gaps.push(label);
      else optional_gaps.push(label);
    }
  }

  const ratio = (b: Record<string, CoverageCell>) => {
    const cells = Object.values(b);
    if (!cells.length) return 1;
    const exp = cells.reduce((a, c) => a + c.expected, 0);
    const got = cells.reduce((a, c) => a + Math.min(c.available, c.expected), 0);
    return exp ? got / exp : 1;
  };
  /* Weighted toward REQUIRED so optional gaps cannot drag a good packet down —
     and the gate below reads critical_gaps directly, so a high overall can
     never hide a missing required field either. */
  const overall = 0.70 * ratio(required) + 0.25 * ratio(important) + 0.05 * ratio(optional);

  return {
    question_type: intent, overall: +overall.toFixed(3),
    required, important, optional,
    critical_gaps, important_gaps, optional_gaps, not_applicable,
  };
}

export type CompletenessState = "COMPLETE" | "PARTIAL" | "INSUFFICIENT" | "INVALID";

export interface ResearchCompleteness {
  state: CompletenessState;
  reason: string;
  required_fields: string[];
  available_fields: string[];
  missing_fields: string[];
  critical_gaps: string[];
  safe_to_rank: boolean;
  safe_to_compare: boolean;
  safe_to_make_betting_interpretation: boolean;
}

/**
 * The data-delivery state. NOT a betting score, and deliberately not a number:
 * the analyst needs a decision it can obey, not a percentage it has to
 * interpret. Integrity contamination outranks coverage — clean-but-thin data
 * can still be reasoned over honestly, badly-joined data cannot be reasoned
 * over at all.
 */
export function completenessGate(
  cov: SemanticCoverage, integrity: Integrity, scope: SlateScope | null,
): ResearchCompleteness {
  const required_fields = Object.keys(cov.required);
  const available_fields = required_fields.filter((f) => cov.required[f].available >= cov.required[f].expected);
  const missing_fields = required_fields.filter((f) => cov.required[f].available < cov.required[f].expected);

  const reqRatio = required_fields.length
    ? required_fields.reduce((a, f) => a + Math.min(1, cov.required[f].available / Math.max(1, cov.required[f].expected)), 0) / required_fields.length
    : 1;
  const emptyRequired = required_fields.filter((f) => cov.required[f].available === 0);

  let state: CompletenessState;
  let reason: string;

  if (integrity.verdict === "FAIL") {
    state = "INVALID";
    reason = `Evidence integrity failed (${integrity.summary}). The data cannot be safely attributed, so no ranking or comparison is permitted regardless of how much of it there is.`;
  } else if (emptyRequired.length) {
    state = "INSUFFICIENT";
    reason = `Required evidence is entirely absent: ${emptyRequired.join(", ")}. `
      + `Answer only what the present evidence supports and name what is missing.`;
  } else if (reqRatio < 0.75) {
    state = "INSUFFICIENT";
    reason = `Only ${Math.round(reqRatio * 100)}% of the required evidence for a "${cov.question_type}" question was retrieved `
      + `(${cov.critical_gaps.join(", ")}). That is too thin to rank responsibly.`;
  } else if (cov.critical_gaps.length || cov.important_gaps.length || (scope && !scope.complete)) {
    state = "PARTIAL";
    const bits = [
      ...cov.critical_gaps.map((g) => `required ${g}`),
      ...cov.important_gaps.map((g) => `important ${g}`),
    ];
    if (scope && !scope.complete) bits.push(`slate incomplete (${scope.live_games}/${scope.scheduled_games} scheduled games in scope)`);
    reason = `Answerable, with material gaps: ${bits.join("; ")}. Use what is present and name the gaps explicitly.`;
  } else {
    state = "COMPLETE";
    reason = "All required and important evidence for this question was retrieved and passed integrity.";
  }

  const usable = state === "COMPLETE" || state === "PARTIAL";
  return {
    state, reason, required_fields, available_fields, missing_fields,
    critical_gaps: cov.critical_gaps,
    safe_to_rank: usable,
    safe_to_compare: usable,
    safe_to_make_betting_interpretation: usable
      && (cov.required.signal?.available ?? cov.important.signal?.available ?? cov.optional.signal?.available ?? 0) > 0,
  };
}

/* ========================================================================
   EVIDENCE HIERARCHY — analytical priority, NOT a betting weight.
   ======================================================================== */
export function evidenceTier(e: Evidence): { tier: number; label: string } {
  if (e.status === "UNAVAILABLE") return { tier: 99, label: "UNAVAILABLE — not evidence" };
  const stale = e.status === "STALE" || e.status === "PARTIAL" || e.status === "PROBABLE" || e.freshness === "STALE";
  if (stale) return { tier: 6, label: "T6 partial/probable/stale" };
  if (e.status === "HISTORICAL" || e.layer === "historical") {
    return { tier: 4, label: "T4 EdgeDesk historical" };
  }
  if (e.layer === "matchup") return { tier: 1, label: "T1 current matchup-specific" };
  if (e.layer === "season") return { tier: 2, label: "T2 current season-level" };
  if (e.layer === "market") return { tier: 3, label: "T3 current market" };
  /* An external rating sits BELOW EdgeDesk's own current measurements and above
     bare context. It is genuine evidence — SP+ and ELO are good at what they
     do — and it is somebody else's model, which is exactly what this tier
     exists to keep visible. It can never be quoted as an EdgeDesk number. */
  if (e.layer === "external_model") return { tier: 4.5, label: "T4.5 EXTERNAL MODEL — evidence, never an EdgeDesk number" };
  if (e.layer === "context") return { tier: 5, label: "T5 contextual" };
  return { tier: 5, label: "T5 contextual" };
}

/* ========================================================================
   HISTORICAL LEAKAGE GUARD.

   Answering "as of last Tuesday" with information that did not exist until
   Thursday produces a research record that looks brilliant and proves nothing.
   Worse, it poisons the learning loop: an outcome scored against contaminated
   research teaches the system that its research was better than it was.

   Every item carries information_timestamp (when it became knowable) alongside
   date (what it is about). This drops anything whose information post-dates
   the as-of moment, and RECORDS what it dropped — a silent filter would be its
   own kind of dishonesty.
   ======================================================================== */
export interface LeakageReport {
  as_of: string | null;
  checked: number;
  excluded: number;
  /** Items with no publication timestamp. Kept, but unprovable either way. */
  undated: number;
  excluded_items: { id?: string; field: string; entity: string | null; information_timestamp: string | null }[];
  note: string;
}

export function enforceNoLeakage(
  evidence: Evidence[], asOfISO: string | null,
): { evidence: Evidence[]; report: LeakageReport } {
  if (!asOfISO) {
    return {
      evidence,
      report: { as_of: null, checked: evidence.length, excluded: 0, undated: 0, excluded_items: [],
        note: "Not a historical question — every retrieved fact is current by construction, so no cutoff applies." },
    };
  }
  const cut = Date.parse(asOfISO.length === 10 ? asOfISO + "T23:59:59Z" : asOfISO);
  if (!Number.isFinite(cut)) {
    return {
      evidence,
      report: { as_of: asOfISO, checked: evidence.length, excluded: 0, undated: 0, excluded_items: [],
        note: `The as-of date "${asOfISO}" could not be parsed, so NO cutoff was applied. Treat any historical claim as unverified rather than assuming it was filtered.` },
    };
  }
  const kept: Evidence[] = [];
  const dropped: LeakageReport["excluded_items"] = [];
  let undated = 0;
  for (const e of evidence) {
    const known = Date.parse(String(e.information_timestamp ?? e.source_timestamp ?? ""));
    /* An item with NO publication timestamp cannot be SHOWN to postdate the
       cutoff, and it cannot be shown to predate it either. It is KEPT and
       COUNTED — dropping every undated row would empty the packet on a
       technicality, and dropping it silently would be its own dishonesty. The
       report names the count so the caveat travels with the answer. */
    if (!Number.isFinite(known)) { undated++; kept.push(e); continue; }
    if (known <= cut) { kept.push(e); continue; }
    dropped.push({ id: e.id, field: e.field, entity: e.entity,
      information_timestamp: e.information_timestamp ?? e.source_timestamp ?? null });
  }
  const caveat = undated
    ? ` ${undated} item${undated === 1 ? " carries" : "s carry"} no publication timestamp, so ${undated === 1 ? "it" : "they"} `
      + `cannot be proven to predate ${asOfISO} — treat any claim resting on ${undated === 1 ? "it" : "them"} as provisional.`
    : "";
  return {
    evidence: kept,
    report: {
      as_of: asOfISO, checked: evidence.length, excluded: dropped.length, undated,
      excluded_items: dropped.slice(0, 20),
      note: (dropped.length
        ? `${dropped.length} item${dropped.length === 1 ? "" : "s"} became known AFTER ${asOfISO} and were removed so this `
          + `historical answer cannot use information that did not exist yet. Injuries, results, closing lines, rankings `
          + `and statistics published later are all excluded. Answer from what was knowable at the time.`
        : `No retrieved fact provably post-dates ${asOfISO}, so nothing had to be excluded.`) + caveat,
    },
  };
}

/**
 * The as-of date a question is asking about, if it is asking about one.
 *
 * Only an EXPLICIT date counts. Inferring a cutoff from "last week" and then
 * silently filtering the packet would be worse than not filtering at all,
 * because the answer would look complete while missing arbitrary evidence.
 */
export function asOfDate(question: string): string | null {
  const raw = String(question ?? "");
  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const usDate = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (usDate) {
    const [, mo, da, yr] = usDate;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
  }
  return null;
}

/* ========================================================================
   NORMALIZATION — one place where every evidence item gets an id, a layer and
   whatever canonical identity its value already carries.

   Done centrally rather than at each of the ~20 emission sites, because the
   whole point is that it cannot be forgotten at one of them. Anything an
   emitter already set is preserved; this only fills gaps.
   ======================================================================== */

const FIELD_LAYER: Record<string, NonNullable<Evidence["layer"]>> = {
  pitcher_quality: "matchup", opponent_offense: "matchup", probable_starter: "matchup",
  team_efficiency: "matchup", quarterback: "matchup", workload: "matchup",
  season_pitching: "season", season_offense: "season",
  signal: "market", sharp_reference: "market", cross_market: "market",
  line_movement: "market", market_residual: "market", book_spread: "market",
  closing_line: "market", model: "market",
  clv_history: "historical", prior_outcome: "historical", pattern: "historical",
  calibration: "historical",
  game: "context", park: "context", weather: "context", team_form: "context",
  matchup_context: "context", rankings: "context", bullpen_flag: "context",
  closer: "context", player_stats: "context",
  /* r3. The analytic tier, NOT the data layer — `data_layer` carries L0..L10
     separately. An external rating gets its own tier so it can never be read
     as an EdgeDesk matchup or market number. */
  nfl_player_production: "season", nfl_team_form: "context",
  cfb_team_season_stat: "season", cfb_record: "season", cfb_roster: "season",
  cfb_game: "context", cfb_ranking: "context", cfb_recruiting: "context",
  cfb_returning_production: "season", cfb_portal: "season",
  cfb_sp_plus: "external_model", cfb_elo: "external_model",
  cfb_book_line: "market",
  cbb_matchup_edge: "matchup", cbb_player_production: "season", cbb_ranking: "context",
  identity_unresolved: "context",
};

/* The DATA layer per field, for the L0..L10 contract. Kept separate from
   FIELD_LAYER on purpose: "how much analytical weight" and "what kind of row
   is this" are different questions, and collapsing them is how a current
   injury and a season split end up indistinguishable. */
const FIELD_DATA_LAYER: Record<string, DataLayer> = {
  game: "L1_SCHEDULE", cfb_game: "L1_SCHEDULE",
  probable_starter: "L6_CURRENT", weather: "L6_CURRENT", bullpen_flag: "L6_CURRENT",
  closer: "L6_CURRENT", rankings: "L6_CURRENT", cfb_ranking: "L6_CURRENT",
  cbb_ranking: "L6_CURRENT", matchup_context: "L5_MATCHUP",
  pitcher_quality: "L5_MATCHUP", opponent_offense: "L5_MATCHUP",
  cbb_matchup_edge: "L5_MATCHUP", workload: "L5_MATCHUP",
  team_efficiency: "L3_TEAM_SEASON", season_offense: "L3_TEAM_SEASON",
  cfb_team_season_stat: "L3_TEAM_SEASON", cfb_record: "L3_TEAM_SEASON",
  cfb_recruiting: "L3_TEAM_SEASON", cfb_returning_production: "L3_TEAM_SEASON",
  cfb_portal: "L3_TEAM_SEASON", nfl_team_form: "L3_TEAM_SEASON", team_form: "L3_TEAM_SEASON",
  season_pitching: "L4_PLAYER_SEASON", quarterback: "L4_PLAYER_SEASON",
  player_stats: "L4_PLAYER_SEASON", nfl_player_production: "L4_PLAYER_SEASON",
  cbb_player_production: "L4_PLAYER_SEASON", cfb_roster: "L4_PLAYER_SEASON",
  signal: "L7_MARKET", sharp_reference: "L7_MARKET", cross_market: "L7_MARKET",
  line_movement: "L7_MARKET", market_residual: "L7_MARKET", book_spread: "L7_MARKET",
  closing_line: "L7_MARKET", cfb_book_line: "L7_MARKET",
  model: "L8_EXTERNAL_MODEL", cfb_sp_plus: "L8_EXTERNAL_MODEL", cfb_elo: "L8_EXTERNAL_MODEL",
  clv_history: "L9_HISTORICAL", prior_outcome: "L9_HISTORICAL",
  pattern: "L10_LEARNING", calibration: "L10_LEARNING",
  identity_unresolved: "L0_IDENTITY", park: "L1_SCHEDULE",
};

export function normalizeEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.map((e, i) => {
    const v: any = e.value ?? {};
    const layer = e.layer ?? FIELD_LAYER[e.field]
      ?? (String(e.field).startsWith("fact:") ? "historical" : "context");
    return {
      ...e,
      id: e.id ?? `e${i + 1}`,
      layer,
      event_id: e.event_id ?? (typeof v?.game_id === "string" || typeof v?.game_id === "number" ? String(v.game_id) : null),
      player_id: e.player_id ?? (v?.pitcher_id ?? v?.player_id ?? null),
      team_id: e.team_id ?? (v?.team_id ?? null),
      date: e.date ?? (v?.game_date ? String(v.game_date).slice(0, 10) : null),
      /* r3. Filled centrally for the same reason `layer` is: twenty emitters
         cannot all be trusted to remember, and one that forgets produces an
         item the hierarchy cannot place. */
      data_layer: e.data_layer ?? FIELD_DATA_LAYER[e.field]
        ?? (layer === "external_model" ? "L8_EXTERNAL_MODEL"
          : layer === "historical" ? "L9_HISTORICAL"
          : layer === "market" ? "L7_MARKET"
          : layer === "season" ? "L3_TEAM_SEASON"
          : layer === "matchup" ? "L5_MATCHUP" : "L6_CURRENT"),
      /* WHEN THE FACT BECAME KNOWABLE. Falls back to the source timestamp and
         then STOPS — deliberately not to retrieved_at.
         A read time is not a publication time. Defaulting to it stamps every
         row with "known now", which makes the leakage guard exclude the entire
         packet on any historical question and leaves the answer with nothing to
         reason over. An unknown publication time is genuinely unknown, and the
         leakage report says so rather than inventing one. */
      information_timestamp: e.information_timestamp ?? e.source_timestamp ?? null,
    };
  });
}

/* ------------------------------------------------------ thesis attack */

/* Deterministic. Reads the OWNED numbers on a signal row and reports whether the
   thesis survives them. It produces no new betting number — it reports which
   owned field breaks the case. */
export function attackThesis(sig: any, floor = 0.02, staleMin = 45): { status: string; note: string; falsifiers: string[] } {
  const edge = num(sig?.edge);
  const firstEdge = num(sig?.first_edge);
  const nb = num(sig?.n_books) ?? 0;
  const sharp = sig?.has_sharp === true || sig?.has_sharp === "true";
  const seen = sig?.last_seen_at ? Date.parse(sig.last_seen_at) : NaN;
  const staleM = Number.isFinite(seen) ? (Date.now() - seen) / 60000 : 999;
  const remaining = (firstEdge && firstEdge > 0 && edge != null) ? Math.max(0, Math.min(1, edge / firstEdge)) : null;

  const falsifiers: string[] = [];
  if (edge == null) falsifiers.push("No fair price on file — there is nothing to judge the number against.");
  if (edge != null && edge < floor) falsifiers.push(`Current edge ${(edge * 100).toFixed(1)}% is already below the ${(floor * 100).toFixed(1)}% floor.`);
  if (!sharp) falsifiers.push("Pinnacle does not print this side — the fair line rests on softer books.");
  if (nb < 4) falsifiers.push(`Only ${nb} book${nb === 1 ? "" : "s"} behind the fair line.`);
  if (staleM >= staleMin) falsifiers.push(`Last re-priced ${Math.round(staleM)}m ago — treat as stale until capture confirms it.`);
  if (edge != null && edge > 0.06) falsifiers.push("An edge this large on a game line is usually a stale or bad price, not a gift.");
  if (remaining != null && remaining < 0.5) falsifiers.push(`Over half the detection edge has decayed (${Math.round(remaining * 100)}% remains).`);

  if (edge == null) return { status: "PENDING", note: "Cannot test a thesis with no fair price on file.", falsifiers };
  if (edge < floor) return { status: "INVALIDATED", note: "The price has moved EV below the floor — the thesis does not survive at this number.", falsifiers };
  const hard = (!sharp && nb < 4) || staleM >= staleMin || (remaining != null && remaining < 0.4);
  if (hard) return { status: "WEAKENED", note: "Positive, but undercut by thin confirmation, staleness or heavy decay.", falsifiers };
  if (falsifiers.length >= 3) return { status: "WEAKENED", note: "Several unresolved problems — a lean, not a strong bet.", falsifiers };
  return { status: "SURVIVES", note: "The edge holds up against price, confirmation and freshness on owned data.", falsifiers };
}

/* ------------------------------------- research packet versioning */

/* A snapshot is the research-relevant state of ONE game, reduced to comparable
   scalars. Storing these versioned is what lets EdgeDesk answer "what changed
   since we last looked" with facts instead of vibes. */
export interface Snapshot {
  event_id: string | null;
  version: number;
  taken_at: number;
  facts: Record<string, unknown>;
}

const SNAP_FIELDS = [
  "current_price", "fair_price", "edge", "n_books", "has_sharp", "stale_min",
  "away_starter", "home_starter", "temp_f", "wind_mph", "park_factor", "status",
] as const;

export function buildSnapshot(eventId: string | null, evidence: Evidence[], focus: any, version = 1): Snapshot {
  const facts: Record<string, unknown> = {};

  /* A snapshot describes ONE game. Slate-wide research carries evidence for the
     whole card, so scope it here — otherwise another game's starter or weather
     lands in this game's packet and the next diff reports a phantom change. */
  const matchup = focus?.away_team && focus?.home_team
    ? normName(`${focus.away_team} @ ${focus.home_team}`) : null;
  if (matchup) {
    evidence = evidence.filter((e) => {
      const ent = normName(e.entity);
      if (ent === matchup) return true;
      const g = (e.value as any)?.game;
      return g ? normName(g) === matchup : false;
    });
  }

  if (focus) {
    facts.current_price = focus.best_dec ?? null;
    facts.fair_price = focus.sharp_fair ?? focus.consensus_fair ?? null;
    facts.edge = focus.edge ?? null;
    facts.n_books = focus.n_books ?? null;
    facts.has_sharp = focus.has_sharp ?? null;
    facts.stale_min = focus.last_seen_at
      ? Math.round((Date.now() - Date.parse(focus.last_seen_at)) / 60000) : null;
  }
  for (const e of evidence) {
    if (e.status === "UNAVAILABLE") continue;
    const v = e.value as any;
    if (e.field === "probable_starter" && v?.side) facts[`${v.side}_starter`] = v.name ?? null;
    if (e.field === "weather") { if (v?.temp_f != null) facts.temp_f = v.temp_f; if (v?.wind_mph != null) facts.wind_mph = v.wind_mph; }
    if (e.field === "park" && v?.park_factor != null) facts.park_factor = v.park_factor;
    if (e.field === "game" && v?.status) facts.status = v.status;
  }
  return { event_id: eventId, version, taken_at: Date.now(), facts };
}

/* What actually moved between two snapshots. Direction included, because
   "the price improved" and "the price ran away" are different answers. */
export function diffSnapshots(prev: Snapshot | null, cur: Snapshot): {
  changed: { field: string; from: unknown; to: unknown; direction: string | null; kind: string }[];
  unchanged: string[];
  note: string;
} {
  if (!prev) {
    return { changed: [], unchanged: [], note: "No earlier research packet on file for this game — this is version 1." };
  }
  const changed: { field: string; from: unknown; to: unknown; direction: string | null; kind: string }[] = [];
  const unchanged: string[] = [];
  for (const f of SNAP_FIELDS) {
    const a = (prev.facts as any)[f], b = (cur.facts as any)[f];
    if (a === undefined && b === undefined) continue;
    const na = num(a), nb = num(b);
    const same = (na != null && nb != null) ? Math.abs(na - nb) < 1e-9 : String(a) === String(b);
    if (same) { unchanged.push(f); continue; }
    let direction: string | null = null;
    if (na != null && nb != null) direction = nb > na ? "up" : "down";
    else if (a == null && b != null) direction = "resolved";
    else if (a != null && b == null) direction = "lost";

    /* A classified change, derived ONLY from the two stored snapshots. Never
       from model language, and never from a value that merely looks different
       — the equality test above has already established a real difference. */
    const kind = (() => {
      if (a == null && b != null) return "NEW";
      if (a != null && b == null) return "REMOVED";
      if (f === "status") return "STATUS_CHANGED";
      if (f === "away_starter" || f === "home_starter") return "STATUS_CHANGED";
      if (f === "current_price" || f === "fair_price") return "PRICE_CHANGED";
      if (f === "edge" && na != null && nb != null) return nb > na ? "IMPROVED" : "WORSENED";
      if (na != null && nb != null) return "MOVED";
      return "DATA_CHANGED";
    })();
    changed.push({ field: f, from: a ?? null, to: b ?? null, direction, kind });
  }
  const mins = Math.round((cur.taken_at - prev.taken_at) / 60000);
  return {
    changed, unchanged,
    note: changed.length
      ? `Compared against research packet v${prev.version}, taken ${mins}m ago.`
      : `Nothing material has changed since research packet v${prev.version}, ${mins}m ago.`,
  };
}

/* -------------------------------------- structured finding extraction */

/* Findings are derived from EVIDENCE, never from model prose. A finding is a
   claim bound to the record that produced it, so nothing an LLM said can ever
   become stored sports knowledge (spec: no knowledge contamination). */
export interface Finding {
  entity: string | null;
  fact_type: string;
  claim: string;
  fact_value: unknown;
  source: string;
  source_timestamp: string | null;
  verification_status: EvStatus;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  valid_until: string | null;
}

const FACT_TTL_HOURS: Record<string, number> = {
  pitcher_quality: 72, opponent_offense: 72, workload: 36, park: 720,
  probable_starter: 12, weather: 3, bullpen_flag: 12, team_form: 48,
};

export function extractFindings(evidence: Evidence[]): Finding[] {
  const out: Finding[] = [];
  for (const e of evidence) {
    if (e.status === "UNAVAILABLE" || e.value == null) continue;
    const ttl = FACT_TTL_HOURS[e.field];
    if (ttl == null) continue;                       // only durable fact types are stored
    const v = e.value as any;
    let claim: string | null = null;

    switch (e.field) {
      case "pitcher_quality":
        if (v.xera == null && v.k_pct == null) break;
        claim = `${e.entity} recorded ${[
          v.xera != null ? `xERA ${v.xera}` : null,
          v.k_pct != null ? `K% ${v.k_pct}` : null,
          v.bb_pct != null ? `BB% ${v.bb_pct}` : null,
          v.barrel_pct != null ? `barrel% ${v.barrel_pct}` : null,
          v.hardhit_pct != null ? `hard-hit% ${v.hardhit_pct}` : null,
        ].filter(Boolean).join(", ")} in EdgeDesk's pitcher_features dataset.`;
        break;
      case "opponent_offense":
        claim = `The offense ${e.entity} faces posted ${[
          v.obp != null ? `OBP ${v.obp}` : null,
          v.iso != null ? `ISO ${v.iso}` : null,
          v.k_pct != null ? `K% ${v.k_pct}` : null,
          v.runs_per_game != null ? `${v.runs_per_game} R/G` : null,
        ].filter(Boolean).join(", ")} in EdgeDesk's offense_features dataset.`;
        break;
      case "workload":
        claim = `${e.entity} last started ${v.last_start}${v.pitches != null ? ` on ${v.pitches} pitches` : ""}.`;
        break;
      case "probable_starter":
        claim = `${v.name} is the probable starter for ${v.team} (${v.throws ?? "hand unknown"}), not confirmed.`;
        break;
      case "park":
        if (v.park_factor == null) break;
        claim = `${v.venue ?? e.entity} carries park factor ${v.park_factor}${v.hr_factor != null ? `, HR factor ${v.hr_factor}` : ""}.`;
        break;
      case "bullpen_flag":
        claim = `${v.pitcher} is flagged ${v.flag}${v.pitches_yesterday != null ? ` after ${v.pitches_yesterday} pitches yesterday` : ""}.`;
        break;
      case "team_form":
        claim = `Records on file: away ${v.away?.record ?? "?"}, home ${v.home?.record ?? "?"}.`;
        break;
      case "weather":
        if (v.temp_f == null && v.wind_mph == null) break;
        claim = `Forecast on file: ${[v.temp_f != null ? `${v.temp_f}°F` : null, v.wind_mph != null ? `wind ${v.wind_mph} mph` : null].filter(Boolean).join(", ")}.`;
        break;
    }
    if (!claim) continue;

    out.push({
      entity: e.entity, fact_type: e.field, claim, fact_value: e.value,
      source: e.source, source_timestamp: e.source_timestamp ?? null,
      verification_status: e.status,
      confidence: e.status === "VERIFIED" ? "HIGH" : e.status === "PROBABLE" || e.status === "PARTIAL" ? "MEDIUM" : "LOW",
      valid_until: new Date(Date.now() + ttl * 3600_000).toISOString(),
    });
  }
  return out;
}

/* ------------------------------- cross-market structure (non-obvious spots) */

/* Which side of a game a selection sits on, by name. Reused from the same
   problem that was mis-grading bets: exact string equality does not survive
   "Athletics" vs "Oakland Athletics". */
function sideOf(selection: string, home: string, away: string): "home" | "away" | null {
  const s = normName(selection), h = normName(home), a = normName(away);
  if (!s || !h || !a) return null;
  if (s === h && s !== a) return "home";
  if (s === a && s !== h) return "away";
  const endsH = h.endsWith(" " + s), endsA = a.endsWith(" " + s);
  if (endsH && !endsA) return "home";
  if (endsA && !endsH) return "away";
  return null;
}

export interface CrossFlag {
  kind: string;
  detail: string;
  markets: string[];
  research_interest: "HIGH" | "MEDIUM" | "LOW";
}

/**
 * Read the RELATIONSHIP between the markets EdgeDesk holds on one game.
 *
 * This is where the non-obvious spots live. A moneyline edge is a thing anyone
 * scanning a board will see. Two markets on the same game agreeing — or worse,
 * disagreeing — is a structural fact about the price that no per-signal score
 * can express, and it is sitting in data EdgeDesk already owns.
 *
 * Everything below is a COMPARISON of owned fields. No implied probability is
 * derived from a spread, no market is converted into another, and no new
 * betting number is produced. The flags are research direction, never a bet.
 */
export function crossMarketFlags(rows: any[], floor = 0.02): CrossFlag[] {
  const out: CrossFlag[] = [];
  if (!rows || rows.length < 2) return out;

  const home = rows[0]?.home_team ?? "", away = rows[0]?.away_team ?? "";
  const live = rows.filter((r) => num(r.edge) != null && num(r.edge)! >= floor);
  const byMarket = (m: string) => rows.filter((r) => r.market === m);

  // 1. Two markets, same team. The rarest and most informative shape: the
  //    price is wrong about a team, not about one bet type.
  const sided = live
    .map((r) => ({ r, side: sideOf(r.selection, home, away) }))
    .filter((x) => x.side);
  const homeSide = sided.filter((x) => x.side === "home").map((x) => x.r);
  const awaySide = sided.filter((x) => x.side === "away").map((x) => x.r);
  for (const [label, group] of [["home", homeSide], ["away", awaySide]] as [string, any[]][]) {
    const markets = Array.from(new Set(group.map((r) => r.market)));
    if (markets.length >= 2) {
      out.push({
        kind: "multi_market_same_side",
        detail: `${group[0].selection} carries an edge in ${markets.length} markets (${markets.join(", ")}). `
          + `Two market types pricing the same side wrong is a stronger structural read than either alone — `
          + `EdgeDesk still scores each separately, so this agreement is not in any single verdict.`,
        markets, research_interest: "HIGH",
      });
    }
  }

  // 2. Two markets, OPPOSITE sides of the same game. One of them is wrong;
  //    a per-signal board shows both as edges and cannot say that.
  if (homeSide.length && awaySide.length) {
    out.push({
      kind: "cross_market_conflict",
      detail: `EdgeDesk holds edges on BOTH sides of this game across different markets `
        + `(${homeSide.map((r) => r.market).join(", ")} on ${homeSide[0].selection} vs `
        + `${awaySide.map((r) => r.market).join(", ")} on ${awaySide[0].selection}). `
        + `They cannot both be right about the same game. Treat as a pricing artefact to investigate, not two bets.`,
      markets: Array.from(new Set([...homeSide, ...awaySide].map((r) => r.market))),
      research_interest: "HIGH",
    });
  }

  // 3. An edge on a derivative market while the moneyline has none. Derivative
  //    markets get less attention and less sharp money, so this is exactly the
  //    kind of spot a moneyline-first scan never surfaces.
  const mlEdge = byMarket("h2h").some((r) => (num(r.edge) ?? 0) >= floor);
  const derivEdges = live.filter((r) => r.market === "spreads" || r.market === "totals");
  if (!mlEdge && derivEdges.length && byMarket("h2h").length) {
    out.push({
      kind: "derivative_only_edge",
      detail: `The moneyline on this game is priced with no edge, but ${derivEdges.map((r) => r.market).join(" / ")} `
        + `carries one. Derivative markets absorb less sharp money, so a discrepancy that exists only there `
        + `is a genuine research target rather than a stale moneyline.`,
      markets: Array.from(new Set(derivEdges.map((r) => r.market))),
      research_interest: "HIGH",
    });
  }

  // 4. Sharp confirmation present on one market and absent on another. The
  //    unconfirmed one is resting on softer books than the board implies.
  const confirmed = live.filter((r) => r.has_sharp === true).map((r) => r.market);
  const unconfirmed = live.filter((r) => r.has_sharp !== true).map((r) => r.market);
  if (confirmed.length && unconfirmed.length) {
    out.push({
      kind: "uneven_sharp_confirmation",
      detail: `Pinnacle prints ${confirmed.join(", ")} on this game but not ${unconfirmed.join(", ")}. `
        + `The unconfirmed market's fair line rests on softer books than its score suggests.`,
      markets: Array.from(new Set([...confirmed, ...unconfirmed])),
      research_interest: "MEDIUM",
    });
  }

  // 5. Book depth differing sharply between markets on the same game.
  const depths = live.map((r) => ({ m: r.market, n: num(r.n_books) ?? 0 })).filter((d) => d.n > 0);
  if (depths.length >= 2) {
    const max = Math.max(...depths.map((d) => d.n)), min = Math.min(...depths.map((d) => d.n));
    if (max >= 6 && min <= 3) {
      out.push({
        kind: "thin_market_on_liquid_game",
        detail: `Book coverage on this game ranges from ${min} to ${max} depending on the market. `
          + `The thin side is materially less trustworthy than the liquid one, which a per-signal book count does not contrast.`,
        markets: depths.map((d) => d.m), research_interest: "MEDIUM",
      });
    }
  }

  return out;
}

/* ------------------------------------- market movement direction */

/**
 * Which way the market moved relative to the price EdgeDesk froze.
 *
 * Movement toward your side is the single most informative pre-settlement
 * signal EdgeDesk can observe, and the tick series was previously handed to the
 * model as a raw dump. This classifies direction and magnitude only — it is a
 * comparison of two owned prices, not a projection, and it never becomes a CLV.
 * Real CLV still comes from `close`, after the fact.
 */
export function movementRead(entryDec: number | null, ticks: any[] | null): {
  direction: "toward" | "away" | "flat" | "unknown";
  moved_pct: number | null;
  n: number;
  note: string;
} {
  const n = ticks?.length ?? 0;
  if (!entryDec || !(entryDec > 1) || n < 2) {
    return { direction: "unknown", moved_pct: null, n,
      note: n < 2 ? "Not enough tick history to read movement." : "No frozen entry price to compare against." };
  }
  const last = num(ticks![n - 1]?.best_dec);
  if (last == null || !(last > 1)) {
    return { direction: "unknown", moved_pct: null, n, note: "Latest tick carries no usable price." };
  }
  // Shortening price (lower decimal) = the market came toward this side.
  const pct = (entryDec - last) / entryDec;
  if (Math.abs(pct) < 0.005) {
    return { direction: "flat", moved_pct: +pct.toFixed(4), n,
      note: "The market has not moved materially since detection." };
  }
  if (pct > 0) {
    return { direction: "toward", moved_pct: +pct.toFixed(4), n,
      note: `The price has shortened ${(pct * 100).toFixed(1)}% since EdgeDesk froze it — the market moved TOWARD this side. `
        + `That is the shape that precedes positive CLV, but it is not CLV: only the close settles that.` };
  }
  return { direction: "away", moved_pct: +pct.toFixed(4), n,
    note: `The price has drifted ${(Math.abs(pct) * 100).toFixed(1)}% longer since detection — the market moved AWAY from this side. `
      + `Either the edge is real and getting better, or the market knows something the frozen price did not.` };
}

/* ------------------------------------------- proactive research scout */

/* Runs over the already-scored board and flags what deserves research time.
   Every reason is a comparison of OWNED fields — it produces no new number and
   never turns a research flag into a betting recommendation. */
export interface ScoutItem {
  event_id: string;
  game: string;
  flags: string[];
  why: string;
  research_interest: "HIGH" | "MEDIUM" | "LOW";
  betting_action: string;      // kept explicitly separate from research interest
}

export function scout(slateRows: any[], floor = 0.02, staleMin = 45): ScoutItem[] {
  const out: ScoutItem[] = [];
  for (const s of slateRows) {
    const edge = num(s.edge), first = num(s.first_edge);
    const nb = num(s.n_books) ?? 0;
    const sharp = s.has_sharp === true || s.has_sharp === "true";
    const seen = s.last_seen_at ? Date.parse(s.last_seen_at) : NaN;
    const staleM = Number.isFinite(seen) ? (Date.now() - seen) / 60000 : null;
    const remaining = (first && first > 0 && edge != null) ? edge / first : null;
    const flags: string[] = [];

    if (edge != null && edge >= 0.04 && (!sharp || nb < 5)) flags.push("large edge, weak confirmation");
    if (edge != null && edge > 0 && edge < floor && sharp && nb >= 6) flags.push("strong confirmation, sub-floor edge");
    if (edge != null && edge >= floor && staleM != null && staleM >= staleMin) flags.push("playable number on a stale capture");
    if (remaining != null && remaining < 0.5 && first! > 0) flags.push("over half the detection edge has decayed");
    if (edge != null && edge > 0.06) flags.push("edge large enough to suspect a bad or stale price");
    if (!sharp && edge != null && edge >= floor) flags.push("no Pinnacle print on this side");
    if (s.pin_dec != null && s.best_dec != null) {
      const gap = num(s.best_dec)! / num(s.pin_dec)!;
      if (gap > 1.06) flags.push("market price diverges sharply from the Pinnacle reference");
    }
    if (edge == null) flags.push("no fair price on file — cannot be evaluated yet");
    if (!flags.length) continue;

    const interest = flags.length >= 3 ? "HIGH" : flags.length === 2 ? "MEDIUM" : "LOW";
    out.push({
      event_id: s.event_id,
      game: `${s.away_team ?? ""} @ ${s.home_team ?? ""}`,
      flags,
      why: flags.join("; ") + ".",
      research_interest: interest,
      betting_action: edge == null
        ? "Not evaluable — WAIT, not a bet."
        : edge < floor
          ? "Below the playable floor — research interest only, not a bet."
          : "EdgeDesk's deterministic verdict governs whether this is a bet; research interest is separate.",
    });
  }
  return out.sort((a, b) => b.flags.length - a.flags.length).slice(0, 12);
}

/* ------------------------------------------- conversation state */

/* Structured, not six raw chat lines: "what about the bullpen?" has to know
   which game is still in focus. */
export interface ConvoState {
  teams: string[];
  sport: string | null;
  eventId: string | null;
  lastIntent: string | null;
}

export function deriveState(history: any[], plan: Plan, packet: any, prev?: ConvoState | null): ConvoState {
  const st: ConvoState = {
    teams: plan.entities.teams.slice(),
    sport: null, eventId: plan.entities.eventId, lastIntent: plan.intent,
  };
  if (!st.teams.length && prev?.teams?.length) st.teams = prev.teams.slice();
  if (!st.eventId && prev?.eventId) st.eventId = prev.eventId;
  if (!st.sport && prev?.sport) st.sport = prev.sport;

  // A loaded signal packet always wins — it is what the user is looking at.
  const g = packet?.game;
  if (g?.matchup && typeof g.matchup === "string") {
    const t = resolveTeams(g.matchup);
    if (t.length) st.teams = t;
  }
  if (packet?.sport_key) st.sport = packet.sport_key;

  // Fall back to whatever the last few turns were about.
  if (!st.teams.length) {
    for (let i = history.length - 1; i >= 0 && i >= history.length - 6; i--) {
      const t = resolveTeams(String(history[i]?.content ?? ""));
      if (t.length) { st.teams = t; break; }
    }
  }
  return st;
}

/* ========================================================================
   PART 1b — PRESENTATION LAYER (deep engine, simple answer).
   Inlined from supabase/functions/edgedesk_ai/_presentation.js by
   `node tools/presentation/inline.js`. Do not edit between the markers here;
   edit the canonical file and re-run the inliner. The sync test fails if the
   three copies (this file, app.html, brief.html) ever drift.
   ======================================================================= */
// deno-lint-ignore-file
/*__EDPRES_START__*/
/* ============================================================================
   EdgeDesk PRESENTATION LAYER — "deep engine, simple answer".

   ONE FILE, FOUR HOSTS. This exact block is inlined into:
     - supabase/functions/edgedesk_ai/index.ts   (server: builds `presentation`)
     - app.html                                   (browser: decision cards, briefs)
     - brief.html                                 (public share page)
     - record.html                                (public track record of published briefs)
   tools/presentation/presentation_sync.test.js fails if the copies drift.
   The canonical source is supabase/functions/edgedesk_ai/_presentation.js.

   THE ONE RULE
     Nothing here computes, adjusts or overrides a probability, fair price,
     edge, EV, CLV, confidence, score, max-playable, break-even or verdict.
     Every one of those arrives from EdgeDesk's deterministic engine and is
     TRANSLATED into sportsbook language. The American-odds conversion is
     display-only and is never fed back into anything.

     AI copy (headline / why / watch / change trigger / market read) is
     OPTIONAL and VALIDATED. When it is missing or rejected, the templated
     deterministic copy stands. Narration failure never takes the card down.
   ============================================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPRES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var VERDICTS = ['BET', 'LEAN', 'WAIT', 'PASS'];
  var VERDICT_RANK = { BET: 0, LEAN: 1, WAIT: 2, PASS: 3 };
  /* Words publisher copy may never carry. Matched case-insensitively. */
  var HYPE = /\b(lock|locks|guaranteed?|guarantees|hammer|hammered|can'?t[- ]miss|cannot miss|free money|ai says|our algorithm guarantees|sure thing|slam[- ]dunk|mortal lock|no[- ]brainer|easy money|100% winner)\b/i;
  /* Words a sports fan cannot be expected to know, and which nothing on a
     public surface defines. AI copy carrying one of these is rejected and the
     deterministic plain-language sentence stands instead. These terms are
     welcome in FULL RESEARCH, which is a different layer with a different
     reader — this gate only guards the five-second view, the publisher brief
     and the share page. */
  var JARGON = /\b(de-?vig(?:ged|ging)?|vigorish|no-?vig|clv|closing[- ]line[- ]value|expected value|\bev\b|pinnacle|sharp(?:er)?[- ](?:market|book|books|fair|reference|money|side)|soft(?:er)? books?|fair (?:line|value|price|odds|probability)|max[- ]playable|market residual|consensus dispersion|liquidity|shin|kelly|overround|steam move|middling|arb(?:itrage)?)\b/i;

  /* ---------------------------------------------------------------- utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function isStr(s) { return typeof s === 'string'; }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function sentence(s) {
    s = clean(s);
    if (!s) return '';
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (!/[.!?]$/.test(s)) s += '.';
    return s;
  }
  function normVerdict(v) {
    v = String(v == null ? '' : v).toUpperCase().trim();
    if (v === 'NO BET' || v === 'NO SIGNAL') return 'PASS';
    if (v === 'STRONG SIGNAL') return 'BET';
    return VERDICTS.indexOf(v) >= 0 ? v : null;
  }
  function toMs(t) {
    if (t == null || t === '') return null;
    if (typeof t === 'number') return isFinite(t) ? t : null;
    var ms = Date.parse(String(t));
    return isFinite(ms) ? ms : null;
  }

  /* ----------------------------------------------------------- odds (display) */
  /* Decimal -> American. DISPLAY ONLY. The result is never fed back into an
     edge, EV or fair-price calculation — the engine keeps its own numbers. */
  function decToAmerican(dec) {
    var d = num(dec);
    if (d == null || d <= 1) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  }
  function fmtAmerican(am) {
    var a = num(am);
    if (a == null) return null;
    a = Math.round(a);
    return (a > 0 ? '+' : '') + a;
  }
  /* Sportsbook-native selection: "Texas Tech -3.5", "Over 47.5", "Chiefs ML". */
  function selectionLabel(market, selection, point) {
    var m = String(market == null ? '' : market).toLowerCase().trim();
    var s = clean(selection);
    if (!s) return null;
    var p = num(point);
    if (m === 'totals' || m === 'total') {
      var side = /^over/i.test(s) ? 'Over' : /^under/i.test(s) ? 'Under' : s;
      return p != null ? side + ' ' + p : side;
    }
    if (m === 'spreads' || m === 'spread') {
      if (p == null) return s;
      return s + ' ' + (p > 0 ? '+' : '') + p;
    }
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') return /\bML$/.test(s) ? s : s + ' ML';
    return p != null ? s + ' ' + p : s;
  }
  function marketLabel(market) {
    var m = String(market == null ? '' : market).toLowerCase().trim();
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') return 'Moneyline';
    if (m === 'spreads' || m === 'spread') return 'Spread';
    if (m === 'totals' || m === 'total') return 'Total';
    return market == null ? null : String(market);
  }

  /* --------------------------------------------------- language translation */
  /* Internal terminology -> what an intelligent sportsbook bettor would say.
     Applied ONLY to simple/publisher copy. Full Research keeps the precise
     terms. Longest phrases first so "sharp fair" is not half-replaced. */
  var TERMS = [
    ['pinnacle de-vig fair', 'the sharper market’s fair line'],
    ['pinnacle (sharp reference)', 'the sharper market'],
    ['sharp reference', 'sharper market'],
    ['sharp-confirmed', 'confirmed by the sharper market'],
    ['sharp confirmation', 'confirmation from the sharper market'],
    ['sharp fair', 'sharper market fair line'],
    ['sharp print', 'quote from the sharper market'],
    ['consensus fair', 'the average fair line across books'],
    ['max-playable', 'good to'],
    ['max playable', 'good to'],
    ['market residual', 'the move beyond what the opening difference normally explains'],
    ['data integrity warning', 'some of the underlying data needs verification'],
    ['evidence integrity', 'data check'],
    ['calibration', 'how similar EdgeDesk signals have held up'],
    ['market edge', 'the current price is better than the sharper market suggests'],
    ['closing line value', 'closing line value'],
    ['de-vigged', 'fair'],
    ['de-vig', 'fair'],
    ['falsifier', 'what would break the case'],
    ['thesis', 'case'],
    ['pinnacle', 'the sharper market'],
    ['clv', 'closing line value'],
    ['ev', 'expected value']
  ];
  function translate(term) {
    var t = clean(term).toLowerCase();
    for (var i = 0; i < TERMS.length; i++) if (TERMS[i][0] === t) return TERMS[i][1];
    return term;
  }
  /* TERMS translates internal -> BETTOR. That is the right altitude for Full
     Research and the wrong one for a fan, so PUBLIC_TERMS is a second pass
     applied only on public surfaces: it takes the bettor wording TERMS
     produced and says the same thing without assuming the vocabulary.
     Longest phrases first, same as TERMS. */
  var PUBLIC_TERMS = [
    ['the sharper market’s fair line', 'EdgeDesk’s comparison price'],
    ['sharper market fair line', 'EdgeDesk’s comparison price'],
    ['the average fair line across books', 'the average price across sportsbooks'],
    ['the current price is better than the sharper market suggests', 'the price on offer is better than the rest of the market suggests'],
    ['confirmation from the sharper market', 'a check against EdgeDesk’s benchmark sportsbook'],
    ['confirmed by the sharper market', 'checked against EdgeDesk’s benchmark sportsbook'],
    ['quote from the sharper market', 'the price at EdgeDesk’s benchmark sportsbook'],
    ['the sharper market', 'EdgeDesk’s benchmark sportsbook'],
    ['sharper market', 'EdgeDesk’s benchmark sportsbook'],
    ['closing line value', 'how the price compared with the market’s final number'],
    ['expected value', 'the long-run value in the price'],
    ['sharp level', 'level of agreement'],
    ['fair probability', 'comparison chance'],
    ['fair line', 'comparison price'],
    ['fair price', 'comparison price'],
    ['fair odds', 'comparison price'],
    ['fair value', 'comparison price'],
    ['good to', 'the price limit'],
    ['liquidity', 'money actually available at that price'],
    ['break-even', 'the price where the bet stops being worth it'],
    ['breakeven', 'the price where the bet stops being worth it']
  ];
  function subst(s, table) {
    for (var i = 0; i < table.length; i++) {
      var from = table[i][0], to = table[i][1];
      var re = new RegExp('(^|[^a-z0-9])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9])', 'gi');
      s = s.replace(re, function (m, pre) { return pre + to; });
    }
    return s;
  }
  /* The public path: bettor translation, then fan translation. */
  function publicText(text) {
    var s = clean(text);
    if (!s) return s;
    return subst(subst(s, TERMS), PUBLIC_TERMS);
  }
  function translateText(text) {
    var s = clean(text);
    if (!s) return s;
    for (var i = 0; i < TERMS.length; i++) {
      var from = TERMS[i][0], to = TERMS[i][1];
      var re = new RegExp('(^|[^a-z0-9])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9])', 'gi');
      s = s.replace(re, function (m, pre) { return pre + to; });
    }
    return s;
  }

  /* Engine reasons are precise strings; each known shape gets a plain
     sentence. Unknown ones fall through the dictionary. */
  var REASON_MAP = [
    [/^([+-]?[\d.]+%) estimated edge vs (.+)$/i, function (m) { return 'The price on offer is ' + m[1].replace(/^\+/, '') + ' better than EdgeDesk’s comparison price for the same bet.'; }],
    [/pinnacle \(sharp reference\) is quoting this side/i, 'The sportsbook EdgeDesk uses as its benchmark is posting a price on this exact bet, so the comparison is against a live number rather than an estimate.'],
    [/best price is at a us-regulated book/i, 'The best price is at a US-regulated book.'],
    [/^(\d+) books? behind the fair line$/i, function (m) { return m[1] + ' sportsbooks were quoting this game when EdgeDesk looked, so the comparison is not resting on one unusual book.'; }],
    [/corroborated across (\d+) sharp level/i, function (m) { return 'Other sportsbooks are pricing this the same way rather than one book sitting alone.'; }],
    [/beat the close \(clv ([^)]+)\)/i, function (m) { return 'EdgeDesk flagged this at a better price than the market finished at before kickoff.'; }],
    [/best price is offshore/i, 'The best price is at an offshore sportsbook, which is harder to reach and less protected than a US-licensed one.'],
    [/only (\d+) books? quot/i, function (m) { return 'Only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet, so the comparison rests on very little.'; }],
    [/priced (\d+)m ago .*verify/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Check the sportsbook is still showing it.'; }],
    [/stale: last re-priced (\d+)m ago/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Odds move quickly, so the real number may be worse by now.'; }],
    [/edge this large on a game line is often a stale/i, 'A gap this big is usually a price that is out of date or simply wrong, not a gift. It normally disappears the moment the sportsbook notices.'],
    [/over half the detection edge has already decayed \((\d+)% remains\)/i, function (m) { return 'Most of the gap EdgeDesk originally spotted has already closed. About ' + m[1] + '% of it is left.'; }],
    [/no sharp \(pinnacle\) confirmation on this exact side/i, 'EdgeDesk’s benchmark sportsbook is not posting a price on this exact bet, so the comparison had to be built from the other sportsbooks. That is a weaker check.'],
    [/failed to beat the close \(clv ([^)]+)\)/i, function (m) { return 'The market finished at a better price than the one EdgeDesk flagged, so the number moved the wrong way.'; }],
    [/mlb caveat: lineups are probable/i, 'Lineups here are expected, not confirmed. One late change moves the price.'],
    [/price keeps moving against you: (\d+)% .* past (\S+) the ev/i, function (m) { return 'The value lives in the price. Past ' + m[2] + ' there is nothing left to buy.'; }],
    [/pinnacle never prints this side/i, 'EdgeDesk’s benchmark sportsbook never posts a price on this bet, so the comparison rests entirely on the other sportsbooks.'],
    [/the last capture \((\d+)m ago\) is stale/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago, and the real number may be worse by now.'; }],
    [/offshore best price is not actually available/i, 'The offshore price may not really be available to you, or not for much money.'],
    [/edge this large is usually a bad or stale line/i, 'A gap this big is usually a bad or out-of-date price, not a gift. One correction erases it.'],
    [/late scratch or lineup change moves the number/i, 'A late scratch or lineup change would move the price.'],
    [/already failed to beat the close/i, 'The market already moved past this number before kickoff.'],
    [/nothing structural stands out/i, 'Nothing structural stands out against it, which is a reason to treat it normally rather than press.'],
    [/the edge existed at detection \(([^)]+)\) but the current price has moved to ([^,]+), pulling ev below the ([\d.]+%) floor/i,
      function (m) { return 'There was something here at ' + m[1] + ', but the price has moved to ' + m[2] + ' and there is no longer enough in it.'; }],
    [/current price is below fair/i, 'The price on offer is worse than EdgeDesk’s comparison price, so there is nothing to take here.'],
    [/no fair price available to judge this number against/i, 'EdgeDesk has no comparison price on file for this bet, so there is nothing to judge the number against.'],
    [/best price is offshore and only (\d+) books?/i, function (m) { return 'The best price is offshore and only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet. That is too thin to trust.'; }],
    [/last re-priced (\d+)m ago\. treat as stale/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. It needs a fresh check at the sportsbook.'; }],
    [/clears the bar with real liquidity: ([+-]?[\d.]+%)/i, function (m) { return 'The price on offer is ' + m[1].replace(/^\+/, '') + ' better than EdgeDesk’s comparison price, at a US-licensed sportsbook.'; }],
    [/positive and qualifying, but with caveats/i, 'The number clears EdgeDesk’s bar, but with caveats worth reading before acting.'],
    [/no fair price is on file yet/i, 'EdgeDesk has no comparison price on file for this bet yet, so there is nothing to judge the number against.'],
    [/qualified on the last number, but it was captured (\d+)m ago/i, function (m) { return 'The price qualified when EdgeDesk last saw it, but that was ' + m[1] + ' minutes ago. A fresh check has to show it is still there.'; }],
    [/a probable starter is still missing/i, 'A probable starter is still missing for this game, and the starter is the single biggest input in the number.']
  ];
  function plainReason(s) {
    var t = clean(s);
    if (!t) return '';
    for (var i = 0; i < REASON_MAP.length; i++) {
      var m = t.match(REASON_MAP[i][0]);
      if (m) { var out = REASON_MAP[i][1]; return typeof out === 'function' ? out(m) : out; }
    }
    return sentence(publicText(t.replace(/\s+[—-]\s+/g, '. ')));
  }

  /* --------------------------------------------------------------- freshness */
  function ageText(min) {
    if (min == null || !isFinite(min)) return null;
    if (min < 1) return 'just now';
    if (min < 60) return Math.round(min) + ' min ago';
    var h = min / 60;
    if (h < 24) return (h < 10 ? (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') : Math.round(h)) + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  /* o: { price_at, research_at, now, stale_min (the engine's own limit) } */
  function freshness(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var limit = num(o.stale_min) != null && num(o.stale_min) > 0 ? num(o.stale_min) : 90;
    var pAt = toMs(o.price_at), rAt = toMs(o.research_at);
    var pAge = pAt != null ? Math.max(0, (now - pAt) / 60000) : (num(o.price_age_min));
    var rAge = rAt != null ? Math.max(0, (now - rAt) / 60000) : (num(o.research_age_min));
    var status = pAge == null ? 'UNKNOWN' : pAge >= limit ? 'STALE' : pAge >= limit / 2 ? 'AGING' : 'CURRENT';
    var warning = status === 'STALE' ? 'This price needs refreshing before it can be used.'
      : status === 'UNKNOWN' ? 'EdgeDesk cannot tell how old this price is.'
      : status === 'AGING' ? 'This price is getting old. Check it is still live.' : null;
    return {
      status: status,
      price_age_min: pAge == null ? null : Math.round(pAge * 10) / 10,
      research_age_min: rAge == null ? null : Math.round(rAge * 10) / 10,
      price_text: pAge == null ? 'Price age unknown' : 'Price updated ' + ageText(pAge),
      research_text: rAge == null ? null : 'Research refreshed ' + ageText(rAge),
      price_captured_at: pAt != null ? new Date(pAt).toISOString() : null,
      limit_min: limit,
      warning: warning
    };
  }

  /* ---------------------------------------------------------------- playable */
  /* The playable threshold is a PRICE the engine owns (max_playable). It is
     never a line threshold, because the engine owns none. */
  function playable(o) {
    o = o || {};
    var v = normVerdict(o.verdict);
    var maxAm = num(o.max_playable_am), needs = num(o.needs_price_am);
    var lim = fmtAmerican(maxAm);
    if (maxAm == null) {
      return { kind: 'NONE', label: null, limit_odds: null,
        text: 'EdgeDesk has no fair price on file, so there is no playable limit yet.' };
    }
    if (v === 'PASS' && needs != null) {
      return { kind: 'NEEDS', label: 'Needs ' + fmtAmerican(needs) + ' or better', limit_odds: fmtAmerican(needs),
        text: 'The current price is past EdgeDesk’s limit. It only becomes a bet again at ' + fmtAmerican(needs) + ' or better.' };
    }
    if (v === 'PASS') {
      return { kind: 'LIMIT', label: 'Limit ' + lim, limit_odds: lim,
        text: 'EdgeDesk’s limit for this number is ' + lim + '. The current price does not qualify.' };
    }
    return { kind: 'GOOD_TO', label: 'Good to ' + lim, limit_odds: lim,
      text: 'EdgeDesk still likes this at ' + lim + '. Past that number the edge is no longer strong enough.' };
  }

  /* ------------------------------------------------------------ price status */
  function priceStatus(o) {
    o = o || {};
    var v = normVerdict(o.verdict);
    var det = num(o.detect_am), cur = num(o.current_am), maxAm = num(o.max_playable_am);
    var edge = num(o.edge), dEdge = num(o.detect_edge), floor = num(o.floor);
    var fr = o.freshness || {};
    if (cur == null) {
      return { kind: 'NO_PRICE', text: 'No current price is on file for this selection.', was: null, now: null };
    }
    var moved = det != null && det !== cur;
    if (v === 'PASS' && dEdge != null && floor != null && dEdge >= floor && edge != null && edge < floor) {
      return { kind: 'PAST_LIMIT', was: 'PLAYABLE', now: 'PASS',
        text: 'Was playable at ' + fmtAmerican(det) + '. Now PASS: the price moved to ' + fmtAmerican(cur) + '.'
          + (maxAm != null ? ' EdgeDesk’s limit was ' + fmtAmerican(maxAm) + '.' : '') };
    }
    if (fr.status === 'STALE') {
      return { kind: 'STALE', text: 'This price needs refreshing before it can be used.', was: null, now: null };
    }
    if (moved) {
      var inside = maxAm != null && v !== 'PASS';
      return { kind: 'MOVED', was: fmtAmerican(det), now: fmtAmerican(cur),
        text: 'Price moved from ' + fmtAmerican(det) + ' to ' + fmtAmerican(cur) + ' since EdgeDesk first flagged it.'
          + (inside ? ' Still inside the limit of ' + fmtAmerican(maxAm) + '.' : '') };
    }
    return { kind: 'HOLDING', was: null, now: fmtAmerican(cur), text: 'The price has held since EdgeDesk flagged it.' };
  }

  /* ---------------------------------------------------------------- integrity */
  function integrityStatus(g) {
    if (!g || !g.verdict) return { status: 'OK', reason: null, reason_plain: null, known: false };
    var v = String(g.verdict).toUpperCase();
    var failed = (g.failed || g.checks || []).filter(function (c) { return c && c.status && String(c.status).toUpperCase() !== 'PASS'; });
    var first = failed[0];
    var reason = first ? (String(first.name || '').replace(/_/g, ' ') + ': ' + clean(first.detail)) : (g.summary || g.headline || null);
    if (reason) reason = publicText(String(reason).slice(0, 260));
    /* The chip may carry the check's own name. The sentence a reader gets does
       not: "identity_chain: two starters are…" is an engine slug glued to a
       fact, and only the fact means anything outside the engine. */
    var plain = first && clean(first.detail) ? publicText(clean(first.detail)).replace(/\.\s*$/, '') : null;
    if (v === 'FAIL') return { status: 'FAILED', reason: reason || 'a data check failed', reason_plain: plain || 'a check on its own data failed', known: true };
    if (v === 'WARNING' || v === 'LOCALIZED') return { status: 'PROVISIONAL', reason: reason || 'some of the underlying data needs verification', reason_plain: plain || 'some of the data behind this needs checking', known: true };
    return { status: 'OK', reason: null, reason_plain: null, known: true };
  }

  /* Availability / data gaps. A missing injury report is NOT "no injuries". */
  function gapSentences(gaps) {
    var out = [];
    (gaps || []).forEach(function (g) {
      var k = String(g && (g.field || g) || '').toLowerCase();
      if (!k) return;
      if (/injur|availab|lineup/.test(k)) out.push('Injury and availability data is not on file. Do not read that as a clean injury report.');
      else if (/weather/.test(k)) out.push('Weather is not on file for this game.');
      else if (/quarterback|qb/.test(k)) out.push('The starting quarterback is not confirmed in EdgeDesk’s data.');
      else if (/starter|pitch/.test(k)) out.push('A probable starter is missing from EdgeDesk’s data.');
      else out.push(publicText(k.replace(/_/g, ' ')) + ' is not on file.');
    });
    var seen = {}, uniq = [];
    out.forEach(function (s) { if (!seen[s]) { seen[s] = 1; uniq.push(s); } });
    return uniq;
  }

  /* ----------------------------------------------------------- availability */
  /* WHO IS PLAYING, and how well EdgeDesk actually knows it.

     Two leagues feed this through ONE shape. The NFL files an official injury
     report and EdgeDesk reads it. College football has no universal report, so
     EdgeDesk builds its own availability layer out of public evidence and
     carries the evidence with it: the source, its confidence, how fresh it is,
     and how much of the field it covers.

     The shape (built by the app, never by this file):
       { status:'ON_FILE'|'NOT_PUBLISHED', source, week, coverage?,
         teams:{ away:{ name, code, filed, dataQuality?, sources_checked?,
                        sources_failed?, official_report_found?, lastUpdated?,
                        players:[{ name, position, status, injury, practice,
                                   confidence?, impact?, source_name?,
                                   source_url?, verified?, contested?,
                                   freshness?, timeline?, observations? }] },
                 home:{ ... } } }

     THE DISTINCTION THIS FILE PROTECTS: "nobody is listed on an official
     report", "EdgeDesk has partial coverage" and "EdgeDesk has no verified
     data" are three different sentences. They are never collapsed, and none of
     them is ever written as "no injuries". */
  var STATUS_RANK = { out: 4, doubtful: 3, game_time_decision: 3, questionable: 2, day_to_day: 2, limited: 1 };
  var STATUS_WORD = { out: 'out', doubtful: 'doubtful', questionable: 'questionable', game_time_decision: 'a game-time decision',
    day_to_day: 'day to day', limited: 'limited', probable: 'probable', expected: 'expected to play', available: 'available' };
  function normTeamName(s) { return normTeam(s); }
  function statusKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z]+/g, '_'); }
  function statusWord(s) { var k = statusKey(s); return STATUS_RANK[k] ? k : null; }
  function statusLabel(s) { var k = statusKey(s); return STATUS_WORD[k] || (k ? k.replace(/_/g, ' ') : null); }
  var QUALITY_COPY = {
    STRONG: 'Strong', PARTIAL: 'Partial', LIMITED: 'Limited', NONE: 'None'
  };
  function sideCoverage(tm) {
    if (!tm) return null;
    var q = tm.dataQuality || null;
    if (!q) return null;
    return { quality: q, label: QUALITY_COPY[q] || q, sources_checked: num(tm.sources_checked), sources_failed: num(tm.sources_failed),
      official: !!tm.official_report_found, last_updated: tm.lastUpdated || null };
  }
  /* The one sentence that says how much EdgeDesk knows, for the whole game. */
  function coverageText(av, sides) {
    if (!av) return null;
    if (av.status === 'NOT_PUBLISHED') return 'No verified availability information found' + (av.reason ? ': ' + av.reason : '') + '.';
    var qs = sides.map(function (s) { return s && s.coverage ? s.coverage.quality : null; }).filter(Boolean);
    if (!qs.length) return null;
    var rank = { STRONG: 4, PARTIAL: 3, LIMITED: 2, NONE: 1 };
    var worst = qs.reduce(function (m, q) { return rank[q] < rank[m] ? q : m; }, qs[0]);
    var official = sides.filter(function (s) { return s && s.coverage && s.coverage.official; }).length;
    var checked = sides.reduce(function (n, s) { return n + ((s && s.coverage && s.coverage.sources_checked) || 0); }, 0);
    if (worst === 'NONE') return 'No verified availability information found for this matchup.';
    if (worst === 'LIMITED') return 'Availability coverage: Limited. EdgeDesk checked ' + checked + ' source' + (checked === 1 ? '' : 's') + ' and found no verified availability information for one side. That is not the same as nobody being hurt.';
    if (worst === 'PARTIAL') return 'Availability coverage: Partial. EdgeDesk found verified information for some players, but college football does not have a universal injury-reporting system.';
    return 'Availability coverage: Strong' + (official ? ' · ' + official + ' official source' + (official === 1 ? '' : 's') : '') + '.';
  }
  function availabilitySummary(av) {
    if (!av || av.status !== 'ON_FILE' || !av.teams) return null;
    var sides = [], listed = [], highImpact = [], worst = 0, anyOfficial = false;
    ['away', 'home'].forEach(function (k) {
      var tm = av.teams[k]; if (!tm) return;
      var cov = sideCoverage(tm);
      if (cov && cov.official) anyOfficial = true;
      var ps = (tm.players || []).filter(function (p) { return statusWord(p.status); });
      var counts = { out: 0, doubtful: 0, questionable: 0, other: 0 };
      ps.forEach(function (p) {
        var w = statusWord(p.status);
        if (counts[w] != null) counts[w]++; else counts.other++;
        worst = Math.max(worst, STATUS_RANK[w] || 0);
        var row = { side: k, team: tm.name || tm.code, name: p.name, position: p.position || null, status: w,
          label: statusLabel(p.status), injury: p.injury || null, practice: p.practice || null,
          confidence: p.confidence || null, impact: p.impact || null, source_name: p.source_name || null,
          source_url: p.source_url || null, verified: p.verified == null ? null : !!p.verified,
          contested: !!p.contested, freshness: p.freshness || null,
          timeline: (p.timeline || []).filter(function (x) { return x && x.day && x.practice_status; }),
          observations: p.observations || [] };
        listed.push(row);
        if (String(p.impact || '').toUpperCase() === 'HIGH') highImpact.push(row);
      });
      var bits = [];
      if (counts.out) bits.push(counts.out + ' out');
      if (counts.doubtful) bits.push(counts.doubtful + ' doubtful');
      if (counts.questionable) bits.push(counts.questionable + ' questionable');
      if (counts.other) bits.push(counts.other + ' listed');
      var label = (tm.code || tm.name || '');
      /* Three different sentences, kept apart on purpose. */
      var say;
      if (tm.filed === false) say = 'no report filed yet';
      else if (bits.length) say = bits.join(', ');
      else if (cov && cov.official) say = 'nobody listed on the official report';
      else if (cov && (cov.quality === 'LIMITED' || cov.quality === 'NONE')) say = 'no verified information found';
      else say = 'nobody listed';
      sides.push({ key: k, label: label, text: label + ': ' + say, coverage: cov, counts: counts, filed: tm.filed !== false, name: tm.name || tm.code || '' });
    });
    listed.sort(function (a, b) {
      var ia = a.impact === 'HIGH' ? 2 : a.impact === 'MEDIUM' ? 1 : 0, ib = b.impact === 'HIGH' ? 2 : b.impact === 'MEDIUM' ? 1 : 0;
      if (ia !== ib) return ib - ia;
      return (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) || String(a.name).localeCompare(String(b.name));
    });
    var cov = coverageText(av, sides);
    return { text: 'Injury report on file (' + (av.source || 'league report') + (av.week ? ', week ' + av.week : '') + '): ' + sides.map(function (s) { return s.text; }).join(' · '),
      sides: sides, listed: listed, high_impact: highImpact, worst: worst, coverage_text: cov, official: anyOfficial,
      last_updated: sides.reduce(function (m, s) { var t2 = s.coverage && s.coverage.last_updated; return (t2 && (!m || String(t2) > String(m))) ? t2 : m; }, null) };
  }
  /* One player, in plain words. Never more than the source said. */
  function playerLine(p) {
    var label = p.label || statusLabel(p.status) || 'on the report';
    var verb = /^(a |the )/.test(label) ? ' is ' : ' is ';
    return p.name + (p.position ? ' (' + p.position + ')' : '') + verb + label
      + (p.injury ? ', ' + String(p.injury).toLowerCase() : '')
      + (p.practice && /did not/i.test(p.practice) ? ', did not practice' : p.practice && /limited/i.test(p.practice) ? ', limited in practice' : '')
      + '.';
  }
  /* The practice trail, only for days a source actually reported. */
  function timelineText(p) {
    if (!p || !p.timeline || !p.timeline.length) return null;
    return p.timeline.map(function (x) { return x.day + ' ' + String(x.practice_status).toLowerCase().replace('dnp', 'did not practice'); }).join(' · ');
  }
  /* How long ago a timestamp was, in the card's own words. */
  function agoText(at) { var ms = toMs(at); if (ms == null) return null; return ageText((Date.now() - ms) / 60000); }
  /* Provenance, for the receipt. */
  function sourceText(p) {
    if (!p) return null;
    var bits = [];
    if (p.source_name) bits.push(p.source_name);
    if (p.confidence) bits.push(String(p.confidence).toLowerCase());
    if (p.freshness && p.freshness !== 'LIVE' && p.freshness !== 'CURRENT') bits.push(String(p.freshness).toLowerCase());
    return bits.length ? bits.join(' · ') : null;
  }

  /* ============================== THE PUBLIC LANGUAGE LAYER ==============================
     LEVEL 1 (decision) and LEVEL 2 (why) copy, for a person who has never
     heard of de-vigging, fair lines, EV, CLV or a sharp book.

     THE RULE HERE IS THE RULE EVERYWHERE: nothing below computes, adjusts or
     overrides a probability, fair price, edge, verdict or threshold. Every
     number arrives from the engine. What changes is only how it is SAID.

     Two things this layer refuses to do, because the engine does not own them:
       · It never states a fair SPREAD or a fair TOTAL. EdgeDesk owns a fair
         PRICE on the line the book is offering, not a line of its own, so a
         spread card compares PRICES on that spread and says so.
       · It never turns a price into a chance of winning. A long price is
         described as "a payout a book posts on a result it sees as unlikely",
         never as a probability, so the card can never be read as a forecast.
     ====================================================================================== */

  /* Each analytical concept, once, with the words the public surfaces use.
     `short` is the label; `simple` is the sentence behind the ⓘ; `guard` is
     the misconception it has to stop. Nothing here is auto-inserted into copy:
     the copy builders below reference these deliberately. */
  var CONCEPTS = {
    edgedesk_comparison: {
      internal_name: 'sharp_fair / fair price',
      short: 'EdgeDesk comparison',
      simple: 'EdgeDesk’s estimate of what this bet should pay, once the sportsbook’s built-in cut is taken out of the prices on the board.',
      detail: 'Every sportsbook price includes a margin for the house. EdgeDesk strips that out across the books quoting the game and lands on one comparison number.',
      guard: 'It is an estimate of a price, not a prediction of who wins.',
      example: 'The book offers +1400. EdgeDesk’s comparison is about +1237. The book is paying more than EdgeDesk expected.'
    },
    benchmark_book: {
      internal_name: 'sharp reference (Pinnacle)',
      short: 'Benchmark sportsbook',
      simple: 'One sportsbook EdgeDesk treats as a reality check, because its prices move quickly when informed money shows up.',
      detail: 'When that book is posting a price on the exact bet, EdgeDesk has a live number to compare against. When it is not, the comparison is built from the other books, which is a weaker check.',
      guard: 'It does not mean that book is right. It means it is the toughest single number to disagree with.'
    },
    price_limit: {
      internal_name: 'max_playable',
      short: 'Price limit',
      simple: 'The worst price at which EdgeDesk still sees enough value. Past it, the same bet is no longer worth it.',
      detail: 'The bet and the price are one thing. Change the price and the answer changes, with nothing else about the game moving.',
      guard: 'It is not a prediction of where the price will go.'
    },
    book_count: {
      internal_name: 'n_books',
      short: 'Books quoting it',
      simple: 'How many sportsbooks were posting a price on this bet when EdgeDesk looked.',
      detail: 'More books means the comparison rests on a crowd rather than on one book with a slow or unusual number.',
      guard: 'It does not mean those books agree with EdgeDesk.'
    },
    beat_the_close: {
      internal_name: 'CLV / closing line value',
      short: 'Price vs the final number',
      simple: 'Whether the price EdgeDesk flagged was better than the price the market settled on right before kickoff.',
      detail: 'Over many calls this is the only honest scoreboard for a research tool: winning one bet can be luck, consistently buying a better number than the market closes at cannot.',
      guard: 'It says nothing about whether that particular bet won.'
    },
    verdict: {
      internal_name: 'display_verdict',
      short: 'The call',
      simple: 'EdgeDesk’s answer on the bet AND the price together: BET, LEAN, WAIT or PASS.',
      detail: 'BET and LEAN mean the price clears the bar. WAIT means something is missing or out of date. PASS means EdgeDesk looked and does not see enough at this price.',
      guard: 'It is a judgement about the price, never a prediction of the result.'
    },
    data_check: {
      internal_name: 'evidence integrity',
      short: 'Data check',
      simple: 'EdgeDesk checking its own inputs before it says anything. If the check fails, no call is published.',
      guard: 'A failed check is not a bad bet. It is EdgeDesk refusing to answer.'
    },
    price_age: {
      internal_name: 'freshness / stale_min',
      short: 'Price age',
      simple: 'When EdgeDesk last saw this price at the sportsbook. Odds move, so an old price may not be there any more.',
      guard: 'An old price is not a wrong price. It is an unconfirmed one.'
    }
  };
  function concept(k) { return CONCEPTS[k] || null; }

  /* What a score is called in this sport. */
  function scoreUnit(sportKey) {
    var k = String(sportKey == null ? '' : sportKey).toLowerCase();
    if (k.indexOf('baseball') === 0) return 'runs';
    if (k.indexOf('icehockey') === 0 || k.indexOf('soccer') === 0) return 'goals';
    return 'points';
  }
  /* Which price pays better. Decimal comparison, so it works across the
     +100 / -100 boundary. DISPLAY ONLY — never fed back into anything. */
  function betterOf(aAm, bAm) {
    var a = americanToDec(aAm), b = americanToDec(bAm);
    if (a == null || b == null) return null;
    if (Math.abs(a - b) < 1e-9) return 0;
    return a > b ? 1 : -1;
  }
  /* The payout, in dollars, straight off the price. Nothing is estimated. */
  function payoutLine(am) {
    var a = num(am);
    if (a == null || a === 0) return null;
    if (a > 0) return 'A $100 bet returns $' + Math.round(a).toLocaleString('en-US') + ' in profit if it wins.';
    return 'You risk $' + Math.round(-a).toLocaleString('en-US') + ' to win $100.';
  }
  /* Which way "better" runs at this price, said once so nobody has to know. */
  function betterHint(am) {
    var a = parseAmerican(am);
    if (a == null) return null;
    return a > 0 ? '“Better” here means a bigger payout — a higher + number.'
                 : '“Better” here means a cheaper price — a − number closer to zero.';
  }

  /* -------- WHAT THE BET ACTUALLY IS, in the words a fan already owns ------ */
  /* o: { market_key, selection_raw, point, home, away, sport_key }
     Short enough to be a headline. The tie/push rule is real and a beginner
     needs it, but it is a footnote, not the sentence — see pushNote(). */
  function betLine(o) {
    o = o || {};
    var m = String(o.market_key == null ? '' : o.market_key).toLowerCase().trim();
    var team = clean(o.selection_raw || '');
    var p = num(o.point);
    var unit = scoreUnit(o.sport_key);
    if (m === 'totals' || m === 'total') {
      if (p == null) return null;
      return (/^over/i.test(team) ? 'More than ' : 'Fewer than ') + p + ' total ' + unit + ', both teams combined';
    }
    if (!team) return null;
    var side = (o.home || o.away) ? sideOf(team, o.home, o.away) : null;
    var opp = side === 'home' ? o.away : side === 'away' ? o.home : null;
    if (m === 'spreads' || m === 'spread') {
      if (p == null) return team + ' with the points';
      if (Math.abs(p) < 1e-9) return team + ' to win outright';
      var whole = Math.abs(p % 1) < 1e-9;
      if (p < 0) {
        var need = Math.abs(p);
        return whole ? team + ' to win by more than ' + need + ' ' + unit
                     : team + ' to win by ' + Math.ceil(need) + ' ' + unit + ' or more';
      }
      return whole ? team + ' to lose by fewer than ' + p + ' ' + unit + ', or win outright'
                   : team + ' to lose by ' + Math.floor(p) + ' ' + unit + ' or fewer, or win outright';
    }
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') return opp ? team + ' to beat ' + opp : team + ' to win';
    return p != null ? team + ' ' + (p > 0 ? '+' : '') + p : team;
  }
  /* The one rule nobody explains to a first-time bettor: a whole-number line
     can land exactly, and the stake comes back. Only ever said when it can
     actually happen. */
  function pushNote(o) {
    o = o || {};
    var m = String(o.market_key == null ? '' : o.market_key).toLowerCase().trim();
    var p = num(o.point);
    var unit = scoreUnit(o.sport_key);
    if (p == null) return null;
    var whole = Math.abs(p % 1) < 1e-9;
    if (m === 'totals' || m === 'total') return whole ? 'If the combined score lands on exactly ' + p + ', the bet is refunded.' : null;
    if (m === 'spreads' || m === 'spread') {
      if (Math.abs(p) < 1e-9) return 'If the game ends level, the bet is refunded.';
      return whole ? 'If the game is decided by exactly ' + Math.abs(p) + ' ' + unit + ', the bet is refunded.' : null;
    }
    return null;
  }
  /* The line to look for at the sportsbook, exactly as it is printed there. */
  function ticketLine(o) {
    o = o || {};
    var mk = marketLabel(o.market_key);
    var sel = selectionLabel(o.market_key, o.selection_raw, o.point);
    if (/^(h2h|ml|moneyline)$/i.test(String(o.market_key || '')) && sel) sel = sel.replace(/\s+ML$/, '');
    if (!mk && !sel) return null;
    return [mk, sel].filter(Boolean).join(' · ');
  }

  /* --------------- WHAT EDGEDESK FOUND: two prices, side by side ---------- */
  /* Only prices are compared, because only a price is owned. On a spread or a
     total the LINE is the sportsbook's and EdgeDesk never proposes its own. */
  function priceCompare(o) {
    o = o || {};
    var cur = parseAmerican(o.current_am), fair = parseAmerican(o.fair_am);
    var bet = o.bet_line || null;
    var edgePct = num(o.edge) != null ? Math.round(num(o.edge) * 1000) / 10 : null;
    if (cur == null) {
      return { have: false, rows: [], sentence: 'No live price is on file for this bet, so there is nothing to compare yet.', detail: null, direction: null };
    }
    var curS = fmtAmerican(cur);
    if (fair == null) {
      return { have: false, direction: null,
        rows: [{ k: 'Your sportsbook', v: curS, note: o.book || null }, { k: 'EdgeDesk comparison', v: 'Not on file', note: null }],
        sentence: 'The price on offer is ' + curS + '. EdgeDesk has no comparison price on file for this bet, so it cannot say whether that is generous or not.',
        detail: null };
    }
    var fairS = fmtAmerican(fair);
    var dir = betterOf(cur, fair);
    var plus = cur > 0;
    var move = dir === 1 ? (plus ? 'is paying more than EdgeDesk expected' : 'is charging less than EdgeDesk expected')
      : dir === -1 ? (plus ? 'is paying less than EdgeDesk expected' : 'is charging more than EdgeDesk expected')
      : 'matches what EdgeDesk expected';
    var diffWord = dir === 1 ? (plus ? 'Paying more than expected' : 'Costing less than expected')
      : dir === -1 ? (plus ? 'Paying less than expected' : 'Costing more than expected')
      : 'The same';
    return {
      have: true, direction: dir === 1 ? 'better' : dir === -1 ? 'worse' : 'same',
      rows: [
        { k: 'Your sportsbook', v: curS, note: o.book || null },
        { k: 'EdgeDesk comparison', v: 'about ' + fairS, note: null },
        { k: 'Difference', v: diffWord, note: null }
      ],
      sentence: (bet ? bet + ' is available at ' + curS + '. ' : 'The price on offer is ' + curS + '. ')
        + 'EdgeDesk’s comparison price for the same bet is about ' + fairS + ', so this sportsbook ' + move + '.',
      detail: edgePct != null ? 'Measured difference: ' + (edgePct > 0 ? edgePct : Math.abs(edgePct)) + '%.' : null
    };
  }

  /* ----------------- THE GUARD: value is not a prediction ----------------- */
  /* Deterministic, from the price alone. A long payout must never be read as
     "EdgeDesk thinks the underdog wins", and a short one must never be read as
     "EdgeDesk thinks the favourite is a good bet". */
  var LONGSHOT_AM = 250;        /* a clear underdog on the moneyline */
  var HEAVY_LONGSHOT_AM = 700;  /* the +1400 shape */
  var LONGSHOT_OTHER_AM = 400;  /* a long price on a spread or a total */
  var HEAVY_FAVOURITE_AM = -250;
  function longShotGuard(o) {
    o = o || {};
    var am = parseAmerican(o.current_am);
    if (am == null) return null;
    var m = String(o.market_key == null ? '' : o.market_key).toLowerCase().trim();
    var ml = (m === 'h2h' || m === 'ml' || m === 'moneyline');
    var team = clean(o.team || '') || 'This side';
    var odds = fmtAmerican(am);
    if (ml && am >= LONGSHOT_AM) {
      var heavy = am >= HEAVY_LONGSHOT_AM;
      return { kind: heavy ? 'HEAVY_UNDERDOG' : 'UNDERDOG',
        text: team + ' is ' + (heavy ? 'a heavy' : 'a clear') + ' underdog here'
          + (o.opponent ? ' against ' + o.opponent : '') + '. EdgeDesk is judging the PRICE, not predicting an upset. '
          + 'A payout like ' + odds + ' is what a sportsbook posts on a result it sees as unlikely — EdgeDesk is only saying that payout looks larger than the rest of the market justifies.' };
    }
    if (!ml && am >= LONGSHOT_OTHER_AM) {
      return { kind: 'LONG_PRICE',
        text: 'This is a long-shot price. A payout like ' + odds + ' is what a sportsbook posts on a result it sees as unlikely. EdgeDesk is judging that payout, not predicting the outcome.' };
    }
    if (ml && am <= HEAVY_FAVOURITE_AM) {
      return { kind: 'FAVOURITE',
        text: team + ' is a strong favourite here, so the payout is small: at ' + odds + ' you risk $' + Math.round(-am) + ' to win $100. '
          + 'EdgeDesk is judging what that costs, not predicting the winner.' };
    }
    return null;
  }

  /* --------------------- THE VERDICT, in plain English -------------------- */
  var VERDICT_PLAIN = {
    BET: { subtitle: 'EdgeDesk likes the price on offer.' },
    LEAN: { subtitle: 'Worth a look, but the case is not strong enough to call it a bet.' },
    WAIT: { subtitle: 'There may be value here, but something still has to be confirmed.' },
    PASS: { subtitle: 'Not worth it at this price.' },
    FAILED: { subtitle: 'EdgeDesk does not trust its own data here, so it is not making a call.' },
    NONE: { subtitle: 'EdgeDesk has no call on file for this bet.' }
  };
  function verdictPlain(o) {
    o = o || {};
    var key = o.suppressed ? 'FAILED' : (VERDICT_PLAIN[o.verdict] ? o.verdict : 'NONE');
    var sub = VERDICT_PLAIN[key].subtitle;
    var label = key === 'FAILED' ? 'DATA CHECK FAILED' : key === 'NONE' ? 'NO CALL' : key;
    var answer;
    if (key === 'FAILED') answer = 'EdgeDesk will not make a call here until a problem with its own data is fixed.';
    else if (key === 'NONE') answer = 'EdgeDesk has nothing on file for this bet.';
    else if (o.no_price) answer = 'No live price on file yet, so there is nothing to judge.';
    else if (key === 'BET') answer = 'The price clears EdgeDesk’s bar right now.';
    else if (key === 'LEAN') answer = 'Something is here, but not enough to call it a bet.';
    else if (key === 'WAIT') answer = o.stale ? 'Interesting price. It needs a fresh check before EdgeDesk trusts it.' : 'Interesting price. Not confirmed yet.';
    else answer = o.needs_odds ? 'It would take ' + o.needs_odds + ' or better to be worth a look.' : 'EdgeDesk looked and does not see enough here.';
    return { key: key, label: label, subtitle: sub, answer: answer };
  }

  /* ---------------------- THE PRICE LIMIT, in plain English --------------- */
  function priceLimitPlain(play) {
    play = play || {};
    var lim = play.limit_odds || null;
    if (play.kind === 'NEEDS') {
      return { label: 'Price needed', value: lim + ' or better', limit_odds: lim, hint: betterHint(lim),
        sentence: 'At the price on offer now, EdgeDesk sees no value. It would take ' + lim + ' or better to change that.' };
    }
    if (play.kind === 'LIMIT') {
      return { label: 'Price limit', value: lim + ' or better', limit_odds: lim, hint: betterHint(lim),
        sentence: 'EdgeDesk’s limit for this bet is ' + lim + '. The price on offer is worse than that, so there is nothing to take.' };
    }
    if (play.kind === 'GOOD_TO') {
      return { label: 'Price limit', value: lim + ' or better', limit_odds: lim, hint: betterHint(lim),
        sentence: 'EdgeDesk still sees value down to ' + lim + '. Worse than that and the value is gone.' };
    }
    return { label: 'Price limit', value: 'Not set', limit_odds: null, hint: null,
      sentence: 'EdgeDesk has no comparison price on file for this bet, so there is no limit yet.' };
  }

  /* ------------------- THE MARKET CHECK, said as what it is --------------- */
  /* has_sharp: the benchmark book is posting a price on THIS EXACT side.
     n_books:   how many sportsbooks were quoting this market at capture.
     Neither is evidence about the teams, and neither is stated as such. */
  function marketCheckPlain(o) {
    o = o || {};
    var lines = [];
    if (o.has_sharp === true) lines.push('The sportsbook EdgeDesk uses as its benchmark is posting a price on this exact bet, so the comparison is against a live number rather than an estimate.');
    else if (o.has_sharp === false) lines.push('EdgeDesk’s benchmark sportsbook is not posting a price on this exact bet, so the comparison had to be built from the other sportsbooks. That is a weaker check.');
    var nb = num(o.n_books);
    if (nb != null) {
      if (nb >= 5) lines.push(nb + ' sportsbooks were quoting this game when EdgeDesk looked, so the comparison is not resting on one unusual book.');
      else if (nb >= 2) lines.push('Only ' + nb + ' sportsbooks were quoting this, which is a thin market. One odd price can pull the comparison around.');
      else if (nb === 1) lines.push('Only one sportsbook was quoting this, so there is nothing to compare it against.');
      else lines.push('No other sportsbook prices were on file for this bet.');
    }
    var ps = o.price_status || {};
    if (ps.kind === 'MOVED' && ps.was && ps.now) lines.push('The price has moved from ' + ps.was + ' to ' + ps.now + ' since EdgeDesk first flagged it.');
    else if (ps.kind === 'PAST_LIMIT') lines.push('The price has moved since EdgeDesk first looked' + (ps.was && ps.now ? ', from ' + ps.was + ' to ' + ps.now : '') + ', and it is now past the point where EdgeDesk sees value.');
    if (o.book && o.trusted === false) lines.push('The best price is at an offshore sportsbook, which is harder to reach and less protected than a US-licensed one.');
    return { lines: lines, text: lines.join(' ') || 'EdgeDesk has no market read on file for this bet.' };
  }

  /* --------------- ENGINE REASONS -> SEMANTIC FACTS -> SENTENCES ---------- */
  /* The engine decides WHICH reasons are true. This decides how each one is
     said, and says it from the packet's own numbers rather than by rewriting
     the engine's string. An unrecognised reason still falls through to
     plainReason(), so a new engine reason degrades to the old behaviour
     instead of disappearing. */
  var REASON_KINDS = [
    [/estimated edge vs/i, 'EDGE_VS_FAIR'],
    [/pinnacle \(sharp reference\) is quoting this side/i, 'SHARP_CONFIRMED'],
    [/best price is at a us-regulated book/i, 'REGULATED'],
    [/^\s*(\d+) books? behind the fair line\s*$/i, 'BOOK_COUNT'],
    [/corroborated across (\d+) sharp level/i, 'CORROBORATED'],
    [/(this signal )?beat the close \(clv/i, 'BEAT_CLOSE'],
    [/failed to beat the close/i, 'MISSED_CLOSE'],
    [/best price is offshore and only (\d+) books?/i, 'OFFSHORE_THIN'],
    [/offshore best price is not actually available/i, 'OFFSHORE_SIZE'],
    [/best price is offshore/i, 'OFFSHORE'],
    [/only (\d+) books? quot/i, 'THIN'],
    [/priced (\d+)m ago/i, 'AGING'],
    [/stale: last re-priced (\d+)m ago/i, 'STALE'],
    [/last re-priced (\d+)m ago\. treat as stale/i, 'STALE'],
    [/the last capture \((\d+)m ago\) is stale/i, 'STALE'],
    [/qualified on the last number, but it was captured (\d+)m ago/i, 'STALE_QUALIFIED'],
    [/edge this large/i, 'TOO_GOOD'],
    [/detection edge has already decayed \((\d+)% remains\)/i, 'DECAYED'],
    [/price keeps moving against you/i, 'PRICE_WINDOW'],
    [/pinnacle never prints this side/i, 'NO_SHARP'],
    [/no sharp \(pinnacle\) confirmation on this exact side/i, 'NO_SHARP'],
    [/mlb caveat: lineups are probable/i, 'LINEUPS'],
    [/late scratch or lineup change/i, 'LINEUPS'],
    [/a probable starter is still missing/i, 'NO_STARTER'],
    [/nothing structural stands out/i, 'NOTHING_STANDS_OUT'],
    [/the edge existed at detection/i, 'PRICE_MOVED_PAST'],
    [/current price is below fair/i, 'BELOW_FAIR'],
    [/no fair price (is on file|available)/i, 'NO_FAIR'],
    [/clears the bar with real liquidity/i, 'CLEARS_BAR'],
    [/positive and qualifying, but with caveats/i, 'QUALIFIES_WITH_CAVEATS']
  ];
  function reasonKind(s) {
    var t = clean(s);
    if (!t) return null;
    for (var i = 0; i < REASON_KINDS.length; i++) {
      var m = t.match(REASON_KINDS[i][0]);
      if (m) return { kind: REASON_KINDS[i][1], m: m };
    }
    return null;
  }
  /* f: the semantic facts pulled off the packet in simpleFromPacket. */
  function plainFor(kind, m, f) {
    f = f || {};
    var cmp = f.compare || {};
    switch (kind) {
      case 'EDGE_VS_FAIR':
      case 'CLEARS_BAR':
        /* priceCompare() has an honest sentence for every state, including
           "no comparison price on file" and "no live price on file", so this
           never falls back to the engine's own wording. */
        return cmp.sentence || null;
      case 'SHARP_CONFIRMED':
        return 'The sportsbook EdgeDesk uses as its benchmark is posting a price on this exact bet, so the comparison is against a live number rather than an estimate.';
      case 'NO_SHARP':
        return 'EdgeDesk’s benchmark sportsbook is not posting a price on this exact bet, so the comparison had to be built from the other sportsbooks. That is a weaker check.';
      case 'REGULATED':
        return 'The best price is at a sportsbook licensed and regulated in the US, so it is a price an ordinary bettor can actually get.';
      case 'BOOK_COUNT':
        return (f.n_books != null ? f.n_books : m[1]) + ' sportsbooks were quoting this game when EdgeDesk looked, so the comparison is not resting on one unusual book.';
      case 'CORROBORATED':
        return 'Other sportsbooks are pricing this the same way rather than one book sitting alone, which makes the gap look less like a single stuck number.';
      case 'BEAT_CLOSE':
        return 'EdgeDesk flagged this at a better price than the market finished at before kickoff.';
      case 'MISSED_CLOSE':
        return 'The market finished at a better price than the one EdgeDesk flagged, so the number moved the wrong way.';
      case 'OFFSHORE':
        return 'The best price is at an offshore sportsbook, which is harder to reach and less protected than a US-licensed one.';
      case 'OFFSHORE_SIZE':
        return 'The offshore price may not really be available to you, or not for much money.';
      case 'OFFSHORE_THIN':
        return 'The best price is offshore and only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet. That is too thin to trust.';
      case 'THIN':
        return 'Only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet, so the comparison rests on very little.';
      case 'AGING':
        return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Check the sportsbook is still showing it.';
      case 'STALE':
        return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Odds move quickly, so the real number may be worse by now.';
      case 'STALE_QUALIFIED':
        return 'The price qualified when EdgeDesk last saw it, but that was ' + m[1] + ' minutes ago. A fresh check has to show it is still there.';
      case 'TOO_GOOD':
        return 'A gap this big is usually a price that is out of date or simply wrong, not a gift. It normally disappears the moment the sportsbook notices.';
      case 'DECAYED':
        return 'Most of the gap EdgeDesk originally spotted has already closed. About ' + m[1] + '% of it is left.';
      case 'PRICE_WINDOW':
        return f.limit_odds ? 'The value lives in the price. Past ' + f.limit_odds + ' there is nothing left to buy.' : 'The value lives in the price, and it disappears once the price moves far enough.';
      case 'LINEUPS':
        return 'Lineups here are expected, not confirmed. One late change moves the price.';
      case 'NO_STARTER':
        return 'A probable starter is still missing for this game, and the starter is the single biggest input in the number.';
      case 'NOTHING_STANDS_OUT':
        return 'Nothing structural stands out against it, which is a reason to treat it normally rather than press.';
      case 'PRICE_MOVED_PAST':
        return f.compare && f.compare.have
          ? 'The gap was there when EdgeDesk first looked, but the price has moved since and there is no longer enough in it.'
          : 'The price has moved since EdgeDesk first looked, and there is no longer enough in it.';
      case 'BELOW_FAIR':
        return 'The price on offer is worse than EdgeDesk’s comparison price, so there is nothing to take here.';
      case 'NO_FAIR':
        return 'EdgeDesk has no comparison price on file for this bet, so there is nothing to judge the number against.';
      case 'QUALIFIES_WITH_CAVEATS':
        return 'The number clears EdgeDesk’s bar, but with caveats worth reading before acting.';
      default:
        return null;
    }
  }
  /* One engine reason -> one public sentence. Semantic first, dictionary last. */
  function publicReason(s, f) {
    var rk = reasonKind(s);
    if (rk) {
      var out = plainFor(rk.kind, rk.m, f);
      if (out) return out;
    }
    return plainReason(s);
  }

  /* ------------------------------------------------------------------ SIMPLE */
  /* The client packet shape (askAI / EDAI.packetOf) is the contract:
       { game:{matchup,sport,sport_key,commence,away,home,event_id},
         market, market_key, selection, selection_raw, point,
         prices:{detect,current,fair,fair_src,best_seen,max_playable,pinnacle,book,trusted},
         edge:{detect,current,ev,remaining,floor},
         confirmation:{has_sharp,n_books,n_books_eff,corrob,book,trusted},
         timing:{stale_min,last_seen_at,research_at},
         price_sensitivity:{breakeven,max_playable,needs_price_for_ev},
         deterministic:{verdict,display_verdict,is_wait,wait_reason,confidence,why,score,band,
                        reasons_for,reasons_against,falsifiers} }
     All prices in the packet are ALREADY American (the engine's own display
     transform). Decimal inputs are accepted too and converted for display. */
  function simpleFromPacket(p, ctx) {
    p = p || {}; ctx = ctx || {};
    var det = p.deterministic || {};
    var prices = p.prices || {};
    var ps = p.price_sensitivity || {};
    var edge = p.edge || {};
    var conf = p.confirmation || {};
    var timing = p.timing || {};
    var game = p.game || {};
    var now = toMs(ctx.now) != null ? toMs(ctx.now) : Date.now();

    var engineVerdict = normVerdict(det.verdict);
    var verdict = normVerdict(det.display_verdict) || engineVerdict;
    var integ = integrityStatus(ctx.integrity || p.integrity || null);

    var curAm = num(prices.current) != null ? num(prices.current) : decToAmerican(prices.current_dec);
    var detAm = num(prices.detect) != null ? num(prices.detect) : decToAmerican(prices.detect_dec);
    var fairAm = num(prices.fair) != null ? num(prices.fair) : decToAmerican(prices.fair_dec);
    var maxAm = num(ps.max_playable) != null ? num(ps.max_playable) : (num(prices.max_playable) != null ? num(prices.max_playable) : decToAmerican(prices.max_playable_dec));
    var needsAm = num(ps.needs_price_for_ev);
    var beAm = num(ps.breakeven) != null ? num(ps.breakeven) : fairAm;
    var book = clean(prices.book || conf.book || '') || null;
    var trusted = (prices.trusted != null) ? !!prices.trusted : (conf.trusted != null ? !!conf.trusted : null);

    var marketKey = p.market_key || p.market || null;
    var selectionRaw = p.selection_raw || p.selection || null;
    var selLabel = p.selection_raw ? selectionLabel(marketKey, selectionRaw, p.point) : (p.selection ? clean(p.selection) : null);
    if (selLabel && /^(h2h|ml|moneyline)$/i.test(String(marketKey || '')) && !/\bML$/.test(selLabel)) selLabel += ' ML';
    var mktLabel = marketLabel(marketKey) || (p.market ? String(p.market) : null);

    var priceAt = timing.last_seen_at != null ? toMs(timing.last_seen_at)
      : (num(timing.stale_min) != null ? now - num(timing.stale_min) * 60000 : null);
    var fr = freshness({ price_at: priceAt, research_at: timing.research_at || ctx.research_at || null, now: now,
      stale_min: num(ctx.stale_limit_min) != null ? num(ctx.stale_limit_min) : num(timing.stale_limit_min) });

    var play = playable({ verdict: verdict, max_playable_am: maxAm, needs_price_am: needsAm });
    var pst = priceStatus({ verdict: verdict, detect_am: detAm, current_am: curAm, max_playable_am: maxAm,
      edge: edge.current, detect_edge: edge.detect, floor: edge.floor, freshness: fr });

    /* ---- suppression: integrity FAIL never shows a recommendation ---- */
    var suppressed = false, displayVerdict = verdict;
    if (integ.status === 'FAILED' && (verdict === 'BET' || verdict === 'LEAN')) { suppressed = true; displayVerdict = 'WAIT'; }
    if (verdict == null) { displayVerdict = null; }

    var odds = fmtAmerican(curAm);
    var noPrice = curAm == null;

    /* ---- the public facts every plain sentence is built from ----
       Nothing new is computed here: these are the engine's own numbers,
       arranged so the copy below can be written from FACTS rather than by
       rewriting the engine's strings. */
    var pubBet = betLine({ market_key: marketKey, selection_raw: selectionRaw, point: p.point, home: game.home, away: game.away, sport_key: game.sport_key });
    var pubTicket = ticketLine({ market_key: marketKey, selection_raw: selectionRaw, point: p.point });
    var pubPush = pushNote({ market_key: marketKey, point: p.point, sport_key: game.sport_key });
    var pickSideKey = (selectionRaw && (game.home || game.away)) ? sideOf(selectionRaw, game.home, game.away) : null;
    var opponent = pickSideKey === 'home' ? (game.away || null) : pickSideKey === 'away' ? (game.home || null) : null;
    var compare = priceCompare({ current_am: curAm, fair_am: fairAm, edge: edge.current, book: book, bet_line: pubBet });
    var guard = longShotGuard({ current_am: curAm, market_key: marketKey, team: selectionRaw, opponent: opponent });
    var facts = { compare: compare, n_books: num(conf.n_books), limit_odds: play.limit_odds, bet_line: pubBet, book: book };

    /* ---- deterministic copy ---- */
    var whyRaw = (det.reasons_for || []).slice();
    var why = [];
    whyRaw.forEach(function (r) { var s = publicReason(r, facts); if (s && why.indexOf(s) < 0) why.push(s); });
    if (!why.length && det.why) why.push(publicReason(det.why, facts));
    /* Strongest drivers only: the engine lists them in priority order. */
    why = why.slice(0, 3).map(function (t) { return { text: t, source: 'deterministic', evidence_ids: [] }; });

    var availability = ctx.availability || p.availability || null;
    var avail = availabilitySummary(availability);
    var gapsIn = (ctx.gaps || p.gaps || []).filter(function (g) {
      /* an injury report on file is not a gap; an unpublished one still is */
      var k = String(g && (g.field || g) || '').toLowerCase();
      return !(avail && /injur|availab/.test(k));
    });
    if (availability && availability.status === 'NOT_PUBLISHED' && !gapsIn.some(function (g) { return /injur/.test(String(g && (g.field || g) || '')); })) gapsIn.push('injury_report');
    var gaps = gapSentences(gapsIn);
    if (availability && availability.status === 'NOT_PUBLISHED' && availability.reason) gaps = gaps.map(function (s) { return /injury and availability/i.test(s) ? 'Injury and availability data is not on file: ' + availability.reason + '. Do not read that as a clean injury report.' : s; });
    var against = (det.reasons_against || []).map(function (r) { return publicReason(r, facts); }).filter(Boolean);
    var fals = (det.falsifiers || []).map(function (r) { return publicReason(r, facts); }).filter(Boolean);
    var watchText, changeText;
    if (displayVerdict === 'WAIT' && (det.is_wait || suppressed)) {
      watchText = suppressed ? sentence('EdgeDesk will not publish a call until it fixes a problem with its own data: ' + (integ.reason_plain || 'a check on its own data failed'))
        : (det.wait_reason ? publicReason(det.wait_reason, facts) : 'Something still needs to confirm before this is a decision.');
      changeText = suppressed ? 'A clean data check would restore the decision.'
        : (play.limit_odds
            ? 'A fresh check at the sportsbook showing ' + play.limit_odds + ' or better, with no late lineup surprise, would turn this into a live call.'
            : 'A fresh look at the sportsbook price, or a confirmed lineup, would settle it.');
    } else if (displayVerdict === 'PASS') {
      watchText = det.why ? publicReason(det.why, facts) : 'EdgeDesk does not see enough value at the current price.';
      changeText = needsAm != null ? 'It becomes interesting again at ' + fmtAmerican(needsAm) + ' or better.'
        : (fals[0] || 'A better price would be needed for EdgeDesk to reconsider.');
    } else {
      watchText = against[0] || fals[0] || 'Nothing structural stands out.';
      changeText = fals[0] || 'A worse price would weaken the case.';
    }
    /* An actionable call must carry the availability caveat in its own watch
       line; a PASS or WAIT already leads with a stronger reason, and the gap
       still shows as a flag on the card. */
    if (gaps.length && /injur|availab/i.test(gaps[0]) && !/injur/i.test(watchText)
      && (displayVerdict === 'BET' || displayVerdict === 'LEAN')) watchText = gaps[0] + ' ' + watchText;
    /* A listed player on the side being backed leads the watch line; an
       opponent's absence is a watch line too, said as the opponent's. */
    if (avail && avail.listed.length && (displayVerdict === 'BET' || displayVerdict === 'LEAN' || displayVerdict === 'WAIT')) {
      var pickSide = (selectionRaw && game.home && normTeamName(selectionRaw) === normTeamName(game.home)) ? 'home' : (selectionRaw && game.away && normTeamName(selectionRaw) === normTeamName(game.away)) ? 'away' : null;
      /* The side being backed leads. A high-impact absence outranks a
         questionable rotation player on either side. */
      var material = avail.listed.filter(function (x) { return x.impact === 'HIGH' || x.status === 'out' || x.status === 'doubtful'; });
      var mine = material.filter(function (x) { return pickSide && x.side === pickSide; });
      var theirs = material.filter(function (x) { return !pickSide || x.side !== pickSide; });
      var lead = mine.length ? playerLine(mine[0]) + (mine.length > 1 ? ' ' + (mine.length - 1) + ' more on the same side listed.' : '')
        : (theirs.length ? 'For the other side, ' + playerLine(theirs[0]).charAt(0).toLowerCase() + playerLine(theirs[0]).slice(1) : '');
      if (lead && !/\bis (out|doubtful)\b/i.test(watchText)) watchText = lead + ' ' + watchText;
    }

    var headline;
    if (suppressed) headline = sentence('DATA CHECK FAILED: EdgeDesk will not publish a call until it fixes a problem with its own data: ' + (integ.reason_plain || 'a check on its own data failed'));
    else if (displayVerdict == null) headline = 'EdgeDesk has no decision on file for this selection.';
    else if (noPrice) headline = 'WAIT: no current price is on file for ' + (selLabel || 'this selection') + '.';
    else if (displayVerdict === 'BET') headline = 'BET: ' + selLabel + ' at ' + odds + '.';
    else if (displayVerdict === 'LEAN') headline = 'LEAN: ' + selLabel + ' at ' + odds + '. Positive, with caveats.';
    else if (displayVerdict === 'WAIT') headline = 'WAIT: ' + selLabel + ' at ' + odds + '. Something still needs to confirm.';
    else headline = 'PASS: EdgeDesk does not see enough value in ' + (selLabel || 'this selection') + ' at ' + odds + '.';
    if (noPrice && displayVerdict != null && !suppressed) displayVerdict = 'WAIT';

    var flags = [];
    if (suppressed) flags.push({ kind: 'DATA_CHECK_FAILED', text: 'Data check failed' + (integ.reason ? ': ' + integ.reason : '') });
    else if (integ.status === 'PROVISIONAL') flags.push({ kind: 'PROVISIONAL', text: 'Provisional' + (integ.reason ? ': ' + integ.reason : ': some of the underlying data needs verification') });
    if (fr.status === 'STALE') flags.push({ kind: 'STALE_PRICE', text: 'Price needs refreshing (' + fr.price_text.replace(/^Price updated /, '') + ')' });
    else if (fr.status === 'UNKNOWN' && !noPrice) flags.push({ kind: 'PRICE_AGE_UNKNOWN', text: 'Price age unknown' });
    if (noPrice) flags.push({ kind: 'NO_PRICE', text: 'No current price on file' });
    if (book && trusted === false) flags.push({ kind: 'OFFSHORE', text: 'Best price is at an offshore book' });
    gaps.forEach(function (g) { flags.push({ kind: 'DATA_GAP', text: g.split('. ')[0].replace(/\.$/, '') }); });
    if (avail) flags.push({ kind: 'AVAILABILITY', text: avail.text.replace(/^Injury report on file \([^)]*\): /, 'Availability: '), severity: avail.worst >= 2 ? 'warn' : 'ok' });

    /* ---- LEVEL 1 + LEVEL 2: the same facts, said for someone who has never
       placed a bet. Additive: every field above is untouched, and Full
       Research still reads `engine` and the precise copy. ---- */
    var vp = verdictPlain({ verdict: displayVerdict, suppressed: suppressed, no_price: noPrice,
      stale: fr.status === 'STALE', needs_odds: play.kind === 'NEEDS' ? play.limit_odds : null });
    var limitPlain = suppressed
      ? { label: 'Price limit', value: 'Withheld', limit_odds: null, hint: null,
          sentence: 'EdgeDesk is not publishing a price limit while the data check is failing.' }
      : priceLimitPlain(play);
    /* WAIT is the only state that needs BOTH halves: the thing that would turn
       it into a bet, and the thing that would end it. Everywhere else the
       change trigger IS the kill condition, and printing it twice under two
       headings is how a one-page brief stops being readable. */
    var killsText = (suppressed || displayVerdict !== 'WAIT') ? null
      : (play.limit_odds
          ? 'If the best price on offer gets worse than ' + play.limit_odds + ', the value is gone and there is nothing left to wait for.'
          : (fals[0] || 'A worse price would end it before it ever became a bet.'));
    var marketCheck = marketCheckPlain({ has_sharp: conf.has_sharp, n_books: conf.n_books, price_status: pst, book: book, trusted: trusted });
    var plainWhyHead = suppressed ? 'Why EdgeDesk is not calling it'
      : displayVerdict === 'PASS' ? 'Why EdgeDesk passes'
      : displayVerdict === 'WAIT' ? 'Why EdgeDesk noticed it'
      : 'Why EdgeDesk noticed it';
    var plain = {
      verdict: vp.key === 'FAILED' || vp.key === 'NONE' ? null : vp.key,
      verdict_label: vp.label,
      verdict_subtitle: vp.subtitle,
      answer: vp.answer,
      bet: pubBet || selLabel || null,
      ticket: pubTicket || selLabel || null,
      push_note: pubPush,
      price: odds,
      book: book,
      payout: payoutLine(curAm),
      found: compare,
      guard: guard ? guard.text : null,
      guard_kind: guard ? guard.kind : null,
      why_heading: plainWhyHead,
      why: why.map(function (w) { return w.text; }),
      risk_heading: suppressed ? 'What EdgeDesk cannot check' : displayVerdict === 'WAIT' ? 'Why wait' : displayVerdict === 'PASS' ? 'Why pass' : 'The biggest risk',
      risk: watchText,
      change_heading: displayVerdict === 'WAIT' ? 'What would turn this into a bet' : displayVerdict === 'PASS' ? 'What would bring it back' : 'What would end it',
      change: changeText,
      price_limit: limitPlain,
      kills: killsText,
      market_check: marketCheck.text,
      market_check_lines: marketCheck.lines,
      price_age: fr.price_text,
      price_age_warning: fr.warning
    };

    return {
      version: VERSION,
      available: displayVerdict != null,
      verdict: displayVerdict,
      engine_verdict: engineVerdict,
      display_verdict: displayVerdict,
      suppressed: suppressed,
      headline: headline,
      selection: selLabel,
      selection_raw: selectionRaw,
      market: marketKey,
      market_label: mktLabel,
      line: num(p.point),
      odds: odds,
      odds_format: 'american',
      odds_display: odds ? odds + (book ? ' · ' + book : '') : (book ? '— · ' + book : '—'),
      book: book,
      book_trusted: trusted,
      fair_odds: fmtAmerican(fairAm),
      breakeven_odds: fmtAmerican(beAm),
      playable_to: play,
      price_status: pst,
      why: why,
      watch: { text: watchText, source: 'deterministic' },
      change_trigger: { text: changeText, source: 'deterministic' },
      market_read: { text: marketCheck.text, source: 'deterministic' },
      plain: plain,
      freshness: fr,
      integrity_status: integ.status,
      integrity_reason: integ.reason,
      integrity_reason_plain: integ.reason_plain || null,
      flags: flags,
      gaps: gaps,
      availability: availability ? { status: availability.status, source: availability.source || null, week: availability.week || null,
        summary: avail ? avail.text : null, coverage_text: avail ? avail.coverage_text : coverageText(availability, []),
        listed: avail ? avail.listed.slice(0, 10) : [], high_impact: avail ? avail.high_impact : [], sides: avail ? avail.sides : [],
        official: avail ? avail.official : false, last_updated: avail ? avail.last_updated : null, reason: availability.reason || null } : null,
      confidence: det.confidence || null,
      score: num(det.score),
      copy_source: 'deterministic',
      /* the engine's graded receipt, verbatim (null until the close pipeline grades the row) */
      outcome: p.clv ? outcomeOf({ clv: p.clv.clv, beat_close: p.clv.beat_close, closing: p.clv.closing, result: p.clv.result, closed_at: p.clv.closed_at, graded_at: p.clv.graded_at, entry_am: detAm != null ? detAm : curAm }) : null,
      game: {
        matchup: game.matchup || null, away: game.away || null, home: game.home || null,
        sport_key: game.sport_key || null, sport_label: game.sport || null,
        commence: game.commence || null, event_id: game.event_id || null
      },
      /* the engine's numbers, verbatim, for Full Research and the internal snapshot */
      engine: {
        current_am: curAm, detect_am: detAm, fair_am: fairAm, max_playable_am: maxAm, breakeven_am: beAm,
        needs_price_am: needsAm, edge: num(edge.current), detect_edge: num(edge.detect), ev: num(edge.ev),
        remaining: num(edge.remaining), floor: num(edge.floor), has_sharp: conf.has_sharp == null ? null : !!conf.has_sharp,
        n_books: num(conf.n_books), confidence: det.confidence || null, score: num(det.score), band: det.band || null,
        why: det.why || null, reasons_for: (det.reasons_for || []).slice(), reasons_against: (det.reasons_against || []).slice(),
        falsifiers: (det.falsifiers || []).slice(), is_wait: !!det.is_wait, wait_reason: det.wait_reason || null
      }
    };
  }

  /* marketReadText() used to say "The sharper market is quoting the same side.
     21 books are behind the fair line." Neither sentence means anything to a
     sports fan, so marketCheckPlain() replaced it: same two engine fields,
     said as what they are. */

  /* Board rows (EDAI.buildBoard) carry the same facts under different keys. */
  function packetFromBoardRow(r) {
    if (!r) return null;
    var price = r.price || {}, edge = r.edge || {}, conf = r.confirmation || {}, det = r.deterministic || {};
    return {
      game: { matchup: r.game || null, sport: r.sport || null, commence: r.starts || null, event_id: r.event_id || null },
      market: r.market || null, market_key: r.market_key || r.market || null,
      selection: r.selection || null, selection_raw: r.selection_raw || null, point: r.point,
      prices: { detect: price.detection, current: price.current, fair: price.fair, fair_src: price.fair_src,
        best_seen: price.best_seen, max_playable: price.max_playable, pinnacle: price.pinnacle, book: price.book },
      edge: { detect: edge.detection, current: edge.current, ev: edge.ev, remaining: edge.remaining, floor: edge.floor },
      confirmation: { has_sharp: conf.has_sharp, n_books: conf.n_books, n_books_eff: conf.n_books_eff, corrob: conf.corrob, trusted: conf.trusted_book, book: price.book },
      timing: { stale_min: r.freshness ? r.freshness.stale_min : null },
      price_sensitivity: { breakeven: price.breakeven, max_playable: price.max_playable, needs_price_for_ev: null },
      deterministic: { verdict: det.verdict, display_verdict: det.display_verdict, is_wait: det.is_wait, wait_reason: det.wait_reason,
        confidence: det.confidence, score: det.score, band: det.band, why: det.why,
        reasons_for: det.reasons_for || [], reasons_against: det.reasons_against || [], falsifiers: det.falsifiers || [] }
    };
  }

  /* ------------------------------------------------------------ AI copy gate */
  /* Which numbers the copy may quote: only the ones the engine owns. */
  function knownNumbers(simple) {
    var s = simple || {}, e = s.engine || {};
    var odds = [s.odds, s.fair_odds, s.breakeven_odds, s.playable_to && s.playable_to.limit_odds,
      fmtAmerican(e.detect_am), fmtAmerican(e.needs_price_am)].filter(Boolean);
    var pcts = [e.edge, e.detect_edge, e.ev, e.floor].filter(function (x) { return x != null; }).map(function (x) { return x * 100; });
    if (e.remaining != null) pcts.push(e.remaining * 100);
    return { odds: odds, pcts: pcts };
  }
  function textOk(text, verdict, known, max) {
    var t = clean(text);
    if (!t) return 'empty';
    if (t.length > (max || 200)) return 'too long';
    if (HYPE.test(t)) return 'hype';
    var jg = t.match(JARGON);
    if (jg) return 'jargon “' + jg[0] + '”';
    var vm = t.match(/\b(BET|LEAN|WAIT|PASS)\b(?=[:\s.,!])/g);
    if (vm && verdict) {
      for (var i = 0; i < vm.length; i++) {
        if (vm[i] !== verdict && !/would (pass|wait)|not a bet|no bet/i.test(t)) return 'contradicts verdict';
      }
    }
    var oddsIn = t.match(/[+-]\d{3,4}\b/g) || [];
    for (var j = 0; j < oddsIn.length; j++) if (known.odds.indexOf(oddsIn[j]) < 0) return 'invented price ' + oddsIn[j];
    var pctIn = t.match(/(\d+(?:\.\d+)?)\s?%/g) || [];
    for (var k = 0; k < pctIn.length; k++) {
      var v = parseFloat(pctIn[k]);
      var hit = known.pcts.some(function (p) { return Math.abs(p - v) < 0.06 || Math.abs(Math.round(p) - v) < 0.5 || Math.abs(Math.round(p * 10) / 10 - v) < 0.06; });
      if (!hit) return 'invented percentage ' + pctIn[k];
    }
    return null;
  }
  function validateCopy(copy, simple, opts) {
    opts = opts || {};
    var errors = [], out = {};
    if (!copy || typeof copy !== 'object') return { ok: false, errors: ['no copy'], cleaned: null };
    var verdict = simple && simple.verdict;
    var known = knownNumbers(simple);
    var ids = opts.known_evidence_ids || null;
    function keep(field, text, max) {
      var err = textOk(text, verdict, known, max);
      if (err) { errors.push(field + ': ' + err); return null; }
      return sentence(text);
    }
    if (isStr(copy.headline)) {
      var h = clean(copy.headline);
      if (verdict && h.toUpperCase().indexOf(verdict + ':') !== 0 && h.toUpperCase().indexOf(verdict + ' ') !== 0) errors.push('headline: must start with the verdict');
      else { var hk = keep('headline', h, 160); if (hk) out.headline = hk; }
    }
    if (Array.isArray(copy.why)) {
      var why = [];
      copy.why.slice(0, 3).forEach(function (w, i) {
        var text = isStr(w) ? w : (w && w.text);
        var t = keep('why[' + i + ']', text, 170);
        if (!t) return;
        var ev = (w && Array.isArray(w.evidence_ids)) ? w.evidence_ids.filter(function (x) { return isStr(x) && (!ids || ids.indexOf(x) >= 0); }) : [];
        why.push({ text: t, source: 'ai', evidence_ids: ev });
      });
      if (why.length) out.why = why;
    }
    ['watch', 'change_trigger', 'market_read', 'plain_english', 'biggest_risk'].forEach(function (f) {
      if (isStr(copy[f])) { var t = keep(f, copy[f], f === 'plain_english' ? 420 : 240); if (t) out[f] = t; }
    });
    return { ok: Object.keys(out).length > 0, errors: errors, cleaned: out };
  }
  /* Returns a NEW simple object. The deterministic fields are untouched;
     only translation/copy fields change, and only when they pass the gate. */
  function applyAiCopy(simple, copy, opts) {
    if (!simple) return { simple: simple, accepted: false, rejected: ['no simple'] };
    var v = validateCopy(copy, simple, opts);
    var out = JSON.parse(JSON.stringify(simple));
    if (!v.ok) return { simple: out, accepted: false, rejected: v.errors };
    var c = v.cleaned;
    /* A suppressed or price-less card keeps its deterministic headline: the AI
       may not talk over a data-check failure or a missing price. */
    if (c.headline && !simple.suppressed && simple.price_status.kind !== 'NO_PRICE') out.headline = c.headline;
    if (c.why) {
      /* AI bullets lead; deterministic bullets fill in behind them so a card
         never gets thinner because one AI bullet was rejected. */
      var merged = c.why.slice();
      (simple.why || []).forEach(function (w) {
        if (merged.length >= 3) return;
        var dup = merged.some(function (m) { return m.text.toLowerCase() === w.text.toLowerCase(); });
        if (!dup) merged.push({ text: w.text, source: 'deterministic', evidence_ids: [] });
      });
      out.why = merged.slice(0, 3);
    }
    if (c.watch && !simple.suppressed) out.watch = { text: c.watch, source: 'ai' };
    if (c.change_trigger) out.change_trigger = { text: c.change_trigger, source: 'ai' };
    if (c.market_read) out.market_read = { text: c.market_read, source: 'ai' };
    if (c.plain_english) out.plain_english = { text: c.plain_english, source: 'ai' };
    if (c.biggest_risk && !simple.suppressed) out.biggest_risk = { text: c.biggest_risk, source: 'ai' };
    /* The plain block is the same copy, one layer down. Keep it in step so the
       five-second view and the brief never disagree with the answer above
       them. Only fields the gate accepted move; everything else stays
       deterministic. */
    if (out.plain) {
      out.plain.why = (out.why || []).map(function (w) { return w.text; });
      if (c.watch && !simple.suppressed) out.plain.risk = out.watch.text;
      if (c.biggest_risk && !simple.suppressed) out.plain.risk = out.biggest_risk.text;
      if (c.change_trigger) out.plain.change = out.change_trigger.text;
      if (c.market_read) out.plain.market_check = out.market_read.text;
      if (c.plain_english) out.plain.answer = out.plain_english.text;
    }
    out.copy_source = 'ai';
    out.copy_rejections = v.errors;
    return { simple: out, accepted: true, rejected: v.errors };
  }
  /* The model returns prose plus ONE fenced block. Split them. */
  function parseAiCopyBlock(text) {
    var s = String(text == null ? '' : text);
    var re = /```\s*edgedesk_copy\s*\n([\s\S]*?)```/i;
    var m = s.match(re);
    if (!m) {
      var m2 = s.match(/<edgedesk_copy>([\s\S]*?)<\/edgedesk_copy>/i);
      if (!m2) return { answer: s.trim(), copy: null, error: 'no block' };
      m = m2;
    }
    var copy = null, error = null;
    try { copy = JSON.parse(m[1]); } catch (e) { error = 'bad json'; }
    return { answer: s.replace(m[0], '').trim(), copy: copy, error: error };
  }

  /* -------------------------------------------------------------- explain */
  /* Every one of these answers a question a first-time reader will actually
     have, in words that need no glossary. Surfaced behind "What does this
     mean?" so the card itself stays clean. */
  var EXPLAIN = {
    good_to: function (s) {
      var pl = (s.plain && s.plain.price_limit) || priceLimitPlain(s.playable_to || {});
      return pl.sentence + (pl.hint ? ' ' + pl.hint : '') + ' The bet and the price are one thing: change the price and the answer changes, with nothing about the game moving.';
    },
    price_limit: function (s) { return EXPLAIN.good_to(s); },
    verdict: function (s) {
      if (s.suppressed) return 'A data check failed, so EdgeDesk will not publish a recommendation until it is repaired. That is EdgeDesk refusing to answer, not a bad bet.';
      if (s.verdict === 'BET') return 'BET means the price on offer is good enough by EdgeDesk’s standard right now. It is a judgement about the price, not a prediction of the result.';
      if (s.verdict === 'LEAN') return 'LEAN means there is something here, but not enough to call it a bet.';
      if (s.verdict === 'WAIT') return 'WAIT means something EdgeDesk needs is missing, out of date or unconfirmed. It is not a no.';
      if (s.verdict === 'PASS') return 'PASS means EdgeDesk looked and does not see enough value at this price. A calm no is a good answer.';
      return 'EdgeDesk has no call on file for this bet.';
    },
    price: function (s) {
      var pay = (s.plain && s.plain.payout) || null;
      return 'The call is the bet AND the price together. ' + ((s.plain && s.plain.bet) || s.selection || 'This bet') + ' at ' + (s.odds || 'no price') + ' is the thing being judged; a worse price can turn the same bet into a pass.'
        + (pay ? ' ' + pay : '');
    },
    comparison: function (s) {
      var c = concept('edgedesk_comparison');
      return c.simple + ' ' + c.detail + ' ' + c.guard;
    },
    benchmark: function (s) {
      var c = concept('benchmark_book');
      return c.simple + ' ' + c.detail + ' ' + c.guard;
    },
    book_count: function (s) {
      var c = concept('book_count');
      var n = s.engine && s.engine.n_books;
      return c.simple + (n != null ? ' Here it was ' + n + '.' : '') + ' ' + c.detail + ' ' + c.guard;
    },
    beat_the_close: function () {
      var c = concept('beat_the_close');
      return c.simple + ' ' + c.detail + ' ' + c.guard;
    },
    provisional: function (s) {
      return 'Provisional means some of the data behind this needs checking' + (s.integrity_reason ? ': ' + s.integrity_reason : '') + '. The call stands, but treat it with care.';
    },
    freshness: function (s) {
      return 'Odds move. ' + ((s.freshness && s.freshness.price_text) || 'Price age unknown') + '. ' + ((s.freshness && s.freshness.warning) || 'This one is recent enough to act on.') + ' An old price is not a wrong price — it is an unconfirmed one.';
    },
    book: function (s) {
      if (!s.book) return 'EdgeDesk did not record which sportsbook is offering this price.';
      return s.book + ' is the sportsbook with the best price EdgeDesk found.' + (s.book_trusted === false ? ' It is offshore, which means it is harder to reach and less protected than a US-licensed book.' : '');
    },
    not_a_prediction: function (s) {
      return (s.plain && s.plain.guard) || 'EdgeDesk judges the price on offer against what the rest of the market is charging. It does not predict who wins.';
    }
  };
  function explain(key, simple) {
    var f = EXPLAIN[key];
    return f ? f(simple || {}) : null;
  }

  /* ------------------------------------------------------------- copy QA */
  /* THE FIVE-SECOND CHECKLIST, as code. Every card and every brief can be run
     through this before it is shown to anybody. It answers the only question
     that matters on a public surface: could a football fan who has never
     placed a bet read this and know what to do?

     It is a LINT, not a gate — it never suppresses a card, because a card that
     fails this is still more useful than no card. It exists so a regression is
     visible instead of silent, and so tools/presentation/public_language.test.js
     and the publisher desk are checking the same rules. */
  var QA_JARGON = /\b(de-?vig(?:ged|ging)?|devig|vigorish|no-?vig|clv|closing[- ]line[- ]value|expected value|\bev\b|pinnacle|sharp(?:er)?[- ](?:market|book|books|fair|reference|money|side)|soft(?:er)? books?|fair (?:line|value|price|odds|probability)|max[- ]playable|market residual|consensus dispersion|liquidity|\bshin\b|overround|implied probability)\b/i;
  /* Words that would turn a judgement about a price into a forecast. */
  var QA_PREDICTION = /\b(will (win|beat|cover|lose)|going to (win|beat|cover)|expect(?:s|ed)? (?:them |it )?to win|likely to (win|beat|cover)|should win|is winning this)\b/i;
  function qaStrings(s) {
    var pl = (s && s.plain) || {};
    var out = [pl.verdict_subtitle, pl.answer, pl.bet, pl.ticket, pl.guard, pl.risk, pl.change, pl.kills,
      pl.market_check, pl.payout, pl.push_note, pl.why_heading, pl.risk_heading, pl.change_heading];
    (pl.why || []).forEach(function (w) { out.push(w); });
    if (pl.found) { out.push(pl.found.sentence, pl.found.detail); (pl.found.rows || []).forEach(function (r) { out.push(r.k, r.v, r.note); }); }
    if (pl.price_limit) out.push(pl.price_limit.label, pl.price_limit.value, pl.price_limit.sentence, pl.price_limit.hint);
    return out.filter(function (x) { return typeof x === 'string' && x; });
  }
  /* Returns { pass, checks:[{id, ok, detail}], failed:[id] }. */
  function copyQA(simple) {
    var s = simple || {};
    var pl = s.plain || {};
    var strings = qaStrings(s);
    var am = parseAmerican(s.odds);
    var isML = /^(h2h|ml|moneyline)$/i.test(String(s.market || ''));
    var longPrice = am != null && (isML ? am >= LONGSHOT_AM : am >= LONGSHOT_OTHER_AM);
    var jargon = strings.map(function (t) { var m = t.match(QA_JARGON); return m ? { term: m[0], text: t.slice(0, 120) } : null; }).filter(Boolean);
    var predict = strings.map(function (t) { var m = t.match(QA_PREDICTION); return m ? { phrase: m[0], text: t.slice(0, 120) } : null; }).filter(Boolean);
    var checks = [
      { id: 'no_undefined_jargon', ok: jargon.length === 0,
        why: 'A public surface may not use a word nothing on the page defines.', detail: jargon.slice(0, 3) },
      { id: 'call_is_stated', ok: !!pl.verdict_label,
        why: 'The reader has to see the call in one word.', detail: pl.verdict_label || null },
      { id: 'call_is_glossed', ok: !!(pl.verdict_subtitle && pl.verdict_subtitle.length > 15),
        why: 'BET, LEAN, WAIT and PASS mean nothing on their own.', detail: pl.verdict_subtitle || null },
      { id: 'next_action_is_clear', ok: !!(pl.answer && pl.answer.length > 12),
        why: 'The reader has to know whether to act, wait, or move on.', detail: pl.answer || null },
      { id: 'bet_in_plain_words', ok: !!(pl.bet && !/\bML$/.test(pl.bet)),
        why: '"Chiefs ML" is shorthand; "Chiefs to beat the Ravens" is the bet.', detail: pl.bet || null },
      { id: 'exact_ticket_shown', ok: !!pl.ticket,
        why: 'The reader still has to find the exact line at the sportsbook.', detail: pl.ticket || null },
      { id: 'price_that_matters_named', ok: !!(pl.price_limit && pl.price_limit.value && pl.price_limit.sentence),
        why: 'A call without its price limit is a pick, not research.', detail: pl.price_limit || null },
      { id: 'what_would_break_it', ok: !!(pl.risk && pl.risk.length > 12),
        why: 'The reader has to know what could make this wrong.', detail: pl.risk || null },
      { id: 'what_would_change_it', ok: !!(pl.change && pl.change.length > 12),
        why: 'The reader has to know what would make the call disappear.', detail: pl.change || null },
      { id: 'value_is_not_a_prediction', ok: predict.length === 0,
        why: 'EdgeDesk judges a price. It never forecasts a result.', detail: predict.slice(0, 3) },
      { id: 'long_price_carries_the_guard', ok: !longPrice || !!pl.guard,
        why: 'A long payout must say out loud that it is not an upset call.', detail: { odds: s.odds, guard: pl.guard || null } }
    ];
    var failed = checks.filter(function (c) { return !c.ok; });
    return { pass: failed.length === 0, checks: checks, failed: failed.map(function (c) { return c.id; }), failures: failed };
  }
  /* Every card in one report, for the publisher desk and for a console sweep. */
  function copyQABatch(cards) {
    var rows = (cards || []).map(function (c) {
      var r = copyQA(c);
      return { key: (c && c.plain && c.plain.bet) || (c && c.selection) || '—', verdict: c && c.plain && c.plain.verdict_label, pass: r.pass, failed: r.failed };
    });
    return { n: rows.length, passing: rows.filter(function (r) { return r.pass; }).length, rows: rows };
  }

  /* -------------------------------------------------------------- publisher */
  var PRESETS = {
    GAME: { title: 'EdgeDesk Game Brief', kicker: null },
    TNF: { title: 'EdgeDesk Game Brief', kicker: 'Thursday Night Football' },
    SNF: { title: 'EdgeDesk Game Brief', kicker: 'Sunday Night Football' },
    MNF: { title: 'EdgeDesk Game Brief', kicker: 'Monday Night Football' },
    CFB: { title: 'EdgeDesk College Football Brief', kicker: 'College Football' },
    SLATE: { title: 'EdgeDesk Slate Brief', kicker: null }
  };
  function dataCheck(simple) {
    var s = simple || {};
    var status, text;
    if (s.suppressed) { status = 'Data check failed'; text = sentence('EdgeDesk will not publish a call until it fixes a problem with its own data: ' + (s.integrity_reason_plain || s.integrity_reason || 'a check on its own data failed')); }
    else if (s.freshness && s.freshness.status === 'STALE') { status = 'Needs refresh'; text = 'The price on file is stale. Refresh before publishing a number.'; }
    else if (s.integrity_status === 'PROVISIONAL') { status = 'Provisional'; text = s.integrity_reason ? 'Some of the underlying data needs verification: ' + s.integrity_reason : 'Some of the underlying data needs verification.'; }
    else if (s.freshness && s.freshness.status === 'UNKNOWN') { status = 'Provisional'; text = 'EdgeDesk cannot tell how old this price is.'; }
    else { status = 'Current'; text = 'Prices and research are current as of capture.'; }
    return { status: status, text: text, price_captured_at: s.freshness ? s.freshness.price_captured_at : null };
  }
  function callText(s) {
    if (!s || !s.available) return 'No decision on file.';
    if (s.suppressed) return 'DATA CHECK FAILED';
    var v = s.verdict;
    var sel = s.selection || 'this selection';
    if (v === 'PASS') return 'PASS — ' + sel + (s.odds ? ' (' + s.odds + ')' : '');
    if (v === 'WAIT') return 'WAIT — ' + sel + (s.odds ? ' (' + s.odds + ')' : '');
    return v + ' — ' + sel + (s.odds ? ' (' + s.odds + ')' : '');
  }
  /* Article-ready copy, strictly from the simple object. */
  function publisher(simple, ctx) {
    ctx = ctx || {};
    var s = simple || {};
    var preset = PRESETS[ctx.preset] ? ctx.preset : 'GAME';
    var P = PRESETS[preset];
    var v = s.verdict;
    var pl = s.plain || {};
    var whyLines = (s.why || []).map(function (w) { return w.text; });
    if (!whyLines.length) whyLines.push(v === 'PASS' ? 'EdgeDesk does not see enough value at the current price.' : 'EdgeDesk’s current research favors this number.');
    var risk = (s.biggest_risk && s.biggest_risk.text) || (s.watch && s.watch.text) || 'The price could move before kickoff.';
    var change = (s.change_trigger && s.change_trigger.text) || 'A worse price would change the call.';
    var goodTo = s.playable_to || {};
    var limit = pl.price_limit || priceLimitPlain(goodTo);
    var market = (s.market_read && s.market_read.text) || '';
    /* The lede leads with the BET as a football sentence, then the price.
       "Texas Tech to win by 4 points or more at -110" is the same fact as
       "Texas Tech -3.5 at -110" and one of them needs no explaining. */
    var bet = pl.bet || s.selection || 'this bet';
    /* A team name keeps its capital mid-sentence. "More than 47.5 total
       points" does not — it is a description, not a name. */
    var totalish = /^(totals?)$/i.test(String(s.market || '')) || /^(More|Fewer) than /.test(bet);
    var betMid = totalish ? bet.charAt(0).toLowerCase() + bet.slice(1) : bet;
    var lede;
    if (s.suppressed) lede = 'EdgeDesk is withholding a call on this game until a problem with its own data is fixed.';
    else if (!s.available) lede = 'EdgeDesk has no call on file for this game.';
    else if (v === 'BET') lede = 'EdgeDesk’s research favors ' + betMid + ' at ' + s.odds + '.' + (goodTo.limit_odds ? ' The price stays good enough down to ' + goodTo.limit_odds + '.' : '');
    else if (v === 'LEAN') lede = 'EdgeDesk leans toward ' + betMid + ' at ' + s.odds + ', with caveats.' + (goodTo.limit_odds ? ' The price stays good enough down to ' + goodTo.limit_odds + '.' : '');
    else if (v === 'WAIT') lede = 'EdgeDesk is not ready to call ' + betMid + ' at ' + s.odds + '. ' + (pl.answer || 'Something still has to be confirmed.');
    else lede = 'At ' + (s.odds || 'the current price') + ', EdgeDesk passes on ' + betMid + '.' + (goodTo.kind === 'NEEDS' ? ' It would take ' + goodTo.limit_odds + ' or better to change that.' : '');
    return {
      version: VERSION,
      preset: preset,
      title: ctx.title || P.title,
      kicker: ctx.kicker || P.kicker || (s.game && s.game.sport_label) || null,
      event_label: ctx.event_label || (s.game && s.game.away && s.game.home ? s.game.away + ' at ' + s.game.home : (s.game && s.game.matchup) || null),
      when_label: ctx.when_label || null,
      sport_label: ctx.sport_label || (s.game && s.game.sport_label) || null,
      lede: lede,
      call: { verdict: s.suppressed ? 'DATA CHECK FAILED' : (v || null), selection: s.selection, odds: s.odds, book: s.book, text: callText(s) },
      good_to: { label: goodTo.label || null, text: goodTo.text || null, limit_odds: goodTo.limit_odds || null },
      why: whyLines.slice(0, 3),
      biggest_risk: risk,
      change_call: change,
      market_read: market,
      /* LEVEL 1 + LEVEL 2, frozen into the snapshot alongside the precise
         fields so an already-published brief keeps rendering either way. */
      plain: {
        status: s.suppressed ? 'DATA CHECK FAILED' : (v || 'NO CALL'),
        status_line: pl.verdict_subtitle || null,
        answer: pl.answer || null,
        bet: pl.bet || s.selection || null,
        ticket: pl.ticket || s.selection || null,
        push_note: pl.push_note || null,
        price: s.odds || null,
        book: s.book || null,
        payout: pl.payout || null,
        found: pl.found || null,
        guard: pl.guard || null,
        why_heading: pl.why_heading || 'Why EdgeDesk noticed it',
        why: whyLines.slice(0, 3),
        risk_heading: pl.risk_heading || 'The biggest risk',
        risk: risk,
        change_heading: pl.change_heading || 'What would change the call',
        change: change,
        kills: pl.kills || null,
        price_limit: limit,
        market_check: market,
        price_age: pl.price_age || (s.freshness ? s.freshness.price_text : null)
      },
      availability: availabilityBrief(s),
      data_check: dataCheck(s),
      freshness_text: s.freshness ? s.freshness.price_text : null,
      powered_by: 'Powered by EdgeDesk Sports'
    };
  }


  /* The brief's availability section. Written for someone with no betting
     knowledge: who is in doubt, what that means for the game, where it came
     from and how sure EdgeDesk is. It never states a consequence for the
     model, because availability does not move a number here. */
  function availabilityBrief(s) {
    var av = s && s.availability;
    if (!av) return null;
    if (av.status === 'NOT_PUBLISHED') return { headline: 'Availability is unknown', lines: [av.coverage_text || 'No verified availability information found.'], coverage: av.coverage_text || null, players: [], sources: [] };
    /* A snapshot deep-clones its cards, so identity is not a safe key here. */
    function key(p) { return (p.team || '') + '|' + (p.name || ''); }
    var high = (av.high_impact || []).slice(0, 3);
    var seen = {}; high.forEach(function (p) { seen[key(p)] = 1; });
    var rest = (av.listed || []).filter(function (p) { return !seen[key(p)]; }).slice(0, 3);
    var lines = [], sources = [], srcSeen = {};
    function addSource(p) {
      if (!p.source_name) return;
      var k = p.source_name + '|' + (p.confidence || '');
      if (srcSeen[k]) return;
      srcSeen[k] = 1;
      sources.push({ name: p.source_name, url: p.source_url || null, confidence: p.confidence || null });
    }
    high.forEach(function (p) {
      lines.push(sentence(p.team + ' ' + (p.position ? p.position + ' ' : '') + p.name + ' is ' + (p.label || p.status)
        + (p.injury ? ' with a ' + String(p.injury).toLowerCase() + ' issue' : '')
        + (p.practice ? ' and was ' + String(p.practice).replace(/ in practice| participation/gi, '').toLowerCase() + ' in practice' : '')));
      lines.push(sentence(p.status === 'out'
        ? (p.team + ' is without ' + p.name + ' for this game, and EdgeDesk’s number does not adjust for it')
        : ('If ' + p.name.split(' ').slice(-1)[0] + ' cannot go, that is a material change to ' + p.team + '’s side of this game, and EdgeDesk’s number does not adjust for it')));
      addSource(p);
    });
    rest.forEach(function (p) {
      lines.push(sentence(p.team + ' ' + (p.position ? p.position + ' ' : '') + p.name + ' is ' + (p.label || p.status)));
      addSource(p);
    });
    if (!lines.length) lines.push(sentence((av.sides || []).map(function (x) { return x.text; }).join(' · ') || 'Nobody is listed'));
    var headline;
    if (!high.length) headline = (av.listed || []).length ? 'Availability notes' : 'No availability flags';
    else if (high[0].status === 'out') headline = high[0].team + ' is missing its ' + (high[0].position || 'starter');
    else headline = high[0].team + ' ' + (high[0].position || 'player') + ' status is unresolved';
    return { headline: headline, lines: lines, coverage: av.coverage_text || null, players: high.concat(rest), sources: sources };
  }

  /* ----------------------------------------------------------------- slate */
  function rankCards(cards) {
    return (cards || []).slice().sort(function (a, b) {
      var ra = VERDICT_RANK[a.verdict] != null ? VERDICT_RANK[a.verdict] : 9;
      var rb = VERDICT_RANK[b.verdict] != null ? VERDICT_RANK[b.verdict] : 9;
      if (ra !== rb) return ra - rb;
      return (num(b.score) || 0) - (num(a.score) || 0);
    });
  }
  /* mode: 'top' (default, max N BET decisions), 'all' (every BET/LEAN), 'single'. */
  function slate(cards, opts) {
    opts = opts || {};
    var mode = opts.mode || 'top';
    var max = num(opts.max) != null && num(opts.max) > 0 ? Math.floor(num(opts.max)) : 3;
    var all = rankCards((cards || []).filter(function (c) { return c && c.available; }));
    var usable = all.filter(function (c) { return !c.suppressed; });
    var bets = usable.filter(function (c) { return c.verdict === 'BET' && c.freshness.status !== 'STALE'; });
    var counts = { bet: 0, lean: 0, wait: 0, pass: 0, failed: 0 };
    all.forEach(function (c) { if (c.suppressed) counts.failed++; else if (c.verdict === 'BET') counts.bet++; else if (c.verdict === 'LEAN') counts.lean++; else if (c.verdict === 'WAIT') counts.wait++; else counts.pass++; });
    var picks, watch;
    if (mode === 'single') { picks = all.slice(0, 1); }
    else if (mode === 'all') { picks = usable.filter(function (c) { return c.verdict === 'BET' || c.verdict === 'LEAN'; }); }
    else { picks = bets.slice(0, max); }
    var picked = {};
    picks.forEach(function (c) { picked[cardKey(c)] = 1; });
    /* Never pad. The strongest non-BET research sits underneath, labelled. */
    watch = all.filter(function (c) { return !picked[cardKey(c)]; }).slice(0, Math.max(max, 3));
    var noBet = !picks.some(function (c) { return c.verdict === 'BET'; });
    var bestWatch = watch.filter(function (c) { return c.verdict === 'LEAN' || c.verdict === 'WAIT'; })[0] || null;
    return {
      mode: mode, max: max,
      picks: picks, watch: watch,
      no_bet: noBet,
      headline: noBet ? 'NO QUALIFYING BETS' : (picks.length + ' qualifying bet' + (picks.length === 1 ? '' : 's')),
      counts: counts,
      best_price_to_watch: bestWatch ? { selection: bestWatch.selection, odds: bestWatch.odds, book: bestWatch.book, verdict: bestWatch.verdict,
        limit: bestWatch.playable_to && bestWatch.playable_to.label, text: bestWatch.watch && bestWatch.watch.text } : null
    };
  }
  function cardKey(c) {
    return [c.game && c.game.event_id, c.market, c.selection_raw || c.selection, c.line].join('|');
  }

  /* -------------------------------------------------------------- snapshot */
  /* A publisher brief is a SNAPSHOT. It does not change when live odds do.
     `refresh` returns a NEW snapshot with a higher version; the old one is
     untouched, and every public price carries its capture timestamp. */
  function worst(a, b, order) { return order.indexOf(a) >= order.indexOf(b) ? a : b; }
  function snapshot(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var cards = (o.cards || []).map(function (c) { return JSON.parse(JSON.stringify(c)); });
    var preset = PRESETS[o.preset] ? o.preset : (o.report_type === 'SLATE' ? 'SLATE' : 'GAME');
    var reportType = o.report_type === 'SLATE' ? 'SLATE' : 'GAME';
    var sl = reportType === 'SLATE' ? slate(cards, { mode: o.mode, max: o.max }) : null;
    var primary = reportType === 'SLATE' ? (sl.picks.concat(sl.watch)) : cards.slice(0, 1);
    var pubCards = (reportType === 'SLATE' ? sl.picks : cards.slice(0, 1)).map(function (c, i) {
      return { rank: i + 1, brief: publisher(c, { preset: preset, event_label: c.game && c.game.away && c.game.home ? c.game.away + ' at ' + c.game.home : (c.game && c.game.matchup) || null, when_label: c.game && c.game.commence ? whenLabel(c.game.commence, o.tz) : null, sport_label: o.sport_label || (c.game && c.game.sport_label) || null }) };
    });
    var watchCards = reportType === 'SLATE' ? sl.watch.map(function (c, i) {
      return { rank: i + 1, brief: publisher(c, { preset: preset, event_label: c.game && c.game.away && c.game.home ? c.game.away + ' at ' + c.game.home : (c.game && c.game.matchup) || null, when_label: c.game && c.game.commence ? whenLabel(c.game.commence, o.tz) : null, sport_label: o.sport_label || null }) };
    }) : [];
    var fresh = 'CURRENT', integ = 'OK';
    primary.forEach(function (c) {
      fresh = worst(fresh, c.freshness && c.freshness.status || 'UNKNOWN', ['CURRENT', 'AGING', 'UNKNOWN', 'STALE']);
      integ = worst(integ, c.integrity_status || 'OK', ['OK', 'PROVISIONAL', 'FAILED']);
    });
    var pickN = reportType === 'SLATE' ? sl.picks.length : 1;
    var prices = primary.map(function (c, i) {
      /* Every field the grader needs to find this exact selection again
         after kickoff travels with the price it was published at. */
      return { event_id: c.game && c.game.event_id, matchup: c.game && c.game.matchup, market: c.market_label, market_key: c.market || null,
        selection: c.selection, selection_raw: c.selection_raw || null, line: c.line, odds: c.odds, odds_am: c.engine ? c.engine.current_am : parseAmerican(c.odds),
        book: c.book, captured_at: c.freshness && c.freshness.price_captured_at || null,
        verdict: c.suppressed ? 'DATA CHECK FAILED' : (c.verdict || null), kind: i < pickN ? 'pick' : 'watch', rank: i < pickN ? i + 1 : i - pickN + 1,
        commence: c.game && c.game.commence || null, sport_key: c.game && c.game.sport_key || null, sport_label: c.game && c.game.sport_label || null,
        home: c.game && c.game.home || null, away: c.game && c.game.away || null };
    });
    var eventIds = [];
    primary.forEach(function (c) { var id = c.game && c.game.event_id; if (id && eventIds.indexOf(id) < 0) eventIds.push(id); });
    var P = PRESETS[preset];
    var title = o.title || P.title;
    var first = cards[0];
    var eventLabel = o.event_label || (reportType === 'GAME' && first && first.game ? (first.game.away && first.game.home ? first.game.away + ' at ' + first.game.home : first.game.matchup) : null);
    return {
      version: VERSION,
      version_no: num(o.version_no) || 1,
      parent_key: o.parent_key || null,
      report_key: o.report_key || (reportType + ':' + preset + ':' + (eventIds.join(',') || 'none')),
      report_type: reportType,
      preset: preset,
      sport: o.sport || (first && first.game && first.game.sport_key) || null,
      sport_label: o.sport_label || (first && first.game && first.game.sport_label) || null,
      title: title,
      kicker: o.kicker || P.kicker || null,
      event_label: eventLabel,
      when_label: o.when_label || (reportType === 'GAME' && first && first.game && first.game.commence ? whenLabel(first.game.commence, o.tz) : null),
      generated_at: new Date(now).toISOString(),
      event_ids: eventIds,
      price_snapshot: prices,
      freshness_status: fresh,
      integrity_status: integ,
      public: {
        cards: pubCards,
        watch: watchCards,
        slate: sl ? { headline: sl.headline, no_bet: sl.no_bet, counts: sl.counts, mode: sl.mode, max: sl.max, best_price_to_watch: sl.best_price_to_watch } : null,
        data_status: publicDataStatus(fresh, integ, prices)
      },
      internal: { cards: cards, slate: sl },
      is_public: false,
      share_slug: null
    };
  }
  function publicDataStatus(fresh, integ, prices) {
    var status = integ === 'FAILED' ? 'Data check failed' : fresh === 'STALE' ? 'Needs refresh' : (integ === 'PROVISIONAL' || fresh === 'UNKNOWN') ? 'Provisional' : 'Current';
    var latest = null;
    prices.forEach(function (p) { if (p.captured_at && (!latest || p.captured_at > latest)) latest = p.captured_at; });
    return { status: status, price_captured_at: latest, prices: prices };
  }
  function refresh(prev, o) {
    o = o || {};
    var next = snapshot({
      cards: o.cards, report_type: prev.report_type, preset: prev.preset, mode: o.mode || (prev.internal && prev.internal.slate && prev.internal.slate.mode),
      max: o.max || (prev.internal && prev.internal.slate && prev.internal.slate.max), sport: prev.sport, sport_label: prev.sport_label,
      title: prev.title, kicker: prev.kicker, event_label: o.event_label || prev.event_label, when_label: o.when_label || prev.when_label,
      now: o.now, tz: o.tz, version_no: (num(prev.version_no) || 1) + 1, parent_key: prev.report_key, report_key: prev.report_key
    });
    return next;
  }
  /* Only what is meant to be published. Engine internals never leave. */
  function publicPayload(snap) {
    if (!snap) return null;
    return {
      version: snap.version, version_no: snap.version_no, report_key: snap.report_key, report_type: snap.report_type, preset: snap.preset,
      sport: snap.sport, sport_label: snap.sport_label, title: snap.title, kicker: snap.kicker, event_label: snap.event_label,
      when_label: snap.when_label, generated_at: snap.generated_at, event_ids: snap.event_ids,
      freshness_status: snap.freshness_status, integrity_status: snap.integrity_status,
      cards: snap.public.cards, watch: snap.public.watch, slate: snap.public.slate, data_status: snap.public.data_status
    };
  }
  function whenLabel(iso, tz) {
    var ms = toMs(iso);
    if (ms == null) return null;
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ET';
    } catch (e) { return new Date(ms).toUTCString(); }
  }
  /* ET calendar facts for primetime resolution. */
  function etParts(iso, tz) {
    var ms = toMs(iso);
    if (ms == null) return null;
    try {
      var f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
      var parts = {};
      f.formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
      var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
      var hour = parseInt(parts.hour, 10); if (hour === 24) hour = 0;
      return { weekday: wd, hour: hour, date: parts.year + '-' + parts.month + '-' + parts.day, ms: ms };
    } catch (e) { var d = new Date(ms); return { weekday: d.getUTCDay(), hour: d.getUTCHours(), date: d.toISOString().slice(0, 10), ms: ms }; }
  }
  /* kind: TNF | SNF | MNF. rows carry {sport_key, commence_time}. Picks the
     next primetime kickoff by ET weekday and a 7pm+ ET start. Nothing is
     hardcoded: the game is whatever the schedule says it is. */
  function primetime(rows, kind, opts) {
    opts = opts || {};
    var now = toMs(opts.now) != null ? toMs(opts.now) : Date.now();
    var want = { TNF: 4, SNF: 0, MNF: 1 }[kind];
    if (want == null) return null;
    /* Nine days, not seven: the next Thursday game can be a full week plus
       kickoff-hours away, and a horizon that ends at the same clock time on
       the seventh day misses an 8:15 pm ET start on the eighth. */
    var horizon = now + (num(opts.days) || 9) * 86400000;
    var best = null;
    (rows || []).forEach(function (r) {
      if (!r || String(r.sport_key || '').indexOf('americanfootball_nfl') !== 0) return;
      var p = etParts(r.commence_time || r.commence || r.t, opts.tz);
      if (!p || p.weekday !== want || p.hour < 19) return;
      if (p.ms < now - 4 * 3600000 || p.ms > horizon) return;
      if (!best || p.ms < best.ms) best = { ms: p.ms, row: r, date: p.date };
    });
    return best;
  }

  /* ------------------------------------------------------------ renderers */
  /* Four identical "What does this mean?" links explain nothing. Each one says
     which word it is about, so the reader can open the one they are stuck on. */
  var WHAT_LABEL = {
    good_to: 'What does “price limit” mean?',
    price_limit: 'What does “price limit” mean?',
    verdict: 'What does this call mean?',
    price: 'Why is the price part of the call?',
    comparison: 'What is EdgeDesk’s comparison price?',
    benchmark: 'What is the benchmark sportsbook?',
    book_count: 'Why does the number of sportsbooks matter?',
    beat_the_close: 'What does “graded against the close” mean?',
    provisional: 'What does “provisional” mean?',
    freshness: 'Why does the price age matter?',
    book: 'Which sportsbook is this?',
    not_a_prediction: 'Is this a prediction?'
  };
  function whatMeans(key, simple) {
    var t = explain(key, simple);
    if (!t) return '';
    return '<details class="dcard-what"><summary>' + esc(WHAT_LABEL[key] || 'What does this mean?') + '</summary><p>' + esc(t) + '</p></details>';
  }
  /* Availability on the card: who is listed, how sure EdgeDesk is, where it
     came from, and how much of the field it actually covers. */
  function availabilityHTML(av) {
    if (!av) return '';
    if (av.status === 'NOT_PUBLISHED') return av.coverage_text ? '<div class="dcard-h">Availability</div><p class="dcard-avail-none">' + esc(av.coverage_text) + '</p>' : '';
    var h = '<div class="dcard-h">Availability</div>';
    if (av.listed && av.listed.length) {
      h += '<ul class="dcard-avail">' + av.listed.slice(0, 6).map(function (p) {
        var src = sourceText(p), tl = timelineText(p);
        return '<li><b>' + esc(p.name) + '</b>' + (p.position ? ' <span class="pos">' + esc(p.position) + '</span>' : '')
          + ' <span class="st ' + esc(p.status) + '">' + esc(p.label || p.status) + '</span>'
          + (p.impact === 'HIGH' ? ' <span class="imp">high impact</span>' : '')
          + (p.injury ? ' · ' + esc(String(p.injury).toLowerCase()) : '')
          + (p.practice ? ' · ' + esc(String(p.practice).replace(/ in practice| participation/gi, '').toLowerCase()) : '')
          + ' <span class="tm">' + esc(p.team) + '</span>'
          + (tl ? '<div class="tl">' + esc(tl) + '</div>' : '')
          + (src ? '<div class="src">' + (p.source_url ? '<a href="' + esc(p.source_url) + '" target="_blank" rel="noopener">' + esc(src) + '</a>' : esc(src)) + (p.contested ? ' · sources disagree' : '') + '</div>' : '')
          + '</li>';
      }).join('') + '</ul>';
    } else if (av.sides && av.sides.length) {
      h += '<p class="dcard-avail-none">' + esc(av.sides.map(function (s) { return s.text; }).join(' · ')) + '</p>';
    }
    if (av.coverage_text) h += '<p class="dcard-avail-cov">' + esc(av.coverage_text) + (av.last_updated ? ' Updated ' + esc(agoText(av.last_updated) || '') + '.' : '') + '</p>';
    return h;
  }

  /* The watchlist line: the two that matter, or a count. Compact on purpose. */
  function availabilityChip(av) {
    if (!av || av.status !== 'ON_FILE') return null;
    var listed = av.listed || [];
    if (!listed.length) return null;
    var top = listed.slice(0, 2).map(function (p) {
      var who = p.impact === 'HIGH' && p.position ? (p.position + (/^(QB|RB|WR|TE)$/.test(p.position) ? '1' : '')) : (p.position || p.name.split(' ').slice(-1)[0]);
      return who + ' ' + (p.label || p.status);
    });
    var text = top.join(' · ') + (listed.length > 2 ? ' · +' + (listed.length - 2) + ' more' : '');
    return { text: text, warn: listed.some(function (p) { return p.impact === 'HIGH' || p.status === 'out'; }), count: listed.length };
  }

  /* The grid states the price comparison. A why-bullet that repeats it word
     for word is noise, and a market-check line already made as a bullet is
     noise too. Both are dropped at render time so the underlying arrays stay
     whole for Full Research and for the snapshot. */
  function sameish(a, b) {
    return clean(String(a || '')).toLowerCase().replace(/[^a-z0-9 ]/g, '') === clean(String(b || '')).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  }
  function whyMinusFound(list, pl, alsoDrop) {
    var drop = [pl && pl.found && pl.found.sentence].concat(alsoDrop || []).filter(Boolean);
    if (!drop.length) return list || [];
    return (list || []).filter(function (w) {
      var t = typeof w === 'string' ? w : w.text;
      return !drop.some(function (d) { return sameish(t, d); });
    });
  }
  function marketMinusWhy(text, whys) {
    if (!text) return text;
    var said = (whys || []).map(function (w) { return typeof w === 'string' ? w : w.text; });
    var kept = String(text).split(/(?<=\.)\s+/).filter(function (sent) {
      return !said.some(function (w) { return sameish(w, sent); });
    });
    return kept.join(' ');
  }

  /* The 5-second view. opts: { actions:[{label, onclick, primary}], compact, id, show_what } */
  function cardHTML(s, opts) {
    opts = opts || {};
    if (!s) return '';
    var pl = s.plain || {};
    var v = s.suppressed ? 'FAILED' : (s.verdict || 'NONE');
    var vcls = s.suppressed ? 'dc-failed' : s.verdict === 'BET' ? 'dc-bet' : s.verdict === 'LEAN' ? 'dc-lean' : s.verdict === 'WAIT' ? 'dc-wait' : s.verdict === 'PASS' ? 'dc-pass' : 'dc-none';
    var vtext = pl.verdict_label || (s.suppressed ? 'DATA CHECK FAILED' : (s.verdict || 'NO DECISION'));
    var goodTo = s.playable_to || {};
    var limit = pl.price_limit || priceLimitPlain(goodTo);
    var h = '<article class="dcard ' + vcls + (opts.compact ? ' compact' : '') + '"' + (opts.id ? ' id="' + esc(opts.id) + '"' : '') + ' data-verdict="' + esc(v) + '">';
    /* THE FIVE SECONDS. What the call is, what it is on, what it costs, and
       the price past which it stops being the call — in that order, and in
       words that need no glossary. */
    h += '<div class="dcard-hero">'
      + '<div class="dcard-eyebrow">EdgeDesk says</div>'
      + '<div class="dcard-verdict">' + esc(vtext) + '</div>'
      + '<div class="dcard-sel">' + esc(pl.bet || s.selection || '—') + '</div>'
      + '<div class="dcard-price">' + esc(pl.ticket ? pl.ticket + ' · ' : '') + esc(s.odds_display || '—') + '</div>'
      + '<div class="dcard-goodto' + (goodTo.kind === 'NEEDS' ? ' needs' : goodTo.kind === 'NONE' ? ' none' : '') + '">'
      + '<span class="k">' + esc(limit.label) + '</span> '
      + '<b>' + esc(limit.value) + '</b>'
      + '</div>'
      + '</div>';
    /* The compact strip carries the answer on its own line below, so the
       subtitle here would say it twice. */
    if (pl.verdict_subtitle) h += '<p class="dcard-sub">' + esc(pl.verdict_subtitle) + ((pl.answer && !opts.compact) ? ' ' + esc(pl.answer) : '') + '</p>';
    /* The compact strip shows only what changes the decision at a glance:
       a failed check, a provisional read, a stale or missing price. Named
       data gaps stay on the full card, where the watch line explains them. */
    if (s.outcome && s.outcome.text) {
      var oc = s.outcome.result === 'win' ? 'win' : s.outcome.result === 'loss' ? 'loss' : s.outcome.result === 'push' ? 'push' : 'pend';
      h += '<div class="dcard-result ' + oc + '"><span class="k">Result</span> ' + esc(s.outcome.text) + '</div>';
    }
    var flags = (s.flags || []).filter(function (f) { return !opts.compact || f.kind !== 'DATA_GAP'; });
    if (flags.length) {
      h += '<div class="dcard-flags">' + flags.map(function (f) {
        var c = f.kind === 'DATA_CHECK_FAILED' ? 'bad' : (f.kind === 'STALE_PRICE' || f.kind === 'NO_PRICE') ? 'bad' : f.kind === 'AVAILABILITY' ? (f.severity === 'warn' ? 'warn' : 'ok') : 'warn';
        return '<span class="dcard-flag ' + c + '">' + esc(f.text) + '</span>';
      }).join('') + '</div>';
    }
    if (!opts.compact) {
      h += '<div class="dcard-body">';
      /* WHAT EDGEDESK FOUND — two prices, side by side, before a single
         sentence of analysis. This is the whole product in one glance. */
      if (pl.found && pl.found.rows && pl.found.rows.length) {
        h += '<div class="dcard-h">What EdgeDesk found</div>'
          + '<div class="dcard-cmp">' + pl.found.rows.map(function (r) {
            return '<div class="dcard-cmp-r"><span class="k">' + esc(r.k) + '</span><b>' + esc(r.v) + '</b>'
              + (r.note ? '<span class="n">' + esc(r.note) + '</span>' : '') + '</div>';
          }).join('') + '</div>'
          + '<p class="dcard-found">' + esc(pl.found.sentence || '') + '</p>'
          + (pl.payout || pl.push_note ? '<p class="dcard-payout">' + esc([pl.payout, pl.push_note].filter(Boolean).join(' ')) + '</p>' : '');
      }
      /* THE GUARD. A big payout is not a forecast. Said before the reasons,
         because it is the misreading that matters most. */
      if (pl.guard) h += '<div class="dcard-guard"><span class="k">Read this first</span><p>' + esc(pl.guard) + '</p></div>';
      var whyList = whyMinusFound(s.why || [], pl, [s.watch && s.watch.text]);
      h += (whyList.length ? '<div class="dcard-h">' + esc(pl.why_heading || 'Why') + '</div><ul class="dcard-why">'
        + whyList.map(function (w) { return '<li>' + esc(w.text) + '</li>'; }).join('')
        + '</ul>' : '')
        + '<div class="dcard-h">' + esc(pl.risk_heading || (s.verdict === 'WAIT' ? 'Why wait' : s.verdict === 'PASS' ? 'Why pass' : 'The biggest risk')) + '</div>'
        + '<p class="dcard-watch">' + esc(s.watch && s.watch.text || '') + '</p>'
        + (s.change_trigger && s.change_trigger.text ? '<div class="dcard-h">' + esc(pl.change_heading || 'What would change it') + '</div><p class="dcard-change">' + esc(s.change_trigger.text) + '</p>' : '')
        + (pl.kills ? '<div class="dcard-h">What would kill it</div><p class="dcard-change">' + esc(pl.kills) + '</p>' : '')
        + (function () { var mc = marketMinusWhy(pl.market_check, whyList); return mc ? '<div class="dcard-h">Market check</div><p class="dcard-market">' + esc(mc) + '</p>' : ''; })()
        + availabilityHTML(s.availability)
        + '<div class="dcard-fresh' + (s.freshness && s.freshness.status === 'STALE' ? ' bad' : '') + '">' + esc(s.freshness ? s.freshness.price_text : '') + (s.freshness && s.freshness.research_text ? ' · ' + esc(s.freshness.research_text) : '') + '</div>'
        + (opts.show_what !== false ? whatMeans('good_to', s) + whatMeans('verdict', s) + whatMeans('comparison', s) + (pl.guard ? whatMeans('not_a_prediction', s) : '') : '')
        + '</div>';
    } else {
      h += '<div class="dcard-line">' + esc(pl.answer || (s.why && s.why[0] && s.why[0].text) || s.headline || '') + '</div>';
      if (pl.guard) h += '<div class="dcard-guardchip">' + esc(pl.guard.split('. ')[0] + '.') + '</div>';
      var chip = availabilityChip(s.availability);
      if (chip) h += '<div class="dcard-availchip' + (chip.warn ? ' warn' : '') + '">' + esc(chip.text) + '</div>';
    }
    if (opts.actions && opts.actions.length) {
      h += '<div class="dcard-actions">' + opts.actions.map(function (a) {
        return '<button type="button" class="dcard-btn' + (a.primary ? ' primary' : '') + '" onclick="' + esc(a.onclick) + '">' + esc(a.label) + '</button>';
      }).join('') + '</div>';
    }
    return h + '</article>';
  }


  /* One pick on the brief, in the order a reader actually needs it:
       what the call is  ->  what the bet is  ->  what it pays  ->
       what EdgeDesk found  ->  the misreading guard  ->  why  ->
       what could break it  ->  what would change it  ->  the market check.
     A brief published before this layer existed has no `plain` block, so
     every line falls back to the field it used to render. */
  function briefCardHTML(pc, opts) {
    opts = opts || {};
    var b = pc.brief, r = pc.rank;
    var pl = b.plain || null;
    var v = b.call.verdict || 'NONE';
    var vcls = v === 'BET' ? 'dc-bet' : v === 'LEAN' ? 'dc-lean' : v === 'WAIT' ? 'dc-wait' : v === 'PASS' ? 'dc-pass' : 'dc-failed';
    var h = '<section class="edb-pick ' + vcls + '">';
    if (opts && opts.numbered) h += '<div class="edb-rank">#' + r + '</div>';
    if (b.event_label && (opts && opts.showEvent)) h += '<div class="edb-ev">' + esc(b.event_label) + (b.when_label ? ' <span class="edb-when">' + esc(b.when_label) + '</span>' : '') + '</div>';
    h += '<div class="edb-call"><span class="edb-verdict">' + esc(v) + '</span>'
      + '<span class="edb-sel">' + esc((pl && pl.bet) || b.call.selection || '—') + '</span></div>';
    if (pl && pl.status_line) h += '<p class="edb-sub">' + esc(pl.status_line) + ((pl.answer && !opts.hideAnswer) ? ' ' + esc(pl.answer) : '') + '</p>';
    h += '<div class="edb-ticket">' + esc((pl && pl.ticket) || b.call.selection || '') + (b.call.odds ? ' · <b>' + esc(b.call.odds) + '</b>' : '') + (b.call.book ? ' · ' + esc(b.call.book) : '') + '</div>';
    if (pl && pl.price_limit && pl.price_limit.value) {
      h += '<div class="edb-goodto"><span class="k">' + esc(pl.price_limit.label) + '</span> ' + esc(pl.price_limit.value) + '</div>'
        + '<p class="edb-limitnote">' + esc(pl.price_limit.sentence) + (pl.price_limit.hint ? ' ' + esc(pl.price_limit.hint) : '') + '</p>';
    } else if (b.good_to && b.good_to.label) {
      h += '<div class="edb-goodto">' + esc(b.good_to.label) + '</div>';
    }
    if (pl && pl.found && pl.found.rows && pl.found.rows.length) {
      h += '<div class="edb-h">What EdgeDesk found</div>'
        + '<div class="edb-cmp">' + pl.found.rows.map(function (x) {
          return '<div class="edb-cmp-r"><span class="k">' + esc(x.k) + '</span><b>' + esc(x.v) + '</b>' + (x.note ? '<span class="n">' + esc(x.note) + '</span>' : '') + '</div>';
        }).join('') + '</div>'
        + '<p class="edb-found">' + esc(pl.found.sentence || '') + '</p>'
        + (pl.payout || pl.push_note ? '<p class="edb-payout">' + esc([pl.payout, pl.push_note].filter(Boolean).join(' ')) + '</p>' : '');
    }
    if (pl && pl.guard) h += '<div class="edb-guard"><span class="k">Read this first</span><p>' + esc(pl.guard) + '</p></div>';
    var bWhy = whyMinusFound(b.why || [], pl, [b.biggest_risk]);
    if (bWhy.length) h += '<div class="edb-h">' + esc((pl && pl.why_heading) || (v === 'PASS' ? 'Why EdgeDesk passes' : v === 'WAIT' ? 'Waiting for' : 'Why EdgeDesk likes it')) + '</div><ol class="edb-why">'
      + bWhy.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol>';
    h += '<div class="edb-h">' + esc((pl && pl.risk_heading) || 'The biggest risk') + '</div><p>' + esc(b.biggest_risk) + '</p>';
    if (b.availability) {
      h += '<div class="edb-h">' + esc(b.availability.headline) + '</div>'
        + b.availability.lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('')
        + (b.availability.coverage ? '<p class="edb-avail-cov">' + esc(b.availability.coverage) + '</p>' : '')
        + (b.availability.sources.length ? '<p class="edb-avail-src">Source: ' + b.availability.sources.map(function (x) { return esc(x.name) + (x.confidence ? ' · ' + esc(String(x.confidence).toLowerCase()) : ''); }).join(' · ') + '</p>' : '');
    }
    h += '<div class="edb-h">' + esc((pl && pl.change_heading) || 'What would change the call') + '</div><p>' + esc(b.change_call) + '</p>';
    if (pl && pl.kills) h += '<div class="edb-h">What would kill it</div><p>' + esc(pl.kills) + '</p>';
    var bMarket = marketMinusWhy(b.market_read, bWhy);
    if (bMarket) h += '<div class="edb-h">Market check</div><p>' + esc(bMarket) + '</p>';
    return h + '</section>';
  }

  /* PROGRESSIVE DISCLOSURE, at the bottom of the page rather than beside every
     number. Four words a reader may still want defined, closed by default.
     Definitions come from CONCEPTS so the app, the brief and the share page
     cannot drift apart. */
  var HOWTO_KEYS = ['verdict', 'price_limit', 'edgedesk_comparison', 'benchmark_book', 'book_count', 'price_age'];
  function howToReadHTML() {
    var items = HOWTO_KEYS.map(function (k) {
      var c = CONCEPTS[k === 'price_limit' ? 'price_limit' : k];
      if (!c) return '';
      return '<dt>' + esc(c.short) + '</dt><dd>' + esc(c.simple) + (c.guard ? ' <i>' + esc(c.guard) + '</i>' : '') + '</dd>';
    }).join('');
    if (!items) return '';
    return '<details class="edb-howto"><summary>How to read this brief</summary><dl>' + items
      + '<dt>What this is not</dt><dd>EdgeDesk judges the price on offer against the rest of the betting market. It does not predict who wins, and a call is never a promise. 21+. Gamble responsibly — 1-800-GAMBLER.</dd>'
      + '</dl></details>';
  }

  /* The one-page brief. opts: { public:true } strips nothing (the public
     payload already contains only publishable fields), it only changes chrome. */
  function briefHTML(snap, opts) {
    opts = opts || {};
    if (!snap) return '';
    var pub = snap.public || snap;   /* accepts a full snapshot or a public payload */
    var cards = pub.cards || [], watch = pub.watch || [], sl = pub.slate || null, ds = pub.data_status || {};
    var h = '<article class="edb" data-report="' + esc(snap.report_type || '') + '" data-preset="' + esc(snap.preset || '') + '">';
    h += '<header class="edb-hd"><div class="edb-brand">EdgeDesk</div><h1 class="edb-title">' + esc(snap.title || 'EdgeDesk Brief') + '</h1>'
      + (snap.kicker ? '<div class="edb-kicker">' + esc(snap.kicker) + '</div>' : '')
      + (snap.event_label ? '<div class="edb-event">' + esc(snap.event_label) + '</div>' : '')
      + (snap.when_label ? '<div class="edb-when">' + esc(snap.when_label) + '</div>' : '')
      + '</header>';
    if (snap.report_type === 'SLATE') {
      h += '<div class="edb-slatehead' + (sl && sl.no_bet ? ' nobet' : '') + '">' + esc(sl ? sl.headline : '') + '</div>';
      if (sl && sl.no_bet) h += '<p class="edb-nobet">EdgeDesk looked at every game on this slate and did not find a price worth betting. That is a real answer, not a gap. The closest calls are below, labelled for what they are.</p>';
      cards.forEach(function (pc) { h += briefCardHTML(pc, { numbered: true, showEvent: true }); });
      if (watch.length) {
        h += '<div class="edb-h edb-sec">' + (sl && sl.no_bet ? 'Strongest research (not bets)' : 'Also on the board') + '</div>';
        watch.forEach(function (pc) { h += briefCardHTML(pc, { numbered: false, showEvent: true }); });
      }
      if (sl && sl.best_price_to_watch) {
        var bp = sl.best_price_to_watch;
        h += '<div class="edb-h edb-sec">The one to keep an eye on</div><p class="edb-bpw"><b>' + esc(bp.selection || '') + '</b>' + (bp.odds ? ' at ' + esc(bp.odds) : '') + (bp.limit ? ' · ' + esc(bp.limit) : '') + (bp.text ? '. ' + esc(bp.text) : '') + '</p>';
      }
    } else {
      cards.forEach(function (pc) {
        var b = pc.brief;
        h += '<div class="edb-h edb-sec">The EdgeDesk call</div>';
        h += '<p class="edb-lede">' + esc(b.lede) + '</p>';
        h += briefCardHTML(pc, { numbered: false, showEvent: false, hideAnswer: true });
      });
    }
    if (opts.grades) h += briefResultsHTML(opts.grades);
    h += howToReadHTML();
    h += '<footer class="edb-ft"><div class="edb-h">EdgeDesk data check</div><p><b>' + esc(ds.status || 'Current') + '</b>'
      + (ds.price_captured_at ? ' · Price captured at ' + esc(fmtStamp(ds.price_captured_at)) : '') + '</p>'
      + (ds.prices && ds.prices.length > 1 ? '<ul class="edb-prices">' + ds.prices.map(function (p) { return '<li>' + esc(p.selection || '') + (p.odds ? ' ' + esc(p.odds) : '') + (p.book ? ' · ' + esc(p.book) : '') + (p.captured_at ? ' · captured ' + esc(fmtStamp(p.captured_at)) : '') + '</li>'; }).join('') + '</ul>' : '')
      + '<p class="edb-gen">Generated ' + esc(fmtStamp(snap.generated_at)) + (snap.version_no > 1 ? ' · version ' + snap.version_no : '') + '</p>'
      + '<p class="edb-powered">Powered by EdgeDesk Sports</p></footer>';
    return h + '</article>';
  }
  function fmtStamp(iso) {
    var ms = toMs(iso);
    if (ms == null) return String(iso || '');
    try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ET'; }
    catch (e) { return new Date(ms).toISOString(); }
  }
  /* Clean semantic HTML for a CMS paste: headings, paragraphs, lists, no classes. */
  function briefCmsHTML(snap) {
    var pub = snap.public || snap, ds = pub.data_status || {};
    var h = '<h1>' + esc(snap.title || 'EdgeDesk Brief') + '</h1>';
    if (snap.kicker) h += '<p><strong>' + esc(snap.kicker) + '</strong></p>';
    if (snap.event_label) h += '<p>' + esc(snap.event_label) + (snap.when_label ? ' · ' + esc(snap.when_label) : '') + '</p>';
    function pick(pc, numbered) {
      var b = pc.brief, pl = b.plain || null, s = '';
      var call = (pl ? (pl.status + ' — ' + pl.bet + (pl.price ? ' (' + pl.price + ')' : '')) : b.call.text);
      if (numbered) s += '<h2>#' + pc.rank + ' ' + esc(call) + (b.event_label ? ' — ' + esc(b.event_label) : '') + '</h2>';
      else { s += '<h2>The EdgeDesk call</h2><p><strong>' + esc(call) + '</strong></p>'; }
      if (pl && pl.status_line) s += '<p><em>' + esc(pl.status_line) + ((pl.answer && numbered) ? ' ' + esc(pl.answer) : '') + '</em></p>';
      if (pl && pl.ticket) s += '<p>At the sportsbook: ' + esc(pl.ticket) + (b.call.odds ? ' · ' + esc(b.call.odds) : '') + (b.call.book ? ' · ' + esc(b.call.book) : '') + '</p>';
      if (pl && pl.price_limit && pl.price_limit.value) s += '<p><strong>' + esc(pl.price_limit.label) + ': ' + esc(pl.price_limit.value) + '</strong> ' + esc(pl.price_limit.sentence) + '</p>';
      else if (b.good_to && b.good_to.label) s += '<p><strong>' + esc(b.good_to.label) + '</strong></p>';
      if (!numbered) s += '<p>' + esc(b.lede) + '</p>';
      if (pl && pl.found && pl.found.rows && pl.found.rows.length) {
        s += '<h3>What EdgeDesk found</h3><ul>' + pl.found.rows.map(function (x) { return '<li>' + esc(x.k) + ': ' + esc(x.v) + (x.note ? ' (' + esc(x.note) + ')' : '') + '</li>'; }).join('') + '</ul>'
          + '<p>' + esc(pl.found.sentence || '') + '</p>' + (pl.payout || pl.push_note ? '<p>' + esc([pl.payout, pl.push_note].filter(Boolean).join(' ')) + '</p>' : '');
      }
      if (pl && pl.guard) s += '<h3>Read this first</h3><p>' + esc(pl.guard) + '</p>';
      var cWhy = whyMinusFound(b.why || [], pl, [b.biggest_risk]);
      if (cWhy.length) s += '<h3>' + esc((pl && pl.why_heading) || (b.call.verdict === 'PASS' ? 'Why EdgeDesk passes' : b.call.verdict === 'WAIT' ? 'Waiting for' : 'Why EdgeDesk likes it')) + '</h3><ol>' + cWhy.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol>';
      s += '<h3>' + esc((pl && pl.risk_heading) || 'The biggest risk') + '</h3><p>' + esc(b.biggest_risk) + '</p>';
      if (b.availability) { s += '<h3>' + esc(b.availability.headline) + '</h3>' + b.availability.lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('')
        + (b.availability.coverage ? '<p>' + esc(b.availability.coverage) + '</p>' : '')
        + (b.availability.sources.length ? '<p>Source: ' + b.availability.sources.map(function (x) { return esc(x.name) + (x.confidence ? ' · ' + esc(String(x.confidence).toLowerCase()) : ''); }).join(' · ') + '</p>' : ''); }
      s += '<h3>' + esc((pl && pl.change_heading) || 'What would change the call') + '</h3><p>' + esc(b.change_call) + '</p>';
      if (pl && pl.kills) s += '<h3>What would kill it</h3><p>' + esc(pl.kills) + '</p>';
      var cMarket = marketMinusWhy(b.market_read, cWhy);
      if (cMarket) s += '<h3>Market check</h3><p>' + esc(cMarket) + '</p>';
      return s;
    }
    if (snap.report_type === 'SLATE') {
      h += '<h2>' + esc(pub.slate ? pub.slate.headline : '') + '</h2>';
      if (pub.slate && pub.slate.no_bet) h += '<p>EdgeDesk looked at every game on this slate and did not find a price worth betting. That is a real answer, not a gap. The closest calls are below, labelled for what they are.</p>';
      (pub.cards || []).forEach(function (pc) { h += pick(pc, true); });
      if ((pub.watch || []).length) { h += '<h2>' + (pub.slate && pub.slate.no_bet ? 'Strongest research (not bets)' : 'Also on the board') + '</h2>'; pub.watch.forEach(function (pc) { h += pick(pc, true); }); }
    } else {
      (pub.cards || []).forEach(function (pc) { h += pick(pc, false); });
    }
    h += '<h3>EdgeDesk data check</h3><p>' + esc(ds.status || 'Current') + (ds.price_captured_at ? ' · Price captured at ' + esc(fmtStamp(ds.price_captured_at)) : '') + '</p>';
    h += '<p><em>EdgeDesk judges the price on offer against the rest of the betting market. It does not predict who wins. 21+. Gamble responsibly — 1-800-GAMBLER.</em></p>';
    h += '<p><em>Powered by EdgeDesk Sports</em></p>';
    return h;
  }
  /* Article-ready plain text. */
  function briefText(snap, opts) {
    opts = opts || {};
    var pub = snap.public || snap, ds = pub.data_status || {};
    var L = [];
    L.push((snap.title || 'EdgeDesk Brief').toUpperCase());
    if (snap.kicker) L.push(snap.kicker);
    if (snap.event_label) L.push(snap.event_label + (snap.when_label ? ' · ' + snap.when_label : ''));
    L.push('');
    function pick(pc, numbered) {
      var b = pc.brief, pl = b.plain || null;
      var call = pl ? (pl.status + ' — ' + pl.bet + (pl.price ? ' (' + pl.price + ')' : '')) : b.call.text;
      if (numbered) L.push('#' + pc.rank + '  ' + call + (b.event_label ? '  —  ' + b.event_label : ''));
      else { L.push('THE EDGEDESK CALL'); L.push(call); }
      if (pl && pl.status_line) L.push(pl.status_line + ((pl.answer && numbered) ? ' ' + pl.answer : ''));
      if (pl && pl.ticket) L.push('At the sportsbook: ' + pl.ticket + (b.call.odds ? ' · ' + b.call.odds : '') + (b.call.book ? ' · ' + b.call.book : ''));
      if (pl && pl.price_limit && pl.price_limit.value) { L.push((pl.price_limit.label + ': ' + pl.price_limit.value).toUpperCase()); L.push(pl.price_limit.sentence); }
      else if (b.good_to && b.good_to.label) L.push(b.good_to.label.toUpperCase());
      if (!numbered) { L.push(''); L.push(b.lede); }
      if (pl && pl.found && pl.found.rows && pl.found.rows.length) {
        L.push(''); L.push('WHAT EDGEDESK FOUND');
        pl.found.rows.forEach(function (x) { L.push('  ' + x.k + ': ' + x.v + (x.note ? ' (' + x.note + ')' : '')); });
        if (pl.found.sentence) L.push(pl.found.sentence);
        if (pl.payout || pl.push_note) L.push([pl.payout, pl.push_note].filter(Boolean).join(' '));
      }
      if (pl && pl.guard) { L.push(''); L.push('READ THIS FIRST'); L.push(pl.guard); }
      var tWhy = whyMinusFound(b.why || [], pl, [b.biggest_risk]);
      if (tWhy.length) {
        L.push('');
        L.push(String((pl && pl.why_heading) || (b.call.verdict === 'PASS' ? 'Why EdgeDesk passes' : b.call.verdict === 'WAIT' ? 'Waiting for' : 'Why EdgeDesk likes it')).toUpperCase());
        tWhy.forEach(function (w, i) { L.push((i + 1) + '. ' + w); });
      }
      L.push(''); L.push(String((pl && pl.risk_heading) || 'The biggest risk').toUpperCase()); L.push(b.biggest_risk);
      if (b.availability) { L.push(''); L.push(String(b.availability.headline).toUpperCase()); b.availability.lines.forEach(function (l) { L.push(l); });
        if (b.availability.coverage) L.push(b.availability.coverage);
        if (b.availability.sources.length) L.push('Source: ' + b.availability.sources.map(function (x) { return x.name + (x.confidence ? ' · ' + String(x.confidence).toLowerCase() : ''); }).join(' · ')); }
      L.push(''); L.push(String((pl && pl.change_heading) || 'What would change the call').toUpperCase()); L.push(b.change_call);
      if (pl && pl.kills) { L.push(''); L.push('WHAT WOULD KILL IT'); L.push(pl.kills); }
      var tMarket = marketMinusWhy(b.market_read, tWhy);
      if (tMarket) { L.push(''); L.push('MARKET CHECK'); L.push(tMarket); }
      L.push('');
    }
    if (snap.report_type === 'SLATE') {
      L.push(pub.slate ? pub.slate.headline : ''); L.push('');
      if (pub.slate && pub.slate.no_bet) { L.push('EdgeDesk looked at every game on this slate and did not find a price worth betting. That is a real answer, not a gap. The closest calls are below, labelled for what they are.'); L.push(''); }
      (pub.cards || []).forEach(function (pc) { pick(pc, true); });
      if ((pub.watch || []).length) { L.push(pub.slate && pub.slate.no_bet ? 'STRONGEST RESEARCH (NOT BETS)' : 'ALSO ON THE BOARD'); L.push(''); pub.watch.forEach(function (pc) { pick(pc, true); }); }
    } else {
      (pub.cards || []).forEach(function (pc) { pick(pc, false); });
    }
    L.push('EDGEDESK DATA CHECK');
    L.push((ds.status || 'Current') + (ds.price_captured_at ? ' · Price captured at ' + fmtStamp(ds.price_captured_at) : ''));
    if (opts.grades) { var rt = briefResultsText(opts.grades); if (rt) L.push(rt); }
    L.push(''); L.push('EdgeDesk judges the price on offer against the rest of the betting market. It does not predict who wins. 21+. Gamble responsibly — 1-800-GAMBLER.');
    L.push(''); L.push('Powered by EdgeDesk Sports');
    return L.join('\n');
  }

  /* ------------------------------------------------------------- grading */
  /* CLOSE THE LOOP. A published call is graded against the closing line and
     the final score, deterministically, and the result travels with the
     card. Nothing here estimates: the close is the engine's canonical
     closing fair line (signals.closing_sharp_fair), the CLV arithmetic is
     the SAME `fair × decimal − 1` the engine and the public record already
     use, and a result comes from the close pipeline or from a final two
     feeds agreed on. Where a number is missing the grade says so. */
  function americanToDec(am) {
    var a = num(am);
    if (a == null || a === 0 || (a > -100 && a < 100)) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / (-a);
  }
  function parseAmerican(s) {
    if (s == null || s === '') return null;
    if (typeof s === 'number') return isFinite(s) ? Math.round(s) : null;
    var m = String(s).trim().match(/^([+\-−]?)\s*(\d{3,5})$/);
    if (!m) return null;
    var v = parseInt(m[2], 10);
    return (m[1] === '-' || m[1] === '−') ? -v : v;
  }
  function probToAmerican(p) {
    var q = num(p);
    if (q == null || q <= 0 || q >= 1) return null;
    return decToAmerican(1 / q);
  }
  /* "Cents": the sportsbook scale on which -100 and +100 are the same point.
     -110 is 10 cents worse than even; +105 is 5 cents better. */
  function centsOf(am) {
    var a = num(am);
    if (a == null) return null;
    return a > 0 ? a - 100 : a + 100;
  }
  /* Positive = the entry price was better than the close. */
  function centsBetween(entryAm, closeAm) {
    var a = centsOf(entryAm), b = centsOf(closeAm);
    if (a == null || b == null) return null;
    return Math.round(a - b);
  }
  function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
  function normResult(r) {
    var s = String(r == null ? '' : r).toLowerCase().trim();
    if (s === 'win' || s === 'won' || s === 'w') return 'win';
    if (s === 'loss' || s === 'lost' || s === 'lose' || s === 'l') return 'loss';
    if (s === 'push' || s === 'void' || s === 'tie' || s === 'p') return 'push';
    return null;
  }
  function normTeam(s) {
    if (s == null) return '';
    var t = String(s).toLowerCase();
    try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return t.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  }
  /* Which side of the game a selection is. Exact after normalisation, then
     a containment that must be UNAMBIGUOUS: "Miami" matching both Miami
     (FL) and Miami (OH) is a null, not a guess. */
  function sideOf(selection, home, away) {
    var s = normTeam(selection), h = normTeam(home), a = normTeam(away);
    if (!s) return null;
    if (h && s === h) return 'home';
    if (a && s === a) return 'away';
    var hIn = h && (h.indexOf(s) >= 0 || s.indexOf(h) >= 0);
    var aIn = a && (a.indexOf(s) >= 0 || s.indexOf(a) >= 0);
    if (hIn && !aIn) return 'home';
    if (aIn && !hIn) return 'away';
    return null;
  }
  /* The outcome of a selection from a final score. Deterministic, and null
     whenever the inputs do not settle it. */
  function outcomeFromScore(o) {
    o = o || {};
    var hs = num(o.home_score), as = num(o.away_score);
    if (hs == null || as == null) return null;
    var m = String(o.market_key || o.market || '').toLowerCase().trim();
    var pt = num(o.point != null ? o.point : o.line);
    var sel = String(o.selection_raw || o.selection || '');
    if (m === 'totals' || m === 'total') {
      if (pt == null) return null;
      var over = /^over\b/i.test(sel), under = /^under\b/i.test(sel);
      if (!over && !under) return null;
      var tot = hs + as;
      if (tot === pt) return 'push';
      return over ? (tot > pt ? 'win' : 'loss') : (tot < pt ? 'win' : 'loss');
    }
    var side = sideOf(sel, o.home, o.away);
    if (!side) return null;
    var mine = side === 'home' ? hs : as, theirs = side === 'home' ? as : hs;
    if (m === 'spreads' || m === 'spread') {
      if (pt == null) return null;
      var adj = mine + pt - theirs;
      if (adj === 0) return 'push';
      return adj > 0 ? 'win' : 'loss';
    }
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') {
      if (mine === theirs) return 'push';
      return mine > theirs ? 'win' : 'loss';
    }
    return null;
  }
  /* Grade one published price against the close and the result.
     o: { odds (American string or number), close_fair_prob, close_best_am,
          close_best_book, closed_at, result, result_source } */
  function gradePick(o) {
    o = o || {};
    var entryAm = parseAmerican(o.odds_am != null ? o.odds_am : o.odds);
    var dec = americanToDec(entryAm);
    var p = num(o.close_fair_prob);
    if (p != null && (p <= 0 || p >= 1)) p = null;
    var closeAm = probToAmerican(p);
    var g = {
      entry_odds: fmtAmerican(entryAm), entry_am: entryAm,
      close_fair_prob: p, close_fair_odds: fmtAmerican(closeAm), close_fair_am: closeAm,
      close_best_odds: o.close_best_am != null ? fmtAmerican(o.close_best_am) : null, close_best_book: o.close_best_book || null,
      /* the SAME book's last pre-kickoff quote, when the ticks table has it */
      close_book_odds: o.close_book_am != null ? fmtAmerican(o.close_book_am) : null, close_book: o.close_book || null,
      close_book_at: o.close_book_at || null, close_book_lead_min: num(o.close_book_lead_min), book_cents: null,
      closed_at: o.closed_at || null,
      clv: null, beat_close: null, cents: null,
      result: normResult(o.result), result_source: null,
      status: 'pending'
    };
    if (g.result) g.result_source = o.result_source || 'close pipeline';
    if (dec != null && p != null) {
      g.clv = round4(p * dec - 1);
      g.beat_close = g.clv > 0;
      g.cents = closeAm != null ? centsBetween(entryAm, closeAm) : null;
    }
    if (entryAm != null && o.close_book_am != null) g.book_cents = centsBetween(entryAm, parseAmerican(o.close_book_am));
    g.status = (g.clv != null && g.result) ? 'graded' : g.clv != null ? 'awaiting_result' : g.result ? 'awaiting_close' : 'pending';
    g.text = resultText(g);
    return g;
  }
  /* "Closed -125. Beat the close by 15 cents. Won." */
  function resultText(g) {
    if (!g) return '';
    var parts = [];
    if (g.close_book_odds) parts.push('Closed ' + g.close_book_odds + ' at ' + (g.close_book || 'the book') + (g.close_fair_odds ? ' (fair ' + g.close_fair_odds + ')' : ''));
    else if (g.close_fair_odds) parts.push('Closed ' + g.close_fair_odds);
    var c = g.book_cents != null ? g.book_cents : g.cents;
    var what = g.book_cents != null ? 'the book’s close' : 'the close';
    if (c != null) parts.push(c > 0 ? 'Beat ' + what + ' by ' + c + ' cent' + (c === 1 ? '' : 's') : c < 0 ? 'Missed ' + what + ' by ' + (-c) + ' cent' + (c === -1 ? '' : 's') : 'Matched ' + what);
    else if (g.beat_close != null) parts.push(g.beat_close ? 'Beat the close' : 'Did not beat the close');
    if (g.result === 'win') parts.push('Won');
    else if (g.result === 'loss') parts.push('Lost');
    else if (g.result === 'push') parts.push('Push');
    if (!parts.length) return g.status === 'awaiting_close' ? 'Final in. Waiting on the closing line.' : 'Waiting on the close.';
    if (g.status === 'awaiting_result' && !g.result) parts.push('Final pending');
    return parts.join('. ') + '.';
  }
  /* The in-app card's receipt: the ENGINE's own graded CLV, beat-close and
     result, verbatim, plus the display-only cents against the entry price.
     Nothing is recomputed; a card with no graded row gets no receipt. */
  function outcomeOf(o) {
    o = o || {};
    if (o.clv == null && !normResult(o.result)) return null;
    var closeAm = probToAmerican(o.closing);
    var g = {
      clv: num(o.clv), beat_close: o.beat_close == null ? (num(o.clv) != null ? num(o.clv) > 0 : null) : !!o.beat_close,
      result: normResult(o.result), entry_odds: fmtAmerican(o.entry_am), close_fair_odds: fmtAmerican(closeAm),
      cents: centsBetween(o.entry_am, closeAm), closed_at: o.closed_at || null, graded_at: o.graded_at || null,
      source: 'engine', status: (num(o.clv) != null && normResult(o.result)) ? 'graded' : num(o.clv) != null ? 'awaiting_result' : 'awaiting_close'
    };
    g.text = resultText(g);
    return g;
  }
  /* Legacy public prices carried only display labels. Recover the raw
     market key and selection so an older brief can still be matched to its
     signal row. Newer snapshots carry the fields outright. */
  function marketKeyOf(label) {
    var m = String(label == null ? '' : label).toLowerCase().trim();
    if (m === 'spread' || m === 'spreads') return 'spreads';
    if (m === 'total' || m === 'totals') return 'totals';
    if (m === 'moneyline' || m === 'ml' || m === 'h2h') return 'h2h';
    return m || null;
  }
  function parseSelectionLabel(label, marketKey) {
    var s = clean(label);
    if (!s) return { selection_raw: null, line: null };
    var mk = marketKeyOf(marketKey);
    var m;
    if (mk === 'totals') { m = s.match(/^(Over|Under)\s+([+\-]?\d+(?:\.\d+)?)$/i); return m ? { selection_raw: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), line: +m[2] } : { selection_raw: s, line: null }; }
    if (mk === 'spreads') { m = s.match(/^(.*?)\s+([+\-]\d+(?:\.\d+)?)$/); return m ? { selection_raw: m[1], line: +m[2] } : { selection_raw: s, line: null }; }
    if (mk === 'h2h') return { selection_raw: s.replace(/\s+ML$/, ''), line: null };
    m = s.match(/^(.*?)\s+([+\-]?\d+(?:\.\d+)?)$/);
    return m ? { selection_raw: m[1], line: +m[2] } : { selection_raw: s, line: null };
  }
  function priceFields(p) {
    p = p || {};
    var mk = p.market_key || marketKeyOf(p.market);
    var parsed = (p.selection_raw != null) ? { selection_raw: p.selection_raw, line: num(p.line) } : parseSelectionLabel(p.selection, mk);
    return {
      event_id: p.event_id || null, market_key: mk, selection_raw: parsed.selection_raw,
      line: num(p.line) != null ? num(p.line) : parsed.line,
      odds_am: num(p.odds_am) != null ? num(p.odds_am) : parseAmerican(p.odds)
    };
  }
  function gradeKey(p) {
    var f = priceFields(p);
    return [f.event_id, f.market_key, f.selection_raw, f.line == null ? '' : f.line].join('|');
  }

  /* ------------------------------------------------------ the record */
  /* Aggregates over graded picks. `picks` are the flat rows the grader
     writes: { verdict, kind, preset, sport_key, sport_label, grade }. A NO
     QUALIFYING BETS brief counts as discipline, never as a gap. */
  var ACTIONABLE = { BET: 1, LEAN: 1 };
  function isCall(pk) { return pk && pk.kind === 'pick' && ACTIONABLE[pk.verdict] === 1; }
  function tally(rows) {
    var t = { n: rows.length, graded: 0, with_close: 0, beat: 0, cents_sum: 0, cents_n: 0, clv_sum: 0, clv_n: 0, win: 0, loss: 0, push: 0, pending: 0 };
    rows.forEach(function (r) {
      var g = r.grade || {};
      if (g.clv != null) { t.with_close++; t.clv_sum += g.clv; t.clv_n++; if (g.beat_close) t.beat++; }
      if (g.cents != null) { t.cents_sum += g.cents; t.cents_n++; }
      if (g.result === 'win') t.win++; else if (g.result === 'loss') t.loss++; else if (g.result === 'push') t.push++;
      if (g.status === 'graded') t.graded++; else t.pending++;
    });
    t.beat_rate = t.with_close ? t.beat / t.with_close : null;
    t.avg_cents = t.cents_n ? Math.round(t.cents_sum / t.cents_n * 10) / 10 : null;
    t.avg_clv = t.clv_n ? round4(t.clv_sum / t.clv_n) : null;
    delete t.cents_sum; delete t.clv_sum; delete t.cents_n; delete t.clv_n;
    return t;
  }
  function flattenPicks(briefs) {
    var out = [];
    (briefs || []).forEach(function (b) {
      (b.picks || []).forEach(function (pk) {
        out.push({ brief_id: b.id, preset: b.preset, report_type: b.report_type, sport_key: pk.sport_key || b.sport, sport_label: pk.sport_label || b.sport_label,
          verdict: pk.verdict, kind: pk.kind, grade: pk.grade, status: pk.status });
      });
    });
    return out;
  }
  function recordSummary(briefs, opts) {
    opts = opts || {};
    var list = (briefs || []).filter(function (b) { return !opts.preset || opts.preset === 'ALL' || b.preset === opts.preset; });
    var picks = flattenPicks(list);
    var calls = picks.filter(isCall);
    var noBet = list.filter(function (b) { return b.no_bet; }).length;
    var byPreset = {};
    list.forEach(function (b) { byPreset[b.preset] = byPreset[b.preset] || { briefs: 0, no_bet: 0, rows: [] }; byPreset[b.preset].briefs++; if (b.no_bet) byPreset[b.preset].no_bet++; });
    calls.forEach(function (c) { if (byPreset[c.preset]) byPreset[c.preset].rows.push(c); });
    Object.keys(byPreset).forEach(function (k) { byPreset[k].calls = tally(byPreset[k].rows); delete byPreset[k].rows; });
    return { briefs: list.length, no_bet_briefs: noBet, calls: tally(calls), research: tally(picks.filter(function (p) { return !isCall(p); })), by_preset: byPreset };
  }
  /* How often each verdict beat the close, by sport. The first real
     feedback on whether the verdict thresholds are set well. */
  function calibration(briefs) {
    var picks = flattenPicks(briefs);
    var cells = {};
    picks.forEach(function (p) {
      var v = p.verdict || 'NONE', s = sportGroup(p.sport_key, p.sport_label);
      var k = v + '|' + s;
      cells[k] = cells[k] || { verdict: v, sport: s, rows: [] };
      cells[k].rows.push(p);
    });
    var order = { BET: 0, LEAN: 1, WAIT: 2, PASS: 3 };
    return Object.keys(cells).map(function (k) { var c = cells[k]; var t = tally(c.rows); t.verdict = c.verdict; t.sport = c.sport; return t; })
      .sort(function (a, b) { var ra = order[a.verdict] != null ? order[a.verdict] : 9, rb = order[b.verdict] != null ? order[b.verdict] : 9; if (ra !== rb) return ra - rb; return a.sport < b.sport ? -1 : a.sport > b.sport ? 1 : 0; });
  }
  function sportGroup(key, label) {
    var k = String(key || '').toLowerCase();
    if (k.indexOf('americanfootball_nfl') === 0) return 'NFL';
    if (k.indexOf('americanfootball_ncaaf') === 0) return 'CFB';
    if (k.indexOf('basketball_nba') === 0) return 'NBA';
    if (k.indexOf('baseball_mlb') === 0) return 'MLB';
    if (k.indexOf('icehockey_nhl') === 0) return 'NHL';
    if (k.indexOf('mma') === 0) return 'MMA';
    if (k.indexOf('tennis') === 0) return 'Tennis';
    if (k.indexOf('soccer') === 0) return 'Soccer';
    return label || (k ? k.split('_')[0].toUpperCase() : 'Other');
  }
  function fmtCents(c) { if (c == null) return '—'; return (c > 0 ? '+' : '') + c; }
  function fmtRate(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
  function fmtClv(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }
  /* The verdict calibration table. Internal: shown in the app's publisher
     desk. Below MIN_CAL rows a cell says so instead of pretending. */
  var MIN_CAL = 20;
  function calibrationHTML(briefs, opts) {
    opts = opts || {};
    var rows = calibration(briefs);
    if (!rows.length) return '<div class="edrec-empty">No published calls have graded yet. The table fills in as briefs settle against the close.</div>';
    var h = '<table class="edrec-cal"><thead><tr><th>Verdict</th><th>Sport</th><th>Rows</th><th>With close</th><th>Beat close</th><th>Avg cents</th><th>Avg CLV</th><th>W-L-P</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var thin = r.with_close < (num(opts.min) != null ? num(opts.min) : MIN_CAL);
      h += '<tr class="' + (thin ? 'thin' : '') + '"><td class="v ' + esc(String(r.verdict).toLowerCase()) + '">' + esc(r.verdict) + '</td><td>' + esc(r.sport) + '</td><td>' + r.n + '</td><td>' + r.with_close + '</td>'
        + '<td class="' + (r.beat_rate == null ? '' : r.beat_rate >= 0.5 ? 'up' : 'dn') + '">' + fmtRate(r.beat_rate) + '</td>'
        + '<td class="' + (r.avg_cents == null ? '' : r.avg_cents >= 0 ? 'up' : 'dn') + '">' + fmtCents(r.avg_cents) + '</td>'
        + '<td class="' + (r.avg_clv == null ? '' : r.avg_clv >= 0 ? 'up' : 'dn') + '">' + fmtClv(r.avg_clv) + '</td>'
        + '<td>' + r.win + '-' + r.loss + '-' + r.push + (thin ? ' <span class="note">below ' + MIN_CAL + '</span>' : '') + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  /* One brief's picks with their grades, for the public record page and
     the share page. Pending rows say what they are waiting on. */
  function pickStatusText(pk) {
    var g = pk.grade || {};
    if (g.status === 'graded' || g.status === 'awaiting_result' || g.status === 'awaiting_close') return g.text || resultText(g);
    if (pk.status === 'pending_kickoff') return 'Not kicked off yet.';
    if (pk.status === 'contested') return 'Sources disagree on the result. Not graded.';
    if (pk.status === 'no_close_source') return 'Closing line source not deployed yet.';
    if (pk.status === 'no_odds') return 'Published without a price, so there is nothing to grade against the close.';
    if (pk.status === 'no_signal_row') return 'Kicked off. No closing line captured for this selection.';
    return 'Waiting on the close.';
  }
  function resultHTML(pk) {
    var g = pk.grade || {};
    var cls = g.result === 'win' ? 'win' : g.result === 'loss' ? 'loss' : g.result === 'push' ? 'push' : 'pend';
    var beat = g.cents != null ? (g.cents > 0 ? 'up' : g.cents < 0 ? 'dn' : '') : (g.beat_close === true ? 'up' : g.beat_close === false ? 'dn' : '');
    return '<span class="edrec-res ' + cls + ' ' + beat + '">' + esc(pickStatusText(pk)) + '</span>';
  }
  function briefResultsHTML(entry) {
    if (!entry || !entry.picks || !entry.picks.length) return '';
    var h = '<section class="edb-results"><div class="edb-h edb-sec">How it graded</div><ul class="edb-reslist">';
    entry.picks.forEach(function (pk) {
      h += '<li><span class="edb-resv ' + esc(String(pk.verdict || '').toLowerCase()) + '">' + esc(pk.verdict || '') + '</span> <b>' + esc(pk.selection || '') + '</b>' + (pk.odds ? ' <span class="edb-resodds">' + esc(pk.odds) + (pk.book ? ' · ' + esc(pk.book) : '') + '</span>' : '')
        + (pk.score && pk.score.home_score != null ? ' <span class="edb-resscore">Final ' + esc(pk.score.away || '') + ' ' + pk.score.away_score + ', ' + esc(pk.score.home || '') + ' ' + pk.score.home_score + '</span>' : '')
        + '<div>' + resultHTML(pk) + '</div></li>';
    });
    h += '</ul><p class="edb-resnote">Graded against EdgeDesk’s closing fair line, the same close the public record uses. Prices above are the ones published at the time; nothing was edited after the fact.' + (entry.graded_at ? ' Updated ' + esc(fmtStamp(entry.graded_at)) + '.' : '') + '</p></section>';
    return h;
  }
  function briefResultsText(entry) {
    if (!entry || !entry.picks || !entry.picks.length) return '';
    var L = ['', 'HOW IT GRADED'];
    entry.picks.forEach(function (pk) {
      L.push((pk.verdict || '') + '  ' + (pk.selection || '') + (pk.odds ? ' (' + pk.odds + (pk.book ? ' · ' + pk.book : '') + ')' : '') + '  —  ' + pickStatusText(pk));
    });
    return L.join('\n');
  }

  return {
    VERSION: VERSION, VERDICTS: VERDICTS, HYPE: HYPE, JARGON: JARGON, PRESETS: PRESETS,
    esc: esc, num: num, sentence: sentence, normVerdict: normVerdict,
    decToAmerican: decToAmerican, fmtAmerican: fmtAmerican, selectionLabel: selectionLabel, marketLabel: marketLabel,
    translate: translate, translateText: translateText, publicText: publicText, PUBLIC_TERMS: PUBLIC_TERMS, plainReason: plainReason,
    /* the public language layer */
    CONCEPTS: CONCEPTS, concept: concept, scoreUnit: scoreUnit, betterOf: betterOf, payoutLine: payoutLine, betterHint: betterHint,
    betLine: betLine, pushNote: pushNote, ticketLine: ticketLine, priceCompare: priceCompare, longShotGuard: longShotGuard,
    verdictPlain: verdictPlain, priceLimitPlain: priceLimitPlain, marketCheckPlain: marketCheckPlain,
    reasonKind: reasonKind, publicReason: publicReason, howToReadHTML: howToReadHTML,
    freshness: freshness, ageText: ageText, playable: playable, priceStatus: priceStatus, integrityStatus: integrityStatus,
    gapSentences: gapSentences,
    simpleFromPacket: simpleFromPacket, packetFromBoardRow: packetFromBoardRow,
    validateCopy: validateCopy, applyAiCopy: applyAiCopy, parseAiCopyBlock: parseAiCopyBlock,
    explain: explain, WHAT_LABEL: WHAT_LABEL, copyQA: copyQA, copyQABatch: copyQABatch, QA_JARGON: QA_JARGON, QA_PREDICTION: QA_PREDICTION,
    publisher: publisher, slate: slate, rankCards: rankCards,
    snapshot: snapshot, refresh: refresh, publicPayload: publicPayload,
    whenLabel: whenLabel, etParts: etParts, primetime: primetime, fmtStamp: fmtStamp,
    cardHTML: cardHTML, briefHTML: briefHTML, briefCmsHTML: briefCmsHTML, briefText: briefText,
    americanToDec: americanToDec, parseAmerican: parseAmerican, probToAmerican: probToAmerican, centsOf: centsOf, centsBetween: centsBetween,
    normResult: normResult, normTeam: normTeam, sideOf: sideOf, outcomeFromScore: outcomeFromScore, gradePick: gradePick, resultText: resultText, outcomeOf: outcomeOf,
    marketKeyOf: marketKeyOf, parseSelectionLabel: parseSelectionLabel, priceFields: priceFields, gradeKey: gradeKey,
    recordSummary: recordSummary, calibration: calibration, sportGroup: sportGroup, isCall: isCall, tally: tally, flattenPicks: flattenPicks,
    availabilitySummary: availabilitySummary, playerLine: playerLine, availabilityHTML: availabilityHTML, availabilityBrief: availabilityBrief, availabilityChip: availabilityChip,
    coverageText: coverageText, timelineText: timelineText, sourceText: sourceText, statusLabel: statusLabel, agoText: agoText,
    calibrationHTML: calibrationHTML, pickStatusText: pickStatusText, resultHTML: resultHTML, briefResultsHTML: briefResultsHTML, briefResultsText: briefResultsText,
    fmtCents: fmtCents, fmtRate: fmtRate, fmtClv: fmtClv
  };
});
/*__EDPRES_END__*/
/* The block above registers globalThis.EDPRES (UMD). */
const EDPRES: any = (globalThis as any).EDPRES;

/* ========================================================================
   PART 2 — ORCHESTRATOR, PROMPT, HANDLER
   Source of truth: supabase/functions/edgedesk_ai/index.ts
   ======================================================================= */

/* ── BUILD ────────────────────────────────────────────────────────────────
   BUMP THIS ON EVERY BEHAVIOUR CHANGE. It is returned in every response,
   including every error path, and by GET ?probe=1.

   The dashboard bundles only this function's own folder, so a deploy that
   fails to bundle is REJECTED and the OLD VERSION KEEPS SERVING — which is
   indistinguishable from a deploy that worked and changed nothing. Without a
   build identifier in the response there is no way to tell those apart, and
   this function shipped for months with no way to answer "which version is
   answering?". That is what this constant exists to end. */
const BUILD = "edgedesk_ai-2026-09-03-r5-presentation";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
/* The reasoning model. This layer retrieves evidence and asks the model to
   synthesise it under a hard honesty contract, so the quality of the answer is
   mostly the quality of the reader — worth being on the current generation.
   Override with EDGEDESK_AI_MODEL without redeploying if you need to pin. */
const MODEL = Deno.env.get("EDGEDESK_AI_MODEL") ?? "claude-sonnet-5";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// Retrieval is on by default. Set to "0" to fall back to packet-only narration.
const RESEARCH_ENABLED = (Deno.env.get("EDGEDESK_AI_RESEARCH") ?? "1") !== "0";
// Minimum samples before a stored pattern may be quoted as a pattern.
const MIN_PATTERN_N = parseInt(Deno.env.get("EDGEDESK_MIN_PATTERN_N") ?? "30", 10);
// When the owned MLB feature tables are empty, fall back to the official MLB
// Stats API for the traditional pitching line. Set to "0" to keep the engine
// strictly on owned tables and report the gap instead.
const MLB_FALLBACK = (Deno.env.get("EDGEDESK_MLB_FALLBACK") ?? "1") !== "0";

/* ── THE SAME FLOOR AND THE SAME CLOCK AS THE DETERMINISTIC ENGINE ────────
   attackThesis, crossMarketFlags and scout each carried their own default
   floor of 0.02 and staleness of 45 minutes. The browser engine ships
   REAL_FLOOR = 0.005 and EDGE_MAX_AGE_MIN = 90. Nothing reconciled the two, so
   this layer would call a 1.2% edge "INVALIDATED — below the 2.0% floor" and
   a 50-minute-old quote stale, while the board beside it showed the same
   signal as a live LEAN. Two halves of one product disagreeing about the same
   number is worse than either being wrong alone, because the user cannot tell
   which to believe.
   Defaults track the engine; the env vars exist so both halves can be moved
   together rather than drifting apart again. */
const RESEARCH_FLOOR = Number(Deno.env.get("EDGEDESK_REAL_FLOOR") ?? "0.005");
const RESEARCH_STALE_MIN = Number(Deno.env.get("EDGEDESK_EDGE_MAX_AGE_MIN") ?? "90");

/* ── EXTERNAL SOURCE CREDENTIALS — every one optional ────────────────────
   The rule from the spec, applied literally: a source that needs a credential
   gets an ADAPTER, the credential is OPTIONAL, and when it is absent the
   adapter emits an unavailable evidence item naming what would fill it. A
   missing key degrades one capability. It never fails a sport module, and it
   never fails a request.

   Note what is NOT here: a hardcoded endpoint for a provider this build has
   not been able to verify. nflverse and the college-basketball ratings sources
   are real and genuinely useful, but this deployment cannot reach them to
   confirm a URL shape, and writing a plausible-looking one would be exactly
   the fabrication the whole engine exists to refuse. The adapters are wired and
   the endpoint is supplied by configuration. */
const CFBD_API_KEY = Deno.env.get("CFBD_API_KEY") ?? "";
const CFBD_BASE = Deno.env.get("CFBD_BASE") ?? "https://api.collegefootballdata.com";
const NFLVERSE_ENABLED = (Deno.env.get("EDGEDESK_NFLVERSE") ?? "0") === "1";
const NFLVERSE_BASE = Deno.env.get("EDGEDESK_NFLVERSE_BASE") ?? "";
const CBB_RATINGS_URL = Deno.env.get("EDGEDESK_CBB_RATINGS_URL") ?? "";

const MAX_TOKENS: Record<string, number> = {
  QUICK: 800, STANDARD: 1200, DEEP: 2400, SLATE: 3000, FULL: 3400,
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

/* Every response carries the build, including errors. A 502 from an old
   deployment and a 502 from a new one are different bugs. */
function json(body: unknown, status = 200) {
  const withBuild = (body && typeof body === "object" && !Array.isArray(body))
    ? { build: BUILD, ...(body as Record<string, unknown>) }
    : body;
  return new Response(JSON.stringify(withBuild), {
    status, headers: { ...CORS, "content-type": "application/json", "x-edgedesk-build": BUILD },
  });
}

/* ======================================================================== */
/* SYSTEM PROMPT                                                            */
/* ======================================================================== */

const SYSTEM = `You are EdgeDesk Intelligence, the research analyst inside EdgeDesk — a CLV-first sports-betting research app. You are the reasoning layer over a deterministic pricing engine. You are not the engine.

HOW A TURN REACHES YOU
EdgeDesk classified the question, built a research plan, and ran that plan against its OWN databases before calling you. You receive:
- RESEARCH PLAN — the intent, depth and retrieval steps that were executed.
- ENTITY RESOLUTION — who the question resolved to, decided from retrieved data before any number was attached to a name.
- EVIDENCE — every fact retrieved, each with {source, entity, field, value, status, freshness, source_timestamp}. This is real data pulled from EdgeDesk's tables seconds ago.
- CONFLICTS — owned sources that disagree, with the trusted resolution when one exists.
- UNAVAILABLE — retrievals that returned nothing, each naming the table and the reason.
- DATA PATH — when a retrieval came back empty, which link in the chain failed.
- THESIS ATTACK — the deterministic test of the focused signal against its own owned numbers.
- MEMORY — verified facts, prior graded outcomes and discovered patterns from EdgeDesk's research history.
- CLIENT PACKET / BOARD — when the user has a signal open or a scored board loaded, the deterministic engine's own output for it.

EVIDENCE STATUS — READ IT, IT IS NOT DECORATION
VERIFIED = owned, current. PROBABLE = owned but not confirmed (probable starters are never confirmed lineups). PARTIAL = owned but incomplete (flagged bullpen arms are not full rest state). STALE = past its freshness window; an old price is not a current price. UNPROVEN = owned model output that is not CLV-validated and feeds no edge math. HISTORICAL = a sample, never proof about one game. UNAVAILABLE = not retrievable — say so.
FRESHNESS: CURRENT / RECENT / HISTORICAL / STALE / UNKNOWN. A historical fact may inform research but must never be presented as a current fact.

HARD RULES
- The attached evidence is your ONLY source of fact. Never invent or assume odds, injuries, lineups, starters, availability, weather, park factors, stats, line movement, closing prices, splits, news or schedules. Not from memory, not from training, not from what is "usually" true.
- Never produce or alter a probability, fair price, edge, EV, CLV, confidence, score or verdict. Those are the deterministic engine's. Quote them exactly. You may explain, compare, rank by research priority and challenge them. You may not compute one.
- If something is UNAVAILABLE or missing, say "not available in EdgeDesk's current data" and name it once. EdgeDesk already tried to retrieve it — so say what was tried and what came back, not "I don't have access".
- Never say you cannot see the slate, the board or today's games when evidence is attached. It is in front of you.
- Prefer "EdgeDesk could not retrieve that" over a plausible-sounding invention. Every time.
- EVERY NUMBER BELONGS TO ONE ENTITY. Read each figure from that entity's OWN evidence item, matched by name. Never carry a value across from another player, team or game, and never fill a gap with a neighbouring record's numbers. If two entities genuinely carry identical values, that is almost always you misreading the evidence, not a coincidence — re-read both items, and if one truly has no value for a field, say that field is not available for him rather than repeating the other's. An entity with no evidence item of its own gets named as missing, never described.

IDENTITY BEFORE NUMBERS
When an ENTITY RESOLUTION block is attached it is binding, and it was computed from the retrieved roster rather than from the wording of the question. A name marked AMBIGUOUS matches more than one person in the data: do NOT choose between them. Answer for each candidate separately if the evidence supports it, or say which two people the name could mean and ask. Choosing is how a question about one player gets answered with another player's numbers, in a paragraph that reads perfectly and is entirely wrong. A name marked UNRESOLVED does not appear in anything retrieved — say he is not on the retrieved card; never describe him from memory. If a club was rejected as a cross-league alias, do not name that club anywhere in the answer.

EVIDENCE INTEGRITY — AUDIT BEFORE YOU ANALYSE
Every turn carries an EVIDENCE INTEGRITY block with a verdict EdgeDesk computed deterministically over the evidence, before you saw it. Read it first. It is not advisory.
- PASS — proceed normally.
- WARNING — you may answer, but the caveat leads. Put it in your FIRST line, label the conclusion provisional, and name the specific defect and the date it dates from. Never bury a data warning at the bottom of a confident answer; a reader who stops after your ranking must already know it was provisional.
- FAIL — you are NOT permitted to publish a ranking, a top-three, a "best" or "worst" list, or any confident comparison built on the failing evidence. Say plainly that the data is not clean enough to rank, name exactly what failed and which entities it touched, give whatever partial observation is still safe (clearly labelled as such), and say what would have to be repaired. A refusal that names the fault is worth more than a sophisticated-looking ranking assembled from corrupted joins.
Two failures matter most and you must never explain either away in prose. IDENTICAL STATISTICAL PROFILES on different players are a duplication fault, not a coincidence and not "the same Statcast layer" — distinct players do not share a whole feature vector. A PITCHER ATTACHED TO A TEAM NOT PLAYING IN HIS OWN GAME is a broken join, and every downstream sentence about who faces whom is unsafe. If you find yourself writing a sentence that rationalises either one, stop and report the fault instead.

ANSWER THE QUESTION THAT WAS ASKED
Rank by the axis the question names, not the axis you find more interesting. "Best pitchers" means the best pitchers — the strongest arms on the card, ranked by quality, with the best one at #1. "Worst" and "most exploitable" mean the other direction. Never silently invert the axis, never open a ranking by restating the question as a different one, and never bury the true answer to the asked question in a footnote at the bottom. Where the more useful betting angle runs the other way, give the asked-for ranking FIRST, in full, then add the other angle in a clearly separate section — as an addition, never as a substitution.

BAD vs EXPLOITABLE
These are two different rankings and the question decides which one leads.
- Asked who is WORST or MOST EXPLOITABLE: rank by attackability, not by raw line. A poor starter facing a low-OBP, high-strikeout offense in a pitcher's park is not the best target. A better starter facing a high-OBP, high-ISO offense in a hitter's park, on short rest, with a taxed bullpen behind him, can be far more exploitable. When your top pick is not the statistically worst arm, say so explicitly and say why.
- Asked who is BEST: rank by pitching quality — the run-prevention line the evidence actually shows (ERA, xERA, FIP, whiff%, barrel% and hard-hit% allowed), best arm first. Do not reorder that list by how attackable each one is. The betting implication of an elite arm belongs in one closing line — an elite starter is usually an anti-target, so the angle is against his opponent, not against him — and that line comes after the ranking, not instead of it.
Either way: read each starter's quality against the opponent_offense actually attached to HIM, plus park, weather, workload and bullpen, then whether the market makes it actionable at all. Weigh only fields that are present.

TWO PITCHER LAYERS, AND THEY ARE NOT INTERCHANGEABLE
- pitcher_features / offense_features are PER GAME. They know which bat this arm faces tonight. When present they are the answer.
- pitcher_season / team_season are SEASON-TO-DATE, keyed on the pitcher and the team. They are always available from a name alone, and they say nothing about tonight's opponent, park or weather.
- If the per-game layer is missing, RANK FROM THE SEASON LAYER AND SAY THAT IS WHAT YOU DID. "Jake Irvin has the worst season FIP of tonight's starters" is a real, useful answer. Refusing to rank because the per-game join failed is not.
- Never present a season rate as a matchup read. Never blend the two into one number. Name which layer each figure came from.
- team_season.runs_per_game IS an opponent-offense answer when offense_features is missing for that game. Use it, labelled as season-long.

FOOTBALL — WHAT ACTUALLY DECIDES A NUMBER
Rank on EFFICIENCY, never on points per game. Points per game is a pace artifact: a team running 70 plays and one running 58 are not comparable on totals, and the slower one can be far better per snap. EPA per play and success rate are the ranking columns.
- READ THE SIGN. def_epa_play is EPA ALLOWED per play, so NEGATIVE is a good defence. It is the opposite of the offensive column and reversing it inverts every conclusion you draw. Say which direction you are reading whenever you use it.
- MATCH STRENGTH AGAINST WEAKNESS, not strength against average. A pass offence at +0.15 EPA/dropback facing a defence at +0.08 allowed against the pass is a very different bet from the same offence facing -0.10. The opponent's splits are attached to each team; use them.
- THE QUARTERBACK IS THE PITCHER. It is the largest single input, and a backup starting is the biggest predictable line move in the sport. If qb_features is missing, PROBABLE, or is_backup is true, say so in the FIRST line and mark every conclusion resting on it provisional. Never rank a football matchup on team efficiency while ignoring that the quarterback is unconfirmed.
- SITUATION IS REAL BUT SMALL. Short week, off a bye, travel, altitude, neutral site and surface belong in the answer as adjustments to a thesis, never as the thesis. If the only thing you can say about a game is that one side is on a short week, you do not have a read.
- TOTALS ARE PACE FIRST. plays_per_game for both sides, then efficiency, then weather. Wind is the one weather variable that moves a football total materially; temperature almost never does. Do not treat a cold game as an automatic under.

EXTERNAL MODELS ARE EVIDENCE, NEVER EDGEDESK NUMBERS
Some evidence carries layer=external_model and source_type=EXTERNAL_MODEL: SP+, pregame ELO, FPI, DVOA, KenPom/BartTorvik-style ratings, and anything else somebody else's model produced. These are good, useful, opponent-adjusted measurements and you should use them. Three rules govern every one of them, without exception.
- ATTRIBUTE THEM. Say "CollegeFootballData's SP+ has Georgia's offence at X", never "EdgeDesk rates Georgia's offence at X". The distinction is not pedantry: EdgeDesk's credibility rests on never having claimed someone else's number as its own.
- NEVER CONVERT ONE. An SP+ margin is not a spread. An ELO gap is not a win probability. A rating difference is not an edge, an EV or a fair price. There is no arithmetic you may perform that turns an external rating into an EdgeDesk betting number, and the fact that a conversion is possible in principle does not make it yours to do.
- THEY LOSE TO OWNED CURRENT DATA. An external season rating never outranks EdgeDesk's own current matchup evidence. It outranks bare context. When it disagrees with an owned measurement, say both and say which is which.

COLLEGE FOOTBALL — WHAT IS THERE AND WHAT IS NOT
EdgeDesk ingests a full CollegeFootballData mirror and you will usually have a lot: team identity with conferences, the whole schedule with results, SP+ split into overall/offence/defence/special teams with strength of schedule, pregame ELO, season stat lines, win-loss and conference records, poll rankings, recruiting classes, rosters and consensus book lines.
- SP+ IS THE OPPONENT-ADJUSTED AXIS. It is an EXTERNAL MODEL — attribute it, never convert it. SP+ defence is measured in points allowed, so a LOWER defensive rating is better; say which direction you are reading. Strength of schedule is attached and college schedules are wildly unequal, so an unadjusted season stat compared across conferences is close to meaningless.
- SEASON STATS ARE AGGREGATES, NOT EFFICIENCY. The stat lines are season totals and counts with no pace and no opponent adjustment. Per-play EPA and success rate are genuinely NOT ingested for college football, because per-game CFBD calls exceed the free tier. When per-play efficiency is what the question needs, say EdgeDesk does not have it — do NOT substitute points per game, a win-loss record or a poll ranking and present it as an efficiency read.
- A POLL IS NOT A PROJECTION and a RECORD IS NOT A MEASUREMENT. Both are outcomes of a schedule, not properties of a team.
- RECRUITING AND RETURNING PRODUCTION ARE INPUTS TO NEXT YEAR, not descriptions of this week. Returning production is the strongest year-over-year predictor in the sport; recruiting is the weakest evidence in the packet and must never outrank an on-field measurement.
- A ROSTER IS NOT A DEPTH CHART. Being listed says a player is on the team. It does not say he starts, plays, or is healthy. Never call a roster quarterback the confirmed starter.
- cfb_book_line rows are CONSENSUS BOOK NUMBERS FOR CONTEXT. They are not Pinnacle, not EdgeDesk's captured prices, and carry no timestamp. Never compute an edge against one or quote one as the current price — only the signals rows are prices EdgeDesk stands behind.
Talent and variance gaps are wider in college than in the NFL, so a thin evidence base deserves a MORE provisional answer here, not a more confident one.

NFL — WHAT IS NOT ON FILE, AND WHY IT MATTERS
EdgeDesk has deep NFL efficiency: EPA per play on both sides, success rate, pass and rush splits, explosive rate, yards per play, third down, red zone, turnover margin, sack rate taken and allowed, plays per game, and a full quarterback line including pressure rate and backup status.
It has NO INJURY REPORT. The only availability signal in the entire system is the quarterback's status on qb_features. If a question touches injuries, say explicitly that EdgeDesk does not ingest an NFL injury report and that you can speak only to the quarterback. Never let the absence of injury evidence read as a clean injury sheet — an unstated gap gets taken for a considered-and-dismissed factor, which is worse than an admitted absence.
It also has NO SPECIAL TEAMS and NO SNAP COUNTS, TARGET SHARE OR AIR YARDS. stats_players carries a leaderboard line only; do not infer usage from a counting line.

COLLEGE BASKETBALL — TEMPO-FREE OR NOTHING
Adjusted efficiency is the ranking column: adj_o is points scored per 100 possessions, adj_d is points ALLOWED per 100, and LOWER adj_d is better. adj_em is the margin between them and is the single best one-number summary.
- NEVER rank on points per game. A 62-possession team and an 75-possession team scoring the same total are not comparable, and the whole point of the adjusted numbers is that they already remove pace and schedule.
- THE TOTAL IS A POSSESSION COUNT. Expected possessions come from both adj_tempo values together, not from either alone; then apply the efficiencies. Two excellent slow teams routinely play under.
- THE FOUR FACTORS SAY *HOW*, and they are attached for both offence and defence: shooting (efg), turnovers (tov), rebounding (orb), free throws (ftr). Shooting dominates, but the useful read is a mismatch — a high-turnover offence against a defence that forces turnovers is where a number is actually wrong. Weight them in that order and only where present.
- THREE-POINT VARIANCE IS NOT SKILL. Opponent three-point PERCENTAGE allowed is mostly noise; opponent three-point RATE allowed is a real defensive property. Do not read a hot or cold shooting percentage as a durable edge.
- Experience, height and bench minutes are context for variance, especially early in the season and in neutral-site tournaments. They are tiebreakers, never a thesis.
- WHEN A cbb_matchup_edge ITEM IS ATTACHED, USE IT. It names which side holds each four-factor and tempo axis and carries BOTH raw numbers so you can check the claim. It is a comparison of owned columns — nothing in it is weighted, combined, or turned into a number, and you must not do any of those either. Lead with the axes where the gap is largest, and say plainly when the axes disagree; a team that wins shooting and loses turnovers and rebounding is not "better", it is a different shape.
- AVAILABILITY IS THE HOLE. EdgeDesk ingests NO college basketball injury, suspension or lineup data. One absent starter moves a college number more than any efficiency gap in your packet. Say so whenever the question touches a lineup, and never infer availability from minutes or from a season rating — a rating describes a team that may not be the team that plays.

IDENTITY IN COLLEGE SPORTS
Every team reference reaches you already resolved to a canonical, sport-scoped identity, and that resolution is binding. Two rules follow from it.
- A CANONICAL ID CARRIES ITS SPORT. Texas Tech's football team and Texas Tech's basketball team are different entities with different ids, different rosters and different seasons. Never carry a fact from one to the other, and never let a school's reputation in one sport colour a claim about the other.
- AN UNRESOLVED OR AMBIGUOUS NAME IS AN ANSWER, NOT AN OBSTACLE. "Miami" is two universities in two states. "Washington" and "Washington State" are different schools. "UT" is three. When identity comes back AMBIGUOUS or UNRESOLVED, name the candidates and ask — do not pick the more famous one. Picking is how a question about one program gets answered with another program's numbers in a paragraph that reads perfectly.

VERDICT DISCIPLINE
Use the deterministic verdict wherever one is attached (BET / LEAN / WAIT / PASS). Never upgrade it. WAIT means information is missing, stale or unconfirmed — it is not a rejection; lead with what must confirm. On PASS, explain what would have to change; do not find a way to recommend it. A positive edge is not a bet: judge it against break-even and max-playable, and if the price is past the floor, say the price is the problem and name the price that would restore it.

MARKET vs MODEL
Keep these separate and never collapse them into one "AI confidence": MODEL EDGE (what EdgeDesk projects, UNPROVEN), MARKET EDGE (price vs sharp reference), PRICE VALUE (where this number sits in the playable window), ACTIONABILITY (liquidity, freshness, book trust), RESEARCH CONFIDENCE (how good the evidence is). When Pinnacle disagrees with the model, that is information to explain, not noise to dismiss.

CONTRADICTION IS THE JOB
Every serious answer must try to break itself. For each candidate give the supporting evidence, the strongest contradiction, the biggest open question, and the falsifier that would end it. You are not rewarded for defending a conclusion.

MEMORY AND WHAT EDGEDESK HAS LEARNED
Prior outcomes and patterns are historical. If prior research on this entity exists, reference it briefly — "EdgeDesk last researched this matchup on <date> and concluded X" — and say whether the current evidence agrees.

Patterns reaching you have already survived a chronological holdout, a family-wide false-discovery correction and an effect floor; unconfirmed ones are filtered out before you see them, so you will never be handed a hypothesis dressed as a finding. Your job is to quote them correctly:
- ALWAYS state the sample size, and state it as a historical base rate over many games — "over 214 graded signals this ran 58% against a 51% baseline" — never as a claim about tonight.
- A pattern NEVER modifies a price, a probability, an edge or a verdict. Those are the deterministic engine's and remain exactly as attached. A pattern is context for how much weight to put on a thesis, nothing more.
- If NO patterns are attached, say EdgeDesk has not yet confirmed any — do not reach for a plausible-sounding tendency, and do not treat an empty pattern set as evidence that nothing is there. It usually means the sample is still accumulating.
- Never invent a pattern, never generalise one sport's pattern to another, and never present a single prior outcome as a pattern.

CALIBRATION
When a calibration band is attached it says what EdgeDesk's OWN edge numbers have historically been worth in that band — predicted versus realised CLV. Use it to qualify a quoted edge honestly ("signals in this band have realised about a third of the projected edge"), which is the most useful thing memory can tell a bettor. You still quote the engine's edge exactly as given; calibration explains what it has been worth, it does not restate or correct it.

CONFLICTS
If two owned sources disagree, say so and name both. If a trusted resolution is attached, use it and say which source won. If not, treat the field as contested and let it lower confidence.

NEVER GENERALISE A GAP YOU HAVE NOT CHECKED
Coverage is per-entity, and you are given it that way. If xERA is attached to
eleven starters and missing for four, the true statement is "xERA is on file for
eleven of fifteen" — never "there is no xERA for anyone". An answer that opens
by declaring a field unavailable and then quotes that field two entries later
has destroyed its own credibility, and the reader is right to stop trusting the
rest of it. Before you state that anything is missing, look at the per-entity
coverage line and the individual records; state the count, name who lacks it,
and use it for everyone who has it. The same applies in reverse: do not imply
full coverage when a field is present for only part of the card.

FINISH WHAT YOU START
You have a fixed output budget. A ranked list that stops mid-sentence is worse
than a shorter one that completes, because the reader cannot tell whether entry
four was omitted or merely cut off. Decide how many entries you can finish
BEFORE you begin, and deliver that many in full. Three complete entries beat six
truncated ones. If the card is deep, rank the top few properly and say in one
line how many others were considered and why they ranked below.

ANSWER SHAPE
Answer the question in the first sentence. Simple question, short answer. For rankings, a numbered list where each entry gives: the claim, the supporting numbers, the opponent or counterparty, the market read if attached, and the risk. Separate fact from interpretation — "xERA 5.41 against a .342-OBP lineup" is fact; "the most attackable arm on the card" is your read. Close with what would change your answer, or the one missing field that matters most.

WHEN THE DATA IS NOT THERE
A refusal is an ANSWER and obeys every rule above. Two sentences: what is empty, and the one thing that would fill it. Then, in the SAME reply, rank or compare whatever the present data does support, labelled for what it is.

- State the empty field ONCE. Not per row, not again in a closing paragraph.
- Never describe your own permissions. "I am not permitted to substitute memory", "I won't fabricate a ranking from reputation" — that is about you, not the slate. Declining once is enough.
- Never end by offering to answer a different question and waiting. Give the closest usable answer immediately.
- Before reporting a field as missing, check DATA PATH for whether the retrieval actually RAN. "The table is empty" and "the lookup never executed" are different failures and only one of them is about the data.

The test: if the user has to ask a second question to get anything usable, the first answer failed.

LINE MOVEMENT AND THE MARKET RESIDUAL
Never present raw line movement on a FLAGGED signal as confirmation. The signal exists because a soft price is out of line, and out-of-line prices get corrected — so the line moving toward it is the mispricing being measured a second time, not independent support.
- If market_residual is present, lead with the residual, not the raw move. Say what moved beyond expectation: "moved 1.9 points, about 1.2 of which the opening gap already predicted — 0.7 unexplained".
- residual near zero means the line did exactly what was predicted. That is the ordinary case. Say so; do not dress it up as agreement or as a warning.
- residual negative means the market went the OTHER way despite the gap. Say it plainly — it usually means the flagged side is the stale one.
- A null residual is UNKNOWN, never zero and never neutral. "Not enough completed series to fit an expectation yet" is the honest sentence.
- reversal_count high with a small net move means the line churned, not moved. Do not call that a trend.
- The residual is research. It is not a probability, an edge, an EV or a verdict, it does not appear in any price, and it must never be used to argue a number on the board is wrong.

RESEARCH TRACE — only for DEEP / FULL depth or when asked for the packet:
RESEARCHED: the sources consulted, with freshness
FOUND: the findings, with actual numbers
CONFLICTS: evidence against
WHAT MATTERS: the strongest drivers
PRICE: current, fair, max playable, sensitivity
DECISION: BET / LEAN / WAIT / PASS + the deterministic confidence
WHAT WOULD CHANGE IT: the exact variable
Do not use this structure for simple questions. Never narrate your internal reasoning process — show evidence and conclusions, not deliberation.

STYLE
Direct, analytical, specific. Name the factors; never "there are many factors to consider". No gambling disclaimers, no hedging boilerplate, no restating the question. When the evidence is strong, commit. When it is weak, say so plainly — a well-reasoned PASS or WAIT is a good answer. Plain prose with **bold** for emphasis and "- " bullets; no headers, no tables, no code blocks.`;

/* ======================================================================== */
/* PRESENTATION MODES — four PRESENTATIONS of one research engine.          */
/*                                                                          */
/* The research pipeline above is untouched by these. They only decide how  */
/* the same evidence is written up, and they add the structured-copy block  */
/* that the presentation layer parses and VALIDATES. The model never owns   */
/* the decision; in every mode the verdict, side, price and playable limit  */
/* are copied from the deterministic engine and quoted exactly.             */
/* ======================================================================== */

export type PresentationMode = "SIMPLE" | "STANDARD" | "DEEP" | "PUBLISHER";

const MODE_PROMPT: Record<PresentationMode, string> = {
  SIMPLE: `PRESENTATION MODE: SIMPLE — the five-second answer.
Your job here is compression, not display. Write for a football fan at a bar who has never placed a bet and has never heard of de-vigging, a fair line, EV, CLV, a sharp book or closing-line value. If a sentence needs a glossary, it has failed. Target an eighth-grade reading level. Short sentences. Short bullets. Never start with background — start with the decision.
Answer in this exact order, and add nothing else unless the question asks for it:
1. The decision, as the first words: "BET:", "LEAN:", "WAIT:" or "PASS:" — copied from the deterministic verdict in DECISION CARD FACTS. Never upgrade it, never downgrade it.
2. The bet said as sport, then the price: "Texas Tech to win by 4 points or more, at -110". Not "Texas Tech -3.5" alone and not "bet Texas Tech" — the price is part of the answer.
3. The price limit, from the card's "good to" price only, said as a limit: "still worth it down to -115". Never invent a threshold, and never state a line threshold — EdgeDesk owns price limits, not line limits.
4. The two or three strongest reasons, one short sentence each.
5. The single strongest reason NOT to bet.
6. What would change the decision.
Under 120 words in total.
BANNED WORDS — code rejects any copy containing them, and the card falls back to EdgeDesk's own templates: de-vig, de-vigged, vig, vigorish, CLV, closing line value, EV, expected value, Pinnacle, sharp market, sharper market, sharp book, sharp fair, sharp reference, soft books, fair line, fair price, fair value, fair odds, max playable, liquidity, market residual, overround, Shin, Kelly, arbitrage.
SAY THIS INSTEAD: "EdgeDesk's comparison price" for the fair number; "the sportsbook EdgeDesk uses as its benchmark" for the sharp reference; "N sportsbooks were quoting this game" for the book count; "the price limit" for max playable; "EdgeDesk flagged this at a better price than the market finished at" for beating the close; "some of the data behind this needs checking" for a data integrity warning.
NEVER LET VALUE READ AS A PREDICTION. On a big underdog price, say plainly that the team is still an underdog and that EdgeDesk is judging the price, not predicting an upset. On a heavy favourite, say what the bet costs rather than who is likely to win.
If the verdict is PASS, "PASS: EdgeDesk does not see enough value at this price." followed by the one reason is a complete, successful answer — do not force action. If EVIDENCE INTEGRITY is FAIL, recommend nothing: say a data check failed and name it. If the price is stale, say the price needs a fresh check before anyone acts. Plain prose and "- " bullets only; no headers.`,
  STANDARD: `PRESENTATION MODE: STANDARD — the decision plus concise supporting evidence.
The first sentence carries the decision, the selection and the current price together, with the verdict copied exactly from DECISION CARD FACTS (never upgraded) and the playable limit quoted from the card's "good to" price only. Then, in at most 250 words: the strongest drivers with their actual numbers from the evidence, the strongest contradiction, and what would change the call. Plain language first; a precise internal term may follow once in parentheses. No research trace, no headers. A PASS or WAIT stated plainly is a good answer.`,
  DEEP: `PRESENTATION MODE: DEEP — full analytical research.
The full ANSWER SHAPE and RESEARCH TRACE rules above apply unchanged. Precise terminology is welcome here; this is the layer sophisticated users open on purpose. The verdict, side, price and playable limit are still the engine's and are quoted exactly.`,
  PUBLISHER: `PRESENTATION MODE: PUBLISHER — neutral, polished, article-ready copy for a sports-media writer whose readers are ordinary fans.
Write as a publication would: third person, neutral, confident only where the evidence is, short, specific, easy to quote. No first person, no "I", no "AI", no "our algorithm", no chat tone, no headers, no bullets — plain paragraphs a writer can lift straight into a story. Never use: lock, guaranteed, hammer, can't miss, free money, AI says.
The reader of the finished article has never placed a bet. Every sentence has to survive that. Name the bet in sport terms first ("Fresno State to beat USC", "Pittsburgh to win by more than 4"), then the price.
BANNED WORDS — code rejects copy containing them: de-vig, de-vigged, vig, vigorish, CLV, closing line value, EV, expected value, Pinnacle, sharp market, sharper market, sharp book, sharp fair, sharp reference, soft books, fair line, fair price, fair value, fair odds, max playable, liquidity, market residual, overround, Shin, Kelly, arbitrage.
Prefer: "EdgeDesk's research favors…", "The price stays good enough down to…", "EdgeDesk's comparison price for the same bet is about…", "The strongest reason is…", "The biggest concern is…", "At a worse price, EdgeDesk would pass."
On a long underdog price, state in the copy that the team is still an underdog and that EdgeDesk is judging the price rather than predicting an upset. The decision, bet, price and price limit are the engine's and are quoted exactly from DECISION CARD FACTS. If there is no bet, say so plainly and explain what EdgeDesk would need to see. Under 200 words.`,
};

/* The structured block the presentation layer parses. Requested in every mode
   whenever a decision card exists, because it is cheap (one fenced block on the
   same call) and it is the only way AI copy reaches the card. Validation is
   code, not trust: see EDPRES.validateCopy. */
const COPY_CONTRACT = `STRUCTURED COPY — REQUIRED WHEN DECISION CARD FACTS ARE ATTACHED.
After your prose answer, output exactly one fenced block and nothing after it:
\`\`\`edgedesk_copy
{"headline":"<VERDICT>: <selection> at <price>. <one short clause>","why":[{"text":"<one plain sentence>","evidence_ids":["e3"]}],"watch":"<the strongest reason not to bet, one sentence>","change_trigger":"<what would change the decision, one sentence>","market_read":"<one or two plain sentences on what the market is doing>","biggest_risk":"<one sentence>","plain_english":"<two or three sentences a beginner would understand>"}
\`\`\`
Rules for the block, enforced by code: the headline starts with the deterministic verdict word from DECISION CARD FACTS followed by a colon; "why" has at most three entries, each one sentence under 160 characters, each citing the evidence ids it rests on; the ONLY odds and percentages you may write anywhere in the block are the ones listed in DECISION CARD FACTS, quoted exactly; no hype words (lock, guaranteed, hammer, can't miss, free money, AI says); NO BETTING JARGON (de-vig, vig, CLV, closing line value, EV, expected value, Pinnacle, sharp/sharper market, sharp book, sharp fair, soft books, fair line, fair price, fair value, fair odds, max playable, liquidity, market residual, overround, Shin, Kelly, arbitrage) — every one of these is rejected by a regex; a sentence that contradicts the verdict is discarded. Anything that fails is replaced by EdgeDesk's own templated copy, which is already plain — so a jargon-free sentence is the only kind that survives. Eighth-grade reading level. "plain_english" is read by a first-time bettor: name the bet in sport terms, say what the price means, and if the price is a long underdog payout say EdgeDesk is judging the price rather than predicting an upset.`;

export function presentationModeOf(body: any, plan: Plan): PresentationMode {
  const explicit = String(body?.presentation_mode ?? "").toUpperCase();
  if (explicit === "SIMPLE" || explicit === "STANDARD" || explicit === "DEEP" || explicit === "PUBLISHER") return explicit;
  if (body?.publisher === true) return "PUBLISHER";
  /* Old callers sent no mode. They keep the full analytical prompt they always
     had — DEEP — so nothing about their answer changes shape. */
  return "DEEP";
}

/** Which deterministic object the card is built from: the client's signal
    packet, a scored board row for the focused game, or nothing. */
export function presentationSource(body: any, research: ResearchOut | null): { kind: string; packet: any } | null {
  const p = body?.packet;
  if (p && typeof p === "object" && p.deterministic && (p.prices || p.price_sensitivity)) {
    return { kind: "packet", packet: p };
  }
  const rows: any[] = Array.isArray(p?.board?.rows) ? p.board.rows : Array.isArray(p?.board) ? p.board : [];
  const focusId = research?.focus?.event_id ?? null;
  if (rows.length) {
    const row = (focusId ? rows.find((r) => String(r?.event_id ?? "") === String(focusId)) : null) ?? null;
    if (row) return { kind: "board", packet: EDPRES.packetFromBoardRow(row) };
  }
  return null;
}

/** Gaps the card must name rather than hide: availability layers that were
    attempted and came back UNAVAILABLE. A missing injury report is not a
    clean injury report. */
function presentationGaps(research: ResearchOut | null): string[] {
  if (!research) return [];
  const GAP_FIELDS = /injur|availab|quarterback|probable_starter|weather/i;
  const out: string[] = [];
  for (const u of research.unavailable) {
    if (GAP_FIELDS.test(u.field) && !out.includes(u.field)) out.push(u.field);
  }
  return out;
}

export interface Presentation {
  version: number;
  mode: PresentationMode;
  source: string;
  simple: any;
  publisher: any;
  copy_source: "deterministic" | "ai";
  copy_rejections: string[];
  ai_copy_error: string | null;
}

/** The deterministic presentation. Built BEFORE the model is called and
    returned whether or not the model answers — narration failure never takes
    the decision card down. */
export function buildPresentation(body: any, research: ResearchOut | null, mode: PresentationMode): Presentation | null {
  if (!EDPRES) return null;
  const src = presentationSource(body, research);
  if (!src) return null;
  const simple = EDPRES.simpleFromPacket(src.packet, {
    integrity: research?.integrity ?? null,
    gaps: presentationGaps(research),
    stale_limit_min: RESEARCH_STALE_MIN,
    research_at: Date.now(),
  });
  if (!simple || !simple.available) return null;
  return {
    version: 1, mode, source: src.kind, simple,
    publisher: EDPRES.publisher(simple, { preset: String(body?.preset ?? "GAME").toUpperCase() }),
    copy_source: "deterministic", copy_rejections: [], ai_copy_error: null,
  };
}

/** Merge validated AI copy into the presentation. Deterministic fields are
    untouched by construction (EDPRES.applyAiCopy only writes copy fields). */
export function applyAiCopyTo(pres: Presentation | null, copy: any, research: ResearchOut | null, error: string | null): Presentation | null {
  if (!pres) return null;
  if (!copy) { pres.ai_copy_error = error ?? "no copy block"; return pres; }
  const ids = research ? research.evidence.map((e) => e.id).filter(Boolean) : null;
  const r = EDPRES.applyAiCopy(pres.simple, copy, { known_evidence_ids: ids });
  pres.simple = r.simple;
  pres.copy_source = r.accepted ? "ai" : "deterministic";
  pres.copy_rejections = r.rejected ?? [];
  pres.ai_copy_error = r.accepted ? null : "copy rejected by validation";
  pres.publisher = EDPRES.publisher(pres.simple, { preset: pres.publisher?.preset ?? "GAME" });
  return pres;
}

/** The facts block the model is allowed to quote numbers from. */
function decisionCardFacts(pres: Presentation | null): string {
  if (!pres) return "";
  const s = pres.simple, e = s.engine ?? {};
  const pct = (x: any) => x == null ? "—" : (x * 100).toFixed(1) + "%";
  return "DECISION CARD FACTS — the deterministic engine's own decision for the selection in focus, already translated. "
    + "Quote these exactly; they are the ONLY odds and percentages the structured copy may contain:\n"
    + `verdict=${s.verdict}${s.suppressed ? " (SUPPRESSED: data check failed — recommend nothing)" : ""}\n`
    + `selection=${s.selection ?? "—"} · market=${s.market_label ?? "—"} · current price=${s.odds ?? "no price on file"}${s.book ? " at " + s.book : ""}\n`
    + `good to (max playable)=${s.playable_to?.limit_odds ?? "—"} · fair=${s.fair_odds ?? "—"} · break-even=${s.breakeven_odds ?? "—"}`
    + `${e.detect_am != null ? " · price when flagged=" + EDPRES.fmtAmerican(e.detect_am) : ""}\n`
    + `edge now=${pct(e.edge)} · edge when flagged=${pct(e.detect_edge)} · floor=${pct(e.floor)}${e.remaining != null ? " · edge remaining=" + Math.round(e.remaining * 100) + "%" : ""}\n`
    + `price status: ${s.price_status?.text ?? "—"}\n`
    + `freshness: ${s.freshness?.price_text ?? "—"} (${s.freshness?.status ?? "UNKNOWN"})\n`
    + `data check: ${s.integrity_status}${s.integrity_reason ? " — " + s.integrity_reason : ""}\n`
    + (s.gaps?.length ? `gaps to name, never to hide: ${s.gaps.join(" ")}\n` : "")
    + `engine reasons for: ${(e.reasons_for ?? []).join(" | ") || "none"}\n`
    + `engine reasons against: ${(e.reasons_against ?? []).join(" | ") || "none"}\n`
    + `engine falsifiers: ${(e.falsifiers ?? []).join(" | ") || "none"}`;
}

/* Shared tradeable bound — the same one close/index.ts grades against, so the
   analyst cannot name a price the board refuses to display and the grader would
   throw out. A lay quote is the other side of the book; a decimal above 30 is a
   placeholder, not a market. */
const SIG_MAX_DEC = Number(Deno.env.get("CLOSE_MAX_DEC") ?? "30");
const SIG_MIN_DEC = Number(Deno.env.get("CLOSE_MIN_DEC") ?? "1.02");
const BACK_MARKETS = new Set(["h2h","spreads","totals","ml","spread","total"]);
export function signalTradeable(r: any): { ok: boolean; reason: string | null } {
  if (!r) return { ok:false, reason:"empty row" };
  const mkt = String(r.market ?? "");
  if (/(^|_)lay$/i.test(mkt)) return { ok:false, reason:`exchange lay quote (${mkt}) — the other side of the book` };
  if (mkt && !BACK_MARKETS.has(mkt.toLowerCase())) return { ok:false, reason:`unrecognised market type "${mkt}"` };
  const dec = Number(r.best_dec);
  if (!Number.isFinite(dec) || dec <= 1) return { ok:false, reason:"no usable price" };
  if (dec > SIG_MAX_DEC) return { ok:false, reason:`price ${dec.toFixed(2)} above the placeholder bound (${SIG_MAX_DEC})` };
  if (dec < SIG_MIN_DEC) return { ok:false, reason:`price ${dec.toFixed(2)} is an extreme snap` };
  return { ok:true, reason:null };
}

/* ========================================================================
   EXTERNAL SOURCE ADAPTERS.

   An adapter, not a hardcoded provider. Each one declares what it needs, and
   the ONLY two outcomes are "retrieved, with provenance" and "unavailable,
   with the reason and the exact env var that would fix it". There is no third
   outcome in which a module fails because a key is missing, and none in which
   a plausible number appears from nowhere.

   Every adapter here is currently gated. That is a deliberate, reported state
   rather than an oversight: this build could not reach any of these hosts to
   verify a request shape, and shipping an unverified endpoint that silently
   returns nothing is worse than shipping a declared gap. Set the env var and
   the adapter runs; leave it unset and the capability reports itself missing.
   ======================================================================== */

export interface ExternalAdapter {
  id: string;
  provider: string;
  sport: string;
  source_type: SourceType;
  capability: string;
  credential_env: string | null;
  configured: () => boolean;
  /** Why it is off, phrased for the person who has to turn it on. */
  unconfigured_reason: string;
  run: (f: typeof fetch, opts: { season: number; teams?: string[] }) => Promise<Evidence[]>;
}

/** A uniform "this source is switched off" evidence item. */
function adapterUnavailable(a: ExternalAdapter): Evidence {
  return ev({
    source: a.provider, field: a.capability, entity: null, value: null,
    status: "UNAVAILABLE", freshness: "UNKNOWN", sport: a.sport,
    source_type: a.source_type, data_layer: "L8_EXTERNAL_MODEL",
    provenance: `${a.provider} adapter present but not configured`,
    note: a.unconfigured_reason,
  });
}

export const EXTERNAL_ADAPTERS: ExternalAdapter[] = [
  {
    id: "cfbd_returning_production",
    provider: "CollegeFootballData",
    sport: "americanfootball_ncaaf",
    source_type: "PROVIDER_API",
    capability: "cfb_returning_production",
    credential_env: "CFBD_API_KEY",
    configured: () => !!CFBD_API_KEY,
    unconfigured_reason:
      "Returning production is not in the ingested cfb schema and CFBD_API_KEY is not set, so EdgeDesk cannot "
      + "retrieve it directly either. Returning production is the strongest year-over-year predictor in college "
      + "football — report it as genuinely unavailable rather than substituting recruiting or last year's record. "
      + "To enable: set CFBD_API_KEY, or extend cfb_ingest to write cfb.returning_production.",
    async run(f, opts) {
      /* Only runs with a key. The endpoint is CFBD's documented returning
         production route; the response shape is NOT assumed beyond "an array
         of rows with a team", and anything that does not parse becomes an
         honest unavailable rather than a guess. */
      try {
        const url = `${CFBD_BASE}/player/returning?year=${opts.season}`;
        const r = await f(url, { headers: { authorization: `Bearer ${CFBD_API_KEY}`, accept: "application/json" } });
        if (!r.ok) {
          return [unavailable("CollegeFootballData", "cfb_returning_production",
            `CFBD returned HTTP ${r.status} for /player/returning?year=${opts.season}`)];
        }
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) {
          return [unavailable("CollegeFootballData", "cfb_returning_production",
            `CFBD returned no returning-production rows for ${opts.season}`)];
        }
        const want = (opts.teams ?? []).map(normName);
        return rows
          .filter((x: any) => !want.length || want.some((t) => normName(x?.team).includes(t)))
          .slice(0, 80)
          .map((x: any) => ev({
            source: "CollegeFootballData", entity: x?.team ?? null, field: "cfb_returning_production",
            sport: "americanfootball_ncaaf", league: "FBS", season: opts.season,
            source_type: "PROVIDER_API", layer: "season", data_layer: "L3_TEAM_SEASON",
            relevance: "roster", value: x, status: "VERIFIED",
            freshness: freshnessOf("historical", Date.now()),
            provenance: `CollegeFootballData /player/returning?year=${opts.season}`,
            note: "Returning production from CFBD. An input to how much of last season's measurement should carry "
              + "forward — never itself a measure of current performance.",
          }));
      } catch (e) {
        return [unavailable("CollegeFootballData", "cfb_returning_production",
          `CFBD request failed — ${String((e as Error)?.message ?? e)}`)];
      }
    },
  },
  {
    id: "nflverse_team_stats",
    provider: "nflverse",
    sport: "americanfootball_nfl",
    source_type: "PROVIDER_API",
    capability: "nfl_external_team_stats",
    credential_env: "EDGEDESK_NFLVERSE_BASE",
    configured: () => NFLVERSE_ENABLED && !!NFLVERSE_BASE,
    unconfigured_reason:
      "The nflverse adapter is wired but no endpoint is configured, and this build deliberately does not assume one. "
      + "EdgeDesk's owned team_features and qb_features already cover EPA, success rate, explosive rate, pressure and "
      + "the quarterback line, so nothing in the NFL module depends on this. To enable: set EDGEDESK_NFLVERSE=1 and "
      + "EDGEDESK_NFLVERSE_BASE to a CSV release URL.",
    async run(f, opts) {
      try {
        const url = NFLVERSE_BASE.includes("{season}")
          ? NFLVERSE_BASE.replace("{season}", String(opts.season))
          : NFLVERSE_BASE;
        const r = await f(url, { headers: { accept: "text/csv,*/*" } });
        if (!r.ok) {
          return [unavailable("nflverse", "nfl_external_team_stats",
            `configured nflverse endpoint returned HTTP ${r.status}`)];
        }
        const rows = csvRows(await r.text());
        if (!rows.length) {
          return [unavailable("nflverse", "nfl_external_team_stats",
            "configured nflverse endpoint returned no parseable CSV rows")];
        }
        return rows.slice(0, 64).map((row) => ev({
          source: "nflverse", entity: row.team ?? row.team_abbr ?? null,
          field: "nfl_external_team_stats",
          sport: "americanfootball_nfl", league: "NFL", season: opts.season,
          source_type: "PROVIDER_API", layer: "season", data_layer: "L3_TEAM_SEASON",
          relevance: "offense", value: row, status: "VERIFIED",
          freshness: freshnessOf("team_stats", Date.now()),
          provenance: `nflverse via configured endpoint (${url.slice(0, 80)})`,
          note: "Third-party NFL data from a configured endpoint. Cross-check against EdgeDesk's owned team_features "
            + "before relying on it; where the two disagree, name both and say which is owned.",
        }));
      } catch (e) {
        return [unavailable("nflverse", "nfl_external_team_stats",
          `configured nflverse endpoint failed — ${String((e as Error)?.message ?? e)}`)];
      }
    },
  },
  {
    id: "cbb_external_ratings",
    provider: "CBB external ratings",
    sport: "basketball_ncaab",
    source_type: "EXTERNAL_MODEL",
    capability: "cbb_external_rating",
    credential_env: "EDGEDESK_CBB_RATINGS_URL",
    configured: () => !!CBB_RATINGS_URL,
    unconfigured_reason:
      "No external college-basketball ratings source is configured. BartTorvik, KenPom and NET all have terms that "
      + "govern automated access, and this build will not scrape one or assume an endpoint. EdgeDesk's owned "
      + "team_features already carries opponent-adjusted efficiency, tempo and both sides of the four factors, so the "
      + "module is complete without it. To enable a permitted or licensed source: set EDGEDESK_CBB_RATINGS_URL.",
    async run(f, opts) {
      try {
        const r = await f(CBB_RATINGS_URL, { headers: { accept: "text/csv,application/json,*/*" } });
        if (!r.ok) {
          return [unavailable("CBB external ratings", "cbb_external_rating",
            `configured ratings endpoint returned HTTP ${r.status}`)];
        }
        const text = await r.text();
        let rows: any[] = [];
        try {
          const j = JSON.parse(text);
          rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
        } catch { rows = csvRows(text); }
        if (!rows.length) {
          return [unavailable("CBB external ratings", "cbb_external_rating",
            "configured ratings endpoint returned nothing parseable as JSON or CSV")];
        }
        return rows.slice(0, 200).map((row: any) => ev({
          source: "CBB external ratings", entity: row.team ?? row.school ?? row.Team ?? null,
          field: "cbb_external_rating",
          sport: "basketball_ncaab", league: "D1", season: opts.season,
          source_type: "EXTERNAL_MODEL", layer: "external_model", data_layer: "L8_EXTERNAL_MODEL",
          relevance: "team_quality", value: row, status: "UNPROVEN",
          freshness: freshnessOf("team_stats", Date.now()),
          provenance: "configured external college-basketball ratings source",
          note: "EXTERNAL MODEL — somebody else's rating. Attribute it, never convert it into a spread, a win "
            + "probability or an edge, and never present it as EdgeDesk's own number.",
        }));
      } catch (e) {
        return [unavailable("CBB external ratings", "cbb_external_rating",
          `configured ratings endpoint failed — ${String((e as Error)?.message ?? e)}`)];
      }
    },
  },
];

/** Run every adapter that applies to a sport, honestly reporting the rest. */
export async function runExternalAdapters(
  sport: string | null, opts: { season: number; teams?: string[]; only?: string[] }, f: typeof fetch = fetch,
): Promise<{ evidence: Evidence[]; ran: string[]; skipped: { id: string; reason: string }[] }> {
  const evidence: Evidence[] = [];
  const ran: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const a of EXTERNAL_ADAPTERS) {
    if (sport && a.sport !== sport) continue;
    if (opts.only && !opts.only.includes(a.id)) continue;
    if (!a.configured()) {
      evidence.push(adapterUnavailable(a));
      skipped.push({ id: a.id, reason: a.credential_env ? `${a.credential_env} not set` : "not configured" });
      continue;
    }
    try {
      evidence.push(...await a.run(f, opts));
      ran.push(a.id);
    } catch (e) {
      evidence.push(unavailable(a.provider, a.capability,
        `adapter threw — ${String((e as Error)?.message ?? e)}`));
      skipped.push({ id: a.id, reason: "threw" });
    }
  }
  return { evidence, ran, skipped };
}

/* ======================================================================== */
/* RESEARCH ORCHESTRATOR                                                    */
/* ======================================================================== */

interface ResearchOut {
  plan: Plan;
  state: ConvoState;
  evidence: Evidence[];
  conflicts: ReturnType<typeof findConflicts>;
  unavailable: { source: string; field: string; reason: string }[];
  attack: { status: string; note: string; falsifiers: string[] } | null;
  memory: { facts: any[]; outcomes: any[]; patterns: any[]; prior: any[]; calibration: any[] };
  data_path: Record<string, unknown>;
  focus: any | null;
  calls: number;
  ms: number;
  log: { table: string; ms: number; rows: number; error: string | null }[];
  completeness: Completeness;
  integrity: Integrity;
  coverage: ReturnType<typeof coverage>[];
  snapshot: Snapshot | null;
  changed: ReturnType<typeof diffSnapshots> | null;
  findings: Finding[];
  queue: ScoutItem[];
  cross: CrossFlag[];
  movement: ReturnType<typeof movementRead> | null;
  /** Canonical identity, established before entity-keyed retrieval was trusted. */
  entities: {
    teams: string[];
    rejected_teams: TeamMatch[];
    players: PlayerResolution[];
  };
  /* ── r2: the research packet ───────────────────────────────────────── */
  semantic: SemanticCoverage;
  research_completeness: ResearchCompleteness;
  slate_scope: SlateScope;
  requirements: Requirement[];
  fallback_retrievals: any[];
  thesis_attack: {
    support: any[]; contradictions: any[];
    unresolved_questions: string[]; falsifiers: string[];
  };
  deterministic_context: Record<string, unknown> | null;
  /* ── r3 ─────────────────────────────────────────────────────────────── */
  /** Which sport module governed this turn, and how it was decided. */
  sport: string | null;
  sport_module: SportIntelligenceModule | null;
  /** Canonical, sport-scoped team identity for everything the question named. */
  identity: IdentityMatch[];
  /** Infrastructure quality per source this session. Never a betting number. */
  source_reliability: ReturnType<Dal["reliabilityReport"]>;
  /** What was excluded to stop future information leaking into a past question. */
  leakage: LeakageReport;
  /** What this sport can and cannot know, and from where. */
  capabilities: CapabilityCell[];
  /** Operational facts accumulated from this run, for the learning layer. */
  learning_context: Record<string, unknown>;
}

/**
 * Which CFB tables THIS question needs — the contract between planner and
 * retriever.
 *
 * Deliberately narrow per intent. The cfb schema has ten readable tables and a
 * question about recruiting has no business reading the schedule, the roster
 * and the book lines: every unnecessary read is budget that the tables the
 * question actually needs will not get. Identity is not in this set because
 * getCfbIntelligence always reads it — nothing in the schema can be attributed
 * without it.
 */
function needsFromCfb(plan: Plan, wants: (s: string) => boolean): Set<string> {
  const n = new Set<string>();
  const add = (...k: string[]) => k.forEach((x) => n.add(x));
  switch (plan.intent) {
    case "cfb_roster": add("roster", "records"); break;
    case "cfb_best_quarterbacks": add("roster", "team_season_stats", "sp_plus"); break;
    case "cfb_recruiting": add("recruiting", "records"); break;
    case "cfb_portal": add("portal", "recruiting"); break;
    case "cfb_returning_production": add("returning_production", "team_season_stats", "records"); break;
    case "cfb_sp_plus": add("sp_plus", "records", "rankings"); break;
    case "cfb_best_matchups": add("sp_plus", "records", "schedule", "rankings"); break;
    case "cfb_betting_candidate": add("sp_plus", "records", "schedule", "lines"); break;
    case "cfb_best_teams": add("sp_plus", "records", "schedule", "rankings"); break;
    default: add("sp_plus", "records", "team_season_stats", "schedule", "team_quality");
  }
  /* An explicit plan step always wins over the intent default — the planner
     may have added a layer the intent alone would not have asked for. */
  if (wants("cfb_recruiting")) add("recruiting");
  if (wants("cfb_roster")) add("roster");
  if (wants("cfb_returning")) add("returning_production");
  if (wants("cfb_portal")) add("portal");
  if (wants("cfb_sp_plus")) add("sp_plus");
  return n;
}

async function runResearch(
  plan: Plan, state: ConvoState, packet: any, dal: Dal, question = "",
): Promise<ResearchOut> {
  const t0 = Date.now();
  const evidence: Evidence[] = [];
  const data_path: Record<string, unknown> = {};
  const steps = new Set(plan.steps);
  const wants = (s: string) => steps.has(s);

  let slateRows: any[] = [];
  let focus: any = null;

  /* ---- 1. the board, server-side ---------------------------------------- */
  if (wants("slate") || wants("focus_signal") || wants("market") || wants("traps")) {
    const s = await dal.getSlate(state.sport ?? null);
    slateRows = s.rows;
    // Only the top of the board goes into the prompt; the rest is summarized.
    evidence.push(...s.ev.slice(0, 24));
    if (s.rows.length > 24) {
      data_path.slate_truncated = { total: s.rows.length, shown: 24 };
    }
  }

  /* ---- 2. what is in focus ---------------------------------------------- */
  // The client's loaded signal always wins. Otherwise resolve from the teams the
  // conversation is about. Otherwise the top of the board.
  let teamKeys = state.teams.map((t) => t.toLowerCase());
  if (slateRows.length) {
    if (teamKeys.length) {
      focus = slateRows.find((r) => {
        const m = `${r.away_team ?? ""} ${r.home_team ?? ""}`.toLowerCase();
        return teamKeys.some((t) => m.includes(t.toLowerCase().split(" ").pop() ?? t));
      }) ?? null;
    }
    if (!focus && plan.entities.rank && slateRows[plan.entities.rank - 1]) focus = slateRows[plan.entities.rank - 1];
    /* SOME SLATE-WIDE QUESTIONS STILL NEED A DETERMINISTIC CANDIDATE.
       "What's the best bet tonight?" is board-wide in its retrieval but it is
       asking for ONE thing the engine already ranked. Leaving focus null at
       SLATE depth meant the deterministic context — price, fair price, edge,
       book depth, sharp print — was never attached, so the analyst was asked
       to name the best bet with none of the engine's own numbers for any
       candidate. The board is ordered by edge, so the top row IS the engine's
       candidate; the model still may not compute anything from it. */
    const NEEDS_CANDIDATE = new Set([
      "best_bets", "why", "price", "attack", "what_changed", "compare", "postmortem", "traps",
    ]);
    if (!focus && (plan.depth !== "SLATE" || NEEDS_CANDIDATE.has(plan.intent))) {
      focus = slateRows[0] ?? null;
    }
  }
  /* THE SPORT COMES FROM THE QUESTION FIRST.
     This fell through to slateRows[0] — the highest-EDGE signal on the board —
     so "best pitchers on today's slate" resolved to whatever sport happened to
     top the board. On an MMA-led board that made sportKey mma, isMlb false, and
     the ENTIRE MLB branch below was skipped: no card, no pitcher_features, no
     live fallback. One retrieval ran, signals, and the analyst then reported
     that pitching data was missing — a conclusion it inferred from the packet
     rather than from a lookup it never performed.
     A pitching question is a baseball question no matter what is hot on the
     board, so intent pins the sport before board order gets a vote. */
  /* plan.sport is set by the classifier when the QUESTION named its league
     explicitly, which is stronger evidence than either the intent map or the
     board. The order below is strictly most-certain-first: an intent that only
     exists for one sport, then an explicit league word, then the loaded signal,
     then conversation state, then — last, and only as a tiebreak — board order. */
  const sportKey: string | null = sportOfIntent(plan.intent) ?? plan.sport
    ?? focus?.sport_key ?? state.sport ?? (slateRows[0]?.sport_key ?? null);
  const mod = sportModule(sportKey);
  const imod = intelligenceModule(sportKey);
  data_path.sport_resolution = {
    resolved: sportKey,
    via: sportOfIntent(plan.intent) ? `intent "${plan.intent}" exists only for this sport`
      : plan.sport ? "the question named its league explicitly"
      : focus?.sport_key ? "the signal the user has open"
      : state.sport ? "conversation state"
      : slateRows.length ? "board order (weakest — the top of the board is not the subject)"
      : "unresolved",
    module: imod ? { label: imod.label, league: imod.league, status: imod.status } : null,
  };

  /* ---- 2b. CANONICAL IDENTITY, BEFORE ANY ENTITY-KEYED RETRIEVAL --------
     The team resolver owns one roster — baseball's — so every club nickname and
     every city token in the language resolves to an MLB club whatever sport is
     being discussed. "How does the Giants offence look tonight?" during football
     season came back San Francisco Giants, and that name was then printed to the
     analyst as the entity in focus for an NFL game, used to filter the card, and
     written into research memory as the subject of the session.
     Now that the sport is known, a club claimed ONLY through an alias it shares
     with another league is dropped. The rejection is recorded rather than
     silently applied: "the name matched baseball and the question is not
     baseball" is a resolution failure worth seeing, not a tidy-up. */
  const teamScope = scopeTeamsToSport(plan.entities.team_matches ?? [], sportKey);
  if (teamScope.rejected.length) {
    state.teams = teamScope.teams;
    teamKeys = state.teams.map((t) => t.toLowerCase());
    data_path.entity_scope = {
      sport: sportKey,
      rejected: teamScope.rejected.map((m) => `${m.name} (matched only on "${m.via}", an alias shared across leagues)`),
      note: "MLB clubs claimed through a cross-league alias were dropped because the question resolved to another sport. "
        + "Names are display labels; identity has to survive the sport.",
    };
  }

  /* ---- 2c. CANONICAL TEAM SCOPE FOR EVERY NON-BASEBALL SPORT ------------
     plan.entities.teams comes from the legacy resolver, which owns exactly one
     roster: baseball's. For an NFL, CFB or CBB question it is therefore empty
     almost always, and wrong occasionally — and every downstream team filter
     reads it. That is why a CFB roster question retrieved no roster: the
     module asks for the teams in scope, the scope was empty, and the read was
     skipped entirely. The answer then reported missing roster data for a
     lookup that never ran, which is the one failure mode this engine is least
     allowed to have.
     For any sport with a canonical registry, the scope is resolved from that
     registry instead. AMBIGUOUS and UNRESOLVED references deliberately do NOT
     enter the scope — an unresolved name must never silently become a filter. */
  const identity: IdentityMatch[] = sportKey && question
    ? resolveTeamIdentity(question, sportKey) : [];
  if (sportKey && sportKey !== "baseball_mlb" && identity.length) {
    const resolved = identity.filter((m) => m.status === "RESOLVED" && m.canonical_name)
      .map((m) => m.canonical_name!);
    const unresolved = identity.filter((m) => m.status !== "RESOLVED");
    if (resolved.length) {
      state.teams = resolved;
      teamKeys = resolved.map((t) => t.toLowerCase());
    }
    data_path.canonical_scope = {
      sport: sportKey,
      resolved: identity.filter((m) => m.status === "RESOLVED")
        .map((m) => `${m.query} -> ${m.canonical_team_id}`),
      not_resolved: unresolved.map((m) => `${m.status}: "${m.query}" (${m.candidates.map((c) => c.canonical_name).join(" | ") || "no candidate"})`),
      note: resolved.length
        ? "Team scope for this sport comes from the canonical, sport-scoped registry rather than the baseball resolver."
        : "No team resolved unambiguously inside this sport, so retrieval stays board-wide rather than filtering on a guess.",
    };
  }

  /* ---- 3. market depth on the focused signal ---------------------------- */
  if (focus && (wants("sharp_reference") || wants("market"))) {
    evidence.push(...await dal.getSharpReference(focus.event_id, focus.market, focus.selection));
  }
  let movement: ReturnType<typeof movementRead> | null = null;
  if (focus && wants("line_movement")) {
    /* THE TRAILING PIPE IS LOAD-BEARING.
       _shared/oddsapi.ts builds the primary key as
           `${event_id}|${market}|${selection}|${point ?? ""}`
       — four segments ALWAYS, with an empty last one when there is no point.
       This rebuilt it as three segments for a null point, so every h2h key
       came out as `<event>|h2h|<name>` against a stored `<event>|h2h|<name>|`.
       It matched nothing on every moneyline, which is most of the board, and
       the miss surfaced as the honest-sounding "no ticks recorded for this
       signal" — a data-absent message for a lookup that was simply wrong.
       Spreads and totals carry a point, so they matched, which is why this
       looked like patchy tick coverage rather than a key bug. */
    const sigKey = `${focus.event_id}|${focus.market}|${focus.selection}|${focus.point ?? ""}`;
    const mv = await dal.getLineMovement(sigKey);
    evidence.push(...mv);
    const series = (mv[0]?.value as any)?.series ?? null;
    /* THE FROZEN PRICE, NOT THE CURRENT ONE. movementRead measures the detection
       price against the latest tick — that is the whole question it answers. It
       was being passed best_dec, which IS the latest price, so entry and last
       were the same number and the function returned "flat" on essentially
       every signal while its own note claimed the market had not moved. The
       frozen number is first_best_dec, which getSlate already selects; best_dec
       remains the fallback for a row that predates detection capture. */
    movement = movementRead(num(focus.first_best_dec) ?? num(focus.best_dec), series);
    /* Movement on its own is close to self-confirming on a flagged signal. The
       residual is fetched alongside it so the narration always has the version
       with the expected correction already subtracted. */
    evidence.push(...await dal.getMarketResidual(sigKey));
  }

  /* Cross-market structure: what the markets on this game say about each other.
     A per-signal board cannot express agreement or conflict between them, so
     this is where spots live that no amount of scanning the board surfaces. */
  let cross: CrossFlag[] = [];
  if (focus?.event_id && plan.depth !== "QUICK") {
    const cm = await dal.getCrossMarket(focus.event_id);
    evidence.push(...cm.ev);
    cross = crossMarketFlags(cm.rows, RESEARCH_FLOOR);
  }
  if (focus && wants("closing_line")) {
    evidence.push(...await dal.getClosingLine(focus.event_id));
  }
  if (focus && wants("model")) {
    evidence.push(...await dal.getModel(focus.event_id));
  }

  /* ---- 4. sport-specific research --------------------------------------- */
  /* An intent that only exists for baseball IS baseball. Without this a
     pitching question on a board topped by another sport retrieved nothing. */
  const isMlb = sportKey === "baseball_mlb" || MLB_INTENTS.has(plan.intent)
    || (!sportKey && plan.entities.teams.length > 0);
  let cardRows: any[] = [];

  if (isMlb && (wants("matchup") || wants("pitchers") || wants("park") || wants("weather") || wants("bullpen") || wants("slate"))) {
    const card = await dal.getMlbCard();
    cardRows = card.rows;
    data_path.mlb_card = card.path;
    // Narrow to the games actually in scope so the prompt stays readable.
    const inScope = (e: Evidence) => {
      if (!teamKeys.length || plan.depth === "SLATE") return true;
      const s = String(e.entity ?? "").toLowerCase();
      return teamKeys.some((t) => s.includes((t.split(" ").pop() ?? t).toLowerCase()));
    };
    /* The cap is a guard against a runaway card, not a routine trim. getMlbCard
       now drops completed games at the source, so a real two-day live slate
       lands well inside this — and if it ever does not, the truncation is
       RECORDED rather than silent. A silent slice here is what sent the model a
       finished slate and let coverage certify it. */
    const scopedCard = card.ev.filter(inScope);
    const cardCap = plan.depth === "SLATE" ? 200 : 40;
    if (scopedCard.length > cardCap) {
      data_path.mlb_card_truncated = {
        emitted: scopedCard.length, shown: cardCap,
        note: "Card evidence exceeded the budget and was cut. Live games are ordered first, so what was dropped is the far end of the window.",
      };
    }
    evidence.push(...scopedCard.slice(0, cardCap));
  }

  if (isMlb && (wants("pitcher_features") || wants("opponent_offense") || wants("workload"))) {
    const pf = await dal.getPitcherFeatures();
    data_path.pitcher_features = pf.path;
    evidence.push(...pf.ev.slice(0, plan.depth === "SLATE" ? 120 : 40));

    /* THE SEASON AXIS.
       The per-game layer above is keyed on game_id, so it goes silent whenever
       that join misses — a game not ingested yet, a slate spanning two ET
       dates, an offense row written against yesterday's card. When it does, a
       question like "worst starters today" has nowhere else to look and the
       answer becomes a refusal about plumbing.
       pitcher_season and team_season are keyed on the PITCHER and the TEAM, so
       they are available from a name alone. Always fetched, never a
       substitute: the per-game row stays the better answer when it exists, and
       the two are labelled distinctly so a season rate is never read as a
       matchup-specific one. */
    /* Guarded. This layer is an ADDITION to an answer that already worked
       without it; if it throws, the right outcome is a slightly thinner answer,
       not a 502 that loses the whole response. read() already swallows query
       errors, so anything reaching here is a bug in the shaping code — and a
       bug in an enrichment must not be fatal to the thing it enriches. */
    try {
      const ps = await dal.getSeasonPitching();
      data_path.pitcher_season = ps.path;
      evidence.push(...ps.ev.slice(0, 4));
    } catch (e) {
      data_path.pitcher_season = { error: `season layer threw and was skipped — ${String((e as Error)?.message ?? e)}` };
    }
  }

  /* Football and basketball. Same trigger shape as the MLB branch above, so a
     question about matchups, efficiency or a quarterback retrieves the owned
     layer for whichever sport is in scope rather than falling through to
     market-only research. */
  /* ---- 4a. THE SPORT'S OWN PRIMARY LAYER GOES FIRST ---------------------
     Ordering is load-bearing under a retrieval budget. College football's
     primary evidence lives in the ingested `cfb` schema; the public multisport
     tables are a SECONDARY layer for it, and usually an empty one, because
     ingest_multisport does not cover CFB in this project. Running the generic
     block first spent identity, SP+, records and season stats' worth of budget
     on probes of empty tables and then ran out — which surfaced as a CFB roster
     question answering with no roster, the exact shape of "the lookup never
     executed" being mistaken for "the data is not there".
     Each sport's module declares its own evidence hierarchy; this honours it. */
  if (sportKey === "americanfootball_ncaaf" && wants("cfb_intelligence")) {
    const needs = needsFromCfb(plan, wants);
    try {
      const cfb = await dal.getCfbIntelligence({ needs, teams: state.teams, season: null });
      data_path.cfb_intelligence = cfb.path;
      evidence.push(...cfb.ev.slice(0, plan.depth === "SLATE" ? 200 : 120));
    } catch (e) {
      data_path.cfb_intelligence = { error: `CFB layer threw and was skipped — ${String((e as Error)?.message ?? e)}` };
    }
  }

  const MULTISPORT = new Set(["americanfootball_nfl", "americanfootball_ncaaf", "basketball_ncaab"]);
  let tfRows: any[] = [];
  if (sportKey && MULTISPORT.has(sportKey)
    && (wants("team_efficiency") || wants("matchup") || wants("pitcher_features")
      || wants("opponent_offense") || wants("quarterback") || wants("matchup_context")
      || wants("cbb_deep") || wants("nfl_deep"))) {
    const tf = await dal.getTeamFeatures(sportKey);
    data_path.team_features = tf.path;
    evidence.push(...tf.ev.slice(0, plan.depth === "SLATE" ? 140 : 45));
    /* Kept so the CBB matchup comparison can be built from the SAME rows the
       efficiency evidence came from, rather than re-reading them. */
    tfRows = tf.ev
      .filter((e) => e.field === "team_efficiency" && e.status !== "UNAVAILABLE")
      .map((e) => {
        const v: any = e.value ?? {};
        return {
          game_id: v.game_id, side: v.side, team: v.team,
          adj_o: v.adj_o, adj_d: v.adj_d, adj_em: v.adj_em, adj_tempo: v.adj_tempo,
          efg_pct: v.four_factors?.efg, to_pct: v.four_factors?.tov,
          orb_pct: v.four_factors?.orb, ft_rate: v.four_factors?.ftr,
          three_rate: v.three_rate,
        };
      });
  }

  /* ---- 4b. SPORT-SPECIFIC DEEP LAYERS ----------------------------------
     Each module is asked only for what the plan says this question needs.
     A recruiting question does not read the roster; a pace question does not
     read recruiting. The `needs` set is the contract between the planner and
     the retriever, and it is what keeps a deep module inside a small budget. */
  const needsFrom = (...keys: string[]) => new Set(keys);

  if (sportKey === "americanfootball_nfl" && wants("nfl_deep")) {
    const needs = needsFrom("player_production", "team_form");
    if (plan.intent === "nfl_injury_impact" || plan.intent === "nfl_best_matchups"
      || plan.intent === "nfl_worst_matchups") needs.add("injuries");
    if (plan.intent === "nfl_best_matchups") needs.add("special_teams");
    try {
      const nfl = await dal.getNflDeep({ needs, teams: state.teams });
      data_path.nfl_deep = nfl.path;
      evidence.push(...nfl.ev.slice(0, 90));
    } catch (e) {
      data_path.nfl_deep = { error: `NFL deep layer threw and was skipped — ${String((e as Error)?.message ?? e)}` };
    }
  }

  if (sportKey === "basketball_ncaab" && wants("cbb_deep")) {
    const needs = needsFrom("matchup_edge", "rankings");
    if (plan.intent === "cbb_best_players") needs.add("player_production");
    if (plan.intent === "cbb_availability" || plan.intent === "cbb_tournament") needs.add("availability");
    try {
      const cbb = await dal.getCbbDeep({ needs, teams: state.teams, teamRows: tfRows });
      data_path.cbb_deep = cbb.path;
      evidence.push(...cbb.ev.slice(0, 90));
    } catch (e) {
      data_path.cbb_deep = { error: `CBB deep layer threw and was skipped — ${String((e as Error)?.message ?? e)}` };
    }
  }

  if (isMlb && wants("bullpen") && cardRows.length) {
    const ids: (number | string)[] = [];
    for (const g of cardRows) {
      const s = `${g.away_team_name} @ ${g.home_team_name}`.toLowerCase();
      const relevant = !teamKeys.length || plan.depth === "SLATE"
        || teamKeys.some((t) => s.includes((t.split(" ").pop() ?? t).toLowerCase()));
      if (relevant) { if (g.away_team_id != null) ids.push(g.away_team_id); if (g.home_team_id != null) ids.push(g.home_team_id); }
    }
    if (ids.length) evidence.push(...await dal.getBullpen(Array.from(new Set(ids)).slice(0, 20)));
  }

  if (isMlb && wants("weather")) {
    const ids = (focus ? [focus.event_id] : slateRows.slice(0, 20).map((r) => r.event_id)).filter(Boolean);
    if (ids.length) evidence.push(...await dal.getWeather(ids));
  }

  if (mod && mod.steps.includes("rankings") && wants("matchup")) {
    const league = sportKey === "americanfootball_ncaaf" ? "CFB" : "UFC";
    evidence.push(...await dal.getRankings(league));
  }

  /* ---- 5. historical + CLV ---------------------------------------------- */
  if (wants("clv_history") || wants("historical_results")) {
    evidence.push(...await dal.getCLVHistory(sportKey, focus?.market ?? null, num(focus?.first_edge ?? focus?.edge)));
  }

  /* ---- 6. research memory ----------------------------------------------- */
  let memory = { facts: [] as any[], outcomes: [] as any[], patterns: [] as any[], prior: [] as any[],
                 calibration: [] as any[] };
  if (wants("memory")) {
    const entities = Array.from(new Set([
      ...state.teams,
      ...evidence.filter((e) => e.field === "probable_starter").map((e) => String(e.entity)),
    ])).slice(0, 8);
    const m = await dal.getResearchMemory(entities, sportKey);
    /* CALIBRATION WAS FETCHED AND THEN THROWN AWAY. getResearchMemory reads
       research_calibration — a real query against the retrieval budget — and
       this assignment dropped the field on the floor. Downstream,
       `(mem as any).calibration ?? []` therefore evaluated to [] on every turn,
       so the whole CALIBRATION section of the system prompt was unreachable and
       the one measurement that says what a quoted edge has historically been
       WORTH never reached the analyst. */
    memory = { facts: m.facts, outcomes: m.outcomes, patterns: m.patterns, prior: m.prior,
               calibration: m.calibration };
    // A "pattern" below the configured sample floor is not a pattern.
    memory.patterns = memory.patterns.filter((p) => (num(p.sample_size) ?? 0) >= MIN_PATTERN_N);
    evidence.push(...m.ev.slice(0, 25));
  }

  /* ---- 6b. PLAYER IDENTITY, resolved against what was actually retrieved --
     A name in a question is a hint. The roster that came back is the only thing
     that can turn it into an identity, which is why this runs AFTER retrieval
     and never before. "Cole" matching both Gerrit Cole and Cole Ragans is not a
     tie to break — it is the answer, and the analyst is told to ask rather than
     pick. Picking is how a question about one player gets answered with
     another's numbers in a paragraph that reads perfectly. */
  const PERSON_FIELDS = new Set(["probable_starter", "pitcher_quality", "quarterback", "player_stats", "workload"]);
  const roster = new Set<string>();
  for (const e of evidence) {
    if (e.status === "UNAVAILABLE") continue;
    if (PERSON_FIELDS.has(String(e.field)) && e.entity) roster.add(String(e.entity));
    const v: any = e.value;
    if (e.field === "season_pitching" && Array.isArray(v?.rows)) {
      for (const r of v.rows) if (r?.name) roster.add(String(r.name));
    }
  }
  const hints = plan.entities.player_hints ?? [];
  const players = hints.length ? resolvePlayers(hints, [...roster]) : [];
  if (players.length) {
    data_path.player_resolution = {
      roster_size: roster.size,
      resolved: players.filter((p) => p.status === "RESOLVED").map((p) => `${p.query} -> ${p.resolved}`),
      ambiguous: players.filter((p) => p.status === "AMBIGUOUS").map((p) => `${p.query} -> ${p.candidates.join(" | ")}`),
      unresolved: players.filter((p) => p.status === "UNRESOLVED").map((p) => p.query),
    };
  }

  /* ---- 7. thesis attack, on owned numbers only -------------------------- */
  const attack = focus ? attackThesis(focus, RESEARCH_FLOOR, RESEARCH_STALE_MIN) : null;

  /* ---- 8. conflicts + unavailable roll-up ------------------------------- */
  const conflicts = findConflicts(evidence);
  const unavail = evidence
    .filter((e) => e.status === "UNAVAILABLE")
    .map((e) => ({ source: e.source, field: e.field, reason: e.note ?? "not retrievable" }));

  // Declare the sport modules EdgeDesk does not own, so the answer can say so
  // rather than improvising a football/basketball opinion.
  if (mod && mod.status === "CORE_ONLY") {
    unavail.push({ source: mod.label, field: "sport_module", reason: mod.needs ?? "sport-specific research is not wired for this league" });
  }

  /* ---- 9. NORMALIZE, SCOPE, REQUIREMENTS, COVERAGE ----------------------
     Everything below reasons about identity and denominators, so normalization
     runs first: ids, layer and canonical identity are assigned in one place
     rather than trusted to twenty emitters. */
  let ev0 = normalizeEvidence(evidence);

  /* The expected universe. It comes from the SCHEDULE, never from the rows
     that came back — counting retrieved rows against retrieved rows always
     reports 100%, which is how a half-ingested card looked complete. */
  const cardScope = (data_path.mlb_card as any)?.slate_scope as SlateScope | undefined;
  const liveDays = new Set([etDay(0), etDay(1)]);
  const starterEv = ev0.filter((e) => e.field === "probable_starter" && e.status !== "UNAVAILABLE");
  const onLiveSlate = (e: Evidence) => {
    const v = e.value as any;
    const d = v?.game_date ? String(v.game_date).slice(0, 10) : null;
    if (d && !liveDays.has(d)) return false;
    return String(v?.status ?? "").toLowerCase() !== "final";
  };
  const scopedStarters = starterEv.filter(onLiveSlate);
  const starters = Array.from(new Set((scopedStarters.length ? scopedStarters : starterEv).map((e) => String(e.entity))));
  /* The team universe is per-sport. College football never emits
     `team_efficiency` — it has no per-play layer — so keying the denominator on
     that field alone gave CFB an entity universe of zero, which makes every
     per-entity requirement vacuously satisfied and coverage a meaningless
     100%. Each sport's actual subject field is listed. */
  const TEAM_SUBJECT_FIELDS = [
    "team_efficiency", "cfb_team_season_stat", "cfb_sp_plus", "cfb_record",
  ];
  const teamsInPlay = Array.from(new Set(
    ev0.filter((e) => TEAM_SUBJECT_FIELDS.includes(String(e.field)) && e.status !== "UNAVAILABLE")
      .map((e) => String(e.entity)).filter((s) => s && s !== "null"),
  ));
  const games = Array.from(new Set(
    ev0.filter((e) => (e.field === "game" || e.field === "cfb_game") && e.status !== "UNAVAILABLE")
      .map((e) => String(e.entity)),
  ));

  const slate_scope: SlateScope = cardScope ?? buildSlateScope(
    sportKey,
    games.map((g) => ({ game_date: etDay(0), status: "Scheduled", game: g })),
    games.map((g) => ({ game_date: etDay(0), status: "Scheduled", game: g })),
  );

  const universe: CoverageUniverse = {
    entities: starters.length ? starters : teamsInPlay,
    games,
    hasFocus: !!focus,
    expectedGames: Math.max(slate_scope.expected_games || 0, games.length),
  };

  const hasResolvedPlayer = players.some((p) => p.status === "RESOLVED");
  const reqs = requirementsFor(plan.intent, hasResolvedPlayer);
  let semantic = semanticCoverage(plan.intent, ev0, reqs, universe, sportKey);

  /* ---- 9b. ADAPTIVE SECOND PASS — gap-driven, never a blanket re-run -----
     The first pass retrieves what the plan asked for. This pass retrieves only
     what the COVERAGE AUDIT says is still missing, and records what each
     targeted call bought. A retrieval that does not improve coverage is worth
     seeing too: it means the gap is real rather than a plumbing miss. */
  const fallback_retrievals: any[] = [];
  const gapFields = new Set(
    [...semantic.critical_gaps, ...semantic.important_gaps].map((g) => g.split(" ")[0]),
  );
  const alreadyHave = (f: string) => ev0.some((e) => e.field === f && e.status !== "UNAVAILABLE");

  const targeted = async (
    reason: string, missing: string, label: string, run: () => Promise<Evidence[]>,
    provider = "EdgeDesk", endpoint = label,
  ) => {
    const rowsBefore = ev0.filter((e) => e.status !== "UNAVAILABLE").length;
    const base = {
      sport: sportKey, reason, missing_requirement: missing, requirement: missing,
      retrieval: label, provider, endpoint, rows_before: rowsBefore,
    };
    if (dal.calls >= dal.budget) {
      fallback_retrievals.push({ ...base,
        result: "skipped — retrieval budget exhausted", rows_added: 0, rows_after: rowsBefore,
        coverage_before: semantic.overall, coverage_after: semantic.overall });
      return;
    }
    const before = semantic.overall;
    let added: Evidence[] = [];
    try { added = await run(); } catch (e) {
      fallback_retrievals.push({ ...base,
        result: `threw — ${String((e as Error)?.message ?? e)}`, rows_added: 0, rows_after: rowsBefore,
        coverage_before: before, coverage_after: before });
      return;
    }
    const useful = added.filter((a) => a.status !== "UNAVAILABLE");
    evidence.push(...added);
    ev0 = normalizeEvidence(evidence);
    semantic = semanticCoverage(plan.intent, ev0, reqs, universe, sportKey);
    fallback_retrievals.push({
      ...base,
      result: useful.length ? "retrieved" : "returned nothing — the gap is real, not a lookup miss",
      rows_added: useful.length,
      rows_after: ev0.filter((e) => e.status !== "UNAVAILABLE").length,
      coverage_before: +before.toFixed(3), coverage_after: +semantic.overall.toFixed(3),
      improved: semantic.overall > before,
    });
  };

  if (isMlb) {
    if ((gapFields.has("pitcher_quality") || gapFields.has("opponent_offense"))
      && !alreadyHave("season_pitching")) {
      await targeted(
        "the per-game pitching layer is short of the slate, so the identity-keyed season layer is fetched as a labelled fallback",
        "pitcher_quality", "pitcher_season + team_season",
        async () => (await dal.getSeasonPitching()).ev);
    }
    if (gapFields.has("weather") && slateRows.length) {
      await targeted("weather is missing for part of the card", "weather", "venue_weather",
        () => dal.getWeather(slateRows.slice(0, 20).map((r) => r.event_id).filter(Boolean)));
    }
    if (gapFields.has("bullpen_flag") && cardRows.length) {
      const ids = Array.from(new Set(cardRows.flatMap((g: any) =>
        [g.away_team_id, g.home_team_id].filter((v) => v != null)))).slice(0, 20);
      if (ids.length) {
        await targeted("bullpen state is missing for teams on the card", "bullpen_flag",
          "mlb_bullpen_taxed + mlb_bullpen_team", () => dal.getBullpen(ids));
      }
    }
  }
  /* ---- SPORT-SPECIFIC SECOND PASS.
     Each of these goes back for ONE named missing requirement, not for the
     whole plan again. A retrieval that adds nothing is recorded too: it is the
     only way to distinguish "EdgeDesk did not look" from "the data is not
     there", and those two produce very different honest answers. */
  if (sportKey === "americanfootball_ncaaf") {
    if (gapFields.has("cfb_returning_production")) {
      await targeted(
        "returning production is required for this question and the first pass did not retrieve it",
        "cfb_returning_production", "cfb.returning_production",
        async () => (await dal.getCfbIntelligence({ needs: new Set(["returning_production"]), teams: state.teams })).ev,
        "CollegeFootballData (cfb schema mirror)", "cfb.returning_production");
      /* THE INGESTED MIRROR IS TRIED FIRST, ALWAYS. Only when the owned table
         cannot supply it does the direct provider call get a turn, and only
         with a key — ingestion over API calls, per the separation the spec
         draws between the two. */
      if (!ev0.some((e) => e.field === "cfb_returning_production" && e.status !== "UNAVAILABLE")) {
        await targeted(
          "the ingested cfb mirror does not carry returning production, so the direct provider adapter is tried",
          "cfb_returning_production", "CFBD /player/returning",
          async () => (await runExternalAdapters("americanfootball_ncaaf",
            { season: seasonFor("americanfootball_ncaaf"), teams: state.teams, only: ["cfbd_returning_production"] })).evidence,
          "CollegeFootballData API", "/player/returning");
      }
    }
    if (gapFields.has("cfb_recruiting")) {
      await targeted("recruiting context is missing for the programs in scope",
        "cfb_recruiting", "cfb.recruiting",
        async () => (await dal.getCfbIntelligence({ needs: new Set(["recruiting"]), teams: state.teams })).ev,
        "CollegeFootballData (cfb schema mirror)", "cfb.recruiting");
    }
    if (gapFields.has("cfb_roster")) {
      await targeted("the question needs roster detail and none was retrieved",
        "cfb_roster", "cfb.roster",
        async () => (await dal.getCfbIntelligence({ needs: new Set(["roster"]), teams: state.teams })).ev,
        "CollegeFootballData (cfb schema mirror)", "cfb.roster");
    }
    if (gapFields.has("cfb_sp_plus")) {
      await targeted("the opponent-adjusted rating axis is missing for part of the scope",
        "cfb_sp_plus", "cfb.ratings",
        async () => (await dal.getCfbIntelligence({ needs: new Set(["sp_plus"]), teams: state.teams })).ev,
        "CollegeFootballData (cfb schema mirror)", "cfb.ratings");
    }
  }
  if (sportKey === "basketball_ncaab" && gapFields.has("cbb_matchup_edge") && tfRows.length) {
    await targeted("the four-factor matchup comparison is required and was not built on the first pass",
      "cbb_matchup_edge", "team_features (derived comparison)",
      async () => (await dal.getCbbDeep({ needs: new Set(["matchup_edge"]), teams: state.teams, teamRows: tfRows })).ev,
      "EdgeDesk (derived)", "team_features");
  }
  if (sportKey === "americanfootball_nfl" && gapFields.has("nfl_player_production")) {
    await targeted("player production is missing for the teams in scope",
      "nfl_player_production", "stats_players (league=NFL)",
      async () => (await dal.getNflDeep({ needs: new Set(["player_production"]), teams: state.teams })).ev,
      "capture_stats", "stats_players");
  }

  if (gapFields.has("sharp_reference") && focus?.event_id) {
    await targeted("the focused signal has no sharp reference attached", "sharp_reference", "signals (sharp)",
      () => dal.getSharpReference(focus.event_id, focus.market, focus.selection));
  }
  if (gapFields.has("clv_history")) {
    await targeted("the question needs a historical base rate and none was retrieved", "clv_history",
      "signals (graded)", () => dal.getCLVHistory(sportKey, focus?.market ?? null, num(focus?.first_edge ?? focus?.edge)));
  }
  if (fallback_retrievals.length) data_path.fallback_retrievals = fallback_retrievals;

  /* ---- 9b-bis. HISTORICAL LEAKAGE GUARD --------------------------------
     Applied AFTER all retrieval and BEFORE anything measures or ranks the
     evidence. Order matters: filtering first would let coverage certify a
     packet that no longer exists, and filtering later would let a leaked fact
     reach the integrity audit and the model. */
  const asOf = asOfDate(question);
  const leak = enforceNoLeakage(ev0, asOf);
  ev0 = leak.evidence;
  if (asOf) {
    data_path.leakage_guard = leak.report;
    /* Coverage has to be recomputed against what SURVIVED the cutoff. A
       coverage number measured before the filter describes a packet the
       analyst was never given — the precise class of bug the delivery check
       exists to catch, reintroduced one layer up. */
    semantic = semanticCoverage(plan.intent, ev0, reqs, universe, sportKey);
  }

  /* ---- 9c. INTEGRITY, then the COMPLETENESS GATE ------------------------ */
  const integrity0 = evidenceIntegrity(ev0, { slateDays: [etDay(0), etDay(1)] });
  const research_completeness = completenessGate(semantic, integrity0, slate_scope);

  const comp = completeness(ev0, sportKey);
  data_path.slate_scope = {
    starters_on_card: starterEv.length, starters_on_live_slate: scopedStarters.length,
    days_counted: Array.from(liveDays),
    ...slate_scope,
    note: "Coverage is measured against the live slate. Completed games from the card's lookback window are excluded from the denominator.",
  };
  /* Legacy per-entity coverage, retained: the semantic layer above answers
     "how much of what this question needs", this answers "which named entities
     lack this field", and the answer quotes both. */
  const cov: ReturnType<typeof coverage>[] = [];
  if (starters.length) {
    cov.push(coverage(ev0, "pitcher_quality", starters));
    cov.push(coverage(ev0, "opponent_offense", starters));
    cov.push(coverage(ev0, "workload", starters));
  }
  if (teamsInPlay.length) cov.push(coverage(ev0, "team_efficiency", teamsInPlay));
  if (games.length) cov.push(coverage(ev0, "weather", games));

  /* ---- 10. research packet versioning -----------------------------------
     Reduce this game's research state to comparable scalars, fetch the last
     stored packet, and diff. This is what makes "what changed since we last
     looked at this?" a factual answer instead of a guess. */
  let snapshot: Snapshot | null = null;
  let changed: ReturnType<typeof diffSnapshots> | null = null;
  if (focus?.event_id) {
    const prev = await dal.getLastSnapshot(focus.event_id);
    snapshot = buildSnapshot(focus.event_id, ev0, focus, (prev?.version ?? 0) + 1);
    changed = diffSnapshots(prev, snapshot);
  }

  /* ---- 11. structured findings, derived from evidence only --------------- */
  const findings = extractFindings(ev0);

  /* ---- 12. proactive research queue ------------------------------------- */
  const queue = slateRows.length ? scout(slateRows, RESEARCH_FLOOR, RESEARCH_STALE_MIN) : [];

  /* ---- 13. THESIS ATTACK INPUTS, bound to evidence ids -------------------
     The support and the contradictions are SELECTED FROM OWNED EVIDENCE, not
     written. If nothing in the packet contradicts the thesis, the list is
     empty and stays empty — a manufactured objection to look even-handed is
     the same failure as a manufactured statistic. */
  const thesis_attack = {
    support: ev0
      .filter((e) => e.status === "VERIFIED" && (e.layer === "matchup" || e.layer === "market"))
      .slice(0, 8).map((e) => ({ id: e.id, field: e.field, entity: e.entity })),
    contradictions: [
      ...conflicts.map((c) => ({
        id: ev0.find((e) => e.field === c.field && e.entity === c.entity)?.id ?? null,
        field: c.field, entity: c.entity,
        detail: `${c.a.source} and ${c.b.source} disagree${c.resolution ? ` — EdgeDesk trusts ${c.resolution}` : " and nothing resolves it"}`,
      })),
      ...ev0.filter((e) => e.status === "STALE" || e.status === "CONFLICT")
        .slice(0, 4).map((e) => ({ id: e.id, field: e.field, entity: e.entity,
          detail: `${e.field} for ${e.entity} is ${e.status.toLowerCase()} and cannot support a current claim` })),
    ],
    unresolved_questions: [
      ...semantic.critical_gaps.map((g) => `Required evidence short: ${g}`),
      ...players.filter((p) => p.status === "AMBIGUOUS").map((p) => `"${p.query}" could be ${p.candidates.join(" or ")}`),
    ],
    falsifiers: attack?.falsifiers ?? [],
  };

  return {
    plan, state, evidence: ev0, conflicts, unavailable: unavail, attack, memory,
    data_path, focus, calls: dal.calls, ms: Date.now() - t0, log: dal.log,
    completeness: comp, coverage: cov, snapshot, changed, findings, queue,
    cross, movement, integrity: integrity0,
    entities: { teams: state.teams, rejected_teams: teamScope.rejected, players },
    semantic, research_completeness, slate_scope, requirements: reqs,
    fallback_retrievals, thesis_attack,
    /* ── r3 ───────────────────────────────────────────────────────────── */
    sport: sportKey,
    sport_module: imod,
    identity,
    source_reliability: dal.reliabilityReport(),
    leakage: leak.report,
    capabilities: imod ? imod.capabilities : [],
    /* OPERATIONAL FACTS, not sports knowledge. This is what §20 means by
       self-improvement without self-modifying code: the system accumulates
       structured observations about how its own retrieval behaved, and future
       research can use them to choose sources. Nothing here is a probability,
       nothing here changes a price, and nothing here was written by a model. */
    learning_context: {
      sport: sportKey,
      intent: plan.intent,
      retrievals: dal.calls,
      sources_attempted: dal.reliabilityReport().length,
      sources_that_returned_nothing: dal.reliabilityReport().filter((s) => s.rows === 0 && !s.failed_retrievals)
        .map((s) => s.source),
      sources_that_failed: dal.reliabilityReport().filter((s) => s.failed_retrievals > 0)
        .map((s) => ({ source: s.source, last_error: s.last_error })),
      coverage_achieved: semantic.overall,
      gaps_that_survived_a_second_pass: fallback_retrievals
        .filter((f: any) => f.rows_added === 0).map((f: any) => f.missing_requirement),
      capability_gaps_declared: (imod?.capabilities ?? [])
        .filter((c) => c.status === "NOT_AVAILABLE").map((c) => c.capability),
      note: "Operational observations from THIS run. Infrastructure quality only — it never becomes a betting number, "
        + "and it never modifies a historical outcome.",
    },
    deterministic_context: focus
      ? {
        event_id: focus.event_id, market: focus.market, selection: focus.selection, point: focus.point ?? null,
        price: focus.best_dec ?? null, first_price: focus.first_best_dec ?? null,
        sharp_fair: focus.sharp_fair ?? null, consensus_fair: focus.consensus_fair ?? null,
        edge: focus.edge ?? null, first_edge: focus.first_edge ?? null,
        n_books: focus.n_books ?? null, n_books_eff: focus.n_books_eff ?? null,
        has_sharp: focus.has_sharp ?? null, clv: focus.clv ?? null,
        beat_close: focus.beat_close ?? null, result: focus.result ?? null,
        _note: "Owned by the deterministic engine. READ-ONLY — quote exactly, never recompute.",
      }
      : null,
  };
}

/* ======================================================================== */
/* PROMPT ASSEMBLY                                                          */
/* ======================================================================== */

/* Evidence gets its own, much larger budget than the ancillary blocks. A full
   MLB slate is ~69KB of evidence; at 60KB it was being cut in half mid-object.
   ~240KB is roughly 60k tokens — comfortably inside the context window, and
   large enough that a real slate never truncates at all. */
const EVIDENCE_MAX = Number(Deno.env.get("EDGEDESK_EVIDENCE_MAX") ?? "240000");

/* For everything OTHER than evidence. Still a blind slice, but these blocks
   (movement reads, queues, data paths) are prose-ish and degrade gracefully;
   evidence does not, which is why it no longer uses this. */
function compact(o: unknown, max = 60000): string {
  const s = JSON.stringify(o);
  return s.length > max ? s.slice(0, max) + `…[truncated at ${max} chars]` : s;
}


function buildUserContent(body: any, research: ResearchOut | null, evidenceMax = EVIDENCE_MAX, pres: Presentation | null = null): string {
  const { mode, question, packet, compare } = body ?? {};
  const parts: string[] = [];
  const ask = (question && String(question).trim()) || defaultAsk(mode);
  parts.push(`QUESTION: ${ask}   (client mode=${mode ?? "chat"})`);

  if (research) {
    const p = research.plan;
    parts.push(
      `RESEARCH PLAN — intent=${p.intent}, mode=${p.mode}, depth=${p.depth}, sport=${research.focus?.sport_key ?? research.state.sport ?? "unresolved"}\n`
      + `Reason: ${p.why}\n`
      + (rankingAxis(p.intent) ? `RANKING AXIS: ${rankingAxis(p.intent)}\n` : "")
      + `Steps executed: ${p.steps.join(", ")}\n`
      + `In focus: ${research.state.teams.join(" / ") || "(board-wide)"}\n`
      + `Retrievals: ${research.calls} reads in ${research.ms}ms`,
    );

    /* ── SPORT MODULE + CAPABILITIES ──────────────────────────────────────
       What this sport can know, before the evidence. The point is that the
       analyst never has to infer a gap from an absence: "EdgeDesk has no NFL
       injury report" is a fact stated up front, not a conclusion the reader is
       left to draw from a packet that simply does not mention injuries. */
    if (research.sport_module) {
      const sm = research.sport_module;
      const gaps = sm.capabilities.filter((c) => c.status === "NOT_AVAILABLE");
      const needsCfg = sm.capabilities.filter((c) => c.status === "REQUIRES_CREDENTIAL" || c.status === "REQUIRES_CONFIGURATION");
      parts.push(
        `SPORT MODULE — ${sm.label} (${sm.league})\n`
        + `Season: ${sm.season.note}\n`
        + `Identity: ${sm.identity.note}\n`
        + `EVIDENCE HIERARCHY for this sport, strongest first: ${sm.evidence_hierarchy.join(" > ")}\n`
        + (gaps.length
          ? `NOT AVAILABLE IN EDGEDESK FOR THIS SPORT — state these as absent if the question touches them, and never `
            + `let their absence read as a clean sheet:\n`
            + gaps.map((c) => `  - ${c.capability}: ${c.notes}`).join("\n") + "\n"
          : "")
        + (needsCfg.length
          ? `NOT CONFIGURED (an adapter exists but no credential or endpoint is set): `
            + needsCfg.map((c) => c.capability).join(", ") + "\n"
          : "")
        + `Everything else in the matrix is retrievable and was retrieved if this question needed it.`,
      );
    }

    /* ── CANONICAL IDENTITY ─────────────────────────────────────────────── */
    if (research.identity?.length) {
      const res = research.identity.filter((i) => i.status === "RESOLVED");
      const bad = research.identity.filter((i) => i.status !== "RESOLVED");
      parts.push(
        "CANONICAL TEAM IDENTITY — sport-scoped, resolved before any number was attached to a name. BINDING.\n"
        + (res.length
          ? res.map((i) => `- "${i.query}" -> ${i.canonical_name} [${i.canonical_team_id}]. ${i.reason}`).join("\n") + "\n"
          : "")
        + (bad.length
          ? bad.map((i) => `- ${i.status}: "${i.query}" — ${i.reason}`
            + (i.candidates.length ? ` Candidates: ${i.candidates.map((c) => `${c.canonical_name}${c.state ? ` (${c.state})` : ""}`).join(", ")}.` : "")
            + ` DO NOT CHOOSE ONE. Name the candidates and ask, or answer for each separately if the evidence supports it.`).join("\n")
          : "")
        + "\nA canonical id carries its sport. Two ids with different sports are different entities however similar "
        + "their names, and a fact from one may never be carried to the other.",
      );
    }

    /* ENTITY RESOLUTION, before the evidence it governs. A number is only as
       good as the identity it is attached to, so the analyst is told who the
       question resolved to — and, just as importantly, who it did NOT. */
    {
      const en = research.entities;
      const lines: string[] = [];
      if (en?.players?.length) {
        for (const p of en.players) {
          if (p.status === "RESOLVED") lines.push(`- "${p.query}" resolves to ${p.resolved}.`);
          else if (p.status === "AMBIGUOUS") {
            lines.push(`- AMBIGUOUS: "${p.query}" matches ${p.candidates.length} people in the retrieved data — `
              + `${p.candidates.join(", ")}. Do NOT pick one. Answer for both if the evidence supports it, or ask `
              + `which was meant. Attributing one player's numbers to another is the worst error you can make here.`);
          } else {
            lines.push(`- UNRESOLVED: "${p.query}" does not appear in anything EdgeDesk retrieved for this slate. `
              + `Say he is not on the retrieved card; do not describe him from memory.`);
          }
        }
      }
      if (en?.rejected_teams?.length) {
        lines.push(`- The name${en.rejected_teams.length === 1 ? "" : "s"} `
          + en.rejected_teams.map((m) => `"${m.via}"`).join(", ")
          + ` matched a baseball club but this question is not baseball, so no MLB club was adopted. `
          + `Do not refer to an MLB team in this answer.`);
      }
      if (lines.length) {
        parts.push("ENTITY RESOLUTION — canonical identity, established from retrieved data before any "
          + "number was attached to a name. Obey it:\n" + lines.join("\n"));
      }
    }

    /* ── THE GATE, before the evidence it governs ────────────────────────
       The analyst must never have to work out for itself whether the packet is
       complete. This states it, in a form that can be obeyed rather than
       interpreted. */
    {
      const rc = research.research_completeness;
      const sc = research.slate_scope;
      const cov = research.semantic;
      const permit = rc.state === "INVALID"
        ? "You may NOT rank, compare, or publish a best/worst list from this evidence. Report the fault, name the entities it touches, and say what must be repaired."
        : rc.state === "INSUFFICIENT"
          ? "You may NOT publish a full ranking. Answer only what the present evidence safely supports, say so plainly in your first line, and name what is missing."
          : rc.state === "PARTIAL"
            ? "You MAY answer and rank. Lead with the gap in your first line, label the conclusion provisional, and name what is missing — do not bury it at the end."
            : "You MAY answer normally.";
      parts.push(
        `RESEARCH COMPLETENESS: ${rc.state}\n`
        + `${rc.reason}\n`
        + `${permit}\n`
        + `safe_to_rank=${rc.safe_to_rank} · safe_to_compare=${rc.safe_to_compare} · `
        + `safe_to_make_betting_interpretation=${rc.safe_to_make_betting_interpretation}\n`
        + (sc && sc.expected_games
          ? `SLATE SCOPE — ${sc.date} (${sc.timezone}): ${sc.live_games} of ${sc.scheduled_games} scheduled games in scope, `
            + `${sc.final_games} already final and excluded, ${sc.missing_games} scheduled game(s) not retrieved. `
            + `${sc.complete ? "The slate is complete." : "The slate is INCOMPLETE — say so before ranking it."}\n`
          : "")
        + `COVERAGE of what THIS question requires — ${Math.round(cov.overall * 100)}%\n`
        + `  required:  ${Object.entries(cov.required).map(([k, c]) => `${k} ${c.available}/${c.expected}${c.via ? ` (via ${c.via})` : ""}`).join(" · ") || "none"}\n`
        + `  important: ${Object.entries(cov.important).map(([k, c]) => `${k} ${c.available}/${c.expected}${c.via ? ` (via ${c.via})` : ""}`).join(" · ") || "none"}\n`
        + `  optional:  ${Object.entries(cov.optional).map(([k, c]) => `${k} ${c.available}/${c.expected}`).join(" · ") || "none"}\n`
        + (cov.critical_gaps.length ? `  CRITICAL GAPS: ${cov.critical_gaps.join(", ")}\n` : "")
        + (cov.important_gaps.length ? `  important gaps: ${cov.important_gaps.join(", ")}\n` : "")
        + (cov.not_applicable.length
          ? `  not applicable to this sport (do NOT report these as missing): ${cov.not_applicable.join(", ")}\n` : "")
        + `A field marked "via" was satisfied by a FALLBACK LAYER — say which layer the number came from.`,
      );
    }

    if (research.fallback_retrievals?.length) {
      parts.push(
        "TARGETED FOLLOW-UP RETRIEVALS — EdgeDesk audited its own coverage and went back for what was missing. "
        + "A retrieval that added nothing means the gap is real, not a lookup miss; say the data does not exist "
        + "rather than that it was not fetched:\n" + compact(research.fallback_retrievals, 2500),
      );
    }

    if (research.deterministic_context) {
      parts.push(
        "DETERMINISTIC CONTEXT — the engine's own numbers for the signal in focus. READ-ONLY. "
        + "Quote them exactly; never recompute, adjust, average or replace one:\n"
        + compact(research.deterministic_context),
      );
    }

    const usableAll = research.evidence.filter((e) => e.status !== "UNAVAILABLE");
    /* Budget FIRST, then audit, so the completeness check measures what the
       model is actually about to receive rather than what was retrieved. That
       gap is precisely the bug this layer exists to catch, so it would be
       absurd for the auditor itself to assume delivery. */
    const budget = budgetEvidence(usableAll, evidenceMax);
    research.integrity = evidenceIntegrity(research.evidence, {
      slateDays: [etDay(0), etDay(1)],
      delivered: { included: budget.included, withheld: budget.dropped },
    });

    /* Placed BEFORE the evidence, deliberately: the verdict has to be read
       before the numbers it governs, not after them. */
    {
      const g = research.integrity;
      parts.push(
        `EVIDENCE INTEGRITY — ${g.verdict}${g.headline ? `\n${g.headline}` : ""}\n`
        + g.checks.map((c) => `- [${c.status}] ${c.name}: ${c.detail}`
          + (c.entities?.length ? `\n    affected: ${c.entities.join("; ")}` : "")).join("\n")
        + (g.verdict === "FAIL"
          ? "\nYou may NOT publish a ranking or a confident comparison from this evidence. Report the fault, "
            + "name the entities it touches, and say what would have to be repaired."
          : g.verdict === "WARNING"
            ? "\nLead with this caveat in your first line and label any conclusion provisional."
            : ""),
      );
    }

    /* EVIDENCE_MAX is deliberately large: a 30-starter MLB slate serializes to
       ~69,000 characters, and the old 60,000 default silently severed it
       mid-object. Evidence is the one block that must never be trimmed to make
       room for something else — it is the entire factual basis of the answer.
       Whole items only, and anything withheld is named below. */
    if (usableAll.length) {
      parts.push(
        "EVIDENCE — retrieved from EdgeDesk's own tables just now. These are the facts you may use; "
        + "quote their values exactly and respect each item's status and freshness.\n"
        + "Each item carries an `id` and a `layer`. EVERY NUMBER YOU QUOTE MUST COME FROM ONE OF THESE ITEMS.\n"
        + "LAYER decides analytical priority when two items speak to the same thing: "
        + "matchup (current, specific to tonight) > season (current, identity-keyed, says nothing about tonight's "
        + "opponent) > market > historical > context. A historical or season figure NEVER outranks a current "
        + "matchup figure, and a season rate must never be presented as a matchup read — name the layer whenever "
        + "the distinction could matter:\n"
        + budget.text,
      );
      if (budget.droppedNote) parts.push("EVIDENCE WITHHELD — " + budget.droppedNote);
      (research as any).evidence_shown = { included: budget.included, withheld: budget.dropped };
    }

    if (research.attack) {
      parts.push(
        "THESIS ATTACK (deterministic, computed from owned signal fields — do not recompute):\n"
        + compact(research.attack),
      );
    }

    /* Support and contradictions SELECTED FROM THE EVIDENCE, by id. An empty
       contradiction list is a real finding and must be reported as one. */
    if (research.thesis_attack) {
      const ta = research.thesis_attack;
      parts.push(
        "THESIS ATTACK INPUTS — evidence ids, chosen from the packet rather than written.\n"
        + `support: ${ta.support.map((s: any) => `${s.id}(${s.field}/${s.entity})`).join(", ") || "none"}\n`
        + `contradictions: ${ta.contradictions.length
          ? ta.contradictions.map((c: any) => `${c.id ?? "-"}: ${c.detail}`).join(" | ")
          : "NONE. Nothing in this packet contradicts the thesis. Say that plainly — do NOT manufacture an objection to look balanced."}\n`
        + `unresolved: ${ta.unresolved_questions.join(" | ") || "none"}`,
      );
    }

    if (research.conflicts.length) {
      parts.push(
        "CONFLICTS — owned sources that disagree. Name both. Use `resolution` when present; "
        + "if it is null the field is contested and should lower confidence:\n"
        + compact(research.conflicts),
      );
    }

    if (research.unavailable.length) {
      parts.push(
        "UNAVAILABLE — EdgeDesk attempted these retrievals and they returned nothing. "
        + "Say plainly that they are not available in EdgeDesk's current data; never fill them in:\n"
        + compact(research.unavailable),
      );
    }

    const mem = research.memory;
    const cal = (mem as any).calibration ?? [];
    if (mem.facts.length || mem.outcomes.length || mem.patterns.length || mem.prior.length || cal.length) {
      parts.push(
        `RESEARCH MEMORY — EdgeDesk's own accumulated history. Every pattern below is CONFIRMED: it cleared the `
        + `${MIN_PATTERN_N}-sample floor, held in a chronologically held-out later window, survived a `
        + `false-discovery correction across every slice tested, and beat an effect floor. Unconfirmed patterns were `
        + `filtered out before this message. Always state the N; prior outcomes are historical, never proof about today:\n`
        + compact({ facts: mem.facts, prior_outcomes: mem.outcomes, patterns: mem.patterns,
                    calibration: cal, prior_sessions: mem.prior }),
      );
    }
    if (!mem.patterns.length) {
      parts.push(
        "LEARNING STATE — EdgeDesk has NO confirmed patterns to offer for this question. That means the sample is "
        + "still accumulating, not that no tendency exists. Say so plainly if the question invites a pattern, and do "
        + "not substitute a general belief about sports betting for a pattern EdgeDesk has actually measured.",
      );
    }

    parts.push(
      `DIMENSION AVAILABILITY (sport-level, secondary to the COVERAGE block above): ${research.completeness.pct}%\n`
      + `Available: ${research.completeness.available.join(", ") || "none"}\n`
      + `Partial/probable: ${research.completeness.partial.join(", ") || "none"}\n`
      + `Stale: ${research.completeness.stale.join(", ") || "none"}\n`
      + `Missing: ${research.completeness.missing.join(", ") || "none"}\n`
      + (research.coverage.length
        ? "Per-entity coverage — use the entities that HAVE the field and name the ones that do not. "
        + "Never say a field is unavailable for the slate when it is available for most of it:\n"
        + research.coverage.map((c) => "  " + c.summary).join("\n")
        : ""),
    );

    if (research.changed) {
      parts.push(
        `WHAT CHANGED — research packet v${research.snapshot?.version ?? 1} vs the last one on file. `
        + "Use this for any 'what changed' question; do not infer movement from anything else:\n"
        + compact(research.changed, 3000),
      );
    }

    if (research.cross.length) {
      parts.push(
        "CROSS-MARKET STRUCTURE — what the markets on this game say about EACH OTHER. "
        + "EdgeDesk scores every signal in isolation, so none of this appears in any single verdict. "
        + "It is research direction derived by comparing owned prices; it is never itself a bet, and a "
        + "conflict flag means one of the two is wrong, not that both are playable:\n"
        + compact(research.cross, 4000),
      );
    }

    if (research.movement) {
      parts.push(
        "MARKET MOVEMENT since EdgeDesk froze the price. This is a comparison of two owned prices, "
        + "NOT a CLV — CLV exists only after the close is captured. Do not present it as one:\n"
        + compact(research.movement),
      );
    }

    if (research.queue.length && (research.plan.mode === "SCOUT" || research.plan.depth === "SLATE")) {
      parts.push(
        "RESEARCH QUEUE — games flagged by comparing owned fields against each other. "
        + "research_interest and betting_action are SEPARATE: a game can be the most interesting "
        + "thing on the board and still not be a bet. Never present research interest as a recommendation:\n"
        + compact(research.queue, 6000),
      );
    }

    /* ── HISTORICAL CUTOFF ────────────────────────────────────────────────
       Placed near the end deliberately: it is a constraint on how the answer
       may be written, and it is the last thing read before the data path. */
    if (research.leakage?.as_of) {
      parts.push(
        `HISTORICAL CUTOFF — this question asks about ${research.leakage.as_of}, so EdgeDesk removed every fact it `
        + `could prove became known afterwards.\n${research.leakage.note}\n`
        + (research.leakage.excluded
          ? `Excluded: ${research.leakage.excluded_items.map((x) => `${x.field}/${x.entity ?? "?"}`).join(", ")}\n`
          : "")
        + `You are answering AS OF THAT DATE. Do not use later injuries, later results, later closing lines, later `
        + `rankings or later statistics — not from this packet, not from memory, and not by reasoning about what must `
        + `have happened since. If the honest answer is that the evidence available at the time was thin, say that; a `
        + `confident hindsight answer is worthless and it contaminates every outcome measured against it.`,
      );
    }

    /* ── SOURCE RELIABILITY ───────────────────────────────────────────────
       Infrastructure quality, stated as such. The one thing that must not
       happen here is the analyst reading a retrieval-success rate as a
       confidence level about a bet, so the boundary is spelled out. */
    if (research.source_reliability?.length) {
      const bad = research.source_reliability.filter((s) => s.failed_retrievals > 0 || s.empty_retrievals > 0);
      parts.push(
        "SOURCE RELIABILITY THIS SESSION — how EdgeDesk's own retrieval behaved. This is INFRASTRUCTURE QUALITY. "
        + "It is not a probability, not a confidence level about any bet, and it must never be presented as one.\n"
        + research.source_reliability.slice(0, 14).map((s) =>
          `- ${s.source}: ${s.successful_retrievals}/${s.attempts} answered, ${s.rows} rows`
          + (s.empty_retrievals ? `, ${s.empty_retrievals} returned empty` : "")
          + (s.failed_retrievals ? `, ${s.failed_retrievals} FAILED (${s.last_error ?? "?"})` : "")).join("\n")
        + (bad.length
          ? `\nA source that answered but returned nothing means the DATA is absent, not that EdgeDesk failed to look — `
            + `say the data does not exist. A source that FAILED means the lookup never completed, which is a different `
            + `sentence and a different fix.`
          : "\nEvery source answered with rows."),
      );
    }

    if (research.learning_context) {
      parts.push(
        "LEARNING CONTEXT — operational facts accumulated from this run. These are observations about EdgeDesk's own "
        + "data pipeline, never about sport. They may inform how much you trust a layer; they may never become a "
        + "number, a probability or a claim about a game:\n"
        + compact(research.learning_context, 2000),
      );
    }

    if (Object.keys(research.data_path).length) {
      parts.push(
        "DATA PATH — where a retrieval came back empty and which link failed. If the user's question "
        + "needed one of these, explain in one sentence what EdgeDesk tried and what came back:\n"
        + compact(research.data_path, 4000),
      );
    }
  }

  // The client's own deterministic output, when a signal or board is loaded.
  if (packet && typeof packet === "object") {
    const clone: Record<string, unknown> = { ...packet };
    const board = clone.board;
    delete clone.board; delete clone.board_mode;
    if (Object.keys(clone).length) {
      parts.push(
        "CLIENT PACKET — the deterministic engine's output for the signal the user has open. "
        + "Its verdict, confidence, score and price sensitivity are authoritative:\n"
        + JSON.stringify(clone),
      );
    }
    if (board) {
      parts.push(
        "CLIENT BOARD — the slate the app already scored. Authoritative for verdicts, confidence, "
        + "scores and price sensitivity:\n" + compact(board),
      );
    }
  }

  if (Array.isArray(compare) && compare.length) {
    parts.push("SHORTLIST — already-scored rows to interpret:\n" + compact(compare));
  }

  if (!research && !packet && !(Array.isArray(compare) && compare.length)) {
    parts.push(
      "No evidence could be retrieved and nothing is attached. Say what EdgeDesk tried, "
      + "and answer only in general terms about how EdgeDesk reasons. Invent nothing.",
    );
  }

  /* ── DECISION CARD FACTS + the structured copy contract ─────────────────
     Last, so it is the closest thing to the answer. The model writes copy
     ABOUT these facts; it never writes the facts. */
  if (pres) {
    parts.push(decisionCardFacts(pres));
    parts.push(COPY_CONTRACT);
  }
  return parts.join("\n\n");
}

function defaultAsk(mode: string): string {
  switch (mode) {
    case "why": return "Why does EdgeDesk have this signal, at this price, right now?";
    case "challenge": return "Attack this bet — what would make the thesis false?";
    case "whatchanged": return "What has changed since EdgeDesk detected this?";
    case "market": return "Is the market telling us something the model is not?";
    case "price": return "At what price does this stop being a bet?";
    case "trace": return "Full research packet: RESEARCHED / FOUND / CONFLICTS / WHAT MATTERS / PRICE / DECISION / WHAT WOULD CHANGE IT.";
    case "research": return "Research this and give a decision. Name anything that could not be verified.";
    case "slate": return "Which of these deserve attention, and where should I start?";
    case "board": return "Answer from the attached board and evidence. Name anything not on file.";
    case "publisher": return "Write the publisher brief for this game from EdgeDesk's decision and evidence.";
    default: return "Research this and give a decision with the reasoning.";
  }
}

/* ======================================================================== */
/* MEMORY WRITE-BACK                                                        */
/* ======================================================================== */

/* The outcome of the most recent memory write, reported by ?probe=1. The
   learning loop's write half fails silently by construction — it is inside a
   catch, after the response has already gone out — so this is the only place
   its health is observable without querying the database. */
let LAST_MEMORY_WRITE: Record<string, unknown> | null = null;

/* Writes the session under the CALLER's JWT, so RLS decides what is allowed.
   Never blocks the response and never fails the request. */
async function rememberSession(
  auth: string, body: any, research: ResearchOut | null, answer: string,
): Promise<void> {
  if (!research || !SUPABASE_URL) return;
  const entities = Array.from(new Set([
    ...research.state.teams,
    ...research.evidence.filter((e) => e.field === "probable_starter").map((e) => String(e.entity)),
  ])).slice(0, 12);

  const row = {
    sport: research.focus?.sport_key ?? research.state.sport ?? null,
    event_id: research.focus?.event_id ?? null,
    market: research.focus?.market ?? null,
    entities,
    question: String(body?.question ?? body?.mode ?? "").slice(0, 1000),
    intent: research.plan.intent,
    mode: research.plan.mode,
    depth: research.plan.depth,
    research_plan: { steps: research.plan.steps, why: research.plan.why, budget: research.plan.budget },
    evidence_summary: {
      counts: research.evidence.reduce((a: Record<string, number>, e) => {
        a[e.status] = (a[e.status] ?? 0) + 1; return a;
      }, {}),
      sources: Array.from(new Set(research.evidence.map((e) => e.source))),
      conflicts: research.conflicts.length,
      unavailable: research.unavailable.map((u) => `${u.source}.${u.field}`),
    },
    conclusion: answer.slice(0, 4000),
    thesis_attack: research.attack,
    data_freshness: research.evidence.reduce((a: Record<string, number>, e) => {
      a[e.freshness] = (a[e.freshness] ?? 0) + 1; return a;
    }, {}),
    retrieval_log: research.log.slice(0, 30),
  };

  const post = (table: string, payload: unknown, wantRow = false, prefer?: string) =>
    fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY, authorization: auth,
        "content-type": "application/json",
        prefer: prefer ?? (wantRow ? "return=representation" : "return=minimal"),
      },
      body: JSON.stringify(payload),
    });

  try {
    /* Ask for the row back so the outcome can be linked to the session that
       produced it. Without that link a graded result cannot be traced to the
       reasoning that preceded it, which is the entire point of the loop. */
    let sessionId: string | null = null;
    try {
      const r = await post("research_sessions", row, true);
      const j = await r.json().catch(() => null);
      sessionId = Array.isArray(j) ? (j[0]?.id ?? null) : (j?.id ?? null);
    } catch { /* the session write is best-effort; the rest still proceeds */ }

    /* ── CLOSE THE LEARNING LOOP ──────────────────────────────────────────
       research_outcomes was being READ but never WRITTEN, and the trigger on
       settle only UPDATEs rows that already exist. So every graded result had
       nothing to attach to and EdgeDesk could never learn from a single one —
       the memory layer was architecturally unable to accumulate.

       An open outcome is now recorded whenever research lands on a real signal
       with a real thesis. It stores what was believed and why, at the price it
       was believed at; settle fills in the closing price, CLV and result later.
       Nothing here is a prediction and nothing is scored — it is the before
       half of a before/after pair. */
    const f = research.focus;
    if (f?.event_id && research.attack && num(f.edge) != null) {
      const strongest = research.evidence
        .filter((e) => e.status === "VERIFIED" && e.relevance && e.relevance !== "schedule")
        .slice(0, 1)
        .map((e) => `${e.field} from ${e.source}: ${JSON.stringify(e.value).slice(0, 220)}`)[0] ?? null;
      const contradiction = research.conflicts[0]
        ? `${research.conflicts[0].field}: ${research.conflicts[0].a.source} vs ${research.conflicts[0].b.source}`
        : (research.attack.falsifiers[0] ?? null);

      /* THE WRITE HALF OF THE LEARNING LOOP, AND IT IS NOT ASSUMED TO WORK.
         This upserts on (user_id, event_id, market, selection) but the payload
         has never sent user_id — it relies on a column DEFAULT of auth.uid().
         If that default is absent the row is rejected, the whole call is inside
         a catch, and the loop silently never accumulates: settle only UPDATEs
         rows that already exist, so a missing open outcome means a graded
         result has nothing to attach to. The status is recorded so ?probe=1 can
         report whether the last write actually landed, rather than leaving it
         to be inferred from an empty table months later. */
      const oRes = await post("research_outcomes?on_conflict=user_id,event_id,market,selection", {
        session_id: sessionId,
        entity: research.state.teams[0] ?? `${f.away_team ?? ""} @ ${f.home_team ?? ""}`,
        sport: f.sport_key ?? null,
        event_id: f.event_id,
        market: f.market ?? null,
        selection: f.selection ?? null,
        thesis: `${research.plan.intent} / ${research.attack.status}: ${research.attack.note}`.slice(0, 1000),
        price: num(f.best_dec),
        fair_price: num(f.sharp_fair) ?? num(f.consensus_fair),
        edge: num(f.edge),
        strongest_support: strongest,
        strongest_contradiction: contradiction,
        falsifier: research.attack.falsifiers[0] ?? null,
      }, false, "resolution=ignore-duplicates,return=minimal");
      LAST_MEMORY_WRITE = {
        at: new Date().toISOString(),
        research_outcomes_status: oRes.status,
        ok: oRes.status >= 200 && oRes.status < 300,
        detail: oRes.status >= 300
          ? (await oRes.text().catch(() => "")).slice(0, 300)
            + " — if this mentions user_id, the column has no auth.uid() default and the learning loop is not accumulating."
          : null,
        session_linked: !!sessionId,
      };
    }

    // Versioned research packet, so the next turn can diff against it.
    if (research.snapshot?.event_id) {
      await post("research_snapshots", {
        event_id: research.snapshot.event_id,
        version: research.snapshot.version,
        sport: research.focus?.sport_key ?? null,
        taken_at: new Date(research.snapshot.taken_at).toISOString(),
        facts: research.snapshot.facts,
      });
    }

    /* ── SOURCE RELIABILITY LEDGER ────────────────────────────────────────
       Infrastructure quality, accumulated across sessions so a source that is
       persistently empty or persistently broken becomes a known operational
       fact rather than something every session rediscovers.

       This is NEVER a betting number and it never touches a price. It exists so
       the retrieval planner can prefer a source that works, and so "cfb.roster
       has answered zero times in three weeks" is answerable without a database
       archaeology session. The table is optional: if it does not exist the POST
       fails, the failure is swallowed like every other memory write, and the
       answer is unaffected. */
    if (research.source_reliability?.length) {
      await post("research_source_stats", research.source_reliability.slice(0, 40).map((s) => ({
        source: s.source,
        sport: research.sport ?? null,
        evidence_type: research.plan.intent,
        sample_size: s.attempts,
        successful_retrievals: s.successful_retrievals,
        failed_retrievals: s.failed_retrievals,
        empty_retrievals: s.empty_retrievals,
        rows_returned: s.rows,
        completeness_rate: s.completeness_rate,
        reliability_score: s.reliability_score,
        last_error: s.last_error,
        observed_at: new Date().toISOString(),
      })));
    }

    // Structured findings — claims bound to the record that produced them.
    // Nothing the model wrote is ever stored here; only extracted evidence.
    if (research.findings.length) {
      await post("research_findings", research.findings.slice(0, 40).map((f) => ({
        entity: f.entity, fact_type: f.fact_type, claim: f.claim,
        fact_value: f.fact_value, source: f.source,
        source_timestamp: f.source_timestamp,
        verification_status: f.verification_status,
        confidence: f.confidence, valid_until: f.valid_until,
        sport: research.focus?.sport_key ?? research.state.sport ?? null,
      })));
    }
  } catch { /* memory is an enhancement; never fail the answer for it */ }
}

/* ======================================================================== */
/* HANDLER                                                                  */
/* ======================================================================== */

/** The research summary returned to the client. Additive; older clients
    ignore it. Factored out so the empty-completion path and the success
    path cannot drift apart. */
function researchSummary(research: ResearchOut | null, plan: Plan) {
  return research
    ? {
      intent: research.plan.intent, mode: research.plan.mode, depth: research.plan.depth,
      entities: research.entities,
      /* r3: which sport module answered, and what identity it bound. */
      sport: research.sport,
      sport_label: research.sport_module?.label ?? null,
      identity: research.identity.map((i) => ({
        query: i.query, status: i.status,
        canonical_team_id: i.canonical_team_id, canonical_name: i.canonical_name,
      })),
      source_reliability: research.source_reliability,
      leakage: research.leakage.as_of
        ? { as_of: research.leakage.as_of, excluded: research.leakage.excluded, undated: research.leakage.undated }
        : null,
      capability_gaps: research.capabilities.filter((c) => c.status === "NOT_AVAILABLE")
        .map((c) => c.capability),
      fallback_retrievals: research.fallback_retrievals,
      packet_version: research.snapshot?.version ?? null,
      changed: research.changed?.changed ?? null,
      findings_stored: research.findings.length,
      cross_market: research.cross.map((c) => ({ kind: c.kind, markets: c.markets, interest: c.research_interest })),
      movement: research.movement?.direction ?? null,
      queue: research.queue.slice(0, 6),
      retrievals: research.calls, ms: research.ms,
      sources: Array.from(new Set(research.evidence.map((e) => e.source))),
      evidence_count: research.evidence.filter((e) => e.status !== "UNAVAILABLE").length,
      /* How much of that count actually reached the model. When these
         differ, coverage is describing more than the answer could see. */
      evidence_shown: (research as any).evidence_shown ?? null,
      /* The panel renders this as a banner above the answer, so a FAIL is
         visible without reading to the bottom. */
      integrity: {
        verdict: research.integrity.verdict,
        summary: research.integrity.summary,
        headline: research.integrity.headline,
        failed: research.integrity.checks.filter((c) => c.status !== "PASS"),
      },
      unavailable: research.unavailable,
      conflicts: research.conflicts.length,
      attack: research.attack?.status ?? null,
      completeness: research.completeness,
      coverage: research.coverage.map((c) => ({ field: c.field, have: c.have_n, total: c.total_n })),
      data_path: research.data_path,
    }
    : { intent: plan.intent, mode: plan.mode, depth: plan.depth, retrievals: 0, note: "retrieval unavailable — answered from the attached packet only" };
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = (() => { try { return new URL(req.url); } catch { return null; } })();
  const probe = url?.searchParams.get("probe") === "1";
  const dry = url?.searchParams.get("dry") === "1";

  /* ?probe=1 — no auth, no model call, no database read. Answers exactly one
     question: WHICH BUILD IS SERVING, and what is it configured to do. This is
     the first thing to call after any deploy. */
  if (probe) {
    return json({
      ok: true,
      build: BUILD,
      model: MODEL,
      research_enabled: RESEARCH_ENABLED,
      mlb_live_fallback: MLB_FALLBACK,
      min_pattern_n: MIN_PATTERN_N,
      evidence_max_chars: EVIDENCE_MAX,
      presentation: {
        version: 1,
        modes: ["SIMPLE", "STANDARD", "DEEP", "PUBLISHER"],
        library_loaded: !!EDPRES,
        library_version: EDPRES ? EDPRES.VERSION : null,
        note: "Deterministic decision -> translate -> present. AI copy is validated; rejected copy falls back to templates.",
      },
      /* Presence only. A boolean says whether a credential is configured; the
         value never leaves the process, and no key, URL or token appears
         anywhere in this response. */
      env: {
        anthropic_key: !!ANTHROPIC_API_KEY,
        supabase_url: !!SUPABASE_URL,
        supabase_anon_key: !!SUPABASE_ANON_KEY,
        cfbd_key: !!CFBD_API_KEY,
        nflverse_configured: !!NFLVERSE_BASE && NFLVERSE_ENABLED,
        cbb_ratings_configured: !!CBB_RATINGS_URL,
      },
      sports: Object.values(SPORTS).map((s) => ({ key: s.key, label: s.label, status: s.status })),
      sport_capabilities: SPORT_CAPABILITIES,
      /* ── r3 diagnostics ────────────────────────────────────────────── */
      sport_modules: Object.values(SPORT_INTELLIGENCE).map((m) => ({
        key: m.key, label: m.label, league: m.league, status: m.status,
        season: m.season.note,
        abbreviation_safe: m.identity.abbreviation_safe,
        research_intents: m.research_intents.length,
        evidence_hierarchy: m.evidence_hierarchy,
        data_layers: Object.keys(m.layers),
        capabilities: m.capabilities.reduce((a: Record<string, number>, c) => {
          a[c.status] = (a[c.status] ?? 0) + 1; return a;
        }, {}),
      })),
      capability_matrix: capabilityMatrix().map((c) => ({
        capability: c.capability, source: c.source, source_type: c.source_type,
        endpoint: c.endpoint, schema: c.schema ?? "public", status: c.status,
        freshness: c.freshness, credential: c.credential, data_layer: c.data_layer,
        notes: c.notes,
      })),
      source_health: {
        /* What this build will actually be ABLE to reach, stated as a
           configuration fact rather than a live probe — probe=1 must stay free
           of database and network calls so it can answer "which build is
           serving" even when everything else is down. */
        owned_public_schema: "read under the caller's JWT, so RLS applies exactly as in the browser",
        owned_cfb_schema: "read via PostgREST Accept-Profile: cfb — requires the cfb schema to be exposed under "
          + "Supabase > API settings, same as the ufc and wta schemas",
        external_keyless: ["statsapi.mlb.com", "baseballsavant.mlb.com"],
        external_credentialed: [
          { provider: "CollegeFootballData", env: "CFBD_API_KEY", configured: !!CFBD_API_KEY },
          { provider: "nflverse", env: "EDGEDESK_NFLVERSE_BASE", configured: !!NFLVERSE_BASE && NFLVERSE_ENABLED },
          { provider: "CBB external ratings", env: "EDGEDESK_CBB_RATINGS_URL", configured: !!CBB_RATINGS_URL },
        ],
      },
      cache_health: {
        entries: cacheSize(),
        cacheable_categories: Object.keys(CACHEABLE),
        note: "Per-isolate, scoped by caller and by schema. Odds, lineups and weather are deliberately never cached.",
      },
      learning_health: {
        last_memory_write: LAST_MEMORY_WRITE,
        min_pattern_n: MIN_PATTERN_N,
        identity_graph_size: canonicalRegistry().length,
        note: "last_memory_write is null until a real question has run in this isolate. Non-null with ok:false means "
          + "the learning loop is dropping its open outcomes and cannot accumulate.",
      },
      intents_with_requirements: Object.keys(REQUIREMENTS).filter((k) => k !== "_default"),
      /* null until a real question has run in this isolate. Non-null and
         ok:false means the learning loop is dropping its open outcomes. */
      last_memory_write: LAST_MEMORY_WRITE,
      modes: ["probe=1 (this)", "dry=1 (research packet, no model call)", "POST (full answer)"],
    });
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "missing bearer" }, 401);
  // ?dry=1 runs retrieval and returns the packet, so the research layer can be
  // verified without spending a model call or depending on the key being set.
  if (!ANTHROPIC_API_KEY && !dry) return json({ error: "ANTHROPIC_API_KEY not set" }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const history = Array.isArray(body?.history) ? body.history.slice(-8) : [];

  /* --- plan ------------------------------------------------------------- */
  const plan = classify(String(body?.question ?? ""), String(body?.mode ?? ""));
  const state = deriveState(history, plan, body?.packet, null);
  const presentationMode = presentationModeOf(body, plan);

  /* --- research --------------------------------------------------------- */
  let research: ResearchOut | null = null;
  if (RESEARCH_ENABLED && SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const dal = new Dal({
        supabaseUrl: SUPABASE_URL, apikey: SUPABASE_ANON_KEY,
        authorization: auth, budget: plan.budget, mlbFallback: MLB_FALLBACK,
      });
      research = await runResearch(plan, state, body?.packet, dal, String(body?.question ?? ""));
    } catch {
      // Retrieval blew up entirely — degrade to packet-only narration, which is
      // exactly the behaviour this function had before the research layer.
      research = null;
    }
  }

  /* --- the deterministic presentation, BEFORE the model ------------------
     Built from the client's packet (or the board row in focus) plus the
     server-side integrity audit. It exists whether or not the model answers. */
  let presentation: Presentation | null = null;
  try { presentation = buildPresentation(body, research, presentationMode); } catch { presentation = null; }

  /* ?dry=1 — everything except the model call. Returns the packet the analyst
     WOULD have received, so retrieval, entity resolution, coverage, integrity
     and the assembled prompt can all be verified in one request without
     spending a token or depending on the answer to reveal a retrieval bug. */
  if (dry) {
    const content = buildUserContent(body, research, EVIDENCE_MAX, presentation);
    return json({
      dry: true,
      /* The whole packet, in the order the analyst reads it, so exactly what
         Claude receives can be inspected without spending a model call. */
      request: { mode: body?.mode ?? "chat", question: body?.question ?? null,
                 has_packet: !!body?.packet, history_turns: history.length,
                 presentation_mode: presentationMode },
      intent: { intent: research?.plan.intent ?? plan.intent, mode: research?.plan.mode ?? plan.mode,
                depth: research?.plan.depth ?? plan.depth, why: research?.plan.why ?? plan.why,
                steps: research?.plan.steps ?? plan.steps },
      /* The resolved sport, from the sport-resolution chain rather than from
         board order — this is the field that tells you whether the whole turn
         was routed to the right module. */
      sport: research?.sport ?? research?.focus?.sport_key ?? research?.state.sport ?? null,
      sport_resolution: (research?.data_path as any)?.sport_resolution ?? null,
      league: research?.sport_module?.league ?? null,
      sport_module: research?.sport_module
        ? {
          key: research.sport_module.key, label: research.sport_module.label,
          league: research.sport_module.league, status: research.sport_module.status,
          season: research.sport_module.season,
          identity: research.sport_module.identity,
          evidence_hierarchy: research.sport_module.evidence_hierarchy,
          research_intents: research.sport_module.research_intents,
          data_layers: research.sport_module.layers,
          learning_dimensions: research.sport_module.learning_dimensions,
        }
        : null,
      /* Canonical, sport-scoped identity for everything the question named,
         including what deliberately did NOT resolve. */
      identity: research?.identity ?? [],
      capabilities: research?.capabilities ?? [],
      capability_matrix: capabilityMatrix(research?.sport ?? null),
      /* Which providers ran, which were skipped, and why. */
      external_sources: {
        adapters: EXTERNAL_ADAPTERS.map((a) => ({
          id: a.id, provider: a.provider, sport: a.sport, capability: a.capability,
          credential_env: a.credential_env, configured: a.configured(),
          reason_if_unconfigured: a.configured() ? null : a.unconfigured_reason,
        })),
      },
      source_reliability: research?.source_reliability ?? [],
      leakage_guard: research?.leakage ?? null,
      learning_context: research?.learning_context ?? null,
      entities: research?.entities ?? null,
      slate_scope: research?.slate_scope ?? null,
      requirements: research?.requirements ?? null,
      coverage: research?.semantic ?? null,
      coverage_per_entity: research?.coverage ?? null,
      completeness: research?.research_completeness ?? null,
      dimension_availability: research?.completeness ?? null,
      integrity: research?.integrity ?? null,
      fallbacks: research?.fallback_retrievals ?? [],
      conflicts: research?.conflicts ?? null,
      unavailable: research?.unavailable ?? null,
      deterministic_context: research?.deterministic_context ?? null,
      historical_context: research
        ? { patterns: research.memory.patterns, prior_outcomes: research.memory.outcomes,
            calibration: (research.memory as any).calibration ?? [] }
        : null,
      thesis_attack: research?.thesis_attack ?? null,
      thesis_attack_deterministic: research?.attack ?? null,
      data_gaps: research?.semantic
        ? { critical: research.semantic.critical_gaps, important: research.semantic.important_gaps,
            optional: research.semantic.optional_gaps, not_applicable: research.semantic.not_applicable }
        : null,
      data_path: research?.data_path ?? null,
      /* The deterministic card, exactly as a client would receive it without
         any model involvement. */
      presentation,
      provenance: {
        build: BUILD, model_not_called: true,
        retrievals: research?.calls ?? 0, retrieval_log: research?.log ?? [],
        sources: research ? Array.from(new Set(research.evidence.map((e) => e.source))) : [],
        ms: research?.ms ?? 0,
      },
      evidence: research?.evidence ?? [],
      evidence_count: research?.evidence.filter((e) => e.status !== "UNAVAILABLE").length ?? 0,
      evidence_shown: (research as any)?.evidence_shown ?? null,
      prompt_chars: content.length,
      prompt: content,
    });
  }

  /* --- synthesize -------------------------------------------------------- */
  const messages = [
    ...history
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: m.content })),
    { role: "user", content: buildUserContent(body, research, EVIDENCE_MAX, presentation) },
  ];
  /* Four presentations of one engine: the research prompt is shared, the
     write-up instructions differ. The copy contract rides along whenever
     there is a decision card to write copy for. */
  const system = SYSTEM + "\n\n" + MODE_PROMPT[presentationMode];
  /* SIMPLE and PUBLISHER are compression tasks; they need less room than a
     full research write-up, plus a small allowance for the copy block. */
  const baseTokens = presentationMode === "SIMPLE" ? 700
    : presentationMode === "STANDARD" ? 1200
    : presentationMode === "PUBLISHER" ? 1400
    : (MAX_TOKENS[plan.depth] ?? 1000);
  const maxTokens = baseTokens + (presentation ? 400 : 0);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      /* The client falls back to its own deterministic engine on a non-200.
         The deterministic card travels anyway so a client that reads it does
         not lose the decision to a narration outage. */
      return json({ error: `anthropic ${r.status}`, detail, presentation }, 502);
    }
    const data = await r.json();
    const textOf = (d: any) => (d?.content ?? [])
      .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
    let answer = textOf(data);

    /* AN EMPTY COMPLETION IS RECOVERABLE, AND IT WAS BEING TREATED AS FATAL.
       The model returning no text almost always means the answer did not FIT:
       a large evidence payload plus a small max_tokens leaves the budget spent
       before a single word is emitted, and the API reports that as
       stop_reason "max_tokens" with an empty content array. Returning 502 threw
       away a request that had already done all its retrieval, and told the user
       nothing about why. Retry once with room to write and a trimmed payload. */
    if (!answer) {
      const stop = data?.stop_reason ?? null;
      const usage = data?.usage ?? null;
      /* REBUILD, do not slice.
         This previously took messages[0] — which is the FIRST HISTORY TURN
         whenever history is non-empty, not the research packet — and cut it at
         60,000 characters. So the retry could re-send an unrelated earlier
         message, and when it did send the packet it severed the evidence array
         mid-object: exactly the failure budgetEvidence exists to prevent,
         reintroduced on the recovery path.
         Rebuilding with a smaller evidence budget keeps whole items only and
         NAMES whatever will not fit, so a retry answer is thinner but never
         built on a truncated record. */
      const trimmed = [
        { role: "user", content: buildUserContent(body, research, Math.floor(EVIDENCE_MAX / 4), presentation) },
      ];
      const r2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: Math.max(2000, maxTokens * 2),
          system,
          messages: trimmed,
        }),
      });
      if (r2.ok) answer = textOf(await r2.json());
      /* Still nothing. Say WHY, with the numbers, instead of two words — and do
         it as a 200 carrying the research, so the caller keeps the deterministic
         board rather than losing the whole response to a narration failure. */
      if (!answer) {
        return json({
          answer: "",
          error: "empty completion",
          why: `the model returned no text (stop_reason ${stop ?? "unknown"}). `
            + (usage ? `input ${usage.input_tokens ?? "?"} tokens, output ${usage.output_tokens ?? "?"}, ` : "")
            + `max_tokens ${maxTokens} at depth ${plan.depth}. `
            + `A retry with double the budget and a trimmed payload also came back empty.`,
          research,
          /* Deterministic copy only — nothing narrated, nothing lost. */
          presentation: applyAiCopyTo(presentation, null, research, "empty completion"),
        }, 200);
      }
    }

    /* --- split the structured copy off the prose, validate it, merge it ---
       The answer old callers receive is the prose ALONE; the block never
       reaches a chat log. If the block is missing or fails validation, the
       card keeps its deterministic copy — narration never owns the decision. */
    let parsed = { answer, copy: null as any, error: null as string | null };
    try { parsed = EDPRES ? EDPRES.parseAiCopyBlock(answer) : parsed; } catch { /* keep the raw answer */ }
    answer = parsed.answer || answer;
    presentation = applyAiCopyTo(presentation, parsed.copy, research, parsed.error);

    // Fire-and-forget memory write.
    const remember = rememberSession(auth, body, research, answer);
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(remember); else remember.catch(() => {});

    return json({
      answer,
      model: data?.model ?? MODEL,
      cached: false,
      // Additive. Older clients ignore it; the panel can render a research trace.
      research: researchSummary(research, plan),
      /* Additive. The structured decision card: deterministic fields from
         EdgeDesk-owned data, copy from the model only where it passed the gate. */
      presentation,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e), presentation }, 502);
  }
}

// Guarded so the module can be imported by tests without starting a server.
if (typeof Deno !== "undefined" && (Deno as any).serve && !Deno.env.get("EDGEDESK_AI_NO_SERVE")) {
  Deno.serve(handle);
}
