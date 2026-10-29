#!/usr/bin/env node
/* ===========================================================================
   THE FAIRLINE PAGE, IN A REAL BROWSER, AGAINST THE REAL STACK.

   fairline/index.html is served as shipped. Every call it makes to Supabase
   is answered by the PostgREST / Auth stand-in the billing suites use, over a
   throwaway PostgreSQL carrying the SHIPPED SQL (fairline.sql and everything
   it builds on): the page and the SQL that decides are the ones that ship.

     1  a signed-out visitor sees the free sign-in, not an error
     2  a free reader: The Board's top three rows and a blurred offer, with the
        filters locked; The Leaks names the biggest leak's slice and shows no
        real number; The Tape is visibly Coming Soon
     3  a paid reader: every row, a stale row greyed and saying "Stale", DK
        Predictions "Coming Soon" on every row, the market filter; The Leaks
        leads with the biggest real leak in one plain sentence, labels are
        chips with words, a small sample says so
     4  the upgrade: the renewal terms ($19.99 per month, renews automatically,
        cancel anytime in Settings) must be ticked; the server checkout is
        Fairline's; the consent is recorded with those exact words BEFORE the
        browser goes to Stripe
     5  a Bet Checker reader is not paid for Fairline: the teaser, and a switch
        in the billing portal instead of a second checkout
     6  at 390 px nothing scrolls sideways; no script error anywhere

   Needs Playwright + Chromium and PostgreSQL (skips cleanly without;
   FAIRLINE_UI_REQUIRED=1 makes a missing one a failure, as CI sets it).
   FAIRLINE_SHOTS=<dir> keeps a picture of each state.
   Run: node tools/fairline/page.e2e.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(ROOT, 'tools', 'billing', '_pgrest.js'));
const PRICING = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'games', 'data', 'config.json'), 'utf8'));
const SB = CFG.supabase_url.replace(/\/+$/, '');
const ANON = CFG.supabase_anon_key;
const REQUIRED = process.env.FAIRLINE_UI_REQUIRED === '1';
const lit = PG.lit;

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
function done() { console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'fairline page — ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }
function skip(why) { if (REQUIRED) { chk('environment: ' + why, false); done(); } console.log('SKIPPED: ' + why + ' (not verified)'); process.exit(0); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });
async function eventually(cond, ms) { const until = Date.now() + (ms || 8000); while (Date.now() < until) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return cond(); }
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (id, email) => b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: id, email, role: 'authenticated', exp: 4102444800 }) + '.' + crypto.randomBytes(6).toString('hex');

(async () => {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) skip('Playwright is not installed');
  const db = PG.start('flpage');
  if (db.skip) skip(db.skip);

  /* ── the database, as shipped ───────────────────────────────────────── */
  db.sql('create table public.signals (sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text, ' +
    'market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz, point_is_modal boolean, is_player_prop boolean not null default false, ' +
    'flagged_at timestamptz, closed_at timestamptz, closing_sharp_fair numeric, clv_excluded_reason text, closing_source text, result text, ' +
    'closing_dec numeric, closing_at_observed timestamptz, clv numeric, beat_close boolean, best_dec numeric, best_book text, best_quote_age_s integer, n_books integer);');
  for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql', 'bet_checker.sql',
    'portfolio.sql', 'bet_import.sql', 'fairline.sql']) {
    db.applyFileAtomic(path.join(ROOT, 'supabase', f));
  }
  const sig = (ev, sport, title, home, away, market, sel, point, fair, best, book, seenMin, startH) => db.sql('insert into public.signals (sig_key, event_id, sport_key, sport_title, ' +
    'commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at, point_is_modal, best_dec, best_book, best_quote_age_s) values (' +
    [lit(ev + '|' + market + '|' + sel + '|' + (point == null ? '' : point)), lit(ev), lit(sport), lit(title), "now() + interval '" + startH + " hours'", lit(home), lit(away),
     lit(market), lit(sel), point == null ? 'null' : point, fair, "now() - interval '" + seenMin + " minutes'", 'true', best, lit(book), 60].join(', ') + ');');
  sig('nfl1', 'americanfootball_nfl', 'NFL', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -3.5, 0.52, 2.04, 'DraftKings', 5, 48);
  sig('nfl1', 'americanfootball_nfl', 'NFL', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Buffalo Bills', 3.5, 0.48, 1.95, 'FanDuel', 5, 48);
  sig('nfl1', 'americanfootball_nfl', 'NFL', 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Over', 47.5, 0.5, 2.01, 'BetMGM', 5, 48);
  sig('nfl1', 'americanfootball_nfl', 'NFL', 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Under', 47.5, 0.5, 1.93, 'BetMGM', 300, 48);   /* stale */
  sig('nfl1', 'americanfootball_nfl', 'NFL', 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Kansas City Chiefs', null, 0.62, 1.7, 'Caesars', 5, 48);
  sig('nfl1', 'americanfootball_nfl', 'NFL', 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Buffalo Bills', null, 0.38, 2.9, 'DraftKings', 5, 48);
  sig('cfb1', 'americanfootball_ncaaf', 'NCAAF', 'Ohio State Buckeyes', 'Michigan Wolverines', 'spreads', 'Michigan Wolverines', 7, 0.5, 2.1, 'FanDuel', 10, 30);
  sig('cfb1', 'americanfootball_ncaaf', 'NCAAF', 'Ohio State Buckeyes', 'Michigan Wolverines', 'spreads', 'Ohio State Buckeyes', -7, 0.5, 1.87, 'DraftKings', 10, 30);

  const tokens = {};
  const user = (n, email) => {
    const id = '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
    db.sql('insert into auth.users (id, email, email_confirmed_at) values (' + lit(id) + ', ' + lit(email) + ', now());');
    const t = jwt(id, email);
    tokens[t] = { id, email, confirmed: true };
    return { id, email, token: t, session: { access_token: t, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: { id, email } } };
  };
  const FREE = user(1, 'free@example.com'), PAID = user(2, 'paid@example.com'), RED = user(3, 'red@example.com');
  db.service("select public.billing_learn_price_tier('price_red_e2e', 'prod_bc', 'red', 'bet_checker_monthly', true, 'e2e');");
  db.service("select public.billing_learn_price_tier('price_black_e2e', 'prod_fl', 'black', 'fairline_monthly', true, 'e2e');");
  db.sql("insert into public.subscriptions (user_id, status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id) values (" +
    lit(PAID.id) + ", 'active', 'price_black_e2e', now() + interval '20 days', 'cus_e2e', 'sub_e2e'), (" +
    lit(RED.id) + ", 'active', 'price_red_e2e', now() + interval '20 days', 'cus_red', 'sub_red');");
  db.sql('insert into public.bankroll_settings (user_id, base_unit_amount, unit_mode) values (' + lit(PAID.id) + ", 25, 'fixed') on conflict (user_id) do update set base_unit_amount = 25, unit_mode = 'fixed';");
  /* settled Bet Checker bets, as the grader leaves them */
  const bc = (u, sport, market, side, line, odds, book, win, clv, n) => db.sql('set session_replication_role = replica; insert into public.user_bets (user_id, bet_key, source, sport, game_id, event_id, ' +
    'market_type, side, team, line, odds, book, units, placed_at, kickoff, home_team, away_team, result, units_won, close_status, clv_pct) values (' +
    [lit(u), lit('bc:' + crypto.randomBytes(6).toString('hex')), "'own'", lit(sport), "'g'", "'g'", lit(market), lit(side), market === 'total' ? 'null' : "'Kansas City Chiefs'",
     line, odds, lit(book), 1, "now() - interval '" + (60 + n) + " hours'", "now() - interval '5 hours'", "'Kansas City Chiefs'", "'Buffalo Bills'",
     lit(win ? 'win' : 'loss'), win ? 0.9091 : -1, "'captured'", clv].join(', ') + '); set session_replication_role = default;');
  for (let i = 0; i < 15; i++) {
    bc(FREE.id, 'NFL', 'spread', 'home', -3.5, -110, 'DraftKings', i < 5, -2, i);
    bc(PAID.id, 'NFL', 'spread', 'home', -3.5, -110, 'DraftKings', i < 5, -2, i);
    bc(PAID.id, 'CFB', 'total', 'over', 55.5, -110, 'Kalshi', i < 5, 3, i);
  }
  for (let i = 0; i < 4; i++) bc(PAID.id, 'NFL', 'moneyline', 'home', 'null', 150, 'Other', i < 1, 1, i);
  const rest = REST.make(db, { serviceKey: 'service-key', anonKey: ANON, tokens });
  const checkouts = [];

  const { srv, port } = await serve(siteHandler);
  const BASE = 'http://127.0.0.1:' + port;
  const browser = await pw.chromium.launch();
  const errors = [];
  async function pageFor(u, width) {
    const ctx = await browser.newContext({ viewport: { width: width || 1280, height: 900 } });
    if (u) await ctx.addInitScript((s) => { try { localStorage.setItem('edgedesk_session', JSON.stringify(s)); } catch (_) {} }, u.session);
    await ctx.route(SB + '/**', async (route) => {
      const r = route.request();
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: '' });
      let res;
      if (r.url().indexOf('/functions/v1/create_checkout_session') >= 0) {
        /* Stripe's hosted checkout is stood in for; the function itself is proven against the real SQL by tools/billing/fairline_tier.test.js */
        checkouts.push({ body: JSON.parse(r.postData() || '{}'), consentsBefore: Number(db.sql('select count(*) from public.billing_consents;')) });
        res = new Response(JSON.stringify({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_fl', session_id: 'cs_test_fl', ref: 'EDS-FL0000' }), { status: 200 });
      } else if (r.url().indexOf('/functions/v1/') >= 0) {
        res = new Response(JSON.stringify({ ok: false }), { status: 404 });
      } else {
        res = await rest.fetch(r.url(), { method: r.method(), headers: r.headers(), body: r.postData() });
      }
      const text = await res.text();
      return route.fulfill({ status: res.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: text });
    });
    await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await ctx.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe checkout (stand-in)</h1>' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return { ctx, page };
  }
  const text = (page, sel) => page.locator(sel).first().innerText().catch(() => '');
  const SHOTS = process.env.FAIRLINE_SHOTS || '';
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  /* how far a locked offer's button pokes out of its box (0 = fully inside) */
  const clipped = (page, sel) => page.evaluate((s) => {
    const box = document.querySelector(s), btn = box && box.querySelector('[data-fl="upgrade"]');
    if (!box || !btn) return 'missing';
    const a = box.getBoundingClientRect(), b = btn.getBoundingClientRect();
    return Math.max(0, Math.round(b.bottom - a.bottom), Math.round(a.top - b.top));
  }, sel);

  try {
    /* 1. signed out */
    let { ctx, page } = await pageFor(null);
    await page.goto(BASE + '/fairline/');
    chk('signed out: the free sign-in is shown, not an error', await eventually(async () => page.locator('[data-fl="out"]').isVisible()));
    chk('and it offers a free account', /Create a free account/.test(await text(page, '[data-fl="out"]')));
    await ctx.close();

    /* 2. a free reader, on a phone */
    ({ ctx, page } = await pageFor(FREE, 390));
    await page.goto(BASE + '/fairline/');
    chk('free: signed in, The Board first', await eventually(async () => /Signed in as free@example.com/.test(await text(page, '[data-fl="who"]'))) &&
      await page.locator('[data-fl="board"]').isVisible());
    chk('free: the top three rows, all fresh', await eventually(async () => (await page.locator('[data-fl="rows"] .fl-row[data-key]').count()) === 3) &&
      await page.locator('[data-fl="rows"] .fl-row[data-fresh="false"]').count() === 0);
    chk('free: the first row is the largest edge (Bills ML at +190 vs 38%: +3.52 pts)', /Buffalo Bills ML/.test(await text(page, '[data-fl="rows"] .fl-row[data-key]')) &&
      /\+3\.52 pts/.test(await text(page, '[data-fl="rows"] .fl-row[data-key]')), await text(page, '[data-fl="rows"] .fl-row[data-key]'));
    chk('free: the rest are blurred, counted, with the offer', await page.locator('[data-fl="board-locked"] .fl-blur').count() === 1 &&
      /5 more prices on The Board/.test(await text(page, '[data-fl="board-locked"]')) && await page.locator('[data-fl="board-locked"] [data-fl="upgrade"]').isVisible());
    chk('free: at 390 px the offer\'s button sits wholly inside the locked Board (never cut off)', (await clipped(page, '[data-fl="board-locked"]')) === 0,
      await clipped(page, '[data-fl="board-locked"]'));
    chk('free: the filters are locked, and say so', await page.locator('select[name="sport"]').isDisabled() && /Filters are part of Fairline/.test(await text(page, '[data-fl="filters"]')));
    chk('The Tape is visibly Coming Soon, not hidden', await page.locator('[data-fl-tab="tape"]').isVisible() && await page.locator('[data-fl-tab="tape"]').isDisabled() &&
      /Coming Soon/.test(await text(page, '[data-fl-tab="tape"]')));
    chk('The Board says plainly it is prices, not picks, and names its limits', /Prices, not picks/.test(await text(page, '[data-fl="board"]')) &&
      /actionable lines only/.test(await text(page, '[data-fl="limits"]')));
    chk('at 390 px nothing scrolls sideways (The Board)', (await overflow(page)) <= 0, await overflow(page));
    await shot(page, '1-free-board-phone');
    await page.click('[data-fl-tab="leaks"]');
    chk('free: The Leaks names the biggest leak\'s slice, and nothing more', await eventually(async () => /Your biggest leak is in /.test(await text(page, '[data-fl="teaser"]'))),
      await text(page, '[data-fl="leaks-body"]'));
    const lockedHtml = await page.locator('[data-fl="leaks-body"]').innerHTML();
    chk('free: at 390 px the offer\'s button sits wholly inside the locked Leaks (never cut off)', (await clipped(page, '[data-fl="teaser"] .fl-locked')) === 0,
      await clipped(page, '[data-fl="teaser"] .fl-locked'));
    chk('free: no real number on the page (the server sent none)', !/272|−5\.45|-5\.45|36\.4/.test(lockedHtml) && /00–00/.test(lockedHtml));
    await shot(page, '2-free-leaks-phone');

    /* 4. the upgrade, with the automatic-renewal consent */
    await page.click('[data-fl="teaser"] [data-fl-act="upgrade"]');
    const terms = await text(page, '[data-fl="terms"]');
    chk('the renewal terms: $19.99 per month, renews automatically, cancel anytime in Settings on the Fairline page', terms === PRICING.fairlineTerms('monthly') &&
      /\$19\.99 per month, renews automatically/.test(terms) && /Settings › Subscription on the Fairline page/.test(terms), terms);
    chk('Subscribe stays off until the terms are ticked', await page.locator('[data-fl="arl-go"]').isDisabled());
    await page.click('[data-fl-plan="annual"]');
    chk('the annual plan shows its own figure', /\$159\.00 per year/.test(await text(page, '[data-fl="terms"]')) && /\$159\.00\/year/.test(await text(page, '[data-fl="arl-go"]')));
    await page.click('[data-fl-plan="monthly"]');
    chk('at 390 px the sheet does not scroll the page sideways', (await overflow(page)) <= 0, await overflow(page));
    await shot(page, '2b-renewal-terms-phone');
    await page.check('[data-fl="agree"]');
    await page.click('[data-fl="arl-go"]');
    chk('the browser goes to Stripe', await eventually(async () => /checkout\.stripe\.com/.test(page.url()), 8000), page.url());
    chk('the server checkout was asked for Fairline monthly at 1999 cents, no trial', checkouts.length === 1 && checkouts[0].body.kind === 'fairline' &&
      checkouts[0].body.plan === 'monthly' && checkouts[0].body.price_cents === 1999 && checkouts[0].body.trial_days === 0, checkouts);
    chk('no consent was written before the server checkout existed', checkouts[0].consentsBefore === 0, checkouts);
    const consent = JSON.parse(db.sql('select row_to_json(c) from public.billing_consents c where user_id = ' + lit(FREE.id) + ' order by created_at desc limit 1;') || 'null');
    chk('the consent is on record with the EXACT terms shown, the figure and the version', consent && consent.offer_text === PRICING.fairlineTerms('monthly') &&
      consent.price_display === '$19.99' && consent.billing_period === 'month' && consent.trial_days === 0 && consent.consent_version === 'fairline-2026-10', consent);
    await ctx.close();

    /* 5. a Bet Checker reader: not Fairline; a switch in the portal, never a second checkout */
    ({ ctx, page } = await pageFor(RED));
    await page.goto(BASE + '/fairline/');
    chk('Bet Checker alone: The Board is the teaser', await eventually(async () => (await page.locator('[data-fl="rows"] .fl-row[data-key]').count()) === 3) &&
      await page.locator('[data-fl="board-locked"]').count() === 1);
    const sw = page.locator('[data-fl="board-locked"] [data-fl="upgrade"]');
    chk('…and the offer is the plan switch in the billing portal', /Switch to Fairline/.test(await sw.innerText()) && await sw.getAttribute('href') === PRICING.portalLink());
    chk('Settings names the plan, says Fairline is not included, and links the portal', /EdgeDesk Bet Checker \(Fairline not included\)/.test(await text(page, '[data-fl="settings"]')) &&
      await page.locator('[data-fl="portal"]').getAttribute('href') === PRICING.portalLink());
    await ctx.close();

    /* 3. a paid reader */
    ({ ctx, page } = await pageFor(PAID));
    await page.goto(BASE + '/fairline/');
    chk('paid: every row on The Board', await eventually(async () => (await page.locator('[data-fl="rows"] .fl-row[data-key]').count()) === 8) &&
      await page.locator('[data-fl="board-locked"]').count() === 0);
    const stale = page.locator('[data-fl="rows"] .fl-row[data-fresh="false"]');
    chk('paid: the stale row is greyed, says "Stale", and is last', await stale.count() === 1 && /Stale/.test(await stale.innerText()) &&
      await page.locator('[data-fl="rows"] .fl-row[data-key]').last().getAttribute('data-fresh') === 'false' &&
      Number(await stale.evaluate((e) => getComputedStyle(e).opacity)) < 1);
    chk('paid: DK Predictions is "Coming Soon" on every row', (await page.locator('[data-fl="rows"] .fl-row[data-key] .fl-cell.inactive').allInnerTexts()).every((t) => /Coming Soon/.test(t)) &&
      await page.locator('[data-fl="rows"] .fl-row[data-key] .fl-cell.inactive').count() === 8);
    chk('paid: each row shows fair (probability and odds), the best price and its book, the edge and the age',
      /52\.0%\s*fair −108/.test(await text(page, '[data-key="nfl1|spreads|Kansas City Chiefs|-3.5"]')) && /\+104/.test(await text(page, '[data-key="nfl1|spreads|Kansas City Chiefs|-3.5"]')) &&
      /DraftKings/.test(await text(page, '[data-key="nfl1|spreads|Kansas City Chiefs|-3.5"]')) && /\+2\.98 pts/.test(await text(page, '[data-key="nfl1|spreads|Kansas City Chiefs|-3.5"]')) &&
      /6 min/.test(await text(page, '[data-key="nfl1|spreads|Kansas City Chiefs|-3.5"]')), await text(page, '[data-key="nfl1|spreads|Kansas City Chiefs|-3.5"]'));
    await shot(page, '3-paid-board');
    await page.selectOption('select[name="market"]', 'total');
    chk('paid: the market filter: totals only', await eventually(async () => (await page.locator('[data-fl="rows"] .fl-row[data-key]').count()) === 2) &&
      (await page.locator('[data-fl="rows"] .fl-row[data-key] .gm-lg').allInnerTexts()).every((t) => /total/i.test(t)));
    chk('paid: a filter never removes the other filters\' choices', (await page.locator('select[name="book"] option').count()) === 5 &&
      (await page.locator('select[name="sport"] option').count()) === 3, await page.locator('select[name="book"] option').allInnerTexts());
    await page.click('[data-fl-tab="leaks"]');
    chk('paid: The Leaks leads with the biggest real leak, in one plain sentence',
      await eventually(async () => /^NFL: down \$189 over 19 bets, and you’re not beating the close\. This one’s real\.$/.test(await text(page, '[data-fl="top"] .fl-verdict'))),
      await text(page, '[data-fl="top"]'));
    chk('paid: its label is a chip with words', /Real leak/.test(await text(page, '[data-fl="top"] .fl-chip')));
    chk('paid: bad luck is told apart from a leak', /Bad luck/.test(await text(page, '[data-fl-dim="sport"] [data-val="CFB"]')) &&
      /beating the close/.test((await page.locator('[data-fl="leaks-body"]').innerText())));
    chk('paid: a small sample says so, with no label', /Small sample/.test(await text(page, '[data-fl-dim="market"] [data-val="moneyline"]')));
    const dims = await page.locator('[data-fl-dim]').evaluateAll((els) => els.map((e) => e.getAttribute('data-fl-dim')));
    chk('paid: every dimension the spec names is on the page', ['market', 'sport', 'bet_type', 'odds', 'lead', 'book', 'stake'].every((d) => dims.indexOf(d) >= 0) &&
      dims.length === 7, dims);
    chk('paid: dollars come from the unit size, and the page says so', /bankroll settings/.test(await text(page, '[data-fl="leaks-body"]')));
    chk('paid: Settings › Subscription names Fairline and links the billing portal to cancel', /Plan: EdgeDesk Fairline/.test(await text(page, '[data-fl="settings"]')) &&
      await page.locator('[data-fl="portal"]').getAttribute('href') === PRICING.portalLink());
    await shot(page, '4-paid-leaks');
    await ctx.close();
    ({ ctx, page } = await pageFor(PAID, 390));
    await page.goto(BASE + '/fairline/#leaks');
    await eventually(async () => (await page.locator('[data-fl="top"] .fl-verdict').count()) > 0);
    chk('a link to #leaks opens The Leaks', await page.locator('[data-fl="leaks"]').isVisible());
    chk('at 390 px nothing scrolls sideways (The Leaks)', (await overflow(page)) <= 0, await overflow(page));
    await shot(page, '5-paid-leaks-phone');
    await page.click('[data-fl-tab="board"]');
    await eventually(async () => (await page.locator('[data-fl="rows"] .fl-row[data-key]').count()) === 8);
    chk('at 390 px nothing scrolls sideways (the paid Board)', (await overflow(page)) <= 0, await overflow(page));
    await shot(page, '6-paid-board-phone');
    await ctx.close();

    chk('no script error on any page load', errors.length === 0, errors.slice(0, 4));
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1200));
  } finally {
    await browser.close();
    srv.close();
    db.stop();
  }
  done();
})();
