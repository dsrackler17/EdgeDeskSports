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

## Stage 2 — badges, dossier, honest states, limitations, search, saved list

Identity check result: **CLEAN** (`--allow-render-changes`). Section C — the
mandatory one — reports *no numeric literal, rounding call, or threshold
changed* in any render function. Section A shows two added queries and zero
removed. Section L confirms no numeral was lost from the plumbing layer; the
five new ones are the confirmed cadence constants.

### Provenance and maturity as data

- `RS_PROV` describes every value class each module displays, with its tier and
  its factual data lineage. `RS_TIER` defines the four tiers: **T0 Observed**,
  **T1 Estimated**, **T2 Computed** (de-vig, fair, CLV, differences,
  percentiles — rendered as *computed*, never as a model), **T3 Research
  Model**. Rendered as a per-module "Provenance & maturity" panel plus inline
  badges on the headline model outputs (WTA `research_score`, props/stats
  `p_over`, UFC live win probability).
- Maturity is a **separate axis**, read only from `research_model_current`
  (`select=*`, field names resolved defensively so the view's exact column
  spelling does not have to be guessed). Absence never implies validation:
  unreachable schema, missing view, no row for the model, or a row with no
  result all render exactly **"No validation report exists for this model."**
  and the model reads **Experimental**. The two live models
  (`wta.research_score`, `model_props.p_over`) therefore read Experimental with
  no validation report — which is the truth today. **No rows were stubbed and
  no table, view, or migration was created.**
- Tapping either badge opens the dossier: version, status, training window,
  validation window, objective, holdout result, last updated — each showing
  "not published" when the field is absent rather than inventing a value.
- Section label is now **"Research Models (Experimental)"**.
- Third-party models that previously had no attribution anywhere (CFBD SP+ and
  **pregame Elo**, ESPN live win probability) now carry a tier badge and their
  source lineage.

### Honest state taxonomy

Every module renders one of: **schema not exposed** (406/404), **reachable but
empty** (zero rows), **zero qualifying** (WTA only — shows reviewed and
excluded counts and explains that the grade is computed server-side), or
**network / auth failure** (each with its own copy, the status code, and the
raw message escaped). Every state carries its own retry. The generic
`'Could not reach the database: ' + e.message` renders are gone from all five
loaders, along with the unescaped interpolation of `e.message`.

### Freshness SLA

WTA is the only pipeline publishing a build time, so it is the only module with
a real SLA (stale renders with the age and the cadence it missed). CFB, UFC,
Stats and Props render a visibly inactive "Freshness SLA inactive" state. **The
fake `'loaded ' + ago(Date.now())` labels — permanently "0s ago" — are deleted
in all four modules**, and the UFC live poll now labels itself by its polling
interval instead of a computed-from-now age. Cadences: WTA/Stats/Props daily,
CFB/UFC weekly, Lab none.

### Cross-module capability

- One entity search across every loaded module, routing to the right module and
  opening the profile. Modules that have not been opened are listed as *not
  searched* with a link, rather than silently omitted.
- Shared saved-research list for any module's entity, persisted under the
  existing `edgedesk_prefs` key (new whitelisted `savedResearch`). Star buttons
  on the CFB team and UFC fighter profiles and on every search hit.
- Per-entity CLV linkage: queries graded `signals` on demand and links the
  receipt where rows exist; where none exist it says *"No graded CLV record
  exists for this entity yet — research context is not an edge."* A failed
  lookup says so explicitly and is never reported as "no record".

### Approved fixes in this stage

- **Lab null-threshold gate** — a validation row with no registered bar used to
  compare against `null` (`sa>=null` → `sa>=0`) and paint a green ✓ against a
  dash. A missing bar now renders *unknown* ("no bar registered"), never
  satisfied.
- **Lab numeric-JSONB crash** — the Lab's `esc` delegated to `stEsc`, whose
  `(s||'')` pattern calls `.replace` on a number and throws, killing the panel;
  the catch then blamed an unmigrated table. `esc` now coerces before escaping,
  and the loader classifies failures instead of asserting a schema problem.
  *Note:* this is the one place a rendering can differ — a JSONB field whose
  value is `0` now renders `0` instead of blank (previously it either blanked or
  crashed the panel). Inherent to the approved fix; no computed number changed.
- **WTA fabricated reason** — the client asserted "score N below the 70
  threshold" for any row without a published disqualifier, even when N ≥ 70. It
  now renders the pipeline's published reason or *"reason not published by the
  pipeline"*. **No client-side string restates the threshold anywhere** (the
  transparency and hidden-count notes were rewritten to reference the
  pipeline's qualifying grade). The gate itself is untouched and server-side.
- **Stats outages** — a failed read used to render "Run capture_stats…", an ops
  instruction for a connectivity problem. Read failures now surface as the
  classified state.
- **CFB season labels** — `team_season_stats` is read without a season filter,
  so the UI no longer claims one for season totals or the record. SP+ *is*
  filtered, so it still names its season. No filter was added.
- **Escaping** — DB-sourced values are escaped in the props board and controls,
  stats projection chips, WTA rates line, UFC chips/live badge, and the CFB SP+
  chip; UFC `fighter_id` values are encoded before entering `onclick`
  attributes. All use `rsEsc(''+v)`, which preserves today's exact
  stringification (so `null` still renders as it did) while closing the
  injection surface.

### Verified

- `scripts/research-identity-check.py`: CLEAN (exit 0). The script now compares
  the plumbing layer (loaders + module registry) as a whole, so logic relocated
  out of a loader into the registry's `freshness()` is verified as *moved*
  rather than lost — it fails on a lost numeral and reports gained ones.
- All 10 inline `<script>` blocks pass `node --check`.
- Stage-1 regression suite: 20/20. Stage-2 suite: 43/43 — badge pairs and
  limitations on all six modules, honest state + retry on all six, no fake
  freshness age, dossier showing the exact no-report string, maturity never
  inferred as Validated, no "70 threshold" string in the DOM, search, saved
  list, and CLV copy. Zero uncaught console errors.

---

## Deep-dive builder integration (uploaded package)

The uploaded `EdgeDesk_UFC_WTA_ATP_deep_dive_builder.zip` is an offline Python
ETL plus a UFC schema definition. It is preserved verbatim under
`tools/deep-dive-builder/` (not wired into the app — it downloads CSVs and
writes a local warehouse; the app is a browser client reading Supabase), with
`tools/deep-dive-builder/INTEGRATION.md` recording what was and was not used.

Implemented into the stats — the part that is frontend-implementable without
inventing data, the **UFC source field dictionary** (`ufc_schema.csv`):

- `RS_FIELDS.ufc` carries all 21 fields verbatim (field, definition, source,
  tier), each mapped to the column this build actually reads.
- A **Source field dictionary** panel renders in the UFC module: every field,
  the source's own definition, its tier badge, and whether this build reads it.
  The four fields it does not read (`dob`, `record_nc`, `knockdowns`,
  `fight_time`) are marked as such and displayed nowhere.
- Every UFC career-microstat label in the fighter profile and stat grid now
  carries the source's definition, so a stat's meaning comes from the schema
  rather than a hand-written label. Labels the schema does not define carry
  nothing rather than an invented gloss.
- A **Deep-dive dataset coverage** block states per module what the builder
  defines versus what the live pipeline owns, including that the tennis
  season/surface/H2H aggregates are owned by no pipeline here and are therefore
  displayed nowhere, and that their source is CC BY-NC-SA 4.0 (non-commercial).

Not implemented: the tennis half (needs tables and a pipeline — out of scope)
and an ATP module (the app has no ATP data or surface; adding an inactive tab
is a product decision, left to the owner).

Identity check after this change: **CLEAN**. Section C caught a numeric token
added to `ufcStatGridHTML` while wiring the definitions; the code was fixed
(label bound once) rather than the check relaxed.
