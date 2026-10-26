# Market Foresight — go-live checklist

**Market Foresight stays in shadow mode.** Nothing in the repository, its
workflows or the terminal switches it live. Going live is one operator
statement, run by hand, after every box below is ticked. Until then, readers
see "In review", the public page says it is in shadow, and only operators read
the record (in `/foresight/` and inside the terminal at `app.html#foresight`).

The steps themselves are in [README.md § Deploy](README.md#deploy). This list
covers what has to be true before step 5 runs.

## 1. Deployed and computing (still in shadow)

- [ ] `supabase/market_foresight.sql` applied to production through **Deploy
      Market Foresight schema**. Every report row reads `ok`; `pending` is
      allowed only for Kalshi verification and Collective reachability.
- [ ] `supabase/research_os.sql` applied. It registers the
      `primary_nav_foresight` event, so taps on the terminal's seat are
      counted. Without it they are silently dropped, exactly as before.
- [ ] A dry run, then a real run, of **Market Foresight run**. The latest
      `mf_admin_runs(5)` row is `completed`, with no `error`.
- [ ] `select * from public.mf_status();` as anon answers
      `{ mode: 'shadow', … }`.

## 2. Reviewed in shadow, as an operator

- [ ] At least one NFL and one FBS game open at `/foresight/?game=…`, and the
      same games open at `app.html#foresight/game/<sport>:<event id>`. Both
      show the same timeline, findings and coverage gaps.
- [ ] The terminal's game page (`app.html#game/<nfl|cfb>/<id>`) previews the
      same counts as the record, under "Keep researching this game".
- [ ] A game that has not kicked off reads "Not in the record yet". It never
      reads zero, and never reads as a measurement.
- [ ] Every "preceded" claim on the reviewed games is checked against the raw
      timeline by hand: an observation after publication still showed the
      unmoved market.
- [ ] Overlapping venue moves read UNRESOLVED, and no page states a timing
      advantage, a lead over "the market", or a profit.
- [ ] The methodology version on the page equals `FROZEN.json`.

## 3. Access, checked against production

Use real accounts, not the operator's own.

- [ ] **Signed out:** the public page and the terminal read "In review" (in
      shadow) and get no measurement from any `mf_*` door.
- [ ] **Free account:** the terminal stops at the paywall, and the Foresight
      doors return no timeline.
- [ ] **Full Access subscriber, in shadow:** "In review", with no
      measurement and no timeline.
- [ ] **Operator, in shadow:** the full record.

## 4. Kalshi (optional for go-live)

- [ ] Either every linked series' rules text is verified
      (`mf_admin_pending_rules()`, then `mf_admin_verify_settlement(…)`), or
      the record states that Kalshi is shown and compared with nothing.
      Going live does not require Kalshi.

## 5. The decision

- [ ] The product owner has read this list, ticked above, and decided to go
      live. Record who and when in the reason text.
- [ ] Rollback is ready: `select public.mf_admin_set_mode('off', 'reason');`
      hides everything without deleting a row.

Only then, by hand, as an operator:

```sql
-- NOT run by any workflow, script or test. A human decision.
select public.mf_admin_set_mode('live', '<who> — <why> — <date>');
```

Then switch on the hourly job (`MARKET_FORESIGHT_WORKER=on`), add `/foresight/`
to `sitemap-pages.xml`, and set the page's robots meta to `index,follow`.

## 6. After going live

- [ ] Signed out and as a subscriber: the record shows its derived
      measurements, and the terminal's Overview card reads "Live" with the last
      run's time.
- [ ] The Full Access timeline is shown to subscribers only, and the
      terminal's record says which one the reader is seeing.
- [ ] No other feature changed: rankings, grades, the Collective's pages, the
      performance ledger and Signal Center read exactly as before
      (`tools/foresight/isolation.test.js` keeps holding this in CI).
