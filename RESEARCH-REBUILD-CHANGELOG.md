# Research section rebuild — changelog

Architecture and presentation only. The research protocol is frozen: no ranking
logic, weighting, threshold, de-vig method, CLV calculation, model math, or
hypothesis definition changed in any stage. `scripts/research-identity-check.py`
proves it mechanically — run it against any two revisions of `app.html`:

    git show <pre-rev>:app.html > /tmp/pre.html
    python3 scripts/research-identity-check.py /tmp/pre.html app.html

Exit 0 = every PostgREST query string, every render/format function, every
display constant, and every numeric literal/rounding call/threshold in the
render layer is identical. Loader plumbing diffs are printed for review.

---

## Stage 1 — shell, registry, fetch consolidation, routing, state

Zero visual change. Identity check result: **CLEAN** — 124 query literals
identical, all three pagination profiles identical, 70 render functions and
6 display constants byte-identical, numeric fingerprints unchanged.

### Moved

- The six research `<section>`s (`v-cfb`, `v-ufc`, `v-wta`, `v-stats`,
  `v-props`, `v-lab`) became panels (`.rpanel`) inside one shell section
  `#v-research`. Every panel keeps its original element ids, so all existing
  render functions and `$()` lookups are untouched. Three of the six sections
  previously sat outside `<main>`; `.view` carries all layout CSS (and `main`
  has none), so the move is layout-neutral.
- `show()` no longer dispatches the six research loaders; the module registry
  (`RESEARCH_MODULES` / `researchRegister`) owns activation. Legacy calls and
  stored prefs that reference subview ids (`show('cfb')`, `lastTab:'cfb'`)
  still work — `show()` reroutes them into the shell.
- The five research refresh buttons now call `researchRefresh(<id>)` (the
  registry's force path with in-flight dedupe and abort) instead of inline
  `loadX(true)`. Same fetch, same force semantics.

### Deleted as duplication

- Five of the six byte-identical `.research-sub` nav blocks (old lines 1498,
  1508, 1518, 1551, 1564, 1575 — md5 175027ed…). One copy remains, rendered
  once at the top of the shell.
- Two of the three pagination-helper clones. `rsFetchAll(schema, sel, ord,
  maxPages, signal)` is the single implementation; `cfbFetchAll` /
  `ufcFetchAll` / `stFetchAll` remain as one-line shims preserving each
  module's exact page cap (25/20/60), default order (`team` / `full_name` /
  `player`), page size (1000), and schema profile, so every request URL is
  byte-identical. Non-research callers of `stFetchAll` (Faults'
  `loadFaultDetail`) and `ufcFetchAll` (Stats' UFC injection) are unaffected.

### New architecture

- **Module contract** — each module registers `{ id, label, schema, cadenceMs,
  load(force, signal), render(), hasData(), search(q), openEntity(id),
  closeEntity(), entityOpen(), deactivate(), freshness(), availability(),
  limitations(), provenance }`. Stage 1 wires the mechanical fields; the
  presentation fields (`availability` / `limitations` / `provenance` dossier)
  render in stage 2. Loaders are late-bound through `window.*` at call time —
  the parse-order trap that killed the ED_COVERAGE Lab section (see below)
  cannot recur.
- **Hash routing** — `#research/<module>` (replaceState, no history spam) and
  `#research/<module>/<entity-id>` (pushed entry). Browser Back now closes the
  `cfbModal` / `ufcModal` profile instead of leaving the app; deep links
  restore module + entity on load. The Record deep link (`#receipt=…`) is
  untouched; each router ignores the other's hashes.
- **lastTab bug fixed** — visiting a research subview stores
  `lastTab:'research'` plus a new whitelisted pref `lastResearchSub` (added to
  `PREF_DEFAULTS`; the prefs reader drops unknown keys, so whitelisting is part
  of the fix). Boot restore routes `lastTab:'research'` to the stored sub;
  legacy stored subview ids still restore correctly and now light the Research
  tab and the sub-nav chip (previously neither lit, and the first Research tap
  yanked a restored WTA/Lab user to CFB).
- **Request lifecycle** — one AbortController per module activation, threaded
  through `sbFetch`; switching modules or leaving the research shell aborts
  in-flight loads. Loaders never commit half-aborted state (guards before every
  state mutation). In-flight loads are deduped; force refresh aborts and
  restarts. Activation paints existing state immediately
  (stale-while-revalidate) and lets each loader's unchanged 300 s TTL guard
  decide whether to refetch.

### Behavior fixes approved for stage 1

- UFC Live Fight Center's 20 s poll timer is cleared on module switch / leaving
  research (previously polled forever and kept rewriting the hidden view).
- UFC mode desync on re-entry fixed: `loadUFC` renders through `ufcRenderMode`,
  which respects Live mode instead of stomping it with the research list.
- `ufcLoadFights` no longer caches `[]` permanently after one failed fetch —
  a transient failure returns empty once and the next tap retries.
- `cfbEsc` also encodes apostrophes (`%27`): `cfbOpenTeam('Hawai'i')` was a JS
  syntax error, so Hawai'i's team modal could never open.

### Verified

- `scripts/research-identity-check.py`: CLEAN (exit 0).
- All 10 inline `<script>` blocks pass `node --check`.
- Browser smoke test (Playwright, stubbed session): 20/20 assertions pass —
  single nav copy, hash + prefs writes, modal open/Back-close/X-close, legacy
  and new-style boot restore, deep link, live-poll teardown; zero uncaught
  console errors; per-subview screenshots pixel-identical to the pre build.

---

## Documented for later (explicitly NOT changed in this pass)

- **Lab "Market Coverage Research" is dead code** (flag per protocol owner:
  ships later as its own change, with badges). The wrapper that mounts
  `ED_COVERAGE.mountResearch` into `#labHost` runs in a `<script>` that ends
  before `window.loadLab` is defined in a later block, so its guard returns and
  the whole section is unreachable. The two-line fix, when it is wanted: move
  the wrapper IIFE (the block that begins "Non-invasively extend the existing
  Lab loader") after `loadLab`'s definition — or re-register Lab's `load`
  through the registry's late-binding, which is how stage 1 wires every other
  loader precisely to avoid this trap.
- p_over green/red chips at ≥52 / ≤48 read as a lean; presentation decision
  deferred by the protocol owner.
- WTA watchlist tab can contradict the Today's-research tab for `watch`-grade
  favorites (beyond the fabricated-reason fix scheduled for stage 2).
- Dead code left in place: `renderAllBoards` / `renderTrapRadar` (and the
  `model_odds` table they reference), the `onlyPositive` pref, the Settings
  `defaultTab:'boards'` option pointing at a nonexistent view, `wtaPct`.

## Stage 2 — pending

Badges (provenance T0/T1/T2/T3 + maturity from `research_model_current`),
model dossier, honest state taxonomy with per-state retry, freshness SLA
(WTA real; others visibly inactive — the fake "0s ago" labels go), known
limitations blocks, cross-module entity search, shared saved-research list,
and the remaining approved fixes (Lab null-threshold gate, Lab numeric-JSONB
crash + misleading banner, WTA fabricated disqualifier reason, Stats outage
honesty, CFB season-label honesty, unescaped e.message/DB values).
