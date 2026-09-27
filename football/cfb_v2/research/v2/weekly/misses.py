"""Miss classification (weekly brief §42): for each graded game whose pure
projection missed by MISS_PTS or more, decompose the miss with postgame DATA
and name its probable driver. No narrative is ground truth; an LLM never
labels a miss.

The decomposition (home orientation; error = actual - projected):

    error = performance_gap + scoreboard_gap
    performance_gap = expected_performance_margin - projected
        how differently the teams actually PLAYED (non-garbage EPA, success,
        drive efficiency, havoc, explosives, field position: perf.py's
        expected margin) from what EdgeDesk projected
    scoreboard_gap  = actual - expected_performance_margin
        how far the scoreboard strayed from how they played; its measured
        parts are turnover luck (recoveries and INTs against expectation, in
        points), special teams (net EPA) and return touchdowns

Drivers, primary first (the component with the largest share of the error, in
the error's direction), each with its number:

    TURNOVER_LUCK        |turnover luck| is the largest scoreboard part
    SPECIAL_TEAMS        |special-teams net EPA| is
    SCOREBOARD_OTHER     the rest of the scoreboard gap (red-zone / finishing
                         variance, late scores the expected margin misses)
    QB_CHANGE            the performance gap, and a QB change event in this
                         game (new starter, benching, injured starter)
    PERSONNEL            the performance gap, and an official report listed
                         two or more starters' units OUT before kickoff
    EXPLOSIVE_VARIANCE   the performance gap, and explosive-play execution
                         far from the teams' norm
    TEAM_PERFORMANCE     the performance gap, no measured cause
    PACE                 (secondary only) a play count far from expected
    UNEXPLAINED          no play-by-play (FCS, a partial feed)

Thresholds are declared below; the classification is descriptive (it feeds
the report and the research queue) and never changes a model.
"""
import numpy as np
import pandas as pd

from . import ids

RULE = 'cfb_miss_classification_v1'
MISS_PTS = 14.0            # |actual - projected| at or beyond this is a miss (about 0.9 sigma)
TURNOVER_MIN_PTS = 4.0     # a turnover-luck part smaller than one turnover's worth never leads
ST_MIN_PTS = 4.0
EXPLOSIVE_Z = 1.5          # explosive execution this far (in SD) from the league norm
PACE_REL = 0.20            # plays 20% above/below the teams' expected plays
PERSONNEL_OUT_MIN = 2      # reported OUT players (starter units) to call PERSONNEL


def _num(x):
    try:
        v = float(x)
        return v if np.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def classify_game(proj, home_perf, away_perf, qb_events=(), outs=None, exp_plays=None, expl_sd=None):
    """proj: {'game_id', 'ens_pred' (home margin), ...}; home_perf/away_perf: perf rows (dict-like) or None;
    qb_events: this game's QB change events; outs: {'home': n, 'away': n} reported OUT starters;
    exp_plays: expected combined plays; expl_sd: league SD of explosive_execution."""
    p = _num(proj.get('ens_pred'))
    hp = home_perf or {}
    actual = _num(hp.get('margin'))
    out = {'game_id': str(proj.get('game_id')), 'rule_version': RULE, 'projected_margin': p, 'actual_margin': actual}
    if p is None or actual is None:
        return None
    err = actual - p
    out['error'] = round(err, 2)
    if abs(err) < MISS_PTS:
        return None
    epm = _num(hp.get('expected_performance_margin'))
    if epm is None or not hp.get('has_pbp', True):
        out.update(primary_driver='UNEXPLAINED', drivers=[], evidence={'note': 'no expected performance margin (no or partial play-by-play)'})
        return out
    perf_gap, score_gap = epm - p, actual - epm
    to_h, to_a = _num(hp.get('turnover_luck_game')) or 0.0, _num((away_perf or {}).get('turnover_luck_game')) or 0.0
    to_luck = to_h - to_a                     # points of home turnover luck net of the away team's
    st = _num(hp.get('st_net_epa')) or 0.0
    rtd = ((_num(hp.get('return_tds')) or 0) - (_num((away_perf or {}).get('return_tds')) or 0)) * 7.0
    other = score_gap - to_luck - st
    sgn = np.sign(err)
    parts = {'TURNOVER_LUCK': to_luck, 'SPECIAL_TEAMS': st, 'SCOREBOARD_OTHER': other}
    # the performance gap gets a cause from the evidence, if any
    perf_label, perf_evidence = 'TEAM_PERFORMANCE', {}
    types = sorted({e.get('event_type') or e.get('type') for e in qb_events or []} - {None})
    if types and any(t in ('NEW_STARTER', 'BENCHING', 'INJURED_STARTER', 'TRANSFER_STARTER', 'RETURNING_STARTER') for t in types):
        perf_label, perf_evidence = 'QB_CHANGE', {'qb_events': types}
    elif outs and max(outs.get('home') or 0, outs.get('away') or 0) >= PERSONNEL_OUT_MIN:
        perf_label, perf_evidence = 'PERSONNEL', {'reported_out': outs}
    else:
        ex_h, ex_a = _num(hp.get('explosive_execution')), _num((away_perf or {}).get('explosive_execution'))
        if expl_sd and ex_h is not None and ex_a is not None and abs(ex_h - ex_a) / expl_sd >= EXPLOSIVE_Z:
            perf_label, perf_evidence = 'EXPLOSIVE_VARIANCE', {'explosive_execution_diff_sd': round((ex_h - ex_a) / expl_sd, 2)}
    parts[perf_label] = perf_gap
    # rank the parts that push in the error's direction by size (tiny turnover/ST parts never lead)
    def eligible(k, v):
        if np.sign(v) != sgn:
            return False
        return not ((k == 'TURNOVER_LUCK' and abs(v) < TURNOVER_MIN_PTS) or (k == 'SPECIAL_TEAMS' and abs(v) < ST_MIN_PTS))
    ranked = sorted(((k, v) for k, v in parts.items() if eligible(k, v)), key=lambda kv: -abs(kv[1]))
    drivers = [k for k, _ in ranked]
    plays = (_num(hp.get('pace_plays')) or 0) + (_num((away_perf or {}).get('pace_plays')) or 0)
    if exp_plays and plays and abs(plays / exp_plays - 1) >= PACE_REL:
        drivers.append('PACE')
    out.update(primary_driver=drivers[0] if drivers else 'SCOREBOARD_OTHER', drivers=drivers,
               performance_gap=round(perf_gap, 2), scoreboard_gap=round(score_gap, 2),
               expected_performance_margin=round(epm, 2),
               components={k: round(v, 2) for k, v in parts.items()},
               evidence=dict(perf_evidence, return_td_pts=rtd, plays=plays or None,
                             expected_plays=round(exp_plays, 1) if exp_plays else None))
    out['miss_id'] = 'cfbx_' + ids.h('miss', out['game_id'], p, RULE)
    return out


def classify_week(projections, perf, qb_events=None, units=None, team_rows=None):
    """projections: the source week's frozen projection records (store 'projections');
    perf: perf.game_performance rows; qb_events: this season's QB events (list of dicts);
    units: availability.snapshot rows (for reported OUTs); team_rows: team state (exp_plays)."""
    if perf is None or not len(perf):
        return []
    P = perf.copy()
    P['game_id'] = P.game_id.astype(str)
    sd = float(P.explosive_execution.std()) if 'explosive_execution' in P and P.explosive_execution.notna().sum() > 30 else None
    by = {(g, ha): r for (g, ha), r in zip(zip(P.game_id, P.home_away), P.to_dict('records'))}
    ev_by_game = {}
    for e in qb_events or []:
        ev_by_game.setdefault(str(e.get('game_id')), []).append(e)
    outs = {}
    if units is not None and len(units):
        U = units[units.unit.ne('ST')]
        for (g, t), x in U.groupby([U.game_id.astype(str), U.team_id.astype(str)]):
            outs.setdefault(g, {})[t] = int(np.nansum(x.reported_out.astype(float)))
    plays = {}
    if team_rows is not None and len(team_rows) and 'exp_plays' in team_rows:
        plays = {str(t): _num(v) for t, v in zip(team_rows.team_id, team_rows.exp_plays)}
    out = []
    for pr in projections:
        g = str(pr.get('game_id'))
        h, a = by.get((g, 'home')), by.get((g, 'away'))
        if h is None:
            continue
        o = outs.get(g, {})
        ep = None
        if plays:
            hp_, ap_ = plays.get(str(h.get('team_id'))), plays.get(str(h.get('opp_id')))
            ep = (hp_ + ap_) / 2.0 * 2 if hp_ and ap_ else None      # exp_plays is per team: both teams' snaps
        c = classify_game(pr, h, a, ev_by_game.get(g, []),
                          {'home': o.get(str(h.get('team_id'))), 'away': o.get(str(h.get('opp_id')))} if o else None,
                          ep, sd)
        if c:
            out.append(ids.clean(c))
    return out


def summary(misses):
    """Driver counts and mean error by driver: the report's table and the research queue's input."""
    rows = {}
    for m in misses:
        d = m.get('primary_driver')
        r = rows.setdefault(d, {'n': 0, 'errors': []})
        r['n'] += 1
        r['errors'].append(m.get('error'))
    return {d: {'n': r['n'], 'mean_abs_error': round(float(np.mean(np.abs(r['errors']))), 2)} for d, r in sorted(rows.items())}
