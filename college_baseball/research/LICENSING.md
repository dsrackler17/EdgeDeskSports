# Source licensing and permissions

**Release gate G1 ("verify source authorization") passes since 2026-10-22: the
owner (Davis) reviewed the NCAA's terms and authorised commercial use of the
NCAA-derived statistics (`research/authorizations.json`).** The other release
gates still decide what the board may claim. Research may run; nothing
from this engine is sold or labelled as a verified betting opportunity while
G1 fails (`validation/release_gates.json`).

| Source | Code licence | Data rights | Automation | Commercial use | Status |
|---|---|---|---|---|---|
| sportsdataverse/baseballr-data | MIT (LICENSE: "YEAR: 2026, COPYRIGHT HOLDER: baseballr.data authors") | compiled from stats.ncaa.org; NCAA terms of use govern the underlying statistics | public raw files, fetched through the guarded client at a few dozen files per season, cached 24 h | **authorised by the owner, 2026-10-22** (the MIT licence covers the repository's code; the owner reviewed the NCAA's terms for the data) | OWNER SIGNED |
| stats.ncaa.org (underlying) | — | NCAA | not accessed directly | not verified (site unreachable from this environment; its terms could not be read here) | OWNER DECISION |
| EdgeDesk `cbb` (ESPN) | — | ESPN terms | existing daily workflow | recorded in `datapack/quant_v1/sources/source_registry.json` as "commercial ingestion/redistribution rights not verified" | OWNER DECISION (pre-existing) |
| The Odds API `baseball_ncaa` | — | paid | through the odds gateway only, at most hourly, February–June | covered by the existing EdgeDesk subscription terms; quota authorised by the owner 2026-10-22 (about 45 credits a game day at most) | AUTHORISED (enabled by Deploy college baseball) |

What the owner needs to decide, concretely:

1. Whether EdgeDesk may display NCAA-derived statistics and model outputs built
   from them to paying subscribers (the NCAA's statistics terms).
2. Whether `baseball_ncaa` should be added to `public.odds_api_sports` and how
   much quota it may use. Until then every market comparison reads
   "MARKET UNAVAILABLE" and no expected value is computed.

What this engine does in the meantime:

- Downloads only public files from raw.githubusercontent.com, through
  `engine/http.js` (quotas, breaker, cache), never the NCAA site.
- Commits derived, aggregated tables (game results, per-game team totals,
  pitcher lines) with provenance (URL, sha256, fetch time) so a rights decision
  can be applied retroactively: deleting `college_baseball/data/` removes every
  NCAA-derived row, and `node college_baseball/ingest/build.js --all` rebuilds it.
