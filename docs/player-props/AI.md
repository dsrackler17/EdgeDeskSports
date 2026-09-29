# Player Props — the AI Research Desk (`football/props/desk.js`)

`propsTurn()` in `supabase/functions/edgedesk_ai/index.ts` runs before the desk
and the research pipeline, for desk and chat clients alike. It answers
player-prop questions **deterministically from the committed files**:

- `players_index.json`
- `board.json`
- `games/<id>.json`
- `markets/<id>.json`

It goes through `EDProps.prepare`, the function the board and the drawer run,
so the desk says what the board says.

| Intent | Example |
|---|---|
| PROP | "Should I bet Puka Nacua over 78.5 receiving yards?" · "Research Davante Adams receiving yards over 63.5 +120 at DraftKings" |
| COMPARE | "Is Bijan 71.5 -110 or 74.5 +105 better?" (both priced on one distribution) |
| PLAYER | "What does EdgeDesk project for Jalen Hurts?" |
| BOARD | "Best player props today?" (ranked by risk-adjusted EV, plus a watch list) |
| INJURY | "How does Nacua being out affect Adams?" (the redistribution plan) |
| UNMODELED | "How many tackles will …?" (said to be unmodeled, never estimated) |

A player the board does not carry, a prop EdgeDesk does not project, a missing or
stale price, or a surname that fits two players is each said plainly, never
filled in.

A model may rephrase the answer only when `EDGEDESK_PROPS_NARRATE=1`, and only
through `EDPROPSDESK.critic`. The critic rejects:

- any number that is not in the deterministic answer;
- "lock", "best bet", "safe bet" and "guaranteed";
- outcomes stated as certain.

A question that names no player and no prop falls through untouched.
`tools/props/props_desk.test.js` runs the kernel and the real handler.
