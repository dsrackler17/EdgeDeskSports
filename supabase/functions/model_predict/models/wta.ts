// ============================================================================
// EdgeDesk : model_predict / models / wta   —   wta_match_v1
//
// WTA match winner. NOT ATP with a different sport key.
//
// It shares the engine — the same Elo mechanics, the same closed-form scoring
// model, the same feature definitions — because the mechanics are the same
// game. What it does not share is a single number. Ratings are built from
// tennis.matches WHERE tour = 'WTA' and nothing else; the rank -> rating prior
// is fitted on WTA's own ranked players; the fitted feature weights live under
// model_version = 'wta_match_v1' in model_parameters and are never read from
// the ATP row; and calibration is run and evaluated separately.
//
// WHY THE STARTING VALUES MATCH ATP'S, AND WHY THAT IS NOT A CLONE. The
// published tennis-Elo schedule is the honest prior for any tour before its own
// history has been fitted. Shipping a different K here — 220 instead of 250,
// say — would look like an independently estimated WTA parameter while actually
// being a number chosen to look independent. The tour-specific values come from
// `?calibrate=1&sport=tennis_wta`, which grid-searches this tour's own results
// and reports the holdout log loss that picked them. Until that has been run
// the telemetry says `published_default` for both tours, which is the truth.
//
// What IS already tour-specific from the first run: every rating, the rank
// prior, the surface blend sample counts, and the reported calibration. WTA
// match-to-match variance is higher, so the same rating gap earns a smaller
// realised edge — that shows up in the graded record, not in a fudge factor
// applied here (spec §29).
// ============================================================================

import { envNum } from "../core/db.ts";
import { makeTennisModel, type TourParams } from "./tennis_engine.ts";

export const WTA_MODEL_VERSION = "wta_match_v1";

export const WTA_PARAMS: TourParams = {
  tour: "WTA",
  modelVersion: WTA_MODEL_VERSION,
  uiLabel: "WTA",
  sportKey: "tennis_wta",
  sportKeyPrefixes: ["tennis_wta"],
  elo: {
    initial: envNum("WTA_ELO_INITIAL", 1500),
    kFactor: envNum("WTA_ELO_K", 250),
    kShift: envNum("WTA_ELO_K_SHIFT", 5),
    kDecay: envNum("WTA_ELO_K_DECAY", 0.4),
    scale: envNum("WTA_ELO_SCALE", 400),
  },
  surfaceMaxWeight: envNum("WTA_SURFACE_WEIGHT", 0.5),
  surfaceFullAt: envNum("WTA_SURFACE_FULL_AT", 30),
  minMatches: envNum("WTA_MIN_MATCHES", 20),
  historyYears: envNum("WTA_HISTORY_YEARS", 8),
};

export const WTAModel = makeTennisModel(WTA_PARAMS);
