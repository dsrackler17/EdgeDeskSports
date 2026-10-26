# Sharp lag — research pipeline (Experimental)

**Status:** EXPERIMENTAL research. Nothing here is advice or a recommendation:
a flag records a measured gap between two markets at one moment, and every
flag is graded against the closing line, losses included.

**The hypothesis.** When a slow market (a Kalshi game-winner YES price, a
DraftKings line) sits at least **2.5 percentage points** below Pinnacle's
de-vigged fair for the same outcome, after the slow market's own fees, the slow
market is lagging. If that is true, the gap shows up as positive closing-line
value (CLV) against Pinnacle's close.

## Contents

| Piece | File |
|---|---|
| The shared core (de-vig, quotes, rules) | `lib/edgedesk_sharp_lag.js` (`window.EDSharpLag`) |
| The tables, guards and switches | `supabase/sharp_lag.sql` (mirror: `supabase/migrations/20261027120000_sharp_lag.sql`) |
| The schedules | `supabase/sharp_lag_cron.sql` |
| The free job (never spends) | `supabase/functions/sharp_lag` |
| The paid dispatcher (through `odds_gateway` only) | `supabase/functions/sharp_check` |
| Tests (all offline, the provider mocked) | `tools/sharp_lag/*.test.js`, run by `.github/workflows/sharp-lag.yml` |
| Deploy (manual, tests first) | `.github/workflows/deploy-sharp-lag.yml` |

## A. The sharp anchor

- **Where Pinnacle comes from.** The hourly `capture` near tier already buys
  every sport's main markets through `odds_gateway` (category `featured`). The
  gateway's book list is ten keys including `pinnacle` and `draftkings`.
  - Ten keys bill as **one** region-equivalent, the same as
    `bookmakers=pinnacle` alone and half of `regions=us,eu`. So narrowing it
    would save nothing and would drop the US books.
  - The anchor therefore costs **zero** extra credits for NFL, NCAAF, MLB and
    MMA.
  - NBA and NHL `featured` boards come from the 3-hourly build jobs once those
    sports are enabled in the gateway (owner's decision, 2026-11-01).
- **How it is stored.** The free `sharp_lag` job reads every new gateway
  snapshot (`featured`, `close`, `sharp_check`) out of
  `public.odds_api_snapshots` every 10 minutes. It writes one append-only
  `sharp_price_snapshots` row per book (Pinnacle, DraftKings), market (h2h,
  spreads, totals), side and point:
  - `captured_at`: the gateway's fetch time;
  - `source_request_id`: the gateway request that bought it.

  A snapshot is read once: a unique key and an ignore-duplicates insert. It
  does not edit `capture` and adds no provider call.
- **De-vig: Shin.** It is the same function `capture` prices
  `signals.sharp_fair` with, including the bracket-checking bisection, and a
  test holds the two equal to 1e-12. An underround pair is normalised
  proportionally, and the flag's `devig_method` says so.
- **Resolution.** An observation's resolution is the seconds since the
  previous one of the same source and event. The first observation takes the
  gateway's band:
  - 60 minutes inside 24 h of the start;
  - 120 minutes to 72 h;
  - 360 minutes beyond.

  Kalshi snapshots are 5 minutes apart. Every flag records the coarser of its
  two, because lag can only be measured to the snapshot cadence.

## B. Triggered checks

The free job detects triggers every 10 minutes and records each once
(`sharp_triggers`, a unique `dedupe_key`):

| Trigger | Source | Rule |
|---|---|---|
| `nba_injury` | `nba_injury_report_snapshots` (from `nba_injury_sync`) | A starter changes status between two consecutive reports covering the game. A starter is one of the top 5 of the club's reference rotation by minutes (`nba/roster_inputs.json`). Coming off the report counts. |
| `nhl_goalie` | `nhl_goalie_starters` consensus rows (from `nhl_goalie_sync`) | The consensus starter of one club changes goalie or status. |
| `kalshi_move` | `kalshi_price_snapshots` of linked markets (`kalshi_game_links`, NFL and CFB moneylines) | The YES mid moves **3¢ or more** between consecutive snapshots at most 10 minutes apart, both two-sided and at most 6¢ wide. |

- **Event matching.** NBA and NHL games are matched to the provider's event
  by both clubs (names and aliases from `nba/data/teams.json` and
  `hockey/data/teams.json`, inlined) and a start within 6 hours. Two
  candidates are no match, never a guess.
- **The hourly dispatcher.** `sharp_check` makes one single-event request per
  triggered game through `odds_gateway`, in the capped category
  `sharp_check`: h2h, spreads, totals at Pinnacle and DraftKings, two books
  billed as one region-equivalent, at most 3 credits. Its rules:
  - **One ask per event per run.** Every trigger it covers is recorded against
    that one answer (`sharp_check_requests`, one row per trigger, ever).
  - **No retry and no stale data.** A refusal (`denied_category_cap`, the
    breaker, the cadence) is recorded and never retried. It asks with
    `want_body: false` and `allow_stale: false`.
  - **Closes.** An NBA or NHL game with an ungraded flag starting inside the
    hour gets one close check, unless one ran in the last 50 minutes. Football
    closes come from `capture`'s hourly board.
  - **At most 12 asks a run.**
- **The hourly rule.** No gateway band is under 60 minutes and every paid
  pg_cron job runs at most hourly (`odds_api_hourly_limits.sql`). So a
  triggered check lands 0 to 60 minutes after its trigger, at most once per
  event per hour. Going faster is the operator's rule to change, not this
  pipeline's.
- **Shadow first.** While `sharp_lag_config.dispatch = shadow` (the default),
  triggers are recorded and nothing is asked. The cron poke does not even wake
  the dispatcher unless dispatch is `live` and the gateway's breaker is on.

## C. Flags

A flag (`sharp_flags`, append-only, one per episode) is written when **all**
of these hold:
- the game has not started;
- the latest Pinnacle observation of the event is **at most 90 minutes old**
  (the existing past-price rule);
- the target is on the **same side at the same point**. For spreads and
  totals in v1, a target at another point is never compared;
- the target price is fresh:
  - DraftKings at most 90 minutes old;
  - Kalshi at most 15 minutes old, two-sided and at most 6¢ wide;
- **gap = Pinnacle Shin fair − the target's all-in cost ≥ 2.5 pp**. The
  all-in cost is:
  - **DraftKings:** 1 / decimal price. The vig is paid, so it stays in;
  - **Kalshi:** the YES ask plus the taker fee (next bullet).
- **The Kalshi fee.** Until an operator records Kalshi's **current published
  fee schedule** as verified in `public.market_execution_costs`, the cost uses
  the **highest plausible fee**:
  - `round_up_to_cent(0.07 × price × (1 − price))` on a single-contract order,
    the most rounding the schedule allows;
  - every such flag is marked `fee_unverified` (the database refuses a Kalshi
    flag without a verified schedule that is not so marked).

  Kalshi's site was not reachable from the build environment, so the schedule
  was **not verified here**.
- **One flag per episode.** A new flag on the same event, venue and side waits
  until the last one's gap has converged.

Each flag stores:
- the trigger type: `scheduled` for a `featured` / `close` board, or the
  trigger behind the `sharp_check` request that bought the observation;
- both prices (Pinnacle's pair and the target's price), the Pinnacle fair and
  the gap;
- the timestamps and the seconds since the Pinnacle observation;
- the snapshot resolution.





## Budget

Every paid request goes through `odds_gateway`: its monthly ceiling, its
shedding and, for this pipeline's two categories, their own daily caps
(methodology change, `docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-26-category-caps.md`).

| Item | Cap per month (30 days) |
|---|---|
| Anchor for NFL, NCAAF, MLB, MMA (reads snapshots already bought) | 0 |
| NBA + NHL `featured` baseline (3-hourly builds, 3 credits each) | ≤ 1,440 |
| `sharp_check`: 90 credits a day (30 requests) | ≤ 2,700 |
| `nba_role_props`: 48 credits a day (12 requests) | ≤ 1,440 |
| **Total** | **≤ 5,580** |

Both categories are priority 4 and shed first, at 60% of each day's
allowance.

## Operator runbook

In order. Each SQL file ends in a report whose rows should read `ok`.

1. Merge and apply the methodology change first (`supabase/odds_api_gateway.sql`).
   It creates the two capped categories **disabled**.
2. Apply `supabase/sharp_lag.sql`, then set the secrets and apply
   `supabase/sharp_lag_cron.sql` (or run **Deploy Sharp lag research**).
4. On or after 2026-11-01, once the base spend tracks its estimate, enable the
   sports and categories:

   ```sql
   select public.odds_api_set_sport('basketball_nba', true);
   select public.odds_api_set_sport('icehockey_nhl', true);
   select public.odds_api_set_category('sharp_check', true);
   select public.odds_api_set_category('nba_role_props', true);
   update public.sharp_lag_config set value = 'live', note = '<who, when>' where key = 'dispatch';
   ```

   Then set the repository variables `NBA_PRICES=on` and `NHL_PRICES=on`.
5. Before any public display, read The Odds API's terms. If they permit it:

   ```sql
   update public.sharp_lag_config set value = 'on', note = 'terms read by <who> on <date>: <clause>' where key = 'public_display';
   ```

6. Before Kalshi flags lose their `fee_unverified` mark, verify Kalshi's
   current published fee schedule and record it in
   `public.market_execution_costs` (`venue = 'kalshi'`, `taker_coefficient`,
   `verified_at`, `verified_by`, `source_url`).
