"""The weekly engine's orchestrator (docs/cfb-weekly/DESIGN.md).

    python3 -m v2.weekly.run --mode weekly|daily|freeze [--season S] [--now ISO] [--force] [--no-fetch]
    python3 -m v2.weekly.run --mode rebuild --season 2024 --through-week 8

Every stage has an explicit status, a failed stage BLOCKS what depends on it,
and nothing is published unless the release gate passes. The pipeline:

  FINAL GAMES -> CLEAN PBP -> GAME PERFORMANCE -> OPPONENT ADJUSTMENT -> TEAM
  POSTERIORS -> PLAYER/QB STATE -> MATCHUP FEATURES -> NEXT-WEEK PURE
  PROJECTIONS -> [GATE] -> FREEZE -> MARKET COMPARISON -> MODEL LAB -> REPORT

It runs V2.1's own point-in-time stages (plays, games, build_ratings, qb, elo,
snapshots, predict_live) in-process, so the refresh is the validated method,
not a copy of it. Nothing here fits a model: the artifact is loaded, verified
against its MANIFEST, and applied.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from . import availability as AV
from . import gate as GATE
from . import ids
from . import project as PJ
from . import runlog as RL
from . import sources as SRC
from .store import Store

RESEARCH = SRC.RESEARCH
REPO = SRC.REPO
CRITICAL_STAGES = ('INGEST_FINAL_SCORES', 'VERIFY_COMPLETED_GAMES', 'VALIDATE_PBP', 'OPPONENT_ADJUSTMENT',
                   'TEAM_POSTERIORS', 'PLAYER_QB_METRICS', 'UPCOMING_FEATURES', 'PURE_SUBMODELS', 'ENSEMBLE',
                   'CALIBRATION', 'LEAKAGE_TESTS')
FINAL_GRACE_H = 36          # a game still not final this long after kickoff is flagged


def season_for(now):
    """The football season of an instant: January and February belong to the
    season that began the previous August."""
    now = pd.Timestamp(now)
    return now.year - 1 if now.month <= 2 else now.year


def weeks_for(G, season, now, mode, through_week=None):
    """(source_week, target_week, T). T is the freeze instant of the target week."""
    g = G[G.season.eq(season)]
    if mode == 'rebuild':
        nxt = g[g.week.gt(through_week)].sort_values('kickoff_ts')
        if nxt.empty:
            raise RL.StageError('no games after week %s in %s' % (through_week, season), 'DATA_QUALITY')
        T = pd.Timestamp(nxt.prediction_ts.min())
        tw = int(g[g.prediction_ts.eq(T)].week.mode().iloc[0])
        return int(through_week), tw, T
    if mode == 'freeze':
        cur = g[(g.prediction_ts <= now) & (g.kickoff_ts > now)]
        if cur.empty:
            return None, None, None
        T = pd.Timestamp(cur.prediction_ts.max())
    else:
        up = g[g.kickoff_ts > now]
        if up.empty:
            return None, None, None
        T = pd.Timestamp(up.prediction_ts.min())
        if T <= now:        # the current week is already frozen: prepare the next one
            later = up[up.prediction_ts > now]
            T = pd.Timestamp(later.prediction_ts.min()) if len(later) else T
    tw = int(g[g.prediction_ts.eq(T)].week.mode().iloc[0])
    done = g[g.kickoff_ts < T]
    sw = int(done.week.max()) if len(done) else 0
    return sw, tw, T


def _sub(args, env=None, timeout=3600):
    """A V2 CLI step as a subprocess, classified on failure."""
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.run(args, cwd=RESEARCH, env=e, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        tail = (p.stderr or p.stdout or '')[-800:]
        raise RL.StageError('%s exited %d: %s' % (' '.join(args[:4]), p.returncode, tail),
                            RL.classify_error(Exception(tail)))
    return p.stdout


def run(season=None, now=None, mode='weekly', force=False, fetch=True, through_week=None,
        state_root=None, lab_dispatch=None, verbose=True):
    now = pd.Timestamp(now) if now is not None else pd.Timestamp.now(tz='UTC')
    if now.tzinfo is None:
        now = now.tz_localize('UTC')
    season = season or season_for(now)
    store = Store(season, state_root)
    run = RL.PipelineRun(season, None, None, mode, C.MODEL_VERSION, C.FEATURE_VERSION, clock=lambda: pd.Timestamp.now(tz='UTC'))
    lock = RL.RunLock(os.path.join(C.OUT, '.weekly.lock'))
    ctx = {'now': now, 'season': season}
    try:
        with lock:
            _pipeline(run, store, ctx, mode, force, fetch, through_week, lab_dispatch)
    except RL.StageError as e:
        run.status = 'LOCKED' if 'holds' in str(e) else 'FAILED'
        run.errors.append({'stage': 'LOCK', 'class': e.klass, 'message': str(e)})
    rec = run.record(versions=ctx.get('versions'), totals=ctx.get('totals'))
    if ctx.get('noop'):
        if verbose:
            print('[weekly] nothing new: run_key %s already published by %s' % (run.run_key, ctx['noop']))
        return rec
    store.append_unique('runs', [{k: v for k, v in rec.items() if k not in ('stages', 'warnings')}])
    store.write_json(os.path.join('runs', rec['run_id'] + '.json'), rec)
    if ctx.get('source_health'):
        store.write_json('source_health.json', ctx['source_health'])
    return rec


def _pipeline(run, store, ctx, mode, force, fetch, through_week, lab_dispatch):
    from . import validate as VAL
    from . import perf as PERF
    from . import qb_state as QBS
    from . import team_state as TS
    now, season = ctx['now'], ctx['season']
    ctx['run_id'] = run.run_id

    # ---------------------------------------------------------- 1-2 ingest
    def ingest(rec):
        if fetch and mode != 'rebuild':
            RL.retry(lambda: _sub(['bash', 'fetch_v2.sh', C.DATA, '2009', str(season)],
                                  env={'CFB_V2_SEASON': str(season)}),
                     on_retry=lambda i, k, e: run.warn('INGEST_FINAL_SCORES', 'fetch retry %d (%s)' % (i, k)))
        prior = list(range(C.FIRST_PBP_SEASON, season))
        v = SRC.versions(season, prior_seasons=prior)
        ctx['versions'] = v
        run.data_version = v['data_version']
        # cost control: stage 1 is rebuilt only for seasons whose inputs changed
        man_path = os.path.join(C.OUT, 'stage1', '.inputs.json')
        man = json.load(open(man_path)) if os.path.exists(man_path) else {}
        todo = []
        for s in range(C.FIRST_PBP_SEASON, season + 1):
            hs = ids.h(*[ids.file_hash(p) for p in SRC.season_paths(s)['pbp'] + SRC.season_paths(s)['schedule']])
            if man.get(str(s)) != hs or not os.path.exists(os.path.join(C.OUT, 'stage1', 'team_game_%d.parquet' % s)):
                todo.append((s, hs))
        if todo and mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.plays'] + [str(s) for s, _ in todo])
            for s, hs in todo:
                man[str(s)] = hs
            os.makedirs(os.path.dirname(man_path), exist_ok=True)
            json.dump(man, open(man_path, 'w'), indent=1, sort_keys=True)
        rec['counts']['stage1_seasons_rebuilt'] = len(todo) if mode != 'rebuild' else 0
        if mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.games'])
        G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
        ctx['G'] = G
        sw, tw, T = weeks_for(G, season, now if mode != 'rebuild' else None, mode, through_week)
        if T is None:
            raise RL.StageError('no upcoming games for season %s at %s (offseason?)' % (season, ids.ts(now)), 'DATA_QUALITY')
        run.source_week, run.target_week = sw, tw
        ctx.update(T=T, source_week=sw, target_week=tw)
        if mode == 'rebuild':
            ctx['now'] = T                # the rebuild knows exactly what was known at T
        g = G[G.season.eq(season)]
        rec['counts'].update(games_season=int(len(g)), games_final=int(g.status.eq('FINAL').sum()),
                             target_week=tw, source_week=sw, T=ids.ts(T))
        # an idempotent re-run of published work is a no-op
        prev = [r for r in store.read('runs') if r.get('run_key') == run.run_key and r.get('published')]
        if prev and not force:
            ctx['noop'] = prev[-1]['run_id']
            raise _Noop()
        return {}

    try:
        run.stage('INGEST_FINAL_SCORES', ingest)
    except _Noop:
        return
    if not run.ok('INGEST_FINAL_SCORES'):
        run.status = 'FAILED'
        return
    T, G, now = ctx['T'], ctx['G'], ctx['now']
    sw, tw = ctx['source_week'], ctx['target_week']

    # ---------------------------------------------------------- 1, 3 verify + validate
    def verify(rec):
        V = VAL.validate_games(season, now)
        ctx['validation'] = V
        src = V[V.week.eq(sw)] if 'week' in V else V
        due = src[pd.to_datetime(src.kickoff_ts, utc=True, errors='coerce') < now - pd.Timedelta(hours=FINAL_GRACE_H)] \
            if 'kickoff_ts' in src else src
        not_final = due[due.status.isin(['SCHEDULED', 'IN_PROGRESS'])]
        for _, r in not_final.iterrows():
            run.warn('VERIFY_COMPLETED_GAMES', 'game %s not final %dh after kickoff' % (r.game_id, FINAL_GRACE_H))
        # a second source: the Model Lab's settled results (ESPN scoreboard + cfbfastR agreement)
        lab = _lab_results(season)
        dis = []
        for _, r in V[V.status.isin(['FINAL_VALIDATED', 'FINAL_PARTIAL_DATA'])].iterrows():
            L = lab.get(str(r.game_id))
            if L and L.get('status') == 'FINAL' and (L.get('home_points') != r.home_points or L.get('away_points') != r.away_points):
                dis.append(str(r.game_id))
        for gid in dis:
            run.warn('VERIFY_COMPLETED_GAMES', 'final score of %s disagrees with the Model Lab settlement' % gid)
        rec['counts'].update(source_week_games=int(len(src)), source_week_final=int(src.status.str.startswith('FINAL').sum()),
                             not_final_after_grace=int(len(not_final)), lab_disagreements=len(dis))
        ctx['totals'] = {'games_expected': int(len(src)), 'games_final': int(src.status.str.startswith('FINAL').sum())}
        return {}

    run.stage('VERIFY_COMPLETED_GAMES', verify, needs=('INGEST_FINAL_SCORES',))

    def validate_pbp(rec):
        V = ctx['validation']
        fin = V[V.status.isin(['FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'DATA_ERROR'])]
        counts = V.status.value_counts().to_dict()
        rec['counts'].update({k.lower(): int(v) for k, v in counts.items()})
        rec['counts']['plays_processed'] = int(fin.pbp_plays.fillna(0).sum()) if 'pbp_plays' in fin else None
        rec['counts']['mean_completeness'] = round(float(fin.pbp_completeness_score.mean()), 4) if len(fin) else None
        for _, r in fin[fin.status.eq('DATA_ERROR')].iterrows():
            run.warn('VALIDATE_PBP', 'DATA_ERROR %s: %s' % (r.game_id, '; '.join((r.issues or [])[:3]) if isinstance(r.issues, list) else r.issues))
        ctx['totals'].update(games_processed=int(len(fin)), plays_processed=rec['counts']['plays_processed'],
                             plays_expected=None)
        return {}

    run.stage('VALIDATE_PBP', validate_pbp, needs=('VERIFY_COMPLETED_GAMES',))

    # ---------------------------------------------------------- 4-5 performance + drives
    def performance(rec):
        P = PERF.game_performance(season, T=T)
        ctx['performance'] = P
        rec['counts']['team_games'] = int(len(P))
        return {}

    run.stage('GAME_PERFORMANCE', performance, needs=('VALIDATE_PBP',))

    def drives(rec):
        S = PERF.team_summary(season, T)
        ctx['team_summary'] = S
        rec['counts']['teams'] = int(len(S))
        return {}

    run.stage('DRIVE_METRICS', drives, needs=('GAME_PERFORMANCE',))

    # ---------------------------------------------------------- 8 opponent adjustment (V2 stage 3)
    def opp_adjust(rec):
        if mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.build_ratings', str(season)])
        return {}

    run.stage('OPPONENT_ADJUSTMENT', opp_adjust, needs=('VALIDATE_PBP',))

    # ---------------------------------------------------------- 6 QB (V2 stage 4 + state)
    def qb(rec):
        if mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.qb', str(season)])
        Q, events = QBS.build(season, T)
        ctx['qb_rows'], ctx['qb_events'] = Q, events
        rec['counts'].update(qbs=int(len(Q)), qb_events=int(len(events)))
        for e in events:
            if e.get('event_type') in ('AMBIGUOUS_STARTER',):
                run.warn('PLAYER_QB_METRICS', 'ambiguous starter: team %s' % e.get('team_id'))
        return {}

    run.stage('PLAYER_QB_METRICS', qb, needs=('OPPONENT_ADJUSTMENT',))

    # ---------------------------------------------------------- 7 availability
    def avail(rec):
        tg = G[G.season.eq(season) & G.prediction_ts.eq(T)]
        U = AV.snapshot(season, tw, tg, now)
        ctx['units'] = U
        known = int(U[U.unit.eq('QB')].knowledge.eq('KNOWN').sum()) if len(U) else 0
        rec['counts'].update(teams=int(U.team_id.nunique()) if len(U) else 0, teams_with_report=known)
        if len(U) and known / max(1, U.team_id.nunique()) < 0.25:
            run.warn('AVAILABILITY_STATE', 'official availability reports for only %d of %d teams: UNKNOWN is not healthy'
                     % (known, U.team_id.nunique()))
        return {}

    run.stage('AVAILABILITY_STATE', avail, needs=('INGEST_FINAL_SCORES',))

    # ---------------------------------------------------------- 9-11 team state
    def posteriors(rec):
        prev = _prev_state(store, sw)
        rows, conv, expl = TS.build(season, T, prev=prev)
        ctx['team_rows'], ctx['convergence'], ctx['explanations'] = rows, conv, expl
        flags = TS.movement_flags(rows, prev, explanations=expl) if hasattr(TS, 'movement_flags') else []
        ctx['team_flags'] = flags
        for f in flags:
            run.warn('TEAM_POSTERIORS', 'rating move review: %s %s' % (f.get('team_id'), f.get('flag')))
        rec['counts'].update(teams=int(len(rows)), movement_flags=len(flags),
                             converged=bool(conv.get('converged')), metrics=len(conv.get('metrics', {})))
        num = rows.select_dtypes('number')
        if num.shape[1] and not np.isfinite(num.fillna(0).values).all():
            raise RL.StageError('non-finite team posterior', 'DATA_QUALITY')
        return {}

    run.stage('TEAM_POSTERIORS', posteriors, needs=('OPPONENT_ADJUSTMENT', 'PLAYER_QB_METRICS'))
    run.stage('RECENT_FORM', lambda rec: rec['counts'].update(
        teams_recent=int(ctx['team_rows'].recent_strength.notna().sum()) if 'recent_strength' in ctx['team_rows'] else 0) or {},
        needs=('TEAM_POSTERIORS',))

    # ---------------------------------------------------------- 12 features (V2 elo + stage 5)
    def features(rec):
        if mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.elo'])
            _sub([sys.executable, '-m', 'v2.snapshots', str(season)])
        X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
        X = X[X.season.eq(season)]
        ctx['X_season'] = X
        Xt = X[X.prediction_ts.eq(T)]
        sched = G[G.season.eq(season) & G.prediction_ts.eq(T)]
        missing = sorted(set(sched.game_id.astype(str)) - set(Xt.game_id.astype(str)))
        if missing:
            raise RL.StageError('%d scheduled target games without a feature row: %s' % (len(missing), missing[:5]), 'DATA_QUALITY')
        A, gbm = PJ.PL.load_artifacts(C.MODEL_VERSION)
        ctx['A'], ctx['gbm'], ctx['X'] = A, gbm, Xt
        ctx['features'] = PJ.upcoming_features(Xt, A, T, ctx['versions'])
        rec['counts'].update(target_games=int(len(Xt)), feature_columns=len(PJ.model_inputs(A)))
        return {}

    run.stage('UPCOMING_FEATURES', features, needs=('TEAM_POSTERIORS',))

    def leakage(rec):
        if mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.tests_leakage'])
        return {}

    run.stage('LEAKAGE_TESTS', leakage, needs=('UPCOMING_FEATURES',))

    # ---------------------------------------------------------- 13-15 inference
    def submodels(rec):
        art = PJ.verify_artifact(C.MODEL_VERSION)
        ctx['artifact'] = art
        if not art['ok']:
            raise RL.StageError('artifact does not verify: %s' % art['reason'], 'DATA_QUALITY')
        D = PJ.infer(ctx['X'], ctx['A'], ctx['gbm'])
        ctx['D'] = D
        rec['counts'].update(games=int(len(D)), mean_abs_margin=round(float(D.ens_pred.abs().mean()), 3))
        return {}

    run.stage('PURE_SUBMODELS', submodels, needs=('UPCOMING_FEATURES', 'LEAKAGE_TESTS'))
    run.stage('ENSEMBLE', lambda rec: rec['counts'].update(
        directional_agreement=round(float(ctx['D'].directional_agreement.mean()), 4),
        mean_ens_sd=round(float(ctx['D'].ens_sd.mean()), 3)) or {}, needs=('PURE_SUBMODELS',))
    run.stage('CALIBRATION', lambda rec: rec['counts'].update(
        win_calibration_method=ctx['D'].win_calibration_method.iloc[0] if len(ctx['D']) else None) or {},
        needs=('ENSEMBLE',))

    def uncertainty(rec):
        D = ctx['D']
        rec['counts'].update(mean_sigma=round(float(D.sigma.mean()), 3),
                             mean_expected_error=round(float(D.expected_model_error.mean()), 3))
        return {}

    run.stage('UNCERTAINTY', uncertainty, needs=('CALIBRATION',))

    # ---------------------------------------------------------- degraded modes, records
    def modes_and_records(rec):
        D, V = ctx['D'], ctx.get('validation')
        sh = SRC.health(season, now, games=G, validation=V, lab_quotes_last=_lab_last_quote(season),
                        previous=_read_json(os.path.join(store.dir, 'source_health.json')))
        ctx['source_health'] = sh
        avail_status = next((s['status'] for s in sh['sources'] if s['source'] == 'injury'), None)
        team_q = _team_pbp_quality(V, T)
        mk = _market_lines(season)
        modes = {}
        for _, r in D.iterrows():
            q = min(team_q.get(str(r.home_id), 1.0), team_q.get(str(r.away_id), 1.0))
            modes[str(r.game_id)] = PJ.model_mode(q, avail_status, str(r.game_id) in mk, ctx['artifact']['ok'])
        ctx['modes'] = modes
        prev = _prev_projections(store)
        has_new = _new_games_since(store, G, season)
        recs, changes, flags = PJ.projection_records(D, ctx['features'], run.run_id, ctx['versions'], prev,
                                                     ctx['A'], ctx['gbm'], modes, has_new)
        ctx.update(projections=recs, changes=changes, projection_flags=flags)
        for f in flags:
            run.warn('RELEASE_GATE', 'projection move review: %s %+.1f (bound %.1f)' % (f['game_id'], f['delta'], f['bound']))
        rec['counts'].update(new_projections=len(recs), changed=len(changes), flags=len(flags),
                             modes={m: sum(1 for v in modes.values() if v[0] == m) for m in PJ.MODE_ORDER})
        return {}

    run.stage('PROJECTION_RECORDS', modes_and_records, needs=('UNCERTAINTY',))

    # ---------------------------------------------------------- the gate
    def release(rec):
        D = ctx['D']
        checks = GATE.sanity(D, ctx['features'], G[G.season.eq(season)], T, now,
                             team_rows=ctx.get('team_rows'), team_flags=ctx.get('team_flags'),
                             qb_rows=ctx.get('qb_rows'), market_ok=True)
        g = GATE.release_gate(run, checks, ctx.get('convergence'), ctx.get('artifact'),
                              leakage_ok=run.ok('LEAKAGE_TESTS'), validation=ctx.get('validation'),
                              source_health=ctx.get('source_health'), critical_stages=CRITICAL_STAGES)
        run.gate = g
        rec['counts'].update(checks=len(g['checks']), failed=len(g['failed']))
        if not g['pass']:
            raise RL.StageError('release gate failed: ' + '; '.join(g['failed']), 'DATA_QUALITY', retryable=False)
        return {}

    run.stage('RELEASE_GATE', release, needs=('PROJECTION_RECORDS',))

    # ---------------------------------------------------------- 16 publish + freeze
    def publish(rec):
        rows = PJ.PL.build_rows(season, now, C.MODEL_VERSION, X=ctx['X_season'], A=ctx['A'], gbm=ctx['gbm'])
        # the degraded mode travels with the published row
        for r in rows:
            m = ctx['modes'].get(str(r['game_id']))
            if m:
                r['model_mode'], r['model_modes'] = m
        if mode == 'rebuild':
            ctx['published_rows'] = rows
            return {}
        log = PJ.PL.publish(rows, season, now, C.MODEL_VERSION)
        rec['counts'].update(frozen_new=log['freeze']['frozen_new'], already_frozen=log['freeze']['already_frozen'],
                             refused_overwrites=len(log['freeze']['refused_overwrites']), upcoming=log['upcoming'])
        if log['freeze']['refused_overwrites']:
            run.warn('FREEZE_EARLY', '%d frozen rows differ from this run and were NOT overwritten'
                     % len(log['freeze']['refused_overwrites']))
        return {}

    run.stage('FREEZE_EARLY', publish, needs=('RELEASE_GATE',))

    def write_state(rec):
        v = ctx['versions']
        base = {'model_version': C.MODEL_VERSION, 'feature_version': C.FEATURE_VERSION, 'run_id': run.run_id,
                'data_version': v.get('data_version'), 'pbp_version': v.get('pbp_version'),
                'roster_version': v.get('roster_version'), 'injury_version': v.get('injury_version'),
                'as_of': ids.ts(T)}
        st = {}
        V = ctx.get('validation')
        if V is not None:
            st['game_validation'] = store.write_versioned('game_validation', [dict(r, **{'run_id': run.run_id}) for r in _records(V)])
        P = ctx.get('performance')
        if P is not None:
            st['game_performance'] = store.write_versioned('game_performance', [dict(r, **{'run_id': run.run_id}) for r in _records(P)])
        TR = ctx['team_rows']
        rows = [dict(r, season=season, week=sw, **base) for r in _records(TR)]
        expl = ctx.get('explanations') or {}
        for r in rows:
            r['explanation'] = expl.get(str(r.get('team_id')))
        summ = ctx.get('team_summary')
        if summ is not None and len(summ):
            sm = {str(k): v for k, v in summ.set_index('team_id').to_dict('index').items()}
            for r in rows:
                r['performance_summary'] = sm.get(str(r.get('team_id')))
        st['team_week_state'] = store.write_versioned('team_week_state', rows)
        Q = ctx.get('qb_rows')
        if Q is not None:
            st['qb_week_state'] = store.write_versioned('qb_week_state', [dict(r, season=season, week=sw, **base) for r in _records(Q)])
        store.append_unique('qb_events', [dict(e, event_id='cfbe_' + ids.h(e.get('team_id'), e.get('event_type'), e.get('player_id'), season, sw),
                                               season=season, week=sw, run_id=run.run_id) for e in (ctx.get('qb_events') or [])])
        U = ctx.get('units')
        if U is not None and len(U):
            st['unit_week_state'] = store.write_versioned('unit_week_state', [dict(r, run_id=run.run_id) for r in _records(U)])
        feat_path = os.path.join('upcoming_game_features', 'week_%02d.jsonl' % tw)
        fp = os.path.join(store.dir, feat_path)
        have = {json.loads(l)['feature_snapshot_id'] for l in open(fp)} if os.path.exists(fp) else set()
        fresh = [f for f in ctx['features'] if f['feature_snapshot_id'] not in have]
        from .store import append_jsonl
        append_jsonl(fp, fresh)
        st['features'] = len(fresh)
        st['projections'] = store.append_unique('projections', ctx['projections'])
        st['projection_changes'] = store.append_unique('projection_changes', ctx['changes'])
        rec['counts'].update({k: v for k, v in st.items()})
        return {}

    run.stage('WRITE_STATE', write_state, needs=('FREEZE_EARLY',))

    # ---------------------------------------------------------- 17 market comparison
    def market(rec):
        if mode == 'rebuild':
            return {'_status': 'SKIPPED'}
        _sub([sys.executable, '-m', 'v2.shadow'])
        _sub(['node', os.path.join('..', 'shadow_decisions.js')])
        return {}

    run.stage('MARKET_COMPARISON', market, needs=('FREEZE_EARLY',),
              skip='market comparison runs after the pure projection is published' if mode == 'rebuild' else None)

    # ---------------------------------------------------------- grading + research
    def grade(rec):
        if mode != 'rebuild':
            _sub([sys.executable, '-m', 'v2.learn_week', '--season', str(season)])
        ctx['previous_week'] = _lab_week_metrics(season, sw)
        rec['counts'].update({k: v for k, v in (ctx['previous_week'] or {}).items() if not isinstance(v, (dict, list))})
        return {}

    run.stage('GRADE_PREVIOUS', grade, needs=('INGEST_FINAL_SCORES',))

    def research(rec):
        from . import research as RS
        items = RS.scan(season, store, ctx)
        rec['counts']['items'] = store.append_unique('research', items)
        ctx['research'] = items
        return {}

    run.stage('RESEARCH', research, needs=('GRADE_PREVIOUS',))

    # ---------------------------------------------------------- 18 model lab hand-off
    def lab(rec):
        if mode == 'rebuild':
            return {'_status': 'SKIPPED'}
        chk = _lab_imported(season)
        rec['counts'].update(chk)
        if lab_dispatch:
            lab_dispatch()
        return {}

    run.stage('MODEL_LAB', lab, needs=('FREEZE_EARLY',),
              skip='a rebuild never writes the Model Lab' if mode == 'rebuild' else None)

    # ---------------------------------------------------------- 19 report
    def report(rec):
        from . import report as REP
        if mode != 'rebuild':
            try:
                _sub([sys.executable, '-m', 'v2.monitor'])
            except RL.StageError as e:
                run.warn('HEALTH_REPORT', 'monitor failed: %s' % str(e)[:200])
        rp = REP.weekly(run, ctx, store)
        rec['counts']['report'] = rp
        return {}

    run.stage('HEALTH_REPORT', report, needs=('INGEST_FINAL_SCORES',))
    run.status = 'PUBLISHED' if run.ok('WRITE_STATE') else ('GATE_FAILED' if run.stages.get('RELEASE_GATE', {}).get('status') == 'FAILED' else 'FAILED')
    run.published = run.status == 'PUBLISHED'


class _Noop(Exception):
    pass


# ------------------------------------------------------------------ helpers
def _records(df):
    return [ids.clean(r) for r in df.to_dict('records')] if df is not None and len(df) else []


def _read_json(p):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None


def _prev_state(store, source_week):
    """The newest published team state of the week before `source_week`."""
    rows = [r for r in store.current('team_week_state') if r.get('week') is not None and r['week'] < source_week]
    if not rows:
        return None
    wk = max(r['week'] for r in rows)
    return pd.DataFrame([r for r in rows if r['week'] == wk])


def _prev_projections(store):
    """The newest published projection per game, with its stored inputs."""
    feats = {}
    fdir = os.path.join(store.dir, 'upcoming_game_features')
    if os.path.isdir(fdir):
        for f in sorted(os.listdir(fdir)):
            for line in open(os.path.join(fdir, f)):
                x = json.loads(line)
                feats[x['feature_snapshot_id']] = x['inputs']
    out = {}
    for p in store.read('projections'):
        p = dict(p)
        p['_inputs'] = feats.get(p.get('feature_snapshot_id'))
        out[p['game_id']] = p
    return out


def _new_games_since(store, G, season):
    runs = [r for r in store.read('runs') if r.get('published')]
    if not runs:
        return True
    last = pd.Timestamp(runs[-1]['started_at'])
    g = G[G.season.eq(season) & G.status.eq('FINAL')]
    return bool((g.kickoff_ts > last - pd.Timedelta(hours=6)).any())


def _team_pbp_quality(V, T):
    if V is None or not len(V) or 'pbp_completeness_score' not in V:
        return {}
    fin = V[V.status.isin(['FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'DATA_ERROR'])]
    if 'kickoff_ts' in fin:
        fin = fin[pd.to_datetime(fin.kickoff_ts, utc=True, errors='coerce') < T]
    rows = pd.concat([fin[['home_id', 'pbp_completeness_score']].rename(columns={'home_id': 't'}),
                      fin[['away_id', 'pbp_completeness_score']].rename(columns={'away_id': 't'})]) \
        if {'home_id', 'away_id'} <= set(fin.columns) else pd.DataFrame(columns=['t', 'pbp_completeness_score'])
    return {str(k): float(v) for k, v in rows.groupby('t').pbp_completeness_score.mean().items()}


def _lab_dir(season):
    return os.path.join(REPO, 'football', 'cfb_lab', 'ledger', str(season))


def _jsonl(p):
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p) if l.strip()]


def _lab_results(season):
    out = {}
    for r in sorted(_jsonl(os.path.join(_lab_dir(season), 'results.jsonl')), key=lambda r: r.get('recorded_at') or ''):
        out[str(r['game_id'])] = r
    return out


def _lab_last_quote(season):
    d = os.path.join(_lab_dir(season), 'quotes')
    last = None
    if os.path.isdir(d):
        for f in os.listdir(d):
            for q in _jsonl(os.path.join(d, f)):
                t = q.get('observed_at')
                if t and (last is None or t > last):
                    last = t
    return last


def _market_lines(season):
    try:
        M = pd.read_parquet(common.out_path('stage2', 'market.parquet'), columns=['game_id', 'spread_open', 'spread_close'])
    except Exception:                                  # noqa: BLE001 - no market file is DEGRADED_MARKET
        return set()
    return set(M.loc[M.spread_open.notna() | M.spread_close.notna(), 'game_id'].astype(str))


def _lab_week_metrics(season, week):
    """The previous week's graded OFFICIAL predictions from the Model Lab
    ledger, per model: MAE, RMSE, Brier, CLV, ATS, ROI (graded by the lab)."""
    ev = [e for e in _jsonl(os.path.join(_lab_dir(season), 'evaluations.jsonl'))
          if e.get('week') == week and e.get('origin', 'LIVE') == 'LIVE' and e.get('checkpoint_type') == 'T24'
          and e.get('result_status', 'FINAL') == 'FINAL' and e.get('abs_margin_error') is not None]
    if not ev:
        return {'week': week, 'graded': 0, 'note': 'no graded LIVE official predictions for this week in the Model Lab yet'}
    out = {'week': week, 'graded': len(ev), 'by_model': {}}
    for mv in sorted({e['model_version'] for e in ev}):
        xs = [e for e in ev if e['model_version'] == mv]
        err = np.array([e['margin_error'] for e in xs if e.get('margin_error') is not None], dtype=float)
        br = [e['brier_win'] for e in xs if e.get('brier_win') is not None]
        clv = [e['clv_points'] for e in xs if e.get('clv_points') is not None]
        ats = [e['ats_result'] for e in xs if e.get('ats_result') in ('WIN', 'LOSS', 'PUSH')]
        units = [e.get('hypothetical_units') for e in xs if e.get('hypothetical_units') is not None]
        w, l = ats.count('WIN'), ats.count('LOSS')
        out['by_model'][mv] = {'n': len(xs), 'mae': round(float(np.mean(np.abs(err))), 3) if len(err) else None,
                               'rmse': round(float(np.sqrt(np.mean(err ** 2))), 3) if len(err) else None,
                               'brier': round(float(np.mean(br)), 4) if br else None,
                               'clv_mean': round(float(np.mean(clv)), 3) if clv else None,
                               'ats': '%d-%d-%d' % (w, l, ats.count('PUSH')),
                               'ats_pct': round(w / (w + l), 4) if (w + l) else None,
                               'roi': round(float(np.sum(units) / len(units)), 4) if units else None}
    return out


def _lab_imported(season):
    """Did the Model Lab import the V2 freezes already written? (read-only)"""
    snap = os.path.join(SRC.REPO, 'football', 'cfb_v2', 'snapshots', str(season))
    frozen = set()
    if os.path.isdir(snap):
        for f in os.listdir(snap):
            if f.endswith('.json') and f != 'replay_to_date.json':
                for x in json.load(open(os.path.join(snap, f))).get('rows', []):
                    frozen.add(str(x['row']['game_id']))
    lab = set()
    pdir = os.path.join(_lab_dir(season), 'predictions')
    if os.path.isdir(pdir):
        for f in os.listdir(pdir):
            for p in _jsonl(os.path.join(pdir, f)):
                if p.get('checkpoint_type') == 'WEEKLY_FREEZE' and p.get('origin') == 'LIVE' and p.get('model_version') == C.MODEL_VERSION:
                    lab.add(str(p['game_id']))
    return {'frozen_games': len(frozen), 'imported_by_lab': len(frozen & lab), 'awaiting_import': len(frozen - lab)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', default='weekly', choices=['weekly', 'daily', 'freeze', 'rebuild'])
    ap.add_argument('--season', type=int, default=None)
    ap.add_argument('--now', default=None)
    ap.add_argument('--through-week', type=int, default=None)
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--no-fetch', action='store_true')
    ap.add_argument('--state-root', default=None, help='write state here instead of football/cfb_weekly (rebuilds)')
    a = ap.parse_args()
    if a.mode == 'rebuild' and (a.season is None or a.through_week is None):
        ap.error('rebuild needs --season and --through-week (use v2.weekly.replay for a season replay)')
    rec = run(season=a.season, now=a.now, mode=a.mode, force=a.force, fetch=not a.no_fetch,
              through_week=a.through_week, state_root=a.state_root)
    print(json.dumps({k: rec.get(k) for k in ('run_id', 'status', 'season', 'source_week', 'target_week', 'published',
                                               'warnings_count', 'errors_count')}, sort_keys=True))
    if rec.get('status') in ('FAILED', 'GATE_FAILED', 'LOCKED'):
        sys.exit(1)


if __name__ == '__main__':
    main()
