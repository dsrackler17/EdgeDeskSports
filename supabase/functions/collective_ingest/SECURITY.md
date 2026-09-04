# collective_ingest — who is allowed to post, and how that is enforced

Audited 2026-09-04 against `index.ts` at that date. This file records the
posture so it is not re-litigated from memory, and names the lines that would
have to change for it to stop being true.

---

## The property

**A key may only ever write to its own creator's model, whatever the body
claims.** That sentence is a comment in `index.ts` above the RPC call, and the
code around it holds it up.

Concretely: nobody can post as EdgeDesk without EdgeDesk's own submission key.
Not a customer with a valid key of their own, not a signed-in user, not
somebody reading `app.html` and calling the endpoint by hand.

## How

| step | where | what it does |
|---|---|---|
| every write route is behind auth | the router | `/v1/health` is the only route reachable without a key, and it is a liveness GET that writes nothing. `/v1/projections`, `/v1/projections/dry-run`, `/v1/projections/retract`, `/v1/me` and `/v1/market` all call `authenticate(req)` first. |
| the key must parse | `parseCollectiveKey` | `mck_live_` or `mck_test_` followed by 40 base62 characters. Anything else is refused before a database read. |
| the key must hash to a stored row | `authenticate` | sha256 of the full raw key, compared against `api_keys` filtered to `status=active` and the matching prefix bucket. |
| the comparison does not leak | `timingSafeEqual` | value- and position-independent. Every candidate row in the bucket is compared rather than breaking on the first match, so response time does not depend on which row matched. |
| failures do not distinguish | `authenticate` | "no such key" and "wrong secret" return the identical message. Telling them apart tells an attacker which half of a guess was right. |
| the creator must be active | `authenticate` | a creator whose `status` is anything but `active` gets 403. |
| **the model is pinned to the key** | `pickModel` + the envelope | the caller's models are loaded `creator_id=eq.<the key's creator>`. `pickModel` searches only that list, so naming another account's model is a 422. The envelope is then rebuilt as `{ ...body, model: model.slug, sport: model.sport_code }` — the two fields that decide whose record a slate lands on are **overwritten server-side** and cannot be spoofed from the body. |
| the RPC gets the resolved identity | `pKey` | `key_id`, `creator_id`, `model_id` and sport all come from the authenticated key, never from the request. |
| there is a per-key ceiling | `rate_check` | hourly, per key and endpoint. Deliberately fail-open with a logged error: a broken shield must not drop a creator's work. |

## What this does *not* do

- **It does not make the endpoint single-tenant.** Any active creator can post
  to *their own* models. That is the Model Collective working as designed —
  independent builders on one shared, graded record — not a gap.
- **It does not protect a leaked key.** A key is a bearer credential. If
  EdgeDesk's own key leaks, the holder can post as EdgeDesk until it is
  rotated (`rotate_key` takes `p_new_hash`).
- **It is not what hides the posting UI.** `edIsOwner()` in `app.html` decides
  what is *drawn*; it is a product-surface gate and says so. This file is what
  decides what is *accepted*. Neither substitutes for the other.

## What would break it

Changing any of these re-opens the question:

1. Reading `model` or `sport` from the request body instead of overwriting them.
2. Loading the caller's models without the `creator_id` filter.
3. Adding a route that writes before `authenticate(req)` returns.
4. Making `timingSafeEqual` an `===`, or breaking out of the candidate loop early.
5. Returning different errors for an unknown prefix and a wrong secret.

`tools/collective/app_sync.test.js` exercises the client half of this path.
The server half above is enforced by `index.ts` alone and has no test harness
in this repo — a deliberate gap to know about, not a claim of coverage.
