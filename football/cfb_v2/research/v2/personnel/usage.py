"""Player x game usage from ESPN play-by-play, point-in-time.

    player_games(season, T=None)   one row per (game, team, player): every game that
                                   kicked off strictly before T when T is given
    team_games(season, T=None)     one row per (game, team): the team context (the
                                   denominators of every share) and id coverage
    reliability(season, T=None)    per-season column reliability computed from the
                                   games before T only (the audit's id collapses)
    coverage(season)               the audit's PBP coverage numbers (docs AUDIT.md)

Conventions shared with V2 stage 1 (v2/plays.py): the same scrimmage-play definition
((rush | pass) & not a no-play penalty & EPA present, text duplicates dropped), the
same garbage rule (common.garbage_mask: quarter and score only), the same QB starter
rule (the passer on the team's first dropback of the game).

Filtered as contaminants (counted in the frame's attrs['filtered']):
  * all-star / offseason games: seasonType 4, or any side in ALL_STAR_TEAM_IDS
  * the provider's 'TEAM' placeholder athletes (negative ids) and the placeholder ids
    PLACEHOLDER_IDS (and anything <= MIN_VALID_ID)

Shares use the ATTRIBUTED team total as denominator (team dropbacks with a passer id,
rushes with a rusher id, targets with a receiver id), so the shares of a team-game sum
to 1; the unattributed remainder is recorded as the team-game's id coverage.
Nothing here reads snap counts, depth charts or OL participation: no feed carries them.
Starts exist for quarterbacks only; for every other position the flags are usage
leaders (usage_leader_rush, usage_top3_target) and are named as usage-based.
"""
import json
import os

import numpy as np
import pandas as pd

from .. import common
from ..weekly import ids

CODE_VERSION = 'personnel_usage_v6'
ALL_STAR_TEAM_IDS = frozenset({3144, 3145, 3146, 3147, 3193, 3194, 3197, 3198, 125290, 125291})
OFFSEASON_SEASON_TYPE = 4
PLACEHOLDER_IDS = frozenset({1, 3, 13})
MIN_VALID_ID = 100                      # every real ESPN athlete id in the local data is > 1000
RED_ZONE_YTG = 20

# id-coverage / event-rate floors for the defensive columns (AUDIT.md "reliability").
# A column is RELIABLE for a season (at T) when BOTH hold over the games before T:
#   id coverage  = flagged events carrying a player id / flagged events   >= ID_COVERAGE_FLOOR
#   event rate   = id-carrying events per team-game                         >= RATE_FLOOR[col]
# Each rate floor is HALF the 2009-2020 median per-team-game rate of an id-carrying
# event (medians: sacks 1.922, interceptions 0.897, break-ups 1.687, forced fumbles
# 0.537, recoveries 0.965; AUDIT.md), so a season whose provider stopped tagging a
# column (2013 sacks: 0.009 a team-game) fails even when the few tags carry ids.
ID_COVERAGE_FLOOR = 0.80
RATE_FLOOR = {'def_sacks': 0.961, 'def_ints': 0.448, 'def_pbu': 0.843, 'def_ff': 0.269, 'def_fr': 0.482}
MIN_TEAM_GAMES_FOR_RELIABILITY = 20     # fewer team-games before T -> 'INSUFFICIENT'

# roles whose team the provider can get wrong: a fumble can be recovered by either side
# and fumble_recovery_team is sometimes the opponent of the recovering player (a QB's
# own recovery filed to the defence). Their team is overridden by the player's
# side-certain roles in the same game (_one_team_per_game).
SIDE_UNCERTAIN_ROLES = ('fumble', 'fumble_recovered')

ROLES_ID = ('passer', 'rusher', 'receiver', 'sack', 'interception', 'pass_breakup', 'fumble',
            'fumble_forced', 'fumble_recovered', 'fg_kicker', 'punter', 'kickoff',
            'kickoff_return', 'punt_return')

PBP_COLS = [
    'game_id', 'season', 'week', 'seasonType', 'pos_team_id', 'def_pos_team_id', 'homeTeamId',
    'awayTeamId', 'period', 'start.pos_score_diff', 'game_play_number', 'text_dupe',
    'rush', 'pass', 'sack', 'int', 'completion', 'pass_attempt', 'penalty_no_play', 'EPA',
    'EPA_success', 'EPA_explosive', 'start.yardsToEndzone', 'first_down_created', 'statYardage',
    'yds_receiving', 'yds_rushed', 'pass_breakup', 'forced_fumble', 'fumble_vec', 'fumble_lost',
    'fumble_recovery_team', 'fumbling_team',
    'fg_attempt', 'fg_made', 'yds_fg', 'fg_team', 'punt', 'yds_punted', 'yds_punt_return',
    'punt_team', 'punt_return_team', 'kickoff_play', 'yds_kickoff', 'yds_kickoff_return',
    'kicking_team', 'kick_return_team', 'xp_attempt', 'xp_made', 'xp_kicker_player_name', 'type.text', 'text',
    'sack_player_id2', 'sack_player_name2',
] + ['%s_player_id' % r for r in ROLES_ID] + ['%s_player_name' % r for r in ROLES_ID]

# per player-game stat columns (all sums; *_ng = non-garbage version)
OFF_STATS = ['dropbacks', 'dropbacks_ng', 'pass_att', 'pass_att_ng', 'completions', 'pass_yds',
             'pass_epa', 'pass_epa_ng', 'pass_succ', 'pass_succ_ng', 'sacks_taken', 'ints_thrown',
             'pass_first_downs',
             'rush_att', 'rush_att_ng', 'rush_yds', 'rush_epa', 'rush_epa_ng', 'rush_succ',
             'rush_succ_ng', 'expl_rush', 'rush_first_downs',
             'targets', 'targets_ng', 'receptions', 'receptions_ng', 'rec_yds', 'rec_epa',
             'rec_epa_ng', 'rec_succ', 'expl_rec', 'rec_first_downs', 'rz_touches', 'rz_targets',
             'fumbles']
DEF_STATS = ['def_sacks', 'def_sack_plays', 'def_ints', 'def_pbu', 'def_ff', 'def_fr']
ST_STATS = ['fg_att', 'fg_made', 'fg_dist_att_sum', 'fg_dist_made_sum', 'fg_att_40plus',
            'fg_made_40plus', 'fg_long_made', 'xp_att', 'xp_made', 'kickoffs', 'kickoff_yds',
            'punts', 'punt_yds', 'punt_net_yds', 'kick_returns', 'kick_return_yds',
            'punt_returns', 'punt_return_yds']
STATS = OFF_STATS + DEF_STATS + ST_STATS

TEAM_COLS = ['team_dropbacks', 'team_dropbacks_ng', 'team_dropbacks_id', 'team_dropbacks_id_ng',
             'team_pass_att', 'team_rushes', 'team_rushes_ng', 'team_rushes_id', 'team_rushes_id_ng',
             'team_targets_id', 'team_targets_id_ng',
             'team_def_sack_events', 'team_def_sack_events_id', 'team_def_sacks_credit',
             'team_def_int_events', 'team_def_int_events_id', 'team_def_pbu_flag', 'team_def_pbu_id',
             'team_def_ff_flag', 'team_def_ff_id', 'team_def_fr_id',
             'team_fumble_events', 'team_fumble_events_id', 'team_kickoff_events', 'team_kickoff_events_id',
             'team_fg_att', 'team_xp_att', 'team_xp_att_id', 'team_kickoffs', 'team_punts',
             'team_returns_id', 'team_plays', 'team_garbage_plays']

_MEM = {}
MEM_SEASONS = 10                        # full seasons kept in memory


# ----------------------------------------------------------------- helpers
def _b(s):
    return s.fillna(False).astype(bool) if s.dtype != bool else s


def _num(s):
    return pd.to_numeric(s, errors='coerce')


def to_ts(T):
    if T is None:
        return None
    t = pd.Timestamp(T)
    return t.tz_localize('UTC') if t.tzinfo is None else t.tz_convert('UTC')


def valid_id(x):
    """Vectorised: a real ESPN athlete id (numeric, > MIN_VALID_ID, not a placeholder).
    Negative ids are the provider's 'TEAM' placeholder athletes."""
    v = _num(pd.Series(x) if not isinstance(x, pd.Series) else x)
    return v.notna() & (v > MIN_VALID_ID) & ~v.isin(list(PLACEHOLDER_IDS))


def pid_str(espn_id):
    return 'espn:%d' % int(espn_id)


def pbp_file(season):
    return common.data_path('pbp', 'play_by_play_%d.parquet' % season)


def load_pbp(season):
    """The play table with the columns this module reads (missing ones as NaN).
    Market / win-probability columns are never requested (V2 plays.FORBIDDEN_PBP_COLUMNS)."""
    import pyarrow.parquet as pq
    from .. import plays as P
    f = pbp_file(season)
    names = set(pq.ParquetFile(f).schema_arrow.names)
    use = [c for c in PBP_COLS if c in names]
    assert not (set(use) & set(P.FORBIDDEN_PBP_COLUMNS)), 'market/WP column requested from pbp'
    d = pd.read_parquet(f, columns=use)
    for c in PBP_COLS:
        if c not in d.columns:
            d[c] = np.nan
    return d


def kickoffs(season):
    """game_id -> kickoff (UTC) and the schedule's team names, from the schedule file."""
    f = common.data_path('sched', 'cfb_schedules_%d.parquet' % season)
    s = pd.read_parquet(f, columns=['game_id', 'start_date', 'season_type', 'home_id', 'home_team',
                                    'away_id', 'away_team', 'week'])
    s['game_id'] = _num(s.game_id).astype('Int64')
    s = s.dropna(subset=['game_id']).drop_duplicates('game_id')
    s['game_id'] = s.game_id.astype('int64')
    s['kickoff_ts'] = pd.to_datetime(s.start_date, utc=True, errors='coerce', format='ISO8601')
    # V2's own kickoff (stage 2) wins where it exists, so both layers share one clock
    g2 = common.out_path('stage2', 'games.parquet')
    if os.path.exists(g2):
        g = pd.read_parquet(g2, columns=['game_id', 'kickoff_ts'])
        k2 = g.drop_duplicates('game_id').set_index('game_id').kickoff_ts
        v = k2.reindex(s.game_id.values).values
        s['kickoff_ts'] = pd.Series(v, index=s.index).where(pd.notna(v), s.kickoff_ts)
        s['kickoff_ts'] = pd.to_datetime(s.kickoff_ts, utc=True)
    return s[['game_id', 'kickoff_ts', 'season_type', 'home_id', 'home_team', 'away_id', 'away_team']]


# ---------------------------------------------------------- play cleaning
def clean_plays(d, season):
    """Drop what V2 stage 1 drops, plus the contaminants; attach kickoff and garbage."""
    n0 = len(d)
    d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()].copy()
    d['pos_team_id'] = d.pos_team_id.astype('int64')
    d['def_pos_team_id'] = d.def_pos_team_id.astype('int64')
    d = d[~_b(d.text_dupe)]
    st = _num(d.seasonType)
    teams = pd.concat([d.pos_team_id, d.def_pos_team_id, _num(d.homeTeamId), _num(d.awayTeamId)], axis=1)
    allstar = teams.isin(list(ALL_STAR_TEAM_IDS)).any(axis=1)
    bad_game = st.eq(OFFSEASON_SEASON_TYPE) | allstar
    bad_ids = set(d.loc[bad_game, 'game_id'])
    d = d[~d.game_id.isin(bad_ids)].copy()
    k = kickoffs(season)
    d = d.merge(k[['game_id', 'kickoff_ts']], on='game_id', how='left')
    d['garbage'] = common.garbage_mask(d.period.fillna(1).astype(int).values,
                                       d['start.pos_score_diff'].fillna(0).values)
    d.attrs['filtered'] = {'rows_in': int(n0), 'allstar_offseason_games': len(bad_ids),
                           'rows_out': int(len(d))}
    return d


# ------------------------------------------------------------ the builder
def _events(d):
    """Long table of (game_id, team_id, pid, name, stat columns) from every role."""
    scrim = (_b(d.rush) | _b(d['pass'])) & ~_b(d.penalty_no_play) & d.EPA.notna()
    live = ~_b(d.penalty_no_play)
    is_pass = scrim & _b(d['pass'])
    is_rush = scrim & _b(d.rush) & ~is_pass
    sack = is_pass & _b(d.sack)
    att = is_pass & ~_b(d.sack)
    ng = ~d.garbage.astype(bool)
    epa = d.EPA.fillna(0.0)
    succ = _b(d.EPA_success).astype(float)
    expl = _b(d.EPA_explosive).astype(float)
    fd = _b(d.first_down_created).astype(float)
    yds = d.statYardage.astype(float).fillna(0.0)
    rz = d['start.yardsToEndzone'].le(RED_ZONE_YTG)
    comp = _b(d.completion) & att
    pos, dfn = d.pos_team_id, d.def_pos_team_id
    one = pd.Series(1.0, index=d.index)

    def team_or(col, fallback):
        v = _num(d[col])
        return v.where(v.notna(), fallback).astype('float64')

    parts = []

    def add(mask, role, team, **stats):
        pidc, namec = role + '_player_id', role + '_player_name'
        m = mask & d[pidc].notna()
        if not m.any():
            return
        x = pd.DataFrame({'game_id': d.game_id[m].values, 'team_id': np.asarray(team[m], dtype='float64'),
                          'pid': _num(d[pidc][m]).values, 'name': d[namec][m].values,
                          'play': d.game_play_number[m].values,
                          'certain': role not in SIDE_UNCERTAIN_ROLES})
        mv = m.values
        for k, v in stats.items():
            if isinstance(v, pd.Series):
                x[k] = v.values[mv]
            elif isinstance(v, np.ndarray):
                x[k] = v[mv]
            else:
                x[k] = v
        parts.append(x)

    f = lambda s: s.astype(float)
    # passer: every dropback (sacks included), V2's definition
    add(is_pass, 'passer', pos, dropbacks=1.0, dropbacks_ng=f(ng), pass_att=f(att), pass_att_ng=f(att & ng),
        completions=f(comp), pass_yds=yds.where(comp, 0.0), pass_epa=epa, pass_epa_ng=epa.where(ng, 0.0),
        pass_succ=succ, pass_succ_ng=succ.where(ng, 0.0), sacks_taken=f(sack),
        ints_thrown=f(_b(d['int']) & att), pass_first_downs=fd.where(att, 0.0), first_db_play=d.game_play_number.astype(float))
    add(is_rush, 'rusher', pos, rush_att=1.0, rush_att_ng=f(ng), rush_yds=yds, rush_epa=epa,
        rush_epa_ng=epa.where(ng, 0.0), rush_succ=succ, rush_succ_ng=succ.where(ng, 0.0), expl_rush=expl,
        rush_first_downs=fd, rz_touches=f(rz))
    add(att, 'receiver', pos, targets=1.0, targets_ng=f(ng), receptions=f(comp), receptions_ng=f(comp & ng),
        rec_yds=yds.where(comp, 0.0), rec_epa=epa, rec_epa_ng=epa.where(ng, 0.0), rec_succ=succ,
        expl_rec=expl.where(comp, 0.0), rec_first_downs=fd.where(comp, 0.0), rz_touches=f(rz & comp),
        rz_targets=f(rz))
    add(live & d.fumble_player_id.notna(), 'fumble', team_or('fumbling_team', pos), fumbles=1.0)
    # defence: split sacks are half each, so a team's sack credits sum to its sacks
    two = d.sack_player_id2.notna() & valid_id(d.sack_player_id2)
    add(sack, 'sack', dfn, def_sacks=np.where(two, 0.5, 1.0), def_sack_plays=1.0)
    s2 = sack & two
    if s2.any():
        parts.append(pd.DataFrame({'game_id': d.game_id[s2].values, 'team_id': dfn[s2].astype('float64').values,
                                   'pid': _num(d.sack_player_id2[s2]).values, 'name': d.sack_player_name2[s2].values,
                                   'play': d.game_play_number[s2].values, 'def_sacks': 0.5, 'def_sack_plays': 1.0,
                                   'certain': True}))
    add(live & _b(d['int']), 'interception', dfn, def_ints=1.0)
    add(live, 'pass_breakup', dfn, def_pbu=1.0)
    add(live, 'fumble_forced', dfn, def_ff=1.0)
    rec_team = team_or('fumble_recovery_team', pd.Series(np.where(_b(d.fumble_lost), dfn, pos), index=d.index))
    add(live, 'fumble_recovered', rec_team, def_fr=1.0)
    # special teams
    fga = live & _b(d.fg_attempt)
    dist = _num(d.yds_fg)
    made = _b(d.fg_made) & fga
    add(fga, 'fg_kicker', team_or('fg_team', pos), fg_att=1.0, fg_made=f(made),
        fg_dist_att_sum=dist.fillna(0.0), fg_dist_made_sum=dist.where(made, 0.0).fillna(0.0),
        fg_att_40plus=f(dist.ge(40)), fg_made_40plus=f(dist.ge(40) & made),
        fg_long_made=dist.where(made, 0.0).fillna(0.0))
    pun = live & _b(d.punt)
    gross = _num(d.yds_punted).fillna(0.0)
    add(pun, 'punter', team_or('punt_team', pos), punts=1.0, punt_yds=gross,
        punt_net_yds=gross - _num(d.yds_punt_return).fillna(0.0))
    add(pun, 'punt_return', team_or('punt_return_team', dfn), punt_returns=1.0,
        punt_return_yds=_num(d.yds_punt_return).fillna(0.0))
    ko = live & _b(d.kickoff_play)
    add(ko, 'kickoff', team_or('kicking_team', dfn), kickoffs=1.0, kickoff_yds=_num(d.yds_kickoff).fillna(0.0))
    add(ko, 'kickoff_return', team_or('kick_return_team', pos), kick_returns=1.0,
        kick_return_yds=_num(d.yds_kickoff_return).fillna(0.0))
    ev = pd.concat(parts, ignore_index=True, sort=False)
    ev = ev[ev.team_id.notna()]
    ev['team_id'] = ev.team_id.astype('int64')
    ok = valid_id(ev.pid)
    dropped = int((~ok).sum())
    ev = ev[ok].copy()
    ev['pid'] = ev.pid.astype('int64')
    return ev, dropped


_SUFFIXES = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}


def name_key(name):
    """Normalised full-name key: lower case, punctuation dropped, generational suffix
    dropped ('Robert Hammond III' -> 'robert hammond')."""
    if name is None or (isinstance(name, float) and np.isnan(name)):
        return ''
    s = str(name).lower().replace('.', ' ').replace(',', ' ').replace("'", '').replace('`', '')
    s = ''.join(ch if (ch.isalnum() or ch in ' -') else ' ' for ch in s).replace('-', ' ')
    toks = [t for t in s.split() if t]
    while len(toks) > 1 and toks[-1] in _SUFFIXES:
        toks = toks[:-1]
    return ' '.join(toks)


def initial_key(name):
    """First initial + last name ('S. Starzyk', 'Scott Starzyk' -> 's starzyk')."""
    k = name_key(name).split()
    if len(k) < 2:
        return ''
    return k[0][0] + ' ' + k[-1]


XP_TYPES = ('Extra Point Good', 'Extra Point Missed')


def xp_plays(d):
    """Extra-point attempts: the xp_attempt flag (2014+, kicker name on the TD play) or,
    before 2014, the separate 'Extra Point Good/Missed' plays whose text names the
    kicker ('A.J. Principe extra point GOOD.'). -> game_id, kicker name, made, team."""
    a = d[_b(d.xp_attempt)]
    a = pd.DataFrame({'game_id': a.game_id.values, 'xp_kicker_player_name': a.xp_kicker_player_name.values,
                      'xp_made': _b(a.xp_made).values, 'pos_team_id': a.pos_team_id.values})
    typ = d['type.text'].fillna('') if 'type.text' in d else pd.Series('', index=d.index)
    b = d[typ.isin(XP_TYPES) & ~_b(d.xp_attempt)]
    nm = b.text.fillna('').str.extract(r'^\s*(.+?)\s+extra point', expand=False) if 'text' in b else None
    b = pd.DataFrame({'game_id': b.game_id.values, 'xp_kicker_player_name': nm.values if nm is not None else None,
                      'xp_made': typ[b.index].eq('Extra Point Good').values, 'pos_team_id': b.pos_team_id.values})
    return pd.concat([a, b], ignore_index=True)


def _xp_events(d, ev):
    """Extra points carry a kicker NAME only (often abbreviated, 'N.Radicic'). Resolve it
    to an id, point-in-time: among the players who kicked (FG, kickoff or punt) for
    either team of the game, in this game or an earlier one this season, the full-name
    key must match exactly one id; failing that, the initial + last-name key must.
    Unresolved attempts stay unattributed (team_xp_att - team_xp_att_id)."""
    empty = pd.DataFrame(columns=['game_id', 'team_id', 'pid', 'name', 'xp_att', 'xp_made'])
    xa = xp_plays(d)
    n_all = int(len(xa))
    x = xa[xa.xp_kicker_player_name.notna() & (xa.xp_kicker_player_name.astype(str).str.len() > 0)]
    if x.empty:
        return empty, n_all, 0
    g = d.drop_duplicates('game_id').set_index('game_id')
    x = x.assign(kickoff_ts=g.kickoff_ts.reindex(x.game_id.values).values,
                 homeTeamId=g.homeTeamId.reindex(x.game_id.values).values,
                 awayTeamId=g.awayTeamId.reindex(x.game_id.values).values)
    x = x[['game_id', 'xp_kicker_player_name', 'xp_made', 'kickoff_ts', 'homeTeamId', 'awayTeamId']].copy()
    x['kickoff_ts'] = pd.to_datetime(x.kickoff_ts, utc=True)
    x['_row'] = np.arange(len(x))
    x['k_full'] = [name_key(v) for v in x.xp_kicker_player_name]
    x['k_init'] = [initial_key(v) for v in x.xp_kicker_player_name]
    col = lambda c: ev[c].fillna(0) if c in ev.columns else pd.Series(0.0, index=ev.index)
    k = ev[(col('fg_att') > 0) | (col('kickoffs') > 0) | (col('punts') > 0)][['game_id', 'team_id', 'pid', 'name']]
    k = k.dropna(subset=['name']).merge(d[['game_id', 'kickoff_ts']].drop_duplicates('game_id'), on='game_id')
    k['k_full'] = [name_key(v) for v in k.name]
    k['k_init'] = [initial_key(v) for v in k.name]
    xs = pd.concat([x.assign(team_id=_num(x.homeTeamId)), x.assign(team_id=_num(x.awayTeamId))])
    got = {}
    for key in ('k_full', 'k_init'):
        kk = k.groupby(['team_id', key, 'pid']).kickoff_ts.min().rename('first_ts').reset_index()
        kk = kk[kk[key] != '']
        m = xs[~xs._row.isin(list(got))].merge(kk, on=['team_id', key], how='inner')
        m = m[m.first_ts.notna() & m.kickoff_ts.notna() & (m.first_ts <= m.kickoff_ts)]
        n = m.groupby('_row').pid.nunique()
        m = m[m._row.isin(n[n.eq(1)].index)].drop_duplicates('_row')
        for r, t, p_ in zip(m._row.values, m.team_id.values, m.pid.values):
            got[int(r)] = (int(t), int(p_))
    x = x[x._row.isin(list(got))]
    out = pd.DataFrame({'game_id': x.game_id.values,
                        'team_id': np.array([got[int(r)][0] for r in x._row], dtype='int64'),
                        'pid': np.array([got[int(r)][1] for r in x._row], dtype='int64'),
                        'name': x.xp_kicker_player_name.values,
                        'xp_att': 1.0, 'xp_made': _b(x.xp_made).astype(float).values})
    return out, n_all, int(len(out))


def _one_team_per_game(ev):
    """A player plays for one team in a game. His side-UNCERTAIN events (fumbles and
    fumble recoveries) go to the team of his side-certain events in that game
    (passer/rusher/receiver -> offence; sack/INT/PBU/FF -> defence; kicking roles -> the
    kicking/returning team the provider names); ties -> the team with more events, then
    the lower id. Side-certain events are never moved, so every share denominator (built
    from the same plays' offence/defence sides) still sums to 1. Players with uncertain
    events only keep the provider's team."""
    ev = ev.copy()
    ev['certain'] = ev.certain.fillna(True).astype(bool)
    c = ev[ev.certain].groupby(['game_id', 'pid', 'team_id']).size().rename('nc').reset_index()
    a = ev.groupby(['game_id', 'pid', 'team_id']).size().rename('na').reset_index()
    c = c.merge(a, on=['game_id', 'pid', 'team_id'], how='left')
    c = c.sort_values(['game_id', 'pid', 'nc', 'na', 'team_id'], ascending=[True, True, False, False, True],
                      kind='mergesort').drop_duplicates(['game_id', 'pid'])
    best = c.set_index(['game_id', 'pid']).team_id
    idx = pd.MultiIndex.from_arrays([ev.game_id.values, ev.pid.values])
    b = best.reindex(idx).values
    mv = ~ev.certain.values & ~np.isnan(b) & (b != ev.team_id.values)
    moved = int(mv.sum())
    ev['team_id'] = np.where(mv, b, ev.team_id.values).astype('int64')
    return ev.drop(columns=['certain']), moved


def _team_context(d):
    scrim = (_b(d.rush) | _b(d['pass'])) & ~_b(d.penalty_no_play) & d.EPA.notna()
    live = ~_b(d.penalty_no_play)
    is_pass = scrim & _b(d['pass'])
    is_rush = scrim & _b(d.rush) & ~is_pass
    att = is_pass & ~_b(d.sack)
    sack = is_pass & _b(d.sack)
    ng = ~d.garbage.astype(bool)
    pv, rv, cv = valid_id(d.passer_player_id), valid_id(d.rusher_player_id), valid_id(d.receiver_player_id)
    sv, sv2 = valid_id(d.sack_player_id), valid_id(d.sack_player_id2)
    iv, bv = valid_id(d.interception_player_id), valid_id(d.pass_breakup_player_id)
    fv, frv = valid_id(d.fumble_forced_player_id), valid_id(d.fumble_recovered_player_id)
    f = lambda m: m.astype(float)
    off = pd.DataFrame({
        'game_id': d.game_id, 'team_id': d.pos_team_id,
        'team_dropbacks': f(is_pass), 'team_dropbacks_ng': f(is_pass & ng),
        'team_dropbacks_id': f(is_pass & pv), 'team_dropbacks_id_ng': f(is_pass & pv & ng),
        'team_pass_att': f(att), 'team_rushes': f(is_rush), 'team_rushes_ng': f(is_rush & ng),
        'team_rushes_id': f(is_rush & rv), 'team_rushes_id_ng': f(is_rush & rv & ng),
        'team_targets_id': f(att & cv), 'team_targets_id_ng': f(att & cv & ng),
        'team_plays': f(scrim), 'team_garbage_plays': f(scrim & ~ng),
    }).groupby(['game_id', 'team_id']).sum()
    two = sv2
    dfn = pd.DataFrame({
        'game_id': d.game_id, 'team_id': d.def_pos_team_id,
        'team_def_sack_events': f(sack), 'team_def_sack_events_id': f(sack & sv),
        'team_def_sacks_credit': np.where(sack & sv, np.where(two, 0.5, 1.0), 0.0) + np.where(sack & two, 0.5, 0.0),
        'team_def_int_events': f(live & _b(d['int'])), 'team_def_int_events_id': f(live & _b(d['int']) & iv),
        'team_def_pbu_flag': f(live & _b(d.pass_breakup)), 'team_def_pbu_id': f(live & bv),
        'team_def_ff_flag': f(live & _b(d.forced_fumble)), 'team_def_ff_id': f(live & fv),
    }).groupby(['game_id', 'team_id']).sum()
    fum = live & _b(d.fumble_vec)
    fteam = _num(d.fumbling_team).where(_num(d.fumbling_team).notna(), d.pos_team_id)
    fu = pd.DataFrame({'game_id': d.game_id, 'team_id': fteam, 'team_fumble_events': f(fum),
                       'team_fumble_events_id': f(fum & valid_id(d.fumble_player_id))})
    fu = fu[fu.team_id.notna()].astype({'team_id': 'int64'}).groupby(['game_id', 'team_id']).sum()
    ko = live & _b(d.kickoff_play)
    kteam = _num(d.kicking_team).where(_num(d.kicking_team).notna(), d.def_pos_team_id)
    kk = pd.DataFrame({'game_id': d.game_id, 'team_id': kteam, 'team_kickoff_events': f(ko),
                       'team_kickoff_events_id': f(ko & valid_id(d.kickoff_player_id))})
    kk = kk[kk.team_id.notna()].astype({'team_id': 'int64'}).groupby(['game_id', 'team_id']).sum()
    tm = off.join(dfn, how='outer').join(fu, how='outer').join(kk, how='outer').fillna(0.0).reset_index()
    return tm


def _build_full(season, pbp=None):
    d = load_pbp(season) if pbp is None else pbp.copy()
    d = clean_plays(d, season)
    ev, dropped = _events(d)
    xp, xp_n, xp_res = _xp_events(d, ev)
    xp['certain'] = True
    ev = pd.concat([ev, xp], ignore_index=True, sort=False)
    ev, moved = _one_team_per_game(ev)
    for c in STATS:
        if c not in ev.columns:
            ev[c] = 0.0
    ev[STATS] = ev[STATS].fillna(0.0)
    key = ['game_id', 'team_id', 'pid']
    g = ev.groupby(key, sort=True)
    agg = {c: 'sum' for c in STATS}
    agg['fg_long_made'] = 'max'
    P = g.agg(agg)
    # the name used most often for the player in the game (ties: alphabetical)
    nm = ev.dropna(subset=['name']).groupby(key + ['name']).size().rename('n').reset_index()
    nm = nm.sort_values(key + ['n', 'name'], ascending=[True, True, True, False, True])
    nm = nm.drop_duplicates(key).set_index(key)['name']
    P['name'] = nm.reindex(P.index)
    P['first_db_play'] = ev[ev.dropbacks.fillna(0) > 0].groupby(key).first_db_play.min().reindex(P.index)
    P = P.reset_index()
    # fumble recoveries credited to the recovering team; recompute team fr from rows
    T = _team_context(d)
    frt = P.groupby(['game_id', 'team_id']).def_fr.sum().rename('team_def_fr_id')
    st = P.groupby(['game_id', 'team_id']).agg(team_fg_att=('fg_att', 'sum'), team_kickoffs=('kickoffs', 'sum'),
                                               team_punts=('punts', 'sum'), team_xp_att_id=('xp_att', 'sum'))
    st['team_returns_id'] = (P.kick_returns + P.punt_returns).groupby([P.game_id, P.team_id]).sum()
    T = T.set_index(['game_id', 'team_id']).join(frt, how='outer').join(st, how='outer').fillna(0.0)
    xpt = xp_plays(d).groupby(['game_id', 'pos_team_id']).size().rename('team_xp_att')
    xpt.index = xpt.index.set_names(['game_id', 'team_id'])
    T = T.join(xpt, how='left').fillna({'team_xp_att': 0.0}).reset_index()
    for c in TEAM_COLS:
        if c not in T.columns:
            T[c] = 0.0
    # game metadata
    meta = d.groupby('game_id').agg(season=('season', 'first'), week=('week', 'first'),
                                    season_type=('seasonType', 'first'), home_id=('homeTeamId', 'first'),
                                    away_id=('awayTeamId', 'first'), kickoff_ts=('kickoff_ts', 'first')).reset_index()
    meta['season'] = season
    T = T.merge(meta, on='game_id', how='left')
    T['home_id'] = _num(T.home_id)
    T['away_id'] = _num(T.away_id)
    T['opp_id'] = np.where(T.team_id.eq(T.home_id), T.away_id, T.home_id)
    T['is_home'] = T.team_id.eq(T.home_id)
    T = T[T.team_id.eq(T.home_id) | T.team_id.eq(T.away_id)].copy()   # a mis-sided play is not a team
    T = T.sort_values(['kickoff_ts', 'game_id', 'team_id'], kind='mergesort').reset_index(drop=True)
    P = P.merge(T, on=['game_id', 'team_id'], how='inner')
    P = _derive(P)
    P.attrs['filtered'] = dict(d.attrs.get('filtered', {}), placeholder_or_negative_id_events=dropped,
                               xp_attempts=xp_n, xp_resolved=xp_res, team_reassigned_events=moved)
    T.attrs['filtered'] = P.attrs['filtered']
    return P, T


def _derive(P):
    """Shares, starts, usage-leader flags, ids. Row-local (a function of the game)."""
    P = P.copy()
    P['player_id'] = 'espn:' + P.pid.astype('int64').astype(str)
    P = P.rename(columns={'pid': 'espn_id'})
    den = lambda c: P[c].where(P[c] > 0)
    P['db_share'] = P.dropbacks / den('team_dropbacks_id')
    P['db_share_ng'] = P.dropbacks_ng / den('team_dropbacks_id_ng')
    P['carry_share'] = P.rush_att / den('team_rushes_id')
    P['carry_share_ng'] = P.rush_att_ng / den('team_rushes_id_ng')
    P['target_share'] = P.targets / den('team_targets_id')
    P['target_share_ng'] = P.targets_ng / den('team_targets_id_ng')
    P['sack_share'] = P.def_sacks / den('team_def_sacks_credit')
    P['qb_rush_att'] = np.where(P.dropbacks > 0, P.rush_att, 0.0)
    # QB starter: the passer on the team's first dropback (V2 stage 1's rule)
    fp = P.groupby(['game_id', 'team_id']).first_db_play.transform('min')
    P['qb_starter'] = P.first_db_play.notna() & P.first_db_play.eq(fp)
    # usage leaders (NOT starts: usage-based flags, ties share the rank)
    key = ['game_id', 'team_id']
    r_db = P.dropbacks.where(P.dropbacks > 0).groupby([P.game_id, P.team_id]).rank(method='min', ascending=False)
    r_ru = P.rush_att.where(P.rush_att > 0).groupby([P.game_id, P.team_id]).rank(method='min', ascending=False)
    r_tg = P.targets.where(P.targets > 0).groupby([P.game_id, P.team_id]).rank(method='min', ascending=False)
    P['usage_leader_dropback'] = r_db.eq(1)
    P['usage_leader_rush'] = r_ru.eq(1)
    P['usage_top3_target'] = r_tg.le(3)
    P['player_game_id'] = [ids.h('cfb_player_game', g, t, p) for g, t, p in
                           zip(P.game_id.values, P.team_id.values, P.player_id.values)]
    P = P.sort_values(['kickoff_ts', 'game_id', 'team_id', 'espn_id'], kind='mergesort').reset_index(drop=True)
    return P


# ------------------------------------------------------------------ cache
def _cache_key(season):
    f = pbp_file(season)
    sf = common.data_path('sched', 'cfb_schedules_%d.parquet' % season)
    st, ss = os.stat(f), os.stat(sf)
    return '%s|%d|%d|%d|%d' % (CODE_VERSION, st.st_size, st.st_mtime_ns, ss.st_size, ss.st_mtime_ns)


def _full(season):
    key = (season, _cache_key(season))
    if key in _MEM:
        return _MEM[key]
    d = common.out_path('personnel', 'cache', 'x')
    d = os.path.dirname(d)
    fp, ft, fm = (os.path.join(d, 'player_games_%d.parquet' % season),
                  os.path.join(d, 'team_games_%d.parquet' % season),
                  os.path.join(d, 'manifest_%d.json' % season))
    P = T = None
    try:
        m = json.load(open(fm))
        if m.get('key') == key[1]:
            P, T = pd.read_parquet(fp), pd.read_parquet(ft)
            P.attrs['filtered'] = T.attrs['filtered'] = m.get('filtered', {})
    except (OSError, ValueError):
        P = T = None
    if P is None:
        P, T = _build_full(season)
        try:
            P.to_parquet(fp, index=False)
            T.to_parquet(ft, index=False)
            with open(fm, 'w') as fh:
                json.dump({'key': key[1], 'filtered': P.attrs.get('filtered', {})}, fh, sort_keys=True)
        except OSError:
            pass
    _MEM[key] = (P, T)
    while len(_MEM) > MEM_SEASONS:                     # bounded: oldest season out first
        _MEM.pop(next(iter(_MEM)))
    return P, T


def _restrict(P, T, T_):
    if T_ is None:
        return P, T
    P2 = P[P.kickoff_ts.notna() & (P.kickoff_ts < T_)]
    T2 = T[T.kickoff_ts.notna() & (T.kickoff_ts < T_)]
    return P2, T2


# -------------------------------------------------------------- public API
def player_games(season, T=None, pbp=None, null_unreliable=False):
    """One row per player x game (x team) for `season`, games that kicked off strictly
    before T when T is given. `pbp`: an explicit play table (tests); bypasses caches.

    Row schema: see METHODS_FOUNDATION.md "player_games". Keys: player_game_id,
    player_id ('espn:<id>'), espn_id, game_id, team_id, opp_id, is_home, season, week,
    season_type, kickoff_ts, name; the STATS columns; the TEAM_COLS team context;
    shares (db_share[_ng], carry_share[_ng], target_share[_ng], sack_share);
    qb_starter, qb_rush_att, usage_leader_dropback, usage_leader_rush, usage_top3_target;
    the reliability flags (<column>_reliable) of the season at T."""
    T_ = to_ts(T)
    if pbp is not None:
        P, TT = _build_full(season, pbp)
    else:
        P, TT = _full(season)
    P2, T2 = _restrict(P, TT, T_)
    out = P2.copy()
    rel = reliability(season, tg=T2)
    # the season's column reliability AT T (games before T only): a collapsed provider
    # column is flagged, never presented as zero production (null_unreliable nulls it)
    for col, flag in (('def_sacks', 'def_sacks_reliable'), ('def_ints', 'def_ints_reliable'),
                      ('def_pbu', 'def_pbu_reliable'), ('def_ff', 'def_ff_reliable'),
                      ('def_fr', 'def_fr_reliable'), ('fumbles', 'fumbles_reliable'),
                      ('kickoffs', 'kickoffs_reliable'), ('receiver', 'receiver_ids_reliable')):
        out[flag] = rel.get(col, {}).get('verdict') == 'RELIABLE'
    if null_unreliable:
        out = mark_unreliable(out, rel)
    out.attrs = dict(P.attrs)
    out.attrs['reliability'] = rel
    return out


def team_games(season, T=None, pbp=None):
    """One row per (game, team): the share denominators and id coverage."""
    T_ = to_ts(T)
    if pbp is not None:
        P, TT = _build_full(season, pbp)
    else:
        P, TT = _full(season)
    _, T2 = _restrict(P, TT, T_)
    return T2.copy()


def reliability(season, T=None, tg=None):
    """Per defensive column: id coverage, id-carrying events per team-game, and the
    verdict RELIABLE / UNRELIABLE / INSUFFICIENT, from the games before T only."""
    tg = team_games(season, T) if tg is None else tg
    n = len(tg)
    spec = {
        'def_sacks': ('team_def_sack_events_id', 'team_def_sack_events'),
        'def_ints': ('team_def_int_events_id', 'team_def_int_events'),
        'def_pbu': ('team_def_pbu_id', 'team_def_pbu_flag'),
        'def_ff': ('team_def_ff_id', 'team_def_ff_flag'),
        'def_fr': ('team_def_fr_id', None),
    }
    out = {}
    for col, (idc, flagc) in spec.items():
        ev = float(tg[idc].sum()) if n else 0.0
        fl = float(tg[flagc].sum()) if (n and flagc) else None
        cov = (min(1.0, ev / fl) if fl else None) if flagc else None
        rate = ev / n if n else None
        if n < MIN_TEAM_GAMES_FOR_RELIABILITY:
            verdict = 'INSUFFICIENT'
        else:
            ok_rate = rate is not None and rate >= RATE_FLOOR[col]
            ok_cov = cov is None or cov >= ID_COVERAGE_FLOOR
            verdict = 'RELIABLE' if (ok_rate and ok_cov) else 'UNRELIABLE'
        out[col] = {'id_coverage': cov, 'events_per_team_game': rate, 'verdict': verdict,
                    'team_games': n}
    # offensive / special-teams attribution (share denominators are attributed totals;
    # this is how much of the play volume is attributed)
    for col, (a, b) in {'passer': ('team_dropbacks_id', 'team_dropbacks'),
                        'rusher': ('team_rushes_id', 'team_rushes'),
                        'receiver': ('team_targets_id', 'team_pass_att'),
                        'fumbles': ('team_fumble_events_id', 'team_fumble_events'),
                        'kickoffs': ('team_kickoff_events_id', 'team_kickoff_events'),
                        'xp': ('team_xp_att_id', 'team_xp_att')}.items():
        num, den = float(tg[a].sum()) if n else 0.0, float(tg[b].sum()) if n else 0.0
        cov = num / den if den else None
        out[col] = {'id_coverage': cov, 'verdict': ('INSUFFICIENT' if n < MIN_TEAM_GAMES_FOR_RELIABILITY else
                                                    'ABSENT' if not den else
                                                    'RELIABLE' if cov >= ID_COVERAGE_FLOOR else 'WEAK'),
                    'team_games': n}
    return out


def mark_unreliable(P, rel):
    """Null the defensive columns whose season reliability (at T) failed, in place of
    presenting a collapsed provider feed as zero production."""
    P = P.copy()
    for col in ('def_sacks', 'def_ints', 'def_pbu', 'def_ff', 'def_fr'):
        ok = rel.get(col, {}).get('verdict') == 'RELIABLE'
        P[col + '_reliable'] = ok
        if not ok:
            P[col] = np.nan
            if col == 'def_sacks':
                P['sack_share'] = np.nan
    return P


# ---------------------------------------------------------------- audit
def coverage(season):
    """The audit's PBP coverage numbers for one season (definitions in AUDIT.md)."""
    d = clean_plays(load_pbp(season), season)
    scrim = (_b(d.rush) | _b(d['pass'])) & ~_b(d.penalty_no_play) & d.EPA.notna()
    live = ~_b(d.penalty_no_play)
    is_pass = scrim & _b(d['pass'])
    is_rush = scrim & _b(d.rush) & ~is_pass
    att = is_pass & ~_b(d.sack)
    sack = is_pass & _b(d.sack)
    tgn = d.groupby(['game_id', 'pos_team_id']).ngroups
    r = lambda num, den: (float(num) / float(den)) if den else None
    fga, pun, ko = live & _b(d.fg_attempt), live & _b(d.punt), live & _b(d.kickoff_play)
    xpp = xp_plays(d)
    P, _ = _full(season)
    return {
        'season': season, 'games': int(d.game_id.nunique()), 'team_games': int(tgn),
        'plays': int(len(d)), 'allstar_offseason_games_removed': d.attrs['filtered']['allstar_offseason_games'],
        'passer_id': r((is_pass & valid_id(d.passer_player_id)).sum(), is_pass.sum()),
        'rusher_id': r((is_rush & valid_id(d.rusher_player_id)).sum(), is_rush.sum()),
        'receiver_id': r((att & valid_id(d.receiver_player_id)).sum(), att.sum()),
        'sacks_per_team_game': r(sack.sum(), tgn),
        'sack_id': r((sack & valid_id(d.sack_player_id)).sum(), sack.sum()),
        'sack2_share': r((sack & valid_id(d.sack_player_id2)).sum(), sack.sum()),
        'int_per_team_game': r((live & _b(d['int'])).sum(), tgn),
        'int_id': r((live & _b(d['int']) & valid_id(d.interception_player_id)).sum(), (live & _b(d['int'])).sum()),
        'pbu_flag_per_team_game': r((live & _b(d.pass_breakup)).sum(), tgn),
        'pbu_id_per_team_game': r((live & valid_id(d.pass_breakup_player_id)).sum(), tgn),
        'ff_id_per_team_game': r((live & valid_id(d.fumble_forced_player_id)).sum(), tgn),
        'fumbles_per_team_game': r((live & _b(d.fumble_vec)).sum(), tgn),
        'fumbler_id': r((live & _b(d.fumble_vec) & valid_id(d.fumble_player_id)).sum(), (live & _b(d.fumble_vec)).sum()),
        'fr_id_per_team_game': r((live & valid_id(d.fumble_recovered_player_id)).sum(), tgn),
        'fg_kicker_id': r((fga & valid_id(d.fg_kicker_player_id)).sum(), fga.sum()),
        'punter_id': r((pun & valid_id(d.punter_player_id)).sum(), pun.sum()),
        'kickoff_kicker_id': r((ko & valid_id(d.kickoff_player_id)).sum(), ko.sum()),
        'xp_attempts': int(len(xpp)),
        'xp_kicker_name': r(xpp.xp_kicker_player_name.notna().sum(), len(xpp)),
        'xp_kicker_resolved': r(P.attrs['filtered'].get('xp_resolved', 0), P.attrs['filtered'].get('xp_attempts', 0)),
        'team_placeholder_events': P.attrs['filtered'].get('placeholder_or_negative_id_events'),
        'kickoff_known': r(d.drop_duplicates('game_id').kickoff_ts.notna().sum(), d.game_id.nunique()),
        **_coverage_extra(season, d),
    }


def _coverage_extra(season, d):
    """Returner and block ids, from the play text (read here only, for the audit)."""
    x = pd.read_parquet(pbp_file(season), columns=['game_id', 'game_play_number', 'text', 'type.text',
                                                   'kickoff_return_player_id', 'punt_return_player_id',
                                                   'fg_block_player_id', 'punt_block_player_id'])
    x = x.merge(d[['game_id', 'game_play_number', 'kickoff_play', 'punt', 'fg_attempt', 'penalty_no_play']].drop_duplicates(
        ['game_id', 'game_play_number']), on=['game_id', 'game_play_number'], how='inner')
    live = ~_b(x.penalty_no_play)
    txt = x.text.fillna('').str.lower()
    ret = txt.str.contains(r'\breturn(?:s|ed)? (?:for|by|of)\b', regex=True)
    ko = live & _b(x.kickoff_play) & ret
    pu = live & _b(x.punt) & ret
    typ = x['type.text'].fillna('')
    kick = _b(x.kickoff_play) | _b(x.punt) | _b(x.fg_attempt) | typ.str.contains('Punt|Field Goal', regex=True)
    blk = typ.str.contains('Blocked', case=False) | (kick & txt.str.contains(r'\bblocked\b', regex=True))
    r = lambda num, den: (float(num) / float(den)) if den else None
    return {'kick_returner_id': r((ko & valid_id(x.kickoff_return_player_id)).sum(), ko.sum()),
            'punt_returner_id': r((pu & valid_id(x.punt_return_player_id)).sum(), pu.sum()),
            'blocked_kicks': int(blk.sum()),
            'block_player_id': r((blk & (valid_id(x.fg_block_player_id) | valid_id(x.punt_block_player_id))).sum(),
                                 blk.sum())}


if __name__ == '__main__':
    import sys
    seasons = [int(a) for a in sys.argv[1:]] or list(range(2009, 2027))
    for S in seasons:
        print(json.dumps(ids.clean(coverage(S)), sort_keys=True))
