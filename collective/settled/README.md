# The Collective's settlement record

One file per sport and season, `<SPORT>_<season>.json`, written by the hourly
**Settle finished games** workflow (`tools/collective/settle_finals.js`) and
committed by it. Nobody edits these by hand.

Each file carries every finished game of that season the Collective holds a
real final for: the final score, where it came from (which public feeds agreed
on it, or `collective` when the database already held it), the Collective's own
captured closing line, and the moment the record first saw the game.

`collective/index.html` reads its sport's file from this origin and grades every
model on it by the published rule, so the site's record depends on no edge
function being deployed, reachable or written to. A game the server has really
settled still wins on the page; the record fills what the server left blank or
settled 0-0.

A 0-0 score is never carried here. No football game ends 0-0; two zeros are the
shape of a blank results form, and the settle job refuses them at the feed.

## The captured closing line, and why it was missing

A final score grades two of the three metrics on this site. The third — the
against-the-spread record, the one every reader means by "how did we do" —
needs the Collective's own captured closing line as well, and for the 2026
college season this file carried one for **0 of 104** finished games while
the NFL file carried one for **15 of 15**.

The cause is in the join, not in the data. The Collective's schedule stores
team names cut to **ten characters** — `Mississippi` is `MISSISSIPP`,
`West Virginia` is `WESTVIRGIN`, `Florida State` is `FLORIDASTA`. 61 of the
142 team names in the college record are exactly ten characters long. NFL
team names are two- and three-letter codes and pass through unchanged, which
is why one sport looked fine and the other looked empty. Every route to a
closing line joined on that stored string, so the college games could not
find their own market row and the close was recorded as `null`.

The settle job now goes back for them, in this order, and writes down which
answered in `close_source`:

| `close_source` | where the number came from |
|---|---|
| `collective` | the Collective's own game row already carried it |
| `collective_odds` | `collective_odds /v1/<league>/closing/<game_id>`, joined by id |
| `collective_odds_board` | the odds board for that week, joined on the team pair and the kickoff day, tolerating the ten-character cut |
| `null` | no close is held for this game. It is graded on its score alone and has **no** against-the-spread result — not a loss, not counted |

The board join takes an exact match on both sides outright, considers a
truncated match only when nothing matches exactly, requires one side to be
exactly right even then, and refuses whenever two rows fit equally:
`NORTHCAROL` is the truncation of both North Carolina and North Carolina
State, and a closing line taken on a coin flip would put a win or a loss on a
record from a different game. It reads `closing` and never `consensus`, so a
current price is never mistaken for a close.

Measured on this record against the full team names in
`football/players/teams/`: the exact join reaches 55 of the 104 college games,
the new one reaches 97. The 7 it refuses are the games with *both* names at
the ten-character boundary; they stay reachable through the per-game route,
which joins on the id and guesses at nothing.

Two rules protect what is already here:

* **A close on file is never blanked by a run that found none.** One odds
  outage used to erase a captured line out of this file, and the next run
  reads the file it just emptied, so the loss was permanent.
* **`close_source` names a close, never an attempt.** A lookup that came back
  empty leaves both fields `null` rather than labelling an absence.

To repair a record written before any of this existed:

```
npm run collective:closes -- --sport CFB --season 2026            # dry run
npm run collective:closes -- --sport CFB --season 2026 --commit   # write it
```

It fills only nulls, touches no score, team, week or kickoff, keeps
`settled_at` (when the record first saw the game), and running it twice
changes nothing. The hourly workflow runs it too, so a close that becomes
available a day after the game still reaches the record.
