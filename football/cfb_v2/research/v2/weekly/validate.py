"""Game finality and play-by-play validation (rule `cfb_game_validation_v1`).

`validate_games(season, now, source_week=None, pbp=None, sched=None)` returns one
row per scheduled game with a finality status and, for every final game, a set of
named PBP checks, human-readable issues, a PBP-rebuilt final score and a 0-1
completeness score. Every constant is defined here and documented in
docs/cfb-weekly/METHODS_GAMES.md section 1. Nothing is invented: a missing play,
score or field stays missing and is reported.

Sources, as inspected (2009-2026 sportsdataverse files):
  schedule  data/sched/cfb_schedules_<S>.parquet: `completed` (bool), `status`
            (STATUS_FINAL | STATUS_CANCELED | STATUS_POSTPONED | STATUS_IN_PROGRESS |
            STATUS_HALFTIME, NaN for most rows), `notes` (free text: 'SEPT. 3rd GAME
            POSTPONED', 'Roanoke College wins by forfeit', 'Suspended Sept 3', bowl
            names), home_points / away_points. There is NO overtime field.
  PBP       data/pbp/play_by_play_<S>.parquet: `status_type_completed` per play,
            running score `homeScore` / `awayScore` after each play, `period`,
            `game_play_number`, `sequenceNumber`, `id`, `drive.id`, `text_dupe`.
Market and win-probability columns are never read (plays.FORBIDDEN_PBP_COLUMNS).
"""
import numpy as np
import pandas as pd

from .. import common
from .. import games as GAMES
from ..plays import FORBIDDEN_PBP_COLUMNS
from . import ids

RULE_VERSION = 'cfb_game_validation_v1'

# ------------------------------------------------------------------ finality
# ONE finality rule for the research stages and the weekly engine (audit F-01): the
# provider statuses and the classifier live in v2/games.py (stage 2), and
# `finality` below adds only what needs the clock (SCHEDULED, overdue).
GRACE_HOURS = 8.0            # kickoff + 8h: a weather-delayed game can run 6-7 hours
FINAL_STATUSES = GAMES.FINAL_STATUSES
IN_PROGRESS_STATUSES = GAMES.IN_PROGRESS_STATUSES
POSTPONED_STATUSES = GAMES.POSTPONED_STATUSES
CANCELED_STATUSES = GAMES.CANCELED_STATUSES

# ------------------------------------------------------------- PBP tolerances
PLAY_RATIO_MIN = 0.75        # below 75% of the national median play count = "few plays"
REF_PLAYS_FALLBACK = 172     # median PBP rows per final game, 2024 and 2025 (both 172-173)
REF_MIN_GAMES = 20           # fewer final games with PBP than this -> use the fallback
SEQ_INVERSION_TOL = 3        # min over (sequenceNumber, id) of decreases along play order, timeouts excluded
PERIOD_BACK_TOL = 1          # plays whose period is below an earlier play's period
EXTRA_GAP_TOL = 3            # missing play numbers beyond the (periods - 1) end-of-period rows
MAX_STEP_TOL = 4             # largest single jump in game_play_number
DOWN_TOL = 2                 # scrimmage plays with down outside 1..4
DISTANCE_TOL = 2             # scrimmage plays with distance outside 0..99
YARDLINE_TOL = 2             # plays with yards-to-end-zone or yard line outside 0..100
DRIVE_REAPPEAR_TOL = 4       # scrimmage drive ids that re-appear after another drive
DRIVE_NULL_TOL = 2           # scrimmage plays without a drive id
POSSESSION_TOL = 2           # possession changes between scrimmage plays inside one drive
SCORE_SMALL_GAP = 8          # a reconciliation miss of <= one score (TD + 2) is "small"
MALFORMED_SHARE_MAX = 0.20   # > 20% rows without period / play number / possession = corrupted
DUPLICATE_SHARE_MAX = 0.05   # > 5% duplicated rows = corrupted

CRITICAL_CHECKS = ('pbp_present', 'team_ids', 'no_duplicate_plays', 'play_order',
                   'quarters_present', 'play_count', 'score_reconciles', 'drive_contiguity')
ALL_CHECKS = CRITICAL_CHECKS + ('home_away_orientation', 'down_valid', 'distance_valid',
                                'yardline_valid', 'overtime_consistent', 'possession_transitions')

# completeness score weights (sum to 1)
COMPLETENESS_WEIGHTS = {
    'play_ratio': 0.30,          # min(1, plays / national median)
    'quarters': 0.15,            # share of quarters 1-4 present
    'score': 0.20,               # 1 if reconciles, else max(0, 1 - gap / 21)
    'play_order': 0.10,
    'no_duplicate_plays': 0.05,
    'team_ids': 0.05,
    'field_validity': 0.05,      # mean of down_valid, distance_valid, yardline_valid
    'drive_contiguity': 0.05,
    'possession_transitions': 0.05,
}
SCORE_GAP_SCALE = 21.0

PBP_VALIDATION_COLS = [
    'game_id', 'id', 'sequenceNumber', 'game_play_number', 'period', 'pos_team_id',
    'def_pos_team_id', 'homeTeamId', 'awayTeamId', 'down', 'distance',
    'start.yardsToEndzone', 'start.yardLine', 'homeScore', 'awayScore', 'drive.id',
    'text_dupe', 'type.text', 'status_type_completed', 'rush', 'pass', 'penalty_no_play',
]
assert not set(PBP_VALIDATION_COLS) & set(FORBIDDEN_PBP_COLUMNS)

STATUSES = ('FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'POSTPONED', 'CANCELED', 'DATA_ERROR',
            'SCHEDULED', 'IN_PROGRESS')


# ------------------------------------------------------------------ loading
def load_pbp_for_validation(season):
    import pyarrow.parquet as pq
    f = common.data_path('pbp', 'play_by_play_%d.parquet' % season)
    names = set(pq.ParquetFile(f).schema_arrow.names)
    d = pd.read_parquet(f, columns=[c for c in PBP_VALIDATION_COLS if c in names])
    for c in PBP_VALIDATION_COLS:
        if c not in d.columns:
            d[c] = np.nan
    return d


def load_schedule_raw(season):
    """The raw schedule file (plays.load_schedule drops `status`, which finality needs)."""
    g = pd.read_parquet(common.data_path('sched', 'cfb_schedules_%d.parquet' % season))
    g['game_id'] = pd.to_numeric(g.game_id, errors='coerce')
    g = g[g.game_id.notna()].copy()
    g['game_id'] = g.game_id.astype('int64')
    return g.sort_values('game_id', kind='mergesort').drop_duplicates('game_id')


def _utc(x):
    if x is None:
        return None
    t = pd.Timestamp(x)
    if t is pd.NaT:
        return None
    return t.tz_localize('UTC') if t.tzinfo is None else t.tz_convert('UTC')


def _bool(v):
    if v is None:
        return False
    try:
        if pd.isna(v):
            return False
    except (TypeError, ValueError):
        pass
    return bool(v)


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else f


# ----------------------------------------------------------------- finality
def finality(sched, now, pbp_completed=None):
    """Per schedule row: the pre-PBP status FINAL | POSTPONED | CANCELED | SCHEDULED |
    IN_PROGRESS | DATA_ERROR, plus `overdue`, `sources_agree` and issues.

    Rules, first match wins (METHODS_GAMES.md 1.1; the classifier is
    games.classify_result, shared with stage 2 since the F-01 fix):
      1. provider status CANCELED -> CANCELED; notes 'forfeit' -> CANCELED (no football
         was played); notes 'cancel' on an uncompleted game -> CANCELED
      2. provider status POSTPONED, or notes 'postpon' on an uncompleted game -> POSTPONED
      3. kickoff after `now` -> SCHEDULED (a result in the file is ignored: point in time)
      4. final claim = completed flag (exactly True) and both scores present. A claim
         contradicted by an in-progress provider status or by the PBP's
         status_type_completed == False -> IN_PROGRESS, sources_agree False. A completed
         tie -> DATA_ERROR (overtime since 1996). Otherwise -> FINAL. A score without the
         completed flag is a partial score -> IN_PROGRESS (a provider STATUS_FINAL
         without the flag is not enough: sources_agree False).
      5. completed flag without both scores -> DATA_ERROR
      6. otherwise IN_PROGRESS (kickoff passed); `overdue` when now >= kickoff + grace.
    """
    now = _utc(now)
    pbp_completed = pbp_completed or {}
    grace = pd.Timedelta(hours=GRACE_HOURS)
    out = []
    for r in sched.itertuples(index=False):
        gid = int(r.game_id)
        st = str(getattr(r, 'status', '') or '').upper()
        st = '' if st in ('NAN', 'NONE') else st
        notes = str(getattr(r, 'notes', '') or '')
        notes_l = '' if notes.lower() in ('nan', 'none') else notes.lower()
        comp = _bool(getattr(r, 'completed', False))
        hp, ap = _num(getattr(r, 'home_points', None)), _num(getattr(r, 'away_points', None))
        has_pts = hp is not None and ap is not None
        k = _utc(getattr(r, 'start_date', None))
        pc = pbp_completed.get(gid)
        issues, agree, overdue = [], True, False
        if k is None:
            issues.append('kickoff time missing in the schedule')
        cls, why, cls_agree = GAMES.classify_result(getattr(r, 'completed', None), st,
                                                    notes if notes_l else '', hp, ap, pc)
        if cls in ('CANCELED', 'POSTPONED'):
            status = cls
            if cls == 'CANCELED' and st not in CANCELED_STATUSES:
                issues.append(why)
        elif now is not None and k is not None and k > now:
            status = 'SCHEDULED'
            if comp or st in FINAL_STATUSES:
                issues.append('schedule carries a result for a game that kicks off after now; ignored')
        elif cls is None:
            status = 'IN_PROGRESS'          # kickoff passed, no result claim yet
        else:
            status, agree = cls, cls_agree
            if why:
                issues.append(why)
        if status == 'IN_PROGRESS' and now is not None and k is not None and now >= k + grace:
            overdue = True
            issues.append('no final status %.0fh after kickoff (grace period passed)' % GRACE_HOURS)
        out.append(dict(game_id=gid, pre_status=status, kickoff_ts=k, sched_status=st or None,
                        sched_completed=comp, pbp_completed=pc, sources_agree=agree,
                        overdue=overdue, fin_issues=issues))
    return pd.DataFrame(out, columns=['game_id', 'pre_status', 'kickoff_ts', 'sched_status',
                                      'sched_completed', 'pbp_completed', 'sources_agree',
                                      'overdue', 'fin_issues'])


# -------------------------------------------------------------- PBP checks
def _as_int_array(s):
    return pd.to_numeric(s, errors='coerce').to_numpy(dtype=float)


def _str_array(s):
    return s.astype(object).where(s.notna(), None).to_numpy()


def _inversions(s):
    """Decreases along the given order, compared exactly (18-digit play ids do not
    survive a float64 cast, so the values stay integers when they parse as such)."""
    s = s[s.notna()]
    v = pd.to_numeric(s, errors='coerce')
    v = v[v.notna()]
    if len(v) < 2:
        return None
    return int((np.diff(v.to_numpy()) < 0).sum())


def check_game_pbp(g, home_id, away_id, home_pts, away_pts, ref_plays):
    """All PBP checks for one final game. `g` = that game's PBP rows (any order).
    Returns a dict: checks, detail, issues, pbp_plays, periods, overtime,
    pbp_score_home, pbp_score_away, score_gap, play_ratio, completeness, corrupted,
    contradiction."""
    issues, detail = [], {}
    n_raw = len(g)
    if n_raw == 0:
        checks = {c: False for c in ALL_CHECKS}
        return dict(checks=checks, detail={'n_raw': 0}, issues=['no play-by-play for a final game'],
                    pbp_plays=0, periods=None, overtime=None, pbp_score_home=None,
                    pbp_score_away=None, score_gap=None, play_ratio=0.0, completeness=0.0,
                    corrupted=False, contradiction=False, score_method=None)
    # ------------------------------------------------ malformed + duplicates
    gpn_all = _as_int_array(g.game_play_number)
    per_all = _as_int_array(g.period)
    pos_all = _as_int_array(g.pos_team_id)
    malformed = np.isnan(gpn_all) | np.isnan(per_all) | np.isnan(pos_all)
    n_malformed = int(malformed.sum())
    dupe_flag = g.text_dupe.fillna(False).astype(bool).to_numpy() if 'text_dupe' in g else np.zeros(n_raw, bool)
    pid = pd.to_numeric(g['id'], errors='coerce') if 'id' in g else pd.Series(np.nan, index=g.index)
    dup_id = (pid.notna() & pid.duplicated(keep='first')).to_numpy()
    n_text_dupe, n_dup_id = int(dupe_flag.sum()), int(dup_id.sum())
    keep = ~(malformed | dupe_flag | dup_id)
    c = g[keep].copy()
    c['_gpn'] = gpn_all[keep]
    c['_per'] = per_all[keep].astype(int) if keep.any() else per_all[keep]
    c = c.sort_values('_gpn', kind='mergesort')
    n_dup_gpn = int(pd.Series(c._gpn.values).duplicated().sum())
    n = len(c)
    detail.update(n_raw=n_raw, n_malformed=n_malformed, n_text_dupe=n_text_dupe,
                  n_dup_id=n_dup_id, n_dup_gpn=n_dup_gpn, n_clean=n)
    checks = {'pbp_present': n > 0}
    checks['no_duplicate_plays'] = (n_text_dupe == 0 and n_dup_id == 0 and n_dup_gpn == 0)
    if n_text_dupe or n_dup_id or n_dup_gpn:
        issues.append('duplicate plays: %d text_dupe, %d repeated play ids, %d repeated play numbers'
                      % (n_text_dupe, n_dup_id, n_dup_gpn))
    if n_malformed:
        issues.append('%d rows without period / play number / possession (excluded)' % n_malformed)
    corrupted = (n_malformed / n_raw > MALFORMED_SHARE_MAX) or \
                ((n_text_dupe + n_dup_id + n_dup_gpn) / n_raw > DUPLICATE_SHARE_MAX)
    if n == 0:
        for k in ALL_CHECKS:
            checks.setdefault(k, False)
        issues.append('no usable play rows')
        return dict(checks=checks, detail=detail, issues=issues, pbp_plays=0, periods=None,
                    overtime=None, pbp_score_home=None, pbp_score_away=None, score_gap=None,
                    play_ratio=0.0, completeness=_completeness(checks, 0.0, 0.0, None),
                    corrupted=True, contradiction=False, score_method=None)

    gpn = c._gpn.to_numpy()
    per = c._per.to_numpy()
    ttype = c['type.text'].astype(object).fillna('').to_numpy() if 'type.text' in c else np.array([''] * n, object)
    not_to = ttype != 'Timeout'
    # ------------------------------------------------------------ ordering
    # the provider carries two sequence keys: sequenceNumber (chronological in the
    # 2014+ feed, not before) and the play id (chronological before 2014, occasionally
    # not since). The order is corroborated when either key agrees with the play number.
    inv = []
    for col in ('sequenceNumber', 'id'):
        if col in c:
            k = _inversions(c[col][not_to])
            if k is not None:
                inv.append(k)
    seq_inv = min(inv) if inv else 0
    period_back = int((per < np.maximum.accumulate(per)).sum())
    n_periods = len(np.unique(per))
    missing = int(gpn.max() - len(np.unique(gpn))) if gpn.min() >= 1 else 0
    extra_gap = max(0, missing - (n_periods - 1))
    max_step = int(np.diff(gpn).max()) if n > 1 else 1
    detail.update(seq_inversions=seq_inv, period_regressions=period_back,
                  missing_play_numbers=missing, extra_gaps=extra_gap, max_step=max_step)
    checks['play_order'] = (seq_inv <= SEQ_INVERSION_TOL and period_back <= PERIOD_BACK_TOL and
                            extra_gap <= EXTRA_GAP_TOL and max_step <= MAX_STEP_TOL and n_dup_gpn == 0)
    if not checks['play_order']:
        issues.append('play order: %d sequence inversions, %d plays out of period order, '
                      '%d unexplained missing play numbers, largest jump %d'
                      % (seq_inv, period_back, extra_gap, max_step))
    # --------------------------------------------------------------- teams
    teams = {int(home_id), int(away_id)}
    pos = _as_int_array(c.pos_team_id)
    dpos = _as_int_array(c.def_pos_team_id)
    seen = set(int(x) for x in np.unique(pos[~np.isnan(pos)])) | \
        set(int(x) for x in np.unique(dpos[~np.isnan(dpos)]))
    ph = _as_int_array(c.homeTeamId)
    pa = _as_int_array(c.awayTeamId)
    ph_mode = int(pd.Series(ph[~np.isnan(ph)]).mode().iloc[0]) if (~np.isnan(ph)).any() else None
    pa_mode = int(pd.Series(pa[~np.isnan(pa)]).mode().iloc[0]) if (~np.isnan(pa)).any() else None
    pbp_pair = {ph_mode, pa_mode}
    checks['team_ids'] = seen <= teams and pbp_pair == teams
    if not checks['team_ids']:
        issues.append('team ids %s not within the scheduled pair %s' % (sorted(seen | {x for x in pbp_pair if x is not None}), sorted(teams)))
    swapped = (ph_mode == int(away_id) and pa_mode == int(home_id))
    checks['home_away_orientation'] = (ph_mode == int(home_id) and pa_mode == int(away_id))
    if swapped:
        issues.append('PBP home/away designation is swapped relative to the schedule (scores re-oriented)')
    # ---------------------------------------------------- down / distance / yard line
    rush = c['rush'].fillna(False).astype(bool).to_numpy() if 'rush' in c else np.zeros(n, bool)
    pas = c['pass'].fillna(False).astype(bool).to_numpy() if 'pass' in c else np.zeros(n, bool)
    npl = c['penalty_no_play'].fillna(False).astype(bool).to_numpy() if 'penalty_no_play' in c else np.zeros(n, bool)
    scrim = (rush | pas) & ~npl
    down = _as_int_array(c.down)
    dist = _as_int_array(c.distance)
    ytg = _as_int_array(c['start.yardsToEndzone'])
    yl = _as_int_array(c['start.yardLine'])
    # down is meaningful on scrimmage plays only (kickoffs / PATs carry 0, -1 or a stale down)
    bad_down = int((scrim & ~np.isin(down, [1, 2, 3, 4])).sum())
    bad_dist = int((scrim & ~((dist >= 0) & (dist <= 99))).sum())
    bad_yl = int(((~np.isnan(ytg)) & ((ytg < 0) | (ytg > 100))).sum() +
                 ((~np.isnan(yl)) & ((yl < 0) | (yl > 100))).sum() +
                 (scrim & np.isnan(ytg)).sum())
    detail.update(bad_down=bad_down, bad_distance=bad_dist, bad_yardline=bad_yl,
                  scrimmage_plays=int(scrim.sum()))
    checks['down_valid'] = bad_down <= DOWN_TOL
    checks['distance_valid'] = bad_dist <= DISTANCE_TOL
    checks['yardline_valid'] = bad_yl <= YARDLINE_TOL
    for k, v, lab in (('down_valid', bad_down, 'down outside 1..4'),
                      ('distance_valid', bad_dist, 'distance outside 0..99'),
                      ('yardline_valid', bad_yl, 'yard line outside 0..100')):
        if not checks[k]:
            issues.append('%d plays with %s' % (v, lab))
    # ------------------------------------------------------------- quarters
    qs = set(int(x) for x in np.unique(per))
    missing_q = sorted({1, 2, 3, 4} - qs)
    checks['quarters_present'] = not missing_q
    if missing_q:
        issues.append('quarters missing from PBP: %s' % missing_q)
    periods = int(per.max())
    overtime = periods >= 5
    # ------------------------------------------------ drives + possession
    drv = _str_array(c['drive.id']) if 'drive.id' in c else np.array([None] * n, object)
    sd = drv[scrim]
    sp = pos[scrim]
    null_drive = int(sum(1 for x in sd if x is None))
    sdn = np.array([x for x in sd if x is not None], dtype=object)
    spn = np.array([p for p, x in zip(sp, sd) if x is not None])
    if len(sdn):
        blocks = int((sdn[1:] != sdn[:-1]).sum()) + 1
        reappear = blocks - len(set(sdn.tolist()))
        poss_nodrive = int(((spn[1:] != spn[:-1]) & (sdn[1:] == sdn[:-1])).sum())
    else:
        reappear, poss_nodrive = 0, 0
    detail.update(drive_reappearances=reappear, scrimmage_null_drive=null_drive,
                  possession_changes_within_drive=poss_nodrive)
    checks['drive_contiguity'] = reappear <= DRIVE_REAPPEAR_TOL and null_drive <= DRIVE_NULL_TOL
    if not checks['drive_contiguity']:
        issues.append('drive structure: %d drive ids re-appear after another drive, %d scrimmage '
                      'plays without a drive id' % (reappear, null_drive))
    checks['possession_transitions'] = poss_nodrive <= POSSESSION_TOL
    if not checks['possession_transitions']:
        issues.append('%d possession changes inside one drive' % poss_nodrive)
    # ------------------------------------------------------------ play count
    ratio = n / float(ref_plays) if ref_plays else 0.0
    checks['play_count'] = ratio >= PLAY_RATIO_MIN
    if not checks['play_count']:
        issues.append('few plays: %d vs national median %g (ratio %.2f)' % (n, ref_plays, ratio))
    # ---------------------------------------------------------- score rebuild
    hs = _as_int_array(c.homeScore)
    as_ = _as_int_array(c.awayScore)
    if swapped:
        hs, as_ = as_, hs
    order = np.lexsort((gpn, per))           # chronological: period, then play number
    ok_rows = ~(np.isnan(hs[order]) | np.isnan(as_[order]))
    cand = []
    if ok_rows.any():
        last = order[ok_rows][-1]
        cand.append(('last_play', hs[last], as_[last]))
        cand.append(('max_running', np.nanmax(hs), np.nanmax(as_)))
    best = None
    for name, h_, a_ in cand:
        gap = max(abs(h_ - home_pts), abs(a_ - away_pts))
        if best is None or gap < best[3]:
            best = (name, h_, a_, gap)
    if best is None:
        pbp_h = pbp_a = gap = None
        method = None
        checks['score_reconciles'] = False
        issues.append('no running score in PBP')
    else:
        method, pbp_h, pbp_a, gap = best
        checks['score_reconciles'] = gap == 0
        if gap == 0 and method == 'max_running':
            issues.append('final PBP row carries a stale running score; the maximum running score reconciles')
        if gap:
            issues.append('PBP score %d-%d vs final %d-%d (gap %d)' % (pbp_h, pbp_a, home_pts, away_pts, gap))
    # --------------------------------------------------------------- overtime logic
    reg = order[(per[order] <= 4) & ok_rows] if ok_rows.any() else np.array([], int)
    ot_ok = True
    if len(reg):
        tied_reg = bool(hs[reg[-1]] == as_[reg[-1]])
        if overtime and not tied_reg:
            ot_ok = False
            issues.append('overtime periods present but regulation ended %d-%d' % (hs[reg[-1]], as_[reg[-1]]))
        if not overtime and tied_reg and 4 in qs:
            ot_ok = False
            issues.append('regulation ended tied in PBP but no overtime periods')
    elif overtime:
        ot_ok = False
        issues.append('overtime periods present without any regulation rows')
    if not overtime and home_pts == away_pts:
        ot_ok = False
        issues.append('final score is tied without overtime')
    checks['overtime_consistent'] = bool(ot_ok)
    detail.update(periods=periods, score_gap=None if gap is None else int(gap))
    # --------------------------------------------------------------- verdicts
    contradiction = False
    if gap is not None and gap > SCORE_SMALL_GAP:
        truncated = (not checks['quarters_present']) or not checks['play_count']
        consistent = pbp_h <= home_pts and pbp_a <= away_pts
        contradiction = not (truncated and consistent)
    comp = _completeness(checks, ratio, len(set(qs) & {1, 2, 3, 4}) / 4.0, gap)
    for k in ALL_CHECKS:
        checks.setdefault(k, False)
    return dict(checks={k: bool(checks[k]) for k in ALL_CHECKS}, detail=detail, issues=issues,
                pbp_plays=n, periods=periods, overtime=overtime,
                pbp_score_home=None if pbp_h is None else int(pbp_h),
                pbp_score_away=None if pbp_a is None else int(pbp_a),
                score_gap=None if gap is None else int(gap), play_ratio=ratio,
                completeness=comp, corrupted=bool(corrupted), contradiction=bool(contradiction),
                score_method=method)


def _completeness(checks, ratio, qshare, gap):
    w = COMPLETENESS_WEIGHTS
    sc = 1.0 if gap == 0 else (0.0 if gap is None else max(0.0, 1.0 - gap / SCORE_GAP_SCALE))
    fv = np.mean([bool(checks.get('down_valid')), bool(checks.get('distance_valid')),
                  bool(checks.get('yardline_valid'))])
    v = (w['play_ratio'] * min(1.0, max(0.0, ratio)) + w['quarters'] * qshare + w['score'] * sc +
         w['play_order'] * bool(checks.get('play_order')) +
         w['no_duplicate_plays'] * bool(checks.get('no_duplicate_plays')) +
         w['team_ids'] * bool(checks.get('team_ids')) + w['field_validity'] * fv +
         w['drive_contiguity'] * bool(checks.get('drive_contiguity')) +
         w['possession_transitions'] * bool(checks.get('possession_transitions')))
    return round(float(v), 6)


def game_status(res):
    """FINAL_VALIDATED | FINAL_PARTIAL_DATA | DATA_ERROR for a final game's check result."""
    ch = res['checks']
    if not ch.get('pbp_present'):
        return 'FINAL_PARTIAL_DATA'
    if not ch.get('team_ids') or res['corrupted'] or res['contradiction']:
        return 'DATA_ERROR'
    if all(ch.get(k) for k in CRITICAL_CHECKS):
        return 'FINAL_VALIDATED'
    return 'FINAL_PARTIAL_DATA'


def reference_plays(season, pbp=None, sched=None, now=None):
    """National median of PBP plays (deduplicated rows) per final game. For a season read
    from disk it is the PREVIOUS season's median (known and fixed before the season, so a
    game's completeness never drifts as the season fills in); otherwise the median of the
    final games in the frames given; the fallback constant when fewer than REF_MIN_GAMES."""
    import os
    if pbp is None and sched is None:
        f = common.data_path('pbp', 'play_by_play_%d.parquet' % (season - 1))
        if os.path.exists(f):
            p = load_pbp_for_validation(season - 1)
            s = load_schedule_raw(season - 1)
            return _median_plays(p, s, None)
        return REF_PLAYS_FALLBACK
    return _median_plays(pbp, sched, now)


def _median_plays(p, s, now):
    fin = finality(s, now if now is not None else pd.Timestamp('2100-01-01', tz='UTC'))
    ids_ = set(fin.game_id[fin.pre_status.eq('FINAL')])
    x = p[p.game_id.isin(ids_)]
    x = x[~x.text_dupe.fillna(False).astype(bool)] if 'text_dupe' in x else x
    x = x[pd.to_numeric(x.game_play_number, errors='coerce').notna() & pd.to_numeric(x.period, errors='coerce').notna()
          & pd.to_numeric(x.pos_team_id, errors='coerce').notna()]
    cnt = x.groupby('game_id').size()
    if len(cnt) < REF_MIN_GAMES:
        return REF_PLAYS_FALLBACK
    return float(np.median(cnt.values))


def _week_filter(sched, source_week):
    if source_week is None:
        return sched
    if isinstance(source_week, tuple):
        st, wk = source_week
        return sched[sched.season_type.astype(str).str.lower().eq(str(st).lower()) & sched.week.eq(int(wk))]
    return sched[sched.season_type.astype(str).str.lower().eq('regular') & sched.week.eq(int(source_week))]


def validate_games(season, now, source_week=None, pbp=None, sched=None, ref_plays=None):
    """One row per scheduled game of `season` (or of `source_week`: an int = that
    regular-season week, a tuple (season_type, week) otherwise). `now` is the
    validation instant (point in time; also stamped as validated_at). `pbp` / `sched`
    replace the files (tests). `ref_plays` overrides the national median."""
    now = _utc(now)
    sched_all = load_schedule_raw(season) if sched is None else sched.copy()
    sched_all['game_id'] = pd.to_numeric(sched_all.game_id, errors='coerce').astype('int64')
    if 'season' not in sched_all:
        sched_all['season'] = season
    if pbp is None:
        pbp_all = load_pbp_for_validation(season)
        if ref_plays is None:
            ref_plays = reference_plays(season)
    else:
        pbp_all = pbp.copy()
        for col in PBP_VALIDATION_COLS:
            if col not in pbp_all.columns:
                pbp_all[col] = np.nan
        if ref_plays is None:
            ref_plays = reference_plays(season, pbp_all, sched_all, now)
    s = _week_filter(sched_all, source_week).sort_values('game_id', kind='mergesort')
    pbp_all = pbp_all[pbp_all.game_id.isin(set(s.game_id))]
    pc = pbp_all.groupby('game_id').status_type_completed.agg(
        lambda v: None if v.isna().all() else bool(v.dropna().astype(bool).all()))
    pcd = {int(k): v for k, v in pc.items()}
    fin = finality(s, now, pcd).set_index('game_id')
    groups = {int(k): v for k, v in pbp_all.groupby('game_id', sort=True)}
    empty = pbp_all.iloc[0:0]
    rows = []
    vat = ids.ts(now) if now is not None else None
    for r in s.itertuples(index=False):
        gid = int(r.game_id)
        f = fin.loc[gid]
        g = groups.get(gid, empty)
        hp, ap = _num(getattr(r, 'home_points', None)), _num(getattr(r, 'away_points', None))
        hdiv = getattr(r, 'home_division', None)
        adiv = getattr(r, 'away_division', None)
        in_scope = (str(hdiv) == 'fbs') or (str(adiv) == 'fbs') or _bool(getattr(r, 'fbs_participant', False))
        row = dict(game_id=gid, season=int(getattr(r, 'season', season)), week=int(r.week) if _num(r.week) is not None else None,
                   season_type=str(getattr(r, 'season_type', '') or ''), kickoff_ts=f.kickoff_ts,
                   home_id=int(r.home_id), away_id=int(r.away_id), in_scope=bool(in_scope),
                   sched_status=f.sched_status, sched_completed=bool(f.sched_completed),
                   pbp_completed=f.pbp_completed, sources_agree=bool(f.sources_agree),
                   overdue=bool(f.overdue))
        issues = list(f.fin_issues)
        per_max = _num(pd.to_numeric(g.period, errors='coerce').max()) if len(g) else None
        # a completed tie is DATA_ERROR (never a result, F-01), but its PBP is still checked
        # so the diagnostics (overtime_consistent) say why
        tie = f.pre_status == 'DATA_ERROR' and hp is not None and ap is not None and hp == ap
        if f.pre_status == 'FINAL' or tie:
            res = check_game_pbp(g, r.home_id, r.away_id, int(hp), int(ap), ref_plays)
            status = game_status(res) if not tie else 'DATA_ERROR'
            issues += res['issues']
            row.update(status=status, home_points=None if tie else int(hp), away_points=None if tie else int(ap),
                       overtime=res['overtime'], periods=res['periods'], pbp_plays=res['pbp_plays'],
                       pbp_completeness_score=res['completeness'], checks=res['checks'],
                       check_detail=res['detail'], pbp_score_home=res['pbp_score_home'],
                       pbp_score_away=res['pbp_score_away'],
                       score_reconciles=bool(res['checks'].get('score_reconciles')),
                       score_gap=res['score_gap'], score_method=res['score_method'],
                       play_ratio=round(float(res['play_ratio']), 6))
        else:
            row.update(status=f.pre_status, home_points=None, away_points=None,
                       overtime=(None if per_max is None else bool(per_max >= 5)),
                       periods=None if per_max is None else int(per_max),
                       pbp_plays=int(len(g)), pbp_completeness_score=None, checks={},
                       check_detail={}, pbp_score_home=None, pbp_score_away=None,
                       score_reconciles=None, score_gap=None, score_method=None, play_ratio=None)
        row.update(issues=issues, ref_plays=float(ref_plays), validated_at=vat, rule_version=RULE_VERSION)
        row['row_hash'] = ids.content_hash(row, exclude=('validated_at',))
        rows.append(row)
    cols = ['game_id', 'season', 'week', 'season_type', 'kickoff_ts', 'home_id', 'away_id', 'in_scope',
            'status', 'home_points', 'away_points', 'overtime', 'periods', 'pbp_plays',
            'pbp_completeness_score', 'checks', 'issues', 'pbp_score_home', 'pbp_score_away',
            'score_reconciles', 'score_gap', 'score_method', 'play_ratio', 'ref_plays',
            'check_detail', 'sched_status', 'sched_completed', 'pbp_completed', 'sources_agree',
            'overdue', 'validated_at', 'rule_version', 'row_hash']
    out = pd.DataFrame(rows, columns=cols)
    if len(out):
        out = out.sort_values(['kickoff_ts', 'game_id'], kind='mergesort', na_position='last').reset_index(drop=True)
    return out


def stage2_final_violations(G, V, season):
    """Every game the stage-2 table counts as a RESULT (status FINAL: it feeds the
    ratings, Elo, the QB state and the grades) that this validator does not accept as
    final with the same score. The weekly engine refuses to go on when the list is not
    empty (VERIFY_COMPLETED_GAMES, audit F-01): an in-progress, cancelled or unconfirmed
    game can never reach the ratings. `V` = validate_games(season, now)."""
    g = G[G.season.eq(season) & G.status.eq('FINAL')]
    v = V.drop_duplicates('game_id').set_index('game_id') if len(V) else V
    out = []
    for gid, hp, ap in zip(g.game_id, g.home_points, g.away_points):
        gid = int(gid)
        if gid not in v.index:
            out.append({'game_id': gid, 'reason': 'stage 2 FINAL, not in the validated schedule'})
            continue
        x = v.loc[gid]
        if x.home_points is None or pd.isna(x.home_points):          # pre-status was not FINAL
            out.append({'game_id': gid, 'reason': 'stage 2 FINAL, validator %s' % x.status,
                        'validator_issues': list(x.issues or [])[:3]})
        elif float(x.home_points) != float(hp) or float(x.away_points) != float(ap):
            out.append({'game_id': gid, 'reason': 'score differs: stage 2 %g-%g, validator %g-%g'
                        % (hp, ap, x.home_points, x.away_points)})
    return out


def status_counts(v, scope_only=True):
    x = v[v.in_scope] if scope_only else v
    return {k: int(x.status.eq(k).sum()) for k in STATUSES}
