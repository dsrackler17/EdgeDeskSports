"""Stage 3 — opponent-adjusted unit ratings, solved jointly, at every prediction timestamp.

For one metric (say pass EPA per dropback), each team-game gives one
observation for the OFFENSE t facing the DEFENSE d:

    y = mu + o_t + d_d + h * H + e,       Var(e) = s2_play / n + s2_game

H = +1 when the offense is at home, -1 when away, 0 at a neutral site. The
offensive rating o_t and defensive rating d_d are estimated TOGETHER in one
Gaussian posterior (a weighted ridge whose penalty is a Bayesian prior):

    o_t ~ N(prior_o_t, tau_o_t^2),   d_d ~ N(prior_d_d, tau_d_d^2)

That joint solve is the fixed point the classic iterative adjustment
("subtract the opponent's rating, recompute, repeat") converges to — it is not
a strength-of-schedule multiplier and it needs no iteration count. Offence and
defence depend on each other and are identified together.

Consequences that fall out of the maths rather than being bolted on:
  * shrinkage by effective sample size: few plays -> large s2/n -> the prior
    dominates; many games -> the data dominates;
  * the preseason prior fades exactly as fast as its variance says it should
    (tau is estimated from history, then scaled by one tuned multiplier);
  * the posterior variance of every rating is available and is used as an
    uncertainty/reliability input downstream.

Two horizons per metric, kept SEPARATE (never averaged into one number):
  season  every game this season weighted equally;
  recent  every observation AND the prior weighted by 0.5 ** (age / half-life),
          so the prior is treated as the oldest observation and fades with it.
Plus last-4 / last-2 residual form: the mean of (observed - expected) over a
team's most recent meaningful games, shrunk by n / (n + k).

Everything is computed from games that KICKED OFF before the prediction
timestamp. `fit()` asserts it.
"""
import numpy as np
import pandas as pd

from . import config as C

GAME_KIND_METRICS = {'plays_pg', 'drives_pg'}


class Design:
    """Index of teams for one season-to-date sample."""

    def __init__(self, teams):
        self.teams = list(teams)
        self.ix = {t: i for i, t in enumerate(self.teams)}
        self.nt = len(self.teams)
        # params: [mu, h, o_0..o_{nt-1}, d_0..d_{nt-1}]
        self.p = 2 + 2 * self.nt

    def o(self, t):
        return 2 + self.ix[t]

    def d(self, t):
        return 2 + self.nt + self.ix[t]


def solve(design, off_ids, def_ids, H, y, w, prior_o, prior_d, tau2_o, tau2_d,
          h_prior=(0.0, 1.0), prior_weight=1.0, want_var=False, diag=None, x0=None,
          system_out=None):
    """Weighted ridge / Gaussian posterior. Returns (x, var or None).

    w: precision weights per observation (already 1/Var(e) * recency).
    prior_weight: multiplies every team prior precision (recency horizon).

    Optional instrumentation (default off; x and var are computed by the same
    expressions whether or not it is on, so every output is unchanged):
      diag        a list: one convergence record is appended (solve_diagnostics)
      x0          start of the conjugate-gradient cross-check (last week's
                  solution); default the prior means
      system_out  a dict: receives the normal equations A, b, the solution x,
                  the full inverse (want_var) and the prior mean/precision"""
    from scipy import sparse
    D = design
    P = D.p
    n = len(y)
    io = np.fromiter((D.o(t) for t in off_ids), dtype=np.int64, count=n)
    idd = np.fromiter((D.d(t) for t in def_ids), dtype=np.int64, count=n)
    rows = np.repeat(np.arange(n), 4)
    cols = np.stack([np.zeros(n, dtype=np.int64), np.ones(n, dtype=np.int64), io, idd], axis=1).ravel()
    vals = np.stack([np.ones(n), H.astype(float), np.ones(n), np.ones(n)], axis=1).ravel()
    X = sparse.csr_matrix((vals, (rows, cols)), shape=(n, P))
    Xw = X.multiply(w[:, None]).tocsr()
    A = (X.T @ Xw).toarray()
    b = np.asarray(Xw.T @ y).ravel()
    # priors: mu flat (tiny precision), h ~ N(h_prior)
    A[0, 0] += 1e-6
    A[1, 1] += 1.0 / h_prior[1]
    b[1] += h_prior[0] / h_prior[1]
    nt = D.nt
    po = np.array([prior_o.get(t, (0.0,))[0] for t in D.teams])
    pdm = np.array([prior_d.get(t, (0.0,))[0] for t in D.teams])
    prec_o = prior_weight / np.array([tau2_o[t] for t in D.teams])
    prec_d = prior_weight / np.array([tau2_d[t] for t in D.teams])
    io_ = np.arange(2, 2 + nt)
    id_ = np.arange(2 + nt, 2 + 2 * nt)
    A[io_, io_] += prec_o
    b[io_] += prec_o * po
    A[id_, id_] += prec_d
    b[id_] += prec_d * pdm
    if diag is None and system_out is None:
        if want_var:
            try:
                Ainv = np.linalg.inv(A)
                return Ainv @ b, np.diag(Ainv).copy()
            except np.linalg.LinAlgError:
                return np.linalg.solve(A, b), np.full(P, np.nan)
        return np.linalg.solve(A, b), None
    # instrumented path: the same arithmetic as above, then the records
    Ainv = None
    if want_var:
        try:
            Ainv = np.linalg.inv(A)
            x, var = Ainv @ b, np.diag(Ainv).copy()
        except np.linalg.LinAlgError:
            Ainv = None
            x, var = np.linalg.solve(A, b), np.full(P, np.nan)
    else:
        x, var = np.linalg.solve(A, b), None
    prior_mean = np.concatenate([[0.0, float(h_prior[0])], po, pdm])
    if diag is not None:
        start = prior_mean if x0 is None else np.asarray(x0, dtype=float)
        rec = solve_diagnostics(A, b, x, start, prior_mean)
        rec['cg_start'] = 'prior_means' if x0 is None else 'prev_week'
        diag.append(rec)
    if system_out is not None:
        system_out.update(A=A, b=b, x=x, Ainv=Ainv, prior_mean=prior_mean,
                          prior_prec=np.concatenate([[1e-6, 1.0 / h_prior[1]], prec_o, prec_d]))
    return x, var


# convergence record thresholds (docs/cfb-weekly/METHODS_STATE.md)
CG_TOL = 1e-10            # CG stops at this residual, relative to the evidence (see below)
RESIDUAL_TOL = 1e-9       # the direct solution's relative residual ||Ax - b|| / ||b||
DELTA_TOL = 1e-6          # max |x_cg - x_direct|, in rating units
CG_REF_FLOOR = 1e-4       # the CG reference never falls below 1e-4 ||S b|| (round-off)


def conjugate_gradient(A, b, x0, ref, tol=CG_TOL, maxiter=None):
    """Jacobi-preconditioned conjugate gradient on A x = b (A symmetric
    positive definite), written as plain CG on the symmetrically scaled
    system (S A S) z = S b, S = diag(A)^-1/2, x = S z.

    Stopping rule: ||S (b - A x)|| <= tol * ||S ref||, ref = b - A m with m the
    prior means, i.e. the residual relative to the EVIDENCE the data add to
    the prior (CG on the deviation from the prior). Relative to ||b|| the
    rule would be meaningless for metrics whose FBS prior variance sits at its
    1.5e-9 floor: b then carries 1e9 x prior mean on those rows and the
    residual of every other row is invisible beside it. The reference is
    floored at CG_REF_FLOOR x ||S b|| so the target stays above round-off when
    the data barely move the prior (a season's first few games).
    Deterministic: fixed order of operations, no randomness.
    Returns (x, iterations, converged, relative residual at stop, reference used)."""
    d = np.sqrt(np.diag(A))
    s = 1.0 / d
    As = A * s[:, None] * s[None, :]
    bs = b * s
    z = np.asarray(x0, dtype=float) * d
    r = bs - As @ z
    nb = float(np.linalg.norm(bs))
    nref = float(np.linalg.norm(ref * s))
    kind = 'evidence ||S(b - A m)||'
    if nref < CG_REF_FLOOR * nb or nref == 0.0:
        nref, kind = (CG_REF_FLOOR * nb) or 1.0, 'floor %.0e ||S b||' % CG_REF_FLOOR
    p = r.copy()
    rr = float(r @ r)
    maxiter = maxiter or 20 * len(b)
    it = 0
    while np.sqrt(rr) > tol * nref and it < maxiter:
        Ap = As @ p
        alpha = rr / float(p @ Ap)
        z = z + alpha * p
        r = r - alpha * Ap
        rr_new = float(r @ r)
        p = r + (rr_new / rr) * p
        rr = rr_new
        it += 1
    rel = float(np.linalg.norm(bs - As @ z)) / nref
    return z * s, it, bool(rel <= tol), rel, kind


def solve_diagnostics(A, b, x, x_start, prior_mean):
    """Convergence record of one solve: residual, conditioning, and an
    iterative cross-check (CG from x_start) against the direct solution."""
    nb = float(np.linalg.norm(b)) or 1.0
    rel_res = float(np.linalg.norm(A @ x - b)) / nb
    cond = float(np.linalg.cond(A))
    d = np.sqrt(np.diag(A))
    cond_scaled = float(np.linalg.cond(A / d[:, None] / d[None, :]))
    xc, it, ok, rel_cg, ref_kind = conjugate_gradient(A, b, x_start, b - A @ prior_mean)
    delta = float(np.max(np.abs(xc - x))) if len(x) else 0.0
    return {'n_params': int(len(b)), 'solved': True, 'rel_residual': rel_res,
            'residual_threshold': RESIDUAL_TOL, 'cond': cond, 'cond_scaled': cond_scaled,
            'cg_method': 'jacobi_pcg', 'cg_tol': CG_TOL, 'cg_tol_reference': ref_kind,
            'cg_iters': int(it), 'cg_converged': ok, 'cg_rel_residual_evidence': rel_cg,
            'cg_rel_residual': float(np.linalg.norm(A @ xc - b)) / nb,
            'delta_max_abs': delta, 'delta_threshold': DELTA_TOL,
            'converged': bool(rel_res < RESIDUAL_TOL and ok and delta < DELTA_TOL)}


def start_vector(design, x0, prior_o, prior_d, h_prior):
    """A full parameter vector from a {'mu', 'h', 'off', 'def'} solution; a
    missing or non-finite entry falls back to its prior mean (mu: 0)."""
    def pick(v, fallback):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return fallback
        return v if np.isfinite(v) else fallback
    off, dfn = x0.get('off', {}), x0.get('def', {})
    return np.concatenate([
        [pick(x0.get('mu'), 0.0), pick(x0.get('h'), float(h_prior[0]))],
        [pick(off.get(t), prior_o[t][0]) for t in design.teams],
        [pick(dfn.get(t), prior_d[t][0]) for t in design.teams]])


def metric_obs(tg, num, den, kind):
    """Rows usable for one metric: value y and effective count n."""
    if kind == 'game':
        y = tg[num].astype(float)
        n = pd.Series(1.0, index=tg.index)
    else:
        n = tg[den].astype(float)
        y = tg[num].astype(float) / n.where(n > 0)
    ok = y.notna() & n.notna() & (n > 0) & np.isfinite(y)
    return y[ok], n[ok], ok


def obs_weights(n, s2_play, s2_game):
    return 1.0 / (s2_play / n + s2_game)


def fit_metric(tg, metric, spec, varcomp, prior, horizon='season', T=None,
               halflife_weeks=None, want_var=False, diag=None, x0=None, system_out=None):
    """Fit one metric on the rows in `tg` (all kicked off before T).

    tg columns: team_id, opp_id, H, kickoff_ts, + metric num/den.
    prior: dict with 'o' {team:(mean,)}, 'd', 'tau2_o' {team:var}, 'tau2_d', 'h' (mean,var).
    Returns DataFrame indexed by team: off, def, off_var, def_var, mu, h, n_obs, n_eff.

    Optional, default off (outputs unchanged): `diag` (list) receives this
    solve's convergence record, tagged with metric/horizon; `x0` is the CG
    start as {'mu', 'h', 'off': {team: v}, 'def': {team: v}} (last week's
    solution; a team or value it lacks starts at its prior mean);
    `system_out` (dict) receives the normal equations and the observation
    rows (see solve)."""
    num, den, kind = spec
    y, n, ok = metric_obs(tg, num, den, kind)
    sub = tg[ok]
    teams = sorted(set(prior['o'].keys()) | set(sub.team_id) | set(sub.opp_id))
    D = Design(teams)
    s2p, s2g = varcomp
    w = obs_weights(n.values, s2p, s2g)
    pw = 1.0
    if horizon == 'recent':
        assert T is not None and halflife_weeks
        age_w = (T - sub.kickoff_ts).dt.total_seconds().values / (7 * 86400.0)
        w = w * 0.5 ** (age_w / halflife_weeks)
        season_start = prior.get('season_start')
        if season_start is not None:
            age_p = max(0.0, (T - season_start).total_seconds() / (7 * 86400.0))
            pw = 0.5 ** (age_p / halflife_weeks)
    tau_o = dict(prior['tau2_o'])
    tau_d = dict(prior['tau2_d'])
    for t in teams:
        if t not in tau_o:
            tau_o[t] = prior['tau2_default_o']
            tau_d[t] = prior['tau2_default_d']
    po = {t: (prior['o'].get(t, (prior.get('default_o', 0.0),))[0],) for t in teams}
    pd_ = {t: (prior['d'].get(t, (prior.get('default_d', 0.0),))[0],) for t in teams}
    if diag is None and system_out is None:
        x, var = solve(D, sub.team_id.values, sub.opp_id.values, sub.H.values, y.values, w,
                       po, pd_, tau_o, tau_d, h_prior=prior['h'], prior_weight=pw, want_var=want_var)
    else:
        xs = None if x0 is None else start_vector(D, x0, po, pd_, prior['h'])
        x, var = solve(D, sub.team_id.values, sub.opp_id.values, sub.H.values, y.values, w,
                       po, pd_, tau_o, tau_d, h_prior=prior['h'], prior_weight=pw, want_var=want_var,
                       diag=diag, x0=xs, system_out=system_out)
        if diag is not None:
            diag[-1].update(metric=metric, horizon=horizon, n_obs=int(len(y)))
        if system_out is not None:
            system_out.update(design=D, rows=sub.index.values, y=y.values.astype(float),
                              n=n.values.astype(float), w=np.asarray(w, dtype=float),
                              prior_weight=pw, horizon=horizon, metric=metric)
    mu, h = x[0], x[1]
    out = pd.DataFrame(index=pd.Index(teams, name='team_id'))
    out['off'] = [x[D.o(t)] for t in teams]
    out['def'] = [x[D.d(t)] for t in teams]
    if var is not None:
        out['off_var'] = [var[D.o(t)] for t in teams]
        out['def_var'] = [var[D.d(t)] for t in teams]
    cnt = sub.groupby('team_id').size()
    cnt_d = sub.groupby('opp_id').size()
    out['n_obs_off'] = cnt.reindex(out.index).fillna(0).values
    out['n_obs_def'] = cnt_d.reindex(out.index).fillna(0).values
    ne = pd.Series(n.values, index=sub.index).groupby(sub.team_id).sum()
    out['n_eff_off'] = ne.reindex(out.index).fillna(0).values
    out.attrs['mu'] = mu
    out.attrs['h'] = h
    # per-observation residuals (for last-k form and variance components)
    pred = mu + h * sub.H.values + out.loc[sub.team_id.values, 'off'].values \
        + out.loc[sub.opp_id.values, 'def'].values
    res = pd.DataFrame({'team_id': sub.team_id.values, 'opp_id': sub.opp_id.values,
                        'kickoff_ts': sub.kickoff_ts.values, 'res': y.values - pred, 'n': n.values})
    return out, res


def residual_volatility(res, prior_sd, k=3.0):
    """Game-to-game SD of a team's residuals (offence and defence pooled),
    shrunk toward the league residual SD with k pseudo-games."""
    r = pd.concat([res[['team_id', 'res']],
                   res[['opp_id', 'res']].rename(columns={'opp_id': 'team_id'})])
    g = r.groupby('team_id').res.agg(['var', 'size'])
    v = (g['var'].fillna(prior_sd ** 2) * (g['size'] - 1).clip(lower=0) + k * prior_sd ** 2) \
        / ((g['size'] - 1).clip(lower=0) + k)
    return np.sqrt(v)


def residual_form(res, k_games, shrink_k):
    """Mean residual over each team's last k games, offence and defence, shrunk."""
    res = res.sort_values('kickoff_ts')
    o = res.groupby('team_id').tail(k_games).groupby('team_id').res.agg(['mean', 'size'])
    d = res.groupby('opp_id').tail(k_games).groupby('opp_id').res.agg(['mean', 'size'])
    o['v'] = o['mean'] * o['size'] / (o['size'] + shrink_k)
    d['v'] = d['mean'] * d['size'] / (d['size'] + shrink_k)
    return o['v'], d['v']


def estimate_varcomp(res):
    """Method of moments: E[res^2] = s2_play / n + s2_game (regression of res^2 on 1/n)."""
    r2 = res.res.values ** 2
    inv = 1.0 / res.n.values
    X = np.stack([np.ones_like(inv), inv], axis=1)
    beta, *_ = np.linalg.lstsq(X, r2, rcond=None)
    s2g, s2p = float(beta[0]), float(beta[1])
    if s2p <= 0:
        s2p = float(np.var(res.res.values) * np.median(res.n.values) * 0.5)
    if s2g <= 0:
        s2g = 1e-6
    return s2p, s2g
