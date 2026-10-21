# College baseball research engine — deployment and rollback

EdgeDesk is a static site plus scheduled Node jobs. The college baseball
engine adds no server, no database table and no secret: everything it shows
is a committed file under `college_baseball/` read by
`lib/edgedesk_cbase_ui.js` (Research → Baseball → NCAA engine).

## Deploy

1. **Merge the branch.** GitHub Pages serves the new files; the NCAA engine
   segment appears in Research → Baseball. Nothing else in the app changes
   (one segment button, one render branch in `app.html`).
2. **Enable the workflows** `.github/workflows/college-baseball-research.yml` (tests), `college-baseball-research-build.yml` and `college-baseball-research-validate.yml`
   (it is on by default once merged):
   - daily 11:23 UTC, February–June: today's season ingested, coverage,
     board, audit, gates, committed with `tools/ci/push_generated.sh`;
   - weekly Monday 12:53 UTC: every validation record refit (no tuning);
   - by hand: `mode=tune` (SELECTION-window tuning, recorded in the
     registry), `mode=backfill` (every season re-ingested).
   It needs no secret and spends no odds credit (`tools/odds/no_bypass.test.js`).
   The weekly refit never looks at the HOLDOUT: it carries forward the
   registered look of the same model version and pricing model, labelled.
   If a refit changes the pricing model, the holdout is withheld (gates G8–G10
   fail) until someone deliberately runs `node college_baseball/walkforward.js
   --holdout`, which counts against the three-looks limit (research/PROTOCOL.md).
   Every run regenerates `docs/college-baseball/REPORT.md` from the evidence.
3. **First run after merge**: `workflow_dispatch` of `college-baseball-research-validate.yml` (mode `validate`, the default) so the
   committed records are rebuilt on the runner, then `college-baseball-research-build.yml` in season.
4. **Before any price is shown as more than research**, every release gate
   must pass (`node college_baseball/release_gates.js --check`). Today G1
   (data rights), G8–G10 (holdout status, if not yet evaluated or not
   validated) and G12 (market settlement) fail by design; see
   `docs/college-baseball/REPORT.md`.

Owner actions that unblock gates:

| Gate | Action |
|---|---|
| G1 | Review the NCAA terms for the stats behind baseballr-data; record the decision in `college_baseball/research/authorizations.json` as `{ "baseballr_data": { "commercial_use": true, "signed_by": "<name>", "date": "<YYYY-MM-DD>" } }` |
| G12 | Capture prices (below), verify each book's college-baseball settlement rules, and mark the matching profile in `college_baseball/lib/pricing.js` VERIFIED |

**Prices, from the first game of the season.** The model can only be market-validated on prices captured after it was frozen (EXPERIMENTS.md, CBASE-H1), so capture has to start before the first pitch of 2027. Three owner actions, in order:

1. Apply `supabase/cbase_odds_sport.sql` (also `supabase/migrations/20261021200000_cbase_odds_sport_row.sql`). It registers `baseball_ncaa` DISABLED, at priority 5, so it is shed first.
2. Enable it in the gateway: `select public.odds_api_set_sport('baseball_ncaa', true);`.
3. Set the repository variable `CBASE_PRICES` to `on`. `.github/workflows/college-baseball-prices.yml` then runs every 20 minutes from 14:00 to 04:59 UTC, February to June.
   - Each run is one `featured` request: about 3 credits when bought, and nothing inside the gateway's cadence window. The worst case is about 100 credits a game day.
   - It keeps prices under `college_baseball/data/market/`.

Withdraw with `select public.odds_api_set_sport('baseball_ncaa', false);` or by unsetting `CBASE_PRICES`.

Each run's `college_baseball/data/market/quotes.json` names any provider team name it could not join (`unmatched_names`) and the names it joined by our team name (`matched_by_name_prefix`).
- Add a name that is one of our teams to `college_baseball/market/aliases.json`, with its team id.
- Correct one there if a prefix match is wrong.

`python3 -m research.clv.cbase` counts the forward test's games and bets. It reads the holdout once, at 500 bets or from 2027-06-30 (the price workflow runs it after each capture). Its verdict goes to `college_baseball/validation/market_clv.json`, and the board's value claims follow `college_baseball/lib/market_gate.js`.

## Rollback

The engine is additive; rolling it back never touches another sport.

- **Hide the segment only**: remove the `ncaa` button from `#mlbhSeg` in
  `app.html` (one line). The board files stay, unused.
- **Freeze the data**: disable the workflow in the Actions tab. The last
  committed board stays as it was, labelled with its build time.
- **Return to the last validated model**: `college_baseball/params/production.json`
  names the last version whose audit had no critical failure, with the
  evidence hash; `research/audit_log.jsonl` lists every promotion and refusal.
  Check out `college_baseball/params/` and `college_baseball/validation/` at the
  commit of that promotion and run `node college_baseball/build_slate.js`.
- **Remove everything**: delete `college_baseball/`, `lib/edgedesk_cbase*`,
  `tools/college_baseball/`, the workflow, and revert the `app.html`,
  `lib/edgedesk_sport_brains.js`, `engine/build_registry.js`,
  `tools/lab/lab.test.js` and `tools/odds/no_bypass.test.js` edits; then
  `node engine/build_registry.js`.

## Verify after deploy

```bash
node tools/college_baseball/run_tests.js        # engine, UI (Chromium), existing sports
node college_baseball/build_slate.js --check
node college_baseball/release_gates.js           # prints every gate with its reason
```
