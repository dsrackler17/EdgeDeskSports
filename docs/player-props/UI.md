# Player Props — the surfaces (`lib/edgedesk_props_ui.js`, `lib/edgedesk_props.css`)

Every number is read from the committed files and priced by `EDProps`. The
drawer re-runs `EDProps.prepare` on the same projection, quotes and board
context; it never simulates and never computes a football number.

| Surface | Where |
|---|---|
| **Research → Props** | The tab after Football, with three segments. |
| **The research drawer** | Opens from any row or card, a game card, a player page, or the deep link `#research/props/<league>\|<projection_id>`. Esc or Back closes it. |
| **Game cards** | NFL cards and FBS (P4) cards carry a *Player prop research* section. |
| **Player pages** | `/players/?p=nfl/puka-nacua`, with `/players/nfl/puka-nacua` routed there by `404.html`. `/players/` is the index. |
| **Lab** | The *Player props validation* tool. |
| **Public record** | `record.html#player-props`: W-L-P, voids, win rate against the mean probability, Brier against the market, CLV, flat ROI, and results by prop. |
| **Landing** | Card 04, *Players + player props*, and the plan list. |

**The Props tab segments:**

- **Board.** NFL/FBS switch, position chips, and filters: slate, market, prop,
  sportsbook, reliability, stage, decision, minimum edge, minimum EV, best price
  only, and search. Columns are player, prop, line, best price, fair line,
  projection, P(O/U), fair odds, edge, EV, decision, reliability and move. Every
  column sorts, and the player column stays sticky.
- **Validation & record.** The walk-forward gates, pass or fail, and the live
  record.
- **Season rates.** The older `model_props` projections, unchanged.

**The drawer's sections:**

1. the decision;
2. the hero numbers (book line, projection, fair line, probability, best price,
   no-vig, edge, EV);
3. links: Ask the Research Desk, player page, game research, all props in the game;
4. WHY and RISKS;
5. the market (every book, movement, sharp reference);
6. the distribution chart and percentiles;
7. every line and price (BEST PRICE / BEST EV / SAFER LINE / HIGHER UPSIDE) and a
   price calculator;
8. opportunity;
9. recent form (shown, not chased);
10. matchup;
11. availability, including redistribution;
12. game environment;
13. reliability and the stage gates;
14. correlated props.

**The game-card section** shows: the top research prop, the biggest model/market
disagreements, the watch list, a pass, and *View all player props for this game*.
Without prices, it shows fair lines only.

**Mobile.** Below 760 px the table becomes cards and the drawer fills the
screen. Nothing scrolls sideways (`tools/props/props_ui.e2e.js` checks this at
390 px).
