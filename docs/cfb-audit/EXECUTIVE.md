# EdgeDesk CFB hostile audit: executive audit (item 126)

> **Status after this audit.**
> - **F-30 and F-31 are fixed** in the same pull request (PR #391):
>   - `football/cfb_production/projections.js` `officialFor()` publishes no official decision at fallback level 3. It refuses a BET that breaks the governed policy (betting off, or no side/line/price): the result is NO_DECISION with the alarm.
>   - `supabase/functions/edgedesk_ai/_cfb_explain.js` `cfbFacts()` lets a BET through only when the decision says betting is on.
>   - Tests: `canonical.test.js` 124, `explain_guard.test.js` 52.
> - **The item-81 wording is corrected:** the V2 panel now says the 2024–25 data informed development and is inspected, not an untouched holdout.
> - **Unchanged:** the classification (B); the other findings keep the status given below.
> - The text is the auditor's own, kept as plain text.

```text
EDGEDESK CFB - EXECUTIVE AUDIT (item 126)
==========================================

Auditor: an independent agent instructed to try to prove EdgeDesk is NOT good. Audited state: the frozen snapshot
EDGEDESK_CFB_FINAL_AUDIT_CANDIDATE (docs/cfb-audit/SNAPSHOT.json, commit e22ff36d) for the core model, and the
production tree b6eae62e9 (PR #391) for the pipeline. No Model Championship has ever been run; the governance
champion is V1 (edgedesk_cfb_p4_v1.0.0). Every number below comes from code that re-runs (TECHNICAL.txt).

CLASSIFICATION: B - APPROVED FOR SHADOW MODE ONLY.

1. What is EdgeDesk CFB?
   A college-football projection system. V2 (edgedesk_cfb_v2.1.0 in production, v2.1.2 the corrected challenger)
   turns play-by-play into opponent-adjusted team ratings frozen every Tuesday at 12:00 UTC, feeds 51 of those
   numbers to a ridge regression and a small gradient-boosted model averaged 50/50, and publishes a fair spread,
   a win probability and 50/80/95% ranges. A separate, governed decision policy compares that number with
   sportsbook quotes; betting is switched off. A Model Lab records every prediction write-once and grades it.
   Personnel, matchup and market-intelligence layers exist as research and shadow only.

2. What survived?
   - The data pipeline is point-in-time and reproducible: rebuilt from raw data bit for bit; every stored
     prediction refits exactly; 63,851 rating rows use only games that had kicked off; no leak found by an outcome
     scan, placebo features, label shuffling or a future-feature injection (which the scan now catches).
   - The pure football number is isolated from the market (46,920 fuzzed market calls changed nothing).
   - Signs, team mapping, odds and push math, settlement, closing-line value and the public record arithmetic are
     correct (510/510 settlements and 174/174 stored snapshots reproduce).
   - V2 is more accurate than the V1 champion and than simple Elo on 2024-25 data (MAE 12.38 vs 12.65, difference
     -0.28 points [-0.47, -0.07]); its win probabilities are calibrated on average (ECE 0.020) and its 80% ranges
     held 81% of results.
   - The production service fails closed: bad inputs and damaged artifacts produce "unavailable", never a number,
     and no path produced a false bet from the frozen artifacts.
   - Eight genuine defects found by this audit were fixed and versioned (v2.1.1, v2.1.2), with no accuracy change.

3. How strong is the evidence?
   Architecture: strong. Performance: weak. There is NO untouched evidence. The 2024-25 "holdout" was read at
   least 13 times during development, the 2026 replay was looked at before the model was frozen, and not one
   prospectively frozen V2 prediction has yet been graded (the first freeze is 2026-09-29). Every accuracy claim
   rests on data that shaped the model.

4. Where is it weaker than the market?
   Everywhere. On 2024-25 V2 misses by 0.28 points more than the opening line and 0.36 more than the close; on the
   2026 games played so far (true finals) 1.13 more than the close. Its Brier score is worse than the close's.
   Betting V2's side of every game would have won 51.0% at the opener and 50.0% at the close - below the 52.4%
   needed at -110. It is biased on P4-home-vs-G5 games (+2.8 points), huge favourites (+4 points at 28+),
   first-career-start quarterbacks (-1.9 to -3.3 points; the model barely reacts to who starts) and FBS-vs-FCS
   games (+6 to +9; not priced).

5. Where might it add information?
   The closing line moves toward V2's side more often than toward simple models (54.7% [52.1, 57.3] of moved lines
   vs 50-53%), by about +0.26 points; that is a small, plausible signal the market later absorbs, not an edge after
   the vig. Its preseason-to-in-season rating mechanics are sound and explainable.

6. Are probabilities calibrated?
   Win probabilities: yes, on average (holdout ECE 0.020, slope 1.06 [0.94, 1.20], every bucket inside its
   interval). Cover probabilities: no - they carry no skill (log loss equals a coin flip). The "reliability" score
   and the per-game uncertainty model do not rank errors (correlation about 0); ranges are right on average but
   too narrow early in the season, in week 1 and in bowls.

7. Does the betting decision layer add value?
   Not yet measurable, and not as betting. The governed policy correctly issues no BET (calibrated EV is -3.2 cents
   per bet at every price). Its LEAN quotes gain more closing-line value than PASS quotes, but neither beats the
   vig, and the "edge quality" tiers only rank closing-line movement (renamed "closing-line tendency"). The live
   capture is one sportsbook with almost no prices, so nothing about execution can be tested.

8. What remains unproven?
   Any prospective accuracy; whether V2's small lead over a simple ridge (0.06 points, not significant) is real;
   quarterback-change handling; injuries, weather, transfers and freshmen; every personnel and matchup correction;
   whether closing-line value survives a real multi-book close; any price-level edge; provider data revisions;
   operation for a full season under the new service.

9. Is it ready?
   Ready for SHADOW, not for production and not for betting. Keep V1 as champion. Switch the shadow model to
   v2.1.2 through the governed change. Fix the two decision-field guards (F-30, F-31). Freeze everything else and
   let prospectively frozen 2026 predictions decide. Promotion requires about one season (>= 700 settled games)
   showing V2 beats V1 with a confidence interval below zero and calibration and coverage in band; any betting
   requires >= 200 settled, priced, multi-book shadow decisions with calibrated EV above zero.

Do not claim: market-beating, an edge, profitability, "sharp", "elite", "high edge quality", reliability as a
precision measure, cover probabilities, QB/injury/weather adjustments, any holdout as untouched, or live results
before frozen rows settle.
```
