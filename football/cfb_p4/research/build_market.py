#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — the market table.

This is the file that changes what the repo is allowed to claim about CFB.
`football/README.md` and `football/params.js` currently state that no public
historical CFB betting-line archive exists. One does:
`sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz` — 1.18M rows,
2006-2025, spread + total + moneyline, OPENING and closing numbers, multiple
books including Pinnacle. Coverage of completed FBS-vs-FBS games is 96-100%
from 2015 on. A real CFB market backtest is therefore possible, and the model
is held to it.

Everything about the file's semantics below was established by execution, not
assumed:

* `game_id` joins 1:1 to the schedules' `game_id`, and the archive's
  `home_team_id`/`away_team_id` match the schedules' `home_id`/`away_id`
  exactly (checked on 2019: 100% agreement).
* `game_desc` is "Away@Home".
* For market_type='spread' and 'money_line', `abbr` names ONE SIDE and the
  row's number belongs to that side (negative spread = favourite). Verified
  on real games: USC (home) -14 / San José State +14, final 30-7.
* For market_type='total', `abbr` is 'over'/'under'.
* `abbr` is a team ABBREVIATION whose vocabulary drifts across eras, so it is
  never string-matched to a school name. Each abbr is resolved to a team_id
  by intersection: the id that appears in EVERY game the abbr appears in.
  That is purely data-derived and survives any renaming.
* `lines`/`odds` are the current (closing) numbers, `opening_lines`/
  `opening_odds` the openers. Both are kept; neither is imputed from the
  other.

EdgeDesk convention on output: `spread_line` is the number of points the HOME
team must win by. Home -14 in book terms becomes spread_line = +14.

Usage: python3 build_market.py <out_dir>
Writes <out>/market.csv (one row per game) and <out>/market_books.csv
(one row per game x book x market, for book-level work such as de-vig).
"""
import os
import sys

import numpy as np
import pandas as pd

import common

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'

SHARP_BOOKS = ('PINNACLE', 'Pinnacle')


def _load_raw():
    p = os.path.join(common.DATA, 'betting', 'cfb_line_odds.csv.gz')
    if not os.path.exists(p):
        raise SystemExit('missing %s — run fetch_data.sh' % p)
    L = pd.read_csv(p, low_memory=False)
    for c in ('game_id', 'season', 'week', 'lines', 'odds', 'opening_lines',
              'opening_odds', 'home_team_id', 'away_team_id'):
        L[c] = pd.to_numeric(L[c], errors='coerce')
    # The archive carries genuine duplicate rows: 1,183,529 raw collapses to
    # ~998,701 distinct. Left in, they double-weight whichever books happen to
    # be duplicated, which quietly biases every consensus median.
    before = len(L)
    L = L.drop_duplicates(subset=['game_id', 'market_type', 'abbr', 'book',
                                  'lines', 'odds', 'opening_lines', 'opening_odds'])
    print('[dedup] %d raw rows -> %d distinct (%.1f%% were duplicates)'
          % (before, len(L), 100.0 * (before - len(L)) / max(before, 1)))
    L = L[L.game_id.notna()].copy()
    L['game_id'] = L.game_id.astype('int64')
    L['abbr'] = L.abbr.astype(str)
    L['book'] = L.book.fillna('unknown').astype(str)
    return L


def resolve_abbr_sides(L):
    """abbr -> team_id, by intersection over every game the abbr appears in.

    An abbr's true team id is the single id present in {home_team_id,
    away_team_id} for ALL of its rows. Counting rather than set-intersecting
    keeps one corrupt row from destroying an otherwise unanimous mapping;
    the agreement rate is reported so a degraded mapping is visible instead
    of silent."""
    side = L[L.market_type.isin(('spread', 'money_line'))].copy()
    side = side[side.abbr.str.lower().ne('nan')]

    long = pd.concat([
        side[['abbr', 'game_id', 'home_team_id']].rename(columns={'home_team_id': 'tid'}),
        side[['abbr', 'game_id', 'away_team_id']].rename(columns={'away_team_id': 'tid'}),
    ], ignore_index=True).dropna(subset=['tid'])

    cnt = long.groupby(['abbr', 'tid']).size().rename('n').reset_index()
    # denominator counts only rows that CARRY ids — otherwise an abbr whose
    # rows simply lack team ids looks like a mapping failure when the mapping
    # was never attempted on them.
    tot = (side[side.home_team_id.notna() & side.away_team_id.notna()]
           .groupby('abbr').size().rename('rows').reset_index())
    best = cnt.sort_values('n').groupby('abbr', as_index=False).last()
    best = best.merge(tot, on='abbr', how='left')
    best['agreement'] = best.n / best.rows
    best['ided_rows'] = best.rows
    return best


def _side_frame(L, amap):
    """spread/moneyline rows tagged home/away."""
    s = L[L.market_type.isin(('spread', 'money_line'))].merge(
        amap[['abbr', 'tid', 'agreement']], on='abbr', how='left')
    s['is_home'] = np.where(s.tid.notna() & (s.tid == s.home_team_id), True,
                    np.where(s.tid.notna() & (s.tid == s.away_team_id), False, None))
    return s


def _median(x):
    x = pd.to_numeric(x, errors='coerce').dropna()
    return float(np.median(x)) if len(x) else np.nan


def build():
    L = _load_raw()
    amap = resolve_abbr_sides(L)
    weak = amap[amap.agreement < 0.99]
    print('[abbr] %d abbreviations resolved; %d below 0.99 agreement'
          % (len(amap), len(weak)))
    if len(weak):
        print(weak.sort_values('agreement').head(12).to_string(index=False))

    S = _side_frame(L, amap)
    unresolved = S.is_home.isna().mean()
    print('[abbr] unresolved side rows: %.4f' % unresolved)
    S = S[S.is_home.notna()].copy()
    S['is_home'] = S.is_home.astype(bool)

    # ---- spreads: keep the HOME side, then flip into EdgeDesk convention ----
    sp = S[S.market_type.eq('spread') & S.is_home].copy()
    sp['spread_line'] = -sp['lines']              # book home -14  ->  +14
    sp['spread_open'] = -sp['opening_lines']

    # ---- totals ----
    to = L[L.market_type.eq('total')].copy()
    to = to[to.abbr.str.lower().isin(('over', 'under', 'nan'))
            | to.abbr.isna() | True]              # abbr is over/under; number is the same either way
    to = to.drop_duplicates(subset=['game_id', 'book', 'lines', 'opening_lines'])

    # ---- moneylines ----
    ml = S[S.market_type.eq('money_line')].copy()

    per_book = []
    for name, d, cols in (
        ('spread', sp, dict(close='spread_line', open='spread_open')),
        ('total', to, dict(close='lines', open='opening_lines')),
    ):
        t = d[['game_id', 'season', 'week', 'book', cols['close'], cols['open']]].copy()
        t.columns = ['game_id', 'season', 'week', 'book', 'close', 'open']
        t['market'] = name
        per_book.append(t)
    mlh = ml[ml.is_home][['game_id', 'season', 'week', 'book', 'odds', 'opening_odds']].copy()
    mlh.columns = ['game_id', 'season', 'week', 'book', 'close', 'open']
    mlh['market'] = 'ml_home'
    mla = ml[~ml.is_home][['game_id', 'season', 'week', 'book', 'odds', 'opening_odds']].copy()
    mla.columns = ['game_id', 'season', 'week', 'book', 'close', 'open']
    mla['market'] = 'ml_away'
    per_book += [mlh, mla]
    BK = pd.concat(per_book, ignore_index=True)
    BK = BK[BK.game_id.notna()]

    def agg(market, prefix):
        d = BK[BK.market.eq(market)]
        g = d.groupby('game_id').agg(
            **{prefix + '_close': ('close', _median),
               prefix + '_open': ('open', _median),
               prefix + '_books': ('book', 'nunique'),
               prefix + '_close_sd': ('close', lambda x: float(pd.to_numeric(x, errors='coerce').std()))})
        sharp = d[d.book.isin(SHARP_BOOKS)].groupby('game_id').agg(
            **{prefix + '_close_pin': ('close', _median),
               prefix + '_open_pin': ('open', _median)})
        return g.join(sharp, how='left')

    M = agg('spread', 'spread')
    M = M.join(agg('total', 'total'), how='outer')
    M = M.join(agg('ml_home', 'mlh'), how='outer')
    M = M.join(agg('ml_away', 'mla'), how='outer')
    M = M.reset_index()

    g = common.load_schedules()[['game_id', 'season', 'week', 'home_team', 'away_team',
                                 'home_key', 'away_key', 'home_fbs', 'away_fbs',
                                 'neutral', 'played', 'margin', 'total_pts']]
    M = M.merge(g, on='game_id', how='inner')

    # data-quality flag: a single-book number with no opener is context, not a market
    M['mkt_quality'] = np.where(
        (M.spread_books.fillna(0) >= 3) & M.spread_close.notna(), 'consensus',
        np.where(M.spread_close.notna(), 'thin', 'none'))
    M['has_open'] = M.spread_open.notna()

    os.makedirs(OUT, exist_ok=True)
    M.to_csv(os.path.join(OUT, 'market.csv'), index=False)
    BK.to_csv(os.path.join(OUT, 'market_books.csv'), index=False)

    fbs = M[M.home_fbs & M.away_fbs & M.played]
    cov = fbs.groupby('season').agg(
        games=('game_id', 'nunique'),
        with_spread=('spread_close', lambda s: int(s.notna().sum())),
        with_open=('spread_open', lambda s: int(s.notna().sum())),
        with_total=('total_close', lambda s: int(s.notna().sum())),
        with_ml=('mlh_close', lambda s: int(s.notna().sum())),
        med_books=('spread_books', 'median'))
    all_g = common.fbs_games().groupby('season').game_id.nunique().rename('sched_games')
    cov = cov.join(all_g)
    cov['pct_spread'] = (cov.with_spread / cov.sched_games * 100).round(1)
    cov['pct_open'] = (cov.with_open / cov.sched_games * 100).round(1)
    print(cov.to_string())

    # sanity: the market must predict the result it priced
    ok = fbs.dropna(subset=['spread_close', 'margin'])
    print('\n[sanity] corr(spread_close, margin) = %.3f  (must be strongly POSITIVE '
          'under the EdgeDesk convention)' % ok.spread_close.corr(ok.margin))
    print('[sanity] mean(margin - spread_close) = %.3f  (must be ~0)'
          % float((ok.margin - ok.spread_close).mean()))
    print('[sanity] home cover rate = %.4f' % float((ok.margin > ok.spread_close).mean()))
    tt = fbs.dropna(subset=['total_close', 'total_pts'])
    print('[sanity] corr(total_close, total_pts) = %.3f' % tt.total_close.corr(tt.total_pts))
    print('[sanity] mean(total_pts - total_close) = %.3f' % float((tt.total_pts - tt.total_close).mean()))
    return M


if __name__ == '__main__':
    build()
