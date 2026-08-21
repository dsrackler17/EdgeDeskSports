// OddsBlaze provider.
//
// The ONLY file in the Collective that knows what an OddsBlaze response looks
// like. Everything else consumes NormalizedSlate. Swapping or adding a vendor
// is a sibling of this file plus one registerProvider call.
//
// Wire contract, from the OddsBlaze API documentation (docs.oddsblaze.com):
//
//   GET <base>?key=<API key>&sportsbook=<book id>&league=<league id>
//              [&market=<id or name, comma separated>]
//              [&price=american|decimal|fractional|probability|…]
//              [&live=true|false]   include only live / only pre-match
//              [&main=true|false]   include only main / only alternate lines
//
//   -> { "updated": <timestamp>,
//        "league":     { "id": "nfl", "name": …, "sport": … },
//        "sportsbook": { "id": "draftkings", "name": "DraftKings" },
//        "events": [ { "id": …,
//                      "teams": { "home": { "id", "name", "abbreviation" },
//                                 "away": { … } },
//                      "date": …, "live": <bool>,
//                      "odds": [ { "id", "market", "name", "price", "main",
//                                  "selection": { "name", "side", "line" } } ] } ] }
//
// The credential is read here and here only, from the NFL_ODDS_API_KEY edge
// function secret. It is placed in the query string because that is the
// documented authentication method, and every URL that leaves this module —
// into a log, an error, an ingest_runs row, or a probe response — goes
// through redactUrl or redactSecret first.
//
// Where the documentation lists a field under more than one name, or where a
// vendor may add one, the reader below tries the documented field first and
// the documented alternatives after. A row that matches none of them is
// returned in `unmapped` with its key names, never with a substituted value.

import {
  americanToDecimal,
  canonicalMarket,
  normKey,
  firstOf,
  GAME_MARKETS,
  lineFromLabel,
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
  UnmappedRow,
} from "./odds_provider.ts";

const DEFAULT_BASE = "https://odds.oddsblaze.com/";
const DEFAULT_TIMEOUT_MS = 12000;
/** Concurrent provider requests. Low on purpose: a trial plan is a shared,
 *  rate limited resource and a burst is the fastest way to lose it. */
const CONCURRENCY = 3;

function apiKey(): string {
  return Deno.env.get("NFL_ODDS_API_KEY") ?? "";
}

function baseUrl(): string {
  return Deno.env.get("NFL_ODDS_BASE_URL") ?? DEFAULT_BASE;
}

/** Canonical market id -> the id OddsBlaze uses in its `market` parameter. */
const PROVIDER_MARKET: Record<string, string> = {
  moneyline: "moneyline",
  spread: "point-spread",
  total: "total-points",
  team_total: "team-total",
  alternate_spread: "alternate-point-spread",
  alternate_total: "alternate-total-points",
};

interface ObEvent {
  id?: unknown;
  teams?: { home?: ObTeam; away?: ObTeam };
  home?: unknown;
  away?: unknown;
  date?: unknown;
  start?: unknown;
  live?: unknown;
  status?: unknown;
  odds?: unknown;
}
interface ObTeam {
  id?: unknown;
  name?: unknown;
  abbreviation?: unknown;
  short_name?: unknown;
}

function hasPlayer(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}

/** The statuses odds.events accepts. A value outside this set violates the
 *  column's CHECK constraint, and because the whole slate is ingested in one
 *  transaction that would abort the batch and lose every price in it — so an
 *  unrecognised vendor status becomes "scheduled" rather than an outage. */
const EVENT_STATUS = new Set(["scheduled", "live", "final", "postponed", "canceled"]);
const STATUS_ALIASES: Record<string, string> = {
  cancelled: "canceled",
  delayed: "postponed",
  suspended: "postponed",
  complete: "final",
  completed: "final",
  finished: "final",
  ended: "final",
  closed: "final",
  inprogress: "live",
  started: "live",
  upcoming: "scheduled",
  pregame: "scheduled",
  notstarted: "scheduled",
};

export function normalizeStatus(raw: unknown, live: boolean): string {
  if (live) return "live";
  const k = normKey(raw);
  if (!k) return "scheduled";
  if (EVENT_STATUS.has(k)) return k;
  return STATUS_ALIASES[k] ?? "scheduled";
}

function teamNames(t: ObTeam | undefined): string[] {
  if (!t) return [];
  return [t.name, t.abbreviation, t.short_name]
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** The container the vendor puts the games in. `events` is what the docs
 *  show; `games` is accepted because the same feed is documented under that
 *  name elsewhere. The probe reports which one was actually seen. */
function eventArray(body: unknown): { rows: ObEvent[]; container: string | null } {
  if (!body || typeof body !== "object") return { rows: [], container: null };
  const o = body as Record<string, unknown>;
  for (const key of ["events", "games"]) {
    if (Array.isArray(o[key])) return { rows: o[key] as ObEvent[], container: key };
  }
  return { rows: [], container: null };
}

/**
 * One vendor odds row -> one NormalizedOdd, or an UnmappedRow explaining
 * exactly which part could not be read.
 */
export function readOdd(
  row: unknown,
  ctx: { book: string; homeNames: string[]; awayNames: string[]; eventLive: boolean },
): { odd: NormalizedOdd } | { bad: UnmappedRow } {
  if (!row || typeof row !== "object") {
    return { bad: unmapped(ctx.book, "odds row is not an object", row) };
  }
  const r = row as Record<string, unknown>;
  const sel = (r.selection && typeof r.selection === "object" && !Array.isArray(r.selection))
    ? r.selection as Record<string, unknown>
    : null;

  // A player prop carries a player; it is a different family and is skipped
  // here rather than mangled into a game line.
  //
  // Emptiness is checked, not truthiness: `players: []` is a truthy value, so
  // a feed that includes an empty players array on ordinary game lines would
  // have had every single row discarded as a prop.
  if (hasPlayer(r.player) || hasPlayer(r.players)) {
    return { bad: unmapped(ctx.book, "player market, not a game line", row) };
  }

  const market = canonicalMarket(firstOf(r.market, r.market_id, r.market_name));
  if (!market) {
    return { bad: unmapped(ctx.book, `unrecognised market ${JSON.stringify(r.market ?? null)}`, row) };
  }
  if (!GAME_MARKETS.includes(market)) {
    return { bad: unmapped(ctx.book, `market ${market} is not a stored game line`, row) };
  }

  const price = parseAmericanPrice(firstOf(r.price, r.odds, r.american));
  if (price === null) {
    return { bad: unmapped(ctx.book, "no usable American price", row) };
  }

  const selectionName = firstOf<unknown>(
    sel?.name,
    typeof r.selection === "string" ? r.selection : null,
    r.name,
  );
  const outcome = resolveOutcome({
    market,
    side: firstOf<unknown>(sel?.side, r.side, r.selection_side),
    selectionName,
    homeNames: ctx.homeNames,
    awayNames: ctx.awayNames,
  });
  if (!outcome) {
    return { bad: unmapped(ctx.book, "could not attribute the price to a side", row) };
  }

  // Documented field first, documented alternatives next, the label last.
  let line = parseLine(
    firstOf<unknown>(sel?.line, sel?.points, r.points, r.selection_points, r.line, r.handicap),
  );
  if (line === null && market !== "moneyline") {
    line = lineFromLabel(selectionName ?? r.name);
  }
  if (market !== "moneyline" && line === null) {
    return { bad: unmapped(ctx.book, `${market} row carries no line`, row) };
  }
  if (market === "moneyline") line = null;

  // Spreads are stored in home convention: the away number is the mirror of
  // the home number, so an away row keeps its own sign as sent.
  return {
    odd: {
      book: ctx.book,
      market,
      outcome,
      outcome_label: typeof selectionName === "string" ? selectionName : null,
      line,
      price,
      is_live: Boolean(firstOf(r.live, ctx.eventLive)),
      is_main: r.main === undefined ? true : Boolean(r.main),
      raw: sampleOf(row, 600),
    },
  };
}

/** One vendor event -> one NormalizedEvent. Team names are passed through
 *  verbatim; turning them into codes is the database's job, using the alias
 *  table, so there is one place where team identity is decided. */
export function readEvent(
  ev: ObEvent,
  ctx: { book: string; providerUpdatedAt: string | null },
): { event: NormalizedEvent | null; bad: UnmappedRow[] } {
  const bad: UnmappedRow[] = [];
  const home = ev.teams?.home ?? (typeof ev.home === "object" ? ev.home as ObTeam : undefined);
  const away = ev.teams?.away ?? (typeof ev.away === "object" ? ev.away as ObTeam : undefined);
  const homeNames = teamNames(home).concat(typeof ev.home === "string" ? [ev.home] : []);
  const awayNames = teamNames(away).concat(typeof ev.away === "string" ? [ev.away] : []);

  const commence = firstOf<unknown>(ev.date, ev.start, (ev as Record<string, unknown>).commence_time);
  if (!homeNames.length || !awayNames.length || !commence) {
    bad.push(unmapped(ctx.book, "event missing teams or kickoff time", ev));
    return { event: null, bad };
  }

  const eventLive = Boolean(ev.live);
  const odds: NormalizedOdd[] = [];
  const rawOdds = Array.isArray(ev.odds) ? ev.odds : [];
  for (const row of rawOdds) {
    const res = readOdd(row, { book: ctx.book, homeNames, awayNames, eventLive });
    if ("odd" in res) odds.push(res.odd);
    else bad.push(res.bad);
  }

  return {
    event: {
      provider_event_id: ev.id === undefined || ev.id === null ? null : String(ev.id),
      home: homeNames[0],
      away: awayNames[0],
      home_name: homeNames[0],
      away_name: awayNames[0],
      commence_time: String(commence),
      status: normalizeStatus(ev.status, eventLive),
      is_live: eventLive,
      provider_updated_at: ctx.providerUpdatedAt,
      odds,
    },
    bad,
  };
}

function buildUrl(book: string, opts: FetchOptions): string {
  const u = new URL(baseUrl());
  u.searchParams.set("key", apiKey());
  u.searchParams.set("sportsbook", book);
  u.searchParams.set("league", opts.league);
  u.searchParams.set("price", "american");
  const markets = opts.markets
    .map((m: MarketId) => PROVIDER_MARKET[m] ?? m)
    .filter(Boolean);
  if (markets.length) u.searchParams.set("market", markets.join(","));
  if (opts.mainOnly) u.searchParams.set("main", "true");
  if (opts.live !== undefined) u.searchParams.set("live", String(opts.live));
  return u.toString();
}

/** Vendor HTTP status -> a stable reason code the ingest run can record and
 *  the dashboard can explain. Bodies are never surfaced. */
function reasonFor(status: number): string {
  if (status === 401 || status === 403) return "invalid_or_unauthorized_key";
  if (status === 402) return "plan_or_trial_expired";
  if (status === 404) return "endpoint_or_league_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_outage";
  return `provider_http_${status}`;
}

async function fetchBook(
  book: string,
  opts: FetchOptions,
): Promise<{ book: string; body: unknown } | { book: string; reason: string }> {
  const url = buildUrl(book, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "accept": "application/json" },
    });
    if (!res.ok) {
      // The body may echo the query string, so it is read and discarded
      // rather than propagated.
      await res.text().catch(() => "");
      return { book, reason: reasonFor(res.status) };
    }
    const text = await res.text();
    try {
      return { book, body: JSON.parse(text) };
    } catch {
      return { book, reason: "malformed_json" };
    }
  } catch (e) {
    const msg = redactSecret(String((e as Error)?.message ?? e), apiKey());
    return { book, reason: /abort/i.test(msg) ? "timeout" : `request_failed: ${msg.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs tasks with a fixed ceiling on how many are in flight. */
async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Merges per-book responses into one slate. Books are fetched separately (the
 * vendor takes one sportsbook per request) but a game is a game: the same
 * event across books collapses onto one entry keyed by teams and kickoff, so
 * the database receives one event carrying every book's prices.
 */
export function mergeBooks(
  parts: { book: string; body: unknown }[],
): { events: NormalizedEvent[]; unmapped: UnmappedRow[]; providerUpdatedAt: string | null } {
  const byKey = new Map<string, NormalizedEvent>();
  const bad: UnmappedRow[] = [];
  let updated: string | null = null;

  for (const part of parts) {
    const body = part.body as Record<string, unknown> | null;
    const partUpdated = body && typeof body.updated === "string" ? body.updated : null;
    if (partUpdated && (!updated || partUpdated > updated)) updated = partUpdated;

    const { rows, container } = eventArray(body);
    if (!container) {
      bad.push(unmapped(part.book, "response carried no events array", body));
      continue;
    }
    for (const ev of rows) {
      const { event, bad: evBad } = readEvent(ev, {
        book: part.book,
        providerUpdatedAt: partUpdated,
      });
      bad.push(...evBad);
      if (!event) continue;
      const key = [event.home, event.away, event.commence_time.slice(0, 10)]
        .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")).join("|");
      const existing = byKey.get(key);
      if (existing) {
        existing.odds.push(...event.odds);
        existing.is_live = existing.is_live || event.is_live;
        // Keep the first provider id seen; the mapping table holds the rest.
        if (!existing.provider_event_id) existing.provider_event_id = event.provider_event_id;
      } else {
        byKey.set(key, event);
      }
    }
  }
  return { events: [...byKey.values()], unmapped: bad, providerUpdatedAt: updated };
}

export const oddsBlazeProvider: OddsProvider = {
  id: "oddsblaze",
  name: "OddsBlaze",

  isConfigured(): boolean {
    return apiKey().length > 0;
  },

  async fetchSlate(opts: FetchOptions): Promise<NormalizedSlate> {
    const fetched_at = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        provider: "oddsblaze",
        league: opts.league,
        fetched_at,
        provider_updated_at: null,
        events: [],
        books_ok: [],
        books_failed: opts.books.map((b) => ({ book: b, reason: "missing_api_key" })),
        unmapped: [],
        counts: { events: 0, odds: 0, unmapped: 0 },
      };
    }

    const results = await pooled(opts.books, CONCURRENCY, (b) => fetchBook(b, opts));
    const ok = results.filter((r): r is { book: string; body: unknown } => "body" in r);
    const failed = results
      .filter((r): r is { book: string; reason: string } => "reason" in r)
      .map((r) => ({ book: r.book, reason: r.reason }));

    const merged = mergeBooks(ok);
    const oddsCount = merged.events.reduce((n, e) => n + e.odds.length, 0);
    return {
      provider: "oddsblaze",
      league: opts.league,
      fetched_at,
      provider_updated_at: merged.providerUpdatedAt,
      events: merged.events,
      books_ok: ok.map((r) => r.book),
      books_failed: failed,
      // Bounded: a systematic shape change produces one report per row, and
      // the run record is not the place to store thousands of them.
      unmapped: merged.unmapped.slice(0, 25),
      counts: { events: merged.events.length, odds: oddsCount, unmapped: merged.unmapped.length },
    };
  },

  async probe(opts: FetchOptions): Promise<ProbeResult> {
    const book = opts.books[0] ?? "draftkings";
    const url = buildUrl(book, opts);
    const base: ProbeResult = {
      provider: "oddsblaze",
      ok: false,
      url_redacted: redactUrl(url),
      http_status: null,
      observed_shape: [],
      sample_event: null,
      sample_odd: null,
      counts: { events: 0, odds: 0 },
      error: null,
      mapping: { mapped: 0, unmapped: [] },
    };
    if (!this.isConfigured()) {
      return { ...base, error: "NFL_ODDS_API_KEY is not set on this function" };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      base.http_status = res.status;
      const text = await res.text();
      if (!res.ok) {
        return { ...base, error: reasonFor(res.status) };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ...base, error: "malformed_json" };
      }
      const { rows, container } = eventArray(body);
      const sample = rows[0];
      const sampleOdds = sample && Array.isArray(sample.odds) ? sample.odds : [];

      // Run the real adapter over the real sample: this is the difference
      // between "the endpoint answered" and "we can read what it said".
      let mapped = 0;
      const bad: UnmappedRow[] = [];
      for (const ev of rows.slice(0, 3)) {
        const r = readEvent(ev, { book, providerUpdatedAt: null });
        if (r.event) mapped += r.event.odds.length;
        bad.push(...r.bad);
      }

      return {
        ...base,
        ok: true,
        observed_shape: shapePaths(body).concat(container ? [`container=${container}`] : []),
        sample_event: sample
          ? { id: sample.id, teams: sample.teams, date: sample.date ?? sample.start, live: sample.live }
          : null,
        sample_odd: sampleOdds.length ? sampleOf(sampleOdds[0], 600) : null,
        counts: {
          events: rows.length,
          odds: rows.reduce((n, e) => n + (Array.isArray(e.odds) ? e.odds.length : 0), 0),
        },
        mapping: { mapped, unmapped: bad.slice(0, 10) },
      };
    } catch (e) {
      const msg = redactSecret(String((e as Error)?.message ?? e), apiKey());
      return { ...base, error: /abort/i.test(msg) ? "timeout" : msg.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Exported for the read API's price comparison. Kept next to the provider so
 *  the American-odds convention has one owner. */
export { americanToDecimal };
