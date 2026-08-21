// collective_odds - the Collective's only outbound call to an odds provider.
//
// Every price on the board arrives through here. Pages never call a provider:
// the site is static HTML, so anything a page can read the public can read,
// and a provider key in a page is a key given away. Collection runs server
// side, writes normalized rows through record_market_snapshots, and pages read
// the stored tables (docs/collective/M-odds.md).
//
// Routes, all admin-only:
//
//   POST /v1/odds/collect   fetch, normalize, store. dry_run stores nothing.
//   GET  /v1/odds/preview   collect with dry_run forced on, for a browser.
//   GET  /v1/odds/probe     what the live feed actually returned: its shape,
//                           its market names, and which of them this adapter
//                           reads. No odds data, no key, no writes.
//   GET  /v1/odds/sources   what the market store holds per feed and how old
//                           the newest price is. The collector's heartbeat.
//   GET  /v1/odds/health    is the key set, what is configured, is it fresh.
//
// A scheduler with no Supabase session can authenticate with the shared
// secret ODDS_COLLECTOR_SECRET in the x-collective-collector header, and acts
// as the first account in admin.user_ids. The database still checks is_admin
// on every write, so this header widens nothing the admin list does not
// already allow.
//
// IMPORTANT: turn OFF "Enforce JWT verification" for this function, so the
// collector-secret path can reach it.

import { err, json, preflight, subpath } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { viewGet } from "../_shared/reads.ts";
import {
  DEFAULT_LEAGUE_TO_SPORT,
  type EventLinkRow,
  fetchOddsBlaze,
  marketCensus,
  normalizeOddsBlaze,
  type SeasonWindow,
  shapeOf,
  type Skipped,
  type SnapshotRow,
} from "../_shared/oddsblaze.ts";

const FN = "collective_odds";

// The key is a secret, so the only thing this function ever reports about it
// is which name it was found under. The value is passed to the adapter and
// goes nowhere else: not into a response, not into a log, not into an error.
const KEY_ENV_NAMES = ["ODDSBLAZE_API_KEY", "ODDS_API_KEY", "NFL_ODDS_API_KEY"];

function providerKey(): { name: string; value: string } | null {
  for (const name of KEY_ENV_NAMES) {
    const value = Deno.env.get(name);
    if (value && value.trim()) return { name, value: value.trim() };
  }
  return null;
}

const BASE_URL_OVERRIDE: string | null = Deno.env.get("ODDS_API_BASE_URL")?.trim() || null;

// A sportsbook/league pair to poll. The feed serves one of each per call.
interface Target {
  sportsbook: string;
  league: string;
}

// Provider ids are lowercase slugs. Validated rather than trusted so a
// caller-supplied value can never be pasted into a URL as a path or a second
// query parameter.
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const DEFAULT_TARGETS: Target[] = [{ sportsbook: "draftkings", league: "mlb" }];
const MAX_TARGETS = 12;

// ------------------------------------------------------------------- auth

// Constant-time-ish comparison. Not a defense against a local attacker, but
// it costs nothing and keeps the secret out of an early-exit timing signal.
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function firstAdminId(): Promise<string | null> {
  const cfg = await rpc<unknown>("get_config", { p_key: "admin.user_ids" });
  const ids = Array.isArray(cfg) ? cfg.filter((v) => typeof v === "string") : [];
  return (ids[0] as string) ?? null;
}

// A signed-in admin, or a scheduler carrying the collector secret. Returns
// the admin uuid the database RPCs will be called with.
async function requireCollector(req: Request): Promise<string | Response> {
  const offered = req.headers.get("x-collective-collector");
  if (offered) {
    const expected = Deno.env.get("ODDS_COLLECTOR_SECRET")?.trim() ?? "";
    if (!expected) {
      return err("forbidden", "Scheduled collection is not enabled.", 403);
    }
    if (!secretsMatch(offered.trim(), expected)) {
      return err("invalid_key", "The collector secret is not valid.", 401);
    }
    const id = await firstAdminId();
    if (!id) {
      return err(
        "forbidden",
        "No administrator is configured, so collection has no account to write as.",
        403,
      );
    }
    return id;
  }
  const user = await requireAdmin(req);
  if (user instanceof Response) return user;
  return user.id;
}

// ----------------------------------------------------------------- config

async function configValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await rpc<unknown>("get_config", { p_key: key });
    return (v === null || v === undefined) ? fallback : v as T;
  } catch (e) {
    console.error(`${FN}: config ${key} unreadable:`, e);
    return fallback;
  }
}

function parseTargets(v: unknown): Target[] {
  if (!Array.isArray(v)) return [];
  const out: Target[] = [];
  for (const t of v) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    const sportsbook = String(rec.sportsbook ?? "").toLowerCase().trim();
    const league = String(rec.league ?? "").toLowerCase().trim();
    if (SLUG.test(sportsbook) && SLUG.test(league)) out.push({ sportsbook, league });
  }
  return out.slice(0, MAX_TARGETS);
}

async function configuredTargets(): Promise<Target[]> {
  const fromConfig = parseTargets(await configValue<unknown>("odds.collect", null));
  return fromConfig.length > 0 ? fromConfig : DEFAULT_TARGETS;
}

async function leagueMap(): Promise<Record<string, string>> {
  const cfg = await configValue<unknown>("odds.league_sports", null);
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k.toLowerCase()] = v;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return DEFAULT_LEAGUE_TO_SPORT;
}

async function seasonWindows(): Promise<SeasonWindow[]> {
  return await viewGet<SeasonWindow>(
    "sport_seasons",
    "select=sport_code,season,starts_on,ends_on",
  );
}

// ------------------------------------------------------------- collection

interface TargetReport {
  sportsbook: string;
  league: string;
  ok: boolean;
  url: string; // redacted
  status: number;
  error?: string;
  events_read?: number;
  rows?: number;
  skipped?: Skipped[];
}

interface Collected {
  rows: SnapshotRow[];
  links: EventLinkRow[];
  reports: TargetReport[];
}

async function collect(targets: Target[], includeLive: boolean): Promise<Collected | Response> {
  const key = providerKey();
  if (!key) {
    return err(
      "not_configured",
      `No odds provider key is set. Add one as an Edge Function secret named ${
        KEY_ENV_NAMES[0]
      }.`,
      503,
      { expected_secret_names: KEY_ENV_NAMES },
    );
  }
  const [seasons, leagueToSport] = await Promise.all([seasonWindows(), leagueMap()]);
  const now = new Date().toISOString();

  const rows: SnapshotRow[] = [];
  const links: EventLinkRow[] = [];
  const reports: TargetReport[] = [];

  for (const t of targets) {
    const outcome = await fetchOddsBlaze(
      fetch,
      BASE_URL_OVERRIDE,
      t.sportsbook,
      t.league,
      key.value,
    );
    if (!outcome.ok) {
      reports.push({
        sportsbook: t.sportsbook,
        league: t.league,
        ok: false,
        url: outcome.url,
        status: outcome.status,
        error: outcome.error,
      });
      continue;
    }
    const norm = normalizeOddsBlaze(outcome.body, {
      leagueToSport,
      seasons,
      now,
      source: "oddsblaze",
      includeLive,
    });
    rows.push(...norm.rows);
    links.push(...norm.links);
    reports.push({
      sportsbook: t.sportsbook,
      league: t.league,
      ok: true,
      url: outcome.url,
      status: outcome.status,
      events_read: norm.rows.length + norm.skipped.length,
      rows: norm.rows.length,
      skipped: norm.skipped,
    });
  }
  return { rows, links, reports };
}

// One RPC call per 200 rows. A slate is far smaller than that; the chunking
// is so a multi-league run cannot fail as one oversized request body.
const CHUNK = 200;

interface StoreTotals {
  stored: number;
  duplicates: number;
  unmatched: number;
  rejected: number;
  unmatched_rows: unknown[];
}

async function storeRows(adminId: string, rows: SnapshotRow[]): Promise<StoreTotals | Response> {
  const totals: StoreTotals = {
    stored: 0,
    duplicates: 0,
    unmatched: 0,
    rejected: 0,
    unmatched_rows: [],
  };
  for (let i = 0; i < rows.length; i += CHUNK) {
    const out = await rpc<Record<string, unknown>>("record_market_snapshots", {
      p_admin: adminId,
      p_rows: rows.slice(i, i + CHUNK),
    });
    if (!out || out.ok !== true) {
      return err(
        String(out?.code ?? "server_error"),
        String(out?.message ?? "The market store refused the batch."),
        out?.code === "forbidden" ? 403 : 422,
      );
    }
    totals.stored += Number(out.stored ?? 0);
    totals.duplicates += Number(out.duplicates ?? 0);
    totals.unmatched += Number(out.unmatched ?? 0);
    totals.rejected += Number(out.rejected ?? 0);
    if (Array.isArray(out.unmatched_rows)) {
      totals.unmatched_rows.push(...out.unmatched_rows);
    }
  }
  return totals;
}

async function storeLinks(adminId: string, links: EventLinkRow[]): Promise<{ linked: number; skipped: number }> {
  let linked = 0;
  let skipped = 0;
  for (let i = 0; i < links.length; i += CHUNK) {
    const out = await rpc<Record<string, unknown>>("link_provider_events", {
      p_admin: adminId,
      p_rows: links.slice(i, i + CHUNK),
    });
    if (out && out.ok === true) {
      linked += Number(out.linked ?? 0);
      skipped += Number(out.skipped ?? 0);
    }
  }
  return { linked, skipped };
}

// --------------------------------------------------------------- handlers

async function handleCollect(req: Request, adminId: string, forceDry: boolean): Promise<Response> {
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    body = await req.json().catch(() => ({})) as Record<string, unknown>;
  }
  const u = new URL(req.url);

  let targets = parseTargets(body.targets);
  const oneBook = String(body.sportsbook ?? u.searchParams.get("sportsbook") ?? "").toLowerCase();
  const oneLeague = String(body.league ?? u.searchParams.get("league") ?? "").toLowerCase();
  if (targets.length === 0 && oneBook && oneLeague) {
    if (!SLUG.test(oneBook) || !SLUG.test(oneLeague)) {
      return err("invalid_payload", "sportsbook and league must be provider slugs.", 422);
    }
    targets = [{ sportsbook: oneBook, league: oneLeague }];
  }
  if (targets.length === 0) targets = await configuredTargets();

  const includeLive = body.include_live === true ||
    u.searchParams.get("include_live") === "true" ||
    await configValue<boolean>("odds.include_live", false) === true;

  const collected = await collect(targets, includeLive);
  if (collected instanceof Response) return collected;

  const dry = forceDry || body.dry_run === true || u.searchParams.get("dry_run") === "true";
  const reachable = collected.reports.filter((r) => r.ok).length;

  const out: Record<string, unknown> = {
    ok: true,
    dry_run: dry,
    provider: "oddsblaze",
    targets: collected.reports,
    rows_normalized: collected.rows.length,
    events_linked: collected.links.length,
  };

  if (dry) {
    // A dry run is for reading, so it shows the rows it would have written.
    out.rows = collected.rows;
    return json(out);
  }

  // Nothing reachable is a provider outage, not a successful empty capture.
  // Reporting it as 200 with zero rows would make a dead collector look
  // exactly like a quiet slate.
  if (reachable === 0) {
    return err("provider_unavailable", "No odds feed could be read.", 502, {
      targets: collected.reports,
    });
  }

  const stored = await storeRows(adminId, collected.rows);
  if (stored instanceof Response) return stored;
  out.stored = stored;
  out.links = await storeLinks(adminId, collected.links);
  return json(out);
}

// What the live feed actually returned, with nothing in it that could carry a
// price, a name, or a credential: the shape of the JSON, and the market names
// with this adapter's verdict on each. A provider changing a field name shows
// up here as a diff instead of as a board that quietly stops updating.
async function handleProbe(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const sportsbook = (u.searchParams.get("sportsbook") ?? DEFAULT_TARGETS[0].sportsbook)
    .toLowerCase();
  const league = (u.searchParams.get("league") ?? DEFAULT_TARGETS[0].league).toLowerCase();
  if (!SLUG.test(sportsbook) || !SLUG.test(league)) {
    return err("invalid_payload", "sportsbook and league must be provider slugs.", 422);
  }
  const key = providerKey();
  if (!key) {
    return err("not_configured", "No odds provider key is set.", 503, {
      expected_secret_names: KEY_ENV_NAMES,
    });
  }
  const outcome = await fetchOddsBlaze(fetch, BASE_URL_OVERRIDE, sportsbook, league, key.value);
  if (!outcome.ok) {
    return err("provider_unavailable", "The odds feed could not be read.", 502, {
      url: outcome.url,
      status: outcome.status,
      error: outcome.error,
    });
  }
  const [seasons, leagueToSport] = await Promise.all([seasonWindows(), leagueMap()]);
  const norm = normalizeOddsBlaze(outcome.body, {
    leagueToSport,
    seasons,
    now: new Date().toISOString(),
    source: "oddsblaze",
  });
  return json({
    ok: true,
    url: outcome.url,
    key_secret_name: key.name,
    shape: shapeOf(outcome.body),
    markets: marketCensus(outcome.body),
    reads: {
      book: norm.book,
      league: norm.league,
      captured_at: norm.captured_at,
      rows: norm.rows.length,
      skipped: norm.skipped,
    },
  });
}

interface SourceRow {
  source: string;
  book: string;
  sport_code: string;
  snapshots: number;
  games: number;
  last_captured_at: string | null;
}

async function handleSources(): Promise<Response> {
  const rows = await viewGet<SourceRow>("market_sources", "select=*&order=last_captured_at.desc");
  const now = Date.now();
  return json({
    ok: true,
    sources: rows.map((r) => ({
      ...r,
      age_minutes: r.last_captured_at
        ? Math.round((now - new Date(r.last_captured_at).getTime()) / 60000)
        : null,
    })),
  });
}

async function handleHealth(): Promise<Response> {
  const key = providerKey();
  const [targets, sports, stale] = await Promise.all([
    configuredTargets(),
    seasonWindows(),
    configValue<number>("market.stale_minutes", 180),
  ]);
  const rows = await viewGet<SourceRow>("market_sources", "select=*");
  const now = Date.now();
  const freshest = rows
    .map((r) => (r.last_captured_at ? now - new Date(r.last_captured_at).getTime() : null))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)[0] ?? null;
  const ageMinutes = freshest === null ? null : Math.round(freshest / 60000);
  return json({
    ok: true,
    provider: "oddsblaze",
    key_configured: key !== null,
    key_secret_name: key?.name ?? null,
    base_url_overridden: BASE_URL_OVERRIDE !== null,
    scheduled_collection_enabled: Boolean(Deno.env.get("ODDS_COLLECTOR_SECRET")),
    targets,
    seasons: sports,
    newest_snapshot_age_minutes: ageMinutes,
    stale_minutes: stale,
    fresh: ageMinutes !== null && ageMinutes <= stale,
  });
}

// ----------------------------------------------------------------- server

async function handle(req: Request): Promise<Response> {
  const path = subpath(req, FN);

  const adminId = await requireCollector(req);
  if (adminId instanceof Response) return adminId;

  if (req.method === "POST" && path === "/v1/odds/collect") {
    return await handleCollect(req, adminId, false);
  }
  if (req.method === "GET" && path === "/v1/odds/preview") {
    return await handleCollect(req, adminId, true);
  }
  if (req.method === "GET" && path === "/v1/odds/probe") {
    return await handleProbe(req);
  }
  if (req.method === "GET" && path === "/v1/odds/sources") {
    return await handleSources();
  }
  if (req.method === "GET" && (path === "/v1/odds/health" || path === "/")) {
    return await handleHealth();
  }
  return err("not_found", "No such endpoint.", 404);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pf = preflight(req);
  if (pf) return pf;
  try {
    return await handle(req);
  } catch (e) {
    // The provider key can appear in a URL inside a thrown fetch error, so
    // the cause is logged and classified but never returned to the caller.
    if (e instanceof RpcError) {
      console.error(`${FN}: ${e.message}:`, e.body);
      return err("server_error", "The market store could not be reached.", 500, {
        stage: "database",
        status: e.status,
      });
    }
    console.error(`${FN}: unexpected error:`, e);
    return err("server_error", "An unexpected server error occurred.", 500, { stage: "function" });
  }
});
