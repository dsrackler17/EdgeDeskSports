// ============================================================
//  FILE:    supabase/functions/capture/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy capture --no-verify-jwt
//  BUILD:   capture-v7-wallclock   (authoritative value: `export const BUILD` below)
//  IMPORTS: NONE from ../_shared. ONE FILE — see the block above the inlined
//           helpers for why that is not a style choice.
// ============================================================
// CAPTURE - runs on a schedule. Prices the FULL board for the configured sports
// and upserts every selection into `signals` (one durable row per outcome/event).
// First sighting sets the opening fields; later runs update best/latest fields.
//
// ─────────────────────────────────────────────────────────────────────────────
// v5 — WHY THE BOARD FILLED WITH EDGES THAT WERE NOT EDGES
//
// THE BUG, MEASURED
//   priceEvent devigs each book independently, takes the MEDIAN fair across
//   books as the consensus, and computes edge = fair x best_dec - 1 where
//   best_dec is the single highest decimal quoted anywhere. Nothing checked
//   whether that highest quote was a real price.
//
//   Four books on a coin-flip market — 1.90/1.95, 1.92/1.93, 1.88/1.98, and one
//   stale or mis-keyed feed at 12.0/1.05 — produce a consensus fair of 0.504
//   and a best price of 12.0. That is an edge of +505%, and it was flagged,
//   stored, and admitted to the record pool exactly like a real signal.
//
//   This is not hypothetical. The learn function reported 458 graded rows with
//   a MEDIAN edge of +40.5% and called them "a pile of broken prices"; they
//   were 13% of everything the loop was learning from. They are also why the
//   board looks wrong: a handful of garbage prices sort to the top of an
//   edge-ordered board and bury every genuine 2-4% edge underneath them.
//
// THE FIX
//   A price EdgeDesk cannot stand behind is STORED and never FLAGGED. Storage
//   is right — it is real market data, and the movement and residual reads want
//   it. Flagging is what puts a number in front of a user and into the record,
//   and that now requires the quote to survive four checks (see `flaggable`):
//   a backable market, a plausible decimal, an edge inside a sane band, and a
//   best price that is not a wild outlier against the other books quoting the
//   same selection. Each rejection is COUNTED BY REASON, so "no edges today"
//   can always be distinguished from "every edge was rejected as a bad price".
//
// AND WHY A BROKEN RUN LOOKED HEALTHY
//   Three separate paths returned ok:true having captured nothing:
//     - CRON_SECRET unset => authorized() is false for every caller, including
//       the scheduler. The function 401s forever and nothing outside can tell.
//     - ODDS_API_KEY unset => every fetch fails, all sports land in `errored`,
//       and the response still said ok:true with priced:0.
//     - CAPTURE_SPORTS empty AND the /sports discovery call failing => an empty
//       sport list, a loop that never runs, and ok:true with sports:0.
//   All three are now hard preconditions that return ok:false and say which
//   one failed. A run that captures nothing is never reported as a success.
//   `errored` carries the HTTP STATUS per sport, because 401 (bad key), 422
//   (bad sport key) and 429 (quota exhausted) need three different fixes and
//   were previously indistinguishable.
//
// ─────────────────────────────────────────────────────────────────────────────
// v6 — THE RUN THAT DIED ON ONE MALFORMED MARKET
//
//   `ev.bookmakers ?? []` and `bk.markets ?? []` were guarded. `mk.outcomes`
//   was not. One market object arriving without an `outcomes` array threw
//     TypeError: Cannot read properties of undefined (reading 'map')
//   out of priceEvent — which is called inside the sport loop with nothing to
//   catch it. The exception unwound past every remaining sport and out of the
//   request handler: no signals written, no ticks, no flags, no telemetry, just
//   a bare 500. And because the scheduler calls capture through net.http_post,
//   which is fire-and-forget and records `succeeded` whatever the HTTP response
//   was, the cron history stayed clean while the board went stale. Reproduced
//   in supabase/tests/capture.test.ts (cases 7-8) before it was fixed.
//
//   FIX: `outcomes` is guarded like its siblings, prices are coerced with
//   Number() and checked with Number.isFinite (a non-numeric price no longer
//   slips past `!d || d <= 1`), and each event is priced inside a try/catch
//   that counts the casualty and keeps going. One bad event costs one event.
//
// v6 — A DUPLICATED LINE FROM ONE BOOK PASSED THE TWO-BOOK CONSENSUS GATE
//
//   n_books was `slot.fairs.length` — the number of QUOTES, not of BOOKS. A
//   single feed listing the same outcome twice therefore reported n_books: 2
//   and satisfied MIN_BOOKS_TO_FLAG, defeating the very check whose comment
//   reads "a fair line resting on one book is that book's own opinion devigged
//   against itself". The same duplicate also double-weighted that book in the
//   consensus median. Quotes are now keyed by book, first quote wins, and
//   best_dec / median_dec are drawn from that same deduped population so the
//   outlier ratio in `flaggable` compares like with like.
//
// PRESERVED FROM v4 (all five fixes still in force)
//   1. Two-phase write so the opening snapshot is never overwritten.
//   2. Phase C freezes the flagged entry price once, guarded on flagged_at IS NULL.
//   3. Exchange lay quotes are stored but never flagged.
//   4. Tick writes default ON and their errors are checked and reported.
//   5. The flag cap DEFERS the weakest candidates to the next run; it never
//      drops the whole batch.
// ─────────────────────────────────────────────────────────────────────────────
/* ═══════════════════════════════════════════════════════════════════════════
   SELF-CONTAINED. DO NOT REPLACE THESE WITH ../_shared IMPORTS.

   The dashboard bundles ONLY the folder of the function you are editing. When a
   relative import cannot resolve, the bundle fails, the deploy is rejected, and
   THE PREVIOUS VERSION KEEPS SERVING — indistinguishable from a deploy that
   worked and changed nothing. Every fix below is worthless if it cannot land.

   Copied verbatim from _shared/db.ts and _shared/oddsapi.ts. sigKey especially:
   it builds the primary key of `signals`, and one character of drift would make
   every row here a NEW signal instead of an update to an existing one — which
   would reset the opening snapshot on the whole board.
   ═══════════════════════════════════════════════════════════════════════════ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const BUILD = "capture-v7-wallclock";

// ---- from _shared/db.ts -----------------------------------------------------
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
function authorized(req: Request): boolean {
  return CRON_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SECRET;
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// ---- from _shared/oddsapi.ts ------------------------------------------------
const ODDS_KEY = Deno.env.get("ODDS_API_KEY") ?? "";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

/** Now returns the STATUS. "errored" without a status cannot be acted on: a bad
    key, a rotated sport key and an exhausted quota are three different fixes. */
async function fetchOdds(sport: string, regions: string, markets: string) {
  const u = `${ODDS_BASE}/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=${regions}&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;
  try {
    const r = await fetch(u);
    const quota = r.headers.get("x-requests-remaining") ?? "";
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { data: [], quota, ok: false, status: r.status, detail: body.slice(0, 200) };
    }
    return { data: await r.json(), quota, ok: true, status: 200, detail: "" };
  } catch (e) {
    return { data: [], quota: "", ok: false, status: 0, detail: String((e as Error)?.message ?? e) };
  }
}
async function fetchActiveSports(): Promise<{ keys: string[]; ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${ODDS_BASE}/sports/?apiKey=${ODDS_KEY}`);
    if (!r.ok) return { keys: [], ok: false, detail: `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
    const list = await r.json();
    return { keys: list.filter((s: any) => s.active && !s.has_outrights).map((s: any) => s.key), ok: true, detail: "" };
  } catch (e) {
    return { keys: [], ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

function bisect(f: (x: number) => number, lo: number, hi: number, it = 80) {
  let fl = f(lo);
  for (let i = 0; i < it; i++) { const m = (lo + hi) / 2, fm = f(m); if (Math.abs(fm) < 1e-10) return m; if ((fl < 0) === (fm < 0)) { lo = m; fl = fm; } else hi = m; }
  return (lo + hi) / 2;
}
export function devig(decs: number[], method = "shin"): number[] {
  const q = decs.map((d) => 1 / d), S = q.reduce((a, b) => a + b, 0);
  if (method === "multiplicative") return q.map((x) => x / S);
  if (method === "power") { const k = bisect((k) => q.reduce((a, x) => a + Math.pow(x, k), 0) - 1, 0.5, 6); return q.map((x) => Math.pow(x, k)); }
  const fair = (z: number) => q.map((qi) => (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / S) - z) / (2 * (1 - z)));
  try { const z = bisect((z) => fair(z).reduce((a, b) => a + b, 0) - 1, 1e-6, 0.5); return fair(z); }
  catch { return q.map((x) => x / S); }
}
export const median = (a: number[]) => { a = [...a].sort((x, y) => x - y); const n = a.length, h = n >> 1; return n % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };

interface Outcome {
  event_id: string; sport_key: string; sport_title: string; commence_time: string;
  home_team: string; away_team: string; market: string; selection: string; point: number | null;
  best_dec: number; best_book: string; sharp_fair: number; consensus_fair: number; edge: number; n_books: number; is_plus_ev: boolean;
  has_sharp: boolean;
  /** Median decimal across every book quoting THIS selection. The reference the
      best price is judged an outlier against. Telemetry + flag discipline only. */
  median_dec: number;
}

export function priceEvent(ev: any, method: string, sharpBook: string): Outcome[] {
  const out: Outcome[] = [];
  const mkts: Record<string, Record<string, any>> = {};
  for (const bk of ev.bookmakers ?? []) {
    const bookKey = String(bk?.key ?? "");
    const isSharp = sharpBook && bookKey.toLowerCase().includes(sharpBook);
    for (const mk of bk.markets ?? []) {
      /* THE FEED IS NOT A CONTRACT. `bookmakers` and `markets` were already
         guarded; `outcomes` was not, so one market object arriving without it
         threw a TypeError out of priceEvent — and priceEvent is called inside
         the sport loop with nothing to catch it. A single malformed market
         therefore killed the WHOLE run: every sport, no writes, no telemetry,
         just a 500 that net.http_post discards. Guarding here restores the
         intended behaviour, which is to skip the market and keep going. */
      const outcomes: any[] = Array.isArray(mk?.outcomes) ? mk.outcomes : [];
      const decs = outcomes.map((o: any) => Number(o?.price));
      if (decs.length < 2 || decs.some((d: number) => !Number.isFinite(d) || d <= 1)) continue;
      const fair = devig(decs, method);
      outcomes.forEach((o: any, i: number) => {
        const pt = o.point ?? null;
        const okey = o.name + (pt != null ? "|" + pt : "");
        mkts[mk.key] = mkts[mk.key] ?? {};
        const slot = mkts[mk.key][okey] ?? (mkts[mk.key][okey] = { name: o.name, point: pt, byBook: new Map<string, { fair: number; dec: number; book: string }>(), sharp: null });
        /* ONE QUOTE PER BOOK PER SELECTION. A book that lists the same outcome
           twice used to push two fairs and two decimals, which inflated n_books
           — so a duplicated line from ONE feed satisfied MIN_BOOKS_TO_FLAG and
           passed the "a single book is not a consensus" gate that exists
           precisely to stop that. It also double-weighted that book in the
           median. First quote wins; the population is now books, not rows. */
        if (slot.byBook.has(bookKey)) return;
        slot.byBook.set(bookKey, { fair: fair[i], dec: decs[i], book: bk.title });
        /* The sharp anchor follows the same first-quote-wins rule, so the fair
           used as the anchor is the same quote counted in the consensus. */
        if (isSharp) slot.sharp = fair[i];
      });
    }
  }
  for (const mk in mkts) for (const okey in mkts[mk]) {
    const s = mkts[mk][okey];
    const quotes = [...s.byBook.values()];
    if (!quotes.length) continue;
    const hasSharp = s.sharp != null;
    /* best_dec and median_dec are drawn from the SAME deduped population, so
       the outlier ratio in `flaggable` compares like with like. */
    const best = quotes.reduce((a, b) => (b.dec > a.dec ? b : a));
    const cons = median(quotes.map((q) => q.fair)), sharp = s.sharp ?? cons, edge = sharp * best.dec - 1;
    out.push({
      event_id: ev.id, sport_key: ev.sport_key, sport_title: ev.sport_title, commence_time: ev.commence_time,
      home_team: ev.home_team, away_team: ev.away_team, market: mk, selection: s.name, point: s.point,
      best_dec: best.dec, best_book: best.book, sharp_fair: sharp, consensus_fair: cons, edge,
      n_books: quotes.length, is_plus_ev: edge > 0, has_sharp: hasSharp,
      median_dec: median(quotes.map((q) => q.dec)),
    });
  }
  return out;
}

/* THE TRAILING PIPE IS LOAD-BEARING. A selection with no point still ends in
   "|". This is the primary key of `signals`; it must not drift. */
export const sigKey = (o: { event_id: string; market: string; selection: string; point: number | null }) =>
  `${o.event_id}|${o.market}|${o.selection}|${o.point ?? ""}`;

const REGIONS = Deno.env.get("CAPTURE_REGIONS") ?? "us";
const MARKETS = Deno.env.get("CAPTURE_MARKETS") ?? "h2h,spreads,totals";
const METHOD = Deno.env.get("DEVIG_METHOD") ?? "shin";
const SHARP = (Deno.env.get("SHARP_BOOK") ?? "pinnacle").toLowerCase();
const TICKS = (Deno.env.get("CAPTURE_TICKS") ?? "true") !== "false";
const SPORTS_ENV = Deno.env.get("CAPTURE_SPORTS") ?? "";
const FLAG_FLOOR = Number(Deno.env.get("CAPTURE_FLAG_FLOOR") ?? "0.005");
const FLAG_MAX = Number(Deno.env.get("CAPTURE_FLAG_MAX") ?? "600");

/* ── FLAG DISCIPLINE ─────────────────────────────────────────────────────
   The bounds a quote must clear before EdgeDesk will put its name on it.

   Deliberately the SAME numbers the rest of the stack already uses, because a
   price the board refuses to display and the grader throws out should never
   have been flagged in the first place:
     - CLOSE_MIN_DEC / CLOSE_MAX_DEC are the tradeable bound close/index.ts
       grades against and edgedesk_ai's signalTradeable() filters on.
     - LEARN_EDGE_MAX is the bound the learning loop already uses to decide a
       row is a broken price rather than an opportunity.
   Sharing them means a flagged signal is, by construction, a signal every
   other component agrees is real. */
const MIN_DEC = Number(Deno.env.get("CLOSE_MIN_DEC") ?? "1.02");
const MAX_DEC = Number(Deno.env.get("CLOSE_MAX_DEC") ?? "30");
const EDGE_SANE_MAX = Number(Deno.env.get("LEARN_EDGE_MAX") ?? "0.25");
/* How far above the median quote the best price may sit before it is treated
   as a broken feed rather than a generous book. Real best-price dispersion on
   a liquid two-way market is a few percent; 1.35 is deliberately loose enough
   that a genuinely soft book still flags. */
const MAX_BEST_VS_MEDIAN = Number(Deno.env.get("CAPTURE_MAX_BEST_RATIO") ?? "1.35");
/* A fair line resting on one book is that book's own opinion devigged against
   itself. Two is the minimum at which "consensus" means anything. */
const MIN_BOOKS_TO_FLAG = Number(Deno.env.get("CAPTURE_MIN_BOOKS") ?? "2");

/* ── WALL CLOCK ──────────────────────────────────────────────────────────
   Capture is one HTTP request and it dies when the platform says so. Every
   write it had not yet issued is lost, and the caller — net.http_post, which
   is fire-and-forget — records a success either way. So the run has to police
   its own clock: finish the sport it is on, skip the rest, RETURN, and say in
   the response exactly what it did not get to. A short honest run beats a long
   one that is killed with its results still in memory.

   110s leaves headroom under the default 150s limit for the final response. */
const BUDGET_MS = Number(Deno.env.get("CAPTURE_MAX_MS") ?? "110000");
/* How many flag freezes are in flight at once. 25 turns a 600-call sequential
   crawl into 24 rounds. Raise it only if PostgREST is comfortable. */
const FLAG_CONCURRENCY = Math.max(1, Number(Deno.env.get("CAPTURE_FLAG_CONCURRENCY") ?? "25"));

/**
 * Can this market actually be BACKED at the quoted price?
 *
 * Exchanges publish both sides. The Odds API surfaces the lay side as its own
 * market key (`h2h_lay`, and the same pattern for other exchange markets), and
 * the pricer has no reason to know the difference. Flagging one would put a
 * price in front of a user that they cannot take, and later grade it into the
 * record as if they had.
 */
export function backable(market: string): boolean {
  const m = String(market ?? "").toLowerCase();
  return !!m && !m.endsWith("_lay") && !m.includes("_lay_");
}

/**
 * Is this a price EdgeDesk is willing to put its name on?
 *
 * STORING and FLAGGING are different acts and this is the line between them.
 * Everything priced gets stored — it is real market data and the movement and
 * residual reads want all of it. Only a flagged row has to be defensible.
 *
 * WHAT FLAGGING ACTUALLY GATES, VERIFIED AGAINST THE CONSUMERS (do not trust
 * the older claim that it gates "the board and the record" — it gates one):
 *   - THE RECORD: yes. record.html and the app's record view both select on
 *     `flagged_at=not.is.null&flagged_edge=gte.0.005&flagged_edge=lte.0.1`,
 *     so an unflagged row can never enter the graded pool or the CLV figures.
 *   - CLV / GRADING: yes. close/index.ts `entryPrice()` prefers
 *     flagged_best_dec and falls back to first_best_dec only when it is absent.
 *   - THE BOARD: NO. app.html's EDGES query filters on `edge=gt.0` and a
 *     commence_time window, and does not mention flagged_at. A stored-but-
 *     refused price with a positive edge therefore still renders on the board.
 *     Capture cannot fix that from here — the filter belongs to the reader —
 *     but nobody should believe this function is protecting the board until
 *     that query also requires flagged_at.
 *
 * Returns the reason for refusal rather than a bare boolean, because the
 * counts by reason are the whole diagnostic: "0 edges today" and "1,400 edges
 * rejected as broken prices" look identical on a board and could not be more
 * different underneath.
 */
export function flaggable(o: {
  market: string; edge: number; best_dec: number; median_dec: number; n_books: number;
}): { ok: boolean; reason: string | null } {
  if (!backable(o.market)) return { ok: false, reason: "exchange_lay_not_backable" };
  if (!Number.isFinite(o.best_dec) || o.best_dec <= 1) return { ok: false, reason: "no_usable_price" };
  if (o.best_dec < MIN_DEC) return { ok: false, reason: "price_below_tradeable_bound" };
  if (o.best_dec > MAX_DEC) return { ok: false, reason: "price_above_tradeable_bound" };
  if (o.n_books < MIN_BOOKS_TO_FLAG) return { ok: false, reason: "single_book_fair_is_not_a_consensus" };
  /* THE ONE THAT MATTERS. A best price far above the median quote for the same
     selection is a stale or mis-keyed feed, not a gift. This is the check that
     turns a 12.0 on a market everyone else prices at 1.90 into a stored row
     instead of a 505% "edge" at the top of the board. */
  if (Number.isFinite(o.median_dec) && o.median_dec > 1
    && o.best_dec / o.median_dec > MAX_BEST_VS_MEDIAN) {
    return { ok: false, reason: "best_price_is_an_outlier_vs_the_other_books" };
  }
  if (!Number.isFinite(o.edge)) return { ok: false, reason: "edge_not_computable" };
  if (o.edge < FLAG_FLOOR) return { ok: false, reason: "below_flag_floor" };
  if (o.edge > EDGE_SANE_MAX) return { ok: false, reason: "edge_implausible_bad_price" };
  return { ok: true, reason: null };
}

const AUTO_PREFIXES = [...new Set(
  (Deno.env.get("CAPTURE_AUTO_PREFIXES") ?? "tennis_")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .concat(["americanfootball_nfl"]),
)];

function canonicalTitle(sportKey: string, sportTitle: string): string {
  if ((sportKey || "").startsWith("americanfootball_nfl")) return "NFL";
  return sportTitle;
}

/**
 * Resolve the sport list. Now reports HOW it was resolved and whether discovery
 * failed, because an empty list is the difference between "nothing is in
 * season" and "the discovery call is broken" — and the old version returned
 * the same empty array for both, then reported a successful run.
 */
async function resolveSports(): Promise<{
  sports: string[]; stable: string[]; autoAdded: string[];
  discoveryOk: boolean; discoveryDetail: string;
}> {
  const stable = SPORTS_ENV.split(",").map((s) => s.trim()).filter(Boolean);
  if (!stable.length) {
    const all = await fetchActiveSports();
    return { sports: all.keys, stable: [], autoAdded: [], discoveryOk: all.ok, discoveryDetail: all.detail };
  }
  let autoAdded: string[] = [];
  let discoveryOk = true, discoveryDetail = "";
  if (AUTO_PREFIXES.length) {
    // free endpoint - does not spend odds quota. if it fails we still capture the stable list.
    const active = await fetchActiveSports();
    discoveryOk = active.ok; discoveryDetail = active.detail;
    autoAdded = active.keys.filter(
      (k) => AUTO_PREFIXES.some((p) => k.startsWith(p)) && !stable.includes(k),
    );
  }
  return { sports: [...new Set([...stable, ...autoAdded])], stable, autoAdded, discoveryOk, discoveryDetail };
}

/* The columns that describe RIGHT NOW. Phase B sends exactly these and nothing
   else — the identity columns are included so that if a phase-A insert ever
   fails, phase B still produces a complete, valid row rather than a NOT NULL
   violation. No first_* column appears here, which is the whole point. */
function liveRow(r: any) {
  return {
    sig_key: r.sig_key, event_id: r.event_id, sport_key: r.sport_key, sport_title: r.sport_title,
    commence_time: r.commence_time, home_team: r.home_team, away_team: r.away_team,
    market: r.market, selection: r.selection, point: r.point,
    last_seen_at: r.last_seen_at, best_dec: r.best_dec, best_book: r.best_book,
    sharp_fair: r.sharp_fair, consensus_fair: r.consensus_fair, edge: r.edge,
    is_plus_ev: r.is_plus_ev, n_books: r.n_books, has_sharp: r.has_sharp,
  };
}

/**
 * A write error, explained.
 *
 * "Bad Request" is not a diagnosis. The two failures that actually happen here
 * have specific, actionable causes, and naming them is the difference between
 * a five-minute fix and another cycle of redeploy-and-see.
 */
function explainWriteError(phase: string, e: any): string {
  const msg = [e?.message, e?.code, e?.details, e?.hint].filter(Boolean).join(" · ");
  const low = String(msg).toLowerCase();
  if (low.includes("null value") && low.includes("first_")) {
    return `${phase}: ${msg} — a first_* column is NOT NULL with no DEFAULT. Phase B deliberately omits the opening `
      + `columns so it can never overwrite them, but Postgres validates the proposed INSERT tuple even when the row `
      + `already exists. Make the first_* columns nullable (or give them defaults) and phase B will succeed.`;
  }
  if (low.includes("cannot affect row a second time")) {
    return `${phase}: ${msg} — two rows in one batch shared a sig_key. Deduplication should prevent this; if it `
      + `recurs, the sigKey builder and the priceEvent outcome key have drifted apart.`;
  }
  if (low.includes("column") && low.includes("does not exist")) {
    return `${phase}: ${msg} — the signals table is missing a column this build writes. Compare it against the `
      + `contract in the header before changing this function.`;
  }
  return `${phase}: ${msg}`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams);
  /* ?diag=1 — prices ONE sport and writes NOTHING. Answers "why is the board
     empty" in a single call: which preconditions hold, what the odds feed
     returned, how many outcomes priced, and exactly why each candidate was or
     was not flagged. It still needs the cron secret; it reads real odds. */
  const diag = params.diag === "1";
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const outOfTime = () => elapsed() > BUDGET_MS;

  if (!authorized(req)) {
    return json({
      ok: false, build: BUILD, error: "unauthorized",
      /* Naming the precondition is safe — it reveals no secret, and without it
         a misconfigured scheduler is invisible from outside forever. */
      reason: CRON_SECRET === ""
        ? "CRON_SECRET is not set on this function, so authorized() rejects EVERY caller including the scheduler. "
          + "Capture has not run since the variable went missing. Set CRON_SECRET and make the cron send a matching "
          + "x-cron-secret header."
        : "the x-cron-secret header did not match CRON_SECRET.",
    }, 401);
  }

  // ---- PRECONDITIONS. A run that cannot capture must never report success.
  if (!ODDS_KEY) {
    return json({ ok: false, build: BUILD, error: "ODDS_API_KEY is not set",
      reason: "Every odds request would fail. Nothing was attempted." }, 500);
  }

  const { sports, stable, autoAdded, discoveryOk, discoveryDetail } = await resolveSports();
  if (!sports.length) {
    return json({
      ok: false, build: BUILD, error: "no sports to capture",
      stable_sports: stable, auto_prefixes: AUTO_PREFIXES,
      sports_discovery_ok: discoveryOk, sports_discovery_error: discoveryDetail || null,
      reason: stable.length
        ? "CAPTURE_SPORTS is set but produced no keys after trimming."
        : discoveryOk
          ? "CAPTURE_SPORTS is empty and the /sports discovery call returned no active sports."
          : `CAPTURE_SPORTS is empty and the /sports discovery call FAILED (${discoveryDetail}), so the sport list `
            + `is empty for a reason that has nothing to do with the season. Previously this returned ok:true with `
            + `priced:0 and looked like a quiet day.`,
    }, 500);
  }

  let priced = 0, quota = "";
  const now = new Date().toISOString();
  const bookSet = new Set<string>();
  const perSport: Record<string, number> = {};
  const errored: { sport: string; status: number; detail: string }[] = [];
  let inserted = 0, updated = 0, flagged = 0;
  let flagDeferred = 0, flagErrors = 0;
  let ticksWritten = 0, tickErrors = 0;
  let dupesDropped = 0;
  let eventErrors = 0;
  const eventErrorSamples: { sport: string; event_id: string | null; error: string }[] = [];
  const skippedForTime: string[] = [];
  const writeErrors: string[] = [];
  /* Why candidates did NOT become signals, counted by reason. This is the
     single most useful number in the response: it separates "a quiet board"
     from "every edge on the board was a broken price". */
  const rejected: Record<string, number> = {};
  const rejectSamples: any[] = [];
  /* Candidates that PASSED every flag check. In a normal run this equals the
     rows phase C will freeze; in ?diag=1 it is the answer to "would this run
     have put anything on the board", asked without writing. */
  let flagCandidates = 0;
  const diagSamples: any[] = [];
  const perSportEvents: Record<string, number> = {};

  const sportList = diag ? sports.slice(0, 1) : sports;

  for (const sport of sportList) {
    /* Out of clock: stop cleanly rather than being killed with this sport's
       writes still unissued. Everything already written stays written. */
    if (outOfTime()) { skippedForTime.push(sport); continue; }
    const { data, quota: q, ok, status, detail } = await fetchOdds(sport, REGIONS, MARKETS);
    if (q) quota = q;
    if (!ok) {
      errored.push({ sport, status, detail });
      perSport[sport] = 0;
      continue;
    }
    const rows: any[] = [];
    const ticks: any[] = [];
    const toFlag: any[] = [];
    const seen = new Set<string>();
    /* Events RETURNED by the provider, before pricing. Separates "the feed sent
       nothing" from "the feed sent events that priced to nothing" — two very
       different faults that both end in an empty board. */
    perSportEvents[sport] = Array.isArray(data) ? data.length : 0;

    for (const ev of data) {
      /* ONE BAD EVENT IS NOT A BAD RUN. priceEvent is defensive now, but it
         parses a third-party feed and this loop is the last place an unexpected
         shape can still escape. Without this, an exception here unwinds all the
         way out of the request handler: every sport lost, nothing written, and
         a bare 500 that the fire-and-forget cron caller never records. Count
         the casualty, name it in the response, and keep capturing. */
      let pricedForEvent: any[];
      try {
        for (const bk of ev.bookmakers ?? []) bookSet.add(bk.key);
        pricedForEvent = priceEvent(ev, METHOD, SHARP);
      } catch (e) {
        eventErrors++;
        if (eventErrorSamples.length < 5) {
          eventErrorSamples.push({ sport, event_id: ev?.id ?? null, error: String((e as Error)?.message ?? e) });
        }
        continue;
      }
      for (const o of pricedForEvent) {
        const key = sigKey(o);
        /* DEDUPE BEFORE THE WRITE. Postgres refuses an ON CONFLICT statement
           that touches the same row twice — "cannot affect row a second time"
           — and that error fails the ENTIRE 500-row chunk, not the duplicate.
           One malformed feed could therefore discard a whole sport's capture. */
        if (seen.has(key)) { dupesDropped++; continue; }
        seen.add(key);

        rows.push({
          sig_key: key, event_id: o.event_id, sport_key: o.sport_key,
          sport_title: canonicalTitle(o.sport_key, o.sport_title),
          commence_time: o.commence_time, home_team: o.home_team, away_team: o.away_team,
          market: o.market, selection: o.selection, point: o.point,
          last_seen_at: now, best_dec: o.best_dec, best_book: o.best_book,
          sharp_fair: o.sharp_fair, consensus_fair: o.consensus_fair, edge: o.edge,
          is_plus_ev: o.is_plus_ev, n_books: o.n_books,
          has_sharp: o.has_sharp,
          // OPENING fields. Written by phase A on first sighting and never again.
          first_seen_at: now, first_best_dec: o.best_dec, first_best_book: o.best_book,
          first_sharp_fair: o.sharp_fair, first_edge: o.edge, first_has_sharp: o.has_sharp,
        });
        if (TICKS) ticks.push({ sig_key: key, best_dec: o.best_dec, sharp_fair: o.sharp_fair, edge: o.edge, n_books: o.n_books });

        /* STORE EVERYTHING, FLAG ONLY WHAT SURVIVES. The row above is already
           written whatever happens here; this decides only whether EdgeDesk
           puts its name on the price. */
        const verdict = flaggable(o);
        if (verdict.ok) {
          flagCandidates++;
          if (diagSamples.length < 12) {
            diagSamples.push({ sport, market: o.market, selection: o.selection, point: o.point,
              edge: +o.edge.toFixed(4), best_dec: o.best_dec, median_dec: +o.median_dec.toFixed(3),
              n_books: o.n_books, best_book: o.best_book, has_sharp: o.has_sharp });
          }
          toFlag.push({ sig_key: key, flagged_at: now, flagged_edge: o.edge,
            flagged_best_dec: o.best_dec, flagged_best_book: o.best_book });
        } else if (verdict.reason !== "below_flag_floor") {
          /* below_flag_floor is the ordinary case — most of the board is not an
             edge and counting it as a rejection would bury the interesting
             reasons. Everything else is recorded. */
          rejected[verdict.reason!] = (rejected[verdict.reason!] ?? 0) + 1;
          if (o.edge >= FLAG_FLOOR && rejectSamples.length < 12) {
            rejectSamples.push({
              reason: verdict.reason, sport, market: o.market, selection: o.selection,
              edge: +o.edge.toFixed(4), best_dec: o.best_dec, median_dec: +o.median_dec.toFixed(3),
              n_books: o.n_books, best_book: o.best_book,
            });
          }
        }
        priced++;
      }
    }
    perSport[sport] = rows.length;

    if (diag) continue;   // diagnostics never write

    /* PHASE A — insert brand-new signals only. */
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error, count } = await db.from("signals")
        .upsert(chunk, { onConflict: "sig_key", ignoreDuplicates: true, count: "exact" });
      if (error) { if (writeErrors.length < 8) writeErrors.push(explainWriteError("insert", error)); continue; }
      inserted += count ?? 0;
    }

    /* PHASE B — refresh the live columns. Cannot touch an opening field. */
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map(liveRow);
      const { error } = await db.from("signals")
        .upsert(chunk, { onConflict: "sig_key", ignoreDuplicates: false });
      if (error) { if (writeErrors.length < 8) writeErrors.push(explainWriteError("update", error)); continue; }
      updated += chunk.length;
    }

    /* PHASE C — freeze the entry price the first time this crosses the floor.
       Guarded on flagged_at IS NULL, so it is written once and never drifts.
       Over the cap, take the STRONGEST edges now and DEFER the rest; they stay
       unflagged so the next run picks them up and the backlog drains. */
    toFlag.sort((a, b) => (b.flagged_edge ?? 0) - (a.flagged_edge ?? 0));
    const flagNow = toFlag.slice(0, FLAG_MAX);
    flagDeferred += Math.max(0, toFlag.length - flagNow.length);
    /* EACH FLAG IS ITS OWN ROUND TRIP AND THAT IS NOT NEGOTIABLE — every row
       carries a different frozen price, so they cannot be collapsed into one
       UPDATE, and the `flagged_at IS NULL` guard is what stops an entry price
       drifting. What WAS negotiable is doing 600 of them one after another.
       At FLAG_MAX=600 and ~40ms per call that is 24 SECONDS PER SPORT of pure
       waiting; across a full sports list it walked straight through the Edge
       Function wall-clock, the run was killed mid-flight, and net.http_post
       recorded a success. Same calls, same guard, same order — issued in
       bounded-concurrency batches instead of single file. */
    for (let i = 0; i < flagNow.length; i += FLAG_CONCURRENCY) {
      const batch = flagNow.slice(i, i + FLAG_CONCURRENCY);
      const results = await Promise.all(batch.map((f) =>
        db.from("signals")
          .update({ flagged_at: f.flagged_at, flagged_edge: f.flagged_edge,
                    flagged_best_dec: f.flagged_best_dec, flagged_best_book: f.flagged_best_book })
          .eq("sig_key", f.sig_key).is("flagged_at", null)
      ));
      for (const { error } of results) {
        if (error) {
          flagErrors++;
          if (writeErrors.length < 8) writeErrors.push(explainWriteError("flag", error));
          continue;
        }
        flagged++;
      }
      if (outOfTime()) { flagDeferred += flagNow.length - (i + batch.length); break; }
    }

    /* Tick history: the only thing that can grade a signal whose market key has
       rotated out of existence, and the entire input to the market residual.
       Its errors are checked, never discarded. */
    if (ticks.length) {
      for (let i = 0; i < ticks.length; i += 500) {
        const { error } = await db.from("signal_ticks").insert(ticks.slice(i, i + 500));
        if (error) {
          tickErrors++;
          if (writeErrors.length < 8) writeErrors.push(explainWriteError("ticks", error));
          continue;
        }
        ticksWritten += Math.min(500, ticks.length - i);
      }
    }
  }

  const books = [...bookSet].sort();
  const sharpPresent = books.some((k) => k.toLowerCase().includes(SHARP));
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);

  /* A RUN THAT CAPTURED NOTHING IS NOT A SUCCESSFUL RUN. Reporting ok:true with
     priced:0 is what let a broken key, a dead sport list and a 401 loop all
     look like quiet days for as long as nobody went looking. */
  const capturedNothing = priced === 0;
  const allErrored = errored.length === sportList.length;
  /* A run where SOME sports failed and others captured is neither a success nor
     a failure, and collapsing it into either loses the thing worth acting on.
     `ok` keeps its existing meaning so current callers are unaffected; `status`
     is additive and carries the distinction. */
  const status = diag
    ? "diagnostic"
    : capturedNothing ? "failed"
    : (errored.length || eventErrors || writeErrors.length || skippedForTime.length) ? "partial" : "ok";

  const body = {
    ok: diag ? (!allErrored && !capturedNothing) : !capturedNothing,
    status,
    build: BUILD,
    ...(diag ? {
      mode: "diagnostic",
      note: "One sport priced. NOTHING was written — no signals, no flags, no ticks.",
      persistence: "skipped_intentionally",
      diag_scope_sport: sportList[0] ?? null,
      events_returned: perSportEvents,
      flaggable_candidates: flagCandidates,
      ...(diagSamples.length ? { flaggable_candidate_samples: diagSamples } : {}),
      would_have_flagged: Math.min(flagCandidates, FLAG_MAX),
    } : {}),
    ...(capturedNothing && !diag
      ? { error: allErrored
            ? "every sport's odds request failed — see `errored` for the HTTP status of each"
            : "no outcomes priced from any sport; the feed returned events with no usable two-sided markets" }
      : {}),

    // sport resolution telemetry
    stable_sports: stable, auto_prefixes: AUTO_PREFIXES, auto_added: autoAdded,
    sports_discovery_ok: discoveryOk,
    ...(discoveryDetail ? { sports_discovery_error: discoveryDetail } : {}),
    sports: sportList.length, sports_list: sportList,
    per_sport: perSport,
    per_sport_events: perSportEvents,
    ...(errored.length ? { errored } : {}),
    ...(eventErrors ? { event_pricing_failures: eventErrors, event_pricing_error_samples: eventErrorSamples } : {}),
    priced, quota_remaining: quota,
    flag_candidates: flagCandidates,
    /* The clock. If `sports_skipped_for_time` is ever non-empty the run is
       outgrowing its window: raise CAPTURE_FLAG_CONCURRENCY, cut FLAG_MAX, or
       split the sports list across two crons. Before this existed the same
       condition killed the run outright and reported nothing at all. */
    elapsed_ms: elapsed(), budget_ms: BUDGET_MS,
    ...(skippedForTime.length
      ? { sports_skipped_for_time: skippedForTime,
          time_warning: `Ran out of clock after ${elapsed()}ms. ${skippedForTime.length} sport(s) were not `
            + `captured this run. Everything written before the cutoff is committed.` }
      : {}),

    /* THE NUMBERS THAT ANSWER "WHY ARE THERE NO EDGES".
       flag_frozen is how many signals entered the record pool this run.
       flag_rejected explains what happened to everything that cleared the floor
       and still did not make it — which, before v5, was silently everything
       from a stale 12.0 quote to a legitimate soft price. */
    flag_frozen: flagged, flag_floor: FLAG_FLOOR, flag_max: FLAG_MAX,
    flag_rejected_total: rejectedTotal,
    flag_rejected_by_reason: rejected,
    ...(rejectSamples.length ? { flag_rejected_samples: rejectSamples } : {}),
    flag_bounds: {
      min_dec: MIN_DEC, max_dec: MAX_DEC, max_edge: EDGE_SANE_MAX,
      max_best_vs_median: MAX_BEST_VS_MEDIAN, min_books: MIN_BOOKS_TO_FLAG,
      note: "A price outside these bounds is STORED but never flagged, so it cannot reach the board or the record. "
        + "Shared with close/index.ts and the learning loop so every component agrees on what a real price is.",
    },
    ...(flagDeferred ? { flag_deferred_to_next_run: flagDeferred } : {}),
    ...(flagErrors ? { flag_write_failures: flagErrors } : {}),

    // write telemetry
    new_signals: inserted, refreshed: updated,
    ...(dupesDropped ? { duplicate_sig_keys_dropped: dupesDropped } : {}),
    ticks_enabled: TICKS, ticks_written: ticksWritten,
    ...(tickErrors ? { tick_write_failures: tickErrors } : {}),
    ...(writeErrors.length ? { write_errors: writeErrors } : {}),

    // market telemetry
    regions: REGIONS, sharp_book: SHARP, sharp_present: sharpPresent, books_seen: books,
  };

  console.log(diag ? "CAPTURE DIAG" : "CAPTURE", JSON.stringify(body));
  return json(body, body.ok ? 200 : 500);
});
