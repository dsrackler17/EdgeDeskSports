#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — positioning and honesty.

   The page tells one story — problem, product, see it, understand it, trust
   it, try it — and a first-time reader should be able to answer six
   questions from it in half a minute: what EdgeDesk is, what it gives them,
   whether it sells picks, why it is useful, why to trust it, and what it
   costs. These tests hold those answers on the page, and hold the line on
   what a marketing page is never allowed to say:

     1  the hero answers the first-screen questions, price included;
     2  the product visual is the product, in the canonical vocabulary;
     3  nothing anywhere promises profit, and no tout word appears;
     4  no metric is claimed that EdgeDesk cannot prove;
     5  live numbers are READ from the committed artifacts, never typed in;
     6  the sections, the coverage and the EV language say the same thing;
     7  navigation and CTAs: one primary action, stated one way;
     8  pricing is one plan, stated plainly, with no scarcity device;
     9  it stays a static page;
    10  a publisher that cites EdgeDesk is credited as exactly that;
    11  responsible-gambling language and the legal links survive;
    12  search and social metadata describe the product that exists.

   Run: node tools/presentation/landing_positioning.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 200); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function plain(h) {
  return String(h).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&minus;/g, '-').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');
}
const TEXT = plain(IDX);
/* one element by id, through its closing tag (sections nest nothing of their own kind) */
function section(id, tag) {
  const a = IDX.indexOf('id="' + id + '"');
  if (a < 0) return '';
  const open = IDX.lastIndexOf('<', a);
  return IDX.slice(open, IDX.indexOf('</' + (tag || 'section') + '>', a));
}

/* ======================================================================== */
/* 1. THE HERO ANSWERS THE FIRST-SCREEN QUESTIONS                           */
/* ======================================================================== */
const HERO = section('top', 'header');
chk('the hero is found', HERO.length > 1500);
has(HERO, 'Research the matchup.', 'what EdgeDesk does, line one');
has(HERO, 'Then price it.', 'and line two');
has(HERO, 'Football research terminal', 'the category is named');
has(HERO, 'NFL + FBS', 'and the scope');
has(HERO, 'the model, the market, the matchup, the roster, the players and the uncertainty', 'the layers are named in one sentence');
has(HERO, 'Instead of', 'what it replaces is stated');
['10 tabs', '5 sites', 'a spreadsheet', 'guessing what mattered'].forEach(t => has(HERO, t, 'it replaces ' + t));
has(HERO, 'id="heroStart"', 'the primary CTA keeps the id bootAuthState rewrites');
chk('the primary CTA is "Start 7 days free"', /id="heroStart"[^>]*>Start 7 days free/.test(HERO));
chk('the secondary CTA is "See a game" and goes to the game', /href="#game"[^>]*>See a game</.test(HERO));
/* the offer sits directly under the button — nobody hunts for what the trial becomes */
const OFFER = (HERO.match(/<p class="microcta">([\s\S]*?)<\/p>/) || [])[1] || '';
chk('the hero offer line is found', OFFER.length > 40);
['Full access for 7 days', '$79.99', '/month', 'Cancel anytime', '21+'].forEach(t => has(OFFER, t, 'the hero offer states ' + t));
chk('the hero offer is the first .microcta, the one bootAuthState rewrites for an unpaid account', () => {
  const first = IDX.search(/class="microcta"/), a = IDX.indexOf('<header class="hero"'), b = IDX.indexOf('</header>');
  return first > a && first < b;
});
lacks(HERO, 'Which betting lines', 'the old cross-sport positioning is gone');
lacks(TEXT, 'golf', 'and no golf copy is left anywhere a reader can see');
lacks(IDX, 'golf, MLB, WNBA, CFB, CBB', 'nor the sport list the hero once carried');

/* ======================================================================== */
/* 2. THE PRODUCT IS THE VISUAL                                             */
/* ======================================================================== */
['Baylor @ Auburn', 'EdgeDesk line', 'Market', 'Difference', 'Projected score', 'Win probability',
 'EdgeDesk EV', 'EdgeDesk prob.', 'Break-even', 'Fair odds', 'Research check']
  .forEach(f => has(HERO, f, 'the hero card shows "' + f + '"'));
has(HERO, 'Illustrative game', 'the hero card says the game is illustrative, in its own chrome');
/* the canonical research status, and one the product would actually give it */
const Canon = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
const heroModel = +((HERO.match(/EdgeDesk line<\/span><span class="v mdl">Auburn &minus;([\d.]+)/) || [])[1]);
const heroMkt = +((HERO.match(/Market<\/span><span class="v">Auburn &minus;([\d.]+)/) || [])[1]);
const heroStatus = (HERO.match(/<span class="st [a-z]+">([A-Z ]+)<\/span>/) || [])[1];
chk('the hero states a model number and a market number that differ', heroModel > 0 && heroMkt > 0 && heroModel !== heroMkt, [heroModel, heroMkt]);
chk('the stated difference is model minus market', new RegExp('Difference</span><span class="v warn">' + (heroModel - heroMkt).toFixed(1) + ' pts').test(HERO));
chk('the hero research status is the one lib/edgedesk_canon.js gives that gap', () => {
  const s = Canon.researchStatus({ projected: true, market: 'FRESH', gap: heroModel - heroMkt, confidence: 72, fair_margin: heroModel });
  return s.label === heroStatus;
}, heroStatus);
chk('the hero research status is a canonical label', Object.keys(Canon.RESEARCH_STATUS).some(k => Canon.RESEARCH_STATUS[k].label === heroStatus), heroStatus);
lacks(IDX, '>REVIEW<', 'the retired REVIEW synonym stays retired');
chk('the research check shows knowns AND unknowns',
  /class="ck ok"/.test(HERO) && /class="ck warn"/.test(HERO) && /class="ck neg"/.test(HERO));
has(HERO, 'starting QB', 'including the quarterback it does not know');
has(HERO, 'move no line until they clear validation', 'the hero discloses the unvalidated layers');
has(HERO, 'Nothing here tells you what to bet', 'and that the card is not a bet');

/* ======================================================================== */
/* 3. NO TOUT LANGUAGE, ANYWHERE ON THE PAGE                                */
/* ======================================================================== */
/* A page that REFUSES to promise profit has to be able to say the words it
   refuses ("no locks", "does not guarantee profit"). So: find every
   occurrence and fail only on one that is not negated. */
const NEG = /\b(?:not|never|no|nobody|nothing|without|refus\w*|cannot|can't|doesn't|does not|isn't|won't)\b[^.]{0,60}$/i;
function claimsIt(re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; const offenders = [];
  while ((m = g.exec(TEXT))) {
    const before = TEXT.slice(Math.max(0, m.index - 70), m.index);
    if (NEG.test(before)) continue;
    /* a question the FAQ asks and answers "No" is not a claim */
    const rest = TEXT.slice(m.index, m.index + 140), stop = rest.search(/[.?!]/);
    if (stop >= 0 && rest[stop] === '?') continue;
    offenders.push('…' + before.slice(-46) + '[' + m[0] + ']');
  }
  return offenders;
}
[/\bLOCKS?\b/i, /\bbest bet\b/i, /\bcan'?t miss\b/i, /\bsure thing\b/i, /\bguaranteed win/i, /\bguaranteed profit/i,
 /\bmortal lock\b/i, /\bfree money\b/i, /\bnever lose\b/i, /\bwe'?ll make you money\b/i, /\bprofit guarantee/i,
 /\bSMASH\b/i, /\bHAMMER\b/i, /\bmax (?:bet|play)\b/i, /\bbet this\b/i, /\bsharp money\b/i, /\bsmart money\b/i,
 /\bsteam\b/i, /\bwait for sharps\b/i]
  .forEach(re => { const o = claimsIt(re);
    chk('no tout phrase is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
[/\bguarantee[sd]? (?:you )?(?:a )?(?:profit|win|return)/i, /\bwin rate of\b/i, /\broi of\b/i, /\bprofit(?:able)? every\b/i]
  .forEach(re => { const o = claimsIt(re);
    chk('no profit promise is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
/* the honest half: the denials themselves are on the page */
has(TEXT, 'does not guarantee profit', 'the page says EV does not guarantee profit');
has(TEXT, 'no picks, no locks, no guaranteed winners', 'and lists what it will never sell');
/* generic SaaS sludge is not how this product talks */
[/\brevolutionary\b/i, /\bcutting-edge\b/i, /\bnext-generation\b/i, /\bAI-powered\b/i, /\bunlock your\b/i,
 /\belevate your\b/i, /\bgame-?changing\b/i, /\bultimate platform\b/i, /\bseamless\b/i]
  .forEach(re => chk('no marketing sludge: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));

/* ======================================================================== */
/* 4. NO UNPROVABLE CLAIMS                                                  */
/* ======================================================================== */
[/\b\d[\d,]* (?:happy )?(?:customers|subscribers|members|users) (?:trust|use|love)/i,
 /\btestimonial/i, /\bas seen on\b/i, /\b\d+% win rate\b/i, /\bunits? (?:won|profit)\b/i, /\bmade \$[\d,]+/i]
  .forEach(re => chk('no unprovable claim ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('structured data claims no rating and no review', !/aggregateRating|"review"/i.test(IDX));

/* ======================================================================== */
/* 5. LIVE NUMBERS COME FROM THE ARTIFACTS, NOT THE SOURCE                  */
/* ======================================================================== */
has(IDX, "fetch('football/rankings/current.json'", 'the power ratings load from the committed artifact');
has(IDX, "fetch('football/players/current.json'", 'and the player counts too');
has(IDX, 'id="lpRatings"', 'the ratings host exists');
has(IDX, 'id="lpPlayers"', 'the player-count host exists');
has(IDX, 'id="lpTeams"', 'the team-count host exists');
chk('the ratings board is not frozen into the markup',
  !/Notre Dame|Ohio State|Indiana|Georgia|Oregon|Texas Tech/.test(IDX.slice(IDX.indexOf('id="lpRatings"'), IDX.indexOf('id="lpRatings"') + 600)));
chk('and neither is a player count', !/15,?488|15,?984/.test(IDX));
/* a team name is ESCAPED, not stripped: stripping rendered Texas A&M as
   "Texas AM" on a page whose argument is that it does not distort the product */
chk('team names are escaped rather than stripped',
  /function esc\(v\)\{ return String\(v\)\.replace\(\/\[&<>"\]\/g/.test(IDX)
  && !/String\(t\.team\)\.replace\(\/\[&<>"\]\/g,''\)/.test(IDX));
chk('a failed artifact read leaves the honest fallback', /\.catch\(function\(\)\{\}\)/.test(IDX));
chk('nothing ranked leaves the fallback rather than an empty board', /if\(!teams\.length\) return;/.test(IDX));
const RK = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
const PQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'current.json'), 'utf8'));
chk('the rankings artifact has a ranked board to read',
  Object.keys(RK.teams || {}).some(k => RK.teams[k] && RK.teams[k].rank != null && RK.teams[k].etsr != null));
chk('the players artifact has the counts the page asks for',
  typeof PQ.player_count === 'number' && typeof PQ.team_count === 'number', JSON.stringify({ p: PQ.player_count, t: PQ.team_count }));
/* the live record and the live activity line are read, never written in */
has(IDX, 'id="proofInner"', 'the public record panel is filled from the database');
has(IDX, 'id="lpLive"', 'the live-activity line exists');
chk('and it stays empty until the database returns a real count', /<p class="live" id="lpLive"[^>]*><\/p>/.test(IDX));
chk('with its line reserved, so the hero does not jump when it fills', /\.live\{[^}]*min-height:17px/.test(IDX));

/* ======================================================================== */
/* 6. ONE STORY, ONE VOCABULARY                                             */
/* ======================================================================== */
const ORDER = ['top', 'difference', 'how', 'tabs', 'product', 'game', 'ev', 'trust', 'record', 'who', 'pricing', 'faq', 'start'];
ORDER.forEach(id => has(IDX, 'id="' + id + '"', 'the ' + id + ' section exists'));
chk('the sections run problem → product → see it → understand it → trust it → try it',
  ORDER.every((id, i) => i === 0 || IDX.indexOf('id="' + id + '"') > IDX.indexOf('id="' + ORDER[i - 1] + '"')));
chk('the page is a short read: at most 14 top-level blocks',
  (IDX.match(/<section\b/g) || []).length <= 13, (IDX.match(/<section\b/g) || []).length);
/* not a picks service */
const NP = section('difference');
has(NP, 'Not picks. A research terminal.', 'the difference is one line');
has(NP, 'A picks service', 'and set against a picks service');
has(NP, '&ldquo;Take Auburn &minus;8.&rdquo;', 'which gives an answer');
['Why the model differs', 'What could make it wrong', 'How sensitive the edge is to price', 'What happens if the line moves']
  .forEach(t => has(NP, t, 'while EdgeDesk shows ' + t));
has(NP, 'EdgeDesk gives you what you need to judge the price', 'and the decision is handed back');
/* three steps */
const HOW = section('how');
['Find the game', 'Research the edge', 'Price the bet'].forEach(t => has(HOW, t, 'the workflow step ' + t));
chk('exactly three steps', (HOW.match(/class="step\b/g) || []).length === 3);
/* the ten tabs */
const TABS = section('tabs');
has(TABS, 'The information already exists. Assembling it is the expensive part.', 'the ten-tabs line survives');
chk('ten sources on the left', (TABS.match(/<span>[A-Z][^<]{2,20}<\/span>/g) || []).length >= 10);
has(TABS, 'One matchup page.', 'one page on the right');
/* six features, no more */
const PROD = section('product');
chk('the feature grid is six cards', (PROD.match(/<article class="feat/g) || []).length === 6);
has(PROD, 'EdgeDesk EV + price', 'one of them is EdgeDesk EV');
chk('each card is a heading and a sentence or two, not an essay',
  (PROD.match(/<p>([^<]|<[^/])*?<\/p>/g) || []).every(p => plain(p).split(/[.!?](\s|$)/).filter(s => s.trim().length > 3).length <= 2));
/* coverage: football, and only football */
[/\bevery sport\b/i, /\ball sports\b/i, /\bMLB\b/, /\bNBA\b/, /\bWNBA\b/, /\btennis\b/i, /\bUFC\b/, /\bbaseball\b/i, /\bgolf/i]
  .forEach(re => chk('coverage is never overstated: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
has(TEXT, 'the NFL and NCAA FBS', 'the FAQ names the coverage exactly');
/* uncertainty is stated as a behaviour, not a disclaimer */
has(IDX, 'carried as unknown, never as healthy', 'unknown is not healthy');
has(IDX, 'A stale price is not compared', 'a stale market is not a price');
has(IDX, 'Layers that have not cleared validation move no line', 'the unvalidated layers move no line');
/* EdgeDesk EV, named one way and explained once in plain English */
[/\bEV Engine\b/, /\bBet EV\b/, /\bExpected Value Tool\b/i, /\bEdge Calculator\b/i, /\bValue Score\b/i]
  .forEach(re => chk('EdgeDesk EV is never renamed: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('EdgeDesk EV is named throughout', (TEXT.match(/EdgeDesk EV/g) || []).length >= 8, (TEXT.match(/EdgeDesk EV/g) || []).length);
has(IDX, 'Expected value estimates the theoretical return of repeatedly taking the same price if EdgeDesk&rsquo;s probability is accurate',
  'expected value is explained once, in plain English');
const EV = section('ev');
has(EV, 'A good number at a bad price is still a bad price.', 'the EV section leads with the idea');
has(EV, 'The game didn&rsquo;t change. The price did.', 'the price-sensitivity idea survives');
has(EV, 'raw and calibrated EV are shown separately', 'raw and calibrated EV are never merged');
has(EV, 'It runs in shadow', 'the EV policy is disclosed as shadow');
has(EV, 'none is presented as a bet', 'so a qualifying price is never sold as a bet');
has(EV, 'Most prices don&rsquo;t qualify', 'and PASS is presented as the normal answer');
has(EV, 'MAX EV is not a recommendation', 'MAX EV is labelled for what it is');
has(IDX, 'Auburn &minus;8 at &minus;105 and Auburn &minus;8 at &minus;130 are economically different bets',
  'the FAQ says why the model spread is not enough');

/* ======================================================================== */
/* 7. NAVIGATION AND THE ONE PRIMARY ACTION                                 */
/* ======================================================================== */
const NAV = section('nav', 'nav');
chk('the site nav is found', NAV.length > 400);
['Product', 'How it works', 'Record', 'Pricing'].forEach(l => has(NAV, '>' + l + '<', 'the nav offers ' + l));
chk('the nav CTA is "Start 7 days free"', /id="navSignup"[^>]*>Start 7 days free</.test(NAV));
has(NAV, 'id="navLogin"', 'and Log in keeps the id bootAuthState rewrites');
lacks(NAV, 'class="navprice"', 'the bar carries no price badge — the offer sits under the hero button');
chk('the phone menu is a real disclosure', /aria-controls="navMenu"/.test(NAV) && /aria-expanded="false"/.test(NAV));
/* every trial button says the same thing */
const TRIAL = [...IDX.matchAll(/<button\b[^>]*onclick="startSubscribe\(\)"[^>]*>([^<]*)/g)].map(m => m[1].trim());
chk('four trial buttons: nav, hero, pricing, close', TRIAL.length === 4, TRIAL.join(' | '));
chk('and every one of them says "Start 7 days free"', TRIAL.every(t => t === 'Start 7 days free'), TRIAL.join(' | '));
[/>\s*Start researching/, />\s*Get started/i, />\s*Join now/i, />\s*Unlock/i, />\s*Try EdgeDesk/i, />\s*Subscribe\b/i, />\s*Begin research/i]
  .forEach(re => chk('no competing CTA verb: ' + re, !re.test(IDX), (re.exec(IDX) || [])[0]));

/* ======================================================================== */
/* 8. PRICING IS ONE PLAN, STATED PLAINLY                                   */
/* ======================================================================== */
const PRICE = section('pricing');
chk('one plan card', (IDX.match(/class="pcard\b/g) || []).length === 1);
has(PRICE, '$79.99', 'the price is stated');
has(PRICE, '7 days free', 'the trial is stated');
has(PRICE, 'id="subscribe"', 'the #subscribe anchor app.html sends people to is here');
lacks(PRICE, 'Only $79.99', 'and never apologised for');
lacks(TEXT, 'worth every penny', 'no worth-every-penny copy');
chk('no crossed-out price', !/<(?:s|del|strike)>\s*\$/.test(IDX) && !/line-through[^}]*\$/.test(IDX));
[/\bcountdown\b/i, /\blimited time\b/i, /\bhurry\b/i, /\bonly \d+ (?:spots|seats|left)\b/i, /\bexpires? (?:soon|tonight|today)\b/i]
  .forEach(re => { const o = claimsIt(re); chk('no scarcity device: ' + re, o.length === 0, o.join(' || ')); });
['NFL + FBS', 'EdgeDesk EV', 'Simulations', 'EdgeDesk power ratings', 'public record', 'research briefs', 'Matchup, roster and player research']
  .forEach(f => has(PRICE, f, 'the plan includes ' + f));
has(PRICE, 'Nothing charged until day 8', 'the trial mechanics are stated');
has(PRICE, 'Cancel anytime before renewal', 'and so is cancelling');
has(PRICE, 'We email you', 'and the reminder before conversion');
has(PRICE, 'id="edOffer" hidden', 'a creator discount is only ever Stripe\'s own record');

/* ======================================================================== */
/* 9. IT STAYS A STATIC PAGE                                                */
/* ======================================================================== */
chk('the landing page loads no application bundle', !/src="app\.js|src="\/app\.|import\s+.*from\s+['"]https?:/.test(IDX));
chk('it makes exactly the two artifact reads', (IDX.match(/fetch\('football\//g) || []).length === 2,
  'found ' + (IDX.match(/fetch\('football\//g) || []).length);
chk('no edge function was added for the landing page', !/functions\/v1\/[a-z_]*landing/.test(IDX));
chk('the only third-party script is the existing Google tag',
  [...IDX.matchAll(/<script[^>]*src="(https?:[^"]+)"/g)].every(m => /^https:\/\/www\.googletagmanager\.com\//.test(m[1])));

/* ======================================================================== */
/* 10. FEATURED IN — MEDIA ATTRIBUTION, STATED EXACTLY                      */
/* ======================================================================== */
/* Stadium Rant's writers cite EdgeDesk's numbers in articles they write and
   publish on their own site. That is the whole claim, and it is the kind of
   claim that rots upward: "featured in" becomes "partner of" becomes
   "official partner of" a couple of well-meaning edits later. */
const MED = (function () {
  const a = IDX.indexOf('id="featured"');
  if (a < 0) return '';
  const note = IDX.indexOf('class="press-note"', a);
  return IDX.slice(IDX.lastIndexOf('<', a), note < 0 ? a : IDX.indexOf('</p>', note) + 4);
})();
chk('the featured-in block exists', MED.length > 800, 'length ' + MED.length);
chk('and it sits inside the trust section', IDX.indexOf('id="featured"') > IDX.indexOf('id="trust"') && IDX.indexOf('id="featured"') < IDX.indexOf('id="record"'));
has(MED, 'Featured in Stadium Rant', 'the publisher is named');
has(MED, 'independent matchup coverage published by <b>Stadium Rant</b>', 'as the publisher of that coverage, not as a partner');
has(MED, 'Stadium Rant is an independent publisher', 'the publisher is called independent');
has(MED, 'editorial attribution, not a partnership, a sponsorship or a syndication deal', 'and the relationship is named by what it is not');
has(MED, 'EdgeDesk has no say in what they publish', 'and the coverage is not EdgeDesk\'s to steer');
has(MED, 'Data and model analysis powered by EdgeDeskSports.com', 'the credit is quoted in the publisher\'s own words');
[/\bofficial partner\b/i, /\bstadium rant partner\b/i, /\bsponsored by\b/i, /\bin partnership with\b/i, /\bpartnered with\b/i,
 /\bour partner\b/i, /\bexclusive partner/i, /\bas seen (?:in|on)\b/i, /\bmedia partner\b/i]
  .forEach(re => chk('the relationship is never inflated to ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
[['https://www.stadiumrant.com/akron-wake-forest-odds-value-edgedesk/',
  'Akron vs. Wake Forest Odds: Why the Numbers Flag Value on the Zips at +2000 (Data by EdgeDesk)'],
 ['https://www.stadiumrant.com/patriots-vs-seahawks-odds-the-numbers-say-seattle-should-be-favored-by-almost-a-touchdown/',
  'Patriots vs. Seahawks Odds: The Numbers Say Seattle Should Be Favored by Almost a Touchdown']]
  .forEach(a => { has(MED, a[0], 'the block links ' + a[1].slice(0, 28));
                  has(MED, a[1], 'under the headline the publisher gave it'); });
chk('each card is bylined to the publisher rather than to EdgeDesk',
  (MED.match(/Published by <b>Stadium Rant<\/b>/g) || []).length === 2);
chk('and each credits EdgeDesk as the data underneath, not as the author',
  /class="cr">Data by EdgeDesk/.test(MED) && /class="cr">Powered by EdgeDesk research/.test(MED));
chk('every stadiumrant.com link opens in a new tab with the opener severed', () => {
  const links = [...IDX.matchAll(/<a\b[^>]*href="https:\/\/www\.stadiumrant\.com[^"]*"[^>]*>/g)].map(m => m[0]);
  return links.length >= 2 && links.every(t => /target="_blank"/.test(t) && /rel="noopener noreferrer"/.test(t));
});
chk('and each card says which site it is about to open', (MED.match(/Read on stadiumrant\.com/g) || []).length === 2);
chk('the publisher is named only in that block, never sprinkled through the page', () => {
  const all = (TEXT.match(/Stadium Rant/g) || []).length;
  const inside = (plain(MED).match(/Stadium Rant/g) || []).length;
  return all === inside;
});
lacks(TEXT, 'writers across the industry', 'and no imaginary contributor network is claimed');

/* ======================================================================== */
/* 11. RESPONSIBLE GAMBLING AND THE LEGAL LINKS                             */
/* ======================================================================== */
chk('21+ is stated at the offer, the price card and the close', (TEXT.match(/21\+/g) || []).length >= 4);
chk('1-800-GAMBLER is on the page more than once', (TEXT.match(/1-800-GAMBLER/g) || []).length >= 3);
has(IDX, 'ncpgambling.org', 'and the national resource is linked');
has(TEXT, 'Research, not picks', 'research, not picks');
has(TEXT, 'Research and decision-support tool', 'and the product is named for what it does: research and decision support');
lacks(TEXT, 'never tells you what to bet', 'and never claims EdgeDesk makes no decision, beside a product that says BET, LEAN, WATCH or PASS');
['/terms.html', '/privacy.html', '/disclaimer.html'].forEach(h => has(IDX, 'href="' + h + '"', 'the footer links ' + h));
has(IDX, 'data-ed-report', 'a visitor can report a problem');

/* ======================================================================== */
/* 12. SEARCH AND SOCIAL                                                    */
/* ======================================================================== */
has(IDX, '<title>EdgeDesk Sports | Football Research Terminal</title>', 'the title names the category');
const DESC = (IDX.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '';
chk('the description is search-length', DESC.length >= 110 && DESC.length <= 160, DESC.length);
chk('and names what it researches', /NFL/.test(DESC) && /college football/.test(DESC) && /Research, not picks/.test(DESC));
has(IDX, '<link rel="canonical" href="https://edgedesksports.com/">', 'the canonical URL is the root');
['og:title', 'og:description', 'og:url', 'og:type', 'twitter:card', 'twitter:title', 'twitter:description']
  .forEach(k => chk('social metadata: ' + k, new RegExp('(property|name)="' + k + '" content="[^"]{5,}"').test(IDX)));
chk('the structured data parses and offers the price consent records', () => {
  const j = JSON.parse((IDX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]);
  const app = j['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  const price = (IDX.match(/var PRICE_DISPLAY="\$([\d.]+)"/) || [])[1];
  return app && app.offers && app.offers.price === price && app.offers.priceCurrency === 'USD';
});

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding positioning: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
