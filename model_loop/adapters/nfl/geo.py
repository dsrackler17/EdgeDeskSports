"""Where each club is based, season by season, and where each game is
played: the inputs to the travel, time-zone and body-clock components.

Current venues come from football/venues/nfl_stadiums.json (hand-entered,
verified). Relocated clubs' earlier homes are the only coordinates added
here, each a stadium location to four decimals; a club's base is its home
stadium, so travel is stadium to stadium. A neutral or international game
is located by its stadium name; a name that cannot be resolved leaves the
travel inputs at zero and is counted in the build report, never guessed.
"""
import json
import math
import os
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
STADIUMS = os.path.join(ROOT, "football", "venues", "nfl_stadiums.json")

# (franchise, first season, last season) -> (lat, lon, tz): homes no longer in the current table
RELOCATED = [
    ("LA", 1995, 2015, (38.6328, -90.1885, "America/Chicago")),      # Edward Jones Dome, St. Louis
    ("LA", 2016, 2019, (34.0141, -118.2879, "America/Los_Angeles")), # LA Memorial Coliseum
    ("LAC", 1967, 2016, (32.7831, -117.1196, "America/Los_Angeles")),# Qualcomm Stadium, San Diego
    ("LAC", 2017, 2019, (33.8644, -118.2611, "America/Los_Angeles")),# StubHub Center, Carson
    ("LV", 1995, 2019, (37.7516, -122.2005, "America/Los_Angeles")), # Oakland Coliseum
]
# stadium names in the schedule feed that the current table carries under another name
ALIASES = {
    "dolphin stadium": "hard rock stadium", "sun life stadium": "hard rock stadium",
    "tiaa bank stadium": "everbank stadium", "university of phoenix stadium": "state farm stadium",
    "cowboys stadium": "at&t stadium", "firstenergy stadium": "huntington bank field",
    "mercedes-benz superdome": "caesars superdome", "estadio banorte": "estadio azteca",
    "azteca stadium": "estadio azteca", "fc bayern munich stadium": "allianz arena",
    "bernabeu": "santiago bernabeu", "arena corinthians": "neo quimica arena",
    "tottenham stadium": "tottenham hotspur stadium",
}
# neutral venues not in the table at all (stadium coordinates)
EXTRA_VENUES = {
    "twickenham stadium": (51.4559, -0.3415, "Europe/London"),
    "stade de france": (48.9245, 2.3602, "Europe/Paris"),
    "rogers centre": (43.6414, -79.3894, "America/Toronto"),
}


def _load():
    with open(STADIUMS) as f:
        j = json.load(f)
    by_name, by_club = {}, {}
    for s in j["stadiums"]:
        rec = (s["lat"], s["lon"], s["tz_name"])
        for n in [s["name"]] + list(s.get("aliases") or []):
            by_name[n.lower()] = rec
        if s.get("club"):
            by_club[s["club"]] = rec
    by_club.setdefault("NYG", by_club.get("NYJ"))      # shared stadium
    by_club.setdefault("LA", by_name.get("sofi stadium"))
    return by_name, by_club


BY_NAME, BY_CLUB = _load()


def base(team, season):
    for fr, a, b, rec in RELOCATED:
        if fr == team and a <= season <= b:
            return rec
    return BY_CLUB.get(team)


def venue(stadium):
    if not isinstance(stadium, str):
        return None
    n = stadium.lower().strip()
    n = ALIASES.get(n, n)
    return BY_NAME.get(n) or EXTRA_VENUES.get(n)


def miles(a, b):
    if not a or not b:
        return 0.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def utc_offset_hours(tz, when):
    if not tz or when is None:
        return 0.0
    return ZoneInfo(tz).utcoffset(when).total_seconds() / 3600.0


def game_geo(g):
    """Travel and clock inputs for one schedule row (home/away franchise
    codes, season, neutral, stadium, kick_et as a naive Eastern datetime)."""
    hb, ab = base(g["home"], g["season"]), base(g["away"], g["season"])
    v = venue(g.get("stadium")) if g.get("neutral") else hb
    resolved = bool(v and hb and ab)
    if not resolved:
        return {"home_miles": 0.0, "away_miles": 0.0, "home_tz": 0.0, "away_tz": 0.0,
                "home_body": 0, "away_body": 0, "geo_resolved": False}
    kick = g.get("kick_et")
    when = None
    if kick is not None and not (isinstance(kick, float) and math.isnan(kick)):
        when = kick.to_pydatetime() if hasattr(kick, "to_pydatetime") else kick
        when = when.replace(tzinfo=ZoneInfo("America/New_York"))
    v_off = utc_offset_hours(v[2], when)
    def side(b):
        shift = v_off - utc_offset_hours(b[2], when)        # + = travelled east
        body = 0
        if when is not None:
            local_body = when.astimezone(ZoneInfo(b[2])).hour
            body = 1 if local_body < 11 else 0               # kickoff before 11:00 on the body clock
        return miles(b, v), shift, body
    hm, ht, hbody = side(hb)
    am, at, abody = side(ab)
    return {"home_miles": hm, "away_miles": am, "home_tz": ht, "away_tz": at,
            "home_body": hbody, "away_body": abody, "geo_resolved": True}
