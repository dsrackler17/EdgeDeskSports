// supabase/functions/ufc_live/index.ts — deploy with Verify JWT OFF
//
// Polls the ESPN MMA scoreboard into ufc.live_events / ufc.live_fights.
//
// Secrets (Edge Functions > Secrets):
//   EDGE_SUPABASE_URL      = https://<project>.supabase.co
//   EDGE_SERVICE_ROLE_KEY  = service_role key
//   CRON_SECRET            = shared secret; callers send it as x-cron-secret
//
// FIXES IN THIS REVISION (each one caused a symptom in the app):
//   1. Stale events were never closed. The old code upserted only the ONE event
//      it selected and left every other row at whatever status it last had, so a
//      card that was 'in' when the poller last ran stayed 'in' forever. That is
//      why a July event was still being served as live in August. Now every
//      event in the window is reconciled, and any event that started well in the
//      past and is still open is closed out.
//   2. Stats were always null. ESPN reports counts like "12/34" (landed of
//      attempted), and Number("12/34") is NaN, so every value was discarded.
//      Values are now parsed leading-numerically, competitor stat shapes are
//      handled defensively, and "attempted"/"accuracy"/"%" entries are skipped
//      so an attempt count is never stored as if it were landed.
//   3. A missing CRON_SECRET returned a bare 401, indistinguishable from a wrong
//      secret — a silently dead poller. Misconfiguration now says so explicitly.
//   4. fight_id was built from name slugs, so two fights with missing names on
//      one card collided and overwrote each other. ESPN's own competition id is
//      used when present.
//
// Nothing here invents a number. A field ESPN does not publish stays null, and
// the app renders null as "not recorded" rather than zero.

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("EDGE_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("EDGE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false }, db: { schema: "ufc" } },
);

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard";
const SUMMARY = (id: string) => `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/summary?event=${id}`;

/* an event that started this long ago and is still open was never closed out */
const STALE_AFTER_MS = 12 * 3600 * 1000;

function slug(name: string | undefined | null): string | null {
  if (!name) return null;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || null;
}
/* ORDER MATTERS, and this was a real bug: "final" CONTAINS the substring "in",
   so the old `t.includes("in")` test classified a FINISHED event as in-progress.
   ESPN also sends status as a name like "STATUS_FINAL" when state is absent, so
   a completed card was written as status 'in' and then stayed there forever —
   the stuck row this poller kept serving. Finished is now checked first, and
   "in" is matched as a word rather than as a substring. */
const IN_WORD = /(^|[^a-z])in([^a-z]|$)/;
function statusOf(s: string | undefined): string {
  const t = (s || "").toLowerCase();
  if (t.includes("post") || t.includes("final") || t.includes("complete")) return "post";
  if (t.includes("progress") || IN_WORD.test(t)) return "in";
  return "pre";
}
function fightStatus(s: string | undefined): string {
  const t = (s || "").toLowerCase();
  if (t.includes("final") || t.includes("post") || t.includes("complete")) return "final";
  if (t.includes("progress") || IN_WORD.test(t)) return "live";
  return "upcoming";
}

/* ---- stat extraction ------------------------------------------------------
   ESPN nests competitor stats differently across feeds, so read defensively and
   return null rather than a guess when nothing matches. */
function statList(c: any): any[] {
  const raw = c?.statistics ?? c?.stats ?? [];
  if (Array.isArray(raw)) {
    if (raw.length && Array.isArray(raw[0]?.stats)) return raw.flatMap((g: any) => g?.stats ?? []);
    return raw;
  }
  if (Array.isArray((raw as any)?.stats)) return (raw as any).stats;
  return [];
}
/* "12/34" -> 12, "12" -> 12, "-" -> null. Never NaN, never a fabricated 0. */
function leadingNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(String(v));
  return m ? Number(m[1]) : null;
}
const SKIP = ["attempt", "accuracy", "percent", "%", "avg", "average", "differential", "defense"];
function pickStat(c: any, wants: string[]): number | null {
  const list = statList(c);
  for (const want of wants) {
    for (const s of list) {
      const key = [s?.name, s?.abbreviation, s?.shortDisplayName, s?.displayName]
        .filter(Boolean).join("|").toLowerCase();
      if (!key.includes(want)) continue;
      if (SKIP.some((bad) => key.includes(bad))) continue;   // never store attempts as landed
      const v = leadingNumber(s?.value ?? s?.displayValue);
      if (v != null) return v;
    }
  }
  return null;
}

function parseCompetition(comp: any, eventId: string, idx: number) {
  const comps = comp?.competitors || [];
  const red = comps.find((c: any) => c?.homeAway === "home") || comps[0] || {};
  const blue = comps.find((c: any) => c?.homeAway === "away") || comps[1] || {};
  const rName = red?.athlete?.displayName ?? red?.athlete?.fullName ?? null;
  const bName = blue?.athlete?.displayName ?? blue?.athlete?.fullName ?? null;
  const st = comp?.status || {};
  /* ESPN's competition id is unique per fight; the slug fallback carries the
     card index so two unnamed fights can never collide on one event. */
  const fightId = comp?.id != null
    ? String(comp.id)
    : `${eventId}_${idx}_${slug(rName) || "red"}_${slug(bName) || "blue"}`;
  return {
    fight_id: fightId,
    event_id: eventId,
    red_name: rName, blue_name: bName,
    red_fighter_id: slug(rName), blue_fighter_id: slug(bName),
    status: fightStatus(st?.type?.state || st?.type?.name),
    round: st?.period ?? null,
    clock: st?.displayClock ?? null,
    red_strikes: pickStat(red, ["significantstrikeslanded", "sigstrikeslanded", "strikeslanded", "significantstrikes", "strike"]),
    blue_strikes: pickStat(blue, ["significantstrikeslanded", "sigstrikeslanded", "strikeslanded", "significantstrikes", "strike"]),
    red_td: pickStat(red, ["takedownslanded", "takedowns", "takedown"]),
    blue_td: pickStat(blue, ["takedownslanded", "takedowns", "takedown"]),
    red_kd: pickStat(red, ["knockdowns", "knockdown", "kd"]),
    blue_kd: pickStat(blue, ["knockdowns", "knockdown", "kd"]),
    red_win_prob: null,          // ESPN does not publish one here; gated in the app
    weight_class: comp?.type?.text || comp?.note || null,
    is_main: !!((comp?.note || "").toLowerCase().includes("main")),
    red_odds: null, blue_odds: null,
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    /* a dead poller must be loud, not a bare 401 */
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (secret === "") {
      return json({
        ok: false,
        error: "CRON_SECRET is not set on this function, so every invocation would 401. " +
          "Set it in Edge Functions > Secrets and send the same value as the x-cron-secret header.",
      }, 500);
    }
    if (req.headers.get("x-cron-secret") !== secret) {
      return json({ ok: false, error: "unauthorized: x-cron-secret missing or did not match CRON_SECRET" }, 401);
    }

    const now = Date.now();
    /* start two days back: a US evening card rolls past midnight UTC, and the
       old today-forward window could miss a fight that was live right then */
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const url = `${SCOREBOARD}?dates=${fmt(new Date(now - 2 * 864e5))}-${fmt(new Date(now + 60 * 864e5))}`;

    let sb: any;
    try {
      const r = await fetch(url);
      if (!r.ok) return json({ ok: false, step: "scoreboard", status: r.status }, 502);
      sb = await r.json();
    } catch (e) {
      return json({ ok: false, step: "scoreboard", error: String(e) }, 502);
    }

    const events: any[] = sb?.events || [];
    const byDate = (a: any, b: any) => new Date(a?.date).getTime() - new Date(b?.date).getTime();
    const state = (e: any) => statusOf(e?.status?.type?.state);
    const live = events.find((e) => state(e) === "in");
    const soonest = events.filter((e) => state(e) === "pre").sort(byDate)[0];
    const lastDone = events.filter((e) => state(e) === "post").sort((a, b) => byDate(b, a))[0];
    const ev = live || soonest || lastDone;

    /* 1. reconcile EVERY event in the window, not just the selected one, so no
          row keeps a status the feed has already moved on from */
    let windowUpserted = 0, eventsError: string | null = null;
    if (events.length) {
      const rows = events.map((e) => ({
        event_id: String(e.id),
        name: e?.name ?? e?.shortName ?? "UFC event",
        status: state(e),
        start_time: e?.date ?? null,
        updated_at: new Date().toISOString(),
      }));
      const r = await db.from("live_events").upsert(rows, { onConflict: "event_id" });
      if (r.error) eventsError = r.error.message; else windowUpserted = rows.length;
    }

    /* 2. close out anything the poller left open in the past. This is what the
          old version never did, and why one stuck card shadowed the board. */
    const cutoff = new Date(now - STALE_AFTER_MS).toISOString();
    let closed = 0, closeError: string | null = null;
    {
      const r = await db.from("live_events")
        .update({ status: "post", updated_at: new Date().toISOString() })
        .lt("start_time", cutoff)
        .neq("status", "post")
        .select("event_id");
      if (r.error) closeError = r.error.message; else closed = (r.data ?? []).length;
    }

    if (!ev) {
      return json({
        ok: true, note: "no UFC events in window", events: events.length,
        window_upserted: windowUpserted, stale_events_closed: closed,
        events_error: eventsError, close_error: closeError, started_at: startedAt,
      });
    }

    const eventId = String(ev.id);
    let comps: any[] = ev?.competitions || [];
    let summaryUsed = false;
    try {
      const r = await fetch(SUMMARY(eventId));
      if (r.ok) {
        const sum = await r.json();
        if (Array.isArray(sum?.competitions) && sum.competitions.length) {
          comps = sum.competitions; summaryUsed = true;
        }
      }
    } catch (_) { /* fall back to the scoreboard's competitions */ }

    const rows = comps
      .map((c: any, i: number) => parseCompetition(c, eventId, i))
      .filter((r: any) => r.red_name || r.blue_name);

    let fightErr: string | null = null;
    if (rows.length) {
      const fRes = await db.from("live_fights").upsert(rows, { onConflict: "fight_id" });
      if (fRes.error) fightErr = `${fRes.error.message} | details:${fRes.error.details ?? ""} | hint:${fRes.error.hint ?? ""}`;
    }

    /* how many fights actually carried a count — the number to watch if the app
       shows a live card with empty stat rows */
    const withStats = rows.filter((r: any) =>
      r.red_strikes != null || r.blue_strikes != null || r.red_td != null ||
      r.blue_td != null || r.red_kd != null || r.blue_kd != null).length;

    return json({
      ok: true,
      started_at: startedAt,
      event: eventId,
      event_name: ev?.name ?? null,
      status: state(ev),
      summary_used: summaryUsed,
      fights: rows.length,
      fights_with_stats: withStats,
      window_events: events.length,
      window_upserted: windowUpserted,
      stale_events_closed: closed,
      events_error: eventsError,
      close_error: closeError,
      fights_error: fightErr,
    });
  } catch (e) {
    return json({ ok: false, started_at: startedAt, crash: String((e as any)?.stack || e) }, 500);
  }
});
