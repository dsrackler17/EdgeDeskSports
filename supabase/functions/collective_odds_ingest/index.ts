// Model Collective — NFL odds ingestion.
//
// The single writer. Nothing else in the Collective calls an odds provider,
// and nothing else writes to the odds schema. One run: read the settings,
// decide whether it is time, fetch, normalize, hand the batch to SQL, close
// any market that has kicked off, and record what happened.
//
// DEPLOYMENT: keep "Enforce JWT verification" ON for this function. The
// gateway then rejects anonymous calls, and the checks below additionally
// require either the service role key (how pg_cron calls it) or an admin
// account. A provider credential lives only in an edge function secret and is
// read only inside that provider's module.
//
// Two providers are registered. Which one runs is the `provider.default`
// setting, not a deploy: OddsBlaze bills per book, The Odds API bills per
// [markets x regions] and returns every book in one request. The Odds API
// reports its remaining credits on every response, so when the active provider
// meters itself this function enforces a budget against those real numbers
// before spending anything.

import { SERVICE_KEY } from "../_shared/env.ts";
import { err, json, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { num, settings, strList } from "../_shared/odds_api.ts";
import { getProvider, registerProvider } from "../_shared/odds_provider.ts";
import type { FetchOptions, NormalizedEvent } from "../_shared/odds_provider.ts";
import { oddsBlazeProvider } from "../_shared/oddsblaze.ts";
import { taPredictedCost, theOddsApiProvider } from "../_shared/theoddsapi.ts";
import { redactSecret } from "../_shared/odds_normalize.ts";

registerProvider(oddsBlazeProvider);
registerProvider(theOddsApiProvider);

const NO_STORE = { "cache-control": "no-store" };
/** Events per RPC call. Keeps a single request body small enough to stay well
 *  inside PostgREST limits on a full 16 game slate with every book. */
const BATCH_EVENTS = 12;

const SETTING_KEYS = [
  "nfl.enabled",
  "nfl.league_id",
  "nfl.books",
  "nfl.markets",
  "nfl.refresh_seconds.live",
  "nfl.refresh_seconds.pregame",
  "nfl.refresh_seconds.idle",
  "nfl.pregame_window_hours",
  "nfl.max_books_per_run",
  "provider.default",
  "provider.credit_reserve",
  "provider.quota",
];

/** Credit accounting carried forward between runs.
 *
 *  A metered provider only reports its remaining balance in a RESPONSE, which
 *  is after the credit has already been spent. So the balance from the last
 *  run is persisted in odds.settings and checked before the next one. That is
 *  what makes the budget a guard rather than a report: without it the first
 *  time we learn the plan is exhausted is a 429, mid-season, on the Sunday
 *  that matters.
 *
 *  An unknown balance is treated as "no information" and allowed through —
 *  never as "unlimited" — because the alternative is a deployment that can
 *  never make its first request. */
interface StoredQuota {
  remaining: number | null;
  used: number | null;
  last_cost: number | null;
  observed_at: string | null;
}

function readStoredQuota(v: unknown): StoredQuota {
  const o = (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
  const n = (x: unknown): number | null => {
    if (x === null || x === undefined || x === "") return null;
    const k = Number(x);
    return Number.isFinite(k) ? k : null;
  };
  return {
    remaining: n(o.remaining),
    used: n(o.used),
    last_cost: n(o.last_cost),
    observed_at: typeof o.observed_at === "string" ? o.observed_at : null,
  };
}

/** pg_cron calls with the service role key; a founder calls with their own
 *  session. Anything else is refused before a provider request is made. */
/** Constant-time compare, so a token cannot be recovered a character at a
 *  time from response latency. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Three ways in, all of them real authentication:
 *
 *   service role key   the operator, by hand
 *   admin session      the founder console
 *   ingest.cron_token  the scheduled job inside the database
 *
 * The cron token exists because the scheduler is pg_cron, which runs in
 * Postgres and cannot hold an edge function secret. Keeping the token in
 * odds.settings means both sides read the same value from the one place that
 * is already service-role-only, with no new secret to distribute and nothing
 * sensitive written into a cron job definition.
 *
 * This is why the gateway's "Enforce JWT verification" is OFF for this
 * function. Leaving it ON would not add security — the anon key that
 * satisfies it is printed in the site's own page source, so every visitor
 * already has one — while it WOULD block pg_net, which has no JWT to send.
 * The gate that matters is this function, and it is below, in code.
 */
async function authorize(req: Request): Promise<{ trigger: string } | Response> {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.replace(/^Bearer\s+/i, "").trim();
  if (SERVICE_KEY && sameSecret(bearer, SERVICE_KEY)) return { trigger: "cron" };

  const presented = (req.headers.get("x-odds-cron-token") ?? "").trim();
  if (presented) {
    const expected = await rpc<unknown>("odds_get_setting", { p_key: "ingest.cron_token" })
      .catch(() => null);
    // A token that was never generated must never match a caller who also
    // sends nothing: both would be the empty string. sameSecret refuses
    // zero length for exactly this reason.
    if (typeof expected === "string" && sameSecret(presented, expected)) {
      return { trigger: "schedule" };
    }
    return err("invalid_key", "That ingest token is not valid.", 401);
  }

  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  return { trigger: "admin" };
}

interface Cadence {
  interval_seconds: number;
  reason: "live" | "pregame" | "idle";
  next_kickoff: string | null;
}

/**
 * How often to poll right now. Live games get the fastest cadence the plan
 * safely allows, a slate about to start gets a middle one, and an empty
 * calendar gets the slow one. Every value comes from odds.settings, so
 * changing the cadence is a settings update rather than a deploy.
 */
async function cadence(cfg: Record<string, unknown>, league: string): Promise<Cadence> {
  const st = await rpc<Record<string, unknown> | null>("odds_status", { p_league: league })
    .catch(() => null);
  const live = num(st?.events_live, 0);
  const windowHours = num(cfg["nfl.pregame_window_hours"], 36);

  if (live > 0) {
    return {
      interval_seconds: num(cfg["nfl.refresh_seconds.live"], 60),
      reason: "live",
      next_kickoff: null,
    };
  }
  const next = await nextKickoff(league);
  if (next) {
    const hours = (Date.parse(next) - Date.now()) / 3_600_000;
    if (hours <= windowHours) {
      return {
        interval_seconds: num(cfg["nfl.refresh_seconds.pregame"], 300),
        reason: "pregame",
        next_kickoff: next,
      };
    }
  }
  return {
    interval_seconds: num(cfg["nfl.refresh_seconds.idle"], 1800),
    reason: "idle",
    next_kickoff: next,
  };
}

async function nextKickoff(league: string): Promise<string | null> {
  const board = await rpc<Record<string, unknown> | null>("odds_board", {
    p_league: league,
    p_from: new Date().toISOString(),
    p_to: null,
    p_include_books: false,
    p_limit: 1,
  }).catch(() => null);
  const games = (board?.games ?? []) as { commence_time?: string }[];
  return games[0]?.commence_time ?? null;
}

/** Seconds since the last run that actually reached the provider. */
async function secondsSinceLastRun(): Promise<number | null> {
  const st = await rpc<Record<string, unknown> | null>("odds_status", { p_league: "nfl" })
    .catch(() => null);
  const last = st?.last_run as { started_at?: string; status?: string } | null | undefined;
  if (!last?.started_at) return null;
  const ms = Date.parse(last.started_at);
  return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 1000) : null;
}

/** Why the site is showing "Odds unavailable", in the order the pipeline
 *  fails. The site itself deliberately says nothing beyond "unavailable" — it
 *  will not guess at a cause in front of a visitor — so this is where the
 *  cause is actually named, for an operator who is already authenticated. */
function diagnose(
  st: Record<string, unknown> | null,
  cfg: Record<string, unknown>,
  provider: { id: string; isConfigured(): boolean },
  quota: StoredQuota,
): { healthy: boolean; state: string; detail: string; fix: string | null } {
  if (cfg["nfl.enabled"] === false) {
    return {
      healthy: false,
      state: "disabled",
      detail: "nfl.enabled is false, so ingestion never runs.",
      fix: "Set nfl.enabled to true in odds.settings.",
    };
  }
  if (!provider.isConfigured()) {
    return {
      healthy: false,
      state: "no_credential",
      detail: `The "${provider.id}" provider has no API key in this function's environment.`,
      fix: provider.id === "theoddsapi"
        ? "Add THE_ODDS_API_KEY (or NFL_ODDS_API_KEY) to the edge function secrets."
        : "Add NFL_ODDS_API_KEY to the edge function secrets.",
    };
  }
  const last = st?.last_run as Record<string, unknown> | null | undefined;
  if (!st?.last_poll_at) {
    if (!last) {
      return {
        healthy: false,
        state: "never_run",
        detail:
          "No ingest run has ever been recorded, so nothing has called the provider. " +
          "This is what makes the site say odds are unavailable.",
        fix: "POST /v1/ingest?force=1 once by hand, then schedule it.",
      };
    }
    return {
      healthy: false,
      state: "never_succeeded",
      detail:
        `Runs exist but none finished ok or partial. The most recent ended "${
          String(last.status ?? "unknown")
        }"` + (last.error_message ? `: ${String(last.error_message).slice(0, 200)}` : "."),
      fix: "Run /v1/probe to see what the provider actually returned.",
    };
  }
  if (num(st?.books_current, 0) === 0) {
    return {
      healthy: false,
      state: "no_current_prices",
      detail: "A poll succeeded but no book has a current price stored.",
      fix: "Run /v1/probe; the mapping section shows which rows could not be read.",
    };
  }
  if (quota.remaining !== null && quota.remaining <= 0) {
    return {
      healthy: false,
      state: "out_of_credit",
      detail: "The provider reports no credits left in this billing period.",
      fix: "Wait for the period to reset, or raise the plan.",
    };
  }
  return {
    healthy: true,
    state: "ok",
    detail: `Last polled ${String(st?.last_poll_at)} with ${
      num(st?.books_current, 0)
    } book(s) currently priced.`,
    fix: null,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_odds_ingest");

  const auth = await authorize(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const cfg = await settings(SETTING_KEYS);
    const league = typeof cfg["nfl.league_id"] === "string"
      ? cfg["nfl.league_id"] as string
      : "nfl";
    const providerId = typeof cfg["provider.default"] === "string"
      ? cfg["provider.default"] as string
      : "oddsblaze";
    const provider = getProvider(providerId);

    if (!provider) {
      return err("server_error", `No provider registered under "${providerId}".`, 500);
    }

    // ------------------------------------------------------------- probe
    // One real request, reporting the observed response STRUCTURE. This is
    // how the integration is confirmed against the live API without printing
    // a credential or trusting a guess about the payload shape.
    if (path === "/v1/probe" && (req.method === "POST" || req.method === "GET")) {
      const books = strList(cfg["nfl.books"], ["draftkings"]);
      const only = url.searchParams.get("book");
      const result = await provider.probe({
        league,
        books: only ? [only] : books.slice(0, 1),
        markets: strList(cfg["nfl.markets"], ["moneyline", "spread", "total"]),
        mainOnly: true,
        timeoutMs: 15000,
      });
      return json(result, result.ok ? 200 : 502, NO_STORE);
    }

    // ------------------------------------------------------------ status
    if (path === "/v1/status" && req.method === "GET") {
      const st = await rpc<Record<string, unknown> | null>("odds_status", { p_league: league });
      const cad = await cadence(cfg, league);
      const quota = readStoredQuota(cfg["provider.quota"]);
      const markets = strList(cfg["nfl.markets"], ["moneyline", "spread", "total"]);
      const cost = taPredictedCost(markets, Deno.env.get("THE_ODDS_API_REGIONS") ?? "us");
      return json({
        ...st,
        provider: { id: provider.id, name: provider.name, configured: provider.isConfigured() },
        cadence: cad,
        seconds_since_last_run: await secondsSinceLastRun(),
        credits: {
          ...quota,
          estimated_cost_per_poll: cost,
          reserve: Math.max(0, num(cfg["provider.credit_reserve"], 0)),
          polls_affordable: quota.remaining === null
            ? null
            : Math.max(0, Math.floor(
              (quota.remaining - Math.max(0, num(cfg["provider.credit_reserve"], 0))) / cost,
            )),
        },
        diagnosis: diagnose(st, cfg, provider, quota),
      }, 200, NO_STORE);
    }

    // ------------------------------------------------------ close markets
    if (path === "/v1/close" && req.method === "POST") {
      const closed = await rpc<number>("odds_finalize_closing", { p_event_id: null });
      const linked = await rpc<number>("odds_link_games", { p_league: league });
      return json({ ok: true, closing_rows: closed ?? 0, games_linked: linked ?? 0 }, 200, NO_STORE);
    }

    // -------------------------------------------------- link to the slate
    if (path === "/v1/link" && req.method === "POST") {
      const linked = await rpc<number>("odds_link_games", { p_league: league });
      return json({ ok: true, games_linked: linked ?? 0 }, 200, NO_STORE);
    }

    // ------------------------------------------------------------ ingest
    if (path === "/v1/ingest" && req.method === "POST") {
      if (cfg["nfl.enabled"] === false) {
        return json({ ok: true, skipped: "disabled", reason: "nfl.enabled is false" }, 200, NO_STORE);
      }
      // Fail closed when the settings could not be read. settings() swallows
      // its errors and leaves null behind, and null is not false — so the
      // kill switch and the throttle would both have silently defaulted to
      // "on, as fast as you like". Against a metered trial plan an
      // unthrottled loop is the expensive failure, so an unreadable settings
      // table stops the run instead of guessing.
      if (cfg["nfl.enabled"] === null || cfg["nfl.enabled"] === undefined) {
        return err(
          "not_configured",
          "The odds settings could not be read, so the kill switch and poll interval are unknown. Refusing to call the provider.",
          503,
        );
      }
      if (!provider.isConfigured()) {
        return err(
          "not_configured",
          "The odds provider credential is not set on this function. Add NFL_ODDS_API_KEY to the edge function secrets.",
          503,
        );
      }

      // Do not hammer the API: a run that arrives early for the current
      // cadence returns without making a provider request at all.
      const cad = await cadence(cfg, league);
      const since = await secondsSinceLastRun();
      if (!force && since !== null && since < cad.interval_seconds) {
        return json({
          ok: true,
          skipped: "too_soon",
          cadence: cad,
          seconds_since_last_run: since,
        }, 200, NO_STORE);
      }

      const books = strList(cfg["nfl.books"], ["draftkings", "fanduel", "betmgm"])
        .slice(0, Math.max(1, num(cfg["nfl.max_books_per_run"], 12)));
      const markets = strList(cfg["nfl.markets"], ["moneyline", "spread", "total"]);
      const opts: FetchOptions = { league, books, markets, mainOnly: true, timeoutMs: 12000 };

      // ------------------------------------------------- credit budget
      // Spend nothing if the last known balance says this request would take
      // the plan below its reserve. The reserve exists so the closing-line
      // captures at the end of a period are still affordable after a month of
      // routine polling: running to exactly zero would mean the last games of
      // the month grade against no captured close at all.
      const reserve = Math.max(0, num(cfg["provider.credit_reserve"], 0));
      const stored = readStoredQuota(cfg["provider.quota"]);
      const cost = taPredictedCost(markets, Deno.env.get("THE_ODDS_API_REGIONS") ?? "us");
      if (stored.remaining !== null && stored.remaining - cost < reserve) {
        return json({
          ok: true,
          skipped: "credit_budget",
          reason:
            `The provider reports ${stored.remaining} credits left. This poll costs about ` +
            `${cost}, which would drop the balance below the reserve of ${reserve}.`,
          quota: stored,
          estimated_cost: cost,
          credit_reserve: reserve,
        }, 200, NO_STORE);
      }

      const runId = await rpc<number>("odds_begin_run", {
        p_provider: provider.id,
        p_league: league,
        p_trigger: auth.trigger,
      });

      try {
        const slate = await provider.fetchSlate(opts);

        // Every book failing is a provider problem, not a slate with no
        // games. Recording it as "0 events" would make an outage look like
        // an empty week, so it is reported as an error and no data is touched.
        if (slate.books_ok.length === 0) {
          const reason = slate.books_failed[0]?.reason ?? "no_books_returned";
          await rpc("odds_finish_run", {
            p_run_id: runId,
            p_stats: {
              status: "error",
              books_requested: books.length,
              books_ok: 0,
              books_failed: slate.books_failed.length,
              error_code: reason,
              error_message: `every requested sportsbook failed: ${
                slate.books_failed.map((b) => `${b.book}=${b.reason}`).join(", ").slice(0, 300)
              }`,
            },
          });
          return err("provider_unavailable", "The odds provider did not return any data.", 502, {
            books_failed: slate.books_failed,
          });
        }

        // Record the balance the provider just reported, before anything
        // below can throw. This is the only moment the real number is known,
        // and a run that fails later still spent the credit.
        if (slate.quota) {
          await rpc("odds_set_setting", {
            p_key: "provider.quota",
            p_value: { ...slate.quota, observed_at: new Date().toISOString() },
          }).catch((e) => console.error("could not persist provider quota:", e));
        }

        let written = 0, unchanged = 0, created = 0, seen = 0, rejected = 0;
        const unmatched: unknown[] = [];
        for (const part of chunk<NormalizedEvent>(slate.events, BATCH_EVENTS)) {
          const res = await rpc<Record<string, unknown>>("odds_ingest", {
            p_run_id: runId,
            p_provider: provider.id,
            p_league: league,
            p_payload: { events: part },
          });
          if (res && res.ok === false) {
            throw new Error(`ingest rejected: ${String(res.code ?? "unknown")}`);
          }
          written += num(res?.snapshots_written, 0);
          unchanged += num(res?.snapshots_unchanged, 0);
          created += num(res?.events_created, 0);
          seen += num(res?.events_seen, 0);
          rejected += num(res?.rows_rejected, 0);
          if (Array.isArray(res?.unmatched)) unmatched.push(...res.unmatched as unknown[]);
        }

        // A game that has kicked off closes now, while its last pre-kickoff
        // price is still the most recent thing we stored.
        const closingRows = await rpc<number>("odds_finalize_closing", { p_event_id: null })
          .catch(() => 0);
        const linked = await rpc<number>("odds_link_games", { p_league: league }).catch(() => 0);

        const partial = slate.books_failed.length > 0 || unmatched.length > 0 ||
          slate.counts.unmapped > 0;
        await rpc("odds_finish_run", {
          p_run_id: runId,
          p_stats: {
            status: partial ? "partial" : "ok",
            credits_spent: slate.quota?.last_cost ?? null,
            credits_remaining: slate.quota?.remaining ?? null,
            books_requested: books.length,
            books_ok: slate.books_ok.length,
            books_failed: slate.books_failed.length,
            events_seen: seen,
            events_created: created,
            events_matched: seen - created,
            snapshots_written: written,
            snapshots_unchanged: unchanged,
            rows_rejected: rejected,
            unmatched: {
              events: unmatched.slice(0, 20),
              provider_rows: slate.unmapped,
              books_failed: slate.books_failed,
            },
          },
        });

        return json({
          ok: true,
          run_id: runId,
          provider: provider.id,
          league,
          cadence: cad,
          books_ok: slate.books_ok,
          books_failed: slate.books_failed,
          events_seen: seen,
          events_created: created,
          snapshots_written: written,
          snapshots_unchanged: unchanged,
          rows_rejected: rejected,
          provider_rows_unmapped: slate.counts.unmapped,
          credits: slate.quota ?? null,
          unmapped_sample: slate.unmapped.slice(0, 5),
          unmatched_events: unmatched.slice(0, 5),
          closing_rows: closingRows ?? 0,
          games_linked: linked ?? 0,
        }, 200, NO_STORE);
      } catch (e) {
        const msg = redactSecret(
          String((e as Error)?.message ?? e),
          Deno.env.get("NFL_ODDS_API_KEY"),
        );
        console.error("collective_odds_ingest run failed:", msg);
        await rpc("odds_finish_run", {
          p_run_id: runId,
          p_stats: { status: "error", error_code: "ingest_failed", error_message: msg },
        }).catch(() => {});
        return err("server_error", "The odds run did not complete.", 500);
      }
    }

    if (["/v1/ingest", "/v1/probe", "/v1/close", "/v1/link", "/v1/status"].includes(path)) {
      return err("method_not_allowed", "Wrong method for this route.", 405);
    }
    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    const msg = redactSecret(String((e as Error)?.message ?? e), Deno.env.get("NFL_ODDS_API_KEY"));
    if (e instanceof RpcError) console.error("collective_odds_ingest rpc failure:", e.message);
    else console.error("collective_odds_ingest failure:", msg);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
