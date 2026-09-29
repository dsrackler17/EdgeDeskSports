# Player Props — college football (FBS)

The same engine, board, drawer, record and desk run for FBS. The treatment is
**stricter**, because the inputs are weaker.

- **Scope.** FBS vs FBS games on EdgeDesk's FBS slate (`football/fbs/slate.json`),
  with the environment from its own model. The relevance filter is tighter than
  the NFL's: target share ≥ 10%, carry share ≥ 15%, and no longest-play props.
- **Data gaps, declared in `board.gaps`.** No snap or route participation is
  published, and there is no provider depth chart, so roles come from usage
  order. Team-games whose play-by-play records pass attempts but no completions
  are excluded as source faults.
- **Availability.** Comes from EdgeDesk's CFB availability reports. A
  missed-game prior (`missed_return`) prices an unreported return.
- **QB.** An uncertain starting quarterback marks every dependent prop
  **QB_UNRESOLVED**, which means WATCH.
- **Reliability.** Scaled by 0.88.
- **Thresholds.** BET needs edge ≥ 6 pp and EV ≥ 8%; LEAN needs 3 pp. The
  reliability floor is 68. The haircut floor is 0.15, so the market is trusted
  more. The estimated hold is 5.5%.
- **Stage.** Every CFB prop market is **EXPERIMENTAL**: no CFB walk-forward
  validation exists yet. An experimental market never carries units.
- **Identity.** CFB players are anchored on the ESPN athlete id. A player who
  reaches the NFL is linked across leagues by that ESPN id (`links.nfl`).
