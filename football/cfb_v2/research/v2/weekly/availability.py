"""Availability state and unit-health state for the weekly engine.

Reads the conference availability reports the repo already collects
(football/availability/reports/<season>_*.json, one per team per game) and
keeps only what was PUBLISHED by the instant the run is asked about: a report
retrieved after kickoff, or published after `as_of`, is not knowledge the
model had. A team with no report is UNKNOWN, never "healthy": a missing
report is not evidence of health.

V2.1 reads no availability input, so none of this changes a pure projection.
It sets the run's DEGRADED_AVAILABILITY mode, the Model Lab's data quality,
and (from the personnel system on) the lineup deltas and their uncertainty.
"""
import glob
import json
import os

import pandas as pd

from . import ids
from .sources import REPO

RULE = 'cfb_availability_state_v1'

# status -> probability the player plays (declared; the personnel system
# replaces these with historically calibrated values where evidence exists)
PLAY_PROBABILITY = {'ACTIVE': 1.0, 'AVAILABLE': 1.0, 'PROBABLE': 0.85, 'QUESTIONABLE': 0.5,
                    'GAME-TIME DECISION': 0.5, 'GTD': 0.5, 'DOUBTFUL': 0.2, 'OUT': 0.0, 'SUSPENDED': 0.0,
                    'TRANSFERRED': 0.0, 'OUT FOR SEASON': 0.0, 'UNKNOWN': None}
UNIT_OF_POSITION = {
    'QB': 'QB', 'RB': 'RB', 'FB': 'RB', 'WR': 'WR_TE', 'TE': 'WR_TE', 'OL': 'OL', 'OT': 'OL', 'T': 'OL', 'G': 'OL',
    'OG': 'OL', 'C': 'OL', 'IOL': 'OL', 'DL': 'DL', 'DE': 'DL', 'DT': 'DL', 'NT': 'DL', 'EDGE': 'DL', 'LB': 'LB',
    'ILB': 'LB', 'OLB': 'LB', 'MLB': 'LB', 'DB': 'DB', 'CB': 'DB', 'S': 'DB', 'SS': 'DB', 'FS': 'DB', 'NB': 'DB',
    'K': 'ST', 'P': 'ST', 'LS': 'ST', 'PK': 'ST',
}
UNITS = ('QB', 'OL', 'WR_TE', 'RB', 'DL', 'LB', 'DB', 'ST')
# source tiers: official team/conference game-status reports are tier 1
TIER_OF_PLATFORM = {'conference': 1, 'hdintelligence': 1, 'pac12': 1, 'team': 1}


def load_reports(season, reports_dir=None):
    d = reports_dir or os.path.join(REPO, 'football', 'availability', 'reports')
    out = []
    for f in sorted(glob.glob(os.path.join(d, '%d_*.json' % season))):
        try:
            r = json.load(open(f))
        except (OSError, ValueError):
            continue
        r['_file'] = os.path.basename(f)
        out.append(r)
    return out


def _known_at(r, as_of):
    """A report is knowledge at `as_of` only if it was published (or, with no
    publication time, retrieved) by then."""
    t = r.get('published_at') or r.get('retrieved_at')
    return t is not None and pd.Timestamp(t) <= pd.Timestamp(as_of)


def snapshot(season, week, games, as_of, team_ids=None, reports=None):
    """Per team x unit availability for the target week's games, as known at
    `as_of`. `games`: frame with game_id, home_id, away_id, kickoff_ts."""
    reports = load_reports(season) if reports is None else reports
    by_game_team = {}
    for r in reports:
        gid = str(r.get('game_id'))
        by_game_team.setdefault(gid, []).append(r)
    rows = []
    for _, g in games.iterrows():
        gid = str(g.game_id)
        for side in ('home', 'away'):
            tid = str(g[side + '_id'])
            tname = g.get(side + '_team')
            reps = [r for r in by_game_team.get(gid, []) if _known_at(r, as_of)
                    and (str(r.get('team_id', '')) == tid or (r.get('team') and tname and str(r['team']).lower() == str(tname).lower()))]
            rep = max(reps, key=lambda r: r.get('published_at') or r.get('retrieved_at')) if reps else None
            players = (rep or {}).get('players') or []
            tier = TIER_OF_PLATFORM.get(str((rep or {}).get('platform', 'conference')).lower(), 2) if rep else None
            age = None
            if rep:
                age = round((pd.Timestamp(as_of) - pd.Timestamp(rep.get('published_at') or rep.get('retrieved_at'))).total_seconds() / 3600, 2)
            for unit in UNITS:
                ps = [p for p in players if UNIT_OF_POSITION.get(str(p.get('position', '')).upper()) == unit]
                out_n = sum(1 for p in ps if PLAY_PROBABILITY.get(str(p.get('status', '')).upper()) == 0.0)
                q_n = sum(1 for p in ps if (PLAY_PROBABILITY.get(str(p.get('status', '')).upper()) or 1.0) not in (0.0, 1.0))
                rows.append(ids.clean({
                    'unit_state_id': 'cfbu_' + ids.h(tid, season, week, unit, RULE, rep.get('_file') if rep else None),
                    'team_id': tid, 'season': season, 'week': week, 'game_id': gid, 'unit': unit,
                    'report_status': 'OFFICIAL_REPORT' if rep else 'NO_REPORT',
                    'knowledge': 'KNOWN' if rep else 'UNKNOWN',
                    'reported_out': out_n if rep else None, 'reported_uncertain': q_n if rep else None,
                    'players': [{'player_id': p.get('player_id'), 'name': p.get('player_name'), 'position': p.get('position'),
                                 'status': p.get('status'), 'play_probability': PLAY_PROBABILITY.get(str(p.get('status', '')).upper())}
                                for p in ps],
                    'source': (rep or {}).get('source_url'), 'source_tier': tier, 'published_at': (rep or {}).get('published_at'),
                    'status_age_hours': age, 'as_of': ids.ts(as_of), 'rule_version': RULE,
                    'health_index': None,
                    'health_note': 'player values and replacement levels come from the personnel system; '
                                   'this row records what the official report said, not a point value',
                }))
    return pd.DataFrame(rows)


def team_summary(units):
    """One row per team: report status and the QB line (for the QB-change flags)."""
    if units is None or not len(units):
        return pd.DataFrame(columns=['team_id', 'report_status', 'qb_out', 'qb_uncertain'])
    g = units.groupby('team_id')
    s = g.report_status.first().to_frame()
    qb = units[units.unit.eq('QB')].set_index('team_id')
    s['qb_out'] = qb.reported_out.reindex(s.index)
    s['qb_uncertain'] = qb.reported_uncertain.reindex(s.index)
    s['status_age_hours'] = g.status_age_hours.min()
    return s.reset_index()
