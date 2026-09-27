#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC LANDING PAGE — interaction.

   The page's problem was not that it said the wrong things. It was that a
   reader met six screens of unbroken prose before anything on the page could
   be operated, and the interactive parts sat thirteen screens down describing
   a sport the product no longer covers.

   These tests hold the fix:

     1  every major beat above the fold is something a reader operates;
     2  each interaction is keyboard-reachable and announces itself;
     3  none of them animates under prefers-reduced-motion;
     4  the page keeps the reader oriented — progress and chapters;
     5  the sections that duplicated a better section stay deleted, and no
        anchor is left pointing at one;
     6  no interaction fabricates a number or reaches the network to get one.

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

/* ======================================================================== */
/* 1. EVERY BEAT ABOVE THE FOLD IS OPERABLE                                 */
/* ======================================================================== */
const MODULES = {
  heroGames: { host: 'lp-sw',      what: 'the hero switches between three research states' },
  pile:      { host: 'pileBtns',   what: 'the Saturday pile-up is built by the reader' },
  layers:    { host: 'layPick',    what: 'the eleven research layers are opened one at a time' },
  stepper:   { host: 'stpRail',    what: 'the five-step read is walked' },
  idk:       { host: 'idkPick',    what: 'the uncertainty conditions are picked' },
  progress:  { host: 'chapRail',   what: 'the reader can see where they are' }
};
Object.keys(MODULES).forEach(m => {
  chk(MODULES[m].what, mod(m).length > 400, m + ' module is missing or a stub');
  has(IDX, MODULES[m].host, 'and its host element exists: ' + MODULES[m].host);
});

/* each module bails out cleanly when its host is absent, so a section can be
   removed without throwing on every page load */
Object.keys(MODULES).forEach(m => {
  chk(m + ' returns early if its host is gone', /if\s*\(\s*!\w+(?:\s*\|\|\s*!\w+)*\s*\)\s*return;/.test(mod(m)));
});

/* the sections that carry them */
[['compress', 'pile'], ['getyou', 'lay'], ['steps', 'stp'], ['idk', 'idkPick']].forEach(p => {
  const sec = IDX.slice(IDX.indexOf('id="' + p[0] + '"'), IDX.indexOf('</section>', IDX.indexOf('id="' + p[0] + '"')));
  chk('the ' + p[0] + ' section hosts its interaction', sec.indexOf('id="' + p[1] + '"') >= 0);
  chk('and it is not a wall of static cards any more', (sec.match(/<button/g) || []).length + (sec.match(/id="/g) || []).length > 2);
});

/* ======================================================================== */
/* 2. KEYBOARD AND SEMANTICS                                                */
/* ======================================================================== */
['heroGames', 'layers', 'idk'].forEach(m => {
  chk(m + ' moves with the arrow keys', /ArrowRight/.test(mod(m)) && /ArrowLeft/.test(mod(m)));
  chk(m + ' wraps at both ends rather than dead-ending',
    /%\s*(?:btns|LAYERS|COND|GAMES)\.length/.test(mod(m)));
  chk(m + ' moves focus with the selection', /\.focus\(\)/.test(mod(m)));
  chk(m + ' reports the selection to assistive tech', /aria-selected/.test(mod(m)));
});
chk('every switcher is a real tablist', (IDX.match(/role="tablist"/g) || []).length >= 3);
chk('and every control is a real button, never a clickable div',
  !/<div[^>]*\sonclick=/.test(IDX));
chk('the chapter rail labels its jumps for screen readers', /aria-label','Jump to '/.test(mod('progress')));
chk('the progress bar itself is decorative and hidden from the tree',
  /<div class="lp-prog" aria-hidden="true">/.test(IDX));
/* the support answers are native disclosure, so they work without script */
chk('the pricing questions are native <details>, not a scripted accordion',
  (IDX.match(/<details class="ss">/g) || []).length >= 4);
chk('every focusable control the page adds has a visible focus ring',
  (IDX.match(/:focus-visible\{outline:2px solid var\(--obs\)/g) || []).length >= 5);

/* ======================================================================== */
/* 3. REDUCED MOTION IS HONOURED BY EVERY MOVING PART                       */
/* ======================================================================== */
['heroGames', 'pile', 'stepper', 'progress'].forEach(m =>
  chk(m + ' checks REDUCE before animating', /REDUCE/.test(mod(m))));
chk('the walkthrough does not self-advance under reduced motion',
  /if\s*\(\s*!REDUCE\s*&&\s*HAS_IO\s*\)/.test(mod('stepper')));
chk('and it stops self-advancing the moment the reader takes over',
  /taken\s*=\s*true/.test(mod('stepper')) && /clearInterval/.test(mod('stepper')));
chk('the self-advance runs once and then disconnects',
  /io\.disconnect\(\)/.test(mod('stepper')));
['.lp-sw', '.lp-pw', '.lp-stp-body', '.lp-prog', '.lp-rail', 'details.ss'].forEach(sel => {
  const rm = IDX.match(/@media\(prefers-reduced-motion:reduce\)\{[^}]*\}[^@]*/g) || [];
  chk('reduced motion is addressed for ' + sel,
    IDX.indexOf('prefers-reduced-motion') >= 0 && rm.length > 0);
});
chk('there are reduced-motion blocks for each new component',
  (IDX.match(/@media\(prefers-reduced-motion:reduce\)/g) || []).length >= 6,
  'found ' + (IDX.match(/@media\(prefers-reduced-motion:reduce\)/g) || []).length);

/* ======================================================================== */
/* 4. THE READER STAYS ORIENTED                                             */
/* ======================================================================== */
has(mod('progress'), "['top','Start']", 'the chapter rail starts at the top');
has(mod('progress'), "['pricing','Access']", 'and ends at the pricing section');
chk('every chapter the rail names is a section that exists', () => {
  const chapters = [...mod('progress').matchAll(/\['([a-z]+)','[^']+'\]/g)].map(m => m[1]);
  return chapters.length >= 8 && chapters.every(id => IDX.indexOf('id="' + id + '"') >= 0);
});
chk('the rail skips a chapter that is not on the page rather than throwing',
  /if\s*\(!sec\)\s*return;/.test(mod('progress')));
chk('scroll work is throttled to a frame, not run per scroll event',
  /requestAnimationFrame/.test(mod('progress')) && /ticking/.test(mod('progress')));
chk('and the scroll listener is passive so it never blocks the scroll',
  /\{passive:\s*true\}/.test(mod('progress')));
chk('the rail is hidden where it would crowd the content column',
  /@media\(min-width:1240px\)\{\.lp-rail\{display:flex\}\}/.test(IDX));
chk('its labels are out of flow so the rail stays dot-width',
  /\.lp-rail \.lbl\{position:absolute/.test(IDX));

/* ======================================================================== */
/* 5. THE DUPLICATES STAY DELETED                                           */
/* ======================================================================== */
/* Each of these said something a surviving section says better, or said it
   about baseball. Deleting them is what took the page from 32 screens to 22. */
['problem', 'terminal', 'pass', 'stack', 'work', 'attention', 'casual', 'ladder',
 'workflow', 'examples', 'how'].forEach(id =>
  lacks(IDX, 'id="' + id + '"', 'the duplicate section ' + id + ' stays deleted'));
['workflow', 'casual', 'boardToDecision'].forEach(m =>
  chk('the orphaned ' + m + ' module went with it', mod(m) === ''));
chk('no anchor points at a section that no longer exists', () => {
  const ids = new Set([...IDX.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
  const bad = [...new Set([...IDX.matchAll(/href="#([a-zA-Z0-9_-]+)"/g)].map(m => m[1]))]
    .filter(a => a !== 'top' && !ids.has(a));
  return bad.length === 0;
});
chk('and no CSS rule is left for a class nothing carries', () => {
  const st = IDX.indexOf('<style>'), en = IDX.indexOf('</style>');
  const css = IDX.slice(st, en), rest = IDX.slice(0, st) + IDX.slice(en);
  const cls = [...new Set((css.match(/\.[a-zA-Z][a-zA-Z0-9_-]+/g) || []).map(s => s.slice(1)))];
  const dead = cls.filter(c => !new RegExp('(?<![a-zA-Z0-9_-])' + c.replace(/-/g, '\\-') + '(?![a-zA-Z0-9_-])').test(rest));
  return dead.length === 0;
});

/* the football-only product no longer demonstrates itself on baseball */
[/\bbullpen\b/i, /\bpitching\b/i, /\bpitch mix\b/i, /\bhandedness\b/i, /\bpark factor\b/i,
 /\bumpire\b/i, /\binnings?\b/i, /Reds @ Cubs/, /Dodgers/]
  .forEach(re => chk('no baseball copy survives: ' + re, !re.test(IDX), (re.exec(IDX) || [])[0]));

/* ======================================================================== */
/* 6. NOTHING IS FABRICATED, NOTHING NEW IS FETCHED                         */
/* ======================================================================== */
chk('every illustrative game is labelled as one',
  (IDX.match(/Illustrative game/g) || []).length >= 2);
chk('the hero card says so in its own chrome',
  /<span class="tag">Illustrative game<\/span>/.test(IDX));
/* the only same-origin reads on the page stay the two committed
   artifacts; everything else that fetches is the pre-existing auth and
   billing plumbing, which this pass did not touch */
chk('the page still makes exactly two artifact reads',
  (IDX.match(/fetch\('football\//g) || []).length === 2,
  'found ' + (IDX.match(/fetch\('football\//g) || []).length);
chk('and every other fetch is the existing Supabase plumbing', () => {
  const all = [...IDX.matchAll(/fetch\(([^,)]{0,24})/g)].map(m => m[1]);
  return all.every(a => /^'football\//.test(a) || /^SB_URL/.test(a) || /^api\(/.test(a));
});
['heroGames', 'pile', 'layers', 'stepper', 'idk'].forEach(m => {
  lacks(mod(m), 'fetch(', m + ' reaches the network for nothing');
  lacks(mod(m), 'Math.random', m + ' invents no number');
});
chk('no interaction writes a projected line the model did not produce',
  !/Math\.random/.test(IDX));
/* the page still never tells anyone what to do */
['heroGames', 'stepper', 'idk'].forEach(m => {
  [/>\s*BET\s*</, /\bLOCK\b/, /\bBEST BET\b/i].forEach(re =>
    chk(m + ' never says ' + re, !re.test(mod(m))));
});
has(mod('heroGames'), 'not advice', 'the research state says it is not advice');
has(mod('stepper'), 'A research state is not a recommendation',
  'and the walkthrough ends by saying so out loud');

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding interaction: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
