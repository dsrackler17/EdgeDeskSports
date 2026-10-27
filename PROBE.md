# TEMPORARY: ruleset bypass probe (2026-10-26, revised 2026-10-27)

This branch is never merged. It holds no repository code. Delete it, and the scratch target branches, when the probe is done.

**Why it changed.** On 2026-10-27 GitHub refused to import `docs/ci/main-ruleset.json` with "invalid actor": this account does not accept the GitHub Actions app (id 15368) as a bypass actor. Its bypass menu offers Deploy keys, the Repository admin, Maintain and Write roles, and the installed apps (Claude, ChatGPT Codex Connector, Supabase). A ruleset that requires pull requests and status checks also binds the data jobs' direct pushes to main, so it needs a bypass that lets them through.

**Question.** Which bypass lets the data jobs' pushes through `main-ruleset.json`'s rules?

- **Write role.** Does it cover a push made with the default `GITHUB_TOKEN`, the way every data job pushes today? If so, the full ruleset needs no workflow change.
- **Deploy keys.** The fallback in `docs/ci/BRANCH_PROTECTION.md`. It works only if the data jobs push with a deploy key, which is a change to the publishing workflows.

Each of the three rulesets has `main-ruleset.json`'s rules unchanged. Only the name, the target and the bypass list differ:

| File | Targets | Bypass |
|---|---|---|
| `control-ruleset.json` | `claude/bypass-probe-control/**` | none |
| `write-ruleset.json` | `claude/bypass-probe-write/**` | Write role |
| `deploykey-ruleset.json` | `claude/bypass-probe-deploykey/**` | Deploy keys |

## Steps (owner only: an agent's token may not write rulesets)

1. **Import all three rulesets.** Settings → Rules → Rulesets → New ruleset → Import a ruleset, once per file. Before you click Create:
   - `write-ruleset.json`: the bypass list must show exactly **Write** (Roles). If it shows another role, delete that one and add Write with **Add bypass**.
   - `deploykey-ruleset.json`: the bypass list must show exactly **Deploy keys**.
   - `control-ruleset.json`: the bypass list must be empty.
2. **Optional: the deploy-key row.** This is needed only if the Write row does not come back ACCEPTED.
   1. On your own machine, run `ssh-keygen -t ed25519 -C "edgedesk bypass probe" -f probe_key` and press Enter twice for no passphrase.
   2. Settings → Deploy keys → Add deploy key: title `TEMP bypass probe`, paste the contents of `probe_key.pub`, and tick **Allow write access**.
   3. Settings → Secrets and variables → Actions → New repository secret: name `PROBE_DEPLOY_KEY`, value the contents of `probe_key` (the file without `.pub`).
   4. Never paste `probe_key` anywhere else.
3. **Re-run the `TEMP bypass probe` run on this branch** (Actions → the run → Re-run jobs), or ask the session to.
4. **Read the table on the run's summary page.**
   - **control** must be REFUSED on every row. That shows the rules bind that kind of push.
   - **write** ACCEPTED on the GITHUB_TOKEN row: a Write-role bypass lets today's data jobs through. Before relying on it, check that it does not also let you or the agents through. On `claude/bypass-probe-write/target`, edit `README.md` in the browser and try to commit directly. GitHub must refuse, or offer a bypass you do *not* have. A session can also try a push.
   - **deploykey** ACCEPTED on the deploy key row: the deploy-key fallback works.
5. **Clean up.**
   - Delete the three TEMP rulesets.
   - Delete the `TEMP bypass probe` deploy key and the `PROBE_DEPLOY_KEY` secret, if you made them.
   - Delete the branches `claude/bypass-probe-runner`, `claude/bypass-probe-control/target`, `claude/bypass-probe-write/target`, `claude/bypass-probe-deploykey/target` and the unused `claude/bypass-probe/target`.
