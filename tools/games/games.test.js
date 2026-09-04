#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK GAMES — the suite.

   What it holds down, in the order a player meets it:

     1  the scoring rule is the DOCUMENTED one, and is deterministic
     2  the football week boundary is the one the README states
     3  anonymous persistence survives, and a challenge cannot be scored twice
     4  Pick 5 submits once and settles from supplied results only
     5  challenge selection is deterministic, total, and prefers playable games
     6  the leaderboard never invents a player
     7  malformed and missing data degrade instead of throwing
     8  the public routes exist, are crawlable, and carry canonical metadata
     9  every page is mobile-first and thumb-friendly
    10  the funnel is instrumented on the EXISTING analytics property
    11  the research deep links point into the real terminal
    12  the responsible-product language is present and the forbidden language
        is absent

   Run: node tools/games/games.test.js
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

/* a localStorage the store can actually use */
let MEM = {};
global.localStorage = {
  getItem: k => (MEM[k] == null ? null : MEM[k]),
  setItem: (k, v) => { MEM[k] = String(v); },
  removeItem: k => { delete MEM[k]; }
};
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));

const W = require(G('lib/week.js'));
const SC = require(G('lib/scoring.js'));
const CH = require(G('lib/challenge.js'));
const RS = require(G('lib/research_state.js'));
const ST = require(G('lib/store.js'));
const LB = require(G('lib/leaderboard.js'));

/* ═══ 1. SCORING ═══════════════════════════════════════════════════════════ */

/* the exact bands the product documents */
[[0, 100], [0.5, 100], [1.0, 100], [1.5, 90], [2.0, 90], [2.5, 80], [3.0, 80],
 [3.5, 70], [4.0, 70], [4.5, 60], [5.0, 60]].forEach(([d, want]) => {
  eq('published band: ' + d + ' pts away scores ' + want, SC.scoreForDistance(d), want);
});
eq('the score floors at zero, never negative', SC.scoreForDistance(40), 0);
eq('exactly 11 points away is zero', SC.scoreForDistance(11), 0);
eq('a distance is never negative', SC.distance(-3, 4), 7);
eq('float noise does not cost a band', SC.scoreForDistance(1.0000000000000002), 100);
eq('distances are stored to a tenth', SC.distance(-6.5, -8.2), 1.7);
chk('a nonsense distance scores nothing', SC.scoreForDistance(NaN) === null
  && SC.scoreForDistance(-1) === null);

/* determinism: the same inputs, a thousand times, one answer */
(() => {
  const a = SC.evaluate({ userSpread: -6.5, edgedesk: -8.2, market: -10.5 });
  let stable = true;
  for (let i = 0; i < 1000; i++) {
    const b = SC.evaluate({ userSpread: -6.5, edgedesk: -8.2, market: -10.5 });
    if (JSON.stringify(a) !== JSON.stringify(b)) { stable = false; break; }
  }
  chk('scoring is deterministic across repeated evaluation', stable);
})();

/* the worked example from the product brief */
(() => {
  const r = SC.evaluate({ userSpread: -6.5, edgedesk: -8.2, market: -10.5 });
  eq('brief example: scores 90 against EdgeDesk', r.score, 90);
  eq('brief example: 1.7 points from EdgeDesk', r.distance_to_edgedesk, 1.7);
  eq('brief example: 4.0 points from the market', r.distance_to_market, 4);
  eq('brief example: the benchmark is EdgeDesk', r.benchmark, 'edgedesk');
  eq('brief example: model-vs-market rides along', r.edgedesk_vs_market, 2.3);
  eq('every result is stamped with the scoring version', r.scoring_version, 'price_it_v1');
})();

/* benchmark fallbacks never silently score against nothing */
eq('with no EdgeDesk price it falls back to the market',
  SC.evaluate({ userSpread: -3, edgedesk: null, market: -5 }).benchmark, 'market');
eq('with neither price it refuses rather than scoring',
  SC.evaluate({ userSpread: -3, edgedesk: null, market: null }).ok, false);
eq('the reserved closing benchmark does not score against nothing in V1',
  SC.evaluate({ userSpread: -3, edgedesk: -5, benchmark: 'close' }).benchmark, 'edgedesk');
chk('the closing-line benchmark is declared for later', SC.BENCHMARKS.indexOf('close') >= 0);

/* the comparison names a side and never calls the player wrong */
(() => {
  const s = SC.compare(-6.5, -8.2, 'EdgeDesk', 'Auburn', 'Baylor');
  has(s, 'Baylor', 'the comparison names the side the player favoured');
  has(s, '1.7', 'the comparison states the distance');
  lacks(s, 'wrong', 'the comparison never says the player is wrong');
  eq('an exact match is described as agreement',
    SC.compare(-7, -7, 'EdgeDesk', 'A', 'B'), 'You priced this exactly where EdgeDesk does.');
})();
['dead_on', 'close', 'near', 'apart', 'far'].forEach(k => {
  chk('band ' + k + ' exists', [100, 85, 65, 40, 10].some(s => SC.band(s).key === k));
});

/* ═══ 2. THE WEEK BOUNDARY ════════════════════════════════════════════════ */
eq('the boundary is Tuesday', W.BOUNDARY.dow, 2);
eq('the boundary is 07:00 UTC', W.BOUNDARY.hour_utc, 7);
eq('a Tuesday one minute early belongs to the old week',
  W.weekKey(Date.parse('2026-09-08T06:59:00Z')), '2026-09-01');
eq('a Tuesday at the boundary starts the new week',
  W.weekKey(Date.parse('2026-09-08T07:00:00Z')), '2026-09-08');
eq('a Saturday sits in its own week',
  W.weekKey(Date.parse('2026-09-05T20:00:00Z')), '2026-09-01');
eq('a Monday night game still belongs to that week',
  W.weekKey(Date.parse('2026-09-07T23:00:00Z')), '2026-09-01');
chk('week keys sort lexicographically', '2026-09-01' < '2026-09-08');
chk('the same week is the same week',
  W.sameWeek(Date.parse('2026-09-03T00:00:00Z'), Date.parse('2026-09-06T00:00:00Z')));
chk('days left never goes negative', W.daysLeft(Date.parse('2026-09-08T06:59:00Z')) >= 0);
eq('consecutive days differ by one', W.dayDiff('2026-09-03', '2026-09-04'), 1);
eq('a malformed day key yields nothing', W.dayDiff('nope', '2026-09-04'), null);

/* ═══ 3. ANONYMOUS PERSISTENCE ════════════════════════════════════════════ */
function freshStore() { MEM = {}; ST.reset(); }
const T0 = Date.parse('2026-09-04T18:00:00Z');

freshStore();
(() => {
  const rec = ST.recordPriceIt({ game_id: '1', slug: 'a-b', home_team: 'Auburn', away_team: 'Baylor',
    user_spread: -6.5, edgedesk_spread: -8.2, market_spread: null, distance: 1.7, score: 90,
    benchmark: 'edgedesk', scoring_version: 'price_it_v1' }, T0);
  eq('a completed challenge is stored', rec.score, 90);
  eq('the result is filed under its football week', rec.week, '2026-09-01');
  eq('a first play starts the streak at one', ST.liveStreak(null, T0), 1);
  eq('the weekly score reflects it', ST.weeklyScore(T0), 90);

  /* REPEAT-PLAY PREVENTION: the same challenge cannot be scored twice */
  const again = ST.recordPriceIt({ game_id: '1', user_spread: 0, edgedesk_spread: -8.2,
    distance: 8.2, score: 0 }, T0);
  eq('replaying a challenge returns the ORIGINAL result', again.score, 90);
  eq('a replay does not inflate the play count', ST.priceItRecord().played, 1);
  eq('a replay does not inflate the weekly score', ST.weeklyScore(T0), 90);
  chk('the stored result is findable by game id', ST.priceItResult('1').score === 90);
  eq('an unplayed challenge has no stored result', ST.priceItResult('nope'), null);
})();

/* the streak: consecutive days advance it, a gap resets it */
freshStore();
(() => {
  const D = d => Date.parse('2026-09-0' + d + 'T18:00:00Z');
  ST.recordPriceIt({ game_id: 'a', score: 10, distance: 1 }, D(1));
  ST.recordPriceIt({ game_id: 'b', score: 10, distance: 1 }, D(2));
  ST.recordPriceIt({ game_id: 'c', score: 10, distance: 1 }, D(3));
  eq('three consecutive days is a streak of three', ST.liveStreak(null, D(3)), 3);
  ST.recordPriceIt({ game_id: 'd', score: 10, distance: 1 }, D(3));
  eq('two plays in one day do not double the streak', ST.liveStreak(null, D(3)), 3);
  ST.recordPriceIt({ game_id: 'e', score: 10, distance: 1 }, D(6));
  eq('a missed day resets the streak to one', ST.liveStreak(null, D(6)), 1);
  eq('the best streak is remembered', ST.read().streak.best, 3);
  eq('a stale streak displays as broken, not as live',
    ST.liveStreak(null, Date.parse('2026-09-20T18:00:00Z')), 0);
})();

/* the Price It record line */
freshStore();
(() => {
  ST.recordPriceIt({ game_id: 'x', score: 100, distance: 1 }, T0);
  ST.recordPriceIt({ game_id: 'y', score: 80, distance: 3 }, T0);
  const r = ST.priceItRecord();
  eq('the record counts games played', r.played, 2);
  eq('the record averages the distance', r.avg_distance, 2);
  eq('the record averages the score', r.avg_score, 90);
  eq('an untouched record averages nothing', (freshStore(), ST.priceItRecord().avg_distance), null);
})();

/* attribution: first touch wins and is never overwritten */
freshStore();
(() => {
  const a = ST.captureAttribution('?utm_source=x&utm_medium=social&utm_campaign=c1', '', T0);
  eq('the campaign is captured', a.utm_source, 'x');
  const b = ST.captureAttribution('?utm_source=later', '', T0);
  eq('a later touch does not overwrite the first', b.utm_source, 'x');
  freshStore();
  const c = ST.captureAttribution('', 'https://news.example.com/post', T0);
  eq('an external referrer is captured when no campaign is present', c.referrer_host, 'news.example.com');
  freshStore();
  eq('our own referrer is not treated as an acquisition source',
    ST.captureAttribution('', 'https://edgedesksports.com/', T0), null);
})();

/* the account ask waits for real engagement */
freshStore();
eq('a brand-new visitor is not asked to sign up', ST.engaged(), false);
ST.recordPriceIt({ game_id: '1', score: 10, distance: 1 }, T0);
eq('one game is still not enough to ask', ST.engaged(), false);
ST.recordPriceIt({ game_id: '2', score: 10, distance: 1 }, T0);
eq('after two the ask is fair', ST.engaged(), true);

/* the whole anonymous history can be handed to an account in one object */
(() => {
  const x = ST.exportForAccount();
  ['streak', 'weeks', 'price_it', 'pick5'].forEach(k =>
    chk('the account export carries ' + k, x[k] != null));
  lacks(JSON.stringify(x), 'display_name', 'the export carries no identity of its own');
})();

/* a browser that refuses storage still plays */
(() => {
  const real = global.localStorage;
  global.localStorage = { getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  let ok = true;
  try {
    ST.reset();
    ST.recordPriceIt({ game_id: 'z', score: 50, distance: 5 }, T0);
    ok = ST.priceItResult('z').score === 50;
  } catch (e) { ok = false; }
  chk('play survives a browser that blocks storage', ok);
  eq('and the page can tell the player it is unsaved', ST.storageWorks(), false);
  global.localStorage = real;
})();

/* ═══ 4. PICK 5 ═══════════════════════════════════════════════════════════ */
freshStore();
(() => {
  const wk = '2026-09-01';
  const sels = ['g1', 'g2', 'g3', 'g4', 'g5'].map((g, i) => ({
    game_id: g, slug: g, pick: i % 2 ? 'home' : 'away',
    home_team: 'H' + i, away_team: 'A' + i, market_spread: -3 }));
  const card = ST.submitPick5(wk, sels, T0);
  eq('a card locks five selections', card.selections.length, 5);
  chk('a submitted card is stamped', !!card.submitted_at);
  eq('a card is one per week — resubmitting returns the first',
    ST.submitPick5(wk, [], T0).selections.length, 5);
  eq('submitting a card counts toward the streak', ST.liveStreak(null, T0), 1);

  /* SETTLEMENT comes from supplied outcomes, never from a local guess */
  const settled = ST.settlePick5(wk, { g1: 'away', g2: 'away', g3: 'away', g4: 'home', g5: 'push' });
  eq('correct sides are counted', settled.correct, 3);
  eq('a push is not a decision', settled.decided, 4);
  eq('a fully-graded card is not marked settled while one game pushes', settled.settled, false);
  eq('one point per correct side lands in the weekly score', ST.weeklyScore(T0), 3);
  eq('the all-time record reads as wins and losses', ST.pick5Record().label, '3–1');
  /* settlement arrives in pieces: re-settling the SAME results must not
     inflate the record, and a late result must still be counted once */
  ST.settlePick5(wk, { g1: 'away', g2: 'away', g3: 'away', g4: 'home', g5: 'push' });
  eq('re-settling the same results does not double-count', ST.pick5Record().correct, 3);
  eq('and does not double-count the decisions', ST.pick5Record().decided, 4);
  const late = ST.settlePick5(wk, { g5: 'away' });
  eq('a late result is counted exactly once', ST.pick5Record().correct, 4);
  eq('and the card is complete once every game has landed', late.settled, true);
  eq('the card totals are recounted, never accumulated', late.decided, 5);
  eq('an unknown week settles nothing', ST.settlePick5('1999-01-01', {}), null);
})();

/* ═══ 5. CHALLENGE SELECTION ══════════════════════════════════════════════ */
function mk(o) {
  return Object.assign({ game_id: 'g', home_team: 'Home', away_team: 'Away',
    kickoff: '2099-01-01 12:00', status: 'PREDICTED', edgedesk_spread: -7,
    market_spread: null, confidence: 50, p4: false, both_fbs: true, slug: 'away-home' }, o);
}
eq('a game with no projection is unplayable',
  CH.playability(mk({ edgedesk_spread: null })) < 0, true);
eq('a game the engine refused to price is unplayable',
  CH.playability(mk({ status: 'INSUFFICIENT_DATA' })) < 0, true);
chk('a market number outranks everything else',
  CH.playability(mk({ market_spread: -7, confidence: 0, p4: false }))
  > CH.playability(mk({ market_spread: null, confidence: 100, p4: true })));
chk('among market-less games, confidence decides',
  CH.playability(mk({ confidence: 90 })) > CH.playability(mk({ confidence: 20 })));
chk('a Power 4 team is preferred over one nobody recognises',
  CH.playability(mk({ p4: true })) > CH.playability(mk({ p4: false })));

(() => {
  const pool = [
    mk({ game_id: '3', slug: 's3', confidence: 20 }),
    mk({ game_id: '1', slug: 's1', confidence: 90, market_spread: -3 }),
    mk({ game_id: '2', slug: 's2', confidence: 60 })
  ];
  const a = CH.rank(pool).map(r => r.game_id).join(',');
  const b = CH.rank(pool.slice().reverse()).map(r => r.game_id).join(',');
  eq('ranking is total and order-independent', a, b);
  eq('the market-carrying game leads the board', a.split(',')[0], '1');
})();

(() => {
  const past = mk({ game_id: 'p', slug: 'sp', kickoff: '2020-01-01 12:00' });
  const soon = mk({ game_id: 'f', slug: 'sf', kickoff: '2099-01-01 12:00' });
  const live = CH.playable([past, soon], Date.parse('2026-09-04T00:00:00Z'));
  eq('a kicked-off game leaves the board', live.length, 1);
  eq('and the upcoming one stays', live[0].game_id, 'f');
})();

(() => {
  const pool = [mk({ game_id: '1', slug: 'a' }), mk({ game_id: '2', slug: 'b' }),
    mk({ game_id: '3', slug: 'c' })];
  const d1 = CH.featured(pool, '2026-09-04'), d1b = CH.featured(pool, '2026-09-04');
  eq('today’s challenge is a pure function of the day', d1.game_id, d1b.game_id);
  const days = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']
    .map(d => CH.featured(pool, d).game_id);
  chk('the featured challenge rotates across days', new Set(days).size > 1, days.join(','));
  eq('an empty board features nothing', CH.featured([], '2026-09-04'), null);
})();

/* A cold visitor's FIRST matchup decides whether they play at all, so the
   daily rotation must draw from the STRONGEST games — not from the tail of the
   board where the model itself does not trust its own number. */
(() => {
  const strong = [], weak = [];
  for (let i = 0; i < CH.FEATURE_POOL; i++)
    strong.push(mk({ game_id: 'S' + i, slug: 's' + i, confidence: 80, p4: true, market_spread: -3 }));
  for (let i = 0; i < 40; i++)
    weak.push(mk({ game_id: 'W' + i, slug: 'w' + i, confidence: 5, p4: false }));
  const pool = weak.concat(strong);
  const picks = [];
  for (let d = 1; d <= 60; d++)
    picks.push(CH.featured(pool, '2026-' + String(1 + (d % 12)).padStart(2, '0')
      + '-' + String(1 + (d % 28)).padStart(2, '0')).game_id);
  chk('the daily challenge is never drawn from the weak tail of the board',
    picks.every(id => id[0] === 'S'), Array.from(new Set(picks)).join(','));
  chk('and it still rotates widely within the strong games',
    new Set(picks).size >= Math.min(8, CH.FEATURE_POOL),
    new Set(picks).size + ' distinct');
})();

/* Sequential day keys are the ONLY input this hash ever gets, so its low bits
   must move between them. A weak mix silently freezes the rotation for days. */
(() => {
  const buckets = new Set();
  for (let d = 1; d <= 28; d++)
    buckets.add(CH.hash('2026-09-' + String(d).padStart(2, '0')) % 12);
  chk('the day hash spreads consecutive dates across the wheel',
    buckets.size >= 8, buckets.size + ' of 12 buckets in a month');
  const b2 = new Set();
  for (let d = 1; d <= 40; d++) b2.add(CH.hash('day-' + d) % 7);
  chk('and across a differently-shaped key too', b2.size >= 6, b2.size + ' of 7');
  eq('the hash is stable for a given key', CH.hash('2026-09-04'), CH.hash('2026-09-04'));
})();

eq('a share slug resolves back to its challenge',
  CH.bySlug([mk({ slug: 'baylor-auburn', game_id: '9' })], 'baylor-auburn').game_id, '9');
eq('a game id resolves too, so an old link survives a rebuild',
  CH.bySlug([mk({ slug: 'x', game_id: '9' })], '9').game_id, '9');
eq('an unknown slug resolves to nothing', CH.bySlug([mk({})], 'nope'), null);
eq('slugs are away-then-home', CH.baseSlug('Baylor', 'Auburn'), 'baylor-auburn');
eq('punctuation is stripped from a slug', CH.baseSlug('Miami (FL)', 'Ohio State'), 'miami-fl-ohio-state');
eq('an empty team still yields a usable token', CH.teamSlug(''), 'team');

(() => {
  const pool = [];
  for (let i = 0; i < 9; i++) pool.push(mk({ game_id: 'm' + i, slug: 'm' + i, market_spread: -3 }));
  pool.push(mk({ game_id: 'n', slug: 'n', market_spread: null }));
  const five = CH.pickFive(pool, '2026-09-01');
  eq('Pick 5 offers exactly five', five.length, 5);
  chk('every Pick 5 game carries a spread to pick against',
    five.every(r => r.market_spread != null));
  eq('Pick 5 is deterministic',
    CH.pickFive(pool, '2026-09-01').map(r => r.game_id).join(','), five.map(r => r.game_id).join(','));
  eq('with no priced game Pick 5 offers none, rather than padding',
    CH.pickFive([mk({ market_spread: null })], '2026-09-01').length, 0);
})();

/* ═══ 6. THE LEADERBOARD ══════════════════════════════════════════════════ */
(async () => {
  LB.configure(null, null);
  const r = await LB.top('2026-09-01', 10);
  eq('an undeployed leaderboard is unavailable, not broken', r.available, false);
  eq('and it returns no rows rather than invented ones', r.rows.length, 0);
  eq('and it says why', r.reason, 'not_configured');
  eq('nobody has a rank on an empty board', LB.rankOf([], 'me'), null);
  eq('a player absent from the board has no rank',
    LB.rankOf([{ display_name: 'other', score: 5 }], 'me'), null);
  eq('a player on the board has their position',
    LB.rankOf([{ display_name: 'a' }, { display_name: 'me' }], 'me'), 2);

  /* a failing network resolves to the empty state and never throws */
  const realFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error('offline'));
  LB.configure('https://example.test', 'key');
  const r2 = await LB.top('2026-09-01', 10);
  eq('an unreachable leaderboard degrades to the empty state', r2.available, false);
  eq('and it never throws at the page', r2.rows.length, 0);
  global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve('not an array') });
  const r3 = await LB.top('2026-09-01', 10);
  eq('a malformed leaderboard payload is refused', r3.available, false);
  global.fetch = realFetch;

  finish();
})();

/* ═══ 7-12. THE SHIPPED FILES ═════════════════════════════════════════════ */
const HOME = fs.readFileSync(G('index.html'), 'utf8');
const PRICE = fs.readFileSync(G('price-it/index.html'), 'utf8');
const PICK = fs.readFileSync(G('pick-5/index.html'), 'utf8');
const CSS = fs.readFileSync(G('games.css'), 'utf8');
const JS = fs.readFileSync(G('games.js'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const ROBOTS = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
const PAGES = [['games home', HOME], ['price it', PRICE], ['pick 5', PICK]];

/* ── 7. malformed and missing data ─────────────────────────────────────── */
eq('a challenge with no context still renders context-free',
  CH.playability(mk({ context: null })) > 0, true);
chk('the artifact is refused if its schema is not the one we wrote',
  JS.indexOf("j.schema !== 'edgedesk_games_challenges_v1'") >= 0);
chk('a challenge fetch failure is caught on every page',
  PAGES.every(([n, p]) => /\.catch\(/.test(p)));
PAGES.forEach(([n, p]) => {
  chk(n + ' tells the player when the board cannot load',
    /could not be loaded/.test(p));
});
chk('a missing market renders as an absence, not as zero',
  PRICE.indexOf('no book number yet') >= 0);
chk('Pick 5 refuses to offer picks it cannot price',
  PICK.indexOf('nothing to pick') >= 0);

/* ── 8. routes, crawlability, metadata ─────────────────────────────────── */
[['games home', HOME, 'https://edgedesksports.com/games'],
 ['price it', PRICE, 'https://edgedesksports.com/games/price-it'],
 ['pick 5', PICK, 'https://edgedesksports.com/games/pick-5']].forEach(([n, p, url]) => {
  has(p, '<link rel="canonical" href="' + url + '">', n + ' declares its canonical URL');
  has(p, 'name="robots" content="index,follow"', n + ' is crawlable');
  has(p, 'property="og:title"', n + ' carries an Open Graph title');
  has(p, 'property="og:description"', n + ' carries an Open Graph description');
  has(p, 'property="og:url" content="' + url + '"', n + ' carries its Open Graph URL');
  has(p, 'name="twitter:card"', n + ' carries a Twitter card');
  chk(n + ' has a title', /<title>[^<]{10,}<\/title>/.test(p));
  chk(n + ' has a meta description', /name="description" content="[^"]{40,}"/.test(p));
  lacks(p, 'noindex', n + ' does not block crawlers');
});
has(HOME, '<title>EdgeDesk Games | Free Football Prediction Games</title>',
  'the home page title is the one the brief specifies');
['/games', '/games/price-it', '/games/pick-5'].forEach(u => {
  has(SITEMAP, 'https://edgedesksports.com' + u + '<', 'the sitemap lists ' + u);
});
chk('the sitemap does not enumerate individual matchups',
  SITEMAP.indexOf('?g=') < 0 && !/price-it\/[a-z]+-/.test(SITEMAP));
has(ROBOTS, 'Allow: /games', 'robots.txt admits crawlers to Games');
has(ROBOTS, 'Sitemap: https://edgedesksports.com/sitemap.xml', 'robots.txt points at the sitemap');
has(NOTFOUND, "p[0]==='games'", 'the static host routes /games/* share links');
has(NOTFOUND, "'/games/'+g+'/?g='", 'a pretty share link becomes the canonical query form');
chk('the games pages exist where the routes claim',
  fs.existsSync(G('index.html')) && fs.existsSync(G('price-it/index.html'))
  && fs.existsSync(G('pick-5/index.html')));
chk('the challenge artifact ships with the site', fs.existsSync(G('data/challenges.json')));

/* ── 9. mobile first ───────────────────────────────────────────────────── */
PAGES.forEach(([n, p]) => {
  has(p, 'width=device-width', n + ' is responsive');
  has(p, 'viewport-fit=cover', n + ' handles a notched phone');
});
has(CSS, '--tap:48px', 'a thumb-friendly minimum tap target is declared');
chk('the primary button meets the tap minimum', /\.btn\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('the Pick 5 選 buttons meet the tap minimum'.replace('選', ''),
  /\.p5-btn\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('the nudge controls meet the tap minimum', /\.nudge\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('the spread slider has a large touch area', /\.sel-range\{[^}]*height:44px/.test(CSS));
chk('the page body never scrolls sideways', /body\{[^}]*overflow-x:hidden/.test(CSS));
chk('the layout is written mobile-first (min-width queries only)',
  CSS.indexOf('@media(min-width') >= 0);
(() => {
  const maxw = (CSS.match(/@media\(max-width:(\d+)px\)/g) || []);
  chk('any max-width query is a narrow-screen refinement, not the base layout',
    maxw.every(m => +m.match(/(\d+)/)[1] <= 480), maxw.join(','));
})();
chk('motion is disabled for players who ask for less of it',
  CSS.indexOf('prefers-reduced-motion') >= 0);
chk('focus is restyled rather than removed', CSS.indexOf(':focus-visible') >= 0);

/* ── 10. analytics ─────────────────────────────────────────────────────── */
const REQUIRED_EVENTS = ['games_page_view', 'price_it_start', 'price_it_complete',
  'pick5_start', 'pick5_complete', 'result_reveal', 'share_result', 'next_game_click',
  'research_cta_click', 'save_score_cta', 'signup_start_from_games',
  'signup_complete_from_games', 'pricing_view_from_games', 'checkout_start_from_games',
  'subscription_complete_from_games'];
REQUIRED_EVENTS.forEach(e => {
  chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0);
});
const ALL = HOME + PRICE + PICK + JS;
['games_page_view', 'price_it_start', 'price_it_complete', 'pick5_start', 'pick5_complete',
 'result_reveal', 'share_result', 'next_game_click', 'research_cta_click', 'save_score_cta',
 'signup_start_from_games'].forEach(e => {
  chk('the funnel actually fires ' + e, new RegExp("track\\('" + e + "'").test(ALL));
});
PAGES.forEach(([n, p]) => {
  has(p, 'G-1PXVBV53FZ', n + ' reports to the site’s existing analytics property');
});
chk('no second analytics vendor is introduced',
  !/posthog|mixpanel|segment\.com|amplitude|plausible\.io|fathom/i.test(ALL));
['sport', 'game_id', 'game_slug', 'game_type', 'research_state'].forEach(prop => {
  chk('events can carry ' + prop, ALL.indexOf(prop) >= 0);
});
chk('events record whether the player was anonymous', JS.indexOf("identity") >= 0);
['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref'].forEach(k => {
  chk('attribution persists ' + k, fs.readFileSync(G('lib/store.js'), 'utf8').indexOf(k) >= 0);
});
chk('attribution is first-touch and carried onward', JS.indexOf('withAttribution') >= 0);

/* ── 11. the research funnel ───────────────────────────────────────────── */
has(JS, "'#research/football'", 'the deep link opens the football research module');
has(JS, '/app.html', 'the deep link points at the real terminal');
chk('the research link carries the game', /researchUrl/.test(JS) && /game_id/.test(JS));
chk('every page offers a way into the research',
  PAGES.every(([n, p]) => /app\.html|openResearch/.test(p)));
has(PRICE, 'Research this matchup', 'the reveal offers the research CTA the brief specifies');
has(PICK, 'Research this game', 'every Pick 5 matchup links to its research');
has(PRICE, 'EdgeDesk research state', 'the reveal shows the research state');
['PASS', 'REVIEW', 'INVESTIGATE', 'Thin data'].forEach(s => {
  chk('the research states reach the player: ' + s,
    (PRICE + fs.readFileSync(G('lib/research_state.js'), 'utf8')).indexOf(s) >= 0);
});
has(PRICE, 'Why EdgeDesk prices it here', 'the reveal explains the model’s number');

/* ── 12. responsible product language ──────────────────────────────────── */
const REQUIRED_COPY = ['Free to play', 'No real-money wagering', 'No purchase necessary', '21+'];
REQUIRED_COPY.forEach(c => {
  chk('the shared footer states: ' + c, JS.indexOf(c) >= 0);
});
has(JS, '1-800-GAMBLER', 'the footer carries the problem-gambling line');
has(JS, 'research, not picks', 'the footer restates the research posture');
PAGES.forEach(([n, p]) => {
  chk(n + ' shows the free-to-play line above the fold or on the entry control',
    /Free to play|free to play|no real-money|No real-money/.test(p));
});
/* the forbidden vocabulary. "lock my price" is allowed and is the ONLY
   permitted use of the word, because it describes submitting an answer. */
const COPY = HOME + PRICE + PICK + JS + CSS;
[/guaranteed edge/i, /free money/i, /can'?t lose/i, /sure thing/i, /risk-?free/i,
 /chase (your )?losses/i, /\bwager\b(?!ing)/i].forEach(re => {
  chk('the copy avoids ' + re, !re.test(COPY.replace(/no real-money wagering/gi, '')),
    (COPY.match(re) || [''])[0]);
});
(() => {
  const locks = (COPY.match(/\block\w*/gi) || []).map(s => s.toLowerCase());
  const allowed = new Set(['lock', 'locked', 'locks', 'locker']);
  chk('the word "lock" is only ever about submitting an answer',
    locks.every(l => allowed.has(l)), locks.join(','));
  chk('"lock" appears as the submit action', /lock my price/i.test(COPY));
})();
/* The product must not HAVE a balance, wallet or entry fee. Saying plainly
   that it has none is the opposite failure, so the disclaimer that denies them
   is removed before this looks for any real one. */
(() => {
  const DENIALS = [
    /No deposits, no wallet, no balance, no entry fee\s*and no prizes\./gi,
    /no deposits/gi, /no wallet/gi, /no balance/gi, /no entry fee/gi, /no cash prize/gi
  ];
  let copy = COPY;
  DENIALS.forEach(re => { copy = copy.replace(re, ''); });
  chk('the product has no balance, wallet, deposit or entry fee of its own',
    !/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i.test(copy),
    (copy.match(/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i) || [''])[0]);
  chk('and it says so plainly', /no wallet/i.test(COPY) && /no real-money wagering/i.test(COPY));
})();
chk('games are never paywalled', !/subscribe to play|upgrade to play|unlock.*\$/i.test(COPY));
chk('a disagreement is never sold as an edge',
  /not (a betting edge|evidence of an edge)|is not a betting edge/i.test(COPY));
chk('the model’s honesty about the closing line reaches the player',
  /does not beat the closing line/i.test(COPY));
chk('the leaderboard never fabricates players',
  HOME.indexOf('No leaderboard results yet. Be the first.') >= 0);

/* ── the artifact the pages actually read ──────────────────────────────── */
(() => {
  const A = JSON.parse(fs.readFileSync(G('data/challenges.json'), 'utf8'));
  eq('the artifact declares its schema', A.schema, 'edgedesk_games_challenges_v1');
  chk('the artifact records which model produced it', !!A.model_version);
  chk('the artifact records which scoring rule applies', !!A.scoring_version);
  eq('the artifact’s scoring version matches the shipped rule',
    A.scoring_version, SC.SCORING_VERSION);
  eq('the artifact’s thresholds match the engine’s',
    JSON.stringify(A.thresholds), JSON.stringify(RS.thresholds()));
  chk('the artifact carries challenges', A.challenges.length > 0);
  chk('every challenge has a price to score against',
    A.challenges.every(c => c.edgedesk_spread != null));
  chk('every challenge has a slug', A.challenges.every(c => !!c.slug));
  chk('slugs are unique', new Set(A.challenges.map(c => c.slug)).size === A.challenges.length);
  chk('every challenge names both teams',
    A.challenges.every(c => c.home_team && c.away_team));
  chk('every challenge carries a research state',
    A.challenges.every(c => ['PASS', 'REVIEW', 'INVESTIGATE', 'THIN', 'NO_MARKET']
      .indexOf(c.research_state) >= 0));
  chk('the research state agrees with the shipped classifier',
    A.challenges.every(c => RS.classify(c.confidence, c.spread_gap).key === c.research_state));
  chk('no challenge carries more than four research factors',
    A.challenges.every(c => !c.factors || c.factors.length <= 4));
  chk('the board states that the model is unproven', A.challenges.every(c => c.unproven === true));
  chk('the artifact states the free-to-play basis', /no real-money wagering/i.test(A.basis));

  /* Pick 5 promises results, so the artifact has to carry the scores that
     settle them. */
  chk('the artifact carries final scores', A.finals && typeof A.finals === 'object');
  chk('every final is a pair of numbers',
    Object.keys(A.finals).every(k => typeof A.finals[k].home_score === 'number'
      && typeof A.finals[k].away_score === 'number'));
  chk('no challenge on the board is already finished',
    A.challenges.every(c => !A.finals[String(c.game_id)]));
})();

/* ── the ATS settlement rule ──────────────────────────────────────────── */
[[-7, 31, 21, 'home'], [-7, 28, 21, 'push'], [-7, 24, 21, 'away'],
 [3, 21, 24, 'push'], [3, 21, 20, 'home'], [-3.5, 24, 21, 'away'],
 [0, 21, 20, 'home'], [0, 20, 20, 'push']].forEach(([sp, hs, as, want]) => {
  eq('a home line of ' + sp + ' with ' + hs + '-' + as + ' settles ' + want,
    SC.atsResult(sp, hs, as), want);
});
eq('a game with no line settles nothing', SC.atsResult(null, 24, 21), null);
eq('a game with no score settles nothing', SC.atsResult(-3, null, 21), null);
chk('the Pick 5 page settles from the artifact’s finals, not from a guess',
  PICK.indexOf('a.finals') >= 0 && PICK.indexOf('SC.atsResult') >= 0);
chk('and it grades against the line the card was picked at',
  PICK.indexOf('sel.market_spread') >= 0);

function finish() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk games | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(f => console.log('  × ' + f));
  process.exit(fail ? 1 : 0);
}
