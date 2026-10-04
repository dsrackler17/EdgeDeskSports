# CFB product audit (September 27, 2026)

What a reader could see, where it lived, and what was hidden, duplicated,
confusing, badly prioritised or inaccessible — read from the code and the
committed artifacts, before any change. Line numbers are `app.html` at the
audited commit (`139a4b1`).

## 1. What existed

| Surface | Where | What it showed |
|---|---|---|
| **Power 4 / FBS board** | `app.html` `fbRenderBoard` → `fbP4Render` | one row per game, live-priced in the browser by `EDCfbP4.projectGame`; statuses from `fbP4StatusFor` (9 labels, `FBP4_STATUSES`); sorts: Kickoff (default), **Largest gap**, Conference, Status |
| **Game card** | `fbP4Card` (l. 56681) | the research summary (`fbGxSummary`) then **25 collapsible sections**: forensic packet, why EdgeDesk leans, projection status, what changed?, best available line, programs & FBS rating, the research read, V2 shadow, fair-line decomposition, venue & forecast, why EdgeDesk prices it here, why this number could be wrong, personnel, quarterbacks, the case for each side, model vs market, price & break-even, data quality by category, scenarios, explain this research, follow · what changed, model & market detail, **model scores (10 chips)**, EdgeDesk rating, data quality & methodology |
| **Research labels** | `lib/cfb_research_view.js` | 9 labels (LIMITED DATA … MARKET ALIGNED) |
| **Integrity gate** | `lib/cfb_disagreement.js` | VERIFIED / INVESTIGATE / DATA FAULT / MARKET FAULT for 7+ gaps |
| **Decision engine** | `football/cfb_decision/decision.js` | BET / LEAN / RESEARCH / PASS / NO_BET per quote, price targets — **shadow only**, validated for V2.1 |
| **Model Lab** | `football/cfb_lab`, `admin/cfb-lab` | hourly checkpoints of V1/V2.1/V2.0, settlement, reports — **admin only** |
| **AI desk** | `supabase/functions/edgedesk_ai` | research packets with their own labels (PASS / RESEARCH LEAD / PRICE DEPENDENT / MODEL DISAGREEMENT / STALE MARKET / INSUFFICIENT DATA); the CFB **explanation boundary** `_cfb_explain.js` existed but was **not wired** into `index.ts` |
| **Record** | `record.html`, `record/football/cfb_2026.json` | the published pregame number vs close and final: 104-125-2 ATS (n=229 decided), CLV −0.15 pts (n=71) |
| **Collective** | `collective/` | user models' picks, graded; never a model input |
| **Watchlist / alerts** | `lib/edgedesk_personal*.js` | star, research-condition alerts, decision journal (Supabase) |

## 2. Findings

**Hidden (valuable, not shown to a reader)**
- V2.1's component models (ridge `C_ridge`, boosted matchup `D_gbm`) and the V2.0 five-submodel candidate — only in the Lab.
- The champion's perturbation SDs per input (rating home/away, home field) — only inside reliability penalty text.
- The champion's empirical margin PMF with real key-number mass (`abs_margin_key_mass`: 3 = 9.3%, 7 = 8.5% of FBS games) — engine-internal.
- The decision policy's reality: betting disabled, calibrated EV −3.2% at every price — in `docs/cfb-decision` only.
- The measured QB starter-change effect (−1.16 pts, n=1,567) — V2.1 params only.
- Typical college open-to-close movement (~1.6 pts) — validation file only.
- The record's own sub-samples (reliability buckets, gap buckets) — summary.json only.

**Duplicated**
- Three "why" views: *Why EdgeDesk leans*, *Why EdgeDesk prices it here*, *Fair-line decomposition*.
- Three "change" views: *Projection status*, *What changed?*, *Follow · what changed*.
- Three data-quality views: *Data quality by category*, *Data quality and methodology*, reliability.
- Three model-vs-market views: *The research read*, *Model vs market*, *Model and market detail*.

**Confusing**
- About 25 status words across four vocabularies on one card: the board chip (9), the research label (9), the decision words (5), the legacy edge tag ("research lean · unproven · historically X%"), plus projection statuses (8).
- The app board prints **RESEARCH** for any priced gap under 7 points — including 0.1.
- Ten unlabelled 0-100 "model scores" beside the line; the volatility index is documented by its own engine as not discriminating between games.

**Poorly prioritised**
- A "Largest gap" sort — the gaps the forensic replay says are most often data problems.
- Price, break-even and the bettable number were collapsed near the bottom; no price curve, no pass-beyond.

**Inaccessible to normal users**
- The Model Lab, the decision engine's verdict and the operations health (CRITICAL: the V2.1 weekly engine has not run this season).

**Valuable but badly explained**
- Confidence vs reliability vs input coverage vs priced coverage (five denominators).
- Sigma and the volatility index.

## 3. What changed because of the audit

- One canonical research page per game (`research/cfb/`), built from cached objects; the app card links to it with the canonical status.
- Seven status words, one function (`T.status`), a legacy map, and the LLM boundary taught the same seven.
- The ten-chip *Model scores* panel and the legacy edge tag were removed from the card (the data-completeness line moved into *Data quality and methodology*).
- The hidden items above are now first-class sections: component models and agreement, sensitivity from the champion's own SDs, the key-number PMF in the price curve, the policy's reality in *why not bet*, the QB effect in sensitivity and reconciliation, movement context in timing, record sub-samples as historical context.
- Default ordering is the research queue; raw gap is a secondary sort.
