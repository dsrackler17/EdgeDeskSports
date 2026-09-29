# Player Props — the Supabase schema (`supabase/player_props.sql`)

The schema is idempotent and additive: no table or column is ever dropped.
Apply it in the SQL editor; it ends in a CHECK THIS report.
`tools/props/player_props_sql.test.js` applies it twice to a real PostgreSQL and
attacks it as anon, as a reader and as the service role.

| Area | Tables / views |
|---|---|
| Identity | `player_registry` (ids match `^edp_[0-9a-f]{12}$`), `player_identity_map` (provider ids, book names, former names), `player_team_memberships` |
| Usage | `player_game_logs`, `player_usage_history` and its views `player_snap_history`, `player_route_history`, `player_target_history`, `player_carry_history`, `player_red_zone_usage`, `player_game_participation` |
| Availability | `player_depth_chart`, `player_injuries`, `player_availability` |
| Market | `player_prop_quotes` (every tick), `player_prop_markets`, `player_prop_consensus`, `player_prop_closing_lines`, `player_prop_snapshots` |
| Model | `player_prop_model_versions` (seeded: NFL_PLAYER_PROPS_V1.0, CFB_PLAYER_PROPS_V1.0), `player_prop_projections`, `player_prop_distributions`, `player_prop_correlations`, `player_prop_calibration` |
| Record | `player_prop_decisions` (frozen), `player_prop_grades`, the view `player_prop_record` |

Guarantees are enforced by triggers and grants, not by application code:

- **Append-only.** `update` and `delete` are revoked, even from `service_role`,
  and blocked by triggers.
- **Pregame only.** A decision frozen at or after kickoff is refused, and so is a
  BET with zero units.
- **Postgame only.** A grade before kickoff is refused.
- **RLS.**
  - Model output (projections, distributions, stages) is public.
  - Live market rows are for authenticated readers.
  - A frozen decision becomes public only **after its kickoff**.

`football/props/sync_supabase.js` mirrors the committed files insert-only
(on-conflict-do-nothing), when `SB_URL` and `SB_SERVICE_ROLE` exist. The
repository stays the record either way.
