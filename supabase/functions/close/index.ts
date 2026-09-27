// ============================================================
//  FILE:    supabase/functions/close/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy close --no-verify-jwt
//  DEBUG:   ?probe=1&secret=YOUR_CRON_SECRET — read-only, browser-openable.
//           Answers "is there nothing to close, or can close not write?"
//           without changing a row. Opening the bare URL with no secret also
//           tells you something: you get a JSON 401 that names the reason,
//           which proves the function is deployed and Verify JWT is off.
//  IMPORTS: NONE from ../_shared. This is ONE FILE. It used to import db.ts and
//           oddsapi.ts, the dashboard bundles only this function's own folder,
//           and a failed bundle leaves the OLD version serving — which is why
//           three revisions of this fix appeared to deploy and did nothing.
// ============================================================
// ─────────────────────────────────────────────────────────────────────────────
// WHY A RUN CAN WRITE NOTHING AT ALL, AND HOW EACH ONE NOW ANNOUNCES ITSELF
//
// The record sitting still is one symptom with four different causes, and the
// old summary could not tell them apart — it counted update failures into
// `updateErrors` and threw the database's message away.
//
//   a. UNAUTHORIZED. CRON_SECRET unset makes authorized() deny everything, so
//      every scheduled tick 401s in silence. The 401 body now says which of
//      "not set" and "did not match" happened.
//   b. MISSING COLUMNS. closing_source / closing_at_observed arrived in a
//      migration. Writing them unconditionally means that if the SQL has not
//      run, EVERY update fails — including the plain live path that worked
//      before. The columns are now probed once and omitted when absent.
//   c. NULL commence_time. In Postgres a NULL fails both `lt` and `gte`, so
//      those rows matched neither the pending window nor the sweep and were
//      invisible to every count. They are now counted.
//   d. WALL CLOCK. The sweep did one UPDATE per row; a 651-row backlog is 651
//      sequential round trips and a real chance of being killed part-way.
//      Write-offs share a payload, so they now go out 500 at a time.
//
// Whatever remains, `write_errors` carries the actual message.
//
// AND ONE THING THIS NO LONGER DOES BY DEFAULT: it does not write off a
// straggler it failed to recover. That stamps closed_at, which is permanent,
// and it is only safe when the tick series is genuinely absent rather than
// merely broken. CLOSE_WRITEOFF=true opts in; until then the count is reported
// as would_write_off and the rows are left alone.
// ─────────────────────────────────────────────────────────────────────────────
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
/* ═══════════════════════════════════════════════════════════════════════════
   SELF-CONTAINED. DO NOT REPLACE THESE WITH ../_shared IMPORTS.

   The Supabase dashboard bundles ONLY the folder of the function you are
   editing. This file used to import ../_shared/db.ts and ../_shared/oddsapi.ts;
   when those are not sitting in the folder the bundle fails, the deploy is
   rejected, AND THE PREVIOUS VERSION KEEPS SERVING — which from the outside is
   indistinguishable from a deploy that worked and changed nothing. That is
   exactly what happened here, repeatedly.

   Everything below is copied verbatim from _shared/db.ts and
   _shared/oddsapi.ts. The de-vig, the pricing and above all sigKey are
   UNCHANGED — sigKey builds the primary key that capture wrote, so a single
   character of drift makes every lookup in this function match zero rows and
   write nothing, silently. If the shared files change, mirror the change here.
   ═══════════════════════════════════════════════════════════════════════════ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- from _shared/db.ts -----------------------------------------------------
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

// ---- from _shared/oddsapi.ts ------------------------------------------------
const ODDS_KEY = Deno.env.get("ODDS_API_KEY") ?? "";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

/* ── PARITY WITH CAPTURE ─────────────────────────────────────────────────────
   CLV is entry_dec x closing_fair - 1. capture computes the entry; this file
   computes the fair. Until v7 the two were not computing the same thing, in
   four separate ways:

     1. THIS FILE COULD NOT REACH THE REFERENCE BOOK AT ALL. fetchOdds only
        ever built &regions=, defaulting to "us", and it had no knowledge of
        CAPTURE_BOOKMAKERS. Pinnacle is an `eu` book, so `s.sharp` was null on
        every selection of every event, and

            const sharp = s.sharp ?? cons;

        silently substituted the consensus of the same soft books the price was
        being measured against — character for character the v8 line capture v9
        was written to delete. The entry edge was anchored on Pinnacle and the
        close on the US soft-book median: two different quantities, differenced,
        and stored as CLV. This is the constant offset learn's fairDrift() kept
        reporting and could not name.

     2. devig() RETURNED A NON-DISTRIBUTION ON AN UNDERROUND BOOK. Shin and
        power both solve for a parameter that SHRINKS implied probabilities down
        to a unit sum; when they already sum below 1 there is nothing to shrink
        and no root exists in either bracket. The old bisect had no way to say
        so — it returned a midpoint — and the fairs came back summing to 0.704.
        That still satisfies 0 < fair < 1, so it was stored as a real CLV.

     3. THE CONSENSUS WAS A PLAIN MEDIAN OVER BOOKMAKER ROWS. Several brands on
        one trading desk voted once each, and the book offering the best price
        helped compute the number its own price was judged against.

     4. THE COHERENCE GUARD WAS DEAD CODE. decideClose reads o.pin_dec and
        o.pin_opp_dec; priceEvent never set them, so `incoherent_close_market`
        has never once fired.

   All four are fixed. The fair is now LABELLED with the rule that produced it
   (closing_reference_type) and stamped with CLOSE_POLICY, so rows priced by the
   old code and rows priced by this one can never be averaged into one number.
   No history is rewritten — close_v7_parity.sql labels the old rows in place.

   THE COPIES BELOW MUST TRACK capture/index.ts. The dashboard bundles one
   folder, so a ../_shared import fails the bundle silently and leaves the old
   version serving. tools/capture/pricer_parity.test.js slices this block out of
   this file and runs it against the real capture module, so a divergence is a
   red build rather than a slow drift in the record.
   ────────────────────────────────────────────────────────────────────────── */

const list = (name: string, dflt: string): string[] =>
  (Deno.env.get(name) ?? dflt).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/* Read the SAME env vars capture reads, so one configuration drives both halves
   of every CLV. A bookmaker list substitutes for the regions term and reaches
   Pinnacle for the price of one region-equivalent; without one the default is
   `us,eu`, which is the corrected default capture v9 ships, NOT the `us` that
   made the reference book structurally unreachable. */
const BOOKMAKERS = list("CAPTURE_BOOKMAKERS", "");
const REGIONS = Deno.env.get("CAPTURE_REGIONS") ?? "us,eu";
const REFERENCE_BOOKS = list("CAPTURE_REFERENCE_BOOKS", "pinnacle");
const MARKETS = Deno.env.get("CAPTURE_MARKETS") ?? "h2h,spreads,totals";
const METHOD = Deno.env.get("DEVIG_METHOD") ?? "shin";

/* How many INDEPENDENT families must remain after the best-priced family is
   removed before a consensus is allowed to stand in for a missing reference.
   capture's Tier B asks for 3-4 families total, which leaves a pack of 2-3;
   this is deliberately at the permissive end of that, because the question here
   is "can this close be measured at all", not "should this be bet". */
const MIN_PACK = Number(Deno.env.get("CLOSE_MIN_PACK_FAMILIES") ?? "2");

/* Stamped on every row this build closes. The point is not the string, it is
   that a reader can segment on it: rows closed before parity were measured
   against a different reference and must never be averaged with these. */
export const CLOSE_POLICY = Deno.env.get("CLOSE_POLICY") ?? "close-2026.09.1";

async function fetchOdds(sport: string, markets: string) {
  const scope = BOOKMAKERS.length
    ? `bookmakers=${encodeURIComponent(BOOKMAKERS.join(","))}`
    : `regions=${encodeURIComponent(REGIONS)}`;
  const u = `${ODDS_BASE}/sports/${sport}/odds/?apiKey=${ODDS_KEY}&${scope}`
    + `&markets=${encodeURIComponent(markets)}&oddsFormat=decimal&dateFormat=iso`;
  const r = await fetch(u);
  return { data: r.ok ? await r.json() : [], quota: r.headers.get("x-requests-remaining") ?? "", ok: r.ok };
}

/** Bisection that can say "there is no root here" instead of returning a
    midpoint that means nothing. Copied from capture. */
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

/** Copied from capture verbatim. Every difference between these two functions
    is a difference in every CLV, so they are compared in CI. */
export function devig(decs: number[], method = "shin"): number[] {
  const q = decs.map((d) => 1 / d);
  const S = q.reduce((a, b) => a + b, 0);
  const normalised = () => q.map((x) => x / S);
  if (!Number.isFinite(S) || S <= 0) return decs.map(() => 0);
  if (method === "multiplicative") return normalised();

  /* AN UNDERROUND BOOK HAS NO MARGIN TO REMOVE. Both Shin and power solve for a
     parameter that SHRINKS the implied probabilities down to 1; when they already
     sum below 1 there is nothing to shrink and no root exists in either bracket.
     Proportional normalisation is the correct and only honest answer. */
  if (!(S > 1)) return normalised();

  if (method === "power") {
    const k = bisect((kk) => q.reduce((a, x) => a + Math.pow(x, kk), 0) - 1, 0.5, 8);
    if (k == null) return normalised();
    const out = q.map((x) => Math.pow(x, k));
    const s2 = out.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(s2) || s2 <= 0) return normalised();
    return out.map((x) => x / s2);
  }

  const fair = (z: number) => q.map((qi) => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / S) - z) / (2 * (1 - z)));
  const z = bisect((zz) => fair(zz).reduce((a, b) => a + b, 0) - 1, 1e-9, 0.5);
  if (z == null) return normalised();
  const out = fair(z);
  const s2 = out.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(s2) || s2 <= 0) return normalised();
  return out.map((x) => x / s2);
}

export const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

/** Drop one value from each tail before taking the middle, when there is enough
    to afford it. Below five observations this is exactly a median. Copied from
    capture, because a consensus computed two different ways is two different
    numbers. */
export const trimmedMedian = (a: number[]): number => {
  if (a.length < 5) return median(a);
  const s = [...a].sort((x, y) => x - y);
  return median(s.slice(1, s.length - 1));
};

/* Two brands on one trading desk are ONE opinion however many rows the feed
   sends. Copied from capture; only operators that are genuinely one desk are
   listed, because wrongly merging two independent books is a worse error than
   failing to merge two related ones. */
export const BOOK_FAMILY: Record<string, string> = {
  betonlineag: "betonline",
  lowvig: "betonline",
  caesars: "caesars",
  williamhill_us: "caesars",
  bovada: "bodog",
  bodog: "bodog",
};
function parseJsonEnv<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return (v && typeof v === "object") ? v as T : fallback; }
  catch { return fallback; }
}
const FAMILY_OVERRIDES = parseJsonEnv<Record<string, string>>(
  Deno.env.get("CAPTURE_FAMILY_OVERRIDES"), {});

export function bookFamily(key: string, overrides: Record<string, string> = FAMILY_OVERRIDES): string {
  const k = String(key ?? "").toLowerCase();
  if (overrides && overrides[k]) return overrides[k];
  return BOOK_FAMILY[k] ?? k;
}

export interface Outcome {
  event_id: string; sport_key: string; sport_title: string; commence_time: string;
  home_team: string; away_team: string; market: string; selection: string; point: number | null;
  best_dec: number; best_book: string;
  /* The closing fair. When reference_type is "sharp" this is the reference
     book's own de-vigged probability; when it is "robust_consensus" it is the
     trimmed median of the independent families that are NOT the best-priced
     one. It is never one silently standing in for the other. */
  sharp_fair: number | null;
  reference_type: "sharp" | "robust_consensus" | "none";
  reference_book: string | null;
  consensus_fair: number | null;
  n_books: number; n_families: number; pack_families: number;
  has_sharp: boolean;
  /* The reference book's own two sides, so decideClose's overround coherence
     check has the data it has always asked for and never received. */
  pin_dec: number | null; pin_opp_dec: number | null;
  ref_age_s: number | null;
}

type Q = { book: string; family: string; dec: number; fair: number; ageS: number | null };

/**
 * Price one event the way capture prices it.
 *
 * The reference book is chosen by the PRIORITY ORDER of referenceBooks rather
 * than by whichever the feed listed first, because an anchor that changes
 * identity between two runs of the same slate is not an anchor.
 */
export function priceEvent(
  ev: any, method: string, referenceBooks: string[] = REFERENCE_BOOKS, nowMs = Date.now(),
): Outcome[] {
  const out: Outcome[] = [];
  const mkts: Record<string, Record<string, {
    name: string; point: number | null; quotes: Q[];
    refPair: { dec: number; opp: number } | null;
  }>> = {};

  for (const bk of ev.bookmakers ?? []) {
    const key = String(bk.key ?? "").toLowerCase();
    const family = bookFamily(key);
    for (const mk of bk.markets ?? []) {
      const decs = (mk.outcomes ?? []).map((o: any) => o.price);
      if (decs.length < 2 || decs.some((d: number) => !d || d <= 1)) continue;
      const fair = devig(decs, method);
      /* Market-level last_update where the feed gives one, else the bookmaker's.
         A missing timestamp is UNKNOWN, never zero: unknown is not young. */
      const stampRaw = mk.last_update ?? bk.last_update ?? null;
      const stamp = stampRaw ? Date.parse(String(stampRaw)) : NaN;
      const ageS = Number.isFinite(stamp) ? Math.max(0, Math.round((nowMs - stamp) / 1000)) : null;

      mk.outcomes.forEach((o: any, i: number) => {
        const pt = o.point ?? null;
        const okey = o.name + (pt != null ? "|" + pt : "");
        mkts[mk.key] = mkts[mk.key] ?? {};
        const slot = mkts[mk.key][okey] ?? (mkts[mk.key][okey] = {
          name: o.name, point: pt, quotes: [], refPair: null,
        });
        slot.quotes.push({ book: key, family, dec: o.price, fair: fair[i], ageS });
        /* Both sides of the reference book's own two-way market, for the
           overround coherence check. Only meaningful when the market really is
           two-sided; a three-way market has no single opposite. */
        if (referenceBooks.includes(key) && decs.length === 2) {
          slot.refPair = { dec: decs[i], opp: decs[1 - i] };
        }
      });
    }
  }

  for (const mk in mkts) for (const okey in mkts[mk]) {
    const s = mkts[mk][okey];
    if (!s.quotes.length) continue;

    /* One quote per operator family. Where a family has several, the FRESHEST
       wins, then the best priced, so the family is represented by its most
       current number. Identical rule to capture. */
    const byFamily = new Map<string, Q>();
    for (const q of s.quotes) {
      const cur = byFamily.get(q.family);
      if (!cur) { byFamily.set(q.family, q); continue; }
      const a = q.ageS ?? Number.MAX_SAFE_INTEGER, b = cur.ageS ?? Number.MAX_SAFE_INTEGER;
      if (a < b || (a === b && q.dec > cur.dec)) byFamily.set(q.family, q);
    }
    const indep = [...byFamily.values()];
    const best = s.quotes.reduce((a, b) => (b.dec > a.dec ? b : a));

    let ref: Q | null = null;
    for (const rb of referenceBooks) {
      const q = s.quotes.find((x) => x.book === rb);
      if (q) { ref = q; break; }
    }

    let fairProb: number | null = null;
    let refType: Outcome["reference_type"] = "none";
    let refAge: number | null = null;
    let pack = 0;

    if (ref) {
      fairProb = ref.fair; refType = "sharp"; refAge = ref.ageS;
    } else {
      /* THE BEST-PRICE BOOK IS REMOVED FROM ITS OWN FAIR VALUE. Without this,
         on a four-book market the book being measured supplies a quarter of the
         number it is measured against. Same rule capture applies at entry. */
      const packQ = indep.filter((q) => q.family !== best.family);
      pack = packQ.length;
      if (pack >= MIN_PACK) {
        fairProb = trimmedMedian(packQ.map((q) => q.fair));
        refType = "robust_consensus";
        /* The age of a consensus is the MEDIAN age of the books that formed it,
           and a missing age counts as unknown rather than fresh. */
        const ages = packQ.map((q) => q.ageS).filter((v): v is number => v != null);
        refAge = ages.length ? median(ages) : null;
      }
    }

    const consensus = indep.length ? trimmedMedian(indep.map((q) => q.fair)) : null;

    out.push({
      event_id: ev.id, sport_key: ev.sport_key, sport_title: ev.sport_title,
      commence_time: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team,
      market: mk, selection: s.name, point: s.point,
      best_dec: best.dec, best_book: best.book,
      sharp_fair: fairProb, reference_type: refType,
      reference_book: ref ? ref.book : null,
      consensus_fair: consensus,
      n_books: s.quotes.length, n_families: indep.length, pack_families: pack,
      has_sharp: ref != null,
      pin_dec: s.refPair ? s.refPair.dec : null,
      pin_opp_dec: s.refPair ? s.refPair.opp : null,
      ref_age_s: refAge,
    });
  }
  return out;
}

/* THE TRAILING PIPE IS LOAD-BEARING. A selection with no point still ends in
   "|", so an h2h key reads `<event>|h2h|<name>|`. Anything that rebuilds this
   key and drops that pipe matches zero rows. */
export const sigKey = (o: { event_id: string; market: string; selection: string; point: number | null }) =>
  `${o.event_id}|${o.market}|${o.selection}|${o.point ?? ""}`;

const WINDOW_MIN = Number(Deno.env.get("CLOSE_WINDOW_MIN") ?? "35"); // grab close this many min before kickoff

// FIX 1: how far AFTER first pitch a signal is still eligible for a close.
// Books commonly keep a pregame market up briefly, and more importantly this is
// what lets a missed cron tick recover instead of losing the event forever.
const GRACE_MIN = Number(Deno.env.get("CLOSE_GRACE_MIN") ?? "180");
/* CLOSE_STALE_MIN is gone. It was the far edge of the straggler sweep, and it
   was the reason a backlog older than 12 hours matched neither the pending
   window nor the sweep and sat unclosed forever. There is no upper age limit
   now: past the grace window a row is either recovered from its tick series or
   written off, and either way it stops hiding. */

// --- integrity thresholds (env-tunable) ---
const CLOSE_MAX_DEC = Number(Deno.env.get("CLOSE_MAX_DEC") ?? "30");         // best_dec above this = placeholder, not a price
const CLOSE_MIN_DEC = Number(Deno.env.get("CLOSE_MIN_DEC") ?? "1.02");       // below this = extreme snap
const CLOSE_OVR_LO = Number(Deno.env.get("CLOSE_OVR_LO") ?? "0.98");         // reference two-side overround floor (<1.0 impossible = stale/flip)
const CLOSE_OVR_HI = Number(Deno.env.get("CLOSE_OVR_HI") ?? "1.25");         // ceiling (placeholder market)
/* Now that the reference book is actually reachable, this means what it says.
   Under the old fetch it could never have been satisfied by anything. */
const CLOSE_REQUIRE_SHARP = (Deno.env.get("CLOSE_REQUIRE_SHARP") ?? "false").toLowerCase() === "true";

/* May the sweep permanently write off a straggler it could not recover?
   Default NO. See the block at the write-off loop for why this is not the
   conservative-looking-but-wrong choice it appears to be. */
const ALLOW_WRITEOFF = (Deno.env.get("CLOSE_WRITEOFF") ?? "false").toLowerCase() === "true";

/**
 * WHICH PRICE IS CLV MEASURED FROM?
 *
 * This is the -2.09% constant offset the learning loop found across every edge
 * band, and it is a measurement artifact rather than a market result.
 *
 * capture prices the FULL board every pass, so a selection is inserted the
 * first time it appears anywhere — usually before it is a signal at all, with
 * no edge. `first_best_dec` is written on that pass and frozen. A row becomes a
 * signal LATER, when a soft book's price drifts out and an edge appears, so the
 * flagged price is typically BETTER than the first-seen price.
 *
 * Computing CLV from the first-seen price therefore charges the scanner for a
 * price it never offered, and understates CLV on every row. `flagged_best_dec`
 * is the price EdgeDesk actually put in front of the user; that is the entry.
 *
 * The fallback chain is deliberate and the basis is reported, because a row
 * graded on a different basis is not comparable and that has to be visible
 * rather than averaged in silently.
 */
export function entryPrice(p: {
  flagged_best_dec?: number | null; first_best_dec?: number | null; best_dec?: number | null;
}): { dec: number | null; basis: "flagged" | "first_seen" | "current" | "none" } {
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 1;
  if (ok(p.flagged_best_dec)) return { dec: p.flagged_best_dec!, basis: "flagged" };
  if (ok(p.first_best_dec)) return { dec: p.first_best_dec!, basis: "first_seen" };
  if (ok(p.best_dec)) return { dec: p.best_dec!, basis: "current" };
  return { dec: null, basis: "none" };
}

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
  /* No reference AND too thin a pack to stand in for one. There is no honest
     fair here, so there is no CLV. Distinguished from invalid_close_fair
     because they need different fixes: this one is book coverage, that one is
     a de-vig that produced something that is not a probability. */
  if (o.reference_type === "none" || closeFair == null) {
    return { clv: null, reason: "no_close_reference" };
  }
  if (!(closeFair > 0) || !(closeFair < 1)) {
    return { clv: null, reason: "invalid_close_fair" };            // de-vig produced a non-probability
  }
  if (opts.requireSharp && o.has_sharp === false) {
    return { clv: null, reason: "no_sharp_at_close" };             // opt-in: require Pinnacle anchor at close
  }

  /* Two-side overround on the REFERENCE book. Until v7 priceEvent never set
     pin_dec/pin_opp_dec, so this guard read undefined and never fired once. It
     now has the data it always asked for. */
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


/* ---------------------------------------------------------------------------
   LAST-TICK CLOSE — the fix for records that fall weeks behind on tennis.

   TWO FAILURES STACKED ON TOP OF EACH OTHER.

   (a) Tennis tournament keys ROTATE. capture discovers them by prefix, so a
       signal is stored under something like tennis_atp_washington. When that
       tournament ends the provider drops the key, fetchOdds returns not-ok, the
       sport is (correctly) skipped rather than being stamped line_pulled, and
       every unclosed signal under that key is deferred on the next run, and the
       next, forever. MLB and NFL have durable keys, which is exactly why only
       tennis fell weeks behind while the rest of the board stayed current.

   (b) The straggler sweep then GOT TO THOSE ROWS FIRST. It matches anything
       unclosed whose event started before the grace floor — which is every one
       of those rotated-key rows within three hours — and stamped them
       missed_close_window with clv null. closed_at is set, so the row is never
       revisited. Recovering only the rows still inside the pending window, as
       the first version of this fix did, was therefore nearly useless: by the
       time a key rotates its signals are already days old and the sweep has
       long since buried them.

   No LIVE close can ever be obtained for those rows. But capture wrote a price
   series to signal_ticks the whole time the market was open, and the last tick
   before first pitch is a REAL OBSERVED PRICE, not an estimate. It is a weaker
   close than a live one — it is the last price we saw, not the last price that
   existed — so it is stored with closing_source = "last_tick" and counted
   separately, rather than being quietly averaged in with live closes.

   Recovery is applied in BOTH places: the sweep and the pending loop.
--------------------------------------------------------------------------- */
type TickClose = { best_dec: number; sharp_fair: number | null; at: string };

/** One tick row -> a usable close, or null. Pure so it can be tested. */
export function tickToClose(
  t: { best_dec?: unknown; sharp_fair?: unknown; created_at?: string } | null | undefined,
): TickClose | null {
  if (!t) return null;
  const dec = Number(t.best_dec);
  if (!Number.isFinite(dec) || dec <= 1) return null;
  const sfRaw = t.sharp_fair == null ? NaN : Number(t.sharp_fair);
  return {
    best_dec: dec,
    sharp_fair: Number.isFinite(sfRaw) ? sfRaw : null,
    at: String(t.created_at ?? ""),
  };
}

type PendingRow = {
  sig_key: string; sport_key?: string; commence_time?: string | null;
  flagged_best_dec?: number | null; first_best_dec?: number | null; best_dec?: number | null;
};

/**
 * Last pregame tick per signal.
 *
 * Ticks recorded AFTER first pitch are rejected: that is an in-play price, not
 * a close, and grading a pregame entry against it would be measuring two
 * different markets against each other.
 */
async function lastTickCloses(rows: PendingRow[]): Promise<Map<string, TickClose>> {
  const out = new Map<string, TickClose>();
  const cutoff = new Map<string, number>();
  for (const r of rows) {
    const t = Date.parse(String(r.commence_time ?? ""));
    cutoff.set(r.sig_key, Number.isFinite(t) ? t : Infinity);
  }

  const BATCH = 25, LIMIT = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { data, error } = await db.from("signal_ticks")
      .select("sig_key,best_dec,sharp_fair,created_at")
      .in("sig_key", batch.map((r) => r.sig_key))
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    const page = error ? [] : (data ?? []);

    for (const t of page) {
      if (out.has(t.sig_key)) continue;                 // desc order: first sighting is the latest tick
      const ts = Date.parse(String(t.created_at));
      if (Number.isFinite(ts) && ts > (cutoff.get(t.sig_key) ?? Infinity)) continue;   // in-play, not a close
      const c = tickToClose(t as any);
      if (c) out.set(t.sig_key, c);
    }

    /* A FULL page means one busy key's history can crowd every other key in the
       batch out of the result entirely. Silently treating those as "no ticks"
       would send a recoverable row to missed_close_window permanently — the
       exact failure this function exists to end — so anything still unresolved
       after a full page is asked for on its own. */
    if (page.length < LIMIT) continue;
    for (const r of batch) {
      if (out.has(r.sig_key)) continue;
      const q = db.from("signal_ticks")
        .select("sig_key,best_dec,sharp_fair,created_at")
        .eq("sig_key", r.sig_key);
      const { data: one } = await (r.commence_time ? q.lte("created_at", r.commence_time) : q)
        .order("created_at", { ascending: false }).limit(1);
      const c = tickToClose((one ?? [])[0] as any);
      if (c) out.set(r.sig_key, c);
    }
  }
  return out;
}

/**
 * The tick-close decision, with no database in it.
 *
 * A tick carries no opposing price, so the two-side overround check cannot run
 * and is passed as nulls rather than being faked — decideClose skips a guard it
 * has no data for instead of inventing one.
 */
export function tickCloseResult(p: PendingRow, t: TickClose) {
  const entry = entryPrice(p);
  const { clv, reason } = decideClose(entry.dec, {
    best_dec: t.best_dec, sharp_fair: t.sharp_fair,
    /* The tick's sharp_fair was written by CAPTURE, so it already carries
       capture's own reference — this path never had the substitution bug. It is
       labelled "tick" rather than "sharp" because it is the last price we SAW,
       not the last price that existed, and the two should never be pooled. */
    reference_type: t.sharp_fair == null ? "none" : "tick",
    has_sharp: null, pin_dec: null, pin_opp_dec: null,
  });
  return { clv, reason, basis: entry.basis };
}

/* ---------------------------------------------------------------------------
   DEPLOY ORDER MUST NOT BE ABLE TO BRICK THIS FUNCTION.

   closing_source and closing_at_observed arrived in a migration. Writing them
   unconditionally means that if the SQL has not been run, EVERY update in this
   function fails on "column does not exist" — including the ordinary live path
   that worked before. A function that silently degrades from partly-working to
   writing nothing, because of the order two deploys happened in, is a worse
   failure than the one it was added to fix.

   So the columns are probed once per run and simply omitted when absent. The
   answer is reported in the summary, because "your record is missing the source
   labels" and "close is broken" need to look different from the outside.
--------------------------------------------------------------------------- */
async function hasColumn(table: string, col: string): Promise<boolean> {
  const { error } = await db.from(table).select(col).limit(1);
  return !error;
}

/** Write a tick-derived close. Shared by the straggler sweep and the pending
    loop so both recover on identical terms and stamp the same basis. */
async function writeTickClose(p: PendingRow, t: TickClose, nowIso: string, srcCols: boolean, refCols: boolean) {
  const { clv, reason, basis } = tickCloseResult(p, t);
  const { error } = await db.from("signals").update({
    closing_dec: t.best_dec,
    closing_sharp_fair: t.sharp_fair,
    ...(srcCols ? { closing_source: "last_tick", closing_at_observed: t.at || null } : {}),
    ...(refCols ? {
      closing_reference_type: t.sharp_fair == null ? "none" : "tick",
      closing_policy: CLOSE_POLICY,
    } : {}),
    clv, clv_excluded_reason: reason, closed_at: nowIso,
  }).eq("sig_key", p.sig_key);
  return { error, clv, reason, basis };
}

Deno.serve(async (req) => {
  /* An unset CRON_SECRET makes authorized() deny everything, so a scheduler
     that never sends the header produces a silent 401 on every tick and a
     record that simply stops advancing. Say which of the two it was. */
  const url = new URL(req.url);
  const probe = url.searchParams.get("probe") === "1";

  /* A browser cannot send x-cron-secret, so a diagnostic that only accepts the
     header is a diagnostic nobody can run at the moment they need it. The same
     secret is accepted as ?secret= — it is not a second credential and not a
     weaker one, it is the same value in a place you can paste. Use it for
     manual checks; leave the schedule on the header, where it stays out of
     request logs. */
  const qSecret = url.searchParams.get("secret") ?? "";
  const envSecret = Deno.env.get("CRON_SECRET") ?? "";
  const ok = authorized(req) || (envSecret !== "" && qSecret === envSecret);

  if (!ok) {
    /* This body is itself the first diagnostic: opening the function URL in a
       browser gets you here, and which sentence you see says whether the
       secret is missing or merely mismatched. Reaching this at all proves the
       function is deployed and that "Verify JWT" is off — a gateway 401 looks
       nothing like this. */
    return json({
      error: "unauthorized",
      deployed: true, build: "close-v7-parity",
      why: envSecret === ""
        ? "CRON_SECRET is not set on this function, so EVERY request is denied — including the scheduled ones. This alone stops the record advancing. Set it in the function's secrets, then send the same value as the x-cron-secret header from the schedule."
        : "CRON_SECRET is set, but this request carried neither a matching x-cron-secret header nor a matching ?secret= parameter.",
      probe_hint: "Append ?probe=1&secret=YOUR_CRON_SECRET to this URL for a read-only report on what close can see and whether it can write.",
    }, 401);
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const horizon = new Date(now + WINDOW_MIN * 60000).toISOString();
  const graceFloor = new Date(now - GRACE_MIN * 60000).toISOString();

  /* Errors are CARRIED, not counted. The previous version did
     `if (error) { updateErrors++; continue; }`, which is how a run that writes
     nothing at all can report a clean-looking summary with a number in it and
     no way to find out why. */
  const writeErrors: string[] = [];
  /* PostgREST puts the useful half of an error in details/hint/code. The
     message on its own is often just "Bad Request", which is how a URL-length
     failure became an unexplainable no-op. Carry all of it. */
  const noteError = (e: any) => {
    if (!e || writeErrors.length >= 6) return;
    const parts = [e.message, e.code && `code=${e.code}`, e.details, e.hint].filter(Boolean);
    writeErrors.push((parts.length ? parts.join(" · ") : String(e)).slice(0, 400));
  };

  const srcCols = await hasColumn("signals", "closing_source");
  /* The v7 parity columns. Probed, not assumed: writing a column the migration
     has not added yet fails EVERY update in this function, including the plain
     live path that worked before, and a function that stops writing because of
     the order two deploys happened in is a worse failure than the one it was
     added to fix. */
  const refCols = await hasColumn("signals", "closing_reference_type");

  /* ---- ?probe=1 : read-only. What close can see and what it would do. ----
     Answers the only question worth asking when the record stops moving:
     is there nothing to close, or is close unable to write? */
  if (probe) {
    const count = async (q: any) => {
      const { count: c, error } = await q;
      return error ? `ERROR ${error.message}` : c;
    };
    const base = () => db.from("signals").select("sig_key", { count: "exact", head: true }).is("closed_at", null);
    const { data: oldest } = await db.from("signals")
      .select("sig_key,sport_key,commence_time").is("closed_at", null)
      .not("commence_time", "is", null)
      .order("commence_time", { ascending: true }).limit(3);
    const { data: newest } = await db.from("signals")
      .select("sig_key,sport_key,commence_time").is("closed_at", null)
      .not("commence_time", "is", null)
      .order("commence_time", { ascending: false }).limit(3);
    // a real write, immediately undone, on one row we already own
    let writeTest = "not attempted — nothing unclosed to test on";
    const victim = oldest?.[0]?.sig_key;
    if (victim) {
      /* Writes closed_at = null on a row whose closed_at is ALREADY null. It
         exercises the real write path and cannot change a value. */
      const { error } = await db.from("signals").update({ closed_at: null }).eq("sig_key", victim);
      writeTest = error ? `WRITE FAILED — ${error.message}` : "writes succeed";
    }
    return json({
      ok: true, build: "close-v7-probe",
      columns: {
        closing_source: srcCols ? "present" : "MISSING — run the migration; source labels will be omitted until you do",
        closing_reference_type: refCols ? "present"
          : "MISSING — run close_v7_parity.sql. Everything else is still written, but until you do there is no way "
            + "to tell a Pinnacle-anchored close from a consensus one, or a v7 row from a pre-parity row.",
      },
      /* The whole point of v7: which books this run can actually see. If
         reference_books are not inside the scope, every close falls back to a
         labelled consensus and Tier-A-equivalent CLV is unreachable. */
      pricing: {
        scope: BOOKMAKERS.length ? `bookmakers=${BOOKMAKERS.join(",")}` : `regions=${REGIONS}`,
        reference_books: REFERENCE_BOOKS,
        reference_reachable: BOOKMAKERS.length
          ? REFERENCE_BOOKS.some((b) => BOOKMAKERS.includes(b))
          : REGIONS.split(",").map((r) => r.trim()).includes("eu"),
        devig_method: METHOD, min_pack_families: MIN_PACK, policy: CLOSE_POLICY,
      },
      unclosed_total: await count(base()),
      unclosed_past_grace: await count(base().lt("commence_time", graceFloor)),
      unclosed_in_window: await count(base().gte("commence_time", graceFloor).lte("commence_time", horizon)),
      unclosed_null_commence: await count(base().is("commence_time", null)),
      oldest_unclosed: oldest, newest_unclosed: newest,
      write_test: writeTest,
      write_off_enabled: ALLOW_WRITEOFF,
      window: { grace_min: GRACE_MIN, window_min: WINDOW_MIN, now: nowIso },
    });
  }

  /* FIX 1: the eligible window now reaches BACKWARD as well as forward. The old
     `gte(commence_time, now)` made a signal eligible only in the 35 minutes
     before its own first pitch, so a single missed tick lost it permanently. */
  /* flagged_best_dec / first_best_dec are requested so CLV can be measured
     from the price actually offered. If a deployment predates those columns the
     select falls back, and the basis counts in the summary make it obvious. */
  const COLS_FULL = "sig_key,sport_key,event_id,best_dec,first_best_dec,flagged_best_dec,sharp_fair,commence_time";
  const COLS_MIN = "sig_key,sport_key,event_id,best_dec,sharp_fair,commence_time";
  let { data: pending, error: pendErr } = await db.from("signals")
    .select(COLS_FULL)
    .is("closed_at", null)
    .gte("commence_time", graceFloor)
    .lte("commence_time", horizon)
    .order("commence_time", { ascending: true })
    .limit(5000);

  if (pendErr) {
    const r = await db.from("signals").select(COLS_MIN)
      .is("closed_at", null)
      .gte("commence_time", graceFloor)
      .lte("commence_time", horizon)
      .order("commence_time", { ascending: true })
      .limit(5000);
    pending = r.data;
  }

  /* Stragglers: started longer ago than the grace window and still unclosed.
     No honest close exists for these, but leaving closed_at null hides them
     from every count forever. Close them with a reason so the gap is visible
     and, once the schedule is right, this number should trend to zero. */
  /* The sweep had a FLOOR as well as a ceiling — `gte(commence_time, staleFloor)`
     — which quietly reintroduced the very bug the sweep exists to kill. Anything
     older than CLOSE_STALE_MIN (12h by default) matched neither the pending
     window nor the sweep, so a single outage longer than half a day orphaned
     those rows permanently: closed_at null forever, invisible to every count.
     The floor is gone. The sweep now reaches back without limit, takes the
     newest stragglers first and works in bounded batches, so a long outage
     drains over successive runs instead of stranding a day of signals. The
     remaining backlog is reported rather than left to be inferred. */
  /* AND — the part that was silently destroying the tennis record — the sweep
     now tries the tick series BEFORE writing anything off. A rotated tournament
     key is guaranteed to reach the sweep rather than the pending window, so
     recovery that only ran in the pending loop never fired for the rows that
     needed it. Sweeping a row that has a recorded pregame price is throwing
     away a close we already own. */
  const STALE_BATCH = 2000;
  const STALE_COLS_FULL = "sig_key,sport_key,commence_time,best_dec,first_best_dec,flagged_best_dec";
  const STALE_COLS_MIN = "sig_key,sport_key,commence_time,best_dec";
  let { data: stale, error: staleErr } = await db.from("signals")
    .select(STALE_COLS_FULL)
    .is("closed_at", null)
    .lt("commence_time", graceFloor)
    .order("commence_time", { ascending: false })
    .limit(STALE_BATCH);
  if (staleErr) {
    const r = await db.from("signals").select(STALE_COLS_MIN)
      .is("closed_at", null)
      .lt("commence_time", graceFloor)
      .order("commence_time", { ascending: false })
      .limit(STALE_BATCH);
    stale = r.data;
  }

  /* Signals with NO commence_time matched neither the pending window nor the
     sweep: in Postgres a NULL fails both `lt` and `gte`, so those rows sat
     unclosed forever and never appeared in any count. They cannot be closed
     honestly — there is no kickoff to snapshot against — but they can stop
     hiding. */
  const { data: noTime } = await db.from("signals")
    .select("sig_key").is("closed_at", null).is("commence_time", null).limit(2000);

  const staleRows: PendingRow[] = (stale ?? []) as PendingRow[];
  const staleTicks = staleRows.length ? await lastTickCloses(staleRows) : new Map<string, TickClose>();

  let sweptStale = 0, recoveredStale = 0, recoveredExcluded = 0;
  const staleBasis: Record<string, number> = {};
  const staleReason: Record<string, number> = {};

  /* Recoveries need a per-row payload. Write-offs do not — they all get the
     same three values, so they go out as ONE request per 500 rows instead of
     one per row. At 651 stragglers the old loop was 651 sequential round trips,
     which is a real chance of hitting the wall clock and writing only part of
     the backlog before the invocation is killed. */
  const writeOff: string[] = [];
  for (const s of staleRows) {
    const t = staleTicks.get(s.sig_key);
    if (!t) { writeOff.push(s.sig_key); continue; }
    const r = await writeTickClose(s, t, nowIso, srcCols, refCols);
    if (r.error) { noteError(r.error); writeOff.push(s.sig_key); continue; }
    recoveredStale++;
    if (r.clv != null) staleBasis[r.basis] = (staleBasis[r.basis] ?? 0) + 1;
    else { recoveredExcluded++; if (r.reason) staleReason[r.reason] = (staleReason[r.reason] ?? 0) + 1; }
  }
  for (const k of (noTime ?? []).map((r) => r.sig_key)) writeOff.push(k);

  /* ------------------------------------------------------------------------
     WRITE-OFF IS OFF BY DEFAULT, AND THAT IS DELIBERATE.

     Stamping missed_close_window sets closed_at, and a row with closed_at set
     is never revisited by anything in this pipeline. It is irreversible.

     That is safe ONLY if the tick series is genuinely absent. If tick capture
     is merely broken — a failing insert, a wrong key, a retention window —
     then every row written off here becomes unrecoverable at the exact moment
     it would otherwise have become recoverable. A scheduled run doing that
     silently to a whole backlog is the worst outcome available.

     Leaving a row unclosed costs nothing but a number in a count. So the sweep
     RECOVERS by default and reports what it would have written off. Set
     CLOSE_WRITEOFF=true only once close_backfill?diag=1 has confirmed there is
     nothing to recover.
     ------------------------------------------------------------------------ */
  let writeOffSkipped = 0;
  if (!ALLOW_WRITEOFF) {
    writeOffSkipped = writeOff.length;
  } else {
    /* 40, not 500. PostgREST puts every value of an `in` filter into the QUERY
       STRING, and a sig_key is ~50-70 characters whose pipes encode to %7C.
       Five hundred of them is roughly 35KB of URL and the gateway rejects the
       whole request as a bare "Bad Request" — no mention of length, nothing
       written, and a summary that still says ok. */
    for (let i = 0; i < writeOff.length; i += 40) {
      const batch = writeOff.slice(i, i + 40);
      const { error } = await db.from("signals").update({
        clv: null, clv_excluded_reason: "missed_close_window",
        ...(srcCols ? { closing_source: "none" } : {}),
        closed_at: nowIso,
      }).in("sig_key", batch);
      if (error) { noteError(error); continue; }
      sweptStale += batch.length;
    }
  }
  /* A full batch means there is more behind it. Say so, so a backlog that is
     draining is distinguishable from one that is stuck. */
  const staleBacklog = staleRows.length >= STALE_BATCH;

  if (!pending?.length) {
    return json({ ok: true, build: "close-v7-parity", closed: recoveredStale, priced: recoveredStale - recoveredExcluded,
      closed_from_last_tick: recoveredStale, swept_missed_window: sweptStale,
      ...(writeOffSkipped ? { would_write_off: writeOffSkipped,
        write_off_skipped: "Nothing was written off — that is irreversible. Set CLOSE_WRITEOFF=true only after close_backfill?diag=1 shows there is nothing to recover." } : {}),
      null_commence_seen: noTime?.length ?? 0,
      ...(staleBacklog ? { stale_backlog_remaining: true } : {}),
      clv_basis: staleBasis, excluded_by_reason: staleReason,
      ...(srcCols ? {} : { columns_missing: "closing_source — run the migration; labels omitted, everything else still written" }),
      ...(writeErrors.length ? { write_errors: writeErrors } : {}),
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
      const { data, ok } = await fetchOdds(sport, MARKETS);
      if (!ok) { providers[sport] = { ok: false, reason: "provider returned not-ok" }; continue; }
      let priced = 0;
      for (const ev of data) for (const o of priceEvent(ev, METHOD, REFERENCE_BOOKS, now)) { fresh.set(sigKey(o), o); priced++; }
      fetchOk.add(sport);
      providers[sport] = { ok: true, events: data.length, priced };
    } catch (e) {
      providers[sport] = { ok: false, reason: String(e).slice(0, 200) };
    }
  }

  /* Sweep-phase recoveries are already written; they are seeded into the tallies
     here so the summary describes the whole run rather than only its live half. */
  let closed = recoveredStale, excluded = recoveredExcluded, deferred = 0, updateErrors = 0;
  let priced = recoveredStale - recoveredExcluded;
  const byReason: Record<string, number> = { ...staleReason };
  const basis: Record<string, number> = { ...staleBasis };
  const refType: Record<string, number> = {};

  /* Rows whose sport could not be priced live AND whose event has already
     started are never going to get a live close — the key is gone. Reach for
     the tick series before giving up on them. A row whose event is still ahead
     is deferred as before: the market may well be back next run. */
  const stranded = pending.filter((p) =>
    !fetchOk.has(p.sport_key) && Date.parse(String(p.commence_time)) < now);
  const tickClose = stranded.length ? await lastTickCloses(stranded) : new Map<string, TickClose>();
  let fromTick = recoveredStale;

  for (const p of pending) {
    // Provider failed for this sport.
    if (!fetchOk.has(p.sport_key)) {
      const t = tickClose.get(p.sig_key);
      if (!t) { deferred++; continue; }           // still upcoming, or no ticks: retry next run
      /* A real observed price, just not a live one. */
      const r = await writeTickClose(p, t, nowIso, srcCols, refCols);
      if (r.error) { updateErrors++; noteError(r.error); continue; }
      closed++; fromTick++;
      if (r.clv != null) { priced++; basis[r.basis] = (basis[r.basis] ?? 0) + 1; }
      else { excluded++; if (r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1; }
      continue;
    }

    const o = fresh.get(p.sig_key) ?? null;
    const entry = entryPrice(p);
    const { clv, reason } = decideClose(entry.dec, o);

    if (reason) { excluded++; byReason[reason] = (byReason[reason] ?? 0) + 1; }

    const { error } = await db.from("signals").update({
      closing_dec: o?.best_dec ?? null,
      closing_book: o?.best_book ?? null,
      closing_sharp_fair: o?.sharp_fair ?? null,
      closing_has_sharp: o?.has_sharp ?? null,
      closing_n_books: o?.n_books ?? null,
      ...(srcCols ? { closing_source: o ? "live" : "none" } : {}),
      /* WHICH RULE PRODUCED THE FAIR, AND UNDER WHICH POLICY. Without these two
         a reader cannot tell a Pinnacle-anchored close from a consensus one, or
         a v7 row from a pre-parity row, and averaging across either boundary is
         how the -2.09% offset stayed invisible for as long as it did. */
      ...(refCols ? {
        closing_reference_type: o?.reference_type ?? null,
        closing_ref_book: o?.reference_book ?? null,
        closing_n_families: o?.n_families ?? null,
        closing_ref_age_s: o?.ref_age_s ?? null,
        closing_policy: CLOSE_POLICY,
      } : {}),
      clv,
      clv_excluded_reason: reason,
      closed_at: nowIso,
    }).eq("sig_key", p.sig_key);

    if (error) { updateErrors++; noteError(error); continue; }
    closed++;
    refType[o?.reference_type ?? "line_pulled"] = (refType[o?.reference_type ?? "line_pulled"] ?? 0) + 1;
    /* Counted only once the row is actually WRITTEN, and only for rows that
       really carry a CLV. `priced: closed - excluded` could go negative when
       excluded rows also failed to update, because `excluded` counted attempts
       while `closed` counted successes. The basis tally has the same problem in
       reverse: crediting a price basis to a row that was excluded describes a
       measurement that never happened, so it is recorded here instead. */
    if (clv != null) { priced++; basis[entry.basis] = (basis[entry.basis] ?? 0) + 1; }
  }

  const summary = {
    ok: true, build: "close-v7-parity", closed, excluded, priced,
    deferred_provider_down: deferred,
    /* The tennis-recovery counters. closed_from_last_tick going UP while
       swept_missed_window falls is the backlog draining; both stuck at zero
       while deferred_provider_down stays high means capture never wrote ticks. */
    closed_from_last_tick: fromTick, recovered_from_sweep: recoveredStale,
    swept_missed_window: sweptStale,
    ...(writeOffSkipped ? { would_write_off: writeOffSkipped,
      write_off_skipped: "Nothing was written off — that is irreversible. Set CLOSE_WRITEOFF=true only after close_backfill?diag=1 shows there is nothing to recover." } : {}),
    null_commence_seen: noTime?.length ?? 0,
    ...(staleBacklog ? { stale_backlog_remaining: true } : {}),
    excluded_by_reason: byReason, updateErrors, providers,
    /* How each stored fair was arrived at. "sharp" is the reference book's own
       de-vig; "robust_consensus" is the trimmed median of the independent
       families that are not the best-priced one, and it is a WEAKER close that
       is labelled rather than silently pooled. A run that is all consensus
       means the reference book is outside the fetch scope — check
       ?probe=1 pricing.reference_reachable. */
    closing_reference: refType, policy: CLOSE_POLICY,
    /* The actual database messages, not just a count of them. A run that
       writes nothing has to be diagnosable from its own output. */
    ...(writeErrors.length ? { write_errors: writeErrors } : {}),
    ...(srcCols ? {} : { columns_missing: "closing_source — run the migration; labels omitted, everything else still written" }),
    /* Which price each stored CLV was measured from. "first_seen" rows are
       open-to-close and understate CLV; "flagged" is the real entry. */
    clv_basis: basis,
    window: { grace_min: GRACE_MIN, window_min: WINDOW_MIN, sweep_has_no_age_limit: true },
  };
  console.log("CLOSE", JSON.stringify(summary));
  return json(summary);
});
