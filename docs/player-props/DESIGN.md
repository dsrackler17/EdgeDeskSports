# Player Props — the research terminal

> Research, not picks. **What the market is offering, what EdgeDesk thinks it
> is worth, why, and where the best price exists** — for every player prop a
> book has posted, in one workflow:
> sport → game → market → player → every line at every book → best price →
> fair probability → EV → research context → BET / LEAN / WATCH / PASS / NO DECISION.

The audit that preceded this is [`AUDIT.md`](AUDIT.md). The operating guide is
[`../runbooks/player-props.md`](../runbooks/player-props.md).

## 1. Principles

1. **A price is either captured or absent.** Every quote carries the book, the
   provider's own update time and EdgeDesk's capture time. Nothing is
   interpolated, averaged into existence, or assumed to be −110.
2. **History is context, never probability.** Hit rates (L5, L10, season,
   home/away, vs similar defences) are printed beside the model probability
   under their own heading and never enter it.
3. **A mean is not enough.** Every market has its own outcome distribution;
   P(over), P(under) and P(push) come from that distribution at the exact line,
   and the drawer prints the family, its parameters and the arithmetic.
4. **Raw model and market-informed model are both shown.** The decision uses a
   declared blend (default 30 % market) whose weight is printed on every prop.
   Market information can never silently dominate.
5. **Positive EV is not a bet.** The class is capped by confidence, sample,
   role, injury, freshness, market depth and probability-source maturity.
6. **Units are conservative and earned.** Until graded props prove the
   probabilities calibrated, every prop is MODEL-ESTIMATED and capped at
   0.25U, the decision engine's own rule for an unvalidated source.
7. **Sport-agnostic core.** Markets, distributions, positions and usage
   columns live in one registry per sport; NFL and CFB are the first two
   entries. Adding a sport is a registry entry, a stats source and a capture
   key — not a rewrite.

## 2. Architecture

```
nflverse (stats_player_week, snap_counts, pbp, depth_charts,       sportsdataverse ESPN player box (CFB)
          roster_weekly, games.csv, injuries)                       football/fbs/slate.json, rosters
            │                                                                   │
            └──────────────► football/props/sources/*  (fetch + cache, keyless) ◄┘
                                        │  player game logs, team logs, defence-allowed logs
                                        ▼
The Odds API /events/{id}/odds ──► football/props/capture.js ──► quotes.json (current listing)
  (per-event, budgeted, opt-in)        identity + dedupe + bounds    lines.json  (open → current, movement)
                                        │                            Supabase player_prop_quotes (ledger)
                                        ▼
                        football/props/model.js   projection engine (volume × share × efficiency
                                        │          × matchup × script × weather × injuries × QB)
                                        ▼
                        lib/edgedesk_props.js     distributions → P(over/under/push) → fair odds
                           (browser + Node)        → no-vig → EV at every book and line → best EV
                                        │          → decision, confidence, units, value score,
                                        │          → hit rates, explanations, settlement, CLV
                                        ▼
                        football/props/build_board.js ──► football/props/<lg>/board.json   (browser)
                                        │                 football/props/<lg>/players.json (drawer)
                                        │                 football/props/<lg>/<season>/evaluations.jsonl
                                        ▼
                        football/props/grade.js ──► results.jsonl → performance.json (record, CLV, calibration)
                        football/props/backtest.js ──► calibration.json (walk-forward distribution calibration)
                                        ▼
                        app.html #v-pprops  ◄── lib/edgedesk_props_ui.js + lib/edgedesk_props.css
```

The page **re-evaluates every prop in the browser** with the same
`EDProps.evaluate` the build used, so freshness is judged at view time, the
reader's unit is applied live, and any alternate line is priced from the
stored distribution.

## 3. The market registry (`EDProps.MARKETS`)

| Category | Markets (key → provider key) | Stat | Distribution |
|---|---|---|---|
| Passing | `pass_yds` `pass_att` `pass_cmp` `pass_tds` `pass_ints` `pass_long` | nflverse `passing_yards` … | Normal · NegBin · NegBin · Poisson · Poisson · max-of-compound |
| Rushing | `rush_yds` `rush_att` `rush_tds` `rush_long` | `rushing_yards` … | gamma compound · NegBin · Poisson · max-of-compound |
| Receiving | `rec_yds` `receptions` `targets` `rec_tds` `rec_long` | `receiving_yards` … | gamma compound · NegBin · NegBin · Poisson · max-of-compound |
| Combined | `rush_rec_yds` `pass_rush_yds` `fantasy_pts` | sums | convolution · Normal · Normal |
| Touchdowns | `anytime_td` `first_td` `tds_2plus` | rush + rec (+ return) TDs | Poisson thinning |
| Other | `fg_made` `kicking_pts` `tackles_ast` `solo_tackles` `sacks` `def_ints` | kicking / defence | Poisson · Normal · NegBin · NegBin · Poisson · Poisson |

Each entry carries the provider keys (main and `_alternate`), the stat
function used for settlement, the positions it applies to, the usage columns
the drawer shows for it, and whether a push is possible (whole-number lines).
Tabs appear only for markets that carry data.

### Distributions (all in `lib/edgedesk_props.js`, auditable)

- **Normal** with a continuity correction on the integer outcome grid.
- **Poisson** and **Negative binomial** (mean, size) with exact PMFs.
- **Gamma compound** — yards = Σ over N events of per-event yards, N ~
  NegBin, per-event yards ~ Gamma (shifted for rushing so a carry can lose
  yards). Because a sum of *n* Gamma(a, θ) is Gamma(n·a, θ), P(Y > L) is an
  exact finite mixture — no simulation noise.
- **Max of compound** — longest reception / rush / completion: P(max ≤ x) =
  PGF_N(F(x)), closed form for Poisson and NegBin counts.
- **Convolution** — rush + receiving yards on a 1-yard grid (independent given
  projected volume; stated).
- **Poisson thinning** — anytime TD = 1 − e^−λ; 2+ = 1 − e^−λ(1+λ); first TD =
  λ/Λ·(1 − e^−Λ) with Λ the game's expected touchdowns.
- **Empirical** — the player's own smoothed history, printed as a *check*
  beside the model, never used for the decision.

Dispersion multipliers per market come from the walk-forward backtest
(`football/props/<lg>/calibration.json`, §8) so a distribution's width is
measured, not assumed.

## 4. The projection engine (`football/props/model.js`)

Volume × share × efficiency, each step recorded for the drawer:

1. **Team volume** — offensive plays per game (recency-weighted, half-life 4
   games, shrunk to last season and the league), opponent pace, and the game
   script from the spread: pass rate = team neutral pass rate (pbp `xpass` +
   PROE) − 0.6 pp per point of expected margin.
2. **Game environment** — team implied points from the consensus spread and
   total (nflverse / captured market), falling back to EdgeDesk's own fair
   margin and total, labelled. Wind ≥ 15 mph and heavy precipitation cut pass
   rate and yards per attempt; a dome removes weather.
3. **Player share** — carry share, target share, dropback share, snap share:
   recency-weighted, shrunk toward the player's prior season on the same team
   or a depth-chart prior, with the last-three-game trend reported apart.
4. **Efficiency** — yards per carry, catch rate, yards per reception, aDOT,
   completion %, yards per attempt, TD and INT rates, each shrunk toward the
   position mean by sample size.
5. **Matchup** — opponent yards per carry, yards per attempt, yards allowed to
   the position, rush EPA allowed, explosive rate, pressure proxy; each a
   ratio to league, shrunk by the opponent's sample, clamped to ±15 %.
6. **Availability** — the player's status (OUT → NO DECISION; DOUBTFUL and
   QUESTIONABLE add uncertainty and cap the class), teammates OUT or DOUBTFUL
   redistribute their share to the same position group (a *projected
   adjustment*, printed with its size), a starting-QB change moves passing
   efficiency and flags every receiver.
7. **Raw vs market-informed** — the raw projection is the engine's alone. The
   market-implied mean is the mean at which the model's own distribution
   reproduces the consensus no-vig probability at the main line. The
   market-informed mean = (1 − w)·raw + w·market, w = 0.30 by default; the
   decision reads it, the raw model is printed beside it.

Parameter uncertainty widens the distribution for thin samples
(`dispersion × (1 + c / n_eff)`), so an uncertain projection moves P toward 50 %.

## 5. Price shopping and EV

For every prop, every book, every line (main and alternate), both sides:

```
implied   = 1 / decimal                         (research_core.impliedProb)
p_win, p_push, p_loss from the distribution at that exact line
EV        = p_win·(decimal − 1) − p_loss        (research_core.expectedRoi; push returns the stake)
break-even (no-push basis) = 1 / decimal
edge vs break-even = p_win / (1 − p_push) − break-even   (the decision's edge; sign = EV's sign)
edge vs no-vig     = p_model − p_no-vig                  (how far EdgeDesk sits from the market)
fair American      = the price at which EV = 0            (push-aware)
```

**Best value is the best EV over every (book, line, price) combination — not
the lowest line and not the best price at one line.** A worse line at a much
better price wins when its EV is higher. The board also names the best raw
price at the consensus line so the reader sees both.

No-vig: proportional (EdgeDesk's default) per two-sided book; the consensus
no-vig is the median across books at the modal line. Power and Shin are
available (`EDEV.devig`) and printed in the drawer. A one-sided quote is priced
but carries no no-vig and caps the class at LEAN.

## 6. Decision, confidence, units, value score

`EDProps.decide(evaluation)` — Layer A (can we evaluate?) then Layer B
(should we bet?), the football engine's shape:

- **NO DECISION** with a blocker code: `GAME_STARTED`, `GAME_CANCELLED`,
  `PLAYER_UNMAPPED`, `PLAYER_OUT`, `NO_PROJECTION`, `NO_MARKET`,
  `STALE_QUOTE` (every quote older than 90 min), `UNSUPPORTED_MARKET`,
  `INVALID_DISTRIBUTION`.
- **BET** edge ≥ 4.0 pp and EV ≥ 5 % (read from `EDDecision.config()`);
  **LEAN** edge ≥ 2.0 pp and EV > 0 with the model on that side of the line;
  **WATCH** a BET-quality price held back by a cap, or within one step of a
  BET (0.5 unit of line or 15 cents); **PASS** otherwise.
- Caps: questionable/doubtful player or unresolved QB → WATCH; decision
  confidence < 40, sample < 3 games, one-sided or single-book market, role
  instability → LEAN; an extreme EV (≥ 15 %) not corroborated by a second book
  → WATCH · PRICE ANOMALY.
- **Decision confidence** 0–100 from recorded components (sample depth, role
  stability, data completeness, market depth, price freshness, injury
  certainty, model–market agreement, model–history agreement, calibration
  maturity), each printed. It is not a win probability.
- **Units**: 0.25 / 0.50 / 0.75 / 1.00 on the engine's ladder, then the minimum
  of every cap — probability source (model-estimated 0.25U, partially
  calibrated 0.50U, calibrated 1.00U), quarter-Kelly at the exact price, single
  book 0.50U — always rounded down. Dollars come from the reader's own unit
  (`EDBankroll`), never assumed.
- **Value score** (the BEST VALUE board) ranks research quality, not EV: the
  class first, then EV × confidence, discounted for thin markets, stale
  prices, small samples, injury and role uncertainty.

## 7. Research context (the drawer)

PRICE (every book, alternates ladder with fair/implied/EV per rung, opening →
current movement, stale warnings) · PROJECTION (raw, market-informed, median,
P25, P75, the step-by-step build) · PROBABILITY (over/under/push, fair odds,
distribution family and parameters, empirical check) · EV (EV %, both edges,
break-even, $ at the reader's unit) · HISTORY (L5, L10, season, home/away, vs
similar defences, game log) · USAGE (only the columns that matter to the
market) · MATCHUP (opponent ranks with values, never fake decimals) · GAME
CONTEXT (spread, total, implied points, script, weather, venue) · ROLE (snap
share, shares, depth, trend, teammate absences — observed vs projected) ·
UNCERTAINTY · WHY OVER / WHY UNDER and RISKS (deterministic sentences from the
structured facts) · CLV once closed.

## 8. Validation, grading and calibration

- **Walk-forward backtest** (`football/props/backtest.js`): for every week of
  a completed season, project every player with data strictly before that
  week and score the realised stat — PIT histogram, P25–P75 coverage, MAE, log
  score, and calibration of P(over) at the projection's own half-point line.
  It fits the per-market dispersion multipliers the live model reads. Mode:
  BACKTEST (no prices) — it proves the distributions, not the edge.
- **Live grading** (`football/props/grade.js`): each frozen pregame evaluation
  is settled from the official box score — WIN / LOSS / PUSH (whole lines) /
  VOID (did not play, cancelled game, market void). Overtime counts.
  Closing line and price come from the last pregame capture; line CLV, price
  CLV and no-vig probability CLV are computed only when a close exists.
- **Performance** (`performance.json`): bets, W-L-P, units, ROI, CLV, average
  EV, by sport, market, position, EV bucket and confidence bucket, every figure
  with its `n` and sample state (`EDValidation.sampleState`).
- **Calibration**: predicted-probability buckets 50–55, 55–60, 60–65, 65–70,
  70+ against the observed hit rate, with Brier and ECE. The probability source
  is promoted from MODEL-ESTIMATED to PARTIALLY CALIBRATED only when ≥ 500
  settled props show ECE ≤ 0.03 — automatically, from the ledger, never by hand.

## 9. Storage (`supabase/player_props.sql`, `supabase/player_props_watchlist.sql`)

| Table | Purpose | Identity / rule |
|---|---|---|
| `player_prop_quotes` | every captured price, append-only | unique (sport, game_id, player_id, market, line, side, book, quoted_at); write-once |
| `player_prop_projections` | projection + distribution per build | unique (sport, game_id, player_id, market, model_version, built_at); write-once |
| `player_prop_evaluations` | probability, no-vig, EV, decision, units per evaluated selection | unique `evaluation_id` (content hash); write-once; refused after kickoff |
| `player_prop_results` | settlement, closing line/price, CLV | one row per evaluation; service role only |
| `player_prop_watchlist` | a reader's starred players / props / games | RLS: owner only |
| views `player_prop_quotes_latest`, `player_prop_line_movement` | current price per identity; open / current / close | security invoker |

The committed JSON feeds are the browser's source; Supabase is the durable
ledger when `SB_URL` / `SB_SERVICE_ROLE` are configured.

## 10. Missing external dependencies (exact fields to activate)

| Needed for | Provider field | Today |
|---|---|---|
| Prop prices (everything priced) | The Odds API per-event odds: `bookmakers[].markets[key=player_*].outcomes[{name, description, price, point}]`, `last_update` | runner built; needs `ODDS_API_KEY` secret + repository variable `PROPS_CAPTURE=on` |
| Routes, route participation, YPRR | per player-game `routes_run` (PFF, FTN, NGS or nflverse `pbp_participation` when published) | column shows "not in feed"; snap share is used and labelled as such |
| CFB injuries / depth | an official availability feed per team-game | "no official report" printed; confidence lowered |
| CFB targets and snaps | per player-game `targets`, `offense_snaps` (CFBD `games/players` usage, PFF) | receptions share and touches used, labelled |
| Coverage tendencies | man/zone rates per defence (FTN charting, PFF) | not shown |

## 11. Files

New: `lib/edgedesk_props.js`, `lib/edgedesk_props_ui.js`,
`lib/edgedesk_props.css`, `football/props/*` (config, sources, capture, model,
build_board, backtest, grade, sync_supabase, tests, fixtures),
`supabase/player_props.sql`, `supabase/player_props_watchlist.sql`,
`.github/workflows/player-props.yml`, `.github/workflows/player-props-tests.yml`,
`tools/props/*` (UI, e2e, SQL tests), `docs/player-props/*`,
`docs/runbooks/player-props.md`.

Modified: `app.html` (nav seat, `#v-pprops`, `show()` hook, boot deep link,
landing-page option, includes), `tools/app/navigation.test.js` (seven seats),
`package.json` (scripts), `supabase/README.md`, `.gitignore`, `README.md`,
`lib/edgedesk_decision.css` (the unclosed comment and merge marker).
