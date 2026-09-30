#!/usr/bin/env python3
"""EdgeDesk CFB — the REGIME-CHANGE history: who changed head coach, and how
much of the roster and of last season's production came back, per FBS
team-season.

WHY THIS EXISTS. The production pricing state carries a long-run rating that
was trained through 2025 and blended against a this-season-only track on ONE
learned prior-weight curve (100% long-run through 3 games, 80% at 4-5, 60% at
6+). For a programme that replaced its head coach AND most of its roster in
the same winter — Iowa State and North Texas in 2026 — the long-run state is
describing a different team. The fix is a separate, steeper curve for those
team-seasons, and a curve is only allowed to exist here if it was FITTED
walk-forward on past seasons with the same kind of change. This file builds
the table that fit runs on (research/regime_backtest.js).

WHAT IS MEASURED, AND FROM WHERE (all public, all already in the pipeline):
  * head coach per team-season   cfbfastR-cfb-data coach_tendencies, 2005+
                                 (one row per team per season, role HC)
  * roster continuity            cfbfastR-data rosters, athlete_id diffed
                                 season over season (features_roster.py's own
                                 definition: same team both seasons)
  * portal outflow               on this team last season, on another
                                 covered team now (features_roster.py)
  * returning production         share of last season's countable
                                 production (dropbacks, touches, targets,
                                 defensive events; features_roster.py's
                                 declared units) by players on this season's
                                 roster, 2015+ (player_stats starts 2014)
  * portal INFLOW, production-   the same units, produced LAST season at
    weighted (audit 2026-09-30   ANOTHER programme by players on this
    follow-up)                   season's roster, as a share of this
                                 programme's own last-season production.
                                 Measured, not a recruiting rating: no
                                 rating-weighted portal feed is public and
                                 keyless (CollegeFootballData's needs a key),
                                 and this misses FCS/JUCO arrivals and
                                 players who did not play
  * the quarterback              last season's PRIMARY QB (most dropbacks for
                                 this programme), whether he is on this
                                 season's roster, and every team-game's
                                 starter (most dropbacks in that game), so a
                                 walk-forward can ask "is the QB who started
                                 the last game last season's QB?" using only
                                 games already played (qb_starts.csv)

NEW HEAD COACH, DEFINED AS THE ENGINE ASKS IT: the tenure began THIS season.
The coach table drops a team in a season it changed coach mid-year (Penn
State and Oklahoma State have no 2025 row), so a missing previous season is
not read as "unknown" when the data can settle it: if this season's coach was
the head coach of a DIFFERENT programme last season, his tenure here began
this season. Anything the data cannot settle stays null — never guessed.

THE CONTINUITY SCALE DRIFTS (P4 returning share fell from 0.67 to 0.43 over
the portal decade, and roster files are thin before ~2016), so every
continuity measure also ships as a within-season percentile among the FBS
teams that season. The signal is defined on the percentile, so a 2012 team
and a 2026 team are compared with their own seasons.

Usage:  CFB_P4_DATA=.cache python3 build_regime_history.py .cache/out
        CFB_P4_DATA=.cache python3 build_regime_history.py .cache/out --current 2026
                 (the season in progress: football/coaching/returning_production_2026.json)
Writes: <out>/regime_history.csv, <out>/qb_starts.csv
"""
import glob
import os
import re
import sys

import numpy as np
import pandas as pd

import common
import features_roster as FR

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
COACH_FIRST = 2005


def _coach_name(s):
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return None
    return re.sub(r'[^a-z]+', '', str(s).lower()) or None


def load_coaches():
    rows = []
    for p in sorted(glob.glob(os.path.join(common.DATA, 'coach', 'coach_*.parquet'))):
        d = pd.read_parquet(p, columns=['season', 'pos_team_id', 'pos_team', 'coach', 'role', 'games'])
        rows.append(d)
    if not rows:
        raise SystemExit('no coach tables under %s/coach — fetch coach_tendencies_<season>.parquet first' % common.DATA)
    c = pd.concat(rows, ignore_index=True)
    c = c[c.role.astype(str).str.upper().eq('HC')].copy()
    c['season'] = pd.to_numeric(c.season, errors='coerce').astype('Int64')
    c['team_id'] = pd.to_numeric(c.pos_team_id, errors='coerce').astype('Int64')
    c['coach_key'] = c.coach.map(_coach_name)
    c['games'] = pd.to_numeric(c.games, errors='coerce').fillna(0)
    # one primary head coach per team-season: the one who coached most games
    c = c.sort_values(['team_id', 'season', 'games'], ascending=[True, True, False])
    prim = c.groupby(['team_id', 'season'], as_index=False).first()
    multi = c.groupby(['team_id', 'season']).size().rename('hc_rows').reset_index()
    return prim.merge(multi, on=['team_id', 'season'], how='left')


def team_ids():
    """ESPN team id -> this season's schedule name and key, from the schedules
    themselves (the coach table carries display names with mascots)."""
    g = common.load_schedules(lo=2004, hi=2026)
    parts = []
    for side in ('home', 'away'):
        s = g[['season', side + '_id', side + '_team', side + '_division']].copy()
        s.columns = ['season', 'team_id', 'team', 'division']
        parts.append(s)
    t = pd.concat(parts, ignore_index=True).dropna(subset=['team_id'])
    t['team_id'] = pd.to_numeric(t.team_id, errors='coerce').astype('Int64')
    t['team_key'] = t.team.map(common.norm)
    t = t.drop_duplicates(['season', 'team_id'])
    return t


def new_head_coach(C):
    """new_hc per (team_id, season): the tenure began this season."""
    by_team = {}
    for r in C.itertuples(index=False):
        by_team.setdefault(int(r.team_id), {})[int(r.season)] = r
    hc_at = {}          # (season, coach_key) -> set(team_id): who was HC where
    for r in C.itertuples(index=False):
        if r.coach_key:
            hc_at.setdefault((int(r.season), r.coach_key), set()).add(int(r.team_id))
    out = []
    for tid, seasons in by_team.items():
        for s, r in seasons.items():
            prev = seasons.get(s - 1)
            ck = r.coach_key
            new, basis, prev_name = None, None, None
            if s <= COACH_FIRST:
                basis = 'first season of the coach table: no previous season to compare'
            elif prev is not None:
                prev_name = prev.coach
                new = bool(ck and prev.coach_key and ck != prev.coach_key)
                basis = ('head coach changed from ' + str(prev.coach)) if new else 'same head coach as last season'
            else:
                elsewhere = sorted(hc_at.get((s - 1, ck), set()) - {tid}) if ck else []
                if elsewhere:
                    new = True
                    basis = ('no %d row for this programme (a mid-season change drops it from the table); '
                             'this season\'s coach was head coach of team %s in %d, so his tenure here began in %d'
                             % (s - 1, ','.join(str(x) for x in elsewhere), s - 1, s))
                else:
                    older = [seasons[y] for y in sorted(seasons) if y < s - 1]
                    if older and ck and older[-1].coach_key == ck:
                        new = False
                        basis = 'no %d row; same head coach as %d' % (s - 1, int(older[-1].season))
                    else:
                        basis = 'no %d row and nothing else settles it: unknown, not continuous' % (s - 1)
            out.append({'team_id': tid, 'season': s, 'coach': r.coach, 'prev_coach': prev_name,
                        'new_hc': new, 'new_hc_basis': basis, 'hc_rows': int(r.hc_rows)})
    return pd.DataFrame(out)


def continuity():
    R = FR.load_rosters(lo=2004, hi=2025)
    try:
        P = FR.player_production(lo=common.PSTATS_FIRST, hi=2025)
        U = FR.production_units(P)
    except Exception as e:                       # production is optional; continuity is not
        print('[regime] player production unavailable (%s) — returning production stays null' % e)
        U = pd.DataFrame(columns=['athlete_id', 'team_key', 'season', 'units', 'yds'])
    T = FR.roster_team_season(R, U)
    # portal INFLOW, production-weighted: what the arrivals produced last season
    # at their previous programme, over this programme's own last-season total
    inc = [c for c in T.columns if c.startswith('g_') and c.endswith('_incoming_units')]
    T['incoming_units'] = T[inc].fillna(0.0).sum(axis=1)
    T['incoming_production'] = T.incoming_units / T.team_prior_units.replace(0, np.nan)
    return T[['team_key', 'season', 'roster_n', 'returning_share', 'transfers_in', 'transfers_out',
              'returning_production', 'incoming_production']], R


DROPBACK_COLS = ('completion_player_id', 'incompletion_player_id', 'sack_taken_player_id',
                 'interception_thrown_player_id')


def qb_tables(lo, hi):
    """Two quarterback tables from the play feed (dropbacks = completions,
    incompletions, sacks taken, interceptions thrown, as features_roster.py
    counts them):
      starts   one row per team-game: the athlete with the most dropbacks in
               that game (the game's starter as observed, never announced)
      primary  one row per team-season: the athlete with the most dropbacks
               for that programme that season, and his share of them"""
    parts = []
    for y in range(lo, hi + 1):
        p = os.path.join(common.DATA, 'pstats', 'pstats_%d.csv' % y)
        if not os.path.exists(p):
            continue
        d = pd.read_csv(p, usecols=lambda c: c in ('game_id', 'week', 'team') + DROPBACK_COLS, low_memory=False)
        s = pd.concat([d[['game_id', 'week', 'team', c]].rename(columns={c: 'athlete_id'}) for c in DROPBACK_COLS
                       if c in d.columns], ignore_index=True)
        s['athlete_id'] = pd.to_numeric(s.athlete_id, errors='coerce')
        s = s[s.athlete_id.notna()]
        s['athlete_id'] = s.athlete_id.astype('int64')
        s['season'] = y
        parts.append(s.groupby(['season', 'game_id', 'week', 'team', 'athlete_id']).size().rename('dropbacks').reset_index())
    if not parts:
        return pd.DataFrame(), pd.DataFrame()
    Q = pd.concat(parts, ignore_index=True)
    Q['team_key'] = Q.team.map(common.norm)
    starts = (Q.sort_values(['season', 'game_id', 'team_key', 'dropbacks'], ascending=[True, True, True, False])
               .groupby(['season', 'game_id', 'team_key'], as_index=False).first()
               [['season', 'game_id', 'week', 'team_key', 'athlete_id', 'dropbacks']]
               .rename(columns={'athlete_id': 'starter_id'}))
    tot = Q.groupby(['season', 'team_key', 'athlete_id']).dropbacks.sum().reset_index()
    team_tot = tot.groupby(['season', 'team_key']).dropbacks.sum().rename('team_dropbacks').reset_index()
    primary = (tot.sort_values(['season', 'team_key', 'dropbacks'], ascending=[True, True, False])
                .groupby(['season', 'team_key'], as_index=False).first()
                .merge(team_tot, on=['season', 'team_key'], how='left'))
    primary['primary_share'] = primary.dropbacks / primary.team_dropbacks.replace(0, np.nan)
    return starts, primary.rename(columns={'athlete_id': 'primary_qb_id'})[['season', 'team_key', 'primary_qb_id', 'primary_share']]


def pct_within_season(df, col, mask):
    """percentile rank (0..1) of `col` among the rows in `mask`, per season"""
    out = pd.Series(np.nan, index=df.index)
    for s, idx in df[mask].groupby('season').groups.items():
        v = df.loc[idx, col]
        ok = v.notna()
        if ok.sum() >= 20:
            out.loc[v[ok].index] = v[ok].rank(pct=True)
    return out


def current_returning_production(season, repo_root):
    """RETURNING PRODUCTION for the season in progress: the share of last
    season's countable production (features_roster.py's declared units, from
    cfbfastR player_stats) made FOR this programme by players on its current
    roster in EdgeDesk's own ESPN roster sync (athlete ids are ESPN ids in both).

        returning_production(T) = units produced for T last season by players
                                  on T's roster now  /  all units produced
                                  for T last season

    The team a unit belongs to is the PLAY FEED's attribution, not last
    season's ESPN roster file: fbs_2025_espn.json was synced in August 2026 and
    lists 2,298 athletes on two programmes (Preston Stone under Northwestern
    AND SMU), so it cannot say which team a player produced for.
    Written to football/coaching/returning_production_<season>.json, which
    football/coaching/build_regime.js reads. A team with no attributed
    production last season is null, never zero."""
    import json
    cur_p = os.path.join(repo_root, 'football', 'rosters', 'fbs_%d_espn.json' % season)
    if not os.path.exists(cur_p):
        print('[regime] ESPN roster for %d not found — returning production not written' % season)
        return None
    cur = json.load(open(cur_p))
    P = FR.player_production(lo=season - 1, hi=season - 1)
    if not len(P):
        print('[regime] no %d player_stats — returning production not written' % (season - 1))
        return None
    U = FR.production_units(P)
    keys = set(U.team_key.unique())
    _, primary = qb_tables(season - 1, season - 1)
    prim = {r.team_key: {'id': int(r.primary_qb_id), 'share': float(r.primary_share)} for r in primary.itertuples(index=False)}
    by_team = {}
    for t in cur.get('teams', []):
        nm = t.get('location') or t.get('display_name') or ''
        cands = [common.norm(t.get(f)) for f in ('location', 'display_name', 'short_name', 'abbreviation') if t.get(f)]
        tk = next((c for c in cands if c in keys), None)
        if not tk:
            by_team[nm] = {'team': nm, 'returning_production': None,
                           'why': 'no %d production is attributed to this programme in the play feed' % (season - 1)}
            continue
        u = U[U.team_key.eq(tk)]
        now_ids = set(int(p['espn_id']) for p in t.get('players', [])
                      if p.get('espn_id') is not None and str(p['espn_id']).lstrip('-').isdigit())
        prior = float(u.units.sum())
        ret = float(u[u.athlete_id.isin(now_ids)].units.sum())
        # portal INFLOW, production-weighted: last season's units produced at
        # ANOTHER programme by players on this roster now
        inc = float(U[U.athlete_id.isin(now_ids) & ~U.team_key.eq(tk)].units.sum())
        top = u.sort_values('units', ascending=False).head(5)
        pq = prim.get(tk)
        by_team[nm] = {'team': nm, 'play_feed_key': tk, 'prior_units': round(prior, 1), 'returning_units': round(ret, 1),
                       'returning_production': round(ret / prior, 4) if prior > 0 else None,
                       'incoming_units': round(inc, 1),
                       'incoming_production': round(inc / prior, 4) if prior > 0 else None,
                       'prev_primary_qb_id': str(pq['id']) if pq else None,
                       'prev_primary_qb_share': round(pq['share'], 4) if pq else None,
                       'returning_qb': (pq['id'] in now_ids) if pq else None,
                       'top_prior_producers_returning': int(top.athlete_id.isin(now_ids).sum()),
                       'why': None if prior > 0 else 'no %d production attributed to this programme' % (season - 1)}
    out = {'schema': 'edgedesk_returning_production_v2', 'season': season,
           'generated_at': pd.Timestamp.now('UTC').isoformat(),
           'source': 'cfbfastR-data player_stats %d (production units, team as attributed by the play feed) x '
                     'EdgeDesk ESPN roster sync %d (athlete ids)' % (season - 1, season),
           'method': 'share of last season\u2019s countable production for this programme (dropbacks 1, touches 1, '
                     'targets 0.5, defensive events 1; research/features_roster.py) made by players on its roster now',
           'incoming_method': 'portal inflow, production-weighted: the same units produced last season at ANOTHER '
                              'programme by players on this roster now, over this programme\u2019s own last-season total '
                              '(misses FCS/JUCO arrivals and players who did not play)',
           'qb_method': 'prev_primary_qb_id = the athlete with the most dropbacks for this programme last season; '
                        'returning_qb = he is on the roster now',
           'by_team': by_team}
    dest = os.path.join(repo_root, 'football', 'coaching', 'returning_production_%d.json' % season)
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('[regime] %d returning production -> %s (%d teams)' % (season, dest, len(by_team)))
    return dest


def main():
    os.makedirs(OUT, exist_ok=True)
    if '--current' in sys.argv:
        season = int(sys.argv[sys.argv.index('--current') + 1])
        current_returning_production(season, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')))
        return
    C = load_coaches()
    NH = new_head_coach(C)
    ids = team_ids()
    NH = NH.merge(ids, on=['season', 'team_id'], how='left')
    T, R = continuity()
    H = NH.merge(T, on=['team_key', 'season'], how='left')
    # the quarterback: last season's primary QB for this programme, and
    # whether he is on this season's roster here (known before the season)
    starts, primary = qb_tables(common.PSTATS_FIRST, 2026)
    if len(primary):
        prev = primary.assign(season=primary.season + 1).rename(
            columns={'primary_qb_id': 'prev_primary_qb_id', 'primary_share': 'prev_primary_qb_share'})
        H = H.merge(prev, on=['team_key', 'season'], how='left')
        on_roster = set(zip(R.season.astype(int), R.team_key, R.athlete_id.astype('int64')))
        roster_seasons = set(R.season.astype(int))           # no roster file = unknown, never "left"
        H['returning_qb'] = [
            (None if (pd.isna(q) or pd.isna(s) or int(s) not in roster_seasons) else ((int(s), k, int(q)) in on_roster))
            for s, k, q in zip(H.season, H.team_key, H.prev_primary_qb_id)]
        H['prev_primary_qb_id'] = H.prev_primary_qb_id.astype('Int64')
        sdest = os.path.join(OUT, 'qb_starts.csv')
        starts.to_csv(sdest, index=False)
        print('[regime] %d team-game starters -> %s' % (len(starts), sdest))
    fbs = H.division.astype(str).str.lower().eq('fbs')
    H['returning_share_pct'] = pct_within_season(H, 'returning_share', fbs)
    H['transfers_out_pct'] = pct_within_season(H, 'transfers_out', fbs)
    H['returning_production_pct'] = pct_within_season(H, 'returning_production', fbs)
    H['incoming_production_pct'] = pct_within_season(H, 'incoming_production', fbs)
    H['fbs'] = fbs
    H = H.sort_values(['season', 'team_key'])
    dest = os.path.join(OUT, 'regime_history.csv')
    H.to_csv(dest, index=False)
    f = H[H.fbs]
    print('[regime] %d FBS team-seasons %d-%d -> %s' % (len(f), f.season.min(), f.season.max(), dest))
    print(f.groupby('season').agg(teams=('team_key', 'nunique'),
                                  new_hc=('new_hc', lambda s: int((s == True).sum())),     # noqa: E712
                                  unknown=('new_hc', lambda s: int(s.isna().sum())),
                                  returning_share=('returning_share', 'median'),
                                  transfers_out=('transfers_out', 'median'),
                                  returning_production=('returning_production', 'median'),
                                  incoming_production=('incoming_production', 'median'),
                                  returning_qb=('returning_qb', lambda s: float(s.dropna().astype(bool).mean()) if s.notna().any() else np.nan))
          .round(3).to_string())


if __name__ == '__main__':
    main()
