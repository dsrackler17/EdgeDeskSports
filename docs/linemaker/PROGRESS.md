# Linemaker build — progress log and checklist

This is the build's resumable state, kept in the repository so an interrupted
session can pick it up. Branch: `claude/linemaker-research-terminal`. Base:
`0a93d07`. The audit is in `AUDIT.md`. The gap ids (G1–G9) are defined there.

## Checklist

- [x] Audit + baseline (`AUDIT.md` §1–2)
- [ ] G1 research_packets views: reproduce the cross-user read on PostgreSQL, fix additively, rollback, test
- [ ] G6/G8 calibration: slate-blind replays (NFL, CFB), walk-forward fit, method chosen per market, reports
- [ ] G6 `lib/edgedesk_fairline.js`: the sheet (spread, moneyline, total, team totals, alternates), price check, tests
- [ ] G8 `tools/football/build_fair_lines.js`: the artifact plus the append-only sheet ledger, with grading
- [ ] G7 Linemaker panel in app.html: states, mobile, e2e
- [ ] G2 model-call timeout
- [ ] G3 AI usage ledger (SQL) + Lite/Pro routing
- [ ] G4 screen context from the browser to the desk
- [ ] G5 saved research on the server
- [ ] AI: fair-line answers from the sheet (desk), with the critic's allowed numbers
- [ ] G9 no-bypass test extended
- [ ] CI workflow, docs, CHANGELOG, README
- [ ] Full regression run; final report

## Log

- 2026-10-11 — Audit done. The baseline is recorded in AUDIT.md §1: three
  pre-existing data-drift failures, all left untouched. Feasibility checks:
  - The slate-blind NFL replay gives 4,051 scored games for 2010–2026.
  - The CFB replay gives 11,794.
  - Walk-forward recalibration of the projection centre improves every NFL market.
  - A discrete team-score model beats the normal on totals and team totals for both leagues.
  - The method is chosen per market by held-out log loss. The CFB spread keeps its raw centre.
