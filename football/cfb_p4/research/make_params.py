#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — assemble ../params.js from the trained artifacts.

Everything the browser engine needs ships here, with its provenance and its
out-of-sample record attached. The record is NOT a footnote: the engine reads
`validation_summary.market` to decide the strongest claim it is allowed to
make, so a model that does not beat the close cannot present itself as one
that does.

Usage: python3 make_params.py <out_dir>
Writes ../params.js
"""
import json
import os
import sys
import datetime

import numpy as np
import pandas as pd

import common

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'params.js')
MODEL_VERSION = 'edgedesk_cfb_p4_v1.0.0'

PROVENANCE = {
    'schedules': 'sportsdataverse/cfbfastR-data schedules/csv/cfb_schedules_YYYY.csv '
                 '(2001-2025; CollegeFootballData-sourced results, venue, attendance, '
                 'neutral-site and season-accurate conference membership)',
    'betting': 'sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz '
               '(2006-2025; spread, total and moneyline, OPENING and closing, multiple '
               'books including Pinnacle). This archive is the reason a real CFB market '
               'backtest exists at all — the repo previously stated that no public CFB '
               'line archive existed, and that was wrong.',
    'rosters': 'sportsdataverse/cfbfastR-data rosters/csv/cfb_rosters_YYYY.csv '
               '(2004-2025; athlete_id, class year, position, measurables). Transfer '
               'portal flow is OBSERVED by diffing athlete_ids season over season.',
    'play_data': 'sportsdataverse/cfbfastR-data player_stats/csv/player_stats_YYYY.csv '
                 '(2014-2025, play-level attribution) scored with an Expected Points '
                 'surface fitted to cfbfastR play-by-play EPA (2004-2022).',
    'team_info': 'sportsdataverse/cfbfastR-data team_info/parquet/cfb_team_info_YYYY.parquet '
                 '(venue coordinates, elevation, capacity, surface, dome, timezone). NOTE: '
                 'this file carries a CURRENT-SNAPSHOT conference for every season and is '
                 'therefore NOT used for historical conference membership.',
    'not_available': 'No public series exists in this corpus for NIL, collectives, injury '
                     'reports, depth charts, coaching tenure, per-player recruiting stars, '
                     'or historical weather. The engine declares each of those unavailable '
                     'and prices it as uncertainty rather than inventing a value.',
}


def build_universe():
    """P4 membership by season (season-accurate, from the schedules) and the
    venue table the browser needs for travel, altitude and weather."""
    conf = common.conference_by_season()
    fbs = conf[conf.division.eq('fbs')]
    by_season = {}
    for s, grp in fbs.groupby('season'):
        row = {}
        for c in common.P4:
            teams = sorted(grp[grp.conference.eq(c)].team_key.tolist())
            if teams:
                row[c] = teams
        if row:
            by_season[str(int(s))] = row

    v = common.venue_geo()
    venues = {}
    latest = fbs[fbs.season.eq(fbs.season.max())].team_key.unique().tolist()
    for r in v.itertuples():
        if not r.team_key or r.team_key not in latest:
            continue
        if pd.isna(r.latitude) or pd.isna(r.longitude):
            continue
        venues[r.team_key] = {
            'venue_id': None if pd.isna(r.venue_id) else int(r.venue_id),
            'name': r.venue_name,
            'lat': round(float(r.latitude), 4),
            'lon': round(float(r.longitude), 4),
            'elev': None if pd.isna(r.elevation) else round(float(r.elevation), 1),
            'capacity': None if pd.isna(r.capacity) else int(r.capacity),
            'tz': common.tz_hours(r.timezone),
            'dome': bool(r.dome) if r.dome is not None else None,
            'grass': None if r.grass is None else bool(r.grass),
        }
    return {'p4_conferences': list(common.P4),
            'p4_by_season': by_season,
            'venues': venues,
            'venue_units': {'elev': 'metres', 'tz': 'UTC offset hours (standard time)'},
            'note': 'Membership is derived from the schedules themselves, which reflect '
                    'realignment correctly (2024: Oregon/UCLA/USC/Washington in the Big Ten, '
                    'California/SMU/Stanford in the ACC). Before 2024 the peer set was the '
                    'Power 5; the engine resolves the tier per season instead of assuming.'}


def build_validation(rep, repl):
    mh = rep.get('market_headline', {})
    ats = mh.get('ats_vs_close', {})
    best = None
    for k, v in ats.items():
        if best is None or v['win_pct'] > ats[best]['win_pct']:
            best = k
    beats = False
    if best is not None:
        beats = ats[best]['win_pct'] > 52.4 and ats[best]['binom_p_one_sided'] < 0.05
    headline = (
        'Held-out %s (seasons no layer of this model was tuned on): model spread MAE %s '
        'against a closing market at %s. %s'
        % (mh.get('window'), mh.get('spread_mae_model'), mh.get('spread_mae_market'),
           'The model beats the close at the thresholds marked significant below.'
           if beats else
           'The model does NOT beat the closing line. Every gap it shows is research, '
           'not an edge, and it is counted nowhere until its own graded CLV says otherwise.'))
    return {
        'market': {
            'window': mh.get('window'),
            'n_games': mh.get('n_games'),
            'spread_mae_model': mh.get('spread_mae_model'),
            'spread_mae_market': mh.get('spread_mae_market'),
            'total_mae_model': mh.get('total_mae_model'),
            'total_mae_market': mh.get('total_mae_market'),
            'ats_vs_close': ats,
            'ou_vs_close': mh.get('ou_vs_close', {}),
            'clv_open_to_close': mh.get('clv_open_to_close'),
            'beats_closing_line': bool(beats),
            'max_tier': 'RESEARCH_LEAN',
            'best_ats': (None if best is None else
                         '%s%% at %s+ points of disagreement (n=%d, p=%s)'
                         % (ats[best]['win_pct'], best, ats[best]['n'],
                            ats[best]['binom_p_one_sided'])),
            'headline': headline,
        },
        'secondary_window': rep.get('market_secondary'),
        'winprob': rep.get('winprob'),
        'calibration': rep.get('calibration'),
        'volatility_validation': rep.get('volatility_validation'),
        'venue': rep.get('venue'),
        'travel': rep.get('travel'),
        'rivalry': rep.get('rivalry'),
        'matchup': rep.get('matchup'),
        'layers': repl,
        'firewall': {
            'layer_a': 'ratings, venue HFA, travel, rivalry, conference — tuned 2001-2013',
            'layer_b': 'efficiency, matchup, blend curve, QB, schedule, total — tuned 2014-2019',
            'layer_c': 'roster continuity, volatility, confidence — tuned 2018-2021',
            'headline_test': '2022-2025, untouched by every layer',
        },
    }


def main():
    with open(os.path.join(OUT, 'params_cfb_p4.json')) as f:
        P = json.load(f)
    with open(os.path.join(OUT, 'report_cfb_p4.json')) as f:
        rep = json.load(f)
    lp = os.path.join(OUT, 'params_layers.json')
    L = json.load(open(lp)) if os.path.exists(lp) else {}
    lr = os.path.join(OUT, 'report_layers.json')
    repl = json.load(open(lr)) if os.path.exists(lr) else {}

    # merge the layer parameters in
    for k in ('qb', 'injury', 'schedule', 'total', 'stability', 'confidence',
              'offfield', 'market', 'development'):
        if k in L:
            P[k] = L[k]
    if 'conference_coefficient' in L:
        P.setdefault('conference', {}).update(L['conference_coefficient'])
        # by_season is keyed by the season it DESCRIBES; the engine reads
        # season-1, because using the current season's cross-conference record
        # to price a current-season game is laundering the result into the
        # projection.
        P['conference']['lookup'] = 'prior_season'
    if 'volatility_youth_group_weights' in L:
        P.setdefault('volatility', {})['youth_group_weights'] = L['volatility_youth_group_weights']

    # keep the FBS universe only: the browser has no use for 400 FCS seeds
    fbs = set(common.conference_by_season()
              .query("division == 'fbs' and season >= 2018").team_key.tolist())
    for key in ('seed_ratings', 'seed_ngames', 'seed_scoring'):
        if key in P.get('rating', {}):
            P['rating'][key] = dict((k, v) for k, v in P['rating'][key].items() if k in fbs)
    if 'seed' in P.get('efficiency', {}):
        P['efficiency']['seed'] = dict((k, v) for k, v in P['efficiency']['seed'].items() if k in fbs)

    P['model_version'] = MODEL_VERSION
    P['built_at'] = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    P['data_provenance'] = PROVENANCE
    P['universe'] = build_universe()
    P['validation_summary'] = build_validation(rep, repl)
    P['unavailable_by_design'] = {
        'weather_coefficients': 'no historical weather series exists in this corpus, so no '
                                'weather coefficient was earned; supplied weather is shown and '
                                'reduces weather uncertainty, but it cannot move the total',
        'injury_position_weights': 'only the quarterback\'s absence is observable in public '
                                   'data; every other position ships untrained',
        'blue_chip_ratio': 'recruit_ids ship empty in the public roster feed — supply '
                           'per-player star ratings to switch this layer on',
        'nil_and_offfield': 'no public NIL or locker-room series exists; supplied signals '
                            'affect information confidence and volatility only',
        'coaching_continuity': 'no coaching-tenure feed in this corpus; supply it and the '
                               'roster-stability score will use it',
    }

    body = json.dumps(P, separators=(',', ':'), allow_nan=False)
    header = (
        "if(typeof window==='undefined'){globalThis.window=globalThis;}\n"
        "/* EdgeDesk CFB Power 4 Intelligence Model — trained parameters.\n"
        "   GENERATED FILE. Produced by football/cfb_p4/research/make_params.py from\n"
        "   public data whose provenance is recorded inside. Regenerate via\n"
        "   research/README.md; never edit by hand. The out-of-sample record travels\n"
        "   with the parameters on purpose: validation_summary.market is what the\n"
        "   engine reads to decide the strongest claim it is allowed to make. */\n"
        "window.EDCfbP4Params = ")
    footer = ";\nif(typeof module!=='undefined'&&module.exports){module.exports=window.EDCfbP4Params;}\n"
    with open(DEST, 'w') as f:
        f.write(header + body + footer)
    size = os.path.getsize(DEST)
    print('[write] %s  (%.1f KB)' % (os.path.abspath(DEST), size / 1024.0))
    print('  seeds: %d FBS teams, %d efficiency profiles, %d venues, %d rated venues, %d rivalry pairs'
          % (len(P['rating']['seed_ratings']), len(P['efficiency'].get('seed', {})),
             len(P['universe']['venues']), len(P['venue']['hfa_by_venue']),
             len(P['rivalry']['pairs'])))
    print('  headline: %s' % P['validation_summary']['market']['headline'])


if __name__ == '__main__':
    main()
