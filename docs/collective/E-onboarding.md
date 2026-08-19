# E. ONBOARDING SPECIFICATION

Purpose: the screen by screen specification of the invite-link join flow (`/join/{token}` to `collective/join.html`), measured against the Section 6 friction budget. This document states the required field count explicitly, names what was cut to stay inside the budget, and specifies every failure page. Binding references: CONTRACT.md sections 4.2 (invite_tokens, creators, models, api_keys), 5.4 (collective_join), API-SHAPES.md (`/v1/join/{token}`, `/v1/join/{token}/redeem`).

---

## 1. The friction budget, restated as pass or fail tests

| Budget item | Limit | This design | Status |
|---|---|---|---|
| Screens from link click to credentials | 3 max | 3 | PASS |
| Required fields across the whole flow | 8 max | 5 | PASS |
| Time for someone who knows their model name | under 90 seconds | roughly 60 seconds, narrated in section 6 | PASS |
| Decisions requiring product knowledge | 0 | 0 | PASS |

**Required field count, stated explicitly: 5 of the 8 allowed.**

1. Email (screen 1)
2. Display name (screen 2, prefilled from token when the invite carried it)
3. Sport (screen 2, prefilled, a single select defaulting to NFL in v1)
4. Model name (screen 2, prefilled when the invite carried it)
5. Terms checkbox (screen 2, one checkbox with a link, per Section 6)

Nothing on screen 3 is a field. Optional fields (description, website, X handle, logo URL) do not count against the budget and are visually labeled `optional` inline.

## 2. What was cut to stay inside the budget

Each of these was considered and deliberately removed from signup. Cutting fields, not adding tooltips, per Section 6.

- **Billing mode question.** Everyone lands in Mode A (`billing_mode='referral'`, `referral_share_bps` from the token or the 4000 default). Mode B is a later dashboard and admin conversation. Asking a new creator to choose between referral and wholesale is the definition of a decision requiring product knowledge.
- **Payout details.** No Stripe Connect, no bank info, no tax form. `payout_accounts.status` starts `unstarted` and Connect is requested only after the first successful live submission (CONTRACT 4.2). Asking a stranger for banking information before they have seen the product working is how you lose them.
- **Methodology, model description, or anything resembling an application.** The invite is the vetting. Description is optional and skippable.
- **Logo upload.** Replaced by an optional logo URL field plus an automatic monogram. An upload widget means file pickers, size limits, crop UIs, and storage plumbing on the critical path. The monogram (first letters of display name words, max 2 chars, rendered by the UI, see F-ui.md) makes every profile look intentional with zero input. A creator who wants a real logo pastes a URL now or later from the dashboard.
- **Additional sports and models.** One sport, one model at signup. More are added later from the dashboard (`models` table supports many per creator). Asking for a list at signup turns one field into a repeating form.
- **Password, password confirmation, captcha.** Magic link only. The invite token itself is the abuse gate (single use or usage capped, 30 day expiry), so no captcha is needed.
- **Username or slug choice.** The slug is generated server side by `redeem_invite` from the display name, disambiguated on collision. Nobody stares at a "that name is taken" error during signup.

## 3. Screen 1: account

Route: `edgedesksports.com/join/{token}` (via the `404.html` shim) which loads `collective/join.html?t={token}`.

On load, before rendering the form, the page calls `GET /v1/join/{token}`:

- `status: "valid"`: render screen 1, and if `founding` is true show a single quiet badge line: `Founding member invite. 50 percent referral share, locked for life.`
- `status: "expired"` or `"spent"` (HTTP 410): render the friendly page in section 7. Never a raw error.
- Network failure or 404 `token_invalid`: render the friendly page variant for an unrecognized link.

Fields and controls:

| Element | Type | Required |
|---|---|---|
| Email | one text input | yes (field 1 of 5) |
| Send my sign-in link | one button | |

Copy above the field: `You are invited to the Model Collective.` plus the prefilled display name from the token if present (`Invite for {display_name}`), so the person knows the link is really for them.

Behavior: the button calls `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: <current join URL including ?t=> } })`. The page then shows one line: `Check your email. The link brings you straight back here.` The magic link returns to the same URL with a session; the page detects the session and advances to screen 2 automatically. If the visitor already has a live Supabase session (an existing EdgeDesk account), screen 1 shows `Continue as {email}` with a one-click continue button and a small `use a different email` link; an existing account gaining a creator record is supported per CONTRACT decision 3.

No password. No confirmation field. No captcha. One field, one button.

## 4. Screen 2: profile and model

Rendered only with a valid session and a valid token. Every prefillable field arrives filled from the token's `prefill` (`display_name`, `sport`, `model_name`); a fully prefilled screen 2 is three already-filled inputs plus one checkbox.

Required (fields 2 through 5):

| Field | Control | Prefill | Validation |
|---|---|---|---|
| Display name | text | token `display_name` | 2 to 40 chars |
| Sport | select, options from `/v1/meta` sports | token `sport`, default NFL | must be an active sport |
| Model name | text | token `model_name` | 2 to 60 chars |
| Terms | one checkbox with a link to the terms text | unchecked | must be checked |

The terms line, verbatim: `I agree to the Collective terms. Submissions are timestamped and become part of the permanent public record, and grading is done by the Collective against its own closing lines.` The word `terms` links to the full text. This is the one and only legal touchpoint, per Section 6.

Optional, each labeled `optional` inline, never blocking:

| Field | Control | Note under the field |
|---|---|---|
| Description | textarea, 280 char cap | `One or two lines about your model. You can write this later.` |
| Website | text (URL) | `No website? Your Collective profile is your site. This is it.` |
| X handle | text, `@` stripped server side | |
| Logo URL | text (URL) | `Leave blank and we generate a clean monogram for you.` |

One button: `Create my profile`. It posts `POST /v1/join/{token}/redeem` with the Bearer JWT and the body from API-SHAPES.md (`display_name, sport, model_name, description?, website_url?, x_handle?, logo_url?, accept_terms: true`). On 200, advance to screen 3 rendered entirely from the redeem response. Redeem is idempotent per user plus token, so a double click or a refresh cannot create duplicates.

Validation errors render inline next to the field, the rest of the form stays filled, nothing resets.

## 5. Screen 3: connect

Zero inputs. Everything on this screen came back in the redeem response and is already created: creator row, model row, slug, key. Three copy blocks, each with one copy button, in this order:

1. **Your API key.** The full `mck_live_...` key in a mono block. Line under it, verbatim: `This is shown once. Treat it like a password. If you lose it, generate a new one from your dashboard, the old one stops working.` Source: `api_key.key`, `shown_once: true`.
2. **Your Claude prompt.** Collapsed preview (first lines visible) with `Copy the whole prompt` as the primary button. Line above it, verbatim: `Paste this into Claude in your own project. It connects your model to the Collective without you touching any code.` Source: `prompt` (rendered per I-claude-integration.md, key already inlined).
3. **Your Collective tab.** The one-line script tag. Line above it, verbatim: `Add this one line to your site to give your audience the Collective tab. Optional, you can do it any time.` Source: `embed_snippet`.

Below the three blocks, the what happens next line, verbatim: `You are live on the Model Wall right now as a MEMBER. Your first submission flips you to ACTIVE CONTRIBUTOR automatically.` Then two links: `View your profile` (`creator.profile_url`) and `Open your dashboard` (`dashboard_url`).

If `founding` is true, one extra line: `Founding member: your 50 percent referral share is locked for the life of your membership.`

The key is never shown again after this screen. Navigating away and returning shows the dashboard path instead (rotate to get a new key). The prompt and the embed snippet are re-downloadable from the dashboard forever; only the key is show-once.

## 6. The under 90 seconds path, narrated

For a creator whose invite carried prefill and who knows their model name:

- 0s: clicks `/join/{token}`. Screen 1 loads with their name on it. Types email, clicks the button. (10s)
- 10s to 35s: opens their inbox, clicks the magic link. Lands back on the join page with a session, screen 2 appears. (25s, dominated by email delivery)
- 35s to 55s: screen 2 is already filled with display name, sport, model name from the token. They glance, maybe fix a spelling, tick the terms box, click `Create my profile`. (20s)
- 55s to 60s: redeem returns, screen 3 renders. Credentials are in hand. (5s)

Total: roughly 60 seconds, with 25 of them being email latency. Copying the key and prompt happens after the budget clock stops because credentials are already in hand at screen 3 load. Worst realistic case (slow email, no prefill) still lands near 90 because screen 2 is four short inputs and a checkbox.

Click count for the proof required by Phase 5 done criteria: 5 clicks (send link, magic link in email, terms checkbox, create profile, one copy button), 5 required fields.

## 7. Token failure pages, friendly by specification

All three render inside the same join page shell, styled like the rest of the flow, never a bare error code.

**Expired** (`token_expired`, 410): headline `This invite has expired.` Body: `Invites last 30 days and this one is past that. Ask for a fresh one and you will be in within two minutes.` Form: email plus optional note, one button `Request a new invite`, posting `POST /v1/join/request`. Always answers 200 and renders: `Done. A new invite goes out to {email} once it is approved.`

**Spent** (`token_spent`, 410): headline `This invite has already been used.` Body: `If that was you, you are already a member: sign in to your dashboard. If someone shared this link with you, request your own below.` A `Go to my dashboard` link, then the same request form as the expired page.

**Unrecognized** (`token_invalid`, 404): headline `This link is not a valid invite.` Body: `Check that the whole link was copied. If it keeps failing, request an invite below.` Same request form.

The request form is fire and forget on the server (writes an admin notification row) and always succeeds from the visitor's point of view.

## 8. What happens automatically after redeem, no founder action

Per Section 6 and enforced by the `redeem_invite` RPC in one transaction:

- Auth account linked (`creators.user_id`), creator record, model record, slug, and live API key all created.
- The profile appears on the Model Wall immediately with derived status MEMBER (the wall view has no manual gate, insertion is appearance).
- Status flips to ACTIVE CONTRIBUTOR on the first live resolved submission, by the derived rule in the `membership_status` view (rule 8.8), never by a flag anyone flips.
- Founding member terms applied from the token when present: `founding_member=true`, `referral_share_bps=5000`, stored on the creator row so the rate travels with them.
- Token `use_count` incremented; at `max_uses` the token is spent.
- Attribution and earnings rows exist from day one (billing inert per rule 8.13); the dashboard earnings panel shows the not-live note from API-SHAPES.md.

## 9. Deliberate exclusions, restated as design commitments

These are not omissions to fix later. They are commitments, and any future change to them reopens the friction budget math:

- Billing mode is never asked at signup. Mode A is the universal default.
- Payout and banking details are never requested before the first successful live submission.
- No methodology questions, no application, no review queue. The invite is the approval.
- Terms are one checkbox with a link, nothing more.
- No password exists anywhere in the flow.
- The empty profile is a feature: a zero-submission creator has a complete, intentional, screenshot-worthy profile page from the second redeem returns (spec in H-creator-profile.md section 6). That page is what they post, and posting it is the growth loop.
