#!/usr/bin/env node
/* ===========================================================================
   Tests for the Model Collective panel on the LANDING PAGE (index.html).

   WHAT THE PANEL IS FOR. It used to be three hardcoded games — a worked
   example that read well and proved nothing, because the one question a
   stranger has about a "collective" is whether anybody is in it. So it asks
   collective_public (/v1/meta, /v1/wall, /v1/games?sport=&season=) and shows
   that the Collective is real: who is in it, what is on the slate, and who
   has posted each game.

   AND NOTHING ELSE. THE GRADED RECORD IS THE MOAT. A model's win rate,
   spread MAE, Brier, its line on a game, its win probability, its pick and
   the consensus of the room are what a subscription buys. None of it may
   appear on this page, for any reader — so the bulk of what is held here is
   the ABSENCE of those numbers, checked against payloads that carry them in
   full. If a future change starts rendering them, these fail.

   That is also why the panel sends no bearer: nothing here is gated, so
   identifying the reader could only unlock something that must not print.

   The rest is the properties that make a network dependency safe on the
   first thing a stranger sees:

     - the worked example is a view of its own AND the floor, so total
       network failure still leaves a readable panel;
     - every sport in meta is asked for by name and capped PER SPORT, because
       an NFL Sunday filling a shared limit is how college football vanished
       from a merged board before;
     - one section failing is one section missing, never the panel;
     - nothing at all is requested until the section is scrolled to;
     - the API base is resolved per request, never at parse time — this block
       is in a different <script> from the one that declares SB_URL.

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
 '.mcw .sb{', '.mcw .chip{', '.mcw .chip.fnd{', '.mcw .chip.ok{', '.mcnote{'
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
/* THE MOAT, ENFORCED IN THE SOURCE. A bearer header is the mechanism by
   which a paid number could ever reach this page, so the block must not
   contain one at all — not a disabled one, not a conditional one. */
chk('the block never builds an authorization header',
  !/authorization/i.test(SRC), { found: (/.{0,60}authorization.{0,60}/i.exec(SRC) || [])[0] });
chk('and never reads a session or a token',
  !/edSession|access_token|sessionValid|SB_KEY/.test(SRC));
chk('and has no notion of an entitled reader, because nothing here is gated',
  !/entitled/i.test(SRC));

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
  chk('and what they model', DOM.mcPanel.innerHTML.includes('Moose NFL'));
  chk('and which sport it is for', DOM.mcPanel.innerHTML.includes('NFL'));
  chk('a founding member is marked as one',
    /chip fnd">Founding</.test(DOM.mcPanel.innerHTML));
  chk('a model that has been graded says so',
    /chip ok">Graded</.test(DOM.mcPanel.innerHTML));
  chk('and one that has not says that instead of an empty row',
    /Pending first grade/.test(DOM.mcPanel.innerHTML));

  /* THE MOAT. The fixture above carries a complete record for MooseMetrics —
     41-33-2, 55.4%, MAE 10.42, Brier 0.2213. Not one of those numbers may
     reach a public page: they are the entire thing a subscription buys. */
  {
    const h = DOM.mcPanel.innerHTML;
    chk('the wall does not publish the win-loss record', !/41-33-2|41\s*-\s*33/.test(h), { h });
    chk('nor the win rate', !/55\.4|0\.554/.test(h), { h });
    chk('nor the spread MAE', !/10\.42/.test(h), { h });
    chk('nor the Brier score', !/0\.22|0\.2213/.test(h), { h });
    chk('nor coverage', !/88/.test(h), { h });
    chk('in fact the wall prints no decimal number at all', !/\d\.\d/.test(h), { h });
  }
  chk('the wall view offers no game tabs', DOM.mcTabs.style.display === 'none');
  chk('the footer says the records exist and are inside, not what they say',
    /How each one has actually graded is inside/.test(DOM.mcFoot.innerHTML),
    { got: DOM.mcFoot.innerHTML });
  chk('and the wall itself points at the plan',
    DOM.mcPanel.innerHTML.includes('href="#pricing"'));

  /* --------------------------------------------------------- the live board */
  const boardTab = DOM.mcViews.querySelectorAll().find(b => b.getAttribute('data-v') === 'board');
  chk('there is a board tab to click', !!boardTab);
  boardTab.click();
  chk('clicking it switches view', EC.state.view === 'board', { got: EC.state.view });
  chk('the board names the real game', DOM.mcPanel.innerHTML.includes('NYJ @ TEN'));
  chk('and says which sport it is', /Sport<\/span><span><b>NFL/.test(DOM.mcPanel.innerHTML));
  chk('both sports reached the tab strip',
    DOM.mcTabs.innerHTML.includes('NYJ @ TEN') && DOM.mcTabs.querySelectorAll().length === 2);
  chk('the board names the models that posted it',
    DOM.mcPanel.innerHTML.includes('moosemetrics'));
  chk('and how many there were, which is a fact about the game, not about a model',
    /<b>2 models<\/b> posted this game/.test(DOM.mcPanel.innerHTML),
    { html: DOM.mcPanel.innerHTML });
  chk('the board is never a table of numbers', !/<table/.test(DOM.mcPanel.innerHTML));
  chk('it says where the numbers are instead',
    /are in the Collective/.test(DOM.mcPanel.innerHTML));
  chk('and points at the plan', DOM.mcPanel.innerHTML.includes('href="#pricing"'));
  chk('and at the Collective itself',
    DOM.mcPanel.innerHTML.includes('href="/collective/"'));

  /* the reader's own choice survives a refresh */
  serve({});
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('a refresh does not yank the reader back to the wall',
    EC.state.view === 'board', { got: EC.state.view });

  /* ------------------------------------------------------------- THE MOAT
     The board payload here is the FULLY UNLOCKED one — every model's spread,
     its win probability, its pick at the line it was made against, its grade,
     and the consensus of the room. That is what the API returns to somebody
     who has paid. This is a public page, so none of it may be rendered even
     when it is sitting right there in the payload. */
  global.edSession = () => ({ access_token: 'real-token' });
  global.sessionValid = () => true;
  serve({ entitled: true });
  EC.refresh();
  for (let i = 0; i < 12; i++) await settle();
  chk('a signed-in reader is still asked for anonymously — nothing here is gated',
    fetches.every(f => !(f.opts.headers && f.opts.headers.authorization)),
    { sent: fetches.map(f => f.opts.headers) });
  {
    const h = DOM.mcPanel.innerHTML;
    chk('an unlocked payload still yields no model spread',
      !/-?2\.5|−2\.5|10\.6/.test(h), { h });
    chk('no win probability', !/61%|82%|0\.61|0\.82/.test(h), { h });
    chk('no pick', !/pick/i.test(h) && !/\+3\.0|−3\.0/.test(h), { h });
    chk('no grade', !/\bWIN\b/.test(h), { h });
    chk('no consensus figure — the word may appear in prose, the number may not',
      !/Consensus\s*(&middot;|·)\s*n=/.test(h) && !/-?6\.0|−6\.0|75%/.test(h), { h });
    chk('no total', !/41\.5/.test(h), { h });
    chk('the board prints no decimal number at all', !/\d\.\d/.test(h), { h });
    chk('what it does print is who posted it',
      /<b>2 models<\/b> posted this game/.test(h), { h });
  }
  chk('and the footer says the same to everyone, paid or not',
    /The lines, the probabilities and the consensus are inside/.test(DOM.mcFoot.innerHTML),
    { got: DOM.mcFoot.innerHTML });
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

  /* A payload where the API unlocked SOME rows — an account entitled to one
     sport, or a creator seeing their own row. The lock flag on the wire is
     not what keeps numbers off this page; the renderer is. */
  {
    const mixed = EC.html.board({
      home: 'TEN', away: 'NYJ', label: 'NYJ @ TEN', sport: 'NFL',
      consensus: { n: 2, spread_mean: -4, total_mean: 40, home_win_prob_mean: 0.6, locked: false },
      models: [{ creator_slug: 'mine', locked: false, projected_spread: -3.5,
                 pick_side: 'home', line_at_submission: -3, home_win_probability: 0.58 },
               { creator_slug: 'theirs', locked: true }]
    });
    chk('an unlocked row is still not printed', !/3\.5|−3\.5/.test(mixed), { mixed });
    chk('an unlocked consensus is still not printed',
      !/n=2/.test(mixed) && !/58%|60%/.test(mixed), { mixed });
    chk('both models are still named, which is the point of the row',
      mixed.includes('mine') && mixed.includes('theirs'));
    chk('and the count counts both', /<b>2 models<\/b>/.test(mixed));
  }
  /* A settled game is the one place a number would be safe — the final score
     is public — but the models' grades are not, so it stays a pointer. */
  {
    const done = EC.html.board({
      home: 'TEN', away: 'NYJ', label: 'NYJ @ TEN', sport: 'NFL',
      result: { home_score: 20, away_score: 17 },
      consensus: { n: 2, spread_mean: -4, locked: false },
      models: [{ creator_slug: 'mine', locked: false, projected_spread: -3.5,
                 grade: { pick_result: 'WIN' } }]
    });
    chk('a settled game says it is final and graded', /Final, and graded/.test(done));
    chk('without printing how anybody graded', !/\bWIN\b/.test(done), { done });
    chk('and points inside for it', /are in the Collective/.test(done));
  }

  /* ------------------------------------------------------------------ done */
  const total = pass + fail;
  if (fail) {
    failures.forEach(f => console.log('FAIL | ' + f.name +
      (f.detail ? ' | ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  }
  console.log((fail ? 'FAILED' : 'PASS') + ' | landing_collective | ' + pass + '/' + total);
  process.exit(fail ? 1 : 0);
})();
