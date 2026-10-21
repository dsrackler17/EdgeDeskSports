import json, math, statistics as st
from collections import defaultdict, Counter
SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad/out/'
inc = json.load(open(SP + 'incumbent_rows.json'))
rows = {r['id']: r for r in inc['rows'] if r['season'] == 2026}
res = {r['id']: r for r in json.load(open(SP + 'research_rows.json'))}
pc = json.load(open(SP + 'pickcenter.json'))['games']
S = json.load(open(SP + 'sample_ids.json'))
def mkt(gid):
    r = pc.get(gid)
    if not r or not r.get('providers'): return None
    p = r['providers'][0]
    hl = p['home_close_line']
    if hl is None: return None
    # sanity: ESPN ids must match the CSV home/away (sides could be swapped)
    row = rows[gid]
    swapped = r['home_id'] != row['home'] or r['away_id'] != row['away']
    if swapped:
        if r['home_id'] == row['away'] and r['away_id'] == row['home']:
            hl = -hl
        else:
            return None
    return {'close_margin': -hl, 'home_line': hl if not swapped else -hl, 'open_margin': None if p['home_open_line'] is None else (-p['home_open_line'] if not swapped else p['home_open_line']),
            'total_close': p['total_close'], 'ml_h': p['ml_home_close'] if not swapped else p['ml_away_close'], 'ml_a': p['ml_away_close'] if not swapped else p['ml_home_close'], 'swapped': swapped, 'details': p['details']}
recs = []
for gid in set(S['top']) | set(S['random']) | set(S['post']) | set(S['ge4']):
    m = mkt(gid)
    if not m: continue
    r = rows[gid]; q = res.get(gid)
    recs.append({'id': gid, 'r': r, 'q': q, 'm': m, 'grp': [g for g in ('top', 'random', 'post', 'ge4') if gid in S[g]]})
print('games with DK close and both models:', len(recs), 'swapped sides fixed:', sum(1 for x in recs if x['m']['swapped']))
def nv(a, b):
    def imp(o): return 100/(o+100) if o > 0 else -o/(-o+100)
    if a is None or b is None: return None
    x, y = imp(a), imp(b); return x/(x+y)
def summary(sub, label):
    if not sub: return
    di = [x['r']['mu_c'] - x['m']['close_margin'] for x in sub]
    dr = [x['q']['margin_mu'] - x['m']['close_margin'] for x in sub]
    ei = [abs(x['r']['y']['margin'] - x['r']['mu_c']) for x in sub]
    er = [abs(x['r']['y']['margin'] - x['q']['margin_mu']) for x in sub]
    ec = [abs(x['r']['y']['margin'] - x['m']['close_margin']) for x in sub]
    adi = sorted(abs(v) for v in di)
    print('%-22s n=%3d | incumbent-close: mean %+.2f MAE %.2f p90 %.2f max %.2f | research-close: mean %+.2f MAE %.2f | MAE vs result: inc %.2f res %.2f close %.2f' % (
        label, len(sub), st.mean(di), st.mean(adi), adi[int(.9*len(adi))-1 if len(adi)>1 else 0], adi[-1], st.mean(dr), st.mean(abs(v) for v in dr), st.mean(ei), st.mean(er), st.mean(ec)))
    return di
rnd = [x for x in recs if 'random' in x['grp']]
summary(rnd, 'RANDOM sample')
for mon in ('2025-11', '2025-12', '2026-01', '2026-02', '2026-03'):
    summary([x for x in rnd if x['r']['date'].startswith(mon)], ' random ' + mon)
summary([x for x in rnd if not x['r']['neutral']], ' random campus')
summary([x for x in rnd if x['r']['neutral']], ' random neutral')
summary([x for x in recs if 'post' in x['grp']], 'POSTSEASON (type P)')
summary([x for x in recs if 'top' in x['grp']], 'TOP model-vs-model'); summary([x for x in recs if 'ge4' in x['grp']], 'ALL |inc-res|>=4')
summary(recs, 'ALL fetched')
# win prob vs no-vig ML
pv = [(x['r']['p'], nv(x['m']['ml_h'], x['m']['ml_a'])) for x in rnd]
pv = [(a, b) for a, b in pv if b is not None]
print('random: |p_model - p_novig| mean %.3f max %.3f n=%d' % (st.mean(abs(a-b) for a, b in pv), max(abs(a-b) for a, b in pv), len(pv)))
# threshold study on random sample: does |inc-close| predict incumbent being wrong?
print('threshold study (random sample, incumbent vs DK close):')
for thr in (2, 3, 4, 5, 6, 8):
    big = [x for x in rnd if abs(x['r']['mu_c'] - x['m']['close_margin']) >= thr]
    if not big: continue
    side = sum(1 for x in big if (x['r']['y']['margin'] - x['m']['close_margin']) * (x['r']['mu_c'] - x['m']['close_margin']) > 0)
    push = sum(1 for x in big if x['r']['y']['margin'] == x['m']['close_margin'])
    print('  |d|>=%d: n=%d (%.1f%%)  result landed on model side of close %d, close side %d, push %d' % (thr, len(big), 100*len(big)/len(rnd), side, len(big)-side-push, push))
# all fetched games (biased but large) for the same threshold table
print('threshold study (all fetched):')
for thr in (2, 3, 4, 5, 6, 8, 10):
    big = [x for x in recs if abs(x['r']['mu_c'] - x['m']['close_margin']) >= thr]
    side = sum(1 for x in big if (x['r']['y']['margin'] - x['m']['close_margin']) * (x['r']['mu_c'] - x['m']['close_margin']) > 0)
    push = sum(1 for x in big if x['r']['y']['margin'] == x['m']['close_margin'])
    print('  |d|>=%d: n=%d  model side %d, close side %d, push %d' % (thr, len(big), side, len(big)-side-push, push))
# top 10 by |incumbent - close|
top = sorted(recs, key=lambda x: -abs(x['r']['mu_c'] - x['m']['close_margin']))[:12]
print('TOP incumbent vs DK close:')
for x in top:
    r = x['r']
    print('%s %s %s %-26s v %-26s neu=%d type=%s inc %.2f res %.2f close %.1f (%s) open %s actual %d  gh %d ga %d grp %s' % (x['id'], r['date'], r['start'][11:16], r['hn'][:26], r['an'][:26], r['neutral'], r['type'], r['mu_c'], x['q']['margin_mu'] if x['q'] else float('nan'), x['m']['close_margin'], x['m']['details'], x['m']['open_margin'], r['y']['margin'], r['gh'], r['ga'], x['grp']))
# most recent: March tournaments
march = sorted([x for x in recs if x['r']['date'] >= '2026-03-01'], key=lambda x: -abs(x['r']['mu_c'] - x['m']['close_margin']))[:8]
print('TOP in March 2026:')
for x in march:
    r = x['r']
    print('%s %s %-26s v %-26s neu=%d type=%s inc %.2f res %.2f close %.1f (%s) actual %d' % (x['id'], r['date'], r['hn'][:26], r['an'][:26], r['neutral'], r['type'], r['mu_c'], x['q']['margin_mu'], x['m']['close_margin'], x['m']['details'], r['y']['margin']))
json.dump([{'id': x['id'], 'm': x['m'], 'grp': x['grp']} for x in recs], open(SP + 'market_join.json', 'w'))
