"""The point-in-time decision dataset: game x prediction snapshot x quote.

    python3 -m v2.decision.dataset      -> out_h/decision/decision_dataset.parquet
                                           out_h/decision/dataset_summary.json
                                           docs/cfb-decision/DATASET.md

MODEL SIDE (every row): the frozen V2.1 walk-forward out-of-fold prediction at
the Tuesday 12:00 UTC freeze (out_h/stage7/backtest_predictions.parquet), exactly
as stored — no pure number is recomputed or altered here, and no market column
enters one. The only derived pure quantities are functions of the stored
snapshot (the t distribution's cover probability at a line, its push mass, the
production-formula reliability score).

QUOTES:
  CONSENSUS_OPEN   2016-2025: the archive's consensus OPENER (median across the
                   books that carry an opener). Priced at an ASSUMED -110 each
                   side (price_source='ASSUMED_-110'): the stage-2 market file
                   carries no prices. The raw archive does carry the opener's
                   own price for 2012-2019 (the single book, 5Dimes, whose
                   opener IS the consensus opener), kept in
                   archive_open_price_side/_other for a sensitivity check.
  BOOK_OPEN        2023-2025: one row per book when >= 2 books carry an opener
                   (Bovada, DraftKings, ESPN Bet); lines only, price assumed.
  PINNACLE_OPEN    never present: the archive's Pinnacle rows carry no opener
                   (spread_open_pin is null in every season). Pinnacle's CLOSE
                   (2012-2019) is kept on the outcome side only.
  LIVE_BOOK_QUOTE  2026: the Model Lab's pregame sportsbook quotes, real
                   observed_at timestamps; the price only when it was CAPTURED
                   (none before week 5) -> otherwise EV is not computable.
                   Provider-declared openers feed live line movement only.
  LIVE_CFBD_OPEN   2026: the CFBD provider-mean opener (no timestamp, no price).
  NONE             a snapshot with no quote (all of 2020; missing openers): the
                   pure side is still recorded for football-only analysis.

OUTCOME SIDE (evaluation only, never a decision input): final margin, ATS
result, units at the ASSUMED price (historical only), closing line, CLV.
"""
import glob
import json
import math
import os
import sys

import numpy as np
import pandas as pd

from .. import config as C
from .. import models as MD
from . import DATASET_VERSION, BASE_MODEL_VERSION
from . import core
from .baseline import parse_params_js, CFB_V2, REPO

LEDGER = os.path.join(REPO, 'football', 'cfb_lab', 'ledger', str(C.LIVE_SEASON))
DOCS = os.path.join(REPO, 'docs', 'cfb-decision')
DIMES = '5Dimes & sportbet'
FIRST_SEASON = 2016                       # first season with a V2.1 ensemble prediction
PUSH_BURN_IN = 2014                       # the push table may read 2014-2015 (pre-DEV, never holdout)


def out_dir():
    p = os.path.join(C.OUT, 'decision')
    os.makedirs(p, exist_ok=True)
    return p


def window_of(season):
    s = int(season)
    if s in C.DEV_SEASONS:
        return 'dev'
    if s in C.HOLDOUT_SEASONS:
        return 'holdout'
    if s == C.LIVE_SEASON:
        return 'live'
    return 'pre_dev'


# ---------------------------------------------------------------- loaders
STAGE7_COLS = ['game_id', 'season', 'week', 'season_type', 'is_postseason', 'neutral_site', 'home_team',
               'away_team', 'home_conference', 'away_conference', 'kickoff_ts', 'prediction_ts', 'status',
               'margin', 'fcs_game', 'ens_pred', 'sigma', 'p_home_raw', 'ens_sd', 'pred_C_ridge', 'pred_D_gbm',
               'reliability', 'early_season', 'weeks_in', 'min_games', 'rating_sd_sum',
               'qb_missing_any', 'qb_unsettled_any', 'h_qb_changed', 'a_qb_changed', 'open_margin',
               'close_margin', 'total_open', 'total_close', 'spread_books', 'market_dispersion', 'source']


def load_stage7():
    fam = json.load(open(os.path.join(C.OUT, 'report', 'selected_families.json')))
    feats = sorted(set(MD.features_for(fam['C']) + MD.features_for(fam['D'])))
    D = pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'))
    have = [c for c in feats if c in D.columns]
    comp = D[have].notna().mean(axis=1)
    X = D[STAGE7_COLS].copy()
    X['data_completeness'] = comp.values
    X['n_model_features'] = len(have)
    return X


def load_t_df():
    rep = json.load(open(os.path.join(C.OUT, 'report', 'backtest.json')))
    return {int(k): int(v['t_df']) for k, v in rep['uncertainty_by_season'].items()}


def load_market_extra():
    M = pd.read_parquet(os.path.join(C.OUT, 'stage2', 'market.parquet'))
    return M[['game_id', 'spread_close_pin', 'spread_open_pin', 'spread_close_sd', 'market_qa',
              'eval_open_close_flip', 'eval_open_close_jump']]


def load_archive_openers():
    """Per-book OPENERS (and the opener's price where the archive has one) from
    the raw cfbfastR multi-book archive, sides resolved exactly as V1's
    build_market does (team-id intersection, never string matching)."""
    os.environ.setdefault('CFB_P4_DATA', os.path.join(C.DATA, 'v1'))
    v1r = os.path.normpath(os.path.join(CFB_V2, '..', 'cfb_p4', 'research'))
    if v1r not in sys.path:
        sys.path.insert(0, v1r)
    import build_market as V1BM                      # noqa: E402  (V1's frozen market builder)
    L = V1BM._load_raw()
    amap = V1BM.resolve_abbr_sides(L)
    S = V1BM._side_frame(L, amap)
    S = S[S.market_type.eq('spread') & S.is_home.notna() & S.opening_lines.notna()].copy()
    S['is_home'] = S.is_home.astype(bool)
    S['game_id'] = S.game_id.astype('int64')
    S['open_home_margin'] = np.where(S.is_home, -S.opening_lines, S.opening_lines)   # BOOK -> INTERNAL
    S['payout'] = core.american_to_payout(pd.to_numeric(S.opening_odds, errors='coerce').values)
    per_book = S.groupby(['game_id', 'book']).open_home_margin.median().rename('book_open_margin').reset_index()
    pr = S[S.payout.notna()].groupby(['game_id', 'book', 'is_home']).payout.median().unstack()
    pr = pr.rename(columns={True: 'payout_home', False: 'payout_away'}).reset_index()
    per_book = per_book.merge(pr, on=['game_id', 'book'], how='left')
    for side in ('home', 'away'):
        b = per_book.get('payout_' + side)
        per_book['price_' + side] = np.where(b >= 1, np.round(100 * b), np.where(b > 0, -np.round(100 / b), np.nan)) \
            if b is not None else np.nan
    return per_book


def engine_iqr(xs):
    """engine.js consensus(): q1 = xs[floor((n-1)/4)], q3 = xs[ceil(3(n-1)/4)]."""
    xs = sorted(xs)
    n = len(xs)
    if n < 2:
        return np.nan
    return float(xs[int(math.ceil((n - 1) * 0.75))] - xs[int(math.floor((n - 1) * 0.25))])


def opener_summary(per_book):
    g = per_book.groupby('game_id')
    out = pd.DataFrame({
        'opener_book_count': g.book.nunique(),
        'opener_books': g.book.apply(lambda s: '|'.join(sorted(s.unique()))),
        'opener_dispersion_sd': g.book_open_margin.apply(lambda s: float(s.std()) if len(s) >= 2 else np.nan),
        'opener_dispersion_iqr': g.book_open_margin.apply(lambda s: engine_iqr(list(s))),
    })
    d = per_book[per_book.book.eq(DIMES)].set_index('game_id')
    out['dimes_open_margin'] = d.book_open_margin
    out['dimes_price_home'] = d.price_home
    out['dimes_price_away'] = d.price_away
    return out.reset_index()


def load_ledger():
    """Live 2026 quotes (real timestamps, no prices) and the ledger's closes/results."""
    Q = [json.loads(l) for f in sorted(glob.glob(os.path.join(LEDGER, 'quotes', '*.jsonl'))) for l in open(f) if l.strip()]
    L = [json.loads(l) for l in open(os.path.join(LEDGER, 'lines.jsonl')) if l.strip()]
    R = [json.loads(l) for l in open(os.path.join(LEDGER, 'results.jsonl')) if l.strip()]
    Q = pd.DataFrame(Q)
    L = pd.DataFrame(L)
    R = pd.DataFrame(R)
    sp = Q[Q.market_type.eq('spread')]
    two = sp[sp.price_home.notna() & sp.price_away.notna()]
    info = {'quotes_total': int(len(Q)), 'quotes_spread': int(Q.market_type.eq('spread').sum()),
            'spread_quotes_two_sided_price': int(len(two)),
            'priced_spread_books': sorted(two.book.dropna().unique().tolist()),
            'priced_spread_weeks': sorted(int(w) for w in two.week.dropna().unique()),
            'first_priced_observed_at': str(two.observed_at.min()) if len(two) else None,
            'priced_spread_games': int(two.game_id.nunique()),
            'weeks': sorted(int(w) for w in Q.week.dropna().unique()),
            'books': sorted(Q.book.dropna().unique().tolist()),
            'quotes_with_any_price': int(Q[['price_home', 'price_away', 'price_over', 'price_under']].notna().any(axis=1).sum()),
            'pregame_spread_quotes': int((Q.market_type.eq('spread') & Q.is_pregame & ~Q.is_provider_open).sum()),
            'provider_open_spread_quotes': int((Q.market_type.eq('spread') & Q.is_provider_open).sum()),
            'provider_close_spread_quotes': int((Q.market_type.eq('spread') & Q.is_provider_close).sum())}
    return Q, L, R, info


# ------------------------------------------------------------ quote rows
def reliability_prod(X, P):
    """engine.js reliability() with the FROZEN production range and caps and no
    live overlays: 100 * clamp((sigma_hi - sigma)/(sigma_hi - sigma_lo)), capped
    for FCS (50), a team with no game (70), unsettled QB (75), unknown QB (65),
    rounded like engine.js (Math.round)."""
    R = P['reliability']
    s = 100.0 * np.clip((R['sigma_hi'] - X.sigma.values) / max(1e-6, R['sigma_hi'] - R['sigma_lo']), 0, 1)
    cap = np.full(len(X), 100.0)
    caps = R['caps']
    cap = np.where(X.fcs_game.values.astype(bool), np.minimum(cap, caps['fcs']), cap)
    mg = X.min_games.values.astype(float)
    cap = np.where(np.isfinite(mg) & (mg < 1), np.minimum(cap, caps['no_games']), cap)
    cap = np.where(X.qb_unsettled_any.fillna(0).values > 0, np.minimum(cap, caps['qb_unsettled']), cap)
    cap = np.where(X.qb_missing_any.fillna(0).values > 0, np.minimum(cap, caps['qb_unknown']), cap)
    out = np.floor(np.minimum(s, cap) + 0.5)
    return np.where(np.isfinite(X.sigma.values), out, np.nan)


def push_tables(base):
    """Walk-forward empirical push tables: season S reads FBS FINAL openers of
    seasons [2014, min(S, 2024)) — never a holdout or live outcome."""
    h = base[~base.fcs_game.astype(bool) & base.status.eq('FINAL') & base.open_margin.notna() & base.margin.notna()]
    tabs = {}
    for S in sorted(base.season.unique()):
        hi = min(int(S), min(C.HOLDOUT_SEASONS))
        past = h[(h.season >= PUSH_BURN_IN) & (h.season < hi)]
        assert not set(past.season.unique()) & (set(C.HOLDOUT_SEASONS) | {C.LIVE_SEASON})
        tabs[int(S)] = core.fit_push_table(past.open_margin.values, past.margin.values) if len(past) else None
    return tabs


def build(write=True, verbose=True):
    P = parse_params_js()
    X = load_stage7()
    X = X[X.season >= FIRST_SEASON].copy()
    tdf = load_t_df()
    X = X.merge(load_market_extra(), on='game_id', how='left')
    per_book = load_archive_openers()
    OS = opener_summary(per_book)
    X = X.merge(OS, on='game_id', how='left')
    X['window'] = [window_of(s) for s in X.season]
    X['t_df'] = X.season.map(tdf).astype(float)
    X['qb_changed_any'] = X[['h_qb_changed', 'a_qb_changed']].fillna(0).max(axis=1)
    X['reliability_wf'] = X['reliability']
    X['reliability'] = reliability_prod(X, P)
    X['pricing_scope'] = np.where(X.fcs_game.astype(bool), 'FCS_EXCLUDED', 'FBS_FBS')
    X['expected_model_error'] = [s * core.mean_abs_t_std(d) if np.isfinite(s) and np.isfinite(d) else np.nan
                                 for s, d in zip(X.sigma, X.t_df)]
    X['model_origin'] = np.where(X.season.eq(C.LIVE_SEASON), 'REPLAY_TRAINED_THROUGH_2025', 'WALK_FORWARD_OOF')
    # the full-game push history for the walk-forward tables (includes 2014-2015 burn-in)
    H = load_stage7()
    H = H[H.season >= PUSH_BURN_IN]
    ptab = push_tables(H)

    rows = []
    # ---------------- historical consensus opener
    hist = X[X.season.lt(C.LIVE_SEASON)]
    q = hist[hist.open_margin.notna()].copy()
    q['quote_role'] = 'CONSENSUS_OPEN'
    q['book'] = 'CONSENSUS'
    q['quote_line_margin'] = q.open_margin
    q['price_source'] = core.PRICE_SOURCE_ASSUMED
    q['quote_price_home'] = float(core.ASSUMED_PRICE)
    q['quote_price_away'] = float(core.ASSUMED_PRICE)
    q['quote_observed_at'] = pd.NaT
    q['decision_ts'] = q.prediction_ts
    q['close_line_margin'] = q.close_margin
    q['close_source'] = 'ARCHIVE_CONSENSUS_CLOSE'
    # the archive's own opener price exists only where the consensus IS the 5Dimes opener
    same = q.dimes_open_margin.notna() & np.isclose(q.dimes_open_margin.fillna(-999), q.open_margin)
    q['archive_open_price_home'] = np.where(same, q.dimes_price_home, np.nan)
    q['archive_open_price_away'] = np.where(same, q.dimes_price_away, np.nan)
    rows.append(q)
    # ---------------- per-book openers where >= 2 books carry one (else the book IS the consensus)
    multi = per_book[per_book.game_id.isin(hist.game_id)]
    cnt = multi.groupby('game_id').book.nunique()
    multi = multi[multi.game_id.isin(cnt[cnt >= 2].index)]
    if len(multi):
        b = hist.merge(multi[['game_id', 'book', 'book_open_margin']], on='game_id', how='inner')
        b = b[b.open_margin.notna()].copy()
        b['quote_role'] = 'BOOK_OPEN'
        b['quote_line_margin'] = b.book_open_margin
        b['price_source'] = core.PRICE_SOURCE_ASSUMED
        b['quote_price_home'] = float(core.ASSUMED_PRICE)
        b['quote_price_away'] = float(core.ASSUMED_PRICE)
        b['quote_observed_at'] = pd.NaT
        b['decision_ts'] = b.prediction_ts
        b['close_line_margin'] = b.close_margin
        b['close_source'] = 'ARCHIVE_CONSENSUS_CLOSE'
        b['archive_open_price_home'] = np.nan
        b['archive_open_price_away'] = np.nan
        rows.append(b.drop(columns=['book_open_margin']))
    # ---------------- live 2026
    Q, L, R, ledger_info = load_ledger()
    live = X[X.season.eq(C.LIVE_SEASON)]
    sp = Q[Q.market_type.eq('spread') & Q.home_line.notna()].copy()
    sp['game_id'] = sp.game_id.astype('int64')
    sp['obs'] = pd.to_datetime(sp.observed_at, utc=True)
    # the provider's declared OPENER per (game, book): never a decision quote itself (its observed_at is the
    # retrieval time, not the posting time), used only for live line movement
    po = sp[sp.is_provider_open.astype(bool)].sort_values('obs').drop_duplicates(['game_id', 'book'], keep='first')
    po = po.set_index(['game_id', 'book']).home_line
    lq = sp[sp.is_pregame.astype(bool) & ~sp.is_provider_open.astype(bool) & ~sp.is_provider_close.astype(bool)]
    lq = lq[['game_id', 'book', 'home_line', 'obs', 'quote_id', 'price_home', 'price_away']].merge(live, on='game_id', how='inner')
    lq = lq[lq.obs < lq.kickoff_ts].copy()                            # point in time: before kickoff
    close = L[L.kind.eq('CLOSE') & L.market_type.eq('spread') & L.home_line.notna()].copy()
    close['game_id'] = close.game_id.astype('int64')
    close = close.drop_duplicates('game_id', keep='last').set_index('game_id')
    lq['quote_role'] = 'LIVE_BOOK_QUOTE'
    lq['quote_line_margin'] = -lq.home_line.astype(float)          # BOOK -> INTERNAL, once
    lq['quote_price_home'] = pd.to_numeric(lq.price_home, errors='coerce').astype(float)
    lq['quote_price_away'] = pd.to_numeric(lq.price_away, errors='coerce').astype(float)
    npr = lq.quote_price_home.notna().astype(int) + lq.quote_price_away.notna().astype(int)
    lq['price_source'] = np.where(npr == 2, core.PRICE_SOURCE_CAPTURED,
                                  np.where(npr == 1, core.PRICE_SOURCE_ONE_SIDED, core.PRICE_SOURCE_NONE))
    lq['live_open_line_margin'] = [-float(po[(g, b)]) if (g, b) in po.index else np.nan for g, b in zip(lq.game_id, lq.book)]
    lq['quote_observed_at'] = lq.obs
    lq['decision_ts'] = np.maximum(lq.obs.values, lq.prediction_ts.values)
    lq['close_line_margin'] = -lq.game_id.map(close.home_line).astype(float)
    lq['close_source'] = 'LEDGER_PROVIDER_DECLARED_CLOSE'
    lq['archive_open_price_home'] = np.nan
    lq['archive_open_price_away'] = np.nan
    keep = list(live.columns) + ['quote_role', 'book', 'quote_line_margin', 'price_source', 'quote_price_home',
                                 'quote_price_away', 'quote_observed_at', 'decision_ts', 'close_line_margin',
                                 'close_source', 'archive_open_price_home', 'archive_open_price_away', 'quote_id',
                                 'live_open_line_margin']
    rows.append(lq[keep])
    lc = live[live.open_margin.notna()].copy()
    lc['quote_role'] = 'LIVE_CFBD_OPEN'
    lc['book'] = 'CFBD_PROVIDER_MEAN'
    lc['quote_line_margin'] = lc.open_margin
    lc['price_source'] = core.PRICE_SOURCE_NONE
    lc['quote_price_home'] = np.nan
    lc['quote_price_away'] = np.nan
    lc['quote_observed_at'] = pd.NaT
    lc['decision_ts'] = lc.prediction_ts
    lc['close_line_margin'] = lc.close_margin
    lc['close_source'] = 'CFBD_PROVIDER_MEAN_CLOSE'
    lc['archive_open_price_home'] = np.nan
    lc['archive_open_price_away'] = np.nan
    rows.append(lc)
    # ---------------- snapshots with no quote at all
    quoted = set(pd.concat([r.game_id for r in rows]).unique())
    nq = X[~X.game_id.isin(quoted)].copy()
    nq['quote_role'] = 'NONE'
    nq['book'] = None
    for c in ('quote_line_margin', 'quote_price_home', 'quote_price_away', 'close_line_margin',
              'archive_open_price_home', 'archive_open_price_away'):
        nq[c] = np.nan
    nq['price_source'] = None
    nq['quote_observed_at'] = pd.NaT
    nq['decision_ts'] = nq.prediction_ts
    nq['close_source'] = None
    rows.append(nq)

    Dd = pd.concat(rows, ignore_index=True, sort=False)
    Dd = derive(Dd, ptab)
    Dd = Dd.sort_values(['season', 'kickoff_ts', 'game_id', 'quote_role', 'book'], kind='mergesort').reset_index(drop=True)
    Dd.insert(0, 'decision_row_id', ['%d:%s:%s:%s' % (g, 'TUE_FREEZE', r, b if isinstance(b, str) else '-')
                                     + (':%s' % qi if isinstance(qi, str) else '')
                                     for g, r, b, qi in zip(Dd.game_id, Dd.quote_role, Dd.book, Dd.get('quote_id', [None] * len(Dd)))])
    assert Dd.decision_row_id.is_unique, 'decision_row_id must be unique'
    Dd = Dd[[c for c, *_ in DICTIONARY if c in Dd.columns]]
    summary = summarize(Dd, ledger_info, per_book, ptab)
    if write:
        Dd.to_parquet(os.path.join(out_dir(), 'decision_dataset.parquet'), index=False)
        with open(os.path.join(out_dir(), 'dataset_summary.json'), 'w') as f:
            json.dump(summary, f, indent=1, sort_keys=True, default=str)
        write_dictionary_md(Dd, summary)
        if verbose:
            print('[dataset] %d rows x %d cols -> %s' % (len(Dd), Dd.shape[1], out_dir()))
    return Dd, summary


def derive(Dd, ptab):
    """Every decision and outcome field, vectorized. Pure numbers are read from
    the snapshot; the quote enters ONLY as the threshold of the model's own
    distribution (and in the market/decision/outcome fields)."""
    Dd['dataset_version'] = DATASET_VERSION
    Dd['model_version'] = BASE_MODEL_VERSION
    Dd['snapshot_type'] = 'TUESDAY_FREEZE'
    Dd['pure_margin'] = Dd.ens_pred
    Dd['pure_fair_home_line'] = -Dd.ens_pred
    Dd['pure_win_prob_home'] = Dd.p_home_raw
    L = Dd.quote_line_margin.astype(float)
    Dd['quote_home_line'] = -L
    has_q = L.notna()
    has_pure = Dd.ens_pred.notna()
    gap = Dd.ens_pred - L
    Dd['gap_home_pts'] = gap
    side_home = gap > 0
    side_ok = has_q & has_pure & gap.ne(0)
    Dd['side'] = np.where(side_ok, np.where(side_home, 'HOME', 'AWAY'), None)
    sgn = np.where(side_home, 1.0, -1.0)
    Dd['side_sign'] = np.where(side_ok, sgn, np.nan)
    Dd['is_home_side'] = np.where(side_ok, side_home.astype(float), np.nan)
    Dd['gap_pts'] = np.where(side_ok, gap * sgn, np.nan)
    Dd['abs_gap_pts'] = np.abs(gap)
    Dd['abs_line'] = L.abs()
    Dd['line_for_side'] = np.where(side_ok, -L * sgn, np.nan)       # book-style number for the side
    ok_p = side_ok & Dd.sigma.notna() & Dd.t_df.notna()
    pch = core.cover_prob_home(Dd.ens_pred.values, Dd.sigma.values, L.values, Dd.t_df.fillna(30).values)
    pch = np.where(ok_p, pch, np.nan)
    Dd['pure_cover_prob_home'] = pch
    Dd['pure_cover_prob'] = np.where(ok_p, np.where(side_home, pch, 1 - pch), np.nan)
    Dd['push_prob_model'] = np.where(ok_p, core.push_prob_model(Dd.ens_pred.values, Dd.sigma.values, L.values,
                                                                 Dd.t_df.fillna(30).values), np.nan)
    Dd['push_prob'] = [core.push_prob_lookup(l, ptab[int(s)]) if np.isfinite(l) and ptab.get(int(s)) else np.nan
                       for l, s in zip(L.values, Dd.season.values)]
    Dd['push_table_seasons'] = ['%d-%d' % (PUSH_BURN_IN, min(int(s), min(C.HOLDOUT_SEASONS)) - 1) for s in Dd.season]
    # market-side at decision
    Dd['books'] = Dd.opener_book_count.where(Dd.quote_role.isin(['CONSENSUS_OPEN', 'BOOK_OPEN']))
    Dd.loc[Dd.quote_role.eq('BOOK_OPEN'), 'books'] = 1.0
    Dd.loc[Dd.quote_role.isin(['LIVE_BOOK_QUOTE']), 'books'] = 1.0
    Dd['dispersion'] = Dd.opener_dispersion_iqr.where(Dd.quote_role.eq('CONSENSUS_OPEN'))
    Dd['archive_book_count'] = Dd.spread_books
    Dd['market_dispersion_close'] = Dd.spread_close_sd
    Dd['total_line'] = Dd.total_open.where(Dd.quote_role.ne('NONE'))
    Dd['market_maturity_hours'] = np.nan                  # no opener timestamps anywhere
    age = (pd.to_datetime(Dd.decision_ts, utc=True) - pd.to_datetime(Dd.quote_observed_at, utc=True)).dt.total_seconds() / 60.0
    Dd['quote_age_min'] = np.where(Dd.quote_role.eq('LIVE_BOOK_QUOTE'), age, np.nan)
    Dd['hours_to_kickoff'] = (Dd.kickoff_ts - pd.to_datetime(Dd.decision_ts, utc=True)).dt.total_seconds() / 3600.0
    ph_, pa_ = Dd.quote_price_home.astype(float).values, Dd.quote_price_away.astype(float).values
    Dd['price_side_american'] = np.where(side_ok, np.where(side_home, ph_, pa_), np.nan)
    Dd['price_other_american'] = np.where(side_ok, np.where(side_home, pa_, ph_), np.nan)
    if 'live_open_line_margin' not in Dd:
        Dd['live_open_line_margin'] = np.nan
    Dd['line_move_at_decision'] = Dd.quote_line_margin - Dd.live_open_line_margin     # live only (home-margin change)
    ps = Dd.price_side_american.values.astype(float)
    po = Dd.price_other_american.values.astype(float)
    Dd['break_even_prob'] = core.break_even(ps)
    mip = [core.market_implied_side(a, b) for a, b in zip(ps, po)]
    Dd['market_implied_prob'] = np.where(has_q, [m[0] for m in mip], np.nan)
    Dd['market_implied_basis'] = np.where(has_q, [m[1] for m in mip], None)
    Dd['theoretical_ev'] = np.where(ok_p & np.isfinite(ps), core.ev_with_push(Dd.pure_cover_prob.values,
                                                                             Dd.push_prob.fillna(0).values, np.nan_to_num(ps, nan=-110)), np.nan)
    Dd['orientation_fault'] = has_q & has_pure & (gap.abs() > 21) & ((Dd.ens_pred + L).abs() <= 7)
    Dd['review_route'] = has_q & has_pure & ((gap.abs() >= 14) | Dd.orientation_fault)
    Dd['timing_bucket'] = np.where(Dd.is_postseason.astype(bool) | (Dd.week >= 12), 'late/post',
                                   np.where(Dd.week <= 3, 'wk0-3', np.where(Dd.week <= 7, 'wk4-7', 'wk8-11')))
    Dd['qb_missing'] = Dd.qb_missing_any
    Dd['qb_unsettled'] = Dd.qb_unsettled_any
    Dd['qb_changed'] = Dd.qb_changed_any
    # archive opener price, oriented to the side (2012-2019 sensitivity only)
    Dd['archive_open_price_side'] = np.where(side_home, Dd.archive_open_price_home, Dd.archive_open_price_away)
    Dd['archive_open_price_other'] = np.where(side_home, Dd.archive_open_price_away, Dd.archive_open_price_home)
    Dd.loc[~side_ok, ['archive_open_price_side', 'archive_open_price_other']] = np.nan
    # ------------------------------------------------ outcome (evaluation only)
    fin = Dd.status.eq('FINAL') & Dd.margin.notna()
    Dd['final_margin'] = Dd.margin.where(fin)
    diff = Dd.final_margin - L
    res = np.where(diff == 0, 0.0, np.where((diff > 0) == side_home, 1.0, -1.0))
    res = np.where(fin & side_ok, res, np.nan)
    Dd['ats_result'] = pd.Series(res).map({1.0: 'W', -1.0: 'L', 0.0: 'P'}).values
    Dd['ats_win'] = np.where(res == 1, 1.0, np.where(res == -1, 0.0, np.nan))
    Dd['is_push'] = np.where(np.isfinite(res), (res == 0).astype(float), np.nan)
    assumed = Dd.price_source.eq(core.PRICE_SOURCE_ASSUMED).values
    Dd['units_assumed_110'] = np.where(assumed, core.units(res, core.ASSUMED_PRICE), np.nan)
    captured = Dd.price_source.isin([core.PRICE_SOURCE_CAPTURED, core.PRICE_SOURCE_ONE_SIDED]).values & np.isfinite(ps)
    Dd['units_captured_price'] = np.where(captured & np.isfinite(res), core.units(res, np.nan_to_num(ps, nan=-110)), np.nan)
    aps = Dd.archive_open_price_side.values.astype(float)
    Dd['units_archive_price'] = np.where(np.isfinite(aps) & np.isfinite(res),
                                         core.units(res, np.nan_to_num(aps, nan=-110)), np.nan)
    cl = Dd.close_line_margin.astype(float)
    Dd['close_home_line'] = -cl
    played = Dd.status.ne('NOT_PLAYED').values                      # a cancelled game has no meaningful close
    clv = np.where(side_ok & cl.notna() & played, (cl - L) * sgn, np.nan)
    Dd['clv_pts'] = clv
    Dd['positive_clv'] = np.where(np.isfinite(clv), (clv > 0).astype(float), np.nan)
    Dd['line_moved'] = np.where(np.isfinite(clv), (clv != 0).astype(float), np.nan)
    Dd['moved_toward_model'] = np.where(np.isfinite(clv) & (clv != 0), (clv > 0).astype(float), np.nan)
    pin = Dd.spread_close_pin.astype(float)
    Dd['pinnacle_close_margin'] = pin
    Dd['clv_pts_pinnacle'] = np.where(side_ok & pin.notna() & Dd.quote_role.eq('CONSENSUS_OPEN'), (pin - L) * sgn, np.nan)
    Dd['abs_error_model'] = (Dd.final_margin - Dd.ens_pred).abs()
    Dd['abs_error_quote'] = (Dd.final_margin - L).abs()
    Dd['abs_error_close'] = (Dd.final_margin - cl).abs()
    Dd['abs_line_move'] = (cl - L).abs()
    # ------------------------------------------------ null reasons
    reasons = []
    for r in Dd.itertuples(index=False):
        why = []
        if not np.isfinite(r.ens_pred):
            why.append('no_pure_prediction')
        if not np.isfinite(r.sigma):
            why.append('no_error_model(sigma needs a prior OOF season: none for 2016)')
        if r.quote_role == 'NONE':
            why.append('no_quote(2020: archive has no openers)' if r.season == C.COVID_SEASON else 'no_quote(no opener in the archive)')
        if r.price_source == core.PRICE_SOURCE_NONE:
            why.append('no_price_captured(live: EV not computable, never assumed)')
        if r.quote_role in ('CONSENSUS_OPEN', 'BOOK_OPEN'):
            why.append('line_move/maturity/freshness: not archived (opener and close only)')
        if r.fcs_game:
            why.append('fcs_game: excluded from pricing')
        if r.status != 'FINAL':
            why.append('not_final: outcome unknown')
        reasons.append(';'.join(why))
    Dd['null_reasons'] = reasons
    return Dd


# --------------------------------------------------------- the dictionary
# (column, layer, definition). Layers: id | pure | market | decision | outcome | meta.
# 'pure' columns never read a market column; 'outcome' columns are evaluation only.
DICTIONARY = [
    ('decision_row_id', 'id', 'game_id:TUE_FREEZE:quote_role:book[:quote_id] — unique row key (grain: game x snapshot x quote)'),
    ('dataset_version', 'meta', DATASET_VERSION),
    ('model_version', 'meta', 'frozen pure model: edgedesk_cfb_v2.1.0'),
    ('model_origin', 'meta', 'WALK_FORWARD_OOF (2016-2025: models fit on earlier seasons only) | REPLAY_TRAINED_THROUGH_2025 (2026: generated after kickoff from point-in-time features — evidence of method, not live foresight)'),
    ('snapshot_type', 'meta', 'TUESDAY_FREEZE: the prediction snapshot at Tuesday 12:00 UTC of the game week'),
    ('game_id', 'id', 'CFBD/ESPN game id'),
    ('season', 'id', 'season'),
    ('week', 'id', 'schedule week (postseason games carry week 1 in the schedule; use is_postseason)'),
    ('season_type', 'id', 'regular | postseason'),
    ('is_postseason', 'id', 'postseason game'),
    ('window', 'id', 'dev (2016-2023, the ONLY window any fit reads) | holdout (2024-2025, never read by fitting code) | live (2026)'),
    ('home_team', 'id', 'home team'),
    ('away_team', 'id', 'away team'),
    ('home_conference', 'id', 'home conference'),
    ('away_conference', 'id', 'away conference'),
    ('neutral_site', 'id', 'neutral site'),
    ('kickoff_ts', 'id', 'kickoff (UTC)'),
    ('prediction_ts', 'id', 'snapshot time: every pure input is as-of this instant'),
    ('status', 'id', 'FINAL | SCHEDULED | NOT_PLAYED'),
    ('fcs_game', 'id', 'an FCS team is playing'),
    ('pricing_scope', 'id', 'FBS_FBS (priced and studied) | FCS_EXCLUDED (in the dataset, excluded from every decision fit and table: the pure mean is biased against the FBS side, REDTEAM section 8)'),
    # ------------------------------------------------------------ pure
    ('pure_margin', 'pure', 'the V2.1 ensemble projected home margin (points; + = home) = stage-7 ens_pred, unaltered'),
    ('pure_fair_home_line', 'pure', 'book-convention fair line = -pure_margin'),
    ('pure_win_prob_home', 'pure', 'V2.1 home win probability (stage-7 p_home_raw: the shipped win calibration is raw)'),
    ('sigma', 'pure', 'the frozen error model\'s predicted SD of (margin - pure_margin), points (stage 7)'),
    ('t_df', 'pure', 'degrees of freedom of the standardized t error distribution for that season (out_h/report/backtest.json uncertainty_by_season)'),
    ('expected_model_error', 'pure', 'theoretical expected |margin - pure_margin| = sigma * E|T_std(t_df)| (points)'),
    ('ens_sd', 'pure', 'ensemble disagreement: SD of the two active submodels (C ridge, D GBM), points'),
    ('pred_C_ridge', 'pure', 'submodel C projected home margin'),
    ('pred_D_gbm', 'pure', 'submodel D projected home margin'),
    ('reliability', 'pure', 'football_prediction_confidence exactly as engine.js reliability() computes it in production: 100*clamp((sigma_hi - sigma)/(sigma_hi - sigma_lo)) with the FROZEN params.js range (15.311-18.499) and caps (FCS 50, a team with no game 70, unsettled QB 75, unknown QB 65), rounded; no live overlays historically. The feature name decision.js passes to the artifact'),
    ('reliability_wf', 'pure', 'the stage-7 walk-forward reliability (same formula, per-season sigma range from earlier seasons; null before 2018)'),
    ('early_season', 'pure', '1 if the snapshot is < 5 weeks after the season\'s first kickoff (stage-7 weeks_in < 5), else 0'),
    ('weeks_in', 'pure', 'weeks from the season\'s first kickoff to the snapshot'),
    ('timing_bucket', 'pure', 'wk0-3 (week <= 3) | wk4-7 | wk8-11 | late/post (week >= 12 or postseason)'),
    ('min_games', 'pure', 'fewer games played of the two teams this season'),
    ('rating_sd_sum', 'pure', 'posterior SD of the two teams\' EPA ratings (standardized)'),
    ('qb_missing', 'pure', 'QB certainty proxy: 1 if either team\'s expected starter is unknown at the snapshot (stage-7 qb_missing_any; unknown -> 1)'),
    ('qb_unsettled', 'pure', 'QB certainty proxy: 1 if either team used >= 2 starters in its last 3 games (qb_unsettled_any)'),
    ('qb_changed', 'pure', 'QB certainty proxy: 1 if either team\'s expected starter is not its season dropback leader (max of h/a_qb_changed)'),
    ('data_completeness', 'pure', 'share of the production model\'s input features (C and D families) that are non-null in the snapshot'),
    ('n_model_features', 'pure', 'number of production features the completeness share is over'),
    # ------------------------------------------------------------ market at decision
    ('quote_role', 'market', 'CONSENSUS_OPEN | BOOK_OPEN | LIVE_BOOK_QUOTE | LIVE_CFBD_OPEN | NONE (see the module docstring; PINNACLE_OPEN never exists)'),
    ('book', 'market', 'CONSENSUS | the book name | CFBD_PROVIDER_MEAN'),
    ('quote_id', 'market', 'the Model Lab quote id (live rows)'),
    ('quote_line_margin', 'market', 'the quoted spread in INTERNAL convention (home margin the market prices; book home -7 == +7)'),
    ('quote_home_line', 'market', 'the same number in BOOK convention (home line)'),
    ('abs_line', 'market', '|quote_line_margin| (points)'),
    ('total_line', 'market', 'the opening total (points) where the archive has one; null live'),
    ('price_source', 'market', 'ASSUMED_-110 (historical study only, labelled) | CAPTURED (live: both sides\' prices observed with the quote) | CAPTURED_ONE_SIDED | NONE (live: no price captured -> EV not computable, never assumed)'),
    ('quote_price_home', 'market', 'American price of the HOME side of the quote (-110 ASSUMED historically; the captured price live; null when not captured)'),
    ('quote_price_away', 'market', 'American price of the AWAY side of the quote (same conventions)'),
    ('price_side_american', 'market', 'American price of the side taken (quote_price_home/away oriented to the side)'),
    ('price_other_american', 'market', 'American price of the other side'),
    ('archive_open_price_home', 'market', 'the raw archive\'s own OPENING price for the home side, 2012-2019 only, where the consensus opener IS the single book\'s (5Dimes) opener; sensitivity check of the -110 assumption'),
    ('archive_open_price_away', 'market', 'the same for the away side'),
    ('archive_open_price_side', 'market', 'archive opening price of the side taken'),
    ('archive_open_price_other', 'market', 'archive opening price of the other side'),
    ('opener_books', 'market', 'books carrying an opener in the archive (2012-2019: 5Dimes only; 2021-2022: Bovada; 2023: Bovada|DraftKings; 2024-2025: + ESPN Bet)'),
    ('opener_book_count', 'market', 'number of books with an opener (the consensus opener is their median)'),
    ('books', 'market', 'books behind the quote at decision: opener_book_count for CONSENSUS_OPEN, 1 for a single book\'s quote'),
    ('dispersion', 'market', 'engine.js IQR of the book openers (q3 - q1 as consensus() computes it) when >= 2 books carry an opener; null otherwise (null for every DEV season but 2023)'),
    ('opener_dispersion_sd', 'market', 'SD of the book openers (>= 2 books)'),
    ('archive_book_count', 'market', 'books quoting the game anywhere in the archive (stage-7 spread_books). AS OF THE CLOSE, era-confounded (2016-2019 ~20, 2021+ ~3-4): quasi point-in-time, never a frozen model input'),
    ('market_dispersion_close', 'market', 'SD of the CLOSING lines across books (spread_close_sd). CLOSE-TIME information: NOT point in time for an opener decision; diagnostic only'),
    ('quote_observed_at', 'market', 'when the quote was observed (live only; historical openers carry no timestamp)'),
    ('decision_ts', 'market', 'max(prediction_ts, quote_observed_at): the earliest instant the decision could be made'),
    ('hours_to_kickoff', 'market', 'kickoff - decision_ts (hours)'),
    ('quote_age_min', 'market', 'quote age at decision (minutes) = decision_ts - quote_observed_at: 0 when the quote arrives after the snapshot, positive when the snapshot is later than the quote; null historically'),
    ('live_open_line_margin', 'market', 'live only: the same book\'s provider-declared OPENER (internal convention), when the ledger carries one'),
    ('line_move_at_decision', 'market', 'home-margin move from the same book\'s provider opener to the decision quote (quote - opener). LIVE ONLY: the archive has the opener and close only, so it is null historically'),
    ('market_maturity_hours', 'market', 'hours since the opener was posted: NULL everywhere (no opener timestamps exist)'),
    # ------------------------------------------------------------ decision
    ('gap_home_pts', 'decision', 'pure_margin - quote_line_margin (+ = the model likes HOME against this quote)'),
    ('side', 'decision', 'the side the pure model prefers against this quote: HOME if gap_home_pts > 0 else AWAY'),
    ('side_sign', 'decision', '+1 HOME, -1 AWAY'),
    ('is_home_side', 'decision', '1 if side is HOME'),
    ('gap_pts', 'decision', 'model-market gap oriented to the side taken (= |gap_home_pts| for the model\'s side; decision.js passes the signed side gap)'),
    ('abs_gap_pts', 'decision', '|gap_home_pts|'),
    ('line_for_side', 'decision', 'the book-style number of the side taken (e.g. -3.5)'),
    ('pure_cover_prob_home', 'decision', 'PURE P(home covers | no push) = 1 - F_t((L - pure_margin)/sigma; t_df), F_t the unit-variance t'),
    ('pure_cover_prob', 'decision', 'PURE P(side covers | no push) (>= 0.5 by construction). The model\'s independent opinion; no market number enters it except as the threshold'),
    ('push_prob', 'decision', 'empirical P(margin == line) for integer lines by |line| bucket, walk-forward (FBS openers of seasons [2014, S), never holdout); 0 on half-point lines. The probability used in EV (the engine.js convention)'),
    ('push_prob_model', 'decision', 'push mass of the model\'s continuous t at an integer line (continuity correction). Understates key numbers; reported, never used in EV'),
    ('push_table_seasons', 'decision', 'the seasons the row\'s push table read'),
    ('break_even_prob', 'decision', '1 / (1 + b(price_side)): the P(cover | no push) at which EV = 0 (0.52381 at -110); null without a price'),
    ('market_implied_prob', 'decision', 'the market\'s P(side covers | no push): proportional de-vig of the two-sided price; 0.5 at a fair line (and at the ASSUMED -110/-110)'),
    ('market_implied_basis', 'decision', 'DEVIG_PROPORTIONAL | FAIR_LINE_0.5'),
    ('theoretical_ev', 'decision', 'EV per unit risked from the PURE probability: p(1-push)b - (1-p)(1-push), at the side\'s price (ASSUMED -110 historically; null live)'),
    ('orientation_fault', 'decision', 'engine.js orientation guard: |gap| > 21 and |pure_margin + line| <= 7 (a sign-flipped market number)'),
    ('review_route', 'decision', 'production routes the row to REVIEW (never priced): |gap| >= 14 (the frozen review_gap) or an orientation fault'),
    # ------------------------------------------------------------ outcome
    ('final_margin', 'outcome', 'final home margin (FINAL games only)'),
    ('ats_result', 'outcome', 'W | L | P for the side taken against the quote'),
    ('ats_win', 'outcome', '1 win, 0 loss, null push'),
    ('is_push', 'outcome', '1 if the margin landed on the line'),
    ('units_assumed_110', 'outcome', 'units at the ASSUMED -110 (+0.9091 / -1 / 0): historical rows only; null live'),
    ('units_captured_price', 'outcome', 'units at the CAPTURED live price (live priced rows, once final)'),
    ('units_archive_price', 'outcome', 'units at the archive\'s own opening price (2016-2019 sensitivity only)'),
    ('close_line_margin', 'outcome', 'closing line, internal convention (archive consensus close; ledger provider close live)'),
    ('close_home_line', 'outcome', 'closing line, book convention'),
    ('close_source', 'outcome', 'where the close came from'),
    ('clv_pts', 'outcome', 'side-oriented closing-line value in points: (close - quote) * side_sign; > 0 = the market moved to the side taken'),
    ('positive_clv', 'outcome', '1 if clv_pts > 0 (no move counts as 0)'),
    ('line_moved', 'outcome', '1 if close != quote'),
    ('moved_toward_model', 'outcome', 'among moved lines: 1 if the close moved toward the side the model took'),
    ('pinnacle_close_margin', 'outcome', 'Pinnacle\'s closing line (2012-2019 only; the archive has no Pinnacle opener)'),
    ('clv_pts_pinnacle', 'outcome', 'side-oriented CLV against Pinnacle\'s close (consensus-opener rows, 2016-2019)'),
    ('abs_error_model', 'outcome', '|final_margin - pure_margin|'),
    ('abs_error_quote', 'outcome', '|final_margin - quote_line_margin|'),
    ('abs_error_close', 'outcome', '|final_margin - close_line_margin|'),
    ('abs_line_move', 'outcome', '|close - quote| (points)'),
    ('eval_open_close_flip', 'outcome', 'stage-2 evaluation flag: opener and close look sign-flipped (uses the close: never a decision input)'),
    ('eval_open_close_jump', 'outcome', 'stage-2 evaluation flag: opener more than 14 points from the close'),
    ('market_qa', 'meta', 'stage-2 ingestion QA note'),
    ('null_reasons', 'meta', 'why fields are null on this row (semicolon-separated)'),
]
LAYER = {c: l for c, l, _ in DICTIONARY}
PURE_FIELDS = [c for c, l, _ in DICTIONARY if l == 'pure']
MARKET_FIELDS = [c for c, l, _ in DICTIONARY if l == 'market']
OUTCOME_FIELDS = [c for c, l, _ in DICTIONARY if l == 'outcome']


def summarize(Dd, ledger_info, per_book, ptab):
    fbs = Dd[Dd.pricing_scope.eq('FBS_FBS')]
    cov = {}
    for (w, role), g in Dd.groupby(['window', 'quote_role']):
        cov['%s|%s' % (w, role)] = {'rows': int(len(g)), 'games': int(g.game_id.nunique()),
                                    'fbs_rows': int(g.pricing_scope.eq('FBS_FBS').sum()),
                                    'with_pure_cover_prob': int(g.pure_cover_prob.notna().sum()),
                                    'with_price': int(g.price_side_american.notna().sum()),
                                    'final': int(g.status.eq('FINAL').sum()),
                                    'with_clv': int(g.clv_pts.notna().sum())}
    by_season = {}
    for s, g in fbs[fbs.quote_role.eq('CONSENSUS_OPEN')].groupby('season'):
        ap = g.archive_open_price_side.notna()
        both110 = ap & g.archive_open_price_side.eq(-110) & g.archive_open_price_other.eq(-110)
        by_season[int(s)] = {'fbs_consensus_open_rows': int(len(g)), 'with_pure_cover_prob': int(g.pure_cover_prob.notna().sum()),
                             'opener_books': sorted(g.opener_books.dropna().unique().tolist()),
                             'archive_open_price_rows': int(ap.sum()),
                             'archive_price_is_-110_both_sides': int(both110.sum()),
                             'review_route': int(g.review_route.sum())}
    return {'dataset_version': DATASET_VERSION, 'rows': int(len(Dd)), 'columns': int(Dd.shape[1]),
            'games': int(Dd.game_id.nunique()), 'coverage_by_window_role': cov,
            'consensus_open_by_season_fbs': by_season, 'ledger': ledger_info,
            'pinnacle_open_rows': int(Dd.spread_open_pin.notna().sum()) if 'spread_open_pin' in Dd else 0,
            'fcs_rows_excluded_from_pricing': int(Dd.fcs_game.astype(bool).sum()),
            'live_priced_rows': int(Dd.price_source.eq(core.PRICE_SOURCE_CAPTURED).sum()),
            'live_priced_rows_final': int((Dd.price_source.eq(core.PRICE_SOURCE_CAPTURED) & Dd.status.eq('FINAL')).sum()),
            'live_rows_with_line_move': int(Dd.line_move_at_decision.notna().sum()),
            'push_table_frozen_2014_2023': ptab.get(min(C.HOLDOUT_SEASONS)),
            'seasons': sorted(int(s) for s in Dd.season.unique())}


def write_dictionary_md(Dd, S):
    os.makedirs(DOCS, exist_ok=True)
    fbs = Dd[Dd.pricing_scope.eq('FBS_FBS')]
    L = []
    L.append('# CFB decision dataset (`%s`)' % DATASET_VERSION)
    L.append('')
    L.append('Generated by `python3 -m v2.decision.dataset` from the frozen V2.1 build (`out_h`). Output: '
             '`football/cfb_v2/research/out_h/decision/decision_dataset.parquet` (%d rows x %d columns, %d games, seasons %d-%d).'
             % (S['rows'], S['columns'], S['games'], min(S['seasons']), max(S['seasons'])))
    L.append('')
    L.append('## Grain and point in time')
    L.append('')
    L.append('- **Grain:** game x prediction snapshot x quote. Every game has exactly one snapshot, the V2.1 walk-forward prediction at the '
             '**Tuesday 12:00 UTC freeze** of its week (stage 7), so the grain is game x quote. A game with no quote keeps one '
             '`quote_role = NONE` row so the football side is never lost.')
    L.append('- **Model side:** the stored stage-7 numbers, unaltered. Seasons 2016-2025 are out-of-fold (each season predicted by '
             'models fit on earlier seasons); 2026 is a replay with models trained through 2025, generated after the games '
             '(evidence of method, not of live foresight). `sigma` exists from 2017 (the error model needs an earlier '
             'out-of-fold season), so **the pure cover probability exists from 2017**; 2016 rows carry the gap, ATS and CLV only.')
    L.append('- **Historical quotes are the consensus OPENER, priced at an ASSUMED -110** (`price_source = ASSUMED_-110`) and '
             'graded against the final margin; CLV runs from the opener to the close, oriented to the side. The close is '
             'outcome-side only. The opener has **no timestamp**: the study assumes it was available at the Tuesday freeze. '
             'Openers are normally posted before Tuesday, so the freeze may already face a moved line (REDTEAM section 15, '
             '"Edge decay"): historical opener results are an optimistic fill, and the close is the pessimistic check.')
    L.append('- **Live 2026 quotes** carry real `observed_at` timestamps (decision_ts = max(prediction_ts, observed_at); only '
             'quotes observed before kickoff). A price is used only when it was CAPTURED with the quote (`price_source = '
             'CAPTURED`); otherwise `break_even_prob`, `theoretical_ev` and every EV are null — a price is never assumed in a '
             'live decision. At this build: %d live rows carry a captured two-sided price (%d of them final).'
             % (S['live_priced_rows'], S['live_priced_rows_final']))
    L.append('- **FBS vs FBS only for pricing.** FCS games stay in the file (`pricing_scope = FCS_EXCLUDED`, %d rows) and are excluded '
             'from every decision fit and table.' % S['fcs_rows_excluded_from_pricing'])
    L.append('')
    L.append('## What the market data does and does not contain')
    L.append('')
    L.append('Established by execution on `data/betting/cfb_line_odds.csv.gz` (the raw cfbfastR multi-book archive) and the '
             'Model Lab ledger, not assumed:')
    L.append('')
    L.append('- **The consensus opener is a single book for most seasons.** Only one book carries opening lines in each era: '
             '5Dimes in 2012-2019 (the stage-2 `spread_open` equals the 5Dimes opener in 99.8% of games), Bovada in 2021-2022, '
             'Bovada + DraftKings in 2023, + ESPN Bet in 2024-2025. So `dispersion` at the opener exists only where two or more '
             'books open (2023+), and `books` = 1 for every DEV season but 2023.')
    L.append('- **2020 has no openers at all** (every 2020 row is `quote_role = NONE`); the study reports 2020 separately.')
    L.append('- **There is no Pinnacle opener.** The archive\'s Pinnacle rows carry no opening line (`spread_open_pin` is null in every '
             'season; %d rows), so the "Pinnacle opener as a second quote" never exists. Pinnacle\'s CLOSE (2012-2019) is kept '
             'on the outcome side (`clv_pts_pinnacle`).' % S['pinnacle_open_rows'])
    L.append('- **Prices.** The stage-2 market file carries no prices. The RAW archive does carry prices for 2006-2019: every '
             'book\'s closing price, and the 5Dimes OPENING price for 2012-2019 — i.e. the real price of the very opener the '
             'study bets. They are kept as `archive_open_price_*` for a sensitivity check of the -110 assumption; the primary '
             'convention stays ASSUMED -110 (consistent with v2/market.py, BACKTEST.md and REDTEAM.md). 2020-2025 carry no '
             'price of any kind. (DESIGN.md says the archive "carries no prices": true of the stage-2 file, not of the raw archive.)')
    ss = S['consensus_open_by_season_fbs']
    L.append('')
    L.append('| season | FBS consensus-opener rows | with pure cover prob | opener books | archive opener price rows | of which -110 both sides | routed to REVIEW |')
    L.append('|---|---|---|---|---|---|---|')
    for s in sorted(ss):
        v = ss[s]
        L.append('| %d | %d | %d | %s | %d | %d | %d |' % (s, v['fbs_consensus_open_rows'], v['with_pure_cover_prob'],
                                                         ', '.join(v['opener_books']).replace('|', ' + ') or '—', v['archive_open_price_rows'],
                                                         v['archive_price_is_-110_both_sides'], v['review_route']))
    lg = S['ledger']
    L.append('')
    L.append('- **Live Model Lab ledger (2026, weeks %s):** %d quotes (%d spread), books: %s. Spread quotes with a two-sided '
             'price: **%d** (books %s, weeks %s, first captured %s, %d games). Of the spread quotes, %d are pregame current '
             'quotes, %d provider-declared openers (live line movement only) and %d provider-declared closes (observed after '
             'kickoff: outcome side only). Priced, per-book, timestamped data has only just begun: it is one book, one week, '
             'and none of the priced games had been played at this build — nothing can be validated on it yet.'
             % (', '.join(str(w) for w in lg['weeks']), lg['quotes_total'], lg['quotes_spread'], ', '.join(lg['books']),
                lg['spread_quotes_two_sided_price'], ', '.join(lg['priced_spread_books']) or '—',
                ', '.join(str(w) for w in lg['priced_spread_weeks']) or '—', lg['first_priced_observed_at'],
                lg['priced_spread_games'], lg['pregame_spread_quotes'], lg['provider_open_spread_quotes'],
                lg['provider_close_spread_quotes']))
    L.append('- **Line movement, market maturity and freshness** are null historically: the archive has only the opener and '
             'the close. Live, `line_move_at_decision` exists where the ledger carries the same book\'s provider opener (%d rows); '
             '`market_maturity_hours` is null everywhere (no opener carries a posting time).' % S['live_rows_with_line_move'])
    L.append('- **Close-time columns are never decision inputs:** `market_dispersion_close` (closing SD across books) and '
             '`archive_book_count` (books in the archive, counted as of the close, era-confounded) are kept for diagnostics.')
    L.append('')
    L.append('## Coverage by window and quote role')
    L.append('')
    L.append('| window \\| role | rows | games | FBS rows | with pure cover prob | with a price | final | with CLV |')
    L.append('|---|---|---|---|---|---|---|---|')
    for k in sorted(S['coverage_by_window_role']):
        v = S['coverage_by_window_role'][k]
        L.append('| %s | %d | %d | %d | %d | %d | %d | %d |' % (k.replace('|', ' \\| '), v['rows'], v['games'], v['fbs_rows'],
                                                              v['with_pure_cover_prob'], v['with_price'], v['final'], v['with_clv']))
    pt = S['push_table_frozen_2014_2023']
    L.append('')
    L.append('## Push table (empirical, integer lines, FBS openers 2014-2023; the frozen table)')
    L.append('')
    L.append('| abs(line) bucket | integer-line games | P(push) |')
    L.append('|---|---|---|')
    for b in pt['buckets']:
        L.append('| %s-%s | %d | %.4f |' % (b['lo'], b['hi'], b['n'], b['p']))
    L.append('')
    L.append('Walk-forward in the dataset: season S reads seasons [2014, min(S, 2024)); the 2014-2015 burn-in seasons are '
             'pre-DEV, never holdout. A bucket with <= 50 games uses 0.02. Half-point lines push with probability 0.')
    L.append('')
    L.append('## Data dictionary')
    L.append('')
    L.append('Layers: **pure** never reads a market column (the quote enters a pure-model quantity only as the threshold of the '
             'model\'s own distribution, in the decision layer); **market** is what was quoted at decision time; **decision** '
             'combines them; **outcome** is evaluation only and never a decision input. Non-null counts are over FBS-vs-FBS rows.')
    L.append('')
    L.append('| column | layer | non-null (FBS) | definition |')
    L.append('|---|---|---|---|')
    for c, layer, d in DICTIONARY:
        nn = int(fbs[c].notna().sum()) if c in fbs else 0
        L.append('| `%s` | %s | %d | %s |' % (c, layer, nn, d.replace('|', '\\|')))
    L.append('')
    L.append('## Feature names the frozen artifact uses (decision.js vocabulary)')
    L.append('')
    L.append('`pure_cover_prob`, `gap_pts`, `abs_gap_pts`, `sigma`, `ens_sd`, `reliability`, `early_season`, `qb_missing`, '
             '`qb_unsettled`, `abs_line`, `is_home_side`, `books`, `dispersion`, `decision_cover_prob`: defined above, with '
             'these exact names; the artifact\'s models list the features they read, their standardization and their fills.')
    open(os.path.join(DOCS, 'DATASET.md'), 'w').write('\n'.join(L) + '\n')


if __name__ == '__main__':
    build()
