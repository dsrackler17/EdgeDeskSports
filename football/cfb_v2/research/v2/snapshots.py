"""Stage 5 — frozen pregame feature snapshots: `cfb_model_training_snapshots`.

One row per (game_id, prediction_ts, feature_version). Every column is either
  * a context identifier,
  * a PURE feature computed only from stage-3/4 state frozen at prediction_ts
    (the ratings themselves were solved from games that kicked off before it),
  * a TARGET (final points / margin / total) that never enters a model.
No market column exists in this table. Market data lives in
`cfb_market_training_snapshots`, built separately from stage2/market.parquet.

Opponent adjustment happens in stage 3, BEFORE any matchup feature is built
here. Matchup edges use standardized metric values — the ratings divided by
the metric's between-team SD — never rank numbers.
"""
import json
import os

import numpy as np
import pandas as pd

from . import config as C
from . import common

SIDE_COLS = ['off', 'def', 'off_var', 'def_var', 'off_rec', 'def_rec', 'prior_off', 'prior_def',
             'l4_off', 'l4_def', 'l2_off', 'l2_def', 'vol', 'n_obs_off', 'n_eff_off']

TARGETS = ['home_points', 'away_points', 'margin', 'total_pts']


def metric_scales(season):
    """Between-team SD of each metric's offence and defence ratings, from the
    data-only finals of seasons BEFORE `season` (point-in-time)."""
    fd = pd.read_parquet(common.out_path('stage3', 'final_dataonly.parquet'))
    fd = fd[fd.season.between(season - 3, season - 1)]
    sc = {}
    for m, g in fd.groupby('metric'):
        # robust SD (IQR / 1.349): the pooled non-FBS teams have extreme,
        # thinly-sampled ratings that would otherwise set the scale
        iqr = lambda x: float(np.subtract(*np.nanpercentile(x, [75, 25]))) / 1.349
        so, sd_ = iqr(g.off), iqr(g['def'])
        sc[m] = max(1e-6, (so + sd_) / 2.0)
    return sc


def wide_ratings(S):
    R = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S))
    cols = [c for c in SIDE_COLS if c in R.columns]
    W = R.pivot_table(index=['prediction_ts', 'team_id'], columns='metric', values=cols, aggfunc='first')
    W.columns = ['%s__%s' % (m, c) for c, m in W.columns]
    return W


def league(S):
    L = pd.read_parquet(common.out_path('stage3', 'league_%d.parquet' % S))
    W = L.pivot_table(index='prediction_ts', columns='metric', values=['mu', 'h'], aggfunc='first')
    W.columns = ['lg_%s__%s' % (m, c) for c, m in W.columns]
    return W


def edge(df, m, sign, scale, a='', b=''):
    """Standardized home-minus-away expected advantage on metric m.
    home offence faces away defence; away offence faces home defence."""
    ho, hd = df['h_%s__off%s' % (m, a)], df['h_%s__def%s' % (m, b)]
    ao, ad = df['a_%s__off%s' % (m, a)], df['a_%s__def%s' % (m, b)]
    return sign * ((ho + ad) - (ao + hd)) / scale


def build_season(S, G, qb, elo):
    g = G[G.season.eq(S)].copy()
    W = wide_ratings(S)
    Lg = league(S)
    sc = metric_scales(S)
    hw = W.add_prefix('h_')
    aw = W.add_prefix('a_')
    g = g.merge(hw, left_on=['prediction_ts', 'home_id'], right_index=True, how='left')
    g = g.merge(aw, left_on=['prediction_ts', 'away_id'], right_index=True, how='left')
    g = g.merge(Lg, left_on='prediction_ts', right_index=True, how='left')
    # ---------------------------------------------------------- QB
    q = qb[qb.season.eq(S)].drop(columns=['season'])
    qcols = [c for c in q.columns if c not in ('prediction_ts', 'team_id')]
    g = g.merge(q.rename(columns={c: 'h_' + c for c in qcols}),
                left_on=['prediction_ts', 'home_id'], right_on=['prediction_ts', 'team_id'],
                how='left').drop(columns=['team_id'])
    g = g.merge(q.rename(columns={c: 'a_' + c for c in qcols}),
                left_on=['prediction_ts', 'away_id'], right_on=['prediction_ts', 'team_id'],
                how='left').drop(columns=['team_id'])
    g = g.merge(elo, on='game_id', how='left')

    # ---------------------------------------------------------- matchup
    F = {}
    for name, num, den, kind, fam in C.METRICS:
        if name in C.STYLE_METRICS or ('h_%s__off' % name) not in g:
            continue
        sgn = -1.0 if name in C.NEGATIVE_METRICS else 1.0
        s = sc.get(name, 1.0)
        F['edge_%s' % name] = edge(g, name, sgn, s)
        F['edge_rec_%s' % name] = sgn * ((g['h_%s__off_rec' % name] + g['a_%s__def_rec' % name])
                                          - (g['a_%s__off_rec' % name] + g['h_%s__def_rec' % name])) / s
        F['edge_prior_%s' % name] = sgn * ((g['h_%s__prior_off' % name] + g['a_%s__prior_def' % name])
                                            - (g['a_%s__prior_off' % name] + g['h_%s__prior_def' % name])) / s
        F['form_%s' % name] = F['edge_rec_%s' % name] - F['edge_%s' % name]
    for m in ('st_net', 'fg_value'):
        if 'h_%s__off' % m in g:
            F['edge_%s' % m] = edge(g, m, 1.0, 1.0)          # already in points (EPA)
    F = pd.DataFrame(F, index=g.index)
    g = pd.concat([g, F], axis=1)

    # named matchup features from the dictionary contract
    ns = lambda m: sc.get(m, 1.0)
    pr_h = (g['lg_pass_rate__mu'] + g['h_pass_rate__off'] + g['a_pass_rate__def']).clip(0.2, 0.8)
    pr_a = (g['lg_pass_rate__mu'] + g['a_pass_rate__off'] + g['h_pass_rate__def']).clip(0.2, 0.8)
    home_pass = (g['h_epa_pass__off'] + g['a_epa_pass__def']) / ns('epa_pass')
    home_rush = (g['h_epa_rush__off'] + g['a_epa_rush__def']) / ns('epa_rush')
    away_pass = (g['a_epa_pass__off'] + g['h_epa_pass__def']) / ns('epa_pass')
    away_rush = (g['a_epa_rush__off'] + g['h_epa_rush__def']) / ns('epa_rush')
    g['match_pass_edge'] = g['edge_epa_pass']
    g['match_rush_edge'] = g['edge_epa_rush']
    g['match_mix_edge'] = (pr_h * home_pass + (1 - pr_h) * home_rush) - (pr_a * away_pass + (1 - pr_a) * away_rush)
    g['match_trench_edge'] = (g['edge_line_yds'] + g['edge_stuff'] + g['edge_opp_rate']) / 3.0
    g['match_havoc_edge'] = g['edge_havoc']
    g['match_sack_edge'] = g['edge_sack_rate']
    g['match_explosive_edge'] = g['edge_expl']
    g['match_early_down_edge'] = g['edge_sr_early']
    g['match_passing_down_edge'] = g['edge_sr_pd']
    g['match_finishing_edge'] = g['edge_pts_per_opp']
    g['match_field_pos_edge'] = g['edge_start_fp']
    g['match_st_edge'] = g.get('edge_st_net', np.nan)
    # strength-meets-weakness products (standardized): the home pass attack
    # against the away pass defence, and the reverse
    z = lambda c, m: g[c] / ns(m)
    g['x_pass_h'] = z('h_epa_pass__off', 'epa_pass') * z('a_epa_pass__def', 'epa_pass')
    g['x_pass_a'] = z('a_epa_pass__off', 'epa_pass') * z('h_epa_pass__def', 'epa_pass')
    g['x_rush_h'] = z('h_epa_rush__off', 'epa_rush') * z('a_epa_rush__def', 'epa_rush')
    g['x_rush_a'] = z('a_epa_rush__off', 'epa_rush') * z('h_epa_rush__def', 'epa_rush')
    g['x_sack_h'] = z('h_sack_rate__off', 'sack_rate') * z('a_sack_rate__def', 'sack_rate')
    g['x_sack_a'] = z('a_sack_rate__off', 'sack_rate') * z('h_sack_rate__def', 'sack_rate')
    # pace / possessions (additive, both teams make the tempo)
    g['exp_plays_total'] = (2 * g['lg_plays_pg__mu'] + g['h_plays_pg__off'] + g['a_plays_pg__def']
                            + g['a_plays_pg__off'] + g['h_plays_pg__def'])
    g['exp_drives_home'] = g['lg_drives_pg__mu'] + g['h_drives_pg__off'] + g['a_drives_pg__def']
    g['exp_drives_away'] = g['lg_drives_pg__mu'] + g['a_drives_pg__off'] + g['h_drives_pg__def']
    hppd = g['lg_ppd__mu'] + g['h_ppd__off'] + g['a_ppd__def'] + g['lg_ppd__h'] * (~g.neutral_site)
    appd = g['lg_ppd__mu'] + g['a_ppd__off'] + g['h_ppd__def'] - g['lg_ppd__h'] * (~g.neutral_site)
    g['drive_pts_home'] = hppd * g['exp_drives_home']
    g['drive_pts_away'] = appd * g['exp_drives_away']
    g['drive_margin_raw'] = g.drive_pts_home - g.drive_pts_away
    g['drive_total_raw'] = g.drive_pts_home + g.drive_pts_away
    # efficiency -> points (model A's input): net EPA per play edge x expected plays per team
    g['eff_pts_raw'] = ((g['h_epa__off'] + g['a_epa__def']) - (g['a_epa__off'] + g['h_epa__def'])
                        + 2 * g['lg_epa__h'] * (~g.neutral_site)) * g['exp_plays_total'] / 2.0

    # ---------------------------------------------- data quality / uncertainty
    g['home_games'] = g['h_epa__n_obs_off'].fillna(0)
    g['away_games'] = g['a_epa__n_obs_off'].fillna(0)
    g['min_games'] = np.minimum(g.home_games, g.away_games)
    g['rating_sd_sum'] = np.sqrt(g['h_epa__off_var'] + g['h_epa__def_var']
                                 + g['a_epa__off_var'] + g['a_epa__def_var']) / ns('epa')
    g['weeks_in'] = (g.prediction_ts - g.groupby('season').kickoff_ts.transform('min')).dt.days / 7.0
    g['early_season'] = (g.weeks_in < 5).astype(float)
    g['vol_sum'] = (g['h_epa__vol'].fillna(g['h_epa__vol'].median())
                    + g['a_epa__vol'].fillna(g['a_epa__vol'].median())) / ns('epa')
    g['to_dependence'] = (g['h_to_rate__off'].abs() + g['a_to_rate__off'].abs()) / ns('to_rate')
    g['qb_missing_any'] = g[['h_qb_missing', 'a_qb_missing']].fillna(1).max(axis=1)
    g['qb_unsettled_any'] = g[['h_qb_unsettled', 'a_qb_unsettled']].fillna(0).max(axis=1)
    g['qb_delta_edge'] = g['h_qb_delta'].fillna(0) - g['a_qb_delta'].fillna(0)
    g['qb_exp_edge'] = g['h_qb_exp_rating'] - g['a_qb_exp_rating']
    g['home_field'] = (~g.neutral_site).astype(float)
    g['feature_version'] = C.FEATURE_VERSION
    g['feature_ts'] = g.prediction_ts            # every feature is as-of this instant
    return g


def build_market_snapshots(G):
    M = pd.read_parquet(common.out_path('stage2', 'market.parquet'))
    X = G[['game_id', 'season', 'week', 'prediction_ts', 'kickoff_ts']].merge(M, on='game_id', how='inner')
    X['open_margin'] = X.spread_open           # internal convention (+ = home favoured)
    X['close_margin'] = X.spread_close         # EVALUATION ONLY
    X['line_move'] = X.close_margin - X.open_margin
    X['market_dispersion'] = X.spread_close_sd
    return X[['game_id', 'season', 'week', 'prediction_ts', 'kickoff_ts', 'open_margin', 'close_margin',
              'total_open', 'total_close', 'spread_books', 'market_dispersion', 'line_move', 'source',
              'has_open', 'has_close', 'spread_close_pin', 'spread_open_pin']]


def main(seasons=None):
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    qb = pd.read_parquet(common.out_path('stage4', 'qb_team.parquet'))
    elo = pd.read_parquet(common.out_path('stage4', 'elo.parquet'))
    seasons = seasons or list(range(C.FIRST_SNAPSHOT_SEASON, C.LIVE_SEASON + 1))
    frames = [build_season(S, G, qb, elo) for S in seasons]
    X = pd.concat(frames, ignore_index=True)
    X.to_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'), index=False)
    MK = build_market_snapshots(G)
    MK.to_parquet(common.out_path('stage5', 'cfb_market_training_snapshots.parquet'), index=False)
    print('[stage5] snapshots', X.shape, 'market', MK.shape)
    return X


if __name__ == '__main__':
    import sys
    main([int(a) for a in sys.argv[1:]] or None)
