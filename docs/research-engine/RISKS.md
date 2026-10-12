# Research engine — risks

Each row gives:
- what could go wrong;
- how likely it is and how much it would matter;
- what is already in place;
- what is still open.

"Open" means a decision or a piece of work that this branch does not do.

## Product and correctness

| # | Risk | Likelihood · impact | In place | Open |
|---|---|---|---|---|
| 1 | **Two answers to one question.** "What's the best NFL bet this weekend?" is answered by the existing football desk (model line against market line, LEAN tier). "…across all sports" is answered by the research engine (market no-vig fair, audit, challenge pass). They can disagree on the same prices. | medium · high | On every benchmark fixture they agree, including an all-rejected scenario where both say nothing qualifies. The desk's answer carries its confidence tier and price ladder. | **Owner decision:** route single-sport best-bet questions through the engine (it changes answers subscribers already get) or keep both. `REPORT.md` §5.1 |
| 2 | **AVAILABILITY picks the wrong player.** A name two clubs carry (the NFL has had two Josh Allens), or a nickname. | low · medium | Full-name match only. Namesakes go to the club the question names, else the listed starter, and the answer names the other club. A name on no list gets no status at all. Tested (`research_host.test.js`). | Nicknames and last names alone ("Is Allen playing?") are not matched; they fall through to the desk or model as before. |
| 3 | **The out-of-scope check intercepts a real question.** | low · medium | Narrow by design: never when an engine route other than a scan or slate answers; never for "across all sports"; "who will win" with a game named goes on to the desk. Switch: `EDGEDESK_OUT_OF_SCOPE=0`. | Watch the `UNSUPPORTED` share in the logs for the first week. |
| 4 | **Fixture fidelity.** The benchmark and host tests run on constructed fixtures. Production shapes, timings and gaps can differ. | medium · medium | The fixtures are built from the committed slates and metrics. The benchmark found and fixed one fidelity gap (the MLB card's date window, `REPORT.md` §2). | A smoke test on production after deploy (`DEPLOY.md` §3). |
| 5 | **Model reply quality is unmeasured.** Every model reply in the benchmark is recorded. | certain · medium | Routing and grounding (what evidence the model is handed) are measured. The desk's rewrite critic is tightened (`_desk.js`). Model-free routes now answer what the model was answering badly. | A live, approved evaluation of the model desk with a key. |
| 6 | **Wall-clock-dependent tests.** Suites that read `Date.now()` can fail on a different day. | low · low (CI only) | The host, benchmark and browser suites pin the clock to 2026-10-12 16:00 UTC. `quant_host` metrics are anchored to the test clock. | Older suites outside this branch were not audited for this. |
| 7 | **The MLB packet only covers yesterday, today and tomorrow** (`Dal.getMlbCard`). | certain · low | AVAILABILITY says when a game is not on the card rather than guessing. | Widen the card window if MLB questions about later games matter. |

## Providers and cost

| # | Risk | Likelihood · impact | In place | Open |
|---|---|---|---|---|
| 8 | **Claude web search rejects the request.** The allow-list is 70 domains (~1.2 K characters), and the documented size limit is not known to us. | low · medium | Paid search is off. A failed call settles at its estimate and the answer stands on the internal research (benchmark item `provider_failures-10`). | The live verification run (`providers_live.js`) before enabling. Trim the list per sport if it is rejected. |
| 9 | **The Perplexity schema is unverified.** The official docs were blocked by the build environment's proxy (HTTP 403). | — | The edge function refuses to call it until `EDGEDESK_PERPLEXITY_SCHEMA_VERIFIED=1`. The parser reads only `results[].title/url/snippet/date`. | Verify against the live API with a key, then set the flag. |
| 10 | **Search spend runs away.** | low · medium | Off by default. The database dollar budget is $0.25 a request, $1 a subscriber a day and $20 a day. It is claimed before every call and settled with the actual usage. The claim fails closed if the budget table is missing. Count quotas, a breaker after 3 failures, a cache, single flight, 2 search slots, at most 2 research runs per subscriber. Each search aborts at the provider's timeout, 5 s before the ledger's. | — |
| 11 | **Model desk cost.** The full model desk sends ≈ 20 K input tokens a question. | certain · medium | The daily allowance (LITE/PRO units) caps it per subscriber. Model-free routes now take player status, schedules, unsupported sports and guarantees away from it. | Trim the packet. Add a guard for off-topic questions ("capital of France" claims a PRO unit). `REPORT.md` §5.3–5.4 |
| 12 | **Odds data cost.** | — | Nothing here buys or re-enables capture. The recovery proposal is a document and a calculator. | The owner's call under the incident runbook (`ODDS_RECOVERY.md`). |
| 13 | **Licensing of a free feed.** The venue forecasts come from open-meteo. Its published terms limit the free API to non-commercial use, and EdgeDesk is a paid product. | medium · medium | Forecasts are context only. They never set a price. | Confirm the terms, then buy the commercial plan or replace the source. Read open-meteo's current terms before deciding; this note is from memory of them. |

## Security and data

| # | Risk | Likelihood · impact | In place | Open |
|---|---|---|---|---|
| 14 | **Prompt injection through search results.** | low · medium | External text is data only. Only a quoted `cited_text` from a returned, allow-listed URL becomes evidence. Injection patterns are screened and demoted to an unverified hypothesis. The model never supplies a probability or a price; the calculation ledger does. | Live adversarial testing once search is enabled. |
| 15 | **API keys in the browser.** | — | Keys exist only as function secrets and are sent in headers server-side. A test asserts the key is never in a request body. `lint.js` checks for secrets. | — |
| 16 | **Look-ahead in the grading record.** | low · high | `research_runs` refuses predictions written after the event started. Outcomes are written only by the service role after the start. Rows are write-once and never deleted inside retention. All tested against Postgres. | — |
| 17 | **`research_runs` grows without bound.** | certain · low | `research_engine_prune()` (service role; never below 180 days; outcomes kept). | Schedule it (pg_cron); it is not scheduled. |

## Process

| # | Risk | Likelihood · impact | In place | Open |
|---|---|---|---|---|
| 18 | **Merging deploys the function.** The Intelligence doctor auto-deploys `edgedesk_ai` when production differs from `main`. | certain · high if unplanned | `DEPLOY.md` §1–2: apply the migrations first, merge only when ready to deploy, verify with `?probe=1`. The build is `r23-research-engine`. | — |
| 19 | **Rollback is undone by the doctor.** | medium · medium | `DEPLOY.md` §5: roll back by reverting on `main`, not by redeploying an old build by hand. Switches turn the new routes off with no deploy. The documented SQL rollback is tested against Postgres. | — |
| 20 | **Another branch changes `edgedesk_ai` before this merges.** Both edit one ~54 K-line file. | medium · medium | Kernels are inlined between markers by `tools/presentation/inline.js`, which `lint.js` keeps in sync. | Merge `main` into the branch and re-run the full suite immediately before merging. |
