"""Line movement, key-number resistance, market disagreement, the model-market
gap, movement toward EdgeDesk and an expected-close model
(brief sections 9-10, 13, 27, 32, 35, 38-39, 68; docs/cfb-market/METHODS.md).

    python3 -m v2.market_intel.movement

WHAT THE HISTORY ALLOWS. The archive has an OPENER and a CLOSE per game (the
opener without a timestamp), never the path between them. Every movement
statistic here is therefore opener -> close; intraday velocity, the number of
books moving, steam, repeated approaches to a number and the 72/48/24/12/6/2 h
horizons need timestamped multi-book quotes, which exist only in the Model
Lab's live ledger (football/cfb_market/market_intel.js computes them there).

Signs: every line is an INTERNAL home margin (+ = home favoured). A move
TOWARD EdgeDesk is (close - open) in the direction of (pure - open).
"""
import argparse

import numpy as np
import pandas as pd

from . import data as D

KEYS = (3, 7, 10, 14)


def week_bucket(w, post):
    return np.where(post, 'post', np.where(w <= 3, 'wk0-3', np.where(w <= 7, 'wk4-7', np.where(w <= 11, 'wk8-11', 'wk12+'))))


def base(X, seasons):
    Q = X[X.fbs_fbs & X.final & X.season.isin(seasons) & X.open_ok & X.close_margin.notna()
          & ~X.eval_open_close_jump.fillna(False).astype(bool)].copy()
    Q['move'] = Q.close_margin - Q.open_margin
    Q['abs_move'] = Q.move.abs()
    Q['wk'] = week_bucket(Q.week.values, Q.is_postseason.values)
    return Q.reset_index(drop=True)


def same_book(A, X, book_key, seasons):
    """one book's own opener -> close (the cleanest 'one book moved' series)."""
    S = A[(A.market_type == 'spread') & (A.book_key == book_key) & A.season.isin(seasons)]
    O = S[S.kind == 'OPEN'][['game_id', 'home_margin']].rename(columns={'home_margin': 'open'})
    C = S[S.kind == 'CLOSE'][['game_id', 'home_margin']].rename(columns={'home_margin': 'close'})
    J = O.merge(C, on='game_id').merge(X[['game_id', 'fbs_fbs', 'final', 'margin', 'season', 'week', 'is_postseason']], on='game_id')
    J = J[J.fbs_fbs & J.final & ((J.close - J.open).abs() < 14)].reset_index(drop=True)
    J['move'] = J.close - J.open
    J['fav_open'] = J.open.abs()
    J['fav_close'] = np.where(np.sign(J.open) == np.sign(J.close), J.close.abs(), -J.close.abs())   # favourite's number, + if still favoured
    return J


def move_distribution(Q, col='move'):
    bt = D.Boot(len(Q))
    am = Q[col].abs().values
    cells = [('0', am == 0), ('0.5', am == 0.5), ('1', am == 1), ('1.5', am == 1.5), ('2', am == 2),
             ('2.5-3', (am >= 2.5) & (am <= 3)), ('3.5-5', (am >= 3.5) & (am <= 5)), ('>5', am > 5)]
    out = {'n': int(len(Q)), 'mean_abs_move': D.cell(bt.mean(am), 3), 'median_abs_move': D.r(np.median(am), 2),
           'p90_abs_move': D.r(np.quantile(am, 0.9), 2),
           'shares': [{'abs_move': k, **D.cell(bt.mean(m.astype(float)), 4)} for k, m in cells]}
    return out


def move_by(Q, key):
    out = []
    bt = D.Boot(len(Q))
    for v in sorted(Q[key].dropna().unique(), key=str):
        m = (Q[key] == v).values
        out.append({key: str(v), 'n': int(m.sum()), 'mean_abs_move': D.cell(bt.mean(Q.abs_move.values, mask=m), 3),
                    'share_moved': D.cell(bt.mean((Q.abs_move.values > 0).astype(float), mask=m), 3)})
    return out


def stickiness(J):
    """How often a book's opener at value v is still v at the close, by v
    (the favourite's number). Key integers against other integers and half
    points; plus, for openers half a point off a key, whether the close lands
    ON the key, crosses it, or retreats."""
    J = J[J.fav_open > 0].reset_index(drop=True)
    bt = D.Boot(len(J))
    stay = (J.open == J.close).values.astype(float)
    fo = J.fav_open.values
    rows = []
    for v in [x / 2 for x in range(2, 35)]:
        m = fo == v
        if m.sum() < 30:
            continue
        rows.append({'open_fav_line': v, 'kind': 'key' if v in KEYS else ('integer' if v == int(v) else 'half'),
                     'stay_rate': D.cell(bt.mean(stay, mask=m), 3)})
    isint = fo == np.round(fo)
    iskey = np.isin(fo, KEYS)
    grp = {'key integers (3, 7, 10, 14)': iskey, 'other integers <= 17': isint & ~iskey & (fo <= 17),
           'half points <= 17': ~isint & (fo <= 17)}
    pooled = {k: D.cell(bt.mean(stay, mask=m), 3) for k, m in grp.items()}
    diff = bt.stat(lambda i: _grp_mean(stay[i], iskey[i]) - _grp_mean(stay[i], (isint & ~iskey & (fo <= 17))[i]))
    # half a point off a key: lands on it / crosses it / retreats
    around = []
    fc = J.fav_close.values
    for k in (3, 7, 10, 14, 4, 6, 8):
        for side, v in (('below', k - 0.5), ('above', k + 0.5)):
            m = fo == v
            if m.sum() < 30:
                continue
            toward = (fc - v) * (1 if side == 'below' else -1)       # + = moved toward k
            on = fc == k
            cross = toward > 0.5 + 1e-9
            around.append({'key': k, 'is_key': k in KEYS, 'opener': v, 'n': int(m.sum()),
                           'close_on_key': D.cell(bt.mean(on.astype(float), mask=m), 3),
                           'close_through_key': D.cell(bt.mean(cross.astype(float), mask=m), 3),
                           'close_unchanged': D.cell(bt.mean((fc == v).astype(float), mask=m), 3)})
    return {'n': int(len(J)), 'by_opener': rows, 'pooled_stay_rate': pooled,
            'stay_key_minus_other_integers': {'est': D.r(diff['est'], 3), 'ci': [D.r(diff['ci'][0], 3), D.r(diff['ci'][1], 3)]},
            'around_keys': around,
            'reading': 'resistance here means only that an opener ON a key number moves less often; repeated approach-and-retreat needs the intraday path'}


def _grp_mean(x, m):
    return float(x[m].mean()) if m.any() else np.nan


def gap_and_toward(Q):
    """model-market gap at the opener and the market's movement toward EdgeDesk."""
    Q = Q[Q.ens_pred.notna()].reset_index(drop=True)
    gap = (Q.ens_pred - Q.open_margin).values                  # + = EdgeDesk likes HOME vs the opener
    s = np.sign(gap)
    toward = Q.move.values * s                                 # + = the close moved toward EdgeDesk (= CLV of the model's side)
    moved = Q.move.values != 0
    ag = np.abs(gap)
    bt = D.Boot(len(Q))
    dist = {'n': int(len(Q)), 'mean_abs_gap': D.cell(bt.mean(ag), 3),
            'quantiles_abs_gap': {str(q): D.r(np.quantile(ag, q), 2) for q in (0.25, 0.5, 0.75, 0.9, 0.95, 0.99)},
            'share_abs_gap_ge': {str(t): D.cell(bt.mean((ag >= t).astype(float)), 3) for t in (1, 2, 3, 5, 7, 10, 14)},
            'model_favours_home_share': D.cell(bt.mean((gap > 0).astype(float)), 3),
            'model_favours_underdog_share': D.cell(bt.mean(((gap * np.sign(Q.open_margin.values)) < 0).astype(float), mask=Q.open_margin.values != 0), 3)}
    rows = []
    for lo, hi in ((0, 1), (1, 2), (2, 3), (3, 5), (5, 7), (7, 10), (10, 99)):
        m = (ag >= lo) & (ag < hi)
        rows.append({'abs_gap': '[%g, %g)' % (lo, hi), 'n': int(m.sum()),
                     'share_moved': D.cell(bt.mean(moved.astype(float), mask=m), 3),
                     'toward_given_moved': D.cell(bt.mean((toward > 0).astype(float), mask=m & moved), 3),
                     'mean_move_toward_pts': D.cell(bt.mean(toward, mask=m), 3),
                     'share_of_gap_closed': D.cell(bt.ratio(np.where(m, toward, 0), np.where(m, ag, 0)), 3)})
    slope = bt.stat(lambda i: np.sum(gap[i] * Q.move.values[i]) / max(np.sum(gap[i] * gap[i]), 1e-9))
    return {'distribution': dist, 'by_gap': rows,
            'move_per_point_of_gap': {'est': D.r(slope['est'], 3), 'ci': [D.r(slope['ci'][0], 3), D.r(slope['ci'][1], 3)]},
            'overall_toward_given_moved': D.cell(bt.mean((toward > 0).astype(float), mask=moved), 3),
            'overall_mean_move_toward': D.cell(bt.mean(toward), 3)}


def decay_by_segment(Q):
    """which EdgeDesk disagreements the market absorbs by the close:
    the slope of the move on the gap, by segment, and by submodel."""
    Q = Q[Q.ens_pred.notna()].reset_index(drop=True)
    gap = (Q.ens_pred - Q.open_margin).values
    mv = Q.move.values
    segs = {
        'week': Q.wk.values,
        'tier': np.where(Q.home_p4 & Q.away_p4, 'P4 v P4', np.where(Q.home_p4 | Q.away_p4, 'P4 v G5', 'G5 v G5')),
        'qb_unsettled': np.where(Q.qb_unsettled_any.fillna(0).values > 0, 'unsettled', 'settled'),
        'reliability': np.where(Q.reliability.values >= 70, 'high (>=70)', np.where(Q.reliability.values >= 45, 'mid', 'low (<45)')),
        'abs_open_line': np.where(Q.open_margin.abs().values <= 7, '<=7', np.where(Q.open_margin.abs().values <= 14, '7.5-14', '>14')),
    }
    out = {}
    for name, lab in segs.items():
        rows = []
        for v in sorted(set(lab)):
            m = lab == v
            if m.sum() < 60:
                continue
            g, y = gap[m], mv[m]
            bt = D.Boot(int(m.sum()))
            st = bt.stat(lambda i: np.sum(g[i] * y[i]) / max(np.sum(g[i] * g[i]), 1e-9))
            rows.append({name: str(v), 'n': int(m.sum()), 'move_per_point_of_gap': {'est': D.r(st['est'], 3), 'ci': [D.r(st['ci'][0], 3), D.r(st['ci'][1], 3)]}})
        out[name] = rows
    # submodels: which component's disagreement does the market move toward?
    gc = (Q.pred_C_ridge - Q.open_margin).values
    gd = (Q.pred_D_gbm - Q.open_margin).values
    ok = np.isfinite(gc) & np.isfinite(gd)
    Xm = np.column_stack([gc[ok], gd[ok]])
    y = mv[ok]
    bt = D.Boot(int(ok.sum()))
    coef = np.linalg.lstsq(Xm, y, rcond=None)[0]
    boots = np.array([np.linalg.lstsq(Xm[i], y[i], rcond=None)[0] for i in bt.idx[:500]])
    out['submodels_joint'] = {'n': int(ok.sum()),
                              'C_ridge_gap': {'est': D.r(coef[0], 3), 'ci': [D.r(np.quantile(boots[:, 0], 0.025), 3), D.r(np.quantile(boots[:, 0], 0.975), 3)]},
                              'D_gbm_gap': {'est': D.r(coef[1], 3), 'ci': [D.r(np.quantile(boots[:, 1], 0.025), 3), D.r(np.quantile(boots[:, 1], 0.975), 3)]}}
    return out


def expected_close(X):
    """expected_close_margin = open + b1 * gap + b2 * gap * [open on a key
    number] + b3 * gap * early, fit walk-forward (seasons < S), scored on S.
    Against the naive forecast (close = open): MAE, direction accuracy among
    lines that moved, calibration of the predicted move."""
    Q = base(X, list(range(2016, 2024)))
    Q = Q[Q.ens_pred.notna()].reset_index(drop=True)
    Q['gap'] = Q.ens_pred - Q.open_margin
    Q['on_key'] = np.isin(Q.open_margin.abs(), KEYS).astype(float)
    Q['early'] = Q.early_season.fillna(0).astype(float)
    feats = lambda F: np.column_stack([F.gap, F.gap * F.on_key, F.gap * F.early])
    preds = []
    coefs = {}
    for S in range(2018, 2024):
        tr, te = Q[Q.season < S], Q[Q.season == S]
        if len(tr) < 500 or not len(te):
            continue
        b = np.linalg.lstsq(feats(tr), tr.move.values, rcond=None)[0]
        coefs[S] = [D.r(x, 4) for x in b]
        p = te.open_margin.values + feats(te) @ b
        preds.append(pd.DataFrame({'game_id': te.game_id.values, 'season': S, 'pred_close': p, 'open': te.open_margin.values,
                                   'close': te.close_margin.values}))
    P = pd.concat(preds, ignore_index=True)
    bt = D.Boot(len(P))
    ae_m = np.abs(P.close - P.pred_close).values
    ae_n = np.abs(P.close - P.open).values
    pm = (P.pred_close - P.open).values
    am = (P.close - P.open).values
    moved = am != 0
    dir_ok = (np.sign(pm) == np.sign(am)).astype(float)
    cal = []
    q = np.quantile(pm, [0.1, 0.3, 0.5, 0.7, 0.9])
    bins = np.digitize(pm, q)
    for b_ in range(6):
        m = bins == b_
        cal.append({'bin': b_, 'n': int(m.sum()), 'pred_move': D.r(pm[m].mean(), 3), 'actual_move': D.cell(bt.mean(am, mask=m), 3)})
    return {'seasons_scored': sorted(int(s) for s in P.season.unique()), 'n': int(len(P)), 'coefficients_by_season': coefs,
            'features': ['gap', 'gap x opener on a key number', 'gap x early season'],
            'mae_model': D.r(ae_m.mean(), 3), 'mae_naive_open': D.r(ae_n.mean(), 3),
            'mae_model_minus_naive': D.cell(bt.mean(ae_m - ae_n), 4),
            'direction_accuracy_when_moved': D.cell(bt.mean(dir_ok, mask=moved), 3),
            'calibration_by_predicted_move': cal}


def dispersion_2023(A, X):
    """opener dispersion (two or more books open, 2023 only in DEV) against the
    size of the opener -> close move."""
    S = A[(A.market_type == 'spread') & (A.kind == 'OPEN') & A.is_book & (A.season == 2023)]
    g = S.groupby('game_id').home_margin.agg(['size', 'min', 'max', 'median']).reset_index()
    g = g[g['size'] >= 2]
    g['open_range'] = g['max'] - g['min']
    J = g.merge(X[['game_id', 'fbs_fbs', 'final', 'close_margin']], on='game_id')
    J = J[J.fbs_fbs & J.final & J.close_margin.notna()].reset_index(drop=True)
    J['abs_move'] = (J.close_margin - J['median']).abs()
    bt = D.Boot(len(J))
    rows = []
    for lo, hi, lab in ((0, 0.001, 'books agree'), (0.001, 1.001, '0.5-1 pt apart'), (1.001, 99, '>1 pt apart')):
        m = (J.open_range >= lo) & (J.open_range < hi)
        rows.append({'opener_range': lab, 'n': int(m.sum()), 'mean_abs_move_to_close': D.cell(bt.mean(J.abs_move.values, mask=m.values), 3)})
    return {'season': 2023, 'n': int(len(J)), 'rows': rows,
            'note': 'the only DEV season with two or more openers per game; 2024-2025 are holdout'}


def run():
    X = D.frame()
    A, _ = D.archive()
    Qa = base(X, (2016, 2017, 2018, 2019))
    Qb = base(X, (2021, 2022, 2023))
    Qd = base(X, D.DEV)
    J5 = same_book(A, X, '5dimessportbet', (2016, 2017, 2018, 2019))
    Jb = same_book(A, X, 'bovada', (2021, 2022, 2023))
    res = {
        'moves_consensus_2016_2019': move_distribution(Qa), 'moves_consensus_2021_2023': move_distribution(Qb),
        'moves_same_book_5dimes_2016_2019': move_distribution(J5), 'moves_same_book_bovada_2021_2023': move_distribution(Jb),
        'moves_by_week_dev': move_by(Qd, 'wk'),
        'stickiness_5dimes_2016_2019': stickiness(J5), 'stickiness_bovada_2021_2023': stickiness(Jb),
        'gap_and_toward_dev': gap_and_toward(Qd),
        'decay_by_segment_dev': decay_by_segment(Qd),
        'expected_close_dev': expected_close(X),
        'opener_dispersion_2023': dispersion_2023(A, X),
    }
    D.write_json('movement.json', res)
    return res


if __name__ == '__main__':
    argparse.ArgumentParser().parse_args()
    r = run()
    print('movement: slope toward model %s' % r['gap_and_toward_dev']['move_per_point_of_gap'])
