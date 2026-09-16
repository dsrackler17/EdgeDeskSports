# Model card — EdgeDesk football projections as the desk quotes them

This card describes what the research desk is allowed to say about the
football projections it quotes. The models themselves are documented with
their training code (`football/research/`, `football/cfb_p4/README.md`,
`football/rankings/README.md`); this is the desk's contract with them.

## CFB — `edgedesk_cfb_p4` (feature version `cfb_p4_fv1`, trained through 2025)

- **Output quoted:** home line (betting convention, negative = home
  favoured), home margin, fair total, home win probability, engine data
  completeness, input contract. Published per game in
  `football/fbs/slate.json` by the weekly build; the desk carries them
  verbatim and never recomputes a number.
- **Validation (walk-forward, from `params.js → validation_summary.market`,
  transcribed into `EDINTEL.MODEL_VALIDATION` and pinned by
  `intelligence.test.js`):** against the closing spread the model wins 49.9%
  at 1+ points of disagreement (n = 2,599) and 46.4% at 6+ (n = 722); no
  band is significant and the win rate falls as the gap grows.
- **Consequence in the desk:** tier RESEARCH for spreads — the model may
  order research and be quoted as an estimate; it may not produce a
  probability or an expected value, and a model-led thesis is capped at
  WATCH. Totals are DIRECTIONAL (51.3% → 54.8%, p = 0.0155 at 6+). Moneyline
  is PROBABILITY (Brier 0.19016, n = 3,113) and experimental.
- **Uncertainty:** the artifact publishes a point estimate; the packet
  declares the missing p10/p90 interval with a reason. Widening for unstable
  quarterbacks, new coaches and thin samples is expressed through the
  rating's own confidence and gates (`football/rankings/current.json`), not
  yet through an interval on the projection — Slice 2 work.
- **Known gaps stated in every packet:** no per-play efficiency ingested
  server-side (the rankings artifact carries opponent-adjusted unit metrics
  the browser reads and the function does not yet), availability UNKNOWN for
  every programme (0 official reports), no weather server-side.
- **Label ceiling:** a CFB spread disagreement alone produces RESEARCH LEAD
  or MODEL DISAGREEMENT, never PRICE DEPENDENT; PRICE DEPENDENT requires the
  kernel's market-anchored BET CANDIDATE.

## NFL — `edgedesk_football` (browser-side)

- The NFL projection (fair spread, fair total, projected score, win
  probability, outcome range) is computed in `app.html` from nflverse
  data and the trained `football/params.js`. **The edge function has no
  server-side NFL projection**; its NFL slate comes from `public.games` with
  no model line. A packet for an NFL game therefore carries the model as
  missing with the reason, and the label is at most RESEARCH LEAD or
  INSUFFICIENT DATA. Publishing `football/nfl/slate.json` from a Node build
  is the Slice 2 step that changes this.

## Rules the desk enforces for every model

1. The model's number is never altered by the writing model; it is quoted
   from the packet or not at all (critic: `NUMBER_NOT_IN_EVIDENCE`).
2. Expected value is computed only from an explicit probability whose source
   is named (`comparison.edge_at_price.probability_source`).
3. The validation tier travels with every quoted number.
4. Every packet is snapshotted before kickoff (`research_packets`), so
   calibration by model version can be computed from what was actually said.
5. Promotion of a new model version is a code change to the artifacts and to
   `EDINTEL.MODEL_VALIDATION`, gated by `intelligence.test.js`, reviewed by a
   person. No production path retrains or edits a model.
