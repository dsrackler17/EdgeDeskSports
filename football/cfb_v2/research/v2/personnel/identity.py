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
# The ESPN 2025 file is the season's 'core athletes' list fetched in August 2026: 14.8%
# of its players who played in 2025 are listed for a different team than the one they
# played for, and it lists 2,476 of the 3,673 players of 2024 who never played in 2025
# (AUDIT.md). cfbfastR's 2025 roster agrees with the games 99.4%. So ESPN's listing
# outranks cfbfastR's only where the audit found it the better source: 2026.
ESPN_PREFERRED_SEASONS = (2026,)
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


def _json_counts(frame, keys, k, v):
    """Per group of `keys`: '{"<k>": v, ...}' with keys sorted as strings (json sort_keys)."""
    f = frame[keys + [k, v]].copy()
    f['_k'] = f[k].astype('int64').astype(str)
    f = f.sort_values(keys + ['_k'], kind='mergesort')
    f['_s'] = '"' + f._k + '": ' + f[v].astype('int64').astype(str)
    return ('{' + f.groupby(keys, sort=True)._s.agg(', '.join) + '}').rename('games_by_team')


def _modal_team(g):
    """g: player-season rows (season, espn_id, team_id, game_id, kickoff_ts). -> per
    player-season modal team (most games; tie: the team of the later last game; then
    the lower id), with the games per team as evidence."""
    c = g.groupby(['season', 'espn_id', 'team_id']).agg(games=('game_id', 'nunique'),
                                                        last_ts=('kickoff_ts', 'max'),
                                                        first_ts=('kickoff_ts', 'min')).reset_index()
    c = c.sort_values(['season', 'espn_id', 'games', 'last_ts', 'team_id'],
                      ascending=[True, True, False, False, True], kind='mergesort')
    ev = _json_counts(c, ['season', 'espn_id'], 'team_id', 'games')
    m = c.drop_duplicates(['season', 'espn_id']).set_index(['season', 'espn_id']).join(ev)
    return m.reset_index(), c


def _latest(R, col, key='espn_id'):
    x = R[R[col].notna()]
    if col == 'position':
        x = x[x[col].astype(str).str.strip().str.len() > 0]
    x = x.sort_values([key, 'season', 'pref'], ascending=[True, False, True], kind='mergesort')
    return x.drop_duplicates(key).set_index(key)


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
    first_at_team = team_counts[['season', 'espn_id', 'team_id', 'first_ts']]

    # rosters (within a season: ESPN 2026, else cfbfastR, else ESPN 2025)
    R = []
    for S in seasons:
        if S in ESPN_ROSTER_SEASONS:
            R.append(espn_roster(S).assign(pref=0 if S in ESPN_PREFERRED_SEASONS else 2))
        if S in CFBFASTR_ROSTER_SEASONS:
            R.append(cfbfastr_roster(S).assign(pref=1))
    rcols = ['espn_id', 'name', 'team_id', 'position', 'class_year', 'height', 'weight', 'season', 'source', 'pref']
    R = pd.concat([r[[c for c in rcols if c in r.columns]] for r in R], ignore_index=True) if R else \
        pd.DataFrame(columns=rcols)
    R = R.sort_values(['season', 'espn_id', 'pref'], kind='mergesort').reset_index(drop=True)
    R1 = R.drop_duplicates(['season', 'espn_id'])

    # team by season: games first, the roster listing when the player has no game that season
    tb = modal[['season', 'espn_id', 'team_id', 'games', 'games_by_team']].assign(team_basis='games')
    rr = R1[R1.team_id.notna()][['season', 'espn_id', 'team_id', 'source']]
    rr = rr.merge(tb[['season', 'espn_id']], on=['season', 'espn_id'], how='left', indicator=True)
    rr = rr[rr._merge.eq('left_only')]
    tb = pd.concat([tb, pd.DataFrame({'season': rr.season.values, 'espn_id': rr.espn_id.values,
                                      'team_id': rr.team_id.astype('int64').values, 'games': 0,
                                      'games_by_team': '{}', 'team_basis': rr.source.values})],
                   ignore_index=True)
    tb['team_id'] = tb.team_id.astype('int64')
    tb['espn_id'] = tb.espn_id.astype('int64')
    tb = tb.sort_values(['espn_id', 'season'], kind='mergesort').reset_index(drop=True)

    # ---------------------------------------------------------- aliases
    al = G.dropna(subset=['name']).groupby(['espn_id', 'name', 'season', 'team_id']).agg(
        n=('game_id', 'nunique'), first_seen=('kickoff_ts', 'min'), last_seen=('kickoff_ts', 'max')).reset_index()
    al['source'] = 'pbp'
    ra = R[R.name.notna() & (R.name.astype(str).str.len() > 0)]
    ra = pd.DataFrame({'espn_id': ra.espn_id.values, 'name': ra.name.values, 'season': ra.season.values,
                       'team_id': ra.team_id.values, 'n': 1, 'first_seen': pd.NaT, 'last_seen': pd.NaT,
                       'source': ra.source.values})
    parts = [al, ra]
    cf_seen = set(R[R.source.str.startswith('cfbfastr')].espn_id)
    if use_pstats:
        for S in seasons:
            if S in PSTATS_SEASONS:
                ps = pstats_names(S)
                cf_seen |= set(ps.espn_id)
                tmx = tb[tb.season.eq(S)].set_index('espn_id').team_id
                parts.append(pd.DataFrame({'espn_id': ps.espn_id.values, 'name': ps.name.values, 'season': S,
                                           'team_id': tmx.reindex(ps.espn_id.values).values, 'n': ps.n.values,
                                           'first_seen': pd.NaT, 'last_seen': pd.NaT,
                                           'source': 'cfbfastr_pstats_%d' % S}))
    A = pd.concat(parts, ignore_index=True)
    A = A[A.espn_id.isin(set(tb.espn_id))].copy()
    A['espn_id'] = A.espn_id.astype('int64')
    A['team_id'] = U._num(A.team_id)
    A['alias_key'] = [U.name_key(v) for v in A.name]
    A['initial_key'] = [U.initial_key(v) for v in A.name]
    A['player_id'] = 'espn:' + A.espn_id.astype(str)
    A = A.sort_values(['espn_id', 'season', 'source', 'name', 'team_id'], kind='mergesort').reset_index(drop=True)
    # an alias's team is consistent when it agrees with the player's team of that season
    # (games first); a roster or play-stats row that places him elsewhere stays as
    # evidence but is not used to resolve names (the ESPN 2025 list keeps departed players)
    tt = tb.set_index(['season', 'espn_id']).team_id
    tteam = tt.reindex(pd.MultiIndex.from_arrays([A.season.values, A.espn_id.values])).values
    A['team_consistent'] = A.source.eq('pbp').values | (A.team_id.values == tteam)
    aliases = A[['player_id', 'espn_id', 'name', 'alias_key', 'initial_key', 'season', 'team_id', 'source', 'n',
                 'first_seen', 'last_seen', 'team_consistent']].copy()

    # --------------------------------------------------------- transfers
    t = tb.copy()
    t['prev_team'] = t.groupby('espn_id').team_id.shift(1)
    t['prev_season'] = t.groupby('espn_id').season.shift(1)
    t['prev_basis'] = t.groupby('espn_id').team_basis.shift(1)
    t['prev_games'] = t.groupby('espn_id').games.shift(1)
    t['prev_gbt'] = t.groupby('espn_id').games_by_team.shift(1)
    x = t[t.prev_team.notna() & t.team_id.ne(t.prev_team)].copy()
    x = x.merge(first_at_team, on=['season', 'espn_id', 'team_id'], how='left')
    gap = (x.season - x.prev_season).astype('int64')
    games_ev = x.team_basis.eq('games')
    transfers = pd.DataFrame({
        'player_id': 'espn:' + x.espn_id.astype(str), 'espn_id': x.espn_id.astype('int64').values,
        'event_type': np.where(gap.eq(1), 'TRANSFER', 'TRANSFER_AFTER_GAP'),
        'from_team': x.prev_team.astype('int64').values, 'to_team': x.team_id.astype('int64').values,
        'from_season': x.prev_season.astype('int64').values, 'to_season': x.season.astype('int64').values,
        'season_gap': gap.values, 'evidence_from': x.prev_basis.values, 'evidence_to': x.team_basis.values,
        'games_from': x.prev_games.astype('int64').values, 'games_to': x.games.astype('int64').values,
        'games_by_team_from': x.prev_gbt.values, 'games_by_team_to': x.games_by_team.values,
        'known_from': pd.to_datetime(x.first_ts.where(games_ev), utc=True).values,
        'known_from_basis': np.where(games_ev, 'first_game_for_new_team', 'roster_listing_not_point_in_time'),
        'portal_date': None,
    })
    transfers['known_from'] = pd.to_datetime(transfers.known_from, utc=True)
    transfers['transfer_id'] = [ids.h('cfb_transfer', p, a_, b_, s1, s2) for p, a_, b_, s1, s2 in zip(
        transfers.player_id, transfers.from_team, transfers.to_team, transfers.from_season, transfers.to_season)]
    transfers = transfers.sort_values(['espn_id', 'to_season'], kind='mergesort').reset_index(drop=True)

    # ----------------------------------------------------------- players
    last = tb.drop_duplicates('espn_id', keep='last').set_index('espn_id')
    P = pd.DataFrame(index=pd.Index(sorted(tb.espn_id.unique()), name='espn_id'))
    P['player_id'] = 'espn:' + P.index.astype(str)
    P['team_id'] = last.team_id
    P['team_season'] = last.season
    P['first_season'] = tb.groupby('espn_id').season.min()
    P['last_season'] = tb.groupby('espn_id').season.max()
    P['team_by_season'] = _json_counts(tb, ['espn_id'], 'season', 'team_id')
    tbb = tb.assign(_k=tb.season.astype(str)).sort_values(['espn_id', '_k'], kind='mergesort')
    tbb['_s'] = '"' + tbb._k + '": "' + tbb.team_basis + '"'
    P['team_basis_by_season'] = '{' + tbb.groupby('espn_id')._s.agg(', '.join) + '}'
    # prior teams: distinct earlier teams other than the current one, in order of first season
    pt = tb.merge(last[['team_id']].rename(columns={'team_id': 'cur'}), left_on='espn_id', right_index=True)
    pt = pt[pt.team_id.ne(pt.cur)].drop_duplicates(['espn_id', 'team_id'])
    P['prior_teams'] = pt.groupby('espn_id').team_id.agg(lambda v: json.dumps([int(z) for z in v]))
    P['prior_teams'] = P.prior_teams.fillna('[]')
    th = transfers.assign(_s='{"event_type": "' + transfers.event_type + '", "from_season": ' +
                          transfers.from_season.astype(str) + ', "from_team": ' + transfers.from_team.astype(str) +
                          ', "to_season": ' + transfers.to_season.astype(str) + ', "to_team": ' +
                          transfers.to_team.astype(str) + '}')
    P['transfer_history'] = ('[' + th.groupby('espn_id')._s.agg(', '.join) + ']')
    P['transfer_history'] = P.transfer_history.fillna('[]')
    P['n_transfers'] = transfers.groupby('espn_id').size().reindex(P.index).fillna(0).astype('int64')
    ut = G.groupby('espn_id')[['dropbacks', 'rush_att', 'targets']].sum()
    P['career_games'] = G.groupby('espn_id').game_id.nunique().reindex(P.index).fillna(0).astype('int64')
    P['career_dropbacks'] = ut.dropbacks.reindex(P.index).fillna(0.0)
    P['career_rushes'] = ut.rush_att.reindex(P.index).fillna(0.0)
    P['career_targets'] = ut.targets.reindex(P.index).fillna(0.0)
    seen = G.groupby('espn_id').kickoff_ts.agg(['min', 'max'])
    P['first_game_ts'] = seen['min'].reindex(P.index)
    P['last_game_ts'] = seen['max'].reindex(P.index)
    # full name: the most frequent spelling in the latest season with a name (PBP games,
    # +1 per roster listing); ties -> ESPN roster spelling, then PBP, then alphabetical
    nm = A[~A.source.str.startswith('cfbfastr_pstats')].copy()
    nm['w'] = nm.n.where(nm.source.eq('pbp'), 1)
    nm['pref'] = np.where(nm.source.str.startswith('espn_roster'), 0, np.where(nm.source.eq('pbp'), 1, 2))
    nm = nm[nm.season.eq(nm.groupby('espn_id').season.transform('max'))]
    nm = nm.groupby(['espn_id', 'name']).agg(w=('w', 'sum'), pref=('pref', 'min')).reset_index()
    nm = nm.sort_values(['espn_id', 'w', 'pref', 'name'], ascending=[True, False, True, True], kind='mergesort')
    P['full_name'] = nm.drop_duplicates('espn_id').set_index('espn_id').name.reindex(P.index)
    # provider ids
    P['provider_ids'] = np.where(P.index.isin(list(cf_seen)),
                                 '{"cfbfastr": "' + P.index.astype(str) + '", "espn": "' + P.index.astype(str) + '"}',
                                 '{"espn": "' + P.index.astype(str) + '"}')
    # position: latest roster listing with one; ATH / none -> observed usage
    pl = _latest(R, 'position')
    P['original_position'] = pl.position.reindex(P.index)
    P['position_source'] = pl.source.reindex(P.index)
    det = [POS.normalize_detail(op, {'usage': {'dropbacks': d_, 'rushes': r_, 'targets': t_}})
           for op, d_, r_, t_ in zip(P.original_position.values, P.career_dropbacks.values,
                                     P.career_rushes.values, P.career_targets.values)]
    P['normalized_position'] = [d_[0] for d_ in det]
    P['position_basis'] = [d_[1] for d_ in det]
    P['unit'] = [POS.unit_of(f) for f in P.normalized_position]
    P['weekly_unit'] = [POS.weekly_unit_of(f) for f in P.normalized_position]
    # class: ESPN 2026 for the current season only; cfbfastR's kept apart and flagged
    c26 = R[R.source.eq('espn_roster_%d' % CURRENT_CLASS_SEASON)].drop_duplicates('espn_id').set_index('espn_id')
    P['class_year'] = c26.class_year.reindex(P.index)
    P['class_year_source'] = np.where(P.class_year.notna(), 'espn_roster_%d' % CURRENT_CLASS_SEASON, None)
    cc = R[R.source.str.startswith('cfbfastr_roster') & R.class_year.notna()]
    cc = cc.sort_values(['espn_id', 'season'], ascending=[True, False], kind='mergesort').drop_duplicates('espn_id')
    cc = cc.set_index('espn_id')
    P['class_year_cfbfastr'] = U._num(cc.class_year.reindex(P.index))
    P['class_year_cfbfastr_season'] = cc.season.reindex(P.index)
    P['class_year_cfbfastr_flag'] = np.where(P.class_year_cfbfastr.notna(), 'UNRELIABLE', None)
    P['height_in'] = U._num(_latest(R, 'height').height.reindex(P.index))
    P['weight_lb'] = U._num(_latest(R, 'weight').weight.reindex(P.index))
    active = P.last_season.eq(S_max)
    P['active_status'] = np.where(active, 'ACTIVE', 'INACTIVE')
    P['active_basis'] = np.where(active, 'seen_in_%d' % S_max, 'last_seen_' + P.last_season.astype(str))
    P = P.reset_index()
    cols = ['player_id', 'espn_id', 'provider_ids', 'full_name', 'team_id', 'team_season', 'team_by_season',
            'team_basis_by_season', 'first_season', 'last_season', 'first_game_ts', 'last_game_ts', 'career_games',
            'career_dropbacks', 'career_rushes', 'career_targets', 'original_position', 'position_source',
            'normalized_position', 'position_basis', 'unit', 'weekly_unit', 'class_year', 'class_year_source',
            'class_year_cfbfastr', 'class_year_cfbfastr_season', 'class_year_cfbfastr_flag', 'height_in',
            'weight_lb', 'prior_teams', 'transfer_history', 'n_transfers', 'active_status', 'active_basis']
    players = P[cols].copy()
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
        if 'team_consistent' in a.columns:
            a = a[a.team_consistent.astype(bool)]
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


# ------------------------------------------------------ position lookup
POSITION_LOOKBACK = 4                  # roster seasons searched backwards from S


def position_lookup(season, usage_rows=None):
    """espn_id -> position for season S, never from a later season: the S listing (source
    order as build_players), else the latest listing in S-1 .. S-POSITION_LOOKBACK, else the family
    implied by the observed usage in `usage_rows` (player_games rows, already restricted
    to what is known) when that usage is dominant (positions.usage_family).
    Columns: espn_id, original_position, family, position_basis, position_source,
    roster_team_id (the S listing's team, if any)."""
    rows = []
    for k, S in enumerate(range(int(season), int(season) - POSITION_LOOKBACK - 1, -1)):
        if S in ESPN_ROSTER_SEASONS:
            r = espn_roster(S)
            rows.append(r[['espn_id', 'position', 'team_id', 'source']].assign(
                order=3 * k + (0 if S in ESPN_PREFERRED_SEASONS else 2)))
        if S in CFBFASTR_ROSTER_SEASONS:
            r = cfbfastr_roster(S)
            rows.append(r[['espn_id', 'position', 'team_id', 'source']].assign(order=3 * k + 1))
    if rows:
        R = pd.concat(rows, ignore_index=True)
    else:
        R = pd.DataFrame(columns=['espn_id', 'position', 'team_id', 'source', 'order'])
    this = R[R.order <= 2].sort_values(['espn_id', 'order'], kind='mergesort').drop_duplicates('espn_id')
    roster_team = this.set_index('espn_id').team_id
    R = R[R.position.notna() & (R.position.astype(str).str.strip().str.len() > 0)]
    R = R.sort_values(['espn_id', 'order'], kind='mergesort').drop_duplicates('espn_id').set_index('espn_id')
    idx = set(R.index) | set(roster_team.index)
    usage = None
    if usage_rows is not None and len(usage_rows):
        usage = usage_rows.groupby('espn_id')[['dropbacks', 'rush_att', 'targets']].sum()
        idx |= set(usage.index)
    idx = sorted(int(i) for i in idx)
    out = pd.DataFrame({'espn_id': idx})
    out['original_position'] = R.position.reindex(idx).values
    out['position_source'] = R.source.reindex(idx).values
    out['roster_team_id'] = U._num(roster_team.reindex(idx)).values
    fam, basis = [], []
    for e, op in zip(out.espn_id.values, out.original_position.values):
        ctx = None
        if usage is not None and e in usage.index:
            u = usage.loc[e]
            ctx = {'usage': {'dropbacks': u.dropbacks, 'rushes': u.rush_att, 'targets': u.targets}}
        f_, b_ = POS.normalize_detail(op, ctx)
        fam.append(f_)
        basis.append(b_)
    out['family'] = fam
    out['position_basis'] = basis
    out.loc[out.position_basis.eq('usage_inferred'), 'position_source'] = 'observed_usage'
    return out


# ------------------------------------------------------------------ audit
def roster_coverage(season):
    """The audit's roster numbers for one season (definitions in AUDIT.md)."""
    out = {'season': int(season)}
    f = common.data_path('v1', 'roster', 'roster_%d.csv' % season)
    if os.path.exists(f):
        raw = pd.read_csv(f, dtype=str, keep_default_na=False, na_values=['', 'NA'])
        idn = U._num(raw.athlete_id)
        yr = U._num(raw.year)
        out.update({
            'cfbfastr_rows': int(len(raw)), 'cfbfastr_teams': int(raw.team.nunique()),
            'cfbfastr_negative_id_share': float((idn < 0).mean()),
            'cfbfastr_duplicate_id_rows': int(raw.athlete_id.duplicated(keep=False).sum()),
            'cfbfastr_position_filled': float(raw.position.notna().mean()),
            'cfbfastr_height_filled': float(U._num(raw.height).notna().mean()),
            'cfbfastr_weight_filled': float(U._num(raw.weight).notna().mean()),
            'cfbfastr_class_is_season_number': float(yr.eq(season).mean()),
            'cfbfastr_class_1to5': float(yr.between(1, 5).mean()),
            'cfbfastr_recruit_ids_filled': float(raw.recruit_ids.notna().mean()) if 'recruit_ids' in raw else None,
        })
        r = cfbfastr_roster(season)
        out['cfbfastr_team_unmapped'] = r.attrs['filtered']['team_unmapped']
    if season in ESPN_ROSTER_SEASONS:
        e = espn_roster(season)
        out.update({'espn_rows': int(len(e)), 'espn_teams': int(e.team_id.nunique()),
                    'espn_class_filled': float(e.class_year.notna().mean()),
                    'espn_position_filled': float(e.position.notna().mean())})
    if season >= C_FIRST_PBP:
        P = U.player_games(season)
        ids_ = P.drop_duplicates('espn_id')
        lst = []
        if season in CFBFASTR_ROSTER_SEASONS:
            lst.append(cfbfastr_roster(season)[['espn_id', 'team_id']])
        if season in ESPN_ROSTER_SEASONS:
            lst.append(espn_roster(season)[['espn_id', 'team_id']])
        if lst:
            R = pd.concat(lst).drop_duplicates()
            on = ids_.espn_id.isin(set(R.espn_id))
            m, _ = _modal_team(P.assign(season=season))
            both = m.merge(R, on=['espn_id', 'team_id'], how='inner').espn_id.nunique()
            out['pbp_players'] = int(len(ids_))
            out['pbp_players_on_roster'] = float(on.mean())
            out['pbp_players_on_roster_same_team'] = float(both / max(1, len(ids_)))
    return out


C_FIRST_PBP = 2009


def box_coverage():
    """ESPN player box season aggregates: usable columns per season (football/data/box)."""
    out = {}
    for y in range(2020, 2030):
        f = os.path.join(REPO, 'football', 'data', 'box', '%d.json' % y)
        if not os.path.exists(f):
            continue
        d = json.load(open(f))
        out[y] = {'rows': d.get('rows'), 'players': d.get('player_count'),
                  'usable': sorted(k for k, v in (d.get('coverage') or {}).items() if v.get('usable')),
                  'unusable': sorted(k for k, v in (d.get('coverage') or {}).items() if not v.get('usable')),
                  'generated_at': d.get('generated_at')}
    return out


if __name__ == '__main__':
    import sys
    if '--audit' in sys.argv:
        for S in range(2004, 2027):
            print(json.dumps(ids.clean(roster_coverage(S)), sort_keys=True))
        print(json.dumps(ids.clean(box_coverage()), sort_keys=True))
    else:
        seasons = [int(a) for a in sys.argv[1:]] or list(range(2009, 2027))
        p, a, t = build_players(seasons)
        print(json.dumps(ids.clean(quality(p, a, seasons)), sort_keys=True))
        print('transfers', len(t))
