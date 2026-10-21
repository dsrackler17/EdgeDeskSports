"""Walk-forward evaluation windows, the comparison against the closing line
and against the current version, and the promotion rule.

The windows are declared before anything is scored (preregistration). The
holdout is read once, for the final decision; tuning never sees it.

Promotion (the rule Phase 2 also uses): a candidate replaces the current
version only if, over the FULL backtest (every evaluation season plus the
current season to date), it lowers BOTH margin MAE and win-probability log
loss, AND it is no worse than the current version on the untouched holdout.
For sports with thin history the required improvement is larger
(`min_gain`). One week's games never decide anything.
"""
import hashlib
import json

import numpy as np

from . import metrics as M


def window_mask(df, window):
    lo, hi = window
    return (df.season >= lo) & (df.season <= hi)


def evaluate(df, pred="pred_margin", prob="win_prob", total="pred_total", label=None):
    """Model and closing line, scored the same way on the same games."""
    d = df[df[pred].notna() & df.result.notna() & df.close_margin.notna()]
    out = {"label": label, "n": int(len(d))}
    if not len(d):
        return out
    out["margin_mae"] = round(M.mae(d[pred], d.result), 4)
    out["close_margin_mae"] = round(M.mae(d.close_margin, d.result), 4)
    out["margin_rmse"] = round(M.rmse(d[pred], d.result), 4)
    out["close_margin_rmse"] = round(M.rmse(d.close_margin, d.result), 4)
    out["mean_abs_vs_close"] = round(float(np.mean(np.abs(d[pred] - d.close_margin))), 4)
    out["share_3plus_from_close"] = round(float(np.mean(np.abs(d[pred] - d.close_margin) >= 3)), 4)
    out["ats_vs_close"] = M.ats_vs_close(d[pred], d.close_margin, d.result)
    if prob in d.columns:
        dp = d[d[prob].notna() & (d.result != 0)]
        y = (dp.result > 0).astype(float)
        out["brier"] = round(M.brier(dp[prob], y), 5)
        out["logloss"] = round(M.logloss(dp[prob], y), 5)
        if "mkt_win_prob" in dp.columns:
            dm = dp[dp.mkt_win_prob.notna()]
            ym = (dm.result > 0).astype(float)
            out["close_brier"] = round(M.brier(dm.mkt_win_prob, ym), 5)
            out["close_logloss"] = round(M.logloss(dm.mkt_win_prob, ym), 5)
            out["brier_same_games"] = round(M.brier(dm[prob], ym), 5)
            out["logloss_same_games"] = round(M.logloss(dm[prob], ym), 5)
        out["calibration"] = M.calibration_table(dp[prob], y)
    if total in d.columns:
        dt = d[d[total].notna() & d.total_pts.notna() & d.close_total.notna()]
        if len(dt):
            out["total_mae"] = round(M.mae(dt[total], dt.total_pts), 4)
            out["close_total_mae"] = round(M.mae(dt.close_total, dt.total_pts), 4)
            out["total_n"] = int(len(dt))
    return out


def compare(df, a, b, prob_a=None, prob_b=None):
    """Paired comparison of two projections on the same games
    (negative mean_diff = a better)."""
    d = df[df[a].notna() & df[b].notna() & df.result.notna()]
    out = {"n": int(len(d)), "mae_a": round(M.mae(d[a], d.result), 4), "mae_b": round(M.mae(d[b], d.result), 4),
           "abs_error": M.paired_abs_error_test(d[a] - d.result, d[b] - d.result)}
    if prob_a and prob_b:
        dp = d[d[prob_a].notna() & d[prob_b].notna() & (d.result != 0)]
        y = (dp.result > 0).astype(float)
        out["logloss_a"] = round(M.logloss(dp[prob_a], y), 5)
        out["logloss_b"] = round(M.logloss(dp[prob_b], y), 5)
        out["logloss"] = M.paired_logloss_test(dp[prob_a], dp[prob_b], y)
    return out


def promotion_decision(full_cand, full_cur, hold_cand, hold_cur, min_gain_mae=0.0, min_gain_ll=0.0):
    """full_* / hold_*: evaluate() dicts on the full backtest and the holdout."""
    reasons = []
    ok = True
    if not (full_cand["margin_mae"] < full_cur["margin_mae"] - min_gain_mae):
        ok = False
        reasons.append(f"full-backtest MAE {full_cand['margin_mae']} does not beat {full_cur['margin_mae']} by {min_gain_mae}")
    if not (full_cand["logloss"] < full_cur["logloss"] - min_gain_ll):
        ok = False
        reasons.append(f"full-backtest log loss {full_cand['logloss']} does not beat {full_cur['logloss']} by {min_gain_ll}")
    if hold_cand["margin_mae"] > hold_cur["margin_mae"]:
        ok = False
        reasons.append(f"holdout MAE {hold_cand['margin_mae']} worse than {hold_cur['margin_mae']}")
    if hold_cand["logloss"] > hold_cur["logloss"]:
        ok = False
        reasons.append(f"holdout log loss {hold_cand['logloss']} worse than {hold_cur['logloss']}")
    return {"promote": ok, "reasons": reasons or ["clears every condition"]}


def content_hash(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()
