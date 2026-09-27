"""Freeze a model candidate: a permanent, hash-locked record of exactly what it was.

    python3 -m v2.freeze_candidate <candidate_id> --commit <sha> [--artifacts <model_version>]

Writes football/cfb_v2/candidates/<candidate_id>/ and refuses to touch a
candidate that already exists (a frozen candidate is never overwritten; a
changed model is a NEW candidate):

  manifest.json       code commit, feature version, every tunable, windows,
                      seeds, preprocessing rules, ensemble weights and every
                      calibration object BY SEASON, training row counts,
                      data-source URLs + sha256 of every raw file, and the
                      sha256 of every file below
  predictions.csv.gz  the candidate's frozen walk-forward record: one row per
                      game 2014-2026 with every component, the ensemble, the
                      error model, probabilities, intervals, reliability and
                      the market-layer outputs. NO outcomes: results are
                      joined at evaluation time from the game table.
  artifacts/          copies of the exported model files (linear models,
                      LightGBM text model, meta)
  params.js           copy of the browser parameters the engine ran with

`football/cfb_v2/candidates.test.js` re-hashes every file in every manifest,
so an edited candidate fails CI.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config as C
from . import common

REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

PRED_COLS = ['game_id', 'season', 'week', 'season_type', 'kickoff_ts', 'prediction_ts', 'home_id', 'away_id',
             'neutral_site', 'fcs_game', 'pred_A_adj_eff', 'pred_B_elo', 'pred_C_ridge', 'pred_D_gbm',
             'pred_E_drive', 'pred_total', 'ens_pred', 'ens_equal', 'ens_sd', 'sigma', 'p_home_raw',
             'p_home_platt', 'p_home_iso', 'lo_50', 'hi_50', 'lo_80', 'hi_80', 'lo_95', 'hi_95', 'reliability',
             'line', 'gap_open', 'pc_home_raw', 'pc_home_cal', 'p_side', 'push_p', 'ev', 'side', 'clv_exp',
             'pred_ma', 'ma_weight_model']

SOURCES = {
    'pbp': 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_pbp/play_by_play_<S>.parquet',
    'sched': 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_schedules/cfb_schedules_<S>.parquet',
    'retprod': 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_returning_production/cfb_returning_production_<S>.parquet',
    'talent': 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_team_talent/cfb_team_talent_<S>.parquet',
    'mline': 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_matchup_line/cfb_matchup_line_<S>.parquet',
    'teaminfo': 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/team_info/parquet/cfb_team_info_<S>.parquet',
    'betting': 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/betting/csv/cfb_line_odds.csv.gz',
    'v1': 'football/cfb_p4/research/fetch_data.sh (V1 inputs: schedules, rosters, player stats, pbp, line archive)',
}


def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def data_manifest():
    out = {}
    root = C.DATA
    for d, _, files in os.walk(root):
        rel = os.path.relpath(d, root)
        if rel.startswith('v1' + os.sep + 'out') or rel == os.path.join('v1', 'out'):
            continue
        for f in sorted(files):
            p = os.path.join(d, f)
            k = os.path.relpath(p, root)
            out[k] = {'sha256': sha256(p), 'bytes': os.path.getsize(p)}
    return out


def git(*args):
    try:
        return subprocess.check_output(['git'] + list(args), cwd=REPO_V2, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return None


def config_snapshot():
    keep = {}
    for k in dir(C):
        if k.isupper() and not k.startswith('_'):
            v = getattr(C, k)
            if isinstance(v, (int, float, str, bool, list, tuple, dict, type(None))):
                keep[k] = v
    return json.loads(json.dumps(keep, default=str))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('candidate_id')
    ap.add_argument('--commit', required=True, help='git commit of the code that produced the candidate')
    ap.add_argument('--artifacts', default=C.MODEL_VERSION)
    ap.add_argument('--note', default='')
    a = ap.parse_args()

    cdir = os.path.join(REPO_V2, 'candidates', a.candidate_id)
    if os.path.exists(os.path.join(cdir, 'manifest.json')):
        sys.exit('refusing: candidate %s is frozen already (a changed model is a new candidate)' % a.candidate_id)
    os.makedirs(os.path.join(cdir, 'artifacts'), exist_ok=True)

    rep = json.load(open(common.out_path('report', 'backtest.json')))
    B = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet'))
    cols = [c for c in PRED_COLS if c in B.columns]
    P = B[cols].copy()
    for c in P.columns:
        if P[c].dtype.kind == 'f':
            P[c] = P[c].round(4)
    for c in ('kickoff_ts', 'prediction_ts'):
        P[c] = pd.to_datetime(P[c], utc=True).dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    P = P.sort_values(['season', 'kickoff_ts', 'game_id'])
    pfile = os.path.join(cdir, 'predictions.csv.gz')
    # mtime=0 keeps the gzip byte-identical across runs (the hash is part of the record)
    import gzip
    with open(pfile, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as gz:
        gz.write(P.to_csv(index=False, lineterminator='\n').encode())

    src_art = os.path.join(REPO_V2, 'artifacts', a.artifacts)
    for f in sorted(os.listdir(src_art)):
        shutil.copy2(os.path.join(src_art, f), os.path.join(cdir, 'artifacts', f))
    shutil.copy2(os.path.join(REPO_V2, 'params.js'), os.path.join(cdir, 'params.js'))

    fam = json.load(open(common.out_path('report', 'selected_families.json')))
    shrink = json.load(open(common.out_path('stage4', 'qb_shrinkage.json')))
    varcomp = json.load(open(common.out_path('stage3', 'varcomp.json')))
    train_rows = (B[(B.status.eq('FINAL')) & (~B.fcs_game) & B.margin.notna()]
                  .groupby('season').size().to_dict())
    files = {}
    for d, _, fs in os.walk(cdir):
        for f in sorted(fs):
            if f == 'manifest.json':
                continue
            p = os.path.join(d, f)
            files[os.path.relpath(p, cdir)] = sha256(p)

    man = {
        'candidate_id': a.candidate_id,
        'frozen_at': common.iso(datetime.now(timezone.utc)),
        'note': a.note,
        'model_version': a.artifacts,
        'feature_version': C.FEATURE_VERSION,
        'code': {'commit': a.commit,
                 'tree_football_cfb_v2': git('rev-parse', '%s:football/cfb_v2' % a.commit),
                 'tree_supabase_sql': git('rev-parse', '%s:supabase/cfb_v2_model.sql' % a.commit),
                 'reproduced_from_scratch_at': common.iso(datetime.now(timezone.utc))},
        'seeds': {'global': C.SEED, 'lightgbm': C.SEED, 'bootstrap': C.SEED, 'reality_check': C.SEED},
        'windows': {'burn_in': [C.FIRST_PBP_SEASON, C.FIRST_SNAPSHOT_SEASON - 1],
                    'snapshots_from': C.FIRST_SNAPSHOT_SEASON, 'oof_from': C.FIRST_OOF_SEASON,
                    'stack_from': C.FIRST_STACK_SEASON, 'calibration_from': C.FIRST_CAL_SEASON,
                    'development_tuning': list(C.DEV_SEASONS), 'holdout': list(C.HOLDOUT_SEASONS),
                    'live': C.LIVE_SEASON,
                    'training_rule': 'every fit for season S uses seasons < S only (expanding window)',
                    'artifacts_trained_through': C.LIVE_SEASON - 1},
        'training_rows_fbs_final_by_season': {str(k): int(v) for k, v in train_rows.items()},
        'config': config_snapshot(),
        'selected_families': fam,
        'preprocessing': {
            'garbage_time': 'declared: |score diff| > 38 (Q2), 28 (Q3), 22 (Q4); weight 0; no WP columns',
            'sacks_untagged_seasons': [2013],
            'trench_havoc': 'recomputed from statYardage (provider flags drift)',
            'market_qa': 'drop |line| > 60; drop openers sign-flipped vs close or > 14 pts from close '
                         '(uses the close: see REDTEAM audit)',
            'fcs': 'FBS-vs-FCS rows are predicted but never priced',
            'variance_components': varcomp,
            'qb_shrinkage': shrink,
        },
        'ensemble_weights_by_season': rep.get('stack_weights_by_season'),
        'uncertainty_and_win_calibration_by_season': rep.get('uncertainty_by_season'),
        'win_calibration_choice': rep.get('win_calibration_choice'),
        'market_layer_by_season': rep.get('market_params_by_season'),
        'reliability_ranges': rep.get('reliability_ranges'),
        'betting_rule': rep.get('rule'),
        'headline': rep.get('headline'),
        'promotion': rep.get('promotion'),
        'data_sources': SOURCES,
        'data_files': data_manifest(),
        'files': files,
    }
    common.write_json(os.path.join(cdir, 'manifest.json'), man)
    print('[freeze] %s: %d predictions, %d data files hashed, %d candidate files'
          % (a.candidate_id, len(P), len(man['data_files']), len(files)))


if __name__ == '__main__':
    main()
