#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — interaction, accessibility, data honesty and
   weight.

   The page is a conversion page with ONE live block on it: the research
   preview, read from EdgeDesk's stored research. Everything else that looks
   like a product screen is a labelled sample. What a reader operates is
   small (the menu, the calls to action, the sticky phone bar, the preview's
   links, the FAQ) and what it reads must be fast and true. These tests hold:

     1  each interaction exists, and bails out cleanly if its host is gone;
     2  it is keyboard-operable and announces itself;
     3  nothing moves under prefers-reduced-motion, nothing loops except the
        loading skeleton (and only while loading, and only for readers who
        allow motion), and nothing is hidden from a reader whose script
        never ran;
     4  the sections the redesigns removed stay removed, with no anchor, module
        or CSS rule left pointing at them;
     5  no number is invented: the page reads two sources, does no odds
        arithmetic of its own, and never uses randomness;
     6  the funnel is measured through ONE client (lib/edgedesk_track.js), with
        no new vendor, and the GA events the dashboards already use survive;
     7  the page stays light, and the heavy artifacts are not downloaded.

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
  navMenu:     { host: 'id="navBurger"', what: 'the phone menu opens and closes', min: 150 },
  pricingView: { host: 'id="pricing"',   what: 'reaching the price is measured', min: 60 },
  coachView:   { host: 'id="coach"',     what: 'reaching Process Coach is measured', min: 60 },
  stickyCta:   { host: 'id="mbar"',      what: 'the phone\'s sticky call to action shows and hides', min: 150 },
  liveBoard:   { host: 'id="lpPreview"', what: 'the live research preview is read and drawn', min: 150 },
  reveals:     { host: 'class="',        what: 'blocks enter once, quietly', min: 150 }
};
Object.keys(MODULES).forEach(m => {
  chk(MODULES[m].what, mod(m).length > MODULES[m].min, m + ' module is missing or a stub');
  has(IDX, MODULES[m].host, 'and its host exists: ' + MODULES[m].host);
});
['navMenu', 'pricingView', 'coachView', 'stickyCta'].forEach(m =>
  chk(m + ' returns early if its host is gone', /if\s*\(\s*!(?:\w+|\$\('[a-z]+'\))(?:\s*\|\|\s*!\w+)*(?:\s*\|\|\s*!HAS_IO)?\s*\)\s*return;/.test(mod(m))));
/* each fallback also hands #free its games: none, so it reads the schedule */
chk('the live board falls back when its view model did not load', /if\(!H\)\{ failAll\(\); renderFreeGames\(null\); return; \}/.test(mod('liveBoard')));
chk('and when the reads fail or return nothing', /\.catch\(function\(\)\{ failAll\(\); renderFreeGames\(null\); \}\)/.test(mod('liveBoard')) && /if\(!o\|\|\(!o\.rpc&&!o\.stat\)\)\{ failAll\(\); renderFreeGames\(null\); return; \}/.test(mod('liveBoard')));
chk('a built board fills #free too', /renderStats\(V\); renderPreview\(V\); renderFreeGames\(V\);/.test(mod('liveBoard')));
['renderStats', 'renderPreview'].forEach(f =>
  chk(f + ' bails out when its host is missing', new RegExp('function ' + f + '\\([^)]*\\)\\{[\\s\\S]{0,220}?if\\(!\\w+\\) return;').test(LANDING)));
chk('the reads are cached for 90 seconds in the session, never in localStorage', /HOME_KEY='edgedesk_home_cache_v1', HOME_TTL=90\*1000/.test(LANDING) && /sessionStorage\.setItem\(HOME_KEY/.test(LANDING) && !/localStorage\.setItem\(HOME_KEY/.test(LANDING));

/* ======================================================================== */
/* 2. KEYBOARD AND SEMANTICS                                                */
/* ======================================================================== */
const NAVM = mod('navMenu');
chk('the menu reports its state', /aria-expanded/.test(NAVM) && /aria-label/.test(NAVM));
chk('Escape closes the menu and returns focus to its button', /'Escape'/.test(NAVM) && /btn\.focus\(\)/.test(NAVM));
chk('a tap outside, a link inside or a wide screen closes it', /!nav\.contains\(ev\.target\)/.test(NAVM) && /closest\('a,button'\)/.test(NAVM) && /innerWidth>960/.test(NAVM));
chk('every control is a real button or link, never a clickable div', !/<(?:div|span|li)[^>]*\sonclick=/.test(IDX));
const MARKUP = IDX.replace(/<script[\s\S]*?<\/script>/g, ' ');
chk('every button in the markup says what kind it is', (MARKUP.match(/<button\b(?![^>]*type=)[^>]*>/g) || []).length === 0,
  (MARKUP.match(/<button\b(?![^>]*type=)[^>]*>/g) || []).slice(0, 3).join(' '));
chk('and no button declares its type twice', !/<button\b[^>]*type="button"[^>]*type="button"/.test(MARKUP));
chk('every button the script builds says what kind it is', !/'<button (?!type=)/.test(LANDING));
chk('the answers are native <details>, so they work without script', (IDX.match(/<details>/g) || []).length >= 10);
chk('there is a skip link to the main content', /<a class="skip" href="#main">/.test(IDX) && /<main id="main">/.test(IDX));
chk('focus is always visible', /:focus-visible\{outline:2px solid var\(--obs\)/.test(CSS));
chk('there is exactly one h1, and it is the hero line', (IDX.match(/<h1\b/g) || []).length === 1 && /<h1 data-hero="headline">Research the game /.test(IDX));
chk('every section is introduced by an h2', () => {
  const secs = [...IDX.matchAll(/<section class="(?:sec[^"]*|final)" id="([a-z]+)">/g)].map(m => m[1]);
  return secs.length >= 10 && secs.every(id => {
    const a = IDX.indexOf('id="' + id + '"'), b = IDX.indexOf('</section>', a);
    return /<h2\b/.test(IDX.slice(a, b));
  });
});
chk('the live preview is a labelled region that announces politely', /id="lpPreview" role="region" aria-label="Live research preview"/.test(IDX) && /id="lpPrevBody" aria-live="polite"/.test(IDX));
chk('every table has a caption and scoped headers', () => {
  const tables = [...IDX.matchAll(/<table class="([a-z-]+)">\s*<caption class="sr">[^<]{20,}<\/caption>\s*<thead><tr>((?:<th scope="col"[^>]*>[^<]*<\/th>)+)<\/tr><\/thead>/g)];
  return tables.length === (IDX.match(/<table\b/g) || []).length && tables.length >= 2;
});
chk('the sample calendar\'s day names have their full names for a screen reader', (IDX.match(/<th scope="col" abbr="(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day">/g) || []).length === 7);
chk('the illustrations are labelled regions or carry their own heading', /class="panel dash calc" role="region" aria-label="Free no-vig calculator"/.test(IDX));
chk('the loading skeleton is hidden from screen readers', /<div class="prev-skel" aria-hidden="true">/.test(IDX));

/* ======================================================================== */
/* 3. MOTION AND NO-SCRIPT READERS                                          */
/* ======================================================================== */
chk('a reduced-motion block covers the page', /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?animation:none!important;transition:none!important/.test(CSS));
chk('reveals are skipped under reduced motion', /if\(REDUCE\|\|!HAS_IO\)/.test(mod('reveals')));
chk('each block reveals once and is then forgotten', /io\.unobserve\(en\.target\)/.test(mod('reveals')));
chk('content is only hidden for a reveal once script is known to be running',
  /\.js \.rv\{opacity:0/.test(CSS) && /documentElement\.className\+=' js'/.test(IDX));
chk('the only looping animation is the loading skeleton, and only for readers who allow motion', () => {
  const loops = (CSS.match(/infinite/g) || []).length;
  return loops === 1 && /@media\(prefers-reduced-motion:no-preference\)\{\.skel\{animation:sk 1\.4s linear infinite\}/.test(CSS);
});
chk('the skeleton exists only while the board is loading', /\.js \.prev-body\.loading \.prev-skel\{display:block\}/.test(CSS) && /body\.classList\.remove\('loading'\)/.test(LANDING));
chk('without script the example preview is visible and the skeleton is not', /\.prev-skel\{display:none/.test(CSS) && /\.js \.prev-ill\{display:none\}/.test(CSS));
chk('a no-script reader is told the live preview needs script', /<noscript><p class="note"[^>]*><b>The live preview needs JavaScript\.<\/b>/.test(IDX));
chk('nothing advances on its own', !/setInterval\(/.test(LANDING));
chk('the scroll behaviour stops being smooth under reduced motion', /prefers-reduced-motion:reduce\)\{\s*html\{scroll-behavior:auto\}/.test(CSS));

/* ======================================================================== */
/* 4. THE REMOVED SECTIONS STAY REMOVED                                     */
/* ======================================================================== */
['compress', 'getyou', 'notpicks', 'steps', 'idk', 'ours', 'close', 'engines', 'football', 'collective', 'attack',
 'evidence', 'ai', 'clv', 'proof', 'bridge', 'values', 'beyond', 'price', 'chapRail', 'problem', 'terminal', 'pass',
 'stack', 'work', 'attention', 'casual', 'ladder', 'examples', 'tabs', 'game', 'ev', 'lpLive']
  .forEach(id => lacks(IDX, 'id="' + id + '"', 'the removed section ' + id + ' stays removed'));
['heroGames', 'pile', 'layers', 'stepper', 'progress', 'idk', 'heroDemo', 'thesisAttack', 'football', 'collective',
 'evidence', 'aiAnalyst', 'clv', 'workflow', 'casual', 'boardToDecision', 'gameTabs', 'evDemo', 'landingArtifacts']
  .forEach(m => chk('the orphaned ' + m + ' module is gone', mod(m) === ''));
/* the 2026-10 redesign: the live board grid, the prop table, the workflow
   card, the price example, the feature grid and the who-it's-for strip went;
   the research preview and its statistics moved to the research section */
['workflow', 'props', 'difference', 'product', 'who', 'lpBoard', 'lpBoardEmpty', 'lpTiles', 'lpPropTable', 'lpPropRows', 'lpConnected', 'lpPriceEx', 'lpRatings', 'heroBoard']
  .forEach(id => lacks(IDX, 'id="' + id + '"', 'the removed block ' + id + ' stays removed'));
chk('and so do their renderers', !/function render(?:Today|Connected|Props|PriceExample|Ratings)\(/.test(IDX));
chk('#how is the loop section itself, the anchor record.html and curriculum.html link to', /<section class="sec" id="how">/.test(IDX));
chk('#today and #record survive as aliases where their content now lives', /<section class="sec alt" id="research">\s*<span id="today" aria-hidden="true"><\/span>/.test(IDX)
  && /<section class="sec alt" id="trust">\s*<span id="record" aria-hidden="true"><\/span>/.test(IDX));
chk('the hero counter it replaced is gone with its function', !/function lpLiveLoad\(/.test(IDX) && !/lpLiveLoad\(\)/.test(IDX));
chk('the golf audience band and its reveal are gone', !/function edAudience/.test(IDX) && !/edAudience\(\)/.test(IDX) && !/id="brd/.test(IDX));
chk('but a partner referral still attributes and is still named at consent',
  /var PARTNERS=\{/.test(IDX) && /Referred by '\+esc\(\(PARTNERS\[r\]&&PARTNERS\[r\]\.name\)\|\|r\)/.test(IDX));
chk('no anchor points at a section that no longer exists', () => {
  const ids = new Set([...IDX.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
  const bad = [...new Set([...IDX.matchAll(/href="#([a-zA-Z0-9_-]+)"/g)].map(m => m[1]))].filter(a => !ids.has(a));
  return bad.length === 0 || (console.log('   dangling:', bad.join(', ')), false);
});
chk('no page elsewhere on the site links to a landing anchor that is gone', () => {
  const ids = new Set([...IDX.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
  const bad = [];
  ['record.html', 'curriculum.html', 'app.html', 'terms.html', 'privacy.html', 'disclaimer.html', '404.html', 'reset.html', 'methodology/index.html', 'research/sample/index.html'].forEach(f => {
    const p = path.join(ROOT, f); if (!fs.existsSync(p)) return;
    [...fs.readFileSync(p, 'utf8').matchAll(/(?:index\.html|href="\/)#([a-zA-Z0-9_-]+)/g)].forEach(m => { if (!ids.has(m[1])) bad.push(f + '#' + m[1]); });
  });
  return bad.length === 0 || (console.log('   dangling:', bad.join(', ')), false);
});
chk('no CSS rule is left for a class nothing carries', () => {
  const st = IDX.indexOf('<style>'), en = IDX.indexOf('</style>');
  /* the markup, and what lib/edgedesk_home_free.js renders into it */
  const css = IDX.slice(st, en).replace(/\/\*[\s\S]*?\*\//g, ''), rest = IDX.slice(0, st) + IDX.slice(en)
    + fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_home_free.js'), 'utf8');
  const cls = [...new Set((css.replace(/url\([^)]*\)/g, '').match(/\.[a-zA-Z][a-zA-Z0-9_-]+/g) || []).map(s => s.slice(1)))]
    .filter(c => !/^\d/.test(c));
  const dead = cls.filter(c => !new RegExp('(?<![a-zA-Z0-9_-])' + c.replace(/-/g, '\\-') + '(?![a-zA-Z0-9_-])').test(rest));
  return dead.length === 0 || (console.log('   dead classes:', dead.join(', ')), false);
});
chk('no giant commented-out markup is left behind', !/<!--[^>]*<(?:section|div|article)\b[\s\S]{0,4000}?-->/.test(IDX.replace(/<script[\s\S]*?<\/script>/g, '')));
[/\bbullpen\b/i, /\bpitching\b/i, /\bpitch mix\b/i, /\bpark factor\b/i, /\bumpire\b/i, /\binnings?\b/i, /Reds @ Cubs/, /Dodgers/]
  .forEach(re => chk('no baseball copy survives: ' + re, !re.test(IDX), (re.exec(IDX) || [])[0]));

/* ======================================================================== */
/* 5. NOTHING IS FABRICATED                                                 */
/* ======================================================================== */
chk('the live preview\'s fallback says it is an example', () => {
  const ill = IDX.slice(IDX.indexOf('id="lpPrevIll"'), IDX.indexOf('id="lpPrevFoot"'));
  return /Example game &middot; not live/.test(ill) && (ill.match(/<small>Example<\/small>/g) || []).length >= 2;
});
/* every other product picture on the page is a SAMPLE, and says so in its
   own chrome — the bar a reader sees before any number in it */
chk('every illustrative panel carries "Sample data" in its own bar', () => {
  const bars = [...MARKUP.matchAll(/<div class="panel(?: dash)?(?: rv)?"[^>]*>\s*<div class="panel-bar">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  /* coach, film room, history (the hero's picture is a free tool, not a sample) */
  return bars.length >= 3 && bars.every(b => /Sample data/.test(b));
}, [...MARKUP.matchAll(/<div class="panel(?: dash)?(?: rv)?"[^>]*>\s*<div class="panel-bar">([\s\S]*?)<\/div>/g)].length);
chk('the page fetches exactly three things of its own: the board RPC, the board file and the Supabase plumbing', () => {
  const all = [...IDX.matchAll(/fetch\(([^,)]{0,40})/g)].map(m => m[1]);
  return all.every(a => /^SB_URL/.test(a) || /^url\+'\/rest\/v1\/rpc\/public_home_board'/.test(a) || /^'\/football\/home\/board\.json'/.test(a));
}, [...IDX.matchAll(/fetch\(([^,)]{0,40})/g)].map(m => m[1]).join(' | '));
chk('no number anywhere is invented at random', !/Math\.random/.test(IDX));
[/impliedFromAmerican/, /americanFromImplied/, /decimalFromAmerican/, /100\s*\/\s*\(\s*-?\s*a\s*\)/, /\(\s*-a\s*\)\s*\/\s*\(\(-a\)\+100\)/, /1\s*\+\s*100\s*\//, /\bexpectedValue\(/, /\bbreakEven\(/]
  .forEach(re => chk('the landing script does no odds arithmetic of its own: ' + re, !re.test(LANDING), (re.exec(LANDING) || [])[0]));
chk('the view model is the only place a live number is shaped', /H\.build\(o\.rpc, o\.stat, Date\.now\(\)\)/.test(LANDING));
chk('a price\'s age is judged when the page is read, with Date.now()', /H\.build\([^)]*Date\.now\(\)\)/.test(LANDING));
[/>\s*BET\s*</, /\bLOCK\b/, /\bBEST BET\b/i, /'PLAY'/].forEach(re => chk('the presentation script never says ' + re, !re.test(LANDING)));
chk('every value the script writes into HTML is escaped', () => {
  /* the escaper exists and the renderers use it for every data field */
  return /function e\(s\)\{ return String\(s==null\?'':s\)\.replace\(\/\[&<>"\]\/g/.test(LANDING)
    && !/\+g\.(?:matchup|home|away|fair_text|market_text|key_reason|status_note)\+/.test(LANDING)
    && !/\+p\.(?:player|market|selection|book|team)\+/.test(LANDING);
});

/* ======================================================================== */
/* 6. MEASUREMENT: ONE CLIENT, NO NEW VENDOR                                */
/* ======================================================================== */
has(IDX, '<script src="/lib/edgedesk_track.js', 'the funnel client is loaded');
chk('it is configured with the site\'s own anon key, and GA stays the page\'s', /EDTrack\.configure\(\{url:SB_URL,key:SB_KEY,ga:false\}\)/.test(IDX));
[['landing_view', /funnel\('landing_view'/], ['cta_clicked', /funnel\('cta_clicked', \{cta: cta, hero: HERO_VARIANT\}\)/], ['pricing_view', /funnel\('pricing_view'/],
 ['landing_live_board_view', /EDTrack\.seen\(\$\('lpPreview'\), 'landing_live_board_view'/], ['signup_started', /edFunnel\('signup_started'/],
 ['checkout_started', /edFunnel\('checkout_started',[\s\S]{0,300}?\{now:true,keepalive:true\}\)/]]
  .forEach(x => chk('the funnel event ' + x[0] + ' is sent', x[1].test(IDX)));
chk('the live-board view counts only when there was a live board to see', /if\(V\.live&&window\.EDTrack\) EDTrack\.seen/.test(LANDING));
chk('checkout_started is sent before the browser leaves for Stripe', IDX.indexOf("edFunnel('checkout_started'") < IDX.indexOf('window.location.href=url;') && IDX.indexOf("edFunnel('checkout_started'") > IDX.indexOf("msg.textContent='Opening secure checkout…'"));
chk('every call to action names itself for the funnel', (MARKUP.match(/data-cta="[a-z_]+"/g) || []).length >= 10);
chk('analytics go through the existing gtag, and no new vendor', /window\.gtag\('event'/.test(LANDING) && !/(segment\.com|mixpanel|amplitude|hotjar|posthog|plausible)/i.test(IDX));
['landing_page_view', 'hero_trial_click', 'pricing_view', 'pricing_trial_click', 'public_record_click', 'login_click']
  .forEach(ev => has(IDX, ev, 'the GA conversion event ' + ev + ' can still be measured'));
chk('the reports\' old names are still sent beside the new ones',
  /GA_LEGACY = \{ hero_cta_click: 'hero_trial_click', pricing_cta_click: 'pricing_trial_click', how_it_works_click: 'hero_how_click' \}/.test(LANDING) && /if\(GA_LEGACY\[name\]\) track\(GA_LEGACY\[name\], label\)/.test(LANDING));
/* THE FUNNEL, VISITOR -> CTA -> SIGNUP -> TRIAL -> PAID, named in GA too */
[['hero_cta_click', /id="heroCta"[^>]*data-track="hero_cta_click"/], ['how_it_works_click', /data-track="how_it_works_click" data-cta="strip_how"/], ['hero_free_click', /id="heroStart"[^>]*data-track="hero_free_click"/],
 ['pricing_cta_click', /id="subBtn"[^>]*data-track="pricing_cta_click"/], ['process_coach_view', /track\('process_coach_view'\)/],
 ['signup_started', /edGa\('signup_started'/], ['signup_completed', /edGa\('signup_completed',\{email_confirmation:false\}\)[\s\S]*edGa\('signup_completed',\{email_confirmation:true\}\)/],
 ['checkout_started', /edGa\('checkout_started'/], ['trial_started', /edGa\(trial\?'trial_started':'subscription_active',\{\}\)/]]
  .forEach(x => chk('the GA event ' + x[0] + ' is sent', x[1].test(IDX)));
chk('GA is told no email, user id or typed text', !/edGa\([^)]*(?:email:|u\.id|\.value)/.test(IDX) && !/track\([^)]*(?:email|\.value)/.test(LANDING));
chk('every GA event the page sends names the hero variant the reader saw', /Object\.assign\(\{hero_variant: HERO_VARIANT\}, params\|\|\{\}\)/.test(LANDING));

/* ======================================================================== */
/* 6b. THE PHONE'S STICKY CALL TO ACTION                                    */
/* ======================================================================== */
const STICKY = mod('stickyCta');
chk('the sticky bar ships hidden', /<div class="mbar" id="mbar" hidden>/.test(IDX));
chk('it exists only on a phone', /@media\(min-width:641px\)\{\.mbar\{display:none!important\}\}/.test(CSS) && /matchMedia\('\(max-width:640px\)'\)/.test(STICKY));
chk('it waits until the hero\'s own button has scrolled away', /\$\('heroCta'\)/.test(STICKY) && /past=!es\[0\]\.isIntersecting && es\[0\]\.boundingClientRect\.top<0/.test(STICKY));
chk('it steps aside at pricing and at the close, where a big button already is', /\['pricing','start'\]/.test(STICKY) && /!near\.pricing && !near\.start/.test(STICKY));
chk('it never sits over a dialog', /querySelector\('\.modal\.on,\.retn\.on'\)/.test(STICKY) && /MutationObserver/.test(STICKY));
chk('it never asks an account that already has access to start a trial', /window\.ED_PAID!=='yes'/.test(STICKY));
chk('it reserves room so it never covers the footer', /body\.mbar-on footer\{padding-bottom:/.test(CSS));
chk('it says the price beside the button', /<div class="mbar" id="mbar" hidden>[\s\S]{0,200}data-ed-price="trial"[\s\S]{0,80}data-ed-price="monthly"/.test(IDX));

/* ======================================================================== */
/* 6c. THE HERO IS READY FOR A TEST, WITHOUT A FAKE TEST FRAMEWORK          */
/* ======================================================================== */
chk('the hero copy lives in one config with the candidate headlines (p: the process line that led before free research)', /var HERO_COPY = \{\s*a: \{ headline: 'Research the game <span class="g">before you bet it\.<\/span>' \},\s*\/\*[^*]*\*\/\s*p: \{ headline: 'Bet with a process\. <span class="g">Know what&rsquo;s working\.<\/span>' \},\s*b: \{ headline: 'Stop guessing <span class="g">why you&rsquo;re losing\.<\/span>' \},\s*c: \{ headline: 'Research the bet\. Track the result\. <span class="g">Improve the process\.<\/span>' \}/.test(LANDING));
chk('variant a is exactly the markup, so search engines and no-script readers get it', IDX.indexOf('<h1 data-hero="headline">Research the game <span class="g">before you bet it.</span></h1>') > 0);
chk('only a named variant can be shown, and nobody is assigned at random', /Object\.prototype\.hasOwnProperty\.call\(HERO_COPY,q\)/.test(LANDING) && !/Math\.random/.test(IDX));
chk('a Sign out click is never counted as a log in', /login_click' && \/sign out\/i/.test(LANDING));

/* ======================================================================== */
/* 7. WEIGHT                                                                */
/* ======================================================================== */
chk('the page is under 200 KB, preserved auth and billing block included', IDX.length < 200 * 1024, Math.round(IDX.length / 1024) + ' KB');
chk('the presentation script is small', LANDING.length < 28 * 1024, Math.round(LANDING.length / 1024) + ' KB');
chk('the multi-megabyte artifacts are never fetched', !/rankings\/current\.json'|players\/current\.json'|props\/(?:nfl|cfb)\/(?:summary|board)\.json|cfb_terminal\/board\.json/.test(IDX.replace(/\/\*[\s\S]*?\*\//g, '')));
const BOARD = path.join(ROOT, 'football', 'home', 'board.json');
chk('the board file the page reads is small', fs.existsSync(BOARD) && fs.statSync(BOARD).size < 64 * 1024, fs.existsSync(BOARD) ? fs.statSync(BOARD).size : 'missing');
chk('the font request asks only for the weights the page uses',
  /Inter:wght@400;500;600;700&family=Space\+Grotesk:wght@500;600;700&family=JetBrains\+Mono:wght@400;500;700&display=swap/.test(IDX));
chk('the database connection is warmed before the first read', /<link rel="preconnect" href="https:\/\/iattxbkbufslbauoumga\.supabase\.co" crossorigin>/.test(IDX));
chk('nothing below the fold is an image or a video', !/<(?:img|video|iframe)\b/.test(IDX));
/* the view model also holds the hero's own rules (the two-pillar preview and
   the selective "worth researching" count), so it gets 36 KiB; the others 32 */
const LIB_BUDGET = { 'edgedesk_home.js': 36 * 1024, 'edgedesk_track.js': 32 * 1024, 'edgedesk_pricing.js': 32 * 1024 };
const libs = Object.keys(LIB_BUDGET).map(f => [f, fs.statSync(path.join(ROOT, 'lib', f)).size]);
chk('the three small libraries it loads stay small', libs.every(([f, n]) => n < LIB_BUDGET[f]), libs.map(([f, n]) => f + ' ' + n).join(', '));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding interaction: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
