"""Audit items 11-13 (duplicates, survivorship, sample selection), 29-30 (push, key numbers) and the
market-orientation defects found by v2.audit.mapping.

    python3 -m v2.audit.samples     -> $CFB_V2_OUT/audit/samples.json

1. Row grain: one row per game in every table the model trains/scores on; the raw line archive's
   duplicate rows; the same pair on the same day under two ids; rescheduled games.
2. Survivorship: per window, the games in the schedule vs the games scored in the published common
   set, why the rest are out, and V2's accuracy on the excluded groups where measurable.
3. Sample selection of the betting record: which seasons/games have an opener; how the historical
   'every game' record depends on which games happen to have archived lines.
4. Market-orientation defects: archive rows whose home/away ids are swapped vs the schedule, and
   games where one book's line has the opposite sign of the others (|line| >= 3 on both sides).
   V2's published market comparison and CLV with and without those games.
5. Push and key numbers: P(final margin == line) for integer lines, FBS-vs-FBS, by era and overtime,
   vs the push table shipped in params.js; the share of overtime finishes at 3 and 7.
"""
import json
import os

import numpy as np
import pandas as pd

from . import _io

RESEARCH = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.environ.get('CFB_V2_DATA', os.path.join(RESEARCH, 'data'))
V2 = os.path.normpath(os.path.join(RESEARCH, '..'))


def grain():
    out = {}
    for p, k in (('stage5/cfb_model_training_snapshots.parquet', 'game_id'),
                 ('stage5/cfb_market_training_snapshots.parquet', 'game_id'),
                 ('stage7/backtest_predictions.parquet', 'game_id'), ('stage2/games.parquet', 'game_id'),
                 ('stage2/market.parquet', 'game_id')):
        d = pd.read_parquet(os.path.join(_io.out_dir(), p), columns=[k])
        out[p] = {'rows': int(len(d)), 'duplicate_keys': int(d[k].duplicated().sum())}
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'))
    G['d'] = G.kickoff_ts.dt.date
    G['pair'] = [tuple(sorted((a, b))) for a, b in zip(G.home_id, G.away_id)]
    out['same_pair_same_season_twice'] = int(G.duplicated(['season', 'pair']).sum())
    tw = G[G.duplicated(['season', 'pair'], keep=False)].sort_values(['season', 'pair'])
    out['same_pair_same_season_examples'] = tw.head(6)[['game_id', 'season', 'home_team', 'away_team', 'kickoff_ts',
                                                        'status', 'is_postseason']].astype(str).to_dict('records')
    L = pd.read_csv(os.path.join(DATA, 'betting', 'cfb_line_odds.csv.gz'), low_memory=False)
    out['line_archive_raw_rows'] = int(len(L))
    out['line_archive_exact_duplicate_rows'] = int(L.duplicated(['game_id', 'market_type', 'abbr', 'book', 'lines', 'odds',
                                                                 'opening_lines', 'opening_odds']).sum())
    out['training_weight'] = 'one row per game (C/D fit on FBS-vs-FBS FINAL rows, unweighted); books aggregated by ' \
                             'median in V1 build_market before V2 sees them'
    return out


def survivorship(M):
    out = {}
    for name, ss in (('dev_2016_2023', _io.DEV), ('holdout_2024_2025', _io.HOLD), ('live_2026', _io.LIVE)):
        a = M[M.season.isin(ss)]
        fin = a[a.status.eq('FINAL')]
        fbs = fin[~fin.fcs_game]
        need = ['ens_pred', 'base_v1', 'line', 'close_margin'] if name != 'live_2026' else ['ens_pred', 'line', 'close_margin']
        common = fbs.dropna(subset=need)
        excl = fbs[~fbs.game_id.isin(common.game_id)]
        rec = {'scheduled_with_fbs_team': int(len(a)), 'final': int(len(fin)), 'not_final': a.status.value_counts().to_dict(),
               'fbs_vs_fcs_final_excluded_from_accuracy': int(fin.fcs_game.sum()),
               'fbs_vs_fbs_final': int(len(fbs)), 'published_common_set': int(len(common)),
               'excluded_from_common_set': int(len(excl)),
               'excluded_reasons': {'no_v1': int(excl.base_v1.isna().sum()) if 'base_v1' in need else None,
                                    'no_opener': int(excl.line.isna().sum()), 'no_close': int(excl.close_margin.isna().sum())},
               'v2_mae_common': float((common.ens_pred - common.margin).abs().mean()),
               'v2_mae_excluded': float((excl.ens_pred - excl.margin).abs().mean()) if len(excl) else None,
               'v2_mae_fcs_games': float((fin[fin.fcs_game].ens_pred - fin[fin.fcs_game].margin).abs().mean()),
               'v2_mae_all_final_incl_fcs': float((fin.ens_pred - fin.margin).abs().mean())}
        e2 = excl.dropna(subset=['close_margin'])
        if len(e2) >= 10:
            rec['excluded_with_close'] = {'n': int(len(e2)), 'v2_mae': float((e2.ens_pred - e2.margin).abs().mean()),
                                          'close_mae': float((e2.close_margin - e2.margin).abs().mean())}
        out[name] = rec
    return out


def sample_selection(M):
    f = _io.fbs_final(M, range(2014, 2027))
    t = f.groupby('season').agg(fbs_final=('game_id', 'size'), with_open=('line', lambda x: int(x.notna().sum())),
                                with_close=('close_margin', lambda x: int(x.notna().sum())))
    no_open = f[f.line.isna() & f.season.ne(2020)]
    has_open = f[f.line.notna()]
    return {'by_season': t.reset_index().to_dict('records'),
            'games_without_opener_excl_2020': int(len(no_open)),
            'v2_mae_games_without_opener': float((no_open.ens_pred - no_open.margin).abs().mean()) if len(no_open) else None,
            'v2_mae_games_with_opener': float((has_open.ens_pred - has_open.margin).abs().mean()),
            'no_opener_share_g5_home': float((~no_open.home_conference.isin(['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'])).mean()) if len(no_open) else None,
            'prices': 'the archive carries lines only after 2019 (and V2 never reads its odds): every historical ROI '
                      'assumes -110; the Model Lab capture (2026) has 805 quotes, 58 with a price'}


def orientation(M):
    B = pd.read_csv(os.path.join(DATA, 'v1', 'out', 'market_books.csv'), low_memory=False)
    s = B[B.market.eq('spread')].copy()
    for c in ('close', 'open'):
        s[c] = pd.to_numeric(s[c], errors='coerce')
    a = s.groupby('game_id').agg(cmax=('close', 'max'), cmin=('close', 'min'), omax=('open', 'max'), omin=('open', 'min'))
    conflict = set(a[((a.cmax >= 3) & (a.cmin <= -3)) | ((a.omax >= 3) & (a.omin <= -3))].index)
    L = pd.read_csv(os.path.join(DATA, 'betting', 'cfb_line_odds.csv.gz'), low_memory=False,
                    usecols=['game_id', 'home_team_id', 'away_team_id'])
    L['game_id'] = pd.to_numeric(L.game_id, errors='coerce')
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'), columns=['game_id', 'home_id', 'away_id'])
    j = L.drop_duplicates().merge(G, on='game_id')
    swapped = set(j[(pd.to_numeric(j.home_team_id) == j.away_id) & (pd.to_numeric(j.away_team_id) == j.home_id)].game_id)
    out = {'swapped_id_games': len(swapped), 'book_sign_conflict_games': len(conflict)}
    for name, ss in (('dev_2016_2023', _io.DEV), ('holdout_2024_2025', _io.HOLD)):
        w = _io.fbs_final(M, ss).dropna(subset=['line', 'close_margin', 'ens_pred'])
        flag = w.game_id.isin(conflict | swapped)
        r = {}
        for lab, x in (('all', w), ('clean', w[~flag]), ('flagged', w[flag])):
            mv = x.close_margin - x.line
            gap = x.ens_pred - x.line
            m = mv != 0
            r[lab] = {'n': int(len(x)),
                      'v2_minus_open_mae': float((x.ens_pred - x.margin).abs().mean() - (x.line - x.margin).abs().mean()),
                      'v2_minus_close_mae': float((x.ens_pred - x.margin).abs().mean() - (x.close_margin - x.margin).abs().mean()),
                      'close_toward_v2_share': float((np.sign(mv) == np.sign(gap))[m].mean()) if m.any() else None,
                      'mean_clv_every_game': float(x.clv_pts.mean()),
                      'flagged_eval_open_close_flip_or_jump': None}
        r['flagged_examples'] = w[flag].head(8)[['game_id', 'season', 'home_team', 'away_team', 'line', 'close_margin',
                                                 'margin', 'ens_pred']].to_dict('records')
        out[name] = r
    return out


def key_numbers(M):
    P = open(os.path.join(V2, 'params.js')).read()
    Pj = json.loads(P[P.index('{', P.index('EDCfbV2Params')):P.rindex('}; })') + 1])
    shipped = Pj['cover']['push_table']
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'))
    f = M[M.status.eq('FINAL') & M.completed.fillna(False).astype(bool)]
    out = {'shipped_push_table': shipped}
    # overtime from the play-by-play period
    ot = []
    for S in range(2014, 2026):
        p = pd.read_parquet(os.path.join(DATA, 'pbp', 'play_by_play_%d.parquet' % S), columns=['game_id', 'period'])
        p['game_id'] = pd.to_numeric(p.game_id, errors='coerce')
        ot.append(p.groupby('game_id').period.max())
    OT = pd.concat(ot)
    f = f.assign(ot=f.game_id.map(OT) > 4)
    rows = {}
    for lab, x in (('fbs_fbs_2014_2025', f[~f.fcs_game & f.season.between(2014, 2025)]),
                   ('fbs_fbs_2016_2025', f[~f.fcs_game & f.season.between(2016, 2025)]),
                   ('fbs_fbs_2014_2019', f[~f.fcs_game & f.season.between(2014, 2019)]),
                   ('fbs_fbs_2021_2025', f[~f.fcs_game & f.season.between(2021, 2025)]),
                   ('with_fcs_2016_2025', f[f.season.between(2016, 2025)])):
        y = x[x.close_margin.notna()]
        integ = y[np.isclose(y.close_margin, np.round(y.close_margin))]
        r = {}
        for L in (3, 7, 10, 14):
            s = integ[integ.close_margin.abs() == L]
            k = int((s.margin == s.close_margin).sum())
            lo, hi = _io.wilson(k / len(s), len(s)) if len(s) else (None, None)
            r['line_%d' % L] = {'n': int(len(s)), 'push_rate': k / len(s) if len(s) else None, 'ci': [lo, hi],
                                'push_rate_excl_ot': float((s.margin == s.close_margin)[~s.ot].mean()) if (~s.ot).any() else None}
        allm = x.margin.abs()
        r['share_abs_margin_3'] = float((allm == 3).mean()); r['share_abs_margin_7'] = float((allm == 7).mean())
        r['ot_share'] = float(x.ot.mean())
        r['share_ot_games_margin_3_or_7'] = float(allm[x.ot].isin([3, 7, 8]).mean()) if x.ot.any() else None
        rows[lab] = r
    out['empirical'] = rows
    out['nfl_reference_not_used'] = 'NFL push rate at 3 is ~0.09-0.10 and at 7 ~0.06; compare with the CFB rows above'
    return out


def main():
    M = _io.preds()
    out = {'doc': __doc__, 'grain': grain(), 'survivorship': survivorship(M), 'sample_selection': sample_selection(M),
           'orientation': orientation(M), 'key_numbers': key_numbers(M)}
    _io.write('samples.json', out)
    print('grain', json.dumps(out['grain'], default=str)[:900])
    for k, v in out['survivorship'].items():
        print('surv', k, v)
    print('sel', {k: v for k, v in out['sample_selection'].items() if k != 'by_season'})
    o = out['orientation']
    print('orient', o['swapped_id_games'], o['book_sign_conflict_games'])
    for k in ('dev_2016_2023', 'holdout_2024_2025'):
        print('  ', k, {kk: vv for kk, vv in o[k].items() if kk != 'flagged_examples'})
    print('keys', json.dumps(out['key_numbers'], default=str)[:2500])


if __name__ == '__main__':
    main()
