# `collective_public` — four patches

Apply in the Supabase dashboard editor with find-and-replace. Each block is
unique in the file. Nothing here changes the first-submission rule.

Read **Patch 3** before applying it: it is the one that changes who can see
paid numbers, and it is a product decision, not a bug fix.

---

## Patch 1 — `/v1/games` games carry no `sport` and no `week`

`_shared/reads.ts` is supposed to hold `buildGames` **once** so the site and the
embed render identical data. The two bundles have drifted: the `collective_embed`
copy carries `sport` and `week` on every game and the `collective_public` copy
does not.

That is why `collective/index.html` has a defensive comment reading *"the games
feed does not always carry a week, and `Wundefined` is worse than no week at
all"* — it is working around this, on the site, against the copy that is missing
the fields. The model page's game log drops the week for every row it renders
from `/v1/games`.

**Find:**

```ts
        game_id: g.game_id, label: g.label, home: g.home, away: g.away,
        kickoff_at: g.kickoff_at, status: g.status,
```

**Replace with:**

```ts
        // sport and week ride along so a board carrying more than one sport
        // can say which is which, and so the model page's game log stops
        // rendering "Wundefined". The collective_embed copy of this builder
        // has carried them since the multi-sport fix; this one had not, and
        // two copies of a "shared" builder that disagree is the bug.
        game_id: g.game_id, sport: g.sport, week: g.week,
        label: g.label, home: g.home, away: g.away,
        kickoff_at: g.kickoff_at, status: g.status,
```

---

## Patch 2 — one row per model per game, and say how many submissions there were

This is the one that matters for the creators who reported the uploader as
broken.

`buildGames` maps **every** row `board_models` returns for a game. Whether a
model appears once or three times on the wall is therefore decided entirely by
that view, and the edge function has no opinion at all. Two consequences:

* if the view ever stops collapsing, the wall renders the same model two or
  three times on one game with no indication which is graded;
* `movement_n` — which the site now prints as a `+n` beside a pick, to tell a
  creator their re-upload **was** received — is passed through only if the view
  happens to expose it. If it does not, that marker silently never renders and
  the creators are back where they started.

This makes the function state the rule itself: **the graded row is the earliest
pre-kickoff live submission**, one row per model per game, and the number of
submissions is counted here rather than hoped for.

It also filters `superseded_at`, which does nothing until
`supabase/migrations/01_supersede.sql` is applied and the column is exposed —
`undefined` is falsy, so every row is kept until it exists. Deploy order stays
free.

**Find** (immediately above `async function buildGames`):

```ts
// The paid gate lives here, in the response body: a locked row carries no
```

**Insert this block before that comment:**

```ts
/* ONE ROW PER MODEL PER GAME, and how many submissions are behind it.
   board_models is read ordered by received_at.asc, so the first row seen for
   a model is its earliest — which is the row the Collective grades. A late
   row does not hold that slot, so a non-late row always wins it.

   movement_n is counted HERE when this collapse actually sees more than one
   row, and otherwise passed through from the view. That order matters: if the
   view already collapses and does not expose the column, counting alone would
   report 1 for every row and quietly claim no revision had ever arrived --
   which is the exact false statement the site's +n marker exists to stop.

   superseded_at is filtered for the day 01_supersede.sql is applied. Until
   the column exists it is undefined, so nothing is filtered and this is a
   no-op; the readers can be deployed before or after the migration. */
function collapseModels(rows: BoardModelRow[]): (BoardModelRow & { movement_n: number })[] {
  const by = new Map<string, BoardModelRow[]>();
  for (const m of rows) {
    if ((m as { superseded_at?: string | null }).superseded_at) continue;
    const k = `${m.creator_slug}/${m.model_slug}`;
    const list = by.get(k);
    if (list) list.push(m); else by.set(k, [m]);
  }
  const out: (BoardModelRow & { movement_n: number })[] = [];
  for (const list of by.values()) {
    const graded = list.find((m) => !m.is_late) ?? list[0];
    const seen = list.length;
    const fromView = Number((graded as { movement_n?: unknown }).movement_n);
    out.push({
      ...graded,
      movement_n: seen > 1 ? seen : (Number.isFinite(fromView) && fromView > 0 ? fromView : 1),
    });
  }
  return out;
}

```

**Then find:**

```ts
        models: models.filter((m) => m.game_id === g.game_id).map((m) =>
          unlocked
            ? { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: false,
                late: m.is_late, pick_side: m.pick_side, projected_spread: m.projected_spread,
                projected_total: m.projected_total, home_win_probability: m.home_win_prob,
                line_at_submission: m.line_at_submission, cover_probability: m.cover_prob,
                received_at: m.received_at,
                grade: m.pick_result !== null || m.margin_error !== null || m.brier !== null
                  ? { pick_result: m.pick_result, margin_error: m.margin_error, brier: m.brier }
                  : null }
            : { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: true }),
```

**Replace with:**

```ts
        // movement_n is on BOTH branches on purpose. It is a count of
        // submissions, not a projection, so it is not a paid number -- and a
        // locked reader seeing that a model revised a game learns nothing
        // they could bet on. Withholding it would put the creator's own
        // "did my re-upload land?" answer behind the paywall.
        models: collapseModels(models.filter((m) => m.game_id === g.game_id)).map((m) =>
          unlocked
            ? { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: false,
                late: m.is_late, pick_side: m.pick_side, projected_spread: m.projected_spread,
                projected_total: m.projected_total, home_win_probability: m.home_win_prob,
                line_at_submission: m.line_at_submission, cover_probability: m.cover_prob,
                received_at: m.received_at, movement_n: m.movement_n,
                grade: m.pick_result !== null || m.margin_error !== null || m.brier !== null
                  ? { pick_result: m.pick_result, margin_error: m.margin_error, brier: m.brier }
                  : null }
            : { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: true,
                movement_n: m.movement_n }),
```

---

## Patch 3 — the free-tier hole. **Read this one before applying it.**

`collective_embed` lists this as its own defect 3 and says *"That branch is
gone."* `collective_public` still has it:

```ts
if (billing !== true) return true;
```

Any signed-in account — free, brand new, anyone who can complete an email
sign-in — is entitled to every pre-kickoff number from `/v1/games` and
`/v1/consensus` while billing is off.

So the two functions now disagree about the same reader: the embed on a
member's site shows them a locked board, and the Collective's own site shows
them the whole thing. One of the two is wrong, and the embed's own header says
which.

**This is a product decision, not a bug fix.** Applying it means non-creator,
non-subscriber accounts stop seeing pre-kickoff numbers on the site today. If
you are deliberately running the board open until billing is live, skip this
patch and instead make the embed match the site — but do not leave them
disagreeing.

**Find:**

```ts
async function isEntitled(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  // While billing is off, any signed-in account is entitled (contract 5.2:
  // the record is being built in the open; anonymous callers stay locked).
  const billing = await rpc<unknown>("get_config", { p_key: "billing.enabled" });
  if (billing !== true) return true;
  const [subs, creators] = await Promise.all([
    viewCount("subscribers", `user_id=eq.${userId}&status=in.(active,past_due)`),
    viewCount("creators", `user_id=eq.${userId}&status=eq.active`),
  ]);
  return subs > 0 || creators > 0;
}
```

**Replace with:**

```ts
/* PAID ACCESS, not a signed-in account -- the same rule collective_embed
   already enforces, so the embed on a member's site and the Collective's own
   site stop disagreeing about the same reader.

   This used to short-circuit on `billing.enabled !== true` and return true for
   anybody holding a session, which is free-tier access to paid numbers. The
   ways in are an EdgeDesk subscription, a Collective subscription, or being a
   creator (they built the board, so they see it). */
async function edgedeskPaid(userId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/subscriptions?select=user_id&user_id=eq.${userId}` +
        `&status=in.(active,trialing,past_due)`,
      { method: "HEAD",
        headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`,
                   "Prefer": "count=exact" } },
    );
    if (!res.ok) {
      console.error("collective_public: edgedesk paid check failed:", res.status);
      return false;
    }
    const total = Number((res.headers.get("content-range") ?? "").split("/")[1]);
    return Number.isFinite(total) && total > 0;
  } catch (e) {
    /* Best effort ON PURPOSE: this is the one table read here that lives
       outside the collective schema, so a rename there must cost this check
       and nothing else -- never the whole board. */
    console.error("collective_public: edgedesk paid check threw:", e);
    return false;
  }
}

async function isEntitled(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [subs, creators, edgedesk] = await Promise.all([
    viewCount("subscribers", `user_id=eq.${userId}&status=in.(active,trialing,past_due)`),
    viewCount("creators", `user_id=eq.${userId}&status=eq.active`),
    edgedeskPaid(userId),
  ]);
  return creators > 0 || subs > 0 || edgedesk;
}
```

---

## Patch 4 — `?season=` empties the whole board

`searchParams.get("season")` returns `""`, not `null`, for `?season=`. `??`
only falls back on null/undefined, `Number("")` is `0`, and `Number.isFinite(0)`
is true — so the season becomes `0`, the `game_detail` filter matches nothing,
and the response is a valid, empty board with no error anywhere.

`collective/index.html` builds exactly that URL:
`'&season='+encodeURIComponent(sport.season||'')`. It is survivable only because
`buildMeta` always fills a season in; anything that does not is one keystroke
from an empty wall with no explanation.

Applies to **both** `/v1/games` and `/v1/consensus` — the same two lines appear
in each; patch both.

**Find (twice):**

```ts
      const season = Number(u.searchParams.get("season") ?? meta.sports.find((s) => s.code === sport)?.season);
      if (!Number.isFinite(season)) return err("invalid_payload", "season must be a number", 422);
```

**Replace both with:**

```ts
      /* "" is not absent. ?season= (which the site sends whenever its own
         season is falsy) survives ?? , Number("") is 0, and 0 is finite -- so
         the board came back empty and valid, with nothing anywhere saying
         why. Blank is treated as absent; a non-numeric season is still a 422. */
      const rawSeason = (u.searchParams.get("season") ?? "").trim();
      const season = rawSeason === ""
        ? Number(meta.sports.find((s) => s.code === sport)?.season)
        : Number(rawSeason);
      if (!Number.isFinite(season) || season <= 0) {
        return err("invalid_payload", "season must be a number", 422);
      }
```

---

## What these do not fix

Whether the wall shows a re-upload at all is decided by the **`board_models`
view**, which is SQL and is not in anything supplied. Patch 2 makes the function
state the rule and count the submissions, so the site's `+n` marker works
either way — but if that view is what is dropping a creator's second submission
entirely, the fix is in the view.

Two artifacts settle it, and nothing else is needed:

1. `select pg_get_viewdef('collective.board_models'::regclass, true);`
2. the `collective_ingest` bundle — it holds `/v1/projections/retract` and is
   where `ingest_submission` is called, so it is where `movement` is decided
   and where the supersede call has to go.
