# Runbook — stale markets

**Symptom.** Labels read STALE MARKET; `market.primary.freshness` is STALE or
UNKNOWN; the panel shows a stale badge beside a price.

The desk is behaving correctly: a stale price is research, never an action,
and no wording can promote it. What to check is why the capture is old.

1. `?probe=1` → nothing about freshness is there by design (it makes no
   network call). Run `node tools/intelligence/deploy_doctor.js` from a
   machine that can reach the project: it reads the newest capture against
   the reader's rung for the nearest kickoff.
2. The kickoff ladder decides the limit (5 min inside 30 min of kickoff, 15
   inside 2 h, 45 inside 6 h, 90 inside a day, 180 inside three days, 360
   beyond). A quote can be "only" 50 minutes old and STALE an hour before
   kickoff. That is intended.
3. If `capture` is running and the book simply pulled the number, the packet
   says so: `market.state` LINE_ONLY or NO_MARKET, `unknowns` names the
   absence. No action.
4. If `capture` is not running, see `failed-ingestion.md` step 3.
5. Never widen the TTL in `EDINTEL.CONFIG.quote_ttl_min` to make a board look
   live. Change it only with `capture`'s own write-side limits, together.
