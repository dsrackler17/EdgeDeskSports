# Non-QB Personnel Availability — the injury impact rating

How much worse is a team with the **expected replacement** playing instead of
the missing player? Not "is he a starter": an elite player with an excellent
backup can matter little, and an average starter with a terrible backup can
matter a lot. This layer measures that for every non-quarterback absence on
file, on a 0–100 scale, with the evidence behind every number.

**It moves no projection.** Every game, team and absence carries
`projection_adjustment: 0`, and the scoring core returns 0 from a constant
that no configuration can change. The score is not points. It becomes
eligible to move a line only after a coefficient is trained on frozen pregame
history and clears the out-of-sample bar below.

```
football/personnel/
  config.js            EVERY multiplier, probability, band and weight — initial priors
  impact.js            the scoring core (pure, deterministic, no clock, no I/O)
  adapters.js          EdgeDesk datasets -> the core's input (college; NFL)
  build_personnel.js   writes current.json (lean) + current.full.json (all evidence)
  freeze.js            the write-once pregame ledger beside each frozen projection
  training.js          readiness for a future coefficient — fits nothing
  desk.js              the AI desk's answers, packet block and critic check
  personnel.test.js    the rules (97 checks)
record/football/personnel/<sport>_<season>_wNN.json   the frozen history
```

## The formula

```
replacement_gap  = player_quality - replacement_quality              (rating points)
raw_impact       = max(0, replacement_gap / scale_sd)
                   x usage_factor x position_leverage
                   x matchup_leverage x unit_concentration_multiplier
impact_if_absent = round(100 x (1 - exp(-raw_impact / 2.5)))         0-100
expected_impact  = impact_if_absent x probability_of_absence
team impact      = round(100 x (1 - exp(-sum(raw_impact x p) / 4.0)))
```

| Score | Class |
|---|---|
| 0–19 | Minimal |
| 20–39 | Low |
| 40–59 | Moderate |
| 60–79 | High |
| 80–100 | Severe |

`impact_if_absent` and `probability_of_absence` are always published side by
side; the expected impact is their product and never replaces them.

## Configuration (`config.js`, version `personnel_impact_v1`)

Every value here is an **initial prior**, not a fitted parameter, and is
subject to empirical calibration once frozen history exists.

**Position leverage** (a relative-importance multiplier, not points; the prior
is the midpoint of the brief's range):

| Slot | Range | Prior | Matchup driver (opponent, measured) |
|---|---|---|---|
| OT (LT/RT) | 1.20–1.40 | 1.30 | pass rush (sack rate generated) |
| EDGE | 1.15–1.35 | 1.25 | pass protection (sack rate allowed), inverted |
| CB1 (primary) | 1.10–1.30 | 1.20 | passing offense |
| WR1 | 1.05–1.25 | 1.15 | pass defense, inverted |
| IOL (G/C) | 1.00–1.20 | 1.10 | run stuffing + pass rush |
| DT | 1.00–1.20 | 1.10 | rushing offense |
| LB | 0.90–1.10 | 1.00 | rushing offense |
| TE | 0.85–1.10 | 0.975 | pass defense, inverted |
| S | 0.85–1.05 | 0.95 | explosive passing |
| RB | 0.70–0.95 | 0.825 | run defense, inverted |
| K / P | 0.40–0.80 | 0.60 | none (not applicable) |
| *CB (non-primary)* | 1.00–1.15 | 1.05 | passing offense — EdgeDesk extension |
| *WR (non-primary)* | 0.90–1.05 | 0.975 | pass defense — EdgeDesk extension |
| *LS* | 0.40–0.80 | 0.60 | none — EdgeDesk extension |
| *OL / DL / DB / OLB (slot unnamed)* | spans both slots | 1.20 / 1.15 / 1.05 / 1.10 | blended — costs confidence |

A college roster spells "OL", "DL", "DB"; it does not say LT or nickel. Those
players take a range spanning both possible slots and half the position
confidence. WR1/CB1 is the depth-rank-1 player of his group.

**Matchup leverage**: `clamp(1 + 0.10 x weighted z, 0.75, 1.25)`, each z capped
at ±2.5, read from the opponent's opponent-adjusted unit metrics in
`football/matchup/metrics.json`. No reputation, no ranking, no name. A missing
metric leaves `matchup_leverage` **null** and costs confidence; the identity is
applied, never a guess.

**Unit concentration**: 1 absence 1.00 · 2 → 1.08 · 3 → 1.18 · 4+ → 1.30.
The count is `1 + the other same-unit absences' probability_of_absence`, so two
questionable guards count as one more expected absence; fractional counts
interpolate. Overlap is handled by the replacement chain as well: a second
absence at a position is replaced from deeper on the depth order, never by the
backup already covering the first.

**Availability states** (probability of absence; the same scalars
`football/cfb_p4` declares): OUT 1.00 · DOUBTFUL 0.75 · QUESTIONABLE 0.50 ·
GAME_TIME_DECISION 0.50 · LIMITED 0.35 (expected participation lost) ·
PROBABLE / EXPECTED 0.15 · UNKNOWN **null** (no expected impact is stated) ·
AVAILABLE 0.

**Usage bands**: ≥0.90 nearly every snap · ≥0.70 major starter · ≥0.50
rotational starter · ≥0.25 important rotation · below that, limited role.

**Confidence** (0–100): a weighted sum over what could be missing — status
0.20 (designation clarity × source tier × freshness), player quality 0.25,
replacement 0.25 (identification × his own measured quality), usage 0.15 (a
proxy counts 0.6), matchup 0.10 (coverage × reliability; excluded when not
applicable), position 0.05. Missing evidence scores zero on its dimension.

## Missing data stays missing

* No player quality is filled. A college EPIR is accepted only when the
  player's own production was measured (career sample and a non-zero shrink
  weight). A rating that is the scale prior plus role and experience points —
  every offensive lineman, most defenders — leaves `player_quality` **null**,
  and the absence is listed **unrated** with the reason, never scored as zero.
* No usage is filled; no matchup is filled; UNKNOWN has no probability.
* **An unknown replacement lowers confidence instead of inventing one.** The
  replacement's quality stays null and the gap is bounded by the rating
  *scale's own* replacement level (EPIR is anchored so 50 is positional
  replacement) — `gap_basis: SCALE_REPLACEMENT_LEVEL` — which is the
  conservative reading: a replacement-level backup.
* The quarterback is excluded (the trained QB layer prices him).
* A team with no graded availability read is `NOT_ASSESSABLE` with a null
  impact. Only a comprehensive official report listing nobody scores 0 at
  high confidence; a partial read listing nobody scores 0 at low confidence.

## Data sources

**Available and wired (college):** EPIR player quality and participation
share (`football/players/teams/<key>.json`); conference availability reports,
operator corrections and the automated read, merged by
`football/availability/overlay.js` and scoped to the fixture exactly as the
engine's own injury list is; opponent unit metrics
(`football/matchup/metrics.json`); the frozen pregame projection
(`record/football/cfb_<season>.json`).

**Available and wired (NFL):** the official injury report
(`football/injuries/nfl_<season>.json`), for the game's own week.

**Missing — what would lift coverage, in order of value:**
1. **Individual offensive-line and defensive grades** (pressures and sacks
   allowed, run/pass block grades, pressure and pass-rush win rates, coverage
   targets). No public college feed attributes a block or a pressure to a
   named player, so every college OL and nearly every defender is unrated.
2. **Snap counts / route participation.** College usage is a participation
   estimate (appearances + touch share), labelled a proxy and discounted.
3. **An authoritative college depth chart.** Replacements come from EdgeDesk's
   participation order (identification confidence 0.55), not a depth chart
   (0.85). ESPN's depth endpoints refuse this repository.
4. **Any NFL player-quality, snap-share or depth feed** (e.g. nflverse snap
   counts and player stats). Until one is wired, NFL absences are listed
   unrated.
5. **NFL opponent unit metrics** on the z scale the matchup drivers read.
6. **Games already missed** per player, needed to separate an absence the team
   rating already reflects from a new one (see double counting).

## The frozen history

`freeze.js` runs in `.github/workflows/football-model-record.yml` after the
record is written and before it is committed. For every game with a frozen
pregame projection (`pick`) it appends an entry beside it whenever, before
kickoff, the projection is revised or the personnel state changes. Each entry
holds `game_id`, `frozen_at`, `inputs_as_of` and the projection (pick time,
home line, projected margin, model version), and points at a content-addressed
state holding one row per absence with `team_id, player_id, position,
injury_status, probability_of_absence, player_quality, replacement_player_id,
replacement_quality, replacement_gap, usage_factor, position_leverage,
matchup_leverage (with its drivers), unit_concentration_multiplier,
raw_injury_impact, normalized_injury_impact, confidence` and the source and
evidence metadata.

Refused: a freeze at or after kickoff, a projection published after kickoff,
inputs or evidence stamped after kickoff, and any change to an existing entry
or state (the run throws before writing). `--verify` re-checks every committed
file (the test suite does too). The freeze never runs on a backfill, so no
postgame knowledge can enter a pregame record.

## Training a coefficient (not done, and not doable yet)

`training.js` builds the rows a future model would regress — the **last**
pregame entry per game, and
`residual = actual_home_margin − frozen_pregame_projected_margin` against the
frozen impact differential, position, replacement gap, matchup leverage,
concentration and probability — and reports readiness. It fits nothing.

The first coefficient should be one pooled term on the home-minus-away
expected impact. Detecting 0.5 points per 10 impact points at 80% power needs
roughly **3,600 CFB games / 2,400 NFL games** in which both sides had a graded
read frozen pregame (residual SD ~16 / ~13, impact-differential SD ~15), split
into at least two training seasons and two holdout seasons. With conference
reports covering only conference games, that is several college seasons.
Promotion then needs all three: lower pooled holdout MAE, a paired test at
p < 0.05, and lower MAE in every holdout season separately. Per-position
coefficients need ~300+ graded absences of Moderate impact or more per group
and come after the pooled term.

## Double counting — what the audit found

1. **ETSR talent moved on named absences — fixed.** `football/players/run_build.js`
   feeds availability (including official next-game reports) into the unit
   build, and `football/rankings/talent.js` used to roll the availability-
   adjusted unit `rating` into `rotation_quality` (weight 0.18) on top of the
   separate `availability` component (0.05). `football/cfb_p4`'s
   `strip_availability` removed only that component, and only when it was a
   penalty. Now the unit build also publishes `rating_ex_availability` (the
   same depth curve with nobody removed), talent rolls rotation quality from
   it, the rating adapter publishes the component's signed `contribution`,
   and the engine strips it whichever way it points. The stripped canonical
   rating no longer moves on a named absence
   (`football/rankings/rankings.test.js`, end to end from a roster). What is
   left is shared by every team: ETSR is re-centred on the league mean, so a
   fully covered team's availability shifts every team by the same 1/N of it,
   which moves no spread.
2. **Non-QB injuries already widen the published distribution.**
   `football/cfb_p4` `context.injuryImpact` adds non-QB rows to injury
   uncertainty, which widens sigma (win and cover probabilities), not the mean.
   A mean coefficient trained on residuals is separate, but its evaluation must
   use the frozen mean, not the widened probabilities.
3. **Team ratings from played games already reflect long absences.** A player
   out for weeks is already missing from the opponent-adjusted performance the
   ratings are built on. The training set needs games-already-missed per
   player (a missing input today) so a season-long absence is not charged
   again.
4. **The quarterback** is priced by the trained QB layer and excluded here.
5. **Duplicate reports** of one athlete count once (highest tier, then
   newest); a replacement is never shared by two absences.

## Where it surfaces

* **Game cards** (FBS and NFL, `app.html`): a compact *Personnel availability*
  section — impact and class, confidence, key losses, unit concern, the
  personnel edge and "Projection effect: Not enabled · 0.0 points" — with the
  full per-absence evidence behind a collapsed *Full evidence* panel.
* **The AI desk** (`supabase/functions/edgedesk_ai`, via `desk.js` inlined as
  `EDPERSONNEL`): "How much does this injury matter?", "Which team is more
  affected by injuries?", "How important is the missing left tackle?", "Who
  replaces this player?", "Are the injuries concentrated in one unit?", "Does
  this defense have meaningful personnel losses?" are answered
  deterministically from the artifact, naming the drivers and ending with the
  no-adjustment sentence. The research packet carries the same block, and the
  critic fails prose that converts a non-QB absence into points.

## Running it

```
npm run cfb:personnel            # build current.json + current.full.json
npm run cfb:personnel:check      # exit 1 if the committed artifact is stale
npm run cfb:personnel:freeze     # freeze what is due (the workflow does this)
npm run cfb:personnel:verify     # re-check every committed frozen entry
npm run cfb:personnel:readiness  # training readiness; fits nothing
npm run cfb:personnel:test       # the rules
node tools/football/personnel_card_ui.test.js    # the card, through the real module
node tools/intelligence/personnel_desk.test.js   # the desk, through the real handler
```
