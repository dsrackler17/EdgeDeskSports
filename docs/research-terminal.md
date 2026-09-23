# The research terminal: architecture, terminology, and the canonical layer

*Research, not picks.* This document maps the system that answers "what does the
model think, what does the market think, why do they differ, and has that
disagreement historically meant anything?" It also defines the vocabulary every
surface uses. It is the Batch 1 deliverable of the research-terminal upgrade.
Later batches extend it rather than replace it.

## 1. Architecture map (as found, September 2026)

| Layer | Where | Notes |
|---|---|---|
| Static site | GitHub Pages at `edgedesksports.com`, no build step | The browser reads committed JSON and calls Supabase edge functions |
| EdgeDesk terminal | `app.html` (≈60k lines, inline JS) | The game research card starts at `THE GAME RESEARCH CARD` (`fbGxState`, `fbGxSummary`, `fbGxDrivers`, `fbP4Card`) |
| CFB P4 engine | `football/cfb_p4/engine.js` `projectGame` | The fair spread is an **explicit additive sum** of `rating, hfa, qb, matchup, travel, schedule, injury, rivalry, conference`, published as `contributions`. Weather enters only the total. Sigma is per game (`uncertainty.volatility`) |
| NFL / CFB v1 engine | `football/engine.js` `predictGame` | Linear. `contributions` are published |
| Model Collective | `collective/index.html` (inline JS), `collective/odds.js` (`MCOdds`), `collective/week.js` | Grading is page-side by the published rule (`atsResult`, `rowGrade`), with server grades first |
| Collective record | `collective/settled/<SPORT>_<season>.json` | Written hourly by `tools/collective/settle_finals.js`. Holds the final score, the captured close and `close_source` |
| Odds | `supabase/functions/capture`, `close`, and the deployed `collective_odds` | The consensus is the median across retail books. A sharp reference is kept apart |
| Intelligence | `supabase/functions/edgedesk_ai` (`_research.js` packet, `_pricing.js` kernel) | The critic rejects invented numbers. Packets are snapshotted to `research_packets` |
| CLV (EdgeDesk) | `tools/intelligence/clv.js` | Graded against `football/pricing/lines_nfl.json` |
| Editorial audit | `tools/editorial/*` | Hash-identified pregame snapshots, then postgame grading |

## 2. The canonical layer (new)

| File | Browser global | Owns |
|---|---|---|
| `lib/research_core.js` | `EDResearch` | Line convention, CLV, market movement vs a model, key numbers, American odds / break-even / no-vig / EV, Wilson and t intervals, Brier / log loss / Brier skill, edge / normalized / lead-time buckets, walk-forward error scale, agreement, effective independent count, outlier status |
| `lib/research_eval.js` | `EDResearchEval` | One prediction-record shape, the leakage guard, the walk-forward evaluator, per-model diagnostics, calibration, scale-method comparison, similar situations, residual correlation |

Both have no dependencies and run unchanged in the browser and in Node. The
tests are `tools/research/*.test.js` (`npm run research:test`). They run
first in `npm test` and in the Collective CI job.

## 3. Terminology

**Home line.** A spread stated for the home team. Negative means home is
favored. Every market line, model spread, posted line and closing line in the
research layer is a home line.

**Engine margin.** The engines' `fair_spread` is a projected *home margin*,
where + means home is favored. That is the opposite sign. It enters the
research layer only through `EDResearch.homeLineFromEngineFairSpread`.

**Side at submission.** The side a model named. If it named none, the side its
number takes against the line it was posted into. This decides CLV, the edge
bucket, and favorite/underdog. The close never decides it.

**ATS side (grading contract, unchanged).** The named side. If none was named,
the side the model's number takes against the captured close. This is the
published Collective rule, preserved as is.

**Gap.** `|model home line − market home line|`, in points.

**Normalized gap.** The gap divided by the model's **walk-forward** expected
error: the RMSE of its own margin residuals on games that were final before it
posted. It is null until 12 such games exist. The RMSE, SD and MAD methods are
all reported by `compareScaleMethods` (coverage of ±1σ and ±2σ). RMSE is the
default because a biased model's error about the line includes its bias.

**CLV (points).** Posted home line versus captured closing home line, turned
onto the side at submission. Positive means the number taken was better.
HOME: −3 → −5 is +2. AWAY: home −3 → −1 (away +3 → +1) is +2.

**Lead time.** Buckets of 72h+, 24–72h, 6–24h, 1–6h and <1h before kickoff.
A post at or after kickoff is `after_kickoff`. It is never folded into <1h.

**Room position.** A model's number against the median of the *other* models'
numbers on the same game:

| Distance from the median | Label |
|---|---|
| under 1.5 | aligned |
| 1.5 to 3 | mild |
| 3 or more | strong |

It is **lone** when the model is the only one on its side of the market line.
These labels are descriptive. An outlier is not wrong.

**Key numbers.** A conventional list of labels: NFL 3 and 7 are primary, with
10, 6, 4 and 14 secondary. CFB 3 and 7 are primary, with 10, 14 and 17
secondary. Crossings are labeled crossed, onto or off. No value is attached to
a crossing.

**Research, not a recommendation.** No surface prints LOCK, BEST BET, or a
combined "score" presented as a probability. EV is shown only from an explicit
model probability for that wager at that price (`priceAssessment`). Without
one it is N/A.

## 4. Defects and risks found in the audit

1. **CLV side chosen by the close** (fixed). The first Collective diagnostics
   measured CLV on the side implied against the *closing* line when a model
   named none. The side is now frozen at submission. ATS grading is untouched.
2. **Untimed rows** (fixed). A graded row with no receipt time cannot be
   proven pregame. It stays in the record, is excluded from the time-based
   diagnostics, and is counted on the page.
3. **One denominator beside many metrics** (fixed in diagnostics). Every
   diagnostic cell prints its own `n`, and percentages carry 95% Wilson
   intervals.
4. **Two sign conventions** (contained). The engine margin (+ = home favored)
   and the betting line (− = home favored) coexist. There is now one named
   converter, and the mirror tests pin it.
5. **≈30 duplicate odds helpers** (open). Implied-probability and de-vig
   helpers are duplicated across `app.html`, the edge-function modules, the
   engines, and other pages. They are not refactored here: they are working
   production code. New code uses `EDResearch`. Consolidation is a follow-up
   that has to be verified module by module.
6. **No finish time on the wire** (ruled). Walk-forward cutoffs treat a
   result as known at kickoff + 6h (`EDResearchEval.finalKnownAt`). This is a
   fixed rule, not an estimate, and it can only make the evaluation stricter.
7. **Room comparison uses final pregame numbers.** A model posted early is
   compared with numbers that may have been posted after it. The label says
   "room", not "at the time".
