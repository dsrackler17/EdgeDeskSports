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
/* Odds come from `capture`, not from The Odds API directly. capture already
   prices MMA through the full pipeline — Shin de-vig, one quote per book,
   consensus fair, and the flaggable() discipline that rejects stale or
   mis-keyed quotes — and writes it to public.signals. Reading that instead of
   re-fetching means one source of truth for every price in the app, no second
   opinion to reconcile, and no extra Odds API quota. */
const SIGNALS_SPORT = Deno.env.get("UFC_SIGNALS_SPORT") ?? "mma_mixed_martial_arts";
/* signals lives in `public`; the client above is pinned to the `ufc` schema. */
const pub = createClient(
  Deno.env.get("EDGE_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("EDGE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
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

/* ---- live odds ------------------------------------------------------------
   Reads h2h prices from The Odds API (the licence this project already holds)
   and writes a CONSENSUS decimal per corner into ufc.live_fights.

   Matching is deliberately conservative. A wrong price on a fight is worse than
   no price, so a fight only gets odds when both fighters match a priced bout:
   first on exact normalised names, then on both surnames together. Anything
   less certain is left null and counted in the response as unmatched. */
function median(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function lastName(n: string | null): string | null {
  const s = slug(n);
  if (!s) return null;
  const parts = s.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}
type PricedBout = { a: string | null; b: string | null; prices: Record<string, number[]>; books: number };
/* Fold capture's per-selection signals rows back into one bout per event.
   best_dec is capture's best available quote across the books it saw, already
   past its own sanity checks; n_books is how many books stood behind it. */
export function boutsFromSignals(rows: any[]): PricedBout[] {
  const byEvent = new Map<string, PricedBout>();
  for (const r of rows ?? []) {
    if (r?.market !== "h2h") continue;
    const dec = Number(r?.best_dec);
    if (!Number.isFinite(dec) || dec <= 1) continue;      // never price off a broken quote
    const id = String(r?.event_id ?? "");
    const k = slug(r?.selection);
    if (!id || !k) continue;
    let e = byEvent.get(id);
    if (!e) { e = { a: slug(r?.home_team), b: slug(r?.away_team), prices: {}, books: 0 }; byEvent.set(id, e); }
    (e.prices[k] = e.prices[k] ?? []).push(dec);
    e.books = Math.max(e.books, Number(r?.n_books) || 0);
  }
  return [...byEvent.values()].filter((e) => Object.keys(e.prices).length > 0);
}
function matchBout(bouts: PricedBout[], red: string | null, blue: string | null) {
  const r = slug(red), b = slug(blue);
  if (!r || !b) return null;
  const exact = bouts.find((x) => (x.a === r && x.b === b) || (x.a === b && x.b === r));
  if (exact) return { bout: exact, how: "exact" };
  const rl = lastName(red), bl = lastName(blue);
  if (!rl || !bl || rl === bl) return null;          // identical surnames: too weak to trust
  const surname = bouts.find((x) => {
    const al = x.a ? x.a.split("-").pop() : null, bbl = x.b ? x.b.split("-").pop() : null;
    return (al === rl && bbl === bl) || (al === bl && bbl === rl);
  });
  return surname ? { bout: surname, how: "surname" } : null;
}
function priceFor(bout: PricedBout, name: string | null): number | null {
  const k = slug(name);
  if (!k) return null;
  if (bout.prices[k]) return median(bout.prices[k]);
  const ln = lastName(name);
  if (!ln) return null;
  const key = Object.keys(bout.prices).find((x) => x.split("-").pop() === ln);
  return key ? median(bout.prices[key]) : null;
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

    /* POST {"odds": false} skips the odds request for this run — useful when
       polling fast during a card and you would rather not spend the quota. */
    const reqBody: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const body_odds: unknown = reqBody?.odds;

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

    /* ---- live odds, read from capture's signals ------------------------- */
    const wantOdds = body_odds !== false && state(ev) !== "post" && rows.length > 0;
    let oddsMatched = 0, oddsBySurname = 0, oddsUnmatched = 0, oddsBooks = 0;
    let oddsError: string | null = null, signalRows = 0, oddsAgeMin: number | null = null;
    let oddsNote: string | null = null;
    if (wantOdds) {
      try {
        /* a window around this card, so an unrelated MMA event cannot be
           mistaken for one of tonight's fights */
        const from = new Date(now - 2 * 864e5).toISOString();
        const to = new Date(now + 7 * 864e5).toISOString();
        const sig = await pub.from("signals")
          .select("event_id,home_team,away_team,selection,market,best_dec,n_books,last_seen_at")
          .eq("market", "h2h").eq("sport_key", SIGNALS_SPORT)
          .gte("commence_time", from).lte("commence_time", to)
          .limit(4000);
        if (sig.error) {
          oddsError = `signals: ${sig.error.message}`;
        } else {
          signalRows = (sig.data ?? []).length;
          const stamps = (sig.data ?? []).map((r: any) => new Date(r?.last_seen_at ?? 0).getTime())
            .filter((t: number) => Number.isFinite(t) && t > 0);
          if (stamps.length) oddsAgeMin = Math.round((now - Math.max(...stamps)) / 60000);
          if (!signalRows) {
            /* capture is not covering MMA. Say so precisely — this is a config
               fix, not a missing feature, and it is invisible otherwise. */
            oddsNote = `capture has no ${SIGNALS_SPORT} h2h rows in this window. Add ${SIGNALS_SPORT} to `
              + `CAPTURE_SPORTS (or to CAPTURE_AUTO_PREFIXES) so capture prices the card; until then fights carry no odds.`;
          } else {
            const bouts = boutsFromSignals(sig.data ?? []);
            for (const row of rows as any[]) {
              const m = matchBout(bouts, row.red_name, row.blue_name);
              if (!m) { oddsUnmatched++; continue; }
              const rp = priceFor(m.bout, row.red_name), bp = priceFor(m.bout, row.blue_name);
              if (rp == null && bp == null) { oddsUnmatched++; continue; }
              row.red_odds = rp; row.blue_odds = bp;
              oddsBooks = Math.max(oddsBooks, m.bout.books);
              oddsMatched++;
              if (m.how === "surname") oddsBySurname++;
            }
          }
        }
      } catch (e) { oddsError = String(e); }
    }

    let fightErr: string | null = null;
    if (rows.length) {
      const fRes = await db.from("live_fights").upsert(rows, { onConflict: "fight_id" });
      if (fRes.error) fightErr = `${fRes.error.message} | details:${fRes.error.details ?? ""} | hint:${fRes.error.hint ?? ""}`;
    }

    /* Reconcile the card: drop rows for this event that are no longer on it.
       Without this, a fight_id scheme change or a late replacement bout leaves
       an orphan row and the card renders the fight twice. Only ever runs when
       this poll actually produced fights, so a bad fetch cannot wipe a card. */
    let orphansRemoved = 0, orphanError: string | null = null;
    if (rows.length) {
      const keep = (rows as any[]).map((r) => r.fight_id);
      const del = await db.from("live_fights").delete()
        .eq("event_id", eventId)
        .not("fight_id", "in", `(${keep.map((k) => `"${String(k).replace(/"/g, '""')}"`).join(",")})`)
        .select("fight_id");
      if (del.error) orphanError = del.error.message; else orphansRemoved = (del.data ?? []).length;
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
      odds_matched: oddsMatched,
      odds_matched_by_surname: oddsBySurname,
      odds_unmatched: oddsUnmatched,
      odds_books_seen: oddsBooks,
      odds_source: "capture -> public.signals",
      odds_signal_rows: signalRows,
      odds_age_minutes: oddsAgeMin,
      ...(oddsNote ? { odds_note: oddsNote } : {}),
      odds_error: oddsError,
      orphan_fights_removed: orphansRemoved,
      orphan_error: orphanError,
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
