// collective_odds - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_odds
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
      "authorization, apikey, content-type, x-collective-key, x-collective-collector, x-client-info",
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

// ---------- inlined _shared/auth.ts ----------
// Shared JWT auth. Bearer tokens are validated against Supabase Auth by
// calling /auth/v1/user; the JWT is never decoded locally, so revoked or
// expired sessions fail closed. Admin checks compare the user id against the
// admin.user_ids config list via the get_config RPC.




async function getUser(
  req: Request,
): Promise<{ id: string; email: string | null } | null> {
  const authz = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  let res: Response;
  try {
    res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: {
        "apikey": ANON_KEY,
        "Authorization": authz,
      },
    });
  } catch (e) {
    console.error("auth.getUser: auth service unreachable:", e);
    return null;
  }
  if (!res.ok) return null;
  const user = await res.json().catch(() => null) as
    | { id?: string; email?: string | null }
    | null;
  if (!user || typeof user.id !== "string" || user.id.length === 0) return null;
  return { id: user.id, email: typeof user.email === "string" ? user.email : null };
}

// getUser plus membership of admin.user_ids. Returns the user, or an err()
// Response (401 invalid_key or 403 forbidden) ready to return to the caller.
async function requireAdmin(
  req: Request,
): Promise<{ id: string; email: string | null } | Response> {
  const user = await getUser(req);
  if (!user) {
    return err("invalid_key", "A valid signed-in session is required.", 401);
  }
  const cfg = await rpc<unknown>("get_config", { p_key: "admin.user_ids" });
  const ids = Array.isArray(cfg) ? cfg.filter((v) => typeof v === "string") : [];
  if (!ids.includes(user.id)) {
    return err("forbidden", "This account is not an administrator.", 403);
  }
  return user;
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
interface MarketRow {
  game_id: string; book: string; source: string;
  home_line: number | null; home_price: number | null;
  away_line: number | null; away_price: number | null;
  total_line: number | null; over_price: number | null; under_price: number | null;
  home_ml_price: number | null; away_ml_price: number | null;
  captured_at: string;
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
  const [models, market, consensus] = await Promise.all([
    viewGet<BoardModelRow>("board_models", `select=*&game_id=in.(${ids})&order=received_at.asc`),
    viewGet<MarketRow>("current_market", `select=*&game_id=in.(${ids})`),
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
        market: (() => {
          const mk = market.find((x) => x.game_id === g.game_id);
          return mk
            ? { book: mk.book, source: mk.source, home_line: mk.home_line,
                home_price: mk.home_price, away_line: mk.away_line,
                away_price: mk.away_price, total_line: mk.total_line,
                over_price: mk.over_price, under_price: mk.under_price,
                home_ml_price: mk.home_ml_price, away_ml_price: mk.away_ml_price,
                captured_at: mk.captured_at }
            : null;
        })(),
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

// ---------- inlined _shared/oddsblaze.ts ----------
// OddsBlaze adapter: the only file in the Collective that knows what an odds
// provider's JSON looks like. Everything downstream of normalizeOddsBlaze()
// sees the record_market_snapshots row shape from docs/collective/M-odds.md
// section 7 and nothing else, which is what makes the provider replaceable.
//
// Deliberately free of Deno APIs so it can be exercised offline against the
// captured fixture in tools/collective/fixtures/. The API key is read in
// collective_odds/index.ts and passed in as an argument; it is never read,
// stored, or logged here.
//
// ---------------------------------------------------------------- the feed
//
// Written against a real captured response (DraftKings / MLB), not against a
// guess. One sportsbook and one league per call, the key carried as the `key`
// query parameter:
//
//   { "updated": "2026-08-20T21:52:44.736Z",
//     "league":     { "id": "mlb", "name": "MLB", "sport": "Baseball" },
//     "sportsbook": { "id": "draftkings", "name": "DraftKings" },
//     "events": [
//       { "id": "d18ab4b2-...", "date": "2026-08-21T00:05:00.000Z", "live": false,
//         "mappings": { "MLB": { "id": "822861" }, "Kalshi": { "id": "KXMLB..." } },
//         "teams": { "home": { "id": "...", "name": "Texas Rangers", "abbreviation": "TEX" },
//                    "away": { "id": "...", "name": "Washington Nationals", "abbreviation": "WSH" } },
//         "odds": [
//           { "id": "DraftKings#<event>#Run Line#Texas Rangers -1.5",
//             "market": "Run Line", "name": "Texas Rangers -1.5", "price": "-181",
//             "main": true, "selection": { "name": "Texas Rangers", "line": -1.5 } },
//           { "market": "Total Runs", "name": "Over 7.5", "price": "-105",
//             "main": true, "selection": { "side": "Over", "line": 7.5 } } ] } ] }
//
// Three things about that shape are easy to get wrong and are the reason this
// file exists:
//
//   * `selection` is an OBJECT, not a string. The team is `selection.name`,
//     the over/under side is `selection.side`, and the handicap or total is
//     `selection.line`. There is no top-level `points` field.
//   * market names are the sport's own vocabulary — "Run Line", "Total Runs" —
//     and the same words prefixed by a period name a different bet entirely
//     ("1st 5 Innings Run Line", "Team Total Runs"). Classification is by
//     exact match for that reason: a substring rule writes an inning's line
//     into the game line and nothing downstream can tell.
//   * `main: true` appears on player props too. It separates the primary line
//     from alternates WITHIN a market; it does not mark the game line.
//
// Field names the capture shows are read first; documented synonyms are
// accepted; anything it cannot read with confidence is reported as a skip
// with a reason rather than guessed at. `GET /v1/odds/probe` prints the shape
// the live feed actually returned, so a drift shows up as a probe diff
// instead of as silently wrong numbers on the board.

// ------------------------------------------------------------------ types

interface SeasonWindow {
  sport_code: string;
  season: number;
  starts_on: string; // date
  ends_on: string; // date
}

// A row in the record_market_snapshots contract (M-odds section 7).
interface SnapshotRow {
  sport: string;
  season: number;
  market: "spread";
  home_team: string;
  away_team: string;
  kickoff: string;
  book: string;
  source: string;
  captured_at: string;
  home_line: number | null;
  home_price: number | null;
  away_line: number | null;
  away_price: number | null;
  total_line: number | null;
  over_price: number | null;
  under_price: number | null;
  home_ml_price: number | null;
  away_ml_price: number | null;
}

// A row for collective.link_provider_events.
interface EventLinkRow {
  provider: string;
  provider_event_id: string;
  sport: string;
  season: number | null;
  home_team: string;
  away_team: string;
  starts_at: string;
  mappings: Record<string, unknown>;
}

interface Skipped {
  reason: string;
  event_id?: string;
  detail?: string;
}

interface NormalizeResult {
  rows: SnapshotRow[];
  links: EventLinkRow[];
  skipped: Skipped[];
  book: string | null;
  league: string | null;
  captured_at: string;
}

interface NormalizeOptions {
  // league id from the feed -> Collective sport code, e.g. { mlb: "MLB" }.
  leagueToSport: Record<string, string>;
  seasons: SeasonWindow[];
  // Used when the feed carries no `updated` timestamp.
  now: string;
  source?: string;
  // In-progress games. Off by default: a live price is a different market
  // from the pregame one, and the closing line is defined as the last
  // snapshot before kickoff. Mixing them would corrupt CLV silently.
  includeLive?: boolean;
}

// The league ids the feed uses, mapped to Collective sport codes. Overridable
// from config so a new league needs no deploy.
const DEFAULT_LEAGUE_TO_SPORT: Record<string, string> = {
  mlb: "MLB",
  nfl: "NFL",
  ncaaf: "NCAAF",
  "ncaa football": "NCAAF",
};

// --------------------------------------------------------------- utilities

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

// Reads the first present key. The captured name always leads.
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

// American prices only. A price that is not an integer, or whose magnitude is
// under 100, is not American: it is decimal, fractional, or probability, and
// storing it as American would be a silent factor-of-anything error. Rejected
// rather than converted, because guessing which format arrived is guessing.
function parseAmericanPrice(v: unknown): number | null {
  let raw: string | null = null;
  if (typeof v === "number") raw = String(v);
  else if (typeof v === "string") raw = v.trim();
  else if (isObj(v)) raw = str(pick(v, ["american", "price", "odds"]));
  if (!raw) return null;
  raw = raw.replace(/^\+/, "").replace(/,/g, "");
  if (!/^-?\d+(\.0+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return Math.trunc(n);
}

// A points/handicap value: -1.5, "-1.5", "+3.5", "7.5". "PK"/"EVEN" is 0.
function parsePoints(v: unknown): number | null {
  let raw: string | null = null;
  if (typeof v === "number") raw = String(v);
  else if (typeof v === "string") raw = v.trim();
  if (!raw) return null;
  if (/^(pk|pick|pick'?em|even)$/i.test(raw)) return 0;
  raw = raw.replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type MarketKind = "spread" | "moneyline" | "total" | null;

// The full-game two-way markets, by exact normalized name. Exactness is the
// whole safety property: "1st 5 Innings Run Line", "3rd Inning Run Line",
// "Team Total Runs", and "Player Hits" all normalize to tokens that are not
// in these sets, so a derivative market can never be read as the game line.
// Adding a league means adding its words here, deliberately, in one place.
const SPREAD_MARKETS = new Set([
  "pointspread", "pointspreads", "spread", "spreads",
  "runline", "runlines", "puckline", "pucklines", "handicap", "asianhandicap",
]);
const MONEYLINE_MARKETS = new Set([
  "moneyline", "moneylines", "ml", "headtohead", "h2h", "matchwinner",
]);
const TOTAL_MARKETS = new Set([
  "total", "totals", "totalpoints", "totalruns", "totalgoals", "overunder",
  "totalpointsoverunder",
]);

function classifyMarket(market: unknown): MarketKind {
  const raw = typeof market === "string"
    ? market
    : isObj(market)
    ? (str(pick(market, ["id", "name"])) ?? "")
    : "";
  const t = normToken(raw);
  if (!t) return null;
  if (SPREAD_MARKETS.has(t)) return "spread";
  if (MONEYLINE_MARKETS.has(t)) return "moneyline";
  if (TOTAL_MARKETS.has(t)) return "total";
  return null;
}

interface TeamRef {
  id: string | null;
  name: string | null;
  abbreviation: string | null;
}

function teamRef(v: unknown): TeamRef {
  if (typeof v === "string") return { id: null, name: v.trim() || null, abbreviation: null };
  if (!isObj(v)) return { id: null, name: null, abbreviation: null };
  return {
    id: str(pick(v, ["id"])),
    name: str(pick(v, ["name", "full_name", "display_name"])),
    abbreviation: str(pick(v, ["abbreviation", "abbr", "short_name", "code"])),
  };
}

// What an odds entry is selecting. The capture puts all three parts inside
// `selection`; a feed that sends a bare string, or that hoists the parts to
// the top level, is read too.
interface Selection {
  team: string | null;
  side: string | null;
  line: number | null;
}

function selectionOf(o: Record<string, unknown>): Selection {
  const sel = o["selection"];
  let team: string | null = null;
  let side: string | null = null;
  let line: number | null = null;

  if (isObj(sel)) {
    team = str(pick(sel, ["name", "team", "participant"]));
    side = str(pick(sel, ["side", "type"]));
    line = parsePoints(pick(sel, ["line", "points", "point", "handicap", "total"]));
  } else if (typeof sel === "string") {
    team = sel.trim() || null;
  }

  if (team === null) team = str(pick(o, ["team", "participant"]));
  if (side === null) side = str(pick(o, ["side"]));
  if (line === null) {
    line = parsePoints(pick(o, ["points", "point", "line", "handicap", "spread", "total"]));
  }

  // Last resort: the display name, which leads with the team and ends with
  // the number — "Texas Rangers -1.5", "Over 7.5".
  const name = str(pick(o, ["name"]));
  if (name) {
    if (line === null) {
      const m = name.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
      if (m) line = parsePoints(m[1]);
    }
    if (side === null) {
      const m = name.match(/\b(over|under)\b/i);
      if (m) side = m[1];
    }
    if (team === null) team = name;
  }
  return { team, side, line };
}

// Which side of a two-way team market this selection is. An exact match on
// the abbreviation, exact-or-prefix on the name: "New York Yankees" and
// "New York Mets" must never collide, and a bare "NY" must never be taken as
// either. A selection that hits both teams, or neither, is not read.
function sideForTeam(sel: Selection, home: TeamRef, away: TeamRef): "home" | "away" | null {
  if (!sel.team) return null;
  const t = normToken(sel.team);
  if (!t) return null;
  const hits = (ref: TeamRef) => {
    const name = ref.name ? normToken(ref.name) : "";
    if (name && (t === name || t.startsWith(name))) return true;
    const abbr = ref.abbreviation ? normToken(ref.abbreviation) : "";
    if (abbr && t === abbr) return true;
    const id = ref.id ? normToken(ref.id) : "";
    return Boolean(id) && t === id;
  };
  const h = hits(home);
  const a = hits(away);
  if (h && !a) return "home";
  if (a && !h) return "away";
  return null;
}

function sideForTotal(sel: Selection): "over" | "under" | null {
  const raw = sel.side ?? sel.team;
  if (!raw) return null;
  const t = normToken(raw);
  if (t === "over" || t === "o" || t.startsWith("over")) return "over";
  if (t === "under" || t === "u" || t.startsWith("under")) return "under";
  return null;
}

// ISO 8601 or epoch seconds/milliseconds. Anything else is unreadable, not
// "now": a snapshot stamped with the wrong time is worse than no snapshot.
function parseTimestamp(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = str(v);
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseTimestamp(Number(s));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The season a kickoff belongs to, from collective.sport_seasons and nothing
// else. A kickoff outside every configured window returns null and the row is
// skipped: resolve_game_ref matches on an exact season, so a guessed season
// silently fails to match instead of loudly refusing.
function seasonFor(
  sport: string,
  kickoffIso: string,
  seasons: SeasonWindow[],
): number | null {
  const t = new Date(kickoffIso).getTime();
  if (isNaN(t)) return null;
  for (const w of seasons) {
    if (w.sport_code !== sport) continue;
    const start = new Date(`${w.starts_on}T00:00:00Z`).getTime();
    const end = new Date(`${w.ends_on}T23:59:59Z`).getTime();
    if (t >= start && t <= end) return w.season;
  }
  return null;
}

// ------------------------------------------------------------- normalizer

interface Payload {
  updated?: unknown;
  sportsbook?: unknown;
  league?: unknown;
  events?: unknown;
}

// Accepts a single payload, an array of payloads (several sportsbook/league
// calls collected together), or a bare array of events.
function payloadsOf(body: unknown): Payload[] {
  if (Array.isArray(body)) {
    if (body.length > 0 && isObj(body[0]) && "events" in (body[0] as object)) {
      return body as Payload[];
    }
    return [{ events: body }];
  }
  if (!isObj(body)) return [];
  if (Array.isArray(body.events)) return [body as Payload];
  for (const k of ["data", "odds", "results", "leagues", "sportsbooks"]) {
    const inner = body[k];
    if (Array.isArray(inner)) return payloadsOf(inner);
  }
  return [];
}

function normalizeOddsBlaze(body: unknown, opts: NormalizeOptions): NormalizeResult {
  const source = opts.source ?? "oddsblaze";
  const rows: SnapshotRow[] = [];
  const links: EventLinkRow[] = [];
  const skipped: Skipped[] = [];
  let book: string | null = null;
  let league: string | null = null;
  let captured = opts.now;

  const payloads = payloadsOf(body);
  if (payloads.length === 0) {
    return {
      rows,
      links,
      skipped: [{ reason: "no_events_in_response" }],
      book,
      league,
      captured_at: captured,
    };
  }

  for (const p of payloads) {
    const sbObj = isObj(p.sportsbook) ? p.sportsbook : {};
    const payloadBook = typeof p.sportsbook === "string"
      ? p.sportsbook
      : str(pick(sbObj, ["name", "id"]));
    const lgObj = isObj(p.league) ? p.league : {};
    const payloadLeague = typeof p.league === "string"
      ? p.league
      : str(pick(lgObj, ["id", "name"]));
    const payloadCaptured = parseTimestamp(
      pick(p as Record<string, unknown>, ["updated", "timestamp", "last_updated"]),
    );
    if (payloadCaptured) captured = payloadCaptured;
    if (payloadBook) book = payloadBook;
    if (payloadLeague) league = payloadLeague;

    const sportFromLeague = payloadLeague
      ? opts.leagueToSport[payloadLeague.toLowerCase()] ?? null
      : null;

    const events = Array.isArray(p.events) ? p.events : [];
    for (const ev of events) {
      if (!isObj(ev)) {
        skipped.push({ reason: "event_not_an_object" });
        continue;
      }
      const eventId = str(pick(ev, ["id", "event_id"]));

      if (ev.live === true && !opts.includeLive) {
        skipped.push({ reason: "live_game", event_id: eventId ?? undefined });
        continue;
      }

      // Teams. teams.home / teams.away as captured; the flat form is accepted
      // because it is the other common spelling.
      const teamsObj = isObj(ev.teams) ? ev.teams : null;
      const home = teamRef(teamsObj ? pick(teamsObj, ["home"]) : pick(ev, ["home_team", "home"]));
      const away = teamRef(teamsObj ? pick(teamsObj, ["away"]) : pick(ev, ["away_team", "away"]));
      if (!home.name || !away.name) {
        skipped.push({ reason: "unreadable_teams", event_id: eventId ?? undefined });
        continue;
      }

      const kickoff = parseTimestamp(
        pick(ev, ["date", "start_date", "start_time", "starts_at", "commence_time"]),
      );
      if (!kickoff) {
        skipped.push({ reason: "unreadable_kickoff", event_id: eventId ?? undefined });
        continue;
      }

      const evLeague = isObj(ev.league) ? str(pick(ev.league, ["id", "name"])) : str(ev.league);
      const sport = sportFromLeague ??
        (evLeague ? opts.leagueToSport[evLeague.toLowerCase()] ?? null : null);
      if (!sport) {
        skipped.push({
          reason: "league_not_mapped_to_sport",
          event_id: eventId ?? undefined,
          detail: payloadLeague ?? evLeague ?? "unknown",
        });
        continue;
      }

      const season = seasonFor(sport, kickoff, opts.seasons);
      if (season === null) {
        skipped.push({
          reason: "kickoff_outside_configured_seasons",
          event_id: eventId ?? undefined,
          detail: kickoff,
        });
        continue;
      }

      const evBook = isObj(ev.sportsbook)
        ? str(pick(ev.sportsbook, ["name", "id"]))
        : str(ev.sportsbook);
      const rowBook = evBook ?? payloadBook;
      if (!rowBook) {
        skipped.push({ reason: "no_sportsbook_on_response", event_id: eventId ?? undefined });
        continue;
      }

      const oddsList = Array.isArray(ev.odds)
        ? ev.odds
        : Array.isArray((ev as Record<string, unknown>).markets)
        ? (ev as Record<string, unknown>).markets as unknown[]
        : [];

      const row: SnapshotRow = {
        sport,
        season,
        market: "spread",
        home_team: home.name,
        away_team: away.name,
        kickoff,
        book: rowBook,
        source,
        captured_at: payloadCaptured ?? captured,
        home_line: null,
        home_price: null,
        away_line: null,
        away_price: null,
        total_line: null,
        over_price: null,
        under_price: null,
        home_ml_price: null,
        away_ml_price: null,
      };

      // `main` separates the primary line from alternates within a market.
      // Alternates carry main:false and are skipped: one snapshot row is the
      // game line, and an alt line written into it would misreport what the
      // book was hanging. Where a book posts more than one primary line (the
      // capture shows DraftKings hanging both a -1.5 and a -1 run line, both
      // main), the first in feed order wins and the rest are left alone —
      // deterministic, and it is the line the book lists first.
      const taken = new Set<string>();
      let sawAlt = false;
      for (const o of oddsList) {
        if (!isObj(o)) continue;
        const kind = classifyMarket(pick(o, ["market", "market_name", "market_id"]));
        if (!kind) continue;
        if (pick(o, ["main"]) === false) {
          sawAlt = true;
          continue;
        }
        const sel = selectionOf(o);
        const price = parseAmericanPrice(pick(o, ["price", "odds", "american", "american_odds"]));

        if (kind === "moneyline") {
          const side = sideForTeam(sel, home, away);
          if (!side || price === null) continue;
          const slot = side === "home" ? "home_ml_price" : "away_ml_price";
          if (taken.has(slot)) continue;
          row[slot] = price;
          taken.add(slot);
          continue;
        }

        if (kind === "spread") {
          const side = sideForTeam(sel, home, away);
          if (!side || sel.line === null) continue;
          const slot = side === "home" ? "spread_home" : "spread_away";
          if (taken.has(slot)) continue;
          taken.add(slot);
          if (side === "home") {
            row.home_line = sel.line;
            row.home_price = price;
          } else {
            row.away_line = sel.line;
            row.away_price = price;
          }
          continue;
        }

        // total
        const side = sideForTotal(sel);
        if (!side || sel.line === null) continue;
        const slot = side === "over" ? "total_over" : "total_under";
        if (taken.has(slot)) continue;
        taken.add(slot);
        if (row.total_line === null) row.total_line = sel.line;
        if (side === "over") row.over_price = price;
        else row.under_price = price;
      }

      // Home convention, enforced here so the database CHECK never sees a
      // violation: the stored pair is always home_line = -away_line. A book
      // quoting only the away side is flipped before writing, never after.
      if (row.home_line !== null && row.away_line !== null) {
        if (row.home_line !== -row.away_line) {
          // Two different lines in one capture is a feed the reader does not
          // understand. The spread is dropped; totals and moneyline still
          // stand, because they are independently readable.
          skipped.push({
            reason: "spread_sides_disagree",
            event_id: eventId ?? undefined,
            detail: `home ${row.home_line} vs away ${row.away_line}`,
          });
          row.home_line = null;
          row.away_line = null;
          row.home_price = null;
          row.away_price = null;
        }
      } else if (row.home_line === null && row.away_line !== null) {
        row.home_line = -row.away_line;
      } else if (row.away_line === null && row.home_line !== null) {
        row.away_line = -row.home_line;
      }

      const hasMarket = row.home_line !== null || row.total_line !== null ||
        row.home_ml_price !== null || row.away_ml_price !== null;
      if (!hasMarket) {
        skipped.push({
          reason: sawAlt ? "no_main_line_only_alternates" : "no_readable_game_line",
          event_id: eventId ?? undefined,
        });
        continue;
      }

      rows.push(row);
      if (eventId) {
        links.push({
          provider: source,
          provider_event_id: eventId,
          sport,
          season,
          home_team: home.name,
          away_team: away.name,
          starts_at: kickoff,
          mappings: collectMappings(ev, home, away),
        });
      }
    }
  }

  return { rows, links, skipped, book, league, captured_at: captured };
}

// Ids the feed carries for the same fixture, kept as a ledger so a later
// settle-from-official-id path has something to work with. Never
// authoritative. The capture nests them one level — { "MLB": { "id": "822861" },
// "Kalshi": { "id": "KXMLB..." } } — so each provider is flattened to its id.
function collectMappings(
  ev: Record<string, unknown>,
  home: TeamRef,
  away: TeamRef,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const m = ev["mappings"];
  if (isObj(m)) {
    for (const [k, v] of Object.entries(m)) {
      const id = isObj(v) ? str(pick(v, ["id", "value"])) : str(v);
      if (id) out[k] = id;
    }
  }
  for (const k of ["sport_id", "league_id", "espn_id", "sportradar_id", "sr_id", "external_id"]) {
    const v = str(ev[k]);
    if (v) out[k] = v;
  }
  if (home.id) out.home_team_id = home.id;
  if (away.id) out.away_team_id = away.id;
  if (home.abbreviation) out.home_abbr = home.abbreviation;
  if (away.abbreviation) out.away_abbr = away.abbreviation;
  return out;
}

// ------------------------------------------------------------------ fetch

// The documented odds endpoint: one sportsbook, one league, key as a query
// parameter. Not guessed — it is the URL the captured response came from.
// ODDS_API_BASE_URL overrides it without a deploy if the account is served
// somewhere else; sportsbook and league are appended unless already present.
const ODDS_BASE_URL = "https://odds.oddsblaze.com/";

function oddsUrl(
  baseUrl: string | null,
  sportsbook: string,
  league: string,
  key: string,
): string {
  const u = new URL(baseUrl || ODDS_BASE_URL);
  if (!u.searchParams.has("sportsbook")) u.searchParams.set("sportsbook", sportsbook);
  if (!u.searchParams.has("league")) u.searchParams.set("league", league);
  u.searchParams.set("key", key);
  return u.toString();
}

// A URL safe to print: the key never appears in a response, a log line, or an
// error message.
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("key")) u.searchParams.set("key", "REDACTED");
    return u.toString();
  } catch {
    return "unparseable-url";
  }
}

interface FetchOutcome {
  ok: boolean;
  url: string; // redacted
  status: number;
  body: unknown;
  error?: string;
}

async function fetchOddsBlaze(
  fetchImpl: typeof fetch,
  baseUrl: string | null,
  sportsbook: string,
  league: string,
  key: string,
  timeoutMs = 20000,
): Promise<FetchOutcome> {
  const url = oddsUrl(baseUrl, sportsbook, league, key);
  const shown = redactUrl(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "Accept": "application/json" },
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // The provider's error text can echo the request, key included. The
      // status is reported; the body never is.
      return { ok: false, url: shown, status: res.status, body: null, error: `provider_status_${res.status}` };
    }
    try {
      return { ok: true, url: shown, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, url: shown, status: res.status, body: null, error: "provider_returned_non_json" };
    }
  } catch (e) {
    return {
      ok: false,
      url: shown,
      status: 0,
      body: null,
      error: e instanceof Error && e.name === "AbortError" ? "provider_timeout" : "provider_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- probe

// The shape of a value, to the depth worth reading: enough to compare the
// live response against the shape this adapter was written for, without
// printing odds data or anything else that could carry a credential.
function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    return depth >= 4
      ? `array[${v.length}]`
      : { array: v.length, of: v.length ? shapeOf(v[0], depth + 1) : "empty" };
  }
  if (isObj(v)) {
    if (depth >= 4) return `object{${Object.keys(v).length}}`;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).slice(0, 40)) out[k] = shapeOf(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

// The market names the feed printed and whether this adapter reads each one.
// The answer to "why is there no line for that game" is usually here.
function marketCensus(body: unknown): Array<{ market: string; count: number; read_as: string }> {
  const seen = new Map<string, number>();
  for (const p of payloadsOf(body)) {
    const events = Array.isArray(p.events) ? p.events : [];
    for (const ev of events) {
      if (!isObj(ev)) continue;
      const oddsList = Array.isArray(ev.odds) ? ev.odds : [];
      for (const o of oddsList) {
        if (!isObj(o)) continue;
        const name = typeof o.market === "string"
          ? o.market
          : isObj(o.market)
          ? (str(pick(o.market, ["name", "id"])) ?? "")
          : "";
        if (!name) continue;
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
    }
  }
  return [...seen.entries()]
    .map(([market, count]) => ({ market, count, read_as: classifyMarket(market) ?? "ignored" }))
    .sort((a, b) => b.count - a.count);
}

// ---------- collective_odds/index.ts ----------
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
