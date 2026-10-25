"""Point-in-time facts about each fighter before every bout, independent of any
rating: what the model's features read (model.py walk), what the backtest
breaks its errors down by (study.py), and what the disagreement guard names
when the model and the market differ (guard.py).

One causal pass over the bouts in the walk's order (start time, bout id). For
each bout and each side (suffix _a / _b):

  n           UFC bouts absorbed before this one (a final with a winner, a draw
              or a no contest: exactly the walk's bout count)
  days_off    whole days since the fighter's last absorbed bout (NaN: none)
  age         years at the bout's start, from the date of birth in
              model_loop/data/ufc/fighters.csv (NaN: no date on file)
  div_step    divisions moved since the last absorbed bout at a standard weight:
              + up, - down, 0 the same, NaN with no earlier standard weight or a
              catchweight / unknown bout now (the 12 divisions, men's and women's
              apart; a move between them is NaN)
  pre_w, pre_l   the professional record before the fighter's FIRST bout in the
              data, from model_loop/data/ufc/fighter_facts.csv (build_facts()),
              which both the loop and the simulator's port read: ESPN's record as
              of records.csv `as_of`, less every result in the data before `as_of`
              ("reconstructed"). For a bout priced now it is exact (the record as
              of now). For a past bout it is exact when every pro bout after the
              fighter's first UFC bout is in the data; a fighter who also fought
              outside the UFC afterwards carries those results back, a hindsight
              the backtest cannot remove (no dated career history is available:
              ingest.py). study.py measures it: the gain on fighters still in the
              UFC, where it can barely act, is about half the full backtest's.
              NaN when no record is on file.
  uw, ul      UFC wins and losses in the data before the bout (decisions with a winner)
  meet        earlier absorbed meetings of these two fighters
  meet_last   fighter_a's result in the most recent one (1, 0, 0.5; NaN: none)
"""
import os

import numpy as np
import pandas as pd

from . import ingest

DIVISIONS = {
    "Flyweight": ("M", 0), "Bantamweight": ("M", 1), "Featherweight": ("M", 2), "Lightweight": ("M", 3),
    "Welterweight": ("M", 4), "Middleweight": ("M", 5), "Light Heavyweight": ("M", 6), "Heavyweight": ("M", 7),
    "W Strawweight": ("W", 0), "W Flyweight": ("W", 1), "W Bantamweight": ("W", 2), "W Featherweight": ("W", 3),
}
DAY = pd.Timedelta(days=1)
FACTS = os.path.join(os.path.dirname(ingest.OUT), "fighter_facts.csv")
FACT_FIELDS = ["fighter_id", "name", "date_of_birth", "first_bout", "pre_w", "pre_l", "pre_d", "pre_source"]


def load_dob(path=ingest.FIGHTERS):
    if not os.path.exists(path):
        return {}
    f = pd.read_csv(path, dtype=str).fillna("")
    out = {}
    for r in f.itertuples():
        t = pd.to_datetime(r.date_of_birth, errors="coerce", utc=True)
        if r.date_of_birth and pd.notna(t):
            out[r.fighter_id] = t
    return out


def load_records(path=ingest.RECORDS):
    """fighter id -> (wins, losses, draws), and the one as_of time (None when the file is absent)"""
    if not os.path.exists(path):
        return {}, None
    f = pd.read_csv(path, dtype=str).fillna("")
    rec, as_of = {}, None
    for r in f.itertuples():
        try:
            w, l, dr = (int(x) for x in r.record.split("-"))
        except ValueError:
            continue
        rec[r.fighter_id] = (w, l, dr)
        as_of = r.as_of or as_of
    return rec, (pd.Timestamp(as_of) if as_of else None)


def pre_data_records(d, rec, as_of):
    """fighter id -> (wins, losses) before the first bout in the data: ESPN's record less every result in the data before as_of"""
    if not rec or as_of is None:
        return {}
    done = d[d.final & (d.ts < as_of)]
    w, l, dr = {}, {}, {}
    for r in done.itertuples():
        if r.draw:
            dr[r.fighter_a_id] = dr.get(r.fighter_a_id, 0) + 1
            dr[r.fighter_b_id] = dr.get(r.fighter_b_id, 0) + 1
        elif not np.isnan(r.y):
            win, lose = (r.fighter_a_id, r.fighter_b_id) if r.y == 1.0 else (r.fighter_b_id, r.fighter_a_id)
            w[win] = w.get(win, 0) + 1
            l[lose] = l.get(lose, 0) + 1
    return {f: (max(0, W - w.get(f, 0)), max(0, L - l.get(f, 0))) for f, (W, L, D) in rec.items()}


def build_facts(d=None, out=FACTS):
    """model_loop/data/ufc/fighter_facts.csv: per fighter, the date of birth and the record before the first bout in the data"""
    import csv
    from . import model as U
    d = U.load(ingest.OUT) if d is None else d
    dob = load_dob()
    rec, as_of = load_records()
    recon = pre_data_records(d, rec, as_of)
    names, first = {}, {}
    for r in d.itertuples():
        for f, n in ((r.fighter_a_id, r.fighter_a), (r.fighter_b_id, r.fighter_b)):
            names[f] = n
            first.setdefault(f, r.ts)
    rows = []
    for f in sorted(names):
        if f in recon:
            (w, l), dr, src = recon[f], "", "reconstructed"
        else:
            w = l = dr = ""
            src = ""
        rows.append({"fighter_id": f, "name": names[f], "date_of_birth": dob[f].strftime("%Y-%m-%d") if f in dob else "",
                     "first_bout": first[f].strftime("%Y-%m-%d"), "pre_w": w, "pre_l": l, "pre_d": dr, "pre_source": src})
    with open(out, "w", newline="") as fh:
        w_ = csv.DictWriter(fh, fieldnames=FACT_FIELDS)
        w_.writeheader()
        w_.writerows(rows)
    return rows


def load_facts(path=FACTS):
    """fighter id -> (date of birth or None, pre_w or None, pre_l or None) from fighter_facts.csv; None when the file is absent"""
    if not os.path.exists(path):
        return None
    f = pd.read_csv(path, dtype=str).fillna("")
    out = {}
    for r in f.itertuples():
        t = pd.to_datetime(r.date_of_birth, errors="coerce", utc=True) if r.date_of_birth else pd.NaT
        out[r.fighter_id] = (t if pd.notna(t) else None, float(r.pre_w) if r.pre_w != "" else None, float(r.pre_l) if r.pre_l != "" else None)
    return out


def compute(d, facts=None):
    """the facts above, one row per bout of d (same index), in the walk's order. The per-fighter facts come from
    fighter_facts.csv (the file the simulator reads too); without it, from fighters.csv and the reconstruction"""
    facts = load_facts() if facts is None else facts
    if facts is None:
        dob0 = load_dob()
        rec, as_of = load_records()
        pre0 = pre_data_records(d, rec, as_of)
        facts = {f: (dob0.get(f), *(pre0.get(f) or (None, None))) for f in set(dob0) | set(pre0)}
    dob = {f: v[0] for f, v in facts.items() if v[0] is not None}
    pre = {f: (v[1], v[2]) for f, v in facts.items() if v[1] is not None}
    n, last, last_div, meets, uw, ul = {}, {}, {}, {}, {}, {}
    cols = {k: np.full(len(d), np.nan) for k in
            ("n_a", "n_b", "days_off_a", "days_off_b", "age_a", "age_b", "div_step_a", "div_step_b",
             "pre_w_a", "pre_l_a", "pre_w_b", "pre_l_b", "uw_a", "ul_a", "uw_b", "ul_b", "meet", "meet_last")}
    div_now = [DIVISIONS.get(str(w)) for w in d.weight_class.values]
    for i, row in enumerate(d.itertuples()):
        a, b, t = row.fighter_a_id, row.fighter_b_id, row.ts
        for s, f in (("a", a), ("b", b)):
            cols["n_" + s][i] = n.get(f, 0)
            cols["uw_" + s][i], cols["ul_" + s][i] = uw.get(f, 0), ul.get(f, 0)
            lt = last.get(f)
            if lt is not None:
                cols["days_off_" + s][i] = (t - lt).days
            if f in dob:
                cols["age_" + s][i] = (t - dob[f]).days / 365.25
            ld, dn = last_div.get(f), div_now[i]
            if ld is not None and dn is not None and ld[0] == dn[0]:
                cols["div_step_" + s][i] = dn[1] - ld[1]
            if f in pre:
                cols["pre_w_" + s][i], cols["pre_l_" + s][i] = pre[f]
        key = (a, b) if a < b else (b, a)
        hist = meets.get(key, [])
        cols["meet"][i] = len(hist)
        if hist:
            winner = hist[-1]
            cols["meet_last"][i] = 0.5 if winner is None else (1.0 if winner == a else 0.0)
        if row.final and (not np.isnan(row.y) or row.draw):
            for f in (a, b):
                n[f] = n.get(f, 0) + 1
                last[f] = t
                if div_now[i] is not None:
                    last_div[f] = div_now[i]
            meets.setdefault(key, []).append(None if row.draw else (a if row.y == 1.0 else b))
            if not row.draw:
                win, lose = (a, b) if row.y == 1.0 else (b, a)
                uw[win] = uw.get(win, 0) + 1
                ul[lose] = ul.get(lose, 0) + 1
    out = pd.DataFrame(cols, index=d.index)
    return out


def side(fx, i, s):
    """one fighter's facts at bout row i (s 'a' or 'b') as a plain dict"""
    g = lambda k: (None if pd.isna(fx[k + "_" + s].iloc[i]) else float(fx[k + "_" + s].iloc[i]))
    return {"ufc_bouts": int(fx["n_" + s].iloc[i]), "days_off": g("days_off"), "age": g("age"), "div_step": g("div_step"),
            "pre_w": g("pre_w"), "pre_l": g("pre_l")}
