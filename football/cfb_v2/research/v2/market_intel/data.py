"""Shared data for the market-intelligence research: games, the stage-2 market,
V2.1's out-of-fold predictions, and the raw multi-book archive normalised into
the CANONICAL market format (docs/cfb-market/AUDIT.md).

Canonical conventions (identical to v2.common, engine.js and the Model Lab):
  * a MARGIN is home points minus away points; `home_margin` of a quote is the
    home margin the market prices (book 'home -7' == +7);
  * the HOME side at internal line L covers when margin > L, AWAY when
    margin < L, margin == L is a push;
  * a price is American odds; decimal = 1 + payout; implied_probability_raw =
    1 / decimal (with the vig).

Nothing here is a model input of the pure layer. Every function is
deterministic (sorted, seeded) and reads only local files.
"""
import json
import math
import os
import sys

import numpy as np
import pandas as pd

from .. import config as C
from ..decision import core

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.normpath(os.path.join(HERE, '..', '..'))
REPO = os.path.normpath(os.path.join(RESEARCH, '..', '..', '..'))
OUTDIR = os.path.join(C.OUT, 'market_intel')
ARTIFACTS = os.path.join(REPO, 'football', 'cfb_market', 'artifacts')
DEV = tuple(C.DEV_SEASONS)                 # 2016-2023: every fit and every choice
HOLDOUT = tuple(C.HOLDOUT_SEASONS)         # 2024-2025: scored once, at the end
SEED = 20260927
BOOT_B = 2000

P4_CONFS = {'SEC', 'Big Ten', 'ACC', 'Big 12', 'Pac-12', 'Pac-10'}
# pre-registered "national brand" list for the bias audit (not chosen by results)
POPULAR = {'Alabama', 'Ohio State', 'Michigan', 'Notre Dame', 'Texas', 'USC', 'Georgia', 'LSU', 'Oklahoma',
           'Penn State', 'Clemson', 'Florida', 'Florida State', 'Tennessee', 'Auburn', 'Oregon', 'Nebraska',
           'Miami', 'Texas A&M'}
NOT_BOOKS = {'consensus', 'teamrankings', 'numberfire'}     # provider averages / projections, not sportsbooks


def outdir():
    os.makedirs(OUTDIR, exist_ok=True)
    return OUTDIR


def write_json(name, obj):
    p = os.path.join(outdir(), name)
    with open(p, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=_jd)
    return p


def write_artifact(name, obj):
    os.makedirs(ARTIFACTS, exist_ok=True)
    p = os.path.join(ARTIFACTS, name)
    with open(p, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=_jd)
        f.write('\n')
    return p


def _jd(o):
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
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v, k) if math.isfinite(v) else None


# ------------------------------------------------------------ book keys
def book_key(name):
    return ''.join(ch for ch in str(name).lower() if ch.isalnum()) or 'unknown'


FAMILY = {'bovadabodog': 'bovada', 'bovada': 'bovada', 'draftkings': 'draftkings', 'williamhillnewjersey': 'caesars',
          'caesars': 'caesars', 'caesarssportsbookcolorado': 'caesars', 'caesarspennsylvania': 'caesars',
          '5dimessportbet': '5dimes', 'betcrisbookmaker': 'bookmaker', 'betonlinesportsbetting': 'betonline',
          'espnbet': 'espnbet', 'pinnacle': 'pinnacle'}


def book_family(key):
    return FAMILY.get(key, key)


# ------------------------------------------------------------ bootstrap
class Boot:
    """A shared game-level bootstrap: one index matrix per population, reused by
    every cell so cell-to-cell differences keep their correlation."""

    def __init__(self, n, B=BOOT_B, seed=SEED):
        self.n, self.B = int(n), int(B)
        rng = np.random.default_rng(seed)
        self.idx = rng.integers(0, max(self.n, 1), size=(self.B, self.n), dtype=np.int64) if self.n else None

    def mean(self, x, mask=None):
        """mean of x over the rows where mask (and x finite); CI by resampling games."""
        x = np.asarray(x, dtype=float)
        ok = np.isfinite(x) if mask is None else (np.asarray(mask, bool) & np.isfinite(x))
        n = int(ok.sum())
        if n == 0:
            return {'n': 0, 'est': None, 'ci': [None, None]}
        est = float(x[ok].mean())
        if n < 20 or self.idx is None:
            return {'n': n, 'est': est, 'ci': [None, None]}
        xv = np.where(ok, x, 0.0)
        w = ok.astype(float)
        num = xv[self.idx].sum(axis=1)
        den = w[self.idx].sum(axis=1)
        with np.errstate(invalid='ignore', divide='ignore'):
            m = num / den
        m = m[np.isfinite(m)]
        return {'n': n, 'est': est, 'ci': [float(np.quantile(m, 0.025)), float(np.quantile(m, 0.975))]}

    def ratio(self, num, den):
        """sum(num)/sum(den) over games (e.g. ROI = units / bets)."""
        a, b = np.asarray(num, float), np.asarray(den, float)
        ok = np.isfinite(a) & np.isfinite(b)
        a, b = np.where(ok, a, 0.0), np.where(ok, b, 0.0)
        tot = b.sum()
        if tot <= 0:
            return {'n': int((b > 0).sum()), 'est': None, 'ci': [None, None]}
        est = float(a.sum() / tot)
        if (b > 0).sum() < 20:
            return {'n': int((b > 0).sum()), 'est': est, 'ci': [None, None]}
        with np.errstate(invalid='ignore', divide='ignore'):
            m = a[self.idx].sum(axis=1) / b[self.idx].sum(axis=1)
        m = m[np.isfinite(m)]
        return {'n': int((b > 0).sum()), 'est': est, 'ci': [float(np.quantile(m, 0.025)), float(np.quantile(m, 0.975))]}

    def stat(self, fn):
        """any statistic fn(idx_row) -> float, CI over the bootstrap rows."""
        est = fn(np.arange(self.n))
        vals = np.array([fn(self.idx[b]) for b in range(self.B)], dtype=float)
        vals = vals[np.isfinite(vals)]
        return {'n': self.n, 'est': float(est) if est is not None else None,
                'ci': [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))] if len(vals) > 20 else [None, None]}


def cell(d, k=4):
    """compact rendering of a Boot result."""
    return {'n': d['n'], 'est': r(d['est'], k), 'ci': [r(d['ci'][0], k), r(d['ci'][1], k)]}


def ci_excludes(d, v=0.0):
    lo, hi = d['ci']
    return lo is not None and hi is not None and (lo > v or hi < v)


# ------------------------------------------------------------- loaders
def t_df_by_season():
    rep = json.load(open(os.path.join(C.OUT, 'report', 'backtest.json')))
    return {int(k): int(v['t_df']) for k, v in rep['uncertainty_by_season'].items()}


def ot_flags():
    """game_id -> overtime (max period >= 5) from the play-by-play (cached)."""
    cache = os.path.join(outdir(), 'ot_flags.parquet')
    if os.path.exists(cache):
        return pd.read_parquet(cache)
    import pyarrow.parquet as pq
    out = []
    d = os.path.join(C.DATA, 'pbp')
    for f in sorted(os.listdir(d)):
        if not f.startswith('play_by_play_') or not f.endswith('.parquet'):
            continue
        t = pq.read_table(os.path.join(d, f), columns=['game_id', 'period']).to_pandas()
        t['period'] = pd.to_numeric(t.period, errors='coerce')
        g = t.groupby('game_id').period.max().rename('max_period').reset_index()
        out.append(g)
    X = pd.concat(out, ignore_index=True)
    X['game_id'] = pd.to_numeric(X.game_id, errors='coerce').astype('Int64')
    X = X.dropna(subset=['game_id']).groupby('game_id', as_index=False).max_period.max()
    X['game_id'] = X.game_id.astype('int64')
    X['overtime'] = X.max_period >= 5
    X.to_parquet(cache, index=False)
    return X


def games():
    G = pd.read_parquet(os.path.join(C.OUT, 'stage2', 'games.parquet'))
    G = G.copy()
    G['fbs_fbs'] = G.home_fbs.astype(bool) & G.away_fbs.astype(bool)
    G['final'] = G.status.eq('FINAL') & G.margin.notna()
    for s in ('home', 'away'):
        conf = G[s + '_conference'].fillna('')
        p4 = conf.isin(P4_CONFS) | G[s + '_team'].eq('Notre Dame')
        # the Pac-12 of 2024+ is two schools: not a power conference
        p4 &= ~(conf.eq('Pac-12') & (G.season >= 2024))
        G[s + '_p4'] = p4
    ot = ot_flags()
    G = G.merge(ot[['game_id', 'overtime']], on='game_id', how='left')
    return G


def market():
    M = pd.read_parquet(os.path.join(C.OUT, 'stage2', 'market.parquet')).copy()
    # stage-2 spreads are already INTERNAL home margins (+ = home favoured)
    M = M.rename(columns={'spread_open': 'open_margin', 'spread_close': 'close_margin',
                          'spread_close_pin': 'pin_close_margin', 'spread_close_sd': 'close_sd'})
    return M[['game_id', 'open_margin', 'close_margin', 'total_open', 'total_close', 'pin_close_margin',
              'spread_books', 'close_sd', 'source', 'market_qa', 'eval_open_close_flip', 'eval_open_close_jump']]


PRED_COLS = ['game_id', 'ens_pred', 'sigma', 'ens_sd', 'reliability', 'pred_total', 'early_season', 'weeks_in',
             'qb_missing_any', 'qb_unsettled_any', 'rating_sd_sum', 'min_games', 'pred_ma', 'ma_weight_model',
             'pred_C_ridge', 'pred_D_gbm']


def preds():
    P = pd.read_parquet(os.path.join(C.OUT, 'stage7', 'backtest_predictions.parquet'), columns=PRED_COLS + ['season'])
    df = t_df_by_season()
    P['t_df'] = P.season.map(df)
    return P.drop(columns=['season'])


def frame():
    """One row per game: schedule, result, stage-2 market, V2.1 OOF prediction."""
    G = games()
    X = G.merge(market(), on='game_id', how='left').merge(preds(), on='game_id', how='left')
    X['window'] = np.where(X.season.isin(DEV), 'dev', np.where(X.season.isin(HOLDOUT), 'holdout',
                           np.where(X.season >= 2026, 'live', 'pre')))
    # sign-flipped / corrupt openers (the stage-2 evaluation flags use the close: diagnostic only)
    X['open_ok'] = X.open_margin.notna() & ~X.eval_open_close_flip.fillna(False).astype(bool)
    return X


# ----------------------------------------------------------- the archive
_ARCH = {}


def _v1bm():
    os.environ.setdefault('CFB_P4_DATA', os.path.join(C.DATA, 'v1'))
    v1r = os.path.normpath(os.path.join(REPO, 'football', 'cfb_p4', 'research'))
    if v1r not in sys.path:
        sys.path.insert(0, v1r)
    import build_market as V1BM      # noqa: E402  (V1's frozen market builder: side resolution)
    return V1BM


def archive():
    """The raw cfbfastR multi-book archive in the CANONICAL format, one row per
    game x book x kind (OPEN | CLOSE) x market (spread | total):

      spread: home_margin (internal), home_line (book), price_home, price_away
      total : total, price_over, price_under

    Sides are resolved exactly as V1's build_market does (abbr -> team id by
    intersection, never string matching). A book whose two sides disagree about
    the number, or with more than one row for a side, is dropped for that game
    (counted in `qa`). Cached as parquet."""
    if 'x' in _ARCH:
        return _ARCH['x']
    cache = os.path.join(outdir(), 'archive_canonical.parquet')
    qa_p = os.path.join(outdir(), 'archive_qa.json')
    if os.path.exists(cache) and os.path.exists(qa_p):
        A = pd.read_parquet(cache)
        _ARCH['x'] = (A, json.load(open(qa_p)))
        return _ARCH['x']
    V1BM = _v1bm()
    L = V1BM._load_raw()
    amap = V1BM.resolve_abbr_sides(L)
    qa = {'raw_distinct_rows': int(len(L))}
    rows = []
    # ---- spreads
    S = V1BM._side_frame(L, amap)
    S = S[S.market_type.eq('spread') & S.is_home.notna()].copy()
    S['is_home'] = S.is_home.astype(bool)
    qa['spread_side_rows'] = int(len(S))
    for kind, lc, pc in (('CLOSE', 'lines', 'odds'), ('OPEN', 'opening_lines', 'opening_odds')):
        T = S[S[lc].notna()][['game_id', 'season', 'book', 'is_home', lc, pc]].copy()
        T.columns = ['game_id', 'season', 'book', 'is_home', 'line', 'price']
        dup = T.groupby(['game_id', 'book', 'is_home']).line.transform('size') > 1
        bad = set(map(tuple, T[dup][['game_id', 'book']].drop_duplicates().values))
        qa['spread_%s_multi_row_dropped' % kind.lower()] = len(bad)
        T = T[~dup]
        H = T[T.is_home].set_index(['game_id', 'book'])
        A = T[~T.is_home].set_index(['game_id', 'book'])
        J = H.join(A[['line', 'price']], rsuffix='_away', how='outer')
        both = J.line.notna() & J.line_away.notna()
        disagree = both & ~np.isclose(J.line, -J.line_away)
        qa['spread_%s_sides_disagree_dropped' % kind.lower()] = int(disagree.sum())
        J = J[~disagree]
        # a one-sided row still gives the number (the other side is its negation); price only where present
        hl = np.where(J.line.notna(), J.line, -J.line_away)
        out = pd.DataFrame({'game_id': J.index.get_level_values(0).astype('int64'),
                            'book': J.index.get_level_values(1), 'season': J.season.values,
                            'kind': kind, 'market_type': 'spread', 'home_line': hl, 'home_margin': -hl,
                            'price_home': J.price.values, 'price_away': J.price_away.values})
        rows.append(out)
    # ---- totals
    T0 = L[L.market_type.eq('total')].copy()
    T0['ou'] = T0.abbr.str.lower()
    T0 = T0[T0.ou.isin(('over', 'under'))]
    for kind, lc, pc in (('CLOSE', 'lines', 'odds'), ('OPEN', 'opening_lines', 'opening_odds')):
        T = T0[T0[lc].notna() & (T0[lc] > 0)][['game_id', 'season', 'book', 'ou', lc, pc]].copy()
        T.columns = ['game_id', 'season', 'book', 'ou', 'line', 'price']
        dup = T.groupby(['game_id', 'book', 'ou']).line.transform('size') > 1
        T = T[~dup]
        O = T[T.ou.eq('over')].set_index(['game_id', 'book'])
        U = T[T.ou.eq('under')].set_index(['game_id', 'book'])
        J = O.join(U[['line', 'price']], rsuffix='_u', how='outer')
        both = J.line.notna() & J.line_u.notna()
        disagree = both & ~np.isclose(J.line, J.line_u)
        qa['total_%s_sides_disagree_dropped' % kind.lower()] = int(disagree.sum())
        J = J[~disagree]
        tl = np.where(J.line.notna(), J.line, J.line_u)
        out = pd.DataFrame({'game_id': J.index.get_level_values(0).astype('int64'),
                            'book': J.index.get_level_values(1),
                            'season': np.where(J.season.notna(), J.season, J.season_u) if 'season_u' in J else J.season.values,
                            'kind': kind, 'market_type': 'total', 'total': tl,
                            'price_over': J.price.values, 'price_under': J.price_u.values})
        rows.append(out)
    A = pd.concat(rows, ignore_index=True)
    for c in ('price_home', 'price_away', 'price_over', 'price_under'):
        v = pd.to_numeric(A[c], errors='coerce')
        A[c] = np.where(v.abs() >= 100, v, np.nan)             # 0 / |a| < 100 is not a price
    A['book_key'] = A.book.map(book_key)
    A['family'] = A.book_key.map(book_family)
    A['is_book'] = ~A.book_key.isin(NOT_BOOKS)
    A['season'] = pd.to_numeric(A.season, errors='coerce')
    A = A.sort_values(['game_id', 'market_type', 'kind', 'book_key']).reset_index(drop=True)
    qa['canonical_rows'] = int(len(A))
    A.to_parquet(cache, index=False)
    with open(qa_p, 'w') as f:
        json.dump(qa, f, indent=1, sort_keys=True)
    _ARCH['x'] = (A, qa)
    return _ARCH['x']


# --------------------------------------------------------- canonical side
def canonical_sides(row):
    """One archive/Lab spread row (home_line, price_home, price_away) -> the two
    canonical side quotes of the brief's section 2. Both resolve to ONE market
    state: home_market_margin = -home_line."""
    hl = float(row['home_line'])
    out = []
    for side, line, price in (('HOME', hl, row.get('price_home')), ('AWAY', -hl if hl != 0 else 0.0, row.get('price_away'))):
        p = None if price is None or not np.isfinite(price) else float(price)
        b = core.american_to_payout(p) if p is not None else float('nan')
        dec = 1.0 + b if np.isfinite(b) else None
        out.append({'side': side, 'line': line, 'home_market_margin': -hl if hl != 0 else 0.0,
                    'american_odds': p, 'decimal_odds': dec,
                    'implied_probability_raw': (1.0 / dec) if dec else None})
    return out
