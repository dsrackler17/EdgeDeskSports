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
                                        │                            Supabase player_prop_ledger_quotes (ledger)
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
                        football/props/correlation.js ──► correlation.json (same-game co-movement, §13)
                        football/props/verify_ledger.js   the ledgers only grew (before every publish)
                                        ▼
                        app.html #v-pprops  ◄── lib/edgedesk_props_ui.js + lib/edgedesk_props.css
                          · NFL and FBS game cards ("Player prop research")  · Lab → Player props validation
                          · record.html (the public props record)  · edgedesk_ai (the desk, §12)
```

The page **re-evaluates every prop in the browser** with the same
`EDProps.evaluate` the build used, so freshness is judged at view time, the
reader's unit is applied live, and any alternate line is priced from the
stored distribution. The mapping from a board row to that evaluation is one
function, `EDProps.boardInput` / `boardEval`, which the page and the AI desk
both call, so neither can drift from the other.

Routes: `#playerprops/<league>` (the board), `#playerprops/<league>/<prop>`
(one prop's drawer), `#playerprops/<league>/game/<game_id>` (one game) and
`#playerprops/<league>/player/<player_id>` (a player: role, usage, status,
environment and recent games above his props). `404.html` sends
`/players/<league>/<player_id>` to the last. `EDPropsUI.go({league, game,
player, prop})` opens any of them from elsewhere in the app.

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
structured facts) · VALIDATION STAGE (the market's stage and every gate, §8) ·
SAME-GAME CORRELATION (the props this one moves with, and the chance both win
beside independence, §13) · CLV once closed.

The same board feeds a **"Player prop research" section on every NFL and FBS
game card**: the priced leads with the page's own decision and EV, the headline
projections (median and middle half), and a link to that game on the Props
page. The section reads nothing until it is opened, and the card and the page
share one board fetch.

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
- **Validation stages, per market** (`EDProps.stageOf` / `stageTable`). A
  market's stage is derived from evidence, never assigned:

  | Stage | Every gate must pass |
  |---|---|
  | EXPERIMENTAL | the default: it informs, it never stakes (capped at LEAN, code `STAGE_EXPERIMENTAL`) |
  | TRACKING | on the backtest's out-of-sample half: walk-forward (V001), as-of data only (V002), beats the naive last-8 baseline on log score (V003), PIT mean within 0.03 of ½ and variance within 15 % of 1/12 (V009), 50 % coverage in 0.45–0.55 (V022), mean bias within 5 % (V007), ECE ≤ 0.03 (V008), n ≥ 300 |
  | RESEARCH GRADE | TRACKING, plus live: ≥ 200 settled finals, live ECE ≤ 0.03, Brier within 0.005 of the no-vig market (V004), probability CLV ≥ 0 (V013) |
  | PRODUCTION | RESEARCH GRADE, plus ≥ 500 finals, ECE ≤ 0.02, positive CLV on ≥ 100 closes (V015) |

  Tail markets (longest play, first TD) stay EXPERIMENTAL until their own live
  calibration is proven. College has no backtest of its own, so every college
  market is EXPERIMENTAL. The backtest writes the naive baseline beside the
  model (`out_of_sample.after[m].baseline`); `grade.js` writes the live
  per-market evidence to `performance.json` → `markets`. The build stamps the
  stage table on the board and on every frozen ledger row. The Lab tool
  **Player props validation** shows every market's gates from the same
  function. An EXPERIMENTAL market's price trigger reads "clears the BET
  thresholds at …; stays capped at LEAN", because it cannot become a BET.
- **The public record** (`record.html#player-props`) copies each league's
  `performance.json` (bets, units, ROI, EV at entry, CLV, flat-1U leans,
  calibration, by market). A missing file is the empty state.

## 9. Storage (`supabase/player_props.sql`, `supabase/player_props_watchlist.sql`)

| Table | Purpose | Identity / rule |
|---|---|---|
| `player_prop_ledger_quotes` | every captured price, append-only | unique (sport, game_id, player_id, market, line, side, book, quoted_at); write-once |
| `player_prop_projections` | projection + distribution per build | unique (sport, game_id, player_id, market, model_version, built_at); write-once |
| `player_prop_evaluations` | probability, no-vig, EV, decision, units per evaluated selection | unique `evaluation_id` (content hash); write-once; refused after kickoff |
| `player_prop_results` | settlement, closing line/price, CLV | one row per evaluation; service role only |
| `player_prop_watchlist` | a reader's starred players / props / games | RLS: owner only |
| views `player_prop_ledger_quotes_latest`, `player_prop_line_movement` | current price per identity; open / current / close | security invoker |

The committed JSON feeds are the browser's source; Supabase is the durable
ledger when `SB_URL` / `SB_SERVICE_ROLE` are configured.

**The ledgers only grow.** Before the hourly job commits anything,
`football/props/verify_ledger.js --league all --base HEAD` proves each
`evaluations.jsonl`, `results.jsonl` and `closes.jsonl` is the committed file
plus new lines, never an edit. It also checks that every line parses, that
every `evaluation_id` recomputes from its own fields and is unique, that every
evaluation predates its kickoff, and that every result grades an evaluation on
file, once, at or after its kickoff. Any problem exits 1, and nothing
publishes.

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
`docs/runbooks/player-props.md`. Later: `football/props/verify_ledger.js`
(§9), `football/props/desk.js` and `tools/props/props_desk.test.js` (§12),
`football/props/correlation.js` and `football/props/nfl/correlation.json`
(§13).

Modified: `app.html` (nav seat, `#v-pprops`, `show()` hook, boot deep link,
landing-page option, includes), `tools/app/navigation.test.js` (seven seats),
`package.json` (scripts), `supabase/README.md`, `.gitignore`, `README.md`,
`lib/edgedesk_decision.css` (the unclosed comment and merge marker). Later:
`supabase/functions/edgedesk_ai/index.ts` (EDProps, EDPROPSDESK, `propsTurn`),
`tools/presentation/inline.js`, `404.html` (`/players/…`), `record.html`
(the props record), and `app.html` (the game-card sections and the Lab tool).

## 12. The AI Research Desk on player props

`football/props/desk.js` (EDPROPSDESK, inlined into
`supabase/functions/edgedesk_ai/index.ts` beside EDProps by
`tools/presentation/inline.js`) answers player-prop questions
deterministically from the committed boards. `propsTurn` runs after the
support boundary and before the desk, for desk and chat clients alike.

| Intent | Example |
|---|---|
| PROP | "Should I bet Bijan Robinson over 84.5 rushing yards?" · "Research Penix passing yards under 224.5 -108" |
| PLAYER | "What does EdgeDesk project for Drake London?" |
| COMPARE | "Is Bijan 71.5 -110 or 74.5 +105 better?" |
| BOARD | "Best player props today?" |
| INJURY | "How does Drake London being out affect Bijan Robinson's rushing yards?" |

Every number is one the board holds, or one `EDProps.boardEval` computed from
it, so the desk says what the page says. The desk:

- never prices a line without a price: no captured book at that line and no
  price in the question means no price, never −110;
- never reuses a stale captured price;
- asks back on a name that fits two players, and never matches an everyday
  word or a place as a first name;
- says when EdgeDesk does not project a market;
- reads the why and the risks only against a real book line, never the page's
  placeholder line.

A rephrasing runs only with `EDGEDESK_PROPS_NARRATE=1`, and only through
`EDPROPSDESK.critic`: no number outside the answer, no "lock" or "best bet",
no certainty. A plain injury question ("Is London out?") reads no board and
stays on the personnel turn.

## 13. Same-game correlation and exposure caps

Props in one game are not independent. `football/props/correlation.js` measures
how they move together from the nflverse game logs:

1. For each player-season with a real role, every market's statistic becomes
   normal scores within that player-season, which is a Gaussian copula, so no
   prop's own distribution changes.
2. Those scores are pooled into Pearson correlations for one player's two
   markets, two teammates, and two opponents.
3. Each estimate is shrunk by n/(n+100). A pair is kept only with n ≥ 150 and
   |ρ| ≥ 0.03.

2024–2025 covers 544 games and 7,297 player-games. For example, QB passing
yards with WR receiving yards is +0.30, and QB passing yards with passing TDs
is +0.43. College borrows the NFL model. The board carries the model as
`board.correlation`, and a pair it does not list counts as independent.

- `EDProps.jointSim` runs a seeded Gaussian-copula Monte Carlo over several
  props in one game. Each leg keeps its own probability. An inconsistent
  pairwise matrix is shrunk until it factors, and the result says by how much.
  The drawer shows each strongly correlated pair's joint probability beside
  independence.
- `EDProps.exposure` caps the stakes across a set of BETs:
  - one player carries at most 1U across his props;
  - one game's correlated stake √(uᵀRu) stays at or under 2U, where R is
    signed by side, so an Over and a correlated Under hedge each other;
  - the lower value score gives way, rounded down to the sizing grid, and a
    BET cut to zero becomes a LEAN (`PLAYER_EXPOSURE` /
    `CORRELATED_EXPOSURE`).

  The build applies the caps before it freezes the record, and the ledger row
  carries `exposure_cap`. The page applies the same caps after it re-prices,
  and the desk applies them to the units it quotes.

## 14. The data factory — a validated second opinion

`football/props/factory/` ([`FACTORY.md`](FACTORY.md)) adds what §10 and the
audit list as missing on the modelling side: committed per-game history for
both leagues (NFL 2011+, college 2014+), a CFB→NFL identity bridge, a
point-in-time feature store with leakage tests, and learned per-position
models validated walk-forward out of sample — college included, which §8
leaves EXPERIMENTAL for want of a backtest.

Every few hours `props-factory.yml` writes
`football/props/factory/<league>/projections.json`: each upcoming prop's
distribution, keyed by this board's own game, player and market ids. The
board build joins it as the row's `fx` and stamps `board.factory` (models,
walk-forward tier and evidence, freshness; older than 36 h is not shown). The
kernel prices it as family `stored` (`EDProps.factoryView`), the drawer's
**Validated model** section shows it beside the engine at the same line and
price, and the desk states it in one sentence.

It is evidence, not the engine: it never sets a price, it does not change a
decision, units or a market's stage, and a disagreement is shown, not
resolved. Evidence that the factory's model is calibrated is not evidence
that the engine is; if the factory should one day drive the probability, that
is a change to §4 and §8, made on this ledger's own grading.

