// ============================================================
//  FILE:    supabase/functions/close/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy close --no-verify-jwt
// ============================================================
// CLOSE — snapshots the closing line just before kickoff and computes price CLV.
// Finds signals whose event starts soon and aren't closed yet, re-prices, stores
// the closing fair + CLV.
//
// INTEGRITY: a CLV is only computed from a REAL, COHERENT close. Implausible or
// pulled closes are stamped in clv_excluded_reason and clv is left null — never
// fabricated. Guards are banded so valid two-way markets (e.g. MLB) always pass.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE BUGS FIXED — these are why the record shows 903 flagged but only 238
// with CLV, and why days go missing.
//
// 1. THE CLOSE WINDOW HAD NO RECOVERY PATH  (the "doesn't pick up every day" bug)
//    The query was:
//        .gte("commence_time", now) .lte("commence_time", now + 35min)
//    A signal is only ever eligible during the 35 minutes before its own first
//    pitch. Miss one cron tick — a cold start, a deploy, a rate limit, an hourly
//    schedule instead of a sub-35-minute one — and every event that started in
//    the gap becomes PERMANENTLY ineligible, because from then on
//    commence_time < now fails the gte. closed_at stays null forever and the
//    signal can never receive a CLV. There was no catch-up and no counter, so
//    the loss was invisible.
//    Fixed with a lookback window (CLOSE_GRACE_MIN) so a late run still catches
//    events that just started, plus an explicit sweep that closes long-past
//    stragglers as `missed_close_window` — turning silent permanent loss into a
//    visible number you can watch go to zero.
//
// 2. A PROVIDER HICCUP PERMANENTLY BURNED SIGNALS
//    `if (!ok) continue;` skipped a sport whose odds fetch failed, and then the
//    grading loop found no snapshot for its signals and wrote
//    clv_excluded_reason='line_pulled_no_close' WITH closed_at set. Once
//    closed_at is set the row is never revisited, so a transient API error
//    permanently marked good signals as having no close. The two cases —
//    "the book pulled the line" and "we failed to ask" — were indistinguishable.
//    Now a sport whose fetch failed is SKIPPED entirely this run and retried on
//    the next one.
//
// 3. A MISSING ENTRY PRICE FABRICATED CLV = -100%
//    `clv = (p.best_dec ?? 0) * closeFair - 1` yields exactly -1 when best_dec
//    is null. That is a fabricated -100% CLV in a pipeline whose whole claim is
//    that nothing is estimated, and it drags the headline average down. A signal
//    with no frozen entry price is now excluded as `no_entry_price`.
// ─────────────────────────────────────────────────────────────────────────────
import { db, authorized, json } from "../_shared/db.ts";
import { fetchOdds, priceEvent, sigKey } from "../_shared/oddsapi.ts";

const REGIONS = Deno.env.get("CAPTURE_REGIONS") ?? "us";
const MARKETS = Deno.env.get("CAPTURE_MARKETS") ?? "h2h,spreads,totals";
const METHOD = Deno.env.get("DEVIG_METHOD") ?? "shin";
const SHARP = (Deno.env.get("SHARP_BOOK") ?? "pinnacle").toLowerCase();
const WINDOW_MIN = Number(Deno.env.get("CLOSE_WINDOW_MIN") ?? "35"); // grab close this many min before kickoff

// FIX 1: how far AFTER first pitch a signal is still eligible for a close.
// Books commonly keep a pregame market up briefly, and more importantly this is
// what lets a missed cron tick recover instead of losing the event forever.
const GRACE_MIN = Number(Deno.env.get("CLOSE_GRACE_MIN") ?? "180");
// Past this, no honest close is obtainable; close the row so it stops hiding.
const STALE_MIN = Number(Deno.env.get("CLOSE_STALE_MIN") ?? "720");

// --- integrity thresholds (env-tunable) ---
const CLOSE_MAX_DEC = Number(Deno.env.get("CLOSE_MAX_DEC") ?? "30");         // best_dec above this = placeholder, not a price
const CLOSE_MIN_DEC = Number(Deno.env.get("CLOSE_MIN_DEC") ?? "1.02");       // below this = extreme snap
const CLOSE_OVR_LO = Number(Deno.env.get("CLOSE_OVR_LO") ?? "0.98");         // pin two-side overround floor (<1.0 impossible = stale/flip)
const CLOSE_OVR_HI = Number(Deno.env.get("CLOSE_OVR_HI") ?? "1.25");         // ceiling (placeholder market)
const CLOSE_REQUIRE_SHARP = (Deno.env.get("CLOSE_REQUIRE_SHARP") ?? "false").toLowerCase() === "true";

/**
 * The whole close decision, as a pure function so it can be tested without a
 * database or a provider. Returns the CLV to store (or null) and the reason it
 * was excluded (or null). It NEVER returns a number it cannot justify.
 */
export function decideClose(
  entryDec: number | null | undefined,
  o: any | null,
  opts = {
    minDec: CLOSE_MIN_DEC, maxDec: CLOSE_MAX_DEC,
    ovrLo: CLOSE_OVR_LO, ovrHi: CLOSE_OVR_HI, requireSharp: CLOSE_REQUIRE_SHARP,
  },
): { clv: number | null; reason: string | null } {
  if (!o) return { clv: null, reason: "line_pulled_no_close" };

  const closeDec = o.best_dec;
  const closeFair = o.sharp_fair;

  if (closeDec == null || closeDec < opts.minDec || closeDec > opts.maxDec) {
    return { clv: null, reason: "implausible_close_price" };       // 50 / 77 placeholders, extreme snaps
  }
  if (closeFair == null || !(closeFair > 0) || !(closeFair < 1)) {
    return { clv: null, reason: "invalid_close_fair" };            // de-vig produced a non-probability
  }
  if (opts.requireSharp && o.has_sharp === false) {
    return { clv: null, reason: "no_sharp_at_close" };             // opt-in: require Pinnacle anchor at close
  }

  // pin two-side overround, only if the pricer surfaced both sides
  if (o.pin_dec != null && o.pin_opp_dec != null && o.pin_dec > 1 && o.pin_opp_dec > 1) {
    const overround = 1 / o.pin_dec + 1 / o.pin_opp_dec;
    if (overround < opts.ovrLo || overround > opts.ovrHi) {
      return { clv: null, reason: "incoherent_close_market" };     // fav/dog flip, one-sided/stale market
    }
  }

  /* FIX 3: the old code did `(p.best_dec ?? 0) * closeFair - 1`, so a null
     entry price produced exactly -1 — a fabricated -100% CLV. There is no
     honest CLV without a frozen entry price. */
  if (entryDec == null || !(entryDec > 1)) {
    return { clv: null, reason: "no_entry_price" };
  }

  return { clv: entryDec * closeFair - 1, reason: null };
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const horizon = new Date(now + WINDOW_MIN * 60000).toISOString();
  const graceFloor = new Date(now - GRACE_MIN * 60000).toISOString();
  const staleFloor = new Date(now - STALE_MIN * 60000).toISOString();

  /* FIX 1: the eligible window now reaches BACKWARD as well as forward. The old
     `gte(commence_time, now)` made a signal eligible only in the 35 minutes
     before its own first pitch, so a single missed tick lost it permanently. */
  const { data: pending } = await db.from("signals")
    .select("sig_key,sport_key,event_id,best_dec,sharp_fair,commence_time")
    .is("closed_at", null)
    .gte("commence_time", graceFloor)
    .lte("commence_time", horizon)
    .order("commence_time", { ascending: true })
    .limit(5000);

  /* Stragglers: started longer ago than the grace window and still unclosed.
     No honest close exists for these, but leaving closed_at null hides them
     from every count forever. Close them with a reason so the gap is visible
     and, once the schedule is right, this number should trend to zero. */
  const { data: stale } = await db.from("signals")
    .select("sig_key,sport_key,commence_time")
    .is("closed_at", null)
    .lt("commence_time", graceFloor)
    .gte("commence_time", staleFloor)
    .limit(2000);

  let sweptStale = 0;
  for (const s of stale ?? []) {
    const { error } = await db.from("signals").update({
      clv: null, clv_excluded_reason: "missed_close_window", closed_at: nowIso,
    }).eq("sig_key", s.sig_key);
    if (!error) sweptStale++;
  }

  if (!pending?.length) {
    return json({ ok: true, closed: 0, swept_missed_window: sweptStale,
      note: sweptStale ? "no live close window, but stragglers were swept — check the cron interval against CLOSE_WINDOW_MIN" : undefined });
  }

  /* FIX 2: track which sports actually priced. A sport whose fetch failed is
     skipped this run rather than having every one of its signals permanently
     stamped 'line_pulled_no_close' — that made a transient API error
     indistinguishable from a book pulling the line, and irreversible. */
  const sports = [...new Set(pending.map((p) => p.sport_key))];
  const fresh = new Map<string, any>();
  const fetchOk = new Set<string>();
  const providers: Record<string, any> = {};
  for (const sport of sports) {
    try {
      const { data, ok } = await fetchOdds(sport, REGIONS, MARKETS);
      if (!ok) { providers[sport] = { ok: false, reason: "provider returned not-ok" }; continue; }
      let priced = 0;
      for (const ev of data) for (const o of priceEvent(ev, METHOD, SHARP)) { fresh.set(sigKey(o), o); priced++; }
      fetchOk.add(sport);
      providers[sport] = { ok: true, events: data.length, priced };
    } catch (e) {
      providers[sport] = { ok: false, reason: String(e).slice(0, 200) };
    }
  }

  let closed = 0, excluded = 0, deferred = 0, updateErrors = 0;
  const byReason: Record<string, number> = {};

  for (const p of pending) {
    // Provider failed for this sport: leave the row open for the next run.
    if (!fetchOk.has(p.sport_key)) { deferred++; continue; }

    const o = fresh.get(p.sig_key) ?? null;
    const { clv, reason } = decideClose(p.best_dec, o);

    if (reason) { excluded++; byReason[reason] = (byReason[reason] ?? 0) + 1; }

    const { error } = await db.from("signals").update({
      closing_dec: o?.best_dec ?? null,
      closing_book: o?.best_book ?? null,
      closing_sharp_fair: o?.sharp_fair ?? null,
      closing_has_sharp: o?.has_sharp ?? null,
      closing_n_books: o?.n_books ?? null,
      clv,
      clv_excluded_reason: reason,
      closed_at: nowIso,
    }).eq("sig_key", p.sig_key);

    if (error) { updateErrors++; continue; }
    closed++;
  }

  const summary = {
    ok: true, closed, excluded, priced: closed - excluded,
    deferred_provider_down: deferred, swept_missed_window: sweptStale,
    excluded_by_reason: byReason, updateErrors, providers,
    window: { grace_min: GRACE_MIN, window_min: WINDOW_MIN, stale_min: STALE_MIN },
  };
  console.log("CLOSE", JSON.stringify(summary));
  return json(summary);
});
