# Agents

Every coding agent working in this repository follows [CLAUDE.md](CLAUDE.md). It is not specific to Claude.

In short:

- never merge or push to `main`;
- never resolve conflicts in the GitHub web editor;
- never weaken a test or a check;
- add `changelog.d/` fragments instead of editing `CHANGELOG.md`;
- never commit a scheduled job's output unless you changed the code that produces it;
- claim your subsystem by opening a draft pull request early;
- run `node tools/integrity/gate.js local` before you push.

[docs/engineering/MERGE_SAFETY.md](docs/engineering/MERGE_SAFETY.md) explains why.
