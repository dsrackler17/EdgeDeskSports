// collective_ingest - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Paste this whole file as index.ts for a function named exactly: collective_ingest
// IMPORTANT: turn OFF "Enforce JWT verification" for this function.
//
// THE LOCK RULE. Every game locks 30 minutes before kickoff. Each model's
// latest live submission received before the lock is the one that counts;
// earlier ones are stored as movement; a receipt at or after the lock is
// stored late and excluded. The rule itself lives in the database
// (supabase/lock_rule.sql); this bundle only states it.

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

// ---------- inlined _shared/env.ts ----------
// Shared environment access for Collective edge functions.
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY are injected
// by the Supabase runtime. COLLECTIVE_BASE_URL is an optional secret that
// points at the public site root and defaults to production.

const SB_URL: string = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY: string = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY: string = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const BASE_URL: string = Deno.env.get("COLLECTIVE_BASE_URL") ?? "https://edgedesksports.com";

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

// Length-independent, value-independent comparison for secret digests. Both
// inputs here are fixed-length lowercase hex, but comparing with === would
// still leak position of the first differing byte through timing; this does
// not, and costs nothing at 64 characters.
function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  version: 2,
  rules: [
    "Pick result: decided by the final score. The actual margin is measured against the Collective's own captured closing spread (home convention) on the pick side; the captured close is the yardstick so every model faces the same number, never the line a creator reports. Push on the exact number, excluded from win percentage. Never graded against a creator-supplied result column.",
    "Margin error: absolute difference between projected home margin and actual home margin. Projected home margin comes from projected scores when given, otherwise from the projected spread.",
    "Brier: squared error on the moneyline home win probability. 0.25 is a coin flip. Lower is better.",
    "The lock: every game locks 30 minutes before kickoff. Each model is graded on its latest live submission received before the lock, timestamped on server receipt; earlier submissions are stored and shown as movement, never regraded. Receipts at or after the lock are stored, marked late, and excluded. Backfill and test data are stored, shown separately, and excluded from records, rankings, and consensus.",
    "Rankings: a model must cover at least 60 percent of the season slate to date and have at least 20 graded games. Win percentage, margin error, and Brier are ranked separately and never blended.",
  ],
};

// ---------- collective_ingest/index.ts ----------
// Model Collective — creator submission API.
//
// The endpoint a creator's own project posts finished projections to,
// authenticated with their mck_live_ / mck_test_ key. It is deliberately the
// same pipeline as the dashboard's browser upload: both resolve to a key
// identity and hand the envelope verbatim to the ingest_submission RPC, so a
// slate posted by a script and a slate posted by a human are validated,
// rate limited, timestamped and graded identically.
//
//   POST /v1/projections           store the slate. Under the lock rule this
//                                  REPLACES the model's number on every game
//                                  that has not locked yet; nothing needs to
//                                  be removed first.
//   POST /v1/projections/dry-run   validate it, store nothing
//   POST /v1/projections/retract   remove YOUR OWN pre-kickoff rows (kept for
//                                  surgical use; a re-post replaces rows on
//                                  its own now, see the route)
//   GET  /v1/me                    confirm a key works, and what it is for
//   GET  /v1/market                the Collective's own current market for a model's sport
//   GET  /v1/health                liveness, no auth
//
// DEPLOYMENT: turn OFF "Enforce JWT verification" for this function. Creators
// authenticate with x-collective-key, not a Supabase session, so the gateway
// must let the request through to be authenticated here.
//
// The key is never stored or logged in the clear. Only the sha256 of the full
// raw key is compared, against the hash already on the api_keys row.
//
// ---------------------------------------------------------------------------
// WHY THE SUBMIT PATH REPORTS ITS FAILURES
//
// A live post returned 500 with an empty `details` while the identical body
// dry-ran clean. Between the two routes this function diverges in exactly two
// places, and BOTH used to produce a byte-identical response:
//
//   1. rate_check is called with p_endpoint: path — "/v1/projections" on the
//      live route, "/v1/projections/dry-run" on the dry one. On the submit
//      path that call was UNGUARDED, so a throw skipped straight to the outer
//      catch and ingest_submission never ran at all.
//   2. ingest_submission is called with p_dry:false, so it performs the writes
//      the dry run only simulates. A constraint failure there raises RpcError
//      into the same outer catch.
//
// The retract route below already learned lesson 1 the hard way — its comment
// says an endpoint string this RPC does not recognise "is exactly the kind of
// thing that turns into an opaque 500" — and guards its own call. The submit
// path did not. It does now.
//
// And the outer catch logged RpcError.body (Postgres's own diagnostic: the
// table, the column, the constraint that refused the write) and then returned
// nothing at all. The answer to "why did my slate 500" existed, in this
// function's console, and the caller had no way to reach it or even to say
// which request was theirs. The retract route hands the database's words back
// to the caller; the submit path is no longer the odd one out.
// ---------------------------------------------------------------------------

const NO_STORE = { "cache-control": "no-store" };

/** Rows in one envelope. Matches the dashboard upload path so a creator
 *  cannot get a different answer depending on which door they used. */
const MAX_ROWS = 500;
/** Bytes. A slate of 500 rows is far under this; anything larger is a
 *  mistake or an attack, and is refused before it is parsed. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface CreatorRow {
  id: string;
  slug: string;
  display_name: string;
  status: string;
}
interface ModelRow {
  id: string;
  slug: string;
  name: string;
  sport_code: string;
}
interface KeyIdentity {
  key_id: string;
  kind: "live" | "test";
  creator: CreatorRow;
  models: ModelRow[];
}

/** The database's own words for a failure, bounded, for the `details` field
 *  the contract already reserves for exactly this ("always present, null when
 *  there is nothing row-level to report"). The caller here is authenticated
 *  with their own key and the rows are their own — the same audience, and the
 *  same disclosure, the retract route below has always had. */
function dbDetail(e: unknown, trace: string, stage: string): Record<string, unknown> {
  if (e instanceof RpcError) {
    return { trace, stage, db_status: e.status, db_error: e.body.slice(0, 600) };
  }
  return { trace, stage, message: String((e as Error)?.message ?? e).slice(0, 300) };
}

/**
 * The hash column on api_keys, resolved from the row rather than assumed.
 *
 * rotate_key takes p_new_hash, so a hash column exists; its exact name is not
 * something to guess at, because guessing wrong means either a crash or —
 * far worse — a comparison against undefined that could be made to pass.
 * The candidates below are tried in order and anything else is a hard error.
 */
const HASH_FIELDS = ["key_hash", "hash", "secret_hash", "token_hash", "hashed_key"];

function hashOf(row: Record<string, unknown>): string | null {
  for (const f of HASH_FIELDS) {
    const v = row[f];
    if (typeof v === "string" && v.length >= 32) return v;
  }
  return null;
}

/**
 * Resolves an x-collective-key header to the creator and models it belongs to.
 *
 * Returns an err() Response for every failure, and deliberately returns the
 * SAME message for "no such key" and "wrong secret": distinguishing them tells
 * an attacker which half of a guess was right.
 */
async function authenticate(req: Request): Promise<KeyIdentity | Response> {
  const raw = (req.headers.get("x-collective-key") ?? "").trim();
  if (!raw) {
    return err(
      "invalid_key",
      "Send your submission key in the x-collective-key header.",
      401,
    );
  }
  const parsed = parseCollectiveKey(raw);
  if (!parsed) {
    return err(
      "invalid_key",
      "That is not a Collective key. Keys look like mck_live_ followed by 40 characters.",
      401,
    );
  }

  const digest = await sha256hex(raw);
  const rows = await viewGet<Record<string, unknown>>(
    "api_keys",
    `select=*&key_prefix=eq.${encodeURIComponent(parsed.prefix)}` +
      `&kind=eq.${parsed.kind}&status=eq.active&limit=5`,
  );

  let match: Record<string, unknown> | null = null;
  let unreadable = 0;
  for (const row of rows) {
    const stored = hashOf(row);
    if (stored === null) {
      // Skip it, do not abandon the bucket. This used to RETURN 500 on the
      // first unreadable row, so a perfectly good key sharing a prefix
      // bucket with one malformed row was refused outright — and the early
      // return also defeated the constant work the loop below is written to
      // do, making the response time depend on which row came first.
      unreadable++;
      console.error(
        "collective_ingest: api_keys row has no recognised hash column; saw:",
        Object.keys(row).join(","),
      );
      continue;
    }
    // Compare every candidate rather than breaking early, so the work done
    // does not depend on which row matched.
    if (timingSafeEqual(stored.toLowerCase(), digest)) match = row;
  }
  if (!match) {
    // Only a bucket that yielded NOTHING readable is a server problem worth
    // saying out loud; one bad row beside good ones is a store to repair,
    // not a reason to tell this caller their key is broken.
    if (rows.length > 0 && unreadable === rows.length) {
      return err(
        "server_error",
        "The key store is not readable in the expected shape.",
        500,
      );
    }
    // Same answer whether the prefix matched nothing or the secret was wrong.
    return err("invalid_key", "That key is not valid, or it has been rotated.", 401);
  }

  const creatorId = String(match.creator_id ?? "");
  if (!creatorId) {
    console.error("collective_ingest: api_keys row has no creator_id");
    return err("server_error", "The key is not attached to a creator.", 500);
  }

  const creators = await viewGet<CreatorRow>(
    "creators",
    `select=id,slug,display_name,status&id=eq.${creatorId}&limit=1`,
  );
  const creator = creators[0];
  if (!creator) return err("invalid_key", "That key is not valid, or it has been rotated.", 401);
  if (creator.status && creator.status !== "active") {
    return err("forbidden", "This creator account is not active.", 403);
  }

  const models = await viewGet<ModelRow>(
    "models",
    `select=id,slug,name,sport_code&creator_id=eq.${creator.id}`,
  );

  // Best effort: a failed touch must never fail a submission.
  tableWrite("api_keys", "PATCH", `id=eq.${String(match.id)}`, {
    last_used_at: new Date().toISOString(),
  }).catch(() => {});

  return { key_id: String(match.id), kind: parsed.kind, creator, models };
}

/** Which model this envelope is for. One model on the account needs no
 *  choice; several do, and guessing would silently file a slate under the
 *  wrong record. */
function pickModel(
  models: ModelRow[],
  wanted: unknown,
): { model: ModelRow } | { error: Response } {
  if (models.length === 0) {
    return {
      error: err(
        "not_found",
        "This account has no model yet. Create one from the dashboard before submitting.",
        404,
      ),
    };
  }
  if (typeof wanted === "string" && wanted) {
    const found = models.find((m) => m.slug === wanted);
    if (!found) {
      return {
        error: err(
          "invalid_payload",
          `No model named "${wanted}" on this account. Available: ${
            models.map((m) => m.slug).join(", ")
          }.`,
          422,
        ),
      };
    }
    return { model: found };
  }
  if (models.length > 1) {
    return {
      error: err(
        "invalid_payload",
        `This account has several models; set "model" to one of: ${
          models.map((m) => m.slug).join(", ")
        }.`,
        422,
      ),
    };
  }
  return { model: models[0] };
}

/**
 * The league key the Collective's own odds feed stores, by sport code.
 *
 * This used to be `if (sport !== "NFL") return null`, which meant every
 * college-football creator got `market: null` on every receipt and an
 * `available:false` market endpoint — not because no market existed, but
 * because nothing ever looked. A sport missing from this map genuinely has
 * no stored market: the snapshot is null and the submission still stands.
 *
 * These values must match what collective_odds_ingest WRITES. Adding a sport
 * here without adding it there yields an empty board rather than an error,
 * so the two lists are changed together or not at all.
 */

const ODDS_LEAGUE: Record<string, string> = {
  NFL: "nfl",
  CFB: "ncaaf",
  NCAAF: "ncaaf",
};

/**
 * The current market for the model's sport, attached to a submission result.
 *
 * This is the number the model is being measured against, handed back at the
 * moment of submission so a creator's tooling can see it without a second
 * call and without asking a sportsbook. It is read from the Collective's own
 * stored feed, and it is strictly additive: any failure here returns null and
 * the submission stands, because an odds outage must never cost a creator
 * their slate.
 */
async function marketSnapshot(sport: string): Promise<Record<string, unknown> | null> {
  const league = ODDS_LEAGUE[String(sport).toUpperCase()];
  if (!league) return null;
  try {
    const board = await rpc<Record<string, unknown> | null>("odds_board", {
      p_league: league,
      p_from: new Date(Date.now() - 24 * 3600e3).toISOString(),
      p_to: new Date(Date.now() + 10 * 24 * 3600e3).toISOString(),
      p_include_books: false,
      p_limit: 40,
    });
    if (!board) return null;
    const games = (board.games ?? []) as Record<string, unknown>[];
    return {
      last_poll_at: board.last_poll_at ?? null,
      last_change_at: board.last_odds_at ?? null,
      games: games.map((g) => {
        const c = (g.consensus ?? {}) as Record<string, unknown>;
        const spread = (c.spread ?? null) as Record<string, unknown> | null;
        const total = (c.total ?? null) as Record<string, unknown> | null;
        const ml = (c.moneyline ?? null) as Record<string, unknown> | null;
        return {
          home: g.home,
          away: g.away,
          kickoff: g.commence_time,
          consensus_spread: spread?.median ?? null,
          consensus_total: total?.median ?? null,
          home_fair_prob: ml?.home_fair_prob ?? null,
          books: spread?.books ?? null,
          last_odds_at: g.last_odds_at ?? null,
        };
      }),
      note:
        "Home convention: a negative spread means the home team is favoured. " +
        "Consensus is the median across retail books; the moneyline is a median " +
        "of de-vigged probabilities. Use this for line_at_submission if your " +
        "model does not carry its own.",
    };
  } catch (e) {
    console.error("collective_ingest: market snapshot unavailable:", (e as Error)?.message ?? e);
    return null;
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_ingest");
  // One id per request, stamped into the console line AND into any error body
  // this function returns. Without it, "my post 500'd" and the stack trace in
  // the log could only be paired by guessing at timestamps — which is exactly
  // how a one-line constraint error turned into a written bug report.
  const trace = crypto.randomUUID().slice(0, 8);

  try {
    // Liveness, before any auth, so a creator's script can tell "my key is
    // wrong" apart from "the endpoint is down".
    if (req.method === "GET" && path === "/v1/health") {
      return json({ ok: true, service: "collective_ingest", time: new Date().toISOString() }, 200, NO_STORE);
    }

    const isSubmit = path === "/v1/projections";
    const isDryRun = path === "/v1/projections/dry-run";
    const isRetract = path === "/v1/projections/retract";
    const isMe = path === "/v1/me";
    const isMarket = path === "/v1/market";

    if (!isSubmit && !isDryRun && !isRetract && !isMe && !isMarket) {
      return err("not_found", `No such route: ${req.method} ${path}`, 404, {
        known: ["/v1/projections", "/v1/projections/dry-run", "/v1/projections/retract", "/v1/me", "/v1/market", "/v1/health"],
      });
    }
    if ((isSubmit || isDryRun || isRetract) && req.method !== "POST") {
      return err("method_not_allowed", "Submit with POST.", 405);
    }
    if ((isMe || isMarket) && req.method !== "GET") {
      return err("method_not_allowed", "Wrong method for this route.", 405);
    }

    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;

    // ------------------------------------------------------------- me
    if (isMe) {
      return json({
        ok: true,
        creator: { slug: auth.creator.slug, display_name: auth.creator.display_name },
        key: { prefix: `mck_${auth.kind}_`, kind: auth.kind },
        models: auth.models.map((m) => ({
          model: m.slug,
          name: m.name,
          sport: m.sport_code,
        })),
        submit_to: "/v1/projections",
        dry_run_to: "/v1/projections/dry-run",
        note: auth.kind === "test"
          ? "This is a test key. Slates sent with it are stored separately and never graded or ranked."
          : "Your latest submission per game received before the lock (30 minutes before kickoff) is the one that counts; earlier ones are stored as movement.",
      }, 200, NO_STORE);
    }

    // --------------------------------------------------------- market
    if (isMarket) {
      // The model decides the sport, and the CALLER decides the model. This
      // read auth.models[0], so a creator with an NFL model and a CFB model
      // always got the NFL market back whichever one they were working on —
      // silently, since the response never said which sport it answered for.
      // ?model=<slug> names one; the first model is only the fallback when
      // none is asked for, and the sport is now stated in the response.
      const wanted = new URL(req.url).searchParams.get("model");
      let sportModel: ModelRow | null = auth.models[0] ?? null;
      if (wanted) {
        const found = auth.models.find((m) => m.slug === wanted);
        if (!found) {
          return err(
            "invalid_payload",
            `No model named "${wanted}" on this account. Available: ${
              auth.models.map((m) => m.slug).join(", ")
            }.`,
            422,
          );
        }
        sportModel = found;
      }
      const sport = sportModel?.sport_code ?? "NFL";
      const snap = await marketSnapshot(sport);
      if (!snap) {
        return json({
          ok: true,
          available: false,
          sport,
          model: sportModel?.slug ?? null,
          reason: "no_stored_market",
          note: "The Collective has no current market for this sport. Do not substitute a number.",
        }, 200, NO_STORE);
      }
      return json({
        ok: true,
        available: true,
        sport,
        model: sportModel?.slug ?? null,
        ...snap,
      }, 200, NO_STORE);
    }

    // --------------------------------------------------------- retract
    // A creator removes THEIR OWN projection rows for games that have not
    // kicked off. Under the lock rule nothing needs this: a re-post replaces
    // the model's number on every game that has not locked, by itself. It
    // stays for surgical use — an operator who wants stored rows gone.
    //
    // It works PRE-KICKOFF only, enforced here against the schedule and never
    // against the caller's clock. Rows for games at or past kickoff are left
    // untouched and reported, whatever was asked.
    //
    // Scope is pinned to the key: the creator's own model, live rows only,
    // and a live key — a test key cannot touch the record. Without
    // confirm:true nothing is deleted; the response is the list of what
    // WOULD go, so the caller sees the blast radius before pulling.
    if (isRetract) {
      const rawR = await req.text();
      let rbody: Record<string, unknown> = {};
      try {
        rbody = rawR ? JSON.parse(rawR) as Record<string, unknown> : {};
      } catch {
        return err("invalid_payload", "Body must be JSON.", 422);
      }
      if (auth.kind !== "live") {
        return err("forbidden", "Retract needs a live key: test keys cannot touch the record.", 403);
      }
      const pickedR = pickModel(auth.models, rbody.model);
      if ("error" in pickedR) return pickedR.error;
      const modelR = pickedR.model;

      // Rate-limited under the SUBMIT endpoint's name: the rate_check RPC
      // predates this route, and an unknown endpoint string is exactly the
      // kind of thing that turns into an opaque 500. Sharing the submit
      // budget is also the right accounting — retract-and-repost is one
      // posting cycle. If the check itself fails, the retract proceeds:
      // rate limiting is a shield, not a correctness gate, and this route
      // is already scoped to the caller's own pre-kickoff rows.
      try {
        const allowedR = await rpc<boolean>("rate_check", {
          p_key_id: auth.key_id,
          p_endpoint: "/v1/projections",
        });
        if (allowedR === false) {
          return err("rate_limited", "Hourly limit reached. Try again later.", 429);
        }
      } catch (e) {
        console.error(`collective_ingest[${trace}] retract: rate_check unavailable:`, (e as Error)?.message ?? e);
      }

      const season = Number(rbody.season);
      if (!Number.isFinite(season)) {
        return err("invalid_payload", 'Say which season to retract from, e.g. {"season": 2026}.', 422);
      }
      const week = rbody.week == null ? null : Number(rbody.week);
      const refs = Array.isArray(rbody.game_refs)
        ? (rbody.game_refs as unknown[]).map((x) => String(x)).filter(Boolean)
        : null;

      // The schedule decides what is pre-kickoff, from the same view the
      // board reads. Postponed and canceled games keep stale kickoffs, so
      // they are excluded rather than guessed at.
      const wqR = week === null || !Number.isFinite(week) ? "" : `&week=eq.${week}`;
      const sched = await viewGet<GameDetailRow>(
        "game_detail",
        `select=game_id,kickoff_at,status,label,home,away&sport=eq.${modelR.sport_code}` +
          `&season=eq.${season}${wqR}&order=kickoff_at.asc`,
      );
      const nowMs = Date.now();
      const wanted = refs ? new Set(refs) : null;
      const eligible: GameDetailRow[] = [];
      const past: string[] = [];
      for (const g of sched) {
        if (wanted && !wanted.has(g.game_id)) continue;
        const pre = g.status !== "postponed" && g.status !== "canceled" &&
          new Date(g.kickoff_at).getTime() > nowMs;
        if (pre) eligible.push(g);
        else past.push(g.game_id);
      }
      if (eligible.length === 0) {
        return json({
          ok: true, retracted: 0, model: modelR.slug, season, week,
          games: [], skipped_kicked_off: past,
          note: "Nothing eligible: no pre-kickoff games matched. Rows for games at or past kickoff are never touched.",
        }, 200, NO_STORE);
      }

      // NEVER build one filter over every eligible game. With no week given
      // the schedule above is the whole season — hundreds of games — and a
      // game_id=in.(...) list that long is a query string tens of thousands
      // of characters wide, which PostgREST answers with a flat 400 that
      // says nothing about the real cause. Read the model's own rows with a
      // SMALL query instead and intersect in memory; delete in chunks.
      const eligibleIds = new Set(eligible.map((g) => g.game_id));
      const CHUNK = 40;
      // What this model has stored, asked for in a way that cannot blow the
      // URL: filter by the model alone (one short query), then keep only the
      // pre-kickoff games. projections is the source of truth; board_models
      // is the same view the public board reads and is tried if the first
      // relation will not answer in these columns. Both errors are reported
      // verbatim rather than as a bare 500.
      let rows: { game_id: string }[];
      let previewSource = "projections";
      const errs: string[] = [];
      async function readOwn(rel: string, q: string) {
        return await viewGet<{ game_id: string }>(rel, q);
      }
      try {
        rows = await readOwn(
          "projections",
          `select=game_id&model_id=eq.${modelR.id}&data_origin=eq.live&limit=5000`,
        );
      } catch (e) {
        errs.push("projections: " + String((e as Error)?.message ?? e).slice(0, 200));
        try {
          previewSource = "board_models";
          rows = await readOwn(
            "board_models",
            `select=game_id&model_id=eq.${modelR.id}&limit=5000`,
          );
        } catch (e2) {
          errs.push("board_models: " + String((e2 as Error)?.message ?? e2).slice(0, 200));
          return err(
            "retract_failed",
            "Could not read this model's stored rows. " + errs.join(" | "),
            502,
          );
        }
      }
      const perGame = new Map<string, number>();
      for (const r of rows) {
        if (!eligibleIds.has(r.game_id)) continue;   // kicked off, or another week
        perGame.set(r.game_id, (perGame.get(r.game_id) ?? 0) + 1);
      }
      const have = { length: Array.from(perGame.values()).reduce((a, b) => a + b, 0) };
      const summary = eligible
        .filter((g) => perGame.has(g.game_id))
        .map((g) => ({ game_id: g.game_id, label: g.label, rows: perGame.get(g.game_id) }));

      if (rbody.confirm !== true) {
        return json({
          ok: true, dry_run: true, retracted: 0,
          model: modelR.slug, season, week, preview_source: previewSource,
          would_remove: have.length, games: summary, skipped_kicked_off: past,
          note: have.length
            ? 'Nothing was deleted. Send the same request with "confirm": true to remove these rows. Posting again replaces these rows on the wall by itself, so this is rarely needed.'
            : "Nothing to remove: this model has no live pre-kickoff rows on these games.",
        }, 200, NO_STORE);
      }

      // Delete in chunks over ONLY the games this model actually has rows
      // for — a short list, so each query string stays well inside any URL
      // limit. The receipt is what the database says it removed, summed
      // across chunks, not what this function believes it asked for. A
      // failing delete reports the database's own words: "projections is a
      // view without a delete rule" is actionable, an opaque 500 is not.
      const targets = Array.from(perGame.keys());
      let n = 0;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const slice = targets.slice(i, i + CHUNK);
        const q = `model_id=eq.${modelR.id}&data_origin=eq.live` +
          `&game_id=in.(${slice.map((id) => `"${id}"`).join(",")})`;
        try {
          const gone = await tableWrite("projections", "DELETE", q) as unknown[] | null;
          n += Array.isArray(gone) ? gone.length : 0;
        } catch (e) {
          console.error(`collective_ingest[${trace}] retract: delete failed:`, (e as Error)?.message ?? e);
          return err(
            "retract_failed",
            `Removed ${n} row(s), then a chunk failed: ` +
              String((e as Error)?.message ?? e).slice(0, 300) +
              " — if projections is a view, the delete needs its base table's name. " +
              "Re-running is safe: it only removes what is still there.",
            502,
          );
        }
      }
      return json({
        ok: true, retracted: n, model: modelR.slug, season, week,
        games: summary, skipped_kicked_off: past,
        note: n
          ? "Removed. These games now show nothing for this model until you post again; the next post before the lock is the one that counts."
          : "The delete matched nothing — the rows may already be gone.",
      }, 200, NO_STORE);
    }

    // ---------------------------------------------------------- submit
    // Refuse an oversized body BEFORE reading it, and measure it in the unit
    // the limit is named in. This compared rawBody.length -- UTF-16 code
    // units -- against a constant called MAX_BODY_BYTES, so a slate carrying
    // multibyte names ("San Jose State" with its accent, "Hawai'i") could be
    // half again as many bytes as the check counted and sail past it. Worse,
    // the body had already been buffered in full by the time the check ran,
    // which is the one thing a size limit is there to prevent.
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return err("invalid_payload", "That payload is too large to be a slate.", 413);
    }
    const rawBody = await req.text();
    // UTF-8 is never fewer bytes than UTF-16 code units and never more than
    // three per unit, so both ends are decided without encoding a second
    // copy of the slate purely to measure it.
    const units = rawBody.length;
    const tooBig = units > MAX_BODY_BYTES
      ? true
      : units * 3 <= MAX_BODY_BYTES
      ? false
      : new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES;
    if (tooBig) {
      return err("invalid_payload", "That payload is too large to be a slate.", 413);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return err("invalid_payload", "Body must be JSON.", 422);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return err("invalid_payload", "Body must be a JSON envelope, not an array.", 422);
    }

    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return err(
        "invalid_payload",
        "Envelope must include a non-empty rows array. Each row needs game_ref, home_team, away_team and kickoff.",
        422,
      );
    }
    if (rows.length > MAX_ROWS) {
      return err("invalid_payload", `${rows.length} rows exceeds the ${MAX_ROWS} row maximum.`, 422);
    }

    const picked = pickModel(auth.models, body.model);
    if ("error" in picked) return picked.error;
    const model = picked.model;

    // Guarded exactly as the retract route's copy above already is, and for
    // the reason its comment gives: an endpoint string this RPC does not
    // recognise "is exactly the kind of thing that turns into an opaque 500".
    // This call is one of only TWO places where the live and dry-run routes
    // differ — they pass "/v1/projections" and "/v1/projections/dry-run"
    // respectively — and the only one that can fail before the slate ever
    // reaches ingest_submission. Unguarded, a throw here cost a creator their
    // whole slate and told them nothing about why.
    //
    // Rate limiting is a shield, not a correctness gate: if the shield is
    // broken, log the database's own words and let the slate through rather
    // than dropping a creator's work on the floor.
    try {
      const allowed = await rpc<boolean>("rate_check", {
        p_key_id: auth.key_id,
        p_endpoint: path,
      });
      if (allowed === false) {
        return err("rate_limited", "Hourly submission limit reached. Try again later.", 429);
      }
    } catch (e) {
      console.error(
        `collective_ingest[${trace}]: rate_check unavailable for ${path}:`,
        e instanceof RpcError ? `${e.message} ${e.body}` : (e as Error)?.message ?? e,
      );
    }

    // The envelope goes to the RPC verbatim apart from pinning the model and
    // sport to the key's own identity: a key may only ever write to its own
    // creator's model, whatever the body claims.
    const pKey = {
      key_id: auth.key_id,
      kind: auth.kind,
      creator_id: auth.creator.id,
      creator_slug: auth.creator.slug,
      creator_name: auth.creator.display_name,
      model_id: model.id,
      model_slug: model.slug,
      model_name: model.name,
      sport: model.sport_code,
    };
    const envelope = { ...body, model: model.slug, sport: model.sport_code };
    delete (envelope as Record<string, unknown>).dry_run;

    // The route decides, not the body: posting to /v1/projections stores,
    // posting to /v1/projections/dry-run never does.
    const dry = isDryRun;

    // The one call that behaves differently between the two routes. A write
    // that the dry run only simulated can fail on a constraint here, and that
    // failure arrives as an RpcError carrying Postgres's own diagnostic. It is
    // caught HERE rather than by the outer catch, so the reply can say which
    // stage failed — "the store refused this" reads very differently from
    // "something in this function threw", and the creator needs to know which.
    let result: Record<string, unknown> | null = null;
    try {
      result = await rpc<Record<string, unknown> | null>("ingest_submission", {
        p_key: pKey,
        p_envelope: envelope,
        p_dry: dry,
      });
    } catch (e) {
      if (e instanceof RpcError) {
        console.error(`collective_ingest[${trace}] ingest_submission rpc failure:`, e.message, e.body);
      } else {
        console.error(`collective_ingest[${trace}] ingest_submission failure:`, e);
      }
      return err(
        "server_error",
        dry
          ? "The store could not validate this slate."
          : "The store refused this slate. Nothing was saved; the reason is in details.",
        500,
        dbDetail(e, trace, "ingest_submission"),
      );
    }

    if (!result || result.ok === false) {
      const code = typeof result?.code === "string" ? result.code : "server_error";
      if (code === "server_error") {
        // The RPC said "server_error" and this used to drop everything it said
        // along with it, leaving details:null. details is the field the
        // contract reserves for exactly this.
        console.error(`collective_ingest[${trace}] submission failed:`, result);
        return err("server_error", "Something went wrong on our side.", 500, {
          trace,
          stage: "ingest_submission",
          rpc_message: result?.message ?? null,
          rpc_details: result?.details ?? null,
        });
      }
      return err(code, String(result?.message ?? "The submission was rejected."), 422, result?.details ?? null);
    }

    const out = { ...result } as Record<string, unknown>;
    delete out.ok;
    out.model = model.slug;
    out.sport = model.sport_code;
    out.kind = auth.kind;
    out.trace = trace;
    if (dry) {
      out.dry_run = true;
      out.submission_id = null;
      out.note = "Nothing was stored. Fix any rejected rows, rerun, then post to /v1/projections.";
    }

    // The market this slate will be measured against, for the creator's own
    // record. Never blocks the submission.
    out.market = await marketSnapshot(model.sport_code);

    return json(out, 200, NO_STORE);
  } catch (e) {
    // Anything that reaches here is outside the submit RPC, which now reports
    // itself above. An RpcError still carries Postgres's own words — the
    // table, the column, the constraint — so hand them back rather than
    // logging them and returning an empty details the caller cannot act on.
    if (e instanceof RpcError) console.error(`collective_ingest[${trace}] rpc failure:`, e.message, e.body);
    else console.error(`collective_ingest[${trace}] failure:`, e);
    return err("server_error", "Something went wrong on our side.", 500, dbDetail(e, trace, "function"));
  }
});
