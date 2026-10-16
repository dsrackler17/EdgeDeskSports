# Model-first game research and automated matchup graphics: audit and plan

Date: 2026-10-16. Branch: `claude/model-first-research-graphics`.

## 1. What the audit found

| Question | Answer (file:line at `a2fdcd9`) |
|---|---|
| NFL model | `football/engine.js` runs **in the browser** (`fbPredict`, `app.html:50421`) on live nflverse CSVs. The same engine runs in Node in `tools/football/build_nfl_slate.js` → `football/nfl/slate.json`: fair line, total, win probability, fair ML, the linear model's own additive terms, outcome range, `cover_curve` from the engine's margin PMF, scenarios, data quality, team ratings and ranks (`teams[code].ranks`). |
| CFB model | `football/cfb_p4/engine.js`, also in the browser (`fbP4Card`, `app.html:57138`) and in Node: `football/fbs/build_coverage.js` → `football/fbs/slate.json`; the hourly `cfb-lab` job turns it into `football/cfb_terminal/{board,games}.json`. `games.json` carries the engine's additive margin terms (`why.rows`, `reconciles: true`), quantiles, the 80% range, matchup cards, QB status and reliability. Unit ranks (run/pass offense and defense, special teams, continuity, OL/DL) are in `football/rankings/current.json`. |
| Research snapshot | `football/cfb_terminal/history/<season>/research_snapshots.jsonl` → `supabase/research_snapshots.sql` (CFB only, append-only, market-state columns). No NFL equivalent, and nothing a graphic can be drawn from. |
| Market dependency | The game cards put `fbDecCardHTML` (the EDGEDESK DECISION card) **first** (`app.html:50553`, `57279`). With no fresh quote, `lib/edgedesk_decision.js:1316` returns `NO_DECISION / STALE_QUOTE` and the card leads with it; the model's projected score, drivers and ranks are not on the NFL card at all (only inside the Game brief). |
| Graphics | `lib/edgedesk_share_card.js` (Canvas 2D, content → layout → draw, 1600×900 and 1080×1080) makes a text card of fair line, market, gap and reliability. No matchup graphic, no team identity, no automation. |
| Levels | Beginner / Research / Lab live in `lib/edgedesk_decision_ui.js:438` and apply to the decision card only. On the NFL card "View full research" targets a `data-edd-research` wrapper that does not exist. |
| Compare My Number | `EDPersonal.compareNumber` (`lib/edgedesk_personal.js:815`) compares a reader's fair spread/total. No price, no probability. The validated price check exists separately: `lib/edgedesk_fairline.js` `priceCheck` (calibration status, held-out bands, VALUE only when CALIBRATED) over `football/linemaker/fair_lines.json`. |
| Deployment | GitHub Pages from `main`; no build step; `lib/*.js` load by `<script src>` with a `?v=` cache-buster. Generated artifacts are committed by scheduled jobs (`tools/ci/push_generated.sh`). Tests are plain `node file.js`; e2e uses Playwright + Chromium with a local static server. No lint/typecheck beyond `node --check`. |

## 2. Architecture

```
 committed model artifacts ──► tools/football/build_game_research.js ──► football/game_research/current.json
 (nfl/slate, fbs/slate,          (hourly, cfb-lab job; no network,        (Layer A: one snapshot per game,
  cfb_terminal/games,             no market read)                          one timestamp, content-hashed id)
  rankings/current,                       │                               football/game_research/probabilities.json
  today/slate for records)                │                               (fair-line sheets from the SAME slates)
                                          └──────────────────────────────► football/game_research/history/<season>.jsonl
                                                                           (append-only, one row per changed snapshot)

 app.html: the reader's market join ──► Layer B (optional): LIVE / CACHED / STALE / UNAVAILABLE, with time and book

 lib/edgedesk_game_snapshot.js   Layer A builder, insights, consistency checks, the three availability states,
                                 Layer B normaliser, compare-a-price (EDFairLine.priceCheck)
 lib/edgedesk_game_graphic.js    deterministic matchup graphic: content → layout → draw (Canvas 2D), PNG,
                                 1080×1080 and 1080×1350, cache by snapshot id + market fingerprint + template
 lib/edgedesk_game_view.js/.css  #game/<league>/<id>: graphic first, What to Watch For, Beginner/Research/Lab,
                                 optional market comparison, Compare my number with a price
```

**Rendering choice: Canvas 2D in the browser, laid out by a pure function.** It is the pattern the repo already
uses (`EDShareCard`, `EDRecordCard`), it needs no dependency or server, it exports PNG with `toBlob`, it shares
through the Web Share API, and the layout is plain data that Node tests can check (every number present, nothing
outside the canvas, nothing overlapping). A server-rendered PNG would need headless Chromium in every scheduled job
and would commit binary churn to git every hour; a deterministic render of a stored snapshot reproduces any
historical graphic byte-for-byte instead. `tools/football/render_game_graphics.js` batch-exports PNGs with the
same code through Playwright for the owner's social posts, skipping snapshots already rendered.

## 3. Phases

1. Layer A snapshot module + builder + history ledger; consistency checks (scores reconcile, probabilities sum to
   100%, cover ≠ win, reliability ≠ probability). Insights chosen from measured data only.
2. Matchup graphic renderer (both formats) with branding, team colours/monograms, projection, insights, market
   panel only when a LIVE quote exists, otherwise model-derived detail. Visual check through Playwright.
3. Game research view and routing; "Game research" entry on every NFL and CFB card; `fbOpenGame` opens it.
4. Decision card: a market-only blocker (stale/no quote) becomes a compact "market comparison not evaluated" note
   below the model; the blocker code moves to Lab. Genuine model faults still lead.
5. Compare my number with a price (spread / total / moneyline + American odds) through `EDFairLine.priceCheck` on
   the snapshot's own probability sheet; labelled "User-entered, unverified sportsbook quote".
6. Hourly build hook, tests (fresh/stale/no odds, model fault, manual price, graphic accuracy, probability
   consistency, history, cache invalidation, 390 px e2e), docs.

Nothing in the existing engines, decision layer, market ingestion, quota gateway, bet tracking, portfolio,
auth or billing changes. Stale-market safeguards are untouched: the view only stops a market outage from
hiding the model.
