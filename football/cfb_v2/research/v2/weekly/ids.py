"""Deterministic ids and canonical hashes for the weekly engine.

The rendering is the Model Lab's (docs/cfb-lab/SCHEMA.md rule 4), so an id
computed here equals the one football/cfb_lab/ledger.js would compute:
None -> '', numbers -> shortest decimal (no trailing zeros, -0 -> 0),
booleans -> true/false, timestamps -> UTC YYYY-MM-DDTHH:MM:SS.sssZ, text as is.
"""
import datetime as _dt
import hashlib
import json
import math

import numpy as np
import pandas as pd


def render(x):
    if x is None:
        return ''
    if isinstance(x, (bool, np.bool_)):
        return 'true' if x else 'false'
    if isinstance(x, (pd.Timestamp, _dt.datetime)):
        return ts(x)
    if isinstance(x, (int, np.integer)):
        return str(int(x))
    if isinstance(x, (float, np.floating)):
        f = float(x)
        if math.isnan(f):
            return ''
        if f == 0:
            return '0'
        if f.is_integer() and abs(f) < 1e21:
            return str(int(f))
        return repr(f)
    return str(x)


def ts(x):
    """UTC ISO with milliseconds and Z; None stays None."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    t = pd.Timestamp(x)
    if t is pd.NaT:
        return None
    if t.tzinfo is None:
        t = t.tz_localize('UTC')
    t = t.tz_convert('UTC')
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (t.microsecond // 1000)


def h(*parts):
    return hashlib.sha256('|'.join(render(p) for p in parts).encode('utf-8')).hexdigest()[:24]


def _clean(o):
    """JSON-safe, deterministic: NaN/inf -> None, numpy -> python, timestamps -> ts()."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (pd.Timestamp, _dt.datetime)):
        return ts(o)
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, (int, np.integer)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if o is pd.NaT:
        return None
    return o


def canonical(obj):
    """Canonical JSON (sorted keys, no whitespace) of a cleaned object."""
    return json.dumps(_clean(obj), sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def content_hash(obj, exclude=()):
    """sha256 of the canonical JSON of obj without the keys in `exclude`."""
    if isinstance(obj, dict) and exclude:
        obj = {k: v for k, v in obj.items() if k not in exclude}
    return hashlib.sha256(canonical(obj).encode('utf-8')).hexdigest()


def file_hash(path, chunk=1 << 20):
    """sha256 of a file's bytes, or None if it does not exist."""
    try:
        d = hashlib.sha256()
        with open(path, 'rb') as f:
            for b in iter(lambda: f.read(chunk), b''):
                d.update(b)
        return d.hexdigest()
    except FileNotFoundError:
        return None


def clean(o):
    return _clean(o)
