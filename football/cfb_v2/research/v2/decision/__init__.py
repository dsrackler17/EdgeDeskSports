"""EdgeDesk CFB decision science — the layer between the frozen pure projection and a wager.

The pure model (edgedesk_cfb_v2.1.0) answers "what is likely to happen". This
package answers a narrower question, with honest uncertainty: WHETHER and WHEN
the model's probabilities and edges against a quoted spread are statistically
credible. It never maximizes ATS, ROI or bet count, and it never alters a
football prediction.

    baseline.py     step 0: freeze the baseline (hashes of every frozen piece)
    core.py         odds, de-vig, break-even, push, EV-with-push, t CDF, CIs
    dataset.py      the point-in-time decision dataset (game x snapshot x quote)
    calibration.py  walk-forward fitters that emit PORTABLE specs (no pickles)
    reference.py    the reference implementation that evaluates the frozen artifact
    study.py        the DEV-only analysis runner (writes out_h/decision/*.json)
    render.py       CALIBRATION.md from the study results
    freeze.py       the frozen calibration artifact, its manifest, the parity fixture
    tests_decision.py

Windows: DEV 2016-2023 is the only window any fitter or selector reads. The
HOLDOUT 2024-2025 is never read by fitting code (assert_dev_only on every fit);
the policy agent scores it once, after thresholds are frozen. LIVE 2026 rows
carry real timestamps and NO prices, so their EV is not computable.
"""
DECISION_SCHEMA = 'cfb_decision_calibration_schema_v1'
ARTIFACT_VERSION = 'cfb_decision_calibration_v1'
BASELINE_ID = 'cfb_decision_baseline_001'
DATASET_VERSION = 'cfb_decision_dataset_v1'
BASE_MODEL_VERSION = 'edgedesk_cfb_v2.1.0'
