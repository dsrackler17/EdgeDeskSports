"""Shadow monitoring and model-health warnings.

    python3 -m v2.monitor --season 2026            (after shadow, every run)

Writes football/cfb_v2/monitoring.json, which football/cfb_v2/monitor.html
renders. Per week, on the FROZEN rows only (replays are excluded):
accuracy (MAE, RMSE, bias), win-probability Brier and calibration, V2 vs V1
vs candidate 001 on the same games, every model vs the line at the freeze and
the close, CLV, ATS, research status counts, pass rate, largest misses and
model disagreement.

Health warnings are INFORMATION. None of them retrains, re-tunes or disables
anything: a person reads them (RUNBOOK.md, "Health warnings").

  mae_spike            a week's MAE above the backtest expectation + 2 SE
  calibration          season-to-date win-probability miscalibration beyond noise
  missing_pbp          a FINAL game older than 48 h with no play-by-play rows
  stale_odds           a game within 72 h of kickoff with no line observed in 36 h
  stale_injury_source  the board's availability source for an upcoming game is > 72 h old
  bet_count            any BET while BET is disabled, or BET above 10% of games
  ensemble_weights     the live stack weights differ from the exported artifact
  disagreement         C and D disagree beyond the backtest's 99th percentile
  pipeline_stale       current.json older than 36 h in season
  feature_drift        week-matched population-stability index of an output (ens_pred,
                       sigma, ens_sd, pred_total) above 0.25 AND above the 99th
                       percentile of pure sampling noise, vs the holdout seasons
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from . import config as C
from . import common

REPO_V2 = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
# model OUTPUTS, not calendar-driven inputs (games played and rating width move with the week by design)
DRIFT_FEATURES = ('ens_pred', 'sigma', 'ens_sd', 'pred_total')


def reference(version):
    f = os.path.join(REPO_V2, 'artifacts', version, 'meta.json')
    m = json.load(open(f)) if os.path.exists(f) else {}
    return m.get('monitoring_reference', {})


def _psi_counts(cnt, ref):
    cur = (cnt + 0.5) / (cnt.sum() + 0.5 * len(cnt))
    return float(np.sum((cur - ref) * np.log(cur / ref)))


def psi(ref_edges, ref_share, x, n_null=2000, seed=C.SEED):
    """Population-stability index of x against the reference deciles, and the
    99th percentile of the PSI that pure sampling noise produces for a slate of
    the same size (a 60-game slate shows PSI ~0.15 with no drift at all)."""
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    if len(x) < 30 or not ref_edges:
        return None, None
    e = np.asarray(ref_edges, float)
    ref = np.asarray(ref_share, float)
    cnt = np.histogram(np.clip(x, e[0], e[-1]), bins=e)[0]
    rng = np.random.default_rng(seed)
    null = [_psi_counts(rng.multinomial(len(x), ref / ref.sum()), ref) for _ in range(n_null)]
    return _psi_counts(cnt, ref), float(np.percentile(null, 99))


def weekly(O):
    rows = []
    for wk, g in O.groupby('week'):
        f = g[g.final_margin.notna()]
        r = {'week': int(wk), 'frozen_games': int(len(g)), 'final': int(len(f))}
        if len(f):
            e = f.v2 - f.final_margin
            r.update(mae=round(e.abs().mean(), 3), rmse=round(float(np.sqrt((e ** 2).mean())), 3), bias=round(e.mean(), 3))
            yw = (f.final_margin > 0).astype(float)
            if f.v2_p_home.notna().any():
                r['brier'] = round(float(((f.v2_p_home - yw) ** 2).mean()), 4)
            for k in ('v1', 'candidate_001'):
                s = f[f[k].notna()]
                if len(s):
                    r['mae_%s_same_games' % k] = round((s[k] - s.final_margin).abs().mean(), 3)
                    r['mae_v2_vs_%s_games' % k] = round((s.v2 - s.final_margin).abs().mean(), 3)
            for k in ('line_at_freeze', 'close'):
                s = f[f[k].notna()]
                if len(s):
                    r['mae_%s' % k] = round((-s[k] - s.final_margin).abs().mean(), 3)
                    r['mae_v2_same_%s_games' % k] = round((s.v2 - s.final_margin).abs().mean(), 3)
            if f.get('clv_pts') is not None and f.clv_pts.notna().any():
                r['clv_mean'] = round(f.clv_pts.mean(), 3)
            if 'ats_at_freeze_line' in f and f.ats_at_freeze_line.notna().any():
                d = f.ats_at_freeze_line.dropna()
                d = d[d != 0]
                r['ats_at_freeze_line'] = round(float((d == 1).mean()), 3) if len(d) else None
            if 'ats_at_close' in f and f.ats_at_close.notna().any():
                d = f.ats_at_close.dropna()
                d = d[d != 0]
                r['ats_at_close'] = round(float((d == 1).mean()), 3) if len(d) else None
            big = f.assign(abs_err=e.abs()).sort_values('abs_err', ascending=False).head(3)
            r['largest_misses'] = [{'game': '%s @ %s' % (x.away, x.home), 'v2': round(x.v2, 1),
                                    'final': x.final_margin, 'abs_error': round(x.abs_err, 1)} for x in big.itertuples()]
        cd = g.v2_components.dropna()
        dis = [abs(c.get('C_ridge', np.nan) - c.get('D_gbm', np.nan)) for c in cd if isinstance(c, dict)]
        r['disagreement_c_d_mean'] = round(float(np.nanmean(dis)), 3) if dis else None
        rows.append(r)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=C.LIVE_SEASON)
    ap.add_argument('--now', default=None)
    a = ap.parse_args()
    now = pd.Timestamp(a.now) if a.now else pd.Timestamp.now(tz='UTC')
    if now.tzinfo is None:
        now = now.tz_localize('UTC')
    ver = C.MODEL_VERSION
    ref = reference(ver)
    of = os.path.join(REPO_V2, 'shadow', str(a.season), 'outcomes.json')
    O = pd.DataFrame(json.load(open(of))['rows']) if os.path.exists(of) else pd.DataFrame()
    alerts = []

    def alert(kind, level, msg, **ev):
        alerts.append(dict(kind=kind, level=level, message=msg, evidence=ev))

    mon = {'season': a.season, 'model_version': ver, 'generated_at': common.iso(now.to_pydatetime()),
           'scope': 'FROZEN shadow projections only (replays excluded); priced games (FBS-vs-FBS) unless noted',
           'policy': 'warnings inform a person; nothing retrains, re-tunes or disables itself because a warning fired',
           'reference': ref}
    if not O.empty:
        for c in ('v2', 'final_margin', 'v1', 'candidate_001', 'line_at_freeze', 'close', 'v2_p_home', 'clv_pts'):
            if c not in O:
                O[c] = np.nan
        O = O[O.priced.fillna(True).astype(bool)] if 'priced' in O else O
        mon['by_week'] = weekly(O)
        f = O[O.final_margin.notna()]
        mon['season_to_date'] = {'frozen_games': int(len(O)), 'final': int(len(f)),
                                 'mae': round((f.v2 - f.final_margin).abs().mean(), 3) if len(f) else None}
        # --- warnings on accuracy and calibration
        for r in mon['by_week']:
            if r.get('mae') and ref.get('mae') and ref.get('sd_abs_err') and r['final'] >= 20:
                lim = ref['mae'] + 2 * ref['sd_abs_err'] / np.sqrt(r['final'])
                if r['mae'] > lim:
                    alert('mae_spike', 'warn', 'week %d MAE %.2f above the backtest expectation band (%.2f)'
                          % (r['week'], r['mae'], lim), week=r['week'], mae=r['mae'], limit=round(lim, 2))
        if len(f) >= 100 and f.v2_p_home.notna().sum() >= 100:
            yw = (f.final_margin > 0).astype(float)
            gap = float(f.v2_p_home.mean() - yw.mean())
            br = float(((f.v2_p_home - yw) ** 2).mean())
            if abs(gap) > 0.05 or (ref.get('brier') and br > ref['brier'] + 0.02):
                alert('calibration', 'warn', 'season-to-date win probabilities are off by %.3f on average (Brier %.3f)'
                      % (gap, br), mean_gap=round(gap, 4), brier=round(br, 4))
    # --- pipeline / data freshness
    cur_f = os.path.join(REPO_V2, 'current.json')
    if os.path.exists(cur_f):
        cur = json.load(open(cur_f))
        age = (now - pd.Timestamp(cur['generated_at'])).total_seconds() / 3600
        mon['current_json_age_hours'] = round(age, 1)
        if age > 36 and now.month in (8, 9, 10, 11, 12, 1):
            alert('pipeline_stale', 'error', 'current.json is %.0f h old' % age, hours=round(age, 1))
        rows = cur.get('rows', [])
        # submodel disagreement and weights
        if ref.get('c_d_abs_p99'):
            big = [r for r in rows if isinstance(r.get('components'), dict) and 'C_ridge' in r['components']
                   and r['components'].get('D_gbm') is not None
                   and abs(r['components']['C_ridge'] - r['components']['D_gbm']) > ref['c_d_abs_p99']]
            for r in big:
                alert('disagreement', 'info', '%s @ %s: C %.1f vs D %.1f (beyond the backtest 99th percentile %.1f)'
                      % (r['away'], r['home'], r['components']['C_ridge'], r['components']['D_gbm'], ref['c_d_abs_p99']),
                      game_id=r['game_id'])
        # feature drift of the upcoming slate vs the backtest
        if ref.get('drift') and rows:
            Df = pd.DataFrame(rows)
            if 'fair_total' in Df:
                Df['pred_total'] = Df.fair_total
            if 'priced' in Df:                       # the reference is FBS-vs-FBS only
                Df = Df[Df.priced.fillna(True).astype(bool)]
            wk = float(Df.weeks_in.median()) if 'weeks_in' in Df else np.nan
            b = 'week%d' % int(min(16, max(0, np.floor(wk)))) if np.isfinite(wk) else 'week8'
            R = ref['drift'].get(b, {})
            mon['feature_drift_psi'] = {'reference_weeks': b}
            for k in DRIFT_FEATURES:
                if k in Df and k in R:
                    v, q99 = psi(R[k]['edges'], R[k]['share'], Df[k].values)
                    mon['feature_drift_psi'][k] = None if v is None else round(v, 3)
                    mon['feature_drift_psi'][k + '_noise_q99'] = None if q99 is None else round(q99, 3)
                    if v is not None and v > max(0.25, q99):
                        lvl = 'warn' if v > 2 * max(0.25, q99) else 'info'
                        alert('feature_drift', lvl, '%s differs from the 2024-25 reference at %s (PSI %.2f; sampling '
                              'noise alone reaches %.2f)' % (k, b, v, q99),
                              psi=round(v, 3), noise_q99=round(q99, 3), reference_weeks=b)
    # stale odds: upcoming games within 72 h with no line observation in 36 h
    lf = os.path.join(REPO_V2, 'shadow', str(a.season), 'lines.jsonl')
    if os.path.exists(lf) and os.path.exists(cur_f):
        L = pd.DataFrame([json.loads(x) for x in open(lf) if x.strip()])
        last = pd.to_datetime(L.groupby('game_id').observed_at.max(), utc=True) if len(L) else pd.Series(dtype='datetime64[ns, UTC]')
        mdf = os.path.join(C.DATA, 'mline', 'ml_%d.parquet' % a.season)
        retrieved = pd.Timestamp(os.path.getmtime(mdf), unit='s', tz='UTC') if os.path.exists(mdf) else None
        soon = [r for r in json.load(open(cur_f)).get('rows', [])
                if 0 < (pd.Timestamp(r['kickoff']) - now).total_seconds() / 3600 <= 72]
        stale = [r for r in soon if r['game_id'] not in last.index]
        if retrieved is not None and (now - retrieved).total_seconds() / 3600 > 36:
            alert('stale_odds', 'warn', 'the line source was last retrieved %.0f h ago' % ((now - retrieved).total_seconds() / 3600))
        if stale:
            alert('stale_odds', 'info', '%d games within 72 h have no line observation' % len(stale),
                  games=[r['game_id'] for r in stale[:20]])
    # stale injury source (the board's availability feed for upcoming games)
    sf = os.path.join(REPO_V2, '..', 'fbs', 'slate.json')
    if os.path.exists(sf):
        ages = []
        for g in json.load(open(sf)).get('games', []):
            k = g.get('kickoff')
            if not k or not (0 < (pd.Timestamp(k) - now).total_seconds() / 3600 <= 72):
                continue
            for c in g.get('input_contract', []) or []:
                if c.get('field') == 'availability' and c.get('as_of'):
                    ages.append((now - pd.Timestamp(c['as_of'])).total_seconds() / 3600)
        if ages and max(ages) > 72:
            alert('stale_injury_source', 'warn', 'an availability source for an upcoming game is %.0f h old' % max(ages),
                  max_age_hours=round(max(ages), 1))
    # missing play-by-play: FINAL games older than 48 h without team-game rows
    try:
        G = pd.read_parquet(common.out_path('stage2', 'games.parquet'))
        tg = pd.read_parquet(common.out_path('stage1', 'team_game_%d.parquet' % a.season))
        g = G[G.season.eq(a.season) & G.status.eq('FINAL') & ~G.fcs_game
              & (G.kickoff_ts < now - pd.Timedelta(hours=48))]
        miss = g[~g.game_id.isin(tg.game_id)]
        mon['pbp_missing_final_games'] = int(len(miss))
        if len(miss):
            alert('missing_pbp', 'warn', '%d FBS games final for 48 h+ have no play-by-play rows' % len(miss),
                  games=[int(x) for x in miss.game_id.head(20)])
    except Exception as e:                      # the live pipeline may not have stage files yet
        mon['pbp_check'] = 'skipped: %s' % e
    # research statuses: BET must not appear while disabled
    try:
        txt = open(os.path.join(REPO_V2, 'params.js')).read()
        pj = json.loads(txt[txt.index('EDCfbV2Params = ') + len('EDCfbV2Params = '):txt.rindex('; })')])
        mon['bet_enabled'] = bool(pj['market']['bet_enabled'])
        aw = ref.get('stack_weights')
        if aw and pj.get('model_version') == ver:
            art = json.load(open(os.path.join(REPO_V2, 'artifacts', ver, 'models.json')))['stack_weights']
            if any(abs(art.get(k, 0) - v) > 1e-9 for k, v in aw.items()):
                alert('ensemble_weights', 'error', 'live stack weights differ from the validated configuration',
                      artifact=art, expected=aw)
    except Exception as e:
        mon['params_check'] = 'skipped: %s' % e
    dec_f = os.path.join(REPO_V2, 'shadow', str(a.season), 'decisions.json')
    if os.path.exists(dec_f):
        dec = json.load(open(dec_f)).get('counts', {})
        n = sum(dec.values()) or 1
        mon['research_status_counts'] = dec
        mon['pass_rate'] = round(dec.get('PASS', 0) / n, 3)
        if dec.get('BET', 0) and not mon.get('bet_enabled', False):
            alert('bet_count', 'error', 'BET emitted while BET is disabled', counts=dec)
        elif dec.get('BET', 0) / n > 0.10:
            alert('bet_count', 'warn', 'BET on more than 10%% of games', counts=dec)
    lsum = os.path.join(REPO_V2, 'learning', '%d_summary.json' % a.season)
    if os.path.exists(lsum):
        L = json.load(open(lsum))
        mon['learning'] = {k: L.get(k) for k in ('model_version', 'games_scored', 'mae', 'bias', 'major_miss_share',
                                                 'expected_major_miss_share_if_calibrated', 'miss_classes', 'sources',
                                                 'by_model_version')}
    mon['alerts'] = alerts
    mon['ok'] = not any(x['level'] == 'error' for x in alerts)
    with open(os.path.join(REPO_V2, 'monitoring.json'), 'w') as fh:
        json.dump(mon, fh, indent=1, sort_keys=True, default=common._json_default)
    print('[monitor] %d alerts (%s)' % (len(alerts), ', '.join(sorted(set(x['kind'] for x in alerts))) or 'none'))


if __name__ == '__main__':
    main()
