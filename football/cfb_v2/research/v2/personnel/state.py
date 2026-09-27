"""Player-week state and the usage-derived depth chart at an instant T.

    player_week_state(season, T, availability=None) -> DataFrame
    depth_chart_state(season, T, availability=None) -> DataFrame
    calibration(season) -> the tables estimated from the seasons before `season`
    reliability_table(season_train, season_holdout) -> held-out calibration evidence

Point in time: every usage number comes from games that kicked off strictly before T
(usage.player_games(season, T)); every availability status from a report published
(or, with no publication time, retrieved) at or before T; every calibration table
and role threshold from COMPLETE seasons before `season`. Rosters are season
snapshots, not point-in-time: they are used for membership and position only and
every row that leans on one says so (roster_pit = False).

What a row is NOT: a snap count (no feed has them), a depth chart from a provider
(none exists: depth_rank is the usage order), a value (player_value_mean/sd and
replacement_value are named null placeholders for the next phase).
"""
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from . import RULE_VERSION
from . import identity as I
from . import positions as POS
from . import usage as U

RULE = 'cfb_player_week_state_v1'
DEPTH_RULE = 'cfb_depth_chart_state_v1'
CAL_VERSION = 'personnel_calibration_v3'

# ---------------------------------------------------------------- metrics
# family -> (player count, team denominator, share name). Offensive shares are
# non-garbage and use the ATTRIBUTED team total (usage.py), so a team's shares sum to 1.
OFF_METRIC = {
    'QB': ('dropbacks_ng', 'team_dropbacks_id_ng', 'dropback_share'),
    'RB': ('rush_att_ng', 'team_rushes_id_ng', 'carry_share'),
    'WR': ('targets_ng', 'team_targets_id_ng', 'target_share'),
    'TE': ('targets_ng', 'team_targets_id_ng', 'target_share'),
    'K': ('kicks', 'team_kicks', 'kick_share'),
    'P': ('punts', 'team_punts', 'punt_share'),
    'RETURNER': ('returns', 'team_returns_id', 'return_share'),
}
FRONT_METRIC = ('def_sacks', 'team_def_sacks_credit', 'sack_share')          # needs def_sacks RELIABLE
SEC_METRIC_PD = ('def_pd', 'team_def_pd', 'pd_share')                       # needs def_pbu AND def_ints
SEC_METRIC_PBU = ('def_pbu', 'team_def_pbu_id', 'pbu_share')                # needs def_pbu only
METRIC_COLS = sorted({v for m in list(OFF_METRIC.values()) + [FRONT_METRIC, SEC_METRIC_PD, SEC_METRIC_PBU]
                      for v in m[:1]})
SLOTS = {'QB': 1, 'RB': 1, 'WR': 3, 'TE': 1, 'K': 1, 'P': 1}     # usage "starter" slots per family
ROLE_FAMILIES = ('QB', 'RB', 'WR', 'TE')
SPECIALIST_FAMILIES = ('K', 'P', 'LS', 'RETURNER')

# expected usage share: exponentially weighted share over the team's games this
# season, half-life in team games, per family. TUNED on the dev seasons 2016-2023
# (METHODS_FOUNDATION.md: next-game share MAE of the last game, last 3, season and
# half-lives 0.35-6 games). QB usage is nearly binary and persistent, so the last
# game dominates; receivers' target shares are noisy, so memory helps.
EW_HALFLIFE = {'QB': 0.35, 'RB': 0.75, 'WR': 1.5, 'TE': 2.0}
EW_HALFLIFE_DEFAULT = 1.5
EW_HALFLIFE_GAMES = EW_HALFLIFE_DEFAULT
RECENT_GAMES = 3
# a starter role needs evidence, not a share alone: in the team's last 3 games the
# player must have at least MIN_RECENT_EVENTS usage events of his family's kind and
# have been used in at least min(2, team games) of them
MIN_RECENT_EVENTS = {'QB': 20, 'RB': 12, 'WR': 6, 'TE': 5}
MIN_RECENT_GAMES = 2
# calibration windows: complete seasons before S (at most this many)
TRAIN_SEASONS = 8
SMOOTH_A = 20.0                         # pseudo-counts toward the coarser cell

# availability: status -> probability the player plays (declared; v2.weekly.availability's
# map, with the report vocabulary's spellings folded in). OUT_FIRST_HALF plays half a game.
PLAY_PROBABILITY = {'ACTIVE': 1.0, 'AVAILABLE': 1.0, 'PROBABLE': 0.85, 'QUESTIONABLE': 0.5,
                    'GAME TIME DECISION': 0.5, 'GTD': 0.5, 'DOUBTFUL': 0.2, 'OUT': 0.0, 'SUSPENDED': 0.0,
                    'TRANSFERRED': 0.0, 'OUT FOR SEASON': 0.0, 'OUT FIRST HALF': 1.0}
GAME_FRACTION = {'OUT FIRST HALF': 0.5}
TIER_OF_PLATFORM = {'conference': 1, 'hdintelligence': 1, 'pac12': 1, 'team': 1}

_MEM = {}


# ============================================================ the panel
def _prep(pg, tg):
    """Add the derived count columns and the per-team game index j (0 = first game)."""
    pg = pg.copy()
    tg = tg.copy()
    pg['kicks'] = pg.fg_att + pg.xp_att
    pg['returns'] = pg.kick_returns + pg.punt_returns
    pg['def_pd'] = pg.def_pbu + pg.def_ints
    tg['team_kicks'] = tg.team_fg_att + tg.team_xp_att_id
    tg['team_def_pd'] = tg.team_def_pbu_id + tg.team_def_int_events_id
    tg = tg.sort_values(['team_id', 'kickoff_ts', 'game_id'], kind='mergesort')
    tg['j'] = tg.groupby('team_id').cumcount()
    pg = pg.merge(tg[['game_id', 'team_id', 'j']], on=['game_id', 'team_id'], how='inner')
    return pg, tg


DEN_COLS = sorted({m[1] for m in list(OFF_METRIC.values()) + [FRONT_METRIC, SEC_METRIC_PD, SEC_METRIC_PBU]})


def _htag(H):
    return ('%g' % H).replace('.', 'p')


def _halflives(H=None):
    return sorted({H} if H is not None else set(EW_HALFLIFE.values()) | {EW_HALFLIFE_DEFAULT})


def _halflife_of(fam, H=None):
    return H if H is not None else EW_HALFLIFE.get(fam, EW_HALFLIFE_DEFAULT)


def _expand(pg, tg, cuts, H=None):
    """Share features at each cut. cuts: (team_id, cut, i) = 'after the team's game i'
    (games j <= i included, age = i - j). Returns (players frame, team frame) keyed by
    (team_id, cut[, espn_id]). H overrides every family's half-life (tuning only)."""
    Hs = _halflives(H)
    x = pg.merge(cuts, on='team_id', how='inner')
    x = x[x.j <= x.i].copy()
    x['age'] = x.i - x.j
    x['rec'] = (x.age < RECENT_GAMES).astype(float)
    x['last'] = (x.age == 0).astype(float)
    t = tg.merge(cuts, on='team_id', how='inner')
    t = t[t.j <= t.i].copy()
    t['age'] = t.i - t.j
    t['rec'] = (t.age < RECENT_GAMES).astype(float)
    t['last'] = (t.age == 0).astype(float)
    key = ['team_id', 'cut']
    pk = key + ['espn_id']
    agg = {}
    new = {}
    for c in METRIC_COLS:
        for h in Hs:
            new[c + '__w' + _htag(h)] = x[c] * 0.5 ** (x.age / h)
            agg[c + '__w' + _htag(h)] = 'sum'
        new[c + '__r'] = x[c] * x.rec
        new[c + '__l'] = x[c] * x['last']
        new[c + '__g'] = ((x[c] > 0) & (x.rec > 0)).astype(float)
        for suf in ('', '__r', '__l', '__g'):
            agg[c + suf] = 'sum'
    x = pd.concat([x, pd.DataFrame(new, index=x.index)], axis=1)
    x['qb_start__r'] = x.qb_starter.astype(float) * x.rec
    x['qb_start__l'] = x.qb_starter.astype(float) * x['last']
    x['qb_start'] = x.qb_starter.astype(float)
    x['lead_db__l'] = x.usage_leader_dropback.astype(float) * x['last']
    x['present__r'] = x.rec
    x['present__l'] = x['last']
    x['games'] = 1.0
    for c in ('qb_start__r', 'qb_start__l', 'qb_start', 'lead_db__l', 'present__r', 'present__l', 'games'):
        agg[c] = 'sum'
    agg['kickoff_ts'] = 'max'
    agg['name'] = 'last'
    x = x.sort_values(pk + ['j'], kind='mergesort')
    X = x.groupby(pk, sort=True).agg(agg)
    X = X.rename(columns={'kickoff_ts': 'player_last_game_ts'}).reset_index()
    tagg = {}
    new = {}
    for c in DEN_COLS:
        for h in Hs:
            new[c + '__w' + _htag(h)] = t[c] * 0.5 ** (t.age / h)
            tagg[c + '__w' + _htag(h)] = 'sum'
        new[c + '__r'] = t[c] * t.rec
        new[c + '__l'] = t[c] * t['last']
        for suf in ('', '__r', '__l'):
            tagg[c + suf] = 'sum'
    t = pd.concat([t, pd.DataFrame(new, index=t.index)], axis=1)
    t['team_games'] = 1.0
    t['team_games_recent'] = t.rec
    tagg['team_games'] = 'sum'
    tagg['team_games_recent'] = 'sum'
    tagg['kickoff_ts'] = 'max'
    TT = t.groupby(key, sort=True).agg(tagg).rename(columns={'kickoff_ts': 'team_last_game_ts'}).reset_index()
    return X, TT


def _qb_streaks(pg):
    """Per (team, j): the starter's espn_id and his consecutive-start streak ending at j."""
    s = pg[pg.qb_starter].sort_values(['team_id', 'j', 'espn_id'], kind='mergesort').drop_duplicates(['team_id', 'j'])
    s = s[['team_id', 'j', 'espn_id']].rename(columns={'espn_id': 'starter'})
    s = s.sort_values(['team_id', 'j'])
    prev_j = s.groupby('team_id').j.shift(1)
    prev_s = s.groupby('team_id').starter.shift(1)
    new = ~(prev_s.eq(s.starter) & prev_j.eq(s.j - 1))
    s['run'] = new.astype(int).groupby(s.team_id).cumsum()
    s['streak'] = s.groupby(['team_id', 'run']).cumcount() + 1
    return s[['team_id', 'j', 'starter', 'streak']]


def _metric_for(fam, rel):
    """(count col, denominator col, share name, basis) for a family given the season's
    column reliability at T; None when there is no usable usage for the family."""
    if fam in OFF_METRIC:
        c, d, n = OFF_METRIC[fam]
        return c, d, n, 'usage'
    if fam in POS.FRONT7_FAMILIES:
        if rel.get('def_sacks', {}).get('verdict') == 'RELIABLE':
            return FRONT_METRIC + ('production',)
        return None
    if fam in POS.SECONDARY_FAMILIES:
        pbu = rel.get('def_pbu', {}).get('verdict') == 'RELIABLE'
        it = rel.get('def_ints', {}).get('verdict') == 'RELIABLE'
        if pbu and it:
            return SEC_METRIC_PD + ('production',)
        if pbu:
            return SEC_METRIC_PBU + ('production',)
        return None
    return None


def _features(X, TT, fam_map, rel, H=None):
    """Attach family, the family's share metric, ranks within (team, cut, family)."""
    F = X.merge(TT, on=['team_id', 'cut'], how='left')
    F = F.assign(family=F.espn_id.map(fam_map).fillna('UNKNOWN')).copy()
    out = {k: np.full(len(F), np.nan) for k in ('share_ew', 'share_recent', 'share_season', 'share_prev',
                                               'recent_n', 'season_n', 'recent_games_used')}
    metric = np.array([None] * len(F), dtype=object)
    basis = np.array([None] * len(F), dtype=object)
    for fam in sorted(F.family.unique()):
        m = _metric_for(fam, rel)
        if m is None:
            continue
        c, d, name, b = m
        tag = '__w' + _htag(_halflife_of(fam, H))
        sel = (F.family == fam).values
        sub = F.loc[sel]
        with np.errstate(invalid='ignore', divide='ignore'):
            out['share_ew'][sel] = (sub[c + tag] / sub[d + tag].where(sub[d + tag] > 0)).values
            out['share_recent'][sel] = (sub[c + '__r'] / sub[d + '__r'].where(sub[d + '__r'] > 0)).values
            out['share_season'][sel] = (sub[c] / sub[d].where(sub[d] > 0)).values
            out['share_prev'][sel] = (sub[c + '__l'] / sub[d + '__l'].where(sub[d + '__l'] > 0)).values
        out['recent_n'][sel] = sub[c + '__r'].values
        out['season_n'][sel] = sub[c].values
        out['recent_games_used'][sel] = sub[c + '__g'].values
        metric[sel] = name
        basis[sel] = b
    extra = pd.DataFrame(out, index=F.index)
    extra['usage_metric'] = metric
    extra['usage_basis'] = basis
    F = pd.concat([F, extra], axis=1)
    F['_e'] = F.share_ew.fillna(-1.0)
    F['_s'] = F.share_season.fillna(-1.0)
    F = F.sort_values(['team_id', 'cut', 'family', '_e', '_s', 'recent_n', 'espn_id'],
                      ascending=[True, True, True, False, False, False, True], kind='mergesort')
    F['rank'] = (F.groupby(['team_id', 'cut', 'family']).cumcount() + 1).astype(float)
    F.loc[F.share_ew.isna(), 'rank'] = np.nan
    return F.drop(columns=['_e', '_s']).reset_index(drop=True)


def _attach_streak(F, pg):
    """QB start context at each cut i: the start streak of the cut game's starter (0 for
    everyone else), from the same games the features came from."""
    st = _qb_streaks(pg).rename(columns={'j': 'i'})
    F = F.merge(st, on=['team_id', 'i'], how='left')
    F['streak'] = np.where(F.starter.eq(F.espn_id), F.streak, 0.0)
    return F.drop(columns=['starter'])


# ====================================================== history (training)
def _fam_map(season, pg):
    pl = I.position_lookup(season, usage_rows=pg)
    return dict(zip(pl.espn_id, pl.family)), pl


def history(season):
    """Per (team, cut after game i, player) features and next-game outcomes for one
    complete season (in-season cuts), plus the week-1 rows (cut = end of season-1,
    outcome = the team's first game of `season`). Cached on disk."""
    key = ('history', season, U._cache_key(season))
    if key in _MEM:
        return _MEM[key]
    d = os.path.dirname(common.out_path('personnel', 'cache', 'x'))
    f = os.path.join(d, 'history_%d.parquet' % season)
    fm = os.path.join(d, 'history_%d.json' % season)
    try:
        if json.load(open(fm)).get('key') == '|'.join(map(str, key)) + '|' + CAL_VERSION:
            Hh = pd.read_parquet(f)
            _MEM[key] = Hh
            return Hh
    except (OSError, ValueError):
        pass
    pg, tg = _prep(U.player_games(season), U.team_games(season))
    rel = U.reliability(season, tg=U.team_games(season))
    fam, _ = _fam_map(season, pg)
    n = tg.groupby('team_id').j.max()
    cuts = pd.DataFrame([(t, i, i) for t, m in n.items() for i in range(int(m))], columns=['team_id', 'cut', 'i'])
    X, TT = _expand(pg, tg, cuts)
    Fh = _features(X, TT, fam, rel)
    Fh = Fh.assign(i=Fh.cut)
    Fh = _attach_streak(Fh, pg)
    Fh = _attach_outcomes(Fh, pg, tg, fam, next_j=Fh.i + 1)
    Fh['context'] = 'in_season'
    Fh['season'] = season
    # week-1 rows: prior season's full-season features, outcome = first game of `season`
    parts = [Fh]
    if season - 1 >= C.FIRST_PBP_SEASON:
        pp, tp = _prep(U.player_games(season - 1), U.team_games(season - 1))
        relp = U.reliability(season - 1, tg=U.team_games(season - 1))
        famp, _ = _fam_map(season - 1, pp)
        np_ = tp.groupby('team_id').j.max()
        cuts1 = pd.DataFrame([(t, -1, int(m)) for t, m in np_.items()], columns=['team_id', 'cut', 'i'])
        X1, T1 = _expand(pp, tp, cuts1)
        F1 = _features(X1, T1, famp, relp)
        F1 = F1.merge(cuts1[['team_id', 'i']], on='team_id', how='left')
        F1 = _attach_streak(F1, pp)
        F1 = _attach_outcomes(F1, pg, tg, fam, next_j=pd.Series(0, index=F1.index))
        # roster confirmation: listed for the same team in `season`'s roster
        roster = _roster_listing(season)
        rt = roster.set_index('espn_id').team_id if len(roster) else pd.Series(dtype=float)
        F1['roster_team_id'] = U._num(rt.reindex(F1.espn_id.values)).values if len(rt) else np.nan
        F1['on_roster'] = np.where(len(rt) == 0, np.nan, (F1.roster_team_id == F1.team_id).astype(float))
        F1['context'] = 'week1'
        F1['season'] = season
        parts.append(F1)
    Hh = pd.concat(parts, ignore_index=True, sort=False)
    keep = ['season', 'context', 'team_id', 'cut', 'i', 'espn_id', 'family', 'usage_metric', 'usage_basis',
            'share_ew', 'share_recent', 'share_season', 'share_prev', 'recent_n', 'season_n',
            'recent_games_used', 'rank', 'team_games',
            'team_games_recent', 'qb_start__l', 'qb_start__r', 'qb_start', 'lead_db__l', 'present__r',
            'next_count', 'next_share', 'next_top', 'next_start', 'next_played', 'streak', 'on_roster',
            'next_exists']
    Hh = Hh[[c for c in keep if c in Hh.columns]].copy()
    try:
        Hh.to_parquet(f, index=False)
        json.dump({'key': '|'.join(map(str, key)) + '|' + CAL_VERSION}, open(fm, 'w'))
    except OSError:
        pass
    _MEM[key] = Hh
    return Hh


def _roster_listing(season):
    """The season's roster listing (identity's source order: ESPN 2026, else cfbfastR,
    else ESPN 2025): espn_id, team_id, position, name, source."""
    parts = []
    if season in I.ESPN_ROSTER_SEASONS:
        parts.append(I.espn_roster(season)[['espn_id', 'team_id', 'position', 'name']].assign(
            src=0 if season in I.ESPN_PREFERRED_SEASONS else 2))
    if season in I.CFBFASTR_ROSTER_SEASONS:
        parts.append(I.cfbfastr_roster(season)[['espn_id', 'team_id', 'position', 'name']].assign(src=1))
    if not parts:
        return pd.DataFrame(columns=['espn_id', 'team_id', 'position', 'name', 'source'])
    r = pd.concat(parts, ignore_index=True)
    r = r[r.team_id.notna()].sort_values(['espn_id', 'src'], kind='mergesort').drop_duplicates('espn_id')
    r['team_id'] = r.team_id.astype('int64')
    r['source'] = np.where(r.src.eq(1), 'cfbfastr_roster_%d' % season, 'espn_roster_%d' % season)
    return r.drop(columns=['src']).reset_index(drop=True)


def _attach_outcomes(F, pg, tg, fam, next_j):
    """Next-game outcome of each (team, cut, player): count and share in his family's
    metric, top-k of his family in that game (usage leader), QB start."""
    F = F.copy()
    F['next_j'] = next_j.values.astype(int)
    nxt = pg[['team_id', 'j', 'espn_id', 'qb_starter'] + METRIC_COLS].copy()
    nxt['family'] = nxt.espn_id.map(fam).fillna('UNKNOWN')
    den = tg.set_index(['team_id', 'j'])
    rows = []
    cnt = np.full(len(nxt), np.nan)
    shr = np.full(len(nxt), np.nan)
    for f_, (c, d, _n) in OFF_METRIC.items():
        sel = (nxt.family == f_).values
        if not sel.any():
            continue
        cnt[sel] = nxt.loc[sel, c].values
        dd = np.asarray(den[d].reindex(pd.MultiIndex.from_arrays([nxt.team_id.values[sel], nxt.j.values[sel]])).values,
                        dtype=float)
        num = np.asarray(nxt.loc[sel, c].values, dtype=float)
        ok = np.isfinite(dd) & (dd > 0)
        shr[sel] = np.where(ok, num / np.where(ok, dd, 1.0), np.nan)
    nxt['next_count'] = cnt
    nxt['next_share'] = shr
    nxt['cnt0'] = nxt.next_count.fillna(0)
    nxt['next_rank'] = nxt.groupby(['team_id', 'j', 'family']).cnt0.rank(method='min', ascending=False)
    nxt['k'] = nxt.family.map(SLOTS)
    nxt['next_top'] = (nxt.next_rank <= nxt.k) & (nxt.cnt0 > 0)
    nxt = nxt.rename(columns={'j': 'next_j', 'qb_starter': 'next_start'})
    nxt['next_played'] = True
    F = F.merge(nxt[['team_id', 'next_j', 'espn_id', 'next_count', 'next_share', 'next_top', 'next_start',
                     'next_played']], on=['team_id', 'next_j', 'espn_id'], how='left')
    ex = tg[['team_id', 'j']].rename(columns={'j': 'next_j'}).assign(next_exists=True)
    F = F.merge(ex, on=['team_id', 'next_j'], how='left')
    F['next_exists'] = F.next_exists.fillna(False).astype(bool)
    for c in ('next_top', 'next_start', 'next_played'):
        F[c] = F[c].fillna(False).astype(bool)
    F['next_count'] = np.where(F.next_exists, F.next_count.fillna(0.0), np.nan)
    F['next_share'] = np.where(F.next_exists, F.next_share.fillna(0.0), np.nan)
    return F


# ============================================================ calibration
SHARE_EDGES = (0.0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.45, 0.60, 0.80, 1.0001)
STREAK_BUCKETS = ((1, 1, '1'), (2, 2, '2'), (3, 4, '3-4'), (5, 999, '5+'))


def _streak_bucket(s):
    for lo, hi, lab in STREAK_BUCKETS:
        if lo <= s <= hi:
            return lab
    return None


def _share_bucket(x):
    if x is None or not np.isfinite(x):
        return None
    for k in range(len(SHARE_EDGES) - 1):
        if SHARE_EDGES[k] <= x < SHARE_EDGES[k + 1]:
            return k
    return len(SHARE_EDGES) - 2


def _rank_bucket(r, fam):
    if r is None or not np.isfinite(r):
        return None
    top = SLOTS.get(fam, 1) + 2
    return int(min(r, top))


def train_seasons(season):
    lo = max(C.FIRST_PBP_SEASON + 1, int(season) - TRAIN_SEASONS)
    return list(range(lo, int(season)))


def _smooth(k, n, prior, a=SMOOTH_A):
    return (k + a * prior) / (n + a)


def _qb_keys(df):
    """QB table keys: the cut game's starter by streak bucket and whether he led the team
    in dropbacks that game; everyone else by his rank among the team's QBs and whether he
    started any of the last 3 games."""
    last = df.streak.fillna(0) > 0
    key = np.where(last, 'LS|' + df.streak.fillna(0).astype(int).map(_streak_bucket).astype(str) + '|' +
                   (df.lead_db__l.fillna(0) > 0).astype(int).astype(str),
                   'OT|' + df['rank'].fillna(9).clip(upper=3).astype(int).astype(str) + '|' +
                   (df.qb_start__r.fillna(0) > 0).astype(int).astype(str))
    coarse = np.where(last, 'LS', 'OT')
    return key, coarse


def _fit_rate_table(keys, coarse, y):
    """Two-level smoothed rates: cell -> coarse group -> overall."""
    d = pd.DataFrame({'k': keys, 'c': coarse, 'y': y.astype(float)})
    base = float(d.y.mean()) if len(d) else 0.5
    cg = d.groupby('c').y.agg(['sum', 'count'])
    cp = {c: _smooth(r['sum'], r['count'], base) for c, r in cg.iterrows()}
    kg = d.groupby(['k', 'c']).y.agg(['sum', 'count']).reset_index()
    table = {}
    for r in kg.itertuples(index=False):
        table[r.k] = {'p': _smooth(r.sum, r.count, cp[r.c]), 'n': int(r.count), 'k': float(r.sum)}
    return {'cells': table, 'coarse': {c: float(v) for c, v in cp.items()}, 'base': base}


def _predict_rate(tab, keys, coarse):
    out = np.full(len(keys), np.nan)
    for i, (k, c) in enumerate(zip(keys, coarse)):
        if k in tab['cells']:
            out[i] = tab['cells'][k]['p']
        elif c in tab['coarse']:
            out[i] = tab['coarse'][c]
        else:
            out[i] = tab['base']
    return out


def _leader_keys(df):
    fam = df.family.astype(str)
    rb = [_rank_bucket(r, f) for r, f in zip(df['rank'].values, fam.values)]
    sb = [_share_bucket(x) for x in df.share_ew.values]
    ctx = df.context.astype(str).values
    key = np.array(['%s|%s|%s|%s' % (c, f, r, s) for c, f, r, s in zip(ctx, fam.values, rb, sb)], dtype=object)
    coarse = np.array(['%s|%s|%s' % (c, f, r) for c, f, r in zip(ctx, fam.values, rb)], dtype=object)
    return key, coarse


def _week1_qb_keys(df):
    last = df.streak.fillna(0) > 0
    ros = df.on_roster.map(lambda v: 'na' if pd.isna(v) else str(int(v)))
    key = np.where(last, 'W1LS|' + ros, 'W1OT|' + df['rank'].fillna(9).clip(upper=3).astype(int).astype(str) + '|' + ros)
    coarse = np.where(last, 'W1LS', 'W1OT')
    return key, coarse


def _role_thresholds(Hin):
    """Per role family: t_full = P25 of the expected share of starter-slot holders (rank
    <= slots) at cuts with >= 3 team games; t_rot = half of t_full (a rotational player
    gets at least half a low-end starter's share)."""
    out = {}
    h = Hin[(Hin.team_games >= 3) & Hin.share_ew.notna()]
    for f in ROLE_FAMILIES:
        s = h[(h.family == f) & (h['rank'] <= SLOTS[f])].share_ew
        b = h[(h.family == f) & (h['rank'] == SLOTS[f] + 1)].share_ew
        if len(s) < 50:
            continue
        t_full = float(np.quantile(s, 0.25))
        out[f] = {'t_full': round(t_full, 4), 't_rot': round(t_full / 2.0, 4),
                  'starter_slot_share_p25': round(t_full, 4),
                  'starter_slot_share_p50': round(float(np.quantile(s, 0.5)), 4),
                  'first_backup_share_p50': round(float(np.quantile(b, 0.5)), 4) if len(b) else None,
                  'first_backup_share_p75': round(float(np.quantile(b, 0.75)), 4) if len(b) else None,
                  'n_starter_slot': int(len(s)), 'n_first_backup': int(len(b))}
    return out


def fit(seasons):
    """Estimate every table from the history of `seasons` (complete seasons)."""
    Hh = pd.concat([history(s) for s in seasons], ignore_index=True)
    Hin = Hh[Hh.context.eq('in_season') & Hh.next_exists]
    Hw = Hh[Hh.context.eq('week1') & Hh.next_exists]
    q = Hin[Hin.family.eq('QB') & Hin.share_ew.notna()]
    kq, cq = _qb_keys(q)
    qb = _fit_rate_table(kq, cq, q.next_start)
    qw = Hw[Hw.family.eq('QB') & Hw.share_ew.notna()]
    kq1, cq1 = _week1_qb_keys(qw)
    qb_w1 = _fit_rate_table(kq1, cq1, qw.next_start)
    # week-1 rows: the state keeps only roster-confirmed (or roster-less) players, so the
    # table is fitted on the same population
    lf = Hh[Hh.next_exists & Hh.family.isin([f for f in SLOTS if f != 'QB']) & Hh.share_ew.notna() &
            (Hh.context.eq('in_season') | Hh.on_roster.ne(0))]
    kl, cl = _leader_keys(lf)
    leader = _fit_rate_table(kl, cl, lf.next_top)
    return {'version': CAL_VERSION, 'train_seasons': list(seasons), 'qb': qb, 'qb_week1': qb_w1,
            'leader': leader, 'roles': _role_thresholds(Hin),
            'n': {'qb_in_season': int(len(q)), 'qb_week1': int(len(qw)), 'leader': int(len(lf))}}


def calibration(season):
    """The tables for `season`, fitted on the TRAIN_SEASONS complete seasons before it.
    Cached in <OUT>/personnel/calibration_<season>.json."""
    seasons = train_seasons(season)
    key = ('cal', int(season), tuple(seasons))
    if key in _MEM:
        return _MEM[key]
    f = common.out_path('personnel', 'calibration_%d.json' % int(season))
    sig = ids.h(CAL_VERSION, U.CODE_VERSION, *[U._cache_key(s) for s in seasons])
    try:
        cal = json.load(open(f))
        if cal.get('signature') == sig:
            _MEM[key] = cal
            return cal
    except (OSError, ValueError):
        pass
    cal = fit(seasons)
    cal['signature'] = sig
    cal = ids.clean(cal)
    try:
        with open(f, 'w') as fh:
            json.dump(cal, fh, sort_keys=True, indent=1)
    except OSError:
        pass
    _MEM[key] = cal
    return cal


def predict_starter(df, cal):
    """starter_probability for rows carrying the history/state features."""
    p = np.full(len(df), np.nan)
    basis = np.array([None] * len(df), dtype=object)
    if not len(df):
        return p, basis
    ctx = df.context.values
    isq = (df.family == 'QB').values & df.share_ew.notna().values
    m = isq & (ctx == 'in_season')
    if m.any():
        k, c = _qb_keys(df[m])
        p[m] = _predict_rate(cal['qb'], k, c)
        basis[m] = 'qb_start_history'
    m = isq & (ctx == 'week1')
    if m.any():
        k, c = _week1_qb_keys(df[m])
        p[m] = _predict_rate(cal['qb_week1'], k, c)
        basis[m] = 'qb_start_history_week1'
    m = (~isq) & df.family.isin([f for f in SLOTS if f != 'QB']).values & df.share_ew.notna().values
    if m.any():
        k, c = _leader_keys(df[m])
        p[m] = _predict_rate(cal['leader'], k, c)
        basis[m] = 'usage_leader_next_game'
    return p, basis


def reliability_table(train, holdout, bins=10):
    """Fit on `train` seasons, predict the `holdout` season, and bin: the held-out
    reliability evidence (METHODS_FOUNDATION.md)."""
    cal = fit(train)
    Hh = history(holdout)
    Hh = Hh[Hh.next_exists & Hh.share_ew.notna() & Hh.family.isin(list(SLOTS))].copy()
    p, basis = predict_starter(Hh, cal)
    Hh['p'] = p
    Hh['y'] = np.where(Hh.family.eq('QB'), Hh.next_start, Hh.next_top).astype(float)
    out = {'train': list(train), 'holdout': holdout, 'groups': {}}
    for name, g in (('QB_in_season', Hh[Hh.family.eq('QB') & Hh.context.eq('in_season')]),
                    ('QB_week1', Hh[Hh.family.eq('QB') & Hh.context.eq('week1')]),
                    ('RB', Hh[Hh.family.eq('RB') & Hh.context.eq('in_season')]),
                    ('WR', Hh[Hh.family.eq('WR') & Hh.context.eq('in_season')]),
                    ('TE', Hh[Hh.family.eq('TE') & Hh.context.eq('in_season')]),
                    ('K_P', Hh[Hh.family.isin(['K', 'P']) & Hh.context.eq('in_season')]),
                    ('non_QB_week1', Hh[~Hh.family.eq('QB') & Hh.context.eq('week1') & Hh.on_roster.ne(0)])):
        g = g[g.p.notna()]
        if not len(g):
            continue
        b = np.minimum((g.p * bins).astype(int), bins - 1)
        tab = g.groupby(b).agg(n=('y', 'size'), mean_pred=('p', 'mean'), observed=('y', 'mean')).reset_index()
        ece = float((tab.n * (tab.mean_pred - tab.observed).abs()).sum() / tab.n.sum())
        out['groups'][name] = {
            'n': int(len(g)), 'base_rate': float(g.y.mean()), 'brier': float(((g.p - g.y) ** 2).mean()),
            'brier_base': float(((g.y.mean() - g.y) ** 2).mean()), 'ece': ece,
            'table': [{'bin': '%.1f-%.1f' % (r.index / bins, (r.index + 1) / bins), 'n': int(r.n),
                       'mean_pred': round(float(r.mean_pred), 4), 'observed': round(float(r.observed), 4)}
                      for r in tab.rename(columns={tab.columns[0]: 'index'}).itertuples(index=False)]}
    return out


# ================================================================ roles
def assign_roles(F, thresholds):
    """Role per row (see METHODS_FOUNDATION.md "roles"). Usage-share based; a share is
    never enough for a starter role without the recent-volume evidence."""
    role = np.array(['UNKNOWN'] * len(F), dtype=object)
    basis = np.array(['no_usage_data'] * len(F), dtype=object)
    fam = F.family.values
    share = F.share_ew.values
    rank = F['rank'].values
    rn = F.recent_n.fillna(0).values
    rg = F.recent_games_used.fillna(0).values
    tgr = F.team_games_recent.fillna(0).values
    tgames = F.team_games.fillna(0).values
    season_n = F.season_n.fillna(0).values
    for i in range(len(F)):
        f = fam[i]
        if f in ROLE_FAMILIES:
            th = thresholds.get(f)
            if th is None or share[i] is None or not np.isfinite(share[i]):
                if tgames[i] >= 2 and season_n[i] == 0:
                    role[i], basis[i] = 'DEEP RESERVE', 'no_usage_this_season'
                else:
                    role[i], basis[i] = 'UNKNOWN', 'no_usage_evidence_yet'
                continue
            s = float(share[i])
            evidence = rn[i] >= MIN_RECENT_EVENTS[f] and rg[i] >= min(MIN_RECENT_GAMES, tgr[i])
            top = np.isfinite(rank[i]) and rank[i] <= SLOTS[f]
            if season_n[i] == 0:
                role[i] = 'DEEP RESERVE' if tgames[i] >= 2 else 'UNKNOWN'
                basis[i] = 'no_usage_this_season' if tgames[i] >= 2 else 'no_usage_evidence_yet'
            elif top and evidence and s >= th['t_full']:
                role[i], basis[i] = 'FULL-TIME STARTER', 'usage_share'
            elif top and evidence and s >= th['t_rot']:
                role[i], basis[i] = 'ROTATIONAL STARTER', 'usage_share'
            elif s >= th['t_rot']:
                role[i], basis[i] = 'ROTATIONAL', 'usage_share' if evidence else 'usage_share_low_volume'
            else:
                role[i], basis[i] = 'BACKUP', 'usage_share'
        elif f in ('K', 'P', 'RETURNER'):
            if share[i] is not None and np.isfinite(share[i]) and season_n[i] > 0:
                if np.isfinite(rank[i]) and rank[i] == 1 and rn[i] > 0:
                    role[i], basis[i] = 'SPECIALIST', 'usage_share'
                else:
                    role[i], basis[i] = 'BACKUP', 'usage_share'
            elif f == 'RETURNER':
                role[i], basis[i] = 'UNKNOWN', 'no_usage_evidence_yet'
            else:
                role[i] = 'DEEP RESERVE' if tgames[i] >= 2 else 'UNKNOWN'
                basis[i] = 'no_usage_this_season' if tgames[i] >= 2 else 'no_usage_evidence_yet'
        elif f == 'LS':
            role[i], basis[i] = 'SPECIALIST', 'position_only_no_usage_data'
        elif f in POS.OL_FAMILIES:
            role[i], basis[i] = 'UNKNOWN', 'no_participation_data_ol'
        elif f in POS.DEFENSIVE_FAMILIES:
            role[i], basis[i] = 'UNKNOWN', 'no_participation_data_defense'
        else:
            role[i], basis[i] = 'UNKNOWN', 'unknown_position'
    return role, basis


# ========================================================== availability
def load_reports(season, reports_dir=None):
    """Official availability reports (football/availability/reports/<season>_*.json)."""
    import glob
    d = reports_dir or os.path.join(I.REPO, 'football', 'availability', 'reports')
    out = []
    for f in sorted(glob.glob(os.path.join(d, '%d_*.json' % int(season)))):
        try:
            r = json.load(open(f))
        except (OSError, ValueError):
            continue
        r['_file'] = os.path.basename(f)
        out.append(r)
    return out


def _status_key(s):
    return ' '.join(str(s or '').upper().replace('_', ' ').replace('-', ' ').split())


def _truthy(v):
    return v is True or str(v).strip().lower() == 'true'


def _known_time(r):
    """A report is knowledge from its publication time; with none, from its retrieval
    (v2.weekly.availability._known_at)."""
    t = r.get('published_at') or r.get('retrieved_at')
    if t in (None, '', 'None'):
        return None
    return U.to_ts(t)


def _report_team(r, sched, team_of_player):
    gid = U._num(pd.Series([r.get('game_id')])).iloc[0]
    if pd.notna(gid):
        g = sched[sched.game_id.eq(int(gid))]
        if len(g):
            g = g.iloc[0]
            k = U.name_key(r.get('team'))
            names = {side: U.name_key(g[side + '_team']) for side in ('home', 'away')}
            exact = [s_ for s_, nk in names.items() if k and nk == k]
            if len(exact) == 1:
                return int(g[exact[0] + '_id'])
            pref = [s_ for s_, nk in names.items() if k and nk and (nk.startswith(k) or k.startswith(nk))]
            if len(pref) == 1:
                return int(g[pref[0] + '_id'])
    votes = {}
    for p in r.get('rows') or []:
        e = U._num(pd.Series([p.get('player_id')])).iloc[0]
        if pd.notna(e) and int(e) in team_of_player:
            t = team_of_player[int(e)]
            votes[t] = votes.get(t, 0) + 1
    if votes:
        return sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return None


def availability_state(season, T, next_games, team_of_player, reports=None):
    """Per (team, espn_id) availability at T and per-team report status.
    next_games: {team_id: game_id of the team's next game at T}."""
    T = U.to_ts(T)
    reports = load_reports(season) if reports is None else reports
    sched = U.kickoffs(int(season))
    known = []
    for r in reports:
        kt = _known_time(r)
        if kt is None or kt > T:
            continue                                   # not knowledge at T
        if not _truthy(r.get('ok', True)):
            continue                                   # a failed read is not a report
        tid = r.get('team_id')
        tid = int(tid) if tid not in (None, '', 'None') else _report_team(r, sched, team_of_player)
        if tid is None:
            continue
        known.append((tid, kt, r))
    per_player, per_team = {}, {}
    # one report per team: the latest known one for the team's NEXT game; with none, the
    # latest known one for an earlier game (its statuses are then stale information only)
    best = {}
    for tid, kt, r in sorted(known, key=lambda x: (x[0], x[1], str(x[2].get('_file', '')))):
        nxt = str(next_games.get(tid)) if next_games.get(tid) is not None else None
        fresh = nxt is not None and str(r.get('game_id')) == nxt
        if fresh or not best.get(tid, (None, None, None, False))[3]:
            best[tid] = (tid, kt, r, fresh)
    for tid, kt, r, fresh in (best[t] for t in sorted(best)):
        gid = str(r.get('game_id'))
        tier = TIER_OF_PLATFORM.get(str(r.get('platform') or 'conference').lower(), 2)
        age = round((T - kt).total_seconds() / 3600.0, 2)
        per_team[tid] = {'fresh': fresh, 'comprehensive': _truthy(r.get('comprehensive')), 'tier': tier,
                         'published_at': ids.ts(kt), 'age': age, 'game_id': gid,
                         'source': r.get('source_url'), 'listed': set()}
        for p in r.get('rows') or []:
            e = U._num(pd.Series([p.get('player_id')])).iloc[0]
            if pd.isna(e):
                continue
            sk = _status_key(p.get('status'))
            pp = PLAY_PROBABILITY.get(sk)
            frac = GAME_FRACTION.get(sk, 1.0)
            per_team[tid]['listed'].add(int(e))
            per_player[(tid, int(e))] = {
                'availability_status': sk if fresh else 'STALE_PRIOR_GAME:' + sk,
                'play_probability': pp if fresh else None,
                'expected_availability': (pp * frac if pp is not None else None) if fresh else None,
                'availability_basis': 'official_report_next_game' if fresh else 'official_report_prior_game',
                'availability_source_tier': tier, 'availability_published_at': ids.ts(kt),
                'availability_status_age_hours': age, 'availability_report_game_id': gid,
                'availability_source': r.get('source_url')}
    return per_player, per_team


# ============================================================== the state
def _next_games(season, T, teams):
    k = U.kickoffs(int(season))
    k = k[k.kickoff_ts.notna() & (k.kickoff_ts >= T)].sort_values(['kickoff_ts', 'game_id'], kind='mergesort')
    out = {}
    for side in ('home_id', 'away_id'):
        for tid, gid, ts_ in zip(k[side].tolist(), k.game_id.tolist(), k.kickoff_ts.tolist()):
            if tid is None or pd.isna(tid):
                continue
            tid = int(tid)
            if tid not in out or ts_ < out[tid][1]:
                out[tid] = (int(gid), ts_)
    return {t: out[t] for t in teams if t in out}, out


def _cut_features(pg, tg, fam, rel, teams=None):
    if not len(tg):
        return pd.DataFrame()
    n = tg.groupby('team_id').j.max()
    if teams is not None:
        n = n[n.index.isin(list(teams))]
    cuts = pd.DataFrame({'team_id': n.index.values, 'cut': 0, 'i': n.values.astype(int)})
    X, TT = _expand(pg, tg, cuts)
    F = _features(X, TT, fam, rel)
    F = F.merge(cuts[['team_id', 'i']], on='team_id', how='left')
    F = _attach_streak(F, pg)
    return F


def _id_role(fam):
    return {'QB': 'passer', 'RB': 'rusher', 'WR': 'receiver', 'TE': 'receiver', 'K': 'xp'}.get(
        fam, 'def_sacks' if fam in POS.FRONT7_FAMILIES else 'def_pbu' if fam in POS.SECONDARY_FAMILIES else None)


def player_week_state(season, T, availability=None, include_roster=True, _pbp=None, _pbp_prev=None):
    """One row per player on a team's usage list (or roster) at instant T.

    availability: None -> the repository's reports for the season; a list of report
    dicts (the files' schema) -> exactly those; [] -> none (every row UNKNOWN).
    _pbp / _pbp_prev: explicit play tables for `season` / `season-1` (tests)."""
    season = int(season)
    T = U.to_ts(T)
    cal = calibration(season)
    pg0 = U.player_games(season, T, pbp=_pbp)
    tg0 = U.team_games(season, T, pbp=_pbp)
    rel = U.reliability(season, tg=tg0)
    pg, tg = _prep(pg0, tg0)
    fam_map, pl = _fam_map(season, pg)
    pl = pl.set_index('espn_id')
    sched = U.kickoffs(season)
    sched_teams = sorted(set(sched.home_id.dropna().astype(int)) | set(sched.away_id.dropna().astype(int)))
    sched_teams = [t for t in sched_teams if t not in U.ALL_STAR_TEAM_IDS]
    teams_played = set(tg.team_id.unique()) if len(tg) else set()

    # ---- in-season rows: every player with a game for the team before T; a player who
    # appeared for two teams is listed under his latest one only
    F = _cut_features(pg, tg, fam_map, rel)
    if len(F):
        F = F.sort_values(['espn_id', 'player_last_game_ts', 'team_id'], kind='mergesort')
        F = F.drop_duplicates('espn_id', keep='last')
        F['context'] = 'in_season'
        F['usage_source'] = 'pbp_in_season'

    # ---- prior season (full, complete before `season` starts)
    prev = pd.DataFrame()
    relp = {}
    if season - 1 >= C.FIRST_PBP_SEASON:
        pp0 = U.player_games(season - 1, pbp=_pbp_prev)
        tp0 = U.team_games(season - 1, pbp=_pbp_prev)
        relp = U.reliability(season - 1, tg=tp0)
        pp, tp = _prep(pp0, tp0)
        famp = {e: fam_map.get(e) or f for e, f in _fam_map(season - 1, pp)[0].items()}
        prev = _cut_features(pp, tp, famp, relp)
    roster = _roster_listing(season) if include_roster else _roster_listing(-1)
    rteam = roster.set_index('espn_id').team_id if len(roster) else pd.Series(dtype='float64')

    # ---- week-1 rows: teams with no game before T use last season's usage list,
    # restricted to players the season's roster lists for the same team (when a roster exists)
    W = pd.DataFrame()
    wk1_teams = [t for t in sched_teams if t not in teams_played]
    if len(prev) and wk1_teams:
        W = prev[prev.team_id.isin(wk1_teams)].copy()
        W = W.sort_values(['espn_id', 'player_last_game_ts'], kind='mergesort').drop_duplicates('espn_id', keep='last')
        if len(rteam):
            rt = U._num(rteam.reindex(W.espn_id.values)).values
            W['on_roster'] = np.where(np.isnan(rt), 0.0, (rt == W.team_id.values).astype(float))
            W = W[W.on_roster.eq(1.0)]
        else:
            W['on_roster'] = np.nan
        W = W[~W.espn_id.isin(set(F.espn_id) if len(F) else set())]
        W['context'] = 'week1'
        W['usage_source'] = 'pbp_prior_season'
    rows = pd.concat([x for x in (F, W) if len(x)], ignore_index=True, sort=False) if (len(F) or len(W)) \
        else pd.DataFrame(columns=['team_id', 'espn_id', 'context', 'family'])
    if 'on_roster' not in rows.columns:
        rows['on_roster'] = np.nan

    # ---- roster-only rows (no usage before T for this team this season)
    if include_roster and len(roster):
        have = set(rows.espn_id)
        ro = roster[roster.team_id.isin(sched_teams) & ~roster.espn_id.isin(have)]
        if len(ro):
            R = pd.DataFrame({'team_id': ro.team_id.values, 'espn_id': ro.espn_id.values,
                              'context': 'roster_only', 'usage_source': 'roster_only', 'on_roster': 1.0})
            tgm = tg.groupby('team_id').j.max() + 1 if len(tg) else pd.Series(dtype=float)
            R['team_games'] = tgm.reindex(R.team_id.values).fillna(0).values
            rows = pd.concat([rows, R], ignore_index=True, sort=False)
    if not len(rows):
        return pd.DataFrame()
    rows['family'] = rows.espn_id.map(lambda e: fam_map.get(e) or 'UNKNOWN')
    for c in ('share_ew', 'share_recent', 'share_season', 'share_prev', 'recent_n', 'season_n',
              'recent_games_used', 'rank', 'team_games', 'team_games_recent', 'streak', 'qb_start__r',
              'qb_start', 'lead_db__l', 'present__r', 'games'):
        if c not in rows.columns:
            rows[c] = np.nan
    # roster-only players of a team that has played: a known zero in the family metric
    ro = rows.context.eq('roster_only')
    for fam in rows.family[ro].unique():
        m = _metric_for(fam, rel)
        if m is None:
            continue
        sel = ro & rows.family.eq(fam) & rows.team_games.fillna(0).gt(0)
        rows.loc[sel, ['share_ew', 'share_recent', 'share_season', 'share_prev', 'recent_n', 'season_n',
                       'recent_games_used']] = 0.0
        rows.loc[sel, 'usage_metric'] = m[2]
        rows.loc[sel, 'usage_basis'] = m[3]

    # ---- depth rank: order within (team, family) by expected share (usage-derived)
    rows['_e'] = rows.share_ew.fillna(-1.0)
    rows['_s'] = rows.share_season.fillna(-1.0)
    rows['_n'] = rows.recent_n.fillna(-1.0)
    rows = rows.sort_values(['team_id', 'family', '_e', '_s', '_n', 'espn_id'],
                            ascending=[True, True, False, False, False, True], kind='mergesort')
    rows['depth_rank'] = (rows.groupby(['team_id', 'family']).cumcount() + 1).astype(float)
    rows.loc[rows.share_ew.isna(), 'depth_rank'] = np.nan
    rows['rank'] = rows.depth_rank
    rows = rows.drop(columns=['_e', '_s', '_n']).reset_index(drop=True)

    # ---- roles and starter probability
    role, rbasis = assign_roles(rows, cal['roles'])
    rows['role'] = role
    rows['role_basis'] = rbasis
    sp_rows = rows[rows.context.isin(['in_season', 'week1'])]
    p, pb = predict_starter(sp_rows, cal)
    rows['starter_probability'] = np.nan
    rows['starter_probability_basis'] = None
    rows.loc[sp_rows.index, 'starter_probability'] = p
    rows.loc[sp_rows.index, 'starter_probability_basis'] = pb
    # the team's QBs cannot start more than one game between them; WRs fill 3 slots
    for fam_, k in SLOTS.items():
        m = rows.family.eq(fam_) & rows.starter_probability.notna()
        tot = rows[m].groupby('team_id').starter_probability.transform('sum')
        scale = np.where(tot > k, k / tot, 1.0)
        rows.loc[m, 'starter_probability'] = rows.loc[m, 'starter_probability'].values * scale

    # ---- availability
    next_games, _ = _next_games(season, T, sorted(set(rows.team_id.astype(int))))
    team_of_player = dict(zip(rows.espn_id.astype(int), rows.team_id.astype(int)))
    reports = availability if availability is not None else None
    per_player, per_team = availability_state(season, T, {t: g for t, (g, _) in next_games.items()},
                                              team_of_player, reports=reports)
    av_cols = ['expected_availability', 'play_probability', 'availability_status', 'availability_basis',
               'availability_source_tier', 'availability_published_at', 'availability_status_age_hours',
               'availability_report_game_id', 'availability_source']
    av = {c: [] for c in av_cols}
    for t, e in zip(rows.team_id.astype(int).values, rows.espn_id.astype(int).values):
        rec = per_player.get((t, e))
        if rec is None:
            tm = per_team.get(t)
            if tm and tm['fresh'] and tm['comprehensive']:
                rec = {'availability_status': 'NOT_LISTED', 'play_probability': 1.0, 'expected_availability': 1.0,
                       'availability_basis': 'not_listed_on_comprehensive_report_next_game',
                       'availability_source_tier': tm['tier'], 'availability_published_at': tm['published_at'],
                       'availability_status_age_hours': tm['age'], 'availability_report_game_id': tm['game_id'],
                       'availability_source': tm['source']}
            else:
                rec = {'availability_status': 'UNKNOWN', 'play_probability': None, 'expected_availability': None,
                       'availability_basis': 'no_report_known_at_T' if not tm else
                       ('report_for_prior_game_only' if not tm['fresh'] else 'not_listed_report_not_comprehensive'),
                       'availability_source_tier': None, 'availability_published_at': None,
                       'availability_status_age_hours': None, 'availability_report_game_id': None,
                       'availability_source': None}
        for c in av_cols:
            av[c].append(rec.get(c))
    for c in av_cols:
        rows[c] = av[c]

    # ---- identity, position, prior season, freshness, quality
    name_now = pg.sort_values(['espn_id', 'kickoff_ts'], kind='mergesort').drop_duplicates('espn_id', keep='last') \
        .set_index('espn_id').name if len(pg) else pd.Series(dtype=object)
    rname = roster.set_index('espn_id').name if len(roster) else pd.Series(dtype=object)
    pname = prev.set_index('espn_id').name if len(prev) and 'name' in prev else pd.Series(dtype=object)
    names = []
    for e in rows.espn_id.values:
        v = name_now.get(e) if e in name_now.index else None
        if v is None or (isinstance(v, float) and np.isnan(v)):
            v = rname.get(e) if e in rname.index else None
        if v is None or (isinstance(v, float) and np.isnan(v)):
            v = pname.get(e) if len(pname) and e in pname.index else None
        names.append(v)
    rows['name'] = names
    rows['original_position'] = pl.original_position.reindex(rows.espn_id.values).values
    rows['position_basis'] = pl.position_basis.reindex(rows.espn_id.values).fillna('unknown').values
    rows['position_source'] = pl.position_source.reindex(rows.espn_id.values).values
    rows['unit'] = [POS.unit_of(f) for f in rows.family]
    rows['weekly_unit'] = [POS.weekly_unit_of(f) for f in rows.family]
    if len(prev):
        pv = prev.sort_values(['espn_id', 'games'], kind='mergesort').drop_duplicates('espn_id', keep='last') \
            .set_index('espn_id')
        rows['prior_season_team_id'] = pv.team_id.reindex(rows.espn_id.values).values
        rows['prior_season_share'] = pv.share_season.reindex(rows.espn_id.values).values
        rows['prior_season_usage_metric'] = pv.usage_metric.reindex(rows.espn_id.values).values
    else:
        rows['prior_season_team_id'] = np.nan
        rows['prior_season_share'] = np.nan
        rows['prior_season_usage_metric'] = None
    rows['roster_team_id'] = U._num(rteam.reindex(rows.espn_id.values)).values if len(rteam) else np.nan
    rows['roster_listed'] = rows.roster_team_id.eq(rows.team_id)
    rows['roster_pit'] = False
    rows['next_game_id'] = [next_games.get(int(t), (None, None))[0] for t in rows.team_id]
    rows['next_game_kickoff'] = [ids.ts(next_games.get(int(t), (None, None))[1]) for t in rows.team_id]
    cov, ver = [], []
    for f in rows.family.values:
        r_ = rel.get(_id_role(f)) if _id_role(f) else None
        cov.append(r_.get('id_coverage') if r_ else None)
        ver.append(r_.get('verdict') if r_ else None)
    rows['id_coverage'] = cov
    rows['id_coverage_verdict'] = ver
    fresh = []
    for c_, pr, tgr in zip(rows.context.values, rows.present__r.values, rows.get('present__l', pd.Series(
            np.nan, index=rows.index)).values):
        if c_ == 'week1':
            fresh.append('PRIOR_SEASON')
        elif c_ == 'roster_only':
            fresh.append('ROSTER_ONLY')
        elif tgr == 1:
            fresh.append('CURRENT')
        elif pr and pr > 0:
            fresh.append('RECENT')
        else:
            fresh.append('STALE')
    rows['freshness'] = fresh
    q = []
    for c_, m_, v_ in zip(rows.context.values, rows.usage_metric.values, rows.id_coverage_verdict.values):
        if m_ is None or (isinstance(m_, float) and np.isnan(m_)):
            q.append('LOW')
        elif c_ == 'roster_only':
            q.append('LOW')
        elif c_ == 'week1' or v_ in ('WEAK', 'INSUFFICIENT'):
            q.append('MEDIUM')
        else:
            q.append('HIGH')
    rows['source_quality'] = q
    rows['def_data_reliable'] = [
        (rel.get('def_sacks', {}).get('verdict') == 'RELIABLE') if f in POS.FRONT7_FAMILIES else
        (rel.get('def_pbu', {}).get('verdict') == 'RELIABLE') if f in POS.SECONDARY_FAMILIES else None
        for f in rows.family.values]
    last_ts = pd.to_datetime(rows['player_last_game_ts'] if 'player_last_game_ts' in rows else
                             pd.Series(pd.NaT, index=rows.index), utc=True)
    team_ts = pd.to_datetime(rows['team_last_game_ts'] if 'team_last_game_ts' in rows else
                             pd.Series(pd.NaT, index=rows.index), utc=True)
    rows['days_since_player_game'] = ((T - last_ts).dt.total_seconds() / 86400.0).round(2)

    # ---- the row
    out = pd.DataFrame({
        'rule_version': RULE, 'personnel_rule_version': RULE_VERSION, 'as_of': ids.ts(T), 'season': season,
        'team_id': rows.team_id.astype('int64').values, 'player_id': 'espn:' + rows.espn_id.astype('int64').astype(str),
        'espn_id': rows.espn_id.astype('int64').values, 'name': rows.name.values,
        'original_position': rows.original_position.values, 'position_family': rows.family.values,
        'position_basis': rows.position_basis.values, 'position_source': rows.position_source.values,
        'unit': rows.unit.values, 'weekly_unit': rows.weekly_unit.values,
        'context': rows.context.values, 'usage_source': rows.usage_source.values,
        'usage_metric': rows.usage_metric.values, 'usage_basis': rows.usage_basis.values,
        'expected_usage_share': rows.share_ew.values, 'recent_share': rows.share_recent.values,
        'season_share': rows.share_season.values, 'previous_game_share': rows.share_prev.values,
        'recent_usage_count': rows.recent_n.values, 'season_usage_count': rows.season_n.values,
        'recent_games_used': rows.recent_games_used.values, 'player_games': rows.games.values,
        'team_games': rows.team_games.values, 'team_games_recent': rows.team_games_recent.values,
        'role': rows.role.values, 'role_basis': rows.role_basis.values,
        'depth_rank': rows.depth_rank.values,
        'depth_basis': np.where(rows.depth_rank.isna(), None,
                                np.where(rows.usage_basis.eq('production'), 'production_derived', 'usage_derived')),
        'starter_probability': rows.starter_probability.values,
        'starter_probability_basis': rows.starter_probability_basis.values,
        'is_last_starter': (rows.streak.fillna(0) > 0).values & rows.family.eq('QB').values,
        'qb_start_streak': np.where(rows.family.eq('QB'), rows.streak, np.nan),
        'qb_starts_recent': np.where(rows.family.eq('QB'), rows.qb_start__r, np.nan),
        'qb_starts_season': np.where(rows.family.eq('QB') & rows.context.eq('in_season'), rows.qb_start, np.nan),
        'expected_availability': rows.expected_availability.values, 'play_probability': rows.play_probability.values,
        'availability_status': rows.availability_status.values, 'availability_basis': rows.availability_basis.values,
        'availability_source_tier': rows.availability_source_tier.values,
        'availability_published_at': rows.availability_published_at.values,
        'availability_status_age_hours': rows.availability_status_age_hours.values,
        'availability_report_game_id': rows.availability_report_game_id.values,
        'availability_source': rows.availability_source.values,
        'next_game_id': pd.array(U._num(rows.next_game_id).values, dtype='Int64'),
        'next_game_kickoff': rows.next_game_kickoff.values,
        'prior_season_team_id': pd.array(U._num(rows.prior_season_team_id).values, dtype='Int64'),
        'prior_season_share': rows.prior_season_share.values,
        'prior_season_usage_metric': rows.prior_season_usage_metric.values,
        'roster_listed': rows.roster_listed.values,
        'roster_team_id': pd.array(U._num(rows.roster_team_id).values, dtype='Int64'),
        'roster_pit': False,
        'id_coverage': rows.id_coverage.values, 'id_coverage_verdict': rows.id_coverage_verdict.values,
        'def_data_reliable': rows.def_data_reliable.values, 'source_quality': rows.source_quality.values,
        'freshness': rows.freshness.values,
        'player_last_game_ts': [ids.ts(x) if pd.notna(x) else None for x in last_ts],
        'team_last_game_ts': [ids.ts(x) if pd.notna(x) else None for x in team_ts],
        'days_since_player_game': rows.days_since_player_game.values,
        'player_value_mean': None, 'player_value_sd': None, 'replacement_value': None, 'value_model': None,
        'value_status': 'NOT_MODELLED: value models are the next phase (qb.py, units.py)',
        'calibration_train_seasons': json.dumps(cal['train_seasons']),
    })
    out = out.sort_values(['team_id', 'position_family', 'depth_rank', 'espn_id'],
                          na_position='last', kind='mergesort').reset_index(drop=True)
    out.insert(0, 'player_week_state_id', ['cfbpws_' + ids.h(p, t, season, T, RULE) for p, t in
                                           zip(out.player_id, out.team_id)])
    recs = out.to_dict('records')
    out['content_hash'] = [ids.content_hash(r, exclude=('player_week_state_id',)) for r in recs]
    out.attrs['reliability'] = rel
    return out


def depth_chart_state(season, T, availability=None, state=None):
    """Per team x position family: the players ordered by expected usage share (the
    usage-derived depth chart; no provider depth chart exists). Families without usage
    data (OL, defence in unreliable seasons, LS) are listed unordered, confidence NONE."""
    S = player_week_state(season, T, availability) if state is None else state
    if not len(S):
        return pd.DataFrame()
    rows = []
    for (t, f), g in S.groupby(['team_id', 'position_family'], sort=True):
        ordered = g.depth_rank.notna().any()
        g = g.sort_values(['depth_rank', 'espn_id'], na_position='last', kind='mergesort')
        lead = g.iloc[0] if ordered else None
        conf = None
        if ordered and lead is not None and pd.notna(lead.starter_probability):
            conf = float(lead.starter_probability)
        label = 'NONE' if not ordered else ('UNKNOWN' if conf is None else
                                           'HIGH' if conf >= 0.8 else 'MEDIUM' if conf >= 0.6 else 'LOW')
        players = [{'player_id': r.player_id, 'name': r.name, 'depth_rank': None if pd.isna(r.depth_rank) else int(r.depth_rank),
                    'expected_usage_share': None if pd.isna(r.expected_usage_share) else round(float(r.expected_usage_share), 4),
                    'role': r.role, 'starter_probability': None if pd.isna(r.starter_probability) else
                    round(float(r.starter_probability), 4), 'expected_availability': r.expected_availability}
                   for r in g.itertuples(index=False)]
        rows.append({
            'depth_chart_state_id': 'cfbdc_' + ids.h(t, season, g.as_of.iloc[0], f, DEPTH_RULE),
            'rule_version': DEPTH_RULE, 'as_of': g.as_of.iloc[0], 'season': int(season), 'team_id': int(t),
            'position_family': f, 'unit': POS.unit_of(f), 'source': 'usage_derived',
            'ordering': ('production_share' if ordered and g.usage_basis.eq('production').any() else
                         'usage_share' if ordered else 'none'),
            'usage_metric': g.usage_metric.dropna().iloc[0] if g.usage_metric.notna().any() else None,
            'confidence': conf, 'confidence_label': label,
            'confidence_basis': 'leader_starter_probability' if conf is not None else
            ('no_usage_data' if not ordered else 'no_calibrated_probability'),
            'n_players': int(len(g)), 'players': json.dumps(ids.clean(players), sort_keys=True),
        })
    return pd.DataFrame(rows)


def availability_coverage(season=2026):
    """The audit's availability-report numbers (definitions in AUDIT.md)."""
    reps = load_reports(season)
    ok = [r for r in reps if _truthy(r.get('ok', True))]
    st = {}
    n_rows = 0
    pub_before = ret_before = 0
    games = set()
    for r in ok:
        games.add(str(r.get('game_id')))
        for p in r.get('rows') or []:
            n_rows += 1
            k = _status_key(p.get('status'))
            st[k] = st.get(k, 0) + 1
        k_ = U.to_ts(r.get('kickoff')) if r.get('kickoff') else None
        if k_ is not None:
            pb = r.get('published_at')
            if pb not in (None, '', 'None') and U.to_ts(pb) <= k_:
                pub_before += 1
            if r.get('retrieved_at') and U.to_ts(r['retrieved_at']) <= k_:
                ret_before += 1
    lag = []
    for r in ok:
        if r.get('kickoff') and r.get('retrieved_at'):
            lag.append((U.to_ts(r['retrieved_at']) - U.to_ts(r['kickoff'])).total_seconds() / 3600.0)
    return {'season': season, 'files': len(reps), 'ok_files': len(ok), 'games': len(games), 'rows': n_rows,
            'status_counts': st, 'published_before_kickoff': pub_before, 'retrieved_before_kickoff': ret_before,
            'retrieved_minus_kickoff_hours_median': float(np.median(lag)) if lag else None,
            'with_published_at': sum(1 for r in ok if r.get('published_at') not in (None, '', 'None'))}
