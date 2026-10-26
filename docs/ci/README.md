# CI: what runs, and how to run it before you open a pull request

The repository has 175 workflows. 66 of them run on pull requests: 63
path-filtered, and three on every pull request (`core-validation.yml`,
`odds-gateway-tests.yml`, `cfb-security.yml`). Each workflow names its own
commands. `npm run verify` reads those files and runs what GitHub would run,
so "run the tests" no longer means guessing which suites a change touches.

## Commands

| Command | What it runs | When |
|---|---|---|
| `npm run verify:core` | the integrity gate on every tracked file, plus its own tests (~1 min) | after any conflict resolution; before every push |
| `npm run verify:plan` | nothing. It prints the workflows this change starts and every step's fate | first, to see what you are in for |
| `npm run verify:affected` | every workflow a pull request with these changes starts (vs the merge base with `origin/main`, plus uncommitted and untracked files) | after each meaningful change |
| `npm run verify` | every workflow a pull request can start, except the live-source integration ones | before you open a pull request |
| `npm run verify:cfb` / `verify:odds` / `verify:research` | one group from `tools/ci/checks.json` | iterating inside one area (not a substitute for `verify`) |

Options for `node tools/ci/verify.js`:

- `--base <ref>`: the branch to diff against.
- `--workflow a.yml,b.yml`: run only the named workflows.
- `--include-live`: also run the live-source integration workflows.
- `--ci`: set `CI=true`, as a runner does.
- `--bail`: stop at the first failure.
- `--verbose`: stream each step's output.
- `--json <file>`: also write the results as JSON.
- `--keep-writes`: keep committed files a step rewrote (see below).
- `--root <dir>`: run against another checkout.
- `--clock-shift <days>`, `--tz <zone>` and `--net-audit`: determinism
  audits (see below).

Each step's output is saved under `.cache/verify/<run>/`, which is gitignored.

### What verify reports

Every step ends in one of these states:

- **PASS / FAIL**: it ran as its job runs it, with `bash -e` and the step's
  env, working directory and job timeout.
- **NOT VERIFIED here**: it could not run on this machine, and verify says
  why:
  - it needs a secret or a repository variable;
  - its `if:` depends on a step output;
  - its job's PostgreSQL service is not listening on `127.0.0.1:5432`;
  - it is a matrix job;
  - it needs Python packages its job installs that this machine lacks
    (verify names the `pip install` line);
  - it is a live-source workflow (without `--include-live`).

  These never count as passed. Report them as **not verified**.
- **skipped**: an install step (the machine provides Node, PostgreSQL and
  Chromium) or an `if:` that is false on a pull request.

A step that appears in several workflows runs once.

A suite should write only to a temporary directory. verify names every step
that leaves a committed file different from `HEAD`. At the end it restores
those files, unless you pass `--keep-writes`, so a test's side effect is
never committed by accident.

Exit codes:

- `0`: every step that ran passed.
- `1`: a step failed.
- `2`: verify could not run (for example, no `origin/main`; fetch it).

### What verify is not

It is not CI. It does not:

- run on GitHub's runner image (Node 22 there; verify warns when the major
  version differs here);
- hold the repository's secrets;
- move the browser's own clock;
- install anything.

A green `verify` means the checks that could run here passed. The pull
request's checks are still the record.

## Check categories (`tools/ci/checks.json`)

Every workflow a pull request can start belongs to exactly one category.
`tools/ci/workflows.test.js` fails when a new pull-request workflow has none.
Categories group checks for people; they rename nothing, so every check
keeps the name branch protection may require.

| Category | What it covers |
|---|---|
| Core validation | the repository parses; every path a workflow runs exists; cross-cutting integrity |
| Sports model validation | pregame models, calibration, freezes, validation records |
| Market and odds integrity | the odds gateway and its budget, quotes, EV, decisions, market layers, ledgers |
| Research and signals | research terminal, game research, Signal Center, intelligence, published research |
| Simulation | the simulator and the games built on it |
| Database and security | RLS on a real PostgreSQL, secrets and access audits |
| Frontend and navigation | the pages a reader sees, in a browser where it matters |
| Integration (live sources) | pull-request runs that probe ESPN, MLB Stats or a provider feed; kept apart from the deterministic suites and never replaced by mocks |

## Workflows added or changed by the 2026-10-26 repair

- **`core-validation.yml`** (`Core validation / Repository integrity`): runs
  on every pull request and every push to `main`, with no path filter. It is
  the first check to require.
- **`cfb-published-validation.yml`**: after each hourly CFB Model Lab run, it
  runs the CFB validation and research-terminal suites on `main`. A push by a
  workflow starts no other workflow, so without it an hourly board that
  contradicts its own rules stays unseen until the next unrelated pull
  request fails.
- **Concurrency**: 13 test workflows that had none now let a newer push to a
  pull request replace its older run. Runs on `main` (push, schedule,
  dispatch) each keep their own group, so none of them is cancelled.
- **Browser installs**: `continue-on-error` is gone from the six Playwright
  install steps. A browser suite without a browser prints SKIPPED and exits
  0, so a failed install used to leave its job green having tested nothing.
- **`odds-gateway-tests.yml`**: its job is named `Odds gateway suites`, so a
  required check can name it unambiguously (32 jobs are called `suites`).

## Determinism audits

`--clock-shift <days>` runs every node process a step starts with
`Date.now()` and `new Date()` moved (`tools/ci/clock_shift.js`, through
`NODE_OPTIONS`). A suite that passes today and fails 14 days from now is
reading the wall clock against committed data. It will fail on a future day
with no change to the code. #798, #794 and #793 each fixed one of these by
hand.

`--tz <zone>` does the same for the timezone.

`--net-audit` loads `tools/ci/net_audit.js` into every node process and names
each step that opened a connection to a host that is not loopback. It blocks
nothing, so the results are the same as without it. A test file need not
name a URL to reach the network; `nfl_slate.test.js` did so through the
builder it calls.

The results of the 2026-10-26 audits are in
[INCIDENT-2026-10-26.md](INCIDENT-2026-10-26.md).

## Notifications

See [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md#notifications). The short
version: protecting `main` removes most of the failure email at its source.
Tune the rest in your own GitHub notification settings, and never by turning
a check off.
