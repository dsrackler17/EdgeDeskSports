#!/usr/bin/env python3
"""Assemble legacy_predictions.csv from the three baselines and print sanity numbers.
usage: python3 -I assemble.py <legacy_dir>"""
import sys, os, math, json
import numpy as np
import pandas as pd

L = sys.argv[1]
D = os.path.join(L, 'data', 'nfl')
O = os.path.join(L, 'out')
SIGMA = 10.7   # params.js nfl.sigma_margin


def ncdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


g = pd.read_csv(os.path.join(D, 'games.csv'))
g = g[(g.season >= 2006) & g.home_score.notna() & g.away_score.notna()].copy()
base = g[['game_id', 'season', 'week', 'home_team', 'away_team']].copy()

# (A) trained: walk-forward OOS frame (2026-extended run; identical to the canonical run for <=2025)
oos = pd.read_csv(os.path.join(O, 'ext2026', 'nfl_oos.csv'))
tot = pd.read_csv(os.path.join(O, 'ext2026', 'nfl_oos_total.csv'))
canon = pd.read_csv(os.path.join(O, 'canon', 'nfl_oos.csv'))
chk = canon.merge(oos, on='game_id', suffixes=('_c', '_e'))
assert len(chk) == len(canon) and np.allclose(chk.model_spread_c, chk.model_spread_e, atol=0, rtol=0)
A = oos[['game_id', 'model_spread']].rename(columns={'model_spread': 'trained_margin'})
A['trained_win_prob'] = [ncdf(m / SIGMA) for m in A.trained_margin]
A = A.merge(tot[['game_id', 'model_total']].rename(columns={'model_total': 'trained_total'}), on='game_id', how='outer')

def shipped(fname, pfx):
    s = pd.read_csv(os.path.join(O, fname))
    return s[['game_id', 'margin', 'win_prob', 'total']].rename(columns={
        'margin': pfx + '_margin', 'win_prob': pfx + '_win_prob', 'total': pfx + '_total'})

B = shipped('shipped.csv', 'shipped')
C = shipped('shipped_deffix.csv', 'shipped_deffix')

out = base.merge(A, on='game_id', how='left').merge(B, on='game_id', how='left').merge(C, on='game_id', how='left')
cols = ['game_id', 'season', 'week', 'home_team', 'away_team',
        'trained_margin', 'trained_win_prob', 'trained_total',
        'shipped_margin', 'shipped_win_prob', 'shipped_total',
        'shipped_deffix_margin', 'shipped_deffix_win_prob', 'shipped_deffix_total']
out = out.sort_values(['season', 'week', 'game_id'])[cols]
out.to_csv(os.path.join(L, 'legacy_predictions.csv'), index=False, float_format='%.6f')

# ---------------- sanity numbers ----------------
ev = out.merge(g[['game_id', 'game_type', 'result', 'spread_line', 'total', 'total_line']]
               .rename(columns={'total': 'pts'}), on='game_id')
res = {'rows': len(out), 'by_season': out.groupby('season').size().to_dict(),
       'nan_counts': out.isna().sum().to_dict()}

def block(d, label):
    r = {}
    for b in ['trained', 'shipped', 'shipped_deffix']:
        e = d.dropna(subset=[b + '_margin', 'spread_line'])
        r[b] = {'n': len(e), 'mae_model': round(float(np.abs(e[b + '_margin'] - e.result).mean()), 3),
                'mae_close': round(float(np.abs(e.spread_line - e.result).mean()), 3)}
        et = d.dropna(subset=[b + '_total', 'total_line'])
        r[b]['total_n'] = len(et)
        r[b]['total_mae_model'] = round(float(np.abs(et[b + '_total'] - et.pts).mean()), 3)
        r[b]['total_mae_close'] = round(float(np.abs(et.total_line - et.pts).mean()), 3)
        y = (e.result > 0).astype(float); m = e.result != 0
        p = np.clip(e[b + '_win_prob'].values, 1e-6, 1 - 1e-6)
        r[b]['winprob_brier_nonties'] = round(float(np.mean(((p - y) ** 2)[m.values])), 5)
    cm = d.dropna(subset=['trained_margin', 'shipped_margin', 'shipped_deffix_margin', 'spread_line'])
    r['common'] = {'n': len(cm), 'mae_close': round(float(np.abs(cm.spread_line - cm.result).mean()), 3)}
    for b in ['trained', 'shipped', 'shipped_deffix']:
        r['common']['mae_' + b] = round(float(np.abs(cm[b + '_margin'] - cm.result).mean()), 3)
    r['corr'] = {k: round(float(cm[[a, c]].corr().iloc[0, 1]), 4) for k, (a, c) in {
        'trained~shipped': ('trained_margin', 'shipped_margin'),
        'trained~deffix': ('trained_margin', 'shipped_deffix_margin'),
        'shipped~deffix': ('shipped_margin', 'shipped_deffix_margin'),
        'trained~close': ('trained_margin', 'spread_line'),
        'shipped~close': ('shipped_margin', 'spread_line'),
        'deffix~close': ('shipped_deffix_margin', 'spread_line')}.items()}
    res[label] = r

block(ev[(ev.season >= 2016) & (ev.season <= 2025) & (ev.game_type == 'REG')], 'reg_2016_2025')
block(ev[(ev.season >= 2016) & (ev.season <= 2025)], 'all_types_2016_2025')
block(ev[(ev.season >= 2006) & (ev.season <= 2015) & (ev.game_type == 'REG')], 'reg_2006_2015')
block(ev[ev.season == 2026], 'season_2026_to_date')
print(json.dumps(res, indent=1))
with open(os.path.join(O, 'sanity.json'), 'w') as f:
    json.dump(res, f, indent=1)
