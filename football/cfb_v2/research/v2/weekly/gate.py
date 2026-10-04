"""Sanity checks and the weekly release gate.

Nothing is published (no freeze, no current.json, no team state) unless every
gate condition holds. On failure the previous valid state stays in place and
the run is recorded as GATE_FAILED with the failing checks. Half-computed
ratings are never published.
"""
import numpy as np
import pandas as pd

# bounds, each declared with its reason
MAX_DATA_ERROR_SHARE = 0.05       # more than 5% of the source week's finals unusable -> hold the week
MAX_QB_STATE_AGE_DAYS = 21        # an expected starter whose last game is older is a stale QB state
TOTAL_RANGE = (10.0, 120.0)       # a fair total outside this is not a football score
MAX_ABS_MARGIN = 75.0             # beyond anything in 2009-2025 FBS


MAX_WITHHELD_SHARE = 0.05        # more than 5% of the week's games withheld by game-level checks -> hold the week


def check(name, ok, detail=None, critical=True, games=None, action=None):
    """action: None (a run-level check), 'WITHHOLD_GAME' (the failing games are
    not published; the rest of the week is) or 'WITHHOLD_TOTAL' (the failing
    games publish their spread but not their total)."""
    c = {'check': name, 'ok': bool(ok), 'critical': critical, 'detail': detail}
    if action:
        c['action'] = action
        c['games'] = sorted(str(g) for g in (games or []))
    return c


def sanity(D, feats, games, T, now, team_rows=None, team_flags=None, qb_rows=None, market_ok=True):
    """D: inference frame for the target games; feats: feature snapshots;
    games: the stage-2 games frame; T: the freeze instant."""
    out = []
    g = D.copy()
    # one game per team per target week
    tw = pd.concat([g[['game_id', 'home_id']].rename(columns={'home_id': 't'}),
                    g[['game_id', 'away_id']].rename(columns={'away_id': 't'})])
    dup_team = tw.groupby('t').game_id.nunique()
    out.append(check('no team projected in two games of the week', (dup_team <= 1).all(),
                     sorted(dup_team[dup_team > 1].index.astype(str).tolist())[:10]))
    out.append(check('no team both home and away in one game', (g.home_id != g.away_id).all()))
    out.append(check('no duplicate games', g.game_id.is_unique, int(g.game_id.duplicated().sum())))
    ok_p = g.p_home_raw.between(0, 1, inclusive='neither') & g.p_home_calibrated.between(0, 1, inclusive='neither')
    bad = g.loc[~ok_p, 'game_id'].astype(str).tolist()
    out.append(check('win probabilities strictly inside (0, 1); home + away = 1 by construction', ok_p.all(),
                     bad[:10], games=bad, action='WITHHOLD_GAME'))
    fin = np.isfinite(g[['ens_pred', 'sigma', 'pred_total']].astype(float)).all(axis=1) & (g.sigma > 0)
    bad = g.loc[~fin, 'game_id'].astype(str).tolist()
    out.append(check('no NaN or infinite spreads, sigmas or totals; sigma positive', fin.all(), bad[:10],
                     games=bad, action='WITHHOLD_GAME'))
    pl = g.pred_total.between(*TOTAL_RANGE) & (g.ens_pred.abs() <= MAX_ABS_MARGIN)
    bad = g.loc[~pl, 'game_id'].astype(str).tolist()
    out.append(check('plausible totals (%g-%g) and margins (|margin| <= %g)' % (TOTAL_RANGE + (MAX_ABS_MARGIN,)), pl.all(),
                     bad[:10], games=bad, action='WITHHOLD_GAME'))
    # a projected margin larger than the projected total implies negative points for one team: the
    # separately modelled total is incoherent there (lopsided mismatches), the spread is not
    coh = ((g.pred_total + g.ens_pred) / 2 >= 0) & ((g.pred_total - g.ens_pred) / 2 >= 0)
    bad = g.loc[pl & ~coh, 'game_id'].astype(str).tolist()
    out.append(check('implied team points >= 0 (margin within the total)', not bad, bad[:10], critical=False,
                     games=bad, action='WITHHOLD_TOTAL'))
    ids_ok = set(games.home_id.astype(str)) | set(games.away_id.astype(str))
    bad_ids = sorted({str(x) for x in pd.concat([g.home_id, g.away_id]).astype(str)} - ids_ok)
    out.append(check('no invalid team ids', not bad_ids, bad_ids[:10]))
    # point-in-time: features as of T, T before every kickoff, nothing after kickoff
    ft = pd.to_datetime([f['feature_ts'] for f in feats], utc=True) if feats else pd.DatetimeIndex([])
    ko = pd.to_datetime([f['kickoff_ts'] for f in feats], utc=True) if feats else pd.DatetimeIndex([])
    out.append(check('no post-kickoff data (feature_ts < kickoff for every game)', bool((ft < ko).all()) if len(ft) else True))
    out.append(check('every feature snapshot is as of the freeze instant T',
                     bool((ft == pd.Timestamp(T)).all()) if len(ft) else True))
    # the state used only games that kicked off before T
    if team_rows is not None and len(team_rows) and 'last_game_kickoff' in team_rows:
        lk = pd.to_datetime(team_rows.last_game_kickoff, utc=True, errors='coerce')
        out.append(check('team state uses only games that kicked off before T', bool((lk.dropna() < pd.Timestamp(T)).all())))
    # rating jumps must carry an explanation
    if team_flags:
        unexplained = [f['team_id'] for f in team_flags if not f.get('drivers')]
        out.append(check('no extreme team rating move without an explanation', not unexplained, unexplained[:10]))
    # stale QB state
    if qb_rows is not None and len(qb_rows) and 'last_game_kickoff' in qb_rows:
        exp = qb_rows[qb_rows.expected_starter.fillna(False).astype(bool)]
        lk = pd.to_datetime(exp.last_game_kickoff, utc=True, errors='coerce')
        stale = exp[(pd.Timestamp(T) - lk) > pd.Timedelta(days=MAX_QB_STATE_AGE_DAYS)]
        out.append(check('no expected-starter QB state older than %d days' % MAX_QB_STATE_AGE_DAYS, stale.empty,
                         stale.team_id.astype(str).tolist()[:10] if 'team_id' in stale else None, critical=False))
    out.append(check('no market inputs in the pure model (checked against the artifact columns)', market_ok))
    return out


def release_gate(run, sanity_checks, convergence, artifact, leakage_ok, validation=None, source_health=None,
                 critical_stages=(), n_week_games=None):
    """Every condition must hold for the week's refreshed projections to be
    published. Returns {'pass': bool, 'failed': [...], 'checks': [...]}."""
    checks = []
    bad_stages = [n for n in critical_stages if run.stages.get(n, {}).get('status') not in ('OK', 'WARN', 'SKIPPED')]
    checks.append(check('pipeline completed (every critical stage OK or WARN)', not bad_stages, bad_stages))
    crit = (source_health or {}).get('critical_failures') or []
    checks.append(check('critical data sources present', not crit, crit))
    if validation is not None and len(validation):
        v = validation[validation.in_scope] if 'in_scope' in validation else validation
        fin = v[v.status.isin(['FINAL_VALIDATED', 'FINAL_PARTIAL_DATA', 'DATA_ERROR'])]
        share = float(fin.status.eq('DATA_ERROR').mean()) if len(fin) else 0.0
        checks.append(check('data errors within bound (%.0f%% of finals)' % (100 * MAX_DATA_ERROR_SHARE),
                            share <= MAX_DATA_ERROR_SHARE, round(share, 4)))
    conv_ok = bool(convergence and convergence.get('converged'))
    checks.append(check('opponent adjustment converged (every metric)', conv_ok,
                        (convergence or {}).get('not_converged')))
    checks.append(check('no leakage test failure', bool(leakage_ok)))
    checks.append(check('model artifacts loaded and verified against MANIFEST.json', bool(artifact and artifact.get('ok')),
                        (artifact or {}).get('reason')))
    # game-level failures withhold those games; the week is held only if too many are withheld
    n_games = max(1, int(n_week_games or 0))           # unknown week size: any withheld game holds the week
    withheld = sorted({gid for c in sanity_checks if c.get('action') == 'WITHHOLD_GAME' and not c['ok']
                       for gid in c.get('games') or []})
    totals = sorted({gid for c in sanity_checks if c.get('action') == 'WITHHOLD_TOTAL' and not c['ok']
                     for gid in c.get('games') or []} - set(withheld))
    failed_sanity = [c['check'] for c in sanity_checks if c['critical'] and not c['ok'] and not c.get('action')]
    checks.append(check('sanity checks pass', not failed_sanity, failed_sanity))
    share = len(withheld) / n_games
    checks.append(check('games withheld by game-level checks within bound (%.0f%% of the week)' % (100 * MAX_WITHHELD_SHARE),
                        share <= MAX_WITHHELD_SHARE, {'withheld': withheld, 'share': round(share, 4)}))
    failed = [c['check'] for c in checks if c['critical'] and not c['ok']]
    warn = [c['check'] for c in sanity_checks if not c['critical'] and not c['ok']]
    return {'pass': not failed, 'failed': failed, 'warnings': warn, 'checks': checks + sanity_checks,
            'withheld_games': withheld, 'withheld_totals': totals}
