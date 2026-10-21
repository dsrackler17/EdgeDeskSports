"""CFB ingestion: sportsdataverse play-by-play, schedules, roster-talent and
returning-production priors, and the closing-line archive, into the compact
tables the rating fit reads.

Sources (public, keyless; the same feeds football/cfb_v2/research/fetch_v2.sh
and football/cfb_p4/research/fetch_data.sh already read):
  sportsdataverse-data releases
    espn_cfb_pbp/play_by_play_<S>.parquet     EPA, naive win probability (no
                                              spread inside), passer ids; FBS AND
                                              the FCS teams that play them
    cfb_schedules/cfb_schedules_<S>.parquet    schedule, scores, divisions,
                                              neutral site, kickoff
    cfb_team_talent/cfb_team_talent_<S>.parquet        247 composite (2008+)
    cfb_returning_production/..._<S>.parquet           returning production (2004+)
  cfbfastR-data
    betting/csv/cfb_line_odds.csv.gz          multi-book open + close 2006-2025
    schedules/csv/cfb_schedules_<S>.csv       the spine football/cfb_p4/research/
                                              build_market.py orients lines on
  this repository
    record/football/cfb_2026.json             2026 closes (DraftKings via ESPN),
                                              frozen at kickoff by the record job

Closing lines 2006-2025 are the cfb_p4 market table: football/cfb_p4/research/
build_market.py is run unmodified on the downloaded archive (median across
books after its orientation and book-sign rules; Pinnacle kept separately), so
this adapter and the current engine's backtest grade against the same close.

Outputs (in <data>/build/):
  games.parquet       one row per game with at least one FBS team: teams, divisions,
                      conferences, neutral site, result, close / open / moneyline,
                      the quarterback who started for each side
  unit_games.parquet  per (game, offense, unit): plays and EPA, split into competitive
                      plays (naive win probability 10-90%) and the rest
  qb_games.parquet    per (game, offense, passer): dropbacks and EPA (same split)
  priors.parquet      per (season, team): talent composite, returning production

Usage:
  python3 -m model_loop.adapters.cfb.ingest --data .cache/model_loop/cfb [--fetch] [--seasons 2008-2026]
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
REL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
RAW_CFBFASTR = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main"
BUILD_MARKET = os.path.join(ROOT, "football", "cfb_p4", "research", "build_market.py")
RECORD_2026 = os.path.join(ROOT, "record", "football", "cfb_2026.json")
FIRST_LINES = 2006

# the competitive window: plays outside it are down-weighted at fit time. The
# NAIVE win probability is used because the provider's wp_before reads the
# pregame spread; the naive one is game state only.
WP_LO, WP_HI = 0.10, 0.90

PBP_COLS = ["game_id", "season", "week", "seasonType", "pos_team_id", "def_pos_team_id",
            "homeTeamId", "awayTeamId", "period", "rush", "pass", "sack", "penalty_no_play",
            "EPA", "wp_before_naive", "wp_before", "passer_player_id", "passer_player_name",
            "rusher_player_id", "text_dupe", "kneel_down", "type.text", "text",
            "start.pos_score_diff", "scrimmage_play"]

# 2013's feed files sacks as rushes (football/cfb_v2/research/v2/plays.py
# SACKS_UNTAGGED); they are moved back to pass plays from the play text
SACK_TEXT_SEASONS = {2013}

DIV_RANK = {"fbs": 0, "fcs": 1, "ii": 2, "iii": 3}


def _download(url, dest):
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def current_season(now=None):
    """The football season, not the calendar year: January games belong to
    the season that began the previous August."""
    import time
    t = time.gmtime() if now is None else now
    return t.tm_year - 1 if t.tm_mon <= 2 else t.tm_year


def fetch(data_dir, seasons, refresh_current=True):
    """Download whatever is missing. The newest season is always refetched
    (it grows every week); finished seasons are fetched once."""
    raw = os.path.join(data_dir, "raw")
    os.makedirs(os.path.join(raw, "sched"), exist_ok=True)
    os.makedirs(os.path.join(raw, "betting"), exist_ok=True)
    newest = max(seasons)
    jobs = [(f"{RAW_CFBFASTR}/betting/csv/cfb_line_odds.csv.gz", os.path.join(raw, "betting", "cfb_line_odds.csv.gz"), False)]
    for y in seasons:
        cur = refresh_current and y == newest
        jobs.append((f"{REL}/espn_cfb_pbp/play_by_play_{y}.parquet", os.path.join(raw, f"pbp_{y}.parquet"), cur))
        jobs.append((f"{REL}/cfb_schedules/cfb_schedules_{y}.parquet", os.path.join(raw, f"sched_{y}.parquet"), cur))
        jobs.append((f"{REL}/cfb_team_talent/cfb_team_talent_{y}.parquet", os.path.join(raw, f"talent_{y}.parquet"), cur))
        jobs.append((f"{REL}/cfb_returning_production/cfb_returning_production_{y}.parquet", os.path.join(raw, f"retprod_{y}.parquet"), cur))
    # the current season's CFBD consensus lines (FBS vs FBS): the card's reference
    # line for games not yet closed, and a fallback close for the market rating
    jobs.append((f"{REL}/cfb_matchup_line/cfb_matchup_line_{newest}.parquet", os.path.join(raw, f"mline_{newest}.parquet"), refresh_current))
    # the CSV spine build_market.py orients the line archive against, and the
    # schedule the current engine's replay reads (baselines/replay_cfb_p4.js)
    for y in range(FIRST_LINES, newest + 1):
        jobs.append((f"{RAW_CFBFASTR}/schedules/csv/cfb_schedules_{y}.csv", os.path.join(raw, "sched", f"sched_{y}.csv"),
                     refresh_current and y == newest))
    for url, dest, force in jobs:
        if force or not os.path.exists(dest):
            try:
                _download(url, dest)
                print(f"fetched {os.path.basename(dest)}", file=sys.stderr)
            except Exception as e:  # a missing optional file is reported, never invented
                print(f"fetch failed: {url}: {e}", file=sys.stderr)


def build_market(data_dir):
    """The cfb_p4 market table (football/cfb_p4/research/build_market.py, run
    unmodified) -> <data>/build/market.csv. Rebuilt only when missing: the
    archive it reads ends in 2025."""
    out = os.path.join(data_dir, "build")
    dest = os.path.join(out, "market.csv")
    if os.path.exists(dest):
        return dest
    os.makedirs(out, exist_ok=True)
    env = dict(os.environ, CFB_P4_DATA=os.path.abspath(os.path.join(data_dir, "raw")))
    r = subprocess.run([sys.executable, BUILD_MARKET, os.path.abspath(out)], env=env,
                       cwd=os.path.dirname(BUILD_MARKET), capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(dest):
        raise SystemExit("build_market.py failed:\n" + r.stdout[-3000:] + r.stderr[-3000:])
    with open(os.path.join(out, "market_build.log"), "w") as f:
        f.write(r.stdout + r.stderr)
    return dest


# ------------------------------------------------------------------- build
def _div(x):
    x = str(x).lower() if isinstance(x, str) else ""
    return "fbs" if x == "fbs" else "fcs" if x == "fcs" else "lower"


def _load_sched(raw, seasons):
    frames = []
    for y in seasons:
        p = os.path.join(raw, f"sched_{y}.parquet")
        if os.path.exists(p):
            frames.append(pd.read_parquet(p))
    s = pd.concat(frames, ignore_index=True)
    s = s[s.season_type.isin(["regular", "postseason"])].copy()
    s["kick_utc"] = pd.to_datetime(s.start_date, errors="coerce", utc=True).dt.tz_convert(None)
    return s.drop_duplicates("game_id")


def _rest_days(s):
    """Days since each side's previous game (any division, same season)."""
    long = pd.concat([s[["game_id", "season", "kick_utc", "home_id"]].rename(columns={"home_id": "team"}),
                      s[["game_id", "season", "kick_utc", "away_id"]].rename(columns={"away_id": "team"})])
    long = long.sort_values(["team", "kick_utc"])
    long["prev"] = long.groupby(["team", "season"]).kick_utc.shift(1)
    long["rest"] = (long.kick_utc.dt.normalize() - long.prev.dt.normalize()).dt.days
    return dict(zip(zip(long.game_id, long.team), long.rest))


def _record_2026():
    """2026 closes as the record froze them (DraftKings via ESPN, at kickoff)."""
    try:
        rec = json.load(open(RECORD_2026))["games"]
    except Exception:
        return {}
    out = {}
    for gid, g in rec.items():
        c = g.get("close") or {}
        if c.get("home_line") is None:
            continue
        pr = c.get("prices") or {}
        out[int(gid)] = {"close_margin": -float(c["home_line"]), "close_total": c.get("total"),
                         "home_ml": pr.get("home_ml"), "away_ml": pr.get("away_ml"),
                         "close_source": "record/football/cfb_2026.json (" + str(c.get("book") or c.get("source")) + ")"}
    return out


def build_games(raw, seasons, market_csv):
    s = _load_sched(raw, seasons)
    rest = _rest_days(s)
    s["home_div"] = s.home_division.map(_div)
    s["away_div"] = s.away_division.map(_div)
    s = s[(s.home_div == "fbs") | (s.away_div == "fbs")].copy()
    done = s.completed.fillna(False).astype(bool) & s.home_points.notna() & s.away_points.notna()
    g = pd.DataFrame({
        "game_id": s.game_id.astype("int64"), "season": s.season.astype(int), "week": s.week.astype(int),
        "season_type": s.season_type, "kick_utc": s.kick_utc,
        "home": s.home_id.astype("int64"), "away": s.away_id.astype("int64"),
        "home_name": s.home_team.astype(str), "away_name": s.away_team.astype(str),
        "home_div": s.home_div, "away_div": s.away_div,
        "home_conf": s.home_conference.astype("string"), "away_conf": s.away_conference.astype("string"),
        "neutral": s.neutral_site.fillna(False).astype(bool).astype(int),
        "conf_game": s.conference_game.fillna(False).astype(bool).astype(int),
        "home_score": np.where(done, s.home_points, np.nan), "away_score": np.where(done, s.away_points, np.nan),
        "venue": s.venue.astype("string"), "notes": s.notes.astype("string"),
    })
    g["result"] = g.home_score - g.away_score
    g["total_pts"] = g.home_score + g.away_score
    g["home_rest"] = [rest.get((a, b), np.nan) for a, b in zip(g.game_id, g.home)]
    g["away_rest"] = [rest.get((a, b), np.nan) for a, b in zip(g.game_id, g.away)]
    # one rating slate per regular-season week; the postseason in weekly slates after it
    g["slate"] = g.week.astype(float)
    for y, d in g[g.season_type == "postseason"].groupby("season"):
        last = g[(g.season == y) & (g.season_type == "regular")].week.max()
        first = d.kick_utc.min()
        g.loc[d.index, "slate"] = last + 1 + ((d.kick_utc - first).dt.days // 7)
    g["slate"] = g.slate.astype(int)
    # closing lines: the cfb_p4 market table (2006-2025), the record (2026)
    M = pd.read_csv(market_csv, low_memory=False)
    M = M.drop_duplicates("game_id").set_index("game_id")
    cols = {"spread_close": "close_margin", "total_close": "close_total", "spread_open": "open_margin",
            "mlh_close": "home_ml", "mla_close": "away_ml", "spread_close_pin": "close_margin_pin",
            "spread_books": "close_books"}
    for a, b in cols.items():
        g[b] = g.game_id.map(M[a]) if a in M.columns else np.nan
    g["close_source"] = np.where(g.close_margin.notna(), "cfbfastR line archive (median across books)", None)
    rec = _record_2026()
    for i, gid in zip(g.index, g.game_id):
        r = rec.get(int(gid))
        if r and not np.isfinite(g.at[i, "close_margin"]):
            for k in ("close_margin", "close_total", "home_ml", "away_ml", "close_source"):
                g.at[i, k] = r[k]
    for c in ("close_margin", "close_total", "open_margin", "home_ml", "away_ml", "close_margin_pin"):
        g[c] = pd.to_numeric(g[c], errors="coerce")
    # the current season's CFBD consensus line (sportsdataverse cfb_matchup_line): the
    # reference for games not yet closed; the market rating falls back to it for a
    # finished game the record has no close for. Never used as a graded close.
    g["ref_margin"] = np.nan
    newest = int(g.season.max())
    mp = os.path.join(raw, f"mline_{newest}.parquet")
    if os.path.exists(mp):
        ml = pd.read_parquet(mp, columns=["game_id", "spread"]).dropna().drop_duplicates("game_id")
        g["ref_margin"] = g.game_id.map(dict(zip(ml.game_id.astype("int64"), -ml.spread.astype(float))))
    g["mkt_margin"] = g.close_margin.where(g.close_margin.notna(), np.where(g.result.notna(), g.ref_margin, np.nan))
    return g.sort_values(["kick_utc", "game_id"]).reset_index(drop=True)


def _season_plays(raw, y, game_ids):
    path = os.path.join(raw, f"pbp_{y}.parquet")
    import pyarrow.parquet as pq
    names = set(pq.ParquetFile(path).schema_arrow.names)
    p = pd.read_parquet(path, columns=[c for c in PBP_COLS if c in names])
    for c in PBP_COLS:
        if c not in p.columns:
            p[c] = np.nan
    b = lambda c: p[c].fillna(False).astype(bool)
    rush, pas, sack = b("rush"), b("pass"), b("sack")
    text = p["text"].fillna("").astype(str)
    kneel = b("kneel_down") | (rush & text.str.contains("kneel", case=False))
    keep = ((rush | pas | sack) & ~b("penalty_no_play") & p.EPA.notna() & ~kneel & ~b("text_dupe")
            & p.pos_team_id.notna() & p.def_pos_team_id.notna() & p.game_id.isin(game_ids))
    is_pass = (pas | sack)[keep]
    p = p[keep].copy()
    p["team"] = p.pos_team_id.astype("int64")
    p["opp"] = p.def_pos_team_id.astype("int64")
    p["game_id"] = p.game_id.astype("int64")
    p["unit"] = np.where(is_pass.values, "pass", "rush")
    wp = pd.to_numeric(p.wp_before_naive, errors="coerce")
    p["comp"] = ((wp >= WP_LO) & (wp <= WP_HI)).astype(int)
    p.loc[wp.isna(), "comp"] = 1         # no win probability: counted as competitive
    p["epa"] = p.EPA.astype(float)
    # a dropback with no passer (mostly sacks) belongs to the side's main passer that game
    d = p[p.unit == "pass"]
    main = d[d.passer_player_id.notna()].groupby(["game_id", "team"]).passer_player_id.agg(lambda x: x.value_counts().index[0])
    miss = (p.unit == "pass") & p.passer_player_id.isna()
    p.loc[miss, "passer_player_id"] = [main.get((a, t), np.nan) for a, t in zip(p.game_id[miss], p.team[miss])]
    return p


def _split_sums(df, keys):
    df = df.assign(n_in=df.comp, n_out=1 - df.comp, epa_in=df.epa * df.comp, epa_out=df.epa * (1 - df.comp))
    return df.groupby(keys, as_index=False)[["n_in", "n_out", "epa_in", "epa_out"]].sum()


def build_plays(raw, seasons, games):
    units, qbs, names = [], [], {}
    gids = set(games.game_id)
    slate = dict(zip(games.game_id, games.slate))
    for y in seasons:
        if not os.path.exists(os.path.join(raw, f"pbp_{y}.parquet")):
            continue
        p = _season_plays(raw, y, gids)
        p["season"] = y
        p["week"] = p.game_id.map(slate).astype(int)
        units.append(_split_sums(p, ["game_id", "season", "week", "team", "opp", "unit"]))
        d = p[(p.unit == "pass") & p.passer_player_id.notna()].copy()
        d["qb_id"] = d.passer_player_id.astype("int64").astype(str)
        qbs.append(_split_sums(d, ["game_id", "season", "week", "team", "opp", "qb_id"]))
        nm = d.dropna(subset=["passer_player_name"]).drop_duplicates("qb_id", keep="last")
        names.update(dict(zip(nm.qb_id, nm.passer_player_name.astype(str))))
        print(f"pbp {y}: {len(p)} plays, {p.game_id.nunique()} games", file=sys.stderr)
    u = pd.concat(units, ignore_index=True)
    q = pd.concat(qbs, ignore_index=True)
    qn = pd.DataFrame({"qb_id": list(names), "name": list(names.values())})
    return u, q, qn


def attach_starters(games, q):
    """The quarterback who took the most dropbacks for each side: what the
    backtest prices (the card prices the most recent starter instead)."""
    q = q.assign(n=q.n_in + q.n_out).sort_values("n", ascending=False).drop_duplicates(["game_id", "team"])
    st = dict(zip(zip(q.game_id, q.team), q.qb_id))
    games = games.copy()
    games["home_qb_id"] = [st.get((a, b)) for a, b in zip(games.game_id, games.home)]
    games["away_qb_id"] = [st.get((a, b)) for a, b in zip(games.game_id, games.away)]
    return games


def build_priors(raw, seasons):
    rows = []
    for y in seasons:
        t = os.path.join(raw, f"talent_{y}.parquet")
        r = os.path.join(raw, f"retprod_{y}.parquet")
        d = None
        if os.path.exists(t):
            tt = pd.read_parquet(t)
            d = pd.DataFrame({"team": pd.to_numeric(tt.team_id, errors="coerce"), "talent": tt.talent_composite.astype(float)})
        if os.path.exists(r):
            rp = pd.read_parquet(r)
            rr = pd.DataFrame({"team": pd.to_numeric(rp.team_id, errors="coerce"), "ret_off": rp.off_returning.astype(float),
                               "ret_def": rp.def_returning.astype(float), "ret_all": rp.overall_returning.astype(float)})
            d = rr if d is None else d.merge(rr, on="team", how="outer")
        if d is not None:
            rows.append(d.dropna(subset=["team"]).assign(season=y))
    pr = pd.concat(rows, ignore_index=True)
    pr["team"] = pr.team.astype("int64")
    return pr.drop_duplicates(["season", "team"])


def build(data_dir, seasons):
    raw = os.path.join(data_dir, "raw")
    out = os.path.join(data_dir, "build")
    os.makedirs(out, exist_ok=True)
    market = build_market(data_dir)
    games = build_games(raw, seasons, market)
    u, q, qn = build_plays(raw, seasons, games)
    games = attach_starters(games, q)
    games.to_parquet(os.path.join(out, "games.parquet"), index=False)
    u.to_parquet(os.path.join(out, "unit_games.parquet"), index=False)
    q.to_parquet(os.path.join(out, "qb_games.parquet"), index=False)
    qn.to_parquet(os.path.join(out, "qb_names.parquet"), index=False)
    build_priors(raw, seasons).to_parquet(os.path.join(out, "priors.parquet"), index=False)
    return out


def parse_seasons(spec):
    a, _, b = spec.partition("-")
    return list(range(int(a), int(b or a) + 1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=".cache/model_loop/cfb")
    ap.add_argument("--seasons", default=f"2008-{current_season()}")
    ap.add_argument("--fetch", action="store_true", help="download missing raw files first")
    a = ap.parse_args(argv)
    seasons = parse_seasons(a.seasons)
    if a.fetch:
        fetch(a.data, seasons)
    print(build(a.data, seasons))


if __name__ == "__main__":
    main()
