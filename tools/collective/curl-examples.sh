#!/usr/bin/env bash
# Model Collective API: working curl examples for every endpoint.
# Fill in the variables, then run any block. Each is annotated with its
# auth class: free (no auth), key (x-collective-key), user (subscriber or
# creator JWT), admin (JWT on the admin.user_ids list).

set -euo pipefail

COLLECTIVE_API="${COLLECTIVE_API:-https://iattxbkbufslbauoumga.supabase.co/functions/v1}"
COLLECTIVE_KEY="${COLLECTIVE_KEY:-mck_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}"
USER_JWT="${USER_JWT:-eyJ...signed-in-user}"
ADMIN_JWT="${ADMIN_JWT:-eyJ...admin-user}"

# ---------------------------------------------------------------- ingest (key)

# key check: who am I, what are my limits
curl -s "$COLLECTIVE_API/collective_ingest/v1/whoami" \
  -H "x-collective-key: $COLLECTIVE_KEY"

# dry run: identical validation and resolution, writes nothing. This is the
# endpoint the Universal Prompt uses before anything goes live.
curl -s -X POST "$COLLECTIVE_API/collective_ingest/v1/projections/dry-run" \
  -H "x-collective-key: $COLLECTIVE_KEY" -H "content-type: application/json" \
  -d '{
    "sport": "NFL", "season": 2026, "week": 3, "data_origin": "live",
    "rows": [
      { "game_ref": "NFL_2026_W3_BUF_KC", "home_team": "KC", "away_team": "BUF",
        "kickoff": "2026-09-21T00:20:00Z", "pick_side": "home",
        "projected_spread": -3.5, "projected_total": 47.5,
        "home_win_probability": 0.61 },
      { "game_ref": "NFL_2026_W3_DAL_WSH", "home_team": "WSH", "away_team": "Cowboys",
        "kickoff": "2026-09-20T17:00:00Z", "projected_spread": -1.0 }
    ]
  }'

# the real submission: same envelope, no /dry-run
curl -s -X POST "$COLLECTIVE_API/collective_ingest/v1/projections" \
  -H "x-collective-key: $COLLECTIVE_KEY" -H "content-type: application/json" \
  -d @projections.json

# ---------------------------------------------------------------- public (free)

curl -s "$COLLECTIVE_API/collective_public/v1/meta"
curl -s "$COLLECTIVE_API/collective_public/v1/wall"
curl -s "$COLLECTIVE_API/collective_public/v1/creators/must-be-moose"
curl -s "$COLLECTIVE_API/collective_public/v1/models/must-be-moose/nfl-model"
curl -s "$COLLECTIVE_API/collective_public/v1/rankings"
curl -s "$COLLECTIVE_API/collective_public/v1/activity"
curl -s "$COLLECTIVE_API/collective_public/v1/rules"

# free list, paid numbers: anonymous callers get locked rows on upcoming
# games; settled games are the free public record
curl -s "$COLLECTIVE_API/collective_public/v1/games?sport=NFL&season=2026&week=3"

# ---------------------------------------------------------------- public (user)

# the same board, entitled: subscriber or creator JWT unlocks the numbers
curl -s "$COLLECTIVE_API/collective_public/v1/games?sport=NFL&season=2026&week=3" \
  -H "authorization: Bearer $USER_JWT"

# consensus: paid for upcoming, counts only when not entitled
curl -s "$COLLECTIVE_API/collective_public/v1/consensus?sport=NFL&season=2026&week=3" \
  -H "authorization: Bearer $USER_JWT"

# creator dashboard: profile, key prefixes, embed origins, earnings
curl -s "$COLLECTIVE_API/collective_public/v1/dashboard" \
  -H "authorization: Bearer $USER_JWT"

# edit profile fields (identity only, never records)
curl -s -X POST "$COLLECTIVE_API/collective_public/v1/dashboard/profile" \
  -H "authorization: Bearer $USER_JWT" -H "content-type: application/json" \
  -d '{ "description": "Odds-blind NFL projections, twice daily." }'

# rotate the API key: old key dies now, new key shown once
curl -s -X POST "$COLLECTIVE_API/collective_public/v1/dashboard/keys/rotate" \
  -H "authorization: Bearer $USER_JWT"

# manage embed origins
curl -s -X POST "$COLLECTIVE_API/collective_public/v1/dashboard/origins" \
  -H "authorization: Bearer $USER_JWT" -H "content-type: application/json" \
  -d '{ "add": "https://moosepicks.example.com" }'

# ---------------------------------------------------------------- embed (origin)

# the embed bootstrap: origin must be on the host creator's allowlist
# (edgedesksports.com and localhost always pass in dev)
curl -s "$COLLECTIVE_API/collective_embed/v1/embed/bootstrap?host=must-be-moose&theme=dark" \
  -H "Origin: https://moosepicks.example.com"

# batched embed events, fire and forget
curl -s -X POST "$COLLECTIVE_API/collective_embed/v1/embed/events" \
  -H "Origin: https://moosepicks.example.com" -H "content-type: application/json" \
  -d '{ "host": "must-be-moose", "visitor": "8b0f4a6e-1111-2222-3333-444455556666",
        "events": [ { "type": "impression", "target": null, "path": "/", "at": "2026-09-18T14:00:00Z" } ] }'

# ---------------------------------------------------------------- join (token)

# token status: valid, expired, or spent, plus prefill
curl -s "$COLLECTIVE_API/collective_join/v1/join/mci_examplerawtokenvalue"

# redeem: requires the magic-link session JWT; returns the key once, the
# rendered Universal Prompt, and the embed snippet
curl -s -X POST "$COLLECTIVE_API/collective_join/v1/join/mci_examplerawtokenvalue/redeem" \
  -H "authorization: Bearer $USER_JWT" -H "content-type: application/json" \
  -d '{ "display_name": "Must Be Moose", "sport": "NFL", "model_name": "NFL Model",
        "website_url": "https://moosepicks.example.com", "accept_terms": true }'

# dead-token page: request a fresh invite
curl -s -X POST "$COLLECTIVE_API/collective_join/v1/join/request" \
  -H "content-type: application/json" \
  -d '{ "email": "moose@example.com", "note": "link expired" }'

# ---------------------------------------------------------------- admin

# mint an invite: the returned URL is shown once
curl -s -X POST "$COLLECTIVE_API/collective_admin/v1/admin/invites" \
  -H "authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "prefill": { "display_name": "Must Be Moose", "sport": "NFL", "model_name": "NFL Model" },
        "founding": true, "share_bps": null, "max_uses": 1, "note": "first founding invite" }'

curl -s "$COLLECTIVE_API/collective_admin/v1/admin/invites" -H "authorization: Bearer $ADMIN_JWT"
curl -s "$COLLECTIVE_API/collective_admin/v1/admin/members" -H "authorization: Bearer $ADMIN_JWT"
curl -s "$COLLECTIVE_API/collective_admin/v1/admin/quarantine" -H "authorization: Bearer $ADMIN_JWT"

# resolve a quarantined row by game id, or teach the resolver an alias
curl -s -X POST "$COLLECTIVE_API/collective_admin/v1/admin/quarantine/PROJECTION_UUID/resolve" \
  -H "authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "alias": { "sport": "NFL", "alias": "Okland Raiders", "team_code": "LV" } }'

# load the slate
curl -s -X POST "$COLLECTIVE_API/collective_admin/v1/admin/games" \
  -H "authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "sport": "NFL", "season": 2026, "games": [
        { "week": 3, "kickoff": "2026-09-21T00:20:00Z", "home": "KC", "away": "BUF" } ] }'

# settle games: final scores plus the Collective's own captured closing line
# (home convention). Settling grades every candidate projection immediately.
curl -s -X POST "$COLLECTIVE_API/collective_admin/v1/admin/results" \
  -H "authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "results": [ { "game_id": "GAME_UUID", "home_score": 27, "away_score": 24,
        "closing_spread": -2.5, "closing_total": 47.5, "closing_home_ml_prob": 0.62 } ] }'

curl -s "$COLLECTIVE_API/collective_admin/v1/admin/earnings" -H "authorization: Bearer $ADMIN_JWT"

# ---------------------------------------------------------------- billing

# checkout: reports { live: false } until billing.enabled and Stripe secrets
# are set; then 302-redirects to Stripe Checkout
curl -s "$COLLECTIVE_API/collective_billing/v1/billing/checkout?plan=monthly&ref=must-be-moose"
