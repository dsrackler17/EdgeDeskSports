# Runbook — the desk's own data

Five data sets the desk builds or keeps itself because no reachable feed
carries them. Each has one command, one check and one rule about what it
refuses.

## NFL stadiums (venue geography)

```
node tools/football/verify_nfl_stadiums.js      # exit 1 on any refused row
```

`football/venues/nfl_stadiums.json` is hand-entered. Add or correct a row
with its name, the names the feed has used for it (`aliases`), the club(s),
city, state, coordinates, roof, surface and time zone, then run the
verifier. It refuses a row that is more than 2 km from the college venue
register where both know the stadium, disagrees with games.csv on roof or
surface over three or more games, sits outside its state, or has a time
zone that does not match its longitude. A refused row is never read by the
identity build, the slate build or the forecast provider.

## Injury archive

```
node tools/football/build_injury_archive.js     # fetches missing seasons into the cache
node tools/football/build_injury_archive.js --check
```

Counts the official report (Out, Doubtful, Questionable) by position group
per team-week, 2009 on, and names the linemen and quarterbacks listed Out or
Doubtful. Practice-only lines are not availability records. The pricing
validation reads it for the injury feature arms.

## Opener ledger

```
node tools/football/build_lines_archive.js      # also refreshes the ledger
```

Records the first consensus number the build sees for every upcoming NFL
game, every later number, and the last before the result. It never
backfills: a game first seen with a result gets no opener. Runs with the
injury sync (every six hours), the starter build and the weekly build.

## Desk notes (what a person looked up)

```
node tools/football/add_note.js --sport nfl --team BUF --kind starting_qb \
  --text "Josh Allen confirmed to start by the club" --source "Buffalo Bills" \
  --url https://www.buffalobills.com/news/... --published-at 2026-09-16T14:00:00Z --by "D. Rackler"
node tools/football/add_note.js --list
node tools/football/add_note.js --expire
```

Kinds: starting_qb, starting_qb_confirmation, ol_availability,
ol_replacement, defensive_personnel, weather, current_price,
opponent_adjusted, projection. A note without a url, a publication time or
a recorder is refused. Notes expire after seven days. The investigation
loop reports a matching note as FOUND from its source at its publication
time and names who recorded it; it never calls it a search. Commit
`football/notes/current.json` after adding notes.

## CFB availability by hand

```
cp football/availability/manual/TEMPLATE.csv football/availability/manual/2026-w04.csv
# fill it from the conference report or the school's release, delete the example rows
node football/availability/import_corrections.js football/availability/manual/2026-w04.csv --dry-run
node football/availability/import_corrections.js football/availability/manual/2026-w04.csv
```

Every row goes through `operator.js`: a named player on the current
roster, the fixture, a source name AND url, the publication time and the
recorder, or it is refused with its reasons and not written. A CONFIRMED
starter needs an official team or conference url; otherwise it is
downgraded to PROJECTED. Entries expire; an official filing published later
supersedes them. Commit `football/availability/operator.json`.
