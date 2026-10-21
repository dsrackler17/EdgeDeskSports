"""Render docs/model-loop/cfb/backtest.json (and the tuning log and the
current cards) as docs/model-loop/cfb/BACKTEST.md.

  python3 -m model_loop.adapters.cfb.report
"""
import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DOCS = os.path.join(ROOT, "docs", "model-loop", "cfb")
WINDOW_LABEL = {"tune": "Tune 2014–2020", "validation": "Validation 2021–2024", "holdout": "**Holdout 2025**",
                "live": "Live 2026 (to date)", "backtest_2014_2025": "Full backtest 2014–2025", "all_2014_2026": "All 2014–2026"}
SLICE_LABEL = {"all": "All games with an FBS side", "fbs": "FBS vs FBS", "fcs": "FBS vs FCS / lower division"}
MODELS = [("v2", "v2 (model loop)"), ("cfb_p4", "cfb_p4 v1.0.1 (replay)")]


def f(x, d=3):
    return "—" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{d}f}"


def pct(x):
    return "—" if x is None else f"{100 * x:.1f}%"


def headline(ev, sl):
    out = ["| Window | n | Model | Margin MAE | Close MAE | Log loss | Close log loss | Brier | \\|model − close\\| | ≥3 pts from close | Total MAE | Close total MAE |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for w in ("tune", "validation", "holdout", "live", "backtest_2014_2025"):
        for key, label in MODELS:
            e = ev.get(key, {}).get(sl, {}).get(w)
            if not e or not e.get("n"):
                continue
            out.append(f"| {WINDOW_LABEL[w]} | {e['n']} | {label} | {f(e.get('margin_mae'))} | {f(e.get('close_margin_mae'))} | "
                       f"{f(e.get('logloss_same_games', e.get('logloss')), 4)} | {f(e.get('close_logloss'), 4)} | {f(e.get('brier_same_games', e.get('brier')), 4)} | "
                       f"{f(e.get('mean_abs_vs_close'), 2)} | {pct(e.get('share_3plus_from_close'))} | {f(e.get('total_mae'))} | {f(e.get('close_total_mae'))} |")
    pub = ev.get("cfb_p4_published_2026", {}).get(sl, {}).get("live")
    if pub and pub.get("n"):
        out.append(f"| {WINDOW_LABEL['live']} | {pub['n']} | cfb_p4 as published (record) | {f(pub.get('margin_mae'))} | {f(pub.get('close_margin_mae'))} | "
                   f"{f(pub.get('logloss_same_games', pub.get('logloss')), 4)} | {f(pub.get('close_logloss'), 4)} | {f(pub.get('brier_same_games', pub.get('brier')), 4)} | "
                   f"{f(pub.get('mean_abs_vs_close'), 2)} | {pct(pub.get('share_3plus_from_close'))} | {f(pub.get('total_mae'))} | {f(pub.get('close_total_mae'))} |")
    return "\n".join(out)


def summary_table(ev):
    """The one table: v2 vs cfb_p4 vs close, every window, each slice."""
    out = ["| Slice | Window | n | v2 MAE | cfb_p4 MAE | Close MAE | v2 log loss | cfb_p4 log loss | Close log loss |",
           "|---|---|---|---|---|---|---|---|---|"]
    for sl in ("all", "fbs", "fcs"):
        for w in ("tune", "validation", "holdout", "live", "backtest_2014_2025"):
            a = ev["v2"][sl].get(w) or {}
            b = ev["cfb_p4"][sl].get(w) or {}
            if not a.get("n"):
                continue
            out.append(f"| {SLICE_LABEL[sl]} | {WINDOW_LABEL[w]} | {a['n']} | {f(a.get('margin_mae'))} | {f(b.get('margin_mae'))} | "
                       f"{f(a.get('close_margin_mae'))} | {f(a.get('logloss_same_games', a.get('logloss')), 4)} | "
                       f"{f(b.get('logloss_same_games', b.get('logloss')), 4)} | {f(a.get('close_logloss'), 4)} |")
    return "\n".join(out)


def paired(p):
    out = ["| Slice | Window | Comparison | n | Δ MAE (neg = first better) | 95% CI | Δ log loss | 95% CI |", "|---|---|---|---|---|---|---|---|"]
    for sl in ("all", "fbs", "fcs"):
        for w in ("tune", "validation", "holdout", "live", "backtest_2014_2025"):
            for k, lab in (("v2_vs_cfb_p4", "v2 − cfb_p4"), ("v2_vs_close", "v2 − close"), ("cfb_p4_vs_close", "cfb_p4 − close")):
                c = p.get(sl, {}).get(w, {}).get(k)
                if not c or not c.get("abs_error"):
                    continue
                a = c["abs_error"]
                ll = c.get("logloss") or {}
                out.append(f"| {SLICE_LABEL[sl]} | {WINDOW_LABEL[w]} | {lab} | {a['n']} | {a['mean_diff']:+.3f} | [{a['ci95'][0]:+.3f}, {a['ci95'][1]:+.3f}] | "
                           f"{('%+.4f' % ll['mean_diff']) if ll else '—'} | {('[%+.4f, %+.4f]' % tuple(ll['ci95'])) if ll else '—'} |")
        c = p.get(sl, {}).get("live_vs_published")
        if c and c.get("abs_error"):
            a = c["abs_error"]
            out.append(f"| {SLICE_LABEL[sl]} | {WINDOW_LABEL['live']} | v2 − cfb_p4 as published | {a['n']} | {a['mean_diff']:+.3f} | "
                       f"[{a['ci95'][0]:+.3f}, {a['ci95'][1]:+.3f}] | — | — |")
    return "\n".join(out)


def ablations(rows):
    out = ["| Component | Validation MAE without it (with) | Δ MAE if removed | Δ log loss if removed | FBS: MAE with → without | FCS: MAE with → without | Paired Δ\\|err\\| 95% CI | Status |",
           "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if r.get("val_mae_without") is None:
            out.append(f"| {r['component']} | — | — | — | — | — | — | {r['status']} |")
            continue
        ci = (r.get("paired") or {}).get("abs_error") or {}
        bs = r.get("by_slice") or {}
        sl = lambda k: (f"{bs[k]['mae_with']:.3f} → {bs[k]['mae_without']:.3f}" if k in bs else "—")
        out.append(f"| {r['component']} | {r['val_mae_without']:.4f} ({r['val_mae_with']:.4f}) | {r['delta_mae_if_removed']:+.4f} | "
                   f"{r['delta_logloss_if_removed']:+.5f} | {sl('fbs')} | {sl('fcs')} | {('[%+.3f, %+.3f]' % tuple(ci['ci95'])) if ci.get('ci95') else '—'} | {r['status']} |")
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


def coef_table(coefs):
    rows = ["| Season priced | Home field | 2020 no-crowd | Pass O | QB | Pass D | Rush O | Rush D | Market | Lower-division row | Rest (per 7 days) | Bye |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in sorted(coefs, key=int):
        c = coefs[s]
        g = lambda k, d=1: f"{c[k]:.{d}f}" if k in c else "—"
        rows.append(f"| {s} | {g('home_field', 2)} | {g('covid_2020', 2)} | {g('pass_off')} | {g('qb')} | {g('pass_def')} | {g('rush_off')} | "
                    f"{g('rush_def')} | {g('market', 3)} | {g('division', 2)} | {g('rest', 2)} | {g('bye', 2)} |")
    return "\n".join(rows)


def line_influence(pred):
    d = pred[(pred.season >= 2014) & (pred.season <= 2025) & pred.pred_margin.notna()]
    def sd(cols):
        return float(d[[c for c in cols if c in d]].fillna(0).sum(axis=1).std())
    return {"pass": sd(["c_pass_off", "c_qb", "c_pass_def"]), "rush": sd(["c_rush_off", "c_rush_def"]),
            "pass_offense": sd(["c_pass_off", "c_qb"]), "pass_defense": sd(["c_pass_def"]), "qb": sd(["c_qb"]),
            "market": sd(["c_market"]), "division": sd(["c_division"])}


def card_md(g):
    rows = [f"**{g['away']} @ {g['home']}** (week {g['week']}): fair line **{g['home']} {g['fair_home_line']:+.1f}**, "
            f"win probability {100 * g['home_win_prob']:.1f}%, fair moneyline {g['fair_home_ml']:+d} / {g['fair_away_ml']:+d}, "
            f"80% range {g['range80']['lo']:+.1f} to {g['range80']['hi']:+.1f} (centred on {g['fair_home_margin']:+.2f}). "
            f"Quarterbacks priced: {g['starters']['home']['name']} ({g['starters']['home']['basis']}) vs "
            f"{g['starters']['away']['name']} ({g['starters']['away']['basis']}).",
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


def checklist(bt, pred):
    abl = {a["component"]: a for a in bt["ablations_validation"]}
    def ab(k):
        a = abl.get(k) or {}
        if a.get("delta_mae_if_removed") is None:
            return a.get("status", "")
        return (f"removing it changes validation MAE by {a['delta_mae_if_removed']:+.4f} and log loss by "
                f"{a['delta_logloss_if_removed']:+.5f}: **{a['status']}**")
    li = line_influence(pred)
    cfg = bt["final_config"]
    r = cfg["rating"]
    kn = bt.get("key_numbers") or {}
    cal = bt.get("calibration_layers") or {}
    last = max(bt["coefficients_by_season"]["margin"], key=int)
    c26 = bt["coefficients_by_season"]["margin"].get(last, {})
    push = kn.get("push") or {}
    fade = bt.get("prior_fade") or {}
    dist = (bt.get("distribution_by_season") or {}).get(last) or {}
    items = [
        ("Opponent-adjusted EPA ratings: pass O / pass D / rush O / rush D, per-week penalized fit with priors",
         "Built (`ratings.py`, core `penalized_wls`): a fit before every slate on that season's plays only. "
         f"Line influence over 2014–2025 (SD of points): passing {li['pass']:.2f} (offense incl. QB {li['pass_offense']:.2f}, defense "
         f"{li['pass_defense']:.2f}) vs rushing {li['rush']:.2f}; market rating {li['market']:.2f}. Separate offense/defense coefficients: {ab('offense_defense_split')}."),
        ("Garbage-time weight", f"Plays with naive win probability outside 10–90% count {r['garbage_floor']} of a play (fixed, not tuned; "
         f"the naive model reads no spread). {ab('garbage_time_filter')}."),
        ("Recency half-life", (f"Tuned to {r['hl_week']} slates. " if r["hl_week"] else
                               "Tuned off on 2014–2020: every earlier week of the season counts equally (the grid offered 3, 6 and 12 "
                               "slates); last season fades through the prior strengths instead. ") + f"{ab('in_season_recency')}."),
        ("Separate prior strengths for offense and defense",
         f"Tuned on 2014–2020, in plays of evidence: pass O {r['lam']['pass_off']}, pass D {r['lam']['pass_def']}, rush O {r['lam']['rush_off']}, "
         f"rush D {r['lam']['rush_def']}, QB {r['lam']['qb']}. Share of base strength that is prior, by week: "
         + ", ".join(f"wk {k} {100 * v:.0f}%" for k, v in fade.items()) + "."),
        ("Season carryover, fitted", f"Carry tuned: offense {r['carry']['off']}, defense {r['carry']['def']}, QB {r['carry']['qb']} "
         f"(×{r['carry']['qb_gap']} per season missed), FCS teams {r['carry']['lower']}, market {r['market']['carry']}. {ab('last_season_carryover')}."),
        ("Priors: conference, talent, returning production",
         f"Conference mean weight {r['conf_w']}: {ab('conference_prior')}. 247 talent composite ({r['talent']['off']} off / {r['talent']['def']} def EPA/play per SD): "
         f"{ab('talent_prior')}. Returning-production carry slope {r['retprod']}: {ab('returning_production')}. "
         "Both feeds have history in sportsdataverse-data (talent 2008+, returning production 2004+), contrary to the brief's premise; "
         "they carry no publication timestamp, so they are measured, not assumed point-in-time."),
        ("FCS opponents: no single floor",
         f"Every FCS / lower-division team in the play-by-play is its own parameter around its division's FITTED mean (prior strength "
         f"{r['lam']['lower']} plays, carry {r['carry']['lower']}). One fitted level per division instead (the ablation): {ab('fcs_team_ratings')}. "
         f"A learned lower-division row on top of the ratings ({f(c26.get('division'), 2)} pts for {last}): {ab('division_offset')}."),
        ("Quarterback carried with the player",
         f"Each passer is a parameter (ESPN athlete id) that follows him through transfers; a debut QB starts at his division's debut "
         f"mean from earlier seasons. {ab('qb_layer')}. QB line influence SD {li['qb']:.2f} pts."),
        ("Market rating from prior weeks' closes",
         f"Refitted every slate on earlier closes ({('half-life %s slates' % r['market']['hl_week']) if r['market']['hl_week'] else 'no in-season decay'}, "
         f"prior {r['market']['lam']} games of evidence, last season carried ×{r['market']['carry']}, FCS division means fitted). {ab('market_rating')}."),
        ("Home field fitted from recent seasons, neutral sites honoured",
         (f"Walk-forward, era-weighted (half-life {cfg['model']['hl_season']} seasons{', shrunk toward the long-run value' if cfg['model'].get('hfa_prior_games') else ''}): "
            if cfg["model"]["hl_season"] else
            "Walk-forward on every earlier season since 2010 equally (era weighting, half-lives 3 and 6, was tuned off on 2014–2020): ") +
         f"{f(c26.get('home_field'), 2)} pts for {last} (the market-implied ~2.6 in the audit; cfb_p4 shipped 4.08 until 2026-10-18, now 2.8). "
         f"A neutral site gets none. Era weighting: {ab('era_weighting')}. Shrinkage: {ab('hfa_shrinkage')}. 2020 no-crowd row: {ab('covid_2020')}. "
         f"Rest / bye / short week: {ab('rest_bye_short')}. Travel and time zones: not built (venue geography not ingested), inactive."),
        ("Key-number distribution, CFB's own sigma and multipliers, range centred",
         f"core `KeyNumberMargin` refitted each season on earlier seasons (support ±100; {last}: sigma {dist.get('sigma')}). "
         f"Pushes at closing lines of 3 / 7 / 14: predicted {', '.join(pct((push.get(k) or {}).get('predicted_key')) for k in ('line 3', 'line 7', 'line 14'))} "
         f"vs observed {', '.join(pct((push.get(k) or {}).get('observed')) for k in ('line 3', 'line 7', 'line 14'))} "
         f"(plain normal {', '.join(pct((push.get(k) or {}).get('predicted_flat')) for k in ('line 3', 'line 7', 'line 14'))}). "
         f"Three-way cover log loss at the close {kn.get('three_way_logloss_key')} vs {kn.get('three_way_logloss_flat')} flat. The 80% range is the symmetric "
         "interval around the projection (centred by construction; the cfb_p4 range sat −1.0 off centre)."),
        ("Calibration", f"Distribution width fitted by likelihood on earlier seasons only (ECE {cal.get('platt', {}).get('ece_raw')}). Platt on top: log loss "
         f"{cal.get('platt', {}).get('logloss_raw')} → {cal.get('platt', {}).get('logloss_calibrated')}; isotonic → {cal.get('isotonic', {}).get('logloss_calibrated')}."),
        ("Components sum exactly to the fair line", "Linear model: every card row is coefficient × input and the rows sum to the fair line "
         "(tests hold the residual to 1e-9, FBS and FCS games alike)."),
        ("Totals", "Intercept + both pass matchups + both rush matchups + market total rating, walk-forward like the margin."),
    ]
    out = ["## What was built, item by item\n", "| Item | What was built, and what the backtest says |", "|---|---|"]
    for ask, what in items:
        out.append(f"| {ask} | {what} |")
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
    versions = json.load(open(os.path.join(DOCS, "versions.json"))) if os.path.exists(os.path.join(DOCS, "versions.json")) else None
    ev = bt["evaluation"]
    dec = bt["decision"]
    tuned = [t for t in tl if t.get("param")]
    acc = [t for t in tuned if t.get("accepted")]
    last_season = max(bt["coefficients_by_season"]["margin"], key=int)
    md = []
    md.append("# CFB v2: walk-forward backtest against the current engine (cfb_p4) and the closing line\n")
    md.append(f"Generated {bt['generated_at']} by `model_loop/adapters/cfb/backtest.py report`; preregistration sha256 `{bt['prereg_sha256']}` "
              f"(`docs/model-loop/cfb/prereg.json`, committed before tuning).\n")
    md.append("## Decision\n")
    d = dec["against"]["cfb_p4"]
    md.append(f"**Preregistered rule: {'cleared' if dec['ship'] else 'NOT cleared'}.** " + "; ".join(d["reasons"]) + ".\n")
    md.append(f"Rule: {pre['decision_rule']}\n")
    if versions:
        v = [x for x in versions["versions"] if x["version"] == versions["current"]][0]
        md.append(f"**Served:** v{v['version']} ({v['status']}, promoted by {v['promoted_by']} {v['promoted_at'][:10]}). {v['reason']}\n")
    md.append("## v2 vs cfb_p4 vs the close (same games, paired)\n")
    md.append("Margin MAE against the final score; log loss of the home win probability (ties excluded). *Close* is the median closing "
              "line across books in the cfbfastR archive (2026: the record's DraftKings close). The close's log loss uses the no-vig "
              "closing moneyline where the archive has one, else the same distribution centred on the closing spread. cfb_p4 is the "
              "current card engine replayed cold (its coefficients were trained on 2001–2025, so before 2026 it is partly in sample).\n")
    md.append(summary_table(ev))
    md.append("")
    md.append(checklist(bt, pred))
    for sl in ("all", "fbs", "fcs"):
        md.append(f"## Every window: {SLICE_LABEL[sl]}\n")
        md.append(headline(ev, sl))
        md.append("")
    md.append("## Paired differences (same games; bootstrap 95% intervals)\n")
    md.append(paired(bt["paired"]))
    md.append("\n## Incremental-value bar: each component removed, scored on VALIDATION (2021–2024) only\n")
    md.append("A component stays active only if removing it makes validation margin MAE or log loss (all games with a close) worse; "
              "the rule keeps a component on either metric, so a row whose removal moves both by less than the noise (division row, "
              "2020 row) stays active on a log-loss gain of ~0.00005 and is, in effect, neutral. The FBS / FCS columns are every game "
              "with a result (with or without a close). The holdout was not consulted.\n")
    md.append(ablations(bt["ablations_validation"]))
    md.append("\n## Calibration of the win probability\n")
    md.append("### Holdout 2025 (all games)\n")
    md.append(calib(ev["v2"]["all"]["holdout"]))
    md.append("\n### Full backtest 2014–2025 (all games)\n")
    md.append(calib(ev["v2"]["all"]["backtest_2014_2025"]))
    md.append(f"\nThe same projections priced from a plain normal: full-backtest log loss "
              f"{f(ev['v2_normal_distribution']['all']['backtest_2014_2025'].get('logloss'), 5)} vs {f(ev['v2']['all']['backtest_2014_2025'].get('logloss'), 5)} (key-number).\n")
    md.append("## Against the closing line, side by side (full backtest 2014–2025, FBS vs FBS)\n")
    md.append("Taking each model's side whenever it disagrees with the close by at least the threshold (descriptive, not a preregistered test):\n")
    md.append("v2:\n")
    md.append(ats(ev["v2"]["fbs"]["backtest_2014_2025"]))
    md.append("\ncfb_p4:\n")
    md.append(ats(ev["cfb_p4"]["fbs"]["backtest_2014_2025"]))
    lm = bt.get("line_moves_toward_model_2014_2025") or {}
    md.append("\n## Did the market move toward the model? (archive openers → closes, 2014–2025)\n")
    for k, v in lm.items():
        if v:
            md.append(f"- **{k}**: n {v['n']}, mean {v['mean_pts']:+.3f} pts toward the model's side; {v['positive']} toward / {v['negative']} away / {v['flat']} flat")
    md.append("\n## Fitted coefficients by season priced (walk-forward: each fitted only on earlier seasons)\n")
    md.append(coef_table(bt["coefficients_by_season"]["margin"]))
    md.append("\nRating terms are points per 1.0 EPA/play of rating difference; the market rating is points per point of prior-close rating; "
              "the lower-division row is points when only the away side is outside FBS (negative when only the home side is).\n")
    md.append("## Configuration\n")
    md.append(f"Tuned on 2014–2020 only, by two-pass coordinate descent over the preregistered grid. **{len(tuned)} variants evaluated, {len(acc)} accepted**; "
              f"every one is in `docs/model-loop/cfb/tuning_log.jsonl` with its tune-window MAE.\n")
    grid = pre["tuning"]["grid"]
    edge = []
    for path, vals in grid.items():
        scope, sub = path.split(".", 1)
        cur = bt["tuned_config"][scope]
        for k in sub.split("."):
            cur = cur[k]
        if len(vals) > 1 and cur in (vals[0], vals[-1]):
            edge.append(f"`{path}` = {cur}")
    md.append("```json\n" + json.dumps(bt["final_config"], indent=1) + "\n```")
    if cards:
        md.append(f"\n## Current cards ({len(cards['games'])} games, generated {cards['generated_at']})\n")
        flagged = [g for g in cards["games"] if g.get("disagreement")]
        show = flagged[:2] or cards["games"][:1]
        for g in show:
            md.append(card_md(g))
            md.append("")
        md.append("| Game | v2 fair line | Win prob | Market reference | Gap | Flag |\n|---|---|---|---|---|---|")
        for g in cards["games"]:
            ref = g["market_reference"]["home_line"]
            gap = (g["fair_home_margin"] + ref) if ref is not None else None
            md.append(f"| {g['away']} @ {g['home']} | {g['home']} {g['fair_home_line']:+.1f} | {100 * g['home_win_prob']:.0f}% | "
                      f"{('%s %+.1f' % (g['home'], ref)) if ref is not None else '—'} | {('%+.1f' % gap) if gap is not None else '—'} | "
                      f"{(g['disagreement'] or {}).get('level') or ''} |")
    md.append("\n## Inactive, and why\n")
    for a in bt["ablations_validation"]:
        if not a["status"].startswith("active"):
            md.append(f"- **{a['component']}**: {a['status']}")
    for x in pre["inactive_by_data"]:
        md.append(f"- {x}")
    md.append("\n## Disclosures\n")
    md.append(f"- {pre['forking_paths']['disclosed_before_tuning']}")
    md.append(f"- {pre['forking_paths']['structural_choices']}")
    for x in pre.get("data_caveats", []):
        md.append(f"- {x}")
    if edge:
        md.append("- Tuned values at the edge of the preregistered grid: " + ", ".join(edge) + ". A wider grid is a weekly-loop "
                  "candidate, not a change made here.")
    md.append("- Components removed by the validation bar make the final model's VALIDATION numbers mildly optimistic; the holdout and 2026 numbers are not affected.")
    md.append("- Starters in the backtest are the quarterbacks who took the most dropbacks (known pregame in nearly every case); live cards price the "
              "board's starter (announced, or the last game's) and say so.")
    md.append("- The cfb_p4 replay omits its team-game efficiency (matchup) term and the 2026-only regime cut; it reproduces the published "
              "2022–2025 FBS MAE (12.72 vs 12.77 published for v1.0.0 with efficiency).")
    md.append("- ATS-vs-close tables are descriptive; no betting claim follows from them.")
    with open(os.path.join(DOCS, "BACKTEST.md"), "w") as fh:
        fh.write("\n".join(md) + "\n")
    print(os.path.join(DOCS, "BACKTEST.md"))


if __name__ == "__main__":
    main()
