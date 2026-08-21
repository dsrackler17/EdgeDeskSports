// Model Collective — internal NFL odds API.
//
// The only odds surface the browser is allowed to see. It reads what the
// ingestion function stored; it never calls a provider, and it holds no
// provider credential. Every response carries a freshness envelope, so a
// caller always knows whether a number is current, how old it is, or that
// there is nothing to show. Nothing here fabricates a price.
//
// DEPLOYMENT: turn OFF "Enforce JWT verification" for this function. Market
// odds are public information and the Collective's paid gate is on model
// projections, not on the market. Access to the odds tables themselves stays
// server side: the anon key has no grant on them.

import { err, json, preflight, subpath } from "../_shared/http.ts";
import { RpcError } from "../_shared/db.ts";
import {
  oddsBoard,
  envelope,
  oddsEventPayload,
  oddsHistory,
  isUuid,
  num,
  relativeAge,
  settings,
  oddsStatus,
} from "../_shared/odds_api.ts";
import { rpc } from "../_shared/db.ts";

/** Short cache: long enough to absorb a burst of page loads, short enough
 *  that a line move reaches the site inside a poll cycle. */
const CACHE = { "cache-control": "public, max-age=20" };
const NO_STORE = { "cache-control": "no-store" };
const LEAGUE = "nfl";

const SETTING_KEYS = ["nfl.stale_after_seconds", "nfl.league_id"];

function staleAfter(cfg: Record<string, unknown>): number {
  return num(cfg["nfl.stale_after_seconds"], 900);
}

/** Window helpers. "week" here is the Collective's own slate week, which the
 *  odds feed carries only when the provider supplies it, so the default
 *  window is time based: yesterday through a week out. */
function windowFrom(u: URL): { from: string | null; to: string | null } {
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  if (from || to) {
    return { from: safeDate(from), to: safeDate(to) };
  }
  const days = Math.min(28, Math.max(1, num(u.searchParams.get("days"), 8)));
  return {
    from: new Date(Date.now() - 24 * 3600e3).toISOString(),
    to: new Date(Date.now() + days * 24 * 3600e3).toISOString(),
  };
}

function safeDate(v: string | null): string | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Trims a game to the fields a list view needs. The full book grid is a
 *  detail-view payload; sending it for every game on every page load is
 *  wasted bytes, not extra information. */
function summarize(game: Record<string, unknown>): Record<string, unknown> {
  const consensus = game.consensus as Record<string, unknown> | null;
  const best = game.best as Record<string, unknown> | null;
  return {
    event_id: game.event_id,
    collective_game_id: game.collective_game_id,
    season: game.season,
    week: game.week,
    home: game.home,
    away: game.away,
    home_name: game.home_name,
    away_name: game.away_name,
    commence_time: game.commence_time,
    status: game.status,
    is_live: game.is_live,
    market_closed: game.market_closed,
    last_odds_at: game.last_odds_at,
    book_count: game.book_count,
    /* Kept on the light payload: it is a small id -> name map, and without
       it a summary line can show a price but not name the book behind it. */
    book_names: game.book_names,
    consensus,
    best,
    opening: game.opening,
    closing: game.closing,
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_odds");
  const u = new URL(req.url);

  try {
    const cfg = await settings(SETTING_KEYS);
    const stale = staleAfter(cfg);
    /* Feed health is a property of the feed, not of one game, so the routes
       that return a single object still report the last successful poll. */
    let pollAt: string | null | undefined;
    const feedPolledAt = async (): Promise<string | null> => {
      if (pollAt === undefined) {
        const st = await oddsStatus(LEAGUE).catch(() => null);
        pollAt = (st?.last_poll_at as string | null) ?? null;
      }
      return pollAt;
    };

    // ------------------------------------------------------------ status
    // "Is the feed healthy?" as one object. The dashboards read this to
    // decide between showing numbers and showing why there are none.
    if (req.method === "GET" && (path === "/v1/nfl/status" || path === "/v1/status")) {
      const st = await oddsStatus(LEAGUE);
      const env = envelope(st?.last_poll_at as string | null, stale, LEAGUE,
        "oddsblaze", st?.last_odds_at as string | null);
      return json({ ...env, ...st }, 200, NO_STORE);
    }

    // ------------------------------------------------------------- books
    if (req.method === "GET" && path === "/v1/nfl/books") {
      const rows = await rpc<unknown>("odds_get_setting", { p_key: "nfl.books" });
      return json({ books: Array.isArray(rows) ? rows : [] }, 200, CACHE);
    }

    // -------------------------------------------------- the slate + odds
    // /v1/nfl/games is the light list; /v1/nfl/odds is the same slate with
    // the full book grid. One code path, one source, two payload sizes.
    if (
      req.method === "GET" &&
      (path === "/v1/nfl/games" || path === "/v1/nfl/odds")
    ) {
      const wantBooks = path === "/v1/nfl/odds" && u.searchParams.get("books") !== "0";
      const { from, to } = windowFrom(u);
      const data = await oddsBoard({
        league: LEAGUE,
        from,
        to,
        includeBooks: wantBooks,
        limit: Math.min(200, Math.max(1, num(u.searchParams.get("limit"), 40))),
      });
      const games = (data?.games ?? []) as Record<string, unknown>[];
      const env = envelope(
        data?.last_poll_at as string | null,
        num(data?.stale_after_seconds, stale),
        LEAGUE,
        "oddsblaze",
        data?.last_odds_at as string | null,
      );
      const week = u.searchParams.get("week");
      const filtered = week
        ? games.filter((g) => String(g.week ?? "") === String(Number(week)))
        : games;
      return json({
        ...env,
        window: { from, to },
        count: filtered.length,
        games: wantBooks ? filtered : filtered.map(summarize),
      }, 200, env.state === "unavailable" ? NO_STORE : CACHE);
    }

    // ------------------------------------------------------- best prices
    // Deliberately per line. The payload never crowns one price across
    // different lines, because -4 -105 and -3.5 -110 are different bets.
    if (req.method === "GET" && path === "/v1/nfl/odds/best") {
      const eventId = u.searchParams.get("event");
      const market = u.searchParams.get("market");
      if (eventId) {
        if (!isUuid(eventId)) return err("invalid_payload", "event must be a uuid.", 422);
        const game = await oddsEventPayload({ eventId, includeBooks: true });
        if (!game) return err("not_found", "No odds for that game.", 404);
        const env = envelope(await feedPolledAt(), stale, LEAGUE, "oddsblaze",
          game.last_odds_at as string | null);
        const best = game.best as Record<string, unknown>;
        return json({
          ...env,
          event_id: game.event_id,
          home: game.home,
          away: game.away,
          best: market ? { [market]: best?.[market] ?? null } : best,
          note:
            "Prices are grouped by line. A better price at a different line is a different bet, not a better one.",
        }, 200, CACHE);
      }
      const { from, to } = windowFrom(u);
      const data = await oddsBoard({ league: LEAGUE, from, to, includeBooks: false, limit: 40 });
      const games = (data?.games ?? []) as Record<string, unknown>[];
      const env = envelope(data?.last_poll_at as string | null, stale, LEAGUE,
        "oddsblaze", data?.last_odds_at as string | null);
      return json({
        ...env,
        count: games.length,
        games: games.map((g) => ({
          event_id: g.event_id,
          home: g.home,
          away: g.away,
          commence_time: g.commence_time,
          best: market
            ? { [market]: (g.best as Record<string, unknown>)?.[market] ?? null }
            : g.best,
        })),
        note:
          "Prices are grouped by line. A better price at a different line is a different bet, not a better one.",
      }, 200, CACHE);
    }

    // --------------------------------------------------------- consensus
    if (req.method === "GET" && path === "/v1/nfl/consensus") {
      const eventId = u.searchParams.get("event");
      if (eventId && !isUuid(eventId)) {
        return err("invalid_payload", "event must be a uuid.", 422);
      }
      if (eventId) {
        const game = await oddsEventPayload({ eventId, includeBooks: false });
        if (!game) return err("not_found", "No odds for that game.", 404);
        return json({
          ...envelope(await feedPolledAt(), stale, LEAGUE, "oddsblaze",
            game.last_odds_at as string | null),
          event_id: game.event_id,
          home: game.home,
          away: game.away,
          consensus: game.consensus,
        }, 200, CACHE);
      }
      const { from, to } = windowFrom(u);
      const data = await oddsBoard({ league: LEAGUE, from, to, includeBooks: false, limit: 40 });
      const games = (data?.games ?? []) as Record<string, unknown>[];
      return json({
        ...envelope(data?.last_poll_at as string | null, stale, LEAGUE,
          "oddsblaze", data?.last_odds_at as string | null),
        games: games.map((g) => ({
          event_id: g.event_id,
          home: g.home,
          away: g.away,
          commence_time: g.commence_time,
          consensus: g.consensus,
        })),
      }, 200, CACHE);
    }

    // --------------------------------- closing line for a Collective game
    // What the Results screen prefills, and what a CLV calculation must use.
    // Returns available:false until the market has actually closed.
    let m = path.match(/^\/v1\/nfl\/closing\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && m) {
      const out = await rpc<Record<string, unknown> | null>("odds_closing_for_game", {
        p_game_id: m[1],
      });
      return json(out ?? { available: false, reason: "unknown" }, 200, NO_STORE);
    }

    // ------------------------------------------------- one game's history
    m = path.match(/^\/v1\/nfl\/odds\/([0-9a-f-]{36})\/history$/i);
    if (req.method === "GET" && m) {
      if (!isUuid(m[1])) return err("invalid_payload", "event must be a uuid.", 422);
      const data = await oddsHistory({
        eventId: m[1],
        market: u.searchParams.get("market"),
        book: u.searchParams.get("book"),
        outcome: u.searchParams.get("outcome"),
        limit: Math.min(2000, Math.max(1, num(u.searchParams.get("limit"), 500))),
      });
      const points = (data?.points ?? []) as { at?: string }[];
      const last = points.length ? points[points.length - 1].at ?? null : null;
      return json({
        ...envelope(await feedPolledAt(), stale, LEAGUE, "oddsblaze", last),
        ...data,
        note: "Every stored state, oldest first. Unchanged polls are not stored, so each point is a real move.",
      }, 200, CACHE);
    }

    // ------------------------------------------------------- one game
    // Accepts our event id or the Collective's own game id, so a model page
    // can look up the market without knowing the odds layer's identifiers.
    m = path.match(/^\/v1\/nfl\/odds\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && m) {
      const byEvent = await oddsEventPayload({ eventId: m[1], includeBooks: true });
      const game = byEvent ?? await oddsEventPayload({ gameId: m[1], includeBooks: true });
      if (!game) return err("not_found", "No odds for that game.", 404);
      return json({
        ...envelope(await feedPolledAt(), stale, LEAGUE, "oddsblaze",
          game.last_odds_at as string | null),
        game,
      }, 200, CACHE);
    }

    m = path.match(/^\/v1\/nfl\/game\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && m) {
      const game = await oddsEventPayload({ gameId: m[1], includeBooks: true });
      if (!game) {
        return json({
          ...envelope(await feedPolledAt(), stale, LEAGUE),
          game: null,
          reason: "no_linked_odds_event",
        }, 200, NO_STORE);
      }
      return json({
        ...envelope(await feedPolledAt(), stale, LEAGUE, "oddsblaze",
          game.last_odds_at as string | null),
        game,
      }, 200, CACHE);
    }

    // ------------------------------------------------- assistant snapshot
    // A compact, self-describing view of the current market for a research
    // assistant to read. It exists so an assistant answers from stored data
    // instead of from memory: every number is labelled with its book, its
    // capture time, and its freshness, and when there is nothing stored the
    // payload says so rather than returning an empty shell that could be
    // mistaken for "no line".
    if (req.method === "GET" && path === "/v1/nfl/assistant") {
      const { from, to } = windowFrom(u);
      const data = await oddsBoard({ league: LEAGUE, from, to, includeBooks: true, limit: 32 });
      const games = (data?.games ?? []) as Record<string, unknown>[];
      const env = envelope(
        data?.last_poll_at as string | null,
        num(data?.stale_after_seconds, stale),
        LEAGUE,
        "oddsblaze",
        data?.last_odds_at as string | null,
      );
      return json({
        ...env,
        instructions: env.state === "unavailable"
          ? "No current NFL odds are stored. Say that the market is unavailable. Do not state a spread, total, or moneyline from memory."
          : `Answer only from the games below. Every price names its book and capture time. The feed was last updated ${
            relativeAge(env.age_seconds ?? 0)
          }. If a number is not present here, say it is not available rather than estimating it.`,
        definitions: {
          spread: "Home convention. A negative spread means the home team is favoured.",
          consensus_spread: "Median main line across retail books. Sharp books are reported separately.",
          consensus_moneyline: "Median of de-vigged two-way probabilities. American prices are never averaged.",
          best_price: "Best price within a line. Prices at different lines are different bets and are not ranked against each other.",
          opening: "Median of each book's first stored price.",
          closing: "Written only after kickoff. Absent means the market has not closed.",
        },
        count: games.length,
        games,
      }, 200, CACHE);
    }

    const known = [
      "/v1/nfl/status",
      "/v1/nfl/games",
      "/v1/nfl/odds",
      "/v1/nfl/odds/best",
      "/v1/nfl/consensus",
      "/v1/nfl/books",
      "/v1/nfl/assistant",
    ];
    if (known.includes(path)) {
      return err("method_not_allowed", "Wrong method for this route.", 405);
    }
    return err("not_found", `No such route: ${req.method} ${path}`, 404, { known });
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_odds rpc failure:", e.message, e.body);
    else console.error("collective_odds failure:", e);
    // The site must stay usable when odds are not. Read failures degrade to
    // an explicit "unavailable" envelope rather than a broken page.
    return json({
      ...envelope(null, 900, LEAGUE),
      error: { code: "server_error", message: "Odds are temporarily unavailable.", details: null },
      games: [],
    }, 200, NO_STORE);
  }
});
