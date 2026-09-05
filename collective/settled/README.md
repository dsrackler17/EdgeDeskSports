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
