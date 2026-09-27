"""Step 0 — freeze the decision baseline (cfb_decision_baseline_001).

The baseline is everything the decision science is measured AGAINST: the V2.1
model artifact, the production engine and its parameters, the stage-8 market
layer, the walk-forward prediction file and the market file, and the current
production rule. This module hashes each piece and records the rule values in

    football/cfb_v2/artifacts/decision/cfb_decision_baseline_001/MANIFEST.json

Nothing in the baseline changes. Re-running `python3 -m v2.decision.baseline`
never rewrites the manifest: it VERIFIES every hash and raises on any drift.

    python3 -m v2.decision.baseline            write (first run) or verify
    python3 -m v2.decision.baseline --verify   verify only
"""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import pandas as pd

from .. import config as C
from . import BASELINE_ID, BASE_MODEL_VERSION

RESEARCH = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CFB_V2 = os.path.normpath(os.path.join(RESEARCH, '..'))
REPO = os.path.normpath(os.path.join(CFB_V2, '..', '..'))
ARTIFACTS = os.path.join(CFB_V2, 'artifacts', 'decision')
BASELINE_DIR = os.path.join(ARTIFACTS, BASELINE_ID)
MANIFEST = os.path.join(BASELINE_DIR, 'MANIFEST.json')

FROZEN_FILES = [
    'football/cfb_v2/artifacts/edgedesk_cfb_v2.1.0/MANIFEST.json',
    'football/cfb_v2/engine.js',
    'football/cfb_v2/params.js',
    'football/cfb_v2/research/v2/market.py',
    'football/cfb_v2/research/v2/config.py',
]
# out_h is the V2.1 build (git-ignored); out/ is stale and never read
FROZEN_DATA = {
    'stage7_backtest_predictions': ('stage7', 'backtest_predictions.parquet'),
    'stage2_market': ('stage2', 'market.parquet'),
}
FROZEN_REPORTS = {'backtest_report': ('report', 'backtest.json')}   # t_df and market params by season


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def content_sha256(df, key='game_id'):
    """Hash of the table's CONTENT, independent of parquet writer metadata:
    columns sorted by name, rows sorted by key, pandas row hashes -> sha256."""
    d = df[sorted(df.columns)]
    if key in d:
        d = d.sort_values(key, kind='mergesort')
    h = pd.util.hash_pandas_object(d.reset_index(drop=True), index=False).values
    return hashlib.sha256(h.tobytes()).hexdigest()


def parse_params_js(path=None):
    """The frozen production parameters: the JSON object inside params.js."""
    path = path or os.path.join(CFB_V2, 'params.js')
    s = open(path).read()
    i = s.index('root.EDCfbV2Params = ') + len('root.EDCfbV2Params = ')
    j = s.rindex('; })(')
    return json.loads(s[i:j])


def git_head():
    try:
        return subprocess.check_output(['git', '-C', REPO, 'rev-parse', 'HEAD'], text=True).strip()
    except Exception:           # pragma: no cover
        return None


def snapshot():
    """Every hash and rule value the baseline pins."""
    files = {p: sha256_file(os.path.join(REPO, p)) for p in FROZEN_FILES}
    data = {}
    for k, parts in FROZEN_DATA.items():
        p = os.path.join(C.OUT, *parts)
        df = pd.read_parquet(p)
        data[k] = {'path': 'football/cfb_v2/research/%s/%s' % (os.path.basename(os.path.normpath(C.OUT)), '/'.join(parts)),
                   'file_sha256': sha256_file(p), 'content_sha256': content_sha256(df),
                   'rows': int(len(df)), 'columns': int(df.shape[1])}
    reports = {}
    for k, parts in FROZEN_REPORTS.items():
        p = os.path.join(C.OUT, *parts)
        reports[k] = {'path': 'football/cfb_v2/research/%s/%s' % (os.path.basename(os.path.normpath(C.OUT)), '/'.join(parts)),
                      'file_sha256': sha256_file(p)}
    P = parse_params_js()
    M = P['market']
    rule = M['rule']
    return {
        'files_sha256': files,
        'data': data,
        'reports': reports,
        'production_rule': {
            'bet_enabled': bool(M['bet_enabled']),
            'rule_bet_enabled': bool(rule['bet_enabled']),
            'bet_gap': rule['bet_gap'], 'bet_ev': rule['bet_ev'], 'bet_min_rel': rule['bet_min_rel'],
            'exclude_early': rule['exclude_early'], 'review_gap': rule['review_gap'],
            'lean_ev': rule['lean_ev'], 'lean_gap': rule['lean_gap'],
            'reality_check': rule['reality_check'], 'selection': rule['selection'],
            'grid_size': rule['grid_size'],
            'dispersion_max': M['dispersion_max'], 'stale_minutes': M['stale_minutes'],
            'orientation_gap': M['orientation_gap'], 'orientation_reconcile': M['orientation_reconcile'],
        },
        'production_cover_layer': {'cover': P['cover'], 'clv': P['clv'], 'distribution': P['distribution'],
                                   'reliability': P['reliability'], 'win_calibration_method': P['calibration']['win'].get('method')},
        'historical_convention': ('bet the OPENING consensus at the Tuesday 12:00 UTC freeze at an ASSUMED -110, '
                                  'graded against the final margin; CLV = opener -> close, oriented to the side '
                                  '(v2/market.py). Live: never assume a price (engine.js decide: EV null without one).'),
    }


def write_or_verify(verify_only=False):
    snap = snapshot()
    if os.path.exists(MANIFEST):
        old = json.load(open(MANIFEST))
        drift = []
        for sect in ('files_sha256', 'data', 'reports', 'production_rule', 'production_cover_layer'):
            if old.get(sect) != json.loads(json.dumps(snap[sect])):
                drift.append(sect)
        if drift:
            raise AssertionError('baseline %s DRIFTED in %s — the baseline never changes' % (BASELINE_ID, drift))
        print('[baseline] %s verified: every hash and rule value matches' % BASELINE_ID)
        return old
    if verify_only:
        raise AssertionError('no baseline manifest at %s' % MANIFEST)
    man = {'baseline_id': BASELINE_ID, 'base_model_version': BASE_MODEL_VERSION,
           'created_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'git_head_at_freeze': git_head(),
           'windows': {'dev': list(C.DEV_SEASONS), 'holdout': list(C.HOLDOUT_SEASONS), 'live': C.LIVE_SEASON},
           'statement': ('The frozen decision baseline. The decision-science layer (v2/decision) reads these pieces '
                         'and never writes to them; `python3 -m v2.decision.baseline --verify` and '
                         'tests_decision.py re-hash them.')}
    man.update(snap)
    os.makedirs(BASELINE_DIR, exist_ok=True)
    with open(MANIFEST, 'w') as f:
        json.dump(man, f, indent=1, sort_keys=True)
        f.write('\n')
    print('[baseline] wrote', MANIFEST)
    return man


if __name__ == '__main__':
    write_or_verify(verify_only='--verify' in sys.argv)
