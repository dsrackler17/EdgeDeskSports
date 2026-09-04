# `close` and `capture` as the two halves of every CLV

CLV is `entry_dec x closing_fair - 1`. The entry side comes from `capture`'s
pricer; the closing side comes from `close`'s. If the two do not compute a fair
price the same way, the difference lands in every CLV in the record and is
indistinguishable from market movement.

`learn` measured the symptom for months without being able to name the cause.
Its `fairDrift()` reading says realised CLV is flat across every edge band over
a constant offset, and that a constant offset is "the size of a de-vig or
book-set difference between capture and close rather than anything about the
edge model." `close`'s own header records the number: **-2.09%**.

Four defects were found. All four are fixed in `close-v7-parity`, and
`tools/capture/pricer_parity.test.js` (56 assertions, in CI) is what keeps them
fixed — it imports the real `close` module and the real `capture` module and
compares them, so a divergence is a red build rather than a slow drift in the
record.

---

## 1. `close` could not reach the reference book at all

| | fetch | Pinnacle reachable? |
|---|---|---|
| `capture` v9 | `bookmakers=` (10 keys incl. `pinnacle`), else `regions=us,eu` | yes |
| `close` v6 | `regions=`, hardcoded fallback `"us"`, no bookmaker support | **no** |

Pinnacle is an `eu` book, so `s.sharp` was null on every selection of every
event, and `close/index.ts:174` was

```ts
const cons = median(s.fairs), sharp = s.sharp ?? cons, edge = sharp * s.best.dec - 1;
```

character for character the line capture v9's header identifies as the **v8 root
cause**: the consensus of the same soft books the price was being measured
against, stored under the name `sharp_fair`. The entry edge was anchored on
Pinnacle and the close on the US soft-book median.

**Fixed.** `close` now reads the same `CAPTURE_BOOKMAKERS`,
`CAPTURE_REGIONS` (default `us,eu`) and `CAPTURE_REFERENCE_BOOKS` that capture
reads, so one configuration drives both halves. The substitution is gone: when
there is no reference the fair is a labelled `robust_consensus`, never a
consensus wearing the word sharp.

## 2. `devig` returned a non-distribution on an underround book

Identical wherever there was margin to remove — `2.5e-11`, bisection tolerance.
When the booksum is below 1 there is no root to solve for, and the old `bisect`
had no way to say so:

| booksum | capture v9 | close v6 | close v7 |
|---|---|---|---|
| 1.0477 | `[0.500000, 0.500000]` | `[0.500000, 0.500000]` | `[0.500000, 0.500000]` |
| **0.9524** | `[0.500000, 0.500000]` | **`[0.352168, 0.352168]`** | `[0.500000, 0.500000]` |

Summing to 0.704 is not a probability distribution, and it passed
`decideClose`'s `0 < fair < 1` gate, so it was stored as a real CLV.

**Fixed.** capture's `bisect` (which returns `null` when no root is bracketed)
and capture's `devig` are copied verbatim. Every output is asserted to sum to 1.

## 3. The consensus was a plain median over bookmaker rows

Several brands on one trading desk voted once per brand, and the book offering
the best price helped compute the number its own price was judged against.

**Fixed.** One quote per operator family (freshest wins, then best priced),
`trimmedMedian` rather than `median`, and the best-priced family removed from
its own fair value — the same three rules capture applies at entry.

## 4. The coherence guard was dead code

`decideClose` reads `o.pin_dec` and `o.pin_opp_dec`. `priceEvent` never set
them, so `incoherent_close_market` never once fired in the life of the function.

**Fixed.** The reference book's own two sides are carried through, so the
overround check finally has the data it always asked for.

---

## And one thing the tests found on the way

Nothing in this repository ever created `closing_dec`, `closing_book`,
`closing_has_sharp`, `closing_n_books`, `closing_source` or
`closing_at_observed` — columns `close` writes on **every** run. They exist in
the live database because they were added by hand in the dashboard. A fresh
database built from this checkout would have had a close job whose every UPDATE
failed. `close_v7_parity.sql` now creates them, idempotently, so it is a no-op
where they already exist.

---

## What happens to the history

Rows closed before v7 were measured against a different reference. They are
**labelled, not rewritten**: `close_v7_parity.sql` stamps every already-closed
row `closing_policy = 'pre-v7-legacy'` and gives it a
`closing_reference_type` of `tick`, `none` or `pre-v7-unknown`, and touches no
`clv`, `closing_dec` or `closing_sharp_fair`. Rows still open are left alone
entirely.

That is the same device `flagged_policy` provides on the flagging side, and it
exists for the same reason: pooling two definitions of a measurement and
reporting one number is how the -2.09% stayed invisible for as long as it did.
Any reader of the record can now segment on `closing_policy` and never average
across the boundary.

A backfill that recomputes pre-v7 closes from `book_quote_ticks` is possible and
is **not** done here. It would be a second measurement of the same rows under a
third definition, and it is a decision rather than a cleanup.
