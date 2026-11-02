# The matchup graphic, every other sport

NFL and college football games open their research page with the matchup
graphic ([`README.md`](README.md)); the NHL and the NBA have had the same
picture since 2026-10-20. From 2026-10-26 every other sport EdgeDesk prices
has it too, wherever a reader clicks a game:

| Sport | Model | Where the graphic is | Surface |
|---|---|---|---|
| Men's college basketball | `edgedesk_bb_points_v1` (`basketball/slate.json`, league `ncaam`) | Today's Games → the game's matchup view | court |
| Women's college basketball | the same, league `ncaaw` | Today's Games → the matchup view (the NCAAW pill is new) | court |
| WNBA | the same, league `wnba` | Today's Games → the matchup view (the WNBA pill is new) | court |
| MLB | the run model, `mlb/engine.js` `projectGame` | Research → Baseball → a game → its brief, at the top | diamond |
| College baseball | the run model, `projectCollegeGame` | Research → Baseball → College → a game → its brief, at the top | diamond |
| UFC | the served UFC Elo (`model_loop/published/ufc/current.json`) | Research → UFC (the next card), and Today's Games → the card's matchup view: a chip per bout, the main event first | octagon |

The builders are in `lib/edgedesk_sport_graphic.js` (`window.EDSportGraphic`).
Each one fills the football template's content
(`lib/edgedesk_game_graphic.js` `layout`), so the picture is the football
picture: the EdgeDesk lockup, both sides as monogram badges, three model
panels, a market strip or EdgeDesk's own detail, **What to watch for**, and
the footer. Square 1080×1080 and portrait 1080×1350; Download PNG, Share and
Copy link under it.

## What each picture says

**Basketball (all three leagues).** Fair spread with the model win
probability; the projected score, which is the slate's own projected total
and margin read back ((total ± margin) / 2, overtime included); the fair
total. With a captured price before the tip, the market strip (book, time,
spread, total, moneyline, the no-vig split and the gap in words); otherwise
the model moneyline, the push chance at a whole-number fair line (or the
projected margin) and each team's games this season. What to watch: **who is
playing** (availability is not in the number: check both injury reports),
rest (a back-to-back), the sample size early in a season, home court or a
neutral site, and the gap to the market or a close call.

**MLB.** Fair moneyline for the favourite with its win probability; the
expected runs; the projected total with the 80% range of the total. The
captured market when one is joined (run line, total, moneyline, the capture's
no-vig split, the total gap in runs); otherwise the model run line, model
moneyline and median total. What to watch: the probable starters (probable,
not confirmed), the club furthest from the league's run rate, the park and
the weather, and the engine's own classification of the model–market gap
(a research lean is "a reason to open the game, not an edge"; a data fault
replaces the market strip).

**College baseball.** Projected, never priced. The brief has always said
EdgeDesk turns none of the college numbers into a price, so the picture
carries what the board row carries: the projected margin in runs (labelled
"not a run line"), the expected runs, the projected total and the win
probability. The strip is each club's scoring and runs allowed against the
league and the median total. What to watch: starters (not in the feed),
the strongest rate, the conference adjustment, and the model's own data
warnings.

**UFC.** Fair moneyline for the favourite (the model's probability with no
margin); each fighter's UFC bouts in EdgeDesk's data (0 is a debut); the gap
between the model and the market's no-vig price in points, with the
disagreement guard's verdict ("CHECK WHY" when it disagrees, never an edge).
Fighters are people: their initials in neutral colours. What to watch: the
guard's reasons the model may misread the bout, a debut, a layoff over a
year, a five-year age gap, and always what no fight model sees (the weight
cut, short notice, injuries, the camp).

## The rules

- Every number is the model's own, from its artifact or engine. Nothing is
  re-estimated; a fair price is a probability with no margin.
- A market shows only as captured, before the start, with its book and time.
  Older than 180 minutes (MLB: the board's own 45-minute stale flag) it is
  the **last known market**.
- None of these models prints **EDGE**. Their value claims are off (the lab
  basketball model and the run models were never graded against the close;
  the UFC Elo is experimental), so a gap is stated in words and nothing more.
- The copy rule (`EDSportGraphic.BANNED`, the football graphic's) runs over
  every string; a graphic that would break it is not drawn.
- A game the model has not priced says so in the graphic's place: the lab
  slate prices 72 hours ahead, and an MLB game the engine refused draws "no
  EdgeDesk projection" with the engine's reason.
- Team identity is presentation: the MLB and WNBA clubs' colours, a stable
  colour pair from the name for a school, initials for a fighter. No logo.
- The public `/today/` page shows no graphic: the model is the terminal's.

## Today's Games

`lib/edgedesk_games.js` now lists women's college basketball (ESPN
`basketball/womens-college-basketball`, `groups=50`) and the WNBA (`basketball/wnba`),
each with its market ranges. `tools/slate/research.js` joins both, and men's,
to the lab slate; the fair spread is read from the slate's `fair_home_line`
(it read a field the slate does not carry, so men's games had shown no fair
line). The matchup view (`lib/edgedesk_games_ui.js`) mounts the graphic for
the sports without a research page of their own (`EDSportGraphic.SPORTS_WITH_BLOCK`),
reading `basketball/slate.json` or the UFC model file when the view opens.

For men's games the view also reads `basketball/ncaam_research/published/index.json`
(last season's record, adjusted net rating and offense and defense ranks, and
each school's colour, by ESPN id). What to watch for then carries each team's
record and net-rating rank and each offense against the other defense, and
the no-price strip carries the records and net ratings. Without the index the
graphic draws as before.

A neutral-site game that the schedule and the slate list with home and away
exchanged is read with the schedule's sides (`EDSportGraphic.flipGame`): under
the home-games-only intercept the model prices a neutral game the same either
way round. A home game listed the other way round is still not drawn, because
there the sides decide home court.

The ESPN women's and WNBA scoreboards were not read from the environment this
was built in (its network policy refuses `site.api.espn.com`); `npm run
slate:verify` on a runner shows what they answer.

## Tests

- `npm run sport:graphic:test` (`tools/sport_graphic/sport_graphic.test.js`):
  every committed lab-slate game as each basketball league, every served UFC
  bout, MLB and college baseball through the real engine; the numbers are the
  model's, college baseball carries no price, no EDGE label, the copy rule,
  the market's age, layout inside the canvas in both formats, the new
  surfaces, football unchanged, and the Today's Games join.
- `npm run sport:graphic:e2e` (`tools/sport_graphic/sport_graphic_ui.e2e.js`):
  Chromium over the real builder's slate: the new pills, the matchup view of
  a men's, a women's and a WNBA game (Portrait, Download PNG), an unpriced
  game, a UFC card's chips and keyboard focus, a 390 px phone, the public
  page, the UFC panel, and the MLB and college baseball briefs.
- CI: `.github/workflows/sport-graphic-tests.yml`.
