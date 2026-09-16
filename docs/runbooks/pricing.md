# Runbook — the pricer

## What it is

The desk quotes a fair line, the cover probability at any number, the line a
side is worth betting to, and a status per side. All of it comes from three
artifacts and one kernel:

- `football/pricing/lines_nfl.json` — the closing-line archive (`npm run football:lines`)
- `football/validation/pricing_nfl.json`, `pricing_cfb.json` — the validation
  record: tiers, the blend coefficients, the held-out sigma, the required
  edge (`npm run football:pricing:validate`)
- `football/validation/feature-status-nfl.json` — the feature intake verdicts
- `supabase/functions/edgedesk_ai/_pricing.js` — the kernel (`EDPRICE`)

## Rebuild

```
node tools/football/fetch_nfl_feeds.js            # games, team-week, player-week into the cache
node tools/football/build_lines_archive.js        # the archive
node tools/football/validate_pricing.js           # NFL replay (fetches 2006-2025 team-week once)
node tools/football/validate_pricing.js --sport cfb
node tools/football/build_nfl_slate.js            # the slate with its priced board
node tools/presentation/inline.js                 # after any kernel edit
```

The weekly build runs the first four and stages `football/pricing` and the
two validation files. `--check` on the archive and the validation exits 1
when the committed artifact differs from a fresh build.

## Reading a tier

| tier | what the desk may say |
|---|---|
| VALIDATED | PLAY at or better than the bet-to line, sizing from quarter Kelly capped at 2% |
| LEAN | LEAN_PLAY: "the right side of the number, break-even history, not an edge"; no sizing |
| PROBABILITY | a calibrated cover probability; no bet-to, no play |
| RESEARCH | CONDITIONAL arithmetic on an unvalidated projection; never a recommendation |

The critic fails any answer that says bet, play, bet to, worth betting, EV,
ROI, profit, units or a bankroll fraction when the block did not produce it.

## Switches

`EDGEDESK_PRICING=0` turns the layer off (the r14 answer). With the
validation artifact missing, every market prices as RESEARCH and the panel
shows the validation record as UNKNOWN.

## Grading

`research_packet_pricing` (Supabase view) reads the quoted side, line,
price, book, observation time, status and bet-to from each packet beside
the grades. Export it to JSON and run:

```
node tools/intelligence/clv.js pricing_rows.json
```

CLV is quoted line minus the selection's closing line: positive means the
desk got more points than the close gave. Fifty closed packets are the floor
for any reading, and the reading never says profit.

## When the numbers change

A new validation can move a market between tiers. That is the system
working: the tier and its basis sentence are quoted verbatim by the kernel,
the prompt and the panel, so nothing has to be edited by hand. A feature arm
that reads VALIDATED is a reviewed change to the engine or the blend, never
an edit to the artifact.
