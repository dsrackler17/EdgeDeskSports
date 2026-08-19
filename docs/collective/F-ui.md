# F. COLLECTIVE UI SPECIFICATION

Purpose: the visual and behavioral contract for every Collective surface: `collective/index.html` (wall, profiles, rankings, consensus, dashboard), `collective/join.html`, `collective/admin.html`, and the embed rendered by `collective/embed.js`. One aesthetic, specified once, so the site and the embed are the same components with the same rules. Binding references: CONTRACT.md section 3 (tokens, fonts), API-SHAPES.md (every string rendered comes from those shapes).

---

## 1. The terminal aesthetic, as rules

The Collective reads as part of the existing EdgeDesk terminal, not as a marketing site bolted onto it.

1. **Dark by default.** Background `--bg`, surfaces one step up, never pure black, never white panels.
2. **Dense.** Information per screen is the point. Tables over cards, rows over tiles. Whitespace is a separator, not a layout strategy.
3. **No cards inside cards.** One level of surface nesting maximum: page background, then a surface. A table sits directly on a surface. If a design draft has a bordered box inside a bordered box, flatten it.
4. **No gradients.** Flat token colors only, everywhere, including buttons and badges.
5. **No decorative animation.** No fades on load, no skeleton shimmer, no bouncing anything. The only permitted motion: instant hover state changes, and a single opacity transition (120ms max) when a data region swaps content after a refetch, to avoid flicker. Nothing animates that is not a state change.
6. **Numbers are mono, prose is Inter.** Every number a user might compare down a column renders in JetBrains Mono with `font-variant-numeric: tabular-nums`.
7. **Readable on somebody else's site.** The embed follows every rule here inside its shadow root; the light theme is the same system with inverted tokens, not a second design.

## 2. Color tokens

Exact tokens, identical to app.html, defined once per page and once inside the embed shadow root:

```css
:root{--bg:#0d0f13;--surface:#13161c;--surface2:#191d25;--border:#262c36;
--text:#e7eaf0;--dim:#8a93a2;--faint:#5b6472;--accent:#4d8dff;--pos:#2fb47c;
--neg:#e26044;--warn:#d99a2b;--gold:#e3b84d;--mdl:#9b8cff}
```

Usage map, binding:

| Token | Used for |
|---|---|
| `--bg` | page background, body |
| `--surface` | primary panels, table backgrounds |
| `--surface2` | sticky table headers, hover rows, input backgrounds |
| `--border` | all 1px borders, table row separators |
| `--text` | primary text, numbers |
| `--dim` | secondary text, column headers, timestamps |
| `--faint` | tertiary text, disabled, empty-state body copy |
| `--accent` | links, primary buttons, ACTIVE CONTRIBUTOR chip, focus rings |
| `--pos` | wins, positive records, resolved states |
| `--neg` | losses, errors, revoked, quarantined counts |
| `--warn` | late flags, INACTIVE chip, pending states |
| `--gold` | founding member badge only |
| `--mdl` | model names and model-specific accents |

No color appears in any stylesheet outside this list plus pure transparency. Light theme (embed only, `data-theme="light"`): the same variable names redefined with inverted values inside the shadow root; component CSS never branches on theme, only the token block does.

## 3. Typography

- **Inter** for all prose, labels, navigation, buttons. Loaded from Google Fonts with system-ui fallback: `Inter, -apple-system, "Segoe UI", sans-serif`.
- **JetBrains Mono** for numbers, records, keys, code, timestamps, table numeric cells, the embed snippet, the API key block. Fallback: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`.
- The embed does not load webfonts (it must not fetch on a host page beyond the API call); it uses the fallback stacks only.

Scale (rem, base 16px):

| Role | Size / weight | Face |
|---|---|---|
| Page title | 1.375 / 700 | Inter |
| Section heading | 1.0 / 600, uppercase, letter-spacing 0.06em, `--dim` | Inter |
| Body | 0.875 / 400 | Inter |
| Table cell | 0.8125 / 400 | Inter, Mono for numeric |
| Table header | 0.6875 / 600, uppercase, `--dim` | Inter |
| Chips and badges | 0.6875 / 600, uppercase | Inter |
| Key and code blocks | 0.8125 / 400 | Mono |
| Big record numbers (profile) | 1.5 / 600, tabular | Mono |

Line height 1.45 for prose, 1.2 in tables.

## 4. Layout and density rules

- Max content width 1200px, centered, 16px side padding.
- Single top nav bar: wordmark `MODEL COLLECTIVE` (Inter 700, letter-spaced) linking to the wall, then Wall, Rankings, Games, Activity, and Sign in / Dashboard on the right. Height 48px, `--surface`, bottom border.
- Table row height 36px desktop, 40px touch. Cell padding 8px 12px. Row separators 1px `--border`, no zebra striping.
- Panels: `--surface`, 1px `--border`, 6px radius, 16px padding. Never nested (rule 3 in section 1).
- Buttons: primary is `--accent` background with `--bg` text; secondary is transparent with `--border` border and `--text`. 32px height, 6px radius, no shadows.
- Chips: 2px 8px padding, 4px radius, transparent background with the state color as text and a 1px border in the same color at 40 percent alpha. Chips never have filled backgrounds; this keeps a dense table calm.
- Focus states: 2px `--accent` outline, always visible for keyboard users. Never removed.

## 5. Update cadence

- **60 second cache on free reads.** All free GETs arrive with `cache-control: public, max-age=60` (CONTRACT 5.2). v1 refetches on navigation and reload; the browser cache keeps that cheap inside the TTL. A visibility-gated 60 second refetch timer is a v1.1 target, not shipped.
- **No live sockets in v1.** No Supabase Realtime, no websockets, no SSE. The data changes on the cadence of submissions and settlements, not ticks; a 60 second poll against a CDN-cached response is the correct cost and complexity. Sockets are a future-expansion item (doc N), not a v1 gap to apologize for.
- v1.1 target: refetches swapping content in place with the single 120ms opacity transition, preserving scroll and sort. v1 re-renders the view on navigation.
- Paid and dashboard responses are `no-store`; the dashboard refetches on navigation and on an explicit refresh control, not on a timer.
- Each page shows one quiet freshness stamp per data region: `updated 14:32:05` in `--faint` mono, from the response's `generated_at` when present, else the fetch time.

## 6. Empty states catalog

Every empty state is designed copy, never a blank region or a spinner that never resolves. Layout for all: section heading stays, one `--text` line, one `--faint` line, optional single action. Exact strings, binding:

| Surface | Condition | Copy |
|---|---|---|
| Model Wall | zero listed models | Line 1: `The wall is being built.` Line 2: `Founding members are connecting their models now. Check back shortly.` |
| Model Wall search | filter matches nothing | Line 1: `No models match "{query}".` Action: `Clear search` |
| Creator profile | `empty_state: true` (zero live submissions) | Full spec in H-creator-profile.md section 6. Line 1: `First submission pending.` Line 2: `{display_name} is connected and will appear in grading after their first slate goes live.` |
| Model detail, recent graded | zero graded games | Line 1: `No graded games yet.` Line 2: `Grades appear after the first submitted slate settles.` |
| Rankings | no model clears thresholds | Line 1: `No models are ranked yet.` Line 2: `Ranking requires {min_coverage_pct} percent slate coverage and {min_graded_games} graded games. Every model's progress toward that shows below.` (thresholds from `/v1/rankings`) |
| Rankings, unranked list entry | below threshold | The API's `reason` string verbatim, in `--faint`. |
| Games week | no games loaded for the selected week | Line 1: `No games on the board for week {week}.` Line 2: `The slate posts when the schedule is loaded.` |
| Games, locked upcoming row | not entitled | Chip `LOCKED` in `--warn`, cell text: `Projections unlock for members.` One inline link: `Get access`. When `reason` is `billing_not_live`: `Member access opens soon.` and no link. |
| Consensus | fewer than 2 models on a game | Line 1: `Consensus needs at least two models on the board.` |
| Activity | zero rows | Line 1: `No activity yet.` Line 2: `Submissions appear here the moment they land.` |
| Dashboard earnings | billing inert | The API `note` verbatim: `Billing is not live yet. Attribution is being recorded now and pays out when billing turns on.` |
| Dashboard origins | zero origins | Line 1: `No sites registered for your embed yet.` Line 2: `Add the origin where your Collective tab lives and the embed unlocks there.` Action: `Add origin` |
| Quarantine (admin) | zero rows | Line 1: `Quarantine is clear.` |
| API failure (any region) | fetch failed or timed out | Line 1: `Could not reach the Collective.` Line 2: `Retrying automatically.` The 60s cycle doubles as retry; a manual `Retry now` link appears after two consecutive failures. Last good data stays on screen with its freshness stamp rather than being wiped. |

Interpolations (`{query}`, `{week}`, numbers) fill from live data. No lorem, no `coming soon` without a noun.

## 7. Phone behavior

It will be opened on a phone, most often from a creator's post. Breakpoint: 720px.

- **Tables scroll in-container.** Every table sits in a wrapper with `overflow-x: auto`. The page body never scrolls horizontally. v1.1 targets, not shipped in v1: a sticky-left identity column, `-webkit-overflow-scrolling: touch`, and a 12px end-fade scroll hint.
- **Nav collapses.** Below 720px the nav shows the wordmark plus a menu button toggling a full-width vertical list on `--surface2`. No hover-dependent menus anywhere; everything works on tap.
- Tap targets minimum 40px. Row height moves to 40px.
- Profile pages stack to a single column: identity block, then record, then coverage, then movement, then backfill.
- The three copy blocks on join screen 3 go full width; copy buttons stay above the fold of each block.
- Font sizes do not shrink below the section 3 scale; density on phone comes from stacking, not from smaller type.
- The embed follows the same rules inside its container width, using container queries where available and a resize observer fallback, since the host column width, not the viewport, is its real breakpoint.

## 8. Page inventory (hash-routed, single file `collective/index.html`)

| Route | Content | API |
|---|---|---|
| `#/` | Model Wall (doc G) plus meta counts strip | `/v1/wall`, `/v1/meta` |
| `#/{creator}` | Creator profile (doc H) | `/v1/creators/{slug}` |
| `#/{creator}/{model}` | Model detail: record, per-week coverage table, recent graded, movement summary | `/v1/models/{creator}/{model}` |
| `#/rankings` | Three boards, never blended, plus unranked list with reasons and a rules link | `/v1/rankings`, `/v1/rules` |
| `#/games` | Week board with settled results, grades, locked upcoming | `/v1/games` |
| `#/activity` | Submission feed | `/v1/activity` |
| `#/rules` | Published grading rules verbatim | `/v1/rules` |
| `#/dashboard` | Creator-only: profile edit, keys, origins, earnings, prompt re-download, embed snippet | `/v1/dashboard` and its POSTs |

One shared JS layer renders wall rows, chips, records, and empty states; the embed bundles the same rendering functions. If the site can render something the embed cannot, the shared layer is broken (build prompt Section 4).
