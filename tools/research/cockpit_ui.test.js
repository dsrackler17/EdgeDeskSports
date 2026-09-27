#!/usr/bin/env node
/* THE RESEARCH COCKPIT in app.html, run for real: the block between the
   RESEARCH COCKPIT marker and fbP4Card is sliced out of the page and executed
   with the shared research layer and a REAL CFB P4 projection. The card's
   helpers it calls (fbEsc, fbPts, fbP4Market, fbP4ContractFor) are the page's
   own where they are pure, and stubs only for the two that read board state.
   Pins: the answer-first cells, the exact decomposition, EV that is N/A with
   no market and priced from the model's own distribution with one, the data
   quality breakdown, and no pick language anywhere.
   Run: node tools/research/cockpit_ui.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String(e && e.stack).slice(0, 300); } }
  if (ok) { pass++; return; } fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail)).slice(0, 400)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const START = APP.indexOf('/* ═══ THE RESEARCH COCKPIT');
const END = APP.indexOf('function fbP4Card(u){');
chk('app.html carries the research cockpit ahead of the card', START > 0 && END > START);
if (!(START > 0 && END > START)) done();
function fnSrc(name) {
  const at = APP.indexOf('function ' + name + '(');
  const end = APP.indexOf('\n}\n', at);
  return at < 0 ? '' : APP.slice(at, end + 3);
}
/* fbEsc and fbPts are one-liners in the page */
function lineSrc(name) {
  const at = APP.indexOf('function ' + name + '(');
  return at < 0 ? '' : APP.slice(at, APP.indexOf('\n', at));
}

const c = { console, Date, Math, JSON, String, Number, Object, Array, isFinite, RegExp, Error, parseFloat };
c.window = c; c.self = c; c.globalThis = c;
vm.createContext(c);
['research_core.js', 'research_eval.js', 'game_research.js'].forEach((f) =>
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), c));
vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'params.js'), 'utf8'), c);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'), 'utf8'), c);
vm.runInContext(lineSrc('_escHtml') + '\n' + lineSrc('fbEsc') + '\n' + lineSrc('fbPts') + '\n' + APP.slice(START, END), c);
chk('the page helpers resolved', typeof c.fbEsc === 'function' && typeof c.fbPts === 'function' && typeof c.fbGxResearchRead === 'function');

const P = c.EDCfbP4Params, E = c.EDCfbP4;
const teams = Object.keys(P.rating.seed_ratings);
const HOME = teams.indexOf('alabama') >= 0 ? 'Alabama' : teams[0];
const AWAY = teams.indexOf('georgia') >= 0 ? 'Georgia' : teams[1];
function project(market) {
  return E.projectGame({ season: P.trained_through_season, week: 6, state: E.newState(),
    game: { home: HOME, away: AWAY, neutral_site: false, kickoff: '2025-10-11T19:00:00Z' },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } }, market: market || {} });
}
const recent = new Date(Date.now() - 2 * 3600e3).toISOString();
function unit(id) { return { g: { home_team: HOME, away_team: AWAY, game_id: id, week: 6, season: 2025 }, t: Date.now() + 86400e3 }; }
function setMarket(m) { c.fbP4Market = () => m; }
c.fbP4ContractFor = () => ({ rows: [
  { field: 'qb_starter', side: 'home', state: 'USABLE', as_of: recent },
  { field: 'qb_starter', side: 'away', state: 'UNAVAILABLE' },
  { field: 'weather', state: 'RESEARCH_ONLY', as_of: recent, source: 'open-meteo forecast' },
  { field: 'availability', side: 'home', state: 'UNAVAILABLE' }, { field: 'availability', side: 'away', state: 'UNAVAILABLE' }] });

/* ---- with a market ---- */
const p = project({ spread_line: 3.5, total_line: 52.5 });
setMarket({ spread_line: 3.5, total_line: 52.5, quotes_h2h: [[1.625, 2.35]], book: 'consensus', as_of: recent, stale: false });
const u = unit('1');
const read = c.fbGxResearchRead(u, p);
chk('answer first: market, fair, raw and normalized difference, both probabilities, total, completeness',
  ['Market now', 'EdgeDesk fair', 'Raw difference', 'Normalized difference', 'Win probability', 'Market no-vig',
    'Probability difference', 'Projected total', 'Data completeness'].every((k) => read.indexOf(k) >= 0), read.slice(0, 300));
chk('the market reads as a HOME line (-3.5), not the engine margin (+3.5)', read.indexOf(HOME + ' -3.5') >= 0, read.slice(0, 400));
chk('the normalized difference is in sigma units', /\d\.\d\dσ/.test(read));
chk('research flags explain themselves and disclaim picks', /not a pick, a rating or a probability/.test(read));
const dec = c.fbGxDecomp(u, p);
chk('decomposition lists the engine terms and states they sum exactly', /terms sum exactly to the published number/.test(dec)
  && /quarterback/i.test(dec) && /home-field/i.test(dec), dec.slice(0, 300));
chk('missing terms read "missing · 0" with a reason, never a silent zero', /missing · 0/.test(dec));
const price = c.fbGxPrice(u, p);
chk('the price panel uses the model cover probability at the market line', /Model cover/.test(price) && /%<\/td>/.test(price) && !/n\/a<\/span><\/td><td class="num"><span class="gx-miss">n\/a/.test(price), price.slice(0, 600));
chk('the price is labelled a REFERENCE price, not the market\'s', /reference/.test(price) && /not the market/.test(price));
const dq = c.fbGxQuality(u, p);
chk('data quality shows each category with its status', /UNAVAILABLE/.test(dq) && /PARTIAL/.test(dq) && /injuries/.test(dq) && /mean credit/.test(dq));
chk('research-only weather is AVAILABLE with a note that it is not priced', /research only: retrieved, not priced/.test(dq));

/* ---- without a market ---- */
const p0 = project({});
setMarket({ spread_line: null, total_line: null, quotes_h2h: null, book: null, as_of: null, stale: false });
const u0 = unit('2');
const read0 = c.fbGxResearchRead(u0, p0);
chk('no market: the market cell says none joined and no gap is printed', /no market joined/.test(read0) && !/\d\.\d\dσ/.test(read0));
chk('no market: the price panel says there is nothing to assess', /no price to assess/.test(c.fbGxPrice(u0, p0)));
chk('no market: flagged NO MARKET', /no market/.test(read0));

/* ---- language ---- */
const all = read + dec + price + dq + read0;
chk('no pick language anywhere on the cockpit', !/\b(LOCK|BEST BET|BET NOW|GUARANTEE|SMASH|HAMMER)\b/i.test(all));

/* ---- the shared layer is optional ---- */
chk('without the shared layer the cockpit renders nothing rather than a different number', (() => {
  const saved = c.EDGameResearch; c.EDGameResearch = null;
  const out = c.fbGxResearchRead(unit('3'), p);
  c.EDGameResearch = saved;
  return out === '';
})());

/* ---- scenarios: the real engine re-run ---- */
(function () {
  const req = { season: P.trained_through_season, week: 6, state: E.newState(),
    game: { home: HOME, away: AWAY, neutral_site: false, kickoff: '2025-10-11T19:00:00Z' },
    teams: { home: { conference: 'SEC', injuries: null }, away: { conference: 'SEC', injuries: null } }, market: {} };
  /* a fresh copy per call, sharing the rating state the way fbP4Request does */
  c.fbP4Request = () => Object.assign({}, req, { teams: JSON.parse(JSON.stringify(req.teams)), game: Object.assign({}, req.game) });
  const pp = E.projectGame(req);
  const html = c.fbGxScenarios(unit('9'), pp);
  chk('scenarios are labelled hypothetical and show baseline, scenario, difference', /hypothetical/.test(html) && /Baseline/.test(html) && /Difference/.test(html));
  chk('neutral field is a supported scenario that moves home-field', /Played on a neutral field <span class="ec mut">hypothetical/.test(html) && /home-field/i.test(html), html.slice(0, 900));
  chk('removing an input that was never supplied is not run', /Home injury report removed<\/td><td colspan="4" class="gx-miss">not run/.test(html));
  chk('no quarterback scenario is invented', /Quarterback scenarios are not offered/.test(html) && !/QB1 unavailable/.test(html));
})();

/* ---- follow a game: the timeline ---- */
(function () {
  const store = {};
  c.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const uu = unit('77');
  chk('an unfollowed game offers Follow and records nothing', /Follow this game/.test(c.fbGxWatch(uu, p))
    && !store.ed_research_follow_v1 && !store.ed_research_watch_v1);
  c.fbWatchSave({ '77': { since: '2025-10-01T00:00:00Z', events: [], last: null } });
  setMarket({ spread_line: 3.5, total_line: 52.5, quotes_h2h: null, book: 'consensus', as_of: recent, stale: false });
  uu._gr = null;
  const first = c.fbGxWatch(uu, p);
  chk('a newly followed game says nothing has changed yet, and never back-fills', /No change captured since you followed/.test(first));
  setMarket({ spread_line: 5, total_line: 52.5, quotes_h2h: null, book: 'consensus', as_of: new Date(Date.now() - 600e3).toISOString(), stale: false });
  uu._gr = null;
  const second = c.fbGxWatch(uu, p);
  chk('a captured market move becomes a timeline row with from and to', /Market spread/.test(second) && second.indexOf(HOME + ' -3.5') >= 0 && second.indexOf(HOME + ' -5.0') >= 0, second.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 900));
  chk('without storage the page still renders', (() => { c.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    return /Follow this game/.test(c.fbGxWatch(unit('78'), p)); })());
})();

/* ---- the follow list and the Desk watchlist no longer share a key ----
   Both used ed_research_watch_v1: the Desk stores an ARRAY there, the follow
   list an object keyed by game id, and whichever wrote last destroyed the
   other. The follow list now has its own key and carries over what it left
   under the old one; an array there is the Desk's and is never touched. */
(function () {
  const DESK_KEY = (APP.match(/var DESK_WATCH_KEY='([^']+)'/) || [])[1];
  const FOLLOW_KEY = c.FB_WATCH_KEY;
  chk('the Desk watchlist keeps ed_research_watch_v1', DESK_KEY === 'ed_research_watch_v1', DESK_KEY);
  chk('the follow list has a key of its own', FOLLOW_KEY === 'ed_research_follow_v1' && FOLLOW_KEY !== DESK_KEY, FOLLOW_KEY);
  function mem(init) {
    const store = Object.assign({}, init || {});
    c.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; } };
    return store;
  }
  const follow = (since) => ({ since, events: [], last: null });
  const deskList = [{ game_id: 'd1', sport: 'CFB', matchup: 'A @ B', added_at: '2025-10-01T00:00:00Z', open_questions: [] }];

  /* follows left under the old key by the old page move across, once */
  let store = mem({ ed_research_watch_v1: JSON.stringify({ '77': follow('2025-10-01T00:00:00Z'), '78': follow('2025-10-02T00:00:00Z') }) });
  const w = c.fbWatchLoad();
  chk('follows stored under the old key are carried over', () => !!(w['77'] && w['78']) && w['78'].since === '2025-10-02T00:00:00Z', w);
  chk('onto the follow list’s own key', () => JSON.parse(store.ed_research_follow_v1)['77'].since === '2025-10-01T00:00:00Z');
  chk('and cleared from the old key, so the Desk reads an empty list rather than a follow object', !('ed_research_watch_v1' in store));
  c.fbWatchLoad();
  chk('the carry-over happens once: a second load changes nothing', () => Object.keys(JSON.parse(store.ed_research_follow_v1)).join(',') === '77,78');

  /* the Desk's array under the old key is never touched */
  store = mem({ ed_research_watch_v1: JSON.stringify(deskList) });
  const w2 = c.fbWatchLoad();
  chk('with the Desk’s list under the old key, the follow list reads empty, never the array', !Array.isArray(w2) && Object.keys(w2).length === 0);
  chk('and the Desk’s list is left exactly as it was', store.ed_research_watch_v1 === JSON.stringify(deskList));
  /* the bug itself: a follow saved while the Desk's list is present */
  w2['91'] = follow('2025-10-03T00:00:00Z');
  c.fbWatchSave(w2);
  chk('a follow saved beside the Desk’s list survives the save (it used to vanish from an array)', () => JSON.parse(store.ed_research_follow_v1)['91'].since === '2025-10-03T00:00:00Z');
  chk('and the Desk’s list is still intact', () => JSON.parse(store.ed_research_watch_v1)[0].game_id === 'd1');
  /* the other direction: the Desk saving its list no longer touches a follow */
  store[DESK_KEY] = JSON.stringify(deskList.concat([{ game_id: 'd2', matchup: 'C @ D' }]));
  chk('the Desk writing its list leaves every follow in place', () => !!c.fbWatchLoad()['91'] && JSON.parse(store.ed_research_watch_v1).length === 2);

  /* both keys populated (an old tab wrote to the old key after the move) */
  store = mem({ ed_research_follow_v1: JSON.stringify({ '77': follow('NEW') }),
    ed_research_watch_v1: JSON.stringify({ '77': follow('OLD'), '80': follow('2025-10-04T00:00:00Z') }) });
  const w3 = c.fbWatchLoad();
  chk('a follow already on the new key is never overwritten by the old copy', () => w3['77'].since === 'NEW');
  chk('and one only on the old key is added', () => !!w3['80'] && w3['80'].since === '2025-10-04T00:00:00Z');

  /* bad data under the old key is left alone, never thrown on */
  store = mem({ ed_research_watch_v1: '{not json' });
  chk('unreadable data under the old key does not break the follow list', () => Object.keys(c.fbWatchLoad()).length === 0 && store.ed_research_watch_v1 === '{not json');
  /* a browser whose storage refuses writes keeps the old data where it was */
  store = mem({ ed_research_watch_v1: JSON.stringify({ '77': follow('X') }) });
  c.localStorage.setItem = () => { throw new Error('quota'); };
  chk('if the new key cannot be written, the old copy is not deleted', () => { c.fbWatchMigrate(); return 'ed_research_watch_v1' in store; });
})();

/* ---- explain ---- */
chk('explain tags every line with its evidence type and flags unanswerable questions', (() => {
  setMarket({ spread_line: 3.5, total_line: 52.5, quotes_h2h: [[1.625, 2.35]], book: 'consensus', as_of: recent, stale: false });
  const h = c.fbGxExplain(unit('ex'), p);
  return /model output/.test(h) && /market data/.test(h) && /uncertainty/.test(h) && /Not answerable/.test(h) && /Nothing here is written by a language model/.test(h);
})());

/* ---- the research queue ---- */
(function () {
  c.FB = { p4: {} };
  setMarket({ spread_line: 3.5, total_line: 52.5, quotes_h2h: null, book: 'consensus', as_of: recent, stale: false });
  const far = project({ spread_line: 3.5 });
  const rows = [{ u: unit('q1'), p: far }, { u: unit('q2'), p: { status: 'BLOCKED' } }];
  const html = c.fbP4QueueHTML(rows);
  const o = c.fbGxResearchObj(rows[0].u, far);
  if (o.flags.priority) {
    chk('the queue lists a flagged game with its gap in points and sigma', /WORTH RESEARCHING/.test(html) && /pts/.test(html) && /σ/.test(html));
    chk('the queue says it is a reading order, not a ranking of bets', /not a ranking of bets and not a probability/.test(html));
  } else chk('an unflagged slate draws no queue', html === '');
  chk('a blocked projection never enters the queue', !/q2/.test(html));
  chk('no market alone never queues a game', (() => {
    setMarket({ spread_line: null, total_line: null, quotes_h2h: null, book: null, as_of: null, stale: false });
    const u2 = unit('q3');
    return c.fbP4QueueHTML([{ u: u2, p: project({}) }]) === '';
  })());
  chk('the board mounts the queue above its rows', fnSrc('fbP4BoardHTML').indexOf('fbP4QueueHTML(visible)') > 0);
})();

/* ---- the card mounts it, and the page loads the layer ---- */
chk('fbP4Card mounts the cockpit sections', ['fbGxResearchRead(u,p)', 'fbGxDecomp(u,p)', 'fbGxPrice(u,p)', 'fbGxQuality(u,p)', 'fbGxScenarios(u,p)', 'fbGxWatch(u,p)', 'fbGxExplain(u,p)']
  .every((k) => fnSrc('fbP4Card').indexOf(k) >= 0));
chk('every new section has a toggle default so the first click does what it shows', /research:true,decomp:true,price:false,dq:false,scen:false,watch:false,explain:false/.test(APP));
chk('the board loads the shared research layer', ['lib/research_core.js', 'lib/research_eval.js', 'lib/game_research.js']
  .every((k) => fnSrc('fbP4Ensure').indexOf(k) >= 0));
done();
