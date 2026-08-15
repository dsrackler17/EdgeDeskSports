// ============================================================================
// EdgeDesk : model_predict / models / atp   —   atp_match_v1
//
// ATP match winner. Surface-blended Elo over tennis.matches (tour=ATP), with
// ranking, fatigue, form and head-to-head computed on every row and applied
// only through coefficients fitted on ATP results.
//
// PARAMETERS ARE ATP'S OWN. This file and models/wta.ts share the engine and
// nothing else — separate literals, separate env overrides, separate rows in
// model_parameters, separate calibration runs. Editing a number here cannot
// move the WTA model.
//
// The starting values are FiveThirtyEight's published tennis-Elo schedule
// (K = 250/(m+5)^0.4, surface weight 0.5). They are a PRIOR, not a claim: the
// telemetry reports `parameters: published_default` until `?calibrate=1` has
// fitted them on ATP's own history, at which point it reports `calibrated`
// along with the holdout Brier and log loss that justified them.
// ============================================================================

import { envNum } from "../core/db.ts";
import { makeTennisModel, type TourParams } from "./tennis_engine.ts";

export const ATP_MODEL_VERSION = "atp_match_v1";

export const ATP_PARAMS: TourParams = {
  tour: "ATP",
  modelVersion: ATP_MODEL_VERSION,
  uiLabel: "ATP",
  sportKey: "tennis_atp",
  /* The Odds API names tennis by EVENT — tennis_atp_wimbledon,
     tennis_atp_cincinnati_open — so routing is by PREFIX. The app's own
     evSportLabel() collapses the same way. */
  sportKeyPrefixes: ["tennis_atp"],
  elo: {
    initial: envNum("ATP_ELO_INITIAL", 1500),
    kFactor: envNum("ATP_ELO_K", 250),
    kShift: envNum("ATP_ELO_K_SHIFT", 5),
    kDecay: envNum("ATP_ELO_K_DECAY", 0.4),
    scale: envNum("ATP_ELO_SCALE", 400),
  },
  surfaceMaxWeight: envNum("ATP_SURFACE_WEIGHT", 0.5),
  surfaceFullAt: envNum("ATP_SURFACE_FULL_AT", 30),
  minMatches: envNum("ATP_MIN_MATCHES", 20),
  historyYears: envNum("ATP_HISTORY_YEARS", 8),
};

export const ATPModel = makeTennisModel(ATP_PARAMS);
