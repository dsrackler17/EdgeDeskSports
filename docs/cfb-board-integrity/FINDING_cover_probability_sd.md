# Finding — "the cover probability implies an outcome SD near 8 points for some rows"

**Status: investigated, not changed.** The cover-probability math, the champion's
distribution, σ, calibration and EV are frozen under the research protocol. This is
evidence only. **Conclusion:** on the evidence below, an ~8-point implied SD is **not**
a property of the model's distribution. It is what you get when a cover probability
priced at one line is read against the gap to another line, which is the Market /
Best-price mismatch (bug 2 in [`AUDIT.md`](AUDIT.md)). Re-measure after that fix. If a
row still implies < ~11 at the **same** line, away from the 3/7 key numbers, that
would be a model question and belongs outside this task.

## What the model actually uses

| Layer | Evidence | Width |
|---|---|---|
| V1 per-game σ (`football/cfb_p4/params.js` `volatility`) | `sigma_base 14.633`, `sigma_floor 14.633`, `sigma_ceiling 15.684`; `uncertainty.volatility` clamps to `[floor, ceiling]` (`football/cfb_p4/engine.js:1165-1195`) | σ ∈ **14.63 – 15.68** for every game |
| σ stored by the Model Lab, week 5–6 (`football/cfb_lab/ledger/2026/predictions/*.jsonl`) | V1 n=125: 14.79 – 15.07 · V2.1 n=177: 14.94 – 16.68 · V2.0 n=177: 14.99 – 16.68 | no row below 14.79 |
| The conditioned margin PMF (`distributions.margin_pmf_by_spread`, 181 buckets over spreads −45 … +45) | SD of each bucket computed directly | **14.2 – 17.1** across all 181 buckets |
| Re-centre + σ-stretch (`engine.js dist.coverProbSpread`, `lib/edgedesk_quote_ev.js cfbConditionedCover`) | Gaussian re-weighting by N(σ)/N(σ_base) of a 14–17-wide PMF | inside the σ clamp the result stays 14–18 wide; an 8-point result would need σ ≈ 8, which the clamp forbids |
| EV calibration (`football/cfb_ev/artifacts/cfb_ev_calibration_v1/calibration.json`) | spread close `temperature` T = 1,000,000; open T = 40.9 | **flattens** toward 50% at the anchor and then **shifts**; it never narrows |

## What the published rows imply

Research terminal, the 10 priced games of the 19:36 UTC build (`football/cfb_terminal/games.json`, implied SD = (fair distance to the priced line) / Φ⁻¹(cover)):

| Game | Fair | Priced | Cover | Distance (pts) | σ | Implied SD |
|---|---|---|---|---|---|---|
| Notre Dame @ North Carolina | ND −18.7 | UNC +21 −108 | 0.5697 | 2.31 | 15.05 | 13.2 |
| UCF @ Houston | HOU −8.7 | UCF +11.5 −105 | 0.5749 | 2.76 | 14.84 | 14.6 |
| California @ UNLV | UNLV −10.3 | UNLV −2.5 −115 | 0.7034 | 7.80 | 14.84 | 14.6 |
| Louisville @ NC State | NCST −0.2 | NCST +3.5 −108 | 0.6006 | 3.72 | 14.63 | 14.6 |
| Ohio State @ Iowa | OSU −7.7 | IOWA +14.5 −110 | 0.6663 | 6.81 | 14.84 | 15.8 |
| West Virginia @ Iowa State | ISU −8.9 | ISU −3.5 +100 | 0.6238 | 5.37 | 14.84 | 17.0 |
| Purdue @ Illinois | ILL −14.8 | ILL −10 −110 | 0.6089 | 4.83 | 14.85 | 17.5 |
| Army @ Louisiana Tech | ARMY −6.2 | ARMY −2.5 −105 | 0.5678 | 3.66 | 15.05 | 21.4 |
| Arkansas @ Texas A&M | TAMU −12.1 | ARK +14 −112 | 0.5687 | 1.89 | 14.85 | 10.9 * |
| Texas State @ San Diego State | TXST −5.2 | TXST −4.5 −110 | 0.4871 | 0.67 | 14.85 | n/m * |

\* Under 2 points from fair, a single-point implied SD is dominated by the PMF's shape
rather than its width: the integer re-centring and the key-number mass at 3 and 7
(`abs_margin_key_mass` 3 = 9.3 %, 7 = 8.5 %). The Texas State row even sits on the
wrong side of 50 % for that reason. That is the documented design ("real key-number
mass", `docs/cfb-terminal/AUDIT.md`), not a width.

Model Lab V2.1 / V2.0 cover probabilities go the other way: implied SDs of 65 – 16,000
points (n = 81 / 80). The market-anchored calibration pulls them toward 50 %, which
matches the documented "calibrated EV never reaches the policy minimum".

## How an ~8 appears

On the Pitt @ VT rows from the reproduction (`tools/football/cfb_board_repro_app.js`),
using the browser's own conditioned cover with fair VT −0.8 and σ 14.9:

| Read | Cover | Implied SD |
|---|---|---|
| Pitt +3.5, against its own distance (2.71) | 0.587 – 0.595 | **11.3 – 12.3** (key-number 3 inside the interval) |
| Pitt **+6.5** cover (the stale/alt point the "Best price" picked) read against the **−3.5** Market gap (2.71) | 0.654 – 0.665 | **6.3 – 6.8** |

A row that prints the Market gap from one quote and the cover probability from
another shows exactly the "SD near 8" pattern. The Step 2 fix makes Market, Best
price and the priced quote one snapshot, and that removes it.

## One observation for the model owners (not a fix, not in scope)

The two implementations of the conditioned cover key the PMF table differently:

- `engine.js dist.coverProbSpread` looks the bucket up by the **line being priced**
  (`key = line`), although its comment says "looked up by the market number".
- `edgedesk_quote_ev.js cfbConditionedCover` looks it up by the **market margin**.

At the main line they coincide. On alternate lines they borrow different buckets'
shapes. Every bucket is 14–17 wide, so this does not narrow anything, but the comment
and the code disagree.
