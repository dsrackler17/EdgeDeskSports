# Opening lines: NHL, MLB, NCAAW, UFC, college baseball

The CLV programme asks whether the market moves toward a model's number after the OPENING line (`FINAL_REPORT.md`). These sports could not be tested:
- **NCAAW, UFC and college baseball:** no opening line with a matching close exists for them anywhere.
- **MLB:** no opener after 2021.
- **NHL 2026-27:** no opener for the current season.

An opener only exists if someone records it before the game. This folder is that record. It started on 2026-10-21.

It also keeps what ESPN still holds about finished games: see **The archive** below.

**Writer:** `research/clv/collect_openers.py`, run every hour by `.github/workflows/clv-openers.yml`.

**What it is not:**
- Nothing here is served or priced.
- No odds API credit is spent.

## Source

ESPN's public, keyless scoreboard: the same feed and the same plain request the slate (`tools/slate/espn.js`), the UFC ingest and the CFB lab already make from GitHub's runners.

| Sport | Feed | Read each run |
|---|---|---|
| `nhl` | `hockey/nhl` | today and the next six ET days |
| `mlb` | `baseball/mlb` | today and the next six ET days |
| `ncaaw` | `basketball/womens-college-basketball`, D-I (`groups=50`) | today and the next six ET days |
| `college_baseball` | `baseball/college-baseball`, D-I (`groups=50`) | today and the next six ET days |
| `ufc` | `mma/ufc` | this month and next |

**UFC fallback:** when a card's scoreboard carries no odds for a bout, the bout's odds are read from ESPN's core API (`…/events/{card}/competitions/{bout}/odds`). This happens every run inside 30 hours of the card, and every fourth hour before that.

**Which book:** ESPN names the book it quotes (DraftKings). Each odds object carries the number showing now and, nested, the book's own OPEN.

## Files

`<sport>/<YYYY-MM>.jsonl`:
- append-only;
- filed by the month a row was **observed**, not the month of the game;
- one JSON object per line.

`<sport>/backfill_<season>.jsonl` holds the archive (below). Only the backfill writes these files, and the hourly capture never reads them.

`summary.json` is rebuilt from both on every hourly run. For each sport and ESPN season it counts:
- from the hourly capture: games listed, games priced, games with ESPN's opener, and games settled with a close;
- `testable_live`: priced, with a later close (ESPN's close at settle, or a second quote of our own);
- `archive_games` and `archive_with_open_and_close`: finished games read back from ESPN;
- `testable`: games with either;
- the median hours between our first quote and the start.

## Rows

### `event`

Every listed game, or every UFC bout. Written when first seen and whenever its start, status, `time_valid` or sides change. Games already in play or over are not listed.

| Field | Meaning |
|---|---|
| `cid` | ESPN competition id. For team sports this is also the event id. For UFC it is the bout (`bout_id` in `model_loop/data/ufc/bouts.csv`) |
| `event_id` | ESPN event id (the UFC card) |
| `season`, `season_type` | ESPN's season label and type (1 pre, 2 regular, 3 post). NHL is labelled by its end year, as the repo does |
| `start_utc`, `time_valid` | ESPN's start. `time_valid: false` means a date with the time TBD |
| `status`, `state` | ESPN's status name (`STATUS_SCHEDULED`, `STATUS_POSTPONED`, …) and state (`pre`) |
| `neutral` | ESPN's neutral-site flag |
| `home`, `away` | `{id, abbr, name}`: ESPN team (or fighter) id, abbreviation, display name |
| `side_source`, `card`, `bout_number` | UFC only. `side_source` says whether home/away came from ESPN's `homeAway` or from the listing order |
| `observed_at` | when this run saw it |

### `quote`

A named book's pregame line. Written on first sighting and again on every change.

| Field | Meaning |
|---|---|
| `cid`, `book`, `observed_at` | the game, the book, and when this run saw the line |
| `ml` | `{home, away}` American prices. Both sides, or null |
| `spread` | `{home, home_price, away_price}`. `home` is the home side's line (−1.5 = home gives 1.5). Prices are null when ESPN did not give them. Not recorded for UFC |
| `total` | `{point, over, under}`. Not recorded for UFC |
| `open` | the book's opener as ESPN shows it, in the same shape as `ml`, `spread` and `total`. Present only on the row where it first appeared or changed |

**The first quote of a game is the earliest available line.** It is stamped, so an opener-time model number can be matched to it.

### `settle`

Written once per priced game, from ESPN's game summary.

**When:**
- 4 hours after the start, when the game is final;
- otherwise after 72 hours, recording what the summary says (postponed, suspended, no summary);
- a game that is quoted again after an unfinished settle is settled again.

| Field | Meaning |
|---|---|
| `status`, `completed` | ESPN's status at settle |
| `home_score`, `away_score` | final score |
| `books` | `[{book, open, close}]` from the summary's `pickcenter`. This is ESPN's own record of the book's open and close, so the close does not depend on when this job last ran |
| `error` | when the summary could not be read by the deadline |

UFC is not settled here. Its results come from `model_loop/data/ufc/bouts.csv`, and its close is the last pregame quote.

### `archive`

One row per finished game, read back from ESPN by `backfill`. It holds the `event` fields, plus `status`, `completed`, `home_score`, `away_score` and `books` as in `settle`.

There is no first-seen quote, so:
- the opener is the book's own, as ESPN kept it;
- there is no timestamp to match a model number to. An opener-time model number for these games has to be rebuilt from what was known the day before.

## The archive

ESPN's game summaries keep each book's open and close after the game. The probe of 2026-10-21 read four finished games on each sample day:

| Sport | Day sampled | Games with DraftKings' open and close |
|---|---|---|
| NHL | 2026-10-15 | 4 of 4 |
| NHL | 2026-01-15 | 4 of 4 |
| NCAAW | 2026-01-15 | 4 of 4 |
| College baseball | 2026-04-11 | 2 of 4 |
| MLB | 2025-10-01 | 0 of 4: no `pickcenter` at all |
| MLB | 2023-07-15 | none: a TeamRankings close only, which is refused |

So NHL 2025-26 and 2026-27 to date, NCAAW 2025-26 and part of college baseball 2026 can be read back. MLB after 2021 has to be collected going forward.

**To read it:** run the workflow by hand with `mode=backfill`, a `sport` and a range of ET days.

| Sport | Suggested range |
|---|---|
| `nhl` | `20251007` to yesterday |
| `ncaaw` | `20251103` to `20260406` |
| `college_baseball` | `20260213` to `20260623` |

**How a run behaves:**
- It reads up to `max_requests` and stops at a day boundary.
- Running it again over the same range resumes, because games already archived are skipped.
- Every final game is written, with `books: []` when ESPN kept no line, so the denominator is known and a resume never asks twice.

## Rules

- **Pregame only.** A quote is read only while ESPN says the game is `pre`, it is not postponed, cancelled, suspended or delayed, and its start has not passed. A game whose time is TBD counts until its day ends, Eastern. In-play prices are never read.
- **Named books only.** A nameless entry and any book named consensus, average or opening are refused, and so are TeamRankings and numberFire, stats sites whose lines older summaries quote.
- **One spelling per book.** ESPN writes "DraftKings" on the scoreboard and "Draft Kings" in game summaries. Both are stored as `DraftKings`, so a quote and its settle name the same book.
- **Orientation is checked, never assumed.**
  - An odds block whose side ids name the other team as home is refused.
  - A spread is taken from ESPN's side-labelled block first. Its flat fields must agree with it about who is favoured, or the spread is dropped.
  - In hockey and baseball ESPN's `details` text is the moneyline favourite ("TOR -205"), so it is never read as a spread.
  - ESPN does not label a UFC bout's sides, so home and away come from the listing order (`side_source: "order"`). The odds must confirm it, by the fighter id in their links or by the favourite their `details` names. Otherwise the line is refused ("sides not verifiable").
- **Sane numbers only.**
  - A two-way price pair must have implied probabilities summing to between 0.99 and 1.35.
  - Spreads and totals have per-sport bounds.
- **Nothing is inferred.** Whatever fails these rules is left out and counted in the run's report (`rejected`).

## Joining to the models

Every id here is ESPN's.

| Sport | Join |
|---|---|
| NCAAW | `game_id` and team ids in `basketball/data/ncaaw/*.csv` are ESPN's |
| UFC | `bout_id` and `event_id` in `model_loop/data/ufc/bouts.csv` are ESPN's |
| NHL, MLB, college baseball | the models key games by NHL API, Retrosheet and NCAA ids. Join on date and teams |

## Checking what ESPN carries

The pull-request run, and `workflow_dispatch` with `mode=probe`, print a read-only report. It writes nothing. Per sport it shows:
- the games listed, pregame and with odds;
- the first parsed quotes and one raw odds object;
- whether finished games' summaries still carry each book's open and close (the archive).
