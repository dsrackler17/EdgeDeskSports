"""QB personnel layer: per-player QB value, player vs system, replacement, and the
expected-starter distribution at an instant (docs/cfb-personnel/QB.md).

    rule version  cfb_personnel_qb_v1

Everything here REUSES V2.1's stage-4 QB model (v2/qb.py) and never re-tunes it:

  adj(game)   = EPA/dropback - opponent pass-defence rating - h*H          (v2/qb.py)
  rating(T)   = (sum_g w_g db_g adj_g + k * repl) / (sum_g w_g db_g + k)   games kicked off before T,
                w_g = 0.6 ** (seasons ago)  (SEASON_DECAY), k and repl from the burn-in seasons 2009-2013.

What this module adds (point in time: games that kicked off before T, reports published before `now`):

  * per-passer values with a posterior SD. Under V2's own conjugate model
        adj_g | theta ~ N(theta, s2 / db_g),   theta ~ N(repl, s2 / k)
    the posterior of theta is N(rating, s2 / (n_eff + k)), n_eff = sum_g w_g db_g (the decayed
    non-garbage dropbacks, V2's `den`), s2 = V2's per-dropback noise (qb_shrinkage noise_per_game_db).
    With season decay this is the power-prior version of the same posterior (older seasons count
    as fewer dropbacks), i.e. exactly the precision V2's point estimate implies.
  * the replacement level as V2 estimates it (dropback-weighted mean of 20-120-dropback QB-seasons,
    2009-2013) PLUS its spread: the SD of true quality across those QB-seasons, with the sampling
    noise removed (var_true = var_w(m) - s2 * N / sum n). A replacement is N(repl, repl_sd^2).
  * player vs system from QB transfers (dev seasons only): persistence rho of V2's rating across a
    team change, compared with QBs who stay, and the translation prior at a new team
        mean = repl + alpha + rho * (old rating - repl),   var = sigma_u^2 + var(alpha + rho d)
    (alpha: starters sit ~0.1 above V2's backup-level replacement mean; without it rho absorbs that
    level -- the no-intercept form is reported too. The line is weakly identified, n = 162, so its
    bootstrap covariance widens the variance.)
  * the expected-starter distribution per team at T, driven by the official availability reports
    published before `now` (V2's rule -- the last game's starter -- when there is no report, flagged
    UNKNOWN: unknown is not healthy).
"""
import email.utils
import functools
import glob
import json
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import qb as QB

RULE_VERSION = 'cfb_personnel_qb_v1'
CODE_VERSION = 'personnel_qb_v1.1'          # bump to invalidate out/personnel/qb/cache

# ----------------------------------------------------------- declared rules
SHRINK_SEASONS = (2009, 2010, 2011, 2012, 2013)     # V2's burn-in (qb.main), never re-tuned
SAME_STARTER_SEASONS = (2012, 2013, 2014, 2015)     # as qb.main
REPL_DB_BAND = (20, 120)                            # V2's replacement band (estimate_shrinkage)
TRANSFER_SEASONS = tuple(range(2010, 2024))         # season S at the NEW team; S-1 >= 2009; dev only
TRANSFER_WINDOW_GAMES = 4                           # outcome window: his first 4 games for the team he starts for
TRANSFER_MIN_DB = 30                                # non-garbage dropbacks in that window
N_BOOT = 2000
QB_SIDE_COLS = ('qb_missing', 'qb_id', 'qb_exp_rating', 'qb_team_rating', 'qb_delta', 'qb_backup_rating',
                'qb_drop', 'qb_exp_db_log', 'qb_exp_starts', 'qb_changed', 'qb_unsettled')

# ------------------------------------------------ estimated constants (dev)
# Written from estimate_persistence() / replacement() on the dev window and re-derived by
# tests_qb (real-data suite) -- a drift beyond the tolerance there fails the suite.
#   replacement(): 2009-2013 QB-seasons with 20-120 non-garbage dropbacks (V2's band), n = 618
#   QB-seasons / 31,281 dropbacks; bootstrap (2000, C.SEED) 95% CIs. sd = SD of TRUE quality across
#   replacement-level QBs (raw SD 0.2685 minus the sampling noise s2 * N / sum n = 0.0546 in variance).
#   Stability check on dev 2014-2023 (n = 1,476): mean -0.0365 [-0.0509, -0.0221], sd 0.168 [0.147, 0.187] --
#   the replacement level has drifted up since the burn-in; V2 keeps the burn-in value (not re-tuned).
REPLACEMENT = {'mean': -0.056584, 'sd': 0.132275, 'sd_raw': 0.268542, 'n_qb_seasons': 618,
               'mean_ci95': (-0.08006, -0.03467), 'sd_ci95': (0.09467, 0.16107)}
#   estimate_persistence(): QB-seasons 2010-2023 (dev), outcome = first 4 games for the team he starts
#   for (>= 30 non-garbage dropbacks); 162 transfers, 1,516 stays; bootstrap 2000 (C.SEED).
#     transfer  alpha 0.0900 [0.0366, 0.1415]  rho 0.674 [0.236, 1.101]  sigma_u 0.139 [0.095, 0.175]
#     stay      alpha 0.1125 [0.0978, 0.1260]  rho 0.942 [0.836, 1.051]  sigma_u 0.114
#     share of the persistent rating that follows the player rho_tr/rho_stay = 0.716 [0.243, 1.200]
#     pooled transfer shift: level -0.021 [-0.076, 0.032], slope -0.271 [-0.735, 0.182]  (CIs cover 0)
#     new team's previous passing (system) gamma 0.147 [-0.031, 0.339], n = 150
#   WEAK evidence (the transfer line's CI is wide): the translation widens its variance by the
#   bootstrap covariance of (alpha, rho) instead of pretending the line is known.
PERSISTENCE = {'alpha': 0.090001, 'rho': 0.673822, 'resid_sd': 0.139224, 'n': 162,
               'alpha_ci95': (0.03656, 0.14154), 'rho_ci95': (0.23586, 1.10071), 'resid_sd_ci95': (0.09487, 0.17486),
               'param_cov': [[0.00072285, -0.00458766], [-0.00458766, 0.04914157]],
               'alpha_stay': 0.112530, 'rho_stay': 0.941610, 'resid_sd_stay': 0.114200, 'n_stay': 1516,
               'share_following_player': 0.715606, 'share_ci95': (0.24292, 1.19969),
               'alpha_transfer_shift': -0.020961, 'rho_transfer_shift': -0.271422,
               'rho_transfer_shift_ci95': (-0.73453, 0.18162),
               'shift_param_cov': [[0.00079131, -0.00496890], [-0.00496890, 0.05269912]],
               'gamma_system': 0.147235, 'gamma_system_ci95': (-0.03101, 0.33867)}

# availability status -> probability the player plays (availability.PLAY_PROBABILITY, the declared
# table the weekly engine uses), plus the vocabulary the 2026 conference reports actually carry
_STATUS_ALIASES = {'GAME TIME DECISION': 'GAME-TIME DECISION', 'GTD': 'GAME-TIME DECISION',
                   'OUT FOR THE SEASON': 'OUT FOR SEASON', 'SEASON ENDING': 'OUT FOR SEASON',
                   'INACTIVE': 'OUT', 'NOT LISTED': 'NOT LISTED'}
# OUT FIRST HALF: he does not start but plays the second half -> the starter scenario carries half
# the game (game fraction 0.5, as personnel/state.py GAME_FRACTION). Declared, flagged.
GAME_FRACTION = {'OUT FIRST HALF': 0.5}
OUT_STATUSES = ('OUT', 'SUSPENDED', 'OUT FOR SEASON', 'TRANSFERRED')
SCENARIO_STATUSES = ('QUESTIONABLE', 'DOUBTFUL', 'GAME-TIME DECISION', 'PROBABLE', 'OUT FIRST HALF')
# the provider's 'TEAM' placeholder athletes (negative ids) and tiny ids are not quarterbacks
# (same rule as personnel/usage.py MIN_VALID_ID): never a scenario candidate, never an oracle change
MIN_VALID_ID = 100
# a team with no game yet has no dropbacks-per-game: the dev 2016-2023 mean of non-garbage dropbacks
# per FBS team-game (30.63; re-derived by tests_qb). Only reachable for a team with no game this season.
DEFAULT_DB_PER_GAME = 30.6
MAX_NAMED_SCENARIOS = 4          # named starters per team; any remaining mass goes to REPLACEMENT
MIN_SCENARIO_P = 1e-9

_MEM = {}


def play_probability(status):
    """Declared status -> P(plays). None for UNKNOWN / unrecognised (never 'healthy')."""
    from ..weekly import availability as AV
    s = normalize_status(status)
    if s is None:
        return None
    if s == 'NOT LISTED':
        return 1.0
    if s in GAME_FRACTION:
        return GAME_FRACTION[s]
    return AV.PLAY_PROBABILITY.get(s)


def normalize_status(status):
    if status is None:
        return None
    s = str(status).strip().upper().replace('_', ' ')
    s = ' '.join(s.split())
    return _STATUS_ALIASES.get(s, s)


# ================================================================ base data
def base():
    """V2's QB inputs, loaded exactly as qb.main does (cached per process)."""
    key = ('base', C.OUT)
    if key not in _MEM:
        seasons = list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
        Q, G = QB.load(seasons)
        Apast = QB.opponent_adjust_past(Q)
        shrink = QB.estimate_shrinkage(Apast, list(SHRINK_SEASONS))
        shrink['same_starter_prob'] = QB.same_starter_rate(Q, list(SAME_STARTER_SEASONS))
        _MEM[key] = {'Q': Q, 'G': G, 'Apast': Apast, 'shrink': shrink}
    return _MEM[key]


def posterior_sd(den, noise, k):
    """sd(theta | games before T) = sqrt(s2 / (n_eff + k))  (V2's conjugate model, see module doc)."""
    return np.sqrt(noise / (np.asarray(den, dtype=float) + k))


def qb_season_means(A, seasons):
    """Per (season, qb): dropback-weighted mean adj and its non-garbage dropbacks."""
    s = A[A.g_season.isin(seasons) & A.db_ng.gt(0) & A.adj.notna()]
    g = s.assign(wa=s.adj * s.db_ng).groupby(['g_season', 'qb_id'])
    out = pd.DataFrame({'wa': g.wa.sum(), 'n': g.db_ng.sum()})
    out['m'] = out.wa / out.n
    return out.drop(columns='wa').reset_index()


def replacement_from(qs, noise, band=REPL_DB_BAND):
    """Replacement mean (V2's definition) and the SD of TRUE quality among replacement-level QBs."""
    nb = qs[qs.n.between(*band)]
    if not len(nb):
        return {'mean': float('nan'), 'sd': float('nan'), 'sd_raw': float('nan'), 'n_qb_seasons': 0}
    w = nb.n.values
    mu = float(np.average(nb.m, weights=w))
    raw = float(np.average((nb.m - mu) ** 2, weights=w))
    noise_part = noise * len(nb) / w.sum()          # E_w[s2 / n] with weights n
    return {'mean': mu, 'sd': float(np.sqrt(max(raw - noise_part, 0.0))), 'sd_raw': float(np.sqrt(raw)),
            'noise_part_var': float(noise_part), 'n_qb_seasons': int(len(nb)), 'n_dropbacks': float(w.sum())}


def replacement(seasons=SHRINK_SEASONS, n_boot=N_BOOT, b=None):
    """V2's replacement level plus its spread, with bootstrap CIs over QB-seasons."""
    C.assert_dev_only(seasons)
    b = b or base()
    noise = b['shrink']['noise_per_game_db']
    qs = qb_season_means(b['Apast'], list(seasons))
    est = replacement_from(qs, noise)
    nb = qs[qs.n.between(*REPL_DB_BAND)].reset_index(drop=True)
    rng = np.random.default_rng(C.SEED)
    bm, bs = [], []
    for _ in range(n_boot):
        s = nb.iloc[rng.integers(0, len(nb), len(nb))]
        e = replacement_from(s, noise)
        bm.append(e['mean']); bs.append(e['sd'])
    est['mean_ci95'] = tuple(float(x) for x in np.quantile(bm, [0.025, 0.975]))
    est['sd_ci95'] = tuple(float(x) for x in np.quantile(bs, [0.025, 0.975]))
    est['seasons'] = list(seasons)
    est['v2_replacement_mean'] = b['shrink']['replacement_mean']
    return est


# ======================================================= ratings at instants
def _sig(paths):
    out = []
    for p in paths:
        try:
            st = os.stat(p)
            out.append([os.path.basename(p), st.st_size, st.st_mtime_ns])
        except OSError:
            out.append([os.path.basename(p), None, None])
    return out


def _season_inputs(S):
    ps = [common.out_path('stage1', 'qb_game_%d.parquet' % s) for s in range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1)]
    ps += [common.out_path('stage2', 'games.parquet'), common.out_path('stage3', 'final_dataonly.parquet'),
           common.out_path('stage3', 'ratings_%d.parquet' % S), common.out_path('stage3', 'league_%d.parquet' % S)]
    return ps


def cache_dir():
    d = common.out_path('personnel', 'qb', 'cache', 'x')
    return os.path.dirname(d)


def _build_season(S):
    b = base()
    det = {}
    F = QB.team_features(b['Q'], b['Apast'], b['G'], b['shrink'], [S], detail=det)
    parts = []
    for (s, T), d in det.items():
        r = pd.DataFrame({'rating': d['rating'], 'den': d['den']})
        r['career_db'] = d['career_db'].reindex(r.index).fillna(0).astype(float)
        r['starts'] = d['starts'].reindex(r.index).fillna(0).astype(float)
        r.index.name = 'qb_id'
        r = r.reset_index()
        r['season'] = s
        r['prediction_ts'] = T
        parts.append(r)
    R = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(
        columns=['qb_id', 'rating', 'den', 'career_db', 'starts', 'season', 'prediction_ts'])
    return R, F


def season_ratings(S, refresh=False):
    """Per-QB V2 rating, n_eff, career dropbacks and starts at EVERY freeze of season S (long frame),
    and V2's stage-4 team features recomputed by qb.team_features. Cached under
    out/personnel/qb/cache keyed on the stage-1..3 input files."""
    key = ('sr', S, C.OUT)
    if key in _MEM and not refresh:
        return _MEM[key]
    d = cache_dir()
    fR, fF, fj = [os.path.join(d, '%s_%d.%s' % (n, S, e)) for n, e in (('ratings', 'parquet'), ('team', 'parquet'),
                                                                        ('ratings', 'json'))]
    sig = {'code': CODE_VERSION, 'inputs': _sig(_season_inputs(S))}
    if not refresh and all(os.path.exists(f) for f in (fR, fF, fj)):
        try:
            if json.load(open(fj)) == sig:
                out = (pd.read_parquet(fR), pd.read_parquet(fF))
                _MEM[key] = out
                return out
        except (OSError, ValueError):
            pass
    R, F = _build_season(S)
    R.to_parquet(fR, index=False)
    F.to_parquet(fF, index=False)
    with open(fj, 'w') as fh:
        json.dump(sig, fh)
    _MEM[key] = (R, F)
    return R, F


def build_cache(seasons, procs=3):
    """Fill the rating cache for several seasons in parallel (each season is independent)."""
    todo = []
    for S in seasons:
        d = cache_dir()
        fj = os.path.join(d, 'ratings_%d.json' % S)
        sig = {'code': CODE_VERSION, 'inputs': _sig(_season_inputs(S))}
        ok = os.path.exists(fj) and os.path.exists(os.path.join(d, 'ratings_%d.parquet' % S))
        if ok:
            try:
                ok = json.load(open(fj)) == sig
            except (OSError, ValueError):
                ok = False
        if not ok:
            todo.append(S)
    if todo and procs > 1 and len(todo) > 1:
        import multiprocessing as mp
        with mp.get_context('fork').Pool(min(procs, len(todo))) as pool:
            pool.map(_cache_one, todo)
    else:
        for S in todo:
            _cache_one(S)
    return todo


def _cache_one(S):
    season_ratings(S, refresh=True)
    return S


def ratings_at(S, T, R=None):
    """Per-QB frame (index qb_id): rating, den (n_eff), career_db, starts, rating_sd -- at freeze T."""
    T = pd.Timestamp(T)
    if R is None:
        R = season_ratings(S)[0]
    r = R[R.prediction_ts.eq(T)]
    if not len(r):
        r = live_ratings(S, T)
    r = r.set_index('qb_id')[['rating', 'den', 'career_db', 'starts']]
    sh = base()['shrink']
    r['rating_sd'] = posterior_sd(r.den.values, sh['noise_per_game_db'], sh['k_dropbacks'])
    return r


def live_ratings(S, T):
    """Ratings at one instant that is not in the cache (the live freeze), computed by qb.team_features."""
    key = ('live', S, pd.Timestamp(T), C.OUT)
    if key in _MEM:
        return _MEM[key]
    b = base()
    det = {}
    QB.team_features(b['Q'], b['Apast'], b['G'], b['shrink'], [S], only_ts=[T], detail=det)
    d = det[(S, pd.Timestamp(T))]
    r = pd.DataFrame({'rating': d['rating'], 'den': d['den']})
    r['career_db'] = d['career_db'].reindex(r.index).fillna(0).astype(float)
    r['starts'] = d['starts'].reindex(r.index).fillna(0).astype(float)
    r.index.name = 'qb_id'
    r = r.reset_index()
    r['season'] = S
    r['prediction_ts'] = pd.Timestamp(T)
    _MEM[key] = r
    return r


# ============================================================ team context
def season_rows(S):
    """Season-S QB-game rows in V2's order (the frame team_features slices)."""
    key = ('qs', S, C.OUT)
    if key not in _MEM:
        Q = base()['Q']
        _MEM[key] = Q[Q.g_season.eq(S)]
    return _MEM[key]


def team_context(S, T, team_id, ratings, repl=None):
    """The team's QB situation at T exactly as qb.team_features sees it: V2's expected starter (the
    most recent game's starter), the season dropback order, the rating baseline (qb_team_rating)
    and the last-3-games starter count. Pure function of games kicked off before T."""
    repl = base()['shrink']['replacement_mean'] if repl is None else repl
    qs = season_rows(S)
    T = pd.Timestamp(T)
    cur = qs[qs.kickoff_ts < T]
    epa = cur.epa_db_sum / cur.db_ng.where(cur.db_ng > 0)
    cur = cur[epa.notna()]                         # == current_season_adjust(...).dropna(subset=['adj'])
    ct = cur[cur.team_id.eq(team_id)]
    ctx = {'season': S, 'prediction_ts': T, 'team_id': team_id, 'repl': repl}
    if ct.empty:
        ctx.update(missing=True, v2_starter=None, season_db=pd.Series(dtype=float), team_rating=None,
                   starters3=0, games=0)
        return ctx
    last_gid = ct.sort_values('kickoff_ts').game_id.iloc[-1]
    st = ct[(ct.game_id == last_gid) & ct.starter]
    exp_q = int(st.qb_id.iloc[0]) if len(st) else int(ct.qb_id.iloc[-1])
    season_db = ct.groupby('qb_id').db_ng.sum().sort_values(ascending=False)
    rating = ratings['rating']
    team_rating = float(np.average(rating.reindex(season_db.index).fillna(repl), weights=season_db.values + 1e-9))
    last3 = ct.drop_duplicates('game_id').sort_values('kickoff_ts').game_id.tail(3)
    starters3 = ct[ct.game_id.isin(last3) & ct.starter].qb_id.nunique()
    ctx.update(missing=False, v2_starter=exp_q, season_db=season_db, team_rating=team_rating,
               starters3=int(starters3), games=int(ct.game_id.nunique()))
    return ctx


def side_features(ctx, starter, ratings):
    """V2's per-team QB columns (qb.team_features) for an ARBITRARY starter: the same expressions,
    with `starter` in place of the most recent game's starter (None = an unseen replacement QB).
    With starter == ctx['v2_starter'] this reproduces V2's stage-4 row exactly (tests_qb)."""
    repl = ctx['repl']
    if ctx['missing']:
        return {'qb_missing': 1.0}
    rating, career_db, starts = ratings['rating'], ratings['career_db'], ratings['starts']
    season_db = ctx['season_db']
    team_rating = ctx['team_rating']
    others = [q for q in season_db.index if q != starter]
    backup = float(rating.get(others[0], repl)) if others else repl
    if starter is None:
        er, cdb, nst = repl, 0.0, 0.0
    else:
        er = float(rating.get(starter, repl))
        cdb, nst = career_db.get(starter, 0), float(starts.get(starter, 0))
    return {'qb_missing': 0.0, 'qb_id': (int(starter) if starter is not None else np.nan),
            'qb_exp_rating': er, 'qb_team_rating': team_rating, 'qb_delta': er - team_rating,
            'qb_backup_rating': backup, 'qb_drop': er - backup, 'qb_exp_db_log': float(np.log1p(cdb)),
            'qb_exp_starts': nst, 'qb_changed': float(season_db.index[0] != starter),
            'qb_unsettled': float(ctx['starters3'] >= 2)}


def team_db_per_game(S, default=DEFAULT_DB_PER_GAME):
    """f(team_id, T) -> the team's mean non-garbage dropbacks per game over its games before T
    (`default` when it has none: a declared league level, see lineup.DEFAULT_DB_PER_GAME)."""
    key = ('dbpg', S, C.OUT)
    if key not in _MEM:
        qs = season_rows(S)
        tg = qs.groupby(['game_id', 'team_id']).agg(db=('db_ng', 'sum'), k=('kickoff_ts', 'first')).reset_index()
        _MEM[key] = {int(t): g for t, g in tg.groupby('team_id')}
    by = _MEM[key]

    def f(tid, T):
        g = by.get(int(tid))
        if g is None:
            return default
        m = (g.k < pd.Timestamp(T)).values
        return float(g.db.values[m].mean()) if m.any() else default
    return f


def prev_team_qbs(S, T, team_id, lookback=2):
    """The 'career dropbacks on this team' fallback: QBs who threw for this team in the last
    `lookback` seasons, ordered by their CAREER dropbacks for this team, minus anyone seen throwing
    for another team since his last game here (a transfer out) or this season before T."""
    Q = base()['Q']
    p = Q[Q.team_id.eq(team_id) & Q.g_season.between(S - lookback, S - 1)]
    if p.empty:
        return []
    cand = set(p.qb_id)
    last_here = p.groupby('qb_id').kickoff_ts.max()
    career = Q[Q.team_id.eq(team_id) & Q.g_season.lt(S) & Q.qb_id.isin(cand)].groupby('qb_id').db.sum() \
        .sort_values(ascending=False, kind='mergesort')
    T = pd.Timestamp(T)
    other = Q[Q.qb_id.isin(cand) & Q.team_id.ne(team_id) & Q.g_season.between(S - lookback, S) & (Q.kickoff_ts < T)]
    left = set(other[other.kickoff_ts > other.qb_id.map(last_here)].qb_id)
    return [int(q) for q in career.index if q not in left and q > MIN_VALID_ID]


# ============================================================ player values
@functools.lru_cache(maxsize=1)
def _names_cached(out_dir):
    f = os.path.join(cache_dir(), 'passer_names.parquet')
    srcs = sorted(glob.glob(common.data_path('pbp', 'play_by_play_*.parquet')))
    sig = _sig(srcs)
    fj = f.replace('.parquet', '.json')
    if os.path.exists(f) and os.path.exists(fj):
        try:
            if json.load(open(fj)) == {'code': CODE_VERSION, 'inputs': sig}:
                return pd.read_parquet(f).set_index('qb_id')['name']
        except (OSError, ValueError):
            pass
    import pyarrow.parquet as pq
    parts = []
    for p in srcs:
        names = set(pq.ParquetFile(p).schema_arrow.names)
        if not {'passer_player_id', 'passer_player_name'} <= names:
            continue
        d = pd.read_parquet(p, columns=['passer_player_id', 'passer_player_name']).dropna()
        d['qb_id'] = pd.to_numeric(d.passer_player_id, errors='coerce')
        parts.append(d.dropna(subset=['qb_id'])[['qb_id', 'passer_player_name']])
    if not parts:
        return pd.Series(dtype=str)
    d = pd.concat(parts)
    d['qb_id'] = d.qb_id.astype('int64')
    nm = d.groupby(['qb_id', 'passer_player_name']).size().reset_index(name='n') \
        .sort_values(['qb_id', 'n'], ascending=[True, False]).drop_duplicates('qb_id')
    out = nm.rename(columns={'passer_player_name': 'name'})[['qb_id', 'name']]
    out.to_parquet(f, index=False)
    with open(fj, 'w') as fh:
        json.dump({'code': CODE_VERSION, 'inputs': sig}, fh)
    return out.set_index('qb_id')['name']


def names():
    """ESPN athlete id -> the passer name the play-by-play carries most often (identity only)."""
    try:
        return _names_cached(C.OUT)
    except (OSError, ValueError):
        return pd.Series(dtype=str)


def qb_values(S, T, include_prev_season=True, persistence=None):
    """Per-passer QB value at instant T (games kicked off before T), one row per QB who has
    thrown for any team this season before T (and, with include_prev_season, last season):

      rating, rating_sd       V2's posterior mean and sd = sqrt(s2 / (n_eff + k))
      n_eff                   decayed non-garbage dropbacks (V2's den)
      career_db, career_starts, games_season, starts_season, db_season (non-garbage)
      team_id                 latest team this season (else last season)
      other_team_share        share of n_eff earned for OTHER teams (transfers)
      rating_translated(_sd)  the transfer-translated rating at team_id (see translated())
      above_repl, above_repl_sd   rating - replacement, with the replacement as a distribution
    """
    b = base()
    sh = b['shrink']
    repl, noise, k = sh['replacement_mean'], sh['noise_per_game_db'], sh['k_dropbacks']
    T = pd.Timestamp(T)
    det = {}
    QB.team_features(b['Q'], b['Apast'], b['G'], sh, [S], only_ts=[T], detail=det)
    d = det[(S, T)]
    Q = b['Q']
    cur_all = Q[Q.g_season.eq(S) & (Q.kickoff_ts < T)]
    who = set(cur_all.qb_id)
    prev_s = Q[Q.g_season.eq(S - 1)]
    if include_prev_season:
        who |= set(prev_s.qb_id)
    who = sorted(int(q) for q in who)
    out = pd.DataFrame({'qb_id': who})
    out['season'] = S
    out['as_of'] = T
    out['rating'] = d['rating'].reindex(who).fillna(repl).values
    out['n_eff'] = d['den'].reindex(who).fillna(0.0).values
    out['rating_sd'] = posterior_sd(out.n_eff.values, noise, k)
    out['career_db'] = d['career_db'].reindex(who).fillna(0).astype(float).values
    out['career_starts'] = d['starts'].reindex(who).fillna(0).astype(float).values
    g = cur_all.groupby('qb_id')
    out['games_season'] = g.game_id.nunique().reindex(who).fillna(0).astype(int).values
    out['starts_season'] = cur_all[cur_all.starter].groupby('qb_id').size().reindex(who).fillna(0).astype(int).values
    out['db_season'] = g.db_ng.sum().reindex(who).fillna(0.0).values
    last_team = cur_all.sort_values('kickoff_ts').groupby('qb_id').team_id.last()
    prev_team = prev_s.sort_values('kickoff_ts').groupby('qb_id').team_id.last()
    out['team_id'] = [int(last_team.get(q, prev_team.get(q, -1))) for q in who]
    out['team_source'] = ['this_season' if q in last_team.index else 'last_season' for q in who]
    # transfer split: n_eff earned for other teams (previous seasons decayed, this season as is)
    prev = b['Apast'][b['Apast'].g_season < S].dropna(subset=['adj'])
    wp = prev.db_ng * QB.SEASON_DECAY ** (S - prev.g_season)
    cur = d['cur']
    tmap = dict(zip(out.qb_id, out.team_id))
    rows = pd.concat([pd.DataFrame({'qb_id': prev.qb_id.values, 'team_id': prev.team_id.values,
                                    'w': wp.values, 'wa': (wp * prev.adj).values}),
                      pd.DataFrame({'qb_id': cur.qb_id.values, 'team_id': cur.team_id.values,
                                    'w': cur.db_ng.values, 'wa': (cur.db_ng * cur.adj).values})])
    rows = rows[rows.qb_id.isin(tmap)]
    rows['this'] = rows.team_id.values == rows.qb_id.map(tmap).values
    agg = rows.groupby(['qb_id', 'this'])[['w', 'wa']].sum()
    per = persistence or PERSISTENCE
    tr_m, tr_s, oth = [], [], []
    for q in who:
        wo, wao = (agg.loc[(q, False)].values if (q, False) in agg.index else (0.0, 0.0))
        wt, wat = (agg.loc[(q, True)].values if (q, True) in agg.index else (0.0, 0.0))
        tot = wo + wt
        oth.append(wo / tot if tot > 0 else 0.0)
        m, v = translated(wo, wao, wt, wat, sh, per)
        tr_m.append(m); tr_s.append(np.sqrt(v) if v is not None else np.nan)
    out['other_team_share'] = oth
    out['rating_translated'] = tr_m
    out['rating_translated_sd'] = tr_s
    rsd = REPLACEMENT['sd']
    out['replacement_mean'] = repl
    out['replacement_sd'] = rsd
    out['above_repl'] = out.rating - repl
    out['above_repl_sd'] = np.sqrt(out.rating_sd ** 2 + rsd ** 2)
    nm = names()
    out['name'] = out.qb_id.map(nm)
    out['rule_version'] = RULE_VERSION
    return out


# ======================================================== player vs system
def _preseason(Apast, S, k, repl):
    """V2's rating of every QB at the first freeze of S (games of earlier seasons only)."""
    prev = Apast[Apast.g_season < S].dropna(subset=['adj'])
    wp = prev.db_ng * QB.SEASON_DECAY ** (S - prev.g_season)
    num0 = (wp * prev.adj).groupby(prev.qb_id).sum()
    den0 = wp.groupby(prev.qb_id).sum()
    return (num0 + k * repl) / (den0 + k), den0


def transfer_events(seasons=TRANSFER_SEASONS, window=TRANSFER_WINDOW_GAMES, min_db=TRANSFER_MIN_DB):
    """QB team changes and, for comparison, QBs who stay (dev seasons only; the same ESPN id).

    An event is a QB who STARTED at least one game for his main team A in season S-1 (main team =
    most non-garbage dropbacks) and starts a game for team B in season S. B != A is a transfer,
    B == A a stay. The outcome window is his first `window` games for B in S that contain a
    non-garbage dropback (window=None: the whole season) -- selection is 'he starts for B', which is
    what a pregame announcement tells us, not 'he survived a season as the starter'.

      x      V2's rating at the first freeze of S (all earlier games, season-decayed, shrunk)
      y, n_y opponent-adjusted EPA/dropback over the window at B, and its dropbacks (>= min_db)
      z_new  team B's season S-1 passing by its OTHER passers (dropback-weighted adj), n_z
    """
    seasons = list(seasons)
    C.assert_dev_only(seasons + [s - 1 for s in seasons])
    b = base()
    A, sh = b['Apast'], b['shrink']
    k, repl = sh['k_dropbacks'], sh['replacement_mean']
    ok = A[A.db_ng.gt(0) & A.adj.notna()]
    tq = ok.assign(wa=ok.adj * ok.db_ng).groupby(['g_season', 'team_id', 'qb_id']).agg(
        wa=('wa', 'sum'), n=('db_ng', 'sum'))
    st = A[A.starter].groupby(['g_season', 'team_id', 'qb_id']).size().rename('starts')
    tq = tq.join(st, how='outer').fillna({'starts': 0, 'wa': 0.0, 'n': 0.0}).reset_index()
    main = tq.sort_values(['g_season', 'qb_id', 'n'], ascending=[True, True, False]) \
        .drop_duplicates(['g_season', 'qb_id']).set_index(['g_season', 'qb_id'])
    team_pass = tq.groupby(['g_season', 'team_id'])[['wa', 'n']].sum()
    games = ok.sort_values(['kickoff_ts', 'game_id'], kind='mergesort')
    rows = []
    for S in seasons:
        x, den0 = _preseason(A, S, k, repl)
        if (S - 1) not in main.index.get_level_values(0):
            continue
        prv = main.loc[S - 1]
        prv = prv[prv.starts >= 1]
        gS = games[games.g_season.eq(S) & games.qb_id.isin(prv.index)]
        started = gS[gS.starter]
        # team B: the team he first STARTS for in S
        firstB = started.drop_duplicates('qb_id').set_index('qb_id').team_id
        for q, tB in firstB.items():
            tB, tA = int(tB), int(prv.loc[q].team_id)
            g = gS[(gS.qb_id == q) & (gS.team_id == tB)]
            if window:
                g = g.head(window)
            n_y = float(g.db_ng.sum())
            if n_y < min_db:
                continue
            kind = 'transfer' if tB != tA else 'stay'
            zt = team_pass.loc[(S - 1, tB)] if (S - 1, tB) in team_pass.index else None
            own = tq[(tq.g_season == S - 1) & (tq.team_id == tB) & (tq.qb_id == q)]
            zwa = (zt.wa if zt is not None else 0.0) - (own.wa.sum() if len(own) else 0.0)
            zn = (zt.n if zt is not None else 0.0) - (own.n.sum() if len(own) else 0.0)
            rows.append({'season': S, 'qb_id': int(q), 'kind': kind, 'team_old': tA, 'team_new': tB,
                         'x': float(x.get(q, repl)), 'n_eff_x': float(den0.get(q, 0.0)),
                         'y': float(np.average(g.adj, weights=g.db_ng)), 'n_y': n_y,
                         'games_y': int(g.game_id.nunique()), 'db_old': float(prv.loc[q].n),
                         'starts_old': int(prv.loc[q].starts),
                         'z_new': float(zwa / zn) if zn > 0 else np.nan, 'n_z': float(zn)})
    return pd.DataFrame(rows)


def _fgls(y, X, n, noise, iters=200):
    """y = X b + e, Var(e_i) = s_u^2 + noise / n_i. Feasible GLS with a method-of-moments s_u^2."""
    su2 = 0.01
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        w = 1.0 / (su2 + noise / n)
        Xw = X * w[:, None]
        b = np.linalg.solve(X.T @ Xw + 1e-12 * np.eye(X.shape[1]), Xw.T @ y)
        r = y - X @ b
        su2_new = max(float(np.sum(w * (r ** 2 - noise / n)) / np.sum(w)), 1e-6)
        if abs(su2_new - su2) < 1e-12:
            su2 = su2_new
            break
        su2 = su2_new
    return b, su2


def persistence_fit(ev, noise, repl, intercept=True, with_system=False):
    """y - repl = [alpha] + rho (x - repl) [+ gamma (z_new - mean z)] + e   (FGLS)."""
    y = ev.y.values - repl
    cols, names = [ev.x.values - repl], ['rho']
    if intercept:
        cols.insert(0, np.ones(len(ev))); names.insert(0, 'alpha')
    if with_system:
        z = ev.z_new.values - repl
        cols.append(z - np.nanmean(z)); names.append('gamma_system')
    b, su2 = _fgls(y, np.column_stack(cols), ev.n_y.values, noise)
    out = dict(zip(names, [float(v) for v in b]))
    out['resid_sd'] = float(np.sqrt(su2))
    out['n'] = int(len(ev))
    return out


def pooled_fit(ev, noise, repl):
    """One model for stays and transfers: y - repl = a + rho (x - repl) + t (a_t + d_rho (x - repl))."""
    y = ev.y.values - repl
    x = ev.x.values - repl
    t = ev.kind.eq('transfer').values.astype(float)
    b, su2 = _fgls(y, np.column_stack([np.ones(len(ev)), x, t, t * x]), ev.n_y.values, noise)
    return {'alpha': float(b[0]), 'rho_stay': float(b[1]), 'alpha_transfer_shift': float(b[2]),
            'rho_transfer_shift': float(b[3]), 'resid_sd': float(np.sqrt(su2)), 'n': int(len(ev))}


def _wrmse(y, pred, n, noise, su2):
    w = 1.0 / (su2 + noise / n)
    return float(np.sqrt(np.sum(w * (y - pred) ** 2) / np.sum(w)))


def estimate_persistence(ev=None, n_boot=N_BOOT):
    """Player vs system from QB transfers (dev seasons 2010-2023):

      transfer:  y - repl = alpha + rho * (x - repl) + e,  Var(e) = sigma_u^2 + s2 / n_y   (FGLS)
      stay:      the same on QBs who start for the same team as last season
      pooled:    both, with a transfer shift in level and in slope (the player-vs-system test)
      system:    transfers with the new team's previous passing by its other QBs added
    rho_transfer / rho_stay is the share of the persistent (above-replacement) rating that follows
    the player; the rest stayed with the team he left. Bootstrap (events, seed C.SEED) 95% CIs,
    and a leave-one-season-out check that the transfer translation predicts better than V2's rating
    itself out of sample."""
    b = base()
    sh = b['shrink']
    noise, repl = sh['noise_per_game_db'], sh['replacement_mean']
    ev = transfer_events() if ev is None else ev
    tr = ev[ev.kind.eq('transfer')].reset_index(drop=True)
    stay = ev[ev.kind.eq('stay')].reset_index(drop=True)
    trz = tr[tr.z_new.notna() & (tr.n_z >= TRANSFER_MIN_DB)].reset_index(drop=True)
    est = {'transfer': persistence_fit(tr, noise, repl), 'stay': persistence_fit(stay, noise, repl),
           'pooled': pooled_fit(ev, noise, repl),
           'transfer_system': persistence_fit(trz, noise, repl, with_system=True),
           'as_specified_no_intercept': {'transfer': persistence_fit(tr, noise, repl, intercept=False),
                                         'stay': persistence_fit(stay, noise, repl, intercept=False)}}
    est['share_following_player'] = est['transfer']['rho'] / est['stay']['rho']
    rng = np.random.default_rng(C.SEED)
    keys = ('rho_transfer', 'alpha_transfer', 'resid_sd_transfer', 'rho_stay', 'alpha_stay', 'share',
            'rho_transfer_shift', 'alpha_transfer_shift', 'gamma_system')
    bt = {k: [] for k in keys}
    for _ in range(n_boot):
        a = tr.iloc[rng.integers(0, len(tr), len(tr))]
        s = stay.iloc[rng.integers(0, len(stay), len(stay))]
        z = trz.iloc[rng.integers(0, len(trz), len(trz))]
        ft, fs = persistence_fit(a, noise, repl), persistence_fit(s, noise, repl)
        fp = pooled_fit(pd.concat([a, s]), noise, repl)
        fz = persistence_fit(z, noise, repl, with_system=True)
        for k_, v in (('rho_transfer', ft['rho']), ('alpha_transfer', ft['alpha']),
                      ('resid_sd_transfer', ft['resid_sd']), ('rho_stay', fs['rho']), ('alpha_stay', fs['alpha']),
                      ('share', ft['rho'] / fs['rho']), ('rho_transfer_shift', fp['rho_transfer_shift']),
                      ('alpha_transfer_shift', fp['alpha_transfer_shift']), ('gamma_system', fz['gamma_system'])):
            bt[k_].append(v)
    est['ci95'] = {k_: tuple(float(x) for x in np.quantile(v, [0.025, 0.975])) for k_, v in bt.items()}
    # parameter uncertainty of the transfer line (alpha, rho), used to WIDEN the translation variance
    cv = np.cov(np.vstack([bt['alpha_transfer'], bt['rho_transfer']]))
    est['transfer_param_cov'] = [[float(cv[0, 0]), float(cv[0, 1])], [float(cv[1, 0]), float(cv[1, 1])]]
    cvs = np.cov(np.vstack([bt['alpha_transfer_shift'], bt['rho_transfer_shift']]))
    est['shift_param_cov'] = [[float(cvs[0, 0]), float(cvs[0, 1])], [float(cvs[1, 0]), float(cvs[1, 1])]]
    est['n_transfer'], est['n_stay'], est['n_transfer_with_system'] = int(len(tr)), int(len(stay)), int(len(trz))
    # leave-one-season-out: predict each transfer season from the other seasons' fits
    su2 = est['transfer']['resid_sd'] ** 2
    preds = {'v2_rating': [], 'stay_model': [], 'transfer_model': []}
    ys, ns = [], []
    for S in sorted(tr.season.unique()):
        te, trn = tr[tr.season.eq(S)], tr[tr.season.ne(S)]
        if len(trn) < 20:
            continue
        ft = persistence_fit(trn, noise, repl)
        fs = persistence_fit(stay[stay.season.ne(S)], noise, repl)
        xs = te.x.values - repl
        preds['v2_rating'].append(te.x.values)
        preds['stay_model'].append(repl + fs['alpha'] + fs['rho'] * xs)
        preds['transfer_model'].append(repl + ft['alpha'] + ft['rho'] * xs)
        ys.append(te.y.values); ns.append(te.n_y.values)
    if ys:
        y, n = np.concatenate(ys), np.concatenate(ns)
        est['loso_wrmse'] = {k_: _wrmse(y, np.concatenate(v), n, noise, su2) for k_, v in preds.items()}
        est['loso_mean_error'] = {k_: float(np.mean(y - np.concatenate(v))) for k_, v in preds.items()}
        est['loso_n'] = int(len(y))
    est['by_era'] = {}
    for nm, lo, hi in (('2010_2017', 2010, 2017), ('2018_2023_portal', 2018, 2023)):
        e = tr[tr.season.between(lo, hi)]
        if len(e) >= 20:
            est['by_era'][nm] = persistence_fit(e, noise, repl)
    est['seasons'] = [int(ev.season.min()), int(ev.season.max())] if len(ev) else None
    est['definition'] = ('x = V2 rating at the first freeze of S (earlier games, decayed %.1f/season, shrunk '
                         'k=%.1f toward repl=%.4f); y = opponent-adjusted EPA/dropback over his first %s games '
                         'for the team he starts for in S (>= %d non-garbage dropbacks); FGLS with '
                         'Var(e) = sigma_u^2 + s2/n_y, s2=%.3f'
                         % (QB.SEASON_DECAY, sh['k_dropbacks'], repl, TRANSFER_WINDOW_GAMES, TRANSFER_MIN_DB,
                            noise))
    return est


def translate(old_rating, persistence=None, repl=None):
    """Transfer translation (the prior for a QB's play at a NEW team, from his V2 rating elsewhere):
        mean = repl + alpha + rho * (old - repl),   var = sigma_u^2
    alpha, rho, sigma_u from the transfer fit (estimate_persistence()['transfer']). alpha is the level
    of a QB who STARTS (V2's rating is shrunk toward the backup-level replacement mean, and starters
    out-play it on average: the stay group has the same alpha), so this is the expected level of his
    first games at the new team, on the adjusted EPA/dropback scale."""
    per = persistence or PERSISTENCE
    repl = base()['shrink']['replacement_mean'] if repl is None else repl
    d = np.asarray(old_rating, dtype=float) - repl
    m = repl + per['alpha'] + per['rho'] * d
    cv = per.get('param_cov') or [[0.0, 0.0], [0.0, 0.0]]
    # the residual's true variance PLUS the uncertainty of (alpha, rho) itself (bootstrap covariance):
    # with n = 162 transfers the line is weakly identified, so the prior is wider, not falsely precise
    v = per['resid_sd'] ** 2 + cv[0][0] + 2 * cv[0][1] * d + cv[1][1] * d ** 2
    return m, v


def translated(w_other, wa_other, w_this, wa_this, shrink, persistence=None):
    """A QB's rating ON V2's SCALE when part of his evidence was earned for another team.

    V2's rating is the sequential update  m_o = (wa_o + k repl)/(w_o + k)  (other-team games),
    then  rating = (m_o (w_o + k) + wa_t) / (w_o + k + w_t)  (this team's games). The translation
    replaces m_o by the transfer-shifted  m_o' = m_o + a_t + d_rho (m_o - repl)  -- the pooled
    model's transfer shift relative to QBs who stay, i.e. relative to the population V2's rating is
    calibrated on -- and adds the extra transfer variance (sigma_u,tr^2 - sigma_u,stay^2), weighted
    by the other-team share of the prior. No other-team evidence: V2's rating and posterior variance."""
    per = persistence or PERSISTENCE
    k, repl, noise = shrink['k_dropbacks'], shrink['replacement_mean'], shrink['noise_per_game_db']
    tot = w_other + w_this + k
    v2m = (wa_other + wa_this + k * repl) / tot
    v2v = noise / tot
    if w_other <= 0 or per.get('rho_transfer_shift') is None:
        return float(v2m), float(v2v)
    m_o = (wa_other + k * repl) / (w_other + k)
    d = m_o - repl
    m_o2 = m_o + per['alpha_transfer_shift'] + per['rho_transfer_shift'] * d
    m = (m_o2 * (w_other + k) + wa_this) / tot
    cv = per.get('shift_param_cov') or [[0.0, 0.0], [0.0, 0.0]]
    extra = max(per['resid_sd'] ** 2 - per['resid_sd_stay'] ** 2, 0.0) \
        + cv[0][0] + 2 * cv[0][1] * d + cv[1][1] * d ** 2
    v = v2v + ((w_other + k) / tot) ** 2 * extra
    return float(m), float(v)


# ============================================================ availability
def parse_time(s):
    """ISO-8601 or RFC-2822 (some conference feeds) -> UTC Timestamp; None if absent/unparseable."""
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return None
    try:
        t = pd.Timestamp(s)
    except (ValueError, TypeError):
        try:
            t = pd.Timestamp(email.utils.parsedate_to_datetime(str(s)))
        except (TypeError, ValueError, IndexError):
            return None
    return t.tz_localize('UTC') if t.tzinfo is None else t.tz_convert('UTC')


def load_reports(season, reports_dir=None):
    from ..weekly import availability as AV
    return AV.load_reports(season, reports_dir)


def report_rows(r):
    """The report's designated players ('rows' in edgedesk_availability_report_v1; 'players' in
    older files)."""
    return r.get('rows') or r.get('players') or []


def report_known_at(r):
    """The instant a report became knowledge: its publication time, else its retrieval time."""
    return parse_time(r.get('published_at')) or parse_time(r.get('retrieved_at'))


def report_is_usable(r):
    """A failed read is not a report; a document that names nobody is informative only when the
    conference's policy makes silence mean available (README: silence_means_available)."""
    if r.get('ok') is False:
        return False
    if report_rows(r):
        return True
    return bool(r.get('silence_means_available'))


def _norm_team(s):
    return ' '.join(str(s or '').lower().replace('&', 'and').replace('.', '').replace("'", '').split())


def team_report(reports, game_id, team_id, team_name, now, kickoff=None):
    """The latest usable report for (game, team) that was knowledge at `now` (and before kickoff)."""
    now = pd.Timestamp(now)
    cutoff = min(now, pd.Timestamp(kickoff)) if kickoff is not None else now
    best = None
    for r in reports:
        if str(r.get('game_id')) != str(game_id):
            continue
        tid = r.get('team_id')
        if tid is not None and str(tid) != str(team_id):
            continue
        if tid is None and _norm_team(r.get('team')) != _norm_team(team_name):
            continue
        t = report_known_at(r)
        if t is None or t > cutoff or not report_is_usable(r):
            continue
        if best is None or t > best[0]:
            best = (t, r)
    return best[1] if best else None


def qb_statuses(report):
    """{espn_id: normalized status} for every QB the report designates (other positions ignored: a
    QB listed at another position is rare and not a starter signal)."""
    out = {}
    for p in report_rows(report or {}):
        if str(p.get('position', '')).upper() != 'QB':
            continue
        try:
            pid = int(p.get('player_id'))
        except (TypeError, ValueError):
            continue
        out[pid] = normalize_status(p.get('status'))
    return out


def starter_distribution(ctx, statuses, knowledge, fallback=()):
    """P(start) over the team's QBs at T given the report state.

    Candidates in order: V2's expected starter (the last game's starter), then the team's other QBs
    by season non-garbage dropbacks, then `fallback` (last season's QBs on this team), then an
    unseen REPLACEMENT. Each candidate plays with his status' play probability (not listed on a
    usable report -> 1.0; PROBABLE 0.85; QUESTIONABLE / GAME-TIME DECISION 0.5; DOUBTFUL 0.2;
    OUT / SUSPENDED / OUT FOR SEASON / TRANSFERRED 0.0), and the starting role passes down the list:
        P(c_i starts) = p_i * prod_{j<i} (1 - p_j).
    knowledge: 'UNKNOWN' (no usable report: V2's rule, p = 1, flagged) or 'KNOWN'."""
    if ctx['missing']:
        return [{'qb_id': None, 'p': 1.0, 'status': None, 'role': 'V2_MISSING', 'play_probability': None}]
    v2 = ctx['v2_starter']
    if knowledge != 'KNOWN':
        return [{'qb_id': v2, 'p': 1.0, 'status': 'UNKNOWN', 'role': 'V2_EXPECTED', 'play_probability': None}]
    cands = [v2] + [int(q) for q in ctx['season_db'].index if int(q) != v2 and int(q) > MIN_VALID_ID]
    for q in fallback:
        if q not in cands and int(q) > MIN_VALID_ID:
            cands.append(int(q))
    # a QB the report lists who has not thrown for this team yet is still a candidate after them
    for q in statuses:
        if q not in cands:
            cands.append(int(q))
    out, remaining = [], 1.0
    for i, q in enumerate(cands):
        st = statuses.get(q, 'NOT LISTED')
        pp = play_probability(st)
        if pp is None:                       # an unrecognised status on the report: do not guess
            pp = 1.0
            st = (st or '') + ' (UNRECOGNISED)'
        p = remaining * pp
        if p > MIN_SCENARIO_P:
            out.append({'qb_id': q, 'p': p, 'status': st, 'play_probability': pp,
                        'role': 'V2_EXPECTED' if q == v2 else ('SEASON_QB' if q in ctx['season_db'].index
                                                               else 'OTHER_QB')})
        remaining -= p
        if remaining <= MIN_SCENARIO_P or len(out) >= MAX_NAMED_SCENARIOS:
            break
    if remaining > MIN_SCENARIO_P:
        out.append({'qb_id': None, 'p': remaining, 'status': None, 'play_probability': None,
                    'role': 'REPLACEMENT'})
    s = sum(o['p'] for o in out)
    for o in out:
        o['p'] = o['p'] / s
    return out


def expected_starters(S, T, now, games, reports=None, ratings=None):
    """Per (game, team): the starter distribution at T given the reports known at `now`.
    games: frame with game_id, home_id, away_id, home_team, away_team, kickoff_ts."""
    reports = load_reports(S) if reports is None else reports
    ratings = ratings_at(S, T) if ratings is None else ratings
    dbpg = team_db_per_game(S)
    out = {}
    for _, g in games.iterrows():
        for side in ('home', 'away'):
            tid = int(g[side + '_id'])
            ctx = team_context(S, T, tid, ratings)
            rep = team_report(reports, g.game_id, tid, g.get(side + '_team'), now, g.get('kickoff_ts'))
            know = 'KNOWN' if rep is not None else 'UNKNOWN'
            sts = qb_statuses(rep) if rep is not None else {}
            fb = prev_team_qbs(S, T, tid) if rep is not None else ()
            dist = starter_distribution(ctx, sts, know, fb)
            for d in dist:
                q = d['qb_id']
                if q is None:
                    d['rating'], d['rating_sd'] = ctx['repl'], REPLACEMENT['sd']
                elif q in ratings.index:
                    d['rating'], d['rating_sd'] = float(ratings.at[q, 'rating']), float(ratings.at[q, 'rating_sd'])
                else:                       # never thrown a counted pass: the replacement distribution
                    d['rating'], d['rating_sd'] = ctx['repl'], REPLACEMENT['sd']
            ctx['db_per_game'] = dbpg(tid, T)
            out[(int(g.game_id), tid)] = {
                'ctx': ctx, 'dist': dist, 'knowledge': know, 'side': side,
                'report': None if rep is None else {
                    'file': rep.get('_file'), 'published_at': rep.get('published_at'),
                    'retrieved_at': rep.get('retrieved_at'), 'source_url': rep.get('source_url'),
                    'report_type': rep.get('report_type'), 'qb_statuses': {str(k): v for k, v in sts.items()}}}
    return out
