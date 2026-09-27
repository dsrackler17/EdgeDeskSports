"""The decision-quality scorecard (brief §73) and the uncertainty helpers every
policy table uses.

    scorecard(df)                        one strategy / version / status -> the §73 card, with CIs
    cluster_boot(values, clusters)       game-clustered percentile bootstrap of a mean
    from_shadow(dir)                     the live shadow record (decisions.jsonl + results.jsonl) as a frame
    python3 -m v2.decision.scorecard --shadow football/cfb_decision/2026 [--json]

Input columns (missing optional ones are simply not reported):
    game_id        cluster for every bootstrap (positions on one game move together)
    kickoff_ts     chronological order for the drawdown
    units          realized units of the bet (flat 1u unless `stake_u` says otherwise; NaN = not settled)
    ats_win        1 win / 0 loss / NaN push or unsettled;  is_push (optional)
    clv_pts        side-oriented closing-line value, points (> 0: the market moved to our side)
    p_dec          the decision cover probability (P(cover | no push)) the wager was judged on
    probability_edge, decision_ev, empirical_ev (optional), close_ev (optional: close-implied EV)
    moved_toward_model, abs_line_move (optional)

PROCESS (price, CLV, calibration) and OUTCOME (ATS, ROI) are reported side by
side and never merged: a good price that lost is a good decision.
"""
import json
import math
import os
import sys

import numpy as np
import pandas as pd

from .. import config as C
from . import core

MIN_N_REPORT = 100
MIN_N_USE = 300


def sample_status(n):
    return 'INSUFFICIENT' if n < MIN_N_REPORT else ('PROVISIONAL' if n < MIN_N_USE else 'ESTIMABLE')


def r(x, k=4):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, k) if math.isfinite(x) else None


def rl(v, k=4):
    return None if v is None else [r(x, k) for x in v]


def cluster_boot(values, clusters, B=2000, seed=None, alpha=0.05, min_clusters=20, return_draws=False):
    """Percentile bootstrap of a mean, resampling CLUSTERS (games) with replacement.
    Returns [lo, hi] (and the draws when asked); [None, None] below min_clusters."""
    v = np.asarray(values, dtype=float)
    c = np.asarray(clusters)
    ok = np.isfinite(v)
    v, c = v[ok], c[ok]
    if not len(v):
        return ([None, None], None) if return_draws else [None, None]
    _, inv = np.unique(c, return_inverse=True)
    G = int(inv.max()) + 1
    if G < min_clusters:
        return ([None, None], None) if return_draws else [None, None]
    sums = np.bincount(inv, weights=v, minlength=G)
    cnts = np.bincount(inv, minlength=G).astype(float)
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    draws = np.empty(B)
    step = max(1, int(4e6 // G))
    for i in range(0, B, step):
        k = min(step, B - i)
        idx = rng.integers(0, G, size=(k, G))
        draws[i:i + k] = sums[idx].sum(axis=1) / np.maximum(cnts[idx].sum(axis=1), 1.0)
    ci = [float(np.quantile(draws, alpha / 2)), float(np.quantile(draws, 1 - alpha / 2))]
    return (ci, draws) if return_draws else ci


def paired_cluster_diff(a, b, clusters, B=2000, seed=None):
    """Mean of (a - b) over rows, game-clustered bootstrap CI (the paired comparison of §37)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = a - b
    ok = np.isfinite(d)
    ci = cluster_boot(d[ok], np.asarray(clusters)[ok], B=B, seed=seed)
    return {'n': int(ok.sum()), 'mean': r(d[ok].mean(), 5) if ok.any() else None, 'ci': rl(ci, 5)}


def longest_losing_streak(results):
    """Longest run of consecutive losses (pushes neither extend nor break a run)."""
    best = cur = 0
    for x in results:
        if x == 0:
            cur += 1
            best = max(best, cur)
        elif x == 1:
            cur = 0
    return int(best)


def time_to_recovery(units):
    """Longest stretch (in bets) spent below a previous peak; `recovered` is False if the last one never recovered."""
    u = np.asarray(units, float)
    u = u[np.isfinite(u)]
    if not len(u):
        return {'bets': 0, 'recovered': True}
    cum = np.concatenate([[0.0], np.cumsum(u)])
    peak, peak_i, longest, rec = cum[0], 0, 0, True
    for i in range(1, len(cum)):
        if cum[i] >= peak - 1e-12:
            if i - peak_i > 1:                   # there was a dip below the peak: it took i - peak_i bets to regain it
                longest = max(longest, i - peak_i)
            peak, peak_i = cum[i], i
    tail = len(cum) - 1 - peak_i
    if tail > 0 and cum[-1] < peak - 1e-12 and tail >= longest:
        longest, rec = tail, False
    return {'bets': int(longest), 'recovered': rec}


def scorecard(df, B=2000, seed=None, label=None, drawdown=True):
    """The §73 decision-quality scorecard of one set of decisions, with uncertainty."""
    d = df.sort_values('kickoff_ts', kind='mergesort') if 'kickoff_ts' in df else df
    n = int(len(d))
    g = d['game_id'].values if 'game_id' in d else np.arange(n)
    out = {'label': label, 'bet_count': n, 'games': int(pd.Series(g).nunique()), 'sample_status': sample_status(n)}
    if not n:
        return out
    col = lambda k: d[k].astype(float).values if k in d else np.full(n, np.nan)
    y, u, clv = col('ats_win'), col('units'), col('clv_pts')
    pe, ev, pdec = col('probability_edge'), col('decision_ev'), col('p_dec')
    out['avg_predicted_edge'] = r(np.nanmean(pe)) if np.isfinite(pe).any() else None
    out['avg_ev'] = r(np.nanmean(ev)) if np.isfinite(ev).any() else None
    if 'empirical_ev' in d and np.isfinite(col('empirical_ev')).any():
        out['avg_empirical_ev'] = r(np.nanmean(col('empirical_ev')))
    ok = np.isfinite(clv)
    if ok.any():
        out['avg_clv'] = r(clv[ok].mean(), 3)
        out['avg_clv_ci'] = rl(cluster_boot(clv, g, B=B, seed=seed), 3)
        pc = (clv[ok] > 0).astype(float)
        out['positive_clv_pct'] = r(pc.mean())
        out['positive_clv_wilson'] = rl(core.wilson(pc.sum(), len(pc)))
        out['n_clv'] = int(ok.sum())
    if 'moved_toward_model' in d:
        mt = col('moved_toward_model')
        if np.isfinite(mt).any():
            out['moved_toward_model'] = r(np.nanmean(mt))
            out['moved_toward_model_n'] = int(np.isfinite(mt).sum())
    if 'abs_line_move' in d and np.isfinite(col('abs_line_move')).any():
        out['avg_abs_market_move_after_bet'] = r(np.nanmean(col('abs_line_move')), 3)
    out['avg_market_move_after_bet'] = out.get('avg_clv')          # side-oriented: + = toward the bet
    if 'close_ev' in d and np.isfinite(col('close_ev')).any():
        ce = col('close_ev')
        out['close_implied_ev'] = r(np.nanmean(ce), 5)
        out['close_implied_ev_ci'] = rl(cluster_boot(ce, g, B=B, seed=seed), 5)
    ny = np.isfinite(y)
    k, m = float(y[ny].sum()), int(ny.sum())
    pushes = int(np.nansum(col('is_push'))) if 'is_push' in d else int(np.sum(~ny & np.isfinite(u)))
    out['ats'] = {'wins': int(k), 'losses': int(m - k), 'pushes': pushes,
                  'cover_rate': r(k / m) if m else None, 'wilson': rl(core.wilson(k, m)) if m else None}
    uu = np.isfinite(u)
    if uu.any():
        stake = col('stake_u') if 'stake_u' in d else np.ones(n)
        stake = np.where(np.isfinite(stake), stake, 1.0)
        out['units'] = r(u[uu].sum(), 2)
        out['roi'] = r(u[uu].sum() / stake[uu].sum())
        out['roi_ci'] = rl(cluster_boot(u / np.where(stake > 0, stake, 1.0), g, B=B, seed=seed))
        if drawdown:
            out['max_drawdown'] = r(core.max_drawdown(u[uu]), 2)
            out['max_drawdown_ci'] = rl(core.boot_drawdown_ci(u[uu], B=1000, seed=seed), 2)
            out['longest_losing_streak'] = longest_losing_streak(y[np.isfinite(u)])
            out['time_to_recovery'] = time_to_recovery(u[uu])
    okp = ny & np.isfinite(pdec)
    if okp.any():
        out['mean_p_dec'] = r(pdec[okp].mean())
        out['brier'] = r(core.brier(y[okp], pdec[okp]).mean(), 5)
        out['calibration_error'] = r(pdec[okp].mean() - y[okp].mean())
        w = core.wilson(y[okp].sum(), okp.sum())
        out['calibrated_in_the_large'] = bool(w[0] <= pdec[okp].mean() <= w[1])
    out['process_vs_outcome'] = 'PROCESS: avg_clv, positive_clv_pct, close_implied_ev, calibration; OUTCOME: ats, roi, units'
    return out


# ------------------------------------------------------------------ live
def _jsonl(p):
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def from_shadow(season_dir):
    """The shadow record as a scorecard frame: one row per decision, its grade joined when settled.
    Units: the ledger's own units for a BET at a captured price; for every other status the
    HYPOTHETICAL flat 1u at the decision's captured price (NaN without a price): PASS quality."""
    dec = pd.DataFrame(_jsonl(os.path.join(season_dir, 'decisions.jsonl')))
    res = pd.DataFrame(_jsonl(os.path.join(season_dir, 'results.jsonl')))
    if dec.empty:
        return dec
    if not res.empty:
        dec = dec.merge(res[['decision_id', 'ats_result', 'units', 'clv_pts', 'positive_clv']], on='decision_id', how='left')
    for c in ('ats_result', 'units', 'clv_pts'):
        if c not in dec:
            dec[c] = np.nan
    dec['ats_win'] = dec.ats_result.map({'W': 1.0, 'L': 0.0})
    dec['is_push'] = dec.ats_result.eq('P').astype(float)
    b = dec.price.map(lambda a: core.american_to_payout(a) if a is not None and np.isfinite(a) else np.nan) \
        if 'price' in dec else np.nan
    hyp = np.where(dec.ats_result.eq('W'), b, np.where(dec.ats_result.eq('L'), -1.0, np.where(dec.ats_result.eq('P'), 0.0, np.nan)))
    dec['units'] = np.where(dec.units.notna(), dec.units, hyp).astype(float)
    dec['p_dec'] = dec.get('decision_cover_probability')
    dec['kickoff_ts'] = pd.to_datetime(dec.get('kickoff_ts'), utc=True, errors='coerce')
    return dec


def shadow_scorecards(season_dir, B=1000):
    D = from_shadow(season_dir)
    if D.empty:
        return {'season_dir': season_dir, 'decisions': 0, 'cards': []}
    cards = []
    for (role, st), g in D.groupby(['engine_role', 'status'], sort=True):
        c = scorecard(g, B=B, label='%s %s' % (role, st))
        c['settled'] = int(g.ats_result.notna().sum())
        c['priced'] = int(g.price.notna().sum()) if 'price' in g else 0
        cards.append(c)
    return {'season_dir': season_dir, 'decisions': int(len(D)), 'settled': int(D.ats_result.notna().sum()), 'cards': cards}


if __name__ == '__main__':
    if '--shadow' in sys.argv:
        path = sys.argv[sys.argv.index('--shadow') + 1]
        res = shadow_scorecards(path)
        if '--json' in sys.argv:
            print(json.dumps(res, indent=1, sort_keys=True))
        else:
            print('%s: %d decisions, %s settled' % (path, res['decisions'], res.get('settled')))
            for c in res['cards']:
                print('  %-26s n %4d settled %4d | CLV %s +CLV %s | ATS %s | ROI %s' % (
                    c['label'], c['bet_count'], c['settled'], c.get('avg_clv'), c.get('positive_clv_pct'),
                    (c.get('ats') or {}).get('cover_rate'), c.get('roi')))
