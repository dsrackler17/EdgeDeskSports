"""The final holdout (2024, 2025): read EXACTLY ONCE, after the policy is frozen.

    python3 -m v2.decision.holdout

Before anything is read it checks that the policy artifact is frozen
(policy.json + MANIFEST.json, every hash matching), that the pre-registration
is unchanged, and that holdout_access.jsonl has no READ for this policy's
sha256 — a second run for the same policy is refused. It then APPENDS the
access (UTC time, policy / calibration / pre-registration / code sha256, git
HEAD) to holdout_access.jsonl and only then reads the holdout rows: the only
code path in the repository that loads `window == holdout` decision rows or
stage-7 seasons 2024-2025.

Nothing is refit: the frozen calibration artifact (w = 0.227829, the frozen EV
curves and CLV models) and the frozen policy are applied as they are. Results
are written to out_h/decision/policy/holdout.json and into the policy
artifact's evidence.json and MANIFEST.json; policy.json never changes.
"""
import datetime as dt
import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

from .. import config as C
from . import core
from . import calibration as CAL
from . import dataset as DS
from . import policy as POL
from . import tournament as T
from .scorecard import scorecard, cluster_boot, paired_cluster_diff, r, rl

ACCESS_LOG = os.path.join(T.POLICY_DIR, 'holdout_access.jsonl')
HOLDOUT = list(C.HOLDOUT_SEASONS)


# ------------------------------------------------------------------ guards
def _read_log():
    if not os.path.exists(ACCESS_LOG):
        return []
    with open(ACCESS_LOG) as f:
        return [json.loads(l) for l in f if l.strip()]


def preflight():
    """Everything that must hold before the holdout may be read. Returns the hashes to log."""
    pj, mj = os.path.join(T.POLICY_DIR, 'policy.json'), os.path.join(T.POLICY_DIR, 'MANIFEST.json')
    if not (os.path.exists(pj) and os.path.exists(mj)):
        raise SystemExit('holdout refused: the policy is not frozen (policy.json and MANIFEST.json must exist)')
    M = json.load(open(mj))
    psha = T.sha256_file(pj)
    if M['files']['policy.json'] != psha:
        raise SystemExit('holdout refused: policy.json does not match its MANIFEST')
    P = json.load(open(pj))
    if P.get('bet_enabled') is not False:
        raise SystemExit('holdout refused: the committed policy must keep bet_enabled false')
    prereg = T.sha256_file(T.PREREG)
    if prereg != M['prereg']['sha256'] or prereg != P.get('prereg_sha256'):
        raise SystemExit('holdout refused: the pre-registration changed after the policy was frozen')
    for e in _read_log():
        if e.get('policy_sha256') == psha and e.get('action') == 'READ_HOLDOUT':
            raise SystemExit('holdout refused: the holdout was already read for policy sha256 %s at %s' % (psha, e.get('at')))
    try:
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=T.REPO, capture_output=True, text=True).stdout.strip()
    except OSError:
        head = None
    here = os.path.dirname(os.path.abspath(__file__))
    return {'policy_sha256': psha, 'calibration_sha256': T.sha256_file(POL.CAL_JSON), 'prereg_sha256': prereg,
            'manifest_sha256': T.sha256_file(mj), 'git_head': head,
            'code_sha256': {f: T.sha256_file(os.path.join(here, f)) for f in ('holdout.py', 'policy.py', 'tournament.py', 'scorecard.py')}}


def log_access(entry):
    os.makedirs(T.POLICY_DIR, exist_ok=True)
    with open(ACCESS_LOG, 'a') as f:                       # append-only: never rewritten
        f.write(json.dumps(entry, sort_keys=True) + '\n')


# ------------------------------------------------------------------- load
HO_COLS = ['decision_row_id', 'window', 'game_id', 'season', 'week', 'kickoff_ts', 'decision_ts', 'model_version', 'pricing_scope',
           'quote_role', 'book', 'status', 'side', 'side_sign', 'pure_margin', 'sigma', 't_df', 'quote_home_line', 'quote_line_margin',
           'close_line_margin', 'final_margin', 'gap_pts', 'abs_gap_pts', 'pure_cover_prob', 'push_prob', 'theoretical_ev',
           'review_route', 'ats_win', 'is_push', 'units_assumed_110', 'clv_pts', 'positive_clv', 'moved_toward_model',
           'abs_line_move', 'reliability', 'ens_sd', 'early_season', 'qb_missing', 'qb_unsettled', 'data_completeness',
           'abs_line', 'is_home_side', 'home_conference', 'away_conference', 'is_postseason']


def load_holdout():
    """THE holdout read (called once, after log_access)."""
    H = pd.read_parquet(os.path.join(DS.out_dir(), 'decision_dataset.parquet'), columns=HO_COLS,
                        filters=[('window', '==', 'holdout')])
    assert set(H.season) <= set(HOLDOUT)
    S7 = pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'),
                         columns=['game_id', 'season', 'ev', 'side', 'gap_open', 'early_season', 'reliability', 'line',
                                  'bet_units', 'bet_result', 'clv_pts', 'p_side'],
                         filters=[('season', 'in', HOLDOUT)])
    return H, S7


# --------------------------------------------------------------- evaluate
def frame(H, S7, A, rule, table):
    """Decision numbers from the FROZEN artifact; nothing refit."""
    fbs = H[H.pricing_scope.eq('FBS_FBS') & H.quote_role.eq('CONSENSUS_OPEN') & H.status.eq('FINAL') & H.side.notna()
            & H.pure_cover_prob.notna() & ~H.review_route.astype(bool)].copy()     # the DEV grain; every book: per_book()
    w = float(A['market_shrinkage']['w_model'])
    fbs['p_dec'] = CAL.shrink_np(fbs.pure_cover_prob.values, 0.5, w)
    fbs['decision_ev'] = core.ev_with_push(fbs.p_dec.values, fbs.push_prob.fillna(0).values, -110)
    fbs['probability_edge'] = fbs.p_dec - T.BE110
    fbs['empirical_ev'] = np.interp(fbs.decision_ev.values, A['ev_curve_decision']['x'], A['ev_curve_decision']['y'])
    fbs['p_pos_clv_wf'] = CAL.eval_model_np(A['p_positive_clv'], fbs)       # the frozen model (name kept for the masks)
    fbs['exp_clv_wf'] = CAL.eval_model_np(A['clv_magnitude'], fbs)
    fbs['empirical_ev_decision'] = fbs.empirical_ev
    fbs['units'] = fbs.units_assumed_110
    fbs['close_ev'] = T.close_ev(fbs.clv_pts.values, table)
    fbs['qb_missing'] = fbs.qb_missing.astype(float)
    fbs['qb_unsettled'] = fbs.qb_unsettled.astype(float)
    b = S7.rename(columns={'ev': 'b_ev', 'side': 'b_side', 'gap_open': 'b_gap', 'early_season': 'b_early', 'reliability': 'b_rel',
                           'line': 'b_line', 'bet_units': 'b_units', 'bet_result': 'b_result', 'clv_pts': 'b_clv', 'p_side': 'b_p'})
    fbs = fbs.merge(b.drop(columns=['season']), on='game_id', how='left', validate='many_to_one')
    has = fbs.b_ev.notna()
    fbs['b_lean'] = has & (fbs.b_ev > rule['lean_ev']) & (fbs.b_gap.abs() >= rule['lean_gap'])
    fbs['b_bet'] = fbs.b_lean & (fbs.b_ev > rule['bet_ev']) & (fbs.b_gap.abs() >= rule['bet_gap']) & (fbs.b_rel >= rule['bet_min_rel'])
    if rule.get('exclude_early'):
        fbs['b_bet'] &= ~fbs.b_early.fillna(0).astype(bool)
    fbs['b_close_ev'] = T.close_ev(fbs.b_clv.values, table)
    fbs['kickoff_iso'] = pd.to_datetime(fbs.kickoff_ts, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    fbs['decision_ts_iso'] = pd.to_datetime(fbs.decision_ts, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    return fbs


def candidate_masks(F, tour):
    """Every tournament candidate at its FROZEN final DEV choice."""
    out = {}
    for cid, spec in T.CANDIDATES.items():
        ch = tour['candidates'][cid]['final_dev']['choice']
        out[cid] = spec['mask'](F, ch) if ch is not None else np.zeros(len(F), bool)
    mv = tour['candidates']['multivariate']['final_dev']['choice']
    out['multivariate'] = T.mv_mask(F, (mv[0], tuple(mv[1]))) if mv else np.zeros(len(F), bool)
    out['baseline_001'] = F.b_bet.fillna(False).values.astype(bool)
    out['baseline_lean'] = F.b_lean.fillna(False).values.astype(bool)
    out['empirical_ev'] = (F.empirical_ev >= 0).values
    out['none'] = np.zeros(len(F), bool)
    return out


def calibration_block(F):
    y, p = F.ats_win.values, F.p_dec.values
    ok = np.isfinite(y)
    ll = core.log_loss(y[ok], p[ok])
    coin = core.log_loss(y[ok], np.full(ok.sum(), 0.5))
    pure = core.log_loss(y[ok], F.pure_cover_prob.values[ok])
    d = core.boot_paired_diff(ll, coin)
    dp = core.boot_paired_diff(pure, coin)
    buckets = []
    for lo, hi in ((0.5, 0.525), (0.525, 0.55), (0.55, 0.575), (0.575, 0.60), (0.60, 1.01)):
        s = F[(F.p_dec >= lo) & (F.p_dec < hi) & F.ats_win.notna()]
        if len(s):
            k, n = float(s.ats_win.sum()), len(s)
            wl = core.wilson(k, n)
            buckets.append({'bucket': '%.3f-%.3f' % (lo, hi), 'n': n, 'mean_p_dec': r(s.p_dec.mean()), 'cover': r(k / n),
                            'wilson': rl(wl), 'contains': bool(wl[0] <= s.p_dec.mean() <= wl[1])})
    w = core.wilson(y[ok].sum(), ok.sum())
    return {'n': int(ok.sum()), 'log_loss_decision': r(ll.mean(), 5), 'log_loss_coin': r(coin.mean(), 5),
            'dll_decision_minus_coin': r(d['mean'], 5), 'dll_ci': rl(d['ci'], 5),
            'log_loss_pure': r(pure.mean(), 5), 'dll_pure_minus_coin': r(dp['mean'], 5), 'dll_pure_ci': rl(dp['ci'], 5),
            'mean_p_dec': r(p[ok].mean()), 'cover_rate': r(y[ok].mean()), 'cover_wilson': rl(w),
            'calibrated_in_the_large': bool(w[0] <= p[ok].mean() <= w[1]), 'buckets': buckets}


def evaluate(F, tour, policy, A, dev_oos):
    """The holdout evaluation as a pure function of the holdout frame (tested on DEV stand-ins)."""
    masks = candidate_masks(F, tour)
    seasons = sorted(int(S) for S in F.season.unique())
    cands = {}
    Fb = T.baseline_view(F)
    for cid, m in masks.items():
        V = Fb if cid in T.BASELINES else F
        d = V[m]
        card = scorecard(d, B=2000)
        card['by_season'] = {str(S): (scorecard(d[d.season.eq(S)], B=1000, drawdown=False) if (d.season == S).any() else {'bet_count': 0})
                             for S in seasons}
        dv = dev_oos.get(cid) or {}
        ce_lb = (dv.get('close_implied_ev_ci') or [None, None])[0]
        roi_lb = (dv.get('roi_ci') or [None, None])[0]
        card['no_collapse_vs_dev'] = (None if not len(d) or ce_lb is None or roi_lb is None else
                                      bool((card.get('close_implied_ev') or -9) >= ce_lb and (card.get('roi') or -9) >= roi_lb))
        crit = {'sample_300': len(d) >= 300,
                'pricing_close_ev_lb_gt_0': bool((card.get('close_implied_ev_ci') or [None])[0] is not None and card['close_implied_ev_ci'][0] > 0),
                'clv_lb_gt_0': bool((card.get('avg_clv_ci') or [None])[0] is not None and card['avg_clv_ci'][0] > 0),
                'roi_lb_gt_0': bool((card.get('roi_ci') or [None])[0] is not None and card['roi_ci'][0] > 0),
                'calibrated': bool(card.get('calibrated_in_the_large'))}
        card['holdout_criteria'] = crit
        base = masks['baseline_001']
        pu = np.where(m, V.units.values, 0.0)
        bu = np.where(base, F.b_units.values, 0.0)
        card['paired_vs_baseline_units_per_quote'] = paired_cluster_diff(pu, bu, F.game_id.values)
        cands[cid] = card
    dec = T.replay_frame(F.assign(season=F.season.astype(int)), policy, {S: A for S in seasons})
    st, Rd = T.status_table(F, dec, 'status')
    rs, _ = T.status_table(F, dec, 'reason')
    lean = Rd[Rd._status.eq('LEAN')]
    pas = Rd[Rd._status.eq('PASS')]
    lean_ci = cluster_boot(lean.clv_pts.values, lean.game_id.values) if len(lean) >= 20 else [None, None]
    tiers = {}
    lab = np.where(F.p_pos_clv_wf >= 0.58, 'HIGH', np.where(F.p_pos_clv_wf >= 0.52, 'MEDIUM', 'LOW'))
    for t in ('LOW', 'MEDIUM', 'HIGH'):
        s = F[lab == t]
        c = scorecard(s, B=1000, drawdown=False)
        tiers[t] = {k: c.get(k) for k in ('bet_count', 'avg_clv', 'avg_clv_ci', 'positive_clv_pct', 'close_implied_ev', 'roi', 'ats')}
    hi_ge_lo = (tiers['HIGH'].get('avg_clv') or -9) >= (tiers['LOW'].get('avg_clv') or 9)
    prod_bets = Rd[Rd._status.eq('BET')]
    return {'candidates': cands,
            'production': {'by_status': st, 'by_first_reason': rs, 'bets': int(len(prod_bets)),
                           'status_counts': {k: int(v) for k, v in Rd._status.value_counts().sort_index().items()},
                           'calibration': calibration_block(F),
                           'lean_clv_ci': rl(lean_ci, 3), 'lean_minus_pass_clv': T.paired_like_diff(lean.clv_pts.values, pas.clv_pts.values)},
            'tiers': tiers, 'tiers_high_ge_low_clv': bool(hi_ge_lo),
            'no_collapse': None if not len(prod_bets) else None,
            'n_rows': int(len(F)), 'by_season_rows': {str(S): int((F.season == S).sum()) for S in seasons}}


def per_book(H, A, table):
    """Sensitivity: every book's opener in 2024-2025 (several rows per game: game-clustered bootstrap)."""
    B = H[H.pricing_scope.eq('FBS_FBS') & H.status.eq('FINAL') & H.quote_role.eq('BOOK_OPEN') & H.side.notna()
          & H.pure_cover_prob.notna() & ~H.review_route.astype(bool)].copy()
    if not len(B):
        return {'n': 0}
    w = float(A['market_shrinkage']['w_model'])
    B['p_dec'] = CAL.shrink_np(B.pure_cover_prob.values, 0.5, w)
    B['probability_edge'] = B.p_dec - T.BE110
    B['decision_ev'] = core.ev_with_push(B.p_dec.values, B.push_prob.fillna(0).values, -110)
    B['units'] = B.units_assumed_110
    B['close_ev'] = T.close_ev(B.clv_pts.values, table)
    out = {'rows': int(len(B)), 'games': int(B.game_id.nunique()), 'books': sorted(B.book.dropna().unique().tolist())}
    for name, m in (('all', np.ones(len(B), bool)), ('edge_gt_0', (B.probability_edge > 0).values)):
        out[name] = scorecard(B[m], B=1000, drawdown=False)
    return out


def main():
    ids = preflight()
    entry = dict(ids, action='READ_HOLDOUT', at=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                 seasons=HOLDOUT, note='the one read of the 2024-2025 holdout for this policy')
    log_access(entry)                                                   # logged BEFORE the read
    U, G, rule = T.load_dev()                                           # DEV: the close-EV residuals and the DEV OOS bounds
    table = T.residual_table(U)
    A = POL.load_artifact()
    policy = json.load(open(os.path.join(T.POLICY_DIR, 'policy.json')))
    ev = json.load(open(os.path.join(T.POLICY_DIR, 'evidence.json')))
    tour = ev['tournament']
    H, S7 = load_holdout()                                              # THE holdout read
    F = frame(H, S7, A, rule, table)
    res = evaluate(F, tour, policy, A, tour['oos'])
    res['per_book_sensitivity'] = per_book(H, A, table)
    res['access'] = entry
    an = json.load(open(os.path.join(T.out_dir(), 'analyses.json')))
    gate = T.promotion_gate(tour, an, holdout={'production': res['production'], 'tiers_high_ge_low_clv': res['tiers_high_ge_low_clv'],
                                              'no_collapse': res['no_collapse']}, shadow_settled=0)
    res['promotion_gate'] = gate
    T.dump('holdout.json', T.clean(res))
    hsha = T.sha256_file(os.path.join(T.out_dir(), 'holdout.json'))
    ev['holdout'] = T.clean(res)
    ev['promotion_gate_after_holdout'] = gate
    ep = os.path.join(T.POLICY_DIR, 'evidence.json')
    with open(ep, 'w') as f:
        json.dump(T.clean(ev), f, indent=1, sort_keys=True, default=T._js, allow_nan=False)
        f.write('\n')
    mj = os.path.join(T.POLICY_DIR, 'MANIFEST.json')
    M = json.load(open(mj))
    M['holdout_scored'] = True
    M['holdout'] = {'at': entry['at'], 'seasons': HOLDOUT, 'results_sha256': hsha, 'policy_sha256': ids['policy_sha256'],
                    'access_log': 'holdout_access.jsonl'}
    M['files']['evidence.json'] = T.sha256_file(ep)
    M['promotion_gate'] = {k: (v['pass'] if isinstance(v, dict) else v) for k, v in gate.items()}
    with open(mj, 'w') as f:
        json.dump(T.clean(M), f, indent=1, sort_keys=True)
        f.write('\n')
    log_access({'action': 'HOLDOUT_SCORED', 'at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'policy_sha256': ids['policy_sha256'], 'results_sha256': hsha})
    print('[holdout] scored once:', {k: (v['bet_count'], v.get('avg_clv'), v.get('close_implied_ev'), v.get('roi'))
                                     for k, v in res['candidates'].items()})
    print('[holdout] production statuses', res['production']['status_counts'], 'gate promote', gate['promote'])
    return res


if __name__ == '__main__':
    main()
