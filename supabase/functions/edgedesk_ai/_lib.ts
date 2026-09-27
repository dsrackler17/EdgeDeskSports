// supabase/functions/edgedesk_ai/_lib.ts
/* ===========================================================================
   THE RESEARCH LIBRARY, AS A FILE SOMEBODY CAN OPEN.

   index.ts named this file as PART 1's source of truth and this file did not
   exist. The 8,885 lines below lived only inside that single-file build — and
   that build is 2.2 MB, past the 1 MB ceiling above which GitHub renders no
   blob at all: no view, no search inside it, no web editor. Every other layer
   of the desk had a canonical file small enough to read. The research library,
   the part that decides what is retrieved and what an absence means, did not.

   Nothing changed in the move. The block between the markers is byte-for-byte
   what index.ts carried; `node tools/presentation/inline.js` copies it back,
   and the sync check fails on drift, exactly as it does for EDPRES, EDINTEL
   and the kernels beside them. The deployed file is identical to the byte.

   Edit HERE, then run the inliner. Never edit the copy inside index.ts.
   =========================================================================== */
/*__EDLIB_START__*/
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
      /* compared on the CLUB, not the spelling: "NY Yankees" in one table and
         "New York Yankees" in another are one team, and reading them as two
         is what flagged 26 starters on a live packet */
      s.add(clubKeyFor(e.sport ?? v?.sport, team));
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
      /* the same two clubs on DIFFERENT days are a series, not a duplicate:
         the key carries the date the item is bound to */
      const gd = String(v?.game_date ?? v?.date ?? e.date ?? "").slice(0, 10);
      const key = normName(game) + (gd ? "|" + gd : "");
      const s = idsOf.get(key) ?? new Set<string>();
      s.add(String(id));
      idsOf.set(key, s);
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
  attention_split: "SLATE",
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

/* ========================================================================
   MLB GAME STATE AND CLUB IDENTITY — the two faults a live packet showed.

   A production packet carried 21 items dated the day before, 4 matchups
   under two event ids and 26 starters "attached to two teams". All three
   had one cause each, and none was a wrong join:
     - yesterday's games were not marked "final" in the schedule table (the
       ingest writes its own status words), so the only status test that
       existed let a played game through as tonight's;
     - consecutive games of one series carry different ids and different
       dates, and the duplicate check keyed on the matchup name alone;
     - two tables spell one club two ways ("New York Yankees" / "NY
       Yankees"), and the subject check compared the raw strings.
   ======================================================================== */

/** Has this MLB game been played, whatever the ingest calls it? Status words first; then the clock: a game dated before today (ET) whose start passed more than six hours ago is over even when its status never updated. Suspended games are kept (they resume). */
export function mlbGameFinished(row: any, now = Date.now()): boolean {
  const st = String(row?.status ?? "").toLowerCase();
  if (/suspend|delay/.test(st)) return false;
  if (/final|game over|completed|cancel|postpon|forfeit/.test(st) || st === "f") return true;
  const gd = String(row?.game_date ?? "").slice(0, 10);
  const t = Date.parse(String(row?.start_time ?? ""));
  if (gd && gd < etDay(0) && (!Number.isFinite(t) || t < now - 6 * 3600000)) return true;
  if (Number.isFinite(t) && t < now - 6 * 3600000 && !/progress|live|warmup|pre/.test(st)) return true;
  return false;
}
/** A game that will not be played in this window: postponed or cancelled. */
export function mlbGameOff(row: any): boolean { return /postpon|cancel/.test(String(row?.status ?? "").toLowerCase()); }

let MLB_CLUB_INDEX: Map<string, string> | null = null;
/** The canonical club for any spelling a table uses: the full name, a nickname, a city or an abbreviation. Falls back to the normalised input so two unknown spellings still compare. */
export function mlbClubKey(name: unknown): string {
  const n = normName(name);
  if (!n) return "";
  if (!MLB_CLUB_INDEX) {
    MLB_CLUB_INDEX = new Map();
    for (const t of MLB_TEAMS) {
      MLB_CLUB_INDEX.set(normName(t.name), t.name);
      for (const a of t.aliases) { const k = normName(a); if (k && !MLB_CLUB_INDEX.has(k)) MLB_CLUB_INDEX.set(k, t.name); }
    }
  }
  const exact = MLB_CLUB_INDEX.get(n);
  if (exact) return exact;
  /* "NY Yankees", "Yankees (NYY)", "New York Yankees" — the longest alias that is a whole-word part of the name decides; a city alone is refused where two clubs share it */
  let best: { key: string; club: string } | null = null;
  for (const [k, club] of MLB_CLUB_INDEX) {
    if (k.length < 4) continue;
    if ((" " + n + " ").indexOf(" " + k + " ") >= 0 && (!best || k.length > best.key.length)) best = { key: k, club };
  }
  return best ? best.club : n;
}
/** The key two team spellings are compared on, by sport. */
export function clubKeyFor(sport: unknown, name: unknown): string {
  const n = normName(name);
  if (sport === "baseball_mlb" || sport == null || sport === "") {
    /* an item that names no sport still resolves when the spelling is a known MLB club */
    const k = normName(mlbClubKey(name));
    if (k && k !== n) return k;
    if (sport === "baseball_mlb") return k || n;
  }
  return n;
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

/* --------------------------------------------------------- NBA / NHL / WNBA ---
   THREE LEAGUES THAT HAD A MODULE, AN INTENT AND NOT ONE TEAM.

   `basketball_nba`, `icehockey_nhl` and `basketball_wnba` were registered in
   LEAGUE_OF_SPORT, carried retrieval steps in SPORT_LAYER_STEPS, and matched
   in the sport router — and had zero canonical teams between them. The effect
   was not a degraded answer, it was no answer at all: "How do the Lakers look
   tonight?", "What about the Bruins?" and "How do the Liberty look?" each
   resolved to NOTHING. The pipeline could name the sport and then had no idea
   who was being asked about.

   City and nickname ambiguity is NOT declared here. It is computed across the
   whole registry after every league is loaded, by reconcileAmbiguity() below,
   because a hand-maintained collision list is wrong the moment a league is
   added: "kings" was unambiguous until hockey arrived, "boston" until
   basketball did. */
const NBA_TEAMS: { name: string; city: string; state: string; abbr: string; conf: string; nick: string[] }[] = [
  { name: "Atlanta Hawks", city: "Atlanta", state: "GA", abbr: "ATL", conf: "East", nick: ["hawks"] },
  { name: "Boston Celtics", city: "Boston", state: "MA", abbr: "BOS", conf: "East", nick: ["celtics", "cs"] },
  { name: "Brooklyn Nets", city: "Brooklyn", state: "NY", abbr: "BKN", conf: "East", nick: ["nets"] },
  { name: "Charlotte Hornets", city: "Charlotte", state: "NC", abbr: "CHA", conf: "East", nick: ["hornets"] },
  { name: "Chicago Bulls", city: "Chicago", state: "IL", abbr: "CHI", conf: "East", nick: ["bulls"] },
  { name: "Cleveland Cavaliers", city: "Cleveland", state: "OH", abbr: "CLE", conf: "East", nick: ["cavaliers", "cavs"] },
  { name: "Dallas Mavericks", city: "Dallas", state: "TX", abbr: "DAL", conf: "West", nick: ["mavericks", "mavs"] },
  { name: "Denver Nuggets", city: "Denver", state: "CO", abbr: "DEN", conf: "West", nick: ["nuggets"] },
  { name: "Detroit Pistons", city: "Detroit", state: "MI", abbr: "DET", conf: "East", nick: ["pistons"] },
  { name: "Golden State Warriors", city: "San Francisco", state: "CA", abbr: "GSW", conf: "West", nick: ["warriors", "dubs", "golden state"] },
  { name: "Houston Rockets", city: "Houston", state: "TX", abbr: "HOU", conf: "West", nick: ["rockets"] },
  { name: "Indiana Pacers", city: "Indianapolis", state: "IN", abbr: "IND", conf: "East", nick: ["pacers"] },
  { name: "Los Angeles Clippers", city: "Inglewood", state: "CA", abbr: "LAC", conf: "West", nick: ["clippers", "clips", "la clippers"] },
  { name: "Los Angeles Lakers", city: "Los Angeles", state: "CA", abbr: "LAL", conf: "West", nick: ["lakers"] },
  { name: "Memphis Grizzlies", city: "Memphis", state: "TN", abbr: "MEM", conf: "West", nick: ["grizzlies", "grizz"] },
  { name: "Miami Heat", city: "Miami", state: "FL", abbr: "MIA", conf: "East", nick: ["heat"] },
  { name: "Milwaukee Bucks", city: "Milwaukee", state: "WI", abbr: "MIL", conf: "East", nick: ["bucks"] },
  { name: "Minnesota Timberwolves", city: "Minneapolis", state: "MN", abbr: "MIN", conf: "West", nick: ["timberwolves", "wolves"] },
  { name: "New Orleans Pelicans", city: "New Orleans", state: "LA", abbr: "NOP", conf: "West", nick: ["pelicans", "pels"] },
  { name: "New York Knicks", city: "New York", state: "NY", abbr: "NYK", conf: "East", nick: ["knicks"] },
  { name: "Oklahoma City Thunder", city: "Oklahoma City", state: "OK", abbr: "OKC", conf: "West", nick: ["thunder", "oklahoma city"] },
  { name: "Orlando Magic", city: "Orlando", state: "FL", abbr: "ORL", conf: "East", nick: ["magic"] },
  { name: "Philadelphia 76ers", city: "Philadelphia", state: "PA", abbr: "PHI", conf: "East", nick: ["76ers", "sixers"] },
  { name: "Phoenix Suns", city: "Phoenix", state: "AZ", abbr: "PHX", conf: "West", nick: ["suns"] },
  { name: "Portland Trail Blazers", city: "Portland", state: "OR", abbr: "POR", conf: "West", nick: ["trail blazers", "blazers"] },
  { name: "Sacramento Kings", city: "Sacramento", state: "CA", abbr: "SAC", conf: "West", nick: ["kings", "sacramento"] },
  { name: "San Antonio Spurs", city: "San Antonio", state: "TX", abbr: "SAS", conf: "West", nick: ["spurs", "san antonio"] },
  { name: "Toronto Raptors", city: "Toronto", state: "ON", abbr: "TOR", conf: "East", nick: ["raptors", "raps"] },
  { name: "Utah Jazz", city: "Salt Lake City", state: "UT", abbr: "UTA", conf: "West", nick: ["jazz"] },
  { name: "Washington Wizards", city: "Washington", state: "DC", abbr: "WAS", conf: "East", nick: ["wizards", "wiz"] },
];

/* Utah's club is listed as the Mammoth, the name it plays under from 2025-26.
   `utah hockey club` is kept as an alias because an odds feed that has not
   been updated still sends the old one, and a rename is exactly the kind of
   thing that silently unjoins a board from a schedule. */
const NHL_TEAMS: { name: string; city: string; state: string; abbr: string; conf: string; nick: string[] }[] = [
  { name: "Anaheim Ducks", city: "Anaheim", state: "CA", abbr: "ANA", conf: "West", nick: ["ducks"] },
  { name: "Boston Bruins", city: "Boston", state: "MA", abbr: "BOS", conf: "East", nick: ["bruins", "bs"] },
  { name: "Buffalo Sabres", city: "Buffalo", state: "NY", abbr: "BUF", conf: "East", nick: ["sabres"] },
  { name: "Calgary Flames", city: "Calgary", state: "AB", abbr: "CGY", conf: "West", nick: ["flames"] },
  { name: "Carolina Hurricanes", city: "Raleigh", state: "NC", abbr: "CAR", conf: "East", nick: ["hurricanes", "canes"] },
  { name: "Chicago Blackhawks", city: "Chicago", state: "IL", abbr: "CHI", conf: "West", nick: ["blackhawks", "hawks"] },
  { name: "Colorado Avalanche", city: "Denver", state: "CO", abbr: "COL", conf: "West", nick: ["avalanche", "avs"] },
  { name: "Columbus Blue Jackets", city: "Columbus", state: "OH", abbr: "CBJ", conf: "East", nick: ["blue jackets", "jackets"] },
  { name: "Dallas Stars", city: "Dallas", state: "TX", abbr: "DAL", conf: "West", nick: ["stars"] },
  { name: "Detroit Red Wings", city: "Detroit", state: "MI", abbr: "DET", conf: "East", nick: ["red wings", "wings"] },
  { name: "Edmonton Oilers", city: "Edmonton", state: "AB", abbr: "EDM", conf: "West", nick: ["oilers"] },
  { name: "Florida Panthers", city: "Sunrise", state: "FL", abbr: "FLA", conf: "East", nick: ["panthers"] },
  { name: "Los Angeles Kings", city: "Los Angeles", state: "CA", abbr: "LAK", conf: "West", nick: ["kings"] },
  { name: "Minnesota Wild", city: "Saint Paul", state: "MN", abbr: "MIN", conf: "West", nick: ["wild"] },
  { name: "Montreal Canadiens", city: "Montreal", state: "QC", abbr: "MTL", conf: "East", nick: ["canadiens", "habs"] },
  { name: "Nashville Predators", city: "Nashville", state: "TN", abbr: "NSH", conf: "West", nick: ["predators", "preds"] },
  { name: "New Jersey Devils", city: "Newark", state: "NJ", abbr: "NJD", conf: "East", nick: ["devils"] },
  { name: "New York Islanders", city: "Elmont", state: "NY", abbr: "NYI", conf: "East", nick: ["islanders", "isles"] },
  { name: "New York Rangers", city: "New York", state: "NY", abbr: "NYR", conf: "East", nick: ["rangers"] },
  { name: "Ottawa Senators", city: "Ottawa", state: "ON", abbr: "OTT", conf: "East", nick: ["senators", "sens"] },
  { name: "Philadelphia Flyers", city: "Philadelphia", state: "PA", abbr: "PHI", conf: "East", nick: ["flyers"] },
  { name: "Pittsburgh Penguins", city: "Pittsburgh", state: "PA", abbr: "PIT", conf: "East", nick: ["penguins", "pens"] },
  { name: "San Jose Sharks", city: "San Jose", state: "CA", abbr: "SJS", conf: "West", nick: ["sharks", "san jose"] },
  { name: "Seattle Kraken", city: "Seattle", state: "WA", abbr: "SEA", conf: "West", nick: ["kraken"] },
  { name: "St. Louis Blues", city: "St. Louis", state: "MO", abbr: "STL", conf: "West", nick: ["blues", "st louis"] },
  { name: "Tampa Bay Lightning", city: "Tampa", state: "FL", abbr: "TBL", conf: "East", nick: ["lightning", "bolts", "tampa bay"] },
  { name: "Toronto Maple Leafs", city: "Toronto", state: "ON", abbr: "TOR", conf: "East", nick: ["maple leafs", "leafs"] },
  { name: "Utah Mammoth", city: "Salt Lake City", state: "UT", abbr: "UTA", conf: "West", nick: ["mammoth", "utah hockey club"] },
  { name: "Vancouver Canucks", city: "Vancouver", state: "BC", abbr: "VAN", conf: "West", nick: ["canucks"] },
  { name: "Vegas Golden Knights", city: "Paradise", state: "NV", abbr: "VGK", conf: "West", nick: ["golden knights", "knights", "vegas"] },
  { name: "Washington Capitals", city: "Washington", state: "DC", abbr: "WSH", conf: "East", nick: ["capitals", "caps"] },
  { name: "Winnipeg Jets", city: "Winnipeg", state: "MB", abbr: "WPG", conf: "West", nick: ["jets"] },
];

/* The thirteen clubs through 2025 plus the two 2026 expansions, Toronto and
   Portland. A club listed here that does not exist yet costs nothing — it can
   only produce an identity match with no board row to join to — while a club
   MISSING from here produces exactly the failure this list was added to fix. */
const WNBA_TEAMS: { name: string; city: string; state: string; abbr: string; conf: string; nick: string[] }[] = [
  { name: "Atlanta Dream", city: "Atlanta", state: "GA", abbr: "ATL", conf: "East", nick: ["dream"] },
  { name: "Chicago Sky", city: "Chicago", state: "IL", abbr: "CHI", conf: "East", nick: ["sky"] },
  { name: "Connecticut Sun", city: "Uncasville", state: "CT", abbr: "CON", conf: "East", nick: ["sun", "connecticut"] },
  { name: "Dallas Wings", city: "Arlington", state: "TX", abbr: "DAL", conf: "West", nick: ["wings"] },
  { name: "Golden State Valkyries", city: "San Francisco", state: "CA", abbr: "GSV", conf: "West", nick: ["valkyries"] },
  { name: "Indiana Fever", city: "Indianapolis", state: "IN", abbr: "IND", conf: "East", nick: ["fever"] },
  { name: "Las Vegas Aces", city: "Las Vegas", state: "NV", abbr: "LVA", conf: "West", nick: ["aces", "las vegas"] },
  { name: "Los Angeles Sparks", city: "Los Angeles", state: "CA", abbr: "LAS", conf: "West", nick: ["sparks"] },
  { name: "Minnesota Lynx", city: "Minneapolis", state: "MN", abbr: "MIN", conf: "West", nick: ["lynx"] },
  { name: "New York Liberty", city: "Brooklyn", state: "NY", abbr: "NYL", conf: "East", nick: ["liberty"] },
  { name: "Phoenix Mercury", city: "Phoenix", state: "AZ", abbr: "PHO", conf: "West", nick: ["mercury"] },
  { name: "Portland Fire", city: "Portland", state: "OR", abbr: "POR", conf: "West", nick: ["fire"] },
  { name: "Seattle Storm", city: "Seattle", state: "WA", abbr: "SEA", conf: "West", nick: ["storm"] },
  { name: "Toronto Tempo", city: "Toronto", state: "ON", abbr: "TOR", conf: "East", nick: ["tempo"] },
  { name: "Washington Mystics", city: "Washington", state: "DC", abbr: "WAS", conf: "East", nick: ["mystics"] },
];

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

  /* NBA, NHL and WNBA. One shape, three leagues, because the three lists have
     the same shape and a copy each is three places for a rule to drift.
     Nothing is declared ambiguous here: reconcileAmbiguity() below works it
     out from the finished registry, which is the only way "kings" can be
     ambiguous for BOTH Sacramento and Los Angeles regardless of which league
     was loaded first. */
  for (const [teams, sport, label, league] of [
    [NBA_TEAMS, "basketball_nba", "NBA", "NBA"],
    [NHL_TEAMS, "icehockey_nhl", "NHL", "NHL"],
    [WNBA_TEAMS, "basketball_wnba", "WNBA", "WNBA"],
  ] as [typeof NBA_TEAMS, string, string, string][]) {
    for (const t of teams) {
      const cityTok = normName(t.city);
      const nameCity = normName(t.name.split(" ").slice(0, -1).join(" "));
      const aliases = new Set<string>([normName(t.name), ...t.nick.map(normName)]);
      /* A city is a claim about a metro area, not about a club: every one of
         them is shared with at least one other league somewhere. They go in as
         aliases and reconciliation decides. */
      for (const c of [cityTok, nameCity]) if (c) aliases.add(c);
      addCanonical({
        canonical_team_id: canonicalTeamId(sport, t.name),
        canonical_name: t.name, display_name: t.name,
        sport, sport_label: label, league,
        conference: t.conf, city: t.city, state: t.state, abbreviation: t.abbr,
        aliases: Array.from(aliases), ambiguous_aliases: [],
        provider_ids: { abbr: t.abbr },
      });
    }
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

  reconcileAmbiguity();
}

/**
 * Recompute which tokens are ambiguous, across the FINISHED registry.
 *
 * WHY THIS IS NOT DECLARED BY HAND. Each league block above could only check
 * its tokens against the leagues loaded BEFORE it, so ambiguity depended on
 * declaration order and was therefore asymmetric: load basketball before
 * hockey and "kings" is ambiguous for the Los Angeles Kings and unambiguous
 * for the Sacramento Kings, which is not a description of anything real. It is
 * also wrong the moment a league is added — "kings" was unambiguous until
 * hockey arrived, "boston" until basketball did — and a rule that must be
 * re-audited by hand on every addition will not be.
 *
 * AMBIGUITY IS BETWEEN CLUBS, NOT BETWEEN SPORTS. Texas State is registered
 * twice, once for football and once for basketball, and a question naming
 * "Texas State" is not ambiguous about WHO — only about which sport, which the
 * sport router decides before identity is ever asked. So the count is over
 * distinct canonical NAMES. Two different clubs sharing a token is ambiguity;
 * one club in two sports is not.
 *
 * A token that lands in `ambiguous_aliases` is not lost. resolveTeamIdentity()
 * still matches on it, and with a known sport a single claimant inside that
 * sport is a clean resolution — "kings" is the Sacramento Kings once the
 * question is known to be basketball. What ambiguity buys is the refusal to
 * guess when the sport is NOT known, which is the whole reason this registry
 * exists.
 */
function reconcileAmbiguity(): void {
  const claimants = new Map<string, Set<string>>();
  for (const t of CANONICAL_TEAMS.values()) {
    for (const a of [...t.aliases, ...t.ambiguous_aliases]) {
      const set = claimants.get(a) ?? new Set<string>();
      set.add(t.canonical_name);
      claimants.set(a, set);
    }
  }
  for (const t of CANONICAL_TEAMS.values()) {
    const safe: string[] = [];
    const amb = new Set<string>(t.ambiguous_aliases);
    for (const a of t.aliases) {
      if ((claimants.get(a)?.size ?? 1) > 1) amb.add(a); else safe.push(a);
    }
    t.aliases = safe;
    t.ambiguous_aliases = Array.from(amb);
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
  /* The WNBA was routed by the sport matcher and named in SPORT_LAYER_STEPS
     but had no module here, so `mod` came back undefined and the one thing
     this table exists to do — declare what EdgeDesk does NOT own, so an answer
     says so instead of improvising — did not happen for it. A league that is
     askable must be able to state its own limits. */
  basketball_wnba: {
    key: "basketball_wnba", label: "WNBA", status: "CORE_ONLY", steps: [],
    needs: "No WNBA availability, pace or efficiency tables are ingested. Core market research works; availability is the single highest-value missing input in a twelve-player rotation.",
  },
  mma_mixed_martial_arts: {
    key: "mma_mixed_martial_arts", label: "UFC/MMA", status: "CORE_ONLY", steps: ["rankings"],
    needs: "Fighter metrics live behind the ufc schema (ufc_fighters_sync / ufcstats_sync) and are not exposed to this function's reader. Core market research works.",
  },
  /* WIRED as of the tennis record contract (supabase/tennis_record.sql). The
     match record, the point-in-time feature layer, the rating layer, the model
     registry, the market snapshots and the published record all live in the
     `tennis` schema and are read through five BOUNDED security-definer
     functions (tennis.ai_*), not through raw table access — so the retrieval
     budget is a property of the database rather than a promise this function
     makes. The priced ones check entitlement inside SQL, so an unentitled
     reader is answered by Postgres with no rows rather than by this layer with
     a redaction. See supabase/functions/edgedesk_ai/_tennis.js. */
  tennis_wta: {
    key: "tennis_wta", label: "WTA", status: "WIRED",
    steps: ["tennis_rating", "tennis_surface", "tennis_form", "tennis_fatigue", "tennis_model", "market"],
    needs: "Not ingested, and said rather than substituted: injuries and withdrawals (no source), "
      + "point-by-point (no source), doubles ratings (a pair is a team, never a player), and exact "
      + "first-serve times for historical matches (the archive dates a match to its tournament week, "
      + "which is also why its weather is a week profile and never conditions at the toss).",
  },
  tennis_atp: {
    key: "tennis_atp", label: "ATP", status: "WIRED",
    steps: ["tennis_rating", "tennis_surface", "tennis_form", "tennis_fatigue", "tennis_model", "market"],
    needs: "Same coverage and the same gaps as the WTA module: one record, one rating layer and one "
      + "model serve both tours, with the tour as a column rather than a second implementation.",
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
      "bullpen", "weather", "offense", "historical", "what_changed"],
    /* `best_bets` was listed here, which made sportOfIntent() lock every
       "what are the best bets today?" to baseball before a schedule was read.
       A best-bets question is sport-agnostic; the board sweep decides. */
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
      "nfl_team_comparison", "nfl_research_matchup"],
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
      CAP("injuries_team_wide", "football/matchup/metrics.json", "ARTIFACT", "football/matchup/metrics.json → nfl.teams[code].injuries", "AVAILABLE", "injury", "L6_CURRENT",
        "The official NFL injury report (nflverse injuries_<season>.csv, synced six-hourly) per club: status, injury, practice. Attached to the research packet as injuries.home/away with its retrieved time."),
      CAP("nfl_projection", "football/nfl/slate.json", "ARTIFACT", "football/nfl/slate.json", "AVAILABLE", "model", "L5_MATCHUP",
        "EdgeDesk's own NFL projection per upcoming game (home line, fair total, win probability, p10/p50/p90, contributions), the browser's module run in Node. Carries its walk-forward record; RESEARCH tier for spreads."),
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
      "cfb_betting_candidate", "cfb_what_changed", "cfb_research_matchup"],
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
      CAP("unit_metrics", "football/matchup/metrics.json", "ARTIFACT", "football/matchup/metrics.json → teams[key].performance", "AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "Opponent-adjusted success, early-down, explosive, sack, stuff, third-down and red-zone rates per unit from EdgeDesk's rankings build, with raw, adjusted, league mean, plays and reliability; paired into matchup drivers. Plus play profiles, projected starters and coaching continuity."),
      CAP("per_play_efficiency", "—", "OWNED_TABLE", "—", "NOT_AVAILABLE", "team_stats", "L3_TEAM_SEASON",
        "EPA per play and success rate are NOT ingested for CFB: per-game CFBD calls exceed the free tier. Say so; never substitute points per game or a poll ranking."),
      CAP("returning_production", "cfb.returning_production", "PROVIDER_API", "returning_production", "PROBE", "historical", "L3_TEAM_SEASON",
        "Read is ATTEMPTED against the cfb schema. If cfb_ingest does not write it the read fails and an unavailable item names the exact table and the CFBD endpoint that would fill it.", null, "cfb"),
      CAP("transfer_portal", "cfb.portal", "PROVIDER_API", "portal", "PROBE", "historical", "L3_TEAM_SEASON",
        "Same contract as returning production: attempted, and reported honestly when absent.", null, "cfb"),
      CAP("cfbd_direct", "CollegeFootballData", "PROVIDER_API", "api.collegefootballdata.com", "REQUIRES_CREDENTIAL", "team_stats", "L3_TEAM_SEASON",
        "Direct API calls for returning production, per-play efficiency and portal require CFBD_API_KEY. Without the key each adapter is skipped and the gap is declared — the module never fails as a whole.",
        "CFBD_API_KEY"),
      CAP("per_play_efficiency", "CollegeFootballData", "PROVIDER_API", "stats/season/advanced", "REQUIRES_CREDENTIAL", "team_stats", "L3_TEAM_SEASON",
        "PPA, success rate and explosiveness by offence and defence, the layer the NFL module owns in its own tables and this one has never had. "
        + "Dark without CFBD_API_KEY, and SP+ is not a stand-in for it: a rating of results is not a measurement of how a team plays.",
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
      "cbb_tournament", "cbb_betting_candidate", "cbb_historical", "cbb_what_changed",
      "cbb_research_matchup"],
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
  /* ORDINARY WORDS THAT OPEN A SENTENCE. "Anything worth betting?" put
     ANYTHING on the roster-resolution queue as a candidate person, alongside
     the two teams the reader had just named. A capitalised word is not a
     surname just because it starts a clause. */
  "anything", "something", "anyone", "someone", "nothing", "nobody", "everything", "everyone",
  "any", "some", "none", "all", "both", "either", "neither", "there", "here", "then", "than",
  "worth", "betting", "bet", "bets", "value", "edge", "edges", "pick", "picks", "play", "plays",
  "line", "lines", "odds", "price", "prices", "spread", "total", "moneyline", "market", "markets",
  "game", "games", "matchup", "matchups", "slate", "board", "week", "weekend", "season",
  "thoughts", "think", "look", "looks", "anything's", "whats", "hows",
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
/**
 * What the caller already knows about the question, from a source the
 * classifier itself cannot reach.
 *
 * classify() is synchronous and runs BEFORE any retrieval, so it can only see
 * words. `resolveNamedMatchup` is asynchronous and resolves a real game off a
 * real card — which is strictly better evidence about which sport a question
 * is in, and it arrives one step too late to route anything. That is the whole
 * shape of the production failure: the sport was corrected downstream while the
 * PLAN stayed baseball, so "How does Texas State look this week?" executed
 * `pitcher_features` and `opponent_offense` against a college football game and
 * reported intent=unknown to the reader.
 *
 * So the plan is re-made once the context is known. This is the hint that lets
 * that happen without a second classifier.
 */
export interface ClassifyHint {
  /** The sport the resolved research context settled on. Outranks detectSport. */
  sport?: string | null;
  /** True when exactly one scheduled game is the subject of the question. */
  single_game?: boolean;
}

/* THE RETRIEVAL LAYERS THAT ONLY EXIST IN BASEBALL.
   These step names reach MLB-only tables. A plan that carries them into a
   football question does not merely waste a read: `runResearch` reports the
   steps it executed in the research trace, so the reader was told that a
   college football answer had retrieved `pitcher_features` and
   `opponent_offense` — which was true, and was the bug. */
const MLB_ONLY_STEPS = new Set(["pitchers", "pitcher_features", "opponent_offense",
  "bullpen", "park", "workload"]);

/* What each sport retrieves INSTEAD, so a re-scoped plan still asks for a
   matchup layer rather than simply losing one. Read from the sport module's
   own vocabulary, not invented here. */
const SPORT_LAYER_STEPS: Record<string, string[]> = {
  americanfootball_ncaaf: ["cfb_intelligence", "matchup_context", "cfb_sp_plus"],
  americanfootball_nfl: ["team_efficiency", "quarterback", "matchup_context", "nfl_deep"],
  basketball_ncaab: ["team_efficiency", "matchup_context", "cbb_deep"],
  basketball_nba: ["team_efficiency", "matchup_context"],
  icehockey_nhl: ["team_efficiency", "matchup_context"],
  basketball_wnba: ["team_efficiency", "matchup_context"],
  tennis_atp: ["tennis_rating", "tennis_surface", "tennis_form", "tennis_fatigue", "tennis_model"],
  tennis_wta: ["tennis_rating", "tennis_surface", "tennis_form", "tennis_fatigue", "tennis_model"],
};

/**
 * Re-scope a plan's retrieval steps onto the sport the question is actually in.
 *
 * classify() has forty-odd return statements and most of them are generic —
 * `attack`, `compare`, `price`, `historical`, `unknown`. Every one of those was
 * written when this product was a baseball desk, so every one of them asks for
 * pitchers and bullpens. Re-routing each of them per sport would mean sixty
 * more branches to keep in step; re-scoping the STEPS once, here, fixes all of
 * them together and keeps working when a new intent is added tomorrow.
 *
 * Baseball is returned untouched: the regression requirement is that the MLB
 * path behaves exactly as it did.
 */
/* WHICH SPORTS CLAIM EACH LAYER STEP, built from the tables above rather than
   restated. MLB_ONLY_STEPS caught the baseball half of this problem and only
   the baseball half: `quarterback` is an NFL layer and nothing stopped it
   reaching a basketball plan, so "How do the Lakers look tonight?" planned to
   retrieve a quarterback. A step named by at least one sport belongs to
   exactly the sports that name it; a step named by none is generic (`market`,
   `slate`, `rest`, `rankings`) and travels everywhere. */
const STEP_OWNERS: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  const own = (step: string, sport: string) => {
    const set = m.get(step) ?? new Set<string>();
    set.add(sport);
    m.set(step, set);
  };
  for (const st of MLB_ONLY_STEPS) own(st, "baseball_mlb");
  for (const [sport, steps] of Object.entries(SPORT_LAYER_STEPS)) for (const st of steps) own(st, sport);
  return m;
})();

export function scopeStepsToSport(steps: string[], sport: string | null): string[] {
  if (!sport || sport === "baseball_mlb") return steps.slice();
  const foreign = (st: string) => {
    const owners = STEP_OWNERS.get(st);
    return !!owners && !owners.has(sport);
  };
  const dropped = steps.filter(foreign);
  if (!dropped.length) return steps.slice();
  const kept = steps.filter((st) => !foreign(st));
  /* The replacement layer is added only when the plan asked for a matchup read
     in the first place — a pure price question keeps its narrow shape. */
  const out = kept.slice();
  for (const add of SPORT_LAYER_STEPS[sport] ?? []) if (!out.includes(add)) out.push(add);
  return out;
}

/**
 * Classify, then put the plan in the right sport.
 *
 * The raw classifier is unchanged and still the thing under test; this wrapper
 * only applies what the caller already knew. Without a hint it is a pass-through,
 * so every existing caller and every existing test keeps its exact behaviour.
 */
/* Intents that are ALREADY about one game. A plan carrying one of these needs
   no focusing — it is asking the right shape of question already. */
const ONE_GAME_INTENT = /(^|_)research_matchup$|^attack$|^price$|^what_changed$|^postmortem$|^full_research$|^matchup/;

/**
 * Make a plan be about the one game the context resolved.
 *
 * THIS IS THE REPORTED FAILURE, ONE LEAGUE OVER. "How does Texas State look
 * this week?" came back `intent = unknown` because no branch of the classifier
 * covered a single-team college question. The same holds today for every
 * league without its own intents: "What about the Bruins?" and "How do the
 * Liberty look?" classify as `unknown`, and "How do the Lakers look tonight?"
 * as `slate_overview` — a board-wide sweep answering a question about one
 * team. Fixing that league by league means a new branch every time a sport is
 * added, and the branch that is missing is always the one nobody thought of.
 *
 * So it is fixed once, where the fact is known: when the resolved context says
 * exactly one scheduled game is the subject and the plan is not about one
 * game, the plan is re-pointed at that game with the layers the sport owns. A
 * plan that is already single-game keeps its own shape, and a league with its
 * own intents — MLB, NFL, college — never reaches here with a board-wide plan
 * for a single-game question.
 */
export function focusPlanOnOneGame(plan: Plan, sport: string): Plan {
  if (ONE_GAME_INTENT.test(plan.intent)) return plan;
  if (plan.depth !== "SLATE" && plan.intent !== "unknown") return plan;
  const steps = [...new Set([
    "focus_signal", "market", "sharp_reference", "matchup",
    ...(SPORT_LAYER_STEPS[sport] ?? []),
  ])];
  return {
    ...plan,
    intent: "research_matchup", mode: "MATCHUP", depth: "DEEP", budget: 25,
    steps: scopeStepsToSport(steps, sport),
    why: `One scheduled game is the subject of this question, so it is researched as a matchup rather than `
      + `swept as a board. The classifier reached "${plan.intent}" from the wording alone, before the context `
      + `had resolved which game was meant.`,
  };
}

export function classify(question: string, mode?: string, hint?: ClassifyHint | null): Plan {
  const plan = classifyRaw(question, mode, hint);
  const sport = plan.sport ?? hint?.sport ?? sportOfIntent(plan.intent) ?? null;
  if (!sport) return plan;
  const scoped: Plan = { ...plan, sport, steps: scopeStepsToSport(plan.steps, sport) };
  return hint?.single_game ? focusPlanOnOneGame(scoped, sport) : scoped;
}

function classifyRaw(question: string, mode?: string, hint?: ClassifyHint | null): Plan {
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
    /* BUDGETS ARE SIZED FOR THE RETRIEVAL THAT ACTUALLY HAPPENS.
       These were set when a turn read the board and a feature table or two.
       Staged retrieval spends more and spends it better: stage A costs two
       reads (the published slate plus the database cross-check) before the
       market join, and stage C costs four batched reads plus a bounded roster
       fan-out. On the old STANDARD budget of 8 a college question ran out
       during stage C and reported records and season stats as missing — which
       was honest but wrong, because the data was there and the lookup never
       ran. "EdgeDesk did not look" and "the data is not there" are different
       answers with different fixes, and a budget that produces the first while
       printing the second is the worst of both.
       QUICK stays cheap on purpose: a price question needs the signal row and
       nothing else. */
    /* r13: three more than before, for the football artifacts a single-game
       turn now reads (the metrics file, the forecast, the NFL card). */
    budget: depth === "QUICK" ? 8 : depth === "STANDARD" ? 19 : depth === "DEEP" ? 25 : depth === "SLATE" ? 31 : 35,
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
  /* ONE MISSING BOUNDARY, ONE WRONG ANSWER. This was
     `/\bbet|bets|play|plays|edge|value|candidate\b/` — only the first and last
     alternatives were anchored, so `\bplay` matched the "play" inside
     "played" and the acceptance follow-up "Who have they played?" classified
     as a BETTING question. A question asking which opponents a team has
     already faced retrieved sharp references and a CLV history instead of the
     previous games it asked for. */
  const BET_WORD = /\b(bet|bets|betting|play|plays|playable|edge|value|candidate|candidates|worth a look)\b/;

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
    /* THE SPORT BLOCK ROUTES SPORT QUESTIONS, NOT EVERY QUESTION IN A SPORT.
       "What could make that lean wrong?" is a thesis attack whatever sport it
       is asked in, and it needs the attack retrieval — sharp reference, CLV
       history and prior sessions — which no per-sport branch asks for. These
       intents are therefore left to the generic classifier below; the wrapper
       re-scopes their steps onto the resolved sport, so they come back
       correctly routed without sixty duplicated branches. */
    /* Price questions are in this set for the same reason: "What price makes
       it a pass?" is answered from the price-sensitivity fields at QUICK depth
       in every sport, and routing it to a deep matchup read answers a question
       nobody asked while spending the budget to do it. */
    const GENERIC_WINS = /\b(talk me out|convince me|biggest risk|what would make|what could make|lean wrong|be wrong|falsif|reason not to|what are we missing|postmortem|what went wrong|how did we do|what price|at what price|break ?even|max playable|still playable|what do i need)\b/;
    const det = detectSport(raw);
    /* A CONTEXT THAT RESOLVED A REAL GAME OUTRANKS A WORD SEARCH.
       detectSport can only find a league word or a club that is unique in the
       curated registry — "Texas State" is neither, which is why this branch
       never fired for it and the question fell through to the baseball
       catch-all. When the caller has already resolved the matchup against a
       published card, that IS the sport, and it is better evidence than any
       regex over the sentence. */
    const sport = GENERIC_WINS.test(q) ? null : (hint?.sport ?? (det.confidence === "EXPLICIT" ? det.sport : null));
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
      if (BET_WORD.test(q)) {
        return SP("nfl_betting_candidate", "SLATE",
          base.concat(["sharp_reference", "clv_history", "memory"]),
          "NFL betting research — the deterministic engine still owns the verdict.");
      }
      if (hint?.single_game) {
        return SP("nfl_research_matchup", "DEEP", base.concat(["injuries", "sharp_reference"]),
          "One NFL game is the subject — research THAT matchup in depth rather than sweeping the card.");
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
      if (BET_WORD.test(q)) {
        return SP("cfb_betting_candidate", "SLATE", base.concat(["sharp_reference", "clv_history", "memory"]),
          "CFB betting research.");
      }
      /* ONE GAME IS NOT A CARD. "How does Texas State look this week?" names a
         single program, resolves to a single scheduled game, and used to be
         answered with a card-wide sweep — or, before the sport was corrected at
         all, with baseball. A resolved single game gets the deep per-matchup
         read: previous games, opponent quality, personnel and the market. */
      if (hint?.single_game) {
        return SP("cfb_research_matchup", "DEEP", base.concat(["cfb_sp_plus", "sharp_reference"]),
          "One college football game is the subject — research THAT matchup in depth rather than sweeping the card.");
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
      if (BET_WORD.test(q)) {
        return SP("cbb_betting_candidate", "SLATE", base.concat(["sharp_reference", "clv_history", "memory"]),
          "CBB betting research.");
      }
      if (hint?.single_game) {
        return SP("cbb_research_matchup", "DEEP", base.concat(["availability", "sharp_reference"]),
          "One college basketball game is the subject — research THAT matchup rather than sweeping the card.");
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

  /* "What could make that lean wrong?" is the acceptance question and it is a
     thesis attack in plain English. It matched none of these and fell through
     to the catch-all, so the one question that asks for the counterargument
     retrieved no sharp reference and no market history. */
  if (has("attack", "challenge", "talk me out", "convince me not", "convince me", "biggest risk",
          "what would make", "what could make", "lean wrong", "be wrong", "get this wrong",
          "why not", "falsif", "reason not to", "every reason", "blind to", "what are we missing"))
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
  /* ATTENTION AND PROFILE. "Separate the lower-profile games from the
     nationally prominent ones" is a slate question about the whole card, and it
     had no intent at all — it fell through to `unknown` at STANDARD depth, which
     researched three games thinly and answered a card-wide question from them.
     It is a SLATE sweep, and the attention tiers it needs are computed over the
     whole index rather than over a shortlist. */
  if (/\b(lower|low|small|smaller|little)[- ]?(profile|attention|market|known)\b/.test(q)
    || /\b(high|big|large|national|nationally)[- ]?(profile|attention|prominent|prominence)\b/.test(q)
    || /\b(separate|split|group|divide|contrast)\b[\s\S]{0,40}\b(profile|attention|prominent|marquee|primetime)\b/.test(q)
    || has("marquee", "under the radar", "off the radar", "overlooked games"))
    return P("attention_split", "SLATE",
      ["slate", "cfb_intelligence", "team_efficiency", "matchup_context", "market"],
      "Attention categories across the whole card — an editorial grouping, computed over every game, never a claim about how softly anything is priced.");

  if (has("slate", "today", "tonight", "board", "card"))
    return P("slate_overview", "SLATE", ["slate", "market", "matchup", "pitchers", "pitcher_features", "opponent_offense", "team_efficiency", "quarterback", "matchup_context", "park"], "Board-level overview.");

  return P("unknown", "STANDARD", ["slate", "focus_signal", "market", "matchup", "pitcher_features", "opponent_offense"], "Unclassified — retrieve the board, the matchup layer and any focused signal, then answer from what is there.");
}


/* ========================================================================
   THE SHARED GAME REPOSITORY — types and normalizers.

   One normalized game shape, whatever source produced it, so the eligibility
   rules, the evidence builder and the prompt all speak about the same object.
   A field a source does not carry stays null; nothing is inferred to fill a
   column, because a filled column is indistinguishable from an observed one
   three layers downstream.
   ======================================================================== */

export interface SlateGame {
  /** The board's own id where there is one — ESPN/cfbfastR for CFB. */
  game_id: string;
  /** The ingested CollegeFootballData id, when identity resolved to one. */
  cfb_game_id: string | null;
  source: string;
  season: number | null;
  week: number | null;
  kickoff: string | null;
  home_team: string;
  away_team: string;
  home_id: string | null;
  away_id: string | null;
  home_conference: string | null;
  away_conference: string | null;
  home_group: string | null;
  away_group: string | null;
  neutral_site: boolean | null;
  venue: string | null;
  matchup: string;
  status: string;
  /** Poll rank, where a poll ranks them. An ATTENTION input, never a quality one. */
  home_rank?: number | null;
  away_rank?: number | null;
  /** The resolved market: a line, a price, or neither — kept apart. */
  market?: any;
  /** A number to compare a model against. What the FBS board counts. */
  has_market_line?: boolean;
  /** A real book price that could be bet into. Always the smaller count. */
  has_executable_price?: boolean;
  /** The board engine's own projection, carried verbatim and never recomputed. */
  model_home_line: number | null;
  model_total: number | null;
  model_status: string | null;
  model_completeness: number | null;
  /** r12: carried from the artifact where it publishes them; never recomputed. */
  model_home_win_prob?: number | null;
  model_home_margin?: number | null;
  model_version?: string | null;
  /** r13: the NFL artifact's own context, verbatim. */
  outcome_range?: { p10: number; p50: number; p90: number; sigma?: number; basis?: string; unit?: string } | null;
  contributions?: { spread?: { key: string; value: number | null; points: number | null }[]; total?: any[] } | null;
  home_rest?: number | null;
  away_rest?: number | null;
  roof?: string | null;
  surface?: string | null;
  div_game?: boolean | null;
  home_starter?: any | null;
  away_starter?: any | null;
  model_generated_at?: string | null;
  data_quality?: any | null;
  /** Slice 3: the NFL build publishes the engine's cover curve and its one-input-changed scenarios with the row. */
  cover_curve?: any[] | null;
  scenarios?: any | null;
  /** the NFL build's reference number (nflverse consensus close): a comparison, never a price */
  reference_market?: any | null;
  /** The market, joined ON to the schedule rather than standing in for it. */
  quote: {
    event_id: string; market: string; selection: string; point: number | null;
    dec: number | null; book: string | null; captured_at: string | null;
  } | null;
  has_quote: boolean;
  has_signal: boolean;
  signals: any[];
}

export interface SlateScopeRequest {
  season?: number | null;
  week?: number | null;
  label?: string | null;
  /** Conference / group filters the board had applied, echoed back. */
  conferences?: string[] | null;
  group?: string | null;
  /** Explicit ids the board wants scoped to, when the user is on a filter. */
  game_ids?: string[] | null;
}

export interface SlateIndexResult {
  index: SlateGame[];
  state: any;
  source: string | null;
  source_label: string;
  scope_label: string;
  path: Record<string, unknown>;
  errors: string[];
}

/** The published FBS slate row -> the shared shape. Field names are the
    artifact's own (schema edgedesk_fbs_slate_v1); nothing is renamed by guess. */
export function normalizeFbsArtifactGame(g: any, meta: any): SlateGame {
  return {
    game_id: String(g.game_id),
    cfb_game_id: null,
    source: "football/fbs/slate.json",
    season: num(g.season) ?? num(meta?.season),
    week: num(g.week),
    kickoff: g.kickoff ?? null,
    home_team: String(g.home_team ?? ""),
    away_team: String(g.away_team ?? ""),
    home_id: g.home_team_id ?? null,
    away_id: g.away_team_id ?? null,
    home_conference: g.home_conference ?? null,
    away_conference: g.away_conference ?? null,
    home_group: g.home_fbs_group ?? null,
    away_group: g.away_fbs_group ?? null,
    neutral_site: g.neutral_site === true,
    venue: g.venue ?? null,
    matchup: `${g.away_team} @ ${g.home_team}`,
    status: "scheduled",
    /* The artifact publishes the model line from the HOME side, negative for a
       home favourite, exactly as engine.js emits it. Carried verbatim: this
       layer does not recompute a projection and does not change its sign. */
    model_home_line: num(g.model_home_line),
    model_total: num(g.model_fair_total),
    model_status: g.model_status ?? null,
    model_completeness: num(g.data_completeness),
    model_home_win_prob: num(g.model_home_win_prob),
    model_home_margin: num(g.model_home_margin),
    /* The engine that produced the number, as the artifact names it. The
       slate meta versions the UNIVERSE build; the engine's own version rides
       on the row when the builder writes it, and the shadow row names the
       engine family otherwise. */
    model_version: g.model_version ?? (typeof g.shadow_model_version === "string" && /cfb_p4/.test(g.shadow_model_version)
      ? "edgedesk_cfb_p4 (via " + String(meta?.version ?? "slate") + ")" : (meta?.version ?? null)),
    quote: null, has_quote: false, has_signal: false, signals: [],
  };
}

/** An NFL slate artifact row -> the shared shape. The artifact is the browser's
    own projection run through the same module in Node; every field is carried
    verbatim and nothing is recomputed. */
export function normalizeNflArtifactGame(g: any, meta: any): SlateGame {
  return {
    game_id: String(g.game_id),
    cfb_game_id: null,
    source: "football/nfl/slate.json",
    season: num(g.season) ?? num(meta?.season),
    week: num(g.week),
    kickoff: g.kickoff ?? null,
    home_team: String(g.home_team ?? g.home_code ?? ""),
    away_team: String(g.away_team ?? g.away_code ?? ""),
    /* lowercase club codes, the keys NFL_ALIASES and the board's resolver use */
    home_id: g.home_team_id ?? (g.home_code ? String(g.home_code).toLowerCase() : null),
    away_id: g.away_team_id ?? (g.away_code ? String(g.away_code).toLowerCase() : null),
    home_conference: null, away_conference: null, home_group: null, away_group: null,
    neutral_site: false,
    venue: g.venue ?? null,
    matchup: `${g.away_team ?? g.away_code} @ ${g.home_team ?? g.home_code}`,
    status: "scheduled",
    model_home_line: num(g.model_home_line),
    model_total: num(g.model_fair_total),
    model_status: g.model_status ?? null,
    model_completeness: null,
    model_home_win_prob: num(g.model_home_win_prob),
    model_home_margin: num(g.model_home_margin),
    model_version: g.model_version ?? meta?.engine?.model_version ?? null,
    model_generated_at: meta?.generated_at ?? null,
    outcome_range: g.outcome_range ?? null,
    contributions: g.contributions ?? null,
    home_rest: num(g.home_rest), away_rest: num(g.away_rest),
    roof: g.roof ?? null, surface: g.surface ?? null, div_game: g.div_game == null ? null : !!g.div_game,
    home_starter: g.home_starter ?? null, away_starter: g.away_starter ?? null,
    data_quality: g.data_quality ?? null,
    cover_curve: Array.isArray(g.cover_curve) ? g.cover_curve : null,
    scenarios: g.scenarios && typeof g.scenarios === "object" ? g.scenarios : null,
    reference_market: g.reference_market && typeof g.reference_market === "object" ? g.reference_market : null,
    quote: null, has_quote: false, has_signal: false, signals: [],
  };
}

/** A cfb.games row -> the shared shape. */
export function normalizeCfbGameRow(g: any): SlateGame {
  return {
    game_id: String(g.game_id),
    cfb_game_id: String(g.game_id),
    source: "cfb.games",
    season: num(g.season), week: num(g.week),
    kickoff: g.start_date ?? null,
    home_team: String(g.home_team ?? ""), away_team: String(g.away_team ?? ""),
    home_id: g.home_id != null ? String(g.home_id) : null,
    away_id: g.away_id != null ? String(g.away_id) : null,
    home_conference: g.home_conference ?? null, away_conference: g.away_conference ?? null,
    home_group: null, away_group: null,
    neutral_site: g.neutral_site === true, venue: g.venue ?? null,
    matchup: `${g.away_team} @ ${g.home_team}`,
    status: g.completed === true ? "final" : "scheduled",
    model_home_line: null, model_total: null, model_status: null, model_completeness: null,
    quote: null, has_quote: false, has_signal: false, signals: [],
  };
}

/**
 * Which side of a spread a selection sits on, and what the handicap MEANS.
 *
 * The orientation bug this guards against is the quietest one in the product:
 * a model line stated from the home side compared against a book handicap
 * stated on the named selection produces a gap that is wrong by twice the
 * line, and every sentence built on it reads perfectly. Both numbers are put
 * on the SAME side here, once, and the side is named in the output.
 */
export function orientToSelection(o: {
  selection: string; home_team: string; away_team: string;
  point: number | null; model_home_line: number | null;
}): {
  side: "home" | "away" | null;
  selection_handicap: number | null;
  model_selection_line: number | null;
  market_selection_line: number | null;
  note: string;
} {
  const sel = normName(o.selection), h = normName(o.home_team), a = normName(o.away_team);
  let side: "home" | "away" | null = null;
  if (sel && h && sel === h) side = "home";
  else if (sel && a && sel === a) side = "away";
  else if (sel && h.endsWith(" " + sel) && !a.endsWith(" " + sel)) side = "home";
  else if (sel && a.endsWith(" " + sel) && !h.endsWith(" " + sel)) side = "away";
  if (!side) {
    return { side: null, selection_handicap: null, model_selection_line: null, market_selection_line: null,
      note: `"${o.selection}" could not be resolved to either side of ${o.away_team} @ ${o.home_team}, so no orientation is asserted.` };
  }
  const point = num(o.point);
  const mhl = num(o.model_home_line);
  /* The model line is published from the home side. Flipping it for an away
     selection is a sign change and nothing else — but it is the sign change
     that makes the comparison legitimate. */
  const modelSel = mhl == null ? null : (side === "home" ? mhl : -mhl);
  return {
    side,
    selection_handicap: point,
    model_selection_line: modelSel == null ? null : +modelSel.toFixed(2),
    market_selection_line: point,
    note: `${o.selection} is the ${side} side. Both the model line and the book handicap are stated from that side, `
      + `so a favourite is negative in both. ${modelSel != null && point != null
        ? `Model ${modelSel.toFixed(1)} against a book ${point > 0 ? "+" : ""}${point}.`
        : "One of the two numbers is missing, so no gap is computed."}`,
  };
}


/* ========================================================================
   STAGE B — DETERMINISTIC ELIGIBILITY AND RESEARCH PRIORITY.

   Runs over the compact slate index, before a single detailed read. It is
   pure code over owned fields: no model, no language, no probability. What it
   produces is an ORDER and an ELIGIBILITY, and those are different things —
   a game can be the most interesting thing on the card and still be ineligible
   for a recommendation because nobody is quoting it.
   ======================================================================== */

export interface ShortlistRow {
  game: SlateGame;
  eligible: boolean;
  ineligible_reason: string | null;
  researchable: boolean;
  market_status: string;
  priority: number;
  priority_band: "HIGH" | "MEDIUM" | "LOW";
  drivers: { points: number; why: string }[];
  attention: any;
  disagreement: any | null;
  quote_state: any | null;
}

export function rankSlate(index: SlateGame[], opts: { now?: number; sport?: string | null } = {}): ShortlistRow[] {
  const now = opts.now ?? Date.now();
  return index.map((g) => {
    const drivers: { points: number; why: string }[] = [];
    let score = 0;
    const add = (n: number, why: string) => { score += n; drivers.push({ points: n, why }); };

    const attention = EDINTEL.attentionTier({
      home_group: g.home_group, away_group: g.away_group,
      home_rank: g.home_rank, away_rank: g.away_rank,
      neutral_site: g.neutral_site,
      book_count: g.signals.length ? num(g.signals[0].n_books) : null,
    });

    /* The market side, where one exists. */
    const q = g.quote;
    const quoteState = q
      ? EDINTEL.quoteState({ captured_at: q.captured_at, market: q.market, kickoff: g.kickoff })
      : null;

    /* Model versus market, oriented onto the SAME side before it is measured.
       An unoriented comparison is wrong by twice the line and reads perfectly,
       which is why the orientation is computed rather than assumed. */
    let disagreement: any = null;
    const spread = g.signals.find((r: any) => EDINTEL.normMarket(r.market) === "spreads" && num(r.point) != null);
    if (spread && g.model_home_line != null) {
      const o = orientToSelection({
        selection: String(spread.selection ?? ""), home_team: g.home_team, away_team: g.away_team,
        point: num(spread.point), model_home_line: g.model_home_line,
      });
      if (o.model_selection_line != null && o.market_selection_line != null) {
        disagreement = EDINTEL.disagreementDiagnostics({
          model_line: o.model_selection_line, market_line: o.market_selection_line, market: "spreads",
        });
        disagreement.orientation = o;
      }
    }

    /* ---- ELIGIBILITY. A recommendation needs a live, priced market. ------
       Three states, not two. A game can carry a market NUMBER — a consensus
       line from cfb.lines, with no book, no per-side odds and no timestamp —
       which makes it fully researchable and comparable against the model, and
       still leaves nothing to bet into. Collapsing that into "no market" is
       what made a forty-six-game board read as one. */
    let eligible = true, reason: string | null = null;
    const mk = (g as any).market ?? null;
    const hasLine = mk ? mk.has_market_line : g.has_quote;
    const hasPrice = mk ? mk.has_executable_price : g.has_quote;
    /* HAS THIS GAME STARTED? `status === "final"` caught only the games a feed
       had already marked over, which left the whole window in between — a game
       kicked off forty minutes ago, being watched right now — eligible for a
       recommendation off a pregame price. EdgeDesk ingests no in-game price,
       score or clock, so there is nothing it could be recommending except a
       number from before the game began. */
    const gs = EDINTEL.gameState({ kickoff: g.kickoff ?? null, status: g.status ?? null, now });
    if (!gs.may_recommend && gs.state !== "UNKNOWN") {
      eligible = false;
      reason = gs.state === "FINAL" ? "the game is already final"
        : "this game is already being played, and EdgeDesk holds no in-game price — everything on file for it "
          + "describes the game before kickoff";
    } else if (!hasLine) { eligible = false; reason = "no source EdgeDesk reads carries a market number for this game — not a captured price, not a consensus line"; }
    else if (!hasPrice) {
      eligible = false;
      reason = "this game carries a consensus market LINE but no executable price. It can be researched and "
        + "compared against the model; there is no book, no per-side odds and no capture time, so there is "
        + "nothing to recommend at a price";
    } else if (quoteState && !quoteState.actionable) {
      eligible = false;
      reason = `the only price on file is ${quoteState.status.toLowerCase()} (${quoteState.age_min}m old against a ${quoteState.limit_min}m limit), so nothing here is actionable until it refreshes`;
    }

    /* ---- PRIORITY. Which games repay attention, eligible or not. --------- */
    if (disagreement && disagreement.level === "LARGE") add(3, `the board's model and the market disagree by ${disagreement.gap} points`);
    if (disagreement && disagreement.level === "EXTREME") add(2, `a ${disagreement.gap}-point disagreement, large enough to suspect a data fault rather than value`);
    if (g.has_signal) add(3, "EdgeDesk has flagged a priced signal on this game");
    else if (hasPrice) add(1, "the game carries an executable price but nothing has been flagged on it");
    else if (hasLine) add(1, "the game carries a consensus market line to compare the model against");
    if (quoteState && quoteState.status === "STALE") add(1, `the only quote is ${quoteState.age_min} minutes old; a refresh would settle whether anything here is live`);
    if (attention.tier === "NATIONAL") add(1, "a nationally prominent matchup, so the market is likely to be well attended");
    if (g.model_completeness != null && g.model_completeness < 0.5) {
      add(1, `the board's own input completeness for this game is ${Math.round(g.model_completeness * 100)}%, so its projection is thin`);
    }
    if (g.kickoff) {
      const hrs = (Date.parse(g.kickoff) - now) / 3600000;
      if (Number.isFinite(hrs) && hrs > 0 && hrs < 48) add(1, "kicks off inside 48 hours, so the market is at its most informative");
    }

    return {
      game: g, eligible, ineligible_reason: reason,
      /* Separate from eligibility on purpose: a line-only game is fully
         researchable and is exactly what a college card is mostly made of. */
      researchable: hasLine,
      market_status: mk ? mk.market_status : (g.has_quote ? "PRICED" : "NO MARKET"),
      priority: score,
      priority_band: score >= 6 ? "HIGH" : score >= 3 ? "MEDIUM" : "LOW",
      drivers, attention, disagreement, quote_state: quoteState, game_state: gs,
    };
  }).sort((a, b) => {
    /* Eligible games first — a recommendation can only come from one — then by
       priority. Within a tie, the earlier kickoff, because it decides sooner. */
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(a.game.kickoff ?? "").localeCompare(String(b.game.kickoff ?? ""));
  });
}

/** The scope sentence an answer must open with, built from the ranking. */
export function scopeSentence(index: SlateGame[], ranked: ShortlistRow[], scopeLabel: string, sourceLabel: string, shortlisted: number): string {
  const eligible = ranked.filter((r) => r.eligible).length;
  const quoted = index.filter((g) => g.has_quote).length;
  return `Scope: ${scopeLabel}. ${index.length} game${index.length === 1 ? "" : "s"} on the card from ${sourceLabel}; `
    + `${quoted} carr${quoted === 1 ? "ies" : "y"} a captured quote; ${eligible} ${eligible === 1 ? "is" : "are"} eligible for a priced recommendation; `
    + `${shortlisted} received detailed research. Refreshed ${new Date().toISOString()}.`;
}


/* ========================================================================
   THE DECISION PASS — deterministic, one per quoted selection.

   Every number here was computed by EDINTEL or copied from the pipeline. The
   model never sees this function's inputs and never produces its outputs; it
   explains what this decided, and if it disagrees with the decision it is
   wrong by construction.
   ======================================================================== */

export interface GameDecision {
  game_id: string;
  matchup: string;
  kickoff: string | null;
  market: string;
  selection: string;
  handicap: number | null;
  side: "home" | "away" | null;
  decision: string;
  strength: string | null;
  why: string;
  blockers: string[];
  price: any;
  gates: any;
  model: any;
  disagreement: any;
  what_would_change_it: string[];
  experimental: boolean;
  attention: any;
  evidence_gaps: { field: string; why: string }[];
  evidence_packet_id: string | null;
  research_priority: any;
  /** The capture's own key for the priced signal, so a record can be graded against its close. */
  sig_key?: string | null;
  /** When the decided price was last seen by capture. */
  quote_captured_at?: string | null;
}

export function decideSlate(
  ranked: ShortlistRow[], packets: any[], opts: { sport: string | null; now?: number } = { sport: null },
): GameDecision[] {
  const now = opts.now ?? Date.now();
  const packetBy = new Map<string, any>();
  for (const p of packets ?? []) packetBy.set(String(p.game_id), p);
  const out: GameDecision[] = [];

  for (const r of ranked) {
    const g = r.game;
    if (!g.signals.length) continue;
    for (const sig of g.signals) {
      const market = EDINTEL.normMarket(sig.market);
      const fair = EDINTEL.fairMethod(sig);
      const conf = EDINTEL.confirmationRead(sig);
      const qs = EDINTEL.quoteState({ captured_at: sig.last_seen_at, market: sig.market, kickoff: g.kickoff });
      const orient = orientToSelection({
        selection: String(sig.selection ?? ""), home_team: g.home_team, away_team: g.away_team,
        point: num(sig.point), model_home_line: g.model_home_line,
      });
      const validation = EDINTEL.validationFor(opts.sport, market);

      /* The model's number, oriented onto the same side as the book's. A
         disagreement measured across two different sides is wrong by twice the
         line and reads perfectly, which is why the orientation is explicit. */
      let disagreement: any = null;
      if (orient.model_selection_line != null && orient.market_selection_line != null && market === "spreads") {
        disagreement = EDINTEL.disagreementDiagnostics({
          model_line: orient.model_selection_line, market_line: orient.market_selection_line, market,
        });
        disagreement.orientation = orient;
      } else if (market === "totals" && g.model_total != null && num(sig.point) != null) {
        disagreement = EDINTEL.disagreementDiagnostics({
          model_line: g.model_total, market_line: num(sig.point), market,
        });
      }

      /* Does the THESIS rest on the model? It does when the model is the only
         thing arguing for this side — a large disagreement with no independent
         market case. That distinction is what routes it through the validation
         gate, which for CFB spreads caps it at WATCH however big the gap. */
      const thesisRestsOnModel = !!(disagreement && disagreement.level !== "ORDINARY" && !fair.sharp);

      /* WHAT A DECISION ACTUALLY REQUIRES DEPENDS ON WHAT THE THESIS RESTS ON.
         A market thesis — a reference book's own de-vigged price, beaten at a
         real book — is complete without any matchup evidence at all: the
         evidence IS the market. Requiring a matchup packet for it blocked a
         perfectly sound price edge with "matchup_evidence missing" and turned
         a price question into an INSUFFICIENT DATA answer about a slate.
         A MODEL thesis is the opposite: the model is making a claim about the
         football, so the football inputs are required and their absence is a
         genuine blocker. */
      const required_missing: { field: string; why: string }[] = [];
      const soft_gaps: { field: string; why: string }[] = [];
      const pkt = packetBy.get(String(g.game_id));
      if (!pkt) {
        (thesisRestsOnModel ? required_missing : soft_gaps).push({
          field: "matchup_evidence",
          why: "this game was not researched in depth on this turn"
            + (thesisRestsOnModel
              ? ", and this thesis rests on the model's read of the football rather than on a market price, so the matchup inputs are required"
              : ". The thesis rests on the market price, which is complete without it — but the matchup was not examined and the answer should say so."),
        });
      } else {
        const m = pkt.sections?.matchup;
        for (const side of ["home", "away"] as const) {
          if (m?.[side]?.sp_plus_overall?.missing && m?.[side]?.previous_games?.missing) {
            (thesisRestsOnModel ? required_missing : soft_gaps).push({
              field: `${side}_team_quality`,
              why: `neither an opponent-adjusted rating nor a completed game is on file for ${m?.[side]?.team?.value ?? side}`,
            });
          }
        }
      }

      const d = EDINTEL.decide({
        fair, confirmation: conf, quote_state: qs,
        quote: { dec: num(sig.best_dec), book: sig.best_book, market: sig.market,
          selection: sig.selection, handicap: num(sig.point) },
        game_status: g.status, validation, disagreement,
        thesis_rests_on_model: thesisRestsOnModel,
        required_missing,
        edge_remaining: (num(sig.first_edge) && num(sig.edge) != null && num(sig.first_edge)! > 0)
          ? Math.max(0, Math.min(1, num(sig.edge)! / num(sig.first_edge)!)) : null,
        model: (orient.model_selection_line != null || g.model_total != null)
          ? { line: market === "totals" ? g.model_total : orient.model_selection_line, market }
          : null,
        push_distribution_key: opts.sport ? `${opts.sport}|margin_resid` : null,
      });

      out.push({
        game_id: g.game_id, matchup: g.matchup, kickoff: g.kickoff,
        market, selection: String(sig.selection ?? ""), handicap: num(sig.point), side: orient.side,
        decision: d.decision, strength: d.strength, why: d.why, blockers: d.blockers,
        price: d.price, gates: d.gates, model: d.model, disagreement: d.disagreement,
        what_would_change_it: d.what_would_change_it, experimental: d.experimental,
        attention: r.attention,
        /* Gaps that do NOT block this decision but that the answer must still
           name. An unstated gap reads as a considered-and-dismissed factor. */
        evidence_gaps: soft_gaps,
        evidence_packet_id: pkt ? pkt.packet_id : null,
        research_priority: { score: r.priority, band: r.priority_band, drivers: r.drivers },
        sig_key: (sig as any).sig_key ?? null,
        /* the capture time of the price that was decided on; the freshness
           gate carries the verdict, this carries the observation */
        quote_captured_at: sig.last_seen_at ?? null,
      });
    }
  }
  /* Candidates first, then watches, then the rest. Within a tier, by expected
     return — which is a RANKING of already-decided rows, not a new number. */
  const rank: Record<string, number> = { "BET CANDIDATE": 0, WATCH: 1, PASS: 2, "INSUFFICIENT DATA": 3 };
  return out.sort((a, b) => {
    const ra = rank[a.decision] ?? 9, rb = rank[b.decision] ?? 9;
    if (ra !== rb) return ra - rb;
    return (num(b.price?.market_ev) ?? -99) - (num(a.price?.market_ev) ?? -99);
  });
}

/**
 * The ledger rows a turn would publish.
 *
 * BUILT, not written: the caller decides whether to persist. Only an
 * ACTIONABLE decision is publishable — a PASS is a real answer and worth
 * recording, but a row whose price was never live is not a recommendation and
 * must not enter a record that is later measured as though it were.
 */
export function ledgerRowsFor(
  decisions: GameDecision[], ctx: { sport: string | null; model_version?: string | null; engine_version?: string | null; now?: number },
): any[] {
  const now = ctx.now ?? Date.now();
  const rows: any[] = [];
  for (const d of decisions) {
    /* A switched-off decision layer produced no decision, so there is nothing
       to track. Publishing a row here would put a shutdown on the record as
       though the desk had weighed the selection. */
    if (!d.decision || (d as any).decisions_enabled === false) continue;
    if (d.decision === "INSUFFICIENT DATA") continue;
    if (!d.price || d.price.offered_decimal == null) continue;
    const e = EDINTEL.ledgerEntry({
      sport: ctx.sport, game_id: d.game_id, matchup: d.matchup, kickoff: d.kickoff,
      market: d.market, selection: d.selection, handicap: d.handicap,
      odds_decimal: d.price.offered_decimal, book: d.price.book,
      /* gates.freshness never carried the capture time, so every ledger row
         recorded null here; the decision now carries it explicitly */
      quote_captured_at: (d as any).quote_captured_at ?? d.gates?.freshness?.captured_at ?? null,
      decision: d.decision, strength: d.strength,
      probability: d.price.fair_probability,
      probability_source: d.price.fair_label,
      expected_value: d.price.market_ev,
      price_limit_american: d.price.price_limit_american,
      evidence_version: d.evidence_packet_id,
      evidence_packet_id: d.evidence_packet_id,
      model_version: ctx.model_version ?? null,
      engine_version: ctx.engine_version ?? BUILD,
      decision_config: d.gates ? { ...(d as any).config_used ?? {} } : null,
      mode: "FORWARD", now,
    });
    if (e.ok) rows.push(e);
  }
  return rows;
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
  /** The fetch this layer reads with — the test harness's when one was injected. */
  fetchImpl(): typeof fetch { return this.f; }
  calls = 0;
  budget: number;
  mlbFallback: boolean;
  private callerKey: string;
  /* One availability read per request, memoised: every packet in a slate answer
     wants the same artifact and re-fetching it per game would spend the whole
     research budget on one file. */
  private _avail: { meta: any; byTeam: Map<string, any>; error: string | null } | null = null;
  private _fbs: { meta: any; games: any[]; error: string | null } | null = null;
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
      + "sharp_fair,sharp_book_fair,consensus_fair,edge,first_edge,n_books,n_books_eff,has_sharp,corrob_n,pin_dec,pin_opp_dec,"
      + "reference_type,qual_tier,qual_reason,quality_score,fresh_books,flagged_at,flagged_edge,flagged_best_dec,flagged_best_book,"
      + "home_team,away_team,commence_time,first_seen_at,last_seen_at,clv,beat_close,result,graded_at,closing_sharp_fair"
      /* FLAGGED ONLY. This is the board, so it reads what the board reads. */
      + `&flagged_at=not.is.null&flagged_best_dec=not.is.null`
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
    /* BOTH guards, and the second is not redundant. The `flagged_at IS NULL`
       guard on capture's freeze means a row flagged by an OLDER build stays
       flagged permanently — the same rule that stops an entry price drifting
       also preserves a bad historical flag forever. app.html carries this exact
       pair for this exact reason. */
    const _clean = rows.filter((r: any) => {
      if (!signalIsActionable(r)) { _drop.push("not a qualified EdgeDesk signal (no frozen entry)"); return false; }
      const t = signalTradeable(r); if (!t.ok) _drop.push(t.reason!); return t.ok;
    });
    const _dropped = rows.length - _clean.length;
    const _why = Array.from(new Set(_drop)).slice(0, 4).join("; ");
    rows = _clean;
    if (!rows.length) {
      return { rows: [], ev: [unavailable("signals", "slate",
        `all ${_dropped} signal rows in the window failed the tradeable bound (${_why}). `
        + `That is a capture problem, not an empty board — do not describe the slate as quiet.`)] };
    }
    /* THE TOP ROW OF THIS LIST BECOMES THE ENGINE'S CANDIDATE for a "what should
       I bet" question, and the list is ordered by edge descending with nulls
       last. With no sign filter, a slate where every qualified signal has since
       gone negative still promoted its least-negative row to candidate. A
       qualified signal whose LIVE edge has gone negative is a signal whose price
       has moved past the point of being worth taking; it stays in `rows` as
       context and is marked, so the engine can say the edge is gone rather than
       recommending it. */
    rows = rows.map((r: any) => ({ ...r, edge_still_positive: Number(r.edge) > 0 }));
    const positives = rows.filter((r: any) => r.edge_still_positive);
    if (!positives.length) {
      return { rows, ev: [unavailable("signals", "slate",
        `${rows.length} qualified signal(s) are on the board but every one has moved to a non-positive edge at `
        + `the current price. The scan ran and the board is not broken — the prices have moved. Do not present `
        + `any of these as a live opportunity.`)] };
    }
    rows = positives.concat(rows.filter((r: any) => !r.edge_still_positive));

    /* THE ANCHOR AND THE CLOCK TRAVEL WITH EVERY ROW.
       A raw signal row carries `sharp_fair` — a column capture fills from the
       CONSENSUS whenever no reference book quotes — so handing the row over
       unannotated invites exactly the claim this repair removes. The honest
       method and the quote's age are attached here, once, so no downstream
       reader has to re-derive either. */
    const out = rows.map((r) => {
      const fm = EDINTEL.fairMethod(r);
      const qs = EDINTEL.quoteState({ captured_at: r.last_seen_at, market: r.market, kickoff: r.commence_time });
      return ev({
        source: "signals", entity: `${r.away_team} @ ${r.home_team}`, field: "signal",
        value: {
          ...r,
          fair_method: fm.method, fair_label: fm.label, fair_is_sharp: fm.sharp,
          fair_sentence: fm.sentence, reference_book: fm.reference_book,
          contributing_reference_quotes: fm.contributing_quotes,
          quote_status: qs.status, quote_age_min: qs.age_min, quote_actionable: qs.actionable,
          quote_note: qs.why,
        },
        status: "VERIFIED", relevance: "market",
        source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
        note: `${fm.sentence} ${qs.why}`
          + (qs.actionable ? "" : " This price is NOT actionable; it is the last one EdgeDesk observed."),
      });
    });
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


  /* ==================================================================== */
  /* THE SLATE REPOSITORY — one authoritative answer to "what games exist" */
  /*                                                                       */
  /* THE FAILURE THIS EXISTS TO END                                        */
  /*   The FBS board renders 75 games and Intelligence answered "there are */
  /*   no CFB matchups to evaluate on this slate". Both statements were    */
  /*   produced from owned data, and neither was lying — they were reading */
  /*   DIFFERENT REPOSITORIES. The board builds its universe in the        */
  /*   browser from the cfbfastR schedule feed through football/fbs/fbs.js */
  /*   and publishes it as football/fbs/slate.json. Intelligence asked the */
  /*   `signals` table, which holds PRICED FLAGGED OPPORTUNITIES and holds */
  /*   nothing at all for a sport nobody has flagged this week. An empty   */
  /*   signals query became "no games", and 75 real matchups disappeared.  */
  /*                                                                       */
  /* WHAT THIS DOES INSTEAD                                                */
  /*   Games are discovered from a SCHEDULE source, always, before any     */
  /*   question about prices is asked. Quotes and signals are then joined  */
  /*   ONTO that universe and counted separately, so "no game", "no quote" */
  /*   and "no signal" can never again collapse into one sentence.         */
  /*                                                                       */
  /*   The board's own published artifact is the primary source for CFB    */
  /*   precisely because it IS what the board renders: same builder, same  */
  /*   identities, same game ids. cfb.games is read alongside it as a      */
  /*   cross-check, and a disagreement between them is reported as a data  */
  /*   fault rather than silently resolved in favour of whichever answered */
  /*   first.                                                              */
  /* ==================================================================== */

  /**
   * The FBS slate artifact the board publishes.
   *
   * Static, versioned, and the same bytes the browser renders. Read over HTTP
   * rather than from the database because that is where it lives — it is a
   * build output committed to the site, not a table.
   */
  async getFbsSlateArtifact(): Promise<{ meta: any; games: any[]; error: string | null }> {
    /* Memoised for the same reason the availability read is: the sport probe,
       the slate index and the cross-check all want this one file, and paying
       for it three times would spend the research budget on one artifact. */
    if (this._fbs) return this._fbs;
    if (this.calls >= this.budget) return { meta: null, games: [], error: "research budget exhausted before the slate artifact could be read" };
    this.calls++;
    const url = `${SITE_BASE.replace(/\/+$/, "")}/football/fbs/slate.json`;
    const t0 = Date.now();
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 9000) : null;
      const r = await this.f(url, { signal: ctrl?.signal, headers: { accept: "application/json" } });
      if (timer) clearTimeout(timer);
      if (!r.ok) {
        const err = `HTTP ${r.status} from ${url}`;
        this.log.push({ table: "fbs/slate.json", ms: Date.now() - t0, rows: 0, error: err });
        this.note("fbs/slate.json", false, err);
        return (this._fbs = { meta: null, games: [], error: err });
      }
      const j = await r.json();
      const games = Array.isArray(j?.games) ? j.games : [];
      this.log.push({ table: "fbs/slate.json", ms: Date.now() - t0, rows: games.length, error: null });
      this.note("fbs/slate.json", true, null, games.length);
      return (this._fbs = { meta: j, games, error: null });
    } catch (e) {
      const err = String((e as Error)?.message ?? e);
      this.log.push({ table: "fbs/slate.json", ms: Date.now() - t0, rows: 0, error: err });
      this.note("fbs/slate.json", false, err);
      return (this._fbs = { meta: null, games: [], error: err });
    }
  }

  /**
   * football/availability/current.json — the college availability layer.
   *
   * SAME TRANSPORT AS THE SLATE, for the same reason: this is a committed
   * artifact the site already publishes, so the desk reads what the reader is
   * looking at rather than a second pipeline that could disagree with it. One
   * read per request, cached, and it costs one call against the budget like
   * every other read — a research budget that quietly excluded some reads
   * would not be a budget.
   *
   * WHAT IT CURRENTLY CARRIES IS ITSELF A FINDING. College football has no
   * universal injury report; the artifact's own README says EdgeDesk publishes
   * nothing it cannot verify, and at the time of writing every one of the 138
   * programs is LIMITED with zero player records. That is reported as UNKNOWN
   * and never as healthy.
   */
  async getAvailabilityArtifact(): Promise<{ meta: any; byTeam: Map<string, any>; error: string | null }> {
    if (this._avail) return this._avail;
    if (this.calls >= this.budget) {
      return { meta: null, byTeam: new Map(), error: "research budget exhausted before the availability artifact could be read" };
    }
    this.calls++;
    const url = `${SITE_BASE.replace(/\/+$/, "")}/football/availability/current.json`;
    const t0 = Date.now();
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 9000) : null;
      const r = await this.f(url, { signal: ctrl?.signal, headers: { accept: "application/json" } });
      if (timer) clearTimeout(timer);
      if (!r.ok) {
        const err = `HTTP ${r.status} from ${url}`;
        this.log.push({ table: "availability/current.json", ms: Date.now() - t0, rows: 0, error: err });
        this.note("availability/current.json", false, err);
        return (this._avail = { meta: null, byTeam: new Map(), error: err });
      }
      const j = await r.json();
      const byTeam = new Map<string, any>();
      /* Keyed EVERY way the artifact spells a program, because the slate joins
         on the school name and this file is keyed on the ESPN team id. */
      for (const rec of Object.values<any>(j?.teams ?? {})) {
        for (const n of [rec?.team_name, rec?.team_display, rec?.team_abbr]) {
          const k = EDINTEL.normKey(n);
          if (k && !byTeam.has(k)) byTeam.set(k, rec);
        }
      }
      this.log.push({ table: "availability/current.json", ms: Date.now() - t0, rows: byTeam.size, error: null });
      this.note("availability/current.json", true, null, byTeam.size);
      return (this._avail = { meta: j, byTeam, error: null });
    } catch (e) {
      const err = String((e as Error)?.message ?? e);
      this.log.push({ table: "availability/current.json", ms: Date.now() - t0, rows: 0, error: err });
      this.note("availability/current.json", false, err);
      return (this._avail = { meta: null, byTeam: new Map(), error: err });
    }
  }

  /* ---- r13: the football artifacts the desk reads, one HTTP read each ----
     Same transport and same memoisation as the slate: a committed file the
     site already serves, read once per request, costing one budget call. */
  private _artifacts: Record<string, { json: any; error: string | null }> = {};
  async getArtifact(rel: string, opts?: { free?: boolean }): Promise<{ json: any; error: string | null }> {
    if (this._artifacts[rel]) return this._artifacts[rel];
    /* `free` reads are the two small identity files a single-game turn always
       needs; they are memoised and fixed in number, so they do not compete
       with the schema reads for the turn's budget. */
    if (!opts?.free && this.calls >= this.budget) return { json: null, error: `research budget exhausted before ${rel} could be read` };
    if (!opts?.free) this.calls++;
    const url = `${SITE_BASE.replace(/\/+$/, "")}/${rel}`;
    const t0 = Date.now();
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 9000) : null;
      const r = await this.f(url, { signal: ctrl?.signal, headers: { accept: "application/json" } });
      if (timer) clearTimeout(timer);
      if (!r.ok) {
        const err = `HTTP ${r.status} from ${url}`;
        this.log.push({ table: rel, ms: Date.now() - t0, rows: 0, error: err });
        this.note(rel, false, err);
        return (this._artifacts[rel] = { json: null, error: err });
      }
      const j = await r.json();
      const n = Array.isArray(j?.games) ? j.games.length : j?.teams ? Object.keys(j.teams).length : j?.by_game ? Object.keys(j.by_game).length : 1;
      this.log.push({ table: rel, ms: Date.now() - t0, rows: n, error: null });
      this.note(rel, true, null, n);
      return (this._artifacts[rel] = { json: j, error: null });
    } catch (e) {
      const err = String((e as Error)?.message ?? e);
      this.log.push({ table: rel, ms: Date.now() - t0, rows: 0, error: err });
      this.note(rel, false, err);
      return (this._artifacts[rel] = { json: null, error: err });
    }
  }
  /** football/matchup/metrics.json — per-team metric detail, profiles, starters, coaching, NFL injuries. */
  getMatchupMetrics() { return this.getArtifact("football/matchup/metrics.json"); }
  /** football/nfl/slate.json — the NFL board's own projection, run in Node. */
  async getNflSlateArtifact(): Promise<{ meta: any; games: any[]; error: string | null }> {
    const a = await this.getArtifact("football/nfl/slate.json");
    return { meta: a.json, games: Array.isArray(a.json?.games) ? a.json.games : [], error: a.error };
  }
  /** football/venues/forecasts.json — open-meteo forecasts per game, keyed by game id. */
  getForecasts() { return this.getArtifact("football/venues/forecasts.json"); }

  /**
   * Everything the research packet reads for ONE football game beyond the
   * slate row and the market: both sides' metric records, profiles, starters,
   * coaching, the NFL injury report, and the forecast. Two artifact reads.
   */
  async getFootballContext(o: { sport: string | null; game_id: string | null; home_id: string | null; away_id: string | null; home: string | null; away: string | null }) {
    const out: any = { sport: o.sport, metrics: null, forecast: null, home: null, away: null, nfl_home: null, nfl_away: null, nfl_validation: null, errors: [] as string[], sources: {} as Record<string, unknown> };
    if (o.sport !== "americanfootball_ncaaf" && o.sport !== "americanfootball_nfl") return out;
    if (o.sport === "americanfootball_nfl") {
      /* The NFL artifact is memoised, so this is free when the slate index
         already read it; the engine's validation record rides on its meta. */
      const n = await this.getNflSlateArtifact();
      out.nfl_validation = n.meta?.engine?.validation ?? null;
      if (n.error) out.errors.push(`football/nfl/slate.json could not be read (${n.error})`);
    }
    const m = await this.getMatchupMetrics();
    if (m.error) out.errors.push(`football/matchup/metrics.json could not be read (${m.error})`);
    if (m.json) {
      out.metrics = { generated_at: m.json.generated_at ?? null, season: m.json.season ?? null, sources: m.json.sources ?? null, counts: m.json.counts ?? null };
      const teams = m.json.teams ?? {};
      const find = (id: string | null, name: string | null) => {
        if (!teams || (!id && !name)) return null;
        const k1 = id ? EDINTEL.canonKey(id, name ?? "") : null;
        if (k1 && teams[k1]) return teams[k1];
        const k2 = name ? EDINTEL.normKey(name) : null;
        if (k2 && teams[k2]) return teams[k2];
        const byName = Object.values<any>(teams).find((t) => name && EDINTEL.normKey(t.team) === EDINTEL.normKey(name));
        return byName ?? null;
      };
      if (o.sport === "americanfootball_ncaaf") { out.home = find(o.home_id, o.home); out.away = find(o.away_id, o.away); }
      else {
        const nfl = m.json.nfl?.teams ?? {};
        out.nfl_home = o.home_id ? nfl[String(o.home_id).toUpperCase()] ?? null : null;
        out.nfl_away = o.away_id ? nfl[String(o.away_id).toUpperCase()] ?? null : null;
      }
    }
    /* Slice 5: the store is keyed by game id for both leagues (the NFL slate
       build writes its kickoff forecasts under the nflverse game id). */
    if ((o.sport === "americanfootball_ncaaf" || o.sport === "americanfootball_nfl") && o.game_id) {
      const f = await this.getForecasts();
      if (f.error) out.errors.push(`football/venues/forecasts.json could not be read (${f.error})`);
      const g = f.json?.by_game?.[String(o.game_id)] ?? null;
      if (g) out.forecast = { value: { temp_f: num(g.temp_f), feels_f: num(g.feels_f), wind_mph: num(g.wind_mph), gust_mph: num(g.gust_mph), wind_from: g.wind_from ?? null, wind_word: g.wind_word ?? null, precip_in: num(g.precip_in), precip_pct: num(g.precip_pct), humidity_pct: num(g.humidity_pct), text: g.text ?? null, dome: !!g.dome, kickoff_local: g.kickoff_local ?? null },
        source: g.source ? `football/venues/forecasts.json (${g.source})` : "football/venues/forecasts.json", observed_at: g.as_of ?? f.json?.generated_at ?? null };
      else out.sources.forecast = "no forecast row for this game id";
    }
    return out;
  }

  /**
   * Slice 3: the two identity profiles for one game — football/identity/teams/<key>.json
   * per side, small files, memoised and counted against the budget like any
   * artifact. A profile from another season is refused at read time.
   */
  async getIdentity(o: { sport: string | null; home_id: string | null; away_id: string | null; season?: number | null }) {
    const out: any = { home: null, away: null, errors: [] as string[] };
    if (o.sport !== "americanfootball_ncaaf" && o.sport !== "americanfootball_nfl") return out;
    for (const side of ["home", "away"] as const) {
      const id = (o as any)[side + "_id"];
      if (!id) { out.errors.push(`no ${side} team id to read an identity profile for`); continue; }
      const key = String(id).toLowerCase().replace(/[^a-z0-9]/g, "");
      const a = await this.getArtifact(`football/identity/teams/${key}.json`, { free: true });
      if (a.error) { out.errors.push(`football/identity/teams/${key}.json could not be read (${a.error})`); continue; }
      const j = a.json;
      if (!j || j.schema !== "edgedesk_team_identity_v1") { out.errors.push(`football/identity/teams/${key}.json is not an identity profile`); continue; }
      if (o.season != null && num(j.season) != null && num(j.season) !== num(o.season)) { out.errors.push(`the identity profile for ${key} is season ${j.season}, not ${o.season}; a previous season's identity is never carried forward`); continue; }
      out[side] = j;
    }
    return out;
  }

  /** The most recent snapshot of THIS game's packet, under the caller's own token (RLS: own rows only). */
  async getPreviousPacket(gameId: string, sport: string | null, before?: string | null): Promise<{ packet: any | null; built_at: string | null; error: string | null }> {
    const q = `research_packets?select=packet,built_at,packet_id&game_id=eq.${encodeURIComponent(gameId)}`
      + (sport ? `&sport=eq.${encodeURIComponent(sport)}` : "") + (before ? `&built_at=lt.${encodeURIComponent(before)}` : "") + `&order=built_at.desc&limit=1`;
    const r = await this.read(q, "memory");
    const row = Array.isArray(r.rows) && r.rows.length ? r.rows[0] : null;
    return { packet: row?.packet ?? null, built_at: row?.built_at ?? null, error: r.error };
  }

  /**
   * THE READER'S OWN RISK POLICY, under the reader's own token.
   *
   * One row, RLS-scoped. A missing row is a NORMAL state and is reported as
   * such: the staking engine then answers in units under the documented
   * defaults and says an exact dollar figure needs a bankroll. It never
   * invents one, and it never falls back to another reader's row — which is
   * why this read goes out under the caller's JWT like every other.
   */
  async getBankrollSettings(): Promise<{ row: any | null; error: string | null; state: string }> {
    const r = await this.read("bankroll_settings?select=*&limit=1", "memory");
    const row = Array.isArray(r.rows) && r.rows.length ? r.rows[0] : null;
    return {
      row, error: r.error,
      state: r.error ? "UNREADABLE" : row ? "STORED" : "NO_ROW",
    };
  }

  /**
   * The positions already on the reader's card, so the exposure caps see more
   * than this turn. Reads the engine's own write-once trail (BET rows whose
   * game has not started) rather than a mutable "open bets" table, because
   * the trail is the only record that cannot have been edited.
   */
  /**
   * THE WHOLE BOOK, not the part of it EdgeDesk happens to know about.
   *
   * `stake_open_exposure` unions two things: positions EdgeDesk recommended
   * and recorded (SUBMITTED) and positions the reader declared placing
   * elsewhere (DECLARED). Reading only the first was a real hole in every
   * cap: a reader with 3u on Sunday from their own reads still had a "4u
   * daily cap" that would happily add four more.
   *
   * A DECLARED position can only ever make the engine size LESS. It never
   * enters the trail, the grades or the scorecard — EdgeDesk did not price
   * it and takes neither credit nor blame for it.
   */
  async getOpenExposure(): Promise<{ positions: any[]; error: string | null }> {
    const r = await this.read(
      "stake_open_exposure?select=ticket_id,kind,sport,game_id,matchup,team,market,selection,side,handicap,units,kickoff,built_at"
      + "&order=built_at.desc&limit=120", "memory");
    const seen = new Set<string>();
    const positions = (Array.isArray(r.rows) ? r.rows : []).filter((row: any) => {
      /* one position per (game, market, side): a re-asked question wrote a
         second snapshot of the same wager and it is one exposure, not two.
         A DECLARED row is keyed apart from a SUBMITTED one on purpose — a
         reader who declared a bet EdgeDesk also recommended is telling us
         they placed it, not that they placed it twice, so the declaration
         collapses onto the recommendation rather than doubling it. */
      const k = [row.sport, row.game_id, row.market, row.side ?? row.selection].join("|");
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).map((row: any) => ({
      kind: row.kind === "DECLARED" ? "DECLARED" : "SUBMITTED",
      sport: row.sport, game_id: row.game_id, market: row.market, side: row.side,
      selection: row.selection, line: row.handicap, units: row.units, kickoff: row.kickoff,
      /* the reader's own attribution wins over the selection text: they know
         which team their ticket is exposure to and the parser does not */
      teams: row.team ? [row.team] : null,
      team: row.team ?? null, matchup: row.matchup ?? null, ticket_id: row.ticket_id,
      source: row.kind === "DECLARED"
        ? "a wager the reader declared placing elsewhere; EdgeDesk did not price it and does not grade it, and it counts against the caps"
        : "a position EdgeDesk already recommended and recorded for a game that has not started",
    }));
    return { positions, error: r.error };
  }

  /**
   * The compact, COMPLETE slate index — stage A of staged retrieval.
   *
   * Compact on purpose. This is one small row per game for the whole card, and
   * it is what the eligibility and priority rules run over. Detailed evidence
   * is fetched afterwards, and only for the games that survive. Sending the
   * whole database into one prompt and hoping it fits is exactly how 130 items
   * got withheld for size while the answer claimed to have compared the slate.
   */
  async getSlateIndex(sportKey: string | null, scope: SlateScopeRequest = {}): Promise<SlateIndexResult> {
    const path: Record<string, unknown> = { sport: sportKey, requested_scope: scope };
    const index: SlateGame[] = [];
    const errors: string[] = [];
    let source: string | null = null;
    let sourceLabel = "";

    /* ---- A1. the schedule universe -------------------------------------- */
    /* r13: the NFL has its own published card now, with the model on it. */
    let nflArt: { meta: any; games: any[]; error: string | null } | null = null;
    if (sportKey === "americanfootball_nfl") {
      nflArt = await this.getNflSlateArtifact();
      path.nfl_artifact = { error: nflArt.error, games: nflArt.games.length, schema: nflArt.meta?.schema ?? null, season: nflArt.meta?.season ?? null,
        generated_at: nflArt.meta?.generated_at ?? null, engine: nflArt.meta?.engine?.model_version ?? null, lookahead_days: nflArt.meta?.lookahead_days ?? null };
      if (nflArt.error) errors.push(`the published NFL slate could not be read (${nflArt.error}); the multisport schedule table is used instead`);
    }
    if (sportKey === "americanfootball_nfl" && nflArt && nflArt.games.length) {
      const now = Date.now();
      for (const g of nflArt.games) {
        const t = Date.parse(String(g.kickoff ?? ""));
        if (Number.isFinite(t) && t < now - 6 * 3600_000) continue;
        index.push(normalizeNflArtifactGame(g, nflArt.meta));
      }
      source = "football/nfl/slate.json";
      sourceLabel = `the NFL board's own published slate (${nflArt.meta?.engine?.model_version ?? "edgedesk_football"}, generated ${nflArt.meta?.generated_at ?? "unknown"})`;
    } else if (sportKey === "americanfootball_ncaaf") {
      const art = await this.getFbsSlateArtifact();
      path.fbs_artifact = {
        error: art.error, games: art.games.length,
        schema: art.meta?.schema ?? null, version: art.meta?.version ?? null,
        season: art.meta?.season ?? null, generated_at: art.meta?.generated_at ?? null,
        source: art.meta?.source ?? null, lookahead_days: art.meta?.lookahead_days ?? null,
        counts: art.meta?.counts ?? null,
      };
      if (art.error) errors.push(`the published FBS slate could not be read (${art.error})`);
      for (const g of art.games) {
        index.push(normalizeFbsArtifactGame(g, art.meta));
      }
      if (index.length) {
        source = "football/fbs/slate.json";
        sourceLabel = `the FBS board's own published slate (${art.meta?.source ?? "cfbfastR schedules"}, generated ${art.meta?.generated_at ?? "unknown"})`;
      }

      /* ---- A2. the database cross-check --------------------------------- */
      const season = num(scope.season) ?? num(art.meta?.season) ?? seasonFor("americanfootball_ncaaf");
      let q = `games?select=game_id,season,week,season_type,start_date,completed,neutral_site,conference_game,`
        + `venue,home_id,home_team,home_conference,away_id,away_team,away_conference`
        + `&season=eq.${season}&completed=is.false&order=start_date.asc&limit=400`;
      if (num(scope.week) != null) q += `&week=eq.${num(scope.week)}`;
      const db = await this.read(q, "schedule", "cfb");
      path.cfb_games = { rows: db.rows.length, error: db.error, season, week: num(scope.week) ?? null };
      if (db.error) errors.push(`cfb.games could not be read (${db.error})`);

      if (!index.length && db.rows.length) {
        for (const g of db.rows) index.push(normalizeCfbGameRow(g));
        source = "cfb.games";
        sourceLabel = `the ingested CollegeFootballData schedule (cfb.games, season ${season})`;
      } else if (index.length && db.rows.length) {
        /* Both answered. The board artifact stays authoritative because it is
           literally what the reader is looking at; the database count is
           reported alongside it, and a gap between them is a FINDING. */
        const inWindow = db.rows.filter((r: any) => {
          const t = Date.parse(String(r.start_date ?? ""));
          return Number.isFinite(t) && t >= Date.now() - 6 * 3600_000
            && t <= Date.now() + (num(art.meta?.lookahead_days) ?? 10) * 86400_000;
        });
        path.cross_check = {
          artifact_games: index.length, cfb_games_in_same_window: inWindow.length,
          agrees: Math.abs(inWindow.length - index.length) <= 2,
          note: Math.abs(inWindow.length - index.length) <= 2
            ? "The board's published slate and the ingested schedule agree on the size of this card."
            : `The board's published slate carries ${index.length} games in this window and cfb.games carries ${inWindow.length}. `
              + `That is a real disagreement between two owned sources and is reported rather than resolved by picking one. `
              + `The board artifact is used because it is what the reader is looking at.`,
        };
        if (!(path.cross_check as any).agrees) {
          errors.push(`the two schedule sources disagree on the size of this card (${index.length} vs ${inWindow.length})`);
        }
        /* Carry the database game_id onto the artifact rows where the identity
           resolves, so cfb.lines, cfb.roster and the rest can be joined. */
        const byPair = new Map<string, any>();
        for (const r of db.rows) byPair.set(`${normName(r.away_team)}|${normName(r.home_team)}`, r);
        for (const g of index) {
          const hit = byPair.get(`${normName(g.away_team)}|${normName(g.home_team)}`);
          if (hit) { g.cfb_game_id = String(hit.game_id); g.week = g.week ?? num(hit.week); }
        }
      }
    } else if (sportKey === "baseball_mlb") {
      /* THE MLB SCHEDULE IS `games` WITHOUT A SPORT COLUMN. The deployed table
         is written by the MLB ingest (game_id, game_date, teams, start_time,
         status, park_id) and carries no sport_key; filtering on one answered
         HTTP 400 ("column games.sport_key does not exist") on every MLB
         board, which read as "the schedule retrieval for MLB failed". The
         same read getPitcherFeatures already makes, with the same
         finished-game rule, is the universe. */
      const days = [etDay(-1), etDay(0), etDay(1)];
      const g = await this.read(
        `games?select=game_id,game_date,home_team,away_team,start_time,status,park_id&game_date=in.(${days.join(",")})&order=start_time.asc&limit=80`, "schedule");
      path.games = { rows: g.rows.length, error: g.error, days, table: "games (the MLB schedule; no sport column)" };
      if (g.error) errors.push(`games could not be read (${g.error})`);
      const nowMs = Date.now();
      const seen = new Set<string>();
      let droppedFinished = 0, droppedOff = 0, droppedDup = 0;
      for (const r of g.rows) {
        if (mlbGameFinished(r, nowMs)) { droppedFinished++; continue; }
        if (mlbGameOff(r)) { droppedOff++; continue; }
        const k = `${normName(r.away_team)}|${normName(r.home_team)}|${String(r.game_date ?? "").slice(0, 10)}|${String(r.start_time ?? "").slice(0, 16)}`;
        if (seen.has(k)) { droppedDup++; continue; }
        seen.add(k);
        index.push({
          game_id: String(r.game_id), cfb_game_id: null, source: "games",
          season: null, week: null, kickoff: r.start_time ?? null,
          home_team: mlbClubKey(r.home_team) || String(r.home_team ?? ""), away_team: mlbClubKey(r.away_team) || String(r.away_team ?? ""),
          home_id: null, away_id: null, home_conference: null, away_conference: null,
          home_group: null, away_group: null, neutral_site: null, venue: r.park_id != null ? String(r.park_id) : null,
          matchup: `${mlbClubKey(r.away_team) || r.away_team} @ ${mlbClubKey(r.home_team) || r.home_team}`,
          status: r.status ?? "scheduled",
          model_home_line: null, model_total: null, model_status: null, model_completeness: null,
          quote: null, has_quote: false, has_signal: false, signals: [],
        });
      }
      path.games_scope = { returned: g.rows.length, kept: index.length, dropped_finished: droppedFinished, dropped_postponed: droppedOff, dropped_duplicate: droppedDup,
        note: "A game is finished by its status words or by the clock (dated before today ET with a start more than six hours past); a series is one game per date." };
      if (index.length) { source = "games"; sourceLabel = "the MLB schedule table (games), finished and postponed games dropped"; }
    } else if (sportKey) {
      /* Every other sport: the multisport schedule table. Same contract — the
         universe comes from a schedule, never from the price rows. */
      const days = [etDay(0), etDay(1), etDay(2)];
      let g = await this.read(
        `games?select=game_id,game_date,home_team,away_team,start_time,status`
        + `&sport_key=eq.${encodeURIComponent(sportKey)}&game_date=in.(${days.join(",")})`
        + `&order=start_time.asc&limit=200`, "schedule");
      path.games = { rows: g.rows.length, error: g.error, days };
      if (g.error && /sport_key/.test(g.error)) {
        /* No multisport schedule table is deployed (games is the MLB table).
           The captured markets are the only schedule this sport has: every
           distinct event with a price in the window is a game that exists,
           said as such — a capture, not a schedule. */
        path.schedule_fallback = { reason: `no schedule table for this sport (${g.error.slice(0, 80)})`, universe: "the captured markets" };
        const sg = await this.read(
          `signals?select=event_id,home_team,away_team,commence_time&sport_key=eq.${encodeURIComponent(sportKey)}`
          + `&commence_time=gte.${new Date(Date.now() - 6 * 3600_000).toISOString()}&commence_time=lte.${new Date(Date.now() + 3 * 86400_000).toISOString()}&limit=600`, "");
        path.signals_as_schedule = { rows: sg.rows.length, error: sg.error };
        if (sg.error) errors.push(`no schedule table for this sport and the captured markets could not be read either (${sg.error})`);
        sourceLabel = "the captured markets (no schedule table is deployed for this sport)";
        const seenEv = new Set<string>();
        g = { rows: sg.rows.filter((r: any) => { const k = String(r.event_id); if (seenEv.has(k)) return false; seenEv.add(k); return true; })
          .map((r: any) => ({ game_id: r.event_id, game_date: String(r.commence_time ?? "").slice(0, 10), home_team: r.home_team, away_team: r.away_team, start_time: r.commence_time, status: "scheduled" })), error: sg.error, cached: false };
        if (g.rows.length) source = "signals";
      } else if (g.error) errors.push(`games could not be read (${g.error})`);
      for (const r of g.rows) {
        if (String(r.status ?? "").toLowerCase() === "final") continue;
        index.push({
          game_id: String(r.game_id), cfb_game_id: null, source: "games",
          season: null, week: null, kickoff: r.start_time ?? null,
          home_team: r.home_team, away_team: r.away_team,
          home_id: null, away_id: null, home_conference: null, away_conference: null,
          home_group: null, away_group: null, neutral_site: null, venue: null,
          matchup: `${r.away_team} @ ${r.home_team}`,
          status: r.status ?? "scheduled",
          model_home_line: null, model_total: null, model_status: null, model_completeness: null,
          quote: null, has_quote: false, has_signal: false, signals: [],
        });
      }
      if (index.length && !source) { source = "games"; sourceLabel = "the multisport schedule table"; }
    }

    /* ---- A2b. poll rank, the one attention input EdgeDesk actually holds --
       Attention tiers without rankings collapse to one bucket, which answers
       "separate the lower-profile games from the prominent ones" by saying
       everything is lower-profile. One cheap read fixes it. A poll is an
       opinion about past results and is used here ONLY to say how much
       attention a game gets — never as a measure of quality. */
    if (sportKey === "americanfootball_ncaaf" && index.length) {
      const rk = await this.read(
        "rankings?select=season,week,poll,team,rank&order=week.desc.nullslast&limit=200", "team_stats", "cfb");
      path.rankings = { rows: rk.rows.length, error: rk.error };
      if (rk.rows.length) {
        const ap = rk.rows.filter((r: any) => String(r.poll ?? "").includes("AP"));
        const pool = ap.length ? ap : rk.rows;
        const maxWk = pool.reduce((a: number, r: any) => Math.max(a, num(r.week) ?? 0), 0);
        const rankBy = new Map<string, number>();
        for (const r of pool) {
          if (num(r.week) !== maxWk || !r.team || num(r.rank) == null) continue;
          rankBy.set(normName(r.team), num(r.rank)!);
        }
        for (const g of index) {
          g.home_rank = rankBy.get(normName(g.home_team)) ?? null;
          g.away_rank = rankBy.get(normName(g.away_team)) ?? null;
        }
        path.rankings_applied = { week: maxWk, ranked_teams: rankBy.size };
      }
    }

    /* ---- A3. join the market onto that universe, and COUNT IT SEPARATELY - */
    /* `quoted` counts games with a MARKET NUMBER, which is what the board
       counts. For CFB it is recomputed in A3b once cfb.lines has been read. */
    let quoted = 0, signalled = 0;
    if (index.length && sportKey) {
      const sig = await this.read(
        `signals?select=sig_key,event_id,sport_key,market,selection,point,best_dec,first_best_dec,best_book,`
        + `sharp_fair,sharp_book_fair,consensus_fair,reference_type,reference_book,edge,first_edge,`
        + `n_books,n_books_eff,has_sharp,corrob_n,corrob_ref,pin_dec,pin_opp_dec,qual_tier,qual_reason,`
        + `flagged_at,flagged_best_dec,home_team,away_team,commence_time,first_seen_at,last_seen_at`
        + `&sport_key=eq.${encodeURIComponent(sportKey)}`
        + `&commence_time=gte.${new Date(Date.now() - 6 * 3600_000).toISOString()}`
        + `&commence_time=lte.${new Date(Date.now() + 14 * 86400_000).toISOString()}&limit=900`, "");
      path.signals = { rows: sig.rows.length, error: sig.error };
      if (sig.error) errors.push(`signals could not be read (${sig.error})`);

      /* THE JOIN THAT WAS THE WHOLE BUG.
         This used to key both sides on a normalised display string. The odds
         capture writes the BOOK's name for a program — "North Texas Mean
         Green", "Miami (OH) RedHawks" — and the college schedule writes the
         school alone — "North Texas", "Miami". Those strings never match, so
         every college row was read and none was joined, and the emptiness was
         then reported to the reader as "there are no CFB matchups to
         evaluate" on a card of 75 games.

         tools/newsletter/market.js hit this exact failure and recorded it:
         "a live run read 410 college signal rows and joined zero, and every
         refusal said no_slate_game_with_both_teams". Its fix was to resolve
         through the board's own EDFbs resolver, and this is the same fix
         through the same code — inlined into EDINTEL so the edge function can
         reach it. Both sides must resolve and the kickoffs must agree; a half
         match is refused. */
      const join = EDINTEL.joinSignalsToGames({
        signals: sig.rows,
        games: index.map((g) => ({
          game_id: g.game_id, home_team: g.home_team, away_team: g.away_team,
          /* The artifact publishes the canonical key here; cfb.games publishes
             a numeric row id in the same field. canonKey() takes the first and
             ignores the second rather than indexing a team under "247". */
          home_id: g.home_id, away_id: g.away_id, kickoff: g.kickoff,
        })),
      });
      /* Carried in the data path because a join that drops everything must be
         distinguishable from a feed that returned nothing. */
      path.signal_join = {
        signals_read: join.signals_read, signals_joined: join.signals_joined,
        signals_refused: join.signals_refused, games_matched: join.games_with_signals,
        refusal_reasons: join.refusal_reasons, unresolved_names: join.unresolved_names,
        resolver: join.resolver, diagnosis: join.diagnosis,
      };
      if (join.signals_read > 0 && join.signals_joined === 0) {
        errors.push(`${join.signals_read} captured market rows were read for this sport and NONE joined to a game `
          + `on this card — a name-resolution fault, not an absence of markets`);
      }
      for (const g of index) {
        const rows = join.by_game[String(g.game_id)] ?? [];
        if (!rows.length) continue;
        g.signals = rows;
        g.has_quote = rows.some((r: any) => num(r.best_dec) != null);
        g.has_signal = rows.some((r: any) => r.flagged_at != null && num(r.flagged_best_dec) != null);
        if (g.has_quote) quoted++;
        if (g.has_signal) signalled++;
        const best = rows.slice().sort((a: any, b: any) =>
          String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))[0];
        if (best) g.quote = { event_id: best.event_id, market: best.market, selection: best.selection,
          point: best.point, dec: num(best.best_dec), book: best.best_book, captured_at: best.last_seen_at };
      }
    }

    /* ---- A3b. cfb.lines — THE OTHER HALF OF THE BOARD'S MARKET -----------
       The FBS board resolves a market from TWO sources (fbP4Market): a
       captured `signals` row, and the ingested CollegeFootballData consensus
       in cfb.lines keyed on the CFBD game id. Reading only the first is why
       this function reported one quoted game on a card the board showed as
       forty-six.
       A cfb.lines row is a LINE — no book, no per-side odds, no timestamp — so
       it is counted as a market to research and never as a price to bet into.
       resolveMarket() keeps those two facts apart for every game. */
    let lined = 0, priced = 0;
    if (sportKey === "americanfootball_ncaaf" && index.length) {
      const gids = index.map((g) => g.cfb_game_id).filter(Boolean) as string[];
      const linesBy = new Map<string, any[]>();
      if (gids.length) {
        /* Chunked for the same reason the board chunks it: a single in.() of
           every game id is a URL long enough for a proxy to truncate, and a
           truncated filter comes back SHORTER rather than as an error. */
        const CH = 60;
        for (let i = 0; i < gids.length; i += CH) {
          const part = gids.slice(i, i + CH);
          const ln = await this.read(
            `lines?select=game_id,provider,spread,over_under,home_moneyline,away_moneyline`
            + `&game_id=in.(${part.map(encodeURIComponent).join(",")})&limit=400`, "", "cfb");
          if (ln.error) { errors.push(`cfb.lines could not be read (${ln.error})`); break; }
          for (const l of ln.rows) linesBy.set(String(l.game_id), [...(linesBy.get(String(l.game_id)) ?? []), l]);
        }
      }
      for (const g of index) {
        const m = EDINTEL.resolveMarket({
          signals: g.signals, lines: linesBy.get(String(g.cfb_game_id)) ?? [],
          home_selection: g.home_team, away_selection: g.away_team,
          model_home_line: g.model_home_line, kickoff: g.kickoff,
          lines_convention: (scope as any).lines_convention ?? "betting",
        });
        g.market = m;
        g.has_market_line = m.has_market_line;
        g.has_executable_price = m.has_executable_price;
        /* has_quote keeps its old meaning — an executable price — so nothing
           downstream that gated on it silently widens. The LINE count is a new,
           separately named number. */
        g.has_quote = m.has_executable_price;
        if (m.has_market_line) lined++;
        if (m.has_executable_price) priced++;
      }
      path.cfb_lines = {
        games_with_a_line: lined, games_with_an_executable_price: priced,
        game_ids_tried: gids.length,
        note: "The board counts a game as having a market when EITHER source supplies a number. "
          + "games_with_a_line is that count. games_with_an_executable_price is the subset that could be bet into.",
      };
      quoted = lined;
    }

    /* ---- A4. the state, classified rather than inferred ------------------ */
    const scopeLabel = scope.label
      ?? (num(scope.week) != null ? `week ${num(scope.week)}` : `the next ${sportKey === "americanfootball_ncaaf" ? 10 : 3} days`);
    const state = EDINTEL.slateState({
      scheduled_games: index.length ? index.length : (errors.length ? null : 0),
      games_with_quotes: quoted,
      games_with_executable_price: index.some((g) => g.has_executable_price != null)
        ? index.filter((g) => g.has_executable_price).length : quoted,
      games_with_signals: signalled,
      errors,
      schedule_source: sourceLabel || source,
      scope_label: scopeLabel,
      sport_label: SPORT_INTELLIGENCE[sportKey ?? ""]?.label ?? sportKey ?? "this sport",
    });
    path.slate_state = { state: state.state, scheduled: index.length, quoted, signalled, source };

    return { index, state, source, source_label: sourceLabel, scope_label: scopeLabel, path, errors };
  }

  /** The sharp reference on a specific signal: Pinnacle print + book spread. */
  async getSharpReference(eventId: string, market?: string, selection?: string): Promise<Evidence[]> {
    let q = `signals?select=event_id,market,selection,has_sharp,pin_dec,pin_opp_dec,sharp_fair,consensus_fair,n_books,n_books_eff,corrob_n,last_seen_at&event_id=eq.${encodeURIComponent(eventId)}`;
    if (market) q += `&market=eq.${encodeURIComponent(market)}`;
    if (selection) q += `&selection=eq.${encodeURIComponent(selection)}`;
    q += "&order=last_seen_at.desc.nullslast&limit=4";
    const { rows, error } = await this.read(q, "");
    if (error || !rows.length) return [unavailable("signals", "sharp_reference", error ?? "no signal row for this selection", eventId)];
    return rows.map((r) => {
      const fm = EDINTEL.fairMethod(r);
      const cf = EDINTEL.confirmationRead(r);
      return ev({
        source: "signals", entity: eventId, field: "sharp_reference", value: {
          fair_method: fm.method, fair_label: fm.label, fair_is_sharp: fm.sharp,
          reference_book: fm.reference_book, reference_type: fm.reference_type,
          /* The quotes that ACTUALLY produced the number, named. An empty list
             on a method claiming a sharp anchor is itself the finding. */
          contributing_reference_quotes: fm.contributing_quotes,
          two_way_devig: fm.two_way,
          sharp_book_fair: fm.sharp_book_fair, consensus_fair: fm.consensus_fair,
          fair_probability: fm.fair_probability, fair_american: fm.fair_american,
          independent_families: cf.independent_families, total_books: cf.total_books,
          corroboration: cf.corroboration, sharp_confirmed: cf.sharp_confirmed,
        },
        status: fm.sharp ? "VERIFIED" : "PARTIAL",
        source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
        relevance: "sharp",
        note: `${fm.sentence} ${cf.sentence} ${cf.caveat}`,
      });
    });
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
    /* "final" was the only word tested, and the ingest does not always write
       it: a live packet carried the previous day's whole card as tonight's.
       The rule now reads the status words the feed uses AND the clock. */
    const nowMs = Date.now();
    const isFinal = (r: any) => mlbGameFinished(r, nowMs);
    const today = etDay(0);
    const seenCard = new Set<string>();
    const liveRows = rows.filter((r: any) => {
      if (isFinal(r) || mlbGameOff(r)) return false;
      /* one row per game: the same pairing, date and game number is one card however many times the sync wrote it */
      const k = `${normName(r.away_team_name)}|${normName(r.home_team_name)}|${String(r.game_date ?? "").slice(0, 10)}|${r.game_number ?? 1}`;
      if (seenCard.has(k)) return false;
      seenCard.add(k);
      return true;
    });
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
        source: "mlb_game_cards", entity, field: "game", relevance: "schedule", sport: "baseball_mlb",
        value: { date: g.game_date, game_date: g.game_date, start: g.start_time, local: g.start_time_local, venue: g.venue, status: g.status },
        /* the start time is WHEN THE GAME IS, not when this was observed; as an observation time it read as "timestamped in the future" on every live card */
        status: "VERIFIED", source_timestamp: null, freshness: freshnessOf("schedule", Date.now()),
      }));
      for (const side of ["away", "home"] as const) {
        const nm = side === "away" ? g.away_pitcher_name : g.home_pitcher_name;
        const th = side === "away" ? g.away_pitcher_throws : g.home_pitcher_throws;
        out.push(nm
          ? ev({
            source: "mlb_game_cards", entity: nm, field: "probable_starter", sport: "baseball_mlb",
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
  /* STAGE C — DETAILED EVIDENCE, FOR THE SHORTLIST ONLY                   */
  /*                                                                       */
  /* The whole point of staging. Stage A produced one small row per game    */
  /* for the entire card; stage B ranked it deterministically; this fetches */
  /* the expensive layers for the handful of games that survived, in        */
  /* BATCHED reads rather than per-game fan-out.                            */
  /*                                                                       */
  /* Every fact it emits carries a source and a time context, and every     */
  /* fact it cannot get stays null with the reason attached. A college      */
  /* football packet has real holes — there is no per-play efficiency feed  */
  /* and no injury report in this project — and the holes are declared      */
  /* rather than papered over with a season average wearing the clothes of  */
  /* an observation.                                                        */
  /* ==================================================================== */

  async getCfbGameEvidence(
    shortlist: SlateGame[], opts: { season?: number | null; now?: number } = {},
  ): Promise<{ packets: any[]; path: Record<string, unknown> }> {
    const path: Record<string, unknown> = { shortlist: shortlist.map((g) => g.matchup) };
    const now = opts.now ?? Date.now();
    const season = opts.season ?? seasonFor("americanfootball_ncaaf");
    if (!shortlist.length) return { packets: [], path: { ...path, note: "nothing was shortlisted" } };

    const teams = Array.from(new Set(shortlist.flatMap((g) => [g.home_team, g.away_team]).filter(Boolean)));
    const teamKey = (t: unknown) => normName(t);
    const inList = (xs: string[]) =>
      xs.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(",");

    /* ---- C1. completed games this season: what they have DEMONSTRATED --- */
    const done = await this.read(
      `games?select=game_id,season,week,start_date,completed,neutral_site,conference_game,venue,`
      + `home_team,home_points,home_conference,away_team,away_points,away_conference`
      + `&season=eq.${season}&completed=is.true&order=start_date.asc&limit=1200`, "historical", "cfb");
    path.completed_games = { rows: done.rows.length, error: done.error, season };

    /* ---- C2. SP+ — the opponent-adjusted axis this sport actually has --- */
    const sp = await this.read(
      `ratings?select=season,team,conference,rating,ranking,offense_rating,offense_ranking,`
      + `defense_rating,defense_ranking,special_teams_rating,sos&season=eq.${season}&limit=400`,
      "team_stats", "cfb");
    path.sp_plus = { rows: sp.rows.length, error: sp.error };
    const spBy = new Map<string, any>();
    for (const r of sp.rows) spBy.set(teamKey(r.team), r);

    /* ---- C3. records --------------------------------------------------- */
    const rec = await this.read(
      `records?select=season,team,total_wins,total_losses,total_ties,conf_wins,conf_losses`
      + `&season=eq.${season}&limit=400`, "team_stats", "cfb");
    path.records = { rows: rec.rows.length, error: rec.error };
    const recBy = new Map<string, any>();
    for (const r of rec.rows) recBy.set(teamKey(r.team), r);

    /* ---- C4. season aggregates, for the teams in scope only ------------- */
    const ts = await this.read(
      `team_season_stats?select=season,team,stat_name,stat_value&season=eq.${season}`
      + `&team=in.(${encodeURIComponent(inList(teams)).replace(/%2C/g, ",")})&limit=900`,
      "team_stats", "cfb");
    path.team_season_stats = { rows: ts.rows.length, error: ts.error, teams: teams.length };
    const statsBy = new Map<string, Record<string, unknown>>();
    const vocab = new Set<string>();
    for (const r of ts.rows) {
      if (!r.team || !r.stat_name) continue;
      vocab.add(String(r.stat_name));
      const o = statsBy.get(teamKey(r.team)) ?? {};
      o[String(r.stat_name)] = num(r.stat_value) ?? r.stat_value;
      statsBy.set(teamKey(r.team), o);
    }
    path.stat_vocabulary = [...vocab].sort();

    /* ---- C5. rosters — presence, never a depth chart -------------------- */
    /* THE ROSTER IS THE LEAST DECISIVE LAYER AND THE MOST EXPENSIVE ONE.
       It is per-team, so a five-game shortlist is ten reads — more than every
       other layer in this function combined. It is read last, only for the
       teams in the games that lead the shortlist, and only while there is
       budget left that the batched layers did not need. A roster EdgeDesk
       did not read is reported as not read, which is a different sentence
       from "no roster on file" and is the one that is true. */
    const rosterBy = new Map<string, any>();
    const rosterTeams = teams.slice(0, Math.max(2, Math.min(10, this.budget - this.calls - 1)));
    if (rosterTeams.length < teams.length) {
      path.roster_scope = {
        read: rosterTeams.length, of: teams.length,
        note: "The roster fan-out is bounded by the remaining retrieval budget. The teams not read are reported as "
          + "NOT READ rather than as having no roster.",
      };
      for (const t of teams.slice(rosterTeams.length)) {
        rosterBy.set(teamKey(t), { error: "not read — the retrieval budget was spent on the layers that decide more" });
      }
    }
    for (const t of rosterTeams) {
      const rs = await this.read(
        `roster?select=first_name,last_name,position,jersey,year&team=eq.${encodeURIComponent(t)}`
        + `&limit=200`, "player_stats", "cfb");
      if (rs.error || !rs.rows.length) { rosterBy.set(teamKey(t), { error: rs.error ?? "no roster rows on file" }); continue; }
      rosterBy.set(teamKey(t), {
        players: rs.rows.length,
        quarterbacks: rs.rows.filter((p: any) => String(p.position ?? "").toUpperCase() === "QB")
          .map((p: any) => ({ name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(), year: p.year, jersey: p.jersey })),
      });
    }
    path.rosters = { teams_read: rosterBy.size };

    /* ---- C6. consensus book lines, for market context only -------------- */
    const ids = shortlist.map((g) => g.cfb_game_id).filter(Boolean) as string[];
    const linesBy = new Map<string, any[]>();
    if (ids.length) {
      const ln = await this.read(
        `lines?select=game_id,provider,spread,over_under,home_moneyline,away_moneyline`
        + `&game_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=200`, "", "cfb");
      path.lines = { rows: ln.rows.length, error: ln.error };
      for (const l of ln.rows) linesBy.set(String(l.game_id), [...(linesBy.get(String(l.game_id)) ?? []), l]);
    }

    /* ---- build one packet per shortlisted game -------------------------- */
    const byTeamGames = new Map<string, any[]>();
    for (const g of done.rows) {
      for (const side of ["home", "away"] as const) {
        const t = teamKey(side === "home" ? g.home_team : g.away_team);
        byTeamGames.set(t, [...(byTeamGames.get(t) ?? []), g]);
      }
    }

    /* ---- C7. the college availability layer ----------------------------
       One read for the whole shortlist, not one per game. What it carries is
       itself the finding: 138 programs, and at the time of writing not one
       verified record among them. That is reported as UNKNOWN. */
    const avail = await this.getAvailabilityArtifact();
    const availBy = avail.byTeam, availMeta = avail.meta;
    path.availability = {
      /* teams_indexed counts INDEX KEYS, and a program is indexed under several
         aliases, so it reads ~395 for 138 schools. The artifact's own
         team_count is the number of programs and is what a coverage statement
         must quote; conflating the two put "none of the 395 programs" in front
         of a customer for a 138-school build. */
      teams_indexed: availBy.size, team_count: availMeta?.team_count ?? null, error: avail.error,
      generated_at: availMeta?.generated_at ?? null,
      records: availMeta?.records ?? null, flagged: availMeta?.flagged ?? null,
      teams_with_official: availMeta?.teams_with_official ?? null,
      coverage: availMeta?.coverage ?? null,
      note: "Read, not assumed. A team with no record is UNKNOWN, never healthy.",
    };

    /* Stated ONCE, attached everywhere a past opponent's rating appears. */
    const ratingBasis = EDINTEL.ratingTimeBasis({
      basis: "AS_ASSESSED_NOW", source: `cfb.ratings (SP+, season ${season})`, for_evaluation: false,
    });
    path.rating_time_basis = {
      basis: ratingBasis.basis,
      historical_versions_available: false,
      why: "cfb.ratings is keyed (season, team) with no week or as-of column, so this database carries no "
        + "historical version of a rating. Opponent strength on a PAST game is therefore a retrospective "
        + "assessment, not what was knowable at the time.",
      usable_for_leakage_free_evaluation: ratingBasis.usable_for_leakage_free_evaluation,
    };

    const F = EDINTEL.fact, MISS = EDINTEL.missingFact;
    const packets = shortlist.map((g) => {
      const side = (t: string) => {
        const k = teamKey(t);
        const spr = spBy.get(k) ?? null;
        const rr = recBy.get(k) ?? null;
        /* The availability record for THIS team, classified. EDINTEL.normKey is
           the FBS resolver's own key function, so this joins on the same rule
           the board and the odds join use rather than a fourth one. */
        const av = availMeta || availBy.size
          ? EDINTEL.availabilityRead({
            record: availBy.get(EDINTEL.normKey(t)) ?? null, team: t,
            generated_at: availMeta?.generated_at ?? null, now,
            /* THE SPORT'S OWN TOTALS, so a team with nothing on file can say
               whether that is particular to it or true of all 138 programs.
               Those two read identically to a customer and are not the same
               fact: one is bad luck this week, the other is that EdgeDesk has
               no working injury source for college football at all. */
            league: availMeta ? {
              team_count: availMeta.team_count ?? availBy.size,
              records: availMeta.records ?? null,
              teams_with_official: availMeta.teams_with_official ?? null,
              failed_sources: availMeta.failed_sources ?? null,
            } : null,
          })
          : null;
        const played = (byTeamGames.get(k) ?? []).slice().sort((a, b) =>
          String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")));
        /* PREVIOUS GAMES WITH OPPONENT STRENGTH ATTACHED. A 45-point win is a
           different fact against a top-20 defence than against an FCS side, and
           the SP+ rating of the opponent is what lets the answer say which. */
        const prev = played.slice(0, 5).map((p: any) => {
          const isHome = teamKey(p.home_team) === k;
          const opp = isHome ? p.away_team : p.home_team;
          const oppSp = spBy.get(teamKey(opp)) ?? null;
          const own = num(isHome ? p.home_points : p.away_points);
          const them = num(isHome ? p.away_points : p.home_points);
          return {
            date: p.start_date ? String(p.start_date).slice(0, 10) : null,
            week: num(p.week), opponent: opp,
            venue: p.neutral_site ? "neutral" : isHome ? "home" : "away",
            points_for: own, points_against: them,
            margin: own != null && them != null ? own - them : null,
            result: own != null && them != null ? (own > them ? "W" : own < them ? "L" : "T") : null,
            conference_game: p.conference_game === true,
            /* NAMED FOR WHEN IT IS TRUE. cfb.ratings is keyed (season, team)
               with no week and no as-of column, so this is where the opponent
               stands NOW, not where they stood the day this game was played.
               Calling it `opponent_sp_plus` invited exactly the reading that
               makes a past recommendation look better than it was. */
            opponent_sp_plus_now: oppSp ? num(oppSp.rating) : null,
            opponent_sp_rank_now: oppSp ? num(oppSp.ranking) : null,
            opponent_sp_plus_at_the_time: null,
            opponent_rating_time_basis: "AS_ASSESSED_NOW",
            opponent_conference: isHome ? p.away_conference : p.home_conference,
          };
        });
        /* REST DAYS, DERIVED FROM THE SCHEDULE ITSELF. Not ingested anywhere,
           and computable exactly from two dates, so it is computed rather than
           declared missing. */
        const last = played[0]?.start_date ? Date.parse(String(played[0].start_date)) : NaN;
        const kick = g.kickoff ? Date.parse(g.kickoff) : NaN;
        const restDays = Number.isFinite(last) && Number.isFinite(kick)
          ? Math.round((kick - last) / 86400000) : null;
        const ros = rosterBy.get(k) ?? null;
        const stats = statsBy.get(k) ?? null;

        const SRC_SP = "cfb.ratings (CollegeFootballData SP+)";
        return {
          team: F(t, { source: "football/fbs/slate.json" }),
          record: rr
            ? F(`${rr.total_wins ?? 0}-${rr.total_losses ?? 0}`, {
              source: "cfb.records", basis: `season ${season}`,
              note: "A record is an outcome of a schedule, not a measure of quality.",
            })
            : MISS("no record row on file for this team this season", "cfb.records"),
          conference_record: rr && rr.conf_wins != null
            ? F(`${rr.conf_wins}-${rr.conf_losses}`, { source: "cfb.records" })
            : MISS("no conference record on file", "cfb.records"),
          sp_plus_overall: spr ? F(num(spr.rating), {
            source: SRC_SP, unit: "points per game above average",
            note: "EXTERNAL MODEL. Attribute it to CollegeFootballData; it is not an EdgeDesk number and may not be converted into a spread or a probability.",
          }) : MISS("no SP+ row on file for this team this season", "cfb.ratings"),
          sp_plus_rank: spr ? F(num(spr.ranking), { source: SRC_SP }) : MISS("no SP+ row", "cfb.ratings"),
          sp_plus_offense: spr ? F(num(spr.offense_rating), { source: SRC_SP, note: "Higher is better." }) : MISS("no SP+ row", "cfb.ratings"),
          sp_plus_defense: spr ? F(num(spr.defense_rating), {
            source: SRC_SP,
            note: "SP+ defence is measured in points allowed, so LOWER is better. The sign is opposite to the offensive rating.",
          }) : MISS("no SP+ row", "cfb.ratings"),
          sp_plus_special_teams: spr ? F(num(spr.special_teams_rating), { source: SRC_SP }) : MISS("no SP+ row", "cfb.ratings"),
          strength_of_schedule: spr ? F(num(spr.sos), {
            source: SRC_SP,
            note: "College schedules are wildly unequal, so an unadjusted season stat compared across conferences is close to meaningless without this.",
          }) : MISS("no SP+ row", "cfb.ratings"),
          previous_games: prev.length
            ? F(prev, {
              source: "cfb.games", basis: `completed ${season} games, most recent first`,
              note: "Each previous game carries the OPPONENT's SP+ rating, so the same result can be read against "
                + "who it came against. " + ratingBasis.sentence,
            })
            : MISS("no completed games on file for this team this season — early-season ratings are mostly preseason prior", "cfb.games"),
          games_played: F(played.length, { source: "cfb.games" }),
          rest_days: restDays != null
            ? F(restDays, { source: "cfb.games (derived)", unit: "days since the last kickoff",
              basis: "computed from the two schedule dates, not ingested" })
            : MISS("no previous game on file, so rest cannot be computed", "cfb.games (derived)"),
          season_stats: stats && Object.keys(stats).length
            ? F(stats, {
              source: "cfb.team_season_stats", basis: `season ${season} aggregates`,
              note: "SEASON TOTALS AND COUNTS. No pace adjustment and no opponent adjustment. Not efficiency.",
            })
            : MISS("no season stat rows on file for this team", "cfb.team_season_stats"),
          quarterbacks: ros && ros.quarterbacks
            ? F(ros.quarterbacks, {
              source: "cfb.roster",
              note: "ROSTER PRESENCE, NOT A DEPTH CHART. Being listed does not mean a player starts, plays, or is healthy.",
            })
            : MISS(ros?.error ?? "no roster on file for this team", "cfb.roster"),
          /* The gaps, declared by name so their absence cannot read as a clean sheet. */
          per_play_efficiency: MISS(
            "EPA per play and success rate are NOT ingested for college football — per-game CollegeFootballData calls exceed the free tier. "
            + "Do not substitute points per game, a record or a poll ranking for them.", "—"),
          explosive_play_rate: MISS("not ingested for college football", "—"),
          success_rate: MISS("not ingested for college football", "—"),
          pressure_and_sacks: MISS("not ingested for college football", "—"),
          turnover_margin: MISS("not ingested for college football; season turnover counts may appear in season_stats but carry no opponent adjustment", "—"),
          red_zone: MISS("not ingested for college football", "—"),
          pace_and_possessions: MISS("not ingested for college football", "—"),
          /* AVAILABILITY, READ RATHER THAN ASSUMED.
             This used to say EdgeDesk ingests no college availability feed at
             all. That was wrong: football/availability/ is a real, scheduled
             pipeline over 138 programs. What it currently CARRIES is the
             finding — no verified records, no official reports, two of three
             sources failing — and availabilityRead() states that as UNKNOWN
             with its reasons attached. A team nobody has reported on is not a
             team that has been cleared. */
          availability: av
            ? F({
              /* NAMED. Without it the case-against reads "the home side has no
                 availability report", which is true of some game somewhere. */
              team: av.team,
              state: av.state, sentence: av.sentence, data_quality: av.data_quality,
              counts: av.counts, quarterbacks_flagged: av.quarterbacks,
              official_report_found: av.official_report_found,
              sources_checked: av.sources_checked, sources_failed: av.sources_failed,
              artifact_age_hours: av.artifact_age_hours, stale: av.stale,
              may_claim_healthy: av.may_claim_healthy,
              may_adjust_projection: av.may_adjust_projection,
            }, {
              source: av.source,
              observed_at: availMeta?.generated_at ?? null,
              note: av.sentence + " " + av.adjustment_note,
            })
            : MISS("the availability artifact could not be read on this request, so nothing is known either way "
              + "about who is available — which is not the same as nobody being hurt",
              "football/availability/current.json"),
          injuries: av && av.state === "VERIFIED_FLAGS"
            ? F(av.players, { source: av.source, observed_at: availMeta?.generated_at ?? null,
              note: "Players NOT named here are UNREPORTED, not confirmed fit." })
            : MISS(av ? av.sentence : "no availability record retrieved", "football/availability/current.json"),
        };
      };

      const home = side(g.home_team), away = side(g.away_team);
      const quotes = g.signals.map((r: any) => {
        const fm = EDINTEL.fairMethod(r);
        const qs = EDINTEL.quoteState({ captured_at: r.last_seen_at, market: r.market, kickoff: g.kickoff });
        const orient = orientToSelection({
          selection: String(r.selection ?? ""), home_team: g.home_team, away_team: g.away_team,
          point: num(r.point), model_home_line: g.model_home_line,
        });
        return {
          market: r.market, selection: r.selection, handicap: num(r.point),
          side: orient.side, orientation_note: orient.note,
          odds_decimal: num(r.best_dec), odds_american: EDINTEL.fmtAmerican(EDINTEL.decToAmerican(num(r.best_dec))),
          book: r.best_book, captured_at: r.last_seen_at,
          quote_status: qs.status, quote_age_min: qs.age_min, actionable: qs.actionable,
          fair_method: fm.method, fair_label: fm.label, fair_probability: fm.fair_probability,
          contributing_reference_quotes: fm.contributing_quotes,
          model_selection_line: orient.model_selection_line,
        };
      });

      const attention = EDINTEL.attentionTier({
        home_group: g.home_group, away_group: g.away_group,
        home_rank: g.home_rank, away_rank: g.away_rank,
        neutral_site: g.neutral_site, book_count: g.signals.length ? num(g.signals[0].n_books) : null,
      });

      return EDINTEL.evidencePacket({
        game_id: g.game_id, sport: "americanfootball_ncaaf", version: 1, now,
        identity: {
          matchup: F(g.matchup, { source: g.source }),
          game_id: F(g.game_id, { source: g.source }),
          cfb_game_id: g.cfb_game_id ? F(g.cfb_game_id, { source: "cfb.games" }) : MISS("identity did not resolve to an ingested CollegeFootballData game", "cfb.games"),
          kickoff: g.kickoff ? F(g.kickoff, { source: g.source, observed_at: g.kickoff }) : MISS("no kickoff time on the schedule row", g.source),
          venue: g.venue ? F(g.venue, { source: g.source }) : MISS("no venue on the schedule row", g.source),
          neutral_site: F(g.neutral_site === true, { source: g.source }),
          week: g.week != null ? F(g.week, { source: g.source }) : MISS("no week on the schedule row", g.source),
          status: F(g.status, { source: g.source }),
          home_team: F(g.home_team, { source: g.source }), away_team: F(g.away_team, { source: g.source }),
          home_conference: g.home_conference ? F(g.home_conference, { source: g.source }) : MISS("no conference on file", g.source),
          away_conference: g.away_conference ? F(g.away_conference, { source: g.source }) : MISS("no conference on file", g.source),
          attention_tier: F(attention.tier, { source: "derived", note: attention.caveat }),
        },
        model: {
          home_line: g.model_home_line != null
            ? F(g.model_home_line, {
              source: "football/cfb_p4 engine via " + g.source, unit: "points, from the HOME side",
              note: "Negative is a home favourite. Carried verbatim from the board's own projection; this layer does not recompute it.",
            })
            : MISS("the board did not project this game", g.source),
          total: g.model_total != null ? F(g.model_total, { source: "football/cfb_p4 engine via " + g.source, unit: "points" })
            : MISS("the board did not project a total for this game", g.source),
          status: g.model_status ? F(g.model_status, { source: g.source }) : MISS("no model status on the row", g.source),
          data_completeness: g.model_completeness != null
            ? F(g.model_completeness, { source: g.source, unit: "0-1",
              note: "The board's own measure of how much of its input layer was populated for this game." })
            : MISS("no completeness figure on the row", g.source),
          validation: F(EDINTEL.validationFor("americanfootball_ncaaf", "spreads").limitations, {
            source: "the model's own validation_summary",
            note: "The record that governs what this projection is allowed to become.",
          }),
        },
        market: quotes.length
          ? {
            quotes: F(quotes, { source: "signals", note: "Each quote carries its own capture time, freshness and fair-price method." }),
            consensus_book_lines: linesBy.get(String(g.cfb_game_id)) ?? null
              ? F(linesBy.get(String(g.cfb_game_id)), {
                source: "cfb.lines",
                note: "CONSENSUS BOOK NUMBERS FOR CONTEXT ONLY. Not Pinnacle, not EdgeDesk's captured prices, and they carry no timestamp. Never compute an edge against one.",
              })
              : MISS("no consensus book line on file for this game", "cfb.lines"),
          }
          : {
            quotes: MISS("no captured market quote for this game — it is on the schedule and not on any book EdgeDesk captures", "signals"),
            consensus_book_lines: linesBy.get(String(g.cfb_game_id))
              ? F(linesBy.get(String(g.cfb_game_id)), { source: "cfb.lines", note: "Context only; carries no timestamp and is not a price EdgeDesk stands behind." })
              : MISS("no consensus book line on file for this game", "cfb.lines"),
          },
        matchup: {
          home: home, away: away,
          sp_plus_gap: (home.sp_plus_overall.value != null && away.sp_plus_overall.value != null)
            ? F(+(home.sp_plus_overall.value - away.sp_plus_overall.value).toFixed(2), {
              source: "cfb.ratings (derived by subtraction)", unit: "points",
              note: "A difference of two EXTERNAL model ratings. It is not a spread, not a probability and not an edge, and it must never be converted into one.",
            })
            : MISS("SP+ is missing for at least one side, so no comparison is possible", "cfb.ratings"),
        },
        situation: {
          rest_advantage: (home.rest_days.value != null && away.rest_days.value != null)
            ? F(+(home.rest_days.value - away.rest_days.value).toFixed(0), {
              source: "cfb.games (derived)", unit: "days, positive means the home side is better rested",
            })
            : MISS("rest could not be computed for at least one side", "cfb.games (derived)"),
          weather: MISS(
            "No weather is ingested for college football venues on the server. The browser board fetches a forecast per venue; "
            + "this layer does not, and reports the gap rather than guessing.", "—"),
          travel: MISS("no travel distance is ingested for college football", "—"),
        },
        previous_games: { note: F("Both sides' previous games are under matchup.home.previous_games and matchup.away.previous_games, each with its opponent's SP+ attached.", { source: "cfb.games" }) },
        personnel: {
          home_quarterbacks: home.quarterbacks, away_quarterbacks: away.quarterbacks,
          depth_chart: MISS("EdgeDesk ingests no college football depth chart. A roster says who is on the team, not who plays.", "—"),
          injuries: MISS("EdgeDesk ingests no college football injury report. Their absence is not a clean injury sheet.", "—"),
          roster_continuity: MISS("returning production and transfer-portal flow are not written into the cfb schema by the current ingest", "cfb.returning_production"),
        },
        efficiency: {
          home_season_stats: home.season_stats, away_season_stats: away.season_stats,
          per_play: MISS(
            "Per-play efficiency (EPA per play, success rate, explosive rate) is NOT ingested for college football — "
            + "per-game CollegeFootballData calls exceed the free tier. Do not substitute points per game, a win-loss "
            + "record or a poll ranking for it. SP+ is the opponent-adjusted axis this sport actually has; say which "
            + "one you used.", "—"),
        },
      });
    });

    path.packets = packets.length;
    path.missing_per_packet = packets.map((p: any) => ({ game: p.game_id, missing: p.missing.length, present: p.completeness.fields_present }));
    return { packets, path };
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
    const nowMs = Date.now();
    const finalOf = (r: any) => mlbGameFinished(r, nowMs) || mlbGameOff(r);
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
      + `edge,first_edge,n_books,has_sharp,pin_dec,pin_opp_dec,home_team,away_team,last_seen_at,`
      + `reference_type,qual_tier,qual_reason,flagged_at,flagged_best_dec`
      + `&event_id=eq.${encodeURIComponent(eventId)}&order=edge.desc.nullslast&limit=40`, "");
    if (error) return { rows: [], ev: [unavailable("signals", "cross_market", `read failed — ${error}`, eventId)] };
    /* Every market on the game is legitimate CONTEXT here — the point of a
       cross-market read is to see whether the moneyline and the spread agree —
       but v8 emitted each row's `edge` as VERIFIED evidence with no filter at
       all, including exchange lay rows, so the model could quote the edge of a
       price capture had explicitly refused. The rows stay; the CLAIM does not.
       An unqualified row's edge is nulled out and replaced by the reason it was
       refused, which capture now writes on every priced row. */
    const marked = rows.map((r: any) => (signalIsActionable(r) && signalTradeable(r).ok)
      ? { ...r, edgedesk_signal: true }
      : { ...r, edgedesk_signal: false, edge: null, first_edge: null,
          not_a_signal_because: r.qual_reason ?? "not qualified by capture" });
    if (marked.length < 2) {
      return { rows: marked, ev: [unavailable("signals", "cross_market",
        "only one market is priced on this game — nothing to cross-check", eventId)] };
    }
    return {
      rows: marked,
      ev: [ev({
        source: "signals", entity: eventId, field: "cross_market", relevance: "structure",
        value: marked.map((r) => ({
          market: r.market, selection: r.selection, point: r.point,
          price: r.best_dec, edge: r.edge, edgedesk_signal: r.edgedesk_signal,
          not_a_signal_because: r.not_a_signal_because,
          has_sharp: r.has_sharp, n_books: r.n_books,
        })),
        status: "VERIFIED",
        source_timestamp: marked[0]?.last_seen_at,
        freshness: freshnessOf("odds", marked[0]?.last_seen_at),
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
      /* `confidence` was selected here and is neither written by rememberSession nor present on the deployed table; the read answered 400 and every prior session was lost with it */
      ? await this.read(`research_sessions?select=question,intent,conclusion,sport,entities,created_at&entities=ov.{${ents.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",")}}&order=created_at.desc&limit=10`, "memory")
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

  /* An attention split is a question about the WHOLE card, so it needs the
     schedule complete and the identity resolved. It deliberately does NOT
     require a price: a lower-profile game with no quote still belongs in the
     answer, and requiring one would quietly drop exactly the games the
     question is about. */
  REQUIREMENTS.attention_split = [
    R("slate_index", "REQUIRED", "global", {
      note: "Every game on the card, from a schedule source. A grouping that covers only the quoted games answers a different question.",
    }),
    R("cfb_game", "IMPORTANT", "slate"),
    R("cfb_ranking", "IMPORTANT", "global", {
      note: "Rankings are one of the few attention inputs EdgeDesk actually holds.",
    }),
    R("signal", "OPTIONAL", "global"),
  ];

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
  /* Tennis. The `false` rows are the point: EdgeDesk has no injury source, no
     point-by-point, no doubles rating and no exact first-serve time for a
     historical match, and an answer has to be able to SAY that instead of
     improvising around it. */
  tennis_atp: {
    schedule: true, market: true, rankings: true,
    tennis_record: true, tennis_rating: true, tennis_surface: true, tennis_form: true,
    tennis_fatigue: true, tennis_h2h: true, tennis_model: true, tennis_weather: true,
    tennis_injury: false, tennis_point_by_point: false, tennis_doubles: false,
    tennis_exact_start_time: false,
    starters: false, pitching_season: false, pitching_matchup: false, offense: false,
    bullpen: false, park: false, weather: false, quarterback: false, team_efficiency: false,
  },
  tennis_wta: {
    schedule: true, market: true, rankings: true,
    tennis_record: true, tennis_rating: true, tennis_surface: true, tennis_form: true,
    tennis_fatigue: true, tennis_h2h: true, tennis_model: true, tennis_weather: true,
    tennis_injury: false, tennis_point_by_point: false, tennis_doubles: false,
    tennis_exact_start_time: false,
    starters: false, pitching_season: false, pitching_matchup: false, offense: false,
    bullpen: false, park: false, weather: false, quarterback: false, team_efficiency: false,
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
  tennis_surface_leaders: "tennis_rating", tennis_player_context: "tennis_record",
  tennis_match_context: "tennis_model", tennis_market_disagreement: "tennis_model",
  tennis_data_health: "tennis_record",
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

  const final = universe.filter((r) => mlbGameFinished(r)).length;
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

/* --------------------------------------------- how old is too old, here */

/** How many minutes a captured price on this market may be, given when the
 *  game starts.
 *
 *  THE FLAT NUMBER WAS WRONG AT BOTH ENDS. `RESEARCH_STALE_MIN` is 90 and the
 *  thesis attack used 45, and neither can be right for both a game starting in
 *  twenty minutes and a game starting in six days. The loose end is the one
 *  that cost something: a 44-minute-old price twenty minutes before kickoff
 *  passed the 45-minute check and was described to a customer as the price,
 *  in the window where a line moves fastest and a book pulls a number
 *  soonest.
 *
 *  EDINTEL owns the ladder — it is the same policy capture enforces when it
 *  decides what to store as fresh — so this asks EDINTEL rather than carrying
 *  a fourth copy of the numbers. With no kickoff, or with no EDINTEL, the flat
 *  environment limit stands, which is the old behaviour exactly. */
function staleMinFor(kickoff: unknown, market: unknown = "spreads"): number {
  if (!EDINTEL || typeof EDINTEL.quoteTtlMin !== "function") return RESEARCH_STALE_MIN;
  const k = kickoff ? Date.parse(String(kickoff)) : NaN;
  if (!Number.isFinite(k)) return RESEARCH_STALE_MIN;
  const v = Number(EDINTEL.quoteTtlMin(market ?? "spreads", null, (k - Date.now()) / 3600000));
  return Number.isFinite(v) && v > 0 ? v : RESEARCH_STALE_MIN;
}

/* ------------------------------------------------------ thesis attack */

/* Deterministic. Reads the OWNED numbers on a signal row and reports whether the
   thesis survives them. It produces no new betting number — it reports which
   owned field breaks the case. */
export function attackThesis(
  sig: any, floor = 0.02, staleMin = 45,
  /* WHAT THE SIGNAL ROW CANNOT SEE.
     This function used to read a signal row and nothing else, so a live,
     sharp-anchored, floor-clearing quote came back SURVIVES with an EMPTY
     falsifier list — and "what is the strongest argument against this?" was
     answered with silence. Silence there is not neutrality: it is the closest
     thing this system can produce to manufactured confidence, on the one
     question a reader asks when they are trying not to be fooled.

     The answers were already in the packet. The model is unvalidated in this
     market; availability is UNKNOWN on both sides and unknown is not healthy;
     per-play efficiency is not ingested so the matchup read cannot be tested;
     the whole case rests on one captured price. None of those are visible in a
     signals row, so they are passed in. */
  ctx: {
    validation?: any; availability?: any[]; market?: any;
    packet_gaps?: { field: string; reason: string }[]; kickoff?: string | null;
  } = {},
): { status: string; note: string; falsifiers: string[]; structural: string[];
     counterarguments: string[]; blockers: string[]; next_checks: string[] } {
  const edge = num(sig?.edge);
  const firstEdge = num(sig?.first_edge);
  const nb = num(sig?.n_books) ?? 0;
  const sharp = sig?.has_sharp === true || sig?.has_sharp === "true";
  const seen = sig?.last_seen_at ? Date.parse(sig.last_seen_at) : NaN;
  const staleM = Number.isFinite(seen) ? (Date.now() - seen) / 60000 : 999;
  /* The caller's flat limit is a FLOOR ON THE QUESTION, not the answer: once a
     kickoff is known, how close the game is decides. A caller that names its
     own number on purpose passes something other than the default. */
  if (staleMin === 45 && ctx.kickoff) staleMin = staleMinFor(ctx.kickoff, sig?.market);
  const remaining = (firstEdge && firstEdge > 0 && edge != null) ? Math.max(0, Math.min(1, edge / firstEdge)) : null;

  const falsifiers: string[] = [];
  if (edge == null) falsifiers.push("No fair price on file — there is nothing to judge the number against.");
  if (edge != null && edge < floor) falsifiers.push(`Current edge ${(edge * 100).toFixed(1)}% is already below the ${(floor * 100).toFixed(1)}% floor.`);
  if (!sharp) falsifiers.push("Pinnacle does not print this side — the fair line rests on softer books.");
  if (nb < 4) falsifiers.push(`Only ${nb} book${nb === 1 ? "" : "s"} behind the fair line.`);
  if (staleM >= staleMin) falsifiers.push(`Last re-priced ${Math.round(staleM)}m ago — treat as stale until capture confirms it.`);
  if (edge != null && edge > 0.06) falsifiers.push("An edge this large on a game line is usually a stale or bad price, not a gift.");
  if (remaining != null && remaining < 0.5) falsifiers.push(`Over half the detection edge has decayed (${Math.round(remaining * 100)}% remains).`);

  /* ---- THE STRUCTURAL CASE AGAINST, which no price can clear ----------
     These do not weaken the arithmetic; they bound what the arithmetic is
     evidence OF. They are reported separately for exactly that reason, and
     they are never empty when the limits are real. */
  const structural: string[] = [];
  const v = ctx.validation;
  if (v && v.may_produce_model_ev === false) {
    structural.push(`The model has NO validated outcome probability in this market (${v.tier ?? "unvalidated"}), so its `
      + `agreement with the price is not corroboration of anything. If this case needs the model to be right, it has no `
      + `measured basis${v.max_decision && v.max_decision !== "BET CANDIDATE" ? `, which is why a model-led thesis is capped at ${v.max_decision}` : ""}.`);
  }
  if (v && v.experimental) {
    structural.push("This model is marked EXPERIMENTAL in this market — its walk-forward record does not beat the closing line.");
  }
  for (const av of ctx.availability ?? []) {
    if (!av) continue;
    if (av.state === "UNKNOWN" || av.state === "NOT_RETRIEVED") {
      structural.push(`${av.team}: no availability report on file. That is UNKNOWN, not healthy — a starter could be out `
        + `and EdgeDesk would not know, and nothing in this price accounts for it.`);
    } else if (av.state === "PARTIAL") {
      structural.push(`${av.team}: availability is partial. Players not named are unreported, not confirmed fit.`);
    }
  }
  const gaps = (ctx.packet_gaps ?? []).filter((g) => /efficienc|success_rate|explosive|pace|turnover|red_zone|pressure/.test(g.field));
  if (gaps.length) {
    structural.push(`The matchup read cannot be TESTED: ${gaps.slice(0, 4).map((g) => g.field).join(", ")} `
      + `${gaps.length > 4 ? `and ${gaps.length - 4} more ` : ""}are not ingested for this sport. A recent result that looks `
      + `distorted cannot be checked against per-play evidence, in either direction.`);
  }
  const mk = ctx.market;
  if (mk && mk.has_executable_price && mk.spread && mk.spread.book) {
    structural.push(`The executable half of this case is ONE captured price at ${mk.spread.book}. If that book moves or `
      + `pulls the number, there is no second executable quote behind it.`);
  }
  if (mk && mk.has_market_line && !mk.has_executable_price) {
    structural.push("There is a market NUMBER here but no executable price, so nothing about this can be acted on at a price.");
  }
  const kick = ctx.kickoff ? Date.parse(ctx.kickoff) : NaN;
  if (Number.isFinite(kick)) {
    const hrs = (kick - Date.now()) / 3600000;
    if (hrs > 24) {
      structural.push(`Kickoff is ${Math.round(hrs)} hours away. Most of the information that will move this number — `
        + `availability, weather, late money — has not arrived yet.`);
    }
  }

  /* THREE DIFFERENT THINGS, TOLD APART.

     These were one list, and the conflation is visible in the product: "last
     re-priced 446m ago — treat as stale until capture confirms it" was served
     as an ARGUMENT AGAINST the lean. It is not one. It is a gap in what
     EdgeDesk currently knows, and the sentence even contains its own remedy.
     Reading it as a counterargument lets "refresh the odds" look like an
     answer to a thesis problem, which is how a stale quote and an unvalidated
     model came to be offered as the same kind of objection.

       COUNTERARGUMENT  evidence against the thesis. Acting on it changes the
                        view. Nothing about it is fixed by looking again.
       BLOCKER          information that is missing or stale. It bounds what
                        can be claimed; it is not evidence either way.
       NEXT CHECK       the thing to go and find out. A blocker's remedy.

     Classified from the text that already exists rather than by rewriting the
     rules, so every sentence keeps its wording and only its bucket changes. */
  const STALE_OR_MISSING = /no fair price on file|treat as stale until|no availability report|availability is partial|not ingested for this sport|cannot be TESTED|has not arrived yet/i;
  const counterarguments: string[] = [];
  const blockers: string[] = [];
  for (const f of falsifiers.concat(structural)) {
    (STALE_OR_MISSING.test(f) ? blockers : counterarguments).push(f);
  }
  /* A next check is derived from the blocker it answers, and never invented:
     no blocker, no next check. */
  const next_checks: string[] = [];
  if (staleM >= staleMin) next_checks.push(`Re-capture the price — the last observation is ${Math.round(staleM)} minutes old. This confirms or withdraws the number; it does NOT answer any argument against the lean.`);
  if (edge == null) next_checks.push("Get a fair price on file, so there is something to judge the number against.");
  for (const av of ctx.availability ?? []) {
    if (av && (av.state === "UNKNOWN" || av.state === "NOT_RETRIEVED")) {
      next_checks.push(`Find an availability report for ${av.team}. Until then its status is unknown, and a refreshed price does not make it known.`);
    }
  }
  if (gaps.length) next_checks.push(`Per-play evidence (${gaps.slice(0, 3).map((g) => g.field).join(", ")}) is not ingested for this sport, so a distorted result cannot be checked. Closing this needs an ingest, not a refresh.`);

  const all = falsifiers.concat(structural);
  if (edge == null) return { status: "PENDING", note: "Cannot test a thesis with no fair price on file.", falsifiers: all, structural, counterarguments, blockers, next_checks };
  if (edge < floor) return { status: "INVALIDATED", note: "The price has moved EV below the floor — the thesis does not survive at this number.", falsifiers: all, structural, counterarguments, blockers, next_checks };
  const hard = (!sharp && nb < 4) || staleM >= staleMin || (remaining != null && remaining < 0.4);
  if (hard) return { status: "WEAKENED", note: "Positive, but undercut by thin confirmation, staleness or heavy decay.", falsifiers: all, structural, counterarguments, blockers, next_checks };
  if (falsifiers.length >= 3) return { status: "WEAKENED", note: "Several unresolved problems — a lean, not a strong bet.", falsifiers: all, structural, counterarguments, blockers, next_checks };
  return {
    status: "SURVIVES",
    note: structural.length
      ? "The ARITHMETIC holds against price, confirmation and freshness on owned data. That is not the same as the case "
        + "being strong: the limits below bound what this number is evidence of, and none of them is fixed by a better price."
      : "The edge holds up against price, confirmation and freshness on owned data.",
    falsifiers: all, structural, counterarguments, blockers, next_checks,
  };
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
    /* What KIND of fair line that is. Without it the same field name covers a
       Pinnacle de-vig and a pack median, and a reader has no way to tell. */
    facts.fair_price_source = focus.reference_type
      ?? (focus.has_sharp ? "sharp" : "robust_consensus");
    facts.edge = focus.edge ?? null;
    facts.n_books = focus.n_books ?? null;
    facts.fresh_books = focus.fresh_books ?? null;
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

/* `staleMin` is a FALLBACK here, not a rule: each row carries its own kickoff,
   so each row gets the limit its own kickoff earns. A slate mixes a game
   starting in an hour with one starting on Saturday, and one number cannot be
   right for both. */
export function scout(slateRows: any[], floor = 0.02, staleMin = 45): ScoutItem[] {
  const out: ScoutItem[] = [];
  for (const s of slateRows) {
    const rowStale = s.commence_time ? staleMinFor(s.commence_time, s.market) : staleMin;
    const edge = num(s.edge), first = num(s.first_edge);
    const nb = num(s.n_books) ?? 0;
    const sharp = s.has_sharp === true || s.has_sharp === "true";
    const seen = s.last_seen_at ? Date.parse(s.last_seen_at) : NaN;
    const staleM = Number.isFinite(seen) ? (Date.now() - seen) / 60000 : null;
    const remaining = (first && first > 0 && edge != null) ? edge / first : null;
    const flags: string[] = [];

    if (edge != null && edge >= 0.04 && (!sharp || nb < 5)) flags.push("large edge, weak confirmation");
    if (edge != null && edge > 0 && edge < floor && sharp && nb >= 6) flags.push("strong confirmation, sub-floor edge");
    if (edge != null && edge >= floor && staleM != null && staleM >= rowStale) flags.push("playable number on a stale capture");
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
  /** A matchup the CONVERSATION named, as two raw names. Never the loaded
      packet's own teams: those are what the reader has open, not what they
      asked about, and conflating the two makes an ordinary question about the
      open game look like a matchup that is missing from another sport's card. */
  namedMatchup?: string[];
  /** The structured subject this conversation is on — IDs, resolved once and
      re-validated against the card each turn, rather than re-read out of a
      short transcript. An explicit topic change replaces it wholesale. */
  subject?: ResearchSubject | null;
  teams: string[];
  sport: string | null;
  eventId: string | null;
  lastIntent: string | null;
}

/* THE MATCHUP THE CONVERSATION IS ON, PULLED OUT OF WHAT WAS SAID.
   resolveTeams only knows MLB clubs, so on a college board the history scan
   either finds nothing or finds the wrong sport's team through an alias. But
   the matchup is usually written down in plain sight -- "Analyze Miami versus
   Wake Forest", "Miami @ Wake Forest" -- in the question the user asked or the
   answer that came back. Read it from there.

   This asserts no identity. It extracts two NAMES and hands them to the same
   resolution the rest of the pipeline uses; if they match nothing on the card,
   nothing is focused and the ranking decides as before. Without it, "who have
   they played?" after a named matchup came back with the top-ranked game on
   the board rather than the game being discussed -- a wrong answer that reads
   exactly like a right one. */
const MATCHUP_LEAD = /^(?:analyz|analys|compar|previewi?|research|break down|look at|tell me about|show me|explain|give me|what about|how about|thoughts on|take on)\w*\s+/i;
export function matchupFromText(text: string): string[] {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  /* A side is a capitalised run: "Miami", "Wake Forest", "Texas A&M",
     "Miami (OH)", "Ole Miss". Joiners stay lower case so they cannot start one. */
  /* "(OH)" IS PART OF THE NAME, NOT PUNCTUATION AFTER IT.
     Miami (OH) and Miami are different programs and are frequently on the same
     card. This pattern stopped at the "(", so "Miami (OH) vs Cincinnati" read
     as "Miami" — the Florida school — versus Cincinnati, found no such game,
     and resolved nothing. A parenthetical of a few letters is admitted as part
     of the side it qualifies. */
  const PAREN = "(?:[ ]?\\([A-Za-z.]{1,6}\\))?";
  const SIDE = "[A-Z][A-Za-z'&.-]*" + PAREN + "(?:[ -](?:of|and|&|the|at)?[ ]?[A-Z][A-Za-z'&.-]*" + PAREN + ")*";
  const re = new RegExp("(" + SIDE + ")\\s+(?:versus|vs\\.?|@|at)\\s+(" + SIDE + ")");
  const m = re.exec(t);
  if (!m) return [];
  const clean = (v: string) => v.replace(MATCHUP_LEAD, "").replace(/[.,;:!?]+$/, "").trim();
  const a = clean(m[1]), b = clean(m[2]);
  if (!a || !b || normName(a) === normName(b)) return [];
  /* Two words that are both ordinary sentence openers are a false positive. */
  if (a.split(" ").length > 5 || b.split(" ").length > 5) return [];
  return [a, b];
}

export function deriveState(
  history: any[], plan: Plan, packet: any, prev?: ConvoState | null, question = "",
): ConvoState {
  const st: ConvoState = {
    teams: plan.entities.teams.slice(),
    sport: null, eventId: plan.entities.eventId, lastIntent: plan.intent,
  };
  if (!st.teams.length && prev?.teams?.length) st.teams = prev.teams.slice();
  if (!st.namedMatchup?.length && prev?.namedMatchup?.length) st.namedMatchup = prev.namedMatchup.slice();
  if (prev?.subject) st.subject = prev.subject;
  if (!st.eventId && prev?.eventId) st.eventId = prev.eventId;
  if (!st.sport && prev?.sport) st.sport = prev.sport;

  // A loaded signal packet always wins — it is what the user is looking at.
  /* THE CONVERSATION OUTRANKS THE OPEN TAB, ONCE IT HAS NAMED SOMETHING ELSE.
     A loaded packet is a strong signal — it is what the reader is looking at —
     but it is not stronger than the game they just asked about. A reader with
     a baseball game open who asks about North Texas vs Texas State and then
     says "who have they played?" means the college game; letting the packet
     win on every turn dragged the conversation back to baseball on the first
     follow-up, which is the same production failure one turn later. */
  const namedHere = matchupFromText(question);
  const namedBefore = namedHere.length === 2 ? namedHere : (() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const pair = matchupFromText(String(history[i]?.content ?? ""));
      if (pair.length === 2) return pair;
    }
    return [] as string[];
  })();

  const g = packet?.game;
  const packetNamesIt = !!(g?.matchup && namedBefore.length === 2
    && namedBefore.every((t) => normName(String(g.matchup)).includes(normName(t))));
  if (g?.matchup && typeof g.matchup === "string" && (namedBefore.length !== 2 || packetNamesIt)) {
    const t = resolveTeams(g.matchup);
    if (t.length) st.teams = t;
  }
  if (packet?.sport_key && (namedBefore.length !== 2 || packetNamesIt)) st.sport = packet.sport_key;
  if (namedBefore.length === 2 && !packetNamesIt) {
    /* AN EXPLICIT TOPIC CHANGE REPLACES THE OLD SUBJECT, it does not queue
       behind it. "What about Miami vs Wake Forest?" names a different game, so
       the carried subject is dropped here and re-resolved from the new names —
       otherwise the previous game's id would keep winning the carry and every
       later turn would answer about the matchup the reader had moved off. */
    if (namedHere.length === 2) st.subject = null;
    st.teams = namedBefore;
    st.namedMatchup = namedBefore;
    /* The sport is NOT asserted here — resolveNamedMatchup settles that
       against a real card. Only the subject is carried. */
    st.sport = null;
  }

  /* Fall back to whatever the last few turns were about — INSIDE THIS
     CONVERSATION'S SPORT.
     resolveTeams only knows MLB clubs, and it reaches them through aliases. Ask
     "analyze North Texas versus Texas State" on a college football board and
     the history scan comes back with the TEXAS RANGERS, because "texas" is one
     of that club's aliases. The right game was still researched here, because
     the board scope pinned the sport, but the conversation's entity scope was a
     baseball team for three turns running and a question that leaned on it
     would have retrieved one.
     scopeTeamsToSport already exists for exactly this and was simply not
     applied on the fallback path: once the sport is known to be something other
     than baseball, a club claimed only through a cross-league alias is
     dropped. */
  if (!st.teams.length) {
    const sportNow = st.sport ?? packet?.sport_key ?? packet?.board_scope?.sport ?? null;
    /* ALL of the history the client sent, not the last six entries of it.
       The handler already caps history at eight, and the matchup that anchors a
       conversation is named ONCE -- at the turn the user chose the game -- and
       then referred to by pronoun. Six entries is three turns; ask four
       follow-ups and the anchor falls off the back of the scan while every
       later turn still means the same game. The failure is silent: the ranking
       supplies its top game instead, and a wrong answer about a different
       fixture reads exactly like a right one. */
    for (let i = history.length - 1; i >= 0; i--) {
      const said = String(history[i]?.content ?? "");
      /* The written-down matchup first: it is the thing the conversation is
         actually about, in any sport, and it needs no club table to find. */
      const pair = matchupFromText(said);
      if (pair.length === 2) { st.teams = pair; break; }
      const matches = resolveTeamsDetailed(said);
      const { teams } = scopeTeamsToSport(matches, sportNow);
      if (teams.length) { st.teams = teams; break; }
    }
  }
  /* The same reading applies to THIS question: "what about Miami at Wake
     Forest" names a matchup the MLB resolver cannot see. */
  if (!st.teams.length) {
    const pair = matchupFromText(question);
    if (pair.length === 2) st.teams = pair;
  }
  return st;
}
/*__EDLIB_END__*/
