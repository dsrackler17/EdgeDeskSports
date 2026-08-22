#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — shared loaders and canonical identity.

Every other script in this pipeline reads its data through here, so there is
exactly ONE definition of: what a team is called, which conference it was in
during a given season, which games count, and where a venue is.

Two facts established by execution (see research/README.md, "Data traps"):

1. `team_info/*.parquet` carries a CURRENT-SNAPSHOT conference for every
   season: the 2014 file lists the 2024 realignment (Big Ten 18, ACC 17).
   It is therefore USELESS as a historical membership source and is used
   here ONLY for venue geography. Season-accurate membership comes from the
   schedules' own `home_conference`/`away_conference`, which do reflect
   realignment (2024: Oregon/UCLA/USC/Washington in the Big Ten;
   California/SMU/Stanford in the ACC; Pac-12 down to 2 teams).

2. "Power 4" is a 2024+ construct. Before 2024 the peer set is the Power 5
   (the same four plus the Pac-12). The pipeline models the whole FBS graph
   because opponent adjustment needs it, but every power-tier feature is
   resolved per season rather than assumed.
"""
import os
import re
import glob
import functools

import numpy as np
import pandas as pd

DATA = os.environ.get('CFB_P4_DATA', 'data')

P4 = ('SEC', 'Big Ten', 'Big 12', 'ACC')
P5 = P4 + ('Pac-12',)
P4_ERA_FIRST_SEASON = 2024          # the season the Pac-12 stopped being a peer

SCHED_FIRST, SCHED_LAST = 2001, 2025
ROSTER_FIRST = 2004
PSTATS_FIRST = 2014
BETTING_FIRST = 2006
PBP_FIRST, PBP_LAST = 2002, 2022


# --------------------------------------------------------------------------
# identity
# --------------------------------------------------------------------------
_NON_ALNUM = re.compile(r'[^a-z0-9]+')


def norm(name):
    """Canonical team key. Deliberately aggressive: 'San José State' and
    'San Jose State' and 'SAN JOSE ST.' must collide, because they are the
    same football team in three different feeds."""
    if name is None or (isinstance(name, float) and np.isnan(name)):
        return None
    s = str(name).strip().lower()
    s = (s.replace('é', 'e').replace('í', 'i').replace('á', 'a')
           .replace('ó', 'o').replace('ú', 'u').replace('ñ', 'n')
           .replace('’', "'").replace('‘', "'"))
    s = _NON_ALNUM.sub('', s)
    return s or None


# --------------------------------------------------------------------------
# schedules  (the spine: results, venue, neutrality, season-accurate conf)
# --------------------------------------------------------------------------
@functools.lru_cache(maxsize=1)
def load_schedules(lo=SCHED_FIRST, hi=SCHED_LAST):
    """One row per game, 2001-2025, all divisions. Nothing is dropped here —
    filtering is each caller's decision and must be visible at the call site."""
    frames = []
    for y in range(lo, hi + 1):
        p = os.path.join(DATA, 'sched', 'sched_%d.csv' % y)
        if not os.path.exists(p):
            continue
        frames.append(pd.read_csv(p, low_memory=False))
    if not frames:
        raise SystemExit('no schedules under %s/sched — run fetch_data.sh first' % DATA)
    g = pd.concat(frames, ignore_index=True)

    for c in ('season', 'week', 'home_points', 'away_points', 'attendance',
              'venue_id', 'home_id', 'away_id',
              'home_pregame_elo', 'away_pregame_elo', 'excitement_index'):
        if c in g.columns:
            g[c] = pd.to_numeric(g[c], errors='coerce')

    g['kick_dt'] = pd.to_datetime(g['start_date'], errors='coerce', utc=True)
    g['neutral'] = g['neutral_site'].astype(str).str.upper().eq('TRUE')
    g['conf_game'] = g['conference_game'].astype(str).str.upper().eq('TRUE')
    g['completed_b'] = g['completed'].astype(str).str.upper().eq('TRUE')

    g['home_key'] = g['home_team'].map(norm)
    g['away_key'] = g['away_team'].map(norm)
    g['home_fbs'] = g['home_division'].eq('fbs')
    g['away_fbs'] = g['away_division'].eq('fbs')

    g['played'] = g['completed_b'] & g['home_points'].notna() & g['away_points'].notna()
    g['margin'] = g['home_points'] - g['away_points']          # home perspective
    g['total_pts'] = g['home_points'] + g['away_points']

    g = g.sort_values(['kick_dt', 'game_id'], kind='mergesort').reset_index(drop=True)
    return g


@functools.lru_cache(maxsize=1)
def conference_by_season():
    """(season, team_key) -> conference, division. Season-accurate, derived
    from the schedules themselves. A team's conference for a season is its
    modal conference across that season's games, which is robust to the
    occasional mislabelled row."""
    g = load_schedules()
    a = pd.concat([
        g[['season', 'home_key', 'home_team', 'home_conference', 'home_division']]
          .rename(columns={'home_key': 'team_key', 'home_team': 'team',
                           'home_conference': 'conference', 'home_division': 'division'}),
        g[['season', 'away_key', 'away_team', 'away_conference', 'away_division']]
          .rename(columns={'away_key': 'team_key', 'away_team': 'team',
                           'away_conference': 'conference', 'away_division': 'division'}),
    ], ignore_index=True)
    a = a.dropna(subset=['team_key'])

    def modal(s):
        s = s.dropna()
        return s.mode().iat[0] if len(s) else None

    out = (a.groupby(['season', 'team_key'])
             .agg(team=('team', modal), conference=('conference', modal),
                  division=('division', modal))
             .reset_index())
    return out


def power_tier(season, conference):
    """'P4' | 'P5_PAC' | 'G5' | 'FCS' | None.

    P4 means the four conferences the model is built for, in any season.
    P5_PAC marks pre-2024 Pac-12 teams: peers of the P4 at the time, kept
    distinct so no feature silently claims the 2014 Pac-12 was a G5 league.
    """
    if conference is None or (isinstance(conference, float) and np.isnan(conference)):
        return None
    if conference in P4:
        return 'P4'
    if conference == 'Pac-12':
        return 'P5_PAC' if season < P4_ERA_FIRST_SEASON else 'G5'
    return 'G5'


@functools.lru_cache(maxsize=1)
def p4_membership():
    """(season, team_key) rows for the four modelled conferences only."""
    c = conference_by_season()
    c = c[c.division.eq('fbs') & c.conference.isin(P4)].copy()
    return c.reset_index(drop=True)


# --------------------------------------------------------------------------
# venues
# --------------------------------------------------------------------------
@functools.lru_cache(maxsize=1)
def venue_geo():
    """venue_id -> lat, lon, elevation_m, capacity, grass, dome, timezone.

    Source is team_info, which is a CURRENT snapshot: it maps each team to
    the home venue it uses NOW. That is exactly right for projecting today's
    games and only approximately right for 2003 — so `snapshot_season` ships
    with the table and the venue-HFA fit keys on the schedules' own
    per-game `venue_id`, never on this table's team->venue mapping.

    Neutral sites and defunct stadiums are absent by construction; callers
    must handle a missing venue_id as UNKNOWN rather than substituting a
    league default without saying so.
    """
    rows = []
    for p in sorted(glob.glob(os.path.join(DATA, 'teaminfo', 'ti_*.parquet'))):
        y = int(re.search(r'ti_(\d{4})', p).group(1))
        d = pd.read_parquet(p)
        d['snapshot_season'] = y
        rows.append(d)
    if not rows:
        return pd.DataFrame()
    t = pd.concat(rows, ignore_index=True)
    t = t[t.venue_id.notna()].copy()
    t['venue_id'] = pd.to_numeric(t.venue_id, errors='coerce')
    for c in ('latitude', 'longitude', 'elevation', 'capacity', 'year_constructed'):
        t[c] = pd.to_numeric(t[c], errors='coerce')
    # keep the most recent snapshot per venue
    t = t.sort_values('snapshot_season').groupby('venue_id', as_index=False).last()
    t['team_key'] = t['school'].map(norm)
    return t[['venue_id', 'venue_name', 'city', 'state', 'timezone', 'latitude',
              'longitude', 'elevation', 'capacity', 'year_constructed', 'grass',
              'dome', 'team_key', 'school', 'snapshot_season']]


def haversine_miles(lat1, lon1, lat2, lon2):
    """Great-circle miles. Vectorised; NaN in -> NaN out (never 0, which
    would read as 'no travel')."""
    r = 3958.7613
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2, dtype=float) - np.asarray(lon1, dtype=float))
    a = np.sin(dp / 2.0) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2.0) ** 2
    return 2 * r * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


TZ_OFFSET = {                       # standard-time UTC offsets, hours
    'America/New_York': -5, 'America/Detroit': -5, 'America/Indiana/Indianapolis': -5,
    'America/Kentucky/Louisville': -5, 'America/Toronto': -5,
    'America/Chicago': -6, 'America/Winnipeg': -6, 'America/Menominee': -6,
    'America/North_Dakota/Center': -6,
    'America/Denver': -7, 'America/Boise': -7, 'America/Phoenix': -7,
    'America/Edmonton': -7,
    'America/Los_Angeles': -8, 'America/Vancouver': -8,
    'America/Anchorage': -9, 'Pacific/Honolulu': -10,
}


def tz_hours(tz):
    """UTC offset in hours for a venue timezone, or None. Standard time is
    used deliberately: the quantity that matters is the body-clock gap
    between two campuses, and DST shifts both ends together."""
    if tz is None or (isinstance(tz, float) and np.isnan(tz)):
        return None
    return TZ_OFFSET.get(str(tz))


# --------------------------------------------------------------------------
# game universe
# --------------------------------------------------------------------------
def fbs_games(lo=SCHED_FIRST, hi=SCHED_LAST, both=True, played_only=True):
    """FBS game universe. `both=True` keeps FBS-vs-FBS only (the games any
    market prices and the only ones with two rated sides); `both=False`
    keeps games where at least one side is FBS, which the rating recursion
    needs so that FCS results are not silently discarded."""
    g = load_schedules()
    g = g[(g.season >= lo) & (g.season <= hi)]
    g = g[(g.home_fbs & g.away_fbs) if both else (g.home_fbs | g.away_fbs)]
    if played_only:
        g = g[g.played]
    return g.reset_index(drop=True)


def attach_conferences(g):
    """Add home/away conference + power tier, season-accurately."""
    c = conference_by_season()[['season', 'team_key', 'conference']]
    g = g.merge(c.rename(columns={'team_key': 'home_key', 'conference': 'home_conf'}),
                on=['season', 'home_key'], how='left')
    g = g.merge(c.rename(columns={'team_key': 'away_key', 'conference': 'away_conf'}),
                on=['season', 'away_key'], how='left')
    g['home_tier'] = [power_tier(s, c) for s, c in zip(g.season, g.home_conf)]
    g['away_tier'] = [power_tier(s, c) for s, c in zip(g.season, g.away_conf)]
    g['p4_game'] = g.home_conf.isin(P4) | g.away_conf.isin(P4)
    g['p4_v_p4'] = g.home_conf.isin(P4) & g.away_conf.isin(P4)
    return g


def summarize(df, label):
    print('[%s] rows=%d seasons=%s' % (
        label, len(df),
        '%d-%d' % (df.season.min(), df.season.max()) if len(df) else '-'))


if __name__ == '__main__':
    g = load_schedules()
    summarize(g, 'schedules')
    m = p4_membership()
    print(m.groupby(['season']).team_key.nunique().tail(14).to_string())
    v = venue_geo()
    print('venues with geo: %d' % len(v))
    print(v.head(3).to_string())
