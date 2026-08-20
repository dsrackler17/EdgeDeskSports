// collective_join - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_join
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

// ---------- collective_join/index.ts ----------
// Model Collective join API: the whole join flow is one link (Section 6).
// GET checks a token, POST redeems it after the magic-link sign-in, and the
// dead-token request route makes sure a lost creator is never dropped.








const TOKEN_RE = /^mci_[A-Za-z0-9]{8,64}$/;

function embedSnippet(slug: string): string {
  return `<script src="${BASE_URL}/collective/embed.js" data-collective-host="${slug}" async></script>`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_join");

  // CONTRACT 5: join GETs answer any origin, join POSTs answer only the
  // Collective's own site (plus localhost for development).
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin) {
      let host = "";
      try { host = new URL(origin).hostname; } catch { host = ""; }
      const base = new URL(BASE_URL).hostname;
      const allowed = host === base || host === `www.${base}` || host === "localhost" || host === "127.0.0.1";
      if (!allowed) return err("forbidden_origin", "Join requests come from the Collective site only.", 403);
    }
  }

  try {
    let m = path.match(/^\/v1\/join\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const raw = decodeURIComponent(m[1]);
      if (!TOKEN_RE.test(raw)) return err("token_invalid", "That invite code does not look right.", 404);
      const st = await rpc<{ ok: boolean; code?: string; status?: string; founding?: boolean; prefill?: unknown; expires_at?: string }>(
        "invite_status", { p_token_hash: await sha256hex(raw) });
      if (!st.ok) return err("token_invalid", "That invite does not exist.", 404);
      const body = {
        status: st.status, founding: st.founding ?? false,
        prefill: st.prefill ?? {}, expires_at: st.expires_at ?? null,
        request_url: "/v1/join/request",
      };
      if (st.status === "expired" || st.status === "spent" || st.status === "revoked") return json(body, 410);
      return json(body, 200, { "cache-control": "no-store" });
    }

    m = path.match(/^\/v1\/join\/([^/]+)\/redeem$/);
    if (req.method === "POST" && m) {
      const raw = decodeURIComponent(m[1]);
      if (!TOKEN_RE.test(raw)) return err("token_invalid", "That invite code does not look right.", 404);
      const user = await getUser(req);
      if (!user) return err("invalid_key", "Sign in with your magic link first.", 401);

      const body = await req.json().catch(() => null) as {
        display_name?: string; sport?: string; model_name?: string;
        description?: string | null; website_url?: string | null;
        x_handle?: string | null; logo_url?: string | null; accept_terms?: boolean;
        source_kind?: string | null; source_ref?: string | null;
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);

      const problems: string[] = [];
      const name = (body.display_name ?? "").trim();
      const modelName = (body.model_name ?? "").trim();
      const sport = (body.sport ?? "").trim().toUpperCase();
      if (name.length < 2 || name.length > 60) problems.push("Display name must be 2 to 60 characters.");
      if (modelName.length < 2 || modelName.length > 60) problems.push("Model name must be 2 to 60 characters.");
      if (body.accept_terms !== true) problems.push("The terms checkbox is required.");
      const sports = await viewGet<{ code: string }>("sports", "select=code&active=is.true");
      if (!sports.some((s) => s.code === sport)) problems.push(`Sport must be one of: ${sports.map((s) => s.code).join(", ")}.`);
      const cleanUrl = (v: string | null | undefined): string | null => {
        const s = (v ?? "").trim();
        if (!s) return null;
        try {
          const u = new URL(s.startsWith("http") ? s : `https://${s}`);
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad");
          return u.toString();
        } catch {
          problems.push(`"${s}" is not a usable URL.`);
          return null;
        }
      };
      const website = cleanUrl(body.website_url);
      const logo = cleanUrl(body.logo_url);
      // Model source: optional forever; an unknown kind is dropped, not fatal.
      const srcKind = typeof body.source_kind === "string" &&
        ["excel", "github", "online", "other"].includes(body.source_kind) ? body.source_kind : null;
      const srcRef = (body.source_ref ?? "").toString().trim().slice(0, 300) || null;
      if (problems.length) return err("invalid_payload", problems.join(" "), 422, problems);

      const fresh = await newApiKey("live");
      const out = await rpc<{
        ok: boolean; code?: string; message?: string; already_issued?: boolean;
        creator_slug?: string; display_name?: string; founding?: boolean;
        model_slug?: string; model_name?: string; sport?: string;
      }>("redeem_invite", {
        p_token_hash: await sha256hex(raw),
        p_user_id: user.id,
        p_email: user.email,
        p_profile: {
          display_name: name, sport, model_name: modelName,
          description: (body.description ?? "").toString().trim() || null,
          website_url: website,
          x_handle: (body.x_handle ?? "").toString().trim().replace(/^@/, "") || null,
          logo_url: logo,
          source_kind: srcKind, source_ref: srcRef,
        },
        p_key_prefix: fresh.prefix,
        p_key_hash: fresh.hash,
      });

      if (!out.ok) {
        const status = out.code === "token_expired" || out.code === "token_spent" || out.code === "token_revoked" ? 410 : 404;
        return err(out.code ?? "token_invalid", out.message ?? "This invite cannot be used.", status);
      }

      const slug = out.creator_slug!;
      const prompt = renderPrompt({
        CREATOR_NAME: out.display_name ?? name,
        MODEL_NAME: out.model_name ?? modelName,
        SPORT: out.sport ?? sport,
        API_BASE: `${SB_URL}/functions/v1`,
        API_KEY: out.already_issued ? "(already issued: rotate from your dashboard to get a new one)" : fresh.raw,
        EMBED_SNIPPET: embedSnippet(slug),
        DASHBOARD_URL: `${BASE_URL}/collective/#dashboard`,
        DOCS_URL: `${BASE_URL}/collective/#rules`,
      });

      return json({
        creator: {
          slug, display_name: out.display_name,
          profile_url: `${BASE_URL}/collective/#/${slug}`,
        },
        model: { model_slug: out.model_slug, model_name: out.model_name, sport: out.sport },
        api_key: out.already_issued
          ? { key: null, prefix: null, shown_once: true, note: "already_issued" }
          : { key: fresh.raw, prefix: `mck_live_${fresh.prefix}`, shown_once: true },
        prompt,
        embed_snippet: embedSnippet(slug),
        dashboard_url: `${BASE_URL}/collective/#dashboard`,
        founding: out.founding ?? false,
      }, 200, { "cache-control": "no-store" });
    }

    if (req.method === "POST" && path === "/v1/join/request") {
      const body = await req.json().catch(() => null) as { email?: string; note?: string; token?: string } | null;
      const email = (body?.email ?? "").trim();
      if (!/.+@.+\..+/.test(email)) return err("invalid_payload", "A valid email is required.", 422);
      await rpc("join_request", {
        p_email: email.slice(0, 200),
        p_note: (body?.note ?? "").toString().slice(0, 500),
        p_token: (body?.token ?? "").toString(),
      });
      return json({ ok: true, message: "Request recorded. The founder reviews these and sends fresh links." });
    }

    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_join rpc failure:", e.message, e.body);
    else console.error("collective_join failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
