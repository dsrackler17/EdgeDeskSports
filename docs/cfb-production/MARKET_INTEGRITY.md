# CFB market integrity

When a market number cannot be trusted, EdgeDesk does not bet on it. This page defines what "trusted"
means for a sportsbook quote, a consensus, an opener and a close, and where each rule is enforced.
Football numbers are never changed by any rule here: only whether a quote is used and whether a BET
may stand.

| rule version | what it covers | code |
|---|---|---|
| `cfb_market_quote_integrity_v1` | hard quote validity (§2) and wrong game (§3) | `football/cfb_lab/integrity.js` `validateQuote` |
| `cfb_market_outlier_v1` | outlier quarantine (§4) | `integrity.js` `screenQuote`, `crossMarket` |
| `cfb_market_consensus_integrity_v1` | consensus quality, true freshness, actionable status (§8) | `integrity.js` `assessMarket`, `betGate` |
| `cfb_source_freshness_v1` | freshness limits of every source (§8) | `integrity.js` `FRESHNESS`, `freshnessOf` |
| `cfb_extreme_review_v1` | extreme-disagreement / extreme-probability review (§9) | `integrity.js` `extremeReview` |
| `cfb_bet_volume_guard_v1` | BET-volume anomaly (§9) | `integrity.js` `betVolume` |

The Model Lab's own rule versions (`cfb_lab_quote_dedupe_v1`, `cfb_lab_open_v1`, `cfb_lab_close_v1`, ...,
docs/cfb-lab/METRICS.md) are unchanged. The integrity layer runs **before** them: a quote that fails is
never offered to de-duplication, openers, closes or any consensus.

## 1. One sign convention

- Home margin > 0: the home team is expected to win by that many.
- Home line < 0: the home team is favoured (book convention). `margin = -home_line`, converted once.
- A side's own number: HOME at `-3.5` lays 3.5; AWAY at `+3.5` receives 3.5.

`football/cfb_lab/sign_suite.test.js` checks this convention across every layer that touches a sign: lab_core,
the V2 engine, the decision engine, the ESPN reader, the Odds API capture and the event join. It covers home
favourite, road favourite, pick'em, neutral site, alternate spreads, prices, ATS and CLV. It also runs the
contract over every live row of `football/cfb_v2/current.json`. Run it at deployment. The pages that display
the numbers are held to the same convention by `football/cfb_lab/frontend_contract.test.js`.

**Rounding note.** `engine.js pure()` rounds `projected_margin` and `fair_spread_home_line` to 0.01
separately. At a half-cent boundary they differ by one cent: 6.825 gives 6.83 / -6.82. This is rounding, not
a sign, so contract checks use a 0.015 tolerance. `app.html`'s V2 panel guard and the sign suite both do.

## 2. Hard bounds: impossible quotes are REJECTED

| code | rule |
|---|---|
| `SPREAD_OUT_OF_BOUNDS` | \|home_line\| > 70 |
| `TOTAL_OUT_OF_BOUNDS` | total outside 20–100 (a total of 0 is a missing field read as zero) |
| `PRICE_ZERO` | American odds of 0 |
| `PRICE_NOT_AMERICAN` | 0 < \|price\| < 100 |
| `PRICE_OUT_OF_BOUNDS` | spread/total price beyond ±1000; moneyline beyond ±100000 |
| `PRICE_NOT_INTEGER` | a fractional American price |
| `IDENTICAL_SIDE_PRICES` | both sides the same price and the pair's implied sum > 1.30 (e.g. −300/−300) |
| `TWO_WAY_HOLD_TOO_HIGH` | implied sum > 1.30 |
| `TWO_WAY_BELOW_FAIR` | implied sum < 0.99 (one book paying both sides above fair) |
| `OBSERVED_IN_FUTURE` | observed more than 5 minutes after "now" |
| `PROVIDER_TS_AFTER_OBSERVED` | the provider's update time is more than 5 minutes after our observation |
| `PROVIDER_TS_UNPARSEABLE` | a provider timestamp that is present but not a time |
| `NON_NUMERIC_<FIELD>` | a value present but not a number. Null, `""` and text are never read as 0 |

**Why these bounds.** The bounds mark impossible values, not unusual ones. The raw cfbfastR multi-book
archive has 1,183,529 rows (2006–2025):
- Spreads: the largest legitimate spread is 67.5 (Savannah State @ Florida State, 2012). Eight junk values
  exceed 100 (up to 334).
- Totals: the values outside 20–100 are zeros and numbers above 200.
- Prices: 483 prices sit strictly inside (−100, +100).

A −58.5 line, the largest in the 2026 ledger, passes, and so does a −10000 moneyline.

**Three copies of these rules, pinned to one set of cases.** `football/cfb_lab/fixtures/integrity_rules.json`
(28 cases) must be reproduced exactly by:
- JavaScript: `integrity.validateQuote`;
- the capture function: `supabase/functions/capture/index.ts` `cfbQuoteProblems`;
- Postgres: `supabase/cfb_market_integrity.sql` `cfb_market_quote_problems`.

The three are tested by `integrity.test.js`, `providers.test.js` and `integrity_sql.test.js` respectively.

## 3. Wrong game (REJECT)

In the lab job (`market.screenCandidates`), with the game index and the identity master
(docs/cfb-production/IDENTITY.md):
- `WRONG_GAME_ORIENTATION`: the quote's home and away are the game's away and home.
- `WRONG_GAME_TEAMS`: either team resolves to a different team. "Miami" is never "Miami (OH)", and
  nothing is matched by substring.
- `WRONG_GAME_KICKOFF`: the quote's kickoff is more than 36 h from the game's. Only name-joined sources
  (Odds API) are checked this way. An ESPN or CFBD quote carries the game's own id, so a kickoff that
  differs means the index is stale: the game moved.
- A team name that does not resolve is a `TEAM_UNVERIFIED` warning, never a guessed match.

## 4. Outlier quarantine (QUARANTINE)

Each rule compares one candidate quote against the other books (peers: each other `(source, book)`'s latest
quote of the same game and market within 6 h) or against the same book's previous number:

| code | rule |
|---|---|
| `CROSS_BOOK_OUTLIER` | with ≥ 3 peers, \|x − median\| > max(3.5 pts spread / 5 pts total, 4 × 1.4826 × MAD) |
| `CROSS_BOOK_DISAGREEMENT` | with 1–2 peers, \|x − median\| > 7 pts (spread) / 10 pts (total) |
| `SIGN_FLIP_SUSPECT` | the same book moves from L to ≈ −L (\|L\| ≥ 2.5, a move of ≥ 5) and no peer is within 3 pts of the new number |
| `UNCORROBORATED_JUMP` | the same book moves ≥ 10 pts (spread) / 14 (total) within 48 h, with no peer within 3 pts |
| `CROSS_MARKET_ORIENTATION` | one book, one moment: the spread (\|line\| ≥ 3) and the moneyline name different favourites. Both quotes are quarantined |

A real move is not flagged:
- a 4-point QB-news move is not flagged;
- a flip that other books confirm is not flagged.

The first book to move on real news may be quarantined for an hour or two, until the others follow. That
is the intended trade: a missing number is better than a false one.

## 5. Quarantine storage: kept, never deleted

- Repository ledger: `football/cfb_lab/ledger/<season>/quarantine.jsonl`, append-only and verified by
  `ledger.js verify`.
  - Id: `'cfbz_' + h(quote_id, stage)`, so a replay is a no-op.
  - A row keeps the full quote, `severity`, `reasons`, `rule_version`, the evidence (peer median, MAD,
    previous line) and `detected_at`.
  - The same bad number re-observed within 6 h with the same reasons is not written again: one
    investigation, not 24.
- Postgres: `cfb_market_quote_quarantine` (append-only triggers; authenticated reads, anon nothing), with
  the same columns plus the raw payload. Rows are written by:
  - `cfb_market_quarantine_quotes(p_quotes)`, which the capture function calls fail-soft for the quotes
    its own copy of the rules refused;
  - `cfb_market_ingest_quotes(p_quotes)`, the checked ingest: bad quotes go to quarantine and the rest
    are forwarded unchanged to `cfb_lab_ingest_quotes`.
- The lab report raises one `market_quotes_quarantined` alert with the reason counts for the last 72 h.

## 6. Openers are write-once; corrections are separate

- Openers and closes are derived once (`market.lines`). `cfb_lab_market_lines` ids hash
  `(game, kind, book, market, rule_version)`, and a derived game is never derived again. A late quote with
  an earlier timestamp never replaces the opener (tested).
- A necessary correction goes through `market.correctLine(season, {line_id, home_line | total_points,
  reason, actor})`. It writes `ledger/<season>/market_corrections.jsonl` (Postgres:
  `cfb_market_line_corrections`) with:
  - `version`, the `original` and `corrected` values, the `reason` (≥ 10 characters) and the `actor`;
  - values bounded like any quote.

  The derived line is never edited. Grading keeps using the original. The correction is the "opener
  corrected version" for a person to act on through a governed rule change.

## 7. Closes: deterministic, never live

- **The close is anchored to the authoritative kickoff** (`market.authoritativeKickoffs`), never to the
  first snapshot's kickoff. In order:
  1. the kickoff ESPN reported when it settled the game (`results.sources[].kickoff_ts`);
  2. else the newest kickoff a LIVE snapshot was taken against.
- **It is derived only for a game with a settled state** (FINAL, POSTPONED, CANCELED, NO_CONTEST), at least
  3 h after that kickoff. The result is the evidence that the real kickoff has passed.
- **Kickoff delay** (19:30 → 22:30): the close window moves with it. The close is the last quote before
  22:30, not the stale 19:30 number.
- **Early start** (19:30 → 16:30): a quote observed after 16:30 is in-play, even if a provider still
  says 19:30. It never enters the close.
- **Provider delay:** quotes that sync late but before derivation count. A close, once derived, is final
  (deterministic).
- `lab_core.closeFrom` already refuses quotes at or after the kickoff it is given. Live odds are never read.

The Postgres parity function `cfb_lab_derive_lines()` (run by hand only) still anchors to
`cfb_lab_game_kickoff()` and does not wait for a result. Update it through a governed rule change before it
is ever scheduled.

## 8. Consensus integrity, freshness and the actionable status

`assessMarket(quotes, asOf, {kickoff})` looks at each `(source, book)`'s latest pregame spread quote before
`asOf` (provider averages are dropped when a real book is present). Its checks:
- **True age** = now − min(observed_at, provider_updated_at). A heartbeat of a book whose own
  `last_update` is 10 h old is stale.
- `INVALID` / `MARKET_INVALID`: a quote in the set fails §2 or is quarantined.
- `DEGRADED` / `MARKET_STALE`: the newest true age exceeds the odds limit (6 h within 48 h of kickoff,
  else 36 h: the lab's own METRICS §14 limits).
- `DEGRADED` / `MARKET_DEGRADED`, any one of:
  - fewer than 2 books;
  - more than 50% of books stale;
  - an unresolved range > 3 pts. With ≥ 3 books a MAD outlier is isolated first; it is itself never
    actionable, and the range is taken over the rest.
- `OK` but `MARKET_STALE` for betting: the newest quote is older than 3 h (the decision policy's and the
  engine's `stale_minutes` of 180).

**Where it acts:**
- Model Lab (`checkpoint.run`): every snapshot records `inputs_ref.market_integrity`. A BET is downgraded
  to PASS (fail closed) unless the actionable status is `ACTIONABLE` and any required extreme review
  passed (`inputs_ref.bet_gate`, `pass_reason`). LEAN, RESEARCH and PASS are never changed, and no
  football number, confidence or data-quality status is touched. With one book (the lab today), no BET
  can stand.
- Decision engine (`football/cfb_decision/decision.js`; the Python mirror in
  `football/cfb_v2/research/v2/decision/policy.py` pins the same behaviour):
  - an impossible quote is `PASS_MARKET_INVALID` and no number is computed from it;
  - age is the true age;
  - `decideGame` assesses the consensus when the caller did not. One book cannot carry a BET
    (`PASS_MARKET_DEGRADED`), and an isolated outlier is `PASS_MARKET_INVALID`;
  - the team join goes through the identity master.
- Freshness of every source the lab uses is in `last_run.json → freshness`.

## 9. Extreme reviews and the BET-volume guard

`extremeReview` runs when |model − market| ≥ 10 pts (the decision policy's `extreme_gap_pts`) or when the
cover probability is ≥ 0.60 (or ≤ 0.40). The 0.60 bound: in 3,633 walk-forward development decisions
(`cfb_decision_calibration_v1` evidence, `cover_buckets_decision`), no decision cover probability exceeded
0.60. It is a diagnostic trigger, not a cap. The review fails on any of:

| area | fails when |
|---|---|
| sign | the fair line is not −margin, the side is not where the gap points, or the market looks flipped |
| mapping | home = away, or the quote belongs to another game or team |
| QB | certainty < 70 |
| injuries | certainty < 60 |
| features | older than 8 days |
| market | the quote is ≥ 60 min old, or the consensus is not OK |
| artifact | the params hash or the model version is not the expected one |

A failed review turns a BET into PASS. In `decision.js` the extreme-probability diagnostic runs the same
player-status and freshness checks and adds nothing when they pass.

**BET-volume guard.** Each model's official BET count in its latest week is compared with its earlier weeks.
It is flagged when it exceeds max(10, 3 × the history median), or 20 with fewer than 3 weeks of history. The
flag is the `bet_volume_anomaly` alert and the Postgres view `cfb_market_bet_volume`. It asks for review and
never cancels a bet.

## 10. Duplicate quotes

Unchanged quotes are dropped by the lab's `cfb_lab_quote_dedupe_v1`, with 6 h and close-zone heartbeats so
opening and closing reconstruction stays possible. Running the same hour twice or three times writes
byte-identical files (`chaos.test.js`).

## Tests

- `football/cfb_lab/integrity.test.js` (82): rules, wrong game, outliers, consensus, freshness, settlement
  validity, extreme review, BET gate, BET volume, identity.
- `football/cfb_lab/chaos.test.js` (50): capture with impossible values and schema drift, duplicate cron
  runs, delays, early starts, write-once openers, corrections, schedule authority, fail-closed BET,
  settlement, report alerts, freshness.
- `football/cfb_lab/sign_suite.test.js` (67), `football/cfb_lab/frontend_contract.test.js` (30).
- `football/cfb_decision/integrity_gates.test.js` (23).
- `football/cfb_lab/integrity_sql.test.js` (52, real Postgres).
