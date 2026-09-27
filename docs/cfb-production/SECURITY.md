# CFB production security: secrets, privilege, public endpoints, admin actions, the AI boundary

This audit covers the CFB market, Model Lab, decision and explanation paths. Items marked
**recommendation** are not implemented, because they need project configuration outside this repository.

## 1. Secrets (audited 2026-09-27)

| secret | where it lives | exposure check |
|---|---|---|
| Supabase service role key | GitHub secret `SB_SERVICE_ROLE` (lab, decision sync), capture function env `SUPABASE_SERVICE_ROLE_KEY` | not in any page, script or committed file. The JWTs embedded in `app.html`, `record.html` and `index.html` decode to `"role":"anon"`, the public key by design |
| The Odds API key | capture function env `ODDS_API_KEY` | sent only in the provider URL. Error details carry the provider's response body (first 240 chars), never the URL; the run log carries quota headers only |
| GitHub token (workflow dispatch) | Supabase Vault `edgedesk_gh_token` | the only `ghp_` string in the repository is a 24-character `ghp_xxxx…` placeholder in a comment (`supabase/editorial_dispatch_sql.sql`) |
| CRON_SECRET | capture function env | capture refuses every caller without a matching `x-cron-secret` (401) |
| ANTHROPIC_API_KEY | edgedesk_ai env | server-side only |

**Logs.**
- The lab's `last_run.json` and provider incidents record status codes and classes (`HTTP 503`,
  `TIMEOUT`), never request URLs or headers.
- The shared logger (`football/cfb_production/log.js`) redacts credential-named keys, bearer tokens, JWTs
  and `?apikey=` query values.
- `providers.httpText` throws `HTTP <status>` without the URL.

**Recommendation.** Keep the repository's existing secret scan (`tools/supabase/download_functions.sh` scans
pulled functions) in CI for every PR.

## 2. Least privilege

**Database roles.**
- **anon** reads exactly two owner-run views: `cfb_lab_public_record` and `cfb_lab_public_summary`. It reads
  no `cfb_lab_*`, `cfb_market_*` or decision table, and executes no writer function. Tested in
  `football/cfb_lab/sql.test.js` and `integrity_sql.test.js`.
- **authenticated** reads the internal tables (research data that is also committed to the repository),
  writes none, and executes no writer function.
- **Writer functions** (`cfb_lab_ingest_quotes`, `cfb_lab_set_role`, `cfb_market_quarantine_quotes`,
  `cfb_market_ingest_quotes`, `cfb_market_admin_set_role`) are `security definer` with a pinned
  `search_path` and are executable by `service_role` only.
- **Append-only** tables refuse UPDATE, DELETE and TRUNCATE for every role, the owner included (triggers).
  The service role holds no UPDATE or DELETE grant on them.

**The prediction path needs no admin capability.**
- The lab job writes the repository ledger and mirrors it insert-only.
- The capture function inserts quotes through one RPC.
- Nothing in the prediction path can alter a model, a policy or a role.

**Recommendation.** Replace the service role in the lab mirror and in capture's CFB feed with a dedicated
Postgres role that has INSERT on `cfb_lab_*` / `cfb_market_*` and EXECUTE on the two ingest RPCs only. The
service role bypasses RLS project-wide, which is more than these jobs need.

## 3. Public endpoints and rate limits

| endpoint | who | cost | protection |
|---|---|---|---|
| static pages and `record/football/*.json`, `football/cfb_v2/current.json` | anyone | cached static files | CDN; precomputed, never recalculated per request on the server |
| `cfb_lab_public_record` / `_summary` views | anon | cheap, indexed reads | Supabase / PostgREST limits |
| `edgedesk_ai` (the LLM) | signed-in, entitled readers only (a Bearer JWT; 401 without one) | expensive | per caller: `EDGEDESK_AI_RATE_PER_MIN` (30) and `_PER_HOUR` (300), keyed by a hash of the Authorization header |
| `capture` | the scheduler only (`x-cron-secret`) | quota | 401 without the secret |
| model refreshes, weekly pipeline, Model Lab job | nobody public | expensive | GitHub workflows dispatched by pg_cron with the Vault token, or by a repository maintainer. No public endpoint can trigger a refresh |

**Note.** The `edgedesk_ai` rate book lives in isolate memory, so a burst spread across isolates can exceed
it. **Recommendation:** back it with a Postgres counter if abuse is seen.

## 4. Admin actions are validated

| action | validation |
|---|---|
| promote / retire a model (repository) | `football/cfb_lab/governance.js`: `--reason` and `--actor` are required; the model must be registered; the champion cannot be retired directly; the old champion's demotion and the new champion's promotion are audited in order |
| change a role in Postgres | **`cfb_market_admin_set_role(model, label, role, reason, actor, confirm)`** (new), which requires: the model version typed twice (`confirm` must equal it, so a typo or an accidental click changes nothing); a registered model (a new model enters only as a candidate, with a label); a reason of at least 10 characters; an actor; no direct retirement of the champion; no promotion straight from retired to champion. It then calls `cfb_lab_set_role`. Tested in `integrity_sql.test.js` |
| correct a derived opener or close | `market.correctLine`: needs a reason of at least 10 characters, an actor, an existing line and values within the market bounds. It writes an audited correction and never edits the line |
| manual wagers | `decision.manualDecision`: stored apart and never official (`assertOfficial`) |
| reruns | the lab job is idempotent: a rerun of the same hour writes nothing new (`chaos.test.js`) |

**Recommendation.** Revoke EXECUTE on the underlying `cfb_lab_set_role` from `service_role` so the guarded
wrapper is the only path. The wrapper is `security definer` and keeps working. This touches
`supabase/cfb_lab.sql`, owned by the Model Lab, so it is left to its owner.

## 5. The AI explanation boundary (brief §90-91)

`supabase/functions/edgedesk_ai/_cfb_explain.js`, tested in `football/cfb_lab/explain_guard.test.js`
(37 checks).

**The facts.** `cfbFacts(snapshot)` builds the only facts an explanation may use, from the stored canonical
prediction (a Model Lab snapshot row):
- teams, kickoff, model version;
- the fair line, the home margin, the win probability and the 80% interval;
- the market line and its actionable status;
- the OFFICIAL decision (status, side, line, price);
- each quarterback's status, CONFIRMED only when the source says so;
- data quality and degraded modes.

Parameter hashes, `inputs_ref` and raw rows never cross.

**The prompt.** `buildPrompt(facts)` passes no tools. It says:
- restate only these facts, and no number that is not in them;
- use the official status word;
- call a quarterback confirmed only when the facts say CONFIRMED;
- state the uncertainty;
- do not browse.

**The audit.** `auditExplanation(text, facts)` refuses:

| code | refused text |
|---|---|
| `BET_CLAIM_NOT_OFFICIAL` | BET or bet language on a non-BET |
| `STATUS_MISMATCH` | a status word that is not the official one |
| `QB_CONFIRMED_CLAIM` | "confirmed", "will start" etc. for a quarterback whose status is not CONFIRMED (judged clause by clause; "not confirmed" is the honest statement) |
| `NUMBER_NOT_IN_FACTS` | any number that is not in the facts |
| `SIDE_REVERSED` | the underdog named as the favourite, or with the favourite's line |
| `UNSUPPORTED_METRIC` | EPA, SP+, CLV, sharp or public money, injuries or weather when the facts do not carry them |
| `PROMISE_LANGUAGE` | promises of an outcome |
| `UNCERTAINTY_NOT_STATED` | a degraded prediction presented without its uncertainty |

**Explaining.** `explain(facts, llm)` replaces refused text with the deterministic `render(facts)`, which
passes its own audit in every tested case. The answer's status and side always come from the facts, never
from the model's text.

**Wiring (for the orchestrator).** `supabase/functions/edgedesk_ai/index.ts` is generated by
`tools/presentation/inline.js`. A CFB game explanation path must call `cfbFacts` → `buildPrompt` →
`explain`, and the module must be inlined by that tool. The existing `decision.js`
`auditLanguage` / `attachNarrative` stay as the decision engine's own narrower check.
