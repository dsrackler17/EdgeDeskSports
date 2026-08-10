// supabase/functions/edgedesk_ai/index.ts
// ============================================================================
// EdgeDesk Intelligence — research engine.
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
//   Now:  question
//           -> classify intent
//           -> build a research plan (with a retrieval budget)
//           -> RETRIEVE from EdgeDesk's own tables, server-side, under the
//              caller's JWT so RLS applies exactly as it does in the browser
//           -> normalize every fact with provenance + freshness
//           -> detect conflicts between owned sources
//           -> attack the thesis on the owned numbers
//           -> read research memory (facts / prior outcomes / patterns)
//           -> Claude synthesizes THAT
//           -> write the session back to memory
//
// WHAT DID NOT CHANGE
//   The deterministic pipeline still owns every number. Nothing in here — and
//   nothing the model is allowed to say — computes or adjusts a probability,
//   fair price, edge, EV, CLV, confidence, score or verdict. The research layer
//   retrieves and interprets; it never models.
//
//   If retrieval fails wholesale, the function degrades to exactly the old
//   packet-only behaviour rather than erroring.
// ============================================================================

import {
  Dal, classify, deriveState, attackThesis, findConflicts, sportModule,
  completeness, coverage, num,
  buildSnapshot, diffSnapshots, extractFindings, scout,
  type Evidence, type Plan, type ConvoState, type Completeness,
  type Snapshot, type Finding, type ScoutItem,
} from "./_lib.ts";

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
  QUICK: 700, STANDARD: 1000, DEEP: 1500, SLATE: 1600, FULL: 1800,
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

BAD vs EXPLOITABLE
Ranking arms by xERA answers a different question than ranking betting targets. A poor starter facing a low-OBP, high-strikeout offense in a pitcher's park is not the best target. A better starter facing a high-OBP, high-ISO offense in a hitter's park, on short rest, with a taxed bullpen behind him, can be far more exploitable. Read each starter's quality against the opponent_offense actually attached to HIM, plus park, weather, workload and bullpen — then whether the market makes it actionable at all. When your top pick is not the statistically worst arm, say so explicitly and say why. Weigh only fields that are present.

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
  coverage: ReturnType<typeof coverage>[];
  snapshot: Snapshot | null;
  changed: ReturnType<typeof diffSnapshots> | null;
  findings: Finding[];
  queue: ScoutItem[];
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
  if (focus && wants("line_movement")) {
    const sigKey = `${focus.event_id}|${focus.market}|${focus.selection}${focus.point != null ? "|" + focus.point : ""}`;
    evidence.push(...await dal.getLineMovement(sigKey));
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
  const starters = Array.from(new Set(
    evidence.filter((e) => e.field === "probable_starter" && e.status !== "UNAVAILABLE")
      .map((e) => String(e.entity)),
  ));
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
  };
}

/* ======================================================================== */
/* PROMPT ASSEMBLY                                                          */
/* ======================================================================== */

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
      + `Steps executed: ${p.steps.join(", ")}\n`
      + `In focus: ${research.state.teams.join(" / ") || "(board-wide)"}\n`
      + `Retrievals: ${research.calls} reads in ${research.ms}ms`,
    );

    const usable = research.evidence.filter((e) => e.status !== "UNAVAILABLE");
    if (usable.length) {
      parts.push(
        "EVIDENCE — retrieved from EdgeDesk's own tables just now. These are the facts you may use; "
        + "quote their values exactly and respect each item's status and freshness:\n"
        + compact(usable),
      );
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

  const post = (table: string, payload: unknown) =>
    fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY, authorization: auth,
        "content-type": "application/json", prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });

  try {
    await post("research_sessions", row);

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
          queue: research.queue.slice(0, 6),
          retrievals: research.calls, ms: research.ms,
          sources: Array.from(new Set(research.evidence.map((e) => e.source))),
          evidence_count: research.evidence.filter((e) => e.status !== "UNAVAILABLE").length,
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
