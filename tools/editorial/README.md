# The EdgeDesk editorial system

**Every game should leave EdgeDesk smarter.**

The article system publishes what the model thinks. This publishes what the
model thought, then grades it against what happened — and reports the bet
result and the quality of the reasoning as two separate things, because they
are two separate things.

A winning number built on a broken thesis is published as exactly that. A
losing number built on a defensible read is published as exactly that too.
Nothing else on this page matters as much as those two sentences.

---

## The shape of it

```
   the football model, unchanged
              │
   window.fbBriefGame() / fbNflBriefGame()        ← the research payload
              │
   featured.js        which games earn a permanent research trail
              │
   snapshot.js        an IMMUTABLE, content-addressed capture of the research
              │        ├─ theses.js      the falsifiable claims, extracted
   article_model.js   the pregame article (the existing one, unchanged)
              │
          ─── kickoff ───  the record freezes
              │
   fetch_results.js   the final AND the box score, from the public feeds
              │
   results.js         normalised into a closed metric vocabulary + READINESS
              │
   theses.js          every pregame claim graded against the statistics
   grading.js         bet result and process grade, computed SEPARATELY
   lessons.js         machine-readable research lessons + review candidates
              │
   postgame_model.js  the postgame article — same store, same builder
   quality.js         the gate: integrity blocks, craft scores
   narrate.js         optional model-drafted prose, validated or discarded
              │
   /articles/<slug>-postgame-analysis/            ← linked to the pregame page
```

## The files

| file | what it is |
| --- | --- |
| `featured.js` | the selection engine. Scores every game on the board from the schedule, the slate, EdgeDesk's own ranks and the model-versus-market gap; applies a per-sport floor and a per-week cap; an operator's decision outranks both. Pure, loads in Node and in a browser. |
| `snapshot.js` | the immutable pregame capture and the **fact ledger** — the closed set of things an article is allowed to assert, each with a tier and a path back into the payload. The snapshot id is a content hash of itself. |
| `theses.js` | turns a snapshot into falsifiable claims with expected signals and falsifiers, and grades them afterwards as CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED / INCONCLUSIVE. |
| `results.js` | the metric vocabulary, the provider normalisers, source reconciliation and the **readiness gate**. Pure. |
| `fetch_results.js` | the network half: ESPN summary → ESPN scoreboard → nflverse/cfbfastR → the committed settlement record. Offline by default. |
| `grading.js` | the implied side, ATS/total/moneyline grading, closing-line value, the variance markers, and the four-quadrant verdict. |
| `lessons.js` | research lessons, model-review candidates, and the long-term memory aggregate. |
| `postgame_model.js` | the postgame article record. Registers itself as an `article_type` with `article_model.js`, so it lives in the same store and is rendered by the same renderer. |
| `quality.js` | the publication gate. Integrity failures block; craft failures score. |
| `narrate.js` | the optional language-model layer and, more importantly, the validator that discards its output. |
| `graphic.js` | the header card. EdgeDesk brand only, no team marks, one pure `render()` to replace. |
| `store.js` | the committed store under `articles/data/editorial/`. |
| `run.js` | the orchestrator: `select`, `pregame`, `postgame`, `memory`. |
| `supabase/editorial_system.sql` | the operator-facing half, with the two rules the database enforces itself. |

## Running it

```bash
npm run editorial:select        # score the board, pick the featured games
npm run editorial:pregame       # snapshot + article for what is due
npm run editorial:postgame      # audit + article for what has finished
npm run editorial:memory        # rebuild the research memory
npm run editorial:run           # all four, with the feeds live
npm run editorial:publish       # …and publish what passes every check
npm run editorial:test          # the offline suite
npm run editorial:sql           # the migration, applied and attacked
```

One game, ignoring the idempotency log:

```bash
node tools/editorial/run.js postgame --game NFL:2026_01_NE_SEA --force --network
node tools/editorial/run.js pregame --game CFB:401856789 --network --narrate
node tools/editorial/run.js all --network --dry          # write nothing
node tools/editorial/run.js all --now 2026-09-14T12:00:00Z  # pretend
```

The scheduled job is `.github/workflows/editorial.yml`, every two hours at
`:25`. It needs **no secret**: the schedule feeds, the ESPN box score and the
settlement record are public and keyless. `ANTHROPIC_API_KEY` is optional and
adds four short passages of connective prose to a postgame article; without
it the same article publishes with the same numbers.

---

## 1 — Which games get covered

`featured.js` scores every game on the board out of 100 and stores the score
**itemised**, so a ranking can be argued with rather than only accepted.

| component | points | where it comes from |
| --- | --- | --- |
| national window | 22 | the schedule's own Eastern weekday and kickoff time |
| the only game in its window | 12 | computed from the rest of the slate |
| stage | 14–40 | nflverse `game_type`; cfbfastR `season_type` + `notes` |
| both teams ranked | 6–30 | **EdgeDesk's own** rating, never a poll |
| rivalry | 16 | `articles/data/editorial/rivalries.json`, operator-curated |
| conference / division game | 5–6 | the schedule |
| model-versus-market gap | 0–24 | the research payload's own market block |
| neutral site | 6 | the schedule |

Then a **floor** per sport and a **cap** per sport per week, both in
`articles/data/editorial/featured.json` under `settings`. A postseason game is
never crowded out by a cap. An operator's FEATURE or UNFEATURE outranks
everything and survives a rescore.

**What is deliberately not scored:** the broadcast network (no feed here
carries one — the kickoff *window* is derived from the timestamp and is a
different thing), a national poll, and public betting percentages.

### Changing the thresholds

Edit `articles/data/editorial/featured.json`:

```json
"settings": {
  "thresholds": { "NFL": 30, "CFB": 35 },
  "weekly_caps": { "NFL": 4, "CFB": 6 }
}
```

Then `npm run editorial:select`. Nothing needs a deploy.

---

## 2 — The snapshot, and why it is immutable

A postgame article that re-read "what we thought" from live tables would be
worthless. Ratings absorb the result, the market closes, an injury resolves —
an hour later the model's own pregame number has already moved toward the
thing that happened, and the audit would grade EdgeDesk against a prediction
it never made.

So the research state is captured before publication and never read from
anywhere else again.

* the **id is a content hash** of the snapshot, so re-capturing identical
  research writes the same file — which is what makes the capture idempotent
  under a cron job that fired twice;
* changed research produces a **different** id, so the old snapshot is
  superseded rather than edited;
* `supabase/editorial_system.sql` has **no UPDATE policy** on the snapshot
  table for anybody and a trigger that refuses an edit or a delete **including
  from the service role the pipeline itself runs as**;
* `snapshot.verify()` recomputes the hash, and `quality.js` refuses to publish
  a postgame article whose snapshot no longer matches it.

### The fact ledger

Every figure an article may assert is enumerated once, with a tier:

`VERIFIED_FACT` · `EDGEDESK_MODEL` · `CALCULATED_METRIC` · `INTERPRETATION` ·
`UNKNOWN`

Anything not in the ledger (or in the result record, or computed by this
repository) is an **unsupported statistic** and blocks publication. That is
the whole defence against invention: not an instruction, a closed set and a
check.

---

## 3 — The postgame gate

A final score is not a game. `results.readiness()` requires **all** of:

- a source that calls the game final, and is not POSTPONED / CANCELED /
  SUSPENDED / FORFEIT;
- two integer scores that are not 0-0;
- **at least five of eight core team statistics on both sides** — this is the
  rule that stops a postgame article being written from a scoreboard;
- a configurable settle delay after the final (default 20 minutes);
- the pregame snapshot, because without it there is nothing to audit against;
- **no disagreement between providers.** Two sources with different finals is
  the one case where publishing is worse than waiting.

Every refusal is a named reason in the run log.

---

## 4 — Result versus process

Two grades, computed separately and allowed to disagree.

**Bet result** — arithmetic on the final score and the quote EdgeDesk captured
before kickoff. Note the naming: `implied_side`, never `pick`. EdgeDesk
publishes research; what is graded is the side its own number implied against
the market's, which is how a research platform keeps itself honest.

**Process grade** — `SOUND` / `MIXED` / `UNSOUND` / `UNTESTED`, from the thesis
audit and the variance markers. **It is computed from the mechanism claims
only** — the drivers, matchups and measured advantages — and explicitly
excludes the price and market theses, which are the result in longer words.
Including them would make the two grades agree by construction on every game,
which is the conflation this whole system exists to undo.

The four quadrants, and what each one is published as:

| | process SOUND | process UNSOUND |
| --- | --- | --- |
| **bet won** | the result is evidence the process works | **the most dangerous result on the page** — it pays and teaches nothing, and the article says so |
| **bet lost** | the one a bettor should be least upset about; nothing needs changing yet | the one that should change something, and the lessons say what |

Variance markers — a three-turnover swing, a defensive score, a spread result
that flipped on the final play, a one-score game, a blowout — are detected
from the provider's own payload and named. None of them decides a grade by
itself; two high-severity ones make the result `UNTESTED`, which is the honest
answer to a game that proved nothing either way.

---

## 5 — The research memory

Every postgame article stores machine-readable lessons (`lessons.json`), and
`memory.json` answers the standing questions:

- Do EdgeDesk's winning numbers come from the mechanisms it named?
- What share of winning wagers had incorrect reasoning?
- What share of losing wagers still showed a defensible process?
- Which model drivers fail most often?
- Where does EdgeDesk disagree with the market, and is it worth anything?
- Has the market moved toward EdgeDesk after publication?

Each answer carries its own `n`, and a question with too small a sample says
so rather than producing a percentage somebody would quote.

**No model weight is ever changed from a lesson.** What a lesson can do is
open a **model-review candidate** — a question with evidence attached. Only a
person closes one, and the database requires a disposition, a note of at least
twenty characters and an author to do it. Easy to raise, only a person can
close: that asymmetry is the shape a research memory has to have.

---

## 6 — The language model, and exactly what it may touch

```
  deterministic decision → structured payload → narrate → VALIDATE
                                                            │
                                    rejected copy falls back to the
                                    deterministic prose, every time
```

The model may write four short passages: a standfirst, an opening, a reading
of why the game turned, and a closing thought. It may not write a number,
change a verdict, name a player, describe a play, or add a fact.

The validator refuses, and **one failure discards the whole draft**:

- a figure not in the payload's closed set of assertable values;
- a verdict used against a thesis the audit graded differently;
- recommendation language, by `article_model.FORBIDDEN`;
- a phrase from the machine-written list in `quality.js`;
- a person's name or a quotation the payload does not contain;
- malformed output, a truncated block, a missing field;
- future tense about a game that has been played.

Accepted copy is attached as its **own block** and labelled on the page, not
merged into a section — so the page can always be re-rendered without it, and
the checks can always tell the two apart. The suite asserts that turning
narration on changes no figure the page already carried, which is the real
test of whether the boundary is a boundary.

With no `ANTHROPIC_API_KEY` the pipeline runs identically, minus four
paragraphs of connective prose, and the methodology notice says so.

---

## 7 — The quality gate

Two classes of check, and they are not the same kind of thing.

**INTEGRITY — any failure blocks publication, whatever the score.**

`model_checks` · `team_names` · `score_matches_record` · `teams_match_result` ·
`pregame_claims_unedited` · `snapshot_intact` · `spread_grading` ·
`spread_orientation` · `total_grading` · `total_points` · `no_future_tense` ·
`has_thesis_audit` · `has_process` · `has_wrong_section` ·
`no_unsupported_statistics` · `internal_links_resolve` · `no_result_language`

**CRAFT — each costs stated points; below a floor of 70 the article is held.**

`seo_title_length` · `meta_description_length` · `headline_length` ·
`excerpt_length` · `duplicate_paragraph` · `ai_phrase` · `repetition` ·
`rhetorical_questions` · `thin_sections` · `internal_links`

The checks run on the **rendered page**, not on the record: an unsupported
number is a number a reader can see.

---

## 8 — Operator controls

`/admin/articles` → **Editorial**:

| control | what it does |
| --- | --- |
| **Feature** / **Unfeature** | outranks the score and the cap; survives every rescore |
| **Clear override** | returns the game to the scorer's decision |
| **Disable pregame / postgame** | covers one half of a game and not the other |
| **Copy regenerate command** | the `--force` command for that game |
| **The last editorial run** | one line per step, with the not-ok lines first |
| **Model-review candidates** | the open questions and the evidence behind each |
| **The research memory** | the standing questions and their current answers |

An operator's decision is a write to `editorial_featured_games`; the next
pipeline run reads it and honours it. With the table unreachable the screen
says so rather than pretending to have saved.

**Preview before publishing:** `npm run articles:preview`, then open
`/articles/_preview/<slug>/` — noindex, in no sitemap.

**Publish manually:** the Publish button on the Research articles tab, or
`node tools/editorial/run.js <phase> --auto`.

**Archive:** the Archive button. The record stays in the store; the page goes.

**Force generation / regenerate:** `--force` ignores the idempotency log for
that game and rewrites the record in place. The URL never moves.

---

## 9 — Failure conditions, and what each one does

| condition | what happens |
| --- | --- |
| a schedule feed is unreachable | the run reports which one and covers what it can |
| no captured odds | the article publishes without a market section; no implied side, no bet grading, and the page says why |
| no model projection | the game is held; the run log names it |
| game postponed or cancelled | `completed` is false, readiness refuses, nothing publishes |
| statistics not ready | held, with the missing metrics named and a retry next run |
| providers disagree on the final | refused outright and recorded as a conflict |
| the LLM fails or invents | the whole draft is discarded; deterministic prose ships |
| a quality integrity check fails | held for manual review, with the check named |
| a cron job runs twice | the snapshot hash, the derived ids and the run log each make it a no-op |
| Supabase unreachable | the committed store is the source of truth; the run continues |

**Nothing is ever filled in.** Where data is missing the article writes around
it and says what is missing, or it is held.

---

## 10 — Adding a sport

1. Add a row to `SPORT_RULES` in `featured.js`: its kickoff windows, its stage
   detector, its rank pool, its floor.
2. Add the sport to `SPORTS` in `tools/articles/article_model.js`.
3. Teach `research_host.slate()` to emit its games in the same shape.
4. Add its provider path to `ESPN_PATH` in `fetch_results.js`, or a new
   normaliser in `results.js` if the provider differs.
5. Map its model's driver vocabulary to observable metrics in
   `DRIVER_SIGNALS` (`theses.js`). A driver with no observable metric is not a
   problem — it grades INCONCLUSIVE and says which metric it wanted, which
   over a season is a useful list in itself.

Nothing below `SPORT_RULES` knows the name of a league.

---

## 11 — Changing the schedule

`articles/data/editorial/featured.json` → `settings.pregame_lead_hours`, in
hours before kickoff, per sport, per window:

```json
"pregame_lead_hours": {
  "NFL": { "thursday_night": 9, "sunday_night": 7, "monday_night": 7,
           "sunday_early": 16, "sunday_late": 16, "default": 12 },
  "CFB": { "saturday_night": 12, "saturday_afternoon": 14, "friday_night": 10,
           "default": 14 }
}
```

`postgame_settle_minutes` and `postgame_min_core_metrics` control the postgame
gate. `quality_floor` is the score below which nothing publishes itself.

---

## 12 — Recovering from a failure

1. `articles/data/editorial/runs.json` — find the game and read the reason.
2. Re-run just that game: `node tools/editorial/run.js <phase> --game KEY
   --force --network`.
3. A held article is a real record: preview it, fix the cause, re-run.
4. A snapshot is never the problem — it cannot have changed. If
   `snapshot_intact` fails, something edited a committed file by hand.
5. The database is optional throughout. With Supabase unreachable the
   committed store is the source of truth and the run says so.

---

## What this system refuses to do

1. **Never invent a statistic.** Every figure traces to the snapshot, the
   result record or this repository's own arithmetic, and the gate proves it
   against the rendered page.
2. **Never write a postgame article from a scoreboard.**
3. **Never edit a pregame claim after the fact.** The snapshot is immutable and
   the checks compare the page against it.
4. **Never settle on a provider disagreement.**
5. **Never drop "what EdgeDesk got wrong" because the number won.**
6. **Never let a language model introduce a fact.**
7. **Never change a model weight from one game.**
8. **Never claim a broadcaster, a poll ranking or a public betting percentage.**
9. **Never publish a recommendation**, in any wording, ever.
10. **Never treat a winning bet as proof the reasoning was right.**
