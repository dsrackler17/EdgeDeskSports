# Changelog

## 2026-10-04 — CFB champion: re-centring no longer moves the "no ties" hole or the key numbers

- **The defect.** A college game cannot end level, so every row of the champion's `margin_pmf_by_spread` holds no mass at margin 0. `football/cfb_p4/engine.js` `coverProbSpread` and `lib/edgedesk_quote_ev.js` `cfbConditionedCover` re-centred a row by shifting it a whole number of points. The hole and the 3 / 7 / 10 / 14 spikes moved with it.
  - UConn @ Temple (fair +6.2, row 3.0, shift +3) had no push at Temple −3, so quote EV flagged `INTEGER_PUSH_MISSING` and the engine refused the price as CORRUPTED ODDS. Meanwhile a tie carried 6% of the mass.
  - Across the 2015–2026 calibration rows (closes, openers and ±3 / ±7 alternates), 423 of 12,043 whole-number lines had no push (96 of them at ±3), and 374 of 411 pick'ems carried tie mass.
- **The fix** (`cfbRecentre`, byte-identical in both files). The row is reweighted in place by exp(θ·margin), with θ solved so the mean lands exactly on the fair margin. Every margin keeps its own entry.
  - The reweighting reaches one standard deviation of the row, and no further than the table's row means span. Past that, the rest of the move is a mixture of two whole-point moves (as `football/engine.js` does past its table). Margin 0 is held at zero throughout.
  - A college pick'em (line 0) with no push is no longer a "missing push".
- **What moved.** The fair spread, win probability, sigma and ratings are unchanged. Cover and push probabilities move:
  - Raw cover at the 2022–2025 closes moves 1.8 pp on average (p99 6.5 pp). The model's side gives back 0.3–0.9 pp, most at 5–12-point gaps.
  - Mean push at integer lines goes from 2.4% to 3.2% (observed 4.9%). At 3 it goes from 2.6% to 6.2%, at 7 from 2.4% to 5.3%.
  - Raw cover log loss improves on every window (OOS close 0.7340 → 0.7313).
  - The PMF now predicts pushes better than a normal shortcut (push log loss 0.192 vs 0.203). Before, it was worse (0.237).
- **Re-validation.** The calibration rows were re-derived from their own inputs (`football/cfb_ev/dataset.js --rederive`) and the tournament re-run. It promoted the same methods: close temperature, T = 10⁶ (unchanged); open temperature, T 40.89 → 36.81; moneyline identity.
  - The new hash is recorded as a PATCH in `football/cfb_ev/versions.jsonl`, so the next-100 count continues. The pricing path's PATCH is `edgedesk_cfb_r1+p5`.
  - Disclosed in PREREG.md, post-registration change 3.
- **Two consequences to know.**
  - The calibration anchor (`lib/edgedesk_ev.js` `shiftedHome`, frozen) still carries the curve to the calibrated probability by a location move, which displaces the spikes the raw curve now keeps. The alternate-line audit's +3 slope fell below the 0.6–1.6 band, so the validated alternate domain goes from ±3 to 0.
  - Three games on today's board drop below the flat 25% raw-EV bound and leave INVESTIGATE (two to WORTH RESEARCHING, one to MARKET FAULT).
- **The temporary hold is gone.** `tools/bettor/football_decision.test.js` no longer lets the shifted-hole signature (`tieHoleHold`) through. Its self-check idea is kept in the new regression.
- **Tests.** Every suite runs green with these checks added:
  - no stored curve gives a tie any mass, and every whole-number line on the board carries a push (`tools/bettor/football_decision.test.js`, with a self-check that catches the old shifted hole);
  - the key numbers stay on 3 and 7 (`football/cfb_p4/tests.js`);
  - the mean is exact, and the two functions agree to the bit (`tools/football/quote_ev.test.js`).

## 2026-10-04 — the landing page sells research plus your own betting analytics

The public page now answers, in five seconds: EdgeDesk is football research plus personal betting analytics, it helps you see whether your process is working, it costs $49.99 a month, and it sells no picks.

- **The hero** reads "Research, not picks. / Bet with a process. Know what's working." It has one sentence, the trial as the primary button, "See how it works" beside it, the offer under both, and who it is for.
  - Beside it, a sample week (P&L, ROI, process grade, open positions, what's working, what to watch, next focus). It is labelled **In development** and **Sample data** in its own bar, before any number.
- **The narrative** follows the decision:
  - results vs process: two illustrative tickets whose arithmetic the tests check;
  - the loop: Research → Track → Measure → Learn → Improve, each step marked Live or In development;
  - Process Coach and the Weekly Film Room, on sample data;
  - history: a sample calendar, and the journal that is live today;
  - beginner to advanced;
  - the research terminal, still the one block with live data;
  - value and pricing, trust, FAQ, and the close.
- **Nothing unfinished is sold as live.**
  - Process Coach, the Weekly Film Room, the calendar view, per-bet grades, prediction-market tracking and account connections are labelled wherever they appear.
  - No sportsbook or exchange is shown as connected.
  - The FAQ answers "Can I connect my account?" with "Not yet."
  - There is no social proof beyond Stadium Rant's real, exactly worded credit.
- **The plan card lists only live features:** eight lines (`lib/edgedesk_pricing.js` `FEATURES`, which the terminal's paywall also prints), down from twelve. The trial terms are the billing system's: a card, 7 days, charged on day 8.
- **One call to action**, "Start free trial", in the nav, hero, pricing, close and a phone-only sticky bar.
  - The bar appears once the hero's button scrolls away.
  - It steps aside at pricing, at the close and under a dialog.
  - It never shows for an account that already has access.
- **Hero copy is ready for a test, without a test framework.**
  - `HERO_COPY` holds variants a, b and c; the markup is variant a.
  - `?hero=b` previews a variant. No visitor is assigned at random.
  - Every GA event carries `hero_variant`.
- **Analytics:**
  - New GA events: `hero_cta_click`, `how_it_works_click`, `process_coach_view`, `pricing_cta_click`, `signup_started`, `signup_completed`, `checkout_started` and `trial_started`.
  - The legacy names `hero_trial_click`, `pricing_trial_click` and `hero_how_click` are still sent beside them.
  - The first-party funnel is unchanged and still runs visitor → `cta_clicked` → `signup_started` → `checkout_started` → `trial_started` → `subscription_started`. Its click and landing events now carry the hero variant.
- **Removed:** the live board grid, the prop table, the workflow card, the price example, the six-card feature grid and the who-it's-for strip. The live research preview and its statistics moved to the research section. `#how`, `#today`, `#record`, `#pricing` and `#subscribe` all still land.
- **Preserved unchanged:** auth, the renewal-terms consent, Stripe checkout and its return, attribution and partner credit, the comp check and the public-record panel. The one exception is the hero-button wiring for signed-in accounts.
- **Tests:**
  - `landing_positioning.test.js` (456) now checks the new positioning and the unfinished-feature labelling.
  - `landing_interaction.test.js` (201) now covers the sticky bar, the hero config and the GA events.
  - `tools/home/landing.e2e.js` (210, browser) covers 6 widths, the 375×548 first screen, the funnel and GA, the sticky bar, variants, and the live, stale, midweek and down data states.

## 2026-10-03 — share the Record: an image and a post for X or anywhere

- **A Share button on the Record**, on the public page and the app. It shares the view on screen: the tab (All, CFB, NFL, Player Props), the period, the market and the stake basis.
- **The card** (`lib/edgedesk_record_card.js`) comes in three sizes: X post 1600×900, square 1080×1080 and story 1080×1920. It shows:
  - the units at the graded price, the ROI and the record;
  - each market's units;
  - the sample size.
  - It also says how the units were priced ("at the closing price · not Verified P&L"), prints Verified P&L beside them, and carries "21+".
  - It computes nothing: every number is one the page already printed, from the same kernel.
- **The actions:**
  - **Share…** opens the phone's share sheet with the image attached (X, Messages, Instagram).
  - **Download image** saves the PNG.
  - **Post on X** opens a post with the text and link.
  - **Copy text** and **Copy link** copy each one.
  - The post stays under 280 characters, counting the link as 23 the way X does.
- **The link opens the same view:** `record.html?view=nfl#pnl`.
- **Tests:**
  - `tools/record/record_card.test.js` (72, now in *Record P&L tests* and `npm run record:pnl:test`): what the card says, the post's length, and that every size keeps every word in the frame, with the boxes above the notes and the notes above the footer.
  - `pnl_ui.test.js`: the dialog and its focus, every size drawn, Download, Escape and an outside tap, and the `?view=` link.

## 2026-10-03 — NFL and CFB tabs show P&L, not just the record

After the props were split out, the NFL tab showed only its record (58-38-2): none of its 98 game picks had a verified price. EdgeDesk stored no NFL game quote before 2026-10-03.

- **P&L at the graded price.** Every graded pick is priced at the line it was graded at, so the units and the record describe the same picks (`lib/edgedesk_pnl.js` `gradedPnl`).
  - The model's game picks are graded against the closing line, so they are priced at that line's closing price: nflverse consensus for the NFL, the ESPN book (DraftKings) for college.
  - Player props keep the price captured with the pick.
  - A pick with no closing price (40 CFB moneylines) is left out and counted, never assumed.
- **The ledger now carries that closing price** (`tools/record/pnl_core.js`). Each model pick's `closing_odds` is the side's price that the model record already keeps with the closing line (`grade.pnl`, `pricePick`).
  - Filling a price that was empty is not logged as a correction, in the build or the database.
  - It never makes a pick verified.
- **The page:**
  - Each tab shows its units with its record under them.
  - A new *P&L at the graded price* card sits above Verified P&L, labeled as not Verified P&L.
  - NFL and CFB history rows read e.g. "+124 close · +1.24u not verified".
  - *How P&L works* explains the difference.
- **On the 2026 ledger** (flat 1u):

  | Tab | P&L | Picks | Record |
  |---|---|---|---|
  | NFL | +7.87u (+8.2% ROI) | 98 | 58-38-2 |
  | CFB | −38.49u (−6.4%) | 600 of 640 | |
  | Player Props | −7.17u | 24 | |
  | All | −37.79u | | |

  - NFL by market: spread +7.04u, totals −1.49u, moneyline +2.32u.
- **Verified P&L is unchanged.** It is still only a price EdgeDesk captured at or before the decision: 31 priced, −4.96u flat.
- `record/pnl/` picks up the closing prices on the next *Record P&L* run.
- **Tests:**
  - `pnl.test.js` 183;
  - `pnl_ledger.test.js` 104: every model pick's closing price equals the record's `grade.pnl`; NFL and CFB units equal the record's own closing-price units; no correction logged;
  - `pnl_ui.test.js` 497 on the rebuilt ledger, 493 on the committed one. They cover the tab units and record, the new card, the history rows and the real NFL tab.

## 2026-10-03 — the Record's NFL tab no longer counts the player props

On the Record page the NFL tab, the Player Props tab and All all read −7.17u. The 24 settled priced bets were all NFL player props, and each prop was counted twice: once under NFL, because that tab took every row with `league = 'NFL'`, and again under Player Props. The CFB tab had the same flaw for college props (all leans so far, so it hid behind the leans toggle).

- **The tabs now partition the ledger** (`lib/edgedesk_pnl.js` `SCOPES`). NFL and CFB are that league's game markets only: spread, total and moneyline. Player Props holds every prop, NFL or college. All = CFB + NFL + Player Props, and each row is in exactly one.
  - On the committed 2026 ledger at flat 1u: All −4.96u = CFB +2.21u (7 priced) + NFL 58-38-2 (98 graded, none priced yet) + Player Props −7.17u (24 priced, 160 pending).
  - The NFL ledger lists 0 verified, 98 history and 0 pending. Before, it showed 24 / 122 / 160, with the props mixed in.
- **By sport** (the record card on All, *Where the record comes from*, and Advanced, which was *By league*) now reads NFL, College Football and Player Props. A prop is no longer inside its league's row.
- **The market filter** offers only the markets a tab holds. Moving to NFL or CFB while *Player props* is selected resets the filter to *All markets*, so the view is never empty. The Verified P&L card on NFL / CFB no longer shows an empty Player Props cell.
- **The database copy agrees:** `model_pnl_bets` (`supabase/model_pnl_analytics.sql`) uses the same scopes. `record/pnl/summary.json` picks up the new precomputed views on the next *Record P&L* run.
- **Tests:**
  - `pnl.test.js` 177 (the partition and by sport);
  - `pnl_ledger.test.js` 99 (NFL + CFB + props = All, in both strategies);
  - `pnl_sql.test.js` 206 (SQL scopes equal the kernel). It also loads the stored quotes that the committed ledger's locked prices cite, as the sync does. Since the 2026-10-03 rebuild priced 7 CFB picks from stored quotes, the suite had failed 3 checks on `main` (`snapshot_quote_missing: 7`). The quotes were all there; the test never loaded them;
  - `pnl_ui.test.js` 466: no tab's ledger lists the other's rows, and the college prop leans are checked on Player Props now instead of CFB.

## 2026-10-03 — two checks that went red on the live slates

Decision quality, Personal research CI and CFB research terminal failed on `main` itself, on every open PR. Two tests read the committed live slates, and those slates moved:

- **`tools/bettor/football_decision.test.js`** required PIT @ CLE to be held at the market line. That game kicked off on 2026-10-02 and left the NFL slate, so the check could not find it.
  - It now checks the audit games still on the slate: LA @ PHI is still held.
  - The rule itself is still checked on every slate game.
- **`football/cfb_terminal/read.test.js`** proves an LLM's invented probability is refused, using a fixed "71.3% to cover". This week's selected read carries a 71.4% win probability, so 71.3% is a fact within the audit's tolerance, and was rightly accepted.
  - The test now picks a percentage the facts do not hold: 72.4% on today's slate.

## 2026-10-03 — Verified P&L audited against production; the disconnects fixed

The audit traced a spread, a total, a moneyline and a player prop from the decision to the page (`docs/pnl/AUDIT.md`), and checked production's run logs.

- **Production had no `model_pnl` at all.** Every *Record P&L* run since the table was written called `model_pnl_upsert`, got `PGRST202` (no such function), and went green: the sync caught the error and exited 0, so not even the step's warning fired.
  - `tools/record/pnl_sync.js` now never fails quietly. A missing schema exits 3 and a database that disagrees with the page exits 4, each with an error annotation and a run-summary line. The step is `continue-on-error`: the page is already published and never waits on the database, but the run shows the failure.
  - After every sync it proves the database says what the page says: `verified_pnl_summary()` against the kernel's card over the same ledger (both strategies), and `verified_pnl_integrity()` at 0.
  - **Deploy Record P&L schema** (`.github/workflows/deploy-record-pnl.yml`, manual) tests the SQL on a throwaway PostgreSQL, applies the six files in order with `ON_ERROR_STOP`, syncs and prints the A–I report.
- **A locked price now resolves to a database row.** `supabase/model_pnl_quotes.sql` adds `model_pnl_quotes`, the stored quote every locked price cites, copied once by the sync and append-only. The integrity checks compare every snapshot price with its quote: same game, market, number, time and price. Where production's `cfb_lab_market_quotes` mirror exists, they compare with that independent copy too.
- **Old model decisions cannot be priced, and now say why.** The model record never stored a price before its numbers. The lab's quotes start 2026-09-27T15:07Z and cover its 71 games only. Nothing stored a timestamped NFL game price. 723 of the 731 record-only decisions now read `before_capture`; the other 8 read `line_moved`.
- **From now on every model game gets a stored price.** `tools/record/quote_ledger.js`: every hourly *Football model record* run keeps every priced pregame ESPN reading of every NFL and college game the model prices, in `record/football/quotes/<sport>_<season>.jsonl`.
  - The rows are append-only and use the lab's write-on-change and heartbeat rule; nothing is kept at or after kickoff.
  - NFL games are matched through nflverse's own ESPN id.
  - The price lock reads this ledger beside the lab's. `summary.json` `verified.price_sources` and *How P&L works* say where each league's stored prices begin.
- **The BET decisions' own mirror** was refusing every WATCH / LEAN decision. Production runs the 2026-09-28 18:28 `bettor_decisions.sql`, whose check predates them (23514 on `bds_0b368e37`), and the log called it "skipped". The schema deploy can re-apply the current file (`apply_bettor_decisions`), which accepts all 706 ledger rows. `cfb-lab.yml` now says what the error means.
- **Tests:**
  - `tools/record/quote_ledger.test.js` (19, end to end on the committed slates);
  - `verified_pnl.test.js` 76;
  - `pnl_sql.test.js` 200 (the evidence table, the cross-checks, the sync's parity);
  - `pnl_ui.test.js` 457.

## 2026-10-03 — Verified P&L: no price, no verified P&L

The Records page's Verified P&L said there were no priced bets. In fact two things were true. The P&L counted only `BET` rows. And the 738 graded model decisions (CFB 385-253-2, NFL) had no price at all: the model record never captured one, and its only stored prices were closing prices.

- **The rule.** A decision is in Verified P&L only when it settled (W / L / P) at a valid American price EdgeDesk captured **at or before** the decision, with a stake. Everything else stays in the record as **record only**, with one `pnl_exclusion_reason`.
  - Verified P&L now covers the graded record's own decisions: the model's published numbers and the BETs. So graded = verified + record only, always.
  - A price captured after its decision is `PRICE_AFTER_DECISION`: never units.
- **The price lock** (`tools/record/price_lock.js`). Every *Football model record* run freezes on each pick the market as EdgeDesk's **stored** quotes saw it when the number was published. Today that is the CFB Model Lab's hourly ESPN / DraftKings quotes.
  - It never uses a later quote, the close, today's odds, a provider average or −110.
  - A graded side is priced only when the stored quote was for the exact number it was graded at.
  - A lock is never rewritten. The ledger merge and the `model_pnl` trigger allow exactly one transition, from no price to a price.
- **The backfill** is the same lookup over picks already recorded. It is idempotent; run twice, it locks nothing new.
  - It locked **7 of the 640 graded CFB model decisions**.
  - 625 had no stored quote, because the lab's quotes start 2026-09-27.
  - 8 had a stored quote for another number than the one graded.
  - The 98 NFL decisions stay record only: the nflverse line is a reference, not a price.
- **Stakes.** The decision's own stake is used when it recorded one (`stake_source: explicit`). A model number priced by its lock risks the configurable default 1.00u (`stake_source: default`, `tools/record/pnl_config.json`).
- **Precision.** Profit is now stored to 6 places (a −110 win is +0.909091u), in the kernel and in `edp_pnl_profit`.
- **Database.** `supabase/model_pnl_verified.sql` adds the verification columns, constraints and the one-time lock. `supabase/model_pnl_verified_views.sql` adds:
  - `verified_pnl_decisions`;
  - `verified_pnl_summary`, `verified_pnl_breakdown` (sport / league / market / date / week / month) and `verified_pnl_series`;
  - `verified_pnl_integrity`.

  `supabase/verified_pnl_report.sql` is the read-only verification.
- **The page** (`lib/edgedesk_pnl_ui.js`):
  - **Model performance** leads.
  - A **Verified P&L** card sits under it: net units, ROI, priced decisions, *N of M graded decisions included · K record-only excluded*, units risked, Spreads / Totals / Moneylines / Player Props, and a chart of verified decisions only.
  - Each history row shows `price · stake risked · units`, or *Record only · Price unavailable*.
  - A market filter is added.
  - The card draws from the precomputed summary before the rows file loads.
- **Today:** 762 graded = 31 verified + 731 record only. Verified P&L is +0.42u on 13.00u risked (ROI +3.21%), with 0 integrity errors.
- **Tests:**
  - `tools/record/verified_pnl.test.js` (67 checks: the spec's 10 cases, its 3-bet example, the lock, the backfill, the audit);
  - `pnl_sql.test.js` (172, against a real PostgreSQL);
  - `pnl_ui.test.js` (456, Chromium at 375–1440 px).

## 2026-10-02 — a partial NFL replay no longer regrades the staking modes

The follow-up from the entry below. `tools/intelligence/validate_staking.js` grades the NFL markets on the same engine replay (`validate_pricing.js` `replayNfl`). On the nightly run that could not fetch 2016, it wrote `staking_nfl.json` from 2,642 engine rows instead of 2,658, with 2016 missing from `seasons_loaded`. The staking kernel reads the MODE that file writes, and refuses to stake a SHADOW market.

- **Guard**: with `--write`, a sport whose engine replay loaded some team-week seasons but not all of `replay_from`–`last` is refused.
  - Its file is not written, and the committed one stands.
  - The other sport is still written, and the run exits 3. The learning loop runs it under `continue-on-error`.
- **Unchanged**: with no season cached at all, the replay is not partial. The Elo stand-in is still written, as documented, and labels itself (`engine.available: false`).
- **Checked**:
  - Full cache: written, content identical to the committed file.
  - 2016 removed: NFL refused with exit 3, `staking_nfl.json` byte-identical, `staking_cfb.json` written.
  - No cache: the Elo stand-in is written with exit 0, as before.

## 2026-10-02 — a partial NFL replay no longer reprices the board

`main` went red at `a41195e` (learning loop, 15:56Z). Three checks failed on the same two assertions in `tools/bettor/football_decision.test.js`: Decision quality, Personal research CI and CFB research terminal. The board no longer matched the slate pricing kernel's fair line, off by 0.02 to 0.08 pts on 13 games, and PIT @ CLE was held without crossing.

- **Cause**: `stats_team_week_2016.csv` failed to download on the nightly runner. `validate_pricing.js` logged "the season is skipped in the replay" and wrote the refit anyway.
  - 2016 dropped out of `seasons_loaded`, and 236 fewer games were absorbed (4,889 to 4,653).
  - The NFL blend refit without it: the 2019 holdout tuned on 706 games instead of 722. `latest_coef` moved from −0.3811 + 1.1565×market + 0.2320×(projection − market) to −0.3664 + 1.1551×market + 0.2411×(projection − market).
  - The board reads these coefficients live. `football/nfl/slate.json` was still priced on the complete 2026-09-16 validation.
- **Data**: `football/validation/pricing_nfl.json` and `feature-status-nfl.json` are restored to their pre-loop bytes.
  - Re-running `validate_pricing.js` with all 20 seasons cached reproduces them exactly, apart from `generated_at`: model MAE 10.382, c = 0.232, `unchanged` on a second run. The slate needs no reprice.
  - `staking_nfl.json` was regenerated with `validate_staking.js --write` from the same full cache. It keeps the loop's one new archive game (7,325) and restores the 16 2016 engine rows (2,658 joined).
  - `--reprice` on the partial refit was tried and rejected. It fixes the two assertions, but on coefficients fitted without a season PIT @ CLE's blend lands 0.03 pts short of the market line, so the audit check fails instead.
- **Guard** (`tools/football/validate_pricing.js`): if a replay season's team-week file is still missing after the fetch, the NFL validation refuses, exits 3 and writes nothing, so the last complete validation stands. This covers `pricing_nfl.json` and `feature-status-nfl.json`.
  - Both callers (learning loop and weekly build) run it under `continue-on-error`.
  - Checked with 2016 removed from the cache: exit 3, both files byte-identical. With the full cache: `unchanged`.

## 2026-10-02 — the app's CFB ladder is the terminal's curve, whatever the market

The entry below fixed the terminal. Two readers still fell back to the engine's per-line lookup (`EDCfbP4.dist.coverProbSpread`) whenever `cfbConditionedCover` refused a market outside the ±45 table, or there was no market: `app.html` `fbQevModelCfb` (the alternate ladder and the EV-by-spread chart) and `tools/football/ev_plausibility.js` `coverFor`. So the app priced McNeese @ LSU (LSU −52.5) on a curve that rose with the line (P(M > 18) 0.9270, P(M > 18.5) 0.9309 at fair +41.42, σ 14.9), while its comment said it read the terminal's distribution.

- **One shared row** (`lib/edgedesk_quote_ev.js`):
  - `cfbPmfRow(distributions, fair, marketMargin)` is the market margin clamped to `pmf_spread_range`, or the fair margin clamped the same way when there is no market. `cfbGameCover` reads `cfbConditionedCover` at that row.
  - `cfbConditionedCover` itself is unchanged and still byte-identical to the pre-move function.
  - `football/cfb_terminal/build.js` `v1PmfRow` now calls `cfbPmfRow`. The terminal build is unchanged: `cfb:terminal:check` passes with no new snapshot.
- **The app** (`app.html` `fbQevModelCfb`):
  - `mk.spread_line` is already a home margin (home −52.5 → +52.5, `fbMarketFromEvent`), the same variable as the terminal's `_consMargin`, so it is clamped as is.
  - A market dropped for its orientation (`spread_fault`) counts as no market, as before, and so reads the fair margin.
  - The basis says when the shape was read at the table's edge or at the fair margin. The engine's per-line call remains only for a params file with no table.
  - `app.html` loads `lib/edgedesk_quote_ev.js?v=20261002a`. Both of its loads of the module carried no version before.
- **The EV plausibility bound** (`tools/football/ev_plausibility.js`) measures z in the width of the same curve. `football/validation/ev_plausibility.json` was regenerated with the tool from fresh cfbfastR-data and nflverse caches. The old code reproduces the committed file exactly from those caches, so every change below comes from this fix:
  - Affected CFB rows: 6 of 2,249 fit closes and 5 of 1,602 holdout closes lie past ±45, plus 22 synthetic off-by-7 lines.
  - z* is unchanged (CFB 0.9601), so `PLAUSIBLE_Z` is unchanged. NFL is unchanged.
  - Fit q99 moved from 0.8737 to 0.8785.
  - Holdout off-by-7 lines caught by the new bound rose from 7.18% to 7.37% (13.17% to 13.36% with the rest of the integrity stack).
  - The old flat 25% rule now flags 19.66% of real games (was 19.73%), and catches 98.56% of off-by-7 lines (was 98.63%).
- **Tests**:
  - `tools/football/quote_ev.test.js` §15 lifts `fbQevModelCfb` from `app.html` verbatim. At an out-of-table market, its mirror, the edge, an in-range market, no market and a faulted market, it must equal `v1Dist(...).cover` at every half point from −70 to +100, never rise, and price both sides of the ladder the same. `ev_plausibility.js` must measure the same width. Against the old `app.html` it fails 9 checks.
  - `tools/football/quote_ev_ui.e2e.js` reads McNeese @ LSU off the rendered board, priced against its captured LSU −52.5. Its curve must equal the terminal's at the fair margin, σ and market the page used, and never rise. Against the old `app.html` it fails 3 checks.

## 2026-10-02 — every CFB curve is one distribution, whatever the market

The two follow-ups from the entry below are closed. 47 of 115 stored CFB curves were incoherent: P(margin > t) rose with t. These were McNeese @ LSU (LSU −52.5, past the ±45 margin PMF table) and the 46 games with no market yet. All of them were built from the engine's per-line lookup (`football/cfb_p4/engine.js` `coverProbSpread`), which keys the table by whichever line it is asked about. Sampled at every half point, it stitched a different shape onto each threshold. Past ±45 it also switched to the pooled residual, which is neither shifted onto whole points nor stretched. McNeese @ LSU read 0.9457 at 17.5, 0.9270 at 18 and 0.9309 at 18.5.

- **One table row for the whole curve** (`football/cfb_terminal/build.js` `v1Dist`):
  - A market outside the table now reads the table's nearest edge: the market margin clamped to `pmf_spread_range`. That row is the kernel-weighted shape of the most lopsided spreads on file. Markets at 45 and 45.5 read the same row, so the curve does not jump at the edge.
  - With no market, the shape is conditioned on EdgeDesk's own fair margin, clamped the same way. `decisions.js` conditions its closing distribution on its centre in the same way.
  - Either way `EDQuoteEV.cfbConditionedCover` builds the curve exactly as it builds an in-range market's. It is re-centred by a whole-point shift and stretched to the game's σ, so every curve is monotone and lives on whole-point margins. `cfbConditionedCover` itself is unchanged and still byte-identical to the pre-move function.
  - The pooled residual re-centred on the fair margin was the other candidate, and was rejected. It is the shape of all games, mostly close ones, and it jumps at the table's edge.
  - A curve now names the row it read. The basis text says when that row is the table's edge or the fair margin, and `v1Dist` returns `pmf_row`. `conditioned_on_market_margin` stays the market itself, or null with none.
- **What changed and what did not**:
  - The 68 curves conditioned on an in-range market are byte-identical.
  - At an out-of-range market line the curve no longer equals the engine's own `coverProbSpread`, which there is the pooled residual. P(LSU covers −52.5) was 0.2193 and is now 0.2437 (σ 14.84).
  - McNeese @ LSU is no longer held at MALFORMED PROJECTION:
    - Replayed with its captured prices, and in a build at 13:00Z while its market was fresh, the bettor decision is PASS (EVALUABLE).
    - At 16:34Z its last quote (12:07Z) is stale, so it reads NO DECISION for STALE_QUOTE alone.
    - The EV read stays INVESTIGATE: an 11-point gap to the market is past the implausible-EV bound, as it was before.
  - The committed calibration dataset (`football/cfb_ev/data/cfb_ev_calibration_rows_v1`) is left as frozen. 74 of its 27,870 rows (|market| > 45, all with `pmf_conditioned` 0) would now read a different raw cover: median |Δ| 0.039, max 0.096, including 9 of the 3,120 OOS close rows. `tournament.js --check` still reproduces `calibration.json` exactly. A dataset rebuild would pick up the new rows.
- **Tests**:
  - `football/cfb_terminal/read.test.js` §2b pins the McNeese @ LSU curve, its mirror, the table edge and three no-market curves. Each must be one coherent distribution: never rising, no mass at a half point, P(M > 18) = P(M > 18.5), and the fall across a whole number equal to its mass.
  - `football/cfb_terminal/tests.js` holds every curve of a fresh build to the same rules. Its engine-parity check is now limited to markets inside the table, and past the table the curve must equal the edge-conditioned one.
  - `tools/bettor/football_decision.test.js` is back to zero incoherent replayed games.
- **Rebuilt** `football/cfb_terminal` (16:34Z): every game's curve is coherent and no DISTRIBUTION_SANITY check fails. The decision record (`decisions/2026/snapshots.jsonl`) gains 47 snapshots, one for each changed curve. The old code appends none at the same clock.

## 2026-10-02 — four checks that went red on today's live data

Four PR checks failed on `main` itself: CFB research terminal, Record P&L, Personal research and Decision quality. Decision quality and Record P&L hid three more failures behind their first ones. Overnight the pipelines produced data the tests had never seen. Each cause was traced before anything changed:

- **The decision grader attached a "close" the database refuses** (`football/cfb_terminal/decisions.js`):
  - Western Kentucky @ New Mexico State was evaluated at 23:07:32 on the 23:07:23 capture, the last before kickoff. That same capture was handed back as the row's close, with CLV 0.
  - The leakage audit (`CLOSE_BEFORE_EVALUATION`) and `supabase/decision_validation.sql` both require the close to be captured after the decision.
  - A close is now attached only when captured after the evaluation (`closeAfter`). Otherwise the row grades without CLV, as a game with no captured close always has.
  - The one row already written was repaired with the same rule (`withoutEarlyClose`): its close and CLV are now null and its result is unchanged.
- **The Lab's first live checkpoints were graded** (`tools/validation/validation_engine.test.js`):
  - 64 rows with origin `LIVE` now read as LIVE. They pass the same pregame audit, and their sample still cannot license a recalibration.
  - The check that no Lab row was LIVE described a Lab with nothing graded yet. It now checks that only the Lab's own live checkpoints read as LIVE.
- **An incoherent curve is held, not priced** (`tools/bettor/football_decision.test.js`):
  - McNeese @ LSU (LSU −52.5) lies outside the ±45 range the margin PMF table is conditioned on. Its curve came from the engine's per-line lookup, which borrows a different shape at each half point, so the stored P(margin > t) rises with the line.
  - The engine rightly holds it at MALFORMED_PROJECTION. The replay now reads the incoherence off the curve itself and requires exactly that hold, for at most one game.
  - The curve builder for such games is a follow-up.
- **An NFL card showed college rows as its history** (`lib/edgedesk_decision_ui.js` `healthBinsFor`, found behind the first Decision quality failure):
  - The Lab view's HISTORICAL BUCKETS preferred the LIVE decision buckets as soon as any live decision was graded. That ledger is the CFB terminal's, so the first three graded CFB rows replaced the NFL walk-forward buckets (n=1,893) on every NFL card.
  - LIVE buckets now show only on a card of the sport every live row belongs to. `app.html` loads the file as `?v=20261002a`.
- **The P&L parity check compared different rows** (`tools/record/pnl_sql.test.js`):
  - The real ledger is loaded into the same `model_pnl` table before the dollars check. The first 24 settled BETs (NFL props, PIT @ CLE) made the SQL net −7.24 u against the fixture-only −0.07 u.
  - The kernel and the SQL agree on every row. The check now gives the kernel the same rows the SQL reads, so it also proves parity on real data.
- **The P&L page's live re-read check raced** (`tools/record/pnl_ui.test.js`, found behind the `pnl_sql` failure):
  - After a settlement run the test switches the served ledger to the fixture and waited for any profit / loss / even hero.
  - The real ledger now reads Loss (−7.16u) itself, so the wait returned before the re-read and compared the real figures.
  - It now waits for the fixture's own net. The page's re-read was never wrong.
- **The card priced a curve the terminal refuses** (`lib/edgedesk_decision_inputs.js` `integrityFacts`):
  - The card held an incoherent curve only through the circuit breaker's DISTRIBUTION_SANITY check. That check runs only when the EV or the gap is extreme.
  - In the 15:07 build McNeese @ LSU fell below that, so the terminal read NO DECISION (`DISTRIBUTION_FAULT`, checked every time in `lib/edgedesk_ev.js` `decide`) while the card priced a PASS.
  - The card now honours the EV layer's own verdict. `app.html` loads it as `?v=20261002a`.
  - It is not one game: 47 of 115 stored curves are incoherent. They are every curve built without a usable market (46 with none yet, plus McNeese), because the engine's per-line fallback borrows a different shape at each half point. All 68 market-conditioned curves are coherent.
  - Those 46 were already NO DECISION; the card now gives the terminal's reason. Making the no-market curve one coherent distribution is the follow-up.
- **The home board's size-budget check found no card to copy** (`tools/home/home.test.js`):
  - It builds a 120-game week from a real research-grade opportunity on the committed NFL props board. The 14:56Z board held 16 events and no opportunities between slates, so it crashed on `JSON.parse(undefined)`.
  - When the board has none, it now copies the probe's committed props block (`tools/home/fixtures/props_block.json`). It also checks that a card was found.

## 2026-10-02 — the EV-by-spread chart lays out cleanly on wide alternate ladders

On a wide ladder (Northwestern: +28.5 down to −2.5, a ten-point hole, prices to −10000) the *EdgeDesk EV by spread* chart printed every number's line, price and cover on top of its neighbours. MAIN overprinted MAX EV, and the curve ran through SAFEST +EV. The audit found more than one defect:

- **Chart** (`app.html` `fbQevChartPlot`):
  - it is laid out at the width it is drawn (`fbQevChartFit`, a ResizeObserver), so its text is no longer scaled 1.5× on a desktop card and 0.56× (about 5px) on a phone;
  - axis labels are thinned until none collide. The tagged numbers, the numbers either side of a hole and the two ends are labelled first; hovering any point still gives its line, price, cover, break-even and book;
  - a stretch of more than 2 pts with no number dealt is drawn short and dashed, never as a known stretch of curve;
  - MAIN / SAFEST +EV / MAX EV sit above the curve with a halo. A tag that would overprint another moves to the other side of its point, or climbs above with a leader. One number carrying several tags reads `MAX EV · MAIN`;
  - y ticks are round numbers, and zero reads `0%`, not `+0%`. All chart text is at least 10px, the app's type floor on phones.
- **Buying points**:
  - juice is not quoted in cents past ±1000, where −5000 → −10000 read `5000¢` for 1.0 pp of break-even (`EDQuoteEV.centsComparable`; also the card's price advantage and the step text);
  - the key-margins cell wraps, so the Read column no longer scrolls off the card;
  - a falling cover reads `−0.4 pp`, not `+-0.4 pp`.
- **Ladder table**:
  - a stale quote's reason uses the age column's units (`captured 17h ago`, not `captured 998 min ago`; `EDQuoteEV.ageText`);
  - the LC note appears only when an LC row is shown, and no longer nests parentheses.
- **The same defect in the research terminal** (`research/cfb/terminal.js` `frontierChart`):
  - the axis labelled every other half point, however wide alternates made it. It now uses round ticks at a step whose labels clear each other;
  - the FAIR / CURRENT / BETTABLE TO / TARGET labels stacked by `i % 3`, so a fourth overprinted the first, and a mark near the right edge was clipped. They now take the first free row, stay inside the plot and draw over the mark lines.
- **Tests**:
  - `tools/football/quote_ev_ui.e2e.js` adds a wide-ladder fixture game. At 1280px and 390px it checks: no chart label overprints or leaves the chart, the text is unscaled, the hole is dashed, `0%`, MAX EV tagged, no cents past ±1000, the table fits, and no `+-`. 54 checks. Nine of the new checks fail on the previous code;
  - `tools/football/quote_ev.test.js` adds the age text and the cents rule (218 checks).

## 2026-10-01 — college player props on the Records page

The college props were tracked but left off the page. There are 464 of them; every one is a LEAN while the college props model is EXPERIMENTAL. Without *Include leans*, the CFB view showed no player props at all.

- The **Player props** tile (`lib/edgedesk_pnl_ui.js` `marketTile`) shows the leans tracked beside the bets, in the CFB view and in every other view:
  - CFB: *464 leans tracked*;
  - All: *138 bets pending · 1,239 leans tracked*.

  Once games finish it shows their W-L, marked leans.
- The props view's headline counts every tracked prop: *1,377 recommendations tracked (138 bets, 1,239 leans)*.
- The *Pending* ledger says the leans are tracked, with an *include leans* button that lists them.
- Leans still never enter the record or the P&L unless the reader includes them. The college model's gating is unchanged.
- `tools/record/pnl_ui.test.js`: 257 checks, against the committed data:
  - the CFB tile's lean count;
  - the CFB record unchanged;
  - the pending note;
  - one tap listing the college props.

## 2026-10-01 — the Records page leads with how the model has performed

The page answered "can we calculate exact P&L?" before "how has the model performed?". With nothing priced settled yet, its first and largest message was "0 settled verified bets", above a graded record of 432-284-4. That made a tested model look untested.

- **The headline is the best real figure in the view** (`lib/edgedesk_pnl_ui.js`):
  - **MODEL P&L** (net units, ROI, W-L-P, bets, chart) once priced bets have settled;
  - otherwise **MODEL PERFORMANCE**: 432-284-4, 60.3% won over 720 graded decisions, and each market's record:
    - spread 123-136-4 (47.5%);
    - totals 99-95 (51.0%);
    - moneyline 210-53 (79.8%);
    - player props waiting for settlement.
  - It is marked record only and carries no units.
- **The verified P&L's own status** is a small box under the headline: *Waiting for first priced settlements*, the pending priced bets and the first game.
- **New order:**
  - the headline;
  - the verified P&L status;
  - historical model results (by sport, *Historical P&L unavailable*, why pending — never repeating the headline);
  - the filters (tabs, period, stake, leans);
  - the ledger;
  - *How P&L works* and *Advanced Analytics*, collapsed.
- **Tabs** show each scope's net, else its record (ALL 432-284-4, CFB 376-247-2, NFL 56-37-2), else *Pending* — never — when graded data exists.
- **The ledger has three views:**
  - *Verified P&L*: odds and units, totalling the headline's net;
  - *Historical graded*: date, sport, bet, result and record status *Verified* / *Record only*, counting the record's 720;
  - *Pending*.

  It opens on verified P&L once there is some, else on the graded history.
- `tools/record/pnl_ui.test.js` (249 checks) pins:
  - MODEL PERFORMANCE vs MODEL P&L, against the kernel;
  - the status box and its pending count;
  - the page order;
  - the three ledger views and the history columns;
  - the ledger opening on the history when nothing is verified.

## 2026-10-01 — the Records page populates from every graded recommendation

The Records page showed 0, — and empty tables even though the ledger held 2,052 recommendations, 720 of them graded. Every figure was computed from verified priced bets only, and none had settled. The fix covers the pipeline first, then the page.

**What the data showed (traced, not assumed).**
- All 1,332 pending rows are upcoming games: props on Oct 2–5, CFB decisions on Oct 2–10. The props ledger began today, so no prop has finished.
- The 720 graded rows are the model record: 432-284-4 (60.3%).
  - Spread: 123-136-4 over 263.
  - Totals: 99-95 over 194.
  - Moneyline: 210-53 over 263.
- None of them carries an entry price.
- Two silent gaps in the settling jobs:
  - The props grader worked out why a prop was pending and then dropped the reason.
  - The CFB decision grader would never settle a finished game whose closing line was not captured.

**The pipeline.**
- **One state per row.** Each row is `PENDING`, `VERIFIED`, `RECORD_ONLY`, `VOID` or `INVALID`, set by `lib/edgedesk_pnl.js` (`stateOf`, `record_state`).
  - An unreadable settlement is now `INVALID` with its value, instead of quietly pending.
  - So is a recommendation stamped after kickoff.
- **Why pending.** `tools/record/pnl_core.js` (`pendingReason`) gives each pending row one of these reasons:
  - upcoming;
  - in progress;
  - awaiting the settlement run;
  - awaiting the stat feed;
  - missing final;
  - missing player stat;
  - settlement job failed;
  - missing mapping.
- **Where the reasons come from.**
  - `football/props/grade.js` now writes its reasons to `football/props/<lg>/settlement.json` (`pendingStatus`), including a run whose dataset failed to load.
  - The ledger also reads the finals EdgeDesk holds: the model record and the CFB Lab results.
- **No more waiting forever for a close.** `football/cfb_terminal/decisions.js` (`gradeable`) settles a final with no close after 36 h, with no CLV.
- **The ledger job** (`tools/record/pnl_ledger.js`):
  - writes the states, the reasons, the graded record (overall and by sport, market, model version, week and grade) and the integrity checks of every scope into `record/pnl/summary.json`;
  - writes a small `record/pnl/stamp.json` that the page polls;
  - fails (exit 2) if any integrity check fails.
- **The backfill** is the same idempotent build. Run once on today's ledger, it gives the counts above; a second run changes nothing.
  - The scheduled Record P&L job runs it on `main`: hourly at :41, and after every settlement job. Within the hour of this change, `record/pnl/` carries the states, the reasons and `stamp.json`.
  - Until then the page derives each row's state and the graded record from the same rows itself, and it reloads once the first stamp appears.
- **Database** (`supabase/model_pnl_states.sql`, additive):
  - `record_state` is set by a trigger and constrained (verified means priced; record only means no units);
  - `pending_reason` is written only by `model_pnl_reasons()`, which `tools/record/pnl_sync.js` now calls;
  - `model_record_canonical` is one normalized view (`id`, `game_id`, `event_time`, `model_value`, `entry_odds`, `recommendation_grade`, `settlement_result`, `pnl_units`, `clv`, `record_state`, …);
  - `model_record_states` holds the counts.

**The page** (`lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`).
- **Order.** The view comes first (tabs, period, stake, leans), then the verified P&L, then its chart, then the graded record directly under them.
- **With nothing priced settled**, the verified P&L reads *Waiting for first priced bets to settle* with the pending priced bets and the first game. The record below shows:
  - 720 graded and 432-284-4 by market;
  - the split by sport;
  - *Historical P&L unavailable* for the 720 unpriced results;
  - the pending count with its reason.
- **Tabs** show their record (CFB 376-247-2, NFL 56-37-2) while nothing priced has settled, instead of —.
- **Advanced Analytics:**
  - opens on *Where the record comes from*: W-L-P by sport, market, model version, week and grade;
  - says *Waiting for settlement* once instead of drawing tables of 0.00u;
  - holds every row's state, *Why pending* with each reason's count, and the agreement checks.
- **Players** with nothing settled show —, not 0-0-0. That was checked against the rows.
- **The ledger** gains a *Record only* view (720 graded results, units —). Its audit shows each row's state and why it is pending.
- **Empty is not zero.** The kernel's `summarize` returns `null`, not 0, when there is no settled bet.
- **Integrity on every render.** `EDPnl.integrity()` proves the figures agree:
  - the hero's bet count equals the ledger rows, and its net equals their sum;
  - the chart, the sport and market breakdowns, and the record's markets and sports all add up;
  - every row has one state.
  - A failure shows as an *internal check failed* banner.
- **Live.** The page polls the stamp every 5 minutes and when it is shown again, and re-reads the ledger after a settlement run.

**Tests:**
- `tools/record/pnl.test.js`: 172 checks (states, the record, reasons, integrity, null-not-zero).
- `tools/record/pnl_ledger.test.js`: 97 checks. They pin every pending reason, check the stamp, and rebuild the real sources: one state per row, integrity in every scope.
- `tools/record/pnl_sql.test.js`: 113 checks against a real PostgreSQL. The trigger matches the kernel on every row, and so does the real ledger.
- `tools/record/pnl_ui.test.js`: 222 checks in Chromium. On real data there is no 0.00u or 0-0-0 anywhere, the tabs show records, the reasons add up, and a moved stamp reloads the page.
- `football/props/pipeline.test.js` adds the pending statuses.
- `tools/bettor/football_decision.test.js` adds grading without a close.

## 2026-10-01 — the Washington starter check follows the injury report

The committed-slate check in `tools/football/nfl_regime.test.js` required that Colts @ Commanders (week 4, Tottenham) never price Jayden Daniels. That was true on the week-3 report, which listed him OUT with an elbow injury. The week-4 report lists him as limited in practice with no game designation. The slate rebuilt at 18:54 UTC rightly priced him from the schedule feed, and Intelligence CI and Collective suites went red on every open PR.

- The check now applies the builder's own rule (`starterOf` / `fbNflReconcileStarters`) to the committed report:
  - a schedule-feed starter must not be OUT or DOUBTFUL on it;
  - a replacement must name the scheduled starter as OUT or DOUBTFUL, and the report must still say so.
- The report is held against the slate only when the slate was built after the report was retrieved, because the injury sync and the slate build run separately.
- The no-home-field-at-Tottenham check is unchanged.
- The fixture build in section 4 still pins the OUT-on-week-3 → Mariota substitution.

## 2026-10-01 — the Records page answers "is the model up or down?" first

The Records page was an analytics dashboard: a reader had to read CLV, data-quality counts and pending totals to learn whether EdgeDesk makes money. It now opens on one answer, and everything else is one tap away.

- **The summary, first** (`lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`). It shows the verified model P&L: settled BET recommendations with a captured entry price.
  - Net units is the largest number on the page, followed by PROFIT, LOSS or EVEN, then ROI, W-L-P, win rate, the number of verified bets and the period.
  - With nothing settled it reads **Not enough settled priced bets yet**, with the settled and pending counts. It never shows a giant 0.00u.
- **Tabs** ALL / CFB / NFL / PLAYER PROPS, each with its own net.
- **Controls:**
  - a period: Season (the default), 30 days, 7 days or All time;
  - a stake choice: flat 1u or EdgeDesk stakes;
  - *Include leans*, off by default. PASS and WATCH are never bets.
- **One chart**: cumulative units and the running peak, with current, peak and max drawdown under it. There is no drawdown wash.
- **Historical model results**: spread, totals and moneyline as wins and losses only, labelled *Record only — exact historical P&L unavailable because entry odds were not captured.*
- ***How P&L works*** and ***Advanced Analytics*** replace the long paragraphs and are collapsed.
  - Advanced holds more numbers, drawdown, game markets vs props, every breakdown, calibration, CLV vs P&L, player performance and data quality.
  - In the app it also holds the detailed records: Edges record and Football model record.
- **The ledger** has six columns: date, sport, bet, odds, result, units. A row opens to its audit. Settled and pending are separate views, and the verified total is the summary's net.
- **One dataset.** The summary, tabs, chart, advanced figures and ledger total are all computed from one filtered set of rows by `lib/edgedesk_pnl.js`, so they cannot disagree.
- **The app** (`app.html`): the summary is the first thing under the Records header. The Profit & Loss tab is gone; an old link to it lands on the summary. The Football board's track-record link opens the football model record inside Advanced Analytics.
- **The historical record is a record again.** The units added to the football model record on 2026-10-01 (#456) are gone from the page and from `record/football/summary.json`. The record job no longer assumes −110 for anything: a pick is priced only at a captured closing price (`grade.pnl`, auditable data the page does not show). The captured closing prices are kept.
- **The public record** (`record.html#pnl`) uses the same component. Its long introduction is now one line.
- **Tests:**
  - `tools/record/pnl_ui.test.js` (192 checks) checks the summary, tabs, chart readout and ledger total against the kernel under every scope, period, stake and the leans switch. It also covers the empty state, the record-only historical card, the collapsed sections, the six-column ledger and audit, the app layout, phone widths and no horizontal scroll.
  - `tools/record/signal_pnl_ui.test.js` opens Advanced Analytics to reach the edges record.
  - `tools/record/football_record.test.js` covers no assumed −110 and a summary with no units.

## 2026-10-01 — the landing board holds its own size

The 17:03 Player props rebuild wrote `football/home/board.json` at 75,707 bytes, over the 64 KB the landing page allows. That turned Funnel tests and Collective suites red on `main`. Nothing was wrong with the data: a full NFL week plus a college week put props on 79 games, and `LIMITS` capped the cards per game but not the number of games.

- **A size budget in the build** (`tools/home/build_home.js`, `fit`). Past 60 KB, the games furthest from kickoff give up their prop cards first. Each keeps its counts, and the page uses the research state's own props for that card. The cross-league top 12 is never trimmed. Items nothing points at any more are dropped. What was taken is counted in `props.counts.trimmed`.
- **The board rebuilt** with the budget: 61,009 bytes. All 79 games keep their counts; the 8 latest lose their cards.
- **Unchanged:** the page, the limits per game, the top list and every number on the board.
- **Tests** (`tools/home/home.test.js`): a 120-game week built from a real research-grade opportunity, with these checks:
  - it is over 64 KB without the budget and under it with;
  - the top list is untouched and every id resolves;
  - no item is left that nothing points at;
  - the latest games lose their cards first and keep their counts;
  - the trim is counted, and the build is deterministic.

## 2026-10-01 — the football record is graded in units; Profit & Loss is part of the record

Every graded pick in the football model record now carries a profit or loss, and the Record tab shows it beside every win–loss figure. The separate Profit & Loss tab is gone: its content is the last part of the football record.

- **Real closing prices** (`tools/record/football_record_sources.js`). The record grades every side against the closing line, so it now prices every side at the closing price of that line, read from the same source in the same read:
  - NFL: nflverse `home_spread_odds`, `away_spread_odds`, `over_odds`, `under_odds` and the moneylines;
  - CFB: the ESPN book's `spreadOdds`, `overOdds`/`underOdds` and `moneyLine` (or the nested close), taken only from the reading that gave the line.
- **P&L per pick** (`football_record_core.js`, `grade.pnl`). 1 unit on the spread side, the total side and the straight-up pick, at that side's closing price. A spread or total whose closing price was never captured is priced at the standard −110 and marked `basis: "standard"`. A moneyline is priced only at its real price; without one it counts in the straight-up record only. The arithmetic is `lib/edgedesk_pnl.js`, the same kernel the P&L ledger uses.
- **Price backfill.** A held close takes a price only for the exact line and book it already holds, and a held price is never replaced. NFL closes fill from nflverse on the next run. Graded college games without a price are asked for one through ESPN's summary: newest first, 60 per run, at most 3 times per game.
- **The summary** (`record/football/summary.json`) adds units, risked units, ROI and price basis to every record. It also adds: the moneyline, the net across all three markets, units by points off the close, favourite/underdog, home/away, over/under, a running total by week, and units per CFB matchup group.
- **The Record tab** (`app.html`): the books are now **Edges record** and **Football record & P&L**.
  - The football record opens with its net units, the three markets and a game-by-game running-total chart (hover, tap or arrow keys).
  - Every record tile, the matchup and week tables, and every game row show units. Each game row also shows the price it was graded at, with `std` where the price is the standard −110.
  - A new **What has worked** table and a **By how far the model was from the close** table.
  - **The bets EdgeDesk recommended** (props and game decisions at their recorded prices, `lib/edgedesk_pnl_ui.js` with a row filter) comes last. Model-record rows are left out there because they are priced above.
  - Old links and saved choices for the P&L tab open the football record at that section.
- **First numbers** (re-run on real nflverse data):
  - NFL: all 95 graded picks are at the real closing price. ATS 19-11-2 is +6.04u, totals −0.49u, moneyline +1.08u: net **+6.63u**, ROI +7.1% on 93u risked.
  - CFB: −35.00u at the standard −110, until the record job reads ESPN's closing prices.
- **Unchanged:** grading itself (sides, results, CLV, Brier), the P&L ledger `record/pnl/`, its database copy, and the public `record.html`.
- **Tests:**
  - `tools/record/football_record.test.js`: 19 new cases. Price parsing (nflverse, ESPN flat and nested, a mismatched line refused); the close-price fill rules; P&L at −105, +120, a loss, a push, the standard −110 and an unpriced moneyline; summary units, ROI, splits, gaps and running total; the price-ask bound; the committed record's units equal the sum of its picks.
  - `tools/record/pnl_ui.test.js`: P&L lives in the football record, and model-record rows are not counted twice.

## 2026-10-01 — an open Football tab keeps its prices current; aged quotes are STALE, not a MARKET FAULT

Thursday night's PIT @ CLE read NO DECISION · STALE_QUOTE on every market, and "NFL MARKET SELF-CHECK FAILED" named it as a MARKET FAULT. That was 30 minutes after capture had re-priced the game. Capture and pg_cron were healthy; the fault was in the page (`app.html`).

- **Prices re-read every five minutes** (`fbPriceRefresh`). Before this, an open tab re-read the captured quotes only on its six-hour re-learn. Quotes go stale after 90 minutes a day out, 45 inside six hours and 15 inside two. Now the NFL and FBS boards re-read `signals` every five minutes while the Football module is on screen, and again when the tab comes back to the foreground, then repaint. Open sections, expanded FBS cards and the scroll position are kept. A failed read keeps the quotes already held, which then age into STALE on their own timestamps.
- **No current quote: the last capture, not every row on file** (`fbLatestCapture`). `signals` keeps the opener and every point a line has passed through. After a line move, the median of that whole history sat off the last line the books dealt, so aged quotes read MARKET FAULT and failed the NFL self-check. The stale fallback now uses only the newest capture run's rows, for spreads, totals and the moneyline. It is still marked STALE and still leaves the research ranking.
- **Unchanged:** capture, the freshness ladder, the self-check bound, the decision engine and every model. Current-quote behaviour is identical.
- **Tests:**
  - `tools/football/market_join.test.js` sections 7–8: the aged PIT @ CLE board (fails on the old code with the same self-check message), and the refresh, including a failed read, a reload in flight, another module on screen and a read overtaken by a reload.
  - `tools/football/price_refresh.e2e.js` (`npm run football:prices:e2e`): the same case in Chromium. A three-hour-old capture reads stale with no market fault. After capture re-prices the game and the reader returns to the tab, the card decides on current quotes and the open section is still open.

## 2026-10-01 — profit and loss of every flagged edge, written by the database at settlement

Every flag in `signals` now carries a recorded P&L: 1 unit flat, at the price frozen when the edge was flagged. It is written in the same transaction as its settlement, and shown on the public record beside closing-line value. `docs/pnl/EDGE_PNL.md` has the full account.

- **Database** (`supabase/signal_pnl.sql`, `signal_pnl_summary.sql`, `signal_pnl_sync.sql`):
  - `pnl_grades`: one row per `sig_key`, foreign-keyed to the signal.
  - `pnl_grade_history`: append-only.
  - `pnl_summary`: by sport, tier, market, day / week / month and all-time.
  - `pnl_reconciliation()`, `pnl_verify()`, `pnl_handcheck()`.
- **The math.** +150 win = 1.50, −110 win = 0.909, loss = −1, push = 0. Void is not a bet. A missing flag price is counted and never estimated. P&L at the closing book price is stored for comparison only. Every row is stamped `calc_version = pnl-v1`.
- **The hook.** A trigger on `signals` fires on the columns `settle` and `close` write. It never fails a settlement; errors are logged and reconciled.
- **Backfill.** `pnl_backfill()` is a dry run: counts, a 20-row sample, totals per sport. `pnl_backfill(true)` commits it, idempotently.
- **`record.html#edge-pnl`**, read live from `pnl_summary`:
  - units, ROI and W–L–P;
  - Tier A vs Tier B in plain words (the tier is the one capture froze; nothing is re-classified);
  - a sport filter and a running-total chart;
  - the closing-price comparison;
  - every flag not counted, with its reason;
  - the method note.
- **Records tab:**
  - a **P&L** column on every graded row, on the receipt and in the exports;
  - the old simulated column is labelled **Sim P/L**;
  - a **P&L sync** row in Pipeline health (settled flags with no P&L row: 0).
- **Unchanged:** capture, close, settle, flags, tiers, thresholds and every model. Nothing writes to `signals`.
- **Tests:**
  - `tools/record/signal_pnl.test.js`: the math.
  - `signal_pnl_sql.test.js`: real PostgreSQL. Covers the dry run, idempotent backfill, the hook in the settlement's transaction, a sabotaged hook that still lets the settlement commit, summary = raw sum, a three-way hand-check, and RLS.
  - `signal_pnl_ui.test.js`: Chromium at 375–1440 px, fed the database's own anonymous output.

## 2026-10-01 — every game keeps its brief: "All game briefs" on the publisher desk

**What went away.** The football boards list upcoming games only. A game leaves the board once it is final or six hours
past kickoff (`EDFbs.buildSlate`, the NFL `S.up` window), and its "Game brief" button leaves with it. The live builders
(`fbBriefGame`, `fbNflBriefGame`) read that same upcoming slate, so a brief opened for a game that is no longer on it has
no projection ("this game is not on EdgeDesk's upcoming FBS slate"). Finished NFL games in the week view had no brief
button at all.

**What brings it back.** The article pipeline already keeps a research record for every CFB and NFL game it has seen
(`articles/data/records/`, ~430 games). The builders above produce it before kickoff, and the pipeline freezes it at kickoff.
- **All game briefs** on the publisher desk (Edges and Football) lists every one of them, split into *Already played* and
  *Upcoming*, filterable by CFB / NFL and by team.
- A game that has kicked off opens the brief from its stored pregame record. The page says when the research was built and
  that nothing was recomputed after the result. The footer's data check reads "Pregame research", not "Current".
- A game still upcoming and on a loaded board opens the live brief, exactly as the board's own button does.
- Copy for CMS, Copy plain text, Print and Share brief work on a stored brief. Refresh reloads it. Reader check and Polish
  copy only read a market card, so they are hidden on a stored brief, which has no market card.
- Finished NFL games in the week view carry a "Game brief" again (the stored pregame record).

Nothing computes a number. Tests: `tools/presentation/app_presentation.test.js` (+22 checks, run against the committed
records).

## 2026-09-30 — second follow-up: corrected intervals, the NFL regime signal (#4), the NFL neutral site, the audit's CLV cuts (#5), the two root causes (#3)

While this pass was in progress, #444 and #445 (another session) shipped items 1, 2, 3, 5 and 6 of the follow-up (the
section below). This pass re-ran their reports rather than re-implementing them. It keeps their work and adds what was
wrong or missing:
- three of their reports' bootstrap intervals were too narrow, and two "significant" claims are not;
- item 4 (an NFL regime signal) had not been done, and the NFL board priced Washington with a quarterback who is out;
- the NFL engine applied its home field at neutral and international sites;
- the CLV report did not have the cuts the audit asked for (2+ / 3+ / 5+, regime / not);
- the root causes for North Texas @ Tulsa and Syracuse @ UConn.

Every parameter below was fitted walk-forward. None was fitted on 2024-2025 before its holdout report. "Significant"
means the 95% interval excludes zero. The market is never an input to a rating.

### Corrected — the bootstrap intervals (items 1 and 5, and the first pass's #1)

**Root cause.** `regime_backtest.js`, `regime_magnitude_backtest.js` and `clv_report.js` drew their resamples from
`(seed * 1103515245 + 12345) % 2147483648` computed in doubles. The product passes 2^53, so the low bits are lost and the
sequence falls into a cycle of about 10,466 draws. A 2,000-rep bootstrap of 500+ games therefore re-used the same few
thousand indices, and every interval came out too narrow. It was found because one interval printed as [0.22, 0.32]
around a point estimate of +0.32.

**Change.** All three use an exact 32-bit generator, `seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0` (period
2^32). Each report was re-run with `--write`. `regime_backtest.js` now records `significant` in the pooled record and in
the shipped artifact.

| claim | first published | corrected |
|---|---|---|
| first pass #1: v1 regime curve vs the standard curve, walk-forward 2014-2025 (`regime_curve.js` record) | −0.030 [−0.063, −0.006], significant | **−0.032 [−0.095, +0.033], not significant** |
| #444 #1: v1 vs standard on the regime subset, 2024-2025 holdout | −0.106 [−0.229, −0.011], significant | **−0.106 [−0.226, +0.017], not significant** |
| #444 #5: CFB CLV 2022-2025, all gaps | +0.21 [+0.14, +0.27] | +0.21 [+0.13, +0.29], still excludes zero |
| #444 #5: CFB CLV 2022-2025, gap 2-4 | +0.10 [+0.02, +0.19] | +0.10 [−0.03, +0.23], now includes zero |
| #444 #5: CFB CLV 2021 | +0.12 [+0.01, +0.22] | +0.12 [−0.01, +0.26], now includes zero |

- The section below is corrected in place (the #1 table, the v1 sentence, the #5 table) and says so where it changed.
- The first pass's MAE also reads 13.479 → 13.447 instead of 13.475 → 13.445. That is the fresh public download #444
  verified against, not the generator.
- **Nothing prices differently.** The v1 curve, N = 6 and the signal are unchanged. The magnitude refit was already a
  CANDIDATE.
- **The v1 regime curve still prices, and its gain is no longer significant.** Its point estimates still favour it, and it
  cuts the standard curve's +1.68 bias on the regime subset to +0.94. Keeping or reverting it is raised in the PR as a
  decision; this pass changes neither.
- The same generator is in `tools/intelligence/validate_staking.js`, outside this audit. It is left for a separate change.

### #4 — An NFL regime signal, and the starter the model prices (Washington without Jayden Daniels)

**Root cause (Daniels).** nflverse `games.csv` pre-fills each upcoming game's quarterback with the club's usual starter,
and it had not updated Washington's played week 3: it names Daniels, who left week 2 hurt and is OUT (elbow) on the
week-3 report. The player game logs (`football/props/nfl/players.json`) show Mariota on 100% of the week-3 snaps and
Daniels on 55% of week 2's. The board read the feed's starter, so it priced Washington with Daniels for weeks 4 and 5.

**Change (the starter).**
- `app.html` `fbNflReconcileStarters` reads the NFL injury report the research card already shows
  (`football/injuries/nfl_<season>.json`). A named starter listed OUT or DOUBTFUL is not priced. The club's most recent
  other starter is: the quarterback with the most starts this season, then last season, who is not himself OUT or
  DOUBTFUL. QUESTIONABLE is not a substitution.
- It runs over every unplayed game of the season, not only the board's window.
- When the report is an earlier week's than the game, the substitution is stated as PENDING.
- A club with nobody to name prices its carried quarterback level and says the starter is unknown.
- The substitution is a data-quality note beside the number (`home_qb_note` / `away_qb_note`, `football/engine.js`),
  never a number of its own.
- `tools/football/build_nfl_slate.js` publishes the starter it priced, with its status (`SCHEDULE_FEED`,
  `INJURY_REPORT_REPLACEMENT[_PENDING]`, `STARTER_UNKNOWN`) and the scheduled starter it replaced.

**Change (the regime signal).** `football/research/nfl_regime.py` measures three events per team-game from `games.csv`,
all known before kickoff:
- `hc_new`: the head coach's tenure began this season, including a mid-season change;
- `qb_new`: the starter is not last season's primary starter;
- `qb_out`: the club has started 2+ games and this starter is not its regular starter so far.

The NFL engine's quarterback layer already moves a club by its announced starter, so the signal is fitted on what is
left: the out-of-sample residual (`nfl_oos.csv`, itself walk-forward). The fit is OLS on the home-minus-away signals,
with `hc_new` and `qb_new` split at week 6. It is walk-forward from 2006, with validation 2016-2023. 2024 and 2025 were
scored once, with the fit through 2023, which is the shipped fit. `football/nfl/regime_nfl.js` carries the fit and its
record.

| regime subset (either side: `hc_new` or `qb_new` in weeks 1-6, or `qb_out`) | games | MAE model → adjusted | Δ [95% CI] | bias (regime side) |
|---|---|---|---|---|
| validation 2016-2023 | 1,062 | 10.224 → 10.085 | −0.139 [−0.275, −0.012] | +1.30 → +0.09 |
| **holdout 2024-2025** | 303 | 10.509 → 10.340 | **−0.169 [−0.394, +0.056]: not significant** | +1.29 → +0.17 |
| …2024 | 146 | 10.681 → 10.299 | −0.382 [−0.708, −0.048] | |
| …2025 | 157 | 10.350 → 10.378 | +0.028 [−0.280, +0.332] | |

- Coefficients (points to the club's side): new head coach −1.49 (weeks 1-6), −0.90 (later); new starter +0.13, −0.73;
  regular starter out −2.33.
- **Not promoted.** The adjustment prices only if the holdout interval excludes zero, and it does not. The board shows the
  signal per side and the adjustment the fit would make ("REGIME (not priced …)"), and adds nothing to the number.
- When the most starts this season are tied, the fit's own rule picks the earliest starter as "regular". The card says the
  starts are tied rather than naming a regular starter who is out.

**Live effect (model side, `football/nfl/slate.json` rebuilt at 20:41Z against main's 18:27Z build).**
- Colts @ Commanders (Tottenham): Colts by 0.80 → **Colts by 2.82**. Mariota for Daniels moves it +0.46 toward Washington
  (the engine's quarterback table rates Mariota slightly above Daniels). The neutral site (below) moves it −2.48.
- Giants @ Commanders: Washington by 2.49 → 2.95 (Mariota).
- 21 of 30 games show an active regime side, all unpriced.

### The NFL home field at neutral sites (found by item 3's home-field check)

**Root cause.** The NFL spread intercept (2.48 pts) is the fitted home-field advantage. It was applied to the nominal home
side of every game, including the international and neutral-site games nflverse marks `location = Neutral`.

**Change.**
- `football/engine.js` `nfl.predict` drops the intercept when `game.neutral === true`. The baseline term shows 0 and keeps
  its fitted weight.
- The board sets `neutral` from the feed's `location`, or from a verified international venue in
  `football/venues/nfl_stadiums.json`. The feed marks 57 of its 58 international games Neutral, including the 12 earlier
  games the Jaguars hosted. Only Eagles @ Jaguars (Tottenham, week 5) is marked Home. That game is priced neutral with a
  SITE note saying why.
- Without the venue table, only the feed's own designation counts.

**Result** (`football/research/nfl_neutral_site.js`, the walk-forward predictions on the feed's 90 neutral-site games,
2003-2025):
- The nominal home side finished 3.00 pts under the number: CI [−6.02, −0.01].
- Removing the intercept moved the MAE −0.28, CI [−0.75, +0.23]: **not significant**. This ships as a correction of what
  the term means (a neutral site has no home team), not as a fitted gain.
- Eagles @ Jaguars: Jaguars by 6.51 → 4.03. Colts @ Commanders: −2.48 of the move above.

### #5 — The audit's cuts on the CLV report (2+ / 3+ / 5+, regime / not)

**What was missing.** #444's report buckets by 0.5-2 / 2-4 / 4-7 / 7+ and has no regime split. The audit asked for 2+,
3+ and 5+ against the opener, split regime / not and CFB / NFL.

**Change.** Nothing is fitted and no cut is chosen here.
- `tools/football/clv_report.js` adds `by_threshold` to every sample: cumulative 2+ / 3+ / 5+. Each is split by the v1
  regime flag (either side's team-season fires the signal the shipped curve uses) and by games played against the curve's
  own fitted research minimum (`min_games_for_research` = 6).
- `football/cfb_p4/research/replay_rows.js` carries the flag and the projection's games-played count, on request only
  (`regime: true`). Every other number in the report is byte-identical.

| CFB replay 2022-2025 (the engine's held-out window) | 2+ | 3+ | 5+ |
|---|---|---|---|
| all: toward rate, CLV pts [95% CI] | 52.7%, +0.22 [+0.13, +0.32] | 52.8%, +0.23 [+0.12, +0.35] | 54.6%, +0.35 [+0.19, +0.51] |
| regime-flagged | 50.2%, +0.04 [−0.13, +0.21] | 49.1%, +0.01 [−0.18, +0.20] | 50.9%, +0.11 [−0.14, +0.38] |
| not flagged | 53.9%, +0.33 [+0.21, +0.45] | 55.1%, +0.37 [+0.23, +0.51] | 56.5%, +0.50 [+0.30, +0.72] |
| before 6 games played (either side) | 50.1%, +0.08 [−0.04, +0.20] | 48.4%, +0.04 [−0.11, +0.18] | 50.3%, +0.12 [−0.07, +0.30] |
| from 6 games | 55.1%, +0.35 [+0.22, +0.49] | 57.1%, +0.42 [+0.25, +0.59] | 59.4%, +0.61 [+0.35, +0.89] |

- **Reading.** The close follows EdgeDesk only on settled games. A regime-flagged gap, or one before either side has
  played six games, is followed at a coin flip at every size.
- 2021 (the engine's tune season, never pooled) shows the same direction: before 6 games 45.5%, from 6 57.0% at 2+.
- **NFL and CFB 2026:** 24 and 54 games at 2+, too small to read, with no flags on their rows. NFL history cannot be
  measured: no opener archive exists.
- **Leakage.** No readable cut is over 60% (the test holds it).
  - The replay projects each game before absorbing it, and no market field enters a projection.
  - Its state at kickoff also holds the week's earlier games, which the market also sees by the close.
  - N = 6 was fitted in the first pass on 2014-2025 by another criterion, so this split is not an independent test of it.
- **Proposed, not applied:** a WORTH RESEARCHING label at 5+ should require both sides to have played six games (the
  curve's own N, which today gates regime-flagged teams only). A regime-flagged gap should not be researched on its size
  alone. The 2-point threshold stays.

### #3 — Root causes: North Texas @ Tulsa and Syracuse @ UConn

The explainer's terms (#444) are exact additive pieces of the projection, so each term *is* the move a counterfactual
re-projection makes with that factor turned off. Below, each is credited undiscounted, and only toward closing the gap.
#444's explainer instead discounts each by how much the close has historically taken out. From the committed
`football/fbs/slate.json` (`disagreement_inputs.explainer_terms`).

**North Texas @ Tulsa.** EdgeDesk has North Texas by 9.24. The market has Tulsa −1.5 (one book, last capture). Gap:
10.74 toward North Texas, of which 10.00 (93%) is explained.

| factor | effect | share of the gap |
|---|---|---|
| North Texas's long-run 2025 rating, still weighted 69% at four games (regime curve; 80% standard) | 7.56 | 70% |
| the matchup term: 2025 efficiency carried at half weight (`carry_eff` 0.5) | 2.44 | 23% |
| home field above the fitted 2.58 (4.08 applied) | favours Tulsa; widens the gap | 0 |
| conference | same conference | 0 |
| unexplained | 0.74 | 7% |

- **Root cause:** 2025 North Texas production is still counted as 2026, through the long-run prior and the matchup
  term's efficiency carry.
- On this season's centred track alone, North Texas is still 3.3 pts better than Tulsa.
- **Baylor Hayes** is Tulsa's quarterback (slot 1 on its depth chart; Dexter Williams II started the last game). His
  questionable status is **not read**: no availability record reached Tulsa's quarterbacks (UNKNOWN), and the college QB
  term prices 0 pts. His status could not have caused this gap.
- **North Texas's roster inputs are read correctly** after the coaching exodus. The regime record shows:
  - a new head coach;
  - returning roster share at the 8th percentile;
  - returning production at the 1st;
  - transfers out at the 87th.
- EdgeDesk's own V2 has North Texas by 5.9, between V1 and the market.

**Syracuse @ UConn.** EdgeDesk has UConn by 7.75. The market has Syracuse −6.5 (stale). Gap: 14.25 toward UConn, of which
4.10 (29%) is explained.

| factor | effect | share of the gap |
|---|---|---|
| UConn's long-run rating (new coach, 2nd-percentile returning production; weighted 69%) | 2.60 | 18% |
| home field above the fitted 2.58 (Rentschler gets the league constant 4.08) | 1.50 | 11% |
| conference (UConn is independent) | 0 | 0 |
| unexplained | 10.15 | 71% |

- Ruled out:
  - **Misjoined results:** all 328 FBS results were checked against ESPN box scores before the network closed, and none
    differ.
  - **Schedule strength:** consistent. UConn's this-season number rests on 48-20 at Southern Miss and 14-38 vs Maryland.
  - **Orientation:** the first pass's #5 holds it as DATA FAULT.
- **Root cause:** the model, not the data. V1's margins-only rating still has UConn 1.3 pts better on this season's track
  alone, and the market has Syracuse about 9 better on a neutral field. EdgeDesk's own V2, on efficiency, has Syracuse by
  3.2: it sides with the market. The game stays DATA FAULT.

**Not done in this pass: the "unexplained disagreement" DATA FAULT rule and the research page's "why EdgeDesk disagrees"
section.** #444 put its explainer in the terminal's artifacts (`games.json`, `board.json`); no page renders it yet. With
its discounted terms (holdout R² 0.03), the unexplained part averages 89% of a 7+ gap on its own holdout (8.74 of 9.85
pts), so the rule would flag most large gaps. With the undiscounted terms above, North Texas @ Tulsa is 7% unexplained and
Syracuse @ UConn 71%. Which explainer drives the rule is a decision, raised in the PR. Nothing is excluded from ranking
until it is made.

### #6 — Live re-run: still not possible

At 2026-09-30T20:54Z this environment's network policy refused the capture host (`iattxbkbufslbauoumga.supabase.co`), The
Odds API, ESPN and CollegeFootballData. nflverse (GitHub) was reachable, which is how the NFL slate was rebuilt. No
market number here is reported as current. The Colts props group was not re-run.

### Pre-existing failures on `main`, unchanged here

- `football/cfb_terminal/tests.js`: the terminal build throws at `lib/cfb_terminal.js:1322` (`K.sd.toFixed` on a null
  SD). Texas Southern @ Florida Atlantic has only one independent model number, so its agreement tier is null at an 18.8-pt
  gap. The line is from 0314762b. A fail-closed guard is proposed separately.
- `tools/bettor/decision_ui.e2e.js`: the NFL card reads "…ResearchLabPASS…", and the test's `\bPASS\b` finds no word
  boundary after "Lab".
- `football/cfb_validation/divergence_backtest.js` needs a local replay cache that is not in the repository.

### Tests

- `tools/football/nfl_regime.test.js` (60 checks, new):
  - the fit's provenance: holdout never fitted, walk-forward, significance from the interval, promotion rule, no market
    input, signals known before kickoff;
  - the engine: the neutral site removes exactly the intercept and nothing else; the regime never reaches a number; the
    notes are stated and never priced;
  - the board helpers;
  - the real slate builder on fixture feeds: OUT → PENDING replacement, DOUBTFUL → STARTER_UNKNOWN, QUESTIONABLE kept,
    every unplayed game reconciled, both sides' regime, the Home-marked international venue priced neutral, an unreadable
    injury report said;
  - the committed slate and the neutral-site report.
- `tools/football/clv_report.test.js` §4 (9 checks): the cuts are cumulative; the regime and games-played parts add up; the
  minimum is the curve's; the 2026 samples say "not available"; no readable cut over 60%.
- `tools/football/regime.test.js`: the curve's record states its significance from its interval, and says it is not
  significant.
- A 326-file sweep of every test the workflows and `package.json` run: 323 pass. The three above fail identically on
  `main`.

## 2026-09-30 — CFB board market integrity: Step 1, the read-only audit

Nothing on the board changed. The week-5 board said NO MARKET for games the providers were quoting. This adds
the tools that measure where the quotes go missing, and a report
(`docs/cfb-board-integrity/AUDIT.md`) with every root cause reproduced before any fix:

- `tools/football/cfb_board_audit.js`: provider events → matched → shown with a market, Market vs the latest
  consensus, false staleness, week scoping and duplicate teams, over the committed ledger and board.
- `supabase/audits/cfb_board_market_audit.sql`: the same questions against production (`signals`, `cfb.games`,
  `cfb.lines`, `cfb_lab_market_quotes`). It is one read-only `select`.
- `tools/football/cfb_board_repro_app.js`: the board's own functions, lifted from `app.html`, on the rows each bug
  needs.
- `docs/cfb-board-integrity/FINDING_cover_probability_sd.md`: the "SD near 8" rows, investigated. The model is not
  changed.

## 2026-09-30 — audit follow-up: verification of the first pass, and the second pass

The first pass (the section below) was re-verified from its code and data before anything here was changed. Its
regime backtest reproduces from a fresh download of the public data (held-out MAE 13.479 → 13.447 against its
reported 13.475 → 13.445; the same curve, the same N = 6, an engine self-check of 7e-15); its eleven test suites
pass. Nothing of the second pass had been started. Each item below says what the data supports, including where it
does not support what the audit expected.

### #1 — The regime prior as a continuous magnitude (a CANDIDATE: it did not beat v1, so it does not price)

**Root cause of "Iowa State still ≈ −9 against West Virginia".** There were no magnitude inputs to wire in. The v1
signal is a yes/no, so Iowa State (4th-percentile returning production), North Texas, UConn, Penn State and Virginia
Tech (36th percentile) all got the same 69% long-run weight at four games. West Virginia (3rd-percentile returning
roster, no coach change) got no adjustment at all. The v1 fit also started in 2007, and the curve it ships was fitted
on seasons through 2025. The QB change and portal inflow were not inputs anywhere.

**Change.**
- `football/cfb_p4/research/build_regime_history.py` now also measures:
  - portal inflow, production-weighted: last season's units produced at another programme by players on this roster
    (the rating-weighted alternative needs a keyed feed; this was agreed as the substitute);
  - last season's primary QB and whether he is on the roster;
  - every team-game's starter (`qb_starts.csv`).

  `--current 2026` writes the same fields into `returning_production_2026.json` (schema v2).
- `football/coaching/regime_signal.js` holds the one magnitude definition. It has four hinge features, each zero at or
  better than the season median: new coach, returning production, QB change (the starter of the team's last completed
  game vs last season's primary QB), and portal inflow. An unmeasured input is 0.
- `football/cfb_p4/research/regime_magnitude_backtest.js` replays the shipped engine cold and fits on 2021+ only:
  - **A. Selection.** Three pricing forms (a weight cut onto the raw this-season track, the same onto the centred track,
    a signed level shift on the long-run rating) are fitted on 2021-2022 and scored on 2023.
  - **B. Holdout.** Each form is refitted on 2021-2023 and scored once on 2024-2025, which no fit it is judged on ever
    saw.
  - **C. Ship.** The chosen form is refitted on 2021-2025 and promoted only if the holdout shows it no worse than the
    standard curve and than v1.
- Disclosure: two of the three forms were each scored on the holdout once while the list of forms was being built, so
  read the holdout intervals as optimistic.
- `football/cfb_p4/engine.js` supports both v2 forms (`magnitude`, `prior_shift`). `football/matchup/contract.js`
  forwards them only when `priced`. `football/coaching/build_regime.js` publishes every programme's v2 inputs,
  features and magnitude under `by_team.<key>.magnitude`, with `priced: false` while the artifact is a candidate.

**Result (2024-2025 holdout, never fitted).** Stage A chose `w_raw` (2023 MAE 13.108; standard 13.126).

| subset (games) | standard | v1 (ships) | v2 w_raw | v2 − standard | v2 − v1 |
|---|---|---|---|---|---|
| all FBS games (1,604) | 12.594 | 12.559 | 12.579 | −0.015 [−0.055, +0.023] | +0.020 [−0.013, +0.053] |
| v1 regime subset (537) | 13.027 | 12.921 | 12.946 | −0.080 [−0.181, +0.022] | +0.025 [−0.048, +0.099] |
| heavy turnover (284) | 12.719 | 12.662 | 12.619 | −0.101 [−0.256, +0.050] | −0.043 [−0.146, +0.061] |
| stable (80) | 13.536 | 13.536 | 13.542 | +0.006 | +0.006 |

- Bias on the regime subset (+ = the model overrates the flagged team): standard **+1.68**, v1 +0.94, v2 +0.79.
  The standard curve's figure is about 2.3 standard errors from zero.
- **v1 against the standard curve on the regime subset: −0.106, 95% CI [−0.226, +0.017]. Not significant.** *(Corrected in
  the second follow-up. This was first published as significant, CI [−0.229, −0.011], from a bootstrap whose generator
  cycled; see that section. The table's intervals above are the corrected ones.)* Its 2021-2023 refit gives the identical
  curve (w0 0.75, λ 0.02), so its sight of 2024-2025 did not change it.
- **No v2 form is significantly different from v1, and v2's point estimates are slightly worse.** It is not promoted.
  `football/cfb_p4/regime_magnitude.js` ships as `CANDIDATE`, fitted on 2021-2025 as coach 0.25, returning production
  0.05, QB 0, portal inflow 0. That would put Iowa State's long-run weight at about 60% at four games (×0.74), not under 50%:
  2021-2025 does not support the deep cut the audit expected.
- A fit-years-only diagnostic found the same thing. The best multiplier on the long-run weight is 0.8-0.85 for
  turnover profiles, and 1.0 for the most Iowa-State-like one (new coach, returning production at or under the 10th
  percentile, heavy inflow; 46 games).

**Found on the way: the this-season track is offset.** It starts every programme at `init_rating` (−12), and its FBS
mean stays about 8.6 pts under the long-run track's at every games-played count, 2021-2025 (sd 7.9-9.6 against
8.8-9.5, correlation 0.90+ from four games).
- The standard blend cancels this in the gap, because both teams share one weight. A per-team cut does not: moving
  weight onto the raw track also docks the team about Δw × 8.6 pts for no football reason.
- Iowa State's this-season −7.42 after four games is roughly where Iowa State 2025 (8-4) stood at the same point
  (−8.4). It is not by itself evidence that the team is bad.
- The v2 engine path moves the cut onto the centred track (`trackCentres`). v1 keeps the raw track, as it was fitted and
  validated, and its accidental level shift is part of why it works: regime teams really are overrated by their
  long-run rating.

**Unchanged by design.** All 109 games of a rebuilt `football/fbs/slate.json` have identical model margins and regime
weights (0 differences). Georgia and Ohio State have zero magnitude (the same coach and QB, continuity above the median).

**Tests.** `tools/football/regime.test.js` §9 (24 new checks) covers:
- the hinges and the unmeasured-input rule;
- both engine forms, exact to 1e-9, with the centring on and off;
- that magnitude 0 is the standard curve exactly;
- that a v1 record is byte-identical;
- the contract gating (an unpriced magnitude never reaches the engine);
- the artifact's provenance and verdict;
- the published 2026 record (Georgia and Ohio State at zero; Iowa State and North Texas new coach, new QB, bottom
  decile);
- `qbChangeOf`.

### #2 — A σ-scaled EV plausibility check replaces the flat 25% guard (VERIFIED MAJOR is reachable)

**Root cause.** The first fix bounded raw EV at a flat 25% on a main-line spread. EV is a price-dependent function of
the gap measured in the game's own distribution width, so "25%" meant a different gap in every game. At −110 a
college gap of about 6 points already prices past it.
- A synthetic game that passed every gate read INVESTIGATE ("implausible EV") at every gap of 7+ pts, for any σ from
  13 to 16.
- On the 2024-2025 holdout the flat bound flagged **19.7%** of real college games and **26.0%** of NFL games.
- It left VERIFIED MAJOR reachable on **2.6%** of real CFB 7+ gaps, and on **0%** of NFL ones.

**Change.**
- `lib/edgedesk_quote_ev.js` `implausibleEv(g, model)`: a main-line quote is implausible when
  `z = |fair home margin − the quote's home margin| / σ` exceeds `PLAUSIBLE_Z[sport]`.
  - σ is `distributionSpread(model.home_cover)`: half the central-68% width of the same distribution the EV is priced
    from.
  - Where no width can be read (no fitted sport), the flat 25% bound applies and says so.
- `tools/football/ev_plausibility.js` fits z* as the declared 99.5th percentile of z over correctly-joined games in
  2021-2023, from cold replays of both shipped engines. The market is never an input to a projection. It then scores
  2024-2025 once. The result is `football/validation/ev_plausibility.json`: CFB z* = **0.960** (≈15.7 pts at the
  typical σ 16.3), NFL z* = **0.997** (≈13.0 pts at σ 13.0).
- **The stake is not loosened.** The flat 25% line is kept as `large_ev`, read only by the decision layer's new
  `LARGE_EV` cap (WATCH, no stake). Every decision the old guard held at WATCH is still WATCH with 0 units. A plausible
  large gap now reads VERIFIED MAJOR as a research status, and still carries no stake.
- `lib/edgedesk_canon.js` prints the quote-EV layer's own reason. `lib/edgedesk_decision.js` words IMPLAUSIBLE_EV in σ
  terms.

**Holdout (2024-2025, never fitted).**

| | CFB σ-scaled | CFB flat 25% | NFL σ-scaled | NFL flat 25% |
|---|---|---|---|---|
| real games flagged | 0.69% | 19.7% | 0.18% | 26.0% |
| real 7+ gaps left reachable for VERIFIED MAJOR | 95.2% (of 229) | 2.6% | 98.4% (of 62) | 0% |
| synthetic flipped side caught, with the orientation invariant and the 21-pt guard | 74.6% | 92.5% | 39.8% | 77.0% |
| synthetic mis-joined market caught, same stack | 47.5% | 81.7% | 17.8% | 60.9% |
| synthetic line off by 7 pts caught, same stack | 13.2% | 98.6% | 19.3% | 99.8% |

**What this costs.** Most of the old guard's catch rate came from flagging one real game in five. A line that is wrong
by 7 points cannot be told apart from a real 7-point disagreement by its size alone. That job belongs to the checks
that look at the quote rather than the gap:
- the market-consensus MARKET FAULT (first pass #2/#3);
- the stale-capture rules;
- the integrity gate that VERIFIED requires.

This is stated, not tuned away.

**Tests.**
- `tools/football/quote_ev.test.js` §14 (rewritten for the new rule):
  - the σ reading;
  - a 1.04 σ gap is implausible;
  - a +30% EV at 0.61 σ is not implausible, but is LARGE;
  - an alternate is exempt;
  - the flat fallback;
  - the constants equal the fitted artifact, and the artifact's holdout numbers;
  - **verified 7, 7.5, 9 and 11-pt college gaps at −110 read VERIFIED MAJOR**;
  - a 16-pt gap is still "implausible EV, check data";
  - an NFL 7-pt gap reads VERIFIED MAJOR.
- `tools/bettor/football_decision.test.js` and `tools/bettor/decision.test.js`: six scenarios move from WATCH ·
  IMPLAUSIBLE EV to WATCH · LARGE EV, all still with no stake. The gaps past z* stay IMPLAUSIBLE EV.

### #3 — A disagreement explainer (North Texas @ Tulsa, Syracuse @ UConn)

**What was missing.** A research label says how large a disagreement is and whether it passed the integrity gate. It
never says why. The 2026-09-27 forensic report decomposes EdgeDesk's number, not the gap between it and the market.

**Change.**
- `lib/edgedesk_explainer.js` splits a gap into eight terms read off the engine's own projection:
  - the rating scale;
  - last season's share of the rating, `w·(long-run − this season − track offset)`, and that share on a turned-over
    roster;
  - the home-field constant;
  - QB change;
  - conference;
  - matchup;
  - the rest.

  None of the terms comes from the market.
- `tools/football/explainer_fit.js` fits how much of each term the closing market has historically taken out. It runs
  OLS of `fair − close` on the terms over 2021-2023 FBS games (cold replay, `replay_rows.js --explainer`), scores
  2024-2025 once, and ships a 2021-2025 refit (`football/validation/disagreement_explainer.json`).
- Explained is the intercept plus Σ β·term. Unexplained is the rest.
- `football/cfb_p4/engine.js` publishes the tracks' centres in `layers.strength.track_centres`, for display only; no
  number reads them back.
- `football/fbs/build_coverage.js` publishes the market-free terms in `disagreement_inputs.explainer_terms`.
- `football/cfb_terminal/build.js` explains each game against the consensus it already shows (`games.json`
  `disagreement_explainer`, and a compact form in `board.json`).

**The fit (2021-2023, every term |t| ≥ 1.96).**

| term | β | what it says |
|---|---|---|
| home field | +0.43 | the market gives about 1.8 pts less home edge than the engine's 4.08 constant |
| QB change | +0.50 pts | the market prices a new starter the engine's (usually unavailable) QB term does not |
| last season's share | −0.42 | the market leans on last season *more* than the engine's this-season track does |
| …on a turned-over roster | +0.50 | …except on a turned-over roster, where it takes that back (net ≈ +0.08) |
| conference | +0.19 | |
| rating scale | −0.03 | |

- Matchup and "other" are 0 in every replayed game, because the cold replay has no efficiency or injury feed. They
  ship unfitted: shown, never discounted.
- **Holdout 2024-2025: R² = 0.03.** Mean |gap| 3.92 against mean |unexplained| 3.67; for 7+ gaps, 9.85 against 8.74.
  The measured terms explain a sliver of model-market disagreement, and the explainer says so rather than overstating
  it.

**Applied (terminal build of the committed 2026-09-30 captures, SNAPSHOT).**

| North Texas @ Tulsa: gap 10.74 toward North Texas (market Tulsa −1.5, one book) | term | β | explains |
|---|---|---|---|
| last season's share | −7.56 | −0.36 | +2.74 (toward Tulsa) |
| …on a turned-over roster (North Texas, index 0.86) | −4.84 | +0.48 | −2.33 (toward North Texas) |
| home field | 4.08 | +0.39 | +1.60 |
| rating scale | −10.89 | −0.02 | +0.21 |
| matchup (unfitted) | −2.44 | — | 0 |
| **unexplained** | | | **12.87 toward North Texas** |

The measured terms, taken together, lean 2.1 pts toward Tulsa, so nothing measured explains this gap. Even on this
season's centred track alone, North Texas rates about 4 pts better than Tulsa, and the market disagrees with that as
well. What remains is the market's view of this season's North Texas.

| Syracuse @ UConn: gap 14.25 toward UConn (market Syracuse −6.5, stale) | term | β | explains |
|---|---|---|---|
| home field | 4.08 | +0.39 | +1.60 |
| last season's share | +2.60 | −0.36 | −0.94 |
| …on a turned-over roster (UConn, index 0.87) | +0.58 | +0.48 | +0.28 |
| **unexplained** | | | **13.47 toward UConn** |

It remains DATA FAULT ("possible orientation flip", first pass #5) at a stale capture.

**Tests.** `tools/football/explainer.test.js` (21 checks, added to `football:audit:test` and `cfb:test`):
- the terms are exact pieces of an engine projection (prior share with the published offset, turnover index,
  contributions, QB change), with no market argument;
- explained + unexplained = the gap;
- unfitted terms are shown, never discounted;
- the fit's windows, significance flags and unfitted list;
- the slate and terminal wiring.

### #5 — A closing-line-value validation report

**What was missing.** The existing movement validation (`football/validation/movement_cfb.json`) tests CFBD's pregame
Elo, not EdgeDesk's own number. The scorecard has 6 packets and no reading. Nothing answered whether the market moves
toward EdgeDesk between the opener and the close.

**Change.** `tools/football/clv_report.js` writes `football/validation/clv_report.json`. Nothing is fitted, and the
market is never an input. Per game, on home margins:
- side = sign(fair − open), with no side under 0.5 pt;
- CLV points = side × (close − open);
- CLV probability = the cover probability of that side at the opener, on a distribution centred at the close, minus
  the same at the close.

Each sample reports games, the rate at which moved lines moved toward EdgeDesk (two-sided binomial p), mean CLV with a
bootstrap 95% CI, per season and per gap bucket. Samples under 100 moved games read "too small to read".

**Result.**

| sample | games | moved toward EdgeDesk | p | mean CLV (pts) | CLV (prob) |
|---|---|---|---|---|---|
| **CFB replay 2022-2025**, the engine's held-out window (hyperparameters tuned 2018-2021) | 2,843 | **52.9%** of 2,492 | **0.005** | **+0.21** [+0.13, +0.29] | +0.53 pp |
| …gap 0.5-2 | 737 | 53.2% | 0.11 | +0.16 [+0.02, +0.30] | +0.41 pp |
| …gap 2-4 | 846 | 51.2% | 0.56 | +0.10 [−0.03, +0.23] | +0.28 pp |
| …gap 4-7 | 795 | 52.1% | 0.27 | +0.21 [+0.06, +0.36] | +0.54 pp |
| …gap 7+ | 465 | **56.6%** | **0.009** | **+0.47** [+0.23, +0.74] | +1.19 pp |
| CFB replay 2021 (in-sample for the engine's tune; never pooled) | 686 | 50.8% | 0.74 | +0.12 [−0.01, +0.26] | +0.25 pp |
| CFB 2026 live (frozen record numbers vs the Model Lab's earliest capture) | 68 | 45.1% of 51 | 0.58 | +0.04 [−0.24, +0.35] | too small to read |
| NFL 2026 live (EdgeDesk's own opener ledger; no historical NFL openers exist) | 29 | 71.4% of 21 | 0.08 | +0.45 [−0.28, +1.14] | too small to read |

- By season 2022-2025 the toward-rate is 50.3%, 54.0%, 52.6% and 54.2%.
- *(Intervals corrected in the second follow-up: the report's bootstrap generator cycled, so the first-published
  intervals were too narrow. The 2-4 bucket and the 2021 sample no longer exclude zero; the headline still does.)*
- The college engine's pregame number has shown small, positive, statistically significant CLV on its held-out window,
  concentrated in the 7+ gaps.
- **This is a replay, not a record.** The replay's state is the one at kickoff, which also holds other games played
  between the opener and kickoff.
- The two live 2026 samples are too small to say anything yet.

**Tests.** `tools/football/clv_report.test.js` (16 checks, in `football:audit:test`) covers:
- the sign conventions;
- no side under 0.5 pt;
- a missing line is no CLV;
- the NFL price value;
- the summary arithmetic and the floor;
- the artifact's windows (headline 2022-2025, 2021 apart);
- that the market is not an input and nothing is fitted;
- that each reading follows its own numbers.

### #6 — Re-run both boards live: not possible from this environment

The live capture host (`iattxbkbufslbauoumga.supabase.co`) is denied by this environment's network policy. So are The
Odds API, CollegeFootballData and the SBR odds archive. No board was re-run live. The before/after tables in the PR
use the latest bot-committed captures, and every row is labelled SNAPSHOT with its capture time.

## 2026-09-30 — audit fixes: Week 5 CFB / Week 4 NFL board

These fixes come from a manual audit of the Week 5 CFB / Week 4 NFL board. They are listed in the audit's priority order.
No research gate or label definition was loosened. Where two copies of a rule disagreed, the stricter one was kept.
The "research, not picks" framing is unchanged.

### #1 — Regime change (Iowa State, North Texas, Penn State)

**Root cause.** Every programme's pricing state used one learned prior curve (`football/cfb_p4/params.js`,
`blend.prior_weight_by_week`): 100% long-run rating through 3 games, 80% at 4–5, 60% from 6.

For a programme whose coach and roster left, most of the Week 5 number still described the team that left:
- Iowa State: Campbell to Penn State.
- North Texas: Morris and the roster to Oklahoma State.
- Penn State: Franklin out.

Nothing in the repository supplied a coaching-change or roster-turnover signal. The coach table also had no 2025 row for
Penn State or Virginia Tech, so their changes could not be dated.

**Change.**
- `football/coaching/regime_signal.js` (new) holds the one definition of the signal, used by the fit, the builder and the
  tests. The signal fires on a new head coach AND roster continuity at or below the season's FBS median, or transfers out
  at or above its 75th percentile.
- `football/coaching/build_regime.js` (new) writes `football/coaching/regime.json` from:
  - `continuity.json`
  - the ESPN rosters, diffed on athlete id
  - `returning_production_2026.json`
  - `regime_overrides.json`, a hand-maintained, dated and sourced table (`team, season, new_coach,
    returning_production_pct`), documented in `football/coaching/README.md`
- `football/coaching/build_coaching.js` now walks back past a missing season when dating a tenure.
- `football/cfb_p4/research/regime_backtest.js` fits a separate, steeper curve walk-forward, on seasons before each one
  it is scored on: `w = min(w_standard(g), w0·e^(−λg))`, with w0 = 0.75 and λ = 0.02.
  - The fitted curve is written to `football/cfb_p4/regime_curve.js`.
  - The engine (`blendedRating`) applies it to a regime programme's long-run state.
  - The flag is also carried on a promoted canonical rating.
- **REGIME CHANGE flag.** `lib/edgedesk_canon.js` blocks WORTH RESEARCHING and VERIFIED MAJOR until the team has played
  N = 6 games. The status reads INVESTIGATE, with the flag and the team named.
  - N comes from the held-out cover-rate table: the first 2-game bucket from which regime games cover within 2.5 pp of
    every other game.
- The board, the published build (`football/fbs/build_coverage.js` via `football/matchup/contract.js`), the research
  terminal and the props model all read the same record.

**Backtest.** Held-out 2014–2025, 2,203 games involving a regime team (`report/regime_backtest.json`):

| metric | standard curve | regime curve |
|---|---|---|
| MAE vs the final margin | 13.475 | 13.445 |
| mean \|fair − close\| | 4.249 | 4.206 |

- The MAE change is −0.030, 95% CI [−0.063, −0.006], and 7 of 12 seasons improved.
- **Corrected (second follow-up):** that interval came from a bootstrap whose generator cycled after ~10,466 draws.
  Re-run with an exact generator it is −0.032, CI [−0.095, +0.033]: **not significant**. The artifact now records
  `significant: false`.
- The engine self-check re-projects 128 games; they match the counterfactual to 7e-15.

**Tests.**
- `tools/football/regime.test.js` covers the signal, the walk-back, the fitted curve, the engine shift (exactly
  (w_regime − w_standard)·(long-run − this season)), the contract, the research gate, the season record, the overrides and
  the published slate.
- `tools/football/label_parity.test.js` checks Pitt @ Virginia Tech in every view.

### #2 — Stale CFB market capture

**Root cause.** `fbP4Market` (app.html) used cfb.lines whenever the captured quote was older than its freshness window.
cfb.lines carries no book and no timestamp, and the board treated it as a current market (`stale: false`).

The gap, the label and the research priority were therefore measured against a different snapshot from the one the price
line prices, which reads captured quotes. The captured number itself was the first home `spreads` row returned (see #3).

**Change.**
- The market is the consensus of the CURRENT captured quotes (`fbMarketFromEvent`), which is the snapshot the price line
  prices.
- With no current quote, the consensus of every row is marked stale.
- cfb.lines is kept only as a labelled reference. Used alone it is STALE and reads STALE MARKET, and it is excluded from
  ranking (`rankable: false`).
- **Invariant.** |market spread − consensus of its own quotes| ≤ 1.5, else MARKET FAULT with the reason
  (`EDCanon.marketConsensusFault`). A MARKET FAULT is excluded from ranking.

**Tests.** `tools/football/market_join.test.js` (new), `tools/football/fbs_board_ui.test.js`,
`tools/app/worth_researching_ui.test.js` (reference-only fixtures read stale) and `tools/validation/canon.test.js`.

### #3 — NFL market mapping (SEA −3.0, BUF −3.0)

**Root cause.** `fbMarketFromEvent` took whichever home `spreads` row PostgREST returned first. It set the market's time
to the newest capture of any row.

`signals` keeps a row per point for good, and the capture files alternates under `market='spreads'`. So an August
look-ahead or an alternate at −3 stood as "the market" and looked minutes old, while every book dealt −6.5/−7.

**Change.**
- The main line is the books-weighted mode among the capture's modal rows, falling back to all current rows. It is
  timestamped by its own capture.
- **Self-check.** `fbNflMarketSelfCheck` fails the board (a banner above the rows) if any game's main line sits more than
  1.5 pts from the books-weighted median of its own captured books. That game reads MARKET FAULT.

**Tests.** `tools/football/market_join.test.js` (new) replays the audit's row order and covers:
- the self-check failing the board
- stale-only and reference-only markets
- the college path

`tools/articles/pipeline.test.js` also pins the sign convention of a replayed quote.

### #4 — NFL EV on the opposite side from the displayed model

**Root cause.**
- The NFL cover probabilities came from the margin tables centred on their mean, not their median. A table's median sits
  1–2.5 pts inside its mean, so at the market line the distribution could favour the side the displayed fair margin was
  against.
  - LAC @ SEA, model SEA −9.24, line −7: SEA −7 priced 49.6% and LAC +7 50.4%.
  - NE @ BUF, model BUF −7.18, line −7: NE +7 priced 56.2%, +6.9% EV.
- Separately, the NFL pricing blend could cross the market to the other side. CIN @ MIA: the model has CIN by 1.8, the
  market CIN −8.5, and the blended fair line was CIN −8.66, so the priced side was CIN.

**Change.**
- `football/engine.js` `centredOn` mixes adjacent tables so the distribution's continuous median is the fair margin
  exactly. Past one side's range it mirrors the other side's table; past both, it shifts the nearest extreme table.
- The kernel (`_pricing.js`) and the board hold the blend at the model side's 50% cover point when it would cross the line
  (BLENDED_HELD).
- **Invariant** (`lib/edgedesk_quote_ev.js` `sideInvariant`), checked on the one projection object that feeds both the
  display and EV:
  - If the model is past the line on side X, no side-Y quote at the same or a worse number may carry positive EV.
  - A violation is EV_SIDE_CONTRADICTION: NO DECISION, logged to `console.error`.
  - A display/EV centre mismatch of more than 0.5 pts is PROJECTION_MISMATCH.
- `tools/football/build_nfl_slate.js --reprice` recomputes the slate's pricing block.

**Tests.**
- `tools/football/quote_ev.test.js` §14: medians, sides, spikes, LAC @ SEA, PROJECTION_MISMATCH, and a reproduction of
  the old table off-centre.
- `tools/bettor/football_decision.test.js`, `decision.test.js`, `consistency.test.js`
- `tools/intelligence/pricing.test.js` (the kernel hold)

### #5 — Orientation flip (Syracuse @ UConn)

**Root cause.** The join was oriented correctly: UConn hosts, and the captured event resolves home and away strictly. The
number was not.

`situation.conference` in `football/cfb_p4/engine.js` treated "FBS Independents" as a conference. The group's 2025
cross-conference strength (+15.21, the highest of any group) is an average over unrelated programmes. It handed UConn
+3.8 pts over every ACC team early in the season. On top of that, UConn is in a regime change (#1).

**Change.**
- An independent carries no conference strength. The term is unavailable and says why. Two conferences still get the term.
- **Invariant** (`EDCanon.orientationSuspect`): a gap over 10 pts that flipping the model's sign would bring under 5 is
  DATA FAULT "possible orientation flip".
  - The game is excluded from ranking until resolved. Only a VERIFIED gap is exempt.
  - The check applies to both the CFB and NFL boards and the terminal.

**Backtest.** Held-out 2014–2025, the 522 games of an independent against a conference team
(`football/cfb_p4/research/independents_backtest.js`, `report/independents_backtest.json`):

| metric | before | after |
|---|---|---|
| MAE vs the final margin | 13.376 | 13.185 |
| mean \|fair − close\| | 4.914 | 4.800 |

- The MAE change is −0.192, 95% CI [−0.409, +0.033], so it is **not significant**. 8 of 12 seasons improved.
- The fix ships as a correction of what the term measures, not as a fitted gain.

**Tests.** `tools/football/orientation.test.js` covers the term, the invariant, the NFL board and the published slate.
`tools/bettor/football_decision.test.js` checks that Syracuse @ UConn gets no decision.

### #6 — Pitt @ Virginia Tech: conflicting labels

**Root cause.** Each view carried its own copy of the research rule:
- the board word
- the research view
- the Research Desk's row flags (`thin` from the engine's PASS_LOW_CONFIDENCE, `fault` from the guard gap alone)
- the offline exporter (`football/cfb_p4/export_csv.js`, "RESEARCH" for every gap under 7)
- the press brief (`tools/football/press_brief.js`, a copy of the page's old rule)
- the research terminal's seven-word status, which its brief prints

None of the copies had the stale-market, orientation, regime or implausible-EV rules. They could also disagree with each
other on the confidence and reliability floors.

**Change.**
- `lib/edgedesk_canon.js` `researchStatus` is the one classifier. Where two copies disagreed, the stricter rule was kept:
  unmeasured reliability is not a pass.
- `EDCanon.boardWord` names its result on the board. All of these now read it:
  - `fbP4StatusFor`
  - the research view
  - `fbGameRows` (the Desk and Top Research Priorities: thin, fault and stale are read off the canonical status)
  - the RESEARCH FLAGS queue (shows the word and excludes non-rankable statuses)
  - the CSV export
  - the counters
  - the offline exporter
  - the Read (`lib/edgedesk_read.js`)
  - the press brief, which reads the CSV's `board_status` and classifies nothing
- The terminal's seven-word status is reconciled to the canonical status. It can only be made stricter.

**Tests.** `tools/football/label_parity.test.js` (new) stages Pitt @ Virginia Tech with Virginia Tech in a regime change,
alongside aligned, research, orientation-flip and thin-data games. It checks that the label is identical across:
- the board, the card and the CFB desk
- the Desk rows and picks
- Top Research Priorities
- RESEARCH FLAGS
- the CSV export and the counters
- the offline exporter
- the press brief
- the research terminal

`tools/football/press_brief.test.js` pins the brief to the canon.

### #7 — Player props

**(a) Edge and EV at one quote.**
- Root cause: the table's Edge column showed the model at the consensus line minus the consensus no-vig (`edgeNv`), which
  is a different line and a different price from the EV beside it. A LEAN could show a negative edge.
- Change: the column shows the candidate's own edge (probability minus the break-even of the same book, line and price as
  the EV). The consensus comparison is labelled "nv".
- Self-check: `EDProps.edgeEvAgree` means a BET or LEAN without a positive edge AND EV at its quote is demoted to WATCH
  (EDGE_EV_MISMATCH, logged).

**(b) Correlated props.**
- Root cause: the correlation model lists no pair for most cross-player props, so √(uᵀRu) summed eight 0.25U Colts props
  as independent and the 2U game cap never bound. All 8 NFL BETs were IND @ WAS, 7 of them on the Colts' offence having a
  quiet day.
- Change: every selection that wins when one offence in one game has a big (or a quiet) day is one exposure group. The
  group carries at most the stake of its largest member (GROUP_EXPOSURE), and a defender's prop is grouped on the offence
  it plays against.

**(c) Opponent defensive availability.** It is not a model input: the defensive factors are season-to-date rates. It is
now a warning flag, OPP_DEFENSE_UNMODELED, which names the defenders the opponent's latest report lists OUT or DOUBTFUL
and which week's report that is.

**(d) Regime and usage/volume priors.** On a regime-change programme, last season's share prior and team volume are scaled
by the fitted regime curve relative to the standard curve. REGIME_CHANGE caps the prop below BET until N games.

**Week bug.** "Injury report on file" meant *any* team's report for this week, so a teammate the week-3 report listed OUT
read as back. IND's Alec Pierce did, and every Colts WR share was cut ×0.85. Now:
- the on-file flag is team-specific
- a teammate listed OUT on an earlier report, with his team's current report not on file, is PENDING: no dilution and no
  redistribution
- the prop carries a teammate-uncertain flag
- the player's own earlier listing caps at WATCH (AVAILABILITY_PENDING)

**(e) Tail pricing.** Every alternate line is flagged "tail pricing, uncalibrated" (TAIL_PRICING_UNCALIBRATED) and never
reaches BET.

**Tests.**
- `tools/props/props_core.test.js`:
  - the tail A/B: the same quote is a BET as a main line and a LEAN as an alternate
  - the regime cap, `edgeEvAgree` and the opponent warning
  - exposure groups, including the audit's Colts group on the real correlation model
- `football/props/pipeline.test.js`: the week bug on the fixture (Jayden Reed), the Edge column, and the opponent's
  availability.

### #8 — EV sanity guard (all sports)

**Root cause.** Nothing bounded a spread EV. A main-line spread at +30–45% raw EV, which is almost always a data error
(a stale or mis-joined line, a flipped side), could drive a BET. Player props already had their own bound: PRICE_ANOMALY
caps an uncorroborated EV above 15% at WATCH.

**Change.** Raw EV above 25% on a main-line spread sets the research status to INVESTIGATE, "implausible EV, check data"
(`EDCanon`, rule `implausible_ev`, still rankable but penalised). It also caps the decision at WATCH
(`lib/edgedesk_decision.js`) on the CFB board, the terminal and the NFL board.

**Scope.** The guard applies wherever `lib/edgedesk_quote_ev.js` evaluates a main-line spread. That is every sport this
board prices spreads for (CFB, NFL). The other sports' pipelines price no main-line spread through this path.

**Consequence.** Against live quotes a CFB main-line gap of roughly 5.5–6 pts or more already prices above 25% raw EV, so
a verified 7+ gap reads INVESTIGATE (implausible EV) and VERIFIED MAJOR is effectively unreachable at a live price. That
is a consequence of the bound the audit set, stated here rather than tuned away.

**Tests.** `tools/football/quote_ev.test.js`, `tools/bettor/football_decision.test.js` and `tools/bettor/decision.test.js`.

### Artifacts rebuilt

Everything below was rebuilt with the fixed code on top of the current `main` data. The build times match the base's
latest (2026-09-30 16:00–16:07Z), so the data is the same and only the code differs.

- `football/coaching/regime.json`, `continuity.json` and `returning_production_2026.json`
- `football/fbs/slate.json`, `coverage.json`, `reliability.json` and `football/enrichment/audit.json`
- the research terminal's published files (`football/cfb_terminal/*.json|csv`, `--now` the base's build time); the
  append-only history was not written
- `football/nfl/slate.json` (repriced)
- the NFL and college props boards (at the base's board times); the decision ledgers were not appended
- `football/matchup/metrics.json` and `football/validation/model_health.json`
- `football/cfb_validation/*`, with PATCH rows for the pricing and research code changes

New scripts: `npm run football:audit:test` (regime, orientation, label parity, market join). The same tests were added to
`cfb:test`.
