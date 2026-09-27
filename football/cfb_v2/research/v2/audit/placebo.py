"""Audit items 47-50 — placebo features, label shuffle, future-feature injection, time reversal.

    python3 -m v2.audit.placebo     -> $CFB_V2_OUT/audit/placebo.json

Temporary audit models only (nothing here is production). They reuse V2.1's exact column lists and
hyperparameters (ridge C: alpha 30, standardized; GBM D: config.GBM_PARAMS) and are fitted
walk-forward for the holdout seasons 2024 and 2025 on FBS-vs-FBS FINAL rows of 2012..S-1.
"""
import json
import os

import numpy as np
import pandas as pd

from . import _io


def fit_predict(Xtr, ytr, Xte, cols_c, cols_d, gbm=True):
    from v2 import config as C
    from v2 import models as MD
    lin = MD.Linear(cols_c, alpha=C.RIDGE_ALPHA)
    # bypass the name contract on purpose (placebo/injected names are not in the allowlist)
    Z = Xtr[cols_c].astype(float)
    lin.mean_ = Z.mean(); lin.sd_ = Z.std().replace(0, 1.0).fillna(1.0)
    A = np.column_stack([np.ones(len(Z)), lin._X(Xtr)])
    P = np.eye(A.shape[1]) * lin.alpha; P[0, 0] = 0
    lin.beta_ = np.linalg.solve(A.T @ A + P, A.T @ ytr)
    pc = lin.predict(Xte)
    out = {'pred_C': pc, 'coef_C': dict(zip(['intercept'] + cols_c, lin.beta_))}
    if gbm:
        import lightgbm as lgb
        p = dict(C.GBM_PARAMS); n = p.pop('n_estimators')
        p.update(seed=C.SEED, bagging_seed=C.SEED, feature_fraction_seed=C.SEED)
        b = lgb.train(p, lgb.Dataset(Xtr[cols_d].astype(float).values, label=ytr), num_boost_round=n)
        out['pred_D'] = b.predict(Xte[cols_d].astype(float).values)
        g = b.feature_importance('gain')
        out['gain_D'] = dict(zip(cols_d, g / g.sum()))
    return out


def main():
    from v2 import models as MD, contract as K
    art = json.load(open(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json')))
    cols_c, cols_d = art['submodels']['C_ridge']['cols'], art['submodels']['D_gbm']['cols']
    X = pd.read_parquet(os.path.join(_io.out_dir(), 'stage5', 'cfb_model_training_snapshots.parquet'))
    X = MD.add_derived(X)
    MK = pd.read_parquet(os.path.join(_io.out_dir(), 'stage5', 'cfb_market_training_snapshots.parquet'))
    X = X.merge(MK[['game_id', 'close_margin']], on='game_id', how='left')
    mod = X[~X.fcs_game & X.status.eq('FINAL') & X.margin.notna()]
    rng = np.random.default_rng(_io.SEED)
    res = {'doc': __doc__}
    def mae(y, p):
        return float(np.mean(np.abs(np.asarray(y) - np.asarray(p))))
    base, plc, shf, inj, rev = [], [], [], [], []
    for S in _io.HOLD:
        tr = mod[(mod.season < S) & (mod.season >= 2012)].copy()
        te = mod[mod.season.eq(S)].copy()
        y = tr.margin.values.astype(float)
        b = fit_predict(tr, y, te, cols_c, cols_d)
        base.append((te.margin.values, (b['pred_C'] + b['pred_D']) / 2, b['pred_C'], b['pred_D']))
        # 47 placebo: 5 pure-noise columns added to both models
        pl = ['placebo_%d' % i for i in range(5)]
        for c in pl:
            tr[c] = rng.normal(size=len(tr)); te[c] = rng.normal(size=len(te))
        p = fit_predict(tr, y, te, cols_c + pl, cols_d + pl)
        zc = {c: abs(p['coef_C'][c]) for c in cols_c + pl}
        rank = pd.Series(zc).rank(ascending=False)
        plc.append({'season': S, 'mae_ens_with_placebo': mae(te.margin, (p['pred_C'] + p['pred_D']) / 2),
                    'mae_ens_without': mae(te.margin, (b['pred_C'] + b['pred_D']) / 2),
                    'ridge_abs_coef_placebo_max': float(max(zc[c] for c in pl)),
                    'ridge_abs_coef_real_median': float(np.median([zc[c] for c in cols_c])),
                    'ridge_best_placebo_rank_of_%d' % len(zc): float(min(rank[c] for c in pl)),
                    'gbm_gain_share_placebo_total': float(sum(p['gain_D'][c] for c in pl)),
                    'gbm_gain_share_real_median': float(np.median([p['gain_D'][c] for c in cols_d])),
                    'gbm_best_placebo_rank_of_%d' % (len(cols_d) + 5): float(min(pd.Series(p['gain_D']).rank(ascending=False)[c] for c in pl))})
        # 48 label shuffle: permute the training margins
        ys = rng.permutation(y)
        s = fit_predict(tr, ys, te, cols_c, cols_d)
        shf.append({'season': S, 'mae_shuffled_ens': mae(te.margin, (s['pred_C'] + s['pred_D']) / 2),
                    'mae_predict_train_mean': mae(te.margin, np.full(len(te), y.mean())),
                    'mae_real': mae(te.margin, (b['pred_C'] + b['pred_D']) / 2),
                    'sd_of_shuffled_predictions': float(np.std((s['pred_C'] + s['pred_D']) / 2))})
        # 49 future-feature injection
        e = {'season': S}
        try:
            K.assert_pure(cols_c + ['close_margin'])
            e['named_close_margin_rejected'] = False
        except K.LayerViolation:
            e['named_close_margin_rejected'] = True
        try:
            K.assert_pure(cols_c + ['final_margin_future'])
            e['unknown_name_rejected'] = False
        except K.LayerViolation:
            e['unknown_name_rejected'] = True
        # disguised: an ALLOWED name carrying the outcome
        tr2, te2 = tr.copy(), te.copy()
        tr2['edge_st_net'] = tr2.margin + rng.normal(0, 6, len(tr2)); te2['edge_st_net'] = te2.margin + rng.normal(0, 6, len(te2))
        try:
            K.assert_pure(cols_c)
            e['disguised_passes_name_contract'] = True
        except K.LayerViolation:
            e['disguised_passes_name_contract'] = False
        d = fit_predict(tr2, y, te2, cols_c, cols_d)
        e['mae_with_disguised_outcome'] = mae(te2.margin, (d['pred_C'] + d['pred_D']) / 2)
        e['mae_real'] = mae(te.margin, (b['pred_C'] + b['pred_D']) / 2)
        ok = te2.close_margin.notna()
        e['outcome_scan_flags_it'] = {
            'corr_with_margin_minus_close': float(np.corrcoef(te2.edge_st_net[ok], (te2.margin - te2.close_margin)[ok])[0, 1]),
            'r2_with_margin': float(np.corrcoef(te2.edge_st_net, te2.margin)[0, 1] ** 2),
            'close_r2_with_margin': float(np.corrcoef(te2.close_margin[ok], te2.margin[ok])[0, 1] ** 2)}
        tr3, te3 = tr.copy(), te.copy()
        tr3['edge_st_net'] = np.where(tr3.close_margin.notna(), tr3.close_margin, 0.0)
        te3['edge_st_net'] = np.where(te3.close_margin.notna(), te3.close_margin, 0.0)
        d3 = fit_predict(tr3, y, te3, cols_c, cols_d)
        e['mae_with_disguised_closing_line'] = mae(te3.margin, (d3['pred_C'] + d3['pred_D']) / 2)
        inj.append(e)
        # 50 time reversal: (a) train on every OTHER season incl. the future; (b) end-of-season ratings
        tr4 = mod[(mod.season != S) & (mod.season >= 2012) & (mod.season <= 2025)]
        r4 = fit_predict(tr4, tr4.margin.values.astype(float), te, cols_c, cols_d)
        fd = pd.read_parquet(os.path.join(_io.out_dir(), 'stage3', 'final_dataonly.parquet'))
        f = fd[fd.metric.isin(['epa', 'ppd', 'sr']) & fd.season.isin(range(2012, 2026))]
        piv = f.pivot_table(index=['season', 'team_id'], columns='metric', values=['off', 'def'])
        piv.columns = ['%s_%s' % (m, s) for s, m in piv.columns]
        def leak(df):
            h = piv.reindex(pd.MultiIndex.from_arrays([df.season, df.home_id])).reset_index(drop=True)
            a = piv.reindex(pd.MultiIndex.from_arrays([df.season, df.away_id])).reset_index(drop=True)
            o = pd.DataFrame(index=range(len(df)))
            for m in ('epa', 'ppd', 'sr'):
                o['leak_' + m] = (h['%s_off' % m] + a['%s_def' % m] - a['%s_off' % m] - h['%s_def' % m]).values
            o['home_field'] = df.home_field.values
            return o.fillna(0.0)
        Ltr, Lte = leak(tr), leak(te)
        lcols = ['home_field', 'leak_epa', 'leak_ppd', 'leak_sr']
        lr = fit_predict(Ltr, y, Lte, lcols, lcols, gbm=False)
        ptr = te[['home_field', 'edge_epa', 'edge_ppd', 'edge_sr']].fillna(0)
        pr = fit_predict(tr[['home_field', 'edge_epa', 'edge_ppd', 'edge_sr']].fillna(0), y, ptr,
                         ['home_field', 'edge_epa', 'edge_ppd', 'edge_sr'], [], gbm=False)
        rev.append({'season': S, 'mae_real_walk_forward': mae(te.margin, (b['pred_C'] + b['pred_D']) / 2),
                    'mae_trained_with_future_seasons': mae(te.margin, (r4['pred_C'] + r4['pred_D']) / 2),
                    'mae_point_in_time_4feature_ridge': mae(te.margin, pr['pred_C']),
                    'mae_end_of_season_ratings_4feature_ridge_LEAK': mae(te.margin, lr['pred_C'])})
    y_all = np.concatenate([b[0] for b in base])
    res['baseline_refit'] = {'mae_ens': mae(y_all, np.concatenate([b[1] for b in base])),
                             'mae_C': mae(y_all, np.concatenate([b[2] for b in base])),
                             'mae_D': mae(y_all, np.concatenate([b[3] for b in base]))}
    res['placebo'] = plc
    res['label_shuffle'] = shf
    res['future_injection'] = inj
    res['time_reversal'] = rev
    _io.write('placebo.json', res)
    print(json.dumps(res, indent=1, default=str)[:6000])


if __name__ == '__main__':
    main()
