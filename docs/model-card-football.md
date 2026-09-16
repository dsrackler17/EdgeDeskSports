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
  rating's own confidence and gates, which since Slice 2 ride in the packet
  (`ratings.<side>.confidence`, `ratings.<side>.gates`) from
  `football/matchup/metrics.json`; no interval is published on the CFB
  projection itself.
- **Matchup drivers (Slice 2):** the packet's `drivers` are the rankings
  build's opponent-adjusted unit pairs (`EDINTEL.matchupDrivers`, both
  directions, top four each), each with raw, adjusted and league values, the
  sample, a reliability, the side favoured and its source and time. They
  explain the rating; they are not a second model and produce no number.
- **Known gaps stated in every packet:** availability UNKNOWN for every
  programme (0 official reports); weather only where the venue build
  published a forecast row; travel not computed; coordinator turnover
  unmeasured.
- **Label ceiling:** a CFB spread disagreement alone produces RESEARCH LEAD
  or MODEL DISAGREEMENT, never PRICE DEPENDENT; PRICE DEPENDENT requires the
  kernel's market-anchored BET CANDIDATE.

## NFL — `edgedesk_football_v1.0.0` (feature version `nfl_fv1`, trained through 2025)

- **Output quoted:** home line, home margin, fair total, home win
  probability, the p10/p50/p90 home-margin range (`outcome_range`), and the
  engine's per-feature contributions. Since Slice 2 they are published in
  `football/nfl/slate.json` by `tools/football/build_nfl_slate.js`, which
  boots the same football module `app.html` runs, in Node, over the same
  nflverse feeds; the artifact and the browser agree by construction and the
  desk quotes the artifact verbatim.
- **Validation (walk-forward 2016–2025, hyperparameters frozen on ≤2015,
  carried in the artifact's `engine.validation` and attached to every NFL
  packet):** spread MAE 10.2 against the closing market's 9.78; against the
  close the model wins 48.9% at 1+ points of disagreement (n = 1,962) and
  50.8% at 3+ (n = 870); totals 50.8% at 1+ (n = 2,017) and 51.7% at 3+
  (n = 940). No band is significant.
- **Consequence in the desk:** tier RESEARCH — `may_produce_probability`
  and `may_produce_model_ev` are false, `max_decision` is WATCH. An NFL
  packet can reach RESEARCH LEAD or MODEL DISAGREEMENT on the projection
  alone and PRICE DEPENDENT only through a captured price the kernel
  accepts; it never produces an EV from the model's win probability.
- **Availability:** the official league report (nflverse) is attached per
  club with practice status; a side with a report is `OFFICIAL_REPORT`, and
  players not listed are not on the report rather than healthy. The
  schedule feed's named starter is carried with `confirmed: false`.
- **Known gaps stated in every packet:** no forecast (the forecast artifact
  is keyed by college game id), no play profile or coaching record for NFL
  clubs, no captured NFL price outside the season's capture window.

## Nearby-line sensitivity and scenarios (Slice 3)

- **Cover / push / lose at nearby lines** come from the model's own
  residual distribution around its own projection (the registered college
  pmf, sigma 14.9; the NFL build's spread-conditioned cover curve, sigma
  10.7). They are labelled MODEL_CONDITIONAL for both football spreads
  because the validation record forbids a probability there, and they feed
  no expected value. The probability the price requires is arithmetic on
  the price alone. "Likely to cover if the model is right" and "worth
  betting at this price" are stated as different questions.
- **Scenarios** re-run the validated engine with one input changed (the
  NFL build publishes starter-out, short-week, dome and cold-wind re-runs
  per game) and are labelled CONDITIONAL ESTIMATE; where no engine input
  exists (a college quarterback change, protection, pace) the scenario is
  QUALITATIVE and estimates nothing. The baseline projection is unchanged.
- **Interactions** explain the number; `in_model` says what the rating
  already prices, and a measured advantage the rating includes is not
  counted twice.

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
