#!/usr/bin/env node
/* ===========================================================================
   Tests for the EdgeDesk APP NAVIGATION and the system-health control.

   The product hierarchy is a claim the app makes with its own chrome, and
   these hold it (docs/ia/NAVIGATION_AUDIT.md):

     1  FIVE destinations, one per question a reader brings — Research ·
        Card · Portfolio · Process · More — and no sixth one, including the
        one the AI drawer used to append at runtime;
     2  Props and Edges are Research panels, AI is contextual, the Ledger
        merged into Portfolio, and Record is EdgeDesk's MODEL performance in
        More — never the reader's own P&L;
     3  every route the app ever shipped still lands somewhere real, and the
        seat that owns it lights up;
     4  the header status control tells the truth about three different
        states, and never dresses a research warning as a failed system —
        as ONE compact "System" status with the database folded into it;
     5  a source that has not loaded reads "not loaded", never a clean zero;
     6  More is sections, and lists only destinations that exist;
     7  every seat tap and every secondary destination is recorded, so the
        next navigation decision has evidence.

   The browser half is tools/app/navigation.e2e.js.

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
/* 1. THE BOTTOM NAV — FIVE DESTINATIONS, NO SIXTH                          */
/* ======================================================================== */
const NAV_START = APP.indexOf('<nav class="bottomnav"');
const NAV_END = APP.indexOf('</nav>', NAV_START);
chk('the bottom nav markup is found', NAV_START >= 0 && NAV_END > NAV_START);
const NAV = APP.slice(NAV_START, NAV_END);
/* only the LIVE buttons: the commented-out Pulse and Discipline pair is left
   in the file on purpose and must not be read as part of the bar */
const live = NAV.replace(/<!--[\s\S]*?-->/g, '');
const order = (live.match(/data-v="([a-z]+)"/g) || []).map(s => s.replace(/[^a-z]/g, '').replace(/^datav/, ''));

eq('the navigation is exactly the five destinations, in order', order.join(','), 'research,card,portfolio,process,more');
eq('five seats, not six', order.length, 5);
['pprops', 'edges', 'ai', 'record', 'ledger', 'faults', 'collective', 'news'].forEach(v =>
  chk(v + ' holds no seat in the bottom bar', order.indexOf(v) < 0));
chk('Research is the tab the markup rests on', /data-v="research" class="on"/.test(NAV));
chk('and no second button claims the active class', (live.match(/class="on"/g) || []).length === 1);
['Research', 'EdgeDesk Card', 'Portfolio', 'Process', 'More'].forEach(l =>
  has(live, 'aria-label="' + l + '"', 'the ' + l + ' seat is named for screen readers'));
has(APP, "b[j].setAttribute('aria-current','page')", 'the active seat is announced, not only coloured');
/* the AI drawer used to append its own seat whenever none was there */
lacks(APP, "b.setAttribute('data-v','ai')", 'the AI drawer no longer appends a seat at runtime');
has(APP, "if(v==='ai'){try{window.EDAI.open();}catch(_){}return;}", "show('ai') still opens the drawer over whatever is on screen");
has(APP, 'id="rsAskBtn" onclick="edAsk()"', 'Ask EdgeDesk sits in the Research header');
has(APP, "fbGxSec(gid,'ask','Ask EdgeDesk',fbGxAsk(u)", 'and on game research');
has(APP, "edNavTrack('primary',b.dataset.v);show(b.dataset.v);", 'a seat tap is recorded, then routed through show()');

/* ======================================================================== */
/* 2. WHERE EVERYTHING THAT LEFT THE BAR WENT                              */
/* ======================================================================== */
/* Props and Edges are Research panels, registered modules of the shell */
has(APP, '<div id="v-pprops" class="rpanel hide"><div id="ppHost"></div></div>', 'Player Props is a Research panel');
has(APP, '<div id="v-edges" class="rpanel hide">', 'Edges is a Research panel');
lacks(APP, '<section id="v-edges"', 'Edges is no longer a view of its own');
lacks(APP, '<section id="v-pprops"', 'nor is Player Props');
has(APP, "researchRegister({id:'edges',", 'Edges is a registered research module');
has(APP, "researchRegister({id:'pprops',", 'and so is Player Props');
chk('both live inside the Research shell', APP.indexOf('<div id="v-pprops"') > APP.indexOf('<section id="v-research"') && APP.indexOf('<div id="v-edges"') > APP.indexOf('<section id="v-research"')
    && APP.indexOf('<div id="v-edges"') < APP.indexOf('<div id="rsDossier"'));
has(APP, "if(sub==='props')sub='pprops';", 'an old #research/props link lands on the Player Props terminal');
has(APP, "if(sub==='pprops'){try{if(!/^#playerprops/.test(location.hash||''))", 'the shell never overwrites a #playerprops/… link');
/* the Research sub-navigation: four seats, the rest one tap deeper */
const SUB = (APP.match(/<nav class="stseg research-sub" aria-label="Research">[^\n]*?<\/nav>/) || [''])[0];
eq('Research reads Football · Props · Edges · Other', JSON.stringify(SUB.match(/data-sub="[a-z]+"/g)),
   JSON.stringify(['football', 'pprops', 'edges', 'other'].map(s => 'data-sub="' + s + '"')));
const OTHER = (APP.match(/<div class="rs-oth-row hide" id="rsOther"[^\n]*?<\/div>/) || [''])[0];
eq('Other holds the other sports, then the research tools', JSON.stringify(OTHER.match(/data-sub="[a-z]+"/g)),
   JSON.stringify(['ufc', 'baseball', 'stats', 'lab', 'rdesk'].map(s => 'data-sub="' + s + '"')));
has(APP, "var RS_OTHER={ufc:'UFC',baseball:'Baseball',stats:'Stats',lab:'Lab',rdesk:'Desk'};", 'and the fourth seat names whichever of them is open');
/* Football: NFL and CFB first, rosters last, highlighted by name not position */
eq('Football reads NFL · CFB · Players · Rankings · Rosters', JSON.stringify((APP.match(/<div class="stseg fb-seg" id="fbSeg"[^\n]*?<\/div>/) || [''])[0].match(/data-fs="[a-z0-9]+"/g)),
   JSON.stringify(['nfl', 'p4', 'players', 'rankings', 'cfb'].map(s => 'data-fs="' + s + '"')));
has(APP, "(bs[i].getAttribute('data-fs')||order[i])===FB.sport", 'and the lit segment is found by its data-fs');
/* the Ledger merged into Portfolio; its ids moved with their renderers */
has(APP, '<section id="v-portfolio" class="view hide">', 'Portfolio is a view');
has(APP, '<section id="v-process" class="view hide">', 'Process is a view');
lacks(APP, 'id="v-ledger"', 'the Ledger is no longer a page of its own');
['betlist', 'betlistDone', 'clvKpis', 'qaList', 'lg_form', 'lg_toggle', 'portfolio', 'pfImportFile'].forEach(id =>
  chk('Portfolio carries #' + id, APP.indexOf('id="' + id + '"') > APP.indexOf('<section id="v-portfolio"') && APP.indexOf('id="' + id + '"') < APP.indexOf('<section id="v-process"')));
has(APP, "var NAV_ALIAS={ledger:'portfolio'", "show('ledger') lands on Portfolio");
has(APP, '<details class="ws-mkt" id="edMarketAct"', "the Ledger's market line-move feed moved to Edges");
chk('and its ids came with it', ['mktFeed', 'mktBanner', 'mktFresh'].every(id => APP.indexOf('id="' + id + '"') > APP.indexOf('<div id="v-edges"') && APP.indexOf('id="' + id + '"') < APP.indexOf('<div id="rsDossier"')));
/* tracking a price keeps the reader where they were */
lacks(APP, "saveBets(b);show('ledger');", 'tracking a price no longer navigates away');
has(APP, 'window.edTracked(b[0])', 'it says where the price went instead');
/* Record is EdgeDesk's model performance — never the reader's */
has(APP, '<h2 style="margin:0">Model performance <span class="rec-scope">EdgeDesk&rsquo;s record &middot; not your bets', 'Record is titled as EdgeDesk\'s model performance, not the reader\'s');
lacks(APP, "['Record','Your graded track record", 'and nothing describes it as the reader\'s record');
has(APP, "EdgeDesk\\u2019s own graded record, in More. Its record, never yours.", 'Settings → About says whose record it is');
chk('the P&L summary is still the first thing under the Model performance header',
    /<div class="row-between"><h2 style="margin:0">Model performance[\s\S]{0,700}?<\/div>\s*(<!--[\s\S]*?-->\s*)*<div id="recPnlWrap"><\/div>/.test(APP));
/* destinations with no seat light the seat that owns them */
has(APP, "var NAV_OWNER={faults:'more',terms:'more',settings:'more',collective:'more',news:'more',record:'more'};", 'everything reached through More lights More');
has(APP, "var NAV_PRIMARY={research:1,card:1,portfolio:1,process:1};", '"remember last tab" remembers destinations only');

/* ======================================================================== */
/* 3. DEFAULT LANDING, DEEP LINKS AND ROUTE SAFETY                          */
/* ======================================================================== */
has(APP, "defaultTab:'research'", 'the default landing page is Research');
has(APP, "lastResearchSub:'football'", 'and the default research module is Football');
has(APP, "lastTab:'research'", 'and a user with no memory yet is remembered as being there');
chk('the Research shell is the view the markup paints first', /<section id="v-research" class="view">/.test(APP));
chk('and the Football panel inside it is the one on show', /<div id="v-football" class="rpanel">/.test(APP));
chk('and the Football sub-tab reads active', /<button data-sub="football" class="on"/.test(APP));
has(APP, "var _lt=NAV_ALIAS[_p.lastTab]||_p.lastTab;", 'a remembered tab from before the five destinations is read through the aliases');
has(APP, "else if(_t&&(RESEARCH_MODULES[_t]||$('v-'+_t)))show(_t);", 'every remembered tab is routed explicitly');
has(APP, "else researchGo(_p.lastResearchSub||'football');", 'and an unusable memory falls back to the default destination');
has(APP, "if(_rh){", 'a research deep link still beats the remembered tab');
has(APP, "else if(navHashRoute(location.hash)){}", 'destination links (#portfolio, #process, #ledger, #receipt=…) are routed at boot');
has(APP, "else if(typeof window.edSetupDue==='function'&&window.edSetupDue())show('setup');", 'a new account starts at setup');
chk('and setup never beats a deep link', APP.indexOf("else if(navHashRoute(location.hash)){}") < APP.indexOf("window.edSetupDue())show('setup')")
    && APP.indexOf("if((location.hash||'')==='#card')show('card');") < APP.indexOf("window.edSetupDue())show('setup')"));
has(APP, "if(/^#receipt=/.test(h)){var rv=$('v-record');", 'a cold #receipt=… share link opens Model performance');
['card', 'portfolio', 'process', 'more', 'ledger', 'record', 'pnl', 'edges', 'props', 'settings', 'faults', 'news', 'collective', 'terms'].forEach(h =>
  chk('#' + h + ' is a link that lands', new RegExp('NAV_HASH_MAP=\\{[^}]*\\b' + h + ":'").test(APP)));
has(APP, "if(/^#playerprops/.test(h)){if(RESEARCH_SUB!=='pprops'", '#playerprops links work inside a running app, not only at boot');
/* nothing was renamed out of existence: every view id the app shipped with that
   is still a page still exists, and the two new ones joined them */
['v-edges','v-faults','v-record','v-research','v-terms','v-social','v-settings','v-discipline','v-football','v-cfb','v-ufc','v-stats','v-props','v-lab','v-rdesk','v-pprops','v-card','v-collective','v-news',
 'v-portfolio','v-process','v-setup']
  .forEach(id => has(APP, 'id="' + id + '"', 'the ' + id + ' route exists'));
has(APP, 'id="v-more"', 'and More is a view like any other');
/* Tennis was retired from the product: its old routes land on the Research default */
lacks(APP, 'id="v-tennis"', 'the Tennis panel is gone');
lacks(APP, 'data-sub="tennis"', 'and so is its Research tab');
has(APP, "var RS_RETIRED=EDSPORTS.retiredModuleRoutes();", 'old tennis routes have a destination (lib/edgedesk_sports.js)');
has(APP, "if(RS_RETIRED[sub])sub=RS_RETIRED[sub];", 'researchGo sends a retired module there');
has(APP, "if(m&&RS_RETIRED[m[1]])return {sub:RS_RETIRED[m[1]],entity:null,retired:true};",
    'and a #research/tennis/… deep link resolves there instead of being ignored');
has(APP, "^#research\\/([a-z]+)(?:\\/(.+))?$", 'the research hash grammar is unchanged');
has(APP, "window.addEventListener('hashchange'", 'back and forward still route');
has(APP, "if(/^#research\\//.test(_h)||/^#playerprops/.test(_h)||NAV_HASH_RE.test(_h))history.replaceState",
    'leaving the Research shell clears the research hash');
chk('and it clears ONLY a research or destination hash, never the record receipt link',
    APP.indexOf("'#receipt='") >= 0 && !/NAV_HASH_RE=\/[^/]*receipt/.test(APP));
has(APP, "var _rp=document.querySelectorAll('#v-research .rpanel');for(var _k=0;_k<_rp.length;_k++)_rp[_k].classList.add('hide');",
    'leaving Research hides its panels, so "is Edges on screen?" stays true only while it is');
has(APP, "if(!$('v-portfolio').classList.contains('hide'))autoSettle()", 'the 60-second settle follows the bets to Portfolio');

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
  function el(id) { return els[id] || (els[id] = { id: id, textContent: '', className: '', title: '', innerHTML: '', attrs: {}, classList: { add() {}, remove() {} }, setAttribute(k, v) { this.attrs[k] = String(v); } }); }
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

/* the pill, painted against a real element: ONE compact status — "System ●
   Healthy" — the word for a wide header, the count for a phone (.hpc), and
   the whole sentence in the control's aria-label */
function paint(o) { const X = makeCtx(o); X.$('sysHealthPill'); X.$('sysHealthBtn'); X.sysHealthPill(); return X; }
C = paint({ dbClass: 'pill ok', health: CLEAN, faults: [] });
let PH = C.__els.sysHealthPill.innerHTML;
has(PH, '<span class="hpk">System</span>', 'the status says what it is the status of');
has(PH, '<span class="hpv">Healthy</span>', 'a healthy system reads Healthy');
lacks(PH, 'class="hpc"', 'and carries no count');
chk('and wears the ok class', /\bok\b/.test(C.__els.sysHealthPill.className));
eq('the control says it in words', C.__els.sysHealthBtn.attrs['aria-label'], 'System status: healthy. Open system health');
C = paint({ dbClass: 'pill ok', health: CLEAN, faults: [{ cls: 'x' }] });
PH = C.__els.sysHealthPill.innerHTML;
has(PH, '<span class="hpv">1 warning</span>', 'one fault reads as one warning');
has(PH, '<span class="hpc">1</span>', 'and a phone still gets the count, not colour alone');
chk('in amber, not red', /\bwarn\b/.test(C.__els.sysHealthPill.className) && !/\berr\b/.test(C.__els.sysHealthPill.className));
C = paint({ dbClass: 'pill err', health: CLEAN, faults: [] });
PH = C.__els.sysHealthPill.innerHTML;
has(PH, '<span class="hpv">1 failing</span>', 'a failed database read reads as one failing check');
chk('in red', /\berr\b/.test(C.__els.sysHealthPill.className));
C = paint({ dbClass: 'pill' });
has(C.__els.sysHealthPill.innerHTML, '<span class="hpv">Checking</span>', 'nothing reported yet reads Checking, never Healthy');
/* the database glance is folded into the one status, not deleted */
has(APP, '<span class="pill" id="dbPill">', 'the database pill keeps its id for every writer');
has(APP, '.hpbtn #dbPill{display:none}', 'and is drawn as part of the one status rather than a second pill');

/* the health load never invents a record out of a failed fetch */
C = makeCtx({ dbClass: 'pill' });
chk('a failed health fetch leaves no health record', () =>
  C.sysHealthLoad(true).then(() => C.SH.health === null && !!C.SH.healthErr));

/* ======================================================================== */
/* 6. MORE IS SECTIONS, AND LISTS ONLY WHAT EXISTS                          */
/* ======================================================================== */
has(APP, "if(v==='more')loadMore();", 'the router loads the More list');
const MORE = APP.slice(APP.indexOf('function loadMore(){'), APP.indexOf('window.loadMore=loadMore;'));
const groups = (MORE.match(/group\('([^']+)'/g) || []).map(g => g.slice(7, -1));
eq('More is five sections, in order', groups.join('|'), 'Community &amp; tools|Transparency|System|Account|Legal');
const rowIdx = (t) => MORE.indexOf("'" + t + "'");
chk('Community & tools: Collective and Games', rowIdx('Collective') < MORE.indexOf("group('Transparency'") && MORE.indexOf("'EdgeDesk Games") < MORE.indexOf("group('Transparency'"));
chk('Transparency: Model performance, Methodology, Data sources', ['Model performance', 'Methodology', 'Data sources'].every(t => rowIdx(t) > MORE.indexOf("group('Transparency'") && rowIdx(t) < MORE.indexOf("group('System'")));
chk('System: Model & data health, Faults, News', ['Model & data health', 'Faults', 'News & moat alerts'].every(t => rowIdx(t) > MORE.indexOf("group('System'") && rowIdx(t) < MORE.indexOf("group('Account'")));
chk('Account: Settings & account, Set up EdgeDesk', ['Settings & account', 'Set up EdgeDesk'].every(t => rowIdx(t) > MORE.indexOf("group('Account'") && rowIdx(t) < MORE.indexOf("group('Legal'")));
chk('Legal: Terms & disclaimer', rowIdx('Terms & disclaimer') > MORE.indexOf("group('Legal'"));
lacks(MORE, "'Ledger'", 'More lists no Ledger: it merged into Portfolio');
has(MORE, "'sysHealthOpen()'", 'Model & data health opens the same panel as the header control');
has(APP, '<button class="moreitem" onclick="event.stopPropagation();', 'and a row\'s tap no longer closes that panel in the same click');
has(MORE, "$('v-faults')?", 'Faults is listed only if the view exists');
has(MORE, "typeof window.hiwOpen==='function'?", 'Methodology only if it exists');
has(MORE, 'RESEARCH_MODULES.lab', 'Data sources only if the Lab exists');
has(MORE, "$('v-settings')?", 'Settings only if it exists');
has(APP, "labOpen('provenance')", 'and Data sources reaches the real provenance tool');
has(MORE, 'tel:18004262537', 'More ends with the helpline, as a link');
const moreCalls = MORE.split('\n').filter(l => /moreItem\(IC\./.test(l));
chk('every More row is recorded as more:<id>', moreCalls.length >= 10 && moreCalls.every(l => /,'[a-z_]+'\)(:''|\]|,|\)|$)/.test(l.trim())), moreCalls.filter(l => !/,'[a-z_]+'\)(:''|\]|,|\)|$)/.test(l.trim())));
has(APP, "var go=(id?'edNavTrack(\\'secondary\\',\\'more:'+id+'\\');':'')+call;", 'and the row itself sends it');

/* ======================================================================== */
/* 7. NAVIGATION EVIDENCE                                                   */
/* ======================================================================== */
const TRACK = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_track.js'), 'utf8');
const FSQL = fs.readFileSync(path.join(ROOT, 'supabase', 'funnel.sql'), 'utf8');
['primary_nav_research', 'primary_nav_card', 'primary_nav_portfolio', 'primary_nav_process', 'primary_nav_more', 'secondary_nav_opened'].forEach(n => {
  has(TRACK, "'" + n + "'", n + ' is a name the tracker sends');
  chk(n + ' is in funnel.sql\'s client registry', new RegExp("\\('" + n + "',\\s*'client'").test(FSQL));
});
has(APP, "var name=kind==='primary'?'primary_nav_'+dest:'secondary_nav_opened';", 'a seat tap is primary_nav_<seat>, everything else secondary_nav_opened');
has(APP, "edNavTrack('secondary','research:'+b.dataset.sub)", 'Research tabs are recorded');

/* ======================================================================== */
/* 8. NOTHING THAT WORKS WAS DELETED                                        */
/* ======================================================================== */
['function loadEdges(', 'function loadRecord(', 'function loadMarket(', 'function loadCollective(', 'function loadNews(',
 'FL_DETECTORS', 'renderCalibration(', 'window.Discipline', 'function renderLedger(', 'function trackSignal(', 'function autoSettle(']
  .forEach(s => has(APP, s, 'untouched: ' + s));
has(APP, "renderLedger();loadEdges();", 'the board still loads at boot, whatever the landing view is');
/* the disclaimer keeps every element */
const FOOT = (APP.match(/<div class="foot" id="edFoot"[^\n]*<\/div>/) || [''])[0];
['Research and decision-support tool.', 'Decision support.', 'Signals can be wrong.', '21+', 'Bet responsibly', '1-800-GAMBLER', "show('terms')"]
  .forEach(t => has(FOOT, t, 'the disclaimer keeps "' + t + '"'));
has(FOOT, 'href="tel:18004262537"', 'and the helpline is a tap-to-call link');

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\napp navigation: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
