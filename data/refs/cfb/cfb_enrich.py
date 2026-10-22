"""Fill gaps in the EdgeDesk CFB officiating package and emit EdgeDesk-ready tables.

Inputs: the uploaded package (cfb_refs/), NCAA schedules 2024-2026, ESPN CFB pbp 2024-2026.
Fills:
  1. Referee role: evidence that the single NCAA-listed official is the crew chief.
  2. Name aliases: typo/nickname variants merged to one canonical official.
  3. Unmatched NCAA officials (no ESPN id) matched to ESPN games by date + teams.
  4. Same-day double assignments resolved by conference, or nulled.
  5. Holding and PI split into offensive vs defensive using possession from pbp.
"""
import re
import pandas as pd

PKG = "/home/claude/cfbin/cfb_refs/"
FRESH = "/home/claude/cfbfresh/"
OUT = "/home/claude/refs/cfb_out/"
import os; os.makedirs(OUT, exist_ok=True)

key = lambda s: re.sub(r"[^a-z]", "", str(s).lower())
log = []

# ---------- 2. alias map (minority spelling -> canonical) ----------
ALIASES = {
    "adamsavioe": "adamsavoie", "adamsavole": "adamsavoie",
    "andrewspaciale": "andrewspeciale", "brianbanks": "bryanbanks", "calmcneil": "calmcneill",
    "carvonnebarrett": "cravonnebarrett", "chiscoyte": "chriscoyte", "chriscoyle": "chriscoyte",
    "danieldautreaux": "danielgautreaux", "davidgautreaux": "danielgautreaux",
    "darrylberry": "darryldeberry", "darryldebarry": "darryldeberry",
    "garypeterson": "garypatterson", "grayreed": "garyreed", "gregblum": "gregoryblum",
    "hankjohns": "henryjohns", "henryjones": "henryjohns",
    "jasconautrey": "jasonautrey", "jasonautry": "jasonautrey",
    "jasonnickelby": "jasonnickleby", "jasonnicklebys": "jasonnickleby",
    "jeffreyservinski": "jeffservinski", "jeremetate": "jeremeetate",
    "jerrymaygallanes": "jerrymagallanes", "johnnoli": "jonnoli", "jonnoll": "jonnoli", "jonnooli": "jonnoli",
    "justinelliot": "justinelliott", "kevinrandle": "kevinrandall", "kyleolsom": "kyleolson",
    "leehendrick": "leehedrick", "marcelkeer": "marcelkerr", "markklucyznski": "markkluczynski",
    "mathewrichards": "matthewrichards", "mattloeffier": "mattloeffler", "michaelmccabe": "mikemccabe",
    "michaelvandervede": "michaelvandervelde", "michaelvanderveld": "michaelvandervelde",
    "mikevandervelde": "michaelvandervelde", "nateblake": "nateblack", "rickwayne": "rickwarne",
    "rileyjophnson": "rileyjohnson", "rodneyburnett": "rodneyburnette",
    "rodsnodgrass": "ronsnodgrass", "ronsnodrass": "ronsnodgrass", "roybernard": "rorybernard",
    "stepenbaron": "stephenbaron", "stephenbarron": "stephenbaron", "stephonbaron": "stephenbaron",
    "steveanderson": "stevenanderson", "stevemarlow": "stevemarlowe", "teddpitts": "tedpitts",
    "timhedfepeth": "timhedgepeth", "timhedgepath": "timhedgepeth",
    "tutasalaam": "tutashindasalaam", "tutashinasalaam": "tutashindasalaam",
    "waynewinker": "waynewinkler",
}
canon = lambda k: ALIASES.get(k, k)

g = pd.read_csv(PKG + "data/games.csv")
g["day"] = (pd.to_datetime(g.start_date) - pd.Timedelta(hours=6)).dt.date
g["referee_id"] = g.official_id.map(lambda k: canon(k) if pd.notna(k) else None)
g["referee_source"] = g.official_id.map(lambda k: "ncaa_listed" if pd.notna(k) else None)
for k in g.official_id.dropna().unique():
    if canon(k) != k:
        log.append(dict(step="alias_merge", detail=f"{k} -> {canon(k)}",
                        games=int((g.official_id == k).sum())))

# ---------- 3. unmatched NCAA officials -> ESPN games ----------
cand = pd.read_csv("/home/claude/refs/unmatched_candidates.csv")
cand = cand[(cand.score >= 2) & cand.game_id.notna()]
cand = cand[~cand.game_id.duplicated(keep=False)]
for _, r in cand.iterrows():
    gid = int(r.game_id)
    i = g.index[g.game_id == gid]
    if len(i) and pd.isna(g.loc[i[0], "referee_id"]):
        g.loc[i[0], ["referee_id", "referee_source", "listed_official"]] = [canon(key(r.official)), "ncaa_matched_by_date_teams", r.official]
        log.append(dict(step="unmatched_fill", detail=f"{r.official} -> {gid} ({r.match})", games=1))

# canonical display name = most common spelling for that id
disp = (g.dropna(subset=["referee_id"]).groupby("referee_id").listed_official
        .agg(lambda s: re.sub(r"\s+", " ", s.value_counts().index[0]).strip()))
g["referee"] = g.referee_id.map(disp)

# primary conference per ref (conference games only)
cg = g[g.referee_id.notna() & (g.home_conference == g.away_conference)]
prim = cg.groupby("referee_id").home_conference.agg(lambda s: s.value_counts().index[0])

# ---------- 4. same-day double assignments ----------
dup = g[g.referee_id.notna()].groupby(["referee_id", "day"]).game_id.apply(list)
dup = dup[dup.map(len) > 1]
g["assignment_conflict"] = False
for (rid, day), gids in dup.items():
    pc = prim.get(rid)
    rows = g[g.game_id.isin(gids)]
    keep = rows[(rows.home_conference == pc) | (rows.away_conference == pc)].game_id.tolist()
    if len(keep) == 1:
        drop = [x for x in gids if x != keep[0]]
        msg = f"kept {keep[0]} (matches {pc})"
    else:
        drop = gids
        msg = "ambiguous, nulled all"
    g.loc[g.game_id.isin(drop), ["referee_id", "referee", "referee_source"]] = None
    g.loc[g.game_id.isin(drop), "assignment_conflict"] = True
    log.append(dict(step="same_day_conflict", detail=f"{rid} {day}: {gids} {msg}", games=len(drop)))

# ---------- 5. off/def split for holding and PI ----------
pp = pd.read_csv(PKG + "data/penalty_plays.csv",
                 usecols=["game_id", "id", "text", "penalty_team_id", "penalty_side", "penalty_detail",
                          "holding_not_declined_or_offset_play", "pass_interference_mention_play",
                          "penalty_declined", "penalty_offset"])
pos = []
for y in (2024, 2025, 2026):
    p = pd.read_parquet(FRESH + f"pbp{y}.parquet", columns=["id", "start.pos_team.id", "start.def_pos_team.id"])
    pos.append(p)
pos = pd.concat(pos).drop_duplicates("id")
pos["id"] = pos["id"].astype("int64")
pp["id"] = pp["id"].astype("int64")
pp = pp.merge(pos, on="id", how="left")
txt = pp.text.fillna("").str.lower()
det = pp.penalty_detail.fillna("").str.lower()
side = pp.penalty_side.copy()
side = side.where(side.notna(), pd.Series(pd.NA, index=pp.index))
by_pos = pd.Series(pd.NA, index=pp.index, dtype="object")
pt = pd.to_numeric(pp.penalty_team_id, errors="coerce")
by_pos[pt == pd.to_numeric(pp["start.pos_team.id"], errors="coerce")] = "off"
by_pos[pt == pd.to_numeric(pp["start.def_pos_team.id"], errors="coerce")] = "def"
by_txt = pd.Series(pd.NA, index=pp.index, dtype="object")
by_txt[txt.str.contains("offensive holding") | det.str.contains("offensive holding")] = "off"
by_txt[txt.str.contains("defensive holding") | det.str.contains("defensive holding")] = "def"
pp["side"] = by_txt.fillna(side).fillna(by_pos)
live = ~(pp.penalty_declined.fillna(False).astype(bool) | pp.penalty_offset.fillna(False).astype(bool))
hold = pp.holding_not_declined_or_offset_play.fillna(False).astype(bool)
pi = pp.pass_interference_mention_play.fillna(False).astype(bool) & live
opi_txt = txt.str.contains("offensive pass interference")
agg = pd.DataFrame({
    "game_id": pp.game_id,
    "off_holding": hold & (pp.side == "off"),
    "def_holding": hold & (pp.side == "def"),
    "holding_side_unknown": hold & pp.side.isna(),
    "opi": pi & ((pp.side == "off") | opi_txt),
    "dpi": pi & (pp.side == "def") & ~opi_txt,
}).groupby("game_id").sum().astype(int).reset_index()
log.append(dict(step="holding_split",
                detail=f"holding plays {int(hold.sum())}: off {int(agg.off_holding.sum())}, "
                       f"def {int(agg.def_holding.sum())}, unknown {int(agg.holding_side_unknown.sum())}",
                games=0))

g = g.merge(agg, on="game_id", how="left")
pbp_ok = g.pbp_available.astype(bool)
for c in ["off_holding", "def_holding", "holding_side_unknown", "opi", "dpi"]:
    g[c] = g[c].where(~pbp_ok | g[c].notna(), 0)
    g.loc[~pbp_ok, c] = pd.NA
g["referee_primary_conf"] = g.referee_id.map(prim)
g["referee_identity"] = g.referee_id.map(lambda x: "inferred_crew_chief" if pd.notna(x) else None)

# ---------- outputs ----------
games = g.rename(columns={
    "total_accepted_penalties": "flags", "total_penalty_yards": "penalty_yards",
    "home_accepted_penalties": "home_flags", "away_accepted_penalties": "away_flags",
    "holding_not_declined_or_offset_plays": "holding_total",
    "false_start_mention_plays": "false_start", "accepted_penalties_per_100_scrimmage_plays": "flags_per_100_plays",
})
cols = ["game_id", "season", "week", "start_date", "neutral_site", "home_team", "away_team",
        "home_conference", "away_conference", "home_points", "away_points",
        "referee_id", "referee", "referee_primary_conf", "referee_source", "referee_identity", "assignment_conflict",
        "flags", "penalty_yards", "home_flags", "away_flags", "home_penalty_yards", "away_penalty_yards",
        "holding_total", "off_holding", "def_holding", "holding_side_unknown", "dpi", "opi", "false_start",
        "scrimmage_plays", "flags_per_100_plays", "pbp_available", "source_url"]
games = games[cols].sort_values(["season", "start_date"])
games.to_csv(OUT + "cfb_ref_game_penalties.csv", index=False)

M = ["flags", "penalty_yards", "holding_total", "off_holding", "def_holding", "dpi", "false_start", "home_flags", "away_flags"]


def summarize(df, label):
    df = df[df.referee_id.notna()]
    grp = df.groupby("referee_id")
    s = grp[M].mean().round(2).add_suffix("_pg")
    s.insert(0, "games", grp.size())
    s.insert(0, "referee", grp.referee.first())
    s.insert(1, "primary_conf", s.index.map(prim))
    s["pbp_games"] = grp.pbp_available.sum().astype(int)
    s["flags_per_100_plays"] = (100 * grp["flags"].sum() / grp.scrimmage_plays.sum()).round(2)
    s["home_minus_away_pg"] = (s.home_flags_pg - s.away_flags_pg).round(2)
    fbs = df[M].mean()
    s["flags_vs_fbs_pg"] = (s.flags_pg - fbs["flags"]).round(2)
    s["holding_vs_fbs_pg"] = (s.holding_total_pg - fbs["holding_total"]).round(2)
    conf_games = df[df.home_conference == df.away_conference]
    cavg = conf_games.groupby("home_conference")[["flags", "holding_total"]].mean()
    s["flags_vs_conf_pg"] = (s.flags_pg - s.primary_conf.map(cavg["flags"])).round(2)
    s["holding_vs_conf_pg"] = (s.holding_total_pg - s.primary_conf.map(cavg["holding_total"])).round(2)
    s["flags_rank_in_conf"] = s.groupby("primary_conf").flags_pg.rank(ascending=False, method="min")
    s.insert(0, "window", label)
    return s.reset_index().sort_values("flags_pg", ascending=False)


summ = pd.concat([summarize(games[games.season == y], str(y)) for y in (2026, 2025, 2024)]
                 + [summarize(games, "2024-2026")])
summ.to_csv(OUT + "cfb_ref_summary.csv", index=False)

conf = games[games.home_conference == games.away_conference].groupby(["season", "home_conference"]).agg(
    games=("game_id", "size"), flags_pg=("flags", "mean"), holding_pg=("holding_total", "mean"),
    ref_coverage=("referee_id", lambda x: round(100 * x.notna().mean(), 1))).round(2).reset_index()
conf.to_csv(OUT + "cfb_conference_baselines.csv", index=False)

pd.DataFrame(log).to_csv(OUT + "fill_log.csv", index=False)

cov = games.groupby("season").agg(games=("game_id", "size"), with_ref=("referee_id", lambda x: x.notna().sum()))
print(cov, "\n", pd.DataFrame(log).step.value_counts())
print("distinct refs:", games.referee_id.nunique())
print([l for l in log if l["step"] == "holding_split"])
print(summ[summ.window == "2026"].head(15)[["referee", "primary_conf", "games", "flags_pg", "holding_total_pg",
                                            "off_holding_pg", "flags_vs_conf_pg", "holding_vs_conf_pg"]].to_string(index=False))
