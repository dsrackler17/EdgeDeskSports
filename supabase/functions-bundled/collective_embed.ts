// collective_embed - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_embed
// IMPORTANT: turn OFF "Enforce JWT verification" for this function.

// ---------- inlined _shared/env.ts ----------
// Shared environment access for Collective edge functions.
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY are injected
// by the Supabase runtime. COLLECTIVE_BASE_URL is an optional secret that
// points at the public site root and defaults to production.

const SB_URL: string = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY: string = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY: string = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const BASE_URL: string = Deno.env.get("COLLECTIVE_BASE_URL") ?? "https://edgedesksports.com";

// ---------- inlined _shared/http.ts ----------
// Shared HTTP helpers: JSON responses, the contract error shape, CORS, and
// subpath routing. Every Collective edge function builds its responses here so
// the error taxonomy and CORS behavior stay identical across functions.

function corsHeaders(origin = "*"): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-collective-key, x-client-info",
    "Access-Control-Max-Age": "86400",
  };
  if (origin !== "*") {
    headers["Vary"] = "Origin";
  }
  return headers;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...headers,
    },
  });
}

// Error response in the contract shape { error: { code, message, details } }.
// details is always present, null when there is nothing row-level to report.
function err(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  return json({ error: { code, message, details: details ?? null } }, status);
}

// Returns a 204 Response for OPTIONS requests, else null.
function preflight(req: Request, origin = "*"): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Path after /functions/v1/<fnName>, normalized. Works both behind the
// production gateway (/functions/v1/<fnName>/...) and when served locally
// (/<fnName>/...). "" becomes "/", duplicate slashes collapse, and a
// trailing slash is stripped except on the root.
function subpath(req: Request, fnName: string): string {
  const pathname = new URL(req.url).pathname;
  const marker = `/${fnName}`;
  const idx = pathname.indexOf(marker);
  let rest = idx >= 0 ? pathname.slice(idx + marker.length) : pathname;
  if (!rest.startsWith("/")) rest = `/${rest}`;
  rest = rest.replace(/\/{2,}/g, "/");
  if (rest.length > 1 && rest.endsWith("/")) rest = rest.slice(0, -1);
  return rest;
}

// ---------- inlined _shared/db.ts ----------
// Shared database access. Edge functions never talk SQL: they call the
// SECURITY DEFINER RPCs in the collective schema through PostgREST with the
// service role key. RPCs return jsonb outcome objects like { ok: true, ... }
// or { ok: false, code: "token_expired", message: "..." }; callers translate
// ok:false codes to the HTTP error taxonomy. RpcError means an unexpected
// database failure and maps to 500 server_error (log it, never leak the body).


class RpcError extends Error {
  status: number;
  body: string;

  constructor(fn: string, status: number, body: string) {
    super(`rpc ${fn} failed with status ${status}`);
    this.name = "RpcError";
    this.status = status;
    this.body = body;
  }
}

async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "collective",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RpcError(fn, res.status, text);
  }
  if (text === "") {
    return null as T;
  }
  return JSON.parse(text) as T;
}

// ---------- inlined _shared/reads.ts ----------
// Shared read paths over the collective views via PostgREST, plus the
// response builders used by both the public API and the embed API. The
// embed and the site MUST render from identical data (Section 4 of the
// build prompt), so the builders live here once.



async function viewGet<T = unknown>(view: string, query: string): Promise<T[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${view}?${query}`, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": "collective",
    },
  });
  if (!res.ok) {
    throw new Error(`view ${view} read failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as T[];
}

async function viewCount(view: string, query: string, column = "id"): Promise<number> {
  const res = await fetch(`${SB_URL}/rest/v1/${view}?select=${column}&${query}`, {
    method: "HEAD",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": "collective",
      "Prefer": "count=exact",
    },
  });
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function tableWrite(
  table: string,
  method: "POST" | "PATCH" | "DELETE",
  query: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${query ? "?" + query : ""}`, {
    method,
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "collective",
      "Prefer": "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${table} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------ shapes

interface WallRow {
  creator_slug: string; creator_name: string; logo_url: string | null; monogram: string;
  founding: boolean; membership: string; model_slug: string; model_name: string; sport: string;
  record: {
    graded: number; wins: number; losses: number; pushes: number;
    win_pct: number | null; margin_mae: number | null; brier: number | null;
  } | null;
  coverage_pct: number | null; last_submission_at: string | null;
  website_url: string | null; x_handle: string | null;
}

interface WallViewRow {
  creator_slug: string; creator_name: string; logo_url: string | null; monogram: string;
  founding: boolean; website_url: string | null; x_handle: string | null; membership: string;
  model_slug: string; model_name: string; sport: string;
  graded: number | null; wins: number | null; losses: number | null; pushes: number | null;
  win_pct: number | null; margin_mae: number | null; brier: number | null;
  coverage_pct: number | null; last_submission_at: string | null;
}

const MEMBER_RANK: Record<string, number> = { "ACTIVE CONTRIBUTOR": 0, "MEMBER": 1, "INACTIVE": 2 };

function toWallRow(v: WallViewRow): WallRow {
  return {
    creator_slug: v.creator_slug, creator_name: v.creator_name, logo_url: v.logo_url,
    monogram: v.monogram, founding: v.founding, membership: v.membership,
    model_slug: v.model_slug, model_name: v.model_name, sport: v.sport,
    record: v.graded && v.graded > 0
      ? { graded: v.graded, wins: v.wins ?? 0, losses: v.losses ?? 0, pushes: v.pushes ?? 0,
          win_pct: v.win_pct, margin_mae: v.margin_mae, brier: v.brier }
      : null,
    coverage_pct: v.coverage_pct, last_submission_at: v.last_submission_at,
    website_url: v.website_url, x_handle: v.x_handle,
  };
}

// Canonical order everywhere: membership rank, then graded desc, then name.
// One ordering for every host and every surface (Section 4 hard rule).
async function buildWall(): Promise<WallRow[]> {
  const rows = await viewGet<WallViewRow>("model_wall", "select=*");
  return rows.map(toWallRow).sort((a, b) =>
    (MEMBER_RANK[a.membership] ?? 9) - (MEMBER_RANK[b.membership] ?? 9) ||
    ((b.record?.graded ?? 0) - (a.record?.graded ?? 0)) ||
    a.creator_name.localeCompare(b.creator_name));
}

interface MetaShape {
  name: string;
  pricing: { monthly_cents: number; annual_cents: number; currency: string };
  billing_live: boolean;
  sports: { code: string; name: string; season: number; in_season: boolean }[];
  counts: { creators: number; models: number; graded_games: number; live_projections: number };
  urls: { site: string; join_info: string; rules: string };
}

async function buildMeta(): Promise<MetaShape> {
  const [monthly, annual, billing, sports, seasons] = await Promise.all([
    rpc<unknown>("get_config", { p_key: "pricing.monthly_cents" }),
    rpc<unknown>("get_config", { p_key: "pricing.annual_cents" }),
    rpc<unknown>("get_config", { p_key: "billing.enabled" }),
    viewGet<{ code: string; name: string; active: boolean }>("sports", "select=code,name,active&active=is.true"),
    viewGet<{ sport_code: string; season: number; starts_on: string; ends_on: string }>(
      "sport_seasons", "select=*&order=season.desc"),
  ]);
  const [creators, models, settled, liveRows] = await Promise.all([
    viewCount("creators", "is_listed=is.true&status=eq.active"),
    viewCount("models", "is_listed=is.true"),
    viewCount("games", "status=eq.final"),
    viewCount("projections", "data_origin=eq.live&resolution_status=eq.resolved"),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const site = `${BASE_URL}/collective/`;
  return {
    name: "Model Collective",
    pricing: { monthly_cents: Number(monthly ?? 2499), annual_cents: Number(annual ?? 0), currency: "usd" },
    billing_live: billing === true,
    sports: sports.map((s) => {
      const season = seasons.find((x) => x.sport_code === s.code);
      return {
        code: s.code, name: s.name, season: season?.season ?? new Date().getFullYear(),
        in_season: !!season && season.starts_on <= today && today <= season.ends_on,
      };
    }),
    counts: { creators, models, graded_games: settled, live_projections: liveRows },
    urls: { site, join_info: site + "#about", rules: site + "#rules" },
  };
}

// ------------------------------------------------------------ the board

interface GameDetailRow {
  game_id: string; sport: string; season: number; week: number | null; kickoff_at: string;
  status: string; home: string; away: string; label: string;
  home_score: number | null; away_score: number | null;
  closing_spread: number | null; closing_total: number | null;
}
interface BoardModelRow {
  game_id: string; model_id: string; creator_slug: string; model_slug: string;
  pick_side: string | null; projected_spread: number | null; projected_total: number | null;
  home_win_prob: number | null; line_at_submission: number | null; cover_prob: number | null;
  received_at: string; is_late: boolean;
  pick_result: string | null; margin_error: number | null; brier: number | null;
}
interface ConsensusRow {
  game_id: string; n: number; spread_mean: number | null; spread_median: number | null;
  spread_stdev: number | null; spread_min: number | null; spread_max: number | null;
  total_mean: number | null; total_median: number | null; home_win_prob_mean: number | null;
  n_picks: number; pct_picks_home: number | null; agreement: number | null;
}

interface GamesPayload {
  sport: string; season: number; week: number | null; entitled: boolean;
  games: unknown[];
}

// The paid gate lives here, in the response body: a locked row carries no
// projection numbers at all (Section 5: the gate is in the API, not the DOM).
async function buildGames(
  sport: string, season: number, week: number | null, entitled: boolean,
): Promise<GamesPayload> {
  const wq = week === null ? "" : `&week=eq.${week}`;
  const games = await viewGet<GameDetailRow>(
    "game_detail", `select=*&sport=eq.${sport}&season=eq.${season}${wq}&order=kickoff_at.asc`);
  if (games.length === 0) return { sport, season, week, entitled, games: [] };
  const ids = games.map((g) => `"${g.game_id}"`).join(",");
  const [models, consensus] = await Promise.all([
    viewGet<BoardModelRow>("board_models", `select=*&game_id=in.(${ids})&order=received_at.asc`),
    viewGet<ConsensusRow>("consensus", `select=*&game_id=in.(${ids})`),
  ]);
  const now = Date.now();
  return {
    sport, season, week, entitled,
    games: games.map((g) => {
      const settled = g.status === "final" || (g.home_score !== null);
      // Postponed and canceled games keep a stale kickoff_at in the past;
      // they must stay locked or their pre-game numbers would leak free.
      const open = !settled &&
        (g.status === "postponed" || g.status === "canceled" ||
          new Date(g.kickoff_at).getTime() > now);
      const unlocked = entitled || settled || !open;
      const c = consensus.find((x) => x.game_id === g.game_id) ?? null;
      return {
        game_id: g.game_id, label: g.label, home: g.home, away: g.away,
        kickoff_at: g.kickoff_at, status: g.status,
        result: settled && g.home_score !== null
          ? { home_score: g.home_score, away_score: g.away_score,
              closing_spread: g.closing_spread, closing_total: g.closing_total }
          : null,
        consensus: !c || c.n === 0
          ? (unlocked ? null : { locked: true, n: c?.n ?? 0 })
          : (unlocked
            ? { locked: false, n: c.n, spread_mean: c.spread_mean, spread_median: c.spread_median,
                spread_stdev: c.spread_stdev, spread_min: c.spread_min, spread_max: c.spread_max,
                total_mean: c.total_mean, total_median: c.total_median,
                home_win_prob_mean: c.home_win_prob_mean,
                pct_picks_home: c.pct_picks_home, agreement: c.agreement }
            : { locked: true, n: c.n }),
        models: models.filter((m) => m.game_id === g.game_id).map((m) =>
          unlocked
            ? { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: false,
                late: m.is_late, pick_side: m.pick_side, projected_spread: m.projected_spread,
                projected_total: m.projected_total, home_win_probability: m.home_win_prob,
                line_at_submission: m.line_at_submission, cover_probability: m.cover_prob,
                received_at: m.received_at,
                grade: m.pick_result !== null || m.margin_error !== null || m.brier !== null
                  ? { pick_result: m.pick_result, margin_error: m.margin_error, brier: m.brier }
                  : null }
            : { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: true }),
      };
    }),
  };
}

// Entitlement: an active subscriber, or any creator (they contributed to
// the board), checked by the Collective and never by a host site.
async function isEntitled(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  // While billing is off, any signed-in account is entitled (contract 5.2:
  // the record is being built in the open; anonymous callers stay locked).
  const billing = await rpc<unknown>("get_config", { p_key: "billing.enabled" });
  if (billing !== true) return true;
  const [subs, creators] = await Promise.all([
    viewCount("subscribers", `user_id=eq.${userId}&status=in.(active,past_due)`),
    viewCount("creators", `user_id=eq.${userId}&status=eq.active`),
  ]);
  return subs > 0 || creators > 0;
}

// The current slate week: the week of the next game to kick off (with a
// 36 hour grace so a week stays current through its Monday night game),
// else the last week that has games.
async function currentWeek(sport: string, season: number): Promise<number | null> {
  const grace = new Date(Date.now() - 36 * 3600e3).toISOString();
  const next = await viewGet<{ week: number | null }>("game_detail",
    `select=week&sport=eq.${sport}&season=eq.${season}&kickoff_at=gte.${encodeURIComponent(grace)}&week=not.is.null&order=kickoff_at.asc&limit=1`);
  if (next[0]?.week != null) return next[0].week;
  const last = await viewGet<{ week: number | null }>("game_detail",
    `select=week&sport=eq.${sport}&season=eq.${season}&week=not.is.null&order=kickoff_at.desc&limit=1`);
  return last[0]?.week ?? null;
}

const RULES = {
  version: 1,
  rules: [
    "Pick result: decided by the final score. The actual margin is measured against the Collective's own captured closing spread (home convention) on the pick side; the captured close is the yardstick so every model faces the same number, never the line a creator reports. Push on the exact number, excluded from win percentage. Never graded against a creator-supplied result column.",
    "Margin error: absolute difference between projected home margin and actual home margin. Projected home margin comes from projected scores when given, otherwise from the projected spread.",
    "Brier: squared error on the moneyline home win probability. 0.25 is a coin flip. Lower is better.",
    "First submission: each model is graded on its first pre-kickoff live submission per game, timestamped on server receipt. Later revisions are stored and shown as movement, never regraded. Post-kickoff receipts are stored, marked late, and excluded. Backfill and test data are stored, shown separately, and excluded from records, rankings, and consensus.",
    "Rankings: a model must cover at least 60 percent of the season slate to date and have at least 20 graded games. Win percentage, margin error, and Brier are ranked separately and never blended.",
  ],
};

// ---------- collective_embed/index.ts ----------
// Model Collective embed API. One bootstrap payload renders the Collective
// tab on a member's site. The payload is built identically for every host
// and only annotated with the host pin afterward: a host cannot hide a
// rival, reorder rankings, or filter a bad week (Section 4, enforced here
// server side). The lock is the per-creator origin allowlist; the slug in
// page source is deliberately harmless anywhere else.





function corsFor(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function originHost(req: Request): string | null {
  const o = req.headers.get("origin") ?? "";
  if (o) return o;
  const ref = req.headers.get("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function originAllowed(creatorId: string | null, origin: string | null): Promise<boolean> {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // The Collective's own domain always renders itself.
  const base = new URL(BASE_URL).hostname;
  if (host === base || host === `www.${base}`) return true;
  if (host === "localhost" || host === "127.0.0.1") {
    const allow = await rpc<unknown>("get_config", { p_key: "embed.allow_localhost" });
    if (allow === true) return true;
  }
  if (!creatorId) return false;
  // Full-origin comparison (scheme plus host plus port), not hostname only:
  // an http page or an odd port on a registered host does not pass.
  let normalized: string;
  try {
    const ou = new URL(origin);
    normalized = `${ou.protocol}//${ou.host}`;
  } catch {
    return false;
  }
  const rows = await viewGet<{ id: string; origin: string }>(
    "embed_installs", `select=id,origin&creator_id=eq.${creatorId}&status=eq.active`);
  return rows.some((r) => {
    try {
      const ru = new URL(r.origin);
      return `${ru.protocol}//${ru.host}` === normalized;
    } catch {
      return false;
    }
  });
}

Deno.serve(async (req) => {
  const origin = originHost(req);
  const cors = corsFor(origin);
  const pre = preflight(req);
  if (pre) return new Response(null, { status: 204, headers: cors });
  const path = subpath(req, "collective_embed");

  try {
    if (req.method === "GET" && path === "/v1/embed/bootstrap") {
      const u = new URL(req.url);
      // Slug shape is enforced before it ever reaches a PostgREST filter.
      const rawHost = (u.searchParams.get("host") ?? "").trim();
      const hostSlug = /^[a-z0-9-]{1,40}$/.test(rawHost) ? rawHost : "";

      let hostCreator: { id: string; slug: string; display_name: string } | null = null;
      if (hostSlug) {
        const rows = await viewGet<{ id: string; slug: string; display_name: string }>(
          "creators", `select=id,slug,display_name&slug=eq.${hostSlug}&status=eq.active&limit=1`);
        hostCreator = rows[0] ?? null;
      }

      if (!(await originAllowed(hostCreator?.id ?? null, origin))) {
        return new Response(JSON.stringify({
          error: { code: "forbidden_origin",
            message: "This domain is not registered for this Collective embed.", details: null },
        }), { status: 403, headers: { "content-type": "application/json", ...cors } });
      }

      const [meta, wallCanonical, cacheSeconds] = await Promise.all([
        buildMeta(),
        buildWall(),
        rpc<unknown>("get_config", { p_key: "embed.cache_seconds" }),
      ]);

      // Identical payload for every host; the single host privilege is the
      // pin annotation applied after the canonical build.
      const wall = [...wallCanonical];
      if (hostCreator) {
        const i = wall.findIndex((w) => w.creator_slug === hostCreator!.slug);
        if (i > 0) wall.unshift(wall.splice(i, 1)[0]);
      }

      const sport = meta.sports[0];
      const board = sport
        ? await buildGames(sport.code, sport.season, null, false)
        : { games: [] as unknown[] };
      type BoardGame = { status: string; kickoff_at: string; result: unknown };
      const games = board.games as BoardGame[];
      const now = Date.now();
      const upcoming = games.filter((g) =>
        g.result === null && new Date(g.kickoff_at).getTime() > now).slice(0, 16);
      const settled = games.filter((g) => g.result !== null).slice(-10).reverse();

      const creators = wall.reduce((acc: Record<string, unknown>[], w) => {
        let c = acc.find((x) => x.slug === w.creator_slug);
        if (!c) {
          c = {
            slug: w.creator_slug, display_name: w.creator_name, monogram: w.monogram,
            logo_url: w.logo_url, website_url: w.website_url, x_handle: w.x_handle,
            membership: w.membership, founding: w.founding, models: [] as unknown[],
          };
          acc.push(c);
        }
        (c.models as unknown[]).push({
          model_name: w.model_name, sport: w.sport, record: w.record, coverage_pct: w.coverage_pct,
        });
        return acc;
      }, []);

      const refq = hostSlug ? `?ref=${encodeURIComponent(hostSlug)}` : "";
      if (hostCreator) {
        // touch install freshness, best effort
        tableWrite("embed_installs", "PATCH",
          `creator_id=eq.${hostCreator.id}`, { last_seen_at: new Date().toISOString() })
          .catch(() => {});
      }

      return json({
        host: hostCreator
          ? { creator_slug: hostCreator.slug, creator_name: hostCreator.display_name, pinned: true }
          : null,
        meta, wall, creators,
        upcoming: { entitled: false, games: upcoming },
        settled: { games: settled },
        subscribe_url: `${BASE_URL}/collective/${refq}#join`,
        collective_url: `${BASE_URL}/collective/${refq}`,
        cache_seconds: Number(cacheSeconds ?? 60),
      }, 200, { ...cors, "cache-control": `public, max-age=${Number(cacheSeconds ?? 60)}` });
    }

    if (req.method === "POST" && path === "/v1/embed/events") {
      const body = await req.json().catch(() => null) as {
        host?: string; visitor?: string;
        events?: { type?: string; target?: string | null; path?: string; at?: string }[];
      } | null;
      if (!body || !Array.isArray(body.events)) {
        return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json", ...cors } });
      }
      const VALID = ["impression", "profile_view", "outbound_click", "collective_click", "subscribe_click"];
      const hostSlug = typeof body.host === "string" && /^[a-z0-9-]{1,40}$/.test(body.host) ? body.host : "";
      const visitor = typeof body.visitor === "string" ? body.visitor.slice(0, 64) : null;
      let creatorId: string | null = null;
      if (hostSlug) {
        const rows = await viewGet<{ id: string }>("creators", `select=id&slug=eq.${hostSlug}&limit=1`);
        creatorId = rows[0]?.id ?? null;
      }
      // Events pass the SAME origin allowlist as bootstrap: engagement is a
      // future payment signal (Section 5), so an unregistered origin cannot
      // write events or mint first touches. Still 202: the embed never sees
      // an error for telemetry.
      if (!(await originAllowed(creatorId, origin))) {
        return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json", ...cors } });
      }
      const events = body.events.slice(0, 50).filter((e) => VALID.includes(e.type ?? ""));
      if (events.length) {
        const referrer = (req.headers.get("referer") ?? "").slice(0, 300) || null;
        const slugRe = /^[a-z0-9-]{1,40}$/;
        const targetSlugs = [...new Set(events.map((e) => e.target).filter((t): t is string => typeof t === "string" && slugRe.test(t)))];
        const targets = targetSlugs.length
          ? await viewGet<{ id: string; slug: string }>("creators", `select=id,slug&slug=in.(${targetSlugs.join(",")})`)
          : [];
        await tableWrite("embed_events", "POST", "", events.map((e) => ({
          creator_id: creatorId, event_type: e.type, visitor_id: visitor,
          target_creator_id: targets.find((t) => t.slug === e.target)?.id ?? null,
          referrer,
          path: (e.path ?? "").slice(0, 300), origin: origin ?? null,
        }))).catch((e) => console.error("embed_events insert failed:", e));
        // Attribution first touch on the referring creator (Section 5):
        // recorded on engagement that shows intent to follow the Collective.
        if (visitor && hostSlug && events.some((e) => e.type === "subscribe_click" || e.type === "collective_click" || e.type === "impression")) {
          await rpc("record_touch", {
            p_visitor: visitor, p_creator_slug: hostSlug, p_source: "embed", p_origin: origin,
          }).catch((e) => console.error("record_touch failed:", e));
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json", ...cors } });
    }

    return new Response(JSON.stringify({
      error: { code: "not_found", message: `No such route: ${req.method} ${path}`, details: null },
    }), { status: 404, headers: { "content-type": "application/json", ...cors } });
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_embed rpc failure:", e.message, e.body);
    else console.error("collective_embed failure:", e);
    return new Response(JSON.stringify({
      error: { code: "server_error", message: "Something went wrong on our side.", details: null },
    }), { status: 500, headers: { "content-type": "application/json", ...cors } });
  }
});
