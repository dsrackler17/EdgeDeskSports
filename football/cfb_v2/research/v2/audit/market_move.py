"""Audit items 43-46 (+33/34 limits) — does the close move toward EdgeDesk, and is any betting result luck?

    python3 -m v2.audit.market_move    -> $CFB_V2_OUT/audit/market_move.json

1. Share of games whose close moved toward the predictor (sign(close-open) == sign(pred-open) among
   games that moved), mean movement toward the predictor (all games, 0 when no move), by |gap| >= 0,
   1, 2, 3, 4 — for V2.1 AND for placebo predictors (V1, Elo, CFBD Elo, audit ridges, naive home
   field, a random predictor with V2's gap spread). If simple or random predictors show the same
   pattern, "the market moves toward EdgeDesk" is not evidence about EdgeDesk.
2. CLV x outcome decomposition of 'always bet the V2 side at the opener' (the only historical bet set;
   BET is disabled).
3. Luck: ATS win rate vs the -110 break-even with a binomial test and bootstrap CI; permutation test
   that re-draws V2's side within each season-week (keeps the weekly structure) — ATS and CLV of the
   real side vs 2,000 random-side worlds.
"""
import numpy as np
import pandas as pd
from scipy import stats

from . import _io

BE = 1 / (1 + 100 / 110)


def movement(w, pred, thresholds=(0, 1, 2, 3, 4)):
    gap = w[pred] - w.line
    mv = w.close_margin - w.line
    out = {}
    for t in thresholds:
        m = gap.abs() >= t if t > 0 else gap.abs() > 0
        g, v = gap[m], mv[m]
        moved = v != 0
        toward = (np.sign(v) == np.sign(g))[moved]
        k, n = int(toward.sum()), int(moved.sum())
        lo, hi = _io.wilson(k / n, n) if n else (None, None)
        tw = (np.sign(g) * v)
        out['gap_ge_%d' % t] = {'n_games': int(m.sum()), 'n_moved': n, 'share_toward': k / n if n else None,
                                'share_ci': [lo, hi], 'mean_move_toward_pts': float(tw.mean()),
                                'mean_move_toward_ci': _io.ci(tw.values[_io.boot_idx(len(tw), 1000)].mean(axis=1))}
    return out


def main():
    M = _io.preds().copy()
    B = pd.read_parquet(_io.audit_path('baseline_preds.parquet'))
    M = M.merge(B[['game_id', 'ridge_epa3', 'ridge_small8']], on='game_id', how='left')
    rng = np.random.default_rng(_io.SEED)
    out = {'doc': __doc__}
    for name, ss in (('dev_2016_2023', _io.DEV), ('holdout_2024_2025', _io.HOLD), ('live_2026_replay', _io.LIVE),
                     ('dev_plus_holdout', _io.DEV + _io.HOLD)):
        w = _io.fbs_final(M, ss).dropna(subset=['ens_pred', 'line', 'close_margin']).copy()
        sdg = float((w.ens_pred - w.line).std())
        w['placebo_random'] = w.line + rng.normal(0, sdg, len(w))
        preds = ['ens_pred', 'base_v1', 'pred_B_elo', 'base_cfbd_elo', 'ridge_epa3', 'ridge_small8', 'base_hfa',
                 'placebo_random']
        W = {'n': int(len(w)), 'movement': {}}
        for p in preds:
            ww = w.dropna(subset=[p])
            if len(ww) > 100:
                W['movement'][p] = movement(ww, p)
                W['movement'][p]['n_common'] = int(len(ww))
        # same-games comparison V2 vs V1 (V1 missing in 2026)
        # 2. CLV x outcome for the every-game V2 side at the opener
        s = w[w.side.notna()]
        pos = s.clv_pts > 0; neg = s.clv_pts < 0; win = s.bet_result == 1; loss = s.bet_result == -1
        W['clv_outcome'] = {'pos_clv_win': int((pos & win).sum()), 'pos_clv_loss': int((pos & loss).sum()),
                            'neg_clv_win': int((neg & win).sum()), 'neg_clv_loss': int((neg & loss).sum()),
                            'zero_clv': int((s.clv_pts == 0).sum()), 'pushes': int((s.bet_result == 0).sum()),
                            'win_rate_given_pos_clv': float(win[pos].sum() / (win[pos].sum() + loss[pos].sum())),
                            'win_rate_given_neg_clv': float(win[neg].sum() / (win[neg].sum() + loss[neg].sum())),
                            'mean_clv': float(s.clv_pts.mean())}
        # 3. luck
        dec = s[s.bet_result != 0]
        k, n = int((dec.bet_result == 1).sum()), int(len(dec))
        W['ats_every_game_at_open'] = {'n_decided': n, 'wins': k, 'win_rate': k / n, 'win_rate_ci': list(_io.wilson(k / n, n)),
                                       'p_value_vs_break_even_one_sided': float(stats.binomtest(k, n, BE, 'greater').pvalue),
                                       'p_value_vs_50_two_sided': float(stats.binomtest(k, n, 0.5).pvalue),
                                       'roi_at_minus110': float(s.bet_units.mean()),
                                       'roi_ci': _io.ci(s.bet_units.values[_io.boot_idx(len(s), 2000)].mean(axis=1))}
        dc = s[s.bet_result_close.notna() & (s.bet_result_close != 0)]
        kc, nc = int((dc.bet_result_close == 1).sum()), int(len(dc))
        W['ats_every_game_at_close'] = {'n_decided': nc, 'wins': kc, 'win_rate': kc / nc, 'win_rate_ci': list(_io.wilson(kc / nc, nc)),
                                        'p_value_vs_50_two_sided': float(stats.binomtest(kc, nc, 0.5).pvalue)}
        # permutation: random side within season-week
        grp = (s.season.astype(str) + '-' + s.week.astype(str)).values
        home_cover = np.sign(s.margin - s.line).values          # +1 home covers, -1 away, 0 push
        clv_home = (s.close_margin - s.line).values
        real_side = np.where(s.side.eq('HOME'), 1, -1)
        real_ats = np.mean((real_side * home_cover)[home_cover != 0] > 0)
        real_clv = np.mean(real_side * clv_home)
        R = 2000
        ats_null, clv_null = np.empty(R), np.empty(R)
        # keep the share of HOME picks within each week (structure-preserving shuffle)
        idx_by_g = pd.Series(np.arange(len(s))).groupby(grp).apply(lambda x: x.values).to_dict()
        for i in range(R):
            sd = real_side.copy()
            for g, ix in idx_by_g.items():
                sd[ix] = rng.permutation(sd[ix])
            ats_null[i] = np.mean((sd * home_cover)[home_cover != 0] > 0)
            clv_null[i] = np.mean(sd * clv_home)
        W['permutation_within_week'] = {'real_ats': float(real_ats), 'null_ats_mean': float(ats_null.mean()),
                                        'null_ats_95': _io.ci(ats_null), 'p_ats': float(np.mean(ats_null >= real_ats)),
                                        'real_clv': float(real_clv), 'null_clv_mean': float(clv_null.mean()),
                                        'null_clv_95': _io.ci(clv_null), 'p_clv': float(np.mean(clv_null >= real_clv))}
        out[name] = W
    _io.write('market_move.json', out)
    for name in ('dev_2016_2023', 'holdout_2024_2025', 'live_2026_replay'):
        W = out[name]
        print('=====', name, 'n', W['n'])
        for p, r in W['movement'].items():
            print('  %-15s' % p, ' '.join('%s:%.3f(n%d,mv%+.2f)' % (k.replace('gap_ge_', '>='), v['share_toward'] or 0,
                                                                    v['n_moved'], v['mean_move_toward_pts'])
                                             for k, v in r.items() if k.startswith('gap')))
        print('  clv_outcome', W['clv_outcome'])
        print('  ats open', W['ats_every_game_at_open'])
        print('  ats close', W['ats_every_game_at_close'])
        print('  perm', W['permutation_within_week'])


if __name__ == '__main__':
    main()
