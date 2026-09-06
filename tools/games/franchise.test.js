#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK GAMES — the franchise layer, on the client.

   What it holds down:

     1  the economy the client SHOWS is the economy the SQL APPLIES — the
        published table, the identity lists, the starters, the attributes
        and the rating weights are pinned to supabase/games_franchise.sql
     2  the level curve is the War Room's
     3  the store keeps a franchise snapshot for one account only, and a
        reward queue that cannot hold the same thing twice
     4  the anonymous envelope previews and exports honestly: capped where
        the server caps, and carrying no identity
     5  player presentation is a pure, escaped function of a row
     6  the client never decides a reward: it asks, queues on failure,
        replays once online, and reads "not deployed" as a state
     7  sign-in writes the terminal's session key and nothing else
     8  the pages, the routes, the shell, the copy rules and the funnel
     9  the trusted worker computes no price and refuses to run blind
    10  the SQL file keeps the repository's conventions
    11  the weekly game, 12 franchise vs franchise, 13 the offseason and
        the facilities, 14 the draft and the market: the constants the
        client shows are the SQL's, the client asks and never decides, the
        pages say what they read

   Run: node tools/games/franchise.test.js
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
global.location = { search: '', pathname: '/games/', origin: 'https://edgedesksports.com' };
global.window = global.window || global;
global.atob = s => Buffer.from(s, 'base64').toString('binary');
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));

const W = require(G('lib/week.js'));
require(G('lib/scoring.js'));
require(G('lib/challenge.js'));
require(G('lib/research_state.js'));
require(G('lib/attribution.js'));
const ST = require(G('lib/store.js'));
const DY = require(G('lib/dynasty.js'));
const S = require(G('lib/social.js'));
const AU = require(G('lib/auth.js'));
const F = require(G('lib/franchise.js'));

const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'games_franchise.sql'), 'utf8');
const JS = fs.readFileSync(G('games.js'), 'utf8');
const CSS = fs.readFileSync(G('games.css'), 'utf8');
const FCSS = fs.readFileSync(G('franchise.css'), 'utf8');
const HOME = fs.readFileSync(G('index.html'), 'utf8');
const PRICE = fs.readFileSync(G('price-it/index.html'), 'utf8');
const PICK = fs.readFileSync(G('pick-5/index.html'), 'utf8');
const DRILL = fs.readFileSync(G('two-minute-drill/index.html'), 'utf8');
const DYN = fs.readFileSync(G('dynasty/index.html'), 'utf8');
const STATUS = fs.readFileSync(G('status/index.html'), 'utf8');
const OFFICE = fs.readFileSync(G('franchise/index.html'), 'utf8');
const ROSTER = fs.readFileSync(G('roster/index.html'), 'utf8');
const GAMEDAY = fs.readFileSync(G('gameday/index.html'), 'utf8');
const TROPHIES = fs.readFileSync(G('trophies/index.html'), 'utf8');
const MARKET = fs.readFileSync(G('market/index.html'), 'utf8');
const CONF = fs.readFileSync(G('conference/index.html'), 'utf8');
const FJS = fs.readFileSync(G('lib/franchise.js'), 'utf8');
const AUTHJS = fs.readFileSync(G('lib/auth.js'), 'utf8');
const LANDING = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const H2H = fs.readFileSync(G('h2h/index.html'), 'utf8');
const SQLTEST = fs.readFileSync(path.join(__dirname, 'sql', 'games_franchise.test.sql'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const README = fs.readFileSync(G('README.md'), 'utf8');
const PUB = fs.readFileSync(G('publish_board.js'), 'utf8');

function fresh() { MEM = {}; ST.reset(); }
const T0 = Date.parse('2026-09-04T18:00:00Z');   /* Friday, week of 2026-09-01 */

/* ═══ 1. THE ECONOMY, PINNED TO THE SQL ═══════════════════════════════════ */
eq('the economy is versioned', F.ECONOMY_VERSION, 'economy_v1');
has(SQL, "'version', 'economy_v1'", 'and the SQL carries the same version');
eq('Price It: 50 XP', F.ECONOMY.price_it.xp, 50);
eq('Pick 5 card: 75 XP and 25 TC', F.ECONOMY.pick5_card.xp + '/' + F.ECONOMY.pick5_card.tc, '75/25');
eq('a correct side: 10 XP and 15 TC', F.ECONOMY.pick5_correct.xp + '/' + F.ECONOMY.pick5_correct.tc, '10/15');
eq('a perfect card: 150 XP and 200 TC', F.ECONOMY.pick5_perfect.xp + '/' + F.ECONOMY.pick5_perfect.tc, '150/200');
eq('the daily drill: 40 XP, 3 TC per correct, capped at 30', F.ECONOMY.drill_daily.xp + '/' + F.ECONOMY.drill_daily.tc_per_correct + '/' + F.ECONOMY.drill_daily.tc_max, '40/3/30');
eq('research: 15 XP, ten a week', F.ECONOMY.research_open.xp + '/' + F.ECONOMY.research_open.cap_per_week, '15/10');
eq('Head-to-Head: 40 XP and 1 CP to play, 20 XP and 2 CP to win',
  [F.ECONOMY.h2h_locked.xp, F.ECONOMY.h2h_locked.cp, F.ECONOMY.h2h_win.xp, F.ECONOMY.h2h_win.cp].join('/'), '40/1/20/2');
eq('the founding grant is 100 TC', F.ECONOMY.founded.tc, 100);
/* every line of the JS table appears, number for number, in the SQL's
   franchise_economy(); if either side changes, this goes red */
Object.keys(F.ECONOMY).forEach(k => {
  const o = F.ECONOMY[k];
  const body = Object.keys(o).map(f => "'" + f + "', " + o[f]).join(', ');
  const re = new RegExp("'" + k + "',\\s*jsonb_build_object\\(" + body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\)");
  chk('the SQL applies the same ' + k + ' line the client shows', re.test(SQL), body);
});
chk('the XP table matches the War Room’s where the kinds overlap',
  F.ECONOMY.price_it.xp === DY.XP.price_it && F.ECONOMY.pick5_card.xp === DY.XP.pick5_card
  && F.ECONOMY.pick5_correct.xp === DY.XP.pick5_correct && F.ECONOMY.drill_daily.xp === DY.XP.drill_daily
  && F.ECONOMY.h2h_locked.xp === DY.XP.h2h_locked && F.ECONOMY.h2h_win.xp === DY.XP.h2h_win
  && F.ECONOMY.research_open.xp === DY.XP.research_open && F.ECONOMY.research_open.cap_per_week === DY.RESEARCH_CAP_PER_WEEK);

/* the derived amounts, the SQL's worked examples */
eq('scouting points: 100 -> 40', F.spForScore(100), 40);
eq('scouting points: 90 -> 37 (31.5 rounds up, as the server’s numeric does)', F.spForScore(90), 37);
eq('scouting points: 60 -> 26', F.spForScore(60), 26);
eq('scouting points: 0 -> 5', F.spForScore(0), 5);
eq('team credits: 100 -> 20', F.tcForScore(100), 20);
eq('team credits: 45 -> 14', F.tcForScore(45), 14);
eq('team credits: 0 -> 10', F.tcForScore(0), 10);
eq('drill credits: 8 of 10 -> 24', F.tcForDrill(8), 24);
eq('drill credits cap at 30', F.tcForDrill(10), 30);
chk('rewardsFor names the same amounts', (() => {
  const r = F.rewardsFor('price_it', { score: 90 });
  return r.xp === 50 && r.sp === 37 && r.tc === 19 && F.rewardsFor('founded').tc === 100 && F.rewardsFor('nope').xp == null;
})());

/* the identity lists, pinned to the SQL's check constraints */
function sqlList(col) {
  const m = SQL.match(new RegExp(col + "\\s+text not null check \\(" + col + " in\\s*\\(([^)]*)\\)"));
  if (!m) return null;
  return m[1].match(/'([a-z_0-9]+)'/g).map(s => s.replace(/'/g, ''));
}
[['logo', F.LOGOS], ['theme', F.THEMES], ['offense', F.OFFENSES], ['defense', F.DEFENSES]].forEach(([col, list]) => {
  const sql = sqlList(col);
  chk('the SQL declares the ' + col + ' options', !!sql, 'no constraint found');
  chk('the client offers exactly the ' + col + ' options the SQL accepts',
    sql && sql.length === list.length && list.every(o => sql.indexOf(o.key) >= 0),
    JSON.stringify(sql) + ' vs ' + JSON.stringify(list.map(o => o.key)));
  chk('every ' + col + ' option has a label', list.every(o => o.label && o.label.length > 1));
});
chk('every theme paints a mark that is visible on the dark ground',
  F.THEMES.every(t => /^#[0-9a-f]{6}$/i.test(t.primary) && /^#[0-9a-f]{6}$/i.test(t.secondary)));
chk('every mark draws', F.LOGOS.every(l => /<path d="M/.test(F.logoSvg(l.key, 32, 'forest'))));

/* the roster plan */
(() => {
  /* the plan is a pool function since Phase 4, so the founding roster and
     the offseason's rookies are drawn from one literal */
  const plan = SQL.match(/function public\.franchise_pool_plan\(\)[\s\S]*?select '(\[[\s\S]*?\])'::jsonb;/);
  chk('the SQL states its roster plan', !!plan);
  chk('and the founding generator and the rookie generator both read it', /plan jsonb := public\.franchise_pool_plan\(\);[\s\S]*plan jsonb := public\.franchise_pool_plan\(\);/.test(SQL));
  const rows = plan ? JSON.parse(plan[1]) : [];
  eq('eleven positions', rows.length, 11);
  rows.forEach(r => {
    eq('starters at ' + r.pos + ' match the client', F.STARTERS[r.pos], r.starters);
    eq('the four visible ratings at ' + r.pos + ' match the client', F.ATTR_ORDER[r.pos].join(','), r.attrs.join(','));
    chk('every attribute at ' + r.pos + ' has a label and a name', r.attrs.every(a => F.ATTRS[a] && F.ATTR_NAMES[a]));
  });
  eq('the plan is 38 players', rows.reduce((t, r) => t + r.targets.length, 0), 38);
  chk('the set_starter function counts the same starters',
    /when 'WR' then 3 when 'OL' then 5 when 'DL' then 4 when 'LB' then 3/.test(SQL) && /when 'CB' then 2 when 'S' then 2 else 1/.test(SQL));
})();
chk('the rating weights the client shows are the ones the SQL computes',
  /0\.30 \* qb \+ 0\.12 \* rb \+ 0\.22 \* wr \+ 0\.08 \* te \+ 0\.28 \* ol/.test(SQL)
  && /0\.30 \* dl \+ 0\.22 \* lb \+ 0\.28 \* cb \+ 0\.20 \* s/.test(SQL)
  && /0\.45 \* off \+ 0\.45 \* def \+ 0\.10 \* st/.test(SQL)
  && F.RATING_WEIGHTS.offense.QB === 0.30 && F.RATING_WEIGHTS.defense.CB === 0.28 && F.RATING_WEIGHTS.overall.special === 0.10);
chk('every archetype the brief names exists in the generator',
  ['Field General', 'Gunslinger', 'Scrambler', 'Power Back', 'Elusive Back', 'Receiving Back', 'Deep Threat', 'Route Runner',
   'Possession', 'Ball Hawk', 'Run Stopper', 'Edge Rusher', 'Coverage', 'Hybrid'].every(a => SQL.indexOf('"name":"' + a + '"') >= 0));
has(SQL, '"id":"ice_veins","name":"Ice Veins","desc":"+4 late-game passing performance"', 'the brief’s example trait exists, with its effect');
/* the achievement names the client shows are the ones the SQL seeds */
Object.keys(F.ACHIEVEMENTS).forEach(id => {
  chk('the SQL seeds the achievement ' + id + ' under the name the client shows',
    new RegExp("\\('" + id + "',\\s+'" + F.ACHIEVEMENTS[id].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'").test(SQL));
});
eq('an unknown achievement id still reads as words', F.achievementName('ten_game_streak'), 'Ten Game Streak');

/* ═══ 2. THE LEVEL CURVE ══════════════════════════════════════════════════ */
chk('the curve is the War Room’s, level for level', (() => {
  for (let L = 1; L <= 30; L++) if (F.xpForLevel(L) !== DY.xpForLevel(L)) return false;
  return F.MAX_LEVEL === DY.MAX_LEVEL;
})());
chk('and a total maps to one level', [0, 99, 100, 700, 2699, 2700, 999999].every(x => F.levelFor(x) === DY.levelFor(x)));
(() => {
  const li = F.levelInfo(120);
  chk('levelInfo says where you are and how far to go', li.level === 2 && li.at === 100 && li.next === 250 && li.remaining === 130 && li.pct === 13);
  chk('the last level has nowhere further to go', F.levelInfo(999999).next === null && F.levelInfo(999999).pct === 100);
})();

/* ═══ 3. THE STORE ════════════════════════════════════════════════════════ */
fresh();
(() => {
  const snap = { franchise: { id: 'f1', name: 'Outlaws' }, resources: { xp: 10 } };
  ST.setFranchiseSnapshot(snap, 'user-a', T0);
  chk('a snapshot is kept for its account', ST.franchiseSnapshot('user-a').franchise.name === 'Outlaws');
  eq('and for nobody else', ST.franchiseSnapshot('user-b'), null);
  eq('and not for a signed-out reader', ST.franchiseSnapshot(null), null);
  chk('the fetch time is recorded', !!ST.franchiseFetchedAt());
  chk('the queue holds one item per key', ST.queueFranchise({ key: 'price_it:1', fn: 'f', args: {} }) === true
    && ST.queueFranchise({ key: 'price_it:1', fn: 'f', args: {} }) === false && ST.franchiseQueue().length === 1);
  chk('an item without a key is refused', ST.queueFranchise({ fn: 'f' }) === false);
  ST.dequeueFranchise('price_it:1');
  eq('a confirmed item leaves the queue', ST.franchiseQueue().length, 0);
  ST.clearFranchise();
  eq('sign-out clears the snapshot', ST.franchiseSnapshot('user-a'), null);
  chk('the anonymous export never carries the franchise cache',
    !('franchise' in ST.exportForAccount()));
})();
/* an envelope written before the franchise key existed */
(() => {
  MEM = {}; ST.reset();
  const old = ST.read(); delete old.franchise; ST.write(old);
  let ok = true;
  try { ok = ST.franchiseSnapshot('u') === null && ST.franchiseQueue().length === 0; } catch (e) { ok = false; }
  chk('an envelope from before the franchise reads as empty rather than throwing', ok);
})();

/* ═══ 4. PREVIEW AND PAYLOAD ══════════════════════════════════════════════ */
fresh();
(() => {
  ST.recordPriceIt({ game_id: 'g1', slug: 'a-b', home_team: 'H', away_team: 'A', user_spread: -6.5, edgedesk_spread: -8.2,
    market_spread: -10.5, distance: 1.7, distance_to_market: 4, score: 90, benchmark: 'edgedesk', scoring_version: 'price_it_v1' }, T0);
  ST.recordPriceIt({ game_id: 'g2', user_spread: -3, edgedesk_spread: -3, distance: 0, score: 100 }, T0);
  ST.recordPriceIt({ game_id: 'g2', user_spread: 0, edgedesk_spread: -3, distance: 3, score: 80 }, T0);   /* replay: counts once */
  ST.submitPick5('2026-09-01', [{ game_id: 'g1', pick: 'home', market_spread: -10.5 }, { game_id: 'g3', pick: 'away', market_spread: 3 }], T0);
  ST.settlePick5('2026-09-01', { g1: 'home' });
  ST.recordDrill({ mode: 'daily', day: W.dayKey(T0), rounds: 10, correct: 8, total: 950, seed: 'daily:x' }, T0);
  ST.recordDrill({ mode: 'free', day: W.dayKey(T0), rounds: 10, correct: 10, total: 1500 }, T0);
  for (let i = 0; i < 12; i++) ST.recordResearchOpen({ game_id: 'r' + i, slug: 'r' + i }, T0);
  ST.setDisplayName('Alice');
  const pv = F.preview(ST.read(), T0);
  eq('the preview is versioned', pv.version, 'economy_v1');
  eq('two unique Price Its, one card, one daily drill', pv.week.games, 4);
  eq('XP: 50+50 + 75 + 10 (one correct) + 40 + 10×15 research', pv.week.xp, 50 + 50 + 75 + 10 + 40 + 150);
  eq('scouting points from the two scores: 37 + 40', pv.week.sp, 77);
  eq('team credits: 19 + 20 + 25 + 15 + 24', pv.week.tc, 19 + 20 + 25 + 15 + 24);
  eq('research is capped at ten a week, as the server caps it', pv.week.research, 12);
  chk('free play earns nothing', pv.week.drills === 1);
  const pay = F.historyPayload(ST.read());
  eq('the payload is versioned', pay.v, 1);
  eq('two Price Its travel', pay.price_it.length, 2);
  chk('each with only what the server needs', pay.price_it.every(r => Object.keys(r).sort().join(',') === 'at,game_id,user_spread'));
  eq('one card travels', pay.pick5.length, 1);
  chk('with its selections', pay.pick5[0].selections.length === 2 && pay.pick5[0].selections[0].pick === 'home');
  eq('one daily drill travels, the free run does not', pay.drill.length, 1);
  eq('research opens travel, all of them — the server caps', pay.research.length, 12);
  lacks(JSON.stringify(pay), 'Alice', 'the payload carries no display name');
  lacks(JSON.stringify(pay), 'score', 'and no client-computed score — the server re-derives every one');
})();
fresh();
(() => {
  const pv = F.preview(ST.read(), T0);
  chk('an empty envelope previews nothing', pv.week.games === 0 && pv.all.xp === 0);
  chk('and exports empty lists', F.historyPayload(ST.read()).price_it.length === 0);
})();

/* ═══ 5. PREPARATION AND PRESENTATION ═════════════════════════════════════ */
(() => {
  const p = F.prep({ price_it: 2, pick5_submitted: true, drills: 1, research: 1, price_it_avg_score: 91 });
  eq('the preparation read is versioned', p.version, 'prep_v1');
  eq('scouting is two of three matchups', p.scouting, 67);
  eq('preparation weights the week’s work and caps at 100', p.preparation, 79);
  eq('market IQ is the average score', p.market_iq, 91);
  const full = F.prep({ price_it: 9, pick5_submitted: true, drills: 5, research: 9, price_it_avg_score: 100 });
  chk('nothing exceeds 100', full.scouting === 100 && full.preparation === 100 && full.market_iq === 100);
  const none = F.prep({});
  chk('an empty week reads as zero, and no IQ rather than a fake one', none.scouting === 0 && none.preparation === 0 && none.market_iq === null);
})();
(() => {
  const p = { id: 'p1', first_name: 'Mason', last_name: 'Crowe <b>x</b>', position: 'QB', jersey: 12, age: 24, overall: 82,
    archetype: 'Field General', dev_tier: 'star', potential: 88, rarity: 'rare',
    ratings: { arm: 88, acc: 84, iq: 92, spd: 67 }, traits: [{ name: 'Ice Veins', desc: '+4 late-game passing performance' }],
    depth: 1, acquired_source: 'founding_roster', acquired_season: 2026, acquired_detail: 'Founder roster', career_stats: {} };
  const kr = F.keyRatings(p);
  eq('a quarterback shows ARM, ACC, IQ, SPD in that order', kr.map(r => r.label).join(' '), 'ARM ACC IQ SPD');
  const card = F.playerCard(p);
  has(card, 'MASON CROWE'.split(' ')[0].charAt(0) + 'ason Crowe', 'the card names the player');
  lacks(card, '<b>x</b>', 'and escapes what it is given');
  has(card, '&lt;b&gt;x&lt;/b&gt;', 'literally');
  has(card, '>82</b><span>OVR</span>', 'the overall is the headline number');
  has(card, 'Ice Veins', 'the trait is on the card');
  has(card, '+4 late-game passing performance', 'with what it does');
  has(card, 'Founder roster · 2026', 'and how the player was acquired');
  has(card, 'Career begins 2026', 'a fresh career says so instead of showing zeros');
  has(card, 'pc-rare', 'rarity is a class the stylesheet tints');
  has(card, 'pc-start', 'a starter is marked');
  chk('a backup is not', F.playerCard(Object.assign({}, p, { depth: 2 })).indexOf('pc-start') < 0);
  chk('the stylesheet tints every rarity', ['common', 'uncommon', 'rare', 'elite'].every(r => r === 'common' || FCSS.indexOf('.pc-' + r) >= 0));
  has(F.playerCard(Object.assign({}, p, { traits: [] })), 'None yet', 'a player without a trait says so');
  const gs = F.groups([Object.assign({}, p, { position: 'WR', depth: 2 }), Object.assign({}, p, { id: 'p2', position: 'QB' }), Object.assign({}, p, { id: 'p3', position: 'WR', depth: 1 })]);
  eq('groups follow the canonical position order', gs.map(g => g.position).join(','), 'QB,WR');
  eq('starters lead within a group', gs[1].players[0].id, 'p3');
  chk('weakest and strongest read the server’s groups', (() => {
    const rt = { groups: { QB: 70, RB: 60, WR: 75 } };
    return F.weakest(rt).position === 'RB' && F.strongest(rt).position === 'WR' && F.weakest(null) === null;
  })());
  chk('a mark is an SVG with the theme’s colours', /<svg class="fr-mark"/.test(F.logoSvg('wolf', 40, 'crimson')) && F.logoSvg('wolf', 40, 'crimson').indexOf('#e2664b') >= 0);
  chk('an unknown mark still draws', /<path/.test(F.logoSvg('nope', 40, 'nope')));
  chk('theme variables are inline-safe', /^--fr-primary:#[0-9a-f]{6};--fr-secondary:#[0-9a-f]{6};--fr-ink:#[0-9a-f]{6}$/i.test(F.themeVars('navy')));
  chk('identity resolves labels from the lists', F.identity({ city: 'Lubbock', name: 'Outlaws', offense: 'air_raid', defense: 'zone' }).offense.label === 'Air Raid');
})();

/* ═══ 6. THE CLIENT NEVER DECIDES A REWARD ════════════════════════════════ */
(() => {
  fresh();
  const realUser = S.user, realRpc = S.rpc, realSigned = S.signedIn;
  let calls = [], answer = null;
  S.rpc = (fn, args) => { calls.push([fn, args]); return Promise.resolve(typeof answer === 'function' ? answer(fn, args) : answer); };
  S.user = () => ({ id: 'user-a', email: 'a@example.com', meta: {} });
  S.signedIn = () => true;

  return (async () => {
    /* signed in, no franchise */
    answer = { ok: true, data: null };
    let r = await F.home();
    chk('home with no franchise caches nothing', r.ok && r.data === null && F.snapshot() === null);
    eq('and the state says so', F.state(), 'no_franchise');
    r = await F.recordPriceIt('g1', -6.5);
    chk('a reward call without a franchise is skipped, not sent', r.skipped === true && calls.filter(c => c[0] === 'franchise_record_price_it').length === 0);

    /* founding */
    answer = { ok: true, data: { franchise: { id: 'f1', name: 'Outlaws', city: 'Lubbock', abbr: 'LBK', logo: 'star', theme: 'forest' }, resources: { xp: 0, level: 1, scouting_points: 0, team_credits: 100, coach_points: 0 }, rating: { overall: 70 } } };
    r = await F.create({ name: 'Outlaws', city: 'Lubbock', abbr: 'lbk', logo: 'star', theme: 'forest', offense: 'air_raid', defense: 'zone' });
    chk('create sends the identity, upper-casing the abbreviation', calls[calls.length - 1][0] === 'franchise_create' && calls[calls.length - 1][1].p_abbr === 'LBK');
    chk('and the answer becomes the snapshot', F.hasFranchise() && F.snapshot().franchise.name === 'Outlaws');
    eq('the state is franchise', F.state(), 'franchise');

    /* a reward: the server's numbers come back, the client shows them */
    answer = { ok: true, data: { ok: true, already: false, result: { score: 90 }, rewards: { xp: 50, sp: 37, tc: 19 }, achievements: [], totals: { xp: 50, level: 1, scouting_points: 37, team_credits: 119, coach_points: 0 } } };
    r = await F.recordPriceIt('g1', -6.5);
    const last = calls[calls.length - 1];
    chk('a Price It sends only the game and the line — never a price to score against',
      last[0] === 'franchise_record_price_it' && Object.keys(last[1]).sort().join(',') === 'p_game_id,p_user_spread');
    chk('and the totals it returns refresh the cached snapshot', F.snapshot().resources.team_credits === 119);
    chk('the panel renders the credit', (() => {
      global.EDGames = null; /* games.js is not loaded here; the panel is tested from its source below */
      return r.ok && r.data.rewards.sp === 37;
    })());

    /* offline: queued, replayed once, dequeued */
    answer = { ok: false, error: 'unreachable', message: 'Could not reach EdgeDesk Games.' };
    r = await F.recordDrill({ day: '2026-09-04', rounds: 10, correct: 8, total: 950 });
    chk('an unreachable server queues the call', r.queued === true && ST.franchiseQueue().length === 1 && ST.franchiseQueue()[0].key === 'drill:2026-09-04');
    r = await F.recordDrill({ day: '2026-09-04', rounds: 10, correct: 8, total: 950 });
    eq('queuing the same day twice is once', ST.franchiseQueue().length, 1);
    answer = { ok: true, data: { ok: true, already: false, rewards: { xp: 40, tc: 24 }, totals: { xp: 90, level: 1, scouting_points: 37, team_credits: 143, coach_points: 0 } } };
    const before = calls.length;
    const s = await F.sync();
    chk('sync replays the queue and dequeues on success', s.replayed === 1 && ST.franchiseQueue().length === 0 && calls.length === before + 1);
    chk('a server refusal (not a network failure) is not queued', (async () => {
      answer = { ok: false, status: 400, error: '22023', message: 'that game has kicked off' };
      const x = await F.recordPriceIt('old', -3);
      return x.ok === false && !x.queued && ST.franchiseQueue().length === 0;
    }));

    /* not deployed */
    answer = { ok: false, status: 404, error: 'PGRST202', message: 'Could not find the function' };
    r = await F.home();
    chk('a 404 reads as "not deployed", not as an error the player caused', F.deployed() === false && F.state() === 'not_deployed' && r.error === 'not_deployed');

    /* a different account never sees this snapshot */
    S.user = () => ({ id: 'user-b', email: 'b@example.com', meta: {} });
    eq('another account signing in on this browser sees no franchise', F.snapshot(), null);

    /* A TEAM BEFORE AN ACCOUNT: signed out, the device secret is the identity */
    S.user = () => null; S.signedIn = () => false;
    const realSecret = S.secret;
    S.secret = () => null;
    let b = await F.boot();
    chk('a browser with neither a session nor a secret has nothing to ask, and no franchise', b.state === 'no_franchise' && ST.read().franchise.snapshot === null);
    r = await F.create({ name: 'Comets', city: 'Boise', abbr: 'boi', logo: 'peak', theme: 'teal', offense: 'option', defense: 'zone' });
    eq('and cannot found one — the server would have nothing to own it', r.error, 'no_identity');
    S.secret = () => 'device-secret-dddddddddddddddddddddddddddddd';
    answer = { ok: true, data: null };
    await F.home();
    chk('a signed-out home asks with the secret', calls[calls.length - 1][0] === 'franchise_home' && calls[calls.length - 1][1].p_secret === 'device-secret-dddddddddddddddddddddddddddddd');
    answer = { ok: true, data: { franchise: { id: 'f9', name: 'Comets', city: 'Boise', abbr: 'BOI', logo: 'peak', theme: 'teal', owner: 'device' }, resources: { xp: 0, level: 1, scouting_points: 0, team_credits: 100, coach_points: 0 }, rating: { overall: 69 } } };
    r = await F.create({ name: 'Comets', city: 'Boise', abbr: 'boi', logo: 'peak', theme: 'teal', offense: 'option', defense: 'zone' });
    chk('a signed-out player founds a franchise with the device secret, no account', r.ok && calls[calls.length - 1][1].p_secret === 'device-secret-dddddddddddddddddddddddddddddd');
    chk('and it is cached under the device, marked as living there', F.state() === 'franchise' && F.owner() === 'device' && ST.franchiseSnapshot('anon').franchise.id === 'f9');
    answer = { ok: true, data: { ok: true, already: false, rewards: { xp: 50, sp: 40, tc: 20 }, achievements: [], totals: { xp: 50, level: 1, scouting_points: 40, team_credits: 120, coach_points: 0 } } };
    r = await F.recordPriceIt('g2', -3);
    chk('a device-owned franchise earns, with the secret on the call', r.ok && calls[calls.length - 1][1].p_secret && F.snapshot().resources.scouting_points === 40);
    /* then the player signs up: boot claims the device franchise into the account */
    S.user = () => ({ id: 'user-c', email: 'c@example.com', meta: {} }); S.signedIn = () => true;
    let seq = [];
    answer = (fn) => { seq.push(fn); if (fn === 'franchise_home') return seq.filter(x => x === 'franchise_home').length === 1 ? { ok: true, data: null }
      : { ok: true, data: { franchise: { id: 'f9', name: 'Comets', city: 'Boise', abbr: 'BOI', logo: 'peak', theme: 'teal', owner: 'account' }, resources: { xp: 50, level: 1, scouting_points: 40, team_credits: 120, coach_points: 0 }, rating: { overall: 69 } } };
      if (fn === 'franchise_claim') return { ok: true, data: { claimed: true, reason: null, home: { franchise: { id: 'f9', name: 'Comets', owner: 'account' }, resources: { xp: 50 } } } };
      return { ok: true, data: null }; };
    b = await F.boot();
    chk('signing in with a device franchise claims it: home, claim, home again', seq.join(',').indexOf('franchise_home,franchise_claim,franchise_home') >= 0 && b.claimed === true);
    chk('a signed-in call carries no secret — an account beats a device everywhere', calls.filter(c => c[0] === 'franchise_claim')[0][1].p_secret && !('p_secret' in calls[calls.length - 1][1]));
    chk('and the franchise now lives on the account', F.owner() === 'account' && ST.franchiseSnapshot('anon') === null && ST.franchiseSnapshot('user-c').franchise.id === 'f9');
    S.secret = realSecret;

    S.user = realUser; S.rpc = realRpc; S.signedIn = realSigned;
  })();
})().then(() => {
  /* ═══ 7. SIGNING IN ═══════════════════════════════════════════════════════ */
  return (async () => {
    fresh();
    ST.captureAttribution('?utm_source=x&utm_campaign=c1&ref=partnera', 'https://news.example.com/post', T0);
    const a = AU.attrPayload();
    chk('sign-up carries the landing page’s attribution fields, from the shared ledger',
      a.ref === 'partnera' && a.utm_source === 'x' && a.utm_campaign === 'c1' && 'landing_page' in a && 'referrer_host' in a && 'first_seen_at' in a);
    eq('and names the surface', a.signup_surface, 'games_franchise');
    AU.configure(null, null);
    let r = await AU.signIn('a@example.com', 'secret1');
    eq('an unconfigured build refuses rather than throwing', r.error, 'not_configured');
    AU.configure('https://example.test', 'anon-key');
    r = await AU.signUp('a@example.com', 'short', true);
    eq('a short password is refused before any request', r.error, 'input');
    r = await AU.signUp('a@example.com', 'longenough', false);
    eq('consent is required before any request', r.error, 'consent');
    const realFetch = global.fetch;
    let sent = null;
    global.fetch = (url, o) => { sent = { url, body: JSON.parse(o.body), headers: o.headers }; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ access_token: 'x.' + Buffer.from(JSON.stringify({ sub: 'user-a', email: 'a@example.com', exp: 4102444800 })).toString('base64') + '.y', refresh_token: 'r', expires_at: 4102444800 })) }); };
    r = await AU.signUp('a@example.com', 'longenough', true);
    chk('sign-up posts to Supabase Auth with the anon key, the consent record and the attribution',
      sent && /\/auth\/v1\/signup$/.test(sent.url) && sent.headers.apikey === 'anon-key'
      && sent.body.data.consent_21plus === true && sent.body.data.consent_terms === true && sent.body.data.consent_version === AU.CONSENT_VERSION
      && sent.body.data.ref === 'partnera');
    chk('and stores the session under the terminal’s key', !!MEM[AU.SESSION_KEY] && JSON.parse(MEM[AU.SESSION_KEY]).access_token.indexOf('x.') === 0);
    chk('and the social layer now sees a signed-in user', S.signedIn() && S.user().id === 'user-a');
    lacks(JSON.stringify(MEM), 'longenough', 'no password is ever stored');
    global.fetch = (url, o) => Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve(JSON.stringify({ error_description: 'Invalid login credentials' })) });
    r = await AU.signIn('a@example.com', 'wrong');
    chk('a wrong password is a sentence, not a code', r.ok === false && /Wrong email or password/.test(r.message));
    global.fetch = () => Promise.reject(new Error('offline'));
    r = await AU.signIn('a@example.com', 'x');
    eq('an unreachable server says so', r.error, 'unreachable');
    global.fetch = () => Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') });
    await AU.signOut();
    chk('sign-out removes the session', !MEM[AU.SESSION_KEY] && !S.signedIn());
    global.fetch = realFetch;
  })();
}).then(() => {
  /* ═══ 8. THE PAGES, THE SHELL, THE COPY ═══════════════════════════════════ */
  [['front office', OFFICE, 'https://edgedesksports.com/games/franchise'],
   ['roster', ROSTER, 'https://edgedesksports.com/games/roster'],
   ['game day', GAMEDAY, 'https://edgedesksports.com/games/gameday'],
   ['trophy room', TROPHIES, 'https://edgedesksports.com/games/trophies'],
   ['market', MARKET, 'https://edgedesksports.com/games/market']].forEach(([n, p, url]) => {
    has(p, '<link rel="canonical" href="' + url + '">', n + ' declares its canonical URL');
    has(p, 'name="robots" content="index,follow"', n + ' is crawlable');
    ['og:title', 'og:description', 'og:url'].forEach(k => has(p, 'property="' + k + '"', n + ' carries ' + k));
    has(p, 'name="twitter:card"', n + ' carries a Twitter card');
    chk(n + ' has a title', /<title>[^<]{10,}<\/title>/.test(p));
    chk(n + ' has a meta description', /name="description" content="[^"]{40,}"/.test(p));
    has(p, 'width=device-width', n + ' is responsive');
    has(p, 'viewport-fit=cover', n + ' handles a notched phone');
    has(p, 'rel="icon"', n + ' has a tab icon');
    has(p, 'G-1PXVBV53FZ', n + ' reports to the existing analytics property');
    has(p, 'STALE SCRIPT GUARD', n + ' guards against a stale cached library');
    has(p, '<div id="gt"></div>', n + ' mounts the thumb tab bar');
    has(p, '/games/franchise.css', n + ' loads the franchise stylesheet');
    chk(n + ' loads the social layer before sign-in before the franchise before the runtime',
      p.indexOf('lib/social.js') < p.indexOf('lib/auth.js') && p.indexOf('lib/auth.js') < p.indexOf('lib/franchise.js') && p.indexOf('lib/franchise.js') < p.indexOf('/games/games.js'));
    chk(n + ' says it is free to play', /Free to play/.test(p));
    chk(n + ' says nothing can be bought', /can be bought|Nothing here can be bought/.test(p));
    chk(n + ' handles an undeployed backend', /not_deployed|has not been deployed/.test(p));
  });
  has(SITEMAP, 'https://edgedesksports.com/games/franchise<', 'the sitemap lists the Front Office');
  has(SITEMAP, 'https://edgedesksports.com/games/roster<', 'and the roster');
  has(SITEMAP, 'https://edgedesksports.com/games/gameday<', 'and Game Day');
  has(SITEMAP, 'https://edgedesksports.com/games/trophies<', 'and the Trophy Room');
  has(SITEMAP, 'https://edgedesksports.com/games/market<', 'and the market');
  has(NOTFOUND, "p[1]==='roster'||p[1]==='franchise'||p[1]==='gameday'||p[1]==='trophies'||p[1]==='market'", 'the static host routes the new rooms');
  chk('the pages exist where the routes claim', fs.existsSync(G('franchise/index.html')) && fs.existsSync(G('roster/index.html')) && fs.existsSync(G('gameday/index.html')) && fs.existsSync(G('trophies/index.html')) && fs.existsSync(G('market/index.html')));
  /* the bumper knows the new pages, so a token bump reaches them */
  const bump = require(path.join(ROOT, 'tools', 'games', 'bump_assets.js'));
  chk('the asset bumper stamps the new pages', bump.PAGES.some(p => /franchise\/index\.html$/.test(p)) && bump.PAGES.some(p => /roster\/index\.html$/.test(p)) && bump.PAGES.some(p => /gameday\/index\.html$/.test(p)) && bump.PAGES.some(p => /trophies\/index\.html$/.test(p)) && bump.PAGES.some(p => /market\/index\.html$/.test(p)));

  /* the Front Office */
  has(OFFICE, "G.saveCard(", 'saving goes through the shared one-step form');
  has(JS, "AU.save(email, pass, consent)", 'which goes through the games auth module');
  has(JS, 'I am 21 or older and agree to the', 'the consent affirmation is on the form');
  has(JS, '/terms.html', 'and links the Terms');
  has(OFFICE, 'FR.create(', 'founding calls the server');
  has(OFFICE, 'FR.importHistory(payload)', 'and then imports the anonymous history');
  has(OFFICE, "track('franchise_created'", 'founding is measured');
  has(OFFICE, "track('franchise_import'", 'and so is the import');
  has(JS, "track(r.mode === 'signin' ? 'franchise_signin' : 'franchise_signup'", 'and sign-up, or the sign-in it fell back to');
  has(OFFICE, 'carryOver()', 'the form says what carries over, in real numbers');
  has(OFFICE, 'No account needed', 'founding needs no account');
  has(OFFICE, 'Save your franchise', 'a device-owned franchise is offered a save, not a sign-up wall');
  has(OFFICE, "track('franchise_claimed'", 'and the claim is measured');
  has(OFFICE, 'Share my franchise', 'a franchise can be shared as text');
  chk('the office never blocks the front door: the founding form renders without a session',
    /else renderFound\(\);/.test(OFFICE) && /if\(st==='franchise'\)renderOffice\(\);/.test(OFFICE));
  chk('the Front Office never renders a player it invented', !/first_name:\s*'/.test(OFFICE));
  chk('the identity form offers every option list', /FR\.LOGOS/.test(OFFICE) && /FR\.THEMES/.test(OFFICE) && /FR\.OFFENSES/.test(OFFICE) && /FR\.DEFENSES/.test(OFFICE));
  has(OFFICE, 'Sign out', 'a player can sign out');
  has(OFFICE, 'None of them can be bought', 'the resources say they cannot be bought');

  /* the roster */
  has(ROSTER, 'FR.roster()', 'the roster is read from the server');
  has(ROSTER, 'FR.playerCard(p', 'and rendered with the shared card');
  has(ROSTER, 'FR.setStarter(id,slot)', 'a lineup change goes to the server');
  has(ROSTER, "track('roster_change'", 'and is measured');
  has(ROSTER, "track('player_view'", 'as is a player view');
  has(ROSTER, "track('roster_view'", 'and the roster view');
  has(ROSTER, 'cannot be edited', 'the page says the numbers cannot be edited');

  /* the HQ */
  has(HOME, 'id="heroHq"', 'the home carries the HQ hero');
  chk('the HQ paints before the modules load, for an owner only — the account’s snapshot, or the device’s when there is no session',
    /var key=sub\|\|'anon'/.test(HOME) && /o\.franchise\.user_id===key/.test(HOME) && /heroHq/.test(HOME.slice(0, HOME.indexOf('lib/week.js'))));
  has(HOME, "track('franchise_home_view'", 'the HQ view is measured');
  has(HOME, 'FR.prep(wk)', 'this week’s meters use the published preparation read');
  /* the four questions, in order: who am I playing, what should I do today,
     what do I earn, how does this help my team */
  ['Next up', 'Today', 'Do it now', 'Earns ', 'what it feeds', 'Team OVR', 'Offense', 'Defense', 'Special', 'Scouting', 'Preparation', 'Market IQ', 'Next reward', 'Founder Season'].forEach(t => has(HOME, t, 'the HQ shows ' + t));
  chk('the HQ answers the questions in that order',
    HOME.indexOf('Next up') < HOME.indexOf('>Today</div>') && HOME.indexOf('>Today</div>') < HOME.indexOf('what it feeds') && HOME.indexOf('what it feeds') < HOME.indexOf('>The team</div>'));
  chk('every objective names its reward by the published table',
    /'\+50 XP · up to \+40 SP · up to \+20 TC'/.test(HOME) && /'\+40 XP · up to \+30 TC'/.test(HOME) && /'\+75 XP · \+25 TC/.test(HOME) && /'\+15 XP'/.test(HOME));
  chk('the returning player without a franchise sees rewards on every row too', /'\+50 XP · up to \+40 SP'/.test(HOME) && /wb-week \.r/.test(CSS));
  has(HOME, 'Your first opponent is revealed when ', 'the HQ is honest about the preseason rather than inventing an opponent');
  chk('the HQ shows both calendars: the franchise’s own season and the live football week',
    /class="hq-cal"/.test(HOME) && /ss\.label\|\|'Season I'/.test(HOME) && /CFB<\/b> · Week /.test(HOME) && /live slate/.test(HOME));
  chk('the franchise season is its own calendar in the SQL: numbered, labelled, a fixed number of weeks',
    /number\s+integer not null check \(number >= 1\)/.test(SQL) && /weeks\s+integer not null default 8/.test(SQL) && /primary key \(franchise_id, number\)/.test(SQL)
    && /'Season ' \|\| public\.games_roman\(1\)/.test(SQL));
  has(HOME, 'G.conversionCard', 'the conversion moment is on the home');
  has(HOME, 'Found your franchise', 'and the public explainer names the door');
  has(HOME, 'No leaderboard results yet. Be the first.', 'the leaderboard still never fabricates a player');

  /* the games, wired */
  has(PRICE, 'FR.recordPriceIt(ch.game_id,stored.user_spread)', 'Price It files the same line with the franchise');
  has(PRICE, 'G.rewardPanel(r)', 'and shows what the server credited');
  has(PRICE, 'Error vs EdgeDesk', 'the scouting report states the error');
  has(PRICE, "conversionCard('price_it_after')", 'and the conversion moment after the reveal');
  chk('Price It never sends a benchmark price to the server', !/FR\.recordPriceIt\([^)]*(edgedesk|market)/.test(PRICE));
  has(PICK, 'FR.submitPick5(WEEK,card.selections)', 'Pick 5 files the card with the franchise');
  has(PICK, "conversionCard('pick5_after')", 'and offers the conversion moment');
  has(DRILL, 'FR.recordDrill(', 'the Drill files today’s run');
  chk('but only a daily run that is not a replay', /S\.mode==='daily'&&!S\.replay&&FR/.test(DRILL));
  has(DYN, 'Front Office', 'the War Room opens onto the Front Office');
  has(DYN, '/games/roster/', 'and the roster');
  has(STATUS, "rpc('franchise_economy'", 'the status page probes the franchise layer');
  has(STATUS, 'games_franchise.sql', 'and says how to deploy it');

  /* the shell */
  ['HQ', 'War Room', 'Scouting', 'Training', 'Game Day', 'Roster', 'League', 'Front Office'].forEach(r => has(JS, "label: '" + r + "'", 'the header names the ' + r));
  chk('the tab bar is five rooms', (JS.match(/tab: '/g) || []).length === 5);
  has(JS, '/games/roster/', 'the footer reaches the roster');
  has(JS, '/games/franchise/', 'and the Front Office');
  chk('the tab bar shows only on a phone', /@media\(max-width:480px\)\{\s*\.gtab\{position:fixed/.test(CSS));
  chk('and every tab meets the tap minimum', /\.gtab a\{[^}]*min-height:56px/.test(CSS));
  chk('the wider-only rooms appear from 768px', /\.gh-only-wider\{display:none\}\s*@media\(min-width:768px\)\{\.gh-only-wider\{display:block\}\}/.test(CSS));
  (() => {
    const maxw = (FCSS.match(/@media\(max-width:(\d+)px\)/g) || []);
    chk('the franchise stylesheet is mobile-first too', maxw.every(m => +m.match(/(\d+)/)[1] <= 480), maxw.join(','));
  })();
  chk('identity on every event says signed-in and whether a franchise is owned',
    /p\.identity = signed \? 'authenticated' : 'anonymous'/.test(JS) && /p\.has_franchise = owns/.test(JS));
  chk('research opens are queued for the franchise, not sent from a page that is leaving',
    /ST\.queueFranchise\(\{ key: 'research:'/.test(JS));

  /* the funnel */
  ['franchise_created', 'franchise_home_view', 'player_view', 'roster_change', 'daily_objective_complete', 'scouting_spent',
   'player_scouted', 'weekly_game_started', 'weekly_game_completed', 'h2h_franchise_complete', 'achievement_unlocked',
   'season_complete', 'draft_pick', 'trophy_room_view'].forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  const ALL = HOME + PRICE + PICK + DRILL + DYN + OFFICE + ROSTER + GAMEDAY + TROPHIES + MARKET + JS;
  ['franchise_created', 'franchise_home_view', 'player_view', 'roster_change', 'roster_view', 'front_office_view', 'franchise_reward', 'franchise_import']
    .forEach(e => chk('and actually fires ' + e, new RegExp("track\\('" + e + "'").test(ALL)));
  chk('no second analytics vendor', !/posthog|mixpanel|segment\.com|amplitude|plausible\.io|fathom/i.test(ALL));

  /* the copy rules the rest of Games lives by */
  const COPY = (OFFICE + ROSTER + GAMEDAY + TROPHIES + MARKET + FCSS + JS + HOME).replace(/no real-money wagering/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  [/guaranteed edge/i, /free money/i, /can'?t lose/i, /sure thing/i, /risk-?free/i, /\bwager\b(?!ing)/i, /\bparlay\b/i,
   /loot box/i, /virtual currency/i, /pay[- ]to[- ]win/i, /\bpack\b(?!s? *, no premium)/i, /premium player/i, /\bjackpot\b/i, /\bcasino\b/i]
    .forEach(re => chk('the franchise copy avoids ' + re, !re.test(COPY.replace(/no packs, no premium players/gi, '')), (COPY.match(re) || [''])[0]));
  (() => {
    let c = COPY;
    [/no deposits/gi, /no wallet/gi, /no balance/gi, /no entry fee/gi, /no cash prize/gi, /no prizes/gi].forEach(re => { c = c.replace(re, ''); });
    chk('the franchise has no balance, wallet, deposit, entry fee or prize', !/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i.test(c),
      (c.match(/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i) || [''])[0]);
  })();
  chk('a subscriber earns nothing extra', !/subscriber.*(bonus|multiplier|extra)|pro.*multiplier/i.test(COPY));
  chk('nothing is paywalled', !/subscribe to (play|found|create)|upgrade to (play|found|create)/i.test(COPY));

  /* ═══ 9. THE TRUSTED WORKER ═══════════════════════════════════════════════ */
  const P = require(G('publish_board.js'));
  eq('a naive kickoff is an instant in UTC, as the exporter stamps it', P.kickoffIso('2026-09-05 19:30'), '2026-09-05T19:30:00.000Z');
  eq('an empty kickoff is null', P.kickoffIso(''), null);
  (() => {
    const rows = P.rows({ challenges: [{ game_id: 1, season: 2026, week: 2, slug: 'a-b', home_team: 'B', away_team: 'A', kickoff: '2026-09-05 19:30', edgedesk_spread: -7, market_spread: -6.5, confidence: 50, research_state: 'PASS', status: 'PREDICTED' }],
      finals: { '1': { home_score: 31, away_score: 20 }, '2': { home_score: 10, away_score: 3 }, '3': { home_score: 'x' } } });
    eq('every challenge is a row, and a final for a game off the board is a row too', rows.length, 2);
    chk('a challenge row carries the artifact’s prices and nothing computed', rows[0].edgedesk_spread === -7 && rows[0].market_spread === -6.5 && !('score' in rows[0]));
    chk('the final joins its row', rows[0].final_home === 31 && rows[0].final_away === 20);
    chk('a finals-only row carries the id and the scores', rows[1].game_id === '2' && rows[1].final_home === 10);
    chk('a malformed final is dropped', rows.every(r => r.game_id !== '3'));
  })();
  (() => {
    const key = process.env.EDGD_SB_SERVICE; delete process.env.EDGD_SB_SERVICE;
    eq('the worker refuses to run without the service role', P.config(), null);
    if (key) process.env.EDGD_SB_SERVICE = key;
  })();
  chk('the worker computes no price', !/function\s+(project|predict|rate|price)[A-Z]/.test(PUB) && PUB.indexOf('IT COMPUTES NO PRICE') >= 0);
  has(PUB, "'game_board_upsert'", 'it publishes through the service-only function');
  has(PUB, "'franchise_settle_pick5'", 'and settles through the service-only function');
  chk('it reads the real artifact, not a second board', /challenges\.json/.test(PUB) && !/fetch\(.*odds/i.test(PUB));
  const WF_C = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'games-challenges.yml'), 'utf8');
  const WF_S = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'games-settle.yml'), 'utf8');
  const WF_Q = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'games-sql.yml'), 'utf8');
  has(WF_C, 'node games/publish_board.js', 'the board build publishes to the franchise layer');
  has(WF_S, 'node games/publish_board.js --settle', 'the settle job settles franchise Pick 5');
  has(WF_Q, 'node tools/games/franchise_sql.test.js', 'the SQL job runs the franchise suite');
  chk('the workflows pass the repository’s existing secrets and no new ones',
    /EDGD_SB_SERVICE: \$\{\{ secrets\.SB_SERVICE_ROLE/.test(WF_C) && /EDGD_SB_URL: \$\{\{ secrets\.SB_URL/.test(WF_S)
    && !/secrets\.(?!SB_SERVICE_ROLE|SB_URL|GITHUB_TOKEN|COLLECTIVE_ADMIN_REFRESH_TOKEN)[A-Za-z_]/.test(WF_C + WF_S + WF_Q));

  /* ═══ 10. THE SQL FILE KEEPS THE CONVENTIONS ══════════════════════════════ */
  const TABLES = ['game_board', 'franchises', 'franchise_seasons', 'game_players', 'franchise_activity', 'franchise_ledger',
    'franchise_pick5_cards', 'franchise_pick5_selections', 'franchise_achievement_defs', 'franchise_achievements',
    'franchise_opponents', 'franchise_games'];
  TABLES.forEach(t => {
    has(SQL, 'create table if not exists public.' + t, t + ' is created idempotently');
    has(SQL, 'alter table public.' + t + ' ' + ' '.repeat(Math.max(0, 27 - t.length)) + 'enable row level security', t + ' has row level security on');
  });
  chk('no policy grants a client any write', !/create policy [a-z_]+ on public\.[a-z_]+ for (insert|update|delete)/.test(SQL));
  chk('the ledger write, the generator and the trusted functions are revoked from every client role',
    ['franchise_credit(uuid, text, integer, text, text, text)', 'franchise_generate_roster(uuid, text, integer)', 'game_board_upsert(jsonb)', 'franchise_settle_pick5()', 'franchise_award(uuid, text, integer, jsonb)']
      .every(f => SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  chk('a team comes before an account: the player functions are open to anon, the claim is not',
    ['franchise_create(text, text, text, text, text, text, text, text)', 'franchise_record_price_it(text, numeric, text)', 'franchise_home(text)']
      .every(f => SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0)
    && SQL.indexOf('revoke all on function public.franchise_claim(text) from public, anon') >= 0
    && SQL.indexOf('grant execute on function public.franchise_claim(text) to authenticated') >= 0);
  chk('the resolver is the social layer’s rule: an account, else the hash of the secret presented',
    /f\.anon_hash = public\.games_hash\(p_secret\)/.test(SQL) && /order by \(f\.user_id is not null\) desc/.test(SQL));
  chk('a franchise is owned by an account or a device, never neither', /constraint franchises_owned check \(user_id is not null or anon_hash is not null\)/.test(SQL));
  (() => {
    const definers = (SQL.match(/security definer/g) || []).length;
    const pinned = (SQL.match(/security definer set search_path = public, pg_temp/g) || []).length;
    chk('every security-definer function pins its search_path', definers > 0 && definers === pinned, definers + ' definers, ' + pinned + ' pinned');
  })();
  chk('the file depends on no extension', !/digest\(|gen_random_bytes|pgcrypto|create extension/.test(SQL));
  chk('it ends in a report whose rows say ok or CHECK THIS', /'ok' else 'CHECK THIS'/.test(SQL) && /order by 1;\s*$/.test(SQL));
  chk('the H2H trigger is attached without touching games_social.sql', /create trigger franchise_h2h_settled/.test(SQL)
    && fs.readFileSync(path.join(ROOT, 'supabase', 'games_social.sql'), 'utf8').indexOf('franchise') < 0);
  has(SQL, 'computes NO price', 'the SQL states the one architectural rule');
  chk('the SQL scores Price It against the board, never a client price',
    /select \* into b from public\.game_board where game_id = p_game_id/.test(SQL) && !/p_edgedesk_spread|p_market_spread|p_client_price|p_benchmark/.test(SQL));
  chk('the founder achievement is season-exclusive', /'founder_2026',\s+'Founder Season 2026'[^\n]*2026, 1\)/.test(SQL));
  has(README, 'games_franchise.sql', 'the README documents the file');
  has(README, 'economy_v1', 'and the economy version');
  has(fs.readFileSync(path.join(ROOT, 'supabase', 'README.md'), 'utf8'), 'games_franchise.sql', 'and the supabase README lists it');

  /* ═══ 11. THE WEEKLY GAME (PHASE 2) ═══════════════════════════════════════ */
  /* the simulator's published shape is the SQL's */
  eq('the simulator is versioned', F.SIM_VERSION, 'sim_v1');
  has(SQL, "'sim', 'sim_v1'", 'and every box says so');
  (() => {
    const m = SQL.match(/franchise_scheme_edges\(\)[\s\S]*?select '(\{[\s\S]*?\})'::jsonb;/);
    let sqlEdges = null; try { sqlEdges = m && JSON.parse(m[1]); } catch (_) {}
    chk('the scheme matchup table the client shows is the one the server applies, cell for cell',
      !!sqlEdges && JSON.stringify(sqlEdges) === JSON.stringify(F.SCHEME_EDGES), m ? m[1].slice(0, 80) : 'not found');
    chk('every offense and defense in the table is a real identity',
      Object.keys(F.SCHEME_EDGES).every(o => F.OFFENSES.some(x => x.key === o) && Object.keys(F.SCHEME_EDGES[o]).every(d => F.DEFENSES.some(x => x.key === d))));
    chk('and no offense nets more than a point across the six defenses',
      Object.keys(F.SCHEME_EDGES).every(o => Math.abs(Object.keys(F.SCHEME_EDGES[o]).reduce((a, d) => a + F.SCHEME_EDGES[o][d], 0)) <= 1));
  })();
  eq('Air Raid into Press Man loses two', F.schemeEdge('air_raid', 'press_man'), -2);
  eq('an unknown scheme is even', F.schemeEdge('nope', 'zone'), 0);
  chk('home field and the preparation swing are the SQL\'s numbers', F.HOME_EDGE === 1.5 && F.PREP_SWING === 3
    && /h_me := case when g\.home then 1\.5 \+ stad else 0 end; h_op := case when g\.home then 0 else 1\.5 end;/.test(SQL) && /\/ 50\.0 \* 3, 2\)/.test(SQL));
  chk('preparation swings −3 at 0%, 0 at 50%, +3 at 100%, −0.54 at 41%', F.prepAdj(0) === -3 && F.prepAdj(50) === 0 && F.prepAdj(100) === 3 && F.prepAdj(41) === -0.54);
  /* preparation, prep_v1: the client's worked examples are the ones the SQL suite pins */
  (() => {
    const a = F.prep({ price_it: 1, drills: 1, research: 1, price_it_avg_score: 80 });
    chk('one report, one drill, one open: scouting 33, preparation 41, market IQ 80', a.scouting === 33 && a.preparation === 41 && a.market_iq === 80, JSON.stringify(a));
    const b = F.prep({ price_it: 3, pick5_submitted: true, drills: 1, research: 2, price_it_avg_score: 80 });
    chk('everything done: 100 and 100', b.scouting === 100 && b.preparation === 100);
    has(SQLTEST, 'scouting 33, preparation 41, market IQ 80', 'and the SQL suite asserts the same examples of the server');
    has(SQL, "'version', 'prep_v1'", 'the server publishes the same version');
  })();
  /* the achievements the SQL seeds are the names the client knows */
  (() => {
    const rows = {}; let m; const re = /\('([a-z_0-9]+)',\s+'([^']+)',\s+'/g;
    while ((m = re.exec(SQL))) rows[m[1]] = m[2];
    ['first_win', 'bragging_rights', 'shutout', 'first_season', 'winning_season', 'perfect_season'].forEach(id =>
      chk('the SQL seeds ' + id + ' and the client names it the same', rows[id] && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === rows[id].replace(/''/g, "'"), rows[id]));
  })();
  eq('a weekly game: 100 XP, 40 TC', F.ECONOMY.weekly_game.xp + '/' + F.ECONOMY.weekly_game.tc, '100/40');
  eq('a win: 60 XP, 60 TC, 2 CP', [F.ECONOMY.weekly_win.xp, F.ECONOMY.weekly_win.tc, F.ECONOMY.weekly_win.cp].join('/'), '60/60/2');
  eq('the rival beaten: 50 XP, 1 CP on top', F.ECONOMY.rival_win.xp + '/' + F.ECONOMY.rival_win.cp, '50/1');
  eq('a season completed: 250 XP, 150 TC', F.ECONOMY.season_complete.xp + '/' + F.ECONOMY.season_complete.tc, '250/150');
  chk('rewardsFor knows the game lines', F.rewardsFor('weekly_win').cp === 2 && F.rewardsFor('season_complete').xp === 250);

  /* where the season stands, read from the snapshot */
  (() => {
    const T = Date.parse('2026-09-09T12:00:00Z');
    const base = { franchise: { id: 'f' }, season: { status: 'active', number: 1, label: 'Season I', weeks: 8, week: 2 } };
    const ng = { id: 'g', week: 3, opens_at: '2026-09-12T07:00:00Z', open: false, home: true, rival: false, opponent: { city: 'Bayou', name: 'Marsh Hawks', abbr: 'BAY' } };
    eq('no snapshot, no phase', F.gamePhase(null), null);
    eq('a preseason franchise is waiting for its schedule', F.gamePhase({ franchise: {}, season: { status: 'preseason' } }).phase, 'preseason');
    eq('a complete season waits for the next one', F.gamePhase({ franchise: {}, season: { status: 'complete' } }).phase, 'complete');
    eq('an active season with no game says so', F.gamePhase(base, T).phase, 'between');
    const w = F.gamePhase(Object.assign({ next_game: ng }, base), T);
    chk('a game that opens Saturday is waiting, and says how long', w.phase === 'waiting' && w.opens.label === 'opens in 3 days' && w.game === ng);
    eq('the same game on Saturday is ready', F.gamePhase(Object.assign({ next_game: ng }, base), Date.parse('2026-09-12T07:00:00Z')).phase, 'ready');
    eq('and the server\'s open flag is believed', F.gamePhase(Object.assign({ next_game: Object.assign({}, ng, { open: true }) }, base), T).phase, 'ready');
    eq('the last day counts in hours', F.opensIn('2026-09-12T07:00:00Z', Date.parse('2026-09-11T20:00:00Z')).label, 'opens in 11 hours');
    eq('a matchup is said the way a schedule says it', F.matchupLine(ng), 'vs Bayou Marsh Hawks');
    eq('away is at', F.matchupLine(Object.assign({}, ng, { home: false })), 'at Bayou Marsh Hawks');
    eq('a result is said with the score', F.resultLine({ status: 'final', result: 'W', score_for: 27, score_against: 20, ot: true }), 'W 27–20 (OT)');
    eq('a scheduled game has no result line', F.resultLine(ng), '');
  })();
  /* lines and cards */
  eq('a quarterback line', F.statsLine('QB', { cmp: 18, att: 27, yds: 288, td: 3, int: 1 }), '18/27, 288 yds, 3 TD, 1 INT');
  eq('a back line with receiving', F.statsLine('RB', { car: 15, yds: 102, td: 1, rec: 3, rec_yds: 38 }), '15 car, 102 yds, 1 TD, 3 rec, 38 yds');
  eq('a receiver line', F.statsLine('WR', { rec: 6, yds: 104, td: 1 }), '6 rec, 104 yds, 1 TD');
  eq('a defender line', F.statsLine('LB', { tkl: 9, sacks: 1, int: 0 }), '9 tkl, 1 sack');
  eq('a kicker line says PAT, not XP', F.statsLine('K', { fg: 2, fga: 3, xp: 3 }), '2/3 FG, 3 PAT');
  eq('a punter line averages', F.statsLine('P', { punts: 4, punt_yds: 168 }), '4 punts, 42.0 avg');
  eq('a career line is the sum of the boxes', F.careerLine({ position: 'WR', career_stats: { rec: 12, yds: 190, td: 2, games: 3 }, acquired_season: 2026 }), '12 rec, 190 yds, 2 TD, 3 GP');
  eq('a season line is blank until a game is played', F.seasonLine({ position: 'WR', season_stats: {} }), '');
  chk('the card shows this season once there is one', F.playerCard({ id: 'p', first_name: 'A', last_name: 'B', position: 'RB', jersey: 1, overall: 70, ratings: {}, depth: 1, season_stats: { car: 15, yds: 102, games: 1 } }).indexOf('This season') >= 0
    && F.playerCard({ id: 'p', first_name: 'A', last_name: 'B', position: 'RB', jersey: 1, overall: 70, ratings: {}, depth: 1 }).indexOf('This season') < 0);
  (() => {
    const t = F.gameShareText({ city: 'Lubbock', name: 'Outlaws' },
      { status: 'final', week: 3, result: 'W', score_for: 27, score_against: 20, home: true, opponent: { city: 'Bayou', name: 'Marsh Hawks' }, potg: { name: 'Cameron Everly', position: 'RB', stats: { car: 15, yds: 102, td: 1 } } },
      { label: 'Season I', wins: 2, losses: 1 });
    chk('a shared result is the score, the week, the player of the game and the record — and no claim',
      /LUBBOCK OUTLAWS 27, Bayou Marsh Hawks 20/.test(t) && /Season I · Week 3/.test(t) && /Cameron Everly, RB — 15 car, 102 yds, 1 TD/.test(t) && /Now 2–1\./.test(t)
      && /EdgeDesk Games$/.test(t) && !/\b(bet|wager|odds|edge|lock)\b/i.test(t), t);
  })();
  /* the client asks, and never decides */
  has(FJS, "rpc('franchise_play_week', withSecret({}))", 'playing sends nothing but "play" and the identity');
  chk('a play is never queued — the player must see the result the moment it exists', !/record\('franchise_play_week'/.test(FJS));
  has(FJS, "rpc('franchise_start_season', withSecret({}))", 'starting a season is the same');
  has(FJS, "rpc('franchise_schedule', withSecret({ p_number:", 'the schedule is read by season number');
  has(FJS, "rpc('franchise_game', withSecret({ p_game: String(id) }))", 'and a game by id');
  chk('the client never simulates', !/function (sim|simulate|drive|possession|playGame)\b/.test(FJS) && !/rpc\('franchise_sim/.test(FJS));

  /* Game Day, the page */
  has(GAMEDAY, 'FR.playWeek()', 'Game Day plays through the server');
  has(GAMEDAY, "track('weekly_game_started'", 'and measures the start');
  has(GAMEDAY, "track('weekly_game_completed'", 'and the result');
  has(GAMEDAY, "track('season_complete'", 'and a season completed');
  has(GAMEDAY, "track('season_started'", 'and a season started');
  has(GAMEDAY, "track('gameday_view'", 'and the view');
  has(GAMEDAY, "track('game_share'", 'and a share');
  has(GAMEDAY, 'G.rewardPanel(r)', 'the result shows what the server credited');
  has(GAMEDAY, 'FR.startSeason()', 'the next season starts on request');
  has(GAMEDAY, 'FR.schedule()', 'the schedule is read from the server');
  has(GAMEDAY, 'FR.game(VIEW_GAME)', 'and any past game by its id');
  has(GAMEDAY, 'Every game is played once', 'the page says a game cannot be replayed');
  has(GAMEDAY, 'Kicks off Saturday', 'and names Saturday');
  has(GAMEDAY, 'Player of the game', 'the result names a player of the game');
  has(GAMEDAY, 'Why it went this way', 'and explains the edges');
  has(GAMEDAY, "conversionCard('gameday_after')", 'a device franchise is offered the one-step save after a result');
  has(GAMEDAY, '/games/h2h/', 'Head-to-Head is reached from Game Day');
  has(GAMEDAY, 'Found my franchise', 'and a visitor without a franchise is shown the door');
  chk('Game Day never renders a player, a score or an opponent it invented', !/first_name:\s*'/.test(GAMEDAY) && !/score_for:\s*\d/.test(GAMEDAY) && !/opponent:\s*\{\s*city:/.test(GAMEDAY));
  chk('the pregame lists what would raise preparation, by the published weights', /\+25%/.test(GAMEDAY) && /\+20%/.test(GAMEDAY) && /Math\.round\(40\/3\)/.test(GAMEDAY));
  /* the HQ answers "who am I playing?" with a name and a mark */
  has(HOME, 'FR.gamePhase(snap)', 'the HQ reads the phase from the snapshot');
  has(HOME, 'FR.matchupLine(ng)', 'and names the opponent');
  has(HOME, 'Saturday’s game is open', 'and says when the game is open');
  has(HOME, 'Kicks off Saturday', 'or when it opens');
  chk('an open game is the first thing on today\'s list', HOME.indexOf("'Game Day: play Week '") < HOME.indexOf('File today’s scouting report'));
  has(HOME, 'snap.prep||FR.prep(wk)', 'the meters use the server\'s preparation when the snapshot carries it');
  has(HOME, "conversionCard('hq')", 'a device franchise gets the one-step save under the HQ');
  has(HOME, 'data-cta="hq-gameday"', 'and a door to Game Day');
  /* the shell */
  chk('Game Day is the weekly game now, and Head-to-Head is still one click away',
    require(G('games.js')).ROOMS.some(r => r.key === 'gameday' && r.href === '/games/gameday/' && r.tab === 'Game Day')
    && !require(G('games.js')).ROOMS.some(r => r.href === '/games/h2h/') && /href="\/games\/h2h\/"/.test(JS));
  ['gameday_view', 'season_started', 'game_share'].forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  ['weekly_game_started', 'weekly_game_completed', 'season_complete', 'season_started', 'gameday_view', 'achievement_unlocked'].forEach(e => chk('Game Day fires ' + e, new RegExp("track\\('" + e + "'").test(GAMEDAY)));

  /* SAVE IT, IN ONE STEP — the same EdgeDesk account as the research terminal */
  has(JS, 'function saveCard', 'the one-step save form is shared');
  has(JS, "AU.save(email, pass, consent)", 'and saves through the auth module');
  has(JS, 'AU.recover(email)', 'with a password reset');
  has(JS, 'One EdgeDesk account for everything', 'and says it is the one account');
  chk('a device franchise\'s conversion card IS the form, not a link to one', /if \(FR\.owner\(\) !== 'device'\) return '';[\s\S]*?\+ saveCard\(placement\)/.test(JS));
  chk('the form is wired wherever a conversion card is', /function wireConversion\(onSaved\) \{[\s\S]*?wireSaveCard\(onSaved\)/.test(JS));
  chk('sign-up falls back to sign-in when the email already has an account', /function save\(email, password, consent\)[\s\S]*?already has an account[\s\S]*?signIn\(email, password\)/.test(AUTHJS));
  chk('and a confirmation-mode sign-up that returns no identities is read as an existing account', /identities\.length === 0/.test(AUTHJS) && /r\.ok && r\.existing/.test(AUTHJS));
  has(AUTHJS, "post('/auth/v1/recover', { email: email })", 'the reset goes through Supabase Auth');
  chk('consent is recorded only when an account is created, never on the fall-back sign-in', /consent_21plus: true/.test(AUTHJS) && !/signIn\([^)]*consent/.test(AUTHJS));
  eq('it is the terminal\'s session key', AU.SESSION_KEY, 'edgedesk_session');
  has(LANDING, "localStorage.getItem('edgedesk_session')", 'which the landing page reads');
  has(LANDING, 'if(sessionValid()){ openArl(); return; }', 'so a Games account that wants EdgeDesk Pro skips straight to the plan');
  chk('the office and the HQ both use the shared form', /G\.saveCard\(/.test(OFFICE) && /conversionCard\('hq'\)/.test(HOME));
  chk('the save form meets the tap minimum and stacks on a phone', /\.save-row input\{min-height:var\(--tap\)/.test(FCSS) && /\.save-row\{display:grid;gap:8px\}/.test(FCSS));
  chk('the save form never asks for a display name, a phone or a second password', !/confirm.?password|display.?name|phone/i.test(JS.slice(JS.indexOf('function saveCard'), JS.indexOf('function wireSaveCard'))));

  /* the SQL keeps its conventions on the new side */
  ['franchise_sim(uuid, uuid)', 'franchise_play_game(uuid, timestamptz)', 'franchise_schedule_season(uuid, integer, timestamptz)', 'franchise_sim_lines(jsonb, text, jsonb, jsonb, jsonb, jsonb)', 'franchise_prep(uuid, text)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role', SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_play_week(text)', 'franchise_start_season(text)', 'franchise_schedule(integer, text)', 'franchise_game(uuid, text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated', SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to twelve rows', /select 12, 'the weekly game is open to every franchise/.test(SQL));
  has(SQL, 'drop constraint if exists franchise_activity_kind_check', 'the activity kinds grow without a rebuild');
  has(SQL, "(wk::date + 4)::timestamp + interval '7 hours'", 'a game opens on the Saturday of its week at 07:00 UTC');
  has(SQL, "perform setseed(public.franchise_seed_float(g.seed))", 'the simulator is seeded from the game');
  has(SQL, 'perform public.franchise_open_season(v_id, 1, now());', 'Season I is scheduled at founding');
  has(SQL, "for update", 'the franchise row is locked while a game is played');
  chk('a client sends nothing that changes a result: play and start take the identity and nothing else',
    /franchise_play_week\(p_secret text default null\)/.test(SQL) && /franchise_start_season\(p_secret text default null\)/.test(SQL)
    && !/p_score_for\b|p_result\b|p_box\b|p_game_seed/.test(SQL));
  has(README, 'sim_v1', 'the README documents the simulator version');
  has(README, 'Saturday at 07:00 UTC', 'and the calendar rule');
  has(README, 'Save it, in one step', 'and the one-step save');

  /* ═══ 12. FRANCHISE VS FRANCHISE (PHASE 3) ════════════════════════════════ */
  eq('a challenge played: 60 XP, 30 TC', F.ECONOMY.fc_played.xp + '/' + F.ECONOMY.fc_played.tc, '60/30');
  eq('a challenge won: 40 XP, 40 TC, 2 CP', [F.ECONOMY.fc_win.xp, F.ECONOMY.fc_win.tc, F.ECONOMY.fc_win.cp].join('/'), '40/40/2');
  eq('an upset: 40 XP, 1 CP on top', F.ECONOMY.fc_upset.xp + '/' + F.ECONOMY.fc_upset.cp, '40/1');
  chk('rewardsFor knows the challenge lines', F.rewardsFor('fc_win').cp === 2 && F.rewardsFor('fc_upset').xp === 40 && F.rewardsFor('fc_played').tc === 30);
  (() => {
    const rows = {}; let m; const re = /\('([a-z_0-9]+)',\s+'([^']+)',\s+'/g;
    while ((m = re.exec(SQL))) rows[m[1]] = m[2];
    ['fc_first', 'fc_first_win', 'fc_upset', 'fc_three'].forEach(id =>
      chk('the SQL seeds ' + id + ' and the client names it the same', rows[id] && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === rows[id].replace(/''/g, "'"), rows[id]));
  })();
  chk('the ladder starts at 1500 with K = 24, the same on both sides', F.LADDER_START === 1500 && F.LADDER_K === 24
    && /ladder_rating integer not null default 1500/.test(SQL) && /games_elo_delta\(ra, rb, [^)]*, 24\)/.test(SQL));
  eq('a record is said plainly', F.recordLine({ wins: 3, losses: 1 }), '3–1');
  eq('with ties when there are any', F.recordLine({ wins: 3, losses: 1, ties: 1 }), '3–1–1');
  chk('a challenge link is the Game Day page with the token', /^https:\/\/edgedesksports\.com\/games\/gameday\/\?fc=abc$/.test(F.challengeUrl('abc')));
  (() => {
    const t = F.challengeInviteText({ city: 'Lubbock', name: 'Outlaws', overall: 72, record: { wins: 3, losses: 1 } }, { note: 'Bring it.' });
    chk('an invite says who is calling, how good they are, the note, and that no account is needed',
      /The Lubbock Outlaws \(OVR 72, 3–1\) challenge your franchise\./.test(t) && /“Bring it\.”/.test(t) && /No account needed/.test(t) && !/\b(bet|wager|odds)\b/i.test(t), t);
    const r = F.challengeShareText({ status: 'FINAL', me: { city: 'Lubbock', name: 'Outlaws' }, them: { city: 'Austin', name: 'Wranglers' }, score_for: 27, score_against: 20, ot: true, rating_delta: 12,
      potg: { name: 'A B', position: 'RB', stats: { car: 12, yds: 80, td: 1 } } });
    chk('a shared result is the score, the player of the game and the ladder move — no claim',
      /LUBBOCK OUTLAWS 27, Austin Wranglers 20 \(OT\)/.test(r) && /neutral field/.test(r) && /A B, RB — 12 car, 80 yds, 1 TD/.test(r) && /Ladder: \+12/.test(r) && /EdgeDesk Games$/.test(r), r);
    eq('a shared invite that is not final says the matchup', F.challengeShareText({ status: 'OPEN', me: { city: 'Lubbock', name: 'Outlaws' }, them: null }).split('\n')[0], 'LUBBOCK OUTLAWS challenge a franchise.');
  })();
  /* the client asks; the link is the key */
  has(FJS, "rpc('franchise_challenge_create', withSecret({ p_note: note || null }))", 'a challenge is made with a note and the identity');
  has(FJS, "rpc('franchise_challenge_peek', withSecret({ p_token: String(token || '') }))", 'a link is read by its token');
  has(FJS, "rpc('franchise_challenge_accept', withSecret({ p_token: String(token || '') }))", 'and accepted by its token, nothing more');
  chk('accepting is never queued', !/record\('franchise_challenge_accept'/.test(FJS));
  has(FJS, "rpc('franchise_ladder', withSecret({ p_limit: limit || 25 }))", 'the ladder is read with the identity, for the "me" line');
  has(FJS, "rpc('franchise_h2h_context', { p_token: String(token || '') })", 'the Head-to-Head context is read by the challenge token alone');

  /* Game Day: challenges, the invite landing, the ladder */
  has(GAMEDAY, "match(/[?&]fc=([a-z0-9]{8,32})/i)", 'Game Day reads a challenge link');
  has(GAMEDAY, 'FR.challengePeek(VIEW_FC)', 'and peeks before anything else');
  has(GAMEDAY, 'FR.challengeAccept(', 'accepting plays through the server');
  has(GAMEDAY, "track('fc_invite_open'", 'the landing is measured');
  has(GAMEDAY, "track('fc_accept'", 'and the accept');
  has(GAMEDAY, "track('fc_complete'", 'and the result');
  has(GAMEDAY, "track('fc_create'", 'and a challenge made');
  has(GAMEDAY, "track('fc_share'", 'and a share');
  has(GAMEDAY, "track('ladder_view'", 'and the ladder seen');
  has(GAMEDAY, 'Found a franchise and play', 'a visitor without a franchise is shown the door, and the link brings them back');
  chk('the founding door carries the challenge link back to Game Day', /next='\+encodeURIComponent\('\/games\/gameday\/\?fc='\+VIEW_FC\)/.test(GAMEDAY));
  has(GAMEDAY, 'Accept and play', 'a franchise holding the link can accept');
  has(GAMEDAY, 'This is your own link', 'the challenger is told it is their own link, not offered to play themselves');
  has(GAMEDAY, 'Their lines', 'the result shows their lines too');
  has(GAMEDAY, 'Franchises only — never accounts', 'the ladder says what it lists');
  has(GAMEDAY, "conversionCard('fc_after')", 'a device franchise is offered the one-step save after a challenge');
  has(GAMEDAY, 'Make a challenge link', 'a challenge is made from Game Day');
  chk('Game Day never invents a franchise, a rating or a rank', !/ladder_rating:\s*\d/.test(GAMEDAY) && !/rank:\s*\d/.test(GAMEDAY) && !/city:\s*'[A-Z]/.test(GAMEDAY));
  /* the office brings a visitor back to the challenge, and nowhere outside Games */
  chk('the office accepts a `next` door only inside /games/', /\/\^\\\/games\\\/\[a-z0-9\\-\\\/\]\*/.test(OFFICE) && /href:NEXT\|\|'\/games\/roster\/'/.test(OFFICE));
  has(JS, "esc(o.href || '/games/dynasty/')", 'and the moment can point anywhere in Games');
  /* the HQ */
  has(HOME, "'Rivalry: challenge a friend’s franchise'", 'the HQ offers a challenge as this week’s social objective');
  has(HOME, "ladder <b>#'", 'and shows the ladder rank');
  /* Head-to-Head, with the franchises behind the names */
  has(H2H, 'lib/franchise.js', 'the Head-to-Head page loads the franchise layer');
  has(H2H, 'FR.h2hContext(ch.invite_token)', 'and reads the franchises behind the two names by the token');
  has(H2H, "track('h2h_franchise_complete'", 'a settled Head-to-Head between two franchises is measured');
  chk('the context is painted after the challenge, never instead of it', /function renderChallenge\(ch\)\{\s*renderChallengeInner\(ch\);\s*paintFranchiseContext\(ch\);/.test(H2H));
  ['fc_create', 'fc_invite_open', 'fc_accept', 'fc_complete', 'fc_share', 'ladder_view'].forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  /* the SQL keeps its conventions on the new side */
  ['franchise_sim_versus(uuid, uuid, text, text)', 'franchise_rivalry_bump(uuid, uuid, text, text)', 'franchise_challenge_json(uuid, uuid)', 'franchise_identity_json(uuid)', 'franchise_sim_score_play(jsonb, jsonb, jsonb, jsonb, numeric, jsonb)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role', SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_challenge_create(text, text)', 'franchise_challenge_peek(text, text)', 'franchise_challenge_accept(text, text)', 'franchise_challenges_mine(integer, text)', 'franchise_ladder(integer, text)', 'franchise_h2h_context(text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated', SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to fifteen rows', /select 15, 'the ladder is public and lists franchises, never accounts'/.test(SQL));
  chk('a challenge row is readable by its two parties only', /create policy franchise_challenges_party on public\.franchise_challenges for select\s+using \(public\.franchise_is_mine\(challenger_id\) or \(opponent_id is not null and public\.franchise_is_mine\(opponent_id\)\)\)/.test(SQL));
  chk('the identity a stranger sees carries no account and no resources', /function public\.franchise_identity_json[\s\S]*?\$\$;/.test(SQL)
    && !/user_id|anon_hash|team_credits|scouting_points/.test(SQL.slice(SQL.indexOf('function public.franchise_identity_json'), SQL.indexOf('$$;', SQL.indexOf('function public.franchise_identity_json')))));
  chk('a challenge is accepted once: the row is locked and a played one is refused', /where invite_token = p_token for update/.test(SQL) && /this challenge has already been played/.test(SQL));
  chk('a franchise cannot play itself', /you cannot accept your own challenge/.test(SQL));
  chk('the seed is the server\'s', /v_seed := md5\(c\.id::text \|\| ':' \|\| clock_timestamp\(\)::text\)/.test(SQL));
  chk('the versus simulator plays a neutral field with both sides\' preparation', /'neutral', true/.test(SQL) && /prepa := public\.franchise_prep\(p_a, p_week_key\); prepb := public\.franchise_prep\(p_b, p_week_key\)/.test(SQL));
  chk('the ladder is zero-sum Elo', /db := public\.games_elo_delta\(rb, ra, case res_a when 'W' then 0 when 'L' then 1 else 0\.5 end, 24\)/.test(SQL));
  (() => {
    const a = SQL.indexOf('create or replace function public.franchise_challenge_accept('), b = SQL.indexOf('$$;', SQL.indexOf('begin', a));
    chk('the season record is untouched by an exhibition', a > 0 && b > a && SQL.slice(a, b).indexOf('franchise_seasons') < 0 && SQL.slice(a, b).indexOf('season_stats') < 0
      && /exhibition is not a season game/.test(SQL.slice(a, b)));
  })();
  has(README, 'franchise_sim_versus', 'the README documents the versus simulator');
  has(README, 'lists franchises, never accounts', 'and the ladder rule');

  /* ═══ 13. THE OFFSEASON AND THE FACILITIES (PHASE 4) ═════════════════════ */
  /* the facilities table the client shows is the one the SQL charges */
  eq('facilities are facilities_v1 on both sides', F.FACILITIES_VERSION, 'facilities_v1');
  has(SQL, "'version', 'facilities_v1'", 'the SQL publishes the version');
  F.FACILITY_ORDER.forEach(k => {
    const f = F.FACILITIES[k];
    const re = new RegExp("'" + k + "',\\s+jsonb_build_object\\('name', '" + f.name + "', 'currency', '" + f.currency + "', 'costs', jsonb_build_array\\(" + f.costs.join(', ') + "\\), 'per_level', " + f.per_level + ",\\s+'effect', '" + f.effect.replace(/[+.;]/g, c => '\\' + c) + "'\\)");
    chk('the SQL prices ' + f.name + ' the same, level for level, with the same effect', re.test(SQL), re.source.slice(0, 80));
  });
  chk('every facility is bought with an earned currency, never with money', F.FACILITY_ORDER.every(k => /^(tc|cp)$/.test(F.FACILITIES[k].currency)) && !/'usd'|price_cents|stripe/i.test(SQL));
  (() => {
    const s = F.facilityState('training', { training: 2 }, { team_credits: 700 });
    chk('a facility state names the next price and the shortfall', s.level === 2 && s.cost === 1000 && s.short === 300 && !s.affordable && s.unit === 'TC' && s.bonus === 2 && s.next_bonus === 3);
    chk('a built-out facility has no price', F.facilityState('film', { film: 3 }, { coach_points: 99 }).top && F.facilityState('film', { film: 3 }, {}).cost === null);
    chk('an affordable one says so', F.facilityState('stadium', {}, { coach_points: 6 }).affordable && F.facilityState('stadium', {}, { coach_points: 5 }).short === 1);
    eq('an unknown facility is null', F.facilityState('parking', {}, {}), null);
    eq('the four come in the published order', F.facilityStates({}, {}).map(x => x.key).join(','), 'training,film,conditioning,stadium');
    eq('a facility line', F.facilityLine('film', 1), 'Film Room · level 1 of 3');
  })();
  /* the offseason the client explains is the one the SQL ran */
  eq('the offseason is offseason_v1', F.OFFSEASON_VERSION, 'offseason_v1');
  has(SQL, "'version', 'offseason_v1'", 'the SQL writes the version on the report');
  chk('the retirement rule is the same on both sides', F.RETIRE_AGE === 35 && F.FADE_AGE === 33 && F.FADE_OVERALL === 55 && /retire := age_new >= 35 or \(age_new >= 33 and ovr < 55\)/.test(SQL));
  chk('nobody grows past his potential', /if ovr > pl\.potential and growth > 0 then/.test(SQL) && /pot := case when age_new >= 30 then ovr else greatest\(pl\.potential, ovr\) end/.test(SQL));
  chk('the Training Center is a level of development for the young', /\+ \(case when g >= 4 then 1 else 0 end\) \+ training \+ floor\(random\(\) \* 3\)::int - 1/.test(SQL));
  chk('the offseason runs once, before the next season is written', /if existing is not null then return existing; end if;/.test(SQL)
    && SQL.indexOf('perform public.franchise_offseason(v_f, s.number);') < SQL.indexOf("values (v_f, v_n, 'Season ' || public.games_roman(v_n), v_real, 'preseason', s.weeks);"));
  chk('a rookie is signed for every retirement, from the founding pools, seeded', /f\.seed \|\| ':rookie:' \|\| p_from \|\| ':' \|\| v_pos \|\| ':' \|\| d/.test(SQL) && /public\.franchise_pool_first_names\(\)/.test(SQL.slice(SQL.indexOf('function public.franchise_generate_rookie'))));
  chk('the founding generator draws from the same pools', /first_names text\[\] := public\.franchise_pool_first_names\(\);/.test(SQL.slice(SQL.indexOf('function public.franchise_generate_roster'), SQL.indexOf('function public.franchise_generate_rookie'))));
  chk('the retired keep their careers and leave the roster read', /status = case when retire then 'retired' else status end/.test(SQL) && /where p\.franchise_id = f\.id and p\.status = 'active'/.test(SQL));
  eq('an offseason line', F.offseasonLine({ after_season: 1, summary: { improved: 15, declined: 18, retired: 4, signed: 4, biggest: 17 } }), 'Offseason after Season I: 15 improved, 18 declined, 4 retired, 4 rookies signed. Biggest leap +17.');
  eq('a quiet one', F.offseasonLine({ after_season: 2, summary: { improved: 25, declined: 12, retired: 0, signed: 0, biggest: 3 } }), 'Offseason after Season II: 25 improved, 12 declined.');
  eq('no report, no line', F.offseasonLine(null), '');
  eq('roman numerals', [4, 9, 14, 40].map(F.roman).join(' '), 'IV IX XIV XL');
  ['first_upgrade', 'breakout', 'farewell'].forEach(id => {
    const m = new RegExp("\\('" + id + "',\\s+'([^']+)',").exec(SQL);
    chk('the SQL seeds ' + id + ' and the client names it the same', m && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === m[1], m && m[1]);
  });
  (() => {
    const t = F.trophyShareText({ franchise: { city: 'Lubbock', name: 'Outlaws', founded_season: 2026 }, record: { wins: 9, losses: 7, seasons: 2 },
      achievements: [{ earned: true }, { earned: false }, { earned: true }], rival: { name: 'Condors', wins: 1, losses: 1 }, ladder: { games: 3, rating: 1512 },
      leaders: { passing: [{ name: 'Jamal Ellsworth', yds: 2424 }] } });
    chk('a shared room is the identity, the seasons, the record, the wall and the passing leader — and no claim',
      /^LUBBOCK OUTLAWS\n/.test(t) && /Founded 2026 · 2 seasons · 9–7 all-time/.test(t) && /2 achievements · Rival series 1–1 · Ladder 1512/.test(t)
      && /Career passing: Jamal Ellsworth, 2,424 yds/.test(t) && /EdgeDesk Games$/.test(t) && !/\b(bet|wager|odds|edge|lock)\b/i.test(t), t);
  })();
  /* the client asks; the server charges */
  has(FJS, "rpc('franchise_upgrade', withSecret({ p_facility: String(facility || '') }))", 'an upgrade sends a name and the identity, never a price');
  chk('an upgrade is never queued — spending must see its answer', !/record\('franchise_upgrade'/.test(FJS));
  has(FJS, "rpc('franchise_trophies', withSecret({}))", 'the Trophy Room is one read');
  chk('the snapshot follows the answer, so the HQ and the office agree', /if \(r\.data\.totals\) snap\.resources = r\.data\.totals;\s*if \(r\.data\.facilities\) snap\.facilities = r\.data\.facilities;/.test(FJS));
  chk('the client never ages, develops or retires a player', !/function (offseason|age|develop|retire|rookie)\(/.test(FJS) && !/rpc\('franchise_offseason/.test(FJS) && !/rpc\('franchise_generate_rookie/.test(FJS) && !/retired_season\s*[:=]/.test(FJS));
  /* the Front Office */
  has(OFFICE, 'FR.upgrade(key)', 'the office upgrades through the server');
  has(OFFICE, 'FR.facilityStates(', 'and shows the published table');
  has(OFFICE, "track('facility_upgrade'", 'an upgrade is measured');
  has(OFFICE, 'Built out', 'a built-out facility says so');
  has(OFFICE, "' on hand</span>'", 'a short purse shows the price and what is on hand instead of a button');
  has(OFFICE, 'never with money', 'and the page says money buys nothing');
  has(OFFICE, 'FR.offseasonLine(snap.offseason)', 'the office carries the last offseason');
  has(OFFICE, 'href="/games/trophies/"', 'and opens the Trophy Room');
  chk('the office never invents a level, a price or a report', !/facilities:\s*\{\s*training:\s*\d/.test(OFFICE) && !/cost:\s*\d/.test(OFFICE) && !/after_season:\s*\d/.test(OFFICE));
  /* the Trophy Room, the page */
  has(TROPHIES, 'FR.trophies()', 'the Trophy Room reads through the server');
  has(TROPHIES, "track('trophy_room_view'", 'and is measured');
  has(TROPHIES, "track('trophy_share'", 'and a share is');
  has(TROPHIES, 'FR.trophyShareText(DATA)', 'the share is the published text');
  ['The wall', 'Seasons', 'Career leaders', 'Alumni', 'Offseason'].forEach(h => has(TROPHIES, h, 'the room has ' + h));
  has(TROPHIES, 'Not yet</div>', 'an unearned achievement is shown, not hidden');
  has(TROPHIES, 'retired after Season', 'an alumnus says when he went');
  has(TROPHIES, 'Nothing here is granted', 'the room says nothing is granted');
  has(TROPHIES, 'Found my franchise', 'a visitor without a franchise is shown the door');
  chk('the Trophy Room never renders a player, a season or an achievement it invented', !/first_name:\s*'/.test(TROPHIES) && !/earned:\s*true/.test(TROPHIES) && !/wins:\s*\d/.test(TROPHIES) && !/name:\s*'[A-Z][a-z]+ [A-Z]/.test(TROPHIES));
  /* the HQ, the roster, the shell */
  has(HOME, 'FR.offseasonLine(snap.offseason)', 'the HQ says what the offseason did');
  has(HOME, 'data-cta="hq-trophies"', 'and has a door to the Trophy Room');
  has(ROSTER, 'Players develop in the offseason', 'the roster says how a team improves now');
  has(ROSTER, 'anyone 35 retires (33 and under 55 too)', 'and states the retirement rule');
  chk('the Trophy Room is a room of the facility', require(G('games.js')).ROOMS.some(r => r.key === 'trophies' && r.href === '/games/trophies/') && /href="\/games\/trophies\/">Trophy Room<\/a>/.test(JS));
  ['facility_upgrade', 'trophy_share', 'trophy_room_view'].forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  ['facility_upgrade', 'trophy_share', 'trophy_room_view'].forEach(e => chk('and the pages fire ' + e, new RegExp("track\\('" + e + "'").test(OFFICE + TROPHIES)));
  chk('the facilities meet the tap minimum and stack on a phone', /\.fac-i \.act \.btn\{min-height:40px/.test(FCSS) && /\.fac\{display:grid;gap:8px/.test(FCSS) && /@media\(min-width:720px\)\{\.fac\{grid-template-columns:1fr 1fr\}\}/.test(FCSS));
  /* the SQL keeps its conventions on the new side */
  ['franchise_offseason(uuid, integer)', 'franchise_generate_rookie(uuid, text, integer, integer, text, text)', 'franchise_pool_first_names()', 'franchise_pool_last_names()', 'franchise_pool_plan()', 'franchise_pool_archetypes()', 'franchise_pool_traits()']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role', SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_upgrade(text, text)', 'franchise_trophies(text)', 'franchise_facilities()']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated', SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to seventeen rows', /select 16, 'the offseason and the rookie generator are reachable by no client role'/.test(SQL)
    && /select 17, 'facilities are ' \|\| \(public\.franchise_facilities\(\)->>'version'\) \|\| ', bought with earned resources through the ledger only'/.test(SQL));
  chk('an upgrade is one negative ledger row, keyed by facility and level, and the totals still derive from the ledger',
    /public\.franchise_credit\(v_f, cur, -cost, 'facility', p_facility \|\| ':' \|\| \(lvl \+ 1\)/.test(SQL) && /team_credits = \(select coalesce\(sum\(l\.delta\), 0\) from public\.franchise_ledger l/.test(SQL));
  chk('the top level and a short purse are refused before anything is written',
    /'% is already at its top level', spec->>'name' using errcode = '55000'/.test(SQL) && /not enough %: % needed, % on hand/.test(SQL)
    && SQL.indexOf("not enough %: % needed, % on hand") < SQL.indexOf("ok := public.franchise_credit(v_f, cur, -cost, 'facility'"));
  chk('the Film Room, Conditioning and the Stadium are in the box', /'facilities', jsonb_build_object\('film', film, 'conditioning', cond, 'stadium', case when g\.home then stad else 0 end\)/.test(SQL)
    && /'film', a_film, 'conditioning', a_cond/.test(SQL) && /'film', b_film, 'conditioning', b_cond/.test(SQL));
  chk('a challenge on a neutral field has no Stadium', !/stad/.test(SQL.slice(SQL.indexOf('function public.franchise_sim_versus'), SQL.indexOf('$$;', SQL.indexOf('function public.franchise_sim_versus')))));
  chk('the room is the franchise\'s own', /function public\.franchise_trophies\(p_secret text default null\)[\s\S]*?where id = public\.franchise_of\(p_secret\)/.test(SQL));
  chk('the SQL suite plays the offseason and the facilities through', /17\. THE OFFSEASON AND THE FACILITIES/.test(SQLTEST) && /the dry run and the real one agree, player for player/.test(SQLTEST) && /one credit short is refused/.test(SQLTEST));
  has(README, 'facilities_v1', 'the README documents the facilities');
  has(README, 'offseason_v1', 'and the offseason');
  has(README, 'one negative ledger row', 'and the ledger rule for spending');
  has(README, 'Trophy Room', 'and the Trophy Room');

  /* ═══ 14. THE DRAFT AND THE MARKET (PHASE 5) ═════════════════════════════ */
  /* the market the client shows is the one the SQL runs */
  eq('the market is market_v1 on both sides', F.MARKET_VERSION, 'market_v1');
  has(SQL, "'version', 'market_v1'", 'the SQL publishes the version');
  chk('a report, the picks, the class, the agents and the roster bounds are the SQL\'s numbers',
    F.MARKET.scout_sp === 20 && F.MARKET.picks === 2 && F.MARKET.class_size === 10 && F.MARKET.agents === 6 && F.MARKET.roster_max === 42 && F.MARKET.roster_min === 38
    && /'scout_sp', 20,\s*'picks', 2,\s*'class_size', 10,\s*'agents', 6,\s*'roster_max', 42,\s*'roster_min', 38,/.test(SQL));
  chk('a free agent\'s price is the same formula on both sides', F.signingCost(55) === 100 && F.signingCost(60) === 100 && F.signingCost(65) === 200 && F.signingCost(72) === 340
    && /select greatest\(100, \(coalesce\(p_overall, 0\) - 55\) \* 20\);/.test(SQL) && /'signing', jsonb_build_object\('floor', 100, 'per_point', 20, 'over', 55\)/.test(SQL));
  ['draft_day', 'full_scout', 'gut_call', 'first_signing'].forEach(id => {
    const m = new RegExp("\\('" + id + "',\\s+'([^']+)',").exec(SQL);
    chk('the SQL seeds ' + id + ' and the client names it the same', m && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === m[1], m && m[1]);
  });
  eq('an unscouted prospect\'s line is the range and nothing more', F.prospectLine({ position: 'QB', age: 22, archetype: 'Gunslinger', range: [55, 65] }), 'QB · 22 · Gunslinger · OVR 55–65 · potential unknown');
  eq('a scouted one says what the report said', F.prospectLine({ position: 'QB', age: 22, archetype: 'Gunslinger', overall: 59, potential: 63, dev_tier: 'normal' }), 'QB · 22 · Gunslinger · OVR 59 · potential 63 · Steady');
  eq('the range line', F.rangeLine({ range: [48, 58] }), 'OVR 48–58 · potential unknown');
  eq('no range, no line', F.rangeLine({}), '');
  (() => {
    const r = F.rosterRoom({ active: 41, max: 42, min: 38 });
    chk('the roster\'s room is counted from the board', r.room === 1 && !r.full && !r.floor && F.rosterRoom({ active: 42 }).full && F.rosterRoom({ active: 38 }).floor && F.rosterRoom({ active: 38 }).max === 42);
  })();
  eq('a drafted player\'s line says so', F.acquiredLine({ acquired_source: 'draft', acquired_season: 2026, acquired_detail: 'Pick 1 of the Season II class' }), 'Drafted · 2026 · Pick 1 of the Season II class');
  eq('a signed one too', F.acquiredLine({ acquired_source: 'free_agent', acquired_season: 2026 }), 'Free agent · 2026');
  /* the client asks; the server prices, hides, reveals and places */
  has(FJS, "rpc('franchise_market_board', withSecret({}))", 'the board is one read');
  has(FJS, "rpc('franchise_scout', withSecret({ p_player: String(playerId || '') }))", 'a report sends the player and the identity, never a price');
  has(FJS, "rpc('franchise_draft', withSecret({ p_player: String(playerId || '') }))", 'a pick sends the player and the identity');
  has(FJS, "rpc('franchise_sign', withSecret({ p_player: String(playerId || '') }))", 'a signing sends the player and the identity, never a price');
  has(FJS, "rpc('franchise_release', withSecret({ p_player: String(playerId || '') }))", 'a release sends the player and the identity');
  chk('none of the four is ever queued', !/record\('franchise_(scout|draft|sign|release)'/.test(FJS));
  chk('the client never reveals a prospect on its own', !/range\[0\] \+ \d|function reveal|true_overall|hidden_overall/.test(FJS + MARKET));
  /* the page */
  has(MARKET, 'FR.market()', 'the market page reads the board through the server');
  has(MARKET, 'FR.scout(id)', 'and scouts through it');
  has(MARKET, 'FR.draft(id)', 'and drafts through it');
  has(MARKET, 'FR.sign(id)', 'and signs through it');
  ['market_view', 'scouting_spent', 'player_scouted', 'draft_pick', 'free_agent_signed'].forEach(e => chk('the market page fires ' + e, new RegExp("track\\('" + e + "'").test(MARKET)));
  has(MARKET, 'potential unknown', 'an unscouted prospect says his potential is unknown');
  has(MARKET, 'pc-hidden', 'and shows the ratings as hidden, not as zeros');
  has(MARKET, 'Draft unscouted', 'a gut call is offered as what it is');
  has(MARKET, 'A pick is not undone', 'and asked about once');
  has(MARKET, 'earn more in Price It', 'a short purse points at Price It, never at a purchase');
  has(MARKET, 'release a player on the', 'a full roster points at the roster');
  has(MARKET, 'Nothing here can be bought with money', 'the page says money buys nothing');
  has(MARKET, 'Found my franchise', 'a visitor without a franchise is shown the door');
  chk('the market page never invents a prospect, a price or a pick', !/first_name:\s*'/.test(MARKET) && !/asking:\s*\d/.test(MARKET) && !/picks:\s*\d/.test(MARKET) && !/range:\s*\[\d/.test(MARKET));
  /* the roster releases, the HQ counts the picks, the office points here */
  has(ROSTER, 'FR.release(rid)', 'the roster releases through the server');
  has(ROSTER, "track('player_released'", 'and measures it');
  has(ROSTER, 'He leaves the franchise for good', 'and asks once, plainly');
  chk('a release is offered only where the server would allow it', /if\(!FR\.isStarter\(p\)&&spare&&room&&!room\.floor\)actions\+=/.test(ROSTER));
  has(HOME, "'Draft: '+(mk.picks|0)+' pick'", 'the HQ counts the picks left as an objective');
  has(HOME, 'data-cta="hq-market"', 'and has a door to the market');
  chk('the draft objective comes after the day\'s', HOME.indexOf("'Draft: '+(mk.picks|0)") > HOME.indexOf("'Rivalry: challenge"));
  has(OFFICE, 'href="/games/market/"', 'the office points at the market for Scouting Points');
  chk('the market is a room of the facility', require(G('games.js')).ROOMS.some(r => r.key === 'market' && r.href === '/games/market/') && /href="\/games\/market\/">Draft &amp; Market<\/a>/.test(JS));
  ['market_view', 'free_agent_signed', 'player_released', 'scouting_spent', 'player_scouted', 'draft_pick'].forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  chk('the market cards stack on a phone and the actions meet the tap minimum', /\.pc-actions \.btn\{min-height:40px/.test(FCSS) && /\.mk-sum\{display:grid;grid-template-columns:repeat\(2,1fr\)/.test(FCSS));
  /* the SQL keeps its conventions on the new side */
  ['franchise_generate_player(uuid, text, integer, integer, text, text, text, integer)', 'franchise_open_market(uuid, integer)', 'franchise_prospect_json(public.game_players)', 'franchise_free_number(uuid, text, text)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role', SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_market()', 'franchise_market_board(text)', 'franchise_scout(uuid, text)', 'franchise_draft(uuid, text)', 'franchise_sign(uuid, text)', 'franchise_release(uuid, text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated', SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to nineteen rows', /select 18, 'the market is '/.test(SQL) && /select 19, 'a prospect''s true ratings are read through the board only/.test(SQL));
  chk('the direct read admits no prospect and no free agent', /create policy game_players_own on public\.game_players for select\s+using \(franchise_id is not null and public\.franchise_is_mine\(franchise_id\) and status not in \('prospect', 'free_agent'\)\)/.test(SQL));
  chk('an unscouted prospect is a range fixed per player, and no ratings', /lo := greatest\(40, p\.overall - 3 - \(abs\(hashtext\(p\.id::text\)\) % 5\)\);/.test(SQL)
    && /'range', jsonb_build_array\(lo, least\(99, lo \+ 10\)\), 'overall', null, 'potential', null/.test(SQL));
  chk('a report and a signing are one negative ledger row each, keyed by the player',
    /public\.franchise_credit\(v_f, 'sp', -cost, 'scout', p\.id::text/.test(SQL) && /public\.franchise_credit\(v_f, 'tc', -p\.asking, 'signing', p\.id::text/.test(SQL));
  chk('a short purse, a spent pick and a full roster are refused before anything is written',
    /not enough Scouting Points: % needed, % on hand/.test(SQL) && /no draft picks left until the next offseason/.test(SQL) && /the roster is full at %: release a player first/.test(SQL)
    && SQL.indexOf('not enough Scouting Points: % needed, % on hand') < SQL.indexOf("public.franchise_credit(v_f, 'sp', -cost, 'scout'"));
  chk('the floor and the starters hold on a release', /the roster cannot go below %/.test(SQL) && /you need at least % at %/.test(SQL));
  chk('founding opens the first window and the offseason the next', /perform public\.franchise_open_market\(v_id, 1\);/.test(SQL) && /mk := public\.franchise_open_market\(p_franchise, p_from \+ 1\);/.test(SQL));
  chk('the picks are renewed, never banked', /set draft_picks = \(m->>'picks'\)::int, market_season = p_window/.test(SQL));
  chk('a prospect has no number until he joins', /jersey = public\.franchise_free_number\(v_f, p\.position, p\.id::text\)/.test(SQL) && /'jersey', case when p\.status = 'active' then p\.jersey end/.test(SQL));
  chk('the SQL suite plays the draft and the market through', /18\. THE DRAFT AND THE MARKET/.test(SQLTEST) && /a client cannot read a prospect''s row/.test(SQLTEST) && /the same seed makes the same class/.test(SQLTEST));
  has(README, 'market_v1', 'the README documents the market');
  has(README, 'Where Scouting Points go', 'and says what it is for');
  has(README, 'The roster runs 38 to 42', 'and the roster bounds');

  /* ═══ 15. CONFERENCES AND PLAYOFFS (PHASE 6) ═════════════════════════════ */
  /* the shape of the competition the client shows is the one the SQL runs */
  eq('the conference is conference_v1 on both sides', F.CONFERENCE_VERSION, 'conference_v1');
  has(SQL, "'version', 'conference_v1'", 'the SQL publishes the version');
  chk('the sizes, the round cap, the bracket and the ladder K are the SQL\'s numbers',
    F.CONFERENCE.min_teams === 4 && F.CONFERENCE.max_teams === 12 && F.CONFERENCE.start_min === 4
    && F.CONFERENCE.rounds_max === 7 && F.CONFERENCE.playoff_teams === 4 && F.CONFERENCE.playoff_small === 2
    && F.CONFERENCE.playoff_large_from === 6 && F.CONFERENCE.ladder_k === F.LADDER_K
    && /'name_max', 32,\s*'min_teams', 4, 'max_teams', 12, 'start_min', 4,\s*'rounds_max', 7,\s*'playoff_teams', 4, 'playoff_small', 2, 'playoff_large_from', 6,\s*'ladder_k', 24,/.test(SQL));
  chk('the bracket rule is the same on both sides: four from six up, two below',
    F.playoffTeams(4) === 2 && F.playoffTeams(5) === 2 && F.playoffTeams(6) === 4 && F.playoffTeams(12) === 4
    && /select case when coalesce\(p_n, 0\) >= \(public\.franchise_conference_config\(\)->>'playoff_large_from'\)::int/.test(SQL));
  chk('the conference pays what the SQL pays', F.ECONOMY.conf_game.xp === 80 && F.ECONOMY.conf_game.tc === 35
    && F.ECONOMY.conf_win.xp === 50 && F.ECONOMY.conf_win.tc === 50 && F.ECONOMY.conf_win.cp === 2
    && F.ECONOMY.conf_playoff.xp === 100 && F.ECONOMY.conf_playoff.cp === 1
    && F.ECONOMY.conf_title.xp === 400 && F.ECONOMY.conf_title.tc === 300 && F.ECONOMY.conf_title.cp === 10);
  chk('and rewardsFor names those four kinds',
    F.rewardsFor('conf_game').tc === 35 && F.rewardsFor('conf_win').cp === 2
    && F.rewardsFor('conf_playoff').xp === 100 && F.rewardsFor('conf_title').cp === 10);
  ['conf_first', 'conf_top', 'conf_post', 'conf_title', 'conf_two'].forEach(id => {
    const m = new RegExp("\\('" + id + "',\\s+'([^']+)',").exec(SQL);
    chk('the SQL seeds ' + id + ' and the client names it the same', m && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === m[1], m && m[1]);
  });
  /* presentation is a pure function of a row */
  eq('a regular round is named by its number', F.roundName({ kind: 'regular', round: 3 }), 'Round 3');
  eq('a semifinal is named', F.roundName({ kind: 'semifinal', round: 6 }), 'Semifinal');
  eq('and the final is the final', F.roundName({ kind: 'final', round: 7 }), 'The final');
  eq('a played game reads from the viewer\'s side',
    F.conferenceGameLine({ status: 'final', kind: 'regular', round: 2, a: { id: 'x', name: 'Outlaws' }, b: { id: 'y', name: 'Comets' }, score_a: 24, score_b: 17 }, 'x'),
    'Round 2 · beat the Comets 24–17');
  eq('and from the other side', 
    F.conferenceGameLine({ status: 'final', kind: 'regular', round: 2, a: { id: 'x', name: 'Outlaws' }, b: { id: 'y', name: 'Comets' }, score_a: 24, score_b: 17 }, 'y'),
    'Round 2 · lost to the Outlaws 17–24');
  eq('a game between two others is named, not taken sides in',
    F.conferenceGameLine({ status: 'final', kind: 'final', a: { id: 'x', name: 'Outlaws' }, b: { id: 'y', name: 'Comets' }, score_a: 24, score_b: 17 }, 'z'),
    'The final · Outlaws 24, Comets 17');
  eq('a scheduled one says who meets whom',
    F.conferenceGameLine({ status: 'scheduled', kind: 'semifinal', a: { id: 'x', name: 'Outlaws' }, b: { id: 'y', name: 'Comets' } }, 'x'),
    'Semifinal · Outlaws v Comets');
  eq('a standings row is a record and a difference', F.standingLine({ wins: 4, losses: 1, ties: 0, diff: 33 }), '4–1 · +33');
  eq('a negative difference keeps its sign', F.standingLine({ wins: 1, losses: 4, ties: 0, diff: -38 }), '1–4 · -38');
  (() => {
    const P = o => F.conferencePhase(o).phase;
    chk('the phase is read from the board, never guessed',
      P({}) === 'none' && P({ conference: { status: 'forming' } }) === 'forming'
      && P({ conference: { status: 'regular' }, ready: true }) === 'ready'
      && P({ conference: { status: 'playoffs' }, ready: false }) === 'waiting'
      && P({ conference: { status: 'complete' } }) === 'complete');
  })();
  chk('the invite link is a games URL carrying the token and nothing else',
    F.conferenceUrl('abc123') === 'https://edgedesksports.com/games/conference/?join=abc123');
  chk('the invite text names the conference and never an account',
    /Bring your franchise to The Friday Six\./.test(F.conferenceInviteText({ name: 'The Friday Six' }, { city: 'Lubbock', name: 'Outlaws', overall: 74 }))
    && !/@/.test(F.conferenceInviteText({ name: 'X' }, { city: 'A', name: 'B' })));
  chk('a title shares as a title', /CHAMPIONS/.test(F.titleShareText({ conference: 'The Friday Six', label: 'Season I', runner_up: { name: 'Comets' } }, { city: 'Lubbock', name: 'Outlaws' }).toUpperCase()));
  /* the client asks; the server draws, plays, seeds and crowns */
  has(FJS, "rpc('franchise_conference_board', withSecret({}))", 'the board is one read');
  has(FJS, "rpc('franchise_conference_create', withSecret({ p_name: String(name || '') }))", 'creating sends a name and the identity');
  has(FJS, "rpc('franchise_conference_join', withSecret({ p_token: String(token || '') }))", 'joining sends a token and the identity');
  has(FJS, "rpc('franchise_conference_start', withSecret({}))", 'starting a season sends nothing else');
  has(FJS, "rpc('franchise_conference_advance', withSecret({}))", 'and advancing sends nothing at all');
  chk('none of the conference calls is ever queued', !/record\('franchise_conference/.test(FJS));
  chk('the client never draws a schedule, seeds a bracket or picks a champion',
    !/circle method|function draw|function seedBracket|champion\s*=\s*(?!null)/.test(FJS + CONF));
  /* the page */
  has(CONF, 'FR.conference()', 'the conference page reads the board through the server');
  has(CONF, 'FR.conferenceStart()', 'and starts a season through it');
  has(CONF, 'FR.conferenceAdvance()', 'and plays the round through it');
  has(CONF, 'FR.conferenceJoin(JOIN)', 'and joins through it');
  has(CONF, 'FR.conferenceLeave()', 'and leaves through it');
  ['conference_view', 'conference_create', 'conference_invite_open', 'conference_join', 'conference_start',
   'conference_round', 'conference_title', 'conference_share', 'conference_leave']
    .forEach(e => chk('the conference page fires ' + e, new RegExp("track\\('" + e + "'").test(CONF)));
  has(CONF, 'whoever gets here first plays it for everybody', 'the page says who may advance the round');
  has(CONF, 'The server draws the schedule. Nobody picks their own opponents.', 'and who draws the schedule');
  has(CONF, 'the better seed advances', 'a playoff tie is explained where it is decided');
  has(CONF, 'cannot grow a team mid-season', 'and so is the closed window');
  has(CONF, 'Franchises only, never accounts', 'the standings say what they list');
  has(CONF, 'Nothing here can be bought', 'the page says money buys nothing');
  has(CONF, 'Found my franchise', 'a visitor without a franchise is shown the door');
  has(CONF, 'STALE SCRIPT GUARD', 'and the page guards against a stale cached library');
  chk('the page invents no standing, no seed and no score',
    !/wins:\s*\d/.test(CONF) && !/score_a:\s*\d/.test(CONF) && !/seed:\s*\d/.test(CONF) && !/place:\s*\d/.test(CONF));
  /* the HQ, the Trophy Room and Game Day carry it */
  has(HOME, "'Conference: play '", 'the HQ makes a waiting round the day\'s objective');
  has(HOME, 'data-cta="hq-conference"', 'and has a door to it');
  has(HOME, 'var cf=snap.conference||null;', 'reading the conference off the home snapshot');
  chk('the conference objective comes after the day\'s', HOME.indexOf("'Conference: play '") > HOME.indexOf("'Rivalry: challenge"));
  has(TROPHIES, 'Titles', 'the Trophy Room has a titles wall');
  has(TROPHIES, 'A title stays here even if the franchise later leaves', 'and says a title outlives the conference');
  has(GAMEDAY, 'href="/games/conference/"', 'Game Day points at the conference from the challenges');
  chk('the conference is a room of the facility',
    require(G('games.js')).ROOMS.some(r => r.key === 'conference' && r.href === '/games/conference/')
    && /href="\/games\/conference\/">Conference<\/a>/.test(JS));
  ['conference_view', 'conference_create', 'conference_join', 'conference_round', 'conference_title']
    .forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  has(SITEMAP, 'https://edgedesksports.com/games/conference<', 'the sitemap lists the conference');
  has(NOTFOUND, "p[1]==='conference'", 'the static host routes it');
  chk('the asset bumper stamps the conference page',
    require(path.join(ROOT, 'tools', 'games', 'bump_assets.js')).PAGES.some(p => /conference\/index\.html$/.test(p)));
  chk('the conference standings fit a phone: five columns become four', /\.ladder td\.cf-pf\{display:none\}/.test(FCSS)
    && /@media\(min-width:560px\)\{\.ladder td\.cf-pf,\.ladder th\.cf-pf\{display:table-cell\}\}/.test(FCSS)
    && /\.cf-round \.btn\{min-height:var\(--tap\)\}/.test(FCSS));
  /* the SQL keeps its conventions on the new side */
  ['franchise_conference_draw(uuid, timestamptz)', 'franchise_conference_bracket(uuid)', 'franchise_conference_final(uuid)',
   'franchise_conference_play_one(uuid, timestamptz)', 'franchise_conference_settle(uuid, timestamptz)',
   'franchise_conference_run(uuid, timestamptz)', 'franchise_conference_standings_json(uuid)',
   'franchise_conference_game_json(uuid, boolean)', 'franchise_conference_json(uuid)', 'franchise_conference_of(uuid)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role',
      SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_conference_config()', 'franchise_conference_create(text, text)', 'franchise_conference_peek(text, text)',
   'franchise_conference_join(text, text)', 'franchise_conference_leave(text)', 'franchise_conference_start(text)',
   'franchise_conference_advance(text)', 'franchise_conference_board(text)', 'franchise_conference_game(uuid, text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to twenty-two rows', /select 20, 'the conference is '/.test(SQL)
    && /select 21, 'a conference is read by its members only/.test(SQL)
    && /select 22, 'a franchise belongs to one conference at a time/.test(SQL));
  chk('a conference is read by its members and nobody else',
    /create policy franchise_conferences_member on public\.franchise_conferences for select\s+using \(public\.franchise_conference_is_mine\(id\)\)/.test(SQL)
    && /create policy franchise_conference_games_member on public\.franchise_conference_games for select\s+using \(public\.franchise_conference_is_mine\(conference_id\)\)/.test(SQL));
  chk('one conference to a franchise, held by the key, not by a comment',
    /franchise_id\s+uuid not null unique references public\.franchises \(id\) on delete cascade/.test(SQL));
  chk('the draw is the circle method, seeded from the conference and capped by the table',
    /slot := array\(select 2 \+ \(\(s - 1 \+ \(r - 1\)\) % l\) from generate_series\(1, l\) s\);/.test(SQL)
    && /v_rounds := least\(\(cfg->>'rounds_max'\)::int, l\);/.test(SQL)
    && /order by md5\(c\.seed \|\| ':' \|\| c\.season_number \|\| ':' \|\| franchise_id::text\)/.test(SQL));
  chk('a round opens on the same Saturday boundary the weekly game uses',
    /opens := \(\(wk::date \+ 4\)::timestamp \+ interval '7 hours'\) at time zone 'UTC';/.test(SQL));
  chk('a playoff cannot end level: the better seed is a, and advances',
    /adv := case when g\.kind = 'regular' then null\s+when pts_a >= pts_b then g\.a_id else g\.b_id end;/.test(SQL));
  chk('the standings are the sum of the games, never a number a client sends',
    /set wins = wins \+ \(res_a = 'W'\)::int, losses = losses \+ \(res_a = 'L'\)::int/.test(SQL)
    && /-- the standings are the sum of what happened, not a number a client sends/.test(SQL));
  chk('a decided season is frozen with its standings',
    /insert into public\.franchise_conference_titles \(conference_id, season_number, champion_id, runner_up_id, standings, completed_at\)/.test(SQL));
  chk('a conference round grows careers but not the solo season\'s lines',
    /-- careers grow by the box on both sides; the solo season's lines do not —/.test(SQL)
    && !/season_stats = public\.games_jsonb_sum\(season_stats[^;]*franchise_conference/.test(SQL));
  chk('the SQL suite plays two conferences through', /19\. CONFERENCES AND PLAYOFFS/.test(SQLTEST)
    && /every franchise plays four of the five rounds, and sits out one/.test(SQLTEST)
    && /the top four meet 1v4 and 2v3 in two semifinals/.test(SQLTEST)
    && /a franchise that lives on a device secret joins on the same terms as an account/.test(SQLTEST));
  has(README, 'conference_v1', 'the README documents the conference');
  has(README, 'A **league of friends with standings of its own**', 'and says what it is for');
  has(README, 'circle method', 'and how the schedule is drawn');
  has(README, 'A playoff game cannot end level', 'and how a playoff tie is broken');

  finish();
}).catch(e => { fail++; failures.push('suite threw: ' + (e && e.stack || e)); finish(); });

function finish() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk franchise | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(f => console.log('  × ' + f));
  process.exit(fail ? 1 : 0);
}
