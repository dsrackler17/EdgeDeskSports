# H-RADAR-01: results

> H-RADAR-01 FAILED on its registered holdout: 41 followed bets over 37 games; beat-close rate 24.4% (95% CI 10.3% to 39.0%); follow ROI -1.7% (95% CI -33.4% to 30.5%).

That is the report's own headline, verbatim. The report is
[`report.json`](report.json), committed exactly as the run printed it:
sha256 `8f9d8a4f29c34331bc2471ff87503921337ae3bb72aa2dd304189fad1bb10ab1`,
the hash printed beside it in the run's log. The protocol is
[`../registration_h_radar_01.json`](../registration_h_radar_01.json) (sha256
`56ca979a…cc5a`). It was committed before any Polymarket data was read, and
the report names it.

## The run: the one look

| | |
|---|---|
| Run | [40823328433](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40823328433), attempt 1, `.github/workflows/radar-validation.yml` |
| Commit | `be0ae0df6` (the pull request's merge of `ad9993238` into `main`) |
| Time | 2026-10-29 05:26:25 to 05:43:26 UTC |
| Requests | 7,955 through the Radar gateway: 7,950 answered 200, 5 answered 400 (not retried), no 429, breaker never opened |
| Kept | 7,950 bodies, gzipped, with their manifest: the run's artifact `radar-h-radar-01-40823328433-1` (ID 12875914088, 444 MB, kept 90 days). The manifest's sha256 is `inputs_sha256` in the report. |

`research/radar/one_look.js` read the workflow's earlier runs before this one
fetched anything, and found none. The next run, on `99fe069d2`
([40823731598](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40823731598)),
was stopped by the same guard: it named this run and fetched nothing.

## The criteria (all three required)

| Criterion | Rule | Found | Met |
|---|---|---|---|
| C1_SAMPLE | at least 200 followed bets | 41 | no |
| C2_BEAT_CLOSE | the 95% interval's lower end of the beat-close rate above 50% | 10.3% (rate 24.4%) | no |
| C3_FOLLOW_ROI | the 95% interval's lower end of the mean follow ROI above zero | −33.4% (mean −1.7%) | no |

**passed: false.** The point estimates do not support the hypothesis either.
The beat-close rate (24.4%) is below 50%, and the follow ROI (−1.7%) is below
zero. The intervals come from a bootstrap that resamples whole games: 2,000
resamples, seed 20261029, 37 games.

## How the sample came to be 41 bets

- **The pool** was the sports leaderboard's top 200 by volume, all time, as it
  stood on 2026-10-29. Every wallet's activity was read.
- **172 of the 200 were truncated.** Each had more than 30 pages of 1,000
  activity rows between 2025-09-01 and 2026-10-26. The registration excludes
  a truncated wallet from selection; it names this exclusion as a known
  limitation ("removes some of the busiest traders"). The live probe had
  shown it coming: one top wallet's 1,000 rows covered under three days.
- **Styles of all 200** (from every covered training trade): 123 Directional,
  71 Hedger, 6 Market Maker.
- **13 candidates.** These were Directional, with a complete history and at
  least 50 resolved training bets. All 13 were ranked and selected, fewer
  than the 25 the registration allows.
- **42 holdout bets, from only 3 of the 13:** 22, 19 and 1. The other ten made
  no pregame bet on a covered game that started between 2026-09-01 and
  2026-10-26.
- **41 followed.** One was entered less than 5 minutes before its start, so it
  had no follow price. Every other bet had a follow price and a close.

## Secondary (reported, never tested)

| | n | Beat-close rate | Follow ROI |
|---|---|---|---|
| Follow 15 minutes after entry | 32 | 25.0% | +7.9% |
| Follow price raised by 1 cent | 41 | 7.3% | −3.5% |
| All ranked directional wallets (the same 13) | 41 | 24.4% | −1.7% |

The selected wallets' own holdout bets, at their own entry prices: ROI +1.9%,
CLV% −0.34%.

## What it means

- The test does not support H-RADAR-01. It also cannot rule it out: 41 bets
  over 37 games leaves the follow ROI anywhere from −33% to +31%.
- **Prediction Radar stays Experimental.** Its record section
  (`radar_record()`, part 3) quotes this result. `supabase/radar_registry.sql`
  writes it into the research registry as `h_radar_01_result`, with
  `passed = false`.
- **A second look needs a new registered version** that counts this one. The
  runner fetches nothing while this report is committed.

## Notes (observations, none of which changes the result)

- **Ties.** As registered, a bet beats the close only when the close is
  strictly above the follow price. A close equal to the follow price counts
  as not beating it, and the report does not count ties separately.
- **The five HTTP 400s.** The gateway does not retry a 400, and the report
  counts these five without naming their requests. No holdout bet lost its
  follow price or close to them: the holdout's exclusions list only the one
  bet above. They may have touched a training grade or a market lookup.
- **Markets.** 30,106 markets had a covered league's slug. Gamma answered
  30,083 of them when asked with `closed=true`. The other 23 were not closed
  at run time or are unknown to Gamma, and their trades were not graded.
- **Clusters.** A cluster is the Polymarket event, as registered. Polymarket
  files some spreads and totals under a separate "more markets" event, so
  one game can be two clusters.

## Check it

```
node research/radar/run_validation.js --check
node tools/radar/build_registry_sql.js --check
```

The first confirms the report was run against the registered protocol and
that `passed` is the three criteria together. The second confirms the
registry SQL carries this report.
