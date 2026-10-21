# Collegiate data

Data about college teams that no feed we own carries, read from what the
schools publish about their own teams. It feeds two things:

- **The college baseball model**: roster continuity, results the 2023 source
  never reported, and box scores with starting pitchers, their hand,
  lineups with bats, and weather.
- **The portal ledger**: who left which program, who arrived where, across
  every sport we read.

## The rules (`polite.js`)

Every read of a school's site goes through `polite.js`.

- **Identity.** We read as `EdgeDeskBot/1.0 (+https://edgedesksports.com)`, by name. We never change it.
- **robots.txt first** (RFC 9309).
  - Our own group applies if there is one, otherwise `*`.
  - The longest match wins.
  - `Crawl-delay` is honoured. SIDEARM sites ask for 30 s between reads; we wait it.
- **One request at a time per host**, at least 2 s apart, with per-run and per-day caps.
- **A refusal is permanent and never retried around.** That covers a disallow, a robots.txt that itself refuses robots, a 401/403, or a persistent 429.
  - The host is written to `data/refusals.jsonl` and left alone.
  - ESPN's API and stats.ncaa.org refuse robots, and Wikidata disallows SPARQL, so none of them is read.
- **Only facts a model uses are kept.**
  - Rosters: name, number, position, class, height, weight, hometown, high school, previous school, bats/throws.
  - Box scores: lines, pitchers, lineups, weather.
  - Never kept: social accounts, majors, biographies or photos.
- **Nothing is guessed.** These all become a miss with a reason, and nothing stands in for them:
  - a page of another season or sport;
  - an empty roster;
  - a read listing fewer than half the players the last read did;
  - a name two schools tie to different teams;
  - a box score that matches none of our contests.

The schools' and ncaa.com's terms of use have not been reviewed. robots.txt allows these reads, but that review is a person's call.

## The pieces

| File | What it does |
|---|---|
| `probe.js`, `probe/targets.json` | Reads a few real pages once, on a GitHub runner (this sandbox cannot reach school sites), so every reader is written and tested against real pages (`probe/fixtures/`). |
| `nuxt.js` | SIDEARM and WMT both build on Nuxt 3, which ships each page's own data as `__NUXT_DATA__`. This module decodes it. |
| `platforms.js` | A season's roster on either platform, in one row shape. Player ids are stable across seasons on both platforms. |
| `directory.js` | The registry (`data/schools.json`), built from ncaa.com: every member school, its conference and its athletics site. Division comes from our own baseball record or from a single-division conference; otherwise it is left empty. |
| `rosters.js` | Snapshots in `data/rosters/<sport>/<season>/<school>.json`. Each player carries `first_seen`, `last_seen` and `removed_at`. These are observation dates, not portal dates; the NCAA portal database is not public. |
| `portal.js` | The ledger in `data/portal/<sport>/<season>.json`, with the rules below. |
| `schedules.js` | Season schedules and results in `data/schedules/...`. Each game has its site, its score, extra or shortened innings, and its box-score link. SIDEARM names each opponent's website, which gives an exact join. |
| `boxscores.js` | Box scores in `data/boxscores/...jsonl.gz`. Each game is read once, from the home school, in daily per-host slices. Teams are named by their NCAA codes, which are our team ids. |
| `run.js`, `plan.json` | One run as the plan says: registry, weekly rosters, schedules, backfills, box-score slices, ledger. |

**Portal ledger rules:**
- A transfer needs either a listed previous school, or a departure matching the arrival by name plus hometown or high school. A name alone never matches.
- A senior who leaves is recorded as "eligibility likely done".
- A junior-college transfer is kept as the roster writes it.
- Each team gets its continuity figures: returning share, transfers in and out, newcomers.

**Workflows:**
- `collegiate-rosters.yml`: weekly on main, and on a branch whenever `plan.json` changes.
- `collegiate-backfill.yml`: daily slices on main.
- Both publish `collegiate/data` and share one concurrency group.

## Into the college baseball model

| Input | Where | State |
|---|---|---|
| **Roster continuity** | `college_baseball/lib/continuity.js` → `tq.cont_k` (how much of last season's strength a team carries) | A learning-loop candidate. It stays inactive until it covers 80% of D-I team-seasons in 2014–2024; the weekly report names it until then. |
| **Results** | `college_baseball/ingest/school_results.js` | `audit` compares with the results we hold. `fill` scores a `NO_RESULT` contest when both schools agree, or when one lists it and the other is unread or silent. Not applied yet. |
| **Starters, lineups, weather** | `college_baseball/ingest/school_box.js` | Writes `data/school_box/<season>.csv`. `audit` checks it against our own 2024–2026 box scores. |

Two limits on these inputs:
- **Starters.** A pregame model can use a *projected* starter only. In college that means the weekend rotation inferred from earlier box scores; the actual starter and lineup are oracle inputs.
- **Weather.** Box-score weather is observed, not forecast. It can grade a weather feature but cannot price with one until a pregame forecast source is ingested.
