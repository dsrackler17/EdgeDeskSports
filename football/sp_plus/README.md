# SP+ — an external estimate beside EdgeDesk's CFB number

SP+ is ESPN's opponent-adjusted efficiency rating, created by Bill Connelly.
EdgeDesk shows a line derived from it next to its own fair spread on every
college football card, and grades both against the close. It is a **second
opinion, never an input**. SP+ feeds no EdgeDesk projection, EV, ranking or
grade.

Why: on 2026-10-28 EdgeDesk had Middle Tennessee −4.5 against Kennesaw State.
SP+ had about Middle Tennessee −1, and the game closed Kennesaw State −1.5
(Kennesaw State won 44–28). A results-based number had missed a team that was
losing close games while playing efficiently.

## Provenance

| What | Tier | Meaning |
|---|---|---|
| SP+ rating | **T3 Research Model, external** | the output of a third party's model, not EdgeDesk's; EdgeDesk has not validated it |
| SP+ projected line | **T2 Computed** | a deterministic transform of the T3 rating (below) |

The tiers are the site's own (`RS_TIER`, `app.html`). "External" means it can
never appear as a validated EdgeDesk model.

## Terms and attribution

- **CollegeFootballData.com** (terms dated 2026-08-12, read as quoted in a
  public issue; the site was unreachable from the build environment):
  - commercial use is allowed on the free tier (§3);
  - "display reasonable portions of factual API Data as part of a larger
    product" is allowed (§4);
  - no standalone dataset, bulk download or "public database mirror" (§5);
  - the key stays server-side, never in a public repository or browser
    bundle (§2);
  - attribution is "appreciated but not required"; the recommended line is
    "Data provided by CollegeFootballData.com." (§6).
- **SP+ itself is ESPN's.** No licence for public commercial display was
  found, and none was obtained. The owner chose (2026-10-29) to show **the
  derived projected line only**, with attribution, and never a raw rating or
  rank on a page.
- Every surface carries: *Projection derived from SP+ (ESPN, Bill Connelly).
  Data provided by CollegeFootballData.com.*

What this means for storage: the repository is public and served by GitHub
Pages, so **no SP+ rating is ever committed**. Raw weekly ratings live only in
`public.cfb_sp_ratings`, which nobody but the service role can read.

## A · The weekly capture (`sync.js`, `cfbd.js`)

```
cfb-sp-plus.yml (Mon, retry Tue/Wed; or Run workflow)
  -> GET https://api.collegefootballdata.com/ratings/sp?year=<season>   (Bearer CFBD_API_KEY)
  -> parse: team + finite overall / offense / defense, or the row is rejected with its reason
  -> map: football/cfb_lab/identity.js (CFBD id when present, then name through
          the shared alias table); a prefix-only or ambiguous name is UNMAPPED
          and logged, never guessed
  -> public.cfb_sp_ratings     one row per team (append-only, service role only)
  -> public.cfb_sp_sync_runs   one row per attempt: OK / UNCHANGED / FAILED, with
                               every unmapped name and every rejected row
  -> football/sp_plus/lines.json   metadata and derived lines only
```

- **The week.** CollegeFootballData's `/ratings/sp` takes a year and a team,
  not a week. A capture belongs to the slate's current week
  (`football/fbs/slate.json` `current_week`), stamped with its capture time.
  There is no honest way to backfill past weeks.
- **UNCHANGED.** If the payload is identical to the previous week's capture
  (same sha256 of the values), SP+ has not been updated yet: nothing is stored
  or published for the new week, and the next scheduled run tries again.
- **Fails closed.** No key, an HTTP error, a payload that fails validation, no
  team mapped, no database credentials or an unapplied migration: the attempt
  is recorded in `lines.json` (`last_attempt`) and in `cfb_sp_sync_runs`, no
  capture is published, and the run fails.
- **Setup.**
  1. Apply `supabase/cfb_sp_plus.sql` (SQL editor or psql; idempotent).
  2. Add the repository secret `CFBD_API_KEY`; `SB_URL` and `SB_SERVICE_ROLE`
     already exist.
  3. Run *CFB SP+ weekly sync* once by hand.

```
npm run cfb:sp:sync          # node football/sp_plus/sync.js --write  (needs the three secrets)
npm run cfb:sp:test          # the mocked ingest suite and the Postgres contract
```

## B · The projected line (`lib/cfb_sp_plus.js`, `lines.js`)

A **T2 deterministic transform of the T3 rating** (`cfb_sp_projection_v1`):

```
home margin = home SP+ − away SP+ + home field      (0 at a neutral site)
home line   = − home margin                         (book sign: − = home favoured)
```

- **Home field.** The value EdgeDesk's CFB engine applies, read from the
  engine itself (`lines.js` `appliedHomeField`): today 2.8 from
  `football/cfb_p4/home_field.js` (`cfb_hfa_unified_v1`). If the engine ever
  stopped applying that file, the projection would follow it to
  `params.js` `venue.league_hfa`. `lines.json` records the value and its
  source with every capture.
- **Precision.** Stored at 0.01, shown at 0.1, named for its own favourite
  ("Kennesaw State −1.3").
- **Pure.** No clock, no randomness, no network: the same inputs give the same
  line. The same file runs in node and in the browser (`window.EDCfbSpPlus`).
- **Which games.** Every slate game of the captured week. A team SP+ does not
  rate (an FCS opponent) gets no line, and the entry says why.
- **What is published.** Per game: the teams, the week, the kickoff, the
  neutral flag, `home_margin` and `home_line`, or `UNAVAILABLE` with the reason.
  No rating.

## C · On the cards (`lib/cfb_sp_plus.js` `rowFor`)

| Surface | Where the row sits | Code |
|---|---|---|
| Board card (app) | the summary grid, after EdgeDesk fair / Market / Market gap | `fbGxSummary` in `app.html` |
| Game page `#game/cfb/<id>` | the overview, right after Fair spread | `spTile` in `lib/edgedesk_game_view.js` (`opts.spPlus` from `app.html`) |
| Research terminal `/research/cfb/#/game/<id>` | section 1, right after Fair spread; the summary strip; section A | `research/cfb/resilience_ui.js` `spRow`, `research/cfb/terminal.js` `spRow` |

Each row shows the SP+ line named for its favourite, **T3 external model · T2
computed line**, the SP+ week and capture date, and the attribution. When
EdgeDesk's margin and SP+'s differ by **3 points or more**, a plain
**Models disagree** note gives the size of the gap. The two numbers are never
combined.

**The display rule.** A line is shown only from a capture of the game's own
week, no older than 8 days. Otherwise the row reads **unavailable**, with the
reason:

- the file did not load;
- SP+ has not been synced yet;
- the sync failed, and why;
- the capture is stale;
- the game is from another week (or that week's sync failed, or SP+ had not
  updated);
- a team SP+ does not rate.

A stale number is never shown.

```
node football/sp_plus/display.test.js     # every state of the rule
node football/sp_plus/card_ui.test.js     # the board card, through the real football module
node football/sp_plus/ui.e2e.js           # the game page and the terminal in Chromium
```

## D · Tracking: which number tracks the close (`track.js`)

Run every hour by the CFB Model Lab job (`.github/workflows/cfb-lab.yml`),
which is the only writer of `football/sp_plus/ledger/` and
`football/sp_plus/reports/`.

- **Capture** (`ledger/<season>/captures.jsonl`). For every upcoming CFB game
  on the slate, three numbers at the same moment:
  - EdgeDesk's published fair line (`football/fbs/slate.json`);
  - the SP+ projected line as a card shows it (unavailable included, with its
    reason);
  - the market: the Model Lab's consensus, the median of each book's latest
    pregame quote (`lab_core.marketAt`).

  A row is appended for a game's first capture and whenever one of the three
  changes.
- **Grade** (`ledger/<season>/grades.jsonl`). Once per game, after the Lab has
  the final and its consensus close (`cfb_lab_close_v1`). Each source is
  graded on its last pregame number. A grade is written once and never edited;
  a later result correction does not change it.
- **Report** (`reports/<season>/week_NN.{json,md}`, `season.{json,md}`),
  rebuilt from the grades and dated by the newest one:

| metric | definition |
|---|---|
| MAE vs close | \|source home line − closing home line\| |
| MAE vs final | \|source home margin − final margin\| |
| right side of the close | the source's side against the close (home when its line is below the closing home line), right when the final covered the close on that side; pushes and no-side are not counted |
| close moved toward it | from the market at the game's first capture to the close: toward the side the source leaned, away, or no move |

  Each report also compares the two sources on the games both priced, with
  the close's own MAE against the final as the benchmark.
- **Append-only.** `track.js verify --base HEAD`: every committed ledger file
  must be a prefix of the working file, ids unique and each id matching its
  row's content. The hourly run checks itself before anything is published.
  A violation restores the committed files and warns; it never costs the
  Lab's own publish.

The worked case, 2026-10-28, Kennesaw State at Middle Tennessee:

| | line | off the close (KSU −1.5) | off the final (KSU by 16) | close moved |
|---|---|---|---|---|
| EdgeDesk | MTSU −4.5 | 6.0 | 20.5 | away from it |
| SP+ | MTSU −1.3 | 2.8 | 17.3 | toward it |

One game proves nothing; the season table is the evidence.

```
node football/sp_plus/track.js run [--write] [--now ISO]
node football/sp_plus/track.js verify --base HEAD
node football/sp_plus/track.test.js
```

## E · The registry: external, and kept that way

- **`football/sp_plus/registry.json`** registers *SP+ projected line* as an
  `EXTERNAL_ESTIMATE` with `edgedesk_model: false` and
  `validated_by_edgedesk: false`. It records the T3 rating and T2 line, the
  source and endpoint, the version per capture, the terms as read (with
  their date), the display decision and the attribution.
- **`public.cfb_external_estimates`** (`supabase/cfb_sp_plus.sql`) mirrors it.
  A check constraint refuses to record an external estimate as an EdgeDesk
  model or as validated, and the table is append-only.
- **The page.** `RS_EXTERNAL` in `app.html` pins `cfbd.sp_plus` to the
  **External** maturity badge ahead of the model registry, so no registry row
  can ever present SP+ as Validated. The provenance table lists the SP+ rating
  (T3, external) and the projected line (T2).
- **Never a participant.** SP+ is not a Model Lab role (champion, challenger
  or candidate), has no compatibility entry, and can never be promoted.
  `registry.test.js` fails if any EdgeDesk model, EV, ranking, grade, record,
  decision or Lab file reads SP+'s module or file. It also fails if `app.html`
  reads SP+ anywhere but the board card, the game page's hook and the football
  loader.
