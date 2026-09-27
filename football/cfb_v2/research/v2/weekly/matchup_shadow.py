"""The matchup layer in SHADOW inside the weekly engine (docs/cfb-matchup/METHODS.md §9).

The matchup residual model was frozen as NO_ADJUSTMENT (no family improved
out-of-sample accuracy over V2.1), so this stage RECORDS what the hook
computes at the freeze and never moves a number:

  * the general fair margin of every record must be the published V2.1
    projection (ens_pred of the same game, same run);
  * under NO_ADJUSTMENT the matchup-aware margin must equal the general
    margin exactly; a record that would move a number is refused (not
    written) and reported, never applied;
  * the records are appended write-once to football/cfb_weekly/<season>/
    matchup_shadow.jsonl (id: the hook's matchup_id, which hashes the inputs).

The hook needs the matchup layer's own point-in-time inputs (style ratings of
the season, the backtest history, the frozen matchup artifact). When they are
not built in this environment the stage is SKIPPED with that reason: a shadow
never blocks, delays or changes the production pathway.
"""
import os

from .store import append_jsonl, read_jsonl

FILE = 'matchup_shadow.jsonl'


def prerequisites(season):
    """[] when the hook can run, else the missing inputs (named)."""
    from .. import common
    from ..matchup import style as ST
    from ..matchup import residual as RS
    miss = []
    if not os.path.exists(ST.style_dir('ratings_%d.parquet' % season)):
        miss.append('matchup style ratings for %d (python3 -m v2.matchup.style)' % season)
    if not os.path.exists(ST.style_dir('finals.parquet')):
        miss.append('matchup style finals (python3 -m v2.matchup.style)')
    if not os.path.exists(common.out_path('stage7', 'backtest_predictions.parquet')):
        miss.append('stage-7 backtest predictions (the similar-matchup history)')
    try:
        RS.load_artifact()
    except Exception as e:                         # noqa: BLE001 - named, never silent
        miss.append('the frozen matchup artifact does not load: %s' % str(e)[:120])
    return miss


def check_records(games, projections, status):
    """Split the hook's game records into (ok, refused). A record is refused
    when its general margin is not the published projection, or when it would
    move a number while the artifact says NO_ADJUSTMENT."""
    ok, refused = [], []
    for g in games:
        gid = str(g.get('game_id'))
        want = projections.get(gid)
        gen, aware = g.get('general_fair_margin'), g.get('matchup_aware_margin')
        why = None
        if want is None:
            why = 'no published V2.1 projection for this game in this run'
        elif gen is None or abs(float(gen) - float(want)) > 1e-3:
            why = 'general fair margin %s is not the published projection %s' % (gen, want)
        elif status != 'ADJUST' and (aware is None or abs(float(aware) - float(gen)) > 1e-9
                                     or abs(float(g.get('matchup_adjustment_points') or 0.0)) > 1e-9):
            why = 'NO_ADJUSTMENT artifact but the record moves the margin (%s -> %s): refused, never applied' % (gen, aware)
        (refused if why else ok).append(dict(g, _refused=why) if why else g)
    return ok, refused


def run_stage(season, T, X_T, D, store_dir, week=None, hook=None, prereq=None):
    """One MATCHUP_SHADOW stage body. X_T: the frozen snapshot rows at T;
    D: the engine's inference frame (game_id, ens_pred, sigma). Returns the
    stage result dict ({'_status': 'SKIPPED', ...} when it cannot run)."""
    miss = (prereq or prerequisites)(season)
    if miss:
        return {'_status': 'SKIPPED', 'reason': '; '.join(miss)}
    if hook is None:
        from ..matchup import hook as HK
        hook = HK.matchup_week
    from ..matchup import residual as RS
    art = RS.load_artifact()
    P = D[['game_id', 'ens_pred', 'sigma']].copy()
    X = X_T[X_T.game_id.isin(P.game_id)]
    if 'fcs_game' in X:
        X = X[~X.fcs_game.astype(bool)]
    if not len(X):
        return {'_status': 'SKIPPED', 'reason': 'no FBS-vs-FBS game frozen at T'}
    out = hook(season, T, X, projections=P, art=art, week=week)
    proj = {str(int(r.game_id)): round(float(r.ens_pred), 3) for r in P.itertuples()}
    ok, refused = check_records(out.get('game_matchup') or [], proj, art.get('status'))
    path = os.path.join(store_dir, FILE)
    have = {r.get('matchup_id') for r in read_jsonl(path)}
    fresh = [dict(r, record='SHADOW', moves_production=False) for r in ok if r.get('matchup_id') not in have]
    written = append_jsonl(path, fresh)
    return {'artifact': art.get('artifact'), 'artifact_status': art.get('status'), 'games': len(out.get('game_matchup') or []),
            'written': written, 'already_recorded': len(ok) - len(fresh), 'refused': [r['_refused'] for r in refused][:10],
            'n_refused': len(refused)}
