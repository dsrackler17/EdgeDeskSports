import json, math
SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad/out/'
D = json.load(open(SP + 'decomp.json'))
inc = {r['id']: r for r in json.load(open(SP + 'incumbent_rows.json'))['rows'] if r['season'] == 2026}
res = {r['id']: r for r in json.load(open(SP + 'research_rows.json'))}
mk = {x['id']: x['m'] for x in json.load(open(SP + 'market_join.json'))}
Phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
sig = lambda z: 1 / (1 + math.exp(-z))
for gid, x in D.items():
    g = x['game']; H = x['home']; A = x['away']; c = x['cal']; on = 0 if g['neutral'] else 1
    b = c['b']
    m = (0 if g['neutral'] else x['h']) + H['net'] - A['net']
    comp = [
        ('Home court: (a + b*h)*on = (%.3f + %.4f*%.3f)*%d' % (c['a'], b, x['h'], on), (c['a'] + b * x['h']) * on),
        ('%s prior (0.8 x 2024-25 net %.2f = %.2f) x share %.3f x b' % (H['name'], H['last_season_net'], H['prior_net'], H['share']), b * H['prior_part']),
        ('%s 2025-26 results (%d games) x b' % (H['name'], len(H['games'])), b * H['data_part']),
        ('%s prior (0.8 x 2024-25 net %.2f = %.2f) x share %.3f x b, negated' % (A['name'], A['last_season_net'], A['prior_net'], A['share']), -b * A['prior_part']),
        ('%s 2025-26 results (%d games) x b, negated' % (A['name'], len(A['games'])), -b * A['data_part']),
        ('Rest / back-to-back (model=points: not priced)', 0.0),
        ('Injuries / lineup / transfers (not modelled)', 0.0),
    ]
    total = sum(v for _, v in comp)
    mu_c = c['a'] * on + b * m
    card = x['card']
    print('=' * 100)
    print(gid, g['date'], g['start_utc'], '%s (home) vs %s, neutral=%d' % (H['name'], A['name'], g['neutral']), 'final %s-%s' % (g['hs'], g['as']))
    print('state: mu %.3f h %.3f | cal a %.4f b %.4f w0 %.4f w1 %.5f sd %.3f | ta %.3f tb %.4f sdt %.3f' % (x['mu'], x['h'], c['a'], b, c['w0'], c['w1'], c['sd'], c['ta'], c['tb'], c['sdt']))
    for side in (H, A):
        print('  %s: o %.3f d %.3f net %.3f | prior po %.3f pd %.3f (net %.3f = 0.8 x %.3f) | sw %.3f share k/(sw+k) %.3f | prior part %.3f data part %.3f (sum of per-game contribs %.3f)' % (
            side['name'], side['o'], side['d'], side['net'], side['po'], side['pd'], side['prior_net'], side['last_season_net'], side['sw'], side['share'], side['prior_part'], side['data_part'], side['data_part_recomputed_from_games']))
        for gg in side['games']:
            print('      %s %-30s oppGames %2d score %-7s margin %+4d opp_net %+7.2f resid %+7.2f contrib %+6.2f' % (gg['venue'], gg['opp_name'][:30], gg['opp_games_in_season'], gg['score'], gg['margin'], gg['opp_net'], gg['net_resid'], gg['contrib_net']))
    print('raw margin m = h*on + netH - netA = %.3f*%d + %.3f - %.3f = %.3f' % (x['h'], on, H['net'], A['net'], m))
    for k, v in comp: print('   %+8.3f  %s' % (v, k))
    print('   sum %.3f | mu_c = a*on + b*m = %.3f | residual %.2e | card projected_margin %.1f fair_home_line %.1f' % (total, mu_c, mu_c - total, card['margin'], card['fairSpread']))
    p = card['p_home']
    print('card p_home (logistic) %.4f | Phi(mu/sd) %.4f | diff %.4f' % (p, Phi(mu_c / c['sd']), p - Phi(mu_c / c['sd'])))
    print('card total %.2f fair total %.1f' % (card['total'], card['fairTotal']))
    for L, v in sorted(card['spreadLines'].items(), key=lambda t: float(t[0])):
        print('   home line %6s: home_cover %.4f push %.4f away_cover %.4f fair_home %s fair_away %s' % (L, v['home_cover'], v['push'], v['away_cover'], v['fair_home'], v['fair_away']))
    mm = mk.get(gid); q = res.get(gid)
    if mm: print('DK close (ESPN pickcenter, external): home margin %.1f (%s), open %s, total close %s, ML %s/%s' % (mm['close_margin'], mm['details'], mm['open_margin'], mm['total_close'], mm['ml_h'], mm['ml_a']))
    if q: print('research engine: margin %.2f sd %.2f p %.3f total %.1f (no-roster variant %.2f) cont_h %s cont_a %s' % (q['margin_mu'], q['margin_sd'], q['p_home'], q['total_mu'], q['margin_mu_no_roster'], q['cont_h'], q['cont_a']))
