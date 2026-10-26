# TEMPORARY: GitHub Actions bypass probe (2026-10-26)

This branch is never merged. It holds no repository code. Delete it, and the two scratch target branches, when the probe is done.

**Question.** `docs/ci/main-ruleset.json` (#806) makes the GitHub Actions app (id 15368) the only bypass actor for main. Does that bypass let a push made with the default `GITHUB_TOKEN` through those rules? Every scheduled data job pushes that way.

## Steps (owner only: this session's token may not write rulesets)

1. **Import both rulesets.** They are #806's file, with only the name, the target and (for the control) the bypass list changed:
   - in the browser: Settings → Rules → Rulesets → New ruleset → Import a ruleset, for `probe-ruleset.json` and then `control-ruleset.json`;
   - or, from your machine: `gh api --method POST repos/dsrackler17/EdgeDeskSports/rulesets --input probe-ruleset.json`, then the same for the control file.

   They target only `claude/bypass-probe/**` and `claude/bypass-probe-control/**`.
2. **Re-run the `TEMP bypass probe` workflow run on this branch** (Actions → the run → Re-run jobs), or ask the session to.
3. **Read the `PROBE_RESULT` lines.**
   - control **REFUSED**: the rules bind `GITHUB_TOKEN` pushes;
   - probe **ACCEPTED**: the bypass works. The ruleset can protect main without stopping the bots.
   - probe **REFUSED**: it does not. Do not activate `main-ruleset.json`.
4. **Clean up.** Delete both TEMP rulesets, then the branches `claude/bypass-probe-runner`, `claude/bypass-probe/target` and `claude/bypass-probe-control/target`.
