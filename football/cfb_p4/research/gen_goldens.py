#!/usr/bin/env python3
"""Generate golden parity vectors for ../tests.js.

../engine.js re-implements train_p4.Ratings exactly. These vectors are
produced by the PYTHON reference on fixed synthetic inputs, starting from the
SHIPPED seeds (which is what the browser does on newState()); tests.js
replays the same script through the JS engine and requires agreement to 1e-9.
If either side drifts, the build fails.

Ordering contract, identical in both languages: a game is predicted from the
state BEFORE it and absorbed immediately after, and the two team rows of a
game are processed as an ORDERED pair [home, away] because the league-mean
EWMAs update sequentially.

Usage: python3 gen_goldens.py <out_dir>   (writes ../goldens.json)
"""
import json
import os
import sys

import train_p4 as T

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, '..', 'goldens.json')

with open(os.path.join(OUT, 'params_cfb_p4.json')) as f:
    P = json.load(f)

HP = P['hyperparams'] if 'hyperparams' in P else P['rating']['hyperparams']
FEATS = P['efficiency']['feats']


def seeded():
    """A Ratings pre-loaded from the shipped seeds — the exact state the
    browser starts from."""
    R = T.Ratings(HP, venue_hfa={}, league_hfa=P['venue']['league_hfa'])
    R.r = dict(P['rating']['seed_ratings'])
    R.r0 = dict(R.r)
    R.rf = {}
    R.n = dict(P['rating']['seed_ngames'])
    R.scoring = dict((k, dict(v)) for k, v in P['rating']['seed_scoring'].items())
    R.lmean = P['rating']['league_mean_pts']
    R.eff = dict((k, dict(v)) for k, v in P['efficiency']['seed'].items())
    R.eff_mean = dict(P['efficiency']['league_means'])
    return R


# Three teams that are certain to be in the seeds, with a fixed synthetic
# script. Values are deliberately not real games: parity, not realism, is what
# is being tested.
TEAMS = ['alabama', 'georgia', 'texas']
for t in TEAMS:
    if t not in P['rating']['seed_ratings']:
        raise SystemExit('seed missing for %s — regenerate params first' % t)


def stats(off_epa, succ, expl, ypp, sack, pace,
          d_epa, d_succ, d_expl, d_ypp, d_sack, d_pace):
    """A partial efficiency row: the engine must skip features it is not
    given rather than treating absence as zero."""
    return {'epa_per_play': off_epa, 'success_rate': succ, 'expl_epa_rate': expl,
            'yards_per_play': ypp, 'sack_rate_allowed': sack, 'plays_per_game': pace,
            'def_epa_per_play': d_epa, 'def_success_rate': d_succ,
            'def_expl_epa_rate': d_expl, 'def_yards_per_play': d_ypp,
            'def_sack_rate_allowed': d_sack, 'def_plays_per_game': d_pace}


SCRIPT = [
    # home, away, hfa, home_pts, away_pts, home_stats, away_stats
    ('alabama', 'georgia', 3.1, 27, 24,
     stats(0.14, 0.47, 0.09, 6.6, 0.05, 68, -0.02, 0.41, 0.06, 5.4, 0.08, 66),
     stats(-0.02, 0.41, 0.06, 5.4, 0.08, 66, 0.14, 0.47, 0.09, 6.6, 0.05, 68)),
    ('texas', 'alabama', 2.4, 10, 41,
     stats(-0.11, 0.36, 0.04, 4.6, 0.11, 61, 0.21, 0.52, 0.12, 7.4, 0.03, 71),
     stats(0.21, 0.52, 0.12, 7.4, 0.03, 71, -0.11, 0.36, 0.04, 4.6, 0.11, 61)),
    ('georgia', 'texas', 0.0, 31, 31,
     stats(0.06, 0.44, 0.07, 6.0, 0.06, 64, 0.06, 0.44, 0.07, 6.0, 0.06, 64),
     stats(0.06, 0.44, 0.07, 6.0, 0.06, 64, 0.06, 0.44, 0.07, 6.0, 0.06, 64)),
]


def snapshot(R):
    return {
        'r': dict((t, R.r[t]) for t in TEAMS),
        'rf': dict((t, R.fresh(t, True)) for t in TEAMS),
        'n': dict((t, R.games(t)) for t in TEAMS),
        'scoring': dict((t, dict(R.scoring.get(t, {'pf': 0.0, 'pa': 0.0}))) for t in TEAMS),
        'lmean': R.lmean,
        'eff': dict((t, dict((f, R.eff.get(t, {}).get(f, 0.0))
                             for f in sorted(FEATS))) for t in TEAMS),
    }


def main():
    R = seeded()
    steps = [{'label': 'seeded', 'state': snapshot(R)}]

    # a season break first, so the goldens also pin the carry-over arithmetic
    R.season_break()
    steps.append({'label': 'after_season_break', 'state': snapshot(R)})

    predictions = []
    for home, away, hfa, hp_pts, ap_pts, hs, as_ in SCRIPT:
        predictions.append({
            'home': home, 'away': away, 'hfa': hfa,
            'pred_margin': R.predict_margin(home, away, True, True, hfa),
            'fresh_margin': R.fresh(home, True) - R.fresh(away, True) + hfa,
            'pred_total': R.predict_total(home, away),
        })
        R.absorb(home, away, True, True, hfa, hp_pts - ap_pts, hp_pts, ap_pts,
                 {home: hs, away: as_})
        steps.append({'label': '%s_vs_%s' % (home, away), 'state': snapshot(R)})

    blend = []
    curve = P['blend']['prior_weight_by_week']
    for gp in range(0, 16):
        w = float(curve[str(gp)])
        blend.append({'games_played': gp, 'w': w,
                      'value': w * R.r['alabama'] + (1 - w) * R.fresh('alabama', True)})

    G = {
        'generated_by': 'football/cfb_p4/research/gen_goldens.py',
        'model_version': P.get('model_version'),
        'teams': TEAMS,
        'feats': FEATS,
        'script': [{'home': s[0], 'away': s[1], 'hfa': s[2],
                    'home_points': s[3], 'away_points': s[4],
                    'home_stats': s[5], 'away_stats': s[6]} for s in SCRIPT],
        'steps': steps,
        'predictions': predictions,
        'blend': blend,
    }
    with open(DEST, 'w') as f:
        json.dump(G, f, indent=1)
    print('[write] %s  (%d steps, %d predictions)'
          % (os.path.abspath(DEST), len(steps), len(predictions)))


if __name__ == '__main__':
    main()
