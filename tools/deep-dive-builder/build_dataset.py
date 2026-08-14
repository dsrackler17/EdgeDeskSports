
import os, io, zipfile, time
from pathlib import Path
from datetime import datetime, timezone
import pandas as pd
import requests

OUT = Path(os.environ.get("EDGEDESK_DATA_OUT", "edgedesk_data"))
OUT.mkdir(parents=True, exist_ok=True)

ATP_BASE = "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/"
WTA_BASE = "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/"

def get_csv(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return pd.read_csv(io.BytesIO(r.content), low_memory=False)

def stamp(df, source):
    df = df.copy()
    df["source"] = source
    df["source_tier"] = "T0"
    df["retrieved_at"] = datetime.now(timezone.utc).isoformat()
    return df

def fetch_tennis():
    # Historical tour-level match data. Expand YEARS if you want pre-1990 data.
    years = range(1991, datetime.now().year + 1)

    for tour, base in [("ATP", ATP_BASE), ("WTA", WTA_BASE)]:
        frames=[]
        for y in years:
            fn=f"{tour.lower()}_matches_{y}.csv"
            try:
                d=get_csv(base+fn)
                frames.append(stamp(d, f"JeffSackmann/{tour}"))
                print(tour, y, len(d))
            except Exception as e:
                print("skip", tour, y, e)

        if frames:
            matches=pd.concat(frames, ignore_index=True)
            matches.to_csv(OUT/f"{tour}_matches.csv", index=False)

        for fn in [f"{tour.lower()}_players.csv", f"{tour.lower()}_rankings.csv"]:
            try:
                d=stamp(get_csv(base+fn), f"JeffSackmann/{tour}")
                d.to_csv(OUT/fn, index=False)
            except Exception as e:
                print("skip", fn, e)

def build_tennis_aggregates(tour):
    p=OUT/f"{tour}_matches.csv"
    if not p.exists(): return
    m=pd.read_csv(p, low_memory=False)

    # Sackmann format uses winner_/loser_ fields.
    wcols=[c for c in m.columns if c.startswith("w_")]
    lcols=[c for c in m.columns if c.startswith("l_")]

    rows=[]
    for _,r in m.iterrows():
        base={k:r.get(k) for k in ["tourney_date","tourney_name","surface","round","score"]}
        base["season"]=pd.to_datetime(r.get("tourney_date"), errors="coerce").year
        base["winner"]=r.get("winner_name")
        base["loser"]=r.get("loser_name")
        base["winner_rank"]=r.get("winner_rank")
        base["loser_rank"]=r.get("loser_rank")
        rows.append(base)

    x=pd.DataFrame(rows)
    x.to_csv(OUT/f"{tour}_match_normalized.csv", index=False)

    # Player season summary.
    wins=x.groupby(["season","winner"]).size().rename("wins").reset_index()
    losses=x.groupby(["season","loser"]).size().rename("losses").reset_index()
    wins=wins.rename(columns={"winner":"player"})
    losses=losses.rename(columns={"loser":"player"})
    s=wins.merge(losses,on=["season","player"],how="outer").fillna(0)
    s["matches"]=s["wins"]+s["losses"]
    s["win_pct"]=s["wins"]/s["matches"].replace(0,pd.NA)
    s.to_csv(OUT/f"{tour}_player_season_summary.csv", index=False)

    # Surface summary.
    w=x.groupby(["season","surface","winner"]).size().rename("wins").reset_index()
    l=x.groupby(["season","surface","loser"]).size().rename("losses").reset_index()
    w=w.rename(columns={"winner":"player"})
    l=l.rename(columns={"loser":"player"})
    sf=w.merge(l,on=["season","surface","player"],how="outer").fillna(0)
    sf["matches"]=sf["wins"]+sf["losses"]
    sf["win_pct"]=sf["wins"]/sf["matches"].replace(0,pd.NA)
    sf.to_csv(OUT/f"{tour}_player_surface_summary.csv", index=False)

    # H2H.
    h=x.groupby(["winner","loser"]).size().rename("wins").reset_index()
    rev=h.rename(columns={"winner":"loser","loser":"winner","wins":"losses"})
    h2h=h.merge(rev,on=["winner","loser"],how="outer").fillna(0)
    h2h.to_csv(OUT/f"{tour}_h2h.csv", index=False)

def build_excel():
    files=sorted(OUT.glob("*.csv"))
    if not files: return
    with pd.ExcelWriter(OUT/"EdgeDesk_UFC_WTA_ATP_DeepDive.xlsx", engine="openpyxl") as w:
        for f in files:
            df=pd.read_csv(f, low_memory=False)
            name=f.stem[:31]
            df.to_excel(w,index=False,sheet_name=name)

if __name__=="__main__":
    fetch_tennis()
    build_tennis_aggregates("ATP")
    build_tennis_aggregates("WTA")
    # UFC ingestion is kept separate because UFCStats has no official bulk API.
    build_excel()
    print("DONE:", OUT.resolve())
