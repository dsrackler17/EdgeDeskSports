"""Stage 9 — scoring, like a professional system: accuracy, calibration, coverage, betting.

Every headline number ships with a game-level bootstrap 95% CI (seeded), and
every comparison between two predictors is a PAIRED bootstrap of the
difference, so "V2 beats V1 by 0.3" comes with the interval that says whether
that is distinguishable from nothing.
"""
import numpy as np
import pandas as pd

from . import config as C

RNG = np.random.default_rng(C.SEED)
B = 1000


def boot_ci(x, stat=np.mean, b=B):
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    if len(x) < 20:
        return [None, None]
    rng = np.random.default_rng(C.SEED)
    idx = rng.integers(0, len(x), size=(b, len(x)))
    v = np.array([stat(x[i]) for i in idx])
    return [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]


def margin_metrics(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = ~(np.isnan(y) | np.isnan(p))
    e = p[ok] - y[ok]
    if len(e) == 0:
        return {'n': 0}
    ae = np.abs(e)
    return {'n': int(len(e)), 'mae': float(ae.mean()), 'mae_ci': boot_ci(ae),
            'rmse': float(np.sqrt((e ** 2).mean())), 'median_ae': float(np.median(ae)),
            'bias': float(e.mean()), 'bias_ci': boot_ci(e)}


def paired_mae_diff(y, a, b):
    """MAE(a) - MAE(b) with a paired bootstrap CI. Negative = a is better."""
    y, a, b = (np.asarray(v, float) for v in (y, a, b))
    ok = ~(np.isnan(y) | np.isnan(a) | np.isnan(b))
    d = np.abs(a[ok] - y[ok]) - np.abs(b[ok] - y[ok])
    return {'n': int(ok.sum()), 'diff': float(d.mean()) if ok.any() else None, 'ci': boot_ci(d)}


def prob_metrics(y, p, bins=10):
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = ~(np.isnan(y) | np.isnan(p))
    y, p = y[ok], np.clip(p[ok], 1e-4, 1 - 1e-4)
    if len(y) == 0:
        return {'n': 0}
    brier = (p - y) ** 2
    ll = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    edges = np.linspace(0, 1, bins + 1)
    table, ece = [], 0.0
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= 1)
        if m.sum() == 0:
            continue
        pm, om = float(p[m].mean()), float(y[m].mean())
        table.append({'bin': '%.1f-%.1f' % (edges[i], edges[i + 1]), 'n': int(m.sum()),
                      'mean_pred': round(pm, 4), 'observed': round(om, 4)})
        ece += m.sum() / len(p) * abs(pm - om)
    return {'n': int(len(y)), 'brier': float(brier.mean()), 'brier_ci': boot_ci(brier),
            'log_loss': float(ll.mean()), 'ece': float(ece), 'reliability_table': table}


def coverage(y, lo, hi):
    y, lo, hi = (np.asarray(v, float) for v in (y, lo, hi))
    ok = ~(np.isnan(y) | np.isnan(lo) | np.isnan(hi))
    inside = (y[ok] >= lo[ok]) & (y[ok] <= hi[ok])
    return {'n': int(ok.sum()), 'coverage': float(inside.mean()) if ok.any() else None,
            'mean_width': float((hi[ok] - lo[ok]).mean()) if ok.any() else None}


def betting_metrics(df):
    """df: rows that were BET (units, result, clv_pts, kickoff_ts)."""
    d = df[df.bet_units.notna()].sort_values('kickoff_ts')
    n = len(d)
    if n == 0:
        return {'n': 0}
    decided = d[d.bet_result != 0]
    win = float((decided.bet_result == 1).mean()) if len(decided) else None
    cum = d.bet_units.cumsum().values
    dd = float(np.max(np.maximum.accumulate(np.concatenate([[0], cum]))[1:] - cum)) if n else 0.0
    clv = d.clv_pts.dropna()
    return {'n': int(n), 'wins': int((d.bet_result == 1).sum()), 'losses': int((d.bet_result == -1).sum()),
            'pushes': int((d.bet_result == 0).sum()), 'ats_win_rate': win,
            'ats_win_rate_ci': boot_ci((decided.bet_result == 1).astype(float)) if len(decided) else None,
            'roi_per_bet': float(d.bet_units.mean()), 'roi_ci': boot_ci(d.bet_units),
            'units': float(d.bet_units.sum()), 'max_drawdown_units': dd,
            'clv_mean': float(clv.mean()) if len(clv) else None,
            'clv_ci': boot_ci(clv) if len(clv) else None,
            'clv_positive_share': float((clv > 0).mean()) if len(clv) else None,
            'break_even_win_rate': 0.5238, 'price_assumption': '-110 on every spread (archive has no spread prices)'}


def buckets(df):
    """Subgroup keys used in every breakdown."""
    out = pd.DataFrame(index=df.index)
    out['season'] = df.season.astype(str)
    wk = df.weeks_in
    out['week_bucket'] = pd.cut(wk, [-1, 2, 5, 9, 30], labels=['wk0-2', 'wk3-5', 'wk6-9', 'wk10+']).astype(str)
    out.loc[df.is_postseason, 'week_bucket'] = 'postseason'
    out['early_late'] = np.where(wk < 5, 'early(<5wk)', 'late')
    out['home_conf'] = df.home_conference.fillna('NA')
    p4 = {'SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'}
    hp, ap = df.home_conference.isin(p4), df.away_conference.isin(p4)
    out['p4_g5'] = np.where(hp & ap, 'P4vP4', np.where(hp | ap, 'P4vG5', 'G5vG5'))
    out['p4_g5'] = np.where(df.fcs_game, 'FBSvFCS', out['p4_g5'])
    if 'line' in df:
        L = df.line.abs()
        out['spread_size'] = pd.cut(L, [-0.1, 3, 7, 14, 21, 99], labels=['0-3', '3-7', '7-14', '14-21', '21+']).astype(str)
        out['fav_dog_bet'] = np.where(df.side.isna(), 'none',
                                      np.where((df.side == 'HOME') == (df.line > 0), 'bet_favorite', 'bet_underdog'))
        out['home_away_bet'] = df.side.fillna('none')
    if 'total_open' in df:
        out['total_size'] = pd.cut(df.total_open, [0, 45, 55, 65, 200], labels=['<45', '45-55', '55-65', '65+']).astype(str)
    out['qb_certainty'] = np.where(df.qb_missing_any.fillna(1) > 0, 'qb_unknown(wk1)',
                                   np.where(df.qb_unsettled_any.fillna(0) > 0, 'qb_unsettled', 'qb_settled'))
    if 'reliability' in df:
        out['reliability_bucket'] = pd.cut(df.reliability, [-1, 40, 60, 75, 90, 101],
                                           labels=['<40', '40-60', '60-75', '75-90', '90+']).astype(str)
    if 'gap_open' in df:
        g = df.gap_open.abs()
        out['edge_bucket'] = pd.cut(g, [-0.01, 1, 2, 3, 4, 5, 7, 10, 99],
                                    labels=['0-1', '1-2', '2-3', '3-4', '4-5', '5-7', '7-10', '10+']).astype(str)
    return out
