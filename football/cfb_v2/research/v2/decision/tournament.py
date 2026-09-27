"""The decision-policy study on DEV: the walk-forward policy tournament and every
policy analysis, then the frozen production policy.

    python3 -m v2.decision.tournament            (after v2.decision.study)

Rules: docs/cfb-decision/POLICY_PREREG.md (its sha256 is recorded in every
output; the run refuses to start without it). Reads ONLY DEV rows (a pyarrow
row filter on the decision dataset, a season filter on stage 7): the holdout is
scored once, later, by holdout.py. Writes out_h/decision/policy/*.json (and, with
--freeze, the policy artifact cfb_decision_policy_v1: policy.json, evidence.json,
MANIFEST.json). Deterministic: single-threaded BLAS, seed config.SEED, sorted
JSON, no wall-clock values in any output.
"""
import copy
import hashlib
import json
import math
import os
import sys

import numpy as np
import pandas as pd

from .. import config as C
from . import core
from . import calibration as CAL
from . import dataset as DS
from . import policy as POL
from . import portfolio as PF
from .scorecard import scorecard, cluster_boot, paired_cluster_diff, r, rl, sample_status

SCORED = [2018, 2019, 2021, 2022, 2023]
EVAL = [2019, 2021, 2022, 2023]
BE110 = float(core.break_even(-110))
B110 = 100.0 / 110.0
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '..'))
PREREG = os.path.join(REPO, 'docs', 'cfb-decision', 'POLICY_PREREG.md')
POLICY_VERSION = 'cfb_decision_policy_v1'
POLICY_DIR = os.path.join(POL.ARTIFACTS, POLICY_VERSION)
FROZEN_AT = '2026-09-27'                         # the policy's declared freeze date (no wall clock in outputs)
MIN_TRAIN = 100
ENS_TERCILE_EDGE = 1.649                          # CALIBRATION.md §7 DEV tercile edge (declared)
GATES = {
    'not_early': lambda d: d.early_season.eq(0).values,
    'low_disagreement': lambda d: (d.ens_sd < ENS_TERCILE_EDGE).values,
    'reliability_40': lambda d: (d.reliability >= 40).values,
    'qb_resolved': lambda d: (d.qb_missing.eq(0) & d.qb_unsettled.eq(0)).values,
    'gap_below_10': lambda d: (d.gap_pts < 10).values,
}
CANDIDATES = {
    'edge': {'grid': [0.0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05],
             'mask': lambda d, t: (d.probability_edge >= t - 1e-12).values},
    'decision_ev': {'grid': [0.0, 0.01, 0.02, 0.03, 0.04, 0.05], 'mask': lambda d, t: (d.decision_ev >= t - 1e-12).values},
    'clv_model': {'grid': [0.50, 0.55, 0.58, 0.60, 0.65],
                  'mask': lambda d, t: ((d.probability_edge > 0) & (d.p_pos_clv_wf >= t - 1e-12)).values},
    'gap': {'grid': [2.0, 3.0, 4.0, 5.0, 6.0, 7.0], 'mask': lambda d, t: (d.gap_pts >= t - 1e-12).values},
}
FIXED = {
    'baseline_001': lambda d: d.b_bet.values.astype(bool),
    'baseline_lean': lambda d: d.b_lean.values.astype(bool),
    'empirical_ev': lambda d: (d.empirical_ev_decision >= 0).values,
    'none': lambda d: np.zeros(len(d), bool),
}


def out_dir():
    p = os.path.join(DS.out_dir(), 'policy')
    os.makedirs(p, exist_ok=True)
    return p


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        h.update(f.read())
    return h.hexdigest()


def dump(name, obj):
    with open(os.path.join(out_dir(), name), 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=_js, allow_nan=False)
        f.write('\n')


def _js(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def clean(o):
    """NaN/inf -> None throughout (JSON has neither)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, np.floating):
        return None if not np.isfinite(o) else float(o)
    return o


# ================================================================== data
DS_COLS = ['decision_row_id', 'window', 'model_version', 'pure_margin', 'sigma', 't_df', 'quote_home_line', 'quote_line_margin',
           'close_line_margin', 'final_margin', 'is_push', 'qb_missing', 'qb_unsettled', 'data_completeness', 'total_line',
           'abs_line', 'is_home_side', 'side_sign', 'moved_toward_model', 'abs_line_move', 'home_conference', 'away_conference',
           'decision_ts', 'prediction_ts', 'is_postseason', 'units_archive_price', 'archive_open_price_side',
           'archive_open_price_other', 'pricing_scope', 'quote_role', 'status', 'book']


def load_dev():
    """The walk-forward frame (DEV) joined to DEV dataset columns and the frozen baseline (stage 7, DEV seasons)."""
    W = pd.read_parquet(os.path.join(DS.out_dir(), 'decision_dev_walkforward.parquet'))
    D = pd.read_parquet(os.path.join(DS.out_dir(), 'decision_dataset.parquet'), columns=DS_COLS,
                        filters=[('window', '==', 'dev')])
    assert set(D.window) == {'dev'}
    U = W.merge(D.drop(columns=['window']), on='decision_row_id', how='left', validate='one_to_one')
    assert not set(U.season) & (set(C.HOLDOUT_SEASONS) | {C.LIVE_SEASON})
    CAL.assert_fit_rows(U.assign(window='dev'))
    S7 = pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'),
                         columns=['game_id', 'season', 'ev', 'side', 'gap_open', 'early_season', 'reliability', 'line',
                                  'bet_units', 'bet_result', 'clv_pts', 'p_side', 'margin', 'total_pts', 'home_points',
                                  'away_points', 'close_margin', 'total_close', 'fcs_game', 'status'],
                         filters=[('season', '<=', max(C.DEV_SEASONS))])
    assert S7.season.max() <= max(C.DEV_SEASONS)
    b = S7.rename(columns={'ev': 'b_ev', 'side': 'b_side', 'gap_open': 'b_gap', 'early_season': 'b_early',
                           'reliability': 'b_rel', 'line': 'b_line', 'bet_units': 'b_units', 'clv_pts': 'b_clv',
                           'p_side': 'b_p', 'bet_result': 'b_result'})
    U = U.merge(b[['game_id', 'b_ev', 'b_side', 'b_gap', 'b_early', 'b_rel', 'b_line', 'b_units', 'b_clv', 'b_p', 'b_result']],
                on='game_id', how='left', validate='many_to_one')
    rule = json.load(open(os.path.join(POL.ARTIFACTS, 'cfb_decision_baseline_001', 'MANIFEST.json')))['production_rule']
    has = U.b_ev.notna()
    U['b_lean'] = has & (U.b_ev > rule['lean_ev']) & (U.b_gap.abs() >= rule['lean_gap'])
    U['b_bet'] = U.b_lean & (U.b_ev > rule['bet_ev']) & (U.b_gap.abs() >= rule['bet_gap']) & (U.b_rel >= rule['bet_min_rel'])
    if rule.get('exclude_early'):
        U['b_bet'] &= ~U.b_early.fillna(0).astype(bool)
    U['units'] = U.units_assumed_110
    U['p_dec_'] = U.p_dec
    U['kickoff_iso'] = pd.to_datetime(U.kickoff_ts, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    U['decision_ts_iso'] = pd.to_datetime(U.decision_ts, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    G = S7[S7.status.eq('FINAL') & ~S7.fcs_game.astype(bool) & S7.season.isin(C.DEV_SEASONS)].copy()
    return U, G, rule


def residual_table(U):
    """The close-implied EV's distribution: e = final margin - close (half-point grid), symmetrized."""
    d = U[U.final_margin.notna() & U.close_line_margin.notna()]
    e = np.round(2 * (d.final_margin.values - d.close_line_margin.values)) / 2
    e = np.concatenate([e, -e])
    vals, cnt = np.unique(e, return_counts=True)
    return {'values': vals, 'p': cnt / cnt.sum(), 'n_games': int(len(d)),
            'seasons': sorted(int(s) for s in d.season.unique())}


def close_ev(clv, table):
    """Close-implied EV at -110 of a bet with side-oriented CLV `clv` (points)."""
    c = np.round(2 * np.asarray(clv, float)) / 2
    v, p = table['values'], table['p']
    cdf = np.cumsum(p)
    out = np.full(len(c), np.nan)
    ok = np.isfinite(c)
    x = -c[ok]
    i_le = np.searchsorted(v, x, side='right')            # P(e <= x)
    i_lt = np.searchsorted(v, x, side='left')             # P(e < x)
    p_le = np.where(i_le > 0, cdf[np.maximum(i_le - 1, 0)], 0.0)
    p_lt = np.where(i_lt > 0, cdf[np.maximum(i_lt - 1, 0)], 0.0)
    p_win = 1 - p_le
    p_loss = p_lt
    out[ok] = p_win * B110 - p_loss
    return out


def prepare(U, table):
    U = U.copy()
    U['close_ev'] = close_ev(U.clv_pts.values, table)
    U['p_dec'] = U.p_dec_
    return U


# =============================================================== selection
def fold_score(train, mask, B=1000, seed=None):
    s = train[mask]
    n = int(len(s))
    if n < MIN_TRAIN:
        return {'n': n, 'eligible': False}
    ci90, draws = cluster_boot(s.close_ev.values, s.game_id.values, B=B, seed=seed, alpha=0.10, return_draws=True)
    return {'n': n, 'eligible': True, 'mean': float(np.mean(s.close_ev)), 'lb90': float(ci90[0]), 'sd': float(np.std(draws))}


def choose(train, grid, mask_fn):
    rows = []
    for t in grid:
        sc = fold_score(train, mask_fn(train, t))
        sc['t'] = t
        rows.append(sc)
    el = [i for i, x in enumerate(rows) if x['eligible']]
    if not el:
        return None, rows, None
    bi = max(el, key=lambda i: (rows[i]['lb90'], -i))
    thr = rows[bi]['lb90'] - rows[bi]['sd']
    lo = hi = bi
    while lo - 1 >= 0 and rows[lo - 1]['eligible'] and rows[lo - 1]['lb90'] >= thr:
        lo -= 1
    while hi + 1 < len(rows) and rows[hi + 1]['eligible'] and rows[hi + 1]['lb90'] >= thr:
        hi += 1
    run = list(range(lo, hi + 1))
    ci = run[len(run) // 2]
    return grid[ci], rows, {'best': grid[bi], 'plateau': [grid[i] for i in run], 'threshold': thr}


def paired_gate_se(train, base_mask, gate_mask, B=1000, seed=None):
    """Bootstrap SD of (mean close EV with the gate - without) over training games."""
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    g = train.game_id.values
    codes, inv = np.unique(g, return_inverse=True)
    G = len(codes)
    ce = train.close_ev.values
    a = base_mask & gate_mask
    s_all = np.bincount(inv, weights=np.where(base_mask, ce, 0.0), minlength=G)
    n_all = np.bincount(inv, weights=base_mask.astype(float), minlength=G)
    s_g = np.bincount(inv, weights=np.where(a, ce, 0.0), minlength=G)
    n_g = np.bincount(inv, weights=a.astype(float), minlength=G)
    d = np.empty(B)
    for i in range(B):
        j = rng.integers(0, G, G)
        d[i] = s_g[j].sum() / max(n_g[j].sum(), 1) - s_all[j].sum() / max(n_all[j].sum(), 1)
    return float(np.std(d))


def choose_multivariate(train):
    t, rows, pl = choose(train, CANDIDATES['edge']['grid'], CANDIDATES['edge']['mask'])
    if t is None:
        return None, [], {'edge_rows': rows}
    base = CANDIDATES['edge']['mask'](train, t)
    cur = fold_score(train, base)
    gates, log = [], []
    for _ in range(2):
        best = None
        for gname, gf in GATES.items():
            if gname in gates:
                continue
            m = base & gf(train)
            sc = fold_score(train, m)
            if not sc['eligible']:
                log.append({'gate': gname, 'eligible': False, 'n': sc['n']})
                continue
            se = paired_gate_se(train, base, gf(train))
            gain = sc['lb90'] - cur['lb90']
            log.append({'gate': gname, 'n': sc['n'], 'gain': gain, 'se': se, 'adopt': bool(gain > se)})
            if gain > se and (best is None or gain > best[1]):
                best = (gname, gain, m, sc)
        if best is None:
            break
        gates.append(best[0])
        base, cur = best[2], best[3]
    return (t, tuple(gates)), log, {'edge_plateau': pl}


def mv_mask(d, choice):
    t, gates = choice
    m = CANDIDATES['edge']['mask'](d, t)
    for g in gates:
        m = m & GATES[g](d)
    return m


def run_tournament(U):
    """Every candidate: fold choices on seasons < S, OOS selections on S in EVAL, the final DEV choice."""
    Sc = U[U.season.isin(SCORED)].copy()
    res = {}
    sel = {}
    for cid in list(CANDIDATES) + ['multivariate']:
        folds, oos = {}, np.zeros(len(Sc), bool)
        for S in EVAL:
            tr = Sc[Sc.season < S]
            CAL.assert_past_only(sorted(tr.season.unique()), S)
            ev = Sc.season.eq(S).values
            if cid == 'multivariate':
                ch, log, extra = choose_multivariate(tr)
                folds[S] = {'choice': list(ch) if ch else None, 'gate_log': log, **extra, 'n_train': int(len(tr))}
                if ch is not None:
                    oos |= ev & mv_mask(Sc, ch)
            else:
                spec = CANDIDATES[cid]
                ch, rows, pl = choose(tr, spec['grid'], spec['mask'])
                folds[S] = {'choice': ch, 'scores': rows, 'plateau': pl, 'n_train': int(len(tr))}
                if ch is not None:
                    oos |= ev & spec['mask'](Sc, ch)
        if cid == 'multivariate':
            fin, flog, fextra = choose_multivariate(Sc)
            final = {'choice': list(fin) if fin else None, 'gate_log': flog, **fextra}
        else:
            fin, frows, fpl = choose(Sc, CANDIDATES[cid]['grid'], CANDIDATES[cid]['mask'])
            final = {'choice': fin, 'scores': frows, 'plateau': fpl}
        sel[cid] = oos
        res[cid] = {'folds': {str(k): v for k, v in folds.items()}, 'final_dev': final}
    for cid, fn in FIXED.items():
        m = fn(Sc) & Sc.season.isin(EVAL).values
        sel[cid] = m
        res[cid] = {'folds': None, 'final_dev': {'choice': 'fixed'}}
    return Sc, res, sel


def oos_metrics(Sc, mask, B=2000):
    d = Sc[mask]
    card = scorecard(d, B=B)
    by = {}
    for S in EVAL:
        s = d[d.season.eq(S)]
        by[str(S)] = {'n': int(len(s)), 'clv': r(s.clv_pts.mean(), 3) if len(s) else None,
                      'roi': r(s.units.mean()) if len(s) else None, 'close_ev': r(s.close_ev.mean(), 5) if len(s) else None,
                      'cover': r(s.ats_win.mean()) if len(s) else None}
    card['by_season'] = by
    return card


def fixed_threshold_table(Sc, cid):
    """§55 robustness: every grid value applied as a fixed threshold to the evaluated seasons."""
    spec = CANDIDATES[cid]
    ev = Sc.season.isin(EVAL).values
    rows = []
    for t in spec['grid']:
        m = ev & spec['mask'](Sc, t)
        d = Sc[m]
        row = {'t': t, 'n': int(len(d))}
        if len(d):
            row.update({'roi': r(d.units.mean()), 'roi_ci': rl(cluster_boot(d.units.values, d.game_id.values)),
                        'clv': r(d.clv_pts.mean(), 3), 'clv_ci': rl(cluster_boot(d.clv_pts.values, d.game_id.values), 3),
                        'close_ev': r(d.close_ev.mean(), 5),
                        'close_ev_ci': rl(cluster_boot(d.close_ev.values, d.game_id.values), 5),
                        'cover': r(d.ats_win.mean()), 'max_drawdown': r(core.max_drawdown(d.sort_values('kickoff_ts').units.values), 2),
                        'sample_status': sample_status(len(d))})
        rows.append(row)
    return rows


def bet_valid(cid, Sc, mask, res, card, fixed_rows, base_mask, risk):
    """The pre-registered BET-VALID criteria (POLICY_PREREG.md §4)."""
    d = Sc[mask]
    crit = {}
    seasons_with = sum(1 for S in EVAL if (d.season == S).sum() > 0)
    crit['1_sample'] = bool(len(d) >= 300 and seasons_with >= 3)
    ce = card.get('close_implied_ev_ci') or [None, None]
    crit['2_pricing'] = bool(ce[0] is not None and ce[0] > 0)
    cc = card.get('avg_clv_ci') or [None, None]
    pw = card.get('positive_clv_wilson') or [None, None]
    crit['3_clv'] = bool(cc[0] is not None and cc[0] > 0 and pw[0] is not None and pw[0] > 0.5)
    rc = card.get('roi_ci') or [None, None]
    crit['4_outcome'] = bool(rc[0] is not None and rc[0] > 0)
    crit['5_calibration'] = bool(card.get('calibrated_in_the_large'))
    st_a = all((v['clv'] or 0) > 0 for v in card['by_season'].values() if v['n'] >= 20) and len(d) > 0
    st_b, st_c = None, None
    if cid in CANDIDATES or cid == 'multivariate':
        fin = res[cid]['final_dev']['choice']
        grid = CANDIDATES['edge' if cid == 'multivariate' else cid]['grid']
        fv = fin[0] if (cid == 'multivariate' and fin) else fin
        chs = [(f['choice'][0] if (cid == 'multivariate' and f['choice']) else f['choice']) for f in res[cid]['folds'].values()]
        if fv is None:
            st_b = st_c = False
        else:
            gi = grid.index(fv)
            st_b = sum(1 for c in chs if c is not None and abs(grid.index(c) - gi) <= 1) >= 3
            if fixed_rows is not None:
                me = fixed_rows[gi]
                nb = [fixed_rows[j] for j in (gi - 1, gi + 1) if 0 <= j < len(grid)]
                st_c = all(x['n'] > 0 and me['n'] > 0 and np.sign(x['close_ev'] or 0) == np.sign(me['close_ev'] or 0)
                           and abs((x['roi'] or 0) - (me['roi'] or 0)) <= 0.05 for x in nb)
            else:
                st_c = True
    else:
        st_b = st_c = True
    crit['6_stability'] = bool(st_a and st_b and st_c)
    ev = Sc.season.isin(EVAL).values
    E = Sc[ev]
    pu = np.where(mask[ev], E.units.values, 0.0)
    bu = np.where(base_mask[ev], E.b_units.values, 0.0)
    pdiff = paired_cluster_diff(pu, bu, E.game_id.values)
    bclv = float(E[base_mask[ev]].b_clv.mean()) if base_mask[ev].any() else float('nan')
    crit['7_paired_vs_baseline'] = bool(pdiff['ci'][1] is not None and pdiff['ci'][1] >= 0
                                        and len(d) > 0 and (card.get('avg_clv') or -9) >= (bclv if np.isfinite(bclv) else -9))
    crit['8_risk'] = bool(risk is not None and risk.get('passes'))
    valid = all(crit.values())
    pricing_only = crit['1_sample'] and crit['2_pricing'] and crit['3_clv'] and crit['5_calibration'] and not crit['4_outcome']
    return {'criteria': crit, 'stability_parts': {'clv_positive_each_season': bool(st_a), 'fold_choices_near_final': st_b,
                                                  'neighbours_no_collapse': st_c},
            'paired_vs_baseline_units_per_quote': pdiff, 'baseline_clv_per_bet': r(bclv, 3),
            'verdict': 'BET-VALID' if valid else ('PRICING-ONLY' if pricing_only else 'NOT VALID')}


def risk_block(Sc, mask, icc_hi):
    """§4.8: season drawdown (week blocks) and risk of ruin at the 2.5th percentile posterior cover."""
    ev = Sc.season.isin(EVAL)
    d = Sc[mask]
    if len(d) < 30:
        return {'passes': False, 'note': 'fewer than 30 OOS bets: not simulated'}
    blocks = PF.week_blocks(d, Sc[ev])
    sb = PF.season_bootstrap(blocks)
    w = int(d.ats_win.eq(1).sum())
    l = int(d.ats_win.eq(0).sum())
    pp = float(d.is_push.mean()) if 'is_push' in d else 0.02
    rr = PF.risk_of_ruin(w, l, pp, [len(b) for b in blocks], icc_hi, bankrolls=(25, 50, 100))
    ror = rr['by_bankroll']['100']['p025']['ror']
    return {'season_bootstrap': sb, 'risk_of_ruin': rr, 'passes': bool(sb['max_drawdown_p95'] <= 25 and ror <= 0.01)}


# ============================================================== challenger
CHALLENGER_FEATURES = ['gap_pts', 'pure_cover_prob', 'reliability', 'ens_sd', 'early_season', 'qb_missing', 'qb_unsettled',
                       'abs_line', 'is_home_side', 'week']


def auc(y, p):
    from scipy.stats import rankdata
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    n1, n0 = y.sum(), len(y) - y.sum()
    if n1 == 0 or n0 == 0:
        return None
    rk = rankdata(p)
    return float((rk[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def decision_model_challenger(U):
    """§18: an interpretable logistic model of positive CLV with market-state and quote features, walk-forward,
    against the frozen p_positive_clv (walk-forward predictions from the calibration study)."""
    T = U.copy()
    T['qb_missing'] = T.qb_missing.astype(float)
    T['qb_unsettled'] = T.qb_unsettled.astype(float)
    pred = pd.Series(np.nan, index=T.index)
    specs = {}
    for S in SCORED:
        tr = T[T.season < S]
        CAL.assert_past_only(CAL.assert_fit_rows(tr.assign(window='dev')), S)
        spec = CAL.fit_model(tr, CHALLENGER_FEATURES, 'positive_clv', kind='logistic', l2=100.0)
        m = T.season.eq(S)
        pred[m] = CAL.eval_model_np(spec, T[m])
        specs[str(S)] = {k: (r(v, 4) if not isinstance(v, dict) else {kk: r(vv, 4) for kk, vv in v.items()})
                         for k, v in spec.items() if k in ('intercept', 'coef', 'n_train')}
    sc = T[T.season.isin(SCORED)]
    y = sc.positive_clv.values
    a_new, a_old = auc(y, pred[sc.index].values), auc(y, sc.p_pos_clv_wf.values)
    ll_new = core.log_loss(y, pred[sc.index].values)
    ll_old = core.log_loss(y, sc.p_pos_clv_wf.values)
    rng = np.random.default_rng(C.SEED)
    n = len(sc)
    dd = []
    pn, po = pred[sc.index].values, sc.p_pos_clv_wf.values
    for _ in range(1000):
        j = rng.integers(0, n, n)
        a1, a0 = auc(y[j], pn[j]), auc(y[j], po[j])
        if a1 is not None and a0 is not None:
            dd.append(a1 - a0)
    dll = core.boot_paired_diff(ll_new, ll_old)
    ci = [float(np.quantile(dd, 0.025)), float(np.quantile(dd, 0.975))]
    adopt = bool(ci[0] > 0 and dll['mean'] <= 0)
    return {'features': CHALLENGER_FEATURES, 'ridge': 100.0, 'auc_challenger': r(a_new), 'auc_frozen': r(a_old),
            'auc_diff_ci95': rl(ci), 'log_loss_challenger': r(ll_new.mean(), 5), 'log_loss_frozen': r(ll_old.mean(), 5),
            'log_loss_diff': r(dll['mean'], 5), 'log_loss_diff_ci95': rl(dll['ci'], 5), 'adopted': adopt,
            'walk_forward_fits': specs,
            'rule': 'adopt only if the AUC gain 95% CI > 0 and the log loss is not worse (POLICY_PREREG §3)'}


# ============================================================ replay setup
def season_artifacts(A, U):
    """Per scored season: the frozen artifact with the WALK-FORWARD shrink weight of that season and its
    walk-forward decision-EV curve (2019+; 2018 keeps the frozen curve, labelled)."""
    s10 = json.load(open(os.path.join(DS.out_dir(), 's10_11_ev.json')))['ev_curve_decision_walk_forward']
    arts = {}
    for S in SCORED:
        a = copy.deepcopy(A)
        w = float(U[U.season.eq(S)].w_used.iloc[0])
        a['market_shrinkage'] = dict(a['market_shrinkage'], w_model=w)
        if str(S) in s10:
            a['ev_curve_decision'] = {'input': 'decision_ev', 'x': s10[str(S)]['x'], 'y': s10[str(S)]['y']}
        arts[S] = a
    return arts


def replay_frame(Sc, policy, arts, home_line_col='quote_home_line', previous=None, with_targets=False):
    rows = Sc.to_dict('records')
    out = []
    for i, rw in enumerate(rows):
        if home_line_col != 'quote_home_line':
            rw = dict(rw)
            rw['_home_line'] = rw[home_line_col]
            rw['decision_ts_iso'] = rw['close_ts_iso']
        pure, quote, row, market, now = POL.row_to_inputs(rw, -110.0, -110.0, rw.get('_home_line'))
        ctx = {'policy': policy, 'artifact': arts[int(rw['season'])], 'now': now, 'market': market, 'row': row,
               'expected_model_version': pure['model_version']}
        if previous is not None and previous[i] is not None:
            ctx['previous'] = previous[i]
        out.append(POL.decide_quote(pure, quote, ctx, with_targets=with_targets))
    return out


def status_table(Sc, decisions, by='status'):
    d = Sc.copy()
    d['_status'] = [x['status'] for x in decisions]
    d['_reason'] = [x['reason_codes'][0] if x['reason_codes'] else '' for x in decisions]
    d['_codes'] = ['|'.join(x['reason_codes']) for x in decisions]
    key = {'status': '_status', 'reason': '_reason', 'codes': '_codes'}[by]
    rows = []
    for k, g in d.groupby(key, sort=True):
        c = scorecard(g, B=1000, drawdown=False)
        c['group'] = k
        rows.append(c)
    return rows, d


# ================================================================ analyses
def lean_gap_rule(Sc):
    rows, choice = [], None
    for g in (0.5, 1.0, 1.5, 2.0):
        s = Sc[(Sc.gap_pts >= g) & (Sc.gap_pts < g + 1)]
        ci = cluster_boot(s.clv_pts.values, s.game_id.values)
        rows.append({'g': g, 'n': int(len(s)), 'clv': r(s.clv_pts.mean(), 3), 'clv_ci': rl(ci, 3)})
        if choice is None and ci[0] is not None and ci[0] > 0:
            choice = g
    return {'choice': choice if choice is not None else 2.0, 'rows': rows,
            'rule': 'smallest g in {0.5, 1, 1.5, 2} whose rows with |gap| in [g, g+1) have mean CLV 95% LB > 0'}


def saturation(Sc):
    rows, psat = [], None
    for lo, hi in ((0.5, 0.525), (0.525, 0.55), (0.55, 0.575), (0.575, 0.60), (0.60, 1.01)):
        s = Sc[(Sc.p_dec >= lo) & (Sc.p_dec < hi)]
        c = scorecard(s, B=1000, drawdown=False) if len(s) else {'bet_count': 0}
        c['bucket'] = '%.3f-%.3f' % (lo, hi)
        rows.append(c)
        if len(s) >= 300 and hi <= 0.60:
            psat = hi
    gap_rows = []
    for lo, hi in ((5, 7), (7, 10), (10, 14)):
        s = Sc[(Sc.gap_pts >= lo) & (Sc.gap_pts < hi)]
        c = scorecard(s, B=1000, drawdown=False)
        c['bucket'] = 'gap %s-%s' % (lo, hi)
        gap_rows.append(c)
    return {'p_saturation': psat, 'decision_p_buckets': rows, 'gap_buckets': gap_rows,
            'rule': 'upper edge of the highest decision-probability bucket with >= 300 scored DEV rows'}


def selectivity(Sc):
    E = Sc[Sc.season.isin(EVAL)]
    out = {}
    for score in ('probability_edge', 'p_pos_clv_wf', 'exp_clv_wf'):
        rows = []
        for k in (0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.75, 1.0):
            n = max(1, int(round(k * len(E))))
            d = E.sort_values([score, 'decision_row_id'], ascending=[False, True], kind='mergesort').head(n)
            c = scorecard(d, B=1000)
            rows.append({'top_share': k, 'n': n, 'clv': c.get('avg_clv'), 'clv_ci': c.get('avg_clv_ci'),
                         'close_ev': c.get('close_implied_ev'), 'close_ev_ci': c.get('close_implied_ev_ci'),
                         'roi': c.get('roi'), 'roi_ci': c.get('roi_ci'), 'max_drawdown': c.get('max_drawdown'),
                         'calibration_error': c.get('calibration_error'), 'cover': (c.get('ats') or {}).get('cover_rate'),
                         'sample_status': sample_status(n)})
        out[score] = rows
    return out


def rank_order(Sc):
    E = Sc[Sc.season.isin(EVAL)].copy()
    out = {}
    for score in ('probability_edge', 'decision_ev', 'p_pos_clv_wf', 'exp_clv_wf', 'gap_pts'):
        E['_d'] = pd.qcut(E[score].rank(method='first'), 10, labels=False)
        rows = []
        for k, g in E.groupby('_d'):
            rows.append({'decile': int(k) + 1, 'n': int(len(g)), 'score_mean': r(g[score].mean(), 4),
                         'clv': r(g.clv_pts.mean(), 3), 'close_ev': r(g.close_ev.mean(), 5), 'roi': r(g.units.mean()),
                         'cover': r(g.ats_win.mean())})
        tests = {}
        for o in ('clv_pts', 'close_ev', 'units', 'ats_win'):
            means = [x[{'clv_pts': 'clv', 'close_ev': 'close_ev', 'units': 'roi', 'ats_win': 'cover'}[o]] for x in rows]
            sp = CAL.spearman_perm(list(range(10)), means, n_perm=5000)
            x = E._d.values.astype(float)
            yv = E[o].values.astype(float)
            ok = np.isfinite(yv)
            slope = float(np.polyfit(x[ok], yv[ok], 1)[0])
            rng = np.random.default_rng(C.SEED)
            idx = np.flatnonzero(ok)
            bs = [np.polyfit(x[j], yv[j], 1)[0] for j in (rng.choice(idx, len(idx)) for _ in range(500))]
            tests[o] = {'spearman': r(sp['rho']), 'perm_p': r(sp['p']), 'slope_per_decile': r(slope, 5),
                        'slope_ci': rl([np.quantile(bs, 0.025), np.quantile(bs, 0.975)], 5),
                        'monotone_increasing_supported': bool(np.quantile(bs, 0.025) > 0),
                        'adjacent_inversions': int(sum(1 for a, b in zip(means[:-1], means[1:]) if b < a))}
        out[score] = {'rows': rows, 'tests': tests}
    return out


def pe_at_close(Sc):
    """The probability edge of the SAME side at the closing line (the fold's walk-forward weight)."""
    L = Sc.close_line_margin.values
    ph = core.cover_prob_home(Sc.pure_margin.values, Sc.sigma.values, L, Sc.t_df.values)
    side_home = Sc.side.eq('HOME').values
    p = np.where(side_home, ph, 1 - ph)
    pdc = CAL.shrink_np(p, 0.5, Sc.w_used.values)
    return pdc - BE110


def units_at_close(Sc):
    s = np.where(Sc.side.eq('HOME'), 1.0, -1.0)
    diff = s * (Sc.final_margin.values - Sc.close_line_margin.values)
    return np.where(diff > 0, B110, np.where(diff < 0, -1.0, 0.0))


def timing_analysis(Sc, t_edge):
    d = Sc[Sc.close_line_margin.notna()].copy()
    d['pe_close'] = pe_at_close(d)
    d['units_close'] = units_at_close(d)
    out = {}
    for name, m in (('lean_set_pe_gt_0', d.probability_edge > 0), ('edge_region', d.probability_edge >= t_edge),
                    ('all_rows', np.ones(len(d), bool))):
        s = d[m]
        pdiff = paired_cluster_diff(s.units.values, s.units_close.values, s.game_id.values)
        out[name] = {'n': int(len(s)), 'roi_bet_now_opener': r(s.units.mean()), 'roi_wait_to_close': r(s.units_close.mean()),
                     'now_minus_wait': pdiff, 'clv': r(s.clv_pts.mean(), 3), 'clv_ci': rl(cluster_boot(s.clv_pts.values, s.game_id.values), 3),
                     'close_ev_now': r(s.close_ev.mean(), 5),
                     'share_close_better_for_us': r((s.clv_pts < 0).mean()),
                     'regret_bet_now_pts': r(np.where(s.clv_pts < 0, -s.clv_pts, 0).mean(), 3)}
    er = d[d.probability_edge >= t_edge]
    wc = er[er.exp_clv_wf < 0]
    wci = cluster_boot(wc.clv_pts.values, wc.game_id.values) if len(wc) >= 20 else [None, None]
    wait_ok = bool(len(wc) >= 100 and wci[1] is not None and wci[1] < -0.25)
    out['wait_rule'] = {'n_expected_clv_negative': int(len(wc)), 'realized_clv': r(wc.clv_pts.mean(), 3) if len(wc) else None,
                        'realized_clv_ci': rl(wci, 3), 'wait_enabled': wait_ok,
                        'rule': 'WAIT only if n >= 100 edge-region rows with expected CLV < 0 and realized CLV 95% UB < -0.25'}
    later = d[(d.probability_edge <= 0) & (d.pe_close > 0)]
    out['pass_regret'] = {'passed_at_open_positive_edge_at_close': int(len(later)),
                          'share_of_passes': r(len(later) / max(1, int((d.probability_edge <= 0).sum()))),
                          'their_roi_at_close': r(later.units_close.mean()) if len(later) else None,
                          'their_roi_at_close_ci': rl(cluster_boot(later.units_close.values, later.game_id.values)) if len(later) >= 20 else None,
                          'their_cover_at_close': r(later.units_close.gt(0).mean()) if len(later) else None}
    gone = d[(d.probability_edge > 0) & (d.pe_close <= 0)]
    kept = d[(d.probability_edge > 0) & (d.pe_close > 0)]
    out['edge_disappearance'] = {
        'edge_at_open_gone_at_close': int(len(gone)), 'share_of_edges': r(len(gone) / max(1, int((d.probability_edge > 0).sum()))),
        'gone_roi_at_opener': r(gone.units.mean()) if len(gone) else None,
        'gone_roi_at_close': r(gone.units_close.mean()) if len(gone) else None,
        'gone_roi_at_close_ci': rl(cluster_boot(gone.units_close.values, gone.game_id.values)) if len(gone) >= 20 else None,
        'kept_roi_at_close': r(kept.units_close.mean()) if len(kept) else None,
        'kept_roi_at_close_ci': rl(cluster_boot(kept.units_close.values, kept.game_id.values)) if len(kept) >= 20 else None,
        'kept_n': int(len(kept))}
    er = d[d.probability_edge >= t_edge]
    dpe = np.abs(er.pe_close.values - er.probability_edge.values)
    med = float(np.median(dpe)) if len(dpe) else 0.0
    buf = min(0.005, round(0.5 * med / 0.0005) * 0.0005)
    flips = {}
    for b in (0.0, 0.0025, 0.005, buf):
        on_open = er.probability_edge.values >= t_edge
        stay = er.pe_close.values >= t_edge - b
        flips['%.4f' % b] = {'bet_at_open_not_at_close': int((on_open & ~stay).sum()), 'n': int(on_open.sum()),
                             'flip_rate': r(float((on_open & ~stay).mean()) if len(er) else None)}
    near = d[(d.probability_edge - t_edge).abs() <= 0.01]
    out['stability'] = {'median_abs_open_to_close_edge_change_in_region': r(med, 5), 'hysteresis_buffer_rule_value': buf,
                        'flips_by_buffer': flips, 'near_threshold_share': r(len(near) / max(1, len(d))),
                        'rule': 'buffer = half the median |open->close edge change| in the edge region, rounded to 0.0005, capped at 0.005'}
    return out, d


def expected_vs_realized(Sc, masks):
    out = {}
    for name, m in masks.items():
        d = Sc[m].sort_values('kickoff_ts', kind='mergesort')
        if not len(d):
            out[name] = {'n': 0}
            continue
        p, pp = d.p_dec.values, d.push_prob.fillna(0).values
        exp = p * (1 - pp) * B110 - (1 - p) * (1 - pp)
        e2 = p * (1 - pp) * B110 ** 2 + (1 - p) * (1 - pp)
        var = e2 - exp ** 2
        u = d.units.values
        th = d.theoretical_ev.values
        cum_e, cum_u = np.cumsum(exp), np.cumsum(u)
        idx = np.unique(np.linspace(0, len(d) - 1, min(len(d), 25)).astype(int))
        out[name] = {'n': int(len(d)), 'expected_units_decision': r(exp.sum(), 2), 'expected_units_theoretical': r(th.sum(), 2),
                     'realized_units': r(u.sum(), 2), 'z_realized_vs_decision': r((u.sum() - exp.sum()) / math.sqrt(var.sum()), 3),
                     'z_realized_vs_theoretical': r((u.sum() - th.sum()) / math.sqrt(var.sum()), 3),
                     'curve': [{'bet': int(i + 1), 'expected': r(cum_e[i], 2), 'realized': r(cum_u[i], 2),
                                'theoretical': r(np.cumsum(th)[i], 2)} for i in idx]}
    return out


def tiers(Sc):
    E = Sc.copy()
    E['_tier'] = np.where(E.p_pos_clv_wf >= 0.58, 'HIGH', np.where(E.p_pos_clv_wf >= 0.52, 'MEDIUM', 'LOW'))
    rows = {}
    for t in ('LOW', 'MEDIUM', 'HIGH'):
        s = E[E._tier.eq(t)]
        c = scorecard(s, B=2000, drawdown=False)
        rows[t] = {k: c.get(k) for k in ('bet_count', 'avg_clv', 'avg_clv_ci', 'positive_clv_pct', 'positive_clv_wilson',
                                         'close_implied_ev', 'roi', 'roi_ci', 'ats', 'calibration_error')}
    hi, lo = E[E._tier.eq('HIGH')], E[E._tier.eq('LOW')]
    rng = np.random.default_rng(C.SEED)
    dd = [rng.choice(hi.clv_pts.values, len(hi)).mean() - rng.choice(lo.clv_pts.values, len(lo)).mean() for _ in range(2000)]
    diff_ci = [float(np.quantile(dd, 0.025)), float(np.quantile(dd, 0.975))]
    inc_clv = rows['LOW']['avg_clv'] < rows['MEDIUM']['avg_clv'] < rows['HIGH']['avg_clv']
    inc_pos = rows['LOW']['positive_clv_pct'] < rows['MEDIUM']['positive_clv_pct'] < rows['HIGH']['positive_clv_pct']
    display = bool(inc_clv and inc_pos and diff_ci[0] > 0)
    fc = {}
    for lab, lo_, hi_ in (('LOW', -1, 45), ('MEDIUM', 45, 70), ('HIGH', 70, 101)):
        s = E[(E.reliability >= lo_) & (E.reliability < hi_)]
        fc[lab] = {'n': int(len(s)), 'mae_model': r(np.abs(s.final_margin - s.pure_margin).mean(), 3),
                   'mae_ci': rl(cluster_boot(np.abs(s.final_margin - s.pure_margin).values, s.game_id.values), 3)}
    return {'bet_confidence_tiers': rows, 'high_minus_low_clv_ci': rl(diff_ci, 3), 'clv_increasing': bool(inc_clv),
            'positive_clv_increasing': bool(inc_pos), 'display_edge_quality_tiers': display,
            'football_confidence_labels_vs_error': fc,
            'football_confidence_labels_sort_error': bool(fc['HIGH']['mae_model'] < fc['MEDIUM']['mae_model'] < fc['LOW']['mae_model']
                                                          and fc['HIGH']['mae_ci'][1] < fc['LOW']['mae_ci'][0]),
            'rule': 'display tiers only if CLV and +CLV rate strictly increase LOW < MEDIUM < HIGH and HIGH - LOW CLV 95% CI > 0'}


def rankings(Sc, frozen_ev_curve):
    from scipy.stats import kendalltau
    d = Sc[Sc.probability_edge > 0].copy()
    d['_emp_frozen'] = np.interp(d.decision_ev.values, frozen_ev_curve['x'], frozen_ev_curve['y'])
    out = {}
    for key in ('_emp_frozen', 'decision_ev', 'p_pos_clv_wf', 'exp_clv_wf'):
        taus, wk = [], []
        for k, g in d.groupby(['season', 'week']):
            if len(g) < 3:
                continue
            if g[key].nunique() < 2:
                taus.append(0.0)
            else:
                t = kendalltau(g[key].values, g.clv_pts.values).statistic
                taus.append(0.0 if not np.isfinite(t) else float(t))
            wk.append(k)
        taus = np.array(taus)
        rng = np.random.default_rng(C.SEED)
        bs = [rng.choice(taus, len(taus)).mean() for _ in range(2000)] if len(taus) else [np.nan]
        ci = [float(np.quantile(bs, 0.025)), float(np.quantile(bs, 0.975))]
        out['frozen_empirical_ev' if key == '_emp_frozen' else key] = {
            'weeks': int(len(taus)), 'mean_kendall_tau': r(taus.mean() if len(taus) else None), 'ci95': rl(ci),
            'orders_clv': bool(ci[0] > 0)}
    out['display_bet_rankings'] = bool(out['frozen_empirical_ev']['orders_clv'])
    out['rule'] = ('display rankings only if the key decision.js ranks by (the calibrated EV under the frozen artifact) orders '
                   'realized CLV within weeks (mean Kendall tau 95% CI > 0); a constant key cannot')
    return out


def weekly_counts(Sc, masks):
    E = Sc[Sc.season.isin(EVAL)]
    weeks = E[['season', 'week']].drop_duplicates()
    out = {}
    for name, m in masks.items():
        c = E[m[Sc.season.isin(EVAL).values]].groupby(['season', 'week']).size()
        cnt = weeks.merge(c.rename('n').reset_index(), on=['season', 'week'], how='left').n.fillna(0).values
        out[name] = {'weeks': int(len(cnt)), 'zero_bet_weeks_share': r((cnt == 0).mean()), 'median': r(np.median(cnt), 1),
                     'p90': r(np.quantile(cnt, 0.9), 1), 'max': int(cnt.max()) if len(cnt) else 0,
                     'distribution': {str(int(k)): int(v) for k, v in zip(*np.unique(cnt, return_counts=True))}}
    return out


def research_evidence(Sc):
    d = Sc[Sc.probability_edge > 0]
    flag = d.qb_missing.astype(bool) | d.qb_unsettled.astype(bool)
    out = {}
    for k, s in (('qb_flagged', d[flag]), ('qb_clear', d[~flag])):
        c = scorecard(s, B=2000, drawdown=False)
        out[k] = {kk: c.get(kk) for kk in ('bet_count', 'avg_clv', 'avg_clv_ci', 'positive_clv_pct', 'close_implied_ev',
                                           'close_implied_ev_ci', 'roi', 'roi_ci', 'ats', 'calibration_error', 'mean_p_dec')}
    out['clv_diff_flagged_minus_clear'] = paired_like_diff(d[flag].clv_pts.values, d[~flag].clv_pts.values)
    return out


def paired_like_diff(a, b, B=2000):
    rng = np.random.default_rng(C.SEED)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 20 or len(b) < 20:
        return {'diff': None, 'ci': None}
    dd = [rng.choice(a, len(a)).mean() - rng.choice(b, len(b)).mean() for _ in range(B)]
    return {'diff': r(a.mean() - b.mean(), 3), 'ci': rl([np.quantile(dd, 0.025), np.quantile(dd, 0.975)], 3)}


# ============================================================ the policy
def derive_policy(res, sel, Sc, lean, sat, timing, tier, rank, slate, prereg_sha, valid, kelly_ok):
    fin = res['edge']['final_dev']['choice']
    min_pe = float(fin) if fin is not None else 0.03
    mv = res['multivariate']['final_dev']['choice']
    gates = set(mv[1]) if mv else set()
    edge_valid = valid['edge']['verdict'] == 'BET-VALID'
    P = {
        'version': POLICY_VERSION, 'status': 'SHADOW', 'bet_enabled': False,
        'note': ('Derived by the pre-registered rules of docs/cfb-decision/POLICY_PREREG.md from the DEV walk-forward policy '
                 'study (docs/cfb-decision/POLICY.md). Betting is disabled: turning it on is a person\'s promotion decision '
                 'through the section-86 gate, which this policy fails. Under the frozen calibration artifact the calibrated '
                 '(curve-mapped) EV is -0.0317 at every price, so no quote clears min_ev and the BET region is empty.'),
        'prereg_sha256': prereg_sha, 'calibration_artifact': 'cfb_decision_calibration_v1', 'baseline': 'cfb_decision_baseline_001',
        'min_probability_edge': min_pe, 'min_ev': 0.0, 'ideal_probability_edge': round(2 * min_pe, 4),
        'max_price': -125, 'reference_price': -110, 'stale_minutes': 180, 'max_dispersion_iqr': 1.5, 'min_books': 3,
        'min_football_confidence': 40 if ('reliability_40' in gates or True) else None,
        'max_ensemble_sd': 6.0,
        'min_bet_confidence': (100 * res['clv_model']['final_dev']['choice']) if valid['clv_model']['verdict'] == 'BET-VALID' else None,
        'extreme_gap_pts': 10, 'extreme_ev': 0.12, 'extreme_max_age_minutes': 60, 'extreme_cover_probability': 0.60,
        'orientation_gap': 21, 'orientation_reconcile': 7,
        'lean': {'min_probability_edge': 0.0, 'min_gap_pts': lean['choice']},
        'hysteresis': {'edge_buffer': timing['stability']['hysteresis_buffer_rule_value'],
                       'ev_buffer': timing['stability']['hysteresis_buffer_rule_value']},
        'wait': {'enabled': bool(timing['wait_rule']['wait_enabled'])},
        'stake': {'method': 'flat', 'unit_u': 1, 'max_stake_u': 1, 'kelly_validated': bool(kelly_ok and edge_valid),
                  'kelly_fraction': 0.10, 'bankroll_u': 100, 'saturation_probability': sat['p_saturation']},
        'exposure': {'max_game_u': 1.0, 'same_game_correlation': 1.0, 'max_slate_u': float(slate['choice']),
                     'max_cluster_u': float(slate['cluster_choice'])},
        'display': {'edge_quality_tiers': bool(tier['display_edge_quality_tiers']),
                    'bet_rankings': bool(rank['display_bet_rankings'])},
        'market_limits': {'max_stake_per_book_u': None, 'note': 'at current scale book limits are not the constraint; '
                          'per-book limits, liquidity and price impact are recorded here when stakes grow (brief §50)'},
        'provenance': {'min_probability_edge': 'edge candidate, final DEV plateau choice (prereg §3, §5)',
                       'min_ev': 'declared floor on the calibrated EV (prereg §5)',
                       'lean.min_gap_pts': 'gap bucket CLV rule (prereg §5)',
                       'hysteresis': 'noise-scale buffer rule (prereg §5)',
                       'wait': 'WAIT evidence rule (prereg §5)',
                       'stake.saturation_probability': 'highest decision-probability bucket with >= 300 rows (prereg §5)',
                       'exposure.max_slate_u': 'slate-cap risk rule (prereg §5, §7)',
                       'min_football_confidence / max_ensemble_sd': ('adopted by the multivariate gate search' if gates & {'reliability_40', 'low_disagreement'}
                                                                     else 'declared safety bounds carried from v0: not validated filters'),
                       'declared_not_fitted': ['stale_minutes', 'min_books', 'max_dispersion_iqr', 'max_price', 'reference_price',
                                               'extreme_*', 'orientation_*']},
    }
    if 'reliability_40' not in gates:
        P['min_football_confidence'] = 40
    if 'low_disagreement' in gates:
        P['max_ensemble_sd'] = ENS_TERCILE_EDGE
    return P


# ================================================================== main
def main(freeze=False):
    assert os.path.exists(PREREG), 'the pre-registration is missing: %s' % PREREG
    prereg_sha = sha256_file(PREREG)
    from .baseline import write_or_verify
    write_or_verify(verify_only=True)
    U, G, rule = load_dev()
    table = residual_table(U)
    U = prepare(U, table)
    A = POL.load_artifact()
    Sc, res, sel = run_tournament(U)
    print('[tournament] candidates', {k: v['final_dev']['choice'] for k, v in res.items()})
    icc = PF.cross_game_icc(Sc)
    icc_hi = max(icc['week']['ci95'][1] or 0, icc['conference_week']['ci95'][1] or 0, 0.0)
    fixed_rows = {cid: fixed_threshold_table(Sc, cid) for cid in CANDIDATES}
    base_mask = sel['baseline_001']
    cards, valid, risks = {}, {}, {}
    for cid, m in sel.items():
        cards[cid] = oos_metrics(Sc, m)
        risks[cid] = risk_block(Sc, m, icc_hi)
        valid[cid] = bet_valid(cid, Sc, m, res, cards[cid], fixed_rows.get(cid if cid != 'multivariate' else 'edge'),
                               base_mask, risks[cid])
        print('[tournament] %-14s n %4d  CLV %s  close-EV %s  ROI %s %s  -> %s' % (
            cid, cards[cid]['bet_count'], cards[cid].get('avg_clv'), cards[cid].get('close_implied_ev'), cards[cid].get('roi'),
            cards[cid].get('roi_ci'), valid[cid]['verdict']))
    chall = decision_model_challenger(U)
    t_edge = res['edge']['final_dev']['choice'] if res['edge']['final_dev']['choice'] is not None else 0.03
    lean = lean_gap_rule(Sc)
    sat = saturation(Sc)
    timing, Dt = timing_analysis(Sc, t_edge)
    tier = tiers(Sc)
    rank = rankings(Sc, A['ev_curve_decision'])
    edge_all = Sc.probability_edge >= t_edge
    masks = {'edge_final_all_scored': edge_all.values, 'lean_set_pe_gt_0': (Sc.probability_edge > 0).values,
             'all_rows': np.ones(len(Sc), bool)}
    evr = expected_vs_realized(Sc, masks)
    wk = weekly_counts(Sc, {k: v for k, v in sel.items() if k != 'none'})
    corr = PF.same_game_correlations(G)
    # the risk sets: the edge candidate's OOS bets, or the LEAN set when it has < 100 OOS bets (prereg §5)
    risk_set_name = 'edge' if cards['edge']['bet_count'] >= 100 else 'lean_set_pe_gt_0'
    rmask = sel['edge'] if risk_set_name == 'edge' else (Sc.season.isin(EVAL) & (Sc.probability_edge > 0)).values
    rset = Sc[rmask]
    blocks = PF.week_blocks(rset, Sc[Sc.season.isin(EVAL)])
    w_, l_ = int(rset.ats_win.eq(1).sum()), int(rset.ats_win.eq(0).sum())
    pp = float(rset.is_push.mean())
    slate = PF.choose_slate_cap(blocks, w_, l_, pp, icc_hi)
    slate['cluster_choice'] = math.floor(slate['choice'] / (3 if (icc['conference_week']['ci95'][1] or 0) > 0.05 else 2))
    slate['risk_set'] = risk_set_name
    portfolio = {'risk_set': risk_set_name, 'n_bets': int(len(rset)),
                 'season_bootstrap': PF.season_bootstrap(blocks),
                 'risk_of_ruin': PF.risk_of_ruin(w_, l_, pp, [len(b) for b in blocks], icc_hi),
                 'historical': scorecard(rset, B=1000), 'slate_cap': slate}
    lean_set = Sc[(Sc.probability_edge > 0)]
    kelly = {'edge_oos_set': PF.kelly_compare(Sc[sel['edge']], p_sat=sat['p_saturation'] or 0.55) if sel['edge'].any() else None,
             'lean_set_scored': PF.kelly_compare(lean_set, p_sat=sat['p_saturation'] or 0.55)}
    s5 = json.load(open(os.path.join(DS.out_dir(), 's05_calibration_methods.json')))
    dll_ci = s5['methods']['shrink'].get('dll_vs_market_ci')
    kelly_ok = bool(dll_ci and dll_ci[1] < 0)
    kelly['validation'] = {'decision_p_logloss_vs_coin_ci': dll_ci, 'calibration_significant': kelly_ok,
                           'edge_region_bet_valid': valid['edge']['verdict'] == 'BET-VALID',
                           'kelly_validated': bool(kelly_ok and valid['edge']['verdict'] == 'BET-VALID')}
    policy = derive_policy(res, sel, Sc, lean, sat, timing, tier, rank, slate, prereg_sha, valid, kelly_ok)
    # production replay (per-season walk-forward artifacts) and the counterfactual that exposes every gate
    arts = season_artifacts(A, U)
    Sc = Sc.copy()
    Sc['close_ts_iso'] = (pd.to_datetime(Sc.kickoff_ts, utc=True) - pd.Timedelta(minutes=30)).dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    Sc['close_home_line'] = -Sc.close_line_margin
    dec_open = replay_frame(Sc, policy, arts, with_targets=True)
    st_rows, Rd = status_table(Sc, dec_open, 'status')
    rs_rows, _ = status_table(Sc, dec_open, 'reason')
    cf_policy = dict(policy, bet_enabled=True, version='counterfactual_betting_enabled')
    cf_arts = {S: dict(a, ev_curve_decision={'input': 'decision_ev', 'x': [-1.0, 1.0], 'y': [-1.0, 1.0]}) for S, a in arts.items()}
    dec_cf = replay_frame(Sc, cf_policy, cf_arts)
    cf_rows, _ = status_table(Sc, dec_cf, 'reason')
    has_close = Sc.close_line_margin.notna().values
    prev = [d if has_close[i] else None for i, d in enumerate(dec_open)]
    dec_close = [None] * len(Sc)
    idx = np.flatnonzero(has_close)
    sub = Sc.iloc[idx]
    dc = replay_frame(sub, policy, arts, home_line_col='close_home_line', previous=[prev[i] for i in idx])
    for j, i in enumerate(idx):
        dec_close[i] = dc[j]
    trans = {}
    for a, b in zip(dec_open, dec_close):
        if b is None:
            continue
        k = '%s -> %s' % (a['status'], b['status'])
        trans[k] = trans.get(k, 0) + 1
    lean_rows = Rd[Rd._status.eq('LEAN')]
    pass_rows = Rd[Rd._status.eq('PASS')]
    lean_ci = cluster_boot(lean_rows.clv_pts.values, lean_rows.game_id.values)
    lean_diff = paired_like_diff(lean_rows.clv_pts.values, pass_rows.clv_pts.values)
    lean_valid = bool(lean_ci[0] is not None and lean_ci[0] > 0 and lean_diff['ci'] and lean_diff['ci'][0] > 0)
    research = research_evidence(Sc)
    analyses = {
        'prereg_sha256': prereg_sha,
        'close_ev_residuals': {'n_games': table['n_games'], 'seasons': table['seasons'],
                               'p_at': {str(v): r(p, 5) for v, p in zip(table['values'], table['p']) if abs(v) <= 10}},
        'pass_quality': {'by_status': st_rows, 'by_first_reason': rs_rows, 'counterfactual_betting_enabled_by_reason': cf_rows,
                         'note': 'hypothetical flat 1u at the assumed -110 for every status (PASS quality, brief §29)'},
        'lean': {'gap_rule': lean, 'lean_clv_ci': rl(lean_ci, 3), 'lean_minus_pass_clv': lean_diff, 'lean_validated': lean_valid},
        'research': research, 'saturation': sat, 'selectivity': selectivity(Sc), 'rank_order': rank_order(Sc),
        'timing': timing, 'stability_transitions_open_to_close': trans, 'expected_vs_realized': evr,
        'tiers': tier, 'rankings': rank, 'weekly_counts': wk, 'decision_model_challenger': chall,
        'kelly': kelly, 'portfolio': portfolio, 'correlations': {'same_game': corr, 'cross_game_icc': icc, 'icc_upper_used': r(icc_hi, 5)},
        'robustness_fixed_thresholds': fixed_rows,
    }
    tour = {'prereg_sha256': prereg_sha, 'eval_seasons': EVAL, 'scored_seasons': SCORED, 'n_universe_scored': int(len(Sc)),
            'n_eval_rows': int(Sc.season.isin(EVAL).sum()), 'candidates': res, 'oos': cards, 'bet_valid': valid,
            'risk': {k: {'passes': v.get('passes'), 'max_drawdown_p95': (v.get('season_bootstrap') or {}).get('max_drawdown_p95'),
                         'ror_100u_p025': ((v.get('risk_of_ruin') or {}).get('by_bankroll', {}).get('100', {}).get('p025') or {}).get('ror')}
                     for k, v in risks.items()},
            'baseline_rule': rule}
    dump('tournament.json', clean(tour))
    dump('analyses.json', clean(analyses))
    dump('policy_candidate.json', clean(policy))
    print('[tournament] policy: min_pe %s, lean gap %s, hysteresis %s, wait %s, p_sat %s, slate %s/%s, tiers %s, rankings %s, lean_valid %s'
          % (policy['min_probability_edge'], policy['lean']['min_gap_pts'], policy['hysteresis'], policy['wait'],
             policy['stake']['saturation_probability'], policy['exposure']['max_slate_u'], policy['exposure']['max_cluster_u'],
             policy['display']['edge_quality_tiers'], policy['display']['bet_rankings'], lean_valid))
    if freeze:
        freeze_policy(policy, tour, analyses, prereg_sha)
    return tour, analyses, policy


# =========================================================== the artifact
def promotion_gate(tour, analyses, holdout=None, shadow_settled=0):
    """§86: PASS/FAIL per criterion (POLICY_PREREG §8). Betting stays disabled unless every one passes."""
    ev = json.load(open(os.path.join(POL.ARTIFACTS, 'cfb_decision_calibration_v1', 'evidence.json')))
    buckets = [b for b in ev['cover_buckets_decision'] if (b.get('n') or 0) >= 100]
    g1_dev = all(b['cover_wilson'][0] <= b['mean_p_dec'] <= b['cover_wilson'][1] for b in buckets)
    g1_ho = None if holdout is None else bool(holdout['production']['calibration']['calibrated_in_the_large'])
    t = analyses['tiers']
    g2_ho = None if holdout is None else holdout.get('tiers_high_ge_low_clv')
    A = POL.load_artifact()
    P = json.load(open(os.path.join(POLICY_DIR, 'policy.json'))) if os.path.exists(os.path.join(POLICY_DIR, 'policy.json')) else None
    min_ev = P['min_ev'] if P else 0.0
    g8 = max(A['ev_curve_decision']['y']) >= min_ev
    bv = tour['bet_valid']['edge']['criteria']
    prod_bet_region_empty = not g8
    G = {
        'G1_probabilities_calibrated': {'pass': bool(g1_dev and (g1_ho is not False)) if holdout is not None else None,
                                        'dev': bool(g1_dev), 'holdout': g1_ho},
        'G2_tiers_rank_sensibly': {'pass': bool(t['display_edge_quality_tiers'] and (g2_ho is not False)) if holdout is not None
                                   else None, 'dev': bool(t['display_edge_quality_tiers']), 'holdout': g2_ho},
        'G3_clv_strong_for_the_bet_region': {'pass': False if prod_bet_region_empty else bool(bv['3_clv']),
                                             'note': 'the production BET region is empty' if prod_bet_region_empty else None},
        'G4_thresholds_stable': {'pass': bool(bv['6_stability'])},
        'G5_drawdown_acceptable': {'pass': bool(bv['8_risk'])},
        'G6_holdout_does_not_collapse': {'pass': False if prod_bet_region_empty else (None if holdout is None else holdout.get('no_collapse')),
                                         'note': 'the production BET region is empty' if prod_bet_region_empty else None},
        'G7_shadow_sensible': {'pass': bool(shadow_settled >= 200), 'settled_live_priced_shadow_decisions': shadow_settled,
                               'required': 200},
        'G8_frozen_artifact_admits_a_bet': {'pass': bool(g8), 'max_calibrated_ev': r(max(A['ev_curve_decision']['y']), 5),
                                            'min_ev': min_ev},
        'G9_credible_outcome': {'pass': False if prod_bet_region_empty else bool(bv['4_outcome']),
                                'note': 'the production BET region is empty' if prod_bet_region_empty else None},
    }
    G['promote'] = all(v['pass'] is True for k, v in G.items() if k.startswith('G'))
    G['decision'] = 'bet_enabled stays false' if not G['promote'] else 'eligible for a person\'s promotion decision'
    return G


def freeze_policy(policy, tour, analyses, prereg_sha):
    """Write policy.json (never changed afterwards), evidence.json and MANIFEST.json."""
    from .baseline import MANIFEST as BASELINE_MANIFEST
    os.makedirs(POLICY_DIR, exist_ok=True)
    pj = os.path.join(POLICY_DIR, 'policy.json')
    body = json.dumps(clean(policy), indent=1, sort_keys=True) + '\n'
    if os.path.exists(pj):
        with open(pj) as f:
            if f.read() != body:
                raise RuntimeError('policy.json exists and differs: the policy is frozen (a new version needs a new directory)')
    else:
        with open(pj, 'w') as f:
            f.write(body)
    gate = promotion_gate(tour, analyses)
    evidence = {'policy': POLICY_VERSION, 'prereg_sha256': prereg_sha, 'tournament': tour, 'promotion_gate_before_holdout': gate,
                'analyses_file': 'out_h/decision/policy/analyses.json (git-ignored; reproduced by python3 -m v2.decision.tournament)',
                'analyses_sha256': sha256_file(os.path.join(out_dir(), 'analyses.json')),
                'key_analyses': {k: analyses[k] for k in ('lean', 'saturation', 'timing', 'tiers', 'rankings', 'weekly_counts',
                                                          'decision_model_challenger', 'correlations', 'stability_transitions_open_to_close')},
                'holdout': None}
    ep = os.path.join(POLICY_DIR, 'evidence.json')
    with open(ep, 'w') as f:
        json.dump(clean(evidence), f, indent=1, sort_keys=True, default=_js, allow_nan=False)
        f.write('\n')
    here = os.path.dirname(os.path.abspath(__file__))
    code = {f: sha256_file(os.path.join(here, f)) for f in ('policy.py', 'tournament.py', 'portfolio.py', 'scorecard.py', 'holdout.py')
            if os.path.exists(os.path.join(here, f))}
    man = {'policy': POLICY_VERSION, 'frozen_at': FROZEN_AT, 'bet_enabled': False,
           'files': {'policy.json': sha256_file(pj), 'evidence.json': sha256_file(ep),
                     '../fixtures/policy_parity.json': sha256_file(POL.FIXTURE) if os.path.exists(POL.FIXTURE) else None},
           'prereg': {'path': 'docs/cfb-decision/POLICY_PREREG.md', 'sha256': prereg_sha},
           'calibration_manifest_sha256': sha256_file(os.path.join(POL.ARTIFACTS, 'cfb_decision_calibration_v1', 'MANIFEST.json')),
           'calibration_json_sha256': sha256_file(POL.CAL_JSON),
           'baseline_manifest_sha256': sha256_file(BASELINE_MANIFEST),
           'dataset_sha256': sha256_file(os.path.join(DS.out_dir(), 'decision_dataset.parquet')),
           'code_sha256': code, 'holdout_scored': False,
           'holdout_rule': 'holdout.py reads 2024-2025 once for this policy sha256, logs the access in holdout_access.jsonl '
                           '(append-only) and refuses a second run; policy.json never changes afterwards',
           'promotion_gate': {k: (v['pass'] if isinstance(v, dict) else v) for k, v in gate.items()}}
    with open(os.path.join(POLICY_DIR, 'MANIFEST.json'), 'w') as f:
        json.dump(clean(man), f, indent=1, sort_keys=True)
        f.write('\n')
    print('[tournament] froze', POLICY_DIR, 'policy sha256', man['files']['policy.json'])


if __name__ == '__main__':
    main(freeze='--freeze' in sys.argv)
