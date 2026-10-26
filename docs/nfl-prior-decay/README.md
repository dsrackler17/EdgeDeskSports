# NFL prior-season weighting: diagnosis, starter sync, an experimental decay, and the large-gap gate

This work started from one card: Week 7 SNF, KC @ SEA (2026-10-25).

- **The card:** SEA −4.4, 65.8%.
- **The market:** Kalshi SEA −3, 58.5%.
- **The disagreement:** 7.3 points of win probability.

| | What | Where |
|---|---|---|
| 1 | Diagnosis, written before any model change | [`DIAGNOSIS.md`](DIAGNOSIS.md), `tools/football/nfl_prior_diagnosis.js`, `football/validation/nfl_prior_diagnosis.json` |
| 2 | Data fixes: start history, the starter sync, the QB report as Observed (T0) | `app.html` `fbNflQbStarts`, `football/nfl/starter_sync.js`, `tools/football/nfl_starter_sync.js`, `football/injuries/fetch_injuries.js` |
| 3 | The v2 prior-decay experiment (preregistered, backtested, **rejected**, still experimental) | [`football/research/nfl_v2/prior_decay/`](../../football/research/nfl_v2/prior_decay/RESULTS.md), `supabase/nfl_prior_decay_registry.sql` |
| 4 | The large-gap gate, each chip's data window, Known Limitations (display, live) | `lib/edgedesk_game_snapshot.js`, `lib/edgedesk_game_graphic.js`, `lib/edgedesk_game_view.js` |
| 5 | Tests | `tools/football/nfl_prior_decay.test.js` (`npm run nfl:prior:test`) |

The served model is `edgedesk_nfl_v2.1.0`, and its weights are unchanged by everything here. The frozen CLV ranking
protocol is not touched: nothing here changes how an edge is scored or ranked. The gate changes what is *displayed*.

## 1. What the diagnosis found

Full detail is in [`DIAGNOSIS.md`](DIAGNOSIS.md).

**The 2025 prior drives Team Strength.**

- After 5–6 games the base-strength row is **70% carried 2025 prior**: +3.73 from 2025, −1.02 from 2026.
- On 2026 data alone the row is KC +1.35.
- The "#2 vs #7" efficiency ranks reverse on 2026 alone: KC #3, SEA #8.

**The QB chip is per player, but it is relative to the club's running QB level.**

- The quarterback's quality mostly lives in the team ratings, which decay slowly.
- So the chip can never hold a starter's 2026 play once the club level catches up.

**Large gaps are common and do not earn CLV.**

- 62 of 91 published Week 2–7 cards are more than 5 pp from the close.
- On those cards, CLV is a coin flip: +0.05 pts on the spread, −0.03 pp on the moneyline.

**Do not delete the prior.**

- Over 102 played 2026 games, the 2026-only replay's Brier is 0.2519.
- The served model's is 0.2344, and the close's is 0.2380.

## 2. Data fixes

**The start history read the schedule feed's stale pre-fill (bug).**

- nflverse `games.csv` never corrects a game's QB after kickoff. It still names Drew Lock for Seattle's Weeks 3–6,
  which Sam Darnold played.
- The board counted those as Lock's starts. Tonight's KC @ SEA regime line therefore read "regular starter (Drew Lock)
  out", and the "most recent other starter" picked for an injury replacement came from the same wrong history.
- Fix: a played game's start is now the passer the QB game log credits. That is the passer with the most dropbacks,
  the same rule that already moves his value and sets the model's own regular starter.
- The feed's id is used only for a game the log lacks.

**The starter sync** (`football/nfl/starter_sync.js`, `tools/football/nfl_starter_sync.js`).

- The model prices each starter's own value. Which starter is priced is decided at slate build time from three
  inputs:
  - the schedule feed's id;
  - the depth chart's QB1, reconciled against the last game's first dropback;
  - the injury report (OUT or DOUBTFUL forces a replacement).
- Every upcoming slate game now carries `starter_inputs`: each side's inputs and a fingerprint of them.
- The sync recomputes the fingerprints from the committed inputs. When any upcoming game's fingerprint moved, it does
  two things:
  1. rebuilds `football/nfl/slate.json` immediately, instead of waiting for the next scheduled build;
  2. appends each priced-starter change, with the number before and after, to `football/nfl/starter_sync/nfl_<season>.jsonl`.
- When it runs:
  - `injury-sync.yml` runs it after every injury fetch (every 6 h).
  - `starter-context.yml` logs the changes its own scheduled rebuild makes.
- The game cards follow at the next hourly build of `football/game_research/` (`cfb-lab.yml` is that directory's only
  writer).
- **The card says what changed.** It shows "Updated: SEA starter changed from Sam Darnold to Drew Lock" with both
  versions' win %, as the NHL card shows a goalie change (#774: `public.nhl_game_cards`, `lib/edgedesk_nhl_goalies.js`).
  - The slate carries the latest logged change per game (`starter_update`), and the research page shows it.
  - The NHL sync runs as a Supabase function polled every 5 minutes to puck drop. The NFL sync runs whenever its
    committed inputs refresh: the injury report every 6 h, and the depth chart with each starter-context build. The
    NFL has no scraped inactives list.

**QB injury designation and practice status, as Observed (T0).**

- Each priced starter carries `home_qb_report` / `away_qb_report`. These hold his line on the league's injury report:
  designation, practice status, injury and report week.
- Each report carries its source and two times:
  - **`retrieved_at`:** when EdgeDesk retrieved the report on file.
  - **`first_seen`:** when EdgeDesk's sync first saw that designation-plus-practice line. This comes from a new
    append-only ledger, `football/injuries/history/nfl_<season>_qb.jsonl`.
- nflverse's 2026 file carries no per-row publication time, so neither time is presented as the league's.
- The research page shows the report under **Quarterbacks** with an *Observed · T0* tag.
- Only OUT and DOUBTFUL change who is priced, as before.

## 3. The experimental v2 prior decay

Everything was fixed in [`preregistration.json`](../../football/research/nfl_v2/prior_decay/preregistration.json)
before any variant ran:

- the mechanism;
- the decay schedule;
- three variants;
- the selection rule;
- the promotion criteria, in three stages: validation, then one holdout look, then live CLV;
- the forking-paths count.

**The mechanism.** The prior is re-anchored to the starter's current-season EPA per dropback, shrunk toward his
pre-season value with `k_db` pseudo-dropbacks. So current-season QB play earns weight as the sample grows.

**The run.** One run on 2010–2024, scored on Brier and early-week-line CLV. The 2025 holdout was not predicted.

| | Result |
|---|---|
| Brier | 0.21757 vs 0.21761 for the served config |
| Log loss | slightly better |
| Margin MAE | slightly better |
| CLV | +0.656 vs +0.649 pts |
| Seasons with better Brier | 8 of 15; the rule needs 9 |

**The verdict.** REJECTED; it stays `experimental`, `passed = false`, and it never prices a live card.

The shadow run shows *why* it does not fix KC @ SEA: the QB-anchored term moves that game 0.15 pts. The gap sits in the
team points and EPA priors. Faster team-level decay was already rejected in round 1, so a new team-decay family needs
its own registration.

Details: [`RESULTS.md`](../../football/research/nfl_v2/prior_decay/RESULTS.md).

## 4. The large-gap gate (display, live now)

The rule: if |EdgeDesk win% − market no-vig win%| > 5 points on an NFL card, no EDGE label is shown.

**Which markets are checked.** Every market on the card counts, and the largest gap decides:

- Kalshi's usable mids, both teams, de-vigged;
- the page's captured book moneylines;
- the snapshot's consensus moneylines.

**What the card shows instead.**

- **"Large gap vs market."**
- **The top contributing chip:** the card row pushing hardest toward EdgeDesk's side. Home field is named only if
  nothing else pushes that way.
- **That chip's season split,** for example "SEA +2.7: +3.7 carried from 2025, −1.0 from 2026".
- **That chip's data window,** for example "2025: 70% / 2026: 30%".

**Where it applies.**

- **Graphic:** the "EDGE: …" headline is withheld (and recorded as `edge.gated`). The table and the market strip read
  LARGE GAP VS MARKET.
- **Research page:** a panel at the top, and the decision layer's label is withheld on the page. The decision engine
  itself is unchanged.
- **College cards:** not covered. They keep their 7-point Kalshi note.

**Each chip's data window.**

- `football/nfl_model.js cardWindows` gives every card row the share of its inputs' weight that sits on:
  - the carried prior (last season's rating × 0.8, or a quarterback's value before this season's starts);
  - this season's games.
- It reads the same weights the ratings use and prices nothing.
- The slate carries the windows, and each chip shows its own ("2025: 70% / 2026: 30%").

**Known Limitations.** When any chip in the number leans more than half on the carried prior, the card adds:
"Known limitation: Team Strength (2025: 70% / 2026: 30%) relies more on the carried 2025 prior than on 2026 games…"

## 5. Tests

`node tools/football/nfl_prior_decay.test.js` runs 85 checks, offline, from committed files plus
`tools/football/fixtures/nfl_2026_w7_schedule.json`.

| Area | What the checks cover |
|---|---|
| **Prior weight by week** | the served schedule is v1's; the windows move week by week; the PD formula reproduces its preregistered schedule |
| **Starter changes** | fingerprints move only on a starter input; the sync marks the right side; starter changes are logged with before/after and the card carries "Updated: … starter changed from X to Y" with both win %; the QB report is T0 with source and times; the QB ledger; the stale-feed start history is fixed (regime reads Darnold) |
| **KC @ SEA replay** | the published card to the cent; the snapshot's chip windows and splits; Known Limitations; the gate against Kalshi and the consensus; the graphic beside a quote that would otherwise read "EDGE: SEA −2.5" now reads LARGE GAP VS MARKET with no EDGE text; the research page rendered with the panel, windows, limitations, a withheld LEAN, and the T0 QB report |
| **Gate rules** | 5.0 vs 5.1; the largest market wins; away-side Kalshi; the chip rule; NFL only |
| **Registration** | preregistered before results; holdout untouched; 3 variants counted; experimental; `passed` false; SQL current and applied to PostgreSQL |

## Not done

**Live cards before KC @ SEA's kickoff.**

- The slate and cards are rebuilt by the scheduled jobs after this merges. The starter sync and the gate apply from
  that build on.
- Until the slate is rebuilt with `card.rows[].window`, the windows and Known Limitations stay off the committed cards.
- The gate itself already works on today's snapshots: their rows carry the season split in points, so the chip is
  named with "carried from last season / from this season" until the window arrives.

**Kalshi closes are not in the repository.**

- They live in Supabase (`kalshi_closing_snapshot`). The diagnosis uses the de-vigged nflverse consensus close, which
  is 58.3% for KC @ SEA against Kalshi's 58.5%.

**The grading replay (`S.weekPreds`) still prices completed games with the feed's QB id.**

- That replay is frozen pregame by design, and the published record is untouched.
- The stale SEA Weeks 3–6 cards are documented in the diagnosis, not rewritten.
