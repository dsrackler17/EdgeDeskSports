#!/usr/bin/env node
/* ===========================================================================
   THE TWO-MINUTE DRILL — the suite.

   What it holds down:

     1  every answer is canonical: a question is only asked when the artifact
        already carries its answer, and a coin-flip matchup is skipped
     2  a run is deterministic in (seed, board): everyone answers today's ten
        in the same order, and free play rotates by run number
     3  the first round is the easy one
     4  the scoring rule is the documented one, deterministic, versioned
     5  the daily run is recorded once and replayed; free play never touches
        the weekly score
     6  the page exists, is crawlable, retro without being a casino, mobile
        first, reduced-motion safe, and every miss funnels into the research

   Run: node tools/games/drill.test.js
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
require(G('lib/scoring.js'));
const CH = require(G('lib/challenge.js'));
require(G('lib/research_state.js'));
require(G('lib/attribution.js'));
const ST = require(G('lib/store.js'));
const DR = require(G('lib/drill.js'));

const NOW = Date.parse('2026-09-04T18:00:00Z');
function mk(o) {
  return Object.assign({ game_id: 'g', home_team: 'Home', away_team: 'Away', slug: 'away-home',
    kickoff: '2099-01-01 12:00', status: 'PREDICTED', edgedesk_spread: -7, market_spread: null,
    confidence: 50, research_state: 'NO_MARKET', context: null }, o);
}
const kind = id => DR.KINDS.filter(k => k.id === id)[0];

/* ═══ 1. EVERY ANSWER IS CANONICAL ════════════════════════════════════════ */
chk('the drill declares its kinds', DR.KINDS.length >= 5);
chk('every kind has an id, an applicability rule and a builder',
  DR.KINDS.every(k => k.id && typeof k.ok === 'function' && typeof k.build === 'function'));

/* who EdgeDesk favours: at least a field goal */
chk('a favourite of a field goal is askable', kind('favourite').ok(mk({ edgedesk_spread: -3 })));
chk('a favourite of 2.5 is a coin flip and is not', !kind('favourite').ok(mk({ edgedesk_spread: -2.5 })));
chk('no projection, no question', !kind('favourite').ok(mk({ edgedesk_spread: null })));
(() => {
  const q = kind('favourite').build(mk({ edgedesk_spread: -9.7, home_team: 'Auburn', away_team: 'Baylor' }));
  eq('the home favourite is the home option', q.options[q.answer], 'Auburn');
  has(q.why, 'Auburn −9.7', 'the reveal states the number the answer came from');
  const q2 = kind('favourite').build(mk({ edgedesk_spread: 4, home_team: 'Auburn', away_team: 'Baylor' }));
  eq('a positive home spread favours the away side', q2.options[q2.answer], 'Baylor');
})();

/* the football threshold */
eq('9.7 is asked against a touchdown', DR.thresholdFor(-9.7).pts, 7);
eq('6.5 is not asked against a touchdown (too close) — a field goal instead', DR.thresholdFor(-6.5).pts, 3);
eq('54.8 is asked against five touchdowns', DR.thresholdFor(-54.8).pts, 35);
chk('a spread inside 1.5 of every threshold is skipped', !kind('threshold').ok(mk({ edgedesk_spread: -1 })));
(() => {
  const q = kind('threshold').build(mk({ edgedesk_spread: -9.7, home_team: 'Auburn', away_team: 'Baylor' }));
  eq('9.7 is MORE than a touchdown', q.answer, 0);
  has(q.prompt, 'Auburn', 'the prompt names the favourite');
  has(q.prompt, 'touchdown', 'and the threshold in football words');
  const q2 = kind('threshold').build(mk({ edgedesk_spread: -5.5, home_team: 'Auburn', away_team: 'Baylor' }));
  eq('5.5 is LESS than a touchdown', q2.answer, 1);
  eq('and 5 sits between two thresholds — the nearer one with clearance is used', DR.thresholdFor(-5).pts, 3);
})();

/* model versus market */
chk('a model-versus-market question needs a market', !kind('gap').ok(mk({ market_spread: null, research_state: 'REVIEW' })));
chk('and a research state past the threshold', !kind('gap').ok(mk({ market_spread: -6, edgedesk_spread: -9, research_state: 'PASS' })));
chk('and the same favourite on both sides', !kind('gap').ok(mk({ market_spread: 3, edgedesk_spread: -3, research_state: 'REVIEW' })));
chk('and at least two points between them', !kind('gap').ok(mk({ market_spread: -6, edgedesk_spread: -7.5, research_state: 'REVIEW' })));
(() => {
  const q = kind('gap').build(mk({ market_spread: -6.5, edgedesk_spread: -9.7, research_state: 'REVIEW', home_team: 'Auburn', away_team: 'Baylor' }));
  eq('EdgeDesk at 9.7 against a book 6.5 is the BIGGER favourite', q.answer, 0);
  has(q.why, '3.2 points apart', 'the reveal states the gap');
  chk('and the reveal does not call the gap an edge', !/\bedge\b/i.test(q.why.replace(/EdgeDesk/g, '')));
  chk('the lesson says a gap is not an edge', /not evidence of an edge/.test(q.teaches));
})();

/* roster questions */
const ctx = (a, h) => ({ context: { away: a, home: h } });
chk('OL continuity needs both sides', !kind('ol').ok(mk(ctx({ ol_continuity: 60 }, {}))));
chk('and a ten-point gap', !kind('ol').ok(mk(ctx({ ol_continuity: 60 }, { ol_continuity: 55 }))));
(() => {
  const q = kind('ol').build(mk(Object.assign(ctx({ ol_continuity: 40 }, { ol_continuity: 63 }), { home_team: 'Ole Miss', away_team: 'Louisville' })));
  eq('the side with more OL continuity is the answer', q.options[q.answer], 'Ole Miss');
  has(q.why, '40%', 'the reveal shows both numbers');
  has(q.why, '63%', 'the reveal shows both numbers');
})();
chk('QB continuity needs a fifteen-point gap', !kind('qb').ok(mk(ctx({ qb_continuity: 50 }, { qb_continuity: 60 }))));
chk('returning production needs ten', !kind('production').ok(mk(ctx({ returning_production: 30 }, { returning_production: 35 }))));
chk('transfer churn needs five', !kind('churn').ok(mk(ctx({ transfer_churn: 2 }, { transfer_churn: 5 }))));
(() => {
  const q = kind('churn').build(mk(Object.assign(ctx({ transfer_churn: 0 }, { transfer_churn: 10 }), { home_team: 'Cal', away_team: 'UCLA' })));
  eq('the roster that turned over more is the answer', q.options[q.answer], 'Cal');
  chk('churn is shown as a count, not a percentage', !/%/.test(q.why));
})();
chk('every kind\'s options are the two sides or two stated readings — never an invented number',
  DR.KINDS.every(k => {
    const ch = mk(Object.assign({ edgedesk_spread: -9.7, market_spread: -6.5, research_state: 'REVIEW' },
      ctx({ ol_continuity: 40, qb_continuity: 20, returning_production: 20, transfer_churn: 0 },
          { ol_continuity: 63, qb_continuity: 80, returning_production: 50, transfer_churn: 12 })));
    if (!k.ok(ch)) return true;
    const q = k.build(ch);
    return q.options.length === 2 && (q.answer === 0 || q.answer === 1) && q.why && q.prompt;
  }));

/* ═══ 2. DETERMINISM ══════════════════════════════════════════════════════ */
const A = JSON.parse(fs.readFileSync(G('data/challenges.json'), 'utf8'));
(() => {
  const r1 = DR.build(A.challenges, DR.dailySeed('2026-09-04'), NOW);
  const r2 = DR.build(A.challenges, DR.dailySeed('2026-09-04'), NOW);
  eq('today\'s drill is a pure function of the day and the board', JSON.stringify(r1), JSON.stringify(r2));
  eq('a full board yields ten rounds', r1.rounds.length, DR.ROUNDS);
  chk('no matchup appears twice in a run', new Set(r1.rounds.map(q => q.game_id)).size === r1.rounds.length);
  chk('every round names its matchup for the reveal', r1.rounds.every(q => q.game_id && q.home_team && q.away_team && q.round));
  const r3 = DR.build(A.challenges, DR.dailySeed('2026-09-05'), NOW);
  chk('tomorrow is a different drill', JSON.stringify(r3.rounds.map(q => q.game_id + q.kind)) !== JSON.stringify(r1.rounds.map(q => q.game_id + q.kind)));
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(DR.build(A.challenges, DR.freeSeed('2026-09-04', i), NOW).rounds.map(q => q.game_id).join(','));
  chk('free play rotates by run number', seen.size >= 10, seen.size + ' distinct of 12');
  chk('a run mixes its kinds', new Set(r1.rounds.map(q => q.kind)).size >= 4);
  chk('a kicked-off game is never asked', (() => {
    const past = mk({ game_id: 'p', kickoff: '2020-01-01 12:00', edgedesk_spread: -20 });
    return DR.build([past, mk({ game_id: 'f', edgedesk_spread: -20 })], 'x', NOW).rounds.every(q => q.game_id !== 'p');
  })());
  chk('a short board yields fewer rounds and says so', (() => {
    const r = DR.build([mk({ game_id: '1', edgedesk_spread: -20 }), mk({ game_id: '2', edgedesk_spread: -3 })], 'x', NOW);
    return r.rounds.length < DR.ROUNDS && r.short === true;
  })());
  eq('an empty board yields no rounds', DR.build([], 'x', NOW).rounds.length, 0);
  chk('the engine never reaches for randomness',
    !/Math\.random/.test(fs.readFileSync(G('lib/drill.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
})();

/* ═══ 3. THE FIRST ROUND IS THE EASY ONE ══════════════════════════════════ */
(() => {
  const pool = [];
  for (let i = 0; i < 20; i++) pool.push(mk(Object.assign({ game_id: 'c' + i, edgedesk_spread: -3.5, market_spread: -6.5, research_state: 'REVIEW' },
    ctx({ ol_continuity: 40, qb_continuity: 20 }, { ol_continuity: 63, qb_continuity: 80 }))));
  pool.push(mk({ game_id: 'big', edgedesk_spread: -21 }));
  for (let d = 1; d <= 20; d++) {
    const r = DR.build(pool, DR.dailySeed('2026-09-' + String(d).padStart(2, '0')), NOW);
    if (r.rounds[0].kind !== 'favourite' || r.rounds[0].game_id !== 'big') { chk('round one is always who-EdgeDesk-favours on a two-touchdown game', false, 'day ' + d + ': ' + r.rounds[0].kind); break; }
    if (d === 20) chk('round one is always who-EdgeDesk-favours on a two-touchdown game', true);
  }
  const noBig = pool.slice(0, 20);
  chk('without such a game the run still builds', DR.build(noBig, 'x', NOW).rounds.length > 0);
})();

/* ═══ 4. SCORING ══════════════════════════════════════════════════════════ */
(() => {
  const run = DR.build(A.challenges, DR.dailySeed('2026-09-04'), NOW);
  const perfect = run.rounds.map(q => ({ round: q.round, picked: q.answer }));
  const r = DR.score(run, perfect, 47.9, 'complete');
  eq('ten correct is a thousand', r.points, 1000);
  eq('47.9 seconds left is 47 whole seconds, five points each', r.clock_points, 235);
  eq('the total is the sum', r.total, 1235);
  eq('and it carries the rule version', r.scoring_version, 'drill_v1');
  chk('a perfect run keeps its three lives', r.lives_left === 3 && r.complete === true);
  const three = run.rounds.slice(0, 3).map(q => ({ round: q.round, picked: 1 - q.answer }));
  const out = DR.score(run, three, 90, 'lives');
  eq('three misses is out of lives', out.lives_left, 0);
  eq('and no clock points, however much clock is left', out.clock_points, 0);
  eq('and the misses are named so the reveal can research them', out.misses.length, 3);
  const half = run.rounds.slice(0, 6).map((q, i) => ({ round: q.round, picked: i === 2 ? 1 - q.answer : q.answer }));
  const clock = DR.score(run, half, 0, 'clock');
  eq('running out the clock keeps the answer points', clock.points, 500);
  eq('and nothing for the clock', clock.clock_points, 0);
  eq('and one life was lost', clock.lives_left, 2);
  chk('a run cannot be "complete" with a life count of zero', DR.score(run, three, 100, 'complete').complete === false);
  chk('scoring is deterministic', JSON.stringify(DR.score(run, perfect, 47.9, 'complete')) === JSON.stringify(r));
  chk('a grade is a label, never a verdict on the player', ['perfect', 'sharp', 'solid', 'mixed', 'rough'].every(k =>
    [10, 8, 6, 3, 0].some(c => DR.grade({ correct: c }).key === k)) && !/wrong/i.test(JSON.stringify([10, 8, 6, 3, 0].map(c => DR.grade({ correct: c })))));
})();

/* ═══ 5. THE DAILY RUN IS ONE PER DAY ═════════════════════════════════════ */
(() => {
  MEM = {}; ST.reset();
  const T0 = NOW;
  const a = ST.recordDrill({ mode: 'daily', day: W.dayKey(T0), seed: 'daily:2026-09-04', rounds: 10, correct: 7, points: 700, clock_points: 100, total: 800 }, T0);
  const b = ST.recordDrill({ mode: 'daily', day: W.dayKey(T0), seed: 'daily:2026-09-04', rounds: 10, correct: 10, points: 1000, clock_points: 300, total: 1300 }, T0);
  eq('the second daily attempt returns the first result', b.total, 800);
  eq('the weekly score is ten per correct answer', ST.weeklyScore(T0), 70);
  eq('and the run counts toward the streak', ST.liveStreak(null, T0), 1);
  ST.recordDrill({ mode: 'free', day: W.dayKey(T0), rounds: 10, correct: 10, points: 1000, clock_points: 300, total: 1300 }, T0);
  eq('free play never touches the weekly score', ST.weeklyScore(T0), 70);
  eq('but sets the best', ST.drillRecord().best, 1300);
  eq('and counts the run', ST.drillRecord().runs, 2);
  chk('the stored run carries the matchups so the reveal can be rebuilt', Array.isArray(a.game_ids) && Array.isArray(a.misses));
})();

/* ═══ 6. THE PAGE ═════════════════════════════════════════════════════════ */
const PAGE = fs.readFileSync(G('two-minute-drill/index.html'), 'utf8');
const DCSS = fs.existsSync(G('two-minute-drill/drill.css')) ? fs.readFileSync(G('two-minute-drill/drill.css'), 'utf8') : '';
const CSS = fs.readFileSync(G('games.css'), 'utf8');
const JS = fs.readFileSync(G('games.js'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');

has(PAGE, '<link rel="canonical" href="https://edgedesksports.com/games/two-minute-drill">', 'the Drill declares its canonical URL');
has(PAGE, 'name="robots" content="index,follow"', 'the Drill is crawlable');
['og:title', 'og:description', 'og:url'].forEach(p => has(PAGE, 'property="' + p + '"', 'the Drill carries ' + p));
has(PAGE, 'name="twitter:card"', 'the Drill carries a Twitter card');
chk('the Drill has a title', /<title>[^<]{10,}<\/title>/.test(PAGE));
chk('the Drill has a meta description', /name="description" content="[^"]{40,}"/.test(PAGE));
has(PAGE, 'width=device-width', 'the Drill is responsive');
has(PAGE, 'viewport-fit=cover', 'the Drill handles a notched phone');
has(PAGE, 'rel="icon"', 'the Drill has a tab icon');
has(PAGE, 'G-1PXVBV53FZ', 'the Drill reports to the existing analytics property');
chk('no second analytics vendor', !/posthog|mixpanel|segment\.com|amplitude|plausible\.io|fathom/i.test(PAGE));
has(PAGE, '/games/lib/drill.js', 'the page reads the engine rather than restating it');
has(PAGE, 'DR.build', 'and builds its run from it');
has(PAGE, 'DR.score', 'and scores through it');
has(PAGE, 'DR.dailySeed', 'the daily seed is the shared one');
has(PAGE, 'DR.freeSeed', 'and free play seeds on the run number');
has(PAGE, 'ST.recordDrill', 'a run is recorded on the player\'s record');
has(PAGE, 'ST.drillDaily', 'and a finished daily is replayed rather than replayed for points');
has(PAGE, "G.boot('drill')", 'the Drill boots through the shared runtime');
has(PAGE, 'G.pulse', 'and the War Room reacts to it');
has(PAGE, 'could not be loaded', 'the Drill says when the board cannot load');
has(PAGE, 'Free to play', 'the Drill states that it is free to play');
has(PAGE, 'No real-money wagering', 'and that there is no real-money wagering');
chk('the Drill funnels a miss into the research',
  /research_open_from_drill/.test(PAGE) && /G\.openResearch/.test(PAGE));
chk('and the reveal shows why', /\.why\b|q\.why|\bwhy\b/i.test(PAGE));
has(PAGE, 'Press+Start+2P', 'the retro face comes from the one allowed font host');
chk('and only from it', !/fonts\.(?!googleapis|gstatic)/.test(PAGE));
chk('the Drill is retro, not a casino',
  !/insert coin|credits?\b|jackpot|slot|reel|casino|\bbonus\b|multiplier|\bbet\b|\bwager\b(?!ing)|parlay|odds boost|deposit|wallet|\bbalance\b|entry fee|cash prize|loot box|virtual currency/i
    .test((PAGE + DCSS).replace(/no real-money wagering/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  ((PAGE + DCSS).replace(/no real-money wagering/gi, '').match(/insert coin|credits?\b|jackpot|slot|reel|casino|\bbonus\b|multiplier|\bbet\b|\bwager\b(?!ing)|parlay|odds boost|deposit|wallet|\bbalance\b|entry fee|cash prize|loot box|virtual currency/i) || [''])[0]);
chk('a miss is never the player being wrong',
  !/you were wrong|you got it wrong|wrong answer/i.test(PAGE));
has(PAGE, 'not a betting edge', 'a gap is never sold as an edge');
has(PAGE + DCSS, 'prefers-reduced-motion', 'the Drill respects reduced motion');
chk('the Drill never strobes: no animation faster than three a second',
  (DCSS.match(/animation:[^;]*?(\d*\.?\d+)s/g) || []).every(a => +a.match(/(\d*\.?\d+)s/)[1] >= 0.34 || /steps\(1|infinite/.test(a) === false),
  (DCSS.match(/animation:[^;]*?(\d*\.?\d+)s/g) || []).join(' | '));
chk('the Drill is mobile-first: any max-width query is a narrow refinement',
  ((PAGE + DCSS).match(/@media\s*\(max-width:\s*(\d+)px\)/g) || []).every(m => +m.match(/(\d+)/)[1] <= 480));
chk('the option buttons meet the tap minimum', /min-height:\s*(6\d|7\d|8\d|var\(--tap\))/.test(DCSS));
chk('long team names wrap rather than overflow', /overflow-wrap:\s*break-word/.test(DCSS + CSS));
chk('keyboard players can answer', /ArrowLeft|key ?=== ?'1'|e\.key/.test(PAGE));
chk('the clock is computed from elapsed time, not accumulated ticks', /Date\.now\(\)/.test(PAGE));
chk('the Drill never reaches for randomness', !/Math\.random/.test(PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')));
chk('sound is WebAudio with no asset', /AudioContext/.test(PAGE) && !/\.mp3|\.wav|\.ogg/.test(PAGE));
chk('and can be muted', /mute/i.test(PAGE));
['drill_start', 'drill_round', 'drill_complete', 'drill_share'].forEach(e =>
  chk('the Drill fires ' + e, new RegExp("track\\('" + e + "'").test(PAGE)));
['drill_start', 'drill_round', 'drill_complete', 'drill_share', 'research_open_from_drill'].forEach(e =>
  chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
has(SITEMAP, 'https://edgedesksports.com/games/two-minute-drill<', 'the sitemap lists the Drill');
has(NOTFOUND, "p[1]==='two-minute-drill'", 'a deeper Drill path lands on the Drill');
chk('the Drill is one tap from every page', /\/games\/two-minute-drill\//.test(JS));
chk('the word lock is only ever the submit verb',
  ((PAGE.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').match(/\block\w*/gi) || [])
    .every(w => ['lock', 'locked', 'locks', 'locker'].indexOf(w.toLowerCase()) >= 0)),
  (PAGE.match(/\block\w*/gi) || []).join(','));

console.log((fail ? 'FAIL' : 'PASS') + ' | two-minute drill | ' + pass + ' passed, ' + fail + ' failed');
failures.forEach(f => console.log('  × ' + f));
process.exit(fail ? 1 : 0);
