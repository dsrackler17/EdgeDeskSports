#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — positioning and honesty.

   The page sells ONE idea in five seconds — "one football research terminal
   for the game, the market and the players" — and then shows it working on
   the current slate. A first-time reader should be able to answer, from the
   first screen: what EdgeDesk does (prices football games and players, sets
   its numbers beside the market's, shows why and at what price), whether it
   sells picks (no), and what it costs. These tests hold those answers on the
   page, and hold the line on what a marketing page is never allowed to say:

     1  the hero: the headline, the subhead, the two actions, the offer under
        them, and live statistics that are hidden until the database answers;
     2  the live research preview and the board are READ, never typed in, and
        fall back to an example that says it is one;
     3  player props are part of the product everywhere it is described —
        the hero, the board, the workflow, their own section, the plan, the
        FAQ — and only factors the prop model actually uses are listed;
     4  four public words (RESEARCH / WATCH / PASS / DATA INCOMPLETE; the
        landing board lists only the first three), never a pick, and nothing
        anywhere promises profit;
     5  no metric is claimed that EdgeDesk cannot prove;
     6  the hierarchy: hero, board, workflow, props, difference, product,
        trust, who, pricing, FAQ, close — each said once;
     7  navigation and the trial buttons, stated one way;
     8  pricing is one plan, read from lib/edgedesk_pricing.js, with no
        scarcity device;
     9  the process is the trust headline: nothing disappears after kickoff;
    10  a publisher that cites EdgeDesk is credited as exactly that;
    11  responsible-gambling language and the legal links survive;
    12  search and social metadata describe the product that exists;
    13  the technical explanation lives on /methodology/, linked from here.

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
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
function plain(h) {
  return String(h).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<template[\s\S]*?<\/template>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&minus;/g, '-').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');
}
const TEXT = plain(IDX);
function section(id, tag) {
  const a = IDX.indexOf('id="' + id + '"');
  if (a < 0) return '';
  const open = IDX.lastIndexOf('<', a);
  return IDX.slice(open, IDX.indexOf('</' + (tag || 'section') + '>', a));
}
/* the presentation script: everything after the preserved production block */
const LANDING = (function () {
  const a = IDX.indexOf('LANDING PAGE INTERACTIONS');
  return a < 0 ? '' : IDX.slice(a, IDX.indexOf('</script>', a));
})();

/* ======================================================================== */
/* 1. THE HERO                                                              */
/* ======================================================================== */
const HERO = section('top', 'header');
chk('the hero is found', HERO.length > 1500);
has(HERO, 'NFL + CFB research terminal', 'the eyebrow names the category and the scope');
has(HERO, 'Find where the model and the market <span class="g">disagree.</span>', 'the headline says what EdgeDesk finds');
has(HERO, 'EdgeDesk analyzes every NFL and FBS matchup, compares its fair numbers with live sportsbook markets, and brings <b>game lines, player props, matchup research and uncertainty</b> into one terminal.',
  'the subhead: prices games, compares with the market, props included, one terminal');
chk('the primary action is "Explore today\'s board" and goes to the live board',
  /<a class="btn primary lg" id="heroBoard" href="#today"[^>]*>Explore today&rsquo;s board/.test(HERO));
chk('the secondary action is "Start free trial" through the consented trial flow',
  /<button type="button" class="btn ghost lg" id="heroStart" onclick="startSubscribe\(\)"[^>]*>Start free trial</.test(HERO));
/* the offer sits directly under the buttons — nobody hunts for what the trial becomes */
const OFFER = (HERO.match(/<p class="microcta">([\s\S]*?)<\/p>/) || [])[1] || '';
chk('the hero offer line is found', OFFER.length > 40);
['data-ed-price="trial">7 days free', '$49.99', '/month', 'Cancel anytime', '21+'].forEach(t => has(OFFER, t, 'the hero offer states ' + t));
chk('the hero offer is the first .microcta, the one bootAuthState rewrites for an unpaid account', () => {
  const first = IDX.search(/class="microcta"/), a = IDX.indexOf('<header class="hero"'), b = IDX.indexOf('</header>');
  return first > a && first < b;
});
/* live statistics: five, each hidden until the database returns it */
const STATS = (HERO.match(/<ul class="stats" id="lpStats"[\s\S]*?<\/ul>/) || [''])[0];
['games_analyzed', 'research', 'props_tracked', 'sportsbook_quotes', 'updated'].forEach(k =>
  chk('the statistic ' + k + ' exists and ships hidden', new RegExp('<li data-k="' + k + '"[^>]*hidden>').test(STATS)));
['games analyzed', 'research-grade opportunities', 'player props tracked', 'sportsbook quotes', 'Updated'].forEach(t => has(STATS, t, 'the statistic reads "' + t + '"'));
chk('no statistic carries a number in the markup — they are READ', !/<b>\s*[\d,]+\s*<\/b>/.test(STATS) && !/\d+\s*(?:games|props|quotes)/.test(plain(STATS)));
chk('the statistics are filled only from the view model, and a missing one stays hidden',
  /function renderStats\(V\)/.test(LANDING) && /if\(v\)\{ li\.querySelector\('b'\)\.textContent=v; li\.hidden=false; \} else li\.hidden=true;/.test(LANDING));

/* ======================================================================== */
/* 2. LIVE, NOT TYPED IN                                                    */
/* ======================================================================== */
has(HERO, 'id="lpPreview"', 'the live research preview is in the hero');
has(HERO, 'EdgeDesk &middot; Research', 'and names itself');
chk('the preview ships as a skeleton, not as numbers', /class="prev-body loading" id="lpPrevBody"/.test(HERO) && /class="prev-skel"/.test(HERO));
const ILL = (HERO.match(/<div class="prev-ill" id="lpPrevIll">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/) || [''])[0];
chk('the fallback example says it is an example, in its own chrome', /Example game &middot; not live/.test(ILL) && (ILL.match(/<small>Example<\/small>/g) || []).length >= 2, ILL.slice(0, 200));
chk('the example is shown only without script or when nothing live exists', /\.js \.prev-ill\{display:none\}/.test(IDX) && /body\.classList\.add\('ill'\)/.test(LANDING));
has(IDX, "fetch(url+'/rest/v1/rpc/public_home_board'", 'the board is read from public_home_board() (supabase/home_board.sql)');
has(IDX, "fetch('/football/home/board.json'", 'and the props and college EV from football/home/board.json');
has(IDX, '<script src="/lib/edgedesk_home.js', 'through the tested view model lib/edgedesk_home.js');
chk('both reads carry a deadline, so a slow network leaves the honest fallback', /withDeadline\(fetch\(url\+'\/rest\/v1\/rpc\/public_home_board'/.test(LANDING) && /withDeadline\(fetch\('\/football\/home\/board\.json'/.test(LANDING));
chk('a failed read shows the example and says the board could not be read', /function failAll\(\)/.test(LANDING) && /couldn&rsquo;t be reached just now/.test(LANDING));
chk('an empty slate says so rather than filling the space', /No upcoming NFL or FBS games are on EdgeDesk&rsquo;s board right now/.test(LANDING));
chk('with live games but nothing clearing the gates, the page says PASS is normal and promotes nothing',
  /No game clears EdgeDesk&rsquo;s research gates right now\.<\/b> PASS is a normal answer/.test(LANDING));
chk('the multi-megabyte ratings artifacts are no longer downloaded on every visit',
  !/fetch\('football\/rankings\/current\.json'/.test(IDX) && !/fetch\('football\/players\/current\.json'/.test(IDX));
has(IDX, 'id="lpRatings"', 'the ratings snippet still exists, read from the small board file');
chk('the ratings board is not frozen into the markup',
  !/Notre Dame|Ohio State|Georgia|Oregon|Texas Tech/.test(IDX.slice(IDX.indexOf('id="lpRatings"'), IDX.indexOf('id="lpRatings"') + 400)));
chk('and neither is a player count', !/15,?9\d\d/.test(IDX));
const TODAY = section('today');
has(TODAY, 'Today on EdgeDesk', 'the board is introduced as today\'s');
['Games analyzed', 'Game-market research', 'Player-prop research', 'Watching', 'Passes', 'Last model update', 'Last odds update']
  .forEach(t => has(TODAY, '<span class="l">' + t + '</span>', 'the board counts "' + t + '"'));
chk('the tiles ship hidden and empty', /<div class="tiles" id="lpTiles"[^>]*hidden>/.test(TODAY) && !/<span class="n[^"]*">\d/.test(TODAY));
has(LANDING, 'Market prices show the book and capture time. Nothing here is a recommendation.', 'the board says where its prices come from');

/* ======================================================================== */
/* 3. PLAYER PROPS ARE PART OF THE PRODUCT                                  */
/* ======================================================================== */
const WF = section('workflow');
has(WF, 'Price the game. Price the players.', 'the workflow puts the game and the players together');
has(WF, 'Game lines, player props, matchup data, rosters, simulations and market prices in one research terminal', 'in the brief\'s own sentence');
has(WF, '<div class="gr-k">Player markets</div>', 'the game card carries PLAYER MARKETS');
chk('every example player market is labelled RESEARCH, WATCH or PASS — never BET', /class="st research">RESEARCH/.test(WF) && /class="st watch">WATCH/.test(WF) && /class="st pass">PASS/.test(WF) && !/>BET</.test(WF));
chk('the workflow card is live when a game has priced player markets, else a labelled example', /function renderConnected\(V\)/.test(LANDING) && /id="lpConnTag">Example</.test(WF));
const PR = section('props');
has(PR, 'Price the players too.', 'the prop section headline');
has(PR, 'EdgeDesk doesn&rsquo;t stop at the spread. Research player markets using projections, sportsbook prices, expected value, role, matchup and uncertainty.', 'and its subhead');
chk('the prop table has exactly the brief\'s columns', () => {
  const th = [...PR.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]);
  return JSON.stringify(th) === JSON.stringify(['Player', 'Prop', 'Market', 'EdgeDesk', 'Difference', 'Best odds', 'EdgeDesk EV', 'Status']);
});
chk('the table ships with no row of numbers — it is read', !/<td[^>]*>\s*[+−-]?\d/.test(PR.replace(/<thead>[\s\S]*?<\/thead>/, '')));
['Player', 'Market', 'Line', 'Odds', 'EdgeDesk projection', 'EdgeDesk probability', 'Break-even', 'Fair odds', 'Raw EV', 'Calibrated EV',
 'Projection difference', 'Confidence', 'Best available price', 'Market consensus', 'Market range']
  .forEach(f => has(PR, '<span class="ck">' + f + '</span>', 'every supported prop shows ' + f));
/* only factors football/props/model.js actually uses (docs/player-props/DESIGN.md §4) */
const REASONS = ['Expected volume', 'Snap share', 'Carries', 'Targets', 'Red-zone share', 'Opponent matchup by position', 'Pace', 'Game script', 'Quarterback', 'Injury effects', 'Weather', 'Historical role'];
REASONS.forEach(f => has(PR, '<span class="ck">' + f + '</span>', 'a supported reason: ' + f));
chk('an unsupported factor is never listed as a reason',
  !/<span class="ck">(?:Routes|Route participation|Offensive line|OL status|Coaching)<\/span>/i.test(PR));
has(PR, 'Routes and offensive-line data aren&rsquo;t in EdgeDesk&rsquo;s feed yet, so they are never shown as a reason.', 'and the page says which factors it does not have');
const MODEL = fs.readFileSync(path.join(ROOT, 'football', 'props', 'model.js'), 'utf8');
chk('the listed reasons are ones the prop model computes (share, snap, script, wind, matchup, teammates out, pace)',
  /carry \/ target \/ red-zone share/.test(MODEL) && /snp_pct/.test(MODEL) && /script_pass_rate_per_pt/.test(MODEL) && /wind/.test(MODEL)
  && /what the opponent ALLOWED/.test(MODEL) && /teammates OUT/.test(MODEL) && /opponent pace/.test(MODEL));
['Role uncertainty', 'Injury uncertainty', 'Limited sample', 'QB uncertainty', 'Market disagreement', 'Stale price'].forEach(u => has(PR, u, 'the uncertainty listed: ' + u));
has(PR, 'A prop whose price has gone stale is labelled and its EV withheld', 'a stale prop price is never shown as current');
has(PR, 'Player-prop EV is model-estimated', 'prop EV is labelled model-estimated');
has(PR, 'carry no stake until their graded record promotes them', 'and the validation stage is disclosed');
['Passing yards', 'passing touchdowns', 'interceptions', 'rushing yards', 'rushing attempts', 'receiving yards', 'receptions', 'touchdowns']
  .forEach(m => has(PR, m, 'the prop markets named: ' + m));
chk('the hero subhead, the board, the product grid, the plan and the FAQ all carry player props', () =>
  /player props/.test(HERO) && /Player-prop research/.test(TODAY) && /Player prop research/.test(section('product'))
  && /<li>Player props<\/li>/.test(section('pricing')) && /Which player props does EdgeDesk analyze\?/.test(section('faq')));

/* ======================================================================== */
/* 4. FOUR PUBLIC WORDS. NO PICKS. NO PROFIT PROMISES.                      */
/* ======================================================================== */
/* the landing board lists only games with a current market (lib/edgedesk_home.js
   listed_games), so its legend defines the three words it can show */
['RESEARCH', 'WATCH', 'PASS'].forEach(w => has(TODAY, '>' + w + '</span>', 'the legend defines ' + w));
chk('the landing legend has no DATA INCOMPLETE: nothing listed there carries it', TODAY.indexOf('>DATA INCOMPLETE</span>') < 0);
has(TODAY, 'worth opening, not a bet', 'RESEARCH is defined as not a bet');
const Home = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));
chk('the view model has exactly the four public words', JSON.stringify(Object.keys(Home.STATUS)) === JSON.stringify(['RESEARCH', 'WATCH', 'PASS', 'DATA_INCOMPLETE']));
/* A page that REFUSES to promise profit has to be able to say the words it
   refuses ("no locks", "does not guarantee profit"). Fail only on one that is
   not negated, or on a question the FAQ answers "No". */
const NEG = /\b(?:not|never|no|nobody|nothing|without|refus\w*|cannot|can't|doesn't|does not|isn't|won't)\b[^.]{0,60}$/i;
function claimsIt(re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; const offenders = [];
  while ((m = g.exec(TEXT))) {
    const before = TEXT.slice(Math.max(0, m.index - 70), m.index);
    if (NEG.test(before)) continue;
    const rest = TEXT.slice(m.index, m.index + 140), stop = rest.search(/[.?!]/);
    if (stop >= 0 && rest[stop] === '?') continue;
    offenders.push('…' + before.slice(-46) + '[' + m[0] + ']');
  }
  return offenders;
}
[/\bLOCKS?\b/i, /\block of the day\b/i, /\bbest bet\b/i, /\bcan'?t miss\b/i, /\bsure thing\b/i, /\bguaranteed win/i, /\bguaranteed profit/i,
 /\bmortal lock\b/i, /\bfree money\b/i, /\bnever lose\b/i, /\bwe'?ll make you money\b/i, /\bprofit guarantee/i, /\btail\b/i,
 /\bSMASH\b/i, /\bHAMMER\b/i, /\bmax (?:bet|play)\b/i, /\bbet this\b/i, /\bsharp money\b/i, /\bsmart money\b/i,
 /\bsteam\b/i, /\bwait for sharps\b/i]
  .forEach(re => { const o = claimsIt(re); chk('no tout phrase is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
[/\bguarantee[sd]? (?:you )?(?:a )?(?:profit|win|return)/i, /\bwin rate of\b/i, /\broi of\b/i, /\bprofit(?:able)? every\b/i]
  .forEach(re => { const o = claimsIt(re); chk('no profit promise is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
has(TEXT, 'it does not guarantee profit', 'the page says EV does not guarantee profit');
has(TEXT, 'no picks, no locks, no guaranteed winners', 'and lists what it will never sell');
has(TEXT, 'Research, not picks', 'research, not picks');
[/\brevolutionary\b/i, /\bcutting-edge\b/i, /\bnext-generation\b/i, /\bAI-powered\b/i, /\bunlock your\b/i,
 /\belevate your\b/i, /\bgame-?changing\b/i, /\bultimate platform\b/i, /\bseamless\b/i]
  .forEach(re => chk('no marketing sludge: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('the live preview never prints a pick word', !/'(?:BET|LOCK|PICK)'/.test(LANDING) && !/>\s*(?:BET|LOCK|PICK)\s*</.test(LANDING));

/* ======================================================================== */
/* 5. NO UNPROVABLE CLAIMS                                                  */
/* ======================================================================== */
[/\b\d[\d,]* (?:happy )?(?:customers|subscribers|members|users) (?:trust|use|love)/i,
 /\btestimonial/i, /\bas seen on\b/i, /\b\d+% win rate\b/i, /\bunits? (?:won|profit)\b/i, /\bmade \$[\d,]+/i]
  .forEach(re => chk('no unprovable claim ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('structured data claims no rating and no review', !/aggregateRating|"review"/i.test(IDX));
chk('the record panel is filled from the database, with an honest fallback', /id="proofInner"/.test(IDX) && /Opens as you scroll here/.test(IDX));

/* ======================================================================== */
/* 6. THE HIERARCHY                                                         */
/* ======================================================================== */
const ORDER = ['top', 'today', 'workflow', 'props', 'difference', 'product', 'trust', 'who', 'pricing', 'faq', 'start'];
ORDER.forEach(id => has(IDX, 'id="' + id + '"', 'the ' + id + ' section exists'));
chk('the sections run hero → live board → workflow → props → difference → product → trust → who → pricing → FAQ → close',
  ORDER.every((id, i) => i === 0 || IDX.indexOf('id="' + id + '"') > IDX.indexOf('id="' + ORDER[i - 1] + '"')));
chk('the page is a shorter read: at most 11 top-level blocks', (IDX.match(/<section\b/g) || []).length <= 10, (IDX.match(/<section\b/g) || []).length);
['id="game"', 'id="ev"', 'id="evSlider"', 'id="tabs"', 'id="lpEvData"'].forEach(x =>
  lacks(IDX, x, 'the technical walk-through moved to /methodology/: ' + x));
const NP = section('difference');
has(NP, 'Research, not picks.', 'the difference is one line');
has(NP, 'A picks service', 'set against a picks service');
has(NP, '&ldquo;Take Auburn &minus;8.&rdquo;', 'which gives an answer');
['Its own number', 'The price, not just the side', 'Why it disagrees', 'What it doesn&rsquo;t know'].forEach(t => has(NP, t, 'EdgeDesk shows ' + t));
has(NP, 'A good number at a bad price is still a bad price', 'the price idea, once');
chk('the live price example only reports a stored game EV with its own quote and time',
  /function renderPriceExample\(V\)/.test(LANDING) && /!x\.ev\.stale/.test(LANDING) && /captured '\+e\(v\.age_text/.test(LANDING));
const PROD = section('product');
chk('the feature grid is six cards', (PROD.match(/<article class="feat/g) || []).length === 6);
['Game markets', 'Player prop research', 'EdgeDesk EV + price', 'Matchup research', 'Players + rosters', 'Simulation + uncertainty']
  .forEach(t => has(PROD, '<h3>' + t + '</h3>', 'the product card ' + t));
chk('each card is a heading and a sentence, not an essay',
  (PROD.match(/<p>([^<]|<[^/])*?<\/p>/g) || []).every(p => plain(p).split(/[.!?](\s|$)/).filter(s => s.trim().length > 3).length <= 2));
[/\bevery sport\b/i, /\ball sports\b/i, /\bMLB\b/, /\bNBA\b/, /\bWNBA\b/, /\btennis\b/i, /\bUFC\b/, /\bbaseball\b/i, /\bgolf/i]
  .forEach(re => chk('coverage is never overstated: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
has(TEXT, 'the NFL and NCAA FBS', 'the FAQ names the coverage exactly');
has(IDX, 'carried as unknown, never as healthy', 'unknown is not healthy');
has(IDX, 'A stale price is not compared', 'a stale market is not a price');
has(IDX, 'Layers that have not cleared validation move no line', 'the unvalidated layers move no line');
[/\bEV Engine\b/, /\bBet EV\b/, /\bExpected Value Tool\b/i, /\bEdge Calculator\b/i, /\bValue Score\b/i]
  .forEach(re => chk('EdgeDesk EV is never renamed: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
has(IDX, 'Expected value estimates the theoretical return of repeatedly taking the same price if EdgeDesk&rsquo;s probability is accurate',
  'expected value is explained once, in plain English');

/* ======================================================================== */
/* 7. NAVIGATION AND THE TRIAL BUTTONS                                      */
/* ======================================================================== */
const NAV = section('nav', 'nav');
chk('the site nav is found', NAV.length > 400);
['Today', 'Player props', 'How it works', 'Record', 'Pricing'].forEach(l => has(NAV, '>' + l + '<', 'the nav offers ' + l));
chk('the nav CTA is "Start free trial"', /id="navSignup"[^>]*>Start free trial</.test(NAV));
has(NAV, 'id="navLogin"', 'Log in keeps the id bootAuthState rewrites');
chk('the phone menu is a real disclosure', /aria-controls="navMenu"/.test(NAV) && /aria-expanded="false"/.test(NAV));
const TRIAL = [...IDX.replace(/<script[\s\S]*?<\/script>/g, ' ').matchAll(/<button\b[^>]*onclick="startSubscribe\(\)"[^>]*>([^<]*)/g)].map(m => m[1].trim());
chk('at least five trial buttons: nav, hero, board, pricing, close', TRIAL.length >= 5, TRIAL.join(' | '));
chk('and every one of them says "Start free trial" or opens the terminal', TRIAL.every(t => /^(?:Start free trial|Open every game in the terminal)$/.test(t)), TRIAL.join(' | '));
[/>\s*Start researching/, />\s*Get started/i, />\s*Join now/i, />\s*Unlock/i, />\s*Try EdgeDesk/i, />\s*Subscribe\b/i, />\s*Begin research/i, />\s*Start 7 days free/]
  .forEach(re => chk('no competing CTA verb: ' + re, !re.test(IDX), (re.exec(IDX) || [])[0]));
chk('the board\'s "Explore" action appears in the hero and the close', (IDX.match(/Explore today&rsquo;s board/g) || []).length >= 2);

/* ======================================================================== */
/* 8. PRICING: ONE PLAN, FROM ONE SOURCE                                    */
/* ======================================================================== */
const PRICE = section('pricing');
chk('one plan card', (IDX.match(/class="pcard\b/g) || []).length === 1);
has(PRICE, 'data-ed-price="plan">' + X.PLAN_NAME + '<', 'the plan is named from the pricing file');
has(PRICE, 'data-ed-price="price">' + X.PRICE_DISPLAY + '<', 'the price is stated from the pricing file');
has(PRICE, 'data-ed-price="trial">' + X.TRIAL_LABEL + '<', 'the trial is stated from the pricing file');
has(PRICE, '$49.99', 'the price is stated');
lacks(PRICE, '$79.99', 'and the retired price is gone');
has(PRICE, 'EdgeDesk Full Access', 'the plan is named');
has(PRICE, 'Football research terminal', 'and says what it is');
has(PRICE, 'id="subscribe"', 'the #subscribe anchor app.html sends people to is here');
lacks(PRICE, 'Only $49.99', 'and never apologised for');
[/founding/i, /introductory/i, /\bsale\b/i, /\bdiscount/i, /best value/i, /\bwas \$/i, /normally \$/i]
  .forEach(re => chk('the price is simply the price: ' + re, !re.test(PRICE), (re.exec(PRICE) || [])[0]));
chk('the plan\'s inclusions are the pricing file\'s FEATURES, in order', () => {
  const li = [...(PRICE.match(/<ul class="pincl">([\s\S]*?)<\/ul>/) || [, ''])[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => plain(m[1]).trim());
  return JSON.stringify(li) === JSON.stringify(X.FEATURES);
}, 'the plan card list differs from lib/edgedesk_pricing.js FEATURES');
lacks(TEXT, 'worth every penny', 'no worth-every-penny copy');
chk('no crossed-out price', !/<(?:s|del|strike)>\s*\$/.test(IDX) && !/line-through[^}]*\$/.test(IDX));
[/\bcountdown\b/i, /\blimited time\b/i, /\bhurry\b/i, /\bonly \d+ (?:spots|seats|left)\b/i, /\bexpires? (?:soon|tonight|today)\b/i, /\blimited availability\b/i]
  .forEach(re => { const o = claimsIt(re); chk('no scarcity device: ' + re, o.length === 0, o.join(' || ')); });
chk('no availability limit or scarcity is claimed', !/\bspots? left\b|\bonly \d+ (spots|seats|places)\b|\bwhile (supplies|spots) last\b/i.test(TEXT));
['NFL + FBS', 'Game markets', 'Player props', 'Fair spreads and projections', 'EdgeDesk EV', 'Live market comparison',
 'Matchup research', 'Player and roster research', 'Simulation and uncertainty', 'Power ratings', 'Public record', 'Research briefs']
  .forEach(f => has(PRICE, f, 'the plan includes ' + f));
has(PRICE, 'Nothing charged until day <span data-ed-price="day8">' + X.FIRST_CHARGE_DAY + '</span>', 'the trial mechanics are stated');
has(PRICE, 'Cancel anytime', 'and so is cancelling');
has(PRICE, 'Reminder email', 'and the reminder before conversion');
has(PRICE, 'the exact date your card will be charged', 'which states the charge date');
has(PRICE, 'Unless cancelled before renewal', 'and what day 8 means');
chk('the trial reads Today, Before day 8, Day 8', /<span class="when">Today<\/span>[\s\S]*<span class="when">Before day <span data-ed-price="day8">8<\/span><\/span>[\s\S]*<span class="when">Day <span data-ed-price="day8">8<\/span><\/span><span><b data-ed-price="monthly">\$49\.99\/month<\/b>/.test(PRICE));
has(PRICE, 'id="edOffer" hidden', 'a creator discount is only ever Stripe\'s own record');

/* ======================================================================== */
/* 9. TRUST IS THE PROCESS                                                  */
/* ======================================================================== */
const TR = section('trust');
has(TR, 'Nothing quietly disappears after kickoff.', 'the trust headline is the process');
['Every research result is captured before kickoff.', 'Automatically graded.', 'Losses remain visible.', 'Uncertainty is explicitly shown.', 'Methodology is published.']
  .forEach(t => has(TR, t, 'the process: ' + t));
chk('no historical metric is the headline', !/<h2>[^<]*(?:CLV|ROI|win rate|%|record of)/i.test(TR));
has(TR, 'href="/record.html"', 'the public record stays linked');
has(IDX, 'id="record"', 'and old #record links still land in the right place');
chk('the record panel loads only when a reader nears it', /function lazyProof\(\)|\(function lazyProof\(\)/.test(IDX) && /rootMargin:'600px 0px'/.test(IDX));

/* ======================================================================== */
/* 10. FEATURED IN — MEDIA ATTRIBUTION, STATED EXACTLY                      */
/* ======================================================================== */
const MED = (function () {
  const a = IDX.indexOf('id="featured"');
  if (a < 0) return '';
  const note = IDX.indexOf('class="press-note"', a);
  return IDX.slice(IDX.lastIndexOf('<', a), note < 0 ? a : IDX.indexOf('</p>', note) + 4);
})();
chk('the featured-in block exists', MED.length > 800, 'length ' + MED.length);
chk('and it sits inside the trust section', IDX.indexOf('id="featured"') > IDX.indexOf('id="trust"') && IDX.indexOf('id="featured"') < IDX.indexOf('id="who"'));
has(MED, 'Featured in Stadium Rant', 'the publisher is named');
has(MED, 'independent matchup coverage published by <b>Stadium Rant</b>', 'as the publisher of that coverage, not as a partner');
has(MED, 'Stadium Rant is an independent publisher', 'the publisher is called independent');
has(MED, 'editorial attribution, not a partnership, a sponsorship or a syndication deal', 'and the relationship is named by what it is not');
has(MED, 'EdgeDesk has no say in what they publish', 'and the coverage is not EdgeDesk\'s to steer');
has(MED, 'Data and model analysis powered by EdgeDeskSports.com', 'the credit is quoted in the publisher\'s own words');
[/\bofficial partner\b/i, /\bstadium rant partner\b/i, /\bsponsored by\b/i, /\bin partnership with\b/i, /\bpartnered with\b/i,
 /\bour partner\b/i, /\bexclusive partner/i, /\bas seen (?:in|on)\b/i, /\bmedia partner\b/i]
  .forEach(re => chk('the relationship is never inflated to ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('every stadiumrant.com link opens in a new tab with the opener severed', () => {
  const links = [...IDX.matchAll(/<a\b[^>]*href="https:\/\/www\.stadiumrant\.com[^"]*"[^>]*>/g)].map(m => m[0]);
  return links.length >= 2 && links.every(t => /target="_blank"/.test(t) && /rel="noopener noreferrer"/.test(t));
});
chk('the publisher is named only in that block', () => (TEXT.match(/Stadium Rant/g) || []).length === (plain(MED).match(/Stadium Rant/g) || []).length);

/* ======================================================================== */
/* 11. RESPONSIBLE GAMBLING AND THE LEGAL LINKS                             */
/* ======================================================================== */
chk('21+ is stated at the offer, the price card and the close', (TEXT.match(/21\+/g) || []).length >= 4);
chk('1-800-GAMBLER is on the page more than once', (TEXT.match(/1-800-GAMBLER/g) || []).length >= 3);
has(IDX, 'ncpgambling.org', 'the national resource is linked');
has(TEXT, 'Research and decision-support tool', 'the product is named for what it does');
lacks(TEXT, 'never tells you what to bet', 'and never claims EdgeDesk makes no decision, beside a terminal that says BET, LEAN, WATCH or PASS');
['/terms.html', '/privacy.html', '/disclaimer.html'].forEach(h => has(IDX, 'href="' + h + '"', 'the footer links ' + h));
has(IDX, 'data-ed-report', 'a visitor can report a problem');

/* ======================================================================== */
/* 12. SEARCH AND SOCIAL                                                    */
/* ======================================================================== */
has(IDX, '<title>EdgeDesk Sports | Football Research Terminal</title>', 'the title names the category');
const DESC = (IDX.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '';
chk('the description is search-length', DESC.length >= 110 && DESC.length <= 160, DESC.length);
chk('and names what it researches, props included', /NFL/.test(DESC) && /college football/.test(DESC) && /player props/.test(DESC) && /Research, not picks/.test(DESC));
has(IDX, '<link rel="canonical" href="https://edgedesksports.com/">', 'the canonical URL is the root');
['og:title', 'og:description', 'og:url', 'og:type', 'twitter:card', 'twitter:title', 'twitter:description']
  .forEach(k => chk('social metadata: ' + k, new RegExp('(property|name)="' + k + '" content="[^"]{5,}"').test(IDX)));
chk('the structured data parses and offers the price the pricing file states', () => {
  const j = JSON.parse((IDX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]);
  const app = j['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  /* consent records PRICE_DISPLAY, which index.html reads from the pricing file */
  const price = X.PRICE_DISPLAY.replace(/^\$/, '');
  return /var PRICE_DISPLAY=EDP\?EDP\.PRICE_DISPLAY:'';/.test(IDX) && price === '49.99'
    && app && app.offers && app.offers.price === price && app.offers.priceCurrency === X.CURRENCY
    && app.offers.description === X.TRIAL_DAYS + '-day free trial, then ' + X.PRICE_DISPLAY + ' per ' + X.BILLING_PERIOD + '. Cancel anytime.';
});

/* ======================================================================== */
/* 13. THE METHODOLOGY PAGE                                                 */
/* ======================================================================== */
const METH = fs.readFileSync(path.join(ROOT, 'methodology', 'index.html'), 'utf8');
chk('the landing page links the methodology', (IDX.match(/href="\/methodology\/(?:#[a-z]+)?"/g) || []).length >= 3);
['id="model"', 'id="game"', 'id="ev"', 'id="props"', 'id="statuses"', 'id="uncertainty"', 'id="record"'].forEach(x => has(METH, x, 'the methodology covers ' + x));
has(METH, 'Routes run, route participation and offensive-line data are not in EdgeDesk&rsquo;s data yet', 'and states what the prop model does not have');
has(METH, 'data-ed-price="cta"', 'its offer is the pricing file\'s');
chk('its only third-party script is the Google tag', [...METH.matchAll(/<script[^>]*src="(https?:[^"]+)"/g)].every(m => /googletagmanager/.test(m[1])));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding positioning: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
