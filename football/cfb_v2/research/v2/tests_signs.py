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


# ------------------------------------------------ market orientation (F-11)
def _v1_builder():
    """V1's market builder (football/cfb_p4/research/build_market.py), imported, not run."""
    v1r = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'cfb_p4', 'research'))
    os.environ.setdefault('CFB_P4_DATA', os.path.join(C.DATA, 'v1'))
    if v1r not in sys.path:
        sys.path.insert(0, v1r)
    import build_market as BM                           # noqa: E402
    return BM


@test
def book_sign_rule_drops_the_contradicting_book():
    BM = _v1_builder()
    # three books agree the home team is favoured, one lists the opposite sign (intertops 2014)
    assert BM.sign_rule([7.0, 7.5, 6.5, -7.0]) == [None, None, None, 'dropped']
    # a book 2.5 on the other side of pick'em is an ordinary disagreement: kept
    assert BM.sign_rule([1.5, 1.0, -2.5]) == [None, None, None]
    # ESPN Bet opener 2024 (Michigan at Washington): +3, +2.5 vs -8.5 -> the -8.5 is dropped
    assert BM.sign_rule([3.0, -8.5, 2.5]) == [None, 'dropped', None]
    # two books, one each side, both >= 3: nothing to decide by -> the field is unresolved
    assert BM.sign_rule([6.0, -3.0]) == ['unresolved', 'unresolved']
    # a genuine pick'em split is not unresolved
    assert BM.sign_rule([0.5, -0.5]) == [None, None]
    assert BM.sign_rule([np.nan, 7.0, -7.0, 6.0]) == [None, None, 'dropped', None]


def _archive(rows):
    return pd.DataFrame([dict(zip(('game_id', 'market_type', 'abbr', 'home_team_id', 'away_team_id', 'book', 'lines',
                                   'opening_lines'), r)) for r in rows])


@test
def orientation_by_team_id_fixes_swapped_ids_and_ambiguous_abbreviations():
    BM = _v1_builder()
    rows = []
    # the ARMY abbreviation is seen in many games; LAF only ever against Army (both ids equally often)
    for g in range(10):
        rows += [(100 + g, 'spread', 'ARM', 349.0, 900.0 + g, 'B', -10.0, -10.0),
                 (100 + g, 'spread', 'OPP%d' % g, 349.0, 900.0 + g, 'B', 10.0, 10.0)]
    rows += [(1, 'spread', 'ARM', 349.0, 322.0, 'B', -33.5, -33.0), (1, 'spread', 'LAF', 349.0, 322.0, 'B', 33.5, 33.0)]
    # NAVY at ARMY in the schedule; the archive lists the ids the other way round (Army-Navy 2021)
    for g in range(10):
        rows += [(200 + g, 'spread', 'NAV', 2426.0, 800.0 + g, 'B', -3.0, -3.0),
                 (200 + g, 'spread', 'X%d' % g, 2426.0, 800.0 + g, 'B', 3.0, 3.0)]
    rows += [(2, 'spread', 'ARM', 2426.0, 349.0, 'B', 7.0, 8.5), (2, 'spread', 'NAV', 2426.0, 349.0, 'B', -7.0, -8.5)]
    # a stray abbreviation of another game filed under game 1 (Ball State-Colgate rows in UMass-BC 2014)
    for g in range(10):
        rows += [(300 + g, 'spread', 'BALL', 2050.0, 700.0 + g, 'B', -20.0, -20.0)]
    rows += [(1, 'spread', 'BALL', 349.0, 322.0, 'B', -28.5, -25.5)]
    L = _archive(rows)
    sched = {1: (349, 322), 2: (349, 2426)}
    assign, OG = BM.orient_sides(L, sched)
    og = OG.set_index('game_id')
    assert assign[(1, 'ARM')] == 'home' and assign[(1, 'LAF')] == 'away', 'both sides resolved to the home team'
    assert assign[(1, 'BALL')] is None, 'a stray abbreviation of another game was used'
    assert og.loc[1, 'side_resolution'] == 'elimination'
    # archive ids swapped vs the schedule: the side labels are unreliable, the lines are not used
    assert assign[(2, 'ARM')] is None and assign[(2, 'NAV')] is None
    assert bool(og.loc[2, 'archive_ids_swapped']) and og.loc[2, 'side_resolution'] == 'archive_ids_swapped'
    assert not bool(og.loc[1, 'archive_ids_swapped'])
    S = BM._side_frame(L, BM.resolve_abbr_sides(L), sched)
    h = S[S.game_id.isin([1, 2]) & S.is_home.eq(True)].set_index('game_id')
    assert -h.loc[1, 'lines'] == 33.5 and 2 not in h.index, h[['abbr', 'lines']]


@test
def stage2_orients_the_archive_against_its_own_schedule():
    G = pd.DataFrame({'game_id': [1, 2, 3], 'home_id': [10, 20, 30], 'away_id': [11, 21, 31]})
    M = pd.DataFrame({'game_id': [1, 2, 3], 'spread_open': [7.0, 7.0, 7.0], 'spread_close': [8.0, 8.0, 8.0],
                      'spread_close_pin': [8.0, 8.0, 8.0], 'spread_open_pin': [7.0, 7.0, 7.0],
                      'total_open': [50.0] * 3, 'total_close': [51.0] * 3,
                      'orient_home_id': [10.0, 21.0, 99.0], 'orient_away_id': [11.0, 20.0, 98.0],
                      'source': ['cfbfastR_multibook_archive'] * 3})
    O = GM.orient_by_team_id(M.copy(), G).set_index('game_id')
    assert O.loc[1, 'spread_close'] == 8.0 and not O.loc[1, 'market_reoriented']
    assert O.loc[2, 'spread_close'] == -8.0 and O.loc[2, 'spread_open'] == -7.0 and O.loc[2, 'market_reoriented']
    assert O.loc[2, 'total_close'] == 51.0, 'a total has no side'
    assert np.isnan(O.loc[3, 'spread_close']) and bool(O.loc[3, '_team_mismatch'])


@test
def data_archive_orientation_named_games():
    """[data] On the corrected V1 market table: the audit's named games carry the right sign."""
    f = os.environ.get('CFB_V2_V1_MARKET', '')
    if not f or not os.path.exists(f):
        return 'skipped (no CFB_V2_V1_MARKET)'
    M = pd.read_csv(f, low_memory=False).set_index('game_id')
    if 'market_orientation_rule' not in M:
        return 'skipped (archive built before the F-11 fix)'
    # Army-Navy 2021: archive ids swapped, books contradict each other -> no spread, flagged, total kept
    an = M.loc[401301056]
    assert np.isnan(an.spread_close) and np.isnan(an.spread_open) and bool(an.archive_ids_swapped), an
    assert an.total_close == 35.5
    sw = M[M.archive_ids_swapped.fillna(False).astype(bool)]
    assert sw.spread_close.isna().all() and sw.spread_open.isna().all()
    # Army-Lafayette 2016: Army laid 33.5, not a pick'em
    assert M.loc[400868915, 'spread_close'] > 30
    # UMass-Boston College 2014 (BC -17; stray Ball State-Colgate rows under the same id)
    assert M.loc[400547728, 'spread_close'] == -17.0
    return '%d swapped-id games without a spread; Army-Lafayette 2016 close %+.1f' % (
        len(sw), M.loc[400868915, 'spread_close'])


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
