"""QB week state and QB change detection (docs/cfb-weekly/DESIGN.md, METHODS_STATE.md).

    qb_rows, events = build(season, T)

Everything is point-in-time: only games that kicked off before T (the Tuesday
12:00 UTC freeze) are read. The QB value model is V2's (v2/qb.py), reused and
never re-tuned: a passer's rating is his dropback-weighted, season-decayed,
opponent-adjusted EPA per dropback shrunk toward the replacement mean by
k ~ 150.6 dropbacks (qb.estimate_shrinkage on 2009-2013, exactly as qb.main).

What this module adds on top of V2's team features:
  * per-QB rows (V2 keeps one row per team);
  * a posterior SD from the same conjugate model: var = s2 / (n_eff + k),
    s2 = the per-dropback noise variance (qb_shrinkage noise_per_game_db);
  * a calibrated starter probability (STARTER_TABLE, fitted on the DEV
    seasons, checked on a held-out dev season by tests_state);
  * rushing, explosive-pass and turnover proxies computed from play-by-play
    (stage 1 does not keep them);
  * QB change events: NEW_STARTER, RETURNING_STARTER, INJURED_STARTER (inferred),
    BENCHING, TRANSFER_STARTER, MULTI_QB_ROTATION, AMBIGUOUS_STARTER.
A QB change never rewrites the team's offensive MEAN; `lineup()` reports the
extra offensive variance (the variance of the QB posterior difference) that
team_state adds to the offence SD.
"""
import os

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from .. import qb as QB
from . import ids

RULE_VERSION = 'cfb_qb_state_v1'

# ------------------------------------------------------------ declared rules
BENCH_SHARE = 0.40          # a reliever with >= 40% of the game's non-garbage dropbacks = benching
ROTATION_SHARE = 0.30       # >= 2 QBs each with >= 30% of the dropbacks over the last 3 games
AMBIGUOUS_P = 0.60          # expected starter below this starter probability -> review flag
MIN_QB_DROPBACKS = 10       # a passer is a QB row if he started, or has >= 10 dropbacks,
MIN_QB_SHARE = 0.05         # or >= 5% of the team's season dropbacks (else: a trick-play passer)
STABILIZE_MIN, STABILIZE_MAX = 3, 5   # QB_STABILIZING: 3-5 straight starts after a change
SHRINK_SEASONS = (2009, 2010, 2011, 2012, 2013)     # as qb.main
SAME_STARTER_SEASONS = (2012, 2013, 2014, 2015)     # as qb.main

# ------------------------------------------------------ starter probability
# P(the starter of the team's latest game starts its next game), by
#   n_last  = games in the window (the team's last min(3, games so far) games),
#   k       = how many of those the latest starter started (1..n_last),
#   benched = he was replaced in the latest game by a QB who took >= 40% of
#             its non-garbage dropbacks (BENCH_SHARE).
# Fitted by fit_starter_table() on the DEV seasons 2016-2023 (11,631 team-game
# transitions; every cell shrunk toward its benched / not-benched group rate
# with EB_M = 20 pseudo-transitions). The same function fitted on 2016-2022
# is calibrated on held-out 2023 (tests_state: calibration). Re-derive with
#   python3 -c "from v2.weekly import qb_state as Q; print(Q.fit_starter_table(Q.transitions(range(2016, 2024))))"
EB_M = 20.0
STARTER_FIT_SEASONS = tuple(range(2016, 2024))
STARTER_TABLE = {
    # (n_last, k, benched): (probability, transitions)
    (1, 1, False): (0.9055, 1092), (1, 1, True): (0.2716, 93),
    (2, 1, False): (0.8366, 115), (2, 1, True): (0.3021, 22),
    (2, 2, False): (0.9202, 870), (2, 2, True): (0.3125, 43),
    (3, 1, False): (0.7154, 862), (3, 1, True): (0.1427, 146),
    (3, 2, False): (0.8402, 1094), (3, 2, True): (0.2835, 120),
    (3, 3, False): (0.9272, 6793), (3, 3, True): (0.3409, 381),
}
# group rates the cells shrink toward: not benched 0.8974, benched 0.2845
# In-season level: starter continuity drifts by season (DEV: 0.879 of transitions
# kept the starter in 2016, 0.828 in 2023), so the cell probabilities are
# shifted on the logit scale by one season-level delta, estimated at T from the
# CURRENT season's transitions already resolved before T (point-in-time),
# with a N(0, LEVEL_SD^2) prior. LEVEL_SD chosen by walk-forward log loss on
# DEV 2019-2023 over {none, 0.1, 0.2, 0.3, 0.5} (METHODS_STATE.md).
LEVEL_SD = 0.1
# When the latest starter does NOT start the next game, who does (DEV 2016-2023):
# the team's top backup by season non-garbage dropbacks, another QB who has
# played this season, or a QB with no snaps this season (unlisted).
CHANGE_SPLIT = {'top_backup': 0.6829, 'other_seen': 0.2021, 'unseen': 0.115}

_CACHE = {}


# ================================================================ loading
def _load(season):
    key = ('Q', season, C.OUT)
    if key not in _CACHE:
        Q, G = QB.load(list(range(C.FIRST_PBP_SEASON, season + 1)))
        _CACHE[key] = (Q, G)
    return _CACHE[key]


def _shrinkage():
    """V2's QB shrinkage, recomputed exactly as qb.main does (never re-tuned)."""
    key = ('shrink', C.OUT)
    if key not in _CACHE:
        Q, _ = QB.load(list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1)))
        Apast = QB.opponent_adjust_past(Q)
        shrink = QB.estimate_shrinkage(Apast, list(SHRINK_SEASONS))
        shrink['same_starter_prob'] = QB.same_starter_rate(Q, list(SAME_STARTER_SEASONS))
        _CACHE[key] = (Apast, shrink)
    return _CACHE[key]


def _b(s):
    return s.fillna(False).astype(bool)


def pbp_qb_stats(season):
    """Per (game, team, player) passing/rushing/turnover counts from play-by-play,
    with stage 1's play filter and garbage-time weight (non-garbage counts)."""
    key = ('pbp', season, C.DATA)
    if key in _CACHE:
        return _CACHE[key]
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % season)
    if not os.path.exists(f):
        _CACHE[key] = None
        return None
    import pyarrow.parquet as pq
    want = ['game_id', 'pos_team_id', 'def_pos_team_id', 'passer_player_id', 'rusher_player_id',
            'fumble_player_id', 'rush', 'pass', 'sack', 'int', 'fumble_lost', 'EPA', 'EPA_explosive',
            'penalty_no_play', 'text_dupe', 'period', 'start.pos_score_diff', 'passer_player_name']
    names = set(pq.ParquetFile(f).schema_arrow.names)
    d = pd.read_parquet(f, columns=[c for c in want if c in names])
    for c in want:
        if c not in d.columns:
            d[c] = np.nan
    d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()].copy()
    d['pos_team_id'] = d.pos_team_id.astype('int64')
    d = d[~_b(d.text_dupe)]
    d['garbage'] = common.garbage_mask(d.period.fillna(1).astype(int).values,
                                       d['start.pos_score_diff'].fillna(0).values)
    scrim = (_b(d.rush) | _b(d['pass'])) & ~_b(d.penalty_no_play) & d.EPA.notna()
    s = d[scrim].copy()
    s['w'] = np.where(s.garbage, 0.0, 1.0)
    s['is_pass'] = _b(s['pass'])
    s['is_rush'] = _b(s.rush)
    s['pid'] = pd.to_numeric(s.passer_player_id, errors='coerce')
    s['rid'] = pd.to_numeric(s.rusher_player_id, errors='coerce')
    s['fid'] = pd.to_numeric(s.fumble_player_id, errors='coerce')
    p = s[s.is_pass & s.pid.notna()]
    kp = [p.game_id, p.pos_team_id, p.pid.astype('int64')]
    P = pd.DataFrame({
        'db_pbp': p.groupby(kp).size(),
        'db_ng_pbp': p.w.groupby(kp).sum(),
        'expl_pass_ng': (p.w * _b(p.EPA_explosive)).groupby(kp).sum(),
        'int_ng': (p.w * _b(p['int'])).groupby(kp).sum(),
        # a lost fumble on a pass/sack play with no fumbler id is attributed to
        # the passer only when it is a sack (the passer holds the ball)
        'fum_pass_ng': (p.w * (_b(p.fumble_lost) & ((p.fid == p.pid) |
                                                     (p.fid.isna() & _b(p.sack))))).groupby(kp).sum(),
    })
    r = s[s.is_rush & s.rid.notna()]
    kr = [r.game_id, r.pos_team_id, r.rid.astype('int64')]
    Rr = pd.DataFrame({
        'rush_ng': r.w.groupby(kr).sum(),
        'rush_epa_ng': (r.w * r.EPA).groupby(kr).sum(),
        'fum_rush_ng': (r.w * (_b(r.fumble_lost) & (r.fid.isna() | (r.fid == r.rid)))).groupby(kr).sum(),
    })
    P.index = P.index.set_names(['game_id', 'team_id', 'qb_id'])
    Rr.index = Rr.index.set_names(['game_id', 'team_id', 'qb_id'])
    out = P.join(Rr, how='outer').fillna(0.0).reset_index()
    nm = p.dropna(subset=['passer_player_name']).groupby(p.pid.astype('int64')) \
        .passer_player_name.agg(lambda x: x.value_counts().index[0]) if len(p) else pd.Series(dtype=str)
    _CACHE[('names', season, C.DATA)] = nm.to_dict()     # kept out of DataFrame.attrs (deep-copied by pandas)
    _CACHE[key] = out
    return out


# ======================================================= game-level facts
def team_games(rows):
    """One row per team-game from per-QB rows of ONE team (sorted by kickoff):
    starter, non-garbage dropbacks per QB, benching."""
    cols = ['game_id', 'kickoff_ts', 'qb_id', 'db', 'db_ng', 'first_play', 'starter']
    if 'prediction_ts' in rows:
        cols.append('prediction_ts')
    recs = rows[cols].sort_values(['kickoff_ts', 'game_id', 'first_play']).to_dict('records')
    by = {}
    order = []
    for r in recs:
        if r['game_id'] not in by:
            by[r['game_id']] = []
            order.append(r['game_id'])
        by[r['game_id']].append(r)
    out = []
    for gid in order:
        g = by[gid]
        st = [r for r in g if r['starter']]
        starter = int(st[0]['qb_id']) if st else int(min(g, key=lambda r: r['first_play'])['qb_id'])
        dbng, db = {}, {}
        for r in g:
            q = int(r['qb_id'])
            dbng[q] = dbng.get(q, 0.0) + float(r['db_ng'])
            db[q] = db.get(q, 0.0) + float(r['db'])
        tot = sum(dbng.values())
        others = {q: v for q, v in dbng.items() if q != starter}
        reliever, share = None, 0.0
        if others and tot > 0:
            reliever = max(sorted(others), key=lambda q: others[q])
            share = others[reliever] / tot
        benched = bool(db.get(starter, 0.0) >= 1 and tot > 0 and share >= BENCH_SHARE)
        out.append({'game_id': gid, 'kickoff_ts': g[0]['kickoff_ts'], 'prediction_ts': g[0].get('prediction_ts'),
                    'starter': starter,
                    'db_ng': dbng, 'db_ng_total': tot, 'benched': benched,
                    'reliever': reliever if benched else None, 'reliever_share': share,
                    'played': set(dbng)})
    return out


def window_state(games):
    """(latest starter, n_last, k, benched) for a list of team_games()."""
    if not games:
        return None, 0, 0, False
    last = games[-1]
    win = games[-3:]
    k = sum(1 for g in win if g['starter'] == last['starter'])
    return last['starter'], len(win), k, bool(last['benched'])


# ================================================= starter probability fit
def transitions(seasons):
    """Every consecutive team-game pair of the given seasons (see transitions_from)."""
    seasons = list(seasons)
    Q, _ = _load(max(seasons))
    return transitions_from(Q[Q.g_season.isin(seasons)])


def transitions_from(Q):
    """The window state after each team game and whether its starter started
    the team's next game (and, if not, who), with the next game's kickoff and
    freeze (next_T) so a transition can be used only once it is resolved."""
    rows = []
    for (S, t), q in Q.groupby(['g_season', 'team_id']):
        games = team_games(q)
        for i in range(1, len(games)):
            sL, n_last, k, benched = window_state(games[:i])
            nxt = games[i]['starter']
            seen = {}
            for g in games[:i]:
                for qq, v in g['db_ng'].items():
                    seen[qq] = seen.get(qq, 0.0) + v
            seen.pop(sL, None)
            order = sorted(seen, key=lambda x: (-seen[x], x))
            who = 'same' if nxt == sL else ('top_backup' if order and nxt == order[0]
                                            else ('other_seen' if nxt in seen else 'unseen'))
            rows.append((S, t, i, n_last, k, benched, nxt == sL, who, games[i]['kickoff_ts'],
                         games[i]['prediction_ts']))
    return pd.DataFrame(rows, columns=['season', 'team_id', 'game_index', 'n_last', 'k', 'benched',
                                       'same', 'who', 'next_kickoff', 'next_T'])


def _logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def level_shift(resolved, table=None, sd=LEVEL_SD):
    """Season-level logit shift of the starter table: the MAP of delta in
    logit(p) = logit(p_cell) + delta over already-resolved transitions of the
    current season, with a N(0, sd^2) prior (0 when there are none)."""
    if resolved is None or not len(resolved) or not sd:
        return 0.0
    z0 = np.array([_logit(starter_probability(a, b, c, table))
                   for a, b, c in zip(resolved.n_last, resolved.k, resolved.benched)])
    y = resolved.same.values.astype(float)
    d = 0.0
    for _ in range(50):
        p = 1.0 / (1.0 + np.exp(-(z0 + d)))
        g = float(np.sum(y - p)) - d / sd ** 2
        h = -float(np.sum(p * (1 - p))) - 1.0 / sd ** 2
        step = g / h
        d -= step
        if abs(step) < 1e-12:
            break
    return float(d)


def fit_starter_table(tr, m=EB_M):
    """Cell rates shrunk toward the benched / not-benched group rate."""
    table = {}
    grp = tr.groupby('benched').same.mean()
    for (n_last, k, b), g in tr.groupby(['n_last', 'k', 'benched']):
        p = (g.same.sum() + m * grp[b]) / (len(g) + m)
        table[(int(n_last), int(k), bool(b))] = (round(float(p), 4), int(len(g)))
    ch = tr[~tr.same].who.value_counts(normalize=True)
    split = {w: round(float(ch.get(w, 0.0)), 4) for w in ('top_backup', 'other_seen', 'unseen')}
    return {'table': table, 'change_split': split, 'group': {bool(k): float(v) for k, v in grp.items()},
            'n': int(len(tr)), 'seasons': sorted(int(s) for s in tr.season.unique())}


def calibration_report(tr, fit_seasons, test_season, sd=LEVEL_SD):
    """Held-out calibration of the starter probability: the table fitted on
    `fit_seasons`, applied to `test_season` exactly as build() would (at each
    freeze, the level shift from that season's transitions resolved before it)."""
    fit = fit_starter_table(tr[tr.season.isin(list(fit_seasons))])['table']
    ho = tr[tr.season.eq(test_season)].copy()
    p = np.empty(len(ho))
    for T, idx in ho.groupby('next_T').groups.items():
        res = ho[ho.next_kickoff < T]
        d = level_shift(res, fit, sd) if sd else 0.0
        sel = ho.index.get_indexer(idx)
        p[sel] = [starter_probability(a, b, c, fit, d) for a, b, c in
                  zip(ho.loc[idx, 'n_last'], ho.loc[idx, 'k'], ho.loc[idx, 'benched'])]
    ho['p'] = p
    y = ho.same.astype(float).values
    bins = pd.cut(ho.p, [0, .2, .4, .6, .7, .8, .85, .9, .95, 1.0])
    ece = float(sum(len(g) * abs(g.same.mean() - g.p.mean()) for _, g in ho.groupby(bins, observed=True)) / len(ho))
    # logistic recalibration y ~ a + b logit(p): calibration slope b (1 = calibrated)
    z = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    X = np.column_stack([np.ones_like(z), z])
    beta = np.zeros(2)
    for _ in range(50):
        q = 1 / (1 + np.exp(-X @ beta))
        Hm = X.T @ (X * (q * (1 - q))[:, None])
        step = np.linalg.solve(Hm, X.T @ (y - q))
        beta += step
        if np.max(np.abs(step)) < 1e-12:
            break
    se_b = float(np.sqrt(np.linalg.inv(Hm)[1, 1]))
    cells = []
    for key, g in ho.groupby(['n_last', 'k', 'benched']):
        pm = g.p.mean()
        cells.append({'cell': key, 'n': int(len(g)), 'observed': float(g.same.mean()), 'predicted': float(pm),
                      'z': float((g.same.mean() - pm) / np.sqrt(pm * (1 - pm) / len(g)))})
    base = float(tr[tr.season.isin(list(fit_seasons))].same.mean())
    return {'test_season': int(test_season), 'n': int(len(ho)), 'level_sd': sd, 'ece': ece,
            'mean_predicted': float(p.mean()), 'mean_observed': float(y.mean()),
            'in_the_large_z': float((y.sum() - p.sum()) / np.sqrt(np.sum(p * (1 - p)))),
            'slope': float(beta[1]), 'slope_se': se_b,
            'brier': float(np.mean((p - y) ** 2)), 'brier_constant': float(np.mean((base - y) ** 2)),
            'log_loss': float(-np.mean(y * np.log(np.clip(p, 1e-9, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-9, 1)))),
            'cells': cells}


def starter_probability(n_last, k, benched, table=None, delta=0.0):
    """Calibrated P(the latest starter starts the next game): the table cell,
    shifted by the season level `delta` on the logit scale."""
    tab = table if table is not None else STARTER_TABLE
    if n_last <= 0:
        return None
    key = (int(min(n_last, 3)), int(max(1, min(k, n_last, 3))), bool(benched))
    if key in tab:
        v = tab[key]
        p = float(v[0] if isinstance(v, tuple) else v)
    else:
        # an unseen cell: the group rate of its benched flag
        same = [v[0] if isinstance(v, tuple) else v for kk, v in tab.items() if kk[2] == bool(benched)]
        if not same:
            return None
        p = float(np.mean(same))
    if delta:
        p = 1.0 / (1.0 + np.exp(-(_logit(p) + delta)))
    return p


# ========================================================= change events
def detect(rows, career, team_id, T=None, table=None, split=None, delta=0.0):
    """QB state of ONE team from its current-season per-QB rows before T.

    rows    [game_id, kickoff_ts, qb_id, db, db_ng, first_play, starter] (this team,
            this season, kicked off before T)
    career  [qb_id, team_id, game_id, kickoff_ts] every start before T (any team/season)
    Returns {'expected_qb', 'starter_probability', 'probabilities' {qb: p},
             'p_unlisted', 'n_last', 'k', 'benched_latest', 'streak', 'events': [...]}"""
    split = split if split is not None else CHANGE_SPLIT
    games = team_games(rows)
    out = {'expected_qb': None, 'starter_probability': None, 'probabilities': {}, 'p_unlisted': None,
           'n_last': 0, 'k': 0, 'benched_latest': False, 'streak': 0, 'stabilizing': False,
           'events': [], 'games': games}
    if not games:
        return out
    sL, n_last, k, benched = window_state(games)
    p = starter_probability(n_last, k, benched, table, delta)
    last = games[-1]
    out.update(expected_qb=sL, starter_probability=p, n_last=n_last, k=k, benched_latest=benched)
    # the complement: the top backup (by season non-garbage dropbacks), other seen QBs, unseen
    seen = {}
    for g in games:
        for q, v in g['db_ng'].items():
            seen[q] = seen.get(q, 0.0) + v
    others = sorted([q for q in seen if q != sL], key=lambda x: (-seen[x], x))
    probs = {sL: p}
    rest = 1.0 - p if p is not None else None
    if rest is not None:
        f_top, f_oth, f_un = split.get('top_backup', 0.0), split.get('other_seen', 0.0), split.get('unseen', 0.0)
        if not others:
            out['p_unlisted'] = rest
        else:
            probs[others[0]] = rest * (f_top + (0.0 if len(others) > 1 else f_oth))
            if len(others) > 1:
                for q in others[1:]:
                    probs[q] = rest * f_oth / (len(others) - 1)
            out['p_unlisted'] = rest * f_un
    out['probabilities'] = probs
    # consecutive starts ending at the latest game
    streak = 0
    for g in reversed(games):
        if g['starter'] != sL:
            break
        streak += 1
    out['streak'] = streak
    # QB_STABILIZING (descriptive): 3-5 straight starts after another QB started earlier this season
    out['stabilizing'] = bool(STABILIZE_MIN <= streak <= STABILIZE_MAX and len(games) > streak
                              and not benched)

    ev = []

    def add(kind, qb_id, inferred=False, **detail):
        ev.append({'type': kind, 'team_id': int(team_id), 'qb_id': None if qb_id is None else int(qb_id),
                   'game_id': int(last['game_id']), 'kickoff_ts': last['kickoff_ts'],
                   'inferred': bool(inferred), 'detail': detail})

    car = career[career.kickoff_ts < last['kickoff_ts']]
    mine = car[car.qb_id.eq(sL)]
    if not (mine.team_id == team_id).any():
        add('NEW_STARTER', sL, career_starts_elsewhere=int((mine.team_id != team_id).sum()))
        if (mine.team_id != team_id).any():
            prev = mine.sort_values('kickoff_ts').iloc[-1]
            add('TRANSFER_STARTER', sL, previous_team_id=int(prev.team_id),
                previous_team_starts=int((mine.team_id == prev.team_id).sum()),
                other_team_starts=int((mine.team_id != team_id).sum()))
    if len(games) >= 2:
        prevg = games[-2]
        earlier = [i for i, g in enumerate(games[:-1]) if g['starter'] == sL]
        if earlier and prevg['starter'] != sL:
            add('RETURNING_STARTER', sL, games_missed=int(len(games) - 2 - earlier[-1]),
                last_start_game_id=int(games[earlier[-1]]['game_id']))
        s_prev = prevg['starter']
        if s_prev != sL and s_prev not in last['played'] and not prevg['benched']:
            add('INJURED_STARTER', s_prev, inferred=True, replaced_by=int(sL),
                note='absent from the latest game with no benching in his last start; '
                     'no injury report is read')
    if benched:
        add('BENCHING', sL, reliever=last['reliever'], reliever_share=round(last['reliever_share'], 4),
            note='replaced mid-game (an in-game injury looks the same in play-by-play)')
    win = games[-3:]
    tot = {}
    for g in win:
        for q, v in g['db_ng'].items():
            tot[q] = tot.get(q, 0.0) + v
    s = sum(tot.values())
    heavy = sorted([q for q, v in tot.items() if s > 0 and v / s >= ROTATION_SHARE])
    if len(heavy) >= 2:
        # a platoon (both play in the same games) vs a starter switch inside the window
        together = sum(1 for g in win if sum(1 for q in heavy if g['db_ng'].get(q, 0) > 0) >= 2)
        add('MULTI_QB_ROTATION', None, qbs=heavy,
            shares={str(q): round(tot[q] / s, 4) for q in heavy}, games=len(win),
            same_game_sharing=bool(together >= 2), games_shared=int(together))
    starters3 = len(set(g['starter'] for g in win))
    reasons = []
    if p is not None and p < AMBIGUOUS_P:
        reasons.append('starter probability %.2f < %.2f' % (p, AMBIGUOUS_P))
    if len(heavy) >= 2 and starters3 >= 2:
        reasons.append('rotation with %d different starters in the last %d games' % (starters3, len(win)))
    if reasons:
        add('AMBIGUOUS_STARTER', sL, review=True, reasons=reasons)
    out['events'] = ev
    return out


# ================================================================== build
def _ratings_at(season, T, ratings, league):
    """epa_pass defence ratings and h at T (V2's opponent adjustment)."""
    if ratings is not None:
        R = ratings[ratings.prediction_ts.eq(T)] if 'prediction_ts' in ratings else ratings
        L = league[league.prediction_ts.eq(T)] if league is not None else None
        if len(R):
            return R, L
    f = common.out_path('stage3', 'ratings_%d.parquet' % season)
    if os.path.exists(f):
        R = pd.read_parquet(f, columns=['prediction_ts', 'team_id', 'metric', 'def'])
        R = R[R.prediction_ts.eq(T)]
        if len(R):
            L = pd.read_parquet(common.out_path('stage3', 'league_%d.parquet' % season))
            return R, L[L.prediction_ts.eq(T)]
    from .. import build_ratings as BR
    fr = BR.run(seasons_out=[season], only_ts=[T], write=False, metrics=['epa_pass'],
                return_frames=True, verbose=False, ctx=_CACHE.setdefault(('br_ctx_qb',), {}))
    return fr['ratings'][season], fr['league'][season]


def _prev_freeze(G, season, T):
    pts = sorted(pd.Timestamp(x) for x in G.loc[G.season.eq(season), 'prediction_ts'].unique())
    before = [x for x in pts if x < T]
    return before[-1] if before else None


def build(season, T, ratings=None, league=None, Q=None):
    """Per-QB state and QB change events of every team at freeze T.

    ratings/league: the stage-3 frames at T (default: the stage-3 files, or an
    only_ts rebuild when T is not in them). Q: an injected per-QB game frame
    (tests); default the stage-1 qb_game files."""
    T = pd.Timestamp(T)
    T = T.tz_localize('UTC') if T.tzinfo is None else T.tz_convert('UTC')
    Qall, G = _load(season)
    if Q is not None:
        Qall = Q
    Apast, shrink = _shrinkage()
    k, repl, s2 = shrink['k_dropbacks'], shrink['replacement_mean'], shrink['noise_per_game_db']
    Qall = Qall[Qall.kickoff_ts < T]
    qs = Qall[Qall.g_season.eq(season)]
    career = Qall[Qall.starter][['qb_id', 'team_id', 'game_id', 'kickoff_ts']]
    R, L = _ratings_at(season, T, ratings, league)
    detail = {}
    F = QB.team_features(Qall, Apast[Apast.kickoff_ts < T], G, shrink, [season], only_ts=[T],
                         detail=detail, ratings={season: R.assign(prediction_ts=T)},
                         league={season: L.assign(prediction_ts=T) if L is not None and len(L)
                                 else pd.DataFrame({'prediction_ts': [T], 'metric': ['epa_pass'],
                                                    'h': [0.0]})})
    F = F.set_index('team_id')
    det = detail.get((season, T), {})
    rating, den = det.get('rating', pd.Series(dtype=float)), det.get('den', pd.Series(dtype=float))
    starts = det.get('starts', pd.Series(dtype=float))
    cur = det.get('cur', pd.DataFrame(columns=['team_id', 'qb_id', 'adj', 'db_ng']))
    stats = pbp_qb_stats(season)
    names = _CACHE.get(('names', season, C.DATA), {})
    if stats is not None:
        stats = stats[stats.game_id.isin(set(qs.game_id))]
    T_prev = _prev_freeze(G, season, T)
    g_s = G[G.season.eq(season)]
    fbs = set(g_s.loc[g_s.home_fbs, 'home_id']) | set(g_s.loc[g_s.away_fbs, 'away_id'])
    tr = transitions_from(qs)
    resolved = tr[tr.next_kickoff < T] if len(tr) else tr
    delta = level_shift(resolved)
    rows, events = [], []
    for t, q in qs.groupby('team_id'):
        st = detect(q, career, t, T, delta=delta)
        exp_q = st['expected_qb']
        v2 = F.loc[t] if t in F.index else None
        if v2 is not None and not pd.isna(v2.get('qb_id')) and int(v2['qb_id']) != exp_q:
            raise AssertionError('expected starter differs from qb.team_features for team %s' % t)
        for e in st['events']:
            e['season'] = int(season)
            e['as_of'] = T
            e['fresh'] = bool(T_prev is None or e['kickoff_ts'] >= T_prev)
            e['rule_version'] = RULE_VERSION
            e['fcs_team'] = bool(t not in fbs)
            if t not in fbs:
                e['reliability'] = 'low: FCS teams appear only in games against FBS teams'
            e['event_id'] = 'cfbq_' + ids.h('qbevent', e['type'], season, t, e['qb_id'], e['game_id'])
            events.append(e)
        season_db = q.groupby('qb_id').db.sum()
        season_dbng = q.groupby('qb_id').db_ng.sum()
        team_db = float(season_db.sum())
        season_starts = q[q.starter].groupby('qb_id').size()
        last3 = [g['game_id'] for g in st['games'][-3:]]
        rec_att = q[q.game_id.isin(last3)].groupby('qb_id').db.sum()
        ct = cur[cur.team_id.eq(t)] if len(cur) else cur
        st_t = stats[stats.team_id.eq(t)] if stats is not None else None
        for qid in sorted(season_db.index):
            qid = int(qid)
            is_qb = (qid == exp_q or season_starts.get(qid, 0) > 0 or season_db[qid] >= MIN_QB_DROPBACKS
                     or (team_db > 0 and season_db[qid] / team_db >= MIN_QB_SHARE))
            if not is_qb:
                continue
            qq = q[q.qb_id.eq(qid)]
            null = {}
            dbng = float(qq.db_ng.sum())
            ca = ct[ct.qb_id.eq(qid) & (ct.db_ng > 0)] if len(ct) else ct
            adj = float(np.average(ca.adj, weights=ca.db_ng)) if len(ca) else None
            if adj is None:
                null['adj_epa_db'] = 'no non-garbage dropback this season'
            sr = float(qq.succ_db.sum() / dbng) if dbng > 0 else None
            sk = float(qq.sacks.sum() / dbng) if dbng > 0 else None
            if dbng <= 0:
                null['success_rate'] = null['sack_rate'] = 'no non-garbage dropback this season'
            rush = expl = tov = None
            n_rush = None
            if st_t is None:
                for f in ('rush_contribution', 'explosive_pass_rate', 'turnover_proxy'):
                    null[f] = 'play-by-play file missing for %d' % season
            else:
                sq = st_t[st_t.qb_id.eq(qid)]
                gp = int(qq.game_id.nunique() + len(set(sq.game_id) - set(qq.game_id)))
                n_rush = float(sq.rush_ng.sum())
                rush = float(sq.rush_epa_ng.sum()) / gp if gp else None
                dbp = float(sq.db_ng_pbp.sum())
                expl = float(sq.expl_pass_ng.sum() / dbp) if dbp > 0 else None
                acts = dbp + n_rush
                tov = float((sq.int_ng.sum() + sq.fum_pass_ng.sum() + sq.fum_rush_ng.sum()) / acts) \
                    if acts > 0 else None
                if expl is None:
                    null['explosive_pass_rate'] = 'no non-garbage dropback in play-by-play'
                if tov is None:
                    null['turnover_proxy'] = 'no non-garbage action play in play-by-play'
            n_eff = float(den.get(qid, 0.0))
            post = float(rating.get(qid, repl))
            rows.append({
                'season': int(season), 'as_of': T, 'team_id': int(t), 'fcs_team': bool(t not in fbs),
                'qb_id': qid,
                'qb_name': names.get(qid),
                'expected_starter': bool(qid == exp_q),
                'starter_probability': st['probabilities'].get(qid, 0.0 if st['starter_probability'] is not None
                                                                 else None),
                'career_starts': int(starts.get(qid, 0)),
                'season_starts': int(season_starts.get(qid, 0)),
                'season_games': int(qq.game_id.nunique()),
                'season_dropbacks': int(season_db[qid]),
                'season_dropbacks_ng': dbng,
                'recent_attempts': int(rec_att.get(qid, 0)),
                'adj_epa_db': adj,
                'success_rate': sr,
                'sack_rate': sk,
                'rush_contribution': rush,
                'qb_rushes_ng': n_rush,
                'explosive_pass_rate': expl,
                'turnover_proxy': tov,
                'posterior_value': post,
                'posterior_sd': float(np.sqrt(s2 / (n_eff + k))),
                'n_eff_dropbacks': n_eff,
                'dropback_share': float(season_dbng.get(qid, 0.0) / season_dbng.sum())
                if season_dbng.sum() > 0 else None,
                'start_streak': int(st['streak']) if qid == exp_q else 0,
                'qb_stabilizing': bool(st['stabilizing']) if qid == exp_q else False,
                'p_unlisted_starter': st['p_unlisted'] if qid == exp_q else None,
                'starter_level_shift': delta,
                'starter_level_n': int(len(resolved)),
                'null_reasons': null,
                'rule_version': RULE_VERSION,
            })
    qb_rows = pd.DataFrame(rows)
    if len(qb_rows):
        qb_rows = qb_rows.sort_values(['team_id', 'expected_starter', 'qb_id'],
                                      ascending=[True, False, True]).reset_index(drop=True)
    ev = pd.DataFrame(events)
    if len(ev):
        ev = ev.sort_values(['team_id', 'type', 'event_id']).reset_index(drop=True)
    return qb_rows, ev


def lineup(qb_rows, events, team_id):
    """Team-level QB context for team_state: the expected starter, his starter
    probability, the events, and the offensive uncertainty inflation.

    The team's offence ratings were built on its season dropback mix; when the
    expected starter is NOT the season's dropback leader (V2's qb_changed), the
    offence gains the variance of the QB posterior difference
        Var(theta_exp - sum_j s_j theta_j) = (1 - s_e)^2 v_e + sum_{j != e} s_j^2 v_j
    (s_j = season non-garbage dropback shares, v_j = posterior variances,
    posteriors independent), in (EPA/dropback)^2. team_state multiplies it by
    the expected dropbacks^2. The team's offensive MEAN is never rewritten."""
    q = qb_rows[qb_rows.team_id.values == team_id] if len(qb_rows) else qb_rows
    ev = events[events.team_id.values == team_id] if events is not None and len(events) else pd.DataFrame()
    if not len(q):
        return {'expected_qb_id': None, 'status': 'NO_GAMES_YET', 'events': [], 'qb_change': False,
                'qb_diff_var_epa_db2': None, 'qb_offense_var_inflation_epa_db2': 0.0,
                'qb_stabilizing': False}
    e = q[q.expected_starter]
    e = e.iloc[0] if len(e) else None
    shares = q.set_index('qb_id').dropback_share.fillna(0.0)
    var = q.set_index('qb_id').posterior_sd ** 2
    diff_var = None
    change = False
    if e is not None:
        se = float(shares.get(e.qb_id, 0.0))
        diff_var = (1 - se) ** 2 * float(var[e.qb_id]) + float(sum(
            shares[j] ** 2 * var[j] for j in shares.index if j != e.qb_id))
        change = bool(len(shares) and shares.idxmax() != e.qb_id and shares.max() > se)
    types = sorted(set(ev.type)) if len(ev) else []
    stab = bool(e is not None and e.qb_stabilizing)
    return {'expected_qb_id': None if e is None else int(e.qb_id),
            'expected_qb_name': None if e is None else e.qb_name,
            'starter_probability': None if e is None else e.starter_probability,
            'status': 'OK', 'qb_change': change, 'events': types,
            'qb_diff_var_epa_db2': diff_var,
            'qb_offense_var_inflation_epa_db2': float(diff_var) if change else 0.0,
            'qb_stabilizing': stab}

