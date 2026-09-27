"""Sign-convention audit, scenario by scenario.

    python3 -m v2.tests_signs          (exit 0 = green)

Canonical convention (common.py): an INTERNAL margin is home points minus away
points, so +7 means the home team is expected to win by 7. A sportsbook home
line of -7 (home laying 7) is the same statement, negated, and is converted
exactly once at ingestion.

Every scenario below is written from the bettor's point of view with a known
answer, then pushed through each place a sign can go wrong: the ingestion
converters (archive, CFBD provider mean, V1 replay records), the cover grader,
the EV formula, CLV, the "moved toward the model" test and the consensus. The
[data] tests re-check the same scenarios on the real archive: if a converter
were flipped for one source or one kind of game, the favourite would stop
winning in that slice.
"""
import os
import sys
import tempfile
import traceback

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import games as GM
from . import market as MKT

RESULTS = []


def test(fn):
    RESULTS.append(fn)
    return fn


# One place for the arithmetic every consumer must agree with. Written out
# longhand, deliberately NOT calling the functions under test.
def truth(side, line_margin, final_margin, close_margin=None):
    """side 'HOME'/'AWAY'; line/close in INTERNAL margin terms."""
    d = final_margin - line_margin
    if d == 0:
        res = 0
    elif side == 'HOME':
        res = 1 if d > 0 else -1
    else:
        res = 1 if d < 0 else -1
    clv = None
    if close_margin is not None:
        # a HOME bettor gains when the market later asks the home team to win by MORE
        clv = (close_margin - line_margin) if side == 'HOME' else (line_margin - close_margin)
    return res, clv


# Scenarios: (name, home_line_open, home_line_close, model_margin, final_margin,
#             expected side, expected result, expected clv)
SCEN = [
    # Texas Tech at HOME, -7. Model: Tech by 10 (+10). Tech wins by 10, closes -8.5.
    ('home favourite', -7.0, -8.5, 10.0, 10.0, 'HOME', 1, 1.5),
    # Texas Tech on the ROAD, -7 -> the home line is +7 -> margin -7. Model: Tech by 10
    # -> internal -10. Tech wins by 10 (margin -10). Closes Tech -8.5 (home +8.5).
    ('road favourite', 7.0, 8.5, -10.0, -10.0, 'AWAY', 1, 1.5),
    # home favourite that the model thinks is overpriced: home -7, model +3, home wins by 3
    ('home favourite, model takes the dog', -7.0, -6.0, 3.0, 3.0, 'AWAY', 1, 1.0),
    # road dog that the model likes: home -10 (margin +10), model +4 -> AWAY; home wins by 14
    ('road dog loses by more than the line', -10.0, -11.0, 4.0, 14.0, 'AWAY', -1, -1.0),
    # favourite flip: opens home -2 (margin +2), closes home +1.5 (margin -1.5); model -3
    ('favourite flip', -2.0, 1.5, -3.0, -4.0, 'AWAY', 1, 3.5),
    # pick'em: 0 line, model +1 -> HOME; a 0 final is a push
    ("pick'em push", 0.0, 0.0, 1.0, 0.0, 'HOME', 0, 0.0),
    ("pick'em win", 0.0, -1.0, 1.0, 1.0, 'HOME', 1, 1.0),
    # hook: home -3.5, model +5, home wins by 3 -> loses; closes -4
    ('hook loses by half a point', -3.5, -4.0, 5.0, 3.0, 'HOME', -1, 0.5),
    # push on a whole number: home -3, model +6, home wins by 3
    ('whole-number push', -3.0, -3.0, 6.0, 3.0, 'HOME', 0, 0.0),
]


@test
def converters_negate_exactly_once():
    for name, lo, lc, mm, fm, side, res, clv in SCEN:
        m = common.book_home_line_to_margin(lo)
        assert m == -lo, name
        assert common.margin_to_book_home_line(m) == lo, name


@test
def cover_grader_matches_longhand_every_scenario():
    for name, lo, lc, mm, fm, side, res, clv in SCEN:
        line = common.book_home_line_to_margin(lo)
        r_home = common.home_cover_result(fm, line)
        r = r_home if side == 'HOME' else -r_home
        t, _ = truth(side, line, fm)
        assert r == t == res, (name, r, t, res)


@test
def scenario_side_follows_model_minus_market():
    for name, lo, lc, mm, fm, side, res, clv in SCEN:
        gap = mm - common.book_home_line_to_margin(lo)        # + = model likes HOME
        if gap == 0:
            continue
        assert ('HOME' if gap > 0 else 'AWAY') == side, name


def _synthetic_market_world(seed=11):
    """Two seasons of synthetic games with an honest, modest model. Season 2021
    holds the scenarios, graded by market.run; 2019-2020 train the calibrators."""
    rng = np.random.default_rng(seed)
    rows, mk = [], []
    gid = 0
    for S in (2019, 2020):
        for _ in range(700):
            gid += 1
            true = rng.normal(0, 14)
            ens = true + rng.normal(0, 5)
            line = true + rng.normal(0, 3)
            close = line + 0.3 * (ens - line) + rng.normal(0, 1)
            fm = float(np.round(true + rng.normal(0, 13)))
            rows.append(dict(game_id=gid, season=S, status='FINAL', ens_pred=ens, sigma=14.0, margin=fm,
                             ens_sd=2.0, rating_sd_sum=1.0, early_season=0.0, qb_unsettled_any=0.0,
                             qb_missing_any=0.0, fcs_game=False))
            mk.append(dict(game_id=gid, open_margin=np.round(line * 2) / 2, close_margin=np.round(close * 2) / 2))
    for name, lo, lc, mm, fm, side, res, clv in SCEN:
        gid += 1
        rows.append(dict(game_id=gid, season=2021, status='FINAL', ens_pred=mm, sigma=14.0, margin=fm,
                         ens_sd=2.0, rating_sd_sum=1.0, early_season=0.0, qb_unsettled_any=0.0,
                         qb_missing_any=0.0, fcs_game=False, scen=name))
        mk.append(dict(game_id=gid, open_margin=common.book_home_line_to_margin(lo),
                       close_margin=common.book_home_line_to_margin(lc)))
    D = pd.DataFrame(rows)
    MK = pd.DataFrame(mk)
    for c in ('total_open', 'total_close', 'market_dispersion', 'spread_books'):
        MK[c] = np.nan
    MK['has_open'] = True
    MK['source'] = 'synthetic'
    unc = {S: {'t_df': 8} for S in (2019, 2020, 2021)}
    return D, MK, unc


@test
def market_layer_grades_every_scenario_like_longhand():
    D, MK, unc = _synthetic_market_world()
    M, _ = MKT.run(D, MK, unc, [2020, 2021])
    s = M[M.season.eq(2021)].set_index('scen')
    for name, lo, lc, mm, fm, side, res, clv in SCEN:
        r = s.loc[name]
        line = common.book_home_line_to_margin(lo)
        assert r.line == line, name
        assert np.isclose(r.gap_open, mm - line), name
        # the side is chosen by the calibrated cover probability, which with an
        # honest calibrator agrees with the sign of the gap on these clear cases
        assert r.side == side, (name, r.side, side)
        t_res, t_clv = truth(r.side, line, fm, common.book_home_line_to_margin(lc))
        assert r.bet_result == t_res == res, (name, r.bet_result, t_res, res)
        assert np.isclose(r.clv_pts, t_clv) and np.isclose(t_clv, clv), (name, r.clv_pts, t_clv, clv)
        # units: +0.909 on a win at -110, -1 on a loss, 0 on a push
        exp_units = {1: 100.0 / 110.0, -1: -1.0, 0: 0.0}[res]
        assert np.isclose(r.bet_units, exp_units), name
        # EV and cover probability point the same way as the side
        assert r.p_side >= 0.5, name
        pc_home = r.pc_home_cal
        assert (pc_home >= 0.5) == (side == 'HOME'), name
        # EV = p_win * payout - p_loss, recomputed longhand
        p_win = r.p_side * (1 - r.push_p)
        p_loss = (1 - r.p_side) * (1 - r.push_p)
        assert np.isclose(r.ev, p_win * (100.0 / 110.0) - p_loss), name


@test
def ev_breaks_even_at_the_break_even_probability():
    for price in (-110, -105, -120, +100, +115):
        be = MKT.break_even_prob(price)
        ev = be * MKT.american_to_payout(price) - (1 - be)
        assert abs(ev) < 1e-12, price
    assert abs(MKT.break_even_prob(-110) - 0.5238095) < 1e-6


@test
def closing_line_value_sign_on_line_moves():
    # the market moving toward the side taken is positive CLV for that side
    for side, open_m, close_m, want in (('HOME', 7, 8.5, 1.5), ('HOME', 7, 5, -2), ('AWAY', 7, 5, 2),
                                        ('AWAY', -3, -6, 3), ('AWAY', 2, -1.5, 3.5)):
        _, c = truth(side, open_m, 0.0, close_m)
        assert c == want, (side, open_m, close_m, c, want)


@test
def cfbd_provider_lines_are_converted_from_book_convention():
    """games.build_market reads the CFBD release in BOOK convention and must
    negate it; the archive CSV is already in margin convention and must not
    be negated again."""
    tmp = tempfile.mkdtemp()
    ml = os.path.join(tmp, 'mline')
    os.makedirs(ml)
    pd.DataFrame({'game_id': [1, 2, 3, 4], 'spread_open': [-7.0, 7.0, 0.0, -2.0],
                  'spread': [-8.5, 8.5, -1.0, 1.5], 'over_under': [50.0] * 4,
                  'over_under_open': [49.0] * 4}).to_parquet(os.path.join(ml, 'ml_2026.parquet'))
    arch = os.path.join(tmp, 'market.csv')
    pd.DataFrame({'game_id': [5], 'spread_open': [7.0], 'spread_close': [8.5], 'spread_books': [5],
                  'spread_close_sd': [0.5], 'total_open': [50.0], 'total_close': [51.0],
                  'spread_close_pin': [8.5], 'spread_open_pin': [7.0]}).to_csv(arch, index=False)
    G = pd.DataFrame({'game_id': [1, 2, 3, 4, 5]})
    M = GM.build_market(G, arch, ml).set_index('game_id')
    # 1 home favourite, 2 road favourite, 3 pick'em opener, 4 favourite flip, 5 archive home fav
    assert M.loc[1, 'spread_open'] == 7.0 and M.loc[1, 'spread_close'] == 8.5
    assert M.loc[2, 'spread_open'] == -7.0 and M.loc[2, 'spread_close'] == -8.5
    assert M.loc[3, 'spread_open'] == 0.0 and M.loc[3, 'spread_close'] == 1.0
    assert M.loc[4, 'spread_open'] == 2.0 and M.loc[4, 'spread_close'] == -1.5
    assert M.loc[5, 'spread_open'] == 7.0 and M.loc[5, 'spread_close'] == 8.5, 'archive negated twice'
    assert M.loc[5, 'source'] == 'cfbfastR_multibook_archive'


@test
def consensus_is_a_median_of_home_lines():
    # the engine's consensus (JS) and V1's (python median across books) agree on
    # sign by construction: every book row is reduced to the HOME line first
    xs = [-7.0, -6.5, -7.5, -7.0]
    assert float(np.median(xs)) == -7.0
    assert common.book_home_line_to_margin(float(np.median(xs))) == 7.0


# ------------------------------------------------------------------ data
def _art(*p):
    f = common.out_path(*p)
    return f if os.path.exists(f) else None


def _joined():
    fg, fm = _art('stage2', 'games.parquet'), _art('stage2', 'market.parquet')
    if not (fg and fm):
        return None
    G = pd.read_parquet(fg)
    M = pd.read_parquet(fm)
    j = G.merge(M, on='game_id')
    return j[j.status.eq('FINAL') & j.spread_close.notna()]


@test
def data_home_and_road_favourites_win_by_source_and_site():
    j = _joined()
    if j is None:
        return 'skipped (no artifact)'
    out = []
    for src in j.source.unique():
        for neutral in (False, True):
            s = j[j.source.eq(src) & j.neutral_site.eq(neutral)]
            hf, rf = s[s.spread_close >= 3], s[s.spread_close <= -3]
            if len(hf) < 40 or len(rf) < 40:
                continue
            # home favourites (internal close >= +3) win; road favourites (<= -3) make the home team lose
            assert (hf.margin > 0).mean() > 0.6, (src, neutral, 'home fav win rate', (hf.margin > 0).mean())
            assert (rf.margin < 0).mean() > 0.6, (src, neutral, 'road fav win rate', (rf.margin < 0).mean())
            assert hf.margin.mean() > 0 and rf.margin.mean() < 0, (src, neutral)
            out.append('%s/%s n=%d' % (src[:5], 'N' if neutral else 'H', len(s)))
    return ', '.join(out)


@test
def data_pickem_and_flips_behave():
    j = _joined()
    if j is None:
        return 'skipped (no artifact)'
    pk = j[j.spread_close.abs() <= 1.0]
    assert len(pk) > 100 and abs((pk.margin > 0).mean() - 0.5) < 0.1, 'pick-em games are not ~50/50'
    fl = j[j.spread_open.notna() & (np.sign(j.spread_open) * np.sign(j.spread_close) < 0)]
    # after a favourite flip the CLOSING favourite should win more often than not
    if len(fl) > 50:
        assert (np.sign(fl.margin) == np.sign(fl.spread_close)).mean() > 0.5
    return 'pickem n=%d, flips n=%d' % (len(pk), len(fl))


@test
def data_v1_replay_records_are_converted():
    f = _art('stage7', 'backtest_predictions.parquet')
    if not f:
        return 'skipped (no artifact)'
    B = pd.read_parquet(f, columns=['margin', 'base_v1', 'ens_pred', 'line', 'close_margin', 'status'])
    B = B[B.status.eq('FINAL')]
    for c in ('base_v1', 'ens_pred', 'line', 'close_margin'):
        s = B[B[c].notna()]
        assert s[c].corr(s.margin) > 0.5, (c, 'is not in home-margin convention')


@test
def data_grading_matches_longhand_on_real_rows():
    f = _art('stage7', 'backtest_predictions.parquet')
    if not f:
        return 'skipped (no artifact)'
    B = pd.read_parquet(f, columns=['side', 'line', 'margin', 'close_margin', 'bet_result', 'clv_pts', 'status'])
    B = B[B.status.eq('FINAL') & B.side.notna() & B.line.notna() & B.close_margin.notna()]
    r = [truth(s, l, m, c) for s, l, m, c in zip(B.side, B.line, B.margin, B.close_margin)]
    assert np.array_equal(B.bet_result.values, np.array([x[0] for x in r], dtype=float))
    assert np.allclose(B.clv_pts.values, np.array([x[1] for x in r], dtype=float))
    return 'n=%d' % len(B)


def main():
    import argparse
    import json
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', default=None, help='also write the results as JSON here')
    a = ap.parse_args()
    fail = 0
    res = {}
    for fn in RESULTS:
        try:
            r = fn()
            res[fn.__name__] = {'ok': True, 'detail': r if isinstance(r, str) else None}
            print('ok   ' + fn.__name__ + ('  [%s]' % r if isinstance(r, str) else ''))
        except Exception:
            fail += 1
            res[fn.__name__] = {'ok': False, 'detail': None}
            print('FAIL ' + fn.__name__)
            traceback.print_exc()
    print('%d/%d passed' % (len(RESULTS) - fail, len(RESULTS)))
    if a.report:
        with open(a.report, 'w') as fh:
            json.dump({'passed': len(RESULTS) - fail, 'total': len(RESULTS), 'scenarios': [x[0] for x in SCEN],
                       'tests': res}, fh, indent=1, sort_keys=True)
            fh.write('\n')
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
