# Methodology change — per-category daily caps in the odds gateway (2026-10-26)

**Type:** methodology change to the odds gateway's budget guards (AGENTS.md §3).
It is its own pull request and needs explicit review before it merges.
Nothing it adds can spend: both new categories are created **disabled**.

## Why

The Sharp-lag research pipeline (a separate pull request) buys two kinds of
event-driven requests through `odds_gateway`:

- `sharp_check`: one event's Pinnacle and DraftKings main markets after a
  trigger (an NBA starter's status change, an NHL goalie change, a Kalshi move
  of 3¢ or more), plus a pre-tip closing check for NBA and NHL games with a
  flag;
- `nba_role_props`: one NBA event's volume player markets after a rotation
  player is ruled out.

A trigger is a news event, so its volume is not bounded by a schedule. Before
this change the gateway had **no per-category limit**: a category could spend
until the shared daily allowance shed it, at 60% of the day for priority 4.
On a quiet day that is hundreds of credits for one research category. The
owner's decision (2026-10-26) was a cap **enforced by the gateway itself**,
not by the caller: the October incident came from six callers each holding a
private budget that nothing could see.

## What changes

`supabase/odds_api_gateway.sql` (and its six SQL-editor parts, regenerated):

1. `odds_api_categories.daily_cap_credits integer`. NULL means no cap of its
   own, which is every category that existed before. A check constraint
   refuses a negative cap.
2. `odds_api_acquire` refuses a paid request with `denied_category_cap` when
   the category's credits today (UTC), settled at `x-requests-last` or still
   reserved at their upper bound, plus this request's upper bound would exceed
   the cap. The check runs:
   - under the same `odds_api_config` row lock as every other budget decision,
     so concurrent workers cannot both take the last credits under the cap;
   - after the breaker, cooldown, quota, ceiling, emergency and reserve checks
     and before the shedding check. It only ever refuses: none of those is
     relaxed;
   - for paid requests only. A cache hit costs nothing and is never refused.
3. Two categories, **disabled**, at priority 4 (shed first, with the
   alternate ladders):

   | Category | Endpoint | Markets | Books | Cost per request | Daily cap |
   |---|---|---|---|---|---|
   | `sharp_check` | `/events/{id}/odds` | h2h, spreads, totals | pinnacle, draftkings (1 region-equivalent) | ≤ 3 | 90 (30 requests) |
   | `nba_role_props` | `/events/{id}/odds` | player_rebounds, player_assists, player_threes, player_points_rebounds_assists | the props category's ten books (1 region-equivalent) | ≤ 4 | 48 (12 requests) |

4. Cadence rows: both are bought only inside 24 h of the start, at most hourly
   per event (the hourly floor constraint still refuses anything faster).
   `nba_role_props` is never polled for any other sport.
5. `odds_api_spend_patterns()` gains `%/functions/v1/sharp_check%` and
   `%sharp_check_poke%`, so the emergency stop pauses the hourly dispatcher
   and `odds_api_hourly_limits.sql` holds it to hourly.
   - The second pattern is needed because the pg_cron command is
     `select public.sharp_check_poke();`. It carries no URL, as with
     `capture_poke`.
   - The list is changed in `odds_api_emergency_stop.sql`, the source of truth.
   - The gateway file re-creates the identical list, so applying the gateway
     reaches a live database without re-running the stop, which would re-pause
     every job. A test keeps the two lists identical.
   - The free `sharp_lag` function deliberately matches no pattern: it never
     calls the gateway or the provider.
6. Two report rows (11 and 12) confirm the caps and the spend pattern.

## Before and after

On a real PostgreSQL (`tools/odds/gateway_sql.test.js`, section 14). "Before"
is the same test file run against `main`'s gateway SQL.

| Scenario | Before (`main`) | After |
|---|---|---|
| The capped categories exist | no: `column "daily_cap_credits" does not exist`, live layer aborts | yes, disabled, priority 4, caps 90 / 48 |
| A disabled capped category asks | n/a | `denied_category` |
| Three 3-credit checks against a cap of 9 | n/a | all three granted |
| The fourth | granted until the shared allowance sheds it | `denied_category_cap`, reason names spent and cap |
| A settled request billed 0 of its 3 reserved | n/a | the 3 credits come back under the cap |
| A cache hit at the cap | n/a | `cache_hit`, free |
| `featured` / `props` at the same moment | granted | granted (no cap of their own) |
| A new UTC day | n/a | the cap starts again |
| Cap set to 0 | n/a | every paid request refused, category still enabled |
| Cap set to -1 | n/a | refused by `odds_api_categories_daily_cap_chk` |
| 12 concurrent checks, 12-credit cap | n/a | exactly 4 granted, 8 `denied_category_cap`, reservations = 12 |
| `sharp_check` 30 h out | n/a | `skipped_window` |
| `nba_role_props` for an NFL event | n/a | `skipped_window` |
| The emergency stop covers `/functions/v1/sharp_check` and `sharp_check_poke()` | no | yes; `sharp_lag` (URL or poke) is not a spend path |
| Suite totals | 70 passed, 5 failed | 104 passed, 0 failed |

Every assertion that existed before passes unchanged. The only edit to an
existing check is the report's row count, from 10 to 12.

**Committed data:** none changes. This touches only the control plane's
schema and functions. No ledger, snapshot or record row is rewritten.

## Budget effect

At the caps, worst case per month (30 days): `sharp_check` ≤ 2,700,
`nba_role_props` ≤ 1,440. With the NBA and NHL `featured` baseline the owner
approved (≤ 1,440), the research pipeline's ceiling is ≤ 5,580 credits a
month. That sits on top of the existing paths' 30–42K estimate (§8 of
INCIDENT.md), inside the 57,000 breaker latch and the 60,000 operational
ceiling. The caps are ceilings: priority 4 is shed at 60% of each day's
allowance, so real spend is expected well below them.

## Operator steps (after merge)

1. Apply `supabase/odds_api_gateway.sql` (or its six parts in order). Rows
   1–12 of the report should read `ok`. The breaker, the budget and every
   existing category are left as they were.
2. Do **not** enable `sharp_check` or `nba_role_props` until the Sharp-lag
   pull request is merged and deployed, and until November's first days show
   the base spend tracking under its estimate:

   ```sql
   select public.odds_api_set_category('sharp_check', true);
   select public.odds_api_set_category('nba_role_props', true);
   ```

3. To change a cap (credits per UTC day; 0 stops the category):

   ```sql
   update public.odds_api_categories set daily_cap_credits = 60 where category = 'sharp_check';
   ```
