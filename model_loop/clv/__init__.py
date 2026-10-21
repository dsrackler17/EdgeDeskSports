"""Closing-line value: one harness for every EdgeDesk sport.

A model has edge only if the prices it would bet early move toward its
number by the close. Everything in here measures that, and nothing else is
the headline: accuracy against the final score is a diagnostic.

harness.py   bet selection against the opener, CLV in points and in no-vig
             probability, edge buckets, per-season tables, cluster bootstrap
             intervals, the multiple-testing penalty
residual.py  the market-residual model: ridge regression of the open-to-close
             move on the model's disagreement with the opener and a sport's
             information features, fitted walk-forward
sources.py   readers for the line archives the studies use (each documents
             what it does and does not know: books, timestamps, markets)

Nothing in here changes a published number.
"""
