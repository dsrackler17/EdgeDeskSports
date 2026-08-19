# API RESPONSE SHAPES (binding for edge functions, frontend, and embed)

Concrete JSON contracts. Field names here are final. Frontend renders exactly these; functions return exactly these. Nullable means the key is present with null, never absent. All timestamps ISO 8601 UTC strings. All money integer cents.

Testing hook (all pages and embed): the API base can be overridden with `?api=<base>` query param or `localStorage.COLLECTIVE_API_OVERRIDE`; `collective/embed.js` also accepts `data-api="<base>"`. Production default is `COLLECTIVE_CONFIG.API`.

## GET /v1/meta  (free)
```json
{
  "name": "Model Collective",
  "pricing": { "monthly_cents": 2000, "annual_cents": 20000, "currency": "usd" },
  "billing_live": false,
  "sports": [ { "code": "NFL", "name": "Football", "season": 2026, "in_season": true } ],
  "counts": { "creators": 3, "models": 4, "graded_games": 120, "live_projections": 260 },
  "urls": { "site": "https://edgedesksports.com/collective/", "join_info": "https://edgedesksports.com/collective/#about", "rules": "https://edgedesksports.com/collective/#rules" }
}
```

## GET /v1/wall  (free)
```json
{ "generated_at": "…", "rows": [ {
  "creator_slug": "moose", "creator_name": "Must Be Moose", "logo_url": null, "monogram": "MM",
  "founding": true, "membership": "ACTIVE CONTRIBUTOR",
  "model_slug": "nfl-model", "model_name": "NFL Model", "sport": "NFL",
  "record": { "graded": 24, "wins": 14, "losses": 9, "pushes": 1, "win_pct": 0.609,
              "margin_mae": 9.8, "brier": 0.231 },
  "coverage_pct": 87.5, "last_submission_at": "…",
  "website_url": "https://…", "x_handle": "mustbemoose"
} ] }
```
`record` is null for a model with zero graded games. `membership` is one of `ACTIVE CONTRIBUTOR`, `MEMBER`, `INACTIVE`.

## GET /v1/creators/{slug}  (free)
```json
{ "creator": { "slug": "moose", "display_name": "…", "description": null, "website_url": null,
  "x_handle": null, "logo_url": null, "monogram": "MM", "founding": true, "membership": "MEMBER",
  "joined_at": "…", "pinned_model_slug": null },
  "models": [ { "model_slug": "nfl-model", "model_name": "NFL Model", "sport": "NFL",
    "record": { …same as wall… }, "coverage_pct": 87.5, "last_submission_at": null,
    "backfill": { "rows": 569, "note": "Backfilled history, shown separately, never ranked" } } ],
  "empty_state": false }
```
`empty_state` true when the creator has zero live submissions; the profile still renders fully (Section 6 rule) and the UI shows the pending line.

## GET /v1/models/{creator}/{model}  (free)
```json
{ "creator": { "slug": "…", "display_name": "…" },
  "model": { "model_slug": "…", "model_name": "…", "sport": "NFL", "description": null },
  "record": { … }, "coverage": [ { "season": 2026, "week": 1, "games_available": 16, "games_submitted": 14 } ],
  "coverage_pct": 87.5,
  "recent_graded": [ { "game_id": "…", "label": "BUF @ KC", "kickoff_at": "…", "week": 3,
     "pick_side": "home", "closing_spread": -2.5, "final": "27-24",
     "pick_result": "win", "margin_error": 3.0, "brier": 0.152, "movement_n": 2 } ] }
```

## GET /v1/rankings  (free)
```json
{ "rules_version": 1,
  "thresholds": { "min_coverage_pct": 60, "min_graded_games": 20 },
  "boards": {
    "win_pct":    [ { "rank": 1, "creator_slug": "…", "creator_name": "…", "model_slug": "…", "model_name": "…", "sport": "NFL", "value": 0.609, "graded": 24, "coverage_pct": 87.5 } ],
    "margin_mae": [ { "rank": 1, "…": "…", "value": 9.8 } ],
    "brier":      [ { "rank": 1, "…": "…", "value": 0.231 } ]
  },
  "unranked": [ { "creator_slug": "…", "model_slug": "…", "model_name": "…", "reason": "coverage 40% is below the 60% minimum" } ] }
```

## GET /v1/games?sport=NFL&season=2026&week=3  (free for settled, locked rows for upcoming when not entitled)
```json
{ "sport": "NFL", "season": 2026, "week": 3, "entitled": false,
  "games": [ {
    "game_id": "…", "label": "BUF @ KC", "home": "KC", "away": "BUF",
    "kickoff_at": "…", "status": "scheduled",
    "result": null,
    "consensus": { "locked": true },
    "models": [ { "creator_slug": "…", "model_slug": "…", "locked": true } ]
  }, {
    "game_id": "…", "label": "NYG @ DAL", "home": "DAL", "away": "NYG",
    "kickoff_at": "…", "status": "final",
    "result": { "home_score": 27, "away_score": 20, "closing_spread": -4.5, "closing_total": 47.5 },
    "consensus": { "locked": false, "n": 3, "spread_mean": -5.2, "spread_median": -5.0, "spread_stdev": 1.1,
                   "spread_min": -6.5, "spread_max": -4.0, "total_mean": 48.1, "home_win_prob_mean": 0.66,
                   "pct_picks_home": 0.67, "agreement": 0.67 },
    "models": [ { "creator_slug": "…", "model_slug": "…", "locked": false, "late": false,
      "pick_side": "home", "projected_spread": -6.0, "projected_total": 48.5,
      "home_win_probability": 0.68, "received_at": "…",
      "grade": { "pick_result": "win", "margin_error": 1.0, "brier": 0.102 } } ]
  } ] }
```
Locked rows carry no numeric keys at all. When `entitled` is true (subscriber or creator JWT), upcoming rows carry the numbers and `locked: false`.

## GET /v1/consensus?sport=NFL&season=2026&week=3  (paid for upcoming; settled free)
```json
{ "entitled": true, "rows": [ { "game_id": "…", "label": "…", "kickoff_at": "…", "status": "scheduled",
   "n": 3, "spread_mean": -5.2, "spread_median": -5.0, "spread_stdev": 1.1, "spread_min": -6.5, "spread_max": -4.0,
   "total_mean": 48.1, "total_median": 48.0, "home_win_prob_mean": 0.66, "pct_picks_home": 0.67, "agreement": 0.67 } ] }
```
Not entitled: `{ "entitled": false, "reason": "subscription_required" | "billing_not_live", "rows": [ { "game_id", "label", "kickoff_at", "status", "n" } ] }` (counts only, no numbers).

## GET /v1/activity  (free)
```json
{ "rows": [ { "at": "…", "creator_slug": "…", "creator_name": "…", "model_name": "…", "sport": "NFL",
  "kind": "submission", "n_rows": 14, "n_first": 12, "week": 3 } ] }
```

## GET /v1/rules  (free)
```json
{ "version": 1, "rules": [ "Pick result: …", "Margin error: …", "Brier: …", "First submission: …", "Coverage: …" ] }
```

## GET /v1/dashboard  (creator JWT)
```json
{ "creator": { …same as profile creator… , "billing_mode": "referral", "referral_share_bps": 5000 },
  "models": [ { "model_slug": "…", "model_name": "…", "sport": "NFL" } ],
  "keys": [ { "prefix": "mck_live_a1b2c3d4", "status": "active", "created_at": "…", "last_used_at": null } ],
  "origins": [ { "id": "…", "origin": "https://example.com", "status": "active" } ],
  "earnings": { "this_month_cents": 0, "balance_cents": 0, "available_cents": 0,
    "referred_active": 0, "referred_total": 0, "note": "Billing is not live yet. Attribution is being recorded now and pays out when billing turns on." },
  "embed_snippet": "<script src=… data-collective-host=…></script>",
  "prompt_available": true }
```

## POST /v1/dashboard/keys/rotate -> `{ "key": "mck_live_…", "prefix": "…", "shown_once": true }`
## POST /v1/dashboard/profile  body: any of display_name, description, website_url, x_handle, logo_url, pinned_model_slug -> `{ "ok": true, "creator": { … } }`
## POST /v1/dashboard/origins  body `{ "add": "https://example.com" }` or `{ "remove": "<id>" }` -> `{ "ok": true, "origins": [ … ] }`

## GET /v1/embed/bootstrap?host=moose&theme=dark
```json
{ "host": { "creator_slug": "moose", "creator_name": "Must Be Moose", "pinned": true },
  "meta": { …same as /v1/meta… },
  "wall": [ …same rows as /v1/wall, host row first, others in canonical order… ],
  "creators": [ { "slug": "…", "display_name": "…", "monogram": "…", "logo_url": null, "website_url": "…", "x_handle": "…", "membership": "…", "founding": false, "models": [ { "model_name": "…", "sport": "…", "record": { … }, "coverage_pct": 0 } ] } ],
  "upcoming": { "entitled": false, "games": [ …locked shape from /v1/games… ] },
  "settled": { "games": [ …settled shape… ] },
  "subscribe_url": "https://edgedesksports.com/collective/?ref=moose#join",
  "collective_url": "https://edgedesksports.com/collective/?ref=moose",
  "cache_seconds": 60 }
```
Canonical order everywhere: membership rank (ACTIVE CONTRIBUTOR, MEMBER, INACTIVE), then graded desc, then name. Host pinning moves the host to index 0 and sets `pinned`, nothing else differs per host.

## POST /v1/embed/events  body `{ "host": "moose", "visitor": "…uuid…", "events": [ { "type": "impression", "target": null, "path": "/", "at": "…" } ] }` -> `{ "ok": true }`  (fire and forget, 202)

## GET /v1/join/{token}
```json
{ "status": "valid", "founding": true, "prefill": { "display_name": "…", "sport": "NFL", "model_name": "…" },
  "expires_at": "…" }
```
`status`: `valid | expired | spent`. Expired and spent return HTTP 410 with the same shape plus `request_url`.

## POST /v1/join/{token}/redeem  (Bearer JWT from magic link; body: display_name, sport, model_name, description?, website_url?, x_handle?, logo_url?, accept_terms: true)
```json
{ "creator": { "slug": "moose", "display_name": "…", "profile_url": "https://edgedesksports.com/collective/#/moose" },
  "model": { "model_slug": "nfl-model", "model_name": "NFL Model", "sport": "NFL" },
  "api_key": { "key": "mck_live_…", "prefix": "mck_live_a1b2c3d4", "shown_once": true },
  "prompt": "…full universal prompt text…",
  "embed_snippet": "<script src=\"https://edgedesksports.com/collective/embed.js\" data-collective-host=\"moose\" async></script>",
  "dashboard_url": "https://edgedesksports.com/collective/#dashboard",
  "founding": true }
```

## Ingest, POST /v1/projections and /v1/projections/dry-run
Request and response exactly as in CONTRACT.md section 5.1. Dry-run response adds `"dry_run": true` and `submission_id: null`.

## GET /v1/whoami (ingest key)
```json
{ "creator": { "slug": "…", "display_name": "…" }, "model": { "model_slug": "…", "model_name": "…", "sport": "NFL" },
  "key": { "prefix": "…", "kind": "live" }, "limits": { "max_rows": 500, "rate_per_hour": 60 } }
```

## Admin
- POST /v1/admin/invites body `{ prefill: {display_name, sport, model_name}, founding: bool, share_bps: int|null, max_uses: int, note: string }` -> `{ "invite_url": "https://edgedesksports.com/join/mci_…", "token": "mci_…", "expires_at": "…", "shown_once": true }`
- GET /v1/admin/invites -> `{ "rows": [ { "id", "prefix", "note", "founding", "max_uses", "use_count", "expires_at", "status", "created_at" } ] }`
- GET /v1/admin/members -> `{ "rows": [ { "creator_slug", "display_name", "membership", "founding", "referral_share_bps", "billing_mode", "models": [...], "key_prefixes": [...], "origins": [...], "joined_at", "last_submission_at" } ] }`
- GET /v1/admin/quarantine -> `{ "rows": [ { "projection_id", "creator_slug", "model_name", "raw_game_ref", "raw_row": {…}, "reason", "received_at" } ] }`
- POST /v1/admin/quarantine/{id}/resolve body `{ "game_id": "…" }` or `{ "alias": { "sport": "NFL", "alias": "Jags", "team_code": "JAX" } }` -> `{ "ok": true, "resolved": 3 }` (alias path re-resolves all quarantined rows that now match)
- POST /v1/admin/games body `{ "sport": "NFL", "season": 2026, "games": [ { "week": 3, "kickoff": "…", "home": "KC", "away": "BUF" } ] }` -> `{ "ok": true, "upserted": 16 }`
- POST /v1/admin/results body `{ "results": [ { "game_id": "…", "home_score": 27, "away_score": 24, "closing_spread": -2.5, "closing_total": 47.5, "closing_home_ml_prob": 0.62 } ] }` -> `{ "ok": true, "settled": 1, "graded": 3 }`
- GET /v1/admin/earnings -> `{ "rows": [ { "creator_slug", "month", "earned_cents", "clawed_cents", "paid_cents", "balance_cents", "available_cents" } ] }`
