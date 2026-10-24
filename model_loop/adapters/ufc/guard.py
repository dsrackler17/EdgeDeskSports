"""The UFC market disagreement guard: what the product may say when the served
model and the market disagree.

  threshold   docs/model-loop/ufc/guard.json threshold_pp (8 points to start):
              |model - market| above it -> status DISAGREES, labelled "Model
              disagrees with market", never an edge
  market      the no-vig price for the same fighter (market.py: the latest
              captured two-way quote before the bout)
  factors     what about this bout the model is known to misread, each with its
              measured record when the study has one (docs/model-loop/ufc/study):
              a short UFC sample, a long layoff, age, a weight change, a rematch
  signal      a disagreement is a signal ONLY when the study certified that gaps
              that size beat the closing line out of sample, on a timestamped
              close (guard.json certify). Until then `signal_allowed` is false
              and every surface shows the two numbers and the reasons, nothing
              more. The simulator's copy (simulator/src/sports/ufc/guard.ts)
              applies the same file and is checked against this one.
"""
import json
import os

import numpy as np

from . import ingest

ROOT = ingest.ROOT
CONFIG = os.path.join(ROOT, "docs", "model-loop", "ufc", "guard.json")
STUDY = os.path.join(ROOT, "docs", "model-loop", "ufc", "study")
LABEL = "Model disagrees with market"


def config(path=CONFIG):
    with open(path) as f:
        return json.load(f)


def certification(gaps, reference, cfg=None):
    """Is a gap above the threshold a signal? gaps: study.gap_table() on out-of-sample bouts; reference: the close's provenance."""
    cfg = cfg or config()
    th, C = cfg["threshold_pp"], cfg["certify"]
    rows = [r for r in (gaps or {}).get("rows", []) if r["lo"] >= th]
    n = sum(r["n"] for r in rows)
    lm = sum(r["model_log_loss"] * r["n"] for r in rows) / n if n else None
    lc = sum(r["close_log_loss"] * r["n"] for r in rows) / n if n else None
    over = (gaps or {}).get(f"over_{th}") or {}
    ci = over.get("diff_ci95")
    reasons = []
    if C.get("requires_timestamped_close", True) and not (reference or {}).get("timestamped"):
        reasons.append("the closing line on file is untimestamped (a public archive's pre-fight line), so it can refuse a signal but never certify one")
    if n < C["min_n"]:
        reasons.append(f"{n} out-of-sample bouts with a gap of {th}+ points, fewer than {C['min_n']}")
    if lm is not None and lc is not None and lm >= lc:
        reasons.append(f"on those bouts the model's log loss {lm:.4f} is worse than the closing line's {lc:.4f}: "
                       f"{over.get('market_favour', '—')} resolved in the market's favour, {over.get('model_favour', '—')} in the model's")
    elif ci and ci[1] >= 0:
        reasons.append(f"the model's edge over the close on those bouts has a 95% interval {ci} that is not below zero")
    return {"certified": not reasons, "threshold_pp": th, "n": n, "model_log_loss": None if lm is None else round(lm, 5),
            "close_log_loss": None if lc is None else round(lc, 5), "model_favour": over.get("model_favour"),
            "market_favour": over.get("market_favour"), "ci95": ci, "reasons": reasons or ["certified"]}


def evidence_for(version):
    """the served version's measured record by factor (study breakdowns), or {} when the study has not run"""
    for name in (f"diagnosis_{version}.json",):
        p = os.path.join(STUDY, name)
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f).get("breakdowns") or {}
    return {}


def _rec(ev, group, bucket):
    for r in (ev.get(group) or {}).get("rows", []):
        if r.get("bucket") == bucket and r.get("n_close"):
            return {"n": r["n_close"], "model_said": r.get("model_said_close_subset"), "close_said": r.get("close_said"), "won": r.get("won_close_subset")}
    return None


def _num(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else x


def explain(name_a, fa, name_b, fb, meet=None, meet_last=None, evidence=None, cfg=None):
    """The factors present in this bout that the model is known to misread. fa/fb: factors.side() dicts."""
    cfg = cfg or config()
    F, ev, out = cfg["factors"], evidence or {}, []
    for nm, f in ((name_a, fa), (name_b, fb)):
        n = f.get("ufc_bouts", 0)
        if n == 0:
            out.append({"code": "debut", "fighter": nm, "text": f"{nm} makes a UFC debut: the model has no UFC bout to rate",
                        "record": _rec(ev, "debutants", "one debutant")})
        elif n <= F["short_sample_bouts"]:
            pw, pl = _num(f.get("pre_w")), _num(f.get("pre_l"))
            pro = f" (pro record before the UFC {int(pw)}-{int(pl)})" if pw is not None and pl is not None else ""
            out.append({"code": "short_sample", "fighter": nm, "text": f"{nm} has {n} UFC bout{'s' if n != 1 else ''} in the data{pro}: a short sample",
                        "record": _rec(ev, "ufc_sample", "1-2" if n <= 2 else "3-5")})
    for nm, f in ((name_a, fa), (name_b, fb)):
        d = _num(f.get("days_off"))
        if d is not None and d >= F["layoff_days"]:
            out.append({"code": "layoff", "fighter": nm, "text": f"{nm} returns after {int(d)} days out",
                        "record": _rec(ev, "layoff", "365-539" if d < 540 else "540+")})
    aa, ab = _num(fa.get("age")), _num(fb.get("age"))
    for nm, a in ((name_a, aa), (name_b, ab)):
        if a is not None and a >= F["age_years"]:
            out.append({"code": "age", "fighter": nm, "text": f"{nm} is {a:.1f}, past {F['age_years']}: how much age has taken is where the model and the market most often differ",
                        "record": _rec(ev, "age", "35-36" if a < 37 else "37+")})
    if aa is not None and ab is not None and abs(aa - ab) >= F["age_gap_years"] and not any(x["code"] == "age" for x in out):
        old = name_a if aa > ab else name_b
        out.append({"code": "age_gap", "fighter": old, "text": f"{old} is {abs(aa - ab):.1f} years older",
                    "record": _rec(ev, "age", "older by 5+ years")})
    for nm, f in ((name_a, fa), (name_b, fb)):
        st = _num(f.get("div_step"))
        if st:
            out.append({"code": "weight_change", "fighter": nm,
                        "text": f"{nm} moves {'up' if st > 0 else 'down'} {abs(int(st))} division{'s' if abs(st) > 1 else ''}: the rating was earned at another weight",
                        "record": _rec(ev, "division_change", "moved up" if st > 0 else "moved down")})
    if meet:
        last = None if meet_last is None or (isinstance(meet_last, float) and np.isnan(meet_last)) else meet_last
        who = name_a if last == 1.0 else name_b if last == 0.0 else None
        out.append({"code": "rematch", "fighter": who, "text": f"a rematch ({int(meet)} earlier meeting{'s' if meet > 1 else ''}"
                    + (f"; {who} won the last)" if who else "; the last had no winner)"),
                    "record": _rec(ev, "rematches", "rematch: read from the last meeting's winner")})
    return out


def assess(p_model_a, market, factors_list, cert, cfg=None):
    """the guard's verdict for one bout. market: {'p_a': no-vig chance of fighter_a, ...} or None"""
    cfg = cfg or config()
    th = cfg["threshold_pp"]
    if not market or market.get("p_a") is None:
        return {"status": "NO_MARKET", "label": "No market price on file", "threshold_pp": th, "gap_pp": None,
                "signal_allowed": False, "factors": factors_list, "certified": bool(cert and cert.get("certified"))}
    gap = 100.0 * (p_model_a - market["p_a"])
    dis = abs(gap) > th
    certified = bool(cert and cert.get("certified"))
    return {"status": "DISAGREES" if dis else "AGREES", "label": LABEL if dis else "Model and market agree within the threshold",
            "threshold_pp": th, "gap_pp": round(gap, 1), "signal_allowed": bool(dis and certified),
            "factors": factors_list if dis else [], "certified": certified,
            "note": ("A gap this size has been certified to beat the closing line." if dis and certified else
                     "Not an edge: gaps this size have historically resolved in the market's favour, or have not been certified to beat the close."
                     if dis else None)}
