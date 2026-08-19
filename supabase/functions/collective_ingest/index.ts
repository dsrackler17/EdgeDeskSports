// collective_ingest: the submission API for the Model Collective.
//
// Routes (subpath after /functions/v1/collective_ingest):
//   GET  /v1/whoami               key check: creator, model, key, limits
//   POST /v1/projections          submit a slate envelope
//   POST /v1/projections/dry-run  identical validation and resolution, writes
//                                 nothing, returns what would happen
//
// Auth is the x-collective-key header (verify_jwt=false in config.toml).
// This function is transport, auth, limits, and response shaping only; all
// row-level business logic lives in the collective.ingest_submission RPC.

import { err, json, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { parseCollectiveKey, sha256hex } from "../_shared/keys.ts";

const FN_NAME = "collective_ingest";

// Contract error taxonomy (CONTRACT.md section 5) used when translating
// ok:false RPC outcomes to HTTP statuses.
const CODE_STATUS: Record<string, number> = {
  invalid_key: 401,
  revoked_key: 401,
  forbidden: 403,
  forbidden_origin: 403,
  not_found: 404,
  entitlement_required: 402,
  token_invalid: 404,
  token_expired: 410,
  token_spent: 410,
  method_not_allowed: 405,
  rate_limited: 429,
  payload_too_large: 413,
  invalid_payload: 422,
  conflict: 409,
  server_error: 500,
};

interface VerifyResult {
  ok?: boolean;
  code?: string;
  message?: string;
  // verify_key returns FLAT fields (see migration 7)
  key_id?: string;
  kind?: string;
  creator_id?: string;
  creator_slug?: string;
  creator_name?: string;
  model_id?: string;
  model_slug?: string;
  model_name?: string;
  sport?: string;
  limits?: { max_rows?: number; max_bytes?: number; rate_per_hour?: number };
}

interface IngestResult {
  ok?: boolean;
  code?: string;
  message?: string;
  details?: unknown;
  submission_id?: string | null;
  received_at?: string;
  data_origin?: string;
  counts?: unknown;
  rows?: unknown[];
  duplicate?: boolean;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

async function handle(req: Request): Promise<Response> {
  const path = subpath(req, FN_NAME);

  const routeMethods: Record<string, string> = {
    "/v1/whoami": "GET",
    "/v1/projections": "POST",
    "/v1/projections/dry-run": "POST",
  };
  const expected = routeMethods[path];
  if (!expected) {
    return err("not_found", `No such route: ${path}`, 404);
  }
  if (req.method !== expected) {
    return err(
      "method_not_allowed",
      `${path} accepts ${expected} only.`,
      405,
      null,
    );
  }

  // 1. Parse the submission key.
  const rawKey = (req.headers.get("x-collective-key") ?? "").trim();
  if (rawKey === "") {
    return err("invalid_key", "Missing x-collective-key header.", 401);
  }
  const parsed = parseCollectiveKey(rawKey);
  if (!parsed) {
    return err(
      "invalid_key",
      "The submission key is malformed. Keys look like mck_live_... or mck_test_...",
      401,
    );
  }

  // 2. Verify by prefix lookup plus hash comparison, done in the database.
  const keyHash = await sha256hex(rawKey);
  const verified = await rpc<VerifyResult | null>("verify_key", {
    p_prefix: parsed.prefix,
    p_hash: keyHash,
  });
  if (!verified || verified.ok === false) {
    const revoked = verified?.code === "revoked_key";
    if (revoked) {
      return err(
        "revoked_key",
        "This key has been revoked. Rotate a new key from your dashboard.",
        401,
      );
    }
    return err("invalid_key", "Unknown submission key.", 401);
  }

  const keyId = verified.key_id ?? null;
  if (!keyId) {
    console.error("collective_ingest: verify_key result carried no key id:", verified);
    return err("server_error", "An unexpected server error occurred.", 500);
  }

  // 3. Per-key sliding-hour rate limit.
  const allowed = await rpc<boolean>("rate_check", {
    p_key_id: keyId,
    p_endpoint: path,
  });
  if (allowed === false) {
    return err(
      "rate_limited",
      "Hourly rate limit reached for this key. Try again later.",
      429,
    );
  }

  const limits = verified.limits ?? {};
  const maxRows = asNumber(limits.max_rows, 500);
  const maxBytes = asNumber(limits.max_bytes, 524288);
  const ratePerHour = asNumber(limits.rate_per_hour, 60);

  if (path === "/v1/whoami") {
    return json({
      creator: {
        slug: verified.creator_slug ?? null,
        display_name: verified.creator_name ?? null,
      },
      model: {
        model_slug: verified.model_slug ?? null,
        model_name: verified.model_name ?? null,
        sport: verified.sport ?? null,
      },
      key: {
        prefix: `mck_${parsed.kind}_${parsed.prefix}`,
        kind: parsed.kind,
      },
      limits: { max_rows: maxRows, rate_per_hour: ratePerHour },
    });
  }

  // 4. Size limits: reject on the declared content-length first, then on the
  // actual body length, so an honest large client fails fast and a dishonest
  // header cannot dodge the cap.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return err(
      "payload_too_large",
      `Payload exceeds the ${maxBytes} byte limit.`,
      413,
    );
  }
  const bodyText = await req.text();
  const bodyBytes = new TextEncoder().encode(bodyText).length;
  if (bodyBytes > maxBytes) {
    return err(
      "payload_too_large",
      `Payload is ${bodyBytes} bytes; the limit is ${maxBytes}.`,
      413,
    );
  }

  // 5. Parse the envelope. Non-JSON bodies are rejected here; everything
  // row-level (team resolution, quarantine, first-submission lock, late
  // flags, idempotent replay) happens inside the ingest RPC transaction.
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return err("invalid_payload", "Body must be valid JSON.", 422);
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return err("invalid_payload", "Body must be a JSON object envelope.", 422);
  }
  const rows = (envelope as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return err(
      "invalid_payload",
      "Envelope must include a non-empty rows array.",
      422,
    );
  }
  if (rows.length > maxRows) {
    return err(
      "invalid_payload",
      `Envelope has ${rows.length} rows; the limit is ${maxRows} rows per submission.`,
      422,
    );
  }

  // 6. Hand the envelope to the database verbatim. Identity comes from the
  // verified key, never from name strings in the payload.
  const dry = path === "/v1/projections/dry-run";
  const result = await rpc<IngestResult | null>("ingest_submission", {
    p_key: verified,
    p_envelope: envelope,
    p_dry: dry,
  });

  if (!result || result.ok === false) {
    const code = typeof result?.code === "string" ? result.code : "server_error";
    const status = CODE_STATUS[code] ?? 500;
    if (status === 500) {
      console.error("collective_ingest: ingest_submission failed:", result);
      return err("server_error", "An unexpected server error occurred.", 500);
    }
    return err(
      code,
      typeof result?.message === "string"
        ? result.message
        : "The submission was rejected.",
      status,
      result?.details ?? null,
    );
  }

  const out: Record<string, unknown> = {
    submission_id: dry ? null : (result.submission_id ?? null),
    received_at: result.received_at ?? new Date().toISOString(),
    data_origin: result.data_origin ?? null,
    counts: result.counts ?? null,
    rows: result.rows ?? [],
    duplicate: result.duplicate ?? false,
  };
  if (dry) {
    out.dry_run = true;
  }
  return json(out);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pf = preflight(req);
  if (pf) return pf;
  try {
    return await handle(req);
  } catch (e) {
    if (e instanceof RpcError) {
      console.error(`collective_ingest: ${e.message}:`, e.body);
    } else {
      console.error("collective_ingest: unexpected error:", e);
    }
    return err("server_error", "An unexpected server error occurred.", 500);
  }
});
