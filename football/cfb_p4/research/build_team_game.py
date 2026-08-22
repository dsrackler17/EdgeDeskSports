#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — per-team-per-game efficiency features from
cfbfastR-data `player_stats` (2014-2025).

WHY THIS FILE EXISTS
Full play-by-play with real EPA stops at 2022. A model that has to project
the 2026 season cannot run on 2022 data, so the recent-season efficiency
layer is rebuilt from `player_stats`, which IS published through the current
season and carries down, distance, yards-to-goal, drive ids and per-play
player attribution. `ep_surface.py` then scores those plays with an Expected
Points surface fitted on the real pbp, and `validate_lite.py` checks the
reconstruction against real EPA on the 2014-2022 overlap. If that check ever
fails, this table must not be trusted, and the report says so.

THREE TRAPS THIS FILE EXISTS TO HANDLE (all found by execution, not assumed)

1. `team` IS NOT RELIABLY THE OFFENCE. On 31% of sack rows the credited team
   is the team that MADE the sack, and 7% of drives carry more than one
   `team` value. Every row is therefore re-anchored to its DRIVE's offence,
   which is derived from the unambiguous plays (rushes and completions).

2. `team_score`/`opponent_score` FOLLOW `team`, so they flip perspective on
   exactly those rows. They are re-oriented to the drive offence, and they
   are POST-play, so the pre-play score state used for garbage time is the
   previous play's value within the game.

3. Punts and kickoffs are largely ABSENT while field-goal attempts are
   present. Drive counts and points-per-drive are therefore offensive-drive
   approximations, and they are labelled as such rather than presented as
   full drive charting.

Usage: python3 build_team_game.py <out_dir> [first_season] [last_season]
Writes <out>/team_game.csv  (one row per game per team, offence + defence)
"""
import os
import sys

import numpy as np
import pandas as pd

import common
from ep_surface import EPSurface, epa as epa_calc

_SURFACE = None                     # set by main(); the fitted EP lookup

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
Y0 = int(sys.argv[2]) if len(sys.argv) > 2 else common.PSTATS_FIRST
Y1 = int(sys.argv[3]) if len(sys.argv) > 3 else common.SCHED_LAST

USECOLS = [
    'game_id', 'season', 'week', 'team', 'conference', 'opponent',
    'team_score', 'opponent_score', 'drive_id', 'play_id', 'period',
    'clock_minutes', 'clock_seconds', 'yards_to_goal', 'down', 'distance',
    'completion_player', 'completion_player_id', 'completion_yds',
    'incompletion_player', 'incompletion_player_id',
    'rush_player', 'rush_player_id', 'rush_yds',
    'reception_player', 'reception_yds',
    'sack_taken_player', 'sack_taken_player_id', 'sack_taken_stat',
    'sack_player', 'sack_stat',
    'interception_thrown_player', 'interception_thrown_player_id', 'interception_player',
    'touchdown_player', 'touchdown_stat',
    'fumble_player', 'fumble_recovered_player', 'fumble_forced_player',
    'pass_breakup_player',
    'field_goal_attempt_player', 'field_goal_made_player',
]

# Explosive thresholds. The yardage forms are the standard public definitions,
# stated openly rather than tuned into the target: 15+ through the air, 10+ on
# the ground. The EPA form is the one the model actually uses, and its
# threshold was CALIBRATED against cfbfastR's own explosive flag: EPA>=1.8
# (the pbp rush rule) over-calls the rate by +0.026 when applied to
# surface-derived EPA, while EPA>=2.2 reproduces the real 7.4% explosive rate
# and lifts team-game agreement from r=0.777 to r=0.825.
EXPL_PASS_YDS = 15
EXPL_RUSH_YDS = 10
EXPL_EPA = 2.2
STUFF_YDS = 0                      # rush gaining <= 0 is "stuffed"

# Garbage time. Score margins beyond which the football stops being the
# football being modelled. Same shape as accepted public definitions; the
# threshold widens earlier in the game.
GARBAGE = {1: 43, 2: 37, 3: 27, 4: 22}


def _num(s):
    return pd.to_numeric(s, errors='coerce')


def _success(down, distance, gain):
    """Standard success: 50% of the distance on 1st, 70% on 2nd, 100% on
    3rd/4th. NaN gain -> NaN success (never a fabricated failure)."""
    need = np.where(down == 1, 0.5 * distance,
            np.where(down == 2, 0.7 * distance, distance))
    out = np.where(np.isnan(gain), np.nan, (gain >= need).astype(float))
    return out


def load_season(year):
    p = os.path.join(common.DATA, 'pstats', 'pstats_%d.csv' % year)
    if not os.path.exists(p):
        return None
    d = pd.read_csv(p, usecols=lambda c: c in USECOLS, low_memory=False)
    for c in ('game_id', 'season', 'week', 'period', 'down', 'distance',
              'yards_to_goal', 'completion_yds', 'rush_yds', 'reception_yds',
              'sack_taken_stat', 'sack_stat', 'team_score', 'opponent_score',
              'clock_minutes', 'clock_seconds', 'drive_id', 'play_id'):
        if c in d.columns:
            d[c] = _num(d[c])
    d = d[d.game_id.notna() & d.drive_id.notna()].copy()
    d['season'] = year
    return d


def anchor_drives(d):
    """Re-anchor every row to its drive's offence, and re-orient the score."""
    unambiguous = d.completion_player.notna() | d.rush_player.notna()
    off = (d[unambiguous].groupby('drive_id').team
           .agg(lambda s: s.mode().iat[0] if len(s.mode()) else None)
           .rename('off_team'))
    d = d.merge(off, on='drive_id', how='left')

    # the game's two teams; the defence is simply the other one
    pair = (pd.concat([d[['game_id', 'team']].rename(columns={'team': 't'}),
                       d[['game_id', 'opponent']].rename(columns={'opponent': 't'})])
            .dropna().drop_duplicates())
    counts = pair.groupby('game_id').t.nunique()
    bad_games = set(counts[counts != 2].index)
    teams = (pair[~pair.game_id.isin(bad_games)]
             .sort_values(['game_id', 't']).groupby('game_id').t
             .agg(list).rename('pair'))
    d = d.merge(teams, on='game_id', how='left')

    def other(row):
        p = row['pair']
        if not isinstance(p, list) or len(p) != 2 or row['off_team'] is None:
            return None
        return p[1] if p[0] == row['off_team'] else p[0]

    d['def_team'] = [other(r) for _, r in d[['pair', 'off_team']].iterrows()]
    dropped = int(d.off_team.isna().sum())
    d = d[d.off_team.notna() & d.def_team.notna()].copy()

    # score, re-oriented to the offence and shifted to PRE-play
    same = d.team.eq(d.off_team)
    d['off_score_post'] = np.where(same, d.team_score, d.opponent_score)
    d['def_score_post'] = np.where(same, d.opponent_score, d.team_score)
    d = d.sort_values(['game_id', 'play_id'], kind='mergesort')
    # pre-play state is the previous play's post state, per game, from the
    # OFFENCE's point of view on the current row
    home_running = d.groupby('game_id')[['off_score_post', 'def_score_post']].shift(1)
    prev_off_team = d.groupby('game_id').off_team.shift(1)
    same_off = prev_off_team.eq(d.off_team)
    d['off_score_pre'] = np.where(same_off, home_running.off_score_post,
                                  home_running.def_score_post)
    d['def_score_pre'] = np.where(same_off, home_running.def_score_post,
                                  home_running.off_score_post)
    d['off_score_pre'] = d.off_score_pre.fillna(0.0)
    d['def_score_pre'] = d.def_score_pre.fillna(0.0)
    return d, dropped


def classify(d):
    """Play type and yards gained. Types are mutually exclusive in this feed
    (verified: 0 rows carry both a completion and a rush)."""
    comp = d.completion_player.notna()
    inc = d.incompletion_player.notna()
    rush = d.rush_player.notna()
    sack = d.sack_taken_player.notna()
    intc = d.interception_thrown_player.notna()

    d['is_pass'] = comp | inc | sack | intc
    d['is_rush'] = rush & ~d.is_pass
    d['is_scrimmage'] = d.is_pass | d.is_rush
    d['is_sack'] = sack
    d['is_dropback'] = d.is_pass

    gain = np.full(len(d), np.nan)
    gain = np.where(comp, d.completion_yds, gain)
    gain = np.where(inc, 0.0, gain)
    gain = np.where(intc, 0.0, gain)
    gain = np.where(sack, -np.abs(d.sack_taken_stat.fillna(0.0)), gain)
    gain = np.where(d.is_rush, d.rush_yds, gain)
    d['gain'] = gain

    d['turnover'] = (d.interception_thrown_player.notna()
                     | (d.fumble_player.notna() & d.fumble_recovered_player.notna())).astype(float)
    d['td'] = d.touchdown_player.notna().astype(float)
    d['fg_made'] = d.field_goal_made_player.notna().astype(float)
    d['fg_att'] = d.field_goal_attempt_player.notna().astype(float)

    d['success'] = _success(d.down.values, d.distance.values, d.gain.values)
    d['expl_pass'] = np.where(comp, (d.completion_yds >= EXPL_PASS_YDS).astype(float), np.nan)
    d['expl_rush'] = np.where(d.is_rush, (d.rush_yds >= EXPL_RUSH_YDS).astype(float), np.nan)
    d['stuffed'] = np.where(d.is_rush, (d.rush_yds <= STUFF_YDS).astype(float), np.nan)

    # EPA. Seconds remaining in the HALF (the surface's clock convention);
    # overtime carries 0, matching how cfbfastR's own model treats it.
    tsr = np.where(d.period.gt(4), 0.0,
                   np.where(d.period.mod(2).eq(1), 900.0, 0.0)
                   + d.clock_minutes.fillna(0) * 60.0 + d.clock_seconds.fillna(0))
    sd = (d.off_score_pre - d.def_score_pre).values
    ep_delta, ep0, ep1 = epa_calc(_SURFACE, d.down.values, d.distance.values,
                                  d.yards_to_goal.values, tsr, sd,
                                  np.nan_to_num(d.gain.values), d.td.values.astype(bool)
                                  if 'td' in d.columns else np.zeros(len(d), bool),
                                  d.turnover.values.astype(bool)
                                  if 'turnover' in d.columns else np.zeros(len(d), bool))
    d['epa'] = np.where(d.is_scrimmage & d.gain.notna(), ep_delta, np.nan)
    d['epa_pass'] = np.where(d.is_pass, d.epa, np.nan)
    d['epa_rush'] = np.where(d.is_rush, d.epa, np.nan)
    d['expl_epa'] = np.where(d.is_scrimmage, (d.epa >= EXPL_EPA).astype(float), np.nan)

    d['early_down'] = d.down.isin([1, 2])
    d['passing_down'] = ((d.down == 2) & (d.distance >= 8)) | (d.down.isin([3, 4]) & (d.distance >= 5))
    d['third_down'] = d.down.eq(3)
    d['fourth_down'] = d.down.eq(4) & d.is_scrimmage
    d['converted'] = np.where(d.down.isin([3, 4]) & d.is_scrimmage,
                              (d.gain >= d.distance).astype(float), np.nan)
    d['red_zone'] = d.yards_to_goal.le(20)

    margin = d.off_score_pre - d.def_score_pre
    thresh = d.period.map(GARBAGE).fillna(22)
    d['garbage'] = margin.abs() > thresh
    return d


def aggregate_offense(d):
    """One row per (game_id, off_team): what that offence did."""
    live = d[~d.garbage]
    scr = live[live.is_scrimmage]

    def agg(frame, keys):
        gp = frame.groupby(keys)
        return gp

    g = scr.groupby(['game_id', 'season', 'week', 'off_team', 'def_team'])
    out = g.agg(
        plays=('is_scrimmage', 'sum'),
        yards=('gain', 'sum'),
        success_rate=('success', 'mean'),
        dropbacks=('is_dropback', 'sum'),
        rushes=('is_rush', 'sum'),
        sacks_allowed=('is_sack', 'sum'),
        epa_per_play=('epa', 'mean'),
        epa_pass=('epa_pass', 'mean'),
        epa_rush=('epa_rush', 'mean'),
        expl_epa_rate=('expl_epa', 'mean'),
        expl_pass_rate=('expl_pass', 'mean'),
        expl_rush_rate=('expl_rush', 'mean'),
        stuff_rate=('stuffed', 'mean'),
        turnovers=('turnover', 'sum'),
        tds=('td', 'sum'),
    ).reset_index()
    out['yards_per_play'] = out.yards / out.plays.replace(0, np.nan)
    out['pass_rate'] = out.dropbacks / out.plays.replace(0, np.nan)
    out['sack_rate_allowed'] = out.sacks_allowed / out.dropbacks.replace(0, np.nan)

    ed = scr[scr.early_down].groupby(['game_id', 'off_team']).success.mean().rename('early_down_success')
    ede = scr[scr.early_down].groupby(['game_id', 'off_team']).epa.mean().rename('early_down_epa')
    pdn = scr[scr.passing_down].groupby(['game_id', 'off_team']).success.mean().rename('passing_down_success')
    t3 = scr[scr.third_down].groupby(['game_id', 'off_team']).converted.mean().rename('third_down_rate')
    t4 = scr[scr.fourth_down].groupby(['game_id', 'off_team']).converted.mean().rename('fourth_down_rate')
    t4n = scr[scr.fourth_down].groupby(['game_id', 'off_team']).converted.size().rename('fourth_down_att')
    rz = scr[scr.red_zone].groupby(['game_id', 'off_team']).success.mean().rename('red_zone_success')

    # drive-level: offensive drives only (punts are absent from this feed)
    dr = live.groupby(['game_id', 'off_team', 'drive_id']).agg(
        start_ytg=('yards_to_goal', 'first'),
        td=('td', 'max'), fg=('fg_made', 'max'), to=('turnover', 'max')).reset_index()
    dr['points'] = 7 * dr.td + 3 * dr.fg
    drv = dr.groupby(['game_id', 'off_team']).agg(
        drives=('drive_id', 'nunique'),
        points_per_drive=('points', 'mean'),
        start_field_position=('start_ytg', 'mean'),
        finish_rate=('td', 'mean')).reset_index()
    # "opportunity": drives reaching the opponent 40 (ytg <= 40) that score
    opp = live[live.yards_to_goal.le(40)].groupby(['game_id', 'off_team', 'drive_id']).td.max().reset_index()
    oppr = opp.groupby(['game_id', 'off_team']).td.mean().rename('opportunity_rate')

    for extra in (ed, ede, pdn, t3, t4, t4n, rz, oppr):
        out = out.merge(extra, on=['game_id', 'off_team'], how='left')
    out = out.merge(drv, on=['game_id', 'off_team'], how='left')

    # DEFENSIVE FRONT DISRUPTION, credited to the defence.
    #
    # This is deliberately NOT the classic havoc rate. Havoc needs pass
    # break-ups, interceptions and forced fumbles, and every one of those
    # columns has season-scale coverage collapses in this feed: defence-
    # credited sacks run 0.07 per team-game in 2014 against 1.71 in 2018,
    # pass break-ups all but vanish 2020-2024, and interceptions thrown run
    # 0.87 (2014) / 0.17 (2023) / 0.65 (2025). Those are data artefacts, not
    # defences changing, and an EWMA fed on them would learn the feed's
    # release history.
    #
    # Sacks TAKEN (offence-side attribution) and stuffed runs (derived from
    # rushing yardage) are stable across the whole window, so the metric is
    # built from those two and named for what it actually measures.
    hav = live.groupby(['game_id', 'def_team']).agg(
        hv_sacks=('is_sack', 'sum'),
        hv_stuffs=('stuffed', 'sum'),
        hv_plays=('is_scrimmage', 'sum')).reset_index()
    hav['front_disruption_rate'] = ((hav.hv_sacks + hav.hv_stuffs)
                                    / hav.hv_plays.replace(0, np.nan))
    out = out.merge(hav[['game_id', 'def_team', 'front_disruption_rate']],
                    on=['game_id', 'def_team'], how='left')
    return out


def aggregate_qb(d):
    """Per game per team: the quarterback who actually took the dropbacks, and
    what those dropbacks were worth.

    No depth chart exists in any public feed, so 'the starter' is defined as
    the player with the most dropbacks in the game. That is an observation,
    not an assumption, and games where no dropback is attributed simply have
    no QB row rather than a guessed one."""
    live = d[~d.garbage & d.is_dropback].copy()
    qid = live.completion_player_id
    qid = qid.fillna(live.incompletion_player_id)
    qid = qid.fillna(live.sack_taken_player_id)
    qid = qid.fillna(live.interception_thrown_player_id)
    qnm = live.completion_player.fillna(live.incompletion_player) \
              .fillna(live.sack_taken_player).fillna(live.interception_thrown_player)
    live['qb_id'] = pd.to_numeric(qid, errors='coerce')
    live['qb_name'] = qnm
    live = live[live.qb_id.notna()]
    if not len(live):
        return pd.DataFrame()
    g = live.groupby(['game_id', 'season', 'week', 'off_team', 'qb_id', 'qb_name']).agg(
        dropbacks=('epa', 'size'), epa_sum=('epa', 'sum'), epa_mean=('epa', 'mean'),
        sacks=('is_sack', 'sum'), ints=('interception_thrown_player', lambda s: int(s.notna().sum())),
        success=('success', 'mean')).reset_index()
    g = g.sort_values('dropbacks')
    primary = g.groupby(['game_id', 'off_team'], as_index=False).last()
    share = g.groupby(['game_id', 'off_team']).dropbacks.sum().rename('team_dropbacks').reset_index()
    primary = primary.merge(share, on=['game_id', 'off_team'], how='left')
    primary['dropback_share'] = primary.dropbacks / primary.team_dropbacks.replace(0, np.nan)
    return primary


def to_team_game(off):
    """Pivot the offensive rows into one row per (game, team) carrying both
    that team's offence and the defence it played against."""
    o = off.rename(columns={'off_team': 'team', 'def_team': 'opponent'}).copy()
    OFF_COLS = ['plays', 'yards', 'yards_per_play', 'epa_per_play', 'epa_pass', 'epa_rush',
                'expl_epa_rate', 'early_down_epa', 'success_rate', 'early_down_success',
                'passing_down_success', 'expl_pass_rate', 'expl_rush_rate', 'stuff_rate',
                'pass_rate', 'sack_rate_allowed', 'third_down_rate', 'fourth_down_rate',
                'red_zone_success', 'turnovers', 'points_per_drive', 'drives',
                'start_field_position', 'finish_rate', 'opportunity_rate',
                'front_disruption_rate']
    cols = [c for c in OFF_COLS if c in o.columns]
    o = o[['game_id', 'season', 'week', 'team', 'opponent'] + cols]
    # the mirror: what a team ALLOWED is literally what its opponent's
    # offence did, so the defensive half of the row is the same numbers read
    # from the other side. Renaming is explicit, never positional.
    d = o.rename(columns=dict([('team', 'opponent'), ('opponent', 'team')]
                              + [(c, 'def_' + c) for c in cols]))
    merged = o.merge(d, on=['game_id', 'season', 'week', 'team', 'opponent'], how='outer')
    lone = int(merged[cols[0]].isna().sum() + merged['def_' + cols[0]].isna().sum())
    if lone:
        print('[note] %d team-game rows have only one side of the ball attributed '
              '(the other offence produced no anchorable drive); their missing half '
              'stays NaN rather than being imputed' % lone)
    return merged


def main():
    os.makedirs(OUT, exist_ok=True)
    global _SURFACE
    sp = os.path.join(OUT, 'ep_surface.json')
    if not os.path.exists(sp):
        raise SystemExit('run ep_surface.py fit %s first' % OUT)
    _SURFACE = EPSurface(sp)
    frames, qframes, notes = [], [], []
    for y in range(Y0, Y1 + 1):
        d = load_season(y)
        if d is None:
            notes.append('%d: player_stats not published' % y)
            continue
        d, dropped = anchor_drives(d)
        d = classify(d)
        off = aggregate_offense(d)
        frames.append(off)
        q = aggregate_qb(d)
        if len(q):
            qframes.append(q)
        gb = float(d.garbage.mean())
        pg = max(1.0, len(off))
        print('[%d] plays=%d drives_unanchored=%d garbage_share=%.3f team_games=%d '
              '| per team-game, UNSTABLE columns not used: pbu=%.2f int=%.2f ff=%.2f'
              % (y, len(d), dropped, gb, len(off),
                 d.pass_breakup_player.notna().sum() / pg,
                 d.interception_player.notna().sum() / pg,
                 d.fumble_forced_player.notna().sum() / pg))
    if not frames:
        raise SystemExit('no player_stats found under %s/pstats' % common.DATA)
    off = pd.concat(frames, ignore_index=True)

    # Season-centre EPA. The surface is frozen but scoring environments are
    # not, and the reconstruction carries a season-level level shift of up to
    # 0.08 EPA/play. Centring removes the level and keeps the spread, which
    # is the quantity the ratings actually use. The raw column is kept so the
    # shift itself stays inspectable rather than hidden.
    off['epa_per_play_raw'] = off.epa_per_play
    shift = off.groupby('season').epa_per_play.transform('mean')
    off['epa_per_play'] = off.epa_per_play - shift
    print('[centre] season EPA/play level shift removed:')
    print(off.groupby('season').epa_per_play_raw.mean().round(4).to_string())

    tg = to_team_game(off)

    # reconcile against the schedules: every team-game must be a real game
    g = common.load_schedules()[['game_id', 'home_team', 'away_team', 'home_points',
                                 'away_points', 'home_division', 'away_division']]
    tg['team_key'] = tg.team.map(common.norm)
    tg['opp_key'] = tg.opponent.map(common.norm)
    tg = tg.merge(g, on='game_id', how='left')
    matched = tg.home_team.notna().mean()
    print('[reconcile] team-games matched to a scheduled game: %.4f' % matched)

    if qframes:
        qg = pd.concat(qframes, ignore_index=True)
        qg['team_key'] = qg.off_team.map(common.norm)
        qg.to_csv(os.path.join(OUT, 'qb_game.csv'), index=False)
        print('[write] %s/qb_game.csv  rows=%d  distinct QBs=%d'
              % (OUT, len(qg), qg.qb_id.nunique()))

    tg.to_csv(os.path.join(OUT, 'team_game.csv'), index=False)
    print('[write] %s/team_game.csv  rows=%d seasons=%d-%d'
          % (OUT, len(tg), int(tg.season.min()), int(tg.season.max())))
    for n in notes:
        print('[note]', n)


if __name__ == '__main__':
    main()
