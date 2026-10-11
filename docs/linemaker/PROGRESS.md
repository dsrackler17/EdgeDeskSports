# Linemaker build — progress log and checklist

This is the build's resumable state, kept in the repository so an interrupted
session can pick it up. Branch: `claude/linemaker-research-terminal`. Base:
`0a93d07`. The audit is in `AUDIT.md`. The gap ids (G1–G9) are defined there.

## Checklist

- [x] Audit + baseline (`AUDIT.md` §1–2)
- [x] G1 research_packets views: reproduce the cross-user read on PostgreSQL, fix additively, rollback, test
- [x] G6/G8 calibration: slate-blind replays (NFL, CFB), walk-forward fit, method chosen per market, reports
- [x] G6 `lib/edgedesk_fairline.js`: the sheet (spread, moneyline, total, team totals, alternates), price check, tests
- [x] G8 `tools/football/build_fair_lines.js`: the artifact plus the append-only sheet ledger, with grading
- [x] G7 Linemaker panel in app.html: states, mobile, e2e
- [x] G2 model-call timeout
- [x] G3 AI usage ledger (SQL) + Lite/Pro routing
- [x] G4 screen context from the browser to the desk
- [x] G5 saved research on the server
- [x] AI: fair-line answers from the sheet (desk): team totals and alternate lines, deterministic, every number from the sheet
- [x] G9 no-bypass test extended
- [x] CI workflow, docs, CHANGELOG, README
- [x] Full regression run; final report

## Log

- 2026-10-11 — Audit done. The baseline is recorded in AUDIT.md §1: three
  pre-existing data-drift failures, all left untouched. Feasibility checks:
  - The slate-blind NFL replay gives 4,051 scored games for 2010–2026.
  - The CFB replay gives 11,794.
  - Walk-forward recalibration of the projection centre improves every NFL market.
  - A discrete team-score model beats the normal on totals and team totals for both leagues.
  - The method is chosen per market by held-out log loss. The CFB spread keeps its raw centre.
- 2026-10-11 — G1 fixed and tested on PostgreSQL (`research_packets_rls_sql.test.js`,
  28 pass): with the old definition reader A reads B's packets through both
  views and anon reads 2 rows; after `research_packets_views_rls.sql` neither
  can. Commit `c621b3f5`. The sweep of every other view found no other
  owner-rights view over per-user rows (AUDIT.md §3).
- 2026-10-11 — Calibration and sheets (`94217eb7`). Week-batched cold replays,
  method chosen per market on 2016–20 (NFL) / 2014–19 (CFB), confirmed on
  2021–25 / 2020–25. CALIBRATED: NFL spread, CFB total. Everything else is
  PROVISIONAL with its reasons. At-market held-out slopes are far below 1
  (0.17, 0.30, −0.08, 0.21), so the price check never says VALUE without an
  at-market band and a positive conservative edge.
- 2026-10-11 — The Lines panel (`a3ed0c5b`): desktop and 390 px phone, loading,
  empty, error, stale and per-market status states, Ask about this, Save this
  sheet. 84 e2e checks.
- 2026-10-11 — The desk (`c5c47aa9`, `0501b58f`, `af9ee323`): a model clock (45 s
  per call, 100 s per turn), a shared daily allowance with Lite/Pro routing
  (atomic per reader; 12 concurrent claims at a limit of 5 give exactly 5), the
  on-screen game passed as allow-listed context, saved research on the
  account (own rows only, frozen at save), and deterministic team-total and
  alternate-line answers from the sheet. No AI path can start an odds refresh
  beyond what was already scoped; the linemaker spends nothing (no-bypass §8–9).
- 2026-10-11 — CI on PR #547: the new Linemaker tests job and the Intelligence
  lint/migrations/artifacts/browser jobs are green. Five suites jobs are red
  on `main` itself (data drift from the hourly bot commits). They are
  explained on the PR and not repaired here.
- 2026-10-11 — Final regression on the branch head. Results in REPORT.md §3.
  Every failure reproduces on the base or on `main` with the same assertions.
