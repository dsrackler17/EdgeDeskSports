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
  completeness, coverage, num, etDay, rankingAxis, budgetEvidence, evidenceIntegrity,
  buildSnapshot, diffSnapshots, extractFindings, scout,
  crossMarketFlags, movementRead,
  type Evidence, type Plan, type ConvoState, type Completeness,
  type Snapshot, type Finding, type ScoutItem, type CrossFlag, type Integrity,
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

FOOTBALL — WHAT ACTUALLY DECIDES A NUMBER
Rank on EFFICIENCY, never on points per game. Points per game is a pace artifact: a team running 70 plays and one running 58 are not comparable on totals, and the slower one can be far better per snap. EPA per play and success rate are the ranking columns.
- READ THE SIGN. def_epa_play is EPA ALLOWED per play, so NEGATIVE is a good defence. It is the opposite of the offensive column and reversing it inverts every conclusion you draw. Say which direction you are reading whenever you use it.
- MATCH STRENGTH AGAINST WEAKNESS, not strength against average. A pass offence at +0.15 EPA/dropback facing a defence at +0.08 allowed against the pass is a very different bet from the same offence facing -0.10. The opponent's splits are attached to each team; use them.
- THE QUARTERBACK IS THE PITCHER. It is the largest single input, and a backup starting is the biggest predictable line move in the sport. If qb_features is missing, PROBABLE, or is_backup is true, say so in the FIRST line and mark every conclusion resting on it provisional. Never rank a football matchup on team efficiency while ignoring that the quarterback is unconfirmed.
- SITUATION IS REAL BUT SMALL. Short week, off a bye, travel, altitude, neutral site and surface belong in the answer as adjustments to a thesis, never as the thesis. If the only thing you can say about a game is that one side is on a short week, you do not have a read.
- TOTALS ARE PACE FIRST. plays_per_game for both sides, then efficiency, then weather. Wind is the one weather variable that moves a football total materially; temperature almost never does. Do not treat a cold game as an automatic under.

COLLEGE FOOTBALL — AND WHAT IS MISSING
The schedule, rankings, rest, venue and situational layer are ingested. Play-by-play EFFICIENCY is NOT: there is no free CFB feed for EPA or success rate without a CollegeFootballData key, and the missing_note on each row says so. When those fields are absent, say plainly that EdgeDesk does not ingest CFB efficiency yet — do NOT substitute points per game, win-loss record or a ranking and present it as an efficiency read. A ranking is a poll, not a projection. Talent and variance gaps are wider in college than in the NFL, so a thin evidence base deserves a more provisional answer here, not a more confident one.

COLLEGE BASKETBALL — TEMPO-FREE OR NOTHING
Adjusted efficiency is the ranking column: adj_o is points scored per 100 possessions, adj_d is points ALLOWED per 100, and LOWER adj_d is better. adj_em is the margin between them and is the single best one-number summary.
- NEVER rank on points per game. A 62-possession team and an 75-possession team scoring the same total are not comparable, and the whole point of the adjusted numbers is that they already remove pace and schedule.
- THE TOTAL IS A POSSESSION COUNT. Expected possessions come from both adj_tempo values together, not from either alone; then apply the efficiencies. Two excellent slow teams routinely play under.
- THE FOUR FACTORS SAY *HOW*, and they are attached for both offence and defence: shooting (efg), turnovers (tov), rebounding (orb), free throws (ftr). Shooting dominates, but the useful read is a mismatch — a high-turnover offence against a defence that forces turnovers is where a number is actually wrong. Weight them in that order and only where present.
- THREE-POINT VARIANCE IS NOT SKILL. Opponent three-point PERCENTAGE allowed is mostly noise; opponent three-point RATE allowed is a real defensive property. Do not read a hot or cold shooting percentage as a durable edge.
- Experience, height and bench minutes are context for variance, especially early in the season and in neutral-site tournaments. They are tiebreakers, never a thesis.

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

  /* Football and basketball. Same trigger shape as the MLB branch above, so a
     question about matchups, efficiency or a quarterback retrieves the owned
     layer for whichever sport is in scope rather than falling through to
     market-only research. */
  const MULTISPORT = new Set(["americanfootball_nfl", "americanfootball_ncaaf", "basketball_ncaab"]);
  if (sportKey && MULTISPORT.has(sportKey)
    && (wants("team_efficiency") || wants("matchup") || wants("pitcher_features")
      || wants("opponent_offense") || wants("quarterback") || wants("matchup_context"))) {
    const tf = await dal.getTeamFeatures(sportKey);
    data_path.team_features = tf.path;
    evidence.push(...tf.ev.slice(0, plan.depth === "SLATE" ? 140 : 45));
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
    cross, movement, integrity: evidenceIntegrity(evidence, { slateDays: [etDay(0), etDay(1)] }),
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

    const usableAll = research.evidence.filter((e) => e.status !== "UNAVAILABLE");
    /* Budget FIRST, then audit, so the completeness check measures what the
       model is actually about to receive rather than what was retrieved. That
       gap is precisely the bug this layer exists to catch, so it would be
       absurd for the auditor itself to assume delivery. */
    const budget = budgetEvidence(usableAll, EVIDENCE_MAX);
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
        + "quote their values exactly and respect each item's status and freshness:\n"
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
          /* What the CLIENT supplied, reported separately from what the server
             retrieved.

             Without this the trace read "1 retrieval · Sources: signals" under
             an answer full of xERA and barrel rates, because the board the
             browser attached is not server-side evidence and never appeared in
             `sources`. The answer was correctly grounded — every figure matched
             pitcher_features — but the provenance display said otherwise, which
             on a product whose entire claim is provenance is the worst possible
             direction to be wrong in. A reader cannot distinguish that from
             fabrication, and should not have to. */
          client_context: {
            board_games: Array.isArray((body as any)?.board?.games) ? (body as any).board.games.length
              : Array.isArray((body as any)?.board) ? (body as any).board.length : 0,
            packet_attached: !!(body as any)?.packet,
            compare_rows: Array.isArray((body as any)?.compare) ? (body as any).compare.length : 0,
          },
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
