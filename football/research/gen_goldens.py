#!/usr/bin/env python3
"""Generate golden parity vectors for ../tests.js.

The JS engine (../engine.js) re-implements the exact recursions of
train_nfl.Ratings and train_cfb.CfbRatings. These goldens are computed by
the PYTHON reference implementation on fixed synthetic inputs; tests.js
replays the same inputs through the JS engine and requires agreement to
1e-9. If either side drifts, the parity test fails the build.

Absorb ordering contract (both languages): team rows are processed as an
ORDERED list [home, away] — league-mean EWMAs update sequentially, so
order is part of the algorithm.

Usage: python3 gen_goldens.py <out_dir>   (writes goldens.json next to it)
"""
import sys, os, json
import train_nfl as N
import train_cfb as C

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(OUT, 'params_nfl.json')) as f:
    PN = json.load(f)
with open(os.path.join(OUT, 'params_cfb.json')) as f:
    PC = json.load(f)

# ---------- NFL ratings recursion golden ----------
R = N.Ratings(PN['hyperparams'])
# seed league means from the shipped params (runtime does the same)
R.lmean = dict(PN['league_means'])

def raw(off_epa, pass_epa, rush_epa, ep, er, sra, pr, plays,
        d_epa, d_pass, d_rush, dep, der, srm, pf, pa):
    return {'off_epa_play': off_epa, 'pass_epa_db': pass_epa,
            'rush_epa_att': rush_epa, 'expl_pass': ep, 'expl_rush': er,
            'sack_rate_all': sra, 'pass_rate': pr, 'plays': plays,
            'def_epa_play': d_epa, 'def_pass_epa_db': d_pass,
            'def_rush_epa_att': d_rush, 'def_expl_pass': dep,
            'def_expl_rush': der, 'sack_rate_made': srm,
            'pts_for': pf, 'pts_against': pa}

script = [
    # (home, away, home_raw, away_raw, qb_starts)
    ('KC', 'BUF',
     raw(0.15, 0.22, 0.02, 0.11, 0.16, 0.05, 0.60, 63, -0.05, -0.02, -0.04, 0.07, 0.12, 0.09, 27, 20),
     raw(0.02, 0.05, -0.03, 0.08, 0.11, 0.08, 0.58, 61, 0.15, 0.22, 0.02, 0.11, 0.16, 0.05, 20, 27),
     {'KC': ('00-TEST-QB1', 0.11), 'BUF': ('00-TEST-QB2', -0.02)}),
    ('BUF', 'NYJ',
     raw(0.09, 0.13, 0.05, 0.10, 0.14, 0.06, 0.55, 66, -0.11, -0.15, -0.02, 0.05, 0.10, 0.10, 31, 10),
     raw(-0.11, -0.15, -0.02, 0.05, 0.10, 0.10, 0.52, 58, 0.09, 0.13, 0.05, 0.10, 0.14, 0.06, 10, 31),
     {'BUF': ('00-TEST-QB2', 0.05), 'NYJ': ('00-TEST-QB3', -0.13)}),
    ('KC', 'NYJ',
     raw(0.05, 0.08, 0.01, 0.09, 0.13, 0.07, 0.61, 60, 0.01, 0.03, -0.01, 0.08, 0.12, 0.06, 23, 21),
     raw(0.01, 0.03, -0.01, 0.08, 0.12, 0.06, 0.50, 59, 0.05, 0.08, 0.01, 0.09, 0.13, 0.07, 21, 23),
     {'KC': ('00-TEST-QB1', 0.02)}),
]
for home, away, hr, ar, qbs in script:
    ordered = {home: hr, away: ar}          # insertion order = [home, away]
    R.absorb_game(ordered, qbs)
R.season_break()

nfl_state = {
    'team': {t: {f: R.team[t][f] for f in N.RATE_FEATS} for t in sorted(R.team)},
    'ngames': dict(sorted(R.ngames.items())),
    'lmean': {f: R.lmean[f] for f in sorted(R.lmean)},
    'team_qb': dict(sorted(R.team_qb.items())),
    'qb': {k: R.qb[k] for k in sorted(R.qb)},
}

# prediction golden on the resulting state
class G:
    pass
g = G()
g.home_fr = 'KC'; g.away_fr = 'BUF'
g.home_qb_id = '00-TEST-QB1'; g.away_qb_id = '00-TEST-QB2'
g.home_rest = 7; g.away_rest = 6; g.roof = 'outdoors'; g.temp = 41.0
g.wind = 12.0; g.div_game = 0; g.week = 14; g.surface = 'grass'
sf, tf, cf, known = N.game_features(R, g, {})

import numpy as np
w_s = np.array(PN['w_spread']); w_c = np.array(PN['w_ctx']); w_t = np.array(PN['w_total'])
xs = np.array([sf[f] for f in N.SPREAD_FEATS] + [1.0])
xc = np.array([cf[f] for f in N.CTX_FEATS] + [1.0])
xt = np.array([tf[f] for f in N.TOTAL_FEATS] + [1.0])
nfl_pred = {
    'spread_feats': {k: sf[k] for k in N.SPREAD_FEATS},
    'ctx_feats': {k: cf[k] for k in N.CTX_FEATS},
    'total_feats': {k: tf[k] for k in N.TOTAL_FEATS},
    'koerner_spread': float(xs @ w_s),
    'ctx_adj': float(xc @ w_c),
    'model_spread': float(xs @ w_s + xc @ w_c),
    'sharp_total': float(xt @ w_t),
}

# ---------- CFB recursion golden ----------
CR = C.CfbRatings(PC['hyperparams'])
cfb_script = [
    ('Georgia', 'Clemson', True, True, True, 24, 34, 10),
    ('Georgia', 'Austin Peay', True, False, False, 45, 48, 3),
    ('Clemson', 'Georgia Tech', True, True, False, 10, 27, 17),
]
cfb_preds = []
for home, away, hf, af, neu, margin, hp_, ap_ in cfb_script:
    cfb_preds.append(CR.predict_margin(home, away, hf, af, neu))
    CR.absorb(home, away, hf, af, neu, margin, hp_, ap_)
CR.season_break()
cfb_state = {
    'r': dict(sorted(CR.r.items())),
    'n': dict(sorted(CR.n.items())),
    'off': {t: CR.off[t] for t in sorted(CR.off)},
    'lmean_pts': CR.lmean_pts,
    'pre_absorb_predictions': cfb_preds,
    'final_pred_geo_clem_neutral': CR.predict_margin('Georgia', 'Clemson', True, True, True),
    'final_pred_total_geo_clem': CR.predict_total('Georgia', 'Clemson'),
}

golden = {'nfl_script': [
              {'home': h, 'away': a, 'home_raw': hr, 'away_raw': ar,
               'qb_starts': {t: list(v) for t, v in q.items()}}
              for h, a, hr, ar, q in script],
          'nfl_state': nfl_state,
          'nfl_pred_game': {'home': 'KC', 'away': 'BUF',
                            'home_qb_id': '00-TEST-QB1', 'away_qb_id': '00-TEST-QB2',
                            'home_rest': 7, 'away_rest': 6, 'roof': 'outdoors',
                            'temp': 41.0, 'wind': 12.0, 'div_game': 0,
                            'week': 14, 'surface': 'grass'},
          'nfl_pred': nfl_pred,
          'cfb_script': [list(x) for x in cfb_script],
          'cfb_state': cfb_state}

with open(os.path.join(HERE, 'goldens.json'), 'w') as f:
    json.dump(golden, f, indent=1)
print('goldens.json written')
