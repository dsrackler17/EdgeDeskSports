import json, math, sys
from statistics import NormalDist
W='/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad/wnba_work'
d=json.load(open(W+'/pit_2026.json'))
teams=json.load(open('/home/user/EdgeDeskSports/basketball/data/wnba/teams.json'))
cal=d['cal2026']; sd=cal['sd_margin']
N=NormalDist()
rows=d['rows']
out=[]
for r in rows:
    pe=min(max(r['p_elo'],1e-6),1-1e-6)
    m_elo=sd*N.inv_cdf(pe)
    p_norm=1-NormalDist(r['margin_mu'],sd).cdf(0)
    out.append(dict(r, m_elo=m_elo, gap=r['margin_mu']-m_elo, p_norm=p_norm))
rec=[o for o in out if o['date']>='2026-09-01']
print('n recent',len(rec))
rec.sort(key=lambda o:-abs(o['gap']))
for o in rec[:10]:
    print(o['id'],o['date'],o['type'],teams[o['home']][:14],'v',teams[o['away']][:14],'model %.2f elo %.2f gap %.2f actual %d  p %.3f pelo %.3f'%(o['margin_mu'],o['m_elo'],o['gap'],o['y']['margin'],o['p_points'],o['p_elo']))
# season-wide stats
import statistics as st
g=[abs(o['gap']) for o in out]
print('2026 all |model-elo| mean %.2f median %.2f p90 %.2f max %.2f'%(st.mean(g),st.median(g),sorted(g)[int(.9*len(g))],max(g)))
# logistic vs normal discrepancy
dd=[abs(o['p_points']-o['p_norm']) for o in out]
print('max |p_logistic - p_normal| %.4f mean %.4f'%(max(dd),st.mean(dd)))
mx=max(out,key=lambda o:abs(o['p_points']-o['p_norm'])); print(mx['id'],mx['p_points'],mx['p_norm'],mx['margin_mu'])
# MAE margin and total, vs actual, 2026
print('2026 margin MAE %.2f, total MAE %.2f, total bias %.2f'%(st.mean(abs(o['margin_mu']-o['y']['margin']) for o in out), st.mean(abs(o['total_mu']-o['y']['total']) for o in out), st.mean(o['total_mu']-o['y']['total'] for o in out)))
print('elo margin MAE %.2f'%st.mean(abs(o['m_elo']-o['y']['margin']) for o in out))
# by month total bias
from collections import defaultdict
bm=defaultdict(list)
for o in out: bm[o['date'][:7]].append(o)
for k in sorted(bm):
    v=bm[k]; print(k,len(v),'total bias %.2f'%st.mean(o['total_mu']-o['y']['total'] for o in v),'raw t bias %.2f'%st.mean(o['t_raw']-o['y']['total'] for o in v),'margin bias %.2f'%st.mean(o['margin_mu']-o['y']['margin'] for o in v), 'mean total %.1f'%st.mean(o['y']['total'] for o in v))
json.dump(out,open(W+'/an_2026.json','w'))
