#!/usr/bin/env node
/* ===========================================================================
   THE PERSONAL RESEARCH LAYER, WIRED — static checks, no browser, no database.

     1  THE OFFER HAS ONE SOURCE. lib/edgedesk_pricing.js states it; index.html's
        consent constants (PRICE_DISPLAY, TRIAL_DAYS, BILLING_PERIOD, recorded
        with every auto-renewal consent), app.html's SUB_PRICE_DISPLAY and every
        trial CTA's static text must agree with it, character for character.
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
/* THE ONE SOURCE: lib/edgedesk_pricing.js PLAN. Every figure below is derived
   from it, so changing the price is one edit there (after Stripe) and this
   suite then proves no page kept the old figure. */
chk('the displayed price is the plan\'s cents, formatted once', X.PRICE_DISPLAY === X.money(X.PLAN.price_cents) && /^\$\d+\.\d{2}$/.test(X.PRICE_DISPLAY), X.PRICE_DISPLAY);
chk('the CTA line is built from the plan and nothing else',
  X.CTA_LINE === X.TRIAL_DAYS + '-day free trial. ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + ' after trial. Cancel anytime.', X.CTA_LINE);
chk('the plan carries a trial, a period, a currency, a consent version and a Stripe checkout link',
  X.TRIAL_DAYS > 0 && X.BILLING_PERIOD === 'month' && X.CURRENCY === 'USD' && /^arl-/.test(X.CONSENT_VERSION) && X.validLink(X.PAYMENT_LINK) && X.validLink(X.RESUBSCRIBE_LINK));
chk('a Stripe price id, when set, is a Stripe price id', X.STRIPE_PRICE_ID === null || /^price_[A-Za-z0-9]+$/.test(X.STRIPE_PRICE_ID), X.STRIPE_PRICE_ID);
chk('the founding-member note is the plan\'s, and no availability limit is invented', X.FOUNDING === true && /keep their rate while continuously subscribed/.test(X.FOUNDING_NOTE) && X.AVAILABILITY_LIMIT === null);
/* index.html and app.html read the file; each literal after || is only the
   fallback for a page whose pricing file failed to load, and must be equal */
const fb = (src, name) => (src.match(new RegExp('var ' + name + '=\\(ED_PRICING&&ED_PRICING\\.[A-Z_]+\\)\\|\\|("?)([^";]+)\\1;')) || [])[2];
chk('index.html PRICE_DISPLAY (recorded with consent) reads the file, and its fallback matches', /var PRICE_DISPLAY=\(ED_PRICING&&ED_PRICING\.PRICE_DISPLAY\)\|\|/.test(IDX) && fb(IDX, 'PRICE_DISPLAY') === X.PRICE_DISPLAY, fb(IDX, 'PRICE_DISPLAY'));
chk('index.html TRIAL_DAYS reads the file, and its fallback matches', /var TRIAL_DAYS=\(ED_PRICING&&ED_PRICING\.TRIAL_DAYS\)\|\|/.test(IDX) && +fb(IDX, 'TRIAL_DAYS') === X.TRIAL_DAYS, fb(IDX, 'TRIAL_DAYS'));
chk('index.html BILLING_PERIOD reads the file, and its fallback matches', /var BILLING_PERIOD=\(ED_PRICING&&ED_PRICING\.BILLING_PERIOD\)\|\|/.test(IDX) && fb(IDX, 'BILLING_PERIOD') === X.BILLING_PERIOD, fb(IDX, 'BILLING_PERIOD'));
chk('index.html STRIPE_LINK reads the file, and its fallback matches', /var STRIPE_LINK=\(ED_PRICING&&ED_PRICING\.PAYMENT_LINK\)\|\|/.test(IDX) && fb(IDX, 'STRIPE_LINK') === X.PAYMENT_LINK, fb(IDX, 'STRIPE_LINK'));
chk('index.html CONSENT_VERSION reads the file, and its fallback matches', /var CONSENT_VERSION=\(ED_PRICING&&ED_PRICING\.CONSENT_VERSION\)\|\|/.test(IDX) && fb(IDX, 'CONSENT_VERSION') === X.CONSENT_VERSION, fb(IDX, 'CONSENT_VERSION'));
chk('app.html SUB_PRICE_DISPLAY reads the file, and its fallback matches',
  /var SUB_PRICE_DISPLAY=\(window\.EDPricing&&window\.EDPricing\.PRICE_DISPLAY\)\|\|"([^"]+)";/.test(APP) && (APP.match(/var SUB_PRICE_DISPLAY=\(window\.EDPricing&&window\.EDPricing\.PRICE_DISPLAY\)\|\|"([^"]+)";/) || [])[1] === X.PRICE_DISPLAY);
chk('app.html PG_STRIPE_LINK (the no-trial resubscribe link) reads the file, and its fallback matches',
  (APP.match(/var PG_STRIPE_LINK=\(window\.EDPricing&&window\.EDPricing\.RESUBSCRIBE_LINK\)\|\|'([^']+)';/) || [])[1] === X.RESUBSCRIBE_LINK);
chk('no page types the price outside the pricing file and its checked fallbacks', () => {
  const lit = new RegExp(X.PRICE_DISPLAY.replace(/[$.]/g, (c) => '\\' + c), 'g');
  const body = (src) => src.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '').replace(/data-ed-price="[a-z0-9]+">[^<]*</g, '><')
    .replace(/\|\|"\$[\d.]+"/g, '').replace(/\|\|'[^']*'/g, '');
  const stray = [['index.html', IDX], ['app.html', APP]].map((x) => [x[0], (body(x[1]).match(lit) || []).length]).filter((x) => x[1] > 0);
  return stray.length === 0 || (console.log('   stray prices:', JSON.stringify(stray)), false);
});
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
/* the offer sits under the hero buttons, so a reader sees what the free week
   becomes before any button, at every width */
chk('the hero says what follows the free week, right under its buttons',
  /id="heroStart"[\s\S]{0,400}<p class="microcta"><span><b><span data-ed-price="trial">[^<]+<\/span><\/b><\/span><span>Then <span data-ed-price="price">[^<]+<\/span>\/month<\/span><span>Cancel anytime<\/span>/.test(IDX));
chk('the in-app paywall states the trial line for a new account and promises no trial to a lapsed one',
  /fresh\?X\.CTA_LINE:X\.RESUBSCRIBE_LINE/.test(APP) && /Start 7-day free trial \\u2014 then '\+SUB_PRICE_DISPLAY\+'\/mo/.test(APP));
chk('the new-account paywall button goes through the consented trial flow', /'<a class="pg-btn" href="\.\/index\.html#subscribe">Start 7-day free trial/.test(APP));
chk('no countdown or scarcity device in the offer itself',
  ![X.CTA_LINE, X.AFTER_TRIAL_LINE, X.RESUBSCRIBE_LINE, X.PLAN_NAME, X.FOUNDING_NOTE].concat(X.INCLUDES).some((t) => /countdown|limited|hurry|expires|only \d+|spots? left/i.test(t)));

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
