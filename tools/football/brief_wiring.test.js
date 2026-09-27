#!/usr/bin/env node
/* ============================================================================
   THE BRIEF LAYER CAN ACTUALLY REACH THE FOOTBALL MODULE.

   WHAT WENT WRONG, TWICE OVER. brief_research.test.js extracted the research
   builders out of app.html by name and ran them in a flat sandbox. They
   passed 168 checks. They were also completely unreachable in a browser.

   app.html's football engine is an IIFE. A function declared inside it is
   invisible outside it, which is why the module ends with fifty-nine
   `window.fbX = fbX` lines. The three new builders had no such line, so
   EDBRIEF's `researchFor()` hit `if(!window.fbBriefResearch) return null;`
   on its first statement, every game brief silently fell back to the
   market-only page this work exists to replace, and the rankings button
   reported the artifact was not loaded. Nothing threw. Nothing logged. Every
   source-level assertion still passed.

   SO THIS TEST DOES NOT READ THE SOURCE. It EXECUTES the module — the real
   IIFE, out of the real file, in a VM with a stub DOM — and then calls the
   builders through `window`, exactly as the brief layer does. A function
   that is not exported fails here no matter how correct its body is.

   It also holds the general contract, so the next function added to that
   module is checked without anyone remembering to check it: every `window.fb*`
   the rest of the page reaches for must be defined by somebody.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let checks = 0, failures = 0;
function ok(cond, what) { checks++; if (cond) return; failures++; console.error('  FAIL: ' + what); }
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n' + t); }

/* ---- the football module, sliced out of the page ------------------------
   The slicing and the stub DOM live in _module.js so that every football
   test runs the SAME real module rather than each keeping its own copy of
   the harness. */
const M = require('./_module.js');
const SRC = M.moduleSource(ROOT);
const MODULE = SRC.module, REST = SRC.rest;

/* ═══ 1. it really is a closed scope ═════════════════════════════════════ */
section('1. the football engine is a closed scope, so reaching in needs an export');
ok(/^\s*(\/\*[\s\S]*?\*\/\s*)?\(function\s*\(\s*\)\s*\{/.test(MODULE),
  'the module body opens as an IIFE — nothing declared inside it is global by default');
ok(/\}\)\(\);\s*(\/\*[\s\S]*?\*\/\s*)*$/.test(MODULE.trim()), 'and closes as one');
const exported = new Set((MODULE.match(/window\.(fb[A-Za-z0-9_]+)\s*=/g) || []).map(s => s.slice(7).replace(/\s*=$/, '')));
ok(exported.size > 40, 'it exports its public surface explicitly (' + exported.size + ' names) — that is the convention this test enforces');

/* ═══ 1b. ONE CONFIDENCE LEDGER, NOT TWO ═════════════════════════════════
   The board explains its own confidence number and the committed artifact
   carries the same explanation. A second copy of that arithmetic in app.html
   is how the screen and football/fbs/slate.json come to describe one game
   differently, which is the exact class of bug the shared modules exist to
   end. So the renderer must DELEGATE and must render nothing when the module
   is absent — an explanation that might be wrong is worse than none. */
section('1b. the board explains its confidence from the shared module, not from a second copy');
{
  const fn = (MODULE.match(/function fbGxLedger\(u,p,cov\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(fn.length > 0, 'the board carries a confidence-ledger renderer');
  ok(/window\.EDConfidence\.ledger\(/.test(fn),
    'and it calls the shared module rather than computing a ledger of its own');
  ok(/if\(!window\.EDConfidence\|\|!window\.EDConfidence\.ledger\)return ''/.test(fn),
    'with the module absent it renders nothing at all');
  ok(!/lost_points\s*=\s*[^;]*\*/.test(fn),
    'and it does no point arithmetic of its own');
  ok(/football\/matchup\/confidence\.js/.test(SRC.module + SRC.rest),
    'the page loads football/matchup/confidence.js');
  ok(/football\/matchup\/qb_context\.js/.test(SRC.module + SRC.rest),
    'and football/matchup/qb_context.js, so the starter is flattened once');
  /* the browser's starter flattening must delegate too */
  const qb = (MODULE.match(/function fbP4QbContext\([^)]*\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/window\.EDQbContext\.build\(/.test(qb), 'the browser flattens the starter through the shared module');
  ok(/if\(!window\.EDQbContext\)return null/.test(qb),
    'and keeps no fallback copy: with the module absent the board reports the starter unknown, which is true');
  /* and no surface may round a probability across the boundary */
  ok(!/home_win_prob\s*\*\s*100\)\.toFixed\(0\)/.test(MODULE),
    'no board cell renders a win probability with a bare toFixed(0) any more');
  ok(/function fbWinPair\(pHome\)/.test(MODULE) && /window\.fbWinPair=fbWinPair/.test(MODULE),
    'the bounded renderer exists and is exported');
}

/* ═══ 2. every cross-scope reference resolves ════════════════════════════ */
section('2. every window.fb* the rest of the page reaches for is defined by somebody');
const definedOutside = new Set((REST.match(/window\.(fb[A-Za-z0-9_]+)\s*=/g) || []).map(s => s.slice(7).replace(/\s*=$/, '')));
const referencedOutside = new Set((REST.match(/window\.(fb[A-Za-z0-9_]+)/g) || []).map(s => s.slice(7)));
referencedOutside.forEach(function (name) {
  ok(exported.has(name) || definedOutside.has(name),
    'window.' + name + ' is referenced outside the football module and something defines it');
});
ok(referencedOutside.size > 0, 'the page does reach across the boundary, so this contract is load-bearing');

/* ═══ 3. RUN IT. This is the check the source-level suite could not make ══ */
section('3. the module runs and puts the brief layer\'s entry points on window');
const BOOT = M.boot({ root: ROOT });
if (BOOT.stubbed.length) console.log('  (stubbed page globals: ' + BOOT.stubbed.join(', ') + ')');
ok(!BOOT.error, 'the module runs to completion' + (BOOT.error ? ' — threw: ' + (BOOT.error.message || BOOT.error) : ''));
const win = BOOT.win;

/* the three the brief layer names, and two that already worked, as controls */
[['fbBriefGame', 'the canonical matchup research payload'],
 ['fbBriefResearch', 'the game research builder'],
 ['fbBriefRankings', 'the week\'s rankings builder'],
 ['fbRkEnsure', 'the rankings artifact loader'],
 ['fbRkTab', 'the rankings tab switch (control — this one always worked)'],
 ['fbGxScore', 'the projected-score split (control)']].forEach(function (pair) {
  eq(typeof win[pair[0]], 'function', 'window.' + pair[0] + ' — ' + pair[1] + ' — is reachable from outside the module');
});

/* ═══ 4. and they work when called the way EDBRIEF calls them ════════════ */
section('4. called through window, on the committed artifact, they return real work');
if (typeof win.fbBriefResearch === 'function' && win.FB && win.FB.rk) {
  const res = win.fbBriefResearch({ home: 'Miami', away: 'Florida A&M' });
  ok(!!res, 'a half-rated matchup returns a research block rather than null');
  if (res) {
    ok(res.table.rows.length >= 20, 'it carries every ranked component as a row (' + res.table.rows.length + ')');
    ok(!!res.state && !!res.state.label, 'and says where the game stands');
    ok(res.missing.length > 0, 'and names what it could not measure');
    ok(!/\b(null|undefined|NaN)\b/.test(JSON.stringify(res.headline) + JSON.stringify(res.notes)),
      'with no stringified nothing in its prose');
  }

  const both = win.fbBriefResearch({ home: 'Texas Tech', away: 'Utah' });
  ok(!!both && both.table.rows.every(function (r) { return r.a != null || r.h != null || /Δ/.test(r.k); }),
    'a fully rated matchup fills both columns');

  const rk = win.fbBriefRankings({ top: 25 });
  ok(!!rk, 'the rankings builder returns a payload rather than null');
  if (rk) {
    eq(rk.rows.length, 25, 'a Top 25 has 25 rows');
    ok(rk.spotlights.length >= 1, 'and at least one team is explained');
    ok(rk.columns.indexOf('SPECIAL TEAMS') >= 0, 'special teams is a column');
  }
  eq(typeof win.fbRkEnsure, 'function', 'and openGame can await the loader before it draws');
} else {
  ok(false, 'the module did not expose fbBriefResearch, so nothing downstream could be exercised');
}

/* ═══ 4b. the starter context reaches the payload ════════════════════════
   The board reported an unknown starting quarterback on all 75 games because
   every caller passed `qb:null` and nothing ever loaded the committed starter
   artifact. The regression is not "the artifact is wrong" — it is "the page
   never asks for it", which is invisible to a test that reads the artifact.
   So this executes the module and checks the LOADER exists, the payload
   carries the block, and the block cannot promote an expectation into a
   confirmation.
   ═══════════════════════════════════════════════════════════════════════ */
section('4b. the starter context is loaded and carried, and never promoted');
eq(typeof win.fbStartersEnsure, 'function', 'the starter loader is exported so the board can await it');
eq(typeof win.fbBrStarters, 'function', 'the starter block builder is reachable');
ok(/fbStartersEnsure\(cur\)/.test(MODULE), 'the board load chain asks for the starter artifact');
{
  const blk = win.fbBrStarters('Utah', 'Texas Tech');
  ok(!!blk && !!blk.away && !!blk.home, 'the block has a side for each team');
  ok(blk.away.confirmed === false && blk.home.confirmed === false,
    'with no artifact loaded nothing is confirmed');
  ok(blk.away.priced === false && blk.home.priced === false,
    'and nothing in it is priced');
  ok(/research-only/.test(blk.away.priced_why || ''), 'the record says why it is not priced');
  ok(/never read as healthy/.test(blk.note || ''), 'and that an absent availability report is not health');
  const payload = win.fbBriefGame({ home: 'Texas Tech', away: 'Utah' });
  ok(!!payload && !!payload.starters, 'the college payload carries the starter block');
  ok(!!payload && (payload.missing || []).concat(payload.notes || [])
    .some(function (t) { return /quarterback/i.test(t); }),
    'and the card says something about the quarterback either way');
}

/* ═══ 5. the callers name exactly these symbols ══════════════════════════ */
section('5. the brief layer asks for the names the module exports');
[['researchFor (college)', /window\.fbBriefGame\|\|window\.fbBriefResearch/],
 ['researchFor (NFL)', /window\.fbNflBriefGame\|\|window\.fbNflBriefResearch/],
 ['openGame', /window\.fbRkEnsure && !\(window\.FB&&FB\.rk&&FB\.rk\.data\)/],
 ['openRankings', /window\.fbBriefRankings\?window\.fbBriefRankings\(/]].forEach(function (pair) {
  ok(pair[1].test(REST), pair[0] + ' reaches across the boundary by the exported name');
});

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks : 'PASS — ' + checks + ' checks'));
process.exit(failures ? 1 : 0);
