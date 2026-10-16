# The linemaker: fair-line sheets, the desk's hardening, and how to run them

This build adds what the audit (`AUDIT.md`) found missing:

- one projection priced in every market, with an honest record behind each probability;
- a panel to read the result;
- desk answers for team totals and alternate lines;
- a clock on the model call;
- a shared AI allowance with Lite/Pro routing;
- the on-screen game passed to the desk;
- saved research on the reader's account;
- a fix for a cross-user read.

Everything else it uses already existed and is reused unchanged:

- the engines;
- `lib/research_core.js` for every piece of odds arithmetic;
- the research shell;
- the inliner;
- the PostgreSQL harness.

## 1. Where everything lives

| piece | file |
|---|---|
| Pricing library (spread, moneyline, total, team totals, ladders, price check, ranking) | `lib/edgedesk_fairline.js` (`EDFairLine`) |
| Calibration record builder | `tools/football/linemaker_calibrate.js` → `football/validation/linemaker_{nfl,cfb}.json` |
| Sheet builder and append-only ledger | `tools/football/build_fair_lines.js` → `football/linemaker/fair_lines.json`, `football/linemaker/ledger/<season>/sheets.jsonl` |
| Grader | `tools/football/linemaker_grade.js` → `football/linemaker/grades.json` |
| Panel (Research → Other → Lines, `#research/lines[/<game>]`) | `lib/edgedesk_linemaker_ui.js`, `lib/edgedesk_linemaker.css`, registered in `app.html` |
| Desk answers for team totals and alternate lines | `football/linemaker/desk.js` (`EDLinesDesk`), inlined into `edgedesk_ai`, called by `linesTurn` |
| AI allowance | `supabase/ai_usage.sql` (+ `_rollback.sql`), `usageClaim` / `usageSettle` / `routeTier` in `edgedesk_ai/index.ts` |
| Saved research | `supabase/saved_research.sql` (+ `_rollback.sql`), `lib/edgedesk_saved_research.js` (`EDSaved`) |
| View RLS fix | `supabase/research_packets_views_rls.sql` (+ `_rollback.sql`); the same change is in `research_packets.sql` |
| CI and schedules | `.github/workflows/linemaker.yml` (tests), `linemaker-build.yml` (sheets, every three hours), `linemaker-calibrate.yml` (record, weekly) |

## 2. The calibration record

### 2.1 The replay

The shipped engines (`football/engine.js` for the NFL and `football/cfb_p4/engine.js` for college) are replayed cold from public history, **one week at a time**. Every game of a week is projected from the state before that week. Only then is the week absorbed.

- This removes the same-slate look-ahead that a kickoff-order replay allows (`docs/research-terminal.md` §4.7).
- The market never enters a projection.
- A season with missing input is refused, not skipped.

### 2.2 The candidates

Each market has candidate distributions. Every one is fitted only on seasons before the one it is scored on.

| candidate | what it is |
|---|---|
| `NORMAL_RAW` | a normal on the engine's own number, with the training residual sd |
| `NORMAL_CAL` | a normal on the recalibrated number, `y = a + b·x` |
| `KERNEL_JOINT` | each team's points as a kernel-weighted empirical distribution of real scores, given its projected points; the two teams are independent and convolved into margin and total |
| `ENGINE` | the shipped engine's own cover functions: the incumbent for spread, moneyline and total. It has no team total |

The kernel uses an adaptive bandwidth of at least 600 effective games and a 3% normal mix.

The measured residual correlation between the two teams is about −0.02, which supports treating them as independent.

### 2.3 How candidates are scored

Every candidate is scored on the same events, anchored on the engine's own rounded number:

- **Spread and total:** win, push or lose at offsets −10 … +10 (whole and half points), plus the closing number where the archive has one.
- **Team totals:** offsets −7 … +7.
- **Moneyline:** home win, tie or away win.

The score is the mean multinomial log loss. Brier is reported beside it.

### 2.4 The rules

These were written into the tool before any score was read.

- **Choosing the method.** On the selection window, the lowest log loss wins. The incumbent `ENGINE` is kept unless a challenger beats it by at least 0.001 nats. The confirmation window and the live season (2026, which no fit has seen) are reported, never used to choose.
- **Status: CALIBRATED** requires all of these, on the confirmation window's binary events:
  - n ≥ 1000;
  - |mean p − mean y| ≤ 0.02;
  - logistic calibration slope between 0.85 and 1.15;
  - no 0.05 bin with n ≥ 200 off by more than 0.05;
  - Brier skill over climatology above 0.
- **Status: PROVISIONAL** is anything else. The rules a market failed are listed with it.
- **Bands.** For every 0.05 bin of held-out probability, the observed rate and its Wilson 95% interval are kept:
  - across all lines;
  - separately, **only at the number the market closed at**.

### 2.5 Results (the committed records)

| league | market | method | status | held-out log loss (2021–25 NFL, 2020–25 CFB) | live 2026 | at-market slope |
|---|---|---|---|---|---|---|
| NFL | spread | ENGINE | CALIBRATED | 0.7121 (next best 0.7164) | 0.6928 | **0.17** (n 1391) |
| NFL | moneyline | ENGINE (kept: KERNEL_JOINT won by < 0.001) | PROVISIONAL: mean p off by 0.034 | 0.6681 | 0.7001 (n 65) | — |
| NFL | total | KERNEL_JOINT | PROVISIONAL: mean p off by 0.035; one bin | 0.7264 (ENGINE 0.9260) | 0.7223 | **0.30** (n 1411) |
| NFL | team total | KERNEL_JOINT | PROVISIONAL: one bin | 0.7503 (normal 0.7544) | 0.7531 | never tested |
| CFB | spread | ENGINE, read as one distribution per game (below) | PROVISIONAL: mean p off by 0.030 | 0.7264 | 0.7303 | **−0.07** (n 4275) |
| CFB | moneyline | NORMAL_CAL | PROVISIONAL: one bin | 0.5565 (ENGINE 0.5584) | 0.4968 | — |
| CFB | total | KERNEL_JOINT | **CALIBRATED** | 0.7279 (ENGINE 0.8938) | 0.7129 | **0.21** (n 4303) |
| CFB | team total | KERNEL_JOINT | PROVISIONAL: one bin | 0.7480 (normal 0.7556) | 0.7499 | never tested |

What the table says:

1. **Against outcomes, the probabilities are well calibrated.** Calibration slopes are 0.95–1.04, and every market has positive skill over climatology.
2. **At the numbers the market posted, they have almost no resolution.** When the model says 62% at the closing number, it happened about 52% of the time. This is the same finding as `pricing_*.json` (the model does not beat the close), seen from the probability side. It is why the price check reads the at-market bands.
3. **The CFB spread is priced from one distribution per game.** The engine's per-line call (`football/cfb_p4/engine.js` `dist.coverProbSpread`) borrows its shape from the `margin_pmf_by_spread` row keyed by the line being priced, and from the pooled residual past the table's ±45. A ladder of lines therefore read a different distribution at every rung, and the chance of covering sometimes fell as the line got better. Examples: Tulane −0.5 38.9% but +0.5 38.7%. Every FBS sheet had dips: up to 1 point inside a published ladder and 3 points across the ±45 edge.
   - **How it reads now.** `tools/football/build_fair_lines.js` `cfbSpreadCover` reads the shape once per game, from the row at EdgeDesk's own fair margin clamped to the table (`EDQuoteEV.cfbGameCover`). This is the row the terminal and the app read when no market is joined; the linemaker never reads one. The shape is then re-centred and stretched exactly as the engine does it. At the fair margin it equals the engine to the bit.
   - **The calibration replay grades the same function.** On identical data, held-out log loss improved: 0.72413 → 0.72394 (selection) and 0.72673 → 0.72643 (confirmation). The calibration slope went from 1.024 to 1.007. The mean-probability miss went from 0.0295 to 0.0303, so the status stays PROVISIONAL.
   - **The engine itself is unchanged.** Its card prices one line, the market's.
4. **The engines' total distributions give zero push probability on whole-number lines.** Their residual tables are relative to a fractional fair total. A game that lands exactly on a whole-number total gets a near-infinite log loss. The kernel prices those pushes. The engines are left as they are; this is reported, not changed.
5. **Centre accuracy, out of sample.**
   - NFL margin MAE: model 10.31, close 9.76. Total MAE: model 10.45, close 10.31 (2021–25).
   - CFB margin MAE: model 13.05, close 12.21 (2020–25).

**Caveat (printed in every record):** the engines' linear weights and residual tables were fitted through 2025. On 2016–2025 they are partly in-sample, which favours `ENGINE`. The 2026 season is clean.

### 2.6 The live fit

The chosen methods are refitted on every completed season through 2025 and shipped in the record's `live` block:

- centres;
- standard deviations;
- tie rate (NFL ≈ 0.3%, CFB 0);
- the team-points grid at 0.5-point steps.

## 3. The sheet and the price check

**One sheet per pregame game** carries:

- the fair spread, moneyline, total and both team totals;
- each market's method, calibration **status** (against outcomes) and, separately, its **tier** against the closing line (from `pricing_*.json`; team totals are RESEARCH, because no closing team-total line is archived);
- the ladders: spread and total ±10, team totals ±7.

The **reference line** (the NFL slate's nflverse consensus, or the CFB Lab's consensus opener) is shown as a gap and a probability. It is never treated as a price, and no expected value is computed against it.

**Price check** (`EDFairLine.priceCheck`). It takes any line and any American price. It computes the cover probability, break-even, probability edge and expected return per unit, all through `research_core.priceAssessment`. The verdicts are:

| verdict | when |
|---|---|
| `VALUE` | the market is CALIBRATED, an **at-market** band exists, the edge is still positive at the bottom of that band's Wilson interval, and expected return ≥ 2% |
| `THIN` | expected return is positive, but one of the VALUE conditions fails; the reason names which one |
| `NO_VALUE` | expected return ≤ 0, with the arithmetic shown |
| `CANNOT_EVALUATE` | the price is invalid, the line is a quarter point, or the line is off the ladder for an ENGINE market |

Consequences:

- A team total can never be VALUE: it has no at-market record.
- A realistic −110 quote on a spread or total is THIN, because of the at-market bands.
- Nothing ever says BET or PLAY.

**Ranking** (`rankQuotes`) keeps only VALUE. It drops a quote older than 90 minutes and orders the rest by conservative return. An empty ranking is a normal answer.

## 4. The ledger and the grades

The build appends a record for a game only when all of these hold:

- the game has not kicked off;
- its sheet moved materially: a fair line by a half point, the moneyline by a point, or a method, status or calibration record changed.

Each record's id is a hash of its contents. `--check` fails on:

- an edited record;
- a record at or after kickoff;
- a duplicate.

The build refuses to run over a ledger it cannot read back, and verifies that the old bytes are a prefix of the new file.

The grader scores the **last pregame record** of each game, using the probabilities frozen in it:

- moneyline Brier and log loss;
- spread and total at the closing number;
- team totals at the fair half point;
- margin, total and team-points MAE and RMSE;
- the share of games where the market moved toward the fair line.

Every figure carries n and a sample state (under 50 = too early). There is no profit and no ROI: nothing here was a bet.

## 5. The panel

Research → Other → **Lines**. Controls:

- an NFL / CFB switch;
- team search;
- sort by kickoff or by gap to the reference line;
- a per-game sheet with the four ladder tabs;
- the price check, with the no-vig split and a multi-book comparison;
- the held-out record and the graded ledger;
- Save this sheet;
- Ask EdgeDesk.

States: loading, error (with retry), integrity refusal, empty, and stale (more than 18 hours old).

Behaviour:

- The two scripts load on first open.
- Wide tables scroll inside their own box.
- The page never scrolls sideways at 390 px.

## 6. The desk

- **Team totals and alternate lines.** `linesTurn` answers these deterministically from the sheets, with no model call. The research pipeline lists these markets as unsupported. A player-prop question, or one it cannot place, passes through.
- **The model clock.** `EDGEDESK_AI_TIMEOUT_MS` (45 s) applies per round trip and `EDGEDESK_AI_DEADLINE_MS` (100 s) to the whole loop. A timeout is the existing narration-failed answer (502, research kept, retryable), with `timed_out`.
- **The allowance and the route.**
  - Every question claims one LITE unit before any work.
  - A question deeper than QUICK also claims PRO.
  - When PRO is spent, the question is answered LITE: no investigation providers, no quote refresh, no tool loop, the answer capped at 1600 tokens, and `EDGEDESK_AI_LITE_MODEL` when it is set. The response's `route` says which route was taken and why.
  - When LITE is spent, the response is a 429 with the reset time.
  - If the claim cannot be made, the question is UNMETERED. This is the subscription gate's own fail-open rule; the per-isolate limiter still applies.
  - Claims are settled once, with the model's token counts.
  - Defaults: 600 LITE and 100 PRO per reader per UTC day, in `ai_usage_policy`.
- **The screen.**
  - The research shell records the open panel. The Lines panel also records the game and the tab.
  - The desk receives these as identifiers (`research_context.screen`).
  - When the conversation has no game, the on-screen game becomes the subject, through `sanitizeSubject` and the published-card re-read.
  - A game named in the question still wins.
- **Saved research.**
  - The desk's Save and Saved research also write to and read from the reader's account. Lines adds Save this sheet.
  - The account copy is frozen at save. The reader can rename, annotate, archive or delete their own items.
  - When the account save is not possible, the reason is shown and the device copy remains.

## 7. Switches

| env (edgedesk_ai) | default | effect |
|---|---|---|
| `EDGEDESK_AI_TIMEOUT_MS` / `EDGEDESK_AI_DEADLINE_MS` | 45000 / 100000 | the model clock |
| `EDGEDESK_AI_USAGE` | 1 | 0: no allowance claims (the per-isolate limiter only) |
| `EDGEDESK_AI_LITE_MODEL` | (unset = the main model) | the model for LITE answers |
| `EDGEDESK_LINES` | 1 | 0: no team-total or alternate-line answers |

The policy table: `update public.ai_usage_policy set pro_daily_limit = …, lite_daily_limit = …, enabled = … where id = 1;` (service role).

## 8. Deploying

Nothing in this build has been applied to production. In order:

1. **Apply `supabase/research_packets_views_rls.sql` first and soon.** On Supabase's default grants, the two views are readable with the public anon key. Then run a check: `select reloptions from pg_class where relname in ('research_packet_grades','research_packet_pricing');` must show `security_invoker=true`.
2. Apply `supabase/ai_usage.sql`, then `supabase/saved_research.sql`. Each ends in an ok / CHECK THIS report.
3. Redeploy `edgedesk_ai` (the Deploy intelligence workflow). Then check `?probe=1`: it shows `model_clock`, `ai_usage`, and `build`.
4. Merge. The Linemaker workflow then builds the sheets every three hours and recalibrates weekly. Neither needs a secret.

## 9. Rollback

| piece | how |
|---|---|
| View RLS | `research_packets_views_rls_rollback.sql`. This reopens the cross-user read; use it only if something that cannot wait broke |
| Allowance | `ai_usage_rollback.sql` drops the functions and keeps the ledger. The function then answers UNMETERED. Or set `EDGEDESK_AI_USAGE=0` without a deploy |
| Saved research | `saved_research_rollback.sql` revokes reader access and keeps every row. The app falls back to the device |
| Desk lines turn | `EDGEDESK_LINES=0` |
| Model clock | raise `EDGEDESK_AI_TIMEOUT_MS` (it accepts up to 120000) |
| Panel | revert the `app.html` commit. The artifacts are inert without it |
| Sheets and ledger | stop the workflow. The ledger is append-only and is never rewritten by a rollback |

## 10. Not verified here, and why

- **Production.** The live Supabase tables, the deployed function and the production page were not checked; there are no credentials in this environment. The view leak is reproduced on PostgreSQL 16 with Supabase's roles and grants shimmed. It is UNVERIFIED against the live project.
- **The writing model.** Neither the LITE model nor the timeout was tried against the real API. The timeout and routing are exercised with a stubbed endpoint.
- **NFL questions through the in-app desk in the browser e2e.** The harness does not serve the nflverse CSVs the page uses to build its NFL card. The CFB path is proven end to end, and the server path is proven for both leagues.
- **Live performance of the published sheets.** The grades start at zero: the first sheets were published on 2026-10-11.
