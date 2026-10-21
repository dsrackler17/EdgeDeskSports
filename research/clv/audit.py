"""Phase 1: line coverage per sport, season and market, from the same readers
the studies use. Writes research/clv/results/data_audit.json.

  python3 -m research.clv.audit
"""
import json
import os

import numpy as np
import pandas as pd

from model_loop.clv import sources as S

OUT = os.path.join(S.ROOT, "research", "clv", "results")


def _cov(g, pairs):
    row = {"games": int(len(g))}
    for name, (o, c) in pairs.items():
        if o not in g or c not in g:
            continue
        ok = g[o].notna() & g[c].notna()
        row[f"{name}_open_close"] = int(ok.sum())
        if ok.any():
            mv = (g.loc[ok, c] - g.loc[ok, o])
            row[f"{name}_mean_abs_move"] = round(float(mv.abs().mean()), 3)
            row[f"{name}_share_moved"] = round(float((mv != 0).mean()), 3)
    return row


def _ml_move(g, prefix_open="open_ml", prefix_close="close_ml"):
    h, a = g[f"{prefix_open}_home"], g[f"{prefix_open}_away"]
    ch, ca = g[f"{prefix_close}_home"], g[f"{prefix_close}_away"]
    ok = h.notna() & a.notna() & ch.notna() & ca.notna()
    if not ok.any():
        return {"ml_open_close": 0}
    po = S._implied(h[ok]) / (S._implied(h[ok]) + S._implied(a[ok]))
    pc = S._implied(ch[ok]) / (S._implied(ch[ok]) + S._implied(ca[ok]))
    return {"ml_open_close": int(ok.sum()), "ml_mean_abs_move_prob": round(float(np.abs(pc - po).mean()), 4)}


def cfb():
    d, qa = S.cfb_market()
    d = d[d.played.astype(bool)]
    rows = []
    for s, g in d.groupby("season"):
        r = {"season": int(s)}
        r.update(_cov(g, {"spread": ("open_line", "close_line"), "total": ("open_total", "close_total")}))
        r["spread_open_vs_consensus_close"] = int((g.open_line.notna() & g.close_line_cons.notna()).sum())
        r["pinnacle_close"] = int(g.close_line_pin.notna().sum())
        r.update(_ml_move(g))
        books = g.spread_opener_books.dropna()
        r["opener_books"] = sorted({b for x in books for b in x.split("|")})
        r["fbs_vs_fbs"] = int((g.home_fbs.astype(bool) & g.away_fbs.astype(bool)).sum())
        rows.append(r)
    return {"qa": qa, "seasons": rows}


def sbr(sport):
    d, qa = S.sbr(sport)
    rows = []
    for s, g in d.groupby("sbr_season"):
        r = {"sbr_season": int(s)}
        pairs = {"total": ("open_total", "close_total")}
        if sport in ("nfl", "nba"):
            pairs["spread"] = ("open_line", "close_line")
        r.update(_cov(g, pairs))
        if sport in ("nhl", "mlb"):
            r.update(_ml_move(g))
        else:
            r["ml_close_only"] = int((g.close_ml_home.notna() & g.close_ml_away.notna()).sum())
        rows.append(r)
    return {"qa": qa, "seasons": rows}


def espn(league, sport_key, games_csv):
    d, qa = S.espn_lines(league, sport_key)
    ids = []
    for s, path in games_csv.items():
        g = pd.read_csv(os.path.join(S.ROOT, path))
        g = g[g.status.astype(str).str.upper().eq("FINAL")] if "status" in g else g
        ids.append(pd.DataFrame({"game_id": g.game_id.astype(int), "season": s}))
    sched = pd.concat(ids)
    d = sched.merge(d, on="game_id", how="left")
    rows = []
    for s, g in d.groupby("season"):
        r = {"season": int(s), "games_final": int(len(g)), "fetched": int(g.n_providers.notna().sum()),
             "with_any_provider": int((g.n_providers > 0).sum())}
        r.update(_cov(g, {"spread": ("open_line", "close_line"), "total": ("open_total", "close_total")}))
        r.update(_ml_move(g))
        rows.append(r)
    return {"qa": qa, "book": "DraftKings", "seasons": rows}


def nfl_2026():
    d = json.load(open(os.path.join(S.ROOT, "football", "pricing", "openers_nfl.json")))["games"]
    rows = []
    for gid, g in d.items():
        o, c = g.get("open") or {}, g.get("close") or {}
        rows.append({"gid": gid, "closed": bool(g.get("closed")), "open_line": o.get("home_line"),
                     "close_line": c.get("home_line"), "open_seen": o.get("seen_at"), "date": g.get("date")})
    x = pd.DataFrame(rows)
    ok = x.closed & x.open_line.notna() & x.close_line.notna()
    first = pd.to_datetime(x.open_seen, errors="coerce", utc=True)
    kick = pd.to_datetime(x.date, errors="coerce", utc=True)
    lead = (kick - first).dt.total_seconds() / 86400
    return {"games": int(len(x)), "closed_with_open": int(ok.sum()),
            "mean_abs_move": round(float((x.close_line - x.open_line)[ok].abs().mean()), 3),
            "open_seen_days_before_game_date_median": round(float(lead.median()), 2),
            "source": "football/pricing/openers_nfl.json (nflverse consensus first seen; seen_at timestamps)"}


def cfb_2026():
    rows = [json.loads(l) for l in open(os.path.join(S.ROOT, "football", "cfb_lab", "ledger", "2026", "lines.jsonl"))]
    x = pd.DataFrame(rows)
    sp = x[x.market_type == "spread"]
    piv = sp.pivot_table(index="game_id", columns="kind", values="home_line", aggfunc="first")
    q = sp.pivot_table(index="game_id", columns="kind", values="quality", aggfunc="first")
    ok = piv.get("OPEN").notna() & piv.get("CLOSE").notna()
    return {"games": int(sp.game_id.nunique()), "open_and_close": int(ok.sum()),
            "open_quality": q.get("OPEN").value_counts().to_dict(), "close_quality": q.get("CLOSE").value_counts().to_dict(),
            "mean_abs_move": round(float((piv.CLOSE - piv.OPEN)[ok].abs().mean()), 3),
            "source": "football/cfb_lab/ledger/2026/lines.jsonl"}


def main():
    os.makedirs(OUT, exist_ok=True)
    rep = {"cfb": cfb(), "cfb_2026_ledger": cfb_2026(), "nfl_2026_openers": nfl_2026()}
    for sp in ("nfl", "nba", "nhl", "mlb"):
        rep[f"sbr_{sp}"] = sbr(sp)
    rep["espn_nba"] = espn("nba", "nba", {2026: "nba/data/games/2026.csv", 2027: "nba/data/games/2027.csv"})
    rep["espn_wnba"] = espn("wnba", "wnba", {2025: "basketball/data/wnba/2025.csv", 2026: "basketball/data/wnba/2026.csv"})
    if os.path.exists(os.path.join(S.CACHE, "espn", "ncaam_pickcenter.jsonl")):
        rep["espn_ncaam"] = espn("ncaam", "cbb", {2026: "basketball/data/ncaam/2026.csv"})
    with open(os.path.join(OUT, "data_audit.json"), "w") as f:
        json.dump(rep, f, indent=1, default=str)
    print(json.dumps({k: (v.get("qa") if isinstance(v, dict) and "qa" in v else v) for k, v in rep.items()}, indent=1, default=str)[:4000])


if __name__ == "__main__":
    main()
