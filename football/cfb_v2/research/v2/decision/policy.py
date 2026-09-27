"""The Python mirror of football/cfb_decision/decision.js: the status gates, the
price targets, BET NOW / WAIT, the stake and the correlated exposure.

    decide_quote(pure, quote, ctx)        decision.js decideQuote (status, reasons, numbers)
    decide_game(pure, market, ctx)        decision.js decideGame (per book, the best quote)
    price_targets(pure, quote, side, ctx) decision.js priceTargets
    timing(out, s, ctx)                   decision.js timing
    kelly_fraction(p, price), stake(d, P) decision.js kellyFraction / stake
    apply_exposure(positions, P)          decision.js applyExposure
    validate_policy(P), validate_artifact(A, version)

It exists so the policy study replays EXACTLY the production decision on
historical rows (tournament.py, holdout.py) and so the two implementations are
held together by a parity fixture:

    football/cfb_v2/artifacts/decision/fixtures/policy_parity.json

generated here (`python3 -m v2.decision.policy --fixture`) and checked by
football/cfb_decision/tests.js (every status, reason code, timing, stake and
exposure to 1e-9).

JavaScript semantics are mirrored on purpose, including the `a || default`
fallbacks (a policy value of exactly 0 falls back to the default: see
POLICY.md, "decision.js notes") and Math.round (ties toward +infinity).
Quote validation mirrors the spread rules of football/cfb_lab/integrity.js
validateQuote (the module decision.js requires in node); the team join uses
exact case-insensitive equality (decision.js uses the identity master in node,
so parity cases never depend on a team alias).
"""
import copy
import json
import math
import os
from datetime import datetime, timezone

from scipy import special

from . import reference as REF

ENGINE_ID = 'edgedesk_cfb_decision'
ENGINE_VERSION = 'cfb_decision_engine_v1'
REASON_CODES = ['PASS_PRICE', 'PASS_MODEL_UNCERTAINTY', 'PASS_QB_UNCERTAINTY', 'PASS_MARKET_STALE',
                'PASS_MODEL_DISAGREEMENT', 'PASS_INSUFFICIENT_EV', 'PASS_LINE_MOVED', 'PASS_DATA_QUALITY',
                'PASS_MARKET_DISPERSION', 'PASS_MARKET_INVALID', 'PASS_MARKET_DEGRADED', 'NO_BET_CALIBRATION',
                'NO_BET_VERSION_MISMATCH', 'NO_BET_COMPUTATION', 'NO_BET_POLICY', 'NO_BET_BETTING_DISABLED',
                'RESEARCH_QB', 'RESEARCH_MARKET_IMMATURE', 'RESEARCH_DATA_INCOMPLETE', 'RESEARCH_EXTREME_EDGE',
                'LEAN_DIRECTIONAL', 'BET_VALIDATED', 'HELD_BY_HYSTERESIS']
EXTREME_COVER_PROBABILITY = 0.60
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

HERE = os.path.dirname(os.path.abspath(__file__))
ARTIFACTS = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'artifacts', 'decision'))
CAL_JSON = os.path.join(ARTIFACTS, 'cfb_decision_calibration_v1', 'calibration.json')
FIXTURE = os.path.join(ARTIFACTS, 'fixtures', 'policy_parity.json')


# ------------------------------------------------------------ JS semantics
def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def truthy(v):
    """JavaScript truthiness."""
    if v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, (int, float)):
        return not (v == 0 or v != v)
    if isinstance(v, str):
        return len(v) > 0
    return True


def jor(v, d):
    """JavaScript `v || d`."""
    return v if truthy(v) else d


def js_round(x):
    """Math.round: nearest integer, ties toward +infinity."""
    return math.floor(x + 0.5)


def r(x, k=4):
    if not isnum(x):
        return None
    m = 10.0 ** k
    return js_round(x * m) / m


def clamp(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)


def js_str(x):
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return 'undefined' if x is None else str(x)


def parse_ms(s):
    """Date.parse for ISO-8601 UTC strings (ms since the epoch); None when unparseable."""
    if s is None or s == '':
        return None
    if isnum(s):
        return float(s)
    try:
        t = datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    d = t - EPOCH
    return float(d.days * 86400000 + d.seconds * 1000 + d.microseconds // 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (int(ms) % 1000)


# ------------------------------------------------------------------ prices
def american_to_payout(a):
    if not isnum(a) or a == 0 or (-100 < a < 100):
        return None
    return a / 100.0 if a > 0 else 100.0 / (-a)


def payout_to_american(b):
    if not isnum(b) or b <= 0:
        return None
    return js_round(100 * b) if b >= 1 else -js_round(100 / b)


def break_even(a):
    b = american_to_payout(a)
    return None if b is None else 1.0 / (1.0 + b)


def devig(pa, pb):
    qa, qb = break_even(pa), break_even(pb)
    if qa is None or qb is None:
        return None
    s = qa + qb
    return {'p_a': qa / s, 'p_b': qb / s, 'overround': s - 1, 'hold': 1 - 1 / s}


def push_prob(line, table):
    return REF.push_probability(line, table)


def expected_value(p, pp, price):
    b = american_to_payout(price)
    if b is None or not isnum(p):
        return None
    pp = pp if isnum(pp) else 0.0
    return p * (1 - pp) * b - (1 - p) * (1 - pp)


def minimum_price(p, pp, min_ev):
    if not isnum(p) or p <= 0:
        return None
    pp = pp if isnum(pp) else 0.0
    need = (jor(min_ev, 0) / max(1e-9, 1 - pp) + (1 - p)) / p
    return payout_to_american(need)


def price_better_or_equal(a, b):
    pa, pb = american_to_payout(a), american_to_payout(b)
    return pa is not None and pb is not None and pa >= pb - 1e-12


def next_better_price(a):
    return (101 if a + 1 > -100 else a + 1) if a < 0 else a + 1


def decision_ev_floor(A, min_ev):
    cT = A.get('ev_curve') if (A.get('ev_curve') and A['ev_curve'].get('input') == 'theoretical_ev') else None
    c = A.get('ev_curve_decision') or (A.get('ev_curve') if (A.get('ev_curve') and not cT) else None)
    if not c:
        return None if cT else min_ev
    xs, ys = c.get('x'), c.get('y')
    if not xs:
        return min_ev
    if ys[0] >= min_ev:
        return -math.inf
    for i in range(1, len(xs)):
        if ys[i] >= min_ev:
            return xs[i - 1] + (min_ev - ys[i - 1]) / ((ys[i] - ys[i - 1]) or 1) * (xs[i] - xs[i - 1])
    return None


# ------------------------------------------------------------- artifacts
def validate_artifact(A, model_version):
    if not isinstance(A, dict):
        return {'ok': False, 'code': 'NO_BET_CALIBRATION', 'detail': 'no calibration artifact loaded'}
    if A.get('schema') != 'cfb_decision_calibration_schema_v1':
        return {'ok': False, 'code': 'NO_BET_CALIBRATION', 'detail': 'unknown artifact schema %s' % A.get('schema')}
    if not A.get('cover_calibration'):
        return {'ok': False, 'code': 'NO_BET_CALIBRATION', 'detail': 'artifact has no cover calibration'}
    if A.get('ev_curve') and A['ev_curve'].get('input') == 'theoretical_ev' and not A.get('ev_curve_decision'):
        return {'ok': False, 'code': 'NO_BET_CALIBRATION', 'detail': 'artifact has no EV curve for the decision EV'}
    if not A.get('base_model_version') or A['base_model_version'] != model_version:
        return {'ok': False, 'code': 'NO_BET_VERSION_MISMATCH', 'detail': 'artifact validated for %s' % A.get('base_model_version')}
    return {'ok': True}


def validate_policy(P):
    if not isinstance(P, dict) or not truthy(P.get('version')):
        return {'ok': False, 'code': 'NO_BET_POLICY', 'detail': 'no decision policy'}
    for k in ('min_probability_edge', 'min_ev', 'stale_minutes', 'max_price'):
        if k not in P:
            return {'ok': False, 'code': 'NO_BET_POLICY', 'detail': 'policy lacks ' + k}
    return {'ok': True}


# ---------------------------------------------------------- probabilities
def t_cdf(z, df):
    if not isnum(df) or df > 1e6:
        df = 1e6
    s = math.sqrt((df - 2) / df)
    return float(special.stdtr(df, z / s))


def pure_cover(pure, home_line, side):
    mu, sd, df = pure.get('projected_margin'), pure.get('sigma'), pure.get('t_df')
    if not (isnum(mu) and isnum(sd) and sd > 0 and isnum(home_line)):
        return None
    p_home = 1 - t_cdf((-home_line - mu) / sd, df)
    return p_home if side == 'HOME' else 1 - p_home


def decision_probability(p_pure, market_p, feats, A):
    pc = REF.calibrate(A.get('cover_calibration'), p_pure, feats)
    sh = A.get('market_shrinkage')
    if not sh or not isnum(market_p):
        return {'calibrated': pc, 'decision': pc, 'w_model': 1}
    p, w = REF.market_shrink(pc, market_p, sh, feats)
    return {'calibrated': pc, 'decision': p, 'w_model': w}


# ------------------------------------------------------------ confidences
def football_confidence(pure, A):
    score = pure.get('football_prediction_confidence')
    scale = (A.get('reliability_scale') or {}).get('expected_abs_error') if A else None
    if scale and isnum(score):
        eae = REF.interp(scale['x'], scale['y'], score)
    else:
        eae = pure['sigma'] * math.sqrt(2 / math.pi) if isnum(pure.get('sigma')) else None
    lab = 'UNKNOWN' if not isnum(score) else ('HIGH' if score >= 70 else ('MEDIUM' if score >= 45 else 'LOW'))
    return {'score': score if isnum(score) else None, 'expected_abs_error_pts': r(eae, 2), 'label': lab}


def quote_problems(quote, now):
    """football/cfb_lab/integrity.js validateQuote, spread rules."""
    out = []
    for c in ('home_line', 'price_home', 'price_away'):
        v = quote.get(c)
        if v is not None and v != '' and not isnum(v):
            out.append('NON_NUMERIC_' + c.upper())
    hl = quote.get('home_line')
    if isnum(hl) and abs(hl) > 70:
        out.append('SPREAD_OUT_OF_BOUNDS')
    imp = []
    for c in ('price_home', 'price_away'):
        a = quote.get(c)
        if not isnum(a):
            imp.append(None)
            continue
        if a == 0:
            out.append('PRICE_ZERO')
        elif abs(a) < 100:
            out.append('PRICE_NOT_AMERICAN')
        elif abs(a) > 1000:
            out.append('PRICE_OUT_OF_BOUNDS')
        elif round(a) != a:
            out.append('PRICE_NOT_INTEGER')
        imp.append(break_even(a) if abs(a) >= 100 else None)
    if imp[0] is not None and imp[1] is not None:
        s = imp[0] + imp[1]
        if quote.get('price_home') == quote.get('price_away') and s > 1.30:
            out.append('IDENTICAL_SIDE_PRICES')
        elif s > 1.30:
            out.append('TWO_WAY_HOLD_TOO_HIGH')
        if s < 0.99:
            out.append('TWO_WAY_BELOW_FAIR')
    obs, upd = parse_ms(quote.get('observed_at')), parse_ms(quote.get('provider_updated_at'))
    tol = 5 * 60000
    if now is not None and obs is not None and obs > now + tol:
        out.append('OBSERVED_IN_FUTURE')
    if upd is not None and obs is not None and upd > obs + tol:
        out.append('PROVIDER_TS_AFTER_OBSERVED')
    if quote.get('provider_updated_at') not in (None, '') and upd is None:
        out.append('PROVIDER_TS_UNPARSEABLE')
    seen, u = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            u.append(x)
    return u


def quote_key(q):
    return js_str(q['quote_id']) if q.get('quote_id') is not None else 'book:%s|%s' % (js_str(q.get('book')), js_str(q.get('observed_at')))


def quote_age_minutes(quote, now):
    o = parse_ms(quote.get('observed_at'))
    if o is None:
        return None
    u = parse_ms(quote.get('provider_updated_at'))
    base = u if (u is not None and u < o) else o
    return (now - base) / 60000.0


def market_confidence(quote, market, now, P):
    age = quote_age_minutes(quote, now)
    market = market or {}
    books = market.get('books') if isnum(market.get('books')) else None
    iqr = market.get('dispersion_iqr') if isnum(market.get('dispersion_iqr')) else None
    s, basis = 100, []
    if not isnum(age):
        s = 0
        basis.append('quote time unknown')
    elif age > P['stale_minutes']:
        s = 0
        basis.append('stale')
    elif age > P['stale_minutes'] / 2:
        s -= 25
        basis.append('aging quote')
    if books is None:
        s -= 30
        basis.append('book count unknown')
    elif books < jor(P.get('min_books'), 3):
        s -= 30
        basis.append('%s book(s)' % books)
    if iqr is not None and iqr > jor(P.get('max_dispersion_iqr'), 1.5):
        s -= 40
        basis.append('books disagree')
    if not isnum(quote.get('price_home')) or not isnum(quote.get('price_away')):
        s -= 20
        basis.append('one-sided or missing prices')
    s = clamp(s, 0, 100)
    return {'score': s, 'age_minutes': r(age, 1), 'books': books, 'dispersion_iqr': iqr,
            'label': 'HIGH' if s >= 70 else ('MEDIUM' if s >= 40 else 'LOW'), 'basis': basis}


def bet_confidence(feats, A):
    p = REF.eval_model(A.get('bet_confidence'), feats) if A and A.get('bet_confidence') else None
    pclv = REF.eval_model(A.get('p_positive_clv'), feats) if A and A.get('p_positive_clv') else None
    base = p if isnum(p) else pclv
    lab = 'UNKNOWN' if not isnum(base) else ('HIGH' if base >= 0.58 else ('MEDIUM' if base >= 0.52 else 'LOW'))
    return {'p_positive_clv': r(pclv, 4), 'score': js_round(100 * base) if isnum(base) else None, 'label': lab}


def integrity_check(pure, quote, ctx, gap_pts, ev, p_cover):
    P, now, failures = ctx['policy'], ctx['now'], []
    extreme = abs(gap_pts) >= jor(P.get('extreme_gap_pts'), 10) or (isnum(ev) and ev >= jor(P.get('extreme_ev'), 0.12))
    xp = P['extreme_cover_probability'] if isnum(P.get('extreme_cover_probability')) else EXTREME_COVER_PROBABILITY
    extreme_p = isnum(p_cover) and (p_cover >= xp or p_cover <= 1 - xp)
    mkt = -quote['home_line']
    if abs(gap_pts) > jor(P.get('orientation_gap'), 21) and abs(pure['projected_margin'] + mkt) <= jor(P.get('orientation_reconcile'), 7):
        failures.append('sign')
    if js_str(quote.get('game_id')) != js_str(pure.get('game_id')):
        failures.append('mapping')
    if truthy(quote.get('home_team')) and truthy(pure.get('home')) and str(quote['home_team']).lower() != str(pure['home']).lower():
        failures.append('join')
    ko = parse_ms(pure.get('kickoff')) if pure.get('kickoff') else None
    if ko is None or now >= ko:
        failures.append('schedule: kicked off')
    elif ko - now > 10 * 86400000:
        failures.append('schedule: more than 10 days away')
    if truthy(ctx.get('expected_model_version')) and pure.get('model_version') != ctx['expected_model_version']:
        failures.append('model version')
    if extreme or extreme_p:
        row = ctx.get('row') or {}
        if truthy(row.get('qb_missing_any')) or truthy(row.get('qb_unsettled_any')):
            failures.append('player status')
        age = quote_age_minutes(quote, now)
        if not isnum(age):
            age = math.inf
        if not (age <= jor(P.get('extreme_max_age_minutes'), 60)):
            failures.append('freshness')
    return {'extreme': bool(extreme), 'extreme_probability': bool(extreme_p), 'ok': not failures, 'failures': failures}


# --------------------------------------------------------------- features
def features(pure, quote, side, p_pure, gap_side, ctx, mc):
    row = ctx.get('row') or {}
    wk = pure.get('week') if isnum(pure.get('week')) else row.get('week')
    if row.get('early_season') is not None:
        early = 1 if truthy(row.get('early_season')) else 0
    else:
        early = 1 if (isnum(wk) and wk <= 3) else 0
    return {'pure_cover_prob': p_pure, 'gap_pts': gap_side, 'abs_gap_pts': abs(gap_side),
            'sigma': pure.get('sigma'), 'ens_sd': pure['ensemble_sd'] if isnum(pure.get('ensemble_sd')) else row.get('ens_sd'),
            'reliability': pure.get('football_prediction_confidence'), 'week': wk, 'early_season': early,
            'qb_unsettled': 1 if truthy(row.get('qb_unsettled_any')) else 0,
            'qb_missing': 1 if truthy(row.get('qb_missing_any')) else 0,
            'dispersion': mc['dispersion_iqr'] if (mc and isnum(mc.get('dispersion_iqr'))) else None,
            'books': mc.get('books') if mc else None, 'quote_age_min': mc.get('age_minutes') if mc else None,
            'is_home_side': 1 if side == 'HOME' else 0, 'abs_line': abs(quote['home_line'])}


def side_numbers(pure, quote, side, ctx):
    P, A = ctx.get('policy') or {}, ctx['artifact']
    price = quote.get('price_home') if side == 'HOME' else quote.get('price_away')
    other = quote.get('price_away') if side == 'HOME' else quote.get('price_home')
    p_pure = pure_cover(pure, quote['home_line'], side)
    gap = pure['projected_margin'] - (-quote['home_line'])
    gap_side = gap if side == 'HOME' else -gap
    dv = devig(price, other)
    market_p = dv['p_a'] if dv else 0.5
    feats = features(pure, quote, side, p_pure, gap_side, ctx, ctx.get('_mc'))
    if p_pure is None:
        dp = {'calibrated': None, 'decision': None, 'w_model': None}
    else:
        dp = decision_probability(p_pure, market_p, feats, A)
    feats['decision_cover_prob'] = dp['decision']
    pp = push_prob(quote['home_line'], A.get('push_table') or P.get('push_table'))
    be = break_even(price)
    ev = expected_value(dp['decision'], pp, price)
    ev_t = expected_value(p_pure, pp, price)
    cT = A['ev_curve'] if (A.get('ev_curve') and A['ev_curve'].get('input') == 'theoretical_ev') else None
    cD = A.get('ev_curve_decision') or (A.get('ev_curve') if (A.get('ev_curve') and not cT) else None)
    if isnum(ev):
        ev_emp = REF.interp(cD['x'], cD['y'], ev) if cD else (None if cT else ev)
    else:
        ev_emp = ev
    ev_emp_t = REF.interp(cT['x'], cT['y'], ev_t) if (isnum(ev_t) and cT) else None
    exp_clv = REF.eval_model(A['clv_magnitude'], feats) if A.get('clv_magnitude') else None
    return {'side': side, 'price': price if isnum(price) else None, 'pure_cover_probability': p_pure,
            'calibrated_cover_probability': dp['calibrated'], 'decision_cover_probability': dp['decision'],
            'w_model': dp['w_model'], 'market_implied_probability': market_p, 'devig': dv, 'push_probability': pp,
            'break_even_probability': be,
            'probability_edge': (dp['decision'] - be) if (isnum(be) and isnum(dp['decision'])) else None,
            'theoretical_ev': ev_t, 'decision_ev': ev, 'empirical_ev': ev_emp, 'empirical_ev_theoretical': ev_emp_t,
            'expected_clv_pts': exp_clv, 'gap_pts': gap_side, 'features': feats}


# ----------------------------------------------------------- price targets
def price_targets(pure, quote, side, ctx):
    P, A = ctx['policy'], ctx['artifact']
    ref = P['reference_price'] if isnum(P.get('reference_price')) else -110
    sgn = 1 if side == 'HOME' else -1
    line_side = sgn * quote['home_line']

    def at_line(line_for_side, price):
        q = {'game_id': quote.get('game_id'), 'home_line': sgn * line_for_side,
             'price_home': price if side == 'HOME' else None, 'price_away': price if side == 'AWAY' else None,
             'observed_at': quote.get('observed_at'), 'book': quote.get('book')}
        return side_numbers(pure, q, side, ctx)

    def clears(n):
        return (isnum(n['probability_edge']) and isnum(n['empirical_ev']) and n['probability_edge'] >= P['min_probability_edge']
                and n['empirical_ev'] >= P['min_ev'])

    cur_price = quote.get('price_home') if side == 'HOME' else quote.get('price_away')
    cur = at_line(line_side, cur_price if isnum(cur_price) else ref)
    ev_floor = decision_ev_floor(A, P['min_ev'])
    pc, pp = cur['decision_cover_probability'], cur['push_probability']
    if ev_floor is None or not isnum(pc):
        min_price = None
    else:
        min_price = None if ev_floor == -math.inf else minimum_price(pc, pp, ev_floor)
    cands, floor_ok = [], (ev_floor is not None and isnum(pc))
    if floor_ok and ev_floor != -math.inf:
        if isnum(min_price):
            cands.append(min_price)
        else:
            floor_ok = False
    be_max = pc - P['min_probability_edge'] if isnum(pc) else None
    if floor_ok:
        if isnum(be_max) and 0 < be_max < 1:
            cands.append(payout_to_american((1 - be_max) / be_max))
        else:
            floor_ok = False
    cand = None
    if floor_ok:
        for c in cands:
            if cand is None or price_better_or_equal(c, cand):
                cand = c
    k = 0
    while cand is not None and k < 5 and not clears(at_line(line_side, cand)):
        cand = next_better_price(cand)
        k += 1
    if cand is not None and not clears(at_line(line_side, cand)):
        cand = None

    def worst(pred):
        found, L = None, line_side + 10
        while L >= line_side - 10 - 1e-9:
            n = at_line(L, ref)
            if pred(n):
                found = L
            elif found is not None:
                break
            L -= 0.5
        return found

    bettable = worst(clears)
    ideal_edge = P['ideal_probability_edge'] if isnum(P.get('ideal_probability_edge')) else 2 * P['min_probability_edge']
    ideal = worst(lambda n: isnum(n['probability_edge']) and n['probability_edge'] >= ideal_edge and clears(n))
    worst_allowed = P.get('max_price')
    if cand is None:
        floor = None
    else:
        floor = cand if (not isnum(worst_allowed) or price_better_or_equal(cand, worst_allowed)) else worst_allowed
    return {'side': side, 'current_line': line_side, 'reference_price': ref, 'bettable_to_price': floor,
            'bettable_to_line': bettable, 'ideal_entry_line': ideal,
            'acceptable_entry': {'line': bettable, 'price': ref} if bettable is not None else None,
            'minimum_ev_entry': {'line': line_side, 'price': min_price} if isnum(min_price) else None,
            'do_not_bet': {'worse_than_line': bettable, 'or_price_worse_than': floor} if bettable is not None else {'any': True}}


# ------------------------------------------------------------- the quote
def decide_quote(pure, quote, ctx, with_targets=True):
    """decision.js decideQuote. with_targets=False skips priceTargets (the status never reads the CURRENT
    decision's targets; only a later snapshot reads them through ctx['previous'])."""
    ctx = dict(ctx or {})
    P, A = ctx.get('policy'), ctx.get('artifact')
    now = ctx.get('now')
    now = float(now) if isnum(now) else parse_ms(now)
    out = {'engine': ENGINE_ID, 'engine_version': ENGINE_VERSION, 'status': 'NO_BET', 'timing': 'NONE',
           'reason_codes': [], 'book': (quote or {}).get('book'), 'game_id': (pure or {}).get('game_id')}

    def fin(status, codes):
        out['status'] = status
        for c in codes:
            if c not in out['reason_codes']:
                out['reason_codes'].append(c)
        if status != 'BET':
            out['timing'] = 'NONE'
            out['stake_u'] = 0
        return out

    if not pure or pure.get('status') != 'PREDICTED':
        return fin('NO_BET', ['NO_BET_COMPUTATION'])
    pv = validate_policy(P)
    if not pv['ok']:
        return fin('NO_BET', [pv['code']])
    av = validate_artifact(A, pure.get('model_version'))
    if not av['ok']:
        return fin('NO_BET', [av['code']])
    if not quote or not isnum(quote.get('home_line')):
        return fin('NO_BET', ['NO_BET_COMPUTATION'])
    if quote_problems(quote, now):
        return fin('PASS', ['PASS_MARKET_INVALID'])
    mi = (ctx.get('market') or {}).get('integrity')
    if mi and mi.get('quarantined_quote_ids') and quote_key(quote) in mi['quarantined_quote_ids']:
        return fin('PASS', ['PASS_MARKET_INVALID'])
    ctx['now'] = now
    mc = market_confidence(quote, ctx.get('market') or {}, now, P)
    ctx['_mc'] = mc
    try:
        h = side_numbers(pure, quote, 'HOME', ctx)
        a = side_numbers(pure, quote, 'AWAY', ctx)
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return fin('NO_BET', ['NO_BET_COMPUTATION'])
    if isnum(h['probability_edge']) and isnum(a['probability_edge']):
        s = h if h['probability_edge'] >= a['probability_edge'] else a
    elif isnum(h['decision_cover_probability']) and isnum(a['decision_cover_probability']):
        s = h if h['decision_cover_probability'] >= a['decision_cover_probability'] else a
    else:
        s = h
    if not isnum(s['pure_cover_probability']) or not isnum(s['decision_cover_probability']):
        return fin('NO_BET', ['NO_BET_COMPUTATION'])
    out['side'] = s['side']
    out['line_for_side'] = quote['home_line'] if s['side'] == 'HOME' else -quote['home_line']
    out['price'] = s['price']
    for k, src, d in (('pure_cover_probability', 'pure_cover_probability', 4),
                      ('calibrated_cover_probability', 'calibrated_cover_probability', 4),
                      ('decision_cover_probability', 'decision_cover_probability', 4),
                      ('market_implied_probability', 'market_implied_probability', 4), ('model_weight', 'w_model', 3),
                      ('push_probability', 'push_probability', 4), ('break_even_probability', 'break_even_probability', 4),
                      ('probability_edge', 'probability_edge', 4), ('theoretical_ev', 'theoretical_ev', 4),
                      ('decision_ev', 'decision_ev', 4), ('empirical_ev', 'empirical_ev', 4),
                      ('expected_clv_pts', 'expected_clv_pts', 2), ('model_market_gap_pts', 'gap_pts', 2)):
        out[k] = r(s[src], d)
    out['raw'] = {k: s[k] for k in ('probability_edge', 'decision_ev', 'empirical_ev', 'decision_cover_probability',
                                     'pure_cover_probability', 'break_even_probability', 'expected_clv_pts', 'gap_pts')}
    out['football_confidence'] = football_confidence(pure, A)
    out['market_confidence'] = mc
    out['bet_confidence'] = bet_confidence(s['features'], A)
    out['price_targets'] = price_targets(pure, quote, s['side'], ctx) if with_targets else None
    ev, pe, row = s['empirical_ev'], s['probability_edge'], ctx.get('row') or {}
    integ = integrity_check(pure, quote, ctx, s['gap_pts'], s['decision_ev'], s['decision_cover_probability'])
    out['integrity'] = integ
    if not integ['ok']:
        return fin('PASS', ['PASS_DATA_QUALITY'])
    if mc['age_minutes'] is None or mc['age_minutes'] > P['stale_minutes']:
        return fin('PASS', ['PASS_MARKET_STALE'])
    if not isnum(s['price']):
        return fin('PASS', ['PASS_PRICE'])
    if isnum(P.get('max_price')) and not price_better_or_equal(s['price'], P['max_price']):
        return fin('PASS', ['PASS_PRICE'])
    if isnum(mc['dispersion_iqr']) and mc['dispersion_iqr'] > jor(P.get('max_dispersion_iqr'), 1.5):
        return fin('PASS', ['PASS_MARKET_DISPERSION'])
    if not isnum(ev) or not isnum(pe):
        return fin('NO_BET', ['NO_BET_COMPUTATION'])
    prev = ctx.get('previous')
    pt = (prev or {}).get('price_targets') or {}
    if (prev and prev.get('side') == s['side'] and isnum(pt.get('bettable_to_line'))
            and out['line_for_side'] < pt['bettable_to_line'] - 1e-9 and pe < P['min_probability_edge']):
        return fin('PASS', ['PASS_LINE_MOVED'])
    clears = pe >= P['min_probability_edge'] and ev >= P['min_ev']
    held = False
    hy = P.get('hysteresis')
    if (not clears and prev and prev.get('status') == 'BET' and prev.get('side') == s['side'] and truthy(hy)
            and pe >= P['min_probability_edge'] - jor(hy.get('edge_buffer'), 0) and ev >= P['min_ev'] - jor(hy.get('ev_buffer'), 0)):
        clears, held = True, True
    research = []
    if truthy(row.get('qb_missing_any')) or truthy(row.get('qb_unsettled_any')):
        research.append('RESEARCH_QB')
    if isnum(mc['books']) and mc['books'] < jor(P.get('min_books'), 3):
        research.append('RESEARCH_MARKET_IMMATURE')
    if truthy(row.get('data_incomplete')):
        research.append('RESEARCH_DATA_INCOMPLETE')
    if integ['extreme']:
        research.append('RESEARCH_EXTREME_EDGE')
    fc, bc = out['football_confidence'], out['bet_confidence']
    uncertain = isnum(P.get('min_football_confidence')) and isnum(fc['score']) and fc['score'] < P['min_football_confidence']
    ens = s['features']['ens_sd']
    disagree = isnum(P.get('max_ensemble_sd')) and isnum(ens) and ens > P['max_ensemble_sd']
    weak = isnum(P.get('min_bet_confidence')) and (not isnum(bc['score']) or bc['score'] < P['min_bet_confidence'])
    if clears:
        if research:
            return fin('RESEARCH', research)
        if uncertain:
            return fin('PASS', ['PASS_MODEL_UNCERTAINTY'])
        if disagree:
            return fin('PASS', ['PASS_MODEL_DISAGREEMENT'])
        if weak:
            return fin('LEAN', ['LEAN_DIRECTIONAL'])
        if not truthy(P.get('bet_enabled')):
            return fin('LEAN', ['NO_BET_BETTING_DISABLED'])
        if mi and truthy(mi.get('actionable_status')) and mi['actionable_status'] != 'ACTIONABLE':
            st = mi['actionable_status']
            return fin('PASS', ['PASS_MARKET_STALE' if st == 'MARKET_STALE' else
                                ('PASS_MARKET_INVALID' if st == 'MARKET_INVALID' else 'PASS_MARKET_DEGRADED')])
        out['timing'] = timing(out, s, ctx)
        if held:
            out['reason_codes'].append('HELD_BY_HYSTERESIS')
        out['stake_u'] = stake(out, P)
        return fin('BET', ['BET_VALIDATED'])
    L = P.get('lean') or {}
    if pe > jor(L.get('min_probability_edge'), 0) and abs(s['gap_pts']) >= jor(L.get('min_gap_pts'), 1) and not research:
        return fin('LEAN', ['LEAN_DIRECTIONAL'])
    if research and s['pure_cover_probability'] - s['break_even_probability'] >= P['min_probability_edge']:
        return fin('RESEARCH', research)
    return fin('PASS', ['PASS_PRICE' if pe <= 0 else 'PASS_INSUFFICIENT_EV'])


def timing(out, s, ctx):
    W = ctx['policy'].get('wait')
    if not W or not truthy(W.get('enabled')) or not isnum(out.get('expected_clv_pts')):
        return 'BET_NOW'
    if out['expected_clv_pts'] >= 0:
        return 'BET_NOW'
    gain = -out['expected_clv_pts'] * jor(W.get('ev_per_point'), 0.03)
    loss = jor(W.get('p_disappear'), 0.3) * jor(out.get('empirical_ev'), 0)
    return 'WAIT' if gain - loss > jor(W.get('min_benefit_ev'), 0.01) else 'BET_NOW'


# ---------------------------------------------------------------- staking
def kelly_fraction(p, price):
    b = american_to_payout(price)
    if b is None or not isnum(p):
        return 0.0
    return max(0.0, (b * p - (1 - p)) / b)


def stake(d, P):
    S = P.get('stake') or {}
    unit = S['unit_u'] if isnum(S.get('unit_u')) else 1
    if S.get('method') != 'fractional_kelly' or not truthy(S.get('kelly_validated')):
        return min(unit, S['max_stake_u'] if isnum(S.get('max_stake_u')) else unit)
    frac = clamp(S['kelly_fraction'] if isnum(S.get('kelly_fraction')) else 0.1, 0, 0.25)
    p_sat = S['saturation_probability'] if isnum(S.get('saturation_probability')) else 0.6
    p = min(d['decision_cover_probability'], p_sat)
    f = kelly_fraction(p, d['price']) * frac * (S['bankroll_u'] if isnum(S.get('bankroll_u')) else 100)
    return r(min(f, S['max_stake_u'] if isnum(S.get('max_stake_u')) else 1), 2)


def down3(x):
    return math.floor(x * 1000 + 1e-9) / 1000


def apply_exposure(positions, P):
    E = P.get('exposure') or {}
    lst = []
    for x in positions:
        y = dict(x)
        y['stake_u'] = x.get('stake_u') or 0
        y['scaled_by'] = []
        lst.append(y)
    by_game, order = {}, []
    for x in lst:
        k = js_str(x.get('game_id'))
        if k not in by_game:
            by_game[k] = []
            order.append(k)
        by_game[k].append(x)
    rho = E['same_game_correlation'] if isnum(E.get('same_game_correlation')) else 1
    cap = E['max_game_u'] if isnum(E.get('max_game_u')) else 1.5
    for k in order:
        g = by_game[k]
        v = 0.0
        for i in range(len(g)):
            v += g[i]['stake_u'] * g[i]['stake_u']
            for j in range(i + 1, len(g)):
                v += 2 * rho * g[i]['stake_u'] * g[j]['stake_u']
        eff = math.sqrt(max(0.0, v))
        if eff > cap and eff > 0:
            for x in g:
                x['stake_u'] = down3(x['stake_u'] * cap / eff)
                x['scaled_by'].append('game cap %su' % js_str(cap))

    def cap_group(key, cap_u, label):
        if not isnum(cap_u):
            return
        groups, gorder = {}, []
        for x in lst:
            gk = key(x)
            if gk is not None:
                if gk not in groups:
                    groups[gk] = []
                    gorder.append(gk)
                groups[gk].append(x)
        for gk in gorder:
            s = 0.0
            for x in groups[gk]:
                s = s + x['stake_u']
            if s > cap_u:
                for x in groups[gk]:
                    x['stake_u'] = down3(x['stake_u'] * cap_u / s)
                    x['scaled_by'].append('%s %su' % (label, js_str(cap_u)))

    cap_group(lambda x: x.get('conference_cluster') or None, E.get('max_cluster_u'), 'cluster cap')
    cap_group(lambda x: 'slate', E.get('max_slate_u'), 'slate cap')
    tot = 0.0
    for x in lst:
        tot = tot + x['stake_u']
    return {'positions': lst, 'total_u': r(tot, 3)}


# ---------------------------------------------------------------- the game
def decide_game(pure, market, ctx):
    """decision.js decideGame, for a market whose integrity the caller assessed (market['integrity'])
    or none (the integrity module is node-only)."""
    ctx = ctx or {}
    quotes = (market or {}).get('quotes') or []
    per = []
    for q in quotes:
        if not q or q.get('market_type') == 'total' or truthy(q.get('alternate')):
            continue
        prev = (ctx.get('previous_by_book') or {}).get(q.get('book')) if ctx.get('previous_by_book') else None
        c = dict(ctx)
        c.update(market=market, previous=prev)
        per.append(decide_quote(pure, q, c))
    rank = lambda d: d['empirical_ev'] if isnum(d.get('empirical_ev')) else -1
    tie = lambda d: d['decision_ev'] if isnum(d.get('decision_ev')) else -1
    order = {'BET': 5, 'RESEARCH': 4, 'LEAN': 3, 'PASS': 2, 'NO_BET': 1}
    idx = list(range(len(per)))
    bets = sorted([i for i in idx if per[i]['status'] == 'BET'], key=lambda i: (-rank(per[i]), -tie(per[i]), i))
    tops = sorted(idx, key=lambda i: (-order[per[i]['status']], -rank(per[i]), -tie(per[i]), i))
    best = bets[0] if bets else None
    top = tops[0] if tops else None
    return {'status': 'BET' if best is not None else (per[top]['status'] if top is not None else 'NO_BET'),
            'summary_index': best if best is not None else top, 'decisions': per,
            'best_book': per[best]['book'] if best is not None else None}


# ============================================================ replay helpers
def load_artifact(path=CAL_JSON):
    with open(path) as f:
        return json.load(f)


def row_to_inputs(rw, price_home=-110.0, price_away=-110.0, home_line=None, books=None, dispersion=None):
    """A decision-dataset row -> (pure, quote, ctx pieces) exactly as production would see it at the
    decision instant: the quote observed at decision_ts (age 0: the historical convention assumes the
    opener was available at the Tuesday freeze), no book count or dispersion (not point in time
    historically), the row's QB and early-season flags."""
    now = parse_ms(rw['decision_ts_iso'])
    hl = rw['quote_home_line'] if home_line is None else home_line
    pure = {'status': 'PREDICTED', 'game_id': js_str(rw['game_id']), 'model_version': rw['model_version'],
            'projected_margin': float(rw['pure_margin']), 'sigma': float(rw['sigma']), 't_df': float(rw['t_df']),
            'football_prediction_confidence': float(rw['reliability']) if isnum(rw.get('reliability')) else None,
            'ensemble_sd': float(rw['ens_sd']) if isnum(rw.get('ens_sd')) else None,
            'week': int(rw['week']), 'kickoff': rw['kickoff_iso']}
    quote = {'game_id': js_str(rw['game_id']), 'book': rw.get('book') or 'CONSENSUS', 'home_line': float(hl),
             'price_home': price_home, 'price_away': price_away, 'observed_at': rw['decision_ts_iso']}
    row = {'early_season': float(rw['early_season']), 'qb_missing_any': bool(rw.get('qb_missing')),
           'qb_unsettled_any': bool(rw.get('qb_unsettled')),
           'data_incomplete': bool(isnum(rw.get('data_completeness')) and rw['data_completeness'] < DATA_COMPLETE_MIN)}
    market = {'books': books, 'dispersion_iqr': dispersion}
    return pure, quote, row, market, now


DATA_COMPLETE_MIN = 0.95      # declared: a snapshot missing > 5% of the production model's inputs is incomplete


def replay(rows, policy, artifact, previous=None, with_targets=False):
    """decide_quote over dataset rows (dicts from row_to_inputs-ready records). Returns decisions in order."""
    out = []
    for i, rw in enumerate(rows):
        pure, quote, row, market, now = row_to_inputs(rw, rw.get('_price_home', -110.0), rw.get('_price_away', -110.0),
                                                      rw.get('_home_line'))
        ctx = {'policy': policy, 'artifact': artifact, 'now': now, 'market': market, 'row': row,
               'expected_model_version': pure['model_version']}
        if previous is not None and previous[i] is not None:
            ctx['previous'] = previous[i]
        out.append(decide_quote(pure, quote, ctx, with_targets=with_targets))
    return out


# ================================================================ the parity fixture
NOW_ISO = '2026-10-01T15:00:00.000Z'
KICK_ISO = '2026-10-03T19:30:00.000Z'


def _base_pure(**over):
    p = {'status': 'PREDICTED', 'game_id': '401', 'model_version': 'edgedesk_cfb_v2.1.0', 'home': 'Texas Tech',
         'away': 'Baylor', 'projected_margin': 9.5, 'sigma': 15.0, 't_df': 100, 'football_prediction_confidence': 70,
         'ensemble_sd': 2.0, 'week': 6, 'kickoff': KICK_ISO}
    p.update(over)
    return p


def _base_quote(**over):
    q = {'game_id': '401', 'book': 'bookA', 'home_line': -3.5, 'price_home': -110, 'price_away': -110,
         'observed_at': '2026-10-01T14:50:00.000Z', 'market_type': 'spread'}
    q.update(over)
    return q


# a test policy that CAN bet (fixture only: the committed production policy never enables betting)
TEST_POLICY = {
    'version': 'parity_test_policy', 'bet_enabled': True, 'min_probability_edge': 0.02, 'min_ev': 0.02,
    'stale_minutes': 180, 'max_price': -125, 'max_dispersion_iqr': 1.5, 'min_books': 3, 'min_football_confidence': 30,
    'max_ensemble_sd': 6, 'extreme_gap_pts': 10, 'extreme_ev': 0.15, 'extreme_max_age_minutes': 60,
    'lean': {'min_probability_edge': 0, 'min_gap_pts': 1}, 'hysteresis': {'ev_buffer': 0.004, 'edge_buffer': 0.004},
    'wait': {'enabled': False}, 'reference_price': -110,
    'stake': {'method': 'flat', 'unit_u': 1, 'max_stake_u': 1},
    'exposure': {'max_game_u': 1.5, 'max_slate_u': 3, 'same_game_correlation': 1}}
# the frozen artifact with the decision EV mapped through the identity (fixture only), so every gate is reachable
BETTABLE_PATCH = {'ev_curve_decision': {'input': 'decision_ev', 'x': [-0.2, 0.3], 'y': [-0.2, 0.3]},
                  'cover_calibration': {'map': {'method': 'platt', 'a': 0, 'b': 0.6}},
                  'market_shrinkage': {'w_model': 0.85, 'space': 'logit'}}


def _merge(base, patch):
    out = copy.deepcopy(base)
    for k, v in (patch or {}).items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = copy.deepcopy(v)
    return out


def fixture_cases(prod_policy=None):
    """(id, note, pure, quote, ctx-spec) cases covering every status, reason code, timing and stake path."""
    T = TEST_POLICY
    B = BETTABLE_PATCH
    cases = []

    def add(cid, note, pure=None, quote=None, policy=None, policy_patch=None, artifact_patch=None, market=None, row=None,
            now=NOW_ISO, previous=None, artifact_missing=False, expected_model_version=None):
        pol = _merge(policy if policy is not None else T, policy_patch) if policy is not None or policy_patch else copy.deepcopy(T)
        cases.append({'id': cid, 'note': note, 'pure': pure or _base_pure(), 'quote': quote or _base_quote(),
                      'policy': pol, 'artifact_patch': artifact_patch if artifact_patch is not None else B,
                      'artifact_missing': artifact_missing,
                      'market': market if market is not None else {'books': 6, 'dispersion_iqr': 0.5},
                      'row': row if row is not None else {}, 'now': now, 'previous': previous,
                      'expected_model_version': expected_model_version})

    add('bet_clear', 'a clear price edge: BET, flat 1u, BET_NOW')
    add('lean_small_edge', 'a small edge below the thresholds: LEAN_DIRECTIONAL', quote=_base_quote(home_line=-7.5))
    add('pass_price_fair_line', 'no edge at the fair line: PASS_PRICE', quote=_base_quote(home_line=-9.5))
    add('pass_insufficient_ev', 'a positive edge below 1 point of gap: PASS_INSUFFICIENT_EV',
        pure=_base_pure(projected_margin=4.3), quote=_base_quote(home_line=-3.5, price_home=102, price_away=-122))
    add('pass_juice', 'an edge at terrible juice (worse than the price limit): PASS_PRICE', quote=_base_quote(price_home=-135, price_away=115))
    add('pass_no_price', 'no captured price: PASS_PRICE, never an assumed -110', quote=_base_quote(price_home=None, price_away=None))
    add('pass_stale', 'a stale quote: PASS_MARKET_STALE', quote=_base_quote(observed_at='2026-10-01T09:00:00.000Z'))
    add('pass_dispersion', 'books disagree: PASS_MARKET_DISPERSION', market={'books': 6, 'dispersion_iqr': 2.5})
    add('pass_uncertainty', 'an uncertain projection: PASS_MODEL_UNCERTAINTY', pure=_base_pure(football_prediction_confidence=10))
    add('pass_disagreement', 'submodel disagreement: PASS_MODEL_DISAGREEMENT', pure=_base_pure(ensemble_sd=9))
    add('research_qb', 'an unresolved QB: RESEARCH_QB', row={'qb_unsettled_any': True})
    add('research_immature', 'one book: RESEARCH_MARKET_IMMATURE', market={'books': 1, 'dispersion_iqr': 0})
    add('research_incomplete', 'incomplete inputs: RESEARCH_DATA_INCOMPLETE', row={'data_incomplete': True})
    add('research_extreme', 'an extreme edge that passes integrity: RESEARCH_EXTREME_EDGE',
        pure=_base_pure(projected_margin=21), quote=_base_quote(home_line=-7))
    add('pass_data_quality_stale_extreme', 'an extreme edge with a 2.5-hour-old quote: PASS_DATA_QUALITY',
        pure=_base_pure(projected_margin=21), quote=_base_quote(home_line=-7, observed_at='2026-10-01T12:30:00.000Z'))
    add('pass_data_quality_mapping', 'a quote for another game: PASS_DATA_QUALITY', quote=_base_quote(game_id='999'))
    add('pass_data_quality_flip', 'a sign-flipped market: PASS_DATA_QUALITY', pure=_base_pure(projected_margin=-24),
        quote=_base_quote(home_line=-24))
    add('pass_data_quality_kickoff', 'after kickoff', now='2026-10-03T20:00:00.000Z')
    add('pass_data_quality_version', 'the expected model version differs', expected_model_version='edgedesk_cfb_v9')
    add('lean_betting_disabled', 'betting disabled: LEAN NO_BET_BETTING_DISABLED', policy_patch={'bet_enabled': False})
    add('lean_weak_bet', 'bet confidence below the policy floor: LEAN_DIRECTIONAL', policy_patch={'min_bet_confidence': 99})
    add('pass_market_degraded', 'an assessed consensus that is not actionable: PASS_MARKET_DEGRADED',
        market={'books': 6, 'dispersion_iqr': 0.5, 'integrity': {'actionable_status': 'MARKET_DEGRADED', 'reasons': ['few books']}})
    add('pass_market_stale_consensus', 'an assessed consensus that is stale: PASS_MARKET_STALE',
        market={'books': 6, 'dispersion_iqr': 0.5, 'integrity': {'actionable_status': 'MARKET_STALE'}})
    add('pass_market_invalid_quarantine', 'a quarantined quote: PASS_MARKET_INVALID',
        quote=_base_quote(quote_id='q-77'), market={'books': 6, 'dispersion_iqr': 0.5, 'integrity': {'quarantined_quote_ids': ['q-77']}})
    add('pass_market_invalid_price', 'an impossible American price: PASS_MARKET_INVALID', quote=_base_quote(price_home=50, price_away=-110))
    add('pass_market_invalid_spread', 'an impossible spread: PASS_MARKET_INVALID', quote=_base_quote(home_line=-80))
    add('no_bet_calibration', 'no calibration artifact: NO_BET_CALIBRATION', artifact_missing=True)
    add('no_bet_version', 'a model version the artifact was not validated for: NO_BET_VERSION_MISMATCH',
        pure=_base_pure(model_version='edgedesk_cfb_v3.0.0'))
    add('no_bet_policy', 'a policy without max_price: NO_BET_POLICY', policy_patch={'max_price': None})
    add('no_bet_computation', 'a failed probability computation: NO_BET_COMPUTATION', pure=_base_pure(sigma=float('nan')))
    add('no_bet_not_predicted', 'a projection that is not PREDICTED: NO_BET_COMPUTATION', pure=_base_pure(status='NO_DATA'))
    add('bet_wait', 'validated WAIT and a line expected to improve by 2 points: WAIT',
        policy_patch={'wait': {'enabled': True, 'ev_per_point': 0.03, 'p_disappear': 0.1, 'min_benefit_ev': 0.005}},
        artifact_patch=_merge(B, {'clv_magnitude': {'type': 'linear', 'intercept': -2, 'coef': {}}}))
    add('bet_now_tiny', 'a trivial expected improvement: BET_NOW',
        policy_patch={'wait': {'enabled': True, 'ev_per_point': 0.03, 'p_disappear': 0.1, 'min_benefit_ev': 0.005}},
        artifact_patch=_merge(B, {'clv_magnitude': {'type': 'linear', 'intercept': -0.1, 'coef': {}}}))
    add('bet_kelly', 'fractional Kelly validated: 0.25 Kelly, capped at 1u',
        policy_patch={'stake': {'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 0.25, 'bankroll_u': 100,
                                'max_stake_u': 1, 'saturation_probability': 0.58}})
    add('bet_kelly_saturated', 'Kelly input capped at the saturation probability',
        policy_patch={'stake': {'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 0.25, 'bankroll_u': 100,
                                'max_stake_u': 5, 'saturation_probability': 0.52}})
    add('bet_kelly_unvalidated', 'unvalidated Kelly falls back to flat',
        policy_patch={'stake': {'method': 'fractional_kelly', 'kelly_validated': False, 'unit_u': 1, 'max_stake_u': 1}})
    add('bet_kelly_above_quarter', 'a policy asking for full Kelly gets quarter Kelly',
        policy_patch={'stake': {'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 1, 'bankroll_u': 100,
                                'max_stake_u': 100, 'saturation_probability': 0.7}})
    add('away_side_bet', 'the model prefers the away side', pure=_base_pure(projected_margin=-9.5), quote=_base_quote(home_line=3.5))
    add('shaded_price', 'a shaded two-sided price (de-vig != 0.5)', quote=_base_quote(price_home=-118, price_away=-102))
    add('plus_money', 'a plus-money side', pure=_base_pure(projected_margin=2.0), quote=_base_quote(home_line=4.5, price_home=120, price_away=-140))
    add('key_number_3', 'an integer line on 3 (push probability)', quote=_base_quote(home_line=-3.0))
    add('postseason_week1', 'a postseason game: schedule week 1 with an explicit early_season 0',
        pure=_base_pure(week=1), row={'early_season': 0})
    add('same_team_join', 'a quote carrying the same home team name', quote=_base_quote(home_team='Texas Tech'))
    # hysteresis and line-moved: the previous decision is another case's output
    prev_far = {'status': 'BET', 'side': 'HOME', 'price_targets': {'bettable_to_line': -99}}
    prev_near = {'status': 'BET', 'side': 'HOME', 'price_targets': {'bettable_to_line': -6.0}}
    add('hyst_held', 'just below the thresholds after a BET on the same side: HELD_BY_HYSTERESIS',
        quote=_base_quote(home_line=-7.0), previous=prev_far, policy_patch={'hysteresis': {'ev_buffer': 0.05, 'edge_buffer': 0.05}})
    add('hyst_not_held', 'the same without a buffer: not a BET', quote=_base_quote(home_line=-7.0), previous=prev_far,
        policy_patch={'hysteresis': None})
    add('hyst_other_side', 'a previous BET on the other side is never held', quote=_base_quote(home_line=-7.0),
        previous={'status': 'BET', 'side': 'AWAY', 'price_targets': {'bettable_to_line': -99}},
        policy_patch={'hysteresis': {'ev_buffer': 0.05, 'edge_buffer': 0.05}})
    add('line_moved', 'the line moved through the previous bettable-to: PASS_LINE_MOVED', quote=_base_quote(home_line=-9.0), previous=prev_near)
    # the frozen artifact as committed (flat decision EV curve): no quote clears at any price
    for cid, pm, hl, ph, pa in (('frozen_edge_110', 12.0, -3.5, -110, -110), ('frozen_small', 6.0, -3.5, -110, -110),
                                ('frozen_plus_price', 12.0, -3.5, 120, -140), ('frozen_away', -12.0, 3.5, -110, -110)):
        add(cid, 'the frozen calibration artifact (flat decision EV curve): the price never clears',
            pure=_base_pure(projected_margin=pm, sigma=16.0), quote=_base_quote(home_line=hl, price_home=ph, price_away=pa),
            artifact_patch={})
    if prod_policy is not None:
        for cid, pm, hl, row, mk in (('prod_lean', 12.0, -3.5, {}, {'books': 5, 'dispersion_iqr': 0.5}),
                                     ('prod_pass', 5.0, -3.5, {}, {'books': 5, 'dispersion_iqr': 0.5}),
                                     ('prod_research_qb', 12.0, -3.5, {'qb_missing_any': True}, {'books': 5, 'dispersion_iqr': 0.5}),
                                     ('prod_one_book', 12.0, -3.5, {}, {'books': 1, 'dispersion_iqr': None}),
                                     ('prod_extreme', 19.0, -3.5, {}, {'books': 5, 'dispersion_iqr': 0.5})):
            add(cid, 'the committed production policy with the frozen artifact', pure=_base_pure(projected_margin=pm, sigma=16.0),
                quote=_base_quote(home_line=hl), policy=prod_policy, artifact_patch={}, row=row, market=mk)
    return cases


def run_case(c, A_frozen):
    A = None if c['artifact_missing'] else _merge(A_frozen, c['artifact_patch'])
    pol = c['policy']
    if pol.get('max_price', 0) is None:
        pol = {k: v for k, v in pol.items() if k != 'max_price'}
    pure = dict(c['pure'])
    if isinstance(pure.get('sigma'), str):
        pure['sigma'] = float(pure['sigma'])
    ctx = {'policy': pol, 'artifact': A, 'now': parse_ms(c['now']), 'market': c['market'], 'row': c['row']}
    if c.get('expected_model_version'):
        ctx['expected_model_version'] = c['expected_model_version']
    if c.get('previous') is not None:
        ctx['previous'] = c['previous']
    return decide_quote(pure, c['quote'], ctx)


EXPOSURE_CASES = [
    ('two_same_game_rho1', [{'game_id': 'g1', 'stake_u': 1}, {'game_id': 'g1', 'stake_u': 1}, {'game_id': 'g2', 'stake_u': 1},
                            {'game_id': 'g3', 'stake_u': 1}], {'max_game_u': 1.5, 'max_slate_u': 3, 'same_game_correlation': 1}),
    ('rho0', [{'game_id': 'g', 'stake_u': 1}, {'game_id': 'g', 'stake_u': 1}], {'max_game_u': 1.5, 'same_game_correlation': 0}),
    ('rho_mid_cluster', [{'game_id': 'a', 'stake_u': 1, 'conference_cluster': 'SEC'}, {'game_id': 'a', 'stake_u': 0.8, 'conference_cluster': 'SEC'},
                         {'game_id': 'b', 'stake_u': 1, 'conference_cluster': 'SEC'}, {'game_id': 'c', 'stake_u': 1, 'conference_cluster': 'B12'},
                         {'game_id': 'd', 'stake_u': 0.5}],
     {'max_game_u': 1, 'max_slate_u': 3, 'max_cluster_u': 1.5, 'same_game_correlation': 0.6}),
    ('under_caps', [{'game_id': 'x', 'stake_u': 0.5}, {'game_id': 'y', 'stake_u': 0.5}], {'max_game_u': 1, 'max_slate_u': 8}),
    ('defaults', [{'game_id': 'x', 'stake_u': 1}, {'game_id': 'x', 'stake_u': 1}, {'game_id': 'x', 'stake_u': 1}], {}),
]


def _num_or_none(x):
    return float(x) if isnum(x) else None


def build_fixture(prod_policy=None, path=FIXTURE):
    A = load_artifact()
    cases = fixture_cases(prod_policy)
    fx = []
    for c in cases:
        o = run_case(c, A)
        pt = o.get('price_targets') or {}
        exp = {'status': o['status'], 'reason_codes': o['reason_codes'], 'timing': o['timing'],
               'stake_u': _num_or_none(o.get('stake_u')), 'side': o.get('side'),
               'probability_edge': o.get('probability_edge'), 'empirical_ev': o.get('empirical_ev'),
               'decision_cover_probability': o.get('decision_cover_probability'),
               'expected_clv_pts': o.get('expected_clv_pts'),
               'bettable_to_price': pt.get('bettable_to_price'), 'bettable_to_line': pt.get('bettable_to_line'),
               'ideal_entry_line': pt.get('ideal_entry_line'),
               'bet_confidence_score': (o.get('bet_confidence') or {}).get('score'),
               'market_confidence_score': (o.get('market_confidence') or {}).get('score')}
        cc = {k: v for k, v in c.items()}
        pure = dict(cc['pure'])
        if isinstance(pure.get('sigma'), float) and not math.isfinite(pure['sigma']):
            pure['sigma'] = 'NaN'
        cc['pure'] = pure
        cc['expected'] = exp
        fx.append(cc)
    stakes = []
    for pol_stake, d in (({'method': 'flat', 'unit_u': 1, 'max_stake_u': 1}, {'decision_cover_probability': 0.56, 'price': -110}),
                         ({'method': 'flat', 'unit_u': 1, 'max_stake_u': 0.5}, {'decision_cover_probability': 0.56, 'price': -110}),
                         ({'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 0.1, 'bankroll_u': 100, 'max_stake_u': 1.5,
                           'saturation_probability': 0.55}, {'decision_cover_probability': 0.5412, 'price': -110}),
                         ({'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 0.25, 'bankroll_u': 100, 'max_stake_u': 1.5,
                           'saturation_probability': 0.55}, {'decision_cover_probability': 0.5712, 'price': 105}),
                         ({'method': 'fractional_kelly', 'kelly_validated': True, 'kelly_fraction': 0.25, 'bankroll_u': 100, 'max_stake_u': 1,
                           'saturation_probability': 0.6}, {'decision_cover_probability': 0.49, 'price': -110})):
        stakes.append({'stake_policy': pol_stake, 'decision': d, 'expected_stake_u': stake(d, {'stake': pol_stake}),
                       'expected_kelly_fraction': kelly_fraction(min(d['decision_cover_probability'], pol_stake.get('saturation_probability', 1)), d['price'])})
    expo = []
    for cid, pos, E in EXPOSURE_CASES:
        res = apply_exposure(pos, {'exposure': E})
        expo.append({'id': cid, 'positions': pos, 'exposure': E,
                     'expected': {'total_u': res['total_u'], 'stakes': [x['stake_u'] for x in res['positions']],
                                  'scaled_by': [x['scaled_by'] for x in res['positions']]}})
    games = []
    gq = [_base_quote(book='A', home_line=-8.5), _base_quote(book='B', home_line=-3.5), _base_quote(book='C', home_line=-6.0)]
    for gid, patch in (('game_frozen_flat', {}), ('game_bettable', BETTABLE_PATCH)):
        Ag = _merge(A, patch)
        mk = {'books': 6, 'dispersion_iqr': 0.5, 'integrity': {'actionable_status': 'ACTIONABLE'}, 'quotes': gq}
        pol = prod_policy if (prod_policy is not None and gid == 'game_frozen_flat') else TEST_POLICY
        g = decide_game(_base_pure(projected_margin=12.0, sigma=16.0), mk,
                        {'policy': pol, 'artifact': Ag, 'now': parse_ms(NOW_ISO), 'row': {}})
        games.append({'id': gid, 'artifact_patch': patch, 'policy': pol, 'market': mk,
                      'pure': _base_pure(projected_margin=12.0, sigma=16.0), 'now': NOW_ISO,
                      'expected': {'status': g['status'], 'summary_index': g['summary_index'],
                                   'statuses': [d['status'] for d in g['decisions']]}})
    doc = {'generated_by': 'v2.decision.policy.build_fixture', 'mirror_of': 'football/cfb_decision/decision.js',
           'calibration_artifact': 'cfb_decision_calibration_v1', 'tolerance': 1e-9,
           'note': 'artifact_patch keys replace the frozen calibration artifact\'s keys (fixture only); policies are inline. '
                   'TEST policies enable betting to reach every gate; the committed production policy never does.',
           'cases': fx, 'stakes': stakes, 'exposure': expo, 'games': games}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(doc, f, indent=1, sort_keys=True, allow_nan=False, default=_js_default)
        f.write('\n')
    return doc


def _js_default(o):
    import numpy as np
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    raise TypeError(type(o))


if __name__ == '__main__':
    import sys
    if '--fixture' in sys.argv:
        pp = None
        pj = os.path.join(ARTIFACTS, 'cfb_decision_policy_v1', 'policy.json')
        if os.path.exists(pj):
            pp = json.load(open(pj))
        d = build_fixture(pp)
        print('[policy] wrote', FIXTURE, len(d['cases']), 'cases')
