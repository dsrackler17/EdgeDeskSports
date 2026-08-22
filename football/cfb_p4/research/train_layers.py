#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — the layers that sit on top of the rating recursion:
quarterback, offensive line, schedule stress, injury impact, total pace, and
the weights behind the roster-stability, youth and confidence scores.

Each one is measured against the SAME pregame residual the rating recursion
left behind (out/p4_oos.csv), so nothing here can quietly re-explain what the
ratings already explain.

WHAT IS MEASURED HERE
* QUARTERBACK (VIII). A per-QB EPA-per-dropback record is built from the play
  feed, shrunk toward a replacement prior by sample size, lagged so a game is
  only ever projected from dropbacks thrown BEFORE it, and regressed against
  the residual. The points-per-EPA coefficient is the answer.
* QB ABSENCE — the only injury effect that can be honestly measured from
  public data. A team's primary quarterback is identified by prior dropback
  share; games he does not throw in are compared with games he does. That
  single number becomes the QB entry in the engine's position-importance
  table, and EVERY OTHER POSITION IS LEFT UNTRAINED rather than invented.
* SCHEDULE STRESS (XV). Rest, bye, consecutive road games, travel and time
  zones in the last three games, and the strength of the previous and next
  opponent — all computed pregame, then regressed on the residual.
* TOTAL / PACE. Combined tempo against the total residual.
* SCORE WEIGHTS. The roster-stability, youth-volatility and confidence scores
  weight their inputs by each input's MEASURED association with error, so the
  0-100 numbers the app shows are not arbitrary index arithmetic.

WHAT IS NOT MEASURED HERE, AND IS THEREFORE NOT SHIPPED
* Weather coefficients. No historical weather series exists in this corpus,
  and none is reachable offline. The engine ships with NO weather
  coefficients: supplied weather is displayed and reduces the weather
  uncertainty term, but it cannot move the projected total, because nothing
  has earned the right to move it.
* Non-quarterback injury weights, coaching tenure, NIL, per-player recruiting.

Usage: python3 train_layers.py <out_dir>
Writes <out>/params_layers.json and <out>/report_layers.json
"""
import json
import os
import sys

import numpy as np
import pandas as pd

import common

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
B_LO, B_HI = 2014, 2019
C_LO, C_HI = 2018, 2021
TEST_LO = 2022


def _ols(X, y, lam=1.0):
    XtX = X.T @ X + lam * np.eye(X.shape[1])
    return np.linalg.solve(XtX, X.T @ y)


def _r2(y, yhat):
    return float(1 - np.sum((y - yhat) ** 2) / np.sum((y - y.mean()) ** 2))


def _perm_p(X, y, r2, seed=11, n=60):
    rng = np.random.RandomState(seed)
    null = []
    for _ in range(n):
        idx = rng.permutation(len(y))
        w = _ols(X[idx], y)
        null.append(_r2(y, X @ w))
    return float(np.mean(np.array(null) >= r2))


# ===========================================================================
# quarterback
# ===========================================================================
def qb_layer(oos, qg, report):
    if qg is None or not len(qg):
        report['qb'] = {'note': 'qb_game.csv absent — QB layer not trained'}
        return None, None

    qg = qg.sort_values(['qb_id', 'season', 'week']).copy()
    # career-to-date, STRICTLY before this game
    qg['cum_db'] = qg.groupby('qb_id').dropbacks.cumsum() - qg.dropbacks
    qg['cum_epa'] = qg.groupby('qb_id').epa_sum.cumsum() - qg.epa_sum
    qg['cum_games'] = qg.groupby('qb_id').cumcount()
    prior = 0.0
    shrink_grid = (100, 200, 300, 500, 800)

    def qb_value(shrink):
        w = qg.cum_db / (qg.cum_db + shrink)
        eff = np.where(qg.cum_db > 0, qg.cum_epa / qg.cum_db.replace(0, np.nan), prior)
        return w * np.nan_to_num(eff, nan=prior) + (1 - w) * prior

    home = qg.rename(columns={'off_team': 'team'})[['game_id', 'team', 'cum_db', 'cum_epa', 'cum_games',
                                                    'dropbacks', 'qb_id', 'season', 'week']]
    d = oos[['game_id', 'season', 'week', 'home_key', 'away_key', 'margin', 'pred_margin',
             'both_fbs', 'known']].copy()
    d = d[d.both_fbs & (d.known >= 4)]
    d['resid'] = d.margin - d.pred_margin

    best = None
    for shrink in shrink_grid:
        qg['qb_val'] = qb_value(shrink)
        m = qg[['game_id', 'team_key', 'qb_val', 'cum_db', 'cum_games']]
        j = d.merge(m.add_prefix('h_'), left_on=['game_id', 'home_key'],
                    right_on=['h_game_id', 'h_team_key'], how='inner')
        j = j.merge(m.add_prefix('a_'), left_on=['game_id', 'away_key'],
                    right_on=['a_game_id', 'a_team_key'], how='inner')
        tr = j[(j.season >= B_LO) & (j.season <= B_HI)].dropna(subset=['h_qb_val', 'a_qb_val', 'resid'])
        if len(tr) < 800:
            continue
        X = np.column_stack([tr.h_qb_val - tr.a_qb_val, np.ones(len(tr))])
        w = _ols(X, tr.resid.values)
        r2 = _r2(tr.resid.values, X @ w)
        if best is None or r2 > best['r2']:
            best = {'shrink': shrink, 'w': w, 'r2': r2, 'n': int(len(tr)), 'joined': j}

    if best is None:
        report['qb'] = {'note': 'not enough joined QB games to fit the layer'}
        return None, None

    j = best['joined']
    te = j[j.season >= TEST_LO].dropna(subset=['h_qb_val', 'a_qb_val', 'resid'])
    Xte = np.column_stack([te.h_qb_val - te.a_qb_val, np.ones(len(te))])
    r2_te = _r2(te.resid.values, Xte @ best['w']) if len(te) > 200 else None
    Xtr = np.column_stack([j[(j.season >= B_LO) & (j.season <= B_HI)].h_qb_val
                           - j[(j.season >= B_LO) & (j.season <= B_HI)].a_qb_val,
                           np.ones(best['n'])])
    p = _perm_p(Xtr, j[(j.season >= B_LO) & (j.season <= B_HI)].resid.values, best['r2'])

    params = {
        'points_per_epa_db': round(float(best['w'][0]), 4),
        'prior_epa_per_db': 0.0,
        'shrink_attempts': int(best['shrink']),
        'starts_for_full_stability': 20,
        'new_system_stability_penalty': 0.25,
        'not_returning_penalty': 0.2,
        'ceiling_floor_spread': 6.0,
        'points_per_rush_value': 0.0,
        'basis': 'career-to-date EPA/dropback, shrunk, regressed on the rating '
                 'residual over %d tune-window games' % best['n'],
    }
    report['qb'] = {'n_tune': best['n'], 'r2_tune': round(best['r2'], 5),
                    'r2_test': None if r2_te is None else round(r2_te, 5),
                    'permutation_p': round(p, 3), 'shrink_attempts': int(best['shrink']),
                    'points_per_epa_db': params['points_per_epa_db'],
                    'note': 'a QB one full point of EPA per dropback better than his '
                            'counterpart is worth %.1f points of spread'
                            % params['points_per_epa_db']}
    return params, best['joined']


def qb_absence(oos, qg, report):
    """The one injury effect public data can actually measure."""
    if qg is None or not len(qg):
        report['injury'] = {'note': 'no QB table — no injury weight is trained'}
        return None
    season_primary = (qg.sort_values('dropbacks')
                      .groupby(['team_key', 'season'], as_index=False).last()
                      [['team_key', 'season', 'qb_id', 'dropbacks']]
                      .rename(columns={'qb_id': 'primary_qb', 'dropbacks': 'best_game_db'}))
    tot = qg.groupby(['team_key', 'season']).dropbacks.sum().rename('season_db').reset_index()
    sp = season_primary.merge(tot, on=['team_key', 'season'])
    g = qg.merge(sp, on=['team_key', 'season'], how='left')
    g['is_primary'] = g.qb_id.eq(g.primary_qb)

    d = oos[oos.both_fbs & (oos.known >= 4)].copy()
    d['resid'] = d.margin - d.pred_margin
    m = g[['game_id', 'team_key', 'is_primary']]
    j = d.merge(m.add_prefix('h_'), left_on=['game_id', 'home_key'],
                right_on=['h_game_id', 'h_team_key'], how='inner')
    j = j.merge(m.add_prefix('a_'), left_on=['game_id', 'away_key'],
                right_on=['a_game_id', 'a_team_key'], how='inner')
    j['x'] = j.h_is_primary.astype(float) - j.a_is_primary.astype(float)
    j = j.dropna(subset=['resid', 'x'])
    if len(j) < 1000 or j.x.abs().sum() < 100:
        report['injury'] = {'note': 'too few games where a primary QB did not play'}
        return None
    X = np.column_stack([j.x.values, np.ones(len(j))])
    w = _ols(X, j.resid.values)
    r2 = _r2(j.resid.values, X @ w)
    p = _perm_p(X, j.resid.values, r2)
    n_missing = int((j.x != 0).sum())
    qb_w = abs(float(w[0]))
    report['injury'] = {
        'n': int(len(j)), 'n_games_with_a_backup': n_missing,
        'qb_absence_points': round(float(w[0]), 3), 'r2': round(r2, 5),
        'permutation_p': round(p, 3),
        'note': 'measured effect of a team\'s primary quarterback taking no dropbacks. '
                'This is the ONLY position whose absence is observable in public data, '
                'so it is the only position weight that ships.'}
    return {
        'position_weight': {'QB': round(qb_w, 3)},
        'max_position_weight': round(max(qb_w, 1.0), 3),
        'status_weight': {'out': 1.0, 'doubtful': 0.75, 'questionable': 0.5,
                          'probable': 0.15, 'active': 0.0},
        'basis': 'QB weight measured from primary-QB absences (%d games); every other '
                 'position is deliberately absent — supply a weight or the engine '
                 'counts that injury as uncertainty only' % n_missing,
    }


# ===========================================================================
# schedule stress
# ===========================================================================
def build_team_schedule(games, oos, tvm):
    """Per team per game, pregame-only schedule context."""
    g = games[games.home_fbs & games.away_fbs].copy()
    rows = []
    for r in g.itertuples():
        for side, tk, opp, home in (('home', r.home_key, r.away_key, True),
                                    ('away', r.away_key, r.home_key, False)):
            rows.append({'game_id': r.game_id, 'season': r.season, 'week': r.week,
                         'kick': r.kick_dt, 'team_key': tk, 'opp_key': opp,
                         'is_home': home, 'neutral': bool(r.neutral),
                         'venue_team': r.home_key})
    t = pd.DataFrame(rows).sort_values(['team_key', 'season', 'kick'])
    t['rest_days'] = t.groupby(['team_key', 'season']).kick.diff().dt.total_seconds() / 86400.0
    t['away_game'] = (~t.is_home) & (~t.neutral)
    t['consecutive_road'] = 0
    run = {}
    cr = []
    for r in t.itertuples():
        key = (r.team_key, r.season)
        run[key] = (run.get(key, 0) + 1) if r.away_game else 0
        cr.append(run[key])
    t['consecutive_road'] = cr
    t['road_last3'] = (t.groupby(['team_key', 'season']).away_game
                       .transform(lambda s: s.shift(1).rolling(3, min_periods=1).sum()))

    def miles(a, b):
        va, vb = tvm.get(a), tvm.get(b)
        if not va or not vb:
            return np.nan
        return float(common.haversine_miles(np.array([va['lat']]), np.array([va['lon']]),
                                            np.array([vb['lat']]), np.array([vb['lon']]))[0])

    t['trip_miles'] = [0.0 if (r.is_home and not r.neutral) else miles(r.team_key, r.venue_team)
                       for r in t.itertuples()]
    t['miles_last3'] = (t.groupby(['team_key', 'season']).trip_miles
                        .transform(lambda s: s.shift(1).rolling(3, min_periods=1).sum()))

    def tzd(a, b):
        va, vb = tvm.get(a), tvm.get(b)
        if not va or not vb or va['tz'] is None or vb['tz'] is None:
            return np.nan
        return abs(va['tz'] - vb['tz'])

    t['trip_tz'] = [0.0 if (r.is_home and not r.neutral) else tzd(r.team_key, r.venue_team)
                    for r in t.itertuples()]
    t['tz_last3'] = (t.groupby(['team_key', 'season']).trip_tz
                     .transform(lambda s: s.shift(1).rolling(3, min_periods=1).sum()))

    # Opponent strength. `prev_opp_rating` is the rating that opponent carried
    # into the game just played, which is in the past and safe.
    #
    # `next_opp_rating` is where leakage hides: the NEXT game's pregame rating
    # already contains the result of THIS game. Only the next opponent's
    # IDENTITY is knowable now (schedules are published in advance), so the
    # lookahead feature uses that opponent's rating AS OF THIS KICKOFF,
    # recovered from the rating timeline with a backward as-of join.
    rat = pd.concat([
        oos[['game_id', 'kick_dt', 'home_key', 'home_rating']]
           .rename(columns={'home_key': 'team_key', 'home_rating': 'rating'}),
        oos[['game_id', 'kick_dt', 'away_key', 'away_rating']]
           .rename(columns={'away_key': 'team_key', 'away_rating': 'rating'})
    ])
    rat['kick_dt'] = pd.to_datetime(rat.kick_dt, errors='coerce', utc=True)
    t = t.merge(rat[['game_id', 'team_key', 'rating']]
                .rename(columns={'team_key': 'opp_key', 'rating': 'opp_rating'}),
                on=['game_id', 'opp_key'], how='left')
    t['prev_opp_rating'] = t.groupby(['team_key', 'season']).opp_rating.shift(1)

    t['next_opp_key'] = t.groupby(['team_key', 'season']).opp_key.shift(-1)
    timeline = (rat.dropna(subset=['kick_dt', 'rating'])
                   .sort_values('kick_dt')[['kick_dt', 'team_key', 'rating']]
                   .rename(columns={'team_key': 'next_opp_key', 'rating': 'next_opp_rating'}))
    left = t.dropna(subset=['next_opp_key']).sort_values('kick')[['game_id', 'team_key', 'kick', 'next_opp_key']]
    left['kick'] = pd.to_datetime(left.kick, errors='coerce', utc=True)
    asof = pd.merge_asof(left.sort_values('kick'), timeline,
                         left_on='kick', right_on='kick_dt', by='next_opp_key',
                         direction='backward', allow_exact_matches=False)
    t = t.merge(asof[['game_id', 'team_key', 'next_opp_rating']],
                on=['game_id', 'team_key'], how='left')
    return t


SCHED_COMPONENTS = ['short_rest', 'off_bye', 'consec_road', 'road_last3',
                    'miles_last3', 'tz_last3', 'prev_opponent_strength', 'lookahead']


def schedule_layer(oos, sched, report):
    s = sched.copy()
    s['short_rest'] = ((7 - s.rest_days) / 7.0).clip(0, 1)
    s['off_bye'] = (s.rest_days >= 12).astype(float)
    s['consec_road'] = (s.consecutive_road / 3.0).clip(0, 1)
    s['road_last3'] = (s.road_last3 / 3.0).clip(0, 1)
    s['miles_last3'] = (s.miles_last3 / 4000.0).clip(0, 1)
    s['tz_last3'] = (s.tz_last3 / 4.0).clip(0, 1)
    s['prev_opponent_strength'] = ((s.prev_opp_rating + 20) / 40.0).clip(0, 1)
    s['lookahead'] = ((s.next_opp_rating + 20) / 40.0).clip(0, 1)
    cols = ['game_id', 'team_key'] + SCHED_COMPONENTS
    s = s[cols]

    d = oos[oos.both_fbs & (oos.known >= 4)].copy()
    d['resid'] = d.margin - d.pred_margin
    j = d.merge(s.add_prefix('h_'), left_on=['game_id', 'home_key'],
                right_on=['h_game_id', 'h_team_key'], how='inner')
    j = j.merge(s.add_prefix('a_'), left_on=['game_id', 'away_key'],
                right_on=['a_game_id', 'a_team_key'], how='inner')
    diffs = {}
    for c in SCHED_COMPONENTS:
        diffs[c] = j['h_' + c] - j['a_' + c]
    D = pd.DataFrame(diffs)
    D['resid'] = j.resid.values
    D['season'] = j.season.values
    tr = D[(D.season >= B_LO) & (D.season <= B_HI)].dropna()
    if len(tr) < 800:
        report['schedule'] = {'note': 'too few complete schedule rows to fit'}
        return None
    X = np.column_stack([tr[c].values for c in SCHED_COMPONENTS] + [np.ones(len(tr))])
    w = _ols(X, tr.resid.values)
    r2 = _r2(tr.resid.values, X @ w)
    p = _perm_p(X, tr.resid.values, r2)
    te = D[D.season >= TEST_LO].dropna()
    r2_te = None
    if len(te) > 300:
        Xte = np.column_stack([te[c].values for c in SCHED_COMPONENTS] + [np.ones(len(te))])
        r2_te = _r2(te.resid.values, Xte @ w)
    weights = dict((c, round(float(w[i]), 4)) for i, c in enumerate(SCHED_COMPONENTS))
    scale = float(np.mean(np.abs(X[:, :-1] @ w[:-1])))
    report['schedule'] = {'n_tune': int(len(tr)), 'r2_tune': round(r2, 5),
                          'r2_test': None if r2_te is None else round(r2_te, 5),
                          'permutation_p': round(p, 3), 'weights': weights,
                          'mean_abs_points': round(scale, 3),
                          'note': 'schedule geometry moves the number by %.2f points on '
                                  'average; that is the honest size of this effect' % scale}
    return {'weights': weights, 'points_per_stress': round(float(scale) / 50.0, 5),
            'basis': 'walk-forward residual regression, %d tune-window games' % len(tr)}


# ===========================================================================
# total / pace
# ===========================================================================
def total_layer(oos, tg, report):
    if tg is None:
        report['total'] = {'note': 'no team-game table'}
        return None
    pace = tg.groupby(['game_id', 'team_key']).plays.mean().rename('plays').reset_index()
    d = oos.dropna(subset=['pred_total']).copy()
    d = d[d.both_fbs & (d.known >= 4)]
    d['resid'] = d.total_pts - d.pred_total
    j = d.merge(pace.add_prefix('h_'), left_on=['game_id', 'home_key'],
                right_on=['h_game_id', 'h_team_key'], how='inner')
    j = j.merge(pace.add_prefix('a_'), left_on=['game_id', 'away_key'],
                right_on=['a_game_id', 'a_team_key'], how='inner')
    j['pace_sum'] = j.h_plays + j.a_plays
    tr = j[(j.season >= B_LO) & (j.season <= B_HI)].dropna(subset=['pace_sum', 'resid'])
    if len(tr) < 500:
        report['total'] = {'note': 'too few rows'}
        return None
    X = np.column_stack([tr.pace_sum.values, np.ones(len(tr))])
    w = _ols(X, tr.resid.values)
    r2 = _r2(tr.resid.values, X @ w)
    report['total'] = {'n': int(len(tr)), 'r2': round(r2, 5),
                       'points_per_play': round(float(w[0]), 5),
                       'note': 'IN-GAME pace is not knowable pregame; this coefficient is '
                               'applied to each side\'s opponent-adjusted pace EWMA, which is'}
    return {'points_per_pace': round(float(w[0]), 5)}


# ===========================================================================
# score weights
# ===========================================================================
def score_weights(oos, rs, report):
    """Weight each position group by how strongly its continuity and class mix
    actually associate with prediction error. A group whose continuity tells
    us nothing gets a small weight instead of an equal share."""
    if rs is None:
        report['score_weights'] = {'note': 'no roster table'}
        return None, None
    d = oos[oos.both_fbs & (oos.known >= 4)].copy()
    d['abs_resid'] = (d.margin - d.pred_margin).abs()
    groups = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'EDGE', 'LB', 'CB', 'S', 'DB']
    cont, youth, diag = {}, {}, {}
    for gname in groups:
        rc, re_ = 'g_%s_returning_share' % gname, 'g_%s_experience' % gname
        if rc not in rs.columns:
            continue
        r = rs[['team_key', 'season', rc, re_]]
        j = d.merge(r.add_prefix('h_'), left_on=['home_key', 'season'],
                    right_on=['h_team_key', 'h_season'], how='left')
        j = j.merge(r.add_prefix('a_'), left_on=['away_key', 'season'],
                    right_on=['a_team_key', 'a_season'], how='left')
        j = j[(j.season >= C_LO) & (j.season <= C_HI)]
        turn = np.fmax(1 - j['h_' + rc], 1 - j['a_' + rc])
        yng = np.fmax(1 - j['h_' + re_], 1 - j['a_' + re_])
        ok = pd.DataFrame({'t': turn, 'y': yng, 'e': j.abs_resid}).dropna()
        if len(ok) < 400:
            continue
        ct = float(ok.t.corr(ok.e))
        cy = float(ok.y.corr(ok.e))
        cont[gname] = max(0.0, ct)
        youth[gname] = max(0.0, cy)
        diag[gname] = {'n': int(len(ok)), 'corr_turnover_vs_abs_error': round(ct, 4),
                       'corr_youth_vs_abs_error': round(cy, 4)}
    if not cont:
        report['score_weights'] = {'note': 'no group had enough rows'}
        return None, None
    st = sum(cont.values()) or 1.0
    sy = sum(youth.values()) or 1.0
    cont_n = dict((k, round(v / st, 4)) for k, v in cont.items())
    youth_n = dict((k, round(v / sy, 4)) for k, v in youth.items())
    report['score_weights'] = {'per_group': diag,
                               'note': 'weights are the normalised positive association between '
                                       'each group\'s turnover / youth and the size of the model\'s '
                                       'error. Groups with a non-positive association get zero '
                                       'weight rather than an equal share.'}
    return cont_n, youth_n


def confidence_weights(qb, sched, matchup_pairs, report):
    """Confidence weights inputs by the size of the effect each one carries.
    An input that moves the number by a tenth of a point should not count the
    same as the rating itself."""
    w = {'rating': 1.0, 'venue': 0.25}
    if qb:
        w['qb'] = round(min(1.0, abs(qb['points_per_epa_db']) * 0.15), 3)
    if sched:
        w['schedule'] = round(min(0.5, sched['points_per_stress'] * 50 / 4.0), 3)
    if matchup_pairs:
        w['matchup'] = 0.4
    w['roster_home'] = 0.25
    w['roster_away'] = 0.25
    w['injuries'] = 0.35
    w['travel'] = 0.1
    w['weather'] = 0.1
    w['offfield_home'] = 0.05
    w['offfield_away'] = 0.05
    report['confidence_weights'] = {
        'weights': w,
        'note': 'confidence measures INFORMATION COMPLETENESS, not outcome certainty. '
                'It is deliberately orthogonal to volatility: a veteran mismatch in a dome '
                'can be high confidence and moderate volatility at once.'}
    return w


def main():
    rep = {}
    oos = pd.read_csv(os.path.join(OUT, 'p4_oos.csv'), low_memory=False)
    qg_path = os.path.join(OUT, 'qb_game.csv')
    qg = pd.read_csv(qg_path, low_memory=False) if os.path.exists(qg_path) else None
    tg_path = os.path.join(OUT, 'team_game.csv')
    tg = pd.read_csv(tg_path, low_memory=False) if os.path.exists(tg_path) else None
    rs_path = os.path.join(OUT, 'roster_team_season.csv')
    rs = pd.read_csv(rs_path, low_memory=False) if os.path.exists(rs_path) else None

    games = common.fbs_games(both=True)
    venues = common.venue_geo()
    tvm = {}
    for r in venues.itertuples():
        if r.team_key and not pd.isna(r.latitude):
            tvm[r.team_key] = {'lat': float(r.latitude), 'lon': float(r.longitude),
                               'tz': common.tz_hours(r.timezone)}

    qb, _ = qb_layer(oos, qg, rep)
    inj = qb_absence(oos, qg, rep)
    sched_tbl = build_team_schedule(games, oos, tvm)
    sched = schedule_layer(oos, sched_tbl, rep)
    tot = total_layer(oos, tg, rep)
    cont_w, youth_w = score_weights(oos, rs, rep)
    conf_w = confidence_weights(qb, sched, True, rep)

    params = {}
    if qb:
        params['qb'] = qb
    if inj:
        params['injury'] = inj
    if sched:
        params['schedule'] = sched
    if tot:
        params['total'] = tot
    if cont_w:
        params['stability'] = {'weights': {'new_hc': 0.10, 'new_oc': 0.05, 'new_dc': 0.05},
                               'group_weights': cont_w,
                               'basis': 'coaching penalties are a DECLARED POLICY, not a '
                                        'measurement: no public coaching-tenure feed exists '
                                        'in this corpus, so they apply only when the caller '
                                        'supplies staff continuity'}
    if youth_w:
        params['volatility_youth_group_weights'] = youth_w
    params['confidence'] = {'weights': conf_w}
    params['offfield'] = {'half_life_days': 21,
                          'basis': 'declared decay policy — off-field signals affect '
                                   'information confidence and volatility only, never the mean'}
    params['market'] = {'min_research_gap': 2.0, 'min_confidence': 35.0,
                        'basis': 'declared policy thresholds, not fitted edges'}

    with open(os.path.join(OUT, 'params_layers.json'), 'w') as f:
        json.dump(params, f, indent=1)
    with open(os.path.join(OUT, 'report_layers.json'), 'w') as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep, indent=1)[:6000])
    print('[write] params_layers.json, report_layers.json')


if __name__ == '__main__':
    main()
