"""football_prediction_confidence (0-100) — how trustworthy the PREDICTION is.

It is NOT "how much EdgeDesk likes the game". It never reads the market, the
gap or the EV. It is built from the calibrated error model:

  base  = where this game's predicted sigma sits in the historical sigma range
          (sigma already carries sample size, early season, rating posterior
          width, model disagreement, QB instability, team volatility, FCS)
  caps  = hard ceilings for states the error model cannot see well:
          FCS participant 50, a team with no current-season game 70,
          unsettled quarterback 75, both QBs unresolved (week 1) 65

Then it is CHECKED, walk-forward: each reliability bucket publishes its
historical MAE and interval coverage, so "80" means something measurable.
"""
import numpy as np
import pandas as pd

CAPS = {'fcs': 50.0, 'no_games': 70.0, 'qb_unsettled': 75.0, 'qb_unknown': 65.0}


def score(D, sig_lo, sig_hi):
    s = D.sigma.values
    base = 100.0 * np.clip((sig_hi - s) / max(1e-6, sig_hi - sig_lo), 0, 1)
    cap = np.full(len(D), 100.0)
    cap = np.where(D.fcs_game.values, np.minimum(cap, CAPS['fcs']), cap)
    cap = np.where(D.min_games.fillna(0).values < 1, np.minimum(cap, CAPS['no_games']), cap)
    cap = np.where(D.qb_unsettled_any.fillna(0).values > 0, np.minimum(cap, CAPS['qb_unsettled']), cap)
    cap = np.where(D.qb_missing_any.fillna(1).values > 0, np.minimum(cap, CAPS['qb_unknown']), cap)
    return np.minimum(base, cap)


def attach(D, seasons):
    """Walk-forward: the sigma range for season S comes from seasons < S."""
    D = D.copy()
    D['reliability'] = np.nan
    ranges = {}
    for S in seasons:
        past = D[(D.season < S) & D.sigma.notna()]
        cur = D.season.eq(S) & D.sigma.notna()
        if len(past) < 300 or not cur.any():
            continue
        lo, hi = float(np.percentile(past.sigma, 5)), float(np.percentile(past.sigma, 95))
        ranges[S] = (lo, hi)
        D.loc[cur, 'reliability'] = score(D[cur], lo, hi)
    return D, ranges
