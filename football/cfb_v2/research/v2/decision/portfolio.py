"""The risk layer's evidence: correlations, staking, portfolio simulation, drawdown and risk of ruin.

Everything here runs AFTER selection (brief §38): it sizes and caps; it never
changes which quotes qualify.

    same_game_correlations(G)      phi coefficients of outcome indicators on DEV finals (spread / total /
                                   moneyline / alternate lines / synthetic team totals), game bootstrap CIs
    cross_game_icc(df)             within-week and within-conference-week correlation of model-side results
    season_bootstrap(blocks)       seasons of 15 weeks resampled from observed weeks: units, SD, 5th pct, drawdown, worst week
    risk_of_ruin(...)              Monte Carlo with parameter uncertainty (Beta posterior) and within-week correlation
    kelly_compare(df, ...)         flat vs fractional Kelly with hard caps (the Kelly input capped at saturation)
    choose_slate_cap(...)          the pre-registered slate-cap rule

Seeds: config.SEED; every simulation is deterministic.
"""
import math

import numpy as np
import pandas as pd
from scipy import stats

from .. import config as C
from . import core
from .scorecard import cluster_boot, r, rl

B110 = 100.0 / 110.0


# ------------------------------------------------------------ correlations
def _phi(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 30 or x.std() == 0 or y.std() == 0:
        return None, int(len(x))
    return float(np.corrcoef(x, y)[0, 1]), int(len(x))


def _phi_ci(x, y, B=2000, seed=None):
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    n = len(x)
    if n < 30:
        return [None, None]
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    out = np.empty(B)
    for i in range(B):
        j = rng.integers(0, n, n)
        a, b = x[j], y[j]
        out[i] = np.corrcoef(a, b)[0, 1] if a.std() > 0 and b.std() > 0 else np.nan
    out = out[np.isfinite(out)]
    return [float(np.quantile(out, 0.025)), float(np.quantile(out, 0.975))]


def _ind(cond, push):
    v = np.where(cond, 1.0, 0.0)
    return np.where(push, np.nan, v)


def same_game_correlations(G, B=2000):
    """G: DEV FBS finals with margin, total_pts, home_points, away_points, close_margin, total_close.
    Lines are the consensus CLOSE (the most complete); outcome indicators exclude pushes."""
    G = G[G.margin.notna() & G.close_margin.notna()].copy()
    L = G.close_margin.values                  # internal: the home margin the market prices
    M = G.margin.values
    home_cover = _ind(M > L, M == L)
    home_win = np.where(M > 0, 1.0, np.where(M < 0, 0.0, np.nan))
    fav_home = L > 0
    fav_cover = np.where(fav_home, home_cover, np.where(np.isfinite(home_cover), 1 - home_cover, np.nan))
    fav_cover = np.where(L == 0, np.nan, fav_cover)
    has_t = G.total_close.notna().values & G.total_pts.notna().values
    T, TP = G.total_close.values, G.total_pts.values
    over = np.where(has_t, _ind(TP > T, TP == T), np.nan)
    hp, ap = G.home_points.values.astype(float), G.away_points.values.astype(float)
    fav_pts = np.where(fav_home, hp, ap)
    dog_pts = np.where(fav_home, ap, hp)
    fav_tt = (T + np.abs(L)) / 2.0
    dog_tt = (T - np.abs(L)) / 2.0
    fav_tt_over = np.where(has_t, _ind(fav_pts > fav_tt, fav_pts == fav_tt), np.nan)
    dog_tt_under = np.where(has_t, _ind(dog_pts < dog_tt, dog_pts == dog_tt), np.nan)
    dog_tt_over = np.where(np.isfinite(dog_tt_under), 1 - dog_tt_under, np.nan)
    dog_cover = np.where(np.isfinite(fav_cover), 1 - fav_cover, np.nan)
    alt3 = _ind(M > L + 3, M == L + 3)
    alt7 = _ind(M > L + 7, M == L + 7)
    altm3 = _ind(M > L - 3, M == L - 3)
    pairs = {
        'favorite_spread__game_over': (fav_cover, over, 'the favourite covers and the game goes over'),
        'underdog_spread__game_under': (dog_cover, np.where(np.isfinite(over), 1 - over, np.nan), 'the underdog covers and the game goes under'),
        'home_spread__game_over': (home_cover, over, 'home covers and the game goes over'),
        'spread__moneyline_same_team': (home_cover, home_win, 'a team covers and wins outright (same team)'),
        'spread__alternate_spread_3pts_worse': (home_cover, alt3, 'a team covers the line and covers 3 points worse (same team)'),
        'spread__alternate_spread_7pts_worse': (home_cover, alt7, 'a team covers the line and covers 7 points worse'),
        'spread__alternate_spread_3pts_better': (home_cover, altm3, 'a team covers the line and covers 3 points better'),
        'favorite_spread__underdog_team_total_under': (fav_cover, dog_tt_under, 'SYNTHETIC team-total line (total - spread)/2'),
        'favorite_spread__favorite_team_total_over': (fav_cover, fav_tt_over, 'SYNTHETIC team-total line (total + spread)/2'),
        'underdog_spread__underdog_team_total_over': (dog_cover, dog_tt_over, 'SYNTHETIC team-total line'),
    }
    out = {}
    for k, (x, y, note) in pairs.items():
        v, n = _phi(x, y)
        out[k] = {'phi': r(v), 'ci95': rl(_phi_ci(x, y, B=B)), 'n': n, 'note': note}
    by_line = {}
    for lo, hi in ((0, 3), (3, 7), (7, 14), (14, 99)):
        m = (np.abs(L) >= lo) & (np.abs(L) < hi) & (L != 0)
        row = {}
        for k in ('favorite_spread__game_over', 'spread__moneyline_same_team', 'favorite_spread__underdog_team_total_under'):
            x, y, _ = pairs[k]
            v, n = _phi(x[m], y[m])
            row[k] = {'phi': r(v), 'ci95': rl(_phi_ci(x[m], y[m], B=1000)), 'n': n}
        by_line['%s-%s' % (lo, hi)] = row
    return {'pairs': out, 'by_abs_line': by_line, 'n_games': int(len(G)),
            'seasons': sorted(int(s) for s in G.season.unique()),
            'lines': 'consensus close (spread and total); team-total lines are SYNTHETIC: the archive has none',
            'not_estimable': ['team-total lines and prices (none in the archive; the synthetic split of the game total is shown)',
                              'alternate-line and same-game-parlay PRICES (outcome correlation only; books price SGPs with their own correlation)',
                              'player props and live (in-game) markets',
                              'moneyline PRICES at decision time (the archive has closing moneylines only; the outcome correlation needs none)',
                              'correlation of CLV across books (one opener per game in most DEV seasons)']}


def cross_game_icc(df, B=2000, seed=None):
    """Intraclass correlation of model-side ATS results (1/0, pushes dropped) within a (season, week) slate
    and within a (season, week, conference) cluster, one-way ANOVA estimator; group bootstrap CI."""
    d = df[df.ats_win.notna()].copy()
    res = {}
    conf = np.where(d.home_conference.values == d.away_conference.values, d.home_conference.values, 'NONCONF')
    d['_conf'] = conf
    for name, keys in (('week', ['season', 'week']), ('conference_week', ['season', 'week', '_conf'])):
        grp = d.groupby(keys, sort=True).ats_win.apply(lambda s: s.values.astype(float))
        groups = [g for g in grp.values if len(g) >= 2]
        est = _icc(groups)
        rng = np.random.default_rng(C.SEED if seed is None else seed)
        bs = []
        for _ in range(B):
            j = rng.integers(0, len(groups), len(groups))
            v = _icc([groups[i] for i in j])
            if v is not None:
                bs.append(v)
        res[name] = {'icc': r(est, 5), 'ci95': rl([np.quantile(bs, 0.025), np.quantile(bs, 0.975)], 5),
                     'groups': len(groups), 'rows': int(sum(len(g) for g in groups))}
    return res


def _icc(groups):
    k = np.array([len(g) for g in groups], float)
    if len(groups) < 3:
        return None
    N, a = k.sum(), len(groups)
    means = np.array([g.mean() for g in groups])
    grand = np.concatenate(groups).mean()
    ssb = float(np.sum(k * (means - grand) ** 2))
    ssw = float(sum(np.sum((g - g.mean()) ** 2) for g in groups))
    msb, msw = ssb / (a - 1), ssw / (N - a)
    k0 = (N - np.sum(k ** 2) / N) / (a - 1)
    den = msb + (k0 - 1) * msw
    return float((msb - msw) / den) if den > 0 else None


# ---------------------------------------------------------- simulations
def week_blocks(sel, universe, unit_col='units', stake_col=None):
    """Per (season, week) of the UNIVERSE, the selected bets' units in kickoff order (empty weeks included)."""
    weeks = universe[['season', 'week']].drop_duplicates().sort_values(['season', 'week']).itertuples(index=False)
    s = sel.sort_values('kickoff_ts', kind='mergesort')
    by = {k: g for k, g in s.groupby(['season', 'week'], sort=False)}
    blocks = []
    for w in weeks:
        g = by.get((w.season, w.week))
        if g is None:
            blocks.append(np.zeros(0))
        else:
            u = g[unit_col].astype(float).values
            if stake_col:
                u = u * g[stake_col].astype(float).values
            blocks.append(u[np.isfinite(u)])
    return blocks


def _block_stats(blocks):
    T = np.array([b.sum() for b in blocks], float)
    Mx = np.array([max(0.0, np.cumsum(b).max()) if len(b) else 0.0 for b in blocks])
    Mn = np.array([min(0.0, np.cumsum(b).min()) if len(b) else 0.0 for b in blocks])
    D = np.array([core.max_drawdown(b) if len(b) else 0.0 for b in blocks])
    return T, Mx, Mn, D


def season_bootstrap(blocks, n_weeks=15, sims=20000, seed=None, slate_cap=None):
    """Seasons of n_weeks resampled (with replacement) from observed week blocks. With a slate cap the
    week's stakes are scaled down to the cap (decision.js applyExposure). Exact season drawdowns."""
    if slate_cap is not None:
        blocks = [b * (slate_cap / len(b)) if len(b) > slate_cap else b for b in blocks]
    T, Mx, Mn, D = _block_stats(blocks)
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    idx = rng.integers(0, len(blocks), size=(sims, n_weeks))
    c = np.zeros(sims)
    peak = np.zeros(sims)
    mdd = np.zeros(sims)
    worst = np.full(sims, np.inf)
    for w in range(n_weeks):
        j = idx[:, w]
        mdd = np.maximum(mdd, np.maximum(D[j], peak - (c + Mn[j])))
        peak = np.maximum(peak, c + Mx[j])
        c = c + T[j]
        worst = np.minimum(worst, T[j])
    q = lambda v, p: r(np.quantile(v, p), 2)
    return {'sims': sims, 'weeks_per_season': n_weeks, 'blocks': len(blocks),
            'bets_per_season_mean': r(np.mean([len(b) for b in blocks]) * n_weeks, 1),
            'season_units_mean': r(c.mean(), 2), 'season_units_sd': r(c.std(), 2),
            'season_units_p05': q(c, 0.05), 'season_units_p50': q(c, 0.5), 'season_units_p95': q(c, 0.95),
            'max_drawdown_p50': q(mdd, 0.5), 'max_drawdown_p95': q(mdd, 0.95), 'max_drawdown_p99': q(mdd, 0.99),
            'worst_week_p05': q(worst, 0.05), 'worst_week_min': r(worst.min(), 2), 'slate_cap': slate_cap}


def risk_of_ruin(wins, losses, push_p, week_counts, rho, bankrolls=(25, 50, 100), seasons=3, n_weeks=15,
                 paths=20000, seed=None, slate_cap=None, ruin_fraction=0.5):
    """P(the bankroll falls by ruin_fraction within `seasons`) for flat 1u bets. The cover probability (no push)
    is drawn per path from Beta(1 + wins, 1 + losses) (the posterior predictive) and also fixed at the
    posterior's 2.5 / 50 / 97.5 percentiles. Weekly bet counts are resampled from the observed weeks;
    outcomes within a week share a Gaussian copula with correlation rho. Monte Carlo SE reported."""
    rng = np.random.default_rng(C.SEED if seed is None else seed)
    a, b = 1.0 + wins, 1.0 + losses
    qs = {'p025': float(stats.beta.ppf(0.025, a, b)), 'p50': float(stats.beta.ppf(0.5, a, b)),
          'p975': float(stats.beta.ppf(0.975, a, b))}
    counts = np.asarray(week_counts, int)
    K = int(max(1, counts.max()))
    W = seasons * n_weeks
    out = {'posterior_cover_quantiles': {k: r(v) for k, v in qs.items()}, 'rho': r(rho, 4), 'paths': paths,
           'seasons': seasons, 'ruin': 'a loss of %d%% of the starting bankroll at any bet' % int(100 * ruin_fraction),
           'push_prob': r(push_p), 'bets_per_season_mean': r(counts.mean() * n_weeks, 1), 'slate_cap': slate_cap, 'by_bankroll': {}}
    scen = {'posterior_predictive': None, **qs}
    sq = math.sqrt(max(0.0, rho))
    sr = math.sqrt(max(0.0, 1 - rho))
    res = {br: {} for br in bankrolls}
    for name, pfix in scen.items():
        p = rng.beta(a, b, size=paths) if pfix is None else np.full(paths, pfix)
        c = np.zeros(paths)
        low = np.zeros(paths)
        for w in range(W):
            k = counts[rng.integers(0, len(counts), size=paths)]
            z = sq * rng.standard_normal(paths)[:, None] + sr * rng.standard_normal((paths, K))
            push = rng.random((paths, K)) < push_p
            win = stats.norm.cdf(z) < p[:, None]
            u = np.where(push, 0.0, np.where(win, B110, -1.0))
            active = np.arange(K)[None, :] < k[:, None]
            scale = np.ones(paths) if slate_cap is None else np.where(k > slate_cap, slate_cap / np.maximum(k, 1), 1.0)
            u = np.where(active, u, 0.0) * scale[:, None]
            pref = c[:, None] + np.cumsum(u, axis=1)
            low = np.minimum(low, pref.min(axis=1))
            c = pref[:, -1]
        for br in bankrolls:
            pr = float(np.mean(low <= -ruin_fraction * br))
            res[br][name] = {'ror': r(pr, 5), 'mc_se': r(math.sqrt(max(pr * (1 - pr), 1e-12) / paths), 5)}
        if name == 'posterior_predictive':
            out['mean_units_after_%d_seasons' % seasons] = r(c.mean(), 2)
    out['by_bankroll'] = {str(k): v for k, v in res.items()}
    return out


def kelly_compare(df, p_col='p_dec', price=-110, fractions=(0.10, 0.25), caps=(0.5, 1.0, 1.5), p_sat=0.55,
                  bankroll=100.0, B=2000):
    """Flat 1u vs fractional Kelly on the SAME bets. The Kelly input is the decision probability capped at the
    saturation probability; the stake is frac * f*(p) * bankroll, hard-capped; no compounding (a fixed bankroll
    base, so the comparison is of sizing, not of growth)."""
    d = df.sort_values('kickoff_ts', kind='mergesort')
    b = core.american_to_payout(price)
    p = np.minimum(d[p_col].astype(float).values, p_sat)
    fstar = np.maximum(0.0, (b * p - (1 - p)) / b)
    u = d.units.astype(float).values
    g = d.game_id.values
    rows = [{'method': 'flat_1u', 'stake_mean': 1.0}]
    stakes = {'flat_1u': np.ones(len(d))}
    for fr in fractions:
        for cap in caps:
            k = 'kelly_%.2f_cap_%.1f' % (fr, cap)
            stakes[k] = np.minimum(cap, fr * fstar * bankroll)
            rows.append({'method': k, 'stake_mean': None})
    out = []
    for row in rows:
        s = stakes[row['method']]
        su = s * u
        ok = np.isfinite(su)
        staked = float(s[ok].sum())
        o = {'method': row['method'], 'bets': int(ok.sum()), 'bets_with_stake': int((s[ok] > 0).sum()),
             'stake_mean': r(s[ok].mean(), 3), 'stake_max': r(s[ok].max(), 3) if ok.any() else None,
             'units': r(su[ok].sum(), 2), 'roi_per_unit_staked': r(su[ok].sum() / staked, 4) if staked > 0 else None,
             'units_per_bet_ci': rl(cluster_boot(su, g, B=B), 4),
             'max_drawdown': r(core.max_drawdown(su[ok]), 2), 'max_drawdown_ci': rl(core.boot_drawdown_ci(su[ok], B=1000), 2)}
        out.append(o)
    return {'p_saturation': p_sat, 'bankroll_base_u': bankroll, 'price': price, 'rows': out,
            'note': 'Kelly sizes by the decision probability; when that probability barely clears break-even the Kelly '
                    'stake is a small fraction of a unit, so Kelly can only shrink a flat record, not rescue it'}


def choose_slate_cap(blocks, wins, losses, push_p, rho, caps=(3, 5, 8, 10, 15), dd_max=25.0, ror_max=0.01, bankroll=100):
    """The pre-registered rule: the largest cap whose simulated 95th percentile season drawdown <= dd_max and
    whose risk of ruin (50% of `bankroll` within 3 seasons, at the posterior's 2.5th percentile) <= ror_max."""
    counts = np.array([len(b) for b in blocks], int)
    table = []
    for cap in caps:
        sb = season_bootstrap(blocks, sims=10000, slate_cap=cap)
        rr = risk_of_ruin(wins, losses, push_p, counts, rho, bankrolls=(bankroll,), paths=10000, slate_cap=cap)
        ror = rr['by_bankroll'][str(bankroll)]['p025']['ror']
        ok = sb['max_drawdown_p95'] <= dd_max and ror <= ror_max
        table.append({'cap': cap, 'max_drawdown_p95': sb['max_drawdown_p95'], 'ror_p025': ror, 'passes': bool(ok)})
    passing = [t['cap'] for t in table if t['passes']]
    return {'choice': max(passing) if passing else min(caps), 'table': table, 'rule': 'largest cap with p95 season drawdown <= %g u '
            'and risk of ruin (50%% of %du in 3 seasons, 2.5th pct cover) <= %g; the smallest cap if none passes' % (dd_max, bankroll, ror_max)}
