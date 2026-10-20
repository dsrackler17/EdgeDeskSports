#!/usr/bin/env python3
"""NFL team-game efficiency from nflverse PLAY-BY-PLAY, with and without
garbage time — the input of the garbage-time toggle (Step 4, preregistered in
preregistration.json as G0/G1/G2).

For every season it downloads nflverse-data pbp/play_by_play_<y>.csv.gz,
aggregates each offence's plays in each game into the stats_team_week columns
the engine reads (football/engine.js nfl.teamGameFromStw), and deletes the
download. Three files per season, one per filter:

  G0  every scrimmage play (the control: same source, no filter)
  G1  second-half plays dropped when the offence's pre-snap win probability
      is below 0.10 or above 0.90
  G2  plays in any quarter dropped when it is below 0.05 or above 0.95

A scrimmage play is play_type 'pass' or 'run' with an EPA, not a two-point
try, kneel, spike or aborted snap. Pass plays are attempts and sacks (a
scramble is a run, as stats_team_week counts it); passing_20 is a completion
of 20+ yards, rushing_10 a run of 10+.

Usage: python3 build_pbp_team_games.py <out_dir> [first=1999] [last=2026]
"""
import os, sys, gzip, urllib.request, tempfile, shutil
import numpy as np
import pandas as pd

OUT = sys.argv[1]
FIRST = int(sys.argv[2]) if len(sys.argv) > 2 else 1999
LAST = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
URL = 'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{y}.csv.gz'
COLS = ['game_id', 'season', 'week', 'season_type', 'posteam', 'defteam', 'qtr', 'wp', 'epa', 'play_type',
        'pass_attempt', 'rush_attempt', 'sack', 'complete_pass', 'yards_gained', 'two_point_attempt',
        'qb_kneel', 'qb_spike', 'aborted_play']
FILTERS = {
    'G0': lambda d: np.ones(len(d), dtype=bool),
    'G1': lambda d: ~((d.qtr >= 3) & ((d.wp < 0.10) | (d.wp > 0.90))),
    'G2': lambda d: ~((d.wp < 0.05) | (d.wp > 0.95)),
}
os.makedirs(OUT, exist_ok=True)


def aggregate(d):
    is_pass = (d.play_type == 'pass')
    is_run = (d.play_type == 'run')
    d = d.assign(
        _att=(is_pass & (d.sack != 1) & (d.pass_attempt == 1)).astype(int),
        _sk=(is_pass & (d.sack == 1)).astype(int),
        _pepa=np.where(is_pass, d.epa, 0.0),
        _car=is_run.astype(int),
        _repa=np.where(is_run, d.epa, 0.0),
        _p20=(is_pass & (d.complete_pass == 1) & (d.yards_gained >= 20)).astype(int),
        _r10=(is_run & (d.yards_gained >= 10)).astype(int),
    )
    g = d.groupby(['season', 'week', 'season_type', 'game_id', 'posteam', 'defteam'], sort=False).agg(
        attempts=('_att', 'sum'), sacks_suffered=('_sk', 'sum'), passing_epa=('_pepa', 'sum'),
        carries=('_car', 'sum'), rushing_epa=('_repa', 'sum'), passing_20=('_p20', 'sum'), rushing_10=('_r10', 'sum'),
    ).reset_index().rename(columns={'posteam': 'team', 'defteam': 'opponent_team'})
    # stats_team_week's own order: a game's two rows by team code
    return g.sort_values(['week', 'game_id', 'team'], kind='mergesort')


for y in range(FIRST, LAST + 1):
    done = [os.path.join(OUT, f'pbp_{k}_{y}.csv') for k in FILTERS]
    if all(os.path.exists(p) for p in done) and y < LAST:
        continue
    tmp = tempfile.mkdtemp(prefix='pbp_')
    try:
        gz = os.path.join(tmp, f'pbp_{y}.csv.gz')
        urllib.request.urlretrieve(URL.format(y=y), gz)
        d = pd.read_csv(gz, usecols=COLS, low_memory=False)
        d = d[d.play_type.isin(['pass', 'run']) & d.epa.notna() & d.posteam.notna()
              & (d.two_point_attempt.fillna(0) != 1) & (d.qb_kneel.fillna(0) != 1)
              & (d.qb_spike.fillna(0) != 1) & (d.aborted_play.fillna(0) != 1)]
        for k, f in FILTERS.items():
            keep = f(d) if k == 'G0' else (f(d) | d.wp.isna())   # a play with no win probability is kept
            aggregate(d[keep]).to_csv(os.path.join(OUT, f'pbp_{k}_{y}.csv'), index=False)
        print(f'{y}: {len(d)} scrimmage plays -> {", ".join(FILTERS)}', flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
print('pbp team-games ready in', OUT)
