# Runbook — rolling the research layer back

Every piece added in Slice 1 is additive and independently reversible.

| to undo | do this | effect |
|---|---|---|
| the structured answer, the critic and the packet in the prompt | set `EDGEDESK_STRUCTURED_ANSWER=0` on the function (no redeploy) | r11 behaviour: four-section Desk read, no label, no critic; the panel renders nothing for the absent `structured` field |
| the tool loop | `EDGEDESK_TOOL_LOOP=0` (the default) | one model call, no tools |
| the decision layer | `EDGEDESK_DECISIONS_ENABLED=0` | no recommendation; packets label RESEARCH LEAD / INSUFFICIENT DATA |
| the function build | `supabase functions deploy edgedesk_ai` from the previous commit (`git checkout <sha> -- supabase/functions/edgedesk_ai/index.ts`) | the browser tolerates a response without `structured`, `research_packet` or `critic` |
| the panel | republish the previous `app.html` (revert the commit; GitHub Pages ships on merge) | the function's additive fields are ignored |
| the prediction ledger | `drop view public.research_packet_calibration; drop view public.research_packet_grades; drop table public.research_packets cascade;` | answers unaffected; the function's write fails and is reported in `?probe=1 → packet_health`; nothing else depends on it |
| everything | `git revert` the Slice 1 commits; run `node tools/presentation/inline.js` | `_research.js`, the tests, the migration and the docs are new files; the `index.ts` and `app.html` edits are additive |

**Not reversible:** rows already written to `research_packets`. Deletion is
blocked by a trigger; dropping the table is the deliberate database action
above.

**Verify after a rollback:** `GET ?probe=1` → `build`,
`research_kernel.structured_answer`; `POST ?dry=1` with a CFB question →
`research_packet` null when the layer is off; `npm run intel:test` green on
the checkout you deployed.
