"""Book quality, consensus methods, opener vs close informativeness
(brief sections 5-8; docs/cfb-market/METHODS.md).

    python3 -m v2.market_intel.books

Data: the raw multi-book archive's CLOSING spreads with real prices for
2016-2019 (the DEV seasons that carry prices; ~20 offshore books incl.
Pinnacle), and the lines-only closes and openers of 2021-2023 (Bovada,
DraftKings, ESPN Bet, Caesars/William Hill). FBS vs FBS completed games.

PRICE-ADJUSTED IMPLIED MARGIN. A book at home -3 -120 and one at -3.5 +100
are not the same number. Each quote is turned into the home margin at which
its no-vig probability would be fair, under the frozen key-number
distribution centred on that margin with the market's own width:
p_novig(home covers | no push) = P(M > L | mu) / (1 - P(M = L | mu)), solved
for mu. Books are then compared, and consensus is taken, on that one scale.

INFORMATION vs PRICE. `market_information_weight` answers "how much of this
book's disagreement with the rest of the market is information": the slope of
the outcome residual (margin - leave-one-out consensus) on the book's
deviation from that consensus, shrunk toward 0 by its sampling variance. A
book's PRICE quality (hold, how often it has the best number or price) is
measured separately; a highly informative book can be a bad place to bet.
"""
import argparse

import numpy as np
import pandas as pd

from ..decision import core
from . import data as D
from . import keynumbers as KN

PRICE_SEASONS = (2016, 2017, 2018, 2019)          # DEV seasons with real closing prices
LINE_SEASONS = (2021, 2022, 2023)                 # DEV seasons with lines only (US books)
MIN_BOOKS = 5                                     # a game needs >= 5 books for LOO work
GRID = np.arange(-8.0, 8.0001, 0.05)


# ------------------------------------------------------ implied margins
def implied_table(fit, sigma, lines, df=100):
    """for each internal line L: p(mu) = P(home covers | no push) on a mu grid."""
    ks = np.arange(-KN.KMAX, KN.KMAX + 1)
    out = {}
    for L in sorted(set(float(x) for x in lines)):
        mus = L + GRID
        P = KN.key_pmf(mus, np.full(len(mus), sigma), np.full(len(mus), df), fit['mult'], fit['ot'], fit['method'])
        w = (P * (ks[None, :] > L + 1e-9)).sum(axis=1)
        pp = P[:, ks == int(round(L))].sum(axis=1) if abs(L - round(L)) < 1e-9 else np.zeros(len(mus))
        p = w / np.maximum(1 - pp, 1e-12)
        p = np.maximum.accumulate(p)                    # monotone in mu (guards float noise)
        out[L] = (p, mus)
    return out


def implied_margin(L, p_home, table):
    p, mus = table[float(L)]
    return float(np.interp(p_home, p, mus))


def quotes_with_implied(A, X, seasons, fit, sigma):
    """CLOSE spread quotes of real books with the price-adjusted implied margin."""
    S = A[(A.market_type == 'spread') & (A.kind == 'CLOSE') & A.is_book & A.season.isin(seasons)].copy()
    S = S.merge(X[['game_id', 'fbs_fbs', 'final', 'margin', 'close_margin', 'season', 'week']].rename(columns={'season': 'g_season'}),
                on='game_id')
    S = S[S.fbs_fbs & S.final].copy()
    priced = S.price_home.notna() & S.price_away.notna()
    qh = np.where(priced, core.break_even(S.price_home.fillna(-110).values), 0.5)
    qa = np.where(priced, core.break_even(S.price_away.fillna(-110).values), 0.5)
    S['p_home_novig'] = qh / (qh + qa)
    S['hold'] = np.where(priced, qh + qa - 1.0, np.nan)
    tab = implied_table(fit, sigma, S.home_margin.unique())
    S['implied_margin'] = [implied_margin(L, p, tab) for L, p in zip(S.home_margin.values, S.p_home_novig.values)]
    S['priced'] = priced
    # a game-level corrupt quote (a book 10+ points from the game's median) is a feed error, not a view
    med = S.groupby('game_id').home_margin.transform('median')
    S['feed_error'] = (S.home_margin - med).abs() >= 10
    return S


def loo(S, col='implied_margin'):
    """leave-one-out median of the OTHER books on the same game."""
    S = S.copy()
    vals = S.groupby('game_id')[col].apply(list).to_dict()
    out = []
    for gid, v in zip(S.game_id.values, S[col].values):
        xs = list(vals[gid])
        xs.remove(v)
        out.append(float(np.median(xs)) if xs else np.nan)
    S['loo_median'] = out
    S['n_books_game'] = S.groupby('game_id').book_key.transform('size')
    return S


# ------------------------------------------------------------ per book
def book_table(S, min_games=150):
    """information quality and price quality, per book (DEV, games with >= MIN_BOOKS books)."""
    S = S[(S.n_books_game >= MIN_BOOKS) & ~S.feed_error].copy()
    S['dev'] = S.implied_margin - S.loo_median
    S['resid'] = S.margin - S.loo_median
    n_games_all = S.game_id.nunique()
    # best number / best price per side (raw lines and prices), for PRICE quality
    g = S.groupby('game_id')
    S['best_home_line'] = S.home_line == g.home_line.transform('max')          # home gets the most points
    S['best_away_line'] = S.home_line == g.home_line.transform('min')
    S['best_home_implied'] = S.implied_margin == g.implied_margin.transform('min')   # cheapest home number, price-adjusted
    S['best_away_implied'] = S.implied_margin == g.implied_margin.transform('max')
    rows = []
    for bk, B in S.groupby('book_key'):
        n = B.game_id.nunique()
        if n < min_games:
            continue
        B = B.reset_index(drop=True)
        bt = D.Boot(len(B))
        dev, res = B.dev.values, B.resid.values
        sxx = float(np.sum(dev * dev))
        beta = float(np.sum(dev * res) / sxx) if sxx > 0 else np.nan
        bb = bt.stat(lambda i: np.sum(dev[i] * res[i]) / max(np.sum(dev[i] * dev[i]), 1e-9)) if sxx > 0 else {'ci': [None, None]}
        se = (bb['ci'][1] - bb['ci'][0]) / 3.92 if bb['ci'][0] is not None else np.nan
        ae_book = np.abs(B.margin - B.implied_margin).values
        ae_loo = np.abs(B.margin - B.loo_median).values
        rows.append({
            'book': bk, 'family': D.book_family(bk), 'games': int(n), 'availability': D.r(n / n_games_all, 3),
            'mean_abs_deviation_pts': D.r(np.mean(np.abs(dev)), 3),
            'share_off_consensus_ge_0_5': D.r(np.mean(np.abs(dev) >= 0.5), 3),
            'share_off_consensus_ge_1': D.r(np.mean(np.abs(dev) >= 1.0), 3),
            'information_slope': {'est': D.r(beta, 3), 'ci': [D.r(bb['ci'][0], 3), D.r(bb['ci'][1], 3)], 'se': D.r(se, 3)},
            'close_mae_minus_loo_consensus_mae': D.cell(bt.mean(ae_book - ae_loo), 3),
            'hold': D.r(B.hold.mean(), 4) if B.priced.any() else None,
            'best_number_share': D.r(np.mean(B.best_home_line | B.best_away_line), 3),
            'best_price_adjusted_share': D.r(np.mean(B.best_home_implied | B.best_away_implied), 3),
        })
    # EMPIRICAL-BAYES shrinkage of the slopes toward their precision-weighted
    # mean: tau^2 (the between-book variance of TRUE slopes) is estimated from
    # the spread of the estimates beyond their sampling variance (DerSimonian-
    # Laird). tau^2 = 0 means the data cannot tell the books apart.
    b_ = np.array([x['information_slope']['est'] for x in rows], float)
    s_ = np.array([x['information_slope']['se'] for x in rows], float)
    ok = np.isfinite(b_) & np.isfinite(s_) & (s_ > 0)
    w = 1.0 / s_[ok] ** 2
    bbar = float(np.sum(w * b_[ok]) / np.sum(w))
    Qs = float(np.sum(w * (b_[ok] - bbar) ** 2))
    tau2 = max(0.0, (Qs - (ok.sum() - 1)) / (np.sum(w) - np.sum(w * w) / np.sum(w)))
    for x, bi, si in zip(rows, b_, s_):
        sh = bbar + (bi - bbar) * (tau2 / (tau2 + si * si)) if np.isfinite(bi) and np.isfinite(si) else bbar
        x['information_slope_shrunk'] = D.r(sh, 3)
        x['market_information_weight'] = D.r(max(0.0, sh), 3)
        x['consensus_weight'] = D.r(1.0 + 2.0 * max(0.0, sh - bbar), 3)
    # pooled: is disagreement between books information at all?
    Sb = S[S.book_key.isin([x['book'] for x in rows])].reset_index(drop=True)
    dv, rs = Sb.dev.values, Sb.resid.values
    gid = Sb.game_id.values
    ug, inv = np.unique(gid, return_inverse=True)
    num_g = np.bincount(inv, weights=dv * rs)
    den_g = np.bincount(inv, weights=dv * dv)
    bg = D.Boot(len(ug))
    pooled = bg.ratio(num_g, den_g)
    rows.sort(key=lambda x: -(x['market_information_weight'] or 0))
    return {'n_games': int(n_games_all), 'books': rows,
            'eb': {'pooled_mean_slope': D.r(bbar, 3), 'tau2_between_books': D.r(tau2, 4), 'Q': D.r(Qs, 2), 'k_books': int(ok.sum())},
            'pooled_slope_all_books': D.cell(pooled, 3)}


# ------------------------------------------------------- consensus rules
def weighted_median(x, w):
    o = np.argsort(x, kind='mergesort')
    x, w = np.asarray(x)[o], np.asarray(w)[o]
    c = np.cumsum(w)
    return float(x[np.searchsorted(c, 0.5 * c[-1])])


def trimmed_mean(x, frac=0.2):
    x = np.sort(np.asarray(x, float))
    k = int(np.floor(frac * len(x)))
    return float(x[k:len(x) - k].mean()) if len(x) - 2 * k > 0 else float(np.median(x))


def consensus_rules(S, weights):
    """one row per game: every consensus rule over that game's books."""
    out = []
    for gid, G in S.groupby('game_id'):
        if len(G) < MIN_BOOKS:
            continue
        im, hl = G.implied_margin.values, G.home_margin.values
        w = np.array([weights.get(b, 1.0) for b in G.book_key.values])
        pin = G[G.book_key == 'pinnacle']
        out.append({'game_id': gid, 'season': int(G.season.iloc[0]), 'margin': float(G.margin.iloc[0]), 'n_books': len(G),
                    'median_line': float(np.median(hl)), 'mean_line': float(np.mean(hl)),
                    'median_implied': float(np.median(im)), 'mean_implied': float(np.mean(im)),
                    'trimmed_implied': trimmed_mean(im), 'weighted_median_implied': weighted_median(im, w),
                    'weighted_mean_implied': float(np.sum(w * im) / np.sum(w)),
                    'pinnacle_implied': float(pin.implied_margin.iloc[0]) if len(pin) else np.nan,
                    'dispersion_iqr': float(np.subtract(*np.percentile(hl, [75, 25]))),
                    'dispersion_sd_implied': float(np.std(im, ddof=1))})
    return pd.DataFrame(out)


RULES = ['median_line', 'mean_line', 'median_implied', 'mean_implied', 'trimmed_implied',
         'weighted_median_implied', 'weighted_mean_implied', 'pinnacle_implied']


def weights_from(S_train):
    """information weights for the weighted rules, learned on training seasons:
    1 + 2 x market_information_weight (a book with weight 0.5 counts double)."""
    bt = book_table(loo(S_train), min_games=100)
    return {b['book']: b['consensus_weight'] for b in bt['books']}, bt


def consensus_walkforward(S):
    """train on earlier price seasons, score the next (2017, 2018, 2019)."""
    frames = []
    for T in (2017, 2018, 2019):
        w, _ = weights_from(S[S.season < T])
        C = consensus_rules(S[S.season == T], w)
        frames.append(C)
    C = pd.concat(frames, ignore_index=True)
    C = C[C.pinnacle_implied.notna()].reset_index(drop=True)
    bt = D.Boot(len(C))
    base = np.abs(C.margin - C.median_line).values
    rows = []
    for r_ in RULES:
        ae = np.abs(C.margin - C[r_]).values
        se = (C.margin - C[r_]).values ** 2
        rows.append({'rule': r_, 'mae': D.r(ae.mean(), 4), 'rmse': D.r(np.sqrt(se.mean()), 4),
                     'mae_minus_median_line': D.cell(bt.mean(ae - base), 4)})
    return {'n_games': int(len(C)), 'seasons_scored': [2017, 2018, 2019], 'rows': rows}


# ----------------------------------------------------- Pinnacle vs rest
def pinnacle_vs_consensus(S):
    """When Pinnacle's price-adjusted margin differs from the other books'
    median, does the result side with Pinnacle? (Pinnacle has closes only in
    the archive: no Pinnacle opener exists.)"""
    P = S[(S.book_key == 'pinnacle') & (S.n_books_game >= MIN_BOOKS) & ~S.feed_error].reset_index(drop=True)
    dev = (P.implied_margin - P.loo_median).values
    res = (P.margin - P.loo_median).values
    bt = D.Boot(len(P))
    out = {'n_games': int(len(P))}
    for thr in (0.25, 0.5, 1.0):
        m = np.abs(dev) >= thr
        # the side Pinnacle prefers relative to the rest: HOME if Pinnacle's margin is higher
        side = np.sign(dev)
        win = np.where(res * side > 0, 1.0, np.where(res * side < 0, 0.0, np.nan))
        out['diff_ge_%g' % thr] = {'games': int(m.sum()),
                                   'result_sides_with_pinnacle_vs_loo_median': D.cell(bt.mean(win, mask=m & np.isfinite(win)), 3),
                                   'mean_residual_toward_pinnacle_pts': D.cell(bt.mean(res * side, mask=m), 3)}
    ae_p = np.abs(P.margin - P.implied_margin).values
    ae_c = np.abs(P.margin - P.loo_median).values
    out['mae_pinnacle_minus_rest'] = D.cell(bt.mean(ae_p - ae_c), 4)
    return out


# ------------------------------------------------ opener vs close vs result
def opener_vs_close(X, A):
    """Is the close more informative than the opener, and does the opener ->
    close move carry information about the result? (the opener is one book in
    most seasons: 5Dimes 2016-2019, Bovada 2021-2022, the median of 2-3 books 2023)."""
    out = {}
    for label, seasons in (('2016-2019 (5Dimes opener, multi-book close)', (2016, 2017, 2018, 2019)),
                           ('2021-2023 (Bovada/DraftKings opener, few-book close)', (2021, 2022, 2023))):
        Q = X[X.fbs_fbs & X.final & X.season.isin(seasons) & X.open_ok & X.close_margin.notna()
              & ~X.eval_open_close_jump.fillna(False).astype(bool)].reset_index(drop=True)
        bt = D.Boot(len(Q))
        ae_o = np.abs(Q.margin - Q.open_margin).values
        ae_c = np.abs(Q.margin - Q.close_margin).values
        mv = (Q.close_margin - Q.open_margin).values
        r_o = (Q.margin - Q.open_margin).values
        m = mv != 0
        slope = bt.stat(lambda i: np.sum(mv[i] * r_o[i]) / max(np.sum(mv[i] * mv[i]), 1e-9))
        res = {'n': int(len(Q)), 'mae_open': D.r(ae_o.mean(), 3), 'mae_close': D.r(ae_c.mean(), 3),
               'mae_close_minus_open': D.cell(bt.mean(ae_c - ae_o), 3),
               'share_moved': D.r(m.mean(), 3),
               'result_residual_per_point_of_move (1 = the move is fully information)': {'est': D.r(slope['est'], 3), 'ci': [D.r(slope['ci'][0], 3), D.r(slope['ci'][1], 3)]}}
        if Q.ens_pred.notna().any():
            ae_p = np.abs(Q.margin - Q.ens_pred).values
            res['mae_pure'] = D.r(np.nanmean(ae_p), 3)
            res['mae_pure_minus_open'] = D.cell(bt.mean(ae_p - ae_o), 3)
            res['mae_pure_minus_close'] = D.cell(bt.mean(ae_p - ae_c), 3)
        out[label] = res
    return out


def us_books_lines(A, X):
    """2021-2023 (lines only): the US books' closing numbers against the
    result and against each other (no prices: implied margin = the line)."""
    S = A[(A.market_type == 'spread') & (A.kind == 'CLOSE') & A.is_book & A.season.isin(LINE_SEASONS)].copy()
    S = S.merge(X[['game_id', 'fbs_fbs', 'final', 'margin']], on='game_id')
    S = S[S.fbs_fbs & S.final]
    S['implied_margin'] = S.home_margin
    med = S.groupby('game_id').home_margin.transform('median')
    S['feed_error'] = (S.home_margin - med).abs() >= 10
    S = loo(S[~S.feed_error])
    rows = []
    for bk, B in S[S.n_books_game >= 2].groupby('book_key'):
        if B.game_id.nunique() < 150:
            continue
        B = B.reset_index(drop=True)
        dev, res = (B.implied_margin - B.loo_median).values, (B.margin - B.loo_median).values
        bt = D.Boot(len(B))
        sxx = float(np.sum(dev * dev))
        bb = bt.stat(lambda i: np.sum(dev[i] * res[i]) / max(np.sum(dev[i] * dev[i]), 1e-9)) if sxx > 0 else {'est': None, 'ci': [None, None]}
        rows.append({'book': bk, 'family': D.book_family(bk), 'games': int(B.game_id.nunique()),
                     'mean_abs_deviation_pts': D.r(np.mean(np.abs(dev)), 3), 'share_off_ge_1': D.r(np.mean(np.abs(dev) >= 1), 3),
                     'information_slope': {'est': D.r(bb.get('est'), 3), 'ci': [D.r(bb['ci'][0], 3), D.r(bb['ci'][1], 3)]}})
    return {'seasons': list(LINE_SEASONS), 'books': rows,
            'note': 'lines only (no prices after 2019): a book at -3 -120 and -3 +100 look identical here'}


def dispersion_and_error(C):
    """does closing dispersion across books predict the size of the market's error?"""
    C = C.copy()
    C['ae'] = np.abs(C.margin - C.median_implied)
    q = np.quantile(C.dispersion_sd_implied, [0.25, 0.5, 0.75])
    bins = np.digitize(C.dispersion_sd_implied, q)
    bt = D.Boot(len(C))
    rows = []
    for b in range(4):
        rows.append({'dispersion_quartile': b + 1, 'ae_close': D.cell(bt.mean(C.ae.values, mask=bins == b), 3)})
    return {'rows': rows, 'quartile_edges_pts': [D.r(x, 3) for x in q]}


def run():
    X = D.frame()
    A, qa = D.archive()
    fit, _ = KN.load_artifact()
    dev_close = X[X.fbs_fbs & X.final & X.season.isin(D.DEV) & X.close_margin.notna()]
    sigma_mkt = float(np.std(dev_close.margin - dev_close.close_margin, ddof=1))
    S = quotes_with_implied(A, X, PRICE_SEASONS, fit, sigma_mkt)
    S = loo(S[~S.feed_error])
    bt = book_table(S)
    wf = consensus_walkforward(S)
    C_all = consensus_rules(S, {})
    res = {'sigma_market_dev': D.r(sigma_mkt, 3), 'archive_qa': qa,
           'n_quotes_2016_2019': int(len(S)), 'share_priced': D.r(S.priced.mean(), 4),
           'books_2016_2019': bt, 'consensus_walkforward': wf, 'pinnacle_vs_consensus': pinnacle_vs_consensus(S),
           'opener_vs_close': opener_vs_close(X, A), 'us_books_2021_2023': us_books_lines(A, X),
           'dispersion_vs_market_error': dispersion_and_error(C_all)}
    # the deployable weights: every DEV price season; unknown books weigh 1
    w_all = {b['book']: {'family': b['family'], 'market_information_weight': b['market_information_weight'],
                         'consensus_weight': b['consensus_weight'],
                         'stale_or_outlier_rate_ge_1pt': b['share_off_consensus_ge_1'], 'hold': b['hold']}
             for b in bt['books']}
    fam = {}
    for b in bt['books']:
        f = fam.setdefault(b['family'], [])
        f.append(b['consensus_weight'])
    art = {'artifact': 'cfb_market_book_quality_v1', 'schema': 'cfb_market_book_quality_schema_v1',
           'fit': {'seasons': list(PRICE_SEASONS), 'population': 'FBS vs FBS completed, CLOSING quotes with prices, games with >= 5 books',
                   'weight_rule': 'slope_b = outcome residual (margin - leave-one-out median) on the book\'s price-adjusted deviation from that median; empirical-Bayes shrinkage toward the precision-weighted mean slope with the DerSimonian-Laird between-book variance; market_information_weight = max(0, shrunk slope); consensus_weight = 1 + 2 x max(0, shrunk slope - mean slope)',
                   'eb': bt['eb'], 'pooled_slope_all_books': bt['pooled_slope_all_books']},
           'sigma_market': D.r(sigma_mkt, 3), 'default_weight': 1.0,
           'books': w_all, 'families': {k: D.r(float(np.mean(v)), 3) for k, v in fam.items()},
           'consensus_rule': 'consensus_margin = the median of the books\' lines (the Lab rule, unchanged); the median of price-adjusted implied margins is carried beside it; the information-weighted median is implemented but INACTIVE (weights_active = false): on the DEV walk-forward no weighted, trimmed or Pinnacle-only rule beats the plain median by a margin its CI supports (docs/cfb-market/BACKTEST.md)',
           'weights_active': False,
           'note': 'weights exist only for books in the 2016-2019 archive; the US books the Lab captures (draftkings, fanduel, betmgm, caesars, espnbet...) weigh 1 until their own timestamped history supports another number'}
    D.write_artifact('book_quality_v1.json', art)
    D.write_json('books.json', res)
    return res


if __name__ == '__main__':
    argparse.ArgumentParser().parse_args()
    r = run()
    print('books: %d quotes; top info weight %s' % (r['n_quotes_2016_2019'], r['books_2016_2019']['books'][0]['book']))
