#!/usr/bin/env node
/* ===========================================================================
   THE BET CHECKER PAGE, IN A REAL BROWSER, AGAINST THE REAL STACK.

   bet-checker/index.html is served as shipped. Every call it makes to
   Supabase is answered by the SHIPPED log_user_bet function (imported, under
   a Deno shim) and the PostgREST / Auth stand-in the billing suites use, over
   a throwaway PostgreSQL carrying the SHIPPED migrations — the page, the
   function and the SQL that grades are the ones that ship. Only Stripe's
   hosted checkout is stood in for (create_checkout_session is proven against
   the real SQL by tools/billing/tier_flow.test.js).

     1  a signed-out visitor sees the free sign-in, not an error
     2  a free reader logs an NFL bet: the grade appears AT ONCE (green), the
        card is on the list, "1 of 10 grades used this month"
     3  a college football bet grades red; a line EdgeDesk never priced is
        saved "Not graded", saying it is never estimated
     4  the paid stats are blurred, with no real number on the page, and an
        upgrade button
     5  the eleventh graded bet of the month is SAVED, ungraded, with the
        upgrade prompt
     6  the upgrade: the renewal terms ($7.99 per month, renews automatically,
        cancel anytime in Settings) must be ticked; the consent is recorded
        with those exact words BEFORE the browser goes to Stripe
     7  after the close, a card shows its CLV — and a bet whose line the
        market closed off says "No close available"
     8  a Bet Checker subscriber sees real stats and the billing portal
     9  at 390 px nothing scrolls sideways; no script error anywhere

   Needs Playwright + Chromium and PostgreSQL (skips cleanly without;
   BET_CHECKER_UI_REQUIRED=1 makes a missing one a failure, as CI sets it).
   Run: node tools/bet_checker/page.e2e.js
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
const REQUIRED = process.env.BET_CHECKER_UI_REQUIRED === '1';
const lit = PG.lit;

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
function done() { console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'bet checker page — ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }
function skip(why) { if (REQUIRED) { chk('environment: ' + why, false); done(); } console.log('SKIPPED: ' + why); process.exit(0); }

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
  const db = PG.start('bcpage');
  if (db.skip) skip(db.skip);

  /* ── the database, as shipped ───────────────────────────────────────── */
  db.sql('create table public.signals (sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text, ' +
    'market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz, point_is_modal boolean, is_player_prop boolean not null default false, ' +
    'flagged_at timestamptz, closed_at timestamptz, closing_sharp_fair numeric, clv_excluded_reason text, closing_source text, result text, ' +
    'closing_dec numeric, closing_at_observed timestamptz, clv numeric, beat_close boolean);');
  for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql', 'bet_checker.sql']) {
    db.applyFileAtomic(path.join(ROOT, 'supabase', f));
  }
  const sig = (ev, sport, home, away, market, sel, point, fair, modal) => db.sql("insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at, point_is_modal) values (" +
    [lit(ev + '|' + market + '|' + sel + '|' + (point == null ? '' : point)), lit(ev), lit(sport), "now() + interval '2 days'", lit(home), lit(away), lit(market), lit(sel),
     point == null ? 'null' : point, fair, "now() - interval '5 minutes'", modal ? 'true' : 'false'].join(', ') + ');');
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -3.5, 0.52, true);
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Buffalo Bills', 3.5, 0.48, true);
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -3, 0.55, false);
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Over', 47.5, 0.5, true);
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Under', 47.5, 0.5, true);
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Kansas City Chiefs', null, 0.62, true);
  sig('nfl1', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Buffalo Bills', null, 0.38, true);
  sig('cfb1', 'americanfootball_ncaaf', 'Ohio State Buckeyes', 'Michigan Wolverines', 'spreads', 'Ohio State Buckeyes', -7, 0.5, true);
  sig('cfb1', 'americanfootball_ncaaf', 'Ohio State Buckeyes', 'Michigan Wolverines', 'spreads', 'Michigan Wolverines', 7, 0.5, true);

  const tokens = {};
  const user = (n, email) => {
    const id = '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
    db.sql('insert into auth.users (id, email, email_confirmed_at) values (' + lit(id) + ', ' + lit(email) + ', now());');
    const t = jwt(id, email);
    tokens[t] = { id, email, confirmed: true };
    return { id, email, token: t, session: { access_token: t, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: { id, email } } };
  };
  const FREE = user(1, 'free@example.com'), PAID = user(2, 'paid@example.com');
  db.service("select public.billing_learn_price_tier('price_red_e2e', 'prod_bc', 'red', 'bet_checker_monthly', true, 'e2e');");
  db.sql("insert into public.subscriptions (user_id, status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id) values (" +
    lit(PAID.id) + ", 'active', 'price_red_e2e', now() + interval '20 days', 'cus_e2e', 'sub_e2e');");

  /* ── the shipped function, and the stand-in, behind Supabase's URL ─── */
  const rest = REST.make(db, { serviceKey: 'service-key', anonKey: ANON, tokens });
  const ENV = { SUPABASE_URL: SB, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
  globalThis.Deno = { env: { get: (k) => ENV[k] } };
  globalThis.fetch = async (url, init) => rest.fetch(String(url), init);
  const quiet = console.log; console.log = () => {};
  let LOG;
  try { LOG = await import(path.join(ROOT, 'supabase', 'functions', 'log_user_bet', 'index.ts')); }
  catch (e) { console.log = quiet; db.stop(); skip('log_user_bet could not be imported: ' + (e && e.message)); }
  console.log = quiet;
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
      const url = r.url();
      const headers = r.headers();
      const body = r.postData();
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: '' });
      let res;
      if (url.indexOf('/functions/v1/log_user_bet') >= 0) {
        const q = console.log; console.log = () => {};
        try { res = await LOG.handle(new Request(url, { method: r.method(), headers, body: r.method() === 'POST' ? body : undefined })); }
        finally { console.log = q; }
      } else if (url.indexOf('/functions/v1/create_checkout_session') >= 0) {
        checkouts.push({ body: JSON.parse(body || '{}'), consentsBefore: Number(db.sql('select count(*) from public.billing_consents;')) });
        res = new Response(JSON.stringify({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_e2e', session_id: 'cs_test_e2e', ref: 'EDS-E2E000' }), { status: 200 });
      } else if (url.indexOf('/functions/v1/') >= 0) {
        res = new Response(JSON.stringify({ ok: false }), { status: 404 });
      } else {
        res = await rest.fetch(url, { method: r.method(), headers, body });
      }
      const text = await res.text();
      return route.fulfill({ status: res.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: text });
    });
    await ctx.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe checkout (stand-in)</h1>' }));
    await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return { ctx, page };
  }
  const text = (page, sel) => page.locator(sel).first().innerText().catch(() => '');
  /* BET_CHECKER_SHOTS=<dir> keeps a picture of each state, for a person to look at */
  const SHOTS = process.env.BET_CHECKER_SHOTS || '';
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };

  try {
    /* 1. signed out */
    let { ctx, page } = await pageFor(null);
    await page.goto(BASE + '/bet-checker/');
    chk('signed out: the free sign-in is shown, not an error', await eventually(async () => page.locator('[data-bc="out"]').isVisible()));
    chk('and it offers a free account', /Create a free account/.test(await text(page, '[data-bc="out"]')));
    await ctx.close();

    /* 2. a free reader logs an NFL bet */
    ({ ctx, page } = await pageFor(FREE));
    await page.goto(BASE + '/bet-checker/');
    chk('signed in: the page opens on the reader\'s account', await eventually(async () => /Signed in as free@example.com/.test(await text(page, '[data-bc="who"]'))));
    chk('no bets yet: the form is open and the list says how it works', await eventually(async () => page.locator('[data-bc="form-wrap"]').evaluate((d) => d.open)) &&
      /No bets logged yet/.test(await text(page, '[data-bc="bets"]')));
    chk('"0 of 10 grades used this month"', /0 of 10 grades used this month/.test(await text(page, '[data-bc="usage"]')));
    await page.click('[data-bc-sport="NFL"]');
    const games = await page.locator('select[name="game"] option').allInnerTexts();
    chk('only NFL games, only ones that have not started', games.length === 2 && /Buffalo Bills at Kansas City Chiefs/.test(games[1]), games);
    await page.selectOption('select[name="game"]', 'nfl1');
    await eventually(async () => (await page.locator('select[name="market"] option').count()) === 4);
    await page.selectOption('select[name="market"]', 'spread');
    await page.selectOption('select[name="side"]', 'home');
    chk('the main line fills itself in', await page.inputValue('input[name="line"]') === '-3.5');
    chk('the hint names the lines EdgeDesk grades', /Graded at: −3\.5 \(main\), −3/.test(await text(page, '[data-bc="lines"]')), await text(page, '[data-bc="lines"]'));
    await page.fill('input[name="odds"]', '+105');
    const t0 = Date.now();
    await page.click('[data-bc="submit"]');
    chk('THE GRADE APPEARS AT ONCE: green, +3.22 points', await eventually(async () => /Beat fair/.test(await text(page, '[data-bc="result"]')), 5000) &&
      /\+3\.22 pts/.test(await text(page, '[data-bc="result"]')), await text(page, '[data-bc="result"]'));
    chk('in under three seconds', Date.now() - t0 < 3000, Date.now() - t0);
    chk('the card is on the list, green, with EdgeDesk\'s fair', await page.locator('.bc-card[data-grade="green"]').count() === 1 &&
      /fair -108/.test(await text(page, '.bc-card[data-grade="green"]')) && /CLV after the close/.test(await text(page, '.bc-card[data-grade="green"]')));
    chk('and it is a game card (the simple .gm-card)', await page.locator('.gm-card.bc-card').count() === 1);
    chk('"1 of 10 grades used this month"', /1 of 10 grades used this month/.test(await text(page, '[data-bc="usage"]')));
    chk('the row is the reader\'s, in the database', db.sql("select count(*) from public.user_bets where user_id = " + lit(FREE.id) + " and entry_grade = 'green'") === '1');

    /* 3. college football: red; a line never priced: ungraded */
    await page.click('[data-bc-sport="CFB"]');
    await page.selectOption('select[name="game"]', 'cfb1');
    await eventually(async () => (await page.locator('select[name="market"] option').count()) === 2);
    await page.selectOption('select[name="market"]', 'spread');
    await page.selectOption('select[name="side"]', 'home');
    await page.fill('input[name="odds"]', '-110');
    await page.click('[data-bc="submit"]');
    chk('a college football bet at -110 against a 50% fair: RED', await eventually(async () => /Below fair/.test(await text(page, '[data-bc="result"]'))), await text(page, '[data-bc="result"]'));
    await page.fill('input[name="line"]', '-6');
    await page.fill('input[name="odds"]', '-110');
    await page.click('[data-bc="submit"]');
    chk('a line EdgeDesk never priced: saved "Not graded", and it says we never estimate one',
      await eventually(async () => /Not graded/.test(await text(page, '[data-bc="result"]'))) && /never estimate/.test(await text(page, '[data-bc="result"]')));
    chk('three cards now, newest first', await page.locator('.bc-card').count() === 3 && /Not graded/.test(await text(page, '.bc-card')));
    await shot(page, '1-free-after-three-bets');

    /* 4. the paid stats, blurred */
    chk('the stats are locked for a free reader, with an upgrade button', await page.locator('.bc-locked .bc-blur').count() === 1 &&
      await page.locator('.bc-lock-over [data-bc-act="upgrade"]').isVisible());
    const statsHtml = await page.locator('[data-bc="stats"]').innerHTML();
    chk('and the blurred block carries no real number (the server sent none)', /00%/.test(statsHtml) && !/3\.22|−2\.38|-2\.38/.test(statsHtml));

    /* 5. the eleventh graded bet of the month */
    for (let i = 0; i < 8; i++) db.service('select public.bet_checker_log_bet(' + lit(FREE.id) + ", 'nfl1', 'spread', 'away', 3.5, -110, 'DraftKings', 1, " + lit(crypto.randomBytes(8).toString('hex')) + ');');
    await page.reload();
    await eventually(async () => /10 of 10 grades used this month/.test(await text(page, '[data-bc="usage"]')));
    chk('ten used: the usage line says so, and what happens next', /10 of 10 grades used this month/.test(await text(page, '[data-bc="usage"]')) &&
      /saved without a grade/.test(await text(page, '[data-bc="usage"]')));
    await page.click('[data-bc="form-wrap"] summary');
    await page.click('[data-bc-sport="NFL"]');
    await page.selectOption('select[name="game"]', 'nfl1');
    await eventually(async () => (await page.locator('select[name="market"] option').count()) === 4);
    await page.selectOption('select[name="market"]', 'total');
    await page.selectOption('select[name="side"]', 'over');
    await page.fill('input[name="odds"]', '+100');
    await page.click('[data-bc="submit"]');
    chk('the eleventh: SAVED, "Not graded — free limit", with an upgrade prompt',
      await eventually(async () => /free limit/.test(await text(page, '[data-bc="result"]'))) && await page.locator('[data-bc="result"] [data-bc-act="upgrade"]').isVisible());
    chk('and it is in the database, ungraded, with no fair price', db.sql("select count(*) from public.user_bets where user_id = " + lit(FREE.id) +
      " and entry_grade_reason = 'free_limit_reached' and entry_fair_price is null") === '1');

    /* 6. the upgrade, with the automatic-renewal consent */
    await page.click('[data-bc="result"] [data-bc-act="upgrade"]');
    const terms = await text(page, '[data-bc="terms"]');
    chk('the renewal terms: $7.99 per month, renews automatically, cancel anytime in Settings', terms === PRICING.betCheckerTerms('monthly') &&
      /\$7\.99 per month, renews automatically/.test(terms) && /Cancel anytime in Settings/.test(terms), terms);
    chk('Subscribe stays off until the terms are ticked', await page.locator('[data-bc="arl-go"]').isDisabled());
    await page.click('[data-bc-plan="annual"]');
    chk('the annual plan shows its own figure', /\$59\.00 per year/.test(await text(page, '[data-bc="terms"]')) && /\$59\.00\/year/.test(await text(page, '[data-bc="arl-go"]')));
    await page.click('[data-bc-plan="monthly"]');
    await shot(page, '2-renewal-terms');
    await page.check('[data-bc="agree"]');
    await page.click('[data-bc="arl-go"]');
    chk('the browser goes to Stripe', await eventually(async () => /checkout\.stripe\.com/.test(page.url()), 8000), page.url());
    chk('the server checkout was asked for Bet Checker monthly at 799 cents, no trial', checkouts.length === 1 && checkouts[0].body.kind === 'bet_checker' &&
      checkouts[0].body.plan === 'monthly' && checkouts[0].body.price_cents === 799 && checkouts[0].body.trial_days === 0, checkouts);
    chk('no consent was written before the server checkout existed (no checkout, no consent record)', checkouts[0].consentsBefore === 0, checkouts);
    const consent = JSON.parse(db.sql('select row_to_json(c) from public.billing_consents c where user_id = ' + lit(FREE.id) + ' order by created_at desc limit 1;') || 'null');
    chk('the consent is on record with the EXACT terms shown, the figure and the version', consent && consent.offer_text === PRICING.betCheckerTerms('monthly') &&
      consent.price_display === '$7.99' && consent.billing_period === 'month' && consent.trial_days === 0 && consent.consent_version === 'bet-checker-2026-10', consent);
    await ctx.close();

    /* 7. after the close */
    db.sql("set session_replication_role = replica; update public.user_bets set kickoff = now() - interval '1 hour' where event_id = 'nfl1'; " +
      "update public.signals set commence_time = now() - interval '1 hour' where event_id = 'nfl1'; set session_replication_role = default;");
    db.sql("update public.signals set closed_at = now(), closing_sharp_fair = 0.55, closing_source = 'live' where sig_key = 'nfl1|spreads|Kansas City Chiefs|-3.5';" +
      " update public.signals set closed_at = now(), closing_sharp_fair = 0.45, closing_source = 'live' where sig_key = 'nfl1|spreads|Buffalo Bills|3.5';" +
      " update public.signals set closed_at = now(), clv_excluded_reason = 'line_pulled_no_close', closing_source = 'none' where sig_key = 'nfl1|spreads|Kansas City Chiefs|-3';" +
      " update public.signals set closed_at = now(), closing_sharp_fair = 0.5, closing_source = 'live' where market = 'totals' and event_id = 'nfl1';");
    db.service("select public.bet_checker_log_bet(" + lit(PAID.id) + ", 'cfb1', 'spread', 'away', 7, -105, 'Kalshi', 2, 'paidcfb0001');");
    db.sql("set session_replication_role = replica; insert into public.user_bets (user_id, bet_key, source, sport, game_id, event_id, market_type, side, team, line, odds, book, units, entry_grade, close_status, kickoff, home_team, away_team) values (" +
      lit(FREE.id) + ", 'bc:offline-3', 'own', 'NFL', 'nfl1', 'nfl1', 'spread', 'home', 'Kansas City Chiefs', -3, -110, 'DraftKings', 1, 'yellow', 'pending', now() - interval '1 hour', 'Kansas City Chiefs', 'Buffalo Bills'); set session_replication_role = default;");
    db.service('select public.bet_checker_grade_pending(500);');
    ({ ctx, page } = await pageFor(FREE, 390));
    await page.goto(BASE + '/bet-checker/');
    await eventually(async () => (await page.locator('.bc-card').count()) > 0);
    const cards = await page.locator('.bc-card').allInnerTexts();
    chk('after the close the green bet shows its CLV: +12.75%', cards.some((c) => /Beat fair/.test(c) && /CLV \+12\.75%/.test(c)), cards.slice(0, 3));
    chk('a bet whose line the market closed off says "No close available", and why', cards.some((c) => /No close available/.test(c) && /different line/.test(c) && /closed at −3\.5/.test(c)));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk('at 390 px nothing scrolls sideways', overflow <= 0, overflow);
    await shot(page, '3-phone-after-close');
    await ctx.close();

    /* 8. a Bet Checker subscriber */
    ({ ctx, page } = await pageFor(PAID));
    await page.goto(BASE + '/bet-checker/');
    chk('a subscriber sees real stats: no blur, the CLV rate and the splits', await eventually(async () => (await page.locator('.bc-kpis .stat').count()) === 4) &&
      await page.locator('.bc-blur').count() === 0 && /By market/.test(await text(page, '[data-bc="stats"]')) && /By book/.test(await text(page, '[data-bc="stats"]')));
    chk('no usage line: every bet is graded', await page.locator('[data-bc="usage"]').isHidden());
    await shot(page, '4-subscriber');
    chk('Settings › Subscription names the plan and links the billing portal to cancel',
      /EdgeDesk Bet Checker/.test(await text(page, '[data-bc="settings"]')) && await page.locator('[data-bc="portal"]').getAttribute('href') === PRICING.portalLink());
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
