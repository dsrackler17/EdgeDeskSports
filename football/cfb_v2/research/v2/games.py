"""Stage 2 — the game table (pure context + targets) and the SEPARATE market table.

Two files, never merged inside the pure path:

  games.parquet   identifiers, schedule context, point-in-time timestamps and the
                  TARGETS (final points). Context features derived here (rest,
                  travel, time zone, altitude) are knowable from the schedule.
  market.parquet  opening / closing consensus lines, ALREADY converted to the
                  internal home-margin convention at this boundary.

A game with no final score and a kickoff in the past is `status='NOT_PLAYED'`
(postponed or cancelled): it stays in the table, is never scored, and is never
absorbed into a rating.
"""
import math
import sys
from datetime import timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import config as C
from . import common


def _haversine(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2) - np.radians(lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def _tz_offset_hours(tzname, when):
    if not isinstance(tzname, str) or not tzname:
        return np.nan
    try:
        return when.astimezone(ZoneInfo(tzname)).utcoffset().total_seconds() / 3600.0
    except Exception:
        return np.nan


def load_teaminfo(season):
    """Home-venue geography per team. The cfbfastR team_info file for a season
    carries the team's home stadium; geography is static, so the nearest
    available season is used when a season file is missing."""
    import os
    for s in [season] + [season + k for k in (-1, 1, -2, 2, -3, 3)]:
        f = os.path.join(C.DATA, '..', 'data', 'teaminfo', 'ti_%d.parquet' % s)
        f2 = common.data_path('teaminfo', 'ti_%d.parquet' % s)
        for ff in (f2, f):
            if os.path.exists(ff):
                t = pd.read_parquet(ff, columns=['team_id', 'latitude', 'longitude', 'elevation',
                                                 'timezone', 'dome', 'classification'])
                t['team_id'] = pd.to_numeric(t.team_id, errors='coerce')
                return t.dropna(subset=['team_id']).drop_duplicates('team_id').set_index('team_id')
    return pd.DataFrame(columns=['latitude', 'longitude', 'elevation', 'timezone', 'dome'])


def build_games(seasons):
    frames = []
    for S in seasons:
        g = pd.read_parquet(common.out_path('stage1', 'games_%d.parquet' % S))
        frames.append(g)
    G = pd.concat(frames, ignore_index=True)
    G = G[G.game_id.notna()].copy()
    G['game_id'] = G.game_id.astype('int64')
    before = len(G)
    G = G.drop_duplicates('game_id')
    dup_ids = before - len(G)
    G['home_fbs'] = G.home_division.eq('fbs')
    G['away_fbs'] = G.away_division.eq('fbs')
    G = G[G.home_fbs | G.away_fbs].copy()
    G['kickoff_ts'] = pd.to_datetime(G.start_date, utc=True, errors='coerce')
    G = G[G.kickoff_ts.notna()]
    # same two teams on the same calendar day twice = a feed duplicate under a new id
    G['_d'] = G.kickoff_ts.dt.date
    G['_pair'] = [tuple(sorted((a, b))) for a, b in zip(G.home_id, G.away_id)]
    before = len(G)
    G = G.sort_values(['game_id']).drop_duplicates(['_pair', '_d'], keep='first')
    dup_pairs = before - len(G)
    G = G.drop(columns=['_d', '_pair'])
    G['prediction_ts'] = [common.prediction_ts_for_kickoff(k.to_pydatetime()) for k in G.kickoff_ts]
    G['prediction_ts'] = pd.to_datetime(G.prediction_ts, utc=True)
    G['neutral_site'] = G.neutral_site.fillna(False).astype(bool)
    G['conference_game'] = G.conference_game.fillna(False).astype(bool)
    played = G.home_points.notna() & G.away_points.notna()
    G['status'] = np.where(played, 'FINAL',
                           np.where(G.kickoff_ts < pd.Timestamp.now(tz='UTC'), 'NOT_PLAYED', 'SCHEDULED'))
    G['margin'] = np.where(played, G.home_points - G.away_points, np.nan)
    G['total_pts'] = np.where(played, G.home_points + G.away_points, np.nan)
    G['is_postseason'] = G.season_type.astype(str).str.lower().eq('postseason')
    G['fcs_game'] = ~(G.home_fbs & G.away_fbs)

    # ---------------------------------------------------------- rest days
    long = pd.concat([
        G[['game_id', 'season', 'kickoff_ts', 'home_id']].rename(columns={'home_id': 'team_id'}),
        G[['game_id', 'season', 'kickoff_ts', 'away_id']].rename(columns={'away_id': 'team_id'}),
    ]).sort_values(['team_id', 'kickoff_ts'])
    long['prev'] = long.groupby(['team_id', 'season']).kickoff_ts.shift(1)
    long['rest_days'] = (long.kickoff_ts - long.prev).dt.total_seconds() / 86400.0
    rest = long.set_index(['game_id', 'team_id']).rest_days
    G['home_rest'] = [rest.get((a, b), np.nan) for a, b in zip(G.game_id, G.home_id)]
    G['away_rest'] = [rest.get((a, b), np.nan) for a, b in zip(G.game_id, G.away_id)]
    G['rest_diff'] = (G.home_rest.clip(upper=21) - G.away_rest.clip(upper=21))

    # ------------------------------------------------- travel / tz / altitude
    tv, tz, alt = [], [], []
    ti_cache = {}
    for r in G.itertuples(index=False):
        ti = ti_cache.get(r.season)
        if ti is None:
            ti = ti_cache[r.season] = load_teaminfo(r.season)
        h = ti.loc[r.home_id] if r.home_id in ti.index else None
        a = ti.loc[r.away_id] if r.away_id in ti.index else None
        if r.neutral_site or h is None or a is None:
            tv.append(np.nan); tz.append(np.nan); alt.append(np.nan)
            continue
        tv.append(float(_haversine(h.latitude, h.longitude, a.latitude, a.longitude)))
        when = r.kickoff_ts.to_pydatetime()
        tz.append(_tz_offset_hours(h.timezone, when) - _tz_offset_hours(a.timezone, when))
        try:
            alt.append(float(h.elevation) - float(a.elevation))
        except (TypeError, ValueError):
            alt.append(np.nan)
    G['travel_miles'] = tv
    G['tz_shift'] = tz
    G['altitude_diff_ft'] = np.array(alt) * 3.28084
    report = dict(games=len(G), duplicate_ids_dropped=int(dup_ids),
                  duplicate_pair_day_dropped=int(dup_pairs),
                  not_played=int((G.status == 'NOT_PLAYED').sum()))
    return G.sort_values(['kickoff_ts', 'game_id']).reset_index(drop=True), report


# ------------------------------------------------------------------ market
def build_market(G, v1_market_csv, mline_dir):
    """Opening / closing consensus, INTERNAL convention (home margin, + = home favoured).

    Primary 2006-2025: the cfbfastR multi-book archive as built by V1's
    build_market.py (already margin convention, verified corr(close, margin) > 0).
    Secondary / 2026: CFBD /lines provider mean from the cfb_matchup_line
    release, which is in BOOK convention and is converted here, once."""
    import os
    rows = []
    if os.path.exists(v1_market_csv):
        m = pd.read_csv(v1_market_csv, low_memory=False)
        m = m[['game_id', 'spread_open', 'spread_close', 'spread_books', 'spread_close_sd',
               'total_open', 'total_close', 'spread_close_pin', 'spread_open_pin']].copy()
        m['source'] = 'cfbfastR_multibook_archive'
        rows.append(m)
    cf = []
    for f in sorted(os.listdir(mline_dir)) if os.path.isdir(mline_dir) else []:
        d = pd.read_parquet(os.path.join(mline_dir, f),
                            columns=['game_id', 'spread_open', 'spread', 'over_under', 'over_under_open'])
        cf.append(d)
    if cf:
        c = pd.concat(cf, ignore_index=True)
        c = pd.DataFrame({
            'game_id': c.game_id,
            # BOOK -> INTERNAL, the one conversion
            'spread_open': [common.book_home_line_to_margin(x) for x in c.spread_open],
            'spread_close': [common.book_home_line_to_margin(x) for x in c.spread],
            'total_open': c.over_under_open, 'total_close': c.over_under,
            'spread_books': np.nan, 'spread_close_sd': np.nan,
            'spread_close_pin': np.nan, 'spread_open_pin': np.nan,
            'source': 'cfbd_lines_provider_mean'})
        rows.append(c)
    M = pd.concat(rows, ignore_index=True)
    M['game_id'] = pd.to_numeric(M.game_id, errors='coerce')
    M = M.dropna(subset=['game_id'])
    M['game_id'] = M.game_id.astype('int64')
    # prefer the multi-book archive; CFBD fills what it does not carry
    M['_rank'] = M.source.map({'cfbfastR_multibook_archive': 0, 'cfbd_lines_provider_mean': 1})
    M = M.sort_values(['game_id', '_rank']).drop_duplicates('game_id').drop(columns='_rank')
    M = M[M.game_id.isin(G.game_id)].copy()
    # ---- market QA at the ingestion boundary. A bad number is DROPPED, never
    # repaired: guessing a convention from values is what produced every
    # sign bug this project has had (football/README.md). Found by execution:
    # openers of -185 and +334, and openers whose sign is flipped relative to
    # the close (2021 Big Ten title game opens 'Iowa -10.5', closes 'Michigan -12').
    M['market_qa'] = ''
    for col in ('spread_open', 'spread_close'):
        bad = M[col].abs() > 60
        M.loc[bad, 'market_qa'] += col + '_implausible;'
        M.loc[bad, col] = np.nan
    mv = (M.spread_close - M.spread_open).abs()
    flip = ((M.spread_open + M.spread_close).abs() <= 3) & (mv > 10)
    jump = (mv > 14) & ~flip
    M.loc[flip, 'market_qa'] += 'open_sign_flipped_vs_close;'
    M.loc[jump, 'market_qa'] += 'open_to_close_jump_gt_14;'
    M.loc[flip | jump, 'spread_open'] = np.nan
    # the archive's opener is missing for all of 2020 and before 2012; never imputed
    M['has_open'] = M.spread_open.notna()
    M['has_close'] = M.spread_close.notna()
    return M


def main():
    seasons = list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
    G, rep = build_games(seasons)
    G.to_parquet(common.out_path('stage2', 'games.parquet'), index=False)
    import os
    M = build_market(G, os.environ.get('CFB_V2_V1_MARKET', ''), common.data_path('mline'))
    M.to_parquet(common.out_path('stage2', 'market.parquet'), index=False)
    j = G.merge(M, on='game_id', how='inner')
    j = j[j.status.eq('FINAL') & j.spread_close.notna()]
    rep['market_rows'] = len(M)
    rep['market_qa_dropped'] = M.market_qa.str.split(';').explode().replace('', np.nan).dropna().value_counts().to_dict()
    rep['sanity_corr_close_margin'] = float(j.spread_close.corr(j.margin))
    rep['sanity_mean_margin_minus_close'] = float((j.margin - j.spread_close).mean())
    assert rep['sanity_corr_close_margin'] > 0.5, 'market sign convention broken at ingestion'
    common.write_json(common.out_path('stage2', 'report.json'), rep)
    print('[stage2]', rep)


if __name__ == '__main__':
    main()
