EdgeDesk — files to upload
==========================

1) capture-index.ts
   ->  supabase/functions/capture/index.ts
   Build: capture-v7-wallclock
   Single-file, self-contained, one remote import, no ../_shared.
   Deploy: supabase functions deploy capture --no-verify-jwt

2) app.html
   ->  app.html  (repo root)
   Active board now requires flagged_at IS NOT NULL + a usable
   flagged_best_dec. Historical / graded / replay / movement reads are
   deliberately NOT gated.

After deploying capture, call it once by hand:
   GET /functions/v1/capture?diag=1   with header  x-cron-secret: <CRON_SECRET>
Confirm the response "build" reads capture-v7-wallclock. If it still says v5,
the deploy did not land and the old version is still serving.
