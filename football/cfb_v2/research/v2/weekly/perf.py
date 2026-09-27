"""Game performance objects, expected performance margin, turnover luck, explosive
dependency and drive metrics (season and recency). METHODS_GAMES.md section 3.

  game_performance(season, T=None, validation=None) -> one row per team-game
  team_summary(season, T, perf=None)               -> one row per team, as of T
  fit_expected_margin(write=True) / load_expected_margin()

Filtered ("non-garbage") numbers use V2's exact definitions (plays.build_season:
the scrimmage-play set, garbage weight 0, the drive table, trench and havoc
metrics from raw yardage); raw numbers are the same formulas with every play
weighted 1. The filtered sums equal out/stage1/team_game_<S>.parquet to float
precision (tests_games checks it), so the stage1 aggregation is reused as a
definition while every season is recomputed from the current PBP (a live season's
stage1 file can be stale). Special teams are V2's (never garbage-filtered).

Everything estimated from data is estimated on the development seasons only
(config.DEV_SEASONS, 2016-2023) and frozen in the artifact
football/cfb_v2/artifacts/weekly/expected_margin_v1.json.
"""
import hashlib
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import plays as V2P
from . import ids
from . import validate as VAL

PERF_VERSION = 'cfb_perf_v1'
ARTIFACT_VERSION = 'cfb_expected_margin_v1'
REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
ARTIFACT_PATH = os.path.join(REPO_V2, 'artifacts', 'weekly', 'expected_margin_v1.json')

CLOSE_GAME_MARGIN = 8            # "close game" = decided by one score or less
EXPLOSIVE_K_MIN, EXPLOSIVE_K_MAX = 50.0, 5000.0
INT_K_MIN, INT_K_MAX = 100.0, 20000.0

# expected performance margin: home-minus-away differentials of non-garbage offense
# metrics in the same game (home offense value minus the value home's defense allowed)
EM_FEATURES = [
    ('em_epa', 'off_epa_pp'),          # EPA per play
    ('em_sr', 'off_sr'),               # success rate
    ('em_drive_epa', 'off_drive_epa'), # drive efficiency: EPA per drive
    ('em_so_rate', 'off_so_rate'),     # scoring opportunities per drive
    ('em_start_fp', 'off_start_fp'),   # average start, yards to the end zone (lower = better)
    ('em_havoc', 'off_havoc_rate'),    # havoc suffered by the offense (sacks + run TFLs)
    ('em_expl', 'off_expl_rate'),      # explosive plays per play
]

# rate metrics: name, numerator, denominator (the V2 sum columns)
RATE_METRICS = [
    ('epa_pp', 'epa_sum', 'n_plays'),
    ('epa_pass', 'epa_pass_sum', 'n_db'),
    ('epa_rush', 'epa_rush_sum', 'n_rush'),
    ('sr', 'succ', 'n_plays'),
    ('sr_pass', 'succ_pass', 'n_db'),
    ('sr_rush', 'succ_rush', 'n_rush'),
    ('sr_early', 'succ_early', 'n_early'),
    ('sr_pd', 'succ_pd', 'n_pd'),
    ('expl_rate', 'expl', 'n_plays'),
    ('expl_epa_share', 'expl_epa', 'pos_epa'),
    ('havoc_rate', 'havoc', 'n_plays'),
    ('sack_rate', 'sacks', 'n_db'),
    ('line_yds', 'line_yds', 'n_rush'),
    ('stuff_rate', 'stuff', 'n_rush'),
    ('so_rate', 'scoring_opps', 'n_drives'),
    ('pts_per_opp', 'opp_pts', 'scoring_opps'),
    ('drive_epa', 'drive_epa_sum', 'n_drives'),
    ('ppd', 'drive_pts', 'n_drives'),
    ('start_fp', 'start_ytg_sum', 'n_drives'),
]
OFF_SUMS = ['n_plays', 'epa_sum', 'succ', 'expl', 'n_db', 'epa_pass_sum', 'succ_pass', 'expl_pass',
            'sacks', 'n_rush', 'epa_rush_sum', 'succ_rush', 'expl_rush', 'line_yds', 'stuff',
            'opp_run', 'n_early', 'succ_early', 'n_pd', 'succ_pd', 'n_3rd', 'conv_3rd', 'havoc',
            'turnovers', 'expl_epa', 'pos_epa']
DRIVE_SUMS = ['n_drives', 'drive_pts', 'scoring_opps', 'opp_pts', 'start_ytg_sum', 'drive_epa_sum',
              'td', 'fg', 'three_out', 'xp_start_sum']
# drive metrics reported per game, season to date and recency weighted: name, num, den
DRIVE_METRICS = [
    ('ppd', 'drive_pts', 'n_drives'),            # points per drive (V2 7/3/0 convention)
    ('xp_start', 'xp_start_sum', 'n_drives'),    # expected points per drive (EP at the drive start)
    ('so_rate', 'scoring_opps', 'n_drives'),
    ('td_rate', 'td', 'n_drives'),
    ('fg_rate', 'fg', 'n_drives'),
    ('three_out_rate', 'three_out', 'n_drives'),
    ('start_fp', 'start_ytg_sum', 'n_drives'),   # average start, yards to the end zone
    ('value', 'drive_epa_sum', 'n_drives'),      # average drive value: EPA per drive
]
TD_RESULTS = ['TD', 'PASSING TD', 'RUSHING TD']          # V2's drive-points mapping
FG_RESULTS = ['FG', 'FG GOOD', 'FIELD GOAL']
LOST_FUMBLE_TYPES = ('Fumble Return Touchdown', 'Fumble Recovery (Opponent) Touchdown')

EXTRA_PBP_COLS = ['type.text', 'fumble_vec', 'fumbling_team', 'forced_fumble', 'defense_score_play',
                  'EP_start', 'status_type_completed', 'homeTeamId', 'awayTeamId']
assert not set(EXTRA_PBP_COLS) & set(V2P.FORBIDDEN_PBP_COLUMNS)


def _b(s):
    return s.fillna(False).astype(bool)


def _div(a, b):
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    with np.errstate(divide='ignore', invalid='ignore'):
        return np.where(b > 0, a / np.where(b > 0, b, 1.0), np.nan)


def _sig(x, k=12):
    """Round to k significant digits (stable JSON across BLAS builds)."""
    if x is None or not np.isfinite(x):
        return None
    return float('%.*g' % (k, float(x)))


# ------------------------------------------------------------------- loading
def load_plays(season):
    import pyarrow.parquet as pq
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % season)
    names = set(pq.ParquetFile(f).schema_arrow.names)
    want = list(dict.fromkeys(V2P.PBP_COLS + EXTRA_PBP_COLS))
    assert not set(want) & set(V2P.FORBIDDEN_PBP_COLUMNS), 'market/WP column requested from pbp'
    d = pd.read_parquet(f, columns=[c for c in want if c in names])
    for c in want:
        if c not in d.columns:
            d[c] = np.nan
    return d


def prepare(d):
    """V2's cleaning (plays.build_season): possession known, provider duplicates out,
    the DECLARED garbage flag; then the scrimmage set with V2's per-play flags."""
    d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()].copy()
    d['pos_team_id'] = d.pos_team_id.astype('int64')
    d['def_pos_team_id'] = d.def_pos_team_id.astype('int64')
    d = d[~_b(d.text_dupe)]
    d['garbage'] = common.garbage_mask(d.period.fillna(1).astype(int).values,
                                       d['start.pos_score_diff'].fillna(0).values)
    # fumbles: the fumbling team (provider), lost per the provider flag, plus the two
    # return-touchdown play types the provider mislabels as recovered (METHODS 3.4)
    d['fum'] = _b(d.fumble_vec)
    d['fteam'] = pd.to_numeric(d.fumbling_team, errors='coerce').where(
        pd.to_numeric(d.fumbling_team, errors='coerce').notna(), d.pos_team_id)
    d['fum_lost'] = d.fum & (_b(d.fumble_lost) | d['type.text'].isin(LOST_FUMBLE_TYPES))
    rush, pas = _b(d.rush), _b(d['pass'])
    scrim = (rush | pas) & ~_b(d.penalty_no_play) & d.EPA.notna()
    s = d[scrim].copy()
    s['is_rush'] = _b(s.rush)
    s['is_pass'] = _b(s['pass'])
    s['succ_f'] = _b(s.EPA_success).astype(float)
    s['expl_f'] = _b(s.EPA_explosive).astype(float)
    s['early'] = _b(s.early_down)
    s['pd'] = _b(s.passing_down)
    s['third'] = s.down.eq(3)
    s['conv3'] = (_b(s.first_down_created) | _b(s.touchdown)).astype(float)
    s['to_f'] = (_b(s['int']) | _b(s.fumble_lost)).astype(float)
    yd = s.statYardage.astype(float)
    s['sack_f'] = _b(s.sack).astype(float)
    s['tfl_rush_f'] = (s.is_rush & (yd < 0)).astype(float)
    s['havoc_f'] = np.maximum(s.sack_f, s.tfl_rush_f)
    s['stuff_f'] = (s.is_rush & (yd <= 0)).astype(float)
    s['opp_f'] = (s.is_rush & (yd >= 5)).astype(float)
    y = yd.clip(lower=-20)
    s['ly'] = np.where(y < 0, 1.2 * y, np.minimum(y, 4) + 0.5 * np.clip(y - 4, 0, 6))
    s['giveaway'] = _b(s['int']) | (s.fum_lost & (s.fteam == s.pos_team_id))
    return d, s


# ----------------------------------------------------------- aggregations
def _offense_sums(s, w, season):
    """V2's team-game sums (plays.build_season) for weights w, plus the explosive sums."""
    EPA = s.EPA
    allm = pd.Series(True, index=s.index)

    def col(mask, val=None):
        v = w if val is None else w * val
        return v.where(mask, 0.0)
    F = pd.DataFrame({
        'n_plays': col(allm), 'epa_sum': col(allm, EPA), 'succ': col(allm, s.succ_f),
        'expl': col(allm, s.expl_f), 'n_db': col(s.is_pass), 'epa_pass_sum': col(s.is_pass, EPA),
        'succ_pass': col(s.is_pass, s.succ_f), 'expl_pass': col(s.is_pass, s.expl_f),
        'sacks': col(s.is_pass, s.sack_f), 'n_rush': col(s.is_rush),
        'epa_rush_sum': col(s.is_rush, EPA), 'succ_rush': col(s.is_rush, s.succ_f),
        'expl_rush': col(s.is_rush, s.expl_f),
        'line_yds': col(s.is_rush, pd.Series(s.ly, index=s.index)),
        'stuff': col(s.is_rush, s.stuff_f), 'opp_run': col(s.is_rush, s.opp_f),
        'n_early': col(s.early), 'succ_early': col(s.early, s.succ_f), 'n_pd': col(s.pd),
        'succ_pd': col(s.pd, s.succ_f), 'n_3rd': col(s.third), 'conv_3rd': col(s.third, s.conv3),
        'havoc': col(allm, s.havoc_f), 'turnovers': col(allm, s.to_f),
        'expl_epa': col(allm, s.expl_f * EPA), 'pos_epa': col(allm, EPA.clip(lower=0.0)),
    }, index=s.index)
    agg = F.groupby([s.game_id, s.pos_team_id]).sum()
    agg.index = agg.index.set_names(['game_id', 'team_id'])
    if season in V2P.SACKS_UNTAGGED:
        for c in ('sacks', 'havoc', 'n_db', 'epa_pass_sum', 'succ_pass', 'expl_pass', 'n_rush',
                  'epa_rush_sum', 'succ_rush', 'expl_rush', 'line_yds', 'stuff', 'opp_run'):
            agg[c] = np.nan
    return agg


def _drive_table(s):
    """V2's drive table (plays.build_season) with the extra per-drive fields."""
    dr = s[s['drive.id'].notna()].sort_values(['game_id', 'game_play_number'])
    g = dr.groupby(['game_id', 'drive.id'])
    # team = most frequent offense on the drive, ties to the smallest id (= Series.mode().iloc[0])
    cnt = dr.groupby(['game_id', 'drive.id', 'pos_team_id']).size().rename('k').reset_index()
    cnt = cnt.sort_values(['game_id', 'drive.id', 'k', 'pos_team_id'], ascending=[True, True, False, True],
                          kind='mergesort').drop_duplicates(['game_id', 'drive.id'])
    D = pd.DataFrame({
        'start_ytg': g['start.yardsToEndzone'].first(),
        'min_ytg': g['start.yardsToEndzone'].min(),
        'epa': g.EPA.sum(),
        'garbage': g.garbage.first(),
        'result': g['drive.result'].first(),
        'n_scrim': g.size(),
        'ep_start': g.EP_start.first(),
    }).reset_index()
    D = D.merge(cnt[['game_id', 'drive.id', 'pos_team_id']].rename(columns={'pos_team_id': 'team_id'}),
                on=['game_id', 'drive.id'], how='left')
    res = D.result.fillna('').str.upper()
    D['td'] = res.isin(TD_RESULTS).astype(float)
    D['fg'] = res.isin(FG_RESULTS).astype(float)
    D['pts'] = np.where(D.td > 0, 7.0, np.where(D.fg > 0, 3.0, 0.0))
    D['so'] = (D.min_ytg <= 40).astype(float)
    D['three_out'] = ((D.n_scrim <= 3) & res.eq('PUNT')).astype(float)
    D = D[D.start_ytg.between(1, 99)]
    return D


def _drive_sums(D, weighted):
    wd = np.where(D.garbage, C.GARBAGE_WEIGHT, 1.0) if weighted else np.ones(len(D))
    x = pd.DataFrame({
        'game_id': D.game_id.values, 'team_id': D.team_id.values,
        'n_drives': wd, 'drive_pts': wd * D.pts.values, 'scoring_opps': wd * D.so.values,
        'opp_pts': wd * D.so.values * D.pts.values, 'start_ytg_sum': wd * D.start_ytg.values,
        'drive_epa_sum': wd * D.epa.values, 'td': wd * D.td.values, 'fg': wd * D.fg.values,
        'three_out': wd * D.three_out.values, 'xp_start_sum': wd * D.ep_start.values,
    })
    return x.groupby(['game_id', 'team_id']).sum()


def _special_teams(d):
    """V2's special-teams nets (plays.build_season), per (game, team)."""
    spm = _b(d.sp) & d.EPA.notna() & ~_b(d.penalty_no_play)
    sp = d[spm][['game_id', 'pos_team_id', 'def_pos_team_id', 'EPA', 'fg_attempt', 'punt', 'kickoff_play']].copy()

    def net(frame, name):
        a = frame.groupby(['game_id', 'pos_team_id']).EPA.sum()
        a.index = a.index.set_names(['game_id', 'team_id'])
        b = frame.groupby(['game_id', 'def_pos_team_id']).EPA.sum()
        b.index = b.index.set_names(['game_id', 'team_id'])
        return a.sub(b, fill_value=0.0).rename(name)
    stn = net(sp, 'st_net_epa')
    fg = sp[_b(sp.fg_attempt)].groupby(['game_id', 'pos_team_id']).EPA.agg(['sum', 'size'])
    fg.index = fg.index.set_names(['game_id', 'team_id'])
    fg = fg.rename(columns={'sum': 'fg_epa', 'size': 'n_fg'})
    pn = net(sp[_b(sp.punt)], 'punt_net_epa')
    kn = net(sp[_b(sp.kickoff_play)], 'kick_net_epa')
    out = pd.concat([stn, fg, pn, kn], axis=1)
    return out


def _turnover_sums(d, s):
    """Per (game, team): fumbles by the fumbling team (all non-nullified plays),
    lost / forced, interceptions thrown, giveaway EPA, dropbacks, return touchdowns."""
    t = d[~_b(d.penalty_no_play)]
    f = t[t.fum]
    fk = [f.game_id, f.fteam.astype('int64')]
    fum = pd.DataFrame({
        'fumbles': f.groupby(fk).size().astype(float),
        'fumbles_lost': f.fum_lost.astype(float).groupby(fk).sum(),
        'fumbles_forced_on': _b(f.forced_fumble).astype(float).groupby(fk).sum(),
    })
    fum.index = fum.index.set_names(['game_id', 'team_id'])
    ints = _b(t['int'])
    it = ints.astype(float).groupby([t.game_id, t.pos_team_id]).sum().rename('ints_thrown')
    it.index = it.index.set_names(['game_id', 'team_id'])
    sk = [s.game_id, s.pos_team_id]
    ge = pd.DataFrame({
        'giveaway_epa': s.EPA.where(s.giveaway, 0.0).groupby(sk).sum(),
        'giveaway_abs_epa': s.EPA.abs().where(s.giveaway, 0.0).groupby(sk).sum(),
        'giveaway_plays': s.giveaway.astype(float).groupby(sk).sum(),
        'dropbacks': s.is_pass.astype(float).groupby(sk).sum(),
        'scrim_plays': s.groupby(sk).size().astype(float),
    })
    ge.index = ge.index.set_names(['game_id', 'team_id'])
    tt = t['type.text'].fillna('')
    dtd = _b(t.defense_score_play) & tt.str.contains('Touchdown')
    ktd = tt.eq('Kickoff Return Touchdown')
    r1 = dtd.astype(float).groupby([t.game_id, t.def_pos_team_id]).sum()
    r1.index = r1.index.set_names(['game_id', 'team_id'])
    r2 = ktd.astype(float).groupby([t.game_id, t.pos_team_id]).sum()
    r2.index = r2.index.set_names(['game_id', 'team_id'])
    rt = r1.add(r2, fill_value=0.0).rename('return_tds')
    return pd.concat([fum, it, ge, rt], axis=1)


# ------------------------------------------------------------ schedule rows
def _games(season, T, pbp_completed=None):
    sched = VAL.load_schedule_raw(season)
    fin = VAL.finality(sched, T, pbp_completed)
    g = sched.merge(fin[['game_id', 'pre_status', 'kickoff_ts']], on='game_id', how='left')
    in_scope = g.home_division.astype(str).eq('fbs') | g.away_division.astype(str).eq('fbs')
    g = g[g.pre_status.eq('FINAL') & in_scope & g.kickoff_ts.notna()].copy()
    if T is not None:
        g = g[g.kickoff_ts < VAL._utc(T)]
    # same pair on the same calendar day under two ids = a feed duplicate (games.py rule)
    g['_d'] = g.kickoff_ts.dt.date
    g['_pair'] = [tuple(sorted((a, b))) for a, b in zip(g.home_id, g.away_id)]
    g = g.sort_values('game_id', kind='mergesort').drop_duplicates(['_pair', '_d'], keep='first')
    return g.drop(columns=['_d', '_pair'])


# ------------------------------------------------------------ artifact I/O
_ARTIFACT_CACHE = {}


def load_expected_margin(path=None):
    p = path or ARTIFACT_PATH
    if p not in _ARTIFACT_CACHE:
        with open(p) as f:
            a = json.load(f)
        body = {k: v for k, v in a.items() if k != 'sha256'}
        if ids.content_hash(body) != a.get('sha256'):
            raise ValueError('expected-margin artifact hash does not verify: %s' % p)
        _ARTIFACT_CACHE[p] = a
    return _ARTIFACT_CACHE[p]


def _artifact_or_none():
    try:
        return load_expected_margin()
    except FileNotFoundError:
        return None


# ------------------------------------------------------- the season frame
_CORE_CACHE = {}


def clear_cache():
    """Forget the per-process season frames and the loaded artifact (call after the
    PBP / schedule files or the artifact change inside one process)."""
    _CORE_CACHE.clear()
    _ARTIFACT_CACHE.clear()


def _core(season):
    """Every final in-scope game of the season (no time cut), per team-game, without
    anything that depends on the artifact. Cached per process."""
    if season in _CORE_CACHE:
        return _CORE_CACHE[season].copy()
    raw = load_plays(season)
    pc = raw.groupby('game_id').status_type_completed.agg(
        lambda v: None if v.isna().all() else bool(v.dropna().astype(bool).all()))
    pcd = {int(k): v for k, v in pc.items()}
    d, s = prepare(raw)
    del raw
    w_f = pd.Series(np.where(s.garbage, C.GARBAGE_WEIGHT, 1.0), index=s.index)
    w_r = pd.Series(1.0, index=s.index)
    of = _offense_sums(s, w_f, season)
    orw = _offense_sums(s, w_r, season)
    D = _drive_table(s)
    df_ = _drive_sums(D, True)
    dr_ = _drive_sums(D, False)
    st = _special_teams(d)
    to = _turnover_sums(d, s)
    garb = s.garbage.groupby([s.game_id, s.pos_team_id]).sum()
    garb.index = garb.index.set_names(['game_id', 'team_id'])
    G = _games(season, None, pcd)

    base = []
    for side, tid, oid, pf, pa in (('home', 'home_id', 'away_id', 'home_points', 'away_points'),
                                   ('away', 'away_id', 'home_id', 'away_points', 'home_points')):
        b = pd.DataFrame({
            'game_id': G.game_id.values, 'season': season, 'week': G.week.values,
            'season_type': G.season_type.astype(str).values, 'kickoff_ts': G.kickoff_ts.values,
            'team_id': G[tid].astype('int64').values, 'opp_id': G[oid].astype('int64').values,
            'home_away': side, 'neutral_site': _b(G.neutral_site).values,
            'fbs': G[tid.replace('_id', '_division')].astype(str).eq('fbs').values,
            'opp_fbs': G[oid.replace('_id', '_division')].astype(str).eq('fbs').values,
            'points_for': G[pf].astype(float).values, 'points_against': G[pa].astype(float).values,
        })
        base.append(b)
    TG = pd.concat(base, ignore_index=True)
    TG['kickoff_ts'] = pd.to_datetime(TG.kickoff_ts, utc=True)
    TG['margin'] = TG.points_for - TG.points_against
    TG['won'] = TG.margin > 0
    key = ['game_id', 'team_id']
    okey = ['game_id', 'opp_id']

    def attach(frame, prefix, suffix=''):
        fr = frame.copy()
        fr.columns = [prefix + c + suffix for c in fr.columns]
        fr = fr.reset_index()
        own = TG[key].merge(fr, on=key, how='left')
        opp = TG[okey].merge(fr.rename(columns={'team_id': 'opp_id'}), on=okey, how='left')
        return own.drop(columns=key), opp.drop(columns=okey)

    parts = []
    o_f, d_f = attach(pd.concat([of, df_], axis=1), '', '')
    o_r, d_r = attach(pd.concat([orw, dr_], axis=1), '', '_raw')
    parts += [o_f.add_prefix('off_'), d_f.add_prefix('def_'), o_r.add_prefix('off_'), d_r.add_prefix('def_')]
    s_own, _ = attach(st, '', '')
    t_own, t_opp = attach(to, '', '')
    g_own, _ = attach(garb.rename('garbage_plays').to_frame(), '', '')
    parts += [s_own, t_own, t_opp.add_prefix('opp_'), g_own]
    TG = pd.concat([TG] + parts, axis=1)
    TG['has_pbp'] = TG.off_n_plays_raw.notna() & TG.def_n_plays_raw.notna()
    for c in ('fg_epa', 'n_fg', 'punt_net_epa', 'kick_net_epa', 'st_net_epa', 'fumbles', 'fumbles_lost',
              'fumbles_forced_on', 'ints_thrown', 'giveaway_epa', 'giveaway_abs_epa', 'giveaway_plays',
              'dropbacks', 'return_tds', 'scrim_plays', 'opp_fumbles', 'opp_fumbles_lost',
              'opp_fumbles_forced_on', 'opp_ints_thrown', 'opp_giveaway_epa', 'opp_giveaway_abs_epa',
              'opp_giveaway_plays', 'opp_dropbacks', 'opp_return_tds', 'opp_scrim_plays', 'garbage_plays'):
        if c in TG:
            TG[c] = np.where(TG.has_pbp, TG[c].fillna(0.0), np.nan)
    TG = TG.drop(columns=['opp_return_tds', 'opp_scrim_plays', 'opp_giveaway_abs_epa', 'opp_giveaway_plays'],
                 errors='ignore')
    TG = TG.sort_values(['kickoff_ts', 'game_id', 'home_away'], ascending=[True, True, False],
                        kind='mergesort').reset_index(drop=True)
    _CORE_CACHE[season] = TG
    return TG.copy()


def _rates(TG):
    """Offense / defense rates, filtered and raw, from the sums."""
    out = {}
    for side in ('off', 'def'):
        for name, num, den in RATE_METRICS:
            out['%s_%s' % (side, name)] = _div(TG['%s_%s' % (side, num)], TG['%s_%s' % (side, den)])
            out['%s_%s_raw' % (side, name)] = _div(TG['%s_%s_raw' % (side, num)], TG['%s_%s_raw' % (side, den)])
    return pd.DataFrame(out, index=TG.index)


def em_features(TG):
    """Game-level (home rows) expected-margin differentials: home minus away."""
    R = TG if 'off_epa_pp' in TG else pd.concat([TG, _rates(TG)], axis=1)
    h = R[R.home_away.eq('home')].set_index('game_id')
    a = R[R.home_away.eq('away')].set_index('game_id')
    X = pd.DataFrame(index=h.index)
    for f, col in EM_FEATURES:
        X[f] = h[col] - a.reindex(h.index)[col]
    X['margin'] = h.margin
    return X


def _predict_em(X, art):
    coef = art['model']['coef']
    v = np.full(len(X), art['model']['intercept'], dtype=float)
    for f in art['model']['features']:
        v = v + coef[f] * X[f].to_numpy(dtype=float)
    return v


def game_performance(season, T=None, validation=None):
    """One row per team-game of the season's final in-scope games (at least one FBS
    team, V2's universe) that kicked off before T (all final games when T is None).
    `validation` (validate_games output) adds validation_status and completeness."""
    TG = _core(season)
    if T is not None:
        Tt = VAL._utc(T)
        TG = TG[TG.kickoff_ts < Tt]
        # a game final in today's file may not have been final at T (point in time)
        fin = VAL.finality(VAL.load_schedule_raw(season), Tt)
        TG = TG[TG.game_id.isin(set(fin.game_id[fin.pre_status.eq('FINAL')]))]
    TG = TG.reset_index(drop=True)
    TG = pd.concat([TG, _rates(TG)], axis=1)
    art = _artifact_or_none()
    # ---------------------------------------------------------- expected margin
    X = em_features(TG)
    if art is not None:
        em = pd.Series(_predict_em(X, art), index=X.index)
        TG['expected_performance_margin'] = np.where(
            TG.home_away.eq('home'), TG.game_id.map(em), -TG.game_id.map(em))
        TG['scoreboard_overperformance'] = TG.margin - TG.expected_performance_margin
        K = art['constants']
    else:
        TG['expected_performance_margin'] = np.nan
        TG['scoreboard_overperformance'] = np.nan
        K = None
    # ---------------------------------------------------------- turnovers
    TG['ints_made'] = TG.opp_ints_thrown
    TG['fumbles_recovered'] = TG.fumbles - TG.fumbles_lost              # own fumbles kept
    TG['opp_fumbles_recovered'] = TG.opp_fumbles_lost                   # takeaways by fumble
    TG['forced_fumbles'] = TG.opp_fumbles_forced_on
    TG['giveaways'] = TG.ints_thrown + TG.fumbles_lost
    TG['takeaways'] = TG.ints_made + TG.opp_fumbles_recovered
    TG['turnover_margin'] = TG.takeaways - TG.giveaways
    TG['turnover_epa'] = TG.giveaway_epa
    TG['takeaway_epa'] = -TG.opp_giveaway_epa
    if K is not None:
        sL, rL, ppt = K['fumble_lost_share'], K['int_rate_per_dropback'], K['points_per_turnover']
        TG['exp_fumbles_lost'] = TG.fumbles * sL
        TG['exp_opp_fumbles_recovered'] = TG.opp_fumbles * sL
        TG['exp_ints_thrown_lg'] = TG.dropbacks * rL
        TG['exp_ints_made_lg'] = TG.opp_dropbacks * rL
        exp_m = (TG.exp_ints_made_lg + TG.exp_opp_fumbles_recovered) - (TG.exp_ints_thrown_lg + TG.exp_fumbles_lost)
        TG['turnover_luck_game'] = (TG.turnover_margin - exp_m) * ppt
    else:
        for c in ('exp_fumbles_lost', 'exp_opp_fumbles_recovered', 'exp_ints_thrown_lg',
                  'exp_ints_made_lg', 'turnover_luck_game'):
            TG[c] = np.nan
    # ---------------------------------------------------------- explosive
    TG['explosive_opportunity'] = TG.off_expl_rate
    TG['explosive_execution'] = _div(TG.off_expl_epa, TG.off_expl)
    TG['explosive_dependency_raw'] = TG.off_expl_epa_share
    if K is not None:
        TG['explosive_dependency_score'] = _shrink_dep(TG.off_expl_epa, TG.off_pos_epa, TG.off_n_plays, K)
    else:
        TG['explosive_dependency_score'] = np.nan
    # ---------------------------------------------------------- drives (non-garbage)
    TG['drive_n'] = TG.off_n_drives
    for name, num, den in DRIVE_METRICS:
        TG['drive_%s' % name] = _div(TG['off_%s' % num], TG['off_%s' % den])
    # ---------------------------------------------------------- pace
    TG['pace_plays'] = TG.off_n_plays_raw
    TG['pace_drives'] = TG.off_n_drives_raw
    if validation is not None and len(validation):
        vm = validation.set_index('game_id')
        TG['validation_status'] = TG.game_id.map(vm.status)
        TG['pbp_completeness_score'] = TG.game_id.map(vm.pbp_completeness_score)
    else:
        TG['validation_status'] = None
        TG['pbp_completeness_score'] = np.nan
    # every numeric field is finite or null with a reason: a game without PBP has null
    # play metrics; a rate whose denominator is 0 (e.g. points per opportunity with no
    # opportunity) is null by definition
    TG['null_reason'] = np.where(TG.has_pbp, None, 'no_pbp')
    TG['as_of'] = ids.ts(T) if T is not None else None
    TG['perf_version'] = PERF_VERSION
    TG['artifact_sha256'] = art['sha256'] if art is not None else None
    TG['perf_id'] = ['cfbp_' + ids.h(g, t, PERF_VERSION) for g, t in zip(TG.game_id, TG.team_id)]
    return TG


def _shrink_dep(expl_epa, pos_epa, n_plays, K):
    """Explosive dependency shrunk to the league share with k plays:
    (n * raw + k * league) / (n + k); raw = explosive EPA / positive EPA."""
    n = np.asarray(n_plays, dtype=float)
    raw = _div(expl_epa, pos_epa)
    k, L = K['explosive_dep_k'], K['explosive_dep_league']
    n = np.where(np.isfinite(raw), n, 0.0)
    raw = np.where(np.isfinite(raw), raw, L)
    return (n * raw + k * L) / (n + k)


# ---------------------------------------------------------------- summary
def team_summary(season, T, perf=None):
    """Per team, as of T: everything aggregated over the team's games that kicked
    off before T. Recency versions weight a game 0.5 ** (age_weeks / half-life),
    half-life = config.RECENT_HALFLIFE_WEEKS, age measured from T. Sums are taken
    over the team's games with PBP (games_with_pbp); record and scoreboard margin use
    every final game."""
    Tt = VAL._utc(T)
    P = game_performance(season, Tt) if perf is None else perf[perf.kickoff_ts < Tt]
    art = load_expected_margin()
    K = art['constants']
    P = P[P.margin.notna()].sort_values(['team_id', 'kickoff_ts', 'game_id'], kind='mergesort').copy()
    if not len(P):
        return pd.DataFrame()
    P['age_w'] = (Tt - P.kickoff_ts).dt.total_seconds() / (7 * 86400.0)
    P['rw'] = 0.5 ** (P.age_w / C.RECENT_HALFLIFE_WEEKS)
    P['loss'] = P.margin < 0
    P['close'] = P.margin.abs() <= CLOSE_GAME_MARGIN
    P['close_win'] = P.close & P.won
    P['close_loss'] = P.close & P.loss
    g = P.groupby('team_id', sort=True)
    S = pd.DataFrame({
        'fbs': g.fbs.last().astype(bool), 'games': g.size(), 'wins': g.won.sum().astype(int),
        'losses': g.loss.sum().astype(int), 'scoreboard_margin': g.margin.mean(),
        'performance_margin': g.expected_performance_margin.mean(),
        'overperformance': g.scoreboard_overperformance.mean(),
        'close_games': g.close.sum().astype(int), 'close_wins': g.close_win.sum().astype(int),
        'close_losses': g.close_loss.sum().astype(int),
    })
    S['record'] = [f'{w}-{l}' for w, l in zip(S.wins, S.losses)]
    S['close_game_record'] = [f'{w}-{l}' for w, l in zip(S.close_wins, S.close_losses)]
    h = P[P.has_pbp]
    sum_cols = ['dropbacks', 'opp_dropbacks', 'ints_thrown', 'ints_made', 'fumbles', 'fumbles_lost',
                'opp_fumbles', 'opp_fumbles_recovered', 'forced_fumbles', 'return_tds',
                'off_n_plays', 'off_expl', 'off_expl_epa', 'off_pos_epa',
                'st_net_epa', 'fg_epa', 'punt_net_epa', 'kick_net_epa']
    dcols = sorted({'%s_%s' % (sd, c) for sd in ('off', 'def') for _, a, b in DRIVE_METRICS for c in (a, b)})
    H = h.groupby('team_id', sort=True)[sum_cols + dcols].sum().reindex(S.index)
    Hr = h[dcols].mul(h.rw, axis=0).groupby(h.team_id, sort=True).sum().reindex(S.index)
    S['games_with_pbp'] = h.groupby('team_id').size().reindex(S.index).fillna(0).astype(int)
    S = S.join(_turnover_luck(H, K))
    S['turnover_luck_pg'] = _div(S.turnover_luck_index, S.games_with_pbp)
    S['explosive_plays'] = H.off_expl
    S['explosive_opportunity'] = _div(H.off_expl, H.off_n_plays)
    S['explosive_execution'] = _div(H.off_expl_epa, H.off_expl)
    S['explosive_dependency_raw'] = _div(H.off_expl_epa, H.off_pos_epa)
    S['explosive_dependency_score'] = _shrink_dep(H.off_expl_epa.fillna(0), H.off_pos_epa.fillna(0),
                                                  H.off_n_plays.fillna(0), K)
    S['drive_n'] = H.off_n_drives
    for name, num, den in DRIVE_METRICS:
        for sd, pre in (('off', 'drive_'), ('def', 'def_drive_')):
            S[pre + name] = _div(H['%s_%s' % (sd, num)], H['%s_%s' % (sd, den)])
            S[pre + name + '_rec'] = _div(Hr['%s_%s' % (sd, num)], Hr['%s_%s' % (sd, den)])
    for c in ('st_net_epa', 'fg_epa', 'punt_net_epa', 'kick_net_epa'):
        S['%s_total' % c] = H[c]
        S['%s_pg' % c] = _div(H[c], S.games_with_pbp)
    S = S.reset_index()
    S.insert(1, 'season', season)
    S.insert(2, 'as_of', ids.ts(Tt))
    S['perf_version'] = PERF_VERSION
    S['artifact_sha256'] = art['sha256']
    return S


def _turnover_luck(H, K):
    """Season-to-date turnover luck in points (METHODS 3.4), vectorised over the rows
    of H (per-team sums):
      luck = ((takeaways - giveaways) - (E[takeaways] - E[giveaways])) * points_per_turnover
      E[fumbles lost] = own fumbles * league lost share (and the same for the opponent's)
      E[INT thrown]   = dropbacks * (INT + k * league rate) / (dropbacks + k)
      E[INT made]     = opponent dropbacks * (INT made + k * league rate) / (opp dropbacks + k)"""
    sL, rL, k, ppt = (K['fumble_lost_share'], K['int_rate_per_dropback'], K['int_shrinkage_k'],
                      K['points_per_turnover'])
    f = lambda c: H[c].astype(float).fillna(0.0)
    db, dbo, it, im = f('dropbacks'), f('opp_dropbacks'), f('ints_thrown'), f('ints_made')
    fu, fl, ofu, ofr = f('fumbles'), f('fumbles_lost'), f('opp_fumbles'), f('opp_fumbles_recovered')
    e_it = db * (it + k * rL) / (db + k)
    e_im = dbo * (im + k * rL) / (dbo + k)
    e_fl, e_ofr = fu * sL, ofu * sL
    act = (im + ofr) - (it + fl)
    exp = (e_im + e_ofr) - (e_it + e_fl)
    out = pd.DataFrame({
        'dropbacks': db, 'ints_thrown': it, 'ints_made': im, 'fumbles': fu, 'fumbles_lost': fl,
        'opp_fumbles': ofu, 'opp_fumbles_recovered': ofr,
        'forced_fumbles': f('forced_fumbles') if 'forced_fumbles' in H else np.nan,
        'return_tds': f('return_tds') if 'return_tds' in H else np.nan,
        'turnover_margin': act, 'exp_turnover_margin': exp, 'exp_ints_thrown': e_it,
        'exp_ints_made': e_im, 'exp_fumbles_lost': e_fl, 'exp_opp_fumbles_recovered': e_ofr,
        'fumble_luck': ((ofr - e_ofr) - (fl - e_fl)) * ppt,
        'int_luck': ((im - e_im) - (it - e_it)) * ppt,
        'turnover_luck_index': (act - exp) * ppt,
    }, index=H.index)
    return out


# ------------------------------------------------------ fitting (dev only)
def _dev_frames(seasons):
    C.assert_dev_only(seasons)
    out = {}
    for S in seasons:
        TG = _core(S)
        TG = pd.concat([TG, _rates(TG)], axis=1)
        v = VAL.validate_games(S, pd.Timestamp('%d-06-01' % (S + 1), tz='UTC'))
        TG['validation_status'] = TG.game_id.map(v.set_index('game_id').status)
        out[S] = TG
    return out


def estimate_constants(frames):
    """Dev-season constants the perf objects need (METHODS 3.4-3.5)."""
    P = pd.concat([f[f.has_pbp] for f in frames.values()], ignore_index=True)
    fum, lost = P.fumbles.sum(), P.fumbles_lost.sum()
    db, ints = P.dropbacks.sum(), P.ints_thrown.sum()
    rL = ints / db
    # INT shrinkage: method of moments over FBS team-seasons
    ts = P[P.fbs].groupby(['season', 'team_id'])[['ints_thrown', 'dropbacks']].sum()
    ts = ts[ts.dropbacks > 0]
    p = ts.ints_thrown / ts.dropbacks
    var_obs = float(np.average((p - rL) ** 2, weights=ts.dropbacks))
    noise = float(np.average(rL * (1 - rL) / ts.dropbacks, weights=ts.dropbacks))
    tau2 = max(var_obs - noise, 1e-12)
    k_int = float(np.clip(rL * (1 - rL) / tau2, INT_K_MIN, INT_K_MAX))
    # points per turnover: mean |EPA| of scrimmage giveaway plays
    ppt = {'mean_abs_epa': float(P.giveaway_abs_epa.sum() / P.giveaway_plays.sum()),
           'n': int(P.giveaway_plays.sum())}
    # explosive dependency: league share and split-half k
    dep_L = P.off_expl_epa.sum() / P.off_pos_epa.sum()
    sh = _split_half(P, [('dep', 'off_expl_epa', 'off_pos_epa')])
    r_half, n_half = sh['dep']['r'], sh['dep']['n_half_plays']
    k_dep = n_half * (1 - r_half) / r_half if r_half > 0 else EXPLOSIVE_K_MAX
    k_dep = float(np.clip(k_dep, EXPLOSIVE_K_MIN, EXPLOSIVE_K_MAX))
    return {
        'fumble_lost_share': _sig(lost / fum), 'fumbles': int(fum), 'fumbles_lost': int(lost),
        'int_rate_per_dropback': _sig(rL), 'int_shrinkage_k': _sig(k_int),
        'int_team_rate_sd_true': _sig(np.sqrt(tau2)),
        'points_per_turnover': _sig(ppt['mean_abs_epa']), 'turnover_plays': ppt['n'],
        'explosive_dep_league': _sig(dep_L), 'explosive_dep_k': _sig(k_dep),
        'explosive_dep_split_half_r': _sig(r_half), 'explosive_dep_half_plays': _sig(n_half),
    }


def _split_half(P, specs, min_games=6):
    """Team-season split-half correlation (odd vs even games in kickoff order) of
    ratio metrics num/den, FBS team-seasons with >= min_games games."""
    P = P[P.fbs].sort_values(['season', 'team_id', 'kickoff_ts', 'game_id'], kind='mergesort').copy()
    P['gi'] = P.groupby(['season', 'team_id']).cumcount()
    P['half'] = P.gi % 2
    ng = P.groupby(['season', 'team_id']).size()
    keep = ng[ng >= min_games].index
    out = {}
    for name, num, den in specs:
        h = P.groupby(['season', 'team_id', 'half'])[[num, den]].sum()
        h = h[h.index.droplevel('half').isin(keep)]
        v = (h[num] / h[den].where(h[den] > 0)).unstack('half')
        dn = h[den].unstack('half')
        ok = v.notna().all(axis=1)
        r = float(np.corrcoef(v[ok][0], v[ok][1])[0, 1]) if ok.sum() > 2 else np.nan
        out[name] = {'r': r, 'n_team_seasons': int(ok.sum()), 'n_half_plays': float(dn[ok].stack().median())}
    return out


def fit_expected_margin(write=True, path=None, seasons=C.DEV_SEASONS):
    """OLS of the final home margin on the non-garbage home-minus-away differentials
    over FINAL_VALIDATED in-scope games of the development seasons; the artifact also
    freezes the dev-estimated perf constants. Deterministic: refitting reproduces the
    same sha256."""
    seasons = tuple(int(s) for s in seasons)
    C.assert_dev_only(seasons)
    frames = _dev_frames(seasons)
    Xs = []
    for S in seasons:
        TG = frames[S]
        X = em_features(TG)
        st = TG[TG.home_away.eq('home')].set_index('game_id').validation_status
        X = X[st.reindex(X.index).eq('FINAL_VALIDATED')]
        Xs.append(X.assign(season=S))
    X = pd.concat(Xs).sort_index(kind='mergesort')
    feats = [f for f, _ in EM_FEATURES]
    ok = np.isfinite(X[feats + ['margin']].to_numpy(dtype=float)).all(axis=1)
    X = X[ok]
    A = np.column_stack([np.ones(len(X))] + [X[f].to_numpy(dtype=float) for f in feats])
    y = X.margin.to_numpy(dtype=float)
    beta = np.linalg.solve(A.T @ A, A.T @ y)
    pred = A @ beta
    resid = y - pred
    n, p = len(y), len(feats)
    r2 = 1 - float(resid @ resid) / float(((y - y.mean()) ** 2).sum())
    rsd = float(np.sqrt(resid @ resid / (n - p - 1)))
    const = estimate_constants(frames)
    data = []
    for S in seasons:
        data.append({'season': S,
                     'pbp_sha256': ids.file_hash(common.data_path('pbp', 'play_by_play_%d.parquet' % S)),
                     'sched_sha256': ids.file_hash(common.data_path('sched', 'cfb_schedules_%d.parquet' % S))})
    art = {
        'artifact_version': ARTIFACT_VERSION,
        'perf_version': PERF_VERSION,
        'validation_rule': VAL.RULE_VERSION,
        'target': 'home_points - away_points (internal margin convention)',
        'model': {
            'method': 'OLS with intercept (numpy normal equations)',
            'features': feats,
            'feature_definitions': {f: 'home %s minus away %s, non-garbage (V2 garbage weight 0)' % (c, c)
                                    for f, c in EM_FEATURES},
            'intercept': _sig(beta[0]),
            'coef': {f: _sig(b) for f, b in zip(feats, beta[1:])},
            'n': int(n), 'r2': _sig(r2), 'residual_sd': _sig(rsd),
            'mae': _sig(float(np.abs(resid).mean())),
            'games_filter': 'final, at least one FBS team, validation FINAL_VALIDATED, all features finite',
        },
        'training_seasons': list(seasons),
        'training_data': data,
        'constants': const,
    }
    art['sha256'] = ids.content_hash(art)
    if write:
        p = path or ARTIFACT_PATH
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            f.write(json.dumps(ids.clean(art), indent=1, sort_keys=True, ensure_ascii=False) + '\n')
        _ARTIFACT_CACHE.pop(p, None)
    return art


# ---------------------------------------------------------- reports (docs)
def calibration(seasons=C.HOLDOUT_SEASONS):
    """Out-of-sample check of the frozen expected margin: slope of actual on expected
    (OLS with intercept) and MAE, over FINAL_VALIDATED in-scope games."""
    art = load_expected_margin()
    out = {}
    allx = []
    for S in seasons:
        TG = _core(S)
        v = VAL.validate_games(S, pd.Timestamp('%d-06-01' % (S + 1), tz='UTC'))
        X = em_features(TG)
        st = v.set_index('game_id').status
        X = X[st.reindex(X.index).eq('FINAL_VALIDATED')]
        X = X[np.isfinite(X[[f for f, _ in EM_FEATURES] + ['margin']].to_numpy(dtype=float)).all(axis=1)]
        X['exp'] = _predict_em(X, art)
        allx.append(X.assign(season=S))
        out[S] = _calib(X)
    out['pooled'] = _calib(pd.concat(allx))
    return out


def _calib(X):
    e, y = X.exp.to_numpy(dtype=float), X.margin.to_numpy(dtype=float)
    A = np.column_stack([np.ones(len(e)), e])
    b = np.linalg.solve(A.T @ A, A.T @ y)
    return {'n': int(len(e)), 'slope': round(float(b[1]), 4), 'intercept': round(float(b[0]), 4),
            'mae': round(float(np.abs(y - e).mean()), 4), 'resid_sd': round(float(np.std(y - e, ddof=1)), 4),
            'r2': round(float(1 - ((y - e) ** 2).sum() / ((y - y.mean()) ** 2).sum()), 4)}


def evidence_turnovers(seasons=C.DEV_SEASONS):
    """Split-half (odd / even games) team-season correlations on dev seasons: the
    persistence of fumble recovery vs INT rate, fumble rate and EPA/play."""
    C.assert_dev_only(seasons)
    P = pd.concat([_core(S) for S in seasons], ignore_index=True)
    P = P[P.has_pbp].copy()
    P['fum_rec_own'] = P.fumbles - P.fumbles_lost
    P['all_fumbles'] = P.fumbles + P.opp_fumbles
    P['recovered_all'] = (P.fumbles - P.fumbles_lost) + P.opp_fumbles_lost
    specs = [('own_fumble_recovery_rate', 'fum_rec_own', 'fumbles'),
             ('def_fumble_recovery_rate', 'opp_fumbles_lost', 'opp_fumbles'),
             ('all_fumble_recovery_rate', 'recovered_all', 'all_fumbles'),
             ('fumbles_per_scrimmage_play', 'fumbles', 'scrim_plays'),
             ('int_rate_per_dropback', 'ints_thrown', 'dropbacks'),
             ('def_int_rate_per_dropback', 'opp_ints_thrown', 'opp_dropbacks'),
             ('epa_per_play', 'off_epa_sum', 'off_n_plays')]
    res = _split_half(P, specs)
    return {k: {'r': round(v['r'], 4), 'n_team_seasons': v['n_team_seasons']} for k, v in res.items()}


def evidence_explosive(seasons=C.DEV_SEASONS):
    """Does a higher pre-game explosive dependency predict a larger next-game residual?
    Residual = final margin minus V2's walk-forward pregame prediction (ens_pred, from
    out/stage7/backtest_predictions.parquet), from the team's side; dependency = the
    shrunk season-to-date score before that game's freeze (prediction_ts)."""
    C.assert_dev_only(seasons)
    art = load_expected_margin()
    K = art['constants']
    bt = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'),
                         columns=['game_id', 'season', 'home_id', 'away_id', 'margin', 'ens_pred',
                                  'prediction_ts'])
    bt = bt[bt.season.isin(seasons) & bt.margin.notna() & bt.ens_pred.notna()]
    rows = []
    for S in seasons:
        P = _core(S)
        P = P[P.has_pbp].sort_values(['team_id', 'kickoff_ts', 'game_id'], kind='mergesort')
        b = bt[bt.season.eq(S)]
        for side, tcol, sgn in (('home', 'home_id', 1.0), ('away', 'away_id', -1.0)):
            x = b[['game_id', tcol, 'margin', 'ens_pred', 'prediction_ts']].rename(columns={tcol: 'team_id'})
            x['resid'] = sgn * (x.margin - x.ens_pred)
            x['pred_team'] = sgn * x.ens_pred
            rows.append(x.assign(season=S))
    R = pd.concat(rows, ignore_index=True)
    R['prediction_ts'] = pd.to_datetime(R.prediction_ts, utc=True)
    # point-in-time cumulative sums per team: games that kicked off before prediction_ts
    dep, npl, prior_games = [], [], []
    cache = {S: _core(S) for S in seasons}
    for r in R.itertuples(index=False):
        P = cache[r.season]
        h = P[(P.team_id == r.team_id) & P.has_pbp & (P.kickoff_ts < r.prediction_ts)]
        n = float(h.off_n_plays.sum())
        dep.append(float(_shrink_dep([h.off_expl_epa.sum()], [h.off_pos_epa.sum()], [n], K)[0]))
        npl.append(n)
        prior_games.append(len(h))
    R['dep'] = dep
    R['prior_plays'] = npl
    R['prior_games'] = prior_games
    R = R[R.prior_games >= 3]
    z = (R.dep - R.dep.mean()) / R.dep.std()
    y2 = R.resid ** 2
    A = np.column_stack([np.ones(len(z)), z, np.abs(R.pred_team.to_numpy(dtype=float))])
    beta, res_, _, _ = np.linalg.lstsq(A, y2.to_numpy(dtype=float), rcond=None)
    e = y2.to_numpy(dtype=float) - A @ beta
    s2 = (e @ e) / (len(e) - A.shape[1])
    cov = s2 * np.linalg.inv(A.T @ A)
    terc = pd.qcut(R.dep, 3, labels=['low', 'mid', 'high'])
    sd_by = R.groupby(terc, observed=True).resid.agg(lambda v: float(np.sqrt((v ** 2).mean())))
    from scipy import stats as _st
    lev = _st.levene(*[R.resid[terc == k].to_numpy() for k in ('low', 'mid', 'high')], center='median')
    return {
        'n_team_games': int(len(R)),
        'spearman_dep_vs_abs_resid': round(float(_st.spearmanr(R.dep, R.resid.abs()).correlation), 4),
        'slope_resid2_per_sd_dep': round(float(beta[1]), 3),
        'slope_t': round(float(beta[1] / np.sqrt(cov[1, 1])), 3),
        'control': '|pregame predicted margin| (blowout expectations have larger residuals)',
        'rmse_resid_by_tercile': {k: round(v, 3) for k, v in sd_by.items()},
        'brown_forsythe_p': round(float(lev.pvalue), 4),
        'dep_tercile_cuts': [round(float(x), 4) for x in R.dep.quantile([1 / 3, 2 / 3])],
    }
