"""EdgeDesk CFB market intelligence, price discovery and bet timing — the research half.

docs/cfb-market/METHODS.md. The market layer is STRICTLY SEPARATE from the pure
football model: nothing in this package writes to, or is read by, the pure
projection (v2.contract.assert_pure refuses every market column), and every
market-informed number here is labelled a MARKET or CHALLENGER number.

    python3 -m v2.market_intel.keynumbers      key numbers, half points, alt lines
    python3 -m v2.market_intel.books           book quality, consensus, opener vs close
    python3 -m v2.market_intel.movement        opener->close moves, resistance, dispersion, gap
    python3 -m v2.market_intel.challenger      market-informed challenger, market residual
    python3 -m v2.market_intel.bias            bias audit (EdgeDesk and the market)
    python3 -m v2.market_intel.replay          replay, execution, line shopping, timing, ladder
    python3 -m v2.market_intel.replay --holdout  the 2024-2025 holdout, scored ONCE
    python3 -m v2.market_intel.report          docs/cfb-market/BACKTEST.md tables
    python3 -m v2.market_intel.tests_market --fast   synthetic tests (no data)

Windows: DEV 2016-2023 is the only window any fit or table-driven choice reads;
the 2024-2025 holdout is scored once, at the end, reported separately.
"""
