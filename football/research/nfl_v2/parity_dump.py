#!/usr/bin/env python3
"""NFL training/serving PARITY — the Python side.

Runs the training pipeline's own code (build_features.build_nfl and
train_nfl.sequential_pass, unmodified) over 1999..LAST with the SHIPPED
hyperparameters, and records:

  start     the full rating state at the moment the FIRST season under test
            begins (after its season break): team ratings, league means,
            quarterback values, team QB levels, games absorbed
  absorbs   after EVERY absorbed game of the seasons under test, both clubs'
            16 ratings, both clubs' QB level, every league mean, and the
            credited quarterbacks' values

football/parity.test.js loads that start state into football/engine.js and
replays the same games through nfl.absorbCompleted — the one absorb path every
live caller now uses — and fails on any difference beyond 1e-9.

Usage:
  NFL_LAST_SEASON=2026 python3 football/research/nfl_v2/parity_dump.py \
      <raw_dir> <out_json> [first_season=2025]
<raw_dir> holds games.csv, stw_<y>.csv and spw_<y>.csv (fetch_history.sh).
"""
import os, sys, json, math, re, gzip, tempfile, importlib

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(RESEARCH))

RAW = sys.argv[1]
OUT_JSON = sys.argv[2]
FIRST = int(sys.argv[3]) if len(sys.argv) > 3 else 2025
LAST = int(os.environ.get('NFL_LAST_SEASON', '2026'))
os.environ['NFL_LAST_SEASON'] = str(LAST)

# build_features reads DATA/nfl/<file>; give it that layout over the raw cache
work = tempfile.mkdtemp(prefix='nfl_parity_')
os.makedirs(os.path.join(work, 'data'))
os.symlink(os.path.abspath(RAW), os.path.join(work, 'data', 'nfl'))
out_dir = os.path.join(work, 'out'); os.makedirs(out_dir)

sys.path.insert(0, RESEARCH)
sys.argv = ['build_features.py', os.path.join(work, 'data'), out_dir]
bf = importlib.import_module('build_features')
bf.build_nfl()
sys.argv = ['train_nfl.py', out_dir]
tn = importlib.import_module('train_nfl')

import pandas as pd

def shipped_hyperparams():
    txt = open(os.path.join(ROOT, 'football', 'params.js'), encoding='utf8').read()
    m = re.search(r'window\.EDFootballParams\s*=\s*(\{.*\});', txt, re.S)
    return json.loads(m.group(1))['nfl']['hyperparams']

HP = shipped_hyperparams()
games = pd.read_csv(os.path.join(out_dir, 'nfl_games.csv'), parse_dates=['kick_dt']).sort_values(['kick_dt', 'game_id'])
tg = pd.read_csv(os.path.join(out_dir, 'nfl_team_games.csv'))
qb = pd.read_csv(os.path.join(out_dir, 'nfl_qb_games.csv'))

def f64(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)

record = {'start': None, 'absorbs': []}
season_of_break = [1999]
season_games = list(games.season.values)  # season of each game, in pass order
cursor = {'i': -1}

class Recording(tn.Ratings):
    def season_break(self):
        super().season_break()
        season_of_break[0] += 1
        if season_of_break[0] == FIRST and record['start'] is None:
            record['start'] = {
                'season': FIRST,
                'team': {t: {f: f64(v) for f, v in r.items()} for t, r in self.team.items()},
                'lmean': {f: f64(v) for f, v in self.lmean.items()},
                'qb': {q: {'v': f64(x['v']), 'n': int(x['n'])} for q, x in self.qb.items()},
                'team_qb': {t: f64(v) for t, v in self.team_qb.items()},
                'ngames': {t: int(n) for t, n in self.ngames.items()},
            }

    def absorb_game(self, rows_by_team, qb_starts):
        super().absorb_game(rows_by_team, qb_starts)
        if season_of_break[0] < FIRST:
            return
        teams = list(rows_by_team.keys())
        record['absorbs'].append({
            'season': season_of_break[0],
            'teams': teams,
            'ratings': {t: {f: f64(self.team[t][f]) for f in tn.RATE_FEATS} for t in teams},
            'team_qb': {t: f64(self.team_qb.get(t, 0.0)) for t in teams},
            'lmean': {f: f64(v) for f, v in self.lmean.items()},
            'qb': {t: {'id': q[0], 'dev': f64(q[1]),
                       'v': f64(self.qb[q[0]]['v']) if q[0] in self.qb else None,
                       'n': int(self.qb[q[0]]['n']) if q[0] in self.qb else None}
                   for t, q in qb_starts.items()},
        })

tn.Ratings = Recording
_, R = tn.sequential_pass(games, tg, qb, HP)

# the game list the JS side replays, in the pass order, with the absorb flag
g2 = games[games.season >= FIRST]
record['games'] = [{'game_id': r.game_id, 'season': int(r.season), 'gameday': str(r.kick_dt.date()),
                    'home_team': r.home_fr, 'away_team': r.away_fr,
                    'home_score': float(r.home_score), 'away_score': float(r.away_score)}
                   for r in g2.itertuples()]
record['meta'] = {'first_season': FIRST, 'last_season': LAST, 'hyperparams': HP,
                  'absorbed': len(record['absorbs']), 'games': len(record['games']),
                  'source': 'football/research/build_features.py + train_nfl.py (sequential_pass), unmodified'}
os.makedirs(os.path.dirname(os.path.abspath(OUT_JSON)), exist_ok=True)
payload = json.dumps(record, separators=(',', ':'))
if OUT_JSON.endswith('.gz'):
    with gzip.GzipFile(OUT_JSON, 'wb', mtime=0) as fh:   # mtime 0: a rerun on the same data is byte-identical
        fh.write(payload.encode('utf8'))
else:
    with open(OUT_JSON, 'w') as fh:
        fh.write(payload)
print(f"parity dump: start of {FIRST}, {len(record['absorbs'])} absorbs over {len(record['games'])} games -> {OUT_JSON}")
