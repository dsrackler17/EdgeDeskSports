# Model-first game research and the matchup graphic

EdgeDesk's own analytical research is the product. Sportsbook odds are context.
This change makes that true on the NFL and college football research flow:

- every game with a valid projection gets a **research snapshot** built from
  EdgeDesk's models alone (Layer A);
- every snapshot gets a **matchup graphic**, drawn deterministically from the
  snapshot's numbers, downloadable and shareable as a PNG;
- a game opens a **research page** (`#game/<nfl|cfb>/<game_id>`) with the
  graphic first and the market last;
- a missing, stale or broken sportsbook quote removes the market comparison
  and nothing else. "NO DECISION · STALE_QUOTE" no longer leads a game.

Plan and audit: [`PLAN.md`](PLAN.md). Date: 2026-10-16.

---

## 1. Two layers, three answers

```
 football/nfl/slate.json ─┐
 football/fbs/slate.json ─┤                                   ┌─► football/game_research/current.json
 cfb_terminal/games.json ─┼─► tools/football/build_game_research.js ─┼─► football/game_research/probabilities.json
 rankings/current.json ───┤      (hourly, cfb-lab job; reads no market)  └─► football/game_research/history/<season>.jsonl
 today/slate.json (records, polls) ┘
                                       LAYER A — the snapshot (lib/edgedesk_game_snapshot.js)

 the reader's page: board.json market state (CFB) / captured signals (NFL) ─► LAYER B — EDGameSnapshot.market()
```

| Layer | What | Source | When it is missing |
|---|---|---|---|
| **A · EdgeDesk model** | projected score, fair spread, fair total, win probabilities, model moneyline, 80% outcome range, the model's own terms, unit rankings, insights, reliability / data check | the committed model runs | the page states a **research limitation** and shows no number |
| **B · Sportsbook market** | spread, total, moneyline, book, capture time | joined by the page at view time | the market section reads one calm sentence; nothing else changes |

`EDGameSnapshot.availability(snapshot, market, decision)` answers separately:

| Answer | Values |
|---|---|
| Research | AVAILABLE · LIMITED · UNAVAILABLE (model and football data only) |
| Model | ACTIVE · DATA FAULT · UNAVAILABLE |
| Market | LIVE · CACHED (last known, not current) · STALE · MANUAL · REFERENCE · FAULT · UNAVAILABLE |
| Betting decision | EVALUATED · NOT EVALUATED (only market blockers) · BLOCKED (a model or game blocker) |

The page prints all four as chips, e.g. `RESEARCH available · MODEL active ·
MARKET unavailable · BETTING DECISION not evaluated`, and under the market
section: *"Live sportsbook prices are currently unavailable. EdgeDesk’s
independent matchup projections remain available."*

### Market states

`EDGameSnapshot.market()` follows `lib/edgedesk_market_state.js`: LIVE inside
180 minutes of capture, CACHED to 72 hours, STALE beyond. A quote the page has
already marked stale is never LIVE. Only LIVE is compared, drawn on the graphic
or handed to the price comparison as market data; CACHED and STALE appear as
"last known number, for context only"; FAULT carries no number at all.

### The decision card

The existing EDGEDESK DECISION card is unchanged (`lib/edgedesk_decision_ui.js`).
On the board's game cards, `fbDecCardHTML` now checks the blocker codes:

- **only market blockers** (`STALE_QUOTE`, `NO_MARKET`, `NO_VALID_QUOTE`,
  `MARKET_SUSPENDED`, `FRESHNESS_UNKNOWN`, and the market-data faults
  `CORRUPTED_ODDS`, `ORIENTATION_FAULT`): a compact note, *Market comparison ·
  betting decision not evaluated*, with the full card, blocker code included,
  under **Lab details**;
- **any model or game blocker** (`DATA_FAULT`, `DISTRIBUTION_MISSING`,
  `IMPOSSIBLE_PROBABILITY`, `MODEL_VERSION_UNKNOWN`, `INVALID_GAME`,
  `EV_SIDE_CONTRADICTION`): the full card, unsoftened;
- an evaluated decision (BET / LEAN / WATCH / PASS): the full card.

Every board card now opens with the model: projected score, fair spread and
total, model win probability, and **Game research & graphic**. The stale-market
safeguards, the decision engine and its tests are untouched.

---

## 2. The snapshot

`lib/edgedesk_game_snapshot.js` (`window.EDGameSnapshot`, Node `require`):
`fromNfl(game, ctx)`, `fromCfb(game, ctx)`, `insights`, `checks`,
`graphicSpec`, `market`, `availability`, `compareMarket`, `comparePrice`,
`beginner`.

| Field | NFL | CFB |
|---|---|---|
| Fair spread, total, win probability | `football/nfl/slate.json` (the engine the browser runs, in Node) | `football/fbs/slate.json` |
| Projected score | `EDCalc.projectedScores`: adds to the fair total and differs by the fair margin exactly (two decimals when parity requires it) | same |
| Model moneyline | the engine's fair ML (checked against the win probability) | derived from the win probability |
| 80% range | the engine's margin PMF (p10–p90) | the terminal's quantiles, **only when the terminal projected the same margin** |
| Model terms | the linear spread model's terms (do not have to sum: post-model adjustments follow) | the engine's additive terms (`why.rows`, reconcile exactly) |
| Unit ranks | the slate's own ranks (32 clubs) | `football/rankings/current.json` (rank 1 = best on every row) |
| Confidence | **Data check** (the NFL publishes no reliability score; none is invented) | **Reliability 0–100**, never printed as a percent |
| Records | the slate's own results (W-L-T) | ESPN's record for games inside `today/slate.json`'s window, with time; otherwise omitted |

**The snapshot id** (`gr1-…`) is a hash of everything the snapshot says.
The same inputs always give the same id; any change (a number, a rank, a
record) gives a new one.

**Mixed runs are refused.** A CFB terminal object whose margin differs from
the slate's is not used: its drivers and range are left out and the snapshot
says why. A probability sheet whose centre differs from its snapshot is
dropped, never served.

### Consistency checks (Phase 8)

`EDGameSnapshot.checks` runs on every snapshot; a failure is a **DATA FAULT**
on the page (status chip, red box) and on the graphic (it replaces the detail
strip):

| Check | Rule |
|---|---|
| scores_reconcile | projected scores add to the fair total and differ by the fair margin, at their own decimals |
| headline_scores_within_tolerance | whole-number scores on the graphic are within ±1 point of the spread and total (each is the exact score rounded once); a near pick'em that would tie is printed to one decimal instead |
| win_probabilities_sum / win_display_sums_100 | the two probabilities sum to 1; the displayed whole percents sum to 100 |
| winner_agrees | the fair line and the win probability name the same favourite |
| model_moneyline_restates_probability | the model moneyline's implied probability is within 1 point of the win probability |
| total_plausible | 20–110 |
| range_contains_projection | the 80% range is ordered and contains the projection |
| ranks_in_range | every rank sits inside its league |
| display_from_raw | `model.display` (football_half_point_v1, `lib/edgedesk_football_lines.js`) is exactly what the shared utility derives from the snapshot's own raw margin and total: the fair line within a quarter point of the raw margin and on its side (or PK), the total within a quarter point, the whole-number projected score never naming the other winner |

**What the page and the graphic print** is `model.display`: the fair spread
and total at the nearest half point, PK at zero, and the projected score in
whole points. The raw fields beside it (`home_margin`, `total_exact`,
`scores`, `win_prob`) are unchanged and are what every comparison, price
check and probability reads. `compareMarket()` measures the gap from the raw
margin, and adds the rounding note and the key-number note. A snapshot written
before the display block existed, such as a started game's frozen snapshot or
a history spec, has no `display` and redraws with its own numbers
(`docs/system-integrity/FOOTBALL_LINES.md`).

### Insights ("What to watch for")

Chosen by `EDGameSnapshot.insights` from the snapshot's own numbers only, one
per family, strongest first, at most four:

- **unit pairings**: one side's run / pass offense against the unit that must
  stop it (pass rush vs pass protection for the NFL; OL vs DL for college),
  when the gap spans at least 20% of the league; **strength on strength** when
  both are in the top tenth;
- **team strength**: college, the projection's own neutral-field term; NFL,
  overall-efficiency ranks; "even on paper" under 1.5 points;
- **home field**: the model's own term, and when it is larger than the
  projected margin, the lean it flips;
- other model terms of a point or more (QB adjustment, rest, matchup);
- roster continuity and special teams when the ranks are 40%+ of the league
  apart;
- quarterback only when there is a real question (no starter named, sources
  disagree, a listed competition). An unannounced college starter who started
  last week is normal and is not an insight;
- weather only from a forecast on file, when material.

When fewer than three survive, a second pass relaxes the unit gap to 10% and
adds whole offense vs whole defense. Nothing is padded: some games show two.
Every insight carries its evidence (ranks or points) and the page prints the
source and time beneath it.

---

## 3. The matchup graphic

`lib/edgedesk_game_graphic.js` (`window.EDGameGraphic`): **content → layout →
draw**, the pattern of `lib/edgedesk_share_card.js`.

- **Deterministic.** No image model and no hand-made template per game: the
  same snapshot gives the same picture. Layout is plain data, so Node tests
  check every number and every text box.
- **Formats.** Square 1080×1080 (primary) and portrait 1080×1350.
- **Sections.** EdgeDesk lockup and *Research not picks*; league and week;
  team monogram badges in team colours with record and poll rank; date, time
  (ET) and venue; **Fair spread** · **Projected score** with a win-probability
  bar · **Fair total** with projected points; then either the **current
  market** (LIVE quotes only: book, capture time, spread, total, moneyline,
  no-vig win %, and EdgeDesk vs market) or **EdgeDesk model detail**
  (neutral-field edge, 80% range, model moneyline, power rank). Where Kalshi
  has a trusted price, **EdgeDesk vs market** replaces either: EdgeDesk's
  unrounded spread, total and win % · moneyline over the book's and Kalshi's,
  and the difference under each (see README §Kalshi market data → The matchup
  graphic);
  **What to watch for**; reliability or data check, model status, snapshot
  time and id.
- **No empty boxes.** A market without a moneyline draws no moneyline column;
  the model detail strip only prints cells that exist.
- **Fonts.** Barlow Condensed (display) and Inter (body) from Google Fonts,
  awaited before drawing; the lockup and every fitted line shrink to fit if a
  fallback face is used.
- **Team identity.** Monogram badges in team colours. NFL colours from a
  table of the clubs' published colours; college abbreviations and colours
  from ESPN's identity in the NCAAM data pack
  (`football/game_research/identity_cfb.json`, all 138 FBS teams matched by
  name). **No team logo or helmet is drawn**: EdgeDesk holds no licence for
  them. A team with no identity on file gets initials and neutral colours.
- **Cache.** `EDGameGraphic.cacheKey` = renderer version + template + snapshot
  id + the market quote shown + format (+ the Kalshi prices shown, when any). A page view reuses a drawn graphic; a
  new snapshot or a new live quote draws a new one automatically. A stale
  quote does not change the key (it is never drawn).
- **History.** `football/game_research/history/<season>.jsonl` stores the
  graphic spec each time what the graphic prints changes (pregame only,
  append-only). Any past graphic can be redrawn exactly.
- **Batch export.** `npm run game:graphics -- [--league cfb] [--format both]
  [--week 7] [--out dir] [--no-kalshi]` renders PNGs through Playwright into
  `.cache/game_graphics/`, named by snapshot id and the Kalshi snapshot shown;
  files already on disk are never redrawn.

### What the reference graphics got wrong, and what the product does instead

| Reference | Problem | Product |
|---|---|---|
| "COLORADO STATE +14.5 · 53% MARKET IMPLIED WIN %" | a spread's implied **cover** probability (with vig) labelled a **win** probability | no probability under a spread; market probabilities only as **no-vig win %** from a moneyline pair |
| "TO WIN 17% / 86%" | implied probabilities with the margin, summing to 103% | the no-vig pair, labelled no-vig, summing to 100% |
| "SPREAD TO WATCH" / "TOTAL TO WATCH · OVER 51.5" beside a fair total of 51.2 | a pick-like call, sometimes on the side the model does not lean | no "to watch" side; the graphic states EdgeDesk's numbers |
| "DATA CONFIDENCE: 83%" | a 0–100 score printed as a probability | "RELIABILITY 88/100 · STRONG"; NFL: "DATA CHECK: COMPLETE" |
| "Texas State #21 in run defense vs Colorado State #135" | the same unit compared across teams, not a matchup | an offense against the defense that has to stop it |
| "Texas State (4-1)", "Colorado State (2-4)" | records that did not match the feed (both were 2-3) | records from the slate's own results or ESPN, with time, else omitted |
| "Notre Dame is the stronger team by 6.4" beside "BYU +3.2" and "+4.1 home field" | three numbers presented without showing how they reconcile | the projection’s own terms, which sum to the margin: 6.44 (strength) + 0.84 (matchup) − 4.08 (home field) = 3.20 |
| "+4.1 points from playing at home" on a neutral-site NFL game | home field applied where there is none | no home-field insight at a neutral site |

---

## 4. The research page

`lib/edgedesk_game_view.js` + `lib/edgedesk_game_view.css`, mounted by the
app at `#game/<nfl|cfb>/<game_id>[?f=portrait]`.

1. **Status**: the four answers, and a fifth chip for Kalshi (why its price
   is, or is not, on the graphic).
2. **Graphic**, then Download PNG · Share (native share with the image where
   the browser allows, else the link) · Copy link · Save (the existing
   watchlist star) · Compare my number · Explore research.
3. **Game overview**: kickoff, projected winner, projected score, fair spread
   and total, win probabilities, model moneyline (labelled), reliability / data
   check with its definition, snapshot time and id. If the live board has
   newer inputs than the snapshot, the page says so and does not blend them.
4. **What to watch for**: the insights in full sentences, with sources.
5. **Deep research**: **Beginner** (a plain answer, what could change it) ·
   **Research** (the projection, the scoring distribution's 80% ranges, fair
   alternate lines at every half point from the same run's probability sheet,
   unit rankings with bars, the model's terms, NFL one-input scenarios, how the
   number has moved) · **Lab** (model and
   input files with times, consistency checks, uncertainty, market
   diagnostics with blocker codes, definitions). The level is shared with the
   decision card (`edgedesk_info_level_v1`). The board's full game card is one
   link away.
6. **Market comparison** (optional): from a LIVE quote only; otherwise the
   calm note and, for context, the last known number labelled as not current.
7. **Compare my number**: below.

Entry points: **Game research & graphic** on every NFL and FBS board card;
Today's Games "View Research", the desk's game links and email links
(`fbOpenGameFromDesk`) open the page, falling back to the board card when a
game has no snapshot. `fbOpenGame` and the module's `openEntity` hook are
unchanged.

---

## 5. Compare my number with a price

The reader picks Spread (team, line, American odds), Total (over/under,
total, odds) or Moneyline (team, odds). `EDGameSnapshot.comparePrice` prices it
with `EDFairLine.priceCheck` (`lib/edgedesk_fairline.js`, the linemaker's
validated pipeline) on **the snapshot's own probability sheet**
(`football/game_research/probabilities.json`, built from the same slates,
dropped if its centre differs):

| Printed | Meaning |
|---|---|
| Price implies | the price's break-even probability, margin included |
| EdgeDesk model cover / win / over probability | from the sheet's distribution at that exact line, with the push |
| Difference | model probability with pushes removed − break-even, in points |
| EdgeDesk fair odds | the model's no-margin price (an estimate, not a sportsbook price) |
| Expected value | **only when that market's probabilities are CALIBRATED** on held-out seasons; otherwise withheld with the reason |
| Held-out check | where the calibration record has one: how often probabilities like this came true at market numbers, and the low end |

Every result is labelled **"User-entered, unverified sportsbook quote"**. The
typed price is never stored, never sent anywhere and never shown as market
data. The verdict words are research words (clears / does not clear the
price's break-even), never "bet". The existing fair-number comparison
(`EDMine.compareOpen`, saved to the journal) stays one tap away.

---

## 6. Operations

| | |
|---|---|
| Build | `npm run game:research` (the hourly `cfb-lab` job runs it after the research terminal and publishes `football/game_research/`; it is the only writer) |
| Integrity | `npm run game:research:check`: ids are content hashes, checks re-run identically, sheets match their snapshots, history is pregame-only. It does **not** rebuild from current inputs: other jobs move those between builds |
| College identity | `npm run game:research:identity` regenerates `identity_cfb.json` |
| Graphics batch | `npm run game:graphics` |
| A game that kicked off | keeps its last pregame snapshot (frozen, marked) for 36 hours, then leaves `current.json`; its graphic spec stays in the history |
| Size | `current.json` ≈ 1 MB (≈ 115 KB gzipped) for ~140 games; `probabilities.json` loads only when a price is compared |

### The landing page's real games

`build()` also writes `football/game_research/landing.json`: up to three
pregame games, exactly as `current.json` carries them, each with its own
sheet from `probabilities.json` and the calibration block for its league.
They are chosen from the games EdgeDesk's editorial desk features in its free
articles (`articles/data/editorial/featured.json`): one per league first, then
by editorial priority. With none, the soonest games with a full data check are
used, and each game says which rule chose it. `--check` holds the file to
`current.json` (same snapshot ids, matched sheets). The landing page's #model
section (`lib/edgedesk_home_model.js`) draws them with this code: the
graphic, the three levels, and Compare my number. No sportsbook price is in
the file. `node tools/football/build_game_research.js --landing` re-derives the
file from the committed snapshots alone.

## 7. Tests

| Suite | What |
|---|---|
| `tools/football/game_research.test.js` (`npm run game:research:test`) | every committed game: projection identities, reconciliation, insights against their evidence, no market field in Layer A; synthetic no-projection, data-fault, mixed-run and near-pick'em games; every market state; the blocker classification against the decision engine's own codes; compare-a-price (calibrated vs provisional EV, bad input, mismatched sheet); graphic content and layout bounds for every game in both formats; cache keys; history append/no-append/frozen; the integrity check and a tamper case; the app wiring, the calm note and the model-first lead run on stubs |
| `tools/football/game_research_ui.e2e.js` (`npm run game:research:e2e`) | Chromium at 390 px and 1280 px: fresh, stale and missing CFB odds; NFL with the odds feed down; a data fault; the three levels; typed spread and moneyline prices; PNG downloads in both formats; copy link and share fallback; no horizontal scroll; the board card's lead and its button; Back |

## 8. Limits, stated

- **Logos and helmets** are not drawn (no licence on file). `EDGameGraphic`
  draws monograms; licensed assets can replace them in `layout` without
  touching the data.
- **CFB records** exist only for games inside the ESPN slate's window.
- **The NFL board computes its projection live in the browser** from the same
  engine; the snapshot is the hourly Node run. When they differ, the page says
  so and keeps the snapshot's numbers together.
- **NFL model terms** do not have to add to the margin (post-model
  adjustments follow); the page says so. College terms reconcile exactly.
- **Fair alternate lines** are one model distribution per game. A better
  line never shows a lower chance, and a CFB ±0.5 pair reads the same
  because college games cannot tie. The CFB ladder once read a different
  table row at every line and dipped by up to a point; see
  `docs/linemaker/DESIGN.md` §2.5. The tests check every served ladder.
- **EV** is shown only where the market's probabilities are calibrated; none
  of EdgeDesk's markets has yet been shown to beat the closing line, and the
  price check says so on every result.
