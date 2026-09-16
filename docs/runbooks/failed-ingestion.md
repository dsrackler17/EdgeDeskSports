# Runbook — an ingestion failed, or a source went quiet

**Symptom.** Packets carry `missing` fields that used to be present; the
`?probe=1 → source_health` or the doctor reports an artifact 404; the panel's
Sources disclosure shows UNKNOWN badges where LIVE badges used to be.

1. **Which source?** `GET /functions/v1/edgedesk_ai?probe=1` prints the
   capability matrix and env presence. `POST ?dry=1` with the question prints
   `provenance.retrieval_log` (table, ms, rows, error) and `unavailable`.
2. **Artifact (slate, availability, rankings, matchup metrics, NFL slate)?**
   Check the GitHub Actions run that builds it (`football-weekly-build.yml`,
   `availability-sync.yml`, `starter-context.yml`, `injury-sync.yml`) and
   that `main` carries a fresh `generated_at`. `football/matchup/metrics.json`
   and `football/nfl/slate.json` can be rebuilt by hand with
   `npm run football:metrics` and `npm run nfl:slate` (`--offline` reads the
   cached feeds); `--check` on either compares without writing.
   GitHub Pages serves the file; a stale `generated_at` means the build did
   not run or did not commit. Re-run the workflow by hand.
3. **`signals` empty or old?** `capture` is scheduled by pg_cron
   (`supabase/capture_cron.sql`) with `capture.yml` as backup. Check the
   `capture` function logs and `capture_poke()`; the doctor's board-freshness
   check names the rung that is not being kept.
4. **`cfb` schema unreadable?** The schema must be exposed under Supabase →
   API settings; a 401/404 on `cfb.games` is reported as `RETRIEVAL_FAILED`,
   not as an empty card.
5. **Nothing to fix in code.** The desk degrades honestly: a missing input
   becomes a named unknown, the label falls (STALE MARKET / INSUFFICIENT
   DATA), and the critic rejects prose that fills the gap. Do not patch the
   prompt to paper over a feed.
