# Unresolved research questions

Time-boxed: each was investigated far enough to state what would resolve it.

| # | Question | Status | What would resolve it |
|---|---|---|---|
| U-01 | Commercial rights to NCAA-derived statistics | OWNER DECISION | owner review of the NCAA terms; `research/authorizations.json` signed (gate G1) |
| U-02 | Sportsbook market for college baseball | BLOCKED | authorise `baseball_ncaa` in `public.odds_api_sports` with a quota; capture closes for a season before any market test |
| U-03 | Does the first listed pitcher always start? | OPEN | parse "X to p for Y" in play-by-play descriptions for 2024–2026 and compare the first Y with the box score's first pitcher |
| U-04 | Run rules per conference and per series (Friday/Saturday/Sunday differ in some conferences) | OPEN | conference handbooks (not reachable here), or a per-conference measurement once enough games accumulate per context |
| U-05 | Separate starter and bullpen elasticities; lineup quality vs the starter | OPEN | refit the hybrid with two elasticities on 2024–2025 and test on 2026+ |
| U-06 | Historical weather as forecast at prediction time | BLOCKED | an authorised forecast archive plus venue coordinates; realised weather would leak |
| U-07 | Base-out run expectancy (RE24) | OPEN | reconstruct base states from runner-advance text; measure the reconstruction error on games whose linescores are known |
| U-08 | Pitcher identity before 2024 | OPEN | track pitchers through play-by-play substitutions (2017–2022) to extend the pitcher window |
| U-09 | Did the 2023 season's missing results exist elsewhere? | OPEN | the EdgeDesk `cbb` ESPN union, if it was running in 2023, or another archive |
| U-10 | Does the NCAA use the automatic extra-inning runner in any context? | MEASURED NO (pooled) | extra-inning scoring is below regulation scoring (rules_evidence R07); a per-season or per-event check if a rule change is announced |
| U-11 | Starter confirmation sources | BLOCKED | a timestamped, authorised feed of announced starters; until then every starter is PROJECTED or UNKNOWN |
