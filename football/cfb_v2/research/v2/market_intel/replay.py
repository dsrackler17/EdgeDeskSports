"""Historical market replay, execution simulation, line-shopping value, the
timing scorecard and the market-layer backtest ladder (brief sections 53-56,
65, 72-73, 81-82; docs/cfb-market/BACKTEST.md).

    python3 -m v2.market_intel.replay              DEV 2016-2023
    python3 -m v2.market_intel.replay --holdout    the 2024-2025 holdout, ONCE

REPLAY. The historical record is two market states per game: the consensus
OPENER (no timestamp) and the CLOSE. A decision at the Tuesday 12:00 UTC
freeze sees only the opener (assumed available then: an optimistic fill, the
same convention as v2/market.py and REDTEAM.md) and never the close, a later
price or a later book. The close enters only as the outcome-side benchmark
(CLV) or as the explicitly LATER execution ("final pre-kick").

PRICES. 2016-2019: real prices (the 5Dimes opening price of the very opener
the study bets; every book's closing price). 2020-2025: none exist, so an
ASSUMED -110 is used and labelled on every table. A live output never assumes
a price (football/cfb_market/market_intel.js).

NO RULE SEARCH. Every arm of the ladder uses thresholds written here before it
was run; nothing is tuned on results. The tuned policy belongs to the decision
engine (football/cfb_decision; docs/cfb-decision/DESIGN.md).
"""
import argparse
import datetime as dt
import json
import os

import numpy as np
import pandas as pd

from ..decision import core
from . import books as BK
from . import challenger as CH
from . import data as D
from . import keynumbers as KN

KEYS = (3, 7, 10, 14)
# ---- REGISTRATION 1 (fixed before any ladder result was computed): cumulative arms.
# It turned out degenerate: once |gap| >= 3, the pure t probability is >= 0.55 and the
# EV >= 3% in every game (the raw pure probability is overconfident against the market),
# so A1 = A2 = A3. It is still reported.
GAP_MIN = 3.0            # A1: |pure - opener| >= 3 points
P_MIN = 0.55             # A2: + pure cover probability (t, frozen sigma) >= 0.55
EV_MIN_PURE = 0.03       # A3: + EV per unit at the price, pure probability + key-number push
EV_MIN_MI = 0.02         # A4: + EV per unit at the price under the market-informed challenger mean
REVIEW_GAP = 14.0        # A4: |gap| >= 14 is a data review, never a bet (the frozen review_gap)
# ---- REGISTRATION 2 (fixed after registration 1 was seen to be degenerate, BEFORE any of
# these arms was computed): each arm is a STANDALONE rule at the nominal strength of a
# 3-point gap - p = 0.57 is a 3-point gap at the median frozen sigma (16.4), EV = 9% is the
# pure EV of that gap at -110 - so the arms differ only in what they measure.
R2_P_MIN = 0.57          # A2': pure cover probability >= 0.57 (scales the gap by the game's sigma)
R2_EV_MIN = 0.09         # A3': pure EV >= 9% at the ACTUAL price with the key-number push
ASSUMED = -110.0


# ------------------------------------------------------------ prices
def opener_prices(A):
    """the 5Dimes opener (line + both prices) per game, 2016-2019."""
    S = A[(A.market_type == 'spread') & (A.kind == 'OPEN') & (A.book_key == '5dimessportbet')]
    return S[['game_id', 'home_margin', 'price_home', 'price_away']].rename(
        columns={'home_margin': 'dimes_open', 'price_home': 'op_home', 'price_away': 'op_away'})


def close_prices(A, X):
    """per game: the median closing price of the books that hang exactly the
    consensus closing number, each side (2016-2019; else missing)."""
    S = A[(A.market_type == 'spread') & (A.kind == 'CLOSE') & A.is_book & A.price_home.notna() & A.price_away.notna()]
    S = S.merge(X[['game_id', 'close_margin']], on='game_id')
    S = S[np.isclose(S.home_margin, S.close_margin)]
    to_dec = lambda a: 1.0 + core.american_to_payout(a)
    S = S.assign(dh=to_dec(S.price_home.values), da=to_dec(S.price_away.values))
    g = S.groupby('game_id')[['dh', 'da']].median().reset_index()
    back = lambda d: np.where(d >= 2, (d - 1) * 100, -100 / (d - 1))
    g['cp_home'] = back(g.dh.values)
    g['cp_away'] = back(g.da.values)
    return g[['game_id', 'cp_home', 'cp_away']]


# ---------------------------------------------------- probabilities
def side_probs(P, L, s):
    """P(win), P(push), P(loss) of side s (+1 home, -1 away) at internal line L, per row."""
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)[None, :]
    L = np.asarray(L, float)[:, None]
    above = (P * (ks > L + 1e-9)).sum(axis=1)
    below = (P * (ks < L - 1e-9)).sum(axis=1)
    push = 1.0 - above - below
    win = np.where(s > 0, above, below)
    loss = np.where(s > 0, below, above)
    return win, push, loss


def ev_units(win, push, loss, price):
    b = core.american_to_payout(np.asarray(price, float))
    return win * b - loss


def units(result, price):
    b = core.american_to_payout(np.asarray(price, float))
    return np.where(result > 0, b, np.where(result < 0, -1.0, 0.0))


def result_of(margin, L, s):
    d = (np.asarray(margin, float) - np.asarray(L, float)) * s
    return np.sign(d)


# ------------------------------------------------------------ frame
def build(X, A, seasons, fit, chal_w, sigma_mkt, stage7):
    """one row per game with a usable opener and a pure prediction with sigma."""
    Q = X[X.fbs_fbs & X.final & X.season.isin(seasons) & X.open_ok & X.ens_pred.notna() & X.sigma.notna()
          & ~X.eval_open_close_jump.fillna(False).astype(bool) & X.close_margin.notna()].copy()
    Q = Q.merge(opener_prices(A), on='game_id', how='left').merge(close_prices(A, X), on='game_id', how='left')
    Q = Q.merge(stage7, on='game_id', how='left')
    Q = Q.sort_values(['kickoff_ts', 'game_id']).reset_index(drop=True)
    Q['gap'] = Q.ens_pred - Q.open_margin
    Q['s'] = np.where(Q.gap >= 0, 1.0, -1.0)                 # EdgeDesk's side vs the opener
    real_open = Q.season.le(2019) & Q.op_home.notna() & Q.op_away.notna() & np.isclose(Q.dimes_open, Q.open_margin)
    Q['price_open'] = np.where(real_open, np.where(Q.s > 0, Q.op_home, Q.op_away), ASSUMED)
    Q['price_open_src'] = np.where(real_open, 'ARCHIVE_5DIMES_OPEN', 'ASSUMED_-110')
    real_close = Q.cp_home.notna() & Q.cp_away.notna()
    Q['price_close'] = np.where(real_close, np.where(Q.s > 0, Q.cp_home, Q.cp_away), ASSUMED)
    Q['price_close_src'] = np.where(real_close, 'ARCHIVE_CLOSE_MEDIAN', 'ASSUMED_-110')
    n = len(Q)
    Pp = KN.key_pmf(Q.ens_pred.values, Q.sigma.values, Q.t_df.values, fit['mult'], fit['ot'], fit['method'])
    Pt = KN.pmf_t(Q.ens_pred.values, Q.sigma.values, Q.t_df.values)
    Q['w_o'], Q['p_o'], Q['l_o'] = side_probs(Pp, Q.open_margin.values, Q.s.values)
    wt, pt, lt = side_probs(Pt, Q.open_margin.values, Q.s.values)
    Q['p_pure_t'] = wt / np.maximum(wt + lt, 1e-12)            # the pure t's P(cover | no push)
    Q['ev_pure_open'] = ev_units(Q.w_o.values, Q.p_o.values, Q.l_o.values, Q.price_open.values)
    mu_h = Q.open_margin.values + chal_w * Q.gap.values        # the market-informed challenger mean
    Ph = KN.key_pmf(mu_h, Q.sigma.values, Q.t_df.values, fit['mult'], fit['ot'], fit['method'])
    wh, ph, lh = side_probs(Ph, Q.open_margin.values, Q.s.values)
    Q['ev_mi_open'] = ev_units(wh, ph, lh, Q.price_open.values)
    # the market's own view at the close (the CLV benchmark in EV units)
    Pm = KN.key_pmf(Q.close_margin.values, np.full(n, sigma_mkt), np.full(n, 100.0), fit['mult'], fit['ot'], fit['method'])
    wm, pm, lm = side_probs(Pm, Q.open_margin.values, Q.s.values)
    Q['ev_mkt_open'] = ev_units(wm, pm, lm, Q.price_open.values)
    wc, pc, lc = side_probs(Pm, Q.close_margin.values, Q.s.values)
    Q['ev_mkt_close'] = ev_units(wc, pc, lc, Q.price_close.values)
    wpc, ppc, lpc = side_probs(Pp, Q.close_margin.values, Q.s.values)
    Q['ev_pure_close'] = ev_units(wpc, ppc, lpc, Q.price_close.values)
    Q['clv_pts'] = (Q.close_margin - Q.open_margin) * Q.s
    Q['res_open'] = result_of(Q.margin.values, Q.open_margin.values, Q.s.values)
    Q['res_close'] = result_of(Q.margin.values, Q.close_margin.values, Q.s.values)
    Q['u_open'] = units(Q.res_open.values, Q.price_open.values)
    Q['u_close'] = units(Q.res_close.values, Q.price_close.values)
    Q['on_key'] = np.isin(Q.open_margin.abs(), KEYS)
    return Q


def stage7_cols():
    import pandas as _pd
    from .. import config as C
    S = _pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'), columns=['game_id', 'ev', 'p_side'])
    return S.rename(columns={'ev': 'stage8_ev', 'p_side': 'stage8_p_side'})


# ------------------------------------------------------------ scoring
def score(Q, m, exec_='open', label=''):
    """one strategy: bets where m, executed at the opener or the close."""
    Z = Q[m].reset_index(drop=True)
    n = len(Z)
    if n == 0:
        return {'arm': label, 'bets': 0}
    u = Z['u_' + exec_].values
    res = Z['res_' + exec_].values
    bt = D.Boot(n)
    win = np.where(res > 0, 1.0, np.where(res < 0, 0.0, np.nan))
    clv = Z.clv_pts.values if exec_ == 'open' else np.zeros(n)
    evm = Z['ev_mkt_' + exec_].values
    srcs = Z['price_%s_src' % exec_].value_counts().to_dict()
    return {'arm': label, 'execution': exec_, 'bets': int(n),
            'bets_per_season': D.r(n / max(Z.season.nunique(), 1), 1),
            'clv_pts': D.cell(bt.mean(clv), 3), 'positive_clv_rate': D.cell(bt.mean((clv > 0).astype(float)), 3),
            'ev_at_entry_market_close_view': D.cell(bt.mean(evm), 4),
            'ats': D.cell(bt.mean(win), 3), 'roi': D.cell(bt.ratio(u, np.ones(n)), 4),
            'units': D.r(u.sum(), 2), 'max_drawdown_u': D.r(core.max_drawdown(u), 2), 'price_sources': srcs}


def _timing(Q, a4):
    """A5: bet now at the opener when the walk-forward expected close move is toward
    the side; otherwise wait and re-decide at the close with the close-horizon challenger."""
    exp_move = Q.exp_move_toward.values
    now = a4 & (exp_move >= 0)
    wait = a4 & (exp_move < 0)
    still = wait & (Q.ev_mi_close.values >= EV_MIN_MI)
    t = score(Q, now, 'open', 'A5 timing: BET NOW part (expected move toward the side)')
    w = score(Q, still, 'close', 'A5 timing: WAIT part, still >= 2% EV at the close')
    both = pd.concat([Q[now].assign(_u=Q.u_open[now], _res=Q.res_open[now], _clv=Q.clv_pts[now], _ev=Q.ev_mkt_open[now]),
                      Q[still].assign(_u=Q.u_close[still], _res=Q.res_close[still], _clv=0.0, _ev=Q.ev_mkt_close[still])]).sort_values('kickoff_ts')
    comb = {'arm': 'A5 + timing (now + surviving waits)', 'bets': int(len(both)),
            'waits_total': int(wait.sum()), 'waits_that_disappeared': int((wait & ~still).sum())}
    if len(both):
        bt = D.Boot(len(both))
        wv = np.where(both._res > 0, 1.0, np.where(both._res < 0, 0.0, np.nan))
        comb.update({'clv_pts': D.cell(bt.mean(both._clv.values), 3), 'positive_clv_rate': D.cell(bt.mean((both._clv.values > 0).astype(float)), 3),
                     'ev_at_entry_market_close_view': D.cell(bt.mean(both._ev.values), 4),
                     'ats': D.cell(bt.mean(wv), 3), 'roi': D.cell(bt.ratio(both._u.values, np.ones(len(both))), 4),
                     'units': D.r(both._u.sum(), 2), 'max_drawdown_u': D.r(core.max_drawdown(both._u.values), 2)})
    return [t, w, comb]


def arm_masks(Q, registration=2):
    """the decision of every arm, from PRE-DECISION columns only (the opener, the
    pure projection, the price at the opener, the challenger mean). The close,
    the result and every later price are never read here (tests_market checks it)."""
    gap = Q.gap.abs().values
    old = (Q.stage8_ev.values > 0.06) & (gap >= 3.0) & ~Q.early_season.fillna(0).astype(bool).values & (gap < 14.0)
    mi = (Q.ev_mi_open.values >= EV_MIN_MI) & (gap < REVIEW_GAP)
    a1 = gap >= GAP_MIN
    if registration == 1:
        a2 = a1 & (Q.p_pure_t.values >= P_MIN)
        a3 = a2 & (Q.ev_pure_open.values >= EV_MIN_PURE)
        a4 = a3 & mi
    else:
        a2 = Q.p_pure_t.values >= R2_P_MIN
        a3 = Q.ev_pure_open.values >= R2_EV_MIN
        a4 = mi
    return {'old': old, 'a1': a1, 'a2': a2, 'a3': a3, 'a4': a4}


def ladder(Q, registration=2):
    """PURE GAP -> + UNCERTAINTY -> + PRICE/VIG -> + MARKET INTELLIGENCE -> + TIMING,
    beside the frozen stage-8 rule (the 'old' market decision, SELECTED ON DEV)."""
    M = arm_masks(Q, registration)
    if registration == 1:
        names = ('A1 pure gap only (|gap| >= 3)', 'A2 + uncertainty (pure cover p >= 0.55)',
                 'A3 + price/vig (EV >= 3% at the price, key-number push)', 'A4 + market intelligence (challenger-mean EV >= 2%, review gap)')
    else:
        names = ("A1 pure gap only (|gap| >= 3)", "A2' pure + uncertainty (pure cover p >= 0.57: the gap scaled by sigma)",
                 "A3' pure + price/vig (EV >= 9% at the actual price, key-number push)",
                 "A4' pure + market intelligence (challenger-mean EV >= 2% at the price, key numbers, review gap)")
    rows = [score(Q, np.ones(len(Q), bool), 'open', 'every game, model side (reference)'),
            score(Q, M['old'], 'open', 'OLD: frozen stage-8 rule (ev > 0.06, gap >= 3, not early, gap < 14; selected on DEV)')]
    rows += [score(Q, M[k], 'open', n) for k, n in zip(('a1', 'a2', 'a3', 'a4'), names)]
    rows += _timing(Q, M['a4'])
    return rows


def timing_scorecard(Q):
    """the same EdgeDesk side, bet at the opener (Tuesday freeze) vs at the
    close (final pre-kick): EV at entry, CLV, ATS, ROI - all games and |gap| >= 3."""
    out = []
    for lab, m in (('all games', np.ones(len(Q), bool)), ('|gap| >= 3', Q.gap.abs().values >= 3)):
        for ex in ('open', 'close'):
            r_ = score(Q, m, ex, lab)
            Z = Q[m]
            bt = D.Boot(len(Z))
            r_['ev_at_entry_pure_view'] = D.cell(bt.mean(Z['ev_pure_' + ex].values), 4)
            out.append(r_)
        Z = Q[m].reset_index(drop=True)
        bt = D.Boot(len(Z))
        out.append({'arm': lab, 'execution': 'open minus close (paired)',
                    'roi_diff': D.cell(bt.mean(Z.u_open.values - Z.u_close.values), 4),
                    'ev_market_view_diff': D.cell(bt.mean(Z.ev_mkt_open.values - Z.ev_mkt_close.values), 4)})
    return out


def expected_move(Q_all, train_cap=None):
    """walk-forward expected close move toward EdgeDesk's side (movement.expected_close form).
    train_cap: the last season any fit may read (the holdout passes the last DEV season)."""
    Q = Q_all.copy()
    Q['on_key_f'] = Q.on_key.astype(float)
    Q['early_f'] = Q.early_season.fillna(0).astype(float)
    Q['exp_move_toward'] = np.nan
    feats = lambda F: np.column_stack([F.gap, F.gap * F.on_key_f, F.gap * F.early_f])
    for S in sorted(Q.season.unique()):
        tr = Q[(Q.season < S) & ((Q.season <= train_cap) if train_cap else True)]
        if len(tr) < 400:
            continue
        b = np.linalg.lstsq(feats(tr), (tr.close_margin - tr.open_margin).values, rcond=None)[0]
        m = Q.season == S
        Q.loc[m, 'exp_move_toward'] = (feats(Q[m]) @ b) * Q.s[m].values
    return Q


def attach_close_ev(Q, fit, w_close):
    mu = Q.close_margin.values + w_close * (Q.ens_pred.values - Q.close_margin.values)
    P = KN.key_pmf(mu, Q.sigma.values, Q.t_df.values, fit['mult'], fit['ot'], fit['method'])
    w, p, l = side_probs(P, Q.close_margin.values, Q.s.values)
    Q['ev_mi_close'] = ev_units(w, p, l, Q.price_close.values)
    return Q


# ------------------------------------------------------ line shopping
def line_shopping(X, A, fit, sigma_mkt):
    """2016-2019 closes at real prices: consensus vs one book vs the best line /
    best price-adjusted / best-EV quote among 3 books and among all books."""
    S = BK.quotes_with_implied(A, X, BK.PRICE_SEASONS, fit, sigma_mkt)
    S = S[~S.feed_error & S.priced]
    G = X[X.fbs_fbs & X.final & X.season.isin(BK.PRICE_SEASONS) & X.close_margin.notna() & X.sigma.notna()][
        ['game_id', 'ens_pred', 'sigma', 't_df', 'close_margin', 'margin', 'season', 'kickoff_ts']]
    S = S.merge(G[['game_id', 'ens_pred', 'sigma', 't_df']], on='game_id')
    G = G[G.game_id.isin(S.game_id)].sort_values(['kickoff_ts', 'game_id']).reset_index(drop=True)
    G['s'] = np.where(G.ens_pred - G.close_margin >= 0, 1.0, -1.0)
    S = S.merge(G[['game_id', 's']], on='game_id')
    S['price_side'] = np.where(S.s > 0, S.price_home, S.price_away)
    # EV of every quote under EdgeDesk's key distribution and under the market's (consensus-centred)
    Pe = KN.key_pmf(S.ens_pred.values, S.sigma.values, S.t_df.values, fit['mult'], fit['ot'], fit['method'])
    we, pe, le = side_probs(Pe, S.home_margin.values, S.s.values)
    S['ev_ed'] = ev_units(we, pe, le, S.price_side.values)
    cmed = S.close_margin.values
    Pm = KN.key_pmf(cmed, np.full(len(S), sigma_mkt), np.full(len(S), 100.0), fit['mult'], fit['ot'], fit['method'])
    wm, pm, lm = side_probs(Pm, S.home_margin.values, S.s.values)
    S['ev_mkt'] = ev_units(wm, pm, lm, S.price_side.values)
    S['side_line'] = S.home_margin * S.s * -1.0            # points for the side in its own convention (+ = getting points)
    S['res'] = result_of(S.margin.values, S.home_margin.values, S.s.values)
    S['u'] = units(S.res.values, S.price_side.values)
    three = {'5dimessportbet', 'bovadabodog', 'betonlinesportsbetting'}

    def pick(sub, how):
        if how == 'best_line':
            sub = sub.sort_values(['game_id', 'side_line', 'ev_mkt'], ascending=[True, False, False])
        elif how == 'best_ev_edgedesk':
            sub = sub.sort_values(['game_id', 'ev_ed'], ascending=[True, False])
        elif how == 'best_ev_market':
            sub = sub.sort_values(['game_id', 'ev_mkt'], ascending=[True, False])
        return sub.groupby('game_id').head(1).set_index('game_id')

    cons = S[np.isclose(S.home_margin, S.close_margin.values)]
    cons = cons.groupby('game_id').agg(ev_mkt=('ev_mkt', 'median'), ev_ed=('ev_ed', 'median'), u=('u', 'median'),
                                       res=('res', 'first'), side_line=('side_line', 'first'))
    strategies = {'consensus (median number, median price)': cons,
                  'one book (Bovada)': S[S.book_key == 'bovadabodog'].groupby('game_id').head(1).set_index('game_id'),
                  'best number, 3 books': pick(S[S.book_key.isin(three)], 'best_line'),
                  'best EdgeDesk EV, 3 books': pick(S[S.book_key.isin(three)], 'best_ev_edgedesk'),
                  'best number, all books': pick(S, 'best_line'),
                  'best price-adjusted (market EV), all books': pick(S, 'best_ev_market'),
                  'best EdgeDesk EV, all books': pick(S, 'best_ev_edgedesk')}
    base_games = G.set_index('game_id')
    out = []
    for subset, gm in (('every game (EdgeDesk side vs the close)', np.ones(len(G), bool)),
                       ('|pure - close| >= 3', (G.ens_pred - G.close_margin).abs().values >= 3)):
        ids = G.game_id.values[gm]
        common = set(ids)
        for k, v in strategies.items():
            common &= set(v.index)
        ids = [i for i in ids if i in common]
        bt = D.Boot(len(ids))
        c = strategies['consensus (median number, median price)'].loc[ids]
        for name, T in strategies.items():
            T = T.loc[ids]
            win = np.where(T.res > 0, 1.0, np.where(T.res < 0, 0.0, np.nan))
            conv_pw = ((c.res.values == 0) & (T.res.values > 0)).mean()
            conv_lp = ((c.res.values < 0) & (T.res.values == 0)).mean()
            conv_lw = ((c.res.values < 0) & (T.res.values > 0)).mean()
            out.append({'subset': subset, 'strategy': name, 'games': len(ids),
                        'points_vs_consensus': D.cell(bt.mean(T.side_line.values - c.side_line.values), 3),
                        'ev_market_view': D.cell(bt.mean(T.ev_mkt.values), 4),
                        'ev_market_view_minus_consensus': D.cell(bt.mean(T.ev_mkt.values - c.ev_mkt.values), 4),
                        'ats': D.cell(bt.mean(win), 3), 'roi': D.cell(bt.ratio(T.u.values, np.ones(len(T))), 4),
                        'roi_minus_consensus': D.cell(bt.mean(T.u.values - c.u.values), 4),
                        'conversions_vs_consensus': {'push_to_win': D.r(conv_pw, 4), 'loss_to_push': D.r(conv_lp, 4), 'loss_to_win': D.r(conv_lw, 4)}})
    return {'seasons': list(BK.PRICE_SEASONS), 'rows': out,
            'note': 'real closing prices; the offshore books of 2016-2019 (the US books the Lab captures today are not in this archive with prices)'}


def pinnacle_proxy(X):
    """how often the Pinnacle close differs from the consensus close (2013-2019, stage-2)."""
    Z = X[X.fbs_fbs & X.final & X.season.between(2013, 2019) & X.pin_close_margin.notna() & X.close_margin.notna()].reset_index(drop=True)
    d = (Z.pin_close_margin - Z.close_margin).values
    bt = D.Boot(len(Z))
    return {'n': int(len(Z)), 'mean_abs_diff_pts': D.cell(bt.mean(np.abs(d)), 3),
            'share_diff_ge_0_5': D.cell(bt.mean((np.abs(d) >= 0.5).astype(float)), 3),
            'share_diff_ge_1': D.cell(bt.mean((np.abs(d) >= 1).astype(float)), 3),
            'note': 'lines only (the price is not compared): the share of games in which a second, sharper book offered a different number at the close'}


def live_cadence():
    """the live Lab ledger: how often a book's pregame quote is refreshed (for
    the stale-data failsafe and latency) - counts only; no decisions exist yet."""
    import glob
    p = os.path.join(D.REPO, 'football', 'cfb_lab', 'ledger', '2026', 'quotes', '*.jsonl')
    rows = [json.loads(l) for f in sorted(glob.glob(p)) for l in open(f) if l.strip()]
    Qd = pd.DataFrame(rows)
    if not len(Qd):
        return {'quotes': 0}
    sp = Qd[(Qd.market_type == 'spread') & Qd.is_pregame & ~Qd.is_provider_open]
    sp = sp.assign(t=pd.to_datetime(sp.observed_at, utc=True), k=pd.to_datetime(sp.kickoff_ts, utc=True))
    sp = sp.sort_values(['game_id', 'book', 't'])
    gaps = sp.groupby(['game_id', 'book']).t.diff().dt.total_seconds().dropna() / 60.0
    lead = (sp.k - sp.t).dt.total_seconds() / 3600.0
    return {'quotes_total': int(len(Qd)), 'books': sorted(Qd.book.dropna().unique().tolist()),
            'quotes_with_price': int(Qd[['price_home', 'price_away', 'price_over', 'price_under']].notna().any(axis=1).sum()),
            'pregame_spread_quotes': int(len(sp)), 'games_with_pregame_quote': int(sp.game_id.nunique()),
            'refresh_gap_minutes_quantiles': {str(q): D.r(np.quantile(gaps, q), 1) for q in (0.1, 0.5, 0.9)} if len(gaps) else None,
            'hours_to_kickoff_quantiles': {str(q): D.r(np.quantile(lead, q), 1) for q in (0.1, 0.5, 0.9)} if len(lead) else None,
            'multi_book_games': int(sp.groupby('game_id').book.nunique().ge(2).sum())}


# ------------------------------------------------------------ runs
def context():
    X = D.frame()
    A, _ = D.archive()
    fit, art = KN.load_artifact()
    ch = json.load(open(os.path.join(D.ARTIFACTS, 'challenger_v1.json')))
    dev_close = X[X.fbs_fbs & X.final & X.season.isin(D.DEV) & X.close_margin.notna()]
    sigma_mkt = float(np.std(dev_close.margin - dev_close.close_margin, ddof=1))
    return X, A, fit, ch, sigma_mkt


def walk_w(X, S):
    """the challenger weights for season S from seasons before S (walk-forward)."""
    P = CH.population(X, [s for s in D.DEV if s < S] if S <= max(D.DEV) else list(D.DEV))
    w_o = CH.fit_w(P.ens_pred.values, P.open_margin.values, P.margin.values)
    Pc = P[P.close_margin.notna()]
    w_c = CH.fit_w(Pc.ens_pred.values, Pc.close_margin.values, Pc.margin.values)
    return w_o, w_c


def dev_frame(X, A, fit, sigma_mkt, seasons):
    s7 = stage7_cols()
    frames = []
    for S in seasons:
        w_o, w_c = walk_w(X, S)
        Q = build(X, A, [S], fit, w_o, sigma_mkt, s7)
        Q = attach_close_ev(Q, fit, w_c)
        Q['chal_w_open'], Q['chal_w_close'] = w_o, w_c
        frames.append(Q)
    Q = pd.concat(frames, ignore_index=True).sort_values(['kickoff_ts', 'game_id']).reset_index(drop=True)
    Qx = expected_move(pd.concat([dev_frame_minimal(X, A, fit, sigma_mkt, s7), Q[Q.season > 2016]], ignore_index=True)
                       .drop_duplicates('game_id', keep='last'))
    Q = Q.merge(Qx[['game_id', 'exp_move_toward']], on='game_id', how='left')
    return Q


def dev_frame_minimal(X, A, fit, sigma_mkt, s7):
    """2016 (no frozen sigma): opener, close, gap and side only, for the movement model's training."""
    Q = X[X.fbs_fbs & X.final & X.season.eq(2016) & X.open_ok & X.ens_pred.notna() & X.close_margin.notna()
          & ~X.eval_open_close_jump.fillna(False).astype(bool)].copy()
    Q['gap'] = Q.ens_pred - Q.open_margin
    Q['s'] = np.where(Q.gap >= 0, 1.0, -1.0)
    Q['on_key'] = np.isin(Q.open_margin.abs(), KEYS)
    return Q


def run():
    X, A, fit, ch, sigma_mkt = context()
    Q = dev_frame(X, A, fit, sigma_mkt, [s for s in D.DEV if s >= 2017])
    res = {'sigma_market': D.r(sigma_mkt, 3), 'n_games': int(len(Q)),
           'price_sources_open': Q.price_open_src.value_counts().to_dict(),
           'price_sources_close': Q.price_close_src.value_counts().to_dict(),
           'thresholds': {'GAP_MIN': GAP_MIN, 'P_MIN': P_MIN, 'EV_MIN_PURE': EV_MIN_PURE, 'EV_MIN_MI': EV_MIN_MI, 'REVIEW_GAP': REVIEW_GAP,
                          'R2_P_MIN': R2_P_MIN, 'R2_EV_MIN': R2_EV_MIN},
           'ladder_dev': ladder(Q, 2),
           'ladder_dev_real_prices_2017_2019': ladder(Q[Q.season <= 2019].reset_index(drop=True), 2),
           'ladder_dev_registration_1': ladder(Q, 1),
           'timing_scorecard_dev': timing_scorecard(Q),
           'line_shopping_2016_2019': line_shopping(X, A, fit, sigma_mkt),
           'pinnacle_vs_consensus_close_2013_2019': pinnacle_proxy(X),
           'live_ledger_2026': live_cadence(),
           'challenger_weights_used': {int(s): [D.r(a, 4), D.r(b, 4)] for s, a, b in Q.groupby('season')[['chal_w_open', 'chal_w_close']].first().itertuples()}}
    D.write_json('replay.json', res)
    return res


# ------------------------------------------------------------ holdout
HOLDOUT_FILE = 'holdout.json'


def holdout(rescore=False):
    """The 2024-2025 holdout, scored ONCE with every artifact frozen on DEV."""
    p = os.path.join(D.outdir(), HOLDOUT_FILE)
    if os.path.exists(p) and not rescore:
        prev = json.load(open(p))
        raise SystemExit('the holdout was scored at %s; it is scored once (--rescore only to regenerate the SAME frozen evaluation)' % prev.get('scored_at'))
    X, A, fit, ch, sigma_mkt = context()
    out = {'scored_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'seasons': list(D.HOLDOUT),
           'frozen': {'key_numbers': 'key_numbers_v1.json (%s)' % fit['method'], 'challenger_w': ch['w_pure'],
                      'book_quality': 'book_quality_v1.json', 'thresholds': 'replay.py constants'}}
    # 1. key-number distribution
    H = KN.population(X, D.HOLDOUT)
    F = {'ot': fit['ot'], 'local': fit['mult'], 'global': KN.fit_all(KN.population(X, D.DEV))['global']}
    out['key_numbers'] = KN.score_methods(H, F)
    Hc = H[H.close_margin.notna()]
    out['key_numbers_ladder'] = KN.ladder_summary(KN.ladder_frame(H, F, sigma_mkt))
    out['landing_holdout'] = KN.landing_table(H)
    # 2. challenger at the frozen DEV weight
    Pp = CH.population(X, D.HOLDOUT)
    w = ch['w_pure']
    Pp = Pp.assign(hybrid=Pp.open_margin + w * (Pp.ens_pred - Pp.open_margin))
    bt = D.Boot(len(Pp))
    ae = lambda c: np.abs(Pp.margin - Pp[c]).values
    out['challenger'] = {'n': int(len(Pp)), 'w_pure': w,
                         'mae': {c: D.r(ae(c).mean(), 3) for c in ('ens_pred', 'open_margin', 'hybrid', 'close_margin')},
                         'hybrid_minus_open': D.cell(bt.mean(ae('hybrid') - ae('open_margin')), 3),
                         'pure_minus_open': D.cell(bt.mean(ae('ens_pred') - ae('open_margin')), 3),
                         'w_refit_on_holdout_for_reference': D.r(CH.fit_w(Pp.ens_pred.values, Pp.open_margin.values, Pp.margin.values), 3)}
    # 3. movement toward EdgeDesk
    from . import movement as MV
    Qh = MV.base(X, D.HOLDOUT)
    out['movement_toward'] = MV.gap_and_toward(Qh)
    out['opener_dispersion'] = holdout_dispersion(A, X)
    # 4. ladder at ASSUMED -110 (no holdout prices exist), frozen DEV weights and thresholds
    s7 = stage7_cols()
    Pd = CH.population(X, D.DEV)
    w_o = CH.fit_w(Pd.ens_pred.values, Pd.open_margin.values, Pd.margin.values)
    Pdc = Pd[Pd.close_margin.notna()]
    w_c = CH.fit_w(Pdc.ens_pred.values, Pdc.close_margin.values, Pdc.margin.values)
    Qh2 = build(X, A, list(D.HOLDOUT), fit, w_o, sigma_mkt, s7)
    Qh2 = attach_close_ev(Qh2, fit, w_c)
    dev_all = dev_frame(X, A, fit, sigma_mkt, [s for s in D.DEV if s >= 2017])
    Qx = expected_move(pd.concat([dev_all, Qh2], ignore_index=True), train_cap=max(D.DEV))
    Qh2 = Qh2.merge(Qx[['game_id', 'exp_move_toward']], on='game_id', how='left')
    out['ladder'] = ladder(Qh2, 2)
    out['ladder_registration_1'] = ladder(Qh2, 1)
    out['timing_scorecard'] = timing_scorecard(Qh2)
    # 5. the bias flags that matter most, on the holdout
    from . import bias as BI
    Bq = BI.population(X, D.HOLDOUT)
    main, _ = BI.groups(Bq)
    out['bias'] = [g for g in main if g.get('group') in ('favourite (closing line)', 'P4 side in P4 vs G5', 'road team (non-neutral)',
                                                          'favourite laying 0.5-7', 'national brand side (pre-registered list) vs a non-brand',
                                                          'favourite laying 21.5+ (huge spreads)')]
    D.write_json(HOLDOUT_FILE, out)
    return out


def holdout_dispersion(A, X):
    S = A[(A.market_type == 'spread') & (A.kind == 'OPEN') & A.is_book & A.season.isin(D.HOLDOUT)]
    g = S.groupby('game_id').home_margin.agg(['size', 'min', 'max', 'median']).reset_index()
    g = g[g['size'] >= 2]
    g['open_range'] = g['max'] - g['min']
    J = g.merge(X[['game_id', 'fbs_fbs', 'final', 'close_margin']], on='game_id')
    J = J[J.fbs_fbs & J.final & J.close_margin.notna()].reset_index(drop=True)
    J['abs_move'] = (J.close_margin - J['median']).abs()
    bt = D.Boot(len(J))
    rows = []
    for lo, hi, lab in ((0, 0.001, 'books agree'), (0.001, 1.001, '0.5-1 pt apart'), (1.001, 99, '>1 pt apart')):
        m = ((J.open_range >= lo) & (J.open_range < hi)).values
        rows.append({'opener_range': lab, 'n': int(m.sum()), 'mean_abs_move_to_close': D.cell(bt.mean(J.abs_move.values, mask=m), 3)})
    return {'n': int(len(J)), 'rows': rows}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--holdout', action='store_true')
    ap.add_argument('--rescore', action='store_true')
    a = ap.parse_args()
    if a.holdout:
        h = holdout(a.rescore)
        print('holdout scored at', h['scored_at'])
    else:
        r = run()
        print('replay: %d games; ladder arms %d' % (r['n_games'], len(r['ladder_dev'])))
