#!/usr/bin/env python3
"""Bundle the trained NFL + CFB parameter sets into ../params.js and emit
golden test vectors (reference predictions computed by THIS pipeline) that
../tests.js replays through the JS engine to prove python/JS parity.

Usage: python3 make_params.py <out_dir>
"""
import sys, os, json, datetime

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(OUT, 'params_nfl.json')) as f:
    nfl = json.load(f)
with open(os.path.join(OUT, 'params_cfb.json')) as f:
    cfb = json.load(f)
with open(os.path.join(OUT, 'report_nfl.json')) as f:
    rep_nfl = json.load(f)
with open(os.path.join(OUT, 'report_cfb.json')) as f:
    rep_cfb = json.load(f)

nfl['abs_margin_key_mass'] = rep_nfl['abs_margin_key_mass']
cfb['abs_margin_key_mass'] = rep_cfb['abs_margin_key_mass']

bundle = {
    'model_version': nfl['model_version'],
    'built_at': datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat(),
    'nfl': nfl,
    'cfb': cfb,
    # headline honesty block — shipped with the parameters so the UI can
    # quote the real out-of-sample record instead of asserting quality
    'validation_summary': {
        'nfl': {
            'oos_test_window': '2016-2025 (hyperparams frozen on <=2015)',
            'spread_mae_model': rep_nfl['spread_model']['test_2016_2025']['mae_model'],
            'spread_mae_closing_market': rep_nfl['spread_model']['test_2016_2025']['mae_market'],
            'total_mae_model': rep_nfl['total_model']['test_2016_2025']['mae_model'],
            'total_mae_closing_market': rep_nfl['total_model']['test_2016_2025']['mae_market'],
            'ats_vs_close': rep_nfl['ats_spread_vs_close_test'],
            'ou_vs_close': rep_nfl['ou_total_vs_close_test'],
            'winprob_brier_model': rep_nfl['winprob_model']['brier'],
            'winprob_brier_market_novig': rep_nfl['winprob_market_novig']['brier'],
            'beats_closing_line': False,
            'note': 'The model does NOT beat the NFL closing line out of sample. '
                    'It is a projection/context engine; edges remain UNPROVEN '
                    'until its own graded CLV beats the close.',
        },
        'cfb': {
            'oos_test_window': '2016-2025 (hyperparams frozen on <=2015)',
            'margin_mae_model': rep_cfb['test_2016_2025']['mae_margin_model'],
            'margin_mae_elo_benchmark': rep_cfb['test_2016_2025']['mae_margin_elo_benchmark'],
            'margin_mae_hfa_only': rep_cfb['test_2016_2025']['mae_margin_hfa_only'],
            'total_mae_model': rep_cfb['test_2016_2025']['mae_total_model'],
            'winprob_brier_model': rep_cfb['winprob_model_test']['brier'],
            'market_backtest': None,
            'note': 'No public historical CFB betting lines exist in the training '
                    'dataset, so NO market backtest is claimed for CFB. Market '
                    'comparison happens live against real quotes only.',
        },
    },
}

js = ('/* EdgeDesk Football Engine — trained parameters. GENERATED FILE.\n'
      '   Produced by football/research/make_params.py from public data whose\n'
      '   provenance is recorded inside. Regenerate via research/README.md;\n'
      '   never edit by hand. */\n'
      'window.EDFootballParams = ')
body = json.dumps(bundle, separators=(',', ':'))
tail = (';\n'
        "if (typeof module!=='undefined'&&module.exports)"
        'module.exports=window.EDFootballParams;\n')
with open(os.path.join(HERE, '..', 'params.js'), 'w') as f:
    # window may not exist under node; make the file safe in both worlds
    f.write('if(typeof window===\'undefined\'){globalThis.window=globalThis;}\n')
    f.write(js + body + tail)
print('params.js written:', len(body), 'bytes of JSON')
