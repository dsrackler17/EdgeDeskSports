"""Tune the rating engine's two knobs by walk-forward NEXT-GAME prediction.

For every prediction timestamp T in the development seasons, each team-game
played in the following week is predicted from ratings frozen at T:

    y_hat = mu_T + o_t + d_d + h_T * H

and scored by play-weighted squared error against what happened. The knobs:

  RATING_PRIOR_SCALE     multiplies every preseason prior variance
                         (small = sticky prior, large = data dominates sooner)
  RECENT_HALFLIFE_WEEKS  the recent-form horizon's decay

Only DEV seasons are read (config.assert_dev_only). Result -> report/tuning_ratings.json
"""
import itertools
import json
import sys

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import build_ratings as B
from . import ratings as R

TUNE_METRICS = ['epa', 'epa_pass', 'epa_rush', 'sr', 'ppd', 'expl', 'line_yds', 'st_net']
TUNE_SEASONS = [2016, 2017, 2018, 2019, 2021, 2022]


def score(seasons, scale, halflives, metrics):
    C.assert_dev_only(seasons)
    specs = {k: v for k, v in B.metric_specs().items() if k in metrics}
    B.run(seasons_out=seasons, prior_scale=scale, halflife=halflives[0], write=True,
          metrics=metrics, verbose=False)
    TG, G = B.load_team_games(seasons)
    out = {}
    for S in seasons:
        Rt = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S))
        Lg = pd.read_parquet(common.out_path('stage3', 'league_%d.parquet' % S))
        tg = TG[TG.g_season.eq(S)]
        gp = G[G.season.eq(S)][['game_id', 'prediction_ts']]
        tg = tg.merge(gp, on='game_id')
        for m, spec in specs.items():
            y, n, ok = R.metric_obs(tg, spec[0], spec[1], spec[2])
            sub = tg[ok].assign(y=y, n=n)
            r = Rt[Rt.metric.eq(m)]
            lg = Lg[Lg.metric.eq(m)].set_index('prediction_ts')
            key_o = r.set_index(['prediction_ts', 'team_id'])
            for col in ('off', 'off_rec', 'prior_off'):
                pass
            idx_o = pd.MultiIndex.from_arrays([sub.prediction_ts, sub.team_id])
            idx_d = pd.MultiIndex.from_arrays([sub.prediction_ts, sub.opp_id])
            mu = lg.mu.reindex(sub.prediction_ts).values
            h = lg.h.reindex(sub.prediction_ts).values
            first = np.isnan(mu)
            for hz, oc, dc in (('season', 'off', 'def'), ('recent', 'off_rec', 'def_rec'),
                               ('prior', 'prior_off', 'prior_def')):
                pred = mu + h * sub.H.values + key_o[oc].reindex(idx_o).values \
                    + key_o[dc].reindex(idx_d).values
                okp = ~np.isnan(pred)
                e2 = (sub.y.values - pred) ** 2
                w = sub.n.values if spec[2] != 'game' else np.ones(len(sub))
                o = out.setdefault((m, hz), [0.0, 0.0])
                o[0] += float(np.sum((w * e2)[okp])); o[1] += float(np.sum(w[okp]))
    return {'%s|%s' % k: v[0] / v[1] for k, v in out.items()}


def main():
    grid_scale = [0.25, 0.5, 1.0, 2.0, 4.0, 8.0]
    grid_hl = [2.0, 3.0, 5.0, 8.0]
    results = {}
    for sc in grid_scale:
        results['scale=%s' % sc] = score(TUNE_SEASONS, sc, [3.0], TUNE_METRICS)
        print(sc, {k: round(v, 5) for k, v in results['scale=%s' % sc].items() if k.endswith('season')})
    best_scale = {}
    for m in TUNE_METRICS:
        errs = {sc: results['scale=%s' % sc]['%s|season' % m] for sc in grid_scale}
        best_scale[m] = min(errs, key=errs.get)
    # one global scale: the one minimising the sum of RELATIVE errors across metrics
    rel = {sc: np.mean([results['scale=%s' % sc]['%s|season' % m]
                        / min(results['scale=%s' % s2]['%s|season' % m] for s2 in grid_scale)
                        for m in TUNE_METRICS]) for sc in grid_scale}
    g_scale = min(rel, key=rel.get)
    hl_res = {}
    for hl in grid_hl:
        hl_res['hl=%s' % hl] = score(TUNE_SEASONS, g_scale, [hl], TUNE_METRICS)
        print('hl', hl, {k: round(v, 5) for k, v in hl_res['hl=%s' % hl].items() if k.endswith('recent')})
    relh = {hl: np.mean([hl_res['hl=%s' % hl]['%s|recent' % m]
                         / hl_res['hl=%s' % hl]['%s|season' % m] for m in TUNE_METRICS]) for hl in grid_hl}
    g_hl = min(relh, key=relh.get)
    rep = {'seasons': TUNE_SEASONS, 'metrics': TUNE_METRICS, 'grid_prior_scale': grid_scale,
           'grid_halflife_weeks': grid_hl, 'next_game_mse_by_scale': results,
           'best_scale_by_metric': best_scale, 'relative_error_by_scale': rel,
           'chosen_prior_scale': g_scale, 'recent_vs_season_ratio_by_halflife': relh,
           'next_game_mse_by_halflife': hl_res, 'chosen_halflife_weeks': g_hl}
    common.write_json(common.out_path('report', 'tuning_ratings.json'), rep)
    print('chosen prior scale', g_scale, 'halflife', g_hl, relh)


if __name__ == '__main__' and len(sys.argv) == 1:
    main()


def main_batch(metrics, scales, seasons, tag):
    """Per-metric prior-scale search for a batch of metrics (season horizon only)."""
    res = {}
    for sc in scales:
        res[sc] = score(seasons, sc, [3.0], metrics)
        print(tag, sc, {k: round(v, 6) for k, v in res[sc].items() if k.endswith('season')}, flush=True)
    best = {m: min(scales, key=lambda s: res[s]['%s|season' % m]) for m in metrics}
    common.write_json(common.out_path('report', 'tuning_ratings_%s.json' % tag),
                      {'seasons': seasons, 'scales': scales, 'mse': {str(k): v for k, v in res.items()},
                       'best_scale_by_metric': best})
    print(tag, 'best', best, flush=True)


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'batch':
    main_batch(sys.argv[2].split(','), [1.0, 2.0, 4.0, 8.0], TUNE_SEASONS, sys.argv[3])
