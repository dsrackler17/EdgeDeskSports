#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — positioning and honesty.

   EdgeDesk became a football research terminal; the landing page was still
   selling a cross-sport odds board. These tests hold the new positioning and,
   more importantly, hold the line on what a marketing page is never allowed
   to say:

     1  the hero answers the five-second questions;
     2  the product visual is the product — every field the app renders;
     3  nothing anywhere promises profit, and no tout word appears;
     4  no metric is claimed that EdgeDesk cannot prove — no testimonials,
        no customer counts, no ROI, no win rate;
     5  live numbers are READ from the committed artifacts, never frozen
        into the page, so marketing cannot drift from the product;
     6  the unvalidated layers are disclosed on the marketing page too.

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
const TEXT = IDX.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

/* ======================================================================== */
/* 1. THE HERO ANSWERS THE FIVE-SECOND QUESTIONS                            */
/* ======================================================================== */
/* Content the reader sees now lives in the page's own script modules as
   often as in its markup — the hero card, the walkthrough and the
   uncertainty panel are all rendered from data. Slicing the module by brace
   matching keeps every assertion pointed at the exact source of the words a
   reader ends up reading, rather than at whichever half of the file they
   happen to sit in today. */
function mod(name) {
  const i = IDX.indexOf('(function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = i, started = false;
  for (; j < IDX.length; j++) {
    const c = IDX[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) break; }
  }
  return IDX.slice(i, j + 1);
}
chk('the hero card module is found', mod('heroGames').length > 800);
chk('the walkthrough module is found', mod('stepper').length > 800);
chk('the uncertainty module is found', mod('idk').length > 800);

const HERO = IDX.slice(IDX.indexOf('<header class="hero"'), IDX.indexOf('</header>')) + mod('heroGames');
chk('the hero is found', HERO.length > 500);
has(HERO, 'Research the matchup.', 'what EdgeDesk does, line one');
has(HERO, 'Then price it.', 'and line two');
has(HERO, 'Football research terminal', 'the category is named');
has(HERO, 'NFL + FBS', 'and the scope');
has(HERO, 'the model, the market, the roster, the players, the matchup', 'the layers are named');
has(HERO, 'Instead of', 'what it replaces is stated');
['10 tabs', '5 sites', 'a spreadsheet'].forEach(t => has(HERO, t, 'it replaces ' + t));
has(HERO, 'Start researching', 'the primary CTA is a research verb');
has(HERO, 'See what is inside', 'and a secondary CTA into the product');
has(HERO, 'Research, not picks.', 'the differentiator is in the hero');
has(HERO, '$79.99/month', 'and the price is stated plainly');
lacks(HERO, 'Which betting lines', 'the old cross-sport positioning is gone');
lacks(HERO, 'Competitive golfer', 'and the golf hook with it');
lacks(IDX, "golf, MLB, WNBA, CFB, CBB", 'and the sport list it rewrote the hero to');

/* ======================================================================== */
/* 2. THE PRODUCT IS THE VISUAL                                             */
/* ======================================================================== */
['Baylor @ Auburn', 'EdgeDesk', 'Market', 'Difference', 'Projected score',
 'Win probability', 'Research state', 'Data confidence', 'What this means',
 'Research check', 'Why EdgeDesk prices it here']
  .forEach(f => has(HERO, f, 'the hero card shows "' + f + '"'));
['PASS', 'REVIEW', 'INVESTIGATE'].forEach(s =>
  has(HERO, "state:'" + s + "'", 'the hero offers the research state ' + s));
chk('the hero switcher names all three, so the product does not look like it finds edges everywhere',
  /Model agrees/.test(HERO) && /Small gap/.test(HERO) && /Large gap/.test(HERO));
chk('the agreeing game is the one shown first',
  HERO.indexOf("state:'PASS'") < HERO.indexOf("state:'REVIEW'"));
has(HERO, 'That is agreement. There is nothing here to research further',
  'and the PASS game says plainly there is nothing to do');
has(HERO, 'read as missing information rather than as an opportunity',
  'while the large gap is a question, not a discovery');
has(HERO, 'past EdgeDesk&rsquo;s own guard bound', 'named against the guard bound');
has(HERO, 'Illustrative game', 'and says the game is illustrative');
chk('the card shows a model number and a market number that differ',
  /Auburn -9\.7/.test(HERO) && /Auburn -8\.0/.test(HERO));
chk('the research check shows knowns AND unknowns',
  /\['ok',/.test(HERO) && /\['warn',/.test(HERO) && /\['neg',/.test(HERO));
has(HERO, 'starting quarterback', 'including the quarterback it does not know');
/* the card must not imply the unvalidated layers price the game */
has(HERO, 'neither has cleared validation', 'the hero discloses the unvalidated layers');
has(HERO, 'moves a projected line', 'and that they move no line');
has(HERO, 'Nothing here tells you what to bet', 'and that the card is not a bet');

/* ======================================================================== */
/* 3. NO TOUT LANGUAGE, ANYWHERE ON THE PAGE                                */
/* ======================================================================== */
/* A page that REFUSES to promise profit has to be able to say the words it
   refuses. "It does not guarantee profit" and a "What you are not buying"
   list containing "Guaranteed winners" are the honest use of these phrases,
   and a checker that cannot tell a claim from a denial would push the page
   into being LESS explicit about what it is not. So: find every occurrence,
   and fail only on one that is not negated and not inside the not-buying
   list. */
const NOTBUY = (function () {
  const a = IDX.indexOf('What you are not buying');
  const b = a < 0 ? -1 : IDX.indexOf('</ul>', a);
  return a < 0 ? '' : IDX.slice(a, b);
})();
chk('the page carries an explicit "what you are not buying" list', NOTBUY.length > 40);
const NEG = /\b(?:not|never|no|nobody|nothing|without|refus\w*|cannot|can't|doesn't|does not|isn't|won't)\b[^.]{0,60}$/i;
function claimsIt(re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m, offenders = [];
  while ((m = g.exec(TEXT))) {
    const before = TEXT.slice(Math.max(0, m.index - 70), m.index);
    if (NEG.test(before)) continue;                       /* a denial */
    if (NOTBUY.indexOf(m[0]) >= 0) continue;              /* the not-buying list */
    offenders.push('…' + before.slice(-46) + '[' + m[0] + ']');
  }
  return offenders;
}
[/\bLOCKS?\b/, /\bbest bet\b/i, /\bcan'?t miss\b/i, /\bsure thing\b/i, /\bguaranteed win/i,
 /\bguaranteed profit/i, /\bmortal lock\b/i, /\bfree money\b/i,
 /\bnever lose\b/i, /\bwe'?ll make you money\b/i, /\bprofit guarantee/i]
  .forEach(re => { const o = claimsIt(re);
    chk('no tout phrase is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
/* profit promises */
[/\bguarantee[sd]? (?:you )?(?:a )?(?:profit|win|return)/i, /\bwin rate of\b/i,
 /\broi of\b/i, /\bprofit(?:able)? every\b/i]
  .forEach(re => { const o = claimsIt(re);
    chk('no profit promise is CLAIMED: ' + re, o.length === 0, o.slice(0, 2).join(' || ')); });
/* and the denials themselves must still be there — the honest half */
has(TEXT, 'does not guarantee profit', 'the page still says CLV does not guarantee profit');
has(NOTBUY, 'Guaranteed winners', 'and still lists guaranteed winners as something you are not buying');

/* ======================================================================== */
/* 4. NO UNPROVABLE CLAIMS                                                  */
/* ======================================================================== */
[/\b\d[\d,]* (?:happy )?(?:customers|subscribers|members|users) (?:trust|use|love)/i,
 /\btestimonial/i, /\bas seen on\b/i, /\b\d+% win rate\b/i, /\bunits? (?:won|profit)\b/i,
 /\bmade \$[\d,]+/i]
  .forEach(re => chk('no unprovable claim ' + re, !re.test(TEXT), (re.exec(TEXT) || [])[0]));

/* ======================================================================== */
/* 5. LIVE NUMBERS COME FROM THE ARTIFACTS, NOT THE SOURCE                  */
/* ======================================================================== */
has(IDX, "fetch('football/rankings/current.json'", 'the power ratings load from the committed artifact');
has(IDX, "fetch('football/players/current.json'", 'and the player counts too');
chk('the ratings board is not frozen into the markup',
  !/Notre Dame|Ohio State|Indiana|Georgia|Oregon/.test(IDX.slice(IDX.indexOf('id="lpRatings"'), IDX.indexOf('id="lpRatings"') + 600)));
chk('and neither is a player count',
  !/15,?488|15488/.test(IDX));
has(IDX, 'id="lpRatings"', 'the ratings host exists');
/* a team name is ESCAPED, not stripped: stripping rendered Texas A&M as
   "Texas AM" on a page whose argument is that it does not distort the product */
chk('team names are escaped rather than stripped',
  /function esc\(v\)\{ return String\(v\)\.replace\(\/\[&<>"\]\/g/.test(IDX)
  && !/String\(t\.team\)\.replace\(\/\[&<>"\]\/g,''\)/.test(IDX));
has(IDX, 'id="lpPlayers"', 'the player-count host exists');
has(IDX, 'id="lpTeams"', 'the team-count host exists');
chk('a failed artifact read leaves the honest fallback',
  /\.catch\(function\(\)\{\}\)/.test(IDX));
chk('nothing ranked leaves the fallback rather than an empty board',
  /if\(!teams\.length\) return;/.test(IDX));
/* the artifacts it reads actually carry those fields */
const RK = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
const PQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'current.json'), 'utf8'));
chk('the rankings artifact has a ranked board to read',
  Object.keys(RK.teams || {}).some(k => RK.teams[k] && RK.teams[k].rank != null && RK.teams[k].etsr != null));
chk('the players artifact has the counts the page asks for',
  typeof PQ.player_count === 'number' && typeof PQ.team_count === 'number',
  JSON.stringify({ p: PQ.player_count, t: PQ.team_count }));

/* ======================================================================== */
/* 6. THE HONEST SECTIONS                                                   */
/* ======================================================================== */
['compress', 'getyou', 'notpicks', 'steps', 'idk', 'ours', 'who', 'close']
  .forEach(id => has(IDX, 'id="' + id + '"', 'the ' + id + ' section exists'));
/* the workflow never tells a reader to bet */
const STEPS = IDX.slice(IDX.indexOf('id="steps"'), IDX.indexOf('id="idk"')) + mod('stepper');
['PASS', 'REVIEW', 'INVESTIGATE', 'THIN DATA'].forEach(v =>
  has(STEPS, v, 'the workflow ends in the state ' + v));
[/>\s*BET\s*</, /\bLOCK\b/, /\bPLAY\b/].forEach(re =>
  chk('the workflow never says ' + re, !re.test(STEPS)));
has(STEPS, 'Decide for yourself', 'and the last step hands the decision back');
/* the model may say I don't know */
const IDK = IDX.slice(IDX.indexOf('id="idk"'), IDX.indexOf('id="ours"')) + mod('idk');
has(IDK, 'Unknown is never treated as healthy', 'unknown is not healthy');
has(IDK, 'Missing is not zero', 'missing is not zero');
has(IDK, 'cleared walk-forward validation', 'the unvalidated layers are named');
has(IDK, 'moves a projected line anywhere in the product', 'and stated to move no line');
has(IDK, 'a guess is never substituted for it', 'and no guess is substituted');
/* every condition states the RULE that fires, not just the intention —
   an intention is a disclaimer, a rule is a behaviour */
chk('each uncertainty condition carries the rule it triggers',
  (mod('idk').match(/\br:'/g) || []).length === (mod('idk').match(/\bk:'/g) || []).length
  && (mod('idk').match(/\br:'/g) || []).length >= 6);
/* The two worked examples became the hero switcher, so the reader meets a
   PASS and an INVESTIGATE in the first screen rather than eight screens
   down. The badge class stays namespaced: a bare .verdict belongs to an
   animated component that starts at opacity 0, and reusing the name once
   rendered both research states invisible. */
chk('the research-state badge does not reuse the animated .verdict class',
  !/<span class="verdict">/.test(IDX) && !/'verdict'/.test(mod('heroGames')));
chk('the state badge is rendered from the state tone, not hand-written markup',
  /class="st '\+g\.stateTone\+'"/.test(mod('heroGames')));
/* not a picks service */
const NP = IDX.slice(IDX.indexOf('id="notpicks"'), IDX.indexOf('id="steps"'));
has(NP, 'not paying for', 'the differentiator is stated');
has(NP, 'somebody else&rsquo;s pick', 'in those words');
has(NP, 'Research the matchup. Then price it.', 'and closes on the positioning line');

/* ======================================================================== */
/* 7. NAVIGATION AND THE CLOSE                                              */
/* ======================================================================== */
const NAV = (function () {
  const a = IDX.indexOf('<nav>');                 /* the site nav; the reading
     rail above it is <nav class="lp-rail">, so match the bare tag */
  return a < 0 ? '' : IDX.slice(a, IDX.indexOf('</nav>', a));
})();
chk('the site nav is found', NAV.length > 200);
['Product', 'How it works', 'Record', 'Pricing'].forEach(l =>
  has(NAV, '>' + l + '<', 'the nav offers ' + l));
has(NAV, 'Start researching', 'and its CTA is a research verb');
lacks(NAV, 'Engines', 'internal vocabulary is out of the marketing nav');
lacks(NAV, 'Football model', 'and so is the old model link');
const CLOSE = IDX.slice(IDX.indexOf('id="close"'), IDX.indexOf('id="pricing"'));
has(CLOSE, 'You could do this research', 'the close concedes the reader could do it themselves');
has(CLOSE, 'spend your Saturday', 'and names the real trade');
has(CLOSE, 'Start researching', 'and closes on the CTA');

/* ======================================================================== */
/* 8. PRICING IS STATED, NOT APOLOGISED FOR                                 */
/* ======================================================================== */
const PRICE = IDX.slice(IDX.indexOf('id="pricing"'));
has(PRICE, '$79.99', 'the price is stated');
lacks(PRICE, 'Only $79.99', 'and never apologised for');
lacks(TEXT, 'worth every penny', 'no worth-every-penny copy');
has(PRICE, 'not a promise of profit', 'the price is not sold as profit');
has(PRICE, 'pincl', 'and what it includes is itemised');
['Game research', 'EdgeDesk power ratings', 'Player research', 'Simulations',
 'The public pre-kickoff record', 'Copyable research briefs']
  .forEach(f => has(PRICE, f, 'the list includes ' + f));

/* ======================================================================== */
/* 9. IT STAYS A STATIC PAGE                                                */
/* ======================================================================== */
chk('the landing page loads no application bundle',
  !/src="app\.js|src="\/app\.|import\s+.*from\s+['"]https?:/.test(IDX));
chk('and adds only the two artifact reads',
  (IDX.match(/fetch\('football\//g) || []).length === 2,
  'found ' + (IDX.match(/fetch\('football\//g) || []).length);
chk('no edge function was added for the landing page',
  !/functions\/v1\/[a-z_]*landing/.test(IDX));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding positioning: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
