"""Build NFL referee flag datasets for EdgeDesk.

Sources:
  - nflverse play-by-play (pbp_YYYY.parquet) for penalties
  - nflverse schedules (games.csv) for referee per game
  - manual_assignments.json (next to this script) for games nflverse has not
    filled in yet (Football Zebras, announced Wed/Thu). nflverse wins whenever
    it has a referee for a game.

  python build_ref_data.py
      2024-2026 from ./games.csv and ./pbp_YYYY.parquet, written to ./ (the full rebuild)
  python build_ref_data.py --seasons 2026 --games G --pbp-dir D --out-dir O
      one season (the weekly sync, .github/workflows/ref-sync.yml)

Outputs, for the seasons asked:
  ref_game_penalties.csv                one row per played game  -> nfl_ref_game_penalties
  ref_assignments.csv                   every game with a referee -> nfl_ref_assignments
  ref_summary.csv                       per-ref averages: the latest season, the one before, and all of them
  ref_assignments_{season}_w{week}.csv  the next week with assignments, joined to those averages
"""
import argparse
import json
import os
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = {"nflverse", "footballzebras", "manual"}

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--seasons", type=int, nargs="+", default=[2024, 2025, 2026])
ap.add_argument("--games", default="games.csv")
ap.add_argument("--pbp-dir", default=".")
ap.add_argument("--out-dir", default=".")
ap.add_argument("--manual", default=os.path.join(HERE, "manual_assignments.json"))
args = ap.parse_args()
SEASONS = sorted(set(args.seasons))
os.makedirs(args.out_dir, exist_ok=True)


def out(name):
    return os.path.join(args.out_dir, name)


def load_manual(path, known):
    """{game_id: referee} and {game_id: source}; any mistake stops the build."""
    with open(path) as fh:
        doc = json.load(fh)
    refs, src, bad = {}, {}, []
    for blk in doc.get("weeks", []):
        season, week, source = blk.get("season"), blk.get("week"), blk.get("source", "footballzebras")
        if not isinstance(season, int) or not isinstance(week, int):
            bad.append(f"a block has season {season!r}, week {week!r}: both must be whole numbers")
            continue
        if source not in SOURCES:
            bad.append(f"{season} week {week}: source {source!r} is not one of {sorted(SOURCES)}")
        for gid, ref in (blk.get("games") or {}).items():
            if not gid.startswith(f"{season}_{week:02d}_"):
                bad.append(f"{gid} is listed under {season} week {week}")
            elif gid not in known:
                bad.append(f"{gid} is not a game_id in {args.games}")
            elif not isinstance(ref, str) or not ref.strip():
                bad.append(f"{gid} has no referee name")
            elif gid in refs:
                bad.append(f"{gid} is listed twice")
            else:
                refs[gid], src[gid] = ref.strip(), source
    if bad:
        sys.exit(f"{path}:\n  " + "\n  ".join(bad))
    return refs, src


SNAP_TYPES = {"run", "pass", "no_play", "punt", "field_goal", "kickoff", "extra_point", "qb_kneel", "qb_spike"}
COUNTED = {
    "off_holding": ["Offensive Holding"],
    "def_holding": ["Defensive Holding"],
    "dpi": ["Defensive Pass Interference"],
    "opi": ["Offensive Pass Interference"],
    "false_start": ["False Start"],
    "roughing_passer": ["Roughing the Passer"],
    "unnecessary_roughness": ["Unnecessary Roughness"],
    "illegal_contact": ["Illegal Contact"],
    "illegal_use_of_hands": ["Illegal Use of Hands"],
}

games = pd.read_csv(args.games)
MANUAL_REFS, MANUAL_SRC = load_manual(args.manual, set(games.game_id))
games = games[games.season.isin(SEASONS)].copy()
nflv = games["referee"].notna()
for r in games[nflv & games.game_id.isin(MANUAL_REFS)].itertuples():
    if r.referee != MANUAL_REFS[r.game_id]:
        print(f"note: {r.game_id}: nflverse has {r.referee}, manual_assignments.json has {MANUAL_REFS[r.game_id]}; nflverse wins")
games["referee"] = games["referee"].fillna(games["game_id"].map(MANUAL_REFS))
games["source"] = games["game_id"].map(MANUAL_SRC).where(~nflv, "nflverse")

rows = []
for s in SEASONS:
    p = pd.read_parquet(os.path.join(args.pbp_dir, f"pbp_{s}.parquet"), columns=[
        "game_id", "play_type", "penalty", "penalty_type", "penalty_team", "penalty_yards",
        "home_team", "away_team", "desc"])
    p["is_snap"] = p.play_type.isin(SNAP_TYPES)
    pen = p[p.penalty == 1].copy()
    d = pen["desc"].fillna("").str.lower()
    pen["declined"] = d.str.contains("declined")
    pen["offsetting"] = d.str.contains("offsetting")
    pen["accepted"] = ~pen.declined & ~pen.offsetting
    g = pen.groupby("game_id")
    out_s = pd.DataFrame({
        "flags": g.size(),
        "accepted_flags": g.accepted.sum(),
        "penalty_yards": g.penalty_yards.sum(),
        "home_flags": g.apply(lambda x: (x.penalty_team == x.home_team).sum()),
        "away_flags": g.apply(lambda x: (x.penalty_team == x.away_team).sum()),
    })
    for col, types in COUNTED.items():
        out_s[col] = g.apply(lambda x, t=types: x.penalty_type.isin(t).sum())
    out_s["snaps"] = p.groupby("game_id").is_snap.sum()
    rows.append(out_s.reset_index())

pg = pd.concat(rows).fillna(0)
pg = games[["game_id", "season", "week", "game_type", "gameday", "away_team", "home_team",
            "referee", "total", "total_line", "spread_line", "result"]].merge(pg, on="game_id")
pg = pg[pg.result.notna() & pg.referee.notna()].copy()
num = [c for c in pg.columns if c in ["flags", "accepted_flags", "penalty_yards", "home_flags", "away_flags", "snaps"] + list(COUNTED)]
pg[num] = pg[num].astype(int)
pg["holding_total"] = pg.off_holding + pg.def_holding
pg["flags_per_100_snaps"] = (100 * pg["flags"] / pg["snaps"]).round(2)
# 1 over, 0 under; null on a push and when there is no line
pg["went_over"] = (pg.total > pg.total_line).astype("Int64").where((pg.total != pg.total_line) & pg.total_line.notna())
pg = pg.sort_values(["season", "week", "game_id"])
pg.to_csv(out("ref_game_penalties.csv"), index=False)

METRICS = ["flags", "accepted_flags", "penalty_yards", "holding_total", "off_holding", "def_holding",
           "dpi", "opi", "false_start", "roughing_passer", "unnecessary_roughness", "home_flags", "away_flags"]


def summarize(df, label):
    g = df.groupby("referee")
    s = g[METRICS].mean().round(2).add_suffix("_pg")
    s.insert(0, "games", g.size())
    s["flags_per_100_snaps"] = (100 * g["flags"].sum() / g["snaps"].sum()).round(2)
    s["home_minus_away_pg"] = (s.home_flags_pg - s.away_flags_pg).round(2)
    ou = df.dropna(subset=["went_over"]).groupby("referee").went_over
    s["overs"] = ou.sum().astype(int)
    s["unders"] = (ou.count() - ou.sum()).astype(int)
    lg = df[METRICS].mean()
    s["flags_vs_league_pg"] = (s.flags_pg - lg["flags"]).round(2)
    s["holding_vs_league_pg"] = (s.holding_total_pg - lg["holding_total"]).round(2)
    s["flags_rank"] = s.flags_pg.rank(ascending=False, method="min").astype(int)
    s["holding_rank"] = s.holding_total_pg.rank(ascending=False, method="min").astype(int)
    s.insert(0, "window", label)
    league = {"window": label, "referee": "LEAGUE AVG", "games": len(df),
              **{f"{m}_pg": round(lg[m], 2) for m in METRICS},
              "flags_per_100_snaps": round(100 * df["flags"].sum() / df["snaps"].sum(), 2)}
    return pd.concat([s.reset_index().sort_values("flags_pg", ascending=False), pd.DataFrame([league])])


# windows: the latest season, the one before it, and every season asked for
reg = pg[pg.game_type == "REG"]
LATEST = SEASONS[-1]
ALL = f"{SEASONS[0]}-{LATEST}" if len(SEASONS) > 1 else None
parts = [summarize(reg[reg.season == s], str(s)) for s in SEASONS[::-1][:2] if (reg.season == s).any()]
if ALL:
    parts.append(summarize(reg, ALL))
summary = pd.concat(parts) if parts else pd.DataFrame(columns=["window", "referee"])
summary.to_csv(out("ref_summary.csv"), index=False)

# the next week with assignments (games not played yet), joined to the latest
# season's and the whole window's numbers
upcoming = games[(games.season == LATEST) & games.referee.notna() & games.result.isna()]
if len(upcoming):
    week = int(upcoming.week.min())
    slate = upcoming[upcoming.week == week][["game_id", "season", "week", "gameday", "away_team", "home_team",
                                            "total_line", "spread_line", "referee"]].copy()
    keep = ["referee", "games", "flags_pg", "holding_total_pg", "off_holding_pg", "dpi_pg",
            "penalty_yards_pg", "flags_vs_league_pg", "holding_vs_league_pg", "flags_rank", "holding_rank"]
    for label, prefix in ((str(LATEST), f"s{str(LATEST)[2:]}_"), (ALL, f"y{len(SEASONS)}_")):
        if label and (summary.window == label).any():
            w = summary[summary.window == label][keep].add_prefix(prefix).rename(columns={prefix + "referee": "referee"})
            slate = slate.merge(w, on="referee", how="left")
    slate.to_csv(out(f"ref_assignments_{LATEST}_w{week}.csv"), index=False)
    print(f"{LATEST} week {week}: {len(slate)} games with a referee assigned")
else:
    print(f"{LATEST}: no upcoming game has a referee assigned yet")

# full assignment table (all games with a known ref) for the DB
assign = games[games.referee.notna()][["game_id", "season", "week", "referee", "source"]]
assign.to_csv(out("ref_assignments.csv"), index=False)

if (summary.window == str(LATEST)).any():
    print(summary[summary.window == str(LATEST)][["referee", "games", "flags_pg", "holding_total_pg", "off_holding_pg",
                                                  "flags_per_100_snaps", "flags_vs_league_pg", "holding_rank"]].to_string(index=False))
print(len(pg), "games;", pg.groupby("season").size().to_dict(), "|", len(assign), "assignments;",
      assign.groupby("source").size().to_dict())
