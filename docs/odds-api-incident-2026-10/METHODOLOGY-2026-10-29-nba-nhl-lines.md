# Methodology change — NBA and NHL game lines every two hours (2026-10-29)

**Type:** methodology change to the odds gateway's purchase cadence
(AGENTS.md §3). It is its own pull request and needs explicit review before it
merges. **Nothing it adds can spend.** Both leagues stay disabled until the
owner turns them on, after the November reset (step 2 below).

## Why

The owner wants Bet Checker to grade NBA and NHL bets, not only NFL and college
football (2026-10-29). A bet is graded against EdgeDesk's fair price at its line
(`signals.sharp_fair`, written by `capture`) and later against the close
(written by `close`). Neither league has any: both are registered with the
gateway **disabled** (`supabase/nba_odds_sport.sql`,
`supabase/nhl_odds_sport.sql`), so `odds_api_acquire` answers `denied_sport`.

The owner was offered two prices for their main markets (h2h, spreads, totals):

| Option | Cadence inside 72 h of the next start | Per league per day | Both leagues per month (30 days) |
|---|---|---|---|
| The gateway's default (`'*'` rows) | 60 min inside 24 h, 120 to 72 h | ≤ 24 buys × 3 = 72 | ≤ 4,320 |
| **Chosen: two hours** | 120 min | ≤ 12 buys × 3 = 36 | **≤ 2,160** |

The owner chose two hours: half the credits. The fair price a bet is graded
against may be up to two hours old instead of one, still well inside the 390
minutes Bet Checker accepts (`bet_checker_rules().fair_max_age_min`).

## What changes

**New `supabase/odds_api_nba_nhl_lines.sql`**, idempotent and pasteable:

1. It registers `basketball_nba` (group `nba`) and `icehockey_nhl` (group
   `nhl`), **disabled**, at priority 4. These are the same rows their own files
   insert. A row that exists, enabled or not, is left exactly as it is.
2. It adds 16 cadence rows: `featured` and `close`, for `nba` and `nhl`:

   | Hours to the league's next start | `'*'` (every other sport, unchanged) | `nba` / `nhl` |
   |---|---|---|
   | ≤ 3 | 60 | **120** |
   | ≤ 24 | 60 | **120** |
   | ≤ 72 | 120 | 120 |
   | beyond | 360 | 360 |

   - `odds_api_interval` reads a group's own rows when it has any, so these
     rows replace the `'*'` rows for these two leagues only.
   - **Both categories must say two hours.** Capture's `featured` and close's
     `close` ask for the same fingerprint: same endpoint, markets, books and
     format. If either said 60, the board would be bought hourly for both.
   - Rows are inserted `on conflict do nothing`, so an operator's later edit is
     kept, and the report then says CHECK THIS for that row.
3. The report: each band for each league and category, and football's band
   (still 60).

**`.github/workflows/deploy-odds-gateway.yml`:**
- a new input, `apply_nba_nhl_lines` (default on), which applies the file after
  the gateway and hourly-limit SQL;
- the new suite added to the suites that must pass before anything ships.

**`.github/workflows/odds-gateway-tests.yml`:** runs the new suite,
`tools/odds/nba_nhl_lines_sql.test.js`, on a real PostgreSQL.

**`.github/workflows/capture.yml`:** prints capture's `sports_list`. This adds
observability only. The production `CAPTURE_SPORTS` is set in Supabase and no
document records it: every run since at least 2026-10-26 reports `sports: 9`
while `DEFAULT_SPORTS` has 4. After the switch-on, the next run shows whether
capture asks for the two leagues at all (step 3).

**Not changed:**
- the breaker and the budget;
- every other sport's and category's cadence;
- the hourly floor, priorities, the shedding levels and the category caps;
- schedules and jobs;
- capture, close and their code;
- the qualification rules and edge floors.

## Before and after

On a real PostgreSQL with production's emergency stop, gateway, and NBA/NHL
registration files applied. The breaker is on, the recovery budget is set, and
both leagues are enabled. "Before" is `main`'s gateway alone. "After" adds
`odds_api_nba_nhl_lines.sql`. The NBA's next tip is 2 h away, the NHL's next
faceoff 10 h away and the NFL's kickoff 2 h away.

| Request (stored board's age) | Before | After |
|---|---|---|
| NBA `featured` (65 min) | `granted`: bought | `cache_hit`: free |
| NBA `close` (65 min) | `granted` | `cache_hit` |
| NBA `featured` (117 min) | `granted` | `cache_hit` |
| NBA `featured` (119 min) | `granted` | `granted` (two hours less the scheduler's 2-minute slack) |
| NHL `featured` (65 min) | `granted` | `cache_hit` |
| NHL `close` (117 min) | `granted` | `cache_hit` |
| NFL `featured` (65 min) | `granted` | `granted` (unchanged, hourly) |

`tools/odds/nba_nhl_lines_sql.test.js` passes 24 of 24 checks. It also checks:
- the leagues stay disabled, or enabled if an operator enabled one;
- no other cadence row changes;
- under pressure the two-hour band stretches like every band;
- with a league off, nothing is bought;
- an operator's edit is kept and reported.

**The suite fails if either category is left hourly.** Setting one band,
`close` for the NBA inside 3 h, to 60 fails 5 checks: capture's board is then
re-bought at 90 minutes.

**Committed data:** none changes. No ledger, snapshot, signal or record row is
rewritten.

## Budget effect

**Per league:** at most 12 purchases a day × 3 credits = 36 a day, about 1,080
a month. For both leagues that is **about 2,160 a month**, or about 12,000
over the rest of the regular season, which runs to mid-April.
- **The cadence is the ceiling, and in season also the estimate.**
  `capture_near` asks every hour at :12, so on a day with games the board is
  bought every two hours.
- **An empty board is free.** On a day with no games the provider bills
  nothing.

**Against the November budget** (INCIDENT.md §8):

| | Credits a month |
|---|---|
| Existing paths, expected | 30,000–42,000 |
| Research pipeline ceiling (the 2026-10-26 category caps) | ≤ 5,580 |
| **This change** | **≤ 2,160** |
| Worst case together | ≤ 49,740 |

That is inside the 57,000 breaker latch and the 60,000 operational ceiling.
The 40,000 reserve is untouched.

**Not included:**
- **The NBA and NHL research jobs** (`NBA_PRICES` / `NHL_PRICES`). They ask
  for `featured` in `american` format, so they never share capture's board.
  Both repository variables are off: the NBA build of 2026-10-29 01:07Z logged
  `[nba quotes] DISABLED`. If they are turned on, they add the ≤ 1,440 a month
  the owner approved on 2026-10-26. That is already part of the 5,580 above.

## Freshness, and what else changes

| | Football, MMA, MLB | NBA, NHL (this change) |
|---|---|---|
| Main lines inside 24 h | ≤ 60 min | ≤ 120 min |
| The close Bet Checker and the record grade against | the last board before the start, ≤ 60 min old | the last board before the start, **≤ 120 min old** |
| Under budget pressure (×1.5 / ×2 / ×3) | 90 / 120 / 180 min | 180 / 240 / 360 min |

**Shedding.** Both leagues are priority 4, shed first. Past 60% of a day's
allowance a stale NBA or NHL board is not re-bought that day:
- stored prices keep serving, labelled with their age;
- a Bet Checker bet logged after its fair passes 390 minutes is saved
  ungraded (`fair_price_stale`).

This is the gateway's existing rule, unchanged here.

**Signals on the board and record.** Once capture prices these leagues, their
lines qualify under capture's generic edge floors, the ones MMA and MLB use. So
NBA and NHL flags appear on the terminal's board and record. The owner was
told this before choosing.

**Results.** `settle`, which writes `signals.result`, is deployed but not in
this repository. Whether it settles NBA and NHL rows is checked after the
switch-on. CLV does not depend on it.

## Operator steps (after merge, on or after 2026-11-01 00:00 UTC)

Nothing can be bought before the reset. Do these **after** INCIDENT.md §9
steps 7–11 (budget, breaker, quota, schedules).

1. **Apply the file.** Run Actions → Deploy odds gateway, which applies it by
   default, or paste `supabase/odds_api_nba_nhl_lines.sql` into the SQL editor.
   Every report row should read `ok`.
2. **Turn the leagues on.** This is the spend switch:

   ```sql
   select public.odds_api_set_sport('basketball_nba', true);
   select public.odds_api_set_sport('icehockey_nhl', true);
   ```

   `{"ok": false, "reason": "unknown sport"}` means step 1 has not run.
3. **Check that capture asks for them.** The next capture run (Actions →
   Capture the board, or `capture_near` at :12) prints `sports_list`. If
   `basketball_nba` and `icehockey_nhl` are not in it, add them to the
   `CAPTURE_SPORTS` secret (Supabase → Edge Functions → Secrets), keeping
   every key already there.
4. **Watch the first day** on `admin/odds-usage/`. Each league should show
   about 12 purchases and 36 credits, and capture's `per_sport` should price
   NBA and NHL games.

**To withdraw:** `select public.odds_api_set_sport('basketball_nba', false);`
(and the same for `icehockey_nhl`). Nothing more is bought. Stored rows stay.
