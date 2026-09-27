"""Audit item 1 — freeze the audited state: EDGEDESK_CFB_FINAL_AUDIT_CANDIDATE (phase 1, core model).

    python3 -m v2.audit.snapshot   (from football/cfb_v2/research, CFB_V2_OUT=out_h)

Writes docs/cfb-audit/SNAPSHOT.json. Read-only with respect to everything it hashes.
"""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.normpath(os.path.join(HERE, '..', '..'))
V2 = os.path.normpath(os.path.join(RESEARCH, '..'))
REPO = os.path.normpath(os.path.join(V2, '..', '..'))


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def git(*a):
    return subprocess.run(['git', '-C', REPO] + list(a), capture_output=True, text=True).stdout.strip()


def rel(p):
    return os.path.relpath(p, REPO)


def hash_tree(d, pattern=None):
    out = {}
    for root, _, files in os.walk(d):
        for f in sorted(files):
            if pattern and not f.endswith(pattern):
                continue
            p = os.path.join(root, f)
            out[rel(p)] = sha(p)
    return dict(sorted(out.items()))


def combined(hmap):
    return hashlib.sha256(json.dumps(hmap, sort_keys=True).encode()).hexdigest()


def main():
    sys.path.insert(0, RESEARCH)
    from v2 import config as C
    out = os.environ.get('CFB_V2_OUT', os.path.join(RESEARCH, 'out_h'))
    art = os.path.join(V2, 'artifacts', C.PRODUCTION_MODEL_VERSION)
    A = json.load(open(os.path.join(art, 'models.json')))
    man = json.load(open(os.path.join(art, 'MANIFEST.json')))
    art_check = {f: {'manifest': h, 'actual': sha(os.path.join(art, f)), 'match': sha(os.path.join(art, f)) == h}
                 for f, h in man['files'].items()}
    ptxt = open(os.path.join(V2, 'params.js')).read()
    P = json.loads(ptxt[ptxt.index('{', ptxt.index('EDCfbV2Params')):ptxt.rindex('}; })') + 1])
    feat_C = A['submodels']['C_ridge']['cols']
    feat_D = A['submodels']['D_gbm']['cols']
    feat_S = A['sigma_model']['cols']
    feature_schema = {'feature_version': C.FEATURE_VERSION, 'C_ridge': feat_C, 'D_gbm': feat_D,
                      'TotalE': A['submodels']['TotalE']['cols'], 'sigma_model': feat_S,
                      'dropped_features': list(C.DROPPED_FEATURES),
                      'schema_sha256': combined({'C': feat_C, 'D': feat_D, 'S': feat_S})}
    data_dir = os.environ.get('CFB_V2_DATA', os.path.join(RESEARCH, 'data'))
    data_hashes = {}
    for sub in sorted(os.listdir(data_dir)):
        if sub == 'v1':
            continue
        for f in sorted(os.listdir(os.path.join(data_dir, sub))):
            data_hashes[sub + '/' + f] = sha(os.path.join(data_dir, sub, f))
    cand = json.load(open(os.path.join(V2, 'candidates', 'cfb_v2_candidate_001', 'manifest.json')))
    same_as_c001 = {k: (cand['data_files'].get(k, {}).get('sha256') == v) for k, v in data_hashes.items()}
    training = {rel(os.path.join(out, p)): sha(os.path.join(out, p)) for p in (
        'stage5/cfb_model_training_snapshots.parquet', 'stage5/cfb_market_training_snapshots.parquet',
        'stage7/backtest_predictions.parquet', 'stage2/games.parquet', 'stage2/market.parquet',
        'report/backtest.json', 'report/promotion.json')}
    stale = os.path.join(RESEARCH, 'out')
    stale_info = {}
    if os.path.isdir(stale):
        rb = os.path.join(stale, 'report', 'backtest.json')
        if os.path.exists(rb):
            b = json.load(open(rb))
            stale_info = {'dir': rel(stale), 'model_version': b.get('model_version'),
                          'feature_version': b.get('feature_version'),
                          'stage7_sha256': sha(os.path.join(stale, 'stage7', 'backtest_predictions.parquet'))}
    ob = json.load(open(os.path.join(out, 'report', 'backtest.json')))
    sql = {rel(os.path.join(REPO, 'supabase', f)): sha(os.path.join(REPO, 'supabase', f))
           for f in sorted(os.listdir(os.path.join(REPO, 'supabase'))) if f.startswith('cfb_') and f.endswith('.sql')}
    code = {rel(os.path.join(V2, f)): sha(os.path.join(V2, f)) for f in ('engine.js', 'params.js', 'tests.js',
                                                                         'shadow_decisions.js')
            if os.path.exists(os.path.join(V2, f))}
    code.update(hash_tree(os.path.join(RESEARCH, 'v2'), '.py'))
    code = {k: v for k, v in code.items() if '/audit/' not in k}
    lab = hash_tree(os.path.join(REPO, 'football', 'cfb_lab'), '.js')
    lab.update(hash_tree(os.path.join(REPO, 'football', 'cfb_lab', 'ledger')))
    lab[rel(os.path.join(REPO, 'football', 'cfb_lab', 'config.json'))] = sha(os.path.join(REPO, 'football', 'cfb_lab', 'config.json'))
    dirty = [l for l in git('status', '--porcelain').splitlines()]
    import lightgbm, numpy, pandas, scipy, sklearn, pyarrow
    snap = {
        'snapshot_id': 'EDGEDESK_CFB_FINAL_AUDIT_CANDIDATE',
        'phase': 'PHASE 1 — frozen core model (V2.1 pure model, research pipeline, weekly engine, Model Lab). '
                 'Personnel units, matchup, market intelligence and decision calibration are still being built by '
                 'other agents and are hashed here only as they stood at snapshot time.',
        'created_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'git': {'commit': git('rev-parse', 'HEAD'), 'branch': git('branch', '--show-current'),
                'shallow_clone': git('rev-parse', '--is-shallow-repository') == 'true',
                'earliest_commit_in_clone': git('log', '--reverse', '--format=%h %ad', '--date=iso').splitlines()[0],
                'uncommitted_paths': dirty,
                'note': 'HEAD moves while other agents commit; every hash below is the ground truth, not the commit.'},
        'governance': {'champion_selection': 'NOT_RUN',
                       'champion_selection_note': 'No Model Championship was ever run in this project.',
                       'governance_champion': 'edgedesk_cfb_p4_v1.0.0 (V1)',
                       'audited_candidate': C.PRODUCTION_MODEL_VERSION,
                       'audited_candidate_status': P.get('promotion', {}).get('decision'),
                       'bet_enabled': P['market']['bet_enabled']},
        'production_model_version': C.PRODUCTION_MODEL_VERSION, 'model_version_in_params': P['model_version'],
        'feature_version': C.FEATURE_VERSION, 'trained_through': P.get('trained_through'),
        'database_schema': {'note': 'no schema_version column exists; the DDL files are the schema of record',
                            'files_sha256': sql},
        'model_artifacts': {'dir': rel(art), 'manifest_check': art_check,
                            'params_js_sha256': sha(os.path.join(V2, 'params.js')),
                            'engine_js_sha256': sha(os.path.join(V2, 'engine.js')),
                            'candidate_001_manifest_sha256': sha(os.path.join(V2, 'candidates', 'cfb_v2_candidate_001', 'manifest.json')),
                            'weekly_expected_margin_v1_sha256': sha(os.path.join(V2, 'artifacts', 'weekly', 'expected_margin_v1.json')),
                            'other_artifacts': hash_tree(os.path.join(V2, 'artifacts', 'decision'))},
        'feature_schema': feature_schema,
        'training_dataset': {'build_dir': rel(out), 'build_model_version': ob.get('model_version'),
                             'build_feature_version': ob.get('feature_version'), 'files_sha256': training,
                             'raw_data_combined_sha256': combined(data_hashes), 'raw_data_files': len(data_hashes),
                             'raw_data_identical_to_candidate_001_manifest': all(same_as_c001.values()),
                             'raw_data_sha256': data_hashes},
        'stale_build': stale_info,
        'calibration': {'win_method': P['calibration']['win']['method'],
                        'win_platt_unused': P['calibration']['win']['platt'],
                        'cover_method': C.COVER_CALIBRATION, 'cover_coef': P['cover']['coef'],
                        'cover_rsd_fill': P['cover']['rsd_fill'], 'push_table': P['cover']['push_table']},
        'uncertainty_model': {'t_df': P['distribution']['t_df'],
                              'abs_z_quantiles': P['distribution']['abs_z_quantiles'],
                              'sigma_cols': feat_S,
                              'sigma_model_sha256': combined(A['sigma_model']),
                              'reliability': P['reliability']},
        'ensemble': {'active': list(C.ACTIVE_COMPONENTS), 'method': C.STACK_METHOD, 'weights': A['stack_weights']},
        'market_engine': {'engine_id': 'edgedesk_cfb_v2', 'engine_js_sha256': sha(os.path.join(V2, 'engine.js')),
                          'clv_beta': P['clv']['beta'], 'stale_minutes': P['market']['stale_minutes'],
                          'dispersion_max': P['market']['dispersion_max'],
                          'orientation_guard': [P['market']['orientation_gap'], P['market']['orientation_reconcile']]},
        'decision_policy': {'rule': P['market']['rule'], 'bet_enabled': P['market']['bet_enabled'],
                            'qb_overlay': P['qb'], 'injury_overlay': P['injury'], 'weather_overlay': P['weather']},
        'production_thresholds': {'review_gap': P['market']['rule']['review_gap'],
                                  'bet_gap': P['market']['rule']['bet_gap'], 'bet_ev': P['market']['rule']['bet_ev'],
                                  'bet_min_rel': P['market']['rule']['bet_min_rel'],
                                  'exclude_early': P['market']['rule']['exclude_early'],
                                  'lean_ev': P['market']['rule']['lean_ev'],
                                  'promotion_gates': P.get('promotion')},
        'source_configuration': {'fetch_script_sha256': sha(os.path.join(RESEARCH, 'fetch_v2.sh')),
                                 'config_py_sha256': sha(os.path.join(RESEARCH, 'v2', 'config.py')),
                                 'sources': cand.get('data_sources'),
                                 'pinning': 'none: fetch_v2.sh downloads the current release asset; nothing pins a hash'},
        'code_sha256': code,
        'model_lab_sha256': lab,
        'environment': {'python': sys.version.split()[0], 'lightgbm': lightgbm.__version__, 'numpy': numpy.__version__,
                        'pandas': pandas.__version__, 'scipy': scipy.__version__, 'sklearn': sklearn.__version__,
                        'pyarrow': pyarrow.__version__},
    }
    dst = os.path.join(REPO, 'docs', 'cfb-audit', 'SNAPSHOT.json')
    with open(dst, 'w') as f:
        json.dump(snap, f, indent=1, sort_keys=True)
        f.write('\n')
    print('wrote', rel(dst), 'artifact manifest match:', all(v['match'] for v in art_check.values()),
          'raw data == c001 manifest:', snap['training_dataset']['raw_data_identical_to_candidate_001_manifest'])


if __name__ == '__main__':
    main()
