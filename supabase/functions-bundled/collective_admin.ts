// collective_admin - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_admin
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
  home_win_prob: number | null; received_at: string; is_late: boolean;
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

// ---------- collective_admin/index.ts ----------
// Model Collective admin API: the founder console's backend. Every route
// requires a signed-in account on the admin.user_ids config list. Minting
// an invite returns the raw link exactly once.







const NO_STORE = { "cache-control": "no-store" };
const SOURCE_KINDS = ["excel", "github", "online", "other"];

async function cfgInt(key: string, fallback: number): Promise<number> {
  const v = await rpc<unknown>("get_config", { p_key: key });
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Start of "today" on the Collective's home clock (America/Chicago). Two-pass
// offset lookup so the answer is exact even on DST transition days: first get
// CT midnight using the current offset, then re-derive the offset as of that
// midnight and recompute.
function ctDayStartIso(): string {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const offAt = (d: Date) => {
      const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" })
        .formatToParts(d).find((x) => x.type === "timeZoneName")?.value ?? "GMT-06:00";
      const o = name.replace("GMT", "");
      return /^[+-]\d{2}:\d{2}$/.test(o) ? o : "-06:00";
    };
    let guess = new Date(`${ymd}T00:00:00${offAt(new Date())}`);
    guess = new Date(`${ymd}T00:00:00${offAt(guess)}`);
    if (Number.isNaN(guess.getTime())) throw new Error("bad date");
    return guess.toISOString();
  } catch {
    return new Date(Date.now() - 24 * 3600e3).toISOString();
  }
}

function inviteMessage(url: string, name: string): string {
  return `You're invited to the Model Collective.

Open this link to set up your profile and model (it takes about a minute):
${url}

You sign in with your email (no password), confirm your name and your model, and say where the model lives (spreadsheet, GitHub, or hosted). After that your dashboard handles everything: post a slate by uploading your spreadsheet, and the Collective grades your record independently.

The link is personal to you${name ? `, ${name}` : ""}, works once, and expires in 30 days.`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_admin");

  try {
    const admin = await requireAdmin(req);
    if (admin instanceof Response) return admin;

    // One action mints the whole onboarding package: token, URL, prefill
    // (name, model, source), founding status, expiry. Provisioning of the
    // account, profile, model, key, prompt, and embed happens automatically
    // when the creator completes onboarding through the link.
    if (path === "/v1/admin/invites" && req.method === "POST") {
      const body = await req.json().catch(() => null) as {
        display_name?: string; email?: string; model_name?: string;
        source_kind?: string; source_ref?: string; founding?: boolean;
        prefill?: Record<string, unknown>; max_uses?: number; note?: string;
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const name = (body.display_name ?? "").toString().trim();
      let prefill: Record<string, unknown>;
      if (name) {
        if (name.length < 2 || name.length > 60) {
          return err("invalid_payload", "Name must be 2 to 60 characters.", 422);
        }
        const email = (body.email ?? "").toString().trim().slice(0, 120);
        if (email && !/.+@.+\..+/.test(email)) {
          return err("invalid_payload", `"${email}" does not look like an email address.`, 422);
        }
        prefill = {
          display_name: name,
          model_name: (body.model_name ?? "").toString().trim().slice(0, 60) || null,
          email: email || null,
          source_kind: SOURCE_KINDS.includes(body.source_kind ?? "") ? body.source_kind : null,
          source_ref: (body.source_ref ?? "").toString().trim().slice(0, 300) || null,
        };
      } else if (body.prefill && typeof body.prefill === "object") {
        // older client shape, still honored
        prefill = body.prefill;
      } else {
        return err("invalid_payload", "A name is required to mint an invite.", 422);
      }
      const t = await newInviteToken();
      const out = await rpc<{ ok: boolean; code?: string; message?: string; expires_at?: string; invite_id?: string }>(
        "mint_invite", {
          p_admin: admin.id,
          p_prefill: prefill,
          p_founding: body.founding === true,
          p_share_bps: null,
          p_max_uses: typeof body.max_uses === "number" ? body.max_uses : 1,
          p_note: (body.note ?? prefill.email ?? "").toString().slice(0, 300),
          p_token_hash: t.hash,
          p_token_prefix: t.prefix,
        });
      if (!out.ok) return err(out.code ?? "server_error", out.message ?? "Mint failed.", out.code === "forbidden" ? 403 : 500);
      const url = `${BASE_URL}/join/${t.raw}`;
      return json({
        invite_id: out.invite_id ?? null,
        invite_url: url,
        token: t.raw, expires_at: out.expires_at, shown_once: true,
        invite: {
          display_name: (prefill.display_name as string) ?? null,
          model_name: (prefill.model_name as string) ?? null,
          email: (prefill.email as string) ?? null,
          source_kind: (prefill.source_kind as string) ?? null,
          founding: body.founding === true,
        },
        message: inviteMessage(url, (prefill.display_name as string) ?? ""),
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/invites" && req.method === "GET") {
      interface Row {
        id: string; token_prefix: string; note: string | null; founding_member: boolean;
        max_uses: number; use_count: number; expires_at: string; created_at: string;
        revoked_at: string | null; prefill: Record<string, unknown> | null;
      }
      const rows = await viewGet<Row>("invite_tokens",
        "select=id,token_prefix,note,founding_member,max_uses,use_count,expires_at,created_at,revoked_at,prefill&order=created_at.desc&limit=200");
      const now = new Date().toISOString();
      return json({
        rows: rows.map((r) => {
          const p = r.prefill ?? {};
          return {
            id: r.id,
            display_name: (p.display_name as string) ?? null,
            model_name: (p.model_name as string) ?? null,
            email: (p.email as string) ?? null,
            source_kind: (p.source_kind as string) ?? null,
            note: r.note, founding: r.founding_member,
            max_uses: r.max_uses, use_count: r.use_count,
            expires_at: r.expires_at, created_at: r.created_at,
            status: r.revoked_at ? "revoked"
              : r.use_count >= r.max_uses ? "redeemed"
              : (r.expires_at < now ? "expired" : "sent"),
          };
        }),
      }, 200, NO_STORE);
    }

    const rm = path.match(/^\/v1\/admin\/invites\/([0-9a-f-]{36})\/revoke$/);
    if (rm && req.method === "POST") {
      const out = await rpc<{ ok: boolean; code?: string; message?: string; already_revoked?: boolean }>(
        "revoke_invite", { p_admin: admin.id, p_invite_id: rm[1] });
      if (!out.ok) {
        return err(out.code ?? "server_error", out.message ?? "Revoke failed.",
          out.code === "forbidden" ? 403 : out.code === "not_found" ? 404 : 500);
      }
      return json({ ok: true, already_revoked: out.already_revoked === true }, 200, NO_STORE);
    }

    // The command center numbers: who is in, who is onboarding, what happened
    // today, and where the money stands. Everything computed from real rows
    // and the configured economics, nothing hard-coded.
    if (path === "/v1/admin/overview" && req.method === "GET") {
      const since = ctDayStartIso();
      interface CreatorRow { id: string; founding_member: boolean; status: string }
      interface InviteRow { use_count: number; max_uses: number; expires_at: string; revoked_at: string | null }
      interface SubRow { model_id: string }
      const [creators, invites, subsToday, models, subscribers, quarantine, monthly, reserveBps, platformBps, poolBps, fCount, billing] =
        await Promise.all([
          viewGet<CreatorRow>("creators", "select=id,founding_member,status"),
          viewGet<InviteRow>("invite_tokens", "select=use_count,max_uses,expires_at,revoked_at"),
          viewGet<SubRow>("submissions",
            `select=model_id&data_origin=eq.live&received_at=gte.${encodeURIComponent(since)}`),
          viewGet<{ id: string }>("models", "select=id&is_listed=is.true"),
          viewCount("subscribers", "status=in.(active,past_due)"),
          viewCount("quarantine_queue", "", "projection_id"),
          cfgInt("pricing.monthly_cents", 2499),
          cfgInt("econ.reserve_bps", 1000),
          cfgInt("econ.platform_bps", 3000),
          cfgInt("econ.founder_pool_bps", 6000),
          cfgInt("econ.founder_count", 6),
          rpc<unknown>("get_config", { p_key: "billing.enabled" }),
        ]);
      const nowIso = new Date().toISOString();
      const active = creators.filter((c) => c.status === "active");
      const submittedModels = new Set(subsToday.map((s) => s.model_id));
      const mrr = subscribers * monthly;
      const pool = Math.floor((mrr * poolBps) / 10000);
      return json({
        collective: {
          founding_members: active.filter((c) => c.founding_member).length,
          creators: active.length,
          subscribers,
          mrr_cents: mrr,
          billing_live: billing === true,
        },
        onboarding: {
          invites_pending: invites.filter((i) =>
            !i.revoked_at && i.use_count < i.max_uses && i.expires_at >= nowIso).length,
          invites_redeemed: invites.filter((i) => i.use_count >= i.max_uses).length,
        },
        today: {
          models_submitted: submittedModels.size,
          models_missing: models.filter((mo) => !submittedModels.has(mo.id)).length,
          quarantined_rows: quarantine,
        },
        economics: {
          price_cents: monthly,
          reserve_bps: reserveBps, platform_bps: platformBps,
          founder_pool_bps: poolBps, founder_count: Math.max(fCount, 1),
          reserve_cents: Math.floor((mrr * reserveBps) / 10000),
          platform_cents: Math.floor((mrr * platformBps) / 10000),
          pool_cents: pool,
          per_founder_cents: Math.floor(pool / Math.max(fCount, 1)),
        },
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/members" && req.method === "GET") {
      interface WallRow {
        creator_id: string; creator_slug: string; creator_name: string; membership: string;
        founding: boolean; model_name: string; last_submission_at: string | null;
      }
      interface CreatorRow {
        id: string; slug: string; display_name: string; description: string | null;
        website_url: string | null; status: string; founding_member: boolean;
        referral_share_bps: number; billing_mode: string; created_at: string;
      }
      interface ModelRow {
        creator_id: string; slug: string; name: string; sport_code: string;
        source_kind: string | null; source_ref: string | null;
      }
      const [wall, creators, models, keys, installs] = await Promise.all([
        viewGet<WallRow>("model_wall", "select=creator_id,creator_slug,creator_name,membership,founding,model_name,last_submission_at"),
        viewGet<CreatorRow>("creators",
          "select=id,slug,display_name,description,website_url,status,founding_member,referral_share_bps,billing_mode,created_at&order=created_at.asc"),
        viewGet<ModelRow>("models", "select=creator_id,slug,name,sport_code,source_kind,source_ref"),
        viewGet<{ creator_id: string; key_prefix: string; kind: string; status: string }>(
          "api_keys", "select=creator_id,key_prefix,kind,status"),
        viewGet<{ creator_id: string; origin: string }>("embed_installs", "select=creator_id,origin&status=eq.active"),
      ]);
      return json({
        rows: creators.map((c) => {
          const mine = wall.filter((w) => w.creator_id === c.id);
          const myModels = models.filter((mo) => mo.creator_id === c.id);
          return {
            creator_slug: c.slug,
            display_name: c.display_name,
            description: c.description,
            website_url: c.website_url,
            account_status: c.status,
            membership: mine[0]?.membership ?? "MEMBER",
            founding: c.founding_member,
            referral_share_bps: c.referral_share_bps,
            billing_mode: c.billing_mode,
            models: myModels.map((mo) => ({
              slug: mo.slug, name: mo.name, sport: mo.sport_code,
              source_kind: mo.source_kind, source_ref: mo.source_ref,
            })),
            key_prefixes: keys.filter((k) => k.creator_id === c.id && k.status === "active")
              .map((k) => `mck_${k.kind}_${k.key_prefix}`),
            origins: installs.filter((i) => i.creator_id === c.id).map((i) => i.origin),
            joined_at: c.created_at,
            last_submission_at: mine.map((w) => w.last_submission_at).filter(Boolean).sort().pop() ?? null,
          };
        }),
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/quarantine" && req.method === "GET") {
      const rows = await viewGet("quarantine_queue", "select=*&limit=200");
      return json({ rows }, 200, NO_STORE);
    }

    let m = path.match(/^\/v1\/admin\/quarantine\/([0-9a-f-]+)\/resolve$/);
    if (m && req.method === "POST") {
      const body = await req.json().catch(() => null) as {
        game_id?: string; alias?: { sport?: string; alias?: string; team_code?: string };
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      if (typeof body.game_id === "string" && body.game_id) {
        const out = await rpc<{ ok: boolean; code?: string; message?: string; resolved?: number }>(
          "admin_resolve_quarantine", { p_projection_id: m[1], p_game_id: body.game_id });
        if (!out.ok) return err(out.code ?? "not_found", out.message ?? "Could not resolve.", 404);
        return json({ ok: true, resolved: out.resolved ?? 1 }, 200, NO_STORE);
      }
      if (body.alias && body.alias.alias && body.alias.team_code) {
        const sport = (body.alias.sport ?? "NFL").toUpperCase();
        const code = body.alias.team_code.toUpperCase();
        // CFB team codes run longer than NFL's three letters (OHIOSTATE).
        if (!/^[A-Z0-9]{2,10}$/.test(sport) || !/^[A-Z0-9]{2,12}$/.test(code)) {
          return err("invalid_payload", "Sport and team code look wrong.", 422);
        }
        const teams = await viewGet<{ id: string }>(
          "teams", `select=id&sport_code=eq.${sport}&code=eq.${code}&limit=1`);
        if (!teams[0]) return err("not_found", "No team with that code.", 404);
        await tableWrite("team_aliases", "POST", "", {
          sport_code: sport, alias: body.alias.alias.trim(), team_id: teams[0].id,
        }).catch(() => { /* alias may already exist; the re-resolve still runs */ });
        const out = await rpc<{ ok: boolean; resolved?: number }>("admin_reresolve", { p_sport: sport });
        return json({ ok: true, resolved: out.resolved ?? 0 }, 200, NO_STORE);
      }
      return err("invalid_payload", "Pass game_id or alias.", 422);
    }

    if (path === "/v1/admin/games" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const out = await rpc<{ ok: boolean; code?: string; message?: string; upserted?: number; failed?: unknown[] }>(
        "upsert_games", { p_admin: admin.id, p_payload: body });
      if (!out.ok) return err(out.code ?? "invalid_payload", out.message ?? "Upsert failed.", out.code === "forbidden" ? 403 : 422);
      return json({ ok: true, upserted: out.upserted ?? 0, failed: out.failed ?? [] }, 200, NO_STORE);
    }

    if (path === "/v1/admin/results" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { results?: Record<string, unknown>[] } | null;
      if (!body || !Array.isArray(body.results)) return err("invalid_payload", "Pass a results array.", 422);
      let settled = 0, graded = 0;
      const failures: unknown[] = [];
      for (const r of body.results.slice(0, 100)) {
        const out = await rpc<{ ok: boolean; message?: string; graded?: number }>(
          "settle_game", { p_admin: admin.id, p_game_id: r.game_id, p_result: r });
        if (out.ok) { settled++; graded += out.graded ?? 0; }
        else failures.push({ game_id: r.game_id, message: out.message });
      }
      return json({ ok: failures.length === 0, settled, graded, failures }, 200, NO_STORE);
    }

    if (path === "/v1/admin/earnings" && req.method === "GET") {
      interface Row {
        creator_slug: string; period_month: string; earned_cents: number | null;
        clawed_cents: number | null; paid_cents: number | null;
        balance_cents: number | null; available_cents: number | null;
      }
      const [rows, subscribers, monthly, reserveBps, platformBps, poolBps, fCount, refBps, billing] =
        await Promise.all([
          viewGet<Row>("creator_earnings_monthly", "select=*&order=period_month.desc"),
          viewCount("subscribers", "status=in.(active,past_due)"),
          cfgInt("pricing.monthly_cents", 2499),
          cfgInt("econ.reserve_bps", 1000),
          cfgInt("econ.platform_bps", 3000),
          cfgInt("econ.founder_pool_bps", 6000),
          cfgInt("econ.founder_count", 6),
          cfgInt("econ.referral_bps", 0),
          rpc<unknown>("get_config", { p_key: "billing.enabled" }),
        ]);
      const mrr = subscribers * monthly;
      const pool = Math.floor((mrr * poolBps) / 10000);
      const n = Math.max(fCount, 1);
      return json({
        summary: {
          price_cents: monthly, subscribers, mrr_cents: mrr,
          reserve_bps: reserveBps, platform_bps: platformBps,
          founder_pool_bps: poolBps, founder_count: n, referral_bps: refBps,
          reserve_cents: Math.floor((mrr * reserveBps) / 10000),
          platform_cents: Math.floor((mrr * platformBps) / 10000),
          pool_cents: pool,
          per_founder_cents: Math.floor(pool / n),
          billing_live: billing === true,
        },
        rows: rows.map((r) => ({
          creator_slug: r.creator_slug, month: r.period_month?.slice(0, 7),
          earned_cents: r.earned_cents ?? 0, clawed_cents: r.clawed_cents ?? 0,
          paid_cents: r.paid_cents ?? 0, balance_cents: r.balance_cents ?? 0,
          available_cents: r.available_cents ?? 0,
        })),
      }, 200, NO_STORE);
    }

    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_admin rpc failure:", e.message, e.body);
    else console.error("collective_admin failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
