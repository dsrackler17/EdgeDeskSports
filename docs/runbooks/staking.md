# Runbook — the staking engine (Slice 8)

What it is: the deterministic layer that turns a priced opportunity into a
number of units under the reader's own risk policy. It computes no
probability; it reads them from the intelligence and pricing kernels and
applies a written policy. The language model explains its output and cannot
change a number in it.

## Deploy, in order

1. **Apply the migration.** Paste `supabase/bankroll_and_stakes.sql` into the
   Supabase SQL editor and run it. It is idempotent and additive; the last
   statement is a report whose every row must read `ok`. A row reading
   `CHECK THIS` names what is wrong — fix that and run the file again.
   Verify locally first if you like: `npm run intel:stake:sql` applies the
   same file twice to a throwaway cluster and attacks it.

2. **Deploy the edge function.** `supabase/functions/edgedesk_ai/index.ts`
   carries `EDSTAKE` inlined. Edit `_stake.js`, never `index.ts`, then
   `node tools/presentation/inline.js` and paste the function. `npm run
   intel:lint` fails on drift.

3. **Commit the validation artifacts.** `football/validation/staking_nfl.json`
   and `staking_cfb.json` decide which markets may be recommended. Regenerate
   with `npm run stake:validate:write`. A missing artifact does not block
   anything (the tier caps still govern); a committed SHADOW does.

4. **Deploy `app.html`** for the sizing panel, the router and the bankroll
   editor.

5. **Nothing else is required.** With no `bankroll_settings` row the engine
   answers in units under the printed defaults and says an exact dollar amount
   needs a bankroll. It never assumes one.

## Switches

| env (on `edgedesk_ai`) | default | effect |
|---|---|---|
| `EDGEDESK_STAKING` | `1` | `0`: no card is built and the answer is the board alone — the behaviour before this slice |
| `EDGEDESK_STAKE_TOP` | `5` | how many positions one card may emit |
| `EDGEDESK_STAKE_POLICY` | unset | a JSON object of policy defaults for a deployment with no settings row. It can only TIGHTEN: a cap above the shipped default and a floor below it are both ignored, so a deployment cannot loosen the policy silently |

`?probe=1 → staking_kernel` reports whether the kernel loaded, the caps in
force, the gate list, the reliability weights, the deployment overrides that
were accepted and the last audit-trail write.

## The default risk policy

Quarter Kelly on the **conservative** probability. Sizes 0 / 0.25 / 0.50 /
0.75 / 1.00 units, rounded **down**. At most 1.00u on one wager, 1.25u on one
game, 1.50u involving one team, 4.00u in a day, 8.00u in a week. At most two
positions involving one team. Parlays off; when enabled, 2–3 legs, 0.10u–0.25u,
and only against the book's own verified combined price.

A reader changes any of it in `bankroll_settings`. The database refuses an
incoherent set (a single cap above the game cap, a daily cap above the weekly
one, a parlay minimum above its maximum), so a policy that cannot be obeyed
cannot be stored.

## When a reader asks why they got 0 units

Read the recommendation, not the prose. Every PASS carries `gates_failed` with
the code and the detail, and the trail stores the same thing in
`stake_recommendations.pass_reason`:

- `CONSERVATIVE_EV_NOT_POSITIVE` — the price is not good enough. The detail
  names the price that would be.
- `BELOW_MINIMUM_UNIT` — the edge is real and the position it earns rounds
  below 0.25u. This is a WATCH, not a rejection.
- `EXPOSURE_CAP` — a cap left nothing. The detail names which cap and what is
  already on it. No price change fixes this one.
- `MARKET_IN_SHADOW_MODE` — the walk-forward has not released this market.
  `football/validation/staking_<sport>.json` carries the numbers.
- `STALE_PRICE` / `NO_EXECUTABLE_QUOTE` / `ODDS_UNVERIFIED` — a capture
  problem, not a betting judgement. Check the capture function.
- `RELIABILITY_BELOW_FLOOR` — the detail names the weakest component, which is
  the thing to fix.

`select * from public.stake_pass_reasons` counts them, because a pass is a
result and is reported like one.

## When a reader asks whether it works

`select * from public.stake_engine_scorecard` — profit at the engine's own
sizes beside a flat 0.5u and a flat 1u on the same selections, with a sample
floor beside every row. Below the floor no reading is claimed. CLV, Brier and
log loss are in `stake_recommendation_grades`.

The honest current answer, from `npm run stake:validate`: no market has
earned BET. The NFL spread and total are SHADOW and both college markets are
RESEARCH_ONLY, so nothing is recommended on model grounds, and a market-de-vig
price edge is capped at 0.75u with the CLV ledger as its only record.

## What this layer will never do

Place a bet. Assume a bankroll. Produce a size from a language model. Raise a
size for conviction, a rivalry, a revenge angle or an atmosphere. Round a size
up. Recommend both sides of a market. State a combined parlay probability.
Rewrite a recommendation after the market moves — a later view is a new row.
