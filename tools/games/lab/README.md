# The gridiron lab

Two pages that draw the football renderer on its own, at sizes a phone never
shows it at, so it can be looked at rather than guessed about.

- `players.html` — every animation state and every build, in both kits, at
  game scale and at four times game scale. This is where the athlete is
  designed: if a lineman does not read as a lineman here, no amount of
  camera work will save him on the field.
- `weather.html` — the same twenty yards of field under every time of day
  and every sky, side by side. A night game and an afternoon game have to be
  two different pictures, and a grid is the only way to tell.

They are development tools. They are not linked from the product, they are
excluded in `robots.txt`, and they read the same `games/lib/gridiron/paint.js`
the game does — so they cannot drift from it.

Serve the repository root and open `/tools/games/lab/players.html`.
