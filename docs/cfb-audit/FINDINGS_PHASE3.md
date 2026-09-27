# EdgeDesk CFB hostile audit: phase 3 findings and the final classification

> **Status after this audit.**
> - **F-30 and F-31 are fixed** in the same pull request (PR #391):
>   - `football/cfb_production/projections.js` `officialFor()` publishes no official decision at fallback level 3. It refuses a BET that breaks the governed policy (betting off, or no side/line/price): the result is NO_DECISION with the alarm.
>   - `supabase/functions/edgedesk_ai/_cfb_explain.js` `cfbFacts()` lets a BET through only when the decision says betting is on.
>   - Tests: `canonical.test.js` 124, `explain_guard.test.js` 52.
> - **The item-81 wording is corrected:** the V2 panel now says the 2024–25 data informed development and is inspected, not an untouched holdout.
> - **Unchanged:** the classification (B); the other findings keep the status given below.
> - The text is the auditor's own, kept as plain text.

```text
EDGEDESK CFB HOSTILE AUDIT - PHASE 3 FINDINGS (H3 production pathway) AND THE FINAL CLASSIFICATION
=================================================================================================

Audited tree: /home/user/EdgeDeskSports at b6eae62e9 (PR #391, exactly what will merge). Read-only on production;
no holdout re-scored. Reproduction scripts (scratch, not in the repo so the repository's engine-call scan stays
green): scratchpad/audit2/attack.js (26 attacks on the canonical path, stored projections, fallback and retries),
failclosed.js (11 artifact/contract corruptions), betattack.js (forcing a BET out of decision.js), phase2.py.
Outputs: attack.json, failclosed.json. Repository suites re-run on this tree: canonical 117/117, final_hardening
23/23, replay 7/7, security 55/55, debug_ui 32/32, cfb_production 120/120, sql 133/133 (real Postgres, including a
real two-session deadlock), ui 40/40, cfb_lab 275/275, chaos 50/50, cfb_decision 101/101, cfb_v2_panel 20/20,
fbs_board_ui 185 assertions; reproduce.js: 174/174 snapshots, 510/510 settlements; replay_week.js week 3:
deterministic, 0 bets, 0 after-kickoff snapshots.

Governance, unchanged: no Model Championship has been run (champion_selection NOT_RUN); the governance champion is
V1 edgedesk_cfb_p4_v1.0.0; production V2 is edgedesk_cfb_v2.1.0 in shadow; v2.1.1 and v2.1.2 are unpromoted
challengers; betting is disabled.

-------------------------------------------------------------------------------------------------
A. F-21 CLOSURE (verified independently)
-------------------------------------------------------------------------------------------------
v2.1.2 (build out_p2) has 0 pinned FBS rating-sides in 2016, 2020, 2024 and 2025 (my check on both offence and
defence variances at the final freeze); v2.1.0 (out_h) has 8 by my floor criterion (expl_pass, fg_value, st_net,
to_rate on both sides; the patch author counts 9 including the sack_rate defence side at a different floor). My
phase-2 check read offence only - the patch's count is the more complete one. Accuracy effect is inside noise
(holdout MAE -0.0020 [-0.0070, +0.0030], inspected data). Status: FIXED in a challenger, not in production.

-------------------------------------------------------------------------------------------------
B. NEW FINDINGS (phase 3), by severity
-------------------------------------------------------------------------------------------------

F-30 (MEDIUM) - the stored "official decision" does not re-check the betting switch: a BET row in the decision
ledger is published as the official status.
  Where: football/cfb_production/projections.js officialDecision() (and supabase/functions/edgedesk_ai/
  _cfb_explain.js cfbFacts(), which reads it). numeric.js policyConsistency() ("a BET only while betting is
  enabled") exists but is not called on this path.
  Reproduction: attack.js case "a BET row in the decision ledger while bet_enabled=false": one decision row
  {engine_role CHALLENGER, engine_version cfb_decision_engine_v1, policy_version cfb_decision_policy_v1, status BET}
  passed to projections.build() -> games[].official_decision.status = "BET", basis "... SHADOW, betting disabled".
  The app's V2 panel prints official_decision.status verbatim ("Official decision BET"); the AI facts carry it as
  kind OFFICIAL.
  Exposure: the producer cannot emit it - decision.js returns LEAN with NO_BET_BETTING_DISABLED when
  bet_enabled=false (decision.js:534), and betattack.js could not force a BET even with a hacked policy
  (bet_enabled true, min_ev -1): PASS_DATA_QUALITY / calibrated EV -0.0317. health.js raises CRITICAL on a BET
  while disabled. So the path needs a corrupted or foreign row in the committed, append-only
  football/cfb_decision/<season>/decisions.jsonl. It is a missing consumer-side guard on the one field that says
  BET in public, not a live false BET. Fix: apply policyConsistency (and the policy's own bet_enabled) in
  officialDecision and in cfbFacts, and refuse (show NO_DECISION + an alarm) rather than display.

F-31 (MEDIUM) - at fallback level 3 the stored record pairs V1's number with a V2-based official decision.
  Where: projections.js build(): official = resolved.level === 4 ? UNAVAILABLE : officialDecision(...). At level 3
  (V2.1 row refused, V1 serves the number) the governed V2 decision made earlier from a V2 frozen projection is
  still stored as official_decision.
  Reproduction: attack.js case "V2 row fails contract, V1 fallback, earlier V2 decision exists": resolved
  {level 3, mode FALLBACK_MODEL}, official_decision LEAN.
  Exposure: the app panel returns before printing the decision when canonical is not PREDICTED, so the public page
  is safe; the debug view shows it; cfbFacts would build an explanation with an OFFICIAL V2 status, no V2
  numbers, and without the fallback mode (canon is null, so degraded modes are not added). This contradicts the
  manifest rule "a fallback never borrows the other model's number" for the decision layer. Fix: at level 3 the
  official decision is FALLBACK/NO_DECISION.

F-32 (LOW) - the node row contract checks types, ranges and internal consistency, not provenance or identity.
  attack.js: shifting ens_pred and both components by +10 together -> PREDICTED, margin -1.83 -> 8.17; swapping
  home/away names with ids kept -> PREDICTED, fair line shown for the wrong team ("New Mexico State -2.0" instead
  of "Western Kentucky -2.0"); swapping ids and names together (a sign-flipped row) -> PREDICTED.
  canonical.pure does not call identity.js validateGame (which does refuse id/name conflicts) and current.json rows
  carry no content hash (frozen snapshot files do). Upstream, current.json is built from one schedule table, so
  the practical risk is low; this is defence in depth.

F-33 (LOW) - the row contract's sigma range is the numeric bound [3, 40], not the declared training-derived HARD
  rule. sigma 8 (training sigma is about 13.8-19.4) passes and moves the home win probability 0.454 -> 0.409.
  The model_inputs have training ranges; the row_inputs (ens_pred [-80, 80], sigma [3, 40]) do not.

F-34 (LOW) - calibration fail-closed is soft for the win probability. failclosed.js: deleting the calibration
  block or setting an unknown method silently returns the raw probability (PREDICTED). Harmless today because the
  shipped method IS raw; it would silently de-calibrate a model that ships Platt or isotonic. Every other
  corruption failed closed: no distribution, no t_df, no |z| quantiles, no reliability, Platt without
  coefficients, t_df 2, inverted quantiles, a changed model version and a missing input contract all ->
  UNAVAILABLE or a refusal to start; bet_enabled true in params changes no pure number.

F-35 (LOW) - a stale current.json is not a degraded mode. A 12-day-old current.json still resolves games to level
  1/2 by their data modes; health.js warns only after 8 days (health.js:157). One missed weekly run can publish
  week-old ratings without a public label.

F-36 (LOW) - db.withRetry classifies an HTTP 503 from PostgREST as UNKNOWN and does not retry it (1 attempt);
  deadlocks (40P01) retry 5 times with 150/300/600/1200 ms backoff and recover (verified), permanent errors
  (23505) are not retried. The insert-only mirror recovers on the next run, so this is an availability note.

F-37 (LOW) - promotion evidence floor. The promotion guard requires the Model Lab evaluation ELIGIBLE on at
  least 150 official live pairs with the MAE-difference CI below 0 (lab_core.js:740). With a per-game SD of the
  V2-V1 error difference of about 3.8 points, 150 pairs give a CI half-width of about 0.6: the gate is hard to pass
  by luck but also cannot confirm a 0.28-point gain. The audit's recommendation (>= 700 games) stands.

F-38 (LIMITATION) - the production pathway currently runs almost entirely degraded: 55 of 60 stored games are
  level 2 (MARKET_DEGRADED 57 from one book, NO_PLAYER_DATA 53, QB_UNCERTAIN 19), 2 are FULL, 3 NOT_PRICED; 0
  governed decisions exist (NO_DECISION 60). The week replay can only replay v2.0.0 rows (no V2.1 per-row history
  exists yet). MATCHUP_SHADOW skips on a fresh build (known).

-------------------------------------------------------------------------------------------------
C. THE PENDING_H3 ITEMS
-------------------------------------------------------------------------------------------------
81 Frontend display - SURVIVED with notes. The V2 panel reads projections.json, loads no engine, re-checks the sign
   contract (fair line = -margin, probabilities sum to 1) and shows nothing when it fails; the win probability is
   printed with the favoured side; degraded games hide the confidence score (55/55) and say why in words. The main
   V1 board's UI suite passes (185 assertions, 161 games). Notes: F-30 (a ledger BET would print), the "beats V1
   on the 2024-25 holdout" sentence needs "inspected".
82 API - SURVIVED. anon reads only the two public views; writer RPCs are service-role security-definer functions;
   append-only triggers; security.test.js 55/55, sql.test.js 133/133 on real Postgres; committed JWTs decode to
   anon only.
86 Failure modes - SURVIVED. chaos.test.js 50/50 (corrupt quotes quarantined, kickoff delays and early starts in
   the close window, postponed/cancelled/rescheduled games, BET fail-closed on a stale or degraded market,
   settlement voids and corrections, duplicate cron runs byte-identical); final_hardening 23/23 (stale odds,
   missing QB field, NaN input, wrong or unmapped team, +450 quote, incompatible artifact, provider timeout,
   deadlock, duplicate game rows, a BET while disabled flagged, decision calibration missing -> NO_BET);
   sql.test.js a real deadlock. Not covered by a test: a PBP-provider outage for a whole week (the gate holds the
   week; not exercised end to end here) and a stale current.json (F-35).
87 Fail-closed - SURVIVED with F-34. 10 of 11 corruptions refuse; the decision engine returns NO_BET without a valid
   calibration artifact or policy (validateArtifact / validatePolicy) and did not BET under a hacked policy.
88 Fallback - PARTIAL (F-31). Levels 1 FULL -> 2 DEGRADED -> 3 FALLBACK_MODEL (V1) -> 4 UNAVAILABLE are applied;
   duplicate V2 rows for one game fall to V1 (verified); the fallback records its version and reason; but the
   decision field is not reset at level 3.
89 Retry - SURVIVED (runtime): bounded, classified, jittered, never zero wait; F-36.
90 Deadlock - SURVIVED (runtime): a real two-session deadlock in the SQL suite: one victim, retried, incident
   recorded; advisory-lock leases for jobs.
91 Idempotency - SURVIVED: projections.build at a fixed as_of is byte-identical; a repeated lab hour writes nothing;
   settlement second run adds 0 (replay_week); reproduce.js 510/510.
92 Historical replay - SURVIVED within its limit: week 3 of 2026 replayed hour by hour, deterministic ledger hash,
   455 snapshots, 0 after kickoff, 0 bets; only v2.0.0 rows exist to replay (F-38).
93 Cost/performance - SURVIVED: the canonical projections build takes about 0.6 s for 60 games (264 KB); perf.json
   (2026-09-27) measured the real schema at one season of synthetic volume at rest and under a concurrent writer.
94 Single points of failure (classification): CRITICAL - the sportsdataverse release assets (PBP and schedule; one
   provider; F-01 showed a mid-slate asset), GitHub Actions (every job), the frozen artifact + params.js; HIGH -
   the single sportsbook feed (DraftKings via ESPN; every close is provider-declared), Supabase (mirror only; the
   git ledger is primary); MEDIUM - the V1 board (the fallback level); LOW - the AI explanation (deterministic
   fallback text). Mitigations in place: fail-closed service, fallback to V1, health alarms; missing: a second PBP
   source, multi-book capture, a current.json age mode (F-35).
109 Final model version - NONE ASSIGNED: the audit does not approve production (see D). The recommended shadow
   production version is edgedesk_cfb_v2.1.2 (v2.1.0 + F-01/02/10/11/15/21 fixes, accuracy indistinguishable),
   switched through the governed four-part change of PATCH_v2.1.2 section 9, as a shadow model under V1.
110 Release manifest - the pieces exist and verify: football/cfb_production/manifest.json (champion_selection
   NOT_RUN), the artifact MANIFESTs (v2.1.0 356bd0f9..., v2.1.1 5081956d..., v2.1.2 38a0d952...), decision
   policy v1 policy.json sha cb9019a2..., the input contract cfb_input_contract_1, compatibility.json, the DDL files
   hashed in docs/cfb-audit/SNAPSHOT.json. No final release manifest is issued because no release is approved.

-------------------------------------------------------------------------------------------------
D. FINAL CLASSIFICATION (item 122)
-------------------------------------------------------------------------------------------------
B. APPROVED FOR SHADOW MODE ONLY.

The H3 attack found no path by which the canonical service, under the frozen artifacts and a producer-written
ledger, publishes a wrong V2 number or a BET: bad inputs are refused, bad artifacts fail closed, betting cannot be
reached, the reproduction is exact. The two MEDIUM findings (F-30, F-31) are consumer-side guards on the decision
field, not wrong model outputs. So this is not C (technical failure).

It is not A because the evidence a production approval needs does not exist:
  1. No prospective V2 prediction has settled. The first frozen V2 row is the Tuesday 2026-09-29 freeze.
  2. Every historical window was used in development; 2024-2025 was read at least 13 times.
  3. V2 is less accurate than the opening and the closing line in every window (holdout +0.28 / +0.36 points;
     live 2026 true finals +1.13 vs the close) and has no betting edge (ATS at the close 49.97%).
  4. Its advantage over a simple 8-feature ridge is not significant (-0.057 [-0.136, +0.023]).
  5. The uncertainty/reliability structure is decorative (sigma does not rank errors; reliability Spearman ~0),
     the cover probability has no skill, and the snapshot ignores quarterback identity (F-24).
  6. No Model Championship was run; the governance champion is V1.
  7. The pathway runs degraded on 55 of 60 games (one book, no player data).
It is not D because nothing that failed validation is being shipped: BET is disabled, the governed policy issues
none, and the official status is LEAN/PASS/RESEARCH/NO_DECISION.

What is required to move to A (do not weaken): >= 700 settled, prospectively frozen FBS-vs-FBS V2 games (about one
season) with V2 - V1 MAE CI below 0, calibration and coverage in band; F-30 and F-31 fixed; one governed switch
off v2.1.0 (to v2.1.2); for any betting: >= 200 settled, priced, multi-book shadow decisions with calibrated EV > 0.
```
