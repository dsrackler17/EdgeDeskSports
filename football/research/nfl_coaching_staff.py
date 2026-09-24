#!/usr/bin/env python3
"""EdgeDesk NFL Coaching / Staff walk-forward.

Reads the EXISTING NFL out-of-sample projection ledger produced by
train_nfl.py and asks one incremental question:

    Does persistent team/head-coach performance that the base NFL model failed
    to explain improve the NEXT pregame projection?

Nothing in here scores reputation. Coach identity comes from nflverse
games.csv. Every residual is observed only after the game's frozen pregame
model spread. OC/DC history and game-management decision value remain absent.

Tune/test firewall:
  - 2003-2015 chooses reliability shrink k and cap.
  - 2016-2025 certifies the frozen choice.
  - the holdout cannot swap in a different cap after seeing results.

Outputs JSON only. Production promotion remains a separate Node gate that uses
football/validation/promote.js.

Usage:
  python3 nfl_coaching_staff.py OUT_DIR \
    --experiment-out OUT_DIR/nfl_coaching_staff_experiment.json \
    --seed-out OUT_DIR/nfl_coaching_staff_seed.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np
import pandas as pd

DECAY = {1: 0.45, 2: 0.30, 3: 0.17, 4: 0.08}
INPUT_WEIGHTS = {
    'current_residual_conversion': 0.45,
    'multi_season_head_coach': 0.30,
    'program_persistence': 0.15,
    'efficiency_development': 0.05,
    'game_management': 0.05,
}
K_GRID = [4.0, 8.0, 12.0, 16.0]
CAPS = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]
TUNE_END = 2015
HOLD_START = 2016
HOLD_END = 2025
SIGMA_MARGIN = 10.7
MIN_TUNE_IMPROVEMENT = 0.02
RMSE_TOLERANCE = 0.01
EDGE_THRESHOLDS = [0.5, 1.0, 1.5, 2.0, 3.0]


def r(x, n=4):
    if x is None or not np.isfinite(x):
        return None
    return round(float(x), n)


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def two_sided_normal_p(t):
    return max(0.0, min(1.0, math.erfc(abs(t) / math.sqrt(2.0))))


def paired_error_test(df, base_col, arm_col):
    x = (np.abs(df['margin'] - df[base_col])
         - np.abs(df['margin'] - df[arm_col])).dropna().values
    if len(x) < 30:
        return {'n': int(len(x)), 'p': None, 'reason': 'fewer than thirty paired games'}
    sd = np.std(x, ddof=1)
    if not np.isfinite(sd) or sd <= 0:
        return {'n': int(len(x)), 'p': None, 'reason': 'zero paired-error variance'}
    m = float(np.mean(x))
    t = m / (sd / math.sqrt(len(x)))
    return {'n': int(len(x)), 'mean_diff': r(m), 't': r(t), 'p': r(two_sided_normal_p(t))}


def score(df, pred_col):
    z = df.dropna(subset=[pred_col, 'margin'])
    if not len(z):
        return {'n': 0, 'spread_mae': None, 'rmse': None, 'brier': None}
    err = z[pred_col] - z['margin']
    p = np.array([norm_cdf(v / SIGMA_MARGIN) for v in z[pred_col]], dtype=float)
    y = (z['margin'].values > 0).astype(float)
    ties = z['margin'].values == 0
    if ties.any():
        p = p[~ties]
        y = y[~ties]
    return {
        'n': int(len(z)),
        'spread_mae': r(np.mean(np.abs(err)), 3),
        'rmse': r(np.sqrt(np.mean(err * err)), 3),
        'brier': r(np.mean((p - y) ** 2), 5) if len(p) else None,
    }


def residual_direction(df, base_col, arm_col):
    z = df.dropna(subset=[base_col, arm_col, 'margin'])
    x = (z[arm_col] - z[base_col]).values
    y = (z['margin'] - z[base_col]).values
    keep = np.abs(x) > 1e-12
    x, y = x[keep], y[keep]
    if len(x) < 20:
        return {'n': int(len(x)), 'slope': None, 'correlation': None}
    vx = np.var(x)
    if vx <= 0:
        return {'n': int(len(x)), 'slope': None, 'correlation': None}
    slope = np.cov(x, y, ddof=1)[0, 1] / np.var(x, ddof=1)
    corr = np.corrcoef(x, y)[0, 1] if np.std(y) > 0 else np.nan
    return {
        'n': int(len(x)),
        'slope': r(slope),
        'correlation': r(corr),
        'mean_adjustment': r(np.mean(x)),
        'mean_base_residual': r(np.mean(y)),
    }


def ats_vs_close(df, pred_col):
    out = {}
    z = df.dropna(subset=[pred_col, 'spread_line', 'margin'])
    for tau in EDGE_THRESHOLDS:
        d = z[np.abs(z[pred_col] - z['spread_line']) >= tau].copy()
        if not len(d):
            out[str(tau)] = {'n': 0, 'wins': 0, 'losses': 0, 'pushes': 0, 'win_pct': None}
            continue
        side = np.sign(d[pred_col] - d['spread_line'])
        ats = side * (d['margin'] - d['spread_line'])
        pushes = int((ats == 0).sum())
        n = int((ats != 0).sum())
        wins = int((ats > 0).sum())
        out[str(tau)] = {
            'n': n, 'wins': wins, 'losses': n - wins, 'pushes': pushes,
            'win_pct': r(wins / n, 4) if n else None,
            'clears_110_break_even': bool(n and wins / n > 0.5238095238),
        }
    return out


def stat_add(store, season, key, value):
    if key is None or not np.isfinite(value):
        return
    rec = store[season][key]
    rec[0] += float(value)
    rec[1] += 1


def stat_mean(rec):
    return (rec[0] / rec[1]) if rec and rec[1] > 0 else None


def current_input(current, team, k):
    rec = current.get(team)
    if not rec or rec[1] <= 0:
        return None
    n = rec[1]
    return {
        'evidence': stat_mean(rec),
        'observations': n,
        'reliability': n / (n + k),
        'coverage': 1.0,
    }


def historical_input(store, key, season, k):
    parts, coverage, n_total = [], 0.0, 0
    for lag, w in DECAY.items():
        rec = store.get(season - lag, {}).get(key)
        if not rec or rec[1] <= 0:
            continue
        parts.append((w, stat_mean(rec)))
        coverage += w
        n_total += rec[1]
    if not parts:
        return None
    den = sum(w for w, _ in parts)
    evidence = sum(w * v for w, v in parts) / den
    reliability = coverage * (n_total / (n_total + k))
    return {
        'evidence': evidence,
        'observations': n_total,
        'reliability': reliability,
        'coverage': coverage,
    }


def side_staff(team, coach, season, current_team, season_team, season_coach, k):
    vals = {
        'current_residual_conversion': current_input(current_team, team, k),
        'multi_season_head_coach': historical_input(season_coach, coach, season, k) if coach else None,
        'program_persistence': historical_input(season_team, team, season, k),
        'efficiency_development': None,
        'game_management': None,
    }
    observed_weight = 0.0
    weighted_evidence = 0.0
    weighted_rel = 0.0
    for key, w in INPUT_WEIGHTS.items():
        x = vals.get(key)
        if not x or not np.isfinite(x['evidence']) or not (x['reliability'] > 0):
            continue
        observed_weight += w
        weighted_evidence += w * x['evidence']
        weighted_rel += w * x['reliability']
    if observed_weight <= 0:
        return {
            'available': False, 'raw_evidence': None, 'reliability': 0.0,
            'points': 0.0, 'observed_weight': 0.0, 'inputs': vals,
        }
    raw = weighted_evidence / observed_weight
    reliability = max(0.0, min(1.0, weighted_rel))
    return {
        'available': True,
        'raw_evidence': raw,
        'reliability': reliability,
        'points': raw * reliability,
        'observed_weight': observed_weight,
        'inputs': vals,
    }


def prepare(out_dir):
    oos = pd.read_csv(os.path.join(out_dir, 'nfl_oos.csv'))
    games = pd.read_csv(os.path.join(out_dir, 'nfl_games.csv'))
    keep = ['game_id', 'season', 'week', 'kick_dt', 'home_fr', 'away_fr',
            'home_coach', 'away_coach']
    g = games[keep].copy()
    d = oos.merge(g, on=['game_id', 'season', 'week'], how='left')
    d = d.dropna(subset=['model_spread', 'margin', 'home_fr', 'away_fr'])
    d['kick_dt'] = pd.to_datetime(d['kick_dt'], errors='coerce', utc=True)
    d = d.sort_values(['kick_dt', 'game_id']).reset_index(drop=True)
    return d


def replay(base, k):
    season_team = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))
    season_coach = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))
    current_team = defaultdict(lambda: [0.0, 0])
    current_season = None
    rows = []

    for g in base.itertuples(index=False):
        season = int(g.season)
        if current_season != season:
            current_team = defaultdict(lambda: [0.0, 0])
            current_season = season

        home = side_staff(g.home_fr, g.home_coach if isinstance(g.home_coach, str) else None,
                          season, current_team, season_team, season_coach, k)
        away = side_staff(g.away_fr, g.away_coach if isinstance(g.away_coach, str) else None,
                          season, current_team, season_team, season_coach, k)
        row = {
            'game_id': g.game_id, 'season': season, 'week': g.week,
            'margin': float(g.margin), 'spread_line': float(g.spread_line) if pd.notna(g.spread_line) else np.nan,
            'model_spread': float(g.model_spread),
            'home_staff_points': home['points'], 'away_staff_points': away['points'],
            'home_staff_reliability': home['reliability'], 'away_staff_reliability': away['reliability'],
            'staff_reliability': (home['reliability'] + away['reliability']) / 2.0,
        }
        rows.append(row)

        # Observe the result only AFTER the pregame row above has been emitted.
        residual = float(g.margin) - float(g.model_spread)
        half = residual / 2.0
        current_team[g.home_fr][0] += half
        current_team[g.home_fr][1] += 1
        current_team[g.away_fr][0] -= half
        current_team[g.away_fr][1] += 1
        stat_add(season_team, season, g.home_fr, half)
        stat_add(season_team, season, g.away_fr, -half)
        if isinstance(g.home_coach, str) and g.home_coach:
            stat_add(season_coach, season, g.home_coach, half)
        if isinstance(g.away_coach, str) and g.away_coach:
            stat_add(season_coach, season, g.away_coach, -half)

    return pd.DataFrame(rows), season_team, season_coach


def add_cap(df, cap, col):
    h = np.clip(df['home_staff_points'].values, -cap, cap)
    a = np.clip(df['away_staff_points'].values, -cap, cap)
    df[col] = df['model_spread'].values + h - a
    return df


def arm_metrics(df, pred_col, seasons):
    d = df[df.season.isin(seasons)].copy()
    m = score(d, pred_col)
    m.update({
        'paired': paired_error_test(d, 'model_spread', pred_col),
        'predictive_residual': residual_direction(d, 'model_spread', pred_col),
        'ats_vs_close': ats_vs_close(d, pred_col),
        'per_season': [],
        'leakage_clean': True,
    })
    for s in seasons:
        z = d[d.season == s]
        a, b = score(z, 'model_spread'), score(z, pred_col)
        m['per_season'].append({
            'season': int(s), 'n': b['n'],
            'mae_before': a['spread_mae'], 'mae_after': b['spread_mae'],
            'rmse_before': a['rmse'], 'rmse_after': b['rmse'],
        })
    return m


def reliability_buckets(df, pred_col, seasons):
    d = df[df.season.isin(seasons)].copy()
    defs = [
        ('lt_025', 0.0, 0.25),
        ('025_040', 0.25, 0.40),
        ('040_055', 0.40, 0.55),
        ('ge_055', 0.55, float('inf')),
    ]
    out = {}
    for name, lo, hi in defs:
        z = d[(d.staff_reliability >= lo) & (d.staff_reliability < hi)]
        a, b = score(z, 'model_spread'), score(z, pred_col)
        out[name] = {
            'n': b['n'], 'range': [lo, None if math.isinf(hi) else hi],
            'mae_before': a['spread_mae'], 'mae_after': b['spread_mae'],
            'improvement': r((a['spread_mae'] - b['spread_mae'])
                             if a['spread_mae'] is not None and b['spread_mae'] is not None else None, 3),
        }
    return out


def choose_tune(base, replays):
    tune_seasons = sorted(int(x) for x in base[base.season <= TUNE_END].season.unique())
    base_score = score(base[base.season.isin(tune_seasons)], 'model_spread')
    arms = []
    for k, df in replays.items():
        for cap in CAPS[1:]:
            col = f'candidate_{str(cap).replace(".", "_")}'
            z = df.copy()
            add_cap(z, cap, col)
            met = arm_metrics(z, col, tune_seasons)
            imp = (base_score['spread_mae'] - met['spread_mae']
                   if base_score['spread_mae'] is not None and met['spread_mae'] is not None else None)
            eligible = (
                imp is not None and imp >= MIN_TUNE_IMPROVEMENT
                and met['rmse'] is not None and base_score['rmse'] is not None
                and met['rmse'] <= base_score['rmse'] + RMSE_TOLERANCE
                and met['predictive_residual']['slope'] is not None
                and met['predictive_residual']['slope'] > 0
            )
            arms.append({
                'k': k, 'cap': cap, 'eligible': bool(eligible),
                'improvement': r(imp, 3), 'metrics': met,
            })
    eligible = [a for a in arms if a['eligible']]
    eligible.sort(key=lambda a: (a['metrics']['spread_mae'], a['cap'], -a['k']))
    selected = ({'k': eligible[0]['k'], 'cap': eligible[0]['cap'],
                 'reason': 'lowest tune MAE among arms clearing minimum effect, RMSE and residual-direction guards'}
                if eligible else
                {'k': None, 'cap': 0.0,
                 'reason': 'no non-zero NFL Coaching / Staff arm cleared the tune-window guards'})
    return {'seasons': tune_seasons, 'baseline': base_score, 'arms': arms, 'selection': selected}


def build_seed(base, replay_df, season_team, season_coach, k):
    # Latest observed head coach for each franchise through 2025.
    latest = {}
    for g in base.sort_values(['kick_dt', 'game_id']).itertuples(index=False):
        if int(g.season) > HOLD_END:
            continue
        if isinstance(g.home_coach, str) and g.home_coach:
            latest[g.home_fr] = g.home_coach
        if isinstance(g.away_coach, str) and g.away_coach:
            latest[g.away_fr] = g.away_coach

    raw = {}
    for team, coach in latest.items():
        hc = historical_input(season_coach, coach, HOLD_END + 1, k)
        prog = historical_input(season_team, team, HOLD_END + 1, k)
        raw[team] = {'coach': coach, 'head_coach': hc, 'program': prog}

    def ratings(field):
        vals = [(team, d[field]['evidence']) for team, d in raw.items()
                if d.get(field) and np.isfinite(d[field]['evidence'])]
        if not vals:
            return {}
        arr = np.array([x[1] for x in vals], dtype=float)
        mu, sd = float(np.mean(arr)), float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0
        out = {}
        for team, val in vals:
            z = (val - mu) / sd if sd > 1e-12 else 0.0
            out[team] = max(0.0, min(100.0, 50.0 + 12.0 * z))
        return out

    hc_rating, prog_rating = ratings('head_coach'), ratings('program')
    teams = {}
    for team, d in raw.items():
        row = {}
        hc, prog = d['head_coach'], d['program']
        if hc and team in hc_rating:
            row['head_coach'] = {
                'coach': d['coach'], 'rating': r(hc_rating[team], 1),
                'observations': int(hc['observations']),
                'weighted_evidence': r(hc['evidence'], 3),
                'reliability': r(hc['reliability'], 3),
                'source': 'NFL 2003-2025 leak-free pregame model residuals; same head coach only',
                'last_updated': '2025-12-31',
            }
        if prog and team in prog_rating:
            row['program'] = {
                'rating': r(prog_rating[team], 1),
                'observations': int(prog['observations']),
                'weighted_evidence': r(prog['evidence'], 3),
                'reliability': r(prog['reliability'], 3),
                'source': 'NFL 2003-2025 leak-free pregame model residuals; franchise persistence',
                'last_updated': '2025-12-31',
            }
        teams[team] = row

    return {
        'schema': 'edgedesk_nfl_coaching_staff_seed_v1',
        'trained_through_season': 2025,
        'reliability_k': k,
        'decay': DECAY,
        'teams': teams,
        'provenance': {
            'base_predictions': 'football/research/train_nfl.py nfl_oos.csv model_spread',
            'coach_identity': 'nflverse/nfldata games.csv home_coach/away_coach',
            'note': 'No OC/DC identities, reputation ratings, championships, salary or media priors are used.'
        }
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out_dir')
    ap.add_argument('--experiment-out', required=True)
    ap.add_argument('--seed-out', required=True)
    args = ap.parse_args()

    base = prepare(args.out_dir)
    replays, stores = {}, {}
    for k in K_GRID:
        df, season_team, season_coach = replay(base, k)
        replays[k] = df
        stores[k] = (season_team, season_coach)

    tune = choose_tune(base, replays)
    selected_k = tune['selection']['k']
    hold_seasons = list(range(HOLD_START, HOLD_END + 1))

    if selected_k is None:
        # Still report holdout candidates at the component's conservative
        # default k. They are descriptive only; tune selected cap=0.
        selected_k = 8.0

    hold_df = replays[selected_k].copy()
    baseline = score(hold_df[hold_df.season.isin(hold_seasons)], 'model_spread')
    baseline['feature'] = 'nfl_coaching_staff_cap_0'
    baseline['ats_vs_close'] = ats_vs_close(hold_df[hold_df.season.isin(hold_seasons)], 'model_spread')

    hold_arms = []
    for cap in CAPS[1:]:
        col = f'candidate_{str(cap).replace(".", "_")}'
        add_cap(hold_df, cap, col)
        met = arm_metrics(hold_df, col, hold_seasons)
        met.update({
            'feature': f'nfl_coaching_staff_cap_{str(cap).replace(".", "_")}',
            'label': f'NFL Coaching / Staff ±{cap} team points',
            'coefficient': cap,
            'version': 'nfl_coaching_staff_v1',
            'k': selected_k,
            'cap': cap,
            'reliability_buckets': reliability_buckets(hold_df, col, hold_seasons),
        })
        hold_arms.append(met)

    season_team, season_coach = stores[selected_k]
    seed = build_seed(base, hold_df, season_team, season_coach, selected_k)

    experiment = {
        'schema': 'edgedesk_nfl_coaching_staff_experiment_v1',
        'sport': 'americanfootball_nfl',
        'frame': {
            'tune': '2003-2015',
            'holdout': '2016-2025',
            'leakage': 'every coaching/staff value is emitted before the current game residual is observed',
            'base_model': 'nfl_oos.csv model_spread from train_nfl.py',
            'market': 'nflverse closing consensus is benchmark-only and is never an input to the coaching/staff residual'
        },
        'policy': {
            'sport_specific': True,
            'caps_tested': CAPS,
            'reliability_k_tested': K_GRID,
            'tune_min_mae_improvement': MIN_TUNE_IMPROVEMENT,
            'rmse_tolerance': RMSE_TOLERANCE,
            'holdout_cannot_change_tune_choice': True,
            'ats_thresholds_fixed_before_holdout': EDGE_THRESHOLDS,
        },
        'tune': tune,
        'holdout': {'baseline': baseline, 'arms': hold_arms},
        'seed_summary': {'teams': len(seed['teams']), 'reliability_k': selected_k},
    }

    os.makedirs(os.path.dirname(args.experiment_out), exist_ok=True)
    os.makedirs(os.path.dirname(args.seed_out), exist_ok=True)
    with open(args.experiment_out, 'w') as f:
        json.dump(experiment, f, indent=1)
    with open(args.seed_out, 'w') as f:
        json.dump(seed, f, indent=1)

    print('NFL Coaching / Staff tune selection:', json.dumps(tune['selection']))
    print('holdout baseline:', json.dumps(baseline))
    for arm in hold_arms:
        print(f"  cap ±{arm['cap']}: MAE {arm['spread_mae']} RMSE {arm['rmse']} "
              f"Brier {arm['brier']} paired p {arm['paired']['p']}")
    print('wrote', args.experiment_out)
    print('wrote', args.seed_out)


if __name__ == '__main__':
    main()
