# Can we trust this number? The college game-by-game audit

`football/cfb_validation/trust.js` sets every upcoming college game beside
what this season has already shown. It is research only. It changes no
number, no Research Grade and no label, and it fetches nothing.

```
npm run cfb:trust                                   # the report, as markdown
node football/cfb_validation/trust.js --json        # the full object
node football/cfb_validation/trust.js --out DIR     # write DIR/trust.json and DIR/TRUST.md
node football/cfb_validation/trust.js --now ISO     # as of that moment
npm run cfb:trust:test
```

## What it reads

| File | What it gives |
|---|---|
| `record/football/cfb_<season>.json` | every graded game: the pick as published, the close, the verified final |
| `football/fbs/slate.json` | the upcoming games, each with the engine's additive terms and both rating tracks |
| `performance/ledger/quotes/cfb-<season>.jsonl` | the pregame sportsbook quotes, each with its capture time |
| `lib/edgedesk_factor_evidence.js` | each term's held-out record, in words |

`--now` bounds everything. A graded game counts once it kicked off 4 hours
before the moment. A quote counts only if it was captured before both the
game's start and the moment. Only games not yet started are audited.

## What each game gets

1. **The gap.** EdgeDesk's unrounded margin minus the latest pregame line,
   and the team EdgeDesk is more bullish on. Within 1.5 points the two
   `AGREES`. With no captured line the game is `NO_LINE`.
2. **The terms behind the number.** Team strength, home field and the
   stylistic matchup, which add up to the margin. A game whose matchup term
   points the same way as the gap and is at least half of it is flagged
   `MATCHUP_TERM_CARRIES_GAP`. That term is in the number, but its gain on
   games it was never fitted on is not significant
   (`docs/cfb-validation/LOTO.md`).
3. **Past weeks.** The team-strength term blends two tracks:
   - the long-run track, last season's rating carried forward and moved by
     every game since;
   - this season's games alone.

   From six games played, the long-run track keeps 60% of the weight.
   The audit prints both tracks, and the margin with team strength taken
   from this season's games alone. When that margin sits at least 1 point
   nearer the line, the game is flagged `LONG_RUN_TRACK_CARRIES_GAP`.
   - The this-season-only track is not a better estimate. Through week 7 it
     added nothing beyond the model (`docs/cfb-calibration/README.md`, "Stale
     prior?"). The flag says where the gap comes from, not who is right.
4. **The teams.** Each team's graded games against FBS opponents, from its
   own side:
   - how much higher or lower EdgeDesk rated them than the closing line did;
   - where the games finished against the close;
   - both miss sizes.

   FCS games are listed but left out of the summary. Every FCS team is one
   floor rating, so those games are a different population.
5. **The season's record at that gap.** On this season's graded FBS-vs-FBS
   games with about the same gap between EdgeDesk and the close, how often
   the close finished nearer the final, and how often EdgeDesk did.

## The two season tests the reads stand on

- **Does a disagreement with the close carry information?**
  - The slope of (final − close) on (EdgeDesk − close).
  - Above 0 with its 95% interval: EdgeDesk's disagreements point toward the
    result.
  - At 0: a gap is not evidence that the line is wrong.
- **Do the ratings absorb past weeks?**
  - Walk forward week by week. Each FBS-vs-FBS game is set against the two
    teams' mean miss (final − EdgeDesk) in earlier weeks only.
  - A slope above 0 would mean the ratings lag what teams have shown.
  - At 0, the number already holds what those games showed.

**As of 2026-10-27 13:30 UTC** (393 graded FBS-vs-FBS games, 278 in the
past-weeks test):

| | |
|---|---|
| EdgeDesk off by / the close off by | 11.90 / 10.99 points a game |
| the close nearer the final | 233 games (59.3%); EdgeDesk 158 (40.2%) |
| EdgeDesk's side against the close | 187-201-5 |
| disagreement slope | −0.13 (95% CI −0.42 to +0.16): no measurable information |
| at a 7+ point gap | the close nearer in 40 of 58 (69%) |
| earlier misses → next miss | +0.02 (95% CI −0.13 to +0.17): they do not carry over |
| live slate, mean gap toward the home side | +0.28 points (15 games with a line) |

So the college model does not systematically overrate one kind of team.
It does absorb past weeks. It is not yet more precise than the closing
line. When it disagrees with the line, the line has finished nearer more
often, by a wider margin the bigger the gap.

## What it is not

- Not a pick and not an edge. The words it uses are the copy rule's
  (`lib/edgedesk_game_graphic.js` `BANNED`), and its tests check them.
- Not a grade. The Research Grade (`docs/research-grade/METHODOLOGY.md`)
  is unchanged. Folding any of this into the grade would be a methodology
  change: its own pull request, with evidence.
- Not a model change. No priced number reads it.
