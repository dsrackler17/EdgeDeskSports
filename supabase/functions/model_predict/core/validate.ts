// ============================================================================
// EdgeDesk : model_predict / core / validate
//
// The only place a database row is built, and the only place a probability is
// allowed to become one. A model returns a number; this decides whether that
// number is allowed to enter the historical record.
//
// A missing prediction is vastly preferable to a fake 57.3% contaminating the
// record, so every check here fails CLOSED and reports why.
// ============================================================================

import type {
  ContextQuality,
  EventContext,
  MarketEvent,
  ModelPrediction,
  PredictionRow,
  SignalRow,
} from "./types.ts";
import { decToAm, expectedValue, probabilityGap, toAm } from "./odds.ts";
import { matchKey, nrm } from "./names.ts";

export interface RowBuildResult {
  ok: boolean;
  row?: PredictionRow;
  reason?: string;
  detail?: string;
}

/**
 * Find the captured signals row this prediction is being scored against.
 *
 * Returns undefined when the market was not captured for this selection, which
 * is a legitimate outcome: the model still has an opinion, and the snapshot
 * columns are written null rather than filled with a neighbouring price.
 */
export function snapshotFor(
  ev: MarketEvent,
  market: string,
  selection: string,
  point: number | null,
): SignalRow | undefined {
  if (market === "h2h") {
    if (matchKey(selection) === matchKey(ev.home_team)) return ev.h2hHome;
    if (matchKey(selection) === matchKey(ev.away_team)) return ev.h2hAway;
    return undefined;
  }
  if (market === "totals") {
    const mt = ev.mainTotal;
    if (!mt || mt.point == null || point == null || +mt.point !== +point) return undefined;
    const s = nrm(selection);
    if (s.indexOf("over") >= 0) return mt.over;
    if (s.indexOf("under") >= 0) return mt.under;
    return undefined;
  }
  if (market === "spreads") {
    const ms = ev.mainSpread;
    if (!ms || ms.point == null || point == null) return undefined;
    if (Math.abs(Math.abs(+ms.point) - Math.abs(+point)) > 1e-9) return undefined;
    if (matchKey(selection) === matchKey(ev.home_team)) return ms.home;
    if (matchKey(selection) === matchKey(ev.away_team)) return ms.away;
    return undefined;
  }
  return undefined;
}

/**
 * Build one model_predictions row, or refuse.
 *
 * PRODUCTION SAFETY (spec §30). A row is written only when the probability is a
 * finite number strictly inside (0,1), the event carries an id, the model
 * carries a version, and any market line attached to the selection is a finite
 * number. NaN, ±Infinity, 0, 1 and negative probabilities are all rejected with
 * an explicit reason rather than clamped into something plausible.
 */
export function buildRow(
  modelVersion: string,
  event: EventContext,
  marketEvent: MarketEvent,
  pred: ModelPrediction,
  meta: { dataAsOf: string | null; featureSnapshotId: string | null },
): RowBuildResult {
  if (!modelVersion) return { ok: false, reason: "invalid_probability", detail: "model version missing" };
  if (!event.event_id) return { ok: false, reason: "invalid_probability", detail: "event_id missing" };

  const p = pred.model_prob;
  if (typeof p !== "number" || !Number.isFinite(p)) {
    return { ok: false, reason: "invalid_probability", detail: `model_prob is ${String(p)}` };
  }
  if (!(p > 0 && p < 1)) {
    return { ok: false, reason: "invalid_probability", detail: `model_prob out of range: ${p}` };
  }
  if (!pred.market || !pred.selection) {
    return { ok: false, reason: "invalid_probability", detail: "market or selection missing" };
  }
  if (pred.point != null && !Number.isFinite(+pred.point)) {
    return { ok: false, reason: "invalid_market_line", detail: `point is ${String(pred.point)}` };
  }
  // A totals or spreads prediction without a line is not a prediction about
  // anything — the selection alone ("Over") names no market.
  if ((pred.market === "totals" || pred.market === "spreads") && pred.point == null) {
    return { ok: false, reason: "invalid_market_line", detail: `${pred.market} row has no point` };
  }

  const point = pred.point != null ? +pred.point : null;
  const sig = snapshotFor(marketEvent, pred.market, pred.selection, point);
  const mkt = sig && sig.sharp_fair != null && Number.isFinite(+sig.sharp_fair) ? +sig.sharp_fair : null;
  const bestDec = sig && sig.best_dec != null && +sig.best_dec > 1 ? +sig.best_dec : null;

  const gap = probabilityGap(p, mkt);
  const ev = expectedValue(p, bestDec);

  const row: PredictionRow = {
    model_version: modelVersion,
    sport_key: event.sport_key,
    event_id: event.event_id,
    commence_time: event.commence_time,
    home_team: event.home_team,
    away_team: event.away_team,
    market: pred.market,
    selection: pred.selection,
    point,
    model_prob: +p.toFixed(4),
    model_fair_american: toAm(p),
    market_prob_at_pred: mkt != null ? +mkt.toFixed(4) : null,
    market_am_at_pred: mkt != null ? toAm(mkt) : null,
    best_am_at_pred: bestDec != null ? decToAm(bestDec) : null,
    // PROBABILITY GAP, not expected value. The two live in different columns on
    // purpose and must never be relabelled into each other (spec §13).
    model_edge: gap != null ? +gap.toFixed(4) : null,
    model_ev: ev != null ? +ev.toFixed(4) : null,
    context_quality: pred.context_quality,
    missing_features: pred.missing_features ?? [],
    data_as_of: meta.dataAsOf,
    feature_snapshot_id: meta.featureSnapshotId,
    model_detail: pred.detail ?? null,
  };
  /* Legacy columns are merged LAST but must never shadow a real one, so a
     model cannot quietly rewrite model_prob through this door. */
  if (pred.legacyColumns) {
    for (const k of Object.keys(pred.legacyColumns)) {
      if (!(k in row)) (row as unknown as Record<string, unknown>)[k] = pred.legacyColumns[k];
    }
  }
  return { ok: true, row };
}

/** Downgrade the quality label as critical inputs go missing. Metadata only —
 *  it never touches model_prob (spec §29). */
export function qualityFrom(missingCritical: number, missingTotal: number): ContextQuality {
  if (missingCritical > 0) return "LOW";
  if (missingTotal > 2) return "MEDIUM";
  return missingTotal > 0 ? "MEDIUM" : "HIGH";
}

/**
 * Reject duplicate (model_version, event_id, market, selection) inside a single
 * run before it reaches Postgres.
 *
 * The unique index and ignore-duplicates already protect the stored snapshot,
 * but they do it SILENTLY — which is exactly how the doubleheader bug hid. A
 * duplicate produced inside one run is a modelling error, so it is caught here
 * where it can be reported.
 */
export function dedupeRows(rows: PredictionRow[]): { kept: PredictionRow[]; dropped: PredictionRow[] } {
  const seen = new Set<string>();
  const kept: PredictionRow[] = [];
  const dropped: PredictionRow[] = [];
  for (const r of rows) {
    const k = `${r.model_version}|${r.event_id}|${r.market}|${r.selection}`;
    if (seen.has(k)) dropped.push(r);
    else {
      seen.add(k);
      kept.push(r);
    }
  }
  return { kept, dropped };
}
