"""Shadow mode records: what every model said, what the market did, what happened.

    python3 -m v2.shadow --season 2026            (after predict_live, every run)

Three records, three different rules:

  snapshots/<season>/<freeze>.json   FROZEN, written by predict_live, hashed,
                                     never modified. Each row carries the
                                     hardened V2 projection AND, frozen with it,
                                     candidate 001's projection, V1's projection
                                     (football/fbs/slate.json) and the market as
                                     seen at the freeze.
  shadow/<season>/lines.jsonl        APPEND-ONLY line ledger: one line per game
                                     whenever the observed opener / current
                                     number / total changes, stamped with the
                                     observation time. Never rewritten. This is
                                     the timestamped history the archive does not
                                     have (edge decay by time needs it).
  shadow/<season>/outcomes.json      DERIVED, recomputed every run from the two
                                     above plus final scores: the closing number
                                     (last pre-kickoff observation), the result,
                                     every model's error, CLV and grading.
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from . import config as C
from . import common

REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def ledger_path(season):
    d = os.path.join(REPO_V2, 'shadow', str(season))
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, 'lines.jsonl')


def read_ledger(season):
    p = ledger_path(season)
    if not os.path.exists(p):
        return pd.DataFrame(columns=['game_id', 'observed_at', 'open_home_line', 'current_home_line',
                                     'total_open', 'total_current', 'source', 'retrieved_at'])
    rows = [json.loads(x) for x in open(p) if x.strip()]
    return pd.DataFrame(rows)


def market_now(season):
    """The current market for the season from the pipeline's own ingestion
    (stage 2: CFBD provider mean for the live season), in BOOK convention for
    storage (home line; negative = home favoured), with its retrieval time."""
    M = pd.read_parquet(common.out_path('stage2', 'market.parquet'))
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
    G = G[G.season.eq(season)][['game_id', 'kickoff_ts']]
    M = M.merge(G, on='game_id', how='inner')
    f = common.data_path('mline', 'ml_%d.parquet' % season)
    retrieved = common.iso(pd.Timestamp(os.path.getmtime(f), unit='s', tz='UTC').to_pydatetime()) \
        if os.path.exists(f) else None
    out = {}
    for r in M.itertuples(index=False):
        out[int(r.game_id)] = {
            'open_home_line': common.margin_to_book_home_line(r.spread_open) if pd.notna(r.spread_open) else None,
            'current_home_line': common.margin_to_book_home_line(r.spread_close) if pd.notna(r.spread_close) else None,
            'total_open': None if pd.isna(r.total_open) else float(r.total_open),
            'total_current': None if pd.isna(r.total_close) else float(r.total_close),
            'source': r.source, 'retrieved_at': retrieved, 'kickoff': common.iso(r.kickoff_ts.to_pydatetime())}
    return out


def record_lines(season, now):
    """Append a ledger line for every not-yet-kicked-off game whose observed
    numbers changed since its last ledger line."""
    mk = market_now(season)
    L = read_ledger(season)
    last = {}
    if not L.empty:
        L = L.sort_values('observed_at')
        for r in L.itertuples(index=False):
            last[int(r.game_id)] = (r.open_home_line, r.current_home_line, r.total_open, r.total_current)
    n = 0
    with open(ledger_path(season), 'a') as fh:
        for gid, m in sorted(mk.items()):
            if m['current_home_line'] is None or pd.Timestamp(m['kickoff']) <= now:
                continue
            key = (m['open_home_line'], m['current_home_line'], m['total_open'], m['total_current'])
            if last.get(gid) == key:
                continue
            fh.write(json.dumps({'game_id': gid, 'observed_at': common.iso(now.to_pydatetime()),
                                 'open_home_line': key[0], 'current_home_line': key[1], 'total_open': key[2],
                                 'total_current': key[3], 'source': m['source'], 'retrieved_at': m['retrieved_at']},
                                sort_keys=True) + '\n')
            n += 1
    return n


def frozen_rows(season):
    d = os.path.join(REPO_V2, 'snapshots', str(season))
    rows = []
    for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if f == 'replay_to_date.json' or not f.endswith('.json'):
            continue
        j = json.load(open(os.path.join(d, f)))
        for x in j['rows']:
            rows.append(dict(x['row'], model_version=j.get('model_version'), frozen_file=f))
    return rows


def grade(margin, home_line_book, side_home):
    """+1 win, -1 loss, 0 push for a bet on side_home at a BOOK home line."""
    m = common.book_home_line_to_margin(home_line_book)
    return common.home_cover_result(margin, m) * (1 if side_home else -1)


def outcomes(season, now):
    G = pd.read_parquet(common.out_path('stage2', 'games.parquet')).set_index('game_id')
    L = read_ledger(season)
    mk = market_now(season)
    out = []
    for r in frozen_rows(season):
        gid = int(r['game_id'])
        g = G.loc[gid] if gid in G.index else None
        sh = r.get('shadow') or {}
        rec = {'game_id': gid, 'week': r.get('week'), 'home': r.get('home'), 'away': r.get('away'),
               'kickoff': r.get('kickoff'), 'prediction_ts': r.get('prediction_ts'), 'model_version': r.get('model_version'),
               'v2': r.get('ens_pred'), 'v2_sigma': r.get('sigma'), 'v2_p_home': r.get('p_home'),
               'v2_components': r.get('components'), 'priced': r.get('priced', True),
               'candidate_001': (sh.get('candidate_001') or {}).get('ens_pred'),
               'v1': (sh.get('v1') or {}).get('margin'), 'v1_p_home': (sh.get('v1') or {}).get('home_win_prob'),
               'line_at_freeze': (sh.get('market_at_freeze') or {}).get('current_home_line'),
               'opener': (sh.get('market_at_freeze') or {}).get('open_home_line')}
        # closing number: the last ledger observation before kickoff, else the
        # provider's final number for a completed game
        lg = L[L.game_id.eq(gid)] if not L.empty else L
        if len(lg):
            pre = lg[pd.to_datetime(lg.observed_at, utc=True) < pd.Timestamp(r['kickoff'])]
            if len(pre):
                rec['close'] = pre.sort_values('observed_at').current_home_line.iloc[-1]
                rec['close_observed_at'] = pre.sort_values('observed_at').observed_at.iloc[-1]
                rec['n_line_observations'] = int(len(pre))
                rec['opener'] = rec['opener'] if rec['opener'] is not None else pre.sort_values('observed_at').open_home_line.iloc[0]
        if rec.get('close') is None and gid in mk and mk[gid]['current_home_line'] is not None and g is not None \
                and g.status == 'FINAL':
            rec['close'] = mk[gid]['current_home_line']
            rec['close_observed_at'] = 'provider final number (' + str(mk[gid]['retrieved_at']) + ')'
        if g is not None and g.status == 'FINAL':
            y = float(g.margin)
            rec['final_margin'] = y
            for k in ('v2', 'candidate_001', 'v1'):
                if rec.get(k) is not None:
                    rec['err_' + k] = round(rec[k] - y, 3)
            for k in ('opener', 'line_at_freeze', 'close'):
                if rec.get(k) is not None:
                    rec['err_' + k] = round(common.book_home_line_to_margin(rec[k]) - y, 3)
            ref = rec.get('line_at_freeze') if rec.get('line_at_freeze') is not None else rec.get('opener')
            if ref is not None and rec.get('v2') is not None:
                side_home = rec['v2'] > common.book_home_line_to_margin(ref)
                rec['v2_side'] = 'HOME' if side_home else 'AWAY'
                rec['ats_at_freeze_line'] = grade(y, ref, side_home)
                if rec.get('close') is not None:
                    rec['ats_at_close'] = grade(y, rec['close'], side_home)
                    mv = common.book_home_line_to_margin(rec['close']) - common.book_home_line_to_margin(ref)
                    rec['clv_pts'] = round(mv if side_home else -mv, 3)
        out.append(rec)
    d = os.path.join(REPO_V2, 'shadow', str(season))
    os.makedirs(d, exist_ok=True)
    body = {'season': season, 'generated_at': common.iso(now.to_pydatetime()),
            'note': 'DERIVED from the frozen snapshots, the append-only line ledger and final scores. '
                    'Recomputed every run; the frozen predictions themselves are never modified.',
            'sign_convention': 'v2 / candidate_001 / v1 and err_* are home MARGINS (+ = home); opener / '
                               'line_at_freeze / close are BOOK home lines (- = home favoured).',
            'rows': out}
    with open(os.path.join(d, 'outcomes.json'), 'w') as fh:
        json.dump(body, fh, indent=1, sort_keys=True, default=common._json_default)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=C.LIVE_SEASON)
    ap.add_argument('--now', default=None)
    a = ap.parse_args()
    now = pd.Timestamp(a.now) if a.now else pd.Timestamp.now(tz='UTC')
    if now.tzinfo is None:
        now = now.tz_localize('UTC')
    n = record_lines(a.season, now)
    o = outcomes(a.season, now)
    print('[shadow] %d new line observations; %d frozen games in outcomes' % (n, len(o)))


if __name__ == '__main__':
    main()
