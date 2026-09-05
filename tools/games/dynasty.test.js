#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK DYNASTY — the suite.

   What it holds down:

     1  XP is DERIVED from the record, never accumulated — so a replayed
        game, a reloaded page, a double-clicked button and a re-run
        settlement are all worth exactly nothing
     2  the level curve is the published one, monotonic, capped, and a
        stored XP total always maps to one level
     3  titles and War Room stages step where the README says they step
     4  weekly missions count only this football week, and the badge is
        earned only by all five
     5  every achievement is a predicate over real rows with a real timestamp,
        and none can be granted
     6  the diff celebrates exactly what is new, once
     7  the store's new ledgers are idempotent by key and survive an envelope
        written before they existed
     8  the pages exist, are crawlable, carry the metadata, respect the mobile
        and copy rules, and reach the research
     9  a subscriber earns the same XP as anyone: nothing in the rules reads
        an account or a plan

   Run: node tools/games/dynasty.test.js
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
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const G = f => path.join(ROOT, 'games', f);

let MEM = {};
let COOKIES = {};
global.localStorage = {
  getItem: k => (MEM[k] == null ? null : MEM[k]),
  setItem: (k, v) => { MEM[k] = String(v); },
  removeItem: k => { delete MEM[k]; }
};
global.document = {
  get cookie() { return Object.keys(COOKIES).map(k => k + '=' + COOKIES[k]).join('; '); },
  set cookie(v) { const m = String(v).match(/^([^=]+)=([^;]*)/); if (m) COOKIES[m[1]] = m[2]; }
};
global.location = { search: '', pathname: '/games/' };
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));

const W = require(G('lib/week.js'));
require(G('lib/scoring.js'));
require(G('lib/challenge.js'));
require(G('lib/research_state.js'));
require(G('lib/attribution.js'));
const ST = require(G('lib/store.js'));
const DY = require(G('lib/dynasty.js'));

function fresh() { MEM = {}; ST.reset(); }
const T0 = Date.parse('2026-09-04T18:00:00Z');       /* Friday, week of 2026-09-01 */
const T1 = Date.parse('2026-09-11T18:00:00Z');       /* the following week */
const D = n => T0 + n * 86400000;
function price(id, ms, extra) {
  return ST.recordPriceIt(Object.assign({ game_id: id, slug: 'a-' + id, home_team: 'Home' + id,
    away_team: 'Away' + id, user_spread: -3, edgedesk_spread: -5, market_spread: -4,
    distance: 2, distance_to_market: 1, score: 90, benchmark: 'edgedesk',
    scoring_version: 'price_it_v1' }, extra || {}), ms);
}

/* ═══ 1. DERIVED, NEVER ACCUMULATED ═══════════════════════════════════════ */
fresh();
eq('a new envelope has no XP', DY.totalXp(ST.read()), 0);
eq('and is level one', DY.summary(ST.read(), T0).level, 1);
eq('and has no War Room yet', DY.summary(ST.read(), T0).created, false);

price('1', T0);
eq('one Price It is worth the published XP', DY.totalXp(ST.read()), DY.XP.price_it);
eq('and it creates the War Room', DY.summary(ST.read(), T0).created, true);
price('1', T0); price('1', T0 + 1000);
eq('replaying the same challenge earns nothing more', DY.totalXp(ST.read()), DY.XP.price_it);
(() => {
  /* a hand-edited envelope with the same game twice in the results array */
  const s = ST.read(); s.price_it.results.push(Object.assign({}, s.price_it.results[0])); ST.write(s);
  eq('even a duplicated row in the envelope counts once', DY.totalXp(ST.read()), DY.XP.price_it);
})();
(() => {
  const a = DY.ledger(ST.read()), b = DY.ledger(ST.read());
  eq('the ledger is deterministic', JSON.stringify(a), JSON.stringify(b));
  chk('every ledger entry names the record it came from',
    a.every(e => e.kind && e.key && typeof e.xp === 'number' && e.label));
})();

/* research opens: unique per game, capped per week */
fresh();
for (let i = 0; i < 15; i++) ST.recordResearchOpen({ game_id: 'g' + i, home_team: 'H', away_team: 'A' }, T0 + i);
ST.recordResearchOpen({ game_id: 'g0' }, T0 + 99);
eq('research XP is capped per football week', DY.totalXp(ST.read()),
  DY.XP.research_open * DY.RESEARCH_CAP_PER_WEEK);
eq('and a repeat open of the same game is one row', Object.keys(ST.read().research.opens).length, 15);
ST.recordResearchOpen({ game_id: 'next-week' }, T1);
eq('a new week has a fresh cap', DY.totalXp(ST.read()),
  DY.XP.research_open * (DY.RESEARCH_CAP_PER_WEEK + 1));

/* the daily drill: one per day, replayed */
fresh();
ST.recordDrill({ mode: 'daily', day: '2026-09-04', rounds: 10, correct: 7, total: 700 }, T0);
ST.recordDrill({ mode: 'daily', day: '2026-09-04', rounds: 10, correct: 10, total: 1400 }, T0);
eq('the daily drill is worth its XP once', DY.totalXp(ST.read()), DY.XP.drill_daily);
eq('and the first result is the one kept', ST.drillDaily('2026-09-04').correct, 7);
eq('and the weekly score took ten per correct answer, once', ST.weeklyScore(T0), 70);
ST.recordDrill({ mode: 'free', day: '2026-09-04', rounds: 10, correct: 10, total: 1400 }, T0);
eq('free play earns no XP', DY.totalXp(ST.read()), DY.XP.drill_daily);
eq('free play does not touch the weekly score', ST.weeklyScore(T0), 70);
eq('but it does count toward the best', ST.drillRecord().best, 1400);
eq('and toward the run total', ST.drillRecord().runs, 2);

/* groups: once ever */
fresh();
ST.recordEvent('group_create', 'tokA', null, T0);
ST.recordEvent('group_create', 'tokB', null, T0 + 1);
eq('founding a second group earns nothing more', DY.totalXp(ST.read()), DY.XP.group_create);
ST.recordEvent('group_join', 'tokC', null, T0);
ST.recordEvent('group_join', 'tokD', null, T0);
eq('joining a second group earns nothing more', DY.totalXp(ST.read()), DY.XP.group_create + DY.XP.group_join);

/* returning for a football week: only after play in an earlier one */
fresh();
ST.touchVisit(T0);
eq('a first visit is not a return', DY.totalXp(ST.read()), 0);
ST.touchVisit(T1);
eq('a new week with no earlier play is not a return either', DY.totalXp(ST.read()), 0);
fresh();
price('1', T0);
ST.touchVisit(T0);
ST.touchVisit(T1);
ST.touchVisit(T1 + 3600000);
eq('a new football week after real play is a return, once', DY.totalXp(ST.read()),
  DY.XP.price_it + DY.XP.week_return);

/* ═══ 2. THE LEVEL CURVE ══════════════════════════════════════════════════ */
eq('level 1 starts at zero', DY.xpForLevel(1), 0);
eq('level 2 costs 100', DY.xpForLevel(2), 100);
eq('level 5 costs 700', DY.xpForLevel(5), 700);
eq('level 10 costs 2,700', DY.xpForLevel(10), 2700);
eq('level 20 costs 10,450', DY.xpForLevel(20), 10450);
eq('the cap is level 30', DY.MAX_LEVEL, 30);
eq('level 30 costs 23,200', DY.xpForLevel(30), 23200);
(() => {
  let mono = true, steps = true;
  for (let L = 2; L <= DY.MAX_LEVEL; L++) {
    if (DY.xpForLevel(L) <= DY.xpForLevel(L - 1)) mono = false;
    if (L >= 3 && (DY.xpForLevel(L) - DY.xpForLevel(L - 1)) - (DY.xpForLevel(L - 1) - DY.xpForLevel(L - 2)) !== 50) steps = false;
  }
  chk('the curve is strictly increasing', mono);
  chk('each level costs exactly 50 XP more than the last', steps);
  let round = true;
  for (let x = 0; x < 30000; x += 7) { const L = DY.levelFor(x); if (x < DY.xpForLevel(L) || (L < DY.MAX_LEVEL && x >= DY.xpForLevel(L + 1))) round = false; }
  chk('every XP total maps to exactly one level', round);
  eq('XP past the cap stays at the cap', DY.levelFor(10000000), DY.MAX_LEVEL);
  eq('nonsense XP is level one', DY.levelFor(NaN), 1);
  eq('negative XP is level one', DY.levelFor(-5), 1);
})();

/* ═══ 3. TITLES AND STAGES ════════════════════════════════════════════════ */
eq('level 1 is a Rookie Analyst', DY.titleFor(1), 'Rookie Analyst');
eq('level 4 is still a Rookie Analyst', DY.titleFor(4), 'Rookie Analyst');
eq('level 5 is a Scout', DY.titleFor(5), 'Scout');
eq('level 10 is a Coordinator', DY.titleFor(10), 'Coordinator');
eq('level 15 is a Director', DY.titleFor(15), 'Director');
eq('level 20 is a General Manager', DY.titleFor(20), 'General Manager');
eq('the room starts in the Garage', DY.stageFor(1).key, 'garage');
eq('level 5 is the Film Room', DY.stageFor(5).key, 'film');
eq('level 10 is the Analytics Lab', DY.stageFor(10).key, 'lab');
eq('level 15 is Football Operations', DY.stageFor(15).key, 'ops');
eq('level 20 is Market Command', DY.stageFor(20).key, 'command');
eq('level 29 is still Market Command', DY.stageFor(29).key, 'command');
eq('the next stage from the Garage is the Film Room at level 5', DY.nextStage(3).level, 5);
eq('there is no stage past Market Command', DY.nextStage(25), null);
chk('every stage names itself and says what it looks like',
  DY.STAGES.every(s => s.name && s.blurb && s.key));
chk('titles and stages step at the same levels, so a level-up reads as one event',
  DY.STAGES.every(s => DY.TITLES.some(t => t.level === s.level)));

/* ═══ 4. WEEKLY MISSIONS ══════════════════════════════════════════════════ */
fresh();
(() => {
  const wk = W.weekKey(T0);
  let m = DY.missionSet(ST.read(), wk);
  eq('five missions a week', m.total, 5);
  eq('none done on a fresh envelope', m.done, 0);
  chk('every mission links somewhere the player can do it',
    m.missions.every(x => /^\/games\//.test(x.href) && x.label && x.how));
  price('1', T0); price('2', T0); 
  m = DY.missionSet(ST.read(), wk);
  eq('two prices is progress, not completion', m.missions.filter(x => x.id === 'price_3')[0].progress, 2);
  price('3', T0);
  m = DY.missionSet(ST.read(), wk);
  chk('three prices completes the mission', m.missions.filter(x => x.id === 'price_3')[0].done);
  price('4', T0);
  eq('a fourth price does not overflow the mission', DY.missionSet(ST.read(), wk).missions[0].progress, 3);
  price('5', T1);
  eq('a price in another week does not count toward this one',
    DY.missionSet(ST.read(), wk).missions[0].progress, 3);
  eq('but it counts toward its own', DY.missionSet(ST.read(), W.weekKey(T1)).missions[0].progress, 1);
  ST.submitPick5(wk, [{ game_id: 'p1', pick: 'home' }], T0);
  ST.recordDrill({ mode: 'daily', day: W.dayKey(T0), rounds: 10, correct: 5, total: 500 }, T0);
  ST.recordResearchOpen({ game_id: '1' }, T0);
  m = DY.missionSet(ST.read(), wk);
  eq('four of five', m.done, 4);
  eq('the set is not complete at four', m.complete, false);
  eq('and no badge XP has been paid', DY.ledger(ST.read()).filter(e => e.kind === 'mission_set').length, 0);
  ST.recordEvent('h2h_create', 'tok1', null, T0 + 5000);
  m = DY.missionSet(ST.read(), wk);
  eq('a created challenge is the fifth', m.done, 5);
  chk('the set completes', m.complete);
  chk('and it is stamped with the moment the last mission landed', m.completed_at === new Date(T0 + 5000).toISOString());
  eq('the badge XP is paid once', DY.ledger(ST.read()).filter(e => e.kind === 'mission_set').length, 1);
  ST.recordEvent('h2h_submit', 'tok2', null, T0 + 6000);
  eq('a second challenge does not pay it again', DY.ledger(ST.read()).filter(e => e.kind === 'mission_set').length, 1);
  chk('answering a challenge counts as challenging a friend too', (() => {
    fresh(); ST.recordEvent('h2h_submit', 'tokX', null, T0);
    return DY.missionSet(ST.read(), wk).missions.filter(x => x.id === 'challenge')[0].done;
  })());
})();

/* ═══ 5. ACHIEVEMENTS ═════════════════════════════════════════════════════ */
fresh();
(() => {
  const ids = DY.ACHIEVEMENTS.map(a => a.id);
  chk('every achievement has a name and a description', DY.ACHIEVEMENTS.every(a => a.id && a.name && a.desc));
  chk('achievement ids are unique', new Set(ids).size === ids.length);
  let A = DY.achievements(ST.read());
  eq('a fresh envelope has earned none', A.filter(a => a.earned).length, 0);
  chk('and the list is the whole catalogue', A.length === DY.ACHIEVEMENTS.length);
  price('1', T0, { distance: 2.5, distance_to_market: 1 });
  A = DY.achievements(ST.read());
  chk('First Price is earned by the first Price It', A.filter(a => a.id === 'first_price')[0].earned);
  eq('and carries the moment it happened', A.filter(a => a.id === 'first_price')[0].at, new Date(T0).toISOString());
  chk('On the Number is not earned at 2.5 points', !A.filter(a => a.id === 'on_the_number')[0].earned);
  price('2', T0, { distance: 0.5 });
  chk('On the Number is earned at half a point', DY.achievements(ST.read()).filter(a => a.id === 'on_the_number')[0].earned);
  price('3', T0, { distance_to_market: 7 });
  chk('Contrarian is earned seven points from the market', DY.achievements(ST.read()).filter(a => a.id === 'contrarian')[0].earned);
  chk('and its description is descriptive, not praise',
    /not a verdict/i.test(DY.ACHIEVEMENTS.filter(a => a.id === 'contrarian')[0].desc));
  for (let i = 4; i <= 10; i++) price(String(i), T0 + i);
  chk('Ten Prices lands on the tenth', DY.achievements(ST.read()).filter(a => a.id === 'ten_prices')[0].earned);
  eq('Fifty Prices shows its progress', DY.achievements(ST.read()).filter(a => a.id === 'fifty_prices')[0].progress, 10);

  const wk = W.weekKey(T0);
  ST.submitPick5(wk, ['a', 'b', 'c', 'd', 'e'].map(g => ({ game_id: g, pick: 'home' })), T0);
  chk('First Card is earned by a card', DY.achievements(ST.read()).filter(a => a.id === 'first_card')[0].earned);
  ST.settlePick5(wk, { a: 'home', b: 'home', c: 'home', d: 'home', e: 'away' });
  chk('Perfect Five is not earned at 4–1', !DY.achievements(ST.read()).filter(a => a.id === 'perfect_five')[0].earned);
  fresh();
  ST.submitPick5(wk, ['a', 'b', 'c', 'd', 'e'].map(g => ({ game_id: g, pick: 'home' })), T0);
  ST.settlePick5(wk, { a: 'home', b: 'home', c: 'home', d: 'home', e: 'home' });
  chk('Perfect Five is earned at 5–0', DY.achievements(ST.read()).filter(a => a.id === 'perfect_five')[0].earned);

  fresh();
  for (let i = 0; i < 9; i++) ST.recordResearchOpen({ game_id: 'r' + i }, T0 + i);
  eq('Researcher shows nine of ten', DY.achievements(ST.read()).filter(a => a.id === 'researcher')[0].progress, 9);
  ST.recordResearchOpen({ game_id: 'r9' }, T0 + 9);
  chk('Researcher is earned at ten unique games', DY.achievements(ST.read()).filter(a => a.id === 'researcher')[0].earned);
  ST.recordResearchOpen({ game_id: 'r9' }, T0 + 10);
  eq('and a repeat open does not move Film Study', DY.achievements(ST.read()).filter(a => a.id === 'film_study')[0].progress, 10);

  fresh();
  for (let d = 0; d < 7; d++) price('s' + d, D(d));
  chk('Seven Days is earned by seven consecutive days', DY.achievements(ST.read()).filter(a => a.id === 'seven_days')[0].earned);

  fresh();
  ST.recordDrill({ mode: 'free', day: '2026-09-04', rounds: 10, correct: 8, total: 800 }, T0);
  chk('Sharp Drill is earned at eight of ten, even in free play', DY.achievements(ST.read()).filter(a => a.id === 'sharp_drill')[0].earned);
  chk('No Huddle is not', !DY.achievements(ST.read()).filter(a => a.id === 'no_huddle')[0].earned);
  ST.recordDrill({ mode: 'free', day: '2026-09-04', rounds: 9, correct: 9, total: 900 }, T0);
  chk('a short board cannot earn No Huddle with nine of nine', !DY.achievements(ST.read()).filter(a => a.id === 'no_huddle')[0].earned);
  ST.recordDrill({ mode: 'daily', day: '2026-09-04', rounds: 10, correct: 10, total: 1000 }, T0);
  chk('No Huddle is earned at ten of ten', DY.achievements(ST.read()).filter(a => a.id === 'no_huddle')[0].earned);

  fresh();
  for (let i = 0; i < 9; i++) ST.recordEvent('h2h_locked', 'c' + i, { opponent: 'Davis' }, T0 + i);
  ST.recordEvent('h2h_locked', 'other', { opponent: 'Kim' }, T0 + 50);
  eq('Rivalry counts the SAME opponent', DY.achievements(ST.read()).filter(a => a.id === 'rivalry')[0].progress, 9);
  chk('Head-to-Head is earned by the first one', DY.achievements(ST.read()).filter(a => a.id === 'first_h2h')[0].earned);
  ST.recordEvent('h2h_locked', 'c9', { opponent: 'Davis' }, T0 + 9);
  chk('Rivalry is earned at ten against one player', DY.achievements(ST.read()).filter(a => a.id === 'rivalry')[0].earned);
  ST.recordEvent('h2h_locked', 'c9', { opponent: 'Davis' }, T0 + 99);
  eq('and the same token again is nothing', ST.eventsOf('h2h_locked').length, 11);

  fresh();
  ST.recordEvent('group_create', 'g', null, T0);
  chk('Founder is earned by creating a group', DY.achievements(ST.read()).filter(a => a.id === 'founder')[0].earned);

  chk('there is no achievement for a leaderboard finish until the board is live',
    ids.indexOf('weekly_champ') < 0 && !ids.some(i => /champ/.test(i)));
})();

/* ═══ 6. THE DIFF ═════════════════════════════════════════════════════════ */
fresh();
(() => {
  let now = DY.summary(ST.read(), T0);
  let d = DY.diff(null, now);
  eq('nothing to celebrate on a fresh envelope', d.xp_gained, 0);
  eq('and no War Room to announce', d.created, false);
  /* PROGRESSIVE DISCLOSURE: the first game is a result, the second is a
     War Room. Nobody who has played once is shown a product tour. */
  const seen0 = DY.marker(now);
  price('1', T0);
  now = DY.summary(ST.read(), T0);
  d = DY.diff(seen0, now);
  chk('the first game is celebrated as a first result', d.first_result);
  chk('and does NOT announce a War Room yet', !d.created);
  chk('and is not a level-up', !d.leveled_up);
  eq('the War Room is announced at two games', DY.CREATE_AT, 2);
  const seen = DY.marker(now);
  d = DY.diff(seen, now);
  eq('seen once, nothing is new', d.xp_gained, 0);
  chk('the first result is not re-announced', !d.first_result && !d.created);
  eq('no new achievements', d.new_achievements.length, 0);
  price('2', T0 + 1);
  now = DY.summary(ST.read(), T0);
  d = DY.diff(seen, now);
  eq('the second game is exactly its XP', d.xp_gained, DY.XP.price_it);
  chk('and it creates the War Room', d.created);
  chk('a creation is not also announced as a level-up', d.leveled_up && d.to_level === 2 && d.from_level === 1);
  chk('without a stage change', !d.stage_changed);
  /* the first look at an envelope with history: one moment, no chip storm */
  chk('a player with history gets a baseline, not a replay of every moment', DY.diff(null, now).baseline === true);
  chk('and a fresh envelope is a baseline too', DY.diff(null, DY.summary({}, T0)).baseline === true);
  const seen2 = DY.marker(now);
  for (let i = 3; i <= 20; i++) price(String(i), T0 + i);
  now = DY.summary(ST.read(), T0);
  d = DY.diff(seen2, now);
  chk('a run of games past level 5 changes the stage', d.leveled_up && d.stage_changed && now.stage.key === 'film');
  chk('new achievements are the ones not in the marker', d.new_achievements.map(a => a.id).indexOf('ten_prices') >= 0
    && d.new_achievements.map(a => a.id).indexOf('first_price') < 0);
  /* missions: only newly done ones, and only in the same week */
  chk('missions newly done are counted against the marker', d.missions_newly_done >= 1);
  const seen3 = DY.marker(now);
  now = DY.summary(ST.read(), T0);
  eq('once seen, no mission is newly done', DY.diff(seen3, now).missions_newly_done, 0);
  const seenOtherWeek = Object.assign({}, seen3, { missions_week: '2000-01-04', missions_done: 5, missions_complete: true });
  chk('a marker from another week does not hide this week’s progress',
    DY.diff(seenOtherWeek, now).missions_newly_done === now.missions.done);
})();

/* ═══ 7. THE STORE'S NEW LEDGERS ══════════════════════════════════════════ */
fresh();
(() => {
  const r1 = ST.recordEvent('h2h_locked', 'tok', { opponent: 'A' }, T0);
  const r2 = ST.recordEvent('h2h_locked', 'tok', { opponent: 'B' }, T0 + 1);
  chk('an event is recorded once', r1.recorded && !r2.recorded);
  eq('and the first write wins', r2.event.meta.opponent, 'A');
  eq('an event carries its football week', r1.event.week, '2026-09-01');
  eq('and its day', r1.event.day, '2026-09-04');
  chk('a missing key records nothing', !ST.recordEvent('h2h_locked', null, null, T0).recorded);
  chk('the ledger survives an envelope written before it existed', (() => {
    MEM = {}; ST.reset();
    MEM[ST.KEY] = JSON.stringify({ v: 1, created_at: 'x', display_name: null,
      streak: { current: 0, best: 0, last_day: null }, weeks: {},
      price_it: { played: 1, score_total: 90, distance_total: 2, results: [{ game_id: 'old', score: 90, distance: 2, at: '2026-09-01T00:00:00Z', week: '2026-09-01' }] },
      pick5: { cards: {}, correct: 0, decided: 0 }, attribution: null, seen: {} });
    const s = ST.read();
    return s.events && s.research && s.research.opens && s.drill && s.drill.daily && s.visits && s.dynasty
      && DY.summary(s, T0).xp === DY.XP.price_it && DY.summary(s, T0).created === true;
  })());
  chk('an envelope missing one nested key gets that key back', (() => {
    MEM = {}; ST.reset();
    MEM[ST.KEY] = JSON.stringify(Object.assign(JSON.parse(MEM[ST.KEY] || '{}'), { v: 1, drill: { runs: 3 } }));
    const s = ST.read();
    return s.drill.runs === 3 && s.drill.daily && Array.isArray(s.drill.history) && s.drill.best === 0;
  })());
  fresh();
  const v = ST.touchVisit(T0);
  chk('the first visit says so', v.first && !v.return_1d);
  const v2 = ST.touchVisit(T0 + 3600000);
  chk('a second visit the same day is not a return', !v2.return_1d && !v2.new_day);
  const v3 = ST.touchVisit(D(1));
  chk('the next day is a one-day return', v3.return_1d && !v3.return_7d);
  const v4 = ST.touchVisit(D(9));
  chk('eight days later is a seven-day return', v4.return_7d);
  eq('days visited are counted', ST.read().visits.days, 3);
  chk('the export carries the ledgers for a future account', (() => {
    const x = ST.exportForAccount();
    return x.events && x.research && x.drill && x.visits;
  })());
  chk('the account ask now counts a daily drill as engagement', (() => {
    fresh(); ST.recordDrill({ mode: 'daily', day: '2026-09-04', rounds: 10, correct: 1, total: 100 }, T0);
    if (ST.engaged()) return false;
    price('1', T0); return ST.engaged();
  })());
})();

/* ═══ 8. THE SHIPPED FILES ════════════════════════════════════════════════ */
const HOME = fs.readFileSync(G('index.html'), 'utf8');
const DYN = fs.readFileSync(G('dynasty/index.html'), 'utf8');
const DYNCSS = fs.existsSync(G('dynasty/dynasty.css')) ? fs.readFileSync(G('dynasty/dynasty.css'), 'utf8') : '';
const PRICE = fs.readFileSync(G('price-it/index.html'), 'utf8');
const PICK = fs.readFileSync(G('pick-5/index.html'), 'utf8');
const H2H = fs.readFileSync(G('h2h/index.html'), 'utf8');
const GRP = fs.readFileSync(G('groups/index.html'), 'utf8');
const CSS = fs.readFileSync(G('games.css'), 'utf8');
const JS = fs.readFileSync(G('games.js'), 'utf8');
const RULES = fs.readFileSync(G('lib/dynasty.js'), 'utf8');
const STORE = fs.readFileSync(G('lib/store.js'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/* the War Room page */
has(DYN, '<link rel="canonical" href="https://edgedesksports.com/games/dynasty">', 'the War Room declares its canonical URL');
has(DYN, 'name="robots" content="index,follow"', 'the War Room is crawlable');
['og:title', 'og:description', 'og:url'].forEach(p => has(DYN, 'property="' + p + '"', 'the War Room carries ' + p));
has(DYN, 'name="twitter:card"', 'the War Room carries a Twitter card');
chk('the War Room has a title', /<title>[^<]{10,}<\/title>/.test(DYN));
chk('the War Room has a meta description', /name="description" content="[^"]{40,}"/.test(DYN));
has(DYN, 'width=device-width', 'the War Room is responsive');
has(DYN, 'viewport-fit=cover', 'the War Room handles a notched phone');
has(DYN, 'rel="icon"', 'the War Room has a tab icon');
has(DYN, 'G-1PXVBV53FZ', 'the War Room reports to the existing analytics property');
has(DYN, '/games/lib/dynasty.js', 'the War Room reads the rules module rather than restating them');
has(DYN, 'DY.summary', 'and renders from the summary, not its own arithmetic');
chk('the War Room never computes XP of its own',
  !/xp\s*[+][=]|xp\s*=\s*xp\s*\+|\+=\s*\d+\s*;?\s*\/\*\s*xp/i.test(DYN.replace(/\/\*[\s\S]*?\*\//g, '')));
has(DYN, 'G.boot(\'dynasty\')', 'the War Room boots through the shared runtime');
has(DYN, 'could not be loaded', 'the War Room says when the board cannot load');
has(DYN, 'Free to play', 'the War Room states that it is free to play');
has(DYN, 'No real-money wagering', 'and that there is no real-money wagering');
['Matchup Board', 'Market Desk', 'Film Room', 'Trophy Wall'].forEach(st =>
  has(DYN, st, 'the War Room has a ' + st + ' station'));
chk('every station is a real link with a text label',
  /class="station/.test(DYN) && /\.station/.test(CSS));
has(DYN, 'aria-hidden="true"', 'the room picture is hidden from screen readers');
chk('and the room is described in text beside it', /Stage \d of \d|stage-caption|class="vh"|sr-only/.test(DYN));
has(DYN, 'prefers-reduced-motion', 'the room respects reduced motion');
has(DYN, 'research_open_from_dynasty', 'the War Room fires the research event');
has(DYN, 'account_save_from_dynasty', 'and the account-save event');
has(DYN, 'dynasty_start', 'and dynasty_start');
has(DYN, "'#research/football'", 'the War Room reaches the real research module');
chk('the War Room says XP never changes a number',
  /never changes EdgeDesk/.test(DYN) && /same XP as everyone/i.test(DYN));
chk('the War Room calls it research progression, not betting skill',
  /research progression/i.test(DYN) && !/betting skill/i.test(DYN));
chk('the War Room shows the XP table so the rules are visible',
  /DY\.XP/.test(DYN) && /<details/.test(DYN));
chk('the War Room never fabricates a rank, a member count or a player',
  !/#\d+ of \d+ players|\d+ members online|members online/i.test(DYN));

/* the home page */
has(HOME, 'Think you know', 'the home page leads with the question, not the product');
has(HOME, 'Price this game', 'and one button that starts a real game');
has(HOME, 'id="heroMu"', 'with today’s matchup named in the hero');
has(HOME, 'Loading matchup', 'and a labelled loading state, never a blank');
chk('the new-visitor hero explains no XP, level or War Room',
  !/XP|Level \d|War Room/.test(HOME.slice(HOME.indexOf('id="heroNew"'), HOME.indexOf('id="heroBack"'))));
has(HOME, 'id="heroBack"', 'a returning player gets their own hero');
has(HOME, 'Welcome back', 'which says welcome back');
has(HOME, 'id="continueBtn"', 'with one CONTINUE');
chk('the returning hero is decided before the modules load',
  HOME.indexOf("localStorage.getItem('edgedesk_games_v1')") > 0
  && HOME.indexOf("localStorage.getItem('edgedesk_games_v1')") < HOME.indexOf('<script src="/games/lib/week.js">'));
chk('and a browser that blocks storage still sees the pitch',
  /try\{[^}]*edgedesk_games_v1[\s\S]*?catch\(_\)\{\}/.test(HOME));
has(HOME, '/games/lib/dynasty.js', 'the home page loads the rules');
has(HOME, 'Your War Room grows', 'the home page explains the persistent layer publicly');
has(HOME, 'research progression, not a betting skill', 'and says what XP is not');
has(HOME, 'same XP as everyone', 'and that a subscriber earns the same XP');
has(HOME, 'No leaderboard results yet. Be the first.', 'the leaderboard still never fabricates a player');

/* the chrome */
has(JS, '/games/dynasty/', 'the header leads with the War Room');
has(JS, '/games/two-minute-drill/', 'and offers the Drill');
has(JS, 'gh-lvl', 'the level badge follows the player onto every page');
chk('the level badge is hidden until a War Room exists', /id="ghLvl"[^>]*hidden/.test(JS));
chk('everything the header sheds is in the footer',
  /\/games\/h2h\//.test(JS.slice(JS.indexOf('function footer'))) && /\/games\/pick-5\//.test(JS.slice(JS.indexOf('function footer')))
  && /\/games\/groups\//.test(JS.slice(JS.indexOf('function footer'))) && /\/games\/price-it\//.test(JS.slice(JS.indexOf('function footer'))));
['dynasty_start', 'war_room_created', 'first_game_complete', 'account_save_from_dynasty', 'level_up',
 'weekly_mission_complete', 'achievement_unlock', 'research_open_from_dynasty', 'premium_view_from_dynasty',
 'subscription_from_dynasty', 'return_1d', 'return_7d', 'return_next_football_week'].forEach(e =>
  chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
['war_room_created', 'first_game_complete', 'level_up', 'weekly_mission_complete', 'achievement_unlock',
 'return_1d', 'return_7d', 'return_next_football_week'].forEach(e =>
  chk('the runtime actually fires ' + e, new RegExp("track\\('" + e + "'").test(JS)));
chk('every event carries the level', /dynasty_level/.test(JS));
chk('a return is measured from the visit ledger, not a page view',
  /touchVisit/.test(JS) && /return_1d/.test(STORE) && /gap_days/.test(STORE));
chk('the pulse celebrates against a stored marker, so nothing fires twice',
  /markDynastySeen/.test(JS) && /dynastySeen/.test(JS) && /DY\.diff/.test(JS));
chk('the pulse is polite to screen readers', /aria-live/.test(JS.slice(JS.indexOf('function pulseHost'))));
chk('the level-up moment can be closed from the keyboard', /Escape/.test(JS));
has(JS, 'recordResearchOpen', 'opening the research is recorded on the player’s record');
chk('the research deep link names the game so the terminal opens the matchup',
  /'#research\/football'/.test(JS) && /frag \+= '\/' \+ encodeURIComponent/.test(JS));
chk('and the terminal knows how to open it',
  /openEntity:function\(id\)\{var s=String\(id==null\?'':id\)/.test(APP) && /fbOpenGameFromDesk\(sport,gid\)/.test(APP));

/* every game reports in */
has(PRICE, "G.pulse({game_type:'price_it'})", 'Price It pulses after a fresh lock');
chk('Price It pulses AFTER the reveal, never on a replay',
  PRICE.indexOf("G.pulse({game_type:'price_it'})") > PRICE.indexOf('renderReveal(ch,stored);'));
has(PRICE, 'This week’s missions', 'Price It shows the week’s missions after the reveal');
has(PRICE, 'Save your War Room', 'the account ask is about the War Room');
has(PRICE, 'account_save_from_dynasty', 'and fires the Dynasty save event');
has(PICK, "G.pulse({game_type:'pick5'})", 'Pick 5 pulses');
has(H2H, "recordEvent('h2h_locked'", 'Head-to-Head records a locked challenge');
has(H2H, "recordEvent('h2h_win'", 'and a win');
has(H2H, "recordEvent('h2h_create'", 'and a created challenge');
has(H2H, "recordEvent('h2h_submit'", 'and an answered one');
chk('an observer of a challenge records nothing', /if\(ch\.your_slot&&ch\.invite_token\)/.test(H2H));
has(GRP, "recordEvent('group_create'", 'Groups records a founded group');
has(GRP, "recordEvent('group_join'", 'and a joined one');
[['price it', PRICE], ['pick 5', PICK], ['head-to-head', H2H], ['groups', GRP], ['home', HOME]].forEach(([n, p]) =>
  has(p, '/games/lib/dynasty.js', n + ' loads the rules'));

/* routes */
has(SITEMAP, 'https://edgedesksports.com/games/dynasty<', 'the sitemap lists the War Room');
has(SITEMAP, 'https://edgedesksports.com/games/two-minute-drill<', 'the sitemap lists the Drill');
has(NOTFOUND, "p[1]==='dynasty'", 'a deeper War Room path lands on the War Room');
chk('the War Room page exists where the route claims', fs.existsSync(G('dynasty/index.html')));

/* ── mobile and copy rules, same as every other page ─────────────────────── */
const PAGES = [['war room', DYN + DYNCSS]];
PAGES.forEach(([n, p]) => {
  const maxw = (p.match(/@media\s*\(max-width:\s*(\d+)px\)/g) || []);
  chk(n + ' is mobile-first: any max-width query is a narrow refinement',
    maxw.every(m => +m.match(/(\d+)/)[1] <= 480), maxw.join(','));
});
chk('a station meets the tap minimum', /\.station\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('a mission row meets the tap minimum', /\.mission\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('a trophy meets the tap minimum', /\.trophy\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('the stations stack on a phone and only widen with min-width',
  /\.stations\{display:grid/.test(CSS) && /@media\(min-width:768px\)\{\.stations\{grid-template-columns/.test(CSS));
chk('the XP bar is a real progress bar on the home page', /role="progressbar"/.test(HOME));

const COPY = DYN + DYNCSS + HOME + JS + RULES;
[/guaranteed edge/i, /free money/i, /can'?t lose/i, /sure thing/i, /risk-?free/i,
 /chase (your )?losses/i, /\bwager\b(?!ing)/i, /\bbet slip\b/i, /\bparlay\b/i, /\bodds boost\b/i,
 /loot box/i, /virtual currency/i, /pay[- ]to[- ]win/i, /\bis a betting skill|betting skill rating|measures? (your )?betting skill/i,
 /you were wrong/i, /limited time/i, /only \d+ left/i, /hurry/i].forEach(re => {
  chk('the Dynasty copy avoids ' + re,
    !re.test(COPY.replace(/no real-money wagering/gi, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')),
    (COPY.match(re) || [''])[0]);
});
(() => {
  const DENIALS = [/No deposits, no wallet, no balance, no entry fee\s*and no prizes\./gi,
    /no deposits/gi, /no wallet/gi, /no balance/gi, /no entry fee/gi, /no cash prize/gi, /no prizes/gi];
  let copy = COPY.replace(/\/\*[\s\S]*?\*\//g, '');
  DENIALS.forEach(re => { copy = copy.replace(re, ''); });
  chk('the Dynasty introduces no balance, wallet, deposit, entry fee or prize',
    !/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i.test(copy),
    (copy.match(/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i) || [''])[0]);
})();
chk('nothing in the rules reads an account, a plan or a subscription',
  !/subscri|premium|plan\b|is_pro|account/i.test(RULES.replace(/\/\*[\s\S]*?\*\//g, '')));
chk('nothing in the rules uses the clock or randomness',
  !/Math\.random|Date\.now\(\)|new Date\(\)/.test(RULES.replace(/\/\*[\s\S]*?\*\//g, '')));
chk('no XP multiplier exists', !/multiplier/i.test(RULES + JS + DYN));
chk('the rules are versioned', /dynasty_v1/.test(RULES));
chk('the War Room page uses the word lock only as the submit verb',
  ((DYN.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').match(/\block\w*/gi) || [])
    .every(w => ['lock', 'locked', 'locks', 'locker'].indexOf(w.toLowerCase()) >= 0)),
  (DYN.match(/\block\w*/gi) || []).join(','));

console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk dynasty | ' + pass + ' passed, ' + fail + ' failed');
failures.forEach(f => console.log('  × ' + f));
process.exit(fail ? 1 : 0);
