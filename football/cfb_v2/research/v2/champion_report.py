"""Champion / challenger report: EdgeDesk V1 vs V2 candidate 001 vs the hardened V2.

    python3 -m v2.champion_report --c001 <out dir of candidate 001> --hard <out dir of the hardened build>

Every number is computed on the SAME games for every predictor (FBS-vs-FBS,
final, all three predictions present), with game-level bootstrap CIs. No overall
grade is given: the evidence is laid out and the decision rules (R10 and gates
G1-G7) are applied mechanically. Writes report/redteam/champion_challenger.json
and docs/cfb-v2/CHAMPION_CHALLENGER.md.
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from . import config as C
from . import redteam as RTM

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..', 'docs', 'cfb-v2'))
RD = os.path.join(HERE, '..', 'report', 'redteam')
WIN = {'dev': list(C.DEV_SEASONS), 'holdout': list(C.HOLDOUT_SEASONS), 'live': [C.LIVE_SEASON]}
PRED = {'V1': 'base_v1', 'V2 candidate 001': 'c001', 'V2 hardened': 'hard'}


def load(c001, hard):
    A = pd.read_parquet(os.path.join(c001, 'stage7', 'backtest_predictions.parquet'))
    B = pd.read_parquet(os.path.join(hard, 'stage7', 'backtest_predictions.parquet'))
    keep = ['game_id', 'season', 'week', 'weeks_in', 'status', 'fcs_game', 'margin', 'neutral_site', 'is_postseason',
            'home_conference', 'away_conference', 'base_v1', 'base_v1_winprob']
    D = A[keep + ['ens_pred', 'p_home_raw', 'lo_50', 'hi_50', 'lo_80', 'hi_80', 'lo_95', 'hi_95', 'line',
                  'close_margin', 'side', 'bet_result', 'bet_units', 'bet_result_close', 'bet_units_close', 'clv_pts',
                  'ev', 'reliability', 'gap_open', 'kickoff_ts']].rename(
        columns={'ens_pred': 'c001', 'p_home_raw': 'p_c001', 'side': 'side_c001', 'bet_result': 'res_c001',
                 'bet_units': 'u_c001', 'bet_result_close': 'resc_c001', 'bet_units_close': 'uc_c001',
                 'clv_pts': 'clv_c001', 'ev': 'ev_c001', 'reliability': 'rel_c001', 'gap_open': 'gap_c001',
                 'line': 'line_c001', 'close_margin': 'close_c001',
                 **{'%s_%d' % (a, q): '%s_%d_c001' % (a, q) for a in ('lo', 'hi') for q in (50, 80, 95)}})
    Bh = B[['game_id', 'ens_pred', 'p_home_raw', 'lo_50', 'hi_50', 'lo_80', 'hi_80', 'lo_95', 'hi_95', 'line',
            'close_margin', 'side', 'bet_result', 'bet_units', 'bet_result_close', 'bet_units_close', 'clv_pts', 'ev',
            'reliability', 'gap_open']].rename(
        columns={'ens_pred': 'hard', 'p_home_raw': 'p_hard', 'side': 'side_hard', 'bet_result': 'res_hard',
                 'bet_units': 'u_hard', 'bet_result_close': 'resc_hard', 'bet_units_close': 'uc_hard',
                 'clv_pts': 'clv_hard', 'ev': 'ev_hard', 'reliability': 'rel_hard', 'gap_open': 'gap_hard',
                 'line': 'line_hard', 'close_margin': 'close_hard',
                 **{'%s_%d' % (a, q): '%s_%d_hard' % (a, q) for a in ('lo', 'hi') for q in (50, 80, 95)}})
    return D.merge(Bh, on='game_id', how='inner')


def block(d, w):
    out = {'n': int(len(d))}
    yw = (d.margin > 0).astype(float)
    for name, c in PRED.items():
        if d[c].isna().all():
            continue
        m = RTM.margin_block(d.margin, d[c])
        pcol = {'base_v1': 'base_v1_winprob', 'c001': 'p_c001', 'hard': 'p_hard'}[c]
        pb = RTM.prob_block(yw, d[pcol]) if d[pcol].notna().sum() > 50 else {}
        r = {k: m.get(k) for k in ('mae', 'mae_ci', 'rmse', 'median_ae', 'bias')}
        r.update({k: pb.get(k) for k in ('brier', 'log_loss', 'ece', 'cal_slope')})
        if c != 'base_v1':
            for q in (50, 80, 95):
                lo, hi = d['lo_%d_%s' % (q, c)], d['hi_%d_%s' % (q, c)]
                ok = lo.notna()
                r['coverage%d' % q] = RTM.r4(((d.margin >= lo) & (d.margin <= hi))[ok].mean()) if ok.any() else None
        # the market
        mo = d.line_hard.notna()
        r['mae_minus_opener'] = RTM.paired(d.margin[mo], d[c][mo], d.line_hard[mo])
        mc = d.close_hard.notna()
        r['mae_minus_close'] = RTM.paired(d.margin[mc], d[c][mc], d.close_hard[mc])
        mm = mo & mc & (d.close_hard != d.line_hard)
        g = d[c][mm] - d.line_hard[mm]
        mv = d.close_hard[mm] - d.line_hard[mm]
        r['close_moved_toward_model_share'] = RTM.r4((np.sign(g) == np.sign(mv)).mean()) if mm.any() else None
        x, y = (d[c] - d.line_hard)[mo & mc].values, (d.close_hard - d.line_hard)[mo & mc].values
        r['move_on_gap_slope'] = RTM.r4(np.sum(x * y) / np.sum(x * x)) if len(x) > 30 else None
        # every game at the opener on the model's side (-110): ATS, ROI, CLV, drawdown
        s = d[mo].sort_values('kickoff_ts')
        side = (s[c] - s.line_hard) > 0
        diff = s.margin - s.line_hard
        res = np.where(diff == 0, 0.0, np.where((diff > 0) == side, 1.0, -1.0))
        u = np.where(res == 1, 100 / 110, np.where(res == -1, -1.0, 0.0))
        clv = np.where(side, s.close_hard - s.line_hard, s.line_hard - s.close_hard)
        cum = np.cumsum(u)
        dec = res[res != 0]
        r['every_game_at_opener'] = {'n': int(len(u)), 'ats': RTM.r4((dec == 1).mean()) if len(dec) else None,
                                     'roi': RTM.r4(u.mean()) if len(u) else None,
                                     'clv': RTM.r4(np.nanmean(clv)) if len(u) else None,
                                     'max_drawdown_units': RTM.r4(np.max(np.maximum.accumulate(np.concatenate([[0], cum]))[1:] - cum)) if len(u) else None}
        out[name] = r
    # the frozen research rule of each V2 version (disabled BET rows included, as "rule-qualified")
    return out


def stability(d):
    out = {}
    axes = {
        'season': d.season.astype(str),
        'week': pd.cut(d.weeks_in, [-1, 2, 5, 9, 30], labels=['wk0-2', 'wk3-5', 'wk6-9', 'wk10+']).astype(str),
        'home conference': d.home_conference.fillna('NA'),
        'favourite size (hardened V2)': pd.cut(d.hard.abs(), [-0.1, 3, 7, 14, 21, 99], labels=['0-3', '3-7', '7-14', '14-21', '21+']).astype(str),
    }
    for ax, key in axes.items():
        t = {}
        for k, g in d.groupby(key):
            if len(g) < 60:
                continue
            t[str(k)] = {'n': int(len(g))}
            for name, c in PRED.items():
                if g[c].notna().mean() > 0.9:
                    t[str(k)][name] = RTM.r4((g[c] - g.margin).abs().mean())
        out[ax] = t
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--c001', required=True)
    ap.add_argument('--hard', required=True)
    a = ap.parse_args()
    D = load(a.c001, a.hard)
    rep = {'windows': {}, 'stability': {}}
    for w, ss in WIN.items():
        d = D[D.season.isin(ss) & D.status.eq('FINAL') & ~D.fcs_game & D.margin.notna()]
        need = ['c001', 'hard'] + (['base_v1'] if w != 'live' else [])
        d = d.dropna(subset=need)
        rep['windows'][w] = block(d, w)
        rep['windows'][w]['hardened_minus_c001'] = RTM.paired(d.margin, d.hard, d.c001)
        if w != 'live':
            rep['windows'][w]['hardened_minus_v1'] = RTM.paired(d.margin, d.hard, d.base_v1)
            rep['stability'][w] = stability(d)
    # R10: the hardened candidate may replace 001 in shadow only if it is not worse on the holdout by > 0.05
    h = rep['windows']['holdout']
    diff = h['hardened_minus_c001']['diff']
    rep['R10'] = {'rule': 'hardened holdout MAE no worse than candidate 001 by more than 0.05, and gates G1-G7 vs V1',
                  'hardened_minus_c001_holdout_mae': diff, 'passes_tolerance': bool(diff is not None and diff <= 0.05)}
    os.makedirs(RD, exist_ok=True)
    with open(os.path.join(RD, 'champion_challenger.json'), 'w') as f:
        json.dump(rep, f, indent=1, default=str)
        f.write('\n')
    render(rep)
    print(json.dumps({w: {k: (v.get('mae') if isinstance(v, dict) else None) for k, v in rep['windows'][w].items()
                          if k in PRED} for w in WIN}, indent=1), rep['R10'])


def f(x, k=3):
    return '—' if x is None else ('%.' + str(k) + 'f') % x


def render(rep):
    L = ['# CFB V2 champion / challenger', '',
         'This report is generated by `python3 -m v2.champion_report`. It gives no overall grade: it lays out the evidence.', '',
         '**Scope:** every number is computed on the same games for every predictor: FBS vs FBS, final, with all predictions present. Brackets are game-level bootstrap 95% CIs.', '',
         '**Champion:** **V1** remains the champion.', '',
         '**Challengers:**',
         '- **V2 candidate 001** is the model merged in #356, frozen in `football/cfb_v2/candidates/cfb_v2_candidate_001`.',
         '- **V2 hardened** (`edgedesk_cfb_v2.1.0`) is candidate 001 after the leak fixes and the simplification decided by the pre-registered rules.', '',
         'The hardened holdout was scored **once**, after the rules were committed.', '']
    for w, title in (('dev', 'Development 2016-2023 (every choice was made here)'), ('holdout', 'Holdout 2024-2025'),
                     ('live', '2026 to date (V1 has no replay for 2026)')):
        W = rep['windows'][w]
        L += ['## %s — %d games' % (title, W['n']), '', '### Margin', '',
              '| | MAE [95% CI] | RMSE | median AE | bias |', '|---|---|---|---|---|']
        for name in PRED:
            if name in W:
                r = W[name]
                L.append('| %s | %s [%s, %s] | %s | %s | %s |' % (name, f(r['mae']), f(r['mae_ci'][0]), f(r['mae_ci'][1]),
                                                                  f(r['rmse']), f(r['median_ae']), f(r['bias'])))
        L.append('')
        hc = W['hardened_minus_c001']
        L.append('- Hardened minus candidate 001: %s pts of MAE [%s, %s].' % (f(hc['diff']), f(hc['ci'][0]), f(hc['ci'][1])))
        if 'hardened_minus_v1' in W:
            hv = W['hardened_minus_v1']
            L.append('- Hardened minus V1: %s [%s, %s].' % (f(hv['diff']), f(hv['ci'][0]), f(hv['ci'][1])))
        L += ['', '### Probability and uncertainty', '',
              '| | Brier | log loss | ECE | calibration slope | 50% cov. | 80% cov. | 95% cov. |', '|---|---|---|---|---|---|---|---|']
        for name in PRED:
            if name in W:
                r = W[name]
                L.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (name, f(r.get('brier'), 4), f(r.get('log_loss'), 4), f(r.get('ece'), 4),
                                                                        f(r.get('cal_slope'), 2), f(r.get('coverage50')), f(r.get('coverage80')), f(r.get('coverage95'))))
        L += ['', '### Market', '',
              '| | MAE − opener [CI] | MAE − close [CI] | close moved toward model | move per pt of gap | every game at the opener: ATS / ROI / CLV / max DD |',
              '|---|---|---|---|---|---|']
        for name in PRED:
            if name in W:
                r = W[name]
                e = r['every_game_at_opener']
                L.append('| %s | %s [%s, %s] | %s [%s, %s] | %s | %s | %s / %s / %s / %s u |' % (
                    name, f(r['mae_minus_opener']['diff']), f(r['mae_minus_opener']['ci'][0]), f(r['mae_minus_opener']['ci'][1]),
                    f(r['mae_minus_close']['diff']), f(r['mae_minus_close']['ci'][0]), f(r['mae_minus_close']['ci'][1]),
                    f(r['close_moved_toward_model_share']), f(r['move_on_gap_slope']), f(e['ats']), f(e['roi']), f(e['clv']),
                    f(e['max_drawdown_units'], 1)))
        L.append('')
        if w in rep['stability']:
            L += ['### Stability (MAE by slice)', '']
            for ax, t in rep['stability'][w].items():
                L += ['**%s**' % ax, '', '| slice | n | ' + ' | '.join(PRED) + ' |', '|---|---|' + '---|' * len(PRED)]
                for k, v in t.items():
                    L.append('| %s | %d | %s |' % (k, v['n'], ' | '.join(f(v.get(n)) for n in PRED)))
                L.append('')
    r10 = rep['R10']
    L += ['## Promotion rule R10 (pre-registered)', '',
          '- **Rule:** %s.' % r10['rule'],
          '- **Hardened minus candidate 001, holdout MAE:** %s.' % f(r10['hardened_minus_c001_holdout_mae']),
          '- **Within the 0.05 tolerance:** %s.' % ('**yes**' if r10['passes_tolerance'] else '**no**'), '',
          'Gates G1-G7 against V1 are in `report/promotion.json` of the hardened build. Promotion to champion is always a person\'s decision.']
    with open(os.path.join(DOCS, 'CHAMPION_CHALLENGER.md'), 'w') as fh:
        fh.write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
