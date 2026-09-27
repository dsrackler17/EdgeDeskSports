"""Future-poisoning test: the end-to-end leakage check.

    python3 -m v2.tests_poison [--season 2019] [--cut-week 7]      (exit 0 = green)

Unit tests catch the leaks someone thought of. This one catches the rest.
It rebuilds season S's point-in-time features twice from the same stage-1
tables: once clean, once after POISONING everything a pregame snapshot at the
cutoff T0 must not know —

  * every team-game and QB-game row that kicked off at/after T0 in season S
    and in every later season (EPA, success, drives, special teams, sacks,
    turnovers, starter flags: all randomised) — i.e. postgame EPA, future
    season averages and future opponent performance;
  * the final scores of those games (the target, and the Elo input);
  * returning production, talent and coaching of every later season
    (end-of-season / future roster information).

Every feature of every snapshot row with prediction_ts <= T0 must come out
bit-identical. Rows after T0 must change (proof the poison reached the
pipeline). A failure names the columns that moved: a season aggregate
recomputed with future games, an imputation statistic over the whole season,
a normalisation that reads later seasons.

The same idea at the model layer is `row_independence` below: a prediction
for a set of games must not depend on which OTHER games are predicted with
it (a median fill over the prediction batch is a leak of later weeks).
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

import numpy as np
import pandas as pd

from . import config as C
from . import common

ID_COLS = {'game_id', 'team_id', 'opp_id', 'season', 'qb_id', 'first_play'}


def _poison_frame(df, mask, rng, count_cols=()):
    df = df.copy()
    num = [c for c in df.columns if c not in ID_COLS and df[c].dtype.kind in 'fi' and c not in count_cols]
    k = int(mask.sum())
    for c in num:
        df[c] = df[c].astype(float)
        v = df.loc[mask, c].values
        df.loc[mask, c] = v * rng.uniform(-3, 3, k) + rng.normal(0, 5, k)
    if 'starter' in df:
        df.loc[mask, 'starter'] = rng.random(k) < 0.5
    return df


def build(S, out_dir, data_dir, poison_T0=None, seed=7):
    """Build season S snapshots into out_dir (stage1 copied from the clean OUT)."""
    from . import games as GM
    from . import build_ratings as BR
    from . import qb as QB
    from . import elo as EL
    from . import snapshots as SN
    clean_out, clean_data = C.OUT, C.DATA
    rng = np.random.default_rng(seed)
    os.makedirs(os.path.join(out_dir, 'stage1'), exist_ok=True)
    seasons = list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
    G0 = pd.read_parquet(os.path.join(clean_out, 'stage2', 'games.parquet'))
    ko = G0.set_index('game_id').kickoff_ts
    for Y in seasons:
        for kind in ('team_game', 'qb_game', 'games'):
            src = os.path.join(clean_out, 'stage1', '%s_%d.parquet' % (kind, Y))
            dst = os.path.join(out_dir, 'stage1', '%s_%d.parquet' % (kind, Y))
            df = pd.read_parquet(src)
            if poison_T0 is not None and Y >= S:
                k = pd.to_datetime(df.game_id.map(ko), utc=True)
                if kind == 'games':
                    k = pd.to_datetime(df.start_date, utc=True, errors='coerce')
                m = (k >= poison_T0).fillna(Y > S).values if Y == S else np.ones(len(df), bool)
                if kind == 'games':
                    df = df.copy()
                    fin = m & df.home_points.notna().values
                    df.loc[fin, 'home_points'] = rng.integers(0, 70, fin.sum())
                    df.loc[fin, 'away_points'] = rng.integers(0, 70, fin.sum())
                else:
                    df = _poison_frame(df, m, rng)
            df.to_parquet(dst, index=False)
    # prior inputs of later seasons (returning production, talent, coaching)
    os.makedirs(data_dir, exist_ok=True)
    for sub in os.listdir(clean_data):
        src = os.path.join(clean_data, sub)
        dst = os.path.join(data_dir, sub)
        if sub in ('retprod', 'talent', 'mline') and poison_T0 is not None:
            os.makedirs(dst, exist_ok=True)
            for f in os.listdir(src):
                d = pd.read_parquet(os.path.join(src, f))
                yr = int(''.join(ch for ch in f if ch.isdigit())[-4:])
                if yr > S:
                    for c in d.columns:
                        if c in ID_COLS or c.endswith('_id') or c in ('week', 'season'):
                            continue
                        if d[c].dtype.kind == 'f':
                            d[c] = rng.uniform(0, 1, len(d))
                        elif d[c].dtype.kind == 'i':
                            d[c] = rng.integers(0, 3, len(d)).astype(d[c].dtype)
                d.to_parquet(os.path.join(dst, f), index=False)
        elif not os.path.exists(dst):
            os.symlink(src, dst)
    C.OUT, C.DATA = out_dir, data_dir
    try:
        G, _ = GM.build_games(seasons)
        G.to_parquet(common.out_path('stage2', 'games.parquet'), index=False)
        BR.run(seasons_out=[S], verbose=False)
        Q, G2 = QB.load(seasons)
        Apast = QB.opponent_adjust_past(Q)
        shrink = QB.estimate_shrinkage(Apast, [2009, 2010, 2011, 2012, 2013])
        qb = QB.team_features(Q, Apast, G2, shrink, [S])
        snaps, fbs = EL.run_elo(G)
        elo = EL.game_features(G, snaps, fbs)
        X = SN.build_season(S, G, qb, elo)
    finally:
        C.OUT, C.DATA = clean_out, clean_data
    return X


def compare(Xc, Xp, T0):
    skip = {'status', 'margin', 'total_pts', 'home_points', 'away_points', 'kickoff_ts', 'prediction_ts',
            'feature_ts', 'start_date', 'completed', 'notes', 'feature_version', 'game_id'}
    cols = [c for c in Xc.columns if c in Xp.columns and c not in skip and Xc[c].dtype.kind in 'fib']
    a = Xc.set_index('game_id').sort_index()
    b = Xp.set_index('game_id').reindex(a.index)
    pre = (a.prediction_ts <= T0).values
    moved_pre, moved_post = {}, 0
    for c in cols:
        x, y = a[c].astype(float).values, b[c].astype(float).values
        same = (np.isclose(x, y, rtol=0, atol=1e-9) | (np.isnan(x) & np.isnan(y)))
        if (~same[pre]).any():
            moved_pre[c] = int((~same[pre]).sum())
        moved_post += int((~same[~pre]).sum())
    return cols, int(pre.sum()), moved_pre, moved_post


def row_independence():
    """Prediction-time transforms must not read OTHER rows of the batch."""
    from . import walkforward as WF
    from . import market as MKT
    rng = np.random.default_rng(3)
    n = 600
    D = pd.DataFrame({'early_season': rng.integers(0, 2, n).astype(float),
                      'min_games': rng.integers(0, 8, n).astype(float),
                      'rating_sd_sum': np.where(rng.random(n) < 0.2, np.nan, rng.uniform(0.5, 2, n)),
                      'ens_sd': rng.uniform(0.5, 5, n), 'ens_pred': rng.normal(0, 14, n),
                      'pred_total': rng.normal(55, 8, n), 'fcs_game': np.zeros(n, bool),
                      'qb_missing_any': np.where(rng.random(n) < 0.2, np.nan, 0.0),
                      'qb_unsettled_any': rng.integers(0, 2, n).astype(float),
                      'vol_sum': np.where(rng.random(n) < 0.2, np.nan, rng.uniform(0.5, 2, n)),
                      'to_dependence': np.where(rng.random(n) < 0.2, np.nan, rng.uniform(0, 3, n))})
    r = rng.normal(0, 14, n)
    sm = WF.SigmaModel().fit(D, r)
    head = D.iloc[:50]
    later = D.iloc[50:].copy()
    later[['rating_sd_sum', 'vol_sum', 'to_dependence']] *= 5.0          # the rest of the season changes
    s_alone = sm.predict(head)
    s_batch = sm.predict(pd.concat([head, later]))[:50]
    bad = []
    if not np.allclose(s_alone, s_batch):
        bad.append('SigmaModel.predict depends on the other rows in the batch')
    p = np.full(50, 0.55)
    a1 = MKT.cover_design(head, p)
    a2 = MKT.cover_design(pd.concat([head, later]), np.full(n, 0.55))[:50]
    if not np.allclose(a1, a2):
        bad.append('market.cover_design depends on the other rows in the batch')
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2019)
    ap.add_argument('--cut-week', type=int, default=7, help='cut at the k-th freeze of the season')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--report', default=None, help='also write the result as JSON here')
    a = ap.parse_args()
    fail = 0
    rep = {'season': a.season, 'cut_week': a.cut_week}
    bad = row_independence()
    rep['row_independence_failures'] = bad
    for b in bad:
        print('FAIL row_independence: ' + b)
    fail += len(bad)
    if not bad:
        print('ok   row_independence: sigma model and cover design read only their own row')
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    pts = sorted(G[G.season.eq(a.season)].prediction_ts.unique())
    T0 = pd.Timestamp(pts[a.cut_week])
    tmp = tempfile.mkdtemp(prefix='cfbv2_poison_')
    try:
        Xc = build(a.season, os.path.join(tmp, 'clean_out'), os.path.join(tmp, 'clean_data'), None)
        Xp = build(a.season, os.path.join(tmp, 'poison_out'), os.path.join(tmp, 'poison_data'), T0)
        cols, n_pre, moved, moved_post = compare(Xc, Xp, T0)
        rep.update(cutoff=str(T0), n_feature_columns=len(cols), n_pre_cutoff_rows=int(n_pre),
                   moved_pre_cutoff={c: int(k) for c, k in moved.items()}, moved_post_cutoff_values=int(moved_post))
        print('     season %d, cutoff %s: %d feature columns, %d pre-cutoff rows' % (a.season, T0, len(cols), n_pre))
        if moved:
            fail += 1
            print('FAIL future_poisoning: pre-cutoff features changed when only the future was poisoned:')
            for c, k in sorted(moved.items(), key=lambda kv: -kv[1])[:40]:
                print('       %-40s %d rows' % (c, k))
        else:
            print('ok   future_poisoning: every pre-cutoff feature is bit-identical')
        if moved_post == 0:
            fail += 1
            print('FAIL future_poisoning: the poison never reached the pipeline (post-cutoff rows unchanged)')
        else:
            print('ok   poison reached the pipeline: %d post-cutoff feature values changed' % moved_post)
    finally:
        if not a.keep:
            shutil.rmtree(tmp, ignore_errors=True)
    print('poison tests: %s' % ('FAILED' if fail else 'green'))
    if a.report:
        rep['result'] = 'FAILED' if fail else 'green'
        with open(a.report, 'w') as fh:
            json.dump(rep, fh, indent=1, sort_keys=True)
            fh.write('\n')
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
