# Protecting `main`

## Where it stands (2026-10-30)

```
GET /repos/dsrackler17/EdgeDeskSports/rules/branches/main
  deletion, non_fast_forward      (ruleset 25958884)
GET /repos/dsrackler17/EdgeDeskSports/branches/main
  "required_status_checks": { "enforcement_level": "off", "contexts": [] }
```

`main` cannot be deleted or force-pushed, but nothing stops a pull request
from merging while its checks are red or still running. On 2026-10-26 that
happened four times in 45 minutes
([INCIDENT-2026-10-26.md](INCIDENT-2026-10-26.md)). On 2026-10-30 #926, #928
and #930 merged within 11 seconds of their checks starting, and `main` went
red on NFL model suites, Game research tests and Collective suites.

The fix is one rule: **Require status checks to pass: `All checks`**. This
page says why the data jobs must carry a certificate before it can be turned
on, and how to turn it on.

Changing repository settings needs the owner's account and the owner's
decision. Agents must not change them.

## The constraint: the data jobs push straight to `main`

Sixty-five workflows commit generated data straight to `main` with the
workflow's `GITHUB_TOKEN`, as `github-actions[bot]`: most through
`tools/ci/push_generated.sh`, a dozen with their own `git push`. A required
status check binds those pushes too. Turned on as it is, it stops every data
pipeline at its next push.

No bypass this account offers lets them through:

| Bypass tried | Result | Evidence |
|---|---|---|
| The GitHub Actions app (id 15368) | GitHub refused the ruleset: "invalid actor" | import of the old `main-ruleset.json`, 2026-10-27. The bypass menu offers only Deploy keys, the Repository admin, Maintain and Write roles, and the installed apps (Claude, ChatGPT Codex Connector, Supabase) |
| Write role | a `GITHUB_TOKEN` push was **refused**: `GH013: Required status check "All checks" is expected` | TEMP bypass probe, run 41092698463 attempt 2, on a scratch branch whose ruleset requires `All checks` with Write as its bypass |
| None (control) | refused, the same way | the same run |

A Repository admin bypass would let the owner's account, and so every coding
agent, through. A Deploy keys bypass works only if the data jobs push with a
deploy key, and a deploy-key push starts workflows, so every data commit
would start CI on `main`.

## The data jobs' certificate

What the rule does accept is a commit whose `All checks` has passed. TEMP
bypass probe, run 41094226276, against the control branch (required
`All checks`, **no bypass**):

| Push with `GITHUB_TOKEN` | Result |
|---|---|
| plain, as the data jobs pushed before | REFUSED (GH013) |
| commit first on a side branch, then an `All checks` check run (success) on it, then the push | **ACCEPTED** |
| the same with a commit status instead of a check run | **ACCEPTED** |

So every push to `main` from a data job goes through
`tools/ci/certified_push.sh`:

1. the commit goes to a side branch, `ci-certify/<run>-<attempt>-<sha>`, so
   GitHub has it;
2. the job's own token posts an `All checks` check run on that commit:
   completed, success, titled "Data publish, not the pull-request gate", and
   naming the workflow and run;
3. the real push;
4. the side branch is deleted.

`push_generated.sh` certifies every attempt, so the commit that lands is the
one certified. A `GITHUB_TOKEN` push starts no workflow, so neither push runs
anything. Only a push to `main` from GitHub Actions is certified; any other
branch, and the suites' local repositories, get a plain `git push`. If the
certificate cannot be made, the push still happens with a warning. While the
rule is off nothing changes. Once it is on, GitHub refuses the push (GH013) and
the job goes red: a loud failure, never a silent one.

Every job that pushes to `main` has `checks: write` for this. The one
workflow that pushes only into pull-request branches,
`nfl-coaching-staff-validation.yml`, does not need it.

**What the certificate is, and is not.** It lets data commits, which no
pull-request check ever ran on, through a rule meant for pull requests: the
same thing a bypass would do. It does not make a data commit checked. Any
workflow with `checks: write` could post an `All checks` success on any
commit, including a pull request's head. The rule stops merging a red or
unfinished pull request by accident. It does not stop someone who sets out to
fake the check. Tests: `tools/ci/certified_push.test.js`.

## Applying it

**1. Merge the pull request that adds the certificate**
(`tools/ci/certified_push.sh`), and wait for one data push to land with it.
On the next `editorial:` commit on `main`, the checks list shows **All
checks — Data publish, not the pull-request gate**. Until that shows, do not
go on.

**2. Turn the rule on.** Settings → Rules → Rulesets → the existing ruleset on
`main` (25958884):

- tick **Require status checks to pass**;
- **Add checks** → `All checks`;
- leave **Require branches to be up to date before merging** off;
- leave the bypass list **empty**;
- Save changes.

[`main-ruleset.json`](main-ruleset.json) holds the same ruleset, for an import
or `gh api --method POST repos/dsrackler17/EdgeDeskSports/rulesets --input
docs/ci/main-ruleset.json` from the owner's machine.

**3. Verify, within the hour:**

- The next scheduled data push still lands. The Editorial system commits
  every few minutes: its run is green and its commit is on `main`. If a data
  job fails with `GH013`, set the ruleset's new rule off again and read that
  job's log for the `certified_push` warning.
- A pull request's merge button waits for `All checks`.
- `GET /repos/dsrackler17/EdgeDeskSports/rules/branches/main` lists
  `required_status_checks`.

**4. Delete the TEMP probe rulesets** (`TEMP probe control`,
`TEMP probe write`) and the branches `claude/bypass-probe-runner`,
`claude/bypass-probe-control/target`, `claude/bypass-probe-write/target`,
`claude/bypass-probe-deploykey/target` and `claude/bypass-probe/target`.

**A bot commit into a pull request branch reports no checks.** Two jobs push
generated files into the pull request that triggered them:
`simulator-sports-data.yml` and `nfl-coaching-staff-validation.yml`. A
`GITHUB_TOKEN` push starts no workflow, so that pull request's new head never
reports `All checks` and waits as "Expected". Press **Update branch**: the
merge commit is yours, so every workflow the pull request starts, `All checks`
among them, runs on the new head.

On this account a ruleset is Active or Disabled (Evaluate mode is GitHub
Enterprise only), which is why step 3 is a checklist rather than a trial.

## The rule

| Field | Value | Why |
|---|---|---|
| Target branches | the default branch | |
| Bypass list | **empty** | no bypass lets the data jobs through (above), and an admin bypass would be an agent bypass |
| Restrict deletions | on | already on |
| Block force pushes | on | already on |
| Require status checks to pass | on | |
| · Status checks | `All checks` (from *GitHub Actions*) | it waits for every workflow the pull request started (below) |
| · Require branches to be up to date before merging | **off** | see below |
| Require a pull request before merging | **off** | it binds direct pushes too, and a certificate cannot satisfy it: every data job would stop |

Leave "Require deployments to succeed", "Require signed commits" and "Require
linear history" off. Each would block the data jobs or change how this
repository merges.

### Why only `All checks`

A required check must report on **every** pull request, or it stays
"Expected — waiting" and blocks the merge. `All checks` does, and it waits for
every workflow the pull request started. That includes the three that run on
every pull request: `Repository integrity` (`core-validation.yml`),
`Odds gateway suites` (`odds-gateway-tests.yml`) and `audit`
(`cfb-security.yml`). Requiring those three as well would add nothing for
pull requests. It would also make each data commit need four certificates
instead of one.

Check names are matched by job name. Keep `All checks` stable: renaming the
job silently un-requires it. `tools/ci/gate.test.js` fails if a check the
ruleset requires is not exactly one job, or if that job does not report on
every pull request.

### All checks: one required check for the 64 path-filtered workflows

`Repository integrity`, `Odds gateway suites` and `audit` alone would not
have stopped #807. It merged 17 s after it
was opened. Its three required checks passed within three minutes, and eight
of the 40 workflows it started failed after that: Collective, Funnel, Market
Foresight, Player props, Signal Center, Simulator, Today's Games and the
matchup graphic. None of the eight could be required, because each is
path-filtered.

`All checks` (`tools/ci/gate.js`) stands for all of them. On every pull
request it:

1. reads the changed files from the API, which is GitHub's own list;
2. predicts the workflows that change starts, from each workflow's own `on:`
   block (`tools/ci/workflows.js`, the reader `npm run verify` uses; its
   prediction matched GitHub's runs on #799, #800, #803, #804, #806 and #807);
3. waits for each run on the head commit;
4. passes only when every one passed (success, skipped or neutral).

It fails:

- at the first failed, cancelled or timed-out run;
- when a predicted workflow never starts within 10 minutes. The reader and
  GitHub then disagree, so fix the reader, never the check.
- when the wait passes 85 minutes.

A run nobody predicted still counts. A workflow disabled in the settings is
named, not waited on. GitHub reads `paths:` filters on a pull request's first
300 changed files only; past that, a missing run is named as such.

It only reads (`actions`, `contents` and `pull-requests`, all read). It never
re-runs, cancels or writes anything. **After you re-run a failed workflow,
re-run `All checks` too.** It decided on the run as it was.

Replayed read-only on real history with `node tools/ci/gate.js --repo
dsrackler17/EdgeDeskSports --pr <n> --once --root <a checkout of the PR's
merge commit>`:

- **#807: ALL CHECKS FAILED**, 32 of 40 passed. It names the eight failed runs.
- **#806: ALL CHECKS PASSED**, 8 of 8.

### Why "require branches to be up to date" stays off

The data bots commit to `main` every few minutes. Under the strict setting,
every pull request would need "Update branch" after every bot commit, and
would re-run its checks each time. It could rarely merge. It is also not
needed for the failure that happened:

- A pull request's checks run on `refs/pull/<n>/merge`: its head merged into
  `main` as of the run.
- The commit that broke `main` was the pull request's own head
  (`2ad15afadd`, an "Update branch" merge).
- With required checks on, the merge button waits for that commit's checks.

## Deployment from unverified branches

Three workflows act on production from a push to an agent branch, gated only
by text in the commit message:

| Workflow | Trigger | What a branch push can do |
|---|---|---|
| `deploy-affiliates.yml` | push to `claude/**` with `[affiliates:apply]` | apply `supabase/referral_codes.sql`, `affiliates.sql`, `affiliate_connor.sql` to the production database |
| `deploy-collective-public.yml` | push to `claude/**` with `[collective-public:deploy]` | deploy the public Collective function |
| `db-doctor.yml` | push to `claude/db-doctor-**` with `[db-doctor:cancel-stuck]` / `[db-doctor:restart]` | cancel or restart production database work |

This is the repository's deliberate "prove it against production before it
reaches main" pattern, and changing it is the owner's call. The
recommendation keeps the pattern and adds a person to it:

1. Settings → Environments → **New environment** `production` → **Required
   reviewers**: the owner. Optionally set *Deployment branches* to `main` and
   `claude/**`.
2. In each of the three workflows, add `environment: production` to the job
   that applies, deploys or restarts.

A branch push can then still *request* the action, but it waits in the
Actions tab until the owner approves it. The workflow change is safe to make
before step 1: a job naming an environment that does not exist yet runs as
before.

## Notifications

GitHub sends an email per failed workflow run. On 2026-10-26 one broken file
produced sixteen failed runs in 75 minutes, about one email per suite that
loads the file. The settings above remove most of those at the source: a red
pull request cannot merge, so `main` and the next pull request stop failing
for it. To tune what remains, use **your own** notification settings, never
the repository's. Agents never change account settings.

- github.com → Settings → **Notifications** → *System* → **Actions**:
  "Notify me for failed workflows only" (and, if you want, "only for
  workflows I triggered").
- To move the mail out of the inbox without losing it: in Gmail, filter
  `from:(notifications@github.com) subject:("Run failed")` with *Skip the
  Inbox* and a label. Read the label, or the Actions tab, once per merge.
- Do not unwatch the repository, and do not turn Actions notifications off.
  A failure on `main`, or in `CFB published-board validation`, is one you
  want.
