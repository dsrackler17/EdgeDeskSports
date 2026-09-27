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

**The secret audit** (`tools/cfb/secret_audit.js`, run on every PR by `.github/workflows/cfb-security.yml`).
It scans every tracked file, the pages a browser downloads (`app.html`, `index.html`, `record.html`,
`brief.html`, every admin page), the job logs the repository keeps (`last_run.json`, `ops.json`,
`projections.json`, the weekly run records, `record/`) and the workflows. It looks for private keys,
non-anon JWTs, GitHub / Stripe / Anthropic / OpenAI / Slack / AWS tokens, database URLs with a password,
keys in URLs and credential-named assignments; in workflows, a secret on a `run:` line or echoed. A finding
shows the file, the line, the kind and a masked fingerprint (`sha256:<10 hex> (<n> chars)`), never the value.

Result on 2026-09-27 (2730 files: 20 page files, 15 log files; 47 workflows): **no secret.**
- 9 test fixtures: fake values in test files (`capture_feed.test.js`, `sql.test.js`, `capture.test.js`,
  two collective tests, `issue_reports.test.sql`, the stub key in `tools/intelligence/conversation.js`).
- 2 informational: `deploy-intelligence.yml` lines 145 and 170 put `secrets.SUPABASE_PROJECT_REF` on a
  `run:` line. A project ref is an identifier, not a credential, and GitHub masks it in the log; moving it
  to `env:` would be tidier.

`football/cfb_production/security.test.js` proves every rule fires (fake values built at run time in a temp
dir, so the test holds none), that no finding carries a value, and that the real tree is clean.

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

**Enforced by `football/cfb_production/security.test.js`** (every PR, `cfb-security.yml`):
- every `security definer` function in `supabase/cfb_*.sql` is revoked from public and anon, with one
  documented exception;
- anon is granted only SELECT on the two settled-record views and EXECUTE on that exception,
  `cfb_terminal_track` (`supabase/cfb_terminal_analytics.sql`, the research terminal's product analytics).
  It is guarded: a fixed event list, clipped text, no identity, 120 events per visitor-hour, and an
  insert into a table no model reads (`football/cfb_terminal/tests.js` enforces the last). It is a public
  write, not a refresh: it cannot start a computation;
- authenticated may execute only the read-only `cfb_health` and the terminal's roll-ups, which answer
  only for growth admins (`growth_is_admin()` inside the function);
- every CFB table has row level security.

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

Enforced by `security.test.js`: `cfb_weekly_poke`, `cfb_lab_poke` and `cfb_lab_cron_status` are revoked
from public, anon and authenticated; no edge function names a CFB workflow or calls a CFB dispatcher; no
page calls a `cfb_` RPC or dispatches a CFB workflow; capture refuses every caller without `CRON_SECRET`
(and everyone when it is unset); the newsletter dispatch checks the caller is an operator first and never
treats the anon key as one.

**Finding outside CFB (not fixed; owner decision).** `editorial_cron` and `newsletter_cron` check no
caller of their own: any request that passes the Supabase gateway (the public anon key is enough, unless
the functions are deployed with JWT verification plus a secret) can ask them to dispatch `editorial.yml` /
`newsletter.yml`. Both honour their kill switches and a debounce (300 s / 600 s), so the worst case is an
extra scheduled run, not a CFB refresh. **Recommendation:** require an `x-cron-secret` header as capture
does, and have the pg_cron jobs send it. Changing the functions without the matching cron change would stop
the schedulers, so it is left to the owner.

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

`supabase/functions/edgedesk_ai/_cfb_explain.js` (`cfb_explanation_boundary_v2`), tested in
`football/cfb_lab/explain_guard.test.js` (44 checks).

**The facts.** `cfbFacts(src)` builds the only facts an explanation may use, from a stored canonical
prediction: an entry of `football/cfb_production/reports/projections.json`, a Model Lab snapshot row, or
`{ pure, decision }`:
- teams, kickoff, model version;
- the fair line, the home margin, the win probability and the 80% interval;
- the market line and its actionable status;
- the OFFICIAL decision (status, side, line, price), taken only from the governed policy
  (`cfb_decision_engine_v1` / `cfb_decision_policy_v1`, F-22). A status from any other source (the stage-8
  engine's research class) is stated as NO BET, never as a status;
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
| `UNSUPPORTED_METRIC` | EPA, SP+, CLV, sharp or public money, injuries or weather when the facts do not carry them; "edge quality" / "edge tier" language for the P(positive CLV) tier (F-23: it is a closing-line tendency, not edge quality) |
| `PROMISE_LANGUAGE` | promises of an outcome |
| `UNCERTAINTY_NOT_STATED` | a degraded prediction presented without its uncertainty |

**Explaining.** `explain(facts, llm)` replaces refused text with the deterministic `render(facts)`, which
passes its own audit in every tested case. The answer's status and side always come from the facts, never
from the model's text.

**Wiring.** `tools/presentation/inline.js` inlines the module into `supabase/functions/edgedesk_ai/index.ts`
(PART 1g3, between the `__EDCFBEXPLAIN_START__` / `_END__` markers; `const EDCFBEXPLAIN`). The source is
updated here; the function is not deployed (a deploy is the owner's). The chat's CFB answers still explain
the champion (V1, `football/cfb_p4`); a V2 game explanation path must call `cfbFacts` → `buildPrompt` →
`explain`. The existing `decision.js` `auditLanguage` / `attachNarrative` stay as the decision engine's own
narrower check.
