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
| `schedules.js` | Season schedules and results in `data/schedules/...`. Each game has its site, its score, extra or shortened innings, and its box-score link; an exhibition is kept and flagged, never a final. Every SIDEARM generation names each opponent's website, which gives an exact join: the Nuxt store, the schedule a Vue page hands its component (George Mason, Bradley), and the older markup. WMT's opponents join by name. WMT renders its games in one of seven themes, all read (a theme that also names the school, marked `--current`, gives the opponent); a WMT site's pages may use its own code for the sport (LSU: `/sports/bsb/`). It is learnt from its own pages, and when every season page 404s under the sport's name, from its plain schedule page, read once a run. Where a page lists "Feb 13 (Fri)" without the year, the year is the season's and the weekday must agree, or the game is left undated. |
| `boxscores.js` | Box scores in `data/boxscores/...jsonl.gz`. Each game is read once, from the home school, in daily per-host slices. Newer SIDEARM boxes name teams by their NCAA codes (our team ids) and give every hand. SIDEARM's older boxes name neither: the teams come from the schedule row that links the box (the school's id, the opponent's website, through `teamids.js` where the registry has none), and the school's own players keep their roster slug, from which `college_baseball/ingest/school_box.js` takes their hands. A box whose two teams do not both resolve is never requested. Newest season first. |
| `teamids.js` | Our team ids for the schools and websites the registry ties to none (82 D-I schools' ncaa.com names are not our record's: App State, Coastal Carolina, Ole Miss), learnt from results: a school's finals against an opponent we know that are our record's contests with team T (same date, same score) make it T; a website a known school lists is T the same way. At least 5 games and 90% agreement, never a team another school already is. `data/team_ids.json`, with the evidence. |
| `run.js`, `plan.json` | One run as the plan says: registry, weekly rosters, schedules, backfills, team ids, box-score slices, ledger. |

**Portal ledger rules:**
- A transfer needs either a listed previous school, or a departure matching the arrival by name plus hometown or high school. A name alone never matches.
- A senior who leaves is recorded as "eligibility likely done".
- A junior-college transfer is kept as the roster writes it.
- Each team gets its continuity figures: returning share, transfers in and out, newcomers.

**Season labels.** SIDEARM lists every season it keeps, and so do WMT's schedule pages and SIDEARM's older ones; those labels are learnt (`data/season_labels.json`). Elsewhere a WMT season is tried under each way WMT sites label one ("2026", "2025-26", "2025-2026"), the school's own form first; a page of another season is refused whichever label reached it. A fall sport's academic-year label ("2026-27") is its first year's season, a spring sport's its second. A site's own code for a sport (LSU's "bsb") is that sport.

**Backfills.** A past season already held is not read again, except a thin schedule (under 10 finals) written by older readers: it is read once more on the current ones (the first day's WMT reader kept one game a season at Vanderbilt). Each run's schedule misses, with what each page answered, are kept in `data/schedule_misses.json`. A backfill is complete once a run has nothing left it could read, and it reopens by itself when its collector learns to read more (each collector names its readers in `backfill.json`). Box scores are planned afresh each run from the schedules held, through the current season.

**Not read yet** (D-I baseball schools whose `/sports/baseball/roster` answers 404 on every season):
- WMT's older WordPress generation (`/sport/m-basebl/`): Arkansas, Georgia Tech.
- WordPress: Kentucky.
- Miami (OH) and Pepperdine: SIDEARM sites with a `/sports/baseball` page, so their roster path needs its own probe.

**Workflows:**
- `collegiate-rosters.yml`: weekly on main, and on main when `plan.json` changes. Never on a branch: the data lives on main, and a branch run would read every school a second time.
- `collegiate-backfill.yml`: daily slices on main.
- Both publish `collegiate/data` and share one repository-wide concurrency group, so two collector runs never read the same schools at once.
- `collegiate-probe.yml` runs by hand only (workflow dispatch, with the branch that changed `probe/targets.json` as the ref). It used to run on any push that changed the targets; a branch that merged main in afterwards got a probe run and a commit it never asked for.

## Into the college baseball model

| Input | Where | State |
|---|---|---|
| **Roster continuity** | `college_baseball/lib/continuity.js` → `tq.cont_k` (how much of last season's strength a team carries) | A learning-loop candidate. It stays inactive until it covers 80% of D-I team-seasons in 2014–2024; the weekly report names it until then. |
| **Results** | `college_baseball/ingest/school_results.js` | `audit` compares with the results we hold; a doubleheader's games pair with ours by score where we hold one (counted apart: the order never inflates agreement). On 2026, 109 schools: 99.93% of scores agree (4,463 of 4,466). `fill` scores a `NO_RESULT` contest when both schools agree, or when one lists it and the other is unread or silent; a doubleheader our record cannot order is marked `dh_order: unverified`. Not applied yet. |
| **Starters, lineups, weather** | `college_baseball/ingest/school_box.js` | Writes `data/school_box/<season>.csv`. `audit` checks it against our own 2024–2026 box scores. On an older SIDEARM box the school's own starter and nine take their hands from its roster, by the slug the box links. |

Two limits on these inputs:
- **Starters.** A pregame model can use a *projected* starter only. In college that means the weekend rotation inferred from earlier box scores; the actual starter and lineup are oracle inputs.
- **Weather.** Box-score weather is observed, not forecast. It can grade a weather feature but cannot price with one until a pregame forecast source is ingested.
