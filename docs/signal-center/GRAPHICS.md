# Signal Center — graphics

Signal graphics are drawn by the same renderer as EdgeDesk's matchup graphics,
`lib/edgedesk_game_graphic.js`. The new signal layouts register on it as
`signal_v1` (`lib/edgedesk_signal_graphic.js`, template version `sg1`).
Extracting the shared pieces (the drawing kit, the backdrop, the lockup, the badge
and the footer) left every matchup layout byte-identical: 392 layouts were hashed
before and after the change and compared.

## Templates

| Template | Drawn for | What it shows |
| --- | --- | --- |
| `probability_shift` | Forecast shift | Previous → updated win probability, the change, the evidence class and what it means, model version, both snapshot times |
| `market_disagreement` | Model–market disagreement, convergence, market movement | EdgeDesk vs the named book (de-vigged), the gap or the move, capture times, "a question, never a recommendation" |
| `injury_impact` | Availability change | Was → now designation with its source and publication time; a forecast effect only when the model computed one |
| `simulator_movement` | Simulator change | Previous → current run probability, the change in Monte Carlo errors, "sampling error only"; CFB selection marked Estimated |
| `reliability_alert` | Model reliability warning | What the live record shows (band, sample, market comparison) and what it implies |
| `weekly_recap` | Built on demand in `/admin/signals/` | The top 3–5 published, verified signals of the window, ranked by the documented score |

Every graphic carries the lockup, **RESEARCH NOT PICKS**, the label and category
chips, the evidence class, the verification state, the signal key and version
hash prefix, and the site. A data-quality warning gets no graphic. Team logos are
never drawn. A team mark is a monogram badge in the team's registered colours
(`teamStyleResolver`). Neutral colours and initials are used when no colours are on file. A logo is never
fabricated.

## Formats

| Format | Size | Use |
| --- | --- | --- |
| square (primary) | 1080 × 1080 | feeds, the detail page default |
| landscape | 1200 × 675 | link previews |
| portrait | 1080 × 1350 | stories |

## Eligibility and generation

- Only a **VERIFIED** payload with an identity gets a graphic (`SG.eligible`), at or above `graphics.min_label`
  (Notable by default, `sc_config.graphics`).
- The worker asks `sc_graphics_due(template_version)`. Due means: there is no graphic at this template version for
  the current version, or an operator asked to regenerate. It draws each due version in Chromium in all three
  formats, from the **stored payload** (the graphic's `payload_sha256` must equal the version's).
- Every drawing is inspected with real font metrics (`SG.check`): no text outside the canvas or wider than its box,
  nothing under 9 px. Pixels are sampled to confirm the backdrop, the header and the RESEARCH NOT PICKS pill were painted. A graphic that fails is stored as FAILED, never
  served.
- Content is immutable once stored. A change of design is a new template version, which makes every current
  version due again.

## Revision and invalidation

| Event | What happens to the graphic |
| --- | --- |
| The signal gets a new version | Earlier graphics become **OUTDATED**; the new version's are drawn on the next run |
| The signal is invalidated or withdrawn | Its graphics become **WITHDRAWN** |
| An operator withdraws one graphic | That graphic becomes WITHDRAWN |
| Any of the above on an APPROVED graphic | The approval becomes **REVOKED** at the same moment |

An earlier graphic stays viewable on the detail page under *Earlier graphics*, stamped across the image:

- `OUTDATED · A NEWER VERSION OF THIS SIGNAL EXISTS`
- `WITHDRAWN · NOT CURRENT RESEARCH`
- `CONTROLLED TEST INPUT · NOT A REAL EVENT` (a fixture, never published)
- `EXAMPLE FROM PUBLISHED HISTORY · NOT CURRENT RESEARCH` (the free page's examples, events that passed ≥ 72 h ago)

## Approval for external publication

`/admin/signals/` → Review → Graphic → **Approve for external publication** records `APPROVED`, the operator and the
time, plus an audit event. It is a record that a person checked this exact graphic. **Nothing reads it to post.**
EdgeDesk has no configured, authorized publishing workflow for X, Discord or any other service, and none was added.
Download PNG (and Share, where the device offers it) is the only way a graphic leaves EdgeDesk, and a person does
it.

## Checking them

```powershell
node tools/signal_center/graphics.test.js      # layouts at every format: geometry, copy rule, long names, every template
node tools/signal_center/graphics.e2e.js       # drawn in Chromium, re-measured, pixels sampled
node tools/signal_center/render_graphics.js --out .cache/signal_center/gfx   # every eligible signal now, with inspection.json
```
