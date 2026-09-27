// collective_join - SELF-CONTAINED BUNDLE for the Supabase dashboard editor.
// Generated from supabase/functions/ by tools/collective/bundle_functions.py.
// Paste this whole file as index.ts for a function named exactly: collective_join
// IMPORTANT: turn OFF "Enforce JWT verification" for this function.
//
// ---------------------------------------------------------------------------
// TRANSCRIBED, NOT EXPORTED. This file was pasted in from the deployed
// function, the same way close/index.ts and learn/index.ts were: DIFF IT
// AGAINST THE DEPLOYED FUNCTION before treating it as authoritative, because a
// transcription error here would be indistinguishable from a real difference.
// The _shared/ sources the header refers to, and bundle_functions.py itself,
// are not in this repository either -- so until they are, this bundle IS the
// source and editing it is how the function changes.
//
// WHAT CHANGED IN THIS COMMIT, and nothing else did:
//
//   1. POST /v1/models -- ADD A SPORT TO AN EXISTING ACCOUNT. New route. A
//      slate attaches to a MODEL and the Collective resolves its games in that
//      model's sport, so a contributor with a CFB model and no NFL model had
//      nothing to attach an NFL slate to. redeem_invite has been able to create
//      a model since the day it was written; it just only ever fires once, at
//      redemption. This is the same capability for an account that already
//      exists. It never reads whose model to create from the body -- the
//      creator comes from the SESSION, the same rule collective_ingest applies
//      to a key.
//
//      The database's collective.get_or_create_model (installed by
//      supabase/collective_model_autocreate.sql) does the work where it is
//      installed: it normalises the sport, serialises on (creator, sport) and
//      inserts on conflict do nothing, so two tabs cannot make two models.
//      Where it is not installed this route writes the row itself and re-reads
//      on a duplicate, so a contributor is never blocked on a migration.
//
//   2. The www host check. It read
//        host === `[www.${base}](https://www.${base})`
//      which is a markdown link, not a hostname, and can never match anything
//      -- so a join POST from www.edgedesksports.com was refused as a
//      forbidden origin. Now `www.${base}`. THIS IS THE ONE LINE WHERE THIS
//      FILE DELIBERATELY DIFFERS FROM WHAT WAS PASTED IN; if the deployed
//      function really carries the markdown, this is a live bug fix, and if it
//      was an artifact of the paste, this restores what was meant.
// ---------------------------------------------------------------------------

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
// Shared read paths over the collective views via PostgREST.

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

// ---------- inlined _shared/sports.ts ----------
/**
 * ONE SPORT, ONE FAMILY. Every spelling that means the same sport collapses to
 * the same key, so a slate detected as "college football", a key typed NCAAF
 * and a model stored as CFB-P4 are one thing and not three.
 *
 * This map is the same one in four places on purpose, and they are changed
 * together: collective.sport_aliases (supabase/collective_model_autocreate.sql),
 * the SPORTS registry in collective/index.html, collective_ingest, and here.
 * The database is the authority -- it is what the unique index is built on --
 * and these copies exist because an edge function bundles no imports and must
 * be able to MATCH a sport without a round trip. They never decide what gets
 * stored: creation goes through the database function, which canonicalises for
 * itself.
 *
 * An unknown code is its own family. Two sports nobody has heard of must never
 * silently become one.
 */
const SPORT_ALIASES: Record<string, string> = {
  NFL: "NFL",
  NATIONALFOOTBALLLEAGUE: "NFL",
  PROFOOTBALL: "NFL",
  NFLFOOTBALL: "NFL",
  AMERICANFOOTBALLNFL: "NFL",
  CFB: "CFB",
  NCAAF: "CFB",
  CFBP4: "CFB",
  COLLEGE: "CFB",
  NCAAFOOTBALL: "CFB",
  COLLEGEFOOTBALL: "CFB",
  NCAAFB: "CFB",
  CFP: "CFB",
  AMERICANFOOTBALLNCAAF: "CFB",
};

function sportFamily(code: unknown): string | null {
  const k = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!k) return null;
  return SPORT_ALIASES[k] ?? k;
}

interface CreatedModel {
  model_id: string;
  model_slug: string;
  model_name: string;
  sport: string;
  created: boolean;
}

/**
 * GET-OR-CREATE, and the only way this function ever makes a model.
 *
 * The work is done by collective.get_or_create_model, installed by
 * supabase/collective_model_autocreate.sql: it normalises the sport,
 * serialises on (creator, sport) with an advisory lock, inserts on conflict do
 * nothing and reads the row back, so two submissions arriving at the same
 * instant get the same model rather than two. That function is the single
 * source of truth -- the dashboard reaches the same logic through
 * public.collective_model_ensure, and collective_ingest calls this same RPC.
 *
 * THE FALLBACK, and why it is not a second source of truth. On a database
 * where the migration has not been pasted yet the RPC answers 404, and
 * refusing here would put a contributor's first slate in a new sport back
 * where this whole change found it: waiting on somebody with database access.
 * So the row is written directly instead, with the same deterministic slug,
 * and a duplicate is treated as the caller getting what they asked for and
 * re-read. It is the weaker path -- it leans on the models table's own
 * uniqueness rather than on an index this function can see -- and it exists
 * only until the file is run.
 */
async function getOrCreateModel(
  creator: { id: string; slug: string; display_name: string },
  sport: string,
  wantedName: string,
): Promise<CreatedModel> {
  try {
    const rows = await rpc<CreatedModel[] | CreatedModel | null>("get_or_create_model", {
      p_creator_id: creator.id,
      p_sport: sport,
      p_model_name: wantedName || null,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row && row.model_slug) return row;
    throw new Error("get_or_create_model returned no row");
  } catch (e) {
    const missing = e instanceof RpcError &&
      (e.status === 404 || /PGRST202|PGRST203|could not find the function/i.test(e.body));
    if (!missing) throw e;
    console.error(
      "collective_join: collective.get_or_create_model is not installed " +
        "(run supabase/collective_model_autocreate.sql); creating the model directly.",
    );
  }

  const code = String(sport).toUpperCase().trim();
  const slug = `${creator.slug}-${code.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  const name = (wantedName || `${creator.display_name || creator.slug} ${code}`).slice(0, 60);
  try {
    const made = await tableWrite("models", "POST", "", [{
      creator_id: creator.id, slug, name, sport_code: code, is_listed: true,
    }]) as { id?: string; slug?: string; name?: string; sport_code?: string }[] | null;
    const row = Array.isArray(made) ? made[0] : null;
    if (row?.slug) {
      return {
        model_id: String(row.id ?? ""),
        model_slug: row.slug,
        model_name: row.name ?? name,
        sport: row.sport_code ?? code,
        created: true,
      };
    }
  } catch (e) {
    // Losing a race is the caller getting what they asked for, not a failure.
    const msg = String((e as Error)?.message ?? e);
    if (!/duplicate key|23505|already exists|conflict/i.test(msg)) throw e;
  }
  const back = await viewGet<{ id: string; slug: string; name: string; sport_code: string }>(
    "models",
    `select=id,slug,name,sport_code&creator_id=eq.${encodeURIComponent(creator.id)}` +
      `&slug=eq.${encodeURIComponent(slug)}&limit=1`,
  );
  if (!back[0]) throw new Error(`the ${code} model could not be created`);
  return {
    model_id: back[0].id,
    model_slug: back[0].slug,
    model_name: back[0].name,
    sport: back[0].sport_code,
    created: false,
  };
}

// ---------- collective_join/index.ts ----------
// Model Collective join API: the whole join flow is one link (Section 6).
// GET checks a token, POST redeems it after the magic-link sign-in, the
// dead-token request route makes sure a lost creator is never dropped, and
// POST /v1/models lets an account that already exists cover another sport.

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
      // `www.${base}`, not a markdown link to it. See the header: as pasted
      // this compared a hostname against "[www.x](https://www.x)", which
      // nothing can equal, so every join POST from www was a forbidden origin.
      const allowed = host === base || host === `www.${base}` ||
        host === "localhost" || host === "127.0.0.1";
      if (!allowed) return err("forbidden_origin", "Join requests come from the Collective site only.", 403);
    }
  }

  try {
    // ---------------------------------------------- add a sport to my account
    // WHY IT EXISTS. A slate is attached to a MODEL, and the Collective
    // resolves that slate's games in that model's sport. A creator with a CFB
    // model and no NFL model has nothing to attach an NFL slate to -- the
    // uploader stops rather than looking NFL games up in the college schedule,
    // which is correct, and reads from outside as "it isn't letting me submit
    // anything". Until this route existed the only cure was an operator
    // running a statement, so a contributor's first upload in a new sport
    // ended in a message asking somebody else to act.
    //
    // WHAT IT WILL NOT DO. It never reads whose model to create from the body.
    // The creator comes from the SESSION -- the same rule collective_ingest
    // applies to a key, where the envelope's model and sport are overwritten
    // with the key's own. A body that could name a creator would be a way to
    // add a model to somebody else's account, and there is no reason for the
    // caller to name one: an account has exactly one creator profile.
    if (req.method === "POST" && path === "/v1/models") {
      const user = await getUser(req);
      if (!user) return err("invalid_key", "Sign in first.", 401);

      const body = await req.json().catch(() => null) as
        { sport?: string; model_name?: string } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);

      const sport = (body.sport ?? "").trim();
      const wanted = (body.model_name ?? "").trim();
      if (!sport) return err("invalid_payload", "Name the sport to create a model for.", 422);
      if (wanted.length > 60) {
        return err("invalid_payload", "Model name must be 60 characters or fewer.", 422);
      }

      // THE CREATOR THIS SESSION OWNS. Looked up by the signed-in user id and
      // nothing else. Active only: a contributor a removal closed does not get
      // to grow a new sport on the way out.
      const creators = await viewGet<{ id: string; slug: string; display_name: string }>(
        "creators",
        `select=id,slug,display_name&user_id=eq.${encodeURIComponent(user.id)}` +
          `&status=eq.active&limit=1`,
      );
      const creator = creators[0];
      if (!creator) {
        return err(
          "forbidden",
          "This account has no active creator profile, so there is nothing to add a model to.",
          403,
        );
      }

      // THE SERVER OWNS THE SPORT VOCABULARY. A code it does not list would
      // make a model whose slates can never resolve against a schedule -- the
      // exact failure this endpoint exists to prevent, arriving one step later.
      // Matched on FAMILY, so a caller saying CFB reaches a server that spells
      // it NCAAF instead of being told CFB is not a sport.
      const sports = await viewGet<{ code: string }>("sports", "select=code&active=is.true");
      const fam = sportFamily(sport);
      const known = sports.find((s) => sportFamily(s.code) === fam);
      if (!known) {
        return err(
          "invalid_payload",
          `Sport must be one of: ${sports.map((s) => s.code).join(", ")}.`,
          422,
          { known_sports: sports.map((s) => s.code) },
        );
      }

      // ALREADY THERE IS NOT AN ERROR. A second press, or two tabs, hands back
      // the same shape -- an error here would read as the model having failed
      // to appear and send somebody looking for a problem that does not exist.
      // get_or_create_model decides that, not a check-then-write here, so two
      // tabs pressing at the same instant cannot both insert.
      let made: CreatedModel;
      try {
        made = await getOrCreateModel(creator, known.code, wanted);
      } catch (e) {
        if (e instanceof RpcError) {
          console.error("collective_join: model create failed:", e.message, e.body);
        } else {
          console.error("collective_join: model create failed:", e);
        }
        return err("server_error", "The model could not be created.", 500);
      }

      return json({
        already: !made.created,
        created: made.created,
        model: {
          model_slug: made.model_slug,
          model_name: made.model_name,
          sport: made.sport,
        },
      }, 200, { "cache-control": "no-store" });
    }

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
