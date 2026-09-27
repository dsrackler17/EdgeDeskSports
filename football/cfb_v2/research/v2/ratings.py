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
          h_prior=(0.0, 1.0), prior_weight=1.0, want_var=False):
    """Weighted ridge / Gaussian posterior. Returns (x, var or None).

    w: precision weights per observation (already 1/Var(e) * recency).
    prior_weight: multiplies every team prior precision (recency horizon)."""
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
    if want_var:
        try:
            Ainv = np.linalg.inv(A)
            return Ainv @ b, np.diag(Ainv).copy()
        except np.linalg.LinAlgError:
            return np.linalg.solve(A, b), np.full(P, np.nan)
    return np.linalg.solve(A, b), None


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
               halflife_weeks=None, want_var=False):
    """Fit one metric on the rows in `tg` (all kicked off before T).

    tg columns: team_id, opp_id, H, kickoff_ts, + metric num/den.
    prior: dict with 'o' {team:(mean,)}, 'd', 'tau2_o' {team:var}, 'tau2_d', 'h' (mean,var).
    Returns DataFrame indexed by team: off, def, off_var, def_var, mu, h, n_obs, n_eff."""
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
    x, var = solve(D, sub.team_id.values, sub.opp_id.values, sub.H.values, y.values, w,
                   po, pd_, tau_o, tau_d, h_prior=prior['h'], prior_weight=pw, want_var=want_var)
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
