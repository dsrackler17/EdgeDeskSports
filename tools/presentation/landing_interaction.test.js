#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — interaction, accessibility and weight.

   The page used to explain every layer of the product at once: thirty
   sections, eleven switchers, a self-advancing walkthrough and a reading
   rail to find your way through it. It now tells one story in thirteen
   blocks, and the few things a reader operates (the menu, one game's tabs,
   the EdgeDesk EV price check) have to be worth operating. These tests hold:

     1  each interaction exists, and bails out cleanly if its host is gone;
     2  each is keyboard-operable and announces itself;
     3  nothing moves under prefers-reduced-motion, nothing loops, and
        nothing is hidden from a reader whose script never ran;
     4  the sections the redesign removed stay removed, with no anchor,
        module or CSS rule left pointing at them;
     5  no interaction fabricates a number or reaches the network for one;
     6  the page stays light.

   Run: node tools/presentation/landing_interaction.test.js
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
const CSS = IDX.slice(IDX.indexOf('<style>'), IDX.indexOf('</style>'));

/* Slice one IIFE module out of the page by brace matching. */
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
/* the presentation script: everything after the preserved production block */
const LANDING = (function () {
  const a = IDX.indexOf('LANDING PAGE INTERACTIONS');
  return a < 0 ? '' : IDX.slice(a, IDX.indexOf('</script>', a));
})();
chk('the presentation script is found, after the production block',
  LANDING.length > 2000 && IDX.indexOf('LANDING PAGE INTERACTIONS') > IDX.indexOf('PRESERVED PRODUCTION BLOCK'));

/* ======================================================================== */
/* 1. EACH INTERACTION EXISTS AND FAILS SOFT                                */
/* ======================================================================== */
const MODULES = {
  navMenu:     { host: 'id="navBurger"',  what: 'the phone menu opens and closes' },
  gameTabs:    { host: 'role="tablist"',  what: 'one game is read tab by tab' },
  evDemo:      { host: 'id="evSlider"',   what: 'the EdgeDesk EV price check is operated' },
  pricingView: { host: 'id="pricing"',    what: 'reaching the price is measured' },
  reveals:     { host: 'class="',         what: 'blocks enter once, quietly' }
};
Object.keys(MODULES).forEach(m => {
  chk(MODULES[m].what, mod(m).length > 150, m + ' module is missing or a stub');
  has(IDX, MODULES[m].host, 'and its host exists: ' + MODULES[m].host);
});
['navMenu', 'gameTabs', 'evDemo', 'pricingView'].forEach(m =>
  chk(m + ' returns early if its host is gone', /if\s*\(\s*!\w+(?:\s*\|\|\s*!\w+)*\s*\)\s*return;/.test(mod(m))));
chk('the EV demo survives a malformed data block', /try\{\s*D=JSON\.parse\([^)]*\);\s*\}catch\(e\)\{\s*return;\s*\}/.test(mod('evDemo')));
chk('and says so, rather than showing stale numbers, if the engine cannot load',
  /\.catch\(failed\)/.test(mod('evDemo')) && /UNAVAILABLE/.test(mod('evDemo')));

/* ======================================================================== */
/* 2. KEYBOARD AND SEMANTICS                                                */
/* ======================================================================== */
const TABS = mod('gameTabs');
['ArrowRight', 'ArrowLeft', 'Home', 'End'].forEach(k => chk('the game tabs answer ' + k, TABS.indexOf("'" + k + "'") >= 0));
chk('and wrap at both ends', /%tabs\.length/.test(TABS));
chk('focus moves with the selection', /\.focus\(\)/.test(TABS));
chk('the selection is announced and focus is roving', /aria-selected/.test(TABS) && /tabIndex=on\?0:-1/.test(TABS));
chk('every tab names the panel it controls and every panel names its tab', () => {
  const tabs = [...IDX.matchAll(/role="tab" id="([^"]+)" aria-controls="([^"]+)"/g)];
  return tabs.length === 3 && tabs.every(t => new RegExp('id="' + t[2] + '" aria-labelledby="' + t[1] + '"').test(IDX));
});
chk('only the first panel is open to begin with', (IDX.match(/role="tabpanel"[^>]*hidden>/g) || []).length === 2);
const NAVM = mod('navMenu');
chk('the menu reports its state', /aria-expanded/.test(NAVM) && /aria-label/.test(NAVM));
chk('Escape closes the menu and returns focus to its button', /'Escape'/.test(NAVM) && /btn\.focus\(\)/.test(NAVM));
chk('a tap outside, a link inside or a wide screen closes it', /!nav\.contains\(e\.target\)/.test(NAVM) && /closest\('a,button'\)/.test(NAVM) && /innerWidth>900/.test(NAVM));
chk('the price slider has a real label', /<label for="evSlider">/.test(IDX));
chk('and states its value in words, not just a position', /aria-valuetext/.test(IDX) && /setAttribute\('aria-valuetext'/.test(mod('evDemo')));
chk('the price check announces its verdict politely', /id="evState" role="status" aria-live="polite"/.test(IDX));
chk('the three example prices are toggle buttons', (IDX.match(/<button type="button" data-price="-?\d+" aria-pressed="false">/g) || []).length === 3);
chk('every control is a real button or link, never a clickable div', !/<(?:div|span|li)[^>]*\sonclick=/.test(IDX));
const MARKUP = IDX.replace(/<script[\s\S]*?<\/script>/g, ' ');
chk('every button in the markup says what kind it is', (MARKUP.match(/<button\b(?![^>]*type=)[^>]*>/g) || []).length === 0,
  (MARKUP.match(/<button\b(?![^>]*type=)[^>]*>/g) || []).slice(0, 3).join(' '));
chk('the answers are native <details>, so they work without script', (IDX.match(/<details>/g) || []).length >= 10);
chk('there is a skip link to the main content', /<a class="skip" href="#main">/.test(IDX) && /<main id="main">/.test(IDX));
chk('focus is always visible', /:focus-visible\{outline:2px solid var\(--obs\)/.test(CSS));
chk('there is exactly one h1, and it is the hero line', (IDX.match(/<h1\b/g) || []).length === 1 && /<h1>Research the matchup\./.test(IDX));
chk('every section is introduced by an h2', () => {
  const secs = [...IDX.matchAll(/<section class="(?:sec[^"]*|final)" id="([a-z]+)">/g)].map(m => m[1]);
  return secs.length >= 12 && secs.every(id => {
    const a = IDX.indexOf('id="' + id + '"'), b = IDX.indexOf('</section>', a);
    return /<h2\b/.test(IDX.slice(a, b));
  });
});
chk('the product previews are described for a screen reader', /role="figure" aria-label="An illustrative EdgeDesk game research card"/.test(IDX));
chk('the ladder has a caption and scoped headers', /<caption class="sr">/.test(IDX) && (IDX.match(/<th scope="col"/g) || []).length >= 5);

/* ======================================================================== */
/* 3. MOTION: QUIET, ONCE, AND NEVER A REASON TO MISS CONTENT               */
/* ======================================================================== */
chk('a reduced-motion block covers the page', /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?animation:none!important;transition:none!important/.test(CSS));
chk('reveals are skipped under reduced motion', /if\(REDUCE\|\|!HAS_IO\)/.test(mod('reveals')));
chk('each block reveals once and is then forgotten', /io\.unobserve\(en\.target\)/.test(mod('reveals')));
chk('content is only hidden for a reveal once script is known to be running',
  /\.js \.rv\{opacity:0/.test(CSS) && !/(^|[^s])\s\.rv\{opacity:0/.test(CSS.replace(/\.js \.rv/g, '')) && /documentElement\.className\+=' js'/.test(IDX));
chk('nothing on the page animates forever', !/infinite/.test(CSS));
chk('nothing advances on its own', !/setInterval\(/.test(LANDING));
chk('the scroll behaviour stops being smooth under reduced motion', /prefers-reduced-motion:reduce\)\{\s*html\{scroll-behavior:auto\}/.test(CSS));

/* ======================================================================== */
/* 4. THE REMOVED SECTIONS STAY REMOVED                                     */
/* ======================================================================== */
/* Each of these was a second or third explanation of something the page
   now says once, or described a product the page no longer sells. */
['compress', 'getyou', 'notpicks', 'steps', 'idk', 'ours', 'close', 'engines', 'football', 'collective', 'attack',
 'evidence', 'ai', 'clv', 'proof', 'bridge', 'values', 'beyond', 'price', 'chapRail', 'problem', 'terminal', 'pass',
 'stack', 'work', 'attention', 'casual', 'ladder', 'workflow', 'examples']
  .forEach(id => lacks(IDX, 'id="' + id + '"', 'the removed section ' + id + ' stays removed'));
['heroGames', 'pile', 'layers', 'stepper', 'progress', 'idk', 'heroDemo', 'thesisAttack', 'football', 'collective',
 'evidence', 'aiAnalyst', 'clv', 'workflow', 'casual', 'boardToDecision']
  .forEach(m => chk('the orphaned ' + m + ' module went with it', mod(m) === ''));
chk('the golf audience band and its reveal are gone', !/function edAudience/.test(IDX) && !/edAudience\(\)/.test(IDX) && !/id="brd/.test(IDX));
chk('but a partner referral still attributes and is still named at consent',
  /var PARTNERS=\{/.test(IDX) && /Referred by '\+esc\(\(PARTNERS\[r\]&&PARTNERS\[r\]\.name\)\|\|r\)/.test(IDX));
chk('no anchor points at a section that no longer exists', () => {
  const ids = new Set([...IDX.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
  const bad = [...new Set([...IDX.matchAll(/href="#([a-zA-Z0-9_-]+)"/g)].map(m => m[1]))].filter(a => !ids.has(a));
  return bad.length === 0;
});
chk('no page elsewhere on the site links to a landing anchor that is gone', () => {
  const ids = new Set([...IDX.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
  const bad = [];
  ['record.html', 'curriculum.html', 'app.html', 'terms.html', 'privacy.html', 'disclaimer.html', '404.html', 'reset.html'].forEach(f => {
    const p = path.join(ROOT, f); if (!fs.existsSync(p)) return;
    [...fs.readFileSync(p, 'utf8').matchAll(/(?:index\.html|href="\/)#([a-zA-Z0-9_-]+)/g)].forEach(m => { if (!ids.has(m[1])) bad.push(f + '#' + m[1]); });
  });
  return bad.length === 0 || (console.log('   dangling:', bad.join(', ')), false);
});
chk('no CSS rule is left for a class nothing carries', () => {
  const st = IDX.indexOf('<style>'), en = IDX.indexOf('</style>');
  const css = IDX.slice(st, en).replace(/\/\*[\s\S]*?\*\//g, ''), rest = IDX.slice(0, st) + IDX.slice(en);
  const cls = [...new Set((css.replace(/url\([^)]*\)/g, '').match(/\.[a-zA-Z][a-zA-Z0-9_-]+/g) || []).map(s => s.slice(1)))]
    .filter(c => !/^\d/.test(c));
  const dead = cls.filter(c => !new RegExp('(?<![a-zA-Z0-9_-])' + c.replace(/-/g, '\\-') + '(?![a-zA-Z0-9_-])').test(rest));
  return dead.length === 0 || (console.log('   dead classes:', dead.join(', ')), false);
});
chk('no giant commented-out markup is left behind', !/<!--[^>]*<(?:section|div|article)\b[\s\S]{0,4000}?-->/.test(IDX.replace(/<script[\s\S]*?<\/script>/g, '')));
/* the football-only product does not demonstrate itself on baseball */
[/\bbullpen\b/i, /\bpitching\b/i, /\bpitch mix\b/i, /\bpark factor\b/i, /\bumpire\b/i, /\binnings?\b/i, /Reds @ Cubs/, /Dodgers/]
  .forEach(re => chk('no baseball copy survives: ' + re, !re.test(IDX), (re.exec(IDX) || [])[0]));

/* ======================================================================== */
/* 5. NOTHING IS FABRICATED, NOTHING NEW IS FETCHED                         */
/* ======================================================================== */
chk('every product panel that shows numbers says they are illustrative', () => {
  const bars = [...IDX.matchAll(/<div class="panel-bar">[\s\S]*?<\/div>/g)].map(m => m[0]);
  return bars.length >= 4 && bars.every(b => /<span class="tag">Illustrative (?:game|prices)<\/span>/.test(b));
});
chk('and every footer on those panels says it is not a tip',
  (IDX.match(/Nothing here tells you what to bet/g) || []).length >= 2);
chk('the page makes exactly its two artifact reads', (IDX.match(/fetch\('football\//g) || []).length === 2);
chk('every other fetch is the existing Supabase plumbing', () => {
  const all = [...IDX.matchAll(/fetch\(([^,)]{0,24})/g)].map(m => m[1]);
  return all.every(a => /^'football\//.test(a) || /^SB_URL/.test(a));
});
lacks(LANDING, 'fetch(', 'the presentation script reaches the network for nothing');
chk('no number anywhere is invented at random', !/Math\.random/.test(IDX));
/* ONE EV implementation: the presentation script carries no odds math */
[/impliedFromAmerican/, /americanFromImplied/, /decimalFromAmerican/, /100\s*\/\s*\(\s*-?\s*a\s*\)/, /\(\s*-a\s*\)\s*\/\s*\(\(-a\)\+100\)/, /1\s*\+\s*100\s*\//]
  .forEach(re => chk('the landing script does no odds arithmetic of its own: ' + re, !re.test(LANDING), (re.exec(LANDING) || [])[0]));
['Q.americanToDecimal(', 'Q.expectedValue(', 'Q.breakEven(', 'Q.fairAmerican('].forEach(f =>
  has(mod('evDemo'), f, 'it asks the terminal\'s engine: ' + f));
has(LANDING, "var EV_LIBS=['/lib/research_core.js", 'the engine loads research_core first');
has(LANDING, "'/lib/edgedesk_quote_ev.js", 'and then the quote-EV engine');
chk('the engine is loaded when needed, not on first paint', /rootMargin:'700px 0px'/.test(mod('evDemo')) && !/<script[^>]*src="\/lib\/edgedesk_quote_ev/.test(IDX));
/* the page still never tells anyone what to do */
[/>\s*BET\s*</, /\bLOCK\b/, /\bBEST BET\b/i, /\bPLAY\b/].forEach(re =>
  chk('the presentation script never says ' + re, !re.test(LANDING)));
/* measurement goes through the tag the site already has */
chk('analytics go through the existing gtag, and no new vendor', /window\.gtag\('event'/.test(LANDING) && !/(segment|mixpanel|amplitude|hotjar|posthog|plausible)/i.test(IDX));
['landing_page_view', 'hero_trial_click', 'hero_demo_click', 'sample_game_interaction', 'pricing_view', 'pricing_trial_click', 'public_record_click', 'login_click']
  .forEach(e => has(IDX, e, 'the conversion event ' + e + ' can be measured'));
chk('a Sign out click is never counted as a log in', /login_click' && \/sign out\/i/.test(LANDING));

/* ======================================================================== */
/* 6. WEIGHT                                                                */
/* ======================================================================== */
chk('the page is under 200 KB, preserved auth and billing block included', IDX.length < 200 * 1024, Math.round(IDX.length / 1024) + ' KB');
chk('the presentation script is small', LANDING.length < 16 * 1024, Math.round(LANDING.length / 1024) + ' KB');
chk('the font request asks only for the weights the page uses',
  /Inter:wght@400;500;600;700&family=Space\+Grotesk:wght@500;600;700&family=JetBrains\+Mono:wght@400;500;700&display=swap/.test(IDX));
chk('nothing below the fold is an image or a video', !/<(?:img|video|iframe)\b/.test(IDX));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding interaction: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
