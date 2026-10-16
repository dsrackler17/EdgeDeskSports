#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — positioning and honesty.

   The page sells ONE idea in five seconds: EdgeDesk is sports research plus
   personal betting analytics — research a football game, track what you
   bet, see whether you are actually profitable and whether your process is
   working. Research, not picks. $49.99 a month. Its model is a BASELINE a
   reader can follow, check and argue with (#model), shown on real games. A first-time reader should
   be able to answer, from the first screen: what EdgeDesk is, what it does,
   what it costs, and that it sells no picks. These tests hold those answers
   on the page, and hold the line on what a marketing page is never allowed
   to say:

     1  the hero: eyebrow, headline, sentence, the two actions, the offer
        under them, who it is for — and no jargon above the fold;
     2  the hero's product picture is a SAMPLE of a feature in development,
        and says both in its own chrome before any number;
     3  one subscription, said once, with what is not live yet marked;
     4  results vs process: the sample tickets' arithmetic is right;
     5  the loop — research, track, measure, learn, improve — is live, and
        what is not (prediction markets, account sync) is marked soon;
     5b the baseline (#model): know it, follow it, help it, disagree with it,
        then real games drawn by the research page's own code, read not typed;
     6  WHAT SHIPPED SAYS LIVE, WHAT DID NOT IS LABELLED: the Process Coach,
        the Weekly Film Room and the calendar are live (pictured on labelled
        sample data); prediction markets and account connections never appear
        without an in-development label, and no platform is called connected;
     7  the research terminal — the live product — is read, never typed in,
        and falls back to an example that says it is one;
     8  pricing is one plan, read from lib/edgedesk_pricing.js, listing only
        what is live, with the real trial terms and no scarcity device;
     9  no picks, no profit promises, no invented proof, no marketing sludge;
    10  the FAQ answers the questions a bettor asks, with the real coverage
        and the real connection support;
    11  one primary call to action, worded one way, everywhere;
    12  the hierarchy, in the order the brief sets;
    13  a publisher that cites EdgeDesk is credited as exactly that;
    14  responsible-gambling language and the legal links survive;
    15  search and social metadata describe the product that exists;
    16  the technical explanation lives on /methodology/, linked from here.

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
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&minus;/g, '-').replace(/&amp;/g, '&')
    .replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');
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
chk('the hero is found', HERO.length > 2500);
has(HERO, '<span class="ey" data-hero="eyebrow">Research, not picks.</span>', 'the eyebrow is the philosophy: research, not picks');
has(HERO, '<h1 data-hero="headline">Research the game <span class="g">before you bet it.</span></h1>', 'the headline: research the game before you bet it');
has(HERO, '<p class="sub" data-hero="sub">Free NFL and college football research every week: today&rsquo;s games, EdgeDesk&rsquo;s number beside the market&rsquo;s, and odds tools, with no card needed.</p>',
  'the sentence: the research is free, every week, with no card');
chk('the sentence is one sentence, not a paragraph', plain(HERO.match(/<p class="sub"[\s\S]*?<\/p>/)[0]).trim().split(/[.!?](\s|$)/).filter(s => s.trim()).length === 1);
/* FREE RESEARCH FIRST (docs/product-led-growth/PLAN.md, Phase 1): the free
   research is the primary action; the trial is right beside it, through the
   same consented flow, with its terms under both */
chk('the primary action is the free research',
  /<a class="btn primary lg" id="heroStart" href="#free" data-track="hero_free_click" data-cta="hero_free">Explore free research <span class="ar" aria-hidden="true">&rarr;<\/span><\/a>/.test(HERO) && /<section class="sec" id="free">/.test(IDX));
chk('the secondary action starts the free trial through the consented flow',
  /<button type="button" class="btn ghost lg" id="heroCta" onclick="startSubscribe\(\)" data-track="hero_cta_click" data-cta="hero_trial">Start free trial<\/button>/.test(HERO));
chk('the free research comes before the trial in the hero', HERO.indexOf('id="heroStart"') < HERO.indexOf('id="heroCta"'));
chk('an account is shown its next step on the primary button: the trial through the consented flow, or the terminal',
  /heroMain\('Start free trial →','hero_cta_click','hero_trial',toPay\)/.test(IDX) && /heroMain\('Open the terminal →','hero_app_click','hero_app',toApp\)/.test(IDX));
/* the offer sits directly under the buttons — nobody hunts for what the trial becomes */
const OFFER = (HERO.match(/<p class="microcta">([\s\S]*?)<\/p>/) || [])[1] || '';
chk('the hero offer line is found', OFFER.length > 40);
['Free research, no card', 'data-ed-price="trial">7 days free', '$49.99', '/month', 'Cancel anytime', '21+'].forEach(t => has(OFFER, t, 'the hero offer states ' + t));
chk('the hero offer is the first .microcta, the one bootAuthState rewrites for an unpaid account', () => {
  const first = IDX.search(/class="microcta"/), a = IDX.indexOf('<header class="hero"'), b = IDX.indexOf('</header>');
  return first > a && first < b;
});
has(HERO, 'Built for NFL + college football bettors, from first-time researchers to serious market analysts.', 'who it is for, beginner to analyst, in one line');
/* the five-second test: no jargon above the fold (the sample panel's own
   labels are a product picture, not the pitch) */
const PITCH = plain(HERO.slice(0, HERO.indexOf('class="panel dash')));
[/\bEV\b/, /\bCLV\b/, /\bBrier\b/i, /\bMonte Carlo\b/i, /\bcalibrat/i, /\bAPI\b/, /\bexpected value\b/i, /\bde-?vig/i]
  .forEach(re => chk('the pitch carries no jargon: ' + re, !re.test(PITCH), (re.exec(PITCH) || [])[0]));
chk('the pitch is short: under 75 words before the product picture', PITCH.split(/\s+/).filter(Boolean).length < 75, PITCH.split(/\s+/).length);

/* ======================================================================== */
/* 2. THE HERO'S PRODUCT PICTURE IS A FREE TOOL THAT WORKS NOW              */
/* ======================================================================== */
const DASH = (HERO.match(/<div class="panel dash calc"[\s\S]*?<div class="panel-foot">[\s\S]*?<\/div>/) || [''])[0];
chk('the hero calculator is found', DASH.length > 800);
const DBAR = (DASH.match(/<div class="panel-bar">([\s\S]*?)<\/div>/) || [, ''])[1];
chk('its own bar says Free, and it is not a sample or a feature in development',
  /<span class="tag live">Free<\/span>/.test(DBAR) && !/Sample data|In development/.test(DASH));
chk('and its label for assistive technology says what it is', /aria-label="Free no-vig calculator"/.test(DASH));
{
  const OT = require(path.join(ROOT, 'lib', 'edgedesk_odds_tools.js'));
  const r = OT.noVig(['-150', '+130'], { method: 'proportional' });
  const pct = (x) => (x * 100).toFixed(2) + '%';
  has(DASH, 'value="-150"', 'it opens on a real two-way price'); has(DASH, 'value="+130"', 'both sides');
  has(DASH, '<span class="v" id="hcPa">' + pct(r.outcomes[0].fair) + '</span>', 'the printed fair chance is the odds library\'s, before any script');
  has(DASH, '<span class="v" id="hcPb">' + pct(r.outcomes[1].fair) + '</span>', 'for both sides');
  has(DASH, 'no-vig &minus;' + r.outcomes[0].fair_american_display.replace('-', ''), 'and the no-vig price');
  has(DASH, '<span class="v" id="hcVig">' + pct(r.overround) + '</span>', 'and the margin taken out');
}
has(DASH, 'href="/tools/no-vig-calculator/"', 'the full calculator, with its working, is one tap away');
has(DASH, 'Not a prediction.', 'and it says what it is not');
['Process Coach', 'Film Room', 'In development', 'Sample data'].forEach(t => lacks(HERO, t, 'nothing in the hero is a feature still being built: ' + t));

/* ======================================================================== */
/* 3. ONE SUBSCRIPTION                                                      */
/* ======================================================================== */
const STRIP = (HERO.match(/<div class="strip"[\s\S]*?<\/div>/) || [''])[0];
chk('the strip says what is free first, in order', /<span class="strip-k">Free<\/span>/.test(STRIP)
  && JSON.stringify([...STRIP.matchAll(/<li>([^<]+)/g)].map(m => plain(m[1]).trim())) === JSON.stringify(['Game research', "Today's games", 'Odds tools', 'Weekly email']));
has(STRIP, '<span class="strip-k">Full Access</span> <span data-ed-price="monthly">$49.99/month</span>', 'then Full Access, at the pricing file\'s price');
chk('nothing in the strip is a feature still being built', !/Process Coach|Soon/.test(STRIP));
has(HERO, 'href="#how" data-track="how_it_works_click" data-cta="strip_how">How Full Access works<', 'how the paid half works is one tap away (the GA report reads how_it_works_click)');
chk('the strip is not fifteen feature cards', (STRIP.match(/<li>/g) || []).length <= 5);

/* ======================================================================== */
/* 4. RESULTS VS PROCESS — the sample tickets add up                        */
/* ======================================================================== */
const WHY = section('why');
has(WHY, 'Winning a bet doesn&rsquo;t mean it was a good bet.', 'the problem headline');
has(WHY, 'Most betting apps tell you what happened. EdgeDesk is built to help you understand why. A good decision can lose. A bad decision can win.', 'the problem, plainly');
has(WHY, 'The scoreboard isn&rsquo;t the whole story.', 'the caption');
has(WHY, '<span class="sample">Illustrative example</span>', 'and it is labelled an example');
function ticket(cls) {
  const t = (WHY.match(new RegExp('<article class="tk ' + cls + '">([\\s\\S]*?)<\\/article>')) || [, ''])[1];
  const row = (k) => plain((t.match(new RegExp('<dt>' + k + '<\\/dt><dd[^>]*>([\\s\\S]*?)<\\/dd>')) || [, ''])[1]).trim();
  return { title: plain((t.match(/<h3>([\s\S]*?)<\/h3>/) || [, ''])[1]).trim(), entry: row('Entry'), close: row('Close'), stake: row('Stake'), result: row('Result'), pnl: row('P&amp;L'), quality: row('Price quality'), head: plain(t.match(/<div class="tk-hd">[\s\S]*?<\/div>/)[0]).trim() };
}
const GOOD = ticket('good'), BAD = ticket('bad');
chk('good process, bad result: Iowa +7.5', GOOD.title === 'Iowa +7.5' && GOOD.head === 'Good process Bad result', GOOD);
chk('bad process, good result: Chiefs -7', BAD.title === 'Chiefs -7' && BAD.head === 'Bad process Good result', BAD);
/* American odds: $100 at -110 wins 100 * 100/110 */
const winAt = (stake, odds) => Math.round(stake * (odds < 0 ? 100 / -odds : odds / 100) * 100) / 100;
chk('both are $100 at -110', GOOD.stake === '$100 at -110' && BAD.stake === '$100 at -110', [GOOD.stake, BAD.stake]);
chk('the loss is the stake: -$100.00', GOOD.result === 'Loss' && GOOD.pnl === '-$100.00', GOOD);
chk('the win is what -110 pays on $100: +$' + winAt(100, -110).toFixed(2), BAD.result === 'Win' && BAD.pnl === '+$' + winAt(100, -110).toFixed(2), BAD);
/* price quality is the entry against the close, for the side bet: taking
   +7.5 against a +5 close is 2.5 points better; laying -7 against a -4 close
   is 3 points worse */
const clv = (entry, close) => parseFloat(entry) - parseFloat(close);
chk('Strong is a better number than the close', clv(GOOD.entry, GOOD.close) === 2.5 && GOOD.quality === 'Strong', [GOOD.entry, GOOD.close, GOOD.quality]);
chk('Poor is a worse number than the close', clv(BAD.entry, BAD.close) === -3 && BAD.quality === 'Poor', [BAD.entry, BAD.close, BAD.quality]);
has(WHY, 'You got 2.5 points more than the market finished at.', 'and the sentence agrees with the numbers');
has(WHY, 'You laid three more points than the closing number.', 'both sentences');

/* ======================================================================== */
/* 5. THE LOOP                                                              */
/* ======================================================================== */
const HOW = section('how');
has(HOW, 'Every bet should teach you something.', 'the loop headline');
const STEPS = [...HOW.matchAll(/<li( class="on")?>\s*<div class="hd"><span class="n">(\d)<\/span><span class="(livechip|soon)">([^<]+)<\/span><\/div>\s*<h3>([^<]+)<\/h3>/g)]
  .map(m => ({ n: +m[2], live: m[3] === 'livechip', label: m[4], name: m[5] }));
chk('five steps: Research, Track, Measure, Learn, Improve', JSON.stringify(STEPS.map(s => s.name)) === JSON.stringify(['Research', 'Track', 'Measure', 'Learn', 'Improve']), STEPS.map(s => s.name));
chk('all five steps are live: the Process Coach and its experiments shipped (CHANGELOG 2026-10-04/05)', STEPS.length === 5 && STEPS.every(s => s.live && s.label === 'Live'), STEPS);
chk('so no step needs a "Today:" stand-in any more', !/<p class="now">/.test(HOW));
chk('tracking is described as logging, never as automatic connection', /Log your bets as you make them/.test(HOW) && !/\b(?:connect|sync)s? (?:where you bet|automatically|your (?:sportsbook|account))/i.test(plain(HOW)));
['Prediction markets', 'Account sync'].forEach(t =>
  chk('"' + t + '" is marked as coming, not live', new RegExp('<span class="ck later">' + t.replace(/\+/g, '\\+') + '<i>soon<\\/i><\\/span>').test(HOW)));
['CSV import', 'Bet slip screenshots', 'By sportsbook', 'Bankroll + drawdown'].forEach(t => has(HOW, '<span class="ck">' + t + '</span>', 'shipped, so live: ' + t));
['Fair spread', 'Win probability', 'Market comparison', 'Roster + matchup context', 'Uncertainty'].forEach(t => has(HOW, '<span class="ck">' + t + '</span>', 'research covers ' + t));
['P&amp;L', 'ROI', 'Closing-line value', 'Exposure', 'By league', 'By market'].forEach(t => has(HOW, '<span class="ck">' + t + '</span>', 'measure covers ' + t));
['Entry timing', 'Price quality', 'Position sizing', 'Rule discipline', 'Edge capture'].forEach(t => has(HOW, '<span class="ck">' + t + '</span>', 'Learn grades ' + t));
['Experiments', 'Weekly Film Room', 'Before-you-bet check'].forEach(t => has(HOW, '<span class="ck">' + t + '</span>', 'Improve offers ' + t));
chk('the only things still marked soon in the loop are prediction markets and account sync', [...HOW.matchAll(/<span class="ck later">([^<]+)<i>soon/g)].map(m => m[1]).join('|') === 'Prediction markets|Account sync');

/* ======================================================================== */
/* 5b. THE BASELINE: A MODEL YOU CAN FOLLOW, AND ARGUE WITH                 */
/* ======================================================================== */
const MOD = section('model');
has(MOD, '<span class="ey">Your baseline <span class="livechip">Live</span></span>', 'the baseline section is live');
has(MOD, 'A model you can follow. <span class="g">And argue with.</span>', 'the baseline headline');
has(MOD, 'It doesn&rsquo;t pick your bets. It&rsquo;s the baseline you measure them against.', 'it says what the model is for, and what it is not');
chk('four cards, in order: know it, follow it, help it, disagree with it', JSON.stringify([...MOD.matchAll(/<span class="fk">([^<]+)<\/span>/g)].map(m => m[1])) === JSON.stringify(['Know it', 'Follow it', 'Help it', 'Disagree with it']));
has(MOD, 'graded against the close and the final, losses included', 'following it means a public record with the losses in');
has(MOD, 'what the model doesn&rsquo;t know yet', 'helping it means knowing what it cannot see');
has(MOD, 'Write down your own fair line.', 'disagreeing means putting a number beside it');
has(MOD, '<b>Why a baseline?</b>', 'and why a baseline matters, in one paragraph');
chk('the season\'s graded count is READ, never typed: it ships hidden and empty', /<span id="mdGraded" hidden><\/span>/.test(MOD));
has(MOD, 'id="mdDemo" role="region" aria-label="Real games, the way subscribers see them"', 'the demo is a labelled region');
chk('without script the demo is a link to the free sample, and no number is in the markup',
  /id="mdBody" aria-live="polite">See one game researched end to end in <a class="lnk" href="\/research\/sample\/" data-cta="model_sample">the free sample<\/a>\.<\/div>/.test(MOD)
  && !/\d+(?:\.\d)?%|[−-]\d+\.\d/.test(plain(MOD.slice(MOD.indexOf('id="mdDemo"')))));
chk('the demo reads real games through the research page\'s own code', /<script src="\/lib\/edgedesk_home_model\.js\?v=/.test(IDX) && /EDHomeModel\.init\(\{track:track, funnel:funnel, wait:withDeadline\}\)/.test(IDX));
chk('the demo closes on the one call to action', /<button type="button" class="btn primary lg" onclick="startSubscribe\(\)" data-track="model_trial_click" data-cta="model_trial">Start free trial /.test(MOD)
  && MOD.indexOf('<span data-ed-price="cta">' + X.CTA_LINE + '</span>') > 0);

/* ======================================================================== */
/* 6. WHAT SHIPPED SAYS LIVE; WHAT DID NOT IS LABELLED                      */
/* ======================================================================== */
/* The Process Coach, the Weekly Film Room and the calendar shipped
   (CHANGELOG 2026-10-04/05; Portfolio schema deployed 2026-10-14): they say
   Live, and their pictures stay SAMPLE data, said in each panel's own bar
   (landing_interaction.test.js checks the bars). Account connections and
   prediction markets did not ship: every mention carries the label. */
const COACH = section('coach'), FILM = section('film'), HIST = section('history');
has(COACH, '<span class="ey">Process Coach <span class="livechip">Live</span></span>', 'the Process Coach is live, at its heading');
has(COACH, 'Until it has 10 graded positions it says Building, never a guess.', 'and its evidence rule is stated (X.MIN.observation)');
has(COACH, 'Don&rsquo;t just ask &ldquo;Am I winning?&rdquo;<br><span class="g">Ask &ldquo;Why?&rdquo;</span>', 'the coach headline');
['Game-day CFB entries', '43 positions', '&minus;12.8%', '&minus;1.3 pts', '61', 'CFB entries &gt;24h early', '51 positions', '+8.7%', '+1.2 pts', '89',
 'Your earlier CFB entries have historically produced better prices and stronger closing-line value than your game-day entries.',
 'Avoid new CFB sides inside six hours of kickoff for four weeks.', 'EdgeDesk will measure whether your price quality improves.', 'Why? View the 94 positions used']
  .forEach(t => has(COACH, t, 'the coach example shows ' + t));
chk('the coach example\'s positions add up: 43 + 51 = 94', 43 + 51 === 94 && /43 positions/.test(COACH) && /51 positions/.test(COACH) && /94 positions used/.test(COACH));
chk('every sample position behind the finding has a CLV that matches its entry and close', () => {
  const rows = [...COACH.matchAll(/<tr><td>[^<]+<\/td><td>([^<]+)<\/td><td>([^<]+) &rarr; ([^<]+)<\/td><td class="(?:pos|neg)">([^<]+)<\/td>/g)];
  const num = (s) => parseFloat(plain(s));
  return rows.length === 4 && rows.every(m => Math.abs((num(m[2]) - num(m[3])) - num(m[4])) < 1e-9);
});
has(COACH, 'Sample data and an illustrative example, not a real customer&rsquo;s results.', 'the coach example says it is not a real customer');
chk('each "your record can\'t show" item says it is live: every one is a Process Coach report today', () => {
  const items = [...COACH.matchAll(/<li><b>([^<]+)<\/b><span>[^<]+<\/span><i class="(livechip|soon)">(Live|Soon)<\/i><\/li>/g)];
  return items.length === 8 && JSON.stringify(items.map(m => m[1])) === JSON.stringify(['Bad wins', 'Good losses', 'Market fit', 'Edge capture', 'Timing', 'Sizing', 'Rules', 'Film room'])
    && items.every(m => m[2] === 'livechip');
});
has(COACH, 'Every finding opens onto the positions behind it', 'and every finding can be checked and challenged (WHY on everything)');
has(FILM, '<span class="ey">Weekly Film Room <span class="livechip">Live</span></span>', 'the Film Room is live');
has(FILM, 'Review your week like game film.', 'the Film Room headline');
['&minus;$126', 'B+', 'The result was worse than the process.', 'Average CLV remained positive.', 'Early CFB spreads', 'Process grade: A', 'Game-day player props', 'Process grade: D+',
 'Best decision', 'Strong price', 'Positive CLV', 'Correct sizing', 'Bad win', 'Poor entry', 'Negative CLV', 'Oversized position', 'Focus: no new CFB sides inside six hours of kickoff.']
  .forEach(t => has(FILM, t, 'the film room shows ' + t));
has(FILM, 'Illustrative sample, not a real customer&rsquo;s week.', 'and its picture says it is a sample');
has(HIST, '<span class="nm">September</span><span class="chips"><span class="tag">Sample data</span></span>', 'the calendar picture is labelled sample data');
has(HIST, 'Your entire betting history. <span class="g">With context.</span>', 'the history headline');
has(HIST, 'Stop relying on memory. See what you did, when you did it, and what happened afterward.', 'the history promise');
['Placed', 'Settled', 'P&amp;L', 'Process'].forEach(t => has(HIST, '<span class="l">' + t + '</span>', 'the calendar day shows ' + t));
['When you entered it', 'Your line, price and stake', 'The result', 'Closing-line value, graded for you', 'EdgeDesk&rsquo;s numbers at that moment', 'Your own notes']
  .forEach(t => has(HIST, '<li>' + t + '</li>', 'the live journal keeps ' + t));
chk('the calendar and per-bet grades are no longer called unfinished: the only thing in development there is account connections',
  (plain(HIST).match(/in development/g) || []).length === 1 && /prediction-market accounts is in development/.test(plain(HIST)));
chk('the sample calendar is September of a real year shape: the 1st on a Tuesday, 30 days, the selected day a Saturday', () => {
  const cells = [...HIST.matchAll(/<td(?: class="sel")?>(?:<span class="d">(\d+)<\/span>)?/g)].map(m => m[1] ? +m[1] : null);
  const first = cells.indexOf(1), sel = +(HIST.match(/<td class="sel"><span class="d">(\d+)/) || [])[1];
  return first === 2 && cells.filter(Boolean).length === 30 && (first + sel - 1) % 7 === 6 && /Saturday, Sept\. 26/.test(HIST) && sel === 26;
});
/* ACCOUNT CONNECTIONS: none is live, so none is claimed */
has(HIST, 'Log a bet by hand, import a CSV export, or read a bet slip screenshot on your own device; the image is never uploaded. Connecting sportsbook and prediction-market accounts is in development.',
  'the three live ways in are named, and connections are described as in development');
has(HIST, 'We won&rsquo;t show any sportsbook or exchange as connected until that connection genuinely works.', 'and the page promises not to overclaim them');
lacks(HIST, 'Connect where you bet', 'the "connect where you bet" headline waits for a connector that works');
chk('no sportsbook or exchange is named as connected, synced or integrated anywhere',
  !/\b(?:DraftKings|FanDuel|BetMGM|Caesars|ESPN BET|Fanatics|bet365|Kalshi|Polymarket|PredictIt|Novig|ProphetX)\b[^.]{0,60}\b(?:connected|synced|integrat\w*|linked)\b/i.test(TEXT)
  && !/\b(?:connected|synced|integrat\w*|linked)\b[^.]{0,40}\b(?:DraftKings|FanDuel|BetMGM|Caesars|ESPN BET|Fanatics|bet365|Kalshi|Polymarket|PredictIt|Novig|ProphetX)\b/i.test(TEXT));
chk('no sportsbook logo or image is on the page', !/<img\b/.test(IDX) && !/logo[^"]*\.(?:png|svg|jpg|webp)/i.test(IDX));
chk('"connected" is only ever said as a refusal', () => [...TEXT.matchAll(/\bconnected\b/gi)].every(m => /won't show|never|not|until/i.test(TEXT.slice(Math.max(0, m.index - 80), m.index))));
/* every place a not-live feature is NAMED in visible copy is a block that
   also carries the label, or a sentence that says so */
[/prediction[- ]market/gi, /\baccount (?:sync|connections?)\b/gi].forEach(re => {
  const bad = [];
  /* a block is a list item, a heading block, a panel, a FAQ answer or
     question; a block may name an unfinished feature only if it carries the
     label, says so in words, or speaks of it in the future tense ("will") —
     and a question the FAQ answers is not a claim */
  const blocks = IDX.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/(?=<(?:li|div class="(?:sig|ins|strip|sec-head|panel-bar|conn|a|hd)"|summary|h[23])\b)/);
  blocks.forEach(b => {
    const t = plain(b); if (!re.test(t)) return; re.lastIndex = 0;
    if (/class="soon"|Sample data|in development|not live|not yet|not available yet|Soon|\bwill\b/i.test(b)) return;
    if (/^<summary>[^<]*\?<\/summary>/.test(b.trim())) return;
    bad.push(t.slice(0, 90));
  });
  /* the sections that are wholly about an unfinished feature carry the label at their heading */
  chk('every mention of ' + re + ' is labelled where it is made', bad.length === 0, bad.slice(0, 3).join(' || '));
});
/* beginner to advanced is now shown, not told: the #model demo's Beginner,
   Research and Lab levels on a real game (the #depth section is gone) */
lacks(IDX, 'id="depth"', 'the depth section made way for the real game');

/* ======================================================================== */
/* 7. THE RESEARCH TERMINAL: LIVE, READ, NEVER TYPED IN                     */
/* ======================================================================== */
const RS = section('research');
has(RS, 'Before you track the decision, <span class="g">research it.</span>', 'the research headline');
has(RS, '<span class="ey">The research terminal <span class="livechip">Live</span></span>', 'and it is the live part of the product');
['EdgeDesk fair line', 'Market line', 'Model gap', 'Win probability', 'Confidence', 'Matchup edge', 'Roster context', 'Weather', 'Player props', 'Best available price']
  .forEach(t => has(RS, '<li><b>' + t + '</b>', 'the terminal shows ' + t));
/* the capabilities are worded to what each league really has */
has(RS, 'A reliability score on college games', 'the reliability score is claimed for college games only');
has(RS, 'Forecasts for college venues', 'weather is claimed for college venues only');
has(RS, 'Where a college team&rsquo;s units hold the advantage', 'matchup edges are claimed for college games only');
has(RS, 'College rosters and player ratings; NFL quarterback rooms', 'rosters are claimed as they are');
has(RS, 'Projections against the line, in an experimental stage.', 'player props are disclosed as experimental');
has(RS, 'Where supported, the best line on file', 'the best price is claimed only where supported');
chk('advanced readers can open the methodology in place', /<details class="deep rv">\s*<summary>For advanced users: how the numbers are built<\/summary>/.test(RS));
has(RS, 'id="today"', 'methodology/\'s #today link still lands on today\'s research');
has(RS, 'id="lpPreview"', 'the live research preview is in the research section');
has(RS, 'EdgeDesk &middot; Research', 'and names itself');
chk('the preview ships as a skeleton, not as numbers', /class="prev-body loading" id="lpPrevBody"/.test(RS) && /class="prev-skel"/.test(RS));
const ILL = (RS.match(/<div class="prev-ill" id="lpPrevIll">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/) || [''])[0];
chk('the fallback example says it is an example, in its own chrome', /Example game &middot; not live/.test(ILL) && (ILL.match(/<small>Example<\/small>/g) || []).length >= 2, ILL.slice(0, 200));
chk('the example is shown only without script or when nothing live exists', /\.js \.prev-ill\{display:none\}/.test(IDX) && /body\.classList\.add\('ill'\)/.test(LANDING));
has(IDX, "fetch(url+'/rest/v1/rpc/public_home_board'", 'the preview is read from public_home_board() (supabase/home_board.sql)');
has(IDX, "fetch('/football/home/board.json'", 'and the props from football/home/board.json');
has(IDX, '<script src="/lib/edgedesk_home.js', 'through the tested view model lib/edgedesk_home.js');
chk('both reads carry a deadline, so a slow network leaves the honest fallback', /withDeadline\(fetch\(url\+'\/rest\/v1\/rpc\/public_home_board'/.test(LANDING) && /withDeadline\(fetch\('\/football\/home\/board\.json'/.test(LANDING));
chk('a failed read shows the example and says the preview could not be reached', /function failAll\(\)/.test(LANDING) && /couldn’t be reached just now/.test(LANDING));
chk('with live games but nothing clearing the gates, the page says PASS is normal and promotes nothing',
  /No game clears EdgeDesk&rsquo;s research gates right now\.<\/b> PASS is a normal answer/.test(LANDING));
const STATS = (RS.match(/<ul class="stats" id="lpStats"[\s\S]*?<\/ul>/) || [''])[0];
['games_analyzed', 'research', 'props_tracked', 'sportsbook_quotes', 'updated'].forEach(k =>
  chk('the statistic ' + k + ' exists and ships hidden', new RegExp('<li data-k="' + k + '"[^>]*hidden>').test(STATS)));
chk('no statistic carries a number in the markup — they are READ', !/<b>\s*[\d,]+\s*<\/b>/.test(STATS) && !/\d+\s*(?:games|props|quotes)/.test(plain(STATS)));
chk('the statistics are filled only from the view model, and a missing one stays hidden',
  /function renderStats\(V\)/.test(LANDING) && /if\(v\)\{ li\.querySelector\('b'\)\.textContent=v; li\.hidden=false; \} else li\.hidden=true;/.test(LANDING));
chk('"worth researching" is the view model\'s selective count in games', /research:n\(c\.worth_researching\)/.test(LANDING));
['RESEARCH', 'WATCH', 'PASS'].forEach(w => has(RS, '>' + w + '</span>', 'the legend defines ' + w));
has(RS, 'worth opening, not a bet', 'RESEARCH is defined as not a bet');
chk('the legend has no DATA INCOMPLETE: the preview never lists one', RS.indexOf('>DATA INCOMPLETE</span>') < 0);
const Home = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));
chk('the view model has exactly the four public words', JSON.stringify(Object.keys(Home.STATUS)) === JSON.stringify(['RESEARCH', 'WATCH', 'PASS', 'DATA_INCOMPLETE']));
chk('the live preview never prints a pick word', !/'(?:BET|LOCK|PICK)'/.test(LANDING) && !/>\s*(?:BET|LOCK|PICK)\s*</.test(LANDING));
chk('the multi-megabyte ratings artifacts are never downloaded', !/fetch\('football\/rankings\/current\.json'/.test(IDX) && !/fetch\('football\/players\/current\.json'/.test(IDX));
chk('a free sample game is one click away', /href="\/research\/sample\/"/.test(RS));

/* ======================================================================== */
/* 8. PRICING: ONE PLAN, FROM ONE SOURCE, ONLY WHAT IS LIVE                 */
/* ======================================================================== */
const PRICE = section('pricing');
chk('one plan card', (IDX.match(/class="pcard\b/g) || []).length === 1);
has(PRICE, 'data-ed-price="plan">' + X.PLAN_NAME + '<', 'the plan is named from the pricing file');
has(PRICE, 'data-ed-price="price">' + X.PRICE_DISPLAY + '<', 'the price is stated from the pricing file');
has(PRICE, 'data-ed-price="trial">' + X.TRIAL_LABEL + '<', 'the trial is stated from the pricing file');
has(PRICE, '$49.99', 'the price is stated');
lacks(PRICE, '$79.99', 'and the retired price is gone');
has(PRICE, 'id="subscribe"', 'the #subscribe anchor app.html sends people to is here');
lacks(PRICE, 'Only $49.99', 'and never apologised for');
[/founding/i, /introductory/i, /\bsale\b/i, /\bdiscount/i, /best value/i, /\bwas \$/i, /normally \$/i]
  .forEach(re => chk('the price is simply the price: ' + re, !re.test(PRICE), (re.exec(PRICE) || [])[0]));
chk('the plan\'s inclusions are the pricing file\'s FEATURES, in order', () => {
  const li = [...(PRICE.match(/<ul class="pincl">([\s\S]*?)<\/ul>/) || [, ''])[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => plain(m[1]).trim());
  return JSON.stringify(li) === JSON.stringify(X.FEATURES);
}, 'the plan card list differs from lib/edgedesk_pricing.js FEATURES');
chk('the plan lists six to eight benefits, not a wall', X.FEATURES.length >= 6 && X.FEATURES.length <= 8, X.FEATURES.length);
chk('and none of them is a feature still in development (account connections, prediction markets)', !X.FEATURES.some(f => /prediction|connect|sync/i.test(f)), X.FEATURES);
chk('the plan names what shipped since: the baseline tools and the Process Coach', ['Compare your number with the model', 'Process Coach and the weekly Film Room'].every(f => X.FEATURES.indexOf(f) >= 0), X.FEATURES);
chk('player props are part of the plan', X.FEATURES.indexOf('Player props') >= 0);
/* FREE BESIDE FULL ACCESS: the free card is lib/edgedesk_plans.js FREE, in
   order; no card on this section lists anything still being built */
const PLANS = require(path.join(ROOT, 'lib', 'edgedesk_plans.js'));
const FREEC = (PRICE.match(/<div class="freecard pcard rv">([\s\S]*?)<div class="pcard rv">/) || [, ''])[1];
chk('a Free card sits beside the plan, before it', FREEC.length > 200 && PRICE.indexOf('freecard') < PRICE.indexOf('id="subscribe"'));
chk('the Free card lists lib/edgedesk_plans.js FREE, in order', () => {
  const li = [...(FREEC.match(/<ul class="pincl free-incl">([\s\S]*?)<\/ul>/) || [, ''])[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => plain(m[1]).trim());
  return JSON.stringify(li) === JSON.stringify(PLANS.FREE.map(f => f.label.replace(/\u2019/g, "'")));
}, 'the Free card differs from lib/edgedesk_plans.js FREE');
has(FREEC, '<span class="pamt">$0</span>', 'free is $0');
chk('the Free card asks for no card and starts no trial', !/startSubscribe|data-ed-price/.test(FREEC) && /href="#free"/.test(FREEC));
PLANS.PLANNED.forEach(f => lacks(PRICE, f.label, 'pricing lists nothing still being built: ' + f.label));
lacks(PRICE, 'class="soon"', 'and marks nothing as coming soon');
has(PRICE, 'One bad habit can cost more than a month of EdgeDesk.', 'the value line');
has(PRICE, 'It can&rsquo;t promise you&rsquo;ll win, and it won&rsquo;t pretend to.', 'and right beside it, no promise');
lacks(PRICE, 'make you more than', 'the price is never justified by promised winnings');
lacks(TEXT, 'pays for itself', 'nor by "pays for itself"');
lacks(TEXT, 'worth every penny', 'no worth-every-penny copy');
chk('no crossed-out price', !/<(?:s|del|strike)>\s*\$/.test(IDX) && !/line-through[^}]*\$/.test(IDX));
[/\bcountdown\b/i, /\blimited time\b/i, /\bhurry\b/i, /\bonly \d+ (?:spots|seats|left)\b/i, /\bexpires? (?:soon|tonight|today)\b/i, /\blimited (?:availability|access)\b/i, /\bprice increase\b/i]
  .forEach(re => chk('no scarcity device: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('no availability limit or scarcity is claimed', !/\bspots? left\b|\bonly \d+ (spots|seats|places)\b|\bwhile (supplies|spots) last\b/i.test(TEXT));
/* the trial terms are the billing system's: a card, 7 days, charged on day 8 */
has(PRICE, '<span data-ed-price="cta">' + X.CTA_LINE + '</span>', 'the trial line is the pricing file\'s');
has(PRICE, 'A card holds the trial. Nothing charged until day <span data-ed-price="day8">' + X.FIRST_CHARGE_DAY + '</span>.', 'the card and the first charge day are stated');
has(PRICE, 'Reminder email', 'and the reminder before conversion');
has(PRICE, 'the exact date your card will be charged', 'which states the charge date');
has(PRICE, 'Unless cancelled before renewal', 'and what day 8 means');
chk('the trial reads Today, Before day 8, Day 8', /<span class="when">Today<\/span>[\s\S]*<span class="when">Before day <span data-ed-price="day8">8<\/span><\/span>[\s\S]*<span class="when">Day <span data-ed-price="day8">8<\/span><\/span><b data-ed-price="monthly">\$49\.99\/month<\/b>/.test(PRICE));
has(PRICE, 'id="edOffer" hidden', 'a creator discount is only ever Stripe\'s own record');

/* ======================================================================== */
/* 9. NO PICKS. NO PROFIT PROMISES. NO INVENTED PROOF. NO SLUDGE.           */
/* ======================================================================== */
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
 /\bsteam\b/i, /\bwait for sharps\b/i, /\bstart winning\b/i, /\bget picks\b/i, /\bparlay\b/i]
  .forEach(re => { const o = claimsIt(re); chk('no tout phrase is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
[/\bguarantee[sd]? (?:you )?(?:a )?(?:profit|win|return)/i, /\bwin rate of\b/i, /\broi of\b/i, /\bprofit(?:able)? every\b/i, /\bmake (?:you )?money\b/i]
  .forEach(re => { const o = claimsIt(re); chk('no profit promise is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
has(TEXT, 'it does not guarantee profit', 'the page says EV does not guarantee profit');
has(TEXT, 'no picks, no locks, no guaranteed winners', 'and lists what it will never sell');
has(TEXT, 'EdgeDesk does not promise winning bets.', 'and says it does not promise winning bets');
chk('"Research, not picks" is said at the top, in the middle and at the close', (TEXT.match(/Research, not picks/g) || []).length >= 4);
[/\brevolutionary\b/i, /\bcutting-edge\b/i, /\bnext-generation\b/i, /\bAI-powered\b/i, /\bunlock your\b/i, /\becosystem\b/i, /\bmaximi[sz]e alpha\b/i,
 /\belevate your\b/i, /\bgame-?changing\b/i, /\bultimate platform\b/i, /\bseamless\b/i, /\bsupercharge\b/i]
  .forEach(re => chk('no marketing sludge: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
/* social proof: only what is real. EdgeDesk has no verified testimonials, no
   public subscriber count and no customer results — so none is shown. */
[/\b\d[\d,]*\+? (?:happy )?(?:customers|subscribers|members|users|bettors) (?:trust|use|love|rely)/i, /\btestimonial/i, /\bas seen on\b/i,
 /\b\d+% win rate\b/i, /\bunits? (?:won|profit)\b/i, /\bmade \$[\d,]+/i, /\b\d[\d,]*\+? (?:bettors|users|subscribers)\b/i, /★|&#9733;|\bstars?\b rating/i,
 /\b(?:customer|user|app store|5-star|five-star) reviews?\b/i, /\b\d[\d,.]* (?:star )?reviews\b/i, /\brated \d/i]
  .forEach(re => chk('no unprovable claim ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
chk('structured data claims no rating and no review', !/aggregateRating|"review"/i.test(IDX));
chk('no quoted customer anywhere: the only quotation is the publisher\'s credit', (IDX.match(/<q>/g) || []).length === 1 && /<q>Data and model analysis powered by EdgeDeskSports\.com\.<\/q>/.test(IDX));
chk('every sample number is someone\'s: never "our users", "customers" or "members" beside a figure', !/\b(?:our|EdgeDesk) (?:users|customers|members|subscribers)\b/i.test(TEXT));
/* trust headline: confident, without profanity */
const TR = section('trust');
has(TR, 'No locks. No guarantees. <span class="g">Just the research.</span>', 'the trust headline');
chk('no profanity anywhere on the page', !/\b(?:bullshit|bs|damn|hell|shit|crap)\b/i.test(TEXT), (TEXT.match(/\b(?:bullshit|bs|damn|hell|shit|crap)\b/i) || [])[0]);
has(TR, 'It gives you research, market context, tracking and evidence about your own decision process.', 'the trust promise');
has(TR, 'Anything marked in development on this page is not in the product yet.', 'and the page\'s own labelling rule is stated');
has(TR, 'href="/record.html"', 'the public record stays linked');
has(IDX, 'id="record"', 'and old #record links still land in the right place');
chk('the record panel is filled from the database, with an honest fallback', /id="proofInner"/.test(IDX) && /Opens as you scroll here/.test(IDX));
chk('the record panel loads only when a reader nears it', /\(function lazyProof\(\)/.test(IDX) && /rootMargin:'600px 0px'/.test(IDX));
has(TR, 'EdgeDesk&rsquo;s record &middot; live', 'and it says it is EdgeDesk\'s own record, not a customer\'s');

/* ======================================================================== */
/* 10. THE FAQ                                                              */
/* ======================================================================== */
const FAQ = section('faq');
const QS = [...FAQ.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => plain(m[1]).trim());
['Is EdgeDesk a picks service?', 'What can I use for free?', 'Does EdgeDesk guarantee I\'ll make money?', 'What if I disagree with EdgeDesk\'s number?', 'Can beginners and advanced bettors both use it?',
 'What sports are currently supported?', 'Can I connect my sportsbook or prediction-market account?', 'Which features are still in development?', 'How does the 7 -day trial work?', 'Can I cancel anytime?']
  .forEach(q => chk('the FAQ answers: ' + q, QS.indexOf(q) >= 0, QS.join(' | ')));
function answer(q) { const i = QS.indexOf(q); const all = [...FAQ.matchAll(/<div class="a">([\s\S]*?)<\/div>/g)]; return i < 0 || !all[i] ? '' : plain(all[i][1]).trim(); }
chk('a picks service? No. Research, not picks.', /^No\. Research, not picks\./.test(answer('Is EdgeDesk a picks service?')));
chk('guaranteed money? No.', /^No\b/.test(answer('Does EdgeDesk guarantee I\'ll make money?')));
chk('sports: football first, the NFL and NCAA FBS', /^Football: the NFL and NCAA FBS/.test(answer('What sports are currently supported?')));
chk('and the other sports the terminal carries, with no value claim for any of them',
  /The terminal also carries research on the NHL, NBA, MLB, college baseball and UFC; where those sports have a model, it is checked against results on seasons it never saw but not yet against the market, so they make no value claims\./.test(answer('What sports are currently supported?')));
chk('connections: not yet; by hand, CSV or screenshot today', /^Not yet\. Today you log a bet by hand, import a CSV export, or read a bet slip screenshot on your own device/.test(answer('Can I connect my sportsbook or prediction-market account?')));
chk('the in-development list names what is still unfinished, and only that', /^Sportsbook and prediction-market account connections, and a dashboard and saved research for free accounts\./.test(answer('Which features are still in development?'))
  && !/Process Coach|Film Room|calendar/.test(answer('Which features are still in development?')));
chk('disagreeing with the model: welcome, and measured', /^Good: that's what it's for\. EdgeDesk is a baseline, not an oracle\./.test(answer('What if I disagree with EdgeDesk\'s number?')) && /how far yours and EdgeDesk's each landed from the close/.test(answer('What if I disagree with EdgeDesk\'s number?')));
chk('beginners and advanced: yes, both', /^Yes\./.test(answer('Can beginners and advanced bettors both use it?')) && /For advanced bettors: Fair lines/.test(answer('Can beginners and advanced bettors both use it?')));
chk('what is free: no account, no card, and what Full Access adds', /^No account, no card/.test(answer('What can I use for free?')) && /Full Access adds/.test(answer('What can I use for free?')));
chk('the FAQ is short: at most a dozen product questions', QS.length <= 12, QS.length);
has(FAQ, 'Re-check my subscription now', 'the self-serve billing re-check survives');
has(FAQ, 'reopen signup', 'and the confirmation-email help');
/* COVERAGE: football leads; the terminal's other sports are named ONCE, in
   the FAQ answer that says none makes a value claim. Retired or uncovered
   sports never appear. */
[/\bevery sport\b/i, /\ball sports\b/i, /\bWNBA\b/, /\btennis\b/i, /\bgolf/i, /\bsoccer\b/i]
  .forEach(re => chk('coverage is never overstated: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
{
  const sportsA = answer('What sports are currently supported?'), rest = TEXT.split(sportsA).join(' ');
  [/\bMLB\b/, /\bNBA\b/, /\bNHL\b/, /\bUFC\b/, /\bbaseball\b/i]
    .forEach(re => chk('another sport is named only in the coverage answer: ' + re, re.test(sportsA) && !re.test(rest), (re.exec(rest) || [])[0]));
}
has(IDX, 'carried as unknown, never as healthy', 'unknown is not healthy');
has(IDX, 'A stale price is not compared', 'a stale market is not a price');
has(IDX, 'Layers that have not cleared validation move no line', 'the unvalidated layers move no line');
[/\bEV Engine\b/, /\bBet EV\b/, /\bExpected Value Tool\b/i, /\bEdge Calculator\b/i, /\bValue Score\b/i]
  .forEach(re => chk('EdgeDesk EV is never renamed: ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));
has(IDX, 'Expected value estimates the theoretical return of repeatedly taking the same price if EdgeDesk&rsquo;s probability is accurate',
  'expected value is explained once, in plain English');

/* ======================================================================== */
/* 11. ONE PRIMARY CALL TO ACTION                                           */
/* ======================================================================== */
const NAV = section('nav', 'nav');
chk('the site nav is found', NAV.length > 400);
/* the site's primary navigation (lib/edgedesk_nav.js), free research first;
   tools/site/nav.test.js holds every public page to the same five */
['Free Research', 'Today&rsquo;s Games', 'Tools', 'Research Terminal', 'Pricing'].forEach(l => has(NAV, '>' + l + '<', 'the nav offers ' + l));
chk('free research leads the nav, pricing closes it',
  NAV.indexOf('>Free Research<') >= 0 && NAV.indexOf('>Free Research<') < NAV.indexOf('>Pricing<'));
chk('the nav CTA is "Start free trial"', /id="navSignup"[^>]*>Start free trial</.test(NAV));
has(NAV, 'id="navLogin"', 'Log in keeps the id bootAuthState rewrites');
chk('the phone menu is a real disclosure', /aria-controls="navMenu"/.test(NAV) && /aria-expanded="false"/.test(NAV));
const MARKUP = IDX.replace(/<script[\s\S]*?<\/script>/g, ' ');
const TRIAL = [...MARKUP.matchAll(/<button\b[^>]*onclick="startSubscribe\(\)"[^>]*>([^<]*)/g)].map(m => m[1].trim());
chk('a trial button in the nav, the hero, the pricing card, the close and the phone bar', TRIAL.length >= 5, TRIAL.join(' | '));
chk('and every one of them says exactly "Start free trial"', TRIAL.every(t => t === 'Start free trial'), TRIAL.join(' | '));
chk('the free trial is never called free without the word trial', !/>\s*Start free\s*</.test(IDX) && !/>\s*Try (?:it )?free\s*</i.test(IDX));
[/>\s*Start researching/, />\s*Get started/i, />\s*Join now/i, />\s*Unlock/i, />\s*Try EdgeDesk/i, />\s*Subscribe\b/i, />\s*Begin research/i, />\s*Start 7 days free/, />\s*Start winning/i, />\s*Get picks/i]
  .forEach(re => chk('no competing CTA verb: ' + re, !re.test(IDX), (re.exec(IDX) || [])[0]));
chk('"See how it works" is the only secondary action in the hero', (HERO.match(/class="btn ghost lg"/g) || []).length === 1);

/* ======================================================================== */
/* 12. THE HIERARCHY                                                        */
/* ======================================================================== */
const ORDER = ['top', 'free', 'model', 'research', 'why', 'how', 'coach', 'film', 'history', 'pricing', 'trust', 'faq', 'start'];
ORDER.forEach(id => has(IDX, 'id="' + id + '"', 'the ' + id + ' section exists'));
chk('hero → free research → the baseline on real games → the live research preview → why results aren\'t enough → the loop → Process Coach → Film Room → history → free + pricing → trust → FAQ → close',
  ORDER.every((id, i) => i === 0 || IDX.indexOf('id="' + id + '"') > IDX.indexOf('id="' + ORDER[i - 1] + '"')));
chk('every section earns its place: twelve sections and the hero, no more', (IDX.match(/<section\b/g) || []).length === 12, (IDX.match(/<section\b/g) || []).length);
chk('free research comes before any subscription pitch', IDX.indexOf('id="free"') < IDX.indexOf('id="why"') && IDX.indexOf('id="free"') < IDX.indexOf('id="pricing"'));
['id="game"', 'id="ev"', 'id="evSlider"', 'id="tabs"', 'id="lpEvData"'].forEach(x =>
  lacks(IDX, x, 'the technical walk-through lives on /methodology/: ' + x));
const FIN = section('start');
has(FIN, 'Research, not picks.', 'the close opens on the philosophy');
has(FIN, 'Build a process you can <span class="g">actually measure.</span>', 'the close headline');
has(FIN, 'Research the game. Track your decisions. Learn what works.', 'the close in three verbs');
has(FIN, '<p class="fprice rv" data-ed-price="monthly">$49.99/month</p>', 'the close states the price');
has(FIN, '<span data-ed-price="cta">' + X.CTA_LINE + '</span>', 'and the real trial terms under the button');

/* ======================================================================== */
/* 13. FEATURED IN — MEDIA ATTRIBUTION, STATED EXACTLY                      */
/* ======================================================================== */
const MED = (function () {
  const a = IDX.indexOf('id="featured"');
  if (a < 0) return '';
  const note = IDX.indexOf('class="press-note"', a);
  return IDX.slice(IDX.lastIndexOf('<', a), note < 0 ? a : IDX.indexOf('</p>', note) + 4);
})();
chk('the featured-in block exists', MED.length > 800, 'length ' + MED.length);
chk('and it sits inside the trust section', IDX.indexOf('id="featured"') > IDX.indexOf('id="trust"') && IDX.indexOf('id="featured"') < IDX.indexOf('id="faq"'));
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
/* 14. RESPONSIBLE GAMBLING AND THE LEGAL LINKS                             */
/* ======================================================================== */
chk('21+ is stated at the offer, the price card, the close and the footer', (TEXT.match(/21\+/g) || []).length >= 4);
chk('1-800-GAMBLER is on the page more than once', (TEXT.match(/1-800-GAMBLER/g) || []).length >= 3);
has(IDX, 'ncpgambling.org', 'the national resource is linked');
has(TEXT, 'Research and decision-support tool', 'the product is named for what it does');
lacks(TEXT, 'never tells you what to bet', 'and never claims EdgeDesk makes no decision, beside a terminal that says BET, LEAN, WATCH or PASS');
['/terms.html', '/privacy.html', '/disclaimer.html'].forEach(h => has(IDX, 'href="' + h + '"', 'the footer links ' + h));
has(IDX, 'data-ed-report', 'a visitor can report a problem');

/* ======================================================================== */
/* 15. SEARCH AND SOCIAL                                                    */
/* ======================================================================== */
has(IDX, '<title>EdgeDesk Sports | Free Football Research + Bet Tracking</title>', 'the title names both halves of the product, free research first');
const DESC = (IDX.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '';
chk('the description is search-length', DESC.length >= 110 && DESC.length <= 160, DESC.length);
chk('and names what it researches and tracks, free first', /^Free /.test(DESC) && /NFL/.test(DESC) && /college football/.test(DESC) && /player props/.test(DESC) && /log your bets/.test(DESC) && /Research, not picks/.test(DESC));
has(IDX, '<link rel="canonical" href="https://edgedesksports.com/">', 'the canonical URL is the root');
['og:title', 'og:description', 'og:url', 'og:type', 'twitter:card', 'twitter:title', 'twitter:description']
  .forEach(k => chk('social metadata: ' + k, new RegExp('(property|name)="' + k + '" content="[^"]{5,}"').test(IDX)));
chk('no metadata advertises a feature that is not live', !/(?:property|name)="(?:og|twitter):[a-z]+" content="[^"]*(?:prediction market|connect)/i.test(IDX)
  && !/<meta name="description" content="[^"]*(?:prediction market|connect)/i.test(IDX));
chk('the structured data parses and offers the price the pricing file states', () => {
  const j = JSON.parse((IDX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]);
  const app = j['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  const price = X.PRICE_DISPLAY.replace(/^\$/, '');
  return /var PRICE_DISPLAY=EDP\?EDP\.PRICE_DISPLAY:'';/.test(IDX) && price === '49.99'
    && app && app.offers && app.offers.price === price && app.offers.priceCurrency === X.CURRENCY
    && app.offers.description === X.TRIAL_DAYS + '-day free trial, then ' + X.PRICE_DISPLAY + ' per ' + X.BILLING_PERIOD + '. Cancel anytime.'
    && !/prediction|connect/i.test(app.description);
});

/* ======================================================================== */
/* 16. THE METHODOLOGY PAGE                                                 */
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
