#!/usr/bin/env node
/* ===========================================================================
   Tests for the Model Collective panel on the LANDING PAGE (index.html).

   WHY THIS EXISTS. That panel used to be three hardcoded games. It read well
   and it proved nothing: the one question a first-time reader has about a
   "collective" is whether anybody is actually in it, and an invented slate
   cannot answer that. So it now asks collective_public — /v1/meta, /v1/wall
   and /v1/games?sport=&season= — the same API the Collective's own site runs
   on, one sport at a time and with the reader's token when they have one.

   That is a network dependency on the first thing a stranger ever sees, so
   what is held here is the set of properties that makes it safe to have:

     - the worked example survives as a view of its own AND as the floor, so
       total network failure still leaves a readable panel;
     - every sport in meta is asked for by name and capped PER SPORT, because
       an NFL Sunday filling a shared limit is exactly how college football
       vanished from a merged board before;
     - one section failing is one section missing, never the panel;
     - nothing at all is requested until the section is scrolled to;
     - the API base is resolved per request, never at parse time — this block
       is in a different <script> from the one that declares SB_URL;
     - a locked row says which of the reasons it is, in the reader's words.

   Run: node tools/collective/landing_collective.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}

const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

/* ------------------------------------------------------------ the markup */
chk('the panel still has its game tab strip', IDX.includes('id="mcTabs"'));
chk('and a view switcher above it', IDX.includes('id="mcViews"'));
chk('and a status tag the loader can rewrite', IDX.includes('id="mcTag"'));
chk('and a footer the loader can rewrite', IDX.includes('id="mcFoot"'));
chk('and a Refresh control in the terminal bar', IDX.includes('id="mcRefresh"'));
chk('the Refresh control is a real button, not a link',
  /<button[^>]*id="mcRefresh"/.test(IDX));
chk('the game strip is the secondary strip, so two tab rows do not read as one',
  IDX.includes('class="tabs sub" id="mcTabs"'));
chk('the section the observer watches is still #collective',
  IDX.includes('<section class="band" id="collective">'));

/* the CSS the live states need, which a worked example never had */
['.term-bar .tbtn{', '.term-bar .tag.live{', '.tabs.sub{',
 '.mcw .mlk{', '.mcw .sb{', '.mcw .chip{', '.mcw .chip.fnd{', '.mcnote{'
].forEach(sel => chk('styles ' + sel.replace('{', ''), IDX.includes(sel)));

/* -------------------------------------------- the renderer, cut out of it */
const A = IDX.indexOf('(function collective(){');
const B = IDX.indexOf('\n\n/* ======================================================================\n   4 · EVIDENCE TABS');
if (A < 0 || B < 0 || B < A) {
  console.log('FAIL | index.html no longer carries the Collective block between its markers');
  process.exit(1);
}
const SRC = IDX.slice(A, B);
chk('the block is the one that talks to collective_public',
  SRC.includes('/collective_public'));
chk('and it asks for every sport meta names, not meta.sports[0]',
  SRC.includes('S.sports.map(') && !/sports\s*\[\s*0\s*\]/.test(SRC));

/* ------------------------------------------------------------- a stub DOM */
function el(id) {
  const node = {
    id, textContent: '', className: '', disabled: false,
    style: {}, _on: [], _html: '', _kids: null,
    addEventListener(k, fn) { this._on.push({ k, fn }); },
    /* Memoised on the current innerHTML, the way a real DOM is: wire()
       attaches its listeners to the nodes querySelectorAll hands back, so a
       fresh object per call would silently drop every click handler and the
       tests would pass on a panel whose tabs do nothing. */
    querySelectorAll() {
      if (this._kids) return this._kids;
      const out = [];
      const re = /<button\b([^>]*)>/g;
      let m;
      while ((m = re.exec(this._html))) {
        const attrs = m[1];
        const at = a => { const r = new RegExp(a + '="([^"]*)"').exec(attrs); return r ? r[1] : null; };
        out.push({ _at: attrs, getAttribute: at, _click: [],
                   addEventListener(k, fn) { if (k === 'click') this._click.push(fn); },
                   click() { this._click.forEach(f => f()); } });
      }
      this._kids = out;
      return out;
    },
    click() { this._on.filter(o => o.k === 'click').forEach(o => o.fn()); }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this._kids = null; }
  });
  return node;
}
const DOM = {};
['mcTabs', 'mcPanel', 'mcViews', 'mcTag', 'mcFoot', 'mcRefresh', 'collective']
  .forEach(id => { DOM[id] = el(id); });

let observed = null;
global.window = global;
global.document = {
  getElementById: id => DOM[id] || null,
  createElement: () => ({ style: {} }),
  head: { appendChild() {} }
};
/* Held, never fired: proving that nothing is requested until the reader
   reaches the section is the point of arming it this way. */
global.IntersectionObserver = function (cb, opts) {
  this.observe = function (node) { observed = { cb, opts, node }; };
  this.disconnect = function () { observed = Object.assign({}, observed, { off: true }); };
};

let fetches = [];
global.fetch = function (url, opts) {
  fetches.push({ url: String(url), opts: opts || {} });
  return Promise.reject(new Error('no route in this test'));
};

/* SB_URL IS DELIBERATELY NOT DEFINED YET. This block ships in a different
   <script> from the one that declares it and blocks execute in order, so at
   the moment it runs SB_URL genuinely does not exist. Reading it at parse
   time is the bug that once left the app's Collective tab stuck on one word
   forever; defining it here would hide exactly that. */
let threw = null;
try { vm.runInThisContext(SRC, { filename: 'index.html [collective]' }); }
catch (e) { threw = String((e && e.stack) || e); }
chk('the block runs before SB_URL exists, as it really does', threw === null, { threw });
chk('so it exposes its surface', global.EDCollective && typeof global.EDCollective === 'object');

const EC = global.EDCollective || {};
chk('it painted the worked example immediately, with no network',
  DOM.mcPanel.innerHTML.includes('MooseMetrics'), { html: DOM.mcPanel.innerHTML.slice(0, 120) });
chk('and made no request at all before the section was reached',
  fetches.length === 0, { fetches });
chk('it armed an observer on the section instead',
  !!observed && observed.node === DOM.collective);
chk('with room to start loading just before the section arrives',
  !!observed && /px/.test(String(observed.opts && observed.opts.rootMargin)));
chk('the example is labelled an example, not a live board',
  DOM.mcTag.textContent === 'Interactive example', { got: DOM.mcTag.textContent });
chk('and the tag is not wearing the live colour',
  !/live/.test(DOM.mcTag.className), { got: DOM.mcTag.className });
chk('with only one view on offer while nothing has loaded',
  EC.views && EC.views().length === 1 && EC.views()[0].k === 'demo');
chk('so the view strip is hidden rather than showing a single tab',
  DOM.mcViews.style.display === 'none', { got: DOM.mcViews.style.display });
chk('the three example games are all selectable',
  DOM.mcTabs.querySelectorAll().length === 3);

/* Now block 1 has run, as it will have by the time anyone scrolls here. */
global.SB_URL = 'https://db.test';
global.SB_KEY = 'anon-key';
global.edSession = () => null;
global.sessionValid = () => false;

/* ------------------------------------------------------ per-sport capping */
function game(sport, i, settled) {
  const base = Date.parse('2026-09-05T00:00:00Z');
  return {
    sport, home: sport + 'H' + i, away: sport + 'A' + i,
    label: sport + 'A' + i + ' @ ' + sport + 'H' + i,
    kickoff_at: new Date(base + (settled ? -1 : 1) * (i + 1) * 3600e3).toISOString(),
    result: settled ? { home_score: 20, away_score: 17 } : null,
    models: []
  };
}
{
  const nfl = { games: [] }, cfb = { games: [] };
  for (let i = 0; i < 16; i++) nfl.games.push(game('NFL', i, false));
  for (let i = 0; i < 9; i++) cfb.games.push(game('CFB', i, false));
  const out = EC.flatten([nfl, cfb]);
  const codes = out.map(g => g.sport);
  chk('an NFL Sunday cannot fill the board on its own',
    codes.filter(c => c === 'NFL').length === 6, { got: codes.filter(c => c === 'NFL').length });
  chk('and college football survives beside it',
    codes.filter(c => c === 'CFB').length === 6, { got: codes.filter(c => c === 'CFB').length });
  chk('the merged list is in kickoff order',
    out.every((g, i) => i === 0 || g.kickoff_at >= out[i - 1].kickoff_at));
}
{
  const bd = { games: [] };
  for (let i = 0; i < 7; i++) bd.games.push(game('NFL', i, true));
  for (let i = 0; i < 2; i++) bd.games.push(game('NFL', 20 + i, false));
  const out = EC.flatten([bd]);
  chk('settled games are capped harder than upcoming ones',
    out.filter(g => g.result).length === 3, { got: out.filter(g => g.result).length });
  chk('and upcoming games come first, whatever their clock says',
    !out[0].result && !out[1].result && out[2].result);
  chk('settled games run newest first',
    out[2].kickoff_at >= out[3].kickoff_at);
}
chk('a board that failed and came back null is skipped, not rendered as empty',
  EC.flatten([null, undefined, { games: null }]).length === 0);

/* ------------------------------------------------------------ the routing */
const META = { sports: [{ code: 'NFL', season: 2026 }, { code: 'CFB', season: null }] };
const WALL = {
  rows: [
    { creator_name: 'MooseMetrics', model_name: 'Moose NFL', sport: 'NFL', founding: true,
      record: { wins: 41, losses: 33, pushes: 2, win_pct: 0.554, margin_mae: 10.42, brier: 0.2213 } },
    { creator_name: 'Newcomer', model_name: 'v0', sport: 'CFB', founding: false, record: null }
  ]
};
function board(sport, opts) {
  opts = opts || {};
  return {
    entitled: !!opts.entitled,
    games: [{
      sport, home: 'TEN', away: 'NYJ', label: 'NYJ @ TEN',
      kickoff_at: new Date(Date.now() + 864e5).toISOString(), result: null,
      consensus: opts.entitled
        ? { n: 3, spread_mean: -6, total_mean: 41.5, home_win_prob_mean: 0.75, locked: false }
        : { locked: true },
      models: opts.entitled
        ? [{ creator_slug: 'moosemetrics', locked: false, projected_spread: -2.5,
             pick_side: 'away', line_at_submission: -3, home_win_probability: 0.61,
             grade: { pick_result: 'WIN' } },
           { creator_slug: 'edgedesk', locked: false, projected_spread: -10.6,
             pick_side: 'home', line_at_submission: -3, home_win_probability: 0.82 }]
        : [{ creator_slug: 'moosemetrics', locked: true },
           { creator_slug: 'edgedesk', locked: true }]
    }]
  };
}
function route(url, entitled) {
  if (url.includes('/v1/meta')) return META;
  if (url.includes('/v1/wall')) return WALL;
  if (url.includes('/v1/games')) {
    const m = /sport=([^&]*)/.exec(url);
    return board(m ? decodeURIComponent(m[1]) : 'NFL', { entitled });
  }
  return null;
}
function serve(opts) {
  opts = opts || {};
  fetches = [];
  global.fetch = function (url, o) {
    fetches.push({ url: String(url), opts: o || {} });
    if (opts.dead) return Promise.reject(new Error('offline'));
    if (opts.fail && opts.fail.some(f => String(url).includes(f)))
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve(route(String(url), opts.entitled)) });
  };
}
const settle = () => new Promise(r => setTimeout(r, 0));

(async function main() {
  /* ------------------------------------------------ a signed-out first look */
  serve({});
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();

  const urls = fetches.map(f => f.url);
  chk('the API base resolved off SB_URL once block 1 had run',
    urls.every(u => u.indexOf('https://db.test/functions/v1/collective_public') === 0),
    { urls });
  chk('meta was asked for first', /\/v1\/meta$/.test(urls[0]), { urls });
  chk('the wall was asked for', urls.some(u => u.includes('/v1/wall')));
  chk('NFL was asked for by name',
    urls.some(u => u.includes('/v1/games?sport=NFL&season=2026')), { urls });
  chk('and so was CFB — every sport meta names, not just the first',
    urls.some(u => u.includes('/v1/games?sport=CFB&season=')), { urls });
  chk('a null season is sent as empty, not as the string "null"',
    !urls.some(u => u.includes('season=null')), { urls });
  chk('a signed-out reader sends no bearer at all',
    fetches.every(f => !(f.opts.headers && f.opts.headers.authorization)));

  chk('the wall is what a stranger lands on, because it needs no account',
    EC.state.view === 'wall', { got: EC.state.view });
  chk('and all three views are now on offer',
    EC.views().map(v => v.k).join(',') === 'wall,demo,board',
    { got: EC.views().map(v => v.k) });
  chk('so the view strip is shown', DOM.mcViews.style.display !== 'none');
  chk('the tag says it is live', /^Live · 2 models$/.test(DOM.mcTag.textContent),
    { got: DOM.mcTag.textContent });
  chk('and wears the live colour', /\blive\b/.test(DOM.mcTag.className));
  chk('the wall names the creators', DOM.mcPanel.innerHTML.includes('MooseMetrics'));
  chk('with their graded record', DOM.mcPanel.innerHTML.includes('41-33-2'));
  chk('their win rate to one decimal', DOM.mcPanel.innerHTML.includes('55.4%'));
  chk('their spread MAE to two', DOM.mcPanel.innerHTML.includes('10.42'));
  chk('their Brier to three', DOM.mcPanel.innerHTML.includes('0.221'));
  chk('a founding member is marked as one',
    /chip fnd">Founding</.test(DOM.mcPanel.innerHTML));
  chk('a model with no graded games says pending rather than 0-0-0',
    DOM.mcPanel.innerHTML.includes('pending'));
  chk('and its empty metrics are em dashes, never zeros',
    !/>0\.000</.test(DOM.mcPanel.innerHTML));
  chk('the wall view offers no game tabs', DOM.mcTabs.style.display === 'none');
  chk('the footer says the record is graded, not self-reported',
    /never self-reported/.test(DOM.mcFoot.innerHTML), { got: DOM.mcFoot.innerHTML });

  /* --------------------------------------------------------- the live board */
  const boardTab = DOM.mcViews.querySelectorAll().find(b => b.getAttribute('data-v') === 'board');
  chk('there is a board tab to click', !!boardTab);
  boardTab.click();
  chk('clicking it switches view', EC.state.view === 'board', { got: EC.state.view });
  chk('the board names the real game', DOM.mcPanel.innerHTML.includes('NYJ @ TEN'));
  chk('and says which sport it is', /Sport<\/span><span><b>NFL/.test(DOM.mcPanel.innerHTML));
  chk('both sports reached the tab strip',
    DOM.mcTabs.innerHTML.includes('NYJ @ TEN') && DOM.mcTabs.querySelectorAll().length === 2);
  chk('a signed-out reader sees the models by name',
    DOM.mcPanel.innerHTML.includes('moosemetrics'));
  chk('and is told how many posted it, which is the public fact about the game',
    /<b>2 models<\/b> posted this game/.test(DOM.mcPanel.innerHTML),
    { html: DOM.mcPanel.innerHTML });
  chk('a fully locked game is one honest line, not a column of identical cells',
    (DOM.mcPanel.innerHTML.match(/unlock before/g) || []).length === 1 &&
    !/<table/.test(DOM.mcPanel.innerHTML), { html: DOM.mcPanel.innerHTML });
  chk('and it names when they unlock rather than only that they are locked',
    /unlock before[\s\S]*kickoff for subscribers/.test(DOM.mcPanel.innerHTML));
  chk('and that they are graded in the open afterwards',
    /graded here for everyone afterwards/.test(DOM.mcPanel.innerHTML));
  chk('the footer tells a signed-out reader what is open and what is paid',
    /pre-kickoff model numbers are what a subscription buys/i.test(DOM.mcFoot.innerHTML),
    { got: DOM.mcFoot.innerHTML });
  chk('and points at the plan on this same page', DOM.mcFoot.innerHTML.includes('href="#pricing"'));
  chk('a market that never loaded is stated as missing, not invented',
    /no price captured yet/.test(DOM.mcPanel.innerHTML));

  /* the reader's own choice survives a refresh */
  serve({});
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('a refresh does not yank the reader back to the wall',
    EC.state.view === 'board', { got: EC.state.view });

  /* ------------------------------------------------------ an entitled reader */
  global.edSession = () => ({ access_token: 'real-token' });
  global.sessionValid = () => true;
  serve({ entitled: true });
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('a signed-in reader sends their own token on the board request',
    fetches.filter(f => f.url.includes('/v1/games'))
      .every(f => f.opts.headers && f.opts.headers.authorization === 'Bearer real-token'),
    { sent: fetches.filter(f => f.url.includes('/v1/games')).map(f => f.opts.headers) });
  chk('and the panel knows it is entitled', EC.state.entitled === true);
  chk('the numbers are there now', DOM.mcPanel.innerHTML.includes('TEN −2.5'),
    { html: DOM.mcPanel.innerHTML });
  chk('and nothing says Subscriber number', !/Subscriber number/.test(DOM.mcPanel.innerHTML));
  chk('the consensus row is a number, not a lock',
    /Consensus &middot; n=3/.test(DOM.mcPanel.innerHTML));
  chk('an away pick is displayed in the away side\'s own convention',
    DOM.mcPanel.innerHTML.includes('NYJ +3.0'), { html: DOM.mcPanel.innerHTML });
  chk('a home pick is displayed in the home side\'s',
    DOM.mcPanel.innerHTML.includes('TEN −3.0'));
  chk('a graded pick carries its result', /chip">WIN</.test(DOM.mcPanel.innerHTML));
  chk('the footer says so rather than selling to someone who already bought',
    /unlocked on your account/.test(DOM.mcFoot.innerHTML), { got: DOM.mcFoot.innerHTML });

  /* the anon key is not an identity */
  global.edSession = () => ({ access_token: 'anon-key' });
  serve({});
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('the publishable anon key is never sent as a bearer',
    fetches.every(f => !(f.opts.headers && f.opts.headers.authorization)),
    { sent: fetches.map(f => f.opts.headers) });
  global.edSession = () => null;
  global.sessionValid = () => false;

  /* ------------------------------------------------- one section at a time */
  serve({ fail: ['/v1/wall'] });
  EC.state.touched = false;
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('a dead wall does not take the board with it',
    EC.state.games.length > 0 && EC.state.wall.length === 0);
  chk('and the reader is put on the board instead of an empty wall',
    EC.state.view === 'board', { got: EC.state.view });
  chk('there is no wall tab to open onto nothing',
    !EC.views().some(v => v.k === 'wall'));

  serve({ fail: ['sport=CFB'] });
  EC.state.touched = false;
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('one sport failing leaves the other on the board',
    EC.state.games.length === 1 && EC.state.games[0].sport === 'NFL',
    { got: EC.state.games.map(g => g.sport) });
  chk('and the panel names the sport that is missing',
    /CFB/.test(EC.html.foot()), { got: EC.html.foot() });
  chk('while saying the rest of the page is unaffected',
    /unaffected/.test(EC.html.foot()));

  /* ------------------------------------------------- total network failure */
  serve({ dead: true });
  EC.state.touched = false;
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('with nothing reachable the panel falls back to the worked example',
    EC.state.view === 'demo', { got: EC.state.view });
  chk('which is still readable', DOM.mcPanel.innerHTML.includes('MooseMetrics'));
  chk('and is labelled an example again, not a live board',
    DOM.mcTag.textContent === 'Interactive example', { got: DOM.mcTag.textContent });
  chk('the panel never sits on the word Loading',
    !/Loading/.test(DOM.mcPanel.innerHTML) && DOM.mcTag.textContent !== 'Loading…');
  chk('and the Refresh button is handed back to the reader',
    DOM.mcRefresh.disabled === false);
  chk('the example footer makes no claim to be live',
    /worked example/.test(DOM.mcFoot.innerHTML), { got: DOM.mcFoot.innerHTML });

  /* ------------------------------------------------------------- the reading */
  chk('a model exactly on the number is 0.0, never a signed zero',
    !/[−+]0\.0/.test(EC.html.demo({ home: 'TEN', away: 'NYJ', market: -3, total: 39,
      rows: [{ m: 'flat', line: -3, hw: 0.5, age: '1h' }],
      cons: { line: -3, hw: 0.5, n: 1 } })));
  chk('a three-point disagreement is marked as the big one it is',
    /dlt big/.test(EC.html.demo({ home: 'TEN', away: 'NYJ', market: -3, total: 39,
      rows: [{ m: 'far', line: -7, hw: 0.5, age: '1h' }],
      cons: { line: -7, hw: 0.5, n: 1 } })));
  chk('and a delta with no market to measure against is a dash, not a number',
    /dlt">—/.test(EC.html.demo({ home: 'JAX', away: 'CLE', market: null, total: null,
      rows: [{ m: 'x', line: -8.1, hw: null, age: '1h' }],
      cons: { line: -8.1, hw: null, n: 1 } })));
  chk('a game nobody has posted says so rather than showing an empty table',
    /No model has posted this game yet/.test(
      EC.html.board({ home: 'TEN', away: 'NYJ', sport: 'NFL', models: [], consensus: null })));
  chk('an empty slate says so rather than throwing',
    /Nothing is on the Collective/.test(EC.html.board(null)));
  chk('a creator name is escaped, never injected',
    EC.html.board({ home: 'A', away: 'B', models: [{ creator_slug: '<img src=x>', locked: true }] })
      .includes('&lt;img src=x&gt;'));

  /* One model unlocked and the rest not is a real state — an entitled reader
     whose subscription covers one sport, or a creator seeing their own row —
     and it is the only case where the per-row lock is still what renders. */
  {
    const mixed = EC.html.board({
      home: 'TEN', away: 'NYJ', label: 'NYJ @ TEN', sport: 'NFL',
      consensus: { n: 2, spread_mean: -4, total_mean: 40, home_win_prob_mean: 0.6, locked: false },
      models: [{ creator_slug: 'mine', locked: false, projected_spread: -3.5,
                 pick_side: 'home', line_at_submission: -3, home_win_probability: 0.58 },
               { creator_slug: 'theirs', locked: true }]
    });
    chk('a partly locked game still renders as a table', /<table/.test(mixed));
    chk('with the unlocked number shown', mixed.includes('TEN −3.5'), { mixed });
    chk('and the locked row saying so in its own cells',
      /Subscriber number/.test(mixed) && /colspan="4"/.test(mixed));
    chk('an unlocked consensus is a number even when a row above it is locked',
      /Consensus &middot; n=2/.test(mixed));
  }
  chk('a locked consensus under unlocked rows is still named as locked',
    /Also a subscriber number/.test(EC.html.board({
      home: 'TEN', away: 'NYJ', sport: 'NFL', consensus: { locked: true },
      models: [{ creator_slug: 'mine', locked: false, projected_spread: -3 }] })));

  /* ------------------------------------------------------------------ done */
  const total = pass + fail;
  if (fail) {
    failures.forEach(f => console.log('FAIL | ' + f.name +
      (f.detail ? ' | ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  }
  console.log((fail ? 'FAILED' : 'PASS') + ' | landing_collective | ' + pass + '/' + total);
  process.exit(fail ? 1 : 0);
})();
