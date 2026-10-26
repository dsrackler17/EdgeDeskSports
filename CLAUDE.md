# CLAUDE.md

The engineering rules for this repository live in `AGENTS.md`, which every
coding agent reads. They are imported here so that Claude Code loads them in
every session. Edit `AGENTS.md`, not this file.

@AGENTS.md

## Claude Code specifics

- Before you open a pull request, run `npm run verify`, and report its
  SUMMARY line and its NOT VERIFIED list verbatim in the pull request body.
- Create pull requests as drafts. Do not merge them, enable auto-merge, or
  mark one ready for review while a check is red or pending.
