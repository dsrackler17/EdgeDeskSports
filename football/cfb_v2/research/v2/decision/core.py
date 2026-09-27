"""Decision math: odds, de-vig, break-even, push, EV with push, the model's t, and CIs.

Every function here is a pure function of its arguments (no data, no state),
so the reference implementation, the dataset builder, the study and the tests
share one definition of each quantity.

Conventions (identical to v2.common and engine.js):
  * a MARGIN is home points minus away points; a line in INTERNAL convention is
    the home margin the market prices (book 'home -7' == internal +7);
  * the HOME side of a spread at internal line L covers when margin > L, the
    AWAY side when margin < L, and margin == L is a push;
  * every cover probability in this package is P(cover | no push), the same
    quantity engine.js calls cover_probability, so EV = p(1-push)b - (1-p)(1-push);
  * a price is American odds; b = payout per unit risked.
"""
import math

import numpy as np
from scipy import stats
from scipy.special import gammaln

from .. import config as C

P_CLIP = 1e-4
ASSUMED_PRICE = -110                      # historical study only, always labelled
PRICE_SOURCE_ASSUMED = 'ASSUMED_-110'
PRICE_SOURCE_NONE = 'NONE'                # a live quote without a captured price
PRICE_SOURCE_CAPTURED = 'CAPTURED'        # a live quote with both sides' prices
PRICE_SOURCE_ONE_SIDED = 'CAPTURED_ONE_SIDED'
PUSH_BUCKETS = ((0, 2.5), (2.5, 3.5), (3.5, 6.5), (6.5, 7.5), (7.5, 13.5), (13.5, 99))
PUSH_DEFAULT = 0.02                       # a bucket with <= PUSH_MIN_N integer lines
PUSH_MIN_N = 50
BOOT_B = 2000


# ------------------------------------------------------------------- odds
def american_to_payout(a):
    """Units won per unit risked. Scalar or array; NaN in -> NaN out."""
    a = np.asarray(a, dtype=float)
    with np.errstate(divide='ignore', invalid='ignore'):
        out = np.where(a > 0, a / 100.0, 100.0 / np.abs(a))
    out = np.where(np.isfinite(a) & (np.abs(a) >= 100), out, np.nan)
    return float(out) if out.ndim == 0 else out


def break_even(a):
    """P(cover | no push) at which EV is exactly 0 at price a: 1 / (1 + b).
    Pushes do not move it: EV = (1-push)(p b - (1-p)) has the sign of p b - (1-p)."""
    b = american_to_payout(a)
    return 1.0 / (1.0 + b)


def devig(a_side, a_other):
    """Proportional (multiplicative) de-vig of a two-sided price.
    Returns (fair probability of the side, overround). None if not two-sided."""
    if a_side is None or a_other is None:
        return None, None
    try:
        a1, a2 = float(a_side), float(a_other)
    except (TypeError, ValueError):
        return None, None
    if not (math.isfinite(a1) and math.isfinite(a2)) or abs(a1) < 100 or abs(a2) < 100:
        return None, None
    q1, q2 = break_even(a1), break_even(a2)
    return q1 / (q1 + q2), q1 + q2 - 1.0


def market_implied_side(a_side, a_other):
    """The market's P(side covers | no push): de-vigged when both prices exist,
    0.5 otherwise (a spread is priced to be a fair coin at the line). Returns
    (probability, basis)."""
    p, _ = devig(a_side, a_other)
    if p is None:
        return 0.5, 'FAIR_LINE_0.5'
    return p, 'DEVIG_PROPORTIONAL'


def ev_with_push(p_nopush, push, price):
    """Expected units per unit risked. p_nopush = P(cover | no push)."""
    b = american_to_payout(price)
    p = np.asarray(p_nopush, dtype=float)
    q = np.asarray(push, dtype=float)
    out = p * (1.0 - q) * b - (1.0 - p) * (1.0 - q)
    return float(out) if np.ndim(out) == 0 else out


def units(result, price):
    """Realized units for W/L/P at a price (result +1 win, -1 loss, 0 push)."""
    r = np.asarray(result, dtype=float)
    b = american_to_payout(price)
    out = np.where(r == 1, b, np.where(r == -1, -1.0, np.where(r == 0, 0.0, np.nan)))
    return float(out) if np.ndim(out) == 0 else out


# -------------------------------------------------------------- transforms
def clip_p(p):
    return np.clip(np.asarray(p, dtype=float), P_CLIP, 1 - P_CLIP)


def logit(p):
    p = clip_p(p)
    out = np.log(p / (1 - p))
    return float(out) if np.ndim(out) == 0 else out


def sigmoid(z):
    z = np.asarray(z, dtype=float)
    out = 1.0 / (1.0 + np.exp(-z))
    return float(out) if np.ndim(out) == 0 else out


# ------------------------------------------------ the frozen model's distribution
def t_cdf_std(x, df):
    """CDF of the STANDARDIZED (unit-variance) Student t, exactly as
    v2.walkforward.t_cdf and engine.js tCdf."""
    df = np.asarray(df, dtype=float)
    s = np.sqrt((df - 2.0) / df)
    out = stats.t.cdf(np.asarray(x, dtype=float) / s, df)
    return float(out) if np.ndim(out) == 0 else out


def mean_abs_t_std(df):
    """E|T| for a unit-variance Student t with df degrees of freedom."""
    df = float(df)
    ea = 2.0 * math.sqrt(df) * math.exp(gammaln((df + 1) / 2.0) - gammaln(df / 2.0)) / (math.sqrt(math.pi) * (df - 1.0))
    return ea / math.sqrt(df / (df - 2.0))


def cover_prob_home(mu, sigma, line, df):
    """PURE P(home covers | no push) at internal line L: 1 - F((L - mu) / sigma)."""
    return 1.0 - t_cdf_std((np.asarray(line, float) - np.asarray(mu, float)) / np.asarray(sigma, float), df)


def is_integer_line(line):
    line = np.asarray(line, dtype=float)
    return np.isfinite(line) & np.isclose(line, np.round(line))


def push_prob_model(mu, sigma, line, df):
    """Push mass the continuous model puts on an integer line (continuity
    correction). Understates key numbers (3, 7) by construction — reported
    beside the empirical table, never used in EV."""
    line = np.asarray(line, dtype=float)
    hi = t_cdf_std((line + 0.5 - np.asarray(mu, float)) / np.asarray(sigma, float), df)
    lo = t_cdf_std((line - 0.5 - np.asarray(mu, float)) / np.asarray(sigma, float), df)
    out = np.where(is_integer_line(line), hi - lo, 0.0)
    return float(out) if np.ndim(out) == 0 else out


def fit_push_table(lines, margins):
    """Empirical P(final margin == line) for INTEGER lines by |line| bucket
    (the market.py buckets). Returns the portable table."""
    lines = np.asarray(lines, dtype=float)
    margins = np.asarray(margins, dtype=float)
    ok = is_integer_line(lines) & np.isfinite(margins)
    lines, margins = lines[ok], margins[ok]
    out = []
    for lo, hi in PUSH_BUCKETS:
        s = (np.abs(lines) >= lo) & (np.abs(lines) <= hi)
        n = int(s.sum())
        p = float((margins[s] == lines[s]).mean()) if n > PUSH_MIN_N else PUSH_DEFAULT
        out.append({'lo': lo, 'hi': hi, 'p': p, 'n': n})
    return {'buckets': out, 'default': PUSH_DEFAULT, 'min_n': PUSH_MIN_N,
            'rule': 'integer lines only; first bucket with lo <= |line| <= hi; half-point lines push with probability 0'}


def push_prob_lookup(line, table):
    try:
        v = float(line)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v) or abs(v - round(v)) > 1e-9:
        return 0.0
    for b in table['buckets']:
        if b['lo'] <= abs(v) <= b['hi']:
            return float(b['p'])
    return float(table.get('default', PUSH_DEFAULT))


# ------------------------------------------------------------------- CIs
def wilson(k, n, z=1.96):
    if not n:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [c - h, c + h]


def _rng(seed=None):
    return np.random.default_rng(C.SEED if seed is None else seed)


def boot_ci(x, B=BOOT_B, seed=None, alpha=0.05, min_n=20):
    """Percentile bootstrap CI of the mean (game-level, iid resampling)."""
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < min_n:
        return [None, None]
    rng = _rng(seed)
    means = np.empty(B)
    step = max(1, int(4e6 // max(n, 1)))
    for i in range(0, B, step):
        k = min(step, B - i)
        idx = rng.integers(0, n, size=(k, n))
        means[i:i + k] = x[idx].mean(axis=1)
    return [float(np.quantile(means, alpha / 2)), float(np.quantile(means, 1 - alpha / 2))]


def boot_paired_diff(a, b, B=BOOT_B, seed=None):
    """Mean of (a - b) with a bootstrap CI and SE (paired, game-level)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    d = a[ok] - b[ok]
    ci = boot_ci(d, B=B, seed=seed)
    return {'n': int(ok.sum()), 'mean': float(d.mean()) if ok.any() else None, 'ci': ci,
            'se': float(d.std(ddof=1) / math.sqrt(len(d))) if len(d) > 1 else None}


def max_drawdown(u):
    u = np.asarray(u, dtype=float)
    u = u[np.isfinite(u)]
    if not len(u):
        return None
    cum = np.concatenate([[0.0], np.cumsum(u)])
    return float(np.max(np.maximum.accumulate(cum) - cum))


def boot_drawdown_ci(u, B=1000, seed=None, alpha=0.05):
    """Distribution of the max drawdown under exchangeability: resample the
    bets iid and play them in the resampled order."""
    u = np.asarray(u, dtype=float)
    u = u[np.isfinite(u)]
    n = len(u)
    if n < 20:
        return [None, None]
    rng = _rng(seed)
    dd = np.empty(B)
    step = max(1, int(2e6 // n))
    for i in range(0, B, step):
        k = min(step, B - i)
        s = u[rng.integers(0, n, size=(k, n))]
        cum = np.concatenate([np.zeros((k, 1)), np.cumsum(s, axis=1)], axis=1)
        dd[i:i + k] = np.max(np.maximum.accumulate(cum, axis=1) - cum, axis=1)
    return [float(np.quantile(dd, alpha / 2)), float(np.quantile(dd, 1 - alpha / 2))]


# ------------------------------------------------------- probability scores
def log_loss(y, p):
    y = np.asarray(y, float)
    p = clip_p(p)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def brier(y, p):
    return (np.asarray(p, float) - np.asarray(y, float)) ** 2


def ece(y, p, bins=10):
    """Adaptive (equal-count) expected calibration error, plus the bin table."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    if not len(y):
        return None, []
    order = np.argsort(p, kind='mergesort')
    chunks = np.array_split(order, bins)
    e, tab = 0.0, []
    for c in chunks:
        if not len(c):
            continue
        e += len(c) / len(y) * abs(p[c].mean() - y[c].mean())
        tab.append({'n': int(len(c)), 'p_lo': float(p[c].min()), 'p_hi': float(p[c].max()),
                    'pred': float(p[c].mean()), 'obs': float(y[c].mean())})
    return float(e), tab
