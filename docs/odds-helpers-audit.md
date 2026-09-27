# Odds helpers: audit and first consolidation (September 2026)

`docs/research-terminal.md` §4.5 recorded "≈30 duplicate odds helpers" and left
consolidation as a follow-up that "has to be verified module by module". This
is that audit, and the first verified migration.

**The rule applied:** a helper was migrated only where its body was
byte-identical to the canonical one and a parity test proves the same output
for every input, including the awkward ones. Two functions that share a name
but behave differently stay separate, and the reason is written down here.

## What was migrated

`lib/research_core.js` now carries the edge-kernel convention once, as
`R.odds` (`amToDec`, `decToAm`, `probToAm`, `breakEven`, `devig2`). The four
server-side kernels that are inlined only into `edgedesk_ai/index.ts` call it
instead of carrying their own copies:

| kernel | helpers removed | now calls |
|---|---|---|
| `_pricing.js` (EDPRICE) | `amToDec`, `decToAm`, `devig2`, `breakEven` | `R.odds.*` |
| `_board.js` (EDBOARD) | `amToDec`, `decToAm` | `R.odds.*` |
| `_stake.js` (EDSTAKE) | `amToDec`, `decToAm` | `R.odds.*` |
| `_desk.js` (EDDESK) | `amToDec`, `decToAm`, `probToAm`, `breakEven` | `R.odds.*` |

`index.ts` inlines `lib/research_core.js` (the `EDRCORE` block), and the
kernels resolve it lazily, at the first price, so block order in the host
does not matter. Under Node they `require` the same file.

`tools/research/odds_parity.test.js` pins the old bodies verbatim and checks
1,254 input combinations against `R.odds`, plus each migrated kernel's own
public functions. It runs in `npm run research:test`.

## Kept separate on purpose

These look like the migrated helpers and are **not** the same function.

| helper | where | why it stays |
|---|---|---|
| `R.americanToDecimal` | `lib/research_core.js` | Strict: refuses \|a\| < 100 (not a real American price). The kernels have always accepted e.g. `+50 → 1.5`, and their callers and tests depend on it. |
| `R.decimalToAmerican`, `R.probToAmerican` | `lib/research_core.js` | Unrounded (analysis values). The kernel convention rounds to a whole price (display and record values). |
| `R.breakEven` / `R.impliedProb` | `lib/research_core.js` | Take an **American** price, no push mass, unrounded. |
| `impliedProb(dec)` | `_intelligence.js` (EDINTEL), `app.html` 32648 | Same name, takes a **decimal** price. `app.html` 22569 has an `impliedProb(american)` in a different scope. Merging either would silently change inputs. |
| `R.noVigTwoWay` | `lib/research_core.js` | Strict prices, unrounded overround; `R.odds.devig2` rounds the overround to four places, as EDPRICE always did. |
| `devig(decs, "shin")` | `supabase/functions/capture`, `close` | Multi-way **Shin** de-vig, not proportional. The two copies are identical to each other, but each edge function is bundled and deployed on its own. Sharing needs a `_shared/` module in the deploy, which is a separate change. |
| `decToAm` | `lib/tennis_model.js` | Rounds negative prices as `-Math.round(100/(d-1))`, which differs from `Math.round(-100/(d-1))` at exact half-cent boundaries. `amToDec` there also rounds to four places. |
| `decToAm` | `football/engine.js`, `football/cfb_p4/engine.js` | No null guard (a decimal ≤ 1 returns a number). They are the engines' published parameter objects, and the backtests read them. |
| `amToDec`, `decToAm`, `devig2(dec, dec)` | `lib/tennis_research.js`, `lib/ufc_research.js` | The same arithmetic, but `devig2` takes **decimal** prices, and both are browser libraries loaded by their own pages without `research_core.js`. Migrating them means adding a script to those pages and re-running their UI tests. |
| `decToAmerican`, `probToAmerican` | `_presentation.js`, `_research.js`, `_intelligence.js`, `app.html`, `brief.html`, `record.html`, `tools/lib/snapshot_contract.js` | The rounding matches `R.odds.decToAm`. But EDPRES and EDINTEL are also inlined into `app.html`, `brief.html` and `record.html`, where `window.EDResearch` is a **different object** (`app.html` defines its own research-orchestration layer under that name). A kernel that reached for `EDResearch.odds` there would find the wrong thing. The name collision has to be resolved first. |
| inline formulas | `tools/intelligence/validate_staking.js` (3 sites) | Offline validation scripts whose outputs are committed (`football/validation/staking_*.json`). Migrate when those artifacts are next rebuilt, so the diff shows no change. |

## Next steps, in order

1. Rename `app.html`'s orchestration `window.EDResearch` (or give the research core
   a second global name). That unblocks EDPRES, EDINTEL and EDRESEARCH, the
   largest group.
2. Load `lib/research_core.js` on the tennis and UFC pages and migrate their
   American↔decimal pair. `devig2(dec, dec)` stays separate or gets its own
   decimal-input canonical helper.
3. Move the Shin `devig` into a `supabase/functions/_shared/` module imported by
   both `capture` and `close`.
4. `validate_staking.js`, at its next artifact rebuild.
