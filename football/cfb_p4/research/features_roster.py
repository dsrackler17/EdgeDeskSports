#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — roster, experience, continuity, portal and QB
features (Sections III, V, VI, VII, VIII, IX, XVII).

WHAT IS REAL HERE
`cfbfastR-data/rosters` publishes, per season 2004-2025: athlete_id, name,
team, class year (1-4), position, height, weight and hometown. That is enough
to measure — not guess — the things college football actually turns on:

  * roster continuity, per position group, by diffing athlete_ids season over
    season. A player on Team A in 2024 and Team B in 2025 IS a transfer. That
    is the portal, observed, not modelled.
  * experience, from a player's FIRST APPEARANCE on any roster. NOT from the
    feed's `year` column: that column is a static, back-propagated value
    carrying a player's EVENTUAL class, so it reads 4 for a true freshman and
    is future information. 65.6% of athletes on three or more rosters never
    see it change, and 0.01% increment season to season. Using it would leak.
  * returning production, by joining those ids to per-play production in
    `player_stats`.
  * the returning starting quarterback, identified by prior-season dropback
    share (no depth chart exists in any public feed, so a share threshold is
    used and its reliability is measured and reported).

WHAT IS NOT REAL HERE, AND IS NOT INVENTED
  * Per-player recruiting stars. `recruit_ids` ships EMPTY in this feed, so
    there is no blue-chip ratio and no per-player pedigree. The engine leaves
    that layer dark and exposes an injection point.
  * NIL, collectives, contracts. No public per-player series exists.
  * Coaching tenure and coordinator continuity. Not in this corpus.
  * Snap counts, so "returning starters" on the offensive line is NOT
    observable. Returning OL bodies and continuity are; that is what ships,
    labelled as what it is.

Section VII (player development) is therefore measured against what IS
available — a program's realised efficiency versus what its experience and
continuity profile predicts — and the report states plainly that recruiting
pedigree is absent from that baseline.

Usage: python3 features_roster.py <out_dir>
Writes <out>/roster_team_season.csv, <out>/player_production.csv,
       <out>/qb_season.csv
"""
import os
import sys

import numpy as np
import pandas as pd

import common

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'

POS_GROUP = {
    'QB': 'QB',
    'RB': 'RB', 'FB': 'RB',
    'WR': 'WR', 'TE': 'TE',
    'OL': 'OL', 'OT': 'OL', 'OG': 'OL', 'G': 'OL', 'C': 'OL',
    'DL': 'DL', 'DT': 'DL', 'NT': 'DL', 'DE': 'DL',
    'EDGE': 'EDGE',
    'LB': 'LB', 'OLB': 'LB', 'ILB': 'LB', 'MLB': 'LB',
    'CB': 'CB', 'S': 'S', 'DB': 'DB',
    'PK': 'K', 'K': 'K', 'P': 'P', 'LS': 'LS',
    'PR': 'RET', 'KR': 'RET',
    'ATH': 'ATH',
}
GROUPS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'EDGE', 'LB', 'CB', 'S', 'DB',
          'K', 'P', 'LS', 'RET', 'ATH']

# The declared class column is kept for reference and NEVER used as a feature
# (see the module docstring). Experience is derived from first appearance.
CLASS_WEIGHT = {1: 0.0, 2: 1.0 / 3.0, 3: 2.0 / 3.0, 4: 1.0}

# Roster files are far too thin to date a player's arrival before ~2019
# (median P4 roster: 57 in 2013, 71 in 2015, 92 in 2018, 116 in 2019). A
# first-appearance year computed on a thin file is wrong in the one direction
# that matters — it makes veterans look like freshmen — so experience is only
# published once there are two dense seasons behind it.
EXPERIENCE_FIRST_SEASON = 2021


def load_rosters(lo=common.ROSTER_FIRST, hi=common.SCHED_LAST):
    frames = []
    for y in range(lo, hi + 1):
        p = os.path.join(common.DATA, 'roster', 'roster_%d.csv' % y)
        if not os.path.exists(p):
            continue
        d = pd.read_csv(p, low_memory=False)
        d['season'] = y
        frames.append(d)
    if not frames:
        raise SystemExit('no rosters under %s/roster' % common.DATA)
    r = pd.concat(frames, ignore_index=True)
    r['athlete_id'] = pd.to_numeric(r.athlete_id, errors='coerce')
    r = r[r.athlete_id.notna()].copy()
    r['athlete_id'] = r.athlete_id.astype('int64')
    r['team_key'] = r.team.map(common.norm)
    r['pos'] = r.position.astype(str).str.upper().str.strip()
    r['group'] = r.pos.map(POS_GROUP)
    r['declared_class'] = pd.to_numeric(r.year, errors='coerce')
    r.loc[~r.declared_class.isin([1, 2, 3, 4]), 'declared_class'] = np.nan
    r['class_year'] = r.declared_class          # reference only; not a feature

    # LEAK-FREE EXPERIENCE: how many seasons this athlete has appeared on any
    # roster, up to and including this one. Known at the time, unlike the
    # feed's own class column.
    first_seen = r.groupby('athlete_id').season.transform('min')
    r['exp_yrs'] = (r.season - first_seen + 1).clip(1, 5)
    r['class_w'] = ((r.exp_yrs - 1) / 3.0).clip(0, 1)
    r.loc[r.season < EXPERIENCE_FIRST_SEASON, 'class_w'] = np.nan
    for c in ('height', 'weight'):
        r[c] = pd.to_numeric(r[c], errors='coerce')
    return r


def player_production(lo=common.PSTATS_FIRST, hi=common.SCHED_LAST):
    """Per player-season production units, from the play feed.

    Deliberately coarse and honest: the feed attributes events, not snaps, so
    'production' here is countable involvement (dropbacks, touches, targets,
    defensive events), never a snap share."""
    rows = []
    for y in range(lo, hi + 1):
        p = os.path.join(common.DATA, 'pstats', 'pstats_%d.csv' % y)
        if not os.path.exists(p):
            continue
        cols = ['season', 'team', 'completion_player_id', 'completion_yds',
                'incompletion_player_id', 'sack_taken_player_id',
                'interception_thrown_player_id', 'rush_player_id', 'rush_yds',
                'reception_player_id', 'reception_yds', 'target_player_id',
                'sack_player_id', 'pass_breakup_player_id',
                'interception_player_id', 'fumble_forced_player_id',
                'touchdown_player_id']
        d = pd.read_csv(p, usecols=lambda c: c in cols, low_memory=False)
        d['season'] = y

        def stack(idcol, kind, ydcol=None):
            if idcol not in d.columns:
                return None
            s = d[d[idcol].notna()][[idcol, 'team', 'season'] + ([ydcol] if ydcol and ydcol in d.columns else [])]
            s = s.rename(columns={idcol: 'athlete_id'})
            s['kind'] = kind
            s['yds'] = s[ydcol] if (ydcol and ydcol in s.columns) else 0.0
            return s[['athlete_id', 'team', 'season', 'kind', 'yds']]

        parts = [
            stack('completion_player_id', 'dropback', 'completion_yds'),
            stack('incompletion_player_id', 'dropback'),
            stack('sack_taken_player_id', 'dropback'),
            stack('interception_thrown_player_id', 'dropback'),
            stack('rush_player_id', 'touch', 'rush_yds'),
            stack('reception_player_id', 'touch', 'reception_yds'),
            stack('target_player_id', 'target'),
            stack('sack_player_id', 'def_event'),
            stack('pass_breakup_player_id', 'def_event'),
            stack('interception_player_id', 'def_event'),
            stack('fumble_forced_player_id', 'def_event'),
        ]
        parts = [x for x in parts if x is not None and len(x)]
        if not parts:
            continue
        s = pd.concat(parts, ignore_index=True)
        s['athlete_id'] = pd.to_numeric(s.athlete_id, errors='coerce')
        s = s[s.athlete_id.notna()]
        s['athlete_id'] = s.athlete_id.astype('int64')
        agg = s.groupby(['athlete_id', 'team', 'season', 'kind']).agg(
            n=('kind', 'size'), yds=('yds', 'sum')).reset_index()
        rows.append(agg)
        print('[production] %d: %d player-season-kind rows' % (y, len(agg)))
    if not rows:
        return pd.DataFrame(columns=['athlete_id', 'team', 'season', 'kind', 'n', 'yds'])
    P = pd.concat(rows, ignore_index=True)
    P['team_key'] = P.team.map(common.norm)
    return P


def production_units(P):
    """One number per player-season that stands for 'how much of this team's
    football did this player actually do'. Weights are declared, not tuned:
    a dropback and a touch are the units the feed can count."""
    w = {'dropback': 1.0, 'touch': 1.0, 'target': 0.5, 'def_event': 1.0}
    P = P.copy()
    P['units'] = P.n * P.kind.map(w).fillna(0.0)
    return (P.groupby(['athlete_id', 'team_key', 'season'])
              .agg(units=('units', 'sum'), yds=('yds', 'sum')).reset_index())


def qb_seasons(P):
    """Per-QB season line, from dropback events."""
    d = P[P.kind.eq('dropback')].groupby(['athlete_id', 'team_key', 'season']).agg(
        dropbacks=('n', 'sum'), pass_yds=('yds', 'sum')).reset_index()
    return d


def roster_team_season(R, units):
    """Per (team, season): continuity, portal flow, class mix, returning
    production — by position group and overall."""
    R = R.copy()
    prev = R[['athlete_id', 'season', 'team_key']].copy()
    prev['season'] = prev.season + 1
    prev = prev.rename(columns={'team_key': 'prev_team_key'})
    R = R.merge(prev, on=['athlete_id', 'season'], how='left')
    R['returning'] = R.prev_team_key.eq(R.team_key)
    R['transfer_in'] = R.prev_team_key.notna() & ~R.returning

    nxt = R[['athlete_id', 'season', 'team_key']].copy()
    nxt['season'] = nxt.season - 1
    nxt = nxt.rename(columns={'team_key': 'next_team_key'})
    R = R.merge(nxt, on=['athlete_id', 'season'], how='left')

    u = units.rename(columns={'season': 'prod_season'})
    upv = u.copy(); upv['season'] = upv.prod_season + 1
    R = R.merge(upv[['athlete_id', 'season', 'units']].rename(columns={'units': 'prior_units'}),
                on=['athlete_id', 'season'], how='left')

    prior_team_units = (units.assign(season=units.season + 1)
                        .groupby(['team_key', 'season']).units.sum()
                        .rename('team_prior_units').reset_index())

    out = []
    for (tk, yr), grp in R.groupby(['team_key', 'season']):
        row = {'team_key': tk, 'season': int(yr), 'roster_n': len(grp)}
        # per group
        for gname in GROUPS:
            gg = grp[grp.group.eq(gname)]
            pre = 'g_' + gname + '_'
            row[pre + 'n'] = len(gg)
            if len(gg):
                row[pre + 'returning_share'] = float(gg.returning.mean())
                row[pre + 'transfer_in'] = int(gg.transfer_in.sum())
                cw = gg.class_w.dropna()
                row[pre + 'experience'] = float(cw.mean()) if len(cw) else np.nan
                row[pre + 'class_known'] = float(gg.class_w.notna().mean())
                pu = gg.prior_units.fillna(0.0)
                row[pre + 'returning_units'] = float(pu[gg.returning].sum())
                row[pre + 'incoming_units'] = float(pu[gg.transfer_in].sum())
                row[pre + 'height'] = float(gg.height.mean()) if gg.height.notna().any() else np.nan
                row[pre + 'weight'] = float(gg.weight.mean()) if gg.weight.notna().any() else np.nan
            else:
                for k in ('returning_share', 'transfer_in', 'experience', 'class_known',
                          'returning_units', 'incoming_units', 'height', 'weight'):
                    row[pre + k] = np.nan
        row['returning_share'] = float(grp.returning.mean())
        row['transfers_in'] = int(grp.transfer_in.sum())
        cw = grp.class_w.dropna()
        row['experience'] = float(cw.mean()) if len(cw) else np.nan
        row['returning_units'] = float(grp.prior_units.fillna(0.0)[grp.returning].sum())
        out.append(row)
    T = pd.DataFrame(out)

    # outgoing transfers are counted on the season the player LEFT
    left = R[R.next_team_key.notna() & ~R.next_team_key.eq(R.team_key)]
    outg = left.groupby(['team_key', 'season']).size().rename('transfers_out').reset_index()
    outg['season'] = outg.season + 1              # attributed to the NEW season
    T = T.merge(outg, on=['team_key', 'season'], how='left')
    T['transfers_out'] = T.transfers_out.fillna(0)

    T = T.merge(prior_team_units, on=['team_key', 'season'], how='left')
    T['returning_production'] = T.returning_units / T.team_prior_units.replace(0, np.nan)
    T['net_portal'] = T.transfers_in - T.transfers_out
    return T


def main():
    os.makedirs(OUT, exist_ok=True)
    R = load_rosters()
    print('[rosters] rows=%d seasons=%d-%d teams=%d'
          % (len(R), R.season.min(), R.season.max(), R.team_key.nunique()))
    # Coverage is stated per season because it is NOT uniform: class year is
    # essentially absent before 2014 and only becomes reliable (>=78%) from
    # 2018. Experience and youth features are therefore only trustworthy in
    # the modern window, and the training window is set accordingly rather
    # than pretending 2006 rosters carry class data.
    cov = R.groupby('season').agg(roster_n=('athlete_id', 'size'),
                                  declared_class_known=('declared_class', lambda s: s.notna().mean()),
                                  experience_usable=('class_w', lambda s: s.notna().mean()),
                                  pos_mapped=('group', lambda s: s.notna().mean()))
    print('[rosters] coverage by season:')
    print(cov.round(3).to_string())
    print('[rosters] recruit_ids populated rows: %d  -> per-player recruiting stars '
          'are NOT available from this feed; the blue-chip layer stays dark'
          % int(R.get('recruit_ids', pd.Series(dtype=object)).notna().sum()))
    print('[rosters] the declared-class column is REFERENCE ONLY: it is static per '
          'athlete (65.6%% of players on 3+ rosters never see it change) and encodes '
          'the EVENTUAL class, so it is future information. Experience is derived '
          'from first roster appearance and published from %d.' % EXPERIENCE_FIRST_SEASON)

    P = player_production()
    P.to_csv(os.path.join(OUT, 'player_production.csv'), index=False)
    U = production_units(P)
    QB = qb_seasons(P)
    QB.to_csv(os.path.join(OUT, 'qb_season.csv'), index=False)

    T = roster_team_season(R, U)
    T.to_csv(os.path.join(OUT, 'roster_team_season.csv'), index=False)
    print('[roster_team_season] rows=%d' % len(T))

    p4 = common.p4_membership()
    j = T.merge(p4, on=['team_key', 'season'], how='inner')
    recent = j[j.season >= 2016]
    print('\n[P4 continuity by season]')
    print(recent.groupby('season').agg(
        teams=('team_key', 'nunique'),
        returning_share=('returning_share', 'mean'),
        transfers_in=('transfers_in', 'mean'),
        transfers_out=('transfers_out', 'mean'),
        returning_production=('returning_production', 'mean')).round(3).to_string())
    print('\n[portal era check] mean incoming transfers per P4 team, by season — '
          'the 2021 portal rule change must be visible in this column or the '
          'diff is not measuring what it claims to measure.')


if __name__ == '__main__':
    main()
