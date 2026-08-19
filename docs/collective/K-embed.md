# K. Embed and Collective Tab Specification

Purpose: the complete contract for `collective/embed.js`, the one-file script that renders the full Model Collective inside any member's site as their Collective tab. This document covers the script tag contract, the shadow DOM boundary, the origin allowlist flow, caching, the failure state catalog with exact copy, the free versus gated split, and the identical-render rule. The embed and the Collective site read the same public API shapes (API-SHAPES.md); if the site can do something the embed cannot, the split is wrong.

---

## 1. Script contract

The entire integration is one tag. No build step, no npm install, no framework requirement, no second file.

```html
<script src="https://edgedesksports.com/collective/embed.js"
        data-collective-host="moose" data-theme="dark" async></script>
```

Attributes:

| Attribute | Required | Values | Behavior |
|---|---|---|---|
| `data-collective-host` | yes | the creator's public slug | Identifies the host creator for pinning and attribution. Public information, safe in page source. Missing or malformed slug renders the static fallback (state F4 below). |
| `data-theme` | no | `dark` (default) or `light` | The only theming control. Any other value is ignored and dark is used. There is deliberately no color, font, layout, or ordering knob: theming limits are part of the identical-render rule. |
| `data-api` | no | an API base URL | Testing hook only, overrides `COLLECTIVE_CONFIG.API` so the embed can be pointed at a staging function. Documented for `embed-demo.html`; production snippets never include it. |
| `async` | recommended | | The script never blocks host page rendering. |

Mount point: the script mounts into `<div id="model-collective">` if the host page provides one, otherwise it mounts in place, where the script tag sits. Both patterns are shown in `collective/embed-demo.html`.

## 2. Shadow DOM boundary, both directions

The embed attaches a shadow root (`mode: 'open'`) on its mount node and renders everything inside it.

- Inward: the host page's CSS cannot reach the embed. All styles live in a `<style>` element inside the shadow root, keyed to the contract's design tokens. No inherited typography is relied on; font families, sizes, and colors are all set explicitly. Fonts fall back to system stacks so the embed needs no external font request to be legible.
- Outward: the embed injects zero global CSS, defines zero globals beyond its own IIFE, registers no service worker, and touches nothing outside its mount node. Its only persistent footprint is one namespaced localStorage key for the visitor id (`mc_visitor`).
- `mode: 'open'` is deliberate: hosts can inspect what renders (transparency is the product), they just cannot restyle or reorder it in a way that survives, because content and order come from the server payload (section 6).

## 3. Origin allowlist flow

1. Browser requests `GET /v1/embed/bootstrap?host={slug}&theme={theme}` and sends its `Origin` header (fallback: the `Referer` host).
2. `collective_embed` matches that origin against active rows in `collective.embed_installs` for the host creator. `edgedesksports.com` always passes; localhost passes while `embed.allow_localhost` is true.
3. Match: 200 with the payload, and `Access-Control-Allow-Origin` echoes the single matched origin, never `*`.
4. No match: 403 `forbidden_origin`, no data in the body. The embed then renders failure state F2 (section 5): the readable static panel with the wordmark and a link to the Collective site. It never retries in a loop (one retry after 10 seconds, then it stays static for the page lifetime).

There is no secret in the page. The slug is public; the allowlist row is the lock. A snippet lifted onto an unauthorized domain produces the fallback panel, which itself only advertises the Collective. Creators manage their origin list from the dashboard (`POST /v1/dashboard/origins`), so adding a new domain is self-service and takes effect on the next bootstrap.

## 4. Caching

- The bootstrap endpoint is one GET returning the entire render payload (wall, host pin, creators directory, settled highlights, locked upcoming, CTA URLs) so the embed makes exactly one data request per page view.
- The response carries `cache-control: public, max-age={embed.cache_seconds}` (seeded 60) and the same number in the body as `cache_seconds`. The URL is fully cacheable per `(host, theme)` pair: no cookies, no auth header on the free path, so it is CDN-friendly as is.
- The embed refreshes in place every `cache_seconds` while the tab is visible (visibility API; hidden tabs do not poll). A failed refresh keeps the last good render on screen, silently.
- Event posts (`POST /v1/embed/events`) are batched, fire-and-forget, flushed on an interval and on `visibilitychange`, and never block or delay rendering.

## 5. Failure states catalog

Rule from the build prompt: the embed renders on somebody else's website, so it can never look broken there. Every failure resolves to a designed state. Exact copy below; this copy ships in `embed.js` and changing it is a contract change.

| State | Trigger | Render |
|---|---|---|
| F1 Loading | before first response, up to 6s | The panel frame with the wordmark and a dim single line: `Loading the Collective...`. No spinners, no skeleton shimmer. |
| F2 Unavailable | timeout at 6s, non-200, or network error | Static panel: the **MODEL COLLECTIVE** wordmark, the line `The Collective is unreachable right now. It has not gone anywhere.`, and the link `Open the Model Collective` to `BASE_URL/collective/`. |
| F3 Forbidden origin | 403 `forbidden_origin` | Same visual panel as F2 with the line `This site is not an authorized host for the Collective embed.` plus the same link out. No mention of the host slug, no hint usable for probing. |
| F4 Bad configuration | missing or invalid `data-collective-host` | Same panel as F2 with the line `The Collective embed is not configured. Check the data-collective-host attribute.` This one is aimed at the installing creator during setup. |
| F5 No JavaScript | script never runs | Nothing renders and nothing breaks: the script tag is inert by design. Hosts wanting a no-JS fallback place their own link inside `<div id="model-collective">`; the embed replaces that content when it mounts. Documented in the snippet instructions. |

All failure panels are fully styled inside the shadow root, respect `data-theme`, and are visually finished: a viewer should read them as an intentional notice, not an error.

## 6. Free versus gated, exactly

The split is enforced by the API payload, never by the embed hiding things. The embed for an anonymous viewer receives locked rows that contain no numbers, so there is nothing in the DOM to reveal.

Free, rendered in full for every viewer:

- The model wall: every listed model, membership status, verified record, coverage, last submission.
- Creator profile panels: bio, monogram or logo, and outbound links to the creator's own site and X handle. These always link out; the embed exports traffic on purpose.
- Verified records and rankings context.
- Settled results: final scores, closing lines, per-model graded rows, and settled consensus.

Gated (paid once billing is live):

- Pre-kickoff numbers: any projection for a game that has not kicked off.
- Upcoming consensus.

Gated rows render as a designed locked row (lock glyph, game label, kickoff time, model count, zero numeric values, because the payload has zero numeric values) with one subscribe CTA per gated section:

```
Subscribe for live numbers, $20/mo
```

linking to `subscribe_url` from the bootstrap payload, which is `BASE_URL/collective/?ref={host}#join`. The `ref` parameter carries first-touch attribution for the host creator, so a subscription that starts inside a member's tab credits that member. While `billing.enabled` is false the same rows carry `reason: "billing_not_live"` and the CTA reads `Live numbers arrive when billing opens` linking to the Collective site, so the embed is honest before money exists.

## 7. The identical-render rule and the single host privilege

The Collective renders identically on every site: same data, same order, same records, same grading, same locked set. Canonical order everywhere is membership rank, then graded games descending, then name (API-SHAPES.md). A host cannot hide a rival, filter a bad week, reorder rankings, or suppress a section, because:

- the embed has no attributes that select, filter, or sort content (section 1 is the complete attribute list), and
- the payload is built once by `collective_embed` in canonical order and only **annotated** for the host: the host's row is moved to index 0 and marked `"pinned": true`. That move plus a `HOST` badge on the pinned row is the entire host privilege, and it is applied server side inside the bootstrap builder. Nothing else in the payload varies by host slug. DOM surgery inside an open shadow root by a determined host is possible for their own visitors, but the served data, the record, and every other viewer's render are beyond their reach, which is what the guarantee actually promises: the numbers cannot be tuned per host.

The persistent link back is likewise non-optional: the panel header wordmark always links to `BASE_URL/collective/` (with `?ref={host}`), and it is part of the payload contract, not a host choice.

## 8. Proof page

`collective/embed-demo.html` is a plain HTML page styled unlike the Collective, standing in for a foreign origin. It carries the one script tag, demonstrates both mount patterns, and shows a rival creator's profile rendering and linking out from the host's page, which is Phase 6's definition of done. With `embed.allow_localhost` true it runs from a local file server against production or against `data-api` pointed at a test base.
