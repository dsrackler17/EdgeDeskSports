"""EdgeDesk model loop: one framework, per-sport adapters.

core/       shared machinery: penalized rating fits with priors, recency
            weights, the key-number margin distribution, calibration,
            exact component attribution, metrics, walk-forward evaluation,
            append-only snapshots.
adapters/   per-sport ingestion, rating dimensions, personnel adjustments,
            environment factors and schedule cadence. NFL is the first.

Nothing in here changes a published number by itself. A model version is
built, backtested walk-forward against the closing line, and only a version
that clears the declared promotion rule on its untouched holdout may feed a
card (see core/walkforward.py and docs/model-loop/).
"""
__version__ = "0.1.0"
