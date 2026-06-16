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
