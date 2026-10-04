# Runbook — the research loop is blocked, slow or silent

**Symptom.** The panel's "What EdgeDesk checked this turn" shows BLOCKED
rows; the prose says a question could not be answered; the investigation
budget line shows the time budget spent; or the packet never carries a live
forecast or a live injury report.

1. **Which provider, which outcome?** `GET ?probe=1 → investigation` lists
   every provider with `configured` and `blocker`. `POST ?dry=1` returns
   `investigation.log` (question, provider, outcome, finding or blocker,
   source, observed time) and `investigation.budget`.
2. **BLOCKED naming an env var.** `EDGEDESK_SEARCH_API_KEY` (web search) or
   `CFBD_API_KEY` (CollegeFootballData) is unset. Set it in the function's
   secrets and redeploy; the provider runs on the next turn. Without it the
   answer still completes on the artifacts and says what was not checked.
3. **BLOCKED: no venue geography.** The live forecast needs the home team's
   venue from the identity profile; NFL stadiums are not in
   `football/venues` yet, so NFL forecasts are a declared gap.
4. **UNAVAILABLE with an HTTP status.** The public feed refused (rate limit,
   outage). The artifact copy is still used and labelled with its own time.
   Nothing is retried within the turn; the cache TTL decides when the next
   turn tries again.
5. **SKIPPED: time or request budget spent.** Raise
   `EDGEDESK_INVESTIGATE_MS` / `_REQUESTS` cautiously; the loop runs before
   the model call, so its budget is answer latency.
6. **Switching it off.** `EDGEDESK_INVESTIGATE=0` stops the loop;
   `EDGEDESK_ANALYST=0` removes the whole layer (the r13 answer). Both are
   reported by `?probe=1`.
7. **Never patch the prompt** to describe a check that did not run: the
   critic rejects a claimed search that is not in the log.
