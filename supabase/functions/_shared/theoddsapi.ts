// The Odds API provider (the-odds-api.com).
//
// The ONLY file in the Collective that knows what a The Odds API response
// looks like. Everything else consumes NormalizedSlate.
//
// Wire contract, from the v4 documentation:
//
//   GET https://api.the-odds-api.com/v4/sports/<sportKey>/odds
//         ?apiKey=<key>
//         &regions=us[,us2,uk,eu,au]
//         &markets=h2h,spreads,totals
//         &oddsFormat=american        <- REQUIRED, see below
//         &dateFormat=iso
//
//   -> [ { "id": …, "sport_key": "americanfootball_nfl",
//          "commence_time": "2026-09-13T17:00:00Z",
//          "home_team": "Cincinnati Bengals",
//          "away_team": "Tampa Bay Buccaneers",
//          "bookmakers": [ { "key": "draftkings", "title": "DraftKings",
//                            "last_update": …,
//                            "markets": [ { "key": "spreads", "last_update": …,
//                                           "outcomes": [ { "name": "Cincinnati Bengals",
//                                                           "price": -110,
//                                                           "point": -3.5 }, … ] } ] } ] } ]
//
// oddsFormat is not optional in practice. The API defaults to DECIMAL, and a
// decimal price is a small positive number that parses cleanly as a number —
// so omitting it does not fail, it silently stores 1.91 where -110 belongs and
// every consensus, de-vig and best-price number downstream becomes quiet
// nonsense. It is pinned below and asserted in the tests.
//
// COST MODEL. This differs from OddsBlaze in a way that matters:
//
//   OddsBlaze     one request PER BOOK; cost scales with how many books.
//   The Odds API  ONE request returns EVERY book in the region; cost is
//                 [number of markets] x [number of regions], independent of
//                 how many books come back.
//
// So this provider issues exactly one request per poll and keeps every book
// in the response. Filtering to a shorter book list would discard data already
// paid for without saving a single credit. `opts.books` is therefore a
// PRIORITY ORDER here, not a filter, and books that were asked for but did not
// appear are reported in books_failed so a vanished book is visible.
//
// The response carries the authoritative credit accounting in its headers:
//   x-requests-remaining  credits left in the period
//   x-requests-used       credits spent in the period
//   x-requests-last       what THIS request cost
// These are read and returned on the slate so the caller can enforce a budget
// against real numbers rather than a predicted cost.
//
// The credential is read here and here only, from THE_ODDS_API_KEY, falling
// back to NFL_ODDS_API_KEY so a single-provider deployment needs one secret.
// It goes in the query string because that is the documented authentication
// method, and every URL leaving this module — into a log, an error, an
// ingest_runs row, or a probe response — passes through redactUrl first.

import {
  canonicalMarket,
  firstOf,
  GAME_MARKETS,
  normKey,
  parseAmericanPrice,
  parseLine,
  redactSecret,
  redactUrl,
  resolveOutcome,
  sampleOf,
  shapePaths,
  unmapped,
} from "./odds_normalize.ts";
import type {
  FetchOptions,
  MarketId,
  NormalizedEvent,
  NormalizedOdd,
  NormalizedSlate,
  OddsProvider,
  ProbeResult,
  ProviderQuota,
  UnmappedRow,
} from "./odds_provider.ts";

const TA_DEFAULT_BASE = "https://api.the-odds-api.com/v4/";
const TA_DEFAULT_TIMEOUT_MS = 15000;
const TA_DEFAULT_REGIONS = "us";

/** Reported as the book on rows that are not attributable to one book, so an
 *  unmapped report never has an empty book column. */
const TA_NO_BOOK = "(response)";

/**
 * The credential, trimmed, with an empty value treated as absent.
 *
 * Both details are load bearing and both were wrong.
 *
 * TRIM: a secret is set by pasting, and a paste carries a trailing newline or
 * space more often than not. Untrimmed, that whitespace is percent-encoded
 * into the query string and the provider answers 401 — a "wrong key" error for
 * a key that is entirely correct, which is close to undiagnosable from the
 * outside because the digest the dashboard shows still looks fine.
 *
 * EMPTY IS ABSENT: `??` only falls through on null and undefined, so a
 * THE_ODDS_API_KEY that exists but is empty would win over a perfectly good
 * NFL_ODDS_API_KEY and send apiKey= with nothing after it.
 */
function taApiKey(): string {
  const preferred = (Deno.env.get("THE_ODDS_API_KEY") ?? "").trim();
  if (preferred !== "") return preferred;
  return (Deno.env.get("NFL_ODDS_API_KEY") ?? "").trim();
}

/** Shape of the configured credential, for diagnostics. Reports LENGTH and
 *  whether it matches the provider's documented form — never the value, and
 *  never any part of it. That is enough to tell a correct key from one
 *  carrying a stray newline, which is otherwise invisible: the dashboard shows
 *  only a digest, and a digest of the wrong string looks exactly as valid as a
 *  digest of the right one. */
export function taKeyShape(): {
  present: boolean;
  length: number;
  looks_like_key: boolean;
  source: string | null;
} {
  const raw = Deno.env.get("THE_ODDS_API_KEY");
  const fromPreferred = typeof raw === "string" && raw.trim() !== "";
  const key = taApiKey();
  return {
    present: key.length > 0,
    length: key.length,
    // The Odds API issues 32 character lowercase hex keys.
    looks_like_key: /^[0-9a-f]{32}$/.test(key),
    source: key.length === 0 ? null : (fromPreferred ? "THE_ODDS_API_KEY" : "NFL_ODDS_API_KEY"),
  };
}

function taBaseUrl(): string {
  // Empty is absent, same as the credential. `??` only falls through on null
  // and undefined, so a base URL override set to an empty string would win
  // and every request would be built against "/" — an invalid URL, reported
  // as a failed fetch rather than as a misconfiguration.
  const raw = (Deno.env.get("THE_ODDS_API_BASE_URL") ?? "").trim() || TA_DEFAULT_BASE;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** Comma separated region list. More regions = proportionally more credits,
 *  so this is a setting rather than a constant: `eu` buys Pinnacle, and
 *  whether that is worth doubling the cost is a plan decision, not a code
 *  decision. */
function taRegions(): string {
  const raw = (Deno.env.get("THE_ODDS_API_REGIONS") ?? TA_DEFAULT_REGIONS).trim();
  return raw === "" ? TA_DEFAULT_REGIONS : raw;
}

/** Our league id -> the API's sport key. */
const TA_SPORT_KEY: Record<string, string> = {
  nfl: "americanfootball_nfl",
  ncaaf: "americanfootball_ncaaf",
  nba: "basketball_nba",
  ncaab: "basketball_ncaab",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
};

/** Canonical market id -> the API's `markets` value. Only the game-line
 *  family is available on the bulk odds endpoint; alternates and props live
 *  on the per-event endpoint, which bills per event and is deliberately not
 *  used here. */
const TA_MARKET_PARAM: Record<string, string> = {
  moneyline: "h2h",
  spread: "spreads",
  total: "totals",
};

/** The API's bookmaker keys are not all the ids the Collective already uses.
 *  Mapping them keeps one book from appearing twice under two names. Keys not
 *  listed here pass through unchanged and are auto-registered on ingest. */
const TA_BOOK_ALIASES: Record<string, string> = {
  williamhill_us: "caesars",
  betfair_ex_us: "betfair",
  betfair_ex_eu: "betfair",
  betfair_ex_uk: "betfair",
  hardrockbet: "hardrock",
  ballybet: "ballybet",
  lowvig: "lowvig",
  betonlineag: "betonline",
  mybookieag: "mybookie",
  betus: "betus",
  unibet_us: "unibet",
  superbook: "superbook",
  windcreek: "betfred",
};

function taCanonicalBook(raw: unknown): string {
  const k = normKey(raw).replace(/[^a-z0-9]/g, "");
  const lower = String(raw ?? "").trim().toLowerCase();
  return TA_BOOK_ALIASES[lower] ?? TA_BOOK_ALIASES[k] ?? (lower || k);
}

// --------------------------------------------------------------- wire types

interface TaOutcome {
  name?: unknown;
  price?: unknown;
  point?: unknown;
  description?: unknown;
}
interface TaMarket {
  key?: unknown;
  last_update?: unknown;
  outcomes?: unknown;
}
interface TaBookmaker {
  key?: unknown;
  title?: unknown;
  last_update?: unknown;
  markets?: unknown;
}
interface TaEvent {
  id?: unknown;
  sport_key?: unknown;
  commence_time?: unknown;
  home_team?: unknown;
  away_team?: unknown;
  bookmakers?: unknown;
}

function taAsArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ------------------------------------------------------------ quota headers

/** The credit accounting the API reports on every response. Numbers only —
 *  no header is echoed verbatim, so a future header carrying anything
 *  identifying cannot leak through this path. */
export function readTaQuota(headers: Headers): ProviderQuota {
  const n = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  return {
    remaining: n("x-requests-remaining"),
    used: n("x-requests-used"),
    last_cost: n("x-requests-last"),
  };
}

/** What one poll will cost, by the documented formula. Used only to plan a
 *  budget before the fact; the authoritative number is x-requests-last on the
 *  response, which is what gets recorded. */
export function taPredictedCost(markets: MarketId[], regionList: string): number {
  const m = markets.filter((x) => TA_MARKET_PARAM[x]).length || 1;
  const r = regionList.split(",").map((s) => s.trim()).filter(Boolean).length || 1;
  return m * r;
}

// ------------------------------------------------------------------ reading

/** One outcome -> one canonical price, or an unmapped row explaining why not.
 *
 *  `point` is per outcome and already in that team's own terms, which is
 *  exactly the home convention the Collective stores: the home outcome's point
 *  IS the home spread. No sign flipping happens here, and none should. */
export function readTaOutcome(
  row: unknown,
  ctx: {
    book: string;
    market: MarketId;
    homeNames: string[];
    awayNames: string[];
    isLive: boolean;
  },
): { odd: NormalizedOdd | null; bad: UnmappedRow | null } {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { odd: null, bad: unmapped(ctx.book, "outcome is not an object", row) };
  }
  const o = row as TaOutcome;

  // A props payload carries `description` (the player). The bulk endpoint is
  // not asked for props, so one appearing means the request changed shape;
  // report it rather than filing a player line as a team line.
  if (o.description !== undefined && o.description !== null && o.description !== "") {
    return {
      odd: null,
      bad: unmapped(ctx.book, "outcome carries a player description; not a game line", row),
    };
  }

  const price = parseAmericanPrice(o.price);
  if (price === null) {
    return { odd: null, bad: unmapped(ctx.book, "no readable american price", row) };
  }

  const outcome = resolveOutcome({
    market: ctx.market,
    selectionName: o.name,
    homeNames: ctx.homeNames,
    awayNames: ctx.awayNames,
  });
  if (!outcome) {
    return {
      odd: null,
      bad: unmapped(ctx.book, "outcome name matched neither team nor over/under", row),
    };
  }

  // Moneyline has no line. Spreads and totals must have one: a spread with no
  // number is not a usable price, and storing it with a null line would let it
  // group with genuinely different numbers in best-price and consensus.
  let line: number | null = null;
  if (ctx.market !== "moneyline") {
    line = parseLine(o.point);
    if (line === null) {
      return { odd: null, bad: unmapped(ctx.book, `${ctx.market} outcome has no point`, row) };
    }
  }

  return {
    odd: {
      book: ctx.book,
      market: ctx.market,
      outcome,
      outcome_label: typeof o.name === "string" ? o.name : null,
      line,
      price,
      is_live: ctx.isLive,
      // The bulk endpoint returns main lines only; alternates are on the
      // per-event endpoint, which this provider does not call.
      is_main: true,
      raw: sampleOf(row, 200),
    },
    bad: null,
  };
}

/** One event -> canonical event plus every price under it. */
export function readTaEvent(
  row: unknown,
  opts: { markets: MarketId[]; now: number },
): { event: NormalizedEvent | null; bad: UnmappedRow[] } {
  const bad: UnmappedRow[] = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { event: null, bad: [unmapped(TA_NO_BOOK, "event is not an object", row)] };
  }
  const e = row as TaEvent;

  const home = typeof e.home_team === "string" ? e.home_team : "";
  const away = typeof e.away_team === "string" ? e.away_team : "";
  const commence = typeof e.commence_time === "string" ? e.commence_time : "";
  if (!home || !away || !commence) {
    return {
      event: null,
      bad: [unmapped(TA_NO_BOOK, "event is missing home_team, away_team or commence_time", row)],
    };
  }
  const kickoff = Date.parse(commence);
  if (!Number.isFinite(kickoff)) {
    return { event: null, bad: [unmapped(TA_NO_BOOK, "commence_time is not a parseable time", row)] };
  }

  // There is no in-play flag on this endpoint, so live is inferred from the
  // clock. Stated plainly rather than guessed at: a game that has kicked off
  // is live until the ingest layer learns otherwise from the Collective's own
  // slate, which is the only place a final score is known.
  const isLive = kickoff <= opts.now;

  const wanted = new Set(opts.markets.length ? opts.markets : GAME_MARKETS);
  const odds: NormalizedOdd[] = [];
  const homeNames = [home];
  const awayNames = [away];
  let newestBook: number | null = null;

  for (const bRow of taAsArray(e.bookmakers)) {
    if (!bRow || typeof bRow !== "object" || Array.isArray(bRow)) {
      bad.push(unmapped(TA_NO_BOOK, "bookmaker is not an object", bRow));
      continue;
    }
    const b = bRow as TaBookmaker;
    const book = taCanonicalBook(firstOf(b.key, b.title));
    if (!book) {
      bad.push(unmapped(TA_NO_BOOK, "bookmaker has no key or title", bRow));
      continue;
    }
    const bUpdated = Date.parse(String(b.last_update ?? ""));
    if (Number.isFinite(bUpdated)) {
      newestBook = newestBook === null ? bUpdated : Math.max(newestBook, bUpdated);
    }

    for (const mRow of taAsArray(b.markets)) {
      if (!mRow || typeof mRow !== "object" || Array.isArray(mRow)) {
        bad.push(unmapped(book, "market is not an object", mRow));
        continue;
      }
      const m = mRow as TaMarket;
      const market = canonicalMarket(m.key);
      if (!market) {
        bad.push(unmapped(book, "market key is not one the Collective stores", mRow));
        continue;
      }
      if (!wanted.has(market)) continue;

      for (const oRow of taAsArray(m.outcomes)) {
        const { odd, bad: problem } = readTaOutcome(oRow, {
          book,
          market,
          homeNames,
          awayNames,
          isLive,
        });
        if (odd) odds.push(odd);
        if (problem) bad.push(problem);
      }
    }
  }

  return {
    event: {
      provider_event_id: typeof e.id === "string" ? e.id : null,
      // Team codes are resolved from these names by the database's alias
      // table, which is the one place that mapping lives.
      home,
      away,
      home_name: home,
      away_name: away,
      commence_time: new Date(kickoff).toISOString(),
      status: isLive ? "live" : "scheduled",
      is_live: isLive,
      provider_updated_at: newestBook === null ? null : new Date(newestBook).toISOString(),
      odds,
    },
    bad,
  };
}

// ------------------------------------------------------------------- request

export function taBuildUrlForTest(opts: FetchOptions): string {
  return taBuildUrl(opts);
}

function taBuildUrl(opts: FetchOptions): string {
  const league = normKey(opts.league) || "nfl";
  const sport = TA_SPORT_KEY[league] ?? league;
  const markets = (opts.markets.length ? opts.markets : GAME_MARKETS)
    .map((m) => TA_MARKET_PARAM[m])
    .filter(Boolean);
  const u = new URL(`sports/${sport}/odds`, taBaseUrl());
  // These two strings are the PROVIDER'S wire names and have nothing to do
  // with our function names. A symbol rename once matched them inside these
  // literals and shipped ?taApiKey=...&taRegions=..., which the API answers
  // with 401 — a wrong-key error for a correct key. The query string is
  // asserted whole in the tests for exactly this reason.
  u.searchParams.set("apiKey", taApiKey());
  u.searchParams.set("regions", taRegions());
  u.searchParams.set("markets", (markets.length ? markets : ["h2h", "spreads", "totals"]).join(","));
  // Pinned, not defaulted. See the header note.
  u.searchParams.set("oddsFormat", "american");
  u.searchParams.set("dateFormat", "iso");
  return u.toString();
}

function taReasonFor(status: number): string {
  if (status === 401) return "the API rejected the key (401)";
  if (status === 429) return "credit limit reached or rate limited (429)";
  if (status === 422) return "the request parameters were rejected (422)";
  if (status === 404) return "no such sport key (404)";
  if (status >= 500) return `the provider returned ${status}`;
  return `unexpected status ${status}`;
}

/** The vendor's own account of an error, bounded and redacted, as a suffix
 *  ready to append to a reason. Empty string when the body says nothing
 *  useful, so a caller never has to test for it. The key is stripped even
 *  though this API does not echo it: a body is untrusted text, and a
 *  credential must not reach a run record by way of one. */
export async function taErrorDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = (await res.text()).trim();
  } catch {
    return "";
  }
  if (!raw) return "";
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const named = parsed?.message ?? parsed?.error_message ?? parsed?.error;
    if (typeof named === "string" && named.trim() !== "") detail = named.trim();
  } catch {
    // Not JSON. The raw text is still better than nothing.
  }
  const safe = redactSecret(detail, taApiKey()).replace(/\s+/g, " ").slice(0, 300);
  return safe ? `: ${safe}` : "";
}

interface TaRawFetch {
  ok: boolean;
  status: number | null;
  body: unknown;
  quota: ProviderQuota;
  reason: string | null;
}

async function taRequest(opts: FetchOptions): Promise<TaRawFetch> {
  const url = taBuildUrl(opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TA_DEFAULT_TIMEOUT_MS);
  const empty: ProviderQuota = { remaining: null, used: null, last_cost: null };
  try {
    const res = await fetch(url, { signal: controller.signal });
    const quota = readTaQuota(res.headers);
    if (!res.ok) {
      // The vendor explains itself on an error, and the explanation is the
      // whole diagnosis: "the api key provided is invalid" and "usage quota
      // has been reached" are both 401, and they need opposite fixes — a
      // different key versus a different plan. Reporting only the status code
      // throws that away and leaves the operator guessing between them.
      return {
        ok: false,
        status: res.status,
        body: null,
        quota,
        reason: `${taReasonFor(res.status)}${await taErrorDetail(res)}`,
      };
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: res.status,
        body: null,
        quota,
        reason: "the response was not JSON",
      };
    }
    return { ok: true, status: res.status, body, quota, reason: null };
  } catch (e) {
    const msg = redactSecret(String((e as Error)?.message ?? e), taApiKey());
    return {
      ok: false,
      status: null,
      body: null,
      quota: empty,
      reason: msg.includes("abort") ? "the request timed out" : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- provider

export const theOddsApiProvider: OddsProvider = {
  id: "theoddsapi",
  name: "The Odds API",

  isConfigured(): boolean {
    return taApiKey().length > 0;
  },

  async fetchSlate(opts: FetchOptions): Promise<NormalizedSlate> {
    const fetchedAt = new Date().toISOString();
    const now = Date.now();
    const base: NormalizedSlate = {
      provider: "theoddsapi",
      league: opts.league,
      fetched_at: fetchedAt,
      provider_updated_at: null,
      events: [],
      books_ok: [],
      books_failed: [],
      unmapped: [],
      counts: { events: 0, odds: 0, unmapped: 0 },
      quota: { remaining: null, used: null, last_cost: null },
    };

    if (!theOddsApiProvider.isConfigured()) {
      base.books_failed = [{ book: TA_NO_BOOK, reason: "no API key configured" }];
      return base;
    }

    const res = await taRequest(opts);
    base.quota = res.quota;
    if (!res.ok) {
      base.books_failed = [{ book: TA_NO_BOOK, reason: res.reason ?? "request failed" }];
      return base;
    }

    // One request returns every book, so a non-array body is the whole run
    // failing rather than one book failing.
    if (!Array.isArray(res.body)) {
      base.books_failed = [{ book: TA_NO_BOOK, reason: "response was not an array of events" }];
      base.unmapped = [unmapped(TA_NO_BOOK, "top level of response is not an array", res.body)];
      base.counts.unmapped = 1;
      return base;
    }

    const events: NormalizedEvent[] = [];
    const bad: UnmappedRow[] = [];
    const seenBooks = new Set<string>();
    let newest: number | null = null;
    let oddsCount = 0;

    for (const row of res.body) {
      const { event, bad: problems } = readTaEvent(row, { markets: opts.markets, now });
      bad.push(...problems);
      if (!event) continue;
      // Pregame/live filter, applied after mapping so the counts stay honest.
      if (opts.live === true && !event.is_live) continue;
      if (opts.live === false && event.is_live) continue;
      for (const o of event.odds) seenBooks.add(o.book);
      oddsCount += event.odds.length;
      if (event.provider_updated_at) {
        const t = Date.parse(event.provider_updated_at);
        if (Number.isFinite(t)) newest = newest === null ? t : Math.max(newest, t);
      }
      events.push(event);
    }

    // opts.books is a priority order, not a filter: every book in the response
    // is kept because it cost nothing extra. A book that was asked for and did
    // not arrive is reported so its absence is visible rather than silent.
    const asked = opts.books.map(taCanonicalBook).filter(Boolean);
    const missing = asked.filter((b) => !seenBooks.has(b));

    const ordered = [...seenBooks].sort((a, b) => {
      const ia = asked.indexOf(a);
      const ib = asked.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    });

    return {
      ...base,
      provider_updated_at: newest === null ? null : new Date(newest).toISOString(),
      events,
      books_ok: ordered,
      books_failed: missing.map((b) => ({
        book: b,
        reason: "requested but not present in the response for this region",
      })),
      unmapped: bad,
      counts: { events: events.length, odds: oddsCount, unmapped: bad.length },
    };
  },

  async probe(opts: FetchOptions): Promise<ProbeResult> {
    const urlRedacted = redactUrl(taBuildUrl(opts));
    const empty: ProbeResult = {
      provider: "theoddsapi",
      ok: false,
      url_redacted: urlRedacted,
      http_status: null,
      observed_shape: [],
      sample_event: null,
      sample_odd: null,
      counts: { events: 0, odds: 0 },
      error: null,
      mapping: { mapped: 0, unmapped: [] },
      quota: { remaining: null, used: null, last_cost: null },
    };

    if (!theOddsApiProvider.isConfigured()) {
      return { ...empty, error: "no API key configured" };
    }

    const res = await taRequest(opts);
    if (!res.ok) {
      return { ...empty, http_status: res.status, error: res.reason, quota: res.quota };
    }
    if (!Array.isArray(res.body)) {
      return {
        ...empty,
        http_status: res.status,
        quota: res.quota,
        observed_shape: shapePaths(res.body),
        error: "response was not an array of events",
      };
    }

    const first = res.body[0] ?? null;
    const { event, bad } = readTaEvent(first, { markets: opts.markets, now: Date.now() });
    const oddsTotal = res.body.reduce((n: number, row: unknown) => {
      const r = row as TaEvent;
      return n + taAsArray(r?.bookmakers).reduce((k: number, b: unknown) => {
        const bb = b as TaBookmaker;
        return k + taAsArray(bb?.markets).reduce(
          (j: number, m: unknown) => j + taAsArray((m as TaMarket)?.outcomes).length,
          0,
        );
      }, 0);
    }, 0);

    return {
      provider: "theoddsapi",
      ok: true,
      url_redacted: urlRedacted,
      http_status: res.status,
      observed_shape: shapePaths(first),
      sample_event: sampleOf(first, 600),
      sample_odd: event?.odds[0] ?? null,
      counts: { events: res.body.length, odds: oddsTotal },
      error: null,
      mapping: { mapped: event?.odds.length ?? 0, unmapped: bad },
      quota: res.quota,
    };
  },
};
