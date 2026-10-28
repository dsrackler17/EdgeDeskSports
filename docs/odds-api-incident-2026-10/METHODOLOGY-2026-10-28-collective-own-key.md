# Methodology change — the Collective polls with its own key until 2026-11-01 (2026-10-28)

**Type:** methodology change to the odds gateway's bypass guard (AGENTS.md §3).
It is its own pull request and needs the owner's explicit review. The owner
chose this option on 2026-10-28 ("do option 2 so it polls before thursday").
It is **time-boxed**: it ends by itself at 2026-11-01T00:00:00Z.

## Why

The Collective's closing lines come from its own daily poll of The Odds API:
pg_cron `collective_nfl_odds` at 12:35Z and `collective_cfb_odds` at 12:40Z,
through `odds.run_ingest` to `collective_odds_ingest`. Read from production on
2026-10-28 with the read-only Collective odds doctor (#852):

| | Until 2026-10-21 | From 2026-10-22 |
|---|---|---|
| Who calls the provider | `collective_odds_ingest`, with its own key | `odds_gateway`, category `collective` |
| Which account | the Collective's own: 57 used, 443 left on Oct 21 | the main 100,000-credit account, empty since 2026-10-10 |
| Result | 872 snapshots on Oct 21 | 11 of 11 polls `denied_unconfirmed_quota`, 0 snapshots |

The redeploy of 2026-10-21 21:51Z put the repository's version live, and that
version routes The Odds API only through the gateway. The gateway refuses every
paid request until it confirms a provider quota for the cycle, and the main
account has none to confirm until it resets at 2026-11-01 00:00 UTC. So every
NFL week 7 game settled with no captured close and no against-the-spread
result. Week 8 will lose its closes the same way, starting with Thursday night's
game, unless the Collective can poll before the reset.

## What changes

`supabase/functions/collective_odds_ingest/index.ts` gains one marked block,
`BEGIN/END COLLECTIVE OWN-KEY EXCEPTION`.

`taRequest` asks the block first. The block takes the request only when all of
these hold:
1. now is before `2026-11-01T00:00:00Z`;
2. `COLLECTIVE_ODDS_API_KEY` is set. It is a new secret name, so the main
   account's key, under any of its names, can never be used;
3. the incident's master switch, `public.odds_api_enabled()`, reads **ON**. A
   breaker it cannot read counts as off. The emergency stop's breaker still
   stops it.

When it takes the request, it makes the same request the function made before
2026-10-21:
- `GET /v4/sports/<sport>/odds`, with h2h, spreads and totals, region `us`
  (3 credits) and american prices;
- the provider's `x-requests-*` headers are recorded, so the function's existing
  reserve guard (`provider.credit_reserve`, 40) and quota record
  (`provider.quota`) work as they did;
- the key is redacted from every error.

Otherwise, and from the reset on, every request goes to `odds_gateway`
unchanged.

**The guard** (`tools/odds/no_bypass.test.js`) is amended openly, not
loosened:
- Rules 1 and 2 read this one file with the block cut out. Everywhere else in
  the repository the provider host and an `apiKey=` query stay forbidden.
- `COLLECTIVE_ODDS_API_KEY` joins the forbidden key names, in files and in
  workflows.
- A new section, 1b, holds the block to its approved shape:
  - one block, in this file only;
  - the expiry is exactly 2026-11-01T00:00:00Z, and it opens only before that
    instant and only with the key set;
  - it reads no other key name;
  - it asks the breaker before the provider call, and an unreadable breaker is
    off;
  - the rest of the file reaches it only as `taRequest`'s first statement.
- After the expiry the suite prints a NOTE asking for the block's removal. It
  does not fail, so `main` cannot turn red on a date.

**Deploying one caller:** `deploy-odds-gateway.yml` gains a `callers` input,
defaulting to all four. Deploying `collective_odds_ingest` alone no longer
ships a pending change to another caller. `close` has one on `main` since
2026-10-23.

## Before and after

`tools/odds/collective_own_key.test.js` runs the deployed handler itself,
type-stripped, with the database, the gateway and the provider stubbed and the
clock injected:

| Scenario | `main`'s function | This function |
|---|---|---|
| Thursday 12:35Z, key set, breaker on | asks the gateway, refused, 0 snapshots | one request to The Odds API with the Collective's key; the board is stored, the close finalized, the own balance (440) recorded |
| 2026-10-31T23:59:59Z | gateway | provider |
| 2026-11-01T00:00:00Z, key set | gateway | gateway; the key is ignored, the breaker not consulted |
| No key, a blank key, or only THE_ODDS_API_KEY / NFL_ODDS_API_KEY / ODDS_API_KEY set | gateway | gateway |
| Breaker off, or unreadable | gateway | nothing called; the run is recorded as an error naming the breaker |
| The provider answers 401, echoing the key | n/a | error recorded; the key appears nowhere |
| 42 credits left, reserve 40, a 3-credit poll | skipped (`credit_budget`) | skipped (`credit_budget`); nothing bought |

| Suite | `main`'s code | this code |
|---|---|---|
| `tools/odds/collective_own_key.test.js` | 13 / 16 | 29 / 0 |
| `tools/odds/no_bypass.test.js`, unamended | 102 / 0 | 100 / 2 (rules 1 and 2 catch the block) |
| `tools/odds/no_bypass.test.js`, amended | — | 110 / 0 |

Each suite was mutation-checked. Each of these turns the guard red:
- the expiry moved a week later;
- the block reading `THE_ODDS_API_KEY`;
- the host named outside the block;
- the breaker read after the provider call;
- the new key read in another function;
- a second call site.

Dropping the breaker check or moving the expiry turns the end-to-end suite red.

`tsc --strict` reports for the function exactly the one error it reported on
`main` (`URLSearchParams.keys` missing from the DOM lib), and no new one.

**Committed data:** none changes. **Budget effect:**
- 3 credits a poll, two polls a day, so about 24 credits through Oct 31,
  from the Collective's own account (443 left).
- Nothing touches the main account or the gateway's ledger.
- Calls beyond the daily schedule (an operator's Run now) are still bounded by
  the Collective's own plan and its reserve guard.

## Operator steps

1. **Set the key.** The Collective's own The Odds API key is the account that
   showed 57 used and 443 remaining on 2026-10-21, not the main 100,000-credit
   account. Set it in the Supabase dashboard (Edge Functions → Secrets), or run:
   ```
   supabase secrets set COLLECTIVE_ODDS_API_KEY=<the Collective's key>
   ```
2. **Merge, then deploy that one function.** Use Actions → Deploy odds gateway
   with `apply_gateway_sql`, `apply_hourly_limits` and `deploy_gateway`
   unchecked, `deploy_callers` checked, and `callers` set to
   `collective_odds_ingest`.
3. **See it work.** Either use the admin console's Run now, or wait for the
   12:35Z poll. Then run Actions → Collective odds doctor: the latest
   `odds.ingest_runs` row should read `ok` or `partial` with snapshots
   written, and `provider.quota` should show the Collective's balance.
4. **After 2026-11-01:**
   - unset `COLLECTIVE_ODDS_API_KEY`;
   - confirm the gateway's new-cycle quota (INCIDENT.md §9 step 8, the free
     quota probe), or the Collective is refused again;
   - remove the block and section 1b in a follow-up.

**Kill switches while it runs:** `nfl.enabled` / `ncaaf.enabled` = false in
`odds.settings`, unsetting the secret, or the odds_api breaker. The breaker is
honoured directly. Applying the 2026-10-28 emergency-stop change also lets the
stop pause the two cron jobs.
