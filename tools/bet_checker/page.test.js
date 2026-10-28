#!/usr/bin/env node
/* ===========================================================================
   THE BET CHECKER PAGE'S WIRING — without a browser.
   (tools/bet_checker/page.e2e.js drives it in Chromium against the real SQL.)

     * the page carries the site's one Main nav, loads each module once, in
       dependency order, and reads its Supabase project from the same
       committed config the games pages read — no key of its own
     * the consent order is the landing page's: the server checkout first,
       then the terms AS SHOWN recorded, then — only then — Stripe
     * the free sign-in is the Games door, configured to come back HERE, and
       Games' own default is unchanged
     * Bet Checker's checkout comes back to /bet-checker/, and the terminal's
       paywall offers Bet Checker (and, to a Bet Checker customer, the
       portal switch rather than a second checkout)
     * a card says what the database decided and nothing more: a grade with
       its edge, "Not graded" with its reason and no number, "No close
       available" out loud, the flag only when the grader set it, and every
       reader-typed string escaped

   Run: node tools/bet_checker/page.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NAV = require(path.join(ROOT, 'lib', 'edgedesk_nav.js'));
const PRICING = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
global.EDBetCheckerCore = require(path.join(ROOT, 'lib', 'edgedesk_bet_checker_core.js'));
const UI = require(path.join(ROOT, 'lib', 'edgedesk_bet_checker.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }

const PAGE = read('bet-checker/index.html');
const MOD = read('lib/edgedesk_bet_checker.js');
const APP = read('app.html');

/* ── the page ──────────────────────────────────────────────────────────── */
const nav = /<nav class="th-nav" aria-label="Main">([\s\S]*?)<\/nav>/.exec(PAGE);
const links = nav ? [...nav[1].matchAll(/<a href="([^"]+)" data-ed-nav="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[2], m[1], m[3]]) : [];
chk('the site\'s one Main nav, five links in order', JSON.stringify(links) === JSON.stringify(NAV.PRIMARY.map((x) => [x.key, x.href, x.label])), links);
const order = ['/lib/edgedesk_auth.js', '/lib/edgedesk_pricing.js', '/lib/edgedesk_access.js', '/games/lib/attribution.js', '/games/lib/social.js',
  '/games/lib/auth.js', '/lib/edgedesk_bet_checker_core.js', '/lib/edgedesk_bet_checker.js'];
const at = order.map((s) => PAGE.indexOf('<script src="' + s + '?v='));
chk('every module loads, once each, in dependency order', at.every((i) => i > 0) && at.every((i, k) => k === 0 || i > at[k - 1]) &&
  order.every((s) => PAGE.split('<script src="' + s + '?v=').length === 2), at);
chk('the stylesheets: the tools frame, the game cards, Bet Checker\'s own', ['/tools/tools.css', '/lib/edgedesk_games.css', '/lib/edgedesk_bet_checker.css']
  .every((c) => PAGE.indexOf('<link rel="stylesheet" href="' + c + '?v=') > 0));
chk('the cards are the simple game cards', /class="gm-card bc-card/.test(MOD) && /class="wrap gm-page bc"/.test(PAGE));
chk('the Supabase project comes from games/data/config.json — the page carries no key', /fetch\('\/games\/data\/config\.json'/.test(PAGE) &&
  !/eyJhbGciOi/.test(PAGE) && !/eyJhbGciOi/.test(MOD) && !/supabase\.co/.test(MOD));
const inline = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
chk('the inline boot parses', inline.length === 1 && (() => { try { new Function(inline[0]); return true; } catch (_) { return false; } })());
chk('mobile first: the viewport, and no fixed width wider than a phone (min-/max-width are fine)', /width=device-width/.test(PAGE) &&
  !/(^|[^-a-z])width:\s*(4[2-9]\d|[5-9]\d\d|\d{4,})px/.test(read('lib/edgedesk_bet_checker.css')));
chk('the page names its Settings › Subscription (the renewal terms send a reader there)', /Settings › Subscription/.test(PAGE) && /Settings \\u203a Subscription on the Bet Checker page/.test(read('lib/edgedesk_pricing.js')));
chk('the page is in the sitemap', /https:\/\/edgedesksports\.com\/bet-checker\//.test(read('sitemap-pages.xml')));

/* ── the consent, in the landing page's order ──────────────────────────── */
const iCo = MOD.indexOf('S.access.startCheckout('), iConsent = MOD.indexOf("'/rest/v1/billing_consents'"), iGo = MOD.indexOf('S.location.href = co.url');
chk('server checkout, then the consent record, then Stripe — in that order', iCo > 0 && iConsent > iCo && iGo > iConsent, [iCo, iConsent, iGo]);
chk('no consent record, no Stripe: a failed write stops before navigating', /if \(!ok\) \{[\s\S]{0,400}Nothing has been charged[\s\S]{0,200}return;\s*\}\s*S\.location\.href = co\.url/.test(MOD));
chk('the terms recorded are the element\'s text, the words the reader saw', /offer_text: terms/.test(MOD) && /var terms = \$\(host, '\[data-bc="terms"\]'\)\.textContent/.test(MOD));
chk('the terms are lib/edgedesk_pricing.js betCheckerTerms(), never typed in the page', /P\.betCheckerTerms\(S\.plan\)/.test(MOD) && !/\$7\.99/.test(PAGE) && !/\$7\.99/.test(MOD));
chk('Subscribe starts disabled; only the tick enables it', /data-bc="arl-go" disabled>/.test(PAGE) && /\$\(host, '\[data-bc="arl-go"\]'\)\.disabled = !e\.target\.checked/.test(MOD));
const T = PRICING.betCheckerTerms('monthly');
chk('the monthly terms: $7.99 per month, renews automatically, cancel anytime in Settings', /\$7\.99 per month, renews automatically/.test(T) && /Cancel anytime in Settings/.test(T) && /no free trial/i.test(T));
chk('the annual terms: $59.00 per year', /\$59\.00 per year/.test(PRICING.betCheckerTerms('annual')) && PRICING.betCheckerOffer('annual').price_cents === 5900);
chk('the figures are the lookup keys the checkout sells', PRICING.BET_CHECKER.PLANS.monthly.LOOKUP_KEY === 'bet_checker_monthly' &&
  PRICING.BET_CHECKER.PLANS.annual.LOOKUP_KEY === 'bet_checker_annual' &&
  /monthly: \{ lookup_key: 'bet_checker_monthly', interval: 'month' \}/.test(read('supabase/functions/create_checkout_session/index.ts')) &&
  /annual: \{ lookup_key: 'bet_checker_annual', interval: 'year' \}/.test(read('supabase/functions/create_checkout_session/index.ts')));
chk('after Stripe, the page asks the server until Bet Checker is confirmed (never the redirect itself)', /S\.access\.finalize\(accessCfg\(\), \{[\s\S]{0,120}until: function \(a\) \{ return !!\(a && a\.bet_checker_paid\); \}/.test(MOD));

/* ── the doors ─────────────────────────────────────────────────────────── */
const GA = read('games/lib/auth.js');
chk('the free sign-in is the Games door, configured to come back here', /configure\(S\.url, S\.key, \{ returnPath: '\/bet-checker\/', surface: 'bet_checker' \}\)/.test(MOD));
chk('and Games\' own default is unchanged', /var RETURN_PATH = '\/games\/', SURFACE = 'games_franchise';/.test(GA) && /redirect_to=' \+ encodeURIComponent\(origin\(\) \+ RETURN_PATH\)/.test(GA));
chk('a confirmation link lands here and is consumed (lib/edgedesk_auth.js)', /S\.edauth\.consume\(\{ url: S\.url, key: S\.key \}\)/.test(MOD));
chk('Bet Checker\'s checkout returns to /bet-checker/', /const back = kind === 'bet_checker' \? c\.siteUrl \+ '\/bet-checker\/'/.test(read('supabase/functions/create_checkout_session/index.ts')));
chk('the terminal\'s paywall offers Bet Checker, free', /href="\/bet-checker\/\?ref=paygate"/.test(APP));
chk('and sends a Bet Checker customer to the portal to switch, never to a second checkout', /if\(acc&&acc\.offer==='upgrade'\)\{[\s\S]{0,400}stripePortalHref\(\)/.test(APP) &&
  /Switch plan in the billing portal/.test(APP));
chk('the portal link is written once, in the pricing file', /var STRIPE_PORTAL_URL=\(window\.EDPricing&&window\.EDPricing\.PORTAL_LINK\)\|\|'';/.test(APP) &&
  /^https:\/\/billing\.stripe\.com\//.test(PRICING.portalLink()) && !/STRIPE_PORTAL_URL\s*=\s*["']https:/.test(APP));

/* ── a card says what the database decided ─────────────────────────────── */
const page = UI._make({ querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} }, { url: 'x', key: 'y', fetch: () => null });
const base = { id: 'b1', sport: 'NFL', market: 'spread', side: 'home', team: 'Kansas City Chiefs', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills',
  line: -3.5, odds: 105, book: 'DraftKings', stake_units: 1, kickoff: '2026-11-01T18:00:00Z', close_status: 'pending', result: 'pending', edgedesk_flagged: false };
let h = page.cardHTML(Object.assign({}, base, { entry_grade: 'green', entry_edge_pct: 3.22, entry_fair_price: -108 }));
chk('a green card: the grade, the edge, the fair, CLV to come', /data-grade="green"/.test(h) && /Beat fair/.test(h) && /\+3\.22 pts · fair -108/.test(h) && /CLV after the close/.test(h));
h = page.cardHTML(Object.assign({}, base, { entry_grade: 'ungraded', entry_grade_reason: 'no_fair_price_at_line', entry_edge_pct: null, entry_fair_price: null }));
chk('an ungraded card says why, and shows no number', /Not graded/.test(h) && /never estimate/.test(h) && !/pts/.test(h) && !/fair -/.test(h));
h = page.cardHTML(Object.assign({}, base, { entry_grade: 'yellow', entry_edge_pct: -0.38, entry_fair_price: -108, line: -3,
  close_status: 'no_close_available', close_reason: 'line_pulled_no_close', closing_line: -3.5, result: 'win', units_won: 0.91 }));
chk('"No close available" is on the card, with why — not hidden', /No close available/.test(h) && /different line/.test(h) && /closed at −3\.5/.test(h) && /Won \+0\.91u/.test(h));
chk('no flag badge unless the grader set it', !/EdgeDesk had this flagged/.test(h) &&
  /EdgeDesk had this flagged/.test(page.cardHTML(Object.assign({}, base, { entry_grade: 'red', edgedesk_flagged: true }))));
h = page.cardHTML(Object.assign({}, base, { team: '<img src=x onerror=alert(1)>', book: '"><script>x</script>', entry_grade: 'green', entry_edge_pct: 2, entry_fair_price: -110 }));
chk('every string is escaped', !/<img src=x/.test(h) && !/<script>x/.test(h) && /&lt;img src=x/.test(h));

/* ── the game picker says what happened to the board ───────────────────── */
/* On 2026-10-28 the board's RPC was not installed: the page said the board
   "could not be loaded" and, right under it, "No upcoming games on EdgeDesk's
   board" — a claim about the board it never read. */
function pickerAfterLoad(gamesAnswer) {
  const opt = () => ({ innerHTML: '', value: '', dataset: {} });
  const els = { game: opt(), market: opt(), side: opt(), line: opt() };
  const form = { elements: els };
  const host = { querySelector: (s) => (s === 'form[data-bc="form"]' ? form : null), querySelectorAll: () => [], addEventListener: () => {} };
  const fetch = async (url) => {
    const name = String(url).split('/rpc/')[1];
    const a = name === 'bet_checker_games' ? gamesAnswer : { status: 200, body: name === 'my_bet_checker_bets' ? { bets: [] } : null };
    return { ok: a.status < 300, status: a.status, text: async () => (a.body == null ? '' : JSON.stringify(a.body)) };
  };
  const p = UI._make(host, { url: 'x', key: 'y', fetch, auth: {}, access: {},
    social: { user: () => ({ id: 'u1' }), session: () => ({ access_token: 't' }) } });
  return p.load().then(() => els.game.innerHTML);
}
(async () => {
  let sel = await pickerAfterLoad({ status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.bet_checker_games' } });
  chk('a board that failed to load is not called empty', /could not be loaded/.test(sel) && !/No upcoming games/.test(sel), sel);
  sel = await pickerAfterLoad({ status: 200, body: [] });
  chk('a board that loaded with no games says so', /No upcoming games on EdgeDesk’s board/.test(sel), sel);
  sel = await pickerAfterLoad({ status: 200, body: [{ event_id: 'e1', sport: 'NFL', commence_time: '2026-11-01T18:00:00Z', home_team: 'Detroit Lions', away_team: 'Green Bay Packers' }] });
  chk('a board with games offers them', /Pick a game \(1\)/.test(sel) && /value="e1">Green Bay Packers at Detroit Lions/.test(sel), sel);

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'bet checker page wiring — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | the picker checks threw: ' + (e && e.stack)); process.exit(1); });
