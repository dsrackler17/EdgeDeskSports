"""Data versions and source health for the weekly engine.

DATA VERSIONS. Every input file the run reads is named by the sha256 of its
bytes. The run's `data_version` hashes those together, and every state row and
projection carries the component versions (pbp_version, schedule_version,
roster_version, injury_version, ...). If a provider later corrects historical
play-by-play, the new file has a new hash, the next run has a new
data_version, and any state it changes is written as a new version that
supersedes the old one. The original prediction still names the version it was
made from.

SOURCE HEALTH. For each critical source: freshness, coverage, error rate and
the last successful ingestion, with a status:
  HEALTHY | STALE | DEGRADED | MISSING | NOT_CONFIGURED | NOT_USED_BY_MODEL
The status feeds the run's degraded modes and the Model Lab's data quality;
a failed source is never reported as "no data".
"""
import json
import os

import pandas as pd

from . import ids

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.abspath(os.path.join(HERE, '..', '..'))
REPO = os.path.abspath(os.path.join(RESEARCH, '..', '..', '..'))


def data_dir():
    return os.environ.get('CFB_V2_DATA', os.path.join(RESEARCH, 'data'))


def season_paths(season):
    d = data_dir()
    return {
        'pbp': [os.path.join(d, 'pbp', 'play_by_play_%d.parquet' % season)],
        'schedule': [os.path.join(d, 'sched', 'cfb_schedules_%d.parquet' % season)],
        'market': [os.path.join(d, 'mline', 'ml_%d.parquet' % season)],
        'talent': [os.path.join(d, 'talent', 'tt_%d.parquet' % season)],
        'retprod': [os.path.join(d, 'retprod', 'rp_%d.parquet' % season)],
        'roster': [os.path.join(REPO, 'football', 'rosters', 'fbs_%d_espn.json' % season)],
        'injury': [os.path.join(REPO, 'football', 'availability', 'current.json')],
        'qb_status': [os.path.join(REPO, 'football', 'starters', 'cfb_%d.json' % season)],
        'weather': [os.path.join(REPO, 'football', 'venues', 'forecasts.json')],
    }


# which sources the pure model reads (the rest inform data quality only)
MODEL_INPUTS = {'pbp', 'schedule', 'talent', 'retprod'}
CRITICAL = ('schedule', 'pbp', 'roster', 'injury', 'qb_status', 'market', 'weather')


def versions(season, prior_seasons=()):
    """{name}_version for every source, plus data_version over the pure-model
    inputs of this and the given prior seasons (the ratings' priors read them)."""
    out = {}
    for name, paths in season_paths(season).items():
        hs = [ids.file_hash(p) for p in paths]
        out[name + '_version'] = ids.h(*hs) if any(hs) else None
    prior = []
    for s in sorted(prior_seasons):
        for name in ('pbp', 'schedule'):
            prior.extend(ids.file_hash(p) for p in season_paths(s)[name])
    out['history_version'] = ids.h(*prior) if prior else None
    out['data_version'] = ids.h(*(out.get(k + '_version') for k in sorted(MODEL_INPUTS)), out['history_version'])
    return out


def _json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _age_h(now, t):
    """Hours between a file's time and the run's as-of instant. None when either
    is missing, or when the file postdates the as-of instant (a historical
    rebuild reads today's files: their age at T is not defined)."""
    if t is None:
        return None
    try:
        a = round((pd.Timestamp(now) - pd.Timestamp(t)).total_seconds() / 3600.0, 2)
    except (ValueError, TypeError):
        return None
    return a if a >= 0 else None


def health(season, now, games=None, validation=None, lab_quotes_last=None, previous=None):
    """Source status for this run. `games`: the stage-2 games frame (for the
    schedule and PBP coverage); `validation`: validate.validate_games output
    (for the PBP error rate); `lab_quotes_last`: the Model Lab's newest quote
    time; `previous`: last run's source_health (for last_successful_ingestion)."""
    now = pd.Timestamp(now)
    P = season_paths(season)
    prev = {s['source']: s for s in (previous or {}).get('sources', [])}
    out = []

    def rec(name, status, freshness_h=None, coverage=None, error_rate=None, detail=None, bound_h=None):
        paths = P.get(name, [])
        v = ids.h(*[ids.file_hash(p) for p in paths]) if paths else None
        p = prev.get(name, {})
        ok_now = status in ('HEALTHY', 'NOT_USED_BY_MODEL')
        last_ok = ids.ts(now) if ok_now else p.get('last_successful_ingestion')
        out.append(ids.clean({'source': name, 'status': status, 'version': v, 'freshness_hours': freshness_h,
                              'freshness_bound_hours': bound_h, 'coverage': coverage, 'error_rate': error_rate,
                              'last_successful_ingestion': last_ok, 'used_by_pure_model': name in MODEL_INPUTS,
                              'critical': name in CRITICAL, 'detail': detail}))

    # schedule/results: every game past kickoff + 36 h should have a final or a void status
    if games is not None and len(games):
        g = games[games.season.eq(season)]
        due = g[g.kickoff_ts < now - pd.Timedelta(hours=36)]
        missing = int((due.status.eq('SCHEDULED')).sum()) if 'status' in due else 0
        cov = round(1 - missing / len(due), 4) if len(due) else None
        rec('schedule', 'HEALTHY' if missing == 0 else ('STALE' if missing / max(1, len(due)) < 0.05 else 'DEGRADED'),
            coverage=cov, detail='%d games past kickoff + 36 h without a final score' % missing)
    else:
        rec('schedule', 'MISSING' if not os.path.exists(P['schedule'][0]) else 'DEGRADED', detail='no games frame')

    # play-by-play: coverage of final games, and the validation error rate
    if validation is not None and len(validation):
        v = validation[validation.in_scope] if 'in_scope' in validation else validation   # games with an FBS team
        fin = v[v.status.isin(['FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'DATA_ERROR'])]
        with_pbp = int((fin.pbp_plays.fillna(0) > 0).sum()) if 'pbp_plays' in fin else 0
        cov = round(with_pbp / len(fin), 4) if len(fin) else None
        err = round(float(fin.status.eq('DATA_ERROR').mean()), 4) if len(fin) else None
        part = round(float(fin.status.eq('FINAL_PARTIAL_DATA').mean()), 4) if len(fin) else None
        st = 'HEALTHY'
        if cov is not None and cov < 0.95:
            st = 'DEGRADED'
        if err is not None and err > 0.05:
            st = 'DEGRADED'
        rec('pbp', st if os.path.exists(P['pbp'][0]) else 'MISSING', coverage=cov, error_rate=err,
            detail='final games with play-by-play; DATA_ERROR share %s, partial share %s' % (err, part))
    else:
        rec('pbp', 'HEALTHY' if os.path.exists(P['pbp'][0]) else 'MISSING', detail='not validated this run')

    # roster (informational for the pure model)
    r = _json(P['roster'][0])
    if r is None:
        rec('roster', 'MISSING', detail='football/rosters/fbs_%d_espn.json absent' % season)
    else:
        t = r.get('generated_at') or r.get('retrieved_at')
        a = _age_h(now, t)
        rec('roster', 'HEALTHY' if a is not None and a <= 24 * 8 else 'STALE', freshness_h=a, bound_h=24 * 8,
            detail='weekly roster sync (Mon 10:00 UTC)')

    # injuries / availability
    av = _json(P['injury'][0])
    if av is None:
        rec('injury', 'MISSING', detail='football/availability/current.json absent')
    else:
        a = _age_h(now, av.get('generated_at'))
        teams = av.get('team_count') or 0
        official = av.get('teams_with_official') or 0
        failed = av.get('failed_sources') or 0
        st = 'HEALTHY'
        if a is None or a > 12:
            st = 'STALE'
        if teams and official / teams < 0.25:
            st = 'DEGRADED'
        rec('injury', st, freshness_h=a, bound_h=12, coverage=round(official / teams, 4) if teams else None,
            detail='%d of %d teams with an official report; %d failed sources; not a pure-model input'
                   % (official, teams, failed))

    # QB status (starters)
    qs = _json(P['qb_status'][0])
    if qs is None:
        rec('qb_status', 'MISSING', detail='football/starters/cfb_%d.json absent' % season)
    else:
        a = _age_h(now, qs.get('generated_at'))
        teams = qs.get('teams') or {}
        known = sum(1 for t in teams.values() if isinstance(t, dict) and (t.get('state') or t.get('status')) not in (None, 'UNKNOWN'))
        rec('qb_status', 'HEALTHY' if a is not None and a <= 36 else 'STALE', freshness_h=a, bound_h=36,
            coverage=round(known / len(teams), 4) if teams else None,
            detail='starter context; the pure model derives the expected starter from play-by-play')

    # odds: the Model Lab's newest captured quote
    if lab_quotes_last:
        a = _age_h(now, lab_quotes_last)
        rec('market', 'HEALTHY' if a is not None and a <= 6 else 'STALE', freshness_h=a, bound_h=6,
            detail='newest quote in the Model Lab ledger; never a pure-model input')
    else:
        rec('market', 'HEALTHY' if os.path.exists(P['market'][0]) else 'MISSING',
            detail='CFBD consensus file only; never a pure-model input')

    # weather: available for the venue layer, not an input of V2.1
    w = _json(P['weather'][0])
    if w is None:
        rec('weather', 'NOT_CONFIGURED', detail='no forecasts file')
    else:
        a = _age_h(now, w.get('generated_at'))
        rec('weather', 'NOT_USED_BY_MODEL', freshness_h=a,
            detail='football/venues/forecasts.json; V2.1 has no weather input (adding one is a model change)')

    return {'season': season, 'as_of': ids.ts(now), 'sources': out,
            'critical_failures': [s['source'] for s in out if s['critical'] and s['status'] in ('MISSING',)
                                  and s['used_by_pure_model']]}
