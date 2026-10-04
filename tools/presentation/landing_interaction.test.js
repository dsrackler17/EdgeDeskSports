#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — interaction, accessibility, data honesty and
   weight.

   The page is a conversion page with a LIVE board on it. What a reader
   operates is small (the menu, the calls to action, the live board's links)
   and what it reads must be fast and true. These tests hold:

     1  each interaction exists, and bails out cleanly if its host is gone;
     2  it is keyboard-operable and announces itself;
     3  nothing moves under prefers-reduced-motion, nothing loops except the
        loading skeleton (and only while loading, and only for readers who
        allow motion), and nothing is hidden from a reader whose script
        never ran;
     4  the sections the redesign removed stay removed, with no anchor, module
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
  navMenu:     { host: 'id="navBurger"', what: 'the phone menu opens and closes' },
  pricingView: { host: 'id="pricing"',   what: 'reaching the price is measured' },
  liveBoard:   { host: 'id="lpBoard"',   what: 'the live board is read and drawn' },
  reveals:     { host: 'class="',        what: 'blocks enter once, quietly' }
};
Object.keys(MODULES).forEach(m => {
  chk(MODULES[m].what, mod(m).length > 150, m + ' module is missing or a stub');
  has(IDX, MODULES[m].host, 'and its host exists: ' + MODULES[m].host);
});
['navMenu', 'pricingView'].forEach(m =>
  chk(m + ' returns early if its host is gone', /if\s*\(\s*!\w+(?:\s*\|\|\s*!\w+)*\s*\)\s*return;/.test(mod(m))));
chk('the live board falls back when its view model did not load', /if\(!H\)\{ failAll\(\); return; \}/.test(mod('liveBoard')));
chk('and when the reads fail or return nothing', /\.catch\(function\(\)\{ failAll\(\); \}\)/.test(mod('liveBoard')) && /if\(!o\|\|\(!o\.rpc&&!o\.stat\)\)\{ failAll\(\); return; \}/.test(mod('liveBoard')));
['renderStats', 'renderPreview', 'renderToday', 'renderConnected', 'renderProps', 'renderPriceExample', 'renderRatings'].forEach(f =>
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
chk('there is exactly one h1, and it is the hero line', (IDX.match(/<h1\b/g) || []).length === 1 && /<h1>Find where the model and the market/.test(IDX));
chk('every section is introduced by an h2', () => {
  const secs = [...IDX.matchAll(/<section class="(?:sec[^"]*|final)" id="([a-z]+)">/g)].map(m => m[1]);
  return secs.length >= 10 && secs.every(id => {
    const a = IDX.indexOf('id="' + id + '"'), b = IDX.indexOf('</section>', a);
    return /<h2\b/.test(IDX.slice(a, b));
  });
});
chk('the live preview is a labelled region that announces politely', /id="lpPreview" role="region" aria-label="Live research preview"/.test(IDX) && /id="lpPrevBody" aria-live="polite"/.test(IDX));
chk('the prop table has a caption and scoped headers', /<table class="ptab" id="lpPropTable">\s*<caption class="sr">/.test(IDX) && (IDX.match(/<th scope="col">/g) || []).length >= 8);
chk('on a phone every prop cell is labelled from the header it lost', (LANDING.match(/data-l="(Player|Prop|Market|EdgeDesk|Difference|Best odds|EdgeDesk EV|Status)"/g) || []).length === 8
  && /\.ptab td::before\{content:attr\(data-l\)/.test(CSS));
chk('the board announces updates politely', /id="lpBoard" aria-live="polite"/.test(IDX));
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
chk('a no-script reader is told the board needs script', /<noscript><div class="empty"><b>The live board needs JavaScript\.<\/b>/.test(IDX));
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
chk('#how survives only as an alias inside the workflow section, for record.html and curriculum.html', /<section class="sec" id="workflow">\s*<span id="how" aria-hidden="true"><\/span>/.test(IDX));
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
  const css = IDX.slice(st, en).replace(/\/\*[\s\S]*?\*\//g, ''), rest = IDX.slice(0, st) + IDX.slice(en);
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
chk('every example panel says it is an example', () => {
  const ill = IDX.slice(IDX.indexOf('id="lpPrevIll"'), IDX.indexOf('id="lpPrevFoot"'));
  const conn = IDX.slice(IDX.indexOf('id="lpConnected"'), IDX.indexOf('</div>', IDX.indexOf('id="lpConnFoot"')));
  return /Example game &middot; not live/.test(ill) && /Example game &middot; not live/.test(conn) && /id="lpConnTag">Example</.test(conn) && /Example layout/.test(conn);
});
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
[['landing_view', /funnel\('landing_view'/], ['cta_clicked', /funnel\('cta_clicked', \{cta: cta\}\)/], ['pricing_view', /funnel\('pricing_view'/],
 ['landing_live_board_view', /EDTrack\.seen\(\$\('today'\), 'landing_live_board_view'/], ['signup_started', /edFunnel\('signup_started'/],
 ['checkout_started', /edFunnel\('checkout_started',[\s\S]{0,300}?\{now:true,keepalive:true\}\)/]]
  .forEach(x => chk('the funnel event ' + x[0] + ' is sent', x[1].test(IDX)));
chk('the live-board view counts only when there was a live board to see', /if\(V\.live&&window\.EDTrack\) EDTrack\.seen/.test(LANDING));
chk('checkout_started is sent before the browser leaves for Stripe', IDX.indexOf("edFunnel('checkout_started'") < IDX.indexOf('window.location.href=url;') && IDX.indexOf("edFunnel('checkout_started'") > IDX.indexOf("msg.textContent='Opening secure checkout…'"));
chk('every call to action names itself for the funnel', (MARKUP.match(/data-cta="[a-z_]+"/g) || []).length >= 10);
chk('analytics go through the existing gtag, and no new vendor', /window\.gtag\('event'/.test(LANDING) && !/(segment\.com|mixpanel|amplitude|hotjar|posthog|plausible)/i.test(IDX));
['landing_page_view', 'hero_trial_click', 'pricing_view', 'pricing_trial_click', 'public_record_click', 'login_click']
  .forEach(ev => has(IDX, ev, 'the GA conversion event ' + ev + ' can still be measured'));
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
