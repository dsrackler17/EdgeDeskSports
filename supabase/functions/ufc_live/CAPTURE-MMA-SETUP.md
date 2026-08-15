# Adding UFC/MMA to `capture`

The fight card reads odds from `public.signals`, which `capture` fills. If
capture is not pricing MMA, fights render with no odds and `ufc_live` reports
`odds_signal_rows: 0` with an `odds_note` saying so. This is the fix.

## 1. Confirm the sport key (free — spends no odds quota)

```bash
curl -s "https://api.the-odds-api.com/v4/sports/?apiKey=$ODDS_API_KEY" \
  | python3 -c "import sys,json;[print(f\"{s['key']:<34} active={s['active']}  {s['title']}\") \
     for s in json.load(sys.stdin) if 'mma' in s['key'].lower()]"
```

Expect `mma_mixed_martial_arts`. If the key has rotated, use whatever this
prints and set `UFC_SIGNALS_SPORT` on `ufc_live` to match, or the two sides will
disagree about what to look for.

## 2. Read the current list first — this is where it goes wrong

`supabase secrets set` **replaces** the value. Setting `CAPTURE_SPORTS` to just
the new key silently drops every sport you are capturing today, and capture will
report a perfectly healthy run over a much smaller board.

```bash
curl -s -X POST '<project>/functions/v1/capture?diag=1' -H 'x-cron-secret: <SECRET>' \
  | python3 -c "import sys,json;print(','.join(json.load(sys.stdin)['stable_sports']))"
```

If this prints an empty line, `CAPTURE_SPORTS` is unset — `resolveSports()`
already returns every active sport, MMA included, and there is nothing to add.
An empty board then has a different cause.

## 3. Append and set

```bash
supabase secrets set CAPTURE_SPORTS="<the list from step 2>,mma_mixed_martial_arts"
```

No redeploy: `CAPTURE_SPORTS` is read per invocation.

### Alternative: let it manage itself

`CAPTURE_AUTO_PREFIXES` adds any *active* key matching a prefix, so MMA is only
requested when there is a card on the board:

```bash
supabase secrets set CAPTURE_AUTO_PREFIXES="tennis_,mma_"
```

**Include `tennis_`.** The default is `"tennis_"`, and setting this variable
replaces it — omit it and tennis silently stops being auto-added.
(`americanfootball_nfl` is concatenated in code, so it survives either way.)

## 4. Verify in order — each step isolates one link

| check | where | healthy |
|---|---|---|
| capture sees the sport | `?diag=1` → `sports_list` | contains `mma_mixed_martial_arts` |
| the feed has events | `?diag=1` → `per_sport_events` | `> 0` for that key |
| rows reach the table | SQL below, after one real run | non-zero, recent `last_seen_at` |
| the card picks them up | `ufc_live` response | `odds_signal_rows > 0`, `odds_matched > 0`, no `odds_note` |

```sql
select count(*) as rows, max(last_seen_at) as newest
  from signals
 where sport_key = 'mma_mixed_martial_arts' and market = 'h2h';
```

## Cost, worth knowing before you turn it on

The Odds API bills **one credit per market per region per request**.
`CAPTURE_MARKETS` defaults to `h2h,spreads,totals`, so every MMA call costs 3
credits even though MMA is essentially an h2h market — books rarely post spreads
or totals on a fight. At a 5-minute cron that is ~860 credits/day for MMA alone,
most of it spent on markets that come back empty.

`CAPTURE_MARKETS` is global, so trimming it would affect every sport. If the
quota matters, the smallest change that fixes only MMA is a per-sport override
in `capture`:

```ts
/* Per-sport market overrides. MMA is an h2h market; requesting spreads and
   totals for it spends two extra credits per call for markets books do not
   post. Everything not listed keeps the global CAPTURE_MARKETS. */
const MARKETS_BY_SPORT: Record<string, string> = JSON.parse(
  Deno.env.get("CAPTURE_MARKETS_BY_SPORT") ?? '{"mma_mixed_martial_arts":"h2h"}',
);
// in the sport loop, replace MARKETS with:
//   const marketsFor = MARKETS_BY_SPORT[sport] ?? MARKETS;
//   ... fetchOdds(sport, REGIONS, marketsFor)
```

That is a code change to a critical path, so it is written here rather than
applied. The env-only route in step 3 is enough to get MMA flowing.
