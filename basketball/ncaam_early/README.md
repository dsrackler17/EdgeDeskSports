# NCAAM-EARLY — the early-season men's college basketball research model

Model id `edgedesk_ncaam_early_v1`, registry key `NCAAM-EARLY`. It is a T3
research model and **EXPERIMENTAL**. Men's NCAA Division I only. In this
repository `cbb` means college **baseball**, so everything here is named
`ncaam_early` / `ncaam_es_*`.

## Why it exists

The first six weeks of the season, through mid-December, are when ratings know
least. In the sibling model's own validation (`docs/ncaam/VALIDATION.md`):

- November margin MAE is 10.2, against 8.8–8.9 from January on;
- 80% intervals cover 77% in November, and 76% for teams with 0–4 games
  played.

NCAAM-EARLY measures what a carried-over rating cannot see:

- the continuity gap between the two teams;
- where each transfer came from, and at what level;
- departed production;
- coaching changes;
- the uncertainty those leave.

**It is built on the existing ratings engine** (`basketball/ncaam_research/team_model.js`,
the engine of NCAAM-FORECAST). It is not a second rating system.

**Prior evidence, disclosed:** that engine already has a simple continuity and
transfer term (`continuity_slope`, `transfer_beta`). Its ablation came out at
+0.002 [−0.015, +0.019] on 2026: it won 2025 and was not confirmed in 2026, so
the champion runs with it off. NCAAM-EARLY's hypothesis is registered knowing
that.

## Status

| Layer | State |
|---|---|
| **T0 data layer** (this directory, `supabase/ncaam_early.sql`) | built and tested; **not deployed**; the sync is **off** (`NCAAM_EARLY_SYNC`) |
| Registration (windows, promotion criteria) | next pull request, before any result exists |
| T2 features, T3 model, market comparison | later pull requests |
| Card and image, grading, accountability | later pull requests |

## Evidence tiers

- **T0, observations.** Schedules, scores, box lines, player seasons, rosters,
  the transfer portal, recruits and provider lines, all from
  CollegeBasketballData.com. Hand-entered coaches, availability and school
  levels, each with its source. Odds come from the odds gateway, not from here.
- **T1, external estimates.** **None.** No licence covering Torvik, KenPom or
  EvanMiya ratings was found (Phase 0, 2026-11-01). CBBD's own `/ratings/*` are
  not read either.
- **T2, deterministic transforms.** Possessions are computed here as
  `FGA − OREB + TOV + 0.475·FTA`, the NCAAM forecast dataset's estimate, with
  CBBD's own figure kept beside it, never mixed in. The derived player moves
  are also T2. Every other transform is in a later pull request.
- **T3, the model.** In a later pull request.

## The data layer

| File | What it does |
|---|---|
| `config.js` | seasons, CBBD settings (call cap, shared-quota reserve), parts, paths |
| `config/cbbd_endpoints.json` | every endpoint and query parameter used, checked against the published OpenAPI document (version 1.30.1, sha256 recorded, 2026-11-01), with each documented row cap |
| `cbbd.js` | the client: refuses anything off that list; Bearer key, redacted everywhere; call cap; stops below the reserve; bounded retries; splits a window that hits a row cap |
| `normalise.js` | payloads to rows. Rejects, never repairs; checks the END-year season convention against CBBD's own `seasonLabel`; LIVE/RETRO labels |
| `moves.js` | derives each player as returning / D-I transfer / portal transfer / freshman / unknown, plus departures, source level and last season's minutes share |
| `manual.js`, `manual/*.json` | the hand-entered observations and their validators |
| `ingest.js` | the sync: fetch, cache, normalise, store, one run row per part and season |
| `db.js` | the RPC client; it can call only `ncaam_es_*` functions |
| `tests/data.test.js`, `tests/sql.test.js` | the suites (`.github/workflows/ncaam-early-tests.yml`) |

### CBBD endpoints (verified 2026-11-01)

| Used | For |
|---|---|
| `/teams?season` | the season's team list. `sourceId` is checked against the ESPN ids the existing engine uses, and the rate is recorded per run. |
| `/conferences/history` | conference membership with start and end seasons |
| `/venues` | venue city, state and country (**no coordinates**) |
| `/games` | schedule, status and finals (≤ 3,000 games a call; windows are split until they are under it) |
| `/games/teams` | team box lines (≤ 3,000 games a call) |
| `/stats/player/season?season` | player seasons: usage, offensive and defensive rating, PORPAG, win shares, shooting, rebounding. A date range is also accepted, for later "as of" pulls. |
| `/teams/roster?season` | rosters with start and end season, height and weight. **No previous school and no capture time.** |
| `/recruiting/portal?year` | portal entries: origin and destination school (with id when D-I), stars, rating |
| `/recruiting/players?year` | recruits: athlete id, committed school, stars, rating, ranking |
| `/lines?season` | provider lines with opening values, **no times** |

**Not in the spec:** coaches, and any previous-school field. Coaches are
entered by hand.

### Point in time

- **Rosters.** A team's whole roster is stored again only when it changes
  (`ncaam_es_roster_captures`). The roster known at time *t* is the capture
  with the latest `captured_at` at or before *t*. A capture taken before the
  season's first regular-season tip is `LIVE`; anything later is `RETRO`.
- **Earlier seasons have no point-in-time roster in any source.** Their
  rosters are read now, after the fact, and are `RETRO` reconstructions. The
  moves derived from them use last season's player records, the portal and
  recruiting, and the limits are stated on every derived row (`evidence`,
  `roster_pit`).
- **Portal, recruits and lines** get a new row only when an entry changes.
  Lines read after tip are `RETRO`: the provider's last value, not a
  certified close.
- **Portal and recruiting `year`.** The offset from `year` to the season is
  verified from the data (`moves.js verifyOffset`), never assumed. When it
  cannot be verified, the portal and recruits are not used at all.

### Data terms and storage

CBBD's terms (read 2026-11-01):

- commercial use and derived outputs are permitted;
- raw API data may not be published "as a standalone dataset or bulk
  download";
- the quota is shared with CollegeFootballData.

**This repository is public, so no CBBD row is committed.** Raw responses are
cached under `/.cache/ncaam_early` (gitignored; in CI, the Actions cache).
Rows are stored in `ncaam_es_*` tables that only `service_role` can read:
RLS is on with no policy, and the client grants are revoked. The run manifest
holds counts, hashes and the quota, and no data row (a test checks this).
`ncaam_es_readiness()` is open to everyone and returns KPIs only.

### The quota

- **CBBD and CFBD share one quota.** The CFB SP+ job uses `CFBD_API_KEY` on
  the free tier. CBBD publishes no numeric limit, and the tier for the CBBD key
  is the owner's choice.
- **Every run is capped** at 40 calls by default, and at most 250 by hand.
- **No call is made** once the provider reports fewer than 300 remaining
  (`X-CallLimit-Remaining`, when it sends it). The football jobs keep that
  margin.
- **Expected spend:**
  - daily (rosters, games): about 3 calls;
  - Mondays (adds teams, box lines, player seasons, lines, portal and
    recruits): about 12;
  - about **130 calls a month** in all;
  - a full backfill, 2019–2027: about 25 calls a season, about 225 once.
- **Current-season box scores** also reach the existing engine free, through
  the hoopR/ESPN dataset NCAAM-FORECAST ingests daily.

## Operating it

**Prerequisites** (the owner):

- the CBBD key in the Actions secrets (`CBBD_API_KEY`) and in Supabase
  secrets;
- `SB_URL` and `SB_SERVICE_ROLE`, which already exist;
- `SB_DB_URL` for the deploy.

**Steps:**

1. **Deploy the tables.** Run Actions → *Deploy NCAAM early-season SQL*. It
   runs the SQL suite on a throwaway PostgreSQL, then applies
   `supabase/ncaam_early.sql` in one transaction. Every report row should read
   `ok`.
2. **Capture the 2026-27 rosters now.** Run Actions → *NCAAM early-season
   sync* with parts `teams,games,rosters,portal,recruits` and season
   `current`. Rosters captured before the first tip (2026-11-02/03) are the
   only `LIVE` rosters this season will ever have.
3. **Backfill.** The same workflow with mode `backfill`, seasons `2019-2026`,
   parts `all`, and a call cap that fits the quota. Split it over several
   days if the free tier is small. Then run parts `moves` for each season.
4. **Turn the schedule on.** Set the repository variable
   `NCAAM_EARLY_SYNC = on`. Without it the scheduled run is skipped, and is
   never reported as a sync.
5. **Coaches.** Enter the 2026-27 head coaches in `manual/coaches.json`,
   starting with the changes. Each record needs its CBBD team id (from step 2)
   and at least one source URL. `node basketball/ncaam_early/tests/data.test.js`
   validates the file. Earlier seasons are incomplete, and say so.
6. **Watch** System health → *NCAAM early-season sync* (`ncaam_es_readiness`):
   - freshness of games and box lines;
   - failures in 24 h, and parts failing twice in a row;
   - box coverage;
   - teams with a live roster;
   - coach records;
   - the shared quota.

**To stop:** set `NCAAM_EARLY_SYNC` to anything but `on`. Stored rows stay.

## Known limitations of the data layer

- No point-in-time roster exists for any past season: those rosters are
  `RETRO` reconstructions.
- A non-D-I transfer's level is known only when a person lists the school in
  `manual/school_levels.json`. Otherwise it is `NON_D1_UNCLASSIFIED`.
- Portal matching uses the exact normalised name on the destination roster.
  Ambiguous names are counted and not matched.
- No source gives coaches or injuries: both are hand-entered, and incomplete
  for history.
- Venues have no coordinates, so travel distance needs another owned source
  (a later pull request).
- CBBD lines carry no times. EdgeDesk's own captures (the odds gateway) are
  the market record for the live season.
