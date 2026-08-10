// ============================================================
//  FILE:    supabase/functions/settle/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy settle --no-verify-jwt
// ============================================================
// SETTLE — pulls final scores and grades every captured selection (win/loss/push),
// records whether it beat the close.
//
// SELF-CONTAINED: the dashboard bundles a pasted function WITHOUT its sibling
// _shared/ files, so db/auth/json, fetchScores and grade are inlined here.
//
// State model (no field overloaded):
//   graded_at             = a real grade happened. result in win/loss/push/void.
//   terminal_at           = provider-INDEPENDENT impossibility (never gradeable).
//   provider_exhausted_at = current provider can't reach it (REVERSIBLE).
//   settle_reason         = short STABLE code.
// QUEUE = graded_at IS NULL AND terminal_at IS NULL AND provider_exhausted_at IS NULL.
//
//   - `beat_close` is a GENERATED column; never written here (SQLSTATE 428C9).
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE BUGS FIXED IN THIS REVISION
//
// 1. SILENT MIS-GRADING ON TEAM-NAME MISMATCH  (data corruption, highest impact)
//    grade() compared selection to home/away with ===. The scores feed says
//    "Oakland Athletics"; signals often store "Athletics". Consequences:
//      h2h     -> a WINNING bet graded "loss" (selection matched neither side,
//                 so it was compared against the winner and lost)
//      spreads -> null -> `?? "void"`
//      totals  -> unrecognised over/under -> null -> `?? "void"`
//    In every case graded_at was written, so the wrong grade became permanent
//    and fed straight into CLV and every historical read built on it.
//    Fixed by resolving the selection to a side by normalised name, nickname and
//    last-token match — and, crucially, by REFUSING to grade when the selection
//    cannot be resolved. An unresolved row now stays in the queue with
//    settle_reason='unresolved_selection' instead of being silently voided.
//
// 2. QUEUE STARVATION
//    The queue was ordered oldest-first and capped at 5000. The scores provider
//    only serves ~3 days. Once more than 5000 rows sat outside that window, the
//    entire slice was ungradeable and NOTHING ever graded again — the old code
//    could only warn about this. Now the gradeable window is queried separately
//    and always processed first, so fresh rows can never be starved by a backlog.
//
// 3. UNGUARDED SCORE FETCH
//    A provider failure for one sport silently produced zero grades with no
//    signal. Per-sport fetch status is now reported.
//
// PREREQUISITE migration (unchanged):
//   alter table signals add column if not exists terminal_at           timestamptz;
//   alter table signals add column if not exists settle_reason         text;
//   alter table signals add column if not exists provider_exhausted_at timestamptz;
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- inlined from _shared/db.ts -----------------------------------------
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
function authorized(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  return secret !== "" && req.headers.get("x-cron-secret") === secret;
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// ---- inlined from _shared/oddsapi.ts ------------------------------------
const KEY = Deno.env.get("ODDS_API_KEY") ?? "";
const BASE = "https://api.the-odds-api.com/v4";

async function fetchScores(sport: string, daysFrom = 3) {
  const u = `${BASE}/sports/${sport}/scores/?apiKey=${KEY}&daysFrom=${daysFrom}&dateFormat=iso`;
  try {
    const r = await fetch(u);
    if (!r.ok) return { data: [], ok: false, status: r.status, error: await r.text().catch(() => "") };
    return { data: await r.json(), ok: true, status: 200, error: null };
  } catch (e) {
    return { data: [], ok: false, status: 0, error: String(e) };
  }
}

/* ===================== NAME RESOLUTION (the bug-1 fix) ===================== */

/** Fold case, accents and punctuation so "St. Louis Cardinals" == "st louis cardinals". */
export function normTeam(s: unknown): string {
  let t = String(s ?? "").toLowerCase();
  try { t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch { /* older runtimes */ }
  return t.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which side of the game a selection refers to — or null when it genuinely
 * cannot be told. Null is a real answer here: it means "do not grade this",
 * not "void it".
 *
 * Matching is tried in strict-to-loose order so a loose rule can never override
 * an exact one, and an ambiguous match (both sides plausible) returns null
 * rather than guessing.
 */
export function resolveSide(selection: string, home: string, away: string): "home" | "away" | null {
  const s = normTeam(selection), h = normTeam(home), a = normTeam(away);
  if (!s || !h || !a) return null;

  if (s === h && s !== a) return "home";
  if (s === a && s !== h) return "away";

  // nickname: the scores feed carries the city, the signal often does not
  // ("Athletics" vs "Oakland Athletics", "Red Sox" vs "Boston Red Sox").
  const endsH = h.endsWith(" " + s) || h === s;
  const endsA = a.endsWith(" " + s) || a === s;
  if (endsH && !endsA) return "home";
  if (endsA && !endsH) return "away";

  // the other direction: signal carries the city, feed does not
  const startsH = s.endsWith(" " + h) || s === h;
  const startsA = s.endsWith(" " + a) || s === a;
  if (startsH && !startsA) return "home";
  if (startsA && !startsH) return "away";

  // last resort: last token (the club nickname) must match exactly one side
  const last = (x: string) => x.split(" ").filter(Boolean).slice(-1)[0] ?? "";
  const ls = last(s), lh = last(h), la = last(a);
  if (ls && lh !== la) {
    if (ls === lh) return "home";
    if (ls === la) return "away";
  }
  return null;   // ambiguous or unknown — refuse to guess
}

/** over / under, tolerating "o 8.5", "Over", "UNDER 8.5", "u8.5". */
export function totalSide(selection: string): "over" | "under" | null {
  const s = normTeam(selection);
  if (/^(o|over)\b/.test(s) || /\bover\b/.test(s)) return "over";
  if (/^(u|under)\b/.test(s) || /\bunder\b/.test(s)) return "under";
  return null;
}

export type GradeOut =
  | { result: "win" | "loss" | "push"; reason: null }
  | { result: null; reason: "unresolved_selection" | "missing_point" | "missing_score" | "unsupported_market" };

/**
 * Grade one selection. NEVER returns a grade it is not sure of — an unresolved
 * selection comes back as {result:null, reason}, and the caller leaves the row
 * in the queue rather than writing a wrong result that can never be undone.
 */
export function grade(
  market: string, selection: string, point: number | null,
  home: string, away: string, hs: number, as: number,
): GradeOut {
  if (hs == null || as == null || !Number.isFinite(hs) || !Number.isFinite(as)) {
    return { result: null, reason: "missing_score" };
  }

  if (market === "h2h") {
    if (hs === as) return { result: "push", reason: null };
    const side = resolveSide(selection, home, away);
    if (!side) return { result: null, reason: "unresolved_selection" };
    const winner = hs > as ? "home" : "away";
    return { result: side === winner ? "win" : "loss", reason: null };
  }

  if (market === "spreads") {
    if (point == null) return { result: null, reason: "missing_point" };
    const side = resolveSide(selection, home, away);
    if (!side) return { result: null, reason: "unresolved_selection" };
    const teamScore = side === "home" ? hs : as;
    const oppScore = side === "home" ? as : hs;
    const m = teamScore - oppScore + point;
    return { result: m > 0 ? "win" : m === 0 ? "push" : "loss", reason: null };
  }

  if (market === "totals") {
    if (point == null) return { result: null, reason: "missing_point" };
    const dir = totalSide(selection);
    if (!dir) return { result: null, reason: "unresolved_selection" };
    const total = hs + as;
    if (total === point) return { result: "push", reason: null };
    const over = total > point;
    return { result: (dir === "over") === over ? "win" : "loss", reason: null };
  }

  return { result: null, reason: "unsupported_market" };
}

// -------------------------------------------------------------------------

// Odds API scores endpoint serves daysFrom<=3. Keep in sync with mark_provider_exhausted.
const PROVIDER_SCORE_RETENTION_DAYS = 3;

// grading policy: null = gradeable; STABLE code = provider-INDEPENDENT terminal.
const TENNIS_GAME_MARKETS = new Set(["spreads", "totals"]);
export function ungradeableReason(sportKey: string, market: string): string | null {
  if (sportKey.startsWith("tennis_") && TENNIS_GAME_MARKETS.has(market)) {
    return "unsupported_tennis_game_market";   // set scores vs game lines: true for any provider
  }
  return null;
}

const QUEUE_STALE_WARN_DAYS = 14;
const GRADEABLE_LIMIT = 4000;   // rows inside the provider window
const BACKLOG_LIMIT = 1000;     // older rows, scanned only to classify terminals

const SELECT_COLS =
  "sig_key,sport_key,event_id,market,selection,point,home_team,away_team,commence_time,clv";

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - 90 * 60000).toISOString();                       // started >90 min ago
  const windowStart = new Date(Date.now() - PROVIDER_SCORE_RETENTION_DAYS * 864e5).toISOString();

  const base = () => db.from("signals").select(SELECT_COLS)
    .is("graded_at", null).is("terminal_at", null).is("provider_exhausted_at", null);

  /* ---- BUG 2 FIX: the gradeable window is fetched on its own -------------
     Previously one oldest-first slice of 5000 covered everything, so a backlog
     older than the provider window could fill the entire slice and starve every
     fresh row indefinitely. Rows the provider can actually answer for are now
     queried separately and always processed. */
  const { data: gradeable, error: gErr } = await base()
    .gte("commence_time", windowStart).lt("commence_time", cutoff)
    .order("commence_time", { ascending: true }).limit(GRADEABLE_LIMIT);

  // Older rows are still scanned, but only so provider-independent terminals
  // (e.g. tennis game lines) get classified. They can never crowd out the above.
  const { data: backlog } = await base()
    .lt("commence_time", windowStart)
    .order("commence_time", { ascending: true }).limit(BACKLOG_LIMIT);

  if (gErr) return json({ error: gErr.message }, 500);

  const inWindow = gradeable ?? [];
  const outWindow = backlog ?? [];

  const queueHealth = {
    gradeableInWindow: inWindow.length,
    backlogOutsideWindow: outWindow.length,
    oldestActionable: outWindow[0]?.commence_time ?? inWindow[0]?.commence_time ?? null,
    windowDays: PROVIDER_SCORE_RETENTION_DAYS,
  };
  const oldestAge = queueHealth.oldestActionable
    ? (Date.now() - new Date(queueHealth.oldestActionable).getTime()) / 86400000 : 0;
  if (oldestAge > QUEUE_STALE_WARN_DAYS) {
    console.log("QUEUE HEALTH WARNING", JSON.stringify({
      message: "backlog older than the provider window; mark_provider_exhausted may be behind",
      ...queueHealth, oldestActionableAgeDays: Math.round(oldestAge * 10) / 10,
    }));
  }

  if (!inWindow.length && !outWindow.length) {
    return json({ ok: true, graded: 0, queueHealth });
  }

  /* ---- scores, per sport, with the failure surfaced --------------------- */
  const sports = [...new Set(inWindow.map((s) => s.sport_key))];
  const scores = new Map<string, any>();
  const providers: Record<string, any> = {};
  for (const sport of sports) {
    const res = await fetchScores(sport, PROVIDER_SCORE_RETENTION_DAYS);
    let completed = 0;
    if (res.ok) {
      for (const g of res.data) {
        if (!g.completed || !g.scores) continue;
        const hs = Number(g.scores.find((x: any) => x.name === g.home_team)?.score);
        const as = Number(g.scores.find((x: any) => x.name === g.away_team)?.score);
        scores.set(g.id, { home: g.home_team, away: g.away_team, hs, as });
        completed++;
      }
    }
    providers[sport] = { ok: res.ok, status: res.status, completed, ...(res.error ? { error: String(res.error).slice(0, 200) } : {}) };
  }

  let graded = 0, skipNoScore = 0, skipNaN = 0, terminal = 0, updateErrors = 0, unresolved = 0;
  const terminalByReason: Record<string, number> = {};
  const unresolvedByReason: Record<string, number> = {};
  const unresolvedSamples: any[] = [];
  const errorSamples: any[] = [];
  const nowIso = new Date().toISOString();

  for (const s of [...inWindow, ...outWindow]) {
    // provider-independent terminals first — these apply to backlog rows too
    const reason = ungradeableReason(s.sport_key, s.market);
    if (reason) {
      const { error } = await db.from("signals").update({
        terminal_at: nowIso, settle_reason: reason,
      }).eq("sig_key", s.sig_key);
      if (error) {
        updateErrors++;
        if (errorSamples.length < 5) {
          const e = { sport: s.sport_key, sig_key: s.sig_key, phase: "terminal", reason,
            code: (error as any).code, message: error.message };
          errorSamples.push(e); console.log("UPDATE ERROR", JSON.stringify(e));
        }
        continue;
      }
      terminal++;
      terminalByReason[reason] = (terminalByReason[reason] ?? 0) + 1;
      continue;
    }

    const fin = scores.get(s.event_id);
    if (!fin) { skipNoScore++; continue; }
    if (!Number.isFinite(fin.hs) || !Number.isFinite(fin.as)) { skipNaN++; continue; }

    const g = grade(s.market, s.selection, s.point, fin.home, fin.away, fin.hs, fin.as);

    /* ---- BUG 1 FIX: refuse to grade what cannot be resolved -------------
       The old code wrote `grade(...) ?? "void"` plus graded_at, so a name
       mismatch became a permanent wrong grade. Now the row keeps its place in
       the queue with a reason attached, so it can be graded correctly once the
       naming is fixed instead of being silently destroyed. */
    if (g.result == null) {
      unresolved++;
      unresolvedByReason[g.reason] = (unresolvedByReason[g.reason] ?? 0) + 1;
      if (unresolvedSamples.length < 10) {
        unresolvedSamples.push({
          sig_key: s.sig_key, sport: s.sport_key, market: s.market,
          selection: s.selection, home: fin.home, away: fin.away, reason: g.reason,
        });
      }
      await db.from("signals").update({ settle_reason: g.reason }).eq("sig_key", s.sig_key);
      continue;
    }

    const { error } = await db.from("signals").update({
      result: g.result, final_home: fin.hs, final_away: fin.as,
      graded_at: nowIso, settle_reason: null,
    }).eq("sig_key", s.sig_key);

    if (error) {
      updateErrors++;
      if (errorSamples.length < 5) {
        const e = { sport: s.sport_key, sig_key: s.sig_key, result_written: g.result, phase: "grade",
          code: (error as any).code, message: error.message,
          details: (error as any).details, hint: (error as any).hint };
        errorSamples.push(e); console.log("UPDATE ERROR", JSON.stringify(e));
      }
      continue;
    }
    graded++;
  }

  const summary = {
    scanned: inWindow.length + outWindow.length,
    graded, unresolved, unresolvedByReason,
    skipNoScore, skipNaN, terminal, terminalByReason, updateErrors,
    ms: Date.now() - startedAt,
  };
  console.log("SUMMARY", JSON.stringify(summary));
  return json({ ok: true, ...summary, queueHealth, providers, unresolvedSamples, errorSamples });
});
