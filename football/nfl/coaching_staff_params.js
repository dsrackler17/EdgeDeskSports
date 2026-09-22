if(typeof window==='undefined'){globalThis.window=globalThis;}
/* GENERATED NFL Coaching / Staff parameters.
   This initial document is intentionally NOT_EVALUATED. The historical
   walk-forward replaces it only after fitting the hyperparameters and seeds.
   Missing fitted values are null, never hand-entered defaults. */
window.EDNFLCoachingStaffParams = {
  "schema": "edgedesk_nfl_coaching_staff_params_v1",
  "generated_at": null,
  "config": {
    "enabled": false,
    "affects_model": false,
    "alpha": null,
    "shrink_k": null,
    "season_carry": null,
    "evidence_carry": null,
    "max_point_adjustment": null,
    "effect_sd": null,
    "trained_through_season": null,
    "validation_status": "NOT_EVALUATED",
    "source": "nflverse games.csv home_coach/away_coach + EdgeDesk pregame base-model residual; historical fit not run yet",
    "version": "nfl_coaching_staff_v1"
  },
  "seeds": {},
  "validation": {
    "status": "NOT_EVALUATED",
    "affects_model": false,
    "reason": "NFL Coaching / Staff walk-forward has not yet published a fitted result."
  }
};
if(typeof module!=='undefined'&&module.exports)module.exports=window.EDNFLCoachingStaffParams;
