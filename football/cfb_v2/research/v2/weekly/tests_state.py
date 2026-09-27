"""Team and QB state: the suite.

    python3 -m v2.weekly.tests_state            (exit 0 = green)
    python3 -m v2.weekly.tests_state --full     + a full-season rebuild of 2025 with and
                                                  without the hooks (byte comparison)

Run from football/cfb_v2/research with CFB_V2_DATA / CFB_V2_OUT set (stage 1-2
outputs present). Real-data checks use season 2025 (a completed holdout
season: nothing here tunes anything) and the dev seasons for calibration.
"""
import os
import shutil
import sys
import tempfile
import time
import traceback

import numpy as np
import pandas as pd

from .. import build_ratings as BR
from .. import common
from .. import config as C
from .. import qb as QB
from .. import ratings as R
from . import ids
from . import qb_state as QS
from . import team_state as TS

S = 2025
T = pd.Timestamp('2025-10-14 12:00', tz='UTC')
T_PREV = pd.Timestamp('2025-10-07 12:00', tz='UTC')

PASS, FAIL = [0], [0]
FAILS = []
NOTES = []


def chk(name, ok, detail=None):
    if ok:
        PASS[0] += 1
    else:
        FAIL[0] += 1
        FAILS.append(name + ('  ' + str(detail)[:400] if detail is not None else ''))


def note(s):
    NOTES.append(s)
    print('  . ' + s)


def section(fn):
    t0 = time.time()
    try:
        fn()
    except Exception as e:
        chk(fn.__name__ + ' raised', False, repr(e))
        traceback.print_exc()
    print('%-34s %.1fs' % (fn.__name__, time.time() - t0))


_STATE = {}


def state():
    """The real-data build at T (with last week's rows as prev), cached."""
    if 'rows' not in _STATE:
        prev, _, _ = TS.build(S, T_PREV)
        rows, conv, ex = TS.build(S, T, prev=prev)
        _STATE.update(prev=prev, rows=rows, conv=conv, ex=ex)
    return _STATE


# ================================================================ hooks
def hooks_identical():
    rng = np.random.default_rng(1)
    teams = list(range(12))
    D = R.Design(teams)
    n = 60
    off = rng.choice(teams, n)
    dfn = np.array([(o + 1 + rng.integers(0, 10)) % 12 for o in off])
    H = rng.choice([-1.0, 0.0, 1.0], n)
    y = rng.normal(0, 1, n)
    w = rng.uniform(0.5, 2, n)
    po = {t: (rng.normal(),) for t in teams}
    pdm = {t: (rng.normal(),) for t in teams}
    t2 = {t: 0.5 for t in teams}
    for want_var in (True, False):
        a = R.solve(D, off, dfn, H, y, w, po, pdm, t2, t2, want_var=want_var)
        d, so = [], {}
        b = R.solve(D, off, dfn, H, y, w, po, pdm, t2, t2, want_var=want_var, diag=d, system_out=so,
                    x0=np.zeros(D.p))
        chk('solve(want_var=%s): x identical with the hooks on' % want_var, np.array_equal(a[0], b[0]))
        chk('solve(want_var=%s): var identical with the hooks on' % want_var,
            (a[1] is None and b[1] is None) or np.array_equal(a[1], b[1]))
        chk('solve records one converged diag', len(d) == 1 and d[0]['converged'], d)
    # fit_metric on real rows
    ctx = TS._br_ctx()
    cur = TS.opponent_adjust(S, T, diag=False)
    setup, priors = cur['setup'], cur['priors']
    obs = TS._obs(setup, S, T)
    for m in ('epa', 'st_net', 'plays_pg'):
        spec = BR.metric_specs()[m]
        for hz in ('season', 'recent'):
            kw = dict(horizon=hz, T=T, halflife_weeks=C.RECENT_HALFLIFE_WEEKS if hz == 'recent' else None,
                      want_var=hz == 'season')
            f1, r1 = R.fit_metric(obs, m, spec, setup['varcomp'][m], priors[m], **kw)
            d = []
            f2, r2 = R.fit_metric(obs, m, spec, setup['varcomp'][m], priors[m], diag=d, system_out={}, **kw)
            chk('fit_metric %s/%s identical with the hooks on' % (m, hz),
                f1.equals(f2) and r1.equals(r2) and f1.attrs == f2.attrs)
    # build_ratings.run(only_ts) with and without diag / warm
    ts2 = [T_PREV, T]
    a = BR.run(seasons_out=[S], only_ts=ts2, write=False, return_frames=True, verbose=False, ctx=ctx)
    d = []
    b = BR.run(seasons_out=[S], only_ts=ts2, write=False, return_frames=True, verbose=False, ctx=ctx,
               diag=d, warm=None)
    chk('run(only_ts): ratings identical with diag on', a['ratings'][S].equals(b['ratings'][S]))
    chk('run(only_ts): league identical with diag on', a['league'][S].equals(b['league'][S]))
    chk('run(only_ts): the second T warm-starts from the first',
        all(r['cg_start'] == 'prev_week' for r in d if r.get('solved') and r['prediction_ts'] == T))
    # only_ts rows = the full-season file's rows at those T (the file is the full build)
    f = common.out_path('stage3', 'ratings_%d.parquet' % S)
    if os.path.exists(f):
        Rf = pd.read_parquet(f)
        first = Rf[Rf.prediction_ts.eq(Rf.prediction_ts.min())]
        v21 = first.vol.notna().any()
        k = ['prediction_ts', 'metric', 'team_id']
        x = a['ratings'][S].sort_values(k).reset_index(drop=True)
        y = Rf[Rf.prediction_ts.isin(ts2)].sort_values(k).reset_index(drop=True)
        cols = [c for c in x.columns if c in y.columns and (v21 or c != 'vol')]
        def eq(c):
            if x[c].dtype.kind == 'f':
                return np.array_equal(x[c].values, y[c].values, equal_nan=True)
            return bool((x[c].values == y[c].values).all())
        bad = [c for c in cols if not eq(c)]
        chk('only_ts rows equal the stage-3 file rows at those T', len(x) == len(y) and not bad, bad)
        if not v21:
            note('stage-3 file predates v2.1 (no volatility prior at the first freeze): vol not compared')
    # qb.team_features hook: one T, in-memory ratings = the stage-4 file rows
    Q, G = QS._load(S)
    Apast, shrink = QS._shrinkage()
    det = {}
    Rt = a['ratings'][S]
    F1 = QB.team_features(Q, Apast, G, shrink, [S], only_ts=[T], detail=det,
                          ratings={S: Rt}, league={S: a['league'][S]})
    fq = common.out_path('stage4', 'qb_team.parquet')
    if os.path.exists(fq):
        F0 = pd.read_parquet(fq)
        F0 = F0[F0.season.eq(S) & F0.prediction_ts.eq(T)].reset_index(drop=True)
        F1c = F1[F0.columns].reset_index(drop=True)
        chk('qb.team_features(only_ts, detail, ratings) equals the stage-4 rows at T',
            len(F0) == len(F1c) and F0.equals(F1c))
    chk('qb.team_features detail holds the per-QB posterior', (S, T) in det and len(det[(S, T)]['rating']) > 100)


def hooks_full_season():
    """--full: 2025 rebuilt twice (hooks off / diag on) into temp OUTs: identical bytes;
    and a one-T merge-write reproduces the full file byte for byte."""
    tmp = tempfile.mkdtemp(prefix='cfbw_state_')
    try:
        outs = []
        for tag, kw in (('off', {}), ('diag', {'diag': []})):
            o = os.path.join(tmp, tag)
            os.makedirs(o)
            for st in ('stage1', 'stage2'):
                os.symlink(os.path.abspath(common.out_path(st, 'x'))[:-2], os.path.join(o, st))
            old = C.OUT
            C.OUT = o
            try:
                BR.run(seasons_out=[S], verbose=False, **kw)
            finally:
                C.OUT = old
            outs.append(o)
        for fn in ('ratings_%d.parquet' % S, 'league_%d.parquet' % S, 'varcomp.json',
                   'final_dataonly.parquet', 'priors.parquet'):
            h = [ids.file_hash(os.path.join(o, 'stage3', fn)) for o in outs]
            chk('full 2025 rebuild: %s identical with diag on' % fn, h[0] == h[1] and h[0] is not None, h)
        # merge-write one T into the full file
        o = outs[0]
        f = os.path.join(o, 'stage3', 'ratings_%d.parquet' % S)
        before = ids.file_hash(f)
        old = C.OUT
        C.OUT = o
        try:
            BR.run(seasons_out=[S], only_ts=[T], write=True, verbose=False)
        finally:
            C.OUT = old
        chk('only_ts merge-write reproduces the full season file byte for byte', ids.file_hash(f) == before)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ========================================================== convergence
def convergence():
    conv = state()['conv']
    chk('convergence covers all 28 metrics', conv['n_metrics'] == 28 and len(BR.metric_specs()) == 28,
        conv['n_metrics'])
    chk('two horizons per metric (56 records)', conv['n_records'] == 56, conv['n_records'])
    chk('every solve converged', conv['converged'], conv['not_converged'])
    rec = conv['records'][0]
    need = {'rel_residual', 'cond', 'cg_iters', 'cg_converged', 'delta_max_abs', 'delta_threshold',
            'converged', 'cg_start', 'metric', 'horizon', 'prediction_ts'}
    chk('records carry residual, condition number, CG iterations, delta, threshold', need <= set(rec), rec)
    chk('CG warm-started from the previous week', all(r['cg_start'] == 'prev_week' for r in conv['records']))
    s = conv['summary']
    chk('relative residual < 1e-9 and delta < 1e-6 everywhere',
        s['max_rel_residual'] < 1e-9 and s['max_delta'] < 1e-6, s)
    note('convergence at %s: max rel residual %.1e, max cond %.2e (scaled %.1f), max CG delta %.1e, '
         'CG iterations median %.0f max %d' % (T.date(), s['max_rel_residual'], s['max_cond'],
                                               s['max_cond_scaled'], s['max_delta'], s['median_cg_iters'],
                                               s['max_cg_iters']))
    # the first freeze (no game): prior only, recorded as such
    d = []
    BR.run(seasons_out=[S], only_ts=[TS.freezes(S)[0]], write=False, verbose=False, diag=d, ctx=TS._br_ctx())
    chk('a freeze with no game records 28 x 2 prior-only records',
        len(d) == 56 and all(not r['solved'] and r['converged'] for r in d))


# ============================================== sequential Bayesian update
def sequential():
    rng = np.random.default_rng(7)
    P, n0, n1 = 9, 40, 25
    X0, X1 = rng.normal(size=(n0, P)), rng.normal(size=(n1, P))
    w0, w1 = rng.uniform(0.5, 3, n0), rng.uniform(0.5, 3, n1)
    y0, y1 = rng.normal(size=n0), rng.normal(size=n1)
    m, prec = rng.normal(size=P), rng.uniform(0.2, 2, P)
    A0 = X0.T @ (X0 * w0[:, None]) + np.diag(prec)
    b0 = X0.T @ (w0 * y0) + prec * m
    S0 = np.linalg.inv(A0)
    x0 = S0 @ b0
    K = np.linalg.solve(X1 @ S0 @ X1.T + np.diag(1 / w1), X1 @ S0).T
    xs, Ss = x0 + K @ (y1 - X1 @ x0), S0 - K @ X1 @ S0
    A = A0 + X1.T @ (X1 * w1[:, None])
    xb = np.linalg.solve(A, b0 + X1.T @ (w1 * y1))
    chk('synthetic: last week posterior as prior + new games = batch posterior (mean)',
        np.max(np.abs(xs - xb)) < 1e-10, np.max(np.abs(xs - xb)))
    chk('synthetic: ... (covariance)', np.max(np.abs(Ss - np.linalg.inv(A))) < 1e-10)
    se = TS.sequential_equivalence(S, T_PREV, T)
    chk('real 2025 week: sequential = batch for all 28 metrics (mean, < 1e-6 posterior SD)',
        len(se['metrics']) == 28 and se['max_mean_diff_in_sd'] < 1e-6, se['max_mean_diff_in_sd'])
    chk('real 2025 week: ... (variance, relative < 1e-8)', se['max_rel_var_diff'] < 1e-8, se['max_rel_var_diff'])
    _STATE['seq'] = se
    note('sequential equivalence %s -> %s: max |mean diff| %.1e (%.1e posterior SD), max rel var diff %.1e'
         % (T_PREV.date(), T.date(), se['max_abs_mean_diff'], se['max_mean_diff_in_sd'], se['max_rel_var_diff']))


# ============================================================ shrinkage
def shrinkage():
    """Same per-game evidence: 1 game moves the posterior away from the prior
    less than 6 games; a NEW game moves the 1-game team more."""
    teams = list(range(20))
    rows = []
    gid = 0
    rng = np.random.default_rng(3)
    k0 = pd.Timestamp('2025-09-01', tz='UTC')
    for wk in range(8):
        perm = rng.permutation(teams)
        for i in range(0, 20, 2):
            a, b = int(perm[i]), int(perm[i + 1])
            for t, o in ((a, b), (b, a)):
                rows.append({'game_id': gid, 'team_id': t, 'opp_id': o, 'H': 0.0,
                             'kickoff_ts': k0 + pd.Timedelta(days=7 * wk), 'n_plays': 70.0, 'epa_sum': 0.0})
            gid += 1
    tg = pd.DataFrame(rows)
    ONE, SIX = 100, 101
    extra = []
    for t, ng in ((ONE, 1), (SIX, 6)):
        for g in range(ng):
            o = g % 20
            for a, b, e in ((t, o, 0.2), (o, t, 0.0)):
                extra.append({'game_id': 1000 + t * 10 + g, 'team_id': a, 'opp_id': b, 'H': 0.0,
                              'kickoff_ts': k0 + pd.Timedelta(days=7 * g), 'n_plays': 70.0, 'epa_sum': e * 70})
    tg = pd.concat([tg, pd.DataFrame(extra)], ignore_index=True)
    allt = teams + [ONE, SIX]
    pr = BR.weak_prior(allt, 0.01, 0.01)
    spec = ('epa_sum', 'n_plays', 'rate')
    fit, _ = R.fit_metric(tg, 'epa', spec, (3.87, 1e-6), pr, want_var=True)
    chk('shrinkage: 1 game of +0.2 EPA/play moves the rating less than 6 such games',
        0 < fit.loc[ONE, 'off'] < fit.loc[SIX, 'off'], fit.loc[[ONE, SIX], 'off'].tolist())
    chk('shrinkage: 6 games -> smaller posterior variance', fit.loc[SIX, 'off_var'] < fit.loc[ONE, 'off_var'])
    new = []
    for t in (ONE, SIX):
        o = 5
        for a, b, e in ((t, o, 0.5), (o, t, 0.0)):
            new.append({'game_id': 5000 + t, 'team_id': a, 'opp_id': b, 'H': 0.0,
                        'kickoff_ts': k0 + pd.Timedelta(days=60), 'n_plays': 70.0, 'epa_sum': e * 70})
    fit2, _ = R.fit_metric(pd.concat([tg, pd.DataFrame(new)], ignore_index=True), 'epa', spec, (3.87, 1e-6),
                           pr, want_var=True)
    d1 = fit2.loc[ONE, 'off'] - fit.loc[ONE, 'off']
    d6 = fit2.loc[SIX, 'off'] - fit.loc[SIX, 'off']
    chk('shrinkage: the same new game moves the 1-game team more than the 6-game team', d1 > d6 > 0, (d1, d6))


# ========================================================= prior decay
def prior_decay():
    fr = TS.freezes(S)
    ts = [fr[i] for i in (1, 3, 5, 7, 9, 11, 13)]
    a = BR.run(seasons_out=[S], only_ts=ts, write=False, return_frames=True, verbose=False, ctx=TS._br_ctx(),
               metrics=None)
    Rr = a['ratings'][S]
    pr = a['priors'][S]
    fbs = TS.opponent_adjust(S, T, diag=False)['fbs']
    ok_all, typical = True, None
    for m in ('epa', 'epa_pass', 'plays_pg'):
        r = Rr[Rr.metric.eq(m) & Rr.team_id.isin(fbs)].copy()
        r['pw'] = r.off_var / r.team_id.map(pr[m]['tau2_o'])
        p = r.pivot(index='prediction_ts', columns='team_id', values='pw').sort_index()
        inc = (p.diff().iloc[1:] > 1e-12).sum().sum()
        ok_all &= inc == 0
        if m == 'epa':
            last = Rr[Rr.metric.eq('epa') & Rr.prediction_ts.eq(ts[-1]) & Rr.team_id.isin(fbs)]
            med = last.n_obs_off.median()
            typical = int(last.iloc[(last.n_obs_off - med).abs().argsort().iloc[0]].team_id)
            seq = p[typical].round(4).tolist()
    chk('prior_weight (posterior var / tau2) never increases through the season (every FBS team, 3 metrics)',
        ok_all)
    chk('prior_weight strictly falls for a typical team (epa offence)', all(np.diff(seq) < 0), seq)
    note('prior_weight, typical FBS team %d, epa offence at 7 freezes: %s' % (typical, seq))
    rows = state()['rows']
    fb = rows[~rows.fcs]
    chk('prior components: every FBS offence decomposes (weights sum to prior_weight)',
        all(abs(sum(v for v in r['offense']['effective_weight'].values()) - r['offense']['prior_weight']) < 1e-9
            or r['offense']['prior_weight'] == 0 for r in fb.prior_components), None)
    oa = TS.opponent_adjust(S, T, diag=False)
    PA = TS.prior_accounting(oa['priors'], oa['explain'], TS.wide(oa['ratings']), fbs, S)
    err = PA.decomposition_error.abs().max()
    chk('prior mean = sum of ridge coefficient x feature terms (all metrics)', err < 1e-9, err)


# ========================================================== recent form
def recent_direction():
    cur = TS.opponent_adjust(S, T, diag=False)
    setup, priors = cur['setup'], cur['priors']
    obs = TS._obs(setup, S, T).copy()
    team = 333
    last = obs[obs.team_id.eq(team)].kickoff_ts.max()
    spec = BR.metric_specs()['epa']

    def fits(o):
        f, _ = R.fit_metric(o, 'epa', spec, setup['varcomp']['epa'], priors['epa'])
        r, _ = R.fit_metric(o, 'epa', spec, setup['varcomp']['epa'], priors['epa'], horizon='recent', T=T,
                            halflife_weeks=C.RECENT_HALFLIFE_WEEKS)
        return f.loc[team, 'off'], r.loc[team, 'off']
    s0, r0 = fits(obs)
    m = obs.team_id.eq(team) & obs.kickoff_ts.eq(last)
    obs.loc[m, 'epa_sum'] += 0.3 * obs.loc[m, 'n_plays']
    s1, r1 = fits(obs)
    chk('recent form: a big latest game raises recent - season', (r1 - s1) > (r0 - s0), (r0 - s0, r1 - s1))
    chk('recent form: the recent horizon moves more than the season horizon', (r1 - r0) > (s1 - s0) > 0)
    rows = state()['rows']
    z = rows.offense_trend_z.dropna()
    chk('trend z-scores are finite for teams with games and centred', len(z) > 150 and abs(z.median()) < 0.5,
        z.describe().to_dict())
    fl = [f for fs in rows.trend_flags for f in fs]
    note('trend flags at %s: %s' % (T.date(), pd.Series(fl).value_counts().to_dict() if fl else {}))


# ================================================== no game at/after T
def point_in_time():
    """Change every stat of every game at or after T (one moved to exactly T),
    rebuild everything from scratch: the state at T is unchanged."""
    base = state()['rows']
    qb0, ev0 = QS.build(S, T)
    orig_tg, orig_q = BR.load_team_games, QB.load
    rng = np.random.default_rng(11)

    def poisoned_tg(seasons):
        TG, G = orig_tg(seasons)
        TG = TG.copy()
        fut = TG.kickoff_ts >= T
        num = [c for c in ('epa_sum', 'n_plays', 'succ', 'epa_pass_sum', 'epa_rush_sum', 'n_db', 'n_rush',
                           'st_net_epa', 'n_plays_all', 'drive_pts', 'turnovers') if c in TG]
        for c in num:
            TG[c] = TG[c].astype(float)
            TG.loc[fut, c] = TG.loc[fut, c] * rng.uniform(0.2, 3.0, fut.sum()) + 5.0
        one = TG.index[fut & TG.g_season.eq(S)][:2]
        TG.loc[one, 'kickoff_ts'] = T                  # a game at exactly T
        return TG, G

    def poisoned_q(seasons):
        Q, G = orig_q(seasons)
        Q = Q.copy()
        fut = Q.kickoff_ts >= T
        Q['epa_db_sum'] = Q['epa_db_sum'].astype(float)
        Q.loc[fut, 'epa_db_sum'] = Q.loc[fut, 'epa_db_sum'] * 5 + 3
        Q.loc[fut, 'starter'] = ~Q.loc[fut, 'starter']
        return Q, G
    TS._reset()
    BR.load_team_games, QB.load = poisoned_tg, poisoned_q
    try:
        prev, _, _ = TS.build(S, T_PREV)
        rows, conv, ex = TS.build(S, T, prev=prev)
        qb1, ev1 = QS.build(S, T)
        later = TS.opponent_adjust(S, TS.freezes(S)[TS.freezes(S).index(T) + 2], diag=False)['ratings']
    finally:
        BR.load_team_games, QB.load = orig_tg, orig_q
        TS._reset()
    same = list(rows.row_hash) == list(base.row_hash)
    chk('perturbing every game at/after T leaves every team state at T identical', same,
        None if same else rows.loc[rows.row_hash != base.row_hash, 'team'].tolist()[:5])
    chk('... and every QB row and event', ids.content_hash(qb0.to_dict('records')) ==
        ids.content_hash(qb1.to_dict('records')) and ids.content_hash(ev0.to_dict('records')) ==
        ids.content_hash(ev1.to_dict('records')))
    clean_later = TS.opponent_adjust(S, TS.freezes(S)[TS.freezes(S).index(T) + 2], diag=False)['ratings']
    chk('... while a later freeze does change (the perturbation was real)',
        not np.allclose(later['off'].values, clean_later['off'].values))


# ============================================================= FCS
def fcs():
    rows = state()['rows']
    fbs = TS.opponent_adjust(S, T, diag=False)['fbs']
    chk('fcs flag = not an FBS team this season', (rows.fcs == ~rows.team_id.isin(fbs)).all())
    f, b = rows[rows.fcs], rows[~rows.fcs]
    chk('FCS teams carry a wider overall SD (every FCS SD > the FBS median)',
        (f.overall_sd > b.overall_sd.median()).all(), (f.overall_sd.min(), b.overall_sd.median()))
    chk('FCS teams are flagged thin data with the reason', f.thin_data.all() and
        all(any('FCS' in x for x in r) for r in f.thin_data_reasons))
    chk('FCS prior pool is the pooled FCS prior', (f.prior_pool == 'fcs_pooled').all())
    note('overall SD at %s: FBS median %.2f, FCS median %.2f points' % (T.date(), b.overall_sd.median(),
                                                                       f.overall_sd.median()))


# =========================================================== special teams
def special_teams():
    fb = TS.st_shock(S, T, 333)
    pv = fb['variants']
    p, dd, fl = pv['production (scale 1.0)'], pv['data-driven tau2 (no floor)'], pv['flat (tau2 1e6)']
    chk('ST: a +14 blocked-punt game barely moves an FBS rating under the production prior',
        abs(p['move_pts']) < 0.01, p)
    chk('ST: ... far less than without the floor or with a flat prior',
        abs(p['move_pts']) < abs(dd['move_pts']) < abs(fl['move_pts']))
    fc = TS.st_shock(S, T, 2640)
    q = fc['variants']['production (scale 1.0)']
    chk('ST: an FCS team (pooled prior, 1 game) moves < 25% of the shock', 0 < q['move_share_of_shock'] < 0.25, q)
    chk('ST: ... and less than under a flat prior',
        q['move_pts'] < fc['variants']['flat (tau2 1e6)']['move_pts'])
    note('ST shock +14: FBS production move %.1e pts (tau2 %.1e), no-floor %.2f, flat %.2f; FCS production %.2f'
         % (p['move_pts'], p['tau2_team'], dd['move_pts'], fl['move_pts'], q['move_pts']))


# ================================================================ QB
def _qrows(games):
    """games: list of [(qb, db_ng, first_play), ...]; the lowest first_play starts."""
    out = []
    k0 = pd.Timestamp('2025-09-01', tz='UTC')
    for i, g in enumerate(games):
        fp_min = min(x[2] for x in g)
        for qb, dbng, fp in g:
            out.append({'game_id': 900 + i, 'kickoff_ts': k0 + pd.Timedelta(days=7 * i), 'qb_id': qb,
                        'db': dbng + 2, 'db_ng': float(dbng), 'first_play': fp, 'starter': fp == fp_min})
    return pd.DataFrame(out)


def _career(rows, team, extra=()):
    c = rows[rows.starter][['qb_id', 'game_id', 'kickoff_ts']].assign(team_id=team)
    if extra:
        c = pd.concat([c, pd.DataFrame(extra)], ignore_index=True)
    return c


def _types(st):
    return sorted(e['type'] for e in st['events'])


def qb_events():
    A, B, X = 1, 2, 3
    r = _qrows([[(A, 30, 1)], [(A, 30, 1)], [(A, 30, 1)], [(A, 30, 1)]])
    st = QS.detect(r, _career(r, 7), 7)
    chk('QB: a settled starter produces no event', _types(st) == [] and st['expected_qb'] == A, _types(st))
    chk('QB: settled starter probability = the (3, 3, not benched) cell', st['starter_probability'] ==
        QS.STARTER_TABLE[(3, 3, False)][0])
    r = _qrows([[(A, 30, 1)], [(A, 30, 1)], [(B, 30, 1)]])
    st = QS.detect(r, _career(r, 7), 7)
    chk('QB: NEW_STARTER + INJURED_STARTER (inferred) when the starter vanishes',
        {'INJURED_STARTER', 'NEW_STARTER'} <= set(_types(st)) and 'BENCHING' not in _types(st) and
        [e for e in st['events'] if e['type'] == 'INJURED_STARTER'][0]['inferred'], _types(st))
    rot = [e for e in st['events'] if e['type'] == 'MULTI_QB_ROTATION']
    chk('QB: a starter switch inside the 3-game window is marked as no same-game sharing',
        all(not e['detail']['same_game_sharing'] for e in rot))
    ext = [{'qb_id': B, 'team_id': 99, 'game_id': 1, 'kickoff_ts': pd.Timestamp('2024-10-01', tz='UTC')},
           {'qb_id': B, 'team_id': 99, 'game_id': 2, 'kickoff_ts': pd.Timestamp('2024-10-08', tz='UTC')}]
    st = QS.detect(r, _career(r, 7, ext), 7)
    tr = [e for e in st['events'] if e['type'] == 'TRANSFER_STARTER']
    chk('QB: TRANSFER_STARTER when the new starter started for another team',
        len(tr) == 1 and tr[0]['detail']['previous_team_id'] == 99 and tr[0]['detail']['previous_team_starts'] == 2,
        _types(st))
    r = _qrows([[(A, 30, 1)], [(B, 30, 1)], [(A, 30, 1)]])
    st = QS.detect(r, _career(r, 7), 7)
    ret = [e for e in st['events'] if e['type'] == 'RETURNING_STARTER']
    chk('QB: RETURNING_STARTER after a missed start', len(ret) == 1 and ret[0]['qb_id'] == A and
        ret[0]['detail']['games_missed'] == 1, _types(st))
    r = _qrows([[(A, 30, 1)], [(A, 30, 1)], [(A, 10, 1), (B, 20, 40)]])
    st = QS.detect(r, _career(r, 7), 7)
    chk('QB: BENCHING when a reliever takes >= 40% of the dropbacks',
        'BENCHING' in _types(st) and st['benched_latest'], _types(st))
    chk('QB: a benched expected starter is AMBIGUOUS (probability below 0.60)',
        'AMBIGUOUS_STARTER' in _types(st) and st['starter_probability'] < QS.AMBIGUOUS_P)
    r = _qrows([[(A, 12, 1), (B, 38, 40)], [(A, 30, 1)], [(A, 35, 1)]])
    st = QS.detect(r, _career(r, 7), 7)
    chk('QB: garbage-free relief below 40% is not a benching', 'BENCHING' not in _types(st))
    r = _qrows([[(A, 31, 1), (B, 19, 30)], [(A, 31, 1), (B, 19, 30)], [(A, 31, 1), (B, 19, 30)]])
    st = QS.detect(r, _career(r, 7), 7)
    chk('QB: MULTI_QB_ROTATION (two QBs >= 30% over 3 games), same starter: not ambiguous',
        _types(st) == ['MULTI_QB_ROTATION'] and st['events'][0]['detail']['same_game_sharing'], _types(st))
    r = _qrows([[(A, 31, 1), (B, 19, 30)], [(B, 31, 1), (A, 19, 30)], [(A, 31, 1), (B, 19, 30)]])
    st = QS.detect(r, _career(r, 7), 7)
    amb = [e for e in st['events'] if e['type'] == 'AMBIGUOUS_STARTER']
    chk('QB: a rotation with different starters is AMBIGUOUS_STARTER (review)',
        len(amb) == 1 and amb[0]['detail']['review'] and 'MULTI_QB_ROTATION' in _types(st), _types(st))
    r = _qrows([[(A, 30, 1)], [(B, 30, 1)], [(B, 30, 1)], [(B, 30, 1)]])
    st = QS.detect(r, _career(r, 7), 7)
    chk('QB: 3 straight starts after a change = stabilizing', st['stabilizing'] and st['streak'] == 3)
    p = st['probabilities']
    chk('QB: starter probabilities in [0, 1] and sum to 1 with the unlisted mass',
        all(0 <= v <= 1 for v in p.values()) and abs(sum(p.values()) + st['p_unlisted'] - 1) < 1e-9, p)
    # lineup inflation
    qb_rows = pd.DataFrame([
        {'team_id': 7, 'qb_id': A, 'qb_name': 'a', 'expected_starter': False, 'dropback_share': 0.9,
         'posterior_sd': 0.07, 'starter_probability': 0.1, 'qb_stabilizing': False},
        {'team_id': 7, 'qb_id': B, 'qb_name': 'b', 'expected_starter': True, 'dropback_share': 0.1,
         'posterior_sd': 0.09, 'starter_probability': 0.9, 'qb_stabilizing': False}])
    lu = QS.lineup(qb_rows, pd.DataFrame(), 7)
    want = 0.9 ** 2 * 0.09 ** 2 + 0.9 ** 2 * 0.07 ** 2
    chk('QB: a backup taking over inflates offensive variance by Var(theta_new - theta_mix)',
        lu['qb_change'] and abs(lu['qb_offense_var_inflation_epa_db2'] - want) < 1e-12, lu)
    qb_rows.loc[:, 'expected_starter'] = [True, False]
    chk('QB: no inflation when the expected starter built the ratings',
        QS.lineup(qb_rows, pd.DataFrame(), 7)['qb_offense_var_inflation_epa_db2'] == 0.0)
    # real rows
    rows = state()['rows']
    lc = rows.lineup_context.dropna()
    chk('team rows carry the QB context; the offence mean is never rewritten',
        len(lc) > 150 and (rows.offense_sd_with_qb >= rows.offense_sd - 1e-12).all())


def starter_calibration():
    tab = QS.STARTER_TABLE
    chk('starter probability table in [0, 1]', all(0 <= v[0] <= 1 for v in tab.values()))
    tr = QS.transitions(range(2016, 2024))
    refit = QS.fit_starter_table(tr)
    chk('the stored table re-derives from DEV 2016-2023', all(abs(refit['table'][k][0] - tab[k][0]) < 1e-4
                                                              for k in tab) and
        refit['change_split'] == QS.CHANGE_SPLIT, refit['table'])
    ll = {sd: np.mean([QS.calibration_report(tr, range(2016, Y), Y, sd)['log_loss'] for Y in range(2019, 2024)])
          for sd in (None, 0.1, 0.2, 0.3, 0.5)}
    best = min(ll, key=lambda k: ll[k])
    chk('LEVEL_SD is the dev walk-forward log-loss choice', best == QS.LEVEL_SD, ll)
    r = QS.calibration_report(tr, range(2016, 2023), 2023)
    chk('held-out 2023: probabilities in [0, 1]', r['n'] > 1000)
    chk('held-out 2023: expected calibration error < 0.03', r['ece'] < 0.03, r['ece'])
    chk('held-out 2023: calibration-in-the-large within 2.5 SE', abs(r['in_the_large_z']) < 2.5,
        (r['mean_predicted'], r['mean_observed'], r['in_the_large_z']))
    chk('held-out 2023: calibration slope within 2 SE of 1', abs(r['slope'] - 1) < 2 * r['slope_se'],
        (r['slope'], r['slope_se']))
    chk('held-out 2023: Brier beats the constant same-starter rate', r['brier'] < r['brier_constant'],
        (r['brier'], r['brier_constant']))
    worst = max((c for c in r['cells'] if c['n'] >= 30), key=lambda c: abs(c['z']))
    _STATE['cal'] = r
    note('starter probability, held-out 2023 (%d transitions): ECE %.4f, slope %.3f +- %.3f, mean p %.4f vs '
         'observed %.4f, Brier %.4f vs %.4f constant; worst cell %s z %.2f (%.3f vs %.3f, n %d)'
         % (r['n'], r['ece'], r['slope'], r['slope_se'], r['mean_predicted'], r['mean_observed'], r['brier'],
            r['brier_constant'], worst['cell'], worst['z'], worst['observed'], worst['predicted'], worst['n']))
    q, _ = QS.build(S, T)
    chk('real build: starter probabilities in [0, 1]', q.starter_probability.dropna().between(0, 1).all())
    note('in-season level shift at %s: %.4f from %d resolved transitions'
         % (T.date(), q.starter_level_shift.iloc[0], q.starter_level_n.iloc[0]))


def qb_uncertainty():
    q1, _ = QS.build(S, T_PREV)
    q2, _ = QS.build(S, T)
    j = q1.merge(q2, on=['team_id', 'qb_id'], suffixes=('_a', '_b'))
    more = j[j.n_eff_dropbacks_b > j.n_eff_dropbacks_a + 1e-9]
    chk('QB posterior SD shrinks when dropbacks accrue (same QB, a week later)',
        len(more) > 100 and (more.posterior_sd_b < more.posterior_sd_a).all())
    o = q2.sort_values('n_eff_dropbacks')
    chk('QB posterior SD is decreasing in effective dropbacks', (np.diff(o.posterior_sd.values) <= 1e-15).all())
    sh = QS._shrinkage()[1]
    chk('QB shrinkage is V2 qb.py (k ~ 150.6 dropbacks)', abs(sh['k_dropbacks'] - 150.5696) < 0.01,
        sh['k_dropbacks'])
    one = q2[q2.expected_starter]
    chk('one expected starter per team with games', one.team_id.is_unique and len(one) > 200)
    num = ['starter_probability', 'adj_epa_db', 'success_rate', 'sack_rate', 'rush_contribution',
           'explosive_pass_rate', 'turnover_proxy', 'posterior_value', 'posterior_sd']
    bad = []
    for r in q2.to_dict('records'):
        for c in num:
            v = r[c]
            if v is None or (isinstance(v, float) and not np.isfinite(v)):
                if c not in r['null_reasons'] and c != 'starter_probability':
                    bad.append((r['qb_id'], c))
    chk('every QB numeric is finite or null with a reason', not bad, bad[:5])


# ============================================================ state rows
def rows_contract():
    st = state()
    rows, ex, prev = st['rows'], st['ex'], st['prev']
    need = ['overall_mean', 'overall_sd', 'offense_mean', 'offense_sd', 'defense_mean', 'defense_sd', 'st_mean',
            'st_sd', 'pass_off_mean', 'pass_off_sd', 'rush_off_mean', 'rush_off_sd', 'pass_def_mean',
            'pass_def_sd', 'rush_def_mean', 'rush_def_sd', 'season_strength', 'recent_strength',
            'recent_minus_season', 'volatility', 'hfa', 'fcs', 'trend_flags', 'lineup_context',
            'prior_weight_offense', 'prior_weight_defense', 'prior_weight_st', 'n_games', 'meaningful_plays_off']
    chk('rows carry the DESIGN contract columns', set(need) <= set(rows.columns),
        set(need) - set(rows.columns))
    chk('one row per team with games or a prior', rows.team_id.is_unique and len(rows) == 230, len(rows))
    core = [c for c in need if c.endswith('_mean') or c.endswith('_sd')] + ['season_strength', 'recent_strength']
    chk('core numerics finite for every team', np.isfinite(rows[core].astype(float).values).all())
    chk('overall = offense + defense + st', np.allclose(rows.overall_mean, rows.offense_mean + rows.defense_mean
                                                        + rows.st_mean, atol=1e-9))
    fb = rows[~rows.fcs]
    chk('points scale is centred on the average FBS team (the FBS mean rating is 0)',
        abs((fb.offense_mean / fb.exp_plays).mean()) < 1e-9 and abs((fb.defense_mean / fb.exp_plays).mean()) < 1e-9)
    # V2's own conversion: a matchup vs the FBS-average team at a neutral site
    cur = TS.opponent_adjust(S, T, diag=False)
    W, lg = TS.wide(cur['ratings']), TS.league_at(cur['league'])
    fbl = [t for t in W['epa'].index if t in cur['fbs']]
    t = 333
    ep, pl = W['epa'], W['plays_pg']
    avg_o, avg_d = ep.loc[fbl, 'off'].mean(), ep.loc[fbl, 'def'].mean()
    exp_total = 2 * lg['plays_pg'][0] + pl.loc[t, 'off'] + pl.loc[fbl, 'def'].mean() + pl.loc[fbl, 'off'].mean() \
        + pl.loc[t, 'def']
    eff = ((ep.loc[t, 'off'] + avg_d) - (avg_o + ep.loc[t, 'def'])) * exp_total / 2.0   # snapshots.eff_pts_raw
    r = rows.set_index('team_id').loc[t]
    chk('offense + defense = snapshots.eff_pts_raw against the FBS-average team (neutral)',
        abs(eff - (r.offense_mean + r.defense_mean)) < 1e-9, (eff, r.offense_mean + r.defense_mean))
    # explanations
    cl = max(abs(e[u]['closure']) for e in ex.values() for u in ('offense', 'defense', 'st', 'overall'))
    fp = max(e['fixed_point_check'] for e in ex.values())
    chk('explanations: components sum to the week-over-week change (every team, every unit)', cl < 1e-9, cl)
    chk('explanations: the conditional re-solves reproduce both joint solutions', fp < 1e-9, fp)
    chk('explanations: consistent with the prev rows given', all(
        e.get('prev_rows_consistent_max_abs', 0) < 1e-9 for e in ex.values()))
    chk('explanations report mean AND sd movement', all('sd_change' in e['overall'] for e in ex.values()))
    num = [c for c in rows.columns if rows[c].dtype.kind == 'f']
    bad = [(c, int((~np.isfinite(rows[c])).sum())) for c in num if (~np.isfinite(rows[c])).any()
           and c not in ('recent_minus_season_sd', 'offense_trend_z', 'defense_trend_z', 'volatility_recent',
                         'volatility_trend_z', 'hfa_team_evidence_pts', 'hfa_team_evidence_raw_pts',
                         'qb_offense_var_inflation_pts2')]
    chk('no unexpected non-finite value', not bad, bad)
    # guardrails
    fl = TS.movement_flags(rows, prev, ex, k=TS.transition_index(S, T))
    chk('movement flags carry drivers', all(f['drivers'] for f in fl))
    fake = prev.copy()
    fake.loc[fake.team_id.eq(333), 'overall_mean'] -= 12.0
    fl2 = TS.movement_flags(rows, fake, ex, k=TS.transition_index(S, T))
    chk('a 12-point overall move is flagged', any(f['team_id'] == 333 and f['flag'] == 'MOVE_ABOVE_P995'
                                                 for f in fl2))
    note('movement flags at %s (k=%d): %d' % (T.date(), TS.transition_index(S, T), len(fl)))
    dm = TS.delta_method_check(S, T)
    chk('delta-method SDs within 5% of the full-covariance SDs (FBS)',
        all(v['fbs_max_rel_err'] < 0.05 for v in dm['units'].values()), dm['units'])
    note('delta method vs full covariance: overall max rel err %.2f%%, median %.2f%%'
         % (100 * dm['units']['overall']['fbs_max_rel_err'], 100 * dm['units']['overall']['fbs_median_rel_err']))


def movement_bounds():
    prov = TS.MOVE_BOUNDS['provenance']['ratings_sha256_16']
    chk('movement bounds are stored with provenance', len(prov) == 8)
    base = C.OUT
    if not all(os.path.exists(os.path.join(base, 'stage3', 'ratings_%d.parquet' % s)) for s in prov):
        note('dev stage-3 files missing under %s: bound re-derivation skipped' % base)
        return
    same = all((ids.file_hash(os.path.join(base, 'stage3', 'ratings_%d.parquet' % s)) or '')[:16] == h
               for s, h in prov.items())
    if not same:
        note('dev stage-3 files are not the provenance build (the bounds read only off/def/var, not vol)')
    b, _ = TS.estimate_movement_bounds(out_dir=base)
    keys = ('fbs_abs_move_p995', 'fbs_sd_drop_p995', 'fcs_abs_move_p995', 'fcs_sd_drop_p995')
    chk('stored movement bounds re-derive from the dev stage-3 files',
        all(abs(b[k] - TS.MOVE_BOUNDS[k]) < 1e-3 for k in keys) and
        all(abs(b['by_bucket'][kd][bk]['abs_move_p995'] - v['abs_move_p995']) < 1e-3
            for kd in ('fbs', 'fcs') for bk, v in TS.MOVE_BOUNDS['by_bucket'][kd].items()),
        {k: b[k] for k in keys})


def determinism():
    rows = state()['rows']
    rows2, conv2, ex2 = TS.build(S, T, prev=state()['prev'])
    chk('team state is deterministic (row hashes)', list(rows.row_hash) == list(rows2.row_hash))
    q1, e1 = QS.build(S, T)
    q2, e2 = QS.build(S, T)
    chk('QB state is deterministic', ids.content_hash(q1.to_dict('records')) == ids.content_hash(
        q2.to_dict('records')) and ids.content_hash(e1.to_dict('records')) == ids.content_hash(e2.to_dict('records')))


def main():
    full = '--full' in sys.argv
    t0 = time.time()
    for fn in (hooks_identical, convergence, sequential, shrinkage, prior_decay, recent_direction, fcs,
               special_teams, qb_events, starter_calibration, qb_uncertainty, rows_contract, movement_bounds,
               determinism, point_in_time):
        section(fn)
    if full:
        section(hooks_full_season)
    for f in FAILS:
        print('FAIL | ' + f)
    print('(%.0fs)' % (time.time() - t0))
    print(('FAILED ' if FAIL[0] else 'ALL GREEN ') + '%d passed, %d failed' % (PASS[0], FAIL[0]))
    sys.exit(1 if FAIL[0] else 0)


if __name__ == '__main__':
    from .runlog import single_thread_blas
    single_thread_blas('v2.weekly.tests_state')
    main()
