"""CLV live tracking for every candidate that passed its holdout gate
(EXPERIMENTS.md, Phase 6). Nothing here prices, publishes or serves anything.

  python3 -m research.clv.live            capture what is new, then grade
  python3 -m research.clv.live grade      grade only

Each run:
  1. capture (append-only, first sighting only): the opener-time model inputs
     each candidate needs, from the numbers EdgeDesk already publishes, and a
     quote log of the DraftKings line ESPN shows (today/slate.json) for the
     sports whose line history is not already kept elsewhere;
  2. grade: every candidate's bets against the earliest available line,
     settled against the last pregame line, with the same harness and the
     same frozen rule as its holdout run.

Sources per sport (all committed files; the run needs no cache):
  cfb   models: the CFB Lab's OPEN checkpoint (football/cfb_lab/ledger/2026/predictions,
        prediction_ts at the open); lines: the Lab's OPEN (observed) and CLOSE
  nfl   models: football/nfl/slate.json (production) and football/nfl/model_loop/current.json
        (loop), first sighting; lines: record/football/quotes/nfl_2026.jsonl (DraftKings, timestamped):
        the line showing at the first sighting, and the last pregame quote
  nhl   models: hockey/slate.json challengers (production and projected goalie), first sighting;
        lines: the quote log (first DraftKings sighting / last before the start)
  nba, ncaam  models: nba/slate.json and basketball/slate.json, first sighting; lines: the quote log

The opener rule for captured model numbers: a model number counts only if it
was captured no later than LAG_H hours after the line it is bet against was
first seen (a number captured after later news would not be an opener-time
number). Rows that miss it are reported as late, never graded.
"""
import datetime as dt
import json
import os
import sys

import numpy as np
import pandas as pd

from model_loop.clv import harness as H
from model_loop.core.distribution import KeyNumberMargin

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIVE = os.path.join(ROOT, "research", "clv", "live")
REGISTRY = os.path.join(LIVE, "registry.json")
MODELS = os.path.join(LIVE, "models_2026.jsonl")
QUOTES = os.path.join(LIVE, "quotes_2026.jsonl")
SUMMARY = os.path.join(LIVE, "summary.json")
LAG_H = 48
POWER = {"ACC", "Big Ten", "Big 12", "SEC"}


def _read(p, default=None):
    try:
        with open(os.path.join(ROOT, p)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _jsonl(p):
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def _now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts(s):
    return pd.to_datetime(s, utc=True, errors="coerce")


# ---------------------------------------------------------------- capture
def capture_models(now=None):
    """First sighting of each game's opener-time model inputs per sport."""
    now = now or _now()
    have = {(r["sport"], str(r["game_id"])) for r in _jsonl(MODELS)}
    new = []
    s = _read("football/nfl/slate.json") or {}
    loop = {g["game_id"]: g for g in (_read("football/nfl/model_loop/current.json") or {}).get("games") or []}
    for g in s.get("games") or []:
        if g.get("model_status") != "PREDICTED" or ("nfl", g["game_id"]) in have:
            continue
        lp = loop.get(g["game_id"]) or {}
        new.append({"sport": "nfl", "game_id": g["game_id"], "captured_at": now, "start_utc": g.get("kickoff"),
                    "week": g.get("week"), "v21": g.get("model_home_margin_exact", g.get("model_home_margin")),
                    "v21_total": g.get("model_fair_total"), "v21_version": g.get("model_version"),
                    "loop": lp.get("fair_home_margin"), "loop_total": lp.get("fair_total")})
    h = _read("hockey/slate.json") or {}
    for g in h.get("games") or []:
        gid = str(g.get("game_id"))
        if ("nhl", gid) in have:
            continue
        ch = {m["model"]: m.get("p_home") for m in ((g.get("challengers") or {}).get("models") or [])}
        new.append({"sport": "nhl", "game_id": gid, "captured_at": now, "start_utc": g.get("start_utc"),
                    "home": g.get("home"), "away": g.get("away"), "p_core": ch.get("B_incumbent"),
                    "p_gproj": ch.get("C_goalie_projected"), "model": (h.get("model") or {}).get("id")})
    n = _read("nba/slate.json") or {}
    for g in n.get("games") or []:
        gid = str(g.get("game_id"))
        if ("nba", gid) in have:
            continue
        pr = g.get("price") or {}
        new.append({"sport": "nba", "game_id": gid, "captured_at": now, "start_utc": g.get("start_utc"),
                    "prod": (pr.get("expected") or {}).get("margin"), "prod_total": (pr.get("expected") or {}).get("total"),
                    "prod_p": (pr.get("moneyline") or {}).get("home"), "model": n.get("model")})
    b = (_read("basketball/slate.json") or {}).get("leagues") or {}
    for lg in ("nba", "ncaam"):
        for g in (b.get(lg) or {}).get("games") or []:
            gid, sport = str(g.get("game_id")), ("nba_lab" if lg == "nba" else "ncaam")
            if (sport, gid) in have:
                continue
            p = g.get("prices") or {}
            new.append({"sport": sport, "game_id": gid, "captured_at": now, "start_utc": g.get("start_utc"),
                        "lab": (p.get("spread") or {}).get("projected_margin"),
                        "lab_total": (p.get("total") or {}).get("projected_total"),
                        "lab_p": (p.get("moneyline") or {}).get("home")})
    os.makedirs(LIVE, exist_ok=True)
    with open(MODELS, "a") as f:
        for r in new:
            f.write(json.dumps(r) + "\n")
    return len(new)


def capture_quotes(now=None):
    """The DraftKings line ESPN shows for nhl / nba / ncaam, logged when it changes."""
    now = now or _now()
    t = _read("today/slate.json") or {}
    last = {}
    for r in _jsonl(QUOTES):
        last[r["event"]] = r
    starts = {e.get("id"): e.get("start_utc") for e in t.get("events") or []}
    new = []
    for key, q in (t.get("markets") or {}).items():
        sport = key.split(":")[0]
        if sport not in ("nhl", "nba", "ncaam"):
            continue
        rec = {"event": key, "sport": sport, "game_id": key.split(":")[-1], "start_utc": starts.get(key),
               "captured_at": q.get("captured_at") or now, "logged_at": now, "book": q.get("book"),
               "moneyline": q.get("moneyline"), "spread": q.get("spread"), "total": q.get("total")}
        p = last.get(key)
        if p and all(p.get(k) == rec.get(k) for k in ("moneyline", "spread", "total")):
            continue
        if rec["start_utc"] and _ts(rec["captured_at"]) >= _ts(rec["start_utc"]):
            continue
        new.append(rec)
    with open(QUOTES, "a") as f:
        for r in new:
            f.write(json.dumps(r) + "\n")
    return len(new)


# ------------------------------------------------------------------ lines
def lines_from_quotes(sport):
    """First and last pregame DraftKings sighting per game (harness orientation)."""
    q = [r for r in _jsonl(QUOTES) if r["sport"] == sport]
    if not q:
        return pd.DataFrame()
    rows = {}
    for r in sorted(q, key=lambda r: r["captured_at"]):
        rows.setdefault(r["game_id"], []).append(r)
    out = []
    for gid, rs in rows.items():
        o, c = rs[0], rs[-1]
        rec = {"game_id": gid, "open_seen": o["captured_at"], "close_seen": c["captured_at"], "start_utc": o.get("start_utc"),
               "n_quotes": len(rs)}
        for tag, r in (("open", o), ("close", c)):
            ml, sp, tt = r.get("moneyline") or {}, r.get("spread") or {}, r.get("total") or {}
            rec[f"{tag}_ml_home"], rec[f"{tag}_ml_away"] = ml.get("home"), ml.get("away")
            hp = (sp.get("home") or {}).get("point")
            rec[f"{tag}_line"] = -hp if hp is not None else np.nan
            rec[f"{tag}_price_home"], rec[f"{tag}_price_away"] = (sp.get("home") or {}).get("price"), (sp.get("away") or {}).get("price")
            rec[f"{tag}_total"], rec[f"{tag}_over"], rec[f"{tag}_under"] = tt.get("point"), tt.get("over"), tt.get("under")
        # a close must be a later sighting than the open
        rec["has_close"] = len(rs) > 1
        out.append(rec)
    return pd.DataFrame(out)


def first_models(sport):
    m = [r for r in _jsonl(MODELS) if r["sport"] == sport]
    return pd.DataFrame(m).drop_duplicates("game_id") if m else pd.DataFrame()


def cfb_frame():
    """The Lab's OPEN checkpoint: production (V1) and the loop's v2, with the Lab's lines."""
    import glob
    rows = []
    for fn in sorted(glob.glob(os.path.join(ROOT, "football", "cfb_lab", "ledger", "2026", "predictions", "week_*.jsonl"))):
        with open(fn) as f:
            for l in f:
                r = json.loads(l)
                if r.get("checkpoint_type") != "OPEN":
                    continue
                rows.append({"game_id": str(r["game_id"]), "model": r["model_version"], "week": r["week"],
                             "season_type": r["season_type"], "margin": r["pure_home_margin"], "total": r["projected_total"],
                             "prediction_ts": r["prediction_ts"], "home": r["home_team"], "away": r["away_team"]})
    p = pd.DataFrame(rows)
    if p.empty:
        return p
    piv = p.pivot_table(index="game_id", columns="model", values=["margin", "total"], aggfunc="first")
    piv.columns = [f"{a}|{b}" for a, b in piv.columns]
    meta = p.drop_duplicates("game_id").set_index("game_id")[["week", "season_type", "home", "away"]]
    d = meta.join(piv)
    d["p4"] = d.get("margin|edgedesk_cfb_p4_v1.0.0")
    d["p4_total"] = d.get("total|edgedesk_cfb_p4_v1.0.0")
    d["v2"] = d.get("margin|edgedesk_cfb_loop_v2.0.0")
    d["v2_total"] = d.get("total|edgedesk_cfb_loop_v2.0.0")
    ln = pd.DataFrame(_jsonl(os.path.join(ROOT, "football", "cfb_lab", "ledger", "2026", "lines.jsonl")))
    for mk, col, nm in (("spread", "home_line", "line"), ("total", "total_points", "total")):
        y = ln[ln.market_type == mk]
        o = y[(y.kind == "OPEN") & (y.quality == "OBSERVED")].groupby("game_id")[col].first()
        c = y[(y.kind == "CLOSE") & y.quality.isin(["OBSERVED", "PROVIDER_DECLARED"])].groupby("game_id")[col].first()
        d[f"open_{nm}"] = o.reindex(d.index.astype(str))
        d[f"close_{nm}"] = c.reindex(d.index.astype(str))
    d["open_line"], d["close_line"] = -d.open_line, -d.close_line
    conf = cfb_conferences()
    hc, ac = d.home.map(lambda t: conf.get(_norm(t))), d.away.map(lambda t: conf.get(_norm(t)))
    hp = hc.isin(POWER) | d.home.eq("Notre Dame")
    ap = ac.isin(POWER) | d.away.eq("Notre Dame")
    d["nonpower"] = (~hp & ~ap).astype(float)
    d["fcs"] = (hc.isna() | ac.isna()).astype(float)      # a side with no FBS conference on file
    d["early"] = ((d.week <= 4) & d.season_type.eq("regular")).astype(float)
    d["season"] = 2026
    d["cluster"] = "2026-" + d.season_type.astype(str) + "-" + d.week.astype(str)
    return d.reset_index()


def _norm(s):
    return "".join(ch for ch in str(s).lower().replace("&", "and") if ch.isalnum())


def cfb_conferences():
    """Team -> conference, from the committed line archive (2025) overlaid with the current FBS slate."""
    out = {}
    a = _read("football/pricing/lines_cfb.json") or {}
    for g in a.get("games") or []:
        if g.get("season") == 2025:
            for side in ("home", "away"):
                if g.get(f"{side}_division") == "fbs":
                    out[_norm(g[side])] = (g.get("ctx") or {}).get(f"{side}_conference")
    for g in (_read("football/fbs/slate.json") or {}).get("games") or []:
        for side in ("home", "away"):
            if g.get(f"{side}_division") == "fbs":
                out[_norm(g[f"{side}_team"])] = g.get(f"{side}_conference")
    return out


def nfl_frame():
    """NFL: the bet is placed against the DraftKings line showing when the
    model's number was first captured (record/football/quotes/nfl_2026.jsonl,
    timestamped, with prices); if no quote had been seen yet, against the
    first one after it. The close is the last pregame quote. (The first-seen
    consensus opener in football/pricing/openers_nfl.json is often posted
    eleven days before the week's slate prices the game, so it cannot be the
    line a slate number is bet against.)"""
    m = first_models("nfl")
    q = pd.DataFrame(_jsonl(os.path.join(ROOT, "record", "football", "quotes", "nfl_2026.jsonl")))
    if m.empty or q.empty:
        return pd.DataFrame()
    q = q[q.is_pregame.astype(bool)].copy()
    q["t"] = _ts(q.observed_at)
    q = q[(q.t < _ts(q.kickoff_ts)) & (_ts(q.kickoff_ts) <= pd.Timestamp.now(tz="UTC"))].sort_values("t")   # final closes only
    rows = []
    for r in m.itertuples(index=False):
        g = q[q.game_id == r.game_id]
        if g.empty:
            continue
        cap = _ts(r.captured_at)
        rec = {"game_id": r.game_id, "week": r.week, "v21": r.v21, "v21_total": r.v21_total, "loop": r.loop,
               "loop_total": r.loop_total, "captured_at": r.captured_at}
        for mk, cols in (("spread", ("home_line", "price_home", "price_away")), ("total", ("total_points", "price_over", "price_under"))):
            x = g[g.market_type == mk]
            if x.empty:
                continue
            before = x[x.t <= cap]
            o = before.iloc[-1] if len(before) else x.iloc[0]
            c = x.iloc[-1]
            if mk == "spread":
                rec.update({"open_line": -o.home_line, "close_line": -c.home_line, "open_price_a": o.price_home,
                            "open_price_b": o.price_away, "close_price_a": c.price_home, "close_price_b": c.price_away,
                            "open_seen": o.observed_at})
            else:
                rec.update({"open_total": o.total_points, "close_total": c.total_points, "open_total_price_a": o.price_over,
                            "open_total_price_b": o.price_under, "close_total_price_a": c.price_over,
                            "close_total_price_b": c.price_under})
        rows.append(rec)
    d = pd.DataFrame(rows)
    if d.empty:
        return d
    d["late"] = False
    d["season"] = 2026
    d["cluster"] = "2026-" + d.week.astype(str)
    return d


def b2b_flags(sport):
    """One-team back-to-back flags from the schedule EdgeDesk already keeps."""
    games = []
    if sport == "nhl":
        for r in _jsonl(os.path.join(ROOT, "hockey", "ledger", "2027.jsonl")):
            games.append((str(r["game_id"]), r["start_utc"], r["home"], r["away"]))
        for g in (_read("hockey/slate.json") or {}).get("games") or []:
            games.append((str(g["game_id"]), g["start_utc"], g["home"], g["away"]))
    g = pd.DataFrame(games, columns=["game_id", "start_utc", "home", "away"]).drop_duplicates("game_id")
    if g.empty:
        return g
    g["day"] = _ts(g.start_utc).dt.tz_convert("America/New_York").dt.normalize()
    g = g.sort_values("day")
    last, out = {}, []
    for r in g.itertuples(index=False):
        b = [float(last.get(t) is not None and (r.day - last[t]).days == 1) for t in (r.home, r.away)]
        out.append((r.game_id, float(sum(b) == 1)))
        last[r.home] = last[r.away] = r.day
    return pd.DataFrame(out, columns=["game_id", "b2b_one"])


def quote_frame(sport, model_sport):
    ln = lines_from_quotes(sport)
    m = first_models(model_sport)
    if ln.empty or m.empty:
        return pd.DataFrame()
    d = ln.merge(m, on="game_id", how="inner", suffixes=("", "_m"))
    d["late"] = (_ts(d.captured_at) - _ts(d.open_seen)).dt.total_seconds() / 3600 > LAG_H
    d = d[d.has_close & (_ts(d.start_utc) <= pd.Timestamp.now(tz="UTC"))]          # final closes only
    if sport == "nhl":
        b = b2b_flags("nhl")
        if not b.empty:
            d = d.merge(b, on="game_id", how="left")
    d["season"] = 2026
    d["cluster"] = _ts(d.start_utc).dt.tz_convert("America/New_York").dt.strftime("%Y-%m-%d")
    return d


# ------------------------------------------------------------------ grade
def predict_move(c, x):
    """A frozen residual model's predicted move."""
    y = np.full(len(x), float(c["intercept"]))
    for f, w in c["coef"].items():
        y = y + float(w) * x[f].to_numpy(float)
    return y


def dist(spec):
    if spec["type"] == "keynumber":
        return KeyNumberMargin.from_json(spec["json"])
    return H.IntegerNormal(spec["sigma"])


def candidate_frame(c, frames):
    d = frames.get(c["frame"])
    if d is None or d.empty:
        return pd.DataFrame()
    x = d.copy()
    if "late" in x:
        x = x[~x.late.fillna(True)]
    if c["kind"] == "points":
        if c["market"] == "total":
            x["open_line"], x["close_line"] = x.open_total, x.close_total
            for k in ("open_price_a", "open_price_b", "close_price_a", "close_price_b"):
                x[k] = x[k.replace("_price", "_total_price")] if k.replace("_price", "_total_price") in x else np.nan
        x = x[x.open_line.notna() & x.close_line.notna()]
        if c["rule"] == "base":
            x["model_line"] = x[c["input"]]
        else:
            o = x.open_line
            for f, src in c["features"].items():
                x[f] = x[src] - o if src not in ("open_lvl",) else o
            for f, (a, b) in (c.get("interactions") or {}).items():
                x[f] = x[a] * x[b]
            x = x[x[list(c["coef"])].notna().all(axis=1)]
            x["model_line"] = x.open_line + predict_move(c, x)
    else:
        x = x.rename(columns={"open_ml_home": "open_a", "open_ml_away": "open_b", "close_ml_home": "close_a", "close_ml_away": "close_b"})
        x = x[x.open_a.notna() & x.close_a.notna()]
        p_open = H.no_vig(x.open_a, x.open_b)
        if c["rule"] == "base":
            x["model_prob"] = x[c["input"]]
        else:
            for f, src in c["features"].items():
                x[f] = x[src] - p_open
            x = x[x[list(c["coef"])].notna().all(axis=1)]
            x["model_prob"] = H.no_vig(x.open_a, x.open_b) + predict_move(c, x)
        if "filter" in c:
            x = x[x[c["filter"]] == 1]
    return x


def grade():
    reg = _read("research/clv/live/registry.json") or {"candidates": []}
    frames = {"cfb": cfb_frame(), "nfl": nfl_frame(), "nhl": quote_frame("nhl", "nhl"), "nba": quote_frame("nba", "nba"),
              "ncaam": quote_frame("ncaam", "ncaam")}
    nb = first_models("nba_lab")
    if not frames["nba"].empty and not nb.empty:
        frames["nba"] = frames["nba"].merge(nb[["game_id", "lab", "lab_total", "lab_p"]], on="game_id", how="left")
    out = {"generated_at": _now(), "lag_rule_hours": LAG_H, "candidates": []}
    for c in reg["candidates"]:
        x = candidate_frame(c, frames)
        cfg = H.HarnessConfig(kind=c["kind"], market=c["market"], thresholds=(c["threshold"],), primary=c["threshold"],
                              dist=dist(c["dist"]) if c["kind"] == "points" else None, n_boot=2000)
        row = {"id": c["id"], "sport": c["sport"], "market": c["market"], "label": c["label"], "status": c["status"],
               "games_with_lines": int(len(x))}
        if len(x):
            s = H.summarize(H.bet_table(x, cfg, c["threshold"]), cfg)
            row.update({"n_bets": s.get("n_bets", 0), "clv_prob": s.get("clv_prob"), "clv_pts": s.get("clv_pts"),
                        "clv_ev": s.get("clv_ev"), "direction_hit_rate": (s.get("direction_hit_rate") or {}).get("mean")})
        else:
            row["n_bets"] = 0
            row["note"] = c.get("live_note", "no live rows yet")
        out["candidates"].append(row)
    os.makedirs(LIVE, exist_ok=True)
    with open(SUMMARY, "w") as f:
        json.dump(out, f, indent=1, default=float)
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("all", "capture"):
        print("models captured:", capture_models(), "quotes logged:", capture_quotes())
    if cmd in ("all", "grade"):
        r = grade()
        for c in r["candidates"]:
            m = (c.get("clv_prob") or {}).get("mean")
            print(c["id"], c["market"], "bets", c.get("n_bets"), "mean clv_prob", None if m is None else round(100 * m, 2))
