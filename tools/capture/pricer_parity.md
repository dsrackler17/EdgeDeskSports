# Where `close` and `capture` disagree about what a fair price is

CLV is `entry_decimal x closing_fair - 1`. The entry side comes from
`capture`'s pricer; the closing side comes from `close`'s. If the two pricers
do not compute a fair price the same way, the difference lands in every CLV in
the record and is indistinguishable from market movement.

`learn` already measured the symptom without being able to name the cause. Its
`fairDrift()` reading says the realised CLV is flat across every edge band over
a constant offset, and that a constant offset is "the size of a de-vig or
book-set difference between capture and close rather than anything about the
edge model." The header of `close` records the number: **-2.09%**.

These are the differences, measured rather than asserted. Reproduce with
`node tools/capture/pricer_parity.test.js`.

---

## 1. The reference book. Structural, and the largest of the three.

| | fetch | Pinnacle reachable? |
|---|---|---|
| `capture` v9 | `bookmakers=` (10 keys incl. `pinnacle`), else `regions=us,eu` | yes, either way |
| `close` v6 | `regions=` with a hardcoded fallback of `us` | **no** |

`close` has no `CAPTURE_BOOKMAKERS` support at all — its `fetchOdds` only ever
builds `&regions=`. Pinnacle is an `eu` book, so:

- With `CAPTURE_REGIONS` unset, capture reads `us,eu` and close reads `us`.
- With `CAPTURE_BOOKMAKERS` set, capture uses the bookmaker list and close
  still reads `regions=us`.

Either configuration leaves `s.sharp` null on every selection at close, and
`close/index.ts:174` is

```ts
const cons = median(s.fairs), sharp = s.sharp ?? cons, edge = sharp * s.best.dec - 1;
```

which is, character for character, the line capture v9's header identifies as
the v8 root cause: `sharp_fair` silently holding the consensus of the same soft
books the edge was measured against. capture v9 fixed it. `close` never got the
fix, so **the entry edge is anchored on Pinnacle and the close is anchored on
the US soft-book median.** Those are different quantities, and the gap between
them is a constant offset applied to every graded row.

## 2. `devig` disagrees on an underround book.

Identical on every overrounded market — max deviation `2.5e-11`, which is
bisection tolerance, not drift. But when a book's implied probabilities sum
below 1 there is no margin to remove and no root to solve for:

| booksum | capture v9 | close v6 |
|---|---|---|
| 1.0477 | `[0.500000, 0.500000]` | `[0.500000, 0.500000]` |
| **0.9524** | `[0.500000, 0.500000]` | **`[0.352168, 0.352168]`** |

capture normalises proportionally, which sums to 1. close returns values summing
to 0.704 — not a probability distribution. It still passes `decideClose`'s
`closeFair > 0 && closeFair < 1` gate, so it is stored as a real CLV. On a 1.95
entry that is a recorded CLV of `-31.4%` where the honest answer is `-2.5%`.

## 3. The consensus is built over different populations.

`capture` medians over independent book **families** (two brands on one trading
desk are one opinion) with `trimmedMedian`, and keeps the execution book out of
its own reference. `close` medians over every bookmaker row the feed returns,
including the book offering the best price. On tight markets the two agree; the
gap opens exactly where an edge comes from, which is where it matters.

---

## What this does NOT establish

That fixing any of this makes the record better. It establishes that the record
currently measures entry and close on different bases, so the -2.09% offset is
at least partly an artifact of the pipeline rather than a fact about the market.
How much of it is artifact is not knowable until the two pricers agree.

Changing `close` re-defines CLV for every future row, and the existing rows were
measured the old way. Any fix has to decide, deliberately, what happens to the
history — the honest options being a `clv_basis`-style label so the two
populations are never averaged, or a backfill that recomputes from
`book_quote_ticks`. That is a decision, not a cleanup.
