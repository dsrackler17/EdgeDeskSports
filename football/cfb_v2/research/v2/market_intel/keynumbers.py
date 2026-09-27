"""Key numbers, the value of each half point, the price-vs-point tradeoff and
alternate-spread fair pricing (brief sections 23-26; docs/cfb-market/METHODS.md).

    python3 -m v2.market_intel.keynumbers            DEV tables + the frozen key-number artifact
    (the 2024-2025 holdout check of the artifact runs from replay --holdout, once)

Population: FBS-vs-FBS completed games. DEV = 2016-2023; 2009-2015 is shown
only as an era comparison. Every rate has n and a game-level bootstrap CI.

The KEY-NUMBER DISTRIBUTION used for alternate lines and half points starts
from the frozen pure model's Student t (mean = the pure margin, the frozen
sigma and df) DISCRETISED to integer margins, then:
  1. the tie mass P(0) (college football has no ties) is sent to the margins
     overtime games actually end on (the DEV overtime |margin| distribution);
  2. LOCAL key-number redistribution: bin k gains Delta_k = (r_|k| - 1) P(k),
     paid by the integers within three points of it (triangular shares 3:2:1,
     half on each side; an inner payer below 1 is replaced by the outer one),
     so the CDF more than three points from a key number is the t's own and
     the mean is (all but) preserved; r_|k| is fit on DEV by ridge-regularised
     least squares on the pooled landing counts at every |k| <= 35.
A GLOBAL multiplicative reweighting (renormalised) is kept as the rejected
alternative: it matches the landing counts too, but it moves cover
probabilities between key numbers (docs/cfb-market/METHODS.md). The mean and
the width stay the pure model's; the market never enters them.
"""
import argparse
import math

import numpy as np
import pandas as pd
from scipy import stats as sst

from ..decision import core
from . import data as D

KMAX = 120                      # integer support [-KMAX, KMAX]; the tails are lumped into the end bins
KEY_FIT_MAX = 35                # individual multipliers for |k| <= 35, one pooled multiplier beyond
PSEUDO = 10.0                   # pseudo-count (expected games) shrinking each multiplier toward 1
REPORT_K = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 17, 18, 20, 21, 24, 27, 28, 31, 35]
ARTIFACT = 'key_numbers_v1.json'


# ------------------------------------------------------------ distribution
def pmf_t(mu, sigma, df, kmax=KMAX):
    """P(margin == k), k = -kmax..kmax, from the standardized t discretised at
    k +/- 0.5 (tails lumped into the end bins). mu, sigma, df: arrays (n,)."""
    mu = np.atleast_1d(np.asarray(mu, float))[:, None]
    sigma = np.atleast_1d(np.asarray(sigma, float))[:, None]
    df = np.broadcast_to(np.atleast_1d(np.asarray(df, float)), mu.shape[:1])[:, None]
    ks = np.arange(-kmax, kmax + 1)
    edges = np.concatenate([ks - 0.5, [kmax + 0.5]])[None, :]
    F = core.t_cdf_std((edges - mu) / sigma, df)
    P = np.diff(F, axis=1)
    P[:, 0] += F[:, 0]
    P[:, -1] += 1.0 - F[:, -1]
    return P


def reweight(P, mult, kmax=KMAX):
    """GLOBAL (rejected) method: |k| multipliers, then renormalise each row."""
    ks = np.abs(np.arange(-kmax, kmax + 1))
    W = P * mult[ks][None, :]
    return W / W.sum(axis=1, keepdims=True)


def fit_multipliers(P, margins, kmax=KMAX, fit_max=KEY_FIT_MAX, pseudo=PSEUDO, iters=25):
    """GLOBAL method fit by IPF: r_|k| such that sum_g P'_g(|k|) == #games
    landing on |k| (pooled beyond fit_max; r_0 = 0 because there are no ties)."""
    ks = np.abs(np.arange(-kmax, kmax + 1))
    am = np.abs(np.asarray(margins, int))
    obs = np.bincount(np.minimum(am, kmax), minlength=kmax + 1).astype(float)
    mult = np.ones(kmax + 1)
    mult[0] = 0.0
    for _ in range(iters):
        Pw = reweight(P, mult, kmax)
        exp = np.bincount(ks, weights=Pw.sum(axis=0), minlength=kmax + 1)
        new = mult.copy()
        for k in range(1, fit_max + 1):
            new[k] = mult[k] * (obs[k] + pseudo) / (exp[k] + pseudo)
        tail_o, tail_e = obs[fit_max + 1:].sum(), exp[fit_max + 1:].sum()
        new[fit_max + 1:] = mult[fit_max + 1:] * (tail_o + pseudo) / (tail_e + pseudo)
        if np.max(np.abs(new - mult)) < 1e-7:
            mult = new
            break
        mult = new
    return mult


def ot_distribution(margins_ot, kmax=KMAX):
    """P(|margin| == k | the game went to overtime), k = 0..kmax (0 has no mass)."""
    am = np.minimum(np.abs(np.asarray(margins_ot, int)), kmax)
    c = np.bincount(am, minlength=kmax + 1).astype(float)
    c[0] = 0.0
    return c / c.sum()


def untie(P, ot, kmax=KMAX):
    """send the discretised t's tie mass P(0) to the overtime margins, half to each sign."""
    P = P.copy()
    c = kmax
    m0 = P[:, c].copy()
    P[:, c] = 0.0
    P[:, c + 1:] += m0[:, None] * ot[None, 1:] / 2.0
    P[:, :c] += m0[:, None] * ot[None, 1:][:, ::-1] / 2.0
    return P


KERNEL = (3.0 / 6, 2.0 / 6, 1.0 / 6)   # share of Delta_k taken at distance 1, 2, 3 (half each side; pre-set)


def _payers(k, kmax=KMAX, kernel=KERNEL):
    """(bin, share) pairs that pay for bin |k|'s gain: distance d on each side
    with share kernel[d-1] / 2; an inner bin below 1 (no ties) is replaced by
    the outer bin at the same distance."""
    out = []
    for d, w in enumerate(kernel, start=1):
        lo, hi = k - d, k + d
        if lo >= 1:
            out.append((lo, w / 2.0))
            if hi <= kmax:
                out.append((hi, w / 2.0))
        elif hi <= kmax:
            out.append((hi, w))
    return out


def local_adjust(P, mult, kmax=KMAX, kernel=KERNEL):
    """LOCAL key-number redistribution of an untied pmf (module docstring):
    bin |k| gains Delta_k = (r_|k| - 1) P(k), paid by the integers within
    three points (triangular shares), on the same side of zero."""
    c = kmax
    out = P.copy()
    for sgn in (1, -1):
        idx = c + sgn * np.arange(1, kmax + 1)             # column j <-> |k| = j + 1
        Q = P[:, idx]
        dl = (mult[1:kmax + 1][None, :] - 1.0) * Q
        R = Q + dl
        for j in range(kmax):
            if not np.any(dl[:, j]):
                continue
            for b, w in _payers(j + 1, kmax, kernel):
                R[:, b - 1] -= w * dl[:, j]
        out[:, idx] = R
    out = np.clip(out, 0.0, None)
    return out / out.sum(axis=1, keepdims=True)


RIDGE = 0.01                    # Tikhonov weight on sum_k E_k (r_k - 1)^2 (pre-set, not tuned)


def fit_local(P, margins, fit_max=KEY_FIT_MAX, ridge=RIDGE, kmax=KMAX, iters=8):
    """r_|k| (|k| <= fit_max; 1 beyond) for the LOCAL method by regularised
    least squares on the pooled landing counts:

        minimise  sum_k (O_k - E'_k)^2 / O_k  +  ridge * sum_k E_k (r_k - 1)^2

    E'_k is linear in (r - 1) through the redistribution operator A (bin k
    gains, the integers within three points pay), which is Laplacian-like and
    nearly singular for smooth patterns: the exact solve blows up (with a +/-1
    kernel it gave r ~ 20 across 1..14), so the ridge is required, not cosmetic. Refined by a few fixed-point steps for the
    clipping at zero."""
    ks = np.abs(np.arange(-kmax, kmax + 1))
    am = np.minimum(np.abs(np.asarray(margins, int)), kmax)
    obs = np.bincount(am, minlength=kmax + 1).astype(float)
    E = np.bincount(ks, weights=P.sum(axis=0), minlength=kmax + 1)
    K = fit_max
    A = np.zeros((K, K))
    for k in range(1, K + 1):
        A[k - 1, k - 1] += 1.0
        for b, w in _payers(k, kmax):
            if b <= K:
                A[b - 1, k - 1] -= w
    Ek = E[1:K + 1]
    M = A * Ek[None, :]                                   # effect of y = r - 1 on the pooled counts
    Wd = np.diag(1.0 / np.maximum(obs[1:K + 1], 1.0))
    H = M.T @ Wd @ M + ridge * np.diag(Ek)
    mult = np.ones(kmax + 1)
    mult[0] = 0.0
    y = np.linalg.solve(H, M.T @ Wd @ (obs[1:K + 1] - Ek))
    mult[1:K + 1] = np.maximum(0.0, 1.0 + y)
    for _ in range(iters):
        El = np.bincount(ks, weights=local_adjust(P, mult, kmax).sum(axis=0), minlength=kmax + 1)
        g = M.T @ Wd @ (obs[1:K + 1] - El[1:K + 1]) - ridge * Ek * (mult[1:K + 1] - 1.0)
        dy = np.linalg.solve(H, g)
        mult[1:K + 1] = np.maximum(0.0, mult[1:K + 1] + dy)
        if np.max(np.abs(dy)) < 1e-6:
            break
    return mult


def fit_report(P, mult, method, ot, margins, kmax=KMAX, upto=21):
    """pooled expected vs observed landing counts under a fitted method."""
    ks = np.abs(np.arange(-kmax, kmax + 1))
    Pm = local_adjust(untie(P, ot), mult) if method == 'local' else reweight(P, mult)
    E = np.bincount(ks, weights=Pm.sum(axis=0), minlength=kmax + 1)
    O = np.bincount(np.minimum(np.abs(np.asarray(margins, int)), kmax), minlength=kmax + 1)
    return [{'k': k, 'observed': int(O[k]), 'expected': D.r(E[k], 1)} for k in range(1, upto + 1)]


def key_pmf(mu, sigma, df, mult, ot, method='local', kmax=KMAX):
    """the key-number distribution of integer home margins for each row."""
    Pt = pmf_t(mu, sigma, df, kmax)
    if method == 't':
        return Pt
    Pu = untie(Pt, ot, kmax)
    if method == 't_untied':
        return Pu
    if method == 'global':
        return reweight(Pt, mult, kmax)
    return local_adjust(Pu, mult, kmax)


def outcome_probs(Prow, home_line_margin, kmax=KMAX):
    """P(home win), P(push), P(home loss) at an internal line L (home covers when margin > L)."""
    ks = np.arange(-kmax, kmax + 1)
    L = float(home_line_margin)
    w = Prow[ks > L + 1e-9].sum()
    p = Prow[np.isclose(ks, L)].sum()
    return w, p, 1.0 - w - p


def ev(win, push, loss, american):
    b = core.american_to_payout(american)
    return win * b - loss


def price_for_ev(win, push, loss, target):
    """the American price at which EV == target (None if none exists)."""
    if win <= 0:
        return None
    b = (target + loss) / win
    return payout_to_american(b)


def payout_to_american(b):
    if b is None or not np.isfinite(b) or b <= 0:
        return None
    return float(100 * b) if b >= 1 else float(-100 / b)


def fair_american(win, loss):
    """no-vig price of a side: EV = 0 with the push returning the stake."""
    return payout_to_american(loss / win) if win > 0 else None


# --------------------------------------------------------------- tables
def population(X, seasons):
    P = X[X.fbs_fbs & X.final & X.season.isin(seasons)].copy()
    P['abs_m'] = P.margin.abs().astype(int)
    fav = np.sign(P.close_margin.where(P.close_margin.notna() & (P.close_margin != 0)))
    P['fav_sign'] = fav
    P['fav_margin'] = P.margin * fav                     # margin from the market favourite's side
    P['fav_line'] = P.close_margin.abs()
    return P.reset_index(drop=True)


def landing_table(P, ks=REPORT_K, B=D.BOOT_B):
    bt = D.Boot(len(P), B=B)
    am = P.abs_m.values
    out = []
    for k in ks:
        out.append(dict(k=k, **D.cell(bt.mean((am == k).astype(float)))))
    top = pd.Series(am).value_counts(normalize=True).head(20)
    return {'abs_margin': out, 'top20': [{'k': int(k), 'share': D.r(v)} for k, v in top.items()], 'n': int(len(P)),
            'no_ties': int((am == 0).sum()) == 0}


def fav_landing_table(P, B=D.BOOT_B):
    Q = P[P.fav_sign.notna()].reset_index(drop=True)
    bt = D.Boot(len(Q), B=B)
    fm = Q.fav_margin.values
    rows = []
    for k in [3, 7, 10, 14, 17, 21, 24, 28, 1, 2, 4, 5, 6, 8]:
        rows.append({'k': k, 'favorite_wins_by': D.cell(bt.mean((fm == k).astype(float))),
                     'underdog_wins_by': D.cell(bt.mean((fm == -k).astype(float)))})
    return {'n': int(len(Q)), 'rows': rows, 'favorite_win_rate': D.cell(bt.mean((fm > 0).astype(float)))}


def heterogeneity(P, B=D.BOOT_B):
    """landing on 3, 7, 10, 14 by favourite size, expected total, overtime rules and era."""
    keys = [3, 7, 10, 14]
    groups = {
        'favorite_size (|closing line|)': [('<=3', P.fav_line <= 3), ('3.5-7', (P.fav_line > 3) & (P.fav_line <= 7)),
                                           ('7.5-14', (P.fav_line > 7) & (P.fav_line <= 14)),
                                           ('14.5-21', (P.fav_line > 14) & (P.fav_line <= 21)), ('>21', P.fav_line > 21)],
        'expected_total (closing total)': [('<45', P.total_close < 45), ('45-51.5', (P.total_close >= 45) & (P.total_close < 52)),
                                           ('52-58.5', (P.total_close >= 52) & (P.total_close < 59)),
                                           ('59-65.5', (P.total_close >= 59) & (P.total_close < 66)), ('>=66', P.total_close >= 66)],
        'overtime_rules (season)': [('2016-2018 (old OT)', P.season.between(2016, 2018)),
                                    ('2019-2020 (2-pt from 5th OT)', P.season.between(2019, 2020)),
                                    ('2021-2023 (2-pt from 3rd OT)', P.season.between(2021, 2023))],
        'game_went_to_overtime': [('regulation', P.overtime.eq(False)), ('overtime', P.overtime.eq(True))],
        'era': [('2009-2015', P.season.between(2009, 2015)), ('2016-2023 (DEV)', P.season.between(2016, 2023))],
    }
    bt = D.Boot(len(P), B=B)
    out = {}
    for gname, cells in groups.items():
        rows = []
        tab = []
        for label, m in cells:
            m = np.asarray(m.fillna(False) if hasattr(m, 'fillna') else m, bool)
            row = {'group': label, 'n': int(m.sum())}
            for k in keys:
                row['p%d' % k] = D.cell(bt.mean((P.abs_m.values == k).astype(float), mask=m))
            rows.append(row)
            tab.append([int(((P.abs_m.values == k) & m).sum()) for k in keys] + [int((~np.isin(P.abs_m.values, keys) & m).sum())])
        tab = np.array(tab)
        tab = tab[tab.sum(axis=1) > 0]
        chi = sst.chi2_contingency(tab)
        out[gname] = {'rows': rows, 'chi2_homogeneity_p': D.r(chi[1], 5), 'chi2_df': int(chi[2])}
    return out


def push_by_line(P, fit, B=D.BOOT_B):
    """P(favourite margin == |closing line|) at integer closing lines, against
    the pure t's continuity mass and the frozen key-number distribution."""
    Q = P[P.fav_sign.notna() & np.isclose(P.fav_line, np.round(P.fav_line)) & P.sigma.notna()].reset_index(drop=True)
    bt = D.Boot(len(Q), B=B)
    Pt = pmf_t(Q.ens_pred.values, Q.sigma.values, Q.t_df.values)
    Pk = key_pmf(Q.ens_pred.values, Q.sigma.values, Q.t_df.values, fit['mult'], fit['ot'], fit['method'])
    ks = np.arange(-KMAX, KMAX + 1)
    idx = np.searchsorted(ks, np.round(Q.close_margin.values).astype(int))
    rr = np.arange(len(Q))
    pt, pk = Pt[rr, idx], Pk[rr, idx]
    push = (Q.margin.values == Q.close_margin.values).astype(float)
    rows = []
    for L in list(range(1, 22)) + [24, 28]:
        m = Q.fav_line.values == L
        if m.sum() < 1:
            continue
        rows.append({'line': L, 'empirical': D.cell(bt.mean(push, mask=m)),
                     'pure_t_mass': D.r(pt[m].mean()), 'key_distribution': D.r(pk[m].mean())})
    return {'n_integer_lines': int(len(Q)), 'rows': rows,
            'note': 'in-sample (the key distribution was fit on these seasons); the out-of-sample check is dev_walkforward and the holdout'}


def local_landing(P, B=D.BOOT_B, window=1.0):
    """q_k: P(favourite margin == k) among games whose closing line is within
    `window` points of k (the half-point value's empirical ingredient)."""
    Q = P[P.fav_sign.notna()].reset_index(drop=True)
    bt = D.Boot(len(Q), B=B)
    fm = Q.fav_margin.values
    rows = []
    for k in list(range(1, 22)) + [24, 28]:
        m = np.abs(Q.fav_line.values - k) <= window
        rows.append({'k': k, 'q': D.cell(bt.mean((fm == k).astype(float), mask=m))})
    return {'window_pts': window, 'rows': rows}


def half_point_table(fit, sigma_by_line, df=100):
    """The value of each half point for the FAVOURITE and the UNDERDOG at a
    market-centred distribution (mean = the line, sigma = the typical frozen
    sigma of games near that line), exact EV math at -110:
      * the probability mass that changes class when the number moves half a
        point (the landing mass on the integer inside the step),
      * the EV change per unit at -110,
      * the equivalent price: the price at the WORSE number with the same EV as
        -110 at the better number; `cents` = its distance from -110 on the
        continuous ladder (-110 -> -10, -100/+100 -> 0, +105 -> +5), i.e. how
        many cents the half point is worth."""
    ks = np.arange(-KMAX, KMAX + 1)
    rows = []
    for L2 in range(1, 57):
        L = L2 / 2.0                                              # the favourite lays L (0.5 .. 28)
        sg = float(np.interp(L, sigma_by_line[0], sigma_by_line[1]))
        Pk = key_pmf([L], [sg], [df], fit['mult'], fit['ot'], fit['method'])[0]
        mass = lambda k: float(Pk[ks == int(round(k))].sum())
        w0, p0, l0 = outcome_probs(Pk, L)                          # favourite -L (home = favourite)
        w1, p1, l1 = outcome_probs(Pk, L + 0.5)                    # favourite -(L + 0.5)
        kf = L if abs(L - round(L)) < 1e-9 else L + 0.5
        evb = ev(w0, p0, l0, -110)
        eq = price_for_ev(w1, p1, l1, evb)
        w2, p2, l2 = outcome_probs(Pk, L - 0.5)
        dw0, dp0, dl0 = l0, p0, w0                                 # underdog +L
        dw1, dp1, dl1 = l2, p2, w2                                 # underdog +(L - 0.5)
        kd = L if abs(L - round(L)) < 1e-9 else L - 0.5
        devb = ev(dw0, dp0, dl0, -110)
        deq = price_for_ev(dw1, dp1, dl1, devb)
        rows.append({'line': L, 'sigma': D.r(sg, 2), 'p_push_at_line': D.r(p0),
                     'fav_step': '-%g -> -%g' % (L, L + 0.5), 'fav_integer': int(round(kf)), 'fav_mass_changed': D.r(mass(kf)),
                     'fav_ev_change_at_-110': D.r(evb - ev(w1, p1, l1, -110)),
                     'fav_equivalent_price': D.r(eq, 1), 'fav_cents': D.r(cents(eq), 1),
                     'dog_step': '+%g -> +%g' % (L, L - 0.5), 'dog_integer': int(round(kd)),
                     'dog_mass_changed': D.r(mass(kd)) if kd > 0 else 0.0,
                     'dog_ev_change_at_-110': D.r(devb - ev(dw1, dp1, dl1, -110)),
                     'dog_equivalent_price': D.r(deq, 1), 'dog_cents': D.r(cents(deq), 1)})
    return rows


def cents(american, ref=-110):
    """how many cents better than `ref` a price is, on the continuous ladder
    (-110 -> -10, -100/+100 -> 0, +105 -> +5): +15 = 15 cents better."""
    if american is None:
        return None
    return _ladder(float(american)) - _ladder(ref)


def _ladder(a):
    return a + 100 if a < 0 else a - 100


def alt_ladder_example(fit, mu=6.2, sigma=16.0, df=100, lines=None):
    """EdgeDesk's fair price for each alternate line from ONE distribution
    (home favoured by mu), against the plain t."""
    lines = lines or [x / 2.0 for x in range(-24, -1)]           # home laying 12 .. 1
    Pk = key_pmf([mu], [sigma], [df], fit['mult'], fit['ot'], fit['method'])[0]
    Pt = pmf_t([mu], [sigma], [df])[0]
    rows = []
    for hl in lines:
        L = -hl
        w, p, l = outcome_probs(Pk, L)
        wt, pt, lt = outcome_probs(Pt, L)
        rows.append({'home_line': hl, 'p_win': D.r(w), 'p_push': D.r(p), 'p_loss': D.r(l),
                     'p_cover_no_push': D.r(w / (w + l)), 'plain_t_cover_no_push': D.r(wt / (wt + lt)),
                     'fair_price': D.r(fair_american(w, l), 1), 'ev_at_-110': D.r(ev(w, p, l, -110))})
    return {'pure_margin': mu, 'sigma': sigma, 'df': df, 'method': fit['method'], 'rows': rows}


def market_half_point_prices(A, X):
    """How BOOKS price a half point: at the close (2016-2019, real prices), for
    each game the books that hang the favourite at two numbers half a point apart
    across integer k: 2 x (difference in no-vig favourite cover probability)
    estimates the landing mass the market prices on k."""
    S = A[(A.market_type == 'spread') & (A.kind == 'CLOSE') & A.is_book & A.season.isin([s for s in D.DEV if s <= 2019])
          & A.price_home.notna() & A.price_away.notna()].copy()
    S = S.merge(X[['game_id', 'fbs_fbs', 'close_margin']], on='game_id')
    S = S[S.fbs_fbs & S.close_margin.notna() & (S.close_margin != 0)]
    fav_home = S.close_margin > 0
    S['fav_line'] = np.where(fav_home, S.home_margin, -S.home_margin)       # the favourite's number (lays it)
    qh, qa = core.break_even(S.price_home.values), core.break_even(S.price_away.values)
    ph = qh / (qh + qa)
    S['p_fav'] = np.where(fav_home, ph, 1 - ph)                              # no-vig P(fav covers | no push)
    g = S.groupby(['game_id', 'fav_line']).p_fav.mean().reset_index()
    recs = []
    for gid, gg in g.groupby('game_id'):
        d = dict(zip(gg.fav_line, gg.p_fav))
        for L, p in d.items():
            L2 = L + 0.5
            if L2 in d:
                k = L if abs(L - round(L)) < 1e-9 else L2              # the integer inside the step
                recs.append((gid, int(round(k)), 2.0 * (p - d[L2])))
    R = pd.DataFrame(recs, columns=['game_id', 'k', 'q_market'])
    rows = []
    for k in range(1, 22):
        v = R[R.k == k].q_market.values
        if len(v) < 5:
            continue
        bt = D.Boot(len(v))
        rows.append({'k': k, 'n_pairs': int(len(v)), 'market_implied_q': D.cell(bt.mean(v))})
    return {'rows': rows, 'n_quotes': int(len(S)), 'seasons': '2016-2019 closes (the only DEV seasons with prices)',
            'note': 'a pair = one game where books hang the favourite at L and L + 0.5; 2 x the no-vig probability difference estimates the landing mass the books price on the integer'}


def totals_table(P, B=D.BOOT_B):
    Q = P[P.total_pts.notna()].reset_index(drop=True)
    bt = D.Boot(len(Q), B=B)
    tp = Q.total_pts.values.astype(int)
    top = pd.Series(tp).value_counts(normalize=True).head(15)
    rows = [{'total': int(k), **D.cell(bt.mean((tp == k).astype(float)))} for k in top.index]
    I = Q[Q.total_close.notna() & np.isclose(Q.total_close, np.round(Q.total_close))].reset_index(drop=True)
    bi = D.Boot(len(I), B=B)
    push = (I.total_pts.values == I.total_close.values).astype(float)
    return {'n': int(len(Q)), 'most_common_totals': rows,
            'push_rate_at_integer_total_lines': D.cell(bi.mean(push)),
            'max_single_total_share': D.r(top.iloc[0]),
            'reading': 'totals have no dominant key number: the most common final total carries under 4% of games'}


# ------------------------------------------------------- fit and validate
METHODS = ('t', 't_untied', 'global', 'local')


def fit_all(P):
    """fit the tie map and both key-number methods on population P (sigma present)."""
    P = P[P.sigma.notna()]
    Pt = pmf_t(P.ens_pred.values, P.sigma.values, P.t_df.values)
    ot = ot_distribution(P.margin[P.overtime.eq(True)].values)
    Pu = untie(Pt, ot)
    mg = fit_multipliers(Pt, P.margin.values.astype(int))
    ml = fit_local(Pu, P.margin.values.astype(int))
    return {'ot': ot, 'global': mg, 'local': ml, 'n': int(len(P)), 'n_ot': int(P.overtime.eq(True).sum()),
            'fit_local': fit_report(Pt, ml, 'local', ot, P.margin.values),
            'fit_global': fit_report(Pt, mg, 'global', ot, P.margin.values)}


def score_methods(te, F):
    """out-of-sample scores of each distribution on test games `te`:
      * log-likelihood of the observed integer margin,
      * log loss of COVER | no push at the closing line (half-point and integer),
      * log loss of PUSH at integer closing lines."""
    te = te[te.sigma.notna() & te.close_margin.notna()].reset_index(drop=True)
    ks = np.arange(-KMAX, KMAX + 1)
    rr = np.arange(len(te))
    mi = np.searchsorted(ks, np.clip(te.margin.values.astype(int), -KMAX, KMAX))
    L = te.close_margin.values
    integer = np.isclose(L, np.round(L))
    li = np.searchsorted(ks, np.round(L).astype(int))
    nonpush = te.margin.values != L
    ycov = (te.margin.values > L).astype(float)
    ypush = (te.margin.values == L).astype(float)
    bt = D.Boot(len(te))
    out, per = {}, {}
    for m in METHODS:
        mult = F['local'] if m == 'local' else F['global']
        P = key_pmf(te.ens_pred.values, te.sigma.values, te.t_df.values, mult, F['ot'], m)
        ll = np.log(np.clip(P[rr, mi], 1e-12, 1))
        above = (ks[None, :] > L[:, None] + 1e-9)
        pw = (P * above).sum(axis=1)
        pp = np.where(integer, P[rr, li], 0.0)
        pc = np.clip(pw / np.maximum(1 - pp, 1e-9), 1e-6, 1 - 1e-6)
        lc = -(ycov * np.log(pc) + (1 - ycov) * np.log(1 - pc))
        pq = np.clip(pp, 1e-6, 1 - 1e-6)
        lp = -(ypush * np.log(pq) + (1 - ypush) * np.log(1 - pq))
        per[m] = {'ll': ll, 'lc': lc, 'lp': lp, 'pc': pc, 'pp': pp}
        out[m] = {'mean_loglik_margin': D.r(ll.mean()),
                  'cover_logloss': D.r(lc[nonpush].mean()), 'cover_pred_mean': D.r(pc[nonpush].mean()),
                  'push_logloss_integer_lines': D.r(lp[integer].mean()), 'push_pred_integer_lines': D.r(pp[integer].mean())}
    out['observed'] = {'cover_rate': D.r(ycov[nonpush].mean()), 'push_rate_integer_lines': D.r(ypush[integer].mean()),
                       'n': int(len(te)), 'n_nonpush': int(nonpush.sum()), 'n_integer_lines': int(integer.sum())}
    comp = {}
    for m in ('global', 'local', 't_untied'):
        comp[m + '_minus_t'] = {
            'loglik_margin_gain': D.cell(bt.mean(per[m]['ll'] - per['t']['ll'])),
            'cover_logloss_change': D.cell(bt.mean(per[m]['lc'] - per['t']['lc'], mask=nonpush), 5),
            'push_logloss_change': D.cell(bt.mean(per[m]['lp'] - per['t']['lp'], mask=integer), 5)}
    comp['cover_prob_shift_vs_t'] = {m: D.r(np.mean(np.abs(per[m]['pc'] - per['t']['pc'])[nonpush]), 5) for m in ('global', 'local')}
    out['paired'] = comp
    return out


LADDER = (-3.0, -2.5, -2.0, -1.5, -1.0, -0.5, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0)


def ladder_frame(te, F, sigma_mc, df=100):
    """ALTERNATE-LINE calibration, market-centred: mean = the closing line C,
    sigma = the DEV-training SD of (margin - C). For each offset d, the line
    C + d is an alternate line; score P(home covers | no push) at it against
    the result. This is exactly what alternate-line pricing and half-point
    values need: the cover probability AWAY from the centre."""
    te = te[te.close_margin.notna()].reset_index(drop=True)
    ks = np.arange(-KMAX, KMAX + 1)
    C = te.close_margin.values
    rows = []
    mats = {}
    for m in METHODS:
        mult = F['local'] if m == 'local' else F['global']
        mats[m] = key_pmf(C, np.full(len(te), sigma_mc), np.full(len(te), df), mult, F['ot'], m)
    for d in LADDER:
        L = C + d
        integer = np.isclose(L, np.round(L))
        li = np.searchsorted(ks, np.round(L).astype(int))
        y = (te.margin.values > L).astype(float)
        nonpush = te.margin.values != L
        rec = {'d': np.full(len(te), d), 'nonpush': nonpush, 'y': y, 'g': np.arange(len(te))}
        for m in METHODS:
            P = mats[m]
            pw = (P * (ks[None, :] > L[:, None] + 1e-9)).sum(axis=1)
            pp = np.where(integer, P[np.arange(len(te)), li], 0.0)
            pc = np.clip(pw / np.maximum(1 - pp, 1e-9), 1e-6, 1 - 1e-6)
            rec['p_' + m] = pc
            rec['l_' + m] = -(y * np.log(pc) + (1 - y) * np.log(1 - pc))
        rows.append(pd.DataFrame(rec))
    Z = pd.concat(rows, ignore_index=True)
    return Z[Z.nonpush].reset_index(drop=True)


def ladder_summary(Z):
    """pooled ladder log loss per method, paired vs the plain t (bootstrap by game)."""
    g = Z.groupby('g')
    G = g[[c for c in Z.columns if c.startswith('l_')]].sum()
    n_obs = g.size().values
    bt = D.Boot(len(G))
    out = {'n_games': int(len(G)), 'n_line_outcomes': int(len(Z))}
    for m in METHODS:
        out[m] = D.r(Z['l_' + m].mean(), 5)
    for m in ('t_untied', 'global', 'local'):
        out[m + '_minus_t'] = D.cell(bt.ratio((G['l_' + m] - G['l_t']).values, n_obs.astype(float)), 5)
    cal = []
    for d in LADDER:
        z = Z[Z.d == d]
        cal.append({'d': d, 'n': int(len(z)), 'observed': D.r(z.y.mean()), **{m: D.r(z['p_' + m].mean()) for m in METHODS}})
    out['by_offset'] = cal
    return out


def dev_walkforward(X):
    """INSIDE DEV: fit on 2017..S-1, score S, S = 2019..2023; pooled scores."""
    rows = []
    pooled = []
    ladders = []
    for S in range(2019, 2024):
        tr = population(X, list(range(2017, S)))
        F = fit_all(tr)
        te = population(X, [S])
        sc = score_methods(te, F)
        rows.append({'season': S, 'n': sc['observed']['n'], 'local_cover_logloss_change': sc['paired']['local_minus_t']['cover_logloss_change'],
                     'global_cover_logloss_change': sc['paired']['global_minus_t']['cover_logloss_change'],
                     'local_loglik_gain': sc['paired']['local_minus_t']['loglik_margin_gain'],
                     'local_push_logloss_change': sc['paired']['local_minus_t']['push_logloss_change']})
        pooled.append((te, F))
        trc = tr[tr.close_margin.notna()]
        smc = float(np.std(trc.margin - trc.close_margin, ddof=1))
        Z = ladder_frame(te, F, smc)
        Z['g'] = Z.g.astype(str) + '_' + str(S)
        ladders.append(Z)
    return {'by_season': rows, 'pooled': pooled_scores(pooled), 'ladder': ladder_summary(pd.concat(ladders, ignore_index=True))}


def pooled_scores(pairs):
    """concatenate per-season out-of-sample scores (each season with its own fit)."""
    frames = []
    for te, F in pairs:
        frames.append(_per_game(te, F))
    Z = pd.concat(frames, ignore_index=True)
    bt = D.Boot(len(Z))
    out = {'n': int(len(Z)), 'n_nonpush': int(Z.nonpush.sum()), 'n_integer_lines': int(Z.integer.sum())}
    for m in METHODS:
        out[m] = {'cover_logloss': D.r(Z['lc_' + m][Z.nonpush].mean(), 5), 'push_logloss': D.r(Z['lp_' + m][Z.integer].mean(), 5),
                  'loglik_margin': D.r(Z['ll_' + m].mean(), 5)}
    out['cover_prob_shift_vs_t'] = {m: D.r(np.mean(np.abs(Z['pc_' + m] - Z['pc_t'])[Z.nonpush]), 5) for m in ('global', 'local', 't_untied')}
    for m in ('global', 'local', 't_untied'):
        out[m + '_minus_t'] = {'cover_logloss_change': D.cell(bt.mean(Z['lc_' + m] - Z['lc_t'], mask=Z.nonpush.values), 5),
                               'push_logloss_change': D.cell(bt.mean(Z['lp_' + m] - Z['lp_t'], mask=Z.integer.values), 5),
                               'loglik_margin_gain': D.cell(bt.mean(Z['ll_' + m] - Z['ll_t']), 4)}
    return out


def _per_game(te, F):
    te = te[te.sigma.notna() & te.close_margin.notna()].reset_index(drop=True)
    ks = np.arange(-KMAX, KMAX + 1)
    rr = np.arange(len(te))
    mi = np.searchsorted(ks, np.clip(te.margin.values.astype(int), -KMAX, KMAX))
    L = te.close_margin.values
    integer = np.isclose(L, np.round(L))
    li = np.searchsorted(ks, np.round(L).astype(int))
    ycov = (te.margin.values > L).astype(float)
    ypush = (te.margin.values == L).astype(float)
    Z = pd.DataFrame({'nonpush': te.margin.values != L, 'integer': integer})
    for m in METHODS:
        mult = F['local'] if m == 'local' else F['global']
        P = key_pmf(te.ens_pred.values, te.sigma.values, te.t_df.values, mult, F['ot'], m)
        Z['ll_' + m] = np.log(np.clip(P[rr, mi], 1e-12, 1))
        pw = (P * (ks[None, :] > L[:, None] + 1e-9)).sum(axis=1)
        pp = np.where(integer, P[rr, li], 0.0)
        pc = np.clip(pw / np.maximum(1 - pp, 1e-9), 1e-6, 1 - 1e-6)
        Z['pc_' + m] = pc
        Z['lc_' + m] = -(ycov * np.log(pc) + (1 - ycov) * np.log(1 - pc))
        pq = np.clip(pp, 1e-6, 1 - 1e-6)
        Z['lp_' + m] = -(ypush * np.log(pq) + (1 - ypush) * np.log(1 - pq))
    return Z


def choose_method(wf):
    """Selection rule (DEV walk-forward only; the holdout is never read):
    a key-number method is eligible when it (a) improves the push log loss at
    integer closing lines (point estimate < 0) and (b) does not worsen the
    ALTERNATE-LINE ladder log loss against the plain t (CI not entirely above
    zero). Among eligible methods the lowest pooled ladder log loss wins,
    because alternate-line prices and half-point values are cover
    probabilities AWAY from the centre. No eligible method: the plain t with
    the tie mass sent to overtime margins. (A first version of this rule
    chose by the smallest shift of the cover probability at the closing line;
    it was replaced after it selected a degenerate +/-1-kernel fit, before the
    ladder check had been run - see METHODS.md.)"""
    p, lad = wf['pooled'], wf['ladder']
    ok = []
    for m in ('local', 'global'):
        push_better = p[m + '_minus_t']['push_logloss_change']['est'] is not None and p[m + '_minus_t']['push_logloss_change']['est'] < 0
        lo = lad[m + '_minus_t']['ci'][0]
        ladder_worse = lo is not None and lo > 0
        if push_better and not ladder_worse:
            ok.append(m)
    if not ok:
        return 't_untied'
    return min(ok, key=lambda m: lad[m])


def sigma_by_line(P):
    Q = P[P.sigma.notna() & P.fav_sign.notna()]
    xs, ys = [], []
    for L in range(0, 36, 2):
        m = (Q.fav_line >= L - 2) & (Q.fav_line <= L + 2)
        if m.sum() >= 30:
            xs.append(float(L))
            ys.append(float(Q.sigma[m].median()))
    return [xs, ys]


def run():
    X = D.frame()
    P = population(X, D.DEV)
    pre = population(X, range(2009, 2016))
    Pall = pd.concat([pre, P], ignore_index=True)
    Fdev = fit_all(P)                                     # 2017-2023 (2016 has no frozen sigma)
    wf = dev_walkforward(X)
    method = choose_method(wf)
    fit = {'mult': Fdev[method] if method in ('local', 'global') else Fdev['local'] * 0 + 1, 'ot': Fdev['ot'], 'method': method}
    sbl = sigma_by_line(P)
    res = {
        'population': 'FBS vs FBS, completed; DEV 2016-2023',
        'landing_dev': landing_table(P),
        'landing_2009_2015': landing_table(pre),
        'favorite_landing_dev': fav_landing_table(P),
        'heterogeneity': heterogeneity(Pall),
        'dev_walkforward_methods': wf,
        'chosen_method': method,
        'push_by_line_dev': push_by_line(P, fit),
        'local_landing_dev': local_landing(P),
        'half_point_values': half_point_table(fit, sbl),
        'alt_ladder_example': alt_ladder_example(fit),
        'totals_dev': totals_table(P),
        'multipliers_local': {int(k): D.r(Fdev['local'][k], 5) for k in range(0, KEY_FIT_MAX + 2)},
        'multipliers_global': {int(k): D.r(Fdev['global'][k], 5) for k in range(0, KEY_FIT_MAX + 2)},
        'ot_distribution': {int(k): D.r(Fdev['ot'][k], 5) for k in range(1, 30) if Fdev['ot'][k] > 0},
        'fit_n': Fdev['n'], 'fit_n_ot': Fdev['n_ot'],
        'fit_counts_local': Fdev['fit_local'], 'fit_counts_global': Fdev['fit_global'],
    }
    A, _ = D.archive()
    res['market_half_point_prices'] = market_half_point_prices(A, X)
    art = {'artifact': 'cfb_market_key_numbers_v1', 'schema': 'cfb_market_key_numbers_schema_v1',
           'method': method,
           'method_text': {'local': 'pure Student t (mean = pure margin, frozen sigma, df) discretised at k +/- 0.5; tie mass to the overtime margin distribution; bin k gains (r_|k| - 1) P(k), paid by the integers within 3 points (shares 3:2:1, half each side; an inner payer below 1 replaced by the outer one); clipped at 0, renormalised',
                           'global': 'discretised t times r_|k|, renormalised',
                           't_untied': 'discretised t with the tie mass sent to the overtime margins'}[method],
           'fit': {'seasons': sorted(int(s) for s in P[P.sigma.notna()].season.unique()), 'n_games': Fdev['n'], 'n_overtime_games': Fdev['n_ot'],
                   'population': 'FBS vs FBS completed, DEV only (2016 has no frozen sigma)',
                   'pseudo_count': PSEUDO, 'individual_up_to': KEY_FIT_MAX, 'selection': choose_method.__doc__.strip()},
           'kmax': KMAX, 'kernel': list(KERNEL),
           'multipliers': [D.r(float(fit['mult'][k]), 6) for k in range(0, KEY_FIT_MAX + 1)],
           'tail_multiplier': 1.0,
           'overtime_distribution': [D.r(float(Fdev['ot'][k]), 6) for k in range(0, 41)],
           'sigma_by_favorite_line': sbl,
           'landing_dev_abs_margin': [{'k': k, 'share': D.r(float((P.abs_m.values == k).mean()), 5)} for k in range(1, 36)],
           'landing_dev_n': int(len(P)),
           'half_point_cents_at_-110': [{'line': x['line'], 'favorite': x['fav_cents'], 'underdog': x['dog_cents']} for x in res['half_point_values']],
           'holdout': 'scored once by python3 -m v2.market_intel.replay --holdout (docs/cfb-market/BACKTEST.md)'}
    D.write_artifact(ARTIFACT, art)
    D.write_json('keynumbers.json', res)
    return res


def load_artifact():
    import json
    import os
    a = json.load(open(os.path.join(D.ARTIFACTS, ARTIFACT)))
    m = np.full(KMAX + 1, float(a['tail_multiplier']))
    m[:len(a['multipliers'])] = a['multipliers']
    ot = np.zeros(KMAX + 1)
    ot[:len(a['overtime_distribution'])] = a['overtime_distribution']
    ot = ot / ot.sum()
    return {'mult': m, 'ot': ot, 'method': a['method']}, a


def parity_fixture():
    """football/cfb_market/fixtures/parity.json: Python reference numbers the
    JavaScript key-number distribution must reproduce (football/cfb_market/tests.js)."""
    import json
    import os
    from . import books as BK
    fit, a = load_artifact()
    ks = np.arange(-KMAX, KMAX + 1)
    cases = []
    for mu, sg, df in ((6.2, 16.0, 100), (-3.0, 15.3, 100), (0.4, 17.5, 30), (21.0, 18.2, 50), (-10.5, 16.4, 100)):
        P = key_pmf([mu], [sg], [df], fit['mult'], fit['ot'], fit['method'])[0]
        lines = []
        for hl in (-14.0, -7.5, -7.0, -3.5, -3.0, -2.5, 0.0, 2.5, 3.0, 7.0, 10.0):
            w, pp, l = outcome_probs(P, -hl)
            lines.append({'home_line': hl, 'home_win': float(w), 'push': float(pp), 'home_loss': float(l)})
        cases.append({'mu': mu, 'sigma': sg, 'df': df, 'p_at': {str(k): float(P[ks == k][0]) for k in (-7, -3, 0, 1, 3, 7, 10, 14)}, 'lines': lines})
    sig = json.load(open(os.path.join(D.ARTIFACTS, 'book_quality_v1.json')))['sigma_market']
    imp = []
    for hl, ph, pa in ((-3.0, -120, 100), (-3.5, 100, -120), (-7.0, -110, -110), (6.5, -105, -115), (-14.5, -110, -110)):
        qh, qa = 1 / (1 + (100 / -ph if ph < 0 else ph / 100)), 1 / (1 + (100 / -pa if pa < 0 else pa / 100))
        tab = BK.implied_table(fit, sig, [-hl])
        imp.append({'home_line': hl, 'price_home': ph, 'price_away': pa, 'implied_margin': BK.implied_margin(-hl, qh / (qh + qa), tab)})
    out = {'artifact': a['artifact'], 'method': a['method'], 'sigma_market': sig, 'cases': cases, 'implied': imp,
           'note': 'generated by python3 -m v2.market_intel.keynumbers --fixture from the frozen artifact'}
    d = os.path.join(D.REPO, 'football', 'cfb_market', 'fixtures')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'parity.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fixture', action='store_true', help='only write the JS parity fixture from the frozen artifact')
    if ap.parse_args().fixture:
        parity_fixture()
        print('parity fixture written')
        raise SystemExit(0)
    r = run()
    m = r['multipliers_local']
    print('key numbers: n=%d; method=%s; local r3=%.3f r7=%.3f r10=%.3f r14=%.3f' % (
        r['landing_dev']['n'], r['chosen_method'], m[3], m[7], m[10], m[14]))
