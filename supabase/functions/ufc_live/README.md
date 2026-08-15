# ufc_live — deployment and diagnosis

Polls the ESPN MMA scoreboard into `ufc.live_events` / `ufc.live_fights`.

## Deploy

```
supabase functions deploy ufc_live      # Verify JWT OFF
supabase secrets set CRON_SECRET=<a long random string>
```

Schedule it (every ~1 min while a card is on, every ~15 min otherwise) and send
the secret as a header:

```
curl -X POST https://<project>.supabase.co/functions/v1/ufc_live \
     -H "x-cron-secret: <the same value>"
```

## Read the response — it is the diagnosis

```json
{ "ok": true, "event": "401700123", "status": "in",
  "fights": 12, "fights_with_stats": 12,
  "window_events": 4, "window_upserted": 4, "stale_events_closed": 1 }
```

- `fights_with_stats: 0` while `status` is `in` → ESPN is not publishing counts
  for this card yet, or the stat names moved. The app shows blanks and says
  "not recorded", which is the honest state — it never fills them with zeros.
- `stale_events_closed > 0` → rows a previous run left open were closed. Seeing
  this once after deploying is expected; seeing it every run is not.
- `401` → the `x-cron-secret` header is missing or does not match.
- `500` with "CRON_SECRET is not set" → the secret was never set, so **every**
  invocation was failing. This is the most likely reason a poller silently stops.

## What was wrong before

1. **`"final"` contains `"in"`.** The old status test `t.includes("in")` matched
   `final` and `STATUS_FINAL`, so a *finished* event was written as `in` — and
   nothing ever moved it off. This is how one card stayed "live" for a month.
2. **Only the selected event was written.** Every other row kept whatever status
   it last had, forever. The function now reconciles every event in the window
   and closes anything that started more than 12 hours ago and is still open.
3. **`Number("12/34")` is `NaN`.** ESPN reports landed/attempted as `"12/34"`, so
   every strike and takedown count was discarded and stored as null — which is
   why a finished fight showed a grid of dashes. Values are parsed leading-
   numerically now, and `attempted` / `accuracy` / `%` entries are skipped so an
   attempt count is never stored as if it were landed.
4. **`fight_id` came from name slugs.** Two fights with missing names on one card
   produced the same id and overwrote each other. ESPN's competition id is used
   when present, with an index-qualified fallback.
5. **The scoreboard window started today**, so a card that began late UTC
   yesterday could be missed. It now starts two days back.

## One-time cleanup

The status bug may have left rows mislabelled. After the first successful run,
`stale_events_closed` handles old events. To check for any remaining:

```sql
select event_id, name, status, start_time, updated_at
  from ufc.live_events
 where status <> 'post' and start_time < now() - interval '12 hours'
 order by start_time desc;
```

## Live odds — sourced from `capture`, not from The Odds API

Fight prices come from `public.signals`, which `capture` already fills. Nothing
here calls The Odds API, so there is **one source of truth for every price in
the app** and no extra quota is spent.

That also means the fight card inherits capture's discipline for free: Shin
de-vig, one quote per book (so a duplicated line cannot inflate the book count),
consensus fair, and the `flaggable()` bounds that reject stale or mis-keyed
quotes. `red_odds` / `blue_odds` are capture's `best_dec` — the best available
book price, already past those checks.

**capture must be pricing MMA.** Add `mma_mixed_martial_arts` to `CAPTURE_SPORTS`
(or to `CAPTURE_AUTO_PREFIXES`). If it is not, odds stay null and the response
says exactly that in `odds_note` rather than failing quietly:

```
"odds_note": "capture has no mma_mixed_martial_arts h2h rows in this window.
              Add mma_mixed_martial_arts to CAPTURE_SPORTS ..."
```

Override the sport key with `UFC_SIGNALS_SPORT` if it ever rotates.

**Matching refuses to guess.** A fight is priced only when both fighters match a
priced bout — exact normalised names first, then both surnames together — and
two corners sharing a surname are rejected as too weak. Unmatched fights keep
null odds and are counted. A wrong price on a fight is worse than no price.

Watch in the response:

| field | meaning |
|---|---|
| `odds_signal_rows` | MMA h2h rows capture had in the window. `0` = capture is not covering MMA |
| `odds_age_minutes` | how long since capture last refreshed those prices |
| `odds_matched` / `odds_unmatched` | fights priced vs. left null |
| `odds_matched_by_surname` | rising = ESPN and the book spell names differently |
| `odds_books_seen` | capture's `n_books` behind the best price |

`POST {"odds": false}` skips the lookup for a run.

## Card reconciliation

After upserting, the poller deletes rows for the event that were not in that
run's payload. This is what stops a card rendering every fight twice after a
`fight_id` scheme change or a late replacement bout. It only runs when the poll
actually returned fights, so a failed fetch cannot wipe a card. Rows that
accumulated before this shipped are cleared once by
`migrations/021_ufc_live_dedupe.sql`.
