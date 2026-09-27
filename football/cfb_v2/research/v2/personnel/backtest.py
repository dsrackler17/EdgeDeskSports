"""Combined comparison harness: BASE vs +QB vs +QB+OL vs +ALL (docs/cfb-personnel/UNITS.md section 8).

    python3 -m v2.personnel.backtest            # dev 2016-2023
    python3 -m v2.personnel.backtest --holdout  # holdout 2024-2025, ONCE (after backtest_units --holdout)

BASE    V2.1's walk-forward out-of-fold prediction (stage 7 ens_pred; see backtest_units.load_base).
+QB     the QB layer's out-of-fold predictions, read from $CFB_V2_OUT/personnel/backtest_qb_oof.parquet
        (game_id, season, week, qb_change, first_time_starter, pred_base, pred_qb, sigma_base, sigma_qb,
        p_home_base, p_home_qb, margin). While the file is absent, +QB is PENDING and every +QB row says so.
        The QB layer's file is its ORACLE (the actual starter, known only after kickoff): an upper bound, like
        the units' oracle deltas; +ALL [oracle] is therefore the joint upper bound.
+QB+OL  the OL unit adds VARIANCE only (sigma' = sqrt(sigma^2 + OL inflation), units.ol_uncertainty). No OL
        report exists before 2026, so on 2014-2025 +QB+OL is +QB by construction; it is evaluated on the
        report-covered 2026 games (interval coverage, log loss): backtest_units.live_2026.
+ALL    +QB + the unit deltas (RB, WR_TE, FRONT7, SECONDARY, ST); the unit betas are re-fitted walk-forward on
        the +QB residual (margin - pred_qb), N(0, 1) prior. Both the PREGAME deltas (history only: what the
        weekly engine can compute before a report) and the ORACLE deltas (hindsight absences, an upper bound).
Promotion (DESIGN.md rule 8): a component is recommended for the challenger only if it improves or preserves
accuracy on ordinary games (d_mae <= +0.005, d_logloss <= +0.0005) AND improves lineup-change games with a
d_mae CI entirely below 0; otherwise it stays research.
"""
import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from . import backtest_units as BU

QB_FILE = 'backtest_qb_oof.parquet'
QB_COLS = ['game_id', 'season', 'week', 'qb_change', 'first_time_starter', 'pred_base', 'pred_qb', 'sigma_base',
           'sigma_qb', 'p_home_base', 'p_home_qb', 'margin']
ORDINARY_MAE_TOL = 0.005
ORDINARY_LL_TOL = 0.0005


def qb_oof():
    """The QB layer's out-of-fold predictions, or None (PENDING) while the file does not exist."""
    f = common.out_path('personnel', QB_FILE)
    if not os.path.exists(f):
        return None
    Q = pd.read_parquet(f)
    miss = [c for c in QB_COLS if c not in Q.columns]
    if miss:
        raise ValueError('%s lacks %s' % (f, miss))
    BU.assert_no_market(list(Q.columns))
    return Q[QB_COLS].drop_duplicates('game_id')


def _frame(seasons):
    """The unit game frame (backtest_units) joined with the QB layer's predictions where present."""
    G = BU.game_frame(tuple(sorted(set(BU.TRAIN0) | set(seasons))))
    Q = qb_oof()
    G['qb_status'] = 'PENDING' if Q is None else 'AVAILABLE'
    if Q is not None:
        G = G.merge(Q[['game_id', 'qb_change', 'pred_qb', 'sigma_qb', 'p_home_qb']], on='game_id', how='left')
        G['pred_qb'] = G.pred_qb.where(G.pred_qb.notna(), G.base)
        G['qb_change'] = G.qb_change.fillna(False).astype(bool)
        G['p_home_qb'] = G.p_home_qb.where(G.p_home_qb.notna(), G.p_base)
    else:
        G['pred_qb'] = G.base
        G['qb_change'] = False
        G['p_home_qb'] = G.p_base
    return G


def _units_on(G, anchor, variant, eval_seasons, frozen_through=None):
    """anchor + sum beta_u Delta_u, betas fitted walk-forward on margin - anchor (all five units)."""
    H = G.copy()
    H['base'] = G[anchor]
    pred, betas = BU.walk_forward(H, BU.VARIANT_UNITS['ALL'], variant, eval_seasons, frozen_through)
    return pred, betas


def compare_all(eval_seasons, frozen_through=None):
    G = _frame(eval_seasons)
    ev = G.season.isin(eval_seasons)
    rng = np.random.default_rng(C.SEED)
    change_units = G.change__ANY.astype(bool)
    lineup_change = change_units | G.qb_change
    ordinary = ev & ~lineup_change
    out = {'seasons': list(eval_seasons), 'qb_layer': G.qb_status.iloc[0], 'n_games': int(ev.sum()),
           'qb_layer_kind': 'oracle (actual starter; upper bound)' if G.qb_status.iloc[0] == 'AVAILABLE' else None,
           'n_lineup_change': int((ev & lineup_change).sum()), 'n_ordinary': int(ordinary.sum()), 'rows': {}}
    df = G.t_df.fillna(100)
    sig = G.sigma.fillna(1.0)
    preds = {}
    if out['qb_layer'] == 'AVAILABLE':
        preds['+QB'] = (G.pred_qb, G.p_home_qb)
        preds['+QB+OL'] = (G.pred_qb, G.p_home_qb)          # no OL report before 2026: identical by construction
    for v in ('pregame', 'oracle'):
        anchor = 'pred_qb'
        p, betas = _units_on(G, anchor, v, eval_seasons, frozen_through)
        name = ('+ALL' if out['qb_layer'] == 'AVAILABLE' else '+UNITS(QB pending)') + ' [%s]' % v
        preds[name] = (p, pd.Series(np.where(G.sigma.notna(), BU.p_home(p.fillna(0), sig, df), np.nan), index=G.index))
        out.setdefault('unit_betas', {})[v] = betas
    for name, (p, ph) in preds.items():
        ok = ev & p.notna()
        out['rows'][name] = {'all_games': BU.compare(G, ok, p, ph, rng),
                             'lineup_change_games': BU.compare(G, ok & lineup_change, p, ph, rng),
                             'ordinary_games': BU.compare(G, ok & ~lineup_change, p, ph, rng)}
        if name.startswith('+QB'):
            out['rows'][name]['qb_change_games'] = BU.compare(G, ok & G.qb_change, p, ph, rng)
    out['promotion'] = promotion(out)
    return out


def _passes(r):
    o, c = r['ordinary_games'], r['lineup_change_games']
    keep = o.get('d_mae', 0.0) <= ORDINARY_MAE_TOL and (o.get('d_logloss') is None or o['d_logloss'] <= ORDINARY_LL_TOL)
    better = bool(c.get('d_mae_ci') and c['d_mae_ci'][1] < 0)
    return {'ordinary_preserved': bool(keep), 'change_improved_ci_below_0': better, 'recommend': bool(keep and better),
            'ordinary_d_mae': o.get('d_mae'), 'ordinary_d_logloss': o.get('d_logloss'),
            'change_d_mae': c.get('d_mae'), 'change_d_mae_ci': c.get('d_mae_ci')}


def promotion(out):
    res = {}
    for name, r in out['rows'].items():
        res[name] = _passes(r)
    if out['qb_layer'] != 'AVAILABLE':
        res['+QB'] = {'recommend': None, 'status': 'PENDING: %s not found' % QB_FILE}
    res['+OL'] = {'recommend': False, 'status': 'NOT_ESTIMATED: variance-only declared prior; no historical OL data; '
                                                'validate on live 2026 games in the Model Lab'}
    return res


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--holdout', action='store_true')
    ap.add_argument('--rescore-holdout', action='store_true')
    a = ap.parse_args(argv)
    if a.holdout:
        f = os.path.join(BU.out_dir(), 'combined_holdout.json')
        if os.path.exists(f) and not a.rescore_holdout:
            raise SystemExit('the combined holdout was already scored (%s); it is scored ONCE' % f)
        if not os.path.exists(os.path.join(BU.out_dir(), 'backtest_holdout.json')):
            raise SystemExit('score the unit holdout first: python3 -m v2.personnel.backtest_units --holdout')
        res = compare_all(BU.HOLDOUT, frozen_through=max(BU.DEV))
        BU._dump('combined_holdout.json', res)
    else:
        res = compare_all(BU.DEV)
        BU._dump('combined_dev.json', res)
    print(json.dumps(ids.clean(res['promotion']), indent=1, default=str))


if __name__ == '__main__':
    main(sys.argv[1:])
