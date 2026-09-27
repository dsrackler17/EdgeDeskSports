"""Player value at an instant T: points per game above replacement (PVAR), with an SD.

    rule 'cfb_personnel_values_v1'

    constants()                      every estimated constant (dev seasons 2016-2023 only), cached
    values_for(season, requests)     posterior value per (player, team, T, component) for arbitrary requests
    player_values(season, T)         one row per player with a value at T (the PVAR table)
    fill_state(state, season, T)     writes player_value_mean / _sd / replacement_value / value_model
                                     into a player_week_state frame (the foundation's null placeholders)

What a value is (docs/cfb-personnel/UNITS.md section 1):

  COMPONENTS (per usage event or per team game)          value per game above replacement
  RB_rush   non-garbage EPA per carry                    (rate - repl) x expected carries per game
  WR_rec    non-garbage EPA per target                   (rate - repl) x expected targets per game
  TE_rec    non-garbage EPA per target                   (rate - repl) x expected targets per game
  FRONT_sack  sacks per team game (production)           V_sack x (rate - repl)          [def_sacks RELIABLE]
  SEC_int   interceptions per team game (production)     V_int  x (rate - repl)          [def_ints RELIABLE]
  SEC_pbu   break-ups per team game (production)         V_pbu  x (rate - repl)          [def_pbu RELIABLE]
  K_fg      FG points over the expected make (by distance) per attempt, x attempts per game
  K_xp      XP points over the league make rate per attempt, x attempts per game
  P_net     net punt yards per punt, x EP per yard x punts per game
  OL        NO value: no player data exists (UNITS.md; units.py carries an uncertainty-only OL row)

Model for every component (a normal-normal model, the conjugate form of the spec's shrinkage):
  per-exposure observations x ~ N(theta, sigma2 / n);   a player first seen: theta ~ N(repl, tau2)
  => posterior mean = (n xbar + k repl) / (n + k),  k = sigma2 / tau2  (from split-half reliability)
  between seasons theta regresses to the population mean mu with persistence rho (Kalman step):
      m' = mu + rho (m - mu),  v' = rho^2 v + tau2 (1 - rho^2)
  rho = rho_stay on the same team, rho_transfer across a team change (the transfer translation).
Efficiency components are CENTRED by the family's league mean per event of their own season (at T:
the season to date, pseudo-count blended with last season), so seasons with different receiver-id
coverage are comparable; the replacement level is a centred level.

Point in time: seasons before T's season contribute complete seasons; T's season contributes games
that kicked off strictly before T. Estimated constants come from the dev seasons 2016-2023 only
(config.assert_dev_only); the holdout and live seasons are never read by an estimator.
Pure model only: no market column is read anywhere in this module.
"""
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from . import identity as I
from . import positions as POS
from . import usage as U

RULE = 'cfb_personnel_values_v1'
CONST_VERSION = 'personnel_values_const_v4'
DEV = tuple(C.DEV_SEASONS)
N_BOOT = 1000

# ------------------------------------------------------------ components
# kind: 'eff'  per-event efficiency (exposure = usage events; total = EPA or points)
#       'rate' production per team game (exposure = team games from the player's first
#              recorded event for the team to T -- participation is not observed)
COMPONENTS = {
    'RB_rush': dict(kind='eff', families=('RB',), exposure='rush_att_ng', total='rush_epa_ng', center=True,
                    unit='RB', slots=1, min_exp=5, rel_col=None),
    'WR_rec': dict(kind='eff', families=('WR',), exposure='targets_ng', total='rec_epa_ng', center=True,
                   unit='WR_TE', slots=3, min_exp=5, rel_col=None),
    'TE_rec': dict(kind='eff', families=('TE',), exposure='targets_ng', total='rec_epa_ng', center=True,
                   unit='WR_TE', slots=1, min_exp=5, rel_col=None),
    'FRONT_sack': dict(kind='rate', families=POS.FRONT7_FAMILIES, exposure='team_games', total='def_sacks',
                       center=False, unit='FRONT7', slots=4, min_exp=3, rel_col='def_sacks'),
    'SEC_int': dict(kind='rate', families=POS.SECONDARY_FAMILIES, exposure='team_games', total='def_ints',
                    center=False, unit='SECONDARY', slots=4, min_exp=3, rel_col='def_ints'),
    'SEC_pbu': dict(kind='rate', families=POS.SECONDARY_FAMILIES, exposure='team_games', total='def_pbu',
                    center=False, unit='SECONDARY', slots=4, min_exp=3, rel_col='def_pbu'),
    'K_fg': dict(kind='eff', families=('K',), exposure='fg_att', total='fg_poe', center=False,
                 unit='ST', slots=1, min_exp=3, rel_col=None),
    'K_xp': dict(kind='eff', families=('K',), exposure='xp_att', total='xp_oe', center=False,
                 unit='ST', slots=1, min_exp=5, rel_col=None),
    'P_net': dict(kind='eff', families=None, exposure='punts', total='punt_net_yds', center=True,
                  unit='ST', slots=1, min_exp=5, rel_col=None),
}
SKILL_COMPONENTS = ('RB_rush', 'WR_rec', 'TE_rec')
DEF_COMPONENTS = ('FRONT_sack', 'SEC_int', 'SEC_pbu')
ST_COMPONENTS = ('K_fg', 'K_xp', 'P_net')
FAMILY_COMPONENTS = {'RB': ('RB_rush',), 'WR': ('WR_rec',), 'TE': ('TE_rec',), 'K': ('K_fg', 'K_xp'),
                     'P': ('P_net',)}
for _f in POS.FRONT7_FAMILIES:
    FAMILY_COMPONENTS[_f] = ('FRONT_sack',)
for _f in POS.SECONDARY_FAMILIES:
    FAMILY_COMPONENTS[_f] = ('SEC_int', 'SEC_pbu')

# the league mean of a centred component at T: season-to-date events blended with last
# season's full mean by LM_PSEUDO pseudo-events (declared), so week 1 is well defined
LM_PSEUDO = 2000.0
# low-usage (replacement) player-seasons: outside the family's usage slots at the team-season
# (rank > slots by exposure, i.e. the backups who take the snaps) with at least min_exp events;
# K / P: every kicker / punter who was not the team-season's primary one
SPLIT_REPORT_MIN = {'RB_rush': 40, 'WR_rec': 20, 'TE_rec': 15, 'FRONT_sack': 5, 'SEC_int': 5, 'SEC_pbu': 5,
                    'K_fg': 6, 'K_xp': 15, 'P_net': 15}

_MEM = {}


def _cache_dir():
    d = os.path.dirname(common.out_path('personnel', 'cache', 'x'))
    os.makedirs(d, exist_ok=True)
    return d


def _src_sig(seasons):
    return ids.h(CONST_VERSION, U.CODE_VERSION, *[U._cache_key(s) for s in seasons])


# ====================================================== families (point in time)
def family_map(season, usage_rows=None):
    """espn_id -> family for `season`: roster labels (season S and earlier listings, never later),
    else observed usage in `usage_rows` (the caller restricts them to what is known).
    Defaults to last season's usage, which is complete before `season` starts."""
    key = ('fam', int(season), None if usage_rows is not None else 'prev')
    if usage_rows is None and key in _MEM:
        return _MEM[key]
    if usage_rows is None and season - 1 >= C.FIRST_PBP_SEASON:
        usage_rows = U.player_games(season - 1)
    pl = I.position_lookup(season, usage_rows=usage_rows)
    out = dict(zip(pl.espn_id.astype('int64'), pl.family))
    if key[2] == 'prev':
        _MEM[key] = out
    return out


def infer_family(dropbacks, rushes, targets):
    """Vectorised positions.usage_family: QB / RB / WR when one kind is >= 70% of >= 10 events."""
    db, ru, tg = (np.asarray(x, dtype=float) for x in (dropbacks, rushes, targets))
    n = db + ru + tg
    out = np.array(['UNKNOWN'] * len(n), dtype=object)
    ok = n >= POS.USAGE_MIN_EVENTS
    with np.errstate(invalid='ignore', divide='ignore'):
        for fam, v in (('QB', db), ('RB', ru), ('WR', tg)):
            m = ok & (v / np.where(n > 0, n, 1.0) >= POS.USAGE_DOMINANCE) & (out == 'UNKNOWN')
            out[m] = fam
    return out


# ============================================================ special-teams inputs
def fg_attempts(season):
    """One row per field-goal attempt (live, id-carrying kicker): game_id, team_id, espn_id,
    kickoff_ts, dist, made. The same play filters as usage.py (all-star games, text duplicates,
    no-play penalties). Cached under <OUT>/personnel/cache."""
    key = ('fga', int(season), U._cache_key(season))
    if key in _MEM:
        return _MEM[key]
    f = os.path.join(_cache_dir(), 'fg_attempts_%d.parquet' % season)
    fm = f.replace('.parquet', '.json')
    try:
        if json.load(open(fm)).get('key') == '|'.join(map(str, key)) + CONST_VERSION:
            d = pd.read_parquet(f)
            _MEM[key] = d
            return d
    except (OSError, ValueError):
        pass
    import pyarrow.parquet as pq
    from .. import plays as P
    cols = ['game_id', 'seasonType', 'pos_team_id', 'def_pos_team_id', 'homeTeamId', 'awayTeamId', 'text_dupe',
            'penalty_no_play', 'fg_attempt', 'fg_made', 'yds_fg', 'fg_kicker_player_id', 'fg_team']
    names = set(pq.ParquetFile(U.pbp_file(season)).schema_arrow.names)
    use = [c for c in cols if c in names]
    assert not (set(use) & set(P.FORBIDDEN_PBP_COLUMNS))
    d = pd.read_parquet(U.pbp_file(season), columns=use)
    for c in cols:
        if c not in d.columns:
            d[c] = np.nan
    d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna() & ~U._b(d.text_dupe)]
    teams = pd.concat([U._num(d.pos_team_id), U._num(d.def_pos_team_id), U._num(d.homeTeamId),
                       U._num(d.awayTeamId)], axis=1)
    bad = U._num(d.seasonType).eq(U.OFFSEASON_SEASON_TYPE) | teams.isin(list(U.ALL_STAR_TEAM_IDS)).any(axis=1)
    d = d[~d.game_id.isin(set(d.loc[bad, 'game_id']))]
    d = d[~U._b(d.penalty_no_play) & U._b(d.fg_attempt) & U.valid_id(d.fg_kicker_player_id)]
    d = d[U._num(d.yds_fg).between(10, 75)]
    team = U._num(d.fg_team).where(U._num(d.fg_team).notna(), U._num(d.pos_team_id))
    k = U.kickoffs(season).set_index('game_id').kickoff_ts
    out = pd.DataFrame({'game_id': d.game_id.astype('int64').values, 'team_id': team.astype('int64').values,
                        'espn_id': U._num(d.fg_kicker_player_id).astype('int64').values,
                        'dist': U._num(d.yds_fg).astype(float).values, 'made': U._b(d.fg_made).astype(float).values})
    out['kickoff_ts'] = k.reindex(out.game_id.values).values
    out = out.sort_values(['kickoff_ts', 'game_id', 'espn_id', 'dist'], kind='mergesort').reset_index(drop=True)
    try:
        out.to_parquet(f, index=False)
        json.dump({'key': '|'.join(map(str, key)) + CONST_VERSION}, open(fm, 'w'))
    except OSError:
        pass
    _MEM[key] = out
    return out


def fg_make_prob(dist, coef):
    """Expected FG make probability by distance: logistic in (d - 40)/10 and its square."""
    z = (np.asarray(dist, dtype=float) - 40.0) / 10.0
    eta = coef[0] + coef[1] * z + coef[2] * z * z
    return 1.0 / (1.0 + np.exp(-eta))


def _logit_irls(X, y, iters=50):
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-(X @ b)))
        W = p * (1 - p)
        H = X.T @ (X * W[:, None])
        g = X.T @ (y - p)
        step = np.linalg.solve(H, g)
        b = b + step
        if np.max(np.abs(step)) < 1e-10:
            break
    p = 1.0 / (1.0 + np.exp(-(X @ b)))
    cov = np.linalg.inv(X.T @ (X * (p * (1 - p))[:, None]))
    return b, cov


def _pbp_play_constants(seasons):
    """EP per yard of field position, and the EPA a defensive event takes away (dev seasons):
      ep_per_yard  = -slope of EP_start on yards to the end zone, 1st-and-10 between the 20s
      V_sack = mean EPA of a non-sack dropback - mean EPA of a sack
      V_int  = mean EPA of a pass attempt without an interception - mean EPA with one
      V_pbu  = mean EPA of a pass attempt without a break-up - mean EPA with one
    EP_start / EPA do not read the market (the provider's WP columns do and are never read)."""
    from .. import plays as P
    C.assert_dev_only(seasons)
    cols = ['game_id', 'pos_team_id', 'def_pos_team_id', 'text_dupe', 'penalty_no_play', 'rush', 'pass', 'sack',
            'int', 'pass_breakup', 'EPA', 'EP_start', 'down', 'distance', 'start.yardsToEndzone']
    assert not (set(cols) & set(P.FORBIDDEN_PBP_COLUMNS))
    xs, ys, acc = [], [], {k: [0.0, 0.0] for k in ('db_ns', 'db_s', 'pa_ni', 'pa_i', 'pa_nb', 'pa_b')}
    for S in seasons:
        d = pd.read_parquet(U.pbp_file(S), columns=cols)
        d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna() & ~U._b(d.text_dupe) & ~U._b(d.penalty_no_play)]
        m = U._num(d.down).eq(1) & U._num(d.distance).eq(10) & U._num(d['start.yardsToEndzone']).between(20, 80) \
            & d.EP_start.notna()
        xs.append(U._num(d.loc[m, 'start.yardsToEndzone']).values)
        ys.append(U._num(d.loc[m, 'EP_start']).values)
        sc = (U._b(d.rush) | U._b(d['pass'])) & d.EPA.notna()
        dbk = sc & U._b(d['pass'])
        sk = dbk & U._b(d.sack)
        att = dbk & ~U._b(d.sack)
        it = att & U._b(d['int'])
        pb = att & U._b(d.pass_breakup)
        e = U._num(d.EPA)
        for k, mm in (('db_ns', dbk & ~sk), ('db_s', sk), ('pa_ni', att & ~it), ('pa_i', it),
                      ('pa_nb', att & ~pb), ('pa_b', pb)):
            acc[k][0] += float(e[mm].sum())
            acc[k][1] += float(mm.sum())
    x, y = np.concatenate(xs), np.concatenate(ys)
    slope = float(np.polyfit(x, y, 1)[0])
    mean = {k: v[0] / v[1] for k, v in acc.items()}
    return {'ep_per_yard': -slope, 'ep_per_yard_n': int(len(x)),
            'V_sack': mean['db_ns'] - mean['db_s'], 'V_int': mean['pa_ni'] - mean['pa_i'],
            'V_pbu': mean['pa_nb'] - mean['pa_b'],
            'n_sacks': int(acc['db_s'][1]), 'n_ints': int(acc['pa_i'][1]), 'n_pbu': int(acc['pa_b'][1]),
            'mean_epa': mean}


# ============================================================ component rows
def _rel_ok(rel, col):
    return col is None or rel.get(col, {}).get('verdict') == 'RELIABLE'


def component_rows(season, fam=None, fg_coef=None, p_xp=None):
    """Per player x team x game rows of every component for one season (complete, or to date):
    espn_id, team_id, game_id, kickoff_ts, component, family, n (exposure), e (raw total),
    season_reliable (the defensive column's verdict over the WHOLE season; True otherwise).
    'rate' components carry a row for every team game from the player's first recorded event
    for the team through the team's last game (zeros where he recorded nothing): participation
    is unobserved, so a player is assumed present from his first appearance on.
    Family: roster labels (family_map); an unlabelled player's family is inferred from his
    usage through that game only (point in time)."""
    pg = U.player_games(season)
    tg = U.team_games(season)
    rel = U.reliability(season, tg=tg)
    fam = family_map(season) if fam is None else fam
    pg = pg.sort_values(['kickoff_ts', 'game_id', 'espn_id'], kind='mergesort')
    f = pg.espn_id.map(fam).fillna('UNKNOWN').values.astype(object)
    unk = f == 'UNKNOWN'
    if unk.any():
        cum = pg.loc[unk, ['espn_id', 'dropbacks', 'rush_att', 'targets']]
        cum = cum.groupby('espn_id')[['dropbacks', 'rush_att', 'targets']].cumsum()
        f[unk] = infer_family(cum.dropbacks, cum.rush_att, cum.targets)
    pg = pg.assign(family=f)
    base = ['espn_id', 'team_id', 'game_id', 'kickoff_ts', 'family']
    parts = []
    for comp, spec in COMPONENTS.items():
        if spec['kind'] == 'eff' and comp not in ('K_fg', 'K_xp'):
            x = pg[pg[spec['exposure']] > 0]
            if spec['families'] is not None:          # K / P: whoever kicks or punts
                x = x[x.family.isin(spec['families'])]
            if comp == 'RB_rush':
                x = x[x.dropbacks.eq(0)]
            parts.append(x[base].assign(component=comp, n=x[spec['exposure']].astype(float).values,
                                        e=x[spec['total']].astype(float).values, season_reliable=True))
        elif comp == 'K_fg':
            a = fg_attempts(season)
            if fg_coef is not None and len(a):
                a = a.assign(poe=3.0 * (a.made - fg_make_prob(a.dist, fg_coef)))
                g = a.groupby(['espn_id', 'team_id', 'game_id'], sort=True).agg(
                    n=('made', 'size'), e=('poe', 'sum'), kickoff_ts=('kickoff_ts', 'first')).reset_index()
                g['family'] = g.espn_id.map(fam).fillna('K')
                parts.append(g.assign(component=comp, season_reliable=True)[base + ['component', 'n', 'e',
                                                                                  'season_reliable']])
        elif comp == 'K_xp':
            if p_xp is not None:
                x = pg[pg.xp_att > 0]
                parts.append(x[base].assign(component=comp, n=x.xp_att.astype(float).values,
                                            e=(x.xp_made - p_xp * x.xp_att).astype(float).values,
                                            season_reliable=True))
        else:                                       # production per team game
            x = pg[pg.family.isin(spec['families']) & (pg[spec['total']] > 0)]
            if not len(x):
                continue
            first = x.groupby(['espn_id', 'team_id']).kickoff_ts.min().rename('first_ts').reset_index()
            t = tg[['game_id', 'team_id', 'kickoff_ts']]
            sp = first.merge(t, on='team_id', how='inner')
            sp = sp[sp.kickoff_ts >= sp.first_ts]
            ev = x.groupby(['espn_id', 'team_id', 'game_id'])[spec['total']].sum().rename('e').reset_index()
            sp = sp.merge(ev, on=['espn_id', 'team_id', 'game_id'], how='left')
            sp['e'] = sp.e.fillna(0.0)
            fam_row = x.groupby('espn_id').family.last()
            sp['family'] = fam_row.reindex(sp.espn_id.values).fillna('UNKNOWN').values
            parts.append(sp.assign(component=comp, n=1.0, season_reliable=_rel_ok(rel, spec['rel_col']))[
                base + ['component', 'n', 'e', 'season_reliable']])
    out = pd.concat(parts, ignore_index=True, sort=False)
    out['season'] = int(season)
    out['kickoff_ts'] = pd.to_datetime(out.kickoff_ts, utc=True)
    out['season_reliable'] = out.season_reliable.astype(bool)
    return out.sort_values(['component', 'kickoff_ts', 'game_id', 'espn_id'], kind='mergesort').reset_index(drop=True)


def _center_full(rows):
    """Centre a complete season's efficiency rows by the family's full-season mean per event."""
    rows = rows.copy()
    rows['lm'] = 0.0
    for comp, spec in COMPONENTS.items():
        if not spec['center']:
            continue
        m = rows.component.eq(comp)
        if m.any():
            rows.loc[m, 'lm'] = rows.loc[m, 'e'].sum() / rows.loc[m, 'n'].sum()
    rows['ec'] = rows.e - rows.n * rows.lm
    return rows


# ============================================================ estimation
def _boot_idx(n, B, rng):
    return rng.integers(0, n, size=(B, n))


def _split_half(r, comp, rng):
    """Split-half reliability: alternate a player's games (within player x team x season)
    into two halves; sigma2 = sum (x0-x1)^2 / sum (1/n0 + 1/n1); tau2 = covariance of the
    halves (weights n0 n1 / (n0 + n1)); k = sigma2 / tau2."""
    x = r[r.component.eq(comp)].sort_values(['espn_id', 'team_id', 'season', 'kickoff_ts', 'game_id'],
                                             kind='mergesort')
    x = x.assign(h=x.groupby(['espn_id', 'team_id', 'season']).cumcount() % 2)
    g = x.groupby(['espn_id', 'team_id', 'season', 'h']).agg(n=('n', 'sum'), e=('ec', 'sum')).unstack('h').dropna()
    g.columns = ['n0', 'n1', 'e0', 'e1']
    mn = COMPONENTS[comp]['min_exp']
    g = g[(g.n0 >= mn) & (g.n1 >= mn)]
    x0, x1 = (g.e0 / g.n0).values, (g.e1 / g.n1).values
    n0, n1 = g.n0.values, g.n1.values
    w = n0 * n1 / (n0 + n1)

    def est(ix):
        a0, a1, ww = x0[ix], x1[ix], w[ix]
        s2 = np.sum((a0 - a1) ** 2) / np.sum(1.0 / n0[ix] + 1.0 / n1[ix])
        m0, m1 = np.sum(ww * a0) / np.sum(ww), np.sum(ww * a1) / np.sum(ww)
        t2 = np.sum(ww * (a0 - m0) * (a1 - m1)) / np.sum(ww)
        return s2, t2
    s2, t2 = est(np.arange(len(g)))
    bs = np.array([est(ix) for ix in _boot_idx(len(g), N_BOOT, rng)])
    ks = bs[:, 0] / np.where(bs[:, 1] > 0, bs[:, 1], np.nan)
    thr = SPLIT_REPORT_MIN[comp]
    big = (n0 >= thr) & (n1 >= thr)
    r_half = float(np.corrcoef(x0[big], x1[big])[0, 1]) if big.sum() > 10 else None
    return {'sigma2': float(s2), 'tau2': float(t2), 'k': float(s2 / t2) if t2 > 0 else None,
            'k_ci': [float(np.nanquantile(ks, 0.025)), float(np.nanquantile(ks, 0.975))],
            'tau2_ci': [float(np.quantile(bs[:, 1], 0.025)), float(np.quantile(bs[:, 1], 0.975))],
            'sigma2_ci': [float(np.quantile(bs[:, 0], 0.025)), float(np.quantile(bs[:, 0], 0.975))],
            'n_player_seasons': int(len(g)), 'split_half_r': r_half, 'split_half_r_n': int(big.sum()),
            'split_half_r_min_exposure_per_half': thr,
            'split_half_median_exposure_per_half': float(np.median(np.concatenate([n0[big], n1[big]])))
            if big.any() else None}


def _player_seasons(r, comp):
    x = r[r.component.eq(comp)]
    g = x.groupby(['espn_id', 'team_id', 'season']).agg(n=('n', 'sum'), e=('ec', 'sum')).reset_index()
    g['rank'] = g.groupby(['team_id', 'season']).n.rank(method='first', ascending=False)
    return g


def _replacement(r, comp, rng):
    """Replacement = pooled centred efficiency (or rate) of the low-usage player-seasons: outside the
    team-season's usage slots (rank > slots by exposure; for rate components by production) with at
    least min_exp exposure."""
    spec = COMPONENTS[comp]
    g = _player_seasons(r, comp)
    if spec['kind'] == 'rate':
        tot = r[r.component.eq(comp)].groupby(['espn_id', 'team_id', 'season']).e.sum()
        g['prod_'] = tot.reindex(pd.MultiIndex.from_frame(g[['espn_id', 'team_id', 'season']])).values
        g['rank'] = g.groupby(['team_id', 'season'])['prod_'].rank(method='first', ascending=False)
    low = g[(g['rank'] > spec['slots']) & (g.n >= spec['min_exp'])]
    n, e = low.n.values, low.e.values
    est = float(e.sum() / n.sum())
    bs = np.array([e[ix].sum() / n[ix].sum() for ix in _boot_idx(len(low), N_BOOT, rng)])
    hi = g[(g['rank'] <= spec['slots']) & (g.n >= spec['min_exp'])]
    allp = g[g.n >= spec['min_exp']]
    return {'repl': est, 'repl_ci': [float(np.quantile(bs, 0.025)), float(np.quantile(bs, 0.975))],
            'repl_n_player_seasons': int(len(low)), 'repl_exposure': float(n.sum()),
            'starter_slot_mean': float(hi.e.sum() / hi.n.sum()) if len(hi) else None,
            'mu_pop': float(allp.e.sum() / allp.n.sum()), 'mu_pop_n': int(len(allp)),
            'definition': 'player-seasons outside the team-season top-%d by %s with exposure >= %d'
                          % (spec['slots'], 'production' if spec['kind'] == 'rate' else 'exposure', spec['min_exp'])}


def _persistence(rs, comp, tau2, rng):
    """Cross-season persistence of the centred efficiency (rate), disattenuated by the split-half
    true variance: rho = cov_w(x_{S-1}, x_S) / tau2, for the SAME team (stay) and a DIFFERENT team
    (transfer: modal team changed). Pairs S-1 -> S with S in the dev seasons."""
    mn = COMPONENTS[comp]['min_exp']
    g = _player_seasons(rs, comp)
    g = g.sort_values(['espn_id', 'season', 'n'], ascending=[True, True, False]).drop_duplicates(['espn_id', 'season'])
    g = g[g.n >= mn]
    g['x'] = g.e / g.n
    a = g.merge(g.assign(season=g.season - 1), on=['espn_id', 'season'], suffixes=('_p', '_c'))
    a = a[a.season.add(1).isin(DEV)]
    out = {}
    for lab, m in (('stay', a.team_id_p.eq(a.team_id_c)), ('transfer', a.team_id_p.ne(a.team_id_c))):
        b = a[m]
        xp, xc = b.x_p.values, b.x_c.values
        w = (b.n_p * b.n_c / (b.n_p + b.n_c)).values

        def est(ix):
            ww = w[ix]
            mp, mc = np.sum(ww * xp[ix]) / np.sum(ww), np.sum(ww * xc[ix]) / np.sum(ww)
            return np.sum(ww * (xp[ix] - mp) * (xc[ix] - mc)) / np.sum(ww) / tau2
        if len(b) < 10:
            out[lab] = {'rho': None, 'n': int(len(b))}
            continue
        bs = np.array([est(ix) for ix in _boot_idx(len(b), N_BOOT, rng)])
        out[lab] = {'rho': float(est(np.arange(len(b)))), 'rho_ci': [float(np.quantile(bs, 0.025)),
                                                                        float(np.quantile(bs, 0.975))],
                    'n': int(len(b))}
    return out


def estimate_constants(seasons=DEV):
    """Every estimated constant of the value model, from the dev seasons only."""
    C.assert_dev_only(seasons)
    rng = np.random.default_rng(C.SEED)
    seasons = sorted(int(s) for s in seasons)
    out = {'version': CONST_VERSION, 'rule': RULE, 'dev_seasons': seasons, 'n_boot': N_BOOT, 'seed': C.SEED}
    # --- FG make model and XP rate (dev attempts)
    A = pd.concat([fg_attempts(S) for S in seasons], ignore_index=True)
    z = (A.dist.values - 40.0) / 10.0
    X = np.column_stack([np.ones(len(z)), z, z * z])
    b, cov = _logit_irls(X, A.made.values)
    bins = pd.cut(A.dist, [0, 29, 39, 49, 75])
    out['fg_model'] = {'coef': [float(v) for v in b], 'se': [float(v) for v in np.sqrt(np.diag(cov))],
                       'form': 'logit p = b0 + b1 z + b2 z^2, z = (distance - 40) / 10', 'n_attempts': int(len(A)),
                       'by_distance': {str(k): {'n': int(len(v)), 'made': float(v.made.mean()),
                                                'model': float(fg_make_prob(v.dist, b).mean())}
                                       for k, v in A.groupby(bins, observed=True)}}
    xp_att = xp_made = 0.0
    for S in seasons:
        pg = U.player_games(S)
        xp_att += float(pg.xp_att.sum())
        xp_made += float(pg.xp_made.sum())
    out['xp_rate'] = {'p': xp_made / xp_att, 'n_attempts': int(xp_att)}
    out['play_values'] = _pbp_play_constants(seasons)
    # --- component rows of the dev seasons (+ the season before the first, for persistence pairs)
    fgc, pxp = out['fg_model']['coef'], out['xp_rate']['p']
    R = pd.concat([_center_full(component_rows(S, fg_coef=fgc, p_xp=pxp)) for S in [seasons[0] - 1] + seasons],
                  ignore_index=True)
    R = R[R.season_reliable]                        # a defensive column only in its RELIABLE seasons
    Rd = R[R.season.isin(seasons)]
    comps = {}
    for comp in COMPONENTS:
        rs = Rd[Rd.component.eq(comp)]
        if not len(rs):
            comps[comp] = {'estimated': False, 'reason': 'no dev season with a RELIABLE column'}
            continue
        ok = sorted(int(x) for x in rs.season.unique())
        sh = _split_half(rs, comp, rng)
        rp = _replacement(rs, comp, rng)
        ps = _persistence(R[R.component.eq(comp)], comp, sh['tau2'], rng)
        comps[comp] = dict(estimated=True, seasons=ok, **sh, **rp, persistence=ps)
    out['components'] = comps
    return ids.clean(out)


def constants(refresh=False):
    """The estimated constants (dev only), cached in <OUT>/personnel/values_constants.json."""
    seasons = list(DEV)
    sig = _src_sig([seasons[0] - 1] + seasons)
    if not refresh and ('const', sig) in _MEM:
        return _MEM[('const', sig)]
    f = common.out_path('personnel', 'values_constants.json')
    if not refresh:
        try:
            c = json.load(open(f))
            if c.get('signature') == sig:
                _MEM[('const', sig)] = c
                return c
        except (OSError, ValueError):
            pass
    c = estimate_constants(seasons)
    c['signature'] = sig
    with open(f, 'w') as fh:
        json.dump(c, fh, indent=1, sort_keys=True)
    _MEM[('const', sig)] = c
    return c


def model_params(const=None):
    """Per component: sigma2, tau2, k, repl, mu, rho_stay, rho_transfer (rho clipped to [0, 1])."""
    const = constants() if const is None else const
    out = {}
    for comp, c in const['components'].items():
        if not c.get('estimated'):
            continue
        ps = c['persistence']
        rs = ps['stay'].get('rho')
        rt = ps['transfer'].get('rho')
        rs = float(np.clip(rs if rs is not None else 0.5, 0.0, 1.0))
        rt = float(np.clip(rt if rt is not None else rs, 0.0, 1.0))
        out[comp] = {'sigma2': c['sigma2'], 'tau2': c['tau2'], 'k': c['sigma2'] / c['tau2'], 'repl': c['repl'],
                     'mu': c['mu_pop'], 'rho_stay': rs, 'rho_transfer': min(rt, rs) if rt > rs else rt,
                     'repl_sd': (c['repl_ci'][1] - c['repl_ci'][0]) / 3.92}
    return out


# ============================================================ pure rules
def posterior(m0, v0, n, e, sigma2):
    """Normal-normal update: prior N(m0, v0), n exposures with total e (centred), noise sigma2 per
    exposure -> (mean, var). With m0 = repl and v0 = tau2 = sigma2 / k this is (e + k repl) / (n + k)."""
    prec = 1.0 / np.asarray(v0, dtype=float) + np.asarray(n, dtype=float) / sigma2
    return (np.asarray(m0, dtype=float) / v0 + np.asarray(e, dtype=float) / sigma2) / prec, 1.0 / prec


def propagate(m, v, rho, mu, tau2):
    """Between seasons: theta' = mu + rho (theta - mu) + noise, stationary variance tau2."""
    rho = np.asarray(rho, dtype=float)
    return mu + rho * (np.asarray(m, dtype=float) - mu), rho ** 2 * np.asarray(v, dtype=float) + tau2 * (1 - rho ** 2)


def season_rho(same_team, gap, rho_stay, rho_transfer):
    """Persistence over `gap` seasons: stay^gap on the same team, transfer x stay^(gap-1) across a change."""
    gap = np.asarray(gap, dtype=float)
    return np.where(np.asarray(same_team, dtype=bool), rho_stay ** gap, rho_transfer * rho_stay ** (gap - 1))


def reliability_gate(verdict):
    """-> (use current-season rows, value allowed, null reason). RELIABLE: both; INSUFFICIENT (< 20
    team-games before T): prior seasons only; UNRELIABLE / missing: null (the unit is uncertainty-only)."""
    if verdict == 'RELIABLE':
        return True, True, None
    if verdict == 'INSUFFICIENT':
        return False, True, None
    return False, False, 'column_%s_at_T' % verdict


def sums_before(rows, requests):
    """Per request (espn_id, T): cumulative n and e over `rows` (espn_id, kickoff_ts, n, e) that kicked
    off STRICTLY before T. Returns arrays (n, e) aligned with `requests`."""
    agg = rows.groupby(['espn_id', 'kickoff_ts'], sort=True).agg(n=('n', 'sum'), e=('e', 'sum')).reset_index()
    agg['cn'] = agg.groupby('espn_id').n.cumsum()
    agg['ce'] = agg.groupby('espn_id').e.cumsum()
    agg['kickoff_ts'] = pd.to_datetime(agg.kickoff_ts, utc=True).astype('datetime64[ns, UTC]')
    agg = agg.sort_values('kickoff_ts', kind='mergesort')
    rq = requests[['espn_id', 'T']].copy()
    rq['T'] = pd.to_datetime(rq['T'], utc=True).astype('datetime64[ns, UTC]')
    rq['_o'] = np.arange(len(rq))
    mm = pd.merge_asof(rq.sort_values('T', kind='mergesort'), agg[['espn_id', 'kickoff_ts', 'cn', 'ce']],
                       left_on='T', right_on='kickoff_ts', by='espn_id', allow_exact_matches=False,
                       direction='backward').sort_values('_o')
    return mm.cn.fillna(0.0).values, mm.ce.fillna(0.0).values


# ============================================================ Kalman season states
def _season_summary(season, const):
    """Per (component, player): complete-season exposure, centred total and modal team."""
    key = ('summ', int(season), const['signature'])
    if key in _MEM:
        return _MEM[key]
    r = _center_full(component_rows(season, fg_coef=const['fg_model']['coef'], p_xp=const['xp_rate']['p']))
    r = r[r.season_reliable]                        # an unreliable season's column never feeds a value
    g = r.groupby(['component', 'espn_id', 'team_id']).agg(n=('n', 'sum'), e=('ec', 'sum')).reset_index()
    g = g.sort_values(['component', 'espn_id', 'n', 'team_id'], ascending=[True, True, False, True], kind='mergesort')
    team = g.drop_duplicates(['component', 'espn_id']).set_index(['component', 'espn_id']).team_id
    s = g.groupby(['component', 'espn_id']).agg(n=('n', 'sum'), e=('e', 'sum'))
    s['team_id'] = team.reindex(s.index).values
    s = s.reset_index()
    s['season'] = int(season)
    _MEM[key] = s
    return s


def season_states(last_season, const=None):
    """Posterior (m, v) per (component, player) after each complete season <= last_season,
    by the Kalman recursion from C.FIRST_PBP_SEASON. Point in time: the state after season s
    uses seasons <= s only. Cached per last_season."""
    const = constants() if const is None else const
    mp = model_params(const)
    key = ('states', int(last_season), const['signature'])
    if key in _MEM:
        return _MEM[key]
    f = os.path.join(_cache_dir(), 'value_states_%d.parquet' % last_season)
    fm = f.replace('.parquet', '.json')
    sig = ids.h(const['signature'], *[U._cache_key(s) for s in range(C.FIRST_PBP_SEASON, last_season + 1)])
    try:
        if json.load(open(fm)).get('key') == sig:
            st = pd.read_parquet(f)
            _MEM[key] = st
            return st
    except (OSError, ValueError):
        pass
    rows = []
    state = {}                                        # comp -> DataFrame indexed by espn_id
    for s in range(C.FIRST_PBP_SEASON, last_season + 1):
        sm = _season_summary(s, const)
        for comp, p in mp.items():
            x = sm[sm.component.eq(comp)].set_index('espn_id')
            if not len(x):
                continue
            prev = state.get(comp)
            m0 = np.full(len(x), p['repl'])
            v0 = np.full(len(x), p['tau2'])
            if prev is not None:
                have = x.index.isin(prev.index)
                pv = prev.reindex(x.index[have])
                rho = season_rho(pv.team_id.values == x.team_id.values[have], (s - pv.season).values,
                                 p['rho_stay'], p['rho_transfer'])
                m0[have], v0[have] = propagate(pv.m.values, pv.v.values, rho, p['mu'], p['tau2'])
            m, v = posterior(m0, v0, x.n.values, x.e.values, p['sigma2'])
            new = pd.DataFrame({'m': m, 'v': v, 'season': s, 'team_id': x.team_id.values,
                                'n': x.n.values}, index=x.index)
            state[comp] = new if prev is None else pd.concat([prev[~prev.index.isin(new.index)], new])
            rows.append(new.assign(component=comp).reset_index())
    st = pd.concat(rows, ignore_index=True)
    try:
        st.to_parquet(f, index=False)
        json.dump({'key': sig}, open(fm, 'w'))
    except OSError:
        pass
    _MEM[key] = st
    return st


def season_prior(season, const=None):
    """The prior at the start of `season` per (component, player): the latest state from seasons
    before `season`, with the team it was earned for (propagation happens in values_for, where
    the team asked about decides stay vs transfer)."""
    if season - 1 < C.FIRST_PBP_SEASON:
        return pd.DataFrame(columns=['component', 'espn_id', 'm', 'v', 'season', 'team_id', 'n'])
    st = season_states(season - 1, const)
    st = st.sort_values(['component', 'espn_id', 'season'], kind='mergesort')
    return st.drop_duplicates(['component', 'espn_id'], keep='last').reset_index(drop=True)


# ============================================================ values at T
def _season_rows(season, const):
    key = ('srows', int(season), const['signature'], U._cache_key(season))
    if key in _MEM:
        return _MEM[key]
    r = component_rows(season, fg_coef=const['fg_model']['coef'], p_xp=const['xp_rate']['p'])
    _MEM[key] = r
    return r


def _np_ts(T):
    return pd.Timestamp(T).tz_convert('UTC').tz_localize(None).to_datetime64()


def _league_mean_at(rows, comp, Ts, prev_mean):
    """Family league mean per event at each T (games that kicked off before T), blended with last
    season's full mean by LM_PSEUDO pseudo-events (declared)."""
    x = rows[rows.component.eq(comp)].sort_values('kickoff_ts', kind='mergesort')
    ce, cn = np.cumsum(x.e.values), np.cumsum(x.n.values)
    ks = pd.to_datetime(x.kickoff_ts, utc=True).dt.tz_localize(None).values
    out = {}
    for T in Ts:
        i = int(np.searchsorted(ks, _np_ts(T), side='left'))
        e, n = (ce[i - 1], cn[i - 1]) if i > 0 else (0.0, 0.0)
        out[T] = (e + LM_PSEUDO * prev_mean) / (n + LM_PSEUDO)
    return out


def values_for(season, requests, const=None):
    """Posterior value per request row (espn_id, team_id, T, component); returns the rows with
    m (posterior mean, centred units), sd, n_season (exposure before T), value_rate = m - repl
    (per event / per team game), value_sd, prior_basis, reliable (defensive columns at T).
    Only games that kicked off strictly before T enter; defensive components whose column is
    not RELIABLE at T return null values with a reason (INSUFFICIENT: prior seasons only)."""
    const = constants() if const is None else const
    mp = model_params(const)
    season = int(season)
    rq = requests.copy()
    rq['T'] = pd.to_datetime(rq['T'], utc=True).astype('datetime64[ns, UTC]')
    rq['_ord'] = np.arange(len(rq))
    rows = _season_rows(season, const)
    pri = season_prior(season, const).set_index(['component', 'espn_id'])
    prev_rows = _season_rows(season - 1, const) if season - 1 >= C.FIRST_PBP_SEASON else rows.iloc[:0]
    Ts = sorted(rq['T'].unique())
    tg = U.team_games(season)
    verdict_at = {}
    for T in Ts:
        r_ = U.reliability(season, tg=tg[tg.kickoff_ts < T])
        verdict_at[T] = {c: r_.get(c, {}).get('verdict') for c in ('def_sacks', 'def_ints', 'def_pbu')}
    out = []
    for comp, g in rq.groupby('component', sort=True):
        if comp not in mp:
            out.append(g.assign(m=np.nan, sd=np.nan, n_season=np.nan, value_rate=np.nan, value_sd=np.nan,
                                prior_basis=None, reliable=False, null_reason='component_not_estimated'))
            continue
        p = mp[comp]
        spec = COMPONENTS[comp]
        x = rows[rows.component.eq(comp)].sort_values(['kickoff_ts', 'espn_id'], kind='mergesort')
        lmT = {T: 0.0 for T in Ts}
        if spec['center']:
            pv = prev_rows[prev_rows.component.eq(comp)]
            prev_mean = float(pv.e.sum() / pv.n.sum()) if len(pv) and pv.n.sum() > 0 else 0.0
            lmT = _league_mean_at(rows, comp, Ts, prev_mean)
        # the player's own evidence this season strictly before T (every team he played for)
        mm = g.reset_index(drop=True)
        nn, ce = sums_before(x, mm)
        lm_arr = np.array([lmT[T] for T in mm['T']])
        ee = ce - nn * lm_arr
        idx = pd.MultiIndex.from_arrays([np.array([comp] * len(mm), dtype=object), mm.espn_id.values])
        have = idx.isin(pri.index)
        m0 = np.full(len(mm), p['repl'])
        v0 = np.full(len(mm), p['tau2'])
        basis = np.array(['replacement_prior'] * len(mm), dtype=object)
        if have.any():
            pr = pri.reindex(idx[have])
            same = pr.team_id.values == mm.team_id.values[have]
            rho = season_rho(same, season - pr.season.values, p['rho_stay'], p['rho_transfer'])
            m0[have], v0[have] = propagate(pr.m.values, pr.v.values, rho, p['mu'], p['tau2'])
            basis[have] = np.where(same, 'prior_seasons_same_team', 'prior_seasons_transfer')
        gates = [reliability_gate('RELIABLE' if spec['rel_col'] is None else verdict_at[T].get(spec['rel_col']))
                 for T in mm['T']]
        use_cur = np.array([g_[0] for g_ in gates])
        ok = np.array([g_[1] for g_ in gates])
        why = np.array([None if g_[2] is None else spec['rel_col'] + ':' + g_[2] for g_ in gates], dtype=object)
        nn = np.where(use_cur, nn, 0.0)
        ee = np.where(use_cur, ee, 0.0)
        basis = np.where(ok & ~use_cur, basis + '+no_current_season(insufficient)', basis)
        m, var = posterior(m0, v0, nn, ee, p['sigma2'])
        r_ = mm.assign(m=m, sd=np.sqrt(var), n_season=nn, prior_basis=basis, reliable=ok, null_reason=why)
        r_['value_rate'] = np.where(ok, r_.m - p['repl'], np.nan)
        r_['value_sd'] = np.where(ok, np.sqrt(r_.sd ** 2 + p['repl_sd'] ** 2), np.nan)
        out.append(r_)
    res = pd.concat(out, ignore_index=True).sort_values('_ord').drop(columns=['_ord'])
    res.index = requests.index
    return res


# ============================================================ per-player PVAR at T
def event_value(comp, const=None):
    """Points per unit of a component's rate (1 for EPA / points; EP per yard for punting;
    the EPA a defensive event takes away for the production rates)."""
    const = constants() if const is None else const
    pvv = const['play_values']
    return {'P_net': pvv['ep_per_yard'], 'FRONT_sack': pvv['V_sack'], 'SEC_int': pvv['V_int'],
            'SEC_pbu': pvv['V_pbu']}.get(comp, 1.0)


def player_values(season, T, state=None, const=None):
    """One row per (player, component) on a team's usage list at T: posterior rate, value per
    event above replacement, expected exposure per game and PVAR = value x exposure per game
    (points per game above replacement) with its SD. Exposure per game: the player's expected
    usage share (player_week_state) x the team's attributed non-garbage events per game before T
    (skill); FG / XP attempts and punts per team game x the kick / punt share (K, P); 1 team game
    (defence, presence-based production rates)."""
    from . import state as ST
    const = constants() if const is None else const
    T = U.to_ts(T)
    S = ST.player_week_state(season, T, availability=[]) if state is None else state
    S = S[S.position_family.isin(list(FAMILY_COMPONENTS))]
    req = []
    for f, comps in FAMILY_COMPONENTS.items():
        s = S[S.position_family.eq(f)]
        for c in comps:
            req.append(pd.DataFrame({'espn_id': s.espn_id.values, 'team_id': s.team_id.values, 'T': T,
                                     'component': c, 'family': f,
                                     'expected_usage_share': s.expected_usage_share.values,
                                     'name': s.name.values, 'role': s.role.values, 'context': s.context.values}))
    rq = pd.concat(req, ignore_index=True)
    v = values_for(season, rq, const)
    tg = U.team_games(season, T)
    if not len(tg) and season - 1 >= C.FIRST_PBP_SEASON:
        tg = U.team_games(season - 1)
    per = tg.groupby('team_id').agg(rush=('team_rushes_id_ng', 'mean'), tgt=('team_targets_id_ng', 'mean'),
                                    fga=('team_fg_att', 'mean'), xpa=('team_xp_att_id', 'mean'),
                                    punts=('team_punts', 'mean'))
    col = {'RB_rush': 'rush', 'WR_rec': 'tgt', 'TE_rec': 'tgt', 'K_fg': 'fga', 'K_xp': 'xpa', 'P_net': 'punts'}
    share = v.expected_usage_share.fillna(0.0).values
    ev = np.ones(len(v))
    for c, cc in col.items():
        m = v.component.eq(c).values
        ev[m] = per[cc].reindex(v.team_id.values[m]).values * share[m]
    v['exposure_per_game'] = ev
    ev_pts = v.component.map(lambda c: event_value(c, const)).values
    v['pvar'] = v.value_rate * v.exposure_per_game * ev_pts
    v['pvar_sd'] = v.value_sd * v.exposure_per_game * np.abs(ev_pts)
    v['rule_version'] = RULE
    return v.reset_index(drop=True)


def fill_state(state, season, T, const=None):
    """The foundation's null placeholders filled: player_value_mean / player_value_sd (PVAR, points
    per game above replacement, summed over the player's components), replacement_value (0 by
    definition: the value is above replacement; the replacement level itself is in value_model),
    value_model, value_status. OL and players without a component keep null with a reason."""
    const = constants() if const is None else const
    v = player_values(season, T, state=state, const=const)
    agg = v.groupby(['espn_id', 'team_id']).agg(pv=('pvar', lambda s: s.sum(min_count=1)),
                                                sd=('pvar_sd', lambda s: np.sqrt((s ** 2).sum(min_count=1))),
                                                comps=('component', lambda s: ','.join(sorted(set(s)))),
                                                why=('null_reason', lambda s: ';'.join(sorted({x for x in s if x}))))
    out = state.copy()
    key = pd.MultiIndex.from_arrays([out.espn_id.values, out.team_id.values])
    a = agg.reindex(key)
    out['player_value_mean'] = a.pv.values
    out['player_value_sd'] = a.sd.values
    out['replacement_value'] = np.where(a.comps.notna(), 0.0, np.nan)
    out['value_model'] = np.where(a.comps.notna(), RULE + ':' + a.comps.fillna('').astype(str), None)
    status = []
    for fam, pv, why in zip(out.position_family.values, a.pv.values, a.why.values):
        if fam in POS.OL_FAMILIES:
            status.append('NOT_ESTIMATED: no offensive-line player data (UNITS.md); OL is uncertainty-only')
        elif fam not in FAMILY_COMPONENTS:
            status.append('NOT_MODELLED: no value component for this family')
        elif pd.isna(pv):
            status.append('NULL: ' + (why or 'no value'))
        else:
            status.append('ESTIMATED')
    out['value_status'] = status
    return out
