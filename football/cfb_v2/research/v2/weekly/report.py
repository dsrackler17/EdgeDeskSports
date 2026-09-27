"""EDGEDESK CFB WEEKLY MODEL REFRESH — the internal report of one run
(football/cfb_weekly/<season>/reports/week_NN.{json,md}). Everything in it is
read from the run's own records; nothing is recomputed or narrated.
"""
import json
import os

import numpy as np
import pandas as pd

from . import ids
from .sources import REPO


def _f(x, k=1, sign=False):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return '—'
    return ('%+.' + str(k) + 'f' if sign else '%.' + str(k) + 'f') % x


def _movers(rows, prev, n=8):
    if rows is None or not len(rows) or prev is None or not len(prev) or 'overall_mean' not in rows:
        return [], [], []
    a = rows.set_index(rows.team_id.astype(str))
    b = prev.set_index(prev.team_id.astype(str))
    j = a.join(b[['overall_mean', 'overall_sd']].rename(columns={'overall_mean': 'prev_mean', 'overall_sd': 'prev_sd'}), how='inner')
    j['d_mean'] = j.overall_mean - j.prev_mean
    j['d_sd'] = j.overall_sd - j.prev_sd
    name = j['team'] if 'team' in j else j.index.to_series()
    j['name'] = name
    cols = ['name', 'overall_mean', 'd_mean', 'overall_sd', 'd_sd']
    rise = j.sort_values('d_mean', ascending=False).head(n)[cols].reset_index().to_dict('records')
    fall = j.sort_values('d_mean').head(n)[cols].reset_index().to_dict('records')
    unc = j.reindex(j.d_sd.abs().sort_values(ascending=False).index).head(n)[cols].reset_index().to_dict('records')
    return rise, fall, unc


def weekly(run, ctx, store):
    season, sw, tw = ctx['season'], ctx.get('source_week'), ctx.get('target_week')
    rows = ctx.get('team_rows')
    prev = None
    try:
        from .run import _prev_state
        prev = _prev_state(store, sw) if sw is not None else None
    except Exception:                                   # noqa: BLE001 - the report never fails the run
        prev = None
    rise, fall, unc = _movers(rows, prev)
    V = ctx.get('validation')
    fin = V[V.status.isin(['FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'DATA_ERROR'])] if V is not None and len(V) else None
    sh = ctx.get('source_health') or {}
    srcs = {s['source']: s for s in sh.get('sources', [])}
    D = ctx.get('D')
    dec = _decisions(season)
    hi_unc = []
    if D is not None and len(D):
        top = D.sort_values('sigma', ascending=False).head(8)
        hi_unc = [{'game_id': str(r.game_id), 'matchup': '%s @ %s' % (r.get('away_team'), r.get('home_team')),
                   'sigma': round(float(r.sigma), 2), 'drivers': r.get('uncertainty_drivers')} for _, r in top.iterrows()]
    body = ids.clean({
        'title': 'EDGEDESK CFB WEEKLY MODEL REFRESH', 'season': season, 'source_week': sw, 'target_week': tw,
        'run_id': run.run_id, 'status': run.status if run.status != 'RUNNING' else ('PUBLISHED' if run.ok('WRITE_STATE') else 'IN_PROGRESS'),
        'model_version': run.model_version, 'feature_version': run.feature_version, 'data_version': run.data_version,
        'generated_at': ids.ts(pd.Timestamp.now(tz='UTC')), 'freeze_instant': ids.ts(ctx.get('T')),
        'data': {
            'games_processed': int(len(fin)) if fin is not None else None,
            'validation': V.status.value_counts().to_dict() if V is not None and len(V) else {},
            'pbp_coverage': (srcs.get('pbp') or {}).get('coverage'),
            'pbp_error_rate': (srcs.get('pbp') or {}).get('error_rate'),
            'availability_coverage': (srcs.get('injury') or {}).get('coverage'),
            'market_status': (srcs.get('market') or {}).get('status'),
            'sources': [{'source': s['source'], 'status': s['status'], 'freshness_hours': s.get('freshness_hours'),
                         'coverage': s.get('coverage')} for s in sh.get('sources', [])],
        },
        'rating_changes': {'largest_rises': rise, 'largest_falls': fall, 'largest_uncertainty_changes': unc,
                           'review_flags': ctx.get('team_flags') or []},
        'qb_changes': ctx.get('qb_events') or [],
        'model_health': {
            'pipeline_status': {n: s['status'] for n, s in run.stages.items()},
            'opponent_adjustment': {k: v for k, v in (ctx.get('convergence') or {}).items() if k != 'metrics'},
            'gate': (run.gate or {}).get('pass'), 'gate_failed': (run.gate or {}).get('failed'),
            'artifact': (ctx.get('artifact') or {}).get('ok'), 'warnings': len(run.warnings), 'errors': len(run.errors),
        },
        'previous_week': ctx.get('previous_week'),
        'upcoming_week': {
            'games_projected': int(len(D)) if D is not None else 0,
            'decisions': dec.get('counts') if dec else None,
            'decision_note': 'BET/LEAN/RESEARCH/PASS come from the market layer on frozen rows (shadow_decisions.js)',
            'high_uncertainty_games': hi_unc,
            'model_modes': {m: sum(1 for v in (ctx.get('modes') or {}).values() if v[0] == m)
                            for m in ('FULL', 'DEGRADED_MARKET', 'DEGRADED_AVAILABILITY', 'DEGRADED_PBP', 'FALLBACK')},
        },
        'projection_changes': (ctx.get('changes') or [])[:20],
        'projection_review_flags': ctx.get('projection_flags') or [],
        'performance_vs_expectation': _perf_table(ctx.get('team_summary')),
        'research_flags': ctx.get('research') or [],
        'policy': 'State update only. No weights, features, calibration or ensemble changed; retraining happens only '
                  'as a challenger version (docs/cfb-weekly/RUNBOOK.md).',
    })
    d = os.path.join(store.dir, 'reports')
    os.makedirs(d, exist_ok=True)
    name = 'week_%02d' % (tw if tw is not None else 0)
    with open(os.path.join(d, name + '.json'), 'w') as f:
        json.dump(body, f, indent=1, sort_keys=True)
        f.write('\n')
    with open(os.path.join(d, name + '.md'), 'w') as f:
        f.write(markdown(body))
    return os.path.join('reports', name)


def _decisions(season):
    p = os.path.join(REPO, 'football', 'cfb_v2', 'shadow', str(season), 'decisions.json')
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None


def _perf_table(S, n=10):
    if S is None or not len(S):
        return []
    cols = [c for c in ('team_id', 'team', 'record', 'scoreboard_margin', 'performance_margin', 'turnover_luck_index',
                        'close_game_record', 'explosive_dependency_score') if c in S.columns]
    X = S[cols].copy()
    if 'scoreboard_margin' in X and 'performance_margin' in X:
        X['scoreboard_minus_performance'] = X.scoreboard_margin - X.performance_margin
        X = X.reindex(X.scoreboard_minus_performance.abs().sort_values(ascending=False).index)
    return X.head(n).to_dict('records')


def markdown(b):
    L = ['# %s' % b['title'], '',
         'SOURCE WEEK: %s  ·  TARGET WEEK: %s  ·  season %s' % (b['source_week'], b['target_week'], b['season']), '',
         'Run `%s` — **%s**. Model `%s`, features `%s`, data `%s`. Freeze instant %s.'
         % (b['run_id'], b['status'], b['model_version'], b['feature_version'], (b['data_version'] or '')[:12], b['freeze_instant']), '',
         '## Data', '']
    d = b['data']
    L.append('- games processed: %s · validation %s' % (d['games_processed'], ', '.join('%s %s' % kv for kv in sorted(d['validation'].items()))))
    L.append('- PBP coverage %s · PBP error rate %s · availability coverage %s · market %s'
             % (d['pbp_coverage'], d['pbp_error_rate'], d['availability_coverage'], d['market_status']))
    L += ['', '| source | status | freshness (h) | coverage |', '|---|---|---|---|']
    for s in d['sources']:
        L.append('| %s | %s | %s | %s |' % (s['source'], s['status'], s.get('freshness_hours') if s.get('freshness_hours') is not None else '—',
                                          s.get('coverage') if s.get('coverage') is not None else '—'))
    rc = b['rating_changes']
    for title, key in (('Largest rises', 'largest_rises'), ('Largest falls', 'largest_falls'),
                       ('Largest uncertainty changes', 'largest_uncertainty_changes')):
        L += ['', '## %s (overall, points vs an average FBS team)' % title, '',
              '| team | rating | change | SD | SD change |', '|---|---|---|---|---|']
        for r in rc[key]:
            L.append('| %s | %s | %s | %s | %s |' % (r.get('name'), _f(r.get('overall_mean')), _f(r.get('d_mean'), sign=True),
                                                    _f(r.get('overall_sd')), _f(r.get('d_sd'), 2, sign=True)))
        if not rc[key]:
            L.append('| — | no previous state to compare | | | |')
    if rc['review_flags']:
        L += ['', '**Rating moves flagged for review:** ' + '; '.join('%s (%s)' % (f.get('team_id'), f.get('flag')) for f in rc['review_flags'])]
    L += ['', '## QB changes', '']
    L += ['- %s: %s %s%s' % (e.get('team_id'), e.get('event_type'), e.get('player_name') or e.get('player_id') or '',
                             ' — %s' % e.get('detail') if e.get('detail') else '') for e in b['qb_changes'][:30]] or ['- none detected']
    h = b['model_health']
    L += ['', '## Model health', '',
          '- gate: **%s**%s · artifact verified: %s · warnings %s · errors %s'
          % ('PASS' if h['gate'] else 'FAIL', (' (' + '; '.join(h['gate_failed']) + ')') if h['gate_failed'] else '',
             h['artifact'], h['warnings'], h['errors']),
          '- opponent adjustment: %s' % json.dumps(h['opponent_adjustment'], sort_keys=True),
          '- stages: ' + ', '.join('%s %s' % kv for kv in h['pipeline_status'].items())]
    pw = b.get('previous_week') or {}
    L += ['', '## Previous week (graded by the Model Lab, OFFICIAL LIVE predictions)', '']
    if pw.get('by_model'):
        L += ['| model | n | MAE | RMSE | Brier | CLV | ATS | ROI |', '|---|---|---|---|---|---|---|---|']
        for m, x in pw['by_model'].items():
            L.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (m, x['n'], _f(x['mae'], 2), _f(x['rmse'], 2), _f(x['brier'], 4),
                                                                _f(x['clv_mean'], 2), x['ats'], _f(x['roi'], 3)))
    else:
        L.append('- %s' % (pw.get('note') or 'no graded predictions yet'))
    u = b['upcoming_week']
    L += ['', '## Upcoming week', '', '- games projected: %s · decisions: %s · model modes: %s'
          % (u['games_projected'], u['decisions'], u['model_modes']), '', 'High-uncertainty games:', '']
    L += ['- %s (sigma %s): %s' % (g['matchup'], g['sigma'], ', '.join(g['drivers'] or [])) for g in u['high_uncertainty_games']] or ['- none']
    if b['projection_changes']:
        L += ['', '## Projection changes (why the pure number moved)', '']
        for c in b['projection_changes'][:12]:
            r = c['projection_change_reason']
            L.append('- game %s: %+.2f → %+.2f (%+.2f): %s' % (c['game_id'], c['from_margin'], c['to_margin'], r['delta_margin'],
                                                          ', '.join('%s %+.2f' % (x['family'], x['points']) for x in r['by_family'][:4])))
    if b['performance_vs_expectation']:
        L += ['', '## Record vs underlying performance (largest gaps)', '',
              '| team | record | scoreboard margin | performance margin | turnover luck | close games | explosive dependency |',
              '|---|---|---|---|---|---|---|']
        for r in b['performance_vs_expectation']:
            L.append('| %s | %s | %s | %s | %s | %s | %s |' % (r.get('team') or r.get('team_id'), r.get('record'),
                     _f(r.get('scoreboard_margin'), sign=True), _f(r.get('performance_margin'), sign=True),
                     _f(r.get('turnover_luck_index'), sign=True), r.get('close_game_record'), _f(r.get('explosive_dependency_score'), 2)))
    L += ['', '## Research flags', '']
    L += ['- %s (%s): n %s, mean residual %s, 95%% CI %s — %s' % (x['pattern'], x['origin'], x['n'], x['mean_residual'], x['ci95'], x['status'])
          for x in b['research_flags']] or ['- none crossed the evidence bar (n >= 50, |z| >= 2)']
    L += ['', '> ' + b['policy'], '']
    return '\n'.join(L)
