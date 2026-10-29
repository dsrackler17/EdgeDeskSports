# SP+ — an external estimate beside EdgeDesk's CFB number

SP+ is ESPN's opponent-adjusted efficiency rating, created by Bill Connelly.
EdgeDesk shows a line derived from it next to its own fair spread on every
college football card, and grades both against the close. It is a **second
opinion, never an input**. SP+ feeds no EdgeDesk projection, EV, ranking or
grade.

Why: on 2026-10-28 EdgeDesk had Middle Tennessee −4.5 against Kennesaw State.
SP+ had about Middle Tennessee −1, and the game closed Kennesaw State −1.5
(Kennesaw State won 44–28). A results-based number had missed a team that was
losing close games while playing efficiently.

## Provenance

| What | Tier | Meaning |
|---|---|---|
| SP+ rating | **T3 Research Model, external** | the output of a third party's model, not EdgeDesk's; EdgeDesk has not validated it |
| SP+ projected line | **T2 Computed** | a deterministic transform of the T3 rating (below) |

The tiers are the site's own (`RS_TIER`, `app.html`). "External" means it can
never appear as a validated EdgeDesk model.

## Terms and attribution

- **CollegeFootballData.com** (terms dated 2026-08-12, read as quoted in a
  public issue; the site was unreachable from the build environment):
  - commercial use is allowed on the free tier (§3);
  - "display reasonable portions of factual API Data as part of a larger
    product" is allowed (§4);
  - no standalone dataset, bulk download or "public database mirror" (§5);
  - the key stays server-side, never in a public repository or browser
    bundle (§2);
  - attribution is "appreciated but not required"; the recommended line is
    "Data provided by CollegeFootballData.com." (§6).
- **SP+ itself is ESPN's.** No licence for public commercial display was
  found, and none was obtained. The owner chose (2026-10-29) to show **the
  derived projected line only**, with attribution, and never a raw rating or
  rank on a page.
- Every surface carries: *Projection derived from SP+ (ESPN, Bill Connelly).
  Data provided by CollegeFootballData.com.*

What this means for storage: the repository is public and served by GitHub
Pages, so **no SP+ rating is ever committed**. Raw weekly ratings live only in
`public.cfb_sp_ratings`, which nobody but the service role can read.

## A · The weekly capture (`sync.js`, `cfbd.js`)

```
cfb-sp-plus.yml (Mon, retry Tue/Wed; or Run workflow)
  -> GET https://api.collegefootballdata.com/ratings/sp?year=<season>   (Bearer CFBD_API_KEY)
  -> parse: team + finite overall / offense / defense, or the row is rejected with its reason
  -> map: football/cfb_lab/identity.js (CFBD id when present, then name through
          the shared alias table); a prefix-only or ambiguous name is UNMAPPED
          and logged, never guessed
  -> public.cfb_sp_ratings     one row per team (append-only, service role only)
  -> public.cfb_sp_sync_runs   one row per attempt: OK / UNCHANGED / FAILED, with
                               every unmapped name and every rejected row
  -> football/sp_plus/lines.json   metadata and derived lines only
```

- **The week.** CollegeFootballData's `/ratings/sp` takes a year and a team,
  not a week. A capture belongs to the slate's current week
  (`football/fbs/slate.json` `current_week`), stamped with its capture time.
  There is no honest way to backfill past weeks.
- **UNCHANGED.** If the payload is identical to the previous week's capture
  (same sha256 of the values), SP+ has not been updated yet: nothing is stored
  or published for the new week, and the next scheduled run tries again.
- **Fails closed.** No key, an HTTP error, a payload that fails validation, no
  team mapped, no database credentials or an unapplied migration: the attempt
  is recorded in `lines.json` (`last_attempt`) and in `cfb_sp_sync_runs`, no
  capture is published, and the run fails.
- **Setup.**
  1. Apply `supabase/cfb_sp_plus.sql` (SQL editor or psql; idempotent).
  2. Add the repository secret `CFBD_API_KEY`; `SB_URL` and `SB_SERVICE_ROLE`
     already exist.
  3. Run *CFB SP+ weekly sync* once by hand.

```
npm run cfb:sp:sync          # node football/sp_plus/sync.js --write  (needs the three secrets)
npm run cfb:sp:test          # the mocked ingest suite and the Postgres contract
```
