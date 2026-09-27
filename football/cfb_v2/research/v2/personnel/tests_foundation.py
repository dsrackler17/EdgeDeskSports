"""Tests for the personnel data foundation (positions, identity, usage, state).

    python3 -m v2.personnel.tests_foundation

Runs on the local data (CFB_V2_DATA / CFB_V2_OUT): the play-by-play, the rosters,
the stage-1 QB games and the availability reports. The first run builds the caches
under <OUT>/personnel (a few minutes); later runs take about two minutes.
"""
import json
import os
import shutil
import sys
import tempfile
import warnings

warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from ..weekly import availability as WA
from . import identity as I
from . import positions as POS
from . import state as ST
from . import usage as U

PASS, FAIL = [0], []
T_MID = '2025-10-14T12:00:00Z'          # a Tuesday freeze in the middle of 2025


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL.append((name, detail))


def done():
    for n, d in FAIL:
        print('FAIL | %s%s' % (n, ('  ' + json.dumps(ids.clean(d), default=str)[:400]) if d is not None else ''))
    print(('ALL GREEN ' if not FAIL else 'FAILED ') + '%d passed, %d failed' % (PASS[0], len(FAIL)))
    sys.exit(0 if not FAIL else 1)


def section(fn):
    """Run one block; an exception is a failure of that block, not of the suite."""
    try:
        fn()
    except Exception as e:                            # noqa: BLE001
        import traceback
        FAIL.append((fn.__name__ + ' raised', repr(e) + ' ' + traceback.format_exc()[-600:]))


# ============================================================ positions
def t_positions():
    cases = {
        'QB': 'QB', 'qb': 'QB', ' Quarterback ': 'QB', 'RB': 'RB', 'FB': 'RB', 'HB': 'RB', 'WR': 'WR', 'SB': 'WR',
        'TE': 'TE', 'OT': 'OT', 'T': 'OT', 'OG': 'OG', 'G': 'OG', 'C': 'C',
        'OL': 'OL_OTHER', 'IOL': 'OL_OTHER', 'Offensive Lineman': 'OL_OTHER',
        'DE': 'EDGE', 'EDGE': 'EDGE', 'EDG': 'EDGE', 'DT': 'DT', 'NT': 'DT', 'DL': 'DL_OTHER',
        'Defensive Lineman': 'DL_OTHER', 'LB': 'LB', 'ILB': 'LB', 'OLB': 'LB', 'MLB': 'LB',
        'CB': 'CB', 'S': 'S', 'FS': 'S', 'SS': 'S', 'DB': 'DB_OTHER', 'NB': 'DB_OTHER',
        'K': 'K', 'PK': 'K', 'P': 'P', 'LS': 'LS', 'KR': 'RETURNER', 'PR': 'RETURNER',
        'ATH': 'UNKNOWN', None: 'UNKNOWN', '': 'UNKNOWN', float('nan'): 'UNKNOWN', 'XYZ': 'UNKNOWN',
    }
    bad = {str(k): (POS.normalize(k), v) for k, v in cases.items() if POS.normalize(k) != v}
    chk('positions: ESPN and cfbfastR/CFBD strings map to their families', not bad, bad)
    chk('positions: a generic OL stays OL_OTHER and a generic DL stays DL_OTHER (never guessed)',
        POS.normalize('OL') == 'OL_OTHER' and POS.normalize('DL') == 'DL_OTHER'
        and POS.normalize_detail('OL')[1] == 'generic_label' and POS.normalize_detail('DL')[1] == 'generic_label')
    heavy = {'usage': {'dropbacks': 300, 'rushes': 40, 'targets': 0}}
    chk('positions: usage context never overrides a provider label (OL with QB usage stays OL_OTHER)',
        POS.normalize('OL', heavy) == 'OL_OTHER' and POS.normalize('DL', heavy) == 'DL_OTHER')
    chk('positions: ATH resolves only from dominant observed usage, flagged usage_inferred',
        POS.normalize_detail('ATH', heavy) == ('QB', 'usage_inferred')
        and POS.normalize('ATH', {'usage': {'dropbacks': 5, 'rushes': 5, 'targets': 5}}) == 'UNKNOWN'
        and POS.normalize('ATH', {'usage': {'dropbacks': 3}}) == 'UNKNOWN')
    chk('positions: unit_of covers every family (QB OL WR_TE RB FRONT7 SECONDARY ST)',
        all(POS.unit_of(f) in POS.UNITS for f in POS.FAMILIES if f != 'UNKNOWN')
        and POS.unit_of('EDGE') == 'FRONT7' and POS.unit_of('LB') == 'FRONT7' and POS.unit_of('S') == 'SECONDARY'
        and POS.unit_of('OL_OTHER') == 'OL' and POS.unit_of('TE') == 'WR_TE' and POS.unit_of('RETURNER') == 'ST')
    chk('positions: weekly_unit_of covers every family (QB OL WR_TE RB DL LB DB ST)',
        all(POS.weekly_unit_of(f) in POS.WEEKLY_UNITS for f in POS.FAMILIES if f != 'UNKNOWN')
        and all(POS.weekly_unit_of(f) in POS.PERSONNEL_TO_WEEKLY[POS.unit_of(f)]
                for f in POS.FAMILIES if f != 'UNKNOWN'))
    mism = {k: (POS.weekly_unit_of(POS.normalize(k)), v) for k, v in WA.UNIT_OF_POSITION.items()
            if POS.weekly_unit_of(POS.normalize(k)) != v}
    chk('positions: agree with the weekly engine on every position string it knows', not mism, mism)
    seen = set()
    for S in I.ESPN_ROSTER_SEASONS:
        seen |= set(I.espn_roster(S).position.dropna().astype(str))
    unk = sorted(p for p in seen if POS.normalize(p) == 'UNKNOWN' and p.upper() != 'ATH')
    chk('positions: every ESPN roster position string (2025/2026) maps to a family (ATH aside)', not unk, unk)


# ========================================================== contaminants
def t_contaminants():
    chk('contaminants: placeholder / negative / tiny ids are not player ids',
        list(U.valid_id(pd.Series([-1044320, -5, 1, 3, 13, 50, 4431452]))) == [False] * 6 + [True])
    raw = pd.read_parquet(U.pbp_file(2021), columns=['game_id', 'seasonType', 'homeTeamId', 'awayTeamId'])
    raw_bad = raw[raw.seasonType.eq(4) | raw.homeTeamId.isin(list(U.ALL_STAR_TEAM_IDS))
                  | raw.awayTeamId.isin(list(U.ALL_STAR_TEAM_IDS))].game_id.unique()
    P = U.player_games(2021)
    teams = set(P.team_id) | set(P.opp_id.dropna().astype(int))
    chk('contaminants: the raw 2021 feed has all-star/offseason games and they are removed',
        len(raw_bad) > 0 and not set(raw_bad) & set(P.game_id) and not teams & set(U.ALL_STAR_TEAM_IDS)
        and not P.season_type.eq(4).any(), {'raw_bad': len(raw_bad)})
    chk('contaminants: no negative (TEAM placeholder) or placeholder id survives in player_games',
        bool(P.espn_id.gt(U.MIN_VALID_ID).all()) and not P.espn_id.isin(list(U.PLACEHOLDER_IDS)).any()
        and P.attrs['filtered'].get('placeholder_or_negative_id_events', 0) > 0,
        P.attrs.get('filtered'))
    r = I.cfbfastr_roster(2010)
    chk('contaminants: legacy negative roster ids are dropped (2010 roster)',
        r.attrs['filtered']['negative_id'] > 0 and bool(r.espn_id.gt(0).all()), r.attrs['filtered'])
    # player-stats placeholders "1" / "3" / "13", on a synthetic file through the real loader
    tmp = tempfile.mkdtemp()
    os.makedirs(os.path.join(tmp, 'v1', 'pstats'))
    pd.DataFrame({'game_id': [1, 1, 1, 1, 1], 'team': ['A'] * 5,
                  'rush_player_id': ['1', '3', '13', '-7', '4431452'],
                  'rush_player': ['TEAM', 'TEAM', 'TEAM', 'TEAM', 'Real Player']}).to_csv(
        os.path.join(tmp, 'v1', 'pstats', 'pstats_2099.csv'), index=False)
    old = C.DATA
    try:
        C.DATA = tmp
        I._MEM.pop(('pstats', 2099), None)
        ps = I.pstats_names(2099)
    finally:
        C.DATA = old
        I._MEM.pop(('pstats', 2099), None)
        shutil.rmtree(tmp, ignore_errors=True)
    chk('contaminants: player_stats placeholder ids 1 / 3 / 13 and negative ids are filtered',
        list(ps.espn_id) == [4431452] and ps.attrs['filtered']['placeholder_id'] == 3
        and ps.attrs['filtered']['negative_id'] == 1, ps.attrs.get('filtered'))


# ====================================================== identity/transfer
REG = {}


def t_identity():
    p, a, t = I.build_players([2024, 2025])
    REG['p'], REG['a'], REG['t'] = p, a, t
    P4, P5 = U.player_games(2024), U.player_games(2025)
    d4 = P4.groupby('player_id').dropbacks.sum()
    d5 = P5.groupby('player_id').dropbacks.sum()
    x = t[t.from_season.eq(2024) & t.to_season.eq(2025) & t.evidence_from.eq('games') & t.evidence_to.eq('games')]
    x = x.assign(db24=x.player_id.map(d4), db25=x.player_id.map(d5))
    x = x[(x.db24 >= 150) & (x.db25 >= 150)]
    x = x.merge(p[['player_id', 'full_name', 'normalized_position']], on='player_id')
    x = x[x.normalized_position.eq('QB')].sort_values(['db25', 'player_id'], ascending=[False, True])
    chk('identity: at least one QB changed teams 2024 -> 2025 in the data', len(x) > 0)
    if not len(x):
        return
    q = x.iloc[0]
    REG['qb'] = q
    pid, eid = q.player_id, int(q.espn_id)
    t4 = P4[P4.espn_id.eq(eid)].groupby('team_id').size()
    t5 = P5[P5.espn_id.eq(eid)].groupby('team_id').size()
    row = p[p.player_id.eq(pid)].iloc[0]
    tbs = json.loads(row.team_by_season)
    chk('identity: the transfer QB (%s) keeps ONE player_id across both schools' % q.full_name,
        pid == 'espn:%d' % eid and int(t4.idxmax()) == int(q.from_team) and int(t5.idxmax()) == int(q.to_team)
        and tbs.get('2024') == int(q.from_team) and tbs.get('2025') == int(q.to_team) and (p.player_id == pid).sum() == 1,
        {'name': q.full_name, 'from': int(q.from_team), 'to': int(q.to_team)})
    tr = t[t.player_id.eq(pid)]
    first5 = P5[P5.espn_id.eq(eid) & P5.team_id.eq(int(q.to_team))].kickoff_ts.min()
    chk('identity: the move is a TRANSFER row with games-per-team evidence, known from his first new-team game, no portal date',
        len(tr) == 1 and tr.event_type.iloc[0] == 'TRANSFER' and json.loads(tr.games_by_team_from.iloc[0]).get(
            str(int(q.from_team)), 0) > 0 and json.loads(tr.games_by_team_to.iloc[0]).get(str(int(q.to_team)), 0) > 0
        and pd.Timestamp(tr.known_from.iloc[0]) == first5 and tr.portal_date.iloc[0] is None,
        tr.to_dict('records'))
    chk('identity: prior_teams and transfer_history carry the old school',
        int(q.from_team) in json.loads(row.prior_teams) and row.n_transfers == 1
        and json.loads(row.transfer_history)[0]['to_team'] == int(q.to_team))
    chk('identity: every player_id is espn:<athlete id>, unique, positive',
        bool(p.player_id.is_unique) and bool((p.player_id == 'espn:' + p.espn_id.astype(str)).all())
        and bool(p.espn_id.gt(U.MIN_VALID_ID).all()))
    chk('identity: cfbfastR class is flagged UNRELIABLE and never fills class_year',
        bool(p.class_year.isna().all()) and set(p.class_year_cfbfastr_flag.dropna()) <= {'UNRELIABLE'}
        and p.class_year_cfbfastr.notna().any())
    chk('identity: full_name is set for every player with games',
        bool(p[p.career_games > 0].full_name.notna().all()))


def t_resolve():
    p, a = REG['p'], REG['a']
    reg = I.Registry(p, a)
    q = REG.get('qb')
    if q is not None:
        nm = q.full_name
        chk('resolve: a unique name within (team, season) resolves',
            reg.resolve(nm, int(q.to_team), 2025) == q.player_id and reg.resolve(nm, int(q.from_team), 2024) == q.player_id)
        chk('resolve: never across teams (right name, wrong team or season -> None)',
            reg.resolve(nm, int(q.to_team), 2024) is None and reg.resolve(nm, int(q.from_team), 2025) is None
            and reg.resolve(nm, 333 if int(q.to_team) != 333 else 61, 2025) is None,
            [reg.resolve_detail(nm, int(q.to_team), 2024), reg.resolve_detail(nm, int(q.from_team), 2025)])
        chk('resolve: never by name alone (no team -> None, with the reason)',
            reg.resolve(nm, None, 2025) is None and 'NO_TEAM' in reg.resolve_detail(nm, None, 2025)['reason'])
        chk('resolve: the exact id wins first',
            reg.resolve_detail('Somebody Else', None, 2025, espn_id=str(int(q.espn_id)))['reason'] == 'EXACT_ID'
            and reg.resolve('x', None, 2025, espn_id='espn:%d' % int(q.espn_id)) == q.player_id)
        ini = U.initial_key(nm)
        k = sorted(reg.init.get((ini, int(q.to_team), 2025), ()))
        if len(k) == 1:
            chk('resolve: initial + last name ("%s") resolves when unique' % ini,
                reg.resolve(nm.split()[0][0] + '. ' + nm.split()[-1], int(q.to_team), 2025) == q.player_id)
    # real ambiguity: two ids with one name on one team in one season
    amb = a[a.team_id.notna()].groupby(['alias_key', 'team_id', 'season']).player_id.nunique()
    amb = amb[amb > 1].sort_index()
    chk('resolve: the data holds same-name same-team-season pairs (the case to refuse)', len(amb) > 0)
    if len(amb):
        (k, t, s) = amb.index[0]
        d = reg.resolve_detail(k, int(t), int(s))
        chk('resolve: an ambiguous real name returns None with the reason and the candidates',
            d['player_id'] is None and d['reason'].startswith('AMBIGUOUS') and len(d['candidates']) >= 2, d)
    # synthetic: position disambiguates, else refuse
    sp = pd.DataFrame({'player_id': ['espn:9000001', 'espn:9000002'], 'normalized_position': ['QB', 'CB']})
    sa = pd.DataFrame({'player_id': ['espn:9000001', 'espn:9000002'], 'alias_key': ['john smith', 'john smith'],
                       'initial_key': ['j smith', 'j smith'], 'season': [2025, 2025], 'team_id': [1000.0, 1000.0]})
    sr = I.Registry(sp, sa)
    chk('resolve: two John Smiths on one team -> None; a position that tells them apart resolves',
        sr.resolve('John Smith', 1000, 2025) is None and sr.resolve('John Smith', 1000, 2025, position='QB') == 'espn:9000001'
        and sr.resolve('John Smith', 1000, 2025, position='WR') is None and sr.resolve('John Smith', 1001, 2025) is None)


# ============================================================ usage at T
def t_usage_T():
    Tm = U.to_ts(T_MID)
    P = U.player_games(2025, T_MID)
    full = U.player_games(2025)
    chk('usage: player_games(season, T) holds no game at or after T (and the full season does)',
        len(P) > 0 and bool((P.kickoff_ts < Tm).all()) and bool((full.kickoff_ts >= Tm).any()))
    tg = U.team_games(2025, T_MID)
    chk('usage: team_games(season, T) holds no game at or after T', bool((tg.kickoff_ts < Tm).all()))
    # perturbation: rewrite every play of every game at/after T
    raw = U.load_pbp(2025)
    k = U.kickoffs(2025).set_index('game_id').kickoff_ts
    fut = raw.game_id.map(k) >= Tm
    pert = raw.copy()
    pert.loc[fut, 'EPA'] = pert.loc[fut, 'EPA'] + 3.0
    pert.loc[fut, 'rusher_player_id'] = pert.loc[fut, 'passer_player_id']
    pert.loc[fut, 'receiver_player_name'] = 'Changed Name'
    pert.loc[fut, 'sack_player_id'] = np.nan
    drop = pert.index[fut.values][::5]
    pert = pert.drop(index=drop)
    a_ = U.player_games(2025, T_MID, pbp=raw)
    b_ = U.player_games(2025, T_MID, pbp=pert)
    cols = [c for c in a_.columns if c not in ('player_game_id',)]
    same = len(a_) == len(b_) and a_[cols].reset_index(drop=True).equals(b_[cols].reset_index(drop=True))
    chk('usage: perturbing games at/after T leaves player_games(season, T) unchanged', same,
        {'a': len(a_), 'b': len(b_), 'future_rows': int(fut.sum())})
    sa = ST.player_week_state(2025, T_MID, availability=[], _pbp=raw)
    sb = ST.player_week_state(2025, T_MID, availability=[], _pbp=pert)
    chk('state: perturbing games at/after T leaves the player-week state at T unchanged (content hashes)',
        len(sa) == len(sb) and list(sa.content_hash) == list(sb.content_hash), {'a': len(sa), 'b': len(sb)})
    REG['state_mid'] = sa


def t_shares():
    for S in (2016, 2025):
        P = U.player_games(S)
        worst = {}
        for c, dn in (('db_share', 'team_dropbacks_id'), ('carry_share', 'team_rushes_id'),
                      ('target_share', 'team_targets_id'), ('db_share_ng', 'team_dropbacks_id_ng'),
                      ('carry_share_ng', 'team_rushes_id_ng'), ('target_share_ng', 'team_targets_id_ng')):
            g = P[P[dn] > 0].groupby(['game_id', 'team_id'])[c].sum()
            worst[c] = float((g - 1.0).abs().max())
        chk('usage %d: dropback, carry and target shares sum to 1 per team-game (raw and non-garbage)' % S,
            max(worst.values()) < 1e-9, worst)
    P = U.player_games(2025)
    chk('usage: one team per player-game after the side-uncertain fix (residual provider side errors < 0.1%)',
        float((P.groupby(['game_id', 'espn_id']).team_id.nunique() > 1).mean()) < 0.001)
    chk('usage: split sacks credit half each, so team sack credits equal credited sacks',
        abs(P.groupby(['game_id', 'team_id']).def_sacks.sum().sum()
            - U.team_games(2025).team_def_sacks_credit.sum()) < 1e-6)
    rel = U.reliability(2022)
    chk('usage: the audit collapses are flagged (2022 INT / PBU / FF ids unreliable, 2013 sacks)',
        rel['def_ints']['verdict'] == 'UNRELIABLE' and rel['def_pbu']['verdict'] == 'UNRELIABLE'
        and U.reliability(2013)['def_sacks']['verdict'] == 'UNRELIABLE'
        and U.reliability(2019)['def_ints']['verdict'] == 'RELIABLE'
        and not U.player_games(2022).def_ints_reliable.any())


def t_starters():
    for S in (2016, 2025):
        f = common.out_path('stage1', 'qb_game_%d.parquet' % S)
        if not os.path.exists(f):
            chk('usage %d: stage-1 qb_game exists for the starter check' % S, False)
            continue
        q = pd.read_parquet(f)
        qs = q[q.starter & (q.qb_id > U.MIN_VALID_ID)][['game_id', 'team_id', 'qb_id']]
        P = U.player_games(S)
        ps = P[P.qb_starter][['game_id', 'team_id', 'espn_id']]
        m = qs.merge(ps, on=['game_id', 'team_id'], how='inner')
        n_start = P[P.qb_starter].groupby(['game_id', 'team_id']).size()
        chk('usage %d: the QB starter matches stage-1 qb_game on every team-game (%d)' % (S, len(m)),
            len(m) >= 0.99 * len(qs) and bool((m.qb_id == m.espn_id).all()) and bool(n_start.eq(1).all()),
            {'stage1': len(qs), 'matched': len(m), 'agree': float((m.qb_id == m.espn_id).mean())})
    P = U.player_games(2025)
    chk('usage: non-QB starts are never fabricated (only usage-leader flags exist)',
        not any(c for c in P.columns if c.endswith('_starter') and c != 'qb_starter')
        and {'usage_leader_rush', 'usage_top3_target', 'usage_leader_dropback'} <= set(P.columns))


# ================================================================ roles
def t_roles():
    cal = ST.calibration(2025)
    th = cal['roles']
    chk('roles: thresholds estimated for QB RB WR TE with 0 < t_rot < t_full <= 1',
        set(ST.ROLE_FAMILIES) <= set(th) and all(0 < th[f]['t_rot'] < th[f]['t_full'] <= 1 for f in ST.ROLE_FAMILIES), th)
    base = {'share_ew': np.nan, 'rank': np.nan, 'recent_n': 0.0, 'recent_games_used': 0.0, 'team_games_recent': 3.0,
            'team_games': 6.0, 'season_n': 0.0}
    rows = [
        dict(base, family='WR', share_ew=0.5, rank=1, recent_n=1, recent_games_used=1, team_games_recent=1,
             team_games=1, season_n=1),                                    # targeted once
        dict(base, family='WR', share_ew=0.30, rank=1, recent_n=2, recent_games_used=1, season_n=2),  # 2 looks
        dict(base, family='WR', share_ew=0.22, rank=1, recent_n=25, recent_games_used=3, season_n=50),
        dict(base, family='QB', share_ew=0.60, rank=1, recent_n=80, recent_games_used=3, season_n=150),
        dict(base, family='QB', share_ew=0.99, rank=1, recent_n=4, recent_games_used=1, season_n=4),   # 4 dropbacks
        dict(base, family='RB', share_ew=0.0, rank=4, season_n=0.0),
        dict(base, family='OG'), dict(base, family='LB'), dict(base, family='LS'),
    ]
    role, basis = ST.assign_roles(pd.DataFrame(rows), th)
    starters = ('FULL-TIME STARTER', 'ROTATIONAL STARTER')
    chk('roles: a low-usage player targeted once (50% of a 2-target game) is not a starter', role[0] not in starters, role[0])
    chk('roles: a high share on 2 targets is not a starter', role[1] not in starters, role[1])
    chk('roles: a WR1 with 25 recent targets and a 22% share is a FULL-TIME STARTER', role[2] == 'FULL-TIME STARTER', role[2])
    chk('roles: a QB with 60% of dropbacks and evidence is a ROTATIONAL STARTER', role[3] == 'ROTATIONAL STARTER', role[3])
    chk('roles: a QB with 4 dropbacks is not a starter, whatever his share', role[4] not in starters, role[4])
    chk('roles: no usage all season on a team with games -> DEEP RESERVE', role[5] == 'DEEP RESERVE', role[5])
    chk('roles: OL and defenders are UNKNOWN (no participation data); LS a position-only SPECIALIST',
        role[6] == 'UNKNOWN' and role[7] == 'UNKNOWN' and role[8] == 'SPECIALIST', list(role[6:]))
    S = REG.get('state_mid')
    if S is not None:
        st = S[S.role.isin(starters)]
        low = st[st.apply(lambda r: r.recent_usage_count < ST.MIN_RECENT_EVENTS.get(r.position_family, 0), axis=1)]
        chk('roles (state 2025-10-14): no starter lacks the recent-volume evidence', len(low) == 0, low.head(3).to_dict('records'))
        ol = S[S.position_family.isin(POS.OL_FAMILIES)]
        chk('roles (state): every OL row is UNKNOWN, no OL depth rank', bool(ol.role.eq('UNKNOWN').all())
            and bool(ol.depth_rank.isna().all()))


# ====================================================== starter probability
def t_starter_prob():
    S = REG.get('state_mid')
    if S is not None:
        sp = S.starter_probability.dropna()
        chk('starter probability: in [0, 1]', bool(sp.between(0, 1).all()) and len(sp) > 0)
        qs = S[S.position_family.eq('QB')].groupby('team_id').starter_probability.sum()
        chk('starter probability: a team\'s QBs sum to at most 1', bool((qs <= 1 + 1e-9).all()), float(qs.max()))
        chk('starter probability: named by basis (QB history vs usage-leader for the rest)',
            set(S.starter_probability_basis.dropna()) <= {'qb_start_history', 'qb_start_history_week1',
                                                          'usage_leader_next_game'}
            and set(S[S.position_family.eq('QB') & S.starter_probability.notna()].starter_probability_basis)
            <= {'qb_start_history', 'qb_start_history_week1'})
    train = list(range(2016, 2024))
    C.assert_dev_only(train)
    rt = ST.reliability_table(train, 2024)
    REG['rel'] = rt
    g = rt['groups']
    for name, tol in (('QB_in_season', 0.03), ('RB', 0.03), ('WR', 0.03), ('TE', 0.03), ('K_P', 0.03)):
        v = g.get(name)
        chk('starter probability: calibrated on held-out 2024 for %s (ECE %.4f < %.2f, Brier below base rate)'
            % (name, v['ece'] if v else -1, tol), v is not None and v['ece'] < tol and v['brier'] < v['brier_base'],
            v and {k: v[k] for k in ('n', 'ece', 'brier', 'brier_base')})
    v = g.get('QB_in_season')
    top = [r for r in (v or {}).get('table', []) if r['bin'] == '0.9-1.0']
    chk('starter probability: the 0.9-1.0 bin of QB last starters starts ~90%+ of next games',
        bool(top) and abs(top[0]['mean_pred'] - top[0]['observed']) < 0.03, top)


# ========================================================= availability
def t_availability():
    T = U.to_ts('2026-09-22T12:00:00Z')
    k = U.kickoffs(2026)
    P = U.player_games(2026, T)
    busy = P.groupby('team_id').espn_id.nunique()
    nxt = k[(k.kickoff_ts >= T) & k.home_id.isin(list(busy[busy >= 10].index))]
    nxt = nxt.sort_values(['kickoff_ts', 'game_id']).iloc[0]
    team, gid = int(nxt.home_id), int(nxt.game_id)
    pl = P[P.team_id.eq(team)].sort_values(['dropbacks', 'rush_att', 'espn_id'], ascending=False).espn_id.unique()
    chk('availability: a team with usage and an upcoming game exists for the synthetic reports', len(pl) >= 3)
    if len(pl) < 3:
        return
    x, y, z = int(pl[0]), int(pl[1]), int(pl[2])
    before = {'game_id': str(gid), 'team_id': team, 'published_at': ids.ts(T - pd.Timedelta(hours=1)),
              'retrieved_at': ids.ts(T - pd.Timedelta(minutes=30)), 'ok': True, 'comprehensive': False,
              'platform': 'conference', 'source_url': 'test://before', '_file': 'a.json',
              'rows': [{'player_id': str(x), 'status': 'OUT'}, {'player_id': str(z), 'status': 'GAME_TIME_DECISION'}]}
    after = {'game_id': str(gid), 'team_id': team, 'published_at': ids.ts(T + pd.Timedelta(hours=1)),
             'retrieved_at': ids.ts(T + pd.Timedelta(hours=2)), 'ok': True, 'comprehensive': True,
             'platform': 'conference', 'source_url': 'test://after', '_file': 'b.json',
             'rows': [{'player_id': str(y), 'status': 'OUT'}, {'player_id': str(x), 'status': 'AVAILABLE'}]}
    S = ST.player_week_state(2026, T, availability=[before, after])
    r = S.set_index('espn_id')
    chk('availability: a report published before T applies (OUT -> play probability 0, tier and age recorded)',
        r.loc[x, 'availability_status'] == 'OUT' and r.loc[x, 'expected_availability'] == 0.0
        and r.loc[x, 'availability_source_tier'] == 1 and abs(r.loc[x, 'availability_status_age_hours'] - 1.0) < 1e-9,
        r.loc[x, ['availability_status', 'expected_availability', 'availability_status_age_hours']].to_dict())
    chk('availability: a report published after T is ignored (its OUT and its AVAILABLE both unseen)',
        r.loc[y, 'availability_status'] == 'UNKNOWN' and pd.isna(r.loc[y, 'expected_availability'])
        and r.loc[x, 'availability_status'] == 'OUT',
        r.loc[y, ['availability_status', 'expected_availability', 'availability_basis']].to_dict())
    chk('availability: GAME_TIME_DECISION maps to 0.5',
        r.loc[z, 'availability_status'] == 'GAME TIME DECISION' and r.loc[z, 'play_probability'] == 0.5)
    S0 = ST.player_week_state(2026, T, availability=[])
    chk('availability: no report -> UNKNOWN, never 1.0',
        bool(S0.availability_status.eq('UNKNOWN').all()) and bool(S0.expected_availability.isna().all()))
    # the real reports: at a time before any was published, none is knowledge
    reps = ST.load_reports(2026)
    first = min(ST._known_time(r_) for r_ in reps if ST._known_time(r_) is not None)
    pp, pt = ST.availability_state(2026, first - pd.Timedelta(seconds=1), {}, {}, reports=reps)
    pp2, pt2 = ST.availability_state(2026, U.to_ts('2026-09-27T00:00:00Z'), {}, {}, reports=reps)
    chk('availability: the repository reports are unseen before their publication and seen after',
        not pp and not pt and len(pt2) > 0, {'teams_after': len(pt2)})
    chk('availability: OUT_FIRST_HALF plays half a game (expected availability 0.5)',
        ST.PLAY_PROBABILITY[ST._status_key('OUT_FIRST_HALF')] * ST.GAME_FRACTION[ST._status_key('OUT_FIRST_HALF')] == 0.5)


# ========================================================== determinism
def t_determinism():
    a1, t1 = U._build_full(2024)
    a2, t2 = U._build_full(2024)
    chk('determinism: the player-game build is byte-identical twice',
        a1.equals(a2) and t1.equals(t2) and ids.content_hash(a1.player_game_id.tolist()) ==
        ids.content_hash(a2.player_game_id.tolist()))
    I._MEM.clear()
    p1, al1, tr1 = I.build_players([2025])
    I._MEM.clear()
    p2, al2, tr2 = I.build_players([2025])
    chk('determinism: the registry build is identical twice', p1.equals(p2) and al1.equals(al2) and tr1.equals(tr2))
    s1 = ST.player_week_state(2025, T_MID, availability=[])
    s2 = ST.player_week_state(2025, T_MID, availability=[])
    chk('determinism: player_week_state twice -> identical ids and content hashes',
        list(s1.player_week_state_id) == list(s2.player_week_state_id) and list(s1.content_hash) == list(s2.content_hash))
    chk('determinism: row ids are unique', bool(s1.player_week_state_id.is_unique))
    d1 = ST.depth_chart_state(2025, T_MID, state=s1)
    d2 = ST.depth_chart_state(2025, T_MID, state=s2)
    chk('depth chart: deterministic, usage-derived, one row per team x family',
        d1.equals(d2) and set(d1.source) == {'usage_derived'}
        and not d1.duplicated(['team_id', 'position_family']).any())
    ol = d1[d1.position_family.isin(POS.OL_FAMILIES)]
    chk('depth chart: OL is listed unordered with confidence NONE', bool(ol.ordering.eq('none').all())
        and bool(ol.confidence_label.eq('NONE').all()))
    chk('state: value fields are named null placeholders',
        bool(s1.player_value_mean.isna().all()) and bool(s1.replacement_value.isna().all())
        and s1.value_status.str.startswith('NOT_MODELLED').all())


if __name__ == '__main__':
    for fn in (t_positions, t_contaminants, t_identity, t_resolve, t_usage_T, t_shares, t_starters, t_roles,
               t_starter_prob, t_availability, t_determinism):
        section(fn)
    done()
