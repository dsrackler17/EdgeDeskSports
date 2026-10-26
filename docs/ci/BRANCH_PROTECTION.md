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

65 workflows (60 of them scheduled) commit generated data straight to
`main`: the editorial system, the Model Lab, ratings, settlement and the app
version stamp. They authenticate with the workflow's `GITHUB_TOKEN`, as
`github-actions[bot]`, through `tools/ci/push_generated.sh`.

A rule that requires a pull request, or required status checks, applies to
those pushes too. Turn either on without a bypass and every data pipeline
stops at its next push. The bypass list below therefore contains the GitHub
Actions app and nothing else.

## The ruleset (Settings → Rules → Rulesets → New ruleset → New branch ruleset)

| Field | Value | Why |
|---|---|---|
| Ruleset name | `main: verified merges` | |
| Enforcement status | **Evaluate** for a day, then **Active** | Evaluate logs what it would block without blocking it, so a missed bot shows up before it breaks |
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
| · Status checks | `Repository integrity`, `Odds gateway suites`, `audit` (all from *GitHub Actions*) | see the next section |

Leave "Require deployments to succeed", "Require signed commits" and "Require
linear history" off. Each would block the data bots or change how this
repository merges, and nothing on 2026-10-26 needed them.

### Why these three checks, and why not more

A required check must report on **every** pull request. A workflow with a
`paths:` filter does not run on a pull request outside its paths. A required
check that never reports stays "Expected — waiting" forever and blocks the
merge. Today three checks run on every pull request:

| Check (job name) | Workflow | What it would have caught on 2026-10-26 |
|---|---|---|
| `Repository integrity` | `core-validation.yml` | `2ad15afadd`: the unparseable `lib/edgedesk_quote_ev.js` and the invalid `slate_audit.json`, in about 20 s, with file and line |
| `Odds gateway suites` | `odds-gateway-tests.yml` | the same breakage, through `football/props/factory/odds.test.js` (#800, #803) |
| `audit` | `cfb-security.yml` | secrets and least-privilege audit |

Check names are matched by job name. `Odds gateway suites` was renamed from
`suites` in this change because 32 workflows have a job called `suites`, and
a required `suites` would be satisfied by whichever one reported. Keep these
three names stable. Renaming a job silently un-requires its check.

The 63 path-filtered workflows still run, still report, and still block a
careful human. They are not *required* until each can report on every
pull request. The step that gets there, without running every suite on every
change, is to move each workflow's path filter into the job:

- a small first job (`node tools/ci/verify.js --list`-style, reading the
  workflow's own `paths:`) that outputs whether the change touches the
  workflow;
- the real job with `needs:` and `if:` on that output. A job skipped by
  `if:` reports as *skipped*, which satisfies a required check.

That is a change to each workflow. Make it one workflow at a time, starting
with `cfb-validation-tests.yml`, `cfb-terminal.yml` and `decision-quality.yml`,
and add each to the required list once it reports on a pull request that does
not touch it.

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
