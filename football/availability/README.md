# EdgeDesk CFB Availability Intelligence

College football has no universal injury report. There is no free, standardized
CFB equivalent of the NFL's league-filed report, so EdgeDesk builds its own
availability layer out of public evidence — and says exactly how good that
evidence is.

The product's credibility comes from admitting what it does not know, so these
four are never collapsed into one another:

| What EdgeDesk says | What it means |
|---|---|
| **Verified availability flags** | a source EdgeDesk trusts named a player and a designation |
| **No reported injuries** | an *official* report was read and it listed nobody |
| **Partial coverage** | some players verified, but CFB has no universal report |
| **No verified data** | EdgeDesk looked and found nothing it would publish |

## The pieces

| File | What it owns |
|---|---|
| `availability.js` | the deterministic core: status normalization, identity resolution, source precedence, confidence, impact, canonicalization, freshness, game summaries |
| `collectors.js` | one function per source. Turns a page or a feed into raw reports. Decides nothing. |
| `fetch_availability.js` | the pipeline: collect → resolve → rank → write the dataset |
| `build_sources.js` | regenerates `sources.json` from the roster dataset plus `sources.overrides.json` |
| `sources.json` | the registry: every FBS program, keyed by the ESPN team id the roster sync uses |
| `sources.overrides.json` | **the file you edit** to add an official source |
| `availability.test.js` | the rules, offline, on fixtures |
| `../../.github/workflows/availability-sync.yml` | the schedule |

Ingestion is isolated from presentation. `availability.js` and the collectors
never render anything; the card, the brief and the Full picture never scrape
anything. The browser reads one committed file.

## Dataset output

```
football/availability/current.json        lean — what the app loads
football/availability/current.full.json   evidence, unresolved, failures — the admin view
football/availability/<season>/week-NN.json   the archive, one file per week
```

Nothing is committed until the sync runs for real. Until then the card keeps
saying the report is not on file, which is the truth.

Records are content-addressed (`digest`), so a run that changes nothing commits
nothing.

## Adding a school or a source

Edit **`sources.overrides.json`** only. No code change, no redeploy.

```jsonc
{
  "conferences": {
    "Big 12": { "availability_url": "https://big12sports.com/availability-report" }
  },
  "teams": {
    "2641": {                                    // the ESPN team id, same one the roster sync uses
      "conference": "Big 12",
      "availability_url": "https://texastech.com/football-availability",
      "football_news_url": "https://texastech.com/news/football",
      "depth_chart_url": "https://texastech.com/sports/football/roster",
      "beat_sources": [
        { "name": "Beat Reporter Name", "url": "https://…", "source_type": "TEAM_REPORTER" }
      ]
    }
  }
}
```

Then:

```
node football/availability/build_sources.js      # merge it into sources.json
node football/availability/fetch_availability.js --only 2641 --dry
```

Find a team id with:

```
node -e "require('./football/availability/sources.json').teams
  .filter(t=>/Texas Tech/i.test(t.team_name)).forEach(t=>console.log(t.team_id,t.team_name))"
```

An entry is used **only when it carries a url**, so a half-filled entry is inert
and safe to commit. A conference entry is inherited by every school in it.

**What must never be added:** forums, message boards, aggregators, fantasy
sites, betting Discords, crowdsourced injury guesses, anything AI-generated.
`availability.js` refuses them by url and by name, and the test suite asserts it.

## How a page is read

The official-page extractor is **anchored on the roster**: it scans the page
text only for names already on that team's roster and reads the status from the
words around the name. A name that is not on the roster can never become a
player, and a page the extractor cannot read yields nothing rather than a guess.

## Status normalization

| The source says | EdgeDesk records |
|---|---|
| ruled out, will not play, out for the season | `OUT` |
| unlikely to play, doubtful | `DOUBTFUL` |
| game-time decision | `GAME_TIME_DECISION` |
| questionable, uncertain | `QUESTIONABLE` |
| day-to-day | `DAY_TO_DAY` |
| probable, likely to play | `PROBABLE` |
| expected to play, cleared to return | `EXPECTED` |
| available, active, no restrictions | `AVAILABLE` |
| limited role, on a snap count | `LIMITED` |

Practice is a **separate field** (`DNP` / `LIMITED` / `FULL`), because it is a
different fact:

- **"did not practice" never becomes OUT.**
- **"full participant" never becomes AVAILABLE.**
- A non-contact jersey, a walking boot, warmups or leaving a game early are
  recorded as *observations* and never upgraded to a designation.
- A denial ("no longer questionable") is not a designation.

## Source precedence

| Tier | Types |
|---|---|
| 1 | `OFFICIAL_TEAM`, `OFFICIAL_CONFERENCE`, `COACH_QUOTE`, `DEPTH_CHART` |
| 2 | `TEAM_REPORTER`, `REPUTABLE_MEDIA` |
| 3 | `GAME_PARTICIPATION`, `OTHER` |

Canonical = highest tier, then highest confidence, then newest. A lower-tier
report that disagrees **never overwrites** a higher-tier one; it is kept in
`contested_by` with the reason it did not win.

| Case | Result |
|---|---|
| Official says QUESTIONABLE, a publication says OUT | **QUESTIONABLE**, contradiction recorded |
| Official Tuesday QUESTIONABLE, official Friday OUT | **OUT** |
| Reporter OUT Thursday, official AVAILABLE Friday | **AVAILABLE** |

## Confidence

| Level | Earned by |
|---|---|
| `CONFIRMED` | official team or conference report with an explicit designation |
| `HIGH` | coach statement or depth-chart designation |
| `MEDIUM` | credentialed reporter or major outlet with a designation |
| `LOW` | indirect evidence: participation, depth-chart movement |

The AI layer **consumes** this value and never chooses it.

## Impact

Role-based and deterministic. Without a depth role from a real source EdgeDesk
does not claim a player is a starter, so his impact is capped.

| | with a starter role | without one |
|---|---|---|
| QB | HIGH | MEDIUM |
| OL, EDGE | HIGH | LOW |
| WR, RB, TE, DL, CB, S, LB | MEDIUM | LOW |
| K, P, LS | LOW | LOW |

A *questionable* starter is one notch below an *out* starter. An AVAILABLE or
EXPECTED player is news, not an absence, so his impact is LOW.

## Freshness

`LIVE` ≤6h · `CURRENT` ≤48h · `AGING` ≤96h · `STALE` ≤7d · `HISTORICAL` older,
or filed before this game week. Stale records are **kept** as history and
**excluded** from the current-game summary. Last week's OUT is never this week's.

## Game participation

Used only as a fallback, only for a player another source already put in
question, and worded as availability evidence:

> Did not record participation in the last completed game.

Never *"the player is injured"*.

## The schedule

| When (UTC) | Cadence |
|---|---|
| Saturday | hourly |
| Sunday 00:00–05:00 | hourly (Saturday night ET) |
| Sunday, Monday | every 6 hours |
| Tuesday–Thursday | every 3 hours |
| Friday | every 2 hours |

One failed source never fails the run. Failures are recorded per team and shown
in the inspection view.

## Where it surfaces

One dataset, one presentation path (`EDCARD.availabilityFor` → `EDPRES`):

- **Edge card** — the availability flag, the listed players with source,
  confidence and practice trail, and the coverage sentence
- **Top-edges strip / watchlist** — a one-line chip (`QB1 questionable · LT out`)
- **Full picture** — the availability spotlight, per side, with what it would
  mean and the explicit note that the model does not adjust for it
- **Research brief** — a plain-English availability section with its sources
- **AI narration** — the same structured record, as facts it may summarize only
- **Publisher desk → Availability data** — coverage, unresolved reports and
  failed sources

## Known coverage gaps

1. **No official sources are configured yet.** `sources.overrides.json` ships
   empty on purpose: shipping URLs that were never fetched would be exactly the
   kind of unverified claim this layer exists to prevent. Automated coverage
   today comes from the ESPN feeds this repo already trusts. Add schools per the
   instructions above; coverage rises immediately, with no code change.
2. **No CFB depth chart is authoritative.** Roles come from ESPN's depth charts
   where they exist; without one, impact is capped and no starter is claimed.
3. **Conference availability reports** are inherited once configured; none is
   configured yet.
4. **The sandbox cannot reach ESPN**, so the collectors are fixture-tested here
   and run for real in GitHub Actions, exactly like the roster sync.
5. **Availability moves no model number.** It is context until a deterministic
   player-value adjustment exists.

## Tests

```
node football/availability/availability.test.js
```

Covers name matching, suffixes, initials, apostrophes, duplicate names, team
resolution, status normalization, the observation-only cases, source
precedence and all three conflict scenarios, confidence, impact, stale data,
duplicate and conflicting reports, unresolved players, the timeline, game
summaries, the four coverage states, the extractor, and the pipeline end to end.
