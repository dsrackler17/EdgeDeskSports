# CFB personnel — data foundation methods

The foundation answers **who** plays, **for whom**, **how much**, and **how sure we are** at any instant T,
from data that existed at T. It carries no player values yet: `player_value_mean`, `player_value_sd` and
`replacement_value` are named null placeholders that the next phase (QB value, units, lineup deltas) fills.
Contract: [DESIGN.md](DESIGN.md). Data coverage and the classification of every feature: [AUDIT.md](AUDIT.md).

```
football/cfb_v2/research/v2/personnel/
  positions.py   normalize(original_position, context=None) -> family; unit_of, weekly_unit_of
  identity.py    build_players(seasons) -> (players, aliases, transfers); resolve(name, team_id, season, position)
  usage.py       player_games(season, T=None); team_games(season, T=None); reliability(season, T=None)
  state.py       player_week_state(season, T, availability=None); depth_chart_state(season, T)
  tests_foundation.py   python3 -m v2.personnel.tests_foundation   (ALL GREEN 73 passed)
```

Run from `football/cfb_v2/research` with `CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out`. Everything is
deterministic: no randomness, sorted outputs, ids from `v2.weekly.ids.h`, row hashes from
`ids.content_hash`. Caches live in `$CFB_V2_OUT/personnel/` (`cache/player_games_<S>.parquet`,
`cache/history_<S>.parquet`, `calibration_<S>.json`); each is keyed by the code version and the source
files' size and modification time, so a refreshed play-by-play or schedule rebuilds it. Timings on this
machine: one season's player-games 2–5 s to build (0.3 s cached); the full registry 2009–2026 50 s;
`player_week_state` 15–17 s per instant with the calibration cached (a season's calibration, first time,
about 60 s); the test suite 3.5 min.

## 1. Positions (`positions.py`)

`normalize(original_position, context=None) -> family`, `normalize_detail(...) -> (family, basis)`.

| family | provider strings (ESPN, cfbfastR/CFBD, availability reports) |
|---|---|
| QB | QB, Quarterback |
| RB | RB, HB, TB, **FB** (Fullback), Running Back |
| WR | WR, **SB** (slotback), FL, SE, Wide Receiver |
| TE | TE, Tight End |
| OT / OG / C | OT, T, LT, RT / OG, G, LG, RG / C, OC |
| **OL_OTHER** | OL, IOL, Offensive Line(man) — a generic label stays generic |
| EDGE | **DE**, EDGE, EDG, Defensive End |
| DT | DT, NT, NG, Nose Tackle |
| **DL_OTHER** | DL, Defensive Line(man) — generic |
| LB | LB, ILB, OLB, MLB, WLB, SLB |
| CB / S | CB, Corner(back) / S, FS, SS, SAF, Safety |
| **DB_OTHER** | DB, **NB** (nickel: CB or S by scheme) — generic |
| K / P / LS / RETURNER | K, PK, Place Kicker / P / LS, Long Snapper / KR, PR, RET |
| UNKNOWN | ATH, N/S, blank, anything else |

Rules: a generic line or secondary label is never resolved to a specific family (`basis = generic_label`).
`context={'usage': {'dropbacks', 'rushes', 'targets'}}` resolves **only** an ATH / missing position, and
only when one kind is ≥ 70% of ≥ 10 observed usage events (QB, RB, or WR — a target-dominant ATH is WR, a
tight end cannot be told from targets); the basis is then `usage_inferred`. It never overrides a provider
label. Units: `unit_of(family)` → QB, OL, WR_TE, RB, FRONT7 (EDGE, DT, DL_OTHER, LB), SECONDARY (CB, S,
DB_OTHER), ST (K, P, LS, RETURNER); `weekly_unit_of(family)` → the weekly engine's QB OL WR_TE RB DL LB DB ST
(FRONT7 = DL + LB, `PERSONNEL_TO_WEEKLY`). A test checks every string in
`v2.weekly.availability.UNIT_OF_POSITION` lands in the same weekly unit, and that every position string in
the 2025/2026 ESPN rosters maps to a family.

Registry distribution (109,232 players): WR 15,385, LB 11,830, OL_OTHER 11,155, DB_OTHER 9,502, RB 9,092,
DL_OTHER 8,383, TE 5,808, QB 5,246, S 4,191, CB 3,763, K 2,940, EDGE 2,871, DT 1,916, P 1,671, LS 1,489,
OT 311, OG 290, C 149, RETURNER 5, UNKNOWN 13,235 (roster-less FCS players with too little usage).
Position basis: provider label 65,927, generic label 29,040, usage-inferred 1,030, unknown 13,235.

## 2. Identity (`identity.py`)

**One id.** `player_id = 'espn:<athlete id>'`. The ESPN athlete id is the id of the play-by-play, of
cfbfastR's rosters and play stats, of the ESPN rosters and player box; it survives transfers. cfbfastR
carries the same number, recorded as `provider_ids['cfbfastr']` when a cfbfastR source lists the player; a
different cfbfastR id never occurs locally.

**Sources, by authority.** (1) Play-by-play appearances (`usage.player_games`): who played, for whom,
when. (2) Rosters, per season in this order: ESPN 2026; cfbfastR (2004–2025); ESPN 2025 last. The ESPN 2025
file is a "core athletes" list: 14.8% of its players who played in 2025 are listed for another team, and it
lists 2,476 of the 3,673 players of 2024 who never played in 2025 (AUDIT.md #30); cfbfastR agrees with the
2025 games 99.4%. (3) cfbfastR play stats: extra spellings only.

**Contaminants removed.** All-star / offseason games (seasonType 4; teams 3144 3145 3146 3147 3193 3194 3197
3198 125290 125291); the feed's negative "TEAM" ids; the legacy negative roster ids (never in a play); ids
1 / 3 / 13 and anything ≤ 100 (`usage.valid_id`); duplicate roster rows (one row per id and season, the
listing that sorts first); all-star roster teams.

`build_players(seasons) -> (players_df, aliases_df, transfers_df)`:

- **players** (one row per player): `player_id, espn_id, provider_ids` (JSON), `full_name`, `team_id,
  team_season` (latest), `team_by_season` (JSON {season: team}), `team_basis_by_season` (JSON: `games` or
  the roster file), `first_season, last_season, first_game_ts, last_game_ts, career_games,
  career_dropbacks, career_rushes, career_targets, original_position, position_source,
  normalized_position, position_basis, unit, weekly_unit, class_year, class_year_source,
  class_year_cfbfastr, class_year_cfbfastr_season, class_year_cfbfastr_flag` (always `UNRELIABLE`),
  `height_in, weight_lb, prior_teams` (JSON list), `transfer_history` (JSON), `n_transfers,
  active_status` (ACTIVE when seen in the last season built), `active_basis`.
  - team of a season = the **modal** team over the player's games that season (most games; tie: the team
    of the later last game; then the lower id); a roster listing only when he has no game that season.
  - full name = the most frequent spelling in the latest season with a name (games count once each, a
    roster listing once); ties: ESPN roster spelling, then PBP, then alphabetical.
  - position = the latest roster listing that has one (source order as above).
  - class year = ESPN 2026 class for the 2026 roster only (`class_year_source = espn_roster_2026`);
    cfbfastR's `year` is kept apart in `class_year_cfbfastr` and flagged UNRELIABLE (it is the season number
    through 2011 and the eventual class after; AUDIT.md #33).
- **aliases** (one row per player × spelling × season × team × source): `name, alias_key` (lower case,
  punctuation and generational suffix dropped), `initial_key` (first initial + last name), `season,
  team_id, source` (pbp / cfbfastr_roster_<S> / espn_roster_<S> / cfbfastr_pstats_<S>), `n` (games or
  listings), `first_seen, last_seen` (kickoffs, PBP rows), `team_consistent` (the alias's team equals the
  player's team of that season; 99.48% of rows — the 2,117 ESPN-roster and 561 cfbfastR-roster rows that
  place a player elsewhere stay as evidence but do not feed name resolution).
- **transfers** (one row per team change between consecutive seasons of the player's history):
  `event_type` (`TRANSFER` when the seasons are consecutive, `TRANSFER_AFTER_GAP` otherwise),
  `from_team, to_team, from_season, to_season, season_gap, evidence_from, evidence_to` (`games` or the
  roster file), `games_from, games_to, games_by_team_from, games_by_team_to` (JSON games per team — the
  evidence), `known_from` (kickoff of his first game for the new team; null for roster evidence),
  `known_from_basis`, `portal_date` (always null: no source), `transfer_id`.
  - 21,634 rows over 2010–2026 (18,523 TRANSFER, 3,111 after a gap); with games at both schools: 437 /
    613 / 730 / 979 / 1,261 / 1,203 in 2021–2026, of which quarterbacks 62 / 86 / 88 / 123 / 138 / 136.
  - Point in time: a transfer is knowledge from `known_from`. Roster-evidence rows have no point-in-time
    date; a backtest must not use them before the player's first game for the new team.

**Resolution.** `resolve(name, team_id, season, position=None, espn_id=None) -> player_id | None`;
`resolve_detail(...)` also returns the reason and the candidates. Order: (1) an exact id (`espn_id`, with or
without the `espn:` prefix) that is in the registry; (2) the full-name key within **(team, season)**; (3) the
initial + last-name key within (team, season). Each step resolves only when exactly one player matches; a
`position` that tells candidates apart is used before refusing. Two or more matches → `None`, reason
`AMBIGUOUS_…: n players`. No team or season → `None` (`NO_TEAM_OR_SEASON: never resolved by name alone`).
A name is never matched across teams or seasons. The registry for `resolve()` defaults to the season and
the one before it.

### Identity quality (2009–2026)

| measure | value |
|---|---|
| canonical players / with at least one play / roster-only | 109,232 / 57,301 / 51,931 |
| alias rows (PBP / cfbfastR roster / ESPN roster / cfbfastR play stats) | 511,603 (135,113 / 260,110 / 37,143 / 79,237) |
| **same id, different names** (PBP spellings) | 7,563 ids with > 1 raw spelling; **5,422** with > 1 normalised name |
| — of which: a feed token glued to the name ("utah junior tuione", "temp marquise liverpool"; 2009–2022 feeds) | 4,316 |
| — first-name variants (nickname / spelling: "cedric" / "credric patterson"; a handful are two people on one id, e.g. "jonathan jones" / "skylar jones") | 666 |
| — initial-only forms ("c j wilson"; extra-point kicker names) | 429 |
| — suffix / spacing / last-name typos | 6 / 3 / 2 |
| passers 2022–2026 with > 1 spelling / > 1 normalised name (of 1,976 passer ids) | 26 / **17** (the audit's 15 of 2,141 counted placeholder and all-star ids) |
| **same name, different ids**: PBP name keys with > 1 id (of 59,485) | 2,310 (common names, different teams) |
| same name, same team, same season (the collisions `resolve()` must refuse): PBP / all sources | **85 / 1,329** |
| player-games whose events the feed split across both teams, after the fix below | 18–26 a season (< 0.1%) |

The same-id-different-name cases are harmless for identity (the id decides) and are why `full_name` is
the most frequent recent spelling. The same-team-season collisions are why resolution refuses rather than
picks: e.g. "A. J. Gates", Alabama State 2024, is two ids.

## 3. Usage (`usage.py`)

`player_games(season, T=None, pbp=None, null_unreliable=False)` — one row per player × game × team, for the
games that kicked off **strictly before T** (kickoff = V2 stage 2's `kickoff_ts`, else the schedule's
`start_date`). The full season is built once and cached; a T restriction is a filter on kickoff, and every
column is a function of that game's plays only (plus, for extra-point names, games at or before it), so
nothing after T can move a row: a test rewrites every play after T (EPA, rusher ids, names, deletions) and
checks `player_games(season, T)` and the player-week state at T are unchanged.

Play definitions are V2 stage 1's (AUDIT.md §8): scrimmage = (rush | pass) & live & EPA present; a
dropback includes sacks; garbage = `common.garbage_mask` (quarter and score only).

**Row schema** (127 columns):

- keys: `player_game_id` (`ids.h('cfb_player_game', game, team, player)`), `player_id, espn_id, game_id,
  team_id, opp_id, is_home, home_id, away_id, season, week, season_type, kickoff_ts, name` (the spelling the
  feed used most in that game).
- passing (the passer on every dropback): `dropbacks[_ng], pass_att[_ng], completions, pass_yds,
  pass_epa[_ng], pass_succ[_ng], sacks_taken, ints_thrown, pass_first_downs, first_db_play`.
- rushing: `rush_att[_ng], rush_yds, rush_epa[_ng], rush_succ[_ng], expl_rush` (EPA_explosive),
  `rush_first_downs, qb_rush_att` (rushes by a player with a dropback in the game: QB rushes; scrambles are
  not identifiable, AUDIT.md #19).
- receiving (the receiver on every pass attempt): `targets[_ng], receptions[_ng], rec_yds, rec_epa[_ng],
  rec_succ, expl_rec, rec_first_downs`, `rz_touches` (rushes + receptions starting inside the 20),
  `rz_targets`, `fumbles`.
- defence: `def_sacks` (a split sack is **half to each** sacker, so a team's credits equal its sacks),
  `def_sack_plays, def_ints, def_pbu, def_ff, def_fr`.
- special teams: `fg_att, fg_made, fg_dist_att_sum, fg_dist_made_sum, fg_att_40plus, fg_made_40plus,
  fg_long_made, xp_att, xp_made, kickoffs, kickoff_yds, punts, punt_yds, punt_net_yds` (gross − return
  yards; a touchback counts 20), `kick_returns, kick_return_yds, punt_returns, punt_return_yds`.
- team context of the (game, team) — the denominators: `team_dropbacks[_ng]`, `team_dropbacks_id[_ng]`
  (with a passer id), `team_pass_att, team_rushes[_ng], team_rushes_id[_ng], team_targets_id[_ng],
  team_plays, team_garbage_plays`, the defensive event and id counts (`team_def_sack_events[_id],
  team_def_sacks_credit, team_def_int_events[_id], team_def_pbu_flag, team_def_pbu_id, team_def_ff_flag,
  team_def_ff_id, team_def_fr_id`), `team_fumble_events[_id], team_kickoff_events[_id], team_fg_att,
  team_xp_att[_id], team_kickoffs, team_punts, team_returns_id`.
- shares: `db_share[_ng]` = dropbacks / team dropbacks with a passer id; `carry_share[_ng]` = rushes / team
  rushes with a rusher id (quarterback runs included); `target_share[_ng]` = targets / team targets with a
  receiver id; `sack_share`. Attributed denominators make a team-game's shares sum to 1 (tested to 1e-9 for
  all six); the unattributed rest is the id coverage (AUDIT.md table 2).
- starts: `qb_starter` = the passer on the team's first dropback (among valid ids) — it agrees with stage-1
  `qb_game.starter` on 100% of the team-games both hold (2016 and 2025 tested; stage 1 also keeps all-star
  games and 'TEAM' passers, which are dropped here). **No other position has a start**; the
  usage flags `usage_leader_dropback`, `usage_leader_rush` (top carry count), `usage_top3_target` (top-3
  target count; ties share the rank) are named as usage-based.
- reliability at T: `def_sacks_reliable, def_ints_reliable, def_pbu_reliable, def_ff_reliable,
  def_fr_reliable, fumbles_reliable, kickoffs_reliable, receiver_ids_reliable` (the season's verdicts over
  the games before T; `null_unreliable=True` nulls the failed defensive columns). `attrs['filtered']`
  counts the contaminants removed, `attrs['reliability']` has the numbers.

**Attribution rules.** Offence roles → the play's offence; sack / interception / break-up / forced fumble →
its defence; kickers and returners → the feed's kicking / receiving team columns. Fumbles and recoveries are
side-uncertain: the feed's `fumble_recovery_team` sometimes names the recovering player's opponent (a
quarterback's own recovery filed to the defence), so those events move to the team of the player's
side-certain events in the same game (299 events in 2025). Side-certain events are never moved, which keeps
every share denominator exact. Extra points carry a kicker name only (2014+: `xp_kicker_player_name`;
2009–13: separate "Extra Point Good/Missed" plays, name parsed from the text); the name resolves to the unique
kicker (FG, kickoff or punt) of either team in this or an earlier game of the season with that full-name
key, else that initial + last-name key: 94.3–98.8% of attempts through 2025, 86.2% in 2026 so far.

**Reliability.** `reliability(season, T=None, tg=None)` → per column `{id_coverage, events_per_team_game,
verdict, team_games}` from the games before T. Defensive rule: id coverage ≥ 0.80 (where the feed also sets
a flag) and id-carrying events per team-game ≥ half the 2009–2020 median (sacks 0.961, INT 0.448, PBU 0.843,
FF 0.269, FR 0.482); fewer than 20 team-games → INSUFFICIENT. Verdicts per season: AUDIT.md table 3.

`team_games(season, T=None)` returns the team-context rows alone (one per game × team). `coverage(season)`
returns the audit's table-2 numbers.

## 4. Player-week state (`state.py`)

`player_week_state(season, T, availability=None, include_roster=True) -> DataFrame` — one row per player on
a team's usage list or roster at T.

### Who gets a row (membership)

- **in_season**: every player with a game for the team this season before T (listed under his most recent
  team if he appeared for two).
- **week1** (the team has no game this season before T): the team's previous-season usage list, restricted
  to the players this season's roster lists for the same team (when a roster exists). Features are the
  previous season's.
- **roster_only**: rostered players with no game this season. On a team that has played, a skill player's
  share is a known zero; OL, defence and LS get no usage metric.

Rosters are snapshots, not point in time: `roster_pit` is always false and membership from a roster is
flagged. The 2026 ESPN roster was fetched 2026-09-21, so week-1 membership for 2026 is post hoc.

### Usage shares

The family's metric (`usage_metric`): QB `dropback_share` (non-garbage dropbacks), RB `carry_share`
(non-garbage rushes, quarterback runs in the denominator), WR / TE `target_share` (non-garbage targets),
K `kick_share` (FG + XP attempts), P `punt_share`, RETURNER `return_share`; front seven `sack_share` only
when `def_sacks` is RELIABLE at T; secondary `pd_share` (break-ups + interceptions) when both are RELIABLE,
else `pbu_share` when break-ups are; otherwise none (`usage_basis = production` for defensive shares: they
are production, not participation). OL and LS: none.

- `expected_usage_share` = Σ w_j c_j / Σ w_j D_j over the team's games this season before T, with
  w_j = 0.5^(age_j / h) (age 0 = the team's latest game; games the player missed count with c = 0).
- `recent_share` (the team's last 3 games), `season_share`, `previous_game_share`, with the counts
  `recent_usage_count, season_usage_count, recent_games_used`, `player_games`, `team_games`.

Half-lives h, TUNED on the dev seasons 2016–2023 (`config.assert_dev_only`) by the next-game share MAE of
every player on a team's usage list at every cut:

| family | last game | last 3 | season | h 0.35 | h 0.5 | h 0.75 | h 1 | h 1.5 | h 2 | h 3 | h 6 | **chosen** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QB (n 27,963) | **0.1193** | 0.1487 | 0.1767 | 0.1233 | 0.1276 | 0.1344 | 0.1401 | 0.1485 | 0.1541 | 0.1608 | 0.1684 | 0.35 |
| RB (56,948) | 0.0814 | 0.0802 | 0.0854 | 0.0790 | 0.0780 | **0.0775** | 0.0777 | 0.0786 | 0.0795 | 0.0809 | 0.0829 | 0.75 |
| WR (87,004) | 0.0635 | 0.0577 | 0.0588 | 0.0606 | 0.0590 | 0.0576 | 0.0571 | **0.0568** | 0.0569 | 0.0573 | 0.0579 | 1.5 |
| TE (30,861) | 0.0446 | 0.0398 | 0.0398 | 0.0424 | 0.0412 | 0.0401 | 0.0396 | **0.0392** | **0.0392** | **0.0392** | 0.0394 | 2 |

For QBs the last game wins outright; h = 0.35 keeps a little memory (MAE +0.004) so one injury-shortened
game does not zero a starter's expected share — the start question itself is carried by
`starter_probability`, not by the share. K, P, RETURNER and defence use h = 1.5.

### Depth rank

`depth_rank` = order within (team, family) by expected share, then season share, then recent count, then
id. It is the usage-derived depth chart (`depth_basis = usage_derived`, or `production_derived` for
defensive shares); null where the family has no metric (OL, LS, defence in unreliable seasons).

### Roles

`role` ∈ FULL-TIME STARTER, ROTATIONAL STARTER, ROTATIONAL, SPECIALIST, BACKUP, DEEP RESERVE, UNKNOWN, with
`role_basis`. For QB / RB / WR / TE, with s = expected share, k = usage slots (QB 1, RB 1, WR 3, TE 1):

- **evidence** = at least `MIN_RECENT_EVENTS` usage events of the family's kind in the team's last 3 games
  (QB 20, RB 12, WR 6, TE 5) **and** used in at least min(2, team games) of them. A share alone never makes a
  starter: a receiver targeted once, a quarterback with 4 dropbacks, a star with 8 snaps, all fail it.
- FULL-TIME STARTER: rank ≤ k, evidence, s ≥ t_full. ROTATIONAL STARTER: rank ≤ k, evidence, t_rot ≤ s <
  t_full. ROTATIONAL: s ≥ t_rot otherwise (`usage_share_low_volume` when evidence fails). BACKUP: some usage
  this season, s < t_rot. DEEP RESERVE: no usage this season on a team with ≥ 2 games. UNKNOWN: no evidence
  yet (team with < 2 games and no usage).
- K / P / RETURNER: SPECIALIST = the family's rank-1 with recent usage, BACKUP otherwise, DEEP RESERVE with
  none. LS: SPECIALIST by position only (`position_only_no_usage_data`).
- **OL and every defender: UNKNOWN** (`no_participation_data_ol` / `_defense`) — production shares are not
  participation.

Thresholds are estimated from the history of the calibration seasons (the 8 complete seasons before the
state's season), at every cut with ≥ 3 team games: **t_full = the 25th percentile of the expected share of
starter-slot holders** (rank ≤ k; three quarters of starters get at least this), **t_rot = t_full / 2** (a
rotational player gets at least half a low-end starter's share).

| family | t_full | t_rot | starter-slot share P25 / P50 | first backup (rank k+1) share P50 / P75 | n slots / n backups |
|---|---|---|---|---|---|
| QB | 0.9248 | 0.4624 | 0.925 / 0.993 | 0.002 / 0.058 | 9,610 / 9,007 |
| RB | 0.3563 | 0.1782 | 0.356 / 0.441 | 0.203 / 0.266 | 9,610 / 9,604 |
| WR | 0.1271 | 0.0636 | 0.127 / 0.173 | 0.068 / 0.093 | 28,830 / 9,571 |
| TE | 0.0601 | 0.0301 | 0.060 / 0.097 | 0.031 / 0.053 | 9,375 / 8,748 |

(Season 2026, trained on 2018–2025. The 2025 values, trained on 2017–2024, differ by < 0.006.) At
2025-10-14 the state holds 805 full-time starters, 160 rotational starters, 915 rotational, 1,391 backups,
1,085 specialists, 5,745 deep reserves and 24,923 UNKNOWN (OL, defence, LS-less rows, and roster players of
FCS teams whose games are not in the feed).

### Starter probability

`starter_probability` with `starter_probability_basis`:

- **QB, in season** (`qb_start_history`): P(the player starts the team's next game). For the starter of the
  team's latest game, by his consecutive-start streak (1, 2, 3–4, 5+) × whether he led the team in dropbacks
  that game; for every other QB, by his rank among the team's QBs (1, 2, 3+) × whether he started any of the
  last 3. Cells are smoothed toward their group (20 pseudo-counts). 2026 table (trained 2018–2025):

  | cell | P(start next) | n | | cell | P | n |
  |---|---|---|---|---|---|---|
  | last starter, streak 1, led | 0.824 | 2,390 | | not last starter, rank 1, no recent start | 0.500 | 491 |
  | streak 2, led | 0.875 | 1,673 | | rank 1, started one of last 3 | 0.468 | 178 |
  | streak 3–4, led | 0.913 | 2,430 | | rank 2, no recent start | 0.070 | 8,376 |
  | streak 5+, led | 0.934 | 4,643 | | rank 2, recent start | 0.186 | 1,715 |
  | streak 1 / 2 / 3–4 / 5+, **did not lead** (pulled or hurt) | 0.260 / 0.378 / 0.369 / 0.377 | 181 / 105 / 138 / 153 | | rank 3+, no / recent start | 0.022 / 0.162 | 6,827 / 336 |

- **QB, week 1** (`qb_start_history_week1`): last season's final starter, by roster confirmation — 0.697
  when this season's roster lists him for the team (n 893), 0.020 when not (608); other QBs by rank × roster.
- **Everyone else** (`usage_leader_next_game`, **usage-based, not a start**): P(the player is among his
  family's top-k by usage in the team's next game), by context × family × rank (1…k+2) × expected-share bucket
  (edges 0, .02, .05, .10, .15, .20, .30, .45, .60, .80, 1). K and P included (k = 1).
- A team's QB probabilities are scaled to sum ≤ 1 (WR ≤ 3); the remainder is a starter not on the usage list.
  The probability is history-based and **does not read the availability reports** — see §6.

**Calibration on held-out seasons** (fit on the 8 seasons before, predict every cut of the held-out season;
ECE = n-weighted |mean prediction − observed rate| over ten bins; Brier vs the base-rate Brier):

| held out | QB in season | RB | WR | TE | K / P | QB week 1 | others week 1 |
|---|---|---|---|---|---|---|---|
| 2023 (fit 2015–22) | ECE 0.016, Brier 0.084 vs 0.237 (n 3,971) | 0.011 (7,844) | 0.014 (11,681) | 0.016 (4,581) | 0.013 (4,768) | 0.025 (537) | 0.024 (2,195) |
| 2024 (fit 2016–23) | **0.009**, 0.072 vs 0.238 (4,167) | 0.011 (8,082) | 0.017 (12,282) | 0.016 (4,879) | 0.008 (5,025) | 0.014 (580) | 0.032 (2,106) |
| 2025 (fit 2017–24) | 0.012, 0.065 vs 0.232 (4,503) | 0.008 (8,318) | 0.018 (13,429) | 0.014 (5,291) | 0.006 (5,130) | **0.073** (609) | **0.125** (2,813) |
| 2026 live, in season (fit 2018–25) | 0.053, 0.059 vs 0.248 (911) | 0.024 (1,776) | 0.023 (2,714) | 0.029 (1,043) | 0.017 (814) | — | — |

Held-out 2024, QB in season: predicted 0.049 → observed 0.047 (n 2,186); 0.177 → 0.175 (268); 0.849 → 0.855
(557); 0.926 → 0.931 (1,003); the sparse middle bins (25–78 cuts) wander (0.38 → 0.16, 0.48 → 0.60). Every
Brier is well under its base rate. Two warnings: (1) **week 1 of 2025 is miscalibrated** (predicted 0.74 for
roster-confirmed last starters, observed 0.50) because the 2025 roster snapshot lists departed players
(AUDIT.md §4) — week-1 probabilities are only as good as the roster; (2) **2026 so far is under-confident**
for last starters (predicted 0.833, observed 0.903, n 411 after four weeks; the 2018–25 early-season rate is
0.876) — watch it as the season fills.

### Availability

`expected_availability` = play probability × game fraction, from the official reports (`availability`:
`None` → the repository's `football/availability/reports/<season>_*.json`; a list → exactly those; `[]` →
none). A report is knowledge from `published_at` (else `retrieved_at`) ≤ T; a failed read (`ok: false`) is not
a report. Per team, the report used is the latest known one **for the team's next game** (next kickoff ≥ T);
with none, the latest known for an earlier game, whose statuses are kept as `STALE_PRIOR_GAME:<status>` with
**no** probability. Status → play probability (declared, v2.weekly.availability's map with the report
vocabulary folded in): AVAILABLE / ACTIVE 1.0, PROBABLE 0.85, QUESTIONABLE 0.5, GAME TIME DECISION / GTD 0.5,
DOUBTFUL 0.2, OUT / SUSPENDED / TRANSFERRED / OUT FOR SEASON 0.0, OUT FIRST HALF plays (1.0) half a game
(expected 0.5). A player not named on a **comprehensive** next-game report is `NOT_LISTED` → 1.0 (the
conference's rule: silence means available). Otherwise `UNKNOWN` with a null probability — never 1.0.
Carried: `availability_status, play_probability, availability_basis, availability_source_tier` (1 =
official conference / team report), `availability_published_at, availability_status_age_hours` (T −
publication), `availability_report_game_id, availability_source`. The report's team is its `team_id`, else
its name matched to the game's schedule (exact, then a unique prefix), else the listed players' teams.

### Row schema (71 columns)

`player_week_state_id` (`cfbpws_` + h(player, team, season, T, rule)), `rule_version`
(`cfb_player_week_state_v1`), `personnel_rule_version`, `as_of`, `season, team_id, player_id, espn_id,
name, original_position, position_family, position_basis, position_source, unit, weekly_unit, context`
(in_season / week1 / roster_only), `usage_source, usage_metric, usage_basis, expected_usage_share,
recent_share, season_share, previous_game_share, recent_usage_count, season_usage_count, recent_games_used,
player_games, team_games, team_games_recent, role, role_basis, depth_rank, depth_basis,
starter_probability, starter_probability_basis, is_last_starter, qb_start_streak, qb_starts_recent,
qb_starts_season`, the availability block above, `next_game_id, next_game_kickoff,
prior_season_team_id, prior_season_share, prior_season_usage_metric, roster_listed, roster_team_id,
roster_pit, id_coverage, id_coverage_verdict` (of the family's attribution column at T),
`def_data_reliable, source_quality` (HIGH: in-season PBP with a reliable id column; MEDIUM: week-1 prior
season, or a weak id column; LOW: roster only or no metric), `freshness` (CURRENT = used in the team's last
game, RECENT = in its last 3, STALE, PRIOR_SEASON, ROSTER_ONLY), `player_last_game_ts, team_last_game_ts,
days_since_player_game`, **`player_value_mean, player_value_sd, replacement_value, value_model`** (null),
`value_status` (`NOT_MODELLED: value models are the next phase`), `calibration_train_seasons`,
`content_hash` (canonical hash of the row without its id).

## 5. Depth chart state

`depth_chart_state(season, T, availability=None, state=None)` — one row per team × position family:
`depth_chart_state_id` (`cfbdc_` + h(team, season, T, family, rule)), `rule_version, as_of, season,
team_id, position_family, unit, source` (always `usage_derived`), `ordering` (`usage_share`,
`production_share`, or `none` — OL, LS and defence without reliable data are listed unordered), `usage_metric,
confidence` (the leader's starter probability), `confidence_label` (HIGH ≥ 0.8, MEDIUM ≥ 0.6, LOW, UNKNOWN
when no calibrated probability, NONE when unordered), `confidence_basis, n_players, players` (JSON list in
order: player_id, name, depth_rank, expected_usage_share, role, starter_probability,
expected_availability).

## 6. What the next phases must know

1. **Entry point.** Read players through `player_week_state(season, T)`; never recompute usage from the
   play table. Value fields are null; fill them keyed by `player_id` and write `value_model`.
2. **QB.** `is_last_starter`, `qb_start_streak`, `qb_starts_recent`, `starter_probability` come from the same
   first-dropback rule as V2 stage 1 (`qb.py`), so they join to `qb_team` without translation. The
   starter probability already contains history's injury and benching rates; combining it with a report
   (`expected_availability`) must condition, not multiply blindly, or availability is counted twice.
3. **Units.** OL is UNKNOWN everywhere; the defence has production shares only where table 3 of the audit
   says RELIABLE, and none for the secondary in 2021–2024. Unit models must be uncertainty-first there, as
   DESIGN.md rule 5 says; a sack share is not a snap share.
4. **Receivers 2022–2024.** Target shares are exact over identified targets, but 21–31% of targets are
   unidentified (`id_coverage_verdict = WEAK`): the shares are fine, the counts are low.
5. **Week 1.** Membership comes from a roster snapshot that is not point-in-time; its quality varies (2025
   is bad). Backtests of week-1 lineups should treat the roster as the weak link and report week 1 apart.
6. **Transfers.** `transfers.known_from` is the only point-in-time date; roster-evidence transfers have none.
7. **Contaminants.** Stage-1 `qb_game` keeps all-star games and 'TEAM' passers; the personnel layer drops
   them. Filter before joining.
8. **Box aggregates** (tackles, TFL, hurries) are season totals: usable as last season's numbers only.
9. **Availability.** 2026 conference games only; the status map is declared, not calibrated. The weekly
   engine's `availability.snapshot` reads a `players` key the report files do not have (they use `rows`),
   so its unit counts are empty; `state.availability_state` reads `rows`.
10. **Rejected inputs.** `data/mline` QB fields (season hindsight), `availability/current.json`
    (overwritten), cfbfastR class years (flagged; never in `class_year`).
11. **Reproducibility.** Calibration tables and role thresholds for season S come from the 8 complete
    seasons before S and are cached as `calibration_<S>.json`; a held-out evaluation must fit on seasons
    before the one it scores (`state.reliability_table(train, holdout)`).
