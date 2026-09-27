"""The model input contract and the feature distribution monitor (brief 33-35;
docs/cfb-production/CANONICAL.md §3-4).

The contract is declared in football/cfb_production/contract/input_contract.json:
for every input the frozen artifact reads, its type, null policy, missing
indicator and what the model would do with a null. The numeric ranges come
from the training reference (feature_reference_<model>.json, built once from
the training rows by `--build-reference`) by the declared rule:

  HARD range  training [min, max] widened by half the span on each side,
              intersected with the natural bounds (binary {0,1}, min 0, ...).
              Outside it -> CRITICAL.
  SOFT range  training [p01, p99]. Outside it -> a legitimate extreme, counted
              by the monitor, never refused.

enforce(X, A) runs BEFORE inference: a game with a CRITICAL violation is not
inferred, not published and not decided (the weekly gate withholds it; more
than 5% of a week withheld holds the week). Nothing here imputes, clips or
changes an input.

monitor(X, reference) compares a slate with the training slates of the same
week of the season: its mean, SD, share outside the soft range and missing
share against the envelope the eight training seasons spanned. It returns
flags; it never refits.

    python3 -m v2.weekly.contract --build-reference [--out-dir DIR]   (needs a v2.1 build)
    python3 -m v2.weekly.contract --check --season 2026               (the live slate, report only)
"""
import argparse
import hashlib
import json
import math
import os

import numpy as np
import pandas as pd

from .sources import REPO

CONTRACT_DIR = os.path.join(REPO, 'football', 'cfb_production', 'contract')
CONTRACT_FILE = os.path.join(CONTRACT_DIR, 'input_contract.json')
DEV_SEASONS = tuple(range(2016, 2024))          # the artifact's training window (meta.json windows.dev)
QUANTILES = (0.001, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 0.999)

# the monitor's declared thresholds (diagnostics, not tuned to produce flags)
MIN_N = 20                   # a slate smaller than this is not judged
TAIL_SHARE = 0.10            # share of the slate outside the soft range flagged at least above this
MISSING_DELTA = 0.20         # live missing share above the training slates' maximum by more than this


def load(path=None):
    return json.load(open(path or CONTRACT_FILE))


def reference_path(contract=None):
    c = contract or load()
    return os.path.join(CONTRACT_DIR, c['reference'])


def load_reference(contract=None):
    p = reference_path(contract)
    return json.load(open(p)) if os.path.exists(p) else None


def phase_of(weeks_in, is_postseason):
    """The week of the season a row belongs to ('w0'..'w16', 'post'): the
    monitor compares a slate with the training rows of the same week, because
    schedule-clock inputs (games played, rating uncertainty) move with it."""
    if bool(is_postseason):
        return 'post'
    w = float(weeks_in) if weeks_in is not None and not (isinstance(weeks_in, float) and math.isnan(weeks_in)) else 0.0
    return 'w%d' % int(min(16, max(0, math.floor(w))))


def _derived(X):
    from .. import models as MD
    return MD.add_derived(X)


def _stats(v):
    v = pd.to_numeric(pd.Series(v), errors='coerce').astype(float)
    ok = v[np.isfinite(v)]
    out = {'n': int(len(v)), 'missing_share': round(float(1 - len(ok) / len(v)), 6) if len(v) else None}
    if len(ok):
        out.update(mean=float(ok.mean()), sd=float(ok.std(ddof=1)) if len(ok) > 1 else 0.0,
                   min=float(ok.min()), max=float(ok.max()),
                   q={str(q): float(ok.quantile(q)) for q in QUANTILES})
    return out


# ----------------------------------------------------------------- reference
def _slate_stats(v, soft):
    v = pd.to_numeric(pd.Series(v), errors='coerce').astype(float)
    ok = v[np.isfinite(v)]
    out = {'missing': float(1 - len(ok) / len(v)) if len(v) else None,
           'mean': float(ok.mean()) if len(ok) else None,
           'sd': float(ok.std(ddof=1)) if len(ok) > 1 else None}
    out['tail'] = float(((ok < soft[0]) | (ok > soft[1])).mean()) if soft and len(ok) else None
    return out


def build_reference(X, contract=None, source=None):
    """Distribution of every contract field on the training rows (dev seasons,
    FBS-vs-FBS, FINAL: walkforward.train_rows' filter), plus, for every week of
    the season, the ENVELOPE of the per-season slate statistics (mean, SD,
    share outside the soft range, missing share): the range those statistics
    took across the eight training seasons. The HARD ranges come from
    `fields_inferred`: every dev row the model is ever run on (FBS-vs-FCS
    games are inferred, though never priced)."""
    c = contract or load()
    X = X[X.season.isin(DEV_SEASONS)]
    if 'status' in X:
        X = X[X.status.eq('FINAL')]
    Dall = _derived(X)
    X = X[~X.fcs_game.astype(bool)]
    D = _derived(X)
    D['_phase'] = [phase_of(w, p) for w, p in zip(D.get('weeks_in', pd.Series(0.0, index=D.index)), D.is_postseason)]
    fields = [f['field'] for f in c['model_inputs']]
    ftype = {f['field']: f['type'] for f in c['model_inputs']}
    raw = sorted({s.strip() for f in c['model_inputs'] if f.get('imputed_from') for s in f['imputed_from']['raw'].split(',')})
    ref = {'schema': 'cfb_feature_reference_v2', 'model_version': c['model_version'], 'feature_version': c['feature_version'],
           'contract_version': c['version'], 'seasons': list(DEV_SEASONS), 'rows': int(len(D)), 'source': source,
           'filter': 'dev seasons, FBS-vs-FBS, FINAL (the training rows)', 'quantiles': list(QUANTILES),
           'fields': {}, 'fields_inferred': {}, 'weeks': {}}
    for f in fields:
        ref['fields'][f] = _stats(D[f]) if f in D else {'n': 0, 'absent': True}
        ref['fields_inferred'][f] = {k: v for k, v in _stats(Dall[f]).items() if k in ('n', 'missing_share', 'min', 'max')} if f in Dall else {'n': 0}
    soft = {f: ((ref['fields'][f].get('q') or {}).get('0.01'), (ref['fields'][f].get('q') or {}).get('0.99')) for f in fields}
    for ph, g in D.groupby('_phase'):
        env, n_slates = {}, 0
        for _, sl in g.groupby('season'):
            n_slates += 1
            cols = [(f, sl[f], soft[f] if ftype[f] != 'binary' else None) for f in fields if f in sl]
            cols += [(r, X.loc[sl.index, r], None) for r in raw if r in X]
            for name, v, sf in cols:
                st = _slate_stats(v, sf)
                e = env.setdefault(name, {})
                for k, x in st.items():
                    if x is None:
                        continue
                    lo, hi = e.get(k, (x, x))
                    e[k] = (min(lo, x), max(hi, x))
        ref['weeks'][ph] = {'rows': int(len(g)), 'slates': n_slates,
                            'envelope': {n: {k: [round(v[0], 6), round(v[1], 6)] for k, v in e.items()} for n, e in env.items()}}
    ref['sha256'] = hashlib.sha256(json.dumps({k: v for k, v in ref.items() if k != 'sha256'}, sort_keys=True).encode()).hexdigest()
    return ref


# ----------------------------------------------------------------- ranges
def ranges(contract=None, reference=None):
    """{field: {'hard': (lo, hi), 'soft': (lo, hi) or None}} by the declared rule."""
    c = contract or load()
    ref = reference if reference is not None else load_reference(c)
    out = {}
    for f in c['model_inputs']:
        name = f['field']
        if f['type'] == 'binary':
            out[name] = {'hard': (0.0, 1.0), 'soft': None}
            continue
        s = ((ref or {}).get('fields') or {}).get(name) or {}
        si = ((ref or {}).get('fields_inferred') or {}).get(name) or s
        lo, hi = si.get('min'), si.get('max')
        if lo is None or hi is None:
            hard = (-math.inf, math.inf)
        else:
            span = max(hi - lo, 1e-9)
            hard = (lo - span / 2.0, hi + span / 2.0)
        if 'min' in f:
            hard = (max(hard[0], f['min']), hard[1])
        if 'hard_range' in f:
            hard = (max(hard[0], f['hard_range'][0]), min(hard[1], f['hard_range'][1]))
        q = s.get('q') or {}
        soft = (q.get('0.01'), q.get('0.99')) if q else None
        out[name] = {'hard': hard, 'soft': soft}
    return out


# ----------------------------------------------------------------- enforce
def _finite(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def enforce(X, A=None, contract=None, reference=None):
    """Check every target game's model inputs (after the artifact's own
    derivations) and timestamps. Returns
      {'version', 'games', 'critical_games': [ids], 'violations': {id: [..]},
       'fields': n, 'ok': bool}
    A game listed in critical_games must not be inferred or published."""
    c = contract or load()
    rg = ranges(c, reference)
    fields = [f for f in c['model_inputs']]
    if A is not None:
        from . import project as PJ
        want = set(PJ.model_inputs(A))
        have = {f['field'] for f in fields}
        if want != have:
            raise ValueError('input contract %s does not cover the artifact inputs: missing %s, extra %s'
                             % (c['version'], sorted(want - have)[:10], sorted(have - want)[:10]))
    D = _derived(X) if len(X) else X
    viol = {}
    for i, r in D.iterrows():
        gid = str(r['game_id'])
        bad = []
        mg = _finite(r.get('min_games'))
        for f in fields:
            name = f['field']
            if name not in D:
                bad.append('%s: column absent' % name)
                continue
            raw = r[name]
            if isinstance(raw, (bool, np.bool_)):
                raw = float(raw)
            v = _finite(raw)
            if v is None:
                is_null = raw is None or (isinstance(raw, float) and math.isnan(raw))
                if is_null and f['null_policy'] == 'ALLOWED_BEFORE_FIRST_GAME' and mg == 0:
                    continue
                bad.append('%s: %s' % (name, 'null' if is_null else 'not a finite number (%r)' % (raw,)))
                continue
            if f['type'] == 'binary' and v not in (0.0, 1.0):
                bad.append('%s: %r is not binary' % (name, v))
                continue
            lo, hi = rg[name]['hard']
            if not (lo <= v <= hi):
                bad.append('%s: %g outside the hard range [%g, %g]' % (name, v, lo, hi))
        # point in time: nothing after kickoff
        ko = pd.to_datetime(r.get('kickoff_ts'), utc=True, errors='coerce')
        for tcol in ('feature_ts', 'prediction_ts'):
            t = pd.to_datetime(r.get(tcol), utc=True, errors='coerce')
            if t is pd.NaT or ko is pd.NaT or pd.isna(t) or pd.isna(ko):
                bad.append('%s or kickoff_ts missing' % tcol)
            elif t > ko:
                bad.append('%s %s is after kickoff %s' % (tcol, t.isoformat(), ko.isoformat()))
        if str(r.get('home_id')) == str(r.get('away_id')):
            bad.append('home_id equals away_id')
        if bad:
            viol[gid] = bad
    return {'version': c['version'], 'model_version': c['model_version'], 'games': int(len(D)),
            'critical_games': sorted(viol), 'violations': viol, 'fields': len(fields), 'ok': not viol}


# ----------------------------------------------------------------- monitor
def _outside(x, env, floor):
    """x outside the training envelope [lo, hi] widened by max(half its width, floor)."""
    if x is None or not env:
        return False
    lo, hi = env
    pad = max(0.5 * (hi - lo), floor)
    return x < lo - pad or x > hi + pad


def monitor(X, reference=None, contract=None, min_n=MIN_N):
    """The slate's distribution vs the training slates of the same week of the
    season. A statistic is flagged when it leaves the range the eight training
    seasons' slates spanned, widened by half that range (and by a floor of a
    quarter of the training SD for means and SDs). Returns
    {'status', 'phase', 'n', 'flags': [...], 'features': {...}}."""
    c = contract or load()
    ref = reference if reference is not None else load_reference(c)
    if ref is None:
        return {'status': 'NO_REFERENCE', 'flags': [], 'n': int(len(X)),
                'detail': 'no training reference (python3 -m v2.weekly.contract --build-reference)'}
    D = _derived(X) if len(X) else X
    if len(D) and 'fcs_game' in D:
        D = D[~D.fcs_game.astype(bool)]          # the reference is FBS-vs-FBS
    n = int(len(D))
    phases = [phase_of(w, p) for w, p in zip(D.get('weeks_in', pd.Series(0.0, index=D.index)), D.get('is_postseason', pd.Series(False, index=D.index)))]
    phase = max(set(phases), key=phases.count) if phases else None
    W = (ref.get('weeks') or {}).get(phase) or {}
    env = W.get('envelope') or {}
    out = {'status': 'OK', 'phase': phase, 'n': n, 'reference_slates': W.get('slates'), 'reference_sha256': ref.get('sha256'),
           'rule': {'min_n': min_n, 'envelope_pad': 'max(half the envelope width, a quarter of the training SD)',
                    'tail_share_min': TAIL_SHARE, 'missing_delta': MISSING_DELTA},
           'flags': [], 'features': {}}
    if n < min_n:
        out['status'] = 'TOO_FEW_GAMES'
        return out
    if not env:
        out['status'] = 'NO_REFERENCE_WEEK'
        return out
    ftype = {f['field']: f['type'] for f in c['model_inputs']}
    names = [f['field'] for f in c['model_inputs']] + [r for r in env if r not in ftype]
    for name in names:
        e = env.get(name)
        if not e:
            continue
        src = D[name] if name in D else (X.loc[D.index, name] if name in X else None)
        if src is None:
            continue
        r = (ref.get('fields') or {}).get(name) or {}
        q = r.get('q') or {}
        soft = (q.get('0.01'), q.get('0.99')) if q and ftype.get(name) == 'number' else None
        st = _slate_stats(src, soft)
        rsd = r.get('sd') or 0.0
        v = {k: (round(x, 4) if isinstance(x, float) else x) for k, x in st.items()}
        v['envelope'] = e
        v['flags'] = []
        if ftype.get(name) in ('number', 'binary') and _outside(st['mean'], e.get('mean'), 0.25 * rsd):
            v['flags'].append('MEAN_SHIFT')
        if ftype.get(name) == 'number' and _outside(st['sd'], e.get('sd'), 0.25 * rsd):
            v['flags'].append('SD_SHIFT')
        if st['tail'] is not None and e.get('tail') and st['tail'] > max(TAIL_SHARE, e['tail'][1] + 0.05):
            v['flags'].append('TAILS')
        if st['missing'] is not None and e.get('missing') and st['missing'] - e['missing'][1] > MISSING_DELTA:
            v['flags'].append('MISSINGNESS' if name in ftype else 'RAW_MISSINGNESS')
        out['features'][name] = v
        for fl in v['flags']:
            out['flags'].append({'field': name, 'flag': fl, 'mean': v.get('mean'), 'sd': v.get('sd'), 'tail': v.get('tail'),
                                 'missing': v.get('missing'), 'envelope': {k: e.get(k) for k in ('mean', 'sd', 'tail', 'missing')}})
    out['status'] = 'FLAGGED' if out['flags'] else 'OK'
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--build-reference', action='store_true')
    ap.add_argument('--out-dir', default=None, help='write the reference here instead of the contract directory')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--season', type=int, default=None)
    a = ap.parse_args()
    from .. import common
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    c = load()
    if a.build_reference:
        fv = set(X.feature_version.dropna().unique()) if 'feature_version' in X else set()
        if fv and fv != {c['feature_version']}:
            raise SystemExit('refused: the build is feature schema %s, the contract is %s' % (sorted(fv), c['feature_version']))
        stage5 = common.out_path('stage5', 'cfb_model_training_snapshots.parquet')
        src = {'file': 'stage5/cfb_model_training_snapshots.parquet', 'sha256': hashlib.sha256(open(stage5, 'rb').read()).hexdigest()}
        ref = build_reference(X, c, src)
        p = os.path.join(a.out_dir or CONTRACT_DIR, c['reference'])
        common.write_json(p, ref)
        print('[contract] reference: %d training rows, %d fields -> %s' % (ref['rows'], len(ref['fields']), p))
    if a.check:
        s = a.season or int(X.season.max())
        T = X[X.season.eq(s)].prediction_ts.max()
        Xt = X[X.season.eq(s) & X.prediction_ts.eq(T)]
        print(json.dumps({'enforce': {k: v for k, v in enforce(Xt, contract=c).items() if k != 'violations'},
                          'monitor': {k: v for k, v in monitor(Xt, contract=c).items() if k not in ('features', 'raw_missing')}},
                         default=str, indent=1))


if __name__ == '__main__':
    main()
