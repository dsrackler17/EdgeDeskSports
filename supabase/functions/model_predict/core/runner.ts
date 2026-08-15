// ============================================================================
// EdgeDesk : model_predict / core / runner
//
// The shared pipeline. Every sport goes through exactly these steps and no
// sport is allowed its own path through them:
//
//     signals read -> market index -> context load -> event assembly
//         -> validate -> predict -> row build -> dedupe -> write -> telemetry
//
// A failure inside one sport is contained to that sport. A bad tennis schema
// must not cost the MLB slate its predictions, so each model runs inside its
// own try and reports `status: error` with its message while the others carry
// on. The response is the audit record for the run: what was scheduled, what
// was predicted, what was skipped and why, and which captured events nobody
// claimed.
// ============================================================================

import type {
  MarketEvent,
  ModelContext,
  PredictionRow,
  SignalRow,
  SkipEntry,
  SportPredictionModel,
  SportTelemetry,
} from "./types.ts";
import { buildRow, dedupeRows } from "./validate.ts";
import { buildMarketIndex, eventsInStartOrder, SIGNAL_SELECT } from "./market.ts";
import { MODEL_REGISTRY, REGISTERED_SPORTS } from "./registry.ts";
import { envNum } from "./db.ts";
import type { ModelDeps } from "./types.ts";

/**
 * How far ahead of `now` each sport's captured market is read.
 *
 * MLB keeps v1.2's window exactly (-3h to +30h) because that window is part of
 * the frozen baseline. The others are set to the cadence of the sport: a
 * weekly league needs days of horizon or the slate is invisible, a daily one
 * does not.
 */
export function windowFor(registryKey: string): { backHours: number; aheadHours: number } {
  switch (registryKey) {
    case "baseball_mlb":
      return { backHours: envNum("MODEL_WINDOW_BACK_H", 3), aheadHours: envNum("MLB_WINDOW_AHEAD_H", 30) };
    case "americanfootball_nfl":
      return { backHours: envNum("MODEL_WINDOW_BACK_H", 3), aheadHours: envNum("NFL_WINDOW_AHEAD_H", 192) };
    case "mma_mixed_martial_arts":
      return { backHours: envNum("MODEL_WINDOW_BACK_H", 3), aheadHours: envNum("UFC_WINDOW_AHEAD_H", 192) };
    case "tennis_atp":
    case "tennis_wta":
      return { backHours: envNum("MODEL_WINDOW_BACK_H", 3), aheadHours: envNum("TENNIS_WINDOW_AHEAD_H", 48) };
    case "basketball_wnba":
      return { backHours: envNum("MODEL_WINDOW_BACK_H", 3), aheadHours: envNum("WNBA_WINDOW_AHEAD_H", 36) };
    default:
      return { backHours: 3, aheadHours: 36 };
  }
}

async function readSignals(
  deps: ModelDeps,
  model: SportPredictionModel,
  registryKey: string,
): Promise<SignalRow[]> {
  const w = windowFor(registryKey);
  const lo = new Date(deps.now.getTime() - w.backHours * 3600e3).toISOString();
  const hi = new Date(deps.now.getTime() + w.aheadHours * 3600e3).toISOString();
  const out: SignalRow[] = [];
  const seen = new Set<string>();
  for (const prefix of model.sportKeyPrefixes) {
    /* `like.<prefix>*` catches tennis_atp_wimbledon and
       americanfootball_nfl_preseason alongside the bare key. */
    const filter = `sport_key=like.${encodeURIComponent(prefix)}*`;
    const PAGE = 1000;
    for (let p = 0; p < 8; p++) {
      const rows = await deps.sbGet(
        `signals?select=${SIGNAL_SELECT}&${filter}&commence_time=gte.${lo}&commence_time=lte.${hi}` +
        `&order=commence_time.asc,event_id.asc&limit=${PAGE}&offset=${p * PAGE}`,
      );
      if (!rows || !rows.length) break;
      for (const r of rows) {
        const k = `${r.event_id}|${r.market}|${r.selection}|${r.point}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r as SignalRow);
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

export interface SportRunResult {
  telemetry: SportTelemetry;
  rows: PredictionRow[];
  samples: PredictionRow[];
}

export async function runSport(
  deps: ModelDeps,
  registryKey: string,
  model: SportPredictionModel,
): Promise<SportRunResult> {
  const telemetry: SportTelemetry = {
    model_version: model.modelVersion,
    ui_label: model.uiLabel,
    status: "ok",
    scheduled: 0,
    eligible: 0,
    predicted: 0,
    skipped: [],
    rows_built: 0,
    rows_written: 0,
    market_events: 0,
    matched_events: 0,
    unmatched_events: [],
    data_quality: { status: "ok" },
  };

  const marketRows = await readSignals(deps, model, registryKey);
  /* Indexed once here purely to count and to report unclaimed events. Each
     model rebuilds its own index inside buildEvents() from the same rows, so
     the claim state the telemetry reads is the model's, not a copy. */
  const marketEvents = eventsInStartOrder(buildMarketIndex(marketRows));
  telemetry.market_events = marketEvents.length;

  const ctx: ModelContext = await model.loadContext(deps, marketRows);
  telemetry.data_quality = {
    status: ctx.status,
    missing: ctx.missing,
    detail: ctx.detail,
    data_as_of: ctx.dataAsOf ?? null,
    feature_snapshot_id: ctx.featureSnapshotId,
    contract: model.dataContract,
  };

  if (ctx.status !== "ok") {
    telemetry.status = ctx.status;
    /* An unusable context is not an excuse to say nothing about the slate. Every
       captured event is still reported as skipped, with the reason, so the run
       shows what would have been predicted had the data been there. */
    telemetry.scheduled = marketEvents.length;
    telemetry.skipped = marketEvents.slice(0, 50).map((e) => ({
      event_id: e.event_id,
      label: `${e.away_team} @ ${e.home_team}`,
      reason: "model_context_failed" as const,
      detail: ctx.detail,
    }));
    telemetry.unmatched_events = marketEvents.slice(0, 10).map((e) => ({
      event_id: e.event_id,
      game: `${e.away_team} @ ${e.home_team}`,
      commence_time: e.commence_time,
    }));
    if (model.telemetryExtra) telemetry.extra = model.telemetryExtra([], ctx);
    return { telemetry, rows: [], samples: [] };
  }

  const assembled = await model.buildEvents(deps, marketRows, ctx);
  telemetry.scheduled = assembled.scheduled;
  telemetry.skipped.push(...assembled.skipped);
  telemetry.eligible = assembled.events.length;

  const rows: PredictionRow[] = [];
  for (const { event, market } of assembled.events) {
    const v = model.validateContext(event, ctx);
    if (!v.ok) {
      telemetry.skipped.push({
        event_id: event.event_id,
        label: `${event.away_team} @ ${event.home_team}`,
        reason: v.reason ?? "model_context_failed",
        detail: v.detail,
      });
      continue;
    }

    let preds;
    try {
      preds = await model.predict(event, market, ctx, deps);
    } catch (e) {
      telemetry.skipped.push({
        event_id: event.event_id,
        label: `${event.away_team} @ ${event.home_team}`,
        reason: "model_context_failed",
        detail: "predict threw: " + String((e as Error)?.message ?? e),
      });
      continue;
    }

    let built = 0;
    for (const p of preds) {
      if (!model.supportsMarket(p.market, p.selection)) {
        telemetry.skipped.push({
          event_id: event.event_id,
          label: `${event.away_team} @ ${event.home_team} · ${p.market}`,
          reason: "unsupported_market",
          detail: `unsupported_by_model: ${model.modelVersion} does not model ${p.market}`,
        });
        continue;
      }
      const r = buildRow(model.modelVersion, event, market.event, p, {
        dataAsOf: ctx.dataAsOf ?? null,
        featureSnapshotId: ctx.featureSnapshotId ?? null,
      });
      if (!r.ok || !r.row) {
        telemetry.skipped.push({
          event_id: event.event_id,
          label: `${event.away_team} @ ${event.home_team} · ${p.market} ${p.selection}`,
          reason: (r.reason as SkipEntry["reason"]) ?? "invalid_probability",
          detail: r.detail,
        });
        continue;
      }
      rows.push(r.row);
      built++;
    }
    if (built > 0) telemetry.predicted++;
  }

  const { kept, dropped } = dedupeRows(rows);
  for (const dRow of dropped) {
    telemetry.skipped.push({
      event_id: dRow.event_id,
      label: `${dRow.away_team} @ ${dRow.home_team} · ${dRow.market} ${dRow.selection}`,
      reason: "duplicate_event",
      detail: "a second row for the same (model_version, event_id, market, selection) was produced in one run",
    });
  }

  telemetry.rows_built = kept.length;
  const predictedIds = new Set(kept.map((r) => r.event_id));
  telemetry.matched_events = predictedIds.size;
  /* A captured event that produced no row. This is the line that makes a future
     join break visible IN THE RUN rather than three weeks later in the record —
     it is how the doubleheader bug would have been caught on day one. */
  telemetry.unmatched_events = marketEvents
    .filter((e) => !predictedIds.has(e.event_id))
    .slice(0, 10)
    .map((e) => ({ event_id: e.event_id, game: `${e.away_team} @ ${e.home_team}`, commence_time: e.commence_time }));

  if (model.telemetryExtra) telemetry.extra = model.telemetryExtra(kept, ctx);

  return { telemetry, rows: kept, samples: kept.slice(0, 3) };
}

export interface RunOptions {
  dry: boolean;
  sportFilter?: string | null;
  upsert: (rows: unknown[]) => Promise<number>;
}

export async function runAll(deps: ModelDeps, opts: RunOptions) {
  const keys = REGISTERED_SPORTS.filter((k) => {
    if (!opts.sportFilter) return true;
    return k === opts.sportFilter;
  });

  const sports: Record<string, SportTelemetry> = {};
  const errors: Array<{ sport: string; error: string }> = [];
  const samples: PredictionRow[] = [];
  let rowsBuilt = 0, rowsWritten = 0, scheduled = 0, predicted = 0;

  for (const key of keys) {
    const model = MODEL_REGISTRY[key];
    try {
      const res = await runSport(deps, key, model);
      if (!opts.dry && res.rows.length) {
        res.telemetry.rows_written = await opts.upsert(res.rows);
      }
      sports[key] = res.telemetry;
      rowsBuilt += res.telemetry.rows_built;
      rowsWritten += res.telemetry.rows_written;
      scheduled += res.telemetry.scheduled;
      predicted += res.telemetry.predicted;
      samples.push(...res.samples);
    } catch (e) {
      /* One sport's data problem is isolated here. It is reported, not swallowed,
         and the remaining sports still run. */
      const msg = String((e as Error)?.message ?? e);
      errors.push({ sport: key, error: msg });
      sports[key] = {
        model_version: model.modelVersion,
        ui_label: model.uiLabel,
        status: "error",
        scheduled: 0, eligible: 0, predicted: 0, skipped: [],
        rows_built: 0, rows_written: 0,
        market_events: 0, matched_events: 0, unmatched_events: [],
        data_quality: { status: "error", detail: msg, contract: model.dataContract },
        error: msg,
      };
      deps.log("sport run failed", { sport: key, error: msg });
    }
  }

  return { sports, errors, samples, rowsBuilt, rowsWritten, scheduled, predicted };
}
