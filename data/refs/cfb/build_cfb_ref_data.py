"""Build CFB referee flag datasets for EdgeDesk from ESPN's public JSON.

Usage:
  python build_cfb_ref_data.py --seasons 2024 2025 2026            # full backfill
  python build_cfb_ref_data.py --seasons 2026 --weeks 8            # weekly update
  python build_cfb_ref_data.py --seasons 2026 --upcoming 9         # next week's assigned refs (if ESPN has them)

Outputs (in --out, default ./out):
  cfb_ref_game_penalties.csv   one row per completed FBS game
  cfb_ref_assignments.csv      game -> referee (completed + upcoming)
  cfb_ref_summary.csv          per-ref averages: season and 3-yr, vs overall and vs conference avg
  cfb_coverage.csv             % of games per season/week with a referee found (watch this)

Raw ESPN JSON is cached in ./cache so reruns don't refetch completed games.
"""
import argparse, json, os, re, time
from pathlib import Path

import pandas as pd
import requests

BASE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
HDRS = {"User-Agent": "Mozilla/5.0 EdgeDeskSports ref-sync"}
CACHE = Path("cache")
CACHE.mkdir(exist_ok=True)

HOLD_RE = re.compile(r"\bholding\b", re.I)
OFF_HOLD_RE = re.compile(r"offensive holding", re.I)
DEF_HOLD_RE = re.compile(r"defensive holding", re.I)
DPI_RE = re.compile(r"(defensive )?pass interference", re.I)
OPI_RE = re.compile(r"offensive pass interference", re.I)
FALSE_START_RE = re.compile(r"false start", re.I)
TARGETING_RE = re.compile(r"targeting", re.I)
PEN_RE = re.compile(r"penalty", re.I)
DECLINED_RE = re.compile(r"declined|offsetting", re.I)


def get(url, params=None, cache_key=None, tries=4):
    if cache_key and (CACHE / cache_key).exists():
        return json.loads((CACHE / cache_key).read_text())
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=HDRS, timeout=30)
            if r.status_code == 200:
                data = r.json()
                if cache_key:
                    (CACHE / cache_key).write_text(json.dumps(data))
                time.sleep(0.25)
                return data
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"ESPN request failed: {url} {params}")


def scoreboard(season, week, seasontype=2):
    return get(f"{BASE}/scoreboard",
               {"dates": season, "seasontype": seasontype, "week": week, "groups": 80, "limit": 400})


def find_referee(summary):
    officials = (summary.get("gameInfo") or {}).get("officials") or []
    crew = []
    ref = None
    for o in officials:
        name = o.get("displayName") or o.get("fullName")
        pos = ((o.get("position") or {}).get("displayName") or (o.get("position") or {}).get("name") or "")
        crew.append(f"{pos}:{name}")
        if pos.lower() == "referee" and name:
            ref = name.strip()
    return ref, "|".join(crew)


def parse_box_penalties(summary):
    """Returns {team_id: (flags, yards)} from box score 'totalPenaltiesYards' ('7-55')."""
    out = {}
    for t in (summary.get("boxscore") or {}).get("teams", []):
        tid = str((t.get("team") or {}).get("id"))
        for s in t.get("statistics", []):
            if s.get("name") == "totalPenaltiesYards":
                m = re.match(r"\s*(\d+)\s*-\s*(-?\d+)", s.get("displayValue", ""))
                if m:
                    out[tid] = (int(m.group(1)), int(m.group(2)))
    return out


def parse_play_penalties(summary):
    counts = dict(holding_total=0, off_holding=0, def_holding=0, dpi=0, opi=0, false_start=0,
                  targeting=0, pbp_penalty_plays=0, plays=0)
    drives = ((summary.get("drives") or {}).get("previous")) or []
    for d in drives:
        for p in d.get("plays", []):
            counts["plays"] += 1
            text = p.get("text") or ""
            ptype = ((p.get("type") or {}).get("text")) or ""
            if not (PEN_RE.search(text) or "penalty" in ptype.lower()):
                continue
            if DECLINED_RE.search(text):
                continue
            counts["pbp_penalty_plays"] += 1
            if HOLD_RE.search(text):
                counts["holding_total"] += 1
                if OFF_HOLD_RE.search(text):
                    counts["off_holding"] += 1
                elif DEF_HOLD_RE.search(text):
                    counts["def_holding"] += 1
            if OPI_RE.search(text):
                counts["opi"] += 1
            elif DPI_RE.search(text):
                counts["dpi"] += 1
            if FALSE_START_RE.search(text):
                counts["false_start"] += 1
            if TARGETING_RE.search(text):
                counts["targeting"] += 1
    return counts


def total_line(summary):
    for pc in summary.get("pickcenter") or []:
        if pc.get("overUnder") is not None:
            return pc.get("overUnder"), pc.get("spread")
    return None, None


def game_rows(season, week):
    sb = scoreboard(season, week)
    if not sb:
        return [], []
    done, upcoming = [], []
    for ev in sb.get("events", []):
        comp = ev["competitions"][0]
        teams = {c["homeAway"]: c for c in comp["competitors"]}
        home, away = teams.get("home"), teams.get("away")
        if not home or not away:
            continue
        base = {
            "espn_id": ev["id"], "season": season, "week": week,
            "gameday": ev.get("date", "")[:10],
            "neutral_site": bool(comp.get("neutralSite")),
            "conference_game": bool(comp.get("conferenceCompetition")),
            "home_team": home["team"].get("abbreviation"), "away_team": away["team"].get("abbreviation"),
            "home_team_id": str(home["team"]["id"]), "away_team_id": str(away["team"]["id"]),
            "home_conf_id": str(home["team"].get("conferenceId") or ""),
            "away_conf_id": str(away["team"].get("conferenceId") or ""),
        }
        completed = ((ev.get("status") or {}).get("type") or {}).get("completed")
        # cache completed games forever; always refetch upcoming
        summary = get(f"{BASE}/summary", {"event": ev["id"]},
                      cache_key=f"sum_{ev['id']}.json" if completed else None)
        if not summary:
            continue
        ref, crew = find_referee(summary)
        base.update(referee=ref, crew=crew)
        if not completed:
            upcoming.append(base)
            continue
        box = parse_box_penalties(summary)
        hf, hy = box.get(base["home_team_id"], (None, None))
        af, ay = box.get(base["away_team_id"], (None, None))
        ou, spread = total_line(summary)
        hs, as_ = int(home.get("score") or 0), int(away.get("score") or 0)
        row = dict(base, home_score=hs, away_score=as_, total=hs + as_, total_line=ou, spread_text=spread,
                   home_flags=hf, away_flags=af, home_pen_yards=hy, away_pen_yards=ay)
        row.update(parse_play_penalties(summary))
        done.append(row)
    return done, upcoming


METRICS = ["flags", "penalty_yards", "holding_total", "off_holding", "def_holding", "dpi", "opi",
           "false_start", "targeting", "home_flags", "away_flags"]


def summarize(df, label):
    df = df[df.referee.notna() & df["flags"].notna()]
    if df.empty:
        return pd.DataFrame()
    g = df.groupby("referee")
    s = g[METRICS].mean().round(2).add_suffix("_pg")
    s.insert(0, "games", g.size())
    s["primary_conf_id"] = g.home_conf_id.agg(lambda x: x.mode().iat[0] if not x.mode().empty else "")
    s["flags_per_100_plays"] = (100 * g["flags"].sum() / g["plays"].sum().replace(0, pd.NA)).round(2)
    s["home_minus_away_pg"] = (s.home_flags_pg - s.away_flags_pg).round(2)
    ou = df.dropna(subset=["went_over"]).groupby("referee").went_over
    s["overs"] = ou.sum()
    s["unders"] = ou.count() - ou.sum()
    lg = df[METRICS].mean()
    s["flags_vs_fbs_pg"] = (s.flags_pg - lg["flags"]).round(2)
    s["holding_vs_fbs_pg"] = (s.holding_total_pg - lg["holding_total"]).round(2)
    conf = df.groupby("home_conf_id")[["flags", "holding_total"]].mean()
    s["flags_vs_conf_pg"] = (s.flags_pg - s.primary_conf_id.map(conf["flags"])).round(2)
    s["holding_vs_conf_pg"] = (s.holding_total_pg - s.primary_conf_id.map(conf["holding_total"])).round(2)
    s.insert(0, "window", label)
    return s.reset_index().sort_values("flags_pg", ascending=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", type=int, nargs="+", required=True)
    ap.add_argument("--weeks", type=int, nargs="*", default=list(range(0, 17)))
    ap.add_argument("--upcoming", type=int, default=None, help="week number to pull assignments for")
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(exist_ok=True)

    done, upcoming = [], []
    for s in a.seasons:
        for w in a.weeks:
            d, u = game_rows(s, w)
            done += d; upcoming += u
            print(f"{s} wk{w}: {len(d)} final, {sum(r['referee'] is not None for r in d)} with ref")
        if a.upcoming is not None:
            _, u = game_rows(s, a.upcoming)
            upcoming += u

    pg = pd.DataFrame(done)
    if pg.empty:
        raise SystemExit("No games pulled")
    # merge with existing file so weekly runs append instead of overwrite
    f = out / "cfb_ref_game_penalties.csv"
    if f.exists():
        old = pd.read_csv(f, dtype={"espn_id": str, "home_team_id": str, "away_team_id": str,
                                    "home_conf_id": str, "away_conf_id": str})
        pg = pd.concat([old[~old.espn_id.isin(pg.espn_id)], pg])
    pg["flags"] = pg.home_flags + pg.away_flags
    pg["penalty_yards"] = pg.home_pen_yards + pg.away_pen_yards
    pg["flags_per_100_plays"] = (100 * pg["flags"] / pg["plays"].replace(0, pd.NA)).round(2)
    pg["went_over"] = (pg.total > pg.total_line).astype("Int64").where(pg.total_line.notna() & (pg.total != pg.total_line))
    pg = pg.sort_values(["season", "week", "espn_id"])
    pg.to_csv(f, index=False)

    cov = pg.groupby(["season", "week"]).agg(games=("espn_id", "size"),
                                             with_ref=("referee", lambda x: x.notna().sum()),
                                             with_box=("flags", lambda x: x.notna().sum()))
    cov["ref_coverage_pct"] = (100 * cov.with_ref / cov.games).round(1)
    cov.to_csv(out / "cfb_coverage.csv")

    seasons = sorted(pg.season.unique())
    parts = [summarize(pg[pg.season == s], str(s)) for s in seasons]
    parts.append(summarize(pg[pg.season > max(seasons) - 3], f"{max(seasons)-2}-{max(seasons)}"))
    pd.concat(parts).to_csv(out / "cfb_ref_summary.csv", index=False)

    asg = pd.concat([pg[["espn_id", "season", "week", "home_team", "away_team", "referee", "crew"]],
                     pd.DataFrame(upcoming, columns=["espn_id", "season", "week", "home_team", "away_team", "referee", "crew"])]
                    ).drop_duplicates("espn_id", keep="last")
    asg.to_csv(out / "cfb_ref_assignments.csv", index=False)

    print(cov.tail(20).to_string())
    print(f"{len(pg)} games, {pg.referee.notna().mean():.1%} with referee, "
          f"{pg.referee.nunique()} distinct referees")


if __name__ == "__main__":
    main()
