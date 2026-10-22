import pandas as pd, re, sys
G='/home/claude/cfbin/cfb_refs/'
g=pd.read_csv(G+'data/games.csv')
g['d']=(pd.to_datetime(g.start_date)-pd.Timedelta(hours=6)).dt.date
STOP={'university','of','the','state','st','bears','at','vs'}
def toks(s):
    s=re.sub(r'\(.*?\)|\*.*','',str(s)).lower().replace('@',' ').replace('st.','state')
    return set(re.findall(r'[a-z]+',s))
out=[]
for y,f in [(2024,'sched2024.csv.gz'),(2025,'sched2025.csv.gz'),(2026,'sched26.csv.gz')]:
    o=pd.read_csv(G+f'raw/ncaa_mfb_officials_{y}.csv.gz'); u=o[o.espn_game_id.isna()]
    s=pd.read_csv(f).drop_duplicates('contest_id')
    s['d']=pd.to_datetime(s.date.str[:10],format='%m/%d/%Y',errors='coerce').dt.date
    cand=g[(g.season==y)&g.official_id.isna()]
    for _,r in u.merge(s[['contest_id','d','team_name','opponent']],on='contest_id',how='left').iterrows():
        if pd.isna(r.d): out.append((y,r.contest_id,r.official,None,'no_schedule_row',0)); continue
        ts=toks(r.team_name)|toks(r.opponent)
        c=cand[cand.d.isin([r.d,r.d+pd.Timedelta(days=1),r.d-pd.Timedelta(days=1)])]
        best=None;bs=0
        for _,cg in c.iterrows():
            sc=len(ts&(toks(cg.home_team)|toks(cg.away_team))-STOP)
            if sc>bs: bs, best=sc, cg
        out.append((y,r.contest_id,r.official,None if best is None else best.game_id,
                    f'{r.team_name} vs {r.opponent} -> '+('' if best is None else f'{best.away_team} @ {best.home_team}'),bs))
df=pd.DataFrame(out,columns=['season','contest_id','official','game_id','match','score'])
df.to_csv('/home/claude/refs/unmatched_candidates.csv',index=False)
print(df.score.value_counts().sort_index()); print(df[df.score>=1].to_string())
