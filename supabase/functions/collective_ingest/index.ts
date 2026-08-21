// Model Collective — creator submission API.
//
// The endpoint a creator's own project posts finished projections to,
// authenticated with their mck_live_ / mck_test_ key. It is deliberately the
// same pipeline as the dashboard's browser upload: both resolve to a key
// identity and hand the envelope verbatim to the ingest_submission RPC, so a
// slate posted by a script and a slate posted by a human are validated,
// rate limited, timestamped and graded identically.
//
//   POST /v1/projections           store the slate
//   POST /v1/projections/dry-run   validate it, store nothing
//   GET  /v1/me                    confirm a key works, and what it is for
//   GET  /v1/market                the Collective's own current NFL market
//   GET  /v1/health                liveness, no auth
//
// DEPLOYMENT: turn OFF "Enforce JWT verification" for this function. Creators
// authenticate with x-collective-key, not a Supabase session, so the gateway
// must let the request through to be authenticated here.
//
// The key is never stored or logged in the clear. Only the sha256 of the full
// raw key is compared, against the hash already on the api_keys row.

import { err, json, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { parseCollectiveKey, sha256hex, timingSafeEqual } from "../_shared/keys.ts";
import { tableWrite, viewGet } from "../_shared/reads.ts";

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
  for (const row of rows) {
    const stored = hashOf(row);
    if (stored === null) {
      console.error(
        "collective_ingest: api_keys row has no recognised hash column; saw:",
        Object.keys(row).join(","),
      );
      return err(
        "server_error",
        "The key store is not readable in the expected shape.",
        500,
      );
    }
    // Compare every candidate rather than breaking early, so the work done
    // does not depend on which row matched.
    if (timingSafeEqual(stored.toLowerCase(), digest)) match = row;
  }
  // Same answer whether the prefix matched nothing or the secret was wrong.
  if (!match) {
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
  if (String(sport).toUpperCase() !== "NFL") return null;
  try {
    const board = await rpc<Record<string, unknown> | null>("odds_board", {
      p_league: "nfl",
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

  try {
    // Liveness, before any auth, so a creator's script can tell "my key is
    // wrong" apart from "the endpoint is down".
    if (req.method === "GET" && path === "/v1/health") {
      return json({ ok: true, service: "collective_ingest", time: new Date().toISOString() }, 200, NO_STORE);
    }

    const isSubmit = path === "/v1/projections";
    const isDryRun = path === "/v1/projections/dry-run";
    const isMe = path === "/v1/me";
    const isMarket = path === "/v1/market";

    if (!isSubmit && !isDryRun && !isMe && !isMarket) {
      return err("not_found", `No such route: ${req.method} ${path}`, 404, {
        known: ["/v1/projections", "/v1/projections/dry-run", "/v1/me", "/v1/market", "/v1/health"],
      });
    }
    if ((isSubmit || isDryRun) && req.method !== "POST") {
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
          : "Only the first pre-kickoff submission per game counts toward the record.",
      }, 200, NO_STORE);
    }

    // --------------------------------------------------------- market
    if (isMarket) {
      const sport = auth.models[0]?.sport_code ?? "NFL";
      const snap = await marketSnapshot(sport);
      if (!snap) {
        return json({
          ok: true,
          available: false,
          reason: "no_stored_market",
          note: "The Collective has no current market for this sport. Do not substitute a number.",
        }, 200, NO_STORE);
      }
      return json({ ok: true, available: true, ...snap }, 200, NO_STORE);
    }

    // ---------------------------------------------------------- submit
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
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

    const allowed = await rpc<boolean>("rate_check", {
      p_key_id: auth.key_id,
      p_endpoint: path,
    });
    if (allowed === false) {
      return err("rate_limited", "Hourly submission limit reached. Try again later.", 429);
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

    const result = await rpc<Record<string, unknown> | null>("ingest_submission", {
      p_key: pKey,
      p_envelope: envelope,
      p_dry: dry,
    });

    if (!result || result.ok === false) {
      const code = typeof result?.code === "string" ? result.code : "server_error";
      if (code === "server_error") {
        console.error("collective_ingest submission failed:", result);
        return err("server_error", "Something went wrong on our side.", 500);
      }
      return err(code, String(result?.message ?? "The submission was rejected."), 422, result?.details ?? null);
    }

    const out = { ...result } as Record<string, unknown>;
    delete out.ok;
    out.model = model.slug;
    out.sport = model.sport_code;
    out.kind = auth.kind;
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
    if (e instanceof RpcError) console.error("collective_ingest rpc failure:", e.message, e.body);
    else console.error("collective_ingest failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
