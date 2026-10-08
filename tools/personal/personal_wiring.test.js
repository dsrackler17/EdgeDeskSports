#!/usr/bin/env node
/* ===========================================================================
   THE PERSONAL RESEARCH LAYER, WIRED — static checks, no browser, no database.

     1  THE OFFER HAS ONE SOURCE. lib/edgedesk_pricing.js states it — the
        price, the trial, the plan, what it includes and the Stripe payment
        links. index.html's consent constants (PRICE_DISPLAY, TRIAL_DAYS,
        BILLING_PERIOD, recorded with every auto-renewal consent) and its
        checkout link, app.html's SUB_PRICE_DISPLAY and paywall link, all READ
        it; every static copy a no-JS reader or a search engine sees (the CTAs,
        the plan card, the consent text, the JSON-LD offer) must agree with it
        character for character; and no retired price or founding-rate wording
        is left on a page a customer can read.
     2  THE SPORTSBOOKS a reader can pick are exactly the ones the capture
        function recognises (BOOK_TIER).
     3  THE PAGE LOADS THE LAYER: the stylesheet, the libraries in dependency
        order, the UI module last; the desk renders the personal sections in the
        brief's order; both game cards carry the watch star and "Log decision";
        the settings shell carries the three new sections.
     4  RESEARCH, NOT PICKS: no string in the new code is tout language.
     5  THE JOB is scheduled, reads captured quotes only, and its secrets are the
        repository's existing ones.

   Run: node tools/personal/personal_wiring.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const P = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const APP = read('app.html'), IDX = read('index.html'), UI = read('lib/edgedesk_personal_ui.js'), LIB = read('lib/edgedesk_personal.js');
const CAPTURE = read('supabase/functions/capture/index.ts');

/* ── 1 the offer ──────────────────────────────────────────────────────── */
chk('the standard price is $49.99 a month, from one number', X.PRICE_CENTS === 4999 && X.PRICE_DISPLAY === '$49.99' && X.BILLING_PERIOD === 'month' && X.CURRENCY === 'USD', X.PRICE_DISPLAY);
chk('the trial is 7 days', X.TRIAL_DAYS === 7);
chk('the plan is EdgeDesk Full Access', X.PLAN_NAME === 'EdgeDesk Full Access');
chk('the CTA line is the brief\'s own sentence', X.CTA_LINE === '7-day free trial. $49.99/month after trial. Cancel anytime.', X.CTA_LINE);
/* the consent constants are READ from the one file, never typed again */
chk('index.html PRICE_DISPLAY (recorded with consent) is read from the pricing file', /var PRICE_DISPLAY=EDP\?EDP\.PRICE_DISPLAY:'';/.test(IDX));
chk('index.html TRIAL_DAYS is read from it', /var TRIAL_DAYS=EDP\?EDP\.TRIAL_DAYS:0;/.test(IDX));
chk('index.html BILLING_PERIOD is read from it', /var BILLING_PERIOD=EDP\?EDP\.BILLING_PERIOD:'';/.test(IDX));
chk('index.html sends checkout only to the pricing file\'s trial link', /var STRIPE_LINK=EDP\?EDP\.checkoutLink\('trial'\):'';/.test(IDX)
  && !/buy\.stripe\.com\/[A-Za-z0-9]{6,}/.test(IDX), (IDX.match(/buy\.stripe\.com\/[A-Za-z0-9]{6,}/) || [])[0]);
chk('app.html SUB_PRICE_DISPLAY is read from it', /var SUB_PRICE_DISPLAY=\(window\.EDPricing&&window\.EDPricing\.PRICE_DISPLAY\)\|\|'';/.test(APP));
chk('app.html sends a lapsed reader only to the pricing file\'s resubscribe link', /var PG_STRIPE_LINK=\(window\.EDPricing&&window\.EDPricing\.checkoutLink\('resubscribe'\)\)\|\|'';/.test(APP)
  && !/buy\.stripe\.com\/[A-Za-z0-9]{6,}/.test(APP), (APP.match(/buy\.stripe\.com\/[A-Za-z0-9]{6,}/) || [])[0]);
/* NO CHECKOUT, NO CONSENT: an unconfigured or retired link stops the flow
   before a renewal consent is written, not after */
const ARL_SRC = IDX.slice(IDX.indexOf('async function confirmArl(){'), IDX.indexOf('/* #arlSubmit ships disabled'));
const iConsentWrite = ARL_SRC.indexOf("fetch(SB_URL+'/rest/v1/billing_consents'");
chk('confirmArl refuses an unconfigured checkout BEFORE it records a consent',
  ARL_SRC.indexOf('if(!PRICE_DISPLAY||!BILLING_PERIOD||!TRIAL_DAYS||!PRICE_CENTS||(!window.EDAccess&&!STRIPE_LINK))') > 0
  && ARL_SRC.indexOf('if(!PRICE_DISPLAY||!BILLING_PERIOD||!TRIAL_DAYS||!PRICE_CENTS||(!window.EDAccess&&!STRIPE_LINK))') < iConsentWrite);
/* and stronger than before: a consent is only written once a checkout EXISTS —
   the server-created session, or a valid Payment Link when the server
   function is not deployed — never for a checkout that could not be opened */
chk('confirmArl creates the checkout (server first, Payment Link fallback) BEFORE it records a consent',
  ARL_SRC.indexOf('EDAccess.startCheckout(') > 0 && ARL_SRC.indexOf('EDAccess.startCheckout(') < iConsentWrite
  && ARL_SRC.indexOf("if(!STRIPE_LINK||!/^https:\\/\\/buy\\.stripe\\.com\\/") > 0
  && ARL_SRC.indexOf("if(!STRIPE_LINK||!/^https:\\/\\/buy\\.stripe\\.com\\/") < iConsentWrite);
chk('the server is told the exact offer the consent shows, so it can refuse a different Stripe price',
  /\{kind:'trial',price_cents:PRICE_CENTS,trial_days:TRIAL_DAYS,consent_version:CONSENT_VERSION/.test(ARL_SRC));
chk('only a not-deployed / not-configured server checkout falls back to the Payment Link',
  /else if\(!co\.fallbackOk\)\{/.test(ARL_SRC));
chk('the consent version moved with the terms', /var CONSENT_VERSION="arl-2026-09-v7-trial7";/.test(IDX));
chk('the retired $79.99 links are refused by name', X.RETIRED_LINKS.length === 2 && X.RETIRED_LINKS.every((u) => X.validLink(u) === ''));
chk('a configured link, if any, is a Stripe checkout link and not a retired one',
  [X.CHECKOUT_LINK, X.RESUBSCRIBE_LINK].every((u) => u === '' || X.validLink(u) === u), [X.CHECKOUT_LINK, X.RESUBSCRIBE_LINK]);
if (!X.CHECKOUT_LINK)
  console.log('NOTE  lib/edgedesk_pricing.js has no CHECKOUT_LINK yet: the trial checkout stays closed until the $49.99 trial link is pasted there (tools/billing/verify_stripe_offer.js).');
if (!X.RESUBSCRIBE_LINK)
  console.log('NOTE  lib/edgedesk_pricing.js has no RESUBSCRIBE_LINK yet: a lapsed reader is asked to email support until the no-trial $49.99 link is pasted there.');
const ctaSpans = IDX.match(/data-ed-price="cta">([^<]+)</g) || [];
chk('the landing page carries the offer on at least four CTAs', ctaSpans.length >= 4, ctaSpans.length);
chk('every static CTA text equals the one source (no-JS readers see the same words)',
  ctaSpans.every((m) => m.replace(/^data-ed-price="cta">/, '').replace(/<$/, '') === X.CTA_LINE), ctaSpans);
chk('every static price, trial and plan text equals the one source', () => {
  const want = { price: X.PRICE_DISPLAY, trial: X.TRIAL_LABEL, plan: X.PLAN_NAME, days: String(X.TRIAL_DAYS), day8: String(X.FIRST_CHARGE_DAY), founding: X.FOUNDING_NOTE };
  const bad = [...IDX.matchAll(/data-ed-price="(price|trial|plan|days|day8|founding)">([^<]*)</g)].filter((m) => m[2] !== want[m[1]]).map((m) => m[1] + '=' + m[2]);
  return bad.length === 0 || (console.log('   drift:', bad.join(', ')), false);
});
chk('the renewal terms the customer consents to are filled from the file before they are recorded',
  /<p id="arlTerms">[\s\S]*data-ed-price="price"[\s\S]*<\/p>/.test(IDX) && /EDPricing\.apply\(document\.getElementById\('arlModal'\)\)[\s\S]{0,200}var offer=document\.getElementById\('arlTerms'\)/.test(IDX));
chk('the landing page loads the pricing file and applies it', /\/lib\/edgedesk_pricing\.js/.test(IDX) && /EDPricing\.apply\(document\)/.test(IDX));
/* every static copy of a figure a no-JS reader sees equals the one source */
const WORD = { price: X.PRICE_DISPLAY, monthly: X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD, plan: X.PLAN_NAME };
const bound = [...IDX.matchAll(/data-ed-price="(price|monthly|plan)">([^<]+)</g)];
chk('the price, the monthly figure and the plan name are bound on the landing page', bound.length >= 10, bound.length);
chk('and every bound static copy equals the one source', bound.every((m) => m[2] === WORD[m[1]]), bound.filter((m) => m[2] !== WORD[m[1]]).map((m) => m[0]));
/* the consent text is what is recorded with the consent, so its figures are
   bound and its static copy is the price */
const ARL_TERMS = (IDX.match(/<p id="arlTerms">([\s\S]*?)<\/p>/) || [])[1] || '';
chk('the renewal terms state the price three times, all bound', (ARL_TERMS.match(/data-ed-price="price">\$49\.99</g) || []).length === 3, ARL_TERMS.slice(0, 200));
chk('and promise no founding-rate lock', !/founding|locked for the life/i.test(ARL_TERMS));
/* the structured data search engines read says what the page says */
const LD = JSON.parse((IDX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1] || '{}');
const OFFER = ((LD['@graph'] || []).find((n) => n.offers) || {}).offers || {};
chk('the JSON-LD offer is $49.99 USD', OFFER.price === (X.PRICE_CENTS / 100).toFixed(2) && OFFER.priceCurrency === X.CURRENCY, OFFER);
chk('monthly', OFFER.priceSpecification && OFFER.priceSpecification.unitCode === 'MON' && OFFER.priceSpecification.price === OFFER.price, OFFER.priceSpecification);
chk('and its description is the offer', OFFER.description === X.TRIAL_DAYS + '-day free trial, then ' + X.PRICE_DISPLAY + ' per month. Cancel anytime.', OFFER.description);
/* the plan card lists exactly what the pricing file says Full Access includes */
const PCARD = (IDX.match(/<ul class="pincl">([\s\S]*?)<\/ul>/) || [])[1] || '';
const listed = [...PCARD.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
chk('the plan card lists the pricing file\'s features, in order', JSON.stringify(listed) === JSON.stringify(X.FEATURES), listed);
chk('player props are part of Full Access', X.FEATURES.indexOf('Player props') >= 0);
chk('the paywall renders the same list', /\(\(X&&X\.FEATURES\)\|\|\[\]\)\.map\(/.test(APP));
/* the offer sits under the hero button rather than in the bar, so a reader
   sees what the free week becomes before any button, at every width */
/* free research first: the line under the two hero actions says the research
   needs no card, then what the free week of Full Access becomes */
chk('the hero says what follows the free week, right under its button',
  /id="heroCta"[\s\S]{0,200}<p class="microcta"><span><b>Free research, no card<\/b><\/span><span>Full Access <span data-ed-price="trial">7 days free<\/span><\/span><span>Then <span data-ed-price="price">\$49\.99<\/span>\/month<\/span><span>Cancel anytime<\/span>/.test(IDX));
chk('the in-app paywall states the trial line for a new account and promises no trial to a lapsed one',
  /fresh\?X\.CTA_LINE:X\.RESUBSCRIBE_LINE/.test(APP) && /\(fresh\?'<a class="pg-btn" href="\.\/index\.html#subscribe">Start '\+\(X\?X\.TRIAL_DAYS:''\)\+' days free<\/a>'/.test(APP)
  && /<span class="per">then '\+stEsc\(price\)\+'\/month<\/span>/.test(APP));
chk('the new-account paywall button goes through the consented trial flow', /\(fresh\?'<a class="pg-btn" href="\.\/index\.html#subscribe">Start /.test(APP));
chk('and a new account is asked to unlock Full Access, not told it has lapsed', /:fresh\?'Unlock '\+stEsc\(SUB_PLAN_NAME\)/.test(APP));
chk('no countdown or scarcity device anywhere in the offer file', !/countdown|limited|hurry|expires/i.test(read('lib/edgedesk_pricing.js').replace(/No countdowns, no scarcity, no "limited time"/, '').replace(/nothing here counts down/, '')));

/* NO RETIRED PRICE ON ANY PAGE A CUSTOMER CAN READ. Comments are not read by
   customers and may say what the price used to be; everything else — markup,
   strings, structured data — may not. Nor may it call the price anything but
   the price: no founding rate, no introductory or limited-time figure, no
   "was" price beside it. */
const customerFacing = ['index.html', 'app.html', 'terms.html', 'research/sample/index.html',
  'lib/edgedesk_pricing.js', 'lib/edgedesk_personal_ui.js'];
const uncomment = (src) => src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
customerFacing.forEach((f) => {
  const body = uncomment(read(f));
  const stale = body.match(/\$\s?(79|39|29|24|14)\.99|\b(79|39|29|24|14)\.99\b|\b7999\b/);
  chk(f + ': no retired or historical price a customer can read', !stale, stale && body.slice(Math.max(0, stale.index - 60), stale.index + 40));
  const tout = body.match(/founding[ -]rate|founding member(ship)? (price|rate|pricing)|introductory (price|rate|offer)|limited[ -]time (price|offer)|\bwas \$\d|normally \$\d|price increase/i);
  chk(f + ': the price is never framed as a deal', !tout, tout && tout[0]);
});

/* ── 2 the books ──────────────────────────────────────────────────────── */
const tierBlock = (CAPTURE.match(/export const BOOK_TIER[^{]*\{([\s\S]*?)\};/) || [])[1] || '';
const captureBooks = [...tierBlock.matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]).sort();
const ours = P.BOOKS.map((b) => b.key).sort();
/* the capture function keeps a book's old and new keys (caesars and
   williamhill_us) and joins them through BOOK_FAMILY; one book is one chip */
const famBlock = (CAPTURE.match(/BOOK_FAMILY[^{]*\{([\s\S]*?)\};/) || [])[1] || '';
const fam = {}; [...famBlock.matchAll(/([a-z_]+)\s*:\s*"([a-z_]+)"/g)].forEach((m) => { fam[m[1]] = m[2]; });
const family = (k) => fam[k] || k;
chk('every onboarding sportsbook is a key the capture function recognises', ours.every((k) => captureBooks.indexOf(k) >= 0), ours.filter((k) => captureBooks.indexOf(k) < 0));
chk('every book the capture function recognises is offered, by family',
  captureBooks.every((k) => ours.some((o) => family(o) === family(k))), captureBooks.filter((k) => !ours.some((o) => family(o) === family(k))));
/* LowVig and BetOnline share an operator but are separate sites a reader can
   hold accounts at; Caesars under its old and new key is one book */
chk('one book is never offered twice under an old and a new key', !(ours.indexOf('caesars') >= 0 && ours.indexOf('williamhill_us') >= 0));

/* ── 3 the page ───────────────────────────────────────────────────────── */
const at = (s) => APP.indexOf(s);
chk('the stylesheet is linked in the head', at('/lib/edgedesk_personal.css') > 0 && at('/lib/edgedesk_personal.css') < at('</head>'));
chk('research_core loads before the personal library, which loads before the UI module',
  at('/lib/research_core.js') > 0 && at('/lib/research_core.js') < at('/lib/edgedesk_personal.js') && at('/lib/edgedesk_personal.js') < at('/lib/edgedesk_personal_ui.js'));
chk('the UI module loads after the session helpers', at('/lib/edgedesk_personal_ui.js') > at('/lib/edgedesk_auth.js'));
chk('the desk renders the personal top sections before the board and the bottom ones after it',
  /\+\(mine\?window\.EDMine\.deskHTML\('top'\):''\)\s*\+'<div class="dk-h">Active research opportunities/.test(APP)
  && /\+opsHtml\s*\+\(mine\?window\.EDMine\.deskHTML\('bottom'\):''\)/.test(APP));
chk('both game cards carry the watch star and Log decision', (APP.match(/fbMineActs\('(p4|nfl)',g\.game_id/g) || []).length === 2 && /function fbMineActs\(/.test(APP));
chk('the reading-order rows carry the watch star', /window\.EDMine\.starHTML\(c\.board,c\.gid/.test(APP));
chk('the football module exports the research states', /window\.fbResearchStates=function\(\)/.test(APP) && /function fbResearchStateOf\(r,c,x,ix\)/.test(APP));
['research', 'researchalerts', 'partner'].forEach((id) => chk('settings has the ' + id + ' section', new RegExp("\\{id:'" + id + "'").test(APP)));
chk('the notifications page no longer says research alerts are impossible', /In-app research alerts/.test(APP));
chk('the privacy page says where the watchlist and journal live', /Watchlist, research journal, research alerts/.test(APP));

/* ── 4 research, not picks ────────────────────────────────────────────── */
function strings(src) {
  const out = [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  const rx = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let m; while ((m = rx.exec(code))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}
const TOUT = /\b(bet this|locks?|lock of|guaranteed?|smash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing|hammer)\b/i;
const uiBad = strings(UI).filter((s) => TOUT.test(s));
chk('no tout language in the UI module\'s strings', uiBad.length === 0, uiBad);
const libBad = strings(LIB).filter((s) => TOUT.test(s) && !/bet this\|/.test(s));
chk('no tout language in the library\'s strings (the banned-words list itself excepted)', libBad.length === 0, libBad);
chk('the copy rule refuses tout language', ['BET THIS', 'LOCK', 'GUARANTEED', 'SMASH', 'MUST BET'].every((t) => !P.copyOk(t)));
chk('the UI never renders a profit or ROI figure', !/profit|\broi\b|units won|bankroll up/i.test(strings(UI).join('\n')));

/* ── 5 the job ────────────────────────────────────────────────────────── */
const WF = read('.github/workflows/research-state.yml');
chk('the job is scheduled hourly', /cron: '38 \* \* \* \*'/.test(WF));
chk('its secrets are the repository\'s existing ingestion secrets', /secrets\.SB_URL/.test(WF) && /secrets\.SB_SERVICE_ROLE/.test(WF) && !/ODDS_API_KEY/.test(WF));
chk('the tests run before it may write', WF.indexOf('personal.test.js') < WF.indexOf('research_state.js --network'));
const JOB = read('tools/personal/research_state.js');
chk('the job\'s board reader allows GET on the capture tables only', /READ_ALLOW = \[\/\^signals\\\?\/, \/\^book_quotes\\\?\/, \/\^lines\\\?\/, \/\^games\\\?\/\]/.test(JOB));
chk('the job never calls the odds provider', !/the-odds-api|api\.the-odds|ODDS_API/i.test(JOB));
chk('the SQL files follow the folder convention', ['personal_research.sql', 'affiliates.sql'].every((f) => {
  const s = read('supabase/' + f); return !/^\\/m.test(s) && /CHECK THIS/.test(s) && /notify pgrst/.test(s);
}));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'personal wiring — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
