# CFB team and game identity

No production join is made by a string like "Miami". A team is an internal id, a game is a canonical key,
and anything that cannot be resolved fails that game safely. Nothing is guessed.

Code: `football/cfb_lab/identity.js` (node). Tests: `football/cfb_lab/integrity.test.js` §7 and
`football/cfb_decision/integrity_gates.test.js` (the decision join).

## 1. The team identity master

| field | source |
|---|---|
| `internal_team_id` | the FBS universe key (`football/fbs/fbs.js` `normKey` of the school's schedule name): `miami`, `miamioh`, `texasam`, `ohiostate`, `ohio` |
| provider ids | the ESPN team id, which is also the CollegeFootballData team id (the same numbering: New Mexico State = 166, Miami = 2390, Miami (OH) = 193), from `football/fbs_epa/teams.json` |
| name, aliases | the school name, plus `fbs.js` `TEAM_ALIASES`, the one alias table the board, the capture join and the desk already share |
| historical context | division and conference per season, 2014 onward |

The master holds 250 teams: every FBS program and every opponent since 2014. All 60 games of the current
slate and every row of `football/cfb_v2/current.json` validate cleanly.

**Resolution order** (`resolveTeam`):
1. A provider id: an exact numeric match.
2. An internal id: an exact match.
3. A name, through `fbs.resolveTeam`: exact, alias, "St." expansion, then the longest unambiguous prefix.
   A tie resolves to nothing ("Ohio" never swallows "Ohio State").

An id and a name that disagree (id 2390 = Miami, name "Miami (OH)") resolve to **nothing**, and
`sameTeam` returns **false**. `sameTeam` returns true only when both sides resolve to the same team or the
raw names are identical. It returns null when it cannot tell, and a null is never treated as a match.

**Adding a spelling.** Add it to `TEAM_ALIASES` in `football/fbs/fbs.js`; its tests guard the prefix trap.
A new program appears in the master when `football/fbs_epa/teams.json` is rebuilt.

## 2. Automatic team-mapping validation

`validateGame({home_team, away_team, home_id, away_id, season, home_conference, away_conference, kickoff})`:

| problem (the game fails) | warning (the game proceeds, flagged) |
|---|---|
| `HOME_UNMAPPED` / `AWAY_UNMAPPED`: a team does not resolve | `HOME_NOT_IN_SEASON` / `AWAY_NOT_IN_SEASON`: no entry for this season although later seasons exist |
| `SAME_TEAM`: both sides resolve to one team | `HOME_CONFERENCE` / `AWAY_CONFERENCE`: the feed's conference disagrees with the master's for the season |
| `SAME_TEAM_ID`: home_id = away_id | |
| `KICKOFF_UNPARSEABLE` | |

**Where it is enforced:**
- **Model Lab data quality** (`models.dataQuality`, check `team_mapping`). It compares the model's teams
  (ids and names) with the published board's teams through the master. The outcomes:
  - both teams match: GREEN;
  - home and away swapped: RED;
  - a different team, or home = away: RED;
  - names that differ and cannot be verified: RED, because an unknown mapping fails safely.

  A RED forces PASS and caps the stored confidence, as every RED does.

  **Bug fixed.** The previous check matched by substring (`'miamioh'.includes('miami')`), so "Miami"
  passed as the schedule's "Miami (OH)". It is now RED, and the test is in `integrity.test.js`.
- **Market capture** (`market.screenCandidates` → `integrity.validateQuote`): a quote whose teams are the
  game's in the other orientation, or are different teams, is REJECTED into the quarantine
  (MARKET_INTEGRITY.md §3).
- **Odds API event map**: the board's own join (`joinSignalsToGames`). Both teams must resolve to the game's
  own teams in this orientation, with kickoffs within 36 h. A swapped or ambiguous match is refused.
- **Decision engine** (`decision.js` integrity check): the quote's home team must be the projection's
  home team through the master. "Texas Tech Red Raiders" is Texas Tech; "Texas Longhorns" is not. The
  previous check compared lowercase strings, so every ESPN / Odds API quote that carries a nickname failed
  the join (a false PASS_DATA_QUALITY).
- **Duplicate-game check** (`checkpoint.pairCounts`, `models.dataQuality`): matchups are keyed by canonical
  ids (`identity.pairKey`), so "Miami (FL)" and "Miami" are one team.

## 3. Game identity master

`gameIdentity(game)` returns the canonical key `season|home_internal_id|away_internal_id|UTC kickoff date`
and the provider's own record, kept for debugging: `source`, `game_id`, the provider's home/away names and
ids.

`findDuplicates(games)` finds the same matchup under two provider ids, in the same **or the swapped**
orientation, with kickoffs within 36 h (`SAME_ORIENTATION` / `SWAPPED_ORIENTATION`). A rematch weeks later
is not a duplicate.

## 4. Home/away protection

For every projection, these must hold:

| check | where |
|---|---|
| home id ≠ away id | `validateGame` (lab data quality); the extreme review (`MAPPING: home and away are the same team`) |
| home features belong to home | the model's own home/away ids and names must match the schedule's home/away, in orientation (swapped → RED) |
| the market's orientation | ESPN lines are read by the record's orientation-checked reader, and readings that disagree about which side is favoured are dropped. Odds API lines are the named home team's number whatever order the book lists the outcomes (`capture_feed.test.js`, `sign_suite.test.js`) |
| provider orientation kept for debugging | quotes store `home_team` / `away_team` as the provider named them; `gameIdentity().provider` records the provider's view |

## 5. Player identity (review only; owned by `football/cfb_v2/research/v2/personnel/identity.py`)

Reviewed, not changed. The registry:
- uses the ESPN athlete id as the canonical `player_id` (`espn:<id>`), which survives a transfer;
- resolves an exact id first, then a name within (team, season) only when that name is unique;
- returns None for an ambiguous name, never matching by name alone across teams;
- records transfers from game evidence, with no invented portal dates;
- reports identity quality: same-name collisions and ids with more than one name.

Its team ids are the same ESPN/CFBD numbers this master maps (`provider_ids.espn`). No gap was found that
changes a production number.
