# H-RADAR-02: design record (draft, not registered)

**Status:** DRAFT. Nothing here is registered or live. H-RADAR-02 is a
methodology change to Prediction Radar. It needs the owner's explicit review,
and its selection rules are frozen in a registration before any prospective
test starts. This file records the decisions and the evidence behind them.

## Why

H-RADAR-01 failed on its holdout (`research/radar/H-RADAR-01/RESULTS.md`).
Its rules also left very few bettors to show. 172 of its 200 pool wallets had
more than 30 pages of activity, so they were excluded. That left 13 qualifying
wallets, and 5 of the 10 best had negative Radar Scores. The best 4 by score
placed 1 bet on a covered game in the 8-week holdout. Smart Money Tonight is
a paid feature: it needs current research every day, without lowering any
qualification standard.

## The owner's decisions (2026-10-29)

1. **Discovery is not skill.** The discovery pool is chosen by recent sports
   activity. Volume alone never qualifies a wallet; only the registered
   performance grade does.
2. **The pool stays at 200 wallets.** The owner's "top 10" is a display limit
   for qualifying wallets, not a reason to shrink discovery.
3. **Recent volume over 90 days, measured accurately.** Candidates come from
   Polymarket's 30-day sports leaderboard. Radar reads each candidate's own
   last 90 days completely. The pool is the 200 eligible wallets with the most
   dollars on covered-league games in those 90 days, each with at least a
   minimum number of pregame bets on covered games.
4. **Complete history before judgment.** No wallet is graded on a partial
   history.
5. **Grades count what a follower really gets:** CLV and follower returns net
   of fees, the execution delay, and the prices actually available.
6. **Featured wallets need a positive score.** At most 10 are shown, and
   fewer when fewer qualify. The page says so.
7. **High-frequency wallets.**
   - The data-processing cap and the followability judgment are separate.
   - 1,000 actions in under 3 days is a screening flag only. It does not
     prove sustained activity over 90 days, and it does not prove a bot.
   - When complete history cannot be read within the processing budget, the
     wallet is labelled **insufficient history — ungraded**.
   - A wallet is labelled **high-frequency — not followable** only when its
     observed trading behaviour supports that. The measure is meaningful
     position changes, not individual fills, wherever the data allows.
   - Discovery continues down the leaderboard after exclusions, so excluded
     wallets do not use up the pool.
   - Every run reports how many wallets were screened, excluded and fully
     evaluated.
   - Excluded wallets never appear in the featured followable group. They
     appear in Observed Activity only where that is accurate and useful.
     Radar spends no great effort reconstructing strategies a subscriber
     cannot follow.
8. **Observed activity and evidence-backed signals stay distinct.** What
   wallets hold is labelled observed activity. Only a passed registered test
   earns the word "evidence".
9. **Access is unchanged.** The full experience stays behind the existing
   subscription (`has_active_sub()`).

## What Polymarket's data supports (verified)

The build environment cannot reach Polymarket, so these questions were asked
from GitHub's runner by `tools/radar/probe_h02.js`, through the Radar gateway:
[run 40975470572](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40975470572)
and [run 40975893030](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40975893030),
2026-10-29 around 23:50 UTC. Every body is in each run's artifact.

### Leaderboard periods

| `timePeriod` | Answer |
|---|---|
| `DAY`, `WEEK`, `MONTH`, `ALL` | HTTP 200, 50 wallets each, four different lists |
| `QUARTER`, `YEAR`, `3M`, `90D` | HTTP 400, refused |

There is no 90-day leaderboard. The board goes at least 1,000 wallets deep
(offset 950 answered 50 wallets). It also answers for one wallet (`user=`),
with that wallet's volume and rank in each period.

### What "volume" means

The board's volume is **shares traded on sports markets**, over a rolling
window. It is not dollars.

| 30-day rank | Board, 30 days | Wallet's own shares, last 30 days | Board, 7 days | Own shares, last 7 days |
|---|---|---|---|---|
| 100 | 7,512,274.69 | 7,512,274.69 | 2,100,700.31 | 2,100,700.31 |
| 200 | 3,614,772.42 | 3,619,775.32 | 1,284,112.91 | 1,289,115.81 |

- Rank 100 matches to the cent. Rank 200 differs in every period by the same
  5,003 shares: one trade made after the board's last refresh.
- A wallet that also trades non-sports markets shows less on the sports
  board than in its own activity (rank 400: 0.26 times). That is consistent:
  the board counts sports only.
- Because the board counts shares, a 5-cent longshot share counts the same
  as a 95-cent favourite. So Radar ranks the pool on its own dollar count
  (decision 3).

### What a 90-day read costs

Activity read newest first, 1,000 actions a page, for 90 days:

| 30-day rank | Pages for 90 days | Note |
|---|---|---|
| 1 | about 2,965 | 3,000 actions in its last 2.4 hours |
| 10 | about 1,057 | |
| 50 | about 245 | no covered-league trade in the 5.5 days read |
| 100 | 1 | |
| 200 | 5 | |
| 300 | about 16 | |
| 400 | about 29 | |
| 500 | 11 | |

The top of the 30-day board is high-frequency wallets. From about rank 100
down, a complete 90 days is a few pages.

### Resuming a newest-first read

[Run 40982170115](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40982170115)
checked this on three wallets near rank 100 of the 30-day board. Evaluation
needs it, because it reads 10 pages a run and has to resume where it stopped.

- **`end` bounds a newest-first read**, inclusive of that second. A read
  ending at page 1's oldest second started exactly there.
- **A `next_cursor` saved and used 20 seconds later carries on** with the
  same `start` and `end`: HTTP 200, 1,000 rows, none newer than page 1's
  oldest.

So a read keeps its window and its cursor between runs.

Two notes from the same run:
- The 30-day board again equalled each wallet's own shares over the rolling
  30 days: 1,683,473.46 at rank 400, for example.
- The `DAY` board was empty for every wallet 51 minutes after midnight UTC,
  so `DAY` is the UTC calendar day. H-RADAR-02 does not use it.

### Fees

On the three covered NBA markets probed (a moneyline, a spread and a total):
- `feesEnabled: true`, `feeType: "zero_fees"`;
- `feeSchedule: {rate: 0, takerOnly: true, exponent: 1}`;
- `makerBaseFee` and `takerBaseFee` are 1000, and the CLOB's `/fee-rate`
  says `base_fee: 1000`.

The schedule's rate is 0, so these markets charge no fee today. Fees are
switched on and the schedule can change. So the fee is read from each
market's own schedule at the time, never assumed.

### The price a follower can pay

| Market | Best bid | Best ask | Midpoint | Gamma outcome price | Price history, last point |
|---|---|---|---|---|---|
| Kings vs. Pelicans (Kings) | 0.31 | 0.32 | 0.315 | 0.315 | 0.315 |
| Pelicans −6.5 | 0.49 | 0.50 | 0.495 | 0.495 | 0.495 |
| O/U 235.5 (Over) | 0.48 | 0.49 | 0.485 | 0.485 | 0.485 |

- **Every price Radar records today is the midpoint.** That covers Gamma's
  outcome price, which the Radar record's follow price uses, and the CLOB
  price history, which the grade's follow and close use.
- A follower buys at the ask, half a cent above the midpoint on these
  1-cent-spread markets, with about 57,000 to 98,000 shares at the best ask.
- The CLOB's `/price` names sides from the book's side: `side=BUY` answered
  the best bid and `side=SELL` the best ask. The order book (`/book`) is
  unambiguous, so the record reads the ask from there.
- No historical ask is available. A historical grade therefore adds a cost
  allowance to the midpoint. Prospective records take the real ask from the
  book when a card is published.

### Screening the 30-day board: pace and style, not performance

[Run 40977654862](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40977654862)
read one newest-first page of the last 90 days (at most 1,000 actions) for
each wallet ranked 1 to 300 on the 30-day board. A **position change** is a
run of fills on one token and one side, each fill within 10 minutes of the
last. So a large order filled in many pieces counts once.

- **Screened:** 300, none failed.
- **Flagged** (1,000 actions in under 3 days): 119, or 40%.
- **Complete in one page** (90 days in at most 1,000 actions): 25.
- **With any covered-league trade:** 219.

| Per wallet (10th / 50th / 90th percentile) | Flagged (119) | Not flagged (181) |
|---|---|---|
| Actions a day | 496 / 1,184 / 9,744 | 21 / 113 / 279 |
| **Position changes a day** | **64 / 341 / 2,449** | **2.4 / 14.7 / 57.7** |
| Fills per position change | 1.5 / 2.9 / 12.5 | 1.9 / 6.4 / 19.9 |
| Markets a day | 21 / 164 / 1,167 | 1.3 / 7.3 / 34 |
| Share of markets bought on both sides | 0 / 0.22 / 0.76 | 0 / 0.02 / 0.28 |
| Covered-league share of actions | 0 / 0.08 / 0.91 | 0 / 0.11 / 1.00 |
| Median fill, dollars | 5 / 21 / 62 | 10 / 49 / 431 |

- **The two groups barely overlap on position changes a day.** The flagged
  10th percentile (64) is above the unflagged 90th (58). Flagged wallets
  also trade many more markets a day, buy both sides far more often, and fill
  in smaller pieces.
- **A flag still needs confirmation.** One page covers only the last few days
  of a flagged wallet, so it cannot show sustained activity over 90 days
  (decision 7).
- **Cost.** An unflagged wallet's 90 days are about 113 actions a day at the
  median, or about 10 pages. Reading the 181 unflagged wallets completely
  costs about 2,000 requests, inside one day's 40,000.

### Proposed rules from this evidence (for the owner's review)

- **Processing cap: 30 pages (30,000 actions) for the 90-day window.** The
  unflagged 90th percentile is 279 actions a day, about 25,000 in 90 days, so
  almost every non-high-frequency wallet fits. A wallet over the cap that the
  followability test does not mark is **insufficient history — ungraded**.
- **Followability test (sustained high frequency).** Sample three
  newest-first pages, ending now, 30 days ago and 60 days ago. If each sample
  shows more than **100 position changes a day**, the wallet is
  **high-frequency — not followable**. That is above every unflagged
  wallet's 90th percentile (58) and well under the flagged median (341).
  Otherwise it is read and judged like any other wallet.
- **Discovery walks down the 30-day board** until 200 wallets are eligible,
  and reports how many were screened, marked, ungraded and evaluated.

## Approved by the owner (2026-10-30), to be frozen in the registration

- **High-frequency screen.**
  - A wallet is **high-frequency — not followable** only when each of three
    samples is known and shows more than 100 position changes a day.
  - Each sample is the same fixed span: the 24 hours ending now, 30 days ago
    and 60 days ago.
  - A sample that could not be read is **unknown**, never low activity. So a
    wallet with an unknown sample is never labelled high-frequency.
  - A wallet whose 90 days fit within the processing cap is read
    completely, so its three spans are counted from its own history and none
    is unknown.
  - Passing the screen does not qualify a wallet. It must still pass every
    performance and follower-execution check.
- **Processing cap: 30 pages (30,000 actions) for the 90 days.** A wallet over
  the cap that is not marked high-frequency is **insufficient history —
  ungraded**. Discovery continues past every exclusion, and each run reports
  how many wallets were screened, excluded and fully evaluated.
- **Historical follower price: the midpoint plus 1 cent.** Polymarket keeps
  only midpoint history. That is a full tick, twice the half-cent seen on
  liquid NBA markets. Live cards record the real best ask from the order
  book.
- **The prospective test runs 12 weeks, with a fixed end date.**
  - It measures the featured wallets' Smart Money cards (at most 10 wallets),
    followed at the live best ask when published, net of fees.
  - They must beat the close more than 50% of the time and show positive
    ROI, both on game-clustered 95% intervals, as in H-RADAR-01.
  - Fewer than 200 graded cards by the end date means it cannot pass, and
    the report says so.
- **Fees: confirmed from Polymarket's documentation** (docs.polymarket.com,
  `trading/fees` and `market-data/market-details`, read 2026-10-30).
  - The taker fee in USDC is shares × `feeSchedule.rate` × (p × (1 − p))
    raised to `feeSchedule.exponent`, at the trade price p.
  - Makers never pay; a follower buying is a taker.
  - Each market's own `feesEnabled` and `feeSchedule` decide.
  - Polymarket lists 0.05 as the Sports category rate. Every covered NBA
    market probed had fees enabled at rate 0 (`zero_fees`).
  - Radar applies each market's schedule (`R.takerFee`, `radar_taker_fee`).
    Both reproduce Polymarket's published fee tables: 100 shares at 50¢ in
    Sports pay $1.25.
  - A market whose fee schedule cannot be read is never guessed: its follow,
    or its card, is not graded.

## Open, for the registration

- The minimum number of covered pregame bets in 90 days (decision 3).
- The processing cap and the followability test: proposed above, from the
  screening evidence (decision 7). They need the owner's review.
- The registration file itself, with the frozen rules, the forking-paths
  disclosure (this record and the probe runs are data seen before
  registration) and the test's start and end dates.
