# Collective tooling

Four files, in the order you would actually reach for them.

## Getting your own model's picks onto the board

**`nfl_preflight.sql`** — why the NFL model has not produced a row yet.
Paste it into the Supabase SQL editor. Read-only, costs no odds credits, and
every line of the answer comes out of your own database rather than from a
guess about what might be wrong. Run it again after each fix and watch the
blockers turn to `ok`.

The same answer, in the model's own words, including the per-event
`missing_features` list:

```
curl "https://<project>.supabase.co/functions/v1/model_predict?dry=1&sport=NFL"
```

`?dry=1` runs everything and writes nothing.

**`model_to_csv.sql`** — turns what `nfl_game_v1` wrote in
`public.model_predictions` into the upload CSV. Run it, Export → CSV, drop
the file on the Collective. Headers are the ones the uploader recognises by
name, so nothing needs mapping by hand and the "which number is this?"
question never comes up.

It reads only. It computes no probabilities and invents no picks, so if the
model has not run it returns zero rows — which is the correct answer, and
`nfl_preflight.sql` says which of the three reasons it is.

Every column is read through `to_jsonb`, deliberately. `public.model_predictions`
is not the same shape in every project — the live EdgeDesk table has no
`model_detail` — and naming a column directly makes the whole export fail with
`column "..." does not exist`: no file at all, rather than a file with a
couple of columns blank. Through jsonb an absent column is a NULL. The pick,
the market line and the probabilities survive any missing optional column; the
preflight's two `model_predictions columns` rows say which ones you have.

The pick on each game is the spread side with the largest `model_edge`: the
probability gap between the model and the de-vigged market. That is the price
discrepancy, stated as a number. `model_edge_pct`, `model_ev_pct`,
`market_prob_pct` and `best_price` come along for sorting; the uploader
ignores every header it does not recognise, so leave them in or delete them.

## Starting from the market instead

**`week1_template.sql`** — the same CSV shape built from captured odds, with
the `pick` column left deliberately empty for you to fill. Useful when you
want the slate and the numbers in front of you and the picks are coming from
somewhere other than `model_predictions`.

## Submitting without the browser

**`submit_csv.py`** — stdlib-only, dry-run by default:

```
COLLECTIVE_KEY=... python3 tools/collective/submit_csv.py slate.csv
COLLECTIVE_KEY=... python3 tools/collective/submit_csv.py slate.csv --send
```

Same parsing rules as the in-page uploader, including the sign convention.

## The sign convention, once

`line_at_submission`, `market_line` and `projected_spread` are all the **home**
team's number. Negative means the home team is favoured. So an away pick of
"NE +3.5" is stored as `-3.5`, because the home team is laying it.

`sim_mean_margin` in `model_detail` runs the other way — home minus away,
positive means the home team wins by that much — which is why
`projected_spread` is its negation. Get this backwards and every game on the
board inverts while still looking entirely reasonable. It is pinned in
`tests/collective/model_to_csv.test.mjs` and `slate_upload.test.mjs`.

## Tests

```
sh tests/collective/run_all.sh
```

Needs a local Postgres and Node 22+. `model_to_csv.test.mjs` runs the real
exporter against a real database and feeds the resulting bytes to the
uploader's own parser, extracted from the deployed `collective/index.html` —
the two files never reference each other, and the CSV between them is the
only place they have to agree.
