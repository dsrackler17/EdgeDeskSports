"""Stage 2 — the game table (pure context + targets) and the SEPARATE market table.

Two files, never merged inside the pure path:

  games.parquet   identifiers, schedule context, point-in-time timestamps and the
                  TARGETS (final points). Context features derived here (rest,
                  travel, time zone, altitude) are knowable from the schedule.
  market.parquet  opening / closing consensus lines, ALREADY converted to the
                  internal home-margin convention at this boundary.

Finality (rule `FINALITY_RULE`, audit finding F-01). A game is a RESULT
(`status='FINAL'`, margin and total set) only when the provider marks it
`completed == True`, both scores are present, nothing contradicts the claim
(an in-progress provider status, or a play-by-play whose `status_type_completed`
is false) and the score is not a tie (impossible in college football since 1996
overtime: a completed tie is a placeholder). Every other row keeps its own
status and is NEVER a result: margin and total are NaN, and no rating, Elo, QB
state or grade reads it.

  FINAL        completed, both scores, uncontradicted, not a tie
  IN_PROGRESS  a partial score (completed false), or a completed claim that the
               provider status or the play-by-play contradicts
  CANCELED     provider STATUS_CANCELED, a forfeit, or 'cancel' in the notes of
               an uncompleted game (the 2024 App State-Liberty 0-0 row)
  POSTPONED    provider STATUS_POSTPONED, or 'postpon' in the notes of an
               uncompleted game
  DATA_ERROR   completed with a missing score, or a completed tie
  NOT_PLAYED   no score, not completed, kickoff in the past
  SCHEDULED    no score, not completed, kickoff in the future

The weekly engine's `weekly.validate.finality` applies the SAME classifier
(`classify_result`), so the two can never disagree about what is final, and the
engine's VERIFY_COMPLETED_GAMES stage refuses a stage-2 table that does.
CANCELED and POSTPONED games also do not count as the previous game when rest
days are computed: they did not take place on that date.
"""
import math
import sys
from datetime import timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import config as C
from . import common

# --------------------------------------------------------------- finality (F-01)
FINALITY_RULE = 'cfb_v2_finality_v2'      # v1 (<= v2.1.0): "both scores present" = FINAL
FINAL_STATUSES = {'STATUS_FINAL'}
IN_PROGRESS_STATUSES = {'STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD',
                        'STATUS_DELAYED', 'STATUS_RAIN_DELAY', 'STATUS_SUSPENDED',
                        'STATUS_SCHEDULED'}
POSTPONED_STATUSES = {'STATUS_POSTPONED'}
CANCELED_STATUSES = {'STATUS_CANCELED', 'STATUS_CANCELLED'}
# the only status that is a result; everything else has margin NaN
RESULT_STATUS = 'FINAL'
STAGE2_STATUSES = ('FINAL', 'IN_PROGRESS', 'CANCELED', 'POSTPONED', 'DATA_ERROR', 'NOT_PLAYED', 'SCHEDULED')


def _flag(v):
    """A provider boolean: True / False, or None when missing."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return bool(v)


def _points(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def _text(v):
    t = '' if v is None else str(v)
    return '' if t.strip().lower() in ('', 'nan', 'none', '<na>') else t


def classify_result(completed, provider_status, notes, home_points, away_points, pbp_completed=None):
    """(status, reason, sources_agree) for one schedule row, ignoring the clock.

    status is FINAL | IN_PROGRESS | CANCELED | POSTPONED | DATA_ERROR, or None when the
    row carries no result claim at all (the caller decides SCHEDULED / NOT_PLAYED /
    IN_PROGRESS from the kickoff). First match wins:
      1. provider CANCELED, a forfeit, or 'cancel' in the notes of an uncompleted game -> CANCELED
      2. provider POSTPONED, or 'postpon' in the notes of an uncompleted game -> POSTPONED
      3. completed with both scores:
           provider status in progress, or PBP status_type_completed false -> IN_PROGRESS
           (the sources disagree; never a result until they agree)
           a tie -> DATA_ERROR (college football has had overtime since 1996)
           otherwise -> FINAL
      4. completed without both scores -> DATA_ERROR
      5. not completed with a score (a partial score) -> IN_PROGRESS
      6. not completed, no score, provider status in progress -> IN_PROGRESS
      7. otherwise None
    `completed` must be exactly True for FINAL: a missing flag is not a completion."""
    st = _text(provider_status).upper()
    nl = _text(notes).lower()
    comp = _flag(completed) is True
    hp, ap = _points(home_points), _points(away_points)
    both = hp is not None and ap is not None
    anyp = hp is not None or ap is not None
    if st in CANCELED_STATUSES:
        return 'CANCELED', 'provider status %s' % st, True
    if 'forfeit' in nl:
        return 'CANCELED', 'forfeit: result recorded without a game played (%s)' % _text(notes), True
    if 'cancel' in nl and not comp:
        return 'CANCELED', 'canceled per schedule notes (%s)' % _text(notes), True
    if st in POSTPONED_STATUSES or ('postpon' in nl and not comp):
        return 'POSTPONED', 'provider status %s' % (st or 'notes: ' + _text(notes)), True
    if comp and both:
        why = []
        if st in IN_PROGRESS_STATUSES:
            why.append('provider status %s' % st)
        if _flag(pbp_completed) is False:
            why.append('PBP status_type_completed is false')
        if why:
            return 'IN_PROGRESS', 'sources disagree: completed flag and a score but %s' % ' and '.join(why), False
        if hp == ap:
            return 'DATA_ERROR', 'completed tie %g-%g: impossible in college football (overtime since 1996)' % (hp, ap), True
        return 'FINAL', None, True
    if comp:
        return 'DATA_ERROR', 'schedule marks the game completed but a final score is missing', True
    if anyp:
        return 'IN_PROGRESS', 'a score without the completed flag (partial score%s)' % (
            ', provider status %s' % st if st else ''), st not in FINAL_STATUSES
    if st in IN_PROGRESS_STATUSES:
        return 'IN_PROGRESS', 'provider status %s' % st, True
    return None, None, True


def finality_inputs(season):
    """Per game of `season`: the provider status (schedule `status`, which stage 1 does
    not keep) and the play-by-play completion flag, read from the raw files exactly as
    the weekly engine's validator reads them (None when a game has no PBP flag)."""
    import os
    import pyarrow.parquet as pq
    f = common.data_path('sched', 'cfb_schedules_%d.parquet' % season)
    s = pd.read_parquet(f, columns=[c for c in ('game_id', 'status') if c in pq.ParquetFile(f).schema_arrow.names])
    s['game_id'] = pd.to_numeric(s.game_id, errors='coerce')
    s = s[s.game_id.notna()].drop_duplicates('game_id')
    out = pd.DataFrame({'game_id': s.game_id.astype('int64').values,
                        'provider_status': s['status'].astype(object).values if 'status' in s else None})
    pf = common.data_path('pbp', 'play_by_play_%d.parquet' % season)
    pc = {}
    if os.path.exists(pf) and 'status_type_completed' in pq.ParquetFile(pf).schema_arrow.names:
        p = pd.read_parquet(pf, columns=['game_id', 'status_type_completed'])
        p['game_id'] = pd.to_numeric(p.game_id, errors='coerce')
        p = p[p.game_id.notna()]
        agg = p.groupby('game_id').status_type_completed.agg(
            lambda v: None if v.isna().all() else bool(v.dropna().astype(bool).all()))
        pc = {int(k): v for k, v in agg.items()}
    out['pbp_completed'] = [pc.get(int(g)) for g in out.game_id]
    return out


def assign_status(G, now=None):
    """Set status / margin / total_pts / status_reason on a stage-2 frame that carries
    completed, provider_status, pbp_completed, notes, the scores and kickoff_ts."""
    now = pd.Timestamp.now(tz='UTC') if now is None else now
    st, why = [], []
    for r in G.itertuples(index=False):
        s, w, _ = classify_result(getattr(r, 'completed', None), getattr(r, 'provider_status', None),
                                  getattr(r, 'notes', None), r.home_points, r.away_points,
                                  getattr(r, 'pbp_completed', None))
        if s is None:
            s = 'NOT_PLAYED' if r.kickoff_ts < now else 'SCHEDULED'
        st.append(s)
        why.append(w)
    G['status'] = st
    fin = G.status.eq(RESULT_STATUS).values
    G['margin'] = np.where(fin, G.home_points - G.away_points, np.nan)
    G['total_pts'] = np.where(fin, G.home_points + G.away_points, np.nan)
    return G, why


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
    # finality (F-01): FINAL needs the provider's completed flag; the provider status and
    # the PBP completion flag come from the raw files (stage 1 keeps neither)
    fi = pd.concat([finality_inputs(S) for S in sorted(G.season.dropna().astype(int).unique())], ignore_index=True)
    fi = fi.drop_duplicates('game_id')
    G = G.merge(fi, on='game_id', how='left')
    G, reasons = assign_status(G)
    G['is_postseason'] = G.season_type.astype(str).str.lower().eq('postseason')
    G['fcs_game'] = ~(G.home_fbs & G.away_fbs)

    # ---------------------------------------------------------- rest days
    # a CANCELED or POSTPONED game did not take place on its date: it is not the
    # previous game of either team (F-01; only the 2024 App State-Liberty row, 2009-2025)
    took_place = G[~G.status.isin(['CANCELED', 'POSTPONED'])]
    long = pd.concat([
        took_place[['game_id', 'season', 'kickoff_ts', 'home_id']].rename(columns={'home_id': 'team_id'}),
        took_place[['game_id', 'season', 'kickoff_ts', 'away_id']].rename(columns={'away_id': 'team_id'}),
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
                  not_played=int((G.status == 'NOT_PLAYED').sum()),
                  finality_rule=FINALITY_RULE,
                  status_counts={k: int(v) for k, v in G.status.value_counts().sort_index().items()},
                  not_a_result=[{'game_id': int(g), 'season': int(se), 'status': st, 'reason': w}
                                for g, se, st, w in zip(G.game_id, G.season, G.status, reasons)
                                if st in ('IN_PROGRESS', 'CANCELED', 'POSTPONED', 'DATA_ERROR')])
    # the two finality helper columns are inputs, not part of the stage-2 schema
    G = G.drop(columns=['provider_status', 'pbp_completed'])
    check_finality(G)
    return G.sort_values(['kickoff_ts', 'game_id']).reset_index(drop=True), report


def check_finality(G):
    """Stage-2 invariants (F-01): only FINAL rows are results, every FINAL row is a
    completed, decided game."""
    bad = set(G.status) - set(STAGE2_STATUSES)
    assert not bad, 'unknown stage-2 status %s' % sorted(bad)
    fin = G.status.eq(RESULT_STATUS)
    assert G.loc[fin, 'completed'].map(lambda v: _flag(v) is True).all(), 'FINAL without completed == True'
    assert G.loc[fin, 'margin'].notna().all() and G.loc[fin, 'margin'].ne(0).all(), 'FINAL without a decided margin'
    assert G.loc[~fin, 'margin'].isna().all() and G.loc[~fin, 'total_pts'].isna().all(), \
        'a non-FINAL row carries a result'
    return True


# ------------------------------------------------------------------ market
# Orientation QA carried from V1's build_market.py (rule cfb_market_orientation_v2,
# audit F-11): the team ids the archive rows were oriented by, whether the archive's
# own ids were swapped vs the schedule, how the sides were resolved, and the book lines
# the sign rule dropped. An archive built before the fix has none of them.
MARKET_ORIENTATION_COLS = ('orient_home_id', 'orient_away_id', 'archive_ids_swapped', 'side_resolution',
                           'spread_open_books_dropped', 'spread_close_books_dropped',
                           'spread_open_sign_unresolved', 'spread_close_sign_unresolved',
                           'market_orientation_rule')


def orient_by_team_id(M, G):
    """The archive's consensus is a HOME margin for the home team V1's schedule names.
    Check it against THIS schedule's ids: the same orientation is kept, the reverse is
    negated (flagged `market_reoriented`), anything else is dropped (`market_qa`
    team_mismatch). A pre-fix archive (no orient ids) passes through unchanged."""
    M['market_reoriented'] = False
    M['_team_mismatch'] = False
    if 'orient_home_id' not in M.columns:
        return M
    ids = G.set_index('game_id')[['home_id', 'away_id']]
    h = M.game_id.map(ids.home_id)
    a = M.game_id.map(ids.away_id)
    arch = M.source.eq('cfbfastR_multibook_archive') & M.orient_home_id.notna()
    same = arch & (M.orient_home_id == h) & (M.orient_away_id == a)
    rev = arch & (M.orient_home_id == a) & (M.orient_away_id == h) & ~same
    bad = arch & ~same & ~rev
    for c in ('spread_open', 'spread_close', 'spread_close_pin', 'spread_open_pin'):
        M.loc[rev, c] = -M.loc[rev, c]
    M.loc[rev, 'market_reoriented'] = True
    for c in ('spread_open', 'spread_close', 'spread_close_pin', 'spread_open_pin', 'total_open', 'total_close'):
        M.loc[bad, c] = np.nan
    M['_team_mismatch'] = bad
    return M


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
        qa = [c for c in MARKET_ORIENTATION_COLS if c in m.columns]
        m = m[['game_id', 'spread_open', 'spread_close', 'spread_books', 'spread_close_sd',
               'total_open', 'total_close', 'spread_close_pin', 'spread_open_pin'] + qa].copy()
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
    M = orient_by_team_id(M, G)
    # ---- market QA at the ingestion boundary. A bad number is DROPPED, never
    # repaired: guessing a convention from values is what produced every
    # sign bug this project has had (football/README.md). Found by execution:
    # openers of -185 and +334, and openers whose sign is flipped relative to
    # the close (2021 Big Ten title game opens 'Iowa -10.5', closes 'Michigan -12').
    M['market_qa'] = ''
    tm = M.pop('_team_mismatch').fillna(False).astype(bool)
    M.loc[tm, 'market_qa'] += 'team_mismatch;'
    for col in ('spread_open', 'spread_close'):
        bad = M[col].abs() > 60
        M.loc[bad, 'market_qa'] += col + '_implausible;'
        M.loc[bad, col] = np.nan
    # Candidate 001 DROPPED openers that were sign-flipped or > 14 pts away from
    # the close: that decides which openers exist by looking at a number that
    # did not exist yet (red-team finding). They are now FLAGGED for evaluation
    # only and kept. A genuinely flipped opener is caught at decision time the
    # way production catches it: the orientation guard (model vs market sign)
    # routes it to REVIEW, never to an edge.
    mv = (M.spread_close - M.spread_open).abs()
    M['eval_open_close_flip'] = ((M.spread_open + M.spread_close).abs() <= 3) & (mv > 10)
    M['eval_open_close_jump'] = (mv > 14) & ~M.eval_open_close_flip
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
    mo = sorted(M.market_orientation_rule.dropna().unique()) if 'market_orientation_rule' in M else []
    has_archive = M.source.eq('cfbfastR_multibook_archive').any()
    rep['market_orientation_rule'] = mo[0] if len(mo) == 1 else (
        'none (no multi-book archive: CFBD provider lines only)' if not has_archive else
        'cfb_market_orientation_v1 (archive built before the F-11 fix)' if not mo else 'mixed %s' % mo)
    rep['market_reoriented_games'] = int(M.market_reoriented.sum())
    rep['market_team_mismatch_games'] = int(M.market_qa.str.contains('team_mismatch').sum())
    for c in ('spread_open_books_dropped', 'spread_close_books_dropped'):
        if c in M:
            rep[c + '_games'] = int((M[c].fillna(0) > 0).sum())
    common.write_json(common.out_path('stage2', 'report.json'), rep)
    common.stamp_build('stage2', finality_rule=FINALITY_RULE, market_orientation_rule=rep['market_orientation_rule'],
                       games=int(len(G)), status_counts=rep['status_counts'])
    print('[stage2]', rep)


if __name__ == '__main__':
    main()
