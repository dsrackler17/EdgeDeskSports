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
// PART 2 is the orchestrator, the system prompt and the HTTP handler.
//
// CONTRACT (unchanged): the browser POSTs
//   { mode, question, packet, history, compare }
// and gets back
//   { answer, model?, cached?, research? }        // `research` is additive
// Any non-200 or thrown error makes the client fall back to its own
// deterministic engine, so this function is an ENHANCEMENT, never a dependency.
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
}

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
}

/** Numeric identity of a stat row, used to spot the same row served twice. */
function statFingerprint(v: any): string | null {
  if (!v || typeof v !== "object") return null;
  const SKIP = new Set(["plate_appearances", "at_bats", "batters_faced", "games_started", "home_runs"]);
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
export function dataIntegrity(
  evidence: Evidence[],
  opts: { now?: number; staleDays?: number } = {},
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

  /* 2. DUPLICATION — the same numeric vector on two different people. */
  for (const [label, items, status] of [
    ["pitcher_stats", pitchers, "FAIL"],
    ["offense_stats", offenses, "WARNING"],
  ] as [string, Evidence[], IntegrityVerdict][]) {
    const seen = new Map<string, string[]>();
    for (const e of items) {
      const fp = statFingerprint(e.value);
      if (!fp) continue;
      const who = String((e.value as any)?.name ?? e.entity ?? "?");
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

  /* 3. FRESHNESS — how old is the newest thing we are ranking on. */
  {
    const ages = pitchers.map((e) => AGE_DAYS(e.source_timestamp ?? e.retrieved_at, now))
      .filter((a): a is number => a != null);
    if (!ages.length) {
      checks.push({ name: "freshness", status: "WARNING",
        detail: "No pitcher row carried a source timestamp, so its age cannot be established." });
    } else {
      const newest = Math.min(...ages);
      const when = new Date(now - newest * 86400000).toISOString().slice(0, 10);
      checks.push(newest > staleDays
        ? { name: "freshness", status: "WARNING",
            detail: `The most recent pitcher record is ${Math.round(newest)} days old (${when}). `
              + `Any ranking built on it is provisional and must be labelled as such UP FRONT, not disclosed at the end.` }
        : { name: "freshness", status: "PASS",
            detail: `Newest pitcher record is ${newest < 1 ? "under a day" : Math.round(newest) + " days"} old.` });
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

  const verdict: IntegrityVerdict = checks.some((c) => c.status === "FAIL")
    ? "FAIL"
    : checks.some((c) => c.status === "WARNING") ? "WARNING" : "PASS";

  const failed = checks.filter((c) => c.status !== "PASS");
  const summary = verdict === "PASS"
    ? "All integrity checks passed."
    : `${verdict}: ` + failed.map((c) => c.name).join(", ");

  return { verdict, checks, summary };
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

export const MODE_OF_INTENT: Record<string, Mode> = {
  worst_pitchers: "MATCHUP", exploitable_pitchers: "MATCHUP", best_pitchers: "MATCHUP",
  best_matchups: "MATCHUP", offense: "MATCHUP", research_matchup: "DEEP",
  best_bets: "SLATE", slate_overview: "SLATE", bullpen: "SLATE", weather: "SLATE",
  traps: "SCOUT", research_priority: "SCOUT", signal_quality: "SCOUT",
  market_disagreement: "MARKET", what_changed: "MARKET", price: "MARKET",
  attack: "ATTACK", compare: "COMPARE", historical: "HISTORICAL",
  full_research: "DEEP", why: "FAST", unknown: "FAST",
};

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
    key: "americanfootball_nfl", label: "NFL", status: "CORE_ONLY", steps: [],
    needs: "No NFL team/player feature tables are ingested. Core market research (price, sharp reference, edge, confirmation, CLV) works; QB / efficiency / trenches / rest research needs an NFL feature pipeline.",
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
    key: "americanfootball_ncaaf", label: "CFB", status: "CORE_ONLY", steps: ["rankings"],
    needs: "CFB efficiency lives behind the cfb schema (cfb_ingest / cfbd_rankings) and is not exposed to this function's reader. Core market research plus AP/coaches rankings work.",
  },
};

export function sportModule(key: string | null | undefined): SportModule | null {
  if (!key) return null;
  return SPORTS[key] ?? null;
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

export function resolveTeams(question: string): string[] {
  const q = " " + normName(question) + " ";
  const hits: string[] = [];
  for (const t of MLB_TEAMS) {
    const keys = [normName(t.name), ...t.aliases];
    for (const k of keys) {
      // Two-letter abbreviations are too collision-prone to match loosely.
      if (k.length <= 3 && !q.includes(" " + k + " ")) continue;
      if (q.includes(" " + k + " ") || q.includes(" " + k + "s ")) { hits.push(t.name); break; }
    }
  }
  return Array.from(new Set(hits));
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

  const entities = {
    teams: resolveTeams(raw),
    players: [] as string[],
    date: null as string | null,
    eventId: null as string | null,
    rank: rankMatch ? parseInt(rankMatch[1], 10) : null,
  };

  const P = (intent: string, depth: Depth, steps: string[], why: string): Plan => ({
    intent, mode: MODE_OF_INTENT[intent] ?? "FAST", depth, sport: null, steps, entities,
    budget: depth === "QUICK" ? 4 : depth === "STANDARD" ? 8 : depth === "DEEP" ? 14 : depth === "SLATE" ? 12 : 18,
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

  if (STRONG_WORD.test(q) && PITCH_STEM.test(q) && !MATCHUP_WORD.test(q))
    return P("best_pitchers", "SLATE", ["slate", "pitchers", "pitcher_features", "opponent_offense", "park"], "Ranking starters requires the whole card.");

  // Superlative + subject, matched loosely: "best pitching matchups today" and
  // "biggest mismatch between pitching and offense" are the same question.
  if (/\b(best|strongest|biggest|top|juiciest|worst|weakest|easiest|softest)\b[\s\S]{0,40}\b(matchup|matchups|mismatch|game|games|spot|spots)\b/.test(q))
    return P("best_matchups", "SLATE", ["slate", "pitchers", "pitcher_features", "opponent_offense", "park", "weather", "market"], "Matchup quality across the card.");

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
    return P("slate_overview", "SLATE", ["slate", "market", "matchup", "pitchers", "pitcher_features", "opponent_offense", "park"], "Board-level overview.");

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

export class Dal {
  private o: DalOpts;
  private f: typeof fetch;
  calls = 0;
  budget: number;
  mlbFallback: boolean;
  log: { table: string; ms: number; rows: number; error: string | null }[] = [];

  constructor(o: DalOpts) {
    this.o = o;
    this.f = o.fetchImpl ?? fetch;
    this.budget = o.budget ?? 18;
    this.mlbFallback = o.mlbFallback !== false;
  }

  /** One REST read. Never throws. Returns rows plus the error text if it failed. */
  async read(query: string, category = "schedule"): Promise<{ rows: any[]; error: string | null; cached: boolean }> {
    const ttl = CACHEABLE[category];
    const key = query;
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
      const r = await this.f(`${this.o.supabaseUrl}/rest/v1/${query}`, {
        headers: { apikey: this.o.apikey, authorization: this.o.authorization, accept: "application/json" },
      });
      const txt = await r.text();
      if (!r.ok) {
        const err = `HTTP ${r.status}${txt ? ": " + txt.slice(0, 180) : ""}`;
        this.log.push({ table: query.split("?")[0], ms: Date.now() - t0, rows: 0, error: err });
        if (ttl) CACHE.set(key, { at: Date.now(), rows: [], err });
        return { rows: [], error: err, cached: false };
      }
      let rows: any[] = [];
      try { rows = JSON.parse(txt); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      this.log.push({ table: query.split("?")[0], ms: Date.now() - t0, rows: rows.length, error: null });
      if (ttl) CACHE.set(key, { at: Date.now(), rows, err: null });
      return { rows, error: null, cached: false };
    } catch (e) {
      const err = String((e as Error)?.message ?? e);
      this.log.push({ table: query.split("?")[0], ms: Date.now() - t0, rows: 0, error: err });
      return { rows: [], error: err, cached: false };
    }
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
    const { rows, error } = await this.read(q, "");
    if (error) return { rows: [], ev: [unavailable("signals", "slate", `signals read failed — ${error}`)] };
    if (!rows.length) return { rows: [], ev: [unavailable("signals", "slate", "no signals in the current window")] };
    const out = rows.map((r) => ev({
      source: "signals", entity: `${r.away_team} @ ${r.home_team}`, field: "signal",
      value: r, status: "VERIFIED", relevance: "market",
      source_timestamp: r.last_seen_at, freshness: freshnessOf("odds", r.last_seen_at),
    }));
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
    const n = rows.length;
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
    return [ev({
      source: "signals", entity: sportKey ?? "all", field: "clv_history",
      value: {
        n, beat_close: beat, beat_close_rate: +(beat / n).toFixed(3),
        avg_clv: avg == null ? null : +avg.toFixed(4),
        win_rate: graded ? +(wins / graded).toFixed(3) : null, graded,
      },
      status: "HISTORICAL", freshness: "HISTORICAL", relevance: "history",
      note: "Correlation over a sample of owned graded signals, not proof about any single game.",
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
    const { rows, error } = await this.read(
      `mlb_game_cards?select=game_date,start_time,start_time_local,venue,status,doubleheader,game_number,`
      + `away_team_id,away_team_name,away_record,away_streak,away_pitcher_name,away_pitcher_throws,`
      + `home_team_id,home_team_name,home_record,home_streak,home_pitcher_name,home_pitcher_throws,`
      + `park_factor,hr_factor,run_factor,roof_type,is_dome,temp_f,humidity,precip_prob,wind_mph,wind_dir,wind_rel`
      + `&game_date=in.(${days.join(",")})&order=start_time.asc&limit=60`, "schedule");
    const path: Record<string, unknown> = { table: "mlb_game_cards", days_queried: days, rows: rows.length, error };
    if (error) return { rows: [], ev: [unavailable("mlb_game_cards", "mlb_card", `read failed — ${error}`)], path };
    if (!rows.length) return { rows: [], ev: [unavailable("mlb_game_cards", "mlb_card", `no rows for ${days.join(" / ")} — the MLB schedule sync has not written this slate`)], path };
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
  async getPitcherFeatures(): Promise<{ ev: Evidence[]; path: Record<string, unknown> }> {
    const days = [etDay(-1), etDay(0), etDay(1)];
    const path: Record<string, unknown> = { days_queried: days };
    const out: Evidence[] = [];

    // Link 1 — the games rows that carry the ids pitcher_features is keyed by.
    const g = await this.read(
      `games?select=game_id,game_date,home_team,away_team,start_time,status,park_id&game_date=in.(${days.join(",")})&order=start_time.asc&limit=60`, "schedule");
    path.games = { rows: g.rows.length, error: g.error };

    let ids: string[] = g.rows.map((r) => r.game_id).filter((v) => v != null).map(String);

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
        `pitcher_features?select=game_id,side,pitcher_id,name,xera,k_pct,bb_pct,barrel_pct,hardhit_pct&game_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=200`, "player_stats");
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
        `offense_features?select=game_id,side,obp,iso,k_pct,runs_per_game&game_id=in.(${ids.map(encodeURIComponent).join(",")})&limit=200`, "team_stats");
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

    for (const p of pf) {
      const side = String(p.side ?? "").toLowerCase();
      const opp = offBy[`${p.game_id}|${flip(side)}`] ?? null;
      const u = lastStart[String(p.pitcher_id)] ?? null;
      const missing = (["xera", "k_pct", "bb_pct", "barrel_pct", "hardhit_pct"] as const).filter((k) => p[k] == null);
      out.push(ev({
        source: "pitcher_features", entity: p.name, field: "pitcher_quality", relevance: "pitching",
        value: {
          name: p.name, side, game_id: p.game_id,
          xera: p.xera, k_pct: p.k_pct, bb_pct: p.bb_pct, barrel_pct: p.barrel_pct, hardhit_pct: p.hardhit_pct,
          missing_fields: missing,
        },
        status: missing.length === 5 ? "UNAVAILABLE" : missing.length ? "PARTIAL" : "VERIFIED",
        freshness: "RECENT",
      }));
      out.push(opp
        ? ev({
          source: "offense_features", entity: p.name, field: "opponent_offense", relevance: "matchup",
          value: { faces_side: flip(side), obp: opp.obp, iso: opp.iso, k_pct: opp.k_pct, runs_per_game: opp.runs_per_game },
          status: "VERIFIED", freshness: "RECENT",
          note: "Joined through pitcher_features.game_id and the opposite side of offense_features.",
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
    facts: any[]; outcomes: any[]; patterns: any[]; prior: any[]; ev: Evidence[];
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
    let patQ = "research_patterns?select=pattern_key,sport,description,sample_size,metric,metric_value,confidence,updated_at&order=sample_size.desc&limit=25";
    if (sport) patQ += `&sport=eq.${encodeURIComponent(sport)}`;
    const patterns = await this.read(patQ, "memory");
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
        note: `Discovered over ${p.sample_size} samples. One game is never a pattern.`,
      }));
    }
    if (facts.error || outcomes.error || patterns.error || prior.error) {
      out.push(unavailable("research_memory", "memory",
        `memory tables not readable — ${facts.error ?? outcomes.error ?? patterns.error ?? prior.error}. Run the research-memory migration.`));
    }
    return { facts: facts.rows, outcomes: outcomes.rows, patterns: patterns.rows, prior: prior.rows, ev: out };
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
  changed: { field: string; from: unknown; to: unknown; direction: string | null }[];
  unchanged: string[];
  note: string;
} {
  if (!prev) {
    return { changed: [], unchanged: [], note: "No earlier research packet on file for this game — this is version 1." };
  }
  const changed: { field: string; from: unknown; to: unknown; direction: string | null }[] = [];
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
    changed.push({ field: f, from: a ?? null, to: b ?? null, direction });
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
   PART 2 — ORCHESTRATOR, PROMPT, HANDLER
   Source of truth: supabase/functions/edgedesk_ai/index.ts
   ======================================================================= */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("EDGEDESK_AI_MODEL") ?? "claude-sonnet-4-5";
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

const MAX_TOKENS: Record<string, number> = {
  QUICK: 800, STANDARD: 1200, DEEP: 2400, SLATE: 3000, FULL: 3400,
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "content-type": "application/json" },
  });
}

/* ======================================================================== */
/* SYSTEM PROMPT                                                            */
/* ======================================================================== */

const SYSTEM = `You are EdgeDesk Intelligence, the research analyst inside EdgeDesk — a CLV-first sports-betting research app. You are the reasoning layer over a deterministic pricing engine. You are not the engine.

HOW A TURN REACHES YOU
EdgeDesk classified the question, built a research plan, and ran that plan against its OWN databases before calling you. You receive:
- RESEARCH PLAN — the intent, depth and retrieval steps that were executed.
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

DATA INTEGRITY — AUDIT BEFORE YOU ANALYSE
Every turn carries a DATA INTEGRITY block with a verdict EdgeDesk computed deterministically over the evidence, before you saw it. Read it first. It is not advisory.
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

VERDICT DISCIPLINE
Use the deterministic verdict wherever one is attached (BET / LEAN / WAIT / PASS). Never upgrade it. WAIT means information is missing, stale or unconfirmed — it is not a rejection; lead with what must confirm. On PASS, explain what would have to change; do not find a way to recommend it. A positive edge is not a bet: judge it against break-even and max-playable, and if the price is past the floor, say the price is the problem and name the price that would restore it.

MARKET vs MODEL
Keep these separate and never collapse them into one "AI confidence": MODEL EDGE (what EdgeDesk projects, UNPROVEN), MARKET EDGE (price vs sharp reference), PRICE VALUE (where this number sits in the playable window), ACTIONABILITY (liquidity, freshness, book trust), RESEARCH CONFIDENCE (how good the evidence is). When Pinnacle disagrees with the model, that is information to explain, not noise to dismiss.

CONTRADICTION IS THE JOB
Every serious answer must try to break itself. For each candidate give the supporting evidence, the strongest contradiction, the biggest open question, and the falsifier that would end it. You are not rewarded for defending a conclusion.

MEMORY
Prior outcomes and patterns are historical. Quote a pattern only when its sample_size supports it, and always say the N. One result is never a pattern. If prior research on this entity exists, reference it briefly — "EdgeDesk last researched this matchup on <date> and concluded X" — and say whether the current evidence agrees.

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
/* RESEARCH ORCHESTRATOR                                                    */
/* ======================================================================== */

interface ResearchOut {
  plan: Plan;
  state: ConvoState;
  evidence: Evidence[];
  conflicts: ReturnType<typeof findConflicts>;
  unavailable: { source: string; field: string; reason: string }[];
  attack: { status: string; note: string; falsifiers: string[] } | null;
  memory: { facts: any[]; outcomes: any[]; patterns: any[]; prior: any[] };
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
}

async function runResearch(
  plan: Plan, state: ConvoState, packet: any, dal: Dal,
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
  const teamKeys = state.teams.map((t) => t.toLowerCase());
  if (slateRows.length) {
    if (teamKeys.length) {
      focus = slateRows.find((r) => {
        const m = `${r.away_team ?? ""} ${r.home_team ?? ""}`.toLowerCase();
        return teamKeys.some((t) => m.includes(t.toLowerCase().split(" ").pop() ?? t));
      }) ?? null;
    }
    if (!focus && plan.entities.rank && slateRows[plan.entities.rank - 1]) focus = slateRows[plan.entities.rank - 1];
    if (!focus && plan.depth !== "SLATE") focus = slateRows[0] ?? null;
  }
  const sportKey: string | null = focus?.sport_key ?? state.sport
    ?? (slateRows[0]?.sport_key ?? null);
  const mod = sportModule(sportKey);

  /* ---- 3. market depth on the focused signal ---------------------------- */
  if (focus && (wants("sharp_reference") || wants("market"))) {
    evidence.push(...await dal.getSharpReference(focus.event_id, focus.market, focus.selection));
  }
  let movement: ReturnType<typeof movementRead> | null = null;
  if (focus && wants("line_movement")) {
    const sigKey = `${focus.event_id}|${focus.market}|${focus.selection}${focus.point != null ? "|" + focus.point : ""}`;
    const mv = await dal.getLineMovement(sigKey);
    evidence.push(...mv);
    const series = (mv[0]?.value as any)?.series ?? null;
    movement = movementRead(num(focus.best_dec), series);
  }

  /* Cross-market structure: what the markets on this game say about each other.
     A per-signal board cannot express agreement or conflict between them, so
     this is where spots live that no amount of scanning the board surfaces. */
  let cross: CrossFlag[] = [];
  if (focus?.event_id && plan.depth !== "QUICK") {
    const cm = await dal.getCrossMarket(focus.event_id);
    evidence.push(...cm.ev);
    cross = crossMarketFlags(cm.rows);
  }
  if (focus && wants("closing_line")) {
    evidence.push(...await dal.getClosingLine(focus.event_id));
  }
  if (focus && wants("model")) {
    evidence.push(...await dal.getModel(focus.event_id));
  }

  /* ---- 4. sport-specific research --------------------------------------- */
  const isMlb = sportKey === "baseball_mlb" || (!sportKey && plan.entities.teams.length > 0);
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
    evidence.push(...card.ev.filter(inScope).slice(0, plan.depth === "SLATE" ? 90 : 30));
  }

  if (isMlb && (wants("pitcher_features") || wants("opponent_offense") || wants("workload"))) {
    const pf = await dal.getPitcherFeatures();
    data_path.pitcher_features = pf.path;
    evidence.push(...pf.ev.slice(0, plan.depth === "SLATE" ? 120 : 40));
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
  let memory = { facts: [] as any[], outcomes: [] as any[], patterns: [] as any[], prior: [] as any[] };
  if (wants("memory")) {
    const entities = Array.from(new Set([
      ...state.teams,
      ...evidence.filter((e) => e.field === "probable_starter").map((e) => String(e.entity)),
    ])).slice(0, 8);
    const m = await dal.getResearchMemory(entities, sportKey);
    memory = { facts: m.facts, outcomes: m.outcomes, patterns: m.patterns, prior: m.prior };
    // A "pattern" below the configured sample floor is not a pattern.
    memory.patterns = memory.patterns.filter((p) => (num(p.sample_size) ?? 0) >= MIN_PATTERN_N);
    evidence.push(...m.ev.slice(0, 25));
  }

  /* ---- 7. thesis attack, on owned numbers only -------------------------- */
  const attack = focus ? attackThesis(focus) : null;

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

  /* ---- 9. completeness + per-entity coverage ---------------------------
     "Not on file" is only honest when nothing is on file. When 33 of 40 games
     carry pitcher quality and 7 do not, the answer must say exactly that and
     then use the 33. */
  const comp = completeness(evidence, sportKey);
  /* The universe is the LIVE slate, not everything the card holds.
     getMlbCard queries a three-day ET window because ingest writes dates in its
     own timezone, so yesterday's completed starters were landing in the
     denominator — which is why coverage read 30 of 60 when the fallback had in
     fact covered the whole playable card. Ranking today's matchups against
     yesterday's finished games is not a data gap, it is the wrong question. */
  const liveDays = new Set([etDay(0), etDay(1)]);
  const starterEv = evidence.filter((e) => e.field === "probable_starter" && e.status !== "UNAVAILABLE");
  const onLiveSlate = (e: Evidence) => {
    const v = e.value as any;
    const d = v?.game_date ? String(v.game_date).slice(0, 10) : null;
    if (d && !liveDays.has(d)) return false;
    return String(v?.status ?? "").toLowerCase() !== "final";
  };
  const scoped = starterEv.filter(onLiveSlate);
  const starters = Array.from(new Set((scoped.length ? scoped : starterEv).map((e) => String(e.entity))));
  data_path.slate_scope = {
    starters_on_card: starterEv.length, starters_on_live_slate: scoped.length,
    days_counted: Array.from(liveDays),
    note: "Coverage is measured against the live slate. Completed games from the card's lookback window are excluded from the denominator.",
  };
  const games = Array.from(new Set(
    evidence.filter((e) => e.field === "game").map((e) => String(e.entity)),
  ));
  const cov: ReturnType<typeof coverage>[] = [];
  if (starters.length) {
    cov.push(coverage(evidence, "pitcher_quality", starters));
    cov.push(coverage(evidence, "opponent_offense", starters));
    cov.push(coverage(evidence, "workload", starters));
  }
  if (games.length) cov.push(coverage(evidence, "weather", games));

  /* ---- 10. research packet versioning -----------------------------------
     Reduce this game's research state to comparable scalars, fetch the last
     stored packet, and diff. This is what makes "what changed since we last
     looked at this?" a factual answer instead of a guess. */
  let snapshot: Snapshot | null = null;
  let changed: ReturnType<typeof diffSnapshots> | null = null;
  if (focus?.event_id) {
    const prev = await dal.getLastSnapshot(focus.event_id);
    snapshot = buildSnapshot(focus.event_id, evidence, focus, (prev?.version ?? 0) + 1);
    changed = diffSnapshots(prev, snapshot);
  }

  /* ---- 11. structured findings, derived from evidence only --------------- */
  const findings = extractFindings(evidence);

  /* ---- 12. proactive research queue ------------------------------------- */
  const queue = slateRows.length ? scout(slateRows) : [];

  return {
    plan, state, evidence, conflicts, unavailable: unavail, attack, memory,
    data_path, focus, calls: dal.calls, ms: Date.now() - t0, log: dal.log,
    completeness: comp, coverage: cov, snapshot, changed, findings, queue,
    cross, movement, integrity: dataIntegrity(evidence),
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


function buildUserContent(body: any, research: ResearchOut | null): string {
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

    /* Placed BEFORE the evidence, deliberately: the verdict has to be read
       before the numbers it governs, not after them. */
    {
      const g = research.integrity;
      parts.push(
        `DATA INTEGRITY — ${g.verdict}\n`
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

    const usable = research.evidence.filter((e) => e.status !== "UNAVAILABLE");
    if (usable.length) {
      /* EVIDENCE_MAX is deliberately large: a 30-starter MLB slate serializes
         to ~69,000 characters, and the old 60,000 default silently severed it
         mid-object. Evidence is the one block that must never be trimmed to
         make room for something else — it is the entire factual basis of the
         answer. Whole items only, and anything withheld is named below. */
      const b = budgetEvidence(usable, EVIDENCE_MAX);
      parts.push(
        "EVIDENCE — retrieved from EdgeDesk's own tables just now. These are the facts you may use; "
        + "quote their values exactly and respect each item's status and freshness:\n"
        + b.text,
      );
      if (b.droppedNote) parts.push("EVIDENCE WITHHELD — " + b.droppedNote);
      (research as any).evidence_shown = { included: b.included, withheld: b.dropped };
    }

    if (research.attack) {
      parts.push(
        "THESIS ATTACK (deterministic, computed from owned signal fields — do not recompute):\n"
        + compact(research.attack),
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
    if (mem.facts.length || mem.outcomes.length || mem.patterns.length || mem.prior.length) {
      parts.push(
        `RESEARCH MEMORY — EdgeDesk's own accumulated history. Patterns below already clear the `
        + `${MIN_PATTERN_N}-sample floor; always state the N. Prior outcomes are historical, never proof about today:\n`
        + compact({ facts: mem.facts, prior_outcomes: mem.outcomes, patterns: mem.patterns, prior_sessions: mem.prior }),
      );
    }

    parts.push(
      `RESEARCH COMPLETENESS: ${research.completeness.pct}%\n`
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
    default: return "Research this and give a decision with the reasoning.";
  }
}

/* ======================================================================== */
/* MEMORY WRITE-BACK                                                        */
/* ======================================================================== */

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

      await post("research_outcomes?on_conflict=user_id,event_id,market,selection", {
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

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "missing bearer" }, 401);
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const history = Array.isArray(body?.history) ? body.history.slice(-8) : [];

  /* --- plan ------------------------------------------------------------- */
  const plan = classify(String(body?.question ?? ""), String(body?.mode ?? ""));
  const state = deriveState(history, plan, body?.packet, null);

  /* --- research --------------------------------------------------------- */
  let research: ResearchOut | null = null;
  if (RESEARCH_ENABLED && SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const dal = new Dal({
        supabaseUrl: SUPABASE_URL, apikey: SUPABASE_ANON_KEY,
        authorization: auth, budget: plan.budget, mlbFallback: MLB_FALLBACK,
      });
      research = await runResearch(plan, state, body?.packet, dal);
    } catch {
      // Retrieval blew up entirely — degrade to packet-only narration, which is
      // exactly the behaviour this function had before the research layer.
      research = null;
    }
  }

  /* --- synthesize -------------------------------------------------------- */
  const messages = [
    ...history
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: m.content })),
    { role: "user", content: buildUserContent(body, research) },
  ];

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
        max_tokens: MAX_TOKENS[plan.depth] ?? 1000,
        system: SYSTEM,
        messages,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return json({ error: `anthropic ${r.status}`, detail }, 502);
    }
    const data = await r.json();
    const answer = (data?.content ?? [])
      .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
    if (!answer) return json({ error: "empty completion" }, 502);

    // Fire-and-forget memory write.
    const remember = rememberSession(auth, body, research, answer);
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(remember); else remember.catch(() => {});

    return json({
      answer,
      model: data?.model ?? MODEL,
      cached: false,
      // Additive. Older clients ignore it; the panel can render a research trace.
      research: research
        ? {
          intent: research.plan.intent, mode: research.plan.mode, depth: research.plan.depth,
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
            failed: research.integrity.checks.filter((c) => c.status !== "PASS"),
          },
          unavailable: research.unavailable,
          conflicts: research.conflicts.length,
          attack: research.attack?.status ?? null,
          completeness: research.completeness,
          coverage: research.coverage.map((c) => ({ field: c.field, have: c.have_n, total: c.total_n })),
          data_path: research.data_path,
        }
        : { intent: plan.intent, mode: plan.mode, depth: plan.depth, retrievals: 0, note: "retrieval unavailable — answered from the attached packet only" },
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 502);
  }
}

// Guarded so the module can be imported by tests without starting a server.
if (typeof Deno !== "undefined" && (Deno as any).serve && !Deno.env.get("EDGEDESK_AI_NO_SERVE")) {
  Deno.serve(handle);
}

