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
