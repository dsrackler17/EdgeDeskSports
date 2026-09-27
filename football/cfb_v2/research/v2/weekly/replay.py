"""The shadow replay test (docs/cfb-weekly/REPLAY.md).

    python3 -m v2.weekly.replay --season 2025 --weeks 3,7,11
    python3 -m v2.weekly.replay --season 2025 --weeks all        # every regular-season freeze

For each freeze instant T it builds the world AS IT WAS AT T, in an isolated
directory, and reruns the pipeline there as the live engine would have:

  * the season's play-by-play keeps only games that kicked off before T;
  * the season's schedule keeps every game, but games from T on have no
    score, no winner and are not completed (the future has not happened);
  * every later season: no play-by-play, no scores, and its pregame files
    (talent, returning production, market file) PERTURBED;
  * the season's market file from T on is PERTURBED (lines +7, totals +10,
    points and season stats rescaled): the pure model must not read it.

It also builds the BATCH world once per season: the same stages, the same
code, on the full data (nothing withheld, nothing perturbed), which is how
the backtest's tables are made. Comparing the two at T isolates exactly what
the future contributes; comparing against a stale local out/ would instead
measure code drift. Then, at T:

  1. ratings (stage 3) for every team and metric at T      -> identical
  2. QB features and Elo for the games frozen at T          -> identical
  3. the model's inputs for the games frozen at T (stage 5) -> identical
  4. the weekly engine's rebuild at T in both worlds: same feature snapshot
     ids, same projection ids (the ids hash the inputs), same numbers
  5. the rebuild re-run in the replay world is a no-op, and a forced re-run
     writes nothing new (idempotency)

Identical means bit-for-bit up to float noise (1e-9). Any difference in a
model input is leakage from the future (or from the market) into the past,
and fails the test. Differences in labels (scores, status) are expected and
reported, never counted.

Nothing here writes to the live ledger or the real pipeline outputs: every
write goes to the replay directory (default: a temporary one).
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
import pandas as pd

from .. import config as C
from .. import models as MD
from . import ids
from . import project as PJ
from .sources import RESEARCH, REPO

TOL = 1e-9
SEASON_RE = re.compile(r'_(\d{4})\.parquet$')
STAGES = ('v2.plays', 'v2.games', 'v2.build_ratings', 'v2.qb', 'v2.elo', 'v2.snapshots')
# the market file's columns that are outcomes or prices (perturbed from T on);
# coaching continuity and venue facts are pregame and stay as they are
MARKET_SHIFT = {'spread_open': 7.0, 'spread': 7.0, 'over_under': 10.0, 'over_under_open': 10.0}
MARKET_SCALE_TOKENS = ('points', '_mov', '_epa', '_rate', '_pct', 'per_game', '_fp', 'success', 'wepa', 'rroe',
                       'sec_per_play', 'pregame_elo', 'opp_elo')
LABELS = ('home_points', 'away_points', 'margin', 'total_pts', 'status', 'completed', 'notes')


# ================================================================== the world
def freezes(season, out_dir=None):
    """{source_week: T}: the freeze instant after each regular-season week."""
    G = pd.read_parquet(os.path.join(out_dir or C.OUT, 'stage2', 'games.parquet'))
    g = G[G.season.eq(season) & ~G.is_postseason]
    out = {}
    for w in sorted(g.week.unique()):
        nxt = g[g.week.gt(w)]
        if len(nxt):
            out[int(w)] = pd.Timestamp(nxt.prediction_ts.min())
    return out


def _kickoffs(sched):
    return pd.to_datetime(sched.start_date, utc=True, errors='coerce')


def _perturb_numeric(df, cols, seed):
    rng = np.random.default_rng(seed)
    for c in cols:
        if c in df and pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c]):
            x = df[c].astype(float)
            df[c] = x * 1.5 + 3.0 + rng.normal(0, 1, len(x)) * x.std(skipna=True) if x.notna().any() else x
    return df


def _blank_schedule(s, future):
    s = s.copy()
    for c in ('home_points', 'away_points'):
        if c in s:
            s.loc[future, c] = np.nan
    for c in ('home_winner', 'away_winner'):
        if c in s:
            s[c] = s[c].astype(object)
            s.loc[future, c] = None
    if 'completed' in s:
        s['completed'] = s.completed.astype(object)
        s.loc[future, 'completed'] = False
        s['completed'] = s.completed.astype(bool)
    if 'status' in s:
        s['status'] = s.status.astype(object)
        s.loc[future, 'status'] = 'STATUS_SCHEDULED'
    return s


def _market_perturb(m, rows, seed):
    m = m.copy()
    for c, d in MARKET_SHIFT.items():
        if c in m:
            m.loc[rows, c] = m.loc[rows, c].astype(float) + d
    scale = [c for c in m.columns if c not in MARKET_SHIFT and any(t in c for t in MARKET_SCALE_TOKENS)
             and pd.api.types.is_numeric_dtype(m[c])]
    rng = np.random.default_rng(seed)
    for c in scale:
        x = m.loc[rows, c].astype(float)
        m[c] = m[c].astype(float)
        m.loc[rows, c] = x * 1.5 + 3.0 + rng.normal(0, 1, len(x))
    return m


def build_world(season, T, root, data_dir=None, out_dir=None, seed=0):
    """The world as it was at T, under root/{data,out}. Returns a summary of
    what was withheld or perturbed."""
    data_dir, out_dir = data_dir or C.DATA, out_dir or C.OUT
    D, O = os.path.join(root, 'data'), os.path.join(root, 'out')
    if os.path.exists(root):
        shutil.rmtree(root)
    os.makedirs(D)
    batch = T is None
    summary = {'season': season, 'T': ids.ts(T) if T is not None else None, 'withheld_plays': 0, 'kept_plays': 0,
               'future_games': 0, 'later_seasons': [], 'perturbed_files': [], 'batch': batch}
    sched_S = pd.read_parquet(os.path.join(data_dir, 'sched', 'cfb_schedules_%d.parquet' % season))
    fut_S = pd.Series(False, index=sched_S.index) if batch else \
        (_kickoffs(sched_S) >= T) | _kickoffs(sched_S).isna()
    future_ids = set(pd.to_numeric(sched_S.loc[fut_S, 'game_id'], errors='coerce').dropna().astype('int64'))
    summary['future_games'] = int(fut_S.sum())
    for dp, _, files in os.walk(data_dir):
        rel_dir = os.path.relpath(dp, data_dir)
        os.makedirs(os.path.join(D, rel_dir), exist_ok=True)
        kind = rel_dir.split(os.sep)[0]
        for f in files:
            src, dst = os.path.join(dp, f), os.path.join(D, rel_dir, f)
            m = SEASON_RE.search(f)
            s = int(m.group(1)) if m else None
            if batch or s is None or s < season or kind not in ('pbp', 'sched', 'mline', 'talent', 'retprod'):
                os.symlink(os.path.abspath(src), dst)
                continue
            if s > season and s not in summary['later_seasons']:
                summary['later_seasons'].append(s)
            if kind == 'pbp':
                if s > season:
                    continue                           # the later season has not been played
                p = pd.read_parquet(src)
                gid = pd.to_numeric(p.game_id, errors='coerce')
                keep = ~gid.isin(future_ids)
                summary['withheld_plays'] += int((~keep).sum())
                summary['kept_plays'] += int(keep.sum())
                p[keep].to_parquet(dst, index=False)
            elif kind == 'sched':
                sc = pd.read_parquet(src)
                fut = pd.Series(True, index=sc.index) if s > season else fut_S.reindex(sc.index).fillna(True)
                _blank_schedule(sc, fut).to_parquet(dst, index=False)
            elif kind == 'mline':
                mk = pd.read_parquet(src)
                rows = pd.Series(True, index=mk.index) if s > season else \
                    pd.to_numeric(mk.game_id, errors='coerce').isin(future_ids)
                _market_perturb(mk, rows, seed + s).to_parquet(dst, index=False)
                summary['perturbed_files'].append(os.path.join(rel_dir, f))
            elif kind in ('talent', 'retprod'):
                if s == season:
                    os.symlink(os.path.abspath(src), dst)   # preseason facts, known before week 1
                    continue
                d = pd.read_parquet(src)
                num = [c for c in d.columns if c not in ('season', 'team_id', 'team', 'school', 'conference')]
                _perturb_numeric(d, num, seed + s).to_parquet(dst, index=False)
                summary['perturbed_files'].append(os.path.join(rel_dir, f))
    # outputs: earlier seasons' stage-1 files are read-only inputs (symlinked);
    # everything the stages write is written fresh inside the world
    for st in ('stage1', 'stage2', 'stage3', 'stage4', 'stage5'):
        os.makedirs(os.path.join(O, st), exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, 'stage1', '*.parquet')):
        m = SEASON_RE.search(f)
        s = int(m.group(1)) if m else None
        dst = os.path.join(O, 'stage1', os.path.basename(f))
        if s is None or s < season or (batch and s > season):
            os.symlink(os.path.abspath(f), dst)
        elif s > season:
            b = pd.read_parquet(f)
            if os.path.basename(f).startswith('games_'):
                b = _blank_schedule(b, pd.Series(True, index=b.index))
            else:
                b = b.iloc[:0]                         # no plays yet: no team-games, no QB games
            b.to_parquet(dst, index=False)
    # earlier seasons' ratings are inputs of the season's priors (lags); the
    # season's own and later ones are rebuilt or do not exist yet
    for f in glob.glob(os.path.join(out_dir, 'stage3', '*_20*.parquet')):
        s = int(SEASON_RE.search(f).group(1))
        if s < season:
            shutil.copy(f, os.path.join(O, 'stage3', os.path.basename(f)))
    return summary


def batch_world(season, base):
    """The batch: the same stages, the same code, on the full data (nothing
    withheld, nothing perturbed). Built once per season and shared by every
    week; the comparison isolates what the future contributes."""
    root = os.path.join(base, 'batch_%d' % season)
    done = os.path.join(root, '.built')
    if not os.path.exists(done):
        build_world(season, None, root)
        times, _ = run_stages(season, root)
        json.dump(times, open(done, 'w'))
    env = dict(os.environ, CFB_V2_DATA=os.path.join(root, 'data'), CFB_V2_OUT=os.path.join(root, 'out'),
               OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1', CFB_WEEKLY_QUIET='1')
    return root, env, json.load(open(done))


def run_stages(season, root, timeout=7200):
    env = dict(os.environ, CFB_V2_DATA=os.path.join(root, 'data'), CFB_V2_OUT=os.path.join(root, 'out'),
               OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1', CFB_WEEKLY_QUIET='1')
    times = {}
    for mod in STAGES:
        args = [sys.executable, '-m', mod] + ([str(season)] if mod in ('v2.plays', 'v2.build_ratings', 'v2.qb',
                                                                        'v2.snapshots') else [])
        t0 = time.time()
        p = subprocess.run(args, cwd=RESEARCH, env=env, capture_output=True, text=True, timeout=timeout)
        times[mod] = round(time.time() - t0, 1)
        if p.returncode != 0:
            raise RuntimeError('%s failed in the replay world:\n%s' % (mod, (p.stderr or p.stdout)[-3000:]))
    return times, env


# ============================================================== comparisons
def compare(a, b, keys, cols=None, label=''):
    """Max |diff| per numeric column and exact equality for the rest, on the
    keys both frames share. NaN == NaN."""
    cols = [c for c in (cols or sorted(set(a.columns) & set(b.columns))) if c not in keys]
    ka = a[keys].astype(str).agg('|'.join, axis=1)
    kb = b[keys].astype(str).agg('|'.join, axis=1)
    A, B = a.assign(_k=ka.values).set_index('_k'), b.assign(_k=kb.values).set_index('_k')
    only_a, only_b = sorted(set(A.index) - set(B.index)), sorted(set(B.index) - set(A.index))
    common_k = sorted(set(A.index) & set(B.index))
    A, B = A.loc[common_k], B.loc[common_k]
    diffs = {}
    for c in cols:
        if c not in A and c not in B:
            continue                                   # derived at inference on both sides
        if c not in A or c not in B:
            diffs[c] = 'missing in %s' % ('replay' if c not in A else 'batch')
            continue
        x, y = A[c], B[c]
        if pd.api.types.is_numeric_dtype(x) and pd.api.types.is_numeric_dtype(y) \
                and not pd.api.types.is_bool_dtype(x) and not pd.api.types.is_bool_dtype(y):
            xf, yf = x.astype(float).values, y.astype(float).values
            nan_mismatch = int((np.isnan(xf) != np.isnan(yf)).sum())
            both = ~np.isnan(xf) & ~np.isnan(yf)
            mx = float(np.max(np.abs(xf[both] - yf[both]))) if both.any() else 0.0
            if nan_mismatch or mx > TOL:
                diffs[c] = {'max_abs_diff': mx, 'nan_mismatch': nan_mismatch}
        else:
            # null-aware: under pandas 3, astype(str) turns None into a missing value and missing != missing
            def canon(v):
                return json.dumps(None if v is None or (isinstance(v, float) and np.isnan(v)) else v,
                                  sort_keys=True, default=str)
            ne = int(sum(a_ != b_ for a_, b_ in zip(map(canon, x.astype(object).tolist()), map(canon, y.astype(object).tolist()))))
            if ne:
                diffs[c] = {'unequal_rows': ne}
    return {'label': label, 'rows_replay': int(len(a)), 'rows_batch': int(len(b)), 'rows_compared': len(common_k),
            'only_replay': only_a[:10], 'only_batch': only_b[:10], 'n_only_replay': len(only_a),
            'n_only_batch': len(only_b), 'columns': len(cols), 'diffs': diffs,
            'identical': not diffs and not only_a and not only_b}


def _read(root_out, *p):
    return pd.read_parquet(os.path.join(root_out, *p))


def compare_week(season, T, world_out, batch_out=None):
    batch_out = batch_out or C.OUT
    res = {}
    # 1. ratings at T
    Rr = _read(world_out, 'stage3', 'ratings_%d.parquet' % season)
    Rb = _read(batch_out, 'stage3', 'ratings_%d.parquet' % season)
    res['ratings'] = compare(Rr[Rr.prediction_ts.eq(T)], Rb[Rb.prediction_ts.eq(T)], ['team_id', 'metric'],
                             label='stage-3 ratings at T (every team, every metric)')
    Lr = _read(world_out, 'stage3', 'league_%d.parquet' % season)
    Lb = _read(batch_out, 'stage3', 'league_%d.parquet' % season)
    res['league'] = compare(Lr[Lr.prediction_ts.eq(T)], Lb[Lb.prediction_ts.eq(T)], ['metric'],
                            label='league means and home field at T')
    # the games frozen at T
    Gb = _read(batch_out, 'stage2', 'games.parquet')
    tg = Gb[Gb.season.eq(season) & Gb.prediction_ts.eq(T)]
    gids = set(tg.game_id.astype('int64'))
    # 2. QB features and Elo
    Qr, Qb = _read(world_out, 'stage4', 'qb_team.parquet'), _read(batch_out, 'stage4', 'qb_team.parquet')
    res['qb'] = compare(Qr[Qr.season.eq(season) & Qr.prediction_ts.eq(T)],
                        Qb[Qb.season.eq(season) & Qb.prediction_ts.eq(T)], ['team_id'],
                        label='QB features at T (every team)')
    Er, Eb = _read(world_out, 'stage4', 'elo.parquet'), _read(batch_out, 'stage4', 'elo.parquet')
    res['elo'] = compare(Er[Er.game_id.isin(gids)], Eb[Eb.game_id.isin(gids)], ['game_id'],
                         label='pregame Elo for the games frozen at T')
    # 3. stage-5 rows at T: the model's inputs, strictly; everything else reported
    Xr = _read(world_out, 'stage5', 'cfb_model_training_snapshots.parquet')
    Xb = _read(batch_out, 'stage5', 'cfb_model_training_snapshots.parquet')
    Xr = MD.add_derived(Xr[Xr.season.eq(season) & Xr.prediction_ts.eq(T)])
    Xb = MD.add_derived(Xb[Xb.season.eq(season) & Xb.prediction_ts.eq(T)])
    A, _ = PJ.PL.load_artifacts(C.MODEL_VERSION)
    inputs = PJ.model_inputs(A)
    res['model_inputs'] = compare(Xr, Xb, ['game_id'], cols=inputs,
                                  label='the model inputs of every game frozen at T (%d columns)' % len(inputs))
    rest = [c for c in sorted(set(Xr.columns) & set(Xb.columns)) if c not in inputs and c not in LABELS
            and c != 'game_id']
    other = compare(Xr, Xb, ['game_id'], cols=rest, label='every other stage-5 column except labels')
    res['other_columns'] = other
    res['labels_differ'] = sorted(c for c in compare(Xr, Xb, ['game_id'], cols=[c for c in LABELS if c in Xr],
                                                    label='labels')['diffs'])
    return res


# =========================================================== the weekly engine
def weekly_rebuild(season, week, state_root, env, force=False):
    args = [sys.executable, '-m', 'v2.weekly.run', '--mode', 'rebuild', '--season', str(season),
            '--through-week', str(week), '--state-root', state_root, '--no-fetch'] + (['--force'] if force else [])
    t0 = time.time()
    p = subprocess.run(args, cwd=RESEARCH, env=dict(env, CFB_WEEKLY_QUIET='1'), capture_output=True, text=True,
                       timeout=7200)
    out = (p.stdout or '').strip().splitlines()
    summary = None
    for line in reversed(out):
        if line.startswith('{'):
            summary = json.loads(line)
            break
    return {'returncode': p.returncode, 'seconds': round(time.time() - t0, 1), 'summary': summary,
            'noop': any('nothing new' in l for l in out), 'stderr_tail': (p.stderr or '')[-1500:] if p.returncode else ''}


def _jsonl(path):
    return [json.loads(l) for l in open(path)] if os.path.exists(path) else []


def _lines(path):
    return sum(1 for _ in open(path)) if os.path.exists(path) else 0


PROV = {'run_id', 'as_of', 'data_version', 'pbp_version', 'roster_version', 'injury_version', 'state_id',
        'state_version', 'supersedes', 'created_at', 'recorded_at', 'validated_at', 'computed_at', 'row_hash',
        'performance_id', 'validation_id', 'qb_state_id', 'unit_state_id', 'explanation'}


def _flat_numeric(recs, keys):
    rows = []
    for r in recs:
        d = {k: r.get(k) for k in keys}
        for k, v in r.items():
            if k in PROV or k in keys:
                continue
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                d[k] = v
            elif isinstance(v, (str, bool)) or v is None:
                d[k] = v
        rows.append(d)
    return pd.DataFrame(rows)


def compare_engine(season, state_replay, state_batch):
    sr, sb = os.path.join(state_replay, str(season)), os.path.join(state_batch, str(season))
    res = {}
    Pr, Pb = _jsonl(os.path.join(sr, 'projections.jsonl')), _jsonl(os.path.join(sb, 'projections.jsonl'))
    ir, ib = {p['game_id']: p for p in Pr}, {p['game_id']: p for p in Pb}
    same_id = sum(1 for g in ir if g in ib and ir[g]['projection_id'] == ib[g]['projection_id'])
    diffs = []
    for g in sorted(set(ir) & set(ib)):
        a, b = ir[g], ib[g]
        for k in ('ens_pred', 'sigma', 'p_home_calibrated', 'fair_total', 'input_hash', 'feature_snapshot_id'):
            if a.get(k) != b.get(k):
                diffs.append({'game_id': g, 'field': k, 'replay': a.get(k), 'batch': b.get(k)})
    res['projections'] = {'replay': len(ir), 'batch': len(ib), 'same_projection_id': same_id,
                          'only_replay': sorted(set(ir) - set(ib))[:10], 'only_batch': sorted(set(ib) - set(ir))[:10],
                          'diffs': diffs[:20], 'n_diffs': len(diffs),
                          'mode_differs': sum(1 for g in set(ir) & set(ib) if ir[g].get('model_mode') != ib[g].get('model_mode')),
                          'identical': len(ir) > 0 and same_id == len(ir) == len(ib) and not diffs}
    for kind, keys in (('team_week_state', ['team_id']), ('game_performance', ['game_id', 'team_id']),
                       ('qb_week_state', ['player_id', 'team_id'])):
        a = _flat_numeric(_jsonl(os.path.join(sr, kind + '.jsonl')), keys)
        b = _flat_numeric(_jsonl(os.path.join(sb, kind + '.jsonl')), keys)
        if not len(a) and not len(b):
            res[kind] = {'label': kind, 'identical': True, 'rows_replay': 0, 'rows_batch': 0, 'diffs': {}}
            continue
        res[kind] = compare(a, b, keys, label=kind)
    return res


# ================================================================== the run
def replay_week(season, week, T, base, keep=False):
    root = os.path.join(base, 'w%02d' % week)
    for d in ('state_replay', 'state_batch'):
        shutil.rmtree(os.path.join(root, d), ignore_errors=True)
    broot, benv, _ = batch_world(season, base)
    t0 = time.time()
    world = build_world(season, T, os.path.join(root, 'world'))
    t_world = round(time.time() - t0, 1)
    times, env = run_stages(season, os.path.join(root, 'world'))
    cmp_ = compare_week(season, T, os.path.join(root, 'world', 'out'), os.path.join(broot, 'out'))
    # the weekly engine at T, in the replay world and in the batch world
    st_r, st_b = os.path.join(root, 'state_replay'), os.path.join(root, 'state_batch')
    eng_r = weekly_rebuild(season, week, st_r, env)
    eng_b = weekly_rebuild(season, week, st_b, benv)
    engine = compare_engine(season, st_r, st_b) if eng_r['returncode'] == 0 and eng_b['returncode'] == 0 else None
    # idempotency: the same work again is a no-op; forced, it writes nothing new
    sd = os.path.join(st_r, str(season))
    watched = ('runs.jsonl', 'projections.jsonl', 'team_week_state.jsonl', 'qb_week_state.jsonl',
               'game_performance.jsonl', 'game_validation.jsonl', 'projection_changes.jsonl')
    before = {f: _lines(os.path.join(sd, f)) for f in watched}
    again = weekly_rebuild(season, week, st_r, env)
    mid = {f: _lines(os.path.join(sd, f)) for f in watched}
    forced = weekly_rebuild(season, week, st_r, env, force=True)
    after = {f: _lines(os.path.join(sd, f)) for f in watched}
    idem = {'rerun_noop': again['noop'] and mid == before,
            'forced_writes_only_a_run_record': forced['returncode'] == 0 and all(
                after[f] == before[f] for f in watched if f != 'runs.jsonl') and after['runs.jsonl'] == before['runs.jsonl'] + 1,
            'lines_before': before, 'lines_after_forced': after}
    out = {'season': season, 'source_week': week, 'T': ids.ts(T), 'world': world, 'seconds_world': t_world,
           'stage_seconds': times, 'compare': cmp_, 'engine_replay': eng_r, 'engine_batch': eng_b,
           'engine': engine, 'idempotency': idem}
    strict = [cmp_[k]['identical'] for k in ('ratings', 'league', 'qb', 'elo', 'model_inputs')]
    eng_ok = engine is not None and engine['projections']['identical'] and all(
        engine[k]['identical'] for k in ('team_week_state', 'game_performance', 'qb_week_state'))
    out['pass'] = bool(all(strict) and eng_ok and idem['rerun_noop'] and idem['forced_writes_only_a_run_record'])
    if not keep:
        shutil.rmtree(os.path.join(root, 'world'), ignore_errors=True)
    return out


def _fmt(c):
    if c['identical']:
        return 'identical (%d rows, %d columns)' % (c['rows_compared'], c['columns'])
    parts = []
    if c.get('n_only_replay') or c.get('n_only_batch'):
        parts.append('%d rows only in replay, %d only in batch' % (c.get('n_only_replay', 0), c.get('n_only_batch', 0)))
    for k, v in list(c['diffs'].items())[:6]:
        parts.append('%s %s' % (k, v))
    return 'DIFFERENT: ' + '; '.join(parts)


def write_report(results, path):
    L = ['# CFB weekly engine: shadow replay', '',
         'Generated by `python3 -m v2.weekly.replay` (the method is in `v2/weekly/replay.py`\'s docstring). Each row',
         'rebuilds the world as it was at a past freeze instant T: the season\'s later games unplayed, every later',
         'season unplayed with its pregame files perturbed, and the market file from T on perturbed. It reruns',
         'V2.1\'s point-in-time stages and the weekly engine there, and compares them with the batch world: the',
         'same stages and code on the full season, the way the backtest\'s tables are built. Identical means equal',
         'to 1e-9. A model input that differs would be leakage from the future (or the market) into the past.', '']
    L += ['| season | week | T | withheld plays | ratings | QB | Elo | model inputs | engine projections | '
          'team state | idempotent | pass |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in results:
        c, e, i = r['compare'], r['engine'] or {}, r['idempotency']
        L.append('| %d | %d | %s | %d | %s | %s | %s | %s | %s | %s | %s | **%s** |' % (
            r['season'], r['source_week'], r['T'], r['world']['withheld_plays'],
            'yes' if c['ratings']['identical'] and c['league']['identical'] else 'NO',
            'yes' if c['qb']['identical'] else 'NO', 'yes' if c['elo']['identical'] else 'NO',
            'yes (%d games)' % c['model_inputs']['rows_compared'] if c['model_inputs']['identical'] else 'NO',
            ('yes (%d)' % e['projections']['same_projection_id']) if e and e['projections']['identical'] else 'NO',
            'yes' if e and e['team_week_state']['identical'] else 'NO',
            'yes' if i['rerun_noop'] and i['forced_writes_only_a_run_record'] else 'NO',
            'PASS' if r['pass'] else 'FAIL'))
    L.append('')
    for r in results:
        c, e = r['compare'], r['engine']
        L += ['## %d, after week %d (T = %s)' % (r['season'], r['source_week'], r['T']), '',
              '- world: %d plays withheld, %d kept, %d future games unplayed; later seasons %s unplayed; '
              'perturbed: %s' % (r['world']['withheld_plays'], r['world']['kept_plays'], r['world']['future_games'],
                                  r['world']['later_seasons'], ', '.join(r['world']['perturbed_files']) or 'none'),
              '- stage times (s): %s' % ', '.join('%s %s' % kv for kv in r['stage_seconds'].items())]
        for k in ('ratings', 'league', 'qb', 'elo', 'model_inputs', 'other_columns'):
            L.append('- %s: %s' % (c[k]['label'], _fmt(c[k])))
        L.append('- labels that differ (expected: the future is unplayed): %s' % (', '.join(c['labels_differ']) or 'none'))
        if e:
            p = e['projections']
            L.append('- weekly engine rebuild: %d projections in the replay, %d on the batch tables, %d with the same '
                     'projection id (the id hashes the inputs); %d numeric differences; degraded-mode label differs '
                     'on %d (source health reads the world\'s files)'
                     % (p['replay'], p['batch'], p['same_projection_id'], p['n_diffs'], p['mode_differs']))
            for k in ('team_week_state', 'game_performance', 'qb_week_state'):
                L.append('- %s: %s' % (k, _fmt(e[k]) if e[k].get('rows_compared') is not None else
                                       ('identical (empty)' if e[k]['identical'] else str(e[k]))))
        else:
            L.append('- weekly engine rebuild did not complete: replay rc %s, batch rc %s\n\n```\n%s\n%s\n```'
                     % (r['engine_replay']['returncode'], r['engine_batch']['returncode'],
                        r['engine_replay']['stderr_tail'], r['engine_batch']['stderr_tail']))
        i = r['idempotency']
        L.append('- idempotency: re-run is a no-op: %s; forced re-run writes only a run record: %s (%s -> %s)'
                 % (i['rerun_noop'], i['forced_writes_only_a_run_record'], i['lines_before'], i['lines_after_forced']))
        L.append('')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w').write('\n'.join(L) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2025)
    ap.add_argument('--weeks', default='3,7,11', help='source weeks, or "all"')
    ap.add_argument('--dir', default=None, help='work directory (default: a temporary one)')
    ap.add_argument('--keep', action='store_true', help='keep the replay worlds')
    ap.add_argument('--report', default=os.path.join(REPO, 'docs', 'cfb-weekly', 'REPLAY.md'))
    ap.add_argument('--json', default=None)
    a = ap.parse_args()
    fz = freezes(a.season)
    weeks = sorted(fz) if a.weeks == 'all' else [int(w) for w in a.weeks.split(',')]
    base = a.dir or tempfile.mkdtemp(prefix='cfb_replay_')
    results = []
    for w in weeks:
        if w not in fz:
            print('[replay] week %d has no following freeze in %d; skipped' % (w, a.season))
            continue
        t0 = time.time()
        r = replay_week(a.season, w, fz[w], base, keep=a.keep)
        results.append(r)
        print('[replay] %d week %d (T %s): %s in %.0fs' % (a.season, w, r['T'], 'PASS' if r['pass'] else 'FAIL',
                                                          time.time() - t0), flush=True)
    write_report(results, a.report)
    js = a.json or os.path.join(base, 'replay.json')
    json.dump(ids.clean(results), open(js, 'w'), indent=1, default=str)
    print('[replay] report %s; details %s' % (a.report, js))
    sys.exit(0 if results and all(r['pass'] for r in results) else 1)


if __name__ == '__main__':
    from .runlog import single_thread_blas
    single_thread_blas('v2.weekly.replay')
    main()
