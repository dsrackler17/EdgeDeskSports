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

## 7a — Publication: the publisher, and why it is one file

**`publisher.js` is the only way an article becomes public.** Nothing else may
set `status = 'published'`. The pregame phase, the postgame phase, the backfill
and any future operator action all call the same `publish()`.

Before this existed, publication was two inline lines in the pregame phase and
two more in the postgame phase:

```js
if (AUTO || STORE.settings().auto_publish_pregame) {
  rec = AMODEL.publish(rec, NOW);
```

Two copies of a decision is two places for it to drift, and neither copy checked
anything — the flag was the whole gate. Worse, the flag shipped `false`, so the
system generated snapshots, articles, theses and audits for every featured game
and left all of it in draft. **A research trail nobody can read is not a research
trail.**

### The default is publish

`auto_publish_pregame` and `auto_publish_postgame` default to **true**. An
article that passes generation, factual integrity and the quality floor goes
public with no person in the path. Manual review is what happens when a stated
condition fires, not what happens by default.

Set either to `false` in `articles/data/editorial/featured.json` → `settings` to
go back to holding, per half, without touching code. The Editorial tab of
`/admin/articles` shows which way both switches are set.

### What blocks, and what only warns

**Blocking** — publishing would put something false, broken or duplicated in
front of a reader:

| id | meaning |
| --- | --- |
| `generation_complete` | the article has no sections |
| `title`, `slug`, `canonical` | the document has no headline or no usable URL |
| `seo_description_present` | no meta description at all |
| `model_checks` | the article model's own per-type checks failed |
| `factual_integrity` | a figure on the page does not trace to the snapshot, the result record or our own arithmetic |
| `quality_floor` | the craft score is below 70 |
| `snapshot` | a pregame article citing no snapshot, or a postgame article carrying none |
| `final_data`, `final_completed` | a postgame article with no final score, or one no source called final |
| `no_duplicate` | another article for the same game and type is already published |
| `archived`, `operator_hold` | somebody withdrew it or asked for review on purpose |

**Warning** — recorded, visible, and does *not* stop publication: meta
description length, and every craft check (`seo_title_length`, `repetition`,
`thin_sections`, …). A meta description eight characters longer than preferred
has never made an article wrong. A gate nothing can pass is not a gate.

### The state machine

```
draft ──► ready ──► published ──► archived
  │         │            │
  └─────────┴──► manual_review ──► ready
```

* **`draft`** — generation is incomplete, or validation has not run. *Not*
  "an automated article at rest", which is what it used to mean.
* **`ready`** — validated and publishable; waiting only on its window.
* **`published`** — public. The page exists and the sitemap lists it.
* **`manual_review`** — a blocking condition a person has to clear. Distinct
  from `draft` on purpose: "nobody has looked at this" and "this needs a human"
  are different facts, and the operator queue is meaningless if they share a
  state.
* **`archived`** — withdrawn. A cron job never republishes it.

Only `published` is public. `canTransition()` enforces the arrows;
`supabase/site_articles.sql` constrains the same six values in the database.

### Idempotency

`publish()` on an already-published record keeps the original `published_at`,
leaves `updated_at` alone unless the document actually changed, and returns
`unchanged`. Two cron runs racing the same game produce one article with one
publication date. The comparison is against the **stored** record, passed as
`opts.previous` — comparing the input to a copy of itself can only ever answer
"unchanged".

### An already-published article is never yanked offline

If a blocking condition appears on a live article, the condition is recorded and
the operator is told — but the status stays `published`. Withdrawing a live page
is an operator's decision, not a cron job's.

## 7a2 — Publication windows: no more ninety-minute cliff

The pregame floor used to be one line:

```js
if (leadH * 60 < (cfg.pregame_min_lead_minutes || 90)) { ...refuse... }
```

A complete, factually clean article scoring 100 was refused at 89 minutes
exactly as it would have been at one minute — and the refusal was recorded as a
**failure**. Wrong twice over: the article was not defective, and forty-five
minutes before kickoff is an ordinary time to read pregame research.

There are now three windows, in `tools/editorial/windows.js`:

| window | when | what happens |
| --- | --- | --- |
| `normal` | more than `pregame_normal_lead_minutes` (90) | publish on the existing rules |
| `late_window` | between the minimum (20) and normal | **refresh, revalidate, then publish** |
| `final_window` | inside `pregame_minimum_publish_lead_minutes` (20) | held with a reason; an operator may force it |
| `after_kickoff` | kickoff has passed | never published, never forcible |

`not_due` is the fourth answer and means "not yet" — the per-window lead (a
Sunday early game opens sixteen hours out, Monday night seven) has not arrived.

### Configuration

```
pregame_normal_lead_minutes: 90
pregame_minimum_publish_lead_minutes: 20
```

in `articles/data/editorial/featured.json` → `settings`. `windows.js` is the
only reader; the pregame phase, the dispatcher, the backfill and the health
panel all resolve through it, so there is no second copy of `90` to drift.

The old `pregame_min_lead_minutes` is still honoured as the minimum when the
new keys are absent, so a store configured before this change keeps the
behaviour its operator chose.

**Bad configuration fails safely and loudly.** A minimum above the normal lead
would make the late window negative, every article would fall through to the
final window, and nothing would publish — a silent outage. `validate()` refuses
it, `classify()` returns nothing publishable, and the health panel goes ERROR.
A key that is *present but unreadable* (`"soon"`) is an error too, not a silent
fall back to the default: running a policy the operator did not write is the
same class of bug as a control that saves nowhere.

### The late-window refresh

`tools/editorial/refresh.js`. Only what actually rots near kickoff is
re-verified — the market line and total, the availability report, and whether
the fixture is still happening at the time and place it was scheduled. The
stable research (ratings, schedule strength, season form) is left alone.

**It never touches the original snapshot.** Snapshots are content-addressed, so
a refresh is a *new* file with `role: "publication"`, pointing back at the one
it refreshed. Two artefacts answer two different questions:

* `research` — what EdgeDesk believed when it committed. **This is what the
  postgame audit grades**, via `STORE.researchSnapshot()`.
* `publication` — what was actually true when the article went public. This is
  what closing-line value will need.

Grading the audit against the publication snapshot would let EdgeDesk mark its
own homework with figures it learned after committing, which is exactly the
self-flattery the result-vs-process system exists to prevent.

A refresh that cannot reach the terminal returns `stale` and the article is
**held**, not published with two-hour-old prices under a fresh timestamp.

### What the record remembers

```json
"timing": {
  "publication_window": "late_window",
  "classified_window": "late_window",
  "scheduled_kickoff": "2026-09-13T16:25:00.000Z",
  "minutes_before_kickoff": 45,
  "published_at": "...",
  "refreshed": true
}
```

`forced` when an operator overrode the final window. Nothing on the public page
ever mentions the hour: the reader is getting fresher numbers, not worse ones.

## 7h — The schedulers

**The dispatcher is no longer dependent on GitHub waking up.**

GitHub's scheduler is degraded on this repository. Measured, not assumed: on
2026-09-13 the editorial workflow logged **zero** scheduled runs between 12:58
and 17:03 across two different cron expressions, while every other scheduled
workflow showed the same ~4.5 hour gap — `settle-finals` is hourly and went
11:24 → 15:54. A publisher that must notice a 20–90 minute window cannot be
built on that.

```
supabase pg_cron  ──►  editorial_cron (edge fn)  ──►  workflow_dispatch  ──►  editorial.yml
github schedule   ──────────────────────────────────────────────────────►    (backup)
github workflow_run ────────────────────────────────────────────────────►    (backup)
github push       ──────────────────────────────────────────────────────►    (backup)
operator          ──────────────────────────────────────────────────────►    (manual)
```

**One canonical dispatcher.** The edge function does *not* run the pipeline —
it cannot, because the pipeline boots the football module out of `app.html` in
a Node VM and commits to this repository. It pokes the existing workflow. A
second pipeline in an edge runtime would give EdgeDesk two editorial systems
that disagree, which is far worse than a late article.

### Operator steps (these cannot be done from the repository)

```
1  Enable pg_cron and pg_net          Supabase dashboard → Database → Extensions
2  supabase functions deploy editorial_cron --no-verify-jwt
3  supabase secrets set EDITORIAL_GH_TOKEN=<PAT with actions:write on this repo>
4  psql -f supabase/editorial_runtime.sql
5  psql -f supabase/editorial_cron.sql   (see its header for the two settings)
```

Until step 3 the function returns **503** and says the token is missing — it
never reports success while scheduling nothing.

**Order does not matter, and that is deliberate.** `editorial.yml` learned its
`source` input in the same change that added this function, so a project that
deploys the function before that change reaches `main` is pointing it at a
workflow that does not accept the input. GitHub answers
`422 Unexpected inputs provided: ["source"]` to every tick, and the primary
scheduler would be dead from the day it was installed over a piece of
metadata.

So a 422 naming an unexpected input is retried once without it. The poke lands;
the run records its source as the workflow's default (`manual`) instead of
`supabase_cron`, so `EDITORIAL HEALTH` shows the primary as missing while the
articles keep publishing. The function's `reason` says exactly that and names
the ref whose workflow is behind — a silent fallback would hide a version
mismatch worth fixing. It clears itself when the ref carries the input.

A 422 for any other reason — a workflow with no `workflow_dispatch` trigger, a
disabled one — is reported as an error without a second call, because dropping
the inputs would fail identically.

### Heartbeats

Every invocation writes to `public.editorial_heartbeats`: `scheduler_source`,
`started_at`, `completed_at`, `duration_ms`, `ok`, `actions_considered`,
`actions_executed`, `error`. Written even when the run finds nothing to do,
because "no scheduler is running" and "there was no work" used to look
identical.

Health grades **primary** (`supabase_cron`) and **backup** (anything GitHub)
separately:

| state | meaning |
| --- | --- |
| HEALTHY | the primary is arriving |
| DEGRADED | the primary has stopped but the backup is still invoking the dispatcher |
| ERROR | nothing is successfully invoking it |
| PAUSED | an operator turned `editorial_enabled` off — not a fault |

### Leases

Several schedulers invoking one dispatcher is the design, so the dispatcher is
safe to run twice. `public.editorial_leases` holds expiry-based leases claimed
through `editorial_claim()`:

* **atomic** — the conflict is resolved inside one statement, so two workers
  racing produce exactly one winner (proved from two real processes)
* **self-healing** — a worker that dies releases by doing nothing
* **un-stealable** — `editorial_release()` only affects what you hold
* **not a global stop** — `job:pregame:NFL:A` and `job:pregame:NFL:B` are
  different keys, so independent games still run in parallel

The dispatcher takes `dispatcher`; the expensive per-game steps take
`job:<step>:<game>`. Article-level idempotency already guaranteed one *page*;
the lease stops two workers paying for the same provider fetch and model call.

**No credential means no coordination, not no run.** A laptop with no service
role proceeds uncoordinated and says so, because the pipeline has always been
runnable offline.

## 7i — Settings: one source of truth

```
1  public.editorial_settings          PRODUCTION TRUTH — what the admin writes
2  featured.json → settings           bootstrap and offline fallback only
3  EDGD_* environment variables       explicit deployment override
```

Resolved once per run in `tools/editorial/runtime.js`, which records **where
each value came from**, so the health panel shows the truth rather than a file
the runtime is not reading. A key that is present but unreadable (`"soon"`) is
reported and ignored, never silently coerced.

Validated **in the database**, so no client-side check can be bypassed:
`normal > minimum`, `minimum >= 0`, sane ranges, and a `quality_floor` inside
0–100. Every change writes an audit row with the old and new value and who
made it.

The admin console edits these directly: UI → authenticated PATCH → database →
the next dispatcher run obeys it. No sync step, no committed file to keep in
step, and RLS means only an operator can write.

### The kill switch

`editorial_enabled = false` pauses all autonomous work. The dispatcher still
heartbeats, health reports **PAUSED** rather than ERROR, already-public pages
stay public and every immutable record is untouched. `dispatcher_enabled` stops
scheduled runs separately while leaving a manual run available.

## 7j — The freshness layer

`tools/editorial/freshness.js` replaced the broad re-run of the research
terminal. It asks narrow questions of named sources:

| field | source |
| --- | --- |
| `fixture.status` / `kickoff` / `venue` | ESPN scoreboard |
| `market.line` / `total` / `book` | the research market block |
| `availability.out` / `qb` | nflverse injury report · EdgeDesk availability |

Every field carries `value`, `provider`, `retrieved_at` and a status of
`ok` / `unavailable` / `unsupported`.

**A blind spot is not a non-change.** A source that could not be read is
reported separately from one that did not move — not knowing whether the line
moved and knowing it did not are different facts, and only one is safe to
publish on. College availability with `LIMITED` coverage is `unavailable`,
because absence of a report is not a report of no absences.

### Material change

| rule | default |
| --- | --- |
| `spread_moved` | ≥ 1.0 points |
| `total_moved` | ≥ 2.0 points |
| `kickoff_moved` | ≥ 15 minutes |
| `starting_qb_changed`, `player_ruled_out`, `venue_changed` | always |
| `fixture_postponed` | always, and **blocking** |

Material → the affected interpretation is rebuilt and revalidated before
publishing. Immaterial → the number is updated and recorded, no regeneration.
Every decision names its rule and shows the arithmetic.

**The original thesis is never revised.** The research snapshot is the
analytical commitment the postgame audit grades; the freshness layer describes
current conditions at publication. Two different claims, kept apart.

## 7g — Editorial health

```
node tools/editorial/health.js          the panel, as text
node tools/editorial/health.js --json
```

`tools/editorial/health.js` derives the lifecycle **once**, from the same
stores the pipeline writes, and every run writes the result to
`articles/data/editorial/health.json`. The admin console **renders that file**
rather than re-deriving anything, so the panel and the orchestrator cannot
drift apart. A panel that guesses is a panel that lies the first time the
pipeline changes.

**HEALTHY / DEGRADED / ERROR is about the system, not about one article.**

* **ERROR** — the dispatcher is dead (≥16 missed ticks), has never run, or the
  window configuration is invalid. Nothing can be published.
* **DEGRADED** — the dispatcher is late (≥4 missed ticks), retries are elevated
  or exhausted, or records are stale.
* **HEALTHY** — everything else.

One article in `manual_review` is the system *working* — it found something and
said so — and deliberately does **not** turn the panel red. If it did, the
panel would stop meaning anything and the operator would stop looking at it.

### The next action

`HEALTH.nextAction()` gives one canonical answer per game, in words an operator
can act on: `publish at 2026-09-13T13:20:00Z`, `refresh late-window data and
publish`, `manual force required`, `waiting for kickoff`, `waiting for final`,
`waiting for a stable box score`, `generate postgame`, `retry at …`, `manual
review required`, `complete`. The UI prints it; it does not compute it.

### Postgame debt

Every committed game that has been played and has no published postgame article
appears in `debt`, with a state (`waiting_final`, `waiting_stats`,
`postgame_due`, `generating_postgame`, `manual_review`, `retry_pending`) and a
next action. It cannot vanish because the board moved on, generation failed
once, or a tick was skipped — the invariant is asserted in
`windows.test.js` §11.

### Stale detection

Reported, never silently repaired: `ready_past_kickoff`,
`generating_too_long`, `retry_overdue`, `waiting_stats_too_long`,
`published_without_route`.

## 7b — The dispatcher, and the first-run problem

The job runs **every fifteen minutes** and is almost always free.

It used to run every two hours. That meant a deployment landing at :26 sat idle
until :25 of the hour after next, and a game whose publication window opened
just after a tick published up to two hours late.

Quarter-hourly is affordable because the run is a **dispatcher first**. With
`--if-due` it reads `featured.json`, the snapshots, the run log and the retry
ledger — all files already on disk — works out whether anything is owed, and
exits *without booting the research terminal or touching a feed* when nothing
is. That costs about 75 ms. Only a tick with real work pays for the downloads.

```
node tools/editorial/run.js all --if-due --network
```

A push to `tools/editorial/**` or `tools/articles/**` also triggers the job, so
a deployment is noticed at once rather than at the next tick. The job's own
commits touch `articles/` and the sitemaps, never `tools/`, so it cannot
retrigger itself.

Work is due when the board has not been scored for `select_interval_hours`
(default 6), or a featured game is inside its publication window and unpublished,
or a committed game has finished and has not been audited.

## 7c — Retries

`articles/data/editorial/retries.json` records, per game and step:
`attempt_count`, `last_attempt_at`, `next_retry_at`, `last_error`.

**The two kinds of failure are not the same.** Something that *threw* — a
provider timing out, a feed briefly down, a socket reset — is transient: it backs
off over 5, 15, 45, 120 and 360 minutes and then stops, saying why. A **factual**
failure is not going to fix itself by being retried, so the publisher turns it
into `manual_review`, which no amount of retrying would clear. A step that
finally succeeds clears its own ledger line.

## 7d — The postgame phase does not read the board

`phasePostgame` iterates **`STORE.committedGames()`** — every game with a stored
snapshot — unioned with the current featured board.

This matters more than it looks. `featured.json` is rebuilt from the *current*
slate on every run, and a played game leaves the slate within a day. The original
sequence was: game featured → pregame article published → game played → board
drops it → the next `select` rewrites `featured.json` without it → **the postgame
phase never sees the game again.** The audit half of the product could not fire
at all, and nothing said so, because from the pipeline's point of view there was
no such game.

A snapshot is the durable record of the commitment. Anything with one is owed an
audit, whether or not the schedule feed still carries the fixture.

## 7e — Backfill

```
node tools/editorial/run.js backfill
```

Runs everything already generated through the publisher once — needed because
the store holds complete, validated records that sat at `ready` while publishing
was off.

It is **not** "publish everything". A pregame preview for a game that has already
kicked off is worthless to a reader and dishonest to publish under today's date,
so those are skipped with the reason stated rather than published to make the
numbers look better. A postgame audit has no such expiry.

## 7f — Where publication is reported

```
node tools/editorial/report.js
```

One table per article — type, status, whether it is public, quality score, and
for anything held, the condition that held it. **"Held" is never an answer on its
own**: it is `manual_review: factual_integrity` or `waiting_stats` or
`backing off until … after 2 attempts`, and it is in the job summary, in
`runs.json`, and on the record itself under `publish_state`.

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
