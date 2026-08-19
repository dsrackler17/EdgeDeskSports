# G. MODEL WALL SPECIFICATION

Purpose: the exact contract for the Model Wall, the default view of the Collective site, the first section of the embed, and the page a brand new member sees themselves on within a minute of joining. Columns, sort, status chips, update mechanism, click-through, and behavior at 3 models and at 300. Binding references: API-SHAPES.md `/v1/wall`, CONTRACT.md 4.4 (`model_wall`, `membership_status` views), F-ui.md for tokens and density.

---

## 1. Data source

One request: `GET /v1/wall` (free, `max-age=60`). One wall row per listed model of a listed active creator, straight from the `model_wall` view. The wall never computes a number client side; every value below names its source field in the response row.

## 2. Columns

Order is fixed. Desktop shows all; the phone column notes follow F-ui.md section 7 (identity sticky-left, rest scroll in-container).

| # | Column | Source field(s) | Render |
|---|---|---|---|
| 1 | Creator | `logo_url` or `monogram`, `creator_name`, `founding` | 20px logo (or monogram tile, `--surface2` bg, Inter 600) then name in `--text`. Founding adds a `--gold` `FOUNDING` chip after the name. Sticky-left on phone. |
| 2 | Model | `model_name` | `--mdl` color, Inter 500. |
| 3 | Sport | `sport` | Plain `--dim` text. Hidden entirely while only one sport is active (v1 is NFL only; the column appears automatically when `/v1/meta` lists a second active sport). |
| 4 | Status | `membership` | Chip per section 4. |
| 5 | Record | `record.wins`, `record.losses`, `record.pushes` | Mono, `14-9-1` form. `record` null renders the literal text `no grades yet` in `--faint`. |
| 6 | Win % | `record.win_pct` | Mono, one decimal, `60.9%`. `--pos` at or above .550, `--neg` at or below .450, `--text` between. Null with record null. |
| 7 | Margin MAE | `record.margin_mae` | Mono, one decimal. Lower is better; no coloring, the rankings page does comparisons. |
| 8 | Brier | `record.brier` | Mono, three decimals. |
| 9 | Coverage | `coverage_pct` | Mono percent plus a 40px inline bar (1px border track, `--accent` fill; fill turns `--warn` below the ranking threshold from `/v1/rankings` when cached, else 60). Coverage sits beside the record wherever the record appears (rule 8.7); on the wall that is one column to its right. |
| 10 | Last submission | `last_submission_at` | Relative, `2h ago` / `3d ago`, `--dim` mono. Null renders the literal text `none yet` in `--faint`. |
| 11 | Graded | `record.graded` | Mono integer, `--dim`. Sample size context for columns 6 to 8. Null renders `0`. |

Not columns, by design: confidence (creator-defined, never comparable, rule 9.5), any creator-supplied result or record (rule 9.1), any backfill numbers (profile only, rule 9.4), website and X links (`website_url`, `x_handle` power the profile page, not wall clutter).

## 3. Sort

**Canonical default order, server side and identical everywhere: membership rank (ACTIVE CONTRIBUTOR, then MEMBER, then INACTIVE), then graded desc, then name asc.** The API returns rows already in this order and the wall renders them as received. This is the same canonical order the embed uses (host pinned to index 0 there, nothing else host-variable).

Client-side sort options, applied to the loaded array, never re-requested:

- Default (the canonical order above, labeled `Standing`)
- Win % desc (null records sink to the bottom)
- Margin MAE asc (nulls sink)
- Brier asc (nulls sink)
- Coverage desc
- Last submission desc
- Creator name asc

One active sort at a time, toggled by tapping a column header (single direction per option as listed; tapping the active header returns to Default). The active sort renders an arrow glyph in the header. Sort choice persists in `sessionStorage` per tab and is never shared or serialized into URLs; the canonical link to the wall always opens in canonical order. The embed exposes no sort controls in v1, canonical order only, host pinned first.

Ties inside any client sort break by the canonical order, so sorting is deterministic and stable.

## 4. Status chips and derivation

Chip styling per F-ui.md (outlined, uppercase). Values come from `membership`, derived by the `membership_status` view per rule 8.8, never stored, never editable:

| Chip | Color | Derivation (server, from CONTRACT 4.4) |
|---|---|---|
| `ACTIVE CONTRIBUTOR` | `--accent` | A live resolved submission within `status.active_days` (10) while the sport is in season. |
| `MEMBER` | `--dim` | Joined but no live submission yet, or the sport is out of season. |
| `INACTIVE` | `--warn` | In season and silent for `status.inactive_days` (45) or more. |

The client renders the string it receives and maps it to a color. It never computes status, so the wall, the profile, the embed, and the admin console can not disagree. Unknown future values render as a `--dim` chip with the raw text, so a new status never breaks old clients.

Chip hover (desktop) and tap (phone) shows a one-line title attribute explaining the rule, e.g. `Submitted a live slate in the last 10 days`.

## 5. Live update mechanism

Cache TTL refetch, not sockets. `GET /v1/wall` every 60 seconds while visible, aligned with the server's `max-age=60`, per F-ui.md section 5. On refetch: diff by `(creator_slug, model_slug)` key, patch changed cells in place under the single 120ms opacity swap, preserve scroll and sort. A row that disappears (creator unlisted) is removed; a new row is inserted at its canonical position. The freshness stamp shows the response `generated_at`.

No websockets, no Realtime subscription in v1, deliberately: the wall changes on submission and settlement cadence, and the 60 second poll off a cached response costs one cheap request per open tab per minute. This is a decision, not a gap.

## 6. Click-through

- Any click on a row outside a chip navigates to the creator profile: `#/{creator_slug}` (doc H). The whole row is the target (40px on phone), with the creator cell as the semantic `<a>` for middle-click and long-press.
- Clicking the model name cell navigates one level deeper to `#/{creator_slug}/{model_slug}` (model detail).
- In the embed, the same clicks open the in-embed profile panel; the panel's outbound site and X links open the creator's own properties in a new tab (the embed exports traffic on purpose, build prompt Section 4).
- No hover-revealed actions. Everything reachable by tap.

## 7. Behavior at 3 models and at 300

The wall must look intentional the week it has 3 rows and stay usable at 300 (design for 60 creators, not 6, build prompt Section 5).

**At 3 models (launch state):**

- Full width, comfortable. The table keeps the F-ui.md density tokens (36px rows); it does not stretch rows or inflate padding to fill space, and it does not center a tiny table in a void: the table takes the full 1200px content width with its normal columns, and the space below it is used by the meta strip (`{creators} creators, {graded_games} graded games` from `/v1/meta`) and the settled highlights section, so the page reads as a young board, not an empty one.
- No search, no pagination, no virtualization. Three rows with real chips and real coverage bars look like the start of something, which is the screenshot the first members post.

**Growth thresholds, client side, driven only by row count:**

- **20+ rows: search filter appears.** One input above the table, placeholder `Filter by creator, model, or sport`, matching case-insensitively against `creator_name`, `model_name`, `sport`. Filtering is instant and local. Below 20 rows the input does not render at all; controls must earn their place.
- **100+ rows: client-side pagination.** Page size 100, canonical order preserved across pages, pager control (`1 2 3` plus prev and next) below the table. Search operates across the full dataset, not the current page. Sort applies across the full dataset before pagination.
- Sport filter chips appear alongside search once more than one sport is active, whatever the row count.

**At 300 models:**

- **Sticky header, same density.** The header row sticks (`position: sticky; top: 0`, `--surface2` background, bottom border) under the site nav. Row height, type scale, and cell padding are identical to the 3-row wall: density does not degrade with scale, that is the terminal promise.
- Three pages of 100 via the client pager. The full payload (300 rows of the wall shape is on the order of 100 to 150 KB) is still a single cacheable GET; server-side pagination of `/v1/wall` is deferred until the payload approaches 500 rows and is noted in doc N, not needed for the design target.
- Search and (multi-sport) filter chips are present per the thresholds above.
- Identity column sticky-left on phone plus sticky header combine so a phone user at row 250 still sees who and what.

**Embed at scale:** the embed shows the top 25 wall rows in canonical order (host pinned first) with a `View all {n} models on the Collective` link out to the full wall. This threshold lives in the embed, not the API; the bootstrap payload carries the full wall.
