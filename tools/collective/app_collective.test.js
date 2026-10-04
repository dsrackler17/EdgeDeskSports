#!/usr/bin/env node
/* ===========================================================================
   Tests for the Collective tab in app.html, which renders the Collective
   ITSELF now rather than injecting collective/embed.js.

   WHY IT MOVED. The embed asks collective_embed for one bootstrap payload
   carrying the wall, the creators and the board together. One endpoint, one
   point of failure — and it failed in all three ways available to it: it
   answered 500 and the tab read "temporarily unreachable"; before that it
   showed one sport, because that payload asks for meta.sports[0] and stops;
   and every row was locked for everyone, because its entitled flag was a
   literal. Nothing on this side could do anything about any of it.

   Every piece of that payload has its own endpoint on collective_public —
   /v1/meta, /v1/wall, /v1/games?sport=&season= — which is the API the
   Collective's own site has always used, one sport at a time and with the
   reader's token. So the tab asks those directly, and what these hold is the
   properties that buys:

     - every sport reaches the board, capped PER SPORT so an NFL Sunday
       cannot fill a shared limit and push college off it again;
     - one section failing is one section missing, never the screen;
     - a locked row is explained by which of four things happened, because
       "Subscriber number" on every row invites the wrong guess.

   Run: node tools/collective/app_collective.test.js
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

/* ---- the renderer, cut out of the page that ships it ------------------- */
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
const A = APP.indexOf('/* State first, and NOTHING above it that can throw.');
const B = APP.indexOf('function mcSetStatus(', A);
if (A < 0 || B < 0) {
  console.log('FAIL | app.html no longer carries the Collective renderer between its markers');
  process.exit(1);
}
global.window = global;
global.document = { getElementById: () => null, createElement: () => ({ style: {} }),
                    head: { appendChild() {} } };

/* SB_URL IS DELIBERATELY NOT DEFINED YET.
   This block lives in a different <script> from the one that declares it, and
   separate blocks execute in order — so at the moment this code runs, SB_URL
   does not exist. Reading it at parse time threw a ReferenceError, which
   skipped every top-level `var` after it (MC among them) while leaving the
   hoisted function declarations in place. loadCollective() then wrote
   "Loading the Collective…", mcLoad() threw on MC.ran, its own catch touched
   MC and threw again, and the tab sat on that word forever.
   Defining SB_URL before this line would hide exactly that bug. */
let blockThrew = null;
try { vm.runInThisContext(APP.slice(A, B), { filename: 'app.html [collective]' }); }
catch (e) { blockThrew = String((e && e.message) || e); }
chk('the block runs before SB_URL exists, as it really does', blockThrew === null,
  { threw: blockThrew });
chk('so its state object is actually built',
  global.MC && typeof global.MC === 'object', { got: typeof global.MC });
chk('and the API base is resolved per request, not at parse time',
  typeof global.mcApi === 'function');

/* Now block 3 has run, as it will have by the time anyone opens the tab. */
global.SB_URL = 'https://db.test';
global.SB_KEY = 'anon-key';
global.edSession = () => null;
global.edToken = async () => 'anon-key';
chk('and it resolves once SB_URL is there', global.mcApi() === 'https://db.test/functions/v1');

const KICK = t => new Date(Date.now() + t * 3600e3).toISOString();
const PAST = t => new Date(Date.now() - t * 3600e3).toISOString();
const game = (o) => Object.assign({
  game_id: 'g', label: 'A @ B', home: 'B', away: 'A', kickoff_at: KICK(48),
  status: 'scheduled', result: null, consensus: null, models: []
}, o);
function reset(o) {
  Object.assign(global.MC, { sports: [], wall: [], boards: [], mkt: null,
    entitled: false, identified: false, ran: true, failed: {} }, o || {});
}

/* ---- formatters -------------------------------------------------------- */
chk('a missing number is a dash, not zero', global.mcNum(null) === '—' && global.mcNum(undefined) === '—');
chk('and so is a non-number', global.mcNum('lots') === '—' && global.mcSpr(NaN) === '—');
chk('a spread carries its sign', global.mcSpr(3) === '+3.0' && global.mcSpr(-3.5) === '-3.5');
/* A pick'em renders as 0.0 with no sign, which is how the Collective's own
   pages render it. What matters is that it is a number and not a dash: zero
   is a real spread and must never read as "no line". */
chk('a pick\'em is a number, not a blank', global.mcSpr(0) === '0.0', { got: global.mcSpr(0) });
chk('a probability renders as a percentage', global.mcPct(0.712, 0) === '71%');
chk('a missing probability does not become 0%', global.mcPct(null) === '—');
chk('markup in a name cannot become markup',
  global.mcEsc('<img onerror=x>') === '&lt;img onerror=x&gt;');
chk('quotes are escaped too, since these land in attributes',
  global.mcEsc('a"b') === 'a&quot;b');

/* ---- the wall ---------------------------------------------------------- */
reset({ wall: [
  { creator_name: 'EdgedeskSports', model_name: 'Power 4', sport: 'CFB', founding: true,
    membership: 'ACTIVE CONTRIBUTOR', record: null, coverage_pct: 83 },
  { creator_name: 'MustBeMoose', model_name: 'Moose Metrics', sport: 'NFL', founding: true,
    membership: 'MEMBER',
    record: { graded: 20, wins: 12, losses: 7, pushes: 1, win_pct: 0.632, margin_mae: 9.4, brier: 0.213 },
    coverage_pct: 100 }
] });
let wall = global.mcWallHTML();
chk('every model on the wall is rendered, not just the first',
  /EdgedeskSports/.test(wall) && /MustBeMoose/.test(wall));
chk('a model with no graded games reads pending, not 0-0-0',
  /pending/.test(wall) && !/>0-0-0</.test(wall));
chk('a graded model shows its record and rates',
  /12-7-1/.test(wall) && /63\.2%/.test(wall) && /0\.213/.test(wall), { wall });
chk('founding status is marked', /Founding/.test(wall));
chk('the count in the heading is the number of models',
  /2 models/.test(wall), { wall });

reset({ failed: { wall: true } });
chk('a wall that will not load says so and does not take the page with it',
  /did not load/.test(global.mcWallHTML()));

/* ---- a game row -------------------------------------------------------- */
const locked = game({ consensus: { locked: true, n: 3 },
  models: [{ creator_slug: 'mustbemoose', locked: true }] });
let html = global.mcGameHTML(locked);
chk('a locked row shows no numbers at all',
  /Subscriber number/.test(html) && !/[+-]\d+\.\d/.test(html), { html });
chk('and a locked consensus says which it is',
  /Consensus is a subscriber number/.test(html));

const open = game({ sport: 'CFB', label: 'Massachusetts @ Rutgers', home: 'Rutgers', away: 'Massachusetts',
  consensus: { locked: false, n: 3, spread_mean: -5.1, total_mean: 45, home_win_prob_mean: 0.68 },
  models: [{ creator_slug: 'edgedesksports', locked: false, pick_side: 'home',
             projected_spread: -46.32, projected_total: 53.2, home_win_probability: 0.998 }] });
html = global.mcGameHTML(open);
chk('an unlocked row shows the model\'s own numbers',
  /-46\.3/.test(html) && /O\/U 53\.2/.test(html), { html });
chk('a home pick names the home team, not the word "home"',
  /<b>Rutgers<\/b>/.test(html) && !/>home</.test(html), { html });
chk('the consensus comes through', /consensus/.test(html) && /-5\.1/.test(html));
chk('the row names its sport, because the board carries more than one',
  /CFB/.test(html), { html });
chk('a game nobody has posted says so rather than rendering empty',
  /No model has posted/.test(global.mcGameHTML(game({}))));

/* ---- the board: every sport, capped per sport -------------------------- */
const nfl = { sport: 'NFL', entitled: false,
  games: Array.from({ length: 16 }, (_, i) => game({ game_id: 'n' + i, sport: 'NFL',
    kickoff_at: KICK(24 + i), label: 'A' + i + ' @ B' + i })) };
const cfb = { sport: 'CFB', entitled: false,
  games: [game({ game_id: 'c1', sport: 'CFB', kickoff_at: KICK(30), label: 'UMass @ Rutgers' })] };
reset({ boards: [nfl, cfb] });
let board = global.mcBoardHTML();
chk('an NFL Sunday does not push college off the board',
  /UMass @ Rutgers/.test(board), { has: /UMass/.test(board) });
chk('and the NFL games are all still there', (board.match(/mc-g"/g) || []).length >= 17);
chk('the heading counts what is actually shown', /Upcoming · 17 games/.test(board), { board: board.slice(0, 200) });

reset({ boards: [{ sport: 'NFL', games: [
  game({ game_id: 'late', kickoff_at: KICK(72), label: 'LATE @ X' }),
  game({ game_id: 'soon', kickoff_at: KICK(2), label: 'SOON @ X' })] }] });
board = global.mcBoardHTML();
chk('upcoming games are in kickoff order',
  board.indexOf('SOON @ X') < board.indexOf('LATE @ X'), { board: board.slice(0, 400) });

reset({ boards: [{ sport: 'NFL', games: [
  game({ game_id: 'f', kickoff_at: PAST(48), status: 'final',
         result: { home_score: 24, away_score: 20 } }),
  game({ game_id: 'u', kickoff_at: KICK(24) })] }] });
board = global.mcBoardHTML();
chk('a settled game is filed under the public record, not upcoming',
  board.indexOf('Upcoming') < board.indexOf('Settled, the public record'), { board: board.slice(0, 300) });
chk('and shows its score', /24/.test(board) && /20/.test(board));

reset({ boards: [nfl], failed: { CFB: true } });
board = global.mcBoardHTML();
chk('one sport failing is one sport missing, and it is named',
  /No slate loaded for CFB/.test(board), { board: board.slice(0, 300) });
chk('while the sport that did load is still on screen', /mc-g"/.test(board));

reset({ boards: [] });
chk('no games at all says so rather than rendering nothing',
  /No games on the slate/.test(global.mcBoardHTML()));

/* A load that never settles is the failure this screen keeps having, so it
   is a state with its own words and a way out, not a word left on screen. */
reset({ boards: [], failed: { timeout: true } });
let timedOut = global.mcBoardHTML();
chk('a load that timed out says so, and points at Refresh',
  /did not answer in time/.test(timedOut) && /Refresh/.test(timedOut), { timedOut });
chk('and offers the Collective directly as the other way through',
  /open it directly/.test(timedOut));
reset({ boards: [], failed: { timeout: true }, identified: true });
chk('a timeout is not reported as a verdict on entitlement',
  /nothing above is a verdict on your access/.test(global.mcWhyHTML())
  && !/not entitled/i.test(global.mcWhyHTML()), { why: global.mcWhyHTML() });

/* ---- why a locked board is locked -------------------------------------- */
reset({ boards: [nfl], entitled: true, identified: true });
chk('an open board explains nothing, because there is nothing to explain',
  global.mcWhyHTML() === '');

reset({ boards: [], identified: true });
chk('nothing answering is an outage, not a lock',
  /outage, not a lock/.test(global.mcWhyHTML()));

reset({ boards: [nfl], identified: false });
let why = global.mcWhyHTML();
chk('a signed-out reader is told to sign in', /signed out/i.test(why));
chk('and is NOT told they failed to pay', !/not entitled/i.test(why), { why });

reset({ boards: [nfl], identified: true });
why = global.mcWhyHTML();
chk('a signed-in reader without entitlement is told exactly that',
  /not entitled/i.test(why), { why });
chk('it never promises this page can unlock it',
  /Nothing on this page can change that/.test(why));
chk('and points at the confirming test', /open the full Collective/.test(why));

reset({ ran: false });
chk('nothing is claimed before anything has been asked',
  global.mcWhyHTML() === '' && global.mcBoardHTML() === '');

failures.forEach(f => console.log('FAIL | ' + f.name
  + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
