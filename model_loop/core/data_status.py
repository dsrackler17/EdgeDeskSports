"""The degraded-data flag a loop stamps on its cards at every refresh.

A card is only as good as the inputs it was priced from. When an input the
model needs is missing or contradicted, the card says so instead of looking
as confident as one built on clean data:

  per game   starter unresolved (the feeds disagree on the quarterback)
             no reference line (nothing to measure the disagreement against)
             components that do not sum to the fair line
  the slate  games already played whose results are not in the data yet: the
             ratings behind every card are behind by those games

status is OK or DEGRADED; reasons say exactly what is missing. Nothing here
changes a number: it is a label on the number.
"""
from datetime import datetime, timezone


def game_status(g):
    reasons = []
    for side, s in (g.get("starters") or {}).items():
        basis = str((s or {}).get("basis") or "")
        if basis.upper().startswith("UNRESOLVED"):
            reasons.append(f"{side} starter unresolved: {basis.split(':', 1)[-1].strip()}")
        elif not (s or {}).get("id"):
            reasons.append(f"{side} starter unknown")
    ref = (g.get("market_reference") or {}).get("home_line")
    if ref is None:
        reasons.append("no reference line to measure the model against")
    un = (g.get("reconciliation") or {}).get("unattributed")
    if un is not None and abs(un) > 1e-6:
        reasons.append(f"components do not sum to the fair line ({un:+.4f})")
    return {"status": "DEGRADED" if reasons else "OK", "reasons": reasons}


def stamp(out, missing_results, checked_at=None):
    """Stamp every game and the slate. missing_results: game ids already
    played (kickoff more than 12 hours ago) with no result in the data."""
    n_bad = 0
    for g in out.get("games") or []:
        g["data_status"] = game_status(g)
        n_bad += g["data_status"]["status"] != "OK"
    reasons = []
    if missing_results:
        reasons.append(f"{len(missing_results)} game(s) already played have no result in the data yet, so the ratings "
                       f"are behind by those games: " + ", ".join(sorted(missing_results)[:8])
                       + (" …" if len(missing_results) > 8 else ""))
    recon = [g["game_id"] for g in out.get("games") or [] if any("do not sum" in r for r in g["data_status"]["reasons"])]
    if recon:
        reasons.append(f"{len(recon)} card(s) do not reconcile")
    out["data_status"] = {"status": "DEGRADED" if reasons else "OK", "reasons": reasons,
                          "games_flagged": n_bad, "missing_results": sorted(missing_results),
                          "checked_at": checked_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    return out["data_status"]
