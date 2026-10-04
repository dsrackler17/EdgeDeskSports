"""Model B — dynamic Elo / margin rating (results only, no play data).

A deliberately DIFFERENT lens from the efficiency models: it sees nothing but
final scores, so its errors are only partly correlated with theirs. That
diversity is what an ensemble is for.

    expected home margin = (elo_H - elo_A + HFA * (not neutral)) * PTS_PER_ELO
    update:  delta = K * mov_mult * (result - expected_win_prob)
    mov_mult = ln(min(|margin|, CAP) + 1) * 2.2 / (2.2 + 0.001 * elo_diff_of_winner)

The multiplier gives diminishing returns on blowouts and damps the
autocorrelation that makes favourites' margins run up Elo. Between seasons
every FBS rating regresses toward the FBS mean by CARRY. Non-FBS teams share a
pooled starting rating and move only through their games against FBS teams.

Snapshots are frozen at every prediction timestamp: a game is predicted from
the ratings as they stood at its week's Tuesday freeze.
"""
import math

import numpy as np
import pandas as pd

from . import config as C
from . import common

FBS_INIT = 1500.0
FCS_INIT = 1150.0


def run_elo(G, K=None, HFA=None, CARRY=None, CAP=None):
    K = C.ELO_K if K is None else K
    HFA = C.ELO_HFA if HFA is None else HFA
    CARRY = C.ELO_CARRY if CARRY is None else CARRY
    CAP = C.ELO_MOV_CAP if CAP is None else CAP
    G = G.sort_values(['kickoff_ts', 'game_id'])
    elo = {}
    season = None
    fbs_season = {}
    for S, g in G.groupby('season'):
        fbs_season[S] = set(g.loc[g.home_fbs, 'home_id']) | set(g.loc[g.away_fbs, 'away_id'])
    snaps = {}
    pts = sorted(G.prediction_ts.unique())
    games = list(G.itertuples(index=False))
    gi = 0
    out = []
    for T in pts:
        T = pd.Timestamp(T)
        # absorb every FINAL game that kicked off before T
        while gi < len(games) and games[gi].kickoff_ts < T:
            g = games[gi]; gi += 1
            if g.season != season:
                if season is not None:
                    fb = [t for t in elo if t in fbs_season.get(season, set())]
                    m = np.mean([elo[t] for t in fb]) if fb else FBS_INIT
                    for t in list(elo):
                        if t in fbs_season.get(g.season, set()):
                            elo[t] = FBS_INIT + CARRY * (elo[t] - m) if t in fb else FBS_INIT - 150
                season = g.season
            if g.status != 'FINAL':
                continue
            h, a = g.home_id, g.away_id
            eh = elo.get(h, FBS_INIT if h in fbs_season.get(g.season, set()) else FCS_INIT)
            ea = elo.get(a, FBS_INIT if a in fbs_season.get(g.season, set()) else FCS_INIT)
            d = eh - ea + (0.0 if g.neutral_site else HFA)
            pexp = 1.0 / (1.0 + 10 ** (-d / 400.0))
            margin = g.margin
            res = 1.0 if margin > 0 else (0.0 if margin < 0 else 0.5)
            wd = d if margin > 0 else -d
            mult = math.log(min(abs(margin), CAP) + 1.0) * 2.2 / (2.2 + 0.001 * wd)
            delta = K * mult * (res - pexp)
            elo[h] = eh + delta
            elo[a] = ea - delta
        snaps[T] = dict(elo)
    return snaps, fbs_season


def game_features(G, snaps, fbs_season, HFA=None):
    HFA = C.ELO_HFA if HFA is None else HFA
    rows = []
    for g in G.itertuples(index=False):
        s = snaps.get(pd.Timestamp(g.prediction_ts), {})
        fb = fbs_season.get(g.season, set())
        eh = s.get(g.home_id, FBS_INIT if g.home_id in fb else FCS_INIT)
        ea = s.get(g.away_id, FBS_INIT if g.away_id in fb else FCS_INIT)
        rows.append((g.game_id, eh, ea, eh - ea + (0.0 if g.neutral_site else HFA)))
    return pd.DataFrame(rows, columns=['game_id', 'elo_home', 'elo_away', 'elo_diff'])


def tune(G):
    """Grid search K, HFA, CARRY on DEV seasons: least-squares margin fit of elo_diff."""
    dev = list(C.DEV_SEASONS)
    C.assert_dev_only(dev)
    best = None
    grid = []
    for K in (30.0, 40.0, 50.0):
        for HFA in (40.0, 55.0, 70.0):
            for CARRY in (0.85, 0.9, 0.95, 1.0):
                snaps, fbs = run_elo(G[G.season <= max(dev)], K=K, HFA=HFA, CARRY=CARRY)
                F = game_features(G[G.season.isin(dev) & G.status.eq('FINAL')], snaps, fbs, HFA=HFA)
                F = F.merge(G[['game_id', 'margin', 'fcs_game']], on='game_id')
                F = F[~F.fcs_game]
                b = float(np.sum(F.elo_diff * F.margin) / np.sum(F.elo_diff ** 2))
                mae = float(np.mean(np.abs(F.margin - b * F.elo_diff)))
                grid.append(dict(K=K, HFA=HFA, CARRY=CARRY, pts_per_elo=b, mae=mae))
                if best is None or mae < best['mae']:
                    best = grid[-1]
    return best, grid


def main():
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    best, grid = tune(G)
    common.write_json(common.out_path('report', 'tuning_elo.json'), {'best': best, 'grid': grid})
    snaps, fbs = run_elo(G, K=best['K'], HFA=best['HFA'], CARRY=best['CARRY'])
    F = game_features(G, snaps, fbs, HFA=best['HFA'])
    F.to_parquet(common.out_path('stage4', 'elo.parquet'), index=False)
    print('[elo] best', best)


if __name__ == '__main__':
    main()
