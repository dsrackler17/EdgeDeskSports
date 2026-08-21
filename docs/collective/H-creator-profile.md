# H. CREATOR PROFILE SPECIFICATION

Purpose: element by element specification of the creator profile page (`#/{creator_slug}` on the Collective site and the profile panel inside the embed), with the data source per element, edit permissions, the public versus private boundary, and the zero-submission empty state that Section 6 requires to be screenshot-worthy. Binding references: API-SHAPES.md `/v1/creators/{slug}` and `/v1/models/{creator}/{model}`, CONTRACT.md 4.2 (creators, models), 4.4 (views), F-ui.md for rendering rules.

---

## 1. Data sources, one request per page

The profile renders entirely from `GET /v1/creators/{slug}` (free, `max-age=60`). That response is assembled server side from these underlying sources, and no element on the page draws from anywhere else:

| Underlying source | Feeds |
|---|---|
| `collective.creators` (row) | identity block: name, description, links, logo, founding flag, joined date, pinned model |
| `membership_status` view | status chip |
| `model_records` view (built from `grades` on graded candidate projections) | per-model record block |
| `model_coverage_totals` view | per-model coverage percent and bar |
| `model_movement` view (summarized) | movement note per model, expanded on the model detail page |
| `projections` where `data_origin='backfill'` (counted) | the backfill block, shown separately, never ranked |

Deep dives (per-week coverage table, recent graded rows with movement counts) live on the model detail page via `/v1/models/{creator}/{model}`, not on the profile.

## 2. Elements, top to bottom, each with its source

**2.1 Identity block.** Source: `creator` object, ultimately the `creators` table.

- Logo (`logo_url`) or generated monogram (`monogram`, server-computed initials): 56px tile, `--surface2` background for monograms.
- Display name (`display_name`), page title scale.
- Founding chip (`founding`) in `--gold` when true.
- Membership chip (`membership`), derived server side per rule 8.8, colored per G-model-wall.md section 4. Never computed client side.
- Description (`description`), body text; omitted cleanly when null, no placeholder box.
- Outbound links: website (`website_url`) and X (`x_handle`, rendered as `@handle`, linking to x.com). Both open in a new tab. These links exist on purpose: the Collective exports traffic to the creator's own properties (build prompt Section 4). Omitted when null.
- Joined line: `Member since {joined_at, month year}` in `--dim`.

**2.2 Models section.** Source: `models` array. One panel per model (flat, no nesting per F-ui.md). The pinned model (`creator.pinned_model_slug`) renders first, others in graded desc then name order. Per model:

- Model name (`model_name`, `--mdl`) and sport (`sport`), linking to the model detail page.
- Record block, source `record` (from `model_records` via `grades`): big mono `W-L-P`, then win pct, margin MAE, Brier, and `graded` count on one metrics line. The three metrics render side by side and are never combined into any single score (rule 8.11). `record` null renders the model-level pending line: `No graded games yet. Grades post when submitted slates settle.`
- Coverage, source `coverage_pct` (from `model_coverage_totals`): percent plus the inline bar, always adjacent to the record (rule 8.7: coverage shows next to every record everywhere a record appears). Below the ranking threshold the bar is `--warn` and a `--faint` line states `Coverage below the {threshold} percent ranking minimum`.
- Last submission (`last_submission_at`), relative time in `--dim` mono.
- Movement note, source: `model_movement` summarized server side. One `--dim` line when revisions exist, e.g. `Revised numbers on 3 games this week. First submissions are what gets graded.` This is display of drift, never the graded number (rule 8.5).
- Backfill block, source: `models[].backfill` (counted from `projections` where `data_origin='backfill'`). Rendered as a visually distinct sub-section at the bottom of the model panel, `--surface2` background strip, `--dim` text, labeled exactly: `BACKFILLED HISTORY` with the row count and the API's note verbatim: `Backfilled history, shown separately, never ranked`. Backfill numbers never mix into the record block, never appear on the wall, never enter rankings or consensus (rule 9.4). When `backfill` is null or zero rows, the strip does not render at all.

**2.3 Recent graded strip (per model, optional).** Rendered on the model detail page from `recent_graded` in `/v1/models/{creator}/{model}`: table of label, week, pick, closing spread, final, result chip (`--pos` win, `--neg` loss, `--dim` push), margin error, Brier, and `movement_n` as a small `x2` style revision count. The profile page links to it (`Full record`) rather than embedding it, keeping the profile one screen tall for most creators.

**2.4 Collective footer.** Every profile carries the persistent link back to the Collective wall and, in the embed, the wordmark link required by the embed contract.

## 3. Edit permissions

- **The creator edits identity fields only, via the dashboard, never on the profile page itself.** `POST /v1/dashboard/profile` accepts exactly: `display_name`, `description`, `website_url`, `x_handle`, `logo_url`, `pinned_model_slug` (CONTRACT 5.2). Authenticated by the creator's own JWT; the edge function resolves the creator from the JWT, so a creator can never address another creator's row.
- **Never records.** No API path exists for a creator to write to `grades`, `results`, `projections` (outside append-only ingest), or any view input. Records, coverage, movement, membership status, and rankings are Collective-owned transforms (rule 8.10) and are not editable by anyone, including the founder: they are derived, and changing them means changing the raw tables through the audited maintenance path.
- Slug is not editable in v1 (it is the public identity and inbound links depend on it); a rename request is an admin action, noted for doc N.
- Admin (founder console) can toggle `is_listed`, `status`, and clear personal fields on departure per the retention decision (CONTRACT 1.6). Admin cannot set membership status, which has no column to set.

## 4. Public versus private

**Everything rendered on the profile is public.** The profile endpoint is free, unauthenticated, and cacheable; there are no logged-in-only elements on it. Explicitly public: display name, monogram or logo, description, website, X handle, founding flag, membership status, joined date, per-model records, coverage, movement summaries, backfill counts, recent graded rows.

**Dashboard-only, never on the profile, never in any free or paid public response:**

- API keys (even prefixes) and key status
- Earnings, balances, referral counts, `referral_share_bps`, `billing_mode`
- Embed origin allowlist
- Email and auth identity (`user_id` never leaves the database in any response)
- Invite token linkage
- The Universal Prompt (regenerable from the dashboard, keyed to the creator)

The split is enforced by which edge function builds the response, not by the frontend hiding fields: `collective_public` profile assembly simply never selects those columns. There is no `private: true` flag pattern anywhere; a field is either in the public shape in API-SHAPES.md or it does not exist publicly.

## 5. Rendering rules inherited

Tokens, type, density, phone stacking order (identity, record, coverage, movement, backfill) per F-ui.md. The embed's profile panel renders the same elements from the `creators` array of the bootstrap payload, same order, with outbound links always live.

## 6. The zero-submission empty state

Trigger: `empty_state: true` in the profile response (creator has zero live submissions). Per Section 6 of the build prompt this page must look intentional, not broken: it is the page a brand new member screenshots and posts within minutes of joining, so it is a marketing surface with a spec, not a fallback.

What renders, exactly:

- The full identity block from section 2.1, complete: logo or monogram, name, founding chip if applicable, chip `MEMBER`, description if given, website and X links if given, `Member since {month year}`. Nothing about the top of the page differs from a veteran profile.
- The model panel renders with the model name, sport, and coverage bar at 0 replaced by the pending block below. No empty record grid, no dash-filled table, no zeroed stats that read as a bad record.
- The pending block, copy verbatim (interpolating the display name):

  Line 1 (`--text`, body weight 600): `First submission pending.`
  Line 2 (`--faint`): `{display_name} is connected and will appear in grading after their first slate goes live.`

- If `website_url` is null, one additional `--faint` line under the identity block: `This profile is {display_name}'s home on the Collective.` (mirrors the join flow's one-liner: no website means the Collective profile is their site).
- The persistent Collective footer link, so the screenshot always carries the brand.

What never renders in the empty state: any zeroed metric (`0-0-0`, `0.0%`), any progress spinner, any `error` or `no data` wording, any admonition to submit. The page states a fact in a calm voice: connected, pending, coming.

Exit condition: the first live resolved submission flips `empty_state` to false and `membership` to `ACTIVE CONTRIBUTOR` by derivation, and the record block appears after the first settlement grades. No cache older than 60 seconds ever shows the stale state.
