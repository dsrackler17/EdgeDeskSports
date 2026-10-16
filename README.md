# EdgeDesk

A personal, single-file sports-betting **research** tool. Pulls live odds across
books, removes the vig to build a sharp fair line, flags where the best price beats
it, and tracks your closing-line value (CLV). Everything runs in the browser — no
server, no build step, no accounts.

## What's in the repo
Just **`index.html`**. That's the entire app. Nothing else is required.

## Put it online (GitHub Pages — free)
1. Make sure `index.html` is the only file in the repo (delete anything else).
2. Repo → **Settings** → **Pages**.
3. Source: **Deploy from a branch** → Branch: **main** / **/(root)** → **Save**.
4. Wait ~1 minute. Your site is live at:
   **https://dsrackler17.github.io/EdgeDeskSports/**

## First-time setup (10 seconds)
1. Get a free API key at **https://the-odds-api.com**.
2. Open the site → tap **API key** (top-right) → paste it → **Save**.
   (The key is stored only in your browser via localStorage.)
3. Pick a sport → **Scan edges**.

## The tabs
- **Live edges** — choose sport / region / markets / min-EV / sharp book, then scan.
  Each card shows the best price, the sharp fair %, and the edge. Tap **Track** to
  send it to your ledger. Every signal is labeled *research, not advice*.
- **CLV ledger** — your bets, saved on this device. Enter the closing fair % and mark
  win/loss; it shows avg beat-close, +CLV rate, and ROI. CLV over many bets is the
  only real proof the signals work — not whether any single bet won.
- **De-vig** — paste any American odds, get Shin / power / multiplicative fair %.
- **Terms** — the disclaimer.

## How edges are found
For each game/market it de-vigs every book (Shin), anchors the fair line to your
sharp book (default Pinnacle), and flags any outcome where the best price across
books beats that fair line. `EV% = fair × best_decimal − 1`. A de-vig + line-shop
scanner — sport-agnostic, no per-sport model needed.

## Research articles, and the audit that follows them
`/articles` is the public half of the research terminal: one page per matchup,
carrying EdgeDesk's own fair spread, what moved the number, where each team has
a measured edge, and an itemised account of what the model could not see. See
[`articles/README.md`](articles/README.md).

For the games that matter, a second system closes the loop. Before the game it
freezes exactly what EdgeDesk said, in a snapshot identified by a hash of
itself. After the game it loads that snapshot back, grades every claim against
the box score, and publishes a postgame analysis that reports two things
separately and lets them disagree: **did the number land**, and **was the
reasoning any good**. A winning bet on a broken thesis is published as exactly
that, and "what EdgeDesk got wrong" is printed whether the number won or lost.

Every finding is stored as a machine-readable research lesson, so at the end of
a season the platform can answer questions like *which of our drivers fails
most often* and *what share of our winning numbers came with reasoning the game
contradicted*. No model weight is ever changed from one game; a contradicted
claim opens a review candidate, and only a person closes one.

See [`tools/editorial/README.md`](tools/editorial/README.md).

## The Sports Media Content Engine — research-driven articles for publishers

`/admin/content/` (outbound owners only) turns EdgeDesk's committed research
into broad, searchable sports journalism. It finds and scores the week's topics:
CFB and NFL previews, upset watch, conference races, model-versus-line
disagreements, injury implications, and attributed trending headlines. It then:

- writes an SEO brief and a draft from EdgeDesk's own numbers;
- checks every number, team, price label and phrase against the research;
- holds every featured game to a football evidence packet
  (`lib/football_evidence.js`): quarterbacks, both offenses against both
  defenses, availability, form and history, each claim sourced, dated and
  verified. Any gap between EdgeDesk's number and the market is explained,
  or called UNEXPLAINED and never presented as an edge;
- takes the draft through an owner-only review to a publisher-ready Markdown
  or HTML export, with UTM-tagged links.

Claude can rewrite a draft, but its version is kept only if it passes the same
checks. A weekly job (`.github/workflows/content-engine-weekly.yml`) drafts at most a
couple of the best topics into the owner's review queue. Nothing is approved,
sent or published except by the owner, and the database enforces it
(`supabase/content_engine.sql`). See
[`docs/content-engine/README.md`](docs/content-engine/README.md).

## Research Grades (A–F) and Grade Performance

Every game EdgeDesk researches carries an A–F **Research Grade**: how complete,
current, cross-checked and reliable the pregame research is — never the chance
a side wins, and never a pick. The score (0–100) comes from five provisional,
versioned weights: the model's live track record, data completeness, a check
against a sportsbook line captured before kickoff, matchup clarity and
uncertainty. Missing data earns nothing; an unvalidated track record or a
missing line caps the grade; a failed prerequisite means "Not graded".

The hourly performance job locks each grade before kickoff in an append-only,
hash-chained ledger, re-scores every stored grade from its own inputs, and
judges each verified final against the game's latest pregame grade. The
terminal's boards show a badge, a letter filter and a Grade Breakdown;
[`/performance/grades/`](performance/grades/) shows how the grades held up,
with sample sizes and an honest insufficient-data state until enough games
are settled. See [`docs/research-grade/`](docs/research-grade/).

## System integrity: one calculation layer, one integrity engine

Every number EdgeDesk prints is computed in one place:

- `lib/edgedesk_calc.js`: one rounding policy, so a displayed gap is always
  the difference of the two displayed lines;
- `lib/edgedesk_schedule.js`: kickoff truth (time TBA is never a clock time),
  UTC instants shown in the reader's zone, and current-week scope;
- `lib/edgedesk_availability.js`: a missing quarterback announcement is never
  uncertainty.

`lib/edgedesk_integrity.js` checks each game at seven boundaries, from the
research dashboard to the publisher export. Each check returns PASS, WARNING
or BLOCKED, with its rule, evidence and remediation, and BLOCKED never reaches
Ready to Send. Research status and the betting decision are two separately
explained answers.

See [`docs/system-integrity/`](docs/system-integrity/):

- `OPERATING_GUIDE.md` for the owner's daily check and article approval;
- `REPORT.md` for what changed and why.

Tests: `npm run integrity:test` (the 17 regression cases plus an
integration test on PostgreSQL) and `npm run integrity:audit`.

## Market resilience — research never depends on a sportsbook

Every game's football research (projection, matchup, explanation,
uncertainty) is built without a market and stays complete when the odds
provider is down, the quota is exhausted, or a quote fails a check. Market
data is labelled LIVE / CACHED / HISTORICAL / MANUAL / UNAVAILABLE / FAULT
(`lib/edgedesk_market_state.js`). Each game gets three separate answers:
research visibility, market integrity and betting validation
(`lib/edgedesk_research_engine.js`). A large unverified disagreement is
labelled INVESTIGATE and explained by a sensitivity panel, never promoted.
The research page has a RESEARCH ONLY mode and a model-only research
priority. One request budget protects the Odds API quota: every request goes
through `supabase/functions/odds_gateway` and its control plane
(`supabase/odds_api_gateway.sql`; `docs/odds-api-incident-2026-10/INCIDENT.md`). See
[`docs/market-resilience/README.md`](docs/market-resilience/README.md).
Tests: `npm run resilience:test`.

## Game research — the model first, the graphic automatic, the market optional

Every NFL and FBS game opens a research page (`#game/<nfl|cfb>/<id>`) that
leads with EdgeDesk's own snapshot: an automatically drawn matchup graphic
(square 1080×1080 and portrait 1080×1350, PNG download and share), the
projected score, fair spread and total, both win probabilities, what to watch
for from measured unit rankings and the model's own terms, and Beginner /
Research / Lab depth. The snapshot (`football/game_research/`, built hourly)
reads no sportsbook number; a stale or missing quote removes only the market
comparison, and "NO DECISION · STALE_QUOTE" is moved under Lab details. A
reader can compare their own sportsbook price against the model probability
(labelled user-entered and unverified; EV only where calibrated). See
[`docs/game-research/README.md`](docs/game-research/README.md).
Tests: `npm run game:research:test`, `npm run game:research:e2e`.

## Today's Games — what is being played today, one tap from its research

The first thing on the Research screen is today's slate in every sport EdgeDesk
lists: NFL, college football, NBA, college basketball, NHL, MLB, college baseball
and UFC (soccer was removed on 2026-10-15). It covers the reader's own calendar day in their own time zone
(America/Chicago when the browser does not say), with live status and scores, the
price where one was captured from a named book, and **View Research** straight into
the existing research for that game. **View all games** opens `#games`: Yesterday,
Today, Tomorrow and a date picker, sport and status filters, and team search. The
public `/today/` page shows the same slate with the free research and no prices.

Schedules come from ESPN's scoreboard, built into `today/slate.json` every half hour
(`tools/slate/build.js`, `games-slate.yml`), never from the odds pipeline. The slate
is complete while capture is paused. A failed read keeps the last good one with its
age, and a sport that could not be read says "Unable to load", never "No games". Live
scores come from one poller for every visitor (`games-live.yml`,
`supabase/games_slate.sql`). A signal appears only where the owning engine
certified one. See [`docs/games/README.md`](docs/games/README.md).
Tests: `npm run slate:test`, `npm run slate:sql`, `npm run slate:e2e`.

## The linemaker — fair lines in every market, with the record behind them

Research → Other → **Lines** shows EdgeDesk's own fair sheet for every NFL
and CFB game on the slate: spread, moneyline, total, both team totals and
the alternate lines around each, with push probabilities. The sheets come
from the existing engines (`lib/edgedesk_fairline.js`,
`tools/football/build_fair_lines.js` → `football/linemaker/fair_lines.json`)
and never from a sportsbook. The market is shown beside the sheet as a
reference only. Every market carries its status, CALIBRATED or PROVISIONAL,
and the reasons, from a slate-blind replay on seasons the method never saw
(`football/validation/linemaker_{nfl,cfb}.json`). The price check says VALUE
only when the probability at the market's own number is backed by a record.
Published sheets go to an append-only pregame ledger and are graded after
the games (`football/linemaker/grades.json`). The desk answers team-total and
alternate-line questions from the same sheet, knows the game on your screen,
runs under a shared daily Lite/Pro allowance, and saves research to your
account. See [`docs/linemaker/DESIGN.md`](docs/linemaker/DESIGN.md).
Tests: `npm run linemaker:test`, `npm run linemaker:e2e`,
`npm run intel:route`, `npm run intel:sql`.

## EdgeDesk Intelligence — the research desk

The chat panel in `app.html` is served by `supabase/functions/edgedesk_ai`.
Since Slice 1 (2026-09-16) every single-game football turn builds a normalised
**research packet** (the game, the captured prices with capture times, the
projection with its version and validation record, the model-versus-market
comparison oriented onto one side, EV from a named probability, a deterministic
label — PASS / RESEARCH LEAD / PRICE DEPENDENT / MODEL DISAGREEMENT / STALE
MARKET / INSUFFICIENT DATA — data and conclusion confidence, and a source
manifest), asks the writing model for five headed sections, checks the prose
against the packet with a critic that rejects invented numbers, people,
movement causes and certainties, and snapshots the packet write-once to
`research_packets` for grading against the close.

Slice 2 (football intelligence) routes the football layers into that packet:
the opponent-adjusted matchup drivers, ratings, play profiles, projected
starters and coaching from `football/matchup/metrics.json`, the official NFL
injury report, the forecast where one is on file, rest, roof and surface —
and publishes `football/nfl/slate.json`, the browser's own NFL projection run
in Node, so the desk has an NFL number to quote under its validation record.
The panel renders each layer with its source, observed time and freshness.

Slice 3 (the active analyst) makes the desk investigate: a bounded research
loop sends the consequential unanswered questions (starter, offensive line,
opponent-adjusted performance, defensive personnel, weather, price) to the
configured providers under a time, request and cost budget and logs every
outcome; dated team identity profiles (`football/identity/`) keep measured,
sourced and inferred apart; ten matchup interaction modules explain how one
side's strengths meet the other's weaknesses, with the mechanism, the
counter-case and whether the rating already prices it; recent form is read
against opponent quality; nearby-line sensitivity comes from the model's own
residual distribution and says when it is not a betting probability;
scenarios are labelled conditional; follow-ups resolve against a carried
conversation state; `tools/intelligence/analyst_evals.test.js` prints the
before/after scorecard.

Slice 4 (the pricer) makes the desk quote a price before it looks at a book:
a closing-line archive (`football/pricing/`), a time-separated validation of
the shipped engines against the close (`football/validation/pricing_*.json`,
with tiers VALIDATED / LEAN / PROBABILITY / RESEARCH and the rule for each),
a pricing kernel that states the fair line, the cover probability at any
number, the bet-to line and a status per side that only a validated tier can
turn into PLAY, a ranked board, sizing gated on VALIDATED, a held-out feature
intake (all ten NFL candidates rejected), and a closing-line-value scorecard.
Today the NFL spread is LEAN (break-even history at 1.5+ points of
disagreement, not a profit) and everything else is RESEARCH; the desk says so
in every answer and never states an EV.

Slice 5 closes the pricer's data gaps with data sets the desk builds or keeps
itself: a verified hand-entered NFL stadium table (`football/venues/nfl_stadiums.json`),
the official NFL injury report archived 2009 on (`football/pricing/injuries_nfl.json`)
and fed to the feature intake, an opener ledger the builds capture every six
hours (`football/pricing/openers_nfl.json`), a desk notebook the investigation
reads as a provider (`football/notes/current.json`), and a batch import for
hand-entered college availability. See `docs/runbooks/desk-data.md`.

Slice 6 gives the desk a linemaker's timing read and a nightly learning loop:
a college line archive with openers and pregame Elo (`football/pricing/lines_cfb.json`),
a time-separated movement validation (`football/validation/movement_*.json`;
college is LEAN at 2+ points, a tendency, not a record), BET NOW / WAIT per
side in the price panel only under a validated tendency, and
`tools/intelligence/learning_loop.js`, which grades every quoted price against
its close, opener and result and publishes `football/validation/scorecard.json`.

Slice 7 (the board) answers the card-wide question — "What are the best bets
today?", "your strongest college football bet this week", "the best NFL
total", "another single that isn't in my parlay" — across every supported
sport in season, in the reader's own time zone, from the same schedule
sources, decision pass and pricing kernel the single-game desk uses. A
question used to be answered from the one highest-edge cached signal, in
UTC, with started games included and no record; now every sport in scope is
read and its coverage stated, only pregame games inside the window are
considered, both pricing methods (the sharp de-vig and the validated model
blend) are shown with their tier, an outlier is held for a data check rather
than promoted, nothing is forced when nothing qualifies (the watchlist
carries the price or line that would change it), follow-ups keep exclusions
and re-evaluate a changed price, the written answer is checked against the
board, and every emitted opportunity is snapshotted write-once with a
deterministic id. `npm run intel:board` proves the kernel;
`npm run intel:board:live` asks a deployment for its board.

Slice 8 (the staking engine) answers the question the board could rank but
not size: **how many units**. For every eligible game it evaluates every
supported market, takes the no-vig probability from both sides of the same
number, scores its own reliability from eight recorded components, shrinks the
calibrated probability toward a coin flip by exactly how much is known, works
out the expected value at the exact executable price, and then sizes a
quarter-Kelly position and **rounds it down** through every cap — max single,
the validation tier's own ceiling, and game, team, daily and weekly exposure
read from what is already on the card. PASS is a normal, successful answer and
is printed as one: "NO BET. EdgeDesk evaluated 16 current markets and none
produced positive conservative expected value", with the strongest research
candidate and the specific reason it failed. A bankroll is never assumed — with
no setting on file the answer is in units and says an exact dollar amount needs
one. Conviction, rivalry and revenge change nothing. Every position, PASS
included, is written once to `stake_recommendations` with the price, the
probabilities, the Kelly working, the exposure before and after and the reason,
and graded against the close beside a flat 0.5u and a flat 1u on the same
selections — because a sizing engine that does not beat flat staking is a
decoration. Today it does not: `npm run stake:validate` keeps the NFL spread
and total in SHADOW and both college markets in RESEARCH ONLY, and the desk
says so. See `docs/runbooks/staking.md`.

Slice 9 (the desk) makes the answer short and direct. "What's the best market
line value today?", "Is Maryland -2.5 worth betting?", "Why?", "What if it
drops to +2.5?", "Compare that to Maryland ML", "Anything safer?" get the answer
first, then the price, the reason and the risk, in a few sentences.
Every number comes from one typed-evidence contract per game
(`supabase/functions/edgedesk_ai/_desk.js` over `lib/game_research.js` and the
pricing kernel), for college football and the NFL alike. The board is ranked by
the documented board score, never by the writing model. A price boundary comes
from the same verdict rule at every half point ("+3.5 is attractive, +1.5 is
still playable, at +1 or worse pass"). Stale and reference-only prices are
never current opportunities, and "nothing stands out" is a normal answer. The
conversation keeps the bet under discussion. Every focus selection is frozen
pregame in `desk_prediction_history`, so Similar Situations can be measured
honestly once 150 settled predictions exist; until then it says "building
history". See `docs/intelligence-architecture.md` §15 and
`docs/odds-helpers-audit.md`.

- `docs/intelligence-audit.md` — what was found before the change
- `docs/intelligence-architecture.md` — how a turn flows now, switches, next slices
- `docs/data-providers.md`, `docs/model-card-football.md`, `docs/runbooks/`
- `npm run intel:test` — the kernel, the evaluation harness, the migrations
- `npm run intel:stake` · `npm run stake:validate` — the sizing rules, and whether they beat flat staking

## The multi-sport engine — NHL first, every sport honest

Research → Other → **NHL** prices every NHL game with my own model:
moneyline, 60-minute 3-way, puck line, totals and team totals, with the
goalie scenarios, the evidence, the uncertainty and the walk-forward record
behind each number (`hockey/`, docs/engine/NHL.md). Research → Other →
**Engine** is one board across every sport: the best-supported opportunity at
an actual price — or PASS, with why — beside each sport's readiness, computed
from its validation files (`lib/edgedesk_sport_brains.js`,
`lib/edgedesk_xboard.js`). Today the NHL is validated against outcomes and
not yet against the closing market, no sport may claim value, and NHL prices
are not bought until I authorise it. See
[`docs/engine/README.md`](docs/engine/README.md).
Tests: `npm run nhl:test`, `npm run engine:test`, `npm run nhl:sql`, `npm run engine:e2e`.

The NHL game page now has tabs: Overview, Markets, Scenarios, Players,
Evidence, Models and Record. Overview splits each win probability into its
causes with an exact Shapley decomposition (why a club is at its number, factor by
factor). Markets prints the full sheet: alternate puck lines, alternate
totals, regulation totals, team totals and the first period, with a price
check that says exactly why a price is or isn't actionable. Scenarios
re-prices in place for a goalie or a what-if. Players holds the research for
shots on goal, goals, assists, points and saves, with no value claims. Models
holds the challengers. Record holds the drift monitor. A lab scores seven
model families with the production model's own walk-forward
(`hockey/lab/`, [`docs/engine/NHL_LAB.md`](docs/engine/NHL_LAB.md)). None
passes the promotion rule written before scoring, so the incumbent stays,
slimmed to `xg_core`. A source registry records which providers may be used
and why ([`docs/engine/NHL_SOURCES.md`](docs/engine/NHL_SOURCES.md), access
requests drafted, not sent). An optional Supabase warehouse
(`supabase/nhl_warehouse.sql`) stays off until `NHL_WAREHOUSE=on`
([`docs/engine/NHL_OPERATIONS.md`](docs/engine/NHL_OPERATIONS.md)).
Props: [`docs/engine/NHL_PROPS.md`](docs/engine/NHL_PROPS.md).

The NHL list now opens with **EdgeDesk vs the market**: for every game,
EdgeDesk's likelier winner, the book's number with its margin removed, the
side EdgeDesk rates higher and by how much, and whether any price pays above
EdgeDesk's fair line. Each game's Overview adds the full comparison
(moneyline, total and puck line when priced, with EV and the gates each price
fails) and **Who is better where**, a club-by-club table of the ratings
behind the price. The book's price is the DraftKings line Today's Games
already captures from ESPN: a reference, never a verified quote, so nothing
is called value (`lib/edgedesk_nhl_compare.js`, docs/engine/NHL.md §3a).

The EdgeDesk Quant Data Pack is imported and verified (`datapack/quant_v1`,
[`docs/engine/DATAPACK.md`](docs/engine/DATAPACK.md)). On it and on free
multi-season sources I built and validated walk-forward brains for the NBA,
WNBA, men's and women's college basketball (`basketball/`) and MLB
(`mlb/history/`). The soccer brain was removed on 2026-10-15: EdgeDesk covers
American sports and UFC. UFC, college baseball and
tennis are measured as too thin for a model. The Engine's readiness ladder
keeps apart what is loaded, trained, validated, market-tested, priced now and
actionable. Tests: `npm run datapack:test`, `npm run lab:test`, `npm run lab:check`.

Research → Other → **NBA** is the dedicated NBA engine (`nba/`,
[`docs/engine/NBA.md`](docs/engine/NBA.md)). It is built on every game since
2002-03 with reconstructed lineups and shots. Seventeen candidates (Elo,
Glicko, adjusted efficiency, a Kalman model, player impact (RAPM), a
possession simulation, ridge, logistic and boosted trees, and a stacked
ensemble) are scored walk-forward against the existing lab model, with the
test seasons sealed and every opening of them logged. The chosen model prices
every market from one distribution: moneyline, spread, total, alternates, team
totals, first half and first quarter. Player props (minutes × rate, with
correlated combos) are priced the same way, and "if he sits" scenarios come
from the same model. The test seasons (2017-18 to 2025-26, 11,543 games) were
opened once and logged: the stacked ensemble beats tuned Elo by 0.006 log loss
(bootstrap interval clear of zero) and is calibrated (slope 0.999), but plain
ridge is 0.001 better, so the ensemble did not earn its complexity and the next
specification starts from ridge. Most player props validate on the same
seasons; points + rebounds + assists and points + rebounds are still
provisional. NBA prices are not bought and value claims are off until a market
test passes. Tests: `npm run nba:test`, `npm run nba:sql`, `npm run nba:e2e`,
`npm run nba:check`.

## Men's college basketball research — who is good, why, who makes them good, and how it plays against an opponent

`/research/ncaam/` is an independent research engine for NCAA men's
basketball that needs no sportsbook price. It is built from the college
basketball data pack (`datapack/ncaam_v1`, hash-verified on every read) by
`basketball/ncaam_research/` and the shared math in `lib/ncaam_research.js`.
The pages cover:

- **Teams:** opponent-adjusted offense, defense and tempo with uncertainty;
  current form beside the season.
- **What makes a team effective:** four factors, shot mix, rebounding, ball
  security, free throws, transition and possession length. Each is observed
  vs reliability-shrunk "sustainable".
- **Players:** impact per possession (RAPM with box-score and prior-season
  priors), minutes, role, separability, total contribution and replacement
  cost.
- **Lineups:** pooled toward their players.
- **Conditional minutes scenarios.**
- **Matchups:** any two teams.
- **As-of pregame reports** and **2026-27 openers.**

Every number is labelled descriptive, estimated, projected or conditional.

On the held-out 2025-26 season the team model beats the incumbent points
model on margin and win probability (log loss 0.529 vs 0.538), with
day-clustered intervals excluding zero. The player layer adds a small,
measurable signal only with its priors. Absence scenarios, lineup synergy
and style interactions did not improve held-out predictions, so they are
labelled experimental or hypotheses. The market comparison is a separate
layer that says "market comparison unavailable" today; no basketball odds
source is configured. See [`docs/ncaam/README.md`](docs/ncaam/README.md) and
[`docs/ncaam/VALIDATION.md`](docs/ncaam/VALIDATION.md).

Tests: `npm run ncaam:test`, `npm run ncaam:test:pack`, `npm run ncaam:e2e`,
`npm run ncaam:check`. Refresh: `npm run ncaam:refresh`.

## The quant desk — every sport researched model first, then priced, then audited

"What's the best researched opportunity tonight?" is answered across **every
sport EdgeDesk models**, whether or not a sportsbook price exists
([`docs/quant-desk/MULTISPORT.md`](docs/quant-desk/MULTISPORT.md)). Each sport
engine's published projections (NHL, NBA, WNBA, college basketball, NFL and
FBS) are read into one independent contract, frozen and
written to the database **before any price is read**. Only then are the
frozen projections compared with the prices that exist, without moving them.
The answer has four parts:

- the best **verified** opportunity, or why there is none;
- the best **researched** matchup;
- the strongest **conditional** market watch;
- the other candidates.

Each candidate reports its modelled probability, its uncertainty and its
validation as separate measurements. The answer ends with what could change it,
a coverage report for every sport and its sources. MLB, UFC, the NBA preseason
and unmodelled soccer competitions are named with the reason they have no
projection. `EDGEDESK_ODDS_DISABLED=1` turns every price read off and the
research still runs.

The earlier captured-price scan and its **second, independent audit** of the
strongest candidates on a fresh read are kept, as a labelled **market
benchmark** (a book against the sharp market or the model–market blend). For
each candidate it reports event, market, venue, available price, fair price,
net EV, maximum acceptable entry, and audit execution / evidence verification /
trade eligibility as three separate facts.

- **Contract prices.** "Is Rays at 61¢ positive EV?", "Cleveland +1.5 at 61
  cents on Kalshi", "find me a better price than this Kalshi contract":
  `lib/edgedesk_fairodds.js` prices it in exact decimals with typed units and
  each venue's own fee model (Kalshi UNVERIFIED, Polymarket UNKNOWN until an
  operator verifies a schedule in `market_execution_costs`), against the
  captured market's fair, beside every captured book's all-in cost.
- **The audit** (`supabase/functions/edgedesk_ai/_audit.js`): fifteen checks —
  freshness, still offered, independent EV in a second implementation and a
  second de-vig method, contradictory references, an off-market book,
  availability news after the quote, the starter, settlement, fees,
  liquidity, sharp movement, unexplained model disagreement — with a bounded
  correct → recalculate → re-audit loop and a write-once trail.
- **Honest capability** (`lib/edgedesk_projections.js`, `engine/projections.json`):
  NHL moneyline and puck line, NBA, NCAAM/NCAAW and the NFL spread are
  outcome-validated out of sample. None has been shown to beat the closing
  market, so none is called a verified edge yet. CFB moneylines and NHL totals
  are experimental. MLB has no per-game projection; UFC has no model; soccer was
  removed from the platform on 2026-10-15 and is not covered.
- **Calibration** (`lib/edgedesk_calibration.js`): Brier, log loss, buckets,
  CLV, ROI after fees, drawdown and intervals against the no-vig close, with
  look-ahead rows rejected. On the 2026 settled prop ledgers neither league
  beats the close (`football/validation/calibration_props_2026.json`).

See [`docs/quant-desk/MULTISPORT.md`](docs/quant-desk/MULTISPORT.md),
[`docs/quant-desk/DESIGN.md`](docs/quant-desk/DESIGN.md) and
[`docs/quant-desk/INVENTORY.md`](docs/quant-desk/INVENTORY.md).
Tests: `npm run quant:test`, `npm run quant:sql`, `npm run quant:e2e`;
`npm run quant:replay` replays 2026-10-15 from git (no look-ahead);
`npm run quant:calibrate` rebuilds the calibration report.

## The bettor decision layer — BET / LEAN / WATCH / PASS / NO DECISION (NFL and CFB)

Research status says whether a matchup deserves investigation; the **bet
decision** says whether the current price qualifies. They are never merged.
`lib/edgedesk_decision.js` reads what the research, pricing, calibration,
integrity, QB, availability and market systems already produce and returns one
deterministic object per game and market, for the NFL and CFB through one
engine (`footballDecisionEngine`, league-configured) — the decision, the exact
side / line / price / book, units (0.25–1.00U, capped by the probability
source: model-estimated 0.25U, partially calibrated 0.50U), the playable-to
boundary, raw vs calibrated EV, decision confidence (0–100), the reasons, what
would cancel it or trigger it, and every version. **Layer A** asks whether the
wager can be evaluated — NO DECISION only for missing or invalid essential
data, always with a blocker code; **Layer B** decides BET / LEAN / WATCH / PASS
at the exact price across every line and book. Missing optional data (an
immature calibration, unmeasured reliability, unknown personnel) lowers
confidence and caps the class; it never blocks. A huge EV gets price
verification (WATCH · PRICE ANOMALY until it clears), never a bigger stake.
See [`docs/bettor-decision/FOOTBALL_ENGINE_V2.md`](docs/bettor-decision/FOOTBALL_ENGINE_V2.md).

Surfaces: an EDGEDESK ACTION card above the research on every CFB and NFL game,
a decision chip on every FBS board row, and the **EdgeDesk Card** page (`#card`)
with counts, exposure, filters, the reader's recorded bets and CLV, and the
per-tier record. Bankroll → dollars (1 unit = 1% by default), a four-page
onboarding, beginner mode. Today the CFB calibrated EV is about minus the vig at
most main-line prices, and the NFL decides on its validated pricing blend
(partially calibrated), so the honest output is mostly PASS, with LEAN and
WATCH where a real but sub-threshold edge exists. Every threshold is a
labelled, configurable, conservative default that is **not yet empirically
validated**. See [`docs/bettor-decision/DESIGN.md`](docs/bettor-decision/DESIGN.md),
the audit in `docs/bettor-decision/AUDIT.md` and the engineering report in
`docs/bettor-decision/REPORT.md`.

**Decision quality** ([`docs/bettor-decision/QUALITY_UPGRADE.md`](docs/bettor-decision/QUALITY_UPGRADE.md)):

- Every decision reads **one canonical market** (`lib/edgedesk_market.js`), which carries:
  - consensus, verification status, depth and a quality index that is not a probability;
  - the sharp reference;
  - movement that is described, never attributed.

  One off-market book is named with its distance from consensus and cannot become a BET.
- An **execution layer** (`lib/edgedesk_execution.js`) shows:
  - the price-value curve;
  - a ladder of only the rungs where the decision changes;
  - best execution with its reason;
  - empirical key numbers (`football/validation/key_numbers.json`).
- Every decision carries **versions** and a leakage flag.
- The build ledger grades **every class** (PASS and WATCH too) with CLV in points and in price.
- `lib/edgedesk_validation.js` keeps backtest, walk-forward, reconstructed and live evidence apart. Every figure prints its `n` and a sample state (<50 too early · 50–199 early signal · 200–499 developing · 500+ meaningful). Research alerts never change anything automatically.
- The Card page reads a cached **model health** report (`football/validation/model_health.json`).
- Cards come in **Beginner / Research / Lab** levels (`lib/edgedesk_explain.js`): a one-line answer, why not, what changes my mind, and break the number.

- `npm run bettor:test` — the engine, tracks, bankroll, inputs and renderers, and the unified NFL/CFB engine suite (`tools/bettor/football_decision.test.js`: cases A–L plus the real NFL and CFB payloads)
- `npm run validation:test` — canonical market, execution, validation, ledger & model health, explanations and the three levels; `npm run validation:sql` — `supabase/decision_validation.sql` against a real PostgreSQL; `npm run validation:health` — the model health report
- `npm run bettor:sql` — `supabase/bettor_decisions.sql` against a real PostgreSQL
- `npm run bettor:e2e` — the layer in Chromium, desktop and a 390 px phone

## EdgeDesk Model Performance: every pregame forecast, graded, misses included

`/performance/` is the public record of EdgeDesk's models. It is free and needs no account. Every eligible game forecast, in every sport with a per-game model (NFL, college football, NBA, NHL, WNBA, college basketball), is locked before the start and graded against the verified final.

**The ledger** (`performance/ledger/`) is append-only and hash-chained. It holds:
- every forecast revision, from the independent projection contract (`engine/build_projections.js`, no price read);
- every named-book quote change captured before a start;
- every verified result revision;
- every grade revision.

**The graded forecast** is the last one the ledger captured before the actual start. Earlier revisions are kept, and nothing is overwritten.

**Verification tiers.** *Verified pregame* means the ledger itself captured the forecast. Forecasts imported from EdgeDesk's earlier pregame-only records are *recorded pregame*, labelled as such and never counted in the verified headline. Walk-forward evaluations are shown apart, as *retrospective*.

**Results.** These come from the scoreboard the slate already reads and each sport's own result file, and the sources must agree. A correction is a new revision that regrades the game; postponed, canceled and forfeited games are void.

**Metrics:**
- right winner, Brier, log loss, calibration with Wilson intervals, confidence bands;
- margin and total error;
- model against the captured line, with records at the line;
- units only at a captured price;
- CLV only against a same-source close;
- trends over time.

Every figure carries its `n`, and nothing is printed under 20 games.

**Integrations:**
- Played matchup articles gain an **EdgeDesk Prediction vs. Actual Result** block, built from the article's own published numbers.
- The Monday Weekend Model Review gains a cross-sport accountability section.
- Weekly social drafts are written to `performance/social/`. Nothing posts.

**Docs:**
- [`docs/model-performance/AUDIT.md`](docs/model-performance/AUDIT.md): what existed and the gaps
- [`docs/model-performance/DESIGN.md`](docs/model-performance/DESIGN.md): the design
- [`docs/model-performance/RUNBOOK.md`](docs/model-performance/RUNBOOK.md): configuration, deployment, monitoring, rollback and costs

**Commands:**
- `npm run performance:dry` / `performance:run`: dry run / write
- `npm run performance:check`: chains plus append-only against main
- `npm run performance:test`, `performance:sql`, `performance:e2e`: the test suites
- `npm run performance:sync`: the optional Supabase mirror

## Profit & Loss — every recommendation at the price it was made

The Record's **Profit & Loss** book answers one question: *if I had followed every
EdgeDesk recommendation, how much would I be up or down?* It reads the ledgers the
pipelines already keep: frozen player props, frozen game decisions and the football
model record. It copies each recommendation and each settlement exactly as recorded,
and prices them at the **American odds captured when the call was made**.

- **Two strategies, never mixed:** flat 1u, and EdgeDesk's recommended stakes.
- **ROI is net ÷ risked.**
- **No entry price, no P&L.** The result still counts in the win/loss record, and EdgeDesk never assumes −110.
- **Corrections update the same row**, and each one is logged on it.
- **Nothing is deleted.**

The book has:

- summary cards;
- the cumulative P&L with its running peak and drawdown;
- breakdowns by league, market, prop type, side, book, model edge, grade, unit size, week and model version;
- edge calibration and CLV against P&L;
- player prop performance;
- a searchable, auditable ledger.

It renders in the app (Records → *Profit & Loss*, with dollars at the reader's own
unit) and on the public `record.html#pnl` (units only).

- **Design:** [`docs/pnl/DESIGN.md`](docs/pnl/DESIGN.md)
- `npm run record:pnl` — rebuild `record/pnl/`; `record:pnl:test`, `record:pnl:sql`, `record:pnl:e2e` — the suites
- `supabase/model_pnl.sql`, `supabase/model_pnl_states.sql`, `supabase/model_pnl_analytics.sql` — the idempotent table, corrections audit, every row's one state and the canonical record, rollups and a reader's own dollars

## Player Props — the prop research terminal (NFL and CFB)

The **Props** tab (`#playerprops`) prices player props the same way the
decision layer prices sides and totals. For every prop it shows:

- **Projection:** volume × share × efficiency, with the raw model shown
  beside a 30% market-informed blend.
- **Distribution:** a full distribution per market (Normal, Poisson, negative
  binomial, gamma-compound, longest-play), giving the probability of over,
  under and push at any line.
- **Price:** fair odds; the no-vig market; the best price across books and
  alternate lines; EV at that exact price.
- **Decision:** BET / LEAN / WATCH / PASS / NO DECISION. Units are 0.25–1U,
  capped by how well the probabilities have been validated. A huge EV is
  treated as a price to verify, not a bet.

Hit rates, usage, matchup ranks, role, injuries and the game environment sit
beside the numbers as context. The page labels them as context, never as a
probability.

Prices come from The Odds API. The capture is opt-in and budgeted: it needs
the `ODDS_API_KEY` secret and the repository variable `PROPS_CAPTURE=on`.
Until then the board shows projections and fair lines, and no EV.

Graded results print CLV only where a close exists. Calibration is measured
by probability bucket. The probability source is promoted only when the
settled record earns it.

Beside the engine, the drawer shows a **validated model**: the data factory's
learned, walk-forward-validated distribution for the same prop, priced at the
same line and price. It is built from per-game history (NFL 2011+, college
2014+), a CFB→NFL identity bridge and a leakage-tested point-in-time feature
store. It is evidence, not the decision.

- **Runbook:** [`docs/runbooks/player-props.md`](docs/runbooks/player-props.md)
- **Design:** [`docs/player-props/DESIGN.md`](docs/player-props/DESIGN.md)
- **Data factory:** [`docs/player-props/FACTORY.md`](docs/player-props/FACTORY.md)

- `npm run props:test` — the kernel and the offline pipeline
- `npm run props:sql` — the ledger and watchlist SQL against a real PostgreSQL
- `npm run props:e2e` — the page in Chromium, desktop and a 390 px phone
- `npm run props:board`, `props:board:cfb`, `props:capture`, `props:grade`,
  `props:backtest`, `props:sync` — the pipeline steps
- `npm run props:factory:test`, `props:factory:sql` — the data factory's suites;
  `props:factory:history`, `:backtest`, `:train`, `:project`, `:sync` — its stages

## Portfolio — every bet and prediction-market position, one ledger
*Portfolio* — a seat in the bottom bar (or `#portfolio`) — is the reader's own book across every
sportsbook and prediction market they use, and it answers one question first:
**am I up or down?** Below that are ROI, capital, open exposure and the record;
sportsbook and prediction-market P&L apart and combined; P&L by platform; and
the cumulative line.

- **Tabs:** Overview, Open, History (search, filters, CSV export), Analytics
  (7D / 30D / YTD / All; best and worst platform, sport and market type; by
  where the idea came from) and Accounts.
- **Getting positions in:** sportsbook bets and prediction-market positions are
  entered by hand, or imported from a CSV that is classified on the server —
  new, duplicate, needs review, invalid — before the reader confirms.
- **Money:** every figure is NUMERIC, derived by a database trigger and held in
  parity with `lib/edgedesk_portfolio.js`. Wagers and contracts follow
  different rules: odds × stake, against fills at an average cost.
- **No automatic sync yet**, and nothing says "Connected". The connector
  contract for Phase B (Kalshi first) is in place.

See [`docs/portfolio-architecture.md`](docs/portfolio-architecture.md) and
[`docs/platform-support.md`](docs/platform-support.md).

- `npm run portfolio:test` — the engine, the importer and the page
- `npm run portfolio:sql` — `supabase/portfolio.sql` against a real PostgreSQL, as real readers
- `npm run portfolio:e2e` — the page in Chromium against the real migration, desktop and a 390 px phone

## Learn EdgeDesk — the introduction, walkthroughs and Help

A first visit gets a short introduction ("Research, not picks"). It offers
**Show me around**, which asks *what would you like to do?*, and **Explore
on my own**. It is asked once, and the answer is kept on the device and the
account.

The **?** in the header opens Help on every screen and on phones. Help offers:

- the walkthrough for the page you are on;
- the other tasks;
- a searchable glossary;
- the introduction again.

There are five walkthroughs, each a few steps on the real screen with Back,
Next and Skip:

- research a game;
- understand the research numbers;
- explore player props;
- read today's Card;
- track your bets.

They handle loading, missing data, a locked account and a reader who
navigates away.

Fair spread, implied probability, EV, CLV, confidence, data confidence,
research readiness and the BET/LEAN/WATCH/PASS decisions each open an
explainer where they appear. Every explainer says what the number is, how to
use it, and what it cannot tell you. See
[`docs/guide/README.md`](docs/guide/README.md).
Tests: `npm run guide:test`, `npm run guide:e2e`.

## The personal research terminal
A reader's own research now lives on their account: a **watchlist** (the star on
every game card and on the Top 5), **research-condition alerts** under the bell
(a fair line moving, a quarterback confirmed, the market converging — never
"bet" alerts), a **Top 5 Games to Research** list ordered by research-worthiness
rather than by gap, a **decision journal** that freezes EdgeDesk's numbers at
decision time and grades the reader's number against the close (process and
result kept apart, no profit figure anywhere), first-run **onboarding**, live
**activity counts** from real rows, a **partner program** tracked from Stripe's own
events, and an AI desk that answers "what changed in my watchlist?" or "how has
my CLV looked this month?" from those rows — and says so when a row is missing.
No model methodology changed. See
[`docs/personal-research-terminal.md`](docs/personal-research-terminal.md).

On top of it, the growth upgrade adds **Compare My Number** (a reader's own
fair spread and total beside EdgeDesk's and the market's, the measured inputs
the difference runs through, saved write-once to the journal and set against
the close), **research cards** sized for X from real current data only,
**trial activation** states from deduplicated actions (internal, with
configurable thresholds and an admin report), **acquisition attribution**
(first touch frozen, last touch kept apart, the affiliate ledger untouched),
a one-question **persona** that reorders the desk without hiding anything,
**public sample research** for games an admin chooses, and per-code **creator
campaigns** whose discount Stripe confirms. See
[`docs/growth-upgrade.md`](docs/growth-upgrade.md).

## The weekly research email
Twice a week the same research goes out as an email nobody sends: **College
Football Week Ahead** on Monday and **NFL Week Ahead** on Tuesday, both at 10:00
America/Chicago, the second after Monday Night Football. Each edition carries
the five upcoming games most worth researching — up to ten when more of them
earn it, fewer when they do not, and none rather than padding — with EdgeDesk's
fair spread beside a named book's number, the evidence behind the difference,
and the thing the model could not see printed next to both.

The ranking deliberately does **not** sort on the biggest gap to the market: the
largest gaps in any week come from the thinnest data, so a discrepancy earns its
points only as far as the price and the sample behind it reach, and one standing
on neither is refused with the reason published in the email's own introduction.

Sending is off until an operator turns it on, unsubscribe works in one click
without a login, and no page in this repository can read a subscriber address.

See [`tools/newsletter/README.md`](tools/newsletter/README.md).

## Honest notes
- The API key lives in your browser. That's fine for personal use; it is **not**
  safe if you ever share/sell the page (anyone could read it). Selling later means
  moving the key to a backend.
- The edge is line-shopping soft prices vs the sharp consensus — real but thin, and
  books that limit winners will limit you. Bias toward reduced-juice books.
- Your CLV ledger is the verdict. If beat-close isn't positive over a couple hundred
  bets, the signals are noise.
- Research/information only. Not betting or financial advice. No guaranteed results.
  21+. Gamble responsibly — 1-800-GAMBLER. Not legal advice.
