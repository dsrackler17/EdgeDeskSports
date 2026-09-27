"""Weekly live run: current-season features -> frozen pure projections (shadow mode).

    python3 -m v2.predict_live --season 2026 [--now 2026-09-29T13:00:00Z]

Features come from the SAME stage code the backtest used (stages 1-5 with
seasons_out=[season]); models come from the frozen artifacts of the model
version (football/cfb_v2/artifacts/<version>/): JSON coefficients and a
LightGBM text model. Nothing is refit here — the retraining policy is one
scheduled offseason retrain, never "after one weird Saturday".

Freezing: every game whose prediction_ts has passed and whose kickoff has not
is written to football/cfb_v2/snapshots/<season>/<prediction_ts>.json the
first time the job runs after that freeze. The file is WRITE-ONCE: a later run
that would produce a different row for an already-frozen game refuses to
overwrite it and records the difference in the run log instead.
Games whose freeze time is still in the future are published in current.json
as PROVISIONAL and are not frozen.
"""
import argparse
import hashlib
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config as C
from . import common
from . import models as MD
from . import walkforward as WF
from . import reliability as REL

REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

DISPLAY_DRIVERS = ['match_pass_edge', 'match_rush_edge', 'match_mix_edge', 'match_trench_edge',
                   'match_havoc_edge', 'match_sack_edge', 'match_explosive_edge', 'match_early_down_edge',
                   'match_passing_down_edge', 'match_finishing_edge', 'match_field_pos_edge', 'match_st_edge',
                   'edge_epa', 'edge_ppd', 'elo_diff', 'qb_delta_edge']
UNC_TEXT = {'early_season': 'early-season sample', 'inv_games': 'few games played',
            'rating_sd_sum': 'uncertain team ratings', 'ens_sd': 'model disagreement',
            'abs_pred': 'lopsided matchup (blowout variance)', 'exp_total_z': 'high-scoring environment',
            'fcs_game_f': 'FCS opponent data', 'qb_missing_any': 'quarterback unknown',
            'qb_unsettled_any': 'quarterback unsettled', 'vol_sum': 'volatile teams',
            'to_dependence': 'turnover-dependent teams'}


class LinearArt:
    def __init__(self, d):
        self.cols, self.mean = d['cols'], np.array(d['mean']),
        self.mean = np.array(d['mean']); self.sd = np.array(d['sd'])
        self.beta = np.array(d['beta']); self.intercept = d['intercept']

    def z(self, X):
        Z = X[self.cols].astype(float).values
        Z = np.where(np.isnan(Z), self.mean, Z)
        return (Z - self.mean) / self.sd

    def predict(self, X):
        Z = self.z(X)
        b = self.beta
        return (b[0] + Z @ b[1:]) if self.intercept else Z @ b

    def contributions(self, X):
        Z = self.z(X)
        b = self.beta[1:] if self.intercept else self.beta
        return pd.DataFrame(Z * b, columns=self.cols, index=X.index)


def load_artifacts(version):
    d = os.path.join(REPO_V2, 'artifacts', version)
    A = json.load(open(os.path.join(d, 'models.json')))
    import lightgbm as lgb
    gbm = lgb.Booster(model_file=os.path.join(d, A['submodels']['D_gbm']['file']))
    return A, gbm


def sigma_from_art(D, S):
    Z = WF.sigma_design(D, S.get('fill'))
    mu = np.array([S['mu'][c] for c in S['cols']]); sd = np.array([S['sd'][c] for c in S['cols']])
    Zs = (Z[S['cols']].values - mu) / sd
    b = np.array([S['coef']['intercept']] + [S['coef'][c] for c in S['cols']])
    contrib = pd.DataFrame(Zs * b[1:], columns=S['cols'], index=D.index)
    return np.sqrt(np.exp(b[0] + Zs @ b[1:])), contrib


def predict(X, A, gbm):
    X = MD.add_derived(X)
    P = pd.DataFrame(index=X.index)
    lin = {k: LinearArt(v) for k, v in A['submodels'].items() if k not in ('D_gbm',)}
    active = [k for k in A['stack_weights']]
    for k in active:
        if k != 'D_gbm':
            P['pred_' + k] = lin[k].predict(X)
    if 'D_gbm' in active:
        P['pred_D_gbm'] = gbm.predict(X[A['submodels']['D_gbm']['cols']].astype(float).values)
    P['pred_total'] = lin['TotalE'].predict(X)
    W = A['stack_weights']
    D = X.join(P)
    D['ens_sd'] = D[['pred_' + k for k in active]].std(axis=1)
    D['ens_pred'] = sum(W[k] * D['pred_' + k] for k in W)
    D['sigma'], sc = sigma_from_art(D, A['sigma_model'])
    D['p_home'] = 1.0 - WF.t_cdf(-D.ens_pred.values / D.sigma.values, A['t_df'])
    lo, hi = A['reliability_range']
    D['reliability'] = REL.score(D, lo, hi)
    cc = lin['C_ridge'].contributions(X)
    wC = W.get('C_ridge', 0.0)
    drivers, udrivers = [], []
    for i in D.index:
        c = cc.loc[i, [f for f in DISPLAY_DRIVERS if f in cc.columns]] * max(wC, 1e-9) / max(wC, 1e-9)
        top = c.abs().sort_values(ascending=False).index[:3]
        drivers.append([{'feature': f, 'points': round(float(c[f]), 2)} for f in top])
        u = sc.loc[i].sort_values(ascending=False)
        udrivers.append([UNC_TEXT.get(f, f) for f in u.index[:2] if u[f] > 0])
    D['drivers'] = drivers
    D['uncertainty_drivers'] = udrivers
    return D


def row_json(r):
    def f(x, k=4):
        return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), k)
    comps = {k: f(r['pred_' + k], 3) for k in WF.SUB if ('pred_' + k) in r}
    qb = {}
    for side, pre in (('home', 'h_'), ('away', 'a_')):
        if r.get(pre + 'qb_missing', 1) == 0:
            qb[side] = {'exp_rating': f(r.get(pre + 'qb_exp_rating')), 'backup_rating': f(r.get(pre + 'qb_backup_rating')),
                        'team_rating': f(r.get(pre + 'qb_team_rating')), 'qb_id': int(r[pre + 'qb_id']) if not pd.isna(r.get(pre + 'qb_id')) else None}
        else:
            qb[side] = None
    return {
        'game_id': int(r['game_id']), 'season': int(r['season']), 'week': int(r['week']),
        'home': r['home_team'], 'away': r['away_team'], 'home_id': int(r['home_id']), 'away_id': int(r['away_id']),
        'neutral_site': bool(r['neutral_site']), 'fcs_game': bool(r['fcs_game']),
        'kickoff': common.iso(r['kickoff_ts'].to_pydatetime()),
        'prediction_ts': common.iso(r['prediction_ts'].to_pydatetime()),
        'feature_ts': common.iso(r['feature_ts'].to_pydatetime()),
        'ens_pred': f(r['ens_pred'], 3), 'sigma': f(r['sigma'], 3), 'ens_sd': f(r['ens_sd'], 3),
        'p_home': f(r.get('p_home'), 4),
        'fair_total': f(r['pred_total'], 1), 'rating_sd_sum': f(r['rating_sd_sum']),
        'min_games': f(r['min_games'], 0), 'early_season': bool(r['early_season']), 'weeks_in': f(r['weeks_in'], 2),
        'qb_unsettled_any': f(r['qb_unsettled_any'], 0), 'qb_missing_any': f(r['qb_missing_any'], 0),
        'reliability_base': f(r['reliability'], 1),
        'components': comps, 'drivers': r['drivers'], 'uncertainty_drivers': r['uncertainty_drivers'],
        'qb': qb,
        # FBS-vs-FCS games are NOT PRICED: the submodels are trained on FBS-vs-FBS
        # games only and the walk-forward shows a growing bias against the FBS
        # side of FCS games (v2.1.0: dev -2.8, holdout -6.1, 2026 -8.8 pts;
        # report/redteam/hardened/phase10_uncertainty.json). The numbers stay
        # in the snapshot so the weakness stays measured.
        'priced': not bool(r['fcs_game']),
        'not_priced_reason': ('FBS-vs-FCS: V2 has no validated FCS model (measured bias against the FBS '
                              'side -6.1 pts on the 2024-25 holdout)') if bool(r['fcs_game']) else None,
    }


def canonical_hash(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def pure_part(row):
    """The projection itself: everything except the shadow block (market,
    V1 and candidate-001 context captured at the run that froze the row)."""
    return {k: v for k, v in row.items() if k != 'shadow'}


def v1_projections():
    """V1 (the champion) as published on the FBS board: football/fbs/slate.json."""
    f = os.path.join(REPO_V2, '..', 'fbs', 'slate.json')
    if not os.path.exists(f):
        return {}
    s = json.load(open(f))
    out = {}
    for g in s.get('games', []):
        try:
            gid = int(g['game_id'])
        except (KeyError, TypeError, ValueError):
            continue
        out[gid] = {'margin': g.get('model_home_margin'), 'home_win_prob': g.get('model_home_win_prob'),
                    'status': g.get('model_status'), 'slate_generated_at': s.get('generated_at'),
                    'source': 'football/fbs/slate.json (V1, cfb_p4 engine)'}
    return out


REPORT_FIELDS = ('availability', 'qb_availability', 'qb_starter')
STARTER_KEYS = ('player_id', 'player_name', 'status', 'confirmed', 'published_at', 'retrieved_at')


def pregame_reports():
    """The pregame availability and QB-status evidence the V1 board held when
    this row was frozen: its per-side input-contract entries (state, source,
    timestamps, a short detail), the named starters, and the digest of the
    availability sync it came from (football/availability/current.json, which
    git keeps in full). Recorded only, never used by V2: this is the
    point-in-time record an injury or QB-status validation will need."""
    f = os.path.join(REPO_V2, '..', 'fbs', 'slate.json')
    if not os.path.exists(f):
        return {}
    s = json.load(open(f))
    af = os.path.join(REPO_V2, '..', 'availability', 'current.json')
    av = json.load(open(af)) if os.path.exists(af) else {}
    sync = {'digest': av.get('digest'), 'generated_at': av.get('generated_at'),
            'file': 'football/availability/current.json'} if av else None
    out = {}
    for g in s.get('games', []):
        try:
            gid = int(g['game_id'])
        except (KeyError, TypeError, ValueError):
            continue
        rep = [{'field': c.get('field'), 'side': c.get('side'), 'state': c.get('state'), 'source': c.get('source'),
                'as_of': c.get('as_of'), 'observed_at': c.get('observed_at'), 'priced_by_v1': c.get('priced'),
                'detail': (c.get('detail') or '')[:120]}
               for c in (g.get('input_contract') or []) if c.get('field') in REPORT_FIELDS]
        st = {side: ({k: (g.get(side + '_starter') or {}).get(k) for k in STARTER_KEYS}
                     if g.get(side + '_starter') else None) for side in ('home', 'away')}
        out[gid] = {'reports': rep, 'starters': st, 'availability_sync': sync,
                    'slate_generated_at': s.get('generated_at')}
    return out


def candidate_projections(X, cid='cfb_v2_candidate_001'):
    """The frozen candidate's projection for the same snapshot rows, from its
    own hash-locked artifacts (football/cfb_v2/candidates/<id>/artifacts)."""
    d = os.path.join(REPO_V2, 'candidates', cid, 'artifacts')
    if not os.path.exists(os.path.join(d, 'models.json')):
        return {}
    import lightgbm as lgb
    A = json.load(open(os.path.join(d, 'models.json')))
    gbm = lgb.Booster(model_file=os.path.join(d, A['submodels']['D_gbm']['file']))
    D = predict(X, A, gbm)
    # Its submodel predictions and their spread travel with it, so the CFB
    # Model Lab can score the candidate's components the way it scores the
    # live model's (instrumentation only: nothing here changes a prediction).
    ks = [k for k in A['stack_weights'] if ('pred_' + k) in D.columns]
    out = {}
    for i in D.index:
        r = D.loc[i]
        out[int(r['game_id'])] = {'ens_pred': round(float(r['ens_pred']), 3), 'sigma': round(float(r['sigma']), 3),
                                  'model_version': A['model_version'],
                                  'components': {k: round(float(r['pred_' + k]), 3) for k in ks},
                                  'ens_sd': round(float(r['ens_sd']), 3)}
    return out


def freeze(rows, season, now, version, base=None):
    """Write-once snapshot files, one per prediction_ts."""
    d = os.path.join(base or os.path.join(REPO_V2, 'snapshots'), str(season))
    os.makedirs(d, exist_ok=True)
    log = {'frozen_new': 0, 'already_frozen': 0, 'refused_overwrites': []}
    by_ts = {}
    for r in rows:
        if pd.Timestamp(r['prediction_ts']) <= now < pd.Timestamp(r['kickoff']):
            by_ts.setdefault(r['prediction_ts'], []).append(r)
    for ts, rs in sorted(by_ts.items()):
        f = os.path.join(d, ts.replace(':', '').replace('-', '') + '.json')
        body = {'model_version': version, 'prediction_ts': ts, 'frozen_at': common.iso(now.to_pydatetime()),
                'layer': 'pure_model_projection', 'rows': []}
        if os.path.exists(f):
            old = json.load(open(f))
            have = {x['row']['game_id']: x for x in old['rows']}
            for r in rs:
                h = canonical_hash(pure_part(r))
                if r['game_id'] in have:
                    log['already_frozen'] += 1
                    prev = have[r['game_id']]
                    if prev.get('pure_hash', prev['hash']) != h:
                        log['refused_overwrites'].append({'game_id': r['game_id'], 'prediction_ts': ts})
                # a game newly visible for an already-written freeze time is NOT
                # added: its freeze has passed without it, so it waits for the
                # next freeze rather than being back-dated
            continue
        body['rows'] = [{'hash': canonical_hash(r), 'pure_hash': canonical_hash(pure_part(r)), 'row': r}
                        for r in sorted(rs, key=lambda x: x['game_id'])]
        with open(f, 'w') as fh:
            json.dump(body, fh, indent=1, sort_keys=True)
        log['frozen_new'] += len(rs)
    return log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=C.LIVE_SEASON)
    ap.add_argument('--now', default=None)
    ap.add_argument('--version', default=C.MODEL_VERSION)
    ap.add_argument('--verify', action='store_true',
                    help='only verify that every frozen row still matches its stored hash')
    ap.add_argument('--replay-history', action='store_true',
                    help='also write the season-to-date replay (labelled REPLAY, never frozen)')
    a = ap.parse_args()
    if a.verify:
        d = os.path.join(REPO_V2, 'snapshots', str(a.season))
        bad = 0
        for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if f == 'replay_to_date.json':
                continue
            for x in json.load(open(os.path.join(d, f)))['rows']:
                if canonical_hash(x['row']) != x['hash']:
                    bad += 1
                    print('TAMPERED', f, x['row']['game_id'])
        print('[verify] %s' % ('ok' if not bad else '%d rows fail their hash' % bad))
        raise SystemExit(1 if bad else 0)
    now = pd.Timestamp(a.now) if a.now else pd.Timestamp.now(tz='UTC')
    if now.tzinfo is None:
        now = now.tz_localize('UTC')
    A, gbm = load_artifacts(a.version)
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    X = X[X.season.eq(a.season)]
    D = predict(X, A, gbm)
    rows = [row_json(r) for _, r in D.iterrows()]
    # shadow context, frozen WITH the row: V1 (the champion), the frozen
    # candidate 001, and the market as observed by this run
    from . import shadow as SH
    v1 = v1_projections()
    pr = pregame_reports()
    c1 = candidate_projections(X)
    mk = SH.market_now(a.season) if os.path.exists(common.out_path('stage2', 'market.parquet')) else {}
    for r in rows:
        gid = r['game_id']
        m = mk.get(gid)
        r['shadow'] = {'v1': v1.get(gid), 'candidate_001': c1.get(gid),
                       'market_at_freeze': ({k: m[k] for k in ('open_home_line', 'current_home_line', 'total_open',
                                                                'total_current', 'source', 'retrieved_at')}
                                            if m else None),
                       'pregame_reports': pr.get(gid),
                       'captured_at': common.iso(now.to_pydatetime()),
                       'note': 'captured by the run that froze this row (at or after the freeze time); '
                               'BOOK home lines (- = home favoured); V1 and candidate 001 are home margins'}
    log = freeze(rows, a.season, now, a.version)
    horizon = now + pd.Timedelta(days=10)
    upcoming = [r for r in rows if now < pd.Timestamp(r['kickoff']) <= horizon]
    for r in upcoming:
        r['state'] = 'FROZEN' if pd.Timestamp(r['prediction_ts']) <= now else 'PROVISIONAL'
    cur = {'model_version': a.version, 'generated_at': common.iso(now.to_pydatetime()),
           'mode': 'shadow', 'champion': 'V1', 'season': a.season,
           'note': 'V2 runs in SHADOW beside V1. Pure projections only; the market decision is computed '
                   'at read time by engine.decide() from live prices.',
           'rows': sorted(({**r, 'shadow': {k: v for k, v in (r.get('shadow') or {}).items() if k != 'pregame_reports'}}
                           for r in upcoming), key=lambda r: (r['kickoff'], r['game_id']))}
    with open(os.path.join(REPO_V2, 'current.json'), 'w') as fh:
        json.dump(cur, fh, indent=1, sort_keys=True)
    if a.replay_history:
        past = [dict(r, state='REPLAY') for r in rows if pd.Timestamp(r['kickoff']) <= now]
        with open(os.path.join(REPO_V2, 'snapshots', str(a.season), 'replay_to_date.json'), 'w') as fh:
            json.dump({'model_version': a.version, 'generated_at': common.iso(now.to_pydatetime()),
                       'label': 'REPLAY: point-in-time features and models trained through %d, generated '
                                'after these games were played. Evidence of method, not of live foresight.'
                                % (a.season - 1), 'rows': past}, fh, indent=1, sort_keys=True)
    print('[live] %d rows (%d upcoming); freeze log %s' % (len(rows), len(upcoming), log))


if __name__ == '__main__':
    main()
