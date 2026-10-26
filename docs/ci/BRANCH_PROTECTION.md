# Protecting `main`

## Where it stands (read 2026-10-26 from the public API)

```
GET /repos/dsrackler17/EdgeDeskSports/branches/main
  "protected": false
  "protection": { "enabled": false, "required_status_checks": { "enforcement_level": "off", "contexts": [] } }
GET /repos/dsrackler17/EdgeDeskSports/rules/branches/main
  []            (no ruleset applies)
```

Nothing stops a pull request from merging while its checks are red or still
running. On 2026-10-26 that happened four times in 45 minutes
([INCIDENT-2026-10-26.md](INCIDENT-2026-10-26.md)). This page gives the
settings that would have stopped every one of them.

Nothing on this page has been applied. Changing repository settings needs the
owner's account and the owner's decision. Agents must not change them.

## The constraint that shapes everything: the data bots push to `main`

64 workflows (60 of them scheduled) commit generated data straight to
`main`: the editorial system, the Model Lab, ratings, settlement and the app
version stamp. They authenticate with the workflow's `GITHUB_TOKEN`, as
`github-actions[bot]`, through `tools/ci/push_generated.sh`.

A rule that requires a pull request, or required status checks, applies to
those pushes too. Turn either on without a bypass and every data pipeline
stops at its next push: `push_generated.sh` retries, fails, and turns every
scheduled job red. No workflow pushes with a personal token or a deploy key
(checked 2026-10-26), so one bypass, for the GitHub Actions app, covers all
64. The bypass list below therefore contains that app and nothing else.

## Applying it

**1. Merge the pull request that adds `All checks` first.** The four
required checks exist only once their workflows are on `main`. `All checks`
(`all-checks.yml`) is the last of them. Applied before that, every other pull
request would wait on it forever. `Repository integrity` and `Odds gateway
suites` arrived with #805, and `audit` was already there.

**1a. Prove the bypass on scratch branches first.** GitHub's docs list
"GitHub Apps" among eligible bypass actors. They do not say whether the
built-in GitHub Actions app, and with it the data jobs' `GITHUB_TOKEN`
pushes, is honoured in a personal account's repository. Step 3 only shows
that the page accepted the actor.

1. Import this same file twice, each time targeting a scratch branch
   pattern. The second copy, the control, gets an empty bypass list.
2. From a workflow, push one commit to each scratch branch with the default
   `GITHUB_TOKEN`. The control must be refused, which proves the rules bind
   those pushes; the other copy must be accepted.
3. Delete both copies.

Status, 2026-10-26: prepared and **not yet run**, because the agents' token
may not write rulesets. Do not activate step 2 on `main` until the probe has
passed.

**2. Import the ruleset.** [`main-ruleset.json`](main-ruleset.json) holds
exactly the table below.

- In the browser: Settings → Rules → Rulesets → **New ruleset → Import a
  ruleset**, then choose the file.
- From your own machine, with `gh` logged in as the owner:

```
gh api --method POST repos/dsrackler17/EdgeDeskSports/rulesets --input docs/ci/main-ruleset.json
```

**3. Before you leave the page, check the bypass list shows "GitHub Actions"**
(app id 15368).

If GitHub does not accept that bypass actor on this account, set the ruleset
to **Disabled** and stop: active without it, it would block the data bots. The
fallback is a deploy key that `push_generated.sh` pushes with, added to the
bypass list as *Deploy keys*. That is a change to the publishing workflows.

**4. Verify, within the hour:**

- The next scheduled data push still lands. The Editorial system commits
  every few minutes: its run is green and its commit is on `main`.
- A pull request's merge button waits for `Repository integrity` and
  `All checks`.
- `GET /repos/dsrackler17/EdgeDeskSports/rules/branches/main` lists the
  ruleset.

**A bot commit into a pull request branch reports no checks.** Two jobs push
generated files into the pull request that triggered them:
`simulator-sports-data.yml` and `nfl-coaching-staff-validation.yml`. A
`GITHUB_TOKEN` push starts no workflow, so with this ruleset the pull
request's new head never reports the three required checks. It waits as
"Expected" until someone pushes again.

To unblock one, run *Core validation*, *Odds gateway tests* and *CFB security*
on the pull request's branch (Actions → the workflow → Run workflow). All
three have `workflow_dispatch`. Confirm on the first occurrence that the
dispatched runs satisfy the merge box. Having those two jobs dispatch the
three themselves needs `actions: write` on them; that is a separate decision.

Once `All checks` is required, dispatching those three is not enough. The
bot's head has no pull-request runs for `All checks` to wait on. Press
**Update branch** instead. The data jobs keep `main` moving, so it is almost
always offered. The merge commit is yours, so every workflow the pull
request starts, `All checks` among them, runs on the new head.

Evaluate mode (log, do not block) is offered only on GitHub Enterprise. On
this account a ruleset is Active or Disabled, which is why step 4 is a
checklist rather than a trial period.

## The ruleset (Settings → Rules → Rulesets → New ruleset → New branch ruleset)

| Field | Value | Why |
|---|---|---|
| Ruleset name | `main: verified merges` | |
| Enforcement status | **Active** (once `All checks` is on `main`) | this account has no Evaluate mode (Enterprise only); step 4 above is the check that the bots still push |
| Bypass list | **GitHub Actions** (the app), mode *Always* | the data bots above. Do **not** add *Repository admin*: coding agents act through the owner's account, so an admin bypass is an agent bypass |
| Target branches | *Include default branch* | |
| Restrict deletions | on | |
| Block force pushes | on | |
| Require a pull request before merging | on | |
| · Required approvals | **0** (see below) | |
| · Dismiss stale approvals when new commits are pushed | on | |
| · Require conversation resolution before merging | on | |
| · Allowed merge methods | Merge, Squash | |
| Require status checks to pass | on | |
| · Require branches to be up to date before merging | **off** (see below) | |
| · Status checks | `Repository integrity`, `Odds gateway suites`, `audit`, `All checks` (all from *GitHub Actions*) | see the next section |

Leave "Require deployments to succeed", "Require signed commits" and "Require
linear history" off. Each would block the data bots or change how this
repository merges, and nothing on 2026-10-26 needed them.

### Why these four checks

A required check must report on **every** pull request. A workflow with a
`paths:` filter does not run on a pull request outside its paths. A required
check that never reports stays "Expected — waiting" forever and blocks the
merge. These four run on every pull request:

| Check (job name) | Workflow | What it catches |
|---|---|---|
| `Repository integrity` | `core-validation.yml` | `2ad15afadd`: the unparseable `lib/edgedesk_quote_ev.js` and the invalid `slate_audit.json`, in about 20 s, with file and line |
| `Odds gateway suites` | `odds-gateway-tests.yml` | the same breakage, through `football/props/factory/odds.test.js` (#800, #803) |
| `audit` | `cfb-security.yml` | secrets and least-privilege audit |
| `All checks` | `all-checks.yml` | every other workflow the pull request started: #807's eight failed workflows (below) |

Check names are matched by job name. `Odds gateway suites` was renamed from
`suites` because 32 workflows have a job called `suites`, and a required
`suites` would be satisfied by whichever one reported. Keep these four names
stable. Renaming a job silently un-requires its check.
`tools/ci/gate.test.js` fails if a check the ruleset requires is not exactly
one job, or if that job does not report on every pull request.

### All checks: one required check for the 64 path-filtered workflows

The first three checks would not have stopped #807. It merged 17 s after it
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

### Why required approvals is 0

Claude Code opens its pull requests through the owner's account, so GitHub
counts the owner as their author, and GitHub never lets an author approve
their own pull request. One required approval would therefore block every
merge in this repository. Review still happens: the owner reads the pull
request and presses merge, and `AGENTS.md` §7 forbids agents from merging. To
make approval *enforced*, agents must open pull requests under a separate
identity (a GitHub App or a machine user). The owner's approval then counts,
and Required approvals can be 1.

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
