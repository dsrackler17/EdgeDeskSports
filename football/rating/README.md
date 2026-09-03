# The EdgeDesk Rating (EDR)

EdgeDesk's own answer to *how good is this team* — one number, in **points
against an average FBS team**, rebuilt every week from evidence EdgeDesk can
check.

Not a poll. Not a service. Not ESPN's, not SP+'s, not anybody else's model.
Nothing in here is copied from another rating, and no ranking is used as an
input.

```
football/rating/
  edr.js            the rating itself (UMD, exports EDEDR) — pure, no I/O
  build_rating.js   the weekly job: reads feeds, writes the dataset
  edr.test.js       the rules, enforced (88 checks)
  current.json      what the app reads
  <season>.json     the season's archive of the same file
```

---

## What goes into a rating

| Component | What it reads | Where it comes from |
|---|---|---|
| **RESULTS** | opponent-adjusted scoring margin this season | cfbfastR schedules |
| **CARRYOVER** | the same measure over the previous three seasons — *been there, done that* | cfbfastR schedules |
| **ROSTER** | returning production, net portal movement, and the level the transfers came from | `football/rosters/` (EdgeDesk's own weekly ESPN sync) |
| **AVAILABILITY** | high-impact absences, this week only, reversible | `football/availability/current.json` |

`RESULTS` is a fixed-point recursion: a team's rating is the mean, over its
games, of *(capped margin − opponent's rating)*, with the home side charged a
home advantage **measured from that season's own games** (half the mean home
margin) rather than a constant. Margins are capped at 28 — beating a team by 60
is not twice the evidence of beating them by 30. Non-FBS opponents share one
rating that is itself solved for, so beating an FCS team is worth what the data
says it is worth and not a number somebody chose.

---

## The NIL / portal question, answered with arithmetic

*"Does last season even matter any more?"* is the whole argument about NIL and
the transfer portal. **EDR does not take a side on it.**

Every week it regresses each season's team ratings on the previous season's and
reports the slope. That slope is the carryover weight the rating actually uses.
When last season stops predicting this one, the weight falls **on its own, in
the data**, without anyone editing a constant.

The measurement ships inside the dataset — every consecutive season pair, each
with its slope, its r², and its sample size — so it can be read and argued with:

```json
"carryover": {
  "pairs": [
    { "from": 2022, "to": 2023, "slope": 0.770, "r2": 0.587, "n": 131 },
    { "from": 2023, "to": 2024, "slope": 0.666, "r2": 0.431, "n": 133 },
    { "from": 2024, "to": 2025, "slope": 0.753, "r2": 0.514, "n": 134 }
  ],
  "weight": 0.753,
  "trend": -0.06,
  "note": "last season predicts this one LESS than it used to — the portal era showing up in the arithmetic"
}
```

A team with fewer than six games in either season is noise, not evidence, and is
excluded from the measurement. Fewer than twenty teams in both seasons and the
slope is refused outright rather than guessed.

---

## What EDR does **not** measure

Named in the dataset, and on screen next to every rating — never hidden:

- **NIL spending.** No public feed carries it, and EdgeDesk does not invent
  numbers. What NIL *buys* is observable — who transferred in, and the level of
  program they left — and that is what `ROSTER` reads. **It is not the same
  thing**, and the rating says so.
- **Per-player recruiting stars.** Absent from the public roster feed. Transfer
  pedigree is instead EdgeDesk's **own prior-season rating of the school each
  transfer left** — no recruiting service is consulted.
- **Coaching and coordinator continuity.** No public feed is wired.
- **Anything a poll, a service, or another model asserts.**

---

## Reading a rating

Every rating comes apart into the components that built it, and says what it was
built from and how much of it EdgeDesk actually watched happen:

```
EdgeDesk Rating            +18.61   #1 of 138
this season · 0 g          no completed game yet
carryover · 2025,2024,2023 +16.54   +21.97 × 75% measured
roster                     +2.07
  returning production     61%      z +0.92
  net portal movement      -7 players  z -0.63
  level transfers came from 76/100  z +1.31
availability · this week   —
built from                 carryover only — no completed game this season · confidence 55%
```

`confidence` rises as the season is played, and again when a roster bundle and a
prior season are both on file. Early in the year a rating leans on carryover
rather than on two games, and it says which.

---

## EDR is research context, not a line

**No bet is priced from EDR.** Every line on the Power 4 board still comes from
the Power 4 engine's own rating state, which is shown on the same screen,
labelled as the thing the lines are priced from. EDR sits underneath it as
context the model did not use.

---

## Running it

```bash
node football/rating/build_rating.js            # rebuild current.json + <season>.json
node football/rating/build_rating.js --dry      # print, write nothing
node football/rating/build_rating.js --season 2026 --seasons 5 --week 3
node football/rating/edr.test.js                # the rules
```

The dataset is content-addressed: a rerun that changes no rating, no week and no
carryover measurement writes nothing at all.

`.github/workflows/rating-sync.yml` runs it Sunday morning (every result is in),
Wednesday (roster and availability movement) and Saturday before kickoff. The
test suite runs **before** the write and again on the file that was written — a
rating that stopped adjusting for opponent, or a carryover weight that stopped
being measured, never reaches the app.

---

## Design rules

1. **Nothing is invented.** A team with no results and no prior season gets *no*
   rating, not a made-up one. A transfer from a school EdgeDesk cannot rate is
   skipped, not scored at neutral. A bundle with no measurable field is
   unavailable, not average.
2. **Measured, not assumed.** Home advantage, the carryover weight, and the
   field's own spread for "returning production" are all measured from the data
   each week.
3. **Bounded.** Roster can move a rating by at most ±6 points and availability by
   at most 7 — neither can overwhelm what happened on the field, and a long
   injury report cannot delete a team.
4. **Reversible.** Availability is this week only. A player returning takes the
   points back.
5. **Decomposable.** Every rating can be taken apart on screen, down to the z of
   each roster part, and every rating names its own gaps.
