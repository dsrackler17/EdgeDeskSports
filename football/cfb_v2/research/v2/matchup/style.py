"""Style: HOW a team plays, as continuous, game-state- and opponent-adjusted, point-in-time
numbers (docs/cfb-matchup/METHODS.md sections 2-4).

    python3 -m v2.matchup.style [seasons...]   -> $CFB_V2_OUT/matchup/style/

Pipeline (every step reads only what is older than what it feeds):

 1. plays_S: a compact per-play frame from the PBP with V2's cleaning (possession known,
    provider duplicates out, V2's DECLARED garbage rule). No market / WP column is read.
 2. League expectation models, fit on the three seasons BEFORE S (2009-2011 burn-in pooled
    for seasons <= 2011, which only feed priors and variance components, never a scored row):
      xpass  P(dropback | down, distance, field position, score, quarter, clock), downs 1-3
      xgo    P(go for it | distance, field position, score, quarter, clock), 4th-down decisions
    Pass rate over expectation (PROE) is what a team CHOSE beyond what the situation forced.
 3. team_game_S: per (game, offense) SUMS (never pre-divided): PROE overall / neutral / early
    down neutral / passing downs; QB rushes (rusher = a passer with >= 2 dropbacks in the game;
    designed runs and scrambles cannot be separated in this feed); neutral tempo (drive clock
    seconds per offensive play on drives that start in a neutral state); 4th-down go rate over
    expected; early-down and passing-down EPA; 3rd-down distance; short-yardage conversion.
 4. Opponent-adjusted ratings with V2's joint Gaussian solver (ratings.fit_metric):
        y = mu + o_offense + d_defense + h * H + e
    solved at every freeze T from games that kicked off before T, with a preseason prior per
    team (last season's data-only rating, the season before, coordinator / head-coach change and
    their interactions with last season: scheme continuity, section 24-25). The defensive
    rating of a BEHAVIOR metric is the opponent response: how much more (or less) offenses do
    it against this defense. The posterior SD is style_uncertainty.

Style and quality are kept apart: behavior metrics (proe, neu_pass, ed_proe, pd_proe,
qb_rush_rate, tempo, go_oe) carry no better/worse direction; efficiency metrics do.
"""
import json
import os
import sys
import time

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import plays as V2P
from .. import ratings as R
from .. import build_ratings as BR
from . import STYLE_VERSION
from .audit import FORBIDDEN

# --------------------------------------------------------------- declared constants
NEUTRAL_MAX_DIFF = 10          # |score margin| <= 10 at the snap
NEUTRAL_PERIODS = (1, 2, 3)
NEUTRAL_MIN_HALF_SECS = 120    # not inside the last two minutes of a half
QB_MIN_DROPBACKS = 2           # a rusher is a QB if he has >= 2 dropbacks for the team in the game
SHORT_YARDAGE = 2              # 3rd/4th and <= 2
DIST3_CAP = 20
TEMPO_MAX_SECS = 60.0          # a drive's seconds per play is capped (injury / review stoppages)
PRIOR_SCALE = 2.0              # V2 RATING_PRIOR_SCALE['_default'] (declared, not tuned here)
PRIOR_RIDGE = 0.02             # ridge on the prior model (V2 build_prior: 2 * n * 0.01)
PRIOR_DECAY = 0.85             # recency weight of prior-model training seasons (V2)
BURN_IN = (2009, 2010, 2011)

PLAY_COLS = ['game_id', 'season', 'week', 'pos_team_id', 'def_pos_team_id', 'game_play_number', 'drive.id',
             'period', 'start.TimeSecsRem', 'start.pos_score_diff', 'down', 'distance', 'start.yardsToEndzone',
             'rush', 'pass', 'sack', 'penalty_no_play', 'EPA', 'EPA_success', 'EPA_explosive', 'first_down_created',
             'touchdown', 'passer_player_id', 'rusher_player_id', 'punt', 'fg_attempt', 'kneel_down', 'text_dupe',
             'statYardage', 'passing_down', 'drive.timeElapsed.displayValue', 'int', 'fumble_lost']
assert not set(PLAY_COLS) & (set(V2P.FORBIDDEN_PBP_COLUMNS) | set(FORBIDDEN))

# (name, numerator, denominator, kind); kind 'behavior' has no better/worse direction
STYLE_METRICS = [
    ('proe', 'proe_num', 'n13', 'behavior'),
    ('neu_pass', 'pass_neu', 'n_neu', 'behavior'),
    ('ed_proe', 'ed_proe_num', 'n_edn', 'behavior'),
    ('pd_proe', 'pd_proe_num', 'n_pd13', 'behavior'),
    ('qb_rush_rate', 'n_qbrush', 'n_qbact', 'behavior'),
    ('tempo', 'secs_neu', 'plays_neu', 'behavior'),
    ('go_oe', 'go_oe_num', 'n_4dec', 'behavior'),
    ('qb_rush_epa', 'epa_qbrush_sum', 'n_qbrush', 'efficiency'),
    ('epa_early', 'epa_early_sum', 'n_early', 'efficiency'),
    ('epa_pd', 'epa_pd_sum', 'n_pd', 'efficiency'),
    ('third_dist', 'dist3_sum', 'n_3rd', 'efficiency'),
    ('sy_conv', 'sy_conv', 'n_sy', 'efficiency'),
]
METRIC_NAMES = [m[0] for m in STYLE_METRICS]
BEHAVIOR = {m[0] for m in STYLE_METRICS if m[3] == 'behavior'}
NEGATIVE = {'third_dist'}                    # higher offensive value = worse for the offense
PASS_SPLIT = {'proe', 'neu_pass', 'ed_proe', 'pd_proe', 'qb_rush_rate', 'qb_rush_epa', 'n_qbrush'}
SUM_COLS = ['n13', 'pass13', 'xp13', 'proe_num', 'n_neu', 'pass_neu', 'xp_neu', 'n_edn', 'pass_edn', 'xp_edn',
            'ed_proe_num', 'n_pd13', 'pass_pd13', 'xp_pd13', 'pd_proe_num', 'n_qbact', 'n_qbrush', 'epa_qbrush_sum',
            'qbrush_pd', 'n_early', 'epa_early_sum', 'n_pd', 'epa_pd_sum', 'n_3rd', 'dist3_sum', 'n_sy', 'sy_conv',
            'n_4dec', 'go4', 'xgo4', 'go_oe_num', 'secs_neu', 'plays_neu', 'n_drives_neu']


def style_dir(*parts):
    return common.out_path('matchup', 'style', *parts)


def _b(s):
    return s.fillna(False).astype(bool)


def _secs(x):
    try:
        m, s = str(x).split(':')
        return int(m) * 60 + int(s)
    except Exception:
        return np.nan


# =================================================================== 1. plays
def extract_plays(S):
    """Compact per-play frame for season S (V2's cleaning; garbage flagged, not dropped)."""
    import pyarrow.parquet as pq
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % S)
    names = set(pq.ParquetFile(f).schema_arrow.names)
    d = pd.read_parquet(f, columns=[c for c in PLAY_COLS if c in names])
    for c in PLAY_COLS:
        if c not in d:
            d[c] = np.nan
    d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()].copy()
    d = d[~_b(d.text_dupe)]
    per = pd.to_numeric(d.period, errors='coerce').fillna(1).astype(int)
    sd = pd.to_numeric(d['start.pos_score_diff'], errors='coerce')
    out = pd.DataFrame({
        'game_id': pd.to_numeric(d.game_id, errors='coerce').astype('int64'),
        'team_id': d.pos_team_id.astype('int64'), 'opp_id': d.def_pos_team_id.astype('int64'),
        'play_no': pd.to_numeric(d.game_play_number, errors='coerce'),
        'drive_id': d['drive.id'].astype(str).where(d['drive.id'].notna(), None),
        'period': per.values, 'secs': pd.to_numeric(d['start.TimeSecsRem'], errors='coerce').values,
        'sd': sd.values, 'down': pd.to_numeric(d.down, errors='coerce').values,
        'dist': pd.to_numeric(d.distance, errors='coerce').values,
        'ytg': pd.to_numeric(d['start.yardsToEndzone'], errors='coerce').values,
        'is_rush': _b(d.rush).values, 'is_pass': _b(d['pass']).values, 'is_sack': _b(d.sack).values,
        'no_play': _b(d.penalty_no_play).values, 'epa': pd.to_numeric(d.EPA, errors='coerce').values,
        'succ': _b(d.EPA_success).values, 'expl': _b(d.EPA_explosive).values,
        'conv': (_b(d.first_down_created) | _b(d.touchdown)).values,
        'passer': pd.to_numeric(d.passer_player_id, errors='coerce').values,
        'rusher': pd.to_numeric(d.rusher_player_id, errors='coerce').values,
        'punt': _b(d.punt).values, 'fga': _b(d.fg_attempt).values, 'kneel': _b(d.kneel_down).values,
        'yds': pd.to_numeric(d.statYardage, errors='coerce').values, 'pdown': _b(d.passing_down).values,
        'drive_secs': d['drive.timeElapsed.displayValue'].map(_secs).values,
    })
    out['garbage'] = common.garbage_mask(out.period.values, np.nan_to_num(out.sd.values, nan=0.0))
    out['scrim'] = (out.is_rush | out.is_pass) & ~out.no_play & np.isfinite(out.epa)
    out['season'] = S
    return out.reset_index(drop=True)


def pbp_signature(S):
    """The season's PBP file identity (size, mtime): a changed file (a live season's new games, a provider
    correction) invalidates every cache derived from it."""
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % S)
    st = os.stat(f)
    return {'file': os.path.basename(f), 'size': int(st.st_size), 'mtime_ns': int(st.st_mtime_ns),
            'style_version': STYLE_VERSION}


def _cache_ok(f, S):
    sf = f.replace('.parquet', '.sig.json')
    return os.path.exists(f) and os.path.exists(sf) and json.load(open(sf)) == pbp_signature(S)


def _cache_write(frame, f, S):
    frame.to_parquet(f, index=False)
    common.write_json(f.replace('.parquet', '.sig.json'), pbp_signature(S))


def plays(S, refresh=False):
    f = style_dir('cache', 'plays_%d.parquet' % S)
    if not refresh and _cache_ok(f, S):
        return pd.read_parquet(f)
    P = extract_plays(S)
    _cache_write(P, f, S)
    return P


# ================================================ 2. league expectation models
def xpass_design(P):
    """Declared game-state design for P(dropback). Downs 1-3."""
    down = P.down.values
    dist = np.clip(np.nan_to_num(P.dist.values, nan=10.0), 1, 30)
    ytg = np.clip(np.nan_to_num(P.ytg.values, nan=70.0), 1, 99)
    sd = np.clip(np.nan_to_num(P.sd.values, nan=0.0), -28, 28) / 14.0
    per = np.minimum(P.period.values, 4)
    secs = np.clip(np.nan_to_num(P.secs.values, nan=900.0), 0, 1800) / 1800.0
    ld = np.log(dist)
    d2, d3 = (down == 2).astype(float), (down == 3).astype(float)
    q2, q3, q4 = (per == 2).astype(float), (per == 3).astype(float), (per == 4).astype(float)
    two_min = (secs * 1800 <= 120).astype(float) * ((per == 2) | (per == 4))
    X = np.column_stack([
        d2, d3, ld, ld * d2, ld * d3, (dist >= 10).astype(float), ytg / 100.0, (dist >= ytg).astype(float),
        (ytg <= 5).astype(float), (ytg <= 20).astype(float), (ytg >= 90).astype(float),
        sd, sd ** 2, np.abs(sd) * (sd < 0), q2, q3, q4, secs, q4 * sd, q4 * sd * (1 - secs * 2),
        two_min, two_min * (sd < 0), (P.period.values >= 5).astype(float)])
    return X


def xgo_design(P):
    dist = np.clip(np.nan_to_num(P.dist.values, nan=5.0), 1, 30)
    ytg = np.clip(np.nan_to_num(P.ytg.values, nan=70.0), 1, 99)
    sd = np.clip(np.nan_to_num(P.sd.values, nan=0.0), -28, 28) / 14.0
    per = np.minimum(P.period.values, 4)
    secs = np.clip(np.nan_to_num(P.secs.values, nan=900.0), 0, 1800) / 1800.0
    q4 = (per == 4).astype(float)
    return np.column_stack([
        np.log(dist), (dist <= 1).astype(float), (dist <= 3).astype(float), ytg / 100.0, (ytg <= 35).astype(float),
        (ytg <= 45).astype(float), (ytg >= 60).astype(float), (ytg <= 5).astype(float), sd, q4, q4 * sd,
        q4 * (sd < 0) * (1 - secs * 2), (per == 2).astype(float) * (secs * 1800 <= 120), (P.period.values >= 5).astype(float)])


def std13(P):
    """Downs 1-3 scrimmage plays that count for style: non-garbage, no kneel-downs."""
    return P[P.scrim & ~P.garbage & ~P.kneel & P.down.isin([1, 2, 3])]


def fourth_decisions(P):
    """4th-down decisions: went for it (a scrimmage snap, penalties aside) vs punt / field goal.
    Excluded: garbage, and trailing in the last 5:00 of the 4th quarter (no real choice)."""
    q = P[(P.down == 4) & ~P.garbage & ~P.no_play & ~P.kneel]
    go = (q.is_rush | q.is_pass) & np.isfinite(q.epa)
    kick = q.punt | q.fga
    q = q[go | kick].copy()
    q['go'] = ((q.is_rush | q.is_pass) & np.isfinite(q.epa)).astype(float)
    desperate = (q.period >= 4) & (np.nan_to_num(q.secs.values, nan=900) <= 300) & (np.nan_to_num(q.sd.values) < 0)
    return q[~desperate]


def _fit_logit(X, y, C_=1.0):
    from sklearn.linear_model import LogisticRegression
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd[sd == 0] = 1.0
    m = LogisticRegression(C=C_, max_iter=1000, solver='lbfgs')
    m.fit((X - mu) / sd, y)
    return {'mu': mu.tolist(), 'sd': sd.tolist(), 'coef': m.coef_[0].tolist(), 'intercept': float(m.intercept_[0])}


def _predict_logit(model, X):
    z = ((X - np.array(model['mu'])) / np.array(model['sd'])) @ np.array(model['coef']) + model['intercept']
    return 1.0 / (1.0 + np.exp(-z))


def expectation_window(S):
    """Training seasons of the league expectation models for season S."""
    if S <= max(BURN_IN):
        return list(BURN_IN)
    return [S - 3, S - 2, S - 1]


def expectation_models(S, refresh=False):
    f = style_dir('models', 'expect_%d.json' % S)
    if os.path.exists(f) and not refresh:
        return json.load(open(f))
    win = expectation_window(S)
    tr = [plays(s) for s in win]
    A = pd.concat([std13(p) for s, p in zip(win, tr) if s not in V2P.SACKS_UNTAGGED], ignore_index=True)
    F = pd.concat([fourth_decisions(p) for p in tr], ignore_index=True)
    mp = _fit_logit(xpass_design(A), A.is_pass.values.astype(int))
    mg = _fit_logit(xgo_design(F), F.go.values.astype(int))
    out = {'season': S, 'train_seasons': win, 'style_version': STYLE_VERSION,
           'xpass': mp, 'xgo': mg, 'n_xpass': int(len(A)), 'n_xgo': int(len(F)),
           'xpass_base_rate': float(A.is_pass.mean()), 'xgo_base_rate': float(F.go.mean())}
    common.write_json(f, out)
    return out


# ======================================================== 3. team-game sums
def neutral_mask(P):
    return (P.period.isin(NEUTRAL_PERIODS) & (np.abs(np.nan_to_num(P.sd.values, nan=99)) <= NEUTRAL_MAX_DIFF)
            & (np.nan_to_num(P.secs.values, nan=0) > NEUTRAL_MIN_HALF_SECS))


def team_game_sums(S, P=None, models=None):
    """Per (game, offense team) style sums for season S (see module docstring)."""
    P = plays(S) if P is None else P
    models = expectation_models(S) if models is None else models
    key = ['game_id', 'team_id']
    s = P[P.scrim & ~P.garbage].copy()
    t = std13(P).copy()
    t['xp'] = _predict_logit(models['xpass'], xpass_design(t))
    t['neu'] = neutral_mask(t)
    t['edn'] = t.neu & t.down.isin([1, 2])
    t['p'] = t.is_pass.astype(float)
    g = lambda frame, col: frame.groupby(key)[col].sum() if col else frame.groupby(key).size().astype(float)
    parts = {
        'n13': g(t, None), 'pass13': g(t, 'p'), 'xp13': g(t, 'xp'),
        'n_neu': g(t[t.neu], None), 'pass_neu': g(t[t.neu], 'p'), 'xp_neu': g(t[t.neu], 'xp'),
        'n_edn': g(t[t.edn], None), 'pass_edn': g(t[t.edn], 'p'), 'xp_edn': g(t[t.edn], 'xp'),
        'n_pd13': g(t[t.pdown], None), 'pass_pd13': g(t[t.pdown], 'p'), 'xp_pd13': g(t[t.pdown], 'xp'),
    }
    # QB rushes: the rusher threw >= 2 passes (dropbacks with a passer id) for the team in the game
    db = s[s.is_pass & np.isfinite(s.passer)]
    pc = db.groupby(['game_id', 'team_id', 'passer']).size()
    qbset = pc[pc >= QB_MIN_DROPBACKS].reset_index()[['game_id', 'team_id', 'passer']]
    qbset.columns = ['game_id', 'team_id', 'rusher']
    r = s[s.is_rush & ~s.kneel].merge(qbset.assign(isqb=True), on=['game_id', 'team_id', 'rusher'], how='left')
    r['isqb'] = r.isqb.fillna(False).astype(bool)
    qr = r[r.isqb]
    parts.update({'n_qbrush': g(qr, None), 'epa_qbrush_sum': g(qr, 'epa'), 'qbrush_pd': g(qr[qr.pdown], None)})
    parts['n_qbact'] = parts['n_qbrush'].add(g(s[s.is_pass], None), fill_value=0.0)
    early = s[s.down.isin([1, 2])]
    parts.update({'n_early': g(early, None), 'epa_early_sum': g(early, 'epa'),
                  'n_pd': g(s[s.pdown], None), 'epa_pd_sum': g(s[s.pdown], 'epa')})
    th = s[s.down.eq(3)].copy()
    th['d3'] = np.clip(th.dist, 0, DIST3_CAP)
    parts.update({'n_3rd': g(th, None), 'dist3_sum': g(th, 'd3')})
    sy = s[s.down.isin([3, 4]) & (s.dist <= SHORT_YARDAGE)].copy()
    sy['c'] = sy.conv.astype(float)
    parts.update({'n_sy': g(sy, None), 'sy_conv': g(sy, 'c')})
    F = fourth_decisions(P).copy()
    F['xgo'] = _predict_logit(models['xgo'], xgo_design(F))
    parts.update({'n_4dec': g(F, None), 'go4': g(F, 'go'), 'xgo4': g(F, 'xgo')})
    # neutral tempo: drive clock seconds per offensive snap, drives that START in a neutral state
    dv = P[(P.is_rush | P.is_pass) & P.drive_id.notna()].sort_values(['game_id', 'play_no'], kind='mergesort')
    dg = dv.groupby(['game_id', 'drive_id'])
    D = pd.DataFrame({'team_id': dg.team_id.agg(lambda x: x.mode().iloc[0]), 'snaps': dg.size(),
                      'secs_el': dg.drive_secs.first(), 'period': dg.period.first(), 'sd': dg.sd.first(),
                      'secs': dg.secs.first(), 'garbage': dg.garbage.first()}).reset_index()
    D = D[(D.snaps >= 3) & (D.secs_el > 0) & ~D.garbage]
    D = D[neutral_mask(D)]
    D['spp'] = np.minimum(D.secs_el / D.snaps, TEMPO_MAX_SECS)
    D['secs_w'] = D.spp * D.snaps
    parts.update({'secs_neu': g(D, 'secs_w'), 'plays_neu': g(D, 'snaps'), 'n_drives_neu': g(D, None)})
    out = pd.DataFrame(parts)
    out.index = out.index.set_names(key)
    out = out.reset_index()
    for c in SUM_COLS:
        if c not in out:
            out[c] = np.nan
    cnt = [c for c in SUM_COLS if c.startswith('n_') or c in ('n13', 'pass13', 'xp13', 'plays_neu', 'secs_neu', 'go4',
                                                                   'xgo4', 'sy_conv', 'qbrush_pd', 'dist3_sum')]
    out[cnt] = out[cnt].fillna(0.0)
    for c in ('pass_neu', 'xp_neu', 'pass_edn', 'xp_edn', 'pass_pd13', 'xp_pd13', 'epa_qbrush_sum', 'epa_early_sum',
              'epa_pd_sum'):
        out[c] = out[c].fillna(0.0)
    out['proe_num'] = out.pass13 - out.xp13
    out['ed_proe_num'] = out.pass_edn - out.xp_edn
    out['pd_proe_num'] = out.pass_pd13 - out.xp_pd13
    out['go_oe_num'] = out.go4 - out.xgo4
    if S in V2P.SACKS_UNTAGGED:        # sacks filed as rushes: every pass/rush split is contaminated
        for c in ('proe_num', 'pass_neu', 'ed_proe_num', 'pd_proe_num', 'n_qbrush', 'epa_qbrush_sum', 'pass13',
                  'pass_edn', 'pass_pd13', 'n_qbact'):
            out[c] = np.nan
    opp = P.groupby(key).opp_id.agg(lambda x: x.mode().iloc[0])
    out['opp_id'] = [opp.get((a, b), np.nan) for a, b in zip(out.game_id, out.team_id)]
    out['season'] = S
    return out


def team_games(S, refresh=False):
    f = style_dir('cache', 'team_game_%d.parquet' % S)
    if not refresh and _cache_ok(f, S):
        return pd.read_parquet(f)
    T = team_game_sums(S)
    _cache_write(T, f, S)
    return T


# ===================================================== 4. opponent-adjusted ratings
def load_tg(seasons):
    """Team-game style sums joined to the V2 stage-2 schedule (FINAL games only), in V2's
    stage-3 layout (team_id, opp_id, H, kickoff_ts, g_season)."""
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    TG = pd.concat([team_games(S) for S in seasons], ignore_index=True)
    TG = TG.merge(G[['game_id', 'kickoff_ts', 'home_id', 'away_id', 'neutral_site', 'status', 'season']]
                  .rename(columns={'season': 'g_season'}), on='game_id', how='inner')
    TG = TG[TG.status.eq('FINAL') & TG.opp_id.notna()].copy()
    TG['opp_id'] = TG.opp_id.astype('int64')
    TG['H'] = np.where(TG.neutral_site, 0, np.where(TG.team_id.eq(TG.home_id), 1, -1)).astype(float)
    return TG, G


def specs():
    return {m: (num, den, 'rate') for m, num, den, _ in STYLE_METRICS}


def varcomp(TG, sp):
    """Variance components per metric from the burn-in seasons only (V2 stage 3's method)."""
    vc = {}
    burn = TG[TG.g_season.isin(BURN_IN)]
    for m, spec in sp.items():
        rr = []
        for S, tg in burn.groupby('g_season'):
            y, n, ok = R.metric_obs(tg, spec[0], spec[1], spec[2])
            if ok.sum() < 50:
                continue
            spread = float(np.var(y))
            pr = BR.weak_prior(set(tg.team_id) | set(tg.opp_id), spread, spread)
            _, res = R.fit_metric(tg, m, spec, (spread * np.median(n), spread * 0.5), pr)
            rr.append(res)
        vc[m] = R.estimate_varcomp(pd.concat(rr))
    return vc


def data_only_finals(TG, sp, vc, seasons, FBS):
    final, between = {}, {m: [] for m in sp}
    for S in seasons:
        tg = TG[TG.g_season.eq(S)]
        if tg.empty:
            continue
        final[S] = {}
        for m, spec in sp.items():
            y, n, ok = R.metric_obs(tg, spec[0], spec[1], spec[2])
            if ok.sum() < 50:
                continue
            big = float(np.var(y)) * 2.0
            pr = BR.weak_prior(set(tg.team_id) | set(tg.opp_id), big, big)
            fit, _ = R.fit_metric(tg, m, spec, vc[m], pr, want_var=True)
            final[S][m] = {'off': fit.off, 'def': fit['def'], 'off_var': fit.off_var, 'def_var': fit.def_var}
            fb = [t for t in fit.index if t in FBS.get(S, set())]
            between[m].append((S, fit.loc[fb, 'off'].var(), fit.loc[fb, 'def'].var(),
                               fit.loc[fb, 'off_var'].mean(), fit.loc[fb, 'def_var'].mean()))
    return final, between


PRIOR_COLS = ['lag1', 'lag2', 'lag1_unit', 'unit_change', 'hc_new', 'lag1_hc', 'ret', 'lag1_ret',
              'm_lag1', 'm_lag2', 'm_coach', 'm_ret']


def prior_design(rows, side):
    """V2's explicit missing-value policy (mean-impute + flag), plus the scheme-continuity
    interaction lag1 x coordinator change (the question of section 24-25: does last season's
    style carry over less when the coordinator changed?)."""
    X = pd.DataFrame(index=rows.index)
    l1, l2 = rows['%s_lag1' % side], rows['%s_lag2' % side]
    ret = rows['ret_%s' % side]
    uc = rows['%s_change' % ('oc' if side == 'off' else 'dc')]
    X['m_lag1'], X['m_lag2'] = l1.isna().astype(float), l2.isna().astype(float)
    X['m_coach'], X['m_ret'] = rows.hc_new.isna().astype(float), ret.isna().astype(float)
    X['lag1'], X['lag2'] = l1.fillna(0.0), l2.fillna(0.0)
    X['unit_change'] = uc.fillna(0.0)
    X['lag1_unit'] = X.lag1 * X.unit_change
    X['hc_new'] = rows.hc_new.fillna(0.0)
    X['lag1_hc'] = X.lag1 * X.hc_new
    X['ret'] = (ret - 0.6).fillna(0.0)
    X['lag1_ret'] = X.lag1 * X.ret
    return X[PRIOR_COLS]


def style_prior(S, m, teams_s, fbs, final, FBS, RP, TT, CO, true_var, season_start, explain=None):
    """Preseason prior of style metric m for season S (structure of V2 build_ratings.build_prior:
    ridge on target seasons < S, residual variance = prior variance, pooled non-FBS prior)."""
    tvo, tvd = true_var
    pr = {'o': {}, 'd': {}, 'tau2_o': {}, 'tau2_d': {}, 'season_start': season_start, 'h': (0.0, max(tvo, tvd))}
    fo, fd = [], []
    for L in (1, 2, 3):
        f = final.get(S - L, {}).get(m)
        if f is None:
            continue
        nf = [t for t in f['off'].index if t not in FBS.get(S - L, set())]
        fo.extend(f['off'].loc[nf].values)
        fd.extend(f['def'].loc[nf].values)
    fcs_o = (float(np.mean(fo)) if fo else 0.0, float(np.var(fo)) if len(fo) > 5 else tvo * 4)
    fcs_d = (float(np.mean(fd)) if fd else 0.0, float(np.var(fd)) if len(fd) > 5 else tvd * 4)
    pr['default_o'], pr['tau2_default_o'] = fcs_o[0], max(fcs_o[1], tvo) * PRIOR_SCALE
    pr['default_d'], pr['tau2_default_d'] = fcs_d[0], max(fcs_d[1], tvd) * PRIOR_SCALE
    for t in teams_s:
        if t not in fbs:
            pr['o'][t] = (pr['default_o'],); pr['tau2_o'][t] = pr['tau2_default_o']
            pr['d'][t] = (pr['default_d'],); pr['tau2_d'][t] = pr['tau2_default_d']
    fb = sorted(fbs)
    train = []
    for Sp in range(C.FIRST_PBP_SEASON + 1, S):
        tgt = final.get(Sp, {}).get(m)
        if tgt is None:
            continue
        rows = BR._prior_frame(Sp, sorted(FBS.get(Sp, set())), final, m, RP, TT, CO)
        rows = rows[rows.team_id.isin(tgt['off'].index)]
        rows['y_off'] = rows.team_id.map(tgt['off']); rows['y_def'] = rows.team_id.map(tgt['def'])
        rows['v_off'] = rows.team_id.map(tgt['off_var']); rows['v_def'] = rows.team_id.map(tgt['def_var'])
        train.append(rows)
    cur = BR._prior_frame(S, fb, final, m, RP, TT, CO)
    for side, key, tv in (('off', 'o', tvo), ('def', 'd', tvd)):
        if not train:
            for t in fb:
                pr[key][t] = (0.0,); pr['tau2_' + key][t] = tv * PRIOR_SCALE
            continue
        tr = pd.concat(train, ignore_index=True).dropna(subset=['y_' + side])
        X = prior_design(tr, side).values
        y = tr['y_' + side].values
        w = PRIOR_DECAY ** (S - 1 - tr.season.values)
        # ridge on STANDARDIZED columns (a penalty on raw columns would crush the coefficients of
        # small-scale metrics such as PROE, SD ~0.08, while leaving tempo, SD ~3 s, untouched)
        csd = np.sqrt(np.average((X - np.average(X, axis=0, weights=w)) ** 2, axis=0, weights=w))
        csd[csd < 1e-9] = 1.0
        bs = BR.ridge_fit(X / csd, y, w, alpha=PRIOR_RIDGE * len(y))
        beta = np.concatenate([[bs[0]], bs[1:] / csd])
        resid = y - np.column_stack([np.ones(len(X)), X]) @ beta
        tau2 = max(np.average(resid ** 2, weights=w) - np.average(tr['v_' + side].values, weights=w), 0.15 * tv)
        miss = tr['%s_lag1' % side].isna().values
        tau2_miss = max(np.mean(resid[miss] ** 2) - np.mean(tr['v_' + side].values[miss]), tau2) \
            if miss.sum() >= 10 else tau2 * 2.0
        Xc = prior_design(cur, side).values
        pc = np.column_stack([np.ones(len(Xc)), Xc]) @ beta
        cmiss = cur['%s_lag1' % side].isna().values
        for t, p, mi in zip(cur.team_id.values, pc, cmiss):
            pr[key][t] = (float(p),)
            pr['tau2_' + key][t] = float((tau2_miss if mi else tau2) * PRIOR_SCALE)
        if explain is not None:
            explain[side] = {'beta': dict(zip(['const'] + PRIOR_COLS, [float(b) for b in beta])),
                             'tau2': float(tau2), 'tau2_miss': float(tau2_miss), 'n_train': int(len(y))}
    return pr


def build(seasons_out=None, verbose=True, refresh=False):
    """Everything: plays -> models -> team-game sums -> varcomp -> finals -> priors -> ratings
    at every freeze of seasons_out. Writes style/ratings_<S>.parquet, league_<S>.parquet,
    finals.parquet, priors.json, varcomp.json."""
    t0 = time.time()
    all_seasons = list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
    for S in all_seasons:
        plays(S, refresh=refresh)
        expectation_models(S, refresh=refresh)
        team_games(S, refresh=refresh)
        if verbose:
            print('[style] sums %d  %.0fs' % (S, time.time() - t0), flush=True)
    TG, G = load_tg(all_seasons)
    FBS = BR.fbs_teams_by_season(G)
    RP, TT, CO = BR.load_prior_inputs()
    sp = specs()
    vc = varcomp(TG, sp)
    common.write_json(style_dir('varcomp.json'), {k: list(v) for k, v in vc.items()})
    final, between = data_only_finals(TG, sp, vc, [s for s in all_seasons if s != C.LIVE_SEASON], FBS)
    rows = []
    for S, mm in final.items():
        for m, f in mm.items():
            df = pd.DataFrame({'off': f['off'], 'def': f['def'], 'off_var': f['off_var'], 'def_var': f['def_var']})
            df['season'], df['metric'] = S, m
            rows.append(df.reset_index())
    pd.concat(rows).to_parquet(style_dir('finals.parquet'), index=False)
    true_var = {}
    for m, lst in between.items():
        a = np.array([x[1:] for x in lst if x[0] in BURN_IN] or [[1, 1, 0, 0]], dtype=float)
        true_var[m] = (max(1e-8, np.mean(a[:, 0] - a[:, 2])), max(1e-8, np.mean(a[:, 1] - a[:, 3])))
    seasons_out = seasons_out or list(range(C.FIRST_SNAPSHOT_SEASON, C.LIVE_SEASON + 1))
    prior_explain = {}
    for S in seasons_out:
        fbs = FBS.get(S, set())
        tg_s = TG[TG.g_season.eq(S)]
        g_s = G[G.season.eq(S)]
        teams_s = sorted(set(g_s.home_id) | set(g_s.away_id))
        season_start = g_s.kickoff_ts.min() - pd.Timedelta(days=3)
        priors = {}
        for m in sp:
            ex = {}
            priors[m] = style_prior(S, m, teams_s, fbs, final, FBS, RP, TT, CO, true_var[m], season_start, explain=ex)
            prior_explain['%d/%s' % (S, m)] = ex
        out_rows, league_rows = [], []
        for T in sorted(g_s.prediction_ts.unique()):
            T = pd.Timestamp(T)
            obs = tg_s[tg_s.kickoff_ts < T]
            assert (obs.kickoff_ts < T).all()
            for m, spec in sp.items():
                pr = priors[m]
                y, n, ok = R.metric_obs(obs, spec[0], spec[1], spec[2]) if len(obs) else (None, None, None)
                if obs.empty or ok.sum() == 0:
                    df = pd.DataFrame(index=pd.Index(teams_s, name='team_id'))
                    df['off'] = [pr['o'].get(t, (pr['default_o'],))[0] for t in teams_s]
                    df['def'] = [pr['d'].get(t, (pr['default_d'],))[0] for t in teams_s]
                    df['off_var'] = [pr['tau2_o'].get(t, pr['tau2_default_o']) for t in teams_s]
                    df['def_var'] = [pr['tau2_d'].get(t, pr['tau2_default_d']) for t in teams_s]
                    df['n_obs_off'] = 0.0; df['n_obs_def'] = 0.0; df['n_eff_off'] = 0.0
                    mu, h = np.nan, pr['h'][0]
                else:
                    df, _ = R.fit_metric(obs, m, spec, vc[m], pr, want_var=True)
                    mu, h = df.attrs['mu'], df.attrs['h']
                df = df.reset_index()
                df['metric'], df['prediction_ts'] = m, T
                df['prior_off'] = df.team_id.map(lambda t: pr['o'].get(t, (pr['default_o'],))[0])
                df['prior_def'] = df.team_id.map(lambda t: pr['d'].get(t, (pr['default_d'],))[0])
                df['prior_off_var'] = df.team_id.map(lambda t: pr['tau2_o'].get(t, pr['tau2_default_o']))
                df['prior_def_var'] = df.team_id.map(lambda t: pr['tau2_d'].get(t, pr['tau2_default_d']))
                out_rows.append(df)
                league_rows.append((T, m, mu, h, int(len(obs))))
        R_S = pd.concat(out_rows, ignore_index=True)
        R_S['season'] = S
        R_S['style_version'] = STYLE_VERSION
        L_S = pd.DataFrame(league_rows, columns=['prediction_ts', 'metric', 'mu', 'h', 'n_rows'])
        L_S['season'] = S
        R_S.to_parquet(style_dir('ratings_%d.parquet' % S), index=False)
        L_S.to_parquet(style_dir('league_%d.parquet' % S), index=False)
        if verbose:
            print('[style] ratings %d: %d freezes, %d rows, %.0fs' % (S, L_S.prediction_ts.nunique(), len(R_S),
                                                                     time.time() - t0), flush=True)
    common.write_json(style_dir('priors_explain.json'), prior_explain)
    common.write_json(style_dir('true_var.json'), {k: list(v) for k, v in true_var.items()})
    return final


# ============================================================ readers (downstream)
def ratings(S):
    return pd.read_parquet(style_dir('ratings_%d.parquet' % S))


def league(S):
    return pd.read_parquet(style_dir('league_%d.parquet' % S))


def finals():
    return pd.read_parquet(style_dir('finals.parquet'))


def metric_scales(S, metrics=None):
    """Robust between-team SD (IQR/1.349, offence and defence averaged) of each style metric's
    data-only final ratings over seasons S-3..S-1 (V2 snapshots.metric_scales' rule)."""
    fd = finals()
    fd = fd[fd.season.between(S - 3, S - 1)]
    sc = {}
    for m, g in fd.groupby('metric'):
        iqr = lambda x: float(np.subtract(*np.nanpercentile(x, [75, 25]))) / 1.349
        sc[m] = max(1e-6, (iqr(g.off) + iqr(g['def'])) / 2.0)
    return sc


def wide(S):
    """(prediction_ts, team_id) x [<metric>__off/def/off_var/def_var/n_obs_off/prior_off/prior_def]."""
    Rt = ratings(S)
    cols = ['off', 'def', 'off_var', 'def_var', 'n_obs_off', 'n_obs_def', 'prior_off', 'prior_def']
    W = Rt.pivot_table(index=['prediction_ts', 'team_id'], columns='metric', values=cols, aggfunc='first')
    W.columns = ['s_%s__%s' % (m, c) for c, m in W.columns]
    Lg = league(S).pivot_table(index='prediction_ts', columns='metric', values=['mu', 'h'], aggfunc='first')
    Lg.columns = ['slg_%s__%s' % (m, c) for c, m in Lg.columns]
    return W, Lg


def split_half_reliability(seasons, min_n=30):
    """Odd/even-game split-half reliability of each team-season's RAW style rate (FBS offenses,
    Spearman-Brown corrected): does the metric measure something stable about a team, or noise?"""
    out = {}
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    for m, num, den, kind in STYLE_METRICS:
        rs = []
        for S in seasons:
            T = team_games(S).merge(G[['game_id', 'kickoff_ts', 'home_fbs', 'away_fbs', 'home_id']], on='game_id')
            T = T.sort_values('kickoff_ts')
            T['k'] = T.groupby('team_id').cumcount() % 2
            a = T.groupby(['team_id', 'k'])[[num, den]].sum()
            a = a[a[den] >= min_n / 2]
            v = (a[num] / a[den]).unstack('k').dropna()
            if len(v) < 30:
                continue
            r = float(v[0].corr(v[1], method='spearman'))
            rs.append((S, r, 2 * r / (1 + r)))
        out[m] = {'by_season': {s: round(sb, 3) for s, _, sb in rs},
                  'mean_spearman_brown': round(float(np.mean([x[2] for x in rs])), 3) if rs else None}
    return out


if __name__ == '__main__':
    args = [int(a) for a in sys.argv[1:]]
    build(args or None)
