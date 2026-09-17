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

   `football/validation/markets_extra.json` is the separate door for a team
   total or a player prop, which the kernel otherwise declares out of scope.
   Regenerate with `npm run stake:extra:write`. It opens **nothing** today and
   says why per market: neither closing-line archive carries such a line, so
   there is no history to hold out. An empty `markets` list is the expected
   state and is a result, not an omission.

4. **Deploy `app.html`** for the sizing panel, the router, the bankroll
   editor, the took-it / passed controls and the declared-position editor.

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

The quote refresh is targeted rather than reflexive: a capture pass is spent
only where a stale or aging price sits on a game that has **not started** in a
market EdgeDesk can size, because those are the only refusals a fresh price
can fix. Every refresh records what it bought — `board.sports[].refresh.outcome`
carries the targets before, how many came back current, how many prices moved
and whether the refresh changed an answer at all. A refresh that changed
nothing is recorded as one.

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
  the thing to fix. `weather_certainty` is one of the nine: a 28 mph
  crosswind costs a total more than a side, and a forecast made six days out
  costs something even when it says calm.
- `WEATHER_UNOBSERVED` — the forecast source was read and carries nothing for
  an outdoor game in the market weather moves most. A WATCH, not a rejection:
  a forecast arriving makes it a bet. It never fires on a sport with no
  forecast source wired, because that is a gap in the host rather than a fact
  about the game.
- `MARKET_OUT_OF_SCOPE` on a team total or a prop — see
  `football/validation/markets_extra.json`, which records what would open it.

A card also carries `one_price_away`: the positions whose **only** failed gate
is the age of the price. That is the difference between "EdgeDesk disagrees"
and "EdgeDesk has not looked recently enough", and it is the one refusal a
capture pass can fix.

`select * from public.stake_pass_reasons` counts them, because a pass is a
result and is reported like one. The nightly learning loop publishes the same
counts into `football/validation/scorecard.json` under `staking.passes`.

## When a reader asks whether it works

`select * from public.stake_engine_scorecard` — profit at the engine's own
sizes beside a flat 0.5u and a flat 1u on the same selections, with a sample
floor beside every row. Below the floor no reading is claimed. CLV, Brier and
log loss are in `stake_recommendation_grades`.

`npm run intel:learning-loop` publishes the same comparison, unattended, into
`football/validation/scorecard.json` under `staking`: the engine against both
flat baselines by sport, market, tier and model version, the pass ledger by
gate, and the acceptance record. Every group carries a one-sentence `reading`
that refuses a verdict below the 50-graded-position floor **in either
direction**. The reader's own record (`staking.acceptance`) is reported
separately and is never added to the engine's: a bet the reader declined is
not a bet the engine lost, and a bet the reader resized is not the bet the
engine sized.

The honest current answer, from `npm run stake:validate`: no market has
earned BET. The NFL spread is SHADOW; the NFL total, the NFL moneyline and all
three college markets are RESEARCH_ONLY. So nothing is recommended on model
grounds, and a market-de-vig price edge is capped at 0.75u with the CLV ledger
as its only record.

Two things about that run are worth knowing before quoting it. The threshold
search is **Holm-corrected** across the family of thresholds it tests, so a
record that clears `p < 0.05` at its best threshold no longer earns a tier on
that alone — which is why the NFL spread fell from dozens of positions to
single figures. And the model it graded is named in `frame.model_graded`: the
shipped engine is replayed cold where the nflverse team-week feeds are cached,
and the Elo stand-in is the stated fallback where they are not. Per-market use
is all-or-nothing and each holdout records which it got in `model_source`, so
no market ever mixes the two.

## Did the reader take it

Whether a recommendation was accepted is the one part of the record the desk
cannot compute, and without it the engine's record and the reader's record are
the same number — which is wrong in both directions.

The sizing panel asks, under every sized position: took it at the recommended
size, took it at a different size, or passed. Each writes one row into
`public.stake_recommendation_responses` (`ACCEPTED` / `MODIFIED` / `DECLINED`
/ `EXPIRED`) under the reader's own token. It is append-only and a foreign key
requires it to answer a recommendation that was actually issued, so a second
answer is a second row rather than an edit — changing your mind is recorded as
changing your mind, and nothing a reader does can touch the frozen snapshot.

`stake_recommendation_grades.reader_response` reads the latest one through.
`scorecard.json → staking.acceptance` reports the rate, how often the size was
followed, and the reader's own profit beside what the engine's size would have
returned on the same bets — reported beside each other and never summed.

## The exposure the desk cannot see

Every cap is computed from positions EdgeDesk recommended. A reader with 3u on
Sunday from somewhere else has a "4u daily cap" that would happily add four
more — a cap on the part of their book this system knows about, which is a
weaker promise than the number implies.

`public.external_positions` closes that. A reader declares a wager they placed
elsewhere and `stake_open_exposure` unions it into the caps as a `DECLARED`
position. Unlike the trail this table is mutable and deletable by its owner:
it is their record of their own bets, not EdgeDesk's record of its own claims.
It is **never graded and never scored** — it appears in no scorecard, no CLV
ledger and no flat-staking comparison, and it can only ever make the engine
size less. `card.exposure.declared_units` says how much of the carried
exposure came from there.

Every view in the migration is `security_invoker = true`. A PostgreSQL view
runs as its owner unless told otherwise, and a view over an RLS-protected
table would otherwise read every row in it — one reader could select another
reader's whole book through `stake_open_exposure` while being correctly
refused the table itself. The report at the end of the migration checks it.

## What this layer will never do

Place a bet. Assume a bankroll. Produce a size from a language model. Raise a
size for conviction, a rivalry, a revenge angle or an atmosphere. Round a size
up. Recommend both sides of a market. State a combined parlay probability.
Rewrite a recommendation after the market moves — a later view is a new row.
