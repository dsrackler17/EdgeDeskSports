"""Scheme continuity and style change-points (docs/cfb-matchup/METHODS.md section 8; brief 24-25, 39, 63).

What the data support:
  * coordinator continuity: a PRESEASON flag per team-season (cfb_matchup_line oc_cont / dc_cont,
    2015+). There are no coordinator names, so a coordinator cannot be followed to a new school,
    and there is no mid-season play-caller change feed. Head coaches ARE named (home_head_coach),
    so a head coach's tendencies can be followed across schools.
  * persistence study (dev seasons): year-to-year correlation of each style metric's data-only
    final rating, by coordinator continuity / head-coach change; and, for head coaches who moved,
    whether the NEW team's style is closer to the coach's old team or to the new team's own past.
  * in-season change-points: per team-season, the opponent-adjusted game-level style value
    x_g = observed rate - (league mean + opponent's defensive response rating at that freeze).
    After each game, the mean of the last L games is compared with the mean of the earlier games
    of the season (z statistic with each game's sampling variance from the variance components).
    The threshold is CALIBRATED on the development seasons by permuting game order within
    team-seasons (the no-change null) so that at most 5% of team-seasons ever alarm per metric:
    random weekly variation does not create events.
Events: RUN_PASS_SHIFT (proe), PACE_REGIME_CHANGE (tempo), QB_USAGE_SHIFT (qb_rush_rate),
PRESSURE_SHIFT (defensive sack generation), COORDINATOR_CHANGE_OFF / _DEF (preseason flag).
"""
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from . import style as ST
from . import CHANGE_RULE_VERSION

L_WINDOW = 3               # recent games in the change window
MIN_BEFORE = 3             # games before the window
FALSE_ALARM = 0.05         # per team-season, per metric, under the permutation null
N_PERM = 200
EVENT_METRICS = {'proe': 'RUN_PASS_SHIFT', 'tempo': 'PACE_REGIME_CHANGE', 'qb_rush_rate': 'QB_USAGE_SHIFT',
                 'sack_gen': 'PRESSURE_SHIFT'}


# ------------------------------------------------------------- continuity
def continuity_table():
    md = common.data_path('mline')
    rows = []
    for f in sorted(os.listdir(md)):
        d = pd.read_parquet(os.path.join(md, f), columns=['season', 'home_team_id', 'away_team_id', 'home_head_coach',
                                                         'away_head_coach', 'home_hc_tenure', 'away_hc_tenure',
                                                         'home_oc_cont', 'away_oc_cont', 'home_dc_cont', 'away_dc_cont'])
        for s in ('home', 'away'):
            x = d[['season', s + '_team_id', s + '_head_coach', s + '_hc_tenure', s + '_oc_cont', s + '_dc_cont']]
            x.columns = ['season', 'team_id', 'head_coach', 'hc_tenure', 'oc_cont', 'dc_cont']
            rows.append(x)
    T = pd.concat(rows).dropna(subset=['team_id']).drop_duplicates(['season', 'team_id'])
    T['team_id'] = T.team_id.astype('int64')
    T['season'] = T.season.astype(int)
    return T.reset_index(drop=True)


def persistence_study(seasons=None, n_boot=1000):
    """Year-to-year persistence of style (data-only finals, FBS offenses/defenses), by continuity."""
    seasons = seasons or [s for s in C.DEV_SEASONS if s >= 2016]
    C.assert_dev_only(seasons)
    fd = ST.finals()
    CT = continuity_table()
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['season', 'home_id', 'home_fbs'])
    fbs = {S: set(g.loc[g.home_fbs, 'home_id']) for S, g in G.groupby('season')}
    rng = np.random.default_rng(C.SEED)
    out = {}
    for m in ST.METRIC_NAMES:
        f = fd[fd.metric.eq(m)]
        res = {}
        for side, flag in (('off', 'oc_cont'), ('def', 'dc_cont')):
            rows = []
            for S in seasons:
                a = f[f.season.eq(S)].set_index('team_id')[side]
                b = f[f.season.eq(S - 1)].set_index('team_id')[side]
                ct = CT[CT.season.eq(S)].set_index('team_id')
                t = sorted(set(a.index) & set(b.index) & fbs.get(S, set()) & set(ct.index))
                for tm in t:
                    rows.append((S, tm, a[tm], b[tm], ct.loc[tm, flag], float(ct.loc[tm, 'hc_tenure'] == 0)))
            R = pd.DataFrame(rows, columns=['season', 'team_id', 'y', 'lag', 'cont', 'hc_new'])
            if len(R) < 50:
                continue
            # season-demeaned so league drift does not look like persistence
            R['y'] = R.y - R.groupby('season').y.transform('mean')
            R['lag'] = R.lag - R.groupby('season').lag.transform('mean')

            def corr(x):
                return float(np.corrcoef(x.y, x.lag)[0, 1]) if len(x) > 10 else np.nan
            groups = {'all': R, 'coordinator_kept': R[R.cont.eq(1) & R.hc_new.eq(0)],
                      'coordinator_changed': R[R.cont.eq(0) & R.hc_new.eq(0)], 'head_coach_new': R[R.hc_new.eq(1)]}
            r = {k: {'n': int(len(v)), 'r': corr(v)} for k, v in groups.items()}
            kept, chg = groups['coordinator_kept'], groups['coordinator_changed']
            bs = []
            for _ in range(n_boot):
                i = rng.integers(0, len(kept), len(kept)); j = rng.integers(0, len(chg), len(chg))
                bs.append(corr(kept.iloc[i]) - corr(chg.iloc[j]))
            r['kept_minus_changed'] = {'diff': r['coordinator_kept']['r'] - r['coordinator_changed']['r'],
                                       'ci95': [float(x) for x in np.nanquantile(bs, [0.025, 0.975])]}
            res[side] = r
        out[m] = res
    return out


def head_coach_moves(seasons=None):
    """Head coaches who changed FBS schools: is the new team's first-season style (data-only final)
    closer to the coach's previous team's last season, or to the new team's own last season?"""
    seasons = seasons or [s for s in C.DEV_SEASONS if s >= 2016]
    C.assert_dev_only(seasons)
    CT = continuity_table()
    fd = ST.finals()
    out = {}
    for m in ('proe', 'tempo', 'qb_rush_rate', 'go_oe', 'ed_proe'):
        f = fd[fd.metric.eq(m)]
        rows = []
        for S in seasons:
            cur, prv = CT[CT.season.eq(S)], CT[CT.season.eq(S - 1)]
            pmap = prv.dropna(subset=['head_coach']).set_index('head_coach').team_id
            for _, r in cur[cur.hc_tenure.eq(0)].dropna(subset=['head_coach']).iterrows():
                old = pmap.get(r.head_coach)
                if old is None or isinstance(old, pd.Series) or int(old) == int(r.team_id):
                    continue
                a = f[f.season.eq(S)].set_index('team_id').off
                b = f[f.season.eq(S - 1)].set_index('team_id').off
                if r.team_id in a and r.team_id in b and old in b:
                    rows.append((S, r.head_coach, a[r.team_id], b[r.team_id], b[old]))
        R = pd.DataFrame(rows, columns=['season', 'coach', 'new', 'team_last', 'coach_old_team_last'])
        if len(R) < 10:
            out[m] = {'n': int(len(R))}
            continue
        X = np.column_stack([np.ones(len(R)), R.team_last, R.coach_old_team_last])
        beta = np.linalg.lstsq(X, R.new.values, rcond=None)[0]
        out[m] = {'n': int(len(R)), 'corr_with_team_last': float(np.corrcoef(R.new, R.team_last)[0, 1]),
                  'corr_with_coach_old_team': float(np.corrcoef(R.new, R.coach_old_team_last)[0, 1]),
                  'joint_coef_team_last': float(beta[1]), 'joint_coef_coach_old_team': float(beta[2])}
    return out


# ----------------------------------------------------------- change-points
def game_series(S):
    """Opponent-adjusted game-level style values per team-game of season S (offense metrics plus
    defensive sack generation), with each game's sampling variance."""
    TG = ST.team_games(S)
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    g = G[G.season.eq(S) & G.status.eq('FINAL')][['game_id', 'kickoff_ts', 'prediction_ts', 'home_fbs', 'away_fbs',
                                                     'home_id', 'away_id']]
    TG = TG.merge(g, on='game_id')
    Rt = ST.ratings(S)
    Lg = ST.league(S)
    vc = {k: tuple(v) for k, v in __import__('json').load(open(ST.style_dir('varcomp.json'))).items()}
    rows = []
    for m in ('proe', 'tempo', 'qb_rush_rate'):
        num, den = [(n, d) for mm, n, d, _ in ST.STYLE_METRICS if mm == m][0]
        dd = Rt[Rt.metric.eq(m)].set_index(['prediction_ts', 'team_id'])['def']
        mu = Lg[Lg.metric.eq(m)].set_index('prediction_ts').mu
        x = TG[[c for c in ('game_id', 'team_id', 'opp_id', 'kickoff_ts', 'prediction_ts', num, den)]].copy()
        x = x[x[den] > 0]
        x['val'] = x[num] / x[den]
        opp_d = dd.reindex(pd.MultiIndex.from_arrays([x.prediction_ts, x.opp_id])).values
        x['exp_opp'] = mu.reindex(x.prediction_ts).values + np.nan_to_num(opp_d)
        x['x'] = x.val - np.where(np.isnan(x.exp_opp), np.nanmean(x.val), x.exp_opp)
        s2p, s2g = vc[m]
        x['v'] = s2p / x[den] + s2g
        x['metric'] = m
        rows.append(x[['game_id', 'team_id', 'kickoff_ts', 'metric', 'val', 'x', 'v']])
    # defensive sack generation: opponent sacks per dropback (V2 stage 1 team-game sums)
    T1 = pd.read_parquet(common.out_path('stage1', 'team_game_%d.parquet' % S), columns=['game_id', 'team_id', 'opp_id',
                                                                                        'sacks', 'n_db'])
    T1 = T1.merge(g[['game_id', 'kickoff_ts']], on='game_id')
    T1 = T1[T1.n_db > 5]
    sg = pd.DataFrame({'game_id': T1.game_id, 'team_id': T1.opp_id.astype('int64'), 'kickoff_ts': T1.kickoff_ts,
                       'metric': 'sack_gen', 'val': T1.sacks / T1.n_db})
    lg = sg.val.mean()
    sg['x'] = sg.val - lg
    sg['v'] = lg * (1 - lg) / T1.n_db.values + 1e-4
    rows.append(sg)
    return pd.concat(rows, ignore_index=True).sort_values(['team_id', 'metric', 'kickoff_ts']).reset_index(drop=True)


def scan(xs, vs):
    """Max z over split points k (after each game): mean(last L) vs mean(before)."""
    n = len(xs)
    zs = []
    for k in range(MIN_BEFORE + L_WINDOW, n + 1):
        a, va = xs[k - L_WINDOW:k], vs[k - L_WINDOW:k]
        b, vb = xs[:k - L_WINDOW], vs[:k - L_WINDOW]
        wa, wb = 1 / va, 1 / vb
        ma, mb = np.sum(wa * a) / np.sum(wa), np.sum(wb * b) / np.sum(wb)
        z = (ma - mb) / np.sqrt(1 / np.sum(wa) + 1 / np.sum(wb))
        zs.append((k, z))
    return zs


def calibrate(seasons=None, n_perm=N_PERM):
    """Per-metric |z| threshold: the (1 - FALSE_ALARM) quantile of the max |z| per team-season when
    game order is permuted (no change under the null). Development seasons only."""
    seasons = seasons or [s for s in C.DEV_SEASONS]
    C.assert_dev_only(seasons)
    rng = np.random.default_rng(C.SEED)
    mx = {m: [] for m in EVENT_METRICS}
    for S in seasons:
        Z = game_series(S)
        for (t, m), g in Z.groupby(['team_id', 'metric']):
            if len(g) < MIN_BEFORE + L_WINDOW:
                continue
            xs, vs = g.x.values, g.v.values
            for _ in range(max(1, n_perm // 20)):
                p = rng.permutation(len(xs))
                zz = scan(xs[p], vs[p])
                if zz:
                    mx[m].append(max(abs(z) for _, z in zz))
    return {m: float(np.quantile(v, 1 - FALSE_ALARM)) for m, v in mx.items() if v}


def events(S, thresholds):
    """Style change events of season S, each dated at the first freeze after the triggering game."""
    Z = game_series(S)
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['season', 'prediction_ts'])
    freezes = pd.Series(sorted(pd.to_datetime(G[G.season.eq(S)].prediction_ts.unique(), utc=True)))
    out = []
    for (t, m), g in Z.groupby(['team_id', 'metric']):
        if len(g) < MIN_BEFORE + L_WINDOW or m not in thresholds:
            continue
        zz = scan(g.x.values, g.v.values)
        for k, z in zz:
            if abs(z) >= thresholds[m]:
                ko = pd.Timestamp(g.kickoff_ts.iloc[k - 1])
                ko = ko.tz_localize('UTC') if ko.tzinfo is None else ko
                nxt = freezes[freezes > ko]
                out.append({'season': S, 'team_id': int(t), 'metric': m, 'event_type': EVENT_METRICS[m],
                            'trigger_game_id': int(g.game_id.values[k - 1]), 'trigger_kickoff_ts': pd.Timestamp(ko),
                            'detected_at': pd.Timestamp(nxt.iloc[0]) if len(nxt) else None, 'z': float(z),
                            'threshold': thresholds[m], 'games_before': int(k - L_WINDOW),
                            'shift': float(np.mean(g.x.values[k - L_WINDOW:k]) - np.mean(g.x.values[:k - L_WINDOW])),
                            'rule_version': CHANGE_RULE_VERSION})
                break                  # one event per team-season-metric (the first crossing)
    return pd.DataFrame(out)


def validate_events(seasons, thresholds, n_boot=1000):
    """After an event, does the post-change mean (last L games, shrunk half-way to the season mean)
    predict the NEXT 3 games' opponent-adjusted style better than the season-to-date mean?
    Per metric, and pooled in units of each metric's game-level SD (dev seasons)."""
    C.assert_dev_only(seasons)
    per = {m: {'es': [], 'er': [], 'n': 0} for m in EVENT_METRICS}
    sd = {}
    for S in seasons:
        Z = game_series(S)
        for m, g in Z.groupby('metric'):
            sd.setdefault(m, []).append(float(g.x.std()))
        E = events(S, thresholds)
        for _, e in E.iterrows():
            g = Z[Z.team_id.eq(e.team_id) & Z.metric.eq(e.metric)].reset_index(drop=True)
            k = int(g.index[g.game_id.eq(e.trigger_game_id)][0]) + 1
            nxt = g.iloc[k:k + 3]
            if nxt.empty:
                continue
            m_season = g.x.values[:k].mean()
            m_recent = 0.5 * g.x.values[k - L_WINDOW:k].mean() + 0.5 * m_season
            per[e.metric]['es'].extend(np.abs(nxt.x.values - m_season))
            per[e.metric]['er'].extend(np.abs(nxt.x.values - m_recent))
            per[e.metric]['n'] += 1
    rng = np.random.default_rng(C.SEED)
    out, pooled = {}, []
    for m, v in per.items():
        es, er = np.array(v['es']), np.array(v['er'])
        if len(es) < 10:
            out[m] = {'events': v['n'], 'next_game_obs': int(len(es))}
            continue
        d = er - es
        bs = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(n_boot)]
        out[m] = {'events': v['n'], 'next_game_obs': int(len(d)), 'mae_season_mean': float(es.mean()),
                  'mae_recent_weighted': float(er.mean()), 'delta': float(d.mean()),
                  'delta_ci95': [float(x) for x in np.quantile(bs, [0.025, 0.975])]}
        pooled.append(d / np.mean(sd[m]))
    if pooled:
        d = np.concatenate(pooled)
        bs = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(n_boot)]
        out['pooled_in_sd_units'] = {'n': int(len(d)), 'delta': float(d.mean()),
                                     'delta_ci95': [float(x) for x in np.quantile(bs, [0.025, 0.975])]}
    return out
