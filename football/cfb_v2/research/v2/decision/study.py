"""The DEV-only calibration and decision-science study.

    python3 -m v2.decision.study        (after v2.decision.dataset)

Reads ONLY the DEV rows of out_h/decision/decision_dataset.parquet (a pyarrow
row filter: holdout and live outcomes are never materialized), runs every
section walk-forward, writes out_h/decision/*.json and the walk-forward frame,
then freezes the artifact (freeze.py) and renders docs/cfb-decision/CALIBRATION.md
(render.py).

Populations (FBS vs FBS, the consensus opener at an ASSUMED -110):
  PRICED    final, a side, a quote                                  (2016-2023; no 2020)
  DECISION  PRICED with a pure cover probability (2017+), minus the rows
            production routes to REVIEW (|gap| >= 14 or an orientation fault)
Walk-forward: season S is scored by maps fit on DECISION rows of seasons < S.
Scored seasons: 2018, 2019, 2021, 2022, 2023 (2017 only trains; 2020 has no openers).
Nothing here searches for a profitable rule: every threshold below is either a
declared bucket edge or the break-even of the price.
"""
import json
import math
import os
import time

import numpy as np
import pandas as pd

from .. import config as C
from . import core
from . import calibration as CAL
from . import dataset as DS

SCORED = [2018, 2019, 2021, 2022, 2023]
PRICED_SEASONS = [2017, 2018, 2019, 2021, 2022, 2023]
MIN_N_REPORT = 100            # below: INSUFFICIENT (shown, never used)
MIN_N_USE = 300               # at or above: ESTIMABLE (100-299: PROVISIONAL)
WINSOR_CLV = 10.0             # CLV target clipped at +/-10 pts when FITTING the magnitude model (declared)
COVER_BUCKETS = [(0.5, 0.525, '50-52.5'), (0.525, 0.55, '52.5-55'), (0.55, 0.575, '55-57.5'),
                 (0.575, 0.60, '57.5-60'), (0.60, 0.625, '60-62.5'), (0.625, 0.65, '62.5-65'), (0.65, 1.01, '65+')]
GAP_BUCKETS = [(0, 1, '<1'), (1, 2, '1-2'), (2, 3, '2-3'), (3, 4, '3-4'), (4, 5, '4-5'), (5, 7, '5-7'), (7, 99, '7+')]
EV_BUCKETS = [(-np.inf, 0.0, '<0'), (0.0, 0.01, '0-1%'), (0.01, 0.02, '1-2%'), (0.02, 0.03, '2-3%'),
              (0.03, 0.05, '3-5%'), (0.05, 0.07, '5-7%'), (0.07, np.inf, '7+%')]
EV_BUCKETS_EXT = EV_BUCKETS[:-1] + [(0.07, 0.10, '7-10%'), (0.10, 0.15, '10-15%'), (0.15, 0.25, '15-25%'),
                                    (0.25, np.inf, '25+%')]
REL_BANDS = [(-1, 40, '<40'), (40, 60, '40-60'), (60, 75, '60-75'), (75, 90, '75-90'), (90, 101, '90+')]
TIMING = ['wk0-3', 'wk4-7', 'wk8-11', 'late/post']
CLV_FEATURES = ['gap_pts', 'pure_cover_prob', 'reliability', 'ens_sd', 'early_season']
CLV_DIAG = ['archive_book_count', 'market_dispersion_close']
FOOT_FEATURES = ['sigma', 'ens_sd', 'early_season', 'qb_missing', 'qb_unsettled']
MKT_FEATURES = ['abs_line', 'total_line', 'early_season']
BE_110 = float(core.break_even(core.ASSUMED_PRICE))


def out(*p):
    return os.path.join(DS.out_dir(), *p)


def dump(name, obj):
    with open(out(name), 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=_js)
        f.write('\n')


def _js(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (pd.Timestamp,)):
        return o.isoformat()
    raise TypeError(type(o))


def r(x, k=4):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, k) if math.isfinite(x) else None


def rl(v, k=4):
    return [r(x, k) for x in v] if v is not None else None


# ------------------------------------------------------------------ load
def load_dev():
    """DEV rows only — a pyarrow row filter, so no holdout/live row is ever read."""
    D = pd.read_parquet(out('decision_dataset.parquet'), filters=[('window', '==', 'dev')])
    assert set(D.window) == {'dev'} and not set(D.season) & (set(C.HOLDOUT_SEASONS) | {C.LIVE_SEASON})
    return D


def populations(D):
    fbs = D[D.pricing_scope.eq('FBS_FBS')]
    priced = fbs[fbs.quote_role.eq('CONSENSUS_OPEN') & fbs.status.eq('FINAL') & fbs.side.notna()].copy()
    decision = priced[priced.pure_cover_prob.notna() & ~priced.review_route].copy()
    review = priced[priced.review_route & priced.pure_cover_prob.notna()].copy()
    g = fbs[fbs.quote_role.isin(['CONSENSUS_OPEN', 'NONE'])].drop_duplicates('game_id')
    games = g[g.status.eq('FINAL') & g.sigma.notna() & g.final_margin.notna()].copy()
    return priced, decision, review, games


def sample_status(n):
    return 'INSUFFICIENT' if n < MIN_N_REPORT else ('PROVISIONAL' if n < MIN_N_USE else 'ESTIMABLE')


# ----------------------------------------------------------------- blocks
def block(d, p_dec='p_dec', boot=True, dd=True):
    """Every outcome statistic of a slice, with CIs. Pushes are excluded from
    cover rates and counted; units at the ASSUMED -110."""
    d = d.sort_values('kickoff_ts', kind='mergesort')
    n = len(d)
    y = d.ats_win.values
    nonpush = np.isfinite(y)
    k, m = float(np.nansum(y)), int(nonpush.sum())
    o = {'n': n, 'wins': int(k), 'losses': int(m - k), 'pushes': int(np.nansum(d.is_push.values)),
         'sample_status': sample_status(n)}
    o['cover_rate'] = r(k / m) if m else None
    o['cover_wilson'] = rl(core.wilson(k, m)) if m else None
    o['cover_boot'] = rl(core.boot_ci(y[nonpush])) if boot else None
    pp = d.pure_cover_prob.values.astype(float)
    okp = nonpush & np.isfinite(pp)
    o['mean_p_pure'] = r(np.nanmean(pp)) if np.isfinite(pp).any() else None
    if okp.any():
        o['n_pure'] = int(okp.sum())
        o['brier_pure'] = r(core.brier(y[okp], pp[okp]).mean())
        o['logloss_pure'] = r(core.log_loss(y[okp], pp[okp]).mean())
        o['cal_err_pure'] = r(pp[okp].mean() - y[okp].mean())
    if p_dec in d and d[p_dec].notna().any():
        pdv = d[p_dec].values
        ok = nonpush & np.isfinite(pdv)
        o['n_dec'] = int(np.isfinite(pdv).sum())
        o['mean_p_dec'] = r(np.nanmean(pdv))
        if ok.any():
            o['brier_dec'] = r(core.brier(y[ok], pdv[ok]).mean())
            o['logloss_dec'] = r(core.log_loss(y[ok], pdv[ok]).mean())
            o['cal_err_dec'] = r(pdv[ok].mean() - y[ok].mean())
    u = d.units_assumed_110.values
    o['roi'] = r(np.nanmean(u))
    o['roi_ci'] = rl(core.boot_ci(u)) if boot else None
    o['units'] = r(np.nansum(u), 2)
    c = d.clv_pts.values
    o['clv'] = r(np.nanmean(c), 3)
    o['clv_ci'] = rl(core.boot_ci(c), 3) if boot else None
    pc = d.positive_clv.values
    o['pos_clv'] = r(np.nanmean(pc))
    o['pos_clv_wilson'] = rl(core.wilson(np.nansum(pc), np.isfinite(pc).sum())) if np.isfinite(pc).any() else None
    mt = d.moved_toward_model.values
    nm = int(np.isfinite(mt).sum())
    o['moved_n'] = nm
    o['moved_toward'] = r(np.nanmean(mt)) if nm else None
    o['moved_toward_wilson'] = rl(core.wilson(np.nansum(mt), nm)) if nm else None
    o['mae_model'] = r(d.abs_error_model.mean(), 3)
    o['mae_quote'] = r(d.abs_error_quote.mean(), 3)
    if boot:
        pd_ = core.boot_paired_diff(d.abs_error_model.values, d.abs_error_quote.values)
        o['mae_model_minus_quote'] = r(pd_['mean'], 3)
        o['mae_model_minus_quote_ci'] = rl(pd_['ci'], 3)
    o['mean_abs_gap'] = r(d.abs_gap_pts.mean(), 3)
    if dd:
        o['max_drawdown'] = r(core.max_drawdown(u), 2)
        o['max_drawdown_ci'] = rl(core.boot_drawdown_ci(u), 2) if boot else None
    return o


def add_eb(rows):
    """Minimum-sample rule + hierarchical shrinkage across the buckets of one table:
    beta-binomial EB for the cover rate, normal-normal EB for ROI and CLV."""
    live = [x for x in rows if x.get('n')]
    if len(live) < 2:
        return rows
    k = [x['wins'] for x in live]
    n = [x['wins'] + x['losses'] for x in live]
    shr, kap, p0 = CAL.eb_beta_binomial(k, n)
    for x, v in zip(live, shr):
        x['cover_eb'] = r(v)
    for key, ci in (('roi', 'roi_ci'), ('clv', 'clv_ci')):
        means = [x[key] if x[key] is not None else np.nan for x in live]
        ses = [((x[ci][1] - x[ci][0]) / 3.92) if x.get(ci) and x[ci][0] is not None else np.nan for x in live]
        s, tau2, m0 = CAL.eb_normal(means, ses)
        for x, v in zip(live, s):
            x[key + '_eb'] = r(v, 4)
    for x in live:
        x['eb_note'] = 'cover_eb: beta-binomial EB (kappa %.0f toward %.4f); roi_eb/clv_eb: normal-normal EB' % (kap or 0, p0 or 0)
    return rows


def bucket_table(d, col, buckets, p_dec='p_dec', boot=True):
    rows = []
    for lo, hi, lab in buckets:
        s = d[(d[col] >= lo) & (d[col] < hi)]
        b = block(s, p_dec, boot=boot) if len(s) else {'n': 0}
        b['bucket'] = lab
        rows.append(b)
    return add_eb(rows)


def group_table(d, col, groups, p_dec='p_dec'):
    rows = []
    for g in groups:
        s = d[d[col] == g]
        b = block(s, p_dec) if len(s) else {'n': 0}
        b['bucket'] = g
        rows.append(b)
    return add_eb(rows)


def prob_metrics(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    e, tab = core.ece(y, p)
    fixed = []
    for lo, hi, lab in COVER_BUCKETS:
        s = (p >= lo) & (p < hi)
        if s.sum():
            fixed.append((s.sum(), abs(p[s].mean() - y[s].mean())))
    ece_fixed = sum(n * a for n, a in fixed) / max(1, sum(n for n, _ in fixed))
    return {'n': int(len(y)), 'log_loss': r(core.log_loss(y, p).mean(), 5), 'brier': r(core.brier(y, p).mean(), 5),
            'ece_adaptive10': r(e), 'ece_fixed_buckets': r(ece_fixed), 'mean_p': r(p.mean()), 'cover_rate': r(y.mean()),
            'cal_in_the_large': r(p.mean() - y.mean()), 'reliability_table': [{k: r(v) for k, v in t.items()} for t in tab]}


# ============================================================ sections
def s05_methods(W):
    """Continuous walk-forward calibration: every map fit on seasons < S."""
    Y = W[W.ats_win.notna()]
    specs = {
        'market': (lambda tr: {'w': 0.0}, lambda m, c: np.full(len(c), 0.5), True, 0),
        'identity': (lambda tr: None, lambda m, c: c.pure_cover_prob.values, True, 0),
        'shrink': (lambda tr: CAL.fit_shrink(tr.pure_cover_prob.values, tr.ats_win.values),
                   lambda m, c: CAL.shrink_np(c.pure_cover_prob.values, 0.5, m['w']), True, 1),
        'logit_pwl': (lambda tr: CAL.fit_logit_pwl(tr.pure_cover_prob.values, tr.ats_win.values),
                      lambda m, c: CAL.apply_map_np(m, c.pure_cover_prob.values), True, 5),
        'isotonic': (lambda tr: CAL.fit_isotonic_symmetric(tr.pure_cover_prob.values, tr.ats_win.values),
                     lambda m, c: CAL.apply_map_np(m, c.pure_cover_prob.values), True, None),
        'platt': (lambda tr: CAL.fit_platt(tr.pure_cover_prob.values, tr.ats_win.values),
                  lambda m, c: CAL.apply_map_np(m, c.pure_cover_prob.values), False, 2),
        'beta': (lambda tr: CAL.fit_beta(tr.pure_cover_prob.values, tr.ats_win.values),
                 lambda m, c: CAL.apply_map_np(m, c.pure_cover_prob.values), False, 3),
        'isotonic_fold': (lambda tr: CAL.fit_isotonic_fold(tr.pure_cover_prob.values, tr.ats_win.values),
                          lambda m, c: CAL.apply_map_np(m, c.pure_cover_prob.values), False, None),
    }
    order = ['market', 'identity', 'shrink', 'logit_pwl', 'isotonic']       # parsimony order (eligible maps)
    preds, fits, res = {}, {}, {}
    for k, (f, p, elig, npar) in specs.items():
        pr, fi = CAL.walk_forward(Y, SCORED, f, p, min_train=300)
        full = {}
        for S in SCORED:
            cur = W[W.season == S]
            full[S] = p(fi[S], cur)
        preds[k] = pd.Series(np.concatenate([full[S] for S in SCORED]),
                             index=np.concatenate([W[W.season == S].index for S in SCORED]))
        fits[k] = fi
        yy = W.loc[preds[k].index, 'ats_win']
        res[k] = dict(prob_metrics(yy.values, preds[k].values), eligible=elig, n_params=npar,
                      by_season={int(S): prob_metrics(W[W.season == S].ats_win.values, full[S])['log_loss'] for S in SCORED})
    ll = {k: core.log_loss(W.loc[preds[k].index, 'ats_win'].values, preds[k].values) for k in preds}
    mask = np.isfinite(W.loc[preds['market'].index, 'ats_win'].values)
    best = min((k for k in order), key=lambda k: np.nanmean(ll[k][mask]))
    for k in preds:
        d = ll[k][mask] - ll[best][mask]
        bd = core.boot_paired_diff(ll[k][mask], ll[best][mask])
        res[k]['dll_vs_best_eligible'] = r(d.mean(), 6)
        res[k]['dll_se'] = r(d.std(ddof=1) / math.sqrt(len(d)), 6)
        res[k]['dll_ci'] = rl(bd['ci'], 6)
        dm = ll[k][mask] - ll['market'][mask]
        res[k]['dll_vs_market'] = r(dm.mean(), 6)
        res[k]['dll_vs_market_ci'] = rl(core.boot_paired_diff(ll[k][mask], ll['market'][mask])['ci'], 6)
    chosen = None
    for k in order:
        if res[k]['dll_vs_best_eligible'] <= (res[k]['dll_se'] or 0) + 1e-12:
            chosen = k
            break
    rule = ('lowest pooled walk-forward log loss among SIDE-SYMMETRIC maps (f(1-p) = 1 - f(p), required because '
            'decision.js applies one map to each side); the first map in the parsimony order market -> identity -> '
            'shrink -> logit_pwl -> isotonic whose paired log-loss excess over the best is within 1 SE is chosen. '
            'Platt-with-intercept, 3-parameter beta and the unreflected isotonic are diagnostics (asymmetric).')
    return {'methods': res, 'best_eligible': best, 'chosen': chosen, 'rule': rule,
            'scored_seasons': SCORED, 'n_scored_nonpush': int(mask.sum())}, preds, fits


def shrink_by_season(W):
    Y = W[W.ats_win.notna()]
    wf, local = {}, {}
    for S in SCORED:
        tr = Y[Y.season < S]
        CAL.assert_past_only(CAL.assert_fit_rows(tr), S)
        f = CAL.fit_shrink(tr.pure_cover_prob.values, tr.ats_win.values)
        wf[int(S)] = {k: (r(v) if not isinstance(v, list) else rl(v)) for k, v in f.items()}
    for S in PRICED_SEASONS:
        s = Y[Y.season == S]
        f = CAL.fit_shrink(s.pure_cover_prob.values, s.ats_win.values, bounded=False)
        local[int(S)] = {k: (r(v) if not isinstance(v, list) else rl(v)) for k, v in f.items()}
    CAL.assert_fit_rows(Y)
    pooled = CAL.fit_shrink(Y.pure_cover_prob.values, Y.ats_win.values)
    rng = np.random.default_rng(C.SEED)
    x, yv = Y.pure_cover_prob.values, Y.ats_win.values
    bw = []
    for _ in range(500):
        i = rng.integers(0, len(x), len(x))
        bw.append(CAL.fit_shrink(x[i], yv[i], bounded=False)['w_unbounded'])
    from scipy import stats
    lw = [local[S]['w_unbounded'] for S in PRICED_SEASONS]
    lse = [(local[S]['w_ci95_profile'][1] - local[S]['w_ci95_profile'][0]) / 3.92 for S in PRICED_SEASONS]
    wbar = np.average(lw, weights=1 / np.square(lse))
    q = float(np.sum(np.square((np.array(lw) - wbar) / np.array(lse))))
    return {'walk_forward': wf, 'per_season_local': local,
            'pooled_dev': {k: (r(v) if not isinstance(v, list) else rl(v)) for k, v in pooled.items()},
            'pooled_bootstrap_ci95': [r(np.quantile(bw, 0.025)), r(np.quantile(bw, 0.975))],
            'pooled_p_w0': r(stats.chi2.sf(pooled['lr_w0'], 1), 5), 'pooled_p_w1': r(stats.chi2.sf(pooled['lr_w1'], 1), 8),
            'heterogeneity_Q': r(q), 'heterogeneity_df': len(lw) - 1,
            'heterogeneity_p': r(stats.chi2.sf(q, len(lw) - 1)),
            'inverse_variance_mean_local_w': r(wbar)}


def decision_frame(W, s5, preds, fits):
    """The walk-forward calibrated and decision probabilities of the scored seasons."""
    chosen = s5['chosen']
    W = W.copy()
    W['p_cal'] = np.nan
    W['p_dec'] = np.nan
    W['w_used'] = np.nan
    if chosen in ('shrink', 'market', 'identity'):
        idx = preds[chosen].index
        W.loc[idx, 'p_cal'] = W.loc[idx, 'pure_cover_prob']
        W.loc[idx, 'p_dec'] = preds[chosen].values
        for S in SCORED:
            m = W.season.eq(S)
            W.loc[m, 'w_used'] = {'shrink': (fits['shrink'][S] or {}).get('w'), 'market': 0.0, 'identity': 1.0}[chosen]
    else:
        W.loc[preds[chosen].index, 'p_cal'] = preds[chosen].values
        for S in SCORED:
            tr = W[(W.season < S) & W.p_cal.notna() & W.ats_win.notna()]
            m = W.season.eq(S)
            w = CAL.fit_shrink(tr.p_cal.values, tr.ats_win.values)['w'] if len(tr) > 300 else 1.0
            W.loc[m, 'w_used'] = w
            W.loc[m, 'p_dec'] = CAL.shrink_np(W.loc[m, 'p_cal'].values, 0.5, w)
    W['decision_ev'] = core.ev_with_push(W.p_dec.values, W.push_prob.fillna(0).values, core.ASSUMED_PRICE)
    W['probability_edge'] = W.p_dec - BE_110
    return W


def nested_w_on_top(W, preds):
    """Residual shrinkage each map still needs: w fit on the map's OWN out-of-sample outputs of earlier seasons."""
    outp = {}
    for k in ('logit_pwl', 'isotonic', 'platt', 'beta'):
        s = pd.Series(preds[k])
        df = W.loc[s.index].assign(p_cal=s.values)
        df = df[df.ats_win.notna()]
        by = {}
        for S in SCORED[1:]:
            tr = df[df.season < S]
            by[int(S)] = r(CAL.fit_shrink(tr.p_cal.values, tr.ats_win.values)['w'])
        allf = CAL.fit_shrink(df.p_cal.values, df.ats_win.values)
        outp[k] = {'walk_forward': by, 'pooled_oos': r(allf['w']), 'pooled_ci95': rl(allf['w_ci95_profile'])}
    return outp


def s04_buckets(Wd):
    sc = Wd[Wd.season.isin(SCORED)]
    pure = bucket_table(sc, 'pure_cover_prob', COVER_BUCKETS)
    dec = bucket_table(sc, 'p_dec', COVER_BUCKETS)
    by_season = {}
    for S in PRICED_SEASONS:
        s = Wd[Wd.season == S]
        by_season[int(S)] = [dict(bucket=lab, **{k: v for k, v in block(s[(s.pure_cover_prob >= lo) & (s.pure_cover_prob < hi)],
                                                                          boot=False, dd=False).items()
                                                  if k in ('n', 'cover_rate', 'mean_p_pure', 'pushes')})
                             for lo, hi, lab in COVER_BUCKETS]
    pure_all = bucket_table(Wd, 'pure_cover_prob', COVER_BUCKETS, p_dec='__none__', boot=True)
    return {'pure_buckets_scored': pure, 'decision_buckets_scored': dec, 'pure_buckets_2017_2023': pure_all,
            'pure_by_season': by_season,
            'overall_scored': block(sc), 'note': 'side = the side the pure model prefers; pushes excluded from cover rates and counted'}


def conditional_tests(Wd, W_all):
    """Sections 6-9: conditional tables + the evidence test for a conditional map."""
    Y = W_all[W_all.ats_win.notna()].copy()
    ens_edges = [float(np.quantile(W_all.ens_sd, 1 / 3)), float(np.quantile(W_all.ens_sd, 2 / 3))]

    def rel_band(v):
        for lo, hi, lab in REL_BANDS:
            if lo <= v < hi:
                return lab
        return None

    def gap_band(v):
        for lo, hi, lab in GAP_BUCKETS:
            if lo <= v < hi:
                return lab
        return None

    def ens_band(v):
        return 'low' if v < ens_edges[0] else ('mid' if v < ens_edges[1] else 'high')

    groupers = {
        'reliability': (lambda d: d.reliability.map(rel_band), [b[2] for b in REL_BANDS], 'reliability',
                        [40, 60, 75, 90]),
        'ens_sd_tercile': (lambda d: d.ens_sd.map(ens_band), ['low', 'mid', 'high'], 'ens_sd', ens_edges),
        'timing': (lambda d: d.timing_bucket, TIMING, None, None),
        'gap': (lambda d: d.abs_gap_pts.map(gap_band), [b[2] for b in GAP_BUCKETS], 'abs_gap_pts', [1, 2, 3, 4, 5, 7]),
    }
    outd = {}
    n_tests = len(groupers)
    sc = Wd[Wd.season.isin(SCORED)].copy()
    for name, (fn, groups, feat, edges) in groupers.items():
        Y['_g'] = fn(Y).values
        sc['_g'] = fn(sc).values
        x, yv, g = Y.pure_cover_prob.values, Y.ats_win.values, Y._g.values
        single = CAL.fit_shrink(x, yv, bounded=False)
        ll1 = CAL.nll(single['w_unbounded'] * core.logit(x), yv)
        ws, llg = CAL.fit_group_shrink(x, yv, g)
        G = len(set(g))
        lr = CAL.lr_test(ll1, llg, G - 1)
        # walk-forward: group weights (groups with < 150 training rows fall back to the single weight)
        dll = []
        for S in SCORED:
            tr = Y[Y.season < S]
            CAL.assert_past_only(CAL.assert_fit_rows(tr), S)
            cur = Y[Y.season == S]
            w1 = CAL.fit_shrink(tr.pure_cover_prob.values, tr.ats_win.values)['w']
            wg = {}
            for gg in set(tr._g):
                m = tr._g.values == gg
                wg[gg] = CAL.fit_shrink(tr.pure_cover_prob.values[m], tr.ats_win.values[m])['w'] if m.sum() >= 150 else w1
            pc = CAL.shrink_np(cur.pure_cover_prob.values, 0.5, np.array([wg.get(v, w1) for v in cur._g]))
            p1 = CAL.shrink_np(cur.pure_cover_prob.values, 0.5, w1)
            dll.append(core.log_loss(cur.ats_win.values, pc) - core.log_loss(cur.ats_win.values, p1))
        dll = np.concatenate(dll)
        ci = core.boot_ci(dll)
        adopt = bool(lr['p'] < 0.05 / n_tests and ci[1] is not None and ci[1] < 0)
        table = group_table(sc, '_g', groups)
        for row in table:
            gname = row['bucket']
            m = Y._g.values == gname
            if m.sum() >= 30:
                f = CAL.fit_shrink(x[m], yv[m], bounded=False)
                row['w_group'] = r(f['w_unbounded'])
                row['w_group_ci95'] = rl(f['w_ci95_profile'])
                row['n_fit'] = int(m.sum())
        outd[name] = {'table_scored_2018_2023': table, 'lr_test_dev_2017_2023': {k: r(v, 5) for k, v in lr.items()},
                      'w_single': r(single['w_unbounded']), 'w_by_group': {str(k): r(v) for k, v in ws.items()},
                      'walk_forward_dll_conditional_minus_single': r(dll.mean(), 6), 'walk_forward_dll_ci': rl(ci, 6),
                      'adopted': adopt, 'bonferroni_alpha': 0.05 / n_tests, 'feature': feat, 'edges': edges,
                      'rule': 'adopt a conditional map only if the in-sample LR test rejects one weight at 0.05/%d AND '
                              'the walk-forward log-loss change has a 95%% CI entirely below 0' % n_tests}
    # disagreement vs overconfidence of the ERROR model (standardized absolute error by tercile)
    return outd, ens_edges


def s10_ev(Wd):
    sc = Wd[Wd.season.isin(SCORED)].copy()
    theo = bucket_table(sc, 'theoretical_ev', EV_BUCKETS_EXT)
    theo_std = bucket_table(sc, 'theoretical_ev', EV_BUCKETS)
    dec = bucket_table(sc, 'decision_ev', EV_BUCKETS)
    for rows, col in ((theo, 'theoretical_ev'), (theo_std, 'theoretical_ev'), (dec, 'decision_ev')):
        for row, (lo, hi, lab) in zip(rows, EV_BUCKETS_EXT if rows is theo else EV_BUCKETS):
            s = sc[(sc[col] >= lo) & (sc[col] < hi)]
            row['mean_theoretical_ev'] = r(s.theoretical_ev.mean())
            row['mean_decision_ev'] = r(s.decision_ev.mean())
    # walk-forward empirical EV curve (theoretical EV -> realized units)
    curves, ev_emp = {}, pd.Series(np.nan, index=Wd.index)
    for S in SCORED:
        tr = Wd[Wd.season < S]
        CAL.assert_past_only(CAL.assert_fit_rows(tr), S)
        cv = CAL.fit_ev_curve(tr.theoretical_ev.values, tr.units_assumed_110.values, tr.push_prob.values)
        curves[int(S)] = {'x': rl(cv['x']), 'y': rl(cv['y']), 'tau2': r(cv['tau2'], 6)}
        m = Wd.season.eq(S)
        ev_emp[m] = CAL.interp_np(cv['x'], cv['y'], Wd.loc[m, 'theoretical_ev'].values)
    Wd['empirical_ev'] = ev_emp
    # nested curve on the (walk-forward) decision EV
    curves_d, ev_emp_d = {}, pd.Series(np.nan, index=Wd.index)
    for S in SCORED[1:]:
        tr = Wd[(Wd.season < S) & Wd.decision_ev.notna()]
        cv = CAL.fit_ev_curve(tr.decision_ev.values, tr.units_assumed_110.values, tr.push_prob.values)
        curves_d[int(S)] = {'x': rl(cv['x']), 'y': rl(cv['y']), 'tau2': r(cv['tau2'], 6)}
        m = Wd.season.eq(S)
        ev_emp_d[m] = CAL.interp_np(cv['x'], cv['y'], Wd.loc[m, 'decision_ev'].values)
    Wd['empirical_ev_decision'] = ev_emp_d
    sc = Wd[Wd.season.isin(SCORED)]
    u = sc.units_assumed_110.values
    null = 0.5 * (1 - sc.push_prob.fillna(0).values) * (100 / 110) - 0.5 * (1 - sc.push_prob.fillna(0).values)
    mse = lambda pred: r(np.nanmean((u - pred) ** 2), 6)
    evaluation = {'mse_realized_vs_theoretical_ev': mse(sc.theoretical_ev.values),
                  'mse_realized_vs_decision_ev': mse(sc.decision_ev.values),
                  'mse_realized_vs_empirical_ev': mse(sc.empirical_ev.values),
                  'mse_realized_vs_no_skill': mse(null),
                  'mean_theoretical_ev': r(sc.theoretical_ev.mean()), 'mean_decision_ev': r(sc.decision_ev.mean()),
                  'mean_empirical_ev': r(sc.empirical_ev.mean()), 'mean_realized': r(np.nanmean(u)),
                  'mean_realized_ci': rl(core.boot_ci(u))}
    return {'theoretical_ev_buckets_extended': theo, 'theoretical_ev_buckets': theo_std, 'decision_ev_buckets': dec,
            'ev_curve_walk_forward': curves, 'ev_curve_decision_walk_forward': curves_d,
            'evaluation_scored': evaluation}, Wd


def s14_edge(Wd):
    sc = Wd[Wd.season.isin(SCORED)]
    by_season = {}
    for S in SCORED:
        s = sc[sc.season == S]
        by_season[int(S)] = {'n': int(len(s)), 'share_edge_pos': r((s.probability_edge > 0).mean()),
                             'edge_q50': r(s.probability_edge.median()), 'edge_q90': r(s.probability_edge.quantile(0.9)),
                             'edge_max': r(s.probability_edge.max()), 'p_dec_max': r(s.p_dec.max())}
    pos = block(sc[sc.probability_edge > 0])
    neg = block(sc[sc.probability_edge <= 0])
    return {'by_season': by_season, 'edge_positive': pos, 'edge_nonpositive': neg,
            'break_even_at_assumed_110': BE_110,
            'pure_edge_share_positive': r((sc.pure_cover_prob > BE_110).mean()),
            'note': 'probability_edge = decision_cover_probability - break_even(price); > 0 is the ONLY cut here '
                    '(the price\'s break-even), declared, not searched'}


def fit_clv_models(tr, feats, kind):
    tgt = 'positive_clv' if kind == 'logistic' else 'clv_fit'
    return CAL.fit_model(tr, feats, tgt, kind=kind)


def auc(y, p):
    from scipy import stats
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    n1, n0 = y.sum(), (1 - y).sum()
    if n1 == 0 or n0 == 0:
        return None
    rk = stats.rankdata(p)
    return float((rk[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


L2_GRID = (1.0, 10.0, 100.0, 1000.0, 10000.0)      # ridge grid for the interpretable models (declared)
FOOT_SCALE = (10.0, 16.0)                          # declared: score 100 <-> 10 pts expected |error|, 0 <-> 16 pts
MKT_SCALE = (0.5, 3.0)                             # declared: score 100 <-> 0.5 pt expected |move|, 0 <-> 3 pts


def _wf_series(D, feats, kind, l2, target):
    pr, _ = CAL.walk_forward(D, SCORED, lambda tr: CAL.fit_model(tr, feats, target, kind=kind, l2=l2),
                             lambda m, c: CAL.eval_model_np(m, c))
    return pd.Series(np.concatenate([pr[S] for S in SCORED]),
                     index=np.concatenate([D[D.season == S].index for S in SCORED]))


def _boot_stat(fn, n, B=1000):
    rng = np.random.default_rng(C.SEED)
    v = [fn(rng.integers(0, n, n)) for _ in range(B)]
    v = [x for x in v if x is not None and np.isfinite(x)]
    return [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))]


def s19_clv(Wd):
    """p_positive_clv (logistic) and the CLV-magnitude model (linear), walk-forward.
    The ridge strength of each variant is chosen on the pooled walk-forward loss
    over a declared 5-value grid (disclosed: a mild selection on the evaluation)."""
    D = Wd[Wd.clv_pts.notna()].copy()
    D['clv_fit'] = D.clv_pts.clip(-WINSOR_CLV, WINSOR_CLV)
    variants = {'intercept_only': [], 'gap_only': ['gap_pts'], 'frozen_features': CLV_FEATURES,
                'with_close_side_diagnostics': CLV_FEATURES + CLV_DIAG}
    res, preds, l2s = {'logistic': {}, 'linear': {}}, {'logistic': {}, 'linear': {}}, {'logistic': {}, 'linear': {}}
    for kind in ('logistic', 'linear'):
        target = 'positive_clv' if kind == 'logistic' else 'clv_fit'
        for name, feats in variants.items():
            best = None
            for l2 in (L2_GRID if feats else (1.0,)):
                p = _wf_series(D, feats, kind, l2, target)
                sub = D.loc[p.index]
                loss = (core.log_loss(sub.positive_clv.values, p.values).mean() if kind == 'logistic'
                        else np.mean((sub.clv_pts.values - p.values) ** 2))
                if best is None or loss < best[0] - 1e-12:
                    best = (loss, l2, p)
            _, l2, p = best
            l2s[kind][name] = l2
            preds[kind][name] = p
            sub = D.loc[p.index]
            if kind == 'logistic':
                y = sub.positive_clv.values
                pv = p.values
                res[kind][name] = {'n': int(len(y)), 'log_loss': r(core.log_loss(y, pv).mean(), 5),
                                   'brier': r(core.brier(y, pv).mean(), 5), 'auc': r(auc(y, pv)),
                                   'auc_ci': rl(_boot_stat(lambda i: auc(y[i], pv[i]), len(y))) if feats else None,
                                   'pred_range_p05_p95': rl([np.quantile(pv, 0.05), np.quantile(pv, 0.95)]),
                                   'features': feats, 'l2': l2}
            else:
                y = sub.clv_pts.values
                pv = p.values
                e = y - pv
                ok = np.std(pv) > 1e-9
                res[kind][name] = {'n': int(len(y)), 'mae': r(np.abs(e).mean()), 'rmse': r(np.sqrt((e ** 2).mean())),
                                   'corr': r(np.corrcoef(pv, y)[0, 1]) if ok else None,
                                   'corr_ci': rl(_boot_stat(lambda i: np.corrcoef(pv[i], y[i])[0, 1], len(y))) if (ok and feats) else None,
                                   'calibration_slope': r(np.polyfit(pv, y, 1)[0]) if ok else None,
                                   'features': feats, 'l2': l2}
    # production baseline: clv_exp = beta * gap (beta walk-forward, the market.py definition)
    bp = []
    for S in SCORED:
        tr = D[D.season < S]
        beta = float(np.sum(tr.gap_pts * tr.clv_pts) / np.sum(tr.gap_pts ** 2))
        bp.append(beta * D[D.season == S].gap_pts.values)
    bp = pd.Series(np.concatenate(bp), index=np.concatenate([D[D.season == S].index for S in SCORED]))
    y = D.loc[bp.index].clv_pts.values
    res['linear']['production_beta_times_gap'] = {'n': int(len(y)), 'mae': r(np.abs(y - bp.values).mean()),
                                                  'rmse': r(np.sqrt(((y - bp.values) ** 2).mean())),
                                                  'corr': r(np.corrcoef(bp.values, y)[0, 1]),
                                                  'calibration_slope': r(np.polyfit(bp.values, y, 1)[0])}
    ll = lambda name: core.log_loss(D.loc[preds['logistic'][name].index].positive_clv.values, preds['logistic'][name].values)
    se = lambda name: (D.loc[preds['linear'][name].index].clv_pts.values - preds['linear'][name].values) ** 2
    for name in variants:
        res['logistic'][name]['dll_vs_intercept'] = r((ll(name) - ll('intercept_only')).mean(), 6)
        res['logistic'][name]['dll_vs_intercept_ci'] = rl(core.boot_paired_diff(ll(name), ll('intercept_only'))['ci'], 6)
        res['linear'][name]['dmse_vs_intercept'] = r((se(name) - se('intercept_only')).mean(), 4)
        res['linear'][name]['dmse_vs_intercept_ci'] = rl(core.boot_paired_diff(se(name), se('intercept_only'))['ci'], 4)
    # adoption: these models RANK (bet confidence, expected CLV). A variant is adopted when it discriminates
    # out of sample (walk-forward AUC CI above 0.5 / correlation CI above 0) AND does not worsen the
    # walk-forward loss against the base rate (point estimate). Stated after the loss-only comparison
    # (whose CIs include 0) came out inconclusive — disclosed in CALIBRATION.md.
    pick = {}
    for kind in ('logistic', 'linear'):
        pick[kind] = 'intercept_only'
        for name in ('frozen_features', 'gap_only'):
            m = res[kind][name]
            disc = (m['auc_ci'][0] > 0.5) if kind == 'logistic' else (m['corr_ci'] is not None and m['corr_ci'][0] > 0)
            loss_ok = (m['dll_vs_intercept'] <= 0) if kind == 'logistic' else (m['dmse_vs_intercept'] <= 0)
            if disc and loss_ok:
                pick[kind] = name
                break
    p = preds['logistic'][pick['logistic']]
    sub = D.loc[p.index].assign(pp=p.values)
    sub['dec'] = pd.qcut(sub.pp.rank(method='first'), 10, labels=False)
    diag = [{'decile': int(k) + 1, 'n': int(len(g)), 'pred': r(g.pp.mean()), 'obs': r(g.positive_clv.mean()),
             'obs_wilson': rl(core.wilson(g.positive_clv.sum(), len(g)))} for k, g in sub.groupby('dec')]
    pe = preds['linear'][pick['linear']]
    sub2 = D.loc[pe.index].assign(pe=pe.values)
    sub2['dec'] = pd.qcut(sub2.pe.rank(method='first'), 10, labels=False)
    diag2 = [{'decile': int(k) + 1, 'n': int(len(g)), 'pred': r(g.pe.mean(), 3), 'obs': r(g.clv_pts.mean(), 3),
              'obs_ci': rl(core.boot_ci(g.clv_pts.values), 3)} for k, g in sub2.groupby('dec')]
    Wd['p_pos_clv_wf'] = np.nan
    Wd.loc[p.index, 'p_pos_clv_wf'] = p.values
    Wd['exp_clv_wf'] = np.nan
    Wd.loc[pe.index, 'exp_clv_wf'] = pe.values
    by_season_base = {int(S): r(D[D.season == S].positive_clv.mean()) for S in PRICED_SEASONS}
    CAL.assert_fit_rows(D)
    final = {}
    rng = np.random.default_rng(C.SEED)
    for kind in ('logistic', 'linear'):
        target = 'positive_clv' if kind == 'logistic' else 'clv_fit'
        feats = variants[pick[kind]]
        l2 = l2s[kind][pick[kind]]
        spec = CAL.fit_model(D, feats, target, kind=kind, l2=l2)
        boots = []
        for _ in range(300):
            i = rng.integers(0, len(D), len(D))
            boots.append(CAL.fit_model(D.iloc[i], feats, target, kind=kind, l2=l2)['coef'])
        spec['coef_ci95'] = {k: rl([np.quantile([b[k] for b in boots], 0.025), np.quantile([b[k] for b in boots], 0.975)])
                             for k in feats}
        final[kind] = spec
        final[kind + '_diagnostic'] = CAL.fit_model(D, CLV_FEATURES + CLV_DIAG, target, kind=kind,
                                                    l2=l2s[kind]['with_close_side_diagnostics'])
    return {'walk_forward': res, 'reliability_diagram_p_positive_clv': diag, 'deciles_expected_clv': diag2,
            'picked': pick, 'l2_chosen': l2s, 'final': final, 'winsor_clv_fit': WINSOR_CLV,
            'base_rate_positive_clv': r(D.positive_clv.mean()), 'base_rate_by_season': by_season_base,
            'share_no_move': r((D.clv_pts == 0).mean()),
            'adoption_rule': 'adopt the frozen-feature (else gap-only) model when its walk-forward AUC 95% CI is above 0.5 '
                             '(correlation CI above 0 for the magnitude model) AND its walk-forward loss is not above the '
                             'base rate\'s; stated after the loss-only comparison was inconclusive'}, Wd


def _pick_parsimony(res, order, key='mse'):
    best = min(order, key=lambda k: res[k][key])
    for k in order:
        if res[k][key] - res[best][key] <= (res[k].get('se_vs_best') or 0) + 1e-12:
            return k, best
    return best, best


def eb_pav_scale(score, err, bands, increasing=False):
    """Band means of err over the score bands -> normal-normal EB toward the pooled mean -> PAV."""
    from sklearn.isotonic import IsotonicRegression
    score, err = np.asarray(score, float), np.asarray(err, float)
    xs, ms, ses, ns = [], [], [], []
    for lo, hi, lab in bands:
        m = (score >= lo) & (score < hi) & np.isfinite(err)
        if m.sum() < 30:
            continue
        xs.append(float(score[m].mean()))
        ms.append(float(err[m].mean()))
        ses.append(float(err[m].std(ddof=1) / math.sqrt(m.sum())))
        ns.append(int(m.sum()))
    shr, tau2, m0 = CAL.eb_normal(ms, ses)
    y = IsotonicRegression(increasing=increasing).fit(xs, shr, sample_weight=ns).predict(xs)
    return {'x': xs, 'y': [float(v) for v in y], 'tau2': tau2, 'pooled': m0,
            'bands': [{'x': x, 'n': n, 'mean': m, 'se': s, 'eb': float(e)} for x, n, m, s, e in zip(xs, ns, ms, ses, shr)]}


def s24_confidences(games, W_all, priced):
    """Three empirical confidences: football (expected |error|), market (expected |move|), bet (P(+CLV))."""
    from scipy import stats
    G = games[games.season.isin(C.DEV_SEASONS)].copy()
    G['abs_err'] = G.abs_error_model
    sc_seasons = [s for s in sorted(G.season.unique()) if s > min(G.season)]
    cands = {'intercept_only': [], 'linear_sigma': ['sigma'], 'linear_frozen_features': FOOT_FEATURES,
             'theory_sigma_E|T|': None}
    fres, fpred = {}, {}
    for name, feats in cands.items():
        if feats is None:
            p = pd.Series(G.expected_model_error.values, index=G.index)[G.season.isin(sc_seasons)]
        else:
            pr, _ = CAL.walk_forward(G, sc_seasons, lambda tr, f=feats: CAL.fit_model(tr, f, 'abs_err', kind='linear', l2=1e-6),
                                     lambda m, c: CAL.eval_model_np(m, c), min_train=300)
            p = pd.Series(np.concatenate([pr[S] for S in sc_seasons]),
                          index=np.concatenate([G[G.season == S].index for S in sc_seasons]))
        fpred[name] = p
        y = G.loc[p.index].abs_err.values
        fres[name] = {'n': int(len(y)), 'mse': r(np.mean((y - p.values) ** 2), 4), 'bias': r(np.mean(p.values - y), 3),
                      'spearman': r(stats.spearmanr(p.values, y).statistic) if np.std(p.values) > 0 else None,
                      'features': feats, 'eligible': feats is not None}
    order = ['intercept_only', 'linear_sigma', 'linear_frozen_features']
    best = min(order, key=lambda k: fres[k]['mse'])
    for name, p in fpred.items():
        y = G.loc[p.index].abs_err.values
        pb = fpred[best][p.index].values
        d = (y - p.values) ** 2 - (y - pb) ** 2
        di = (y - p.values) ** 2 - (y - fpred['intercept_only'][p.index].values) ** 2
        fres[name]['dmse_vs_best'] = r(d.mean(), 4)
        fres[name]['se_vs_best'] = r(d.std(ddof=1) / math.sqrt(len(d)), 4)
        fres[name]['dmse_vs_intercept'] = r(di.mean(), 4)
        fres[name]['dmse_vs_intercept_ci'] = rl(core.boot_ci(di), 4)
    fpick = next(k for k in order if fres[k]['dmse_vs_best'] <= (fres[k]['se_vs_best'] or 0) + 1e-12)

    def quint_table(pred, y):
        q = pd.qcut(pd.Series(pred).rank(method='first'), 5, labels=False).values
        return [{'band': int(k) + 1, 'n': int((q == k).sum()), 'pred_mean': r(pred[q == k].mean(), 3),
                 'mae': r(y[q == k].mean(), 3), 'mae_ci': rl(core.boot_ci(y[q == k]), 3)} for k in range(5)]

    ps = fpred['linear_sigma']
    ys = G.loc[ps.index].abs_err.values
    sigma_quint = quint_table(G.loc[ps.index].sigma.values, ys)
    sigma_quint_mono = CAL.spearman_perm([x['pred_mean'] for x in sigma_quint], [x['mae'] for x in sigma_quint])
    # does the production reliability score sort |error|? game-level slope per 10 points, bootstrap CI
    Gs = G[G.season.isin(sc_seasons) & G.reliability.notna()]
    xr, yr = Gs.reliability.values, Gs.abs_err.values
    slope = float(np.polyfit(xr, yr, 1)[0]) * 10
    sl_ci = _boot_stat(lambda i: float(np.polyfit(xr[i], yr[i], 1)[0]) * 10, len(xr))
    sg = G[G.season.isin(sc_seasons)]
    sslope = float(np.polyfit(sg.sigma.values, sg.abs_err.values, 1)[0])
    ss_ci = _boot_stat(lambda i: float(np.polyfit(sg.sigma.values[i], sg.abs_err.values[i], 1)[0]), len(sg))
    # the production score -> expected |error| scale: EB + PAV, validated walk-forward
    rel_pred = pd.Series(np.nan, index=G.index)
    for S in sc_seasons:
        tr = G[(G.season < S) & G.reliability.notna()]
        CAL.assert_past_only(CAL.assert_fit_rows(tr), S)
        sc_ = eb_pav_scale(tr.reliability.values, tr.abs_err.values, REL_BANDS)
        m = G.season.eq(S) & G.reliability.notna()
        rel_pred[m] = CAL.interp_np(sc_['x'], sc_['y'], G.loc[m, 'reliability'].values)
    rel_rows = []
    for lo, hi, lab in REL_BANDS:
        s = G[G.season.isin(sc_seasons) & (G.reliability >= lo) & (G.reliability < hi)]
        rel_rows.append({'band': lab, 'n': int(len(s)), 'pred_mean': r(rel_pred[s.index].mean(), 3),
                         'mae': r(s.abs_err.mean(), 3), 'mae_ci': rl(core.boot_ci(s.abs_err.values), 3),
                         'mean_sigma': r(s.sigma.mean(), 3), 'mean_score': r(s.reliability.mean(), 1)})
    rel_wf_rows = []
    for lo, hi, lab in REL_BANDS:
        s = G[G.season.isin(sc_seasons) & (G.reliability_wf >= lo) & (G.reliability_wf < hi)]
        rel_wf_rows.append({'band': lab, 'n': int(len(s)), 'mae': r(s.abs_err.mean(), 3),
                            'mae_ci': rl(core.boot_ci(s.abs_err.values), 3)})
    rmono = CAL.spearman_perm(list(range(len(REL_BANDS))), [x['mae'] if x['mae'] is not None else np.nan for x in rel_rows])
    CAL.assert_fit_rows(G)
    rel_scale = eb_pav_scale(G.reliability.values, G.abs_err.values, REL_BANDS)
    from sklearn.isotonic import IsotonicRegression
    iso_raw = IsotonicRegression(increasing=False, out_of_bounds='clip').fit(G.reliability.dropna().values,
                                                                             G.loc[G.reliability.notna(), 'abs_err'].values)
    grid = list(range(0, 101, 10))
    fspec = CAL.fit_model(G, cands[fpick], 'abs_err', kind='linear', l2=1e-6)
    # standardized error by disagreement tercile: does disagreement predict OVERCONFIDENCE of sigma?
    G['z'] = (G.final_margin - G.pure_margin) / G.sigma
    edges = [float(np.quantile(G.ens_sd, 1 / 3)), float(np.quantile(G.ens_sd, 2 / 3))]
    G['ens_t'] = np.where(G.ens_sd < edges[0], 'low', np.where(G.ens_sd < edges[1], 'mid', 'high'))
    zt = []
    for t in ('low', 'mid', 'high'):
        s = G[G.ens_t == t]
        eabs = np.array([core.mean_abs_t_std(d) for d in s.t_df])
        zt.append({'tercile': t, 'n': int(len(s)), 'mean_abs_z': r(s.z.abs().mean()), 'expected_abs_z': r(eabs.mean()),
                   'ratio': r(s.z.abs().mean() / eabs.mean()), 'ratio_ci': rl(np.array(core.boot_ci(s.z.abs().values)) / eabs.mean()),
                   'cover80': r((s.z.abs() <= 1.2816).mean()), 'mae': r(s.abs_err.mean(), 3), 'mean_sigma': r(s.sigma.mean(), 3),
                   'mean_ens_sd': r(s.ens_sd.mean(), 3)})
    football = {'candidates_walk_forward': fres, 'picked': fpick, 'best_mse': best,
                'sigma_quintiles': sigma_quint, 'sigma_quintile_monotonicity': sigma_quint_mono,
                'sigma_slope_abs_err_per_pt': r(sslope, 4), 'sigma_slope_ci': rl(ss_ci, 4),
                'reliability_slope_per_10pts': r(slope, 4), 'reliability_slope_ci': rl(sl_ci, 4),
                'reliability_bands_production_score': rel_rows, 'reliability_bands_stage7_wf': rel_wf_rows,
                'reliability_band_monotonicity': rmono,
                'reliability_scale': {'x': rel_scale['x'], 'y': rel_scale['y']}, 'reliability_scale_detail': rel_scale,
                'reliability_isotonic_raw_grid': {'x': grid, 'y': [r(v, 3) for v in iso_raw.predict(np.array(grid, float))]},
                'final_model': fspec, 'scale_expected_abs_error': list(FOOT_SCALE),
                'disagreement_vs_standardized_error': zt, 'ens_sd_tercile_edges': edges,
                'seasons_scored': [int(s) for s in sc_seasons],
                'population': 'FBS vs FBS DEV games with sigma (2017-2023, 2020 included)', 'n_games': int(len(G))}
    # ---- market: expected |close - quote| from the quote itself (point in time) + close-side diagnostics
    M = priced[priced.clv_pts.notna() & ~priced.orientation_fault].copy()
    M['abs_move'] = M.abs_line_move
    M['pin_present'] = M.pinnacle_close_margin.notna().astype(float)
    mseasons = [s for s in sorted(M.season.unique()) if s > min(M.season)]
    mc = {'intercept_only': [], 'frozen_point_in_time': MKT_FEATURES,
          'with_close_side_diagnostics': MKT_FEATURES + ['archive_book_count', 'market_dispersion_close', 'pin_present']}
    mres, mpred = {}, {}
    for name, feats in mc.items():
        pr, _ = CAL.walk_forward(M, mseasons, lambda tr, f=feats: CAL.fit_model(tr, f, 'abs_move', kind='linear', l2=1e-6),
                                 lambda m, c: CAL.eval_model_np(m, c), min_train=300)
        p = pd.Series(np.concatenate([pr[S] for S in mseasons if S in pr]),
                      index=np.concatenate([M[M.season == S].index for S in mseasons if S in pr]))
        mpred[name] = p
        y = M.loc[p.index].abs_move.values
        ye = M.loc[p.index].abs_error_quote.values
        mres[name] = {'n': int(len(y)), 'mse': r(np.mean((y - p.values) ** 2), 4), 'features': feats,
                      'spearman_abs_move': r(stats.spearmanr(p.values, y).statistic) if np.std(p.values) > 0 else None,
                      'spearman_abs_quote_error': r(stats.spearmanr(p.values, ye).statistic) if np.std(p.values) > 0 else None}
    morder = ['intercept_only', 'frozen_point_in_time']
    mbest = min(morder, key=lambda k: mres[k]['mse'])
    for name in mc:
        p = mpred[name]
        yv2 = M.loc[p.index].abs_move.values
        d = (yv2 - p.values) ** 2 - (yv2 - mpred[mbest][p.index].values) ** 2
        di = (yv2 - p.values) ** 2 - (yv2 - mpred['intercept_only'][p.index].values) ** 2
        mres[name]['dmse_vs_best'] = r(d.mean(), 4)
        mres[name]['se_vs_best'] = r(d.std(ddof=1) / math.sqrt(len(d)), 4)
        mres[name]['dmse_vs_intercept'] = r(di.mean(), 4)
        mres[name]['dmse_vs_intercept_ci'] = rl(core.boot_ci(di), 4)
    mpick = next(k for k in morder if mres[k]['dmse_vs_best'] <= (mres[k]['se_vs_best'] or 0) + 1e-12)
    pm = mpred['frozen_point_in_time']
    mtab = quint_table(pm.values, M.loc[pm.index].abs_move.values)
    mtab_err = quint_table(pm.values, M.loc[pm.index].abs_error_quote.values)
    CAL.assert_fit_rows(M)
    mspec = CAL.fit_model(M, mc[mpick], 'abs_move', kind='linear', l2=1e-6)
    market = {'candidates_walk_forward': mres, 'picked': mpick,
              'quintiles_abs_move_by_pit_model': mtab, 'quintiles_abs_quote_error_by_pit_model': mtab_err,
              'final_model': mspec, 'scale_expected_abs_move': list(MKT_SCALE),
              'target': '|close - quote| (points): how far the quoted number is from where the market settles',
              'population': 'FBS consensus openers 2016-2023 with a close (no 2020), orientation faults excluded',
              'seasons_scored': [int(s) for s in mseasons], 'mean_abs_move': r(M.abs_move.mean(), 3)}
    return {'football': football, 'market': market}


def deciles(Wd, score, outcomes=('clv_pts', 'positive_clv', 'ats_win', 'units_assumed_110', 'probability_edge')):
    sc = Wd[Wd.season.isin(SCORED) & Wd[score].notna()].copy()
    sc['_d'] = pd.qcut(sc[score].rank(method='first'), 10, labels=False)
    rows = []
    for k, g in sc.groupby('_d'):
        row = {'decile': int(k) + 1, 'n': int(len(g)), 'score_mean': r(g[score].mean(), 4),
               'score_range': [r(g[score].min(), 4), r(g[score].max(), 4)]}
        for o in outcomes:
            v = g[o].values
            row[o] = r(np.nanmean(v), 4)
            row[o + '_ci'] = rl(core.boot_ci(v, B=1000), 4)
        u = g.sort_values('kickoff_ts', kind='mergesort').units_assumed_110.values
        row['max_drawdown'] = r(core.max_drawdown(u), 2)
        row['max_drawdown_ci'] = rl(core.boot_drawdown_ci(u, B=1000), 2)
        rows.append(row)
    tests = {}
    for o in outcomes:
        means = [x[o] for x in rows]
        sp = CAL.spearman_perm(list(range(10)), means)
        top = sc[sc._d == 9][o].values
        bot = sc[sc._d == 0][o].values
        top, bot = top[np.isfinite(top)], bot[np.isfinite(bot)]
        rng = np.random.default_rng(C.SEED)
        bd = [rng.choice(top, len(top)).mean() - rng.choice(bot, len(bot)).mean() for _ in range(2000)]
        x = sc._d.values.astype(float)
        yv = sc[o].values.astype(float)
        ok = np.isfinite(yv)
        slope = float(np.polyfit(x[ok], yv[ok], 1)[0])
        bs = []
        idx = np.flatnonzero(ok)
        for _ in range(1000):
            i = rng.choice(idx, len(idx))
            bs.append(np.polyfit(x[i], yv[i], 1)[0])
        inv = int(sum(1 for a, b in zip(means[:-1], means[1:]) if a is not None and b is not None and b < a))
        tests[o] = {'spearman_decile_means': r(sp['rho']), 'spearman_perm_p': r(sp['p']),
                    'top_minus_bottom': r(np.mean(top) - np.mean(bot), 4),
                    'top_minus_bottom_ci': rl([np.quantile(bd, 0.025), np.quantile(bd, 0.975)], 4),
                    'slope_per_decile': r(slope, 5), 'slope_ci': rl([np.quantile(bs, 0.025), np.quantile(bs, 0.975)], 5),
                    'adjacent_inversions': inv,
                    'monotone_increasing_supported': bool(np.quantile(bs, 0.025) > 0)}
    return {'score': score, 'rows': rows, 'tests': tests, 'n': int(len(sc))}


def s2020(D, games, fspec):
    G = games[games.season.eq(C.COVID_SEASON)].copy()
    tr = games[games.season.isin([2017, 2018, 2019])]
    CAL.assert_fit_rows(tr)
    spec = CAL.fit_model(tr.assign(abs_err=tr.abs_error_model), fspec['feats'], 'abs_err', kind='linear', l2=1e-6)
    G['pred_abs_err'] = CAL.eval_model_np(spec, G)
    out = {'n_games': int(len(G)), 'mae_model': r(G.abs_error_model.mean(), 3),
           'mae_model_ci': rl(core.boot_ci(G.abs_error_model.values), 3),
           'mean_expected_abs_error_wf': r(G.pred_abs_err.mean(), 3),
           'mean_theory_expected_error': r(G.expected_model_error.mean(), 3),
           'openers': 0, 'note': 'no openers exist in 2020: no decision row, no ATS/ROI/CLV at a quote'}
    # diagnostic only: the pure distribution against the CLOSE (never a decision quote)
    fbs = D[D.pricing_scope.eq('FBS_FBS') & D.season.eq(C.COVID_SEASON)].drop_duplicates('game_id')
    fbs = fbs[fbs.status.eq('FINAL') & fbs.sigma.notna()]
    cm = pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'),
                         columns=['game_id', 'close_margin']).rename(columns={'close_margin': 'close_margin_s7'})
    fbs = fbs.merge(cm, on='game_id', how='left')
    fbs = fbs[fbs.close_margin_s7.notna()]
    L = fbs.close_margin_s7.values
    ph = core.cover_prob_home(fbs.pure_margin.values, fbs.sigma.values, L, fbs.t_df.values)
    side_home = fbs.pure_margin.values > L
    p = np.where(side_home, ph, 1 - ph)
    diff = fbs.final_margin.values - L
    y = np.where(diff == 0, np.nan, ((diff > 0) == side_home).astype(float))
    ok = np.isfinite(y)
    f = CAL.fit_shrink(p[ok], y[ok], bounded=False)
    out['diagnostic_vs_close'] = {'n': int(ok.sum()), 'pushes': int((~ok).sum()), 'cover_rate': r(np.mean(y[ok])),
                                  'mean_p_pure': r(p[ok].mean()), 'log_loss_pure': r(core.log_loss(y[ok], p[ok]).mean(), 5),
                                  'log_loss_coin': r(math.log(2), 5), 'w_2020_close': r(f['w_unbounded']),
                                  'w_ci95': rl(f['w_ci95_profile']),
                                  'label': 'DIAGNOSTIC: the close is not a decision quote; this only shows the pure '
                                           'distribution is no better calibrated against the close'}
    return out


def price_sensitivity(Wd, priced):
    """2016-2019: the archive's real OPENING price of the very opener the study bets."""
    P = priced[priced.archive_open_price_side.notna() & priced.season.le(2019)].copy()
    both = P.archive_open_price_side.eq(-110) & P.archive_open_price_other.eq(-110)
    mk = [core.market_implied_side(a, b)[0] for a, b in zip(P.archive_open_price_side, P.archive_open_price_other)]
    P['p_mkt_archive'] = mk
    d = core.boot_paired_diff(P.units_archive_price.values, P.units_assumed_110.values)
    out = {'n': int(len(P)), 'share_both_sides_-110': r(both.mean()),
           'price_pairs': {str(k): int(v) for k, v in P.groupby(['archive_open_price_side', 'archive_open_price_other']).size()
                           .sort_values(ascending=False).head(8).items()},
           'mean_devig_market_prob_side': r(np.mean(mk)), 'share_market_prob_not_0.5': r(np.mean(np.abs(np.array(mk) - 0.5) > 1e-9)),
           'roi_assumed_110': r(P.units_assumed_110.mean()), 'roi_archive_price': r(P.units_archive_price.mean()),
           'roi_diff_archive_minus_assumed': r(d['mean']), 'roi_diff_ci': rl(d['ci']),
           'mean_break_even_archive': r(np.nanmean(core.break_even(P.archive_open_price_side.values)))}
    # the shrink weight with the de-vigged archive market probability as the anchor (2017-2019, descriptive)
    Q = P[P.pure_cover_prob.notna() & P.ats_win.notna() & ~P.review_route]
    if len(Q) > 300:
        f5 = CAL.fit_shrink(Q.pure_cover_prob.values, Q.ats_win.values, 0.5, bounded=False)
        fa = CAL.fit_shrink(Q.pure_cover_prob.values, Q.ats_win.values, Q.p_mkt_archive.values, bounded=False)
        out['w_anchor_0.5'] = r(f5['w_unbounded'])
        out['w_anchor_devig_archive'] = r(fa['w_unbounded'])
        out['n_w'] = int(len(Q))
    return out


def review_block(review):
    return block(review, p_dec='__none__') if len(review) else {'n': 0}


# ================================================================= main
def main(freeze_artifact=True):
    t0 = time.time()
    from .baseline import write_or_verify
    write_or_verify(verify_only=True)
    D = load_dev()
    priced, W, review, games = populations(D)
    CAL.assert_fit_rows(W)
    print('[study] DEV decision rows %d (priced %d, review %d, games %d)' % (len(W), len(priced), len(review), len(games)))
    s5, preds, fits = s05_methods(W)
    print('[study] s5 chosen', s5['chosen'], 'best', s5['best_eligible'])
    sw = shrink_by_season(W)
    Wd = decision_frame(W, s5, preds, fits)
    s5['w_on_top_of_each_map'] = nested_w_on_top(W, preds)
    s5['shrink_weight'] = sw
    dump('s05_calibration_methods.json', s5)
    s4 = s04_buckets(Wd)
    dump('s04_cover_buckets.json', s4)
    cond, ens_edges = conditional_tests(Wd, W)
    cond['review_rows_not_priced'] = review_block(review)
    cond['gap_buckets_incl_2016_no_pure'] = bucket_table(
        priced[priced.season.isin([2016] + PRICED_SEASONS)].assign(pure_cover_prob=priced.pure_cover_prob), 'abs_gap_pts',
        GAP_BUCKETS + [(14, 999, '14+ (REVIEW)')], p_dec='__none__')
    dump('s06_09_conditional.json', cond)
    print('[study] conditional adopted:', {k: v['adopted'] for k, v in cond.items() if isinstance(v, dict) and 'adopted' in v})
    s10, Wd = s10_ev(Wd)
    dump('s10_11_ev.json', s10)
    s14 = s14_edge(Wd)
    dump('s12_14_edge.json', s14)
    s19, Wd = s19_clv(Wd)
    dump('s19_20_clv_models.json', s19)
    s24 = s24_confidences(games, W, priced)
    Wd['bet_confidence_wf'] = Wd.p_pos_clv_wf
    s24['bet'] = {'definition': 'bet_confidence = the calibrated P(positive CLV) of the frozen p_positive_clv model '
                                '(0-100 = 100 x p); it is validated against realized CLV and the calibrated edge, and is '
                                'shown NOT to predict wins',
                  'deciles': deciles(Wd, 'bet_confidence_wf')}
    dump('s24_27_confidences.json', s24)
    s33 = {k: deciles(Wd, k) for k in ('pure_cover_prob', 'theoretical_ev', 'probability_edge', 'exp_clv_wf')}
    s33['min_sample_rules'] = {'MIN_N_REPORT': MIN_N_REPORT, 'MIN_N_USE': MIN_N_USE,
                               'rule': 'a bucket below %d rows is INSUFFICIENT (shown, never used); %d-%d PROVISIONAL; '
                                       '>= %d ESTIMABLE. Every bucket table carries empirical-Bayes shrunk cover, ROI and '
                                       'CLV (beta-binomial / normal-normal across the buckets of that table): a policy '
                                       'reads the shrunk numbers, never the raw ones' % (MIN_N_REPORT, MIN_N_REPORT, MIN_N_USE - 1, MIN_N_USE)}
    dump('s33_36_rank_order.json', s33)
    s20 = s2020(D, games, {'feats': list(s24['football']['final_model']['coef'].keys())})
    dump('s2020.json', s20)
    ps = price_sensitivity(Wd, priced)
    dump('price_sensitivity.json', ps)
    keep = ['decision_row_id', 'game_id', 'season', 'week', 'kickoff_ts', 'side', 'gap_pts', 'abs_gap_pts', 'pure_cover_prob',
            'p_cal', 'p_dec', 'w_used', 'push_prob', 'theoretical_ev', 'decision_ev', 'probability_edge', 'empirical_ev',
            'empirical_ev_decision', 'p_pos_clv_wf', 'exp_clv_wf', 'reliability', 'ens_sd', 'early_season', 'timing_bucket',
            'ats_result', 'ats_win', 'units_assumed_110', 'clv_pts', 'positive_clv']
    Wd[keep].to_parquet(out('decision_dev_walkforward.parquet'), index=False)
    summary = {'populations': {'dev_priced_fbs': int(len(priced)), 'dev_decision': int(len(W)),
                               'dev_decision_scored': int(Wd.season.isin(SCORED).sum()), 'review_rows': int(len(review)),
                               'football_games': int(len(games))},
               'scored_seasons': SCORED, 'priced_seasons': PRICED_SEASONS, 'elapsed_s': round(time.time() - t0, 1)}
    dump('study_summary.json', summary)
    print('[study] sections written in %.1fs' % (time.time() - t0))
    if freeze_artifact:
        from . import freeze
        freeze.main(W, Wd, s5, s10, s19, s24, s4, cond, s14, s33, s20, ps, summary)
        from . import render
        render.main()
    return Wd


if __name__ == '__main__':
    import sys
    main(freeze_artifact='--no-freeze' not in sys.argv)
