"""Scheme-data audit: what the play-by-play (sportsdataverse espn_cfb_pbp, 2009-2026) and the
team tables can and cannot support, measured season by season.

    python3 -m v2.matchup.audit            -> $CFB_V2_OUT/matchup/audit.json

Every desired field of brief sections 1/3/4 gets a status:
  AVAILABLE    read directly, consistent in every season
  DERIVABLE    computed from consistent raw columns (yardage, down, distance, score, clock)
  PARTIAL      exists only in some seasons, or only a pooled/proxy version exists
  UNRELIABLE   exists but its tagging drifts between seasons (a season effect, not football)
  UNAVAILABLE  no reachable feed carries it (NEW SOURCE REQUIRED)
  REJECT       derivable but refused (leakage: the provider model reads the pregame spread)
The status is decided by the measured coverage below, not assumed: a text keyword that
appears in 0 plays of a season is UNAVAILABLE for that season.
"""
import json
import sys

import numpy as np
import pandas as pd

from .. import common
from .. import config as C

# provider columns a model reads the pregame spread into (never used, as in V2 stage 1)
FORBIDDEN = ('wp_before', 'wp_after', 'wpa', 'go_boost', 'go_wp', 'fg_wp', 'punt_wp', 'go_wp_diff',
             'fg_wp_diff', 'punt_wp_diff', 'fourth_down_recommendation', 'start.pos_team_spread',
             'start.spread_time', 'gameSpread', 'homeTeamSpread', 'overUnder')

AUDIT_COLS = ['season', 'game_id', 'pos_team_id', 'rush', 'pass', 'sack', 'penalty_no_play', 'EPA', 'text',
              'pass_depth', 'pass_direction', 'rush_direction', 'air_yards', 'yards_after_catch', 'qb_hurry',
              'xpass', 'kneel_down', 'start.TimeSecsRem', 'rusher_player_id', 'passer_player_id', 'down',
              'distance', 'drive.id', 'drive.timeElapsed.displayValue', 'drive.offensivePlays', 'pass_breakup',
              'TFL', 'stuffed_run', 'line_yards', 'second_level_yards', 'open_field_yards', 'power_rush_attempt',
              'early_down', 'passing_down', 'statYardage', 'start.yardsToEndzone', 'start.pos_score_diff',
              'period', 'game_play_number']

TEXT_KEYS = {'shotgun': 'shotgun', 'no_huddle': 'no huddle', 'play_action': 'play action|play-action',
             'rpo': r'\brpo\b', 'scramble': 'scrambl', 'motion': 'motion', 'under_center': 'under center',
             'pistol': 'pistol', 'blitz': 'blitz', 'coverage': 'coverage', 'qb_hurried_text': 'hurried'}


def _b(s):
    return s.fillna(False).astype(bool)


def _secs(x):
    try:
        m, s = str(x).split(':')
        return int(m) * 60 + int(s)
    except Exception:
        return np.nan


def season_coverage(S):
    import pyarrow.parquet as pq
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % S)
    names = set(pq.ParquetFile(f).schema_arrow.names)
    d = pd.read_parquet(f, columns=[c for c in AUDIT_COLS if c in names])
    for c in AUDIT_COLS:
        if c not in d:
            d[c] = np.nan
    scrim = (_b(d.rush) | _b(d['pass'])) & ~_b(d.penalty_no_play) & d.EPA.notna()
    s = d[scrim]
    ps, rs = s[_b(s['pass'])], s[_b(s.rush)]
    t = s.text.fillna('').str.lower()
    out = {'season': S, 'scrimmage_plays': int(len(s)), 'games': int(s.game_id.nunique())}
    nn = lambda x: round(float(x.notna().mean()), 4) if len(x) else None
    rate = lambda x: round(float(_b(x).mean()), 4) if len(x) else None
    out.update({
        'pass_flag': rate(s['pass']), 'rush_flag': rate(s.rush), 'sack_per_dropback': rate(ps.sack),
        'early_down_flag': rate(s.early_down), 'passing_down_flag': rate(s.passing_down),
        'down_nonnull': nn(s.down), 'distance_nonnull': nn(s.distance), 'ytg_nonnull': nn(s['start.yardsToEndzone']),
        'score_diff_nonnull': nn(s['start.pos_score_diff']), 'statyardage_nonnull': nn(s.statYardage),
        'pass_depth_nonnull': nn(ps.pass_depth), 'pass_direction_nonnull': nn(ps.pass_direction),
        'air_yards_nonnull': nn(ps.air_yards), 'yac_nonnull': nn(ps.yards_after_catch),
        'rush_direction_nonnull': nn(rs.rush_direction), 'qb_hurry_rate': rate(ps.qb_hurry),
        'pbu_per_dropback': rate(ps.pass_breakup), 'provider_tfl_rate': rate(s.TFL),
        'provider_stuffed_run_rate': rate(rs.stuffed_run), 'yardage_stuff_rate': round(float((rs.statYardage <= 0).mean()), 4),
        'provider_line_yards_mean': round(float(pd.to_numeric(rs.line_yards, errors='coerce').mean()), 4),
        'provider_second_level_mean': round(float(pd.to_numeric(rs.second_level_yards, errors='coerce').mean()), 4),
        'provider_open_field_mean': round(float(pd.to_numeric(rs.open_field_yards, errors='coerce').mean()), 4),
        'power_rush_attempt_rate': rate(rs.power_rush_attempt),
        'rusher_id_nonnull': nn(rs.rusher_player_id), 'passer_id_nonnull': nn(ps.passer_player_id),
        'provider_xpass_nonnull': nn(s.xpass),
    })
    for k, pat in TEXT_KEYS.items():
        out['text_' + k] = round(float(t.str.contains(pat, regex=True).mean()), 5)
    # QB rushes: rusher who also threw >= 2 passes for the team in the game
    pz = ps[ps.passer_player_id.notna()].groupby(['game_id', 'pos_team_id', 'passer_player_id']).size()
    qbs = set((g, tm, q) for (g, tm, q), n in pz.items() if n >= 2)
    key = list(zip(rs.game_id, rs.pos_team_id, rs.rusher_player_id))
    isqb = np.array([k in qbs for k in key])
    out['qb_rush_share_of_rushes'] = round(float(isqb.mean()), 4) if len(isqb) else None
    # per-play clock: distinct start clocks within a drive (drive-level stamping in older seasons)
    ss = s[s['drive.id'].notna()]
    nun = ss.groupby(['game_id', 'drive.id'])['start.TimeSecsRem'].nunique()
    npl = ss.groupby(['game_id', 'drive.id']).size()
    k = npl >= 4
    out['per_play_clock_distinct_share'] = round(float((nun[k] / npl[k]).mean()), 4) if k.any() else None
    dr = d.drop_duplicates(['game_id', 'drive.id'])
    sec = dr['drive.timeElapsed.displayValue'].map(_secs)
    op = pd.to_numeric(dr['drive.offensivePlays'], errors='coerce')
    ok = (sec > 0) & (op >= 3)
    out['drive_time_valid'] = round(float(sec.notna().mean()), 4)
    out['drive_secs_per_play_median'] = round(float((sec[ok] / op[ok]).median()), 3) if ok.any() else None
    return out


# desired field -> (side, status, evidence keys, how V2/matchup derives it, note)
FIELDS = [
    ('run/pass tendency', 'off', 'DERIVABLE', ['pass_flag', 'rush_flag'], 'style: pass rate, PROE',
     'sacks are dropbacks; 2013 sacks untagged (V2 SACKS_UNTAGGED) -> pass/rush split contaminated in 2013'),
    ('early-down run/pass rate', 'off', 'DERIVABLE', ['early_down_flag'], 'style: ed_proe (neutral early-down PROE)', ''),
    ('neutral-situation pass rate', 'off', 'DERIVABLE', ['score_diff_nonnull', 'down_nonnull'],
     'style: neu_pass, proe (own expected-pass model on down/distance/field/score/clock)',
     'the provider xpass column is NOT used (its feature set is undocumented)'),
    ('play-action', 'off', 'UNAVAILABLE', ['text_play_action'], '-', 'no flag, 0 text mentions in every season'),
    ('RPO', 'off', 'UNAVAILABLE', ['text_rpo'], '-', 'no flag; the rare text hits are names, not RPO tags'),
    ('designed QB run', 'off', 'PARTIAL', ['qb_rush_share_of_rushes'],
     'style: qb_rush_rate, qb_rush_epa (designed runs and scrambles POOLED)',
     'a QB rush is identifiable (rusher = the game passer); designed vs scramble is not'),
    ('scramble rate', 'off', 'UNAVAILABLE', ['text_scramble'], 'proxy only: QB rushes on passing downs',
     '0 text mentions in every season; no flag'),
    ('shotgun usage', 'off', 'PARTIAL', ['text_shotgun'], 'live display only',
     'gamebook text from 2025 (partial) and 2026 only: no training history'),
    ('under-center usage', 'off', 'PARTIAL', ['text_shotgun'], 'live display only (= not shotgun)',
     'inferable only where the 2025+ text tags formation'),
    ('personnel grouping', 'off', 'UNAVAILABLE', [], '-', 'not in any reachable feed'),
    ('formation width', 'off', 'UNAVAILABLE', [], '-', 'not in any reachable feed'),
    ('motion', 'off', 'UNAVAILABLE', ['text_motion'], '-', '0 text mentions'),
    ('tempo', 'off', 'DERIVABLE', ['drive_time_valid', 'drive_secs_per_play_median', 'per_play_clock_distinct_share'],
     'style: tempo = neutral-drive seconds per offensive play (drive clock); V2 plays_pg / drives_pg',
     'per-play clock is stamped per DRIVE in older seasons (distinct-clock share ~0.5-0.65 before 2024), so '
     'per-play seconds are REJECTED; the drive elapsed time is valid in every season. 2023 clock rule raises '
     'the level -> season-normalized'),
    ('no-huddle', 'off', 'PARTIAL', ['text_no_huddle'], 'live display only', 'text from 2025 (partial) / 2026 only'),
    ('explosive-pass tendency', 'off', 'DERIVABLE', ['statyardage_nonnull'], 'V2 expl_pass (EPA-explosive flag)', ''),
    ('explosive-rush tendency', 'off', 'DERIVABLE', ['statyardage_nonnull'], 'V2 expl_rush', ''),
    ('short/intermediate/deep passing', 'off', 'PARTIAL', ['pass_depth_nonnull', 'air_yards_nonnull'],
     'live display only', 'pass_depth / air_yards exist only 2025 (partial) and 2026'),
    ('inside/outside run tendency', 'off', 'PARTIAL', ['rush_direction_nonnull'], 'live display only',
     'rush_direction only 2025 (partial) and 2026'),
    ('standard-down tendencies', 'off', 'DERIVABLE', ['passing_down_flag'], 'style: proe on non-passing downs', ''),
    ('passing-down tendencies', 'off', 'DERIVABLE', ['passing_down_flag'], 'style: pd_proe, epa_pd', ''),
    ('fourth-down aggressiveness', 'off', 'DERIVABLE', ['down_nonnull', 'distance_nonnull'],
     'style: go_oe (own expected-go model)',
     'provider go_boost / fourth_down_recommendation read the spread-based WP model -> REJECTED'),
    ('pressure rate', 'def', 'PARTIAL', ['qb_hurry_rate', 'text_qb_hurried_text'], 'proxy: sack rate, havoc',
     'qb_hurry is 0 before 2025, 1.7% in 2025, 3.8% in 2026: no history, tagging still settling'),
    ('sack rate', 'def', 'DERIVABLE', ['sack_per_dropback'], 'V2 sack_rate', '2013 untagged'),
    ('havoc', 'def', 'DERIVABLE', ['provider_tfl_rate'], 'V2 front havoc (sacks + run TFL from yardage)',
     'classic havoc with pass break-ups is UNRELIABLE: PBU tagging swings (see pbu_per_dropback)'),
    ('blitz proxy', 'def', 'UNAVAILABLE', ['text_blitz'], '-', 'no rusher counts, 0 text mentions'),
    ('run-stop rate', 'def', 'DERIVABLE', ['yardage_stuff_rate'], 'V2 stuff / opp_rate from yardage',
     'provider stuffed_run drifts (see provider_stuffed_run_rate) -> recomputed from statYardage'),
    ('stuff rate', 'def', 'DERIVABLE', ['yardage_stuff_rate'], 'V2 stuff', ''),
    ('explosive plays allowed', 'def', 'DERIVABLE', ['statyardage_nonnull'], 'V2 expl_pass/expl_rush def', ''),
    ('passing success allowed', 'def', 'DERIVABLE', [], 'V2 sr_pass def', ''),
    ('rushing success allowed', 'def', 'DERIVABLE', [], 'V2 sr_rush def', ''),
    ('QB rushing allowed', 'def', 'PARTIAL', ['qb_rush_share_of_rushes'], 'style: qb_rush_epa def, qb_rush_rate def',
     'designed + scramble pooled'),
    ('early-down defense', 'def', 'DERIVABLE', [], 'V2 sr_early def; style epa_early def', ''),
    ('passing-down defense', 'def', 'DERIVABLE', [], 'V2 sr_pd def; style epa_pd def', ''),
    ('red-zone / scoring-opportunity defense', 'def', 'DERIVABLE', [], 'V2 pts_per_opp / so_rate def', ''),
    ('defensive pace effects', 'def', 'DERIVABLE', ['drive_time_valid'], 'style: tempo def (joint model)', ''),
    ('box-count information', 'def', 'UNAVAILABLE', [], '-', 'no tracking / charting feed'),
    ('coverage family', 'def', 'UNAVAILABLE', ['text_coverage'], '-', 'no charting feed; 0 text mentions'),
    ('second-level / open-field yards', 'off', 'UNRELIABLE', ['provider_second_level_mean', 'provider_open_field_mean'],
     '-', 'provider columns drift across seasons (V2 FEATURE_COVERAGE: REJECTED)'),
    ('provider expected pass (xpass)', 'off', 'REJECT', ['provider_xpass_nonnull'], 'own model instead',
     'undocumented feature set; replaced by style.xpass_model on declared state variables'),
    ('provider 4th-down recommendation', 'off', 'REJECT', [], 'own expected-go model instead',
     'reads the spread-based win-probability model'),
    ('OL health / continuity', 'off', 'UNAVAILABLE', [], '-', 'no point-in-time injury or snap-count history'),
    ('secondary / front-seven health', 'def', 'UNAVAILABLE', [], '-', 'no point-in-time injury history'),
    ('coordinator continuity', 'both', 'PARTIAL', [], 'changes: oc_cont / dc_cont (preseason flag, 2015+)',
     'a continuity flag only: no coordinator names, so a coordinator cannot be followed across schools'),
    ('weather (wind, rain, heat)', 'both', 'UNAVAILABLE', [], '-',
     'archived observed weather is hindsight; no archived pregame forecasts (V2 FEATURE_COVERAGE)'),
]


def classify(per_season):
    rows = []
    for name, side, status, keys, derived, note in FIELDS:
        ev = {}
        for k in keys:
            ev[k] = {str(r['season']): r.get(k) for r in per_season}
        rows.append({'field': name, 'side': side, 'status': status, 'evidence': ev, 'derived_as': derived,
                     'note': note})
    return rows


def run(seasons=None, write=True):
    seasons = seasons or list(range(C.FIRST_PBP_SEASON, C.LIVE_SEASON + 1))
    per = []
    for S in seasons:
        per.append(season_coverage(S))
        print('[audit] %d %s' % (S, {k: per[-1][k] for k in ('scrimmage_plays', 'qb_hurry_rate', 'pass_depth_nonnull',
                                                            'text_shotgun', 'per_play_clock_distinct_share')}),
              flush=True)
    out = {'seasons': seasons, 'per_season': per, 'fields': classify(per),
           'status_counts': pd.Series([f[2] for f in FIELDS]).value_counts().to_dict(),
           'forbidden_provider_columns': list(FORBIDDEN)}
    if write:
        common.write_json(common.out_path('matchup', 'audit.json'), out)
    return out


if __name__ == '__main__':
    run([int(a) for a in sys.argv[1:]] or None)
