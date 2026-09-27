# CFB player data audit and historical coverage

What the repository's player data can support, season by season, measured on the local files on
2026-09-27. Every number below is recomputed by the personnel modules; nothing is copied from a provider's
documentation. The definitions in section 8 are exact, so a number can be checked without running
anything.

```
cd football/cfb_v2/research
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out
python3 -m v2.personnel.usage              # table 2: play-by-play coverage, one JSON line per season
python3 -m v2.personnel.identity --audit   # tables 4-5: rosters per season, ESPN box columns
python3 -c "from v2.personnel import usage as U; print({S: {k: v['verdict'] for k, v in U.reliability(S).items()} for S in range(2009, 2027)})"   # table 3
python3 -c "from v2.personnel import state; print(state.availability_coverage(2026))"                                                             # table 6
python3 -m v2.personnel.identity           # identity quality (METHODS_FOUNDATION.md)
```

Sources read: ESPN play-by-play (`data/pbp/play_by_play_<Y>.parquet`, 2009–2026, the sportsdataverse
release), cfbfastR rosters (`data/v1/roster`, 2004–2025), cfbfastR play stats (`data/v1/pstats`,
2014–2025), ESPN rosters (`football/rosters/fbs_2025_espn.json`, `fbs_2026_espn.json`), ESPN player box season
aggregates (`football/data/box/<Y>.json`, 2022–2026), official availability reports
(`football/availability/reports/2026_*.json`), schedules (`data/sched`), V2 stage outputs.

## 1. Verdict per desired feature

AVAILABLE: in the data, usable as is. DERIVABLE: not a field, but computed exactly from fields that are.
PARTIAL: usable for some seasons, teams or columns only. NEW SOURCE REQUIRED: no local source carries it.
UNRELIABLE: present, but the values cannot be trusted where marked. REJECT: present, must not be used.

| # | feature | class | seasons usable | reason (measured) |
|---|---|---|---|---|
| 1 | Player identity across sources and transfers | AVAILABLE | 2009–2026 | One id: the ESPN athlete id is the id of the PBP, cfbfastR rosters and play stats, ESPN rosters and player box, and it survives a transfer. 0 of 511,603 alias rows needed a cross-provider id map. |
| 2 | Passer on every dropback | AVAILABLE | 2009–2026 | 97.4–99.9% of dropbacks carry a passer id (table 2). |
| 3 | Rusher on every rush | AVAILABLE | 2009–2026 | 96.6–99.2%. |
| 4 | Receiver on every target | PARTIAL | 2009–2021, 2025–2026 good; 2022–2024 weak | 82–89% of pass attempts carry a receiver id through 2021, then 78.9% (2022), 76.7% (2023), **68.6% (2024)**, 94.8–95.4% (2025–26). Shares use identified targets as the denominator; the verdict is flagged per season (`receiver_ids_reliable`). |
| 5 | QB starts | DERIVABLE | 2009–2026 | The passer on the team's first dropback (V2 stage 1's rule); identical to stage-1 `qb_game.starter` on 100% of team-games (tests). |
| 6 | Starts at any other position | NEW SOURCE REQUIRED | — | No lineup, starter or participation field for any non-QB position. What is derivable is a usage leader (top carry share, top-3 target share), named as such. |
| 7 | Sacks by player | AVAILABLE (2013 UNRELIABLE) | 2009–2012, 2014–2026 | 83–99% of sacks carry a sacker id. 2013: the feed tagged 0.03 sacks a team-game (V2 plays.SACKS_UNTAGGED), 30% with an id. |
| 8 | Split sacks (second sacker) | PARTIAL | 2009–2024 | 5.7–14.8% of sacks name a second sacker through 2024, **2.2% in 2025, 0.1% in 2026**: the provider stopped filling `sack_player_id2`, so from 2025 a split sack is a full sack for the first name. |
| 9 | Interceptions by player | UNRELIABLE 2021–23, 2025–26 | 2009–2020, 2024 | Interceptor id on 98–100% of interceptions through 2020, then 49.9%, 37.9%, 38.9% (2021–23), 88.6% (2024), 76.4% (2025), 62.8% (2026). |
| 10 | Pass break-ups by player | UNRELIABLE 2021–2024 | 2009–2020, 2025–2026 | 1.38–2.08 id-carrying break-ups a team-game through 2020, 0.13–0.35 in 2021–24 (the flag itself collapses with the ids), 1.62 / 2.91 in 2025–26. |
| 11 | Forced fumbles by player | UNRELIABLE 2021–2025 | 2009–2020, 2026 | 0.46–0.59 a team-game through 2020, 0.08–0.27 in 2021–25, 0.44 in 2026. |
| 12 | Fumble recoveries by player | AVAILABLE; provider's recovering team UNRELIABLE | 2009–2026 | 0.53–1.04 id-carrying recoveries a team-game (all above the floor). The feed's `fumble_recovery_team` sometimes names the opponent of the recovering player (a quarterback's own recovery filed to the defence): 41 events in 2016, 299 in 2025 are moved to the player's side-certain team (METHODS_FOUNDATION.md). |
| 13 | Fumbler | UNRELIABLE 2009–13, 2025–26 | 2014–2024 | Fumbler id on 17.7–20.9% of fumbles 2009–13, 91–92% 2014–20, 78–87% 2021–24, **48.7% (2025), 2.0% (2026)**. |
| 14 | Tackles, TFL, pressures by player, per game | NEW SOURCE REQUIRED | — | The PBP has no tackler or pressure-player field (`qb_hurry` is a flag with no player). |
| 15 | ESPN player box season aggregates (tackles, TFL, sacks, PD, hurries, INT, kicking, returns, QBR) | PARTIAL | 2024–2026 all columns; 2023 hurries/INT/kicking/returns; 2022 INT/punting/FG/QBR | Season totals with no game dates: **not point-in-time inside a season**, usable only as a completed prior season's aggregate (i.e. from 2025 on). Column usability is the box file's own measured coverage (table 5). |
| 16 | Snap counts | NEW SOURCE REQUIRED | — | None in any feed the repository reads. |
| 17 | Depth charts | NEW SOURCE REQUIRED (usage order DERIVABLE) | — | No provider depth chart. `state.depth_chart_state` orders players by expected usage share and is labelled `source = usage_derived`. |
| 18 | Offensive-line participation | NEW SOURCE REQUIRED | — | No OL field at all: OL players appear in the PBP only on fumble recoveries. Every OL row of the player-week state is role UNKNOWN. |
| 19 | Scrambles | UNRELIABLE | — | The ESPN text almost never says "scramble" (0–116 plays in a season of ~150,000). QB rushes are DERIVABLE: rush attempts by a player with a dropback in the same game (`qb_rush_att`). |
| 20 | Air yards / yards after catch | UNRELIABLE for history | 2025–2026, partially | Filled on ≤ 1.2% of plays before 2025; 15.8% / 9.1% of plays in 2025; 34.7% / 21.0% in 2026. |
| 21 | Per-player EPA, success, explosives, red-zone touches, first downs | AVAILABLE | 2009–2026 | `EPA`, `EPA_success`, `EPA_explosive` (one EP model for every season), `start.yardsToEndzone`, `first_down_created`. |
| 22 | Garbage time | DERIVABLE | 2009–2026 | V2's declared rule (`common.garbage_mask`, quarter and score only); raw and non-garbage counts are both stored. |
| 23 | Field-goal kicker | AVAILABLE | 2009–2026 | 98.4–100%. |
| 24 | Extra-point kicker | DERIVABLE | 2009–2026 | Name only (no id in any season; before 2014 a separate "Extra Point Good/Missed" play whose text names the kicker). Resolved to an id point-in-time: 94.3–98.8% of attempts 2009–2025, 86.2% in 2026 so far. |
| 25 | Punter, net punting | AVAILABLE / DERIVABLE | 2009–2026 | Punter id 97.6–99.5%; net yards = gross − return yards (touchbacks count 20). |
| 26 | Kickoff kicker | PARTIAL | 2014–2024 | 74–79% (2009–13), 96–99.5% (2014–24), **57.2% (2025), 1.5% (2026)**. |
| 27 | Kick and punt returners | AVAILABLE | 2012–2026 (KR), 2009–2026 (PR) | Returner id on 91.7–100% of returned kicks from 2012 (70.8–73.3% 2009–11; 89.4% in 2023) and 86.8–98.7% of returned punts. |
| 28 | Kick blockers | UNRELIABLE | — | 35–83% of blocked kicks name a blocker; 0 of 55 in 2026. |
| 29 | cfbfastR rosters | PARTIAL | 2016–2025 good; 2009–2015 partial | 2009–2015 list 36–52% of players under legacy **negative** ids that no play carries, so only 82.0–90.0% of the season's PBP players are found on it; 97.7–100% from 2016. Season snapshots, **not point-in-time**. |
| 30 | ESPN 2025 roster file | UNRELIABLE for membership | — | It is the season's "core athletes" list fetched 2026-08-26: 14.8% of its players who played in 2025 are listed for a different team than the one they played for, and it lists 2,476 of the 3,673 players of 2024 who never played in 2025 at their 2024 school (cfbfastR's 2025 roster: 782). cfbfastR's 2025 roster agrees with the games 99.4%, so it outranks the ESPN file for 2025. Names and positions from the ESPN file are still usable. |
| 31 | ESPN 2026 roster | AVAILABLE (current snapshot) | 2026 | 15,780 players, 138 FBS teams, class 99.97%, position 100%, fetched 2026-09-21 (a snapshot, not point-in-time for earlier 2026 instants; FBS only, so 71.3% of 2026 PBP players, who include FCS opponents, are on it). |
| 32 | Position | AVAILABLE | 2009–2026 | 91–100% of roster rows carry one. 29,040 registry players only ever carry a generic label (OL / DL / DB), which stays generic (`*_OTHER`). |
| 33 | Class year | UNRELIABLE (cfbfastR); AVAILABLE for 2026 only (ESPN) | 2026 | cfbfastR's `year` equals the **season number** on 100% of rows through 2011, 49.5% in 2017, 0.9–6.1% from 2020, and is otherwise the eventual class. ESPN 2026 class is 99.97% filled and is used for 2026 only. |
| 34 | Height, weight | AVAILABLE 2017+; PARTIAL 2009–2016 | 2009–2026 | Height 90–95%, weight 49–79% of rows 2009–16; 94–99% from 2017. |
| 35 | Per-player recruiting | NEW SOURCE REQUIRED | — | `recruit_ids` is empty on 100% of roster rows in every season 2004–2025. |
| 36 | Transfers | DERIVABLE | 2010–2026 | A change of modal team between seasons, on the one id: 437 / 613 / 730 / 979 / 1,261 / 1,203 transfers with games at both schools in 2021–26 (136 quarterbacks into 2026). |
| 37 | Portal entry / commitment dates | NEW SOURCE REQUIRED | — | None anywhere; ESPN `previous_school` is empty on 100% of 2026 rows. A transfer is known from the player's first game for the new team, or from a (non-point-in-time) roster listing. |
| 38 | Pregame availability (official reports) | PARTIAL | 2026 conference games | 117 report files, 78 readable, 43 games, 565 player rows (OUT 486, QUESTIONABLE 44, GAME TIME DECISION 35). 64 of the 78 were published before kickoff; **none was retrieved before kickoff** (median 6.2 h after), so knowledge is gated on `published_at`. |
| 39 | Historical injury / availability reports | NEW SOURCE REQUIRED | — | Nothing before 2026. |
| 40 | `football/availability/current.json` | REJECT for history | — | Overwritten live artifact: it holds only the latest state. |
| 41 | Supabase `cfb_player_availability` | REJECT | — | Never written. |
| 42 | `data/mline` QB fields (`*_qb_name`, `*_returning_qb`, `*_qb_starter_years`, `*_qb_games`) | REJECT | — | Season hindsight (the season's eventual QB, whole-season games). |
| 43 | Team talent / returning production (`data/talent`, `data/retprod`) | out of scope | — | Team-level aggregates (V2 team features), no player ids. |

## 2. Play-by-play coverage by season

tg = team-game. Percentages are shares (section 8 defines each). "TEAM events" are player-role events the feed
filed under a negative "TEAM" placeholder id; "all-star games" are the all-star / offseason games removed.

| season | games | passer id % | rusher id % | receiver id % | sacks / tg | sack id % | split sacks % | INT / tg | INT id % | PBU id / tg | FF id / tg | FR id / tg | fumbler id % | FG kicker id % | XP attempts | XP kicker resolved % | punter id % | kickoff kicker id % | KR id % | PR id % | blocked kicks | blocker id % | TEAM events | all-star games |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2009 | 786 | 97.4 | 97.4 | 82.0 | 1.94 | 83.0 | 8.7 | 0.95 | 98.8 | 1.39 | 0.46 | 0.93 | 17.9 | 99.3 | 4846 | 97.3 | 97.6 | 76.4 | 73.3 | 95.0 | 169 | 35.5 | 0 | 2 |
| 2010 | 786 | 98.0 | 97.5 | 82.7 | 1.98 | 93.3 | 8.3 | 0.98 | 98.9 | 1.43 | 0.48 | 0.93 | 17.7 | 99.7 | 5082 | 97.1 | 98.0 | 74.4 | 70.8 | 94.7 | 168 | 45.8 | 0 | 2 |
| 2011 | 799 | 97.8 | 96.6 | 84.3 | 1.91 | 92.4 | 10.7 | 0.91 | 98.4 | 1.41 | 0.59 | 0.97 | 19.2 | 98.4 | 5317 | 96.1 | 98.0 | 74.0 | 72.4 | 94.3 | 176 | 35.8 | 0 | 3 |
| 2012 | 823 | 98.3 | 96.9 | 86.4 | 1.97 | 94.0 | 10.5 | 0.91 | 99.1 | 1.38 | 0.59 | 1.00 | 18.1 | 99.2 | 5708 | 94.3 | 98.3 | 74.6 | 91.7 | 94.8 | 174 | 36.2 | 0 | 3 |
| 2013 | 855 | 98.7 | 97.6 | 85.1 | 0.03 | 30.2 | 5.7 | 0.96 | 99.2 | 1.45 | 0.53 | 0.80 | 20.9 | 99.4 | 6122 | 95.5 | 99.0 | 78.8 | 98.6 | 92.5 | 180 | 35.0 | 0 | 3 |
| 2014 | 850 | 99.7 | 98.3 | 88.0 | 2.07 | 89.1 | 11.2 | 0.91 | 99.7 | 1.58 | 0.54 | 1.00 | 91.1 | 99.8 | 5820 | 98.7 | 99.5 | 96.3 | 99.2 | 98.5 | 164 | 60.4 | 168 | 3 |
| 2015 | 862 | 99.6 | 97.7 | 88.3 | 2.02 | 98.7 | 12.8 | 0.90 | 99.5 | 1.87 | 0.59 | 1.04 | 91.9 | 99.9 | 5885 | 98.4 | 99.1 | 99.5 | 99.6 | 98.2 | 178 | 75.3 | 131 | 3 |
| 2016 | 855 | 99.7 | 97.9 | 87.8 | 2.07 | 98.9 | 13.2 | 0.87 | 99.9 | 1.95 | 0.55 | 0.97 | 91.7 | 99.9 | 5912 | 98.3 | 99.5 | 99.2 | 99.6 | 98.3 | 170 | 74.1 | 1331 | 2 |
| 2017 | 869 | 99.7 | 98.1 | 88.2 | 2.04 | 97.6 | 12.9 | 0.86 | 99.9 | 2.07 | 0.57 | 0.96 | 91.7 | 99.8 | 5783 | 97.6 | 99.3 | 98.8 | 99.6 | 98.2 | 154 | 74.7 | 1304 | 3 |
| 2018 | 881 | 99.6 | 98.0 | 88.2 | 2.09 | 98.0 | 12.2 | 0.84 | 99.7 | 2.08 | 0.53 | 0.98 | 91.8 | 99.8 | 5996 | 97.5 | 99.5 | 99.2 | 99.8 | 97.6 | 187 | 70.1 | 1376 | 3 |
| 2019 | 887 | 99.7 | 97.9 | 88.6 | 2.09 | 98.4 | 14.8 | 0.79 | 99.8 | 2.00 | 0.50 | 0.88 | 91.9 | 100 | 5847 | 98.2 | 99.3 | 98.9 | 99.4 | 98.7 | 128 | 74.2 | 1300 | 3 |
| 2020 | 564 | 99.7 | 98.1 | 88.9 | 2.15 | 99.1 | 12.1 | 0.83 | 98.0 | 1.79 | 0.51 | 0.87 | 92.4 | 99.9 | 3780 | 97.0 | 99.4 | 99.2 | 98.7 | 96.6 | 97 | 82.5 | 805 | 1 |
| 2021 | 839 | 98.6 | 98.0 | 81.8 | 2.11 | 88.9 | 10.7 | 0.80 | 49.9 | 0.35 | 0.27 | 0.53 | 78.3 | 99.9 | 5451 | 98.8 | 98.8 | 98.1 | 99.1 | 96.4 | 146 | 58.9 | 989 | 3 |
| 2022 | 857 | 98.7 | 97.8 | 78.9 | 2.06 | 88.1 | 11.0 | 0.81 | 37.9 | 0.19 | 0.15 | 0.73 | 86.7 | 99.4 | 5398 | 97.1 | 98.8 | 98.8 | 99.1 | 96.3 | 170 | 48.8 | 1033 | 4 |
| 2023 | 903 | 98.6 | 97.9 | 76.7 | 1.98 | 85.9 | 11.3 | 0.81 | 38.9 | 0.18 | 0.08 | 0.76 | 85.7 | 99.3 | 5564 | 97.7 | 98.9 | 98.7 | 89.4 | 86.8 | 140 | 45.7 | 883 | 0 |
| 2024 | 946 | 99.3 | 97.9 | 68.6 | 1.91 | 89.4 | 11.8 | 0.75 | 88.6 | 0.13 | 0.08 | 0.53 | 87.4 | 99.1 | 5842 | 97.1 | 98.9 | 98.7 | 98.4 | 98.6 | 151 | 51.7 | 558 | 0 |
| 2025 | 956 | 99.9 | 99.1 | 94.8 | 1.94 | 88.8 | 2.2 | 0.74 | 76.4 | 1.62 | 0.25 | 0.82 | 48.7 | 100 | 5765 | 97.6 | 99.0 | 57.2 | 99.7 | 98.2 | 166 | 42.2 | 127 | 0 |
| 2026 | 323 | 99.8 | 99.2 | 95.4 | 1.75 | 94.2 | 0.1 | 0.68 | 62.8 | 2.91 | 0.44 | 0.79 | 2.0 | 99.9 | 2012 | 86.2 | 98.4 | 1.5 | 100 | 91.7 | 55 | 0 | 11 | 0 |

2026 is the season to date (games through 2026-09-26).

## 3. Column reliability verdicts (what `usage.reliability` returns for the full season)

A defensive column is RELIABLE when, over the games before the instant asked about, **both** its id coverage
is at least 80% (where the feed also sets a flag) **and** its id-carrying events per team-game are at least
half the 2009–2020 median (sacks 0.961, interceptions 0.448, break-ups 0.843, forced fumbles 0.269,
recoveries 0.482; medians 1.922 / 0.897 / 1.687 / 0.537 / 0.965). Fewer than 20 team-games before the
instant is INSUFFICIENT. Offensive / special-teams attribution columns are RELIABLE at ≥ 80% id coverage,
otherwise *weak*; *absent* = the feed has no such event. `player_games` carries the verdict of its own
instant as `<column>_reliable`, and the player-week state never builds a share from an unreliable column.

| season | def_sacks | def_ints | def_pbu | def_ff | def_fr | receiver | fumbles | kickoffs | xp |
|---|---|---|---|---|---|---|---|---|---|
| 2009 | ok | ok | ok | ok | ok | ok | weak | weak | ok |
| 2010 | ok | ok | ok | ok | ok | ok | weak | weak | ok |
| 2011 | ok | ok | ok | ok | ok | ok | weak | weak | ok |
| 2012 | ok | ok | ok | ok | ok | ok | weak | weak | ok |
| 2013 | **UNRELIABLE** | ok | ok | ok | ok | ok | weak | weak | ok |
| 2014 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2015 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2016 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2017 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2018 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2019 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2020 | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 2021 | ok | **UNRELIABLE** | **UNRELIABLE** | **UNRELIABLE** | ok | ok | weak | ok | ok |
| 2022 | ok | **UNRELIABLE** | **UNRELIABLE** | **UNRELIABLE** | ok | weak | ok | ok | ok |
| 2023 | ok | **UNRELIABLE** | **UNRELIABLE** | **UNRELIABLE** | ok | weak | ok | ok | ok |
| 2024 | ok | ok | **UNRELIABLE** | **UNRELIABLE** | ok | weak | ok | ok | ok |
| 2025 | ok | **UNRELIABLE** | ok | **UNRELIABLE** | ok | ok | weak | weak | ok |
| 2026 | ok | **UNRELIABLE** | ok | ok | ok | ok | weak | weak | ok |

Consequence for the defence: a front-seven usage share (sack share) exists in every season but 2013; a
secondary share exists as pass-defended share (break-ups + interceptions) in 2009–2020 and as break-up share
in 2025–2026; **2021–2024 have no usable secondary production at all**. Neither is participation.

## 4. Rosters by season (cfbfastR; the join to the play-by-play)

| season | rows | teams | negative ids % | dup-id rows | position % | height % | weight % | class = season number % | class in 1–5 % | recruit ids % | PBP players | on same-season roster % | on it for the modal team % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2004 | 3620 | 161 | 0 | 2 | 0 | 0 | 0 | 100 | 0 | 0 | | | |
| 2005 | 4146 | 171 | 0 | 2 | 1.7 | 1.6 | 0 | 100 | 0 | 0 | | | |
| 2006 | 4367 | 181 | 0 | 2 | 13.3 | 13.1 | 2.3 | 100 | 0 | 0 | | | |
| 2007 | 4698 | 190 | 0 | 2 | 29.3 | 29.1 | 4.6 | 100 | 0 | 0 | | | |
| 2008 | 4798 | 193 | 0 | 0 | 51.9 | 51.7 | 6.9 | 100 | 0 | 0 | | | |
| 2009 | 13747 | 197 | 51.8 | 0 | 91.1 | 90.2 | 51.2 | 100 | 0 | 0 | 5927 | 82.0 | 81.9 |
| 2010 | 14253 | 200 | 50.7 | 0 | 91.7 | 90.6 | 50.2 | 100 | 0 | 0 | 6037 | 84.1 | 83.9 |
| 2011 | 14508 | 204 | 50.8 | 0 | 93.0 | 90.9 | 50.7 | 100 | 0 | 0 | 6124 | 84.1 | 84.0 |
| 2012 | 14966 | 208 | 49.1 | 6 | 94.5 | 90.9 | 49.4 | 99.5 | 0.5 | 0 | 6311 | 84.1 | 84.0 |
| 2013 | 15566 | 216 | 46.0 | 6 | 97.0 | 90.8 | 52.5 | 98.4 | 1.6 | 0 | 6170 | 90.0 | 89.9 |
| 2014 | 16178 | 221 | 41.9 | 4 | 97.9 | 92.2 | 60.7 | 92.2 | 7.8 | 0 | 7176 | 82.6 | 82.3 |
| 2015 | 16426 | 224 | 36.0 | 6 | 98.5 | 94.1 | 69.9 | 81.5 | 18.5 | 0 | 7336 | 86.0 | 85.3 |
| 2016 | 18068 | 226 | 22.0 | 14 | 95.9 | 93.5 | 79.2 | 68.1 | 31.9 | 0 | 7492 | 98.0 | 97.4 |
| 2017 | 17907 | 225 | 17.7 | 14 | 100 | 99.4 | 98.9 | 49.5 | 50.4 | 0 | 7437 | 98.3 | 97.7 |
| 2018 | 17940 | 228 | 12.5 | 14 | 97.5 | 96.4 | 95.7 | 30.6 | 69.2 | 0 | 7904 | 97.8 | 97.3 |
| 2019 | 18794 | 217 | 3.0 | 2 | 97.1 | 95.8 | 95.5 | 15.2 | 84.6 | 0 | 7798 | 99.0 | 98.7 |
| 2020 | 16458 | 144 | 0 | 78 | 99.4 | 99.2 | 99.3 | 0.9 | 98.8 | 0 | 5633 | 97.7 | 97.0 |
| 2021 | 18698 | 227 | 0 | 392 | 96.5 | 96.1 | 96.1 | 6.1 | 93.7 | 0 | 6837 | 98.4 | 97.1 |
| 2022 | 30401 | 307 | 0 | 4 | 97.8 | 97.3 | 97.3 | 2.3 | 97.5 | 0 | 7017 | 100 | 99.3 |
| 2023 | 22465 | 304 | 0 | 2 | 94.4 | 94.1 | 94.2 | 5.7 | 94.3 | 0 | 7112 | 99.5 | 98.9 |
| 2024 | 22843 | 308 | 0 | 12 | 94.5 | 94.3 | 94.4 | 5.5 | 94.5 | 0 | 7672 | 99.1 | 98.4 |
| 2025 | 30072 | 315 | 0 | 8 | 97.2 | 96.5 | 96.2 | 2.8 | 97.0 | 0 | 8488 | 100 | 99.3 |
| 2026 | | | | | | | | | | | 6685 | 71.3 | 71.1 |

(2025 and 2026 roster joins include the ESPN files; 2026 is ESPN only, FBS only.)

Roster membership as a week-1 signal is itself season-dependent. Of the players on a team's previous-season
usage list (anyone with a play), the new season's roster lists 52–61% for the same team in 2012–2019 and
2022–2024 (67–74% in 2020–21, the COVID eligibility years), and of those listed, 50–57% record a play in the
team's first game in 2012–2019 and 39–47% in 2020–2024, but only **32.1% in 2025**, when the snapshot lists
69.5%: the 2025 roster keeps players who had left. The week-1 starter probabilities are well calibrated on
2023 and 2024 and degrade on 2025 for that reason (METHODS_FOUNDATION.md).

## 5. ESPN player box season aggregates

| season | player rows | players | usable columns (the file's own coverage check) | failed columns |
|---|---|---|---|---|
| 2022 | 40,598 | 7,558 | field goals, interceptions, punting, QBR | tackles, solo, TFL, sacks, passes defended, hurries |
| 2023 | 57,239 | 9,562 | extra points, field goals, hurries, interceptions, kick/punt returns, punting, QBR | tackles, solo, TFL, sacks, passes defended |
| 2024 | 78,993 | 12,473 | all 13 | — |
| 2025 | 80,496 | 12,755 | all 13 | — |
| 2026 | 28,210 | 11,243 | all 13 (season to date, generated 2026-09-27) | — |

The box file is a season total with a `games` count and no dates: inside a season it is not point-in-time,
so the personnel state does not read it. It is the only source of tackles, TFL and hurries by player.

## 6. Availability reports (2026)

| files | readable (`ok`) | games | player rows | OUT | QUESTIONABLE | GAME TIME DECISION | with `published_at` | published ≤ kickoff | retrieved ≤ kickoff | retrieved − kickoff, median |
|---|---|---|---|---|---|---|---|---|---|---|
| 117 | 78 | 43 | 565 | 486 | 44 | 35 | 78 | 64 | 0 | 6.2 h |

The 39 unreadable files are refused reads (`ok: false`, mostly "the document carries no publication date")
and carry no rows. Note for the weekly engine: the report files keep players under `rows`, not `players`
(`v2/weekly/availability.py` reads `players`, so its per-unit counts come out empty); `state.py` reads `rows`.

## 7. Identity

One id system and 109,232 canonical players over 2009–2026 (57,301 with at least one play, 51,931 roster-only).
Quality numbers (same id with several names, same name with several ids, collisions that block resolution)
are in METHODS_FOUNDATION.md "identity quality". Contaminants removed: 38 all-star / offseason games
(seasonType 4 or teams 3144/3145/3146/3147/3193/3194/3197/3198/125290/125291), 10,016 play-role events filed
under a negative "TEAM" id (2014–2026), the legacy negative roster ids (up to 51.8% of a 2009–2015 roster),
duplicate roster rows (392 in 2021), and the player-stats placeholder ids 1 / 3 / 13 (0 occurrences in the local
2014–2025 player-stats files; the filter stays).

## 8. Definitions (exact)

Play filters. A play is used when `pos_team_id` and `def_pos_team_id` are present, `text_dupe` is false, and
its game is not an all-star / offseason game (any play of the game has `seasonType` = 4, or either side or
either listed home/away team is one of the ids above). A **live** play has `penalty_no_play` false. A
**scrimmage** play is live, has `rush` or `pass` true and has `EPA` present (V2 stage 1). A **dropback** is a
scrimmage play with `pass` true (sacks included); a **pass attempt** is a dropback with `sack` false; a
**rush** is a scrimmage play with `rush` true and `pass` false. A **team-game** (tg) is a distinct
(`game_id`, `pos_team_id`). A **valid player id** is numeric, greater than 100 and not 1, 3 or 13 (negative
ids are the feed's "TEAM" placeholder).

Table 2. passer id % = dropbacks with a valid `passer_player_id` / dropbacks. rusher id % = rushes with a valid
`rusher_player_id` / rushes. receiver id % = pass attempts with a valid `receiver_player_id` / pass attempts.
sacks / tg = dropbacks with `sack` true / team-games. sack id % = those with a valid `sack_player_id` / sacks.
split sacks % = sacks with a valid `sack_player_id2` / sacks. INT / tg = live plays with `int` true /
team-games; INT id % = those with a valid `interception_player_id` / those. PBU id / tg, FF id / tg, FR id / tg
= live plays with a valid `pass_breakup_player_id`, `fumble_forced_player_id`, `fumble_recovered_player_id` /
team-games. fumbler id % = live plays with `fumble_vec` true and a valid `fumble_player_id` / live plays with
`fumble_vec` true. FG kicker id %, punter id %, kickoff kicker id % = live plays with `fg_attempt` / `punt` /
`kickoff_play` true and a valid `fg_kicker_player_id` / `punter_player_id` / `kickoff_player_id` / those
plays. XP attempts = plays with `xp_attempt` true plus plays typed "Extra Point Good" or "Extra Point Missed"
without it (before 2014). XP kicker resolved % = attempts whose kicker name resolves, point-in-time, to
exactly one id (METHODS_FOUNDATION.md) / XP attempts. KR id % (PR id %) = live kickoff (punt) plays whose
text contains "return", "returns" or "returned" followed by "for", "by" or "of", with a valid
`kickoff_return_player_id` (`punt_return_player_id`) / those plays. blocked kicks = plays typed "…Blocked…"
or kicking plays whose text contains the word "blocked"; blocker id % = those with a valid
`fg_block_player_id` or `punt_block_player_id`. TEAM events = player-role events (every role of table 2)
whose id is not valid. all-star games = games removed by the filter.

Table 4. rows = roster file rows; teams = distinct `team` names; negative ids % = rows with `athlete_id` < 0;
dup-id rows = rows whose `athlete_id` appears more than once in the file; position / height / weight % =
rows with the field filled (numeric for height and weight); class = season number % = rows whose `year` equals
the season; class in 1–5 % = rows with `year` 1–5; recruit ids % = rows with `recruit_ids` filled. PBP
players = distinct valid ids in the season's player-games; on same-season roster % = share of them listed
(any team) on that season's cfbfastR or ESPN roster; on it for the modal team % = share listed for the team
they played the most games for.

Table 6. files = `football/availability/reports/2026_*.json`; readable = `ok` true; published / retrieved ≤
kickoff compares `published_at` / `retrieved_at` with the report's `kickoff`.

## 9. Data sources that would most improve player modeling

Ranked by expected value to the personnel system: what each would unlock that is UNKNOWN today, weighted by
how directly it reaches the margin and whether it could be backtested.

1. **Snap counts** (per player-game, ideally with alignment). The single largest gap: participation for every
   position. Today 100% of offensive-line rows and every defensive row are role UNKNOWN, and 2021–2024 have no
   usable secondary data at all (table 3). Snap counts turn usage shares into participation shares, give
   real starts at every position, measure OL and defensive continuity and rotation depth, and make the unit
   backtests possible. A historical archive (2014+) would make them backtestable at once.
2. **Depth charts** (published weekly, timestamped). The pregame lineup a team intends, above all at
   quarterback, where the measured effects are largest (starter → backup −1.44 pts, n = 958; first-time
   starter −3.30, n = 158). The usage-derived starter probability is calibrated (held-out ECE ≈ 0.01) but it
   only says what history implies after the last start; a depth chart names the planned change the week it
   happens. Only a timestamped archive is point-in-time.
3. **Offensive-line participation** (the starting five per game). OL continuity is the largest unit the system
   cannot measure (the OL never appears in the play-by-play). Largely subsumed by snap counts; cheaper if only
   starters are recorded.
4. **Historical injury / availability reports.** The status → play-probability map is declared, not
   calibrated, because the only reports are 43 games of 2026. A history (2025 and earlier where conferences
   published) would calibrate it and backtest pregame availability; its value is capped by how little was
   published before the 2025 mandates.
5. **Per-player recruiting** (ratings with an id crosswalk; `recruit_ids` is empty). A prior for the players
   with no usage history (freshmen, backups, transfers into a new role): the replacement-level question.
   Team talent already exists; the gain is at the player margin.
6. **Portal dates** (entry and commitment). Today a transfer is known from the first game at the new school,
   or from a roster snapshot that is not point-in-time. Dates would move that knowledge into the offseason
   (week-1 rosters); in-season value is small because teams rarely change in-season.
