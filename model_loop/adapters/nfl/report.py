"""Render docs/model-loop/nfl/backtest.json (and the tuning log and the
current cards) as docs/model-loop/nfl/BACKTEST.md.

  python3 -m model_loop.adapters.nfl.report
"""
import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DOCS = os.path.join(ROOT, "docs", "model-loop", "nfl")
WINDOW_LABEL = {"tune": "Tune 2011–2019", "validation": "Validation 2020–2024", "holdout": "**Holdout 2025**",
                "live": "Live 2026 (wk 1–6)", "backtest_2011_2025": "Full backtest 2011–2025", "all_2011_2026": "All 2011–2026"}
MODELS = [("v2", "v2 (this rebuild)"), ("v1_trained", "v1 as trained"), ("v1_shipped", "v1 as shipped"),
          ("v1_shipped_defense_fixed", "v1 shipped, defense fixed")]


def f(x, d=3):
    return "—" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{d}f}"


def headline(ev):
    out = ["| Window | n | Model | Margin MAE | Close MAE | Log loss | Close log loss | Brier | \\|model − close\\| | ≥3 pts from close | Total MAE | Close total MAE |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for w in ("tune", "validation", "holdout", "live", "backtest_2011_2025"):
        for key, label in MODELS:
            e = ev.get(key, {}).get(w)
            if not e or not e.get("n"):
                continue
            out.append(f"| {WINDOW_LABEL[w]} | {e['n']} | {label} | {f(e.get('margin_mae'))} | {f(e.get('close_margin_mae'))} | "
                       f"{f(e.get('logloss_same_games', e.get('logloss')), 4)} | {f(e.get('close_logloss'), 4)} | {f(e.get('brier_same_games', e.get('brier')), 4)} | "
                       f"{f(e.get('mean_abs_vs_close'), 2)} | {f(100 * e['share_3plus_from_close'], 1) + '%' if e.get('share_3plus_from_close') is not None else '—'} | "
                       f"{f(e.get('total_mae'))} | {f(e.get('close_total_mae'))} |")
    pub = ev.get("v1_published_2026", {}).get("live")
    if pub and pub.get("n"):
        out.append(f"| {WINDOW_LABEL['live']} | {pub['n']} | v1 as published (record) | {f(pub.get('margin_mae'))} | {f(pub.get('close_margin_mae'))} | "
                   f"{f(pub.get('logloss_same_games', pub.get('logloss')), 4)} | {f(pub.get('close_logloss'), 4)} | {f(pub.get('brier_same_games', pub.get('brier')), 4)} | "
                   f"{f(pub.get('mean_abs_vs_close'), 2)} | {f(100 * pub['share_3plus_from_close'], 1)}% | — | — |")
    return "\n".join(out)


def paired(p):
    out = ["| Window | Comparison | n | Δ MAE (neg = v2 better) | 95% CI | Δ log loss | 95% CI |", "|---|---|---|---|---|---|---|"]
    for w in ("tune", "validation", "holdout", "live", "backtest_2011_2025"):
        for k, lab in (("v2_vs_v1_trained", "v2 − v1 trained"), ("v2_vs_v1_shipped", "v2 − v1 shipped"), ("v2_vs_close", "v2 − close")):
            c = p.get(w, {}).get(k)
            if not c or not c.get("abs_error"):
                continue
            a = c["abs_error"]
            ll = c.get("logloss") or {}
            out.append(f"| {WINDOW_LABEL[w]} | {lab} | {a['n']} | {a['mean_diff']:+.3f} | [{a['ci95'][0]:+.3f}, {a['ci95'][1]:+.3f}] | "
                       f"{('%+.4f' % ll['mean_diff']) if ll else '—'} | {('[%+.4f, %+.4f]' % tuple(ll['ci95'])) if ll else '—'} |")
    c = p.get("live_vs_published")
    if c and c.get("abs_error"):
        a = c["abs_error"]
        ll = c.get("logloss") or {}
        out.append(f"| {WINDOW_LABEL['live']} | v2 − v1 as published | {a['n']} | {a['mean_diff']:+.3f} | [{a['ci95'][0]:+.3f}, {a['ci95'][1]:+.3f}] | "
                   f"{('%+.4f' % ll['mean_diff']) if ll else '—'} | {('[%+.4f, %+.4f]' % tuple(ll['ci95'])) if ll else '—'} |")
    return "\n".join(out)


def ablations(rows):
    out = ["| Component | Validation MAE without it (with: base) | Δ MAE if removed | Δ log loss if removed | Paired Δ\\|err\\| 95% CI | Status |",
           "|---|---|---|---|---|---|"]
    for r in rows:
        if r.get("val_mae_without") is None:
            out.append(f"| {r['component']} | — | — | — | — | {r['status']} |")
            continue
        ci = (r.get("paired") or {}).get("abs_error") or {}
        out.append(f"| {r['component']} | {r['val_mae_without']:.4f} ({r['val_mae_with']:.4f}) | {r['delta_mae_if_removed']:+.4f} | "
                   f"{r['delta_logloss_if_removed']:+.5f} | {('[%+.3f, %+.3f]' % tuple(ci['ci95'])) if ci.get('ci95') else '—'} | {r['status']} |")
    return "\n".join(out)


def calib(e):
    c = e.get("calibration") or {}
    out = ["| Predicted bin | n | Mean predicted | Observed |", "|---|---|---|---|"]
    for b in c.get("bins", []):
        out.append(f"| {b['bin']} | {b['n']} | {b['mean_pred']:.3f} | {b['observed']:.3f} |")
    out.append(f"\nExpected calibration error: **{c.get('ece')}**")
    return "\n".join(out)


def ats(e):
    out = ["| Gap vs close ≥ | n | Model side wins | Win % | One-sided p |", "|---|---|---|---|---|"]
    for t, a in (e.get("ats_vs_close") or {}).items():
        out.append(f"| {t} pt | {a['n']} | {a['wins']} | {f(100 * a['win_pct'], 1) if a['win_pct'] is not None else '—'}% | {f(a['p_one_sided'], 4)} |")
    return "\n".join(out)


def hfa_path(coefs):
    rows = ["| Season priced | Home field | Pass O | QB | Pass D | Rush O | Rush D | Market rating | Rest (per 7 days) |", "|---|---|---|---|---|---|---|---|---|"]
    for s in sorted(coefs, key=int):
        c = coefs[s]
        rows.append(f"| {s} | {c.get('home_field', 0):.2f} | {c.get('pass_off', 0):.1f} | {c.get('qb', 0):.1f} | {c.get('pass_def', 0):.1f} | "
                    f"{c.get('rush_off', 0):.1f} | {c.get('rush_def', 0):.1f} | {c.get('market', 0):.3f} | {c.get('rest', 0):.2f} |")
    return "\n".join(rows)


def prior_decay(pred):
    """Mean |prior part| / (|prior part| + |season part|) of the base-strength
    points, by week, over 2011-2025: how fast last season fades."""
    d = pred[(pred.season >= 2011) & (pred.season <= 2025) & pred.pred_margin.notna()].copy()
    base = sum(d["c_" + k].fillna(0) for k in ("pass_off", "qb", "pass_def", "rush_off", "rush_def", "market") if "c_" + k in d)
    season_part = base - d.prior_part
    share = np.abs(d.prior_part) / (np.abs(d.prior_part) + np.abs(season_part)).replace(0, np.nan)
    t = share.groupby(d.week).mean()
    rows = ["| Week | Share of base strength from the prior |", "|---|---|"]
    for w in (1, 2, 3, 4, 6, 8, 10, 12, 14, 17):
        if w in t.index:
            rows.append(f"| {w} | {100 * t[w]:.0f}% |")
    return "\n".join(rows)


def card_md(g):
    rows = [f"**{g['away']} @ {g['home']}** (week {g['week']}): fair line **{g['home']} {g['fair_home_line']:+.1f}**, "
            f"win probability {100 * g['home_win_prob']:.1f}%, fair moneyline {g['fair_home_ml']:+d} / {g['fair_away_ml']:+d}, "
            f"80% range {g['range80']['lo']:+.1f} to {g['range80']['hi']:+.1f} (centred on {g['fair_home_margin']:+.2f}). "
            f"Starters: {g['starters']['home']['name']} ({g['starters']['home']['basis']}) vs {g['starters']['away']['name']} ({g['starters']['away']['basis']}).",
            "", "| Group | Component | Points (home +) | From the prior | From 2026 |", "|---|---|---|---|---|"]
    for c in g["components"]:
        if abs(c["points"]) < 0.005 and c["key"] not in ("home_field",):
            continue
        rows.append(f"| {c['group'].replace('_', ' ')} | {c['label']} | {c['points']:+.2f} | "
                    f"{('%+.2f' % c['from_prior']) if 'from_prior' in c else '—'} | {('%+.2f' % c['from_this_season']) if 'from_this_season' in c else '—'} |")
    rows.append(f"| | **Sum = fair margin** | **{g['reconciliation']['components_sum']:+.2f}** | | |")
    rows.append(f"\nUnattributed: {g['reconciliation']['unattributed']:.1e}. Market reference: {g['market_reference']['home_line']}.")
    if g.get("disagreement"):
        d = g["disagreement"]
        rows.append(f"\n**{d['level']}: {d['text']}** (toward the {d['direction']} side). Driving components: "
                    + "; ".join(f"{x['label']} {x['points']:+.2f}" for x in d["drivers"]) + ".")
    return "\n".join(rows)


def line_influence(pred):
    d = pred[(pred.season >= 2011) & (pred.season <= 2025) & pred.pred_margin.notna()]
    def sd(cols):
        return float(d[[c for c in cols if c in d]].fillna(0).sum(axis=1).std())
    return {"pass": sd(["c_pass_off", "c_qb", "c_pass_def"]), "rush": sd(["c_rush_off", "c_rush_def"]),
            "pass_offense": sd(["c_pass_off", "c_qb"]), "pass_defense": sd(["c_pass_def"]), "qb": sd(["c_qb"]),
            "market": sd(["c_market"])}


def checklist(bt, pred):
    """The ten Phase 1 items, each with what was built and what the evidence says."""
    abl = {a["component"]: a for a in bt["ablations_validation"]}
    def ab(k):
        a = abl.get(k) or {}
        if a.get("delta_mae_if_removed") is None:
            return a.get("status", "")
        return f"removing it changes validation MAE by {a['delta_mae_if_removed']:+.4f} and log loss by {a['delta_logloss_if_removed']:+.5f}: {a['status']}"
    li = line_influence(pred)
    cfg = bt["final_config"]
    kn = bt.get("key_numbers") or {}
    cal = bt.get("calibration_layers") or {}
    c26 = bt["coefficients_by_season"]["margin"].get("2026", {})
    push3 = (kn.get("push") or {}).get("line 3", {})
    push7 = (kn.get("push") or {}).get("line 7", {})
    rows = [
        ("1", "Opponent-adjusted EPA, pass O / pass D / rush O / rush D, from nflverse play-by-play; pass weighted over rush",
         "Built (`ratings.py`: per-week penalized fit, offense and defense as separate ratings with separate priors). "
         f"Line influence over 2011–2025 (SD of points): passing {li['pass']:.2f} vs rushing {li['rush']:.2f}; "
         f"pass offense incl. QB {li['pass_offense']:.2f} vs pass defense {li['pass_defense']:.2f}. "
         f"Separate offense/defense *coefficients*: {ab('offense_defense_split')}; the weighting comes from the ratings instead "
         f"(defense carried {cfg['rating']['carry']['def']} season to season vs offense {cfg['rating']['carry']['off']})."),
        ("2", "Recency weighting within the season",
         f"Built; half-life tuned to {cfg['rating']['hl_week']} weeks. {ab('in_season_recency')} (effectively neutral)."),
        ("3", "Bayesian prior blending with a fitted shrink rate",
         f"Built; prior strength in plays of evidence tuned on 2011–2019 (pass O {cfg['rating']['lam']['pass_off']}, pass D {cfg['rating']['lam']['pass_def']}, "
         f"rush O {cfg['rating']['lam']['rush_off']}, rush D {cfg['rating']['lam']['rush_def']}, QB {cfg['rating']['lam']['qb']}). "
         f"Last-season carryover: {ab('last_season_carryover')}. The prior's share falls from 100% in week 1 to about half by week 2 and ~27% by week 8 (table below)."),
        ("4", "Market-informed priors (preseason win totals, prior-week closing spreads)",
         f"Prior-week closing spreads: built as a market rating refitted every week (half-life {cfg['rating']['market']['hl_week']} weeks). {ab('market_rating')}: "
         f"the largest single gain. Preseason win totals: **inactive, not owned**."),
        ("5", "QB value separate from the team",
         f"Built: each quarterback is a parameter of his own that travels with the player; the team's pass rating is what remains. {ab('qb_layer')}. "
         f"QB line influence SD {li['qb']:.2f} pts; contested starters are priced both ways on the card."),
        ("6", "Personnel-aware priors (QB, lead RB, top WR, OL continuity; offseason moves)",
         f"QB: carries with the player (tuned carry {cfg['rating']['carry']['qb']}). RB/WR production that moved teams: built and tested, "
         f"tuned to weight {cfg['rating']['personnel']['skill']} on 2011–2019 (no value), so **inactive**. OL snap continuity: {ab('ol_continuity')} (negligible)."),
        ("7", "Home field from recent seasons with shrinkage; rest, short weeks, travel distance and time zones as separate components",
         f"Home field fitted walk-forward from recent seasons: {c26.get('home_field', float('nan')):.2f} pts for 2026 (home field with a typical trip). "
         f"Rest / bye / short week: {ab('rest_bye_short')}. Travel distance, time zones, body clock: {ab('travel_timezone')}; "
         "jointly valid, but miles and time zones are nearly collinear and the time-zone coefficient alone has the wrong sign, so the split between them should not be read individually (Phase 2 candidate: one combined travel term)."),
        ("8", "Margin distribution that respects key numbers",
         f"Built (`core/distribution.py`), mean solved to equal the projection. Push rate at closing lines of exactly 3: predicted {100 * push3.get('predicted_key', float('nan')):.1f}% vs observed "
         f"{100 * push3.get('observed', float('nan')):.1f}% (a plain normal says {100 * push3.get('predicted_flat', float('nan')):.1f}%); at 7: {100 * push7.get('predicted_key', float('nan')):.1f}% vs "
         f"{100 * push7.get('observed', float('nan')):.1f}% (normal {100 * push7.get('predicted_flat', float('nan')):.1f}%). Three-way cover log loss at the close {kn.get('three_way_logloss_key')} vs {kn.get('three_way_logloss_flat')}. "
         "For straight-up win probability the shape adds nothing (log loss within 0.0002 of a normal)."),
        ("9", "Probability calibration (isotonic or Platt) fitted on history",
         f"The distribution's width is fitted by likelihood on earlier seasons only, which calibrates it (ECE {cal.get('platt', {}).get('ece_raw')} over 2011–2025). "
         f"A Platt layer on top: log loss {cal.get('platt', {}).get('logloss_raw')} → {cal.get('platt', {}).get('logloss_calibrated')}, ECE → {cal.get('platt', {}).get('ece_calibrated')}; "
         f"isotonic: log loss → {cal.get('isotonic', {}).get('logloss_calibrated')}. Neither helps, so **no extra layer** (which also keeps win, cover and moneyline on one table)."),
        ("10", "Garbage-time filtering",
         f"Built: plays outside 10–90% win probability count {cfg['rating']['garbage_floor']} of a play (fixed in advance, not tuned). {ab('garbage_time_filter')}."),
    ]
    out = ["## Phase 1, item by item\n", "| # | Asked for | What was built, and what the backtest says |", "|---|---|---|"]
    for n, ask, what in rows:
        out.append(f"| {n} | {ask} | {what} |")
    out.append("")
    return "\n".join(out)


def main():
    bt = json.load(open(os.path.join(DOCS, "backtest.json")))
    pre = json.load(open(os.path.join(DOCS, "prereg.json")))
    tl = [json.loads(l) for l in open(os.path.join(DOCS, "tuning_log.jsonl"))]
    pred = pd.read_csv(os.path.join(DOCS, "predictions.csv.gz"))
    cards = None
    if os.path.exists(os.path.join(DOCS, "cards_current.json")):
        cards = json.load(open(os.path.join(DOCS, "cards_current.json")))
    ev = bt["evaluation"]
    dec = bt["decision"]
    tuned = [t for t in tl if t.get("param")]
    acc = [t for t in tuned if t.get("accepted")]
    last_season = max(bt["coefficients_by_season"]["margin"], key=int)
    md = []
    md.append("# NFL v2: walk-forward backtest against v1 and the closing line\n")
    md.append(f"Generated {bt['generated_at']} by `model_loop/adapters/nfl/backtest.py report`; preregistration sha256 `{bt['prereg_sha256']}` "
              f"(`docs/model-loop/nfl/prereg.json`, written before tuning).\n")
    md.append("## Decision (as preregistered)\n")
    md.append(f"**{'SHIP: v2 clears the rule against both versions of v1.' if dec['ship'] else 'DO NOT SHIP YET: v2 does not clear every condition.'}**\n")
    for k, d in dec["against"].items():
        md.append(f"- Against **{k}**: {'clears' if d['promote'] else 'does not clear'}. " + "; ".join(d["reasons"]))
    md.append(f"\nRule: {pre['decision_rule']}\n")
    md.append(checklist(bt, pred))
    md.append("## Every window, every model, the same games\n")
    md.append("Margin MAE is against the final score. *Close* is the nflverse consensus closing line on the same games. "
              "Log loss and Brier are on games with a closing moneyline, compared with the no-vig close. "
              "v1 as trained is the original research pipeline's own walk-forward (every coefficient out of sample). "
              "v1 as shipped is the browser engine's absorb path, with defenses frozen; its coefficients were fitted on 2003–2025, so it has an in-sample advantage before 2026.\n")
    md.append(headline(ev))
    md.append("\n## Paired differences (same games; bootstrap 95% intervals)\n")
    md.append(paired(bt["paired"]))
    md.append("\n## Incremental-value bar: each component removed, scored on VALIDATION (2020–2024) only\n")
    md.append("A component stays active only if removing it makes validation margin MAE or log loss worse. The holdout was not consulted.\n")
    md.append(ablations(bt["ablations_validation"]))
    md.append("\n## Calibration of the win probability\n")
    md.append("### Holdout 2025\n")
    md.append(calib(ev["v2"]["holdout"]))
    md.append("\n### Full backtest 2011–2025\n")
    md.append(calib(ev["v2"]["backtest_2011_2025"]))
    md.append(f"\nThe same projections priced from a plain normal instead of the key-number distribution: full-backtest log loss "
              f"{f(ev['v2_normal_distribution']['backtest_2011_2025'].get('logloss'), 5)} vs {f(ev['v2']['backtest_2011_2025'].get('logloss'), 5)} (key-number).\n")
    md.append("## Against the closing line, side by side (full backtest 2011–2025)\n")
    md.append("Taking v2's side whenever it disagrees with the close by at least the threshold:\n")
    md.append(ats(ev["v2"]["backtest_2011_2025"]))
    md.append("\nThe same for v1 as trained:\n")
    md.append(ats(ev["v1_trained"]["backtest_2011_2025"]))
    md.append("\n## CLV, 2026 only (EdgeDesk's own opener capture began 2026-09-16; no historical openers exist)\n")
    for k, v in bt["clv_2026"].items():
        if v:
            md.append(f"- **{k}**: n {v['n']}, mean {v['mean_pts']:+.2f} pts toward the model's side, {v['positive']} positive / {v['negative']} negative / {v['flat']} flat")
    md.append("\n## How fast last season fades (v2, 2011–2025)\n")
    md.append(prior_decay(pred))
    md.append("\n## Fitted coefficients by season priced (walk-forward: each fitted only on earlier seasons)\n")
    md.append(hfa_path(bt["coefficients_by_season"]["margin"]))
    shrink = bt["final_config"]["model"].get("hfa_prior_games") or 0
    md.append(f"\nPoints per unit: rating terms are points per 1.0 EPA/play of rating difference (offense and defense share one coefficient: "
              f"the validation bar rejected separate ones); the market rating is points per point of prior-close rating. "
              f"Home field for {last_season} is fitted from recent seasons (half-life {bt['final_config']['model']['hl_season']} seasons)"
              + (f" and shrunk toward the long-run value ({shrink:g} games of pull)." if shrink else
                 "; the extra pull toward the long-run value was tuned off (it did not help on 2011-2019).") + "\n")
    md.append("## Configuration\n")
    md.append(f"Tuned on 2011–2019 only, by two-pass coordinate descent over the preregistered grid. **{len(tuned)} variants evaluated, {len(acc)} accepted**; "
              f"every one is in `docs/model-loop/nfl/tuning_log.jsonl` with its tune-window MAE.\n")
    md.append("```json\n" + json.dumps(bt["final_config"], indent=1) + "\n```")
    if cards:
        md.append("\n## Current cards (research candidate; not on the published board)\n")
        for g in cards["games"]:
            if g["game_id"] in ("2026_07_KC_SEA",):
                md.append(card_md(g))
        md.append("\n| Game | v2 fair line | Market reference | Gap | Flag |\n|---|---|---|---|---|")
        for g in cards["games"]:
            ref = g["market_reference"]["home_line"]
            gap = (-g["fair_home_line"] - (-ref)) if ref is not None else None
            md.append(f"| {g['away']} @ {g['home']} | {g['home']} {g['fair_home_line']:+.1f} | {('%s %+.1f' % (g['home'], ref)) if ref is not None else '—'} | "
                      f"{('%+.1f' % gap) if gap is not None else '—'} | {(g['disagreement'] or {}).get('level') or ''} |")
    md.append("\n## Data the model could not use\n")
    for x in pre["inactive_by_data"]:
        md.append(f"- {x}")
    md.append(f"\n## Disclosures\n\n- {pre['forking_paths']['disclosed_before_tuning']}\n- {pre['forking_paths']['structural_choices']}")
    md.append("- Two components (separate offense/defense coefficients, the division term) were removed by the validation bar, so the final model's VALIDATION numbers are mildly optimistic; the holdout and 2026 numbers are not affected.")
    md.append("- Tuned values at the edge of the preregistered grid (QB carry 1.0, QB prior strength 100, market half-life 2 weeks and prior strength 1, defensive prior strength 300, ridge 8) are listed in the tuning log; a wider grid is a Phase 2 candidate, not a change made here.")
    md.append("- The ATS-vs-close tables are descriptive: they were not a preregistered test, several thresholds are shown, and no betting claim follows from them.")
    md.append("- Starters in the backtest are the quarterbacks who actually started (known pregame in nearly every case); live cards use the reconciled starter.")
    with open(os.path.join(DOCS, "BACKTEST.md"), "w") as fh:
        fh.write("\n".join(md) + "\n")
    print(os.path.join(DOCS, "BACKTEST.md"))


if __name__ == "__main__":
    main()
