# Player Props — identity

**Durable ids, never names.** A player's EdgeDesk id is
`edp_` + 12 hex characters of `hash(league | anchor system | anchor id)`:

- the anchor for the NFL is the nflverse **GSIS** id;
- the anchor for CFB is the **ESPN** athlete id.

The id is minted once, kept forever in `football/props/<league>/players.json`
(`registry.js`), and never recomputed from a name.

The registry also keeps a **crosswalk** of provider ids:

- NFL: ESPN, PFR, PFF, NFL, ESB, Sleeper, OTC;
- the **sportsbook names** each book has used (`aliases.books`, learned only
  from an unambiguous match);
- **former names** (`aliases.former`), kept when a name changes, such as a new
  hyphenated surname or a preferred name;
- team history (`teams`), which records trades, and a slug assigned once
  (collisions get `-2`, `-3` …).

## Resolving a sportsbook name (`EDProps.resolvePlayer`)

The search space is the two rosters in the game. Steps are tried in order, and
the first unique hit wins:

1. **OVERRIDE.** `football/props/identity_overrides.json`, keyed
   `LEAGUE|team|compactname`, for the rare manual fix.
2. **EXACT.** The normalised name (accents, punctuation and **suffixes** such as
   Jr., Sr. and III removed) or a known alias.
3. **VARIANT.** Initials (A.J. ↔ AJ), a nickname table (Mike ↔ Michael …), or
   joined hyphenated surnames (Amon-Ra ↔ Amonra).
4. **TOKEN_SUBSET.** Same first name and final surname token.
5. **SURNAME_INITIAL.** Unique within the team and position.

**Two players who both fit are refused** (`AMBIGUOUS_*`). The quote becomes a
BAD MAPPING row and is never priced against a guessed player. A position hint
separates duplicate names (Josh Allen QB / LB). Unresolved names are listed in
`market.json` `unmapped` with the candidates that were considered.
