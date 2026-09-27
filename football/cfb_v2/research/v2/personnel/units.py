"""Unit strength, health and lineup deltas per team at an instant T (every unit but the QB).

    rule 'cfb_personnel_units_v1'

    rating_weights(season)                 per team-game rating weights of the metric each unit's
                                           baseline follows (ratings.py's own weights, verified)
    panel(season, freezes)                 per (team, T, group, player): the rating's baseline share
                                           (rating_lineup_context), history and healthy shares, value per
                                           game, and (hindsight, for the ORACLE only) the next game's usage
    lineups(P, lam, availability=None)     upcoming lineups: oracle / pregame / healthy / reported
    deltas(P, lam, ...)                    per (team, T, unit): delta in points and its variance
    unit_state(season, T, availability=None)   live rows (one per team x unit, OL included)
    ol_uncertainty(season, T, availability=None)
    condition_share, condition_starter, redistribute, lineup_delta   the pure rules (tests_units)

THE RULE (docs/cfb-personnel/DESIGN.md rule 2). A unit adjustment is
    delta = sum_p (upcoming share_p - baseline share_p) x V_p            [points per game]
V_p = the player's value per game at the unit's full usage (values.py: value per event above
replacement x the team's events per game x points per event). The BASELINE is the lineup the team's
rating represents, built with the rating's own weights (ratings.py / build_ratings.py):
  * season horizon: every game weighted by w_g = 1 / (s2_play / n_g + s2_game) (varcomp.json; for
    the rate metrics s2_game ~ 1e-6, so w_g ~ n_g / s2_play: every non-garbage play counts once;
    garbage plays have weight 0 in stage 1, and shares here are non-garbage), plus the preseason
    PRIOR with precision 1 / tau2 (priors.parquet);
  * recent horizon: games and the prior decayed by 0.5 ** (age / C.RECENT_HALFLIFE_WEEKS) (8 weeks;
    the prior's age is counted from the season start = first kickoff - 3 days, as build_ratings);
  * the prior's share of the posterior mean pi = prec_prior / (prec_prior + sum w) per horizon (the
    one-team form; the joint solve's off_var(T) / off_var(T0) agrees, UNITS.md reports the check);
  * the prior's LINEUP = last season's shares at the team of the players who return (listed on this
    season's roster for the team, or seen for it before T); departed players' shares are replacement
    (V = 0), because V2's prior already discounts departures through returning production;
    baseline_p = 1/2 [pi_s prior_p + (1 - pi_s) data_s,p] + 1/2 [pi_r prior_p + (1 - pi_r) data_r,p]
    (the artifact reads both horizons: edge_* and edge_rec_*).
Re-anchoring follows: as a replacement accumulates games, his data share grows and pi falls, so the
baseline moves to him through the same weighting and a long absence stops being subtracted.

UPCOMING lineups (share groups RB, WR_TE, K, P):
  e_p  history expectation: EW share over the team's games (per-family half-lives of state.py; a
       missed game counts 0) = player_week_state.expected_usage_share; it CONTAINS history's absence rate
  h_p  healthy share: the same EW over the games he was used in (conditional on playing)
  p_hist = e_p / h_p
  with an availability status p (play probability): a_p = p x h_p   (CONDITIONING: p replaces p_hist;
       multiplying p x e_p would count the absence probability twice); UNKNOWN: a_p = e_p (not healthy)
  redistribution: the unit keeps its total share T_u; the missing mass goes (1 - lam) pro rata to the
       available players and lam to an unseen replacement (V = 0); lam is estimated on dev absences.
Presence groups (FRONT7, SECONDARY): production is not participation, so the lineup is presence
(0..1), not a share; a missing defender is replaced at replacement production (V = 0).

Point in time: every share, weight and value uses games that kicked off strictly before T; the
oracle columns (next_*, rem_*) are hindsight and are used ONLY by the oracle backtest variant.
Pure model only: no market column is read.
"""
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from . import positions as POS
from . import state as ST
from . import usage as U
from . import values as V

RULE = 'cfb_personnel_units_v1'
PANEL_VERSION = 'personnel_units_panel_v6'

# ------------------------------------------------------------------ groups
# share groups: a player's share of the team's attributed non-garbage events of the group's kind.
# presence groups: production per team game; the lineup is presence (participation is not observed).
GROUPS = {
    'RB': dict(unit='RB', kind='share', families=('RB',), count='rush_att_ng', den='team_rushes_id_ng',
               comps=('RB_rush',), metric=('epa_rush', 'o'), per_game={'RB_rush': 'team_rushes_id_ng'}),
    'WR_TE': dict(unit='WR_TE', kind='share', families=('WR', 'TE'), count='targets_ng', den='team_targets_id_ng',
                  comps=('WR_rec', 'TE_rec'), metric=('epa_pass', 'o'),
                  per_game={'WR_rec': 'team_targets_id_ng', 'TE_rec': 'team_targets_id_ng'}),
    'K': dict(unit='ST', kind='share', families=None, count='kicks', den='team_kicks', comps=('K_fg', 'K_xp'),
              metric=('fg_value', 'o'), per_game={'K_fg': 'team_fg_att', 'K_xp': 'team_xp_att_id'}),
    'P': dict(unit='ST', kind='share', families=None, count='punts', den='team_punts', comps=('P_net',),
              metric=('st_net', 'o'), per_game={'P_net': 'team_punts'}),
    'FRONT7': dict(unit='FRONT7', kind='presence', families=POS.FRONT7_FAMILIES, prod=('def_sacks',),
                   comps=('FRONT_sack',), metric=('epa_pass', 'd')),
    'SECONDARY': dict(unit='SECONDARY', kind='presence', families=POS.SECONDARY_FAMILIES,
                      prod=('def_ints', 'def_pbu'), comps=('SEC_int', 'SEC_pbu'), metric=('epa_pass', 'd')),
}
UNITS = ('RB', 'WR_TE', 'FRONT7', 'SECONDARY', 'ST', 'OL')
UNIT_GROUPS = {'RB': ('RB',), 'WR_TE': ('WR_TE',), 'FRONT7': ('FRONT7',), 'SECONDARY': ('SECONDARY',),
               'ST': ('K', 'P')}
COMP_FAMILY = {'WR_rec': ('WR',), 'TE_rec': ('TE',)}          # component restricted to these families

# an ABSENCE (oracle): a player whose healthy share implies >= MIN_EXPECTED_EVENTS usage events in the
# game (P(no usage | plays) <= e^-4 ~ 2% under a Poisson count) and who records none, in a game the
# team played. K / P: someone else kicked / punted and he did not.
MIN_EXPECTED_EVENTS = 4.0
# a defender is 'gone' (oracle) when he records no production in this game nor in any later game of
# the season, with at least GONE_MIN_REMAINING team games left (this one included)
GONE_MIN_REMAINING = 3
DEF_CHANGE_SHARE = 0.15            # a defender whose share of the unit's production >= this is 'key'
# pregame presence of a defender: production in the team's last PREGAME_RECENT games
PREGAME_RECENT = 3
LAMBDA_DEFAULT = 0.35              # replaced by the dev estimate (backtest_units.estimate_lambda)

_MEM = {}


# ================================================================ pure rules
def condition_share(e, h, p_status):
    """Expected upcoming share given availability. e = history expectation (contains history's
    absence rate), h = healthy share (conditional on playing), p_status = play probability from a
    report (NaN = UNKNOWN). Known status -> p x h (the report REPLACES history's absence rate);
    UNKNOWN -> e (history, never 'healthy')."""
    e, h = np.asarray(e, dtype=float), np.asarray(h, dtype=float)
    p = np.asarray(p_status, dtype=float)
    return np.where(np.isnan(p), e, p * h)


def condition_starter(sp, p_hist, p_status):
    """Starter (usage-leader) probability given availability: P(top | plays) = sp / p_hist, then x p.
    UNKNOWN keeps the history-based sp."""
    sp, ph = np.asarray(sp, dtype=float), np.asarray(p_hist, dtype=float)
    p = np.asarray(p_status, dtype=float)
    with np.errstate(invalid='ignore', divide='ignore'):
        cond = np.clip(sp / np.where(ph > 0, ph, np.nan), 0.0, 1.0)
    cond = np.where(np.isnan(cond), sp, cond)
    return np.where(np.isnan(p), sp, np.clip(p * cond, 0.0, 1.0))


def redistribute(a, total, lam, available=None):
    """Upcoming shares from availability-conditioned shares a (one team's group), keeping the
    group's total share `total`: above it -> scaled down pro rata; below it -> the missing mass goes
    (1 - lam) pro rata to the available players (by a) and lam to an unseen replacement.
    Returns (u, u_replacement)."""
    a = np.clip(np.asarray(a, dtype=float), 0.0, None)
    avail = (a > 0) if available is None else (np.asarray(available, dtype=bool) & (a > 0))
    s = float(a.sum())
    if total <= 0:
        return a * 0.0, 0.0
    if s >= total:
        return a * (total / s), 0.0
    M = total - s
    sa = float(a[avail].sum())
    if sa <= 0:
        return a, M
    u = a + np.where(avail, (1.0 - lam) * M * a / sa, 0.0)
    return u, lam * M


def lineup_delta(base, up, Vp, Vsd=None):
    """delta = sum (up - base) x V ; var = sum (up - base)^2 x sd^2 (players independent)."""
    d = np.asarray(up, dtype=float) - np.asarray(base, dtype=float)
    Vp = np.nan_to_num(np.asarray(Vp, dtype=float))
    out = float(np.sum(d * Vp))
    var = float(np.sum(d ** 2 * np.nan_to_num(np.asarray(Vsd, dtype=float)) ** 2)) if Vsd is not None else 0.0
    return out, var


def prior_shares(w, age_weeks, tau2, prior_age_weeks, halflife=None):
    """The preseason prior's share of the rating's posterior mean, per horizon (the one-team form of
    ratings.solve): season pi = (1/tau2) / (1/tau2 + sum w); recent: games AND the prior decayed by
    0.5 ** (age / halflife). w: the rating's per-game precision weights of the games before T."""
    hl = C.RECENT_HALFLIFE_WEEKS if halflife is None else halflife
    w = np.asarray(w, dtype=float)
    dec = 0.5 ** (np.asarray(age_weeks, dtype=float) / hl)
    pp = 1.0 / tau2
    pw = 0.5 ** (max(0.0, prior_age_weeks) / hl)
    return pp / (pp + w.sum()), pw * pp / (pw * pp + (w * dec).sum())


def baseline_share(S_pg, w, dec, prior, pi_s, pi_r):
    """rating_lineup_context for one team: S_pg = players x games shares (games before T), w = the
    rating's game weights, dec = the recent horizon's decay, prior = the prior lineup's shares.
    -> (baseline, data_season, data_recent); baseline = mean of the two horizons' pi-blends."""
    S_pg = np.asarray(S_pg, dtype=float)
    n = S_pg.shape[0]
    w, dec = np.asarray(w, dtype=float), np.asarray(dec, dtype=float)
    data_s = S_pg @ w / w.sum() if w.sum() > 0 else np.zeros(n)
    wr = w * dec
    data_r = S_pg @ wr / wr.sum() if wr.sum() > 0 else np.zeros(n)
    prior = np.asarray(prior, dtype=float)
    base = 0.5 * (pi_s * prior + (1 - pi_s) * data_s) + 0.5 * (pi_r * prior + (1 - pi_r) * data_r)
    return base, data_s, data_r


def ew_shares(Cm, D, halflives):
    """History expectation e and healthy share h per player: EW over the team's games (age in team
    games, 0 = the latest; per-player half-life); e counts missed games as 0, h only the games he was
    used in. e = p_hist x h exactly (p_hist = the usage-weighted share of games he played)."""
    Cm, D = np.asarray(Cm, dtype=float), np.asarray(D, dtype=float)
    J = Cm.shape[1]
    W = 0.5 ** ((J - 1 - np.arange(J))[None, :] / np.asarray(halflives, dtype=float)[:, None])
    num = (W * Cm).sum(axis=1)
    den = (W * D[None, :]).sum(axis=1)
    e = np.where(den > 0, num / np.where(den > 0, den, 1.0), 0.0)
    dp = (W * D[None, :] * (Cm > 0)).sum(axis=1)
    h = np.where(dp > 0, num / np.where(dp > 0, dp, 1.0), np.nan)
    return e, h


# ============================================================ rating weights
def _varcomp():
    if 'vc' not in _MEM:
        _MEM['vc'] = json.load(open(common.out_path('stage3', 'varcomp.json')))
    return _MEM['vc']


def rating_weights(season):
    """Per (metric, side, team, game): kickoff_ts and the rating's precision weight
    w = 1 / (s2_play / n + s2_game) of the team's observation on that side (off: its offence rows;
    def: the opponent's offence rows against it). Plus tau2 per (metric, side, team) and the
    season start used for the prior's age. Read from stage 1 / stage 3 exactly as build_ratings."""
    key = ('rw', int(season))
    if key in _MEM:
        return _MEM[key]
    vc = _varcomp()
    t1 = pd.read_parquet(common.out_path('stage1', 'team_game_%d.parquet' % season),
                         columns=['game_id', 'team_id', 'opp_id', 'n_db', 'n_rush'])
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'), columns=['game_id', 'season', 'kickoff_ts',
                                                                             'status'])
    Gs = G[G.season.eq(season)]
    t1 = t1.merge(Gs[Gs.status.eq('FINAL')][['game_id', 'kickoff_ts']], on='game_id', how='inner')
    season_start = Gs.kickoff_ts.min() - pd.Timedelta(days=3)
    pri = pd.read_parquet(common.out_path('stage3', 'priors.parquet'))
    pri = pri[pri.season.eq(season)]
    out = {}
    for g, spec in GROUPS.items():
        m, side = spec['metric']
        s2p, s2g = vc[m]
        ncol = {'epa_rush': 'n_rush', 'epa_pass': 'n_db'}.get(m)
        x = t1.copy()
        x['n'] = x[ncol].astype(float) if ncol else 1.0
        if side == 'd':
            x = x.assign(team_id=x.opp_id)
        x = x[x.n > 0]
        x['w'] = 1.0 / (s2p / x.n + s2g)
        tau = pri[pri.metric.eq(m) & pri.side.eq(side)].set_index('team_id').prior_var
        out[(m, side)] = {'games': x[['team_id', 'game_id', 'kickoff_ts', 'w']].copy(), 'tau2': tau,
                          'tau2_default': float(tau.median()) if len(tau) else 1.0}
    res = {'metrics': out, 'season_start': season_start, 'halflife_weeks': C.RECENT_HALFLIFE_WEEKS}
    _MEM[key] = res
    return res


def _team_weights(rw, metric, side, team_id):
    key = ('tw', id(rw), metric, side)
    if key not in _MEM:
        g = rw['metrics'][(metric, side)]['games']
        _MEM[key] = {int(t): (x.kickoff_ts.values, x.w.values, x.game_id.values)
                     for t, x in g.sort_values('kickoff_ts').groupby('team_id')}
    return _MEM[key].get(int(team_id), (np.array([], dtype='datetime64[ns]'), np.zeros(0), np.zeros(0)))


def pi_at(rw, metric, side, team_id, T):
    """(pi_season, pi_recent, sum_w, n_games) for one team at T: the prior's share of the posterior
    mean in each horizon (one-team form of ratings.solve)."""
    d = rw['metrics'][(metric, side)]
    ks, w, _ = _team_weights(rw, metric, side, team_id)
    ks = pd.to_datetime(ks, utc=True)
    m = ks < T
    tau2 = float(d['tau2'].get(team_id, d['tau2_default']))
    age = (T - ks[m]).total_seconds().values / (7 * 86400.0)
    pa = (T - rw['season_start']).total_seconds() / (7 * 86400.0)
    pi_s, pi_r = prior_shares(w[m], age, tau2, pa, rw['halflife_weeks'])
    return pi_s, pi_r, float(w[m].sum()), int(m.sum())


# ================================================================== panel
def _prep_season(season):
    """player_games / team_games of `season` with the derived count columns and the PIT family."""
    key = ('prep', int(season), U._cache_key(season))
    if key in _MEM:
        return _MEM[key]
    pg = U.player_games(season).copy()
    tg = U.team_games(season).copy()
    pg['kicks'] = pg.fg_att + pg.xp_att
    tg['team_kicks'] = tg.team_fg_att + tg.team_xp_att_id
    fam = V.family_map(season)
    pg = pg.sort_values(['kickoff_ts', 'game_id', 'espn_id'], kind='mergesort').reset_index(drop=True)
    f = pg.espn_id.map(fam).fillna('UNKNOWN').values.astype(object)
    unk = f == 'UNKNOWN'
    if unk.any():
        cum = pg.loc[unk, ['espn_id', 'dropbacks', 'rush_att', 'targets']].groupby('espn_id')[
            ['dropbacks', 'rush_att', 'targets']].cumsum()
        f[unk] = V.infer_family(cum.dropbacks, cum.rush_att, cum.targets)
    pg['family'] = f
    tg = tg.sort_values(['team_id', 'kickoff_ts', 'game_id'], kind='mergesort').reset_index(drop=True)
    tg['j'] = tg.groupby('team_id').cumcount()
    pg = pg.merge(tg[['game_id', 'team_id', 'j']], on=['game_id', 'team_id'], how='inner')
    _MEM[key] = (pg, tg)
    return pg, tg


def _group_rows(pg, g, rel=None):
    """Rows of player-games that count for group g: (espn_id, team_id, j, c, family)."""
    spec = GROUPS[g]
    if spec['kind'] == 'share':
        x = pg[pg[spec['count']] > 0]
        if spec['families'] is not None:
            x = x[x.family.isin(spec['families'])]
        return x.assign(c=x[spec['count']].astype(float))[['espn_id', 'team_id', 'j', 'c', 'family', 'game_id']]
    cols = [c for c in spec['prod'] if rel is None or rel.get(c, {}).get('verdict') == 'RELIABLE']
    if not cols:
        return pg.iloc[:0].assign(c=0.0)[['espn_id', 'team_id', 'j', 'c', 'family', 'game_id']]
    x = pg[pg.family.isin(spec['families'])]
    c = x[cols].fillna(0.0).sum(axis=1)
    x = x.assign(c=c.values)
    return x[x.c > 0][['espn_id', 'team_id', 'j', 'c', 'family', 'game_id']]


def _halflife(fam):
    return ST.EW_HALFLIFE.get(fam, ST.EW_HALFLIFE_DEFAULT)


def _prod_matrix(pgt, g, idx, nG, cols):
    """players x team-games production (or usage) counts of group g for one team-season."""
    spec = GROUPS[g]
    M = np.zeros((len(idx), max(nG, 1)))
    if spec['kind'] == 'share':
        x = pgt[pgt[spec['count']] > 0]
        if spec['families'] is not None:
            x = x[x.family.isin(spec['families'])]
        vals = x[spec['count']].values.astype(float)
    else:
        x = pgt[pgt.family.isin(spec['families'])]
        vals = x[list(cols)].fillna(0.0).sum(axis=1).values.astype(float) if cols else np.zeros(len(x))
        keep = vals > 0
        x, vals = x[keep], vals[keep]
    if len(x):
        np.add.at(M, (x.espn_id.map(idx).values, x.j.values), vals)
    return M


def panel(season, freezes, const=None, oracle=True):
    """Per (team, T, group, player) rows (see the module docstring). freezes: DataFrame with
    team_id, T (UTC) and, for the oracle, game_id (the team's upcoming game). Only games that kicked
    off strictly before T feed a share, a weight or a value; next_* / rem_* (the upcoming game and
    the rest of the season) are hindsight and are filled only when oracle=True."""
    const = V.constants() if const is None else const
    season = int(season)
    fr = freezes.copy()
    fr['T'] = pd.to_datetime(fr['T'], utc=True)
    if 'game_id' not in fr.columns:
        fr['game_id'] = np.nan
    pg, tg = _prep_season(season)
    prev = season - 1 >= C.FIRST_PBP_SEASON
    pgp, tgp = _prep_season(season - 1) if prev else (pg.iloc[:0], tg.iloc[:0])
    relp = U.reliability(season - 1, tg=tgp) if prev else {}
    roster = ST._roster_listing(season)
    rteam = dict(zip(roster.espn_id.astype('int64'), roster.team_id.astype('int64'))) if len(roster) else {}
    rw = rating_weights(season)
    hl = rw['halflife_weeks']
    Ts = sorted(fr['T'].unique())
    rel_T = {T: U.reliability(season, tg=tg[tg.kickoff_ts < T]) for T in Ts}
    cols_T = {T: {g: tuple(c for c in spec.get('prod', ()) if rel_T[T].get(c, {}).get('verdict') == 'RELIABLE')
                  for g, spec in GROUPS.items()} for T in Ts}
    usable_T = {T: {g: any(rel_T[T].get(c, {}).get('verdict') in ('RELIABLE', 'INSUFFICIENT')
                           for c in spec.get('prod', ())) for g, spec in GROUPS.items()} for T in Ts}
    pcols_prev = {g: tuple(c for c in spec.get('prod', ()) if relp.get(c, {}).get('verdict') == 'RELIABLE')
                  for g, spec in GROUPS.items()}
    fam_all = V.family_map(season)
    cols_out = {}

    def put(k, v):
        cols_out.setdefault(k, []).append(v)

    for tid, ft in fr.groupby('team_id', sort=True):
        tid = int(tid)
        tgt = tg[tg.team_id.eq(tid)].sort_values('j')
        kick = pd.to_datetime(tgt.kickoff_ts, utc=True)
        kick_np = kick.dt.tz_localize(None).values
        gid_order = tgt.game_id.values
        nG = len(tgt)
        tgpt = tgp[tgp.team_id.eq(tid)].sort_values('j')
        pgt = pg[pg.team_id.eq(tid)]
        pgpt = pgp[pgp.team_id.eq(tid)]
        first_any = pgt.groupby('espn_id').j.min()
        ft = ft.sort_values('T')
        Jn = {T: (int(np.searchsorted(kick_np, V._np_ts(T), side='left')) if nG else 0) for T in ft['T']}
        jnext = {}
        for T, gid in zip(ft['T'], ft.game_id):
            j_ = np.nonzero(gid_order == gid)[0] if pd.notna(gid) else []
            jnext[T] = int(j_[0]) if len(j_) else None
        for g, spec in GROUPS.items():
            m_, side = spec['metric']
            # ---- last season at this team: the prior lineup (returning players) and healthy shares
            if spec['kind'] == 'share':
                xp = pgpt[pgpt[spec['count']] > 0]
                if spec['families'] is not None:
                    xp = xp[xp.family.isin(spec['families'])]
                Dp = tgpt[spec['den']].values.astype(float) if len(tgpt) else np.zeros(0)
                cp = xp.groupby('espn_id')[spec['count']].sum()
                prior_share = cp / Dp.sum() if Dp.sum() > 0 else cp * 0.0
                dj = dict(zip(tgpt.j.values, Dp))
                dplayed = xp.groupby('espn_id').j.apply(lambda s: float(sum(dj.get(j, 0.0) for j in set(s))))
                prior_h = (cp / dplayed.where(dplayed > 0)).fillna(0.0)
            else:
                cp_cols = pcols_prev[g]
                xp = pgpt[pgpt.family.isin(spec['families'])]
                prodp = xp[list(cp_cols)].fillna(0.0).sum(axis=1) if cp_cols else pd.Series(0.0, index=xp.index)
                xp = xp[prodp.values > 0]
                prior_share = pd.Series(1.0, index=sorted(set(xp.espn_id)))
                prior_h = prior_share
            prior_fam = xp.groupby('espn_id').family.last() if len(xp) else pd.Series(dtype=object)
            per_prev = {k: float(tgpt[c].mean()) if len(tgpt) else np.nan for k, c in (spec.get('per_game') or {}).items()}
            den_prev = float(tgpt[spec['den']].mean()) if (spec['kind'] == 'share' and len(tgpt)) else np.nan
            # ---- this season: the universe of players and their count matrices
            if spec['kind'] == 'share':
                xs = pgt[pgt[spec['count']] > 0]
                if spec['families'] is not None:
                    xs = xs[xs.family.isin(spec['families'])]
            else:
                xs = pgt[pgt.family.isin(spec['families'])]
            univ = sorted(set(xs.espn_id) | set(prior_share.index))
            if not univ:
                continue
            idx = {e: i for i, e in enumerate(univ)}
            nU = len(univ)
            univ_a = np.array(univ, dtype='int64')
            mats = {}
            fam_rows = xs.sort_values('j')[['espn_id', 'j', 'family']]
            fr_by = {e: (x.j.values, x.family.values) for e, x in fam_rows.groupby('espn_id')}
            fam_static = np.array([fam_all.get(int(e), 'UNKNOWN') for e in univ], dtype=object)
            pr_share = np.array([float(prior_share.get(e, 0.0)) for e in univ])
            pr_h = np.array([float(prior_h.get(e, 0.0)) for e in univ])
            in_prior = np.array([e in prior_share.index for e in univ])
            rost = np.array([rteam.get(int(e)) == tid for e in univ])
            fa = first_any.reindex(univ_a).values
            _, w_all, g_all = _team_weights(rw, m_, side, tid)
            wmap = dict(zip(g_all, w_all))
            wg_full = np.array([wmap.get(x, 0.0) for x in gid_order])
            D_full = tgt[spec['den']].values.astype(float) if spec['kind'] == 'share' else None
            for T in ft['T'].unique():
                if spec['kind'] == 'presence' and not usable_T[T][g]:
                    continue                        # no usable defensive column at T: uncertainty only
                J = Jn[T]
                ck = spec['count'] if spec['kind'] == 'share' else cols_T[T][g]
                if ck not in mats:
                    mats[ck] = _prod_matrix(pgt, g, idx, nG, ck if spec['kind'] == 'presence' else None)
                Cm = mats[ck]
                used = (Cm[:, :J] > 0).any(axis=1) if J else np.zeros(nU, dtype=bool)
                seen = np.nan_to_num(fa, nan=1e9) < J
                ret = in_prior & (rost | seen)
                keep = used | ret
                if not keep.any():
                    continue
                pi_s, pi_r, _, _ = pi_at(rw, m_, side, tid, T)
                K = np.nonzero(keep)[0]
                n = len(K)
                C_ = Cm[K, :J]
                fams = []
                for i in K:
                    e = univ[i]
                    f0 = fam_static[i]
                    if e in fr_by:
                        js, fs = fr_by[e]
                        mm = js < J
                        if mm.any():
                            f0 = fs[mm][-1]
                        elif f0 == 'UNKNOWN':
                            f0 = prior_fam.get(e, f0)
                    elif f0 == 'UNKNOWN':
                        f0 = prior_fam.get(e, f0)
                    fams.append(f0)
                wg = wg_full[:J]
                age_w = (T - kick.iloc[:J]).dt.total_seconds().values / (7 * 86400.0) if J else np.zeros(0)
                dec = 0.5 ** (age_w / hl)
                pr = np.where(ret[K], pr_share[K], 0.0)
                if spec['kind'] == 'share':
                    D = D_full[:J]
                    okD = D > 0
                    S_pg = np.where(okD[None, :], C_ / np.where(okD, D, 1.0)[None, :], 0.0) if J else np.zeros((n, 0))
                    _, data_s, data_r = baseline_share(S_pg, wg * okD, dec, pr, 0.0, 0.0)
                    if J:
                        e_, h_ = ew_shares(C_, D, [_halflife(f) for f in fams])
                        h_ = np.where(np.isnan(h_), np.where(ret[K], pr_h[K], 0.0), h_)
                        tot = float(e_.sum())
                        per_game = {k: float(tgt[c].values[:J].mean()) for k, c in spec['per_game'].items()}
                        den_pg = float(D.mean())
                    else:                               # week 1: last season's usage at the team
                        e_ = pr.copy()
                        h_ = np.where(ret[K], pr_h[K], 0.0)
                        # the unit total is the returning players' healthy shares: the departed players'
                        # usage goes to unseen replacements (V = 0), never pro rata to the returners
                        tot = float(h_.sum())
                        per_game = dict(per_prev)
                        den_pg = den_prev
                    prod_share = np.full(n, np.nan)
                    prod_team = np.nan
                else:
                    has = (C_ > 0) if J else np.zeros((n, 0), dtype=bool)
                    first = np.where(has.any(axis=1), has.argmax(axis=1), J) if J else np.zeros(n, dtype=int)
                    pres = (np.arange(J)[None, :] >= first[:, None]).astype(float) if J else np.zeros((n, 0))
                    _, data_s, data_r = baseline_share(pres, wg, dec, pr, 0.0, 0.0)
                    h_ = np.ones(n)
                    recent = C_[:, max(0, J - PREGAME_RECENT):J].sum(axis=1) > 0 if J else np.zeros(n, dtype=bool)
                    e_ = np.where(recent | (J < PREGAME_RECENT), 1.0, 0.0)
                    tot = np.nan
                    per_game = {}
                    den_pg = np.nan
                    ptot = C_.sum(axis=1) if J else np.zeros(n)
                    prod_share = ptot / ptot.sum() if ptot.sum() > 0 else np.zeros(n)
                    prod_team = float(Cm[:, :J].sum()) if J else 0.0
                base = 0.5 * (pi_s * pr + (1 - pi_s) * data_s) + 0.5 * (pi_r * pr + (1 - pi_r) * data_r)
                if J:
                    rev = (C_[:, ::-1] > 0)
                    last_j = np.where(rev.any(axis=1), J - 1 - rev.argmax(axis=1), -1)
                else:
                    last_j = np.full(n, -1)
                put('espn_id', univ_a[K])
                put('family', np.array(fams, dtype=object))
                put('team_id', np.full(n, tid, dtype='int64'))
                put('T', np.array([T] * n, dtype=object))
                put('group', np.array([g] * n, dtype=object))
                put('unit', np.array([spec['unit']] * n, dtype=object))
                put('J', np.full(n, J))
                put('pi_s', np.full(n, pi_s))
                put('pi_r', np.full(n, pi_r))
                put('in_season', last_j >= 0)
                put('returning', ret[K])
                put('prior_share', pr)
                put('data_s', data_s)
                put('data_r', data_r)
                put('base', base)
                put('e', e_)
                put('h', h_)
                put('p_hist', np.where(h_ > 0, np.clip(e_ / np.where(h_ > 0, h_, 1.0), 0, 1), np.nan))
                put('last_j', last_j)
                put('games_missed_run', np.where(last_j >= 0, J - 1 - last_j, J))
                put('group_total', np.full(n, tot))
                put('den_per_game', np.full(n, den_pg))
                put('prod_share', prod_share)
                put('prod_team', np.full(n, prod_team))
                for k in ('RB_rush', 'WR_rec', 'TE_rec', 'K_fg', 'K_xp', 'P_net'):
                    put('pg_' + k, np.full(n, per_game.get(k, np.nan)))
                # ---- the oracle's hindsight: the upcoming game and the rest of the season
                jn = jnext.get(T) if oracle else None
                gid = ft[ft['T'].eq(T)].game_id.iloc[0]
                put('game_id', np.full(n, gid if pd.notna(gid) else np.nan))
                if jn is not None:
                    put('next_played', np.ones(n, dtype=bool))
                    put('next_c', Cm[K, jn])
                    put('rem_c', Cm[K, jn:].sum(axis=1))
                    put('rem_games', np.full(n, nG - jn))
                    put('next_den', np.full(n, float(D_full[jn]) if spec['kind'] == 'share' else np.nan))
                    put('next_group_c', np.full(n, float(Cm[:, jn].sum())))
                else:
                    put('next_played', np.zeros(n, dtype=bool))
                    for k in ('next_c', 'rem_c', 'rem_games', 'next_den', 'next_group_c'):
                        put(k, np.full(n, np.nan))
    if not cols_out:
        return pd.DataFrame()
    P = pd.DataFrame({k: np.concatenate(v) for k, v in cols_out.items()})
    P['T'] = pd.to_datetime(P['T'], utc=True)
    P['season'] = season
    return _attach_values(P, season, const)


def _attach_values(P, season, const):
    """V (points per game at the group's full usage / full presence) and its SD, from values.py."""
    req = []
    for g, spec in GROUPS.items():
        x = P[P.group.eq(g)]
        for comp in spec['comps']:
            y = x
            if comp in COMP_FAMILY:
                y = x[x.family.isin(COMP_FAMILY[comp])]
            if len(y):
                req.append(pd.DataFrame({'row': y.index.values, 'espn_id': y.espn_id.values,
                                         'team_id': y.team_id.values, 'T': y['T'].values, 'component': comp}))
    rq = pd.concat(req, ignore_index=True)
    v = V.values_for(season, rq, const)
    ev = v.component.map(lambda c: V.event_value(c, const)).values
    per = np.ones(len(v))
    for g, spec in GROUPS.items():
        for comp, col in (spec.get('per_game') or {}).items():
            m = (v.component == comp).values
            if m.any():
                per[m] = P.loc[v.row.values[m], 'pg_' + comp].values
    v['V'] = v.value_rate.values * per * ev
    v['V_sd'] = v.value_sd.values * per * np.abs(ev)
    agg = v.groupby('row').agg(V=('V', lambda s: s.sum(min_count=1)),
                               V_sd=('V_sd', lambda s: np.sqrt((s ** 2).sum(min_count=1))),
                               value_basis=('prior_basis', lambda s: ','.join(sorted({str(x) for x in s}))),
                               value_null=('null_reason', lambda s: ';'.join(sorted({x for x in s if isinstance(x, str) and x}))))
    P = P.join(agg, how='left')
    return P


# ================================================================ lineups
def lineups(P, lam, availability=None):
    """Upcoming lineups per panel row: u_oracle (hindsight absences), u_pregame (history only),
    u_healthy (everyone available: the naive reference), u_report (availability statuses by
    conditioning; `availability` = {(team_id, espn_id): play probability}, missing = UNKNOWN).
    Share groups keep their total share and redistribute (lam to replacement); presence groups
    use the presence probability directly."""
    P = P.copy()
    for c in ('u_oracle', 'u_pregame', 'u_healthy', 'u_report', 'u_known', 'absent', 'p_status'):
        P[c] = np.nan
    P['absent'] = False
    for (tid, T, g), x in P.groupby(['team_id', 'T', 'group'], sort=False):
        idx = x.index.values
        spec = GROUPS[g]
        if availability is not None:
            p = np.array([availability.get((int(tid), int(e)), np.nan) for e in x.espn_id.values], dtype=float)
        else:
            p = np.full(len(x), np.nan)
        P.loc[idx, 'p_status'] = p
        if spec['kind'] == 'share':
            tot = float(x.group_total.iloc[0])
            h = x.h.values
            uh, _ = redistribute(h, tot, lam)
            P.loc[idx, 'u_healthy'] = uh
            P.loc[idx, 'u_pregame'] = x.e.values
            a = condition_share(x.e.values, h, p)
            ur, _ = redistribute(a, tot, lam, available=np.isnan(p) | (p > 0))
            P.loc[idx, 'u_report'] = ur if np.any(~np.isnan(p)) else x.e.values
            # the KNOWN-absence lineup: reported statuses only, everyone else at his healthy share
            # (the oracle's construction with the report in place of hindsight)
            pk = np.where(np.isnan(p), 1.0, p)
            uk, _ = redistribute(pk * h, tot, lam, available=pk > 0)
            P.loc[idx, 'u_known'] = uk
            if bool(x.next_played.iloc[0]):
                if g in ('K', 'P'):
                    ab = (x.h.values >= 0.5) & (x.next_c.values == 0) & (x.next_group_c.values > 0)
                else:
                    ab = (x.h.values * x.den_per_game.values >= MIN_EXPECTED_EVENTS) & (x.next_c.values == 0)
                po = np.where(ab, 0.0, 1.0)
                uo, _ = redistribute(po * h, tot, lam, available=~ab)
                P.loc[idx, 'u_oracle'] = uo
                P.loc[idx, 'absent'] = ab
        else:
            P.loc[idx, 'u_healthy'] = 1.0
            P.loc[idx, 'u_pregame'] = x.e.values
            P.loc[idx, 'u_report'] = np.where(np.isnan(p), x.e.values, p)
            P.loc[idx, 'u_known'] = np.where(np.isnan(p), 1.0, p)
            if bool(x.next_played.iloc[0]):
                gone = (x.next_c.values == 0) & (x.rem_c.values == 0) & (x.rem_games.values >= GONE_MIN_REMAINING) \
                    & x.in_season.values
                P.loc[idx, 'u_oracle'] = np.where(gone, 0.0, 1.0)
                own = x.prod_share.values * x.prod_team.values if 'prod_team' in x else np.zeros(len(x))
                key = (x.prod_share.values >= DEF_CHANGE_SHARE) & (own >= DEF_MIN_OWN) & \
                    (x.prod_team.values >= DEF_MIN_TEAM if 'prod_team' in x else False)
                P.loc[idx, 'absent'] = gone & key
    return P


# variant -> (upcoming lineup, reference lineup, value column).
#   V      the efficiency value (values.py: EPA / points per event above replacement x events per game)
#   V_use  the USAGE-REVEALED value of the skill groups (research alternative): the player's healthy events
#          per game (h x the group's events per game). The coach's usage choice is read as a quality signal:
#          a delta in V_use units is sum (u - b) x h x U (a share-weighted loss of usage); beta converts it to
#          points. Only RB and WR_TE carry it (K / P have one specialist; the defence is production-based).
VARIANTS = {'oracle': ('u_oracle', 'base', 'V'), 'oracle_naive': ('u_oracle', 'u_healthy', 'V'),
            'pregame': ('u_pregame', 'base', 'V'), 'report': ('u_report', 'base', 'V'),
            'oracle_use': ('u_oracle', 'base', 'V_use'), 'oracle_naive_use': ('u_oracle', 'u_healthy', 'V_use'),
            'pregame_use': ('u_pregame', 'base', 'V_use'), 'report_use': ('u_report', 'base', 'V_use'),
            # the report-path CANDIDATE: known absences only (reported OUT / QUESTIONABLE ...), relative to the
            # healthy lineup, usage-revealed value; its oracle analogue is 'oracle_naive_use'
            'report_absence_use': ('u_known', 'u_healthy', 'V_use')}
# a NEW absence (the lineup change the rating has not absorbed yet): absent for at most this many games
NEW_ABSENCE_MAX_GAMES = 2
# a KEY defender (defensive 'unit change'): >= DEF_CHANGE_SHARE of the unit's production to date, with at
# least DEF_MIN_OWN events of his own and DEF_MIN_TEAM for the team (a share of 1 sack is not a role)
DEF_MIN_OWN = 2.0
DEF_MIN_TEAM = 6.0


def deltas(P, variants=('oracle', 'oracle_naive', 'pregame')):
    """Per (team, T, unit): delta (points per game, + = the team is stronger than its rating says)
    and variance per variant, and the absence descriptors of the unit."""
    P = P.copy()
    if 'V_use' not in P.columns:
        P['V_use'] = np.where(P.group.isin(['RB', 'WR_TE']), P.h * P.den_per_game, P.V)
    for k in variants:
        u, b, vc = VARIANTS[k]
        d = (P[u].values - P[b].values)
        P['d_' + k] = d * P[vc].fillna(0.0).values
        sd = P.V_sd.fillna(0.0).values
        if vc == 'V_use':                          # the usage value carries no value SD of its own
            sd = np.where(P.group.isin(['RB', 'WR_TE']).values, 0.0, sd)
        P['v_' + k] = d ** 2 * sd ** 2
    P['abs_in_season'] = P.absent & P.in_season
    P['abs_new'] = P.abs_in_season & (P.games_missed_run + 1 <= NEW_ABSENCE_MAX_GAMES)
    P['abs_len'] = np.where(P.absent, P.games_missed_run + 1, np.nan)
    P['abs_V'] = np.where(P.absent, P.V.fillna(0.0) * P.h, 0.0)
    agg = {('d_' + k): 'sum' for k in variants}
    agg.update({('v_' + k): 'sum' for k in variants})
    agg.update({'absent': 'sum', 'abs_in_season': 'sum', 'abs_new': 'sum', 'abs_len': 'max', 'abs_V': 'sum',
                'V': lambda s: s.notna().sum(), 'pi_s': 'first', 'pi_r': 'first', 'J': 'first'})
    keys = ['season', 'team_id', 'T', 'unit'] + (['game_id'] if 'game_id' in P.columns else [])
    D = P.groupby(keys, dropna=False).agg(agg).reset_index().rename(
        columns={'absent': 'n_absent', 'abs_in_season': 'n_absent_in_season', 'abs_new': 'n_absent_new',
                 'abs_len': 'max_absence_len', 'V': 'n_valued'})
    return D


# ================================================================== live
def ol_from_reports(reports, T, next_game, team_of_report=None):
    """The OL rows of the official reports known at T (published_at, else retrieved_at, <= T; ok != false)
    for each team's NEXT game: {team_id: {ol_listed, ol_out, ol_uncertain, ol_expected_missing,
    var_inflation_pts2, status NOT_ESTIMATED, prior}}. next_game: {team_id: game_id}; a report for any
    other game is ignored. team_of_report(r) -> team id when the report carries none."""
    T = U.to_ts(T)
    out = {}
    for r in reports:
        kt = ST._known_time(r)
        if kt is None or kt > T or not ST._truthy(r.get('ok', True)):
            continue
        tid = r.get('team_id')
        tid = int(tid) if tid not in (None, '', 'None') else (team_of_report(r) if team_of_report else None)
        if tid is None or tid not in next_game or str(next_game[tid]) != str(r.get('game_id')):
            continue                                  # a report for another game is not this game's
        rows = [p for p in (r.get('rows') or r.get('players') or [])
                if POS.unit_of(POS.normalize(p.get('position'))) == 'OL']
        miss = 0.0
        n_out = n_q = 0
        for p in rows:
            sk = ST._status_key(p.get('status'))
            pp = ST.PLAY_PROBABILITY.get(sk)
            if pp is None:
                continue
            miss += 1.0 - pp * ST.GAME_FRACTION.get(sk, 1.0)
            n_out += int(pp == 0.0)
            n_q += int(0.0 < pp < 1.0)
        prev = out.get(tid)
        if prev is None or kt >= prev['known_at']:
            out[tid] = {'team_id': tid, 'game_id': str(r.get('game_id')), 'known_at': kt, 'ol_listed': len(rows),
                        'ol_out': n_out, 'ol_uncertain': n_q, 'ol_expected_missing': miss,
                        'var_inflation_pts2': OL_VAR_PER_MISSING * miss, 'status': 'NOT_ESTIMATED',
                        'prior': OL_PRIOR_NOTE}
    return out


def ol_uncertainty(season, T, availability=None, teams=None):
    """OL unit, uncertainty only (no OL player data exists). From the official reports known at T for
    each team's NEXT game: the OL players listed OUT / DOUBTFUL / QUESTIONABLE / GTD; the margin variance
    inflation is a DECLARED, UNVALIDATED prior (OL_VAR_PER_MISSING points^2 per expected missing OL
    player), flagged NOT_ESTIMATED, to be validated on live 2026 games in the Model Lab."""
    T = U.to_ts(T)
    reports = ST.load_reports(season) if availability is None else availability
    k = U.kickoffs(int(season))
    k = k[k.kickoff_ts.notna() & (k.kickoff_ts >= T)]
    allt = sorted(set(k.home_id.dropna().astype(int)) | set(k.away_id.dropna().astype(int)))
    nxt, _ = ST._next_games(season, T, teams if teams is not None else allt)
    sched = U.kickoffs(int(season))
    return ol_from_reports(reports, T, {t: g for t, (g, _) in nxt.items()},
                           lambda r: ST._report_team(r, sched, {}))


# The OL prior (DECLARED, UNVALIDATED): each expected-missing offensive lineman listed on the next game's
# official report adds OL_VAR_PER_MISSING points^2 to the margin variance of that game (both teams add).
# Reasoning, not evidence: a starting lineman's absence is plausibly worth 0-2 points of margin with an
# unknown sign of the V2.1 error it leaves (the rating contains his past games; whether he is a starter is
# unknown -- no OL participation data), so it is modelled as noise of sd 1.0 point per missing lineman.
OL_VAR_PER_MISSING = 1.0
OL_PRIOR_NOTE = ('declared prior: +1.0 pt^2 margin variance per expected-missing OL player on the next game\'s '
                 'official report; NOT_ESTIMATED -- validate on live 2026 games through the Model Lab')


def unit_state(season, T, availability=None, lam=None, teams=None, const=None):
    """Live rows, one per (team, unit): the baseline lineup the rating represents, the expected upcoming
    lineup (history, conditioned on the official reports known at T), the delta in points and its SD,
    health / continuity / depth, and the OL uncertainty row. availability: None -> the repository's
    reports; a list -> exactly those; [] -> none (every player UNKNOWN)."""
    T = U.to_ts(T)
    season = int(season)
    lam = lambda_estimate()['lambda'] if lam is None else lam
    k = U.kickoffs(season)
    k = k[k.kickoff_ts.notna() & (k.kickoff_ts >= T)]
    allt = sorted(set(k.home_id.dropna().astype(int)) | set(k.away_id.dropna().astype(int)))
    teams = allt if teams is None else [t for t in teams if t in allt]
    nxt, _ = ST._next_games(season, T, teams)
    fr = pd.DataFrame({'team_id': list(nxt), 'T': T, 'game_id': [g for g, _ in nxt.values()]})
    if not len(fr):
        return pd.DataFrame()
    P = panel(season, fr, const=const, oracle=False)
    reps = ST.load_reports(season) if availability is None else availability
    nx = {t: g for t, (g, _) in nxt.items()}
    pp, pt = ST.availability_state(season, T, nx, dict(zip(P.espn_id.astype(int), P.team_id.astype(int))),
                                   reports=reps)
    av = {}
    for (t, e), rec in pp.items():                    # expected availability = play probability x game fraction
        if rec.get('expected_availability') is not None:
            av[(int(t), int(e))] = float(rec['expected_availability'])
    for t, tm in pt.items():                           # NOT_LISTED on a comprehensive next-game report
        if tm['fresh'] and tm['comprehensive']:
            for e in P[P.team_id.eq(t)].espn_id.astype(int):
                av.setdefault((int(t), int(e)), 1.0)
    L = lineups(P, lam, availability=av)
    ol = ol_uncertainty(season, T, availability=reps, teams=teams)
    L['V_use'] = np.where(L.group.isin(['RB', 'WR_TE']), L.h * L.den_per_game, np.nan)
    ab = absence_betas()
    rows = []
    for (tid, unit), x in L.groupby(['team_id', 'unit'], sort=True):
        d, var = lineup_delta(x.base, x.u_report, x.V, x.V_sd)
        d_abs = float(np.nansum((x.u_known - x.u_healthy) * x.V_use)) if unit in ('RB', 'WR_TE') else None
        b_abs = ab.get('betas', {}).get(unit)
        # availability uncertainty: a QUESTIONABLE player is a coin flip, not half a player
        p = x.p_status.values
        av_var = float(np.nansum(np.where(np.isnan(p), 0.0, p * (1 - p)) * (x.h.values * x.V.fillna(0).values) ** 2))
        known = np.isfinite(p).any()
        strength_up = float(np.nansum(x.u_report * x.V))
        strength_h = float(np.nansum(x.u_healthy * x.V))
        strength_b = float(np.nansum(x.base * x.V))
        cont = float(np.minimum(x.u_report, x.base).sum() / x.base.sum()) if x.base.sum() > 0 else None
        lineup = [{'player_id': 'espn:%d' % r.espn_id, 'family': r.family, 'baseline': round(float(r.base), 4),
                   'expected': round(float(r.u_report), 4), 'healthy': round(float(r.u_healthy), 4),
                   'p_hist': None if pd.isna(r.p_hist) else round(float(r.p_hist), 3),
                   'play_probability': None if pd.isna(r.p_status) else float(r.p_status),
                   'value_per_game': None if pd.isna(r.V) else round(float(r.V), 3),
                   'value_sd': None if pd.isna(r.V_sd) else round(float(r.V_sd), 3)}
                  for r in x.sort_values('base', ascending=False).itertuples(index=False)
                  if r.base > 0.005 or r.u_report > 0.005]
        rows.append({'unit_state_id': 'cfbpu_' + ids.h(tid, season, T, unit, RULE), 'rule_version': RULE,
                     'as_of': ids.ts(T), 'season': season, 'team_id': int(tid), 'unit': unit,
                     'next_game_id': nx.get(int(tid)), 'knowledge': 'REPORTED' if known else 'UNKNOWN',
                     'delta_pts': d, 'delta_sd': float(np.sqrt(var + av_var)),
                     'absence_delta_use': d_abs,
                     'absence_delta_pts': (b_abs['beta'] * d_abs) if (b_abs is not None and d_abs is not None) else None,
                     'absence_beta': b_abs['beta'] if b_abs is not None else None,
                     'strength_expected': strength_up, 'strength_healthy': strength_h, 'strength_baseline': strength_b,
                     'health_pts': strength_up - strength_h, 'continuity': cont,
                     'depth_n': int((x.h * x.den_per_game.fillna(0) >= MIN_EXPECTED_EVENTS).sum())
                     if GROUPS[x.group.iloc[0]]['kind'] == 'share' else int((x.prod_share >= DEF_CHANGE_SHARE).sum()),
                     'pi_season': float(x.pi_s.iloc[0]), 'pi_recent': float(x.pi_r.iloc[0]),
                     'value_status': 'ESTIMATED' if x.V.notna().any() else 'NULL: ' + ';'.join(
                         sorted({s for s in x.value_null.dropna() if s})),
                     'lineup': json.dumps(ids.clean(lineup), sort_keys=True)})
    have = {(r['team_id'], r['unit']) for r in rows}
    for tid in sorted(set(fr.team_id)):
        o = ol.get(int(tid), {})
        rows.append({'unit_state_id': 'cfbpu_' + ids.h(tid, season, T, 'OL', RULE), 'rule_version': RULE,
                     'as_of': ids.ts(T), 'season': season, 'team_id': int(tid), 'unit': 'OL',
                     'next_game_id': nx.get(int(tid)), 'knowledge': 'REPORTED' if o else 'UNKNOWN',
                     'delta_pts': None, 'delta_sd': float(np.sqrt(o['var_inflation_pts2'])) if o else None,
                     'ol_listed': o.get('ol_listed'), 'ol_out': o.get('ol_out'), 'ol_uncertain': o.get('ol_uncertain'),
                     'ol_expected_missing': o.get('ol_expected_missing'),
                     'var_inflation_pts2': o.get('var_inflation_pts2', 0.0) if o else None,
                     'value_status': 'NOT_ESTIMATED: OL is uncertainty-only; ' + OL_PRIOR_NOTE})
        for u in ('FRONT7', 'SECONDARY'):
            if (int(tid), u) not in have:
                rows.append({'unit_state_id': 'cfbpu_' + ids.h(tid, season, T, u, RULE), 'rule_version': RULE,
                             'as_of': ids.ts(T), 'season': season, 'team_id': int(tid), 'unit': u,
                             'next_game_id': nx.get(int(tid)), 'knowledge': 'UNKNOWN', 'delta_pts': None,
                             'delta_sd': None, 'value_status': 'NULL: no RELIABLE defensive column at T '
                                                               '(usage.reliability); uncertainty-only'})
    return pd.DataFrame(rows)


def absence_betas():
    """The report-path candidate's betas (points per usage-revealed unit), fitted on the oracle absences of
    2014-2023 and frozen (backtest_units.run_dev -> units/absence_beta.json); {} until estimated."""
    f = common.out_path('personnel', 'units', 'absence_beta.json')
    try:
        return json.load(open(f))
    except (OSError, ValueError):
        return {}


def lambda_estimate():
    """The dev estimate of lam (backtest_units.estimate_lambda), else the declared default."""
    f = common.out_path('personnel', 'units', 'lambda.json')
    try:
        return json.load(open(f))
    except (OSError, ValueError):
        return {'lambda': LAMBDA_DEFAULT, 'basis': 'declared default (no dev estimate on disk)'}
