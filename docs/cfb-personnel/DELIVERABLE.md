# CFB player-level roster intelligence: final deliverable

What was built for the personnel brief (§70), item by item. Code is in
`football/cfb_v2/research/v2/personnel/`. The detailed documents are:
- [AUDIT.md](AUDIT.md): what the data allows;
- [METHODS_FOUNDATION.md](METHODS_FOUNDATION.md): identity, positions, usage and player-week state;
- [QB.md](QB.md): the quarterback layer;
- [UNITS.md](UNITS.md): the non-QB values and units;
- [DESIGN.md](DESIGN.md): the rules.

**No personnel component is promoted.**
- **Quarterback.** An announced starter improves QB-change games in the same direction on both the development
  seasons and the holdout. The gain is too small to separate from zero, and ordinary games are unchanged by
  construction. It is recommended as a *challenger* that runs in a game-day refresh.
- **Every non-QB unit.** Each one is research-only or uncertainty-only. The one non-QB signal found on the
  development seasons failed the 2024–2025 holdout. That holdout was scored once.

Nothing here moves a production margin.

| # | item | where | what it is |
|---|---|---|---|
| 1 | player-data audit | [AUDIT.md §1](AUDIT.md) | 43 desired features, each classed AVAILABLE / DERIVABLE / PARTIAL / UNRELIABLE / REJECT / NEW SOURCE REQUIRED, with the measured reason |
| 2 | historical coverage | [AUDIT.md §2–6](AUDIT.md) | Play-by-play id coverage by season, column reliability, rosters, the ESPN box score and the 2026 availability reports. Receiver ids are weak in 2022–24 (69–79 %). Interceptor and break-up ids collapse in 2021–23 |
| 3 | canonical player identity | `identity.py`, [METHODS_FOUNDATION §2](METHODS_FOUNDATION.md) | The ESPN athlete id is the one id across the play-by-play, rosters and box scores, and it survives transfers: 0 of 511,603 alias rows needed a cross-provider map. Aliases are kept, and identity quality is measured for 2009–2026 |
| 4 | position normalization | `positions.py`, [§1](METHODS_FOUNDATION.md) | Provider labels map to canonical positions. A generic label (OL / DL / DB) stays generic (`*_OTHER`) and is never guessed |
| 5 | player-week state | `state.py` `player_week_state(season, T)`, [§4](METHODS_FOUNDATION.md) | 71 columns per player at an instant T: membership, usage shares, depth rank, role, starter probability and availability. Point-in-time |
| 6 | expected snap model | [AUDIT #16](AUDIT.md) | **Not buildable**: no feed carries snap counts. Expected **usage** shares (carries, targets, dropbacks) take its place, and are named as such |
| 7 | QB value model | `qb.py` `qb_values`, `ratings_at`, [QB.md §1](QB.md) | A per-player rating at T with a posterior SD, shrunk to replacement |
| 8 | QB replacement model | `qb.py` `expected_starters`, `starter_distribution`, [QB.md §3](QB.md) | A starter distribution at T from history's injury and benching rates, conditioned (not multiplied) on an official report |
| 9 | OL model | `units.py` `ol_uncertainty`, `ol_from_reports`, [UNITS §2](UNITS.md) | **Uncertainty-only, NOT_ESTIMATED.** No feed carries offensive-line participation. A declared prior adds +1.0 pt² of margin variance per expected-missing lineman, from official reports only |
| 10 | OL continuity | [AUDIT #18](AUDIT.md) | **Not buildable** from the data: OL players appear in the play-by-play only on fumble recoveries |
| 11 | WR/TE model | `values.py` (EPA per target; k = 103 WR, 112 TE) | Shrunk efficiency plus usage share. Verdict: research. The next candidate is a new-absence report delta |
| 12 | RB model | `values.py` (EPA per carry; k = 163) | Verdict: research. The split-half reliability of efficiency is 0.195 |
| 13 | defensive-front model | `values.py` (sacks per game; k = 12.1) | Verdict: uncertainty-only. Production is not participation |
| 14 | LB model | [UNITS §2](UNITS.md) | No linebacker-specific field exists (no tacklers or pressures in the play-by-play). Linebackers are inside FRONT7 production |
| 15 | secondary model | `values.py` (interceptions and break-ups, 2016–20 only) | Uncertainty-only: the ids are null in 2021–23 |
| 16 | special-teams player model | `values.py` (FG points over expected, XP, net punt) | FG make model logit p = 0.792 − 0.860z + 0.090z², n = 19,884. Verdict: research. V2.1's special-teams ratings never leave their prior (item 42) |
| 17 | replacement-level methodology | [UNITS §1](UNITS.md), [QB.md §1](QB.md) | Replacement is the value of the players who come in, with bootstrap CIs: e.g. RB −0.016, WR −0.072 EPA; K −0.342 FG points; P −2.14 net yards |
| 18 | PVAR methodology | [UNITS §9](UNITS.md), [QB.md §6](QB.md) | Points versus a replacement, per game, with SD. For 2025: only 2–3 % of skill players are more than 1.96 SD above replacement; specialists are the most precise |
| 19 | availability probabilities | `state.py` availability, `units.py` | From official reports gated on `published_at`, with a declared status map (not calibrated). UNKNOWN is never read as healthy |
| 20 | depth-chart model | `state.depth_chart_state`, [§5](METHODS_FOUNDATION.md) | Ordered by expected usage share and labelled `source = usage_derived`. No provider depth chart exists |
| 21 | transfer translation | `qb.transfer_events`, `estimate_persistence`; `values.py` ρ | QB: 72 % of above-replacement rating follows the player [24 %, 120 %], so it only widens uncertainty. Non-QB ρ-transfer (e.g. FRONT 0.34) is capped at the stay ρ |
| 22 | returning player value | [UNITS §10](UNITS.md) | Returning production 2.0 is evidence only. A PVAR-based defensive returning share predicts the weeks 1–4 residual at +1.11 pts/SD [0.26, 1.99]. The roster-based version is weaker: +0.57 [−0.29, 1.40] |
| 23 | roster continuity | `state.py` membership, transfers | The share of usage returning and the transfers in and out, by unit. Membership comes from a roster snapshot that is not point-in-time; week 1 is reported apart |
| 24 | unit-health system | `units.py` `unit_state(season, T)` | Per team and unit at T: lineup, values, reported OUT count, `absence_delta_pts`. Published as flagged research information only |
| 25 | personnel uncertainty | `units.py` (OL variance, multi-absence ×1.017), `lineup.py` scenario spread | Personnel changes widen σ or publish a scenario spread; they never narrow it |
| 26 | event-driven updates | `qb_state` / QB events in the weekly engine; `lineup.project` | QB change events (NEW_STARTER, BENCHING, …) are live in the weekly engine's report. A report-driven projection needs a write-once **game-day refresh**: in 2026 no report was published before the Tuesday freeze |
| 27 | lineup scenario system | `lineup.py` `project`, [QB.md §4](QB.md) | Each starter scenario's margin on the frozen artifact, mixed by play probability, with the "pure artifact" view beside it |
| 28 | double-counting protection | [UNITS §5](UNITS.md), [QB.md verdict](QB.md) | Ablation by absence length shows the rating absorbs long absences. The holdout shows the naive delta double-counts, so only a baseline-anchored delta is allowed |
| 29 | baseline-lineup logic | `units.py` `baseline_share`, `reanchor_example`, [UNITS §3](UNITS.md) | The expected lineup re-anchors as an absence ages. Example: Patrick Taylor Jr. (Memphis 2019) |
| 30 | historical backtest | `backtest.py` `compare_all` | BASE vs +QB vs +QB+OL vs +ALL on development 2016–23 and holdout 2024–25: MAE, RMSE, tail, Brier, calibration, and change-game subsets |
| 31 | QB-specific backtest | `backtest_qb`, [QB.md §5](QB.md) | Oracle ΔMAE on QB-change games: dev −0.020 [−0.092, +0.057], holdout −0.088 [−0.225, +0.044]. Ordinary games are unchanged |
| 32 | OL-specific backtest | [UNITS §8](UNITS.md) | **Not possible before 2026** (no OL reports), so +QB+OL equals +QB historically. The 2026 live counts are logged |
| 33 | skill-position backtest | [UNITS §4, §7](UNITS.md) | Dev: efficiency deltas are ~0; the usage-valued known-absence delta gives ΔMAE −0.016 [−0.029, −0.002]. Holdout: it **fails**, harming ordinary games +0.088 [+0.023, +0.151] |
| 34 | defensive-player backtest | [UNITS §4](UNITS.md) | +DEF ΔMAE −0.016 [−0.042, +0.010] on dev change games. Not promotable |
| 35 | source-quality system | `usage.reliability`, [AUDIT §3](AUDIT.md) | Per season and column: RELIABLE / WEAK / UNRELIABLE (e.g. `receiver_ids_reliable`). Unreliable columns are excluded, never imputed |
| 36 | internal roster dashboard | — | **Not built.** The data exists in `unit_state` and the Postgres views (`supabase/cfb_personnel.sql`), but no admin page reads them yet. It is the next wiring step |
| 37 | database migrations | `supabase/cfb_personnel.sql` (SQL bundle file 5) | 10 tables (players, aliases, transfer history, player performance, player-week state, depth chart state, unit state, player events, game snapshot, model versions) plus views. Append-only, with RLS. `football/cfb_personnel/sql.test.js`: 42 checks |
| 38 | scheduled jobs | — | **None for the new layer**: it is research and changes no production number. The sync script `football/cfb_personnel/sync_supabase.js` is ready. The existing V1 availability pipeline (`football-model-record.yml`) keeps running |
| 39 | tests | `tests_foundation` (73), `tests_qb` (64 fast / 86 full), `tests_units` (73 fast / 128 full), `sql.test.js` (42) | CI runs `tests_qb --fast`, `tests_units --fast` and the SQL suite (`cfb-weekly-tests.yml`). `tests_foundation` needs the play-by-play data and stays local |
| 40 | files changed | below | |
| 41 | performance comparison | [UNITS §8](UNITS.md) | No +ALL row passes the promotion rule; the skill known-absence row harms ordinary holdout games +0.057 [−0.007, +0.120] |
| 42 | remaining limitations | below | |
| 43 | data sources that would most improve player modeling | [AUDIT §9](AUDIT.md) | In order: snap counts or participation (OL above all); pregame depth charts; historical injury reports; per-game defensive tacklers and pressures; portal dates |
| 44 | production promotion recommendation | this page, first paragraph | **Promote nothing now.** Shadow the QB challenger `edgedesk_cfb_v2.1.0+personnel_qb_v1` in a game-day refresh. Validate the "new skill absence ≤ 2 games" candidate on live 2026 reports. Carry the V2 findings (item 42) into the next retrain |

## Files

In `football/cfb_v2/research/v2/personnel/`:
- foundation: `identity.py`, `positions.py`, `usage.py`, `state.py`, `tests_foundation.py`;
- quarterback layer: `qb.py`, `lineup.py`, `backtest_qb.py`, `tests_qb.py`;
- units: `values.py`, `units.py`, `backtest_units.py`, `backtest.py`, `tests_units.py`.

Elsewhere:
- `supabase/cfb_personnel.sql`;
- `football/cfb_personnel/{sync_supabase.js, sql.test.js}`;
- docs in `docs/cfb-personnel/`.

## Remaining limitations

- **Missing data.** No snap counts, OL participation, depth charts, tacklers or pressures, historical injury
  reports, or portal dates in any feed.
- **Report timing.** 2026 availability reports arrive on game day. None was published before the Tuesday freeze.
- **Unreliable columns.** Receiver ids in 2022–24 and the secondary's ids in 2021–23 cannot be relied on.
- **V2 findings for the next retrain.** Special-teams ratings are frozen at their prior, because `fg_value` and
  `st_net` prior variance sits at the 1.5e-9 floor. `qb_team_rating` re-anchors 4–6× faster than the ratings
  absorb a new QB. V2's preseason prior is not the returning lineup.
- **Unvalidated statuses.** The availability status map is declared, not calibrated.
