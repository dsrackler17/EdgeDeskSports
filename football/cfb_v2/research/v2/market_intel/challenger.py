"""The market-informed CHALLENGER and the market residual (brief sections
42-44; docs/cfb-market/METHODS.md).

    python3 -m v2.market_intel.challenger

    market_adjusted_projection = w * pure + (1 - w) * market      (w learned walk-forward)

It is a SEPARATE Model Lab challenger. It never replaces, alters or feeds the
displayed EdgeDesk pure fair line; it answers "what is the best prediction of
the final margin using both EdgeDesk and the market", and so measures how much
information the market holds beyond EdgeDesk (and EdgeDesk beyond the market).

Point in time: the market input is the consensus OPENER, assumed available at
the Tuesday 12:00 UTC freeze (the archive has no opener timestamps; see
BACKTEST.md). The close is used only as a reference (what the hybrid would be
if the freeze saw the close) and to measure the market residual at the close.
Every weight is fit on seasons before the one it predicts; DEV 2016-2023 only.
"""
import argparse

import numpy as np
import pandas as pd

from .. import contract as K
from . import data as D

COND = ['early', 'rel_z', 'qb_unsettled', 'ens_sd_z']      # pre-registered conditioning variables


def population(X, seasons):
    Q = X[X.fbs_fbs & X.final & X.season.isin(seasons) & X.open_ok & X.ens_pred.notna()
          & ~X.eval_open_close_jump.fillna(False).astype(bool)].copy()
    Q['early'] = Q.early_season.fillna(0).astype(float)
    Q['rel_z'] = (Q.reliability.fillna(50) - 50.0) / 25.0
    Q['qb_unsettled'] = (Q.qb_unsettled_any.fillna(0) > 0).astype(float)
    Q['ens_sd_z'] = (Q.ens_sd.fillna(3.0) - 3.0) / 2.0
    Q['wk'] = np.where(Q.is_postseason, 'post', np.where(Q.week <= 3, 'wk0-3', np.where(Q.week <= 7, 'wk4-7', np.where(Q.week <= 11, 'wk8-11', 'wk12+'))))
    return Q.reset_index(drop=True)


def fit_w(pure, mkt, y):
    """least-squares weight on the pure model in w*pure + (1-w)*mkt, clipped to [0, 1]."""
    d = pure - mkt
    return float(np.clip(np.sum(d * (y - mkt)) / max(np.sum(d * d), 1e-9), 0.0, 1.0))


def fit_cond(Q, mkt_col):
    """w(x) = w0 + sum_j w_j x_j on the pre-registered variables (not clipped
    per game; the prediction is mkt + w(x) * (pure - mkt))."""
    d = (Q.ens_pred - Q[mkt_col]).values
    Xd = np.column_stack([d] + [d * Q[c].values for c in COND])
    return np.linalg.lstsq(Xd, (Q.margin - Q[mkt_col]).values, rcond=None)[0]


def pred_cond(Q, mkt_col, b):
    d = (Q.ens_pred - Q[mkt_col]).values
    w = b[0] + sum(b[j + 1] * Q[c].values for j, c in enumerate(COND))
    return Q[mkt_col].values + np.clip(w, 0.0, 1.0) * d, np.clip(w, 0.0, 1.0)


def walkforward(X):
    Q = population(X, D.DEV)
    rows = []
    wts = {}
    for S in range(2017, 2024):
        tr, te = Q[Q.season < S], Q[Q.season == S]
        if not len(te) or len(tr) < 400:
            continue
        w_o = fit_w(tr.ens_pred.values, tr.open_margin.values, tr.margin.values)
        trc, tec = tr[tr.close_margin.notna()], te[te.close_margin.notna()]
        w_c = fit_w(trc.ens_pred.values, trc.close_margin.values, trc.margin.values)
        b = fit_cond(tr, 'open_margin')
        pc, wcond = pred_cond(te, 'open_margin', b)
        wts[S] = {'w_open': D.r(w_o, 4), 'w_close': D.r(w_c, 4), 'cond': [D.r(x, 4) for x in b], 'n_train': int(len(tr))}
        rows.append(pd.DataFrame({
            'game_id': te.game_id.values, 'season': S, 'wk': te.wk.values, 'margin': te.margin.values,
            'pure': te.ens_pred.values, 'open': te.open_margin.values, 'close': te.close_margin.values,
            'hybrid_open': w_o * te.ens_pred.values + (1 - w_o) * te.open_margin.values,
            'hybrid_open_cond': pc, 'w_cond': wcond,
            'hybrid_close': w_c * te.ens_pred.values + (1 - w_c) * te.close_margin.values,
            'stage8_pred_ma': te.pred_ma.values}))
    return pd.concat(rows, ignore_index=True), wts


def scores(P, cols, ref):
    P = P.dropna(subset=cols + [ref]).reset_index(drop=True)
    bt = D.Boot(len(P))
    base_ae = np.abs(P.margin - P[ref]).values
    out = {'n': int(len(P)), 'reference': ref, 'rows': []}
    for c in cols:
        e = (P.margin - P[c]).values
        out['rows'].append({'model': c, 'mae': D.r(np.abs(e).mean(), 3), 'rmse': D.r(np.sqrt((e ** 2).mean()), 3),
                            'bias': D.r(e.mean(), 3), 'mae_minus_ref': D.cell(bt.mean(np.abs(e) - base_ae), 3)})
    return out


def market_residual(X):
    """Does EdgeDesk predict the market's error? slope of (margin - market) on
    (pure - market), at the opener and at the close, with a walk-forward
    out-of-sample R^2 (the fitted slope applied to the next season)."""
    Q = population(X, D.DEV)
    out = {}
    for label, col in (('opener', 'open_margin'), ('close', 'close_margin')):
        Z = Q[Q[col].notna()].reset_index(drop=True)
        g = (Z.ens_pred - Z[col]).values
        r_ = (Z.margin - Z[col]).values
        bt = D.Boot(len(Z))
        sl = bt.stat(lambda i: np.sum(g[i] * r_[i]) / max(np.sum(g[i] * g[i]), 1e-9))
        sse_m, sse_0 = 0.0, 0.0
        per = []
        for S in range(2017, 2024):
            tr, te = Z.season.values < S, Z.season.values == S
            if te.sum() == 0 or tr.sum() < 400:
                continue
            b = np.sum(g[tr] * r_[tr]) / np.sum(g[tr] * g[tr])
            e_m = r_[te] - b * g[te]
            per.append({'season': S, 'slope_train': D.r(b, 3), 'oos_r2': D.r(1 - np.sum(e_m ** 2) / np.sum(r_[te] ** 2), 4)})
            sse_m += np.sum(e_m ** 2)
            sse_0 += np.sum(r_[te] ** 2)
        out[label] = {'n': int(len(Z)), 'slope': {'est': D.r(sl['est'], 3), 'ci': [D.r(sl['ci'][0], 3), D.r(sl['ci'][1], 3)]},
                      'oos_r2_pooled': D.r(1 - sse_m / sse_0, 4), 'by_season': per}
    return out


def weight_by_segment(Q):
    """the in-DEV weight on EdgeDesk by week bucket and reliability, opener and close."""
    out = []
    for name, lab in (('week', Q.wk.values),
                      ('reliability', np.where(Q.reliability >= 70, 'high', np.where(Q.reliability >= 45, 'mid', 'low')))):
        for v in sorted(set(lab)):
            m = lab == v
            Z = Q[m].reset_index(drop=True)
            if len(Z) < 150:
                continue
            bt = D.Boot(len(Z))
            wo = bt.stat(lambda i: fit_w(Z.ens_pred.values[i], Z.open_margin.values[i], Z.margin.values[i]))
            Zc = Z[Z.close_margin.notna()].reset_index(drop=True)
            btc = D.Boot(len(Zc))
            wc = btc.stat(lambda i: fit_w(Zc.ens_pred.values[i], Zc.close_margin.values[i], Zc.margin.values[i]))
            out.append({'segment': name, 'value': str(v), 'n': int(len(Z)),
                        'w_pure_vs_open': {'est': D.r(wo['est'], 3), 'ci': [D.r(wo['ci'][0], 3), D.r(wo['ci'][1], 3)]},
                        'w_pure_vs_close': {'est': D.r(wc['est'], 3), 'ci': [D.r(wc['ci'][0], 3), D.r(wc['ci'][1], 3)]}})
    return out


def open_vs_close_weight(Q):
    """market weight at the opener vs at the close (1 - w): does the market's
    weight rise toward kickoff? Paired bootstrap on the same games."""
    Z = Q[Q.close_margin.notna()].reset_index(drop=True)
    bt = D.Boot(len(Z))
    p, o, c, y = Z.ens_pred.values, Z.open_margin.values, Z.close_margin.values, Z.margin.values
    d = bt.stat(lambda i: fit_w(p[i], c[i], y[i]) - fit_w(p[i], o[i], y[i]))
    return {'n': int(len(Z)), 'w_open': D.r(fit_w(p, o, y), 3), 'w_close': D.r(fit_w(p, c, y), 3),
            'w_close_minus_w_open': {'est': D.r(d['est'], 3), 'ci': [D.r(d['ci'][0], 3), D.r(d['ci'][1], 3)]},
            'reading': 'market weight at a horizon = 1 - w; a negative difference means the market weighs more at the close'}


def layer_guard():
    """the challenger's inputs are MARKET columns: the pure contract refuses them."""
    try:
        K.assert_pure(['ens_pred', 'open_margin'])
    except K.LayerViolation:
        return True
    return False


def run():
    X = D.frame()
    P, wts = walkforward(X)
    Q = population(X, D.DEV)
    cols = ['pure', 'open', 'hybrid_open', 'hybrid_open_cond', 'stage8_pred_ma', 'close', 'hybrid_close']
    res = {
        'walkforward_weights': wts,
        'scores_vs_open': scores(P, cols, 'open'),
        'scores_vs_pure': scores(P, ['pure', 'open', 'hybrid_open', 'hybrid_open_cond'], 'pure'),
        'hybrid_cond_minus_hybrid': scores(P, ['hybrid_open_cond'], 'hybrid_open'),
        'by_week': {wk: scores(P[P.wk == wk], ['pure', 'open', 'hybrid_open'], 'open') for wk in sorted(P.wk.unique())},
        'market_residual': market_residual(X),
        'weight_by_segment': weight_by_segment(Q),
        'open_vs_close_weight': open_vs_close_weight(Q),
        'layer_guard_refuses_market_inputs_in_pure': layer_guard(),
    }
    cond_better = res['hybrid_cond_minus_hybrid']['rows'][0]['mae_minus_ref']
    use_cond = cond_better['ci'][1] is not None and cond_better['ci'][1] < 0
    Qall = Q
    w_all = fit_w(Qall.ens_pred.values, Qall.open_margin.values, Qall.margin.values)
    b_all = fit_cond(Qall, 'open_margin')
    art = {'artifact': 'cfb_market_challenger_v1', 'schema': 'cfb_market_challenger_schema_v1',
           'label': 'MARKET-INFORMED CHALLENGER (Model Lab only): never the EdgeDesk fair line, never a pure input',
           'formula': 'market_adjusted_projection = market + w * (pure - market); market = the consensus opener at the Tuesday freeze (live: the consensus at the snapshot)',
           'w_pure': D.r(w_all, 4), 'conditional_used': bool(use_cond),
           'conditional': {'variables': COND, 'coef': [D.r(x, 5) for x in b_all],
                           'definitions': {'early': 'early_season flag', 'rel_z': '(reliability - 50) / 25', 'qb_unsettled': 'either QB unsettled',
                                           'ens_sd_z': '(ens_sd - 3) / 2'}},
           'fit': {'seasons': list(D.DEV), 'n_games': int(len(Qall)), 'population': 'FBS vs FBS completed with a usable opener',
                   'selection': 'the conditional weight is used only if its DEV walk-forward MAE beats the single weight with a CI entirely below zero'},
           'holdout': 'scored once by python3 -m v2.market_intel.replay --holdout'}
    D.write_artifact('challenger_v1.json', art)
    D.write_json('challenger.json', res)
    return res


if __name__ == '__main__':
    argparse.ArgumentParser().parse_args()
    r = run()
    print('challenger:', [(x['model'], x['mae']) for x in r['scores_vs_open']['rows']])
