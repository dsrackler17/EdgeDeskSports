// collective_public - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_public
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

// ---------- inlined _shared/keys.ts ----------
// Shared key and token primitives. Submission keys are
// mck_live_{8 base62}{32 base62} or mck_test_{8 base62}{32 base62}.
// Invite tokens are mci_{24 base62}. Only the sha256 hex of the full raw
// string is ever stored; the prefix is stored for lookup and display.

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Unbiased base62 string via rejection sampling over crypto.getRandomValues.
// 248 is the largest multiple of 62 that fits in a byte, so bytes at or above
// it are discarded instead of skewing the distribution.
function randBase62(n: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i];
      if (b < 248) {
        out.push(BASE62[b % 62]);
      }
    }
  }
  return out.join("");
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const KEY_RE = /^mck_(live|test)_([0-9A-Za-z]{8})[0-9A-Za-z]{32}$/;

// Validates shape mck_live_<8+32 base62> or mck_test_<8+32 base62>.
// prefix is the 8 chars after mck_live_ or mck_test_.
function parseCollectiveKey(
  raw: string,
): { prefix: string; kind: "live" | "test" } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { prefix: m[2], kind: m[1] as "live" | "test" };
}

// New submission key. The raw string is shown once; hash is sha256hex of the
// FULL raw key string.
async function newApiKey(
  kind: "live" | "test",
): Promise<{ raw: string; prefix: string; hash: string }> {
  const prefix = randBase62(8);
  const secret = randBase62(32);
  const raw = `mck_${kind}_${prefix}${secret}`;
  const hash = await sha256hex(raw);
  return { raw, prefix, hash };
}

// New invite token mci_<24 base62>; prefix is the first 8 of the 24; hash is
// sha256hex of the full raw token.
async function newInviteToken(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  const body = randBase62(24);
  const raw = `mci_${body}`;
  const hash = await sha256hex(raw);
  return { raw, prefix: body.slice(0, 8), hash };
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
  // Games this model has a graded-eligible pick on, played or not. Separates
  // "has not submitted" from "submitted, waiting on kickoff"; record stays
  // null through both, so the surfaces cannot tell them apart without it.
  submitted_games: number;
  website_url: string | null; x_handle: string | null;
}

interface WallViewRow {
  creator_slug: string; creator_name: string; logo_url: string | null; monogram: string;
  founding: boolean; website_url: string | null; x_handle: string | null; membership: string;
  model_slug: string; model_name: string; sport: string;
  graded: number | null; wins: number | null; losses: number | null; pushes: number | null;
  win_pct: number | null; margin_mae: number | null; brier: number | null;
  coverage_pct: number | null; last_submission_at: string | null;
  submitted_games: number | null;
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
    submitted_games: v.submitted_games ?? 0,
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
  total_line: number | null; captured_at: string;
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

// ---------- inlined _shared/prompt_template.ts ----------
// The Universal Creator Prompt. This constant is the single source; the
// human-readable copy lives at collective/claude-prompt-template.md and must
// stay identical. It ships in the same repo and same deploy as the API, so
// an endpoint change and its prompt change land in one commit.

const PROMPT_TEMPLATE = `You are helping {{CREATOR_NAME}} connect their sports model to the Model Collective. The Collective is shared infrastructure for independent creators: they send finished projections to one endpoint, and the Collective grades them, shows them on a shared wall, and sends traffic back. You are working inside the creator's own project. Their model, code, and site belong to them and stay exactly as they are.

Follow these steps in order. Do not skip the confirmations.

1. Inspect first. Look through this project and report what you find before changing anything: what it is built with (plain HTML, React, Next.js, Vue, Node, Python, Flask, Django, Supabase, Firebase, a GitHub Action, or a script run by hand), and where it runs. Do not assume any particular framework. Everything below works for all of them.

2. Find the finished numbers. Locate where this project produces its final projections (a CSV file, a database table, a function's output, a spreadsheet export). Show {{CREATOR_NAME}} what you found and confirm it is the right place before going further.

3. Map the fields. The Collective accepts one JSON envelope per slate. Map the creator's fields to it and SHOW THE MAPPING for approval before sending anything. Required per game: game_ref (their own id for the game, any format), home_team, away_team, kickoff (ISO time). Optional, only if the model already produces them: pick_side (home or away), projected_spread (home team's number, negative means home favored), projected_total, proj_home_score, proj_away_score, home_win_probability (moneyline chance the home team wins, 0 to 1), cover_probability (chance the pick covers, 0 to 1, requires line_at_submission), line_at_submission, confidence. Do not invent numbers the model does not produce, and do not build any new modeling work. If a field means something different in their data (for example a result column that means "the pick covered"), leave it out and say so.

4. Never send proprietary logic. Only finished outputs leave this project: the numbers above, nothing else. No source code, no weights, no formulas, no intermediate data. Say this plainly to {{CREATOR_NAME}} and confirm they agree with what will be sent.

5. Add, do not rebuild. Put the submission code in one new file plus a small "Send to Model Collective" trigger that fits how this project already runs (a button, a script command, a step at the end of their pipeline). Do not restructure the project, do not touch the model logic, do not change any existing output.

6. Keep the key private. The API key below must never appear in a public page or a public repo. For a server or a script, read it from an environment variable named COLLECTIVE_KEY. For a purely static site, do not put the key in the browser: use a GitHub Action with a repository secret instead, like this:

   name: Send to Model Collective
   on: [workflow_dispatch, schedule]
   jobs:
     submit:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - run: |
             curl -s -X POST "{{API_BASE}}/collective_ingest/v1/projections" \\
               -H "x-collective-key: $COLLECTIVE_KEY" \\
               -H "content-type: application/json" \\
               --data @projections.json
           env:
             COLLECTIVE_KEY: \${{ secrets.COLLECTIVE_KEY }}

   Or a local Python script with only the standard library: read the JSON, urllib.request.urlopen a POST to the same URL with the x-collective-key header from os.environ.

7. Add the Collective tab. Put this snippet on one page or route of the creator's site, and nowhere else. It renders the whole Collective inside their site and touches nothing else on the page:

   {{EMBED_SNIPPET}}

8. Dry run first. Before anything goes live, send the mapped slate to the test endpoint and show {{CREATOR_NAME}} the exact JSON you sent and the exact response:

   POST {{API_BASE}}/collective_ingest/v1/projections/dry-run
   header x-collective-key: the key below

   The response lists every row as resolved, quarantined, late, or rejected, with reasons. Nothing is stored. Fix any rejected rows, rerun, and only then switch the URL to /v1/projections for the real submission.

9. Report back. When done, tell {{CREATOR_NAME}}: which files you added or changed, how to submit going forward and how often (before kickoff matters: only the first submission per game before kickoff counts toward their record), what to do if a submission fails (the response says exactly which row and why; quarantined rows are fine, a human resolves them), and that the key can be rotated any time at {{DASHBOARD_URL}}.

Credentials and identity for this creator:
  Creator: {{CREATOR_NAME}}
  Model: {{MODEL_NAME}} ({{SPORT}})
  API base: {{API_BASE}}
  API key (treat like a password): {{API_KEY}}
  Docs and grading rules: {{DOCS_URL}}

One honest rule to close on: the Collective grades every model the same way, against its own closing lines, on first submissions only. Backfilled history is stored and shown separately but never graded. Send the whole slate, not just the confident games, because slate coverage is published next to the record.`;

function renderPrompt(vars: Record<string, string>): string {
  let out = PROMPT_TEMPLATE;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

// ---------- collective_public/index.ts ----------
// Model Collective public read API. Free surfaces are genuinely free (they
// are the marketing surface); paid surfaces gate IN THE RESPONSE BODY, so
// no unentitled caller ever receives a pre-kickoff number (Section 5).
// Dashboard routes serve the signed-in creator only.








const FREE_CACHE = { "cache-control": "public, max-age=60" };
const NO_STORE = { "cache-control": "no-store" };

interface CreatorRow {
  id: string; user_id: string | null; slug: string; display_name: string;
  description: string | null; website_url: string | null; x_handle: string | null;
  logo_url: string | null; founding_member: boolean; billing_mode: string;
  referral_share_bps: number; pinned_model_id: string | null; created_at: string;
}

function pub(c: CreatorRow, membership: string, monogram: string, pinned: string | null) {
  return {
    slug: c.slug, display_name: c.display_name, description: c.description,
    website_url: c.website_url, x_handle: c.x_handle, logo_url: c.logo_url,
    monogram, founding: c.founding_member, membership,
    joined_at: c.created_at, pinned_model_slug: pinned,
  };
}

async function creatorPayload(slug: string) {
  const wall = await buildWall();
  const mine = wall.filter((w) => w.creator_slug === slug);
  if (mine.length === 0) return null;
  const creators = await viewGet<CreatorRow>("creators", `select=*&slug=eq.${slug}&limit=1`);
  if (creators.length === 0) return null;
  const c = creators[0];
  const backfill = await viewGet<{ model_id: string; rows: number }>(
    "model_backfill", `select=*`);
  const models = await viewGet<{ id: string; slug: string }>(
    "models", `select=id,slug&creator_id=eq.${c.id}`);
  const pinned = models.find((m) => m.id === c.pinned_model_id)?.slug ?? null;
  const anyLive = mine.some((w) => w.last_submission_at !== null);
  return {
    creator: pub(c, mine[0].membership, mine[0].monogram, pinned),
    models: mine.map((w) => {
      const modelId = models.find((m) => m.slug === w.model_slug)?.id;
      const bf = backfill.find((b) => b.model_id === modelId);
      return {
        model_slug: w.model_slug, model_name: w.model_name, sport: w.sport,
        record: w.record, coverage_pct: w.coverage_pct, last_submission_at: w.last_submission_at,
        submitted_games: w.submitted_games,
        backfill: bf ? { rows: bf.rows, note: "Backfilled history, shown separately, never ranked" } : null,
      };
    }),
    empty_state: !anyLive,
  };
}

async function requireCreator(req: Request): Promise<{ user: { id: string }; creator: CreatorRow } | Response> {
  const user = await getUser(req);
  if (!user) return err("invalid_key", "Sign in to use the dashboard.", 401);
  const rows = await viewGet<CreatorRow>("creators", `select=*&user_id=eq.${user.id}&limit=1`);
  if (rows.length === 0) return err("not_found", "This account has no creator profile.", 404);
  return { user, creator: rows[0] };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_public");

  try {
    // ------------------------------------------------------------ free
    if (req.method === "GET" && path === "/v1/meta") {
      return json(await buildMeta(), 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/wall") {
      return json({ generated_at: new Date().toISOString(), rows: await buildWall() }, 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/rules") {
      return json(RULES, 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/rankings") {
      interface RankRow {
        creator_slug: string; creator_name: string; model_slug: string; model_name: string;
        sport: string; graded: number | null; coverage_pct: number | null;
        win_pct: number | null; margin_mae: number | null; brier: number | null;
        is_ranked: boolean; unranked_reason: string | null;
        rank_win_pct: number | null; rank_margin_mae: number | null; rank_brier: number | null;
      }
      const rows = await viewGet<RankRow>("model_rankings", "select=*");
      const [minCov, minGraded] = await Promise.all([
        rpc<unknown>("get_config", { p_key: "ranking.min_coverage_pct" }),
        rpc<unknown>("get_config", { p_key: "ranking.min_graded_games" }),
      ]);
      const board = (rankKey: "rank_win_pct" | "rank_margin_mae" | "rank_brier",
        valKey: "win_pct" | "margin_mae" | "brier") =>
        rows.filter((r) => r.is_ranked && r[rankKey] !== null)
          .sort((a, b) => (a[rankKey] ?? 0) - (b[rankKey] ?? 0))
          .map((r) => ({
            rank: r[rankKey], creator_slug: r.creator_slug, creator_name: r.creator_name,
            model_slug: r.model_slug, model_name: r.model_name, sport: r.sport,
            value: r[valKey], graded: r.graded, coverage_pct: r.coverage_pct,
          }));
      return json({
        rules_version: RULES.version,
        thresholds: { min_coverage_pct: Number(minCov ?? 60), min_graded_games: Number(minGraded ?? 20) },
        boards: {
          win_pct: board("rank_win_pct", "win_pct"),
          margin_mae: board("rank_margin_mae", "margin_mae"),
          brier: board("rank_brier", "brier"),
        },
        unranked: rows.filter((r) => !r.is_ranked).map((r) => ({
          creator_slug: r.creator_slug, model_slug: r.model_slug,
          model_name: r.model_name, reason: r.unranked_reason,
        })),
      }, 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/activity") {
      interface ActRow {
        at: string; creator_slug: string; creator_name: string; model_name: string;
        sport: string; n_rows: number; n_first: number; week: number | null;
      }
      const rows = await viewGet<ActRow>("activity_feed", "select=*&limit=40");
      return json({
        rows: rows.map((r) => ({
          at: r.at, creator_slug: r.creator_slug, creator_name: r.creator_name,
          model_name: r.model_name, sport: r.sport, kind: "submission",
          n_rows: r.n_rows, n_first: r.n_first, week: r.week,
        })),
      }, 200, FREE_CACHE);
    }

    // Who am I: the one route the site uses to decide which dashboard to
    // render. Role resolution happens here, server side, from the actual
    // rows: a creators row makes a creator, an active subscribers row makes
    // a subscriber, anyone else signed in is a member. The client only uses
    // this for layout; every paid number stays gated in its own response.
    if (req.method === "GET" && path === "/v1/me") {
      const user = await getUser(req);
      if (!user) return json({ signed_in: false, role: "guest" }, 200, NO_STORE);
      interface SubscriberRow { status: string; plan: string; current_period_end: string | null; started_at: string }
      const [creators, subs, adminCfg] = await Promise.all([
        viewGet<CreatorRow>("creators", `select=*&user_id=eq.${user.id}&limit=1`),
        viewGet<SubscriberRow>("subscribers",
          `select=status,plan,current_period_end,started_at&user_id=eq.${user.id}&limit=1`),
        rpc<unknown>("get_config", { p_key: "admin.user_ids" }),
      ]);
      const admin = Array.isArray(adminCfg) && adminCfg.includes(user.id);
      const entitled = await isEntitled(user.id);
      const c = creators[0] ?? null;
      let creator = null;
      if (c) {
        const wall = await buildWall();
        const mine = wall.filter((w) => w.creator_slug === c.slug);
        creator = {
          slug: c.slug, display_name: c.display_name, founding: c.founding_member,
          membership: mine[0]?.membership ?? "MEMBER", monogram: mine[0]?.monogram ?? "",
          logo_url: c.logo_url,
          models: mine.map((w) => ({ model_slug: w.model_slug, model_name: w.model_name, sport: w.sport })),
        };
      }
      const sub = subs[0] ?? null;
      const role = c
        ? "creator"
        : (sub && ["active", "past_due"].includes(sub.status) ? "subscriber" : "member");
      return json({
        signed_in: true, email: user.email, role, admin, entitled,
        founding: c?.founding_member ?? false,
        creator,
        subscription: sub
          ? { status: sub.status, plan: sub.plan, current_period_end: sub.current_period_end, started_at: sub.started_at }
          : null,
      }, 200, NO_STORE);
    }

    let m = path.match(/^\/v1\/creators\/([a-z0-9-]+)$/);
    if (req.method === "GET" && m) {
      const payload = await creatorPayload(m[1]);
      if (!payload) return err("not_found", "No creator at this address.", 404);
      return json(payload, 200, FREE_CACHE);
    }

    m = path.match(/^\/v1\/models\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (req.method === "GET" && m) {
      const payload = await creatorPayload(m[1]);
      const model = payload?.models.find((x) => x.model_slug === m![2]);
      if (!payload || !model) return err("not_found", "No such model.", 404);
      const models = await viewGet<{ id: string; description: string | null }>(
        "models", `select=id,description,slug,creators!inner(slug)&slug=eq.${m[2]}&creators.slug=eq.${m[1]}&limit=1`);
      const modelId = models[0]?.id;
      interface CovRow { season: number; week: number; games_available: number; games_submitted: number }
      interface LogRow {
        game_id: string; label: string; kickoff_at: string; week: number | null;
        pick_side: string | null; closing_spread: number | null; final: string | null;
        pick_result: string | null; margin_error: number | null; brier: number | null; movement_n: number;
      }
      const [coverage, log] = await Promise.all([
        modelId
          ? viewGet<CovRow>("model_coverage", `select=season,week,games_available,games_submitted&model_id=eq.${modelId}&order=season.desc,week.asc`)
          : Promise.resolve([] as CovRow[]),
        modelId
          ? viewGet<LogRow>("model_game_log", `select=*&model_id=eq.${modelId}&order=graded_at.desc&limit=25`)
          : Promise.resolve([] as LogRow[]),
      ]);
      return json({
        creator: {
          slug: payload.creator.slug, display_name: payload.creator.display_name,
          founding: payload.creator.founding,
        },
        model: { model_slug: model.model_slug, model_name: model.model_name, sport: model.sport,
          description: models[0]?.description ?? null },
        record: model.record,
        coverage,
        coverage_pct: model.coverage_pct,
        recent_graded: log.map((g) => ({
          game_id: g.game_id, label: g.label, kickoff_at: g.kickoff_at, week: g.week,
          pick_side: g.pick_side, closing_spread: g.closing_spread, final: g.final,
          pick_result: g.pick_result, margin_error: g.margin_error, brier: g.brier,
          movement_n: g.movement_n,
        })),
      }, 200, FREE_CACHE);
    }

    // ------------------------------------------- free list, paid numbers
    if (req.method === "GET" && path === "/v1/games") {
      const u = new URL(req.url);
      const meta = await buildMeta();
      const rawSport = u.searchParams.get("sport") ?? "";
      const sport = /^[A-Z0-9]{2,10}$/.test(rawSport) ? rawSport : (meta.sports[0]?.code ?? "NFL");
      const season = Number(u.searchParams.get("season") ?? meta.sports.find((s) => s.code === sport)?.season);
      if (!Number.isFinite(season)) return err("invalid_payload", "season must be a number", 422);
      const rawWeek = u.searchParams.get("week");
      let week: number | null = null;
      if (rawWeek !== null) {
        week = Number(rawWeek);
        if (!Number.isInteger(week)) return err("invalid_payload", "week must be an integer", 422);
      } else {
        // No week asked for: default to the current slate, not the season.
        week = await currentWeek(sport, season);
      }
      const user = await getUser(req);
      const entitled = await isEntitled(user?.id ?? null);
      const payload = await buildGames(sport, season, week, entitled);
      return json(payload, 200, entitled ? NO_STORE : FREE_CACHE);
    }

    if (req.method === "GET" && path === "/v1/consensus") {
      const u = new URL(req.url);
      const meta = await buildMeta();
      const rawSport = u.searchParams.get("sport") ?? "";
      const sport = /^[A-Z0-9]{2,10}$/.test(rawSport) ? rawSport : (meta.sports[0]?.code ?? "NFL");
      const season = Number(u.searchParams.get("season") ?? meta.sports.find((s) => s.code === sport)?.season);
      if (!Number.isFinite(season)) return err("invalid_payload", "season must be a number", 422);
      const rawWeek = u.searchParams.get("week");
      let week: number | null = null;
      if (rawWeek !== null) {
        week = Number(rawWeek);
        if (!Number.isInteger(week)) return err("invalid_payload", "week must be an integer", 422);
      } else {
        week = await currentWeek(sport, season);
      }
      const user = await getUser(req);
      const entitled = await isEntitled(user?.id ?? null);
      const board = await buildGames(sport, season, week, entitled);
      type BoardGame = {
        game_id: string; label: string; kickoff_at: string; status: string;
        consensus: Record<string, unknown> | null;
      };
      const rows = (board.games as BoardGame[])
        .filter((g) => g.consensus !== null)
        .map((g) => {
          const c = g.consensus as Record<string, unknown>;
          if (c.locked) {
            return { game_id: g.game_id, label: g.label, kickoff_at: g.kickoff_at, status: g.status, n: c.n ?? null };
          }
          return { game_id: g.game_id, label: g.label, kickoff_at: g.kickoff_at, status: g.status, ...c };
        });
      if (entitled) return json({ entitled: true, rows }, 200, NO_STORE);
      return json({
        entitled: false,
        reason: (await buildMeta()).billing_live ? "subscription_required" : "billing_not_live",
        rows,
      }, 200, FREE_CACHE);
    }

    // ------------------------------------------------------- dashboard
    if (path === "/v1/dashboard" && req.method === "GET") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const { creator } = ctx;
      const wall = await buildWall();
      const mine = wall.filter((w) => w.creator_slug === creator.slug);
      interface KeyRow { key_prefix: string; kind: string; status: string; created_at: string; last_used_at: string | null }
      interface OriginRow { id: string; origin: string; status: string }
      interface EarnRow {
        period_month: string; earned_cents: number | null; balance_cents: number | null; available_cents: number | null;
      }
      const [keys, origins, earnings, referredTotal, referredActive] = await Promise.all([
        viewGet<KeyRow>("api_keys", `select=key_prefix,kind,status,created_at,last_used_at&creator_id=eq.${creator.id}&order=created_at.desc`),
        viewGet<OriginRow>("embed_installs", `select=id,origin,status&creator_id=eq.${creator.id}&order=created_at.asc`),
        viewGet<EarnRow>("creator_earnings_monthly", `select=period_month,earned_cents,balance_cents,available_cents&creator_id=eq.${creator.id}&order=period_month.desc`),
        (await viewGet<{ id: string }>("attributions", `select=id&creator_id=eq.${creator.id}`)).length,
        (await viewGet<{ id: string }>("subscribers", `select=id,attributions!inner(creator_id)&attributions.creator_id=eq.${creator.id}&status=in.(active,past_due)`)).length,
      ]);
      const thisMonth = new Date().toISOString().slice(0, 7);
      const meta = await buildMeta();
      const [poolBps, fCount, refBps] = await Promise.all([
        rpc<unknown>("get_config", { p_key: "econ.founder_pool_bps" }),
        rpc<unknown>("get_config", { p_key: "econ.founder_count" }),
        rpc<unknown>("get_config", { p_key: "econ.referral_bps" }),
      ]);
      const balance = earnings.reduce((s, e) => s + (e.balance_cents ?? 0), 0);
      const available = earnings.reduce((s, e) => s + (e.available_cents ?? 0), 0);
      const models = await viewGet<{ id: string; slug: string; name: string; sport_code: string }>(
        "models", `select=id,slug,name,sport_code&creator_id=eq.${creator.id}`);
      const pinned = models.find((x) => x.id === creator.pinned_model_id)?.slug ?? null;
      return json({
        creator: {
          ...pub(creator, mine[0]?.membership ?? "MEMBER", mine[0]?.monogram ?? "", pinned),
          billing_mode: creator.billing_mode, referral_share_bps: creator.referral_share_bps,
        },
        models: models.map((x) => ({ model_slug: x.slug, model_name: x.name, sport: x.sport_code })),
        keys: keys.map((k) => ({
          prefix: `mck_${k.kind}_${k.key_prefix}`, status: k.status,
          created_at: k.created_at, last_used_at: k.last_used_at,
        })),
        origins,
        earnings: {
          this_month_cents: earnings.find((e) => e.period_month?.startsWith(thisMonth))?.earned_cents ?? 0,
          balance_cents: balance, available_cents: available,
          referred_active: referredActive, referred_total: referredTotal,
          note: meta.billing_live
            ? null
            : "Billing is not live yet. Attribution is being recorded now and pays out when billing turns on.",
        },
        embed_snippet: `<script src="${BASE_URL}/collective/embed.js" data-collective-host="${creator.slug}" async></script>`,
        prompt_available: true,
        economics: {
          founding: creator.founding_member,
          founder_pool_bps: Number(poolBps ?? 6000),
          founder_count: Math.max(Number(fCount ?? 6), 1),
          referral_bps: Number(refBps ?? 0),
        },
      }, 200, NO_STORE);
    }

    if (path === "/v1/dashboard/profile" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const patch: Record<string, unknown> = {};
      // Creators edit identity fields only; records, rates, and flags are
      // never editable from here. Values must be strings; URLs must parse
      // as http(s) so a profile can never publish a javascript: link.
      for (const k of ["display_name", "description", "website_url", "x_handle", "logo_url"]) {
        if (!(k in body)) continue;
        const v = body[k];
        if (v !== null && typeof v !== "string") {
          return err("invalid_payload", `${k} must be a string.`, 422);
        }
        patch[k] = v === "" ? null : v;
      }
      for (const k of ["website_url", "logo_url"]) {
        const v = patch[k];
        if (typeof v !== "string") continue;
        try {
          const uu = new URL(v.startsWith("http") ? v : `https://${v}`);
          if (uu.protocol !== "https:" && uu.protocol !== "http:") throw new Error("scheme");
          patch[k] = uu.toString();
        } catch {
          return err("invalid_payload", `${k} is not a usable URL.`, 422);
        }
      }
      if (typeof patch.x_handle === "string") patch.x_handle = patch.x_handle.replace(/^@/, "");
      if (typeof body.pinned_model_slug === "string" && /^[a-z0-9-]{1,40}$/.test(body.pinned_model_slug)) {
        const mrows = await viewGet<{ id: string }>(
          "models", `select=id&creator_id=eq.${ctx.creator.id}&slug=eq.${body.pinned_model_slug}&limit=1`);
        if (mrows[0]) patch.pinned_model_id = mrows[0].id;
      }
      if (typeof patch.display_name === "string" &&
        ((patch.display_name as string).length < 2 || (patch.display_name as string).length > 60)) {
        return err("invalid_payload", "Display name must be 2 to 60 characters.", 422);
      }
      const updated = await tableWrite("creators", "PATCH", `id=eq.${ctx.creator.id}`, patch) as CreatorRow[];
      const c = updated[0];
      return json({ ok: true, creator: pub(c, "", "", null) }, 200, NO_STORE);
    }

    // Browser slate submission: the signed-in creator posts an envelope from
    // the dashboard (CSV or Excel upload, or manual entry) without ever
    // handling their API key. Same validation pipeline as the key path: the
    // envelope goes verbatim into the ingest RPC under the creator's own
    // active key identity, so rate limits and attribution behave identically.
    if (path === "/v1/dashboard/submit" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return err("invalid_payload", "Body must be a JSON envelope.", 422);
      }
      const rows = body.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return err("invalid_payload", "Envelope must include a non-empty rows array.", 422);
      }
      if (rows.length > 500) {
        return err("invalid_payload", `${rows.length} rows exceeds the 500 row maximum.`, 422);
      }
      interface ModelRow { id: string; slug: string; name: string; sport_code: string }
      const models = await viewGet<ModelRow>(
        "models", `select=id,slug,name,sport_code&creator_id=eq.${ctx.creator.id}`);
      if (models.length === 0) return err("not_found", "This account has no model yet.", 404);
      let model = models[0];
      if (typeof body.model === "string" && body.model) {
        const found = models.find((x) => x.slug === body.model);
        if (!found) return err("invalid_payload", `No model named "${body.model}" on this account.`, 422);
        model = found;
      } else if (models.length > 1) {
        return err("invalid_payload", "This account has several models; set \"model\" to one of: " +
          models.map((x) => x.slug).join(", "), 422);
      }
      const keys = await viewGet<{ id: string }>(
        "api_keys", `select=id&creator_id=eq.${ctx.creator.id}&status=eq.active&order=created_at.desc&limit=1`);
      if (!keys[0]) return err("conflict", "No active API key on this account. Rotate a key from the dashboard first.", 409);
      const allowed = await rpc<boolean>("rate_check", { p_key_id: keys[0].id, p_endpoint: "/v1/dashboard/submit" });
      if (allowed === false) return err("rate_limited", "Hourly submission limit reached. Try again later.", 429);
      const pKey = {
        key_id: keys[0].id, kind: "live",
        creator_id: ctx.creator.id, creator_slug: ctx.creator.slug, creator_name: ctx.creator.display_name,
        model_id: model.id, model_slug: model.slug, model_name: model.name, sport: model.sport_code,
      };
      const envelope = { ...body, model: model.slug, sport: model.sport_code };
      delete (envelope as Record<string, unknown>).dry_run;
      const dry = body.dry_run === true;
      const result = await rpc<Record<string, unknown> | null>("ingest_submission", {
        p_key: pKey, p_envelope: envelope, p_dry: dry,
      });
      if (!result || result.ok === false) {
        const code = typeof result?.code === "string" ? result.code : "server_error";
        if (code === "server_error") {
          console.error("collective_public dashboard submit failed:", result);
          return err("server_error", "Something went wrong on our side.", 500);
        }
        return err(code, String(result?.message ?? "The submission was rejected."), 422);
      }
      const out = { ...result } as Record<string, unknown>;
      delete out.ok;
      if (dry) { out.dry_run = true; out.submission_id = null; }
      return json(out, 200, NO_STORE);
    }

    // The submission center: every slate this creator has ever posted, newest
    // first, with the stored per-slate counts. Answers "did my model actually
    // submit?" without the creator hunting through the public surfaces.
    if (path === "/v1/dashboard/submissions" && req.method === "GET") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      interface SubListRow {
        id: string; received_at: string; data_origin: string;
        n_rows: number; n_resolved: number; n_quarantined: number; n_late: number;
        models: { slug: string; name: string; sport_code: string };
      }
      const rows = await viewGet<SubListRow>("submissions",
        `select=id,received_at,data_origin,n_rows,n_resolved,n_quarantined,n_late,` +
        `models!inner(slug,name,sport_code,creator_id)` +
        `&models.creator_id=eq.${ctx.creator.id}&order=received_at.desc&limit=40`);
      return json({
        rows: rows.map((s) => ({
          id: s.id, received_at: s.received_at, data_origin: s.data_origin,
          model_slug: s.models.slug, model_name: s.models.name, sport: s.models.sport_code,
          rows: s.n_rows, resolved: s.n_resolved, quarantined: s.n_quarantined, late: s.n_late,
        })),
      }, 200, NO_STORE);
    }

    // The Universal Prompt, on demand from the dashboard. The stored key is
    // hashed and can never be echoed back, so the prompt carries a marked
    // placeholder the creator swaps for their real key.
    if (path === "/v1/dashboard/prompt" && req.method === "GET") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const models = await viewGet<{ slug: string; name: string; sport_code: string }>(
        "models", `select=slug,name,sport_code&creator_id=eq.${ctx.creator.id}&limit=1`);
      if (!models[0]) return err("not_found", "This account has no model yet.", 404);
      const prompt = renderPrompt({
        CREATOR_NAME: ctx.creator.display_name,
        MODEL_NAME: models[0].name,
        SPORT: models[0].sport_code,
        API_BASE: `${SB_URL}/functions/v1`,
        API_KEY: "YOUR_API_KEY (paste your mck_live_ key here; rotate one from the dashboard if you no longer have it)",
        EMBED_SNIPPET: `<script src="${BASE_URL}/collective/embed.js" data-collective-host="${ctx.creator.slug}" async></script>`,
        DASHBOARD_URL: `${BASE_URL}/collective/#dashboard`,
        DOCS_URL: `${BASE_URL}/collective/#rules`,
      });
      return json({ prompt }, 200, NO_STORE);
    }

    if (path === "/v1/dashboard/keys/rotate" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const fresh = await newApiKey("live");
      const out = await rpc<{ ok: boolean }>("rotate_key", {
        p_creator_id: ctx.creator.id, p_new_prefix: fresh.prefix, p_new_hash: fresh.hash, p_kind: "live",
      });
      if (!out?.ok) return err("server_error", "Rotation failed.", 500);
      return json({ key: fresh.raw, prefix: `mck_live_${fresh.prefix}`, shown_once: true }, 200, NO_STORE);
    }

    if (path === "/v1/dashboard/origins" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const body = await req.json().catch(() => null) as { add?: string; remove?: string } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      if (typeof body.add === "string") {
        let origin: string;
        try {
          const u = new URL(body.add);
          if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("https required");
          origin = `${u.protocol}//${u.host}`;
        } catch {
          return err("invalid_payload", "Origins must be full https:// URLs.", 422);
        }
        await tableWrite("embed_installs", "POST", "", { creator_id: ctx.creator.id, origin })
          .catch(() => { /* already listed: adding again is a no-op */ });
      } else if (typeof body.remove === "string" && /^[0-9a-f-]{36}$/.test(body.remove)) {
        await tableWrite("embed_installs", "DELETE", `id=eq.${body.remove}&creator_id=eq.${ctx.creator.id}`);
      } else {
        return err("invalid_payload", "Pass add or remove.", 422);
      }
      const origins = await viewGet("embed_installs",
        `select=id,origin,status&creator_id=eq.${ctx.creator.id}&order=created_at.asc`);
      return json({ ok: true, origins }, 200, NO_STORE);
    }

    if (["/v1/dashboard/profile", "/v1/dashboard/keys/rotate", "/v1/dashboard/origins", "/v1/dashboard/submit"].includes(path) ||
      ["/v1/meta", "/v1/wall", "/v1/rules", "/v1/rankings", "/v1/activity", "/v1/games", "/v1/consensus",
        "/v1/dashboard", "/v1/dashboard/submissions", "/v1/dashboard/prompt", "/v1/me"].includes(path)) {
      return err("method_not_allowed", "Wrong method for this route.", 405);
    }
    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_public rpc failure:", e.message, e.body);
    else console.error("collective_public failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
