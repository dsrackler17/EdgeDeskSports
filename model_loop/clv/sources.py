"""Readers for the line archives the CLV studies use.

Every reader returns one row per game in the harness orientation:

  open_line / close_line   spread: the market's expected HOME margin (home -3 = +3)
  open_total / close_total total points / goals / runs
  open_ml_home / ...       American odds

Nothing is imputed: a missing opener stays missing, and the hygiene rules
below only DROP numbers that cannot be real. The counts they drop are
returned with the data so the audit can print them.

Sources (see DATA_AUDIT.md for coverage):

  cfb_market  sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz,
              oriented by football/cfb_p4/research/build_market.py (run with
              CFB_P4_DATA pointing at the cache). Opening numbers exist for ONE
              book per era (5Dimes 2012-19, Bovada 2021-22, Bovada/DraftKings/
              ESPN Bet 2023-25); closes for 3-22 books. No timestamps.
  sbr         flancast90/sportsbookreview-scraper data/<sport>_archive_10Y.json:
              the sportsbookreview.com "scores and odds archives", 2011-2021.
              One opening and one closing number per market from SBR's
              reference book (not named), no timestamps. NFL/NBA: spread and
              total open+close, moneyline close only. NHL/MLB: moneyline and
              total open+close.
  espn        ESPN game JSON mirrored by sportsdataverse (hoopR-nba-raw,
              hoopR-mbb-raw, wehoop-wnba-raw): `pickcenter` DraftKings open and
              close for spread, total and moneyline, no timestamps.
"""
import concurrent.futures as cf
import json
import os
import urllib.request

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "clv")
RAW = os.path.join(CACHE, "raw")

SBR_URL = "https://raw.githubusercontent.com/flancast90/sportsbookreview-scraper/main/data/{sport}_archive_10Y.json"
CFB_LINES_URL = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/betting/csv/cfb_line_odds.csv.gz"

# hygiene: a move or a line beyond these is a data error, not a market
MAX_ABS_LINE = {"nfl": 30, "cfb": 70, "nba": 30, "cbb": 45, "wnba": 30}
MAX_SPREAD_MOVE = {"nfl": 14, "cfb": 21, "nba": 15, "cbb": 15, "wnba": 15}
MAX_TOTAL_MOVE = {"nfl": 14, "cfb": 21, "nba": 20, "cbb": 20, "wnba": 20, "nhl": 2.0, "mlb": 3.0}
TOTAL_RANGE = {"nfl": (25, 70), "cfb": (25, 95), "nba": (160, 280), "cbb": (90, 190), "wnba": (120, 200),
               "nhl": (4, 8), "mlb": (5, 16)}
OVERROUND = (0.98, 1.20)   # two-way implied-probability sum a real market sits in


def _download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        f.write(r.read())
    os.replace(tmp, dest)


def _implied(a):
    a = np.asarray(a, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(a < 0, -a / (-a + 100.0), 100.0 / (a + 100.0))


def ml_ok(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    ok = np.isfinite(a) & np.isfinite(b) & (np.abs(a) >= 100) & (np.abs(b) >= 100)
    s = _implied(a) + _implied(b)
    return ok & (s >= OVERROUND[0]) & (s <= OVERROUND[1])


def _hygiene(df, sport, qa):
    """Drop impossible numbers; record how many."""
    d = df
    if "open_line" in d:
        cap = MAX_ABS_LINE.get(sport)
        if cap:
            bad = (d.open_line.abs() > cap) | (d.close_line.abs() > cap)
            qa["spread_abs_line_dropped"] = int(bad.sum())
            d.loc[bad, ["open_line", "close_line"]] = np.nan
        mv = MAX_SPREAD_MOVE.get(sport)
        if mv:
            bad = (d.close_line - d.open_line).abs() > mv
            qa["spread_move_dropped"] = int(bad.sum())
            d.loc[bad, ["open_line", "close_line"]] = np.nan
    if "open_total" in d:
        lo, hi = TOTAL_RANGE[sport]
        for c in ("open_total", "close_total"):
            bad = (d[c] < lo) | (d[c] > hi)
            qa[f"{c}_range_dropped"] = int(bad.sum())
            d.loc[bad, c] = np.nan
        bad = (d.close_total - d.open_total).abs() > MAX_TOTAL_MOVE[sport]
        qa["total_move_dropped"] = int(bad.sum())
        d.loc[bad, ["open_total", "close_total"]] = np.nan
    for when in ("open", "close"):
        h, a = f"{when}_ml_home", f"{when}_ml_away"
        if h in d:
            bad = d[h].notna() & ~ml_ok(d[h], d[a])
            qa[f"{when}_ml_dropped"] = int(bad.sum())
            d.loc[bad, [h, a]] = np.nan
    for when in ("open", "close"):
        o, u = f"{when}_over_odds", f"{when}_under_odds"
        if o in d and u in d:
            bad = d[o].notna() & ~ml_ok(d[o], d[u])
            d.loc[bad, [o, u]] = np.nan
    return d


# ---------------------------------------------------------------- CFB
def cfb_market(market_dir=os.path.join(CACHE, "cfb_market")):
    """Per game: the opener books' median open and median close (same books:
    the same-book move), plus the all-book consensus close and Pinnacle's.

    Run first (once):
      CFB_P4_DATA=.cache/clv/cfbdata python3 football/cfb_p4/research/build_market.py .cache/clv/cfb_market
    """
    m = pd.read_csv(os.path.join(market_dir, "market.csv"))
    b = pd.read_csv(os.path.join(market_dir, "market_books.csv"), low_memory=False)
    b = b[b.close_conflict.isna() & b.open_conflict.isna()]
    out = m[["game_id", "season", "week", "home_team", "away_team", "home_fbs", "away_fbs", "neutral", "played",
             "margin", "total_pts", "spread_close", "total_close", "spread_close_pin", "total_close_pin",
             "spread_books", "side_resolution"]].copy()
    out = out.rename(columns={"spread_close": "close_line_cons", "total_close": "close_total_cons",
                              "spread_close_pin": "close_line_pin", "total_close_pin": "close_total_pin"})
    qa = {"games": int(len(out))}
    for mk, (oc, cc) in {"spread": ("open_line", "close_line"), "total": ("open_total", "close_total"),
                         "ml_home": ("open_ml_home", "close_ml_home"), "ml_away": ("open_ml_away", "close_ml_away")}.items():
        x = b[(b.market == mk) & b.open.notna() & b.close.notna()]
        g = x.groupby("game_id").agg(o=("open", "median"), c=("close", "median"), n=("book", "nunique"),
                                     books=("book", lambda s: "|".join(sorted(set(s)))))
        out = out.merge(g.rename(columns={"o": oc, "c": cc, "n": f"{mk}_open_books", "books": f"{mk}_opener_books"}),
                        left_on="game_id", right_index=True, how="left")
    out = _hygiene(out, "cfb", qa)
    out["result"] = out.margin
    return out, qa


# ---------------------------------------------------------------- SBR
SBR_START_YEAR_LABEL = {"nfl": False, "mlb": False, "nba": True, "nhl": True}


def sbr(sport, raw_dir=RAW):
    """The SBR archive for nfl / nba / nhl / mlb, one row per game."""
    p = os.path.join(raw_dir, f"sbr_{sport}_archive_10Y.json")
    if not os.path.exists(p):
        _download(SBR_URL.format(sport=sport), p)
    d = pd.read_json(p)
    qa = {"rows": int(len(d))}
    d["date"] = pd.to_datetime(d.date.astype("Int64").astype(str), format="%Y%m%d", errors="coerce")
    d["sbr_season"] = d.season
    out = pd.DataFrame({"sbr_season": d.season, "date": d.date, "home_team": d.home_team, "away_team": d.away_team,
                        "home_score": pd.to_numeric(d.home_final, errors="coerce"),
                        "away_score": pd.to_numeric(d.away_final, errors="coerce")})
    out["margin"] = out.home_score - out.away_score
    out["total_pts"] = out.home_score + out.away_score
    num = lambda c: pd.to_numeric(d[c], errors="coerce") if c in d else np.nan
    if sport in ("nfl", "nba"):
        out["open_line"] = -num("home_open_spread")
        cs, ct = num("home_close_spread"), num("close_over_under")
        # Scraper defect: in 7-9% of rows the CLOSING spread and total trade
        # places (home_close_spread = +/-216, close_over_under = 4.0). The
        # misplaced field keeps the spread's SIGN (checked against the close
        # moneyline's favourite on every such row), so the repair is exact:
        # spread = sign(field) * close_over_under, total = |field|. These rows
        # are mostly games whose favourite flipped near pick'em, so dropping
        # them would bias the move toward small ones.
        sw = (cs.abs() > 30) & (ct < 30)
        qa["close_spread_total_swapped_repaired"] = int(sw.sum())
        out["close_line"] = -np.where(sw, np.sign(cs) * ct, cs)
        out["close_total_raw"] = np.where(sw, cs.abs(), ct)
        out["close_ml_home"], out["close_ml_away"] = num("home_close_ml"), num("away_close_ml")
    else:
        out["open_ml_home"], out["open_ml_away"] = num("home_open_ml"), num("away_open_ml")
        out["close_ml_home"], out["close_ml_away"] = num("home_close_ml"), num("away_close_ml")
        # the archive keeps ONE price per total (no under price), so totals are
        # graded on the line alone; the juice is not reconstructed
        out["open_total_one_price"] = num("open_over_under_odds")
        out["close_total_one_price"] = num("close_over_under_odds")
    out["open_total"] = num("open_over_under")
    out["close_total"] = out.pop("close_total_raw") if "close_total_raw" in out else num("close_over_under")
    # zero is the scraper's placeholder for a missing number
    for c in [c for c in out.columns if c.startswith(("open_", "close_"))]:
        if c in ("open_line", "close_line"):
            continue
        z = out[c] == 0
        qa[f"{c}_zero_placeholder"] = int(z.sum())
        out.loc[z, c] = np.nan
    if sport in ("nfl", "nba"):
        # a spread of exactly 0 at BOTH open and close with no moneyline is a placeholder; pick'em is real otherwise
        z = (out.open_line == 0) & (out.close_line == 0) & out.close_ml_home.isna()
        qa["spread_zero_placeholder"] = int(z.sum())
        out.loc[z, ["open_line", "close_line"]] = np.nan
    out = _hygiene(out, sport, qa)
    out["result"] = out.margin
    return out, qa


# ---------------------------------------------------------------- ESPN
ESPN_REPOS = {
    "nba": "https://raw.githubusercontent.com/sportsdataverse/hoopR-nba-raw/main/nba/json/final/{gid}.json",
    "ncaam": "https://raw.githubusercontent.com/sportsdataverse/hoopR-mbb-raw/main/mbb/json/final/{gid}.json",
    "wnba": "https://raw.githubusercontent.com/sportsdataverse/wehoop-wnba-raw/main/wnba/json/final/{gid}.json",
}


def _num(x):
    try:
        return float(str(x).replace("+", "").replace("o", "").replace("u", ""))
    except (TypeError, ValueError):
        return np.nan


def _extract_pickcenter(gid, j):
    rec = {"game_id": int(gid), "providers": []}
    comp = ((j.get("header") or {}).get("competitions") or [{}])[0]
    rec["start"] = comp.get("date")
    for c in comp.get("competitors") or []:
        rec[f"{c.get('homeAway')}_id"] = str((c.get("team") or {}).get("id"))
        rec[f"{c.get('homeAway')}_score"] = _num(c.get("score"))
    for p in j.get("pickcenter") or []:
        ps, tt, ml = p.get("pointSpread") or {}, p.get("total") or {}, p.get("moneyline") or {}
        g = lambda d, side, when, k: _num((((d.get(side) or {}).get(when)) or {}).get(k))
        rec["providers"].append({
            "provider": (p.get("provider") or {}).get("name"),
            "open_home_spread": g(ps, "home", "open", "line"), "close_home_spread": g(ps, "home", "close", "line"),
            "open_home_spread_odds": g(ps, "home", "open", "odds"), "open_away_spread_odds": g(ps, "away", "open", "odds"),
            "close_home_spread_odds": g(ps, "home", "close", "odds"), "close_away_spread_odds": g(ps, "away", "close", "odds"),
            "open_total": g(tt, "over", "open", "line"), "close_total": g(tt, "over", "close", "line"),
            "open_over_odds": g(tt, "over", "open", "odds"), "open_under_odds": g(tt, "under", "open", "odds"),
            "close_over_odds": g(tt, "over", "close", "odds"), "close_under_odds": g(tt, "under", "close", "odds"),
            "open_ml_home": g(ml, "home", "open", "odds"), "open_ml_away": g(ml, "away", "open", "odds"),
            "close_ml_home": g(ml, "home", "close", "odds"), "close_ml_away": g(ml, "away", "close", "odds"),
            "spread_field": _num(p.get("spread")), "ou_field": _num(p.get("overUnder")),
        })
    return rec


def espn_fetch(league, game_ids, workers=16):
    """Fetch (once) and extract the pickcenter of each game; the extracted
    record, not the 1 MB game file, is cached as one JSON line per game."""
    path = os.path.join(CACHE, "espn", f"{league}_pickcenter.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    have = set()
    if os.path.exists(path):
        with open(path) as f:
            have = {json.loads(l)["game_id"] for l in f if l.strip()}
    todo = [int(g) for g in game_ids if int(g) not in have]

    def one(gid):
        try:
            with urllib.request.urlopen(ESPN_REPOS[league].format(gid=gid), timeout=120) as r:
                return _extract_pickcenter(gid, json.loads(r.read()))
        except Exception as e:  # missing file: recorded, never guessed
            return {"game_id": gid, "error": str(e)[:80], "providers": []}

    with open(path, "a") as f, cf.ThreadPoolExecutor(workers) as ex:
        for rec in ex.map(one, todo):
            f.write(json.dumps(rec) + "\n")
    return path


def espn_lines(league, sport_key, book="DraftKings"):
    """The cached pickcenter records -> one row per game with `book`'s open
    and close (harness orientation)."""
    path = os.path.join(CACHE, "espn", f"{league}_pickcenter.jsonl")
    rows = []
    with open(path) as f:
        for l in f:
            r = json.loads(l)
            base = {"game_id": r["game_id"], "fetch_error": r.get("error"), "start": r.get("start"),
                    "n_providers": len(r["providers"])}
            pr = next((p for p in r["providers"] if p.get("provider") == book), None)
            if pr:
                base.update({k: v for k, v in pr.items() if k != "provider"})
            rows.append(base)
    d = pd.DataFrame(rows).drop_duplicates("game_id", keep="last")
    for c in ("open_home_spread", "close_home_spread"):
        if c not in d:
            d[c] = np.nan
    d["open_line"] = -d.open_home_spread
    d["close_line"] = -d.close_home_spread
    d["open_price_a"], d["open_price_b"] = d.get("open_home_spread_odds"), d.get("open_away_spread_odds")
    d["close_price_a"], d["close_price_b"] = d.get("close_home_spread_odds"), d.get("close_away_spread_odds")
    qa = {"games": int(len(d)), "fetch_errors": int(d.fetch_error.notna().sum()),
          "with_book": int(d.open_line.notna().sum() if "open_line" in d else 0)}
    d = _hygiene(d, sport_key, qa)
    return d, qa
