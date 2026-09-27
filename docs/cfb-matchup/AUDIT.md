# CFB scheme and matchup engine: scheme-data audit

Code: `football/cfb_v2/research/v2/matchup/audit.py` (coverage) and `style.split_half_reliability`.
Outputs: `$CFB_V2_OUT/matchup/audit.json`, `$CFB_V2_OUT/matchup/reliability_dev.json`. The canonical build is
`CFB_V2_OUT=research/out_h`, the V2.1 / fv2 build.

```
cd football/cfb_v2/research
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
python3 -m v2.matchup.audit          # every season 2009-2026, ~15 s
```

## Verdict

**The play-by-play supports a solid behavioral style model, but not a scheme model.** These are all
measurable in every season:

- run/pass choice, conditioned on the game situation;
- tempo, from the drive clock;
- QB rushing (designed runs and scrambles pooled);
- explosive plays;
- trench outcomes, from yardage;
- sacks;
- 4th-down decisions;
- field position and finishing drives.

What makes a *scheme* is not in any historical season: personnel groupings, formations, motion,
play-action, RPO, blitz, box counts and coverage. The 2025-2026 gamebook text adds formation (shotgun /
no-huddle), pass depth / direction, run direction and QB hurries. Those fields have no training history,
so they can be displayed live but cannot be validated. The status counts over 44 desired fields are:

| status | fields |
|---|---|
| DERIVABLE | 20 |
| PARTIAL | 9 |
| UNAVAILABLE (new source required) | 12 |
| UNRELIABLE | 1 |
| REJECT | 2 |

No field is AVAILABLE as a clean, provider-computed column. Everything usable is derived from raw
yardage, down, distance, score, clock and player ids. The provider's derived columns either drift or
read the spread.

## 1. Coverage by season (measured, not assumed)

Scrimmage plays = rush or pass, not a no-play penalty, EPA present (V2's set). Rates are per scrimmage
play unless a denominator is named.

| season | plays | qb_hurry / dropback | PBU / dropback | pass_depth present | rush_direction present | "shotgun" in text | "no huddle" in text | "play action" in text | distinct per-play clock within a drive | drive clock valid | drive sec / snap (median) | QB share of rushes | sack / dropback | provider stuffed_run | stuff from yardage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2009 | 106,689 | 0.014 | 0.044 | 0.010 | 0.084 | 0 | 0 | 0 | 0.66 | 0.996 | 26.5 | 0.182 | 0.059 | 0.192 | 0.204 |
| 2012 | 117,477 | 0.015 | 0.043 | 0.008 | 0.069 | 0 | 0 | 0 | 0.71 | 0.999 | 25.0 | 0.179 | 0.057 | 0.182 | 0.192 |
| 2013 | 119,748 | 0.019 | 0.048 | 0.008 | 0.077 | 0 | 0 | 0 | 0.66 | 0.998 | 24.7 | 0.192 | **0.001** | 0.179 | 0.189 |
| 2014 | 121,837 | **0** | 0.050 | 0 | 0 | 0 | 0 | 0 | 0.65 | 0.999 | 25.0 | 0.192 | 0.060 | 0.177 | 0.193 |
| 2016 | 121,819 | 0 | 0.058 | 0 | 0 | 0 | 0 | 0 | 0.54 | 1.000 | 25.0 | 0.192 | 0.062 | 0.177 | 0.192 |
| 2019 | 122,449 | 0 | 0.061 | 0 | 0 | 0 | 0 | 0 | 0.49 | 1.000 | 26.0 | 0.202 | 0.063 | 0.181 | 0.194 |
| 2021 | 113,962 | 0 | **0.011** | 0 | 0 | 0 | 0 | 0 | 0.60 | 1.000 | 26.2 | 0.182 | 0.064 | 0.153 | 0.163 |
| 2023 | 118,461 | 0 | 0.006 | 0.001 | 0.006 | 0.001 | 0.001 | 0 | 0.53 | 0.999 | 27.0 | 0.206 | 0.061 | 0.142 | 0.168 |
| 2024 | 123,988 | 0 | 0.004 | 0 | 0.002 | 0 | 0 | 0 | 0.85 | 1.000 | 27.3 | 0.205 | 0.059 | 0.147 | 0.173 |
| 2025 | 126,095 | 0.036 | 0.051 | 0.389 | 0.418 | 0.399 | 0.264 | 0 | 0.90 | 1.000 | 27.2 | 0.226 | 0.060 | 0.127 | 0.183 |
| 2026 | 39,753 | 0.077 | 0.099 | 0.906 | 0.972 | 0.926 | 0.580 | 0 | 0.91 | 1.000 | 27.7 | 0.201 | 0.058 | **0.077** | 0.175 |

Every season 2009-2026 is in `audit.json`. What the table shows:

- **Pressure (`qb_hurry`) is not a history.** It is tagged in about 1.5% of dropbacks in 2009-2013,
  **never** in 2014-2024, and again in 2025 (3.6%) and 2026 (7.7%, still settling).
- **Pass break-ups are a season effect.** They swing from 6% to 0.4% of dropbacks and back (2021-2024
  vs 2025-2026). So "classic havoc" is UNRELIABLE, and V2's front havoc (sacks + run TFLs from
  yardage) is the usable version.
- **The provider's `stuffed_run` drifts: 0.19 → 0.08.** A stuff computed from `statYardage` is stable
  at 0.16-0.20. V2 already recomputes it; the audit confirms the decision.
- **Per-play clocks are not usable before 2024.** The clock is stamped per DRIVE in older seasons:
  only 49-71% of plays within a drive have a distinct start clock before 2024, against 85-91% after.
  So per-play seconds are unusable across seasons. The **drive elapsed time is valid in 99.6-100% of
  drives in every season**, so tempo is DERIVABLE as drive clock seconds per snap. The level moves
  with the 2023 clock rule (25-26 s → 27+ s), which is why tempo is season-normalized.
- **Formation, depth, direction and no-huddle exist only in the new gamebook text.** That text starts
  part-way through 2025 (39-42% of plays) and covers ~90-97% of 2026. There is no history to
  validate against.
- **"Scramble" and "play action" never appear in the text of any season.** RPO is not in the text
  (the few `rpo` string hits are names). Motion, blitz, coverage, under-center and pistol: 0 hits
  in 2026.
- **The 2013 sack column is empty (0.001 per dropback).** V2's `SACKS_UNTAGGED` rule applies: every
  pass/rush split of 2013 (PROE, QB rushing) is missing, never zero.

## 2. The desired fields (brief sections 1, 3, 4)

| field | side | status | how it is derived (or why not) |
|---|---|---|---|
| run/pass tendency | off | DERIVABLE | pass rate; PROE = passes minus expected passes (own model). 2013 contaminated (sacks untagged) |
| early-down run/pass rate | off | DERIVABLE | `ed_proe`: neutral 1st/2nd-down PROE |
| neutral-situation pass rate | off | DERIVABLE | `neu_pass` (\|margin\| ≤ 10, Q1-3, not the last 2:00 of a half) and `proe` (state-conditioned). The provider `xpass` is not used |
| play-action | off | UNAVAILABLE | no flag; 0 text mentions in every season |
| RPO | off | UNAVAILABLE | no flag |
| designed QB run | off | PARTIAL | QB rush = the rusher threw ≥ 2 passes for the team in the game; designed runs and scrambles cannot be separated |
| scramble rate | off | UNAVAILABLE | no flag, no text. Proxy only: QB rushes on passing downs (`qbrush_pd`) |
| shotgun / under center | off | PARTIAL | 2025 (partial) and 2026 text only: live display, no training history |
| personnel grouping, formation width, motion | off | UNAVAILABLE | not in any reachable feed |
| tempo | off | DERIVABLE | `tempo`: neutral-drive clock seconds per snap (drive clock valid every season); V2 `plays_pg` / `drives_pg` |
| no-huddle | off | PARTIAL | 2025-2026 text only |
| explosive-pass / explosive-rush tendency | off | DERIVABLE | V2 `expl_pass` / `expl_rush` |
| short / intermediate / deep passing | off | PARTIAL | `pass_depth` / `air_yards` 2025 (39%) and 2026 (91%) only |
| inside / outside run | off | PARTIAL | `rush_direction` 2025-2026 only |
| standard-down / passing-down tendencies | off | DERIVABLE | `proe` / `pd_proe`; V2 `sr_pd`; style `epa_pd` |
| fourth-down aggressiveness | off | DERIVABLE | `go_oe`: go rate over an own expected-go model. The provider `go_boost` / `fourth_down_recommendation` read the spread-based WP model: **REJECT** |
| pressure rate | def | PARTIAL | see qb_hurry above; proxies: sack rate, front havoc |
| sack rate | def | DERIVABLE | V2 `sack_rate` (2013 missing) |
| havoc | def | DERIVABLE | V2 front havoc (sacks + run TFLs from yardage); PBU-based havoc UNRELIABLE |
| blitz proxy | def | UNAVAILABLE | no rusher counts |
| run-stop / stuff rate | def | DERIVABLE | V2 `stuff`, `opp_rate`, `line_yds` from yardage |
| explosive plays allowed, pass / rush success allowed | def | DERIVABLE | V2 defensive ratings |
| QB rushing allowed | def | PARTIAL | style `qb_rush_epa` / `qb_rush_rate` defense (designed + scramble pooled) |
| early-down / passing-down defense | def | DERIVABLE | V2 `sr_early`, `sr_pd`; style `epa_early`, `epa_pd` |
| red-zone / scoring-opportunity defense | def | DERIVABLE | V2 `pts_per_opp`, `so_rate` |
| defensive pace effects | def | DERIVABLE | the defensive rating of `tempo` (joint model) |
| box counts, coverage family, man / zone | def | UNAVAILABLE | no charting / tracking feed |
| second-level / open-field yards | off | UNRELIABLE | provider columns drift (V2 FEATURE_COVERAGE already REJECTED) |
| OL / secondary / front-seven health | both | UNAVAILABLE | no point-in-time injury or snap history (V2 FEATURE_COVERAGE) |
| coordinator continuity | both | PARTIAL | `oc_cont` / `dc_cont`, a preseason flag, 2015+; no names, no mid-season changes |
| weather | both | UNAVAILABLE | no archived pregame forecasts; observed weather is hindsight |

## 3. Does each derived style metric measure something stable? (split-half reliability)

Each team-season's raw rate is computed on its odd and even games separately. The correlation between
the two halves is Spearman-Brown corrected and averaged over the dev seasons 2016-2023 (FBS offenses).
A metric that is mostly noise cannot describe a team.

| metric | kind | split-half reliability |
|---|---|---|
| QB rush share (`qb_rush_rate`) | behavior | **0.89** |
| tempo (`tempo`) | behavior | **0.87** |
| PROE (`proe`) | behavior | **0.85** |
| early-down neutral PROE (`ed_proe`) | behavior | 0.83 |
| neutral pass rate (`neu_pass`) | behavior | 0.83 |
| passing-down PROE (`pd_proe`) | behavior | 0.80 |
| early-down EPA (`epa_early`) | efficiency | 0.66 |
| 4th-down go over expected (`go_oe`) | behavior | 0.63 |
| 3rd-down distance (`third_dist`) | efficiency | 0.50 |
| passing-down EPA (`epa_pd`) | efficiency | 0.42 |
| QB-rush EPA (`qb_rush_epa`) | efficiency | 0.36 |
| short-yardage conversion (`sy_conv`) | efficiency | **0.27** |

**Behavior (what a team chooses) is highly reliable. Situational efficiency (how well it does in a
thin slice of plays) is mostly noise.** Short-yardage conversion is the clearest case: that is why the
brief's "strongly shrink" is not optional. The joint model shrinks the noisy metrics hardest,
because their variance components are large.

## 4. What is NOT used, and why

- **Provider win probability, spreads and 4th-down recommendations.** They read the pregame spread
  (`audit.FORBIDDEN`, enforced at import in `style.PLAY_COLS`).
- **Provider `xpass`.** Its feature set is undocumented. It is replaced by `style.xpass_model` on
  declared state variables, fit on the three prior seasons.
- **Provider `stuffed_run`, `line_yards`, `second_level_yards`, `open_field_yards`, `havoc`.**
  They drift (section 1). V2's yardage recomputation is used instead.
- **CFBD season stats in `cfb_matchup_line`** (e.g. `*_off_sec_per_play_mean`). They are full-season
  aggregates, so not point in time.

## 5. The highest-value missing scheme data

In order of expected value for matchup modeling:

1. **Charted pressure and blitz**, per dropback, historically. Pressure-vs-protection is the brief's
   special-treatment matchup, and sacks are a thin, noisy proxy (about 6% of dropbacks).
2. **Personnel grouping and formation per snap** (11/12/21, shotgun / pistol / under center),
   historically. Without it, "scheme" means behavior only.
3. **Designed run vs scramble.** QB mobility is measurable only pooled.
4. **Point-in-time injury / availability and snap counts** for OL, front seven and secondary. This is
   the personnel × matchup dimension the brief asks for; today only the QB has a point-in-time history.
5. **Coordinator names by season**, to follow a play-caller across schools. The head-coach analysis
   (METHODS §2.5) shows that style follows the coach.
6. **Archived pregame weather forecasts** (wind × passing, rain × ball security).

The 2025+ gamebook text will give items 2 and part of 1 (hurries, depth, direction) **from now on**.
With two or three seasons of it, the depth / direction / hurry matchups can be tested the same way as
everything in BACKTEST.md.
