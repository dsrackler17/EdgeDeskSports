# capture — the qualification engine

Runs on a schedule. Prices the board for the configured sports, writes one
durable row per `(event, market, selection, point)` into `signals`, and decides
which of those rows EdgeDesk is willing to put its name on.

There is exactly **one** definition of an actionable EdgeDesk signal:

```
flagged_at IS NOT NULL AND flagged_best_dec > 1
```

`qualifySignal()` in `index.ts` is the only thing that produces it. The board,
the research engine, the record, the grader and the learning loop all read that
state; none of them re-derives it. `tools/capture/board_contract.test.js` fails
if any of them starts to.

---

## Deploy

```bash
# 1. The migration FIRST. Capture degrades safely without it — it drops the
#    columns the database lacks and names them in `schema_gaps` — but until it
#    runs, persistence streaks cannot be stored, so a Tier B candidate can never
#    reach its second confirmation and the actionable board stays empty.
#    Paste supabase/capture_v9_qualification.sql into the SQL editor and run it.
#    Every row of its report should say ok.

# 2. The function.
supabase functions deploy capture --no-verify-jwt

# 3. Verify, in this order. None of these writes anything.
curl -s -H "x-cron-secret: $CRON_SECRET" "$FN/capture?probe=1" | jq .
curl -s -H "x-cron-secret: $CRON_SECRET" "$FN/capture?diag=1"  | jq '.funnel, .rejected_by_reason'
```

`?probe=1` spends at most two odds requests on one sport and answers the two
questions that cannot be answered from a docs page: **which books does each
selection strategy actually return on this account**, and **what did the
provider charge for it** (from its own `x-requests-last` header). Read
`by_regions.reference_present` and `by_bookmakers.reference_present`. If the
bookmaker list reaches Pinnacle at the same or lower cost, set
`CAPTURE_BOOKMAKERS` and stop paying for two regions.

`?diag=1` prices one sport and writes nothing. Its `funnel` is monotonic by
construction, so the drop between two adjacent stages is the cost of exactly one
rule.

---

## Environment variables

### Must be set (capture refuses to run without these)

| Variable | Why |
|---|---|
| `CRON_SECRET` | Unset means `authorized()` rejects every caller **including the scheduler**, forever, silently. Capture now says so in the 401 body. |
| `ODDS_API_KEY` | Every request would fail. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Without them capture would price the board and discard it. It now refuses rather than reporting a successful empty pass. |

### Changed in v9 — review these

| Variable | Old default | New default | Why |
|---|---|---|---|
| `CAPTURE_REGIONS` | `us` | `us,eu` | **This is the root cause fix.** Pinnacle is not in the Odds API `us` region, so with `us` alone the sharp anchor was null on every row of every run and `sharp_fair` silently held the consensus. Costs one extra region per request; `CAPTURE_BOOKMAKERS` is the cheaper route once `?probe=1` confirms the billing. |
| `CAPTURE_MAX_BEST_RATIO` | `1.35` | `2.0` | The decimal ratio is now only a catastrophic backstop. Outlier detection moved to probability space, which is strictly stricter at short prices and correctly permissive at long ones. |
| `CAPTURE_FLAG_FLOOR` | `0.005` | *removed* | Replaced by `EDGE_FLOOR`, segmented on sport × market × tier. Override with `CAPTURE_EDGE_FLOOR` (JSON). |
| `LEARN_EDGE_MAX` | `0.25` for everything | *per market* | 10% on spreads and totals, 20% on moneylines. Override with `CAPTURE_EDGE_SANE_MAX` (JSON). |
| `SHARP_BOOK` | `pinnacle` (substring match) | *removed* | Replaced by `CAPTURE_REFERENCE_BOOKS`, an exact-match priority list. Substring matching meant an empty value matched every book. |
| `CAPTURE_AUTO_PREFIXES` | force-appended NFL | honours the value you set | Setting it to `""` used to still pull in every active NFL key, including preseason, on top of an explicit `CAPTURE_SPORTS`. Now `""` means none. Unset means `tennis_`, NFL and NCAAF. |

### New in v9

| Variable | Default | What it does |
|---|---|---|
| `CAPTURE_BOOKMAKERS` | *(empty)* | Explicit bookmaker list; replaces `regions` entirely when set. The only way to reach Pinnacle and the US retail books in one request. Empty by default because the billing must be **measured** on the account that pays for it — run `?probe=1`. |
| `CAPTURE_REFERENCE_BOOKS` | `pinnacle` | Books EdgeDesk will call a sharp reference, in priority order. Adding one is a claim that its price is independent information; that claim belongs in a commit message with evidence. |
| `CAPTURE_MISSING_TS_FRESH` | `false` | A quote with no provider timestamp counts as stale. Setting this `true` is a documented downgrade — unknown age is not young age. |
| `CAPTURE_MIN_MINUTES_TO_START` | `10` | Inside this window a signal is a race with the clock, not research. |
| `CAPTURE_MAX_DAYS_TO_START` | `14` | Beyond this a game is priced and stored but never made actionable. |
| `CAPTURE_MAX_ABS_PROB_DEV` | `0.08` | Primary outlier rule: probability points the best price may sit below the pack median. |
| `CAPTURE_MIN_PROB_RATIO` | `0.60` | Catches a doubled longshot, where the absolute gap stays small. |
| `CAPTURE_MAX_MAD_Z` | `6` | **Widens** tolerance on a dispersed pack. It never narrows it — see the comment in `qualifySignal`; a z-test that narrows rejects every edge worth having. |
| `CAPTURE_MIN_QUALITY` | `0` (**off**) | Gate on the composite quality score. Off by default: the score is built from measured components and stored for audit, but it has never been validated against outcomes, and gating on an unvalidated composite is how a system starts believing its own decoration. Raise it only with backtest evidence. |
| `CAPTURE_BOOK_QUOTES` | `true` | Per-book quote history for actionable signals only. Nothing wrote `book_quotes` before, which is why the book-bias panels have never had data. |
| `CAPTURE_EDGE_FLOOR` | *(JSON)* | Override the floor table, e.g. `{"ncaaf|h2h|B": null}` to take **no action** in a segment. `null` is supported and produces `segment_not_qualified_for_action`. |
| `CAPTURE_CONFIRMATIONS` | *(JSON)* | `{"*|*":{"A":1,"B":2}}`. |
| `CAPTURE_FRESHNESS_POLICY`, `CAPTURE_BOOK_REQUIREMENTS`, `CAPTURE_MAX_DISPERSION`, `CAPTURE_DEVIG_POLICY`, `CAPTURE_BOOK_FAMILIES` | *(JSON)* | Merged over the built-in tables. |

Unchanged: `CAPTURE_MARKETS`, `CAPTURE_SPORTS`, `CAPTURE_TICKS`, `CAPTURE_FLAG_MAX`
(now a **run** cap, not per sport), `CAPTURE_FLAG_CONCURRENCY`, `CAPTURE_MAX_MS`,
`CLOSE_MIN_DEC`, `CLOSE_MAX_DEC`.

---

## API cost

Cost is charged per request as roughly *markets × regions*; the sports list and
the number of events are free. The levers, in order of size:

1. **`us` → `us,eu` doubles the per-request cost.** It is not optional: without a
   region containing Pinnacle, Tier A is unreachable by construction and every
   "sharp" claim is a consensus. `?probe=1` measures whether `CAPTURE_BOOKMAKERS`
   buys the same coverage for one region's worth — if it does, the increase is
   fully repaid.
2. **The sports list.** `CAPTURE_SPORTS` is the biggest dial. `CAPTURE_AUTO_PREFIXES`
   now actually honours being turned off.
3. **Cadence.** Capture reads the whole board per sport per call, so a far-out game
   costs nothing extra. What costs is calling often. A defensible split, within
   the existing cron: one frequent job over a short `CAPTURE_SPORTS` list for
   sports in season, one slower job for the rest.

`quota_spent_this_run`, `quota_used` and `quota_remaining` are all in every
response, so the bill is observable rather than inferred.

---

## Reading a run

The response answers, from one call and without inference:

- `funnel.stages` — ten gates, monotonically non-increasing. A big drop at
  `fresh_price` is a dead feed; at `reference_quality` it is book coverage; at
  `edge_floor` it is an efficient market; at `persistence` it is simply a
  candidate not yet seen twice.
- `rejected_by_reason` + `rejected_samples` — every refusal, counted and sampled.
- `tier_counts`, `per_segment` — Tier A vs Tier B vs PASS, per sport/market.
- `reference_present` + `reference_warning` — if the configured sharp book never
  appeared, this says so and names the fix.
- `quotes_missing_timestamp` + `freshness_warning` — if the feed stops sending
  update stamps, freshness stops working, and this is how you find out.
- `schema_gaps` — columns the database does not have, which capture dropped and
  kept going.
- `policy_in_force` — the thresholds that produced these decisions, echoed so a
  run explains itself.

**Zero actionable signals is a valid outcome.** It is not the same as a broken
run, and the funnel is how you tell them apart.

---

## Remaining weaknesses

Written down rather than left to be discovered.

1. **No out-of-sample results exist yet.** `record/grades.json` is an empty seed
   and `signals` lives only in Supabase, so no number in this repository
   describes real performance. The floors in `EDGE_FLOOR`, the freshness limits
   and `CONFIRMATIONS[B] = 2` are **priors with stated reasons, not fitted
   values**. Run `tools/capture/export_history.js` then `tools/capture/backtest.js`
   against the real database to replace them, and record the fold results in the
   commit message that changes them.
2. **The closing POINT is not stored anywhere.** `closing_sharp_fair` gives price
   CLV; line CLV in points — "we bet +3 and it closed +2.5" — needs the closing
   handicap, which nothing writes. The harness computes it and the exporter emits
   `closing_point: null` rather than approximating it. Fixing this means the
   close pipeline storing the closing point, which is outside this repository.
3. **`book_quality` is empty and should stay empty** until the backtest fills it
   from history strictly earlier than the period it is then used on. Nothing in
   this repository invents a `lead_lag_score`.
4. **The de-vig policy is Shin everywhere**, unchanged from v8. That is a refusal
   to make a claim, not a finding. `devigComparison()` in the harness answers it
   properly, but needs `pin_dec`/`pin_opp_dec`, which only v9 writes — so it can
   only be answered on signals captured from here on.
5. **The close and learn functions are not in this repository.** Every claim
   capture's comments make about them is unverifiable from a checkout.
6. **Three rows in the production database carry a flag from an older build** and
   the `flagged_at IS NULL` guard makes that permanent — the same rule that stops
   an entry price drifting also preserves a bad historical flag. They are labelled
   `pre-v9-legacy` by the migration and reported separately, never deleted.
7. **Tier B's `CONFIRMATIONS = 2` costs one capture cycle of price movement.** On
   a fast-moving line the price may be gone by the second sighting. That is the
   intended trade — a single snapshot of a consensus with no independent reference
   is thin evidence — but it is a trade, and the harness measures both sides.
