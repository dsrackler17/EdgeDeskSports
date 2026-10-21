"""Step 3: what price does each rule need? Descriptive only: it reads seasons
already scored (development and the Phase 6 holdout) and selects nothing.

  python3 -m model_loop.clv_early.prices

  1. break-even: each bet's no-vig probability of winning at its own number,
     taken from the closing market, priced at a grid of American odds; the
     price at which the rule's mean return is zero
  2. line shopping (CFB 2023-25, the seasons with several books' openers): the
     best opening number across Bovada, DraftKings and ESPN Bet for the side the
     rule bets, against the bet book alone
  3. earlier entry (NFL): the same v2.1.0 totals rule against SBR's opener
     (often posted before the previous week is played) and against the Tuesday line
"""
import json
import os

import numpy as np
import pandas as pd

from . import harness as H
from . import run as R

GRID = [-120, -115, -112, -110, -108, -105, -103, -102, 100, 105]


def dec(a):
    a = np.asarray(a, float)
    return np.where(a > 0, 1 + a / 100.0, 1 + 100.0 / np.abs(a))


def american(d):
    return round(100 * (d - 1)) if d >= 2 else round(-100 / (d - 1))


def p_side(df, sport, market, thr):
    """Per bet: the closing market's no-vig probability that the bet wins at its own number."""
    d = H.place_bets(df, H.Config(threshold=thr, market=market), R.distribution(sport, market))
    d = d[d.bet].copy()
    po = H.closing_p_over(R.distribution(sport, market), d.close_line.values.astype(float),
                          d["close_p"].astype(float).fillna(0.5).values if "close_p" in d else np.full(len(d), 0.5),
                          d.bet_line.values.astype(float))
    d["p"] = np.where(d.side > 0, po, 1 - po)
    return d


def price_table(d):
    p = d.p.values
    row = {f"{g:+d}": float(np.mean(p * dec(g) - 1)) for g in GRID}
    be = 1.0 / float(np.mean(p))
    row["breakeven_american"] = american(be)
    row["n"] = int(len(d))
    row["mean_p"] = float(np.mean(p))
    return row


def rules():
    pn = R.read_pred(os.path.join(R.CACHE, "pred_nfl_v21.csv"))
    pc = R.read_pred(os.path.join(R.CACHE, "pred_cfb_loop_lag1.parquet"))
    out = {}
    for name, sport, pred, mk, thr, kw in (
            ("H-3 NFL v2.1.0 total >=2", "nfl", pn, "total", 2.0, {"fresh": True}),
            ("H-4 CFB Loop W-2 spread >=3", "cfb", pc, "spread", 3.0, {}),
            ("H-5 CFB Loop W-2 total >=3", "cfb", pc, "total", 3.0, {}),
            ("H-1 NFL v2.1.0 spread >=2 (failed gate)", "nfl", pn, "spread", 2.0, {"fresh": True})):
        for part, seasons in (("development", None), ("holdout 2025-26", [2025, 2026])):
            df = R.frame(sport, pred, mk, seasons=seasons, unlock=seasons is not None, **kw)
            out[f"{name} | {part}"] = price_table(p_side(df, sport, mk, thr))
    return out


def shopping():
    """CFB 2023-25: best opening number across the three books with openers."""
    b = pd.read_csv(os.path.join(R.ROOT, ".cache", "model_loop", "cfb", "build", "market_books.csv"), low_memory=False)
    b = b[b.close_conflict.isna() & b.open_conflict.isna() & b.book.isin(["Bovada", "DraftKings", "ESPN Bet"])]
    b = b[b.season.between(2023, 2025) & b.open.notna() & b.close.notna() & ((b.close - b.open).abs() <= 10)]
    b["game_id"] = b.game_id.astype(int).astype(str)
    pc = R.read_pred(os.path.join(R.CACHE, "pred_cfb_loop_lag1.parquet"))
    out = {}
    for mk, thr in (("spread", 3.0), ("total", 3.0)):
        piv = b[b.market == mk].pivot_table(index="game_id", columns="book", values="open", aggfunc="first")
        df = R.frame("cfb", pc, mk, seasons=[2023, 2024, 2025], unlock=True, close="consensus")
        d = p_side(df, "cfb", mk, thr)
        d = d[d.game_id.isin(piv.index)].copy()
        books = piv.reindex(d.game_id)
        # best number for the bet's side: lowest home margin for home / over side is the LOWER total for over
        best = np.where(d.side.values > 0, books.min(axis=1).values, books.max(axis=1).values)
        n_books = books.notna().sum(axis=1).values
        d["best_open"] = best
        d = d[(n_books >= 2) & np.isfinite(best)]
        shop = d.assign(bet_line=d.best_open)[["game_id", "season", "week", "model", "bet_line", "close_line"]].copy()
        shop["model"] = shop.bet_line + d.side.values * 100.0          # force the same side as the bet-book bet
        ds = p_side(shop, "cfb", mk, 0.0)
        out[mk] = {"games": int(len(d)), "bet book only": price_table(d),
                   "best of 3 books": price_table(ds),
                   "mean points gained by shopping": float(np.mean(d.side.values * (d.bet_line.values - d.best_open.values))),
                   "clv_pts bet book": float(d.clv_pts.mean()), "clv_pts best": float(np.mean(ds.clv_pts))}
    return out


def earlier_entry():
    """NFL v2.1.0 totals >=2 against SBR's opener vs the Tuesday line (2020-21 overlap and SBR 2011-21)."""
    from .cross import sbr_games, harness_frame
    m, _ = sbr_games()
    m["game_id"] = m.game_id.astype(str)
    P = R.read_pred(os.path.join(R.CACHE, "pred_nfl_v21.csv")).set_index("game_id")
    out = {}
    for tag, seasons in (("SBR open 2011-21", list(range(2011, 2022))), ("SBR open 2020-21", [2020, 2021])):
        src = m[m.season.isin(seasons)]
        df = harness_frame(src, src.game_id.map(P.model_total), "total")
        out[tag] = price_table(p_side(df, "nfl", "total", 2.0))
    df = R.frame("nfl", P.reset_index(), "total", seasons=[2020, 2021], fresh=True)
    df = df[df.game_id.isin(set(m[m.season.isin([2020, 2021])].game_id))]
    out["Tuesday line 2020-21 (same games)"] = price_table(p_side(df.drop(columns=["close_p"]), "nfl", "total", 2.0))
    return out


def main():
    res = {"rules": rules(), "shopping_cfb_2023_25": shopping(), "earlier_entry_nfl_totals": earlier_entry()}
    os.makedirs(R.RESULTS, exist_ok=True)
    with open(os.path.join(R.RESULTS, "step3_prices.json"), "w") as f:
        json.dump(res, f, indent=1, default=R._js)
    cols = ["-110", "-108", "-105", "-103", "-102", "+100"]
    print(f"{'rule':52} {'n':>5} " + " ".join(f"{c:>7}" for c in cols) + "  break-even")
    for k, v in list(res["rules"].items()) + [(f"NFL totals >=2 vs {k}", v) for k, v in res["earlier_entry_nfl_totals"].items()]:
        print(f"{k:52} {v['n']:>5} " + " ".join(f"{100 * v[c]:+6.2f}%" for c in cols) + f"  {v['breakeven_american']:+d}")
    for mk, v in res["shopping_cfb_2023_25"].items():
        print(f"CFB {mk} 2023-25 shopping: games {v['games']}, +{v['mean points gained by shopping']:.2f} pts better number; "
              f"CLV {v['clv_pts bet book']:+.3f} -> {v['clv_pts best']:+.3f}; ROI@-110 {100 * v['bet book only']['-110']:+.2f}% -> "
              f"{100 * v['best of 3 books']['-110']:+.2f}%; break-even {v['bet book only']['breakeven_american']:+d} -> "
              f"{v['best of 3 books']['breakeven_american']:+d}")
    return res


if __name__ == "__main__":
    main()
