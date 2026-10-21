# The CFB board prices the governance champion

**Before this, nothing a reader saw depended on governance.** The board (`app.html`) and the slate
build (`football/fbs/build_coverage.js`) both called `EDCfbP4.projectGame()` and priced V1
(`cfb_p4`), whatever `football/cfb_lab/governance/model_roles.jsonl` said. A promotion changed
labels and nothing else. The V2 projections were only an opt-in shadow panel (`?cfbv2=1`).

**Now the champion prices the board.** It does so through the one engine call every CFB surface
shares, so the board, the slate, the record, the AI, articles and the newsletter all agree.

## How it works

| piece | what it does |
|---|---|
| `football/cfb_production/champion.js` | Runs in the hourly lab job and writes `reports/champion.json`, the champion's stored pregame numbers per game, read through the Model Lab's own adapters. **Empty while V1 is the champion.** |
| `lib/cfb_champion.js` | Holds the table. `entryFor(gameId)` returns a number only if it was computed before kickoff and is under 30 h old. `coverMargin` reads cover off the distribution the champion publishes (the model loop's key-number PMF). |
| `football/cfb_p4/engine.js` | When the request names a game the table covers, the champion's margin, width, win probability, total, interval and cover price it. V1 is computed exactly as before and kept in `model.champion.v1`. One last contribution row, *priced by ⟨model⟩ (its number less V1's)*, keeps the rows summing to the published margin. |
| `football/fbs/build_coverage.js` | Loads the table and names each priced request's game. Every row gets `priced_by` (null when V1 priced it) and a `v1` block with cfb_p4's own number. |
| `app.html` | Loads the library and the table in the CFB engine chain and names each request's game. Scenario and sensitivity runs ask for V1 (`no_champion`). Quote-level EV reads cover from the champion's own distribution. |

**Where V1 still applies.**
- **Per game:** every game the champion's table does not cover falls back to V1 and says so. That
  covers a game the table doesn't list, a stale number, a number computed after kickoff, and a
  missing or unreadable table. This is the manifest's FALLBACK_MODEL level.
- **Everywhere, if the versions disagree:** a loop champion prices only while the loop serves
  *exactly* the promoted version. If the loop has moved on, V1 prices everything until a person
  promotes the new version or rolls back.

**Readers that stay on V1** keep reading V1 whichever model prices the board:
- the Lab's V1 adapter and the production fallback read the `v1` block;
- the model loop's head-to-head reads `games[].v1` too (model_loop PR dsrackler17/EdgeDeskSports#644).

## Promoting a model

The Model Lab tracks every challenger live: V1 (champion), V2.1, candidate 001 and
`edgedesk_cfb_loop_v2.0.0` (experiment EXP-005). The promotion rule is `cfb_lab_promotion_v1` in
`football/cfb_lab/reports/<season>/promotion.json`. A challenger needs all of these on at least
150 common official games:
- the bootstrap CI of its MAE difference lies wholly below zero;
- Brier is no worse;
- calibration error (ECE) is within 0.01;
- 80% coverage is in the 75–85% band;
- the 95th-percentile miss is no worse;
- it wins at least 60% of weeks.

**Promotion is automatic** (the owner's instruction, 2026-10-21). Every lab hour,
`football/cfb_production/auto_promote.js` (rule `cfb_auto_promotion_v1`) reads the evaluation the
last run published and, when a challenger is **ELIGIBLE** against the current champion, promotes it
exactly as a person would, behind the same promotion guard (tests included). The job then opens a
GitHub issue saying what changed and how to undo it. Each run:
1. **Returns to V1** when the champion is a loop version the loop no longer serves. The board has
   already fallen back to V1 for every game by then, so governance says so too, and the new version
   is measured against V1.
2. **Registers** a loop version the Lab has never seen as challenger, with its experiment, so its
   live evidence counts from its first capture.
3. **Promotes** the eligible challenger with the largest MAE improvement. If the guard refuses it,
   the next one is tried. At most one promotion per run, and none in a run that returned to V1.
   V1 itself, eligible against a worse champion, comes back the same way (`--rollback`).

Nothing changes without the evidence. `football/cfb_production/reports/auto_promotion.json` records
what each run did and considered, and why. The switch is `auto_promotion.enabled` in
`football/cfb_lab/config.json`; its first reading and every change of it are RULE_CHANGED rows on the
audit log. A person can still promote by hand at any time:

```
node football/cfb_lab/governance.js promote --model <version> --reason "<why>" --actor <name> --evidence football/cfb_lab/reports/2026/promotion.json
```

The promotion guard (`football/cfb_production/promotion.js`) runs first. For a model loop version
(`edgedesk_cfb_loop_vX.Y.Z`), checks 3–5 are:
- the loop serves exactly this version;
- the champion table prices games from it;
- the config it serves is the one the Lab measured live.

These sit alongside the explicit version, registration, tests and ELIGIBLE checks.

The next hourly lab run writes the champion's table, and the next slate build and every board load
price from it.

**Rollback:** promote V1 back with `--rollback`, and the next lab run empties the table.

## Checks

- `football/cfb_production/champion.test.js` covers the table builder, the reader's freshness rules,
  the one-distribution cover and the loop guard.
- `football/cfb_p4/tests.js` ("the governance champion") covers:
  - V1 champion: unchanged;
  - a champion's number: margin, win probability and version;
  - rows summing exactly, with V1 kept beside them;
  - the champion's own cover and interval;
  - the counterfactual opt-out and every fallback.
- `football/cfb_lab/tests.js` covers the loop adapter and the shared distribution.
- `football/cfb_production/auto_promote.test.js` covers automatic promotion:
  - only on an ELIGIBLE evaluation against the current champion, behind the guard;
  - refused with no live capture, another config, failing tests or an unreadable loop;
  - the best first, one per run;
  - the return to V1 and registration of a new loop version;
  - V1 coming back by evidence, the dry run, and the switch.

Rebuilding the slate with V1 as champion gave identical numbers on 99 of 99 games. With a simulated
loop champion, 62 games were priced by it exactly, with V1 kept in `v1`, and 37 fell back to V1.
