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
| The research registrations | `research/sharp_lag/registration_sharp_lag.json`, `registration_role_shift.json`, generated into `supabase/sharp_lag_registry.sql` |
| NBA role shifts: the scenarios (3-hourly NBA build) | `nba/props/role_shift.js`, written to `nba/role_shift.json` by `nba/props/build_props.js` |
| NBA role shifts: the game page | `lib/edgedesk_nba_ui.js` ("Who absorbs the minutes") |
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

## Registered validation

Both models are registered EXPERIMENTAL in the research registry
(`supabase/sharp_lag_registry.sql`, generated from the JSON, never edited by
hand) **before the first flag is graded**. The database enforces the order:
a grade names its registry version, and none is accepted without it.

| Model | Promotion rule |
|---|---|
| `SHARP-LAG` v0.1 | **200+ graded flags AND** the lower end of the two-sided 95% percentile interval of the mean CLV above zero. The interval is a game-clustered bootstrap: 2,000 resamples of whole games, seed 20261026. |
| `NBA-ROLE-SHIFT` v0.1 | The same rule, on its own flags; flag threshold 2.5 pp. |

Meeting both makes a model **eligible**. A person promotes it, through a
validation report; no code does.

## D. Grading

After the start (10 minutes after, so the last board is in), each flag gets
one grade (`sharp_flag_grades`, append-only, once):
- **Close:** the last Pinnacle observation of the same side and point at or
  before the start.
  - If it is more than 90 minutes before the start, or absent, the flag is
    **no close**: counted, with its reason, excluded from CLV.
  - The no-close count and rate are a data-quality line on the record.
- **Target close:** the target's last price before the start, attached.
- **CLV (pp)** = closing Pinnacle fair − the flag's all-in cost. **Hit** =
  CLV > 0.
- **Lag to converge:** the first target observation after the flag whose gap
  to the Pinnacle fair current at that moment is under **1.0 pp**. It is
  censored at the start (never converged), and reported with the flag's
  snapshot resolution.

The record is computed straight from the append-only tables, with no edit
step. It splits by sport, market and trigger: flags, graded, no close, average
CLV, hit rate, average lag and resolution.

## E. Where it shows (all tagged Experimental)

- **Game research page.** The NFL and CFB research page (`#game/...`) and
  the terminal's matchup view (the games page, every sport) each get a
  "Sharp lag · Experimental" section with the game's flags:
  - target price, Pinnacle fair, gap and trigger;
  - each price's age, where an observation older than 90 minutes reads as a
    **past price**, never a current one.
- **Signals.** A feed of today's flags, each tagged Experimental with its
  time.
- **Performance.** The public "Sharp lag (Experimental)" record.
- **Every surface** shows the registered threshold and the progress ("47 of
  200 graded flags").
- **Who sees what.**
  - Live Pinnacle fairs and live flag details are **subscriber-only**,
    consistent with `signals`.
  - The public gets the validation progress (counts only) always. It gets
    the graded record and every flag's details once its game has **started**,
    and only after an operator has read The Odds API's terms and switched
    `public_display` on. `the-odds-api.com` was not reachable from the build
    environment, so the terms were **not checked here**.
  - The public `/today/` page has no Sharp-lag section and makes no
    Sharp-lag read.
- **How it reads.** Every page reads through `public.sharp_lag_flags()` and
  `public.sharp_lag_progress()` only: the terminal under the reader's own
  token (`window.slData` in `app.html`), the Performance page with the public
  anon key (`performance/sharp_lag.js`). The database decides what each reader
  sees; the pages never filter access themselves.
- **Tests.** `tools/sharp_lag/sharp_lag_ui.test.js` checks the helpers, the
  wiring and the Performance script against a stubbed database.
  `tools/sharp_lag/sharp_lag_ui.e2e.js` draws every surface in Chromium at
  390 px and 1280 px: no page error, no sideways scroll.

## F. NBA role shifts (Experimental)

Research model **NBA-ROLE-SHIFT v0.1**, registered on its own
(`research/sharp_lag/registration_role_shift.json`). It asks one question:
when a rotation player sits, does the market under-adjust his teammates'
volume props?

**The scenarios (`nba/props/role_shift.js`, in the 3-hourly NBA build).**
`nba/props/build_props.js` fits the props model, writes the default slate
unchanged, and then writes `nba/role_shift.json`: one scenario per top-8
rotation player (reference minutes, `nba/roster_inputs.json`) of every
upcoming game. `props_slate.json` only points at it, under `regimes`.

- **Splits (primary, game level).** For each teammate, his games without the
  absent player and with him, this season and last, while both were on the
  club. A listed DNP and a game the absent player is missing from the box
  both count as "without". Minutes, usage (FGA + 0.44 FTA + TOV), FGA, 3PA,
  REB, AST and PTS per game and per minute, shrunk toward "with" by 10 games:
  `(n_without × without + 10 × with) / (n_without + 10)`.
- **Regime.** The existing props model's prediction for the teammate, moved
  by the splits: the model's minutes plus the shrunk minutes delta, on the
  model's own minutes nodes; each per-minute rate × shrunk / with; the
  model's variance function and correlations unchanged. 3-pointers made are
  the regime's 3PA × his 3P%, shrunk toward the league's with 100 attempts.
  The default beside it makes 3PM the same way, so a change is the
  absence's alone.
- **Cross-check (stints, reported beside, never overriding).** In games both
  played: his share of the court time with the absent player on and off the
  floor, the minutes that implies, and his FGA, 3PA and assists per 36 either
  way (play-by-play shots). Rebounds are not in the stints.
- **Priced teammates.** The 3–4 with the largest minutes or usage change get
  the four volume markets: the regime's P(over) at every half-point line
  within 5 of the mean, and the fair line nearest 50%.
- A player who missed his team's last game gets no scenario: the default
  already prices the team without him.

**The switch (the free `sharp_lag` function).** When two consecutive injury
reports move a top-8 player to OUT or DOUBTFUL (not QUESTIONABLE), the
function records one `role_shift` trigger per player and game. Its detail
holds the regime switch (`projected` → `injury_conditioned`, the build's
time), the absent player's move and the priced teammates. A scenario file
older than 24 hours switches nothing on.

**The prices (`sharp_check`, paid, through the gateway).** One
`nba_role_props` request per game: rebounds, assists, 3-pointers made,
points + rebounds + assists, ten books, one region-equivalent, ≤ 4 credits,
inside the category's daily cap. Ingest stores only the named teammates'
props. Inside the last hour, an ungraded role-shift flag gets one close
check the same way.

**Flags.** From the trigger's own pull only: at the first book posting a
two-way half-point line for the teammate and market (DraftKings, FanDuel,
BetMGM, Caesars, ESPN BET, BetRivers, Fanatics, Hard Rock, BetOnline,
Pinnacle), the regime's P(side) − 1 / decimal (vig included) ≥ 2.5 pp. A
whole-number line is not evaluated, a price over 90 minutes old is a past
price, and the absent player's own unders are never flagged (the database
refuses them too). Each flag stores the absent player, the minutes delta,
both samples (games without, stints), both lines (fair and posted) and both
prices (fair and posted). Its resolution is the time from the report to the
pull.

**Grades.** Once the game has a final ESPN box score (or a day after the
start without one): the same book, player, market and line, the last
two-way price at or before the start and at most 90 minutes before it (else
no close, counted). CLV = its Shin P(side) − the flag's cost. The player's
actual stat and over / under / push / void are stored beside CLV; CLV is the
registered criterion.

**Where it shows.** The NBA game page (`#research/nba/<game>`): "Who absorbs
the minutes · Experimental", switched on by OUT or DOUBTFUL on the game's
current injury report, and the game's Sharp-lag flags with each model's
progress. Performance: the role-shift record, with the actual results.

Tests: `tools/sharp_lag/role_shift.test.js` (a constructed team, worked out
by hand), the role sections of `sharp_lag_fn.test.js` and
`sharp_lag_sql.test.js`, and the NBA page in `sharp_lag_ui.e2e.js`.

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
3. Apply `supabase/sharp_lag_registry.sql`: the registrations, before any
   grade.
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
7. Role shifts need nothing more: the scheduled NBA build publishes
   `nba/role_shift.json` every 3 hours, and `sharp_lag` reads it from
   `NBA_ROLE_SHIFT_URL` (default `https://edgedesksports.com/nba/role_shift.json`).
   A file over 24 hours old switches nothing on, and the run says
   `role_shift_stale`. Grades read ESPN's game summary (`NBA_SUMMARY_URL`).
