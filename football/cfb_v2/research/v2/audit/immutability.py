"""Audit item 4 — historical data immutability and provenance.

    python3 -m v2.audit.immutability    -> $CFB_V2_OUT/audit/immutability.json

What can be tested with what exists locally:
  1. recorded provenance: every hash any artifact recorded for a raw file vs the file now;
     the earliest recording time (nothing older exists: the clone is shallow);
  2. cross-source agreement for the same games: the V2 schedule release (sportsdataverse
     parquet) vs V1's schedule copy (cfbfastR CSV) — ids, date, neutral site, final scores;
  3. play-by-play completeness: the last score in the play-by-play vs the schedule's final
     score (a PBP that stops early or was later corrected shows up here);
  4. the Model Lab's recorded 2026 results (written at the time) vs today's 2026 schedule file;
  5. definition drift inside provider columns across seasons (prior inputs, market books).
"""
import glob
import hashlib
import json
import os

import numpy as np
import pandas as pd

from . import _io

RESEARCH = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.environ.get('CFB_V2_DATA', os.path.join(RESEARCH, 'data'))
V2 = os.path.normpath(os.path.join(RESEARCH, '..'))
REPO = os.path.normpath(os.path.join(V2, '..', '..'))


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def provenance():
    rec = []
    c = json.load(open(os.path.join(V2, 'candidates', 'cfb_v2_candidate_001', 'manifest.json')))
    for f, r in c['data_files'].items():
        p = os.path.join(DATA, f)
        rec.append({'source': 'candidate_001 manifest (%s)' % c['frozen_at'], 'file': f,
                    'match': os.path.exists(p) and sha(p) == r['sha256']})
    e = json.load(open(os.path.join(V2, 'artifacts', 'weekly', 'expected_margin_v1.json')))
    for r in e['training_data']:
        for k, f in (('pbp_sha256', 'pbp/play_by_play_%d.parquet'), ('sched_sha256', 'sched/cfb_schedules_%d.parquet')):
            rec.append({'source': 'weekly/expected_margin_v1.json', 'file': f % r['season'],
                        'match': sha(os.path.join(DATA, f % r['season'])) == r[k]})
    mt = {}
    for sub in os.listdir(DATA):
        for f in glob.glob(os.path.join(DATA, sub, '*')):
            if os.path.isfile(f):
                mt[sub] = min(mt.get(sub, 9e18), os.path.getmtime(f))
    return {'records_checked': len(rec), 'mismatches': [r for r in rec if not r['match']],
            'earliest_recorded_hash_time': c['frozen_at'],
            'local_file_mtime_utc_by_dir': {k: pd.Timestamp(v, unit='s', tz='UTC').isoformat() for k, v in mt.items()},
            'fetch_pins_hashes': False,
            'note': 'No hash, copy or snapshot of any provider file exists from before 2026-09-27; the repository '
                    'clone is shallow (first commit 2026-09-26). Point-in-time immutability of 2009-2025 inputs '
                    'is therefore NOT testable; every historical input is the provider version as downloaded on '
                    '2026-09-27.'}


def cross_source():
    out = []
    for S in range(2014, 2026):
        a = pd.read_parquet(os.path.join(DATA, 'sched', 'cfb_schedules_%d.parquet' % S))
        f = os.path.join(DATA, 'v1', 'sched', 'sched_%d.csv' % S)
        if not os.path.exists(f):
            continue
        b = pd.read_csv(f, low_memory=False)
        a['game_id'] = pd.to_numeric(a.game_id, errors='coerce'); b['game_id'] = pd.to_numeric(b.game_id, errors='coerce')
        a = a.dropna(subset=['game_id']).drop_duplicates('game_id').set_index('game_id')
        b = b.dropna(subset=['game_id']).drop_duplicates('game_id').set_index('game_id')
        fbs = a[(a.home_division.eq('fbs') | a.away_division.eq('fbs'))].index
        j = a.loc[a.index.intersection(b.index).intersection(fbs)]
        k = b.loc[j.index]
        both = j.home_points.notna() & k.home_points.notna()
        r = {'season': S, 'fbs_games_v2': int(len(fbs)), 'in_both': int(len(j)),
             'only_v2': int(len(fbs.difference(b.index))),
             'home_id_mismatch': int((pd.to_numeric(j.home_id) != pd.to_numeric(k.home_id)).sum()),
             'score_mismatch': int(((j.home_points != k.home_points) | (j.away_points != k.away_points))[both].sum()),
             'final_in_one_only': int((j.home_points.notna() != k.home_points.notna()).sum()),
             'start_date_mismatch': int((pd.to_datetime(j.start_date, utc=True) != pd.to_datetime(k.start_date, utc=True)).sum()),
             'neutral_mismatch': int((j.neutral_site.astype(bool) != k.neutral_site.astype(str).str.upper().eq('TRUE')).sum())}
        mm = j[both & ((j.home_points != k.home_points) | (j.away_points != k.away_points))]
        r['examples'] = [{'game_id': int(g), 'v2': [x.home_points, x.away_points],
                          'v1': [k.loc[g, 'home_points'], k.loc[g, 'away_points']]} for g, x in mm.head(5).iterrows()]
        out.append(r)
    return out


def pbp_vs_schedule():
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'))
    G = G[G.status.eq('FINAL')]
    out = []
    for S in range(2009, 2027):
        p = pd.read_parquet(os.path.join(DATA, 'pbp', 'play_by_play_%d.parquet' % S),
                            columns=['game_id', 'end.homeScore', 'end.awayScore', 'game_play_number'])
        p['game_id'] = pd.to_numeric(p.game_id, errors='coerce')
        last = p.groupby('game_id')[['end.homeScore', 'end.awayScore']].max()
        g = G[G.season.eq(S)].set_index('game_id')
        j = g.join(last, how='inner')
        mism = (j['end.homeScore'] != j.home_points) | (j['end.awayScore'] != j.away_points)
        big = mism & (((j['end.homeScore'] - j.home_points).abs() + (j['end.awayScore'] - j.away_points).abs()) >= 7)
        out.append({'season': S, 'final_games': int(len(g)), 'with_pbp': int(len(j)),
                    'pbp_final_score_mismatch': int(mism.sum()), 'mismatch_ge_7pts': int(big.sum()),
                    'share_mismatch': float(mism.mean()) if len(j) else None,
                    'fbs_fbs_mismatch': int((mism & ~j.fcs_game).sum())})
    return out


def lab_results_vs_schedule():
    f = os.path.join(REPO, 'football', 'cfb_lab', 'ledger', '2026', 'results.jsonl')
    if not os.path.exists(f):
        return None
    R = pd.DataFrame([json.loads(l) for l in open(f)])
    R['game_id'] = pd.to_numeric(R.game_id)
    s = pd.read_parquet(os.path.join(DATA, 'sched', 'cfb_schedules_2026.parquet'))
    s['game_id'] = pd.to_numeric(s.game_id, errors='coerce')
    j = R.merge(s[['game_id', 'home_points', 'away_points']], on='game_id', how='left', suffixes=('_lab', '_sched'))
    fin = j[j.status.eq('FINAL')]
    mm = fin[(fin.home_points_lab != fin.home_points_sched) | (fin.away_points_lab != fin.away_points_sched)]
    return {'lab_results': int(len(R)), 'final': int(len(fin)), 'not_in_schedule_or_unscored': int(fin.home_points_sched.isna().sum()),
            'score_mismatch': int(len(mm.dropna(subset=['home_points_sched']))),
            'examples': mm.head(5)[['game_id', 'home_points_lab', 'away_points_lab', 'home_points_sched', 'away_points_sched']].to_dict('records')}


def drift():
    rp = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(os.path.join(DATA, 'retprod', '*.parquet')))])
    tt = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(os.path.join(DATA, 'talent', '*.parquet')))])
    M = _io.preds()
    return {'retprod_def_returning_missing_share': rp.groupby('season').def_returning.apply(lambda x: round(float(x.isna().mean()), 3)).to_dict(),
            'retprod_rows': rp.groupby('season').size().to_dict(),
            'talent_n_recruits_median': tt.groupby('season').n_recruits.median().to_dict(),
            'market_median_books_per_game': M.groupby('season').spread_books.median().to_dict(),
            'market_opener_coverage_fbs_final': _io.fbs_final(M, range(2014, 2027)).groupby('season').line.apply(lambda x: round(float(x.notna().mean()), 3)).to_dict()}


def main():
    out = {'doc': __doc__, 'provenance': provenance(), 'cross_source_schedule': cross_source(),
           'pbp_vs_schedule': pbp_vs_schedule(), 'lab_results_vs_schedule_2026': lab_results_vs_schedule(),
           'definition_drift': drift()}
    _io.write('immutability.json', out)
    print('provenance', {k: v for k, v in out['provenance'].items() if k != 'note'})
    for r in out['cross_source_schedule']:
        print('xsrc', {k: v for k, v in r.items() if k != 'examples'}, r['examples'][:2])
    for r in out['pbp_vs_schedule']:
        print('pbp', r)
    print('lab', out['lab_results_vs_schedule_2026'])
    print('drift', out['definition_drift'])


if __name__ == '__main__':
    main()
