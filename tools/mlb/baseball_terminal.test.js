#!/usr/bin/env node
/* ===========================================================================
   THE BASEBALL RESEARCH TERMINAL — the layer above the boards.

   WHAT IT ASSERTS, and every one of these is a rule the surface would
   otherwise break quietly:

     1  THE PANEL IS NOT THE ARCHIVE. A database with no mlbhist installed
        still gets the snapshot, the signals, the card and every projection,
        because none of them is read from mlbhist. This is the failure that
        left a full MLB card sitting under "Loading the MLB card…" forever.
     2  ONE NUMBER, ONE PLACE. The overview, the signals and the board rows
        are all drawn from the same cached engine call, so an overview figure
        can never disagree with the card beneath it.
     3  A DISAGREEMENT IS NEVER AN EDGE. The strongest word the surface may
        use is disagreement, past the guard bound it must say data fault, and
        the model status must state that nothing here has been graded against
        a closing line.
     4  NOTHING IS INVENTED. No engine means no projection and a sentence
        saying so; no price means no comparison; an unposted starter is named.
     5  THE COLLEGE CARD IS A CLUB-LEVEL NUMBER and says so on every game,
        because that source carries no starting pitcher at all.
     6  FILTERS AND ORDERING ARE REAL. The board can be reduced to the games
        the model disagrees with, and ordered by how far apart they are.

   It runs the SHIPPED source, sliced out of app.html, against the real
   engine. Nothing here is a rewritten copy.

   Run: node tools/mlb/baseball_terminal.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
require(path.join(ROOT, 'mlb', 'params.js'));
const EDBaseball = require(path.join(ROOT, 'mlb', 'engine.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 300); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : '')); return false;
}
function has(hay, needle, name) { return chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { return chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }
function eq(name, got, want) { return chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function near(name, got, want, tol) {
  const d = Math.abs(Number(got) - Number(want));
  return chk(name, Number.isFinite(d) && d <= (tol == null ? 0.005 : tol), 'got ' + got + ', want ' + want);
}

/* ---- the shipped source, sliced by name -------------------------------- */
function slice(startMark, endMark, label) {
  const a = APP.indexOf(startMark);
  if (a < 0) { console.log('FAIL | app.html no longer carries ' + label + ' where this test slices it'); process.exit(1); }
  const b = APP.indexOf(endMark, a);
  if (b < 0) { console.log('FAIL | app.html no longer ends ' + label + ' where this test slices it'); process.exit(1); }
  return APP.slice(a, b);
}
const TERMINAL = slice('/* ═══ BASEBALL RESEARCH TERMINAL',
  "researchRegister({id:'baseball'", 'the baseball research terminal');
/* the terminal kit it renders through, taken whole rather than stubbed: a
   stub would let the layout pass while shipping something else */
const KIT = slice('var RS_TK_ICONS={', '/* a module that has no overview of its own', 'the research terminal kit');
const MLBNORM = APP.match(/function mlbNorm\(x\)\{[^\n]*\n/)[0];

const PRELUDE = `
function stEsc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
function mlbhEsc(s){return stEsc(s==null?"":String(s));}
function cbbEsc(s){return stEsc(s==null?"":String(s));}
function edEsc(s){return stEsc(s);}
function edAttrJs(s){return edEsc(String(s==null?'':s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'"));}
function ago(t){return t?'1m ago':'—';}
function whenLabel(iso){return 'Wed, Sep 18, 7:10 PM';}
function rsNorm(s){return String(s==null?'':s).toLowerCase();}
function rsParseStamp(v){return v?Date.parse(v):null;}
function rsFreshness(){return {published:false,builtAt:null,stale:false};}
function rsStateHTML(){return '';}
function rsBadgeHTML(){return '';}
function rsMetaRender(){}
function edEvent(){}
function $(id){return null;}
var RESEARCH_MODULES={};
var RS_PROV={baseball:[{nm:'x',tier:'T0',src:'y'}]};
var RS_LIMITS={baseball:['a limitation']};
function mlbbNum(v){if(v==null||v==='')return null;var n=+v;return isFinite(n)?n:null;}
function mlbbGameTime(g){return g.start_time_local||'7:10 PM ET';}
function mlbbDayLabel(d){return d===MLBB.days[0]?'Today':'Tomorrow';}
function mlbbPool(){return [].concat(window.EDGES||[],window.D5_POOL||[],window.CONS_POOL||[]);}
function mlbhSetSeg(){}
function cbbOpenBrief(){return false;}
function mlbbOpenBrief(){return false;}
function renderBaseball(){}
var MLBH={seg:'games',err:null,errCode:null,at:null,status:null,meta:null};
var MLBO={};
`;

/* ---- fixtures ---------------------------------------------------------- */
const TODAY = '2026-06-10', TOMORROW = '2026-06-11';

function card(o) {
  return Object.assign({
    game_date: TODAY, start_time: TODAY + 'T23:10:00Z', start_time_local: '7:10 PM',
    venue: 'A Ballpark', status: 'Scheduled', game_number: 1,
    run_factor: 100, hr_factor: 100, is_dome: false,
    temp_f: 70, wind_mph: 0, wind_rel: 'out', precip_prob: 0
  }, o);
}
const CARDS = [
  /* 1 — full strength, a captured total the model disagrees with */
  card({ away_team_id: 147, home_team_id: 121,
    away_team_name: 'New York Yankees', away_record: '40-25', away_pitcher_name: 'Gerrit Cole', away_pitcher_throws: 'R',
    home_team_name: 'New York Mets', home_record: '34-31', home_pitcher_name: 'Kodai Senga', home_pitcher_throws: 'R' }),
  /* 2 — no starter posted on either side */
  card({ away_team_id: 111, home_team_id: 119, start_time: TODAY + 'T23:40:00Z',
    away_team_name: 'Boston Red Sox', away_record: '33-32',
    home_team_name: 'Los Angeles Dodgers', home_record: '41-24', venue: 'Dodger Stadium' }),
  /* 3 — tomorrow, wind blowing hard out of a hitters' park */
  card({ game_date: TOMORROW, start_time: TOMORROW + 'T23:10:00Z', away_team_id: 158, home_team_id: 112,
    away_team_name: 'Milwaukee Brewers', away_record: '30-35', away_pitcher_name: 'Freddy Peralta', away_pitcher_throws: 'R',
    home_team_name: 'Chicago Cubs', home_record: '32-33', home_pitcher_name: 'Justin Steele', home_pitcher_throws: 'L',
    venue: 'Wrigley Field', run_factor: 106, wind_mph: 16, wind_rel: 'out', temp_f: 84 })
];

const TEAM_SEASON = {
  'newyorkyankees': { runs_per_game: 5.30, ra_per_game: 3.90 },
  'newyorkmets': { runs_per_game: 4.10, ra_per_game: 4.60 },
  'bostonredsox': { runs_per_game: 4.40, ra_per_game: 4.45 },
  'losangelesdodgers': { runs_per_game: 5.10, ra_per_game: 3.80 },
  'milwaukeebrewers': { runs_per_game: 4.20, ra_per_game: 4.30 },
  'chicagocubs': { runs_per_game: 4.35, ra_per_game: 4.55 },
  'atlantabraves': { runs_per_game: 4.60, ra_per_game: 4.10 },
  'houstonastros': { runs_per_game: 4.50, ra_per_game: 4.05 },
  'seattlemariners': { runs_per_game: 4.05, ra_per_game: 3.95 },
  'sandiegopadres': { runs_per_game: 4.30, ra_per_game: 4.20 }
};
const PITCHER_SEASON = {
  'gerritcole': { era: 2.85, fip: 3.05, ip: 88, games_started: 14 },
  'kodaisenga': { era: 3.60, fip: 3.90, ip: 70, games_started: 12 },
  'freddyperalta': { era: 3.40, fip: 3.70, ip: 78, games_started: 13 },
  'justinsteele': { era: 4.10, fip: 4.20, ip: 74, games_started: 13 }
};

function build(opts) {
  opts = opts || {};
  const ctx = {
    console, Date, Math, JSON, String, Number, Array, Object, isFinite, parseFloat, parseInt,
    Intl, RegExp, setTimeout, document: { activeElement: null, querySelectorAll: () => [], addEventListener: () => {} }
  };
  ctx.window = ctx;
  ctx.MLBB = {
    at: opts.neverLoaded ? null : Date.now(), err: opts.cardErr || null, loading: null,
    days: [TODAY, TOMORROW], season: 2026,
    cards: opts.noCard ? [] : CARDS.map((g, i) => Object.assign({ __key: 'k' + i, __game_id: 900 + i }, g)),
    teamSeason: opts.noRates ? {} : TEAM_SEASON,
    pitcherSeason: PITCHER_SEASON, pitchers: {}, offense: {},
    read: { mlb_game_cards: 'VERIFIED', games: 'VERIFIED', team_season: 'VERIFIED',
      mlbhist: opts.noArchive ? 'NOT_INSTALLED' : 'VERIFIED' },
    coverage: opts.noArchive ? null : { start: 2016, end: 2025 }, byGame: {}
  };
  ctx.MLBB.cards.forEach((g) => { ctx.MLBB.byGame[g.__key] = g; });
  ctx.CBB = opts.cbb || { at: null, board: null, seasonTable: null, seasonTableErr: null,
    projRows: null, projRowsAt: null, err: null, errCode: null };
  ctx.MLBPEN = { 121: [{ severity: 2 }, { severity: 1 }] };
  ctx.MLBCL = {};
  /* One captured total the model will disagree with, plus both moneyline
     sides so a fair number exists to compare against. */
  ctx.EDGES = opts.noMarket ? [] : [
    { sport_key: 'baseball_mlb', event_id: 'ev1', away_team: 'New York Yankees', home_team: 'New York Mets',
      market: 'totals', selection: 'Over', point: 7.5, best_dec: 1.91, best_book: 'Pinnacle', n_books: 9,
      sharp_fair: 0.51, last_seen_at: new Date(Date.now() - 4 * 60000).toISOString() },
    { sport_key: 'baseball_mlb', event_id: 'ev1', away_team: 'New York Yankees', home_team: 'New York Mets',
      market: 'totals', selection: 'Under', point: 7.5, best_dec: 1.95, best_book: 'Pinnacle', n_books: 9,
      last_seen_at: new Date(Date.now() - 4 * 60000).toISOString() },
    { sport_key: 'baseball_mlb', event_id: 'ev1', away_team: 'New York Yankees', home_team: 'New York Mets',
      market: 'h2h', selection: 'New York Mets', point: null, best_dec: 2.45, first_best_dec: 2.30,
      best_book: 'Pinnacle', n_books: 9, sharp_fair: 0.415,
      last_seen_at: new Date(Date.now() - 4 * 60000).toISOString() },
    { sport_key: 'baseball_mlb', event_id: 'ev1', away_team: 'New York Yankees', home_team: 'New York Mets',
      market: 'h2h', selection: 'New York Yankees', point: null, best_dec: 1.62,
      best_book: 'Pinnacle', n_books: 9, last_seen_at: new Date(Date.now() - 4 * 60000).toISOString() }
  ];
  ctx.D5_POOL = []; ctx.CONS_POOL = [];
  ctx.EDBaseballParams = opts.noModel ? null : global.EDBaseballParams;
  ctx.EDBaseball = opts.noModel ? null : EDBaseball;
  vm.createContext(ctx);
  vm.runInContext(MLBNORM + PRELUDE + KIT + TERMINAL, ctx);
  return ctx;
}

/* =========================================================================
   1 — THE ROWS, AND THE ONE ENGINE CALL BEHIND THEM
   ========================================================================= */
{
  const ctx = build();
  const rows = ctx.mlbxRows();
  eq('a row for every game on the card', rows.length, 3);
  chk('every row projected', rows.every((r) => r.ok));
  chk('the rows are cached against the load stamp', ctx.mlbxRows() === rows);
  ctx.MLBB.at = Date.now() + 1;
  chk('and rebuilt when the card reloads', ctx.mlbxRows() !== rows);
}
{
  const ctx = build();
  const r = ctx.mlbxRows()[0];
  has(JSON.stringify(r.p.model), 'fair_total', 'the projection carries a total');
  chk('the better club is projected to score more',
    r.p.model.away_runs > r.p.model.home_runs, r.p.model.away_runs + ' vs ' + r.p.model.home_runs);
  chk('the captured total is joined', r.mkt.total_line === 7.5);
  near('the gap is the model total minus the posted one',
    r.totalGap, r.p.model.fair_total - 7.5, 0.011);
  chk('the market’s own de-vigged fair number is used, not one invented here',
    Math.abs(r.p.market.consensus_fair_home - 0.415) < 1e-9);
  has(r.p.market.consensus_fair_source, 'capture', 'and it is attributed to the capture');
  chk('a bullpen flag reaches the projection',
    (r.p.components.home_bullpen_notes || []).some((n) => /flagged arm/.test(n)));
  chk('the movement on the home price is carried', r.move != null && r.move < 0);
}

/* =========================================================================
   2 — THE SNAPSHOT AND THE SIGNALS
   ========================================================================= */
{
  const ctx = build();
  const rows = ctx.mlbxRows();
  const s = ctx.mlbxSnapshot(rows);
  eq('every game is counted', s.games, 3);
  eq('only the priced game is counted as priced', s.priced, 1);
  eq('the game with no starter posted is counted', s.unknown, 1);

  const items = ctx.mlbxTodayItems(rows);
  chk('signals were computed', items.length > 0);
  const keys = items.map((i) => i.k);
  chk('the unposted starter is surfaced', keys.indexOf('Probable starter not posted') >= 0, keys.join(' | '));
  chk('the wind-driven run environment is surfaced',
    keys.indexOf('Weather moves the run environment') >= 0, keys.join(' | '));
  chk('every signal carries why it matters', items.every((i) => i.why && i.why.length > 40));
  chk('every signal points at a real row', items.every((i) => i.r && i.r.key != null));
  const card = ctx.rsTkSig(ctx.mlbxSigItem(items[0]));
  has(card, 'Open research', 'a signal offers a way into the research');
  has(card, 'mlbxSigOpen', 'and it opens the game it is about');
}

/* =========================================================================
   3 — A DISAGREEMENT IS NEVER AN EDGE
   ========================================================================= */
{
  const ctx = build();
  const status = ctx.mlbxModelStatusHTML();
  has(status, 'Experimental', 'the model is badged experimental');
  has(status, 'Not walk-forward trained', 'and states it is not trained');
  has(status, 'No closing-line record', 'and that it has no record');
  has(status, 'never a play', 'and that a disagreement is not a play');
  lacks(status, 'Validated', 'nothing here claims validation');

  const method = ctx.mlbxDrawerHTML('method');
  has(method, 'negative binomial', 'the methodology names the distribution');
  has(method, 'conference', 'and explains the college schedule adjustment');
  has(method, 'will not fill a missing input', 'and what it refuses to do');
  const record = ctx.mlbxDrawerHTML('record');
  has(record, 'There is no track record', 'the record drawer says there is none');
  has(record, 'None of that is validation', 'and that self-consistency is not validation');
  has(record, 'a limitation', 'and it carries the published limitations');

  /* the guard bound, driven through the real engine */
  const g = build();
  g.EDGES = [{ sport_key: 'baseball_mlb', event_id: 'x', away_team: 'New York Yankees', home_team: 'New York Mets',
    market: 'totals', selection: 'Over', point: 2.5, best_dec: 1.9, n_books: 5,
    last_seen_at: new Date().toISOString() }];
  g.MLBB.at = Date.now() + 2;
  const fr = g.mlbxRows()[0];
  chk('an impossible gap is a data fault, not a disagreement', fr.fault && !fr.lean);
  const fitems = g.mlbxTodayItems(g.mlbxRows());
  chk('and it is surfaced as a data-quality warning',
    fitems.some((i) => i.k === 'Data-quality warning' && i.pri === 'neg'));
  has(g.mlbhGamesHTML(), 'data fault', 'and the board row is chipped as one');
}

/* =========================================================================
   4 — NOTHING IS INVENTED
   ========================================================================= */
{
  const ctx = build({ noModel: true });
  const rows = ctx.mlbxRows();
  chk('with no engine there is no projection', rows.every((r) => !r.ok));
  has(ctx.mlbhGamesHTML(), 'The run model did not load', 'and the board says so');
  has(ctx.mlbxOverviewHTML(), 'did not load', 'and so does the overview');
  lacks(ctx.mlbxOverviewHTML(), 'class="v mdl"', 'and no number is shown in its place');
}
{
  const ctx = build({ noMarket: true });
  const rows = ctx.mlbxRows();
  chk('with no price there is no comparison', rows.every((r) => r.totalGap == null && r.mlGapPts == null));
  chk('but the projection still stands', rows.every((r) => r.ok));
  has(ctx.mlbhGamesHTML(), 'no price', 'and the row says the price is missing');
  const items = ctx.mlbxTodayItems(rows);
  chk('a disagreement is never claimed without a market',
    !items.some((i) => /disagreement/i.test(i.k)));
}
{
  const ctx = build({ noRates: true });
  const rows = ctx.mlbxRows();
  chk('a club with no season rate still projects', rows.every((r) => r.ok));
  chk('and the substitution is disclosed',
    rows[0].warn.some((w) => /no season run rate/.test(w)), JSON.stringify(rows[0].warn));
  has(ctx.mlbhGamesHTML(), 'fallback baseline', 'and the board names the fallback baseline');
}
{
  const ctx = build({ noCard: true });
  const eb = ctx.mlbhGamesHTML();
  has(eb, 'No MLB games on the card', 'an empty card says so');
  has(eb, 'correct answer rather than an error', 'and an empty card is not called an error');
  /* NEVER LOADED AND LOADED-AND-EMPTY MUST NOT LOOK ALIKE. */
  const waiting = build({ neverLoaded: true, noCard: true });
  has(waiting.mlbhGamesHTML(), 'Loading the MLB card', 'a load that has not answered says it is loading');
  has(waiting.mlbxOverviewHTML(), 'fb-skel', 'and the overview shows a skeleton rather than an empty desk');
}

/* =========================================================================
   5 — THE ARCHIVE IS NOT THE PANEL
   ========================================================================= */
{
  const ctx = build({ noArchive: true });
  const board = ctx.mlbhGamesHTML();
  has(board, 'New York Yankees', 'a card without the archive still lists every game');
  chk('and still projects every one of them', ctx.mlbxRows().every((r) => r.ok));
  const ov = ctx.mlbxOverviewHTML();
  has(ov, 'Today in baseball', 'and the overview still draws');
  lacks(ov, 'Loading', 'and it is not stuck loading');
  const sys = ctx.mlbxSystemHTML();
  has(sys, 'not_installed', 'system health reports the archive as not installed');
  has(sys, 'run model', 'and reports whether the run model loaded');
  /* the page-level wiring that used to strand the card */
  has(APP, 'try{ await mlbhLoadSeg(force); }catch(_){}',
    'a failed archive status still loads the segment');
  has(APP, 'THE ARCHIVE IS NOT THE PANEL',
    'and the reason is written where the next reader will find it');
}

/* =========================================================================
   6 — FILTERS AND ORDERING
   ========================================================================= */
{
  const ctx = build();
  has(ctx.mlbhGamesHTML(), 'Every game', 'the board offers an unfiltered view');
  has(ctx.mlbhGamesHTML(), 'With a price', 'and a priced-only view');
  has(ctx.mlbhGamesHTML(), 'Starter unposted', 'and an unposted-starter view');
  ctx.mlbxSetFilter('priced');
  eq('the priced filter reduces the board', ctx.mlbxRowFilter(ctx.mlbxRows()).length, 1);
  ctx.mlbxSetFilter('unknown');
  eq('the unposted-starter filter reduces the board', ctx.mlbxRowFilter(ctx.mlbxRows()).length, 1);
  ctx.mlbxSetFilter('lean');
  const lean = ctx.mlbxRowFilter(ctx.mlbxRows());
  chk('a filter that matches nothing offers a way back',
    lean.length > 0 || ctx.mlbhGamesHTML().indexOf('Show every game') >= 0);
  ctx.mlbxSetFilter('all');
  ctx.mlbxSetSort('time');
  const byTime = ctx.mlbxRowSort(ctx.mlbxRows());
  chk('ordering by first pitch is chronological',
    byTime[0].t <= byTime[1].t && byTime[1].t <= byTime[2].t);
  ctx.mlbxSetSort('total');
  const byGap = ctx.mlbxRowSort(ctx.mlbxRows());
  chk('ordering by total gap puts the disagreement first', byGap[0].totalGap != null);
  /* a reordered board is still navigable: the day has to ride the row once it
     is no longer the heading above it */
  has(ctx.mlbhGamesHTML(), 'Today \u00b7', 'a reordered board keeps the day on the row');
  ctx.mlbxSetSort('time');
  has(ctx.mlbhGamesHTML(), '>Today<', 'and a chronological board groups under it');
}

/* =========================================================================
   10 — A MISSING STAMP NEVER READS AS FRESH
   ========================================================================= */
{
  const ctx = build();
  ctx.MLBB.at = null;
  const items = ctx.mlbxTodayItems(ctx.mlbxRows());
  const foot = ctx.mlbxSigItem(items[0]).foot;
  has(foot, 'load time not recorded', 'an unrecorded load says so rather than reading as this instant');
  chk('a missing load stamp is never rendered as an age', foot.indexOf('0s ago') < 0);
  lacks(ctx.mlbxOverviewHTML(), '0s ago', 'and the overview heading does not either');
}

/* =========================================================================
   7 — THE FINDER
   ========================================================================= */
{
  const ctx = build();
  const all = ctx.mlbxFinderHTML(ctx.mlbxRows(), '');
  has(all, 'Search team or matchup', 'the finder invites a search');
  has(all, 'New York', 'and lists games');
  const one = ctx.mlbxFinderHTML(ctx.mlbxRows(), 'cubs');
  has(one, 'Chicago Cubs', 'a search reaches its game');
  lacks(one, 'Boston Red Sox', 'and excludes the others');
  has(one, 'proj', 'and the row carries the projection so the list itself answers the question');
  const none = ctx.mlbxFinderHTML(ctx.mlbxRows(), 'zzzz');
  has(none, 'No game on either card matches', 'and an empty search says so');
}

/* =========================================================================
   8 — COLLEGE: A CLUB-LEVEL NUMBER, AND IT SAYS SO
   ========================================================================= */
{
  const CONF = { name: 'SEC', clubs: 14, games: 700, nonconference_games: 260, run_diff: 320,
    runs_per_nonconf_game: 1.23, sufficient: true };
  const tbl = { ok: true, season: 2026,
    league: { clubs: 300, games: 15000, runs_per_game: 6.7, runs_allowed_per_game: 6.7 },
    by_id: {
      't1': { team_id: 't1', games: 48, runs_per_game: 8.1, runs_allowed_per_game: 5.2, conference_name: 'SEC' },
      't2': { team_id: 't2', games: 46, runs_per_game: 5.9, runs_allowed_per_game: 7.4, conference_name: 'Big Ten' }
    },
    conferences: { SEC: CONF, 'Big Ten': { name: 'Big Ten', nonconference_games: 240, runs_per_nonconf_game: -0.1, sufficient: true } } };
  const board = { ok: true, in_season: true, from: TODAY, through: TOMORROW,
    counts: { total: 2, final: 1, live: 0, scheduled: 1, abandoned: 0 },
    games: [
      { game_id: 'c1', season: 2026, date: TODAY, start_time: TODAY + 'T22:00:00Z', completed: false, abandoned: false,
        state: 'pre', neutral_site: false, conference_game: false, venue: 'A Park', seen_by: ['scoreboard', 'schedules'],
        away: { team_id: 't2', name: 'Indiana', score: null, rank: null }, home: { team_id: 't1', name: 'LSU', score: null, rank: 2 } },
      { game_id: 'c2', season: 2026, date: TODAY, start_time: TODAY + 'T18:00:00Z', completed: true, abandoned: false,
        state: 'post', neutral_site: false, conference_game: true, venue: 'B Park', seen_by: ['scoreboard'],
        away: { team_id: 't2', name: 'Purdue', score: 3 }, home: { team_id: 't1', name: 'Ohio State', score: 7 } }
    ] };
  const ctx = build({ cbb: { at: Date.now(), board: board, seasonTable: tbl, seasonTableErr: null,
    projRows: null, projRowsAt: null, err: null, errCode: null } });
  const rows = ctx.cbbxRows();
  eq('only the game still to be played is projected', rows.length, 1);
  chk('and it projected', rows[0].ok);
  chk('the stronger club is favoured',
    rows[0].p.model.home_win_prob > 0.6, String(rows[0].p.model.home_win_prob));
  chk('the conference adjustment is written out',
    /non-conference game/.test(rows[0].p.components.home_conference_note || ''));
  chk('every college projection names the missing starter',
    rows[0].warn.some((w) => /No probable starting pitcher exists/.test(w)));
  chk('no college game claims a market', rows.every((r) => !r.priced));
  const nums = ctx.cbbxNumHTML(rows[0]);
  has(nums, 'Proj total', 'the college row carries a projected total');
  has(nums, 'Home win', 'and a win probability');
  /* both cards are one desk */
  const all = ctx.mlbxAllRows();
  eq('the overview spans both cards', all.length, 4);
  const snap = ctx.mlbxSnapshot(all);
  eq('and counts each league', snap.mlb + snap.cbb, 4);
  eq('college games are tagged as college', ctx.mlbxTag(rows[0]), 'NCAA');
}

/* =========================================================================
   9 — THE PAGE WIRING
   ========================================================================= */
has(APP, 'id="mlbOverview"', 'the panel mounts the overview');
has(APP, 'id="mlbSystem"', 'and the system card');
has(APP, 'try{ mlbxRenderOverview(); }catch(_){}', 'and renderBaseball paints them');
has(APP, '/mlb/params.js', 'the page loads the published constants');
has(APP, '/mlb/engine.js', 'and the engine');
has(APP, "onclick=\"mlbxRefreshClick()\"", 'the refresh button reloads the whole panel');
chk('the shell search can reach a game', APP.indexOf("id:'g:'+r.sport+':'+r.key") >= 0);
chk('the module reports data when either card answered',
  APP.indexOf('||(window.CBB&&CBB.board&&CBB.board.games&&CBB.board.games.length));}') >= 0);
has(APP, 'baseball.run_model_v1', 'the model is declared in the provenance block');
has(APP, 'has never been graded against a closing line',
  'and the limitations say it has never been graded');

failures.forEach((f) => console.log('  ✗ ' + f));
console.log((fail === 0 ? '\nbaseball research terminal: ' : '\nFAIL | baseball research terminal: ')
  + pass + ' passed, ' + fail + ' failed');
if (fail === 0) console.log('PASS | baseball research terminal | ' + pass + ' assertions');
process.exit(fail === 0 ? 0 : 1);
