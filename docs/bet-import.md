# Import picks — screenshots or pasted text

*For books with no history export (Novig, ProphetX, Kalshi, DK Predictions, …).* The reader adds screenshots of their bet history, or pastes its text. EdgeDesk's reader (Claude, vision) turns them into one row per bet: it tells the platform from the screenshot and starts reading the moment the screenshots are chosen. The reader checks every row in an editable table; rows with nothing to check arrive already confirmed, and only confirmed rows are saved to their Portfolio. A pick saved while open is **updated in place** when a later screenshot shows its result.

It sits beside the existing ways in, with the same result:

| Way in | Where | What it writes |
|---|---|---|
| Record by hand | Portfolio → + Add position | `portfolio_positions` (`source = MANUAL`) |
| CSV import | Portfolio → Import → A file (CSV) | the import pipeline → `portfolio_positions` (`CSV`) |
| One bet slip, OCR on the device | Import / Accounts → "Or one bet from a screenshot" | the manual form, filled in (`MANUAL`) |
| **Import picks (this)** | **Import → Screenshots or pasted text**, + Add position, the empty book | **the import pipeline → `portfolio_positions` (`IMPORT_SCREENSHOT` / `IMPORT_PASTE`)** |

There is **no second picks table**. Picks go through the Portfolio's own staging and commit (`portfolio_imports` → `portfolio_import_rows` → `portfolio_import_classify()` → `portfolio_import_commit()`, `supabase/portfolio.sql`). They get the same server-side validation, the same fingerprint dedupe, the same derived P&L and the same row level security as every other import.

## 1. The flow

```
1 BOOK    Detect automatically (default) · Novig · ProphetX · Kalshi · DK Predictions · Other
          (name + sportsbook / prediction market); each row's platform can be changed in review
2 ADD     screenshots (camera roll, up to 12) — read     or   pasted text (up to 120,000 characters)
          as soon as they are chosen
          ├─ scaled to ≤ 2576 px, re-encoded as JPEG          └─ read in parts of 12,000 characters
          │  on the device (drops photo metadata);
          │  tall scrolling captures cut into
          │  overlapping tiles
          └─ sent 2 images per request ──▶ parse_bet_import (edge function, JWT) ──▶ Anthropic Messages API
                                           │  strict JSON schema; every row checked on the server;
                                           │  a failing row is FLAGGED with its issues, never dropped
3 REVIEW  editable table: low-confidence fields highlighted; rows with errors cannot be confirmed;
          each pick matched to an EdgeDesk game (public.signals) — unmatched ones said plainly, with
          the games to pick from; "already in your portfolio" checked before Confirm (a read);
          a clean row (valid, no warning, nothing unsure, its game settled) arrives confirmed;
          "Add more screenshots" appends to the same review
4 SAVE    Confirm → stage → classify → commit → finalize, under the reader's own token;
          a pick saved Open that this screenshot settles → one PATCH of that position (§5)
```

**Nothing is written before Confirm.** Reading, game matching and the duplicate check are reads, and a pre-confirmed row is only a tick the reader can remove. The staging rows are written in the same step as the commit.

**The platform.** "Detect automatically" is the default: the model names the platform from the logo, names and layout, and the row says "(detected)". DraftKings and FanDuel each have two products: a position priced as a percentage or in cents is read as **DraftKings Predictions** / **FanDuel Predicts**, not the sportsbook. When it cannot be told, the row asks for it (an error until chosen). A platform the reader picks on the first step wins; a screenshot that names another one is a warning.

## 2. What is extracted, per bet

`supabase/functions/parse_bet_import` asks for strict JSON (`output_config.format`, the schema in `lib/edgedesk_bet_import_core.js` `SCHEMA`):

| Field | Notes |
|---|---|
| sport, league | inferred from the teams is allowed, rated lower |
| event, teams, event_start | "Away @ Home"; a prediction market's title |
| market_type | moneyline · spread · total · prop · parlay · future · other |
| market, selection, side, line | `side` is YES / NO for contracts |
| price_display, price_format, price_value | exactly as shown ("54¢", "+120", "1.91") |
| stake, contracts, potential_payout, payout, fees | dollars; a contract's stake is its cost ("Bought $24.64"), payout what it paid ("Paid $48.84") |
| boost_pct | a profit boost the card shows ("25% Boost"); a boosted win's payout is recorded as paid |
| placed_at | local `YYYY-MM-DDTHH:MM`, resolved from "Yesterday 7:05 PM" with the reader's date and zone |
| status | open · won · lost · push · void · cashed_out · unknown |
| bet_id, is_bonus, legs, notes | |
| confidence | 0–1 for book, sport, league, event, market_type, selection, line, price, stake, payout, placed_at, status |

**Prices are stored both ways.**

- `portfolio_positions.price_display` is the price as shown.
- `price_american` is that price as American odds, *derived by trigger* for both instruments. A wager uses its own odds. A contract uses its average entry price read as a probability: **54¢ → −117, 40¢ → +150, 50¢ → +100, 32¢ → +213.**
- The rule is half away from zero, computed exactly (`public.portfolio_prob_to_american` ≡ `EDBetImportCore.probToAmerican`).

**Which instrument.** Novig and ProphetX are sportsbooks (exchanges): a stake at odds. Kalshi and DK Predictions are prediction markets: each pick becomes a BUY fill of `contracts` at `price` (0–1). The position is rebuilt from it, as the Portfolio always does.

- A contract that won resolves to its side; one that lost resolves to the other side. What a settled one paid is its `reported_payout` (a boosted win pays more than $1 a contract).
- A contract sold early becomes a BUY and a SELL.
- A pick that names its outcome ("Under 202.5", "James Madison") is YES on it unless it says No; the row says so as information.
- **Contracts, exactly.** The Portfolio stores a fill as contracts × price and requires that product to be a whole millionth, so a 2-decimal price (54¢, 54%) takes contracts to 4 decimals. `EDBetImportCore.contractsFor` uses, in order: the count as printed; the payout if it wins, when that does not cost more than was paid; the cost ÷ price rounded *down* to what the price allows; what a win paid (no boost). Whatever was paid beyond contracts × price (fees, or that rounding's fraction of a cent) is the fill's fee, so the cost stored is exactly what the reader paid. *DK example:* Under 202.5 at 54%, Bought $24.64 → 45.6296 contracts = $24.639984 + $0.000016 fee; it won and Paid $48.84 (25% boost) → P&L **+$24.20**.
- One game's Over and Under (or two teams' spreads) are different contracts: the selection is part of the contract's market name ("Total Points · Under 202.5").

## 3. The checks (one set of rules, two places)

`lib/edgedesk_bet_import_core.js` is copied verbatim into the function (`tools/portfolio/inline_bet_import_core.js`; the unit suite fails on drift). The server runs it over the model's answer. The browser runs it again on every edit.

- **Errors** block Confirm until fixed: no event, no pick or side, no price or an unreadable one, no stake (or contracts), a contract count the price cannot carry exactly, no placed date or one in the future, a cash-out with no amount, a parlay of contracts, no platform.
- **Warnings** highlight and keep a row from arriving confirmed. Examples: a payout the price doesn't explain, a price converted between odds and cents, a cost below contracts × price, a book that differs from the one chosen, an unknown result (recorded as open), and twins in one upload ("only one is saved").
- **Information** says what was worked out and needs nothing: contracts derived, a boosted payout recorded, YES assumed from the pick. It is shown muted, does not count as "flagged", and does not stop pre-confirmation.
- **Unsure** marks only a field that holds a value the model rated below 0.7: a moneyline has no line and an open bet no payout, and empty is not doubt.
- An answer cut off by `max_tokens` keeps its complete bets and says some may be missing.

## 4. Matching a pick to an EdgeDesk game (for CLV)

The candidates come from `public.signals` (EdgeDesk's capture), through `bet_import_events(from, to, sports)` and `bet_import_markets(event_ids)`. Those return event identity and capture keys only, never a price.

- **Matched on its own** only when both teams are named, it is the only such game, and the start fits: placed at most 10 days before (or during) the game, and within 3 hours of any start the screenshot printed.
- **A shared city is evidence for neither team:** "New York Giants" does not name the Jets.
- Anything else is **offered, never chosen.** The row says "Not matched · Without a game, CLV is not graded" and lists the games to pick from, a search box, and "No EdgeDesk game — save without CLV".
- A pick no EdgeDesk game fits at all (no candidate) says **No game found** and is saved without a game unless the reader searches one out; it can arrive confirmed. One with games to choose from waits for the reader.
- A matched sportsbook single (moneyline, spread, total) also gets its exact capture key (`signals.sig_key`), stored as `portfolio_positions.market_sig_key` with `event_id` and `event_start_at`.

`portfolio_svc_attach_import_close()` runs every 15 minutes (pg_cron). Once a matched single's game has started, it writes the close to the journal as an `EDGEDESK_CAPTURE` close; the Portfolio's CLV is computed from that close.

- **The close it uses:** the reader's own book's last captured tick at or before the start, no more than 6 hours before it (`book_quote_ticks`, the Decision Record feed's rule). If there is none, EdgeDesk's own recorded close for that market (`signals.closing_dec`).
- It writes once, only on the stored key, and only when the line is the pick's own.

## 5. Saving

- One `portfolio_imports` row per kind (`screenshot_v1` / `paste_v1`) and one staged row per pick (two for a contract sold early).
- Then `portfolio_import_commit()` and `portfolio_bet_import_finalize()`, which copies the price as shown, the game and its capture key from the reviewed rows. All of it runs under the reader's own token.
- **The label.** The commit writes `'CSV'`; the trigger `portfolio_import_source()` relabels a row `IMPORT_SCREENSHOT` / `IMPORT_PASTE` at insert when its import is a screenshot or paste import. Upper case, like the column's other values.
- **Dedupe.** A pick matching one already saved for the same reader on platform, event, market, selection and line, price, stake and placed minute (the Portfolio's fingerprint) is `DUPLICATE` and skipped. Twins in one upload are `DUPLICATE_IN_FILE`. The page checks the same fingerprint before Confirm and shows "Already in your portfolio".
- **Automatic update.** The fingerprint leaves the result out, so last week's Open pick and today's screenshot of it Won are the same pick. Before Confirm the page reads the saved position (`id, status, resolution, reported_payout, source`) and plans the change (`EDBetImport.updatePlan`):
  - saved **Open**, now settled → one PATCH of that position: a wager's `status, reported_payout, settled_at`; a contract's `resolution, reported_payout, settled_at`. The row says "Already in your portfolio as Open — saving updates it to Won (paid 48.84)", arrives confirmed, and the button reads "Confirm and update 1 pick". The derive trigger recomputes P&L and result.
  - already settled the same way → nothing (skipped, as before); settled **another** way → left alone, and the row says so ("edit it in History if this is right"); sold early while saved open → the reader records the sale in History.
  - a synced position is the platform's record and is never patched (its guard would refuse it anyway).
  - The PATCH runs under the reader's token and the existing owner-only update policy: no new grant, no new function. It is never an insert, so a pick is never saved twice.
  - DK Predictions has no API: the result updates when a later screenshot of it is imported, not on its own.
- **RLS** is unchanged: owner-only on every table. The two insert policies only gain the two new source values; `portfolio.sql` carries the same text, so re-running either file leaves the same policy.
- **Sync.** A future sportsbook or Kalshi sync adopts an imported pick instead of counting it twice (`portfolio_aggregator.sql`, `portfolio_connect.sql`).

## 6. Security, privacy, cost

- **The images are never stored.** They go browser → function → model and are dropped. The page re-encodes them first, which strips EXIF and location. The usage row records counts and sizes only. No log line carries an image, the text, a token or a bet, and the suite checks this.
- **The API key** is the Supabase secret `ANTHROPIC_API_KEY` (shared with `edgedesk_ai`), read in the function and sent only to `api.anthropic.com`.
- **Auth.** The gateway verifies the JWT (deployed without `--no-verify-jwt`), and the function asks Supabase Auth again. The public anon key is refused.
- **Limits per request:** ≤ 6 images, each a real PNG / JPEG / WebP / GIF (checked by magic bytes) of ≤ 4.5 MB, ≤ 18 MB together, or ≤ 40,000 characters of text. The page sends 2 images, or 12,000 characters, at a time, so each read stays well inside the function's time limit.
- **A long read stays connected.** Sign-in, the request checks and the allowance answer with their own status (401, 413, 429, 503). Once a request is accepted, the function answers `200` at once and sends a space every 4 seconds until the JSON (`keepAlive` in the function; `JSON.parse` skips the spaces). Without it, a phone browser (iPhone Safari) or a proxy could drop a minute-long read that had sent nothing, and the page could only say "EdgeDesk could not be reached". A failure from then on is `{ ok: false, status, reason, message }` in that body.
- **"EdgeDesk could not be reached"** means the browser got no readable answer. If it appears for every reader, check the function is deployed (Actions → Deploy bet import): a function that does not exist answers without CORS headers, which the browser reports as a network failure.
- **The allowance** (`bet_import_policy`, one row the service role edits): 20 requests an hour and 60 a day per reader, 200 images a day, 3,000 requests a day across all readers. `enabled = false` stops all requests.
  - A claim is atomic per reader (an advisory lock), and refused claims are recorded.
  - **It fails closed:** if the allowance cannot be checked, nothing is sent to the model.
- **Prompt injection.** The prompt treats all input as data. Pasted text goes between markers, and a platform name typed for "Other" cannot break out of its quotes.
- **Model:** `claude-opus-5-5`, effort `medium`, with the server-side refusal fallback (`fallbacks: "default"`). Override with `BET_IMPORT_MODEL`, `BET_IMPORT_EFFORT` and `BET_IMPORT_FALLBACKS=0`.
- **Cost:** a phone screenshot is roughly 1–5k image tokens, and the answer is about 200 tokens a bet.

## 7. Deploy

1. **Actions → Deploy bet import (screenshots / paste)** (`.github/workflows/deploy-bet-import.yml`). It runs the suites first, then applies `supabase/bet_import.sql` (one transaction; a `CHECK THIS` fails it), then deploys `parse_bet_import`. Alternatively, paste `supabase/bet_import.sql` into the SQL editor; its 10 report rows should read `ok`.
2. **Secrets:**
   - GitHub: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SB_DB_URL`.
   - Supabase: `ANTHROPIC_API_KEY`.
3. Merging ships the page: `lib/edgedesk_bet_import_core.js`, `lib/edgedesk_bet_import.js`, `lib/edgedesk_bet_import.css` and `app.html`.
4. Before any sync is ever switched on, re-run **Deploy Portfolio schema** so the sync adoption lists know the two new sources.

## 8. Tests

| Suite | What it proves |
|---|---|
| `node tools/portfolio/bet_import.test.js` (100) | The core: every price shape exact; the schema strict all the way down; flag-don't-drop. The shipped function against a mocked network: sign-in, the caps, the allowance failing closed, the call (key, version, schema, fallback), the server checks, the settle, no input in any log, and a request with no platform read as "detect automatically". The review table: unsure and blocked fields, matching, escaping, staged rows, and the `app.html` wiring. **DK Predictions** from a reader's screenshots: platform detected, percent prices, Bought / Paid / boost, exact contracts, contract names, pre-confirmation, and every update plan. |
| `node tools/portfolio/bet_import_sql.test.js` (76) | `bet_import.sql` over the Portfolio schema, twice. The browser's own staged rows through the real commit; labels, prices, game and key; the browser fingerprint ≡ the database's. Dedupe (screenshot, then paste), in-file twins, an invalid row kept and flagged. Kalshi contracts, cents and a sale. The DK cards through the commit with the book's P&L (+24.20, −24.64, −24.78), then an Open pick settled in place by the browser's own update plan under RLS (another reader cannot), and the same screenshot never inserted twice; a sportsbook pick Open → Won the same way. RLS as another reader and anon. The allowance. The games lookup. The close (Novig tick, then EdgeDesk's close), once, for the scheduler only. |
| `node tools/portfolio/bet_import.e2e.js` (41) | Chromium, the real migrations: reading starts on choosing the screenshots, scaled and tiled on the device; the clean pick arrives confirmed; fixing a stake in place, picking a game, deleting junk, Confirm, saved rows in the database, and the same picks refused a second time. DK Predictions with no platform chosen: five rows, three pre-confirmed, one more screenshot appended, one Save, then a later screenshot updates the open pick in place — at 1280 px and 390 px. |
| `ANTHROPIC_API_KEY=… node tools/portfolio/bet_import_live.js shots…` | **Opt-in, a real API call, never in CI.** Your own screenshots (or `--paste FILE`) through the deployed function's request checks, prompt, schema and model call, and the server checks; prints what the review table would show. `--expect tools/portfolio/fixtures/dk_predictions_trades.json` compares against the transcribed DK screenshots. |

The first three run in `.github/workflows/portfolio-tests.yml`. The DK fixture (`tools/portfolio/fixtures/dk_predictions_trades.json`) is a hand transcription of three "Trades" screenshots a reader shared; the images are not committed (their header shows an account balance, which is never a bet).

## 9. Manual check (production)

**Novig screenshot**

1. Portfolio → Import → **Screenshots or pasted text**. Leave **Detect automatically** on and choose a screenshot of your Novig bet history from the camera roll: reading starts straight away.
2. Every bet in the screenshot is a row, filed under **Novig (detected)**. Check the fields: unsure ones are highlighted, a row with an error cannot be confirmed, and a row with nothing to check is already ticked. A Chiefs −2.5 at −110 shows `-110` in Price.
3. Each NFL / NBA / … pick says **Matched** with its game, or **Not matched** with games to pick from. Pick one or choose "No EdgeDesk game".
4. Fix anything wrong, delete what isn't a bet, then **Confirm** rows (or **Confirm all without errors**) → **Confirm and save N picks**.
5. History shows the picks. In the SQL editor: `select selection, source, price_display, price_american, event_id, market_sig_key from portfolio_positions order by created_at desc limit 5;` gives `IMPORT_SCREENSHOT`, the price as shown, and the game.
6. Import the same screenshot again: each row says **Already in your portfolio** and Save stays at 0.

**Pasted Kalshi history**

1. Kalshi → Portfolio / History: select the rows, copy. In EdgeDesk: **Kalshi** → **Paste text** → paste → **Read my picks**.
2. Each position shows YES/NO, the price as **54¢** with "≈ −117 · $0.54" under it, contracts and cost. A settled one shows Won or Lost; one sold early shows Cashed out with what it sold for.
3. **Confirm and save.** In History the position reads Kalshi, settled with its P&L. `price_display` is `54¢`, `price_american` is `-117`, and `source` is `IMPORT_PASTE`.
4. Paste the same text again: nothing new is saved.
5. Allowance: `select status, reason, images, outcome, bets, tokens_in, tokens_out from bet_import_usage order by id desc limit 5;` shows one row per read, with counts only.

**DraftKings Predictions screenshots (My Activity → Trades)**

1. Choose the screenshots with **Detect automatically** on. Each card is a row filed under **DraftKings Predictions (detected)**: "Under 202.5 | 54%" shows 54% with "≈ −117 · $0.54", Bought $24.64 as the cost, contracts worked out (45.6296), Won with Paid $48.84 and "25% boost". The header balance is not a row.
2. Complete cards arrive ticked; a card cut off by the screen edge is a row that asks for what it is missing (usually when it was placed).
3. **Confirm and save.** History shows each as a settled DraftKings Predictions position: +$24.20 for the boosted win, −$24.64 / −$24.78 for the losses.
4. For an open trade: save it while open; after it settles, import a new screenshot of it. The row says **Already in your portfolio as Open — saving updates it to Won**; **Confirm and update 1 pick** settles the same position (no second one).
