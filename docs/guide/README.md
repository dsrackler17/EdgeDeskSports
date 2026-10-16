# Learn EdgeDesk — the introduction, walkthroughs, Help and term explainers

A first-time visitor should be able to use EdgeDesk without anyone explaining
it to them. This layer does that inside the product, on the real screens, and
it never claims more than the numbers do: research, not picks.

| File | What it is |
|---|---|
| `lib/edgedesk_guide_content.js` | Every word: the introduction, the tasks, each walkthrough's steps, the glossary. Data only. |
| `lib/edgedesk_guide.js` | The engine: when the introduction opens, the walkthrough ring and card, Help, the term explainer, what is remembered. |
| `lib/edgedesk_guide.css` | The app's own tokens and shapes. |
| `tools/guide/guide.test.js` | The copy rules, the selectors, the state rules, the wiring. No browser. `npm run guide:test` |
| `tools/guide/guide_ui.e2e.js` | Desktop and a 390 px phone in Chromium. `npm run guide:e2e` |

## Where a reader finds it

- **First visit.** A short introduction in the welcome overlay (`#welHost`) offers *Show me around* and *Explore on my own*. It replaces the old conceptual welcome; `welOpen()` now opens this one, and the old one runs only if the guide failed to load.
  - *Show me around* asks **What would you like to do?** and lists the tasks this build supports.
  - *Explore on my own*, the ×, Escape or a click on the backdrop dismiss it, and a short note points at Help.
- **Help, any time.** These all open the same panel:
  - the **?** button in the header (labelled *Help* from 760 px, on every screen and on phones);
  - *Learn EdgeDesk* in the account menu;
  - More → Account → *Learn EdgeDesk*.

  The panel has four parts:
  - **On this page:** the walkthrough for the current screen and the terms used on it.
  - **Learn a task:** the other walkthroughs.
  - **Terms & numbers:** a searchable glossary.
  - **Start over:** replay the introduction, or open *How EdgeDesk works*.
- **Terms where they appear.** The following open a short explainer on click, tap or Enter. Each explainer says what the term is, how to use it, and what it cannot tell you.
  - Every decision-layer label (`tip()` in `lib/edgedesk_decision_ui.js`, now carrying `data-ed-tip="<key>"`).
  - Every label marked `data-ed-term="<id>"`:
    - football research cells (`fbTermAttr` in `app.html`);
    - the props filters and drawer;
    - game details;
    - Portfolio's CLV figures;
    - Model performance's *Outcome* / *Price quality*.

## The walkthroughs

Each walkthrough covers one task in 4–5 steps. Every step shows *Step n of m*, Back, Next and Skip, and the arrow keys also move between steps.

| Task | Screen | What it teaches |
|---|---|---|
| Research a game | Research → Today's Games | The strip and sport chips, other days, a game's ⓘ details and readiness, opening its research (the reader may press **Research** themselves), what the research shows. |
| Understand the research numbers | A football game's decision card | BET / LEAN / WATCH / PASS / NO DECISION, EdgeDesk's line against consensus, market state (no fresh price means no EV and no edge), the Beginner / Research / Lab levels, the reasoning and what would change it. |
| Explore player props | Research → Props | The league tabs, the data-freshness line, Best Value / All Props, filters, opening a prop. |
| Read today's Card | Card | The counts, the top of the card, filters, bankroll and units, opening a decision. |
| Track your bets | Portfolio | Adding a position, the tabs, *Tracked from EdgeDesk* (graded against the close), then Process. |

## Real conditions

- **Loading.** A step waits for its control. While it waits, the card says *Loading this screen…*.
- **Missing data.** If the control never appears, the step says why and offers the next useful action. For example:
  - The football engine is down: *No game decision is on screen*, plus a link to the glossary.
  - Props have no captured prices: no EV to rank and no edge to claim.
  - The schedule failed: a failed read is not an empty day.
  - Portfolio is signed out or unreachable.

  Known empty and error states are matched from the screen itself (`adapt`).
- **A started game** opens its stored pregame brief. The step says so.
- **Navigating away.** If the reader leaves the screen, the card says *You've moved to another screen* and offers **Go back**.
- **Restricted access.** Access is all or nothing behind the paywall (`#payGate`). Behind it:
  - the introduction never opens;
  - no walkthrough or Help panel starts;
  - a walkthrough already running when the paywall appears ends quietly.
- **Other dialogs.**
  - The introduction waits while any of these is open, or while the reader is typing: Setup, the six-step onboarding, the Card's own explainer, AI, a stored brief.
  - Those first-run layers in turn ask `EDGuide.busy()`, so nothing stacks on a walkthrough.
  - Finishing the Card walkthrough stands in for the Card's four-page explainer, which stays one tap away (*How to read this card*).
- **Nothing is blocked.** The ring takes no pointer events, so the highlighted control always works.
  - The card sits beside its target on a desktop. On a phone it docks above the navigation, and the target is scrolled above it.
  - Re-rendered boards (`innerHTML`) are followed: targets are resolved again on every frame.
- **Accessibility.**
  - The introduction and Help are labelled modal dialogs that keep Tab inside and return focus on close.
  - Each step moves focus to its heading.
  - Escape ends whatever is open.
  - Terms become keyboard buttons (`role="button"`, `aria-haspopup="dialog"`).
  - `prefers-reduced-motion` stops the ring's glide and the Help button's pulse, and scrolling is instant.

## What is remembered

- **On the device:** `edgedesk_guide_v1` = `{ intro: done|dismissed, tours: { id: done|skipped }, helpSeen }`.
  - It follows the `edgedesk_*` convention, so sign-out and a different account clear it with everything else.
- **On the account:** `user_metadata.edgedesk_guide` = `{ intro, at, done[] }`.
  - It is written through `edAuthPut`, as the display name is. It is written once per change and best effort.
  - It means signing out, or a new device, does not start the introduction over.

When is the introduction due (`introDue`)?

- **Yes:** on a first visit.
- **No:** once it has been answered, either on the device or on the account.
- **No:** for an existing reader who already dismissed the old welcome. The Help button carries a small dot until they open it once.
- **New accounts:** an account under 14 days old still gets it, even though `lib/edgedesk_first_run.js` pre-sets the old welcome key.

## Adding a walkthrough or a term

1. Write the steps in `TOURS` in `lib/edgedesk_guide_content.js`. Each step needs:
   - a `target`: a selector, a list of selectors, `card:<selector>` inside the open decision card, or a named target;
   - the `page` it lives on;
   - how to `go` there;
   - a `title` and `body`;
   - optionally `adapt`, `missing`, `terms` and `clickNext`.

   Keep it to five steps or fewer, and add its id to `TASKS` and `PAGE_TOURS`.
2. For a term, add an entry to `GLOSSARY` with `ask`, `short`, `what`, `use`, `limits` and `where`. To make a label open it, mark the label `data-ed-term="<id>"` in its renderer.
3. Run `npm run guide:test`. It checks that:
   - every id, class and attribute in a step's selectors exists in `app.html` or a renderer;
   - every chip and marker names a real entry;
   - the copy never promises a result.

   Then run `npm run guide:e2e`.
