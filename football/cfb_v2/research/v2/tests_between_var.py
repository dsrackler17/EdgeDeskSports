"""Between-team variance tests (audit finding F-21): no rating is pinned to its prior.

    python3 -m v2.tests_between_var

Before the fix, stage 3 (v2/build_ratings.py) floored the burn-in between-team
variance at 1e-8 whenever the method-of-moments estimate was <= 0, so the prior
variance of expl_pass, fg_value, st_net, to_rate (both sides) and sack_rate's
defence was 1.5e-9 x scale and those ratings never moved in-season. Rule
cfb_v2_between_var_v2 (docs/cfb-audit/PATCH_v2.1.2.md section 1) keeps a positive
moment, else uses the split-half covariance, else refuses. The legacy rule stays
the default for the versions built with it (v2.1.0, v2.1.1).

Synthetic checks run anywhere (and in the production `tests_weekly --fast`).
Real-data checks run on the build at $CFB_V2_OUT and are skipped without one:
  * the stored stage 3 is reproduced exactly, for one freeze, under the rule the
    build was stamped with (the legacy default for an unstamped build);
  * a legacy build pins exactly the nine known metric-sides; a v2 build pins none.
"""
import json
import os
import shutil
import sys
import tempfile
import traceback

import numpy as np
import pandas as pd

from . import build_ratings as BR
from . import common
from . import config as C

RESULTS = []
ENV = 'CFB_V2_BETWEEN_VAR_RULE'
PINNED_LEGACY = {'expl_pass/off', 'expl_pass/def', 'fg_value/off', 'fg_value/def', 'st_net/off', 'st_net/def',
                 'to_rate/off', 'to_rate/def', 'sack_rate/def'}


def test(fn):
    RESULTS.append(fn)
    return fn


class _env:
    """Set (or unset, value None) $CFB_V2_BETWEEN_VAR_RULE and C.MODEL_VERSION for a block."""

    def __init__(self, rule, version=None):
        self.rule, self.version = rule, version

    def __enter__(self):
        self.old = os.environ.get(ENV), C.MODEL_VERSION
        if self.rule is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = self.rule
        if self.version:
            C.MODEL_VERSION = self.version

    def __exit__(self, *a):
        if self.old[0] is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = self.old[0]
        C.MODEL_VERSION = self.old[1]


# ------------------------------------------------------------------ synthetic
@test
def default_rule_is_legacy_for_the_released_versions():
    for v in ('edgedesk_cfb_v2.1.0', 'edgedesk_cfb_v2.1.1'):
        assert BR.artifact_between_var_rule(v) == BR.LEGACY_BETWEEN_VAR_RULE, v
        with _env(None, v):
            assert BR.between_var_rule() == BR.LEGACY_BETWEEN_VAR_RULE, v
    with _env(None, C.PRODUCTION_MODEL_VERSION):
        assert BR.between_var_rule() == BR.artifact_between_var_rule(C.PRODUCTION_MODEL_VERSION)
    with _env(None, 'edgedesk_cfb_vX.not_released'):
        assert BR.between_var_rule() == BR.LEGACY_BETWEEN_VAR_RULE


@test
def the_environment_selects_the_rule_and_refuses_an_unknown_one():
    with _env(BR.F21_BETWEEN_VAR_RULE, 'edgedesk_cfb_v2.1.0'):
        assert BR.between_var_rule() == BR.F21_BETWEEN_VAR_RULE
    with _env('cfb_v2_between_var_bogus'):
        try:
            BR.between_var_rule()
        except ValueError:
            pass
        else:
            raise AssertionError('an unknown rule was accepted')


@test
def v2_keeps_a_positive_moment_and_falls_back_only_when_it_is_not_positive():
    old = BR.split_half_between
    try:
        BR.split_half_between = lambda *a, **k: [{'season': s, 'n_fbs': 100, 'cov_off': c, 'se_off': 0.1,
                                                  'cov_def': c, 'se_def': 0.1} for s, c in ((1, 0.5), (2, 0.7))]
        a = np.array([[2.0, 1.0, 1.0, 1.5], [2.5, 1.2, 1.0, 1.6]])       # moment: off +1.25, def -0.45
        tv, d = BR._between_var_v2('m', None, a, [1, 2], None, None, None, None)
        assert tv[0] == np.mean(a[:, 0] - a[:, 2]) == max(1e-8, np.mean(a[:, 0] - a[:, 2]))   # the legacy value, exactly
        assert d['off']['source'] == 'moment'
        assert abs(tv[1] - 0.6) < 1e-12 and d['def']['source'] == 'split_half'
        BR.split_half_between = lambda *a, **k: [{'season': 1, 'n_fbs': 100, 'cov_off': -0.1, 'se_off': 0.1,
                                                  'cov_def': -0.1, 'se_def': 0.1}]
        try:
            BR._between_var_v2('m', None, np.array([[1.0, 1.0, 2.0, 2.0]]), [1], None, None, None, None)
        except SystemExit:
            pass
        else:
            raise AssertionError('no measurable signal must refuse, never pin')
    finally:
        BR.split_half_between = old


def _league(seed, n_teams=120, weeks=12, p0=0.10, sd_o=0.02, sd_d=0.015, n_att=35):
    """One synthetic season of a binomial rate metric with known offence/defence spreads."""
    rng = np.random.default_rng(seed)
    o, d = rng.normal(0, sd_o, n_teams), rng.normal(0, sd_d, n_teams)
    rows, games = [], []
    gid = 0
    t0 = pd.Timestamp('2030-09-01T18:00Z')
    for w in range(1, weeks + 1):
        perm = rng.permutation(n_teams)
        for i in range(0, n_teams, 2):
            h, a = int(perm[i]), int(perm[i + 1])
            gid += 1
            ts = t0 + pd.Timedelta(days=7 * (w - 1))
            games.append({'game_id': gid, 'week': w})
            for t, u, H in ((h, a, 1.0), (a, h, -1.0)):
                n = n_att
                p = np.clip(p0 + o[t] + d[u], 0.01, 0.99)
                rows.append({'game_id': gid, 'team_id': t, 'opp_id': u, 'H': H, 'kickoff_ts': ts, 'g_season': 2030,
                             'num': float(rng.binomial(n, p)), 'den': float(n)})
    return pd.DataFrame(rows), pd.DataFrame(games), o, d


@test
def split_half_recovers_the_between_variance_when_the_noise_model_is_overstated():
    """The F-21 mechanism in miniature: with the per-play variance overstated 2.5x (as for
    expl_pass and sack_rate), the legacy moment is negative (the metric would be pinned);
    the split-half covariance still recovers the true between-team variance."""
    from . import ratings as R
    spec = ('num', 'den', 'rate')
    seasons, betw, sh_o, sh_d, tru_o, tru_d = [], [], [], [], [], []
    for k in range(3):
        TG, G, o, d = _league(20260927 + k)
        TG = TG.assign(g_season=2030 + k)
        s2p = 2.5 * 0.1 * 0.9                                       # overstated per-play noise
        y, n, ok = R.metric_obs(TG, *spec)
        big = float(np.var(y)) * 2.0
        teams = set(TG.team_id) | set(TG.opp_id)
        fit, _ = R.fit_metric(TG, 'm', spec, (s2p, 1e-6), BR.weak_prior(teams, big, big), want_var=True)
        betw.append((fit.off.var(), fit['def'].var(), fit.off_var.mean(), fit.def_var.mean()))
        sh = BR.split_half_between(TG, G, {2030 + k: teams}, 'm', spec, (s2p, 1e-6), [2030 + k])[0]
        sh_o.append(sh['cov_off']); sh_d.append(sh['cov_def'])
        tru_o.append(np.var(o, ddof=1)); tru_d.append(np.var(d, ddof=1))
        seasons.append(2030 + k)
    a = np.array(betw)
    assert np.mean(a[:, 0] - a[:, 2]) <= 0 and np.mean(a[:, 1] - a[:, 3]) <= 0, a     # the legacy rule would pin
    for est, tru in ((np.mean(sh_o), np.mean(tru_o)), (np.mean(sh_d), np.mean(tru_d))):
        assert est > 0 and 0.5 * tru < est < 1.3 * tru, (est, tru)                 # conservative, not zero


@test
def scoring_refuses_features_of_another_rule():
    tmp = tempfile.mkdtemp(prefix='cfb_bv_')
    old = C.OUT
    try:
        C.OUT = tmp
        from . import games as GM
        s2 = common.stamp_build('stage2', finality_rule=GM.FINALITY_RULE)
        common.stamp_build('stage5', feature_version='fvX', stage2=s2)            # predates the field: legacy
        common.require_build('fvX', 't', between_var_rule=BR.LEGACY_BETWEEN_VAR_RULE)
        try:
            common.require_build('fvX', 't', between_var_rule=BR.F21_BETWEEN_VAR_RULE)
        except common.StaleBuild:
            pass
        else:
            raise AssertionError('a v2 artifact was scored on legacy features')
        common.stamp_build('stage5', feature_version='fvX', stage2=s2, between_var_rule=BR.F21_BETWEEN_VAR_RULE)
        common.require_build('fvX', 't', between_var_rule=BR.F21_BETWEEN_VAR_RULE)
        try:
            common.require_build('fvX', 't', between_var_rule=BR.LEGACY_BETWEEN_VAR_RULE)
        except common.StaleBuild:
            pass
        else:
            raise AssertionError('a legacy artifact was scored on v2 features')
        common.require_build('fvX', 't')                                           # no rule asked: unchanged behaviour
    finally:
        C.OUT = old
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ real data
def _build_rule():
    b = common.build_stamp()
    if b is None or not os.path.exists(common.out_path('stage3', 'ratings_%d.parquet' % C.LIVE_SEASON)):
        return None
    return ((b.get('stages') or {}).get('stage3') or {}).get('between_var_rule', BR.LEGACY_BETWEEN_VAR_RULE)


@test
def real_stored_freeze_is_reproduced_under_its_own_rule():
    rule = _build_rule()
    if rule is None:
        return 'skipped (no stage-3 build at CFB_V2_OUT)'
    S = C.LIVE_SEASON
    stored = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S))
    T = sorted(stored.prediction_ts.unique())[-1]
    with _env(None if rule == BR.LEGACY_BETWEEN_VAR_RULE else rule):
        fr = BR.run(seasons_out=[S], only_ts=[T], write=False, return_frames=True, verbose=False)
    key = ['prediction_ts', 'metric', 'team_id']
    a = stored[stored.prediction_ts.eq(T)].sort_values(key).reset_index(drop=True)
    b = fr['ratings'][S].sort_values(key).reset_index(drop=True)[a.columns]
    for c in a.columns:
        assert ((a[c] == b[c]) | (a[c].isna() & b[c].isna())).all(), c
    return '%s, freeze %s: %d rows identical' % (rule, T, len(a))


@test
def real_no_rating_is_pinned_under_v2_and_legacy_pins_exactly_the_known_sides():
    rule = _build_rule()
    if rule is None:
        return 'skipped (no stage-3 build at CFB_V2_OUT)'
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    found = {}
    for S in range(2015, C.LIVE_SEASON + 1):
        g = G[G.season.eq(S)]
        fbs = set(g[g.home_fbs].home_id) | set(g[g.away_fbs].away_id)
        R = pd.read_parquet(common.out_path('stage3', 'ratings_%d.parquet' % S),
                            columns=['team_id', 'metric', 'prediction_ts', 'off', 'def', 'prior_off', 'prior_def',
                                     'off_var', 'def_var'])
        R = R[R.prediction_ts.eq(R.prediction_ts.max()) & R.team_id.isin(fbs)]
        pinned = set()
        for m, x in R.groupby('metric'):
            for side in ('off', 'def'):
                # posterior variance within 2x the legacy floor (1.5e-9 x the largest scale, 8) for most teams
                if (x[side + '_var'] <= 2.4e-8).mean() > 0.5:
                    pinned.add('%s/%s' % (m, side))
        found[S] = pinned
    if rule == BR.LEGACY_BETWEEN_VAR_RULE:
        assert all(v == PINNED_LEGACY for v in found.values()), found
        return 'legacy build: the nine known sides are pinned in every season 2015-%d (F-21, documented)' % C.LIVE_SEASON
    assert all(not v for v in found.values()), found
    return '%s build: no FBS rating is pinned in any season 2015-%d' % (rule, C.LIVE_SEASON)


def main():
    fail = 0
    for fn in RESULTS:
        try:
            r = fn()
            print('ok   ' + fn.__name__ + ('  [%s]' % r if isinstance(r, str) else ''))
        except Exception:
            fail += 1
            print('FAIL ' + fn.__name__)
            traceback.print_exc()
    print('%d/%d passed' % (len(RESULTS) - fail, len(RESULTS)))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
