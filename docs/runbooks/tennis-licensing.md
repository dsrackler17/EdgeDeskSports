# Runbook — what tennis data EdgeDesk may actually sell

This exists because the answer is counter-intuitive and the cost of getting it
wrong is not a red build.

## The finding, in one line

**Every free tennis match archive reachable in September 2026 is
non-commercial — including the ones a web search describes as MIT-licensed.**

## The trap, specifically

Search for "tennis dataset commercial use" and the top results include
`Tennismylife/TML-Database`, summarised as MIT, ATP + WTA, 1968–2026, actively
updated. That summary is wrong. The repository's own README says:

> Redistribution, commercial use, or selling of the raw database without
> permission from TennisMyLife and/or the ATP may violate copyright or terms
> of use.

> All data usage is **non-commercial** unless explicitly permitted.

and, separately, that it is derived from Jeff Sackmann's `tennis_atp` "under
Creative Commons Non-Commercial Share Alike".

`nick-benelli/Tennis-Data-Pipeline` is the same shape and shows why the
mistake is easy: it really does carry an **MIT `LICENSE` file**. That file
covers the *code*. Four sections of its README down, the *data* is
"Creative Commons Attribution-NonCommercial-ShareAlike 4.0", attributed to
Sackmann.

**An MIT licence on a repository is not a licence on the data inside it, and a
mirror cannot grant rights the upstream withheld.** Share-alike carries
forward; relicensing NC-SA data as MIT downstream does not make it MIT, it
makes the mirror a licence breach you would be inheriting.

All three quotes above were read from the source files on 2026-09-21, not
from a search summary. Each is registered in `tennis.source_licenses` with
`commercial_use = false` and the quote in its `notes`, so the next person to
go looking finds the answer in the database instead of in a search engine.

Jeff Sackmann's own `tennis_atp` and `tennis_wta` repositories now return 404
— they are no longer public. The archive EdgeDesk holds
(`EdgeDesk_Tennis_Dataset.zip`) is in that format and under that licence:
**CC BY-NC-SA 4.0. Research and model development, not sale.**

## What this does NOT block

Holding the archive, importing it, training on it, and researching with it are
all permitted by CC BY-NC-SA. What is not permitted is **selling the output**.
So the archive import is not blocked on licensing — the paid surface is.

`tennis.enforce_commercial_clearance` is what holds that line. An opportunity
inherits the licence of the model that produced it, so a model trained on
`archive` cannot have its priced output stored under a commercially cleared
`source_key`. The refusal happens in the database, on INSERT and on both
UPDATE paths, whatever the pipeline believes. That is the protection: you
cannot accidentally sell this, because the row will not store.

## The routes that are actually sellable

Ranked by how close each is to a signature, not by how attractive it is.

1. **tennis-data.co.uk** — registered as `tennis_data_uk`. ATP + WTA results
   *with closing odds* back to 2000. Free for personal use; the publisher
   licenses commercial use separately, so this is the only free-to-inspect
   candidate with a real commercial path. Closing prices matter: CLV grading
   needs them and the Sackmann format does not carry them. **Ask them for
   commercial terms.** Cheapest credible route to a sellable product.

2. **Sportradar / SportsDataIO / Goalserve / api-tennis.com** — official or
   licensed feeds, priced per seat or per call, commercial redistribution
   terms written into the contract. This is what a paid tennis product is
   normally built on. Expect a real invoice.

3. **Permission from Sackmann directly.** CC BY-NC-SA reserves commercial
   rights to the licensor, so they are the licensor's to grant. The Match
   Charting README makes clear he takes the licence seriously; he is also a
   person who can be asked.

There is no fourth route. If a free archive appears that claims commercial
clearance, assume it is a mirror of one of the above until its provenance is
read at source — that is exactly the failure this document exists to prevent.

## When a source is cleared

Do not edit `commercial_use` by hand and move on. The constraint requires a
named clearer, and that is the audit trail:

```sql
update tennis.source_licenses
   set commercial_use = true,
       allowed_uses   = array['research','commercial','display'],
       cleared_by     = 'name of the person who signed it',
       cleared_at     = now(),
       notes          = notes || ' CLEARED <date>: <agreement reference>.'
 where source_key = 'tennis_data_uk';
```

From that moment the gate lets priced output from models trained on that
source be stored as sellable, and not one moment before.
