"""Stage 8 — the market decision layer. It runs only AFTER the pure projection is frozen.

The pure layer answers "what is likely to happen". This layer answers "is the
price far enough from our calibrated distribution to act". It reads the
frozen pure projection (ens_pred, sigma, t df) and the market, and never writes
back into the pure projection.

Everything learned here (cover-probability calibration, the market-adjusted
challenger's weights, the decision thresholds) is fit walk-forward on earlier
seasons, and the THRESHOLDS are chosen on the development seasons only.

Historical simulation convention: a bet is placed at the OPENING consensus
line at the Tuesday freeze, at -110 (the archive carries lines, not spread
prices — stated in every report), and graded against the final margin. CLV is
the move from that opener to the close, oriented to the side taken.
"""
import numpy as np
import pandas as pd
from scipy import optimize

from . import config as C
from . import common
from .walkforward import t_cdf, assert_past_only

JUICE = C.STANDARD_JUICE_FOR_BACKTEST
WIN_PAYOUT = 100.0 / abs(JUICE)          # 0.9091 units per unit risked at -110
BREAK_EVEN = 1.0 / (1.0 + WIN_PAYOUT)    # 0.5238


def american_to_payout(a):
    a = float(a)
    return a / 100.0 if a > 0 else 100.0 / (-a)


def break_even_prob(a):
    return 1.0 / (1.0 + american_to_payout(a))


def push_prob_table(past):
    """P(final margin == line) for integer lines, by |line| bucket, from past seasons."""
    p = past[past.line.notna()]
    p = p[np.isclose(p.line, np.round(p.line))]
    tab = {}
    for lo, hi in ((0, 2.5), (2.5, 3.5), (3.5, 6.5), (6.5, 7.5), (7.5, 13.5), (13.5, 99)):
        s = p[p.line.abs().between(lo, hi)]
        tab[(lo, hi)] = float((s.margin == s.line).mean()) if len(s) > 50 else 0.02
    return tab


def push_prob(line, tab):
    if line is None or np.isnan(line) or not np.isclose(line, round(line)):
        return 0.0
    for (lo, hi), v in tab.items():
        if lo <= abs(line) <= hi:
            return v
    return 0.02


def cover_design(D, p_raw, rsd_fill=1.0):
    """Conditional Platt design: the slope on the model's own cover logit may
    shrink when the model is less trustworthy (dynamic no-bet zone).
    rsd_fill is learned on the calibrator's TRAINING rows (candidate 001 used
    the median of the batch being scored — a within-season look-ahead)."""
    x = np.log(np.clip(p_raw, 1e-4, 1 - 1e-4) / (1 - np.clip(p_raw, 1e-4, 1 - 1e-4)))
    ens_sd = (D.ens_sd.values - 3.0) / 2.0
    rsd = (D.rating_sd_sum.fillna(rsd_fill).values - 1.0)
    early = D.early_season.values.astype(float)
    qbu = D.qb_unsettled_any.fillna(0).values + D.qb_missing_any.fillna(1).values
    return np.column_stack([np.ones_like(x), x, x * ens_sd, x * rsd, x * early, x * qbu])


class CoverCalibrator:
    def fit(self, A, y):
        f = lambda b: np.sum(np.logaddexp(0, -(2 * y - 1) * (A @ b))) + 1.0 * np.sum(b[2:] ** 2)
        b0 = np.zeros(A.shape[1]); b0[1] = 1.0
        self.b_ = optimize.minimize(f, b0, method='BFGS').x
        return self

    def predict(self, A):
        return 1.0 / (1.0 + np.exp(-(A @ self.b_)))


def run(D, MK, unc, seasons):
    """Attach market-layer columns to every game with an opening line."""
    M = D.merge(MK[['game_id', 'open_margin', 'close_margin', 'total_open', 'total_close',
                    'has_open', 'market_dispersion', 'spread_books', 'source']],
                on='game_id', how='left')
    M['line'] = M.open_margin
    M['gap_open'] = M.ens_pred - M.open_margin          # + = model likes HOME vs the opener
    M['gap_close'] = M.ens_pred - M.close_margin
    for c in ('pc_home_raw', 'pc_home_cal', 'p_side', 'ev', 'push_p', 'clv_exp', 'pred_ma',
              'ma_weight_model'):
        M[c] = np.nan
    params = {}
    for S in seasons:
        if S not in unc:
            continue
        df = unc[S]['t_df']
        cur = M.season.eq(S) & M.ens_pred.notna() & M.line.notna()
        past = M[(M.season < S) & M.ens_pred.notna() & M.line.notna() & M.status.eq('FINAL')
                 & M.sigma.notna() & M.season.isin(list(unc.keys()) + [])]
        # the cover calibrator needs its own OOF raw probs, which exist only
        # for seasons that themselves had an uncertainty model
        if len(past) < 400:
            continue
        assert_past_only(sorted(past.season.unique()), S)
        pr_past = 1.0 - t_cdf((past.line.values - past.ens_pred.values) / past.sigma.values,
                              np.array([unc[s]['t_df'] for s in past.season]))
        nonpush = past.margin.values != past.line.values
        yc = (past.margin.values > past.line.values).astype(float)
        rsd_fill = float(past.rating_sd_sum.median())
        cal = CoverCalibrator().fit(cover_design(past[nonpush], pr_past[nonpush], rsd_fill), yc[nonpush])
        tab = push_prob_table(past)
        c = M[cur]
        pr = 1.0 - t_cdf((c.line.values - c.ens_pred.values) / c.sigma.values, df)
        pc = cal.predict(cover_design(c, pr, rsd_fill))
        pp = np.array([push_prob(l, tab) for l in c.line.values])
        side_home = pc >= 0.5
        p_side = np.where(side_home, pc, 1 - pc)
        # EV per unit risked at -110 with push mass removed from both outcomes
        p_win = p_side * (1 - pp)
        p_loss = (1 - p_side) * (1 - pp)
        ev = p_win * WIN_PAYOUT - p_loss
        M.loc[cur, 'pc_home_raw'] = pr
        M.loc[cur, 'pc_home_cal'] = pc
        M.loc[cur, 'p_side'] = p_side
        M.loc[cur, 'push_p'] = pp
        M.loc[cur, 'ev'] = ev
        M.loc[cur, 'side'] = np.where(side_home, 'HOME', 'AWAY')
        # expected close movement toward the model (CLV opportunity), learned
        pm = past.close_margin.notna()
        beta = None
        if pm.sum() > 300:
            x = (past.ens_pred - past.line)[pm].values
            yv = (past.close_margin - past.line)[pm].values
            beta = float(np.sum(x * yv) / np.sum(x * x))
            M.loc[cur, 'clv_exp'] = beta * (c.ens_pred - c.line).values
        # market-adjusted CHALLENGER (never labelled the EdgeDesk fair line)
        A = np.column_stack([np.ones(len(past)), past.ens_pred, past.line,
                             past.ens_pred * past.early_season, past.line * past.early_season,
                             past.ens_pred * (past.ens_sd - 3) / 2, past.line * (past.ens_sd - 3) / 2])
        b = np.linalg.lstsq(A, past.margin.values, rcond=None)[0]
        Ac = np.column_stack([np.ones(len(c)), c.ens_pred, c.line, c.ens_pred * c.early_season,
                              c.line * c.early_season, c.ens_pred * (c.ens_sd - 3) / 2,
                              c.line * (c.ens_sd - 3) / 2])
        M.loc[cur, 'pred_ma'] = Ac @ b
        wm = (b[1] + b[3] * c.early_season.values + b[5] * (c.ens_sd.values - 3) / 2)
        wk = (b[2] + b[4] * c.early_season.values + b[6] * (c.ens_sd.values - 3) / 2)
        M.loc[cur, 'ma_weight_model'] = wm / np.where(np.abs(wm + wk) < 1e-6, 1, wm + wk)
        params[S] = {'cover_cal': [float(x) for x in cal.b_], 'cover_rsd_fill': rsd_fill, 'push_table': {'%s-%s' % k: v for k, v in tab.items()},
                     'ma_coef': [float(x) for x in b], 'clv_beta': beta, 'n_train': int(len(past))}
    # grading (evaluation only)
    fin = M.status.eq('FINAL') & M.line.notna() & M.side.notna()
    hm = M.side.eq('HOME')
    diff = M.margin - M.line
    M['bet_result'] = np.where(~fin, np.nan,
                               np.where(diff == 0, 0.0, np.where((diff > 0) == hm, 1.0, -1.0)))
    M['bet_units'] = np.where(M.bet_result == 1, WIN_PAYOUT, np.where(M.bet_result == -1, -1.0, 0.0))
    M.loc[~fin, 'bet_units'] = np.nan
    M['clv_pts'] = np.where(hm, M.close_margin - M.line, M.line - M.close_margin)
    # PESSIMISTIC CHECK: the archive has only the opener and the close, and a
    # Tuesday freeze may already be looking at a line that has moved from the
    # opener. Grading the same side at the CLOSING number is the lower bound:
    # if the side does not win at the close, the opener result is timing.
    finc = fin & M.close_margin.notna()
    dc = M.margin - M.close_margin
    M['bet_result_close'] = np.where(~finc, np.nan,
                                     np.where(dc == 0, 0.0, np.where((dc > 0) == hm, 1.0, -1.0)))
    M['bet_units_close'] = np.where(M.bet_result_close == 1, WIN_PAYOUT,
                                    np.where(M.bet_result_close == -1, -1.0, 0.0))
    M.loc[~finc, 'bet_units_close'] = np.nan
    return M, params


def decide(M, rule):
    """Research status from the frozen dev-selected rule. Returns (status, reason)."""
    st = np.full(len(M), 'PASS', dtype=object)
    why = np.full(len(M), 'insufficient edge after calibration', dtype=object)
    has = M.line.notna() & M.ev.notna()
    why[~has.values] = 'no opening market line'
    big = has & (M.gap_open.abs() >= rule['review_gap'])
    lean = has & (M.ev > rule['lean_ev']) & (M.gap_open.abs() >= rule['lean_gap'])
    bet = lean & (M.ev > rule['bet_ev']) & (M.gap_open.abs() >= rule['bet_gap']) \
        & (M.reliability >= rule['bet_min_rel'])
    if rule.get('exclude_early'):
        bet &= ~M.early_season.astype(bool)
    st[lean.values] = 'LEAN'; why[lean.values] = 'positive calibrated EV below the BET rule'
    if rule.get('bet_enabled'):
        st[bet.values] = 'BET'; why[bet.values] = 'meets the development-window rule'
    else:
        st[bet.values] = 'LEAN'
        why[bet.values] = 'meets the dev rule, but BET is disabled: the rule did not beat the reality check'
    rv = big & ~bet
    st[rv.values] = 'REVIEW'
    why[rv.values] = 'disagreement beyond %.0f pts: historically a data or news problem more often than an edge' % rule['review_gap']
    # the production orientation guard (engine.js decide): a disagreement that
    # collapses when the market sign is flipped is a convention fault, never an edge
    orient = has & (M.gap_open.abs() > 21) & ((M.ens_pred + M.line).abs() <= 7)
    st[orient.values] = 'REVIEW'
    why[orient.values] = 'market number looks sign-flipped relative to the model: data check, never an edge'
    return st, why
