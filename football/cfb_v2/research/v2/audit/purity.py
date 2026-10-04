"""Audit items 19 (Python path) and 80 (production vs backtest consistency).

    python3 -m v2.audit.purity     -> $CFB_V2_OUT/audit/purity_python.json

1. predict_live.predict (the production Python scorer, frozen v2.1.0 artifacts) on the 2026
   stage-5 rows, then again with wild market columns injected into the frame (open/close
   lines, gaps, spreads, prices): every pure output must be identical.
2. The same scorer vs the walk-forward research predictions stored in stage 7 for 2026
   (models fitted on 2012-2025 = the artifact): ens_pred, sigma, p_home, intervals.
3. The production browser engine (engine.js pure()) on the frozen rows vs the research p_home_raw
   and interval arithmetic, through node.
"""
import json
import os
import subprocess

import numpy as np
import pandas as pd

from . import _io


def main():
    from v2 import predict_live as PL, walkforward as WF
    X = pd.read_parquet(os.path.join(_io.out_dir(), 'stage5', 'cfb_model_training_snapshots.parquet'))
    X26 = X[X.season.eq(2026)].copy()
    A, gbm = PL.load_artifacts('edgedesk_cfb_v2.1.0')
    D0 = PL.predict(X26, A, gbm)
    rng = np.random.default_rng(_io.SEED)
    Xw = X26.copy()
    for c in ('open_margin', 'close_margin', 'spread_open', 'spread_close', 'line', 'gap_open', 'current_home_line',
              'price_home', 'price_away', 'total_open', 'total_close', 'spread', 'over_under', 'home_pregame_elo'):
        Xw[c] = rng.uniform(-60, 60, len(Xw))
    D1 = PL.predict(Xw, A, gbm)
    keys = ['ens_pred', 'sigma', 'p_home', 'reliability', 'pred_total', 'ens_sd']
    inj = {k: float(np.nanmax(np.abs(D0[k].values - D1[k].values))) for k in keys}
    inj['drivers_equal'] = bool((D0.drivers.astype(str) == D1.drivers.astype(str)).all())
    # 2. vs stage 7
    M = _io.preds()
    m = D0[['game_id', 'ens_pred', 'sigma', 'p_home', 'reliability']].merge(
        M[['game_id', 'ens_pred', 'sigma', 'p_home_raw', 'reliability', 'lo_80', 'hi_80']], on='game_id', suffixes=('', '_wf'))
    cons = {'n': int(len(m)), 'max_abs_diff_ens_pred': float((m.ens_pred - m.ens_pred_wf).abs().max()),
            'max_abs_diff_sigma': float((m.sigma - m.sigma_wf).abs().max()),
            'max_abs_diff_p_home': float((m.p_home - m.p_home_raw).abs().max()),
            'max_abs_diff_reliability': float((m.reliability - m.reliability_wf).abs().max())}
    # 3. engine.js on the frozen/provisional rows vs Python arithmetic on the same row numbers
    V2 = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    js = r"""
    require('%s/params.js'); var E=require('%s/engine.js'); var fs=require('fs');
    var rows=[]; ['current.json','snapshots/2026/replay_to_date.json'].forEach(function(f){
      try{ JSON.parse(fs.readFileSync('%s/'+f,'utf8')).rows.forEach(function(r){rows.push(r)}) }catch(e){} });
    var out=rows.map(function(r){var p=E.pure(r); return {game_id:r.game_id, ens:r.ens_pred, sigma:r.sigma,
      p_row:r.p_home, rel_row:r.reliability_base, mv:p.model_version, st:p.status, pm:p.projected_margin, ph:p.home_win_prob_raw,
      i80:p.intervals?p.intervals.p80:null, conf:p.football_prediction_confidence}});
    console.log(JSON.stringify(out));
    """ % (V2, V2, V2)
    res = json.loads(subprocess.run(['node', '-e', js], capture_output=True, text=True, check=True).stdout)
    E = pd.DataFrame(res)
    e = E[E.st.eq('PREDICTED')].copy()
    P = json.load(open(os.path.join(V2, 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json')))
    df = P['t_df']
    e['p_py'] = 1.0 - WF.t_cdf(-e.ens.astype(float).values / e.sigma.astype(float).values, df)
    zq = P['abs_z_quantiles']
    q80 = zq.get('0.8', zq.get(0.8)) if isinstance(zq, dict) else None
    e['lo80_py'] = e.ens - float(q80) * e.sigma
    eng = {'rows': int(len(E)), 'predicted': int(len(e)),
           'max_abs_diff_p_home_engine_vs_python_t': float((e.ph - e.p_py).abs().max()),
           'max_abs_diff_p_home_engine_vs_row_p_home': float((e.ph - e.p_row).abs().max()),
           'max_abs_diff_lo80_engine_vs_python': float((e.i80.map(lambda x: x[0]) - e.lo80_py).abs().max()),
           'rows_by_model_version_label_in_file': E.groupby('mv').size().to_dict(),
           'max_abs_diff_confidence_vs_row_reliability': float((e.conf - e.rel_row).abs().max())}
    out = {'doc': __doc__, 'python_market_injection_max_abs_diff': inj, 'python_vs_stage7_2026': cons,
           'engine_vs_python': eng}
    _io.write('purity_python.json', out)
    print(json.dumps(out, indent=1, default=str)[:3000])


if __name__ == '__main__':
    main()
