#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — Expected Points surface, and the EPA engine that
scores the light play table with it.

THE PROBLEM THIS SOLVES
cfbfastR publishes real, model-grade EPA — but its play-by-play stops at
2022. `player_stats` runs through the current season but carries only state
(down, distance, yards-to-goal, clock, score) and yards gained. So the recent
seasons have to be scored with an EP model of our own. Rather than invent
one, this fits a surface TO cfbfastR's own `EP_start`, then re-derives EPA
from the same next-state arithmetic.

WHAT WAS ESTABLISHED BY EXECUTION (see report/BACKTEST.md)
* cfbfastR's `EP_start` is a deterministic function of exactly five inputs:
  start.down, start.distance, start.yardsToEndzone, start.TimeSecsRem and
  pos_score_diff_start. Grouping 123,467 scrimmage plays on that 5-tuple
  gives within-cell SD of 0.0000. Score differential really is an input —
  at 1st-and-10 from the 25, EP runs from -0.98 when trailing by 21+ to
  +2.90 when leading by 21+.
* `start.TimeSecsRem` is seconds left in the HALF (0-1800), not the game.
* The cfbfastR EP model is FROZEN across seasons: the same 5-tuple returns a
  bit-identical EP in 2005, 2010, 2014, 2019 and 2022. A surface fit on any
  subset therefore generalises exactly, and a season holdout measures only
  the table's approximation error.
* The bare `down`/`distance` columns in the pbp files are NOT the play's
  down and distance (93.7% null, and every non-null value is 1 and 10). The
  real state lives in the `start.*` columns. Using the wrong pair silently
  destroys the fit.
* pbp 2016 WEEK 2 is CORRUPT (end.yardsToEndzone pinned at 99), which alone
  drags 2016's team-game EPA SD from ~0.23 to 0.756. It is excluded.

FIDELITY OF THE SHIPPED SURFACE
  R^2 = 0.9846, MAE = 0.171 EP, 99th-percentile |error| = 0.71 EP on held-out
  2021-2022 (230k plays), from 24,662 bytes of JSON. The honest out-of-sample
  variant (fit <=2020) scores R^2 = 0.9844 — i.e. the table generalises.
  Making the surface bigger does not help downstream: 110 KB lifts surface
  R^2 to 0.9895 but team-game EPA correlation only from 0.947 to 0.952,
  because the next-state arithmetic, not the surface, dominates the residual.

Usage:
  python3 ep_surface.py fit  <out_dir>      # -> <out>/ep_surface.json
  python3 ep_surface.py check <out_dir>     # replay the fidelity numbers
"""
import json
import os
import sys
import gzip

import numpy as np
import pandas as pd

import common

# Bin edges. Chosen to track the shape of the EP response (tight around the
# key score margins and the end of each half), then frozen.
SD_BINS = [-999, -28, -21, -17, -14, -11, -8, -4, -1, 0, 3, 7, 10, 13, 16, 20, 27, 999]
TS_BINS = [-1, 15, 30, 60, 90, 120, 180, 300, 450, 600, 900, 1200, 1500, 1801]
YTG_KNOTS = list(range(1, 100, 5)) + [99]

TD_VALUE = 6.98            # touchdown + expected PAT, cfbfastR convention
SAFETY_VALUE = -2.0

CORRUPT_SLICES = [(2016, 2)]   # (season, week) excluded: end-of-play state is garbage


class EPSurface(object):
    """Lookup: EP(down, distance, yards_to_goal, secs_left_in_half, score_diff).

    Stored as int hundredths of a point so the whole surface is 24 KB."""

    def __init__(self, obj_or_path):
        o = obj_or_path
        if isinstance(o, str):
            with open(o) as f:
                o = json.load(f)
        self.o = o
        self.sd_bins = np.array(o['sd_bins'])
        self.ts_bins = np.array(o['ts_bins'])
        self.kn = np.array(o['ytg_knots'])
        self.base = np.array(o['base'], dtype=np.float64).reshape(o['base_shape']) / 100.0
        self.adj = np.array(o['adj'], dtype=np.float64).reshape(o['adj_shape']) / 100.0

    def _base_at(self, down, dist_eff, ytg):
        row = (down - 1) * 25 + (dist_eff - 1)
        v = self.base[row]
        x = np.clip(ytg, 1, 99).astype(float)
        idx = np.clip(np.searchsorted(self.kn, x, side='right') - 1, 0, len(self.kn) - 2)
        x0, x1 = self.kn[idx], self.kn[idx + 1]
        w = (x - x0) / (x1 - x0)
        r = np.arange(len(x))
        return v[r, idx] * (1 - w) + v[r, idx + 1] * w

    def ep(self, down, dist, ytg, tsr, sd):
        down = np.clip(np.asarray(down), 1, 4).astype(int)
        ytg = np.clip(np.asarray(ytg), 1, 99).astype(int)
        dist = np.asarray(dist)
        de = np.clip(np.minimum(dist, ytg), 1, 25).astype(int)
        b = self._base_at(down, de, ytg)
        si = np.searchsorted(self.sd_bins, np.asarray(sd), side='left')
        ti = np.searchsorted(self.ts_bins, np.asarray(tsr), side='left')
        yc = np.clip((ytg - 1) // 20, 0, 4)
        a = self.adj[si, ti, yc, down - 1]
        return b + a


def epa(surface, down, dist, ytg, tsr, sd, gain, is_td, is_turnover):
    """EPA from the same next-state arithmetic cfbfastR uses. Returns
    (epa, ep_before, ep_after)."""
    down = np.asarray(down, float); dist = np.asarray(dist, float)
    ytg = np.asarray(ytg, float); tsr = np.asarray(tsr, float)
    sd = np.asarray(sd, float); gain = np.asarray(gain, float)
    ep0 = surface.ep(down, dist, ytg, tsr, sd)
    nyt = ytg - gain
    first = gain >= dist
    nd = np.where(first, 1, down + 1)
    ndist = np.where(first, np.minimum(10, np.maximum(nyt, 1)), np.maximum(dist - gain, 1))
    opp_ytg = np.clip(100 - nyt, 1, 99)
    ep_opp = -surface.ep(np.ones_like(down), np.minimum(10, opp_ytg), opp_ytg, tsr, -sd)
    ep_next = surface.ep(np.clip(nd, 1, 4), ndist, np.clip(nyt, 1, 99), tsr, sd)
    ep1 = np.where(nyt <= 0, TD_VALUE,
          np.where(is_turnover, ep_opp,
          np.where(nyt >= 100, SAFETY_VALUE,
          np.where(nd > 4, ep_opp, ep_next))))
    ep1 = np.where(np.asarray(is_td, bool), TD_VALUE, ep1)
    return ep1 - ep0, ep0, ep1


def _load_training_plays(lo=2004, hi=2022):
    cols = ['season', 'week', 'start.down', 'start.distance', 'start.yardsToEndzone',
            'start.TimeSecsRem', 'pos_score_diff_start', 'EP_start', 'scrimmage_play']
    out = []
    for y in range(lo, hi + 1):
        p = os.path.join(common.DATA, 'pbp', 'pbp_%d.parquet' % y)
        if not os.path.exists(p):
            continue
        try:
            d = pd.read_parquet(p, columns=cols)
        except Exception:
            print('[skip] %d: required EPA columns absent (2002/2003 stubs)' % y)
            continue
        d = d[d.scrimmage_play == True].dropna(subset=cols[:-1])
        for s, w in CORRUPT_SLICES:
            if y == s:
                before = len(d)
                d = d[d.week != w]
                print('[exclude] %d week %d: %d corrupt plays dropped '
                      '(end-of-play field position pinned at 99)' % (s, w, before - len(d)))
        d = d[d['start.down'].between(1, 4)]
        d.columns = ['season', 'week', 'down', 'dist', 'ytg', 'tsr', 'sd', 'EP_start', 'sp']
        out.append(d.drop(columns='sp'))
    if not out:
        raise SystemExit('no usable pbp under %s/pbp' % common.DATA)
    A = pd.concat(out, ignore_index=True)
    A['dist_eff'] = np.minimum(np.minimum(A.dist, A.ytg), 25).astype(int)
    A = A[A.ytg.between(1, 99) & A.tsr.between(0, 1800) & A.sd.between(-98, 98)]
    return A


def fit(A):
    """Backfitting: a (down, effective distance, yards-to-goal) base surface
    and a (score-bin, time-bin, coarse field position, down) adjustment,
    alternated to convergence, then smoothed and knotted."""
    KA = ['down', 'dist_eff', 'ytg']
    KG = ['sdb', 'tsb', 'ytc', 'down']
    A = A.copy()
    A['sdb'] = pd.cut(A.sd, SD_BINS, labels=False).astype(int)
    A['tsb'] = pd.cut(A.tsr, TS_BINS, labels=False).astype(int)
    A['ytc'] = np.minimum((A.ytg - 1) // 20, 4)

    def lk(t, tab, k):
        return tab.reindex(pd.MultiIndex.from_frame(t[k])).to_numpy()

    gm = A.EP_start.mean()
    g = np.zeros(len(A))
    T = G = None
    for _ in range(6):
        T = A.assign(y=A.EP_start - g).groupby(KA)['y'].mean()
        b = np.nan_to_num(lk(A, T, KA), nan=gm)
        G = A.assign(r=A.EP_start - b).groupby(KG)['r'].mean()
        g = np.nan_to_num(lk(A, G, KG))

    piv = T.rename('v').reset_index().pivot_table(index=['down', 'dist_eff'], columns='ytg', values='v')
    piv = piv.reindex(index=pd.MultiIndex.from_product([[1, 2, 3, 4], range(1, 26)],
                                                       names=['down', 'dist_eff']),
                      columns=range(1, 100))
    piv = piv.interpolate(axis=1, limit_direction='both').ffill().bfill()
    piv = piv.T.rolling(5, center=True, min_periods=1).mean().T
    Gd = G.reindex(pd.MultiIndex.from_product(
        [range(len(SD_BINS) - 1), range(len(TS_BINS) - 1), range(5), [1, 2, 3, 4]])).fillna(0)
    return {
        'v': 1,
        'note': 'EP(down, distance, yards_to_goal, seconds_left_in_half, score_diff) '
                'fit to cfbfastR EP_start, 2004-2022 scrimmage plays, 2016 week 2 excluded',
        'sd_bins': SD_BINS[1:-1], 'ts_bins': TS_BINS[1:-1], 'ytg_knots': YTG_KNOTS,
        'base': np.round(piv[YTG_KNOTS].to_numpy() * 100).astype(int).ravel().tolist(),
        'base_shape': [100, len(YTG_KNOTS)],
        'adj': np.round(Gd.to_numpy() * 100).astype(int).tolist(),
        'adj_shape': [len(SD_BINS) - 1, len(TS_BINS) - 1, 5, 4],
    }


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'fit'
    out = sys.argv[2] if len(sys.argv) > 2 else 'out'
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, 'ep_surface.json')

    if mode == 'fit':
        A = _load_training_plays()
        print('[fit] scrimmage plays: %d  seasons %d-%d' % (len(A), A.season.min(), A.season.max()))
        # Honest split first: the reported generalisation number must come
        # from a surface that never saw the test seasons.
        oos = fit(A[A.season <= 2020])
        prod = fit(A)
        with open(os.path.join(out, 'ep_surface_oos.json'), 'w') as f:
            json.dump(oos, f, separators=(',', ':'))
        with open(path, 'w') as f:
            json.dump(prod, f, separators=(',', ':'))
        te = A[A.season >= 2021]
        for name, o in (('held-out fit (<=2020)', oos), ('shipped fit (all seasons)', prod)):
            S = EPSurface(o)
            p = S.ep(te.down.values, te.dist.values, te.ytg.values, te.tsr.values, te.sd.values)
            y = te.EP_start.values
            r = y - p
            js = json.dumps(o, separators=(',', ':'))
            print('[%s] R2(2021-22)=%.4f MAE=%.4f p99|err|=%.3f bytes=%d gzip=%d'
                  % (name, 1 - np.sum(r ** 2) / np.sum((y - y.mean()) ** 2),
                     np.abs(r).mean(), np.percentile(np.abs(r), 99),
                     len(js), len(gzip.compress(js.encode()))))
        print('[write] %s' % path)
        return

    if mode == 'check':
        A = _load_training_plays()
        S = EPSurface(path)
        p = S.ep(A.down.values, A.dist.values, A.ytg.values, A.tsr.values, A.sd.values)
        r = A.EP_start.values - p
        print('shipped surface on ALL 2004-2022: R2=%.4f MAE=%.4f'
              % (1 - np.sum(r ** 2) / np.sum((A.EP_start.values - A.EP_start.mean()) ** 2),
                 np.abs(r).mean()))
        return

    raise SystemExit('usage: ep_surface.py [fit|check] <out_dir>')


if __name__ == '__main__':
    main()
