# Novig exchange market data — DraftKings vs Novig, at the price a stake actually gets

EdgeDesk should tell a reader not just what a line is, but what that line
actually costs, whether a better executable number exists elsewhere, and how
that price changes expected value. This integration adds Novig — a
peer-to-peer sports exchange — beside the existing DraftKings / The Odds API
pipeline, for the same bet, at the reader's stake, with every limit stated.

**Status (2026-10-30).** Built and tested. **Not yet deployed or
authenticated:** the read-only key has to be provisioned from the project's
management key (§Credentials), which only the owner's GitHub/Supabase
credentials can do. Public display is **off** until Novig's written
permission is on record (§Data rights). Nothing here places an order.

| Piece | Where |
|---|---|
| NOVIG-V3 signer | `lib/novig_signing.js` (30/30 of Novig's published vectors) |
| Executable-price engine and metrics | `lib/edgedesk_venue_compare.js` (`window.EDVENUE`) |
| Market matching | `lib/novig_market_map.js` (with `lib/football_identity.js`) |
| REST ingestion | `supabase/functions/novig_sync` (probe / discover / snapshot) |
| Storage, comparison, research, KPIs | `supabase/novig_market_data.sql` (+ `_cron`, `_rollback`, migrations `20261030120000`, `20261030120100`) |
| Key provisioning (transient) | `supabase/functions/novig_key_bootstrap`, `tools/novig/provision.js`, `.github/workflows/novig-provision.yml` |
| Stream (off) | `lib/novig_stream.js`, `tools/novig/stream_worker.js` |
| Game-card module | `lib/edgedesk_market_compare_ui.js` (`EDMarketCompareUI.html`, called by `app.html`'s own `window.fbNovigHTML`, beside `fbKalshiHTML`) |
| Graphics | `lib/edgedesk_compare_cards.js` (`window.EDCompareCards`) |
| Lead-lag | `lib/edgedesk_lead_lag.js` (`window.EDLeadLag`) |
| Operator console | `admin/novig/index.html` |
| Tests | `tools/novig/*.test.js`, run by `.github/workflows/novig.yml` (category market-odds) |
| Deploy | `.github/workflows/deploy-novig.yml` (manual, tests first) |

---

## 1. What already existed (Phase 0)

- **The sportsbook path.** The Odds API is reached only through
  `supabase/functions/odds_gateway` (budget, breaker, ledger;
  `supabase/odds_api_gateway.sql`). DraftKings is one of the gateway's
  bookmakers. Every Pinnacle and DraftKings price the gateway buys is copied,
  append-only, into **`public.sharp_price_snapshots`** by the Sharp-lag
  pipeline (`supabase/sharp_lag.sql`): `event_id, book, market, side, point,
  price_dec, captured_at, book_last_update`. That tape is the DraftKings side
  of every comparison here; it is service-role only and stays so.
- **Paid retrieval is paused** by the emergency stop until The Odds API's
  credit reset (2026-11-01 00:00 UTC; `docs/odds-api-incident-2026-10/INCIDENT.md`).
  Until it resumes, DraftKings prices age into **Stale** and are shown as
  history, never compared as current (§5).
- **Events** are The Odds API's (`signals.event_id`, full team names in
  `home_team` / `away_team`). Teams resolve through `lib/football_identity.js`
  (NFL clubs, college alias groups), the same code Kalshi's links and the
  Collective's grading use.
- **The closest analog** is the Kalshi layer (`supabase/functions/kalshi_sync`,
  `supabase/kalshi_market_data.sql`): append-only snapshots, links matched on
  both teams and the date, frozen rules in a SQL function, a pg_cron poke with
  a Vault secret, a manual deploy workflow, and a guarded hook on the football
  cards. This integration follows it piece for piece.
- **Display gating precedent:** Sharp-lag's `sharp_lag_config.public_display`
  (off until a person has read the provider's terms; every change logged).
- **Odds math** lives in `lib/research_core.js`, `lib/edgedesk_calc.js` and,
  in exact decimals, `lib/edgedesk_fairodds.js` (EDFAIR). EDFAIR classes
  Novig as a commission exchange with an unknown rate; changing that would
  change the AI desk's EV answers, so it is left as it is (a follow-up), and
  the Novig-specific arithmetic lives in `lib/edgedesk_venue_compare.js`.
- **The football model's own published record** (`fbModelCard` in `app.html`)
  says it does not beat the close and that everything it shows is research.
  It is therefore research-tier for EV here (§6).

## 2. Novig, as documented (docs.novig.com, read 2026-10-30)

- **Hosts.** Production `https://api.novig.com`, paper (play money)
  `https://api.paper.novig.com`. A key works only in the environment where it
  was made ("api key not found" elsewhere). Rows are stamped with their
  environment, and only `novig_config.expected_environment` (production) is
  ever served to a reader.
- **Signing (NOVIG-V3).** `Novig-Key-Id`, `Novig-Timestamp` (ms, ±30 s),
  `Novig-Signature` (standard padded base64) over six LF-joined lines:
  `NOVIG-V3`, the timestamp, the method, the path, the canonical query, the
  lowercase hex SHA-256 of the raw body. Ed25519 or P-256 (DER). `GET /v3/time`
  is Novig's clock; `POST /v3/echo` proves host, key, clock and string at once.
- **Keys.** `management` (one, made on Profile; opens and funds subaccounts,
  makes keys), `management::read` (`POST /v3/keys`; reads everything, moves
  nothing), `trading` (made only with a subaccount), `trading::read`
  (`POST /v3/account/subaccounts/{keyId}/keys`; reads one subaccount and opens
  the websocket). **Any key reads the catalog and history; `GET /v3/ws` needs
  `trading` or `trading::read`.**
- **Money.** Prices are decimal strings on a 279-price grid; quantities are
  whole contracts; **one contract pays 1¢** ("110 contracts at 0.665 cost
  $0.73150 and pay $1.10000"); the ledger is to $0.00001, half up.
- **The book.** Every resting order is a bid. A bid at p on one outcome is
  liquidity for the other outcome at 1 − p, with that bid's quantity.
- **Fees.** Taker only: `c · P(1 − P) · N · 1¢` per fill, at the fill price,
  `c` from `market.fee.coefficient`; `WHEN_LIVE` charges only while the event
  is `OPEN_INGAME` (decided at match time), `ALWAYS` in every phase. Pregame
  game lines are therefore fee-free to a taker today.
- **Voids.** Every game line Novig listed on 2026-10-30 is `voids: FMV`: a
  void settles at fair market value, where a sportsbook refunds.
- **Location.** Every signed route runs an IP check and a key-holder device
  check (451). Novig warns that rotating hosted addresses (GitHub Actions,
  serverless platforms) meet `RESTRICTED_NETWORK_REGION` on and off, and that
  **repeated 451 retries can lock the account**. Unsigned `/v3/public/...`
  catalog reads exist; this integration does not route around a 451 with
  them (§9).
- **Limits.** Token buckets (`GET /v3/limits`; `read` refills at 16/s at the
  base tier), `429` with `Retry-After`, an edge `403` with an HTML body for
  some data-center addresses, default user agents and bursts.

## 3. Credentials

**Already in Edge Function secrets (not touched):** `NOVIG_MANAGEMENT_KEY_ID`,
`NOVIG_MANAGEMENT_PRIVATE_KEY`. They are never read by the ingestion function,
never revoked, never rotated, never printed.

**Least privilege.** The process that polls every five minutes holds a
`management::read` key, which can read the catalog and nothing that moves
money or places orders. The stream (off) would hold a `trading::read` key on
an *existing* subaccount. Neither is ever `trading`.

| Secret | Holder | What |
|---|---|---|
| `NOVIG_ENV` | `novig_sync`, stream worker | `production` or `paper` — the environment the management key belongs to, as `whoami` establishes it; never guessed |
| `NOVIG_READ_KEY_ID` / `NOVIG_READ_PRIVATE_KEY` | `novig_sync` | `management::read`, REST ingestion. The private key is the single-line base64 PKCS#8 body (a PEM or a `\n`-flattened PEM also works) |
| `NOVIG_STREAM_KEY_ID` / `NOVIG_STREAM_PRIVATE_KEY` | stream worker only | `trading::read` on an existing subaccount (optional) |
| `NOVIG_CRON_SECRET` (+ Vault `novig_cron_secret`) | `novig_sync`, pg_cron | the poke's shared secret |
| `NOVIG_INGEST_ENABLED` | `novig_sync` | `true` to run discover/snapshot (default off) |
| `NOVIG_BOOTSTRAP_SECRET` | `novig_key_bootstrap` | one-time, generated and unset inside one provisioning run |

**Provisioning (recommended): Actions → "Novig — provision read-only keys".**
It runs the tests, deploys the transient `novig_key_bootstrap` with a one-time
secret, asks it which environment the management key belongs to (it signs
`POST /v3/echo` on both hosts; the one that answers 200 is the environment,
and the key list and existing subaccounts are printed; when Novig answers but
accepts the key in neither environment — a 451 location refusal among them —
the run stops at once and is never retried), generates an Ed25519
keypair **on the runner**, sends only the public half, lets the management
key register it (`POST /v3/keys` → `management::read`), checks Novig's
fingerprint against the key it sent, sets `NOVIG_READ_KEY_ID`,
`NOVIG_READ_PRIVATE_KEY` and `NOVIG_ENV` with `supabase secrets set
--env-file` (functions read a new secret immediately — Supabase docs), shreds
the file, and — always, even on failure — deletes the bootstrap function and
unsets its secret. With `stream_subaccount_key_id` set to an existing
subaccount's trading key id, it does the same for a `trading::read` stream
key. It never opens a subaccount (that would mint a trading key) and refuses a
subaccount that does not already exist.

An Edge Function cannot write Edge Function secrets itself; the Supabase CLI
with the project's access token (already a repository secret,
`SUPABASE_ACCESS_TOKEN`) is the supported path, and that is what the workflow
uses.

**Manual fallback (only if the workflow cannot be used).** On a trusted
machine with the management key's PEM (the file Novig's Profile screen
downloaded) and Node 22:

```bash
openssl genpkey -algorithm ed25519 -out read.pem && openssl pkey -in read.pem -pubout -out read.pub.pem
```

Sign `POST /v3/keys` with the management key, body
`{"name":"edgedesk-ingest-read","publicKey":"<contents of read.pub.pem>","algorithm":"Ed25519"}`
(`lib/novig_signing.js` `signRequest` does the signing; or the curl recipe in
Novig's `api-reference/authentication/create-a-key`). Then set
`NOVIG_READ_KEY_ID` (the returned `keyId`), `NOVIG_READ_PRIVATE_KEY` (the
base64 lines of `read.pem` joined, without the BEGIN/END lines) and
`NOVIG_ENV` in Dashboard → Edge Functions → Secrets, and delete `read.pem`.

**Verify:** Actions → "Deploy Novig market data" with `first_run`, or POST
`{"mode":"probe"}` to `novig_sync` with the cron secret. The probe records the
clock offset, the echo, the throttle, the key holder's geolocation standing
and the key's scope (a full `management` key is flagged as over-privileged).

## 4. Coverage

| Novig league | Odds API sport key | Identity | Kickoff tolerance |
|---|---|---|---|
| NFL | `americanfootball_nfl` | club symbol AND name must agree (`lib/football_identity.js`) | 36 h |
| NCAAF | `americanfootball_ncaaf` | shared college alias groups (Ohio St. = Ohio State Buckeyes; Ohio ≠ Ohio State) | 36 h |
| NBA, NHL, MLB, NCAAB, WNBA, NCAABSB, NCAAWB | `basketball_nba`, `icehockey_nhl`, `baseball_mlb`, `basketball_ncaab`, `basketball_wnba`, `baseball_ncaa`, `basketball_wncaab` | exact full name only ("LA Clippers" is not guessed to be "Los Angeles Clippers") | 4 h (doubleheaders and back-to-backs are ambiguous, and refused) |

**Markets:** `MONEY`↔`h2h`, `SPREAD`↔`spreads`, `TOTAL`↔`totals`, and the
first-half twins (`MONEY_1H`↔`h2h_h1`, …). Player props, team totals,
three-way (regulation) markets and futures are **not mapped** (unsupported,
counted): props need verified participant mapping and Novig's new
participation-protected twins (`*_PROTECTED`, from 2026-10-29) settle
differently; futures need the simulator's settlement rules.

**What will actually compare:** only events that are in BOTH `public.signals`
and Novig's catalog, at lines DraftKings has quoted. Today the gateway
captures NFL, NCAAF and MLB (NBA and NHL are registered but disabled until the
owner turns them on after the credit reset), so those are the leagues with a
DraftKings side. Live Novig catalog on 2026-10-30 ~14:10 UTC (public catalog,
read-only): NFL 47 events / 1,289 game-line markets; NCAAF 116 / over 5,000;
NBA 18 / 835; NHL 4 / 47; NCAAB 1 / 28; MLB 2 / 10; WNBA 1 / 33; college
baseball 0.

## 5. Matching, freshness and the rules

**A link is made only when every one holds** (`lib/novig_market_map.js`):
same league and sport key; exactly one book event with both teams, the same
home and away (a swapped listing is refused — a spread's strike is the home
handicap), kickoff inside the tolerance; a supported market type; the same
period; the exact line; each outcome read from its own name and checked
against the strike (the home outcome carries the strike, the away outcome its
negation; Over and Under both carry it); the two outcomes are the two teams.
Anything else is queued in `public.novig_unmapped` with its reason (counted
again each run; resolved when it links or the reason stops applying).
**Confidence:** high when both teams are resolved by full name (and, in the
NFL, by symbol too), kickoff within 15 minutes and no settlement note can bite
an ordinary result; medium otherwise (an NFL moneyline is always medium: a tie
is undocumented at Novig). Every link records its constraints, notes, method,
linker version and verification time; a link is append-only, and one that no
longer holds on re-verification is invalidated with the reason.

**Settlement notes** travel with every comparison: Novig settles a void at
fair value (`FMV`) where a sportsbook refunds; whole-number lines push at
both; a first half excludes overtime at both. Prices compare for a completed
game.

**The rules** (`public.novig_rule()` = `EDVENUE.RULES`; a test fails if they
differ): Novig REST snapshot Recently updated ≤ 10 min, never "Live" (only a
streamed book ≤ 90 s is); DraftKings Live ≤ 10 min, Recently updated ≤ 90 min
(EDINTEL's quote TTL), then **Stale — historical, not a current price**; a
comparison needs both venues current; a research pair needs them within 10
minutes of each other; ties under 0.10 pp; a model probability older than
36 h is not current. Snapshot cadence: 5 min inside 2 h of kickoff, 10 min to
24 h, 30 min beyond; an unchanged book (ETag 304 or the same seq) is
**confirmed** (its observation time moves up) and not stored again.

## 6. The numbers (lib/edgedesk_venue_compare.js)

- **Executable price.** A stake buys whole contracts, all-in (price plus any
  taker fee), walking the other outcome's bids cheapest first; per-fill fees
  half up to $0.00001. FILLED, PARTIAL (the book ran out — the stake is "not
  fillable", never assumed filled) or NO_LIQUIDITY. VWAP, effective decimal /
  American / implied, slippage, and whether the top price is achievable at
  that size. Standard stakes $25, $50, $100, $250, $500 (stored with every
  snapshot) plus any custom stake (walked against the stored depth).
- **Implied probability:** +A → 100/(A+100); −A → |A|/(|A|+100); a contract →
  its price.
- **Hold:** sum of implied probabilities − 1, only for a complete set of
  mutually exclusive outcomes quoted together (generalised to n outcomes).
  Never "what a bettor is guaranteed to lose". Novig's sum of best asks − 1 is
  shown as an **exchange spread**, not a hold.
- **No-vig:** proportional normalisation, labelled an estimate.
- **Cost of the worse price** at stake S: (payout on a win at the better
  venue) − (payout at the worse one), at each venue's executable price for S
  (Novig's unspent remainder counted as returned).
- **EV** per $1 = p · net win per $1 − (1 − p − p_push), at each venue's
  executable price; ΔEV and dollars at the stake; states: positive at both,
  only at Novig, only at DraftKings, negative at both, insufficient data.
  **EV is stated only when the model probability passes the gate:** versioned,
  validated tier, frozen before the quote, not older than 36 h, for exactly
  this market (kind, period, line, side). Today no game-line model passes —
  the football model is research-tier by its own record — so the cards say
  why no EV is stated, and the EV graphic refuses to draw.

## 7. Storage and growth

`novig_book_snapshots` (append-only; unique on environment, market, source,
seq): the top of book and the standard stakes' fills, kept for the record.
`novig_book_depth`: the ladder behind each snapshot (≤ 10 levels), pruned
daily after 7 days except each market's last book before kickoff (its close).
Only comparable markets are snapshotted (moneylines; spreads/totals at a line
DraftKings has quoted in the last day, or Novig's consensus line), only when
due, only when changed. Snapshot and depth sizes, rows per day and the stale
share are on `novig_readiness` and the console.

## 8. Data rights (the public-display gate)

**What Novig's documentation says.** Novig documents an affiliate
integration ("Odds Screens: Display Novig prices on your platform using our
REST catalog and order book. Perfect for price comparison sites") inside its
affiliate program (apply at workwithnovig.com; affiliates@novig.co), and
publishes anonymized daily CSVs at data.novig.com. **Nothing found states the
terms under which Novig's prices may be displayed commercially, stored
historically, redistributed to subscribers, used in social graphics, or
branded with Novig's name or logo, or the polling scale permitted.** API
credentials are not that permission.

**Until written permission covering each of those is on record:**
- `novig_config.public_display = 'off'` (`NOVIG_PUBLIC_DISPLAY_ENABLED`): the
  database returns Novig prices to operators only; subscribers and anon read
  nothing (tested).
- `NOVIG_PUBLIC_DISPLAY_ENABLED = false` in
  `lib/edgedesk_market_compare_ui.js`: even with the database switch on, the
  card renders nothing for subscribers until this ships as `true` in a
  reviewed change. Both must be on.
- Graphics are drawn for operators only, watermarked **INTERNAL PREVIEW — NOT
  FOR DISTRIBUTION**. Nothing posts anywhere automatically. No Novig logo is
  used (the name is used as a source attribution).
- Ingestion is a separate switch (`NOVIG_INGEST_ENABLED`), so storage can wait
  for permission too if the owner prefers.

**To switch display on:** record who, when and the permission's reference:
`update public.novig_config set value = 'on', note = '<who, when, reference>'
where key = 'public_display';` (logged in `novig_config_log`), and ship the
code flag.

## 9. Streaming

A websocket must stay open for hours; a Supabase Edge Function lives 150 s
(Free) / 400 s (paid). `tools/novig/stream_worker.js` (Node 22, no package)
therefore runs only on a **persistent host with a fixed US address Novig
admits**, under a supervisor (systemd, a container restart policy), with
`NOVIG_STREAM_ENABLED=true`, a `trading::read` key, `NOVIG_ENV`,
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. It signs the upgrade,
subscribes the linked markets (under 512 tokens a request and the watch
limit), keeps each book exact (per-market, per-channel seq; gaps buffered,
resnapshotted and replayed; partial fills keep their queue position;
lifecycle; reconnect with jittered backoff; a geolocation close stops it and
halts the REST sync), and writes changed books every 15 s as `ws_book`
snapshots. Until it runs, the REST sync is the source and nothing is called
Live.

## 10. Operations

Deploy order: provision keys → Deploy Novig market data (`apply_sql`,
`set_cron_secret`, `enable_ingest=on`, `first_run`). The console
(`/admin/novig/`) shows readiness, the research summary, the unmapped queue
and the display switch.

**The deploy check (`verify`, on by default).** The repository is public, and
so are its Actions logs. Printing a Novig price there would be the
redistribution §8 forbids. `tools/novig/deploy_check.js` therefore prints
facts that are not prices, each `ok` or `CHECK THIS` (which fails the job):

- the ten tables, RLS, the policies and the grants, including that anon can
  read and execute nothing;
- every index the layer declares;
- the display switch (off) and the environment served (production);
- the four cron jobs and that the Vault secret exists;
- rows by environment, the links, the unmapped reasons, the newest runs, a
  halt in force, and the DraftKings tape's newest capture;
- what `novig_access()` and `novig_compare()` give a signed-in reader who is
  not an admin, and the owner's admin account.

With `report_key` (an RSA-3072+ public key, base64 SPKI DER), the admin's own
view — the `novig_compare()` rows, their history and the readiness row — is
added **sealed** to that key (RSA-OAEP-SHA256 + AES-256-GCM). The view goes
from psql straight into the seal and is never printed. Open it where the
private half is, with `node tools/novig/deploy_check.js open <key.pem> <
log.txt`. The whole check is one transaction that is rolled back.

| Alert | Meaning | Do |
|---|---|---|
| `geolocation_*` (451) | the request's network or the key holder's device was refused | network codes: run from a fixed US address; device codes: the key holder opens the Novig app in a permitted state. Runs halt 2 h / 6 h; never retried |
| `locked` (423) | account or exchange locked | contact Novig support; runs halt 6 h |
| `auth_failed` (401) | wrong key or environment, revoked key | check `NOVIG_ENV` and the key (probe); halt 1 h |
| `scope` (403 JSON) | the key cannot read this route | re-provision |
| `edge_blocked` (403 HTML) | Novig's edge refused the address/user agent/rate | halt 15 min; if persistent, change host |
| `rate_limited` | 429s met and waited out | lower `NOVIG_MAX_BOOKS_PER_RUN` / cadence |
| `unmapped_markets` | markets starting soon a book prices could not be matched | read `novig_unmapped` reasons; add an alias only where the identity module's rules allow |
| `clock_skew` | the host clock is off; requests are signed on Novig's time | none needed for signing; fix the host clock |

A failure in the Novig sync touches nothing else: it reads `signals` and the
DraftKings tape and writes only `novig_*` tables.

## 11. Models

No model, ranking, threshold, grade, frozen protocol or historical record is
changed. The comparison is a downstream reader: model probabilities go IN to
the EV gate, Novig prices never go into a model. `novig_compare()`,
`novig_history()` and `novig_price_gap_summary()` are the normalized,
timestamped interface (current DraftKings and Novig executable prices,
implied probabilities, hold, exchange cost, liquidity, movement) for any
research consumer.

**A possible challenger (documented, not built):** "does Novig's pregame
mid, as of a fixed time before kickoff, add information beyond EdgeDesk's
football projection for the close?" — preregistered under the existing model
governance (`engine/lab/protocol.js`), trained only on snapshots strictly
before each game's freeze, evaluated out-of-sample against the incumbent,
and never touching the incumbent until it wins under that protocol.

## 12. Known limitations

- Not deployed or authenticated yet (§Credentials). REST snapshots, not live.
- DraftKings prices are stale until The Odds API resumes (2026-11-01 reset);
  NBA/NHL have no DraftKings side until the owner enables them at the gateway.
- Only full-game and first-half moneylines, spreads and totals; no props or
  futures.
- An NFL moneyline tie and Novig's FMV voids are disclosed, not modelled.
- No validated game-line model probability exists, so no EV is stated.
- Lead-lag is limited by sampling: with hourly DraftKings captures most
  sequences are undetermined, and the study says so.
- The edge function's region may meet Novig's location checks; a fixed
  address may be needed (Novig's own guidance).
- `lib/edgedesk_fairodds.js` (the AI desk) still treats Novig as an exchange
  with an unknown commission; aligning it with Novig's published fee schedule
  is a separate change.
