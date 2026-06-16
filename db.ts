# EdgeDesk — personal multi-sport betting research tool

Live edge scanner + CLV ledger. Logs you in, pulls odds across books through a
Supabase Edge Function (your odds-API key stays server-side), de-vigs to a sharp
fair line, and flags where the best price beats it. Mobile-first.

```
 index.html (landing + login/signup)
      │  Supabase Auth
      ▼
 app.html (the tool)  ──►  Edge Function /odds  ──►  The Odds API
      │   (sends your user JWT)   (holds ODDS_API_KEY, logged-in users only)
      └──►  Supabase Postgres (CLV ledger, RLS = auth.uid())
```

## Files
- `web/index.html` — landing page with email/password + magic-link login/signup
- `web/app.html` — the mobile-first app (auth-gated): Live edges, CLV ledger, De-vig, Terms
- `web/config.js` — public-safe Supabase URL + anon key + function URL
- `supabase/functions/odds/index.ts` — the key-hiding odds proxy (auth-required)
- `supabase/migrations/0001_init.sql` — ledger + watchlist + disclaimer log, RLS by auth.uid()

## Setup (~15 min)

### 1. Supabase project
supabase.com → new project. Copy **Project URL** + **anon public key** (Settings → API).

### 2. Auth
Authentication → Providers → enable **Email**. For a personal tool you can turn
**OFF** "Confirm email" (Authentication → Providers → Email) so signup logs you
straight in. Magic link works either way.

### 3. Database
SQL Editor → run `supabase/migrations/0001_init.sql`.

### 4. Edge Function (your key hides here)
```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set ODDS_API_KEY=your_ROTATED_key
supabase secrets set ALLOWED_ORIGIN=https://your-app-domain     # optional; * if unset
supabase functions deploy odds          # JWT verification ON = only logged-in users
```
Function URL: `https://YOUR-PROJECT.supabase.co/functions/v1/odds`

### 5. Frontend
- Edit `web/config.js` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ODDS_FUNCTION_URL`
  (all public-safe). Set `SHARP_BOOK` (default "pinnacle") — the book your fair
  lines anchor to.
- Host the `web/` folder on Vercel / Netlify / Cloudflare Pages / GitHub Pages.
  `index.html` is the entry; it redirects to `app.html` once you're logged in.
- Set `ALLOWED_ORIGIN` to your hosted URL to lock the function to your domain.

## Odds API
Start with **The Odds API** (the-odds-api.com): cheap, all major sports,
ML/spreads/totals, props on higher tiers. The function is provider-agnostic —
to move to **OpticOdds** (real-time + deeper props) later, change only
`buildUrl()` in the Edge Function.

## How edges are found
Per game/market: de-vig each book (Shin), anchor the fair line to your sharp book,
then flag any outcome where the best price across books beats it.
`EV% = fair × best_decimal − 1`. A de-vig + line-shop scanner — honest and
sport-agnostic, no per-sport model required.

## Reality check (personal use)
- The edge is line-shopping soft prices vs the sharp consensus. It's real but thin,
  and the books easiest to beat limit winners fastest — bias toward reduced-juice
  books that tolerate sharp play.
- **Your CLV ledger is the verdict.** Don't trust the green EV numbers; trust whether
  you beat the closing line over 200+ logged bets. If CLV isn't positive over volume,
  the signals are noise, not edge.
- Gamble responsibly. 21+. 1-800-GAMBLER. This is not legal advice.

---

# Proof loop — capture, grade, learn (auto)

Four scheduled jobs turn the scanner into a self-grading track record. Every
selection it prices is captured, the closing line is snapshotted, the result is
graded after the game, and a rollup learns which slices actually beat the close —
which the scanner then uses to weight live signals.

```
 capture  every 30m   price the FULL board → upsert into signals
 close    every 10m   snapshot closing line + CLV for games about to start
 settle   hourly      pull final scores → grade win/loss/push, beat-close
 learn    hourly      roll up CLV/hit by book/sport/market/edge/time → model_weights
```

## Deploy the loop
```bash
# 1) extra schema
#    run supabase/migrations/0002_proofloop.sql in the SQL editor
# 2) secrets (key already set from before)
supabase secrets set CRON_SECRET=$(openssl rand -hex 24)
supabase secrets set SHARP_BOOK=pinnacle
supabase secrets set CAPTURE_REGIONS=us
supabase secrets set CAPTURE_MARKETS=h2h,spreads,totals
supabase secrets set CAPTURE_SPORTS=americanfootball_nfl,basketball_nba   # limit cost; blank = all active
# supabase secrets set CAPTURE_TICKS=true                                 # optional line-movement firehose
# 3) deploy the jobs (no JWT; protected by CRON_SECRET)
supabase functions deploy capture --no-verify-jwt
supabase functions deploy close   --no-verify-jwt
supabase functions deploy settle  --no-verify-jwt
supabase functions deploy learn   --no-verify-jwt
# 4) schedule them: edit PROJECT_REF + CRON_SECRET in 0003_cron.sql, then run it
```

The app's **Record** tab shows the captured/graded counts, hit rate, average CLV,
beat-close rate, the per-slice breakdown (book / sport / market / edge size / time
to kickoff) with the learned weight, and the calibration table. Live signals get a
`×weight` confidence chip and are ranked by edge × weight.

## What "learns from itself" actually means
This is a line-shop/de-vig scanner — the "prediction" is the sharp book's fair line,
so there is no neural net to train. What improves is **calibration**: the system
measures whether its own flagged edges really beat the close and win at the implied
rate, then up-weights the slices that do and mutes the ones that don't. That is the
honest, durable version of self-improvement — and it's exactly what tells you whether
the tool is real.

## API cost — read this, it's the real constraint
The Odds API bills ~1 credit per market per region per sport per odds call.
`capture` every 30 min over N sports × 3 markets × 1 region ≈ N×3 credits/call,
~48 calls/day → ~N×144 credits/day. Five sports ≈ 21.6k credits/month just for
capture, plus `close`/`settle`. Tune `CAPTURE_SPORTS`, `CAPTURE_MARKETS`, and the
cron cadence to your plan. `close` is the highest-value call (it's where CLV is
measured) — keep that frequent and trim `capture` first if you need to save credits.
When volume justifies it, OpticOdds' real-time feed makes "every moment" literal.
