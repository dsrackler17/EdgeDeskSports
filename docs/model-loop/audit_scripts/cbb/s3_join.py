import json, math, statistics as st, sys
SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad/out/'
inc = json.load(open(SP + 'incumbent_rows.json'))
rows = [r for r in inc['rows'] if r['season'] == 2026]
res = {r['id']: r for r in json.load(open(SP + 'research_rows.json'))}
j = []
for r in rows:
    q = res.get(r['id'])
    if not q: continue
    j.append((r, q))
print('joined D1-v-D1 2026:', len(j))
d = [r['mu_c'] - q['margin_mu'] for r, q in j]
ad = sorted(abs(x) for x in d)
def pct(a, p): return a[min(len(a)-1, int(p*len(a)))]
print('incumbent - research margin: mean %.2f sd %.2f  |d| median %.2f p90 %.2f p99 %.2f max %.2f' % (st.mean(d), st.pstdev(d), pct(ad,.5), pct(ad,.9), pct(ad,.99), ad[-1]))
for thr in (2,3,4,5,6,8):
    print('  share |d|>=%d: %.3f' % (thr, sum(1 for x in ad if x >= thr)/len(ad)))
# errors vs result
inc_mae = st.mean(abs(r['y']['margin'] - r['mu_c']) for r, q in j)
res_mae = st.mean(abs(q['y']['margin'] - q['margin_mu']) for r, q in j)
print('MAE vs result on same games: incumbent %.3f research %.3f' % (inc_mae, res_mae))
# by month
from collections import defaultdict
bm = defaultdict(list)
for (r, q), x in zip(j, d): bm[r['date'][:7]].append(abs(x))
for k in sorted(bm): print('  ', k, len(bm[k]), 'mean |d| %.2f' % st.mean(bm[k]))
# who was right when they disagreed by >=5
big = [(r, q, x) for (r, q), x in zip(j, d) if abs(x) >= 5]
wins = sum(1 for r, q, x in big if abs(r['y']['margin'] - q['margin_mu']) < abs(r['y']['margin'] - r['mu_c']))
print('games |d|>=5:', len(big), 'research closer to result in', wins)
# ATS-like: when |d|>=5, which side of the midpoint did result fall
side = sum(1 for r, q, x in big if (r['y']['margin'] - (r['mu_c'] + q['margin_mu'])/2) * (q['margin_mu'] - r['mu_c']) > 0)
print('  result fell on research side of midpoint:', side, '/', len(big))
top = sorted(zip(j, d), key=lambda t: -abs(t[1]))[:25]
for (r, q), x in top:
    print('%s %s %-28s vs %-28s neu=%d inc %.1f res %.1f d %.1f  act %d  gh %d ga %d  Hsh %.2f Ash %.2f cont %s/%s' % (r['id'], r['date'], r['hn'][:28], r['an'][:28], r['neutral'], r['mu_c'], q['margin_mu'], x, r['y']['margin'], r['gh'], r['ga'], r['Hshare'], r['Ashare'],
        None if q['cont_h'] is None else round(q['cont_h'],2), None if q['cont_a'] is None else round(q['cont_a'],2)))
json.dump([{'inc': r, 'res': q, 'd': x} for (r, q), x in top], open(SP + 'top_disagree.json', 'w'))
# march tournament games
mm = [(r, q, x) for (r, q), x in zip(j, d) if r['date'] >= '2026-03-17']
print('NCAA-tournament window games:', len(mm))
