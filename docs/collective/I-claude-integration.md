# I. UNIVERSAL CLAUDE INTEGRATION SPECIFICATION

Purpose: how the Universal Creator Prompt is generated per creator, what is templated, where the template lives, how it is delivered on join screen 3 and re-delivered from the dashboard, how it stays in sync when the API changes, the nine instructions it gives Claude (build prompt Section 13), and the key-safety path for static sites. Binding references: CONTRACT.md section 7, API-SHAPES.md (`/v1/join/{token}/redeem`, `/v1/dashboard`), E-onboarding.md screen 3.

---

## 1. What the prompt is

One block of plain-language text a creator pastes as their first message to Claude inside their own project. It carries their identity, their credentials, the live endpoints, and a disciplined set of instructions, so that a creator who does not know what an API is ends up connected, dry-run first, key kept safe, site untouched except for one additive module and one tab. It is a template plus a generator, never a hand-written document (Section 13), so it cannot drift from the API actually deployed.

Constraints on the rendered text: plain language, under two pages, no jargon a non-engineer would trip on, no em dashes anywhere.

## 2. Where the template lives and the single-source rule

- **Canonical source: `supabase/functions/_shared/prompt_template.ts`.** A Deno module exporting the template as a string constant plus the `renderPrompt(vars)` function. This is what the `collective_join` and `collective_public` (dashboard) edge functions import and execute.
- **Human-readable mirror: `collective/claude-prompt-template.md`.** The same template text with placeholders visible, kept as the reviewable, diffable copy and linked from the docs. The file header of each states that the other exists and that `_shared/prompt_template.ts` is what ships; a build note requires any edit to land in both files in the same commit. A repo check (grep-level comparison in the test harness) fails if the bodies diverge.

## 3. Placeholders

The complete placeholder list, exactly as in CONTRACT.md section 7. Rendering is dumb string substitution, no logic in the template:

| Placeholder | Filled with | Source at render time |
|---|---|---|
| `{{CREATOR_NAME}}` | display name | `creators.display_name` |
| `{{MODEL_NAME}}` | model name | `models.name` |
| `{{SPORT}}` | sport code | `models.sport_code` |
| `{{API_BASE}}` | functions base URL | config constant |
| `{{API_KEY}}` | the full `mck_live_...` key | in-memory only at redeem or rotate, never re-read from the database (only the hash is stored) |
| `{{EMBED_SNIPPET}}` | the one-line script tag with their slug | built from `BASE_URL` and `creators.slug` |
| `{{DASHBOARD_URL}}` | dashboard link | `BASE_URL` constant |
| `{{DOCS_URL}}` | integration docs link | `BASE_URL` constant |

Because `{{API_KEY}}` exists only while the plaintext key is in memory, the fully keyed prompt can only be produced at exactly two moments: invite redemption and key rotation. Every other delivery renders the prompt with the key slot reading `your API key (shown once when it was created, rotate from the dashboard if you no longer have it)`.

## 4. Generation and delivery moments

1. **Redeem time, join screen 3.** `POST /v1/join/{token}/redeem` calls `renderPrompt` inside the same request that minted the key, and returns the complete text as the `prompt` field of the redeem response. Screen 3 renders it behind one `Copy the whole prompt` button (E-onboarding.md section 5). This is the primary delivery and the only zero-effort fully keyed one.
2. **Dashboard, re-downloadable forever.** The dashboard (`prompt_available: true` in `/v1/dashboard`) offers `Copy your Claude prompt` at any time. It renders from the same template with current identity fields and the keyless key-slot text above. If the creator rotates their key (`POST /v1/dashboard/keys/rotate`), the rotation response pairs the new key with a freshly keyed prompt, same single moment rule.
3. **Admin preview.** The founder console can render the template with sample values for review before sending invites. Never with a real key.

The prompt is creator-private: it is delivered only through authenticated responses (redeem JWT, dashboard JWT) and never appears in any public or embed payload (H-creator-profile.md section 4).

## 5. How it stays in sync when the API changes

The template lives next to the functions in the same repo and the same deploy. `_shared/prompt_template.ts` sits in `supabase/functions/_shared/` beside the ingest code it describes; an endpoint change and its prompt change ship in one commit and one `supabase functions deploy`. There is no separately hosted document to forget:

- Endpoint paths in the template are built from the same `{{API_BASE}}` constant and the same route strings the functions register. Renaming `/v1/projections` without updating the template is a same-file-tree change caught in review, and the harness's divergence check plus a template lint (the test suite asserts every endpoint named in the template exists in the deployed route table) makes it a failing test, not a drift.
- The envelope example embedded in the prompt is the same JSON shape validated by `collective_ingest` (CONTRACT 5.1). The CSV harness (`tools/collective/harness.py`) posts that exact shape to dry-run in CI, so a schema change that breaks the documented example breaks the build.
- Versioning: the API is `/v1/` from day one; a future `/v1/` breaking change is prohibited, and a `/v2/` gets a new template revision shipped in the same commit that adds the routes. The rendered prompt carries a one-line footer `Prompt version {date of deploy}` so support can tell which text a creator pasted.
- Because the join and dashboard functions render at request time, every creator always receives the current template. Nothing is cached per creator; there is no stale stored copy to invalidate.

## 6. The nine instructions the prompt gives Claude (Section 13, binding content outline)

The template body walks Claude through these, in this order, in plain language:

1. **Inspect first.** Look at the existing project and report what it is and how it is organized before changing anything. Assume nothing about framework: the text explicitly says it must work whether the project is static HTML, React, Next.js, Vue, Node, Python, Flask, Django, Supabase, Firebase, a GitHub Action, or a script run by hand.
2. **Locate the finished projections.** Find where final numbers are produced (a CSV, a function's output, a database table, a spreadsheet export) and confirm that location with the creator before proceeding.
3. **Map fields and show the mapping for approval.** Present a small table mapping the creator's fields to the Collective's fields (game, kickoff, home, away, and whichever of pick, spread, total, scores, probabilities already exist). Required fields are minimal; optional fields only if already produced; no new modeling work is ever created to fill a field.
4. **Never send proprietary logic.** Finished outputs only. Stated plainly in the prompt and confirmed with the creator before the first send.
5. **Additive module only.** Submission code goes in one new file plus one visible `Send to Model Collective` trigger (button, script command, or scheduled step, whatever fits the project). Do not restructure the site, do not touch model logic, do not alter any existing output.
6. **Keep the API key server side.** The key never ships to a browser. For a purely static site, use the documented GitHub Action path (section 7 below) or a local script run by hand. The prompt includes this fork explicitly so Claude picks the safe path without the creator knowing why.
7. **Add the Collective tab.** Use the included embed snippet, scoped to one route or tab, touching nothing else on the site.
8. **Dry run first.** Post to `{{API_BASE}}/collective_ingest/v1/projections/dry-run`, show the creator the exact JSON that would be sent and the per-row outcomes, and only after their approval switch to the live endpoint. The dry-run endpoint validates and resolves identically and writes nothing.
9. **Report back.** Finish with: files added and changed, how to submit going forward and how often (each slate before kickoff), what a failure response looks like and what to do (quarantined rows are fine and reviewed, `invalid_key` means rotate from the dashboard), and how to rotate the key.

The template also states the two integrity facts a creator must hear once: the first submission per game before kickoff is what gets graded, later sends show as movement; and submissions received after kickoff are stored but marked late and excluded from grading.

## 7. The static-site key-safety path: GitHub Action with a repo secret

For creators whose whole project is a static site (a GitHub Pages site, a public CSV in a repo), instruction 6 resolves to this documented pattern, included in the prompt in plain words and shipped as a copyable workflow in the docs:

- The creator (or Claude, via the creator) stores the key once as a GitHub repository secret named `COLLECTIVE_KEY`. Secrets are write-only in the GitHub UI, never visible in the repo, never in page source.
- A workflow file `.github/workflows/collective-submit.yml` runs on demand (`workflow_dispatch`) and optionally on a schedule or on push to the projections file. It checks out the repo, reads the finished projections file, builds the envelope, and posts it with the key from `secrets.COLLECTIVE_KEY` in the `x-collective-key` header. The harness script pattern (`tools/collective/harness.py`, stdlib only) is the reference implementation the workflow can call directly.
- First run uses the dry-run endpoint; the workflow flips to live by changing one URL after the creator approves the printed JSON.
- Result: the key exists only in GitHub's secret store and in the Action's runtime, the browser never sees it, and the creator's submit button is the `Run workflow` button. Rotation is: rotate in the dashboard, paste the new value into the same secret.

The prompt describes this in creator language (`your key lives in a locked box on GitHub that your site's visitors can never see`) and Claude executes the mechanics. For non-static projects the same principle applies with the platform's native secret store (environment variables on the server, never in client bundles), and the prompt says so in one sentence.
