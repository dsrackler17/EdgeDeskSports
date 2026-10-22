"""Build NFL referee flag datasets for EdgeDesk.

Sources:
  - nflverse play-by-play (pbp_YYYY.parquet) for penalties
  - nflverse schedules (games.csv) for referee per game (2024-2026 W1-4)
  - Football Zebras weekly assignments for 2026 W5-W7 (nflverse not backfilled yet)
"""
import pandas as pd

SEASONS = [2024, 2025, 2026]

# 2026 assignments nflverse hasn't backfilled yet (Football Zebras)
MANUAL_REFS = {
    # Week 5
    "2026_05_TB_DAL": "Alex Moore", "2026_05_PHI_JAX": "Ron Torbert", "2026_05_CHI_GB": "Clay Martin",
    "2026_05_CIN_MIA": "Brad Rogers", "2026_05_LV_NE": "Craig Wrolstad", "2026_05_MIN_NO": "John Hussey",
    "2026_05_CLE_NYJ": "Bill Vinovich", "2026_05_IND_PIT": "Shawn Smith", "2026_05_HOU_TEN": "Alex Kemp",
    "2026_05_NYG_WAS": "Clete Blakeman", "2026_05_DEN_LAC": "Shawn Hochuli", "2026_05_DET_ARI": "Carl Cheffers",
    "2026_05_SF_SEA": "Land Clark", "2026_05_BAL_ATL": "Brad Allen", "2026_05_BUF_LA": "Scott Novak",
    # Week 6
    "2026_06_SEA_DEN": "Brad Rogers", "2026_06_HOU_JAX": "Shawn Hochuli", "2026_06_CHI_ATL": "Scott Novak",
    "2026_06_BAL_CLE": "Carl Cheffers", "2026_06_TEN_IND": "Bill Vinovich", "2026_06_NYJ_NE": "Clete Blakeman",
    "2026_06_NO_NYG": "Alex Kemp", "2026_06_CAR_PHI": "John Hussey", "2026_06_PIT_TB": "Land Clark",
    "2026_06_ARI_LA": "Clay Martin", "2026_06_LAC_KC": "Alan Eck", "2026_06_BUF_LV": "Shawn Smith",
    "2026_06_DAL_GB": "Craig Wrolstad", "2026_06_WAS_SF": "Adrian Hill",
}
WEEK7 = {
    "2026_07_NE_CHI": "Alan Eck", "2026_07_PIT_NO": "Bill Vinovich", "2026_07_SF_ATL": "Clay Martin",
    "2026_07_CIN_BAL": "Shawn Smith", "2026_07_TB_CAR": "Carl Cheffers", "2026_07_NYG_HOU": "Land Clark",
    "2026_07_IND_MIN": "Brad Rogers", "2026_07_MIA_NYJ": "Brad Allen", "2026_07_CLE_TEN": "Scott Novak",
    "2026_07_DEN_ARI": "Craig Wrolstad", "2026_07_GB_DET": "Alex Moore", "2026_07_LA_LV": "Ron Torbert",
    "2026_07_KC_SEA": "John Hussey", "2026_07_DAL_PHI": "Alex Kemp",
}

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

games = pd.read_csv("games.csv")
games = games[games.season.isin(SEASONS)].copy()
games["referee"] = games["referee"].fillna(games["game_id"].map(MANUAL_REFS))

rows = []
for s in SEASONS:
    p = pd.read_parquet(f"pbp_{s}.parquet", columns=[
        "game_id", "play_type", "penalty", "penalty_type", "penalty_team", "penalty_yards",
        "home_team", "away_team", "desc"])
    p["is_snap"] = p.play_type.isin(SNAP_TYPES)
    pen = p[p.penalty == 1].copy()
    d = pen["desc"].fillna("").str.lower()
    pen["declined"] = d.str.contains("declined")
    pen["offsetting"] = d.str.contains("offsetting")
    pen["accepted"] = ~pen.declined & ~pen.offsetting
    g = pen.groupby("game_id")
    out = pd.DataFrame({
        "flags": g.size(),
        "accepted_flags": g.accepted.sum(),
        "penalty_yards": g.penalty_yards.sum(),
        "home_flags": g.apply(lambda x: (x.penalty_team == x.home_team).sum()),
        "away_flags": g.apply(lambda x: (x.penalty_team == x.away_team).sum()),
    })
    for col, types in COUNTED.items():
        out[col] = g.apply(lambda x, t=types: x.penalty_type.isin(t).sum())
    out["snaps"] = p.groupby("game_id").is_snap.sum()
    rows.append(out.reset_index())

pg = pd.concat(rows).fillna(0)
pg = games[["game_id", "season", "week", "game_type", "gameday", "away_team", "home_team",
            "referee", "total", "total_line", "spread_line", "result"]].merge(pg, on="game_id")
pg = pg[pg.result.notna() & pg.referee.notna()].copy()
num = [c for c in pg.columns if c in ["flags", "accepted_flags", "penalty_yards", "home_flags", "away_flags", "snaps"] + list(COUNTED)]
pg[num] = pg[num].astype(int)
pg["holding_total"] = pg.off_holding + pg.def_holding
pg["flags_per_100_snaps"] = (100 * pg["flags"] / pg["snaps"]).round(2)
pg["went_over"] = (pg.total > pg.total_line).astype("Int64").where(pg.total != pg.total_line)
pg = pg.sort_values(["season", "week", "game_id"])
pg.to_csv("ref_game_penalties.csv", index=False)

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


reg = pg[pg.game_type == "REG"]
summary = pd.concat([
    summarize(reg[reg.season == 2026], "2026"),
    summarize(reg[reg.season == 2025], "2025"),
    summarize(reg, "2024-2026"),
])
summary.to_csv("ref_summary.csv", index=False)

# Week 7 slate joined to each ref's 2026 + 3-yr numbers
w7 = games[games.game_id.isin(WEEK7)][["game_id", "season", "week", "gameday", "away_team", "home_team",
                                         "total_line", "spread_line"]].copy()
w7["referee"] = w7.game_id.map(WEEK7)
keep = ["referee", "games", "flags_pg", "holding_total_pg", "off_holding_pg", "dpi_pg",
        "penalty_yards_pg", "flags_vs_league_pg", "holding_vs_league_pg", "flags_rank", "holding_rank"]
s26 = summary[summary.window == "2026"][keep].add_prefix("s26_").rename(columns={"s26_referee": "referee"})
s3 = summary[summary.window == "2024-2026"][keep].add_prefix("y3_").rename(columns={"y3_referee": "referee"})
w7 = w7.merge(s26, on="referee", how="left").merge(s3, on="referee", how="left")
w7.to_csv("ref_assignments_2026_w7.csv", index=False)

# full assignment table (all games with a known ref) for the DB
assign = pd.concat([
    games[games.referee.notna()][["game_id", "season", "week", "referee"]],
    w7[["game_id", "season", "week", "referee"]],
]).drop_duplicates("game_id")
assign["source"] = assign.game_id.map(lambda g: "footballzebras" if g in MANUAL_REFS or g in WEEK7 else "nflverse")
assign.to_csv("ref_assignments.csv", index=False)

print(summary[summary.window == "2026"][["referee", "games", "flags_pg", "holding_total_pg", "off_holding_pg",
                                         "flags_per_100_snaps", "flags_vs_league_pg", "holding_rank"]].to_string(index=False))
print(len(pg), "games;", pg.groupby("season").size().to_dict())
