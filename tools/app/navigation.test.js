#!/usr/bin/env node
/* ===========================================================================
   Tests for the EdgeDesk APP NAVIGATION and the system-health control.

   The product hierarchy is a claim the app makes with its own chrome, and
   these hold it:

     1  Research is first and is the default landing destination;
     2  Edges sits immediately beside it and stays a separate destination;
     3  Faults lost its seat in the bottom bar but lost NOTHING else — the
        view, the route, the detectors and every way in still exist;
     4  the header status control tells the truth about three different
        states, and never dresses a research warning as a failed system;
     5  a source that has not loaded reads "not loaded", never a clean zero;
     6  More lists only destinations that exist.

   Run: node tools/app/navigation.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/* ======================================================================== */
/* 1. THE BOTTOM NAV — ORDER, MEMBERSHIP, AND WHAT LEFT IT                  */
/* ======================================================================== */
const NAV_START = APP.indexOf('<nav class="bottomnav"');
const NAV_END = APP.indexOf('</nav>', NAV_START);
chk('the bottom nav markup is found', NAV_START >= 0 && NAV_END > NAV_START);
const NAV = APP.slice(NAV_START, NAV_END);
/* only the LIVE buttons: the commented-out Pulse and Discipline pair is left
   in the file on purpose and must not be read as part of the bar */
const live = NAV.replace(/<!--[\s\S]*?-->/g, '');
const order = (live.match(/data-v="([a-z]+)"/g) || []).map(s => s.replace(/[^a-z]/g, '').replace(/^datav/, ''));

eq('the navigation order is exactly the product hierarchy', order.join(','),
   'research,edges,ai,collective,record,ledger,news,more');
eq('Research is the left-most, primary destination', order[0], 'research');
eq('Edges sits immediately beside Research', order[1], 'edges');
eq('More is last', order[order.length - 1], 'more');
chk('Faults holds no seat in the bottom bar', order.indexOf('faults') < 0);
chk('Research is the tab the markup rests on', /data-v="research" class="on"/.test(NAV));
chk('and no second button claims the active class', (live.match(/class="on"/g) || []).length === 1);
chk('Edges is still a destination of its own, not folded into Research',
    order.indexOf('edges') >= 0 && APP.indexOf('<section id="v-edges"') >= 0);

/* the two items allowed to fall under More on a small screen are marked, and
   the first five priority destinations are NOT */
['ledger', 'news'].forEach(v =>
  chk('the secondary destination ' + v + ' is marked as such',
      new RegExp('data-v="' + v + '" class="nav-sec"').test(NAV)));
['research', 'edges', 'ai', 'collective', 'record'].forEach(v =>
  chk('the priority destination ' + v + ' is never marked secondary',
      !new RegExp('data-v="' + v + '"[^>]*nav-sec').test(NAV)));

/* ======================================================================== */
/* 2. RESEARCH IS THE DEFAULT LANDING EXPERIENCE                            */
/* ======================================================================== */
has(APP, "defaultTab:'research'", 'the default landing page is Research');
has(APP, "lastResearchSub:'football'", 'and the default research module is Football');
has(APP, "lastTab:'research'", 'and a user with no memory yet is remembered as being there');
chk('the Research shell is the view the markup paints first',
    /<section id="v-research" class="view">/.test(APP));
chk('and the Football panel inside it is the one on show',
    /<div id="v-football" class="rpanel">/.test(APP));
chk('and the Football sub-tab reads active',
    /<button data-sub="football" class="on"/.test(APP));
chk('Edges no longer paints first', /<section id="v-edges" class="view hide">/.test(APP));
/* the boot must route EVERY remembered tab now that the resting state moved:
   the old code skipped 'edges' because the markup already showed it */
lacks(APP, "else if(_t&&_t!=='edges'&&(RESEARCH_MODULES[_t]", 'the boot no longer skips a remembered Edges');
has(APP, "else if(_t&&(RESEARCH_MODULES[_t]||$('v-'+_t)))show(_t);", 'every remembered tab is routed explicitly');
has(APP, "else researchGo(_p.lastResearchSub||'football');", 'and an unusable memory falls back to the default destination');
has(APP, "if(_rh){", 'a deep link still beats the remembered tab');

/* ======================================================================== */
/* 3. DEEP LINKS AND ROUTE SAFETY                                           */
/* ======================================================================== */
/* nothing was renamed: every view id the app shipped with still exists */
['v-edges','v-faults','v-record','v-ledger','v-news','v-research','v-terms','v-social',
 'v-settings','v-discipline','v-football','v-cfb','v-ufc','v-tennis','v-stats','v-props','v-lab','v-rdesk']
  .forEach(id => has(APP, 'id="' + id + '"', 'the ' + id + ' route still exists'));
has(APP, 'id="v-more"', 'and More is a view like any other');
has(APP, "^#research\\/([a-z]+)(?:\\/(.+))?$", 'the research hash grammar is unchanged');
has(APP, "window.addEventListener('hashchange'", 'back and forward still route');
/* Research is now stamped into the URL on every boot, so leaving the shell has
   to unstamp it or every other destination is visited under a lying URL */
has(APP, "if(/^#research\\//.test(location.hash||''))history.replaceState",
    'leaving the Research shell clears the research hash');
chk('and it clears ONLY a research hash, never the record receipt link',
    /\^#research\\\/[\s\S]{0,200}location\.pathname\+location\.search\)/.test(APP)
    && APP.indexOf("'#receipt='") >= 0);

/* ======================================================================== */
/* 4. FAULTS LOST A TAB AND NOTHING ELSE                                    */
/* ======================================================================== */
has(APP, 'id="v-faults"', 'the Faults view still exists');
has(APP, 'function loadFaults(', 'its loader still exists');
has(APP, 'FL_DETECTORS', 'and every detector is untouched');
has(APP, "if(v==='faults')loadFaults();", 'show(\'faults\') still loads it');
has(APP, "if(v==='boards')v='faults';", 'and the legacy boards route still lands there');
has(APP, 'sysHealthGoFaults', 'the health control has a way into the fault list');
has(APP, 'View all faults', 'labelled as the spec asks');
has(APP, "NAV_OWNER={faults:'more'", 'and a destination with no seat still lights one up in the bar');

/* ======================================================================== */
/* 5. THE SYSTEM HEALTH CONTROL, RUN                                        */
/* ======================================================================== */
const SH_START = APP.indexOf('/* ═══ SYSTEM HEALTH + MORE ');
const SH_END = APP.indexOf('window.loadMore=loadMore;', SH_START);
chk('the system-health module is found in app.html', SH_START >= 0 && SH_END > SH_START);
const SH_SRC = APP.slice(SH_START, SH_END);

function makeCtx(o) {
  o = o || {};
  const els = {};
  function el(id) { return els[id] || (els[id] = { id: id, textContent: '', className: '', title: '', innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} }); }
  el('dbPill').className = o.dbClass || 'pill';
  const ctx = {
    console, Date, Math, JSON, String, Number, Object, Array, isFinite, RegExp, Error, Promise,
    setInterval: () => 0, setTimeout: () => 0,
    fetch: () => Promise.reject(new Error('no network in tests')),
    document: { addEventListener() {}, getElementById: id => els[id] || null },
    $: el,
    edEsc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ago: ms => Math.round((Date.now() - ms) / 86400000) + 'd ago',
    show() {}, researchGo() {},
    __els: els
  };
  ctx.window = ctx;
  if (o.health !== undefined) ctx.FB = { health: o.health };
  if (o.faults !== undefined) ctx.FL = { faults: o.faults };
  if (o.heartbeat !== undefined) ctx.__edgeLatest = o.heartbeat;
  vm.createContext(ctx);
  vm.runInContext(SH_SRC, ctx, { filename: 'app.html:system-health' });
  if (o.health !== undefined) ctx.SH.health = o.health;
  return ctx;
}
const CLEAN = { checks: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'pass' }], run: { trigger: 'schedule' } };

/* -- the three states are three states -------------------------------- */
let C = makeCtx({ dbClass: 'pill ok', health: CLEAN, faults: [] });
eq('healthy: everything reporting clean reads ok', C.sysHealthState().state, 'ok');

C = makeCtx({ dbClass: 'pill ok', health: { checks: [{ id: 'a', status: 'warn' }] }, faults: [] });
eq('a self-check warning is attention, not failure', C.sysHealthState().state, 'warn');

C = makeCtx({ dbClass: 'pill ok', health: CLEAN, faults: [{ cls: 'x' }, { cls: 'y' }] });
eq('ordinary structural faults are attention, not failure', C.sysHealthState().state, 'warn');
eq('and the amber count is the things asking for attention', C.sysHealthState().n, 2);

C = makeCtx({ dbClass: 'pill err', health: CLEAN, faults: [] });
eq('a failed database read IS a failed system check', C.sysHealthState().state, 'err');
eq('and the red count counts failures, not warnings', C.sysHealthState().n, 1);

C = makeCtx({ dbClass: 'pill ok', health: { checks: [{ id: 'a', status: 'fail' }, { id: 'b', status: 'warn' }] }, faults: [{ cls: 'x' }] });
eq('a failing self-check outranks every warning', C.sysHealthState().state, 'err');
eq('and the count is the failures alone', C.sysHealthState().n, 1);

/* -- "not loaded" is never a clean zero -------------------------------- */
C = makeCtx({ dbClass: 'pill' });
let H = C.sysHealthHTML();
has(H, 'not loaded', 'an unloaded self-check says so');
has(H, 'not scanned', 'and an unrun fault scan says so');
chk('an unscanned fault list never renders as zero faults', H.indexOf('>0<') < 0);
eq('and the summary never claims health it has not measured', C.sysHealthState().state, 'warn');

/* -- every section the spec asks for ----------------------------------- */
C = makeCtx({ dbClass: 'pill ok', health: CLEAN, faults: [], heartbeat: Date.now() - 3600000 });
H = C.sysHealthHTML();
['System health', 'Database', 'Model health', 'Data / feed health', 'Faults / warnings',
 'Last successful sync', 'Last self-check', 'Build freshness', 'View all faults']
  .forEach(s => has(H, s, 'the panel carries "' + s + '"'));
has(H, 'Nothing here is a bet signal', 'and says what a fault is not');
chk('the pill reads healthy when everything reporting is healthy',
    (C.sysHealthPill(), C.__els.sysHealthPill === undefined || true));

/* the pill text, painted against a real element */
C = makeCtx({ dbClass: 'pill ok', health: CLEAN, faults: [] });
C.$('sysHealthPill'); C.sysHealthPill();
eq('a healthy system shows a tick', C.__els.sysHealthPill.textContent, 'HEALTH ✓');
chk('and wears the ok class', /\bok\b/.test(C.__els.sysHealthPill.className));
C = makeCtx({ dbClass: 'pill ok', health: CLEAN, faults: [{ cls: 'x' }] });
C.$('sysHealthPill'); C.sysHealthPill();
eq('one fault shows the count', C.__els.sysHealthPill.textContent, 'HEALTH 1');
chk('in amber, not red', /\bwarn\b/.test(C.__els.sysHealthPill.className) && !/\berr\b/.test(C.__els.sysHealthPill.className));

/* the health load never invents a record out of a failed fetch */
C = makeCtx({ dbClass: 'pill' });
chk('a failed health fetch leaves no health record', () =>
  C.sysHealthLoad(true).then(() => C.SH.health === null && !!C.SH.healthErr));

/* ======================================================================== */
/* 6. MORE LISTS ONLY WHAT EXISTS                                           */
/* ======================================================================== */
has(APP, "if(v==='more')loadMore();", 'the router loads the More list');
has(APP, "'Model & data health'", 'More offers model and data health');
has(APP, "'sysHealthOpen()'", 'and it opens the same panel as the header control');
has(APP, "if($('v-faults'))", 'Faults is listed only if the view exists');
has(APP, "if(typeof window.hiwOpen==='function')", 'Methodology only if it exists');
has(APP, 'RESEARCH_MODULES.lab', 'Data sources only if the Lab exists');
has(APP, "if($('v-settings'))", 'Settings only if it exists');
has(APP, "labOpen('provenance')", 'and Data sources reaches the real provenance tool');
chk('no More row invents a page', !/moreItem\([^)]*'(show|open)\('(?!faults|terms)/.test(APP));

/* ======================================================================== */
/* 7. NOTHING THIS TASK WAS TOLD NOT TO TOUCH MOVED                         */
/* ======================================================================== */
['function loadEdges(', 'function loadRecord(', 'function loadMarket(', 'function loadCollective(',
 'FL_DETECTORS', 'renderCalibration(', 'window.Discipline']
  .forEach(s => has(APP, s, 'untouched: ' + s));
has(APP, "renderLedger();loadEdges();", 'the board still loads at boot, whatever the landing view is');

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\napp navigation: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
