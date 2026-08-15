// ============================================================================
// EdgeDesk : model_predict / core / registry
//
// One place that knows which model owns which sport. The frontend's sport
// taxonomy and the backend's must not be allowed to drift, so the labels here
// are the labels app.html already uses — evSportLabel() maps tennis_atp_* to
// "ATP", americanfootball_nfl* to "NFL", and prettySport() maps
// mma_mixed_martial_arts to "MMA" — and `describe()` publishes the whole thing
// so the UI can read it instead of hardcoding a second copy.
//
// ROUTING IS BY PREFIX, NOT BY EQUALITY. The Odds API names tennis per event
// (tennis_atp_wimbledon, tennis_wta_cincinnati) and football per phase
// (americanfootball_nfl_preseason). Matching on equality would silently drop
// every tennis event and every preseason game.
// ============================================================================

import type { SportPredictionModel } from "./types.ts";
import { MLBModel } from "../models/mlb.ts";
import { ATPModel } from "../models/atp.ts";
import { WTAModel } from "../models/wta.ts";
import { UFCModel } from "../models/ufc.ts";
import { NFLModel } from "../models/nfl.ts";
import { WNBAModel } from "../models/wnba.ts";

export const MODEL_REGISTRY: Record<string, SportPredictionModel> = {
  baseball_mlb: MLBModel,
  tennis_atp: ATPModel,
  tennis_wta: WTAModel,
  mma_mixed_martial_arts: UFCModel,
  americanfootball_nfl: NFLModel,
  basketball_wnba: WNBAModel,
};

export const REGISTERED_SPORTS = Object.keys(MODEL_REGISTRY);

/**
 * Which model owns a captured sport_key.
 *
 * Longest prefix wins, so a future `tennis_atp_challenger` model could be
 * registered alongside `tennis_atp` without the generic one shadowing it.
 */
export function resolveModel(sportKey: string): SportPredictionModel | null {
  const k = String(sportKey || "").toLowerCase();
  if (!k) return null;
  let best: SportPredictionModel | null = null;
  let bestLen = -1;
  for (const key of REGISTERED_SPORTS) {
    const m = MODEL_REGISTRY[key];
    for (const p of m.sportKeyPrefixes) {
      if (k.indexOf(p) === 0 && p.length > bestLen) {
        best = m;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** The UI label EdgeDesk already shows for a captured sport_key. */
export function uiLabelFor(sportKey: string): string | null {
  return resolveModel(sportKey)?.uiLabel ?? null;
}

/** Resolve a `?sport=` filter. Accepts a registry key, any captured sport_key,
 *  or the UI label (MLB / ATP / WTA / MMA / NFL / WNBA), case-insensitively. */
export function resolveFilter(arg: string): SportPredictionModel | null {
  const raw = String(arg || "").trim();
  if (!raw) return null;
  const direct = MODEL_REGISTRY[raw.toLowerCase()];
  if (direct) return direct;
  const byPrefix = resolveModel(raw);
  if (byPrefix) return byPrefix;
  const label = raw.toUpperCase();
  for (const key of REGISTERED_SPORTS) {
    if (MODEL_REGISTRY[key].uiLabel.toUpperCase() === label) return MODEL_REGISTRY[key];
  }
  return null;
}

/** Machine-readable description of the whole layer. Served from `?registry=1`
 *  so the frontend can render the sport selector and the per-sport "what does
 *  this model need" panel without a second hardcoded list. */
export function describe() {
  return REGISTERED_SPORTS.map((key) => {
    const m = MODEL_REGISTRY[key];
    return {
      sport_key: key,
      sport_key_prefixes: m.sportKeyPrefixes,
      ui_label: m.uiLabel,
      model_version: m.modelVersion,
      supported_markets: m.supportedMarkets,
      required_data: m.dataContract.filter((c) => c.critical).map((c) => c.source),
      data_contract: m.dataContract,
    };
  });
}
