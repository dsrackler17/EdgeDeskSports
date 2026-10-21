# Market-data recovery proposal — budget-aware, nothing re-enabled

**Status: a proposal.** Nothing in this branch enables, schedules or buys market data.

**2026-10-21: the operator set an hourly floor.** Nothing runs or buys more often than once an hour (`supabase/odds_api_hourly_limits.sql`; the constraint `odds_api_cadence_hourly_floor` refuses any band under 60 minutes). Option B (5 / 15 / 45-minute bands inside 6 h) and option C's 5-minute refresh are not available unless the operator lifts that floor. The planner's schedule A is now 60 / 120 / 360 min; the tables below were computed against the earlier 20-minute plan and are kept as the record of that comparison.

The Odds API capture stays paused under `supabase/odds_api_emergency_stop.sql` until an operator follows the incident runbook:

- `docs/odds-api-incident-2026-10/INCIDENT.md` §9;
- on or after **1 Nov 2026**, when the provider quota resets;
- under the gateway's **60,000-credit operational ceiling** (the breaker latches at 57,000; a 40,000 reserve is never touched).

Everything below is arithmetic from `lib/edgedesk_odds_recovery.js`; the tables are the output of `node tools/research/odds_recovery_report.js`.

## 1. While quotes are unavailable, research keeps working

The five readiness states are unchanged and independent:

1. **available**;
2. **research available**;
3. **model ready**;
4. **market verified**;
5. **actionable**.

With capture paused, the engine still does everything that doesn't need a price:

- finds the games and reads the injury reports and depth charts;
- compares the projection with the reference line (`LINE_DISCREPANCY`);
- shows the model's measured record (`CALIBRATION`);
- runs the challenge pass.

What it never does without a verified price:

- It does not compute an implied probability, an expected value or a maximum price. Those records are `UNAVAILABLE`, with the reason "no verified price".
- It does not call a game actionable. The challenge pass answers *"Is the market quote stale?"* as **critical** when there is no quote, which forces PASS.
- It does not lower any threshold to make more games look ready. A reference line (nflverse consensus, no book, no capture time) is never counted as a price.

## 2. The gap this proposal closes

A price counts as **verified** only while it is younger than the readiness limit for that game's time to kickoff (`supabase/functions/edgedesk_ai/_intelligence.js` `quote_ttl_buckets`):

| Time to kickoff | ≤ 0.5 h | ≤ 2 h | ≤ 6 h | ≤ 24 h | ≤ 72 h | beyond |
|---|---|---|---|---|---|---|
| Price must be younger than | 5 min | 15 min | 45 min | 90 min | 180 min | 360 min |

The gateway's planned event-aware cadence (`supabase/capture_cron.sql`) buys a sport's board at most:

| Time to next kickoff | inside 3 h | inside 24 h | inside 72 h | beyond |
|---|---|---|---|---|
| Interval | 20 min | 60 min | 2 h | 6 h |

The two disagree just before kickoff, where a verified price matters most:

- a board bought every 20 minutes is younger than 5 minutes only a quarter of the time in the final half hour;
- it is younger than 15 minutes three quarters of the time in the 30–120 minutes before kickoff;
- between 3 and 6 hours, a 60-minute cadence against a 45-minute limit leaves a quarter unverifiable.

## 3. What each option costs, on real schedules

Game lines only (h2h, spreads, totals over the gateway's 10-book list = **3 credits per sport request**; one request returns every event of the sport).

The **≤0.5 h … 24–72 h columns** give the share of game-minutes in each window when the price would be verified.

### NFL + FBS game lines, week of 13–19 Oct 2026 (committed slates: 20 NFL and 66 FBS kickoffs)

| Schedule | Credits / week | / day | / 30 days | ≤0.5 h | 0.5–2 h | 2–6 h | 6–24 h | 24–72 h |
|---|---|---|---|---|---|---|---|---|
| A. Gateway cadence as planned (20 / 60 / 120 / 360 min) | 1104 | 157.7 | 4731 | 29% | 80% | 93% | 100% | 100% |
| B. Aligned to the readiness limits inside 6 h (5 / 15 / 45 / 60 / 120 / 360) | 1539 | 219.9 | 6596 | 100% | 100% | 100% | 100% | 100% |
| C. A + research-triggered refresh (≤ 6 h, ≥ 5 min apart, ≤ 120 credits/day) | 1377 | 196.7 | 5901 | 70% | 91% | 100% | 100% | 100% |

### MLB game lines, a SYNTHETIC regular-season week (15 games a day; no MLB schedule is committed)

| Schedule | Credits / week | / day | / 30 days | ≤0.5 h | 0.5–2 h | 2–6 h | 6–24 h | 24–72 h |
|---|---|---|---|---|---|---|---|---|
| A. Gateway cadence as planned | 996 | 142.3 | 4269 | 35% | 81% | 98% | 100% | 100% |
| B. Aligned inside 6 h | 1782 | 254.6 | 7637 | 100% | 100% | 100% | 100% | 100% |
| C. A + research-triggered refresh | 1392 | 198.9 | 5966 | 60% | 90% | 100% | 100% | 100% |

## 4. Recommendation

1. **Football game lines: option B.** Align the gateway's near-kickoff cadence for NFL and NCAAF game lines to the readiness limits inside 6 hours. That is about **+1,865 credits per 30 days**, and every near-kickoff minute becomes verifiable.
2. **MLB (when its regular season returns): option C**, a research-triggered refresh. With games spread across the day, aligning MLB's cadence costs more (+3,368 per 30 days on the synthetic week). A refresh bought only when a subscriber is researching a game whose price is too old buys most of the benefit (+1,697) under a hard daily cap.

   It works as follows:
   - a single sport request (3 credits);
   - at most every 5 minutes per sport;
   - only inside 6 hours of the game;
   - only when the stored board is older than the readiness limit;
   - **≤ 120 credits a day** across all subscribers, plus a per-subscriber daily limit;
   - single-flight per sport, so concurrent questions share one purchase.
3. **Leave the largest consumer as the incident set it.** Player props (55% of October) and alternates stay at the incident's cadences. They are outside the research engine's MARKET state for game lines.

**Total:** **+3,562 credits per 30 days** on top of the incident's expected ~35,000 makes **38,562**, which is **64%** of the 60,000 operational ceiling and under the 57,000 breaker latch. The gateway's daily allowance and shedding still apply.

## 5. How it would be enabled (not done here)

All in the odds gateway, which owns purchasing. None of it is in this branch:

1. Apply the incident runbook first: budget, breaker on, quota confirmed, schedules resumed.
2. **Option B:** set the gateway's per-sport cadence bands for `americanfootball_nfl` and `americanfootball_ncaaf` game lines to `[[0.5, 5], [2, 15], [6, 45], [24, 60], [72, 120], [∞, 360]]` minutes.
3. **Option C:** add a `research_refresh` action to the gateway:
   - service role only;
   - called by `edgedesk_ai` when a research turn finds a game inside 6 hours whose stored price is older than its readiness limit;
   - with the cap, gap and single flight above, metered like every other gateway purchase.
4. Watch `admin/odds-usage/` for a week. Compare the observed credits with §3, and roll back by restoring the bands if they differ by more than 25%.

## 6. What the numbers do not include

- **Provider prices.** The plan is the incident's: $59 a month for 100,000 credits. Credits, not dollars, are the constraint.
- **Other sports** (NBA, NHL, UFC): not simulated. Each adds about the same as a football league per request; run the planner with their schedules before enabling them.
- **Off-season and bye-week variation:** the football numbers are one real week.
- **Player props:** see the incident document.

The simulation assumes the gateway buys exactly on cadence. Shedding at 60% of a day's allowance can only lower the credits, and the verified share with them.
