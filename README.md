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
