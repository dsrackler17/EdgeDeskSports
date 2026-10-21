import json, math
from statistics import NormalDist
N = NormalDist()
W = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad/wnba_work'
d = json.load(open(W + '/decomp.json'))
def am(p):
    dd = 1 / p
    return round((dd - 1) * 100) if dd >= 2 else round(-100 / (dd - 1))
def q(x):
    return ('(%.3f)' % x) if x < 0 else ('%.3f' % x)
def fmt(x, n=2): return ('%+.' + str(n) + 'f') % x
def table(x, title, outcome, ledger=None, extra_rows=None):
    D = x['dec']; r = D['raw']; c = D['cal']; cm = D['comp_margin']; p = D['prior']
    H, A = r['H'], r['A']; b = c['b']
    pn = 1 - NormalDist(c['mu'], c['sd']).cdf(0)
    pe = x['elo_p']; me = c['sd'] * N.inv_cdf(pe)
    L = []
    L.append('**' + title + '**\n')
    L.append('| # | Component | Arithmetic | Value |')
    L.append('|---|---|---|---|')
    L.append('| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | %.3f |' % r['mu'])
    L.append('| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = %.3f) | %.3f |' % (r['h'] / 2, r['h']))
    L.append('| 3 | Home offence o_H / home defence d_H | rating (n=%d games, weight sum %.1f) | %.3f / %.3f |' % (H['n'], H['sw'], H['o'], H['d']))
    L.append('| 4 | Away offence o_A / away defence d_A | rating (n=%d games, weight sum %.1f) | %.3f / %.3f |' % (A['n'], A['sw'], A['o'], A['d']))
    L.append('| 5 | Raw home points | mu + h/2 + o_H - d_A = %.3f + %.3f + %s - %s | %.3f |' % (r['mu'], r['h']/2, q(H['o']), q(A['d']), r['ph']))
    L.append('| 6 | Raw away points | mu - h/2 + o_A - d_H = %.3f - %.3f + %s - %s | %.3f |' % (r['mu'], r['h']/2, q(A['o']), q(H['d']), r['pa']))
    L.append('| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = %.3f + %s - %s | %.3f |' % (r['h'], q(r['homeNet']), q(r['awayNet']), r['m']))
    L.append('| 8 | Card margin: calibration intercept (home games only) | a | %s |' % fmt(cm['intercept'], 3))
    L.append('| 9 | Card margin: home court | b*h = %.4f*%.3f | %s |' % (b, r['h'], fmt(cm['hca'], 3)))
    L.append('| 10 | Card margin: home team strength | b*(o_H+d_H) = %.4f*%s | %s |' % (b, q(r['homeNet']), fmt(cm['home_team'], 3)))
    L.append('| 11 | Card margin: away team strength | -b*(o_A+d_A) = -%.4f*%s | %s |' % (b, q(r['awayNet']), fmt(cm['away_team'], 3)))
    L.append('| 12 | **Card projected margin** (sum 8-11) | %.3f %s %s %s | **%.3f** |' % (cm['intercept'], fmt(cm['hca'], 3), fmt(cm['home_team'], 3), fmt(cm['away_team'], 3), c['mu']))
    L.append('| 13 | of which calibration shrink vs raw | a + (b-1)*m = %.3f + (%.4f)*%s | %s |' % (c['a'], b - 1, q(r['m']), fmt(c['mu'] - r['m'], 3)))
    L.append('| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H %.1f%%, A %.1f%% | %s |' % (100 * p['H']['share'], 100 * p['A']['share'], fmt(p['prior_net_margin_card'], 3)))
    L.append('| 15 | Fair home line | -round(2*%.3f)/2 | %.1f |' % (c['mu'], c['fair_line']))
    L.append('| 16 | Unattributed residual (line vs margin; rounding only) | %.1f + %s | %s |' % (c['fair_line'], q(c['mu']), fmt(c['fair_line'] + c['mu'], 3)))
    L.append('| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | %.3f |' % r['t'])
    L.append('| 18 | Card total | a_T + b_T*t = %.3f + %.4f*%.3f (shrinks toward a_T/(1-b_T) = %.1f) | %.2f (fair %.1f) |' % (c['ta'], c['tb'], r['t'], c['ta'] / (1 - c['tb']), c['tmu'], c['fair_total']))
    L.append('| 19 | Card projected score | (total +/- margin)/2 | %.2f - %.2f |' % ((c['tmu'] + c['mu']) / 2, (c['tmu'] - c['mu']) / 2))
    L.append('| 20 | Win prob (logistic, separate fit) | sig(%.4f + %.4f*%.3f) | %.4f (fair %+d) |' % (c['win'][0], c['win'][1], r['m'], c['pw'], am(c['pw'])))
    L.append('| 21 | P(margin>0) from the card\'s own spread distribution | 1-Phi((0-%s)/%.3f) | %.4f (gap %+.1f pp) |' % (q(c['mu']), c['sd'], pn, 100 * (c['pw'] - pn)))
    L.append('| 22 | Comparison: Elo baseline (NOT a market line) | p_elo %.4f -> %.3f*Phi^-1(p) | %+.2f pts (model - Elo = %+.2f) |' % (pe, c['sd'], me, c['mu'] - me))
    if ledger: L.append('| 23 | Published card (ledger) | p / line / total / exp total | %s |' % ledger)
    L.append('| 24 | Outcome | %s | |' % outcome)
    if extra_rows: L.extend(extra_rows)
    return '\n'.join(L) + '\n'
out = []
labels = {'401918305': 'Finals G1 401918305 - Atlanta Dream @ Golden State Valkyries, 2026-10-17 (card from params 2026-10-14, data through 10-09, calibration v1)',
          '401918306': 'Finals G2 401918306 - Atlanta Dream @ Golden State Valkyries, 2026-10-19 (card from params 2026-10-19 00:12, data through 10-17, calibration v2)',
          '401918307': 'Finals G3 401918307 - Golden State Valkyries @ Atlanta Dream, 2026-10-21 (upcoming; card from the same 10-19 params, G2 NOT absorbed)'}
for x in d['cards']:
    led = 'p %.4f / %.1f / %.1f / %.1f' % (x['ledger']['p'], x['ledger']['line'], x['ledger']['total'], x['ledger']['exp'])
    oc = ('final %d-%d (home margin %+d, total %d)' % (x['final'][0], x['final'][1], x['final'][0] - x['final'][1], x['final'][0] + x['final'][1])) if x['final'] else 'not played (scheduled 2026-10-22T00:00Z)'
    out.append(table(x, labels[x['id']], oc, led))
for x in d['wf']:
    y = x['y']
    out.append(table(x, 'Walk-forward %s - %s @ %s, %s (point-in-time replay; no card was logged for this game)' % (x['id'], x['away'], x['home'], x['date']), 'final home margin %+d, total %d' % (y['margin'], y['total'])))
open(W + '/tables.md', 'w').write('\n'.join(out))
print('\n'.join(out))
