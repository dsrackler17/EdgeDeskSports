"""The UFC loop: preregistered tuning and backtest, then a per-event learning
loop. EXPERIMENTAL throughout: no closing prices are archived for UFC, so
everything here is graded against results only and nothing claims value.

  python3 -m model_loop.adapters.ufc.loop prereg     # the protocol, hashed (committed before any tuning)
  python3 -m model_loop.adapters.ufc.loop backtest   # tune on 2016-2020, report 2021-2024 and the 2025 holdout,
                                                     # create the version history (once)
  python3 -m model_loop.adapters.ufc.loop refresh    # ratings through now; price the next 14 days of bouts
  python3 -m model_loop.adapters.ufc.loop score      # grade every published pregame number that has a result
  python3 -m model_loop.adapters.ufc.loop research   # candidates -> full walk-forward -> promote?
  python3 -m model_loop.adapters.ufc.loop report     # docs/model-loop/ufc/weekly_model_report.md
  python3 -m model_loop.adapters.ufc.loop all        # what the Sunday run does

THE PREREGISTERED RULE (docs/model-loop/ufc/prereg.json, written before the
multi-year data existed in this repository): the tuned Elo is served only if,
on the validation seasons 2021-2024 (n >= 1000 decided bouts), its log loss
beats the coin flip with the paired 95% interval below zero, AND its 2025
holdout log loss is below the coin flip's. Otherwise nothing is published:
UFC stays research only, as it is today.

THE WEEKLY RULE: a candidate replaces the served configuration only if, over
2016 to date, log loss falls by >= 0.0005 with its paired 95% interval below
zero and the Brier score is no worse, and the most recent full season is no
worse on either. Every candidate is logged.
"""
import argparse
import copy
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ...core import metrics as M
from ...core.versions import Versions
from ...core.walkforward import content_hash
from . import ingest
from . import model as U

ROOT = ingest.ROOT
DATA = ingest.OUT
DOCS = os.path.join(ROOT, "docs", "model-loop", "ufc")
PUB = os.path.join(ROOT, "model_loop", "published", "ufc")
LEDGER = os.path.join(ROOT, "model_loop", "ledger", "ufc")
WINDOWS = {"burn_in": [2014, 2015], "tune": [2016, 2020], "validation": [2021, 2024], "holdout": [2025, 2025], "live": [2026, 2099]}
GRID = {"k": [16, 24, 32, 48, 64], "k_new_mult": [1.0, 1.5, 2.0], "layoff_regress": [0.0, 0.25], "calibration": ["none", "slope"]}
MIN_VALIDATION_N = 1000
MIN_GAIN_LL = 0.0005
CATALOGUE = [
    ("k_lower", "k", ("mul", 0.75)), ("k_higher", "k", ("mul", 1.33)),
    ("new_faster", "k_new_mult", ("add", 0.5)), ("new_slower", "k_new_mult", ("add", -0.5)),
    ("new_window_longer", "new_bouts", ("set", 6)),
    ("layoff_more", "layoff_regress", ("add", 0.15)), ("layoff_less", "layoff_regress", ("add", -0.15)),
    ("calibration_toggle", "calibration", ("toggle", None)),
]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _jload(path):
    with open(path) as f:
        return json.load(f)


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else str(o))


def _in(rows, w):
    return (rows.season >= w[0]) & (rows.season <= w[1])


def run(d, cfg):
    rows, state = U.walk(d, cfg)
    rows, fits = U.calibrate(rows, cfg, WINDOWS["tune"][0])
    return rows, state, fits


# ------------------------------------------------------------------ prereg
def prereg_doc():
    return {"schema": "edgedesk_model_loop_ufc_prereg_v1", "model": "walk-forward Elo (model_loop/adapters/ufc/model.py)",
            "data": "ESPN public scoreboard, month by month from 2014 (model_loop/adapters/ufc/ingest.py); "
                    "a bout is scored when it ended with a winner; draws update ratings at 0.5 and are not scored",
            "windows": WINDOWS, "grid": GRID, "selection": "lowest tune-window log loss over every decided bout",
            "serve_rule": {"validation": f"n >= {MIN_VALIDATION_N} and log loss below the coin flip with the paired 95% "
                                         "interval below zero", "holdout": "2025 log loss below the coin flip (read once)"},
            "weekly_rule": f"full 2016-to-date log loss falls by >= {MIN_GAIN_LL} with its paired 95% interval below zero, "
                           "Brier no worse, and the most recent full season no worse on either",
            "symmetry": "no feature depends on which fighter the feed lists first",
            "disclosure": "Before this file was written, only the data pack's 2024 bouts were in the repository; the "
                          "Elo was run on them (engine/lab/ufc_elo.json; and once here to check the code). Nothing "
                          "from 2014-2023 or 2025-2026 had been read."}


def cmd_prereg():
    doc = prereg_doc()
    doc["sha256"] = content_hash({k: v for k, v in doc.items() if k != "sha256"})
    dump(os.path.join(DOCS, "prereg.json"), doc)
    print(f"prereg sha256 {doc['sha256']}", file=sys.stderr)


def _check_prereg():
    doc = _jload(os.path.join(DOCS, "prereg.json"))
    want = content_hash({k: v for k, v in doc.items() if k != "sha256"})
    if want != doc["sha256"] or {k: v for k, v in doc.items() if k != "sha256"} != json.loads(json.dumps(prereg_doc())):
        raise SystemExit("prereg.json does not match the code's protocol: change neither after the fact")
    return doc["sha256"]


# ---------------------------------------------------------------- backtest
def cmd_backtest():
    sha = _check_prereg()
    d = U.load(DATA)
    have = sorted(d.season.unique().tolist())
    tune_seasons = [s for s in range(WINDOWS["tune"][0], WINDOWS["tune"][1] + 1)]
    if not set(tune_seasons) <= set(have):
        raise SystemExit(f"the tune window needs seasons {tune_seasons}; the data has {have}: run ingest fetch/build first")
    log = []
    best = None
    for k in GRID["k"]:
        for kn in GRID["k_new_mult"]:
            for lr in GRID["layoff_regress"]:
                for cal in GRID["calibration"]:
                    cfg = dict(U.DEFAULTS, k=k, k_new_mult=kn, layoff_regress=lr, calibration=cal)
                    rows, _, _ = run(d, cfg)
                    s = U.score(rows, _in(rows, WINDOWS["tune"]))
                    log.append({"config": cfg, "tune_logloss": s["logloss"], "tune_n": s["n"]})
                    if best is None or s["logloss"] < best[0]:
                        best = (s["logloss"], cfg)
    os.makedirs(DOCS, exist_ok=True)
    with open(os.path.join(DOCS, "tuning_log.jsonl"), "w") as f:
        for r in log:
            f.write(json.dumps(r) + "\n")
    cfg = best[1]
    rows, _, fits = run(d, cfg)
    both = (rows.a_bouts > 0) & (rows.b_bouts > 0)
    ev = {w: {"all": U.score(rows, _in(rows, WINDOWS[w])), "both_experienced": U.score(rows, _in(rows, WINDOWS[w]) & both)}
          for w in ("tune", "validation", "holdout", "live")}
    v, h = ev["validation"]["all"], ev["holdout"]["all"]
    reasons = []
    if v.get("n", 0) < MIN_VALIDATION_N:
        reasons.append(f"validation has {v.get('n', 0)} decided bouts, fewer than {MIN_VALIDATION_N}")
    ci = (v.get("vs_coin_flip") or {}).get("ci95")
    if not ci or ci[1] >= 0:
        reasons.append(f"validation log loss vs the coin flip: 95% interval {ci} is not below zero")
    if not h.get("n") or h["logloss"] >= h["coin_flip_logloss"]:
        reasons.append(f"2025 holdout log loss {h.get('logloss')} is not below the coin flip's {h.get('coin_flip_logloss')}")
    serve = not reasons
    out = {"schema": "edgedesk_model_loop_ufc_backtest_v1", "prereg_sha256": sha, "generated_at": now_iso(),
           "seasons_in_data": have, "bouts": int(len(d)), "decided": int(d.y.notna().sum()), "final_config": cfg,
           "tune_best_logloss": best[0], "variants": len(log), "calibration_slopes": fits, "evaluation": ev,
           "decision": {"serve": serve, "reasons": reasons or ["clears every condition"]}}
    dump(os.path.join(DOCS, "backtest.json"), out)
    vp = os.path.join(DOCS, "versions.json")
    if not os.path.exists(vp):
        first = {"version": "1.0.0", "parent": None, "config": cfg, "config_sha256": content_hash(cfg),
                 "status": "SERVED (EXPERIMENTAL)" if serve else "NOT SERVED", "promoted_by": "preregistered-rule" if serve else None,
                 "promoted_at": now_iso(),
                 "reason": ("Cleared the preregistered rule: " if serve else "Did not clear the preregistered rule: ")
                           + "; ".join(out["decision"]["reasons"]) + f". Validation 2021-2024 log loss {v.get('logloss')} "
                           f"(coin flip {v.get('coin_flip_logloss')}); 2025 holdout {h.get('logloss')}. Outcome-graded only: "
                           "no UFC closing prices are archived.",
                 "evidence": {"validation": {k: v.get(k) for k in ("n", "logloss", "brier", "accuracy", "vs_coin_flip")},
                              "holdout_2025": {k: h.get(k) for k in ("n", "logloss", "brier", "accuracy", "vs_coin_flip")}}}
        Versions.create(vp, "UFC", first)
    print(f"ufc backtest: best tune LL {best[0]} with {cfg}; validation {v.get('logloss')} (n {v.get('n')}), "
          f"holdout {h.get('logloss')}; serve={serve}", file=sys.stderr)
    return out


# ----------------------------------------------------------------- refresh
def served():
    vp = os.path.join(DOCS, "versions.json")
    if not os.path.exists(vp):
        return None
    V = Versions(vp)
    return V.current if str(V.current.get("status", "")).startswith("SERVED") else None


def cmd_refresh(fetch=True):
    if fetch:
        ingest.fetch()
        ingest.build()
    d = U.load(DATA)
    cur = served()
    now = pd.Timestamp.now(tz="UTC")
    missing = d[(d.ts < now - pd.Timedelta(hours=12)) & ~d.status.isin(sorted(ingest.DONE))]
    out = {"schema": "edgedesk_model_loop_ufc_current_v1", "generated_at": now_iso(), "status": "EXPERIMENTAL",
           "data_status": {"status": "DEGRADED" if len(missing) else "OK",
                           "reasons": [f"{len(missing)} bout(s) past their start have no result in the data yet"] if len(missing) else [],
                           "missing_results": missing.bout_id.tolist()[:50]},
           "note": "Outcome-graded research only: no UFC closing prices are archived, so nothing here is compared with "
                   "a market or claims value. A bout is priced the same whichever fighter is listed first."}
    if cur is None:
        ran = os.path.exists(os.path.join(DOCS, "backtest.json"))
        out.update(served=None, bouts=[], reason=("No version is served: the tuned Elo did not clear the preregistered rule "
                                                  "(docs/model-loop/ufc/backtest.json)" if ran else
                                                  "No version is served yet: the preregistered backtest has not run (it needs "
                                                  "the 2014-2025 bouts, fetched by the first scheduled run)")
                                                 + ", so no fight probability is published.")
        dump(os.path.join(PUB, "current.json"), out)
        print("ufc refresh: nothing served", file=sys.stderr)
        return out
    rows, state, fits = run(d, cur["config"])
    up = rows[(rows.status == "STATUS_SCHEDULED") & (rows.ts >= now) & (rows.ts <= now + pd.Timedelta(days=14))]
    bouts = []
    for r in up.itertuples():
        bouts.append({"bout_id": r.bout_id, "event_id": r.event_id, "event": r.event_name, "start": r.ts.strftime("%Y-%m-%dT%H:%MZ"),
                      "weight_class": r.weight_class, "fighter_a": {"id": r.fighter_a_id, "name": r.fighter_a, "ufc_bouts_in_data": int(r.a_bouts)},
                      "fighter_b": {"id": r.fighter_b_id, "name": r.fighter_b, "ufc_bouts_in_data": int(r.b_bouts)},
                      "p_a": round(float(r.p), 4), "p_b": round(1 - float(r.p), 4),
                      "basis": "debut: priced as an average fighter" if min(r.a_bouts, r.b_bouts) == 0 else "Elo from every earlier UFC bout in the data"})
    out.update(served={"version": cur["version"], "promoted_at": cur["promoted_at"], "reason": cur["reason"]},
               config_sha256=cur["config_sha256"], calibration_slopes=fits, bouts=bouts)
    dump(os.path.join(PUB, "current.json"), out)
    os.makedirs(LEDGER, exist_ok=True)
    path = os.path.join(LEDGER, f"cards_{now.year}.jsonl")
    last = {}
    if os.path.exists(path):
        for line in open(path):
            if line.strip():
                x = json.loads(line)
                last[x["bout_id"]] = x["content_sha256"]
    added = 0
    with open(path, "a") as f:
        for b in bouts:
            body = {"bout_id": b["bout_id"], "version": cur["version"], "fighter_a_id": b["fighter_a"]["id"],
                    "fighter_b_id": b["fighter_b"]["id"], "p_a": b["p_a"], "start": b["start"]}
            sha = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            if last.get(b["bout_id"]) == sha:
                continue
            f.write(json.dumps(dict(body, published_at=out["generated_at"], content_sha256=sha), sort_keys=True) + "\n")
            added += 1
    print(f"ufc refresh: {len(bouts)} bouts priced by v{cur['version']}; {added} ledger rows", file=sys.stderr)
    return out


# ------------------------------------------------------------------- score
def cmd_score():
    d = U.load(DATA).set_index("bout_id")
    pubs = {}
    for p in sorted(os.listdir(LEDGER)) if os.path.exists(LEDGER) else []:
        if p.startswith("cards_"):
            for line in open(os.path.join(LEDGER, p)):
                if line.strip():
                    x = json.loads(line)
                    pubs.setdefault(x["bout_id"], []).append(x)
    rows = []
    for bid, hist in pubs.items():
        if bid not in d.index:
            continue
        g = d.loc[bid]
        if np.isnan(g.y):
            continue
        pre = [x for x in hist if pd.Timestamp(x["published_at"]) < g.ts]
        if not pre:
            continue
        x = sorted(pre, key=lambda r: r["published_at"])[-1]
        same = x["fighter_a_id"] == g.fighter_a_id
        p = x["p_a"] if same else 1 - x["p_a"]                     # graded the same whichever order the feed shows now
        rows.append({"bout_id": bid, "event": g.event_name, "fighter_a": g.fighter_a, "fighter_b": g.fighter_b,
                     "version": x["version"], "published_at": x["published_at"], "p_a": p, "result_a": float(g.y),
                     "brier": (p - g.y) ** 2, "order_kept_after_result": bool(same)})
    out = {"schema": "edgedesk_model_loop_ufc_record_v1", "generated_at": now_iso(), "bouts": rows,
           "rules": "Pregame only: each bout is graded on the last number published before its start."}
    if rows:
        df = pd.DataFrame(rows)
        out["summary"] = {"n": len(df), "logloss": round(M.logloss(df.p_a, df.result_a), 5), "brier": round(float(df.brier.mean()), 5),
                          "coin_flip_logloss": round(float(np.log(2)), 5),
                          "accuracy": round(float(((df.p_a > 0.5) == (df.result_a > 0.5)).mean()), 4),
                          "feed_order_kept_after_result": round(float(df.order_kept_after_result.mean()), 4)}
    dump(os.path.join(PUB, "record.json"), out)
    print(f"ufc score: {len(rows)} published pregame numbers graded", file=sys.stderr)
    return out


# ---------------------------------------------------------------- research
def _apply(cfg, key, how):
    c = copy.deepcopy(cfg)
    kind, v = how
    cur = c.get(key, U.DEFAULTS.get(key))
    if kind == "mul":
        new = round(cur * v, 4)
    elif kind == "add":
        new = round(min(1.0 if key == "layoff_regress" else 5.0, max(0.0 if key == "layoff_regress" else 1.0, cur + v)), 4)
    elif kind == "toggle":
        new = "none" if cur == "slope" else "slope"
    else:
        new = v
    if new == cur:
        return None
    c[key] = new
    return c


def cmd_research(only=None):
    cur = served()
    if cur is None:
        print("ufc research: nothing served, nothing to challenge", file=sys.stderr)
        return None
    d = U.load(DATA)
    full_w = [WINDOWS["tune"][0], int(d.season.max())]
    last_full = int(d[d.y.notna()].season.max()) - (1 if pd.Timestamp.now(tz="UTC").month < 12 else 0)
    base, _, _ = run(d, cur["config"])
    m_full, m_rec = _in(base, full_w), base.season == last_full
    s0, r0 = U.score(base, m_full), U.score(base, m_rec)
    results = []
    for cid, key, how in CATALOGUE:
        if only and cid not in only:
            continue
        cfg = _apply(cur["config"], key, how)
        rec = {"at": now_iso(), "served_version": cur["version"], "candidate": cid, "change": {"key": key, "how": list(how)}}
        if cfg is None:
            results.append(dict(rec, decision="SKIPPED", reason="no change from the served configuration"))
            continue
        rows, _, _ = run(d, cfg)
        s, r = U.score(rows, m_full), U.score(rows, m_rec)
        dec = rows.loc[base.index[m_full & base.y.notna()]]
        cmp = M.paired_logloss_test(dec.p.values, base.loc[dec.index, "p"].values, dec.y.values)
        dll, dbr = s["logloss"] - s0["logloss"], s["brier"] - s0["brier"]
        reasons = []
        if dll > -MIN_GAIN_LL:
            reasons.append(f"log loss change {dll:+.5f} does not clear -{MIN_GAIN_LL}")
        if not cmp or cmp["ci95"][1] >= 0:
            reasons.append(f"95% interval {cmp and cmp['ci95']} is not below zero")
        if dbr > 0:
            reasons.append(f"Brier worse ({dbr:+.5f})")
        if r.get("n") and (r["logloss"] > r0["logloss"] or r["brier"] > r0["brier"]):
            reasons.append(f"worse on {last_full}")
        results.append(dict(rec, config=cfg, delta={"logloss": round(dll, 6), "brier": round(dbr, 6),
                                                    f"{last_full}_logloss": round(r.get("logloss", 0) - r0.get("logloss", 0), 6)},
                            ci95=cmp and cmp["ci95"], decision="FAIL" if reasons else "PASS", reason="; ".join(reasons) or "clears every condition"))
        print(f"ufc candidate {cid}: {results[-1]['decision']} ({results[-1]['reason']})", file=sys.stderr)
    with open(os.path.join(DOCS, "candidates.jsonl"), "a") as f:
        for r in results:
            f.write(json.dumps({k: v for k, v in r.items() if k != "config"}) + "\n")
    passed = [r for r in results if r["decision"] == "PASS"]
    promoted = None
    if passed:
        best = min(passed, key=lambda r: r["delta"]["logloss"])
        V = Versions(os.path.join(DOCS, "versions.json"))
        promoted = V.promote(best["config"], reason=f"weekly loop: candidate {best['candidate']} cleared the full-window rule",
                             evidence={"delta": best["delta"], "ci95": best["ci95"]}, status="SERVED (EXPERIMENTAL)")
    summary = {"at": now_iso(), "served_before": cur["version"], "promoted": promoted["version"] if promoted else None,
               "window": full_w, "recent_full_season": last_full, "baseline": {"full": s0, "recent": r0},
               "candidates": [{k: v for k, v in r.items() if k != "config"} for r in results]}
    dump(os.path.join(DOCS, "weekly", now_iso()[:10] + ".json"), summary)
    return summary


def cmd_report():
    files = sorted(os.listdir(os.path.join(DOCS, "weekly"))) if os.path.exists(os.path.join(DOCS, "weekly")) else []
    bt = _jload(os.path.join(DOCS, "backtest.json")) if os.path.exists(os.path.join(DOCS, "backtest.json")) else None
    rec = _jload(os.path.join(PUB, "record.json")) if os.path.exists(os.path.join(PUB, "record.json")) else None
    cur = served()
    md = ["# UFC weekly model report\n", f"Generated {now_iso()}. EXPERIMENTAL and outcome-graded only: no UFC closing prices are archived.\n"]
    md.append(f"Served: **{cur['version']}**.\n" if cur else "Served: **nothing**. The tuned Elo has not cleared the preregistered rule; no fight probability is published.\n")
    if bt:
        md.append("## Preregistered backtest\n")
        md.append("| Window | n | Log loss | Coin flip | 95% interval of the difference | Brier | Accuracy |\n|---|---|---|---|---|---|---|")
        for w in ("tune", "validation", "holdout", "live"):
            x = bt["evaluation"][w]["all"]
            if x.get("n"):
                md.append(f"| {w} {WINDOWS[w][0]}–{min(WINDOWS[w][1], max(bt['seasons_in_data']))} | {x['n']} | {x['logloss']} | {x['coin_flip_logloss']} | "
                          f"{(x.get('vs_coin_flip') or {}).get('ci95')} | {x['brier']} | {x['accuracy']} |")
        md.append(f"\nDecision: {'served' if bt['decision']['serve'] else 'not served'} — " + "; ".join(bt["decision"]["reasons"]) + ".\n")
    if rec and rec.get("summary"):
        s = rec["summary"]
        md.append("## The published record\n")
        md.append(f"{s['n']} bouts graded pregame: log loss {s['logloss']} (coin flip {s['coin_flip_logloss']}), Brier {s['brier']}, "
                  f"accuracy {s['accuracy']}. The feed kept its fighter order after the result in {s['feed_order_kept_after_result']:.0%} of them.\n")
    if files:
        w = _jload(os.path.join(DOCS, "weekly", files[-1]))
        md.append("## This week's research\n")
        md.append("| Candidate | Change | Δ log loss | 95% interval | Δ Brier | Decision |\n|---|---|---|---|---|---|")
        for c in w["candidates"]:
            dlt = c.get("delta") or {}
            md.append(f"| {c['candidate']} | `{c['change']['key']}` {c['change']['how']} | {dlt.get('logloss', '—')} | {c.get('ci95', '—')} | "
                      f"{dlt.get('brier', '—')} | {c['decision']}: {c.get('reason', '')} |")
    text = "\n".join(md) + "\n"
    os.makedirs(DOCS, exist_ok=True)
    with open(os.path.join(DOCS, "weekly_model_report.md"), "w") as f:
        f.write(text)
    print(os.path.join(DOCS, "weekly_model_report.md"))


def cmd_all(fetch=True):
    if fetch:
        ingest.fetch()
        ingest.build()
    if not os.path.exists(os.path.join(DOCS, "backtest.json")):
        cmd_backtest()
    cmd_refresh(fetch=False)
    cmd_score()
    s = cmd_research()
    if s and s.get("promoted"):
        cmd_refresh(fetch=False)
    cmd_report()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["prereg", "backtest", "refresh", "score", "research", "report", "all"])
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--only", default="")
    a = ap.parse_args(argv)
    {"prereg": cmd_prereg, "backtest": cmd_backtest, "score": cmd_score, "report": cmd_report}.get(a.cmd, lambda: None)()
    if a.cmd == "refresh":
        cmd_refresh(fetch=not a.no_fetch)
    elif a.cmd == "research":
        cmd_research([c for c in a.only.split(",") if c] or None)
    elif a.cmd == "all":
        cmd_all(fetch=not a.no_fetch)


if __name__ == "__main__":
    main()
