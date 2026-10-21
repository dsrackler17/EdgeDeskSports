"""NFL ingestion: nflverse play-by-play, schedule, rosters and snap counts
into the compact tables the rating fit reads.

Sources (public, keyless, the same releases football/research already uses):
  pbp/play_by_play_<season>.parquet       EPA, win probability, passer ids
  nfldata/games.csv                       schedule, scores, consensus close,
                                          rest, roof, surface, QB ids
  weekly_rosters/roster_weekly_<s>.parquet who was on which team in week 1
  snap_counts/snap_counts_<s>.parquet      offensive-line snaps (2012+)

Outputs (in <data>/build/):
  games.parquet       one row per game, franchise-normalised team codes
  unit_games.parquet  per (game, offense, unit): plays and EPA, split into
                      competitive plays (0.10 <= wp <= 0.90) and the rest,
                      so the garbage-time weight is applied at fit time
  qb_games.parquet    per (game, team, dropback player): dropbacks and EPA
  skill.parquet       per (season, team, player, role): non-QB rushing and
                      receiving EPA, for the personnel priors
  roster_w1.parquet   week-1 roster per (season, team): who carried over
  players.parquet     one row per player: position, draft slot, first season
  ol_snaps.parquet    offensive-line offense snaps per (season, team, player)

Usage:
  python3 -m model_loop.adapters.nfl.ingest --data .cache/model_loop/nfl [--fetch] [--seasons 2006-2026]
"""
import argparse
import os
import sys
import urllib.request

import numpy as np
import pandas as pd

RELEASES = "https://github.com/nflverse/nflverse-data/releases/download"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# one code per franchise across relocations, so a club's rating follows it
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "JAC": "JAX"}

# the competitive window: plays outside it are down-weighted at fit time
WP_LO, WP_HI = 0.10, 0.90

PBP_COLS = ["game_id", "season", "week", "season_type", "posteam", "defteam",
            "play_type", "pass", "rush", "qb_dropback", "qb_kneel", "qb_spike",
            "two_point_attempt", "epa", "success", "wp", "id",
            "passer_player_id", "rusher_player_id", "receiver_player_id",
            "qb_scramble"]


def franchise(code):
    if code is None or (isinstance(code, float) and np.isnan(code)):
        return code
    return FRANCHISE.get(code, code)


def _download(url, dest):
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def fetch(data_dir, seasons, refresh_current=True):
    """Download whatever is missing. The newest season is always refetched
    (it grows every week); finished seasons are fetched once."""
    raw = os.path.join(data_dir, "raw")
    os.makedirs(raw, exist_ok=True)
    newest = max(seasons)
    jobs = [(GAMES_URL, os.path.join(raw, "games.csv"), True)]
    for y in seasons:
        cur = refresh_current and y == newest
        jobs.append((f"{RELEASES}/pbp/play_by_play_{y}.parquet", os.path.join(raw, f"pbp_{y}.parquet"), cur))
        jobs.append((f"{RELEASES}/weekly_rosters/roster_weekly_{y}.parquet", os.path.join(raw, f"roster_weekly_{y}.parquet"), cur))
        if y >= 2012:
            jobs.append((f"{RELEASES}/snap_counts/snap_counts_{y}.parquet", os.path.join(raw, f"snaps_{y}.parquet"), cur))
    for url, dest, force in jobs:
        if force or not os.path.exists(dest):
            try:
                _download(url, dest)
            except Exception as e:  # a missing optional season is reported, never invented
                print(f"fetch failed: {url}: {e}", file=sys.stderr)


def build_games(raw):
    g = pd.read_csv(os.path.join(raw, "games.csv"), low_memory=False)
    for c in ("home_team", "away_team"):
        g[c] = g[c].map(franchise)
    out = pd.DataFrame({
        "game_id": g.game_id, "season": g.season.astype(int), "week": g.week.astype(int),
        "game_type": g.game_type, "gameday": g.gameday, "gametime": g.gametime,
        "home": g.home_team, "away": g.away_team,
        "home_score": g.home_score, "away_score": g.away_score,
        "result": g.result, "total_pts": g.total,
        # nflverse spread_line is the home MARGIN the market expects (+ = home favoured)
        "close_margin": g.spread_line, "close_total": g.total_line,
        "home_ml": g.home_moneyline, "away_ml": g.away_moneyline,
        "neutral": (g.location == "Neutral").astype(int),
        "roof": g.roof, "surface": g.surface, "temp": g.temp, "wind": g.wind,
        "home_rest": g.home_rest, "away_rest": g.away_rest,
        "div_game": g.div_game.fillna(0).astype(int),
        "stadium": g.stadium, "stadium_id": g.stadium_id,
        "home_qb_id": g.home_qb_id, "away_qb_id": g.away_qb_id,
        "home_qb_name": g.home_qb_name, "away_qb_name": g.away_qb_name,
    })
    t = pd.to_datetime(out.gameday + " " + out.gametime.fillna("13:00"), errors="coerce")
    out["kick_et"] = t
    out = out.sort_values(["kick_et", "game_id"]).reset_index(drop=True)
    return out


def _season_plays(raw, y):
    p = pd.read_parquet(os.path.join(raw, f"pbp_{y}.parquet"), columns=PBP_COLS)
    keep = (p.play_type.isin(["pass", "run"]) & p.epa.notna()
            & (p.qb_kneel.fillna(0) == 0) & (p.qb_spike.fillna(0) == 0)
            & (p.two_point_attempt.fillna(0) == 0) & p.posteam.notna() & p.defteam.notna())
    p = p[keep].copy()
    p["posteam"] = p.posteam.map(franchise)
    p["defteam"] = p.defteam.map(franchise)
    p["unit"] = np.where(p["pass"] == 1, "pass", np.where(p["rush"] == 1, "rush", None))
    p = p[p.unit.notna()]
    wp = p.wp.astype(float)
    p["comp"] = ((wp >= WP_LO) & (wp <= WP_HI)).astype(int)
    # a missing win probability (rare, start of overtime) counts as competitive
    p.loc[wp.isna(), "comp"] = 1
    p["epa"] = p.epa.astype(float)
    return p


def _split_sums(df, keys):
    df = df.assign(n_in=df.comp, n_out=1 - df.comp,
                   epa_in=df.epa * df.comp, epa_out=df.epa * (1 - df.comp))
    return df.groupby(keys, as_index=False)[["n_in", "n_out", "epa_in", "epa_out"]].sum()


def build_plays(raw, seasons):
    units, qbs, skill = [], [], []
    for y in seasons:
        path = os.path.join(raw, f"pbp_{y}.parquet")
        if not os.path.exists(path):
            continue
        p = _season_plays(raw, y)
        units.append(_split_sums(p, ["game_id", "season", "week", "posteam", "defteam", "unit"]))
        d = p[p.unit == "pass"].copy()
        d["qb_id"] = d["id"].fillna(d.passer_player_id)
        d = d[d.qb_id.notna()]
        qbs.append(_split_sums(d, ["game_id", "season", "week", "posteam", "defteam", "qb_id"]))
        # personnel: non-QB rushers (designed runs) and targeted receivers
        r = p[(p.unit == "rush") & p.rusher_player_id.notna()][["season", "posteam", "rusher_player_id", "epa", "comp"]]
        r = r.rename(columns={"rusher_player_id": "player_id"}).assign(role="rush")
        c = p[(p.unit == "pass") & p.receiver_player_id.notna()][["season", "posteam", "receiver_player_id", "epa", "comp"]]
        c = c.rename(columns={"receiver_player_id": "player_id"}).assign(role="rec")
        sk = pd.concat([r, c])
        skill.append(sk.groupby(["season", "posteam", "player_id", "role"], as_index=False)
                     .agg(n=("epa", "size"), epa_sum=("epa", "sum")))
        print(f"pbp {y}: {len(p)} plays", file=sys.stderr)
    u = pd.concat(units).rename(columns={"posteam": "team", "defteam": "opp"})
    q = pd.concat(qbs).rename(columns={"posteam": "team", "defteam": "opp"})
    s = pd.concat(skill).rename(columns={"posteam": "team"})
    return u, q, s


def build_rosters(raw, seasons):
    rows = []
    for y in seasons:
        path = os.path.join(raw, f"roster_weekly_{y}.parquet")
        if not os.path.exists(path):
            continue
        r = pd.read_parquet(path)
        r = r[r.game_type.fillna("REG") == "REG"] if "game_type" in r.columns else r
        wk = r.week.min()
        r = r[r.week == wk]
        def numcol(c):
            return pd.to_numeric(r[c], errors="coerce") if c in r.columns else np.nan
        rows.append(pd.DataFrame({
            "season": y, "team": r.team.map(franchise), "gsis_id": r.gsis_id.astype("string"),
            "pfr_id": r.pfr_id.astype("string"), "position": r.position.astype("string"),
            "status": r.status.astype("string"), "entry_year": numcol("entry_year"),
            "draft_number": numcol("draft_number"), "years_exp": numcol("years_exp")}))
    return pd.concat(rows, ignore_index=True)


def build_players(raw, seasons):
    """One row per player id: position, draft slot and first season, from
    every weekly roster (a QB signed mid-season is in no week-1 roster)."""
    rows = []
    for y in seasons:
        path = os.path.join(raw, f"roster_weekly_{y}.parquet")
        if not os.path.exists(path):
            continue
        r = pd.read_parquet(path, columns=[c for c in ("gsis_id", "full_name", "position", "draft_number", "entry_year", "rookie_year")
                                            if c in pd.read_parquet(path).columns])
        r["season"] = y
        rows.append(r)
    p = pd.concat(rows, ignore_index=True)
    p = p[p.gsis_id.notna()]
    for c in ("draft_number", "entry_year", "rookie_year"):
        if c in p.columns:
            p[c] = pd.to_numeric(p[c], errors="coerce")
    agg = p.sort_values("season").groupby("gsis_id").agg(
        name=("full_name", "last"), position=("position", "last"),
        draft_number=("draft_number", "max"), entry_year=("entry_year", "min"),
        first_roster_season=("season", "min")).reset_index()
    for c in ("name", "position", "gsis_id"):
        agg[c] = agg[c].astype("string")
    return agg


def build_ol_snaps(raw, seasons):
    rows = []
    for y in seasons:
        path = os.path.join(raw, f"snaps_{y}.parquet")
        if not os.path.exists(path):
            continue
        s = pd.read_parquet(path)
        s = s[(s.position.isin(["T", "G", "C", "OL", "OT", "OG"])) & (s.game_type == "REG")]
        if not len(s):
            continue
        s = s.assign(team=s.team.map(franchise))
        rows.append(s.groupby(["season", "team", "pfr_player_id"], as_index=False).offense_snaps.sum())
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(columns=["season", "team", "pfr_player_id", "offense_snaps"])


def build(data_dir, seasons):
    raw = os.path.join(data_dir, "raw")
    out = os.path.join(data_dir, "build")
    os.makedirs(out, exist_ok=True)
    games = build_games(raw)
    games.to_parquet(os.path.join(out, "games.parquet"), index=False)
    u, q, s = build_plays(raw, seasons)
    u.to_parquet(os.path.join(out, "unit_games.parquet"), index=False)
    q.to_parquet(os.path.join(out, "qb_games.parquet"), index=False)
    s.to_parquet(os.path.join(out, "skill.parquet"), index=False)
    build_rosters(raw, seasons).to_parquet(os.path.join(out, "roster_w1.parquet"), index=False)
    build_players(raw, seasons).to_parquet(os.path.join(out, "players.parquet"), index=False)
    build_ol_snaps(raw, seasons).to_parquet(os.path.join(out, "ol_snaps.parquet"), index=False)
    return out


def parse_seasons(spec):
    a, _, b = spec.partition("-")
    return list(range(int(a), int(b or a) + 1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=".cache/model_loop/nfl")
    ap.add_argument("--seasons", default="2006-2026")
    ap.add_argument("--fetch", action="store_true", help="download missing raw files first")
    a = ap.parse_args(argv)
    seasons = parse_seasons(a.seasons)
    if a.fetch:
        fetch(a.data, seasons)
    print(build(a.data, seasons))


if __name__ == "__main__":
    main()
