"""The line snapshots the harness bets against, one row per game, in line
space (spreads: the home team's expected margin, home -3 is +3; totals: points).

NFL (2020-2026): nflverse/nfldata games.csv as it stood at each commit
(nfl_line_history.py). For game g in week W of a season:

  tau        the EARLY-WEEK checkpoint: the latest kickoff of week W-1 plus
             5 hours, so every result the models read is final. The early
             line is the last non-blank value the feed carried at or before tau.
             Week 1 has no week W-1 and no in-season starter; it is excluded.
  fri        Friday 17:00 ET of the game's week (after the Friday injury
             report, which carries the final game status): a second checkpoint,
             used only by the experiments that read injury reports.
  close      the last non-blank value before kickoff.

A checkpoint counts only if the feed was live: some commit to games.csv
within LIVE_HOURS before it (in early 2020 the job was not yet running every
ten minutes and a June value would otherwise pose as a September line).

CFB (2012-2019, 2021-2025): the cfbfastR archive through
football/cfb_p4/research/build_market.py (oriented per book). The archive's
OPENER carries no timestamp. The bet book is one per era, fixed before any
model was scored: 5Dimes (2012-2019, the only book with openers then) and
Bovada (2021-2025, the only book with openers in every one of those seasons).
CLV is scored against the same book's close (primary) and the across-book
median close (secondary). Opening and closing prices come from the raw
archive rows where the side can be read unambiguously, else they stay missing.

Data-quality rule (fixed before any model was scored, both sports): a
book's open/close pair is dropped when |close - open| > MAX_MOVE (10 spread
points, 12 total points), and a CFB book close is dropped when it is more than
3 points from the across-book median close. Both are archive errors far more
often than real moves (e.g. a 5Dimes opener of 334, sign-flipped openers).
"""
import bisect
import datetime as dt
import os

import numpy as np
import pandas as pd

from ..core.distribution import no_vig_two_way

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "clv")
NFL_CHANGES = os.path.join(CACHE, "nfl_line_changes.csv.gz")
NFL_COMMITS = os.path.join(CACHE, "nfl_commit_times.txt")
NFL_GAMES_NOW = os.path.join(CACHE, "raw", "nfl_games.csv")
CFB_BUILD = os.path.join(ROOT, ".cache", "model_loop", "cfb", "build")
CFB_RAW_ODDS = os.path.join(CACHE, "raw", "cfb_line_odds.csv.gz")

LIVE_HOURS = 6.0
TAU_LAG_HOURS = 5.0
MAX_MOVE = {"spread": 10.0, "total": 12.0}
MAX_BOOK_VS_CONSENSUS = 3.0
CFB_BET_BOOK = {**{s: "5Dimes & sportbet" for s in range(2012, 2020)}, **{s: "Bovada" for s in range(2021, 2027)}}
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "JAC": "JAX"}
ET = "America/New_York"


def _kick_utc(gameday, gametime):
    t = pd.to_datetime(gameday.astype(str) + " " + gametime.fillna("13:00").astype(str), errors="coerce")
    return t.dt.tz_localize(ET, ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")


def _novig(a, b):
    v = no_vig_two_way(a, b)
    return np.nan if v is None else v


# --------------------------------------------------------------------- NFL
def _value_at(times, values, t):
    """Last value with time <= t (times sorted), or (nan, None)."""
    i = bisect.bisect_right(times, t) - 1
    if i < 0:
        return np.nan, None
    return values[i], times[i]


def nfl_lines(changes=NFL_CHANGES, commits=NFL_COMMITS):
    d = pd.read_csv(changes, low_memory=False)
    d["seen_at"] = pd.to_datetime(d.seen_at, utc=True)
    commit_times = sorted(pd.to_datetime(pd.read_csv(commits, header=None)[0], utc=True))
    # the schedule as it stood last (kickoffs, final scores, types)
    last = d.sort_values("seen_at").groupby("game_id").last()
    sched = last[["season", "game_type", "week", "gameday", "gametime", "home_team", "away_team",
                  "home_score", "away_score"]].reset_index()
    sched["kick"] = _kick_utc(sched.gameday, sched.gametime)
    sched = sched[sched.kick.notna()]
    wk_last = sched.groupby(["season", "week"]).kick.max()
    rows = []
    fields = {"spread": ("spread_line", "home_spread_odds", "away_spread_odds"),
              "total": ("total_line", "over_odds", "under_odds")}
    by_game = {g: q.sort_values("seen_at") for g, q in d.groupby("game_id")}
    for r in sched.itertuples():
        q = by_game.get(r.game_id)
        if q is None or r.week <= 1:
            continue
        prev = wk_last.get((r.season, r.week - 1))
        if prev is None or pd.isna(prev):
            continue
        tau = prev + pd.Timedelta(hours=TAU_LAG_HOURS)
        k = r.kick
        fri = (k.tz_convert(ET).normalize() - pd.Timedelta(days=(k.tz_convert(ET).weekday() - 4) % 7)
               + pd.Timedelta(hours=17)).tz_convert("UTC")
        out = {"game_id": r.game_id, "season": int(r.season), "week": int(r.week), "game_type": r.game_type,
               "home": FRANCHISE.get(r.home_team, r.home_team), "away": FRANCHISE.get(r.away_team, r.away_team),
               "kick_utc": k, "tau_utc": tau, "fri_utc": fri if fri < k - pd.Timedelta(hours=1) else pd.NaT,
               "result": (r.home_score - r.away_score) if pd.notna(r.home_score) else np.nan,
               "total_pts": (r.home_score + r.away_score) if pd.notna(r.home_score) else np.nan}
        for name, t in (("early", tau), ("fri", out["fri_utc"]), ("close", k - pd.Timedelta(seconds=1))):
            ok = pd.notna(t) and t < k
            if ok:
                j = bisect.bisect_right(commit_times, t) - 1
                ok = j >= 0 and (t - commit_times[j]).total_seconds() <= LIVE_HOURS * 3600
            out[name + "_live"] = bool(ok)
            for mk, (col, po, pu) in fields.items():
                s = q[q[col].notna()]
                if not ok or not len(s):
                    out[f"{name}_{mk}"] = np.nan
                    out[f"{name}_{mk}_p"] = np.nan
                    out[f"{name}_{mk}_odds_over"] = out[f"{name}_{mk}_odds_under"] = np.nan
                    continue
                tl = list(s.seen_at)
                i = bisect.bisect_right(tl, t) - 1
                if i < 0:
                    out[f"{name}_{mk}"] = np.nan
                    out[f"{name}_{mk}_p"] = np.nan
                    out[f"{name}_{mk}_odds_over"] = out[f"{name}_{mk}_odds_under"] = np.nan
                    continue
                row = s.iloc[i]
                out[f"{name}_{mk}"] = float(row[col])
                out[f"{name}_{mk}_p"] = _novig(row[po], row[pu]) if pd.notna(row[po]) and pd.notna(row[pu]) else np.nan
                out[f"{name}_{mk}_odds_over"] = float(row[po]) if pd.notna(row[po]) else np.nan
                out[f"{name}_{mk}_odds_under"] = float(row[pu]) if pd.notna(row[pu]) else np.nan
                if name == "early":
                    out[f"early_{mk}_posted_at"] = row.seen_at
        rows.append(out)
    L = pd.DataFrame(rows)
    # finals from the current games.csv (a score rarely lands in the same commit
    # as a market change, so the history's last row usually has no score)
    fin = pd.read_csv(NFL_GAMES_NOW, usecols=["game_id", "home_score", "away_score"]).set_index("game_id")
    hs, as_ = L.game_id.map(fin.home_score), L.game_id.map(fin.away_score)
    L["result"] = hs - as_
    L["total_pts"] = hs + as_
    # the data-quality rule
    for mk in ("spread", "total"):
        bad = (L[f"close_{mk}"] - L[f"early_{mk}"]).abs() > MAX_MOVE[mk]
        L[f"{mk}_qa_dropped"] = bad
        L.loc[bad, [f"early_{mk}", f"early_{mk}_p", f"early_{mk}_odds_over", f"early_{mk}_odds_under"]] = np.nan
    return L


# --------------------------------------------------------------------- CFB
def _cfb_prices(raw=CFB_RAW_ODDS):
    """(game_id, book, market) -> home/over no-vig at open and close, where the
    side row can be matched to the oriented line without ambiguity."""
    a = pd.read_csv(raw, low_memory=False, usecols=["game_id", "market_type", "abbr", "lines", "odds",
                                                    "opening_lines", "opening_odds", "book"])
    a = a[a.market_type.isin(["spread", "total"])].dropna(subset=["game_id"])
    a["game_id"] = a.game_id.astype("int64")
    return a


def cfb_lines(build=CFB_BUILD, raw=CFB_RAW_ODDS):
    m = pd.read_csv(os.path.join(build, "market.csv"), low_memory=False)
    b = pd.read_csv(os.path.join(build, "market_books.csv"), low_memory=False)
    b = b[b.close_conflict.isna() & b.open_conflict.isna()]
    g = pd.read_parquet(os.path.join(build, "games.parquet"))
    keep = ["game_id", "season", "week", "slate", "season_type", "home", "away", "home_div", "away_div",
            "home_conf", "away_conf", "neutral", "kick_utc", "result", "total_pts"]
    g = g[[c for c in keep if c in g.columns]].copy()
    prices = _cfb_prices(raw)
    rows = []
    for mk in ("spread", "total"):
        q = b[b.market == mk].copy()
        q["bet_book"] = q.season.map(CFB_BET_BOOK)
        q = q[q.book == q.bet_book]
        cons = m.set_index("game_id")[f"{mk}_close"]
        q["cons_close"] = q.game_id.map(cons)
        q = q.rename(columns={"open": f"early_{mk}", "close": f"close_{mk}", "cons_close": f"cons_close_{mk}"})
        # prices: the raw row whose number is this side's number at open / close
        pr = prices[prices.market_type == mk]
        p_open, p_close = {}, {}
        for (gid, book), grp in pr[pr.book.isin(set(CFB_BET_BOOK.values()))].groupby(["game_id", "book"]):
            p_open[(gid, book)] = grp
        def side_odds(r, which):
            grp = p_open.get((r.game_id, r.book))
            if grp is None:
                return (np.nan, np.nan)
            line = r[f"{which}_{mk}"]
            if not np.isfinite(line):
                return (np.nan, np.nan)
            lc, oc = ("opening_lines", "opening_odds") if which == "early" else ("lines", "odds")
            if mk == "spread":
                if line == 0:
                    return (np.nan, np.nan)
                h = grp[np.isclose(grp[lc], -line)]
                a_ = grp[np.isclose(grp[lc], line)]
            else:
                h = grp[(grp.abbr.str.lower() == "over") & np.isclose(grp[lc], line)]
                a_ = grp[(grp.abbr.str.lower() == "under") & np.isclose(grp[lc], line)]
            if len(h) != 1 or len(a_) != 1 or not np.isfinite(h[oc].iloc[0]) or not np.isfinite(a_[oc].iloc[0]):
                return (np.nan, np.nan)
            return (float(h[oc].iloc[0]), float(a_[oc].iloc[0]))
        for which in ("early", "close"):
            od = [side_odds(r, which) for _, r in q.iterrows()]
            q[f"{which}_{mk}_odds_over"] = [o[0] for o in od]
            q[f"{which}_{mk}_odds_under"] = [o[1] for o in od]
            q[f"{which}_{mk}_p"] = [_novig(o[0], o[1]) if np.isfinite(o[0]) and np.isfinite(o[1]) else np.nan for o in od]
        bad = ((q[f"close_{mk}"] - q[f"early_{mk}"]).abs() > MAX_MOVE[mk]) | \
              ((q[f"close_{mk}"] - q[f"cons_close_{mk}"]).abs() > MAX_BOOK_VS_CONSENSUS)
        q[f"{mk}_qa_dropped"] = bad
        q.loc[bad, [f"early_{mk}", f"early_{mk}_p", f"early_{mk}_odds_over", f"early_{mk}_odds_under"]] = np.nan
        rows.append(q[["game_id", "book", f"early_{mk}", f"close_{mk}", f"cons_close_{mk}", f"early_{mk}_p",
                       f"close_{mk}_p", f"early_{mk}_odds_over", f"early_{mk}_odds_under", f"{mk}_qa_dropped"]].rename(columns={"book": f"{mk}_book"}))
    L = g.merge(rows[0], on="game_id", how="left").merge(rows[1], on="game_id", how="left")
    return L


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("which", choices=["nfl", "cfb", "both"])
    a = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    if a.which in ("nfl", "both"):
        L = nfl_lines()
        L.to_parquet(os.path.join(CACHE, "nfl_lines.parquet"))
        print("nfl", len(L))
    if a.which in ("cfb", "both"):
        L = cfb_lines()
        L.to_parquet(os.path.join(CACHE, "cfb_lines.parquet"))
        print("cfb", len(L))


if __name__ == "__main__":
    main()
