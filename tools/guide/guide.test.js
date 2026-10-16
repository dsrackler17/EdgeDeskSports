#!/usr/bin/env node
/* ===========================================================================
   THE GUIDE, WITHOUT A BROWSER.

   lib/edgedesk_guide_content.js holds every word the introduction, the
   walkthroughs and the term explainers say; lib/edgedesk_guide.js decides
   when they appear and what is remembered. This suite holds both to the
   product's rules:

     * the copy never promises a result, never calls an estimate a sure
       thing, and every glossary entry says what the number cannot tell you;
     * every walkthrough step points at a control that exists in this build
       (each id, class and attribute in its selectors is found in app.html
       or the renderers), and every chip names a term the glossary has;
     * the first-visit introduction is asked once: a new visitor gets it, a
       reader who answered it (on this device or the account) or who already
       dismissed the old welcome does not;
     * app.html wires it in: the Help button, the scripts, the welcome hand-
       off, and the two first-run layers that wait while a walkthrough runs.

   The browser half is tools/guide/guide_ui.e2e.js.
   Run: node tools/guide/guide.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_guide_content.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_guide.js'));
const V = require(path.join(ROOT, 'lib', 'edgedesk_vocab.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}

const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const LIBS = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /\.js$/.test(f) && !/^edgedesk_guide/.test(f))
  .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n');
const CORPUS = APP + '\n' + LIBS;

/* every string the reader can see */
function strings() {
  const out = [];
  const I = C.INTRO;
  Object.keys(I).forEach((k) => { if (typeof I[k] === 'string') out.push(['intro.' + k, I[k]]); });
  I.points.forEach((p, i) => out.push(['intro.point' + i, p.join(' ')]));
  C.GLOSSARY.forEach((g) => ['term', 'aka', 'ask', 'short', 'what', 'use', 'limits'].forEach((k) => { if (g[k]) out.push([g.id + '.' + k, g[k]]); }));
  Object.keys(C.TOURS).forEach((id) => {
    const t = C.TOURS[id];
    out.push([id + '.title', t.title], [id + '.line', t.line]);
    t.steps.forEach((s, i) => {
      out.push([id + '.' + i + '.title', s.title], [id + '.' + i + '.body', s.body]);
      (s.adapt || []).forEach((a, j) => out.push([id + '.' + i + '.adapt' + j, a.body]));
      if (s.missing) out.push([id + '.' + i + '.missing', s.missing.body]);
      if (s.missing && s.missing.none) out.push([id + '.' + i + '.missing.none', s.missing.none.body]);
    });
  });
  return out;
}
const TEXT = strings();

console.log('\n== the copy keeps the product’s rules ==');
{
  const plain = (s) => String(s).replace(/<[^>]+>/g, ' ');
  /* the decision layer's banned words (lib/edgedesk_decision_ui.js), less
     "guarantee", which the guide uses only to say there is none */
  const BANNED = /\b(lock|max lock|free money|can'?t miss|mortgage|safe bet|this will win|best bet|bet now|smash|hammer|sure thing|can’t lose|can't lose)\b/i;
  const hits = TEXT.filter(([, s]) => BANNED.test(plain(s)));
  chk('no hype or certainty words anywhere in the guide', !hits.length, hits.map((h) => h[0]));
  const sentences = [];
  TEXT.forEach(([k, s]) => plain(s).split(/(?<=[.!?])\s+/).forEach((x) => sentences.push([k, x])));
  const promise = sentences.filter(([, x]) => /guarantee/i.test(x) && !/\b(not|never|no|nor)\b|n’t|n't/i.test(x));
  chk('every mention of a guarantee says there is none', !promise.length, promise);
  const edgeClaims = sentences.filter(([, x]) => /\b(you have|there is|this is) an edge\b/i.test(x));
  chk('no sentence asserts that an edge exists', !edgeClaims.length, edgeClaims);
  chk('the introduction says “Research, not picks.”', /Research, not picks/.test(C.INTRO.title));
  chk('the introduction separates an estimate from a guaranteed result', /estimate/i.test(C.INTRO.caution) && /not that a result is guaranteed/i.test(C.INTRO.caution));
  chk('the introduction offers “Show me around” and “Explore on my own”', C.INTRO.primary === 'Show me around' && C.INTRO.secondary === 'Explore on my own');
  chk('the introduction says how to reopen it', /reopen/i.test(C.INTRO.reopen) && /Help/.test(C.INTRO.reopen));
}

console.log('\n== the glossary ==');
{
  const ids = C.GLOSSARY.map((g) => g.id);
  chk('glossary ids are unique', new Set(ids).size === ids.length, ids);
  const need = ['fair-line', 'implied-probability', 'ev', 'clv', 'data-confidence', 'research-readiness', 'confidence', 'estimate-outcome', 'decision-classes', 'calibration', 'market-state'];
  chk('the terms the product needs are all explained', need.every((id) => C.glossary(id)), need.filter((id) => !C.glossary(id)));
  const thin = C.GLOSSARY.filter((g) => !(g.what && g.use && g.limits && g.short && g.ask && g.group && C.GROUPS.indexOf(g.group) >= 0));
  chk('every entry says what it is, how to use it, its limits, and asks its question', !thin.length, thin.map((g) => g.id));
  const brief = C.GLOSSARY.filter((g) => g.what.length > 520 || g.use.length > 320 || g.limits.length > 320 || g.short.length > 110);
  chk('every entry stays concise', !brief.length, brief.map((g) => g.id));
  const rel = [];
  C.GLOSSARY.forEach((g) => (g.related || []).forEach((r) => { if (!C.glossary(r)) rel.push(g.id + '→' + r); }));
  chk('every related term exists', !rel.length, rel);
  const tips = Object.keys(C.TIP_KEYS).filter((k) => !C.glossary(C.TIP_KEYS[k]));
  chk('every decision-layer tooltip key maps to an entry', !tips.length, tips);
  const unknownTip = Object.keys(C.TIP_KEYS).filter((k) => !V.HELP[k] && k !== 'break_even');
  chk('the tooltip keys mapped are the decision layer’s own (EDVocab.HELP)', !unknownTip.length, unknownTip);
  chk('confidence is never described as a win probability', /not the probability that a bet wins/i.test(C.glossary('confidence').limits));
  chk('EV says no fresh price means no EV', /no fresh, verified price/i.test(C.glossary('ev').limits));
  chk('edge says EdgeDesk won’t claim one without a verified price', /won’t claim one/i.test(C.glossary('edge').limits));
  chk('readiness says ready to research is not ready to bet', /not ready to bet/i.test(C.glossary('research-readiness').limits));
  chk('estimates, confidence and results are kept apart in one entry', /A good estimate can lose/i.test(C.glossary('estimate-outcome').limits));
  chk('search finds a term by its other names', C.search('no-vig').some((g) => g.id === 'implied-probability') && C.search('beat the close').some((g) => g.id === 'clv'));
  chk('search for nothing returns everything', C.search('').length === C.GLOSSARY.length);
}

console.log('\n== the walkthroughs ==');
{
  chk('every task offered has a walkthrough', C.TASKS.every((id) => C.TOURS[id]), C.TASKS);
  const sizes = Object.keys(C.TOURS).map((id) => [id, C.TOURS[id].steps.length]);
  chk('each walkthrough is short (3–6 steps)', sizes.every(([, n]) => n >= 3 && n <= 6), sizes);
  const chips = [];
  Object.keys(C.TOURS).forEach((id) => C.TOURS[id].steps.forEach((s, i) => (s.terms || []).forEach((t) => { if (!C.glossary(t)) chips.push(id + '.' + i + ':' + t); })));
  chk('every “What is …?” chip names a glossary entry', !chips.length, chips);
  const nexts = [];
  Object.keys(C.TOURS).forEach((id) => (C.TOURS[id].next || []).forEach((n) => { if (!C.TOURS[n] || n === id) nexts.push(id + '→' + n); }));
  chk('every “next up” walkthrough exists', !nexts.length, nexts);
  const noWay = [];
  Object.keys(C.TOURS).forEach((id) => C.TOURS[id].steps.forEach((s, i) => { if (!s.title || !s.body || !s.target || !('page' in s)) noWay.push(id + '.' + i); }));
  chk('every step has a title, words, a target and a page', !noWay.length, noWay);
  /* the first step of each walkthrough must survive a slow or failed load */
  const firstMissing = Object.keys(C.TOURS).filter((id) => !C.TOURS[id].steps[0].missing);
  chk('every walkthrough’s first step says what to do when its screen is missing', !firstMissing.length, firstMissing);

  /* every id, class and data attribute a step points at exists in this build */
  const NAMED = ['gameDetails', 'gameResearch', 'openedGame'];
  const bad = [];
  function tokens(sel) {
    const t = [];
    sel.replace(/#([A-Za-z][\w-]*)/g, (_, x) => { t.push(['id', x]); return _; });
    sel.replace(/\.([A-Za-z][\w-]*)/g, (_, x) => { t.push(['class', x]); return _; });
    sel.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, a, v) => { t.push(['attr', a + (v != null ? '="' + v + '"' : '')]); return _; });
    return t;
  }
  Object.keys(C.TOURS).forEach((id) => C.TOURS[id].steps.forEach((s, i) => {
    (Array.isArray(s.target) ? s.target : [s.target]).forEach((sel) => {
      if (typeof sel !== 'string' || NAMED.indexOf(sel) >= 0) return;
      tokens(sel.replace(/^card:/, '')).forEach(([kind, v]) => {
        const ok = kind === 'id' ? (CORPUS.indexOf('id="' + v + '"') >= 0 || CORPUS.indexOf("id = '" + v + "'") >= 0 || CORPUS.indexOf(".id = '" + v + "'") >= 0 || CORPUS.indexOf("'" + v + "'") >= 0)
          : kind === 'class' ? new RegExp('[\'" ]' + v.replace(/[-]/g, '\\-') + '[\'" ]').test(CORPUS) || CORPUS.indexOf('class="' + v) >= 0
            : CORPUS.indexOf(v.split('=')[0]) >= 0 && (v.indexOf('=') < 0 || CORPUS.indexOf(v) >= 0 || CORPUS.indexOf(v.replace(/"/g, "'")) >= 0 || CORPUS.indexOf(v.split('=')[1].replace(/"/g, '')) >= 0);
        if (!ok) bad.push(id + '.' + i + ' ' + kind + ' ' + v);
      });
    });
  }));
  chk('every selector a step points at exists in app.html or the renderers', !bad.length, bad);
  chk('the named targets are the engine’s own', NAMED.every((n) => fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_guide.js'), 'utf8').indexOf(n + ': function') >= 0));
  chk('the Card walkthrough’s rows are the Card’s own (data-edc-open / data-edd-open rows)', /edc-row/.test(LIBS) && /edd-row/.test(LIBS));
}

console.log('\n== pages ==');
{
  chk('Football offers both research walkthroughs', JSON.stringify(C.toursFor('research:football')) === '["game","numbers"]');
  chk('any other Research panel offers “Research a game”', JSON.stringify(C.toursFor('research:nhl')) === '["game"]');
  chk('Props, Card and Portfolio offer their own', C.toursFor('research:pprops')[0] === 'props' && C.toursFor('card')[0] === 'card' && C.toursFor('portfolio')[0] === 'track');
  chk('a screen with no walkthrough offers none (and Help says so)', C.toursFor('more').length === 0 && C.toursFor('settings').length === 0);
  chk('every screen has terms to look up', ['more', 'research:lab', 'card', 'record'].every((p) => C.termsFor(p).length > 0));
  const badTerms = [];
  Object.keys(C.PAGE_TERMS).forEach((p) => C.PAGE_TERMS[p].forEach((t) => { if (!C.glossary(t)) badTerms.push(p + ':' + t); }));
  chk('every page term exists', !badTerms.length, badTerms);
  chk('page labels read as places', C.pageLabel('research:pprops') === 'Research · Props' && C.pageLabel('research:zzz') === 'Research' && C.pageLabel('zzz') === 'This page');
}

console.log('\n== asked once, remembered ==');
{
  const now = Date.parse('2026-10-16T12:00:00Z');
  const day = 864e5;
  const st = G.blank();
  chk('a first visit gets the introduction', G.introDue({ state: st, meta: null, welcomeSeen: false, createdAt: null, now }) === true);
  chk('a new account gets it even though first-run pre-set the old welcome key', G.introDue({ state: st, welcomeSeen: true, createdAt: new Date(now - day).toISOString(), now }) === true);
  chk('a reader who answered it on this device does not', G.introDue({ state: Object.assign(G.blank(), { intro: 'dismissed' }), now }) === false);
  chk('a reader who answered it on their account does not (sign-out, new device)', G.introDue({ state: st, meta: { intro: 'done' }, now }) === false);
  chk('an existing reader who dismissed the old welcome is not interrupted', G.introDue({ state: st, welcomeSeen: true, createdAt: new Date(now - 90 * day).toISOString(), now }) === false);
  chk('…nor one whose account age is unknown', G.introDue({ state: st, welcomeSeen: true, createdAt: null, now }) === false);
  chk('an account is new for 14 days', G.isNewAccount(new Date(now - 13 * day).toISOString(), now) && !G.isNewAccount(new Date(now - 15 * day).toISOString(), now));

  const mem = {}; const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  chk('nothing stored reads as a blank state', JSON.stringify(G.readState(store)) === JSON.stringify(G.blank()));
  G.writeState(store, { intro: 'done', introAt: 'x', tours: { game: { status: 'done', at: 't' }, junk: { status: 'weird' } }, helpSeen: 1, extra: 1 });
  const back = G.readState(store);
  chk('the state round-trips through storage, normalised', back.intro === 'done' && back.tours.game.status === 'done' && !back.tours.junk && back.helpSeen === true && !('extra' in back), back);
  chk('a corrupt stored value reads as blank, never throws', (mem[G.KEY] = '{oops', JSON.stringify(G.readState(store)) === JSON.stringify(G.blank())));
  const thrower = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  chk('blocked storage reads blank and writes false', JSON.stringify(G.readState(thrower)) === JSON.stringify(G.blank()) && G.writeState(thrower, G.blank()) === false);
  chk('the key follows the edgedesk_* convention (cleared on sign-out with the rest)', /^edgedesk_/.test(G.KEY));
  const merged = G.mergeMeta(G.blank(), { intro: 'dismissed', at: 'a', done: ['card', 5] });
  chk('the account’s answer hydrates a fresh device', merged.intro === 'dismissed' && merged.tours.card.status === 'done' && !merged.tours['5']);
  const local = G.mergeMeta(Object.assign(G.blank(), { intro: 'done' }), { intro: 'dismissed' });
  chk('…without overwriting this device’s own answer', local.intro === 'done');
  chk('what the account keeps is small', JSON.stringify(G.metaOf(merged)) === JSON.stringify({ intro: 'dismissed', at: 'a', done: ['card'] }));
}

console.log('\n== availability and empty states ==');
{
  const env = (o) => ({ has: (s) => !!o[s], fn: (n) => !!o['fn:' + n], module: (m) => !!o['module:' + m], obj: (n) => !!o['obj:' + n] });
  chk('a walkthrough runs only when its screen exists', G.available(C.TOURS.card, env({ '#v-card': 1, 'obj:EDDecisionUI': 1 })) && !G.available(C.TOURS.card, env({ '#v-card': 1 })));
  chk('Props needs the props module', !G.available(C.TOURS.props, env({})) && G.available(C.TOURS.props, env({ 'module:pprops': 1 })));
  const strip = C.TOURS.game.steps[0];
  const el = (html) => ({ textContent: html.replace(/<[^>]+>/g, ''), querySelector: (sel) => (sel === '.gm-card' ? (/gm-card/.test(html) ? {} : null) : sel === '.gm-empty.err' ? (/gm-empty err/.test(html) ? {} : null) : sel === '.gm-empty' ? (/gm-empty/.test(html) ? {} : null) : null) });
  chk('a failed schedule is said as a failure, not an empty day', /didn’t load/.test((G.adaptFor(strip, el('<div class="gm-empty err">Unable to load games.</div>')) || {}).body || ''));
  chk('an empty day is said as an empty day', /No games are scheduled/.test((G.adaptFor(strip, el('<div class="gm-empty">No games scheduled today.</div>')) || {}).body || ''));
  chk('a partial failure with games on screen is not called a failure', G.adaptFor(strip, el('<article class="gm-card"></article><p>2 sports could not be loaded</p>')) === null);
  const propsLast = C.TOURS.props.steps[C.TOURS.props.steps.length - 1];
  chk('props without captured prices say there is no EV or edge to claim', /no EV to rank and no edge to claim/.test((G.adaptFor(propsLast, 'Sportsbook prices have not been captured yet.') || {}).body || ''));
  const pf = C.TOURS.track.steps[0];
  chk('Portfolio signed out says so', /not signed in/.test((G.adaptFor(pf, 'Sign in to use Portfolio.') || {}).body || ''));
  chk('Portfolio unreachable says nothing was lost', /nothing you entered is lost/.test((G.adaptFor(pf, 'Could not reach the database. Nothing was changed.') || {}).body || ''));
  chk('a rule that throws does not apply', G.adaptFor({ adapt: [{ when: () => { throw new Error('x'); }, body: 'b' }] }, { textContent: '' }) === null);
}

console.log('\n== wired into app.html ==');
{
  chk('the Help button is in the header, labelled, before the account menu', /id="edHelpBtn"[^>]*aria-label="Help: learn EdgeDesk"/.test(APP) && APP.indexOf('id="edHelpBtn"') < APP.indexOf('class="edav-wrap"') && APP.indexOf('id="edHelpBtn"') > APP.indexOf('class="appbar"'));
  chk('the account menu and More → Account offer Learn EdgeDesk', /EDGuide\.openHelp\('home'/.test(APP) && /moreItem\(IC\.help,'Learn EdgeDesk'/.test(APP)
    && APP.indexOf("moreItem(IC.help,'Learn EdgeDesk'") > APP.indexOf("group('Account'") && APP.indexOf("moreItem(IC.help,'Learn EdgeDesk'") < APP.indexOf("group('Legal'"));
  const ci = APP.indexOf('/lib/edgedesk_guide_content.js'), ei = APP.indexOf('/lib/edgedesk_guide.js');
  chk('the words load before the engine, after first-run', ci > 0 && ei > ci && ci > APP.indexOf('/lib/edgedesk_first_run.js'));
  chk('the stylesheet is linked', /\/lib\/edgedesk_guide\.css\?v=/.test(APP));
  chk('the old welcome hands the first visit to the guide', /window\.EDGuide&&window\.EDGuide\.openIntro/.test(APP) && /if\(!window\.EDGuide\)window\.welOpen\(false\)/.test(APP));
  const pui = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_personal_ui.js'), 'utf8');
  const dui = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'), 'utf8');
  chk('the six-step onboarding waits while the guide is busy', /function onbBusy\(\)[\s\S]{0,600}EDGuide\.busy\(\)/.test(pui));
  chk('the Card’s own onboarding never opens over a walkthrough', /function maybeOnboard\(\)[\s\S]{0,400}EDGuide\.busy\(\)/.test(dui));
  chk('decision-layer tooltips carry their key for the explainer', /data-ed-tip="' \+ esc\(key\)/.test(dui));
  chk('football labels carry their term', /function fbTermAttr\(l\)/.test(APP) && (APP.match(/fbTermAttr\(l\)\+'>'/g) || []).length >= 3);
  const props = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_props_ui.js'), 'utf8');
  const terms = (props.match(/'([a-z-]+)'/g) || []);
  chk('props labels carry their term, and every term exists', /function termAttr\(label\)/.test(props) && /var TERM = \{[^}]*\}/.test(props)
    && props.match(/var TERM = \{([\s\S]*?)\};/)[1].match(/: '([a-z-]+)'/g).every((m) => C.glossary(m.slice(3, -1))), terms.length);
  const marked = (CORPUS.match(/data-ed-term="([a-z-]+)"/g) || []).map((m) => m.slice(14, -1));
  chk('every data-ed-term in the app names a glossary entry', marked.length > 0 && marked.every((id) => C.glossary(id)), marked.filter((id) => !C.glossary(id)));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | guide | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
