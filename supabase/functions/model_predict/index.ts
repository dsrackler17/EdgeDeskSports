// ============================================================================
// EdgeDesk : model_predict  —  multi-sport prediction engine
//
// WHAT THIS FUNCTION IS. It answers one question per market: what does the
// model believe the probability is? It does NOT decide BET / WAIT / PASS. That
// belongs to EdgeDesk's research and decision layer, which is downstream and
// stays downstream (spec §22). It also never calls an LLM: every probability
// here comes out of a deterministic statistical process, and an LLM may one day
// explain a prediction but will never compute one (spec §23).
//
// SPORTS
//     baseball_mlb            mlb_runs_v1.2_nbinom_dh   (the frozen baseline)
//     tennis_atp*             atp_match_v1
//     tennis_wta*             wta_match_v1
//     mma_mixed_martial_arts  ufc_fight_v1
//     americanfootball_nfl*   nfl_game_v1
//     basketball_wnba         wnba_game_v1
//
// MODES
//     ?dry=1            run everything, write nothing. Deployment validation.
//     ?sport=<key>      one sport only. Accepts a registry key, a captured
//                       sport_key, or the UI label (MLB/ATP/WTA/MMA/NFL/WNBA).
//     ?seed=12345       deterministic simulation, for reproducible tests.
//     ?registry=1       publish the model registry and every data contract.
//     ?calibrate=1      fit tour/sport parameters on owned history and store
//                       them. Requires ?sport=. Never runs implicitly.
//
// THE CLV BASELINE IS SACRED. The first prediction for
// (model_version, event_id, market, selection) is the entry snapshot, and
// re-running this function must never overwrite it. That is enforced by the
// unique index plus `Prefer: resolution=ignore-duplicates` in core/db.ts.
// Removing either destroys EdgeDesk's ability to measure CLV, calibration or
// ROI after the fact.
//
// DEPLOY
//     supabase functions deploy model_predict --no-verify-jwt
//     then: curl "$URL/functions/v1/model_predict?dry=1"
// ============================================================================

import { env, inList, makeDb, pmap } from "./core/db.ts";
import { makeRng } from "./core/rng.ts";
import { describe, MODEL_REGISTRY, REGISTERED_SPORTS, resolveFilter } from "./core/registry.ts";
import { runAll } from "./core/runner.ts";
import { calibrate } from "./core/calibrate.ts";
import type { ModelDeps } from "./core/types.ts";

const SB_URL = env("SUPABASE_URL");
const SB_SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");
const CRON_SECRET = env("CRON_SECRET");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

(globalThis as any).Deno?.serve?.(async (req: Request): Promise<Response> => {
  const started = Date.now();
  try {
    const url = new URL(req.url);
    const q = url.searchParams;
    const dry = q.get("dry") === "1";
    const wantRegistry = q.get("registry") === "1";
    const wantCalibrate = q.get("calibrate") === "1";
    const sportArg = q.get("sport");
    const seedArg = q.get("seed");

    if (wantRegistry) {
      return json({ ok: true, registry: describe() });
    }

    /* Anything that WRITES is gated. A dry run is read-only and stays open so
       deployment validation does not need the secret. */
    if ((!dry || wantCalibrate) && CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    if (!SB_URL || !SB_SERVICE) {
      return json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" }, 500);
    }

    const db = makeDb({ url: SB_URL, serviceKey: SB_SERVICE });
    const now = new Date();
    const etDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);

    const seed = seedArg != null && seedArg !== "" ? Number(seedArg) : undefined;
    if (seedArg != null && seedArg !== "" && !Number.isFinite(seed)) {
      return json({ ok: false, error: `seed is not a number: ${seedArg}` }, 400);
    }
    const rng = makeRng(seed);

    const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    const deps: ModelDeps = {
      sbGet: db.sbGet,
      sbGetSchema: db.sbGetSchema,
      jget: db.jget,
      rng,
      etDate,
      now,
      pmap,
      log: (msg, extra) => {
        if (logs.length < 200) logs.push({ msg, extra });
      },
    };

    // ---- resolve the sport filter -----------------------------------------
    let filterKey: string | null = null;
    if (sportArg) {
      const m = resolveFilter(sportArg);
      if (!m) {
        return json({
          ok: false,
          error: `unknown sport: ${sportArg}`,
          known: REGISTERED_SPORTS.map((k) => ({ key: k, label: MODEL_REGISTRY[k].uiLabel })),
        }, 400);
      }
      filterKey = REGISTERED_SPORTS.find((k) => MODEL_REGISTRY[k] === m) ?? null;
    }

    // ---- calibration -------------------------------------------------------
    if (wantCalibrate) {
      if (!filterKey) {
        return json({ ok: false, error: "?calibrate=1 requires ?sport=<key>. Calibration is per model, never implicit." }, 400);
      }
      const res = await calibrate(deps, filterKey, MODEL_REGISTRY[filterKey], { dry, upsert: db.upsert });
      return json({ dry, sport: filterKey, ...res }, res.ok ? 200 : 422);
    }

    // ---- the run -----------------------------------------------------------
    const out = await runAll(deps, { dry, sportFilter: filterKey, upsert: db.upsertPredictions });

    const modelVersions = Object.keys(out.sports).map((k) => out.sports[k].model_version);
    const dataQuality: Record<string, unknown> = {};
    for (const k of Object.keys(out.sports)) dataQuality[k] = out.sports[k].data_quality;

    return json({
      ok: true,
      dry,
      seed: rng.seed,
      et_date: etDate,
      elapsed_ms: Date.now() - started,
      model_versions: modelVersions,
      sports: out.sports,
      games_scheduled: out.scheduled,
      predicted_games: out.predicted,
      rows_built: out.rowsBuilt,
      rows_written: dry ? 0 : out.rowsWritten,
      skipped: Object.keys(out.sports).flatMap((k) =>
        out.sports[k].skipped.slice(0, 25).map((s) => ({ sport: k, ...s }))
      ),
      errors: out.errors,
      data_quality: dataQuality,
      samples: out.samples.slice(0, 12),
      logs: logs.slice(0, 40),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

// Re-exported so a consumer (or a test) can reach the pieces without booting
// the HTTP handler.
export { describe, inList, makeDb, makeRng, MODEL_REGISTRY, runAll };
