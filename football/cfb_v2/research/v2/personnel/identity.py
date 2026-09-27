"""Canonical player registry, aliases, provider ids, positions, transfer history.

    build_players(seasons) -> (players_df, aliases_df, transfers_df)
    resolve(name, team_id, season, position=None) -> player_id | None
    resolve_detail(...)  -> {'player_id', 'reason', 'candidates'}
    quality(players, aliases, seasons) -> the identity-quality numbers (METHODS_FOUNDATION.md)

ONE id system: the ESPN athlete id. It is the id in the play-by-play, in cfbfastR's
rosters and play stats, in ESPN's roster API and player box, and it survives a
transfer. player_id = 'espn:<athlete id>'. cfbfastR carries the same number; the
registry records it under provider_ids['cfbfastr'] when a cfbfastR source lists the
player (a cfbfastR id that differs from the ESPN id never occurs in the local data).

Sources, in order of authority
  1. play-by-play appearances (usage.player_games): who played, for whom, when
  2. ESPN rosters 2025 / 2026 (football/rosters): team, position, class (2026 only),
     height, weight; snapshots fetched once (not point-in-time)
  3. cfbfastR rosters 2004-2025: team, position, height, weight; its class column is
     the EVENTUAL class (or the season number itself before 2019) -> UNRELIABLE
  4. cfbfastR play stats 2014-2025: extra name spellings only

Contaminants removed (counted in quality()): all-star / offseason games and teams
(usage.ALL_STAR_TEAM_IDS), negative ids (the PBP 'TEAM' placeholder athletes and the
legacy negative roster ids 2009-2019, which no play ever carries), the placeholder
ids usage.PLACEHOLDER_IDS, and duplicate roster rows.

A transfer is a change of the player's team between consecutive seasons of his
history, the team of a season being his MODAL team over that season's games (a
roster listing only when he has no games). There are no portal dates anywhere, so
none are invented: `known_from` is the kickoff of his first game for the new team
(games evidence) or null (roster evidence, which is not point-in-time).
"""
import json
import os

import numpy as np
import pandas as pd

from .. import common
from ..weekly import ids
from . import positions as POS
from . import usage as U

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', '..'))
ESPN_ROSTER_SEASONS = (2025, 2026)
CFBFASTR_ROSTER_SEASONS = tuple(range(2004, 2026))
PSTATS_SEASONS = tuple(range(2014, 2026))
CURRENT_CLASS_SEASON = 2026            # the only point-in-time-ish class source (ESPN 2026)

_MEM = {}


# ------------------------------------------------------------- team names
def team_name_map(season=None):
    """School name key -> ESPN team id, from the schedules (the season's first, then any)."""
    if ('tmap', season) in _MEM:
        return _MEM[('tmap', season)]
    import glob
    out = {}
    files = sorted(glob.glob(common.data_path('sched', 'cfb_schedules_*.parquet')))
    for f in files:
        s = pd.read_parquet(f, columns=['home_id', 'home_team', 'away_id', 'away_team'])
        for a, b in ((s.home_team, s.home_id), (s.away_team, s.away_id)):
            for n, i in zip(a.values, b.values):
                if isinstance(n, str) and pd.notna(i):
                    out[n.strip().lower()] = int(i)       # later seasons overwrite earlier ones
    if season is not None:
        f = common.data_path('sched', 'cfb_schedules_%d.parquet' % season)
        if os.path.exists(f):
            s = pd.read_parquet(f, columns=['home_id', 'home_team', 'away_id', 'away_team'])
            for a, b in ((s.home_team, s.home_id), (s.away_team, s.away_id)):
                for n, i in zip(a.values, b.values):
                    if isinstance(n, str) and pd.notna(i):
                        out[n.strip().lower()] = int(i)
    _MEM[('tmap', season)] = out
    return out


# ---------------------------------------------------------------- rosters
def _height_in(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return np.nan
    s = str(v).strip()
    if not s:
        return np.nan
    if "'" in s:
        try:
            ft, rest = s.split("'", 1)
            inch = rest.replace('"', '').strip() or '0'
            return float(int(ft) * 12 + float(inch))
        except ValueError:
            return np.nan
    try:
        x = float(s)
        return x if 50 <= x <= 90 else np.nan
    except ValueError:
        return np.nan


def _weight_lb(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return np.nan
    s = str(v).lower().replace('lbs', '').replace('lb', '').strip()
    try:
        x = float(s)
        return x if 120 <= x <= 450 else np.nan
    except ValueError:
        return np.nan


def espn_roster(season):
    """ESPN roster snapshot for 2025/2026 (empty frame otherwise)."""
    key = ('espn_roster', season)
    if key in _MEM:
        return _MEM[key]
    f = os.path.join(REPO, 'football', 'rosters', 'fbs_%d_espn.json' % season)
    cols = ['espn_id', 'name', 'team_id', 'position', 'class_year', 'height', 'weight', 'jersey', 'season',
            'source', 'retrieved_at']
    if not os.path.exists(f):
        _MEM[key] = pd.DataFrame(columns=cols)
        return _MEM[key]
    d = json.load(open(f))
    rows = []
    for t in d.get('teams') or []:
        try:
            tid = int(t.get('espn_id'))
        except (TypeError, ValueError):
            continue
        if tid in U.ALL_STAR_TEAM_IDS:
            continue
        for p in t.get('players') or []:
            rows.append({'espn_id': p.get('espn_id'), 'name': p.get('name'), 'team_id': tid,
                         'position': p.get('position') or None, 'class_year': p.get('class') or None,
                         'height': _height_in(p.get('height')), 'weight': _weight_lb(p.get('weight')),
                         'jersey': p.get('jersey'), 'season': season, 'source': 'espn_roster_%d' % season,
                         'retrieved_at': d.get('retrieved_at')})
    r = pd.DataFrame(rows, columns=cols)
    r['espn_id'] = U._num(r.espn_id)
    n0 = len(r)
    r = r[U.valid_id(r.espn_id)].copy()
    r['espn_id'] = r.espn_id.astype('int64')
    r = r.sort_values(['espn_id', 'team_id'], kind='mergesort')
    dup = int(r.espn_id.duplicated().sum())
    r = r.drop_duplicates('espn_id').reset_index(drop=True)
    r.attrs['filtered'] = {'rows_in': n0, 'invalid_id': n0 - len(r) - dup, 'duplicate_id': dup}
    _MEM[key] = r
    return r


def cfbfastr_roster(season):
    """cfbfastR roster for 2004-2025. `class_year` is the provider's `year`: UNRELIABLE."""
    key = ('cfbfastr_roster', season)
    if key in _MEM:
        return _MEM[key]
    f = common.data_path('v1', 'roster', 'roster_%d.csv' % season)
    cols = ['espn_id', 'name', 'team_id', 'team_name', 'position', 'class_year', 'height', 'weight', 'jersey',
            'season', 'source']
    if not os.path.exists(f):
        _MEM[key] = pd.DataFrame(columns=cols)
        return _MEM[key]
    r = pd.read_csv(f, dtype=str, keep_default_na=False, na_values=['', 'NA'])
    tmap = team_name_map(season)
    out = pd.DataFrame({
        'espn_id': U._num(r.athlete_id),
        'name': (r.first_name.fillna('').str.strip() + ' ' + r.last_name.fillna('').str.strip()).str.strip(),
        'team_name': r.team,
        'team_id': [tmap.get(str(t).strip().lower()) if isinstance(t, str) else None for t in r.team],
        'position': r.position,
        'class_year': U._num(r.year),
        'height': [_height_in(v) for v in r.height],
        'weight': [_weight_lb(v) for v in r.weight],
        'jersey': r.jersey, 'season': season, 'source': 'cfbfastr_roster_%d' % season,
    })
    n0 = len(out)
    neg = int((out.espn_id < 0).sum())
    out = out[U.valid_id(out.espn_id)].copy()
    out['espn_id'] = out.espn_id.astype('int64')
    allstar = out.team_id.isin(list(U.ALL_STAR_TEAM_IDS))
    out = out[~allstar]
    unmapped = int(out.team_id.isna().sum())
    out = out.sort_values(['espn_id', 'team_name'], kind='mergesort')
    dup = int(out.espn_id.duplicated().sum())
    out = out.drop_duplicates('espn_id').reset_index(drop=True)
    out.attrs['filtered'] = {'rows_in': n0, 'negative_id': neg, 'allstar': int(allstar.sum()),
                             'duplicate_id': dup, 'team_unmapped': unmapped}
    _MEM[key] = out
    return out


def pstats_names(season):
    """(espn_id, name, team_id, game_id) from cfbfastR play stats: aliases only."""
    key = ('pstats', season)
    if key in _MEM:
        return _MEM[key]
    f = common.data_path('v1', 'pstats', 'pstats_%d.csv' % season)
    cols = ['espn_id', 'name', 'team_id', 'game_id']
    if not os.path.exists(f):
        _MEM[key] = pd.DataFrame(columns=cols)
        return _MEM[key]
    r = pd.read_csv(f, dtype=str, keep_default_na=False, na_values=['', 'NA'])
    tmap = team_name_map(season)
    parts = []
    for c in r.columns:
        if c.endswith('_player_id') and c[:-3] in r.columns:
            x = r[[c, c[:-3], 'team', 'game_id']].dropna(subset=[c])
            parts.append(x.set_axis(['espn_id', 'name', 'team', 'game_id'], axis=1))
    a = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=['espn_id', 'name', 'team', 'game_id'])
    # pstats rows are (play, team-of-row); defensive columns name the OTHER team's player
    # on the row of the offense, so a team is only attached through the roster/PBP join
    a['espn_id'] = U._num(a.espn_id)
    n0 = len(a)
    ph = int(a.espn_id.isin(list(U.PLACEHOLDER_IDS)).sum())
    neg = int((a.espn_id < 0).sum())
    a = a[U.valid_id(a.espn_id)]
    a = a.groupby(['espn_id', 'name']).size().rename('n').reset_index()
    a['espn_id'] = a.espn_id.astype('int64')
    a.attrs['filtered'] = {'rows_in': n0, 'placeholder_id': ph, 'negative_id': neg}
    _MEM[key] = a
    return a


# ------------------------------------------------------------ the registry
def _season_games(S):
    P = U.player_games(S)
    cols = ['espn_id', 'team_id', 'game_id', 'kickoff_ts', 'name', 'dropbacks', 'rush_att', 'targets']
    return P[cols].copy()


def _modal_team(g):
    """g: player-season rows (espn_id, team_id, game_id, kickoff_ts). -> per player-season
    modal team (most games; tie: the team of the later last game; then lower id)."""
    c = g.groupby(['season', 'espn_id', 'team_id']).agg(games=('game_id', 'nunique'),
                                                        last_ts=('kickoff_ts', 'max'),
                                                        first_ts=('kickoff_ts', 'min')).reset_index()
    c = c.sort_values(['season', 'espn_id', 'games', 'last_ts', 'team_id'],
                      ascending=[True, True, False, False, True], kind='mergesort')
    by = c.groupby(['season', 'espn_id'])
    ev = by.apply(lambda x: json.dumps({str(int(t)): int(n) for t, n in zip(x.team_id, x.games)},
                                       sort_keys=True), include_groups=False).rename('games_by_team')
    m = c.drop_duplicates(['season', 'espn_id']).set_index(['season', 'espn_id'])
    m = m.join(ev)
    return m.reset_index(), c


def build_players(seasons, use_pstats=True):
    """-> (players_df, aliases_df, transfers_df). Deterministic; see the module docstring
    and METHODS_FOUNDATION.md for every column."""
    seasons = sorted(int(s) for s in seasons)
    key = ('build', tuple(seasons), use_pstats)
    if key in _MEM:
        a, b, c = _MEM[key]
        return a.copy(), b.copy(), c.copy()
    S_max = seasons[-1]
    G = []
    for S in seasons:
        g = _season_games(S)
        g['season'] = S
        G.append(g)
    G = pd.concat(G, ignore_index=True)
    modal, team_counts = _modal_team(G)
    first_at_team = team_counts.set_index(['season', 'espn_id', 'team_id']).first_ts

    # rosters
    R = []
    for S in seasons:
        if S in ESPN_ROSTER_SEASONS:
            R.append(espn_roster(S).assign(pref=0))
        if S in CFBFASTR_ROSTER_SEASONS:
            R.append(cfbfastr_roster(S).assign(pref=1))
    R = pd.concat(R, ignore_index=True) if R else pd.DataFrame(
        columns=['espn_id', 'name', 'team_id', 'position', 'class_year', 'height', 'weight', 'season', 'source', 'pref'])
    R = R.sort_values(['season', 'espn_id', 'pref'], kind='mergesort')
    R1 = R.drop_duplicates(['season', 'espn_id'])          # ESPN listing preferred for a season

    # team by season: games first, roster listing when the player has no games that season
    tb = modal[['season', 'espn_id', 'team_id', 'games', 'games_by_team', 'first_ts']].assign(team_basis='games')
    have = set(zip(tb.season, tb.espn_id))
    rr = R1[R1.team_id.notna()]
    rr = rr[[(s, i) not in have for s, i in zip(rr.season, rr.espn_id)]]
    tb = pd.concat([tb, pd.DataFrame({'season': rr.season.values, 'espn_id': rr.espn_id.values,
                                      'team_id': rr.team_id.astype('int64').values, 'games': 0,
                                      'games_by_team': '{}', 'first_ts': pd.NaT,
                                      'team_basis': rr.source.values})], ignore_index=True)
    tb['team_id'] = tb.team_id.astype('int64')
    tb = tb.sort_values(['espn_id', 'season'], kind='mergesort').reset_index(drop=True)

    # ---------------------------------------------------------- aliases
    al = G.dropna(subset=['name']).groupby(['espn_id', 'name', 'season', 'team_id']).agg(
        n=('game_id', 'nunique'), first_seen=('kickoff_ts', 'min'), last_seen=('kickoff_ts', 'max')).reset_index()
    al['source'] = 'pbp'
    ra = R.dropna(subset=['name'])
    ra = ra[ra.name.str.len() > 0]
    ra = pd.DataFrame({'espn_id': ra.espn_id.values, 'name': ra.name.values, 'season': ra.season.values,
                       'team_id': ra.team_id.values, 'n': 1, 'first_seen': pd.NaT, 'last_seen': pd.NaT,
                       'source': ra.source.values})
    parts = [al, ra]
    if use_pstats:
        for S in seasons:
            if S in PSTATS_SEASONS:
                ps = pstats_names(S)
                tmx = tb[tb.season.eq(S)].set_index('espn_id').team_id
                parts.append(pd.DataFrame({'espn_id': ps.espn_id.values, 'name': ps.name.values, 'season': S,
                                           'team_id': tmx.reindex(ps.espn_id.values).values, 'n': ps.n.values,
                                           'first_seen': pd.NaT, 'last_seen': pd.NaT,
                                           'source': 'cfbfastr_pstats_%d' % S}))
    A = pd.concat(parts, ignore_index=True)
    A = A[A.espn_id.isin(set(tb.espn_id))].copy()
    A['team_id'] = U._num(A.team_id)
    A['alias_key'] = [U.name_key(v) for v in A.name]
    A['initial_key'] = [U.initial_key(v) for v in A.name]
    A['player_id'] = 'espn:' + A.espn_id.astype('int64').astype(str)
    A = A.sort_values(['espn_id', 'season', 'source', 'name', 'team_id'], kind='mergesort').reset_index(drop=True)
    aliases = A[['player_id', 'espn_id', 'name', 'alias_key', 'initial_key', 'season', 'team_id', 'source', 'n',
                 'first_seen', 'last_seen']].copy()

    # --------------------------------------------------------- transfers
    trows = []
    for eid, g in tb.groupby('espn_id', sort=True):
        g = g.sort_values('season')
        prev = None
        for r in g.itertuples(index=False):
            if prev is not None and r.team_id != prev.team_id:
                gap = int(r.season - prev.season)
                kf = first_at_team.get((r.season, eid, r.team_id)) if r.team_basis == 'games' else None
                trows.append({
                    'player_id': 'espn:%d' % eid, 'espn_id': int(eid),
                    'event_type': 'TRANSFER' if gap == 1 else 'TRANSFER_AFTER_GAP',
                    'from_team': int(prev.team_id), 'to_team': int(r.team_id),
                    'from_season': int(prev.season), 'to_season': int(r.season), 'season_gap': gap,
                    'evidence_from': prev.team_basis, 'evidence_to': r.team_basis,
                    'games_from': int(prev.games), 'games_to': int(r.games),
                    'games_by_team_from': prev.games_by_team, 'games_by_team_to': r.games_by_team,
                    'known_from': kf if (kf is not None and pd.notna(kf)) else pd.NaT,
                    'known_from_basis': 'first_game_for_new_team' if r.team_basis == 'games'
                    else 'roster_listing_not_point_in_time',
                    'portal_date': None,
                })
            prev = r
    transfers = pd.DataFrame(trows, columns=[
        'player_id', 'espn_id', 'event_type', 'from_team', 'to_team', 'from_season', 'to_season', 'season_gap',
        'evidence_from', 'evidence_to', 'games_from', 'games_to', 'games_by_team_from', 'games_by_team_to',
        'known_from', 'known_from_basis', 'portal_date'])
    if len(transfers):
        transfers['transfer_id'] = [ids.h('cfb_transfer', p, a, b, s1, s2) for p, a, b, s1, s2 in zip(
            transfers.player_id, transfers.from_team, transfers.to_team, transfers.from_season, transfers.to_season)]
    else:
        transfers['transfer_id'] = []

    # ----------------------------------------------------------- players
    usage_tot = G.groupby('espn_id')[['dropbacks', 'rush_att', 'targets']].sum()
    games_tot = G.groupby('espn_id').game_id.nunique()
    seen = G.groupby('espn_id').kickoff_ts.agg(['min', 'max'])
    # full name: the most frequent spelling in the latest season with a name (PBP games,
    # +1 per roster listing); ties -> ESPN roster spelling, then alphabetical
    nm = A.copy()
    nm['w'] = nm.n.where(nm.source.eq('pbp'), 1)
    nm['pref'] = np.where(nm.source.str.startswith('espn_roster'), 0, np.where(nm.source.eq('pbp'), 1, 2))
    lastS = nm.groupby('espn_id').season.transform('max')
    nm = nm[nm.season.eq(lastS) & ~nm.source.str.startswith('cfbfastr_pstats')]
    nm = nm.groupby(['espn_id', 'name']).agg(w=('w', 'sum'), pref=('pref', 'min')).reset_index()
    nm = nm.sort_values(['espn_id', 'w', 'pref', 'name'], ascending=[True, False, True, True], kind='mergesort')
    full_name = nm.drop_duplicates('espn_id').set_index('espn_id').name
    # position: latest roster listing that has one (ESPN preferred within a season)
    Rp = R[R.position.notna() & (R.position.astype(str).str.len() > 0)]
    Rp = Rp.sort_values(['espn_id', 'season', 'pref'], ascending=[True, False, True], kind='mergesort')
    pos_latest = Rp.drop_duplicates('espn_id').set_index('espn_id')
    Rh = R[R.height.notna()].sort_values(['espn_id', 'season', 'pref'], ascending=[True, False, True],
                                        kind='mergesort').drop_duplicates('espn_id').set_index('espn_id')
    Rw = R[R.weight.notna()].sort_values(['espn_id', 'season', 'pref'], ascending=[True, False, True],
                                        kind='mergesort').drop_duplicates('espn_id').set_index('espn_id')
    cls26 = R[R.source.eq('espn_roster_%d' % CURRENT_CLASS_SEASON)].set_index('espn_id').class_year
    Rc = R[R.source.str.startswith('cfbfastr_roster') & R.class_year.notna()]
    Rc = Rc.sort_values(['espn_id', 'season'], ascending=[True, False], kind='mergesort').drop_duplicates('espn_id')
    cls_cf = Rc.set_index('espn_id')
    cf_seen = set(R[R.source.str.startswith('cfbfastr')].espn_id)
    if use_pstats:
        for S in seasons:
            if S in PSTATS_SEASONS:
                cf_seen |= set(pstats_names(S).espn_id)
    tr_by = transfers.groupby('espn_id') if len(transfers) else None
    rows = []
    for eid, g in tb.groupby('espn_id', sort=True):
        g = g.sort_values('season')
        pid = 'espn:%d' % eid
        tbs = {str(int(s)): int(t) for s, t in zip(g.season, g.team_id)}
        basis = {str(int(s)): b for s, b in zip(g.season, g.team_basis)}
        last = g.iloc[-1]
        prior = []
        for t in g.team_id.values[:-1]:
            if int(t) != int(last.team_id) and int(t) not in prior:
                prior.append(int(t))
        u = usage_tot.loc[eid] if eid in usage_tot.index else None
        ctx = {'usage': {'dropbacks': float(u.dropbacks), 'rushes': float(u.rush_att),
                         'targets': float(u.targets)}} if u is not None else None
        if eid in pos_latest.index:
            op = pos_latest.loc[eid, 'position']
            ps = pos_latest.loc[eid, 'source']
        else:
            op, ps = None, None
        fam, fbasis = POS.normalize_detail(op, ctx)
        hist = []
        if tr_by is not None and eid in tr_by.groups:
            for r in tr_by.get_group(eid).itertuples(index=False):
                hist.append({'from_team': r.from_team, 'to_team': r.to_team, 'from_season': r.from_season,
                             'to_season': r.to_season, 'event_type': r.event_type})
        active = bool(int(last.season) == S_max)
        prov = {'espn': str(int(eid))}
        if eid in cf_seen:
            prov['cfbfastr'] = str(int(eid))
        rows.append({
            'player_id': pid, 'espn_id': int(eid),
            'provider_ids': json.dumps(prov, sort_keys=True),
            'full_name': full_name.get(eid),
            'team_id': int(last.team_id), 'team_season': int(last.season),
            'team_by_season': json.dumps(tbs, sort_keys=True),
            'team_basis_by_season': json.dumps(basis, sort_keys=True),
            'first_season': int(g.season.min()), 'last_season': int(g.season.max()),
            'first_game_ts': seen['min'].get(eid, pd.NaT), 'last_game_ts': seen['max'].get(eid, pd.NaT),
            'career_games': int(games_tot.get(eid, 0)),
            'career_dropbacks': float(u.dropbacks) if u is not None else 0.0,
            'career_rushes': float(u.rush_att) if u is not None else 0.0,
            'career_targets': float(u.targets) if u is not None else 0.0,
            'original_position': op, 'position_source': ps,
            'normalized_position': fam, 'position_basis': fbasis,
            'unit': POS.unit_of(fam), 'weekly_unit': POS.weekly_unit_of(fam),
            'class_year': cls26.get(eid) if eid in cls26.index else None,
            'class_year_source': ('espn_roster_%d' % CURRENT_CLASS_SEASON) if eid in cls26.index else None,
            'class_year_cfbfastr': float(cls_cf.loc[eid, 'class_year']) if eid in cls_cf.index else None,
            'class_year_cfbfastr_season': int(cls_cf.loc[eid, 'season']) if eid in cls_cf.index else None,
            'class_year_cfbfastr_flag': 'UNRELIABLE' if eid in cls_cf.index else None,
            'height_in': float(Rh.loc[eid, 'height']) if eid in Rh.index else None,
            'weight_lb': float(Rw.loc[eid, 'weight']) if eid in Rw.index else None,
            'prior_teams': json.dumps(prior),
            'transfer_history': json.dumps(hist, sort_keys=True),
            'n_transfers': len(hist),
            'active_status': 'ACTIVE' if active else 'INACTIVE',
            'active_basis': ('seen_in_%d' % S_max) if active else ('last_seen_%d' % int(last.season)),
        })
    players = pd.DataFrame(rows)
    players.attrs['seasons'] = seasons
    _MEM[key] = (players, aliases, transfers)
    return players.copy(), aliases.copy(), transfers.copy()


# ---------------------------------------------------------------- resolve
class Registry:
    """Alias index for resolve(). Keys never cross teams: (name key, team, season)."""

    def __init__(self, players, aliases):
        self.players = players
        self.ids = set(players.player_id)
        self.family = dict(zip(players.player_id, players.normalized_position))
        a = aliases[aliases.team_id.notna()]
        self.full, self.init = {}, {}
        for pid, k, ik, s, t in zip(a.player_id.values, a.alias_key.values, a.initial_key.values,
                                    a.season.values, a.team_id.values):
            if k:
                self.full.setdefault((k, int(t), int(s)), set()).add(pid)
            if ik:
                self.init.setdefault((ik, int(t), int(s)), set()).add(pid)

    def resolve_detail(self, name, team_id, season, position=None, espn_id=None):
        if espn_id is not None and str(espn_id).strip():
            e = str(espn_id).replace('espn:', '').strip()
            try:
                pid = 'espn:%d' % int(float(e))
            except ValueError:
                pid = None
            if pid and pid in self.ids:
                return {'player_id': pid, 'reason': 'EXACT_ID', 'candidates': [pid]}
            # an id that is not in the registry falls through to the name path
        if team_id is None or season is None:
            return {'player_id': None, 'reason': 'NO_TEAM_OR_SEASON: never resolved by name alone',
                    'candidates': []}
        try:
            t, s = int(team_id), int(season)
        except (TypeError, ValueError):
            return {'player_id': None, 'reason': 'BAD_TEAM_OR_SEASON', 'candidates': []}
        fam = POS.normalize(position) if position else None
        for label, idx, k in (('NAME_TEAM_SEASON', self.full, U.name_key(name)),
                              ('INITIAL_TEAM_SEASON', self.init, U.initial_key(name))):
            if not k:
                continue
            c = sorted(idx.get((k, t, s), ()))
            if fam and fam != 'UNKNOWN' and len(c) > 1:
                cf = [p for p in c if self.family.get(p) == fam]
                if len(cf) == 1:
                    return {'player_id': cf[0], 'reason': label + '+POSITION', 'candidates': c}
            if len(c) == 1:
                return {'player_id': c[0], 'reason': label, 'candidates': c}
            if len(c) > 1:
                return {'player_id': None, 'reason': 'AMBIGUOUS_%s: %d players' % (label, len(c)),
                        'candidates': c}
        return {'player_id': None, 'reason': 'NOT_FOUND', 'candidates': []}

    def resolve(self, name, team_id, season, position=None, espn_id=None):
        return self.resolve_detail(name, team_id, season, position, espn_id)['player_id']


def registry(seasons):
    key = ('registry', tuple(sorted(int(s) for s in seasons)))
    if key not in _MEM:
        p, a, _ = build_players(seasons)
        _MEM[key] = Registry(p, a)
    return _MEM[key]


def resolve_detail(name, team_id, season, position=None, espn_id=None, reg=None):
    reg = reg or registry([int(season) - 1, int(season)] if int(season) > 2009 else [int(season)])
    return reg.resolve_detail(name, team_id, season, position, espn_id)


def resolve(name, team_id, season, position=None, espn_id=None, reg=None):
    """Exact id first (espn_id), then the name within (team, season), unique only.
    Ambiguous -> None (resolve_detail gives the reason). Never by name alone across teams."""
    return resolve_detail(name, team_id, season, position, espn_id, reg)['player_id']


# ---------------------------------------------------------------- quality
def quality(players, aliases, seasons=None):
    """The identity-quality numbers reported in METHODS_FOUNDATION.md."""
    a = aliases
    pbp = a[a.source.eq('pbp')]
    k_by_id = pbp.groupby('player_id').alias_key.nunique()
    raw_by_id = pbp.groupby('player_id').name.nunique()
    id_by_key = pbp.groupby('alias_key').player_id.nunique()
    same_ts = pbp.groupby(['alias_key', 'team_id', 'season']).player_id.nunique()
    allsrc_ts = a[a.team_id.notna()].groupby(['alias_key', 'team_id', 'season']).player_id.nunique()
    out = {
        'players': int(len(players)),
        'players_with_games': int((players.career_games > 0).sum()),
        'roster_only_players': int((players.career_games == 0).sum()),
        'ids_with_more_than_one_raw_spelling_pbp': int((raw_by_id > 1).sum()),
        'ids_with_more_than_one_name_key_pbp': int((k_by_id > 1).sum()),
        'ids_with_pbp_names': int(len(k_by_id)),
        'name_keys_with_more_than_one_id_pbp': int((id_by_key > 1).sum()),
        'name_keys_pbp': int(len(id_by_key)),
        'same_name_same_team_season_collisions_pbp': int((same_ts > 1).sum()),
        'same_name_same_team_season_collisions_all_sources': int((allsrc_ts > 1).sum()),
        'transfers': None,
        'position_basis': players.position_basis.value_counts().to_dict(),
        'normalized_position': players.normalized_position.value_counts().to_dict(),
    }
    return out


def passer_name_quality(aliases, seasons):
    """The audit's 'same passer id, different names' check (2022-26: 15 of 2,141)."""
    out = {}
    pids = set()
    for S in seasons:
        P = U.player_games(S)
        pids |= set(P[P.dropbacks > 0].player_id)
    a = aliases[aliases.source.eq('pbp') & aliases.season.isin(seasons) & aliases.player_id.isin(pids)]
    k = a.groupby('player_id').name.nunique()
    kk = a.groupby('player_id').alias_key.nunique()
    out['passer_ids'] = int(len(k))
    out['passer_ids_more_than_one_spelling'] = int((k > 1).sum())
    out['passer_ids_more_than_one_name_key'] = int((kk > 1).sum())
    return out
