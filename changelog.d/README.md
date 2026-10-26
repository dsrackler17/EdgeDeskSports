# changelog.d — one file per change

Do not edit `CHANGELOG.md`. Add a file here instead; the Changelog job (`.github/workflows/changelog.yml`) renders every fragment into the block at the top of `CHANGELOG.md` on `main`.

```sh
node tools/changelog/assemble.js --new "The headline, in the house style"
# → changelog.d/2026-10-26-the-headline-in-the-house-style.md
```

A fragment is exactly the entry as it should read:

```markdown
## 2026-10-26 — The headline, in the house style

What changed, why, and how it was tested.
```

Rules (checked on every pull request by the integrity gate, and by `node tools/changelog/assemble.js --validate`):

- The name is `YYYY-MM-DD-some-slug.md`, lowercase letters, digits and hyphens. Its date matches the heading's date.
- The first line is `## YYYY-MM-DD — Headline`, with an em dash.
- There is one entry per file. A second `## ` heading starts another entry, so put that entry in its own file.
- The entry has a body.

Why: on 2026-10-26, eight of ten merged pull requests edited the top of `CHANGELOG.md`. Each one conflicted there, and merges resolved by hand dropped four entries that later commits had to restore. Two pull requests that each add a different file never conflict.

Fragments are kept after they are rendered, because they are the source the block is rebuilt from. To fix a published entry, edit its fragment.
