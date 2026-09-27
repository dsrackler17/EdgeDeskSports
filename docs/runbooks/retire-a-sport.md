# Retiring a sport (Tennis, 2026-09-27)

Tennis is no longer an EdgeDesk product. It is **retired, not deleted**: every
tennis table, historical odds row, grade, model output, migration and research
record stays exactly where it is. What changed is what the product offers and
what it spends money on.

## The one list

`lib/edgedesk_sports.js` (`EDSPORTS`) says which sports are retired, what the
Research shell covers today, and the sentence the desk uses to decline a
retired sport. `node tools/presentation/inline.js` copies it byte for byte into
every host:

| Host | What it does with the list |
|---|---|
| `app.html` | Old research routes (`#research/tennis/…`, `#research/wta`) land on Research → Football; live pools (board, Sport filter, desk, Top 5, brief, rooms, movers) drop retired rows; the Record tab and the Lab's record list exclude them by default; the chat panel answers a retired-sport question without calling the function |
| `record.html` | The public record excludes retired rows by default; `?archive=1` shows the record exactly as stored |
| `supabase/functions/edgedesk_ai/index.ts` | The support boundary: a retired-sport research or betting question gets one sentence, with no research packet and no model call; the system prompt carries the same rule for a question that only names players |
| `supabase/functions/capture/index.ts` | A retired sport key is never requested from the odds provider, whatever `CAPTURE_SPORTS`, `CAPTURE_AUTO_PREFIXES` or `/sports` discovery says |
| `supabase/functions/close/index.ts` | A retired sport's live close is never requested; its open signals close from the last observed tick |

`tools/app/sports_config.test.js` fails if a host drifts from the list or stops
honouring it, if a Research tab or panel exists for a retired module, if the
desk's board (`_board.js` `SUPPORTED`) lists a retired sport, or if a retired
sport's workflow runs on a schedule.

To retire another sport: add it to `RETIRED` in `lib/edgedesk_sports.js`, run
`node tools/presentation/inline.js`, remove its Research tab and panel and its
board entry, remove its workflows' `schedule:` triggers, then deploy (below).
The test names anything you missed.

## Deploy steps (manual, deliberately)

`app.html` and `record.html` ship when merged (GitHub Pages). The Supabase
functions do **not**:

1. **Run the `Deploy intelligence` workflow** (Actions → Deploy intelligence →
   Run workflow) with **`deploy_function` = true** and **`deploy_capture` = true**.
   - `edgedesk_ai` → build `edgedesk_ai-2026-09-27-r20-support-boundary`. Until
     this runs, the deployed desk (`edgedesk_ai-2026-09-25-r17-mine` as of
     2026-09-27) still lists WTA tennis in card-wide best-bets answers and still
     researches tennis questions.
   - `capture` → build `capture-v9-qualified-r3`. Until this runs, the deployed
     capture keeps requesting tennis odds if its `CAPTURE_SPORTS` is empty or
     names a tennis key, or if `CAPTURE_AUTO_PREFIXES` is unset or includes
     `tennis_`.
2. **Verify.** The `Intelligence doctor` workflow (it also runs every six
   hours) must report `CURRENT` for both "deployed build matches this checkout"
   and "deployed capture matches this checkout". The next capture run's summary
   lists any tennis key it dropped under `retired_sports_skipped`.
3. **Optional: tidy the capture secrets.** With `capture-v9-qualified-r3`
   deployed this is not needed, because retired keys are dropped whatever the
   secrets say. If `CAPTURE_AUTO_PREFIXES` is set in the function's secrets and
   contains `tennis_`, you can remove it for clarity:
   before `tennis_,americanfootball_nfl,americanfootball_ncaaf`, after
   `americanfootball_nfl,americanfootball_ncaaf`.
4. **Optional: `close`.** `close` has no workflow deploy path, and its checked-in
   copy was transcribed from the dashboard. Diff it against the deployed
   function before you deploy it (`supabase functions deploy close --no-verify-jwt`;
   see `supabase/README.md`). Without this step close still stops requesting
   tennis on its own once the tennis signals captured before retirement have
   closed, because capture no longer creates new ones.
5. **Optional: close out the tennis record.** The tennis workflows no longer
   run on a schedule. To settle predictions that were published before
   retirement, run `tennis-record` by hand once with `job = settle` and
   `commit` checked after those matches finish.

## The record

The default record (the Record tab, the Lab's list, `record.html`) is the
current product. It excludes retired sports from row sets, from counts and
pool sizes (via the PostgREST rule `or=(sport_key.is.null,sport_key.not.like.tennis_*)`),
from aggregates (CLV, hit rate, calibration, splits), and from the sport filter.
Rows stored without a `sport_key` are judged by their title in the browser.
The archive view shows the record exactly as stored: tick **Include retired
sports (archive)** in the Record tab's filter bar, or open `record.html?archive=1`.

Some Record panels are aggregated server-side across every sport, and the
browser cannot separate a retired sport out of them. In `where_edge`, the
market, favourite/underdog, signal-type and bookmaker boards stay pooled (its
sport board does drop retired sports). The same is true of the `calibration`
table, `book_bias`, and the capture-pipeline pool counts for rows stored without
a `sport_key`. Taking retired sports out of those needs a change to the views
or to the `learn` job, which this deprecation deliberately did not make.
