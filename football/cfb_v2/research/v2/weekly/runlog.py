"""Pipeline run tracking for the weekly engine: stages with explicit statuses,
structured logs, error classes, bounded retries, and the run lock.

A run is one execution of the weekly pipeline. Its record (cfb_pipeline_runs)
names the work (`run_key`: season, weeks, versions, data version, mode), the
execution (`run_id`), every stage's status, timing and counts, and the totals
the brief asks for (games expected/final/processed, plays expected/processed,
warnings, errors). Stage statuses:

  OK       the stage did its work
  WARN     it did, with warnings (partial data, a degraded source)
  FAILED   it could not; every stage that depends on it is BLOCKED
  BLOCKED  not run, because an upstream stage failed
  SKIPPED  not needed in this mode, or nothing changed (cost control)

A later stage never runs against a failed upstream stage: `stage()` checks the
declared dependencies before running the body.
"""
import errno
import fcntl
import json
import os
import re
import sys
import time
import traceback

import pandas as pd

from . import ids

STATUSES = ('OK', 'WARN', 'FAILED', 'BLOCKED', 'SKIPPED')
ERROR_CLASSES = ('TRANSIENT', 'DATA_QUALITY', 'AUTH', 'RATE_LIMIT', 'SCHEMA', 'DATABASE', 'UNKNOWN')

# The per-stage summary statuses the run table carries as columns (brief §2),
# each the worst status of the stages it groups.
STAGE_GROUPS = {
    'score_ingestion_status': ('VERIFY_COMPLETED_GAMES', 'INGEST_FINAL_SCORES'),
    'pbp_status': ('VALIDATE_PBP', 'GAME_PERFORMANCE'),
    'drive_status': ('DRIVE_METRICS',),
    'player_status': ('PLAYER_QB_METRICS', 'AVAILABILITY_STATE'),
    'opponent_adjustment_status': ('OPPONENT_ADJUSTMENT',),
    'team_rating_status': ('TEAM_POSTERIORS', 'RECENT_FORM', 'UNCERTAINTY'),
    'projection_status': ('UPCOMING_FEATURES', 'PURE_SUBMODELS', 'ENSEMBLE', 'CALIBRATION', 'RELEASE_GATE', 'FREEZE_EARLY'),
    'market_status': ('MARKET_COMPARISON',),
    'model_lab_status': ('MODEL_LAB', 'GRADE_PREVIOUS'),
}
_SEVERITY = {None: -1, 'SKIPPED': 0, 'OK': 1, 'WARN': 2, 'BLOCKED': 3, 'FAILED': 4}


BLAS_ENV = {'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}


def single_thread_blas(module):
    """Re-execute `python -m module` with single-threaded BLAS unless it already
    is. The rating solves are bit-reproducible only single-threaded (threaded
    BLAS reorders sums: ~1e-12 differences), and a feature snapshot's id hashes
    its inputs, so a threaded run would mint different ids for the same work.
    The variables must be set before numpy loads, hence the re-exec."""
    if all(os.environ.get(k) == v for k, v in BLAS_ENV.items()):
        return
    env = dict(os.environ, **BLAS_ENV)
    os.execve(sys.executable, [sys.executable, '-m', module] + sys.argv[1:], env)


class StageError(Exception):
    """A stage failure with a class (ERROR_CLASSES)."""

    def __init__(self, msg, klass='UNKNOWN', retryable=None):
        super().__init__(msg)
        self.klass = klass
        self.retryable = klass in ('TRANSIENT', 'RATE_LIMIT') if retryable is None else retryable


def _status(s, codes):
    """An HTTP status as a number on its own: '401628374' (an ESPN game id) is not a
    401 and team '2503' is not a 503 (football/cfb_production/taxonomy.js hasStatus)."""
    return re.search(r'(?<![0-9])(%s)(?![0-9])' % '|'.join(codes), s) is not None


def classify_error(e):
    """Map an exception to an error class. Retrying makes sense only for
    TRANSIENT and RATE_LIMIT; a schema or data-quality error is permanent
    and is never retried."""
    if isinstance(e, StageError):
        return e.klass
    s = (type(e).__name__ + ' ' + str(e)).lower()
    if _status(s, ('429',)) or any(k in s for k in ('rate limit', 'too many requests')):
        return 'RATE_LIMIT'
    if _status(s, ('401', '403')) or any(k in s for k in ('unauthor', 'forbidden', 'permission denied', 'authentication', 'authoriz')) \
            or re.search(r'\bauth\b', s):
        return 'AUTH'
    if any(k in s for k in ('deadlock', '40p01')):
        return 'DATABASE'
    if _status(s, ('502', '503', '504')) or any(k in s for k in ('timed out', 'timeout', 'connection', 'temporarily',
                                                                  'reset by peer', 'name resolution', 'network', 'econn')):
        return 'TRANSIENT'
    if any(k in s for k in ('keyerror', 'no such column', 'column', 'schema', 'arrowinvalid', 'dtype')):
        return 'SCHEMA'
    if any(k in s for k in ('deadlock', '40p01', 'psycopg', 'postgrest', 'sqlstate', 'database')):
        return 'DATABASE'
    if any(k in s for k in ('data quality', 'reconcil', 'duplicate', 'nan', 'non-finite', 'assert')):
        return 'DATA_QUALITY'
    return 'UNKNOWN'


def retry(fn, attempts=4, base=2.0, sleep=time.sleep, on_retry=None):
    """Bounded exponential backoff (base, 2base, 4base, ...) for TRANSIENT and
    RATE_LIMIT errors only; anything else raises at once."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:                       # noqa: BLE001 - classified below
            last = e
            k = classify_error(e)
            if k not in ('TRANSIENT', 'RATE_LIMIT') or i == attempts - 1:
                raise
            if on_retry:
                on_retry(i + 1, k, e)
            sleep(base * (2 ** i))
    raise last


class RunLock:
    """An exclusive, non-blocking file lock: two weekly runs never write team
    state at once. The workflow's concurrency group is the first guard; this
    is the second (manual runs, a local rebuild beside a scheduled run)."""

    def __init__(self, path):
        self.path = path
        self.fh = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
        self.fh = open(self.path, 'a+')
        try:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            self.fh.close()
            self.fh = None
            if e.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                raise StageError('another weekly run holds %s' % self.path, 'DATABASE', retryable=False)
            raise
        self.fh.seek(0); self.fh.truncate()
        self.fh.write(json.dumps({'pid': os.getpid(), 'at': ids.ts(pd.Timestamp.now(tz='UTC'))}))
        self.fh.flush()
        return self

    def __exit__(self, *exc):
        if self.fh:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            self.fh.close()
        return False


class PipelineRun:
    def __init__(self, season, source_week, target_week, mode, model_version, feature_version,
                 started_at=None, log_path=None, clock=None):
        self.clock = clock or (lambda: pd.Timestamp.now(tz='UTC'))
        self.started_at = pd.Timestamp(started_at) if started_at is not None else self.clock()
        self.season, self.source_week, self.target_week = season, source_week, target_week
        self.mode, self.model_version, self.feature_version = mode, model_version, feature_version
        self.data_version = None
        self.stages = {}            # name -> record
        self.order = []
        self.metrics = {}           # observability counters
        self.warnings, self.errors = [], []
        self.log_path = log_path
        self.status = 'RUNNING'
        self.gate = None
        self.published = False

    # ------------------------------------------------------------ identity
    @property
    def run_key(self):
        return ids.h('run', self.season, self.source_week, self.target_week, self.model_version,
                     self.feature_version, self.data_version, self.mode)

    @property
    def run_id(self):
        return 'cfbw_' + ids.h(self.run_key, self.started_at)

    # ------------------------------------------------------------ logging
    def log(self, stage, event, **kw):
        rec = {'at': ids.ts(self.clock()), 'stage': stage, 'event': event}
        rec.update(ids.clean(kw))
        line = json.dumps(rec, sort_keys=True)
        if os.environ.get('CFB_WEEKLY_QUIET') != '1':
            print('[weekly] ' + line, flush=True)
        if self.log_path:
            os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
            with open(self.log_path, 'a') as f:
                f.write(line + '\n')

    def warn(self, stage, msg, **kw):
        self.warnings.append({'stage': stage, 'message': msg, **ids.clean(kw)})
        self.log(stage, 'warning', message=msg, **kw)

    def count(self, key, n=1):
        self.metrics[key] = self.metrics.get(key, 0) + n

    # ------------------------------------------------------------ stages
    def stage(self, name, fn, needs=(), skip=None):
        """Run one stage. `needs`: stage names that must be OK/WARN. `skip`: a
        reason string to record SKIPPED without running. Returns the body's
        result (or None when not run)."""
        rec = {'stage': name, 'status': None, 'started_at': None, 'finished_at': None, 'ms': None,
               'counts': {}, 'warnings': [], 'error': None, 'error_class': None, 'needs': list(needs)}
        self.stages[name] = rec
        self.order.append(name)
        bad = [n for n in needs if self.stages.get(n, {}).get('status') not in ('OK', 'WARN', 'SKIPPED')]
        if bad:
            rec['status'] = 'BLOCKED'
            rec['error'] = 'upstream not OK: ' + ', '.join('%s=%s' % (n, self.stages.get(n, {}).get('status')) for n in bad)
            self.log(name, 'blocked', reason=rec['error'])
            return None
        if skip:
            rec['status'] = 'SKIPPED'
            rec['error'] = skip
            self.log(name, 'skipped', reason=skip)
            return None
        t0 = time.time()
        rec['started_at'] = ids.ts(self.clock())
        self.log(name, 'start')
        n_warn = len(self.warnings)
        try:
            out = fn(rec)
            rec['status'] = 'WARN' if (len(self.warnings) > n_warn or rec['warnings']) else 'OK'
            if isinstance(out, dict) and out.get('_status') in STATUSES:
                rec['status'] = out['_status']
        except Exception as e:                       # noqa: BLE001 - recorded, classified
            out = None
            rec['status'] = 'FAILED'
            rec['error'] = '%s: %s' % (type(e).__name__, str(e)[:500])
            rec['error_class'] = classify_error(e)
            rec['trace'] = traceback.format_exc().splitlines()[-6:]
            self.errors.append({'stage': name, 'class': rec['error_class'], 'message': rec['error']})
        rec['warnings'] = rec['warnings'] + [w['message'] for w in self.warnings[n_warn:]]
        rec['finished_at'] = ids.ts(self.clock())
        rec['ms'] = int((time.time() - t0) * 1000)
        self.log(name, 'finish', status=rec['status'], ms=rec['ms'], counts=rec['counts'],
                 error=rec['error'], error_class=rec['error_class'])
        return out

    def group_status(self, group):
        worst = None
        for n in STAGE_GROUPS[group]:
            s = self.stages.get(n, {}).get('status')
            if s is not None and _SEVERITY[s] > _SEVERITY[worst]:
                worst = s
        return worst

    def ok(self, name):
        return self.stages.get(name, {}).get('status') in ('OK', 'WARN')

    # ------------------------------------------------------------ the record
    def record(self, versions=None, totals=None):
        rec = {
            'run_id': self.run_id, 'run_key': self.run_key, 'season': self.season,
            'source_week': self.source_week, 'target_week': self.target_week, 'mode': self.mode,
            'started_at': ids.ts(self.started_at), 'completed_at': ids.ts(self.clock()),
            'model_version': self.model_version, 'feature_version': self.feature_version,
            'data_version': self.data_version, 'status': self.status, 'published': self.published,
        }
        for g in STAGE_GROUPS:
            rec[g] = self.group_status(g)
        t = {'games_expected': None, 'games_final': None, 'games_processed': None,
             'plays_expected': None, 'plays_processed': None}
        t.update(totals or {})
        rec.update(t)
        rec['warnings_count'] = len(self.warnings)
        rec['errors_count'] = len(self.errors)
        rec['versions'] = versions or {}
        rec['gate'] = self.gate
        rec['metrics'] = self.metrics
        rec['stages'] = [self.stages[n] for n in self.order]
        rec['errors'] = self.errors
        rec['warnings'] = self.warnings[:200]
        return ids.clean(rec)
