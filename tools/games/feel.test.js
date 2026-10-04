#!/usr/bin/env node
/* ===========================================================================
   GAME FEEL — the suite.

   Not "does it work" but "does every important action have a payoff, and
   is the first visit a question rather than a product". What it holds down:

     1  the read (SC.classify) is descriptive, deterministic and versioned
     2  rivalries come from the ledger only, and a loss is a settled row
        that was neither a win nor a draw
     3  the premium moment is due only after real research use this week,
        once, and "keep playing free" is a real choice
     4  Price It: the question first, the lean visible, the lock is a beat,
        the reveal is staggered, the read is shown, the snapshot is the free
        research, and a first-timer is not handed the product
     5  Head-to-Head: the invite landing leads with the person, both picks
        are a moment, a result has a series and a one-tap rematch
     6  Pick 5: progress while picking, a locked moment, a running line as
        games settle, a final grade that is a description
     7  the game-quality events are declared and fired
     8  loading states are labelled; nothing shows a blank

   Run: node tools/games/feel.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function before(hay, a, b, name) { chk(name, hay.indexOf(a) >= 0 && hay.indexOf(b) >= 0 && hay.indexOf(a) < hay.indexOf(b), a + ' must come before ' + b); }

const ROOT = path.join(__dirname, '..', '..');
const G = f => path.join(ROOT, 'games', f);

let MEM = {};
global.localStorage = {
  getItem: k => (MEM[k] == null ? null : MEM[k]),
  setItem: (k, v) => { MEM[k] = String(v); },
  removeItem: k => { delete MEM[k]; }
};
global.document = { cookie: '' };
global.location = { search: '', pathname: '/games/' };
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const W = require(G('lib/week.js'));
const SC = require(G('lib/scoring.js'));
require(G('lib/challenge.js'));
require(G('lib/research_state.js'));
require(G('lib/attribution.js'));
const ST = require(G('lib/store.js'));
const DY = require(G('lib/dynasty.js'));
const T0 = Date.parse('2026-09-04T18:00:00Z');
function fresh() { MEM = {}; ST.reset(); }

/* ═══ 1. THE READ ═════════════════════════════════════════════════════════ */
eq('within a field goal of the market is near', SC.classify(-6.5, -6.5, -9.7).key, 'near');
eq('1.5 away is still near', SC.classify(-8, -6.5, -9.7).key, 'near');
eq('more points to the favourite is an aggressive favourite', SC.classify(-10.5, -6.5, -9.7).key, 'aggressive');
eq('fewer points to the favourite is underdog-friendly', SC.classify(-3, -6.5, -9.7).key, 'dog');
eq('seven or more away is way off consensus', SC.classify(-14, -6.5, -9.7).key, 'far');
eq('flipping the favourite by a lot is way off consensus', SC.classify(3, -6.5, null).key, 'far');
eq('with no market the read is against EdgeDesk', SC.classify(-4, null, -9.7).against, 'EdgeDesk');
eq('and says so', SC.classify(-4, null, -9.7).key, 'dog');
eq('an away favourite reads the same way', SC.classify(9, 6.5, null).key, 'aggressive');
eq('with neither reference there is no read', SC.classify(-4, null, null), null);
eq('the read is versioned', SC.classify(-4, -6.5, null).version, 'classify_v1');
chk('the read never grades the player', ['near', 'aggressive', 'dog', 'far'].every(k => {
  const c = [[-6.5, -6.5], [-10.5, -6.5], [-3, -6.5], [-14, -6.5]].map(p => SC.classify(p[0], p[1], null)).filter(c => c.key === k)[0];
  return c && !/wrong|bad|good|correct|mistake/i.test(c.label + ' ' + c.means);
}));
chk('the read is deterministic', JSON.stringify(SC.classify(-10.5, -6.5, -9.7)) === JSON.stringify(SC.classify(-10.5, -6.5, -9.7)));

/* ═══ 2. RIVALRIES ════════════════════════════════════════════════════════ */
fresh();
(() => {
  eq('no challenges, no rivalries', DY.rivalries(ST.read()).length, 0);
  ['a', 'b', 'c', 'd', 'e'].forEach((k, i) => ST.recordEvent('h2h_locked', k, { opponent: 'Davis' }, T0 + i * 1000));
  ST.recordEvent('h2h_settled', 'a', null, T0); ST.recordEvent('h2h_win', 'a', null, T0);
  ST.recordEvent('h2h_settled', 'b', null, T0);                                   /* a loss */
  ST.recordEvent('h2h_settled', 'c', null, T0); ST.recordEvent('h2h_win', 'c', null, T0);
  ST.recordEvent('h2h_settled', 'd', null, T0); ST.recordEvent('h2h_win', 'd', null, T0);
  ST.recordEvent('h2h_locked', 'z', { opponent: 'Kim' }, T0);
  const r = DY.rivalry(ST.read(), 'Davis');
  eq('five played against Davis', r.played, 5);
  eq('four settled', r.settled, 4);
  eq('three won', r.wins, 3);
  eq('a settled challenge that was neither a win nor a draw is a loss', r.losses, 1);
  eq('the record reads as wins–losses', r.record, '3–1');
  eq('the current streak is two wins running', r.streak, 2);
  eq('an unsettled challenge is not a result', r.results.length, 4);
  eq('Kim is a rivalry with nothing settled', DY.rivalry(ST.read(), 'Kim').settled, 0);
  eq('rivalries sort by games played', DY.rivalries(ST.read())[0].opponent, 'Davis');
  ST.recordEvent('h2h_settled', 'e', null, T0 + 9000); ST.recordEvent('h2h_draw', 'e', null, T0 + 9000);
  const r2 = DY.rivalry(ST.read(), 'Davis');
  eq('a draw is counted', r2.draws, 1);
  eq('and shown in the record', r2.record, '3–1–1');
  eq('and it ends a streak', r2.streak, 0);
  eq('an unknown opponent is nothing', DY.rivalry(ST.read(), 'Nobody'), null);
  ST.recordEvent('h2h_locked', 'a', { opponent: 'Davis' }, T0 + 99);
  eq('re-recording a challenge changes nothing', DY.rivalry(ST.read(), 'Davis').played, 5);
})();

/* ═══ 3. THE PREMIUM MOMENT ═══════════════════════════════════════════════ */
const JS = fs.readFileSync(G('games.js'), 'utf8');
chk('the premium moment waits for real research use', /PRO_AFTER_OPENS = 3/.test(JS));
chk('it counts research opens THIS football week', /o\.week === wk/.test(JS.slice(JS.indexOf('function proDue'))));
chk('it is shown once a week and dismissing it is remembered', /pro_moment:' \+ wk/.test(JS) && /markSeen\('pro_moment:'/.test(JS));
chk('"keep playing free" is a real button', /Keep playing free/.test(JS) && /data-pro-free/.test(JS));
chk('and it never blocks the game', /The games never need it/.test(JS));
chk('it links to the pricing page with the campaign carried', /withAttribution\(PRICING/.test(JS));
chk('and it is measured as a view AFTER research', /premium_view_after_research/.test(JS) && /keep_playing_free/.test(JS));
chk('the pitch is the research, not a better score', /Pro is the research, not a better score/.test(JS));

/* ═══ 4. PRICE IT ═════════════════════════════════════════════════════════ */
const PRICE = fs.readFileSync(G('price-it/index.html'), 'utf8');
const CSS = fs.readFileSync(G('games.css'), 'utf8');
has(PRICE, 'Think you know the line?', 'a first-timer is asked the question');
chk('and the week label is for regulars only', /first\?'Think you know the line\?':'Price It'/.test(PRICE));
has(PRICE, 'class="lean"', 'the lean is visible while the price is set');
chk('the lean fills toward the favoured side', /leanFill/.test(PRICE) && /\.lean \.fill/.test(CSS));
has(PRICE, 'Reset to pick ’em', 'there is a clean reset');
chk('the number reacts to every change', /classList\.add\('bump'\)/.test(PRICE) && /\.sel-line\.bump/.test(CSS));
has(PRICE, 'Your line is in', 'the lock is a beat');
before(PRICE, 'Your line is in', 'renderReveal(ch,stored,true)', 'and it comes before the reveal');
chk('the beat waits, unless motion is reduced', /prefers-reduced-motion: reduce/.test(PRICE) && /still\?0:900/.test(PRICE));
chk('the reveal is staggered: your price, then the market, then EdgeDesk',
  /\.reveal \.price:nth-child\(1\)\{animation-delay:\.05s\}/.test(CSS) && /\.reveal \.price:nth-child\(3\)\{animation-delay:\.65s\}/.test(CSS));
chk('and the stagger is off under reduced motion', /prefers-reduced-motion:reduce\)\{\s*\.reveal \.price/.test(CSS));
has(PRICE, 'SC.classify', 'the reveal shows the read');
chk('the read chip is neutral: near and far are tinted, the leans are not',
  /\.cls \.chip\.near/.test(CSS) && /\.cls \.chip\.far/.test(CSS) && !/\.cls \.chip\.aggressive\{/.test(CSS));
has(PRICE, 'EdgeDesk snapshot', 'the free research teaser is on the reveal');
['Model', 'Market', 'EdgeDesk research state', 'Key driver'].forEach(k => has(PRICE, k, 'the snapshot shows ' + k));
has(PRICE, 'How the rosters compare', 'and how the rosters compare');
chk('the snapshot compares only where the numbers differ', /Math\.abs\(a-h\)<5\)return/.test(PRICE));
has(PRICE, 'Research this matchup', 'the door to the full research is on the snapshot');
before(PRICE, 'EdgeDesk snapshot', 'Play next matchup', 'and it comes before the next-game button');
has(PRICE, 'Why EdgeDesk prices it here', 'the rest of the why is still there');
chk('but folded when there is more than one factor', /<details/.test(PRICE) && /factors\.length>1/.test(PRICE));
has(PRICE, 'You just created your first EdgeDesk game result', 'the first result says so');
chk('the first result explains the score in one line', /within a point keeps all 100/.test(PRICE));
chk('a first-timer is not handed the mission list', /gamesPlayed\(\)>=\(DY\.CREATE_AT\|\|2\)/.test(PRICE));
chk('the premium moment can appear after the reveal, through the shared rule', /G\.proMoment\('price_it_after'\)/.test(PRICE) && /wireProMoment/.test(PRICE));
has(PRICE, 'Loading matchup', 'the loading state is labelled');
has(PRICE, 'first_game_start', 'the first game start is measured');
has(PRICE, 'time_to_first_action', 'and how long it took to get there');
chk('the share is short and ends with the question', /How would you price it\?/.test(JS) && !/Score: /.test(JS.slice(JS.indexOf('function shareText'), JS.indexOf('function shareUrl'))));

/* ═══ 5. HEAD-TO-HEAD ═════════════════════════════════════════════════════ */
const H2H = fs.readFileSync(G('h2h/index.html'), 'utf8');
has(H2H, 'challenged you', 'the invite landing leads with the person');
chk('the name is the headline', /<h1[^>]*>'\s*\+esc\([^)]*display_name[^)]*\)\s*\+' challenged you/.test(H2H.replace(/\s+/g, ' ')) || /challenged you<\/h1>/.test(H2H));
before(H2H, 'challenged you', 'Lock my pick', 'and the pick comes right after');
has(H2H, 'Picks are in', 'both picks are a moment');
has(H2H, 'Run it back', 'a result offers a one-tap rematch');
has(H2H, 'Series vs', 'and a series record');
has(H2H, 'DY.rivalry', 'from the rivalry rule, not a page count');
has(H2H, "recordEvent('h2h_settled'", 'a settled challenge is on the record');
has(H2H, "recordEvent('h2h_draw'", 'and a draw');
chk('a rematch is measured', /track\('rematch'/.test(H2H) && /track\('h2h_rematch'/.test(H2H));
chk('a loss is never framed as being shown up', !/should have|you were wrong|you lost because/i.test(H2H));
has(H2H, 'EdgeDesk gets games wrong too', 'and the research CTA stays honest');
has(H2H, 'Loading challenge', 'the loading state is labelled');
chk('the invite share stays, and the result share names the series',
  /Think you can beat me\?/.test(H2H) && /Series: /.test(H2H));

/* ═══ 6. PICK 5 ═══════════════════════════════════════════════════════════ */
const PICK = fs.readFileSync(G('pick-5/index.html'), 'utf8');
chk('progress reads as picked, not selected', /\/ '\+GAMES\.length\+' picked|' \/ '\+GAMES\.length\+' picked|picked/.test(PICK) && !/of 5 selected/.test(PICK));
has(PICK, 'Lock my card', 'the submit is a lock');
has(PICK, 'Your week is locked', 'submitting is a moment');
has(PICK, 'remaining', 'the running line counts what is left');
has(PICK, 'Perfect card', 'a perfect card is named');
chk('the final grades describe, never grade the person', !/you should|you were wrong/i.test(PICK) && /Rough week/.test(PICK));
has(PICK, 'Share my card', 'the card can be shared');
has(PICK, "Loading this week", 'the loading state is labelled');
chk('the final score is shown from the artifact, away first', /away_score/.test(PICK) && /home_score/.test(PICK));

/* ═══ 7. EVENTS ═══════════════════════════════════════════════════════════ */
['first_game_start', 'time_to_first_action', 'rematch', 'premium_view_after_research', 'keep_playing_free',
 'challenge_created', 'challenge_accepted'].forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));

/* ═══ 8. NO BLANKS ════════════════════════════════════════════════════════ */
const HOME = fs.readFileSync(G('index.html'), 'utf8');
has(HOME, 'Loading matchup', 'the home hero says what it is waiting for');
chk('the skeleton label exists in the shell', /\.sk-label\{/.test(CSS));

console.log((fail ? 'FAIL' : 'PASS') + ' | game feel | ' + pass + ' passed, ' + fail + ' failed');
failures.forEach(f => console.log('  × ' + f));
process.exit(fail ? 1 : 0);
