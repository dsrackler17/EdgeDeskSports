"""EdgeDesk CFB V2 — shared helpers: sign conventions, time, garbage time, I/O.

SIGN CONVENTION (critical infrastructure — see tests):

  * INTERNAL, everywhere in V2: a MARGIN is home points minus away points.
    A predicted margin > 0 means the HOME team is projected to win by that many.
  * SPORTSBOOK DISPLAY: a home line of -7 means home is laying 7. It is the
    exact negation of the internal margin. Conversion happens ONCE, at the
    ingestion boundary, through `book_home_line_to_margin` — nowhere else.
  * A spread bet on the HOME side at book line L (display) covers when
    margin + L > 0; equivalently when margin > market_margin where
    market_margin = -L.
"""
import json
import math
import os
from datetime import datetime, timezone, timedelta

import numpy as np

from . import config as C


# ------------------------------------------------------------ sign helpers
def book_home_line_to_margin(home_line):
    """Sportsbook display line for the HOME side (-7 = home favoured by 7)
    -> internal expected home margin (+7)."""
    if home_line is None:
        return None
    try:
        v = float(home_line)
    except (TypeError, ValueError):
        return None
    if math.isnan(v):
        return None
    return -v


def margin_to_book_home_line(margin):
    if margin is None:
        return None
    return -float(margin)


def home_cover_result(final_margin, market_margin):
    """+1 home covers, -1 away covers, 0 push. market_margin in INTERNAL convention."""
    d = float(final_margin) - float(market_margin)
    if abs(d) < 1e-9:
        return 0
    return 1 if d > 0 else -1


# ------------------------------------------------------------ garbage time
def garbage_mask(period, score_diff_start):
    """Vectorised DECLARED garbage-time rule from quarter and |score diff| only.
    Deliberately does NOT read win probability (the provider's WP model reads
    the pregame spread, which would smuggle market information into pure
    features)."""
    period = np.asarray(period)
    sd = np.abs(np.asarray(score_diff_start, dtype=float))
    out = np.zeros(len(sd), dtype=bool)
    for q, thr in C.GARBAGE_MARGIN_BY_QTR.items():
        if thr is None:
            continue
        out |= (period == q) & (sd > thr)
    # overtime and beyond: never garbage
    return out


# ------------------------------------------------------------------ time
def parse_ts(s):
    if s is None or (isinstance(s, float) and math.isnan(s)):
        return None
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    s = str(s).replace('Z', '+00:00')
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        d = datetime.strptime(s[:10], '%Y-%m-%d')
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def prediction_ts_for_kickoff(kickoff):
    """The weekly freeze: Tuesday 12:00 UTC of the football week containing
    the kickoff (weeks run Tuesday -> Monday). Every game in a week is
    predicted from the same frozen state, so a Thursday result can never
    inform a Saturday prediction in the backtest. Production may refresh more
    often; the backtest is deliberately the conservative version."""
    k = parse_ts(kickoff)
    # weekday(): Mon=0 ... Tue=1
    days_since_tue = (k.weekday() - 1) % 7
    t = (k - timedelta(days=days_since_tue)).replace(hour=12, minute=0, second=0, microsecond=0)
    if t > k:                      # kickoff on Tuesday before noon
        t -= timedelta(days=7)
    return t


def iso(d):
    return d.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if d else None


# ------------------------------------------------------------------- I/O
def out_path(*parts):
    p = os.path.join(C.OUT, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def data_path(*parts):
    return os.path.join(C.DATA, *parts)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=_json_default)
        f.write('\n')


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else round(float(o), 6)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, datetime):
        return iso(o)
    raise TypeError(type(o))


def rnd(x, k=4):
    if x is None:
        return None
    try:
        if isinstance(x, float) and math.isnan(x):
            return None
        return round(float(x), k)
    except (TypeError, ValueError):
        return None
