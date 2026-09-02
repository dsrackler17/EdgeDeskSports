# EdgeDesk presentation layer — deep engine, simple answer

Three layers over one deterministic engine:

| Layer | What | Where |
|---|---|---|
| 1 · 5-second view | verdict · selection · price · good-to · why · watch | Top edges strip, every receipt, AI panel answers, daily research headline |
| 2 · Full research | everything that already existed | behind **Full research** on the receipt; DEEP mode in the AI panel |
| 3 · Publisher brief | one-page, shareable snapshot | **Create brief** on any card, **Game brief** on football cards, presets on the Edges view and the Football overview |

## Ownership

`supabase/functions/edgedesk_ai/_presentation.js` is the canonical library. It is
inlined byte-for-byte into `index.ts`, `app.html` and `brief.html` between
`/*__EDPRES_START__*/ … /*__EDPRES_END__*/`. Edit the canonical file, then:

    node tools/presentation/inline.js        # sync the three hosts
    node tools/presentation/inline.js --check

The library never computes a probability, edge, price limit or verdict. It
translates the engine's fields (`EDAI.evidence` → `EDAI.packetOf`) and it
validates AI copy before a word of it reaches a card.

## Tests

    node tools/presentation/presentation_sync.test.js
    node tools/presentation/presentation.test.js
    node tools/presentation/edgedesk_ai.test.js      # the deployed function, under Node
    node tools/presentation/app_presentation.test.js

## Deploy / migrate

1. Paste `supabase/functions/edgedesk_ai/index.ts` into the `edgedesk_ai`
   function in the Supabase dashboard and deploy. `GET ?probe=1` should show
   `build: edgedesk_ai-2026-09-02-r4-presentation` and `presentation.library_loaded: true`.
2. Run `supabase/publisher_briefs.sql` in the SQL editor (share links need it;
   copy/print work without it).
3. Publish `app.html` and `brief.html` together.

## Manual checks

- **TNF / SNF / MNF**: Edges → Publisher desk → the button. The game is
  resolved from priced NFL rows by ET weekday and a 7 pm+ ET kickoff, falling
  back to the Football schedule. No priced market → an honest WAIT brief.
- **College Football**: Publisher desk → College Football brief. Top decisions
  (max 3 BETs, never padded) or All actionable games. Zero BETs → NO QUALIFYING BETS
  with the strongest LEAN/WAIT/PASS research underneath.
- **Any game / edge**: Create brief on a card, or Game brief on a football card.
- **Writer actions**: Copy for CMS (rich HTML + plain text), Copy plain text,
  Print / Save PDF, Share brief (snapshot + `brief.html?s=<slug>`), Refresh
  from current data (a new version; the old link is unchanged), Polish copy
  (PUBLISHER mode through edgedesk_ai, validated).
